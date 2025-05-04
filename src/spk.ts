import type { PositionAndVelocity } from './astrometry'
import { AU_KM, DAYSEC, J2000 } from './constants'
import type { Daf, Summary } from './daf'
import { type Time, tdb } from './time'
import { type MutVec3, zeroVec } from './vector'

// https://naif.jpl.nasa.gov/pub/naif/toolkit_docs/FORTRAN/req/spk.html
export interface Spk {
	readonly segments: readonly [number, number, SpkSegment][]
	readonly segment: (center: number, target: number) => SpkSegment | undefined
}

export interface SpkSegment {
	readonly daf: Daf
	readonly source: string
	readonly start: number
	readonly end: number
	readonly center: number
	readonly target: number
	readonly frame: number
	readonly type: number
	readonly startIndex: number
	readonly endIndex: number

	readonly at: (time: Time) => Promise<PositionAndVelocity>
}

export function readSpk(daf: Daf): Spk {
	const segments = daf.summaries.map((e) => [e.ints[1], e.ints[0], makeSegment(e, daf)] as Spk['segments'][number])

	return {
		segments,
		segment: (center, target) => {
			return segments.find((e) => e[0] === center && e[1] === target)?.[2]
		},
	}
}

function makeSegment(summary: Summary, daf: Daf): SpkSegment {
	const [start, end] = summary.doubles
	const [target, center, frame, type, startIndex, endIndex] = summary.ints

	switch (type) {
		case 2:
		case 3:
			return new Type2And3Segment(daf, summary.name, start, end, center, target, frame, type, startIndex, endIndex)
		case 9:
			return new Type9Segment(daf, summary.name, start, end, center, target, frame, type, startIndex, endIndex)
		case 21:
			return new Type21Segment(daf, summary.name, start, end, center, target, frame, type, startIndex, endIndex)
	}

	throw Error('only binary SPK data types 2, 3, 9 and 21 are supported')
}

interface Type2And3Coefficient {
	readonly mid: number
	readonly radius: number
	readonly x: Float64Array
	readonly y: Float64Array
	readonly z: Float64Array
	readonly count: number
}

export class Type2And3Segment implements SpkSegment {
	private initialized = false
	private initialEpoch = 0
	private intervalLength = 0
	private rsize = 0
	private n = 0
	private readonly coefficients = new Map<number, Type2And3Coefficient>()

	constructor(
		readonly daf: Daf,
		readonly source: string,
		readonly start: number,
		readonly end: number,
		readonly center: number,
		readonly target: number,
		readonly frame: number,
		readonly type: number,
		readonly startIndex: number,
		readonly endIndex: number,
	) {}

	async at(time: Time): Promise<PositionAndVelocity> {
		if (!this.initialized) {
			// INIT: is the initial epoch of the first record, given in ephemeris seconds past J2000.
			// INTLEN: is the length of the interval covered by each record, in seconds.
			// RSIZE: is the total size of (number of array elements in) each record.
			// N: is the number of records contained in the segment.
			const [a, b, c, d] = await this.daf.read(this.endIndex - 3, this.endIndex)
			this.initialEpoch = a
			this.intervalLength = b
			this.rsize = Math.trunc(c)
			this.n = Math.trunc(d)
			this.initialized = true
		}

		const t = tdb(time)
		const d = (t.day - J2000 + t.fraction) * DAYSEC
		const index = Math.min(this.n, Math.trunc((d - this.initialEpoch) / this.intervalLength))

		if (!(await this.computeCoefficient(index))) {
			throw new Error(`cannot find a segment that covers the date: ${time.day}`)
		}

		// Chebyshev polynomial & differentiation.
		const c = this.coefficients.get(index)!

		const s = (2 * (d - (c.mid - c.radius))) / this.intervalLength - 1
		const ss = 2 * s

		const w0 = zeroVec()
		const w1 = zeroVec()
		const w2 = zeroVec()
		const dw0 = zeroVec()
		const dw1 = zeroVec()
		const dw2 = zeroVec()

		for (let i = c.count - 1; i >= 1; i--) {
			// Polynomial.

			w2[0] = w1[0]
			w2[1] = w1[1]
			w2[2] = w1[2]

			w1[0] = w0[0]
			w1[1] = w0[1]
			w1[2] = w0[2]

			w0[0] = c.x[i] + (ss * w1[0] - w2[0])
			w0[1] = c.y[i] + (ss * w1[1] - w2[1])
			w0[2] = c.z[i] + (ss * w1[2] - w2[2])

			// Differentiation.

			dw2[0] = dw1[0]
			dw2[1] = dw1[1]
			dw2[2] = dw1[2]

			dw1[0] = dw0[0]
			dw1[1] = dw0[1]
			dw1[2] = dw0[2]

			dw0[0] = 2 * w1[0] + dw1[0] * ss - dw2[0]
			dw0[1] = 2 * w1[1] + dw1[1] * ss - dw2[1]
			dw0[2] = 2 * w1[2] + dw1[2] * ss - dw2[2]
		}

		// AU
		w1[0] = (c.x[0] + (s * w0[0] - w1[0])) / AU_KM
		w1[1] = (c.y[0] + (s * w0[1] - w1[1])) / AU_KM
		w1[2] = (c.z[0] + (s * w0[2] - w1[2])) / AU_KM

		// AU/day
		w0[0] = (((w0[0] + s * dw0[0] - dw1[0]) / this.intervalLength) * (2 * DAYSEC)) / AU_KM
		w0[1] = (((w0[1] + s * dw0[1] - dw1[1]) / this.intervalLength) * (2 * DAYSEC)) / AU_KM
		w0[2] = (((w0[2] + s * dw0[2] - dw1[2]) / this.intervalLength) * (2 * DAYSEC)) / AU_KM

		return [w1, w0]
	}

