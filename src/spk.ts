import type { PositionAndVelocity } from './astrometry'
import { AU_KM, DAYSEC, J2000 } from './constants'
import type { Daf, Summary } from './daf'
import { tdb, type Time } from './time'
import { zero, type MutVec3 } from './vector'

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

	readonly compute: (time: Time) => Promise<PositionAndVelocity>
}

export function spk(daf: Daf): Spk {
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

	async compute(time: Time): Promise<PositionAndVelocity> {
		if (!this.initialized) {
			this.initialized = true

			// INIT: is the initial epoch of the first record, given in ephemeris seconds past J2000.
			// INTLEN: is the length of the interval covered by each record, in seconds.
			// RSIZE: is the total size of (number of array elements in) each record.
			// N: is the number of records contained in the segment.
			const [a, b, c, d] = await this.daf.read(this.endIndex - 3, this.endIndex)
			this.initialEpoch = a
			this.intervalLength = b
			this.rsize = Math.trunc(c)
			this.n = Math.trunc(d)
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

		const w0: MutVec3 = [0, 0, 0]
		const w1: MutVec3 = [0, 0, 0]
		const w2: MutVec3 = [0, 0, 0]
		const dw0: MutVec3 = [0, 0, 0]
		const dw1: MutVec3 = [0, 0, 0]
		const dw2: MutVec3 = [0, 0, 0]

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

	// eslint-disable-next-line @typescript-eslint/require-await
	async compute(time: Time): Promise<PositionAndVelocity> {
		return [zero(), zero()]
	}
}

export class Type21Segment implements SpkSegment {
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

	async compute(time: Time): Promise<PositionAndVelocity> {
		return [zero(), zero()]
	}
}
