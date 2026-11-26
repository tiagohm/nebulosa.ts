import { clamp } from '../../../math/numerical/math'
import { type Angle, normalizeAngle, normalizePI } from '../../../math/units/angle'

// Recent history of where a mount's optical axis actually pointed, so that a consumer integrating over
// an interval, such as a camera accumulating an exposure, can ask where the boresight was rather than
// only where it is now. Samples are held in ring buffers of a fixed capacity and interpolated
// linearly between distinct timestamps; equal timestamps preserve the two sides of an instantaneous
// jump. Times are milliseconds on the simulated clock and coordinates are radians.

// Rolling record of boresight samples. Parallel typed arrays rather than an array of objects, since
// this is written on every simulation tick and read in bulk.
export interface BoresightHistory {
	readonly times: Float64Array
	readonly rightAscensions: Float64Array
	readonly declinations: Float64Array
	// Samples recorded so far, saturating at the capacity once the ring wraps.
	count: number
	// Index the next sample will be written to.
	head: number
}

// Largest history that will be allocated, in samples. Three Float64 arrays, so this is 24 MB of ring
// buffer, already far beyond the longest exposure any simulated mount is stepped through at the tick
// rate. The cap exists because the capacity sizes three allocations, and an exported helper must not
// turn a caller's bad number into a RangeError from the typed-array constructor.
const MAX_BORESIGHT_HISTORY_CAPACITY = 1 << 20

// Allocates a history holding at most `capacity` samples, clamped to [2, MAX_BORESIGHT_HISTORY_CAPACITY]
// so that the history always has room for both sides of a jump and never for an absurd request. A
// capacity that is not a number at all is treated as the minimum: NaN reached the typed-array
// constructors as a zero length, and the ring arithmetic then divided by that length and left the head
// NaN, which is a history that silently retains nothing.
export function boresightHistory(capacity: number): BoresightHistory {
	const size = Number.isNaN(capacity) ? 2 : clamp(Math.trunc(capacity), 2, MAX_BORESIGHT_HISTORY_CAPACITY)
	return { times: new Float64Array(size), rightAscensions: new Float64Array(size), declinations: new Float64Array(size), count: 0, head: 0 }
}

// Appends a sample, overwriting the oldest once the ring is full. Callers must record in
// non-decreasing time order, which the simulation tick guarantees.
//
// A different sample landing on the newest timestamp is appended after it. The ordered pair is a
// discontinuity: an interval ending there sees the old side and one beginning there sees the new side,
// without spreading the jump over the preceding segment. An identical sample is ignored so the final
// recording of a split simulation step does not consume another slot.
export function recordBoresightSample(history: BoresightHistory, time: number, rightAscension: Angle, declination: Angle) {
	if (history.count > 0) {
		const newest = physicalIndex(history, history.count - 1)

		if (history.times[newest] === time && history.rightAscensions[newest] === rightAscension && history.declinations[newest] === declination) return
	}

	history.times[history.head] = time
	history.rightAscensions[history.head] = rightAscension
	history.declinations[history.head] = declination
	history.head = (history.head + 1) % history.times.length
	if (history.count < history.times.length) history.count++
}

// Forgets every recorded sample, as on a power cycle, where the previous run says nothing about the
// current one.
export function clearBoresightHistory(history: BoresightHistory) {
	history.count = 0
	history.head = 0
}

// Physical index of the logical sample `index`, counting 0 as the oldest retained sample.
function physicalIndex(history: BoresightHistory, index: number) {
	const capacity = history.times.length
	const oldest = history.count < capacity ? 0 : history.head
	return (oldest + index) % capacity
}

// Time span the history currently covers, as `[oldest, newest]` in milliseconds, or undefined when it
// holds nothing.
export function boresightHistorySpan(history: BoresightHistory): readonly [number, number] | undefined {
	if (history.count === 0) return undefined
	return [history.times[physicalIndex(history, 0)], history.times[physicalIndex(history, history.count - 1)]]
}

