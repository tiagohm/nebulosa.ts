import { type Angle, normalizeAngle, secondsOfTime, toDeg } from './angle'
import { ASEC2RAD, AU_KM, DEG2RAD, PI, PIOVERTWO, TAU } from './constants'
import type { Distance } from './distance'
import { floorDiv, modf, type NumberArray, pmod } from './math'

const { sin, cos, tan, asin, acos, atan, atan2, sqrt, hypot, log10, abs, trunc, floor, min } = Math

// https://github.com/commenthol/astronomia/blob/master/src/

export type Coord = readonly [Angle, Angle]

export const EARTH_RADIUS_KM = 6378.137 // km
export const EARTH_RADIUS = EARTH_RADIUS_KM / AU_KM // au

export const MOON_RADIUS_KM = 1738.1 // km
export const MOON_RADIUS = MOON_RADIUS_KM / AU_KM // au

// Functions and other definitions useful with multiple packages.
export namespace Base {
	// K is the Gaussian gravitational constant.
	export const K = 0.01720209895
	// Julian days of Julian epoch 1900
	export const J1900 = 2415020
	// Julian days of Besselian epoch 1900
	export const B1900 = 2415020.3135
	// Julian days of Besselian epoch 1950
	export const B1950 = 2433282.4235
	// J2000 is the Julian date corresponding to January 1.5, year 2000.
	export const J2000 = 2451545
	// JMod is the Julian date of the modified Julian date epoch.
	export const JMOD = 2400000.5
	// JulianYear in days
	export const JULIAN_YEAR = 365.25 // days
	// JulianCentury in days
	export const JULIAN_CENTURY = 36525 // days
	// BesselianYear in days; equals mean tropical year
	export const BESSELIAN_YEAR = 365.2421988 // days
	// Mean sidereal year
	export const MEAN_SIDEREAL_YEAR = 365.25636 // days

	// Small angle
	export const SMALL_ANGLE = (10 * PI) / 180 / 60 // about .003 radians
	// cosine of small angle
	export const COS_SMALL_ANGLE = 0.99999999871122538308915878430616

	// Sine obliquity at J2000.
	export const SIN_OBL_J2000 = 0.397777156
	// Cosine obliquity at J2000.
	export const COS_OBL_J2000 = 0.917482062

	export function lightTime(dist: Distance) {
		// Formula given as (33.3) p. 224.
		return 0.0057755183 * dist
	}

	// Computes the illuminated fraction of a body's disk.
	export function illuminated(i: Angle) {
		// (41.1) p. 283, also (48.1) p. 345.
		return (1 + cos(i)) * 0.5
	}

	// Computes position angle of the midpoint of an illuminated limb.
	export function limb(bra: Angle, bdec: Angle, sra: Angle, sdec: Angle): Angle {
		// Mentioned in ch 41, p. 283. Formula (48.5) p. 346
		const sδ = sin(bdec)
		const cδ = cos(bdec)
		const sδ0 = sin(sdec)
		const cδ0 = cos(sdec)
		const sa0a = sin(sra - bra)
		const ca0a = cos(sra - bra)
		const x = atan2(cδ0 * sa0a, sδ0 * cδ - cδ0 * sδ * ca0a)
		return x >= 0 ? x : x + TAU
	}

	// Evaluates a polynomial with coefficients c at x. The constant term is c[0].
	export function horner(x: number, c: Readonly<NumberArray>) {
		let i = c.length - 1
		let y = c[i]
		while (i-- > 0) y = y * x + c[i]
		return y
	}

	// Computes sine and cosine.
	export function sincos(epsilon: Angle) {
		return [sin(epsilon), cos(epsilon)]
	}

	// Computes sine² and cosine².
	export function sincos2(epsilon: Angle) {
		const s = sin(epsilon)
		const c = cos(epsilon)
		return [s * s, c * c]
	}

	// Computes the Julian ephemeris day for a Julian year.
	export function julianYearToJDE(year: number) {
		return J2000 + JULIAN_YEAR * (year - 2000)
	}

	// Computes Julian year for a Julian ephemeris day.
	export function jdeToJulianYear(jde: number) {
		return 2000 + (jde - J2000) / JULIAN_YEAR
	}

	// Computes the Julian ephemeris day for a Besselian year.
	export function besselianYearToJDE(year: number) {
		return B1900 + BESSELIAN_YEAR * (year - 1900)
	}

	// Computes the Besselian year for a Julian ephemeris day.
	export function jdeToBesselianYear(jde: number) {
		return 1900 + (jde - B1900) / BESSELIAN_YEAR
	}

	// Computes the number of Julian centuries since J2000.
	export function j2000Century(jde: number) {
		// The formula is given in a number of places in the book, for example
		// (12.1) p. 87.
		// (22.1) p. 143.
		// (25.1) p. 163.
		return (jde - J2000) / JULIAN_CENTURY
	}
}

// Chapter 3, Interpolation.
export namespace Interpolation {
	// Len3 allows second difference interpolation.
	export class Len3 {
		private readonly a: number
		private readonly b: number
		private readonly c: number
		private readonly abSum: number
		private readonly xSum: number
		private readonly xDiff: number

		constructor(
			readonly x1: number,
			readonly x3: number,
			readonly y: Readonly<NumberArray>,
		) {
			if (y.length < 3) throw new Error('y must be length 3')
			if (x3 === x1) throw new Error('x3 (or x5) cannot equal x1')

			// Differences. (3.1) p. 23
			this.a = y[1] - y[0]
			this.b = y[2] - y[1]
			this.c = this.b - this.a
			// Other intermediate values
			this.abSum = this.a + this.b
			this.xSum = x3 + x1
			this.xDiff = x3 - x1
		}

		// InterpolateX interpolates for a given x value.
		interpolateX(x: number) {
			const n = (2 * x - this.xSum) / this.xDiff
			return this.interpolateN(n)
		}

		// Interpolates for a given x value, restricting x to the range x1 to x3.
		interpolateXStrict(x: number) {
			const n = (2 * x - this.xSum) / this.xDiff
			const y = this.interpolateNStrict(n)
			return y
		}

		// Interpolates for a given interpolating factor n.
		interpolateN(n: number) {
			return this.y[1] + n * 0.5 * (this.abSum + n * this.c)
		}

		// Interpolates for a given interpolating factor n.
		interpolateNStrict(n: number) {
			if (n < -1 || n > 1) throw new Error('interpolating factor n must be in range -1 to 1')
			return this.interpolateN(n)
		}

		// Computes the x and y values at the extremum.
		extremum() {
			if (this.c === 0) throw new Error('no extremum in table')
			const n = this.abSum / (-2 * this.c) // (3.5), p. 25
			if (n < -1 || n > 1) throw new Error('extremum falls outside of table')
			const x = 0.5 * (this.xSum + this.xDiff * n)
			const y = this.y[1] - (this.abSum * this.abSum) / (8 * this.c) // (3.4), p. 25
			return [x, y]
		}

		// Find a zero of the quadratic function represented by the table. That is, it returns an x value that yields y=0.
		zero(strong: boolean) {
			let f: (n0: number) => number

			if (strong) {
				// (3.7), p. 27
				f = (n0) => n0 - (2 * this.y[1] + n0 * (this.abSum + this.c * n0)) / (this.abSum + 2 * this.c * n0)
			} else {
				// (3.6), p. 26
				f = (n0) => (-2 * this.y[1]) / (this.abSum + this.c * n0)
			}

			const [n0, ok] = iterate(0, f)

			if (!ok) throw new Error('failure to converge')
			if (n0 > 1 || n0 < -1) throw new Error('zero falls outside of table')

			return 0.5 * (this.xSum + this.xDiff * n0)
		}
	}

	export function iterate(n0: number, f: (n0: number) => number) {
		for (let limit = 0; limit < 50; limit++) {
			const n1 = f(n0)

			if (!Number.isFinite(n1) || Number.isNaN(n1)) break
			if (abs((n1 - n0) / n0) < 1e-15) return [n1, true] as const

			n0 = n1
		}

		return [0, false] as const
	}

	// Interpolates a center value from a table of four rows.
	export function len4Half(y: NumberArray) {
		if (y.length < 4) throw new Error('y must be length 4')

		// (3.12) p. 32
		return (9 * (y[1] + y[2]) - y[0] - y[3]) / 16
	}

	// Len5 allows fourth Difference interpolation.
	export class Len5 {
		private readonly y3: number
		private readonly a: number
		private readonly b: number
		private readonly c: number
		private readonly d: number
		private readonly e: number
		private readonly f: number
		private readonly g: number
		private readonly h: number
		private readonly j: number
		private readonly k: number
		private readonly xSum: number
		private readonly xDiff: number
		private readonly interpCoeff: NumberArray

		constructor(
			readonly x1: number,
			readonly x5: number,
			readonly y: Readonly<NumberArray>,
		) {
			if (y.length < 5) throw new Error('y must be length 5')
			if (x5 === x1) throw new Error('x5 cannot equal x1')

			this.y3 = y[2]

			// differences
			this.a = y[1] - y[0]
			this.b = y[2] - y[1]
			this.c = y[3] - y[2]
			this.d = y[4] - y[3]

			this.e = this.b - this.a
			this.f = this.c - this.b
			this.g = this.d - this.c

			this.h = this.f - this.e
			this.j = this.g - this.f

			this.k = this.j - this.h

			// other intermediate values
			this.xSum = x5 + x1
			this.xDiff = x5 - x1

			this.interpCoeff = [
				// (3.8) p. 28
				this.y3,
				(this.b + this.c) / 2 - (this.h + this.j) / 12,
				this.f / 2 - this.k / 24,
				(this.h + this.j) / 12,
				this.k / 24,
			]
		}

		// Interpolates for a given x value.
		interpolateX(x: number) {
			const n = (4 * x - 2 * this.xSum) / this.xDiff
			return this.interpolateN(n)
		}

		// Interpolates for a given x value, restricting x to the range x1 to x5 given to the the constructor NewLen5.
		interpolateXStrict(x: number) {
			const n = (4 * x - 2 * this.xSum) / this.xDiff
			return this.interpolateNStrict(n)
		}

		// Interpolates for a given interpolating factor n.
		interpolateN(n: number) {
			return Base.horner(n, this.interpCoeff)
		}

		// Interpolates for a given interpolating factor n.
		interpolateNStrict(n: number) {
			if (n < -1 || n > 1) throw new Error('interpolating factor n must be in range -1 to 1')
			return Base.horner(n, this.interpCoeff)
		}

		// Computes the x and y values at the extremum.
		extremum() {
			// (3.9) p. 29
			const nCoeff = [6 * (this.b + this.c) - this.h - this.j, 0, 3 * (this.h + this.j), 2 * this.k]
			const den = this.k - 12 * this.f
			if (den === 0) throw new Error('extremum falls outside of table')

			const [n0, ok] = iterate(0, (n0) => Base.horner(n0, nCoeff) / den)
			if (!ok) throw new Error('failure to converge')
			if (n0 < -2 || n0 > 2) throw new Error('extremum falls outside of table')

			const x = 0.5 * this.xSum + 0.25 * this.xDiff * n0
			const y = Base.horner(n0, this.interpCoeff)

			return [x, y] as const
		}

		// Finds a zero of the quartic function represented by the table. That is, it returns an x value that yields y=0.
		zero(strong: boolean) {
			let f: (n0: number) => number

			if (strong) {
				// (3.11), p. 29
				const M = this.k / 24
				const N = (this.h + this.j) / 12
				const P = this.f / 2 - M
				const Q = (this.b + this.c) / 2 - N
				const numCoeff = [this.y3, Q, P, N, M]
				const denCoeff = [Q, 2 * P, 3 * N, 4 * M]
				f = (n0) => n0 - Base.horner(n0, numCoeff) / Base.horner(n0, denCoeff)
			} else {
				// (3.10), p. 29
				const numCoeff = [-24 * this.y3, 0, this.k - 12 * this.f, -2 * (this.h + this.j), -this.k]
				const den = 12 * (this.b + this.c) - 2 * (this.h + this.j)
				f = (n0) => Base.horner(n0, numCoeff) / den
			}

			const [n0, ok] = iterate(0, f)

			if (!ok) throw new Error('failure to converge')
			if (n0 > 2 || n0 < -2) throw new Error('zero falls outside of table')

			return 0.5 * this.xSum + 0.25 * this.xDiff * n0
		}
	}

	export function len3ForInterpolateX(x: number, x1: number, xN: number, y: Readonly<NumberArray>) {
		if (y.length > 3) {
			const interval = (xN - x1) / (y.length - 1)

			if (interval === 0) throw new Error('xN cannot equal x1')

			let nearestX = trunc((x - x1) / interval + 0.5)

			if (nearestX < 1) {
				nearestX = 1
			} else if (nearestX > y.length - 2) {
				nearestX = y.length - 2
			}

			y = y.slice(nearestX - 1, nearestX + 2)
			xN = x1 + (nearestX + 1) * interval
			x1 = x1 + (nearestX - 1) * interval
		}

		return new Len3(x1, xN, y)
	}

	// Performs interpolation with unequally-spaced abscissae in table [[x0, y0], ... [xN, yN]] of x, y values
	export function lagrange(x: number, table: readonly Readonly<NumberArray>[]) {
		// method of BASIC program, p. 33.0
		const n = table.length
		let sum = 0

		for (let i = 0; i < n; i++) {
			const ti = table[i]
			const xi = ti[0]
			let prod = 1

			for (let j = 0; j < n; j++) {
				if (i !== j) {
					const xj = table[j][0]
					prod *= (x - xj) / (xi - xj)
				}
			}

			sum += ti[1] * prod
		}

		return sum
	}

	// Uses the formula of Lagrange to produce an interpolating polynomial.
	export function lagrangePoly(table: readonly Readonly<NumberArray>[]) {
		// Method not fully described by Meeus, but needed for numerical solution to Example 3.g.
		const sum = new Float64Array(table.length)
		const prod = new Float64Array(table.length)
		const last = table.length - 1

		for (let i = 0; i < table.length; i++) {
			const xi = table[i][0]
			const yi = table[i][1]

			prod[last] = 1

			let den = 1
			let n = last

			for (let j = 0; j < table.length; j++) {
				if (i !== j) {
					const xj = table[j][0]
					prod[n - 1] = prod[n] * -xj

					for (let k = n; k < last; k++) {
						prod[k] -= prod[k + 1] * xj
					}

					n--

					den *= xi - xj
				}
			}

			for (let j = 0; j < prod.length; j++) {
				sum[j] += (yi * prod[j]) / den
			}
		}

		return sum
	}

	// Computes Linear Interpolation of x
	export function linear(x: number, x1: number, xN: number, y: Readonly<NumberArray>) {
		const interval = (xN - x1) / (y.length - 1)
		if (interval === 0) throw new Error('xN cannot equal x1')

		let nearestX = floor((x - x1) / interval)

		if (nearestX < 0) {
			nearestX = 0
		} else if (nearestX > y.length - 2) {
			nearestX = y.length - 2
		}

		const y2 = y.slice(nearestX, nearestX + 2)
		const x01 = x1 + nearestX * interval
		return y2[0] + ((y[1] - y[0]) * (x - x01)) / interval
	}
}

// Chapter 4, Curve Fitting.
export namespace Fit {
	// Fits y = ax + b to sample data.
	export function linear(x: Readonly<NumberArray>, y: Readonly<NumberArray>) {
		const n = min(x.length, y.length)

		let sx = 0
		let sy = 0
		let sx2 = 0
		let sxy = 0

		for (let i = 0; i < n; i++) {
			const xi = x[i]
			const yi = y[i]
			sx += xi
			sy += yi
			sx2 += xi * xi
			sxy += xi * yi
		}

		// (4.2) p. 36
		const d = n * sx2 - sx * sx
		const a = (n * sxy - sx * sy) / d
		const b = (sy * sx2 - sx * sxy) / d
		return [a, b] as const
	}

