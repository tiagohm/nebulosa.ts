import { type Angle, normalizeAngle, normalizePI } from './angle'
import { parallacticAngle } from './astrometry'
import { DAYSEC, PI, TAU, WGS84_FLATTENING } from './constants'
import { equatorialToHorizontal } from './coordinate'
import { eraGst06a } from './erfa'
import type { Point } from './geometry'
import { clamp } from './math'
import type { LunarEclipse } from './moon'
import { lunarEclipseEvents, type LunarEclipseContact, type LunarEclipseContactKind, MOON_RADIUS_EARTH_RADII } from './moon.eclipse.map'
import type { SunMoonPosition } from './sun.eclipse.map'
import { timeShift, tt, type Time } from './time'
import type { Writable } from './types'

// Local lunar eclipse circumstances and Local View geometry.
//
// A lunar eclipse happens on the Moon, so its contact instants (P1..P4) are GLOBAL: every observer shares the
// same times. Only two things vary with the observer's location: whether the Moon is above the horizon at each
// contact (and across the phases), and the topocentric Alt/Az and the P/Z orientation angles. This module
// therefore consumes the already-computed LunarEclipse contact times plus an apparent Sun/Moon position
// provider, and does not rebuild any global eclipse geometry.
//
// Unit conventions: angles in radians; longitude east-positive; latitude geodetic; durations in seconds;
// times are Time (contact times are TT) or Julian Day.

// Shadow model constants (mirrored from moon.ts so the per-contact magnitudes stay consistent with the
// contact times computed there). All radii are in equatorial Earth radii projected on the eclipse plane.

// Enlarged umbra contact limit: |shadow-axis distance| at the umbral external contacts U1/U4.
const LUNAR_ECLIPSE_UMBRA_LIMIT = 1.0128
// Totality limit: |shadow-axis distance| at the total internal contacts U2/U3.
const LUNAR_ECLIPSE_TOTAL_LIMIT = 0.4678
// Enlarged penumbra contact limit: |shadow-axis distance| at the penumbral external contacts P1/P4.
const LUNAR_ECLIPSE_PENUMBRA_LIMIT = 1.5573
// Magnitude denominator: twice the lunar plane radius (the Moon spans 0..1 magnitude over 2 * 0.2725).
const LUNAR_ECLIPSE_MAGNITUDE_DENOMINATOR = 0.545
// Mean angular size (radians) of one Earth equatorial radius seen from the Moon (mean distance ~60.27 Earth
// radii). Used only to scale the schematic Local View horizon offset; not a precise per-event value.
const MEAN_EARTH_RADIUS_ANGULAR_AT_MOON: Angle = 0.01659276403036854845767088434102 // Math.asin(1 / 60.27)
// Earth polar/equatorial radius ratio (1 - flattening).
const F = 1 - WGS84_FLATTENING

// Coarse local visibility classification of a lunar eclipse for one observer.
export type LocalLunarEclipseVisibilityKind = 'notVisible' | 'penumbralOnlyVisible' | 'partialVisible' | 'totalVisible' | 'completelyVisible' | 'geometricOnlyBelowHorizon'

// Apparent Sun/Moon position provider at a dynamical time (TT/TDB), as produced by computeSunMoonPositionAt.
export type LunarEclipsePositionProvider = (time: Time) => SunMoonPosition

// Options controlling the local circumstances computation.
export interface LocalLunarEclipseCircumstancesOptions {
	// Altitude (radians) of the apparent horizon; the Moon is observable when at or above it. Default 0.
	readonly horizonAltitude?: Angle
	// Number of altitude samples across the penumbral interval for the continuous visibility check. The check
	// detects observable stretches even when every contact is below the horizon (e.g. moonrise mid-eclipse).
	// Default 48 (~7 min spacing for a 6 h eclipse), which resolves any lunar phase comfortably.
	readonly altitudeSamples?: number
}

// One resolved local contact event.
export interface LocalLunarEclipseEvent {
	// Which contact this is.
	readonly kind: LunarEclipseContactKind
	// Instant of the contact (TT).
	readonly time: Time
	// Julian Day of the contact.
	readonly jd: number
	// Whether the Moon is at or above the configured horizon at the contact (topocentric center altitude).
	readonly observable: boolean
	// Topocentric apparent Moon altitude (radians) at the contact for this observer (diurnal parallax applied).
	readonly altitude: Angle
	// Topocentric apparent Moon azimuth (radians) at the contact, measured from North through East, in [0, TAU).
	readonly azimuth: Angle
	// Position angle of the limb CONTACT point on the lunar disk, from celestial north toward east, in
	// [0, TAU). This is the P angle of the contact tables: the Earth-shadow-center direction at the external
	// contacts (P1/U1/U4/P4), and its opposite (shadow center + PI) at the U2/U3 internal tangency of a total
	// eclipse, where the limb touches the umbra on the far side of the disk.
	readonly positionAngle: Angle
	// Same CONTACT-point direction in the local zenith-oriented frame (Z = P - parallacticAngle), in [0, TAU).
	readonly zenithAngle: Angle
	// Umbral magnitude at the contact. 0 at U1/U4, 1 at U2/U3, the eclipse magnitude at MAX; negative when the
	// Moon is wholly outside the umbra (e.g. at the penumbral contacts P1/P4).
	readonly umbralMagnitude: number
	// Penumbral magnitude at the contact. 0 at P1/P4.
	readonly penumbralMagnitude: number
}

// Coarse local visibility summary.
export interface LocalLunarEclipseVisibility {
	// Classification kind.
	readonly kind: LocalLunarEclipseVisibilityKind
	// Human-readable description of the classification.
	readonly text: string
	// Whether the eclipse touches the Moon geometrically (always true for a real eclipse, regardless of horizon).
	readonly hasGeometricEclipse: boolean
	// Whether any part of the eclipse is observable with the Moon at or above the configured horizon (true even
	// when every contact is below the horizon but the Moon rises above it between contacts).
	readonly hasObservableEclipse: boolean
}

