import { PI, PIOVERTWO } from '../../core/constants'
import { validatePositiveFinite } from '../../core/validation'
import { type MutVec3, type Vec3, vecAngle, vecFill, vecLatitude, vecLength, vecLongitude, vecMinus, vecNegate, vecZero } from '../../math/linear-algebra/vec3'
import { type Angle, normalizePI } from '../../math/units/angle'
import type { Distance } from '../../math/units/distance'
import { type Planet, planetMagnitude, type PlanetMagnitudeOptions } from '../bodies/photometry'
import type { PositionOverTime } from '../coordinates/astrometry'
import { ecliptic } from '../coordinates/frame'
import { type Time, timeShift } from '../time/time'
import { searchExtrema, searchRoots, type TimeSearchOptions } from './search'

// Planetary events from explicit observer-relative ICRS-oriented vectors. Angles are radians,
// ranges AU, and search steps days. Providers select geometric, astrometric, or apparent corrections;
// these finders add none. Each provider may reuse its own borrowed/read-only buffer;
// independent providers must not share mutable output storage.
// Coarse steps must resolve the events; extrema on window endpoints are excluded by searchExtrema.
//
// Two families of conditions live here and are never interchangeable. The separation finders
// (planetaryConjunctions, planetaryInnerConjunctions, planetaryOppositions, planetaryQuadratures)
// locate extrema or 90-degree crossings of the great-circle angle between two directions. The
// longitude finders (planetaryLongitudeConjunctions, planetaryLongitudeOppositions,
// planetaryLongitudeQuadratures) locate the almanac conditions on the difference of true ecliptic
// longitudes of date, and planetaryAppulses the least separation of any two bodies. For an inclined
// orbit a longitude conjunction and the separation minimum occur at different instants.

// Resolved solar elongation event.
export interface PlanetaryElongationEvent {
	// Epoch at the refined extremum or crossing.
	readonly time: Time
	// Unsigned target-Sun separation in radians, in [0, PI].
	readonly elongation: Angle
}

// Elongation maximum or quadrature, labelled by signed ecliptic longitude relative to the Sun.
export interface PlanetaryDirectionalEvent extends PlanetaryElongationEvent {
	// East (positive longitude difference) or west of the Sun, across the 0/TAU seam.
	readonly kind: 'east' | 'west'
}

// Inner-planet conjunction classification relative to the supplied observer.
export interface PlanetaryConjunction extends PlanetaryElongationEvent {
	// Inferior when target range is smaller than Sun range; superior otherwise.
	readonly kind: 'inferior' | 'superior'
}

// Direct/retrograde transition in true ecliptic longitude of date.
export interface PlanetaryStation {
	// Epoch at which the centered longitude derivative vanishes.
	readonly time: Time
	// Motion before and after the root; tangential zero rates are not transitions.
	readonly kind: 'directToRetrograde' | 'retrogradeToDirect'
	// Signed ecliptic longitude at the station, radians in (-PI, PI].
	readonly longitude: Angle
}

// Station-specific derivative controls, in addition to the normal scan/refinement options.
export interface PlanetaryStationOptions extends TimeSearchOptions {
	// Centered derivative half-step in days, positive and finite; defaults to 0.5 day.
	// Providers must cover the window extended by twice this step; longitude motion across
	// twice this step must be less than PI. Reduce it when greater station timing precision is needed.
	readonly derivativeHalfStep?: number
}

// A local minimum of the observer-target range.
export interface PlanetaryClosestApproach {
	// Epoch of the refined range minimum.
	readonly time: Time
	// Observer-target distance in AU.
	readonly distance: Distance
}

// Copies borrowed target and Sun vectors into the supplied reusable workspaces without mutating them.
function directionsAt(targetAt: PositionOverTime, sunAt: PositionOverTime, time: Time, target: MutVec3, solar: MutVec3) {
	const p = targetAt(time)
	vecFill(target, p[0], p[1], p[2])
	const s = sunAt(time)
	vecFill(solar, s[0], s[1], s[2])
}

// Resolves east/west from the shortest signed longitude difference in the ecliptic of date.
function directionKind(target: Vec3, solar: Vec3, time: Time): 'east' | 'west' {
	const out = vecZero()
	const longitude = vecLongitude(ecliptic(target, time, out))
	return normalizePI(longitude - vecLongitude(ecliptic(solar, time, out))) > 0 ? 'east' : 'west'
}

