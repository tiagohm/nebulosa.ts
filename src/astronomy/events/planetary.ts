import { PIOVERTWO } from '../../core/constants'
import { validatePositiveFinite } from '../../core/validation'
import { type MutVec3, type Vec3, vecAngle, vecFill, vecLength, vecLongitude, vecZero } from '../../math/linear-algebra/vec3'
import { type Angle, normalizePI } from '../../math/units/angle'
import type { Distance } from '../../math/units/distance'
import type { PositionOverTime } from '../coordinates/astrometry'
import { ecliptic } from '../coordinates/frame'
import { type Time, timeShift } from '../time/time'
import { searchExtrema, searchRoots, type TimeSearchOptions } from './search'

// Planetary events from explicit observer-relative ICRS-oriented vectors. Angles are radians,
// ranges AU, and search steps days. Providers select geometric, astrometric, or apparent corrections;
// these finders add none. Each provider may reuse its own borrowed/read-only buffer;
// independent providers must not share mutable output storage.
// Coarse steps must resolve the events; extrema on window endpoints are excluded by searchExtrema.

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
export function planetaryConjunctions(targetAt: PositionOverTime, sunAt: PositionOverTime, start: Time, stop: Time, options: TimeSearchOptions = {}): PlanetaryElongationEvent[] {
	return elongationExtrema(targetAt, sunAt, start, stop, 'minimum', options)
}

// Finds outer-planet oppositions as separation maxima on the far side of quadrature (> PI/2).
// Providers share observer, base axes and correction stage. start/stop and options control the scan;
// returns chronological epochs and separations, which need not reach PI for inclined orbits.
export function planetaryOppositions(targetAt: PositionOverTime, sunAt: PositionOverTime, start: Time, stop: Time, options: TimeSearchOptions = {}): PlanetaryElongationEvent[] {
	return elongationExtrema(targetAt, sunAt, start, stop, 'maximum', options).filter((event) => event.elongation > PIOVERTWO)
}

// Finds 90-degree separation crossings inside start/stop; east/west uses a wrap-safe signed
// ecliptic longitude difference. Providers share observer, base axes and correction stage.
// Returns chronological records with the separation resolved at each refined root.
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
