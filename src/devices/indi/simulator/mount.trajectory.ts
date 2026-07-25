import { type Angle, normalizeAngle, normalizePI } from '../../../math/units/angle'

// Recent history of where a mount's optical axis actually pointed, so that a consumer integrating over
// an interval, such as a camera accumulating an exposure, can ask where the boresight was rather than
// only where it is now. Samples are held in ring buffers of a fixed capacity and interpolated
// linearly; times are milliseconds on the simulated clock and coordinates are radians.

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

// Allocates a history holding at most `capacity` samples. A capacity below one is raised to one, so
// the history always has room for the present.
export function boresightHistory(capacity: number): BoresightHistory {
	const size = Math.max(1, Math.trunc(capacity))
	return { times: new Float64Array(size), rightAscensions: new Float64Array(size), declinations: new Float64Array(size), count: 0, head: 0 }
}

// Appends a sample, overwriting the oldest once the ring is full. Callers must record in
// non-decreasing time order, which the simulation tick guarantees.
export function recordBoresightSample(history: BoresightHistory, time: number, rightAscension: Angle, declination: Angle) {
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

// Interpolates the boresight at `time`, writing `[rightAscension, declination]` into `o` and returning
// it, or undefined when the history is empty.
//
// Times outside the retained span are clamped to its ends rather than extrapolated: beyond the window
// the simulator genuinely does not know, and holding the nearest known direction understates the
// motion instead of inventing it. Right ascension is interpolated along the shorter arc, so a sample
// pair straddling zero behaves.
export function sampleBoresightAt(history: BoresightHistory, time: number, o: [Angle, Angle]): [Angle, Angle] | undefined {
	if (history.count === 0) return undefined

	const last = history.count - 1
	const first = physicalIndex(history, 0)

	if (time <= history.times[first]) {
		o[0] = history.rightAscensions[first]
		o[1] = history.declinations[first]
		return o
	}

	const newest = physicalIndex(history, last)

	if (time >= history.times[newest]) {
		o[0] = history.rightAscensions[newest]
		o[1] = history.declinations[newest]
		return o
	}

	// Binary search for the last sample at or before `time`; the times increase with the logical index.
	let low = 0
	let high = last

	while (high - low > 1) {
		const middle = (low + high) >> 1
		if (history.times[physicalIndex(history, middle)] <= time) low = middle
		else high = middle
	}

	const a = physicalIndex(history, low)
	const b = physicalIndex(history, high)
	const span = history.times[b] - history.times[a]
	const fraction = span > 0 ? (time - history.times[a]) / span : 0

	o[0] = normalizeAngle(history.rightAscensions[a] + normalizePI(history.rightAscensions[b] - history.rightAscensions[a]) * fraction)
	o[1] = history.declinations[a] + (history.declinations[b] - history.declinations[a]) * fraction
	return o
}

// Samples `count` boresight positions evenly across `[startTime, endTime]`, writing them into `out` as
// consecutive right ascension and declination pairs.
//
// A single sample is taken at the midpoint of the interval rather than at its start, since that is the
// representative instant when the motion is not being resolved. Returns the number of pairs written,
// which is 0 when the history is empty or `out` is too small.
export function sampleBoresightTrajectory(history: BoresightHistory, startTime: number, endTime: number, count: number, out: Float64Array) {
	const samples = Math.max(1, Math.trunc(count))
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
		sampleBoresightAt(history, startTime + step * i, pair)
		out[i * 2] = pair[0]
		out[i * 2 + 1] = pair[1]
	}

	return samples
}