// Finds the chosen extrema of target-Sun separation inside start/stop with caller-controlled options.
function elongationExtrema(targetAt: PositionOverTime, sunAt: PositionOverTime, start: Time, stop: Time, kind: 'minimum' | 'maximum', options: TimeSearchOptions): PlanetaryElongationEvent[] {
	const target = vecZero()
	const solar = vecZero()
	const events: PlanetaryElongationEvent[] = []
	const angleAt = (time: Time) => {
		directionsAt(targetAt, sunAt, time, target, solar)
		return vecAngle(target, solar)
	}
	for (const extremum of searchExtrema(angleAt, start, stop, options)) if (extremum.kind === kind) events.push({ time: extremum.time, elongation: extremum.value })
	return events
}

// Finds direct/retrograde transitions over start/stop in true ecliptic longitude of date, avoiding
// the RA pole. targetAt supplies observer-relative base-frame vectors. The centered derivative takes
// normalizePI(after-before)/(2*halfStep), and searchRoots refines its sign changes. Rates on either
// side classify each transition; tangencies are omitted. Allocates event records and reuses workspace.
export function planetaryStations(targetAt: PositionOverTime, start: Time, stop: Time, { derivativeHalfStep = 0.5, ...options }: PlanetaryStationOptions = {}): PlanetaryStation[] {
	// A zero half-step gives a constant NaN rate and silently hides every station.
	validatePositiveFinite(derivativeHalfStep)

	const out = vecZero()
	const longitudeAt = (time: Time) => vecLongitude(ecliptic(targetAt(time), time, out))
	const rateAt = (time: Time) => {
		const before = longitudeAt(timeShift(time, -derivativeHalfStep))
		const after = longitudeAt(timeShift(time, derivativeHalfStep))
		return normalizePI(after - before) / (2 * derivativeHalfStep)
	}

	const events: PlanetaryStation[] = []
	for (const time of searchRoots(rateAt, start, stop, options)) {
		const before = rateAt(timeShift(time, -derivativeHalfStep))
		const after = rateAt(timeShift(time, derivativeHalfStep))
		if (before > 0 && after < 0) events.push({ time, kind: 'directToRetrograde', longitude: normalizePI(longitudeAt(time)) })
		else if (before < 0 && after > 0) events.push({ time, kind: 'retrogradeToDirect', longitude: normalizePI(longitudeAt(time)) })
	}

	return events
}

// Finds elongation maxima inside start/stop and labels east/west of the Sun. Intended for inner
// planets; targetAt and sunAt share observer, inertial basis, and correction stage. No synodic span
// is selected. Returns chronological records without mutating either provider's borrowed storage.
export function planetaryGreatestElongations(targetAt: PositionOverTime, sunAt: PositionOverTime, start: Time, stop: Time, options: TimeSearchOptions = {}): PlanetaryDirectionalEvent[] {
	return elongationExtrema(targetAt, sunAt, start, stop, 'maximum', options).map((event) => {
		const { time, elongation } = event
		return { time, elongation, kind: directionKind(targetAt(time), sunAt(time), time) }
	})
}

// Finds conjunctions as local separation minima within start/stop. Providers share observer, base
// axes and correction stage. Returns chronological times and actual separations (not assumed zero).
// This is separation geometry; the almanac's longitude conjunction is planetaryLongitudeConjunctions.
export function planetaryConjunctions(targetAt: PositionOverTime, sunAt: PositionOverTime, start: Time, stop: Time, options: TimeSearchOptions = {}): PlanetaryElongationEvent[] {
	return elongationExtrema(targetAt, sunAt, start, stop, 'minimum', options)
}

// Finds outer-planet oppositions as separation maxima on the far side of quadrature (> PI/2).
// Providers share observer, base axes and correction stage. start/stop and options control the scan;
// returns chronological epochs and separations, which need not reach PI for inclined orbits.
// This is separation geometry; the almanac's longitude opposition is planetaryLongitudeOppositions.
export function planetaryOppositions(targetAt: PositionOverTime, sunAt: PositionOverTime, start: Time, stop: Time, options: TimeSearchOptions = {}): PlanetaryElongationEvent[] {
	return elongationExtrema(targetAt, sunAt, start, stop, 'maximum', options).filter((event) => event.elongation > PIOVERTWO)
}