// Maximal magnitudes and phase durations for the local circumstances panel.
export interface LocalLunarEclipseDetails {
	// Maximal umbral magnitude (eclipse magnitude for total/partial), or null for a penumbral eclipse.
	readonly maximalUmbralMagnitude: number | null
	// Maximal penumbral magnitude at greatest eclipse.
	readonly maximalPenumbralMagnitude: number
	// Penumbral-phase duration P4 - P1 in seconds.
	readonly penumbralPhaseDuration: number
	// Partial (umbral) phase duration U4 - U1 in seconds, or null when there is no umbral phase.
	readonly partialPhaseDuration: number | null
	// Total phase duration U3 - U2 in seconds, or null when there is no total phase.
	readonly totalPhaseDuration: number | null
	// Total time (seconds) the Moon is at or above the horizon within the penumbral interval, integrated from the
	// continuous visibility samples (refining any interval that may hide a sub-sample horizon crossing, so it
	// stays consistent with hasObservableEclipse). Never exceeds penumbralPhaseDuration.
	readonly observableDuration: number
}

// Full local circumstances for one geographic point.
export interface LocalLunarEclipseCircumstances {
	readonly location: {
		// Geographic longitude in radians, east-positive.
		readonly longitude: Angle
		// Geodetic latitude in radians.
		readonly latitude: Angle
	}
	// Coarse visibility classification.
	readonly visibility: LocalLunarEclipseVisibility
	// Maximal magnitudes and durations.
	readonly details: LocalLunarEclipseDetails
	// Resolved per-contact events keyed by contact kind.
	readonly events: Partial<Record<LunarEclipseContactKind, LocalLunarEclipseEvent>>
}

// Greenwich apparent sidereal time (radians) at a contact, consistent with the apparent Moon position. The
// UT1 fraction comes from the dynamical time and the sample Delta T, matching the global engine.
function contactGast(time: Time, deltaT: number) {
	const ttTime = tt(time)
	const ut1Fraction = ttTime.fraction - deltaT / DAYSEC
	return eraGst06a(ttTime.day, ut1Fraction, ttTime.day, ttTime.fraction)
}

// Position angle (radians, [0, TAU)) of point 2 as seen from point 1, measured from celestial north toward
// east. Uses the stable atan2 formulation; the Earth shadow center is the antisolar point.
function positionAngleBetween(ra1: Angle, dec1: Angle, ra2: Angle, dec2: Angle) {
	const dRA = ra2 - ra1
	const sinDRA = Math.sin(dRA)
	const cosDRA = Math.cos(dRA)
	const y = Math.cos(dec2) * sinDRA
	const x = Math.cos(dec1) * Math.sin(dec2) - Math.sin(dec1) * Math.cos(dec2) * cosDRA
	return normalizeAngle(Math.atan2(y, x))
}

// Whether the contact is the internal (totality) tangency U2/U3 of a total eclipse. There the lunar limb is
// tangent to the umbra from the inside, so the limb contact point lies on the far side of the disk from the
// Earth-shadow center; the external contacts (P1/U1/U4/P4) touch on the shadow-center side instead.
function isInternalTangencyContact(kind: LunarEclipseContactKind, type: LunarEclipse['type']) {
	return type === 'TOTAL' && (kind === 'U2' || kind === 'U3')
}

// |shadow-axis distance| (plane Earth radii) of the Moon at one contact, fixed by the contact kind in the
// Meeus model: this is what makes the per-contact magnitudes exact (0 at the external contacts, 1 at the
// total contacts, the eclipse magnitude at MAX).
//   kind: contact kind.
//   u: penumbra/umbra enlargement term (eclipse.u).
//   gamma: least shadow-axis distance at maximum (eclipse.gamma).
function contactShadowDistance(kind: LunarEclipseContactKind, u: number, gamma: number): number {
	switch (kind) {
		case 'P1':
		case 'P4':
			return LUNAR_ECLIPSE_PENUMBRA_LIMIT + u
		case 'U1':
		case 'U4':
			return LUNAR_ECLIPSE_UMBRA_LIMIT - u
		case 'U2':
		case 'U3':
			return LUNAR_ECLIPSE_TOTAL_LIMIT - u
		case 'MAX':
			return Math.abs(gamma)
	}
}

// Umbral and penumbral magnitudes from the shadow-axis distance and enlargement term. Negative values mean the
// Moon is wholly outside that shadow (kept signed so callers can see how far outside).
function shadowMagnitudes(shadowDistance: number, u: number): [umbral: number, penumbral: number] {
	const umbral = (LUNAR_ECLIPSE_UMBRA_LIMIT - u - shadowDistance) / LUNAR_ECLIPSE_MAGNITUDE_DENOMINATOR
	const penumbral = (LUNAR_ECLIPSE_PENUMBRA_LIMIT + u - shadowDistance) / LUNAR_ECLIPSE_MAGNITUDE_DENOMINATOR
	return [umbral, penumbral]
}

// Topocentric Moon equatorial coordinates (radians) corrected for diurnal parallax. The geocentric apparent
// Moon direction is shifted by the observer's geocentric position before re-deriving right ascension and
// declination. Omitting this (~0.95 deg horizontal parallax) would overstate the altitude near the horizon by
// up to one parallax, marking sub-horizon locations as observable, and would bias the Alt/Az and zenith angle.
//   moonRA, moonDEC: geocentric apparent Moon right ascension/declination (radians).
//   moonDistance: geocentric Moon distance in Earth equatorial radii (position.moon.distance).
//   latitude: observer geodetic latitude (radians).
//   lst: local apparent sidereal time (radians) = GAST + longitude.
//   returns: [topocentric right ascension, topocentric declination] in radians.
function moonTopocentric(moonRA: Angle, moonDEC: Angle, moonDistance: number, latitude: Angle, lst: Angle): [ra: Angle, dec: Angle] {
	// Observer geocentric coordinates (Earth equatorial radii), reduced for Earth flattening (F = b / a). The
	// observer's zenith points to right ascension = lst, geocentric declination = phi'.
	const u = Math.atan(F * Math.tan(latitude))
	const rhoSinPhi = F * Math.sin(u)
	const rhoCosPhi = Math.cos(u)

	const cosD = Math.cos(moonDEC)
	const x = moonDistance * cosD * Math.cos(moonRA) - rhoCosPhi * Math.cos(lst)
	const y = moonDistance * cosD * Math.sin(moonRA) - rhoCosPhi * Math.sin(lst)
	const z = moonDistance * Math.sin(moonDEC) - rhoSinPhi
	const r = Math.hypot(x, y, z)

	return [Math.atan2(y, x), Math.asin(clamp(z / r, -1, 1))]
}

