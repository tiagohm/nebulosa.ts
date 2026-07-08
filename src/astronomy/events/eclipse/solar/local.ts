import { ASEC2RAD, DAYSEC, EARTH_RADIUS_KM, PI } from '../../../../core/constants'
import type { Point } from '../../../../math/numerical/geometry'
import { clamp } from '../../../../math/numerical/math'
import { bisection, brentMinimize, type RootFindingOptions } from '../../../../math/numerical/optimization'
import { type Angle, normalizeAngle, normalizePI } from '../../../../math/units/angle'
import { nearestSolarEclipse, type SolarEclipse } from '../../../bodies/sun'
import { eraGst06a } from '../../../coordinates/erfa/erfa'
import { F, hourAngleFromLongitude, type SunMoonPosition } from '../eclipse'
// oxfmt-ignore
import { besselianSampleAtJulianDay, centralAxisIntersectsEarth, centralLineKind, computePolynomialBesselianElements, evaluateBesselian, findMaximumPoint, projectFundamentalPoint, solarAltitudeAtPoint, SUN_RADIUS_EARTH_RADII, type SolarEclipseGeoPoint, type InstantBesselianElements, type PolynomialBesselianElements } from './map'
import type { Writable } from '../../../../core/types'
import { type Time, timeAtJulianDay, toJulianDay, tt } from '../../../time/time'

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
// Minimum scan step (seconds) for the eclipse-interval Sun-altitude maximum. The altitude peak is broad, so a
// coarse scan brackets it and Brent refines; this bounds the ephemeris cost of the observable-interval check.
const ALTITUDE_SCAN_MIN_STEP_SECONDS = 300
// Root tolerance for local contact instants, in days (~1 ms).
const CONTACT_TOLERANCE_DAYS = 1e-8
// Absolute resolution (days, ~30 s) used to densify a candidate contact bracket before refining it
const CONTACT_REFINE_SUBSTEP_DAYS = 30 / DAYSEC
// Physical tolerance (Earth equatorial radii) for a grazing (tangential) contact: a local extremum of the
// contact function whose refined |value| stays within this is accepted as a double root even without a sign
// change. ~6e-3 km at the Earth's surface; tight enough not to invent contacts on a clearly partial location.
const CONTACT_FUNCTION_TOLERANCE = 1e-6
// Tie tolerance for detecting a sampled local extremum of a contact function, so a flat/tied valley bottom
// (e.g. two equal samples straddling the true grazing instant) is still recognized.
const CONTACT_SAMPLE_EXTREMUM_EPS = 1e-12
// Minimum margin (Earth equatorial radii) by which the observer must be inside the umbral/antumbral cone to
// count as a central phase. A point exactly on the central limit (distance ~ |L2|) has zero central duration
// and must not be reported as total/annular. Deliberately equal to CONTACT_FUNCTION_TOLERANCE: a central
// phase shallower than that is treated by the root finder as a single grazing tangency rather than two
// distinct C2/C3 contacts, so classifying it as a finite central phase would be self-contradictory (central
// kind set but no resolvable central duration). Keeping them aligned keeps centralPhaseKind, C2/C3 and the
// central duration mutually consistent.
const CENTRAL_CONE_TOLERANCE = CONTACT_FUNCTION_TOLERANCE
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

// Vertical trend of the Sun over the eclipse, for composing "on sunrise/sunset" qualifiers: `setting` when
// the Sun is descending across the contacts, `rising` when ascending, `none` when flat (near culmination) or undetermined.
export type LocalSunMotion = 'rising' | 'setting' | 'none'

// Orientation frame for the Local View geometry.
export type LocalViewOrientationMode = 'zenith' | 'north'

// Horizontal handedness of the Local View. With north up, `eastRight` puts celestial east to the right of
// the diagram (image/map-like, the default), while `eastLeft` puts east to the left (the conventional
// naked-eye / sky-chart orientation, e.g. Astrarium). Only the sign of the horizontal axis changes; the
// physics of the contacts is untouched.
export type LocalViewHandedness = 'eastRight' | 'eastLeft'

// Options controlling the local circumstances computation.
export interface LocalSolarEclipseCircumstancesOptions {
	// Altitude (radians) of the apparent horizon; an event is observable when the Sun is at or above it.
	readonly horizonAltitude?: Angle
	// Strongly preferred for accurate Sun altitude, P/Z, apparent diameters and Local View.
	// This should be the same physical source used to build the PolynomialBesselianElements, e.g. VSOP/ELP + ERFA.
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
		// Whether any part of the local eclipse is observable with the Sun at or above the configured horizon
		// (true even when every contact is below the horizon but the Sun rises above it between contacts).
		readonly hasObservableEclipse: boolean
		// Whether a central (total/annular) phase reaches this location.
		readonly hasCentralPhase: boolean
		// Character of the central phase, or 'none' for a partial-only local eclipse.
		readonly centralPhaseKind: LocalCentralPhaseKind
		// Vertical trend of the Sun across the eclipse (so the UI can say "on sunset"/"on sunrise"), or 'none'.
		readonly sunMotion: LocalSunMotion
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
		// Maximal local magnitude, or undefined when there is no local eclipse.
		readonly maximalMagnitude?: number
		// Moon/Sun apparent diameter ratio at maximum, or undefined when unavailable.
		readonly moonSunDiameterRatio?: number
		// Partial-phase duration in seconds (C4 - C1), or undefined.
		readonly partialPhaseDuration?: number
		// Central-phase duration in seconds (C3 - C2), or undefined.
		readonly centralPhaseDuration?: number
		// Width (km) of the local central-shadow chord through the observer at maximum, measured across the
		// path on a spherical Earth. This is NOT necessarily the canonical path width reported on the central
		// line (Astrarium/EclipseWise): for an off-center observer it is the chord through their own location.
		// undefined when the maximum is not central, the observer is outside the central shadow, or no edge is
		// found within MAX_SHADOW_HALF_WIDTH_KM.
		readonly shadowPathWidthKm?: number
	}
	readonly events: {
		readonly C1?: LocalSolarEclipseEvent
		readonly C2?: LocalSolarEclipseEvent
		readonly MAX?: LocalSolarEclipseEvent
		readonly C3?: LocalSolarEclipseEvent
		readonly C4?: LocalSolarEclipseEvent
	}
}

// Internal per-event state needed to draw the Local View without recomputing the fundamental geometry. The
// Local View draws the lunar CENTER, so these are the center position angles, not the limb-contact angles
// reported on the event (positionAngleP/zenithAngleZ).
export interface LocalViewEventState {
	// Sun-Moon center separation in solar radii at the event.
	readonly separationSolarRadii: number
	// Position angle of the lunar center from celestial north toward east, or undefined.
	readonly centerPositionAngle?: Angle
	// Zenith-oriented position angle of the lunar center, or undefined.
	readonly centerZenithAngle?: Angle
	// Solar parallactic angle (radians) at the event, used to rotate the horizon in the north frame, or undefined.
	readonly parallacticAngle?: Angle
	// Solar altitude (radians) at the event.
	readonly sunAltitude: Angle
	// Apparent solar angular radius (radians), or undefined when unavailable.
	readonly solarAngularRadius?: Angle
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
	readonly positionAngle?: Angle
	// Same contact-point angle in the local zenith-oriented frame, normalized to [0, TAU).
	readonly zenithAngle?: Angle
	// Whether the Sun is above or below the horizon at the event.
	readonly visibility: LocalEventVisibility
	// Whether the event is observable (Sun at or above the configured horizon altitude).
	readonly observable: boolean
	// Local magnitude at the event.
	readonly magnitude: number
	// Moon/Sun apparent diameter ratio at the event, or undefined when unavailable.
	readonly moonSunDiameterRatio?: number
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
	// Moon/Sun apparent diameter ratio, or undefined when the solar radius is non-positive.
	readonly moonSunDiameterRatio?: number
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

// Any one drawable Local View shape.
export type LocalSolarEclipseSvgShape = LocalSolarEclipseSvgCircle | LocalSolarEclipseSvgLine | LocalSolarEclipseSvgPath | LocalSolarEclipseSvgPolygon

// A circle primitive (Sun/Moon disk or limb), in SVG pixel coordinates.
export interface LocalSolarEclipseSvgCircle {
	readonly kind: 'circle'
	// Semantic role of this circle.
	readonly role: 'sunDisk' | 'moonDisk' | 'ghostSunDisk' | 'ghostMoonDisk' | 'solarLimb' | 'lunarLimb'
	// Contact this circle was drawn for, so the UI can label it (e.g. the ghost disks "C1"/"MAX"/"C4"). This
	// is a semantic tag, not rendered text.
	readonly event?: LocalEclipseContactKind
	// Center x in SVG pixels.
	readonly cx: number
	// Center y in SVG pixels.
	readonly cy: number
	// Radius in SVG pixels.
	readonly r: number
}

// A line primitive (horizon or trajectory), in SVG pixel coordinates.
export interface LocalSolarEclipseSvgLine {
	readonly kind: 'line'
	// Semantic role of this line.
	readonly role: 'horizonLine' | 'trajectoryLine'
	readonly x1: number
	readonly y1: number
	readonly x2: number
	readonly y2: number
}

// A path primitive (the curved Sun trajectory), as an SVG path data string.
export interface LocalSolarEclipseSvgPath {
	readonly kind: 'path'
	// Semantic role of this path.
	readonly role: 'trajectoryPath'
	// SVG path data string.
	readonly d: string
}

// A filled polygon primitive (the below-horizon band), in SVG pixel coordinates.
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
	// fallback chosen by the builder, or undefined when no event exists at all.
	readonly selectedEvent?: LocalEclipseContactKind
	// Solar disk radius in SVG pixels.
	readonly solarRadiusPx: number
	// All drawable shapes.
	readonly shapes: readonly LocalSolarEclipseSvgShape[]
}

