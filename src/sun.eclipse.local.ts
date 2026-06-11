import { type Angle, normalizeAngle, normalizePI } from './angle'
import { ASEC2RAD, DAYSEC, EARTH_RADIUS_KM, PI } from './constants'
import { eraGst06a } from './erfa'
import type { Point } from './geometry'
import { clamp } from './math'
import { bisection, brentMinimize } from './optimization'
import { evaluateBesselian, F, hourAngleFromLongitude, SUN_RADIUS_EARTH_RADII, type InstantBesselianElements, type PolynomialBesselianElements, type SunMoonPosition } from './sun.eclipse'
import { type Time, timeShift, toJulianDay, tt } from './time'

// Local solar eclipse circumstances ("Local View"): for a single geographic point this module resolves
// the local contacts C1/C2/MAX/C3/C4, the local magnitude, durations, the Sun altitude and the position
// angles P/Z at each event, classifies local visibility, and emits SVG-friendly geometry (plain shapes,
// no text and no UI). It is a strictly additive layer on top of sun.eclipse.ts: the global map engine
// (computeSolarEclipseMapGeometry and the curve solver) is never touched.
//
// Unit conventions match sun.eclipse.ts: longitude east-positive in radians, geodetic latitude in radians,
// all internal angles in radians, times as Time/Julian Day, and the fundamental-plane radii (x, y, l1, l2)
// in Earth equatorial radii.

// Mean apparent solar angular radius (959.63 arcsec) used as a fallback when no SunMoonPosition is supplied.
const SUN_MEAN_ANGULAR_RADIUS = 959.63 * ASEC2RAD
// Default half-width of the local contact search window, in seconds. Mirrors the global engine's default
// (sun.eclipse.ts) so the local contacts are searched over the same span around maximumTime. NOT widened to
// 6 h: the Besselian polynomial is fit over only +-3 h (t0 +- 3 h), so a wider window would evaluate heavily
// extrapolated, unreliable elements. When a central/partial contact is missed at this span, the window is
// instead expanded adaptively up to MAX_CONTACT_SEARCH_SPAN_SECONDS, which stays near the fit edge.
const DEFAULT_CONTACT_SEARCH_SPAN_SECONDS = 3.5 * 3600
// Hard cap for the adaptive contact-window expansion, in seconds. Kept close to the +-3 h polynomial fit so
// the search never relies on far extrapolation.
const MAX_CONTACT_SEARCH_SPAN_SECONDS = 5 * 3600
// Default sampling step for the local contact/maximum search, in seconds.
const DEFAULT_LOCAL_SEARCH_STEP_SECONDS = 60
// Root tolerance for local contact instants, in days (~1 ms).
const CONTACT_TOLERANCE_DAYS = 1e-8
// Physical tolerance (Earth equatorial radii) for a grazing (tangential) contact: a local extremum of the
// contact function whose refined |value| stays within this is accepted as a double root even without a sign
// change. ~6e-3 km at the Earth's surface; tight enough not to invent contacts on a clearly partial location.
const CONTACT_FUNCTION_TOLERANCE = 1e-6
// Tie tolerance for detecting a sampled local extremum of a contact function, so a flat/tied valley bottom
// (e.g. two equal samples straddling the true grazing instant) is still recognized.
const CONTACT_SAMPLE_EXTREMUM_EPS = 1e-12
// A sampled triple is only refined for a grazing root when its smallest |value| is already this close to
// zero (Earth equatorial radii). Keeps the |fn| minimization off deep valleys that are far from a contact.
const GRAZING_SCAN_PREFILTER = 0.05
// Minimum margin (Earth equatorial radii) by which the observer must be inside the umbral/antumbral cone to
// count as a central phase. A point exactly on the central limit (distance ~ |L2|) has zero central duration
// and must not be reported as total/annular.
const CENTRAL_CONE_TOLERANCE = 1e-7
// Absolute floor (Earth equatorial radii) below which the lunar-center direction is undefined (atan2(0, 0)
// is meaningless). Used only when the local solar radius is non-positive/degraded; otherwise the relative
// threshold below applies.
const ANGLE_UNDEFINED_DISTANCE = 1e-10
// The lunar-center direction is treated as undefined once the Sun-Moon separation drops below this fraction
// of the local solar radius. A relative threshold avoids reporting numerically unstable, physically
// meaningless P/Z at a near-perfect central alignment (where the separation in pixels is ~0 anyway).
const ANGLE_UNDEFINED_SEPARATION_SOLAR_RADII = 1e-7
// Order in which contacts are scanned and drawn, earliest to latest.
const CONTACT_ORDER = ['C1', 'C2', 'MAX', 'C3', 'C4'] as const

// Kind of a local eclipse contact.
export type LocalEclipseContactKind = 'C1' | 'C2' | 'MAX' | 'C3' | 'C4'

// Local central-phase character at one instant or location.
export type LocalCentralPhaseKind = 'none' | 'total' | 'annular'

// Coarse classification of how the eclipse is seen from the location.
export type LocalVisibilityKind = 'notVisible' | 'geometricOnlyBelowHorizon' | 'partiallyVisible' | 'completelyVisible' | 'centralPhaseVisible' | 'partialOnlyVisible'

// Whether a given event happens with the Sun above or below the local horizon.
export type LocalEventVisibility = 'aboveHorizon' | 'belowHorizon'

// Orientation frame for the Local View geometry.
export type LocalViewOrientationMode = 'zenith' | 'north'

// Horizontal handedness of the Local View. With north up, `eastRight` puts celestial east to the right of
// the diagram (image/map-like, the default), while `eastLeft` puts east to the left (the conventional
// naked-eye / sky-chart orientation, e.g. Astrarium). Only the sign of the horizontal axis changes; the
// physics of the contacts is untouched.
export type LocalViewHandedness = 'eastRight' | 'eastLeft'

// Options controlling the local circumstances computation.
export interface LocalSolarEclipseCircumstancesOptions {
	// Half-width of the contact search window around maximumTime, in seconds.
	readonly contactSearchSpan?: number
	// Sampling step for the local contact/maximum search, in seconds.
	readonly localSearchStepSeconds?: number
	// Altitude (radians) of the apparent horizon; an event is observable when the Sun is at or above it.
	readonly horizonAltitude?: Angle
	// Whether to also build the Local View geometry.
	readonly includeLocalView?: boolean
	// Local View geometry overrides merged onto the defaults.
	readonly localView?: Partial<LocalSolarEclipseViewOptions>

	// Strongly preferred for accurate Sun altitude, P/Z, apparent diameters and Local View.
	//
	// This should be the same physical source used to build the PolynomialBesselianElements, e.g.
	// VSOP/ELP + ERFA.
	readonly sunMoonPosition?: (time: Time) => SunMoonPosition
}

// Full local circumstances for one geographic point.
export interface LocalSolarEclipseCircumstances {
	readonly location: {
		// Geographic longitude in radians, east-positive.
		readonly longitude: Angle
		// Geodetic latitude in radians.
		readonly latitude: Angle
	}

	readonly visibility: {
		// Coarse local visibility classification.
		readonly kind: LocalVisibilityKind
		// Human-readable description of the visibility classification.
		readonly text: string
		// Whether the eclipse touches this location geometrically (regardless of the horizon).
		readonly hasGeometricEclipse: boolean
		// Whether at least one contact happens with the Sun above the horizon.
		readonly hasObservableEclipse: boolean
		// Whether a central (total/annular) phase reaches this location.
		readonly hasCentralPhase: boolean
		// Character of the central phase, or 'none' for a partial-only local eclipse.
		readonly centralPhaseKind: LocalCentralPhaseKind
		// Whether the expected contacts were all resolved. When false, the classification is based on a
		// partial set of events (e.g. a contact fell outside the search window or failed to converge), so
		// `completelyVisible` is never asserted.
		readonly completeness: {
			// Whether both partial contacts (C1 and C4) were resolved.
			readonly partialContactsComplete: boolean
			// Whether both central contacts (C2 and C3) were resolved, or there is no central phase.
			readonly centralContactsComplete: boolean
		}
	}

