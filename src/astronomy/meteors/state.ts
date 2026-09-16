import { vecAngle } from '../../math/linear-algebra/vec3'
import { altitudeOf } from '../events/horizon'
import { type GeographicPosition, localSiderealTime } from '../observer/location'
import type { Time } from '../time/time'
import { isMeteorShowerActive, meteorActivityMaximumSolarLongitude, meteorActivityZhr } from './activity'
import { meteorMoonDirection, meteorMoonIllumination, meteorSunDirection } from './observation'
import { meteorRadiantHorizontal, meteorRadiantJ2000, meteorRadiantOfDate, meteorRadiantVector } from './radiant'
import { meteorSolarLongitude } from './solar'
import type { MeteorShowerComputationContext, MeteorShowerSolution, MeteorShowerState, MeteorShowerStateOptions } from './types'

// High-level instantaneous meteor-shower states. A prepared context owns all shared solar, lunar and
// observer work for one instant; batch evaluation allocates only per-solution result objects and does
// not retain global or persistent state.

// Prepares solar longitude and the optional observer/ephemeris values used by one or many shower
// states. Sun and Moon vectors are evaluated only when their corresponding result groups are enabled.
export function meteorShowerComputationContext(time: Time, observer?: GeographicPosition, options: MeteorShowerStateOptions = {}): MeteorShowerComputationContext {
	return completeContext({ time, solarLongitude: meteorSolarLongitude(time), observer }, options)
}

// Computes one shower solution at a prepared instant. The function does not mutate the supplied
// context; missing shared values are completed in a short-lived copy according to the options.
export function meteorShowerState(solution: MeteorShowerSolution, context: MeteorShowerComputationContext, options: MeteorShowerStateOptions = {}): MeteorShowerState {
	return stateFromCompleteContext(solution, completeContext(context, options), options, profileMaximumZhr(options))
}

// Computes several shower solutions while sharing solar longitude, LST, Sun and Moon evaluations.
export function meteorShowerStates(solutions: readonly MeteorShowerSolution[], context: MeteorShowerComputationContext, options: MeteorShowerStateOptions = {}): readonly MeteorShowerState[] {
	const complete = completeContext(context, options)
	const maximumZhr = profileMaximumZhr(options)
	return solutions.map((solution) => stateFromCompleteContext(solution, complete, options, maximumZhr))
}

// Adds only the common values selected by options, preserving caller-supplied ephemerides.
function completeContext(context: MeteorShowerComputationContext, options: MeteorShowerStateOptions): MeteorShowerComputationContext {
	const observer = context.observer
	const includeHorizontal = options.includeHorizontal ?? observer !== undefined
	const includeMoon = options.includeMoon ?? true
	const includeSun = options.includeSun ?? observer !== undefined
	const needsSun = includeSun || includeMoon
	return {
		...context,
		localSiderealTime: context.localSiderealTime ?? (observer !== undefined && includeHorizontal ? localSiderealTime(context.time, observer) : undefined),
		sun: context.sun ?? (needsSun ? meteorSunDirection(context.time) : undefined),
		moon: context.moon ?? (includeMoon ? meteorMoonDirection(context.time) : undefined),
	}
}

// Builds one state from a context whose selected common values have already been prepared.
function stateFromCompleteContext(solution: MeteorShowerSolution, context: MeteorShowerComputationContext, options: MeteorShowerStateOptions, maximumZhr: number | undefined): MeteorShowerState {
	const profile = options.profile
	const includeActivity = options.includeActivity ?? profile !== undefined
	const profileActive = profile === undefined || !includeActivity ? true : isProfileActive(profile, context.solarLongitude)
	const catalogActive = isMeteorShowerActive(solution.activityInterval, context.solarLongitude) ?? true
	const active = catalogActive && profileActive
	const radiantJ2000 = meteorRadiantJ2000(solution, context, options)?.radiant
	const observer = context.observer
	const includeHorizontal = options.includeHorizontal ?? observer !== undefined
	const includeMoon = options.includeMoon ?? true
	const includeSun = options.includeSun ?? observer !== undefined
	const horizontal = radiantJ2000 !== undefined && observer !== undefined && includeHorizontal ? meteorRadiantHorizontal(radiantJ2000, observer, context.time, context) : undefined
	const radiantOfDate = radiantJ2000 !== undefined && (options.includeRadiantOfDate ?? true) ? meteorRadiantOfDate(radiantJ2000, context.time) : undefined
	const moonAltitude = includeMoon && context.moon !== undefined && observer !== undefined ? altitudeOf(context.moon, context.time, observer) : undefined
	const moonSeparation = includeMoon && context.moon !== undefined && radiantJ2000 !== undefined ? vecAngle(context.moon, meteorRadiantVector(radiantJ2000)) : undefined
	const moonIllumination = includeMoon && context.moon !== undefined && context.sun !== undefined ? meteorMoonIllumination(context.sun, context.moon) : undefined
	const sunAltitude = includeSun && context.sun !== undefined && observer !== undefined ? altitudeOf(context.sun, context.time, observer) : undefined
	const zhr = profile === undefined || !includeActivity ? undefined : meteorActivityZhr(profile, context.solarLongitude)
	const activityFraction = zhr === undefined ? undefined : !(maximumZhr !== undefined && maximumZhr > 0) || !Number.isFinite(zhr) ? 0 : Math.min(1, Math.max(0, zhr / maximumZhr))

	return {
		solution,
		solarLongitude: context.solarLongitude,
		active,
		activityFraction,
		zhr,
		radiantJ2000,
		radiantOfDate,
		horizontal,
		moonSeparation,
		moonAltitude,
		moonIllumination,
		sunAltitude,
	}
}

// Tests profile support without performing the independent global-maximum search needed by phase.
function isProfileActive(profile: NonNullable<MeteorShowerStateOptions['profile']>, solarLongitude: number): boolean {
	if (profile.type !== 'multiPeak') return isMeteorShowerActive(profile.support, solarLongitude) ?? false
	return profile.components.some((component) => isMeteorShowerActive(component.support, solarLongitude) === true)
}

// Resolves a reusable finite global peak for relative activity, honoring an explicitly prepared value.
function profileMaximumZhr(options: MeteorShowerStateOptions): number | undefined {
	if (options.activityMaximumZhr !== undefined) return options.activityMaximumZhr
	if (options.profile === undefined || options.includeActivity === false) return undefined
	const maximum = meteorActivityMaximumSolarLongitude(options.profile)
	return maximum === undefined ? undefined : meteorActivityZhr(options.profile, maximum)
}