// Summary circumstances of a globally distinguished central-eclipse point (greatest eclipse or greatest
// duration), matching the NASA/Espenak "Greatest Eclipse and Greatest Duration" table.
export interface SolarEclipseExtremeCircumstances {
	// Geographic longitude, east-positive radians, normalized to [-PI, PI].
	readonly longitude: Angle
	// Geodetic latitude in radians.
	readonly latitude: Angle
	// Terrestrial (Dynamical) Time of the event (TT, i.e. TD).
	readonly time: Time
	// Delta T applied (TT - UT1) in seconds.
	readonly deltaT: number
	// Geometric solar altitude at the event in radians.
	readonly sunAltitude: Angle
	// Solar azimuth at the event in radians, measured from North through East, normalized to [0, TAU).
	readonly sunAzimuth: Angle
	// Width of the central (umbral/antumbral) path on the ground in km; undefined when the point is not central.
	readonly pathWidthKm?: number
	// Duration of the central (total/annular) phase in seconds; undefined when the point is not central.
	readonly centralDuration?: number
	// Local eclipse character at the event; undefined when the point is not central.
	readonly kind?: SolarEclipseGeoPoint['kind']
}

// Default circumstances options (all fields fall back to their per-field defaults).
const DEFAULT_LOCAL_SOLAR_ECLIPSE_CIRCUMSTANCES_OPTIONS: LocalSolarEclipseCircumstancesOptions = {}

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

// Computes the local fundamental-plane geometry for one observer at one instant, following the same
// projection used by the global curve solver in sun.eclipse.ts.
export function computeLocalFundamentalState(pbe: PolynomialBesselianElements, longitude: Angle, latitude: Angle, time: Time, state?: Writable<LocalFundamentalState>): LocalFundamentalState {
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
	// yields a undefined ratio rather than a meaningless or negative one.
	const moonSunDiameterRatio = solarRadius > 0 && lunarRadius > 0 && Number.isFinite(solarRadius) && Number.isFinite(lunarRadius) ? lunarRadius / solarRadius : undefined
	// Central phase = observer strictly inside the umbral/antumbral cone (|L2| - distance > tolerance). This is
	// the robust test for both total and annular: the diameter-ratio magnitude exceeds 1 only for total
	// eclipses (the Moon is larger than the Sun), so a magnitude > 1 test would never flag an annular central
	// phase. The tolerance keeps a point exactly on the central limit (zero central duration) out of it.
	const inCentralCone = Math.abs(L2) - distance > CENTRAL_CONE_TOLERANCE
	const centralPhaseKind: LocalCentralPhaseKind = inCentralCone ? (L2 < 0 ? 'total' : 'annular') : 'none'

	state ??= {} as Writable<LocalFundamentalState>

	state.time = time
	state.jd = toJulianDay(time)
	state.be = be
	state.longitude = longitude
	state.latitude = latitude
	state.hourAngle = normalizeAngle(H)
	state.ksi = ksi
	state.eta = eta
	state.zeta = zeta
	state.u = u
	state.v = v
	state.distance = distance
	state.L1 = L1
	state.L2 = L2
	state.magnitude = magnitude
	state.moonSunDiameterRatio = moonSunDiameterRatio
	state.centralPhaseKind = centralPhaseKind

	return state
}

// Computes the local scalar geometry (distance, L1, L2 in Earth equatorial radii) from an already evaluated
// Besselian sample. The sample depends only on the instant, so callers probing many (longitude, latitude)
// points at one time can evaluate it once and reuse it here instead of re-running the polynomial per probe.
// The returned tuple aliases `o`.
function localFundamentalMetricsFromSample(be: Pick<InstantBesselianElements, 'mu' | 'deltaTLongitudeCorrection' | 'd' | 'x' | 'y' | 'l1' | 'l2' | 'tanF1' | 'tanF2'>, longitude: Angle, latitude: Angle, o: [distance: number, L1: number, L2: number]) {
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

	o[0] = Math.hypot(be.x - ksi, be.y - eta)
	o[1] = be.l1 - zeta * be.tanF1
	o[2] = be.l2 - zeta * be.tanF2
	return o
}

// Computes only the local scalar geometry needed by hot root/minimum searches. The returned tuple aliases
// `o` and contains distance, L1 and L2 in Earth equatorial radii.
function computeLocalFundamentalMetrics(pbe: PolynomialBesselianElements, longitude: Angle, latitude: Angle, time: Time, o: [distance: number, L1: number, L2: number]) {
	return localFundamentalMetricsFromSample(evaluateBesselian(pbe, time), longitude, latitude, o)
}

// Local magnitude at a Julian Day, reusing `metrics` to avoid per-sample LocalFundamentalState allocation.
function localMagnitudeAtJulianDay(pbe: PolynomialBesselianElements, longitude: Angle, latitude: Angle, jd: number, metrics: [distance: number, L1: number, L2: number]) {
	const [distance, L1, L2] = computeLocalFundamentalMetrics(pbe, longitude, latitude, timeAtJulianDay(pbe.maximumTime, jd), metrics)
	return (L1 - distance) / (L1 + L2)
}

// Contact scalar at a Julian Day, reusing `metrics`; partial roots use L1, central roots use |L2|.
function localContactValueAtJulianDay(pbe: PolynomialBesselianElements, longitude: Angle, latitude: Angle, jd: number, central: boolean, metrics: [distance: number, L1: number, L2: number]) {
	const [distance, L1, L2] = computeLocalFundamentalMetrics(pbe, longitude, latitude, timeAtJulianDay(pbe.maximumTime, jd), metrics)
	return central ? distance - Math.abs(L2) : distance - L1
}

// Builds the local fundamental state at a Julian Day, reusing maximumTime as the time-scale reference.
function localStateAtJulianDay(pbe: PolynomialBesselianElements, longitude: Angle, latitude: Angle, jd: number, state?: LocalFundamentalState) {
	return computeLocalFundamentalState(pbe, longitude, latitude, timeAtJulianDay(pbe.maximumTime, jd), state)
}