// Topocentric apparent Moon altitude (radians) at one instant for one observer. Applies diurnal parallax, then
// converts to horizontal coordinates. Used by the continuous visibility scan and the phase-visibility search.
export function moonAltitudeAt(time: Time, longitude: Angle, latitude: Angle, getPosition: LunarEclipsePositionProvider) {
	const position = getPosition(time)
	const lst = contactGast(time, position.deltaT ?? 0) + longitude
	const [topoRA, topoDEC] = moonTopocentric(position.moon.rightAscension, position.moon.declination, position.moon.distance, latitude, lst)
	const [, altitude] = equatorialToHorizontal(topoRA, topoDEC, latitude, lst)
	return altitude
}

// Builds one resolved local event: altitude/azimuth, the P/Z orientation angles, and the per-contact
// magnitudes.
function computeLocalEvent(contact: LunarEclipseContact, eclipse: LunarEclipse, longitude: Angle, latitude: Angle, getPosition: LunarEclipsePositionProvider, horizonAltitude: Angle): LocalLunarEclipseEvent {
	const position = getPosition(contact.time)
	const gast = contactGast(contact.time, position.deltaT ?? 0)
	const lst = gast + longitude

	const moonRA = position.moon.rightAscension
	const moonDEC = position.moon.declination

	// Topocentric (parallax-corrected) Moon position drives the observer-dependent quantities: altitude,
	// azimuth and the parallactic angle. The shadow-disk position angle P stays geocentric (the conventional
	// table value): parallax shifts the Moon and the shadow, which lies at the Moon's distance, almost equally.
	const [topoRA, topoDEC] = moonTopocentric(moonRA, moonDEC, position.moon.distance, latitude, lst)
	const [azimuth, altitude] = equatorialToHorizontal(topoRA, topoDEC, latitude, lst)

	// Earth-shadow center = antisolar point; positionAngleBetween gives the shadow-center direction on the
	// lunar disk. The reported P angle is the limb CONTACT-point angle: the shadow-center direction at the
	// external contacts, flipped by PI at the U2/U3 internal tangency of a total eclipse (far side of the disk).
	const shadowRA = position.sun.rightAscension + PI
	const shadowDEC = -position.sun.declination
	const shadowCenterAngle = positionAngleBetween(moonRA, moonDEC, shadowRA, shadowDEC)
	const positionAngle = isInternalTangencyContact(contact.kind, eclipse.type) ? normalizeAngle(shadowCenterAngle + PI) : shadowCenterAngle

	// Lunar parallactic angle converts the celestial-north P angle into the zenith-oriented Z angle.
	const hourAngle = normalizePI(lst - topoRA)
	const q = parallacticAngle(hourAngle, topoDEC, latitude)
	const zenithAngle = normalizeAngle(positionAngle - q)

	const shadowDistance = contactShadowDistance(contact.kind, eclipse.u, eclipse.gamma)
	const [umbralMagnitude, penumbralMagnitude] = shadowMagnitudes(shadowDistance, eclipse.u)

	return {
		kind: contact.kind,
		time: contact.time,
		jd: contact.jd,
		observable: altitude >= horizonAltitude,
		altitude,
		azimuth,
		positionAngle,
		zenithAngle,
		umbralMagnitude,
		penumbralMagnitude,
	}
}

// Human-readable text for each local visibility classification.
export function localLunarVisibilityText(kind: LocalLunarEclipseVisibilityKind) {
	switch (kind) {
		case 'completelyVisible':
			return 'Entire eclipse visible'
		case 'totalVisible':
			return 'Total phase visible'
		case 'partialVisible':
			return 'Partial (umbral) phase visible'
		case 'penumbralOnlyVisible':
			return 'Only the penumbral phase visible'
		case 'geometricOnlyBelowHorizon':
			return 'Eclipse occurs with the Moon below the horizon'
		case 'notVisible':
			return 'Eclipse not visible'
	}
}

// Result of the continuous altitude scan across the penumbral interval.
interface AltitudeScan {
	// Julian Days of the samples, ascending.
	readonly jds: number[]
	// Moon altitudes (radians) at each sample.
	readonly altitudes: number[]
	// Sample spacing in days.
	readonly step: number
}

// Samples the Moon altitude across the penumbral interval [P1, P4] so the classifier can detect observable
// stretches between contacts. Returns empty arrays when the interval is degenerate.
function scanAltitudes(fromJd: number, toJd: number, longitude: Angle, latitude: Angle, getPosition: LunarEclipsePositionProvider, samples: number, reference: Time): AltitudeScan {
	const jds: number[] = []
	const altitudes: number[] = []
	const span = toJd - fromJd
	if (!(span > 0) || samples < 1) return { jds, altitudes, step: 0 }

	const step = span / samples
	for (let i = 0; i <= samples; i++) {
		const jd = fromJd + i * step
		const time = timeAtJulianDay(reference, jd)
		jds.push(jd)
		altitudes.push(moonAltitudeAt(time, longitude, latitude, getPosition))
	}

	return { jds, altitudes, step }
}

// Sidereal Earth rotation rate (radians per day). The diurnal altitude rate is bounded by this, so over one
// scan step the altitude can change by at most EARTH_ROTATION_RATE_PER_DAY * step: a sample interval whose
// endpoints are on the same side of the horizon can hide a crossing pair only when an endpoint is within that
// bound of the horizon.
const EARTH_ROTATION_RATE_PER_DAY = TAU / 0.99726966
// Sub-steps used to integrate a suspect interval that may hide a horizon crossing pair.
const REFINE_SUBSTEPS = 16

