import {
	GM_EARTH_DE440_KM3_S2,
	GM_JUPITER_SYSTEM_KM3_S2,
	GM_MARS_SYSTEM_KM3_S2,
	GM_MERCURY_KM3_S2,
	GM_MOON_KM3_S2,
	GM_NEPTUNE_SYSTEM_KM3_S2,
	GM_PLUTO_SYSTEM_KM3_S2,
	GM_SATURN_SYSTEM_KM3_S2,
	GM_SUN_DE440_KM3_S2,
	GM_URANUS_SYSTEM_KM3_S2,
	GM_VENUS_KM3_S2,
	MU_KM3_S2_TO_AU3_D2,
	SPEED_OF_LIGHT_AU_DAY,
} from '../../../core/constants'
import type { MutVec3, Vec3 } from '../../../math/linear-algebra/vec3'
import type { PositionAndVelocityMut } from '../../coordinates/astrometry'
import type { EphemerisSource } from '../../ephemeris/source'
import { type Time, Timescale, tdb, time } from '../../time/time'

// Numerical propagation of a small body (asteroid or comet) as a massless particle in the field of point masses
// whose states an EphemerisSource gives: the Sun, the planets, the Moon, and optionally the most massive asteroids,
// plus the Sun's post-Newtonian (Schwarzschild, PPN β = γ = 1) term and the Marsden-style non-gravitational
// accelerations of an orbit solution. The equations of motion are integrated in barycentric ICRF axes with an
// adaptive Bulirsch-Stoer extrapolation of the Gragg modified midpoint rule. Positions are AU, velocities AU/day,
// gravitational parameters AU³/day², times TDB days from the epoch. Each force evaluation reads every perturber from the
// source, so the source must stay usable (its kernels open) for as long as the propagator advances. Integration
// workspaces are allocated once per propagator; each source state it reads is a fresh allocation of the source.

// A gravitating body of the force model: its NAIF code in the ephemeris source and its gravitational parameter.
export interface PointMassPerturber {
	// NAIF code of the body whose barycentric state the source gives, such as 10 for the Sun or 5 for the Jupiter barycenter.
	readonly naif: number
	// Gravitational parameter, AU³/day².
	readonly gm: number
}

// Radial distance law g(r) that scales the non-gravitational coefficients: `asteroid` is the (1 AU / r)² of the
// Yarkovsky transverse acceleration (Farnocchia et al. 2013), `comet` the water-sublimation law of Marsden, Sekanina
// and Yeomans (1973), normalized to 1 at 1 AU.
export type NonGravitationalModel = 'asteroid' | 'comet'

// Non-gravitational acceleration of an orbit solution: A1·g(r) along the heliocentric radius, A2·g(r) along the
// transverse direction (in the orbital plane, perpendicular to the radius, toward the motion), and A3·g(r) along the
// orbit normal (angular momentum).
export interface NonGravitationalParameters {
	// Distance law of the coefficients.
	readonly model: NonGravitationalModel
	// Radial coefficient A1, AU/day².
	readonly a1: number
	// Transverse coefficient A2, AU/day².
	readonly a2: number
	// Normal coefficient A3, AU/day².
	readonly a3: number
}

// Forces acting on the particle.
export interface SmallBodyForceModel {
	// Point masses, each read from the source at every force evaluation. Must not include the particle itself, such as a
	// perturbing asteroid propagated from its own state.
	readonly perturbers: readonly PointMassPerturber[]
	// Whether to add the Sun's post-Newtonian term; the Sun's state and GM are those of NAIF 10 in `perturbers`.
	readonly relativity: boolean
	// Non-gravitational acceleration, relative to the Sun of the source; none when absent.
	readonly nonGravitational?: NonGravitationalParameters
}

