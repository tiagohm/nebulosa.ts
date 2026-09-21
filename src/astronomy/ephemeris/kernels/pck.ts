import { DAYSEC, J2000 } from '../../../core/constants'
import { type Mat3, matClone, matFill, matIdentity, type MutMat3, matRotX, matRotZ } from '../../../math/linear-algebra/mat3'
import type { Frame } from '../../coordinates/frame'
import { type Time, tdb } from '../../time/time'
import type { Summary, SyncDaf } from './daf'

// Reader and evaluator for binary PCK (Planetary Constants Kernel) orientation
// stored in DAF files. Type 2 segments hold Chebyshev series for the three Euler
// angles φ, δ, W of the body-fixed frame relative to the segment's inertial frame
// (J2000 / NAIF id 1). Angles are radians, epochs are TDB seconds past J2000, and
// the public Frame rate is W = dR/dt·Rᵀ in radians/day. initialize() loads only
// INIT/INTLEN/RSIZE/N; each Chebyshev record is read and cached on demand via
// SyncDaf.readSync, so the DAF source must remain open while rotationAt /
// dRdtTimesRtAt are used.

// https://naif.jpl.nasa.gov/pub/naif/toolkit_docs/C/req/pck.html

// A parsed binary PCK file: all segments plus a frame-class-id lookup.
export interface Pck {
	// All segments in file order.
	readonly segments: readonly PckSegment[]
	// Resolves the highest-priority segment group for a PCK frame class id, if present.
	readonly segment: (frameClassId: number) => PckSegment | undefined
}

// One PCK segment: orientation of `frameClassId` relative to `inertialFrameId` over [start, end].
export interface PckSegment extends Frame {
	// Segment coverage start, in ephemeris seconds past J2000 (TDB).
	readonly start: number
	// Segment coverage end, in ephemeris seconds past J2000 (TDB).
	readonly end: number
	// PCK frame class id stored in the DAF summary (NAIF integer 1).
	readonly frameClassId: number
	// Inertial reference-frame id the Euler angles are measured against (NAIF integer 2).
	readonly inertialFrameId: number
	// PCK data type (2 is Chebyshev Euler angles).
	readonly type: number
	// First DAF word index of the segment data (1-based).
	readonly startIndex: number
	// Last DAF word index of the segment data (1-based).
	readonly endIndex: number
	// Loads INIT/INTLEN/RSIZE/N. Coefficient records are read later on demand. Safe to call more than once.
	readonly initialize: () => Promise<void>
	// Analytic W = dR/dt·Rᵀ (radians/day). Always present for Type 2 PCK.
	readonly dRdtTimesRtAt: (time: Time, rotation?: Mat3) => Mat3
}

// Decoded Chebyshev record for a type 2 PCK segment.
interface Type2PckCoefficient {
	// Midpoint epoch of the record, in ephemeris seconds past J2000.
	readonly mid: number
	// Half-length of the record interval, in seconds; normalizes time into [-1, 1].
	readonly radius: number
	// Chebyshev coefficients for Euler angle φ (radians).
	readonly phi: Float64Array
	// Chebyshev coefficients for Euler angle δ (radians).
	readonly delta: Float64Array
	// Chebyshev coefficients for Euler angle W (radians).
	readonly w: Float64Array
}

// Reads PCK summaries and builds a reusable frame-class-id segment lookup.
export function readPck(daf: SyncDaf): Pck {
	const segments = new Array<PckSegment>(daf.summaries.length)
	const groups = new Map<number, PckSegment[]>()

	for (let i = 0; i < daf.summaries.length; i++) {
		const segment = makePckSegment(daf.summaries[i], daf)
		segments[i] = segment
		appendPckSegment(groups, segment)
	}

	const byClassId = new Map<number, PckSegment>()

	for (const [frameClassId, list] of groups) {
		byClassId.set(frameClassId, list.length === 1 ? list[0] : new MultiplePckSegment(list))
	}

	return {
		segments,
		segment: (frameClassId) => byClassId.get(frameClassId),
	}
}

// Appends a segment to its frame-class-id group, preserving file order.
function appendPckSegment(groups: Map<number, PckSegment[]>, segment: PckSegment) {
	let list = groups.get(segment.frameClassId)

	if (!list) {
		list = []
		groups.set(segment.frameClassId, list)
	}

	list.push(segment)
}

// Instantiates the concrete segment reader for a supported PCK data type.
function makePckSegment(summary: Summary, daf: SyncDaf): PckSegment {
	const [start, end] = summary.doubles
	const [frameClassId, inertialFrameId, type, startIndex, endIndex] = summary.ints

	switch (type) {
		case 2:
			return new Type2PckSegment(daf, start, end, frameClassId, inertialFrameId, startIndex, endIndex)
		default:
			throw new Error(`unsupported PCK data type ${type}`)
	}
}