	// Computes the correlation coefficient for sample data.
	export function correlationCoefficient(x: Readonly<NumberArray>, y: Readonly<NumberArray>) {
		const n = min(x.length, y.length)

		let sx = 0
		let sy = 0
		let sx2 = 0
		let sy2 = 0
		let sxy = 0

		for (let i = 0; i < n; i++) {
			const xi = x[i]
			const yi = y[i]
			sx += xi
			sy += yi
			sx2 += xi * xi
			sy2 += yi * yi
			sxy += xi * yi
		}

		// (4.3) p. 38
		return (n * sxy - sx * sy) / (sqrt(n * sx2 - sx * sx) * sqrt(n * sy2 - sy * sy))
	}

	// Fits y = ax² + bx + c to sample data.
	export function quadratic(x: Readonly<NumberArray>, y: Readonly<NumberArray>) {
		const N = min(x.length, y.length)

		let P = 0
		let Q = 0
		let R = 0
		let S = 0
		let T = 0
		let U = 0
		let V = 0

		for (let i = 0; i < N; i++) {
			const xi = x[i]
			const yi = y[i]
			const x2 = xi * xi
			P += xi
			Q += x2
			R += xi * x2
			S += x2 * x2
			T += yi
			U += xi * yi
			V += x2 * yi
		}

		// (4.5) p. 43
		const D = N * Q * S + 2 * P * Q * R - Q * Q * Q - P * P * S - N * R * R
		// (4.6) p. 43
		const a = (N * Q * V + P * R * T + P * Q * U - Q * Q * T - P * P * V - N * R * U) / D
		const b = (N * S * U + P * Q * V + Q * R * T - Q * Q * U - P * S * T - N * R * V) / D
		const c = (Q * S * T + Q * R * U + P * R * V - Q * Q * V - P * S * U - R * R * T) / D
		return [a, b, c] as const
	}

	// Fits y = aƒ0(x) + bƒ1(x) + cƒ2(x) to a sample data.
	export function func3(x: Readonly<NumberArray>, y: Readonly<NumberArray>, f0: (a: number) => number, f1: (a: number) => number, f2: (a: number) => number) {
		const N = min(x.length, y.length)

		let M = 0
		let P = 0
		let Q = 0
		let R = 0
		let S = 0
		let T = 0
		let U = 0
		let V = 0
		let W = 0

		for (let i = 0; i < N; i++) {
			const xi = x[i]
			const yi = y[i]
			const y0 = f0(xi)
			const y1 = f1(xi)
			const y2 = f2(xi)
			M += y0 * y0
			P += y0 * y1
			Q += y0 * y2
			R += y1 * y1
			S += y1 * y2
			T += y2 * y2
			U += yi * y0
			V += yi * y1
			W += yi * y2
		}

		// (4.7) p. 44
		const D = M * R * T + 2 * P * Q * S - M * S * S - R * Q * Q - T * P * P
		const a = (U * (R * T - S * S) + V * (Q * S - P * T) + W * (P * S - Q * R)) / D
		const b = (U * (S * Q - P * T) + V * (M * T - Q * Q) + W * (P * Q - M * S)) / D
		const c = (U * (P * S - R * Q) + V * (P * Q - M * S) + W * (M * R - P * P)) / D
		return [a, b, c] as const
	}

	// Fits y = aƒ(x) to sample data.
	export function func1(x: Readonly<NumberArray>, y: Readonly<NumberArray>, f: (a: number) => number) {
		const n = min(x.length, y.length)

		let syf = 0
		let sf2 = 0

		// (4.8) p. 45
		for (let i = 0; i < n; i++) {
			const fx = f(x[i])
			syf += y[i] * fx
			sf2 += fx * fx
		}

		return syf / sf2
	}
}

// Chapter 5, Iteration.
export namespace Iteration {
	// Iterates to a fixed number of decimal places.
	export function decimalPlaces(better: (num: number) => number, start: number, places: number, maxIterations: number) {
		const d = 10 ** -places

		for (let i = 0; i < maxIterations; i++) {
			const n = better(start)
			if (abs(n - start) < d) return n
			start = n
		}

		throw new Error('maximum iterations reached')
	}

	// Iterates to (nearly) the full precision of a float64.
	export function fullPrecision(better: (num: number) => number, start: number, maxIterations: number) {
		for (let i = 0; i < maxIterations; i++) {
			const n = better(start)
			if (abs((n - start) / n) < 1e-15) return n
			start = n
		}

		throw new Error('maximum iterations reached')
	}

	// Finds a root between given bounds by binary search.
	export function binaryRoot(f: (num: number) => number, lower: number, upper: number) {
		let yLower = f(lower)
		let mid = 0

		for (let j = 0; j < 52; j++) {
			mid = (lower + upper) / 2
			const yMid = f(mid)

			if (yMid === 0) break

			if (yLower < 0 === yMid < 0) {
				lower = mid
				yLower = yMid
			} else {
				upper = mid
			}
		}

		return mid
	}
}

// Chapter 7, Julian day.
export namespace Julian {
	// 1582-10-05 Julian Date is 1st Gregorian Date (1582-10-15)
	export const GREGORIAN0JD = 2299160.5

	const DAYS_OF_YEAR = [0, 0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334]

	// Converts a Gregorian year, month, and day of month to Julian day.
	// Negative years are valid, back to JD 0. The result is not valid for dates before JD 0.
	export function calendarGregorianToJD(y: number, m: number, d: number) {
		return calendarToJD(y, m, d, false)
	}

	// Converts a Julian year, month, and day of month to Julian day.
	// Negative years are valid, back to JD 0. The result is not valid for dates before JD 0.
	export function calendarJulianToJD(y: number, m: number, d: number) {
		return calendarToJD(y, m, d, true)
	}

	// Converts from calendar date to julian day
	export function calendarToJD(y: number, m: number, d: number, isJulian: boolean) {
		let b = 0

		if (m < 3) {
			y--
			m += 12
		}

		if (!isJulian) {
			const a = floorDiv(y, 100)
			b = 2 - a + floorDiv(a, 4)
		}

		// (7.1) p. 61
		return floorDiv(36525 * trunc(y + 4716), 100) + (floorDiv(306 * (m + 1), 10) + b) + d - 1524.5
	}

	// Returns the calendar date for the given jd.
	export function jdToCalendar(jd: number, isJulian: boolean = false) {
		const [z, f] = modf(jd + 0.5)
		let a = z

		if (!isJulian) {
			const alpha = floorDiv(z * 100 - 186721625, 3652425)
			a = z + 1 + alpha - floorDiv(alpha, 4)
		}

		const b = a + 1524
		const c = floorDiv(b * 100 - 12210, 36525)
		const d = floorDiv(36525 * c, 100)
		const e = trunc(floorDiv((b - d) * 1e4, 306001))

		const day = trunc(b - d) - floorDiv(306001 * e, 1e4) + f
		const month = e === 14 || e === 15 ? e - 13 : e - 1
		const year = month < 3 ? trunc(c) - 4715 : trunc(c) - 4716

		return [year, month, day] as const
	}

	// Returns the calendar date for the given jd in the Gregorian Calendar.
	export function jdToCalendarGregorian(jd: number) {
		return jdToCalendar(jd, false)
	}

	// Returns the calendar date for the given jd in the Julian Calendar.
	export function jdToCalendarJulian(jd: number) {
		return jdToCalendar(jd, true)
	}

	// Returns true if year y in the Julian calendar is a leap year.
	export function isLeapYearJulian(y: number) {
		return y % 4 === 0
	}

	// Returns true if year y in the Gregorian calendar is a leap year.
	export function isLeapYearGregorian(y: number) {
		return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0
	}

	// Checks if Julian day `jd` falls into the Gregorian calendar
	export function isJDCalendarGregorian(jd: number) {
		return jd >= GREGORIAN0JD
	}

	// Checks if date falls into the Gregorian calendar
	export function isCalendarGregorian(year: number, month: number = 1, day: number = 1) {
		return year > 1582 || (year === 1582 && month > 10) || (year === 1582 && month === 10 && day >= 15)
	}

	// Converts Modified Julian Day to Julian Day.
	export function mjdToJD(mjd: number) {
		return mjd + Base.JMOD
	}

	// Converts Julian Day to Modified Julian Day
	// The MJD sometimes appear when mentioning orbital elements of artificial satellites.
	// Contrary to JD the MJD begins at Greenwich mean midnight.
	export function jdToMJD(jd: number) {
		return jd - Base.JMOD
	}

	// Determines the day of the week for a given JD.
	// The value returned is an integer in the range 0 to 6, where 0 represents Sunday.
	export function dayOfWeek(jd: number) {
		return trunc(jd + 1.5) % 7
	}

	// Computes the day number within the year of the Gregorian calendar.
	export function dayOfYearGregorian(y: number, m: number, d: number) {
		return dayOfYear(y, m, trunc(d), isLeapYearGregorian(y))
	}

	// Computes the day number within the year of the Julian calendar.
	export function dayOfYearJulian(y: number, m: number, d: number) {
		return dayOfYear(y, m, trunc(d), isLeapYearJulian(y))
	}

	// Computes the day number within the year.
	// This form of the function is not specific to the Julian or Gregorian
	// calendar, but you must tell it whether the year is a leap year.
	export function dayOfYear(y: number, m: number, d: number, leap: boolean) {
		let k = 0
		if (leap && m > 1) k = 1
		return k + DAYS_OF_YEAR[m] + trunc(d)
	}

	// Computes the calendar month and day for a given day of year and leap year status.
	export function dayOfYearToCalendar(n: number, leap: boolean) {
		let month = 0
		let k = 0

		if (leap) {
			k = 1
		}

		for (month = 1; month <= 12; month++) {
			if (k + DAYS_OF_YEAR[month] > n) {
				month = month - 1
				break
			}
		}

		const day = n - k - DAYS_OF_YEAR[month]
		return { month, day }
	}
}

// Chapter 11, The Earth's Globe.
export namespace Globe {
	// Represents an ellipsoid of revolution.
	export class Ellipsoid {
		readonly #radius: Distance
		readonly #flat: number

		constructor(radius: Distance, flat: number) {
			this.#radius = radius
			this.#flat = flat
		}

		get A() {
			return this.#radius
		}

		// Returns the polar radius.
		get B() {
			return this.#radius * (1 - this.#flat)
		}

