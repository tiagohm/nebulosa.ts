import { arcsec, type Angle } from './angle'
import { MJD0 } from './constants'
import { binarySearch } from './helper'
import { readLinesFromArrayBuffer } from './io'
import type { PolarMotion, Time, TimeDelta } from './time'

export interface Iers {
	delta: TimeDelta
	xy: PolarMotion

	load: (buffer: AllowSharedBufferSource) => Promise<void>
	clear: () => void
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

			if (isFinite(a) && isFinite(b)) {
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
		return interpolate(time, this.mjd, this.dut1)[0]
	}

	xy(time: Time): [Angle, Angle] {
		const [x, y] = interpolate(time, this.mjd, this.pmX, this.pmY)

		if (isFinite(x) && isFinite(y)) {
			return [arcsec(x), arcsec(y)]
		} else {
			return [0, 0]
		}
	}

	abstract load(buffer: AllowSharedBufferSource): Promise<void>

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
	load(buffer: AllowSharedBufferSource) {
		this.clear()

		return readLinesFromArrayBuffer(buffer, (line) => {
			const pmXa = parseFloat(line.substring(18, 27).trim())
			const pmYa = parseFloat(line.substring(37, 46).trim())
			const pmXb = parseFloat(line.substring(134, 144).trim())
			const pmYb = parseFloat(line.substring(144, 154).trim())
			const dut1a = parseFloat(line.substring(58, 68).trim())
			const dut1b = parseFloat(line.substring(154, 165).trim())

			if ((pmXb || pmXa) && (pmYb || pmYa) && (dut1b || dut1a)) {
				const mjd = parseFloat(line.substring(7, 15).trim())
				this.mjd.push(mjd)
				this.pmX.push(pmXb || pmXa)
				this.pmY.push(pmYb || pmYa)
				this.dut1.push(dut1b || dut1a)
			}
		})
	}
}

// https://hpiers.obspm.fr/iers/eop/eopc04/eopc04.1962-now
// https://hpiers.obspm.fr/eoppc/eop/eopc04/eopc04.txt
export class IersB extends IersBase {
	async load(buffer: AllowSharedBufferSource) {
		this.clear()

		return readLinesFromArrayBuffer(buffer, (line) => {
			if (line.startsWith('#')) return

			const pmX = parseFloat(line.substring(26, 38).trim())
			const pmY = parseFloat(line.substring(38, 50).trim())
			const dut1 = parseFloat(line.substring(50, 62).trim())

			if (pmX && pmY && dut1) {
				const mjd = parseFloat(line.substring(16, 26).trim())
				this.mjd.push(mjd)
				this.pmX.push(pmX)
				this.pmY.push(pmY)
				this.dut1.push(dut1)
			}
		})
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
		if (!b[0] || !b[1]) return this.a.xy(time)
		return b
	}

	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	load(buffer: AllowSharedBufferSource): Promise<void> {
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
