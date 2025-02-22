import { type Angle, arcsec } from './angle'
import { MJD0 } from './constants'
import { binarySearch } from './helper'
import { type Source, readLines } from './io'
import type { PolarMotion, Time, TimeDelta } from './time'

export interface Iers {
	readonly delta: TimeDelta
	readonly xy: PolarMotion

	readonly load: (source: Source) => Promise<void>
	readonly clear: () => void
}

export function interpolate(time: Time, input: number[], ...data: number[][]): number[] {
	const ret = new Array<number>(data.length)

	if (!input.length) return ret

	// const value = time.value
	const mjd = Math.floor(time.day - MJD0 + time.fraction)
	const utc = time.day - (MJD0 + mjd) + time.fraction

	const i = binarySearch(input, mjd, { positive: true })
	const k = Math.max(1, Math.min(i + 1, input.length - 1))
	const t0 = input[k - 1]
	const t1 = input[k]

	for (let z = 0; z < data.length; z++) {
		// Do not extrapolate outside range, instead just propagate last values.
		if (i <= 0) {
			ret[z] = data[z][0]
		} else if (i >= input.length) {
			ret[z] = data[z][data[z].length - 1]
		} else {
			const a = data[z][k - 1]
			const b = data[z][k]

			if (Number.isFinite(a) && Number.isFinite(b)) {
				// a + ((b - a) / (t1 - t0)) * (value - t0)
				ret[z] = a + ((mjd - t0 + utc) / (t1 - t0)) * (b - a)
			} else {
				ret[z] = NaN
			}
		}
	}

	return ret
}

export abstract class IersBase implements Iers {
	protected mjd: number[] = []
	protected pmX: number[] = []
	protected pmY: number[] = []
	protected dut1: number[] = []

	delta(time: Time): number {
		return interpolate(time, this.mjd, this.dut1)[0] || 0
	}

	xy(time: Time): [Angle, Angle] {
		const [x, y] = interpolate(time, this.mjd, this.pmX, this.pmY)

		if (Number.isFinite(x) && Number.isFinite(y)) {
			return [arcsec(x), arcsec(y)]
		} else {
			return [0, 0]
		}
	}

	abstract load(source: Source): Promise<void>

	clear() {
		this.mjd = []
		this.pmX = []
		this.pmY = []
		this.dut1 = []
	}
}

// https://datacenter.iers.org/data/9/finals2000A.all
// https://maia.usno.navy.mil/ser7/readme.finals2000A
export class IersA extends IersBase {
	async load(source: Source) {
		this.clear()

		for await (const line of readLines(source, 188)) {
			const pmXa = +line.substring(18, 27)
			const pmYa = +line.substring(37, 46)
			const pmXb = +line.substring(134, 144)
			const pmYb = +line.substring(144, 154)
			const dut1a = +line.substring(58, 68)
			const dut1b = +line.substring(154, 165)

			if ((pmXb || pmXa) && (pmYb || pmYa) && (dut1b || dut1a)) {
				const mjd = +line.substring(7, 15)
				this.mjd.push(mjd)
				this.pmX.push(pmXb || pmXa)
				this.pmY.push(pmYb || pmYa)
				this.dut1.push(dut1b || dut1a)
			}
		}
	}
}

// https://hpiers.obspm.fr/iers/eop/eopc04/eopc04.1962-now
// https://hpiers.obspm.fr/eoppc/eop/eopc04/eopc04.txt
export class IersB extends IersBase {
	async load(source: Source) {
		this.clear()

		for await (const line of readLines(source, 219)) {
			if (line.startsWith('#')) continue

			const pmX = +line.substring(26, 38)
			const pmY = +line.substring(38, 50)
			const dut1 = +line.substring(50, 62)

			if (pmX && pmY && dut1) {
				const mjd = +line.substring(16, 26)
				this.mjd.push(mjd)
				this.pmX.push(pmX)
				this.pmY.push(pmY)
				this.dut1.push(dut1)
			}
		}
	}
}

export class IersAB implements Iers {
	constructor(
		readonly a: IersA,
		readonly b: IersB,
	) {}

	delta(time: Time): number {
		return this.b.delta(time) || this.a.delta(time)
	}

	xy(time: Time): [Angle, Angle] {
		const b = this.b.xy(time)
		if (!(b[0] && b[1])) return this.a.xy(time)
		return b
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

export const delta: TimeDelta = (time) => {
	return iersab.delta(time)
}

export const xy: PolarMotion = (time) => {
	return iersab.xy(time)
}