// Whether the altitude is monotonic across the window around interval [i, i+1] (its neighbours i-1..i+2). A
// same-side interval can only hide a horizon crossing pair when it is non-monotonic (an interior extremum pokes
// across), so this restricts the costly refinement to the at most one turning point of the penumbral scan.
function isMonotonicWindow(altitudes: number[], i: number) {
	const lo = Math.max(0, i - 1)
	const hi = Math.min(altitudes.length - 1, i + 2)
	let nonDecreasing = true
	let nonIncreasing = true

	for (let k = lo; k < hi; k++) {
		if (altitudes[k + 1] > altitudes[k]) nonIncreasing = false
		if (altitudes[k + 1] < altitudes[k]) nonDecreasing = false
	}

	return nonDecreasing || nonIncreasing
}

// Above-horizon time (days) within one suspect sample interval, by subdividing it and summing the linear
// horizon-crossing fraction of each sub-step. The interval spans at most one scan step, over which the altitude
// is unimodal, so a fixed subdivision resolves a brief peak above the horizon (or a brief dip below it) that the
// coarse endpoints alone miss.
function aboveHorizonDaysInInterval(fromJd: number, toJd: number, horizonAltitude: Angle, longitude: Angle, latitude: Angle, getPosition: LunarEclipsePositionProvider, reference: Time) {
	const dt = (toJd - fromJd) / REFINE_SUBSTEPS
	let previous = moonAltitudeAt(timeAtJulianDay(reference, fromJd), longitude, latitude, getPosition) - horizonAltitude
	let days = 0

	for (let k = 1; k <= REFINE_SUBSTEPS; k++) {
		const current = moonAltitudeAt(timeAtJulianDay(reference, fromJd + k * dt), longitude, latitude, getPosition) - horizonAltitude
		if (previous >= 0 && current >= 0) days += dt
		else if (previous < 0 && current < 0) days += 0
		else {
			const t = previous / (previous - current)
			days += (previous >= 0 ? t : 1 - t) * dt
		}
		previous = current
	}

	return days
}

// Total time (days) the Moon is at or above the horizon within the scanned interval. Each sample interval
// contributes its above-horizon fraction: 1 when both endpoints are above, 0 when both are below, and the
// linearly interpolated horizon-crossing fraction when they straddle the horizon. A same-side interval whose
// nearer endpoint is within one step's altitude change of the horizon is refined by subdivision, so a short
// above-horizon stretch that falls between two coarse samples (the same case phaseReachesHorizon catches for
// the classification) is integrated rather than dropped to zero. The result is capped at the scanned span so it
// can never exceed P4 - P1.
function observableDaysFromScan(scan: AltitudeScan, horizonAltitude: Angle, longitude: Angle, latitude: Angle, getPosition: LunarEclipsePositionProvider, reference: Time) {
	const { jds, altitudes, step } = scan
	if (!(step > 0) || altitudes.length < 2) return 0

	// A same-side interval can hide a crossing pair only when an endpoint is within this much of the horizon.
	const refineMargin = EARTH_ROTATION_RATE_PER_DAY * step
	let days = 0

	for (let i = 0; i + 1 < altitudes.length; i++) {
		const a = altitudes[i] - horizonAltitude
		const b = altitudes[i + 1] - horizonAltitude

		if (a >= 0 === b >= 0) {
			// Both endpoints on the same side of the horizon: confidently the whole step (above) or nothing
			// (below), unless an endpoint is within one step's altitude change of the horizon AND the window is
			// non-monotonic, so a brief excursion across the horizon could hide between the samples; then
			// integrate the sub-interval.
			if (Math.min(Math.abs(a), Math.abs(b)) < refineMargin && !isMonotonicWindow(altitudes, i)) days += aboveHorizonDaysInInterval(jds[i], jds[i + 1], horizonAltitude, longitude, latitude, getPosition, reference)
			else days += a >= 0 ? step : 0
		} else {
			// The endpoints straddle the horizon: the crossing is at t = a / (a - b) of the step (a - b != 0).
			const t = a / (a - b)
			days += (a >= 0 ? t : 1 - t) * step
		}
	}

	return Math.min(days, jds.at(-1)! - jds[0])
}

// Golden-section iteration cap and minimum interval (days, ~2 s) for the phase-visibility interior search.
const PHASE_MAX_ITERATIONS = 32
const PHASE_MIN_SPAN_DAYS = 2 / DAYSEC
// Reciprocal golden ratio, 1 / phi.
const INVERSE_GOLDEN_RATIO = 0.61803398874989484820458683436564 // (Math.sqrt(5) - 1) / 2

// Whether the topocentric Moon altitude reaches the horizon anywhere within [fromJd, toJd].
//
// A sample-only test misses a short above-horizon stretch that falls entirely between two fixed samples (a very
// short total phase, or a grazing high-latitude moonrise/moonset), so this also tests the exact interval
// endpoints (the phase contacts) and, when every sampled point is below the horizon, searches the interior for
// the single altitude maximum. The altitude is unimodal over a phase interval (its hour-angle span is well
// under a full turn, so there is at most one upper transit), so a golden-section search locates that maximum;
// it returns as soon as any evaluated altitude reaches the horizon.
//   scan: the precomputed penumbral-interval altitude samples, used only as a cheap interior pre-check.
//   fromJd, toJd: the phase interval (Julian Days); endpoints are the phase contacts.
//   altFrom, altTo: topocentric Moon altitudes at the endpoints (already resolved on the contact events).
//   reference: time-scale reference for building instants from Julian Days.
function phaseReachesHorizon(scan: AltitudeScan, fromJd: number, toJd: number, altFrom: Angle, altTo: Angle, longitude: Angle, latitude: Angle, getPosition: LunarEclipsePositionProvider, horizonAltitude: Angle, reference: Time) {
	// Exact phase endpoints first: a short phase whose whole above-horizon stretch is its endpoints is caught here.
	if (altFrom >= horizonAltitude || altTo >= horizonAltitude) return true
	if (!(toJd > fromJd)) return false

	// Cheap pre-check: any precomputed sample strictly inside the interval that is already above the horizon.
	for (let i = 0; i < scan.jds.length; i++) {
		if (scan.jds[i] <= fromJd || scan.jds[i] >= toJd) continue
		if (scan.altitudes[i] >= horizonAltitude) return true
	}

	// Interior maximum search (the altitude is unimodal over the interval): golden-section, early-exit on reach.
	const altitudeAt = (jd: number) => moonAltitudeAt(timeAtJulianDay(reference, jd), longitude, latitude, getPosition)
	let lo = fromJd
	let hi = toJd
	let c = hi - INVERSE_GOLDEN_RATIO * (hi - lo)
	let d = lo + INVERSE_GOLDEN_RATIO * (hi - lo)
	let fc = altitudeAt(c)
	let fd = altitudeAt(d)
	if (fc >= horizonAltitude || fd >= horizonAltitude) return true

	for (let i = 0; i < PHASE_MAX_ITERATIONS && hi - lo > PHASE_MIN_SPAN_DAYS; i++) {
		if (fc > fd) {
			hi = d
			d = c
			fd = fc
			c = hi - INVERSE_GOLDEN_RATIO * (hi - lo)
			fc = altitudeAt(c)
		} else {
			lo = c
			c = d
			fc = fd
			d = lo + INVERSE_GOLDEN_RATIO * (hi - lo)
			fd = altitudeAt(d)
		}

		if (fc >= horizonAltitude || fd >= horizonAltitude) return true
	}

	return false
}