// Finds 90-degree separation crossings inside start/stop; east/west uses a wrap-safe signed
// ecliptic longitude difference. Providers share observer, base axes and correction stage.
// Returns chronological records with the separation resolved at each refined root.
// This is separation geometry; the almanac's longitude quadrature is planetaryLongitudeQuadratures.
export function planetaryQuadratures(targetAt: PositionOverTime, sunAt: PositionOverTime, start: Time, stop: Time, options: TimeSearchOptions = {}): PlanetaryDirectionalEvent[] {
	const target = vecZero()
	const solar = vecZero()
	const elongationAt = (time: Time) => {
		directionsAt(targetAt, sunAt, time, target, solar)
		return vecAngle(target, solar)
	}
	return searchRoots((time) => elongationAt(time) - PIOVERTWO, start, stop, options).map((time) => {
		const elongation = elongationAt(time)
		return { time, elongation, kind: directionKind(target, solar, time) }
	})
}

// Classifies conjunction minima as inferior/superior by comparing target and Sun ranges in AU at
// the same epoch. Meaningful for an inner planet only when the supplied observer's geometry admits
// that classification. Does not assume a 1 AU Sun range. start/stop and options control the search.
export function planetaryInnerConjunctions(targetAt: PositionOverTime, sunAt: PositionOverTime, start: Time, stop: Time, options: TimeSearchOptions = {}): PlanetaryConjunction[] {
	return planetaryConjunctions(targetAt, sunAt, start, stop, options).map((event) => {
		const { time, elongation } = event
		return { time, elongation, kind: vecLength(targetAt(time)) < vecLength(sunAt(time)) ? 'inferior' : 'superior' }
	})
}

// Finds local observer-target distance minima inside start/stop using searchExtrema and options.
// targetAt returns base-frame positions in AU; results are chronological and allocate records.
// Physical diameter and angular diameter are separate caller calculations.
export function planetaryClosestApproaches(targetAt: PositionOverTime, start: Time, stop: Time, options: TimeSearchOptions = {}): PlanetaryClosestApproach[] {
	return searchExtrema((time) => vecLength(targetAt(time)), start, stop, options)
		.filter((event) => event.kind === 'minimum')
		.map((event) => ({ time: event.time, distance: event.value }))
}

// Longitude-defined alignment of a target with a reference body, in the true ecliptic of date.
export interface PlanetaryLongitudeCrossing {
	// Epoch of the refined root.
	readonly time: Time
	// Wrapped longitude difference, target minus reference, radians in (-PI, PI]; equals the requested
	// offset up to the refinement tolerance.
	readonly longitudeDifference: Angle
	// Great-circle separation of the two directions at the root, radians in [0, PI]; not zero for an
	// inclined orbit, and never assumed to be.
	readonly separation: Angle
	// Ecliptic latitude difference, target minus reference, radians; positive when the target is north.
	readonly latitudeDifference: Angle
}

// Longitude conjunction (equal longitudes) labelled by line-of-sight ordering.
export interface PlanetaryLongitudeConjunction extends PlanetaryLongitudeCrossing {
	// Inferior when the target range is smaller than the reference range at the root; superior otherwise.
	readonly kind: 'inferior' | 'superior'
}

// Longitude quadrature (difference of +PI/2 or -PI/2) labelled by side.
export interface PlanetaryLongitudeQuadrature extends PlanetaryLongitudeCrossing {
	// East when the target longitude exceeds the reference longitude by PI/2; west at -PI/2.
	readonly kind: 'east' | 'west'
}

// A local minimum of the great-circle separation of two bodies.
export interface PlanetaryAppulse {
	// Epoch of the refined minimum.
	readonly time: Time
	// Least separation of the two directions, radians in [0, PI].
	readonly separation: Angle
}

// A crossing of a chosen illuminated fraction of the disk seen by the observer.
export interface PlanetaryIlluminationCrossing {
	// Epoch of the refined root.
	readonly time: Time
	// Whether the illuminated fraction grows or shrinks through the crossing.
	readonly kind: 'increasing' | 'decreasing'
	// Sun-target-observer phase angle at the root, radians in [0, PI].
	readonly phaseAngle: Angle
}

// A local minimum of modelled apparent visual magnitude (a brightness maximum).
export interface PlanetaryBrightnessMaximum {
	// Epoch of the refined minimum.
	readonly time: Time
	// Apparent visual magnitude from planetMagnitude at the minimum.
	readonly magnitude: number
	// Sun-target-observer phase angle at the minimum, radians in [0, PI].
	readonly phaseAngle: Angle
}

// Half-step, in days, of the residual samples that classify an illumination crossing: 0.01 day keeps
// the samples well inside one coarse step of any planetary search while the illuminated fraction of
// Mercury or Venus changes by more than 1e-5 across them.
const ILLUMINATION_CLASSIFICATION_HALF_STEP = 0.01

