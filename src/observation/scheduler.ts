import { hourAngle } from '../astronomy/events/hourangle'
import type { VisibilityInterval } from '../astronomy/events/visibility'
import { greenwichApparentSiderealTime, type Time, timeShift, timeSubtract } from '../astronomy/time/time'
import { DAYSEC, PI, SIDEREAL_DRIFT_RATE } from '../core/constants'
import { validateNonNegativeInteger } from '../core/validation'
import { sphericalSeparation } from '../math/numerical/geometry'
import type { Angle } from '../math/units/angle'

// Pure, deterministic allocation of one observing session (typically a night) to exposure blocks of
// several targets. The caller supplies the candidate windows of each target (for example from
// visibilityWindows), the requested blocks with priorities, explicit overhead costs, weather or safety
// exclusions, and the current mount/filter/focus state; the scheduler returns a chronological plan
// without touching any device. Execution, aborts and retries remain the sequencer's responsibility: to
// replan after an interruption, call scheduleSession again from the new horizon with the updated
// initial state and completed frame counts.
//
// The algorithm is a deterministic greedy dispatcher with a one-step look-ahead. At each step every
// pending block is placed at its earliest feasible start from the simulated state, and each divisible
// candidate is also tried truncated at the start of every other candidate it would overlap. Each
// variant is charged with the priority-weighted acquisition time it displaces: how much the other
// candidates can still achieve in their remaining windows before versus after it. Its net score is
// (value − displaced) / (end − now), so slews, filter changes, focus, flips and idle waiting all lower
// it. A variant that can start at the earliest possible instant with a positive net score is preferred
// (time is never wasted while harmless work exists); otherwise the best net score wins, which may wait
// for a time-critical block. Every step commits at least one frame, so the loop ends when nothing fits.
//
// Conventions: durations, costs and returned diagnostics are SI seconds; angles are radians. Internal
// instants are seconds from the session start, measured in the start's time scale; returned instants
// are Time values in that same scale (pass TT for uniform seconds across a UTC leap second). Hour
// angles use a local sidereal time extrapolated linearly at the sidereal rate from the apparent
// sidereal time at the session start, accurate to well under a second over one night. Inputs are never
// mutated; the returned plan is freshly allocated and owned by the caller.

// Apparent equatorial pointing of a target, used for slew cost and meridian-flip prediction.
export interface SchedulePointing {
	// Apparent right ascension (equinox of date) compatible with local sidereal time, in radians.
	readonly rightAscension: Angle
	// Apparent declination, in radians.
	readonly declination: Angle
}

// One requested run of identical frames of a target.
export interface ScheduleBlockRequest {
	// Identifier unique across every block of the session; keys completedFrames and skip.
	readonly id: string
	// Exposure time of one frame, in seconds. Zero is allowed (bias frames) when readout is positive.
	readonly exposure: number
	// Requested number of frames, a non-negative integer.
	readonly count: number
	// Filter name. Omitted keeps the filter wheel where it is.
	readonly filter?: string
	// Frames between dithers inside one scheduled chunk, counted across a meridian flip inside it. Omitted
	// or zero never dithers.
	readonly ditherEvery?: number
	// Whether the frames may be split across several chunks. Defaults to false: all remaining frames
	// must fit in one contiguous chunk or the block is not scheduled.
	readonly divisible?: boolean
	// Smallest chunk of a divisible block, in frames. Defaults to 1. Capped at the remaining frames.
	readonly minimumFrames?: number
	// Largest chunk of a divisible block, in frames, so focus, priorities and flips are re-evaluated
	// between chunks. Defaults to unlimited. Ignored for indivisible blocks.
	readonly maximumFrames?: number
	// Earliest instant of the block, setup included. Used for time-critical blocks such as transits.
	readonly notBefore?: Time
	// Latest instant by which the block, frames included, must end.
	readonly notAfter?: Time
}

// A target with its observable windows and requested blocks.
export interface ScheduleTarget {
	// Identifier reported with each scheduled or unscheduled block.
	readonly id: string
	// Positive relative weight of the target's acquisition time in the objective.
	readonly priority: number
	// Intervals in which the target may be observed, in any time scale. Overlapping or unordered
	// intervals are merged. Calibration that may run any time uses one interval covering the session.
	readonly windows: readonly VisibilityInterval[]
	// Pointing of the mount for this target. Omitted means the mount is not moved (dark, bias or panel
	// flat frames): no slew, no meridian flip, and the previous pointing is kept.
	readonly pointing?: SchedulePointing
	// Whether the block needs the sky: such blocks are blocked by 'sky' exclusions and are preceded by
	// autofocus. Defaults to true.
	readonly sky?: boolean
	// Requested blocks, in the caller's preferred order (used as the deterministic tie-breaker).
	readonly blocks: readonly ScheduleBlockRequest[]
}

