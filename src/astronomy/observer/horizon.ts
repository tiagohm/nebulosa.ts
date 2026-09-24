import { PIOVERTWO, TAU } from '../../core/constants'
import type { Writable } from '../../core/types'
import { NumberComparator } from '../../core/util'
import { type Angle, normalizeAngle, normalizePI } from '../../math/units/angle'

// A local horizon mask: at each azimuth, the minimum altitude a target must clear. Altitudes and
// azimuths are radians. Azimuth is north through east and is interpolated on the circle, so the
// segment from the last sample back to the first is included. An empty mask does not obstruct
// anything. The obstruction search takes a sampled alt/az path and reports the instants it crosses
// behind that mask. The path samples must be dense enough that each step is the short azimuth arc.

// One azimuth and the altitude, in radians, a target must reach there to be clear of the horizon.
export interface HorizonSample {
	// Azimuth in radians, north through east.
	readonly azimuth: Angle
	// Minimum altitude in radians. A target below this altitude is obstructed at this azimuth.
	readonly minimumAltitude: Angle
}

// One point of a target's path across the local sky. Time is any uniform unit; only differences and
// the interpolation fraction are used, and the reported crossings keep that unit.
export interface HorizontalPathSample {
	// Time in the caller's unit. Samples are sorted by this value.
	readonly time: number
	// Geometric altitude in radians.
	readonly altitude: Angle
	// Azimuth in radians, north through east.
	readonly azimuth: Angle
}

// One crossing of a path through the horizon mask.
export interface HorizonCrossing {
	// Time of the crossing, in the path's unit.
	readonly time: number
	// Altitude at the crossing, in radians.
	readonly altitude: Angle
	// Azimuth at the crossing, in radians.
	readonly azimuth: Angle
	// `set` means the target is going behind the mask. `rise` means it is emerging.
	readonly kind: 'set' | 'rise'
}

// Prepares a horizon once by sorting normalized azimuths and keeping the higher duplicate altitude.
function prepareHorizonProfile(samples: readonly HorizonSample[]) {
	const copy = samples.map((sample) => ({ azimuth: normalizeAngle(sample.azimuth), minimumAltitude: sample.minimumAltitude }))
	copy.sort((a, b) => a.azimuth - b.azimuth || a.minimumAltitude - b.minimumAltitude)
	const unique: Writable<HorizonSample>[] = []

	for (let i = 0; i < copy.length; i++) {
		const sample = copy[i]
		if (sample === undefined) continue
		const previous = unique.at(-1)
		if (previous !== undefined && previous.azimuth === sample.azimuth) previous.minimumAltitude = Math.max(previous.minimumAltitude, sample.minimumAltitude)
		else unique.push({ azimuth: sample.azimuth, minimumAltitude: sample.minimumAltitude })
	}

	return unique
}

// Looks up a minimum altitude in a prepared circular profile using binary search. Azimuth is radians;
// an empty profile clears the full physical sky and a one-sample profile is constant.
function preparedMinimumAltitude(horizon: readonly HorizonSample[], azimuth: Angle): Angle {
	const first = horizon[0]
	if (first === undefined) return -PIOVERTWO
	if (horizon.length === 1) return first.minimumAltitude

	const target = normalizeAngle(azimuth)
	let low = 0
	let high = horizon.length

	while (low < high) {
		const middle = (low + high) >>> 1
		const sample = horizon[middle]
		if (sample !== undefined && sample.azimuth <= target) low = middle + 1
		else high = middle
	}

	const nextIndex = low === horizon.length ? 0 : low
	const previousIndex = nextIndex === 0 ? horizon.length - 1 : nextIndex - 1
	const previous = horizon[previousIndex]
	const next = horizon[nextIndex]
	if (previous === undefined || next === undefined) return first.minimumAltitude
	const start = previous.azimuth
	const stop = next.azimuth <= start ? next.azimuth + TAU : next.azimuth
	const probe = target < start ? target + TAU : target
	const span = stop - start
	if (!(span > 0)) return Math.max(previous.minimumAltitude, next.minimumAltitude)
	return previous.minimumAltitude + (next.minimumAltitude - previous.minimumAltitude) * ((probe - start) / span)
}

// Minimum altitude of a horizon mask at one azimuth.
// Parameters: samples are the mask, and may be empty or unordered. azimuth is radians. Returns the
// linearly interpolated minimum altitude. An empty mask returns −π/2, which clears every real target.
// A single sample is that altitude at every azimuth. Duplicate azimuths keep the higher altitude.
export function horizonMinimumAltitude(samples: readonly HorizonSample[], azimuth: Angle): Angle {
	return preparedMinimumAltitude(prepareHorizonProfile(samples), azimuth)
}

// Whether a target at this altitude and azimuth is above the horizon mask.
// Parameters: samples are the mask. altitude and azimuth are radians. Returns true when the altitude
// is at least the interpolated minimum. An empty mask returns true.
export function isAboveHorizon(samples: readonly HorizonSample[], altitude: Angle, azimuth: Angle): boolean {
	return altitude >= horizonMinimumAltitude(samples, azimuth)
}

