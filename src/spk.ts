import type { PositionAndVelocity } from './astrometry'
import { AU_KM, DAYSEC, J2000 } from './constants'
import type { Daf, Summary } from './daf'
import { type Time, tdb } from './time'
import type { MutVec3 } from './vec3'

// https://naif.jpl.nasa.gov/pub/naif/toolkit_docs/FORTRAN/req/spk.html
// https://naif.jpl.nasa.gov/pub/naif/misc/toolkit_docs_N0067/C/req/spk.html

const KM_TO_AU = 1 / AU_KM
const KM_PER_SECOND_TO_AU_PER_DAY = DAYSEC / AU_KM

export interface Spk {
	readonly segments: readonly [number, number, SpkSegment][]
	readonly segment: (center: number, target: number) => SpkSegment | undefined
}

export interface SpkSegment {
	// readonly daf: Daf
	// readonly source: string
	readonly start: number
	readonly end: number
	readonly center: number
	readonly target: number
	// readonly frame: number
	// readonly type: number
	readonly startIndex: number
	readonly endIndex: number

	readonly at: (time: Time) => Promise<PositionAndVelocity>
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
		segment: (center, target) => segmentByTarget.get(center)?.get(target),
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

// Converts an arbitrary input instant to SPK ephemeris seconds past J2000.
function spkSeconds(time: Time) {
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
	const [start, end] = summary.doubles
	const [target, center, frame, type, startIndex, endIndex] = summary.ints

	switch (type) {
		case 2:
		case 3:
			return new Type2And3Segment(daf, start, end, center, target, type, startIndex, endIndex)
		case 9:
			return new Type9Segment(daf, start, end, center, target, startIndex, endIndex)
		case 21:
			return new Type21Segment(daf, start, end, center, target, startIndex, endIndex)
	}

	throw new Error('only binary SPK data types 2, 3, 9 and 21 are supported')
}

// More info about spk types: https://spiceypy.readthedocs.io/en/latest/spk.html

interface Type2And3Coefficient {
	readonly mid: number
	readonly radius: number
	readonly x: Float64Array
	readonly y: Float64Array
	readonly z: Float64Array
	readonly vx?: Float64Array
	readonly vy?: Float64Array
	readonly vz?: Float64Array
	readonly count: number
}

// Evaluates one 3D Chebyshev series with a shared normalized time argument.
function evaluateChebyshevVector(x: Float64Array, y: Float64Array, z: Float64Array, s: number, o: MutVec3): MutVec3 {
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

	o[0] = x[0] + s * x0 - x1
	o[1] = y[0] + s * y0 - y1
	o[2] = z[0] + s * z0 - z1

	return o
}

// Evaluates a 3D Chebyshev position series and its first derivative in one pass.
function evaluateChebyshevVectorDerivative(x: Float64Array, y: Float64Array, z: Float64Array, s: number, velocityScale: number, position: MutVec3, velocity: MutVec3): PositionAndVelocity {
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
		// readonly frame: number,
		type: number,
		readonly startIndex: number,
		readonly endIndex: number,
	) {
		this.#daf = daf
		this.#type = type
	}