// Solar altitude (radians) at one instant. With a SunMoonPosition sample it uses the apparent Sun
// right ascension/declination and Greenwich apparent sidereal time; without it, it falls back to the
// Besselian shadow-axis altitude (an approximation: the axis is treated as the Sun direction and the
// geodetic latitude is used directly, matching solarAltitudeAtPoint in sun.eclipse.ts).
function computeSolarAltitude(time: Time, longitude: Angle, latitude: Angle, position?: SunMoonPosition, fallbackBesselian?: InstantBesselianElements) {
	if (position) {
		const deltaT = position.deltaT ?? 0
		const ttTime = tt(time)
		const ut1Fraction = ttTime.fraction - deltaT / DAYSEC
		const gast = eraGst06a(ttTime.day, ut1Fraction, ttTime.day, ttTime.fraction)
		const H = normalizePI(gast + longitude - position.sun.rightAscension)
		const sinAltitude = Math.sin(latitude) * Math.sin(position.sun.declination) + Math.cos(latitude) * Math.cos(position.sun.declination) * Math.cos(H)
		return Math.asin(clamp(sinAltitude, -1, 1))
	}

	if (!fallbackBesselian) throw new Error('computeSolarAltitude requires fallback Besselian elements when no Sun/Moon sample is supplied')

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
	// Position angle of the lunar center, from celestial north toward east, in [0, TAU), or undefined when the
	// Sun-Moon separation is too small for the direction to be defined.
	readonly centerPositionAngle?: Angle
	// Position angle of the lunar center in the zenith frame, in [0, TAU), or undefined.
	readonly centerZenithAngle?: Angle
	// Position angle of the limb-contact point, from celestial north toward east, in [0, TAU), or undefined.
	readonly contactPositionAngle?: Angle
	// Position angle of the limb-contact point in the zenith frame, in [0, TAU), or undefined.
	readonly contactZenithAngle?: Angle
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
function computeSolarParallacticAngle(time: Time, longitude: Angle, latitude: Angle, state: LocalFundamentalState, position: SunMoonPosition | undefined) {
	if (position) {
		const deltaT = position.deltaT ?? 0
		const ttTime = tt(time)
		const ut1Fraction = ttTime.fraction - deltaT / DAYSEC
		const gast = eraGst06a(ttTime.day, ut1Fraction, ttTime.day, ttTime.fraction)
		const H = normalizePI(gast + longitude - position.sun.rightAscension)
		return normalizePI(Math.atan2(Math.sin(H), Math.tan(latitude) * Math.cos(position.sun.declination) - Math.sin(position.sun.declination) * Math.cos(H)))
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

// Computes the topocentric aspect (position and zenith angles of the contact point on the solar disk,
// plus the parallactic angle) for one local contact `kind` at the given time and observer location.
function computeLocalTopocentricAspect(kind: LocalEclipseContactKind, state: LocalFundamentalState, time: Time, longitude: Angle, latitude: Angle, position: SunMoonPosition | undefined): LocalTopocentricAspect {
	const q = computeSolarParallacticAngle(time, longitude, latitude, state, position)

	// At a near-exact central alignment the lunar-center direction is undefined (atan2(0, 0)); report undefined
	// rather than a spurious 0. The Local View is unaffected because the separation is ~0 there anyway.
	if (isLocalViewAngleUndefined(state)) {
		return { parallacticAngle: q }
	}

	const centerP = normalizeAngle(Math.atan2(state.u, state.v))
	const centerZ = normalizeAngle(centerP - q)
	const centralKind = eventCentralKind(kind, state)

	return {
		centerPositionAngle: centerP,
		centerZenithAngle: centerZ,
		contactPositionAngle: contactAngleFromCenter(kind, centralKind, centerP),
		contactZenithAngle: contactAngleFromCenter(kind, centralKind, centerZ),
		parallacticAngle: q,
	}
}

// Apparent solar angular radius (radians) from the Sun distance, falling back to the mean value. The distance
// must be finite and positive: an infinite distance would yield 0 instead of the mean fallback.
export function computeSolarAngularRadius(distance?: number) {
	if (distance !== undefined && Number.isFinite(distance) && distance > 0) return Math.asin(clamp(SUN_RADIUS_EARTH_RADII / distance, -1, 1))
	return SUN_MEAN_ANGULAR_RADIUS
}

// Sun-Moon center separation in local solar radii, guarded so degraded Besselian values never leak a
// non-finite or negative separation into the Local View geometry (cx/cy). Returns 0 when undefined.
export function computeSeparationSolarRadii(state: LocalFundamentalState) {
	const solarRadius = (state.L1 + state.L2) * 0.5
	if (!(solarRadius > 0) || !Number.isFinite(solarRadius)) return 0
	if (!(state.distance >= 0) || !Number.isFinite(state.distance)) return 0
	return state.distance / solarRadius
}

// Central-phase character implied by a contact, used for descriptions. For C2/C3 the umbral radius sign
// decides total vs annular; other contacts carry the state's own classification.
function eventCentralKind(kind: LocalEclipseContactKind, state: LocalFundamentalState) {
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
function buildLocalEvent(kind: LocalEclipseContactKind, jd: number, pbe: PolynomialBesselianElements, longitude: Angle, latitude: Angle, options: LocalSolarEclipseCircumstancesOptions, state?: LocalFundamentalState): LocalSolarEclipseEvent {
	const time = timeAtJulianDay(pbe.maximumTime, jd)
	state = computeLocalFundamentalState(pbe, longitude, latitude, time, state)
	// One ephemeris sample per event, shared by altitude and angular-radius (was up to three calls).
	const position = options.sunMoonPosition?.(time)

	const sunAltitude = computeSolarAltitude(time, longitude, latitude, position, state.be)
	const solarAngularRadius = computeSolarAngularRadius(position?.sun.distance)
	const aspect = computeLocalTopocentricAspect(kind, state, time, longitude, latitude, position)

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
		positionAngle: aspect.contactPositionAngle,
		zenithAngle: aspect.contactZenithAngle,
		visibility: observable ? 'aboveHorizon' : 'belowHorizon',
		observable,
		magnitude: state.magnitude,
		moonSunDiameterRatio: state.moonSunDiameterRatio,
		centralPhaseKind: kind === 'C2' || kind === 'C3' ? centralKind : state.centralPhaseKind,
		localViewState: { separationSolarRadii, centerPositionAngle: aspect.centerPositionAngle, centerZenithAngle: aspect.centerZenithAngle, parallacticAngle: aspect.parallacticAngle, sunAltitude, solarAngularRadius },
	}
}

// Root-finding tolerance (days) for refining contact instants.
const CONTACT_TOLERANCE_ROOT_FIND_OPTIONS: RootFindingOptions = { tolerance: CONTACT_TOLERANCE_DAYS }

// Refines a bracketed contact root, returning undefined when the bracket is rejected.
function bisectRoot(f: (jd: number) => number, lo: number, hi: number) {
	try {
		return bisection(f, lo, hi, CONTACT_TOLERANCE_ROOT_FIND_OPTIONS).root
	} catch {
		return undefined
	}
}

// Finds the Julian Day of the local magnitude maximum within [fromJd, toJd]. A uniform coarse scan brackets
// the best sample, then the one-step bracket around it is densified at a bounded absolute resolution before
export function findLocalMaximumTime(pbe: PolynomialBesselianElements, longitude: Angle, latitude: Angle, fromJd: number, toJd: number, stepDays: number) {
	if (!Number.isFinite(fromJd) || !Number.isFinite(toJd) || toJd < fromJd) {
		return undefined
	}

	const effectiveStepDays = stepDays > 0 && Number.isFinite(stepDays) ? stepDays : Math.max((toJd - fromJd) * 0.5, CONTACT_REFINE_SUBSTEP_DAYS)
	const metrics: [distance: number, L1: number, L2: number] = [0, 0, 0]
	const magnitudeAt = (jd: number) => localMagnitudeAtJulianDay(pbe, longitude, latitude, jd, metrics)

	let bestJd: number | undefined
	let bestMagnitude = -Infinity

	for (let jd = fromJd; ;) {
		const magnitude = magnitudeAt(jd)
		if (Number.isFinite(magnitude) && magnitude > bestMagnitude) {
			bestMagnitude = magnitude
			bestJd = jd
		}
		if (jd === toJd) break
		const nextJd = jd + effectiveStepDays
		jd = nextJd > jd && nextJd < toJd ? nextJd : toJd
	}

	if (bestJd === undefined) return undefined

	// Densify the one-step bracket around the coarse best to relocate a peak narrower than the step.
	const lo = Math.max(fromJd, bestJd - effectiveStepDays)
	const hi = Math.min(toJd, bestJd + effectiveStepDays)
	const subSteps = Math.max(2, Math.ceil((hi - lo) / CONTACT_REFINE_SUBSTEP_DAYS))
	const subStep = (hi - lo) / subSteps

	for (let i = 0; i <= subSteps; i++) {
		const jd = i === subSteps ? hi : lo + i * subStep
		const magnitude = magnitudeAt(jd)
		if (Number.isFinite(magnitude) && magnitude > bestMagnitude) {
			bestMagnitude = magnitude
			bestJd = jd
		}
	}

	// Final Brent refinement within the tight sub-bracket around the densified best.
	const refineLo = Math.max(fromJd, bestJd - subStep)
	const refineHi = Math.min(toJd, bestJd + subStep)

	try {
		const result = brentMinimize((jd) => -magnitudeAt(jd), refineLo, refineHi, CONTACT_TOLERANCE_ROOT_FIND_OPTIONS)
		if (Number.isFinite(result.minimum) && magnitudeAt(result.minimum) >= bestMagnitude) return result.minimum
	} catch {
		// Fall back to the densified best.
	}

	return bestJd
}

// Inserts a root unless an equal one (within ~10x the time tolerance) is already present.
function pushUniqueRoot(roots: number[], root: number) {
	if (!Number.isFinite(root)) return

	for (let i = 0; i < roots.length; i++) {
		if (Math.abs(roots[i] - root) < CONTACT_TOLERANCE_DAYS * 10) return
	}

	roots.push(root)
}

// Ascending numeric sort comparator.
function NumberComparator(a: number, b: number) {
	return a - b
}

// Refines a candidate contact bracket [lo, hi] around a sampled local minimum of a contact function
// (fn <= 0 inside the phase). The bracket is first densified at a bounded absolute resolution
// (CONTACT_REFINE_SUBSTEP_DAYS): a single minimization over the whole bracket can step over a dip much
// narrower than the bracket, so the fine sub-scan both catches transversal crossings of a short finite phase
// directly and locates a tight sub-bracket for the minimum. The refined minimum then yields either a grazing
// double root (it just touches zero) or, for a sub-resolution finite dip, two roots straddling a negative
// minimum (a single |fn| minimization would return only one of them).
function refineMissedContactInterval(evaluate: (jd: number) => number, lo: number, hi: number, roots: number[]) {
	const subSteps = Math.max(2, Math.ceil((hi - lo) / CONTACT_REFINE_SUBSTEP_DAYS))
	const subStep = (hi - lo) / subSteps

	let previousJd = lo
	let previousValue = evaluate(lo)
	let minJd = lo
	let minValue = previousValue

	for (let i = 1; i <= subSteps; i++) {
		const jd = i === subSteps ? hi : lo + i * subStep
		const value = evaluate(jd)
		// A finite phase wider than the sub-step shows up as transversal crossings here. Exact zeros landing on
		// a sub-sample are captured directly (a sign-change test would miss them).
		if (value === 0) {
			pushUniqueRoot(roots, jd)
		} else if (previousValue === 0) {
			pushUniqueRoot(roots, previousJd)
		} else if (previousValue * value < 0) {
			const root = bisectRoot(evaluate, previousJd, jd)
			if (root !== undefined) pushUniqueRoot(roots, root)
		}
		if (value < minValue) {
			minValue = value
			minJd = jd
		}
		previousJd = jd
		previousValue = value
	}

	// Refine the densified minimum within its own sub-bracket.
	const refineLo = Math.max(lo, minJd - subStep)
	const refineHi = Math.min(hi, minJd + subStep)
	let mid: number
	try {
		mid = brentMinimize(evaluate, refineLo, refineHi, CONTACT_TOLERANCE_ROOT_FIND_OPTIONS).minimum
	} catch {
		return
	}

	const midValue = evaluate(mid)
	if (!Number.isFinite(mid) || !Number.isFinite(midValue)) return

	// Grazing contact: the minimum touches zero, a single double root. Only accept it strictly inside the
	// bracket: a "minimum" pinned to lo or hi is the monotone case where the real contact lies just outside
	// the window (common on the boundary intervals), and a small positive endpoint value within tolerance
	// would otherwise plant a phantom root on the window edge. Exact endpoint zeros are still caught by the
	// sub-scan above (value === 0).
	if (Math.abs(midValue) <= CONTACT_FUNCTION_TOLERANCE) {
		if (mid > lo + CONTACT_TOLERANCE_DAYS && mid < hi - CONTACT_TOLERANCE_DAYS) pushUniqueRoot(roots, mid)
		return
	}

	// Sub-resolution finite dip: a negative minimum with a contact on each side still outside the phase.
	if (midValue < -CONTACT_FUNCTION_TOLERANCE) {
		if (evaluate(refineLo) > 0) {
			const left = bisectRoot(evaluate, refineLo, mid)
			if (left !== undefined) pushUniqueRoot(roots, left)
		}
		if (evaluate(refineHi) > 0) {
			const right = bisectRoot(evaluate, mid, refineHi)
			if (right !== undefined) pushUniqueRoot(roots, right)
		}
	}
}

// Finds every Julian Day in [fromJd, toJd] where an already scalar contact function reaches zero, by uniform
// scan plus refinement. The `evaluate` callback returns Earth-equatorial-radii residuals, negative inside
// the phase. Roots are deduplicated and returned sorted ascending.
function findLocalContactValueRoots(fromJd: number, toJd: number, stepDays: number, evaluate: (jd: number) => number) {
	const roots: number[] = []

	if (!Number.isFinite(fromJd) || !Number.isFinite(toJd) || toJd < fromJd) return roots

	let previousJd = fromJd
	let previousValue = evaluate(previousJd)
	if (previousValue === 0) pushUniqueRoot(roots, previousJd)
	if (fromJd === toJd) return roots

	const effectiveStepDays = stepDays > 0 && Number.isFinite(stepDays) ? stepDays : toJd - fromJd
	let beforePreviousJd: number | undefined
	let beforePreviousValue: number | undefined
	let firstIntervalEnd: number | undefined
	let lastIntervalStart = fromJd

	// Transversal roots are caught between adjacent samples. Grazing/sub-sample roots are recovered by
	// refining each interior local minimum as soon as the triplet is available, without storing the whole
	// sampled window.
	for (let jd = Math.min(fromJd + effectiveStepDays, toJd); ;) {
		if (jd <= previousJd) jd = toJd
		const value = evaluate(jd)

		// Transversal roots: exact zeros on a sample and sign changes between neighbors.
		if (value === 0) {
			pushUniqueRoot(roots, jd)
		} else if (previousValue === 0) {
			pushUniqueRoot(roots, previousJd)
		} else if (previousValue * value < 0) {
			const root = bisectRoot(evaluate, previousJd, jd)
			if (root !== undefined) pushUniqueRoot(roots, root)
		}

		// Grazing/sub-sample roots: refine every interior local minimum as soon as its right neighbor exists.
		if (beforePreviousJd !== undefined && beforePreviousValue !== undefined) {
			const nearMinimum = previousValue <= beforePreviousValue + CONTACT_SAMPLE_EXTREMUM_EPS && previousValue <= value + CONTACT_SAMPLE_EXTREMUM_EPS
			if (nearMinimum) refineMissedContactInterval(evaluate, beforePreviousJd, jd, roots)
		}

		firstIntervalEnd ??= jd
		lastIntervalStart = previousJd
		beforePreviousJd = previousJd
		beforePreviousValue = previousValue
		previousJd = jd
		previousValue = value

		if (jd === toJd) break
		const nextJd = jd + effectiveStepDays
		jd = nextJd > jd && nextJd < toJd ? nextJd : toJd
	}

	// The interior-minimum pass needs a triple, so a very short dip wholly inside the first or last interval
	// (both endpoints positive, no interior sample) would be missed. Refine those two boundary intervals
	// explicitly so the detector is symmetric at the window edges (e.g. a contact right at fromJd/toJd at the
	// adaptive expansion limit). Overlaps with the interior pass dedup away.
	if (firstIntervalEnd !== undefined) {
		refineMissedContactInterval(evaluate, fromJd, firstIntervalEnd, roots)
		if (lastIntervalStart !== fromJd || firstIntervalEnd !== toJd) refineMissedContactInterval(evaluate, lastIntervalStart, toJd, roots)
	}

	return roots.sort(NumberComparator)
}

// Finds every Julian Day in [fromJd, toJd] where the scalar contact function fn reaches zero, by uniform
// scan plus refinement. Transversal roots (sign changes) are bracketed directly; grazing roots and short
// phases whose two contacts fall entirely between two samples (no sign change, a sub-sample negative dip)
// are recovered from interior local minima. Roots are deduplicated and returned sorted ascending.
export function findLocalContactRoots(pbe: PolynomialBesselianElements, longitude: Angle, latitude: Angle, fromJd: number, toJd: number, stepDays: number, fn: (state: LocalFundamentalState) => number, state?: Writable<LocalFundamentalState>) {
	state ??= {} as Writable<LocalFundamentalState>
	const evaluate = (jd: number) => fn(localStateAtJulianDay(pbe, longitude, latitude, jd, state))
	return findLocalContactValueRoots(fromJd, toJd, stepDays, evaluate)
}

// Closest root strictly before a reference Julian Day, or undefined.
function rootBefore(roots: readonly number[], reference: number) {
	let best: number | undefined
	for (const root of roots) {
		if (root >= reference) break
		best = root
	}
	return best
}

// Closest root strictly after a reference Julian Day, or undefined.
function rootAfter(roots: readonly number[], reference: number) {
	for (const root of roots) if (root > reference) return root
	return undefined
}

// Adaptively locates the Julian Day of the local magnitude maximum around the eclipse maximumTime. If the
// sampled maximum lands on a window edge the true maximum may lie just outside, which would also misplace the
// contacts around it, so the window is widened (bounded by maxSpan) until the maximum sits clear of the
// boundary. Returns undefined when no maximum can be located. Shared by the contact resolver and the
// location-visibility test so both bracket the maximum identically.
function findLocalEclipseMaximumJd(pbe: PolynomialBesselianElements, longitude: Angle, latitude: Angle, centerJd: number, span: number, maxSpan: number, stepDays: number) {
	let maximumSpan = span
	let maximumJd = findLocalMaximumTime(pbe, longitude, latitude, centerJd - maximumSpan, centerJd + maximumSpan, stepDays)
	if (maximumJd === undefined) return undefined

	while (maximumSpan < maxSpan) {
		const margin = stepDays * 2
		const nearBoundary = maximumJd <= centerJd - maximumSpan + margin || maximumJd >= centerJd + maximumSpan - margin
		if (!nearBoundary) break
		maximumSpan = Math.min(maximumSpan * 1.5, maxSpan)
		const widened = findLocalMaximumTime(pbe, longitude, latitude, centerJd - maximumSpan, centerJd + maximumSpan, stepDays)
		if (widened === undefined) break
		maximumJd = widened
	}

	return maximumJd
}

// Shared frozen "no contacts" event set, returned when the eclipse is not visible at the location.
const EMPTY_LOCAL_ECLIPSE_EVENTS: LocalSolarEclipseCircumstances['events'] = Object.freeze({ C1: undefined, C2: undefined, MAX: undefined, C3: undefined, C4: undefined })

// Resolves the local C1/C2/MAX/C3/C4 events. C2/C3 are only sought when the local maximum is central, so
// a partial-only local eclipse never invents central contacts. Every event is computed geometrically even
// when the Sun is below the horizon; only its observability flag reflects the horizon.
export function computeLocalEclipseEvents(pbe: PolynomialBesselianElements, longitude: Angle, latitude: Angle, options: LocalSolarEclipseCircumstancesOptions): LocalSolarEclipseCircumstances['events'] {
	const span = DEFAULT_CONTACT_SEARCH_SPAN_SECONDS / DAYSEC
	const stepDays = DEFAULT_LOCAL_SEARCH_STEP_SECONDS / DAYSEC
	const maxSpan = MAX_CONTACT_SEARCH_SPAN_SECONDS / DAYSEC
	const centerJd = toJulianDay(pbe.maximumTime)

	const maximumJd = findLocalEclipseMaximumJd(pbe, longitude, latitude, centerJd, span, maxSpan, stepDays)
	if (maximumJd === undefined) return EMPTY_LOCAL_ECLIPSE_EVENTS

	const state = {} as Writable<LocalFundamentalState>

	const { L1, distance, centralPhaseKind } = localStateAtJulianDay(pbe, longitude, latitude, maximumJd, state)
	// No resolvable local eclipse unless the partial depth at closest approach (L1 - distance) exceeds the
	// root finder's tolerance. A shallower grazing touch is treated by the contact search as a single
	// tangency rather than two distinct C1/C4, so reporting a MAX without partial contacts would be
	// inconsistent. This mirrors CENTRAL_CONE_TOLERANCE = CONTACT_FUNCTION_TOLERANCE for the central phase.
	if (!(L1 - distance > CONTACT_FUNCTION_TOLERANCE)) return EMPTY_LOCAL_ECLIPSE_EVENTS

	const MAX = buildLocalEvent('MAX', maximumJd, pbe, longitude, latitude, options, state)

	// The contact search must start with a window that already contains the maximum: the adaptive maximum
	// search above can find a maximum beyond `span`, and if the contact search restarted at `span` the whole
	// phase (and both window edges) would lie outside it, so the edge-based expansion would never trigger. The
	// floor is the smallest window enclosing the maximum (plus a step margin), bounded by `maxSpan`.
	const minimumContactSearchSpan = Math.min(maxSpan, Math.max(span, Math.abs(maximumJd - centerJd) + 2 * stepDays))

	// Resolves the two contacts (ingress before / egress after the maximum) bracketing the maximum for a
	// contact function, expanding the search window toward `maxSpan` while either is still missing. Expansion
	// is bounded so the Besselian polynomial is never evaluated far past its +-3 h fit.
	const resolveContacts = (central: boolean) => {
		let currentSpan = minimumContactSearchSpan
		let before: number | undefined
		let after: number | undefined
		const metrics: [distance: number, L1: number, L2: number] = [0, 0, 0]
		const evaluate = (jd: number) => localContactValueAtJulianDay(pbe, longitude, latitude, jd, central, metrics)

		while (true) {
			const fromJd = centerJd - currentSpan
			const toJd = centerJd + currentSpan
			const roots = findLocalContactValueRoots(fromJd, toJd, stepDays, evaluate)
			before = rootBefore(roots, maximumJd)
			after = rootAfter(roots, maximumJd)
			if ((before !== undefined && after !== undefined) || currentSpan >= maxSpan) break

			// A still-missing contact may simply lie outside the current window: that is the case exactly when
			// the corresponding window edge is still inside the phase (fn <= 0), so the contact is beyond it. If
			// neither missing edge is inside the phase, expanding cannot reveal a contact, so stop. This keeps a
			// window lying entirely inside a long phase (no roots, no sign change) from stopping the expansion.
			const expandForBefore = before === undefined && evaluate(fromJd) <= 0
			const expandForAfter = after === undefined && evaluate(toJd) <= 0
			if (!expandForBefore && !expandForAfter) break

			currentSpan = Math.min(currentSpan * 1.5, maxSpan)
		}

		return { before, after }
	}

	const partial = resolveContacts(false)
	const C1 = partial.before !== undefined ? buildLocalEvent('C1', partial.before, pbe, longitude, latitude, options, state) : undefined
	const C4 = partial.after !== undefined ? buildLocalEvent('C4', partial.after, pbe, longitude, latitude, options, state) : undefined

	let C2: LocalSolarEclipseEvent | undefined
	let C3: LocalSolarEclipseEvent | undefined

	if (centralPhaseKind !== 'none') {
		const central = resolveContacts(true)
		C2 = central.before !== undefined ? buildLocalEvent('C2', central.before, pbe, longitude, latitude, options, state) : undefined
		C3 = central.after !== undefined ? buildLocalEvent('C3', central.after, pbe, longitude, latitude, options, state) : undefined
	}

	return { C1, C2, MAX, C3, C4 }
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

// Minimum Sun-altitude change (radians, ~0.06°) across the eclipse to call the Sun rising or setting rather
// than flat (near culmination, where the earliest and latest contacts can sit at nearly the same altitude).
const SUN_MOTION_ALTITUDE_EPSILON = 1e-3

// Vertical trend of the Sun across the present contacts, by comparing the earliest and latest event altitudes
// (the events are already time-ordered). Lets the UI compose an "on sunset"/"on sunrise" qualifier.
function computeSunMotion(events: LocalSolarEclipseCircumstances['events']): LocalSunMotion {
	let first: LocalSolarEclipseEvent | undefined
	let last: LocalSolarEclipseEvent | undefined

	for (const kind of CONTACT_ORDER) {
		const event = events[kind]
		if (!event) continue
		first ??= event
		last = event
	}

	if (!first || !last || first === last) return 'none'
	const delta = last.sunAltitude - first.sunAltitude
	if (delta < -SUN_MOTION_ALTITUDE_EPSILON) return 'setting'
	if (delta > SUN_MOTION_ALTITUDE_EPSILON) return 'rising'
	return 'none'
}

// Maximum Sun altitude (radians) over [fromJd, toJd]. The Sun's altitude is unimodal over a sub-day interval
// (a single peak at culmination), but the peak is broad and can sit near one end, so a uniform scan brackets
// it before a tight Brent refinement (a single Brent pass over the whole, near-flat interval can stop short
// of the true peak). Used to detect an observable instant between contacts even when every contact itself is
// below the horizon.
function extremeSunAltitudeOverInterval(pbe: PolynomialBesselianElements, longitude: Angle, latitude: Angle, fromJd: number, toJd: number, options: LocalSolarEclipseCircumstancesOptions, minimize: boolean) {
	if (!Number.isFinite(fromJd) || !Number.isFinite(toJd) || toJd < fromJd) return minimize ? Infinity : -Infinity

	const altitudeAt = (jd: number) => {
		const time = timeAtJulianDay(pbe.maximumTime, jd)
		const position = options.sunMoonPosition?.(time)
		return computeSolarAltitude(time, longitude, latitude, position, position ? undefined : evaluateBesselian(pbe, time))
	}

	// Orient so the wanted extremum is always a maximum of `oriented`.
	const oriented = (jd: number) => (minimize ? -altitudeAt(jd) : altitudeAt(jd))

	// The extremum is broad, so a coarse scan (>= 5 min) brackets it cheaply; Brent then refines to the exact
	// value. This caps the ephemeris cost of the check.
	const stepDays = Math.max(DEFAULT_LOCAL_SEARCH_STEP_SECONDS, ALTITUDE_SCAN_MIN_STEP_SECONDS) / DAYSEC
	let best = -Infinity
	let bestJd = fromJd

	for (let jd = fromJd; ;) {
		const value = oriented(jd)
		if (value > best) {
			best = value
			bestJd = jd
		}
		if (jd === toJd) break
		const nextJd = jd + stepDays
		jd = nextJd > jd && nextJd < toJd ? nextJd : toJd
	}

	try {
		const result = brentMinimize((jd) => -oriented(jd), Math.max(fromJd, bestJd - stepDays), Math.min(toJd, bestJd + stepDays), CONTACT_TOLERANCE_ROOT_FIND_OPTIONS)
		const refined = oriented(result.minimum)
		if (Number.isFinite(refined) && refined > best) best = refined
	} catch {
		// Keep the sampled extremum.
	}

	return minimize ? -best : best
}

// Maximum Sun altitude (radians) over [fromJd, toJd]. See extremeSunAltitudeOverInterval.
function maxSunAltitudeOverInterval(pbe: PolynomialBesselianElements, longitude: Angle, latitude: Angle, fromJd: number, toJd: number, options: LocalSolarEclipseCircumstancesOptions) {
	return extremeSunAltitudeOverInterval(pbe, longitude, latitude, fromJd, toJd, options, false)
}

// Minimum Sun altitude (radians) over [fromJd, toJd]. Used to confirm a fully-visible eclipse never dips
// below the horizon at an interior altitude valley (the interval straddling lower culmination).
function minSunAltitudeOverInterval(pbe: PolynomialBesselianElements, longitude: Angle, latitude: Angle, fromJd: number, toJd: number, options: LocalSolarEclipseCircumstancesOptions) {
	return extremeSunAltitudeOverInterval(pbe, longitude, latitude, fromJd, toJd, options, true)
}

// Local hour angle of the Sun (radians, [-PI, PI]). Uses the apparent Sun right ascension and Greenwich
// apparent sidereal time when a SunMoonPosition sample is available, matching computeSolarAltitude exactly;
// otherwise falls back to the Besselian shadow-axis hour angle. Keeping the same source as the altitude is
// what makes the valley detector consistent with the continuous altitude it gates.
function solarHourAngleAt(pbe: PolynomialBesselianElements, longitude: Angle, jd: number, options: LocalSolarEclipseCircumstancesOptions) {
	const time = timeAtJulianDay(pbe.maximumTime, jd)
	const position = options.sunMoonPosition?.(time)

	if (position) {
		const deltaT = position.deltaT ?? 0
		const ttTime = tt(time)
		const ut1Fraction = ttTime.fraction - deltaT / DAYSEC
		const gast = eraGst06a(ttTime.day, ut1Fraction, ttTime.day, ttTime.fraction)
		return normalizePI(gast + longitude - position.sun.rightAscension)
	}

	const be = evaluateBesselian(pbe, time)
	return normalizePI(hourAngleFromLongitude(longitude, be.mu, be.deltaTLongitudeCorrection))
}

// Whether the Sun altitude has an interior minimum (a valley at lower culmination) somewhere in [fromJd, toJd]
// rather than its minimum at an endpoint. d(altitude)/dt has the sign of -sin(H), so a valley exists only when
// the Sun is setting at the start (sin H > 0) and rising at the end (sin H < 0): the interval crosses local
// midnight. Cheap (two hour-angle evaluations from the same source the altitude uses), so the continuous
// minimum is only computed in that rare case; otherwise the interval minimum is at a contact and the event
// check already covers it.
function intervalHasAltitudeValley(pbe: PolynomialBesselianElements, longitude: Angle, fromJd: number, toJd: number, options: LocalSolarEclipseCircumstancesOptions) {
	return Math.sin(solarHourAngleAt(pbe, longitude, fromJd, options)) > 0 && Math.sin(solarHourAngleAt(pbe, longitude, toJd, options)) < 0
}

// Classifies local visibility from the resolved events, refined with continuous Sun-altitude analysis at the
// horizon edges. Observability is event-based in the common case, but uses the altitude maximum over the
// interval when every contact is below the horizon (an eclipse can poke above the horizon at culmination
// between two below-horizon contacts). Symmetrically, `completelyVisible` is downgraded if the altitude dips
// below the horizon at an interior valley (the interval straddling lower culmination), and `centralPhaseVisible`
// is granted if the central interval pokes above the horizon between below-horizon central events. The
// continuous checks are guarded so the common case (a daytime eclipse with all contacts on one horizon side)
// pays nothing.
function computeLocalVisibility(events: LocalSolarEclipseCircumstances['events'], pbe: PolynomialBesselianElements, longitude: Angle, latitude: Angle, options: LocalSolarEclipseCircumstancesOptions): LocalSolarEclipseCircumstances['visibility'] {
	const { C1, C2, MAX, C3, C4 } = events

	if (!MAX) {
		return { kind: 'notVisible', text: localVisibilityText('notVisible'), hasGeometricEclipse: false, hasObservableEclipse: false, hasCentralPhase: false, centralPhaseKind: 'none', sunMotion: 'none', completeness: { partialContactsComplete: false, centralContactsComplete: false } }
	}

	// Central phase is decided by the local maximum, not by C2/C3 existing: a narrow window or a grazing
	// (tangential) central contact may fail to yield both endpoints even though the maximum is central.
	const hasCentralPhase = MAX.centralPhaseKind !== 'none'
	const centralPhaseKind: LocalCentralPhaseKind = MAX.centralPhaseKind

	// The events expected for this eclipse character. `completelyVisible` requires this full set to exist and
	// be above the horizon, so a missing contact never masquerades as a fully visible eclipse.
	const completeEventSet = hasCentralPhase ? C1 !== undefined && C2 !== undefined && C3 !== undefined && C4 !== undefined : C1 !== undefined && C4 !== undefined
	const allExpectedAbove = hasCentralPhase ? C1?.observable === true && C2?.observable === true && MAX.observable && C3?.observable === true && C4?.observable === true : C1?.observable === true && MAX.observable && C4?.observable === true

	// Common case: any contact above the horizon means the eclipse is observable. Only when every contact is
	// below the horizon, and the partial interval is known, do we pay for a continuous check of the altitude
	// maximum between contacts (a culmination sliver above the horizon). The interval [C1, C4] contains every
	// contact, so this never lowers observability below the event-based answer.
	const horizonAltitude = options.horizonAltitude ?? 0
	const eventAnyAbove = C1?.observable === true || C2?.observable === true || MAX.observable || C3?.observable === true || C4?.observable === true
	const anyAbove = eventAnyAbove || (C1 !== undefined && C4 !== undefined && maxSunAltitudeOverInterval(pbe, longitude, latitude, C1.jd, C4.jd, options) >= horizonAltitude)

	// `completelyVisible` requires the full expected event set above the horizon AND no interior dip below it.
	// The dip is only possible when the interval straddles lower culmination (a valley), detected cheaply, so
	// the continuous minimum is computed only in that rare case.
	let completelyVisible = completeEventSet && allExpectedAbove
	if (completelyVisible && C1 !== undefined && C4 !== undefined && intervalHasAltitudeValley(pbe, longitude, C1.jd, C4.jd, options)) {
		completelyVisible = minSunAltitudeOverInterval(pbe, longitude, latitude, C1.jd, C4.jd, options) >= horizonAltitude
	}

	// The central phase is visible if any central event is above the horizon, or (rare) the central interval
	// pokes above between below-horizon central events. The interval scan short-circuits after the event checks.
	const centralPhaseVisible = hasCentralPhase && ((C2?.observable ?? false) || (C3?.observable ?? false) || MAX.observable || (C2 !== undefined && C3 !== undefined && maxSunAltitudeOverInterval(pbe, longitude, latitude, C2.jd, C3.jd, options) >= horizonAltitude))

	let kind: LocalVisibilityKind
	if (!anyAbove) {
		kind = 'geometricOnlyBelowHorizon'
	} else if (completelyVisible) {
		kind = 'completelyVisible'
	} else if (centralPhaseVisible) {
		kind = 'centralPhaseVisible'
	} else if (!hasCentralPhase) {
		kind = 'partialOnlyVisible'
	} else {
		kind = 'partiallyVisible'
	}

	const completeness = { partialContactsComplete: C1 !== undefined && C4 !== undefined, centralContactsComplete: !hasCentralPhase || (C2 !== undefined && C3 !== undefined) }
	return { kind, text: localVisibilityText(kind), hasGeometricEclipse: true, hasObservableEclipse: anyAbove, hasCentralPhase, centralPhaseKind, sunMotion: computeSunMotion(events), completeness }
}

// Maximum geodesic half-width (km) probed when measuring the central shadow path on the ground. A genuine
// local path width stays well under this; a probe that runs past it (e.g. a grazing umbra near the
// terminator, whose ground footprint stretches enormously) is reported as undefined instead of an absurd value.
const MAX_SHADOW_HALF_WIDTH_KM = 600
// March step (km) for the central-edge search across the path.
const SHADOW_EDGE_STEP_KM = 5

// Destination geographic point reached from (lon, lat) along a great-circle bearing (from north toward
// east) after a surface distance, on a sphere of radius EARTH_RADIUS_KM. Writes [longitude, latitude] into
// `o` and returns the same tuple to avoid allocations during shadow-edge marches.
function destinationPoint(longitude: Angle, latitude: Angle, bearing: Angle, distanceKm: number, o: [longitude: Angle, latitude: Angle]) {
	const angular = distanceKm / EARTH_RADIUS_KM
	const sinLat = Math.sin(latitude)
	const cosLat = Math.cos(latitude)
	const sinAng = Math.sin(angular)
	const cosAng = Math.cos(angular)
	const lat2 = Math.asin(clamp(sinLat * cosAng + cosLat * sinAng * Math.cos(bearing), -1, 1))
	const lon2 = longitude + Math.atan2(Math.sin(bearing) * sinAng * cosLat, cosAng - sinLat * Math.sin(lat2))
	o[0] = lon2
	o[1] = lat2
	return o
}

// Distance (km) from the observer to the central-shadow edge along a bearing at a fixed instant: marches
// outward until the central-contact function turns non-negative (leaves the umbra/antumbra), then bisects.
// Returns undefined when no edge is found within MAX_SHADOW_HALF_WIDTH_KM.
function findCentralShadowEdgeKm(centralValueAt: (longitude: Angle, latitude: Angle) => number, longitude: Angle, latitude: Angle, bearing: Angle) {
	let previousKm = 0
	let previousValue = centralValueAt(longitude, latitude)
	const point: [longitude: Angle, latitude: Angle] = [longitude, latitude]

	for (let distanceKm = SHADOW_EDGE_STEP_KM; distanceKm <= MAX_SHADOW_HALF_WIDTH_KM; distanceKm += SHADOW_EDGE_STEP_KM) {
		destinationPoint(longitude, latitude, bearing, distanceKm, point)
		const value = centralValueAt(point[0], point[1])

		if (previousValue < 0 && value >= 0) {
			let lo = previousKm
			let hi = distanceKm
			for (let i = 0; i < 40 && hi - lo > 1e-3; i++) {
				const mid = (lo + hi) * 0.5
				destinationPoint(longitude, latitude, bearing, mid, point)
				if (centralValueAt(point[0], point[1]) < 0) lo = mid
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
// Finite penalty (km) returned to the bearing minimizer for a bearing with no opposite edge pair. It exceeds
// any valid chord (at most 2 * MAX_SHADOW_HALF_WIDTH_KM), so the minimizer steers away from it without the
// NaN/parabola degradation a non-finite penalty could cause inside brentMinimize.
const INVALID_CHORD_WIDTH_PENALTY_KM = MAX_SHADOW_HALF_WIDTH_KM * 4

// Narrowest bidirectional central-shadow chord (km) through the observer, scanned over several bearings and
// then refined around the best one. Unlike a single gradient direction this is well defined even at the exact
// center of the shadow, where the central-contact function distance - |L2| has a non-differentiable cone
// point and the gradient vanishes by symmetry. For each bearing the two opposite edges are summed; the
// discrete minimum over all bearings is refined by a 1-D minimization within one angular step, so the result
// is not capped at the PI / count grid resolution. Returns undefined when no opposite pair of edges is found.
function computeCentralShadowChordWidthByBearingsKm(centralValueAt: (longitude: Angle, latitude: Angle) => number, longitude: Angle, latitude: Angle) {
	const chordWidthAtBearing = (bearing: Angle) => {
		const forward = findCentralShadowEdgeKm(centralValueAt, longitude, latitude, bearing)
		const backward = findCentralShadowEdgeKm(centralValueAt, longitude, latitude, bearing + PI)
		return forward === undefined || backward === undefined ? undefined : forward + backward
	}

	const step = PI / SHADOW_CHORD_BEARING_COUNT
	let best: number | undefined
	let bestBearing = 0

	for (let i = 0; i < SHADOW_CHORD_BEARING_COUNT; i++) {
		const bearing = i * step
		const width = chordWidthAtBearing(bearing)
		if (width === undefined) continue
		if (best === undefined || width < best) {
			best = width
			bestBearing = bearing
		}
	}

	if (best === undefined) return undefined

	// Refine the bearing within one grid step; the true minimum chord usually lies between two samples.
	try {
		const refined = brentMinimize((bearing) => chordWidthAtBearing(normalizeAngle(bearing)) ?? INVALID_CHORD_WIDTH_PENALTY_KM, bestBearing - step, bestBearing + step, { tolerance: 1e-4 })
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
// undefined when the maximum is not central, the observer is not inside the central shadow, or no edge is found
// within MAX_SHADOW_HALF_WIDTH_KM.
export function computeLocalShadowPathWidthKm(pbe: PolynomialBesselianElements, longitude: Angle, latitude: Angle, jd: number) {
	// The Besselian sample depends only on the instant; evaluate it once and reuse it across every
	// (longitude, latitude) chord probe instead of re-running the polynomial (and its derivatives) per probe.
	const sample = besselianSampleAtJulianDay(pbe, jd)
	const metrics: [distance: number, L1: number, L2: number] = [0, 0, 0]
	const centralValueAt = (lon: Angle, lat: Angle) => {
		const [distance, , L2] = localFundamentalMetricsFromSample(sample, lon, lat, metrics)
		return distance - Math.abs(L2)
	}

	// The observer must be strictly inside the central shadow, using the same margin as the central-phase
	// classification so a tangential (zero-duration) edge is treated consistently as not central.
	if (!(centralValueAt(longitude, latitude) < -CENTRAL_CONE_TOLERANCE)) return undefined

	return computeCentralShadowChordWidthByBearingsKm(centralValueAt, longitude, latitude)
}

// Computes the local detail summary (magnitude, ratios and durations) from the resolved events.
function computeLocalDetails(events: LocalSolarEclipseCircumstances['events'], shadowPathWidthKm: number | undefined): LocalSolarEclipseCircumstances['details'] {
	const { C1, C2, MAX, C3, C4 } = events

	return {
		maximalMagnitude: MAX?.magnitude,
		moonSunDiameterRatio: MAX?.moonSunDiameterRatio,
		partialPhaseDuration: C1 !== undefined && C4 !== undefined ? (C4.jd - C1.jd) * DAYSEC : undefined,
		centralPhaseDuration: C2 !== undefined && C3 !== undefined ? (C3.jd - C2.jd) * DAYSEC : undefined,
		shadowPathWidthKm,
	}
}

// Returns the event's Local View state or throws: drawing without it would silently place the Moon
// concentric with the Sun, which looks valid but is physically wrong. Events from buildLocalEvent always
// carry it; this guards against externally constructed events.
function requireLocalViewState(event: LocalSolarEclipseEvent) {
	if (!event.localViewState) throw new Error(`Local View requires localViewState for ${event.kind}`)
	return event.localViewState
}

// Position angle (from the top of the diagram, clockwise) at which an event's lunar center is drawn, in the
// frame of `frameState`. In the north frame the angle is the celestial-north position angle, which is
// frame-independent. In the zenith frame the lunar center must be expressed in the SAME zenith as the rest of
// the diagram, so the frame event's parallactic angle q is subtracted (not the event's own q): otherwise each
// ghost would sit in its own instantaneous vertical, inconsistent with the single horizon drawn for the
// primary event.
function localViewAngleForEvent(eventState: LocalViewEventState, options: LocalSolarEclipseViewOptions, frameState: LocalViewEventState) {
	if (options.orientationMode === 'north') return eventState.centerPositionAngle
	const centerP = eventState.centerPositionAngle
	return centerP && normalizeAngle(centerP - (frameState.parallacticAngle ?? 0))
}

// Computes the solar and lunar disk circles for one event in the Local View frame. The Sun is centered in
// the diagram; the Moon is offset by the local separation along the lunar-CENTER position angle (never the
// limb-contact angle), measured from the top of the diagram clockwise. All disks of one diagram share the
// frame of `frameEvent` (the primary event), so ghost disks and the primary disk use a single zenith.
export function computeLocalViewDiskPair(event: LocalSolarEclipseEvent, options: LocalSolarEclipseViewOptions, frameEvent: LocalSolarEclipseEvent = event) {
	const viewState = requireLocalViewState(event)
	const frameState = requireLocalViewState(frameEvent)
	const sunCx = options.width * 0.5
	const sunCy = options.height * 0.5
	const sunR = options.solarRadiusPx
	// Fall back to a unit ratio for a missing or degraded value, so the Moon disk is never zero/negative.
	const ratio = event.moonSunDiameterRatio !== undefined && event.moonSunDiameterRatio > 0 && Number.isFinite(event.moonSunDiameterRatio) ? event.moonSunDiameterRatio : 1
	const moonR = sunR * ratio

	const separationPx = viewState.separationSolarRadii * sunR
	const angle = localViewAngleForEvent(viewState, options, frameState) ?? 0

	// Position angle grows from up (north/zenith) clockwise toward east. `eastRight` (default) keeps east on
	// the right; `eastLeft` mirrors the horizontal axis for the sky-chart convention.
	const eastSign = options.handedness === 'eastLeft' ? -1 : 1
	const dx = eastSign * separationPx * Math.sin(angle)
	const dy = -separationPx * Math.cos(angle)

	return {
		sun: { kind: 'circle', role: 'sunDisk', event: event.kind, cx: sunCx, cy: sunCy, r: sunR },
		moon: { kind: 'circle', role: 'moonDisk', event: event.kind, cx: sunCx + dx, cy: sunCy + dy, r: moonR },
	} as const
}

// Converts a solar altitude to its signed Local View offset (px) from the Sun center along the zenith
// direction. Guarded against non-finite inputs and clamped only for numerical stability (not physics).
function altitudeToLocalViewOffsetPx(sunAltitude: Angle, solarAngularRadius: Angle | undefined, solarRadiusPx: number, width: number, height: number) {
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
export function buildLocalViewHorizonGeometry(event: LocalSolarEclipseEvent, options: LocalSolarEclipseViewOptions) {
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
	return [band, line] as const
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
	return undefined
}

// Builds the serializable Local View geometry from the resolved events. Emits only geometric shapes: no
// labels, no text primitives and no UI controls.
export function computeLocalSolarEclipseViewGeometry(circumstances: Pick<LocalSolarEclipseCircumstances, 'events'>, options: Partial<LocalSolarEclipseViewOptions> = DEFAULT_LOCAL_VIEW_OPTIONS): LocalSolarEclipseViewGeometry {
	const events = circumstances.events
	const resolvedOptions = Object.assign({}, DEFAULT_LOCAL_VIEW_OPTIONS, options)
	const shapes: LocalSolarEclipseSvgShape[] = []
	const primary = selectPrimaryEvent(events, resolvedOptions.selectedEvent)

	// Ghost MOON disks for every other available contact, drawn behind the primary state. The Sun is fixed
	// at the diagram center, so a per-contact ghost Sun would only stack redundant circles; what differs
	// between contacts is the lunar position, so only the Moon is ghosted.
	// Ghost disks are projected into the PRIMARY event's frame, so the whole diagram shares one zenith.
	if (resolvedOptions.includeGhostDisks && primary) {
		for (const kind of CONTACT_ORDER) {
			const event = events[kind]
			if (!event || event === primary) continue
			const { moon } = computeLocalViewDiskPair(event, resolvedOptions, primary)
			shapes.push({ kind: 'circle', role: 'ghostMoonDisk', event: moon.event, cx: moon.cx, cy: moon.cy, r: moon.r })
		}
	}

	// Primary Sun and Moon disks first, then the horizon on top, so the ground band occludes the part of the
	// disks below the horizon (e.g. a sunrise/sunset eclipse), matching the Astrarium foreground convention.
	if (primary) {
		const pair = computeLocalViewDiskPair(primary, resolvedOptions, primary)
		shapes.push(pair.sun, pair.moon)
	}

	if (primary && resolvedOptions.includeHorizon) {
		for (const shape of buildLocalViewHorizonGeometry(primary, resolvedOptions)) shapes.push(shape)
	}

	return { width: resolvedOptions.width, height: resolvedOptions.height, orientationMode: resolvedOptions.orientationMode, requestedEvent: resolvedOptions.selectedEvent, selectedEvent: primary?.kind, solarRadiusPx: resolvedOptions.solarRadiusPx, shapes }
}

// Computes the full local circumstances for a geographic point: resolves contacts, summarizes details,
// classifies visibility, and optionally builds the Local View. The result is immutable and serializable;
// times are returned as Time/Julian Day and durations in seconds (the UI formats them).
export function computeLocalSolarEclipseCircumstances(pbe: PolynomialBesselianElements, longitude: Angle, latitude: Angle, options: LocalSolarEclipseCircumstancesOptions = DEFAULT_LOCAL_SOLAR_ECLIPSE_CIRCUMSTANCES_OPTIONS) {
	const events = computeLocalEclipseEvents(pbe, longitude, latitude, options)
	const visibility = computeLocalVisibility(events, pbe, longitude, latitude, options)
	const shadowPathWidthKm = events.MAX !== undefined && events.MAX.centralPhaseKind !== 'none' ? computeLocalShadowPathWidthKm(pbe, longitude, latitude, events.MAX.jd) : undefined
	const details = computeLocalDetails(events, shadowPathWidthKm)
	const result: LocalSolarEclipseCircumstances = { location: { longitude, latitude }, visibility, details, events }
	return result
}

// Maximum half-window (days) searched on either side of the central instant for a cone crossing; longer
// than any real central phase so the entry/exit are always bracketed.
const MAX_CENTRAL_HALF_DURATION_DAYS = (20 * 60) / DAYSEC
// Coarse step (days) for bracketing the cone crossings before bisection.
const CENTRAL_DURATION_STEP_DAYS = 4 / DAYSEC

// Bisects the cone crossing (where the central gap changes sign) between the central instant and the first
// stepped sample that lies outside the cone, marching with the given signed step. Returns the crossing
// Julian Day, or undefined when no crossing is found within the search half-window.
function findConeCrossingJd(gapAtJd: (jd: number) => number, jdCenter: number, stepDays: number) {
	let previousJd = jdCenter

	for (let jd = jdCenter + stepDays; Math.abs(jd - jdCenter) <= MAX_CENTRAL_HALF_DURATION_DAYS; jd += stepDays) {
		if (gapAtJd(jd) <= 0) {
			let inside = previousJd
			let outside = jd

			for (let i = 0; i < 50 && Math.abs(outside - inside) > 1e-9; i++) {
				const mid = (inside + outside) * 0.5
				if (gapAtJd(mid) > 0) inside = mid
				else outside = mid
			}

			return (inside + outside) * 0.5
		}

		previousJd = jd
	}

	return undefined
}

// Local fundamental-plane "central gap" |L2| - distance (Earth equatorial radii) of a ground observer at
// one instant: positive inside the umbral/antumbral cone, zero on the path edge, negative outside. Mirrors
// the observer projection in sun.eclipse.local.ts; kept here so the core summary computations stay
// self-contained (core never imports the local layer).
// longitude: east-positive radians; latitude: geodetic radians.
function centralConeGap(be: Pick<InstantBesselianElements, 'mu' | 'deltaT' | 'deltaTLongitudeCorrection' | 'd' | 'x' | 'y' | 'l2' | 'tanF2'>, longitude: Angle, latitude: Angle) {
	const H = hourAngleFromLongitude(longitude, be.mu, be.deltaTLongitudeCorrection)
	const sinD = Math.sin(be.d)
	const cosD = Math.cos(be.d)
	const cosH = Math.cos(H)
	const U = Math.atan(F * Math.tan(latitude))
	const rhoSinPhi = F * Math.sin(U)
	const rhoCosPhi = Math.cos(U)
	const ksi = rhoCosPhi * Math.sin(H)
	const eta = rhoSinPhi * cosD - rhoCosPhi * cosH * sinD
	const zeta = rhoSinPhi * sinD + rhoCosPhi * cosH * cosD
	const distance = Math.hypot(be.x - ksi, be.y - eta)
	return Math.abs(be.l2 - zeta * be.tanF2) - distance
}

// Solar azimuth (radians, from North through East, [0, TAU)) at a point and its instant, using the
// shadow-axis declination as the Sun direction (exact on the central line). The standard horizontal
// transform gives azimuth from the South through West; adding PI rotates it to the North-through-East
// convention used by the NASA tables.
function solarAzimuthAtPoint(pbe: PolynomialBesselianElements, point: SolarEclipseGeoPoint) {
	const be = besselianSampleAtJulianDay(pbe, point.jd!)
	const H = hourAngleFromLongitude(point.x, be.mu, be.deltaTLongitudeCorrection)
	const sinPhi = Math.sin(point.y)
	const cosPhi = Math.cos(point.y)
	return normalizeAngle(Math.atan2(Math.sin(H), Math.cos(H) * sinPhi - Math.tan(be.d) * cosPhi) + PI)
}

// Duration (seconds) of the central (total/annular) phase for a ground point under the shadow axis at
// jdCenter: the span the point stays inside the umbral/antumbral cone. Returns undefined when the point is not
// inside the cone at jdCenter (no central phase there).
function centralPhaseDurationSeconds(pbe: PolynomialBesselianElements, longitude: Angle, latitude: Angle, jdCenter: number) {
	const gapAtJd = (jd: number) => centralConeGap(besselianSampleAtJulianDay(pbe, jd), longitude, latitude)
	if (!(gapAtJd(jdCenter) > CENTRAL_CONE_TOLERANCE)) return undefined

	const enter = findConeCrossingJd(gapAtJd, jdCenter, -CENTRAL_DURATION_STEP_DAYS)
	const exit = findConeCrossingJd(gapAtJd, jdCenter, CENTRAL_DURATION_STEP_DAYS)
	return enter === undefined || exit === undefined ? undefined : (exit - enter) * DAYSEC
}

// Assembles the full summary circumstances at one central-eclipse point: geographic location, TD/UT1 times,
// solar altitude and azimuth, and (when the point is central) the path width, central duration and character.
function extremeCircumstancesAt(pbe: PolynomialBesselianElements, point: SolarEclipseGeoPoint): SolarEclipseExtremeCircumstances {
	const jd = point.jd!
	const time = timeAtJulianDay(pbe.time0, jd)
	const centralDuration = centralPhaseDurationSeconds(pbe, point.x, point.y, jd)

	return {
		longitude: point.x,
		latitude: point.y,
		time,
		deltaT: pbe.deltaT,
		sunAltitude: solarAltitudeAtPoint(pbe, point),
		sunAzimuth: solarAzimuthAtPoint(pbe, point),
		pathWidthKm: centralDuration && computeLocalShadowPathWidthKm(pbe, point.x, point.y, jd),
		centralDuration,
		kind: centralDuration === undefined ? undefined : centralLineKind(pbe, jd),
	}
}

// Circumstances at the greatest eclipse: the instant the shadow axis passes closest to the Earth's center
// (maximum magnitude). For a central eclipse this is the central point at that instant; for a partial or
// non-central eclipse it is the limb point nearest the axis, and the path width / central duration are undefined.
// Returns undefined only when no greatest-eclipse point can be projected.
export function computeGreatestEclipseCircumstances(pbe: PolynomialBesselianElements) {
	const point = findMaximumPoint(pbe)
	return point ? extremeCircumstancesAt(pbe, point) : undefined
}

// Circumstances at the greatest duration: the point on the central line where the central (total/annular)
// phase lasts longest, which is generally not the greatest-eclipse point. Searches the central line over the
// contact window, evaluating the local central duration at each sampled central point and refining the
// maximum. Returns undefined for an eclipse with no central line (partial or non-central).
export function computeGreatestDurationCircumstances(pbe: PolynomialBesselianElements) {
	if (!centralAxisIntersectsEarth(pbe)) return undefined

	const julianDay0 = toJulianDay(pbe.time0)
	const tMaximum = (toJulianDay(pbe.maximumTime) - julianDay0) / pbe.step
	const span = DEFAULT_CONTACT_SEARCH_SPAN_SECONDS / DAYSEC / pbe.step

	// Central-phase duration (seconds) at the central-line point reached at normalized time t, or 0 when the
	// axis misses the Earth or the point is not central there (so the maximizer steers away from those t).
	function durationAtT(t: number) {
		const be = besselianSampleAtJulianDay(pbe, julianDay0 + t * pbe.step)
		const point = projectFundamentalPoint(be, be.x, be.y)
		if (!point) return 0
		return centralPhaseDurationSeconds(pbe, point.x, point.y, point.jd!) ?? 0
	}

	const steps = 128
	let bestT = tMaximum
	let bestDuration = -Infinity

	for (let k = 0; k <= steps; k++) {
		const t = tMaximum - span + (2 * span * k) / steps
		const duration = durationAtT(t)
		if (duration > bestDuration) {
			bestDuration = duration
			bestT = t
		}
	}

	const half = (2 * span) / steps

	try {
		const minimum = brentMinimize((t) => -durationAtT(t), Math.max(tMaximum - span, bestT - half), Math.min(tMaximum + span, bestT + half))
		if (-minimum.value > bestDuration) {
			bestT = minimum.minimum
			bestDuration = -minimum.value
		}
	} catch {
		// Keep the coarse-scan argmax when the refinement bracket is rejected.
	}

	if (!(bestDuration > 0)) return undefined

	const be = besselianSampleAtJulianDay(pbe, julianDay0 + bestT * pbe.step)
	const point = projectFundamentalPoint(be, be.x, be.y)
	return point ? extremeCircumstancesAt(pbe, point) : undefined
}

// Whether a geometric solar eclipse reaches the given location for these Besselian elements, regardless of the
// horizon: true when the local magnitude maximum has a partial depth (L1 - distance) above the contact
// tolerance. Reuses the same adaptive maximum search and gate as computeLocalEclipseEvents, so any location
// this returns true for resolves at least the C1/C4 partial contacts there. Cheap: one polynomial-based
// maximum search over the contact window, no ephemeris sampling and no full event/aspect build.
// longitude: east-positive radians; latitude: geodetic radians.
function hasLocalGeometricEclipse(pbe: PolynomialBesselianElements, longitude: Angle, latitude: Angle, state?: LocalFundamentalState) {
	const span = DEFAULT_CONTACT_SEARCH_SPAN_SECONDS / DAYSEC
	const stepDays = DEFAULT_LOCAL_SEARCH_STEP_SECONDS / DAYSEC
	const maxSpan = Math.max(span, MAX_CONTACT_SEARCH_SPAN_SECONDS / DAYSEC)

	const maximumJd = findLocalEclipseMaximumJd(pbe, longitude, latitude, toJulianDay(pbe.maximumTime), span, maxSpan, stepDays)
	if (maximumJd === undefined) return false

	state = localStateAtJulianDay(pbe, longitude, latitude, maximumJd, state)
	return state.L1 - state.distance > CONTACT_FUNCTION_TOLERANCE
}

// One eclipse in a listLocalSolarEclipses result.
export interface LocalSolarEclipseListEntry {
	// The eclipse as returned by nearestSolarEclipse (global circumstances: maximalTime, gamma, type, magnitude).
	readonly eclipse: SolarEclipse
	// Polynomial Besselian elements for this eclipse.
	readonly elements: PolynomialBesselianElements
	// Local geometry on the fundamental plane at one instant for one observer.
	readonly state: LocalFundamentalState
}

// Lists the solar eclipses whose maximal time falls in (startTime, endTime] that reach the given location.
//
// Eclipses are enumerated with nearestSolarEclipse, walking forward one eclipse per step (the Meeus series is
// cheap, ~2-3 eclipses per scanned year, and only the eclipses that touch the Earth's surface are emitted).
// Each candidate is filtered by a geometric local-visibility test using the required sunMoonPosition provider:
// the Besselian elements are built once and returned as `elements`, so a caller computing full local
// circumstances afterwards never rebuilds them. The costly ephemeris work (the Besselian fit) happens exactly
// once per eclipse and is handed back.
//
// The test is purely geometric: an eclipse is included when its shadow reaches the location even if the Sun is
// below the local horizon there. Pass the returned `elements` to computeLocalSolarEclipseCircumstances to
// refine observability, magnitude, contacts and the Local View. longitude is east-positive radians, latitude
// geodetic radians; the results are ordered earliest-first.
export function listLocalSolarEclipses(longitude: Angle, latitude: Angle, startTime: Time, endTime: Time, sunMoonPosition: (time: Time) => SunMoonPosition) {
	const result: LocalSolarEclipseListEntry[] = []

	const startJd = toJulianDay(startTime)
	const endJd = toJulianDay(endTime)
	if (!Number.isFinite(startJd) || !Number.isFinite(endJd) || endJd < startJd) return result

	// nearestSolarEclipse(t, true) returns the first eclipse strictly after t, so seeding the cursor with the
	// previous maximalTime advances exactly one eclipse per step. previousMaxJd guards against a non-advancing
	// series (which should never happen) so the loop can never spin.
	let cursor = startTime
	let previousMaxJd = -Infinity

	while (true) {
		const eclipse = nearestSolarEclipse(cursor, true)
		const maxJd = toJulianDay(eclipse.maximalTime)
		if (!Number.isFinite(maxJd) || maxJd <= previousMaxJd || maxJd > endJd) break

		// Build the Besselian elements once; reuse them for both the location test and the returned entry.
		const elements = computePolynomialBesselianElements(eclipse.maximalTime, sunMoonPosition)
		const state = {} as Writable<LocalFundamentalState>
		if (hasLocalGeometricEclipse(elements, longitude, latitude, state)) result.push({ eclipse, elements, state })

		previousMaxJd = maxJd
		cursor = eclipse.maximalTime
	}

	return result
}
