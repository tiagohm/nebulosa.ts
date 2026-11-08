import { ECLIPTIC_J2000_MATRIX, PI, TAU } from '../../core/constants'
import { type MutVec3, type Vec3, vecCross, vecDot, vecLength, vecMulScalar } from '../../math/linear-algebra/vec3'
import { hermiteVec3 } from '../../math/numerical/spline'
import type { Angle } from '../../math/units/angle'
import type { Distance } from '../../math/units/distance'
import { type Time, Timescale, tdb, timeShift, timeSubtract } from '../time/time'
import type { KeplerOrbit } from './asteroid'
import { conicClass, EQUATORIAL_TOLERANCE, type OrbitFailure, orbitStateAt, type ReferencePlane } from './mechanics'

// Bounded sampling of a two-body orbit for drawing and tabulation: the conic as a curve in geometric order
// (the whole ellipse, or a finite arc of an open orbit that never reaches its asymptotes) with its apsides
// and nodes, and the chronological states over an interval, refined until a cubic Hermite through
// neighboring states reproduces the exact state. Both stop at a hard point budget, so no input can make them
// allocate without bound. Positions are AU and velocities AU/day in the axes of the orbit's output frame
// (J2000 equatorial for the canonical models of mechanics.ts); every result is freshly allocated.

// Default largest number of points of a conic or of a state table.
export const ORBIT_SAMPLE_LIMIT = 2048

// Default largest sagitta of a drawn chord, relative to the distance of its midpoint from the center
// (1e-4 keeps an orbit 1000 px across within 0.1 px of the true curve).
export const CONIC_TOLERANCE = 1e-4

// Default largest position error of the Hermite interpolation between two consecutive states, relative to
// the distance from the center.
export const STATE_TOLERANCE = 1e-6

// Default outer radius of an open arc, in periapsis distances.
export const OPEN_ARC_RADIUS = 20

// Number of segments of the first, uniform pass before refinement.
const INITIAL_SEGMENTS = 64

// Smallest number of first-pass intervals per period of a bound orbit in sampleStates.
const PERIOD_SEGMENTS = 16

// Margin kept inside the asymptotic true anomaly of a hyperbola, radians, so the arc stays finite.
const ASYMPTOTE_MARGIN = 1e-6

// Options of sampleConic.
export interface ConicSampleOptions {
	// Plane whose line of nodes is marked (default the equator).
	readonly plane?: ReferencePlane
	// Largest distance from the center of an open arc, AU (default OPEN_ARC_RADIUS periapsis distances, never
	// below the periapsis distance).
	readonly maxRadius?: Distance
	// Largest relative sagitta (default CONIC_TOLERANCE).
	readonly tolerance?: number
	// Largest number of points, at least 3 (default ORBIT_SAMPLE_LIMIT).
	readonly maxPoints?: number
}

// Kind of a geometric point marked on a conic.
export type ConicMarkerKind = 'periapsis' | 'apoapsis' | 'ascendingNode' | 'descendingNode'

// A geometric point of a conic.
export interface ConicMarker {
	// What the point is.
	readonly kind: ConicMarkerKind
	// Position, AU, in the orbit's output frame.
	readonly position: MutVec3
}

// The curve of a conic.
export interface ConicSamples {
	// Whether the curve is a closed ellipse; its last point then repeats the first.
	readonly closed: boolean
	// Points in order of true anomaly, AU, in the orbit's output frame.
	readonly points: MutVec3[]
	// Apsides and nodes on the drawn curve: no periapsis on a circular orbit, no apoapsis on an open one, and no
	// node on an orbit in the plane or past the ends of an open arc.
	readonly markers: ConicMarker[]
	// Whether the point budget stopped the refinement before the tolerance was met.
	readonly truncated: boolean
}

// Options of sampleStates.
export interface StateSampleOptions {
	// Largest relative Hermite error (default STATE_TOLERANCE).
	readonly tolerance?: number
	// Largest number of states, at least 2 (default ORBIT_SAMPLE_LIMIT).
	readonly maxSamples?: number
	// Number of uniform intervals before refinement (default 32).
	readonly initialSamples?: number
	// Instants kept as samples when inside the interval, such as a periapsis passage.
	readonly markers?: readonly Time[]
}

// An exact state of a table.
export interface StateSample {
	// Instant, TDB.
	readonly time: Time
	// Position, AU, in the orbit's output frame.
	readonly position: MutVec3
	// Velocity, AU/day, in the orbit's output frame.
	readonly velocity: MutVec3
}

// A chronological table of exact states.
export interface StateSamples {
	readonly ok: true
	// States from the start to the end, in increasing time.
	readonly samples: StateSample[]
	// Whether the sample budget stopped the refinement before the tolerance was met.
	readonly truncated: boolean
}

