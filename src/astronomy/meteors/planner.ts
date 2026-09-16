import { DAYSPERJY, TAU } from '../../core/constants'
import { brentMinimize } from '../../math/numerical/optimization'
import { deg, normalizeAngle } from '../../math/units/angle'
import { searchExtrema, searchRoots } from '../events/search'
import type { GeographicPosition } from '../observer/location'
import { type Time, timeConvert, timeShift, timeSubtract, timeToDate, Timescale } from '../time/time'
import { meteorActivityMaximumZhr } from './activity'
import { meteorSolarLongitudeTimes } from './solar'
import { meteorShowerComputationContext, meteorShowerState } from './state'
import type { MeteorActivityProfile, MeteorObservingConditions, MeteorObservingWindow, MeteorObservingWindowOptions, MeteorShowerSolution, MeteorShowerState, MeteorSolarLongitudeInterval } from './types'

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
	const candidates = plannerCandidateIntervals(profile, solution.activityInterval, start, end, step, options)
	const windows: MeteorObservingWindow[] = []
	for (const candidate of candidates) windows.push(...meteorObservingWindowsInInterval(solution, profile, observer, candidate.start, candidate.end, step, options))
	return windows.sort((a, b) => b.expectedCount - a.expectedCount)
}

// Plans one already-bounded candidate interval at the chosen resolution.
function meteorObservingWindowsInInterval(solution: MeteorShowerSolution, profile: MeteorActivityProfile, observer: GeographicPosition, start: Time, end: Time, step: number, options: MeteorObservingWindowOptions): readonly MeteorObservingWindow[] {
	const activityMaximumZhr = meteorActivityMaximumZhr(profile)
	const rateModel: PlannerRateModel = {
		denominator: (options.obstructionCorrection ?? 1) * (options.populationIndex ?? 2) ** (6.5 - (options.limitingMagnitude ?? 6.5)),
		altitudeExponent: options.altitudeExponent ?? 1,
	}

	const evaluations = new Map<number, Map<number, Map<number, PlannerEvaluation>>>()
	const evaluate = (time: Time) => {
		let scales = evaluations.get(time.day)
		if (scales === undefined) {
			scales = new Map()
			evaluations.set(time.day, scales)
		}
		let fractions = scales.get(time.scale)
		if (fractions === undefined) {
			fractions = new Map()
			scales.set(time.scale, fractions)
		}
		const cached = fractions.get(time.fraction)
		if (cached !== undefined) return cached
		const evaluation = plannerEvaluationAt(solution, profile, observer, time, options, activityMaximumZhr, rateModel)
		fractions.set(time.fraction, evaluation)
		return evaluation
	}

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

		const summary = summarizeRate(rateAt, left, right, step, options.tolerance)
		const bestTime = summary.bestTime
		const bestRate = summary.bestRate
		const expectedCount = summary.expectedCount
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

	return windows
}