// Longitude crossing record at an epoch, from copies of both borrowed vectors.
function longitudeCrossingAt(targetAt: PositionOverTime, referenceAt: PositionOverTime, time: Time): PlanetaryLongitudeCrossing {
	const target = vecZero()
	const reference = vecZero()
	directionsAt(targetAt, referenceAt, time, target, reference)
	const t = ecliptic(target, time, vecZero())
	const r = ecliptic(reference, time, vecZero())
	return { time, longitudeDifference: normalizePI(vecLongitude(t) - vecLongitude(r)), separation: vecAngle(target, reference), latitudeDifference: vecLatitude(t) - vecLatitude(r) }
}

// Every root of sin(longitudeDifference - offset) in start/stop: the epochs where the true-ecliptic
// longitude difference equals offset or offset + PI. The sine is continuous across the 0/TAU seam, so
// no wrap creates or hides a root, and its slope at a root is +/-1 times the relative longitude rate.
function longitudeRoots(targetAt: PositionOverTime, referenceAt: PositionOverTime, start: Time, stop: Time, offset: Angle, options: TimeSearchOptions): PlanetaryLongitudeCrossing[] {
	const target = vecZero()
	const reference = vecZero()
	const out = vecZero()
	const residualAt = (time: Time) => {
		directionsAt(targetAt, referenceAt, time, target, reference)
		const lambda = vecLongitude(ecliptic(target, time, out))
		return Math.sin(lambda - vecLongitude(ecliptic(reference, time, out)) - offset)
	}
	return searchRoots(residualAt, start, stop, options).map((time) => longitudeCrossingAt(targetAt, referenceAt, time))
}

// Finds the epochs in start/stop where the true ecliptic longitude of date of the target minus that of
// the reference equals offset (radians, any value; taken modulo TAU). Both providers return
// observer-relative ICRS-oriented vectors sharing observer, axes and correction stage; the finder
// rotates them with precession-nutation and the true obliquity (ecliptic). It solves the continuous
// sin(difference - offset) and keeps the roots where cos(difference - offset) > 0, so the opposite
// alignment is rejected and the 0/TAU seam is harmless. The coarse step must be shorter than half the
// time the relative longitude takes to advance PI; a tangential touch without a sign change is
// omitted. Returns chronological records with the measured separation and latitude difference.
export function planetaryLongitudeCrossings(targetAt: PositionOverTime, referenceAt: PositionOverTime, start: Time, stop: Time, offset: Angle, options: TimeSearchOptions = {}): PlanetaryLongitudeCrossing[] {
	return longitudeRoots(targetAt, referenceAt, start, stop, offset, options).filter((event) => Math.cos(event.longitudeDifference - offset) > 0)
}

// Finds longitude conjunctions (equal true ecliptic longitudes of date) of a target with a reference
// in start/stop, the almanac definition of conjunction. The kind compares the two provider ranges (AU)
// at the root, so it is meaningful when the reference is the Sun and the target an inner planet; a
// pair of planets may ignore it. Separation at the root is reported, not assumed zero.
export function planetaryLongitudeConjunctions(targetAt: PositionOverTime, referenceAt: PositionOverTime, start: Time, stop: Time, options: TimeSearchOptions = {}): PlanetaryLongitudeConjunction[] {
	return planetaryLongitudeCrossings(targetAt, referenceAt, start, stop, 0, options).map(({ time, longitudeDifference, separation, latitudeDifference }) => ({ time, longitudeDifference, separation, latitudeDifference, kind: vecLength(targetAt(time)) < vecLength(referenceAt(time)) ? 'inferior' : 'superior' }))
}

// Finds longitude oppositions (true ecliptic longitudes of date differing by PI) of a target with a
// reference in start/stop, the almanac definition of opposition to the Sun. The separation at the root
// is reported and need not reach PI for an inclined orbit.
export function planetaryLongitudeOppositions(targetAt: PositionOverTime, referenceAt: PositionOverTime, start: Time, stop: Time, options: TimeSearchOptions = {}): PlanetaryLongitudeCrossing[] {
	return planetaryLongitudeCrossings(targetAt, referenceAt, start, stop, PI, options)
}

// Finds longitude quadratures (true ecliptic longitudes of date differing by +PI/2 or -PI/2) of a
// target with a reference in start/stop, the almanac definition of quadrature with the Sun. East is a
// difference of +PI/2 (target east of the reference), west -PI/2. Both are roots of one continuous
// residual, so a single scan finds both sides chronologically.
export function planetaryLongitudeQuadratures(targetAt: PositionOverTime, referenceAt: PositionOverTime, start: Time, stop: Time, options: TimeSearchOptions = {}): PlanetaryLongitudeQuadrature[] {
	return longitudeRoots(targetAt, referenceAt, start, stop, PIOVERTWO, options).map(({ time, longitudeDifference, separation, latitudeDifference }) => ({ time, longitudeDifference, separation, latitudeDifference, kind: longitudeDifference > 0 ? 'east' : 'west' }))
}

