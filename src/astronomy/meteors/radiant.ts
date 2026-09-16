import { PI, PIOVERTWO } from '../../core/constants'
import { brentMinimize } from '../../math/numerical/optimization'
import { deg, normalizeAngle } from '../../math/units/angle'
import { equatorialFromJ2000, equatorialToHorizontal } from '../coordinates/coordinate'
import { riseTransitSet, type RiseTransitSet } from '../events/horizon'
import { localSiderealTime, type GeographicPosition } from '../observer/location'
import { timeShift, timeSubtract, timeToDate, type Time } from '../time/time'
import { meteorSolarLongitude, meteorSolarLongitudeDelta, timeAtMeteorSolarLongitude } from './solar'
import type { MeteorComputationContext, MeteorHorizontalRadiant, MeteorRadiant, MeteorRadiantMaximumAltitude, MeteorRadiantMaximumAltitudeOptions, MeteorRadiantOptions, MeteorRadiantPathPoint, MeteorRadiantResult, MeteorRadiantVisibility, MeteorShowerSolution } from './types'

// Radiant evaluation in the catalog's geocentric equatorial J2000 frame and its local reductions.
// Drift is applied only with its declared unit basis, RA is wrapped after extrapolation, and a
// declination that crosses a pole is rejected because reflecting it would change the parameterization.

// Per-solution daily-drift caches retain the three adjacent occurrences for each calendar-year/search
// variant. Weak ownership follows catalog solutions and bounded entries prevent unbounded histories.
const DAILY_DRIFT_REFERENCE_CACHE = new WeakMap<MeteorShowerSolution, Map<string, readonly [Time, Time, Time]>>()
const DAILY_DRIFT_REFERENCE_CACHE_LIMIT = 6

// Evaluates a shower solution's radiant at a context instant.
export function meteorRadiantJ2000(solution: MeteorShowerSolution, context: MeteorComputationContext, options: MeteorRadiantOptions = {}): MeteorRadiantResult | undefined {
	if (solution.rightAscension === undefined || solution.declination === undefined) return undefined

	const drift = solution.radiantDrift
	if (drift === undefined) return { radiant: { rightAscension: normalizeAngle(solution.rightAscension), declination: solution.declination }, extrapolated: false }
	if (solution.referenceSolarLongitude === undefined) return undefined

	let delta = 0
	let extrapolated = false

	if (drift.basis === 'solarLongitude') {
		return meteorRadiantAtSolarLongitude(solution, context.solarLongitude, options)
	} else {
		const reference = nearestDailyDriftReference(solution, solution.referenceSolarLongitude, context.time, options)
		delta = timeSubtract(context.time, reference, context.time.scale)
		if (options.extrapolate === false && delta !== 0) return undefined
		const limit = options.maxExtrapolationDays ?? 366
		if (Math.abs(delta) > limit) return undefined
		extrapolated = delta !== 0
	}

	const rightAscension = normalizeAngle(solution.rightAscension + drift.rightAscensionRate * delta)
	const declination = solution.declination + drift.declinationRate * delta
	if (declination < -PIOVERTWO || declination > PIOVERTWO) return undefined
	return { radiant: { rightAscension, declination }, extrapolated }
}

// Samples a fixed or solar-longitude-drifting radiant over a forward circular interval. A daily
// drift needs an absolute year and is therefore rejected by this longitude-only API. The endpoint is
// included exactly when reached by a step or appended once when the final partial step remains.
export function meteorRadiantPath(solution: MeteorShowerSolution, startSolarLongitude: number, endSolarLongitude: number, step: number): readonly MeteorRadiantPathPoint[] {
	if (!(step > 0) || !Number.isFinite(step)) throw new Error('meteor radiant-path step must be finite and positive')
	if (solution.radiantDrift?.basis === 'day') throw new Error('daily radiant drift requires an absolute time interval')
	const width = normalizeAngle(endSolarLongitude - startSolarLongitude)
	const count = Math.floor(width / step)
	if (count > 1_000_000) throw new Error('meteor radiant path would contain too many points')
	const points: MeteorRadiantPathPoint[] = []
	const tolerance = Math.max(1e-12, step * 1e-12)

	for (let index = 0; index <= count; index++) {
		const offset = Math.min(width, index * step)
		const solarLongitude = normalizeAngle(startSolarLongitude + offset)
		const result = meteorRadiantAtSolarLongitude(solution, solarLongitude)
		if (result !== undefined) points.push({ ...result.radiant, solarLongitude })
	}

	if (width - count * step > tolerance) {
		const solarLongitude = normalizeAngle(endSolarLongitude)
		const result = meteorRadiantAtSolarLongitude(solution, solarLongitude)
		if (result !== undefined) points.push({ ...result.radiant, solarLongitude })
	}

	return points
}