	readonly details: {
		// Maximal local magnitude, or null when there is no local eclipse.
		readonly maximalMagnitude: number | null
		// Moon/Sun apparent diameter ratio at maximum, or null when unavailable.
		readonly moonSunDiameterRatio: number | null
		// Partial-phase duration in seconds (C4 - C1), or null.
		readonly partialPhaseDurationSeconds: number | null
		// Central-phase duration in seconds (C3 - C2), or null.
		readonly centralPhaseDurationSeconds: number | null
		// Width (km) of the local central-shadow chord through the observer at maximum, measured across the
		// path on a spherical Earth. This is NOT necessarily the canonical path width reported on the central
		// line (Astrarium/EclipseWise): for an off-center observer it is the chord through their own location.
		// Null when the maximum is not central, the observer is outside the central shadow, or no edge is
		// found within MAX_SHADOW_HALF_WIDTH_KM.
		readonly shadowPathWidthKm: number | null
	}

	readonly events: {
		readonly C1: LocalSolarEclipseEvent | null
		readonly C2: LocalSolarEclipseEvent | null
		readonly MAX: LocalSolarEclipseEvent | null
		readonly C3: LocalSolarEclipseEvent | null
		readonly C4: LocalSolarEclipseEvent | null
	}

	// Optional Local View geometry, present when includeLocalView is set.
	readonly localView?: LocalSolarEclipseViewGeometry
}

// Internal per-event state needed to draw the Local View without recomputing the fundamental geometry. The
// Local View draws the lunar CENTER, so these are the center position angles, not the limb-contact angles
// reported on the event (positionAngleP/zenithAngleZ).
export interface LocalViewEventState {
	// Sun-Moon center separation in solar radii at the event.
	readonly separationSolarRadii: number
	// Position angle of the lunar center from celestial north toward east, or null.
	readonly centerPositionAngleP: Angle | null
	// Zenith-oriented position angle of the lunar center, or null.
	readonly centerZenithAngleZ: Angle | null
	// Solar parallactic angle (radians) at the event, used to rotate the horizon in the north frame, or null.
	readonly parallacticAngle: Angle | null
	// Solar altitude (radians) at the event.
	readonly sunAltitude: Angle
	// Apparent solar angular radius (radians), or null when unavailable.
	readonly solarAngularRadius: Angle | null
}

// One resolved local contact event.
export interface LocalSolarEclipseEvent {
	// Which contact this event is.
	readonly kind: LocalEclipseContactKind
	// Human-readable description of the event.
	readonly description: string
	// Instant of the event.
	readonly time: Time
	// Julian Day of the event.
	readonly jd: number

	// Solar altitude at the event in radians.
	// Uses apparent Sun center altitude if sunMoonPosition is available, otherwise a Besselian approximation.
	readonly sunAltitude: Angle

	// Position angle of the contact point on the solar limb, from celestial north toward east, normalized to
	// [0, TAU). This is the table/circumstances angle: it coincides with the lunar-center angle at C1/MAX/C4
	// and at annular C2/C3, but is opposite (center + PI) at total C2/C3 (internal tangency on the far limb).
	readonly positionAngleP: Angle | null

	// Same contact-point angle in the local zenith-oriented frame, normalized to [0, TAU).
	readonly zenithAngleZ: Angle | null

	// Whether the Sun is above or below the horizon at the event.
	readonly visibility: LocalEventVisibility
	// Whether the event is observable (Sun at or above the configured horizon altitude).
	readonly observable: boolean

	// Local magnitude at the event.
	readonly magnitude: number
	// Moon/Sun apparent diameter ratio at the event, or null when unavailable.
	readonly moonSunDiameterRatio: number | null
	// Central-phase character at the event.
	readonly centralPhaseKind: LocalCentralPhaseKind

	// Internal geometry cache consumed by the Local View builder.
	readonly localViewState?: LocalViewEventState
}

// Local geometry on the fundamental plane at one instant for one observer.
export interface LocalFundamentalState {
	// Instant of this state.
	readonly time: Time
	// Julian Day of this state.
	readonly jd: number
	// Besselian elements evaluated at this instant.
	readonly be: InstantBesselianElements

	// Observer longitude in radians, east-positive.
	readonly longitude: Angle
	// Observer geodetic latitude in radians.
	readonly latitude: Angle

	// Local hour angle of the shadow axis, normalized to [0, TAU).
	readonly hourAngle: Angle
	// Observer fundamental-plane coordinates (Earth equatorial radii).
	readonly ksi: number
	readonly eta: number
	readonly zeta: number

	// Observer-to-axis offset components and their magnitude in the fundamental plane (Earth equatorial radii).
	readonly u: number
	readonly v: number
	readonly distance: number

	// Local penumbral and umbral cone radii at the observer (Earth equatorial radii).
	readonly L1: number
	readonly L2: number

	// Local magnitude (L1 - distance) / (L1 + L2).
	readonly magnitude: number
	// Moon/Sun apparent diameter ratio, or null when the solar radius is non-positive.
	readonly moonSunDiameterRatio: number | null
	// Central-phase character at this state.
	readonly centralPhaseKind: LocalCentralPhaseKind
}

// Options controlling the Local View geometry.
export interface LocalSolarEclipseViewOptions {
	// Diagram width in SVG pixels.
	readonly width: number
	// Diagram height in SVG pixels.
	readonly height: number

	// Which instant is drawn as the primary state.
	readonly selectedEvent: LocalEclipseContactKind

	// Orientation of the diagram.
	//
	// - `zenith`: zenith/up frame.
	// - `north`: celestial north-up frame.
	//
	// This only controls geometry. Do not create UI buttons.
	readonly orientationMode: LocalViewOrientationMode

	// Horizontal handedness of the diagram. Defaults to `eastRight`. Set `eastLeft` to match the
	// conventional naked-eye / sky-chart orientation (east to the left when north is up).
	readonly handedness?: LocalViewHandedness

	// Radius of the solar disk in SVG pixels.
	readonly solarRadiusPx: number

	// Whether to include ghost geometry for all available contacts. No labels.
	readonly includeGhostDisks: boolean

	// Whether to include the apparent horizon geometry.
	readonly includeHorizon: boolean

	// Optional padding for horizon band polygon generation, in SVG pixels.
	readonly horizonBandPaddingPx?: number
}

export type LocalSolarEclipseSvgShape = LocalSolarEclipseSvgCircle | LocalSolarEclipseSvgLine | LocalSolarEclipseSvgPath | LocalSolarEclipseSvgPolygon

export interface LocalSolarEclipseSvgCircle {
	readonly kind: 'circle'
	// Semantic role of this circle.
	readonly role: 'sunDisk' | 'moonDisk' | 'ghostSunDisk' | 'ghostMoonDisk' | 'solarLimb' | 'lunarLimb'
	// Center x in SVG pixels.
	readonly cx: number
	// Center y in SVG pixels.
	readonly cy: number
	// Radius in SVG pixels.
	readonly r: number
}

export interface LocalSolarEclipseSvgLine {
	readonly kind: 'line'
	// Semantic role of this line.
	readonly role: 'horizonLine' | 'trajectoryLine'
	readonly x1: number
	readonly y1: number
	readonly x2: number
	readonly y2: number
}

export interface LocalSolarEclipseSvgPath {
	readonly kind: 'path'
	// Semantic role of this path.
	readonly role: 'trajectoryPath'
	// SVG path data string.
	readonly d: string
}

