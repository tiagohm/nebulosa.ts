import { DAYSPERJY, TAU } from '../../core/constants'
import { brentMinimize } from '../../math/numerical/optimization'
import { deg, normalizeAngle } from '../../math/units/angle'
import { searchExtrema, searchRoots } from '../events/search'
import type { GeographicPosition } from '../observer/location'
import { type Time, timeShift, timeSubtract, timeToDate, utc } from '../time/time'
import { isMeteorShowerActive, isMeteorShowerActivityYearLimited, meteorActivityMaximumZhr, meteorShowerActivityYearApplies } from './activity'
import { meteorSolarLongitudeCrossingTimes } from './solar'
import { meteorShowerComputationContext, meteorShowerState } from './state'
import type { MeteorActivityProfile, MeteorGeometricObservingWindow, MeteorGeometricObservingWindowOptions, MeteorObservingConditions, MeteorObservingWindow, MeteorObservingWindowOptions, MeteorShowerSolution, MeteorShowerState, MeteorSolarLongitudeInterval } from './types'

// Local observing-window planner. It intersects activity support, solar darkness, radiant altitude
// and opt-in lunar constraints, and refines every detected boundary. The profile planner orders its
// windows by integrated expected local count, with all returned lunar values tied to their best-time
// instant through the condition object used during evaluation. The geometric planner needs no
// activity profile, returns no rate or count, and orders its windows chronologically.

// Plans observing windows for one shower, one explicit activity profile and one observer.
export function meteorObservingWindows(solution: MeteorShowerSolution, profile: MeteorActivityProfile, observer: GeographicPosition, start: Time, end: Time, options?: MeteorObservingWindowOptions): readonly MeteorObservingWindow[]
// Equivalent argument order for applications that naturally select a profile first.
export function meteorObservingWindows(profile: MeteorActivityProfile, solution: MeteorShowerSolution, observer: GeographicPosition, start: Time, end: Time, options?: MeteorObservingWindowOptions): readonly MeteorObservingWindow[]

export function meteorObservingWindows(first: MeteorShowerSolution | MeteorActivityProfile, second: MeteorActivityProfile | MeteorShowerSolution, observer: GeographicPosition, start: Time, end: Time, options: MeteorObservingWindowOptions = {}): readonly MeteorObservingWindow[] {
	const duration = timeSubtract(end, start)
	if (!(duration > 0)) return []
	const solution = isSolution(first) ? first : (second as MeteorShowerSolution)
	const profile = isSolution(first) ? (second as MeteorActivityProfile) : first
	const step = chooseStep([...profileSupports(profile), ...(solution.activityInterval === undefined ? [] : [solution.activityInterval])], options.step)
	const candidates = plannerCandidateIntervals(profileSupports(profile), solution.activity, solution.activityInterval, start, end, step, options)
	const windows: MeteorObservingWindow[] = []
	for (const candidate of candidates) windows.push(...meteorObservingWindowsInInterval(solution, profile, observer, candidate.start, candidate.end, step, options))
	return windows.sort((a, b) => b.expectedCount - a.expectedCount)
}