// Integration controls.
export interface SmallBodyPropagatorOptions {
	// Relative tolerance of the position at the end of a step, against the extrapolation of the previous column. Default
	// 1e-13, which keeps the integration error below a meter per year for typical asteroids.
	readonly tolerance?: number
	// Largest step, days. Default 32.
	readonly maxStep?: number
	// Largest distance the particle may move relative to any perturber (the Sun included) in one step, as a fraction of
	// its distance to that perturber, from their relative speed at the start of the step. Ties the spacing of the
	// accepted steps to the encounter timescale distance / relative speed, which changes smoothly from step to step even
	// on the near-rectilinear approach of a planetary flyby, as interpolated tables of the steps need; for a circular
	// orbit it bounds the angle turned per step in radians. No bound when absent.
	readonly maxRelativeStep?: number
	// Called after each accepted step with the instant reached (TDB) and the barycentric state there: position AU in
	// state[0..2], velocity AU/day in state[3..5]. The array is the propagator's own buffer, valid only during the call.
	readonly onStep?: (time: Time, state: Float64Array) => void
}

// Barycentric gravitational parameters of JPL DE440 for the bodies of a DE440-family planetary kernel: the Sun, the
// Mercury and Venus barycenters, the Earth and the Moon apart, and the barycenters of the other planetary systems.
export const DE440_PERTURBERS: readonly PointMassPerturber[] = [
	{ naif: 10, gm: GM_SUN_DE440_KM3_S2 * MU_KM3_S2_TO_AU3_D2 },
	{ naif: 1, gm: GM_MERCURY_KM3_S2 * MU_KM3_S2_TO_AU3_D2 },
	{ naif: 2, gm: GM_VENUS_KM3_S2 * MU_KM3_S2_TO_AU3_D2 },
	{ naif: 399, gm: GM_EARTH_DE440_KM3_S2 * MU_KM3_S2_TO_AU3_D2 },
	{ naif: 301, gm: GM_MOON_KM3_S2 * MU_KM3_S2_TO_AU3_D2 },
	{ naif: 4, gm: GM_MARS_SYSTEM_KM3_S2 * MU_KM3_S2_TO_AU3_D2 },
	{ naif: 5, gm: GM_JUPITER_SYSTEM_KM3_S2 * MU_KM3_S2_TO_AU3_D2 },
	{ naif: 6, gm: GM_SATURN_SYSTEM_KM3_S2 * MU_KM3_S2_TO_AU3_D2 },
	{ naif: 7, gm: GM_URANUS_SYSTEM_KM3_S2 * MU_KM3_S2_TO_AU3_D2 },
	{ naif: 8, gm: GM_NEPTUNE_SYSTEM_KM3_S2 * MU_KM3_S2_TO_AU3_D2 },
	{ naif: 9, gm: GM_PLUTO_SYSTEM_KM3_S2 * MU_KM3_S2_TO_AU3_D2 },
]

// The 16 most massive main-belt asteroids of the JPL perturber file SB441-N16 (sb441-n16.bsp), by their NAIF codes in
// that file (2000000 + number) and their DE441 gravitational parameters, AU³/day², from Table 1 of Farnocchia (2021),
// JPL IOM 392R-21-005.
export const SB441_N16_PERTURBERS: readonly PointMassPerturber[] = [
	{ naif: 2000001, gm: 1.396451812308107e-13 }, // (1) Ceres
	{ naif: 2000004, gm: 3.8548000225257904e-14 }, // (4) Vesta
	{ naif: 2000002, gm: 3.04711463300432e-14 }, // (2) Pallas
	{ naif: 2000010, gm: 1.254253076164081e-14 }, // (10) Hygiea
	{ naif: 2000511, gm: 8.6836253492286545e-15 }, // (511) Davida
	{ naif: 2000704, gm: 6.3110343420878887e-15 }, // (704) Interamnia
	{ naif: 2000052, gm: 5.9824315264869841e-15 }, // (52) Europa
	{ naif: 2000087, gm: 4.8345606546105521e-15 }, // (87) Sylvia
	{ naif: 2000015, gm: 4.5107799051436795e-15 }, // (15) Eunomia
	{ naif: 2000003, gm: 4.2823439677995011e-15 }, // (3) Juno
	{ naif: 2000016, gm: 3.5445002842488978e-15 }, // (16) Psyche
	{ naif: 2000107, gm: 3.2191392075878588e-15 }, // (107) Camilla
	{ naif: 2000088, gm: 2.6529436610356353e-15 }, // (88) Thisbe
	{ naif: 2000007, gm: 2.5416014973471498e-15 }, // (7) Iris
	{ naif: 2000031, gm: 2.4067012218937576e-15 }, // (31) Euphrosyne
	{ naif: 2000065, gm: 2.0917175955133682e-15 }, // (65) Cybele
]