export interface LocalSolarEclipseSvgPolygon {
	readonly kind: 'polygon'
	// Semantic role of this polygon.
	readonly role: 'horizonBand'
	// Polygon vertices in SVG pixels.
	readonly points: readonly Point[]
}

// Serializable Local View geometry: plain shapes only, no text and no UI.
export interface LocalSolarEclipseViewGeometry {
	// Diagram width in SVG pixels.
	readonly width: number
	// Diagram height in SVG pixels.
	readonly height: number
	// Orientation frame the geometry was built in.
	readonly orientationMode: LocalViewOrientationMode
	// The contact the caller requested as the primary state.
	readonly requestedEvent: LocalEclipseContactKind
	// The contact actually drawn as the primary state: the requested one when available, otherwise the
	// fallback chosen by the builder, or null when no event exists at all.
	readonly selectedEvent: LocalEclipseContactKind | null
	// Solar disk radius in SVG pixels.
	readonly solarRadiusPx: number
	// All drawable shapes.
	readonly shapes: readonly LocalSolarEclipseSvgShape[]
}

// Default Local View options.
const DEFAULT_LOCAL_VIEW_OPTIONS: LocalSolarEclipseViewOptions = {
	width: 450,
	height: 160,
	selectedEvent: 'MAX',
	orientationMode: 'zenith',
	handedness: 'eastRight',
	solarRadiusPx: 34,
	includeGhostDisks: true,
	includeHorizon: true,
	horizonBandPaddingPx: 4,
}

// Builds a Time at a Julian Day, preserving the reference time scale and providers.
function timeAtJulianDay(reference: Time, julianDay: number) {
	return timeShift(reference, julianDay - reference.day - reference.fraction, false)
}

// Computes the local fundamental-plane geometry for one observer at one instant, following the same
// projection used by the global curve solver in sun.eclipse.ts.
export function computeLocalFundamentalState(pbe: PolynomialBesselianElements, longitude: Angle, latitude: Angle, time: Time): LocalFundamentalState {
	const be = evaluateBesselian(pbe, time)
	const H = hourAngleFromLongitude(longitude, be.mu, be.deltaTLongitudeCorrection)

	const sinD = Math.sin(be.d)
	const cosD = Math.cos(be.d)
	const sinH = Math.sin(H)
	const cosH = Math.cos(H)

	const U = Math.atan(F * Math.tan(latitude))
	const rhoSinPhi = F * Math.sin(U)
	const rhoCosPhi = Math.cos(U)

	const ksi = rhoCosPhi * sinH
	const eta = rhoSinPhi * cosD - rhoCosPhi * cosH * sinD
	const zeta = rhoSinPhi * sinD + rhoCosPhi * cosH * cosD

	const u = be.x - ksi
	const v = be.y - eta
	const distance = Math.hypot(u, v)

	const L1 = be.l1 - zeta * be.tanF1
	const L2 = be.l2 - zeta * be.tanF2

	const magnitude = (L1 - distance) / (L1 + L2)
	// Ratio from the local Besselian radii: solar = (L1 + L2) / 2, lunar = (L1 - L2) / 2. This is kept as the
	// source so the C1..C4 tangency separations stay exactly consistent (sep = 1 +- ratio). It is not exactly
	// the ephemeris apparent diameter ratio, since l1/l2 use the slightly different NASA k1/k2 lunar radii
	// (~0.08% apart); that difference is negligible for the Local View.
	const solarRadius = (L1 + L2) * 0.5
	const lunarRadius = (L1 - L2) * 0.5
	// Guarded against degraded Besselian values (e.g. far extrapolation): a non-positive or non-finite radius
	// yields a null ratio rather than a meaningless or negative one.
	const moonSunDiameterRatio = solarRadius > 0 && lunarRadius > 0 && Number.isFinite(solarRadius) && Number.isFinite(lunarRadius) ? lunarRadius / solarRadius : null
	// Central phase = observer strictly inside the umbral/antumbral cone (|L2| - distance > tolerance). This is
	// the robust test for both total and annular: the diameter-ratio magnitude exceeds 1 only for total
	// eclipses (the Moon is larger than the Sun), so a magnitude > 1 test would never flag an annular central
	// phase. The tolerance keeps a point exactly on the central limit (zero central duration) out of it.
	const inCentralCone = Math.abs(L2) - distance > CENTRAL_CONE_TOLERANCE
	const centralPhaseKind: LocalCentralPhaseKind = inCentralCone ? (L2 < 0 ? 'total' : 'annular') : 'none'

	return { time, jd: toJulianDay(time), be, longitude, latitude, hourAngle: normalizeAngle(H), ksi, eta, zeta, u, v, distance, L1, L2, magnitude, moonSunDiameterRatio, centralPhaseKind }
}

// Partial-contact scalar: <= 0 inside the penumbra. Roots are C1 (ingress) and C4 (egress).
function partialContactFunction(state: LocalFundamentalState) {
	return state.distance - state.L1
}

// Central-contact scalar: <= 0 inside the umbra/antumbra. Roots are C2 (ingress) and C3 (egress).
function centralContactFunction(state: LocalFundamentalState) {
	return state.distance - Math.abs(state.L2)
}

// Builds the local fundamental state at a Julian Day, reusing maximumTime as the time-scale reference.
function localStateAtJulianDay(pbe: PolynomialBesselianElements, longitude: Angle, latitude: Angle, jd: number) {
	return computeLocalFundamentalState(pbe, longitude, latitude, timeAtJulianDay(pbe.maximumTime, jd))
}

// Solar altitude (radians) at one instant. With a SunMoonPosition sample it uses the apparent Sun
// right ascension/declination and Greenwich apparent sidereal time; without it, it falls back to the
// Besselian shadow-axis altitude (an approximation: the axis is treated as the Sun direction and the
// geodetic latitude is used directly, matching solarAltitudeAtPoint in sun.eclipse.ts).
function computeSolarAltitude(time: Time, longitude: Angle, latitude: Angle, sample: SunMoonPosition | undefined, fallbackBesselian: InstantBesselianElements): Angle {
	if (sample) {
		const deltaT = sample.deltaT ?? 0
		const ttTime = tt(time)
		const ut1Fraction = ttTime.fraction - deltaT / DAYSEC
		const gast = eraGst06a(ttTime.day, ut1Fraction, ttTime.day, ttTime.fraction)
		const H = normalizePI(gast + longitude - sample.sunRightAscension)
		const sinAltitude = Math.sin(latitude) * Math.sin(sample.sunDeclination) + Math.cos(latitude) * Math.cos(sample.sunDeclination) * Math.cos(H)
		return Math.asin(clamp(sinAltitude, -1, 1))
	}

	const be = fallbackBesselian
	const H = hourAngleFromLongitude(longitude, be.mu, be.deltaTLongitudeCorrection)
	const sinAltitude = Math.sin(be.d) * Math.sin(latitude) + Math.cos(be.d) * Math.cos(latitude) * Math.cos(H)
	return Math.asin(clamp(sinAltitude, -1, 1))
}