// Plans the geometric observing windows of one shower for one observer without an activity profile:
// the stretches where the shower is inside its activity support, the Sun is below
// maximumSolarAltitude, the geometric radiant is above minimumRadiantAltitude, and the opt-in lunar
// constraints hold. The support is options.support when given, else the catalog activityInterval;
// without either, the activity cannot be judged, so the windows only satisfy the geometry and are
// labelled geometryOnly. A dated outburst outside its years yields no windows unless
// extrapolateYearLimitedActivity is set. Windows carry no ZHR, rate or count and are returned in
// chronological order; the Sun and Moon at bestTime are evaluated once per window. A non-positive
// span returns an empty array.
export function meteorGeometricObservingWindows(solution: MeteorShowerSolution, observer: GeographicPosition, start: Time, end: Time, options: MeteorGeometricObservingWindowOptions = {}): readonly MeteorGeometricObservingWindow[] {
	if (!(timeSubtract(end, start) > 0)) return []
	const support = options.support ?? solution.activityInterval
	const step = chooseStep(support === undefined ? [] : [support], options.step)
	const candidates = support === undefined ? [{ start, end }] : plannerCandidateIntervals([support], solution.activity, undefined, start, end, step, options)
	const includeMoon = needsMoon(options)
	const extrapolate = options.extrapolateYearLimitedActivity === true
	const windows: MeteorGeometricObservingWindow[] = []

	for (const candidate of candidates) {
		const evaluate = cachedByTime((time): GeometricEvaluation => {
			const context = meteorShowerComputationContext(time, observer, { includeHorizontal: true, includeSun: true, includeMoon })
			const state = meteorShowerState(solution, context, { includeRadiantOfDate: false, includeHorizontal: true, includeSun: true, includeMoon, includeActivity: false, extrapolateYearLimitedActivity: extrapolate })
			const yearApplies = extrapolate || meteorShowerActivityYearApplies(solution.activity, time)
			const active = yearApplies && (support === undefined || isMeteorShowerActive(support, context.solarLongitude) === true)
			return { state, active }
		})

		const score = (time: Time) => {
			const evaluation = evaluate(time)
			return evaluation.active ? constraintMargin(evaluation.state, options) : -1
		}

		const sineAt = (time: Time) => {
			const horizontal = evaluate(time).state.horizontal
			return horizontal === undefined ? 0 : Math.max(0, Math.sin(horizontal.altitude))
		}

		for (const [left, right] of qualifyingSegments(score, candidate.start, candidate.end, step, options)) {
			const summary = summarizeRate(sineAt, left, right, step, options.tolerance)
			const best = meteorShowerState(solution, meteorShowerComputationContext(summary.bestTime, observer, { includeHorizontal: true, includeSun: true, includeMoon: true }), {
				includeRadiantOfDate: false,
				includeHorizontal: true,
				includeSun: true,
				includeMoon: true,
				includeActivity: false,
				extrapolateYearLimitedActivity: extrapolate,
			})
			// The window qualified, so the radiant, Sun and Moon of its best instant are all defined.
			windows.push({
				start: left,
				end: right,
				durationHours: timeSubtract(right, left) * 24,
				bestTime: summary.bestTime,
				maximumRadiantAltitude: best.horizontal!.altitude,
				radiantSineHours: summary.expectedCount,
				sunAltitudeAtBest: best.sunAltitude!,
				moonAltitudeAtBest: best.moonAltitude!,
				moonIlluminationAtBest: best.moonIllumination!,
				moonRadiantSeparationAtBest: best.moonSeparation!,
				support: support === undefined ? 'geometryOnly' : 'activity',
			})
		}
	}

	return windows.sort((a, b) => timeSubtract(a.start, b.start))
}

// One sample of the geometric planner: the shower state without activity, and whether the shower is
// inside its support and its years at the sample instant.
interface GeometricEvaluation {
	// Radiant, Sun and optional Moon state at the sample instant.
	readonly state: MeteorShowerState
	// Whether the sample lies inside the known support and the dated years; true when no support is known.
	readonly active: boolean
}