// Computes the scalar margin used to find all planner boundaries. Positive values satisfy every
// selected constraint; the profile itself supplies the activity support when catalog bounds are absent.
function scoreAt(evaluation: PlannerEvaluation, options: MeteorObservingWindowOptions): number {
	const state = evaluation.state
	if (state.active !== true || !(state.zhr !== undefined && state.zhr > 0) || state.horizontal === undefined || state.sunAltitude === undefined) return -1
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
function plannerEvaluationAt(solution: MeteorShowerSolution, profile: MeteorActivityProfile, observer: GeographicPosition, time: Time, options: MeteorObservingWindowOptions, activityMaximumZhr: number | undefined, rateModel: PlannerRateModel): PlannerEvaluation {
	const includeMoon = needsMoon(options)
	const context = meteorShowerComputationContext(time, observer, { includeHorizontal: true, includeSun: true, includeMoon })
	const state = meteorShowerState(solution, context, { profile, activityMaximumZhr, includeRadiantOfDate: false, includeHorizontal: true, includeSun: true, includeMoon })
	if (state.horizontal === undefined || state.zhr === undefined) return { state, rate: 0 }
	const sine = Math.sin(state.horizontal.altitude)
	const rate = sine > 0 ? (state.zhr * sine ** rateModel.altitudeExponent) / rateModel.denominator : 0
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

// Observation constants hoisted out of every planner sample.
interface PlannerRateModel {
	// Magnitude, population-index and obstruction denominator.
	readonly denominator: number
	// Exponent applied to the radiant-altitude sine.
	readonly altitudeExponent: number
}

// Integrates one window while locating its best coarse sample and refining only that neighborhood.
function summarizeRate(rateAt: (time: Time) => number, start: Time, end: Time, step: number, tolerance: number | undefined): { readonly expectedCount: number; readonly bestTime: Time; readonly bestRate: number } {
	const duration = timeSubtract(end, start)
	const panels = Math.max(1, Math.ceil(duration / step))
	const h = duration / panels
	let bestIndex = 0
	let bestTime = start
	let bestRate = Number.NEGATIVE_INFINITY
	let total = 0
	let previous = 0

	for (let i = 0; i <= panels; i++) {
		const time = i === panels ? end : timeShift(start, i * h)
		const rate = rateAt(time)

		if (rate > bestRate) {
			bestRate = rate
			bestTime = time
			bestIndex = i
		}

		if (panels % 2 === 0) {
			const coefficient = i === 0 || i === panels ? 1 : i % 2 === 0 ? 2 : 4
			total += coefficient * rate
		} else if (i > 0) {
			total += (previous + rate) * 0.5
		}

		previous = rate
	}

	if (bestIndex > 0 && bestIndex < panels) {
		const left = (bestIndex - 1) * h
		const right = (bestIndex + 1) * h
		const refined = brentMinimize((offset) => -rateAt(timeShift(start, offset)), left, right, { tolerance: tolerance ?? 1e-6 })

		if (-refined.value > bestRate) {
			bestRate = -refined.value
			bestTime = timeShift(start, refined.minimum)
		}
	}

	const expectedCount = panels % 2 === 0 ? ((total * h) / 3) * 24 : total * h * 24

	return { expectedCount, bestTime, bestRate }
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

// Restricts long, highly oversampled searches to the temporal intersection of catalog and profile
// support. Short searches retain their original interval to avoid unnecessary annual inversions.
function plannerCandidateIntervals(profile: MeteorActivityProfile, activityInterval: MeteorShowerSolution['activityInterval'], start: Time, end: Time, step: number, options: MeteorObservingWindowOptions): readonly PlannerCandidateInterval[] {
	const duration = timeSubtract(end, start)
	if (duration / step <= 512) return [{ start, end }]

	const profileSupports = profile.type === 'multiPeak' ? profile.components.map((component) => component.support) : [profile.support]
	let spans: SolarLongitudeSpan[] = []
	for (const support of profileSupports) spans.push(...linearSolarLongitudeSpans(support))

	if (activityInterval !== undefined) {
		const catalog = linearSolarLongitudeSpans(activityInterval)
		const intersections: SolarLongitudeSpan[] = []

		for (const profileSpan of spans) {
			for (const catalogSpan of catalog) {
				const lower = Math.max(profileSpan.start, catalogSpan.start)
				const upper = Math.min(profileSpan.end, catalogSpan.end)
				if (upper > lower) intersections.push({ start: lower, end: upper })
			}
		}

		spans = intersections
	}

	spans = mergeSolarLongitudeSpans(spans)
	if (spans.length === 0) return []
	if (spans.length === 1 && spans[0].start === 0 && spans[0].end === TAU) return [{ start, end }]

	const firstYear = timeToDate(timeConvert(start, Timescale.UTC))[0] - 1
	const lastYear = timeToDate(timeConvert(end, Timescale.UTC))[0]
	const candidates: PlannerCandidateInterval[] = []

	for (let year = firstYear; year <= lastYear; year++) {
		for (const span of spans) {
			const startLongitude = span.start === TAU ? 0 : span.start
			const endLongitude = span.end === TAU ? 0 : span.end
			const times = meteorSolarLongitudeTimes(year, [startLongitude, endLongitude], { step: 7, tolerance: options.tolerance, scale: start.scale })
			let candidateEnd = times[1]
			if (timeSubtract(candidateEnd, times[0]) <= 0) candidateEnd = meteorSolarLongitudeTimes(year + 1, [endLongitude], { step: 7, tolerance: options.tolerance, scale: start.scale })[0]
			const candidateStart = timeSubtract(times[0], start) < 0 ? start : times[0]
			candidateEnd = timeSubtract(candidateEnd, end) > 0 ? end : candidateEnd
			if (timeSubtract(candidateEnd, candidateStart) > 0) candidates.push({ start: candidateStart, end: candidateEnd })
		}
	}

	candidates.sort((a, b) => timeSubtract(a.start, b.start))
	const merged: PlannerCandidateInterval[] = []

	for (const candidate of candidates) {
		const previous = merged.at(-1)
		if (previous === undefined || timeSubtract(candidate.start, previous.end) > 1e-8) merged.push(candidate)
		else if (timeSubtract(candidate.end, previous.end) > 0) merged[merged.length - 1] = { start: previous.start, end: candidate.end }
	}

	return merged
}

// Converts one circular support to at most two non-wrapping spans in [0, 2π].
function linearSolarLongitudeSpans(support: MeteorSolarLongitudeInterval): readonly SolarLongitudeSpan[] {
	if (support.fullCircle) return [{ start: 0, end: TAU }]
	const start = normalizeAngle(support.start)
	const end = normalizeAngle(support.end)
	if (start === end) return []
	return start < end
		? [{ start, end }]
		: [
				{ start, end: TAU },
				{ start: 0, end },
			]
}

// Merges overlapping linear longitude spans while preserving disjoint activity regions.
function mergeSolarLongitudeSpans(spans: readonly SolarLongitudeSpan[]): SolarLongitudeSpan[] {
	const sorted = [...spans].sort((a, b) => a.start - b.start || a.end - b.end)
	const merged: SolarLongitudeSpan[] = []

	for (const span of sorted) {
		const previous = merged.at(-1)
		if (previous === undefined || span.start > previous.end) merged.push(span)
		else if (span.end > previous.end) merged[merged.length - 1] = { start: previous.start, end: span.end }
	}

	return merged
}

// One non-wrapping solar-longitude support span in radians.
interface SolarLongitudeSpan {
	readonly start: number
	readonly end: number
}

// One absolute interval worth scanning at the fine planner resolution.
interface PlannerCandidateInterval {
	readonly start: Time
	readonly end: Time
}

function isSolution(value: MeteorShowerSolution | MeteorActivityProfile): value is MeteorShowerSolution {
	return 'activity' in value
}