// Topocentric local aspect of one contact, derived entirely from the local Besselian fundamental-plane
// state so it stays consistent with the local separation and contacts. The geocentric Moon RA/Dec is NOT
// used to orient the Local View: the lunar position the observer sees is dominated by topocentric parallax,
// which the fundamental-plane offset (u, v) already encodes.
//
// Geometry: with the shadow axis ~ the Sun direction (+z), the observer-to-Moon transverse offset in the
// fundamental plane is exactly (u, v) = (be.x - ksi, be.y - eta), whose axes are celestial (east, north).
// So the lunar CENTER position angle from north toward east is atan2(u, v). The solar parallactic angle q
// rotates that into the zenith frame (Z = P - q). The limb-CONTACT angle equals the center angle except at
// a total internal tangency (C2/C3 total), where the last solar sliver is on the far limb (center + PI).
interface LocalTopocentricAspect {
	// Position angle of the lunar center, from celestial north toward east, in [0, TAU), or null when the
	// Sun-Moon separation is too small for the direction to be defined.
	readonly centerPositionAngleP: Angle | null
	// Position angle of the lunar center in the zenith frame, in [0, TAU), or null.
	readonly centerZenithAngleZ: Angle | null
	// Position angle of the limb-contact point, from celestial north toward east, in [0, TAU), or null.
	readonly contactPositionAngleP: Angle | null
	// Position angle of the limb-contact point in the zenith frame, in [0, TAU), or null.
	readonly contactZenithAngleZ: Angle | null
	// Solar parallactic angle, in [-PI, PI] (always defined, it does not depend on the separation).
	readonly parallacticAngle: Angle
}

// Rotates a center position angle to the corresponding limb-contact angle: identical except at a total
// internal tangency (C2/C3), where the contact point sits on the opposite limb.
function contactAngleFromCenter(kind: LocalEclipseContactKind, centralKind: LocalCentralPhaseKind, centerAngle: Angle) {
	if ((kind === 'C2' || kind === 'C3') && centralKind === 'total') return normalizeAngle(centerAngle + PI)
	return normalizeAngle(centerAngle)
}

// Solar parallactic angle (radians, [-PI, PI]). Uses the apparent Sun right ascension/declination and
// Greenwich apparent sidereal time when a SunMoonPosition sample is available, so it shares the exact source
// the Sun altitude uses; otherwise it falls back to the Besselian shadow-axis declination and hour angle.
function computeSolarParallacticAngle(time: Time, longitude: Angle, latitude: Angle, state: LocalFundamentalState, sample: SunMoonPosition | undefined): Angle {
	if (sample) {
		const deltaT = sample.deltaT ?? 0
		const ttTime = tt(time)
		const ut1Fraction = ttTime.fraction - deltaT / DAYSEC
		const gast = eraGst06a(ttTime.day, ut1Fraction, ttTime.day, ttTime.fraction)
		const H = normalizePI(gast + longitude - sample.sunRightAscension)
		return normalizePI(Math.atan2(Math.sin(H), Math.tan(latitude) * Math.cos(sample.sunDeclination) - Math.sin(sample.sunDeclination) * Math.cos(H)))
	}

	const H = state.hourAngle
	return normalizePI(Math.atan2(Math.sin(H), Math.tan(latitude) * Math.cos(state.be.d) - Math.sin(state.be.d) * Math.cos(H)))
}

// Whether the Sun-Moon separation is too small for the lunar-center direction to be physically meaningful.
// Relative to the local solar radius so it scales with the geometry, falling back to an absolute floor when
// the solar radius is degraded/non-positive.
function isLocalViewAngleUndefined(state: LocalFundamentalState) {
	const solarRadius = (state.L1 + state.L2) * 0.5
	if (!(solarRadius > 0) || !Number.isFinite(solarRadius)) return state.distance <= ANGLE_UNDEFINED_DISTANCE
	return state.distance / solarRadius < ANGLE_UNDEFINED_SEPARATION_SOLAR_RADII
}

function computeLocalTopocentricAspect(kind: LocalEclipseContactKind, state: LocalFundamentalState, time: Time, longitude: Angle, latitude: Angle, sample: SunMoonPosition | undefined): LocalTopocentricAspect {
	const q = computeSolarParallacticAngle(time, longitude, latitude, state, sample)

	// At a near-exact central alignment the lunar-center direction is undefined (atan2(0, 0)); report null
	// rather than a spurious 0. The Local View is unaffected because the separation is ~0 there anyway.
	if (isLocalViewAngleUndefined(state)) {
		return { centerPositionAngleP: null, centerZenithAngleZ: null, contactPositionAngleP: null, contactZenithAngleZ: null, parallacticAngle: q }
	}

	const centerP = normalizeAngle(Math.atan2(state.u, state.v))
	const centerZ = normalizeAngle(centerP - q)
	const centralKind = eventCentralKind(kind, state)

	return {
		centerPositionAngleP: centerP,
		centerZenithAngleZ: centerZ,
		contactPositionAngleP: contactAngleFromCenter(kind, centralKind, centerP),
		contactZenithAngleZ: contactAngleFromCenter(kind, centralKind, centerZ),
		parallacticAngle: q,
	}
}

// Apparent solar angular radius (radians) from the Sun distance, falling back to the mean value.
function computeSolarAngularRadius(sample: SunMoonPosition | undefined): Angle {
	if (sample && sample.sunDistance > 0) return Math.asin(clamp(SUN_RADIUS_EARTH_RADII / sample.sunDistance, -1, 1))
	return SUN_MEAN_ANGULAR_RADIUS
}

// Sun-Moon center separation in local solar radii, guarded so degraded Besselian values never leak a
// non-finite or negative separation into the Local View geometry (cx/cy). Returns 0 when undefined.
function computeSeparationSolarRadii(state: LocalFundamentalState) {
	const solarRadius = (state.L1 + state.L2) * 0.5
	if (!(solarRadius > 0) || !Number.isFinite(solarRadius)) return 0
	if (!(state.distance >= 0) || !Number.isFinite(state.distance)) return 0
	return state.distance / solarRadius
}

// Central-phase character implied by a contact, used for descriptions. For C2/C3 the umbral radius sign
// decides total vs annular; other contacts carry the state's own classification.
function eventCentralKind(kind: LocalEclipseContactKind, state: LocalFundamentalState): LocalCentralPhaseKind {
	if (kind === 'C2' || kind === 'C3') return state.L2 < 0 ? 'total' : 'annular'
	return state.centralPhaseKind
}

// English description for one contact, given its central-phase character.
function describeEvent(kind: LocalEclipseContactKind, centralKind: LocalCentralPhaseKind) {
	switch (kind) {
		case 'C1':
			return 'Beginning of partial phase'
		case 'C2':
			return centralKind === 'annular' ? 'Beginning of annular phase' : 'Beginning of total phase'
		case 'MAX':
			return 'Local maximum'
		case 'C3':
			return centralKind === 'annular' ? 'End of annular phase' : 'End of total phase'
		case 'C4':
			return 'End of partial phase'
	}
}

// Builds one resolved local event at a Julian Day, including altitude, P/Z and the Local View cache.
function buildLocalEvent(kind: LocalEclipseContactKind, jd: number, pbe: PolynomialBesselianElements, longitude: Angle, latitude: Angle, options: LocalSolarEclipseCircumstancesOptions): LocalSolarEclipseEvent {
	const time = timeAtJulianDay(pbe.maximumTime, jd)
	const state = computeLocalFundamentalState(pbe, longitude, latitude, time)
	// One ephemeris sample per event, shared by altitude and angular-radius (was up to three calls).
	const sample = options.sunMoonPosition?.(time)

	const sunAltitude = computeSolarAltitude(time, longitude, latitude, sample, state.be)
	const solarAngularRadius = computeSolarAngularRadius(sample)
	const aspect = computeLocalTopocentricAspect(kind, state, time, longitude, latitude, sample)

	const horizonAltitude = options.horizonAltitude ?? 0
	const observable = sunAltitude >= horizonAltitude

	const separationSolarRadii = computeSeparationSolarRadii(state)
	const centralKind = eventCentralKind(kind, state)

	return {
		kind,
		description: describeEvent(kind, centralKind),
		time,
		jd,
		sunAltitude,
		// The table angles are the limb-contact angles; the Local View uses the center angles below.
		positionAngleP: aspect.contactPositionAngleP,
		zenithAngleZ: aspect.contactZenithAngleZ,
		visibility: observable ? 'aboveHorizon' : 'belowHorizon',
		observable,
		magnitude: state.magnitude,
		moonSunDiameterRatio: state.moonSunDiameterRatio,
		centralPhaseKind: kind === 'C2' || kind === 'C3' ? centralKind : state.centralPhaseKind,
		localViewState: { separationSolarRadii, centerPositionAngleP: aspect.centerPositionAngleP, centerZenithAngleZ: aspect.centerZenithAngleZ, parallacticAngle: aspect.parallacticAngle, sunAltitude, solarAngularRadius },
	}
}