// Whether the topocentric Moon stays at or above the horizon across the ENTIRE interval [fromJd, toJd].
//
// "Entire eclipse visible" cannot be decided from the contact samples alone: every contact can be above the
// horizon while the Moon still dips below it between contacts (a high-latitude lower culmination during the
// several-hour penumbral interval). The altitude has at most one interior extremum over a phase interval (its
// hour-angle span is well under a full turn), so the minimum is at an endpoint or at the single lower
// culmination; a golden-section minimum search (bracketed around the lowest precomputed sample) finds it and
// returns false as soon as any evaluated altitude is below the horizon.
//   scan: precomputed penumbral-interval samples, used to reject an obvious below-horizon sample and to bracket.
//   altFrom, altTo: topocentric Moon altitudes at the endpoints (already resolved on the contact events).
function phaseStaysAboveHorizon(scan: AltitudeScan, fromJd: number, toJd: number, altFrom: Angle, altTo: Angle, longitude: Angle, latitude: Angle, getPosition: LunarEclipsePositionProvider, horizonAltitude: Angle, reference: Time) {
	if (altFrom < horizonAltitude || altTo < horizonAltitude) return false
	if (!(toJd > fromJd)) return true

	// Lowest precomputed sample strictly inside: a below-horizon one settles it; otherwise it brackets the
	// continuous minimum (which lies within one step of the lowest sample for an at-most-one-extremum altitude).
	let lowIndex = -1
	let lowAltitude = Infinity
	for (let i = 0; i < scan.jds.length; i++) {
		if (scan.jds[i] <= fromJd || scan.jds[i] >= toJd) continue
		if (scan.altitudes[i] < horizonAltitude) return false
		if (scan.altitudes[i] < lowAltitude) {
			lowAltitude = scan.altitudes[i]
			lowIndex = i
		}
	}

	let lo = fromJd
	let hi = toJd
	if (lowIndex >= 0 && scan.step > 0) {
		lo = Math.max(fromJd, scan.jds[lowIndex] - scan.step)
		hi = Math.min(toJd, scan.jds[lowIndex] + scan.step)
	}

	// Golden-section minimum search, early-exit on a below-horizon point.
	const altitudeAt = (jd: number) => moonAltitudeAt(timeAtJulianDay(reference, jd), longitude, latitude, getPosition)
	let c = hi - INVERSE_GOLDEN_RATIO * (hi - lo)
	let d = lo + INVERSE_GOLDEN_RATIO * (hi - lo)
	let fc = altitudeAt(c)
	let fd = altitudeAt(d)
	if (fc < horizonAltitude || fd < horizonAltitude) return false

	for (let i = 0; i < PHASE_MAX_ITERATIONS && hi - lo > PHASE_MIN_SPAN_DAYS; i++) {
		if (fc < fd) {
			hi = d
			d = c
			fd = fc
			c = hi - INVERSE_GOLDEN_RATIO * (hi - lo)
			fc = altitudeAt(c)
		} else {
			lo = c
			c = d
			fc = fd
			d = lo + INVERSE_GOLDEN_RATIO * (hi - lo)
			fd = altitudeAt(d)
		}

		if (fc < horizonAltitude || fd < horizonAltitude) return false
	}

	return true
}

// Builds a Time at a Julian Day, preserving the reference time scale and providers.
function timeAtJulianDay(reference: Time, julianDay: number) {
	return timeShift(reference, julianDay - reference.day - reference.fraction)
}

