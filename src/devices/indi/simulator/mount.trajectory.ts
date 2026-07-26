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
//
// A sample landing on the instant already at the head replaces it rather than joining it. The history
// is read as a function of time, and two positions under one timestamp make it ambiguous: a lookup at
// or before that instant answered with the position that had been superseded, so an exposure beginning
// there was drawn as a trail from where the boresight used to be. That happens whenever the optical
// axis moves without the clock advancing, which is what switching a pointing error on does.
export function recordBoresightSample(history: BoresightHistory, time: number, rightAscension: Angle, declination: Angle) {
	if (history.count > 0) {
		const newest = physicalIndex(history, history.count - 1)

		if (history.times[newest] === time) {
			history.rightAscensions[newest] = rightAscension
			history.declinations[newest] = declination
			return
		}
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

// Length of the path the boresight swept across `[startTime, endTime]`, radians on the sky.
//
// Summed over every recorded sample inside the window, plus the interpolated endpoints, rather than
// over a grid of a fixed size. That is what makes it immune to aliasing: an evenly spaced probe can
// land on the same phase of a periodic error every time and measure a field that oscillated across the
// sensor as having stood still, whereas the recorded samples are the finest the simulation ever knew.
//
// Small-angle throughout, which holds for the arcseconds of a trail: the right-ascension difference is
// scaled by the cosine of the declination so that the result is a length on the sky rather than in
// coordinate units. Returns 0 when the history is empty or the interval is not positive.
export function boresightPathLength(history: BoresightHistory, startTime: number, endTime: number): Angle {
	if (history.count === 0 || endTime <= startTime) return 0

	const pair: [Angle, Angle] = [0, 0]
	if (sampleBoresightAt(history, startTime, pair) === undefined) return 0

	let previousRightAscension = pair[0]
	let previousDeclination = pair[1]
	let length = 0

	// Walks the retained samples in time order, taking only those strictly inside the window; the two
	// endpoints are interpolated so a window falling between samples still measures its own share.
	for (let i = 0; i < history.count; i++) {
		const index = physicalIndex(history, i)
		const time = history.times[index]
		if (time <= startTime) continue
		if (time >= endTime) break

		const rightAscension = history.rightAscensions[index]
		const declination = history.declinations[index]
		length += segmentLength(previousRightAscension, previousDeclination, rightAscension, declination)
		previousRightAscension = rightAscension
		previousDeclination = declination
	}

	sampleBoresightAt(history, endTime, pair)
	return length + segmentLength(previousRightAscension, previousDeclination, pair[0], pair[1])
}

// Angular distance between two nearby directions, radians, in the small-angle approximation used by
// `boresightPathLength`. The declination of the midpoint scales the right-ascension difference.
function segmentLength(rightAscensionA: Angle, declinationA: Angle, rightAscensionB: Angle, declinationB: Angle): Angle {
	const deltaDeclination = declinationB - declinationA
	const deltaRightAscension = normalizePI(rightAscensionB - rightAscensionA) * Math.cos((declinationA + declinationB) / 2)
	return Math.hypot(deltaRightAscension, deltaDeclination)
}

// Samples `count` boresight positions across `[startTime, endTime]`, spaced by equal path length
// rather than by equal time, writing right ascension, declination and weight triples into `out`.
//
// Spacing them evenly in time resolves the trail only where the motion is evenly spread. A dither, a
// guide correction or any brief out-and-back excursion inside a long exposure falls between uniform
// samples, so the trail it left is missing from the frame however many samples were asked for; placing
// the samples along the path instead puts them where the motion is, by construction.
//
// The weight is the share of the exposure the boresight spent within the stretch of path that sample
// stands for, and the weights sum to one. It is what keeps the photometry right once the samples are
// no longer evenly spaced: a trail is brighter where the mount lingered, and an excursion it spent a
// moment on is faint. A consumer must scale each sample's flux by it rather than dividing the total by
// the sample count.
//
// A single sample is taken at the midpoint of the interval and carries the whole weight. Returns the
// number of triples written, which is 0 when the history is empty or `out` is too small.
export function sampleBoresightPath(history: BoresightHistory, startTime: number, endTime: number, count: number, out: Float64Array) {
	const samples = Math.max(1, Math.trunc(count))
	if (history.count === 0 || out.length < samples * 3) return 0

	const pair: [Angle, Angle] = [0, 0]

	if (samples === 1) {
		sampleBoresightAt(history, (startTime + endTime) / 2, pair)
		out[0] = pair[0]
		out[1] = pair[1]
		out[2] = 1
		return 1
	}

	const span = endTime - startTime
	const total = boresightPathLength(history, startTime, endTime)

	// The times are laid down first, in the slot the weight will take, because the positions are read
	// from them and the weights are then measured along the path rather than from the times at all.
	if (total > 0) markEqualPathTimes(history, startTime, endTime, samples, total, out)
	else for (let i = 0; i < samples; i++) out[i * 3 + 2] = startTime + (span / (samples - 1)) * i

	for (let i = 0; i < samples; i++) {
		sampleBoresightAt(history, out[i * 3 + 2], pair)
		out[i * 3] = pair[0]
		out[i * 3 + 1] = pair[1]
		out[i * 3 + 2] = 0
	}

	if (total > 0 && span > 0) {
		accumulatePathDwell(history, startTime, endTime, samples, total, out)
		for (let i = 0; i < samples; i++) out[i * 3 + 2] /= span
	} else {
		for (let i = 0; i < samples; i++) out[i * 3 + 2] = 1 / samples
	}

	return samples
}

// Adds to `out[i * 3 + 2]` the time, in milliseconds, that the boresight spent within the stretch of
// path that sample i stands for, which is the half step of arc length on either side of it.
//
// Time, not arc length, because that is what an exposure integrates: a field resting at one end of a
// trail deposits light there for as long as it rests, however short the path around that point is.
// Dividing the interval up by the sample times instead would hand each of the two long stationary
// stretches half of its duration to the sample at the far end of it — a dither lasting one per cent of
// an exposure came out a quarter as bright as the star itself.
//
// Within one recorded segment the boresight moves at a constant rate, so its duration is split between
// the stretches it crosses in proportion to the arc in each; a segment that does not move at all
// deposits its whole duration on the stretch it sits in.
function accumulatePathDwell(history: BoresightHistory, startTime: number, endTime: number, samples: number, total: number, out: Float64Array) {
	const pair: [Angle, Angle] = [0, 0]
	sampleBoresightAt(history, startTime, pair)

	const step = total / (samples - 1)
	let previousRightAscension = pair[0]
	let previousDeclination = pair[1]
	let segmentStartTime = startTime
	let travelled = 0

	for (let i = 0; i <= history.count; i++) {
		let time: number
		let rightAscension: Angle
		let declination: Angle

		if (i === history.count) {
			time = endTime
			sampleBoresightAt(history, endTime, pair)
			rightAscension = pair[0]
			declination = pair[1]
		} else {
			const index = physicalIndex(history, i)
			time = history.times[index]
			if (time <= segmentStartTime || time >= endTime) continue
			rightAscension = history.rightAscensions[index]
			declination = history.declinations[index]
		}

		const length = segmentLength(previousRightAscension, previousDeclination, rightAscension, declination)
		const duration = time - segmentStartTime

		if (duration > 0) {
			if (length > 0) {
				const end = travelled + length
				let arc = travelled

				while (arc < end) {
					const index = dwellIndex(arc, step, samples)
					const boundary = Math.min(end, (index + 0.5) * step)
					// Never below `arc`, so a stretch boundary landing exactly on it cannot stall the walk.
					const next = boundary > arc ? boundary : Math.min(end, arc + step * 0.5)
					out[index * 3 + 2] += (duration * (next - arc)) / length
					arc = next
				}
			} else {
				out[dwellIndex(travelled, step, samples) * 3 + 2] += duration
			}
		}

		travelled += length
		previousRightAscension = rightAscension
		previousDeclination = declination
		segmentStartTime = time
	}
}

// Sample whose stretch of path contains the arc length `travelled`, given a spacing of `step` and
// `samples` samples. The stretches meet halfway between neighbours, so the nearest sample owns it.
function dwellIndex(travelled: number, step: number, samples: number) {
	return Math.min(samples - 1, Math.max(0, Math.round(travelled / step)))
}

// Writes into `out[i * 3 + 2]` the times at which the boresight had travelled i/(samples - 1) of
// `total`, walking the recorded samples of `[startTime, endTime]` once.
//
// The history interpolates linearly between samples, so time runs linearly along each segment and the
// crossing is found by proportion within it. Targets left unreached by rounding are clamped to the end
// of the interval, where they take a zero weight and change nothing.
function markEqualPathTimes(history: BoresightHistory, startTime: number, endTime: number, samples: number, total: number, out: Float64Array) {
	const pair: [Angle, Angle] = [0, 0]
	sampleBoresightAt(history, startTime, pair)

	const step = total / (samples - 1)
	let previousRightAscension = pair[0]
	let previousDeclination = pair[1]
	let segmentStartTime = startTime
	let travelled = 0
	let target = 1

	out[2] = startTime

	for (let i = 0; i <= history.count; i++) {
		let time: number
		let rightAscension: Angle
		let declination: Angle

		// The last pass closes the walk on the end of the interval rather than on a recorded sample.
		if (i === history.count) {
			time = endTime
			sampleBoresightAt(history, endTime, pair)
			rightAscension = pair[0]
			declination = pair[1]
		} else {
			const index = physicalIndex(history, i)
			time = history.times[index]
			if (time <= segmentStartTime) continue
			if (time >= endTime) continue
			rightAscension = history.rightAscensions[index]
			declination = history.declinations[index]
		}

		const length = segmentLength(previousRightAscension, previousDeclination, rightAscension, declination)

		while (target < samples - 1 && travelled + length >= target * step) {
			const fraction = length > 0 ? (target * step - travelled) / length : 0
			out[target * 3 + 2] = segmentStartTime + (time - segmentStartTime) * fraction
			target++
		}

		travelled += length
		previousRightAscension = rightAscension
		previousDeclination = declination
		segmentStartTime = time
	}

	while (target < samples - 1) out[target++ * 3 + 2] = endTime
	out[(samples - 1) * 3 + 2] = endTime
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
