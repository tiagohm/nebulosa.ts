import { DAYSPERJY } from '../../core/constants'
import { deg } from '../../math/units/angle'
import { searchExtrema, searchRoots } from '../events/search'
import type { GeographicPosition } from '../observer/location'
import { type Time, timeShift, timeSubtract } from '../time/time'
import { meteorActivityMaximumSolarLongitude, meteorActivityZhr } from './activity'
import { meteorLocalHourlyRate } from './observation'
import { meteorSolarLongitude } from './solar'
import { meteorShowerState } from './state'
import type { MeteorActivityProfile, MeteorObservingConditions, MeteorObservingWindow, MeteorObservingWindowOptions, MeteorShowerSolution, MeteorShowerState, MeteorSolarLongitudeInterval, MeteorVisualObservation } from './types'

// Local observing-window planner. It intersects catalog/profile support, solar darkness, radiant
// altitude and opt-in lunar constraints, refines every detected boundary, evaluates endpoints and
// orders surviving windows by integrated expected local count. All returned lunar values are tied to
// their best-time instant through the condition object used during evaluation.

// Plans observing windows for one shower, one explicit activity profile and one observer.
export function meteorObservingWindows(solution: MeteorShowerSolution, profile: MeteorActivityProfile, observer: GeographicPosition, start: Time, end: Time, options?: MeteorObservingWindowOptions): readonly MeteorObservingWindow[]
// Equivalent argument order for applications that naturally select a profile first.
export function meteorObservingWindows(profile: MeteorActivityProfile, solution: MeteorShowerSolution, observer: GeographicPosition, start: Time, end: Time, options?: MeteorObservingWindowOptions): readonly MeteorObservingWindow[]

export function meteorObservingWindows(first: MeteorShowerSolution | MeteorActivityProfile, second: MeteorActivityProfile | MeteorShowerSolution, observer: GeographicPosition, start: Time, end: Time, options: MeteorObservingWindowOptions = {}): readonly MeteorObservingWindow[] {
	const duration = timeSubtract(end, start)
	if (!(duration > 0)) return []
	const solution = isSolution(first) ? first : (second as MeteorShowerSolution)
	const profile = isSolution(first) ? (second as MeteorActivityProfile) : first
	const step = chooseStep(profile, solution.activityInterval, options.step)
	const maximumSolarLongitude = meteorActivityMaximumSolarLongitude(profile)
	const activityMaximumZhr = maximumSolarLongitude === undefined ? undefined : meteorActivityZhr(profile, maximumSolarLongitude)
	const evaluate = (time: Time) => plannerEvaluationAt(solution, profile, observer, time, options, activityMaximumZhr)
	const qualifies = (time: Time) => scoreAt(evaluate(time), options) >= 0
	const score = (time: Time) => scoreAt(evaluate(time), options)
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

	const metrics: PlannerMetrics = {}
	const rateAt = (time: Time) => {
		const evaluation = evaluate(time)
		accumulateMetrics(metrics, evaluation.state)
		return evaluation.rate
	}

	for (let i = 0; i + 1 < unique.length; i++) {
		const left = unique[i]
		const right = unique[i + 1]
		if (!qualifies(timeShift(left, timeSubtract(right, left) * 0.5))) continue

		const durationDays = timeSubtract(right, left)
		const durationHours = durationDays * 24
		if (durationHours < (options.minimumDurationHours ?? 0)) continue

		metrics.maximumActivityFraction = undefined
		metrics.maximumMoonAltitude = undefined
		metrics.maximumRadiantAltitude = undefined
		metrics.maximumZhr = undefined
		metrics.minimumMoonRadiantSeparation = undefined

		let bestTime: Time
		let bestRate = rateAt(left)
		const endRate = rateAt(right)

		if (endRate > bestRate) {
			bestRate = endRate
			bestTime = right
		} else {
			bestTime = left
		}

		for (const extremum of searchExtrema(rateAt, left, right, { step: Math.min(step, durationDays), tolerance: options.tolerance })) {
			if (extremum.kind === 'maximum' && extremum.value > bestRate) {
				bestRate = extremum.value
				bestTime = extremum.time
			}
		}

		const expectedCount = integrateRate(rateAt, left, right, step)
		const bestState = evaluate(bestTime).state
		accumulateMetrics(metrics, bestState)
		windows.push({
			start: left,
			end: right,
			durationHours,
			expectedCount,
			bestTime,
			bestLocalHourlyRate: bestRate,
			moonIlluminationAtBest: bestState.moonIllumination,
			maximumRadiantAltitude: metrics.maximumRadiantAltitude,
			minimumMoonRadiantSeparation: metrics.minimumMoonRadiantSeparation,
			maximumMoonAltitude: metrics.maximumMoonAltitude,
			maximumActivityFraction: metrics.maximumActivityFraction,
			maximumZhr: metrics.maximumZhr,
		})
	}

	return windows.sort((a, b) => b.expectedCount - a.expectedCount)
}