// Computes the full local circumstances of a lunar eclipse for one geographic point.
//   eclipse: lunar eclipse with its TT contact times, magnitude, u and gamma.
//   longitude: observer geographic longitude (radians, east-positive).
//   latitude: observer geodetic latitude (radians).
//   getSunMoonPosition: apparent Sun/Moon position provider at a dynamical time.
//   options: horizon altitude and altitude-sampling options.
export function computeLocalLunarEclipseCircumstances(eclipse: LunarEclipse, longitude: Angle, latitude: Angle, getSunMoonPosition: LunarEclipsePositionProvider, options: LocalLunarEclipseCircumstancesOptions = {}): LocalLunarEclipseCircumstances {
	const horizonAltitude = options.horizonAltitude ?? 0
	const samples = options.altitudeSamples ?? 48

	const contacts = lunarEclipseEvents(eclipse)
	const events: Writable<Partial<Record<LunarEclipseContactKind, LocalLunarEclipseEvent>>> = {}

	for (const contact of contacts) {
		events[contact.kind] = computeLocalEvent(contact, eclipse, longitude, latitude, getSunMoonPosition, horizonAltitude)
	}

	const p1 = events.P1
	const p4 = events.P4
	const reference = eclipse.maximalTime

	// Continuous altitude scan across the penumbral interval, reused for the observable duration and as a cheap
	// pre-check inside the phase-visibility search.
	const scan = p1 && p4 ? scanAltitudes(p1.jd, p4.jd, longitude, latitude, getSunMoonPosition, samples, reference) : { jds: [], altitudes: [], step: 0 }

	const hasGeometricEclipse = contacts.length > 0
	const penumbralVisible = p1 && p4 ? phaseReachesHorizon(scan, p1.jd, p4.jd, p1.altitude, p4.altitude, longitude, latitude, getSunMoonPosition, horizonAltitude, reference) : false
	const hasObservableEclipse = penumbralVisible

	// The umbral and total intervals lie inside [P1, P4]: if the Moon never reaches the horizon across the whole
	// penumbral interval it cannot in a sub-interval, so this guard also avoids the extra search cost there.
	const umbralVisible = penumbralVisible && events.U1 && events.U4 ? phaseReachesHorizon(scan, events.U1.jd, events.U4.jd, events.U1.altitude, events.U4.altitude, longitude, latitude, getSunMoonPosition, horizonAltitude, reference) : false
	const totalVisible = penumbralVisible && events.U2 && events.U3 ? phaseReachesHorizon(scan, events.U2.jd, events.U3.jd, events.U2.altitude, events.U3.altitude, longitude, latitude, getSunMoonPosition, horizonAltitude, reference) : false

	// "Entire eclipse visible" requires the Moon to stay above the horizon for the whole [P1, P4] interval, not
	// merely at the contacts: a high-latitude lower culmination can drop it below the horizon between contacts.
	const fullyAbove = penumbralVisible && p1 && p4 ? phaseStaysAboveHorizon(scan, p1.jd, p4.jd, p1.altitude, p4.altitude, longitude, latitude, getSunMoonPosition, horizonAltitude, reference) : false

	let kind: LocalLunarEclipseVisibilityKind
	if (!hasGeometricEclipse) kind = 'notVisible'
	else if (!penumbralVisible) kind = 'geometricOnlyBelowHorizon'
	else if (fullyAbove) kind = 'completelyVisible'
	else if (totalVisible) kind = 'totalVisible'
	else if (umbralVisible) kind = 'partialVisible'
	else kind = 'penumbralOnlyVisible'

	// Observable duration: integrate the above-horizon fraction of each sample interval (refining intervals that
	// may hide a sub-sample horizon crossing, and capped at the scanned span), so it stays consistent with
	// hasObservableEclipse even when the Moon only rises above the horizon between two coarse samples.
	const observableDuration = observableDaysFromScan(scan, horizonAltitude, longitude, latitude, getSunMoonPosition, reference) * DAYSEC

	const [, maximalPenumbralMagnitude] = shadowMagnitudes(Math.abs(eclipse.gamma), eclipse.u)

	const details: LocalLunarEclipseDetails = {
		maximalUmbralMagnitude: eclipse.type === 'PENUMBRAL' ? null : eclipse.magnitude,
		maximalPenumbralMagnitude,
		penumbralPhaseDuration: p1 && p4 ? (p4.jd - p1.jd) * DAYSEC : 0,
		partialPhaseDuration: events.U1 && events.U4 ? (events.U4.jd - events.U1.jd) * DAYSEC : null,
		totalPhaseDuration: events.U2 && events.U3 ? (events.U3.jd - events.U2.jd) * DAYSEC : null,
		observableDuration,
	}

	return {
		location: { longitude, latitude },
		visibility: { kind, text: localLunarVisibilityText(kind), hasGeometricEclipse, hasObservableEclipse },
		details,
		events,
	}
}

// Local View geometry

// Orientation of the Local View diagram: 'zenith' puts the local zenith up; 'north' puts celestial north up.
export type LocalLunarViewOrientationMode = 'zenith' | 'north'

// Horizontal handedness: 'eastRight' (default, map-like) puts celestial east to the right; 'eastLeft' mirrors
// it for the naked-eye / sky-chart convention.
export type LocalLunarViewHandedness = 'eastRight' | 'eastLeft'

// Options controlling the Local View geometry.
export interface LocalLunarEclipseViewOptions {
	// Diagram width in SVG pixels.
	readonly width: number
	// Diagram height in SVG pixels.
	readonly height: number
	// Contact drawn as the primary (highlighted) state and as the frame reference for the zenith rotation.
	readonly selectedEvent: LunarEclipseContactKind
	// Diagram orientation. Only geometry changes; no UI is implied.
	readonly orientationMode: LocalLunarViewOrientationMode
	// Horizontal handedness. Defaults to 'eastRight'.
	readonly handedness?: LocalLunarViewHandedness
	// Umbra circle radius in SVG pixels; the global scale anchor for the diagram.
	readonly umbraRadiusPx: number
	// Whether to draw ghost Moon disks for the non-selected contacts.
	readonly includeGhostDisks: boolean
	// Whether to draw the apparent-horizon line and below-horizon band for the selected contact.
	readonly includeHorizon: boolean
	// Optional padding (px) for the horizon band polygon.
	readonly horizonBandPaddingPx?: number
	// Apparent-horizon altitude (radians) the diagram is drawn against: the horizon line is placed at this
	// altitude, so a Moon disk is drawn above it exactly when altitude >= horizonAltitude (matching the event's
	// observable flag). Pass the same value used for the circumstances so an obstructed horizon (e.g. 10 deg)
	// stays consistent with observability. Default 0 (the true horizon).
	readonly horizonAltitude?: Angle
}

// A circle shape: shadow rings or a Moon disk.
export interface LocalLunarEclipseSvgCircle {
	readonly kind: 'circle'
	// Semantic role.
	readonly role: 'penumbra' | 'umbra' | 'moonDisk' | 'ghostMoonDisk'
	// Contact this disk was drawn for (for the Moon disks), so the UI can label it.
	readonly event?: LunarEclipseContactKind
	// Center x in SVG pixels.
	readonly cx: number
	// Center y in SVG pixels.
	readonly cy: number
	// Radius in SVG pixels.
	readonly r: number
}

// A straight line: the horizon or a trajectory segment.
export interface LocalLunarEclipseSvgLine {
	readonly kind: 'line'
	readonly role: 'horizonLine'
	readonly x1: number
	readonly y1: number
	readonly x2: number
	readonly y2: number
}