// Which blocks an exclusion forbids: 'sky' forbids blocks that need the sky (clouds, humidity), 'all'
// forbids every block (safety, power, roof closed with the camera unusable).
export type ScheduleExclusionScope = 'sky' | 'all'

// A supplied weather or safety interval in which no block of its scope may run. Exclusions are inputs,
// never predictions made by the scheduler.
export interface ScheduleExclusion {
	// First instant of the exclusion.
	readonly start: Time
	// Last instant of the exclusion.
	readonly end: Time
	// Affected blocks. Defaults to 'all'.
	readonly scope?: ScheduleExclusionScope
}

// Explicit overhead costs, all non-negative seconds unless stated. Omitted costs are zero.
export interface ScheduleCosts {
	// Slew rate of the mount, in radians per second, applied to the great-circle separation. Omitted
	// makes slews cost only slewSettle.
	readonly slewRate?: number
	// Fixed time added to every slew: acceleration, settling, plate solving and centering.
	readonly slewSettle?: number
	// Readout and download time of one frame.
	readonly readout?: number
	// Time of one dither, settling included.
	readonly dither?: number
	// Time of one filter-wheel change.
	readonly filterChange?: number
	// Time of one autofocus run. Zero disables autofocus.
	readonly focus?: number
	// Seconds after the last autofocus at which a sky block refocuses first. Omitted focuses only once.
	readonly focusInterval?: number
	// Whether a filter change also triggers autofocus before a sky block.
	readonly focusOnFilterChange?: boolean
	// Time of one meridian flip, recentering and guiding settle included.
	readonly meridianFlip?: number
}

// German equatorial mount geometry for meridian-flip prediction. Omit it for mounts that never flip.
export interface ScheduleMeridianPolicy {
	// East-positive geodetic longitude of the site, in radians.
	readonly longitude: Angle
	// Hour angle, in radians, at which a pre-flip block flips. Defaults to 0 (the meridian). The frame in
	// progress at that hour angle, and any dither due after it, is completed first, so leave margin for one
	// exposure; a threshold reached during the slew, filter change or focus flips before the first frame.
	readonly flipAt?: Angle
}

// Mount, filter, focus and progress state at the session start, for the initial plan or a replan.
export interface ScheduleInitialState {
	// Current mount pointing. Omitted makes the first slew cost a worst-case PI-radian slew.
	readonly pointing?: SchedulePointing
	// Whether the mount already is on the post-flip side for the current pointing.
	readonly postFlip?: boolean
	// Current filter. Omitted makes the first filtered block change filter.
	readonly filter?: string
	// Instant of the last autofocus. Omitted makes the first sky block focus when autofocus is enabled.
	readonly lastFocus?: Time
	// Frames already acquired by block id; only the remainder is scheduled.
	readonly completedFrames?: Readonly<Record<string, number>>
	// Block ids aborted or skipped by the sequencer; they are reported as unscheduled.
	readonly skip?: readonly string[]
}

// Options of scheduleSession.
export interface ScheduleOptions {
	// Overhead costs.
	readonly costs?: ScheduleCosts
	// Weather and safety exclusions.
	readonly exclusions?: readonly ScheduleExclusion[]
	// Meridian-flip geometry. Omitted means no flips.
	readonly meridian?: ScheduleMeridianPolicy
	// State at the session start.
	readonly initial?: ScheduleInitialState
}

// Overhead of a scheduled block or of the whole plan, in seconds per category.
export interface ScheduleOverhead {
	// Slew, settle and centering time.
	readonly slew: number
	// Filter-wheel change time.
	readonly filterChange: number
	// Autofocus time.
	readonly focus: number
	// Meridian-flip time.
	readonly meridianFlip: number
	// Frame readout time.
	readonly readout: number
	// Dither time.
	readonly dither: number
	// Sum of every category.
	readonly total: number
}