// Computes the scalar margin used to find all planner boundaries. Positive values satisfy every
// selected constraint; the profile itself supplies the activity support when catalog bounds are absent.
function scoreAt(evaluation: PlannerEvaluation, options: MeteorObservingWindowOptions): number {
	const state = evaluation.state
	if (!state.active || !(state.zhr !== undefined && state.zhr > 0) || state.horizontal === undefined || state.sunAltitude === undefined) return -1
	let margin = (options.maximumSolarAltitude ?? deg(-18)) - state.sunAltitude
	margin = Math.min(margin, state.horizontal.altitude - (options.minimumRadiantAltitude ?? 0))
	if (options.maximumMoonAltitude !== undefined && state.moonAltitude !== undefined) margin = Math.min(margin, options.maximumMoonAltitude - state.moonAltitude)
	if (state.moonAltitude !== undefined && state.moonAltitude > 0) {
		if (options.minimumMoonRadiantSeparation !== undefined && state.moonSeparation !== undefined) margin = Math.min(margin, state.moonSeparation - options.minimumMoonRadiantSeparation)
		if (options.maximumMoonIllumination !== undefined && state.moonIllumination !== undefined) margin = Math.min(margin, options.maximumMoonIllumination - state.moonIllumination)
	}
	return margin
}

// Computes all quantities for one planner sample, evaluating lunar ephemerides only when a selected
// lunar constraint or a condition-aware rate correction requires them.
function plannerEvaluationAt(solution: MeteorShowerSolution, profile: MeteorActivityProfile, observer: GeographicPosition, time: Time, options: MeteorObservingWindowOptions, activityMaximumZhr: number | undefined): PlannerEvaluation {
	const solarLongitude = meteorSolarLongitude(time)
	const includeMoon = needsMoon(options)
	const state = meteorShowerState(solution, { time, solarLongitude, observer }, { profile, activityMaximumZhr, includeRadiantOfDate: false, includeHorizontal: true, includeSun: true, includeMoon })
	if (state.horizontal === undefined || state.zhr === undefined) return { state, rate: 0 }
	const observation: MeteorVisualObservation = {
		count: 1,
		effectiveTime: 1,
		limitingMagnitude: options.limitingMagnitude ?? 6.5,
		populationIndex: options.populationIndex ?? 2,
		obstructionCorrection: options.obstructionCorrection ?? 1,
		radiantAltitude: state.horizontal.altitude,
		altitudeExponent: options.altitudeExponent ?? 1,
	}

	const rate = meteorLocalHourlyRate(state.zhr, observation)
	if (options.rateCorrection === undefined) return { state, rate }
	const conditions = observingConditionsFromState(time, state)
	return { state, rate: conditions === undefined ? 0 : rate * options.rateCorrection(time, conditions) }
}

// Returns whether any selected behavior needs lunar altitude, phase or separation.
function needsMoon(options: MeteorObservingWindowOptions): boolean {
	return options.maximumMoonAltitude !== undefined || options.minimumMoonRadiantSeparation !== undefined || options.maximumMoonIllumination !== undefined || options.rateCorrection !== undefined
}

// Restores the legacy full condition object only for the explicit correction callback seam.
function observingConditionsFromState(time: Time, state: MeteorShowerState): MeteorObservingConditions | undefined {
	if (state.horizontal === undefined || state.sunAltitude === undefined || state.moonAltitude === undefined || state.moonIllumination === undefined || state.moonSeparation === undefined) return undefined
	return { time, sunAltitude: state.sunAltitude, moonAltitude: state.moonAltitude, moonIllumination: state.moonIllumination, moonRadiantSeparation: state.moonSeparation, radiant: state.horizontal }
}

// Metrics accumulated from the same samples already used for rate search and integration.
interface PlannerMetrics {
	// Greatest sampled radiant altitude in radians.
	maximumRadiantAltitude?: number
	// Smallest sampled Moon-radiant separation in radians.
	minimumMoonRadiantSeparation?: number
	// Greatest sampled lunar altitude in radians.
	maximumMoonAltitude?: number
	// Greatest sampled profile fraction.
	maximumActivityFraction?: number
	// Greatest sampled ZHR in meteors per hour.
	maximumZhr?: number
}

// Updates sampled extrema without triggering any additional ephemeris evaluation.
function accumulateMetrics(metrics: PlannerMetrics, state: MeteorShowerState): void {
	if (state.horizontal !== undefined) metrics.maximumRadiantAltitude = Math.max(metrics.maximumRadiantAltitude ?? Number.NEGATIVE_INFINITY, state.horizontal.altitude)
	if (state.moonSeparation !== undefined) metrics.minimumMoonRadiantSeparation = Math.min(metrics.minimumMoonRadiantSeparation ?? Number.POSITIVE_INFINITY, state.moonSeparation)
	if (state.moonAltitude !== undefined) metrics.maximumMoonAltitude = Math.max(metrics.maximumMoonAltitude ?? Number.NEGATIVE_INFINITY, state.moonAltitude)
	if (state.activityFraction !== undefined) metrics.maximumActivityFraction = Math.max(metrics.maximumActivityFraction ?? 0, state.activityFraction)
	if (state.zhr !== undefined) metrics.maximumZhr = Math.max(metrics.maximumZhr ?? 0, state.zhr)
}

// One fully evaluated sample and its local expected rate in meteors per hour.
interface PlannerEvaluation {
	// Aggregated state at the sample instant.
	readonly state: MeteorShowerState
	// Expected local rate in meteors per hour.
	readonly rate: number
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

		if ((fa < 0 && fm > 0) || (fa > 0 && fm < 0)) {
			b = middle
		} else {
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
	if (support.fullCircle) return DAYSPERJY
	return (((support.end - support.start + Math.PI * 2) % (Math.PI * 2)) / (Math.PI * 2)) * DAYSPERJY
}

function isSolution(value: MeteorShowerSolution | MeteorActivityProfile): value is MeteorShowerSolution {
	return 'activity' in value
}
