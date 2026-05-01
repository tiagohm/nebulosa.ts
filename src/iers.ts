import { type Angle, arcsec } from './angle'
import { MJD0 } from './constants'
import { readLines, type Source } from './io'
import type { NumberArray } from './math'
import type { PolarMotion, Time, TimeDelta } from './time'
import { binarySearch } from './util'

const EMPTY_TABLE = new Float64Array(0)

export interface Iers {
	readonly dut1: TimeDelta
	readonly xy: PolarMotion

	readonly load: (source: Source) => Promise<void>
	readonly clear: () => void
}

// Parses one fixed-width numeric field and preserves blanks as NaN.
function parseNumber(line: string, start: number, end: number) {
	const value = line.slice(start, end).trim()
	return value ? +value : Number.NaN
}

// Returns the preferred finite value without treating zero as missing.
function selectFinite(value: number, fallback: number) {
	return Number.isFinite(value) ? value : fallback
}

// Computes the MJD value represented by the given time sample.
function modifiedJulianDate(time: Time) {
	return time.day - MJD0 + time.fraction
}

// Linearly interpolates one EOP column and clamps outside the tabulated range.
function interpolate(time: Time, input: NumberArray, data: NumberArray) {
	const n = input.length

	if (!n) return Number.NaN

	const mjd = modifiedJulianDate(time)
	const day = Math.floor(mjd)
	const i = binarySearch(input, day)

	if (i < 0) {
		const k = -(i + 1)

		// Do not extrapolate outside range, instead just propagate edge values.
		if (k <= 0) return data[0]
		if (k >= n) return data[n - 1]

		const t0 = input[k - 1]
		const t1 = input[k]
		const a = data[k - 1]
		const b = data[k]

		return Number.isFinite(a) && Number.isFinite(b) ? a + ((mjd - t0) / (t1 - t0)) * (b - a) : Number.NaN
	}

	// Exact hits on the final row must clamp to the last known value.
	if (i >= n - 1) return data[n - 1]

	const t0 = input[i]
	const t1 = input[i + 1]
	const a = data[i]
	const b = data[i + 1]

	return Number.isFinite(a) && Number.isFinite(b) ? a + ((mjd - t0) / (t1 - t0)) * (b - a) : Number.NaN
}

export abstract class IersBase implements Iers {
	protected mjd: NumberArray = EMPTY_TABLE
	protected pmX: NumberArray = EMPTY_TABLE
	protected pmY: NumberArray = EMPTY_TABLE
	protected ut1MinusUtc: NumberArray = EMPTY_TABLE

	dut1(time: Time): number {
		const dut1 = interpolate(time, this.mjd, this.ut1MinusUtc)
		return Number.isFinite(dut1) ? dut1 : 0
	}

	xy(time: Time): [Angle, Angle] {
		const x = interpolate(time, this.mjd, this.pmX)
		const y = interpolate(time, this.mjd, this.pmY)

		if (Number.isFinite(x) && Number.isFinite(y)) {
			return [arcsec(x), arcsec(y)]
		} else {
			return [0, 0]
		}
	}

	abstract load(source: Source): Promise<void>

	// Checks whether the requested time lies inside this table coverage range.
	covers(time: Time) {
		const n = this.mjd.length
		if (!n) return false
		const mjd = modifiedJulianDate(time)
		return mjd >= this.mjd[0] && mjd <= this.mjd[n - 1]
	}

	// Computes the distance in days from this table coverage interval.
	distance(time: Time) {
		const n = this.mjd.length
		if (!n) return Number.POSITIVE_INFINITY
		const mjd = modifiedJulianDate(time)
		if (mjd < this.mjd[0]) return this.mjd[0] - mjd
		if (mjd > this.mjd[n - 1]) return mjd - this.mjd[n - 1]
		return 0
	}

	// Replaces the active EOP table with compact numeric arrays.
	protected setTable(mjd: number[], pmX: number[], pmY: number[], ut1MinusUtc: number[]) {
		this.mjd = Float64Array.from(mjd)
		this.pmX = Float64Array.from(pmX)
		this.pmY = Float64Array.from(pmY)
		this.ut1MinusUtc = Float64Array.from(ut1MinusUtc)
	}

	clear() {
		this.mjd = EMPTY_TABLE
		this.pmX = EMPTY_TABLE
		this.pmY = EMPTY_TABLE
		this.ut1MinusUtc = EMPTY_TABLE
	}
}

// https://datacenter.iers.org/data/9/finals2000A.all
// https://maia.usno.navy.mil/ser7/readme.finals2000A
export class IersA extends IersBase {
	async load(source: Source) {
		const mjd: number[] = []
		const pmX: number[] = []
		const pmY: number[] = []
		const ut1MinusUtc: number[] = []

		for await (const line of readLines(source, 188)) {
			const epoch = parseNumber(line, 7, 15)
			const x = selectFinite(parseNumber(line, 134, 144), parseNumber(line, 18, 27))
			const y = selectFinite(parseNumber(line, 144, 154), parseNumber(line, 37, 46))
			const dut1 = selectFinite(parseNumber(line, 154, 165), parseNumber(line, 58, 68))

			if (Number.isFinite(epoch) && Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(dut1)) {
				mjd.push(epoch)
				pmX.push(x)
				pmY.push(y)
				ut1MinusUtc.push(dut1)
			}
		}

		this.setTable(mjd, pmX, pmY, ut1MinusUtc)
	}
}

// https://hpiers.obspm.fr/iers/eop/eopc04/eopc04.1962-now
// https://hpiers.obspm.fr/eoppc/eop/eopc04/eopc04.txt
export class IersB extends IersBase {
	async load(source: Source) {
		const mjd: number[] = []
		const pmX: number[] = []
		const pmY: number[] = []
		const ut1MinusUtc: number[] = []

		for await (const line of readLines(source, 219)) {
			if (line.startsWith('#')) continue

			const epoch = parseNumber(line, 16, 26)
			const x = parseNumber(line, 26, 38)
			const y = parseNumber(line, 38, 50)
			const dut1 = parseNumber(line, 50, 62)

			if (Number.isFinite(epoch) && Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(dut1)) {
				mjd.push(epoch)
				pmX.push(x)
				pmY.push(y)
				ut1MinusUtc.push(dut1)
			}
		}

		this.setTable(mjd, pmX, pmY, ut1MinusUtc)
	}
}

export class IersAB implements Iers {
	constructor(
		readonly a: IersA,
		readonly b: IersB,
	) {}

	// Picks the highest-priority table that covers this time, otherwise the nearest edge table.
	#table(time: Time) {
		if (this.b.covers(time)) return this.b
		if (this.a.covers(time)) return this.a
		return this.b.distance(time) <= this.a.distance(time) ? this.b : this.a
	}

	dut1(time: Time): number {
		return this.#table(time).dut1(time)
	}

	xy(time: Time): [Angle, Angle] {
		return this.#table(time).xy(time)
	}

	load(source: Source): Promise<void> {
		throw new Error('not supported')
	}

	clear() {
		this.a.clear()
		this.b.clear()
	}
}

export const iersa = new IersA()
export const iersb = new IersB()
export const iersab = new IersAB(iersa, iersb)

// Computes UT1 - UTC in seconds
export const dut1: TimeDelta = (time) => iersab.dut1(time)

export const xy: PolarMotion = (time) => iersab.xy(time)
