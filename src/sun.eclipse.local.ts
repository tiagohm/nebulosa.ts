import { type Angle, normalizeAngle, normalizePI } from './angle'
import { ASEC2RAD, DAYSEC, EARTH_RADIUS_KM } from './constants'
import { eraGst06a } from './erfa'
import type { Point } from './geometry'
import { clamp } from './math'
import { bisection, brentMinimize } from './optimization'
import type { SolarEclipse } from './sun'
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
// Default half-width of the local contact search window, in seconds. Mirrors the global engine's default so
// the local contacts are searched over the same span around maximumTime.
const DEFAULT_CONTACT_SEARCH_SPAN_SECONDS = 3.5 * 3600
// Default sampling step for the local contact/maximum search, in seconds.
const DEFAULT_LOCAL_SEARCH_STEP_SECONDS = 60
// Root tolerance for local contact instants, in days (~1 ms).
const CONTACT_TOLERANCE_DAYS = 1e-8
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
		// First-order local shadow-path width in km, or null when not central or not estimable.
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

// Internal per-event state needed to draw the Local View without recomputing the fundamental geometry.
export interface LocalViewEventState {
	// Sun-Moon center separation in solar radii at the event.
	readonly separationSolarRadii: number
	// Position angle P (from celestial north toward east), or null.
	readonly P: Angle | null
	// Zenith-oriented position angle Z, or null.
	readonly Z: Angle | null
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

	// Position angle measured from celestial north toward east, normalized to [0, TAU).
	readonly positionAngleP: Angle | null