// Step counts of the successive modified-midpoint integrations of one Bulirsch-Stoer step (Deuflhard's even sequence);
// its length bounds the extrapolation order.
const STEP_SEQUENCE = [2, 4, 6, 8, 10, 12, 14, 16, 18, 20] as const
// Default relative position tolerance of a step.
const DEFAULT_TOLERANCE = 1e-13
// Default largest step, days.
const DEFAULT_MAX_STEP = 32
// First trial step, days, before the step control adapts it.
const INITIAL_STEP = 4
// Smallest step, days (about 0.9 ms). A step that cannot converge above it would otherwise halve forever.
const MIN_STEP = 1e-8
// Distance from the target, days (about 9 µs), below which a target is considered reached.
const TARGET_EPSILON = 1e-10
// Squared speed of light, (AU/day)².
const C2 = SPEED_OF_LIGHT_AU_DAY * SPEED_OF_LIGHT_AU_DAY
// Marsden-Sekanina-Yeomans (1973) parameters of the cometary g(r): normalization α, scale distance r0 (AU), and the
// exponents m, n, k, so that g(1 AU) = 1.
const COMET_ALPHA = 0.1112620426
const COMET_R0 = 2.808
const COMET_M = 2.15
const COMET_N = 5.093
const COMET_K = 4.6142

// Propagates a massless particle under a SmallBodyForceModel from a barycentric state at an epoch, forward or backward,
// by adaptive Bulirsch-Stoer steps. The propagator keeps its state between calls, so a long integration can be advanced
// in bounded chunks of steps.
export class SmallBodyPropagator {
	readonly #source: EphemerisSource
	readonly #naif: Int32Array
	readonly #gm: Float64Array
	readonly #sunIndex: number
	readonly #relativity: boolean
	readonly #nonGravitational?: NonGravitationalParameters
	readonly #tolerance: number
	readonly #maxStep: number
	readonly #maxRelativeStep: number
	readonly #onStep?: (time: Time, state: Float64Array) => void
	// TDB Julian day number and day fraction of the epoch; instants are base + origin + offset days.
	readonly #base: number
	readonly #origin: number
	// Days elapsed since the epoch at the current state.
	#offset = 0
	// Current trial step magnitude, days.
	#step: number
	readonly #y = new Float64Array(6)
	readonly #f0 = new Float64Array(6)
	readonly #f = new Float64Array(6)
	readonly #za = new Float64Array(6)
	readonly #zb = new Float64Array(6)
	readonly #zc = new Float64Array(6)
	// Extrapolation tableau, row-major: entry (k, j) at ((k * STEP_SEQUENCE.length) + j) * 6.
	readonly #tableau = new Float64Array(STEP_SEQUENCE.length * STEP_SEQUENCE.length * 6)
	// Perturber positions (AU) and velocities (AU/day) of the latest evaluation, 3 values each per perturber.
	readonly #positions: Float64Array
	readonly #velocities: Float64Array

