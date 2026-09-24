import { PIOVERTWO, TAU } from '../../core/constants'
import type { Writable } from '../../core/types'
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

// Sorts a copy by azimuth and, where two samples share an azimuth, keeps the higher minimum altitude.
function normalizedHorizon(samples: readonly HorizonSample[]) {
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

// Minimum altitude of a horizon mask at one azimuth.
// Parameters: samples are the mask, and may be empty or unordered. azimuth is radians. Returns the
// linearly interpolated minimum altitude. An empty mask returns −π/2, which clears every real target.
// A single sample is that altitude at every azimuth. Duplicate azimuths keep the higher altitude.
export function horizonMinimumAltitude(samples: readonly HorizonSample[], azimuth: Angle): Angle {
	const horizon = normalizedHorizon(samples)
	const first = horizon[0]
	if (first === undefined) return -PIOVERTWO
	if (horizon.length === 1) return first.minimumAltitude

	const target = normalizeAngle(azimuth)
	let previous = horizon.at(-1)
	if (previous === undefined) return first.minimumAltitude

	for (let i = 0; i < horizon.length; i++) {
		const next = horizon[i]
		if (next === undefined) continue

		const start = previous.azimuth
		const stop = next.azimuth <= start ? next.azimuth + TAU : next.azimuth
		const probe = target < start ? target + TAU : target

		if (probe >= start && probe <= stop) {
			const span = stop - start
			if (!(span > 0)) return Math.max(previous.minimumAltitude, next.minimumAltitude)
			const fraction = (probe - start) / span
			return previous.minimumAltitude + (next.minimumAltitude - previous.minimumAltitude) * fraction
		}

		previous = next
	}

	return first.minimumAltitude
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

// Clearance of one path sample: altitude minus the mask. Positive means the target is visible.
function clearance(sample: HorizontalPathSample, horizon: readonly HorizonSample[]) {
	return sample.altitude - horizonMinimumAltitude(horizon, sample.azimuth)
}

// Crossings of an alt/az path through a horizon mask.
// Parameters: path is the target's sampled trajectory. horizon is the mask. Returns the crossings in
// time order. `set` is a positive-to-negative clearance change (the target goes behind the mask) and
// `rise` is the opposite. A path of fewer than two samples has no segment to cross. The zero of each
// segment is refined by bisection on the segment fraction, so a mask that bends between the azimuth
// endpoints is honored rather than a straight clearance line that could miss it.
export function horizonCrossings(path: readonly HorizontalPathSample[], horizon: readonly HorizonSample[]): readonly HorizonCrossing[] {
	if (path.length < 2) return []
	const ordered = path.toSorted((a, b) => a.time - b.time)
	const crossings: HorizonCrossing[] = []

	for (let i = 0; i < ordered.length - 1; i++) {
		const from = ordered[i]
		const to = ordered[i + 1]
		if (from === undefined || to === undefined || !(to.time > from.time)) continue

		const startClearance = clearance(from, horizon)
		const endClearance = clearance(to, horizon)

		if (startClearance === 0) {
			const kind = endClearance < 0 ? 'set' : endClearance > 0 ? 'rise' : undefined
			if (kind !== undefined) crossings.push({ time: from.time, altitude: from.altitude, azimuth: normalizeAngle(from.azimuth), kind })
			continue
		}

		if ((startClearance > 0 && endClearance > 0) || (startClearance < 0 && endClearance < 0)) continue

		let low = 0
		let high = 1
		let lowClearance = startClearance

		for (let step = 0; step < 50; step++) {
			const mid = (low + high) * 0.5
			const value = clearance(pointOnSegment(from, to, mid), horizon)

			if (value === 0 || lowClearance === 0) {
				low = mid
				break
			}

			if (value > 0 === lowClearance > 0) {
				low = mid
				lowClearance = value
			} else {
				high = mid
			}
		}

		const point = pointOnSegment(from, to, low)
		crossings.push({ time: point.time, altitude: point.altitude, azimuth: point.azimuth, kind: startClearance > 0 ? 'set' : 'rise' })
	}

	return crossings
}
