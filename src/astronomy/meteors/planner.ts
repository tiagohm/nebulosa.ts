import { deg } from '../../math/units/angle'
import { searchExtrema, searchRoots } from '../events/search'
import type { GeographicPosition } from '../observer/location'
import { type Time, timeShift, timeSubtract } from '../time/time'
import { meteorActivityZhr, isMeteorShowerActive } from './activity'
import { meteorObservingConditions, meteorLocalHourlyRate } from './observation'
import { meteorRadiantJ2000 } from './radiant'
import { meteorSolarLongitude } from './solar'
import type { MeteorActivityProfile, MeteorComputationContext, MeteorObservingConditions, MeteorObservingWindow, MeteorObservingWindowOptions, MeteorShowerSolution, MeteorSolarLongitudeInterval, MeteorVisualObservation } from './types'

// Local observing-window planner. It intersects catalog/profile support, solar darkness, radiant
// altitude and opt-in lunar constraints, refines every detected boundary, evaluates endpoints and
// orders surviving windows by integrated expected local count. All returned lunar values are tied to
// their best-time instant through the condition object used during evaluation.

// Plans observing windows for one shower, one explicit activity profile and one observer.
export function meteorObservingWindows(solution: MeteorShowerSolution, profile: MeteorActivityProfile, observer: GeographicPosition, start: Time, end: Time, options?: MeteorObservingWindowOptions): readonly MeteorObservingWindow[]
// Equivalent argument order for applications that naturally select a profile first.
export function meteorObservingWindows(profile: MeteorActivityProfile, solution: MeteorShowerSolution, observer: GeographicPosition, start: Time, end: Time, options?: MeteorObservingWindowOptions): readonly MeteorObservingWindow[]
export function meteorObservingWindows(first: MeteorShowerSolution | MeteorActivityProfile, second: MeteorActivityProfile | MeteorShowerSolution, observer: GeographicPosition, start: Time, end: Time, options: MeteorObservingWindowOptions = {}): readonly MeteorObservingWindow[] {
	const solution = isSolution(first) ? first : (second as MeteorShowerSolution)
	const profile = isSolution(first) ? (second as MeteorActivityProfile) : first
	const duration = timeSubtract(end, start)
	if (!(duration > 0)) return []
	const step = chooseStep(profile, solution.activityInterval, options.step)
	const qualifies = (time: Time) => scoreAt(solution, profile, observer, time, options) >= 0
	const score = (time: Time) => scoreAt(solution, profile, observer, time, options)
	const boundaries: Time[] = [start, end]
	for (const root of searchRoots(score, start, end, { step, tolerance: options.tolerance })) boundaries.push(root)
	for (const extremum of searchExtrema(score, start, end, { step, tolerance: options.tolerance })) {
		const before = timeShift(extremum.time, -step)
		const after = timeShift(extremum.time, step)
		if (timeSubtract(before, start) > 0) addRootIfBracketed(boundaries, score, before, extremum.time, options.tolerance)
		if (timeSubtract(end, after) > 0) addRootIfBracketed(boundaries, score, extremum.time, after, options.tolerance)
	}

	boundaries.sort((a, b) => timeSubtract(a, b))
	const unique: Time[] = []
	for (const boundary of boundaries) if (unique.length === 0 || timeSubtract(boundary, unique.at(-1)!) > 1e-8) unique.push(boundary)
	const windows: MeteorObservingWindow[] = []
	for (let i = 0; i + 1 < unique.length; i++) {
		const left = unique[i]
		const right = unique[i + 1]
		if (!qualifies(timeShift(left, timeSubtract(right, left) * 0.5))) continue
		const durationDays = timeSubtract(right, left)
		const durationHours = durationDays * 24
		if (durationHours < (options.minimumDurationHours ?? 0)) continue
		const rateAt = (time: Time) => expectedRateAt(solution, profile, observer, time, options)
		let bestTime: Time | undefined
		let bestRate = rateAt(left)
		const endRate = rateAt(right)
		if (endRate > bestRate) {
			bestRate = endRate
			bestTime = right
		} else bestTime = left
		for (const extremum of searchExtrema(rateAt, left, right, { step: Math.min(step, durationDays), tolerance: options.tolerance })) {
			if (extremum.kind === 'maximum' && extremum.value > bestRate) {
				bestRate = extremum.value
				bestTime = extremum.time
			}
		}
		const expectedCount = integrateRate(rateAt, left, right, step)
		const bestConditions = conditionsAt(solution, observer, bestTime, options)
		windows.push({ start: left, end: right, durationHours, expectedCount, bestTime, bestLocalHourlyRate: bestRate, moonIlluminationAtBest: bestConditions?.moonIllumination })
	}
	return windows.sort((a, b) => b.expectedCount - a.expectedCount)
}

// Computes the scalar margin used to find all planner boundaries. Positive values satisfy every
// selected constraint; the profile itself supplies the activity support when catalog bounds are absent.
function scoreAt(solution: MeteorShowerSolution, profile: MeteorActivityProfile, observer: GeographicPosition, time: Time, options: MeteorObservingWindowOptions): number {
	const solarLongitude = meteorSolarLongitude(time)
	const profileZhr = meteorActivityZhr(profile, solarLongitude)
	if (!(profileZhr > 0)) return -1
	const catalogActivity = isMeteorShowerActive(solution.activityInterval, solarLongitude)
	if (catalogActivity === false) return -1
	const radiant = radiantAt(solution, time, solarLongitude)
	if (radiant === undefined) return -1
	const conditions = meteorObservingConditions(radiant, observer, time, { time, solarLongitude })
	let margin = (options.maximumSolarAltitude ?? deg(-18)) - conditions.sunAltitude
	margin = Math.min(margin, conditions.radiant.altitude - (options.minimumRadiantAltitude ?? 0))
	if (options.minimumMoonRadiantSeparation !== undefined) margin = Math.min(margin, conditions.moonRadiantSeparation - options.minimumMoonRadiantSeparation)
	if (options.maximumMoonIllumination !== undefined) margin = Math.min(margin, options.maximumMoonIllumination - conditions.moonIllumination)
	return margin
}