	// Creates a propagator for the particle at `position` (AU) and `velocity` (AU/day), barycentric in the axes of the
	// source, at `epoch` (any time scale). The source must give every perturber of the model, and the Sun (NAIF 10) when
	// relativity or a non-gravitational acceleration is modeled, at every instant the propagator reaches.
	constructor(source: EphemerisSource, model: SmallBodyForceModel, epoch: Time, position: Vec3, velocity: Vec3, options?: SmallBodyPropagatorOptions) {
		const count = model.perturbers.length
		this.#source = source
		this.#naif = new Int32Array(count)
		this.#gm = new Float64Array(count)
		this.#positions = new Float64Array(count * 3)
		this.#velocities = new Float64Array(count * 3)
		let sunIndex = -1

		for (let i = 0; i < count; i++) {
			this.#naif[i] = model.perturbers[i].naif
			this.#gm[i] = model.perturbers[i].gm
			if (model.perturbers[i].naif === 10) sunIndex = i
		}

		// Without the Sun among the perturbers, the relativistic and non-gravitational terms would silently use a zero GM
		// or a Sun at the origin, a plausible-looking but wrong trajectory.
		if (sunIndex < 0 && (model.relativity || model.nonGravitational)) throw new Error('relativity and non-gravitational accelerations need the Sun (NAIF 10) among the perturbers')

		this.#sunIndex = sunIndex
		this.#relativity = model.relativity
		this.#nonGravitational = model.nonGravitational
		this.#tolerance = options?.tolerance ?? DEFAULT_TOLERANCE
		this.#maxStep = options?.maxStep ?? DEFAULT_MAX_STEP
		this.#maxRelativeStep = options?.maxRelativeStep ?? Infinity
		this.#onStep = options?.onStep
		this.#step = Math.min(INITIAL_STEP, this.#maxStep)

		const t = tdb(epoch)
		this.#base = t.day
		this.#origin = t.fraction
		this.#y[0] = position[0]
		this.#y[1] = position[1]
		this.#y[2] = position[2]
		this.#y[3] = velocity[0]
		this.#y[4] = velocity[1]
		this.#y[5] = velocity[2]
	}

	// Days elapsed (TDB) from the epoch to the current state; negative after a backward propagation.
	get offset() {
		return this.#offset
	}

	// Instant of the current state, TDB.
	get time(): Time {
		return this.#timeAt(this.#offset)
	}

	// Barycentric position (AU) and velocity (AU/day) of the current state, freshly allocated.
	state(): PositionAndVelocityMut {
		const y = this.#y
		return [
			[y[0], y[1], y[2]],
			[y[3], y[4], y[5]],
		]
	}