// Converts an arbitrary input instant to PCK ephemeris seconds past J2000.
function pckSeconds(time: Time) {
	const { day, fraction } = tdb(time)
	return (day - J2000 + fraction) * DAYSEC
}

// Checks whether the request epoch is covered by the segment interval, including both ends.
function hasSegmentCoverage(segment: PckSegment, seconds: number) {
	return seconds >= segment.start && seconds <= segment.end
}

// Evaluates a 3D Chebyshev series and its first derivative in one Clenshaw pass.
function evaluateChebyshevVectorDerivative(x: Float64Array, y: Float64Array, z: Float64Array, s: number, velocityScale: number, position: [number, number, number], velocity: [number, number, number]) {
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

	const ss = 2 * s

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
}

// Type 2: Chebyshev Euler angles (φ, δ, W) as a function of TDB seconds past J2000.
// NAIF pxform / Skyfield use active axis rotations whose sine convention is the
// transpose of matRot*. Matching that R with these builders is
//   R = Rz(W) · Rx(δ) · Rz(φ)
// Analytic W = dR/dt·Rᵀ uses the same polynomials (radians/day at the Frame boundary).
export class Type2PckSegment implements PckSegment {
	#initialized = false
	#init?: Promise<void>
	#initialEpoch = 0
	#intervalLength = 0
	#rsize = 0
	#n = 0
	#count = 0
	#lastSeconds = Number.NaN
	readonly #coefficients = new Map<number, Type2PckCoefficient>()
	readonly #angles: [number, number, number] = [0, 0, 0]
	readonly #rates: [number, number, number] = [0, 0, 0]
	readonly #r: MutMat3 = matIdentity()
	readonly #w: MutMat3 = matIdentity()

	// Stores immutable metadata and the backing DAF reader for this Chebyshev PCK segment.
	constructor(
		readonly daf: SyncDaf,
		readonly start: number,
		readonly end: number,
		readonly frameClassId: number,
		readonly inertialFrameId: number,
		readonly startIndex: number,
		readonly endIndex: number,
	) {}

	// PCK Type 2: Chebyshev Euler angles.
	readonly type = 2