// Samples the curve of `orbit` adaptively by true anomaly: a uniform pass, then repeated halving of every chord
// whose sagitta exceeds the tolerance, so the points crowd near the periapsis of an eccentric orbit. An open
// orbit is drawn between the true anomalies where it reaches `maxRadius`, strictly inside its asymptotes.
export function sampleConic(orbit: KeplerOrbit, options?: ConicSampleOptions): ConicSamples {
	const e = orbit.eccentricity
	const conic = conicClass(e)
	const closed = conic === 'circular' || conic === 'elliptic'
	const p = orbit.semiLatusRectum
	const q = p / (1 + e)
	const tolerance = options?.tolerance ?? CONIC_TOLERANCE
	const maxPoints = Math.max(3, options?.maxPoints ?? ORBIT_SAMPLE_LIMIT)

	let end = PI

	if (!closed) {
		const maxRadius = Math.max(q, options?.maxRadius ?? OPEN_ARC_RADIUS * q)
		// r(ν) = p/(1 + e cos ν) = R gives cos ν = (p/R − 1)/e, inside the asymptote acos(−1/e) for a finite R.
		const reach = Math.acos(Math.max(-1, Math.min(1, (p / maxRadius - 1) / e)))
		end = e > 1 ? Math.min(reach, Math.acos(-1 / e) - ASYMPTOTE_MARGIN) : Math.min(reach, PI - ASYMPTOTE_MARGIN)
	}

	const start = closed ? 0 : -end
	const stop = closed ? TAU : end
	const segments = Math.min(INITIAL_SEGMENTS, maxPoints - 1)

	let anomalies: number[] = []
	for (let k = 0; k <= segments; k++) anomalies.push(start + ((stop - start) * k) / segments)
	let points = anomalies.map((v) => orbit.positionAtTrueAnomaly(v))
	let truncated = false

	for (let refining = true; refining;) {
		refining = false
		const nextAnomalies: number[] = [anomalies[0]]
		const nextPoints: MutVec3[] = [points[0]]

		for (let k = 1; k < anomalies.length; k++) {
			const a = points[k - 1]
			const b = points[k]
			const middle = (anomalies[k - 1] + anomalies[k]) / 2
			const m = orbit.positionAtTrueAnomaly(middle)
			const sagitta = Math.hypot(m[0] - (a[0] + b[0]) / 2, m[1] - (a[1] + b[1]) / 2, m[2] - (a[2] + b[2]) / 2)

			if (sagitta > tolerance * vecLength(m)) {
				if (nextPoints.length + (anomalies.length - k) + 1 > maxPoints) truncated = true
				else {
					nextAnomalies.push(middle)
					nextPoints.push(m)
					refining = true
				}
			}

			nextAnomalies.push(anomalies[k])
			nextPoints.push(b)
		}

		anomalies = nextAnomalies
		points = nextPoints
	}

	// The closing point repeats the first exactly, so the polyline closes without a gap.
	if (closed) points[points.length - 1] = points[0].slice() as MutVec3

	return { closed, points, markers: conicMarkers(orbit, closed, conic === 'circular', start, stop, options?.plane ?? 'equator'), truncated }
}

// Apsides and nodes of `orbit` on the drawn range of true anomaly [`start`, `stop`].
function conicMarkers(orbit: KeplerOrbit, closed: boolean, circular: boolean, start: Angle, stop: Angle, plane: ReferencePlane) {
	const markers: ConicMarker[] = []

	if (!circular) markers.push({ kind: 'periapsis', position: orbit.positionAtTrueAnomaly(0) })
	if (closed && !circular) markers.push({ kind: 'apoapsis', position: orbit.positionAtTrueAnomaly(PI) })

	// The plane's pole in the orbit's axes: +Z, or the ecliptic pole (the third row of the equator → ecliptic rotation).
	const pole: Vec3 = plane === 'ecliptic' ? [ECLIPTIC_J2000_MATRIX[6], ECLIPTIC_J2000_MATRIX[7], ECLIPTIC_J2000_MATRIX[8]] : [0, 0, 1]
	const h = vecCross(orbit.position, orbit.velocity)
	const hHat = vecMulScalar(h, 1 / vecLength(h))
	const line = vecCross(pole, hHat)

	if (vecLength(line) > EQUATORIAL_TOLERANCE) {
		// True anomaly of the ascending node in the orbit's own parameterization, measured from its ν = 0 point.
		const origin = orbit.positionAtTrueAnomaly(0)
		const ascending = Math.atan2(vecDot(hHat, vecCross(origin, line)), vecDot(origin, line))

		for (const [kind, v] of [
			['ascendingNode', ascending],
			['descendingNode', ascending + PI],
		] as const) {
			const anomaly = closed ? v : Math.atan2(Math.sin(v), Math.cos(v))
			if (closed || (anomaly > start && anomaly < stop)) markers.push({ kind, position: orbit.positionAtTrueAnomaly(anomaly) })
		}
	}

	return markers
}