	// Position angle in the local zenith-oriented frame, normalized to [0, TAU).
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
	// Which contact was drawn as the primary state.
	readonly selectedEvent: LocalEclipseContactKind
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
	const solarRadius = (L1 + L2) * 0.5
	const lunarRadius = (L1 - L2) * 0.5
	const moonSunDiameterRatio = solarRadius > 0 ? lunarRadius / solarRadius : null
	// Central phase = observer inside the umbral/antumbral cone (distance <= |L2|). This is the robust test
	// for both total and annular: the diameter-ratio magnitude exceeds 1 only for total eclipses (the Moon
	// is larger than the Sun), so a magnitude > 1 test would never flag an annular central phase.
	const inCentralCone = distance <= Math.abs(L2)
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

// Solar altitude (radians) at one instant. With a SunMoonPosition source it uses the apparent Sun
// right ascension/declination and Greenwich apparent sidereal time; without it, it falls back to the
// Besselian shadow-axis altitude (an approximation: the axis is treated as the Sun direction and the
// geodetic latitude is used directly, matching solarAltitudeAtPoint in sun.eclipse.ts).
function computeSolarAltitude(time: Time, longitude: Angle, latitude: Angle, sunMoonPosition: ((time: Time) => SunMoonPosition) | undefined, fallbackBesselian: InstantBesselianElements): Angle {
	if (sunMoonPosition) {
		const sample = sunMoonPosition(time)
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

// Position angles of the lunar center relative to the solar center.
//
// With a SunMoonPosition source, P is the tangent-plane bearing of the Moon from the Sun measured from
// celestial north toward east, q is the solar parallactic angle, and Z = P - q is the zenith-oriented
// angle. Without the source, both are approximated from the fundamental-plane offset (u, v); the single
// helper keeps the sign in one place so it can be validated/flipped if the Local View appears mirrored.
function computePositionAngles(time: Time, longitude: Angle, latitude: Angle, state: LocalFundamentalState, sunMoonPosition?: (time: Time) => SunMoonPosition): { P: Angle | null; Z: Angle | null; parallacticAngle: Angle | null } {
	if (sunMoonPosition) {
		const position = sunMoonPosition(time)
		const dRA = normalizePI(position.moonRightAscension - position.sunRightAscension)
		const cosMoonDec = Math.cos(position.moonDeclination)
		const sinMoonDec = Math.sin(position.moonDeclination)
		const cosSunDec = Math.cos(position.sunDeclination)
		const sinSunDec = Math.sin(position.sunDeclination)
		const cosDRA = Math.cos(dRA)
		const east = cosMoonDec * Math.sin(dRA)
		const north = sinMoonDec * cosSunDec - cosMoonDec * sinSunDec * cosDRA
		const P = normalizeAngle(Math.atan2(east, north))

		const deltaT = position.deltaT ?? 0
		const ttTime = tt(time)
		const ut1Fraction = ttTime.fraction - deltaT / DAYSEC
		const gast = eraGst06a(ttTime.day, ut1Fraction, ttTime.day, ttTime.fraction)
		const H = gast + longitude - position.sunRightAscension
		const q = Math.atan2(Math.sin(H), Math.tan(latitude) * cosSunDec - sinSunDec * Math.cos(H))
		const Z = normalizeAngle(P - q)
		return { P, Z, parallacticAngle: normalizePI(q) }
	}

	// Fallback approximation: the Moon-relative-to-Sun direction is opposite the observer-to-axis offset
	// (u, v) in the fundamental plane, whose x/y axes are celestial east/north.
	const P = normalizeAngle(Math.atan2(-state.u, -state.v))
	const be = state.be
	const H = state.hourAngle
	const q = Math.atan2(Math.sin(H), Math.tan(latitude) * Math.cos(be.d) - Math.sin(be.d) * Math.cos(H))
	const Z = normalizeAngle(P - q)
	return { P, Z, parallacticAngle: normalizePI(q) }
}

// Apparent solar angular radius (radians) from the Sun distance, falling back to the mean value.
function computeSolarAngularRadius(time: Time, sunMoonPosition?: (time: Time) => SunMoonPosition): Angle {
	if (sunMoonPosition) {
		const sample = sunMoonPosition(time)
		if (sample.sunDistance > 0) return Math.asin(clamp(SUN_RADIUS_EARTH_RADII / sample.sunDistance, -1, 1))
	}

	return SUN_MEAN_ANGULAR_RADIUS
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
	const sunMoonPosition = options.sunMoonPosition

	const sunAltitude = computeSolarAltitude(time, longitude, latitude, sunMoonPosition, state.be)
	const { P, Z } = computePositionAngles(time, longitude, latitude, state, sunMoonPosition)
	const solarAngularRadius = computeSolarAngularRadius(time, sunMoonPosition)

	const horizonAltitude = options.horizonAltitude ?? 0
	const observable = sunAltitude >= horizonAltitude

	const solarRadiusFundamental = (state.L1 + state.L2) * 0.5
	const separationSolarRadii = solarRadiusFundamental > 0 ? state.distance / solarRadiusFundamental : 0
	const centralKind = eventCentralKind(kind, state)

	return {
		kind,
		description: describeEvent(kind, centralKind),
		time,
		jd,
		sunAltitude,
		positionAngleP: P,
		zenithAngleZ: Z,
		visibility: observable ? 'aboveHorizon' : 'belowHorizon',
		observable,
		magnitude: state.magnitude,
		moonSunDiameterRatio: state.moonSunDiameterRatio,
		centralPhaseKind: kind === 'C2' || kind === 'C3' ? centralKind : state.centralPhaseKind,
		localViewState: { separationSolarRadii, P, Z, sunAltitude, solarAngularRadius },
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

// Finds every Julian Day in [fromJd, toJd] where the scalar contact function fn changes sign, by uniform
// scan plus bisection refinement. Roots are returned sorted ascending.
export function findLocalContactRoots(pbe: PolynomialBesselianElements, longitude: Angle, latitude: Angle, fromJd: number, toJd: number, stepDays: number, fn: (state: LocalFundamentalState) => number): readonly number[] {
	const evaluate = (jd: number) => fn(localStateAtJulianDay(pbe, longitude, latitude, jd))
	const roots: number[] = []

	let previousJd = fromJd
	let previousValue = evaluate(fromJd)
	if (previousValue === 0) roots.push(fromJd)

	for (let jd = fromJd + stepDays; jd <= toJd + 1e-12; jd += stepDays) {
		const value = evaluate(jd)

		if (value === 0) {
			roots.push(jd)
		} else if (previousValue * value < 0) {
			const root = bisectRoot(evaluate, previousJd, jd)
			if (root !== undefined) roots.push(root)
		}

		previousJd = jd
		previousValue = value
	}

	roots.sort((a, b) => a - b)
	return roots
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
	const centerJd = toJulianDay(pbe.maximumTime)
	const fromJd = centerJd - span
	const toJd = centerJd + span

	const maximumJd = findLocalMaximumTime(pbe, longitude, latitude, fromJd, toJd, stepDays)
	if (maximumJd === undefined) return empty

	const maximumState = localStateAtJulianDay(pbe, longitude, latitude, maximumJd)
	// No local eclipse: even at closest approach the disks do not touch (magnitude <= 0).
	if (!(maximumState.magnitude > 0)) return empty

	const MAX = buildLocalEvent('MAX', maximumJd, pbe, longitude, latitude, options)

	const partialRoots = findLocalContactRoots(pbe, longitude, latitude, fromJd, toJd, stepDays, partialContactFunction)
	const c1Jd = rootBefore(partialRoots, maximumJd)
	const c4Jd = rootAfter(partialRoots, maximumJd)
	const C1 = c1Jd !== undefined ? buildLocalEvent('C1', c1Jd, pbe, longitude, latitude, options) : null
	const C4 = c4Jd !== undefined ? buildLocalEvent('C4', c4Jd, pbe, longitude, latitude, options) : null

	let C2: LocalSolarEclipseEvent | null = null
	let C3: LocalSolarEclipseEvent | null = null

	if (maximumState.centralPhaseKind !== 'none') {
		const centralRoots = findLocalContactRoots(pbe, longitude, latitude, fromJd, toJd, stepDays, centralContactFunction)
		const c2Jd = rootBefore(centralRoots, maximumJd)
		const c3Jd = rootAfter(centralRoots, maximumJd)
		C2 = c2Jd !== undefined ? buildLocalEvent('C2', c2Jd, pbe, longitude, latitude, options) : null
		C3 = c3Jd !== undefined ? buildLocalEvent('C3', c3Jd, pbe, longitude, latitude, options) : null
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
		return { kind: 'notVisible', text: localVisibilityText('notVisible'), hasGeometricEclipse: false, hasObservableEclipse: false, hasCentralPhase: false, centralPhaseKind: 'none' }
	}

	const present = [C1, C2, MAX, C3, C4].filter((event): event is LocalSolarEclipseEvent => event !== null)
	const anyAbove = present.some((event) => event.observable)
	const allAbove = present.every((event) => event.observable)
	const hasCentral = C2 !== null && C3 !== null
	const centralPhaseKind: LocalCentralPhaseKind = MAX.centralPhaseKind

	let kind: LocalVisibilityKind
	if (!anyAbove) {
		kind = 'geometricOnlyBelowHorizon'
	} else if (hasCentral) {
		if (allAbove) kind = 'completelyVisible'
		else if (C2.observable || C3.observable || MAX.observable) kind = 'centralPhaseVisible'
		else kind = 'partiallyVisible'
	} else if (allAbove && C1 !== null && C4 !== null) {
		kind = 'completelyVisible'
	} else {
		kind = 'partialOnlyVisible'
	}

	return { kind, text: localVisibilityText(kind), hasGeometricEclipse: true, hasObservableEclipse: anyAbove, hasCentralPhase: hasCentral, centralPhaseKind }
}

// First-order local shadow-path width in km, computed only for a central local maximum with the Sun above
// the horizon: the umbral cone radius |L2| (Earth equatorial radii) is scaled to km and foreshortened by
// the solar altitude. This is an explicit approximation, not the global path width; null otherwise.
export function computeLocalShadowPathWidthKm(eclipse: SolarEclipse, pbe: PolynomialBesselianElements, longitude: Angle, latitude: Angle, maxEvent: LocalSolarEclipseEvent): number | null {
	if (maxEvent.centralPhaseKind === 'none') return null

	const sinAltitude = Math.sin(maxEvent.sunAltitude)
	if (!(sinAltitude > 0)) return null

	const state = localStateAtJulianDay(pbe, longitude, latitude, maxEvent.jd)
	const width = (2 * Math.abs(state.L2) * EARTH_RADIUS_KM) / sinAltitude
	return Number.isFinite(width) ? width : null
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

// Computes the solar and lunar disk circles for one event in the Local View frame. The Sun is centered in
// the diagram; the Moon is offset by the local separation along the orientation-selected position angle,
// measured from the top of the diagram clockwise.
export function computeLocalViewDiskPair(event: LocalSolarEclipseEvent, options: LocalSolarEclipseViewOptions): { sun: LocalSolarEclipseSvgCircle; moon: LocalSolarEclipseSvgCircle } {
	const sunCx = options.width * 0.5
	const sunCy = options.height * 0.5
	const sunR = options.solarRadiusPx
	const moonR = sunR * (event.moonSunDiameterRatio ?? 1)

	const separationSolarRadii = event.localViewState?.separationSolarRadii ?? 0
	const separationPx = separationSolarRadii * sunR
	const angle = (options.orientationMode === 'zenith' ? event.zenithAngleZ : event.positionAngleP) ?? 0

	const dx = separationPx * Math.sin(angle)
	const dy = -separationPx * Math.cos(angle)

	return {
		sun: { kind: 'circle', role: 'sunDisk', cx: sunCx, cy: sunCy, r: sunR },
		moon: { kind: 'circle', role: 'moonDisk', cx: sunCx + dx, cy: sunCy + dy, r: moonR },
	}
}

// Builds the apparent-horizon geometry for one event: a horizontal line whose vertical offset reflects the
// solar altitude (zenith up), plus a band polygon below it. The north orientation keeps the horizon
// horizontal as well: the parallactic rotation is intentionally not applied until validated visually.
export function buildLocalViewHorizonGeometry(event: LocalSolarEclipseEvent, options: LocalSolarEclipseViewOptions): readonly LocalSolarEclipseSvgShape[] {
	const sunCy = options.height * 0.5
	const solarAngularRadius = event.localViewState?.solarAngularRadius ?? null

	let horizonY = sunCy
	if (solarAngularRadius && solarAngularRadius > 0) {
		const altitudeInSolarRadii = event.sunAltitude / solarAngularRadius
		horizonY = sunCy + altitudeInSolarRadii * options.solarRadiusPx
	}

	const line: LocalSolarEclipseSvgLine = { kind: 'line', role: 'horizonLine', x1: 0, y1: horizonY, x2: options.width, y2: horizonY }
	const padding = options.horizonBandPaddingPx ?? 0
	const bandTop = horizonY + padding
	const band: LocalSolarEclipseSvgPolygon = {
		kind: 'polygon',
		role: 'horizonBand',
		points: [
			{ x: 0, y: bandTop },
			{ x: options.width, y: bandTop },
			{ x: options.width, y: options.height },
			{ x: 0, y: options.height },
		],
	}

	return [line, band]
}

// Picks the event to draw as primary: the requested one, else MAX, else the first available contact.
function selectPrimaryEvent(events: LocalSolarEclipseCircumstances['events'], selectedEvent: LocalEclipseContactKind) {
	const requested = events[selectedEvent]
	if (requested) return requested
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

	// Ghost disks for every other available contact, drawn behind the primary state.
	if (options.includeGhostDisks) {
		for (const kind of CONTACT_ORDER) {
			const event = events[kind]
			if (!event || event === primary) continue
			const pair = computeLocalViewDiskPair(event, options)
			shapes.push({ ...pair.sun, role: 'ghostSunDisk' }, { ...pair.moon, role: 'ghostMoonDisk' })
		}
	}

	if (primary && options.includeHorizon) shapes.push(...buildLocalViewHorizonGeometry(primary, options))

	if (primary) {
		const pair = computeLocalViewDiskPair(primary, options)
		shapes.push(pair.sun, pair.moon)
	}

	return { width: options.width, height: options.height, orientationMode: options.orientationMode, selectedEvent: options.selectedEvent, solarRadiusPx: options.solarRadiusPx, shapes }
}

// Computes the full local circumstances for a geographic point: resolves contacts, summarizes details,
// classifies visibility, and optionally builds the Local View. The result is immutable and serializable;
// times are returned as Time/Julian Day and durations in seconds (the UI formats them).
export function computeLocalSolarEclipseCircumstances(eclipse: SolarEclipse, pbe: PolynomialBesselianElements, longitude: Angle, latitude: Angle, options: LocalSolarEclipseCircumstancesOptions = {}): LocalSolarEclipseCircumstances {
	const events = computeLocalEclipseEvents(pbe, longitude, latitude, options)
	const visibility = computeLocalVisibility(events)
	const shadowPathWidthKm = events.MAX ? computeLocalShadowPathWidthKm(eclipse, pbe, longitude, latitude, events.MAX) : null
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
