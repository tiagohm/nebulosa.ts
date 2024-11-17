import { DAYSEC, MJD0 } from './constants'
import { twoProduct, twoSum } from './math'

// Holds the number of Julian days and the fraction of the day.
export type Time = [number, number]

export enum JulianCalendarCutOff {
	None = 0,
	GregorianStart = 2299161,
	GregorianStartEngland = 2361222,
}

export function time(day: number, fraction: number = 0): Time {
	return normalize(day, fraction)
}

export function timeFromEpoch(epoch: number, unit: number, day: number, fraction: number = 0): Time {
	const [a, b] = normalize(epoch, 0.0, unit)
	day += a
	fraction += b

	let extra = Math.round(fraction)
	day += extra
	fraction -= extra

	return [day, fraction]
}

export function timeUnix(seconds: number) {
	return timeFromEpoch(seconds, DAYSEC, 2440588.0, -0.5)
}

export function timeNow() {
	return timeUnix(Date.now() / 1000)
}

export function timeMJD(mjd: number) {
	return time(mjd + MJD0)
}

// Returns the sum of [day] and [fraction] as two 64-bit floats,
// with the latter guaranteed to be within -0.5 and 0.5 (inclusive on
// either side, as the integer is rounded to even).
// The arithmetic is all done with exact floating point operations so no
// precision is lost to rounding error. It is assumed the sum is less
// than about 1E16, otherwise the remainder will be greater than 1.0.
export function normalize(day: number, fraction: number, divisor: number = 0): [number, number] {
	let [sum, err] = twoSum(day, fraction)
	day = Math.round(sum)
	let [extra, frac] = twoSum(sum, -day)
	frac += extra + err

	if (divisor != 0 && isFinite(divisor)) {
		const q = sum / divisor
		const [a, b] = twoProduct(q, divisor)
		const [c, d] = twoSum(sum, -a)
		;[sum, err] = twoSum(q, (c + (d + err - b)) / divisor)
	}

	// Our fraction can now have gotten >0.5 or <-0.5, which means we would
	// loose one bit of precision. So, correct for that.
	day += Math.round(frac)
	;[extra, frac] = twoSum(sum, -day)
	frac += extra + err

	return [day, frac]
}
