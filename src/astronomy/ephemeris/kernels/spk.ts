import { AU_KM, DAYSEC, J2000, TAU } from '../../../core/constants'
import { type MutVec3, vecZero } from '../../../math/linear-algebra/vec3'
import type { PositionAndVelocity, PositionAndVelocityMut } from '../../coordinates/astrometry'
import { type Time, tdb } from '../../time/time'
import type { Daf, Summary } from './daf'

// Reader and evaluator for SPK (Spacecraft and Planet Kernel) ephemerides stored in DAF files.
// Builds a center->target segment lookup and decodes the supported binary data types (2/3
// Chebyshev, 9 Lagrange, 17 precessing equinoctial elements, 21 extended modified difference
// arrays). Positions are AU and velocities AU/day, expressed in the segment's NAIF reference frame
// with no rotation applied; a type 17 segment rotates its elements from the equator of its central
// body into that frame.
// Frame 1 (J2000) is the orientation ephemeris paths accept as the library base. Records are
// cached per segment; epochs are ephemeris seconds past J2000 (TDB).

// https://naif.jpl.nasa.gov/pub/naif/toolkit_docs/FORTRAN/req/spk.html
// https://naif.jpl.nasa.gov/pub/naif/misc/toolkit_docs_N0067/C/req/spk.html

// Kilometers to astronomical units.
const KM_TO_AU = 1 / AU_KM
// Kilometers per second to AU per day.
const KM_PER_SECOND_TO_AU_PER_DAY = DAYSEC / AU_KM

// NAIF frame code for J2000. An SPK reference-frame component (summary.ints[2],
// NAIF integer 3) equal to this value is the orientation ephemeris paths accept
// as the library ICRS/BCRS base. The reader does not rotate any other frame.
export const SPK_FRAME_J2000 = 1

// A parsed SPK file: all segments plus a center/target segment lookup.
export interface Spk {
	// All segments as [center, target, segment] triples in file order.
	readonly segments: readonly [number, number, SpkSegment][]
	// Resolves the segment giving the target's state relative to the center, if present.
	readonly segment: (center: number, target: number) => Promise<SpkSegment | undefined>
}

// One SPK segment: the state of `target` relative to `center` over [start, end].
export interface SpkSegment {
	// readonly daf: Daf
	// readonly source: string
	// Segment coverage start, in ephemeris seconds past J2000 (TDB).
	readonly start: number
	// Segment coverage end, in ephemeris seconds past J2000 (TDB).
	readonly end: number
	// NAIF code of the center body.
	readonly center: number
	// NAIF code of the target body.
	readonly target: number
	// NAIF reference-frame id. `at` returns vectors in this frame.
	// SPK_FRAME_J2000 is J2000; any other id is not rotated here.
	readonly frame: number
	// readonly type: number
	// First DAF word index of the segment data (1-based).
	readonly startIndex: number
	// Last DAF word index of the segment data (1-based).
	readonly endIndex: number
	// Loads INIT/INTLEN/RSIZE/N. Coefficient records are read later on demand. Safe to call more than once.
	readonly initialize: () => Promise<void>
	// Evaluates position (AU) and velocity (AU/day) at `time` in `frame`. No rotation is applied.
	readonly at: (time: Time) => PositionAndVelocityMut
}

// Reads SPK summaries and builds a reusable center-target segment lookup.
export function readSpk(daf: Daf): Spk {
	const segments = new Array<Spk['segments'][number]>(daf.summaries.length)
	const segmentGroups = new Map<number, Map<number, SpkSegment[]>>()

	for (let i = 0; i < daf.summaries.length; i++) {
		const summary = daf.summaries[i]
		const segment = makeSegment(summary, daf)
		const center = summary.ints[1]
		const target = summary.ints[0]
		segments[i] = [center, target, segment]
		appendSpkSegment(segmentGroups, center, target, segment)
	}

	const segmentByTarget = buildSpkSegmentMap(segmentGroups)

	return {
		segments,
		segment: async (center, target) => {
			const segment = segmentByTarget.get(center)?.get(target)
			await segment?.initialize()
			return segment
		},
	}
}

// Appends a segment to the center-target group preserving file order priority.
function appendSpkSegment(groups: Map<number, Map<number, SpkSegment[]>>, center: number, target: number, segment: SpkSegment) {
	let targets = groups.get(center)

	if (!targets) {
		targets = new Map<number, SpkSegment[]>()
		groups.set(center, targets)
	}

	let segments = targets.get(target)

	if (!segments) {
		segments = []
		targets.set(target, segments)
	}

	segments.push(segment)
}

// Builds one reusable segment lookup entry per center-target pair.
function buildSpkSegmentMap(groups: ReadonlyMap<number, ReadonlyMap<number, readonly SpkSegment[]>>): Map<number, Map<number, SpkSegment>> {
	const segmentByTarget = new Map<number, Map<number, SpkSegment>>()

	for (const [center, targets] of groups) {
		const resolvedTargets = new Map<number, SpkSegment>()

		for (const [target, segments] of targets) {
			resolvedTargets.set(target, segments.length === 1 ? segments[0] : new MultipleSpkSegment([...segments]))
		}

		segmentByTarget.set(center, resolvedTargets)
	}

	return segmentByTarget
}