	private async computeCoefficient(index: number) {
		if (this.coefficients.has(index)) return true

		const components = (this.type - 1) * 3
		const count = Math.trunc((this.rsize - 2) / components)
		const a = this.startIndex + index * this.rsize
		const b = a + this.rsize - 1

		if (a >= this.startIndex && a < b && b <= this.endIndex - 4) {
			const coefficients = await this.daf.read(a, b)

			const [mid, radius] = coefficients
			const x = new Float64Array(count)
			const y = new Float64Array(count)
			const z = new Float64Array(count)

			for (let m = 0; m < count; m++) {
				x[m] = coefficients[2 + m]
				y[m] = coefficients[2 + m + count]
				z[m] = coefficients[2 + m + 2 * count]
			}

			this.coefficients.set(index, { mid, radius, x, y, z, count })

			return true
		}

		return false
	}
}

export class Type9Segment implements SpkSegment {
	constructor(
		readonly daf: Daf,
		readonly source: string,
		readonly start: number,
		readonly end: number,
		readonly center: number,
		readonly target: number,
		readonly frame: number,
		readonly type: number,
		readonly startIndex: number,
		readonly endIndex: number,
	) {}

	// biome-ignore lint/suspicious/useAwait:
	async at(time: Time): Promise<PositionAndVelocity> {
		return [zeroVec(), zeroVec()]
	}
}

interface Type21Coefficent {
	readonly tl: number
	readonly g: Float64Array
	readonly p: number[]
	readonly v: number[]
	readonly dt: number[][]
	readonly kqmax1: number
	readonly kq: number[]
}

export class Type21Segment implements SpkSegment {
	private initialized = false
	private n = 0
	private epochDirCount = 0
	private maxdim = 0
	private dlsize = 0
	private epochTable: Float64Array = new Float64Array(0)
	private epochDir: Float64Array = new Float64Array(0)
	private readonly coefficients = new Map<number, Type21Coefficent>()

	constructor(
		readonly daf: Daf,
		readonly source: string,
		readonly start: number,
		readonly end: number,
		readonly center: number,
		readonly target: number,
		readonly frame: number,
		readonly type: number,
		readonly startIndex: number,
		readonly endIndex: number,
	) {}

