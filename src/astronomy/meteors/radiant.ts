import { PI, PIOVERTWO } from '../../core/constants'
import { deg, normalizeAngle } from '../../math/units/angle'
import { equatorialFromJ2000, equatorialToHorizontal } from '../coordinates/coordinate'
import { riseTransitSet, type RiseTransitSet } from '../events/horizon'
import { localSiderealTime, type GeographicPosition } from '../observer/location'
import { timeShift, timeSubtract, timeToDate, type Time } from '../time/time'
import { meteorSolarLongitude, meteorSolarLongitudeDelta, timeAtMeteorSolarLongitude } from './solar'
import type { MeteorComputationContext, MeteorRadiant, MeteorRadiantOptions, MeteorRadiantResult, MeteorShowerSolution, MeteorHorizontalRadiant, MeteorRadiantVisibility } from './types'

// Radiant evaluation in the catalog's geocentric equatorial J2000 frame and its local reductions.
// Drift is applied only with its declared unit basis, RA is wrapped after extrapolation, and a
// declination that crosses a pole is rejected because reflecting it would change the parameterization.

// Evaluates a shower solution's radiant at a context instant.
export function meteorRadiantJ2000(solution: MeteorShowerSolution, context: MeteorComputationContext, options: MeteorRadiantOptions = {}): MeteorRadiantResult | undefined {
	if (solution.rightAscension === undefined || solution.declination === undefined) return undefined
	const drift = solution.radiantDrift
	if (drift === undefined) return { radiant: { rightAscension: normalizeAngle(solution.rightAscension), declination: solution.declination }, extrapolated: false }
	if (solution.referenceSolarLongitude === undefined) return undefined

	let delta = 0
	let extrapolated = false
	if (drift.basis === 'solarLongitude') {
		delta = meteorSolarLongitudeDelta(context.solarLongitude, solution.referenceSolarLongitude)
		if (options.extrapolate === false && delta !== 0) return undefined
		const limit = options.maxExtrapolationSolarLongitude ?? PI
		if (Math.abs(delta) > limit) return undefined
		extrapolated = delta !== 0
	} else {
		const reference = nearestDailyDriftReference(solution.referenceSolarLongitude, context.time, options)
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

// Chooses the nearest annual occurrence of a daily-drift reference longitude, including the years
// on either side of the context year so a December reference remains near a following January date.
function nearestDailyDriftReference(referenceSolarLongitude: number, time: Time, options: MeteorRadiantOptions): Time {
	const [year] = timeToDate(time)
	let nearest = timeAtMeteorSolarLongitude(year - 1, referenceSolarLongitude, { ...options.solarLongitudeSearch, scale: time.scale })
	let smallestDistance = Math.abs(timeSubtract(time, nearest, time.scale))
	for (let candidateYear = year; candidateYear <= year + 1; candidateYear++) {
		const candidate = timeAtMeteorSolarLongitude(candidateYear, referenceSolarLongitude, { ...options.solarLongitudeSearch, scale: time.scale })
		const distance = Math.abs(timeSubtract(time, candidate, time.scale))
		if (distance < smallestDistance) {
			nearest = candidate
			smallestDistance = distance
		}
	}
	return nearest
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
	let unavailable = false
	const stop = timeShift(time, options.window ?? 1)
	const result = riseTransitSet(
		(current) => {
			const context: MeteorComputationContext = { time: current, solarLongitude: meteorSolarLongitude(current), localSiderealTime: localSiderealTime(current, observer) }
			const result = meteorRadiantJ2000(solution, context, options)
			if (result === undefined) {
				if (timeSubtract(current, time) >= 0 && timeSubtract(stop, current) >= 0) unavailable = true
				return [1, 0, 0]
			}
			return radiantVector(result.radiant)
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

function radiantVector(radiant: MeteorRadiant): readonly [number, number, number] {
	return meteorRadiantVector(radiant)
}

// Retain a named conversion helper for callers that already use this module's vocabulary.
export const meteorRadiantToOfDate = meteorRadiantOfDate

// Degree conversion is kept available for applications that build a drift from MDC documentation.
export const meteorRadiantDegrees = (rightAscension: number, declination: number): MeteorRadiant => ({ rightAscension: normalizeAngle(deg(rightAscension)), declination: deg(declination) })