		// Returns the eccentricity of a meridian.
		get eccentricity() {
			return sqrt((2 - this.#flat) * this.#flat)
		}

		// Computes parallax constants rho sin phi' and rho cos phi' given latitude and height above the ellipsoid.
		parallaxConstants(phi: Angle, h: Distance) {
			const boa = 1 - this.#flat
			const u = atan(boa * tan(phi))
			const su = sin(u)
			const cu = cos(u)
			const sp = sin(phi)
			const cp = cos(phi)
			const hoa = (h * 0.001) / this.#radius
			const rhosPhi = su * boa + hoa * sp
			const rhocPhi = cu + hoa * cp
			return [rhosPhi, rhocPhi] as const
		}

		// Computes rho, the distance (in unit is fraction of the equatorial radius) from Earth center to a point on the ellipsoid.
		rho(phi: Angle) {
			// Magic numbers...
			return 0.9983271 + 0.0016764 * cos(2 * phi) - 0.0000035 * cos(4 * phi)
		}

		// Computes the the radius of the circle that is the parallel of latitude at phi.
		radiusAtLatitude(phi: Angle): Distance {
			const s = sin(phi)
			const c = cos(phi)
			return (this.#radius * c) / sqrt(1 - (2 - this.#flat) * this.#flat * s * s)
		}

		// Computes the radius of meridian at latitude phi.
		radiusOfCurvature(phi: Angle): Distance {
			const s = sin(phi)
			const e2 = (2 - this.#flat) * this.#flat
			return (this.#radius * (1 - e2)) / (1 - e2 * s * s) ** 1.5
		}

		// Computes the distance between two points measured along the surface of an ellipsoid.
		// Accuracy is much better than that of approxAngularDistance or approxLinearDistance.
		distance(lon1: Angle, lat1: Angle, lon2: Angle, lat2: Angle): Distance {
			// From AA, ch 11, p 84.
			const [s2f, c2f] = Base.sincos2((lat1 + lat2) / 2)
			const [s2g, c2g] = Base.sincos2((lat1 - lat2) / 2)
			const [s2Lambda, c2Lambda] = Base.sincos2((lon1 - lon2) / 2)
			const s = s2g * c2Lambda + c2f * s2Lambda
			const c = c2g * c2Lambda + s2f * s2Lambda
			const omega = atan(sqrt(s / c))
			const r = sqrt(s * c) / omega
			const d = 2 * omega * this.#radius
			const h1 = (3 * r - 1) / (2 * c)
			const h2 = (3 * r + 1) / (2 * s)
			return d * (1 + this.#flat * (h1 * s2f * c2g - h2 * c2f * s2g))
		}
	}

	// IAU 1976.
	export const EARTH76 = new Ellipsoid(6.37814 / AU_KM, 1 / 298.257)

	// RotationRate1996_5 is the rotational angular velocity of the Earth
	// with respect to the stars at the epoch 1996.5.
	export const ROTATION_RATE_1996_5 = 7.292114992e-5 // rad/s

	// Computes the length of one degree of longitude.
	export function oneDegreeOfLongitude(rp: Distance): Distance {
		return rp * DEG2RAD
	}

	// Computes the length of one degree of latitude.
	export function oneDegreeOfLatitude(rm: Distance): Distance {
		return rm * DEG2RAD
	}

	// Computes geographic latitude - geocentric latitude (phi - phi') with given geographic latitude (phi).
	export function geocentricLatitudeDifference(phi: Angle): Angle {
		// This appears to be an approximation with hard coded magic numbers.
		// No explanation is given in the text. The ellipsoid is not specified.
		// Perhaps the approximation works well enough for all ellipsoids?
		return ((692.73 * sin(2 * phi) - 1.16 * sin(4 * phi)) * PI) / (180 * 3600)
	}

	// Computes the cosine of the angle between two points.
	// The accuracy deteriorates at small angles.
	// Use d = acos(cos) to obtain geocentric angular distance in radians.
	export function approxAngularDistance(lon1: Angle, lat1: Angle, lon2: Angle, lat2: Angle) {
		return sin(lat1) * sin(lat2) + cos(lat1) * cos(lat2) * cos(lon1 - lon2)
	}

	// Computes a distance across the surface of the Earth.
	// Approximating the Earth as a sphere, the function takes a geocentric angular
	// distance in radians and returns the corresponding linear distance.
	export function approxLinearDistance(d: Angle): Distance {
		return (6371 / AU_KM) * d
	}
}

// Chapter 12, Sidereal Time at Greenwich.
export namespace Sidereal {
	// Returns values for use in computing sidereal time at Greenwich.
	// Cen is centuries from J2000 of the JD at 0h UT of argument jd. This is
	// the value to use for evaluating the IAU sidereal time polynomial.
	// DayFrac is the fraction of jd after 0h UT. It is used to compute the
	// final value of sidereal time.
	export function jdToCFrac(jd: number) {
		const j0f = modf(jd + 0.5)
		return [Base.j2000Century(j0f[0] - 0.5), j0f[1]] as const
	}

	// Polynomial giving mean sidereal time at Greenwich at 0h UT.
	// The polynomial is in centuries from J2000.0, as given by JDToCFrac.
	// Coefficients are those adopted in 1982 by the International Astronomical
	// Union and are given in (12.2) p. 87.
	export const IAU82 = [24110.54841, 8640184.812866, 0.093104, -0.0000062] as const

	// Computes the mean sidereal time (in seconds of time) at Greenwich for a given JD.
	// Computation is by IAU 1982 coefficients.
	export function mean(jd: number) {
		return pmod(_mean(jd), 86400)
	}

	function _mean(jd: number) {
		const sf = _mean0UT(jd)
		return sf[0] + sf[1] * 1.00273790935 * 86400
	}

	// Computes mean sidereal time (in seconds of time) at Greenwich at 0h UT on the given JD.
	export function mean0UT(jd: number) {
		const s = _mean0UT(jd)
		return pmod(s[0], 86400)
	}

	function _mean0UT(jd: number) {
		const cf = jdToCFrac(jd)
		// (12.2) p. 87
		return [Base.horner(cf[0], IAU82), cf[1]] as const
	}

	// Computes the apparent sidereal time (in seconds of time) at Greenwich for the given JD.
	// Apparent is mean plus the nutation in right ascension.
	export function apparent(jd: number) {
		const s = _mean(jd) // seconds of time
		const n = Nutation.nutationInRA(jd) // angle (radians) of RA
		const ns = (n * 3600 * 180) / PI / 15 // convert RA to time in seconds
		return pmod(s + ns, 86400)
	}

	// Computes the apparent sidereal time (in seconds of time) at Greenwich at 0h UT on the given JD.
	export function apparent0UT(jd: number) {
		const [j0, f] = modf(jd + 0.5)
		const cen = (j0 - 0.5 - Base.J2000) / 36525
		const s = Base.horner(cen, IAU82) + f * 1.00273790935 * 86400
		const n = Nutation.nutationInRA(j0) // angle (radians) of RA
		const ns = (n * 3600 * 180) / PI / 15 // convert RA to time in seconds
		return pmod(s + ns, 86400)
	}
}

// Chapter 13, Transformation of Coordinates.
export namespace Coords {
	// Converts ecliptic coordinates to equatorial coordinates given ecliptic obliquity.
	// IMPORTANT: Longitudes are measured *positively* westwards, e.g. Washington D.C. +77°04; Vienna -16°23'.
	export function eclipticToEquatorial(longitude: Angle, latitude: Angle, epsilon: Angle) {
		const [epsilonsin, epsiloncos] = Base.sincos(epsilon)
		const [sBeta, cBeta] = Base.sincos(latitude)
		const [sLambda, cLambda] = Base.sincos(longitude)
		const ra = atan2(sLambda * epsiloncos - (sBeta / cBeta) * epsilonsin, cLambda) // (13.3) p. 93
		const dec = asin(sBeta * epsiloncos + cBeta * epsilonsin * sLambda) // (13.4) p. 93
		return [normalizeAngle(ra), dec] as const
	}

	// Converts equatorial coordinates to ecliptic coordinates given ecliptic obliquity.
	export function equatorialToEcliptic(rightAscension: Angle, declination: Angle, epsilon: Angle) {
		const [epsilonsin, epsiloncos] = Base.sincos(epsilon)
		const [sAlpha, cAlpha] = Base.sincos(rightAscension)
		const [sDelta, cDelta] = Base.sincos(declination)
		const lon = atan2(sAlpha * epsiloncos + (sDelta / cDelta) * epsilonsin, cAlpha) // (13.1) p. 93
		const lat = asin(sDelta * epsiloncos - cDelta * epsilonsin * sAlpha) // (13.2) p. 93
		return [lon, lat] as const
	}

	// Computes Horizontal coordinates from equatorial coordinates given is the location of the observer on the Earth and the sidereal time at Greenwich.
	// Sidereal time must be consistent with the equatorial coordinates. If coordinates are apparent, sidereal time must be apparent as well.
	export function equatorialToHorizontal(rightAscension: Angle, declination: Angle, longitude: Angle, latitude: Angle, st: number) {
		const H = secondsOfTime(st) - longitude - rightAscension
		const [sH, cH] = Base.sincos(H)
		const [sPhi, cPhi] = Base.sincos(latitude)
		const [sDelta, cDelta] = Base.sincos(declination)
		const azimuth = atan2(sH, cH * sPhi - (sDelta / cDelta) * cPhi) // (13.5) p. 93
		const altitude = asin(sPhi * sDelta + cPhi * cDelta * cH) // (13.6) p. 93
		return [azimuth, altitude] as const
	}

	// Converts equatorial coordinates to galactic coordinates.
	// Equatorial coordinates must be referred to the standard equinox of B1950.0.
	// For conversion to B1950, see package precess and utility functions in packkage "common".
	export function equatorialToGalactic(rightAscension: Angle, declination: Angle) {
		const [sdAlpha, cdAlpha] = Base.sincos(GALACTIC_NORTH_RA - rightAscension)
		const [sgDelta, cgDelta] = Base.sincos(GALACTIC_NORTH_DEC)
		const [sDelta, cDelta] = Base.sincos(declination)
		const x = atan2(sdAlpha, cdAlpha * sgDelta - (sDelta / cDelta) * cgDelta) // (13.7) p. 94
		// (galactic0Lon1950 + 1.5 * PI) = magic number of 303 deg
		const lon = (GALACTIC_LON_0 + 1.5 * PI - x) % TAU // (13.8) p. 94
		const lat = asin(sDelta * sgDelta + cDelta * cgDelta * cdAlpha)
		return [lon, lat] as const
	}

	// Converts horizontal coordinates to equatorial coordinates.
	// Sidereal time must be consistent with the equatorial coordinates.
	// If coordinates are apparent, sidereal time must be apparent as well.
	export function horizontalToEquatorial(azimuth: Angle, altitude: Angle, longitude: Angle, latitude: Angle, st: number) {
		const [sA, cA] = Base.sincos(azimuth)
		const [sh, ch] = Base.sincos(altitude)
		const [sPhi, cPhi] = Base.sincos(latitude)
		const H = atan2(sA, cA * sPhi + (sh / ch) * cPhi)
		const ra = normalizeAngle(secondsOfTime(st) - longitude - H)
		const dec = asin(sPhi * sh - cPhi * ch * cA)
		return [ra, dec] as const
	}

	// Converts galactic coordinates to equatorial coordinates.
	// Resulting equatorial coordinates will be referred to the standard equinox of
	// B1950.0. For subsequent conversion to other epochs, see package precess and
	// utility functions in package meeus.
	export function galacticToEquatorial(longitude: Angle, latitude: Angle) {
		// (-galactic0Lon1950 - Pi/2) = magic number of -123 deg
		const [sdLon, cdLon] = Base.sincos(longitude - GALACTIC_LON_0 - PIOVERTWO)
		const [sgDelta, cgDelta] = Base.sincos(GALACTIC_NORTH_DEC)
		const [sb, cb] = Base.sincos(latitude)
		const y = atan2(sdLon, cdLon * sgDelta - (sb / cb) * cgDelta)
		// (galacticNorth1950.RA - PI) = magic number of 12.25 deg
		const ra = normalizeAngle(y + GALACTIC_NORTH_RA - PI)
		const dec = asin(sb * sgDelta + cb * cgDelta * cdLon)
		return [ra, dec] as const
	}

	// Equatorial IAU B1950.0 coordinates of galactic North Pole
	export const GALACTIC_NORTH_RA = (12 + 49 / 60) * 15 * DEG2RAD // 12h49m
	export const GALACTIC_NORTH_DEC = 27.4 * DEG2RAD

	// Galactic Longitude 0°
	// Meeus gives 33 as the origin of galactic longitudes relative to the
	// ascending node of of the galactic equator. 33 + 90 = 123, the IAU
	// value for origin relative to the equatorial pole.
	export const GALACTIC_LON_0 = 33 * DEG2RAD
}

// Rise: Chapter 15, Rising, Transit, and Setting.
export namespace Rise {}

// Chapter 16: Atmospheric Refraction.
// Functions here assume atmospheric pressure of 1010 mb, temperature of 10°C, and yellow light.
export namespace Refraction {
	const GT15_T1 = 58.294 * ASEC2RAD
	const GT15_T2 = 0.0668 * ASEC2RAD
	const GT15_A1 = 58.276 * ASEC2RAD
	const GT15_A2 = 0.0824 * ASEC2RAD

	// Computes the refraction to be subtracted from h0 to obtain the true altitude when altitude is greater than 15 degrees.
	export function gt15True(h0: Angle): Angle {
		// (16.1) p. 105
		const t = tan(PIOVERTWO - h0)
		return GT15_T1 * t - GT15_T2 * t * t * t
	}

	// Computes the refraction to be added to h to obtain the apparent altitude of the body.
	export function gt15Apparent(h: Angle) {
		// (16.2) p. 105
		const t = tan(PIOVERTWO - h)
		return GT15_A1 * t - GT15_A2 * t * t * t
	}

	// Computes the refraction to be subtracted from h0 to obtain the true altitude with accurate of 0.07 arc min from horizon to zenith.
	export function bennett(h0: Angle): Angle {
		// (16.3) p. 106
		const c1 = DEG2RAD / 60
		const c731 = 7.31 * DEG2RAD * DEG2RAD
		const c44 = 4.4 * DEG2RAD
		return c1 / tan(h0 + c731 / (h0 + c44))
	}

	// Computes refraction for obtaining true altitude with accurate of 0.015 arc min.
	export function bennett2(h0: Angle): Angle {
		const cMin = 60 / DEG2RAD
		const c06 = 0.06 / cMin
		const c147 = 14.7 * cMin * DEG2RAD
		const c13 = 13 * DEG2RAD
		const R = bennett(h0)
		return R - c06 * sin(c147 * R + c13)
	}

	// Computes the refraction to be added to h (computed true "airless" altitude of a celestial body) to obtain the apparent altitude of the body.
	export function saemundsson(h: Angle): Angle {
		// (16.4) p. 106
		const c102 = (1.02 * DEG2RAD) / 60
		const c103 = 10.3 * DEG2RAD * DEG2RAD
		const c511 = 5.11 * DEG2RAD
		return c102 / tan(h + c103 / (h + c511))
	}
}

// Chapter 17: Angular Separation.
export namespace AngularSeparation {
	// Computes the angular separation between two celestial bodies.
	export function sep(c1: Coord, c2: Coord) {
		const [sind1, cosd1] = Base.sincos(c1[1])
		const [sind2, cosd2] = Base.sincos(c2[1])

		const cd = sind1 * sind2 + cosd1 * cosd2 * cos(c1[0] - c2[0]) // (17.1) p. 109

		if (cd < Base.COS_SMALL_ANGLE) {
			return acos(cd)
		} else {
			const cosd = cos((c2[1] + c1[1]) / 2) // average dec of two bodies
			return hypot((c2[0] - c1[0]) * cosd, c2[1] - c1[1]) // (17.2) p. 109
		}
	}

	// Computes the minimum separation between two moving objects.
	export function minSep(jd1: number, jd3: number, cs1: readonly [Coord, Coord, Coord], cs2: readonly [Coord, Coord, Coord], fnSep: typeof sep = sep) {
		const y = new Float64Array(3)

		for (let x = 0; x < cs1.length; x++) {
			y[x] = sep(cs1[x], cs2[x])
		}

		const d3 = new Interpolation.Len3(jd1, jd3, y)
		return d3.extremum()[1]
	}

	// Computes the minimum separation between two moving objects.
	export function minSepRect(jd1: number, jd3: number, cs1: readonly [Coord, Coord, Coord], cs2: readonly [Coord, Coord, Coord]) {
		const uv = (c1: Coord, c2: Coord) => {
			const [sind1, cosd1] = Base.sincos(c1[1])
			const deltar = c2[0] - c1[0]
			const tanDeltar = tan(deltar)
			const tanhDeltar = tan(deltar / 2)
			const K = 1 / (1 + sind1 * sind1 * tanDeltar * tanhDeltar)
			const sinDeltad = sin(c2[1] - c1[1])
			const u = -K * (1 - (sind1 / cosd1) * sinDeltad) * cosd1 * tanDeltar
			const v = K * (sinDeltad + sind1 * cosd1 * tanDeltar * tanhDeltar)
			return [u, v] as const
		}

		const us = new Float64Array(3)
		const vs = new Float64Array(3)

		for (let i = 0; i < cs1.length; i++) {
			const ret = uv(cs1[i], cs2[i])
			us[i] = ret[0]
			vs[i] = ret[1]
		}

		const u3 = new Interpolation.Len3(-1, 1, us)
		const v3 = new Interpolation.Len3(-1, 1, vs)
		const up0 = (us[2] - us[0]) / 2
		const vp0 = (vs[2] - vs[0]) / 2
		const up1 = us[0] + us[2] - 2 * us[1]
		const vp1 = vs[0] + vs[2] - 2 * vs[1]
		const up = up0
		const vp = vp0
		let dn = -(us[1] * up + vs[1] * vp) / (up * up + vp * vp)
		let n = dn
		let u = 0
		let v = 0

		for (let limit = 0; limit < 10; limit++) {
			u = u3.interpolateN(n)
			v = v3.interpolateN(n)

			if (abs(dn) < 1e-5) {
				return hypot(u, v) // success
			}

			const up = up0 + n * up1
			const vp = vp0 + n * vp1
			dn = -(u * up + v * vp) / (up * up + vp * vp)
			n += dn
		}

		throw new Error('failure to converge')
	}

	// The haversine function (17.5) p. 115
	export function hav(a: number) {
		return 0.5 * (1 - cos(a))
	}

	// Computes the angular separation between two celestial bodies.
	export function sepHav(c1: Coord, c2: Coord) {
		// using (17.5) p. 115
		return 2 * asin(sqrt(hav(c2[1] - c1[1]) + cos(c1[1]) * cos(c2[1]) * hav(c2[0] - c1[0])))
	}

	// Computes the minimum separation between two moving objects.
	export function minSepHav(jd1: number, jd3: number, cs1: readonly [Coord, Coord, Coord], cs2: readonly [Coord, Coord, Coord]) {
		return minSep(jd1, jd3, cs1, cs2, sepHav)
	}

	// Computes the numerically stable angular separation between two celestial bodies.
	export function sepPauwels(c1: Coord, c2: Coord) {
		const [sind1, cosd1] = Base.sincos(c1[1])
		const [sind2, cosd2] = Base.sincos(c2[1])
		const cosdr = cos(c2[0] - c1[0])
		const x = cosd1 * sind2 - sind1 * cosd2 * cosdr
		const y = cosd2 * sin(c2[0] - c1[0])
		const z = sind1 * sind2 + cosd1 * cosd2 * cosdr
		return atan2(hypot(x, y), z)
	}

	// Computes the minimum separation between two moving objects.
	export function minSepPauwels(jd1: number, jd3: number, cs1: readonly [Coord, Coord, Coord], cs2: readonly [Coord, Coord, Coord]) {
		return minSep(jd1, jd3, cs1, cs2, sepPauwels)
	}

	// Computes the position angle of one body with respect to another.
	export function relativePosition(c1: Coord, c2: Coord) {
		const [sinDeltar, cosDeltar] = Base.sincos(c1[0] - c2[0])
		const [sind2, cosd2] = Base.sincos(c2[1])
		const p = atan2(sinDeltar, cosd2 * tan(c1[1]) - sind2 * cosDeltar)
		return p
	}
}

// Chapter 18: Planetary Conjunctions.
export namespace Conjunction {
	// Computes the time of conjunction between two moving objects, such as planets.
	// t1, t5 are times of first and last rows of ephemerides. The scale is arbitrary.
	// cs1 is the ephemeris of the first object (equatorial or ecliptic).
	// cs2 is the ephemeris of the second object, in the same frame as the first.
	export function planetary(t1: number, t5: number, cs1: readonly Coord[], cs2: readonly Coord[]) {
		if (cs1.length !== 5 || cs1.length !== cs2.length) throw new Error('five rows required in ephemerides')

		const dr = new Float64Array(cs1.length)
		const dd = new Float64Array(cs1.length)

		for (let i = 0; i < cs2.length; i++) {
			dr[i] = cs2[i][0] - cs1[i][0]
			dd[i] = cs2[i][1] - cs1[i][1]
		}

		return conj(t1, t5, dr, dd)
	}

	// Computes a conjunction between a moving and non-moving object.
	export function stellar(t1: number, t5: number, c1: Coord, cs2: readonly Coord[]) {
		if (cs2.length !== 5) throw new Error('five rows required in ephemerides')

		const dr = new Float64Array(cs2.length)
		const dd = new Float64Array(cs2.length)

		for (let i = 0; i < cs2.length; i++) {
			dr[i] = cs2[i][0] - c1[0]
			dd[i] = cs2[i][1] - c1[1]
		}

		return conj(t1, t5, dr, dd)
	}

	// Returns the time of conjunction in JDE and the amount that object 2 was "above" object 1 at the time of conjunction.
	function conj(t1: number, t5: number, dr: NumberArray, dd: NumberArray) {
		const t = new Interpolation.Len5(t1, t5, dr).zero(true)
		const deltad = new Interpolation.Len5(t1, t5, dd).interpolateXStrict(t)
		return [t, deltad] as const
	}
}

// Chapter 20, Smallest Circle containing three Celestial Bodies.
export namespace Circle {
	// Finds the smallest circle containing three points.
	export function smallest(c1: Coord, c2: Coord, c3: Coord) {
		// Using haversine formula
		const cd1 = cos(c1[1])
		const cd2 = cos(c2[1])
		const cd3 = cos(c3[1])
		let a = 2 * asin(sqrt(AngularSeparation.hav(c2[1] - c1[1]) + cd1 * cd2 * AngularSeparation.hav(c2[0] - c1[0])))
		let b = 2 * asin(sqrt(AngularSeparation.hav(c3[1] - c2[1]) + cd2 * cd3 * AngularSeparation.hav(c3[0] - c2[0])))
		let c = 2 * asin(sqrt(AngularSeparation.hav(c1[1] - c3[1]) + cd3 * cd1 * AngularSeparation.hav(c1[0] - c3[0])))

		if (b > a) {
			const t = a
			a = b
			b = t
		}

		if (c > a) {
			const t = a
			a = c
			c = t
		}

		if (a * a >= b * b + c * c) return [a, true] as const

		// (20.1) p. 128
		return [(2 * a * b * c) / sqrt((a + b + c) * (a + b - c) * (b + c - a) * (a + c - b)), false] as const
	}
}

// Chapter 21, Precession.
export namespace Precession {
	// Functions in this package take Julian epoch argurments rather than Julian
	// days. Use Base.jdeToJulianYear() to convert.

	// Computes the approximate annual precision in right ascension and declination.
	// The two epochs should be within a few hundred years.
	// The declinations should not be too close to the poles.
	export function approxAnnualPrecession(rightAscension: Angle, declination: Angle, epochFrom: number, epochTo: number) {
		const [m, na, nd] = mn(epochFrom, epochTo)
		const [sa, ca] = Base.sincos(rightAscension)
		// (21.1) p. 132
		const da = m + na * sa * Math.tan(declination) // seconds of RA
		const dd = nd * ca // seconds of DEC
		return [da * ASEC2RAD * 15, dd * ASEC2RAD] as const
	}

	export function mn(epochFrom: number, epochTo: number) {
		const T = (epochTo - epochFrom) * 0.01
		const m = 3.07496 + 0.00186 * T
		const na = 1.33621 - 0.00057 * T
		const nd = 20.0431 - 0.0085 * T
		return [m, na, nd] as const
	}

	// Uses ApproxAnnualPrecession to compute a simple and quick precession while still considering proper motion.
	export function approxPosition(rightAscension: Angle, declination: Angle, epochFrom: number, epochTo: number, mAlpha: Angle, mDelta: Angle) {
		const [ra, dec] = approxAnnualPrecession(rightAscension, declination, epochFrom, epochTo)
		const dy = epochTo - epochFrom
		return [rightAscension + (ra + mAlpha) * dy, declination + (dec + mDelta) * dy] as const
	}

	// coefficients from (21.2) p. 134
	const ZETA_T = [2306.2181 * ASEC2RAD, 1.39656 * ASEC2RAD, -0.000139 * ASEC2RAD] as const
	const Z_T = [2306.2181 * ASEC2RAD, 1.39656 * ASEC2RAD, -0.000139 * ASEC2RAD] as const
	const THETA_T = [2004.3109 * ASEC2RAD, -0.8533 * ASEC2RAD, -0.000217 * ASEC2RAD] as const
	// coefficients from (21.3) p. 134
	const ZETAT = [2306.2181 * ASEC2RAD, 0.30188 * ASEC2RAD, 0.017998 * ASEC2RAD] as const
	const ZT = [2306.2181 * ASEC2RAD, 1.09468 * ASEC2RAD, 0.018203 * ASEC2RAD] as const
	const THETAT = [2004.3109 * ASEC2RAD, -0.42665 * ASEC2RAD, -0.041833 * ASEC2RAD] as const

	// Precessor represents precession from one epoch to another.
	export class Precessor {
		readonly #zeta: number
		readonly #z: number
		readonly #sTheta: number
		readonly #cTheta: number

		constructor(
			readonly epochFrom: number,
			readonly epochTo: number,
		) {
			// (21.2) p. 134
			let zetaCoeff = ZETAT
			let zCoeff = ZT
			let thetaCoeff = THETAT

			if (epochFrom !== 2000) {
				const T = (epochFrom - 2000) * 0.01
				zetaCoeff = [Base.horner(T, ZETA_T), 0.30188 * ASEC2RAD - 0.000344 * ASEC2RAD * T, 0.017998 * ASEC2RAD]
				zCoeff = [Base.horner(T, Z_T), 1.09468 * ASEC2RAD + 0.000066 * ASEC2RAD * T, 0.018203 * ASEC2RAD]
				thetaCoeff = [Base.horner(T, THETA_T), -0.42665 * ASEC2RAD - 0.000217 * ASEC2RAD * T, -0.041833 * ASEC2RAD]
			}

			const t = (epochTo - epochFrom) * 0.01
			this.#zeta = Base.horner(t, zetaCoeff) * t
			this.#z = Base.horner(t, zCoeff) * t
			const theta = Base.horner(t, thetaCoeff) * t
			this.#sTheta = sin(theta)
			this.#cTheta = cos(theta)
		}

		// Precesses equatorial coordinates.
		precess(rightAscension: Angle, declination: Angle) {
			// (21.4) p. 134
			const [sDelta, cDelta] = Base.sincos(declination)
			const [sAlphaZeta, cAlphaZeta] = Base.sincos(rightAscension + this.#zeta)
			const A = cDelta * sAlphaZeta
			const B = this.#cTheta * cDelta * cAlphaZeta - this.#sTheta * sDelta
			const C = this.#sTheta * cDelta * cAlphaZeta + this.#cTheta * sDelta
			const ra = Math.atan2(A, B) + this.#z
			const dec = C < Base.COS_SMALL_ANGLE ? Math.asin(C) : Math.acos(Math.hypot(A, B)) // near pole
			return [ra, dec] as const
		}
	}

	// Precesses equatorial coordinates from one epoch to another, including proper motions.
	export function position(p: Precessor, rightAscension: Angle, declination: Angle, pmRA: Angle, pmDEC: Angle) {
		const t = p.epochTo - p.epochFrom
		return p.precess(rightAscension + pmRA * t, declination + pmDEC * t)
	}

	// coefficients from (21.5) p. 136
	const ETA_T = [47.0029 * ASEC2RAD, -0.06603 * ASEC2RAD, 0.000598 * ASEC2RAD] as const
	const PI_T = [174.876384 * DEG2RAD, 3289.4789 * ASEC2RAD, 0.60622 * ASEC2RAD] as const
	const P_T = [5029.0966 * ASEC2RAD, 2.22226 * ASEC2RAD, -0.000042 * ASEC2RAD] as const
	const ETAT = [47.0029 * ASEC2RAD, -0.03302 * ASEC2RAD, 0.00006 * ASEC2RAD] as const
	const PIT = [174.876384 * DEG2RAD, -869.8089 * ASEC2RAD, 0.03536 * ASEC2RAD] as const
	const PT = [5029.0966 * ASEC2RAD, 1.11113 * ASEC2RAD, -0.000006 * ASEC2RAD] as const

	// Represents precession from one epoch to another.
	export class EclipticPrecessor {
		readonly #pi: number
		readonly #p: number
		readonly #sEta: number
		readonly #cEta: number

		constructor(
			readonly epochFrom: number,
			readonly epochTo: number,
		) {
			// (21.5) p. 136
			let etaCoeff = ETAT
			let piCoeff = PIT
			let pCoeff = PT

			if (epochFrom !== 2000) {
				const T = (epochFrom - 2000) * 0.01
				etaCoeff = [Base.horner(T, ETA_T), -0.03302 * ASEC2RAD + 0.000598 * ASEC2RAD * T, 0.00006 * ASEC2RAD]
				piCoeff = [Base.horner(T, PI_T), -869.8089 * ASEC2RAD - 0.50491 * ASEC2RAD * T, 0.03536 * ASEC2RAD]
				pCoeff = [Base.horner(T, P_T), 1.11113 * ASEC2RAD - 0.000042 * ASEC2RAD * T, -0.000006 * ASEC2RAD]
			}

			const t = (epochTo - epochFrom) * 0.01
			this.#pi = Base.horner(t, piCoeff)
			this.#p = Base.horner(t, pCoeff) * t
			const eta = Base.horner(t, etaCoeff) * t
			this.#sEta = Math.sin(eta)
			this.#cEta = Math.cos(eta)
		}

		// Precesses coordinates eclFrom, leaving result in eclTo.
		precess(longitude: Angle, latitude: Angle) {
			// (21.7) p. 137
			const [sBeta, cBeta] = Base.sincos(latitude)
			const [sd, cd] = Base.sincos(this.#pi - longitude)
			const A = this.#cEta * cBeta * sd - this.#sEta * sBeta
			const B = cBeta * cd
			const C = this.#cEta * sBeta + this.#sEta * cBeta * sd
			const lon = this.#p + this.#pi - Math.atan2(A, B)
			const lat = C < Base.COS_SMALL_ANGLE ? Math.asin(C) : Math.acos(Math.hypot(A, B)) // near pole
			return [lon, lat]
		}

		// Reduces orbital elements of a solar system body from one equinox to another.
		reduceElements(eFrom: EquinoxOrbitalElements): EquinoxOrbitalElements {
			const psi = this.#pi + this.#p
			const [si, ci] = Base.sincos(eFrom[0])
			const [snp, cnp] = Base.sincos(eFrom[1] - this.#pi)
			// (24.1) p. 159
			const inc = Math.acos(ci * this.#cEta + si * this.#sEta * cnp)
			// (24.2) p. 159
			const node = Math.atan2(si * snp, this.#cEta * si * cnp - this.#sEta * ci) + psi
			// (24.3) p. 159
			const peri = Math.atan2(-this.#sEta * snp, si * this.#cEta - ci * this.#sEta * cnp) + eFrom[2]
			return [inc, node, peri]
		}
	}

	// Precesses ecliptic coordinates from one epoch to another, including proper motions.
	export function eclipticPosition(p: EclipticPrecessor, longitude: Angle, latitude: Angle, pmRA: Angle = 0, pmDEC: Angle = 0) {
		if (Number.isFinite(pmRA) && Number.isFinite(pmDEC) && pmRA !== 0 && pmDEC !== 0) {
			const [lon, lat] = properMotion(pmRA, pmDEC, p.epochFrom, longitude, latitude)
			const t = p.epochTo - p.epochFrom
			longitude += lon * t
			latitude += lat * t
		}

		return p.precess(longitude, latitude)
	}

	export function properMotion(pmRA: Angle, pmDEC: Angle, epoch: number, longitude: Angle, latitude: Angle) {
		if (!pmRA && !pmDEC) return [longitude, latitude] as const
		const epsilon = Nutation.meanObliquity(Base.julianYearToJDE(epoch))
		const [epsilonsin, epsiloncos] = Base.sincos(epsilon)
		const [ra, dec] = Coords.eclipticToEquatorial(longitude, latitude, epsilon)
		const [sAlpha, cAlpha] = Base.sincos(ra)
		const [sDelta, cDelta] = Base.sincos(dec)
		const cBeta = Math.cos(latitude)
		const lon = (pmDEC * epsilonsin * cAlpha + pmRA * cDelta * (epsiloncos * cDelta + epsilonsin * sDelta * sAlpha)) / (cBeta * cBeta)
		const lat = (pmDEC * (epsiloncos * cDelta + epsilonsin * sDelta * sAlpha) - pmRA * epsilonsin * cAlpha * cDelta) / cBeta
		return [lon, lat] as const
	}

	// Takes the 3D equatorial coordinates of an object at one epoch and computes its
	// coordinates at a new epoch, considering proper motion and radial velocity.
	// Radial distance (r) must be in parsecs, radial velocitiy (mr) in parsecs per year.
	export function properMotion3D(rightAscension: Angle, declination: Angle, epochFrom: number, epochTo: number, r: number, mr: number, pmRA: Angle, pmDEC: Angle) {
		const [sAlpha, cAlpha] = Base.sincos(rightAscension)
		const [sDelta, cDelta] = Base.sincos(declination)
		const x = r * cDelta * cAlpha
		const y = r * cDelta * sAlpha
		const z = r * sDelta
		const mrr = mr / r
		const zmDelta = z * pmDEC
		const mx = x * mrr - zmDelta * cAlpha - y * pmRA
		const my = y * mrr - zmDelta * sAlpha + x * pmRA
		const mz = z * mrr + r * pmDEC * cDelta
		const t = epochTo - epochFrom
		const xp = x + t * mx
		const yp = y + t * my
		const zp = z + t * mz
		const ra = Math.atan2(yp, xp)
		const dec = Math.atan2(zp, Math.hypot(xp, yp))
		return [ra, dec] as const
	}
}

// Chapter 22, Nutation and the Obliquity of the Ecliptic.
export namespace Nutation {
	const D_TERMS = [297.85036 * DEG2RAD, 445267.11148 * DEG2RAD, -0.0019142 * DEG2RAD, DEG2RAD / 189474] as const
	const M_TERMS = [357.52772 * DEG2RAD, 35999.05034 * DEG2RAD, -0.0001603 * DEG2RAD, -DEG2RAD / 300000] as const
	const N_TERMS = [134.96298 * DEG2RAD, 477198.867398 * DEG2RAD, 0.0086972 * DEG2RAD, DEG2RAD / 56250] as const
	const F_TERMS = [93.27191 * DEG2RAD, 483202.017538 * DEG2RAD, -0.0036825 * DEG2RAD, DEG2RAD / 327270] as const
	const OMEGA_TERMS = [125.04452 * DEG2RAD, -1934.136261 * DEG2RAD, 0.0020708 * DEG2RAD, DEG2RAD / 450000] as const

	// Computes nutation in longitude (deltaPsi) and nutation in obliquity (deltaEpsilon) for a given JDE (UT + deltaT).
	export function nutation(jde: number) {
		const T = Base.j2000Century(jde)
		// Mean elongation of the Moon from the sun
		const D = Base.horner(T, D_TERMS)
		// Mean anomaly of the Sun (Earth)
		const M = Base.horner(T, M_TERMS)
		// Mean anomaly of the Moon
		const N = Base.horner(T, N_TERMS)
		// Moon's argument of latitude
		const F = Base.horner(T, F_TERMS)
		// Longitude of the ascending node of the Moon's mean orbit on the ecliptic, measured from mean equinox of date
		const omega = Base.horner(T, OMEGA_TERMS)

		let deltaPsi = 0
		let deltaEpsilon = 0

		// Sum in reverse order to accumulate smaller terms first
		for (let i = TABLE_22A.length - 1; i >= 0; i--) {
			const row = TABLE_22A[i]
			const arg = row[0] * D + row[1] * M + row[2] * N + row[3] * F + row[4] * omega
			deltaPsi += sin(arg) * (row[5] + row[6] * T)
			deltaEpsilon += cos(arg) * (row[7] + row[8] * T)
		}

		deltaPsi *= 0.0001 * (DEG2RAD / 3600)
		deltaEpsilon *= 0.0001 * (DEG2RAD / 3600)

		return [deltaPsi, deltaEpsilon] as const
	}

	// Computes a fast approximation of nutation in longitude (deltaPsi) and nutation in obliquity (deltaEpsilon) for a given JDE.
	// Accuracy is 0.5" in deltaPsi, 0.1" in deltaEpsilon.
	export function approxNutation(jde: number) {
		const T = (jde - Base.J2000) / Base.JULIAN_CENTURY
		const omega = 125.04452 * DEG2RAD - 1934.136261 * DEG2RAD * T
		const L = 280.4665 * DEG2RAD + 36000.7698 * DEG2RAD * T
		const N = 218.3165 * DEG2RAD + 481267.8813 * DEG2RAD * T
		const [sOmega, cOmega] = Base.sincos(omega)
		const [s2L, c2L] = Base.sincos(2 * L)
		const [s2N, c2N] = Base.sincos(2 * N)
		const [s2Omega, c2Omega] = Base.sincos(2 * omega)
		const deltaPsi = (-17.2 * sOmega - 1.32 * s2L - 0.23 * s2N + 0.21 * s2Omega) * (DEG2RAD / 3600)
		const deltaEpsilon = (9.2 * cOmega + 0.57 * c2L + 0.1 * c2N - 0.09 * c2Omega) * (DEG2RAD / 3600)
		return [deltaPsi, deltaEpsilon] as const
	}

	// Computes mean obliquity (epsilon₀) following the IAU 1980 polynomial.
	// Accuracy is 1″ over the range 1000 to 3000 years and 10″ over the range 0 to 4000 years.
	export function meanObliquity(jde: number) {
		// (22.2) p. 147
		return Base.horner(Base.j2000Century(jde), [0.4090928042223289, (-46.815 / 3600) * DEG2RAD, (-0.00059 / 3600) * DEG2RAD, (0.001813 / 3600) * DEG2RAD])
	}

	const MEAN_OBLIQUITY_LASKAR_TERMS = [
		0.4090928042223289, // 23h 26' 21.448"
		(-4680.93 / 3600) * DEG2RAD,
		(-1.55 / 3600) * DEG2RAD,
		(1999.25 / 3600) * DEG2RAD,
		(-51.38 / 3600) * DEG2RAD,
		(-249.67 / 3600) * DEG2RAD,
		(-39.05 / 3600) * DEG2RAD,
		(7.12 / 3600) * DEG2RAD,
		(27.87 / 3600) * DEG2RAD,
		(5.79 / 3600) * DEG2RAD,
		(2.45 / 3600) * DEG2RAD,
	] as const

	// Computes mean obliquity (epsilon₀) following the Laskar 1986 polynomial.	 *
	// Accuracy over the range 1000 to 3000 years is .01″.
	// Accuracy over the valid date range of -8000 to +12000 years is "a few seconds.
	export function meanObliquityLaskar(jde: number) {
		// (22.3) p. 147
		return Base.horner(Base.j2000Century(jde) * 0.01, MEAN_OBLIQUITY_LASKAR_TERMS)
	}

	// Computes "nutation in right ascension" or "equation of the equinoxes".
	export function nutationInRA(jde: number) {
		const [deltaPsi, deltaEpsilon] = nutation(jde)
		const epsilon0 = meanObliquity(jde)
		return deltaPsi * cos(epsilon0 + deltaEpsilon)
	}

	const TABLE_22A = [
		// d,m,n,f,omega,s0,s1,c0,c1
		[0, 0, 0, 0, 1, -171996, -174.2, 92025, 8.9],
		[-2, 0, 0, 2, 2, -13187, -1.6, 5736, -3.1],
		[0, 0, 0, 2, 2, -2274, -0.2, 977, -0.5],
		[0, 0, 0, 0, 2, 2062, 0.2, -895, 0.5],
		[0, 1, 0, 0, 0, 1426, -3.4, 54, -0.1],
		[0, 0, 1, 0, 0, 712, 0.1, -7, 0],
		[-2, 1, 0, 2, 2, -517, 1.2, 224, -0.6],
		[0, 0, 0, 2, 1, -386, -0.4, 200, 0],
		[0, 0, 1, 2, 2, -301, 0, 129, -0.1],
		[-2, -1, 0, 2, 2, 217, -0.5, -95, 0.3],
		[-2, 0, 1, 0, 0, -158, 0, 0, 0],
		[-2, 0, 0, 2, 1, 129, 0.1, -70, 0],
		[0, 0, -1, 2, 2, 123, 0, -53, 0],
		[2, 0, 0, 0, 0, 63, 0, 0, 0],
		[0, 0, 1, 0, 1, 63, 0.1, -33, 0],
		[2, 0, -1, 2, 2, -59, 0, 26, 0],
		[0, 0, -1, 0, 1, -58, -0.1, 32, 0],
		[0, 0, 1, 2, 1, -51, 0, 27, 0],
		[-2, 0, 2, 0, 0, 48, 0, 0, 0],
		[0, 0, -2, 2, 1, 46, 0, -24, 0],
		[2, 0, 0, 2, 2, -38, 0, 16, 0],
		[0, 0, 2, 2, 2, -31, 0, 13, 0],
		[0, 0, 2, 0, 0, 29, 0, 0, 0],
		[-2, 0, 1, 2, 2, 29, 0, -12, 0],
		[0, 0, 0, 2, 0, 26, 0, 0, 0],
		[-2, 0, 0, 2, 0, -22, 0, 0, 0],
		[0, 0, -1, 2, 1, 21, 0, -10, 0],
		[0, 2, 0, 0, 0, 17, -0.1, 0, 0],
		[2, 0, -1, 0, 1, 16, 0, -8, 0],
		[-2, 2, 0, 2, 2, -16, 0.1, 7, 0],
		[0, 1, 0, 0, 1, -15, 0, 9, 0],
		[-2, 0, 1, 0, 1, -13, 0, 7, 0],
		[0, -1, 0, 0, 1, -12, 0, 6, 0],
		[0, 0, 2, -2, 0, 11, 0, 0, 0],
		[2, 0, -1, 2, 1, -10, 0, 5, 0],
		[2, 0, 1, 2, 2, -8, 0, 3, 0],
		[0, 1, 0, 2, 2, 7, 0, -3, 0],
		[-2, 1, 1, 0, 0, -7, 0, 0, 0],
		[0, -1, 0, 2, 2, -7, 0, 3, 0],
		[2, 0, 0, 2, 1, -7, 0, 3, 0],
		[2, 0, 1, 0, 0, 6, 0, 0, 0],
		[-2, 0, 2, 2, 2, 6, 0, -3, 0],
		[-2, 0, 1, 2, 1, 6, 0, -3, 0],
		[2, 0, -2, 0, 1, -6, 0, 3, 0],
		[2, 0, 0, 0, 1, -6, 0, 3, 0],
		[0, -1, 1, 0, 0, 5, 0, 0, 0],
		[-2, -1, 0, 2, 1, -5, 0, 3, 0],
		[-2, 0, 0, 0, 1, -5, 0, 3, 0],
		[0, 0, 2, 2, 1, -5, 0, 3, 0],
		[-2, 0, 2, 0, 1, 4, 0, 0, 0],
		[-2, 1, 0, 2, 1, 4, 0, 0, 0],
		[0, 0, 1, -2, 0, 4, 0, 0, 0],
		[-1, 0, 1, 0, 0, -4, 0, 0, 0],
		[-2, 1, 0, 0, 0, -4, 0, 0, 0],
		[1, 0, 0, 0, 0, -4, 0, 0, 0],
		[0, 0, 1, 2, 0, 3, 0, 0, 0],
		[0, 0, -2, 2, 2, -3, 0, 0, 0],
		[-1, -1, 1, 0, 0, -3, 0, 0, 0],
		[0, 1, 1, 0, 0, -3, 0, 0, 0],
		[0, -1, 1, 2, 2, -3, 0, 0, 0],
		[2, -1, -1, 2, 2, -3, 0, 0, 0],
		[0, 0, 3, 2, 2, -3, 0, 0, 0],
		[2, -1, 0, 2, 2, -3, 0, 0, 0],
	] as const
}

export type EquinoxOrbitalElements = readonly [Angle, Angle, Angle] // inclination, longitude of ascending node, argument of perihelion

// Chapter 24, Reduction of Ecliptical Elements from one Equinox to another one.
export namespace ElementEquinox {
	// (24.4) p. 161
	const S = 0.0001139788
	const C = 0.9999999935

	// Reduces orbital elements of a solar system body from equinox B1950 to J2000.
	export function reduceB1950ToJ2000(from: EquinoxOrbitalElements): EquinoxOrbitalElements {
		const W = from[1] - 174.298782 * DEG2RAD
		const [si, ci] = Base.sincos(from[0])
		const [sW, cW] = Base.sincos(W)
		const A = si * sW
		const B = C * si * cW - S * ci
		const inc = asin(hypot(A, B))
		const node = normalizeAngle(174.997194 * DEG2RAD + atan2(A, B))
		const peri = normalizeAngle(from[2] + atan2(-S * sW, C * si - S * ci * cW))
		return [inc, node, peri]
	}

	const Lp = 4.50001688 * DEG2RAD
	const L = 5.19856209 * DEG2RAD
	const J = 0.00651966 * DEG2RAD
	const [SJ, CJ] = Base.sincos(J)

	// Reduces orbital elements of a solar system body from
	// equinox B1950 in the FK4 system to equinox J2000 in the FK5 system.
	export function reduceB1950FK4ToJ2000FK5(from: EquinoxOrbitalElements): EquinoxOrbitalElements {
		const W = L + from[1]
		const [si, ci] = Base.sincos(from[0])
		const [sW, cW] = Base.sincos(W)
		const inc = acos(ci * CJ - si * SJ * cW)
		const node = normalizeAngle(atan2(si * sW, ci * SJ + si * CJ * cW) - Lp)
		const peri = normalizeAngle(from[2] + atan2(SJ * sW, si * CJ + ci * SJ * cW))
		return [inc, node, peri]
	}
}

// Chapter 30, Equation of Kepler.
export namespace Kepler {
	// Computes true anomaly nu for given eccentric anomaly E.
	export function trueAnomaly(E: number, e: Angle) {
		// (30.1) p. 195
		return 2 * atan(sqrt((1 + e) / (1 - e)) * tan(E * 0.5))
	}

	// Computes radius distance r (in units of a) for given eccentric anomaly E.
	export function radius(E: Angle, e: number, a: number) {
		// (30.2) p. 195
		return a * (1 - e * cos(E))
	}

	// Kepler1 solves Kepler's equation by iteration. The iterated formula is E1 = m + e * sin(E0).
	// For some vaues of e and M it will fail to converge and the function will return an error.
	export function kepler1(e: number, m: Angle, places: number) {
		// (30.5) p. 195
		const f = (E0: number) => m + e * sin(E0)
		return Iteration.decimalPlaces(f, m, places, places * 5)
	}

	// Kepler2 solves Kepler's equation by iteration. The iterated formula is E1 = E0 + (m + e * sin(E0) - E0) / (1 - e * cos(E0))
	// The function converges over a wider range of inputs than does Kepler1 but it also fails to converge for some values of e and M.
	export function kepler2(e: number, m: Angle, places: number) {
		const f = (E0: number) => {
			const se = sin(E0)
			const ce = cos(E0)
			return E0 + (m + e * se - E0) / (1 - e * ce) // (30.7) p. 199
		}

		return Iteration.decimalPlaces(f, m, places, places)
	}

	// Solves Kepler's equation by iteration. The iterated formula is the same as in Kepler2 but a limiting function avoids divergence.
	export function kepler2a(e: number, m: Angle, places: number) {
		const f = (E0: number) => {
			const se = sin(E0)
			const ce = cos(E0)
			// method of Leingärtner, p. 205
			return E0 + asin(sin((m + e * se - E0) / (1 - e * ce)))
		}

		return Iteration.decimalPlaces(f, m, places, places * 5)
	}

	// Kepler2b solves Kepler's equation by iteration. The iterated formula is the same as in Kepler2 but a (different) limiting function avoids divergence.
	export function kepler2b(e: number, m: Angle, places: number) {
		const f = (E0: number) => {
			const se = sin(E0)
			const ce = cos(E0)
			let d = (m + e * se - E0) / (1 - e * ce)
			// method of Steele, p. 205
			if (d > 0.5) d = 0.5
			else if (d < -0.5) d = -0.5
			return E0 + d
		}

		return Iteration.decimalPlaces(f, m, places, places)
	}

	// Solves Kepler's equation by binary search.
	export function kepler3(e: number, m: number) {
		// adapted from BASIC, p. 206
		m = normalizeAngle(m)
		let f = 1

		if (m > PI) {
			f = -1
			m = 2 * PI - m
		}

		let E0 = PI * 0.5
		let d = PI * 0.25

		for (let i = 0; i < 53; i++) {
			const M1 = E0 - e * sin(E0)

			if (m - M1 < 0) {
				E0 -= d
			} else {
				E0 += d
			}

			d *= 0.5
		}

		return f < 0 ? -E0 : E0
	}

	// Computes an approximate solution to Kepler's equation. It is valid only for small values of e.
	export function kepler4(e: number, m: number) {
		return atan2(sin(m), cos(m) - e) // (30.8) p. 206
	}
}

// Chapter 36, The Calculation of some Planetary Phenomena.
export namespace Planetary {
	// Computes some intermediate values for a mean planetary configuration
	// given a year and a row of coefficients from Table 36.A, p. 250.0
	export function mean(y: number, a: readonly [number, number, number, number]) {
		// (36.1) p. 250
		const k = floor((365.2425 * y + 1721060 - a[0]) / a[1] + 0.5)
		const J = a[0] + k * a[1]
		const M = normalizeAngle(a[2] + k * a[3])
		const T = Base.j2000Century(J)
		return [J, M, T]
	}

	// Computes a sum of periodic terms.
	export function sum(T: number, M: number, c: readonly Readonly<NumberArray>[]) {
		let j = Base.horner(T, c[0])
		let mm = 0

		for (let i = 1; i < c.length; i++) {
			mm += M

			const [smm, cmm] = Base.sincos(mm)
			j += smm * Base.horner(T, c[i++])
			j += cmm * Base.horner(T, c[i])
		}

		return j
	}

	// Computes the mean time corrected by a sum.
	export function ms(y: number, a: readonly [number, number, number, number], c: readonly Readonly<NumberArray>[]) {
		const [J, M, T] = mean(y, a)
		return J + sum(T, M, c)
	}

	// Computes the time of an inferior conjunction of Mercury.
	export function mercuryInfConj(y: number) {
		return ms(y, MICA, MICB)
	}

	// Computes the time of a superior conjunction of Mercury.
	export function mercurySupConj(y: number) {
		return ms(y, MSCA, MSCB)
	}

	// Computes the time of an inferior conjunction of Venus.
	export function venusInfConj(y: number) {
		return ms(y, VICA, VICB)
	}

	// Computes the time of an opposition of Mars.
	export function marsOpp(y: number) {
		return ms(y, MOA, MOB)
	}

	// Computes the sum of periodic terms with "additional angles"
	export function sumA(T: number, M: number, c: readonly Readonly<NumberArray>[], aa: readonly Readonly<[number, number]>[]) {
		let i = c.length - 2 * aa.length
		let j = sum(T, M, c.slice(0, i))

		for (let k = 0; k < aa.length; k++) {
			const [saa, caa] = Base.sincos(aa[k][0] + aa[k][1] * T)
			j += saa * Base.horner(T, c[i++])
			j += caa * Base.horner(T, c[i++])
		}

		return j
	}

	// Computes the mean time corrected by a sum.
	export function msa(y: number, a: readonly [number, number, number, number], c: readonly Readonly<NumberArray>[], aa: readonly Readonly<[number, number]>[]) {
		const [J, M, T] = mean(y, a)
		return J + sumA(T, M, c, aa)
	}

	// Computes the time of an opposition of Jupiter.
	export function jupiterOpp(y: number) {
		return msa(y, JOA, JOB, JAA)
	}

	// Computes the time of an opposition of Saturn.
	export function saturnOpp(y: number) {
		return msa(y, SOA, SOB, SAA)
	}

	// Computes the time of a conjunction of Saturn.
	export function saturnConj(y: number) {
		return msa(y, SCA, SCB, SAA)
	}

	// Computes the time of an opposition of Uranus.
	export function uranusOpp(y: number) {
		return msa(y, UOA, UOB, UAA)
	}

	// Computes the time of an opposition of Neptune.
	export function neptuneOpp(y: number) {
		return msa(y, NOA, NOB, NAA)
	}

	// Computes time and elongation of a greatest elongation event.
	export function el(y: number, a: unknown, t: readonly Readonly<NumberArray>[], e: readonly Readonly<NumberArray>[]) {
		const [J, M, T] = mean(y, MICA)
		return [J + sum(T, M, t), sum(T, M, e) * DEG2RAD] as const
	}

	// Computes the time and elongation of a greatest eastern elongation of Mercury.
	export function mercuryEastElongation(y: number) {
		return el(y, MICA, MET, MEE)
	}

	// Computes the time and elongation of a greatest western elongation of Mercury.
	export function mercuryWestElongation(y: number) {
		return el(y, MICA, MWT, MWE)
	}

	export function marsStation2(y: number) {
		const [J, M, T] = mean(y, MOA)
		return J + sum(T, M, MS2)
	}

	// Table 36.A, p. 250
	const MICA = [2451612.023, 115.8774771, 63.5867 * DEG2RAD, 114.2088742 * DEG2RAD] as const
	const MSCA = [2451554.084, 115.8774771, 6.4822 * DEG2RAD, 114.2088742 * DEG2RAD] as const
	const VICA = [2451996.706, 583.921361, 82.7311 * DEG2RAD, 215.513058 * DEG2RAD] as const
	const MOA = [2452097.382, 779.936104, 181.9573 * DEG2RAD, 48.705244 * DEG2RAD] as const
	const JOA = [2451870.628, 398.884046, 318.4681 * DEG2RAD, 33.140229 * DEG2RAD] as const
	const SOA = [2451870.17, 378.091904, 318.0172 * DEG2RAD, 12.647487 * DEG2RAD] as const
	const SCA = [2451681.124, 378.091904, 131.6934 * DEG2RAD, 12.647487 * DEG2RAD] as const
	const UOA = [2451764.317, 369.656035, 213.6884 * DEG2RAD, 4.333093 * DEG2RAD] as const
	const NOA = [2451753.122, 367.486703, 202.6544 * DEG2RAD, 2.194998 * DEG2RAD] as const

	// Holds coefficients for "additional angles" for outer planets as given on p. 251

	const JAA = [[82.74 * DEG2RAD, 40.76 * DEG2RAD]] as const

	const SAA = [
		[82.74 * DEG2RAD, 40.76 * DEG2RAD],
		[29.86 * DEG2RAD, 1181.36 * DEG2RAD],
		[14.13 * DEG2RAD, 590.68 * DEG2RAD],
		[220.02 * DEG2RAD, 1262.87 * DEG2RAD],
	] as const

	const UAA = [
		[207.83 * DEG2RAD, 8.51 * DEG2RAD],
		[108.84 * DEG2RAD, 419.96 * DEG2RAD],
	] as const

	const NAA = [
		[207.83 * DEG2RAD, 8.51 * DEG2RAD],
		[276.74 * DEG2RAD, 209.98 * DEG2RAD],
	] as const

	// Table 33.B, p. 256
	const MICB = [
		[0.0545, 0.0002],
		[-6.2008, 0.0074, 0.00003],
		[-3.275, -0.0197, 0.00001],
		[0.4737, -0.0052, -0.00001],
		[0.8111, 0.0033, -0.00002],
		[0.0037, 0.0018],
		[-0.1768, 0, 0.00001],
		[-0.0211, -0.0004],
		[0.0326, -0.0003],
		[0.0083, 0.0001],
		[-0.004, 0.0001],
	] as const

	const MSCB = [
		[-0.0548, -0.0002],
		[7.3894, -0.01, -0.00003],
		[3.22, 0.0197, -0.00001],
		[0.8383, -0.0064, -0.00001],
		[0.9666, 0.0039, -0.00003],
		[0.077, -0.0026],
		[0.2758, 0.0002, -0.00002],
		[-0.0128, -0.0008],
		[0.0734, -0.0004, -0.00001],
		[-0.0122, -0.0002],
		[0.0173, -0.0002],
	] as const

	const VICB = [
		[-0.0096, 0.0002, -0.00001],
		[2.0009, -0.0033, -0.00001],
		[0.598, -0.0104, 0.00001],
		[0.0967, -0.0018, -0.00003],
		[0.0913, 0.0009, -0.00002],
		[0.0046, -0.0002],
		[0.0079, 0.0001],
	] as const

	const MOB = [
		[-0.3088, 0, 0.00002],
		[-17.6965, 0.0363, 0.00005],
		[18.3131, 0.0467, -0.00006],
		[-0.2162, -0.0198, -0.00001],
		[-4.5028, -0.0019, 0.00007],
		[0.8987, 0.0058, -0.00002],
		[0.7666, -0.005, -0.00003],
		[-0.3636, -0.0001, 0.00002],
		[0.0402, 0.0032],
		[0.0737, -0.0008],
		[-0.098, -0.0011],
	] as const

	const JOB = [
		[-0.1029, 0, -0.00009],
		[-1.9658, -0.0056, 0.00007],
		[6.1537, 0.021, -0.00006],
		[-0.2081, -0.0013],
		[-0.1116, -0.001],
		[0.0074, 0.0001],
		[-0.0097, -0.0001],
		[0, 0.0144, -0.00008],
		[0.3642, -0.0019, -0.00029],
	] as const

	const SOB = [
		[-0.0209, 0.0006, 0.00023],
		[4.5795, -0.0312, -0.00017],
		[1.1462, -0.0351, 0.00011],
		[0.0985, -0.0015],
		[0.0733, -0.0031, 0.00001],
		[0.0025, -0.0001],
		[0.005, -0.0002],
		[0, -0.0337, 0.00018],
		[-0.851, 0.0044, 0.00068],
		[0, -0.0064, 0.00004],
		[0.2397, -0.0012, -0.00008],
		[0, -0.001],
		[0.1245, 0.0006],
		[0, 0.0024, -0.00003],
		[0.0477, -0.0005, -0.00006],
	] as const

	const SCB = [
		[0.0172, -0.0006, 0.00023],
		[-8.5885, 0.0411, 0.0002],
		[-1.147, 0.0352, -0.00011],
		[0.3331, -0.0034, -0.00001],
		[0.1145, -0.0045, 0.00002],
		[-0.0169, 0.0002],
		[-0.0109, 0.0004],
		[0, -0.0337, 0.00018],
		[-0.851, 0.0044, 0.00068],
		[0, -0.0064, 0.00004],
		[0.2397, -0.0012, -0.00008],
		[0, -0.001],
		[0.1245, 0.0006],
		[0, 0.0024, -0.00003],
		[0.0477, -0.0005, -0.00006],
	] as const

	const UOB = [[0.0844, -0.0006], [-0.1048, 0.0246], [-5.1221, 0.0104, 0.00003], [-0.1428, 0.0005], [-0.0148, -0.0013], [0], [0.0055], [0], [0.885], [0], [0.2153]] as const

	const NOB = [[-0.014, 0, 0.00001], [-1.3486, 0.001, 0.00001], [0.8597, 0.0037], [-0.0082, -0.0002, 0.00001], [0.0037, -0.0003], [0], [-0.5964], [0], [0.0728]] as const

	// Table 36.C, p. 259

	const MET = [[-21.6106, 0.0002], [-1.9803, -0.006, 0.00001], [1.4151, -0.0072, -0.00001], [0.5528, -0.0005, -0.00001], [0.2905, 0.0034, 0.00001], [-0.1121, -0.0001, 0.00001], [-0.0098, -0.0015], [0.0192], [0.0111, 0.0004], [-0.0061], [-0.0032, -0.0001]] as const

	const MEE = [[22.4697], [-4.2666, 0.0054, 0.00002], [-1.8537, -0.0137], [0.3598, 0.0008, -0.00001], [-0.068, 0.0026], [-0.0524, -0.0003], [0.0052, -0.0006], [0.0107, 0.0001], [-0.0013, 0.0001], [-0.0021], [0.0003]] as const

	const MWT = [[21.6249, -0.0002], [0.1306, 0.0065], [-2.7661, -0.0011, 0.00001], [0.2438, -0.0024, -0.00001], [0.5767, 0.0023], [0.1041], [-0.0184, 0.0007], [-0.0051, -0.0001], [0.0048, 0.0001], [0.0026], [0.0037]] as const

	const MWE = [[22.4143, -0.0001], [4.3651, -0.0048, -0.00002], [2.3787, 0.0121, -0.00001], [0.2674, 0.0022], [-0.3873, 0.0008, 0.00001], [-0.0369, -0.0001], [0.0017, -0.0001], [0.0059], [0.0061, 0.0001], [0.0007], [-0.0011]] as const

	// Table 36.D, p. 261

	const MS2 = [
		[36.7191, 0.0016, 0.00003],
		[-12.6163, 0.0417, -0.00001],
		[20.1218, 0.0379, -0.00006],
		[-1.636, -0.019],
		[-3.9657, 0.0045, 0.00007],
		[1.1546, 0.0029, -0.00003],
		[0.2888, -0.0073, -0.00002],
		[-0.3128, 0.0017, 0.00002],
		[0.2513, 0.0026, -0.00002],
		[-0.0021, -0.0016],
		[-0.1497, -0.0006],
	] as const
}

// Chapter 39, Passages through the Nodes.
export namespace Node {
	// Computes time and distance of passage through the ascending node of a body in an elliptical orbit.
	export function ellipticAscending(axis: Distance, ecc: number, argP: Angle, timeP: number) {
		return elliptic(-argP, axis, ecc, timeP)
	}

	// Computes time and distance of passage through the descending node of a body in an elliptical orbit.
	export function ellipticDescending(axis: Distance, ecc: number, argP: Angle, timeP: number) {
		return elliptic(PI - argP, axis, ecc, timeP)
	}

	export function elliptic(nu: Angle, axis: Distance, ecc: number, timeP: number): readonly [number, Distance] {
		const E = 2 * atan(sqrt((1 - ecc) / (1 + ecc)) * tan(nu * 0.5))
		const [sE, cE] = Base.sincos(E)
		const M = E - ecc * sE
		const n = Base.K / axis / sqrt(axis)
		const jde = timeP + M / n
		const r = axis * (1 - ecc * cE)
		return [jde, r]
	}

	// Computes time and distance of passage through the ascending node of a body in a parabolic orbit.
	export function parabolicAscending(q: Distance, argP: Angle, timeP: number) {
		return parabolic(-argP, q, timeP)
	}

	// Computes time and distance of passage through the descending node of a body in a parabolic orbit.
	export function parabolicDescending(q: Distance, argP: Angle, timeP: number) {
		return parabolic(PI - argP, q, timeP)
	}

	export function parabolic(nu: Angle, q: Distance, timeP: number): readonly [number, Distance] {
		const s = tan(nu * 0.5)
		const jde = timeP + 27.403895 * s * (s * s + 3) * q * sqrt(q)
		const r = q * (1 + s * s)
		return [jde, r]
	}
}

// Chapter 40, Correction for Parallax.
export namespace Parallax {
	export const HOR_PAR = 8.794 * ASEC2RAD

	// Computes equatorial horizontal parallax of a body.
	export function horizontal(delta: Distance): Angle {
		// (40.1) p. 279
		return Math.asin(Math.sin(HOR_PAR) / delta)
		// return horPar / delta // with sufficient accuracy
	}

	// Computes topocentric positions including parallax given the distance to the observed object,
	// rhosPhi, rhocPhi parallax constants (see package globe), longitude of the observer, and time of observation.
	export function topocentric(rightAscension: Angle, declination: Angle, distance: Distance, rhosPhi: number, rhocPhi: number, longitude: Angle, jde: number) {
		const pi = horizontal(distance)
		const theta0 = secondsOfTime(Sidereal.apparent(jde))
		const H = normalizeAngle(theta0 - longitude - rightAscension)
		const sPi = Math.sin(pi)
		const [sH, cH] = Base.sincos(H)
		const [sDelta, cDelta] = Base.sincos(declination)
		const deltaAlpha = Math.atan2(-rhocPhi * sPi * sH, cDelta - rhocPhi * sPi * cH) // (40.2) p. 279
		const alpha = rightAscension + deltaAlpha
		const delta = Math.atan2((sDelta - rhosPhi * sPi) * Math.cos(deltaAlpha), cDelta - rhocPhi * sPi * cH) // (40.3) p. 279
		return [alpha, delta] as const
	}

	// Computes topocentric corrections including parallax using the "non-rigorous" method.
	export function topocentric2(rightAscension: Angle, declination: Angle, distance: Distance, rhosPhi: number, rhocPhi: number, longitude: Angle, jde: number) {
		const pi = horizontal(distance)
		const theta0 = secondsOfTime(Sidereal.apparent(jde))
		const H = normalizeAngle(theta0 - longitude - rightAscension)
		const [sH, cH] = Base.sincos(H)
		const [sDelta, cDelta] = Base.sincos(declination)
		const deltaAlpha = (-pi * rhocPhi * sH) / cDelta // (40.4) p. 280
		const deltaDelta = -pi * (rhosPhi * cDelta - rhocPhi * cH * sDelta) // (40.5) p. 280
		return [deltaAlpha, deltaDelta] as const // This is the corrections, not corrected coordinates
	}

	// Computes topocentric hour angle and declination including parallax using the "alternative" method.
	export function topocentric3(rightAscension: Angle, declination: Angle, distance: Distance, rhosPhi: number, rhocPhi: number, longitude: Angle, jde: number) {
		const pi = horizontal(distance)
		const theta0 = secondsOfTime(Sidereal.apparent(jde))
		const H = normalizeAngle(theta0 - longitude - rightAscension)
		const sPi = Math.sin(pi)
		const [sH, cH] = Base.sincos(H)
		const [sDelta, cDelta] = Base.sincos(declination)
		const A = cDelta * sH
		const B = cDelta * cH - rhocPhi * sPi
		const C = sDelta - rhosPhi * sPi
		const q = Math.sqrt(A * A + B * B + C * C)
		return [Math.atan2(A, B), Math.asin(C / q)] as const
	}

	// Computes topocentric ecliptical coordinates including parallax given geocentric ecliptical longitude and latitude of a body,
	// the geocentric semidiameter (s), the observer's latitude and and height above the ellipsoid (phi and h),
	// the obliquity of the ecliptic (epsilon), the local sidereal time (theta), and the equatorial horizontal parallax of the body (pi).
	export function topocentricEcliptical(longitude: Angle, latitude: Angle, s: Distance, phi: Angle, h: Distance, epsilon: Angle, theta: Angle, pi: Angle) {
		const [S, C] = Globe.EARTH76.parallaxConstants(phi, h)
		const [sLambda, cLambda] = Base.sincos(longitude)
		const [sBeta, cBeta] = Base.sincos(latitude)
		const [sEpsilon, cEpsilon] = Base.sincos(epsilon)
		const [sTheta, cTheta] = Base.sincos(theta)
		const sPi = Math.sin(pi)
		const N = cLambda * cBeta - C * sPi * cTheta
		const lambda = normalizeAngle(Math.atan2(sLambda * cBeta - sPi * (S * sEpsilon + C * cEpsilon * sTheta), N))
		const cLambda_ = Math.cos(lambda)
		const beta = Math.atan((cLambda_ * (sBeta - sPi * (S * cEpsilon - C * sEpsilon * sTheta))) / N)
		const s_ = Math.asin((cLambda_ * Math.cos(beta) * Math.sin(s)) / N)
		return [lambda, beta, s_]
	}
}

// Chapter 41, Illuminated Fraction of the Disk and Magnitude of a Planet.
export namespace Illuminated {
	// Computes the phase angle of a planet.
	// r is planet's distance to Sun, delta its distance to Earth, and R the distance from Sun to Earth. All distances in AU.
	export function phaseAngle(r: Distance, delta: Distance, R: Distance) {
		return acos((r * r + delta * delta - R * R) / (2 * r * delta))
	}

	// Computes the illuminated fraction of the disk of a planet.
	// r is planet's distance to Sun, delta its distance to Earth, and R the distance from Sun to Earth. All distances in AU.
	export function fraction(r: Distance, delta: Distance, R: Distance) {
		// (41.2) p. 283
		const s = r + delta
		return (s * s - R * R) / (4 * r * delta)
	}

	// Computes the phase angle of a planet.
	// L, B, R are heliocentric ecliptical coordinates of the planet.
	// L0, R0 are longitude and radius for Earth, delta is distance from Earth to the planet.
	export function phaseAngle2(L: Angle, B: Angle, R: Distance, L0: Angle, R0: Distance, delta: Distance) {
		// (41.3) p. 283
		return acos((R - R0 * cos(B) * cos(L - L0)) / delta)
	}

	// Computes the phase angle of a planet.
	// L, B are heliocentric ecliptical longitude and latitude of the
	// planet. x, y, z are cartesian coordinates of the planet, delta is distance
	// from Earth to the planet. All distances in AU, angles in radians.
	export function phaseAngle3(L: Angle, B: Angle, R: Distance, L0: Angle, R0: Distance, delta: Distance) {
		// (41.4) p. 283
		const [sL, cL] = Base.sincos(L)
		const [sB, cB] = Base.sincos(B)
		return acos((R * cB * cL + L0 * cB * sL + R0 * sB) / delta)
	}

	// Computes an approximation of the illumanted fraction of Venus.
	export function fractionVenus(jde: number) {
		const T = Base.j2000Century(jde)
		const V = 261.51 * DEG2RAD + 22518.443 * DEG2RAD * T
		const M = 177.53 * DEG2RAD + 35999.05 * DEG2RAD * T
		const N = 50.42 * DEG2RAD + 58517.811 * DEG2RAD * T
		const W = V + (1.91 * DEG2RAD * sin(M) + 0.78 * DEG2RAD * sin(N))
		const delta = sqrt(1.52321 + 1.44666 * cos(W))
		const s = 0.72333 + delta
		return (s * s - 1) / 2.89332 / delta
	}

	// Computes the visual magnitude of Mercury. Formula by G. Müller.
	// r is the planet's distance from the Sun, delta the distance from Earth, and i the phase angle in radians.
	export function mercury(r: Distance, delta: Distance, i: Angle) {
		const s = toDeg(i) - 50
		return 1.16 + 5 * log10(r * delta) + (0.02838 + 0.0001023 * s) * s
	}

	// Computes the visual magnitude of Venus. Formula by G. Müller.
	// r is the planet's distance from the Sun, delta the distance from Earth, and i the phase angle in radians.
	export function venus(r: Distance, delta: Distance, i: Angle) {
		const id = toDeg(i)
		return -4 + 5 * log10(r * delta) + (0.01322 + 0.0000004247 * id * id) * id
	}

	// Computes the visual magnitude of Mars. Formula by G. Müller.
	// r is the planet's distance from the Sun, delta the distance from Earth, and i the phase angle in radians.
	export function mars(r: Distance, delta: Distance, i: Angle) {
		return -1.3 + 5 * log10(r * delta) + 0.01486 * toDeg(i)
	}

	// Computes the visual magnitude of Jupiter. Formula by G. Müller. Effect of phase not considered.
	// r is the planet's distance from the Sun, delta the distance from Earth.
	export function jupiter(r: Distance, delta: Distance) {
		return -8.93 + 5 * log10(r * delta)
	}

	// Computes the visual magnitude of Saturn. Formula by G. Müller.
	// Sun's altitude above the plane of the ring is not considered.
	// r is the planet's distance from the Sun, delta the distance from Earth.
	// B is the Saturnicentric latitude of the Earth referred to the plane of Saturn's ring.
	// deltaU is the difference between the Saturnicentric longitudes of the Sun and the Earth, measured in the plane of the ring.
	// You can use SaturnSisk.Disk to obtain B and deltaU.
	export function saturn(r: Distance, delta: Distance, B: Angle, deltaU: Angle) {
		const s = sin(abs(B))
		return -8.68 + 5 * log10(r * delta) + 0.044 * abs(toDeg(deltaU)) - 2.6 * s + 1.25 * s * s
	}

	// Computes the visual magnitude of Uranus. Formula by G. Müller.
	// r is the planet's distance from the Sun, delta the distance from Earth.
	export function uranus(r: Distance, delta: Distance) {
		return -6.85 + 5 * log10(r * delta)
	}

	// Computes the visual magnitude of Neptune. Formulae by G. Müller.
	// r is the planet's distance from the Sun, delta the distance from Earth.
	export function neptune(r: Distance, delta: Distance) {
		return -7.05 + 5 * log10(r * delta)
	}

	// Computes the visual magnitude of Mercury.
	// The formula is that adopted in "Astronomical Almanac" in 1984.0
	// r is the planet's distance from the Sun, delta the distance from Earth, and i the phase angle in radians.
	export function mercury84(r: Distance, delta: Distance, i: Angle) {
		return Base.horner(toDeg(i), [-0.42 + 5 * log10(r * delta), 0.038, -0.000273, 0.000002])
	}

	// Computes the visual magnitude of Venus.
	// The formula is that adopted in "Astronomical Almanac" in 1984.0
	// r is the planet's distance from the Sun, delta the distance from Earth, and i the phase angle in radians.
	export function venus84(r: Distance, delta: Distance, i: Angle) {
		return Base.horner(toDeg(i), [-4.4 + 5 * log10(r * delta), 0.0009, 0.000239, -0.00000065])
	}

	// Computes the visual magnitude of Mars.
	// The formula is that adopted in "Astronomical Almanac" in 1984.0
	// r is the planet's distance from the Sun, delta the distance from Earth, and i the phase angle in radians.
	export function mars84(r: Distance, delta: Distance, i: Angle) {
		return -1.52 + 5 * log10(r * delta) + 0.016 * toDeg(i)
	}

	// Computes the visual magnitude of Jupiter.
	// The formula is that adopted in "Astronomical Almanac" in 1984.0
	// r is the planet's distance from the Sun, delta the distance from Earth, and i the phase angle in radians.
	export function jupiter84(r: Distance, delta: Distance, i: Angle) {
		return -9.4 + 5 * log10(r * delta) + 0.005 * toDeg(i)
	}

	// Computes the visual magnitude of Saturn.
	// The formula is that adopted in "Astronomical Almanac" in 1984.0
	// r is the planet's distance from the Sun, delta the distance from Earth.
	// B is the Saturnicentric latitude of the Earth referred to the plane of Saturn's ring.
	// deltaU is the difference between the Saturnicentric longitudes
	// of the Sun and the Earth, measured in the plane of the ring.
	export function saturn84(r: Distance, delta: Distance, B: Angle, deltaU: Angle) {
		const s = sin(abs(B))
		return -8.88 + 5 * log10(r * delta) + 0.044 * abs(toDeg(deltaU)) - 2.6 * s + 1.25 * s * s
	}

	// Computes the visual magnitude of Uranus.
	// The formula is that adopted in "Astronomical Almanac" in 1984.0
	// r is the planet's distance from the Sun, delta the distance from Earth.
	export function uranus84(r: Distance, delta: Distance) {
		return -7.19 + 5 * log10(r * delta)
	}

	// Computes the visual magnitude of Neptune.
	// The formula is that adopted in "Astronomical Almanac" in 1984.0
	// r is the planet's distance from the Sun, delta the distance from Earth.
	export function neptune84(r: Distance, delta: Distance) {
		return -6.87 + 5 * log10(r * delta)
	}

	// Computes the visual magnitude of Pluto.
	// The formula is that adopted in "Astronomical Almanac" in 1984.0
	// r is the planet's distance from the Sun, delta the distance from Earth.
	export function pluto84(r: Distance, delta: Distance) {
		return -1 + 5 * log10(r * delta)
	}
}

// Chapter 47, Position of the Moon.
export namespace MoonPosition {
	// Computes the equatorial horizontal parallax of the Moon.
	export function parallax(distance: Distance): Angle {
		// p. 337
		return asin(EARTH_RADIUS / distance)
	}

	function dmf(T: number) {
		const d = Base.horner(T, [297.8501921 * DEG2RAD, 445267.1114034 * DEG2RAD, -0.0018819 * DEG2RAD, DEG2RAD / 545868, -DEG2RAD / 113065000])
		const m = Base.horner(T, [357.5291092 * DEG2RAD, 35999.0502909 * DEG2RAD, -0.0001536 * DEG2RAD, DEG2RAD / 24490000])
		const m_ = Base.horner(T, [134.9633964 * DEG2RAD, 477198.8675055 * DEG2RAD, 0.0087414 * DEG2RAD, DEG2RAD / 69699, -DEG2RAD / 14712000])
		const f = Base.horner(T, [93.272095 * DEG2RAD, 483202.0175233 * DEG2RAD, -0.0036539 * DEG2RAD, -DEG2RAD / 3526000, DEG2RAD / 863310000])
		return [d, m, m_, f]
	}

	// Computes the geocentric location of the Moon, referenced to mean equinox of date and do not include the effect of nutation.
	export function position(jde: number) {
		const T = Base.j2000Century(jde)
		const l_ = Base.horner(T, [218.3164477 * DEG2RAD, 481267.88123421 * DEG2RAD, -0.0015786 * DEG2RAD, DEG2RAD / 538841, -DEG2RAD / 65194000])
		const [d, m, m_, f] = dmf(T)
		const a1 = 119.75 * DEG2RAD + 131.849 * DEG2RAD * T
		const a2 = 53.09 * DEG2RAD + 479264.29 * DEG2RAD * T
		const a3 = 313.45 * DEG2RAD + 481266.484 * DEG2RAD * T
		const e = Base.horner(T, [1, -0.002516, -0.0000074])
		const e2 = e * e

		let sigmal = 3958 * sin(a1) + 1962 * sin(l_ - f) + 318 * sin(a2)
		let sigmar = 0
		let sigmab = -2235 * sin(l_) + 382 * sin(a3) + 175 * sin(a1 - f) + 175 * sin(a1 + f) + 127 * sin(l_ - m_) - 115 * sin(l_ + m_)

		for (const r of TA) {
			const [sina, cosa] = Base.sincos(d * r[0] + m * r[1] + m_ * r[2] + f * r[3])

			switch (r[1]) {
				case 0:
					sigmal += r[4] * sina
					sigmar += r[5] * cosa
					break
				case -1:
				case 1:
					sigmal += r[4] * sina * e
					sigmar += r[5] * cosa * e
					break
				default:
					sigmal += r[4] * sina * e2
					sigmar += r[5] * cosa * e2
					break
			}
		}

		for (const r of TB) {
			const sb = sin(d * r[0] + m * r[1] + m_ * r[2] + f * r[3])

			switch (r[1]) {
				case 0:
					sigmab += r[4] * sb
					break
				case -1:
				case 1:
					sigmab += r[4] * sb * e
					break
				default:
					sigmab += r[4] * sb * e2
					break
			}
		}

		const lon = normalizeAngle(l_) + sigmal * (1e-6 * DEG2RAD)
		const lat = sigmab * (1e-6 * DEG2RAD)
		const range = 385000.56 / AU_KM + sigmar * (1e-3 / AU_KM)
		return [lon, lat, range] as const
	}

	const TA = [
		// d, m, m_, f, sigmal, sigmar
		[0, 0, 1, 0, 6288774, -20905355],
		[2, 0, -1, 0, 1274027, -3699111],
		[2, 0, 0, 0, 658314, -2955968],
		[0, 0, 2, 0, 213618, -569925],

		[0, 1, 0, 0, -185116, 48888],
		[0, 0, 0, 2, -114332, -3149],
		[2, 0, -2, 0, 58793, 246158],
		[2, -1, -1, 0, 57066, -152138],

		[2, 0, 1, 0, 53322, -170733],
		[2, -1, 0, 0, 45758, -204586],
		[0, 1, -1, 0, -40923, -129620],
		[1, 0, 0, 0, -34720, 108743],

		[0, 1, 1, 0, -30383, 104755],
		[2, 0, 0, -2, 15327, 10321],
		[0, 0, 1, 2, -12528, 0],
		[0, 0, 1, -2, 10980, 79661],

		[4, 0, -1, 0, 10675, -34782],
		[0, 0, 3, 0, 10034, -23210],
		[4, 0, -2, 0, 8548, -21636],
		[2, 1, -1, 0, -7888, 24208],

		[2, 1, 0, 0, -6766, 30824],
		[1, 0, -1, 0, -5163, -8379],
		[1, 1, 0, 0, 4987, -16675],
		[2, -1, 1, 0, 4036, -12831],

		[2, 0, 2, 0, 3994, -10445],
		[4, 0, 0, 0, 3861, -11650],
		[2, 0, -3, 0, 3665, 14403],
		[0, 1, -2, 0, -2689, -7003],

		[2, 0, -1, 2, -2602, 0],
		[2, -1, -2, 0, 2390, 10056],
		[1, 0, 1, 0, -2348, 6322],
		[2, -2, 0, 0, 2236, -9884],

		[0, 1, 2, 0, -2120, 5751],
		[0, 2, 0, 0, -2069, 0],
		[2, -2, -1, 0, 2048, -4950],
		[2, 0, 1, -2, -1773, 4130],

		[2, 0, 0, 2, -1595, 0],
		[4, -1, -1, 0, 1215, -3958],
		[0, 0, 2, 2, -1110, 0],
		[3, 0, -1, 0, -892, 3258],

		[2, 1, 1, 0, -810, 2616],
		[4, -1, -2, 0, 759, -1897],
		[0, 2, -1, 0, -713, -2117],
		[2, 2, -1, 0, -700, 2354],

		[2, 1, -2, 0, 691, 0],
		[2, -1, 0, -2, 596, 0],
		[4, 0, 1, 0, 549, -1423],
		[0, 0, 4, 0, 537, -1117],

		[4, -1, 0, 0, 520, -1571],
		[1, 0, -2, 0, -487, -1739],
		[2, 1, 0, -2, -399, 0],
		[0, 0, 2, -2, -381, -4421],

		[1, 1, 1, 0, 351, 0],
		[3, 0, -2, 0, -340, 0],
		[4, 0, -3, 0, 330, 0],
		[2, -1, 2, 0, 327, 0],

		[0, 2, 1, 0, -323, 1165],
		[1, 1, -1, 0, 299, 0],
		[2, 0, 3, 0, 294, 0],
		[2, 0, -1, -2, 0, 8752],
	] as const

	const TB = [
		[0, 0, 0, 1, 5128122],
		[0, 0, 1, 1, 280602],
		[0, 0, 1, -1, 277693],
		[2, 0, 0, -1, 173237],

		[2, 0, -1, 1, 55413],
		[2, 0, -1, -1, 46271],
		[2, 0, 0, 1, 32573],
		[0, 0, 2, 1, 17198],

		[2, 0, 1, -1, 9266],
		[0, 0, 2, -1, 8822],
		[2, -1, 0, -1, 8216],
		[2, 0, -2, -1, 4324],

		[2, 0, 1, 1, 4200],
		[2, 1, 0, -1, -3359],
		[2, -1, -1, 1, 2463],
		[2, -1, 0, 1, 2211],

		[2, -1, -1, -1, 2065],
		[0, 1, -1, -1, -1870],
		[4, 0, -1, -1, 1828],
		[0, 1, 0, 1, -1794],

		[0, 0, 0, 3, -1749],
		[0, 1, -1, 1, -1565],
		[1, 0, 0, 1, -1491],
		[0, 1, 1, 1, -1475],

		[0, 1, 1, -1, -1410],
		[0, 1, 0, -1, -1344],
		[1, 0, 0, -1, -1335],
		[0, 0, 3, 1, 1107],

		[4, 0, 0, -1, 1021],
		[4, 0, -1, 1, 833],

		[0, 0, 1, -3, 777],
		[4, 0, -2, 1, 671],
		[2, 0, 0, -3, 607],
		[2, 0, 2, -1, 596],

		[2, -1, 1, -1, 491],
		[2, 0, -2, 1, -451],
		[0, 0, 3, -1, 439],
		[2, 0, 2, 1, 422],

		[2, 0, -3, -1, 421],
		[2, 1, -1, 1, -366],
		[2, 1, 0, 1, -351],
		[4, 0, 0, 1, 331],

		[2, -1, 1, 1, 315],
		[2, -2, 0, -1, 302],
		[0, 0, 1, 3, -283],
		[2, 1, 1, -1, -229],

		[1, 1, 0, -1, 223],
		[1, 1, 0, 1, 223],
		[0, 1, -2, -1, -220],
		[2, 1, -1, -1, -220],

		[1, 0, 1, 1, -185],
		[2, -1, -2, -1, 181],
		[0, 1, 2, 1, -177],
		[4, 0, -2, -1, 176],

		[4, -1, -1, -1, 166],
		[1, 0, 1, -1, -164],
		[4, 0, 1, -1, 132],
		[1, 0, -1, -1, -119],

		[4, -1, 0, -1, 115],
		[2, -2, 0, 1, 107],
	] as const

	// Computes the longitude of the mean ascending node of the lunar orbit.
	export function node(jde: number) {
		return normalizeAngle(Base.horner(Base.j2000Century(jde), [125.0445479 * DEG2RAD, -1934.1362891 * DEG2RAD, 0.0020754 * DEG2RAD, DEG2RAD / 467441, -DEG2RAD / 60616000]))
	}

	// Computes the longitude of perigee of the lunar orbit.
	export function perigee(jde: number) {
		return normalizeAngle(Base.horner(Base.j2000Century(jde), [83.3532465 * DEG2RAD, 4069.0137287 * DEG2RAD, -0.01032 * DEG2RAD, -DEG2RAD / 80053, DEG2RAD / 18999000]))
	}

	// Computes the longitude of the true ascending node. That is, the node of the instantaneous lunar orbit.
	export function trueNode(jde: number) {
		const [d, m, m_, f] = dmf(Base.j2000Century(jde))
		return node(jde) + -1.4979 * DEG2RAD * sin(2 * (d - f)) + -0.15 * DEG2RAD * sin(m) + -0.1226 * DEG2RAD * sin(2 * d) + 0.1176 * DEG2RAD * sin(2 * f) + -0.0801 * DEG2RAD * sin(2 * (m_ - f))
	}
}

// Chapter 50, Perigee and apogee of the Moon
export namespace Apsis {
	// Conversion factor from k to T, given in (50.3) p. 356
	const CK = 1 / 1325.55

	// Computes mean time of perigee or apogee
	export function mean(T: number) {
		return Base.horner(T, [2451534.6698, 27.55454989 / CK, -0.0006691, -0.000001098, 0.0000000052])
	}

	// Returns k at half h nearest year y.
	export function snap(y: number, h: number) {
		const k = (y - 1999.97) * 13.2555 // (50.2) p. 355
		return floor(k - h + 0.5) + h
	}

	// Computes the jde of the mean perigee of the Moon nearest the given date.
	export function meanPerigee(year: number) {
		return mean(snap(year, 0) * CK)
	}

	// Computes the jde of perigee of the Moon nearest the given date.
	export function perigee(year: number) {
		const [T, D, M, F] = tdmf(year, 0)

		const corr =
			-1.6769 * sin(2 * D) +
			0.4589 * sin(4 * D) +
			-0.1856 * sin(6 * D) +
			0.0883 * sin(8 * D) +
			(-0.0773 + 0.00019 * T) * sin(2 * D - M) +
			(0.0502 - 0.00013 * T) * sin(M) +
			-0.046 * sin(10 * D) +
			(0.0422 - 0.00011 * T) * sin(4 * D - M) +
			-0.0256 * sin(6 * D - M) +
			0.0253 * sin(12 * D) +
			0.0237 * sin(D) +
			0.0162 * sin(8 * D - M) +
			-0.0145 * sin(14 * D) +
			0.0129 * sin(2 * F) +
			-0.0112 * sin(3 * D) +
			-0.0104 * sin(10 * D - M) +
			0.0086 * sin(16 * D) +
			0.0069 * sin(12 * D - M) +
			0.0066 * sin(5 * D) +
			-0.0053 * sin(2 * (D + F)) +
			-0.0052 * sin(18 * D) +
			-0.0046 * sin(14 * D - M) +
			-0.0041 * sin(7 * D) +
			0.004 * sin(2 * D + M) +
			0.0032 * sin(20 * D) +
			-0.0032 * sin(D + M) +
			0.0031 * sin(16 * D - M) +
			-0.0029 * sin(4 * D + M) +
			0.0027 * sin(9 * D) +
			0.0027 * sin(4 * D + 2 * F) +
			-0.0027 * sin(2 * (D - M)) +
			0.0024 * sin(4 * D - 2 * M) +
			-0.0021 * sin(6 * D - 2 * M) +
			-0.0021 * sin(22 * D) +
			-0.0021 * sin(18 * D - M) +
			0.0019 * sin(6 * D + M) +
			-0.0018 * sin(11 * D) +
			-0.0014 * sin(8 * D + M) +
			-0.0014 * sin(4 * D - 2 * F) +
			-0.0014 * sin(6 * D + 2 * F) +
			0.0014 * sin(3 * D + M) +
			-0.0014 * sin(5 * D + M) +
			0.0013 * sin(13 * D) +
			0.0013 * sin(20 * D - M) +
			0.0011 * sin(3 * D + 2 * M) +
			-0.0011 * sin(2 * (2 * D + F - M)) +
			-0.001 * sin(D + 2 * M) +
			-0.0009 * sin(22 * D - M) +
			-0.0008 * sin(4 * F) +
			0.0008 * sin(6 * D - 2 * F) +
			0.0008 * sin(2 * (D - F) + M) +
			0.0007 * sin(2 * M) +
			0.0007 * sin(2 * F - M) +
			0.0007 * sin(2 * D + 4 * F) +
			-0.0006 * sin(2 * (F - M)) +
			-0.0006 * sin(2 * (D - F + M)) +
			0.0006 * sin(24 * D) +
			0.0005 * sin(4 * (D - F)) +
			0.0005 * sin(2 * (D + M)) +
			-0.0004 * sin(D - M)

		return mean(T) + corr
	}

	// Computes the jde of the mean apogee of the Moon nearest the given date.
	export function meanApogee(year: number) {
		return mean(snap(year, 0.5) * CK)
	}

	// Computes the jde of apogee of the Moon nearest the given date.
	export function apogee(year: number) {
		const [T, D, M, F] = tdmf(year, 0.5)

		const corr =
			0.4392 * sin(2 * D) +
			0.0684 * sin(4 * D) +
			(0.0456 - 0.00011 * T) * sin(M) +
			(0.0426 - 0.00011 * T) * sin(2 * D - M) +
			0.0212 * sin(2 * F) +
			-0.0189 * sin(D) +
			0.0144 * sin(6 * D) +
			0.0113 * sin(4 * D - M) +
			0.0047 * sin(2 * (D + F)) +
			0.0036 * sin(D + M) +
			0.0035 * sin(8 * D) +
			0.0034 * sin(6 * D - M) +
			-0.0034 * sin(2 * (D - F)) +
			0.0022 * sin(2 * (D - M)) +
			-0.0017 * sin(3 * D) +
			0.0013 * sin(4 * D + 2 * F) +
			0.0011 * sin(8 * D - M) +
			0.001 * sin(4 * D - 2 * M) +
			0.0009 * sin(10 * D) +
			0.0007 * sin(3 * D + M) +
			0.0006 * sin(2 * M) +
			0.0005 * sin(2 * D + M) +
			0.0005 * sin(2 * (D + M)) +
			0.0004 * sin(6 * D + 2 * F) +
			0.0004 * sin(6 * D - 2 * M) +
			0.0004 * sin(10 * D - M) +
			-0.0004 * sin(5 * D) +
			-0.0004 * sin(4 * D - 2 * F) +
			0.0003 * sin(2 * F + M) +
			0.0003 * sin(12 * D) +
			0.0003 * sin(2 * D + 2 * F - M) +
			-0.0003 * sin(D - M)

		return mean(T) + corr
	}

	// Computes equatorial horizontal parallax of the Moon at the Apogee nearest the given date.
	export function apogeeParallax(year: number) {
		const [T, D, M, F] = tdmf(year, 0.5)

		return (
			3245.251 * ASEC2RAD +
			-9.147 * ASEC2RAD * cos(2 * D) +
			-0.841 * ASEC2RAD * cos(D) +
			0.697 * ASEC2RAD * cos(2 * F) +
			(-0.656 * ASEC2RAD + 0.0016 * ASEC2RAD * T) * cos(M) +
			0.355 * ASEC2RAD * cos(4 * D) +
			0.159 * ASEC2RAD * cos(2 * D - M) +
			0.127 * ASEC2RAD * cos(D + M) +
			0.065 * ASEC2RAD * cos(4 * D - M) +
			0.052 * ASEC2RAD * cos(6 * D) +
			0.043 * ASEC2RAD * cos(2 * D + M) +
			0.031 * ASEC2RAD * cos(2 * (D + F)) +
			-0.023 * ASEC2RAD * cos(2 * (D - F)) +
			0.022 * ASEC2RAD * cos(2 * (D - M)) +
			0.019 * ASEC2RAD * cos(2 * (D + M)) +
			-0.016 * ASEC2RAD * cos(2 * M) +
			0.014 * ASEC2RAD * cos(6 * D - M) +
			0.01 * ASEC2RAD * cos(8 * D)
		)
	}

	// Computes equatorial horizontal parallax of the Moon at the Apogee nearest the given date.
	export function perigeeParallax(year: number) {
		const [T, D, M, F] = tdmf(year, 0)

		return (
			3629.215 * ASEC2RAD +
			63.224 * ASEC2RAD * cos(2 * D) +
			-6.99 * ASEC2RAD * cos(4 * D) +
			(2.834 * ASEC2RAD - 0.0071 * T * ASEC2RAD) * cos(2 * D - M) +
			1.927 * ASEC2RAD * cos(6 * D) +
			-1.263 * ASEC2RAD * cos(D) +
			-0.702 * ASEC2RAD * cos(8 * D) +
			(0.696 * ASEC2RAD - 0.0017 * T * ASEC2RAD) * cos(M) +
			-0.69 * ASEC2RAD * cos(2 * F) +
			(-0.629 * ASEC2RAD + 0.0016 * T * ASEC2RAD) * cos(4 * D - M) +
			-0.392 * ASEC2RAD * cos(2 * (D - F)) +
			0.297 * ASEC2RAD * cos(10 * D) +
			0.26 * ASEC2RAD * cos(6 * D - M) +
			0.201 * ASEC2RAD * cos(3 * D) +
			-0.161 * ASEC2RAD * cos(2 * D + M) +
			0.157 * ASEC2RAD * cos(D + M) +
			-0.138 * ASEC2RAD * cos(12 * D) +
			-0.127 * ASEC2RAD * cos(8 * D - M) +
			0.104 * ASEC2RAD * cos(2 * (D + F)) +
			0.104 * ASEC2RAD * cos(2 * (D - M)) +
			-0.079 * ASEC2RAD * cos(5 * D) +
			0.068 * ASEC2RAD * cos(14 * D) +
			0.067 * ASEC2RAD * cos(10 * D - M) +
			0.054 * ASEC2RAD * cos(4 * D + M) +
			-0.038 * ASEC2RAD * cos(12 * D - M) +
			-0.038 * ASEC2RAD * cos(4 * D - 2 * M) +
			0.037 * ASEC2RAD * cos(7 * D) +
			-0.037 * ASEC2RAD * cos(4 * D + 2 * F) +
			-0.035 * ASEC2RAD * cos(16 * D) +
			-0.03 * ASEC2RAD * cos(3 * D + M) +
			0.029 * ASEC2RAD * cos(D - M) +
			-0.025 * ASEC2RAD * cos(6 * D + M) +
			0.023 * ASEC2RAD * cos(2 * M) +
			0.023 * ASEC2RAD * cos(14 * D - M) +
			-0.023 * ASEC2RAD * cos(2 * (D + M)) +
			0.022 * ASEC2RAD * cos(6 * D - 2 * M) +
			-0.021 * ASEC2RAD * cos(2 * D - 2 * F - M) +
			-0.02 * ASEC2RAD * cos(9 * D) +
			0.019 * ASEC2RAD * cos(18 * D) +
			0.017 * ASEC2RAD * cos(6 * D + 2 * F) +
			0.014 * ASEC2RAD * cos(2 * F - M) +
			-0.014 * ASEC2RAD * cos(16 * D - M) +
			0.013 * ASEC2RAD * cos(4 * D - 2 * F) +
			0.012 * ASEC2RAD * cos(8 * D + M) +
			0.011 * ASEC2RAD * cos(11 * D) +
			0.01 * ASEC2RAD * cos(5 * D + M) +
			-0.01 * ASEC2RAD * cos(20 * D)
		)
	}

	// Computes the distance earth - moon (center to center) using the parallax angle in radians
	export function distance(parallax: Angle): Distance {
		return EARTH_RADIUS / sin(parallax)
	}

	function tdmf(year: number, h: number) {
		const k = snap(year, h)
		const T = k * CK // (50.3) p. 350
		const D = Base.horner(T, [171.9179 * DEG2RAD, (335.9106046 * DEG2RAD) / CK, -0.0100383 * DEG2RAD, -0.00001156 * DEG2RAD, 0.000000055 * DEG2RAD])
		const M = Base.horner(T, [347.3477 * DEG2RAD, (27.1577721 * DEG2RAD) / CK, -0.000813 * DEG2RAD, -0.000001 * DEG2RAD])
		const F = Base.horner(T, [316.6109 * DEG2RAD, (364.5287911 * DEG2RAD) / CK, -0.0125053 * DEG2RAD, -0.0000148 * DEG2RAD])
		return [T, D, M, F] as const
	}
}

// Chapter 56, Stellar Magnitudes.
export namespace Stellar {
	// Computes the combined apparent magnitude of two stars.
	export function sum(m1: number, m2: number) {
		const x = 0.4 * (m2 - m1)
		return m2 - 2.5 * log10(10 ** x + 1)
	}

	// Computes the combined apparent magnitude of a number of stars.
	export function sumN(m: readonly number[]) {
		let s = 0
		for (const mi of m) s += 10 ** (-0.4 * mi)
		return -2.5 * log10(s)
	}

	// Computes the brightness ratio of two apparent magnitudes.
	export function ratio(m1: number, m2: number) {
		const x = 0.4 * (m2 - m1)
		return 10 ** x
	}

	// Computes the difference in apparent magnitude of two stars given their brightness ratio.
	export function difference(ratio: number) {
		return 2.5 * log10(ratio)
	}

	// Computes absolute magnitude given apparent magnitude, and annual parallax in arc seconds.
	export function absoluteByParallax(m: number, pi: number) {
		return m + 5 + 5 * log10(pi)
	}

	// Computes absolute magnitude given apparent magnitude, and distance in parsecs.
	export function absoluteByDistance(m: number, d: number) {
		return m + 5 - 5 * log10(d)
	}
}

// Chapter 57, Binary Stars
export namespace BinaryStars {
	// Computes mean anomaly for the given decimal year, time of periastron (decimal year) and period of revolution in mean solar years.
	export function meanAnomaly(year: number, T: number, P: number): Angle {
		return normalizeAngle((TAU / P) * (year - T))
	}

	// Computes apparent position angle and angular distance of components of a binary star.
	export function position(a: Angle, e: number, i: Angle, ascendingNode: Angle, periastron: Angle, E: Angle) {
		const r = a * (1 - e * cos(E))
		const nu = 2 * atan(sqrt((1 + e) / (1 - e)) * tan(E / 2))
		const [sinNuOmega, cosNuOmega] = Base.sincos(nu + periastron)
		const cosi = cos(i)
		const num = sinNuOmega * cosi
		let theta = atan2(num, cosNuOmega) + ascendingNode
		if (theta < 0) theta += 2 * PI
		const rho = r * sqrt(num * num + cosNuOmega * cosNuOmega)
		return [theta, rho] as const
	}

	// Computes the apparent eccenticity of a binary star given true orbital elements.
	export function apparentEccentricity(e: number, i: Angle, omega: Angle) {
		const cosi = cos(i)
		const [sinOmega, cosOmega] = Base.sincos(omega)
		const A = (1 - e * e * cosOmega * cosOmega) * cosi * cosi
		const B = e * e * sinOmega * cosOmega * cosi
		const C = 1 - e * e * sinOmega * sinOmega
		const d = A - C
		const sqrtD = sqrt(d * d + 4 * B * B)
		return sqrt((2 * sqrtD) / (A + C + sqrtD))
	}
}