// Refines a bracketed contact root, returning undefined when the bracket is rejected.
function bisectRoot(f: (jd: number) => number, lo: number, hi: number) {
	try {
		return bisection(f, lo, hi, { tolerance: CONTACT_TOLERANCE_DAYS }).root
	} catch {
		return undefined
	}
}

// Finds the Julian Day of the local magnitude maximum within [fromJd, toJd]: a uniform scan brackets the
// best sample, then Brent minimization of the negated magnitude refines it. Returns the sampled best when
// the refinement does not improve, or undefined when nothing finite is found.
export function findLocalMaximumTime(pbe: PolynomialBesselianElements, longitude: Angle, latitude: Angle, fromJd: number, toJd: number, stepDays: number): number | undefined {
	let bestJd: number | undefined
	let bestMagnitude = -Infinity

	for (let jd = fromJd; jd <= toJd + 1e-12; jd += stepDays) {
		const magnitude = localStateAtJulianDay(pbe, longitude, latitude, jd).magnitude
		if (Number.isFinite(magnitude) && magnitude > bestMagnitude) {
			bestMagnitude = magnitude
			bestJd = jd
		}
	}

	if (bestJd === undefined) return undefined

	const lo = Math.max(fromJd, bestJd - stepDays)
	const hi = Math.min(toJd, bestJd + stepDays)

	try {
		const result = brentMinimize((jd) => -localStateAtJulianDay(pbe, longitude, latitude, jd).magnitude, lo, hi, { tolerance: CONTACT_TOLERANCE_DAYS })
		if (Number.isFinite(result.minimum) && localStateAtJulianDay(pbe, longitude, latitude, result.minimum).magnitude >= bestMagnitude) return result.minimum
	} catch {
		// Fall back to the sampled maximum.
	}

	return bestJd
}

// Inserts a root unless an equal one (within ~10x the time tolerance) is already present.
function pushUniqueRoot(roots: number[], root: number) {
	if (!roots.some((existing) => Math.abs(existing - root) < CONTACT_TOLERANCE_DAYS * 10)) roots.push(root)
}

function NumberComparator(a: number, b: number) {
	return a - b
}

// Refines a sampled local minimum of a contact function (fn <= 0 inside the phase) within a one-step bracket.
// Two outcomes are distinguished. A true grazing contact, where the minimum just touches zero, yields one
// double root. A finite phase so short that BOTH its contacts fell between two samples, where the minimum
// dips below zero while both bracket ends stay positive, yields two roots recovered by bisection on each side
// of the minimum (a single |fn| minimization would return only one of them).
function refineMissedContactInterval(evaluate: (jd: number) => number, lo: number, hi: number, roots: number[]) {
	let mid: number
	try {
		mid = brentMinimize(evaluate, lo, hi, { tolerance: CONTACT_TOLERANCE_DAYS }).minimum
	} catch {
		return
	}

	const midValue = evaluate(mid)
	if (!Number.isFinite(mid) || !Number.isFinite(midValue)) return

	// Grazing contact: the minimum touches zero, a single double root.
	if (Math.abs(midValue) <= CONTACT_FUNCTION_TOLERANCE) {
		pushUniqueRoot(roots, mid)
		return
	}

	// Missed finite interval: a negative minimum with a contact on each side that is still outside the phase.
	if (midValue < -CONTACT_FUNCTION_TOLERANCE) {
		if (evaluate(lo) > 0) {
			const left = bisectRoot(evaluate, lo, mid)
			if (left !== undefined) pushUniqueRoot(roots, left)
		}
		if (evaluate(hi) > 0) {
			const right = bisectRoot(evaluate, mid, hi)
			if (right !== undefined) pushUniqueRoot(roots, right)
		}
	}
}

// Finds every Julian Day in [fromJd, toJd] where the scalar contact function fn reaches zero, by uniform
// scan plus refinement. Transversal roots (sign changes) are bracketed directly; grazing roots and short
// phases whose two contacts fall entirely between two samples (no sign change, a sub-sample negative dip)
// are recovered from interior local minima. Roots are deduplicated and returned sorted ascending.
export function findLocalContactRoots(pbe: PolynomialBesselianElements, longitude: Angle, latitude: Angle, fromJd: number, toJd: number, stepDays: number, fn: (state: LocalFundamentalState) => number): readonly number[] {
	const evaluate = (jd: number) => fn(localStateAtJulianDay(pbe, longitude, latitude, jd))
	const roots: number[] = []

	// Sample the whole window once so neighboring triplets can be inspected for grazing extrema.
	const jds: number[] = []
	const values: number[] = []
	for (let jd = fromJd; jd <= toJd + 1e-12; jd += stepDays) {
		jds.push(jd)
		values.push(evaluate(jd))
	}

	// Transversal roots: exact zeros on a sample and sign changes between neighbors.
	for (let k = 0; k < jds.length; k++) {
		if (values[k] === 0) {
			pushUniqueRoot(roots, jds[k])
		} else if (k + 1 < jds.length && values[k] * values[k + 1] < 0) {
			const root = bisectRoot(evaluate, jds[k], jds[k + 1])
			if (root !== undefined) pushUniqueRoot(roots, root)
		}
	}

	// Grazing/sub-sample roots: an interior local MINIMUM that comes near zero without changing sign. These
	// contact functions are negative inside the phase, so a contact is always a minimum touching/dipping below
	// zero from positive values; only minima are inspected (a near-maximum near zero has no root and could
	// invent one). The test is tie-tolerant so a tied valley bottom straddling the true instant is still
	// caught, and only brackets whose samples already approach zero are refined. Overlaps with transversal
	// roots dedup away.
	for (let k = 1; k + 1 < jds.length; k++) {
		const nearMinimum = values[k] <= values[k - 1] + CONTACT_SAMPLE_EXTREMUM_EPS && values[k] <= values[k + 1] + CONTACT_SAMPLE_EXTREMUM_EPS
		if (!nearMinimum) continue
		if (Math.min(Math.abs(values[k - 1]), Math.abs(values[k]), Math.abs(values[k + 1])) > GRAZING_SCAN_PREFILTER) continue

		refineMissedContactInterval(evaluate, jds[k - 1], jds[k + 1], roots)
	}

	return roots.sort(NumberComparator)
}

// Closest root strictly before a reference Julian Day, or undefined.
function rootBefore(roots: readonly number[], reference: number) {
	let best: number | undefined
	for (const root of roots) if (root < reference && (best === undefined || root > best)) best = root
	return best
}

// Closest root strictly after a reference Julian Day, or undefined.
function rootAfter(roots: readonly number[], reference: number) {
	let best: number | undefined
	for (const root of roots) if (root > reference && (best === undefined || root < best)) best = root
	return best
}