// Diagnostic flags of a scheduled block.
// partial: frames of the block remain after this chunk.
// meridianFlip: the block contains a meridian flip.
// filterChange: the block starts with a filter change.
// focus: the block starts with an autofocus run.
// unknownPointing: the slew cost assumed a worst-case PI-radian slew because the pointing was unknown.
// waited: the session idles before the block starts.
export type ScheduleBlockFlag = 'partial' | 'meridianFlip' | 'filterChange' | 'focus' | 'unknownPointing' | 'waited'

// One committed chunk of a block. Instants are in the time scale of the session start.
export interface ScheduledBlock {
	// Target identifier.
	readonly targetId: string
	// Block identifier.
	readonly blockId: string
	// Start of the setup (slew, flip, filter change, focus).
	readonly start: Time
	// Start of the first frame.
	readonly exposureStart: Time
	// End of the readout of the last frame.
	readonly end: Time
	// Number of frames in this chunk.
	readonly frames: number
	// Filter of the frames, when requested.
	readonly filter?: string
	// Total exposure time of the chunk, in seconds.
	readonly exposure: number
	// Overhead of the chunk.
	readonly overhead: ScheduleOverhead
	// Seconds the session idles between the previous block and this one.
	readonly idle: number
	// Start of the meridian flip, when the chunk contains one.
	readonly meridianFlip?: Time
	// Net score at selection: (priority-weighted acquisition seconds − displaced) per second elapsed from
	// the end of the previous block. Negative only when every alternative was worse.
	readonly score: number
	// Priority-weighted acquisition seconds this chunk was estimated at selection to make unreachable
	// for other blocks.
	readonly displaced: number
	// Diagnostic flags.
	readonly flags: readonly ScheduleBlockFlag[]
}

// Why frames of a block were not scheduled.
// skipped: listed in initial.skip.
// noWindow: no target window overlaps the session and the block's own time limits.
// excluded: every window is covered by exclusions of the block's scope.
// windowTooShort: no allowed interval fits the block even alone from the initial state.
// partial: some frames of a divisible block were scheduled, not all.
// conflict: the block fits alone but lost its time to other blocks or overhead.
export type UnscheduledReason = 'skipped' | 'noWindow' | 'excluded' | 'windowTooShort' | 'partial' | 'conflict'

// A block whose requested frames were not all scheduled.
export interface UnscheduledBlock {
	// Target identifier.
	readonly targetId: string
	// Block identifier.
	readonly blockId: string
	// Frames requested but not scheduled.
	readonly remainingFrames: number
	// Frames scheduled in this plan.
	readonly scheduledFrames: number
	// Reason code.
	readonly reason: UnscheduledReason
}

// Objective and time accounting of the plan. Durations are seconds.
export interface ScheduleDiagnostics {
	// Length of the session from its start to its end.
	readonly duration: number
	// Total exposure time.
	readonly exposure: number
	// Total overhead by category.
	readonly overhead: ScheduleOverhead
	// Session time spent neither exposing nor in overhead, end of night included.
	readonly idle: number
	// Exposure divided by duration, 0..1 (0 for an empty session).
	readonly efficiency: number
	// Sum over chunks of priority × frames × (exposure + readout), in priority-weighted seconds.
	readonly objective: number
	// Same sum over every requested remaining frame, the objective of a plan without conflicts.
	readonly maximumObjective: number
	// objective / maximumObjective, 1 when nothing was requested.
	readonly completeness: number
	// Number of meridian flips.
	readonly meridianFlips: number
	// Number of greedy steps.
	readonly iterations: number
}

// Chronological plan returned by scheduleSession.
export interface SessionSchedule {
	// Scheduled chunks in chronological, non-overlapping order.
	readonly blocks: readonly ScheduledBlock[]
	// Blocks with frames left unscheduled, in input order.
	readonly unscheduled: readonly UnscheduledBlock[]
	// Objective and time accounting.
	readonly diagnostics: ScheduleDiagnostics
}

// Time interval in seconds from the session start, with start < end.
interface Span {
	// First second of the interval.
	readonly start: number
	// Last second of the interval.
	readonly end: number
}

// Mutable per-block bookkeeping.
interface Entry {
	// Owning target.
	readonly target: ScheduleTarget
	// Requested block.
	readonly block: ScheduleBlockRequest
	// Whether the block needs the sky.
	readonly sky: boolean
	// Exposure plus readout of one frame, in seconds; always positive.
	readonly cycle: number
	// Frames between dithers; zero never dithers.
	readonly ditherEvery: number
	// Chronological intervals allowed for the whole block, setup included, after exclusions.
	readonly allowed: readonly Span[]
	// Whether any window survives the session and the block's own limits before exclusions.
	readonly hasWindow: boolean
	// Frames still to schedule.
	remaining: number
	// Frames scheduled so far in this plan.
	scheduled: number
}