	// Loads INIT, INTLEN, RSIZE, and N from the tail of the segment.
	initialize(): Promise<void> {
		if (this.#initialized) return Promise.resolve()
		if (this.#init) return this.#init

		this.#init = this.#load()
		return this.#init
	}

	// Instantaneous inertial → body-fixed rotation at `time`. The returned matrix is a copy.
	rotationAt(time: Time): Mat3 {
		this.#evaluate(time)
		return matClone(this.#r)
	}

	// Analytic W = dR/dt·Rᵀ (radians/day) at `time`. The returned matrix is a copy.
	// `rotation` is ignored; the operator is formed from the same Chebyshev angles as rotationAt.
	dRdtTimesRtAt(time: Time, _rotation?: Mat3): Mat3 {
		this.#evaluate(time)
		return matClone(this.#w)
	}

	// Reads INIT, INTLEN, RSIZE, and N from the last four words of the segment.
	async #load(): Promise<void> {
		try {
			const directory = await this.daf.read(this.endIndex - 3, this.endIndex)
			this.#initialEpoch = directory[0]
			this.#intervalLength = directory[1]
			this.#rsize = Math.trunc(directory[2])
			this.#n = Math.trunc(directory[3])
			this.#count = Math.trunc((this.#rsize - 2) / 3)
			this.#initialized = true
		} catch (error) {
			this.#init = undefined
			throw error
		}
	}

	// Evaluates Euler angles and fills #r / #w for `time`, reusing the last result when the epoch is unchanged.
	#evaluate(time: Time) {
		if (!this.#initialized) throw new Error('PCK segment is not initialized')

		const seconds = pckSeconds(time)
		if (seconds === this.#lastSeconds) return

		if (!hasSegmentCoverage(this, seconds)) throw new Error(`cannot find a PCK segment that covers the date: ${seconds}`)

		const index = Math.max(0, Math.min(this.#n - 1, Math.floor((seconds - this.#initialEpoch) / this.#intervalLength)))
		const c = this.#coefficient(index)

		if (!c) throw new Error(`cannot find a PCK segment that covers the date: ${seconds}`)

		const s = (seconds - c.mid) / c.radius
		evaluateChebyshevVectorDerivative(c.phi, c.delta, c.w, s, 1 / c.radius, this.#angles, this.#rates)
		pckRotationAndW(this.#angles[0], this.#angles[1], this.#angles[2], this.#rates[0], this.#rates[1], this.#rates[2], this.#r, this.#w)
		this.#lastSeconds = seconds
	}

	// Returns a cached Chebyshev record, reading that record alone from the DAF on first use.
	#coefficient(index: number) {
		const cached = this.#coefficients.get(index)
		if (cached) return cached
		if (index < 0 || index >= this.#n) return undefined

		const start = this.startIndex + index * this.#rsize
		const end = start + this.#rsize - 1
		if (!(start >= this.startIndex && start < end && end <= this.endIndex - 4)) return undefined

		const words = this.daf.readSync(start, end)
		const count = this.#count
		const coefficient: Type2PckCoefficient = {
			mid: words[0],
			radius: words[1],
			phi: words.subarray(2, 2 + count),
			delta: words.subarray(2 + count, 2 + 2 * count),
			w: words.subarray(2 + 2 * count, 2 + 3 * count),
		}

		this.#coefficients.set(index, coefficient)

		return coefficient
	}
}

// Builds R = Rz(w)·Rx(δ)·Rz(φ) in the matRot* convention so the numeric matrix
// equals Skyfield/NAIF pxform Rz_active(−w)·Rx_active(−δ)·Rz_active(−φ).
// Euler rates `dphi`, `ddelta`, `dw` are radians/second from the Chebyshev derivative.
// The closed-form W = dR/dt·Rᵀ (then scaled to rad/day) matches NAIF sxform.
function pckRotationAndW(phi: number, delta: number, w: number, dphi: number, ddelta: number, dw: number, outR: MutMat3, outW: MutMat3) {
	matIdentity(outR)
	matRotZ(phi, outR)
	matRotX(delta, outR)
	matRotZ(w, outR)

	const ca = Math.cos(w)
	const sa = Math.sin(w)
	const u = Math.cos(delta)
	const v = -Math.sin(delta)
	const omega0 = (dw + u * dphi) * DAYSEC
	const omega1 = (ca * ddelta - sa * v * dphi) * DAYSEC
	const omega2 = (sa * ddelta + ca * v * dphi) * DAYSEC

	matFill(outW, 0, omega0, omega2, -omega0, 0, omega1, -omega2, -omega1, 0)
}

// Aggregates several segments for the same frame class id whose coverage windows may overlap.
// Lookups pick the highest-priority (latest in file order) child covering the requested epoch.
export class MultiplePckSegment implements PckSegment {
	readonly start: number
	readonly end: number
	readonly frameClassId: number
	readonly inertialFrameId: number
	readonly type: number
	readonly startIndex: number
	readonly endIndex: number
	readonly #segments: PckSegment[]

	// Validates segment compatibility and preserves file-order priority.
	constructor(segments: PckSegment[]) {
		if (segments.length === 0) {
			throw new Error('at least one segment needs to be provided')
		}

		this.frameClassId = segments[0].frameClassId
		this.inertialFrameId = segments[0].inertialFrameId
		this.type = segments[0].type

		if (segments.length > 1 && segments.some((e) => e.frameClassId !== this.frameClassId)) {
			throw new Error('one of the segments does not match the frame class id')
		}
		if (segments.length > 1 && segments.some((e) => e.inertialFrameId !== this.inertialFrameId)) {
			throw new Error('one of the segments does not match the inertial frame id')
		}
		if (segments.length > 1 && segments.some((e) => e.type !== this.type)) {
			throw new Error('one of the segments does not match the PCK data type')
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

		this.#segments = segments
	}

	// Initializes every child segment.
	async initialize(): Promise<void> {
		for (const segment of this.#segments) {
			await segment.initialize()
		}
	}

	// Selects the highest-priority covering child and returns its rotation.
	rotationAt(time: Time): Mat3 {
		return this.#covering(time).rotationAt(time)
	}

	// Selects the highest-priority covering child and returns its angular-velocity operator.
	dRdtTimesRtAt(time: Time, rotation?: Mat3): Mat3 {
		return this.#covering(time).dRdtTimesRtAt(time, rotation)
	}

	// Latest-in-file child that covers `time`.
	#covering(time: Time): PckSegment {
		const seconds = pckSeconds(time)

		for (let i = this.#segments.length - 1; i >= 0; i--) {
			const segment = this.#segments[i]
			if (hasSegmentCoverage(segment, seconds)) return segment
		}

		throw new Error(`cannot find a PCK segment that covers the date: ${seconds}`)
	}
}