// Converts an arbitrary input instant to SPK ephemeris seconds past J2000 (TDB), the epoch scale of
// segment descriptors and coverage bounds.
export function spkSeconds(time: Time) {
	const { day, fraction } = tdb(time)
	return (day - J2000 + fraction) * DAYSEC
}

// Checks whether the request epoch is covered by the segment interval.
function hasSegmentCoverage(segment: SpkSegment, seconds: number) {
	return seconds >= segment.start && seconds <= segment.end
}

// Finds the first index whose epoch is greater than or equal to the target epoch.
function lowerBoundEpoch(epochs: Float64Array, seconds: number, begin: number, end: number) {
	while (begin < end) {
		const mid = (begin + end) >>> 1

		if (epochs[mid] < seconds) {
			begin = mid + 1
		} else {
			end = mid
		}
	}

	return begin
}

// Instantiates the concrete segment reader for a supported SPK data type.
function makeSegment(summary: Summary, daf: Daf): SpkSegment {
	const segment = makeSpkSegment(summary, daf)
	if (segment) return segment
	throw new Error('only binary SPK data types 2, 3, 9, 17 and 21 are supported')
}

// Instantiates the uninitialized segment reader of one SPK summary over `daf`, or undefined when the
// summary's data type is not one of the supported binary types 2, 3, 9, 17, and 21. Nothing is read
// until the segment's `initialize` runs.
export function makeSpkSegment(summary: Summary, daf: Daf): SpkSegment | undefined {
	const [start, end] = summary.doubles
	const [target, center, frame, type, startIndex, endIndex] = summary.ints

	switch (type) {
		case 2:
		case 3:
			return new Type2And3Segment(daf, start, end, center, target, frame, type, startIndex, endIndex)
		case 9:
			return new Type9Segment(daf, start, end, center, target, frame, startIndex, endIndex)
		case 17:
			return new Type17Segment(daf, start, end, center, target, frame, startIndex, endIndex)
		case 21:
			return new Type21Segment(daf, start, end, center, target, frame, startIndex, endIndex)
	}

	return undefined
}

// More info about spk types: https://spiceypy.readthedocs.io/en/latest/spk.html

// Decoded Chebyshev record for a type 2/3 segment.
interface Type2And3Coefficient {
	// Midpoint epoch of the record, in ephemeris seconds past J2000.
	readonly mid: number
	// Half-length of the record interval, in seconds; normalizes time into [-1, 1].
	readonly radius: number
	// Chebyshev coefficients for the x position component.
	readonly x: Float64Array
	// Chebyshev coefficients for the y position component.
	readonly y: Float64Array
	// Chebyshev coefficients for the z position component.
	readonly z: Float64Array
	// Chebyshev coefficients for the x velocity component (type 3 only).
	readonly vx?: Float64Array
	// Chebyshev coefficients for the y velocity component (type 3 only).
	readonly vy?: Float64Array
	// Chebyshev coefficients for the z velocity component (type 3 only).
	readonly vz?: Float64Array
	// Number of coefficients per component.
	readonly count: number
}

// Evaluates one 3D Chebyshev series with a shared normalized time argument.
function evaluateChebyshevVector(x: Float64Array, y: Float64Array, z: Float64Array, s: number, out: MutVec3): MutVec3 {
	const ss = 2 * s
	let x0 = 0
	let y0 = 0
	let z0 = 0
	let x1 = 0
	let y1 = 0
	let z1 = 0
	let x2 = 0
	let y2 = 0
	let z2 = 0

	for (let i = x.length - 1; i >= 1; i--) {
		x2 = x1
		y2 = y1
		z2 = z1
		x1 = x0
		y1 = y0
		z1 = z0
		x0 = x[i] + ss * x1 - x2
		y0 = y[i] + ss * y1 - y2
		z0 = z[i] + ss * z1 - z2
	}

	out[0] = x[0] + s * x0 - x1
	out[1] = y[0] + s * y0 - y1
	out[2] = z[0] + s * z0 - z1

	return out
}

// Evaluates a 3D Chebyshev position series and its first derivative in one pass.
function evaluateChebyshevVectorDerivative(x: Float64Array, y: Float64Array, z: Float64Array, s: number, velocityScale: number, position: MutVec3, velocity: MutVec3): PositionAndVelocityMut {
	const ss = 2 * s
	let x0 = 0
	let y0 = 0
	let z0 = 0
	let x1 = 0
	let y1 = 0
	let z1 = 0
	let x2 = 0
	let y2 = 0
	let z2 = 0
	let dx0 = 0
	let dy0 = 0
	let dz0 = 0
	let dx1 = 0
	let dy1 = 0
	let dz1 = 0
	let dx2 = 0
	let dy2 = 0
	let dz2 = 0

	for (let i = x.length - 1; i >= 1; i--) {
		x2 = x1
		y2 = y1
		z2 = z1
		x1 = x0
		y1 = y0
		z1 = z0
		x0 = x[i] + ss * x1 - x2
		y0 = y[i] + ss * y1 - y2
		z0 = z[i] + ss * z1 - z2

		dx2 = dx1
		dy2 = dy1
		dz2 = dz1
		dx1 = dx0
		dy1 = dy0
		dz1 = dz0
		dx0 = 2 * x1 + ss * dx1 - dx2
		dy0 = 2 * y1 + ss * dy1 - dy2
		dz0 = 2 * z1 + ss * dz1 - dz2
	}

	position[0] = x[0] + s * x0 - x1
	position[1] = y[0] + s * y0 - y1
	position[2] = z[0] + s * z0 - z1

	velocity[0] = (x0 + s * dx0 - dx1) * velocityScale
	velocity[1] = (y0 + s * dy0 - dy1) * velocityScale
	velocity[2] = (z0 + s * dz0 - dz1) * velocityScale

	return [position, velocity]
}