// Simulated mount, filter and focus state between blocks.
interface MountState {
	// Seconds from the session start at which the mount becomes free.
	readonly time: number
	// Current pointing; undefined when unknown.
	readonly pointing?: SchedulePointing
	// Whether the mount is on the post-flip side for the current pointing.
	readonly postFlip: boolean
	// Current filter; undefined when unknown.
	readonly filter?: string
	// Seconds from the session start of the last autofocus; may be negative or undefined.
	readonly lastFocus?: number
}

// One evaluated placement of a block from a state. Instants are seconds from the session start and
// costs are seconds.
interface Placement {
	// Placed block.
	readonly entry: Entry
	// Start of the setup.
	readonly start: number
	// Start of the first frame.
	readonly exposureStart: number
	// End of the last readout.
	readonly end: number
	// Frames in the chunk.
	readonly frames: number
	// Start of the meridian flip (in the setup or between frames).
	readonly flip?: number
	// Slew and settle time.
	readonly slew: number
	// Filter-wheel change time.
	readonly filterChange: number
	// Whether the chunk changes filter, even when the change costs nothing.
	readonly changedFilter: boolean
	// Autofocus time.
	readonly focus: number
	// Meridian-flip time.
	readonly meridianFlip: number
	// Readout time.
	readonly readout: number
	// Dither time.
	readonly dither: number
	// Whether the slew cost assumed an unknown previous pointing.
	readonly unknownPointing: boolean
	// Priority × frames × (exposure + readout), in priority-weighted seconds.
	readonly value: number
	// State after the chunk.
	readonly after: MountState
}

// A placement with its look-ahead accounting.
interface Choice {
	// Evaluated placement.
	readonly placement: Placement
	// Priority-weighted seconds the other candidates can no longer achieve after it.
	readonly displaced: number
	// (value − displaced) / (end − current time).
	readonly score: number
}

// Absolute tolerance, in seconds, absorbing day-fraction roundoff when frames are fitted to an interval.
const FIT_EPSILON = 1e-6