	// Evaluates position and velocity at the requested epoch.
	async at(time: Time): Promise<PositionAndVelocity> {
		await this.#initialize()

		const seconds = spkSeconds(time)

		if (!hasSegmentCoverage(this, seconds)) {
			throw new Error(`cannot find a segment that covers the date: ${seconds}`)
		}

		const index = Math.max(0, Math.min(this.#n - 1, Math.floor((seconds - this.#initialEpoch) / this.#intervalLength)))
		const c = await this.#computeCoefficient(index)

		if (!c) {
			throw new Error(`cannot find a segment that covers the date: ${seconds}`)
		}

		const s = (seconds - c.mid) / c.radius
		const p: MutVec3 = [0, 0, 0]
		const v: MutVec3 = [0, 0, 0]

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
	async #initialize(): Promise<void> {
		if (this.#initialized) return

		// INIT: is the initial epoch of the first record, given in ephemeris seconds past J2000.
		// INTLEN: is the length of the interval covered by each record, in seconds.
		// RSIZE: is the total size of (number of array elements in) each record.
		// N: is the number of records contained in the segment.

		const [a, b, c, d] = await this.#daf.read(this.endIndex - 3, this.endIndex)
		this.#initialEpoch = a
		this.#intervalLength = b
		this.#rsize = Math.trunc(c)
		this.#n = Math.trunc(d)
		this.#count = Math.trunc((this.#rsize - 2) / (this.#type === 3 ? 6 : 3))
		this.#initialized = true
	}

	// Reads and caches one Chebyshev record from the segment.
	async #computeCoefficient(index: number): Promise<Type2And3Coefficient | undefined> {
		const cached = this.#coefficients.get(index)
		if (cached) return cached
		if (index < 0 || index >= this.#n) return undefined

		const a = this.startIndex + index * this.#rsize
		const b = a + this.#rsize - 1

		if (a >= this.startIndex && a < b && b <= this.endIndex - 4) {
			const coefficients = await this.#daf.read(a, b)

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
// a Lagrange interpolation method. The epochs (also called time tags ) associated with the states
// need not be evenly spaced. For a request epoch not corresponding to the time tag of some state,
// the data type defines a state by interpolating each component of a set of states whose epochs are
// centered near the request epoch.
export class Type9Segment implements SpkSegment {
	#initialized = false
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
		// readonly frame: number,
		// readonly type: number,
		readonly startIndex: number,
		readonly endIndex: number,
	) {
		this.#daf = daf
	}

	// Interpolates one state vector at the requested epoch.
	async at(time: Time): Promise<PositionAndVelocity> {
		await this.#initialize()

		const seconds = spkSeconds(time)
		const index = this.#searchEpochIndex(seconds)

		if (index < 0) {
			throw new Error(`cannot find a segment that covers the date: ${seconds}`)
		}

		const window = Math.min(this.#degree + 1, this.#n)
		const begin = this.#windowStart(seconds, index, window)
		const end = begin + window

		const p: MutVec3 = [0, 0, 0]
		const v: MutVec3 = [0, 0, 0]

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
	async #initialize(): Promise<void> {
		if (this.#initialized) return

		const [a, b] = await this.#daf.read(this.endIndex - 1, this.endIndex)
		this.#degree = Math.trunc(a)
		this.#n = Math.trunc(b)

		const stateLength = this.#n * 6
		this.#stateTable = await this.#daf.read(this.startIndex, this.startIndex + stateLength - 1)
		this.#epochTable = await this.#daf.read(this.startIndex + stateLength, this.startIndex + stateLength + this.#n - 1)
		this.#initialized = true
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

interface Type21Coefficient {
	readonly tl: number
	readonly g: Float64Array
	readonly p: Float64Array
	readonly v: Float64Array
	readonly dt: Float64Array
	readonly kqmax1: number
	readonly kq: Int32Array
}

// Type 21: Extended Modified Difference Arrays
// The SPK Type 21 contains extended Modified Difference Arrays (MDA), also called difference lines.
// These data structures use the same mathematical trajectory representation as SPK data type 1,
// but type 21 allows use of larger, higher-degree MDAs.
export class Type21Segment implements SpkSegment {
	#initialized = false
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
		// readonly frame: number,
		// readonly type: number,
		readonly startIndex: number,
		readonly endIndex: number,
	) {
		this.#daf = daf
	}

	// Interpolates one extended MDA record at the requested epoch.
	async at(time: Time): Promise<PositionAndVelocity> {
		await this.#initialize()

		const seconds = spkSeconds(time)
		const index = this.#searchCoefficientIndex(seconds)
		const c = await this.#computeCoefficient(index)

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
		const p: MutVec3 = [0, 0, 0]
		const v: MutVec3 = [0, 0, 0]

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
	async #initialize(): Promise<void> {
		if (this.#initialized) return

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
	}

	// Finds the first record whose final epoch is not less than the request epoch.
	#searchCoefficientIndex(seconds: number) {
		if (!hasSegmentCoverage(this, seconds)) {
			return -1
		}

		return Math.min(lowerBoundEpoch(this.#epochTable, seconds, 0, this.#n), this.#n - 1)
	}

	// Reads and caches one extended MDA record from the segment.
	async #computeCoefficient(index: number): Promise<Type21Coefficient | undefined> {
		const cached = this.#coefficients.get(index)
		if (cached) return cached
		if (index < 0 || index >= this.#n) return undefined

		const mdaRecord = await this.#daf.read(this.startIndex + index * this.#dlsize, this.startIndex + (index + 1) * this.#dlsize - 1)

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

export class MultipleSpkSegment implements SpkSegment {
	readonly start: number
	readonly end: number
	readonly center: number
	readonly target: number
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

		if (segments.length > 1 && segments.some((e) => e.center !== this.center || e.target !== this.target)) {
			throw new Error('one of the segments does not match the center or target')
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

	// Selects the highest-priority segment that covers the request epoch.
	at(time: Time): Promise<PositionAndVelocity> {
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