// Finds the highest above-horizon radiant position in a bounded interval by coarse sampling followed
// by a bounded Brent refinement around the best sample. A wholly invisible or unavailable radiant
// returns undefined.
export function meteorRadiantMaximumAltitude(solution: MeteorShowerSolution, observer: GeographicPosition, start: Time, end: Time, options: MeteorRadiantMaximumAltitudeOptions = {}): MeteorRadiantMaximumAltitude | undefined {
	const duration = timeSubtract(end, start)
	if (!(duration >= 0)) return undefined
	const step = options.step ?? 1 / 24
	if (!(step > 0) || !Number.isFinite(step)) throw new Error('meteor radiant-altitude step must be finite and positive')
	const panels = Math.max(1, Math.ceil(duration / step))
	let bestIndex = 0
	let best: MeteorHorizontalRadiant | undefined

	const horizontalAt = (offset: number) => {
		const time = timeShift(start, offset)
		const solarLongitude = meteorSolarLongitude(time)
		const radiant = meteorRadiantJ2000(solution, { time, solarLongitude }, options)?.radiant
		return radiant === undefined ? undefined : meteorRadiantHorizontal(radiant, observer, time, { time, solarLongitude })
	}

	for (let index = 0; index <= panels; index++) {
		const horizontal = horizontalAt((duration * index) / panels)
		if (horizontal !== undefined && (best === undefined || horizontal.altitude > best.altitude)) {
			best = horizontal
			bestIndex = index
		}
	}

	if (best === undefined) return undefined

	if (duration > 0 && bestIndex > 0 && bestIndex < panels) {
		const left = (duration * (bestIndex - 1)) / panels
		const right = (duration * (bestIndex + 1)) / panels
		const refined = brentMinimize((offset) => -(horizontalAt(offset)?.altitude ?? -PIOVERTWO), left, right, { tolerance: options.tolerance ?? 1e-6 })
		const horizontal = horizontalAt(refined.minimum)
		if (horizontal !== undefined && horizontal.altitude > best.altitude) best = horizontal
	}

	return best.altitude > 0 ? { time: best.time, altitude: best.altitude, azimuth: best.azimuth } : undefined
}

// Evaluates the longitude-defined subset of radiant drift without duplicating its formula.
function meteorRadiantAtSolarLongitude(solution: MeteorShowerSolution, solarLongitude: number, options: MeteorRadiantOptions = {}): MeteorRadiantResult | undefined {
	if (solution.rightAscension === undefined || solution.declination === undefined) return undefined
	const drift = solution.radiantDrift
	if (drift === undefined) return { radiant: { rightAscension: normalizeAngle(solution.rightAscension), declination: solution.declination }, extrapolated: false }
	if (drift.basis !== 'solarLongitude' || solution.referenceSolarLongitude === undefined) return undefined
	const delta = meteorSolarLongitudeDelta(solarLongitude, solution.referenceSolarLongitude)
	if (options.extrapolate === false && delta !== 0) return undefined
	if (Math.abs(delta) > (options.maxExtrapolationSolarLongitude ?? PI)) return undefined
	const declination = solution.declination + drift.declinationRate * delta
	if (declination < -PIOVERTWO || declination > PIOVERTWO) return undefined

	return {
		radiant: { rightAscension: normalizeAngle(solution.rightAscension + drift.rightAscensionRate * delta), declination },
		extrapolated: delta !== 0,
	}
}

// Chooses the nearest annual occurrence of a daily-drift reference longitude, including the years
// on either side of the context year so a December reference remains near a following January date.
// A seven-day coarse scan is safe for the one monotonic annual solar-longitude root and avoids the
// general hourly event-search default before the result is cached.
function nearestDailyDriftReference(solution: MeteorShowerSolution, referenceSolarLongitude: number, time: Time, options: MeteorRadiantOptions): Time {
	const [year] = timeToDate(time)
	const key = dailyDriftReferenceKey(year, time, options)
	const cached = DAILY_DRIFT_REFERENCE_CACHE.get(solution)?.get(key)
	if (cached !== undefined) return nearestDailyDriftReferenceAt(time, cached)

	const search = { step: 7, ...options.solarLongitudeSearch, scale: time.scale }
	const references = [timeAtMeteorSolarLongitude(year - 1, referenceSolarLongitude, search), timeAtMeteorSolarLongitude(year, referenceSolarLongitude, search), timeAtMeteorSolarLongitude(year + 1, referenceSolarLongitude, search)] as const
	cacheDailyDriftReference(solution, key, references)
	return nearestDailyDriftReferenceAt(time, references)
}

// Selects the closest of one cached year-boundary triplet, allowing the reference to change at the
// midpoint between annual occurrences without repeating the solar inversion.
function nearestDailyDriftReferenceAt(time: Time, references: readonly [Time, Time, Time]): Time {
	let nearest = references[0]
	let smallestDistance = Math.abs(timeSubtract(time, nearest, time.scale))

	for (let index = 1; index < references.length; index++) {
		const candidate = references[index]
		const distance = Math.abs(timeSubtract(time, candidate, time.scale))

		if (distance < smallestDistance) {
			nearest = candidate
			smallestDistance = distance
		}
	}

	return nearest
}