// Allocates a session of exposure blocks.
// Parameters: targets are the candidates with windows, blocks and priorities. start and end bound the
// session (start is the replanning horizon); a non-positive session schedules nothing. options supplies
// costs, exclusions, meridian geometry and the initial state. Every block, its setup included, is
// placed inside one allowed interval of its target: setup (slew, pending flip, filter change, focus)
// happens with the target observable, so open notBefore early enough to absorb it. Autofocus and
// refocus decisions are made at block boundaries only. Returns the chronological plan with per-block
// overhead and flags, the unscheduled blocks with reasons, and objective diagnostics.
// Throws RangeError for duplicate block ids or a frame with no duration and TypeError for a frame
// count that is not a non-negative integer, which would misattribute progress, divide by zero, or
// schedule fractional frames.
export function scheduleSession(targets: readonly ScheduleTarget[], start: Time, end: Time, options: ScheduleOptions = {}): SessionSchedule {
	const costs = options.costs ?? {}
	const initial = options.initial ?? {}
	const slewRate = costs.slewRate ?? Number.POSITIVE_INFINITY
	const slewSettle = costs.slewSettle ?? 0
	const readout = costs.readout ?? 0
	const ditherCost = costs.dither ?? 0
	const filterChangeCost = costs.filterChange ?? 0
	const focusCost = costs.focus ?? 0
	const focusInterval = costs.focusInterval ?? Number.POSITIVE_INFINITY
	const focusOnFilterChange = costs.focusOnFilterChange ?? false
	const flipCost = costs.meridianFlip ?? 0
	const meridian = options.meridian
	const flipAt = meridian?.flipAt ?? 0

	// Seconds from the session start, in the start's time scale.
	const seconds = (time: Time) => timeSubtract(time, start, start.scale) * DAYSEC
	const duration = Math.max(0, seconds(end))
	// Apparent local sidereal time at the session start, extrapolated linearly by hourAngleAt.
	const localSiderealTimeAtStart = meridian === undefined ? 0 : greenwichApparentSiderealTime(start) + meridian.longitude
	// Hour angle in (-PI, PI] of a pointing at a time in seconds from the session start.
	const hourAngleAt = (time: number, pointing: SchedulePointing) => hourAngle(localSiderealTimeAtStart + SIDEREAL_DRIFT_RATE * time, pointing.rightAscension)

	const exclusions = options.exclusions ?? []
	const allExclusions = mergeSpans(exclusions.filter((e) => (e.scope ?? 'all') === 'all').map((e) => ({ start: seconds(e.start), end: seconds(e.end) })))
	const skyExclusions = mergeSpans(exclusions.map((e) => ({ start: seconds(e.start), end: seconds(e.end) })))
	const completed = initial.completedFrames ?? {}
	const skip = new Set(initial.skip)

	const entries: Entry[] = []
	const ids = new Set<string>()

	for (const target of targets) {
		const sky = target.sky ?? true
		const windows = target.windows.map((w) => ({ start: seconds(w.start), end: seconds(w.end) }))

		for (const block of target.blocks) {
			// Progress and skip lists are keyed by block id, so a duplicate would credit the wrong block.
			if (ids.has(block.id)) throw new RangeError(`duplicate block id: ${block.id}`)
			ids.add(block.id)
			validateNonNegativeInteger(block.count)
			const cycle = block.exposure + readout
			// Frame fitting divides by the frame cycle; a zero or NaN cycle would fit unbounded frames.
			if (!(cycle > 0)) throw new RangeError(`block ${block.id} has no frame duration`)

			const lower = Math.max(0, block.notBefore === undefined ? 0 : seconds(block.notBefore))
			const upper = Math.min(duration, block.notAfter === undefined ? duration : seconds(block.notAfter))
			const base = mergeSpans(windows.map((w) => ({ start: Math.max(w.start, lower), end: Math.min(w.end, upper) })))
			const allowed = subtractSpans(base, sky ? skyExclusions : allExclusions)
			const remaining = skip.has(block.id) ? 0 : Math.max(0, block.count - (completed[block.id] ?? 0))
			entries.push({ target, block, sky, cycle, ditherEvery: block.ditherEvery ?? 0, allowed, hasWindow: base.length > 0, remaining, scheduled: 0 })
		}
	}

	// Number of dithers inside a run of n frames: one after every ditherEvery frames, none after the last.
	// The cadence counts frames from the start of the chunk and continues across a flip inside it.
	const ditherCount = (entry: Entry, n: number) => (entry.ditherEvery > 0 && n > 0 ? Math.floor((n - 1) / entry.ditherEvery) : 0)
	// Duration of a run of n frames with readout and dithers, in seconds.
	const framesDuration = (entry: Entry, n: number) => n * entry.cycle + ditherCount(entry, n) * ditherCost
	// Start of frame k (0-based) relative to the first frame of a run without flip, in seconds: after k
	// frames and every dither due after them, including one due right after frame k.
	const frameStart = (entry: Entry, k: number) => k * entry.cycle + (entry.ditherEvery > 0 ? Math.floor(k / entry.ditherEvery) : 0) * ditherCost

	// Largest frame count, at most most, whose run fits in the available seconds. Capping at the requested
	// frames bounds the work, and capping at MAX_SAFE_INTEGER keeps n + 1 distinct from n, so a tiny frame
	// cycle in a long window cannot stall the off-by-one correction below.
	const fit = (entry: Entry, available: number, most: number) => {
		if (!(available >= -FIT_EPSILON)) return 0
		const cap = Math.min(most, Number.MAX_SAFE_INTEGER)
		const limit = available + FIT_EPSILON
		const m = entry.ditherEvery
		let n: number

		if (m > 0 && ditherCost > 0) {
			const group = m * entry.cycle + ditherCost
			const groups = Math.floor((available + ditherCost) / group)
			const rest = available - groups * group
			n = groups * m + (rest > 0 ? Math.floor(rest / entry.cycle) : 0)
		} else {
			n = Math.floor(available / entry.cycle)
		}

		n = Math.max(0, Math.min(cap, n))

		// The closed form may be off by one at floating-point boundaries.
		while (n < cap && framesDuration(entry, n + 1) <= limit) n++
		while (n > 0 && framesDuration(entry, n) > limit) n--
		return n
	}

	// Number of frames, at most most, whose exposure starts before an instant offset seconds after the
	// first frame.
	const framesStartedBefore = (entry: Entry, offset: number, most: number) => {
		if (!(offset > 0)) return 0
		const n = fit(entry, offset, most)
		return n < most && frameStart(entry, n) < offset ? n + 1 : n
	}

	// Frames of a block required in one chunk: all remaining ones unless the block is divisible.
	const requiredFrames = (entry: Entry) => (entry.block.divisible ? Math.min(entry.remaining, entry.block.minimumFrames ?? 1) : entry.remaining)

	// Earliest feasible placement of a block from a state, optionally ending by a deadline in seconds.
	const place = (entry: Entry, state: MountState, deadline: number = Number.POSITIVE_INFINITY): Placement | undefined => {
		const { block, target } = entry
		const need = requiredFrames(entry)
		const most = block.divisible ? Math.min(entry.remaining, block.maximumFrames ?? Number.POSITIVE_INFINITY) : entry.remaining
		if (!(need > 0) || most < need) return undefined

		const pointing = target.pointing
		const filterChanged = block.filter !== undefined && block.filter !== state.filter
		const filterChange = filterChanged ? filterChangeCost : 0

		for (const span of entry.allowed) {
			if (span.end <= state.time) continue
			if (span.start >= deadline) break

			const start = Math.max(span.start, state.time)
			let slew = 0
			let meridianFlip = 0
			let flip: number | undefined
			let unknownPointing = false
			let postFlip = state.postFlip

			if (pointing !== undefined) {
				const crossed = meridian !== undefined && hourAngleAt(start, pointing) >= flipAt

				if (state.pointing === undefined) {
					unknownPointing = true
					slew = slewSettle + PI / slewRate
					postFlip = crossed
				} else if (state.pointing.rightAscension !== pointing.rightAscension || state.pointing.declination !== pointing.declination) {
					slew = slewSettle + sphericalSeparation(state.pointing.rightAscension, state.pointing.declination, pointing.rightAscension, pointing.declination) / slewRate
					postFlip = crossed
				} else if (crossed && !postFlip) {
					// Same pointing still on the pre-flip side past the threshold: flip before exposing.
					meridianFlip = flipCost
					flip = start
					postFlip = true
				}
			}

			const focusNeeded = entry.sky && focusCost > 0 && (state.lastFocus === undefined || start - state.lastFocus >= focusInterval || (focusOnFilterChange && filterChanged))
			const focus = focusNeeded ? focusCost : 0
			const setupEnd = start + slew + meridianFlip + filterChange + focus
			let exposureStart = setupEnd
			let flipPending = false
			let before = 0

			if (meridian !== undefined && pointing !== undefined && !postFlip) {
				// Seconds from the end of the setup until the hour angle reaches the flip threshold.
				const untilFlip = (flipAt - hourAngleAt(setupEnd, pointing)) / SIDEREAL_DRIFT_RATE

				if (untilFlip > 0) {
					// Frames exposed before the threshold; the rest follow a flip inside the run.
					flipPending = true
					before = framesStartedBefore(entry, untilFlip, most)
				} else {
					// The threshold was reached during the slew, filter change or focus: flip before the first frame.
					meridianFlip += flipCost
					flip = setupEnd
					exposureStart += flipCost
					postFlip = true
				}
			}

			const available = Math.min(span.end, deadline) - exposureStart
			let frames = fit(entry, available, most)
			let flipInRun = false

			if (flipPending && frames > before) {
				// The flip replaces the start of frame before + 1, after any dither due there, and the dither
				// cadence continues across it, so the run only grows by the flip time.
				const withFlip = fit(entry, available - flipCost, most)

				if (withFlip > before) {
					frames = withFlip
					flip = exposureStart + frameStart(entry, before)
					flipInRun = true
					meridianFlip += flipCost
					postFlip = true
				} else {
					frames = before
				}
			}

			if (frames < need) continue

			const run = framesDuration(entry, frames) + (flipInRun ? flipCost : 0)
			const dithers = ditherCount(entry, frames)
			const blockEnd = exposureStart + run
			const value = target.priority * frames * entry.cycle

			const after: MountState = {
				time: blockEnd,
				pointing: pointing ?? state.pointing,
				postFlip,
				filter: block.filter ?? state.filter,
				lastFocus: focusNeeded ? setupEnd : state.lastFocus,
			}

			return { entry, start, exposureStart, end: blockEnd, frames, flip, slew, filterChange, changedFilter: filterChanged, focus, meridianFlip, readout: frames * readout, dither: dithers * ditherCost, unknownPointing, value, after }
		}

		return undefined
	}

	// Priority-weighted acquisition seconds a block can still achieve from a state. An indivisible block
	// achieves everything when it still has a placement and nothing otherwise. A divisible block sums the
	// frames fitting in each remaining allowed interval (chunks smaller than its minimum are worthless),
	// ignoring the setup of later chunks, capped at its remaining frames.
	const achievable = (entry: Entry, state: MountState) => {
		if (!entry.block.divisible) return place(entry, state) === undefined ? 0 : entry.target.priority * entry.remaining * entry.cycle

		const need = requiredFrames(entry)
		let frames = 0

		for (const span of entry.allowed) {
			if (span.end <= state.time) continue
			const fitting = fit(entry, span.end - Math.max(span.start, state.time), entry.remaining)
			if (fitting >= need) frames += fitting
			if (frames >= entry.remaining) break
		}

		return entry.target.priority * Math.min(frames, entry.remaining) * entry.cycle
	}

	const initialState: MountState = {
		time: 0,
		pointing: initial.pointing,
		postFlip: initial.postFlip ?? false,
		filter: initial.filter,
		lastFocus: initial.lastFocus === undefined ? undefined : seconds(initial.lastFocus),
	}

	// Feasibility verdicts before anything is committed, for the unscheduled reasons.
	const aloneFeasible = entries.map((entry) => place(entry, initialState) !== undefined)
	let maximumObjective = 0
	for (const entry of entries) maximumObjective += entry.target.priority * entry.remaining * entry.cycle

	const committed: Choice[] = []
	let state = initialState
	let iterations = 0

	while (true) {
		const candidates: Placement[] = []

		for (const entry of entries) {
			if (entry.remaining <= 0) continue
			const placement = place(entry, state)
			if (placement !== undefined) candidates.push(placement)
		}

		if (candidates.length === 0) break

		let earliest = Number.POSITIVE_INFINITY
		for (const candidate of candidates) earliest = Math.min(earliest, candidate.start)
		const baseline = candidates.map((c) => achievable(c.entry, state))
		let ready: Choice | undefined
		let best: Choice | undefined

		// Charges a variant of candidate i with what the other candidates can no longer achieve after it.
		const consider = (placement: Placement, i: number) => {
			let displaced = 0
			for (let j = 0; j < candidates.length; j++) if (j !== i) displaced += Math.max(0, baseline[j] - achievable(candidates[j].entry, placement.after))
			const choice: Choice = { placement, displaced, score: (placement.value - displaced) / (placement.end - state.time) }

			// Strict comparisons keep the earlier variant, in input order, among equal scores.
			if (best === undefined || isBetter(choice, best)) best = choice
			if (placement.start <= earliest + FIT_EPSILON && choice.score > 0 && (ready === undefined || isBetter(choice, ready))) ready = choice
		}

		for (let i = 0; i < candidates.length; i++) {
			const candidate = candidates[i]
			consider(candidate, i)
			if (!candidate.entry.block.divisible) continue

			// Truncations that end the chunk before another candidate would start.
			for (let j = 0; j < candidates.length; j++) {
				const deadline = candidates[j].start
				if (j === i || deadline <= candidate.start || deadline >= candidate.end) continue
				const shortened = place(candidate.entry, state, deadline)
				if (shortened !== undefined) consider(shortened, i)
			}
		}

		const choice = (ready ?? best)!
		const chosen = choice.placement
		chosen.entry.remaining -= chosen.frames
		chosen.entry.scheduled += chosen.frames
		committed.push(choice)
		state = chosen.after
		iterations++
	}

	// Time at a number of seconds from the session start, in the start's time scale.
	const toTime = (offset: number) => timeShift(start, offset / DAYSEC)
	const blocks: ScheduledBlock[] = []
	const totals = { slew: 0, filterChange: 0, focus: 0, meridianFlip: 0, readout: 0, dither: 0, total: 0 }
	let exposure = 0
	let objective = 0
	let meridianFlips = 0
	let previousEnd = 0

	// Remaining frames per entry after each chunk, to flag partial chunks in chronological order.
	const pending = new Map<Entry, number>()
	for (const entry of entries) pending.set(entry, entry.remaining + entry.scheduled)

	for (let i = 0; i < committed.length; i++) {
		const { placement: p, score, displaced } = committed[i]
		const overhead = { slew: p.slew, filterChange: p.filterChange, focus: p.focus, meridianFlip: p.meridianFlip, readout: p.readout, dither: p.dither, total: p.slew + p.filterChange + p.focus + p.meridianFlip + p.readout + p.dither }
		const left = pending.get(p.entry)! - p.frames
		pending.set(p.entry, left)

		const flags: ScheduleBlockFlag[] = []
		if (left > 0) flags.push('partial')
		if (p.flip !== undefined) flags.push('meridianFlip')
		if (p.changedFilter) flags.push('filterChange')
		if (p.focus > 0) flags.push('focus')
		if (p.unknownPointing) flags.push('unknownPointing')
		const idle = p.start - previousEnd
		if (idle > FIT_EPSILON) flags.push('waited')

		if (p.flip !== undefined) meridianFlips++

		blocks.push({
			targetId: p.entry.target.id,
			blockId: p.entry.block.id,
			start: toTime(p.start),
			exposureStart: toTime(p.exposureStart),
			end: toTime(p.end),
			frames: p.frames,
			filter: p.entry.block.filter,
			exposure: p.frames * p.entry.block.exposure,
			overhead,
			idle: Math.max(0, idle),
			meridianFlip: p.flip === undefined ? undefined : toTime(p.flip),
			score,
			displaced,
			flags,
		})

		totals.slew += overhead.slew
		totals.filterChange += overhead.filterChange
		totals.focus += overhead.focus
		totals.meridianFlip += overhead.meridianFlip
		totals.readout += overhead.readout
		totals.dither += overhead.dither
		totals.total += overhead.total
		exposure += p.frames * p.entry.block.exposure
		objective += p.value
		previousEnd = p.end
	}

	const unscheduled: UnscheduledBlock[] = []

	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i]
		const skipped = skip.has(entry.block.id)
		if (!skipped && entry.remaining <= 0) continue

		let reason: UnscheduledReason
		if (skipped) reason = 'skipped'
		else if (!entry.hasWindow) reason = 'noWindow'
		else if (entry.allowed.length === 0) reason = 'excluded'
		else if (entry.scheduled > 0) reason = 'partial'
		else if (!aloneFeasible[i]) reason = 'windowTooShort'
		else reason = 'conflict'

		const remainingFrames = skipped ? Math.max(0, entry.block.count - (completed[entry.block.id] ?? 0)) : entry.remaining
		unscheduled.push({ targetId: entry.target.id, blockId: entry.block.id, remainingFrames, scheduledFrames: entry.scheduled, reason })
	}

	return {
		blocks,
		unscheduled,
		diagnostics: {
			duration,
			exposure,
			overhead: totals,
			idle: Math.max(0, duration - exposure - totals.total),
			efficiency: duration > 0 ? exposure / duration : 0,
			objective,
			maximumObjective,
			completeness: maximumObjective > 0 ? objective / maximumObjective : 1,
			meridianFlips,
			iterations,
		},
	}
}