// A path: the Moon-center trajectory through the contacts.
export interface LocalLunarEclipseSvgPath {
	readonly kind: 'path'
	readonly role: 'trajectoryPath'
	// SVG path data string.
	readonly d: string
}

// A filled polygon: the below-horizon band.
export interface LocalLunarEclipseSvgPolygon {
	readonly kind: 'polygon'
	readonly role: 'horizonBand'
	readonly points: readonly Point[]
}

export type LocalLunarEclipseSvgShape = LocalLunarEclipseSvgCircle | LocalLunarEclipseSvgLine | LocalLunarEclipseSvgPath | LocalLunarEclipseSvgPolygon

// Serializable Local View geometry: plain shapes only, no text and no UI.
export interface LocalLunarEclipseViewGeometry {
	// Diagram width in SVG pixels.
	readonly width: number
	// Diagram height in SVG pixels.
	readonly height: number
	// Orientation frame the geometry was built in.
	readonly orientationMode: LocalLunarViewOrientationMode
	// The contact the caller requested as the primary state.
	readonly requestedEvent: LunarEclipseContactKind
	// The contact actually drawn as primary: the requested one when available, else MAX, else the first
	// available contact, or null when no contact exists.
	readonly selectedEvent: LunarEclipseContactKind | null
	// Umbra circle radius in SVG pixels.
	readonly umbraRadiusPx: number
	// All drawable shapes, in painter order.
	readonly shapes: readonly LocalLunarEclipseSvgShape[]
}

// Default Local View options.
const DEFAULT_LOCAL_LUNAR_VIEW_OPTIONS: LocalLunarEclipseViewOptions = {
	width: 300,
	height: 300,
	selectedEvent: 'MAX',
	orientationMode: 'zenith',
	handedness: 'eastRight',
	umbraRadiusPx: 70,
	includeGhostDisks: true,
	includeHorizon: true,
	horizonBandPaddingPx: 4,
	horizonAltitude: 0,
}

// Chronological contact order used to lay out the trajectory and pick a fallback primary contact.
const CONTACT_ORDER: readonly LunarEclipseContactKind[] = ['P1', 'U1', 'U2', 'MAX', 'U3', 'U4', 'P4']

// Picks the primary contact: the requested one, else MAX, else the first available.
function selectPrimaryEvent(events: Partial<Record<LunarEclipseContactKind, LocalLunarEclipseEvent>>, requested: LunarEclipseContactKind) {
	const requestedEvent = events[requested]
	if (requestedEvent) return requestedEvent
	if (events.MAX) return events.MAX

	for (const kind of CONTACT_ORDER) {
		const event = events[kind]
		if (event) return event
	}

	return null
}

// Shadow-center (disk-placement) direction of a resolved event: the reported limb-contact P angle, undoing the
// U2/U3 internal-tangency flip so the Moon disk is placed by the geometric shadow-center direction, not the
// contact-point direction.
function eventShadowCenterAngle(event: LocalLunarEclipseEvent, type: LunarEclipse['type']) {
	return isInternalTangencyContact(event.kind, type) ? normalizeAngle(event.positionAngle - PI) : event.positionAngle
}

// SVG screen offset (px) of a Moon disk from the shadow center. The Moon center sits opposite the shadow-center
// direction (shadowCenterAngle + PI) at distance ell. In the zenith frame the celestial-north angle is rotated
// by the frame parallactic angle q so the zenith is up; in the north frame q is 0.
//   shadowCenterAngle: position angle (radians) of the Earth-shadow center as seen from the Moon. This is the
//   disk-placement direction, distinct from the reported limb-contact P angle (which is flipped at U2/U3).
//   ell: shadow-axis distance (plane Earth radii).
//   scale: pixels per plane Earth radius.
//   frameParallactic: parallactic angle (radians) of the frame's selected event, applied in zenith mode.
//   orientationMode: diagram orientation.
//   eastSign: +1 for eastRight, -1 for eastLeft.
function moonDiskOffset(shadowCenterAngle: Angle, ell: number, scale: number, frameParallactic: Angle, orientationMode: LocalLunarViewOrientationMode, eastSign: number): Point {
	const q = orientationMode === 'zenith' ? frameParallactic : 0
	const angle = shadowCenterAngle + PI - q
	return { x: eastSign * scale * ell * Math.sin(angle), y: -scale * ell * Math.cos(angle) }
}

// Builds the apparent-horizon line and below-horizon band for the selected contact. The horizon sits at the
// Moon altitude away from the zenith; its distance from the shadow center is scaled by the mean angular size of
// one Earth radius at the Moon, which is a schematic approximation (the shadow is tiny next to the altitude).
function buildHorizonShapes(primary: LocalLunarEclipseEvent, options: LocalLunarEclipseViewOptions, cx: number, cy: number, scale: number, eastSign: number): LocalLunarEclipseSvgShape[] {
	// Zenith direction in SVG pixels (y grows downward). In the north frame the zenith is rotated from "up" by
	// the frame parallactic angle; here the zenith frame keeps it straight up, so the rotation is folded into
	// the disk angles instead and the horizon is drawn straight.
	const q = options.orientationMode === 'north' ? primary.positionAngle - primary.zenithAngle : 0
	const zenithX = eastSign * Math.sin(q)
	const zenithY = -Math.cos(q)

	// Altitude offset (px) from the shadow center along the zenith direction, measured from the CONFIGURED
	// horizon (not true altitude 0) so the line matches the observable flag for a raised/obstructed horizon: the
	// Moon sits above the line exactly when altitude >= horizonAltitude.
	const horizonAltitude = options.horizonAltitude ?? 0
	const offsetPx = clamp(((primary.altitude - horizonAltitude) / MEAN_EARTH_RADIUS_ANGULAR_AT_MOON) * scale, -Math.hypot(options.width, options.height) * 2, Math.hypot(options.width, options.height) * 2)
	const horizonX = cx - offsetPx * zenithX
	const horizonY = cy - offsetPx * zenithY

	const tangentX = -zenithY
	const tangentY = zenithX
	const half = Math.hypot(options.width, options.height)
	const line: LocalLunarEclipseSvgLine = {
		kind: 'line',
		role: 'horizonLine',
		x1: horizonX - tangentX * half,
		y1: horizonY - tangentY * half,
		x2: horizonX + tangentX * half,
		y2: horizonY + tangentY * half,
	}

	const padding = options.horizonBandPaddingPx ?? 0
	const awayX = -zenithX
	const awayY = -zenithY
	const near = -padding
	const far = padding + 4 * half
	const band: LocalLunarEclipseSvgPolygon = {
		kind: 'polygon',
		role: 'horizonBand',
		points: [
			{ x: horizonX - tangentX * half + awayX * near, y: horizonY - tangentY * half + awayY * near },
			{ x: horizonX + tangentX * half + awayX * near, y: horizonY + tangentY * half + awayY * near },
			{ x: horizonX + tangentX * half + awayX * far, y: horizonY + tangentY * half + awayY * far },
			{ x: horizonX - tangentX * half + awayX * far, y: horizonY - tangentY * half + awayY * far },
		],
	}

	return [band, line]
}