// Finds appulses, the local minima of the great-circle separation of two bodies, in start/stop. The
// providers share observer, axes and correction stage and are evaluated at the same epoch. Unlike a
// longitude conjunction this is the least angular distance, whatever the longitudes; minima on the
// window endpoints and minima flatter than one coarse step are not detected. Swapping the providers
// gives the same epochs.
export function planetaryAppulses(firstAt: PositionOverTime, secondAt: PositionOverTime, start: Time, stop: Time, options: TimeSearchOptions = {}): PlanetaryAppulse[] {
	return elongationExtrema(firstAt, secondAt, start, stop, 'minimum', options).map((event) => ({ time: event.time, separation: event.elongation }))
}

// Finds the epochs in start/stop where the illuminated fraction (1 + cos i) / 2 of the target disk seen
// by the observer crosses fraction (0..1), i the Sun-target-observer phase angle from the provider
// vectors (observer-relative target and Sun, same axes and stage; use geometric or light-time vectors
// consistently). Each root is classified by the residual 0.01 day either side; a tangential touch is
// omitted. fraction 0.5 gives the dichotomy of Mercury or Venus, which need not coincide with the
// greatest elongation.
export function planetaryIlluminationCrossings(targetAt: PositionOverTime, sunAt: PositionOverTime, start: Time, stop: Time, fraction: number, options: TimeSearchOptions = {}): PlanetaryIlluminationCrossing[] {
	const target = vecZero()
	const solar = vecZero()
	const toSun = vecZero()
	const toObserver = vecZero()
	const phaseAt = (time: Time) => {
		directionsAt(targetAt, sunAt, time, target, solar)
		return vecAngle(vecNegate(target, toObserver), vecMinus(solar, target, toSun))
	}
	const residualAt = (time: Time) => (1 + Math.cos(phaseAt(time))) / 2 - fraction

	const events: PlanetaryIlluminationCrossing[] = []
	for (const time of searchRoots(residualAt, start, stop, options)) {
		const before = residualAt(timeShift(time, -ILLUMINATION_CLASSIFICATION_HALF_STEP))
		const after = residualAt(timeShift(time, ILLUMINATION_CLASSIFICATION_HALF_STEP))
		if (before < 0 && after > 0) events.push({ time, kind: 'increasing', phaseAngle: phaseAt(time) })
		else if (before > 0 && after < 0) events.push({ time, kind: 'decreasing', phaseAngle: phaseAt(time) })
	}
	return events
}

// Finds the local minima of the modelled apparent visual magnitude of planet (planetMagnitude, Mallama
// and Hilton 2018) in start/stop: every brightness maximum of the model, including any the photometric
// polynomials produce near a conjunction, which the caller may exclude by phase angle. targetAt and
// sunAt return observer-relative vectors in AU (geometric or light-time, used consistently), from which
// the Sun-planet vector is their difference. Where the model is undefined (NaN) no coarse triple
// brackets an extremum, and a refinement that ends on an undefined value is dropped, so NaN never
// becomes an event. magnitude passes the model options (Neptune's year, Saturn's rings).
export function planetaryBrightnessMaxima(planet: Planet, targetAt: PositionOverTime, sunAt: PositionOverTime, start: Time, stop: Time, options: TimeSearchOptions = {}, magnitude: PlanetMagnitudeOptions = {}): PlanetaryBrightnessMaximum[] {
	const target = vecZero()
	const solar = vecZero()
	const sunToTarget = vecZero()
	const toObserver = vecZero()
	const magnitudeAt = (time: Time) => {
		directionsAt(targetAt, sunAt, time, target, solar)
		return planetMagnitude(planet, vecMinus(target, solar, sunToTarget), target, magnitude)
	}

	const events: PlanetaryBrightnessMaximum[] = []
	for (const extremum of searchExtrema(magnitudeAt, start, stop, options)) {
		if (extremum.kind !== 'minimum' || !Number.isFinite(extremum.value)) continue
		directionsAt(targetAt, sunAt, extremum.time, target, solar)
		const phaseAngle = vecAngle(vecNegate(target, toObserver), vecMinus(solar, target, sunToTarget))
		events.push({ time: extremum.time, magnitude: extremum.value, phaseAngle })
	}
	return events
}