// Whether a choice has a strictly higher net score, or an equal one starting strictly earlier.
function isBetter(a: Choice, b: Choice) {
	return a.score > b.score || (a.score === b.score && a.placement.start < b.placement.start)
}

// Sorts spans by start, drops empty ones, and merges overlapping or touching ones. Returns a fresh array.
function mergeSpans(spans: readonly Span[]) {
	const sorted = spans.filter((s) => s.end > s.start).sort((a, b) => a.start - b.start)
	const merged: Span[] = []

	for (const span of sorted) {
		const last = merged.at(-1)
		if (last !== undefined && span.start <= last.end) merged[merged.length - 1] = { start: last.start, end: Math.max(last.end, span.end) }
		else merged.push(span)
	}

	return merged
}

// Removes the merged, chronological cut spans from the merged, chronological base spans. Returns a
// fresh chronological array without empty spans.
function subtractSpans(base: readonly Span[], cut: readonly Span[]) {
	const result: Span[] = []
	let j = 0

	for (const span of base) {
		let from = span.start
		while (j < cut.length && cut[j].end <= from) j++

		for (let k = j; k < cut.length && cut[k].start < span.end; k++) {
			if (cut[k].start > from) result.push({ start: from, end: cut[k].start })
			from = Math.max(from, cut[k].end)
		}

		if (span.end > from) result.push({ start: from, end: span.end })
	}

	return result
}