// Resolves the local C1/C2/MAX/C3/C4 events. C2/C3 are only sought when the local maximum is central, so
// a partial-only local eclipse never invents central contacts. Every event is computed geometrically even
// when the Sun is below the horizon; only its observability flag reflects the horizon.
export function computeLocalEclipseEvents(pbe: PolynomialBesselianElements, longitude: Angle, latitude: Angle, options: LocalSolarEclipseCircumstancesOptions): LocalSolarEclipseCircumstances['events'] {
	const empty = { C1: null, C2: null, MAX: null, C3: null, C4: null } as const

	const span = validPositive(options.contactSearchSpan, DEFAULT_CONTACT_SEARCH_SPAN_SECONDS) / DAYSEC
	const stepDays = validPositive(options.localSearchStepSeconds, DEFAULT_LOCAL_SEARCH_STEP_SECONDS) / DAYSEC
	const maxSpan = Math.max(span, MAX_CONTACT_SEARCH_SPAN_SECONDS / DAYSEC)
	const centerJd = toJulianDay(pbe.maximumTime)

	// The maximum search is adaptive too: if the sampled maximum lands on the window edge the true maximum may
	// lie just outside, which would also misplace the contacts around it. Widen (bounded by maxSpan) until the
	// maximum sits clear of the boundary.
	let maximumSpan = span
	let maximumJd = findLocalMaximumTime(pbe, longitude, latitude, centerJd - maximumSpan, centerJd + maximumSpan, stepDays)
	if (maximumJd === undefined) return empty

	while (maximumSpan < maxSpan) {
		const margin = stepDays * 2
		const nearBoundary = maximumJd <= centerJd - maximumSpan + margin || maximumJd >= centerJd + maximumSpan - margin
		if (!nearBoundary) break
		maximumSpan = Math.min(maximumSpan * 1.5, maxSpan)
		const widened = findLocalMaximumTime(pbe, longitude, latitude, centerJd - maximumSpan, centerJd + maximumSpan, stepDays)
		if (widened === undefined) break
		maximumJd = widened
	}

	const maximumState = localStateAtJulianDay(pbe, longitude, latitude, maximumJd)
	// No local eclipse: even at closest approach the disks do not touch (magnitude <= 0).
	if (!(maximumState.magnitude > 0)) return empty

	const MAX = buildLocalEvent('MAX', maximumJd, pbe, longitude, latitude, options)

	// Resolves the two contacts (ingress before / egress after the maximum) bracketing the maximum for a
	// contact function, expanding the search window from `span` toward `maxSpan` while either is still
	// missing. Expansion is bounded so the Besselian polynomial is never evaluated far past its +-3 h fit.
	const resolveContacts = (fn: (state: LocalFundamentalState) => number) => {
		let currentSpan = span
		let before: number | undefined
		let after: number | undefined

		while (true) {
			const roots = findLocalContactRoots(pbe, longitude, latitude, centerJd - currentSpan, centerJd + currentSpan, stepDays, fn)
			before = rootBefore(roots, maximumJd)
			after = rootAfter(roots, maximumJd)
			if ((before !== undefined && after !== undefined) || currentSpan >= maxSpan) break
			currentSpan = Math.min(currentSpan * 1.5, maxSpan)
		}

		return { before, after }
	}

	const partial = resolveContacts(partialContactFunction)
	const C1 = partial.before !== undefined ? buildLocalEvent('C1', partial.before, pbe, longitude, latitude, options) : null
	const C4 = partial.after !== undefined ? buildLocalEvent('C4', partial.after, pbe, longitude, latitude, options) : null

	let C2: LocalSolarEclipseEvent | null = null
	let C3: LocalSolarEclipseEvent | null = null

	if (maximumState.centralPhaseKind !== 'none') {
		const central = resolveContacts(centralContactFunction)
		C2 = central.before !== undefined ? buildLocalEvent('C2', central.before, pbe, longitude, latitude, options) : null
		C3 = central.after !== undefined ? buildLocalEvent('C3', central.after, pbe, longitude, latitude, options) : null
	}

	return { C1, C2, MAX, C3, C4 }
}

function validPositive(value: number | undefined, fallback: number) {
	return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback
}

// Human-readable text for a visibility classification.
export function localVisibilityText(kind: LocalVisibilityKind) {
	switch (kind) {
		case 'notVisible':
			return 'No eclipse at this location'
		case 'geometricOnlyBelowHorizon':
			return 'Eclipse occurs but the Sun is below the horizon'
		case 'partiallyVisible':
			return 'Eclipse partially visible'
		case 'completelyVisible':
			return 'Entire eclipse visible'
		case 'centralPhaseVisible':
			return 'Central phase visible'
		case 'partialOnlyVisible':
			return 'Only the partial phase is visible'
	}
}

// Classifies local visibility from the resolved events.
function computeLocalVisibility(events: LocalSolarEclipseCircumstances['events']): LocalSolarEclipseCircumstances['visibility'] {
	const { C1, C2, MAX, C3, C4 } = events

	if (!MAX) {
		return { kind: 'notVisible', text: localVisibilityText('notVisible'), hasGeometricEclipse: false, hasObservableEclipse: false, hasCentralPhase: false, centralPhaseKind: 'none', completeness: { partialContactsComplete: false, centralContactsComplete: false } }
	}

	// Central phase is decided by the local maximum, not by C2/C3 existing: a narrow window or a grazing
	// (tangential) central contact may fail to yield both endpoints even though the maximum is central.
	const hasCentralPhase = MAX.centralPhaseKind !== 'none'
	const centralPhaseKind: LocalCentralPhaseKind = MAX.centralPhaseKind

	// The events expected for this eclipse character. `completelyVisible` requires this full set to exist and
	// be above the horizon, so a missing contact never masquerades as a fully visible eclipse.
	const expected = hasCentralPhase ? [C1, C2, MAX, C3, C4] : [C1, MAX, C4]
	const completeEventSet = expected.every((event) => event !== null)
	const allExpectedAbove = expected.every((event) => event?.observable === true)
	const anyAbove = [C1, C2, MAX, C3, C4].some((event) => event?.observable === true)

	let kind: LocalVisibilityKind
	if (!anyAbove) {
		kind = 'geometricOnlyBelowHorizon'
	} else if (completeEventSet && allExpectedAbove) {
		kind = 'completelyVisible'
	} else if (hasCentralPhase && ((C2?.observable ?? false) || (C3?.observable ?? false) || MAX.observable)) {
		kind = 'centralPhaseVisible'
	} else if (!hasCentralPhase) {
		kind = 'partialOnlyVisible'
	} else {
		kind = 'partiallyVisible'
	}

	const completeness = { partialContactsComplete: C1 !== null && C4 !== null, centralContactsComplete: !hasCentralPhase || (C2 !== null && C3 !== null) }
	return { kind, text: localVisibilityText(kind), hasGeometricEclipse: true, hasObservableEclipse: anyAbove, hasCentralPhase, centralPhaseKind, completeness }
}

// Maximum geodesic half-width (km) probed when measuring the central shadow path on the ground. A genuine
// local path width stays well under this; a probe that runs past it (e.g. a grazing umbra near the
// terminator, whose ground footprint stretches enormously) is reported as null instead of an absurd value.
const MAX_SHADOW_HALF_WIDTH_KM = 600
// March step (km) for the central-edge search across the path.
const SHADOW_EDGE_STEP_KM = 5

// Destination geographic point reached from (lon, lat) along a great-circle bearing (from north toward
// east) after a surface distance, on a sphere of radius EARTH_RADIUS_KM.
function destinationPoint(longitude: Angle, latitude: Angle, bearing: Angle, distanceKm: number): readonly [Angle, Angle] {
	const angular = distanceKm / EARTH_RADIUS_KM
	const sinLat = Math.sin(latitude)
	const cosLat = Math.cos(latitude)
	const sinAng = Math.sin(angular)
	const cosAng = Math.cos(angular)
	const lat2 = Math.asin(clamp(sinLat * cosAng + cosLat * sinAng * Math.cos(bearing), -1, 1))
	const lon2 = longitude + Math.atan2(Math.sin(bearing) * sinAng * cosLat, cosAng - sinLat * Math.sin(lat2))
	return [lon2, lat2]
}