// Builds the serializable Local View geometry from the resolved circumstances. Emits only geometric shapes: no
// labels, text or UI. The shadow center is fixed at the diagram center; the Moon disks are placed by their P
// angle and shadow-axis distance, so the eclipse is read off the disk positions relative to the umbra and
// penumbra rings.
//   circumstances: resolved events (from computeLocalLunarEclipseCircumstances) and the eclipse geometry.
//   eclipse: the lunar eclipse (umbra radius sigma, penumbra radius rho).
//   options: Local View options.
export function computeLocalLunarEclipseViewGeometry(circumstances: Pick<LocalLunarEclipseCircumstances, 'events'>, eclipse: LunarEclipse, options: Partial<LocalLunarEclipseViewOptions> = {}): LocalLunarEclipseViewGeometry {
	const resolved: LocalLunarEclipseViewOptions = { ...DEFAULT_LOCAL_LUNAR_VIEW_OPTIONS, ...options }
	const events = circumstances.events
	const cx = resolved.width * 0.5
	const cy = resolved.height * 0.5
	const eastSign = resolved.handedness === 'eastLeft' ? -1 : 1

	// Pixels per plane Earth radius, anchored on the umbra radius. Guard a degraded sigma so the rings never
	// collapse or invert.
	const umbraRadius = eclipse.sigma > 0 && Number.isFinite(eclipse.sigma) ? eclipse.sigma : LUNAR_ECLIPSE_TOTAL_LIMIT
	const scale = resolved.umbraRadiusPx / umbraRadius
	const penumbraRadiusPx = scale * eclipse.rho
	const moonRadiusPx = scale * MOON_RADIUS_EARTH_RADII

	const primary = selectPrimaryEvent(events, resolved.selectedEvent)
	const frameParallactic = primary ? primary.positionAngle - primary.zenithAngle : 0

	const shapes: LocalLunarEclipseSvgShape[] = []

	// Below-horizon band first (painted behind), then shadow rings, ghosts, trajectory, primary disk, then the
	// horizon line on top.
	if (resolved.includeHorizon && primary) {
		shapes.push(buildHorizonShapes(primary, resolved, cx, cy, scale, eastSign)[0])
	}

	shapes.push({ kind: 'circle', role: 'penumbra', cx, cy, r: penumbraRadiusPx })
	shapes.push({ kind: 'circle', role: 'umbra', cx, cy, r: resolved.umbraRadiusPx })

	// Trajectory through the available contacts, in chronological order.
	const trajectory: Point[] = []
	for (const kind of CONTACT_ORDER) {
		const event = events[kind]
		if (!event) continue
		const ell = contactShadowDistance(kind, eclipse.u, eclipse.gamma)
		const offset = moonDiskOffset(eventShadowCenterAngle(event, eclipse.type), ell, scale, frameParallactic, resolved.orientationMode, eastSign)
		trajectory.push({ x: cx + offset.x, y: cy + offset.y })
	}
	if (trajectory.length >= 2) {
		const tokens: string[] = [`M${formatCoordinate(trajectory[0].x)} ${formatCoordinate(trajectory[0].y)}`]
		for (let i = 1; i < trajectory.length; i++) tokens.push(`L${formatCoordinate(trajectory[i].x)} ${formatCoordinate(trajectory[i].y)}`)
		shapes.push({ kind: 'path', role: 'trajectoryPath', d: tokens.join('') })
	}

	// Ghost Moon disks for the non-selected contacts, drawn before the primary so it sits on top.
	if (resolved.includeGhostDisks) {
		for (const kind of CONTACT_ORDER) {
			const event = events[kind]
			if (!event || event === primary) continue
			const ell = contactShadowDistance(kind, eclipse.u, eclipse.gamma)
			const offset = moonDiskOffset(eventShadowCenterAngle(event, eclipse.type), ell, scale, frameParallactic, resolved.orientationMode, eastSign)
			shapes.push({ kind: 'circle', role: 'ghostMoonDisk', event: kind, cx: cx + offset.x, cy: cy + offset.y, r: moonRadiusPx })
		}
	}

	if (primary) {
		const ell = contactShadowDistance(primary.kind, eclipse.u, eclipse.gamma)
		const offset = moonDiskOffset(eventShadowCenterAngle(primary, eclipse.type), ell, scale, frameParallactic, resolved.orientationMode, eastSign)
		shapes.push({ kind: 'circle', role: 'moonDisk', event: primary.kind, cx: cx + offset.x, cy: cy + offset.y, r: moonRadiusPx })
	}

	// Horizon line on top of the disks, so the ground occludes the part of the diagram below it.
	if (resolved.includeHorizon && primary) {
		shapes.push(buildHorizonShapes(primary, resolved, cx, cy, scale, eastSign)[1])
	}

	return {
		width: resolved.width,
		height: resolved.height,
		orientationMode: resolved.orientationMode,
		requestedEvent: resolved.selectedEvent,
		selectedEvent: primary ? primary.kind : null,
		umbraRadiusPx: resolved.umbraRadiusPx,
		shapes,
	}
}

// Formats an SVG coordinate with two decimals, dropping trailing zeros.
function formatCoordinate(value: number) {
	return Number(value.toFixed(2)).toString()
}
