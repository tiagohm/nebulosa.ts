import { PIOVERTWO } from '../../core/constants'
import type { Angle } from '../../math/units/angle'
import { separationFrom, type PositionOverTime } from '../coordinates/astrometry'
import { airmassKastenYoung } from '../formulas'
import type { GeographicPosition } from '../observer/location'
import { type Time, timeSubtract } from '../time/time'
import { altitudeOf } from './horizon'
import { searchIntervals, type TimeSearchOptions } from './search'

// Intervals in which a target clears a set of observing constraints at once: a minimum altitude, a
// maximum Kasten–Young airmass, a maximum solar altitude, and minimum angular separations from the
// Sun and Moon. The target, Sun, and Moon use ICRS-oriented direction callbacks. No origin or
// correction-stage transformations are applied: callers choose matching origins and corrections,
// including topocentric parallax when desired. Each provider may reuse its own borrowed storage.
// Omitted constraints are not applied. A constraint naming the Sun or Moon without its callback is rejected,
// because dropping it would report the target as visible when that body was never checked.

// One stretch during which every requested constraint holds.
export interface VisibilityInterval {
	// First instant of the stretch.
	readonly start: Time
	// Last instant of the stretch.
	readonly end: Time
}

// Optional bodies and the root finder used to locate the crossings.
export interface VisibilitySources extends TimeSearchOptions {
	// J2000 direction of the Sun, required for solar altitude or separation limits.
	readonly sunAt?: PositionOverTime
	// J2000 direction of the Moon, required when minimumMoonSeparation is set.
	readonly moonAt?: PositionOverTime
}

// Limits the target must satisfy together. Angles are radians. Airmass is dimensionless.
export interface VisibilityConstraints {
	// Minimum geometric altitude of the target.
	readonly minimumAltitude?: Angle
	// Maximum Kasten–Young airmass of the target. Combined with minimumAltitude by keeping the stricter
	// altitude. An airmass below 1 cannot occur above the horizon and yields no windows.
	readonly maximumAirmass?: number
	// Maximum geometric altitude of the Sun.
	readonly maximumSunAltitude?: Angle
	// Minimum great-circle target-Sun separation in radians, at the supplied origin/correction stage.
	readonly minimumSunSeparation?: Angle
	// Minimum great-circle target-Moon separation in radians, at the supplied origin/correction stage.
	// Topocentric parallax is included when supplied by the providers; none is added here.
	readonly minimumMoonSeparation?: Angle
}

// Lowest altitude whose Kasten–Young airmass is at most maximumAirmass. Undefined when no altitude
// above the horizon is dark enough, including every request below airmass 1.
function altitudeForAirmass(maximumAirmass: number): Angle | undefined {
	if (!(maximumAirmass >= 1)) return undefined

	let low = 0
	let high = PIOVERTWO

	for (let i = 0; i < 64; i++) {
		const mid = (low + high) * 0.5
		if (airmassKastenYoung(mid) > maximumAirmass) low = mid
		else high = mid
	}

	return high
}

// Intervals in which a target satisfies requested altitude, airmass, solar altitude/avoidance and lunar limits.
// Parameters: targetAt is the J2000 direction of the target. location is the observer. start and end
// bound the search. constraints selects the limits; an empty constraint set makes the whole window
// one interval. sources supplies the Sun and the Moon and the root-finder step. Returns the
// chronological stretches inside the window. Each constraint is scanned independently; provider
// evaluations and scalar geometry are cached for one epoch. The coarse step must resolve every
// crossing of each constraint; no origin or correction-stage conversion is performed.
export function visibilityWindows(targetAt: PositionOverTime, location: GeographicPosition, start: Time, end: Time, constraints: VisibilityConstraints = {}, sources: VisibilitySources = {}): readonly VisibilityInterval[] {
	if (!(timeSubtract(end, start) > 0)) return []
	if ((constraints.maximumSunAltitude !== undefined || constraints.minimumSunSeparation !== undefined) && sources.sunAt === undefined) throw new RangeError('sun direction is required when a solar limit is set')
	if (constraints.minimumMoonSeparation !== undefined && sources.moonAt === undefined) throw new RangeError('moon direction is required when a lunar separation limit is set')

	let minimumAltitude = constraints.minimumAltitude
	if (constraints.maximumAirmass !== undefined) {
		const fromAirmass = altitudeForAirmass(constraints.maximumAirmass)
		if (fromAirmass === undefined) return []
		minimumAltitude = minimumAltitude === undefined ? fromAirmass : Math.max(minimumAltitude, fromAirmass)
	}

	const sunAt = sources.sunAt
	const moonAt = sources.moonAt
	const maximumSunAltitude = constraints.maximumSunAltitude
	const minimumMoonSeparation = constraints.minimumMoonSeparation
	const minimumSunSeparation = constraints.minimumSunSeparation
	const needsTarget = minimumAltitude !== undefined || minimumSunSeparation !== undefined || minimumMoonSeparation !== undefined
	const needsSun = maximumSunAltitude !== undefined || minimumSunSeparation !== undefined
	const targetAltitudeLimit = minimumAltitude
	let epoch = Number.NaN
	let targetAltitude = 0
	let solarAltitude = 0
	let solarSeparation = 0
	let lunarSeparation = 0

	// All provider calls are centralized here, so each borrowed vector remains valid until
	// its scalar geometry is computed. Cache only the current epoch, keeping memory bounded.
	const evaluate = (time: Time) => {
		const offset = timeSubtract(time, start)
		if (offset === epoch) return
		const target = needsTarget ? targetAt(time) : undefined
		const solar = needsSun ? sunAt?.(time) : undefined
		const lunar = minimumMoonSeparation !== undefined ? moonAt?.(time) : undefined
		if (targetAltitudeLimit !== undefined && target !== undefined) targetAltitude = altitudeOf(target, time, location)
		if (maximumSunAltitude !== undefined && solar !== undefined) solarAltitude = altitudeOf(solar, time, location)
		if (minimumSunSeparation !== undefined && target !== undefined && solar !== undefined) solarSeparation = separationFrom(target, solar)
		if (minimumMoonSeparation !== undefined && target !== undefined && lunar !== undefined) lunarSeparation = separationFrom(target, lunar)
		epoch = offset
	}

	const margins: ((time: Time) => number)[] = []
	if (targetAltitudeLimit !== undefined)
		margins.push((time) => {
			evaluate(time)
			return targetAltitude - targetAltitudeLimit
		})
	if (maximumSunAltitude !== undefined)
		margins.push((time) => {
			evaluate(time)
			return maximumSunAltitude - solarAltitude
		})
	if (minimumSunSeparation !== undefined)
		margins.push((time) => {
			evaluate(time)
			return solarSeparation - minimumSunSeparation
		})
	if (minimumMoonSeparation !== undefined)
		margins.push((time) => {
			evaluate(time)
			return lunarSeparation - minimumMoonSeparation
		})
	return searchIntervals(margins, start, end, sources)
}