// Distance (km) from the observer to the central-shadow edge along a bearing at a fixed instant: marches
// outward until the central-contact function turns non-negative (leaves the umbra/antumbra), then bisects.
// Returns undefined when no edge is found within MAX_SHADOW_HALF_WIDTH_KM.
function findCentralShadowEdgeKm(centralValueAt: (longitude: Angle, latitude: Angle) => number, longitude: Angle, latitude: Angle, bearing: Angle): number | undefined {
	let previousKm = 0
	let previousValue = centralValueAt(longitude, latitude)

	for (let distanceKm = SHADOW_EDGE_STEP_KM; distanceKm <= MAX_SHADOW_HALF_WIDTH_KM; distanceKm += SHADOW_EDGE_STEP_KM) {
		const [lon, lat] = destinationPoint(longitude, latitude, bearing, distanceKm)
		const value = centralValueAt(lon, lat)

		if (previousValue < 0 && value >= 0) {
			let lo = previousKm
			let hi = distanceKm
			for (let i = 0; i < 40 && hi - lo > 1e-3; i++) {
				const mid = (lo + hi) * 0.5
				const [midLon, midLat] = destinationPoint(longitude, latitude, bearing, mid)
				if (centralValueAt(midLon, midLat) < 0) lo = mid
				else hi = mid
			}
			return (lo + hi) * 0.5
		}

		previousKm = distanceKm
		previousValue = value
	}

	return undefined
}

// Number of bearings (over a half turn) probed for the narrowest central-shadow chord.
const SHADOW_CHORD_BEARING_COUNT = 24

// Narrowest bidirectional central-shadow chord (km) through the observer, scanned over several bearings and
// then refined around the best one. Unlike a single gradient direction this is well defined even at the exact
// center of the shadow, where the central-contact function distance - |L2| has a non-differentiable cone
// point and the gradient vanishes by symmetry. For each bearing the two opposite edges are summed; the
// discrete minimum over all bearings is refined by a 1-D minimization within one angular step, so the result
// is not capped at the PI / count grid resolution. Returns null when no opposite pair of edges is found.
function computeCentralShadowChordWidthByBearingsKm(centralValueAt: (longitude: Angle, latitude: Angle) => number, longitude: Angle, latitude: Angle): number | null {
	const chordWidthAtBearing = (bearing: Angle) => {
		const forward = findCentralShadowEdgeKm(centralValueAt, longitude, latitude, bearing)
		const backward = findCentralShadowEdgeKm(centralValueAt, longitude, latitude, bearing + PI)
		return forward === undefined || backward === undefined ? undefined : forward + backward
	}

	const step = PI / SHADOW_CHORD_BEARING_COUNT
	let best: number | null = null
	let bestBearing = 0

	for (let i = 0; i < SHADOW_CHORD_BEARING_COUNT; i++) {
		const bearing = i * step
		const width = chordWidthAtBearing(bearing)
		if (width === undefined) continue
		if (best === null || width < best) {
			best = width
			bestBearing = bearing
		}
	}

	if (best === null) return null

	// Refine the bearing within one grid step; the true minimum chord usually lies between two samples.
	try {
		const refined = brentMinimize((bearing) => chordWidthAtBearing(normalizeAngle(bearing)) ?? Infinity, bestBearing - step, bestBearing + step, { tolerance: 1e-4 })
		if (Number.isFinite(refined.value) && refined.value < best) best = refined.value
	} catch {
		// Keep the discrete minimum.
	}

	return best
}

// Robust local width (km) of the central (total/annular) shadow path, measured on the Earth's surface at the
// instant of the local maximum. The umbra/antumbra footprint is found directly in geographic coordinates: the
// narrowest chord through the observer (scanned over several bearings) is the across-path width, with the path
// edges being where the central-contact function vanishes on either side. Working on the ground makes the
// foreshortening near the horizon implicit, avoiding the 1 / sin(altitude) blow-up of a fundamental-plane
// estimate, and the multi-bearing scan stays well defined even at the exact center of the shadow. Returns
// null when the maximum is not central, the observer is not inside the central shadow, or no edge is found
// within MAX_SHADOW_HALF_WIDTH_KM.
export function computeLocalShadowPathWidthKm(pbe: PolynomialBesselianElements, longitude: Angle, latitude: Angle, maxEvent: LocalSolarEclipseEvent): number | null {
	if (maxEvent.centralPhaseKind === 'none') return null

	const time = timeAtJulianDay(pbe.maximumTime, maxEvent.jd)
	const centralValueAt = (lon: Angle, lat: Angle) => centralContactFunction(computeLocalFundamentalState(pbe, lon, lat, time))

	// The observer must be strictly inside the central shadow, using the same margin as the central-phase
	// classification so a tangential (zero-duration) edge is treated consistently as not central.
	if (!(centralValueAt(longitude, latitude) < -CENTRAL_CONE_TOLERANCE)) return null

	return computeCentralShadowChordWidthByBearingsKm(centralValueAt, longitude, latitude)
}

// Computes the local detail summary (magnitude, ratios and durations) from the resolved events.
function computeLocalDetails(events: LocalSolarEclipseCircumstances['events'], shadowPathWidthKm: number | null): LocalSolarEclipseCircumstances['details'] {
	const { C1, C2, MAX, C3, C4 } = events

	return {
		maximalMagnitude: MAX ? MAX.magnitude : null,
		moonSunDiameterRatio: MAX ? MAX.moonSunDiameterRatio : null,
		partialPhaseDurationSeconds: C1 && C4 ? (C4.jd - C1.jd) * DAYSEC : null,
		centralPhaseDurationSeconds: C2 && C3 ? (C3.jd - C2.jd) * DAYSEC : null,
		shadowPathWidthKm,
	}
}

// Returns the event's Local View state or throws: drawing without it would silently place the Moon
// concentric with the Sun, which looks valid but is physically wrong. Events from buildLocalEvent always
// carry it; this guards against externally constructed events.
function requireLocalViewState(event: LocalSolarEclipseEvent): LocalViewEventState {
	if (!event.localViewState) throw new Error(`Local View requires localViewState for ${event.kind}`)
	return event.localViewState
}

// Computes the solar and lunar disk circles for one event in the Local View frame. The Sun is centered in
// the diagram; the Moon is offset by the local separation along the lunar-CENTER position angle (never the
// limb-contact angle), measured from the top of the diagram clockwise.
export function computeLocalViewDiskPair(event: LocalSolarEclipseEvent, options: LocalSolarEclipseViewOptions): { sun: LocalSolarEclipseSvgCircle; moon: LocalSolarEclipseSvgCircle } {
	const viewState = requireLocalViewState(event)
	const sunCx = options.width * 0.5
	const sunCy = options.height * 0.5
	const sunR = options.solarRadiusPx
	// Fall back to a unit ratio for a missing or degraded value, so the Moon disk is never zero/negative.
	const ratio = event.moonSunDiameterRatio !== null && event.moonSunDiameterRatio > 0 && Number.isFinite(event.moonSunDiameterRatio) ? event.moonSunDiameterRatio : 1
	const moonR = sunR * ratio

	const separationPx = viewState.separationSolarRadii * sunR
	const angle = (options.orientationMode === 'zenith' ? viewState.centerZenithAngleZ : viewState.centerPositionAngleP) ?? 0

	// Position angle grows from up (north/zenith) clockwise toward east. `eastRight` (default) keeps east on
	// the right; `eastLeft` mirrors the horizontal axis for the sky-chart convention.
	const eastSign = options.handedness === 'eastLeft' ? -1 : 1
	const dx = eastSign * separationPx * Math.sin(angle)
	const dy = -separationPx * Math.cos(angle)

	return {
		sun: { kind: 'circle', role: 'sunDisk', cx: sunCx, cy: sunCy, r: sunR },
		moon: { kind: 'circle', role: 'moonDisk', cx: sunCx + dx, cy: sunCy + dy, r: moonR },
	}
}