function expectedRateAt(solution: MeteorShowerSolution, profile: MeteorActivityProfile, observer: GeographicPosition, time: Time, options: MeteorObservingWindowOptions): number {
	const solarLongitude = meteorSolarLongitude(time)
	const radiant = radiantAt(solution, time, solarLongitude)
	if (radiant === undefined) return 0
	const conditions = meteorObservingConditions(radiant, observer, time, { time, solarLongitude })
	const observation: MeteorVisualObservation = {
		count: 1,
		effectiveTime: 1,
		limitingMagnitude: options.limitingMagnitude ?? 6.5,
		populationIndex: options.populationIndex ?? 2,
		obstructionCorrection: options.obstructionCorrection ?? 1,
		radiantAltitude: conditions.radiant.altitude,
		altitudeExponent: options.altitudeExponent ?? 1,
	}
	const rate = meteorLocalHourlyRate(meteorActivityZhr(profile, solarLongitude), observation)
	return rate * (options.rateCorrection?.(time, conditions) ?? 1)
}

function conditionsAt(solution: MeteorShowerSolution, observer: GeographicPosition, time: Time | undefined, options: MeteorObservingWindowOptions): MeteorObservingConditions | undefined {
	if (time === undefined) return undefined
	const solarLongitude = meteorSolarLongitude(time)
	const radiant = radiantAt(solution, time, solarLongitude)
	return radiant === undefined ? undefined : meteorObservingConditions(radiant, observer, time, { time, solarLongitude })
}

function radiantAt(solution: MeteorShowerSolution, time: Time, solarLongitude: number) {
	return meteorRadiantJ2000(solution, { time, solarLongitude })?.radiant
}

function integrateRate(rateAt: (time: Time) => number, start: Time, end: Time, step: number): number {
	const duration = timeSubtract(end, start)
	const panels = Math.max(1, Math.ceil(duration / step))
	const h = duration / panels
	let total = 0
	for (let i = 0; i <= panels; i++) {
		const coefficient = i === 0 || i === panels ? 1 : panels % 2 === 0 ? (i % 2 === 0 ? 2 : 4) : 2
		total += coefficient * rateAt(timeShift(start, i * h))
	}
	if (panels % 2 === 0) return ((total * h) / 3) * 24
	let trapezoid = 0
	let previous = rateAt(start)
	for (let i = 1; i <= panels; i++) {
		const current = rateAt(timeShift(start, i * h))
		trapezoid += (previous + current) * h * 0.5
		previous = current
	}
	return trapezoid * 24
}

function addRootIfBracketed(boundaries: Time[], f: (time: Time) => number, left: Time, right: Time, tolerance: number | undefined): void {
	const fl = f(left)
	const fr = f(right)
	if (fl === 0) boundaries.push(left)
	else if (fr === 0) boundaries.push(right)
	else if ((fl < 0 && fr > 0) || (fl > 0 && fr < 0)) boundaries.push(bisect(f, left, right, tolerance ?? 1e-6))
}

function bisect(f: (time: Time) => number, left: Time, right: Time, tolerance: number): Time {
	let a = left
	let b = right
	let fa = f(a)
	for (let iteration = 0; iteration < 100; iteration++) {
		const half = timeSubtract(b, a) * 0.5
		const middle = timeShift(a, half)
		const fm = f(middle)
		if (Math.abs(half) <= tolerance) return middle
		if ((fa < 0 && fm > 0) || (fa > 0 && fm < 0)) b = middle
		else {
			a = middle
			fa = fm
		}
	}
	return timeShift(a, timeSubtract(b, a) * 0.5)
}

function chooseStep(profile: MeteorActivityProfile, activityInterval: MeteorShowerSolution['activityInterval'], requested: number | undefined): number {
	const step = requested ?? 1 / 24
	if (!(step > 0) || !Number.isFinite(step)) throw new Error('meteor observing-window step must be finite and positive')
	let smallestSupport = Number.POSITIVE_INFINITY
	if (profile.type === 'exponential') smallestSupport = supportDays(profile.support)
	else if (profile.type === 'sampled') smallestSupport = supportDays(profile.support)
	else for (const component of profile.components) smallestSupport = Math.min(smallestSupport, supportDays(component.support))
	if (activityInterval !== undefined) smallestSupport = Math.min(smallestSupport, supportDays(activityInterval))
	return smallestSupport > 0 ? Math.min(step, smallestSupport / 4) : step
}

function supportDays(support: MeteorSolarLongitudeInterval): number {
	if (support.fullCircle) return 365.25
	return (((support.end - support.start + Math.PI * 2) % (Math.PI * 2)) / (Math.PI * 2)) * 365.25
}

function isSolution(value: MeteorShowerSolution | MeteorActivityProfile): value is MeteorShowerSolution {
	return 'activity' in value
}