// Interpolates the boresight at `time`, writing `[rightAscension, declination]` into `out` and returning
// it, or undefined when the history is empty.
//
// Times outside the retained span are clamped to its ends rather than extrapolated: beyond the window
// the simulator genuinely does not know, and holding the nearest known direction understates the
// motion instead of inventing it. Right ascension is interpolated along the shorter arc, so a sample
// pair straddling zero behaves.
export function sampleBoresightAt(history: BoresightHistory, time: number, out: [Angle, Angle]): [Angle, Angle] | undefined {
	return sampleBoresightAtSide(history, time, true, out)
}

// Interpolates at `time`, choosing the state after an equal-timestamp jump when `rightSide` is true
// and the state before it otherwise. The returned tuple aliases `out`; an empty history returns
// undefined. This endpoint choice gives an exposure the new state at its opening instant and the old
// state at its closing instant, so a zero-duration configuration jump contributes no fictitious trail.
function sampleBoresightAtSide(history: BoresightHistory, time: number, rightSide: boolean, out: [Angle, Angle]): [Angle, Angle] | undefined {
	if (history.count === 0) return undefined

	const last = history.count - 1
	const first = physicalIndex(history, 0)

	if (time < history.times[first] || (time === history.times[first] && !rightSide)) {
		out[0] = history.rightAscensions[first]
		out[1] = history.declinations[first]
		return out
	}

	const newest = physicalIndex(history, last)

	if (time > history.times[newest] || (time === history.times[newest] && rightSide)) {
		out[0] = history.rightAscensions[newest]
		out[1] = history.declinations[newest]
		return out
	}

	// The boundary is the first sample after `time` on the right side and the first sample at or after it
	// on the left side. Equal timestamps are therefore resolved to the requested side of the jump.
	let low = 0
	let high = history.count

	while (low < high) {
		const middle = (low + high) >> 1
		const sampleTime = history.times[physicalIndex(history, middle)]
		if (sampleTime < time || (rightSide && sampleTime === time)) low = middle + 1
		else high = middle
	}

	if (!rightSide && low < history.count) {
		const at = physicalIndex(history, low)
		if (history.times[at] === time) {
			out[0] = history.rightAscensions[at]
			out[1] = history.declinations[at]
			return out
		}
	}

	const a = physicalIndex(history, low - 1)
	const b = physicalIndex(history, low)
	const span = history.times[b] - history.times[a]
	const fraction = (time - history.times[a]) / span

	out[0] = normalizeAngle(history.rightAscensions[a] + normalizePI(history.rightAscensions[b] - history.rightAscensions[a]) * fraction)
	out[1] = history.declinations[a] + (history.declinations[b] - history.declinations[a]) * fraction
	return out
}

// Samples an exported helper will actually take for a requested `count`, at least one.
//
// A count that is not a number is no instruction at all and is treated as the minimum. Left to flow
// through, NaN passed the size check against the output buffer, ran every loop zero times and came
// back as the number of samples written, so a caller reading that count indexed a buffer nothing had
// been written into. An infinite count survives here and is rejected by that size check instead.
function trajectorySampleCount(count: number) {
	return Number.isNaN(count) ? 1 : Math.max(1, Math.trunc(count))
}

// Samples `count` boresight positions evenly across `[startTime, endTime]`, writing them into `out` as
// consecutive right ascension and declination pairs.
//
// A single sample is taken at the midpoint of the interval rather than at its start, since that is the
// representative instant when the motion is not being resolved. Returns the number of pairs written,
// which is 0 when the history is empty or `out` is too small.
export function sampleBoresightTrajectory(history: BoresightHistory, startTime: number, endTime: number, count: number, out: Float64Array) {
	const samples = trajectorySampleCount(count)
	if (history.count === 0 || out.length < samples * 2) return 0

	const pair: [Angle, Angle] = [0, 0]

	if (samples === 1) {
		sampleBoresightAt(history, (startTime + endTime) / 2, pair)
		out[0] = pair[0]
		out[1] = pair[1]
		return 1
	}

	const step = (endTime - startTime) / (samples - 1)

	for (let i = 0; i < samples; i++) {
		sampleBoresightAtSide(history, startTime + step * i, i < samples - 1, pair)
		out[i * 2] = pair[0]
		out[i * 2 + 1] = pair[1]
	}

	return samples
}