// Exact chronological states of `orbit` from `start` to `end` (both kept, with every marker inside the
// interval): a uniform pass, then repeated halving of every interval where the cubic Hermite through its end
// states (positions and velocities over the interval in days) misses the exact middle state by more than the
// tolerance relative to the distance from the center. A failure of any evaluation fails the whole table, so a
// table never has a gap. An `end` not after `start` gives the single state at `start`.
export function sampleStates(orbit: KeplerOrbit, start: Time, end: Time, options?: StateSampleOptions): StateSamples | OrbitFailure {
	const origin = tdb(start)
	const duration = timeSubtract(end, origin, Timescale.TDB)
	const tolerance = options?.tolerance ?? STATE_TOLERANCE
	const maxSamples = Math.max(2, options?.maxSamples ?? ORBIT_SAMPLE_LIMIT)

	if (!(duration > 0)) {
		const state = orbitStateAt(orbit, origin)
		return state.ok ? { ok: true, samples: [{ time: origin, position: state.position, velocity: state.velocity }], truncated: false } : state
	}

	// A bound orbit starts with at least PERIOD_SEGMENTS intervals per period, so an interval never spans a whole
	// revolution, where both ends coincide and the Hermite check would alias.
	const period = orbit.periodInDays
	const perPeriod = Number.isFinite(period) ? Math.ceil((PERIOD_SEGMENTS * duration) / period) : 0
	const intervals = Math.max(1, Math.min(Math.max(options?.initialSamples ?? 32, perPeriod), maxSamples - 1))
	const offsets = new Set<number>()
	for (let k = 0; k <= intervals; k++) offsets.add((duration * k) / intervals)

	for (const marker of options?.markers ?? []) {
		const offset = timeSubtract(marker, origin, Timescale.TDB)
		if (offset > 0 && offset < duration && offsets.size < maxSamples) offsets.add(offset)
	}

	let samples: StateSample[] = []

	for (const offset of [...offsets].sort((a, b) => a - b)) {
		const state = stateAtOffset(orbit, origin, offset)
		if (!state.ok) return state
		samples.push(state.sample)
	}

	// Offsets (days from the start) of every sample, parallel to `samples`.
	let times = [...offsets].sort((a, b) => a - b)
	// Whether the interval ending at each sample already meets the tolerance.
	let settled = times.map(() => false)
	let truncated = false
	const middle: MutVec3 = [0, 0, 0]

	for (let refining = true; refining;) {
		refining = false
		const nextSamples: StateSample[] = [samples[0]]
		const nextTimes = [times[0]]
		const nextSettled = [true]

		for (let k = 1; k < samples.length; k++) {
			if (!settled[k]) {
				const a = samples[k - 1]
				const b = samples[k]
				const width = times[k] - times[k - 1]
				const state = stateAtOffset(orbit, origin, times[k - 1] + width / 2)
				if (!state.ok) return state

				const exact = state.sample.position
				hermiteVec3(a.position, a.velocity, b.position, b.velocity, width, 0.5, middle)
				const error = Math.hypot(middle[0] - exact[0], middle[1] - exact[1], middle[2] - exact[2])

				if (error > tolerance * vecLength(exact)) {
					if (nextSamples.length + (samples.length - k) + 1 > maxSamples) {
						truncated = true
					} else {
						nextSamples.push(state.sample)
						nextTimes.push(times[k - 1] + width / 2)
						nextSettled.push(false)
						nextSamples.push(b)
						nextTimes.push(times[k])
						nextSettled.push(false)
						refining = true
						continue
					}
				}
			}

			nextSamples.push(samples[k])
			nextTimes.push(times[k])
			nextSettled.push(true)
		}

		samples = nextSamples
		times = nextTimes
		settled = nextSettled
	}

	return { ok: true, samples, truncated }
}

// Exact state of `orbit` at `offset` days after `origin` (TDB), as a sample or the failure of the evaluation.
function stateAtOffset(orbit: KeplerOrbit, origin: Time, offset: number) {
	const time = timeShift(origin, offset)
	const state = orbitStateAt(orbit, time)
	return state.ok ? ({ ok: true, sample: { time, position: state.position, velocity: state.velocity } } as const) : state
}