// Builds a stable cache key for inputs that change the annual inversion result or its output scale.
function dailyDriftReferenceKey(year: number, time: Time, options: MeteorRadiantOptions): string {
	const search = options.solarLongitudeSearch
	return `${year}:${time.scale}:${search?.step ?? 7}:${search?.tolerance ?? 1e-6}`
}

// Stores one reference while evicting the oldest entry after the fixed per-solution capacity.
function cacheDailyDriftReference(solution: MeteorShowerSolution, key: string, references: readonly [Time, Time, Time]): void {
	let cache = DAILY_DRIFT_REFERENCE_CACHE.get(solution)

	if (cache === undefined) {
		cache = new Map()
		DAILY_DRIFT_REFERENCE_CACHE.set(solution, cache)
	}

	if (cache.size >= DAILY_DRIFT_REFERENCE_CACHE_LIMIT) {
		const oldest = cache.keys().next().value
		if (oldest !== undefined) cache.delete(oldest)
	}

	cache.set(key, references)
}

// Converts a J2000 geocentric radiant to the true equator/equinox of date.
export function meteorRadiantOfDate(radiant: MeteorRadiant, time: Time): MeteorRadiant {
	const [rightAscension, declination] = equatorialFromJ2000(radiant.rightAscension, radiant.declination, time)
	return { rightAscension: normalizeAngle(rightAscension), declination }
}

// Converts a J2000 radiant to local geometric horizontal coordinates. Refraction is intentionally
// absent; callers that need it must apply a named atmospheric reduction separately.
export function meteorRadiantHorizontal(radiant: MeteorRadiant, observer: GeographicPosition, time: Time, context?: MeteorComputationContext): MeteorHorizontalRadiant {
	const ofDate = meteorRadiantOfDate(radiant, time)
	const lst = context?.localSiderealTime ?? localSiderealTime(time, observer)
	const [azimuth, altitude] = equatorialToHorizontal(ofDate.rightAscension, ofDate.declination, observer.latitude, lst)
	return { ...radiant, rightAscension: normalizeAngle(radiant.rightAscension), rightAscensionOfDate: ofDate.rightAscension, declinationOfDate: ofDate.declination, azimuth, altitude, time }
}

// Computes rise, upper transit and set for a possibly drifting shower radiant over the requested
// window. The shared horizon finder classifies the full interval and is not replaced by a one-sample
// circumpolar test.
export function meteorRadiantRiseTransitSet(solution: MeteorShowerSolution, observer: GeographicPosition, time: Time, options: import('./types').MeteorRadiantRiseTransitSetOptions = {}): RiseTransitSet | undefined {
	if (solution.rightAscension === undefined || solution.declination === undefined) return undefined

	const stop = timeShift(time, options.window ?? 1)
	let unavailable = false

	const result = riseTransitSet(
		(current) => {
			const context: MeteorComputationContext = { time: current, solarLongitude: meteorSolarLongitude(current), localSiderealTime: localSiderealTime(current, observer) }
			const result = meteorRadiantJ2000(solution, context, options)
			if (result === undefined) {
				if (timeSubtract(current, time) >= 0 && timeSubtract(stop, current) >= 0) unavailable = true
				return [1, 0, 0]
			}
			return meteorRadiantVector(result.radiant)
		},
		observer,
		time,
		options,
	)

	return unavailable ? undefined : result
}

// Classifies a complete rise/transit/set result without treating a single sample as circumpolar.
export function meteorRadiantVisibility(result: RiseTransitSet | undefined): MeteorRadiantVisibility {
	if (result === undefined) return 'unknown'
	if (result.alwaysUp) return 'alwaysUp'
	if (result.alwaysDown) return 'alwaysDown'
	if (result.rise !== undefined && result.set !== undefined) return 'risesAndSets'
	if (result.rise !== undefined) return 'risesOnly'
	if (result.set !== undefined) return 'setsOnly'
	return 'unknown'
}

// Converts a radiant into a unit Cartesian J2000 direction.
export function meteorRadiantVector(radiant: MeteorRadiant): readonly [number, number, number] {
	const rightAscension = normalizeAngle(radiant.rightAscension)
	const cosDeclination = Math.cos(radiant.declination)
	return [cosDeclination * Math.cos(rightAscension), cosDeclination * Math.sin(rightAscension), Math.sin(radiant.declination)]
}

// Degree conversion is kept available for applications that build a drift from MDC documentation.
export function meteorRadiantDegrees(rightAscension: number, declination: number): MeteorRadiant {
	return { rightAscension: normalizeAngle(deg(rightAscension)), declination: deg(declination) }
}