// Type 2: Chebyshev (position only)
// The SPK Type 2 data type contains Chebyshev polynomial coefficients for the position of the body
// as a function of time. Normally, this data type is used for planet barycenters, and for satellites
// whose ephemerides are integrated. (The velocity of the body is obtained by differentiating the position.)
// Type 3: Chebyshev (position and velocity)
// The SPK Type 3 data type contains Chebyshev polynomial coefficients for the position and velocity of the body
// as a function of time. Normally, this data type is used for satellites for which the ephemerides are computed
// from analytical theories.
export class Type2And3Segment implements SpkSegment {
	#initialized = false
	#init?: Promise<void>
	#initialEpoch = 0
	#intervalLength = 0
	#rsize = 0
	#n = 0
	#count = 0
	readonly #coefficients = new Map<number, Type2And3Coefficient>()
	readonly #daf: Daf
	readonly #type: number

	// Stores immutable metadata and the backing DAF reader for this Chebyshev segment.
	constructor(
		daf: Daf,
		// readonly source: string,
		readonly start: number,
		readonly end: number,
		readonly center: number,
		readonly target: number,
		readonly frame: number,
		type: number,
		readonly startIndex: number,
		readonly endIndex: number,
	) {
		this.#daf = daf
		this.#type = type
	}

	// Evaluates position and velocity at the requested epoch.
	at(time: Time): PositionAndVelocityMut {
		if (!this.#initialized) throw new Error('SPK segment is not initialized')

		const seconds = spkSeconds(time)

		if (!hasSegmentCoverage(this, seconds)) {
			throw new Error(`cannot find a segment that covers the date: ${seconds}`)
		}

		const index = Math.max(0, Math.min(this.#n - 1, Math.floor((seconds - this.#initialEpoch) / this.#intervalLength)))
		const c = this.#computeCoefficient(index)

		if (!c) {
			throw new Error(`cannot find a segment that covers the date: ${seconds}`)
		}

		const s = (seconds - c.mid) / c.radius
		const p = vecZero()
		const v = vecZero()

		if (this.#type === 3) {
			evaluateChebyshevVector(c.x, c.y, c.z, s, p)
			evaluateChebyshevVector(c.vx!, c.vy!, c.vz!, s, v)
		} else {
			evaluateChebyshevVectorDerivative(c.x, c.y, c.z, s, 1 / c.radius, p, v)
		}

		p[0] *= KM_TO_AU
		p[1] *= KM_TO_AU
		p[2] *= KM_TO_AU
		v[0] *= KM_PER_SECOND_TO_AU_PER_DAY
		v[1] *= KM_PER_SECOND_TO_AU_PER_DAY
		v[2] *= KM_PER_SECOND_TO_AU_PER_DAY

		return [p, v]
	}

	// Loads INIT, INTLEN, RSIZE, and N once from the tail of the segment.
	initialize(): Promise<void> {
		if (this.#initialized) return Promise.resolve()
		if (this.#init) return this.#init
		this.#init = this.#load()
		return this.#init
	}

	async #load() {
		// INIT: is the initial epoch of the first record, given in ephemeris seconds past J2000.
		// INTLEN: is the length of the interval covered by each record, in seconds.
		// RSIZE: is the total size of (number of array elements in) each record.
		// N: is the number of records contained in the segment.

		try {
			const [a, b, c, d] = await this.#daf.read(this.endIndex - 3, this.endIndex)
			this.#initialEpoch = a
			this.#intervalLength = b
			this.#rsize = Math.trunc(c)
			this.#n = Math.trunc(d)
			this.#count = Math.trunc((this.#rsize - 2) / (this.#type === 3 ? 6 : 3))
			this.#initialized = true
		} catch (error) {
			this.#init = undefined
			throw error
		}
	}

	// Reads and caches one Chebyshev record from the segment.
	#computeCoefficient(index: number): Type2And3Coefficient | undefined {
		const cached = this.#coefficients.get(index)
		if (cached) return cached
		if (index < 0 || index >= this.#n) return undefined

		const a = this.startIndex + index * this.#rsize
		const b = a + this.#rsize - 1

		if (a >= this.startIndex && a < b && b <= this.endIndex - 4) {
			const coefficients = this.#daf.readSync(a, b)

			const [mid, radius] = coefficients
			const x = new Float64Array(this.#count)
			const y = new Float64Array(this.#count)
			const z = new Float64Array(this.#count)

			for (let m = 0; m < this.#count; m++) {
				x[m] = coefficients[2 + m]
				y[m] = coefficients[2 + m + this.#count]
				z[m] = coefficients[2 + m + 2 * this.#count]
			}

			if (this.#type === 3) {
				const vx = new Float64Array(this.#count)
				const vy = new Float64Array(this.#count)
				const vz = new Float64Array(this.#count)

				for (let m = 0; m < this.#count; m++) {
					vx[m] = coefficients[2 + m + 3 * this.#count]
					vy[m] = coefficients[2 + m + 4 * this.#count]
					vz[m] = coefficients[2 + m + 5 * this.#count]
				}

				const coefficient = { mid, radius, x, y, z, vx, vy, vz, count: this.#count }
				this.#coefficients.set(index, coefficient)

				return coefficient
			}

			const coefficient = { mid, radius, x, y, z, count: this.#count }
			this.#coefficients.set(index, coefficient)

			return coefficient
		}

		return undefined
	}
}

// Type 9: Lagrange Interpolation — Unequal Time Steps
// The SPK Type 9 data type represents a continuous ephemeris using a discrete set of states and
// a Lagrange interpolation method. The epochs (also called time tags) associated with the states
// need not be evenly spaced. For a request epoch not corresponding to the time tag of some state,
// the data type defines a state by interpolating each component of a set of states whose epochs are
// centered near the request epoch.
export class Type9Segment implements SpkSegment {
	#initialized = false
	#init?: Promise<void>
	#degree = 0
	#n = 0
	#stateTable: Float64Array = new Float64Array(0)
	#epochTable: Float64Array = new Float64Array(0)
	readonly #daf: Daf

	// Stores immutable metadata and the backing DAF reader for this Lagrange segment.
	constructor(
		daf: Daf,
		// readonly source: string,
		readonly start: number,
		readonly end: number,
		readonly center: number,
		readonly target: number,
		readonly frame: number,
		// readonly type: number,
		readonly startIndex: number,
		readonly endIndex: number,
	) {
		this.#daf = daf
	}

	// Interpolates one state vector at the requested epoch.
	at(time: Time): PositionAndVelocityMut {
		if (!this.#initialized) throw new Error('SPK segment is not initialized')

		const seconds = spkSeconds(time)
		const index = this.#searchEpochIndex(seconds)

		if (!(index >= 0)) {
			throw new Error(`cannot find a segment that covers the date: ${seconds}`)
		}

		const window = Math.min(this.#degree + 1, this.#n)
		const begin = this.#windowStart(seconds, index, window)
		const end = begin + window

		const p = vecZero()
		const v = vecZero()

		for (let i = begin; i < end; i++) {
			const ti = this.#epochTable[i]
			let basis = 1

			for (let j = begin; j < end; j++) {
				if (j !== i) {
					const tj = this.#epochTable[j]
					basis *= (seconds - tj) / (ti - tj)
				}
			}

			const offset = i * 6
			p[0] += this.#stateTable[offset] * basis
			p[1] += this.#stateTable[offset + 1] * basis
			p[2] += this.#stateTable[offset + 2] * basis
			v[0] += this.#stateTable[offset + 3] * basis
			v[1] += this.#stateTable[offset + 4] * basis
			v[2] += this.#stateTable[offset + 5] * basis
		}

		p[0] *= KM_TO_AU
		p[1] *= KM_TO_AU
		p[2] *= KM_TO_AU
		v[0] *= KM_PER_SECOND_TO_AU_PER_DAY
		v[1] *= KM_PER_SECOND_TO_AU_PER_DAY
		v[2] *= KM_PER_SECOND_TO_AU_PER_DAY

		return [p, v]
	}

	// Loads all type 9 states and epochs once.
	initialize(): Promise<void> {
		if (this.#initialized) return Promise.resolve()
		if (this.#init) return this.#init
		this.#init = this.#load()
		return this.#init
	}

	async #load() {
		try {
			const [a, b] = await this.#daf.read(this.endIndex - 1, this.endIndex)
			this.#degree = Math.trunc(a)
			this.#n = Math.trunc(b)

			const stateLength = this.#n * 6
			this.#stateTable = await this.#daf.read(this.startIndex, this.startIndex + stateLength - 1)
			this.#epochTable = await this.#daf.read(this.startIndex + stateLength, this.startIndex + stateLength + this.#n - 1)
			this.#initialized = true
		} catch (error) {
			this.#init = undefined
			throw error
		}
	}

	// Chooses an interpolation window whose center is nearest to the request epoch when the window size is odd.
	#windowStart(seconds: number, index: number, window: number) {
		let center = index

		if ((window & 1) === 1 && index > 0 && seconds - this.#epochTable[index - 1] <= this.#epochTable[index] - seconds) {
			center = index - 1
		}

		let begin = center - (window >> 1)
		if (begin < 0) begin = 0
		if (begin + window > this.#n) begin = this.#n - window
		return begin
	}

	// Finds the state-table insertion index for the request epoch.
	#searchEpochIndex(seconds: number) {
		if (!hasSegmentCoverage(this, seconds)) {
			return -1
		}

		return Math.min(lowerBoundEpoch(this.#epochTable, seconds, 0, this.#n), this.#n - 1)
	}
}

// Type 17: Precessing Equinoctial Elements
// The SPK Type 17 data type models an orbit as a conic whose argument of periapse and longitude of
// the ascending node precess at constant rates, with equinoctial elements referred to the equator
// of the central body, given by the right ascension and declination of its pole in J2000. It suits
// small satellites near an oblate planet, such as the ring moons of Saturn. A segment holds one
// set of 12 doubles: the epoch of the elements (seconds past J2000, TDB), the semi-major axis a
// (km), h = e·sin(ϖ), k = e·cos(ϖ), the mean longitude λ (rad), p = tan(i/2)·sin(Ω),
// q = tan(i/2)·cos(Ω), the rates of the longitude of periapse ϖ, of the mean longitude, and of the
// node Ω (rad/s), and the right ascension and declination of the pole (rad). Evaluation follows
// SPICE EQNCPV: h, k turn with ϖ, p, q turn with Ω, the equinoctial Kepler equation
// λ = F + h·cos(F) − k·sin(F) gives the eccentric longitude F, and the velocity is the exact time
// derivative of the position, precession included. It matches CSPICE N0067 to 3 mm and 1 µm/s for
// Daphnis (sat393_daphnis.bsp), the residual being the rounding of λ over a century of revolutions.
export class Type17Segment implements SpkSegment {
	#initialized = false
	#init?: Promise<void>
	#epoch = 0
	#a = 0
	#h = 0
	#k = 0
	#meanLongitude = 0
	#p = 0
	#q = 0
	#periapseRate = 0
	#meanLongitudeRate = 0
	#nodeRate = 0
	// 1 / (1 + √(1 − e²)), constant because the precession keeps e.
	#b = 0
	// 1 / (1 + p² + q²), constant because the precession keeps the inclination.
	#di = 0
	// Rotation from the equator of the central body to J2000, row-major.
	readonly #rotation = new Float64Array(9)
	readonly #daf: Daf

	// Stores immutable metadata and the backing DAF reader for this equinoctial-element segment.
	constructor(
		daf: Daf,
		readonly start: number,
		readonly end: number,
		readonly center: number,
		readonly target: number,
		readonly frame: number,
		readonly startIndex: number,
		readonly endIndex: number,
	) {
		this.#daf = daf
	}

	// Evaluates position and velocity at the requested epoch, rotated from the equator of the
	// central body into the segment frame.
	at(time: Time): PositionAndVelocityMut {
		if (!this.#initialized) throw new Error('SPK segment is not initialized')

		const seconds = spkSeconds(time)

		if (!hasSegmentCoverage(this, seconds)) {
			throw new Error(`cannot find a segment that covers the date: ${seconds}`)
		}

		const dt = seconds - this.#epoch
		const dlp = this.#periapseRate
		const dnode = this.#nodeRate

		// h, k turn with the longitude of periapse, p, q with the node.
		const lp = dlp * dt
		const clp = Math.cos(lp)
		const slp = Math.sin(lp)
		const h = this.#h * clp + this.#k * slp
		const k = this.#k * clp - this.#h * slp
		const node = dnode * dt
		const cn = Math.cos(node)
		const sn = Math.sin(node)
		const p = this.#p * cn + this.#q * sn
		const q = this.#q * cn - this.#p * sn
		const dh = dlp * k
		const dk = -dlp * h
		const dp = dnode * q
		const dq = -dnode * p

		const f = eccentricLongitude((this.#meanLongitude + this.#meanLongitudeRate * dt) % TAU, h, k)
		const cf = Math.cos(f)
		const sf = Math.sin(f)
		const a = this.#a
		const b = this.#b
		const bhk = b * h * k
		const one = 1 - h * sf - k * cf

		// Position in the orbital plane, along the equinoctial axes f and g, in km.
		const x1 = a * ((1 - b * h * h) * cf + bhk * sf - k)
		const y1 = a * ((1 - b * k * k) * sf + bhk * cf - h)

		// Rate of the eccentric longitude, from the derivative of λ = F + h·cos(F) − k·sin(F), in rad/s.
		const df = (this.#meanLongitudeRate - dlp * (k * cf + h * sf)) / one
		const dhk = dh * k + h * dk
		const dx1 = a * ((bhk * cf - (1 - b * h * h) * sf) * df - 2 * b * h * dh * cf + b * dhk * sf - dk)
		const dy1 = a * (((1 - b * k * k) * cf - bhk * sf) * df - 2 * b * k * dk * sf + b * dhk * cf - dh)

		// Equinoctial axes f and g in the equator of the central body, and their rates.
		const di = this.#di
		const fx = di * (1 - p * p + q * q)
		const fy = di * 2 * p * q
		const fz = di * -2 * p
		const gx = fy
		const gy = di * (1 + p * p - q * q)
		const gz = di * 2 * q
		const dfx = di * 2 * (q * dq - p * dp)
		const dfy = di * 2 * (dp * q + p * dq)
		const dfz = di * -2 * dp
		const dgx = dfy
		const dgy = -dfx
		const dgz = di * 2 * dq

		const ex = x1 * fx + y1 * gx
		const ey = x1 * fy + y1 * gy
		const ez = x1 * fz + y1 * gz
		const evx = dx1 * fx + dy1 * gx + x1 * dfx + y1 * dgx
		const evy = dx1 * fy + dy1 * gy + x1 * dfy + y1 * dgy
		const evz = dx1 * fz + dy1 * gz + x1 * dfz + y1 * dgz

		const r = this.#rotation
		const pos = vecZero()
		const vel = vecZero()

		pos[0] = (r[0] * ex + r[1] * ey + r[2] * ez) * KM_TO_AU
		pos[1] = (r[3] * ex + r[4] * ey + r[5] * ez) * KM_TO_AU
		pos[2] = (r[6] * ex + r[7] * ey + r[8] * ez) * KM_TO_AU
		vel[0] = (r[0] * evx + r[1] * evy + r[2] * evz) * KM_PER_SECOND_TO_AU_PER_DAY
		vel[1] = (r[3] * evx + r[4] * evy + r[5] * evz) * KM_PER_SECOND_TO_AU_PER_DAY
		vel[2] = (r[6] * evx + r[7] * evy + r[8] * evz) * KM_PER_SECOND_TO_AU_PER_DAY

		return [pos, vel]
	}

	// Loads the 12 elements once.
	initialize(): Promise<void> {
		if (this.#initialized) return Promise.resolve()
		if (this.#init) return this.#init
		this.#init = this.#load()
		return this.#init
	}

	async #load() {
		try {
			const [epoch, a, h, k, meanLongitude, p, q, periapseRate, meanLongitudeRate, nodeRate, ra, dec] = await this.#daf.read(this.startIndex, this.startIndex + 11)
			const e2 = h * h + k * k

			// SPICE rejects eccentricities above 0.9; a hyperbolic or nearly parabolic set would make
			// the Kepler equation and √(1 − e²) meaningless.
			if (!(e2 <= TYPE17_MAX_ECCENTRICITY * TYPE17_MAX_ECCENTRICITY)) throw new Error(`SPK type 17 eccentricity ${Math.sqrt(e2)} is above ${TYPE17_MAX_ECCENTRICITY}`)

			this.#epoch = epoch
			this.#a = a
			this.#h = h
			this.#k = k
			this.#meanLongitude = meanLongitude
			this.#p = p
			this.#q = q
			this.#periapseRate = periapseRate
			this.#meanLongitudeRate = meanLongitudeRate
			this.#nodeRate = nodeRate
			this.#b = 1 / (1 + Math.sqrt(1 - e2))
			this.#di = 1 / (1 + p * p + q * q)

			// Columns are the x axis (the ascending node of the equator on the J2000 equator), the y
			// axis, and the pole of the central body, in J2000.
			const sa = Math.sin(ra)
			const ca = Math.cos(ra)
			const sd = Math.sin(dec)
			const cd = Math.cos(dec)
			const r = this.#rotation
			r[0] = -sa
			r[1] = -ca * sd
			r[2] = ca * cd
			r[3] = ca
			r[4] = -sa * sd
			r[5] = sa * cd
			r[6] = 0
			r[7] = cd
			r[8] = sd

			this.#initialized = true
		} catch (error) {
			this.#init = undefined
			throw error
		}
	}
}

// Largest eccentricity a type 17 segment may have, as in SPICE.
const TYPE17_MAX_ECCENTRICITY = 0.9

// Most Newton steps of the equinoctial Kepler equation; with e ≤ 0.9 the safeguarded iteration
// converges to machine precision in a few steps, and the bound only prevents a hang.
const KEPLER_MAX_ITERATIONS = 64

// Solves the equinoctial Kepler equation λ = F + h·cos(F) − k·sin(F) for the eccentric longitude F
// (rad), given the mean longitude λ (rad) and h, k with h² + k² < 1. The left side increases
// strictly with F and F − λ lies within ±e, so Newton steps are kept inside that bracket, falling
// back to bisection when a step leaves it.
function eccentricLongitude(meanLongitude: number, h: number, k: number) {
	const e = Math.sqrt(h * h + k * k)
	let low = meanLongitude - e
	let high = meanLongitude + e
	let f = meanLongitude

	for (let i = 0; i < KEPLER_MAX_ITERATIONS; i++) {
		const sf = Math.sin(f)
		const cf = Math.cos(f)
		const residual = f + h * cf - k * sf - meanLongitude

		if (residual > 0) high = f
		else if (residual < 0) low = f
		else return f

		let next = f - residual / (1 - h * sf - k * cf)
		if (!(next > low && next < high)) next = (low + high) / 2
		if (Math.abs(next - f) <= 1e-15 * Math.max(1, Math.abs(f))) return next
		f = next
	}

	return f
}

// Decoded extended modified-difference-array record for a type 21 segment.
interface Type21Coefficient {
	// Reference epoch of the record, in ephemeris seconds past J2000.
	readonly tl: number
	// Stepsize function vector.
	readonly g: Float64Array
	// Reference position vector (km), one entry per axis.
	readonly p: Float64Array
	// Reference velocity vector (km/s), one entry per axis.
	readonly v: Float64Array
	// Modified divided differences, laid out 3 axes per order.
	readonly dt: Float64Array
	// Maximum difference-table order plus one.
	readonly kqmax1: number
	// Per-axis difference-table order actually used.
	readonly kq: Int32Array
}

// Type 21: Extended Modified Difference Arrays
// The SPK Type 21 contains extended Modified Difference Arrays (MDA), also called difference lines.
// These data structures use the same mathematical trajectory representation as SPK data type 1,
// but type 21 allows use of larger, higher-degree MDAs.
export class Type21Segment implements SpkSegment {
	#initialized = false
	#init?: Promise<void>
	#n = 0
	#maxdim = 0
	#dlsize = 0
	#epochTable: Float64Array = new Float64Array(0)
	#fc: Float64Array = new Float64Array(0)
	#wc: Float64Array = new Float64Array(0)
	#w: Float64Array = new Float64Array(0)
	readonly #coefficients = new Map<number, Type21Coefficient>()
	readonly #daf: Daf

	// Stores immutable metadata and the backing DAF reader for this type 21 segment.
	constructor(
		daf: Daf,
		// readonly source: string,
		readonly start: number,
		readonly end: number,
		readonly center: number,
		readonly target: number,
		readonly frame: number,
		// readonly type: number,
		readonly startIndex: number,
		readonly endIndex: number,
	) {
		this.#daf = daf
	}

	// Interpolates one extended MDA record at the requested epoch.
	at(time: Time): PositionAndVelocityMut {
		if (!this.#initialized) throw new Error('SPK segment is not initialized')

		const seconds = spkSeconds(time)
		const index = this.#searchCoefficientIndex(seconds)
		const c = this.#computeCoefficient(index)

		if (!c) {
			throw new Error(`cannot find a segment that covers the date: ${seconds}`)
		}

		// Next we set up for the computation of the various differences.
		const delta = seconds - c.tl
		let tp = delta
		const mpq2 = c.kqmax1 - 2
		let ks = c.kqmax1 - 1
		const fc = this.#fc
		const wc = this.#wc
		const w = this.#w

		fc[0] = 1

		for (let i = 0; i < mpq2; i++) {
			fc[i + 1] = tp / c.g[i]
			wc[i] = delta / c.g[i]
			tp = delta + c.g[i]
		}

		// Collect KQMAX1 reciprocals.

		for (let i = 0; i < c.kqmax1; i++) {
			w[i] = 1 / (i + 1)
		}

		// Compute the W(K) terms needed for the position interpolation
		// (Note, it is assumed throughout this routine that KS, which
		// starts out as KQMAX1-1 (the maximum integration) is at least 2.

		let jx = 0

		while (ks >= 2) {
			jx++

			for (let i = 0; i < jx; i++) {
				w[i + ks] = fc[i + 1] * w[i + ks - 1] - wc[i] * w[i + ks]
			}

			ks--
		}

		// Perform position interpolation: (Note that KS = 1 right now.
		// We don't know much more than that.)
		const p = vecZero()
		const v = vecZero()

		for (let i = 0; i < 3; i++) {
			const kqq = c.kq[i]
			let sum = 0

			for (let j = kqq - 1; j >= 0; j--) {
				sum += c.dt[3 * j + i] * w[j + ks]
			}

			p[i] = (c.p[i] + delta * (c.v[i] + delta * sum)) * KM_TO_AU
		}

		// Again we need to compute the W(K) coefficients that are
		// going to be used in the velocity interpolation.
		// (Note, at this point, KS = 1, KS1 = 0.)

		for (let i = 0; i < jx; i++) {
			w[i + ks] = fc[i + 1] * w[i + ks - 1] - wc[i] * w[i + ks]
		}

		ks--

		// Perform velocity interpolation.
		for (let i = 0; i < 3; i++) {
			const kqq = c.kq[i]
			let sum = 0

			for (let j = kqq - 1; j >= 0; j--) {
				sum += c.dt[3 * j + i] * w[j + ks]
			}

			v[i] = (c.v[i] + delta * sum) * KM_PER_SECOND_TO_AU_PER_DAY
		}

		return [p, v]
	}

	// Loads the epoch table and interpolation workspace once.
	initialize(): Promise<void> {
		if (this.#initialized) return Promise.resolve()
		if (this.#init) return this.#init
		this.#init = this.#load()
		return this.#init
	}

	async #load() {
		try {
			const [a, b] = await this.#daf.read(this.endIndex - 1, this.endIndex)
			this.#maxdim = Math.trunc(a)
			this.#dlsize = 4 * this.#maxdim + 11
			this.#n = Math.trunc(b)

			// Epochs for all records in this segment.
			const start = this.startIndex + this.#n * this.#dlsize
			this.#epochTable = await this.#daf.read(start, start + this.#n - 1)

			// Reuse work arrays across calls and size them from MAXDIM instead of a fixed cap.
			const workspaceSize = this.#maxdim + 3
			this.#fc = new Float64Array(workspaceSize)
			this.#wc = new Float64Array(workspaceSize)
			this.#w = new Float64Array(workspaceSize)
			this.#initialized = true
		} catch (error) {
			this.#init = undefined
			throw error
		}
	}

	// Finds the first record whose final epoch is not less than the request epoch.
	#searchCoefficientIndex(seconds: number) {
		if (!hasSegmentCoverage(this, seconds)) {
			return -1
		}

		return Math.min(lowerBoundEpoch(this.#epochTable, seconds, 0, this.#n), this.#n - 1)
	}

	// Reads and caches one extended MDA record from the segment.
	#computeCoefficient(index: number): Type21Coefficient | undefined {
		const cached = this.#coefficients.get(index)
		if (cached) return cached
		if (index < 0 || index >= this.#n) return undefined

		const mdaRecord = this.#daf.readSync(this.startIndex + index * this.#dlsize, this.startIndex + (index + 1) * this.#dlsize - 1)

		// Reference epoch of record.
		const tl = mdaRecord[0]
		// Stepsize function vector.
		const g = mdaRecord.subarray(1, this.#maxdim + 1)

		// Reference position & velocity vector.
		const p = new Float64Array(3)
		const v = new Float64Array(3)

		p[0] = mdaRecord[this.#maxdim + 1]
		v[0] = mdaRecord[this.#maxdim + 2]

		p[1] = mdaRecord[this.#maxdim + 3]
		v[1] = mdaRecord[this.#maxdim + 4]

		p[2] = mdaRecord[this.#maxdim + 5]
		v[2] = mdaRecord[this.#maxdim + 6]

		// dt = mdaRecord.sliceArray(maxdim + 7 until 4 * maxdim + 7)
		const dt = new Float64Array(3 * this.#maxdim)
		const dto = this.#maxdim + 7

		for (let p = 0; p < this.#maxdim; p++) {
			const i = 3 * p
			dt[i] = mdaRecord[dto + p]
			dt[i + 1] = mdaRecord[dto + this.#maxdim + p]
			dt[i + 2] = mdaRecord[dto + 2 * this.#maxdim + p]
		}

		const kqo = 4 * this.#maxdim

		// Initializing the difference table.
		const kqmax1 = Math.trunc(mdaRecord[kqo + 7])
		const kq = new Int32Array(3)
		kq[0] = Math.trunc(mdaRecord[kqo + 8])
		kq[1] = Math.trunc(mdaRecord[kqo + 9])
		kq[2] = Math.trunc(mdaRecord[kqo + 10])

		const coefficient = { tl, g, p, v, dt, kqmax1, kq }
		this.#coefficients.set(index, coefficient)

		return coefficient
	}
}

// Aggregates several segments for the same center/target whose coverage windows may overlap,
// presenting them as a single segment. Its bounds are the union of the children, and lookups
// pick the highest-priority (latest in file order) child covering the requested epoch.
export class MultipleSpkSegment implements SpkSegment {
	readonly start: number
	readonly end: number
	readonly center: number
	readonly target: number
	readonly frame: number
	readonly startIndex: number
	readonly endIndex: number

	readonly #segments: SpkSegment[]

	// Validates segment compatibility and preserves file-order priority.
	constructor(segments: SpkSegment[]) {
		if (segments.length === 0) {
			throw new Error('at least one segment needs to be provided')
		}

		this.center = segments[0].center
		this.target = segments[0].target
		this.frame = segments[0].frame

		if (segments.length > 1 && segments.some((e) => e.center !== this.center || e.target !== this.target)) {
			throw new Error('one of the segments does not match the center or target')
		}
		// A merged segment exposes one frame. Mixed frames would make `at` return
		// differently oriented vectors depending on the epoch.
		if (segments.length > 1 && segments.some((e) => e.frame !== this.frame)) {
			throw new Error('one of the segments does not match the reference frame')
		}

		this.start = segments[0].start
		this.end = segments[0].end
		this.startIndex = segments[0].startIndex
		this.endIndex = segments[0].endIndex

		for (let i = 1; i < segments.length; i++) {
			const segment = segments[i]
			if (segment.start < this.start) this.start = segment.start
			if (segment.end > this.end) this.end = segment.end
			if (segment.startIndex < this.startIndex) this.startIndex = segment.startIndex
			if (segment.endIndex > this.endIndex) this.endIndex = segment.endIndex
		}

		// Preserve file order so later segments retain higher SPK priority.
		this.#segments = segments
	}

	// Initializes each segment in sequence.
	async initialize(): Promise<void> {
		for (const segment of this.#segments) await segment.initialize()
	}

	// Selects the highest-priority segment that covers the request epoch.
	at(time: Time): PositionAndVelocityMut {
		const seconds = spkSeconds(time)

		for (let i = this.#segments.length - 1; i >= 0; i--) {
			const segment = this.#segments[i]

			if (hasSegmentCoverage(segment, seconds)) {
				return segment.at(time)
			}
		}

		throw new Error(`cannot find a segment that covers the date: ${seconds}`)
	}
}