// Shortest signed azimuth step from `from` to `to`, in (−π, π].
function shortAzimuthStep(from: Angle, to: Angle) {
	return normalizePI(to - from)
}

// Interpolates one segment at fraction f of its short azimuth arc and linear altitude and time.
function pointOnSegment(from: HorizontalPathSample, to: HorizontalPathSample, fraction: number) {
	return {
		time: from.time + (to.time - from.time) * fraction,
		altitude: from.altitude + (to.altitude - from.altitude) * fraction,
		azimuth: normalizeAngle(from.azimuth + shortAzimuthStep(from.azimuth, to.azimuth) * fraction),
	}
}

// Clearance of one path sample against a prepared mask. Positive means the target is visible.
function clearance(sample: HorizontalPathSample, horizon: readonly HorizonSample[]) {
	return sample.altitude - preparedMinimumAltitude(horizon, sample.azimuth)
}

// Fractions at which one short-arc path segment crosses horizon-profile knots. Endpoints are included,
// sorted, and unique so roots exactly on a knot are considered once.
function segmentFractions(from: HorizontalPathSample, to: HorizontalPathSample, horizon: readonly HorizonSample[]) {
	const start = normalizeAngle(from.azimuth)
	const step = shortAzimuthStep(from.azimuth, to.azimuth)
	const fractions = [0, 1]
	if (step === 0) return fractions

	for (let i = 0; i < horizon.length; i++) {
		const sample = horizon[i]
		if (sample === undefined) continue
		for (let turn = -1; turn <= 1; turn++) {
			const fraction = (sample.azimuth + turn * TAU - start) / step
			if (fraction > 0 && fraction < 1) fractions.push(fraction)
		}
	}

	fractions.sort(NumberComparator)
	let write = 1
	for (let read = 1; read < fractions.length; read++) if (fractions[read] !== fractions[write - 1]) fractions[write++] = fractions[read]
	fractions.length = write
	return fractions
}

// Appends a crossing unless the same instant was already emitted by an adjacent subsegment.
function appendCrossing(crossings: HorizonCrossing[], point: HorizontalPathSample, kind: HorizonCrossing['kind']): void {
	const previous = crossings.at(-1)
	if (previous !== undefined && previous.time === point.time) return
	crossings.push({ time: point.time, altitude: point.altitude, azimuth: normalizeAngle(point.azimuth), kind })
}

// Crossings of an alt/az path through a horizon mask.
// Parameters: path is the target's sampled trajectory. horizon is the mask. Returns the crossings in
// time order. `set` is a positive-to-negative clearance change (the target goes behind the mask) and
// `rise` is the opposite. A path of fewer than two samples has no segment to cross. Each path segment
// is subdivided at every horizon knot on its short azimuth arc. Within each resulting interval both
// the path and mask are linear, so its one possible root is solved directly and internal peaks or
// valleys can produce two crossings in the original segment. Exact-zero samples and plateaus are
// classified from the nearest nonzero clearance on both temporal sides.
export function horizonCrossings(path: readonly HorizontalPathSample[], horizon: readonly HorizonSample[]): readonly HorizonCrossing[] {
	if (path.length < 2) return []
	const ordered = path.toSorted((a, b) => a.time - b.time)
	const prepared = prepareHorizonProfile(horizon)
	const crossings: HorizonCrossing[] = []
	let previousPoint: HorizontalPathSample | undefined
	let previousClearance: number | undefined
	let lastNonzeroClearance: number | undefined
	let zeroStart: HorizontalPathSample | undefined

	for (let i = 0; i < ordered.length - 1; i++) {
		const from = ordered[i]
		const to = ordered[i + 1]
		if (from === undefined || to === undefined || !(to.time > from.time)) continue

		const fractions = segmentFractions(from, to, prepared)
		const points = fractions.map((fraction) => pointOnSegment(from, to, fraction))

		for (let j = 0; j < points.length; j++) {
			const point = points[j]
			if (point === undefined || (previousPoint !== undefined && point.time === previousPoint.time)) continue
			const currentClearance = clearance(point, prepared)

			if (currentClearance === 0) {
				zeroStart ??= point
			} else if (zeroStart !== undefined) {
				if (lastNonzeroClearance === undefined || lastNonzeroClearance > 0 !== currentClearance > 0) {
					appendCrossing(crossings, zeroStart, currentClearance > 0 ? 'rise' : 'set')
				}
				zeroStart = undefined
				lastNonzeroClearance = currentClearance
			} else if (previousPoint !== undefined && previousClearance !== undefined && previousClearance > 0 !== currentClearance > 0) {
				const fraction = Math.abs(previousClearance) / (Math.abs(previousClearance) + Math.abs(currentClearance))
				const root = pointOnSegment(previousPoint, point, fraction)
				appendCrossing(crossings, root, previousClearance > 0 ? 'set' : 'rise')
				lastNonzeroClearance = currentClearance
			} else {
				lastNonzeroClearance = currentClearance
			}

			previousPoint = point
			previousClearance = currentClearance
		}
	}

	return crossings
}