// Converts a solar altitude to its signed Local View offset (px) from the Sun center along the zenith
// direction. Guarded against non-finite inputs and clamped only for numerical stability (not physics).
function altitudeToLocalViewOffsetPx(sunAltitude: Angle, solarAngularRadius: Angle | null, solarRadiusPx: number, width: number, height: number) {
	if (!solarAngularRadius || !(solarAngularRadius > 0)) return 0
	const offset = (sunAltitude / solarAngularRadius) * solarRadiusPx
	if (!Number.isFinite(offset)) return 0
	const maxOffset = Math.hypot(width, height) * 2
	return clamp(offset, -maxOffset, maxOffset)
}

// Builds the apparent-horizon geometry for one event: a horizon line whose distance from the Sun center
// reflects the solar altitude, plus a band polygon on the below-horizon side.
//
// In the `zenith` frame the zenith is straight up, so the horizon is horizontal and a positive altitude
// pushes it below the Sun center. In the `north` frame the top is celestial north, so the zenith is rotated
// from "up" by the solar parallactic angle q; the horizon is rotated with it. At q = 0 the north frame
// reduces exactly to the zenith frame.
export function buildLocalViewHorizonGeometry(event: LocalSolarEclipseEvent, options: LocalSolarEclipseViewOptions): readonly LocalSolarEclipseSvgShape[] {
	const viewState = requireLocalViewState(event)
	const sunCx = options.width * 0.5
	const sunCy = options.height * 0.5

	// Zenith direction (unit) in SVG pixels (y grows downward): straight up in zenith mode, rotated by the
	// parallactic angle in north mode. The horizontal component carries the same handedness sign as the Moon
	// offset, so a mirrored (`eastLeft`) diagram keeps the horizon consistent with the lunar position.
	const eastSign = options.handedness === 'eastLeft' ? -1 : 1
	const q = options.orientationMode === 'north' ? (viewState.parallacticAngle ?? 0) : 0
	const zenithX = eastSign * Math.sin(q)
	const zenithY = -Math.cos(q)

	const offsetPx = altitudeToLocalViewOffsetPx(event.sunAltitude, viewState.solarAngularRadius, options.solarRadiusPx, options.width, options.height)
	// A point on the horizon: from the Sun center, move away from the zenith by the altitude offset.
	const horizonX = sunCx - offsetPx * zenithX
	const horizonY = sunCy - offsetPx * zenithY

	// The horizon line runs perpendicular to the zenith direction; make it long enough to span the diagram.
	const tangentX = -zenithY
	const tangentY = zenithX
	const half = Math.hypot(options.width, options.height)
	const line: LocalSolarEclipseSvgLine = {
		kind: 'line',
		role: 'horizonLine',
		x1: horizonX - tangentX * half,
		y1: horizonY - tangentY * half,
		x2: horizonX + tangentX * half,
		y2: horizonY + tangentY * half,
	}

	// The band fills the half-plane away from the zenith (below the horizon), left to be clipped by the SVG
	// viewport. Its near edge starts the padding ABOVE the line (toward the zenith) so the fill meets the line
	// with no antialiasing gap, and its far edge is oversized enough to cover the whole viewport even when the
	// altitude offset is clamped far outside it (the offset reaches up to 2 * half, so 4 * half always reaches
	// across the diagram from a clamped horizon).
	const padding = options.horizonBandPaddingPx ?? 0
	const awayX = -zenithX
	const awayY = -zenithY
	const near = -padding
	const far = padding + 4 * half
	const band: LocalSolarEclipseSvgPolygon = {
		kind: 'polygon',
		role: 'horizonBand',
		points: [
			{ x: horizonX - tangentX * half + awayX * near, y: horizonY - tangentY * half + awayY * near },
			{ x: horizonX + tangentX * half + awayX * near, y: horizonY + tangentY * half + awayY * near },
			{ x: horizonX + tangentX * half + awayX * far, y: horizonY + tangentY * half + awayY * far },
			{ x: horizonX - tangentX * half + awayX * far, y: horizonY - tangentY * half + awayY * far },
		],
	}

	// Band first (filled ground), then the line on top of it, in painter's order.
	return [band, line]
}

// Picks the event to draw as primary: the requested one, else MAX, else the first available contact.
function selectPrimaryEvent(events: LocalSolarEclipseCircumstances['events'], selectedEvent: LocalEclipseContactKind) {
	const requested = events[selectedEvent]
	if (requested) return requested
	if (events.MAX) return events.MAX
	for (const kind of CONTACT_ORDER) {
		const event = events[kind]
		if (event) return event
	}
	return null
}

// Builds the serializable Local View geometry from the resolved events. Emits only geometric shapes: no
// labels, no text primitives and no UI controls.
export function buildLocalSolarEclipseViewGeometry(circumstances: Pick<LocalSolarEclipseCircumstances, 'events'>, options: LocalSolarEclipseViewOptions): LocalSolarEclipseViewGeometry {
	const events = circumstances.events
	const shapes: LocalSolarEclipseSvgShape[] = []
	const primary = selectPrimaryEvent(events, options.selectedEvent)

	// Ghost MOON disks for every other available contact, drawn behind the primary state. The Sun is fixed
	// at the diagram center, so a per-contact ghost Sun would only stack redundant circles; what differs
	// between contacts is the lunar position, so only the Moon is ghosted.
	if (options.includeGhostDisks) {
		for (const kind of CONTACT_ORDER) {
			const event = events[kind]
			if (!event || event === primary) continue
			const { moon } = computeLocalViewDiskPair(event, options)
			shapes.push({ ...moon, role: 'ghostMoonDisk' })
		}
	}

	// Primary Sun and Moon disks first, then the horizon on top, so the ground band occludes the part of the
	// disks below the horizon (e.g. a sunrise/sunset eclipse), matching the Astrarium foreground convention.
	if (primary) {
		const pair = computeLocalViewDiskPair(primary, options)
		shapes.push(pair.sun, pair.moon)
	}

	if (primary && options.includeHorizon) shapes.push(...buildLocalViewHorizonGeometry(primary, options))

	return { width: options.width, height: options.height, orientationMode: options.orientationMode, requestedEvent: options.selectedEvent, selectedEvent: primary?.kind ?? null, solarRadiusPx: options.solarRadiusPx, shapes }
}

// Computes the full local circumstances for a geographic point: resolves contacts, summarizes details,
// classifies visibility, and optionally builds the Local View. The result is immutable and serializable;
// times are returned as Time/Julian Day and durations in seconds (the UI formats them).
export function computeLocalSolarEclipseCircumstances(pbe: PolynomialBesselianElements, longitude: Angle, latitude: Angle, options: LocalSolarEclipseCircumstancesOptions = {}): LocalSolarEclipseCircumstances {
	const events = computeLocalEclipseEvents(pbe, longitude, latitude, options)
	const visibility = computeLocalVisibility(events)
	const shadowPathWidthKm = events.MAX ? computeLocalShadowPathWidthKm(pbe, longitude, latitude, events.MAX) : null
	const details = computeLocalDetails(events, shadowPathWidthKm)

	const result: LocalSolarEclipseCircumstances = {
		location: { longitude, latitude },
		visibility,
		details,
		events,
	}

	if (options.includeLocalView) {
		const viewOptions: LocalSolarEclipseViewOptions = { ...DEFAULT_LOCAL_VIEW_OPTIONS, ...options.localView }
		return { ...result, localView: buildLocalSolarEclipseViewGeometry({ events }, viewOptions) }
	}

	return result
}