	async at(time: Time): Promise<PositionAndVelocity> {
		if (!this.initialized) {
			const [a, b] = await this.daf.read(this.endIndex - 1, this.endIndex)
			this.maxdim = Math.trunc(a) // Difference line size.
			this.dlsize = 4 * this.maxdim + 11
			this.n = Math.trunc(b) // The number of records in a segment.
			// Epochs for all records in this segment.
			const start = this.startIndex + this.n * this.dlsize
			this.epochTable = await this.daf.read(start, start + this.n - 1)
			this.epochDirCount = Math.trunc(this.n / 100)
			if (this.epochDirCount > 0) this.epochDir = await this.daf.read(this.endIndex - this.epochDirCount - 1, this.endIndex - 2)
			this.initialized = true
		}

		const t = tdb(time)
		const seconds = (t.day - J2000 + t.fraction) * DAYSEC
		const index = this.searchCoefficientIndex(seconds)

		if (!(await this.computeCoefficient(index))) {
			throw new Error(`cannot find a segment that covers the date: ${seconds}`)
		}

		const c = this.coefficients.get(index)!

		// Next we set up for the computation of the various differences.
		const delta = seconds - c.tl
		let tp = delta
		const mpq2 = c.kqmax1 - 2
		let ks = c.kqmax1 - 1

		// TP starts out as the delta t between the request time and the
		// difference line's reference epoch. We then change it from DELTA
		// by the components of the stepsize vector G.
		const fc = new Float64Array(25)
		const wc = new Float64Array(25 - 1)
		const w = new Float64Array(25 + 3)

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
		const p = zeroVec()
		const v = zeroVec()

		for (let i = 0; i < 3; i++) {
			const kqq = c.kq[i]
			let sum = 0

			for (let j = kqq - 1; j >= 0; j--) {
				sum += c.dt[j][i] * w[j + ks]
			}

			p[i] = (c.p[i] + delta * (c.v[i] + delta * sum)) / AU_KM
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
				sum += c.dt[j][i] * w[j + ks]
			}

			v[i] = ((c.v[i] + delta * sum) * DAYSEC) / AU_KM
		}

		return [p, v]
	}

	private searchCoefficientIndex(seconds: number): number {
		let a: number
		let b: number

		if (this.epochDirCount > 0) {
			// TODO: Not tested!
			let subdir = 0

			while (subdir < this.epochDirCount && this.epochDir[subdir] < seconds) {
				subdir++
			}

			a = subdir * 100
			b = (subdir + 1) * 100
		} else {
			a = 0
			b = this.n
		}

		let index = -1

		// Search target epoch in epoch table.
		for (let i = a; i < b; i++) {
			if (i < this.epochTable.length && this.epochTable[i] >= seconds) {
				index = i
				break
			}
		}

		if (index === -1) {
			throw new Error(`cannot find a segment that covers the date: ${seconds}`)
		}

		return index
	}

	private async computeCoefficient(index: number) {
		if (index < 0) return false
		if (this.coefficients.has(index)) return true

		const mdaRecord = await this.daf.read(this.startIndex + index * this.dlsize, this.startIndex + (index + 1) * this.dlsize - 1)

		// Reference epoch of record.
		const tl = mdaRecord[0]
		// Stepsize function vector.
		const g = mdaRecord.subarray(1, this.maxdim + 1)

		// Reference position & velocity vector.
		const p = zeroVec()
		const v = zeroVec()

		p[0] = mdaRecord[this.maxdim + 1]
		v[0] = mdaRecord[this.maxdim + 2]

		p[1] = mdaRecord[this.maxdim + 3]
		v[1] = mdaRecord[this.maxdim + 4]

		p[2] = mdaRecord[this.maxdim + 5]
		v[2] = mdaRecord[this.maxdim + 6]

		// dt = mdaRecord.sliceArray(maxdim + 7 until 4 * maxdim + 7)
		const dt = new Array<MutVec3>(this.maxdim)
		const dto = this.maxdim + 7

		for (let p = 0; p < this.maxdim; p++) {
			dt[p] = [mdaRecord[dto + p], mdaRecord[dto + this.maxdim + p], mdaRecord[dto + 2 * this.maxdim + p]]
		}

		const kqo = 4 * this.maxdim

		// Initializing the difference table.
		const kqmax1 = Math.trunc(mdaRecord[kqo + 7])
		const kq = zeroVec()
		kq[0] = Math.trunc(mdaRecord[kqo + 8])
		kq[1] = Math.trunc(mdaRecord[kqo + 9])
		kq[2] = Math.trunc(mdaRecord[kqo + 10])

		this.coefficients.set(index, { tl, g, p, v, dt, kqmax1, kq })

		return true
	}
}