// Plans one already-bounded candidate interval at the chosen resolution.
function meteorObservingWindowsInInterval(solution: MeteorShowerSolution, profile: MeteorActivityProfile, observer: GeographicPosition, start: Time, end: Time, step: number, options: MeteorObservingWindowOptions): readonly MeteorObservingWindow[] {
	const activityMaximumZhr = meteorActivityMaximumZhr(profile)
	const rateModel: PlannerRateModel = {
		denominator: (options.obstructionCorrection ?? 1) * (options.populationIndex ?? 2) ** (6.5 - (options.limitingMagnitude ?? 6.5)),
		altitudeExponent: options.altitudeExponent ?? 1,
	}

	const evaluate = cachedByTime((time) => plannerEvaluationAt(solution, profile, observer, time, options, activityMaximumZhr, rateModel))
	const score = (time: Time) => scoreAt(evaluate(time), options)
	const windows: MeteorObservingWindow[] = []

	const metrics: PlannerMetrics = {}
	const rateAt = (time: Time) => {
		const evaluation = evaluate(time)
		accumulateMetrics(metrics, evaluation.state)
		return evaluation.rate
	}

	for (const [left, right] of qualifyingSegments(score, start, end, step, options)) {
		const durationHours = timeSubtract(right, left) * 24

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
	if (state.active !== true || !(state.zhr !== undefined && state.zhr > 0)) return -1
	return constraintMargin(state, options)
}

// Computes the smallest margin of the darkness, radiant-altitude and selected lunar constraints, in
// radians or illuminated fraction; non-negative values satisfy all of them, and a state without the
// radiant or the Sun gives -1.
function constraintMargin(state: MeteorShowerState, options: MeteorGeometricObservingWindowOptions): number {
	if (state.horizontal === undefined || state.sunAltitude === undefined) return -1
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
	const state = meteorShowerState(solution, context, { profile, activityMaximumZhr, includeRadiantOfDate: false, includeHorizontal: true, includeSun: true, includeMoon, extrapolateYearLimitedActivity: options.extrapolateYearLimitedActivity })
	if (state.horizontal === undefined || state.zhr === undefined) return { state, rate: 0 }
	const sine = Math.sin(state.horizontal.altitude)
	const rate = sine > 0 ? (state.zhr * sine ** rateModel.altitudeExponent) / rateModel.denominator : 0
	if (options.rateCorrection === undefined) return { state, rate }
	const conditions = observingConditionsFromState(time, state)
	return { state, rate: conditions === undefined ? 0 : rate * options.rateCorrection(time, conditions) }
}

// Returns whether any selected behavior needs lunar altitude, phase or separation.
function needsMoon(options: MeteorGeometricObservingWindowOptions & Pick<MeteorObservingWindowOptions, 'rateCorrection'>): boolean {
	return options.maximumMoonAltitude !== undefined || options.minimumMoonRadiantSeparation !== undefined || options.maximumMoonIllumination !== undefined || options.rateCorrection !== undefined
}

// Memoizes one evaluation per exact instant (day, scale and fraction), so the root search, the
// extremum search and the window summary never evaluate the same sample twice. The cache lives as long
// as the returned function.
function cachedByTime<T>(compute: (time: Time) => T): (time: Time) => T {
	const evaluations = new Map<number, Map<number, Map<number, T>>>()
	return (time: Time) => {
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
		const evaluation = compute(time)
		fractions.set(time.fraction, evaluation)
		return evaluation
	}
}

// Finds the chronological segments of [start, end] where score is non-negative. The boundaries are
// the scan roots plus the roots bisected next to every extremum, which catches tangent and double
// crossings between coarse samples; a segment qualifies by its midpoint and is kept when it lasts at
// least minimumDurationHours.
function qualifyingSegments(score: (time: Time) => number, start: Time, end: Time, step: number, options: Pick<MeteorGeometricObservingWindowOptions, 'tolerance' | 'minimumDurationHours'>): readonly (readonly [Time, Time])[] {
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
	const segments: (readonly [Time, Time])[] = []

	for (let i = 0; i + 1 < unique.length; i++) {
		const left = unique[i]
		const right = unique[i + 1]
		if (!(score(timeShift(left, timeSubtract(right, left) * 0.5)) >= 0)) continue
		if (timeSubtract(right, left) * 24 < (options.minimumDurationHours ?? 0)) continue
		segments.push([left, right])
	}

	return segments
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

// Integrates one window while detecting and refining every local maximum in the same coarse scan.
function summarizeRate(rateAt: (time: Time) => number, start: Time, end: Time, step: number, tolerance: number | undefined): { readonly expectedCount: number; readonly bestTime: Time; readonly bestRate: number } {
	const duration = timeSubtract(end, start)
	const panels = Math.max(1, Math.ceil(duration / step))
	const h = duration / panels
	const maxima: number[] = []
	let bestTime = start
	let bestRate = Number.NEGATIVE_INFINITY
	let total = 0
	let beforePrevious: number | undefined
	let previous: number | undefined

	for (let i = 0; i <= panels; i++) {
		const time = i === panels ? end : timeShift(start, i * h)
		const rate = rateAt(time)

		if (rate > bestRate) {
			bestRate = rate
			bestTime = time
		}

		if (beforePrevious !== undefined && previous !== undefined && previous > beforePrevious && previous > rate) maxima.push(i - 1)

		if (panels % 2 === 0) {
			const coefficient = i === 0 || i === panels ? 1 : i % 2 === 0 ? 2 : 4
			total += coefficient * rate
		} else if (previous !== undefined) {
			total += (previous + rate) * 0.5
		}

		beforePrevious = previous
		previous = rate
	}

	for (const index of maxima) {
		const left = (index - 1) * h
		const right = (index + 1) * h
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

// Chooses the scan step in days: the requested one (1/24 by default), shortened to a quarter of the
// narrowest support so a short activity period is sampled several times.
function chooseStep(supports: readonly MeteorSolarLongitudeInterval[], requested: number | undefined): number {
	const step = requested ?? 1 / 24
	if (!(step > 0) || !Number.isFinite(step)) throw new Error('meteor observing-window step must be finite and positive')
	let smallestSupport = Number.POSITIVE_INFINITY
	for (const support of supports) smallestSupport = Math.min(smallestSupport, supportDays(support))
	return smallestSupport > 0 ? Math.min(step, smallestSupport / 4) : step
}

// Lists the activity supports of a profile: its own, or those of every multi-peak component.
function profileSupports(profile: MeteorActivityProfile): readonly MeteorSolarLongitudeInterval[] {
	return profile.type === 'multiPeak' ? profile.components.map((component) => component.support) : [profile.support]
}

function supportDays(support: MeteorSolarLongitudeInterval): number {
	if (support.fullCircle) return DAYSPERJY
	return (((support.end - support.start + TAU) % TAU) / TAU) * DAYSPERJY
}

// Restricts long, highly oversampled searches to the temporal intersection of the given supports and
// the catalog support. Short searches retain their original interval to avoid unnecessary annual inversions.
function plannerCandidateIntervals(
	supports: readonly MeteorSolarLongitudeInterval[],
	activity: MeteorShowerSolution['activity'],
	activityInterval: MeteorShowerSolution['activityInterval'],
	start: Time,
	end: Time,
	step: number,
	options: Pick<MeteorObservingWindowOptions, 'tolerance' | 'extrapolateYearLimitedActivity'>,
): readonly PlannerCandidateInterval[] {
	const duration = timeSubtract(end, start)
	if (duration / step <= 512) return [{ start, end }]

	let spans: SolarLongitudeSpan[] = []
	for (const support of supports) spans.push(...linearSolarLongitudeSpans(support))

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

	let firstYear = timeToDate(utc(start))[0] - 1
	let lastYear = timeToDate(utc(end))[0]
	const yearLimited = isMeteorShowerActivityYearLimited(activity)

	if (yearLimited && options.extrapolateYearLimitedActivity !== true) {
		// Keep the preceding candidate because a solar-longitude span can cross into the first valid civil year.
		firstYear = Math.max(firstYear, activity.years!.start - 1)
		lastYear = Math.min(lastYear, activity.years!.end)
		if (lastYear < firstYear) return []
	}

	const candidates: PlannerCandidateInterval[] = []

	for (let year = firstYear; year <= lastYear; year++) {
		for (const span of spans) {
			const startLongitude = span.start === TAU ? 0 : span.start
			const endLongitude = span.end === TAU ? 0 : span.end
			const search = { step: 7, tolerance: options.tolerance, scale: start.scale }
			// A longitude the civil year never reaches belongs to a neighboring year's candidate, which the loop also visits.
			const [spanStart, spanEnd] = meteorSolarLongitudeCrossingTimes(year, [startLongitude, endLongitude], search)
			if (spanStart === undefined) continue
			let candidateEnd = spanEnd
			for (let next = year + 1; next <= year + 2 && (candidateEnd === undefined || timeSubtract(candidateEnd, spanStart) <= 0); next++) candidateEnd = meteorSolarLongitudeCrossingTimes(next, [endLongitude], search)[0]
			if (candidateEnd === undefined) continue
			const candidateStart = timeSubtract(spanStart, start) < 0 ? start : spanStart
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