	// Advances toward `target` (any time scale), in either direction, by at most `maxSteps` accepted steps, ending
	// exactly at the target. Returns whether the target was reached; when not, a later call continues from where it
	// stopped. Throws when a step cannot converge above the minimum step, such as a collision with a perturber.
	advance(target: Time, maxSteps: number = Infinity) {
		const t = tdb(target)
		const end = t.day - this.#base + (t.fraction - this.#origin)
		let steps = 0

		while (steps < maxSteps) {
			const remaining = end - this.#offset
			if (Math.abs(remaining) <= TARGET_EPSILON) return true

			this.#evaluate(this.#offset, this.#y, this.#f0)
			let magnitude = Math.min(this.#step, Math.abs(remaining), this.#encounterLimit())

			while (true) {
				const h = remaining < 0 ? -magnitude : magnitude
				const column = this.#bulirschStoerStep(h)

				if (column >= 0) {
					this.#offset = Math.abs(end - (this.#offset + h)) <= TARGET_EPSILON ? end : this.#offset + h
					if (column <= 4) this.#step = Math.min(this.#step * 1.5, this.#maxStep)
					else if (column >= 7) this.#step *= 0.7
					break
				}

				magnitude *= 0.5
				this.#step = magnitude
				if (magnitude < MIN_STEP) throw new Error(`step size underflow at ${this.#offset} days from the epoch`)
			}

			steps++
			this.#onStep?.(this.#timeAt(this.#offset), this.#y)
		}

		return Math.abs(end - this.#offset) <= TARGET_EPSILON
	}

	// TDB instant `offset` days from the epoch.
	#timeAt(offset: number) {
		return time(this.#base, this.#origin + offset, Timescale.TDB)
	}

	// Largest step, days, over which the particle moves relative to every perturber by at most maxRelativeStep of its
	// distance to it, from the perturber states of the latest evaluation, which #evaluate made at the start of the step.
	#encounterLimit() {
		if (!Number.isFinite(this.#maxRelativeStep)) return Infinity

		const y = this.#y
		// Largest relative speed over distance, 1/day.
		let rate = 0

		for (let i = 0; i < this.#naif.length; i++) {
			const o = i * 3
			const dx = y[0] - this.#positions[o]
			const dy = y[1] - this.#positions[o + 1]
			const dz = y[2] - this.#positions[o + 2]
			const vx = y[3] - this.#velocities[o]
			const vy = y[4] - this.#velocities[o + 1]
			const vz = y[5] - this.#velocities[o + 2]
			const w = Math.sqrt((vx * vx + vy * vy + vz * vz) / (dx * dx + dy * dy + dz * dz))
			if (w > rate) rate = w
		}

		return rate > 0 ? this.#maxRelativeStep / rate : Infinity
	}

	// One Bulirsch-Stoer step of h days from the current state, whose derivative is in #f0. On convergence, writes the
	// extrapolated state into #y and returns the tableau column that converged; returns -1 otherwise, leaving #y unchanged.
	#bulirschStoerStep(h: number) {
		const size = STEP_SEQUENCE.length
		const tableau = this.#tableau

		for (let k = 0; k < size; k++) {
			const row = k * size * 6
			this.#midpoint(h, STEP_SEQUENCE[k], row)

			for (let j = 1; j <= k; j++) {
				const ratio = STEP_SEQUENCE[k] / STEP_SEQUENCE[k - j]
				const factor = 1 / (ratio * ratio - 1)
				const current = row + j * 6
				const previous = row + (j - 1) * 6
				const above = (k - 1) * size * 6 + (j - 1) * 6

				for (let i = 0; i < 6; i++) {
					tableau[current + i] = tableau[previous + i] + (tableau[previous + i] - tableau[above + i]) * factor
				}
			}

			if (k >= 2) {
				const best = row + k * 6
				const last = (k - 1) * size * 6 + (k - 1) * 6
				const ex = tableau[best] - tableau[last]
				const ey = tableau[best + 1] - tableau[last + 1]
				const ez = tableau[best + 2] - tableau[last + 2]
				const r2 = tableau[best] * tableau[best] + tableau[best + 1] * tableau[best + 1] + tableau[best + 2] * tableau[best + 2]

				if (ex * ex + ey * ey + ez * ez < this.#tolerance * this.#tolerance * r2) {
					for (let i = 0; i < 6; i++) this.#y[i] = tableau[best + i]
					return k
				}
			}
		}

		return -1
	}

	// Gragg modified midpoint integration of h days in n substeps from the current state, with its derivative in #f0,
	// written into the tableau at `out`.
	#midpoint(h: number, n: number, out: number) {
		const s = h / n
		const y = this.#y
		let previous = this.#za
		let current = this.#zb
		let next = this.#zc

		for (let i = 0; i < 6; i++) {
			previous[i] = y[i]
			current[i] = y[i] + s * this.#f0[i]
		}

		for (let m = 1; m < n; m++) {
			this.#evaluate(this.#offset + m * s, current, this.#f)
			for (let i = 0; i < 6; i++) next[i] = previous[i] + 2 * s * this.#f[i]
			const swap = previous
			previous = current
			current = next
			next = swap
		}

		this.#evaluate(this.#offset + h, current, this.#f)
		for (let i = 0; i < 6; i++) this.#tableau[out + i] = 0.5 * (previous[i] + current[i] + s * this.#f[i])
	}

	// Derivative of the state `y` at `offset` days from the epoch, written into `out`: the velocity, then the
	// barycentric acceleration of the force model. Stores the perturber states it reads.
	#evaluate(offset: number, y: Float64Array, out: Float64Array) {
		const t = this.#timeAt(offset)
		const x = y[0]
		const yy = y[1]
		const z = y[2]
		let ax = 0
		let ay = 0
		let az = 0

		for (let i = 0; i < this.#naif.length; i++) {
			const [p, v] = this.#source.state(this.#naif[i], t)
			const o = i * 3
			this.#positions[o] = p[0]
			this.#positions[o + 1] = p[1]
			this.#positions[o + 2] = p[2]
			this.#velocities[o] = v[0]
			this.#velocities[o + 1] = v[1]
			this.#velocities[o + 2] = v[2]
			const dx = p[0] - x
			const dy = p[1] - yy
			const dz = p[2] - z
			const d2 = dx * dx + dy * dy + dz * dz
			const k = this.#gm[i] / (d2 * Math.sqrt(d2))
			ax += k * dx
			ay += k * dy
			az += k * dz
		}

		if (this.#sunIndex >= 0 && (this.#relativity || this.#nonGravitational)) {
			const o = this.#sunIndex * 3
			const r: MutVec3 = [x - this.#positions[o], yy - this.#positions[o + 1], z - this.#positions[o + 2]]
			const v: MutVec3 = [y[3] - this.#velocities[o], y[4] - this.#velocities[o + 1], y[5] - this.#velocities[o + 2]]
			const acceleration: MutVec3 = [0, 0, 0]
			if (this.#relativity) relativisticAcceleration(r, v, this.#gm[this.#sunIndex], acceleration)
			if (this.#nonGravitational) nonGravitationalAcceleration(r, v, this.#nonGravitational, acceleration)
			ax += acceleration[0]
			ay += acceleration[1]
			az += acceleration[2]
		}

		out[0] = y[3]
		out[1] = y[4]
		out[2] = y[5]
		out[3] = ax
		out[4] = ay
		out[5] = az
	}
}

// Adds to `out` the Sun's post-Newtonian acceleration (AU/day²) of a particle at heliocentric position `r` (AU) and
// velocity `v` (AU/day), for a Sun of gravitational parameter `gm` (AU³/day²): the PPN (β = γ = 1) single-body term
// gm/(c²r³)·[(4gm/r − v²)·r + 4(r·v)·v], whose secular effect is the perihelion advance 6π·gm/(c²a(1 − e²)) per orbit.
function relativisticAcceleration(r: Vec3, v: Vec3, gm: number, out: MutVec3) {
	const r2 = r[0] * r[0] + r[1] * r[1] + r[2] * r[2]
	const rl = Math.sqrt(r2)
	const v2 = v[0] * v[0] + v[1] * v[1] + v[2] * v[2]
	const rv = r[0] * v[0] + r[1] * v[1] + r[2] * v[2]
	const k = gm / (C2 * r2 * rl)
	const radial = k * ((4 * gm) / rl - v2)
	const along = 4 * k * rv
	out[0] += radial * r[0] + along * v[0]
	out[1] += radial * r[1] + along * v[1]
	out[2] += radial * r[2] + along * v[2]
	return out
}

// Distance law g(r) of a non-gravitational model at a heliocentric distance `r` (AU); 1 at 1 AU.
export function nonGravitationalDistanceLaw(model: NonGravitationalModel, r: number) {
	if (model === 'asteroid') return 1 / (r * r)
	const x = r / COMET_R0
	return COMET_ALPHA * x ** -COMET_M * (1 + x ** COMET_N) ** -COMET_K
}

// Adds to `out` the non-gravitational acceleration (AU/day²) of a particle at heliocentric position `r` (AU) and
// velocity `v` (AU/day): (A1·r̂ + A2·t̂ + A3·n̂)·g(r), with n̂ along r × v and t̂ = n̂ × r̂. Nothing is added for a
// rectilinear state, whose transverse and normal directions are undefined.
function nonGravitationalAcceleration(r: Vec3, v: Vec3, parameters: NonGravitationalParameters, out: MutVec3) {
	const rl = Math.sqrt(r[0] * r[0] + r[1] * r[1] + r[2] * r[2])
	const hx = r[1] * v[2] - r[2] * v[1]
	const hy = r[2] * v[0] - r[0] * v[2]
	const hz = r[0] * v[1] - r[1] * v[0]
	const hl = Math.sqrt(hx * hx + hy * hy + hz * hz)
	if (!(hl > 0)) return out

	const g = nonGravitationalDistanceLaw(parameters.model, rl)
	const a1 = (parameters.a1 * g) / rl
	const a3 = (parameters.a3 * g) / hl
	// t̂ = n̂ × r̂ = (h × r) / (|h| r)
	const a2 = (parameters.a2 * g) / (hl * rl)
	out[0] += a1 * r[0] + a2 * (hy * r[2] - hz * r[1]) + a3 * hx
	out[1] += a1 * r[1] + a2 * (hz * r[0] - hx * r[2]) + a3 * hy
	out[2] += a1 * r[2] + a2 * (hx * r[1] - hy * r[0]) + a3 * hz
	return out
}
