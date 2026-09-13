import { ASEC2RAD, AU_KM, DAYSEC, DEG2RAD, PI, PIOVERFOUR, PIOVERTWO, TAU } from '../../core/constants'
import type { Vec3 } from '../../math/linear-algebra/vec3'
import type { Point } from '../../math/numerical/geometry'
import { floorDiv, modf, pmod, type NumberArray } from '../../math/numerical/math'
import { brentMinimize } from '../../math/numerical/optimization'
import { normalizeAngle, secondsOfTime, toDeg, type Angle } from '../../math/units/angle'
import type { Distance } from '../../math/units/distance'
import { moonMeanAscendingNode } from '../bodies/moon'
import { deltaT as calculateDeltaT } from '../time/deltat'
import { time, Timescale } from '../time/time'
import * as vsop87e from './models/analytical/vsop87e'

// Port of Meeus-based algorithms, grouped into namespaces mirroring the source chapters. Angles are radians, distances AU.

const { sin, cos, tan, asin, acos, atan, atan2, sinh, asinh, sqrt, cbrt, hypot, log10, abs, trunc, floor, min, max, round, SQRT2 } = Math

// https://github.com/commenthol/astronomia/blob/master/src/

export type Coord = readonly [Angle, Angle, Distance?]

export const EARTH_RADIUS_KM = 6378.137 // km
export const EARTH_RADIUS = EARTH_RADIUS_KM / AU_KM // au

export const MOON_RADIUS_KM = 1738.1 // km
export const MOON_RADIUS = MOON_RADIUS_KM / AU_KM // au

const MEEUS_VSOP87_FRAME = 'eclipticJ2000'

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
	export const COS_SMALL_ANGLE = cos(SMALL_ANGLE)

	// Sine obliquity at J2000.
	export const SIN_OBL_J2000 = 0.397777156
	// Cosine obliquity at J2000.
	export const COS_OBL_J2000 = 0.917482062

	// Computes the light travel time, in days, for a distance in AU.
	export function lightTime(dist: Distance) {
		// Formula given as (33.3) p. 224.
		return 0.0057755183 * dist
	}

	// Computes the illuminated fraction (0..1) of a body's disk from the phase angle `i` (radians).
	export function illuminated(i: Angle) {
		// (41.1) p. 283, also (48.1) p. 345.
		return (1 + cos(i)) * 0.5
	}

	// Computes the position angle (radians, 0..TAU) of the midpoint of a body's illuminated limb.
	// `bra`/`bdec` are the body's right ascension/declination and `sra`/`sdec` the Sun's, all radians.
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

// Chapter 3: Interpolation.
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
			if (this.y[1] === 0) return 0.5 * this.xSum
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

	// Iterates f from dimensionless n0 for at most 50 steps; returns [value, converged]. Accepts
	// exact fixed points (including zero), otherwise uses 1e-15 relative convergence; failure is [0, false].
	export function iterate(n0: number, f: (n0: number) => number) {
		for (let limit = 0; limit < 50; limit++) {
			const n1 = f(n0)

			if (!Number.isFinite(n1) || Number.isNaN(n1)) break
			if (n1 === n0 || abs((n1 - n0) / n0) < 1e-15) return [n1, true] as const

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
			if (this.y3 === 0) return 0.5 * this.xSum
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

		const x01 = x1 + nearestX * interval
		return y[nearestX] + ((y[nearestX + 1] - y[nearestX]) * (x - x01)) / interval
	}
}

// Chapter 4: Curve Fitting.
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

// Chapter 5: Iteration.
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
			if (n === start || abs((n - start) / n) < 1e-15) return n
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

// Chapter 7: Julian days, mutable astronomical calendars, and modeled UT1/TT conversions.
export namespace Julian {
	// 1582-10-05 Julian Date is 1st Gregorian Date (1582-10-15)
	export const GREGORIAN0JD = 2299160.5

	// Days preceding each month in a common year, indexed by one-based month.
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
		const z = floor(jd + 0.5)
		const f = jd + 0.5 - z
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
		return pmod(floor(jd + 1.5), 7)
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
		if (leap && m > 2) k = 1
		return k + DAYS_OF_YEAR[m] + trunc(d)
	}

	// Returns month and fractional day for ordinal n in [1, 366) or [1, 367) if leap.
	// The ordinal is one-based; leap's extra day belongs after February 28.
	export function dayOfYearToCalendar(n: number, leap: boolean): { month: number; day: number } {
		let month = 12
		while (month > 1 && floor(n) <= DAYS_OF_YEAR[month] + (leap && month > 2 ? 1 : 0)) month--
		return { month, day: n - DAYS_OF_YEAR[month] - (leap && month > 2 ? 1 : 0) }
	}

	// A delta-T model takes a decimal calendar year and returns TT - UT1 in seconds.
	export type DeltaTProvider = (decimalYear: number) => number

	// Active model for Meeus calendar conversions; defaults to the project's historical S15 fit.
	let deltaTProvider: DeltaTProvider = calculateDeltaT

	// Returns TT - UT1 in seconds at decimalYear using the configured model.
	export function deltaTSeconds(decimalYear: number) {
		return deltaTProvider(decimalYear)
	}

	// Changes the model used by subsequent calendar/event conversions; undefined restores the default.
	export function setDeltaTProvider(provider?: DeltaTProvider) {
		deltaTProvider = provider ?? calculateDeltaT
	}

	// Calendar labels with astronomical year numbering (year zero is 1 BCE).
	export interface CalendarDate {
		// Integer astronomical year.
		year: number
		// Month in 1..12.
		month: number
		// Integer day of month in 1..31.
		day: number
	}

	// Time within a uniform 86400-second day, without leap-second labels.
	export interface CalendarTime {
		// Hour in 0..23.
		hour: number
		// Minute in 0..59.
		minute: number
		// Second in 0..59.
		second: number
		// Truncated fractional second in milliseconds, 0..999.
		millisecond: number
	}

	// Mutable Meeus calendar with the Julian/Gregorian reform at 1582-10-15.
	// Dates use astronomical years and fractional days. The reform gap is not a valid mixed-calendar
	// input. JD methods interpret labels as UT1; JDE methods apply the configured delta-T model to TT.
	export class Calendar {
		// Astronomical integer year; zero denotes 1 BCE.
		year = 2000
		// Month in 1..12.
		month = 1
		// Day of month including its fraction of a uniform 86400-second day.
		day = 1

		// Initializes year/month/fractional day, defaulting to 2000-01-01; Date copies its UTC labels.
		constructor(year: number | Date = 2000, month: number = 1, day: number = 1) {
			if (year instanceof Date) this.fromDate(year)
			else {
				this.year = year
				this.month = month
				this.day = day
			}
		}

		// Returns a fresh object containing the calendar labels with the day fraction discarded.
		getDate(): CalendarDate {
			return { year: this.year, month: this.month, day: floor(this.day) }
		}

		// Returns a fresh time-of-day object, truncating submillisecond fractions.
		getTime(): CalendarTime {
			const seconds = pmod(this.day * DAYSEC, DAYSEC)
			const whole = floor(seconds)
			return { hour: floor(whole / 3600), minute: floor(whole / 60) % 60, second: whole % 60, millisecond: floor((seconds - whole) * 1000) }
		}

		// Formats these calendar labels, with truncated milliseconds and ISO extended years.
		// For Julian labels this is not a Gregorian UTC instant; use jdToDate(toJD()) for that conversion.
		toISOString() {
			const { hour, minute, second, millisecond } = this.getTime()
			const year = this.year >= 0 && this.year <= 9999 ? String(this.year).padStart(4, '0') : `${this.year < 0 ? '-' : '+'}${String(abs(this.year)).padStart(6, '0')}`
			return `${year}-${String(this.month).padStart(2, '0')}-${String(floor(this.day)).padStart(2, '0')}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}.${String(millisecond).padStart(3, '0')}Z`
		}

		// Reports whether these labels select the Gregorian side of the 1582 reform.
		isGregorian() {
			return isCalendarGregorian(this.year, this.month, this.day)
		}

		// Copies Date's proleptic Gregorian UTC labels and returns this; it does not convert to Julian labels.
		fromDate(date: Date) {
			this.year = date.getUTCFullYear()
			this.month = date.getUTCMonth() + 1
			this.day = date.getUTCDate() + (date.getUTCHours() * 3600 + date.getUTCMinutes() * 60 + date.getUTCSeconds() + date.getUTCMilliseconds() / 1000) / DAYSEC
			return this
		}

		// Returns a fresh Date interpreting these labels as proleptic Gregorian UTC, rounding milliseconds.
		// Use jdToDate(toJD()) to preserve the instant when these are Julian calendar labels.
		toDate() {
			const date = new Date(0)
			date.setUTCFullYear(this.year, this.month - 1, floor(this.day))
			date.setUTCHours(0, 0, 0, round((this.day - floor(this.day)) * DAYSEC * 1000))
			return date
		}

		// Returns a decimal astronomical year using the nominal 365/366-day calendar year.
		// The skipped reform dates remain included in this ordinal convention.
		toYear() {
			return this.year + (this.dayOfYear() - 1 + this.day - floor(this.day)) / (this.isLeapYear() ? 366 : 365)
		}

		// Replaces this with decimal year's calendar labels and returns this. Rounds the ordinal
		// offset to 1e-8 day (0.864 ms) to suppress cancellation at exact month boundaries.
		fromYear(year: number) {
			this.year = floor(year)
			this.month = 1
			this.day = 1
			const days = this.isLeapYear() ? 366 : 365
			const n = round((year - this.year) * days * 1e8) / 1e8 + 1
			if (n >= days + 1) {
				this.year++
				return this
			}
			const date = dayOfYearToCalendar(n, this.isLeapYear())
			this.month = date.month
			this.day = date.day
			return this
		}

		// Reports leap-year status under this calendar's rule.
		isLeapYear() {
			return this.isGregorian() ? isLeapYearGregorian(this.year) : isLeapYearJulian(this.year)
		}

		// Returns JD for these UT1 labels without modifying the calendar.
		toJD() {
			return calendarToJD(this.year, this.month, this.day, !this.isGregorian())
		}

		// Replaces this with the UT1 calendar labels at jd, normalizing month/year boundaries; returns this.
		fromJD(jd: number) {
			const [year, month, day] = jdToCalendar(jd, !isJDCalendarGregorian(jd))
			this.year = year
			this.month = month
			this.day = day
			return this
		}

		// Replaces this with UT1 labels for TT jde and returns this. Three fixed-point refinements
		// account for delta-T's epoch dependence; accuracy is limited by the chosen model and JD rounding.
		fromJDE(jde: number) {
			this.fromJD(jde)
			for (let i = 0; i < 3; i++) this.fromJD(jde - deltaTSeconds(this.toYear()) / DAYSEC)
			return this
		}

		// Returns TT JDE for these UT1 labels without mutating this, including across midnight.
		toJDE() {
			return this.toJD() + deltaTSeconds(this.toYear()) / DAYSEC
		}

		// Sets this to midnight of the same calendar day and returns this.
		midnight() {
			this.day = floor(this.day)
			return this
		}

		// Sets this to noon of the same calendar day and returns this.
		noon() {
			this.day = floor(this.day) + 0.5
			return this
		}

		// Converts these labels in place: td=true interprets them as TT and converts to UT1;
		// false (default) interprets them as UT1 and converts to TT. Returns this with normalized dates.
		deltaT(td: boolean = false) {
			return td ? this.fromJDE(this.toJD()) : this.fromJD(this.toJDE())
		}

		// Returns weekday 0..6 (Sunday..Saturday) for this calendar date.
		dayOfWeek() {
			return dayOfWeek(this.toJD())
		}

		// Returns the one-based nominal ordinal day, ignoring the fractional day and the reform gap.
		dayOfYear() {
			return dayOfYear(this.year, this.month, this.day, this.isLeapYear())
		}
	}

	// Mutable proleptic Julian calendar; all dates use the Julian leap-year and JD rules.
	export class CalendarJulian extends Calendar {
		// Always false: this calendar retains the Julian rule after the Gregorian reform.
		override isGregorian() {
			return false
		}

		// Replaces this with proleptic Julian labels at jd and returns this.
		override fromJD(jd: number) {
			const [year, month, day] = jdToCalendarJulian(jd)
			this.year = year
			this.month = month
			this.day = day
			return this
		}

		// Allocates Gregorian labels representing the same JD, preserving the day fraction.
		toGregorian() {
			return new CalendarGregorian().fromJD(this.toJD())
		}
	}

	// Mutable proleptic Gregorian calendar; all dates use Gregorian leap-year and JD rules.
	export class CalendarGregorian extends Calendar {
		// Always true: this calendar applies the Gregorian rule before the reform as well.
		override isGregorian() {
			return true
		}

		// Replaces this with proleptic Gregorian labels at jd and returns this.
		override fromJD(jd: number) {
			const [year, month, day] = jdToCalendarGregorian(jd)
			this.year = year
			this.month = month
			this.day = day
			return this
		}

		// Allocates Julian labels representing the same JD, preserving the day fraction.
		toJulian() {
			return new CalendarJulian().fromJD(this.toJD())
		}
	}

	// Converts JD to a fresh proleptic Gregorian Date, rounding to milliseconds; no time-scale correction.
	export function jdToDate(jd: number) {
		return new CalendarGregorian().fromJD(jd).toDate()
	}

	// Converts proleptic Gregorian Date labels to JD; no time-scale correction or input mutation.
	export function dateToJD(date: Date) {
		return new CalendarGregorian(date).toJD()
	}

	// Converts TT jde to a fresh Date whose labels represent modeled UT1 (not leap-second-based UTC).
	export function jdeToDate(jde: number) {
		return new CalendarGregorian().fromJDE(jde).toDate()
	}

	// Treats Date's UTC labels as UT1 and returns TT JDE using the configured delta-T model.
	// Use the time module for a leap-second-based UTC-to-TT conversion.
	export function dateToJDE(date: Date) {
		return new CalendarGregorian(date).toJDE()
	}

	// Allocates Gregorian labels from astronomical year and one-based ordinal n, including its day fraction.
	export function dayOfYearToCalendarGregorian(year: number, n: number) {
		const { month, day } = dayOfYearToCalendar(n, isLeapYearGregorian(year))
		return new CalendarGregorian(year, month, day)
	}

	// Allocates Julian labels from astronomical year and one-based ordinal n, including its day fraction.
	export function dayOfYearToCalendarJulian(year: number, n: number) {
		const { month, day } = dayOfYearToCalendar(n, isLeapYearJulian(year))
		return new CalendarJulian(year, month, day)
	}
}

// Chapter 8: Date of Easter
export namespace Easter {
	// Returns the gregorian date of the Christian Easter Sunday of a given year.
	export function gregorian(year: number) {
		year = trunc(year)
		const a = year % 19
		const b = trunc(year / 100)
		const c = year % 100
		const d = trunc(b / 4)
		const e = b % 4
		const f = trunc((b + 8) / 25)
		const g = trunc((b - f + 1) / 3)
		const h = (19 * a + b - d - g + 15) % 30
		const i = trunc(c / 4)
		const k = c % 4
		const l = (32 + 2 * e + 2 * i - h - k) % 7
		const m = trunc((a + 11 * h + 22 * l) / 451)
		const np = h + l - 7 * m + 114
		const n = trunc(np / 31)
		const p = np % 31
		return [year, n, p + 1] as const
	}

	// Returns the julian date of the Christian Easter Sunday of a given year.
	export function julian(year: number) {
		year = trunc(year)
		const a = year % 4
		const b = year % 7
		const c = year % 19
		const d = (19 * c + 15) % 30
		const e = (2 * a + 4 * b - d + 34) % 7
		const fg = d + e + 114
		const f = trunc(fg / 31)
		const g = fg % 31
		return [year, f, g + 1] as const
	}
}

// Chapter 11: The Earth's Globe.
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

		// Returns fresh dimensionless parallax constants rho sin phi' and rho cos phi' for geodetic
		// latitude phi (radians) and height h (AU) above this ellipsoid, whose radius is also in AU.
		parallaxConstants(phi: Angle, h: Distance) {
			const boa = 1 - this.#flat
			const u = atan(boa * tan(phi))
			const su = sin(u)
			const cu = cos(u)
			const sp = sin(phi)
			const cp = cos(phi)
			const hoa = h / this.#radius
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
			// The coincident-point limit is zero; the nonzero formula divides by s and omega.
			if (s === 0) return 0
			const c = c2g * c2Lambda + s2f * s2Lambda
			const omega = atan(sqrt(s / c))
			const r = sqrt(s * c) / omega
			const d = 2 * omega * this.#radius
			const h1 = (3 * r - 1) / (2 * c)
			const h2 = (3 * r + 1) / (2 * s)
			return d * (1 + this.#flat * (h1 * s2f * c2g - h2 * c2f * s2g))
		}
	}

	// IAU 1976 Earth ellipsoid: equatorial radius 6378.14 km converted to AU, flattening 1/298.257.
	export const EARTH76 = new Ellipsoid(6378.14 / AU_KM, 1 / 298.257)

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

// Chapter 12: Sidereal Time at Greenwich.
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
		const midnight = floor(jd + 0.5) - 0.5
		const cen = Base.j2000Century(midnight)
		const s = Base.horner(cen, IAU82)
		const n = Nutation.nutationInRA(midnight) // angle (radians) of RA
		const ns = (n * 3600 * 180) / PI / 15 // convert RA to time in seconds
		return pmod(s + ns, 86400)
	}
}

// Chapter 13: Transformation of Coordinates.
export namespace Coords {
	// Returns fresh equatorial [RA in 0..TAU, declination] from east-positive ecliptic longitude,
	// latitude and obliquity epsilon, all radians. Cartesian rotation preserves precision near poles.
	export function eclipticToEquatorial(longitude: Angle, latitude: Angle, epsilon: Angle) {
		const [epsilonsin, epsiloncos] = Base.sincos(epsilon)
		const [sBeta, cBeta] = Base.sincos(latitude)
		const [sLambda, cLambda] = Base.sincos(longitude)
		const x = cBeta * cLambda
		const y = cBeta * sLambda * epsiloncos - sBeta * epsilonsin
		const z = sBeta * epsiloncos + cBeta * epsilonsin * sLambda
		const ra = atan2(y, x) // (13.3) p. 93
		const dec = atan2(z, hypot(x, y)) // (13.4) p. 93
		return [normalizeAngle(ra), dec] as const
	}

	// Returns fresh ecliptic [longitude in -PI..PI, latitude] from RA, declination and obliquity
	// epsilon, all radians. Cartesian rotation preserves latitude precision near either pole.
	export function equatorialToEcliptic(rightAscension: Angle, declination: Angle, epsilon: Angle) {
		const [epsilonsin, epsiloncos] = Base.sincos(epsilon)
		const [sAlpha, cAlpha] = Base.sincos(rightAscension)
		const [sDelta, cDelta] = Base.sincos(declination)
		const x = cDelta * cAlpha
		const y = cDelta * sAlpha * epsiloncos + sDelta * epsilonsin
		const z = sDelta * epsiloncos - cDelta * epsilonsin * sAlpha
		const lon = atan2(y, x) // (13.1) p. 93
		const lat = atan2(z, hypot(x, y)) // (13.2) p. 93
		return [lon, lat] as const
	}

	// Computes Horizontal coordinates from equatorial coordinates given is the location of the observer on the Earth and the sidereal time at Greenwich.
	// Sidereal time must be consistent with the equatorial coordinates. If coordinates are apparent, sidereal time must be apparent as well.
	// All coordinates are radians, observer longitude is west-positive, and st is seconds of time.
	// Returns fresh [azimuth from south towards west in -PI..PI, altitude]; azimuth is indeterminate at the zenith/nadir.
	export function equatorialToHorizontal(rightAscension: Angle, declination: Angle, longitude: Angle, latitude: Angle, st: number) {
		const H = secondsOfTime(st) - longitude - rightAscension
		const [sH, cH] = Base.sincos(H)
		const [sPhi, cPhi] = Base.sincos(latitude)
		const [sDelta, cDelta] = Base.sincos(declination)
		const x = cDelta * cH * sPhi - sDelta * cPhi
		const y = cDelta * sH
		const z = sPhi * sDelta + cPhi * cDelta * cH
		const azimuth = atan2(y, x) // (13.5) p. 93
		const altitude = atan2(z, hypot(x, y)) // (13.6) p. 93
		return [azimuth, altitude] as const
	}

	// Converts equatorial coordinates to galactic coordinates.
	// Equatorial coordinates must be referred to the standard equinox of B1950.0.
	// For conversion to B1950, see package precess and utility functions in packkage "common".
	// Inputs and fresh output [longitude in 0..TAU, latitude] are radians; longitude is indeterminate at a pole.
	export function equatorialToGalactic(rightAscension: Angle, declination: Angle) {
		const [sdAlpha, cdAlpha] = Base.sincos(GALACTIC_NORTH_RA - rightAscension)
		const [sgDelta, cgDelta] = Base.sincos(GALACTIC_NORTH_DEC)
		const [sDelta, cDelta] = Base.sincos(declination)
		const a = cDelta * sdAlpha
		const b = cDelta * cdAlpha * sgDelta - sDelta * cgDelta
		const x = atan2(a, b) // (13.7) p. 94
		// (galactic0Lon1950 + 1.5 * PI) = magic number of 303 deg
		const lon = (GALACTIC_LON_0 + 1.5 * PI - x) % TAU // (13.8) p. 94
		const lat = atan2(sDelta * sgDelta + cDelta * cgDelta * cdAlpha, hypot(a, b))
		return [lon, lat] as const
	}

	// Converts horizontal coordinates to equatorial coordinates.
	// Sidereal time must be consistent with the equatorial coordinates.
	// If coordinates are apparent, sidereal time must be apparent as well.
	// Angles are radians: azimuth is south-zero/west-positive and observer longitude west-positive.
	// st is seconds of time; returns fresh [RA in 0..TAU, declination], with RA indeterminate at a pole.
	export function horizontalToEquatorial(azimuth: Angle, altitude: Angle, longitude: Angle, latitude: Angle, st: number) {
		const [sA, cA] = Base.sincos(azimuth)
		const [sh, ch] = Base.sincos(altitude)
		const [sPhi, cPhi] = Base.sincos(latitude)
		const x = ch * cA * sPhi + sh * cPhi
		const y = ch * sA
		const H = atan2(y, x)
		const ra = normalizeAngle(secondsOfTime(st) - longitude - H)
		const dec = atan2(sPhi * sh - cPhi * ch * cA, hypot(x, y))
		return [ra, dec] as const
	}

	// Converts galactic coordinates to equatorial coordinates.
	// Resulting equatorial coordinates will be referred to the standard equinox of
	// B1950.0. For subsequent conversion to other epochs, see package precess and
	// utility functions in package meeus.
	// All angles are radians; returns fresh [RA in 0..TAU, declination], with RA indeterminate at a pole.
	export function galacticToEquatorial(longitude: Angle, latitude: Angle) {
		// (-galactic0Lon1950 - Pi/2) = magic number of -123 deg
		const [sdLon, cdLon] = Base.sincos(longitude - GALACTIC_LON_0 - PIOVERTWO)
		const [sgDelta, cgDelta] = Base.sincos(GALACTIC_NORTH_DEC)
		const [sb, cb] = Base.sincos(latitude)
		const a = cb * sdLon
		const b = cb * cdLon * sgDelta - sb * cgDelta
		const y = atan2(a, b)
		// (galacticNorth1950.RA - PI) = magic number of 12.25 deg
		const ra = normalizeAngle(y + GALACTIC_NORTH_RA - PI)
		const dec = atan2(sb * sgDelta + cb * cgDelta * cdLon, hypot(a, b))
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

// Chapter 14: The Parallactic Angle, and three other Topics.
export namespace Parallactic {
	// Returns parallactic angle of a celestial object given latitude of the observer, declination and hour angle of the observed object.
	export function parallacticAngle(phi: Angle, delta: Angle, H: Angle) {
		const [sDelta, cDelta] = Base.sincos(delta)
		const [sH, cH] = Base.sincos(H)
		return atan2(sH, tan(phi) * cDelta - sDelta * cH) // (14.1) p. 98
	}

	// Returns parallactic angle given latitude of the observer and declination of the observed object.
	// The hour angle is not needed as an input and the math inside simplifies.
	export function parallacticAngleOnHorizon(phi: Angle, delta: Angle) {
		return acos(sin(phi) / cos(delta))
	}

	// Computes how the plane of the ecliptic intersects
	// the horizon at a given obliquity of the ecliptic, geographic latitude of observer and local sidereal time expressed as an hour angle.
	export function eclipticAtHorizon(epsilon: Angle, phi: Angle, theta: Angle) {
		const [sEpsilon, cEpsilon] = Base.sincos(epsilon)
		const [sPhi, cPhi] = Base.sincos(phi)
		const [sTheta, cTheta] = Base.sincos(theta)
		let lambda = atan2(-cTheta, sEpsilon * (sPhi / cPhi) + cEpsilon * sTheta) // (14.2) p. 99

		if (lambda < 0) {
			lambda += PI
		}

		// The lambdas are ecliptic longitudes where the ecliptic intersects the horizon.
		// I is the angle at which the ecliptic intersects the horizon.
		return [lambda, lambda + PI, acos(cEpsilon * sPhi - sEpsilon * cPhi * sTheta)] // (14.3) p. 99
	}

	// Computes the angle between the ecliptic and the parallels
	// of ecliptic latitude at a given ecliptic longitude (lambda) and obliquity of the ecliptic (epsilon).
	export function eclipticAtEquator(lambda: Angle, epsilon: Angle) {
		return atan(-cos(lambda) * tan(epsilon))
	}

	// Computes the angle of the path a celestial object
	// relative to the horizon at the time of its rising or setting.
	export function diurnalPathAtHorizon(phi: Angle, delta: Angle) {
		const tPhi = tan(phi)
		const b = tan(delta) * tPhi
		const c = sqrt(1 - b * b)
		return atan((c * cos(delta)) / tPhi)
	}
}

// Chapter 15: approximate rising, upper transit and setting on a UT1 day. Observer longitude is west-positive.
export namespace Rise {
	// Geographic observer angles in radians, with geodetic latitude and west-positive longitude.
	export interface Observer {
		// Latitude in [-PI/2, PI/2], north positive.
		readonly lat: Angle
		// Longitude in radians, west positive (Boston approximately +71 degrees).
		readonly lon: Angle
	}

	// No distinct daily crossing: permanently above/below the threshold, or tangent/constant altitude.
	export type HorizonState = 'alwaysAbove' | 'alwaysBelow' | 'grazing'

	// A day's ordinary events. Low-level functions use UT1 seconds after midnight; PlanetRise uses JD or Date.
	export interface EventTimes<T = number> {
		// Both rise and set exist in the fixed-declination approximation.
		readonly state: 'normal'
		// Ascending crossing of the standard altitude.
		readonly rise: T
		// Upper meridian passage.
		readonly transit: T
		// Descending crossing of the standard altitude.
		readonly set: T
	}

	// No ordinary rise/set; transit remains a formal hour-angle-zero meridian passage, even at the poles.
	export interface NoCrossing<T = number> {
		// Classification relative to the requested standard altitude, based on the central declination.
		readonly state: HorizonState
		// Upper transit in the same units as EventTimes.
		readonly transit: T
	}

	// Typed daily events without using exceptions or non-finite event times for circumpolar geometry.
	export type Result<T = number> = EventTimes<T> | NoCrossing<T>

	// Conventional positive horizon refraction: 34 arcminutes, in radians (Meeus chapter 15).
	export const MEAN_REFRACTION = (34 / 60) * DEG2RAD

	// Standard geocentric center altitudes with mean refraction included; lunar is a dimensionless coefficient.
	export const STDH0 = {
		// Stars and planets: center appears at the refracted horizon, radians.
		stellar: -MEAN_REFRACTION,
		// Sun: upper limb appears at the refracted horizon, radians.
		solar: (-50 / 60) * DEG2RAD,
		// Multiplier of the Moon's horizontal parallax, not an angle (Meeus p. 101).
		lunar: 0.7275,
		// Moon: mean standard center altitude, radians.
		lunarMean: 0.125 * DEG2RAD,
	} as const

	// Replaces the mean refraction already contained in h0 with positive correction, both radians.
	// Omitted correction preserves h0; explicit zero disables refraction.
	export function refraction(h0: Angle, correction?: Angle) {
		return correction === undefined ? h0 : h0 + MEAN_REFRACTION - correction
	}

	// Standard stellar/planetary center altitude in radians with optional positive horizon refraction.
	export function stdh0Stellar(correction?: Angle) {
		return refraction(STDH0.stellar, correction)
	}

	// Standard solar upper-limb center altitude in radians with optional positive horizon refraction.
	export function stdh0Solar(correction?: Angle) {
		return refraction(STDH0.solar, correction)
	}

	// Mean lunar center altitude in radians with optional positive horizon refraction.
	export function stdh0LunarMean(correction?: Angle) {
		return refraction(STDH0.lunarMean, correction)
	}

	// Lunar standard altitude in radians from horizontal parallax in radians and positive refraction.
	// Meeus p. 101 / Sonia Keys rise.Stdh0Lunar: 0.7275 * parallax - refraction.
	export function stdh0Lunar(parallax: Angle, correction: Angle = MEAN_REFRACTION) {
		return STDH0.lunar * parallax - correction
	}

	// Returns positive crossing hour angle in (0, PI), or a no-crossing state, for latitude,
	// standard altitude h0 and declination in radians. Roundoff within 1e-15 in sine altitude is grazing.
	export function hourAngle(lat: Angle, h0: Angle, declination: Angle): Angle | HorizonState {
		const center = sin(lat) * sin(declination)
		const amplitude = cos(lat) * cos(declination)
		const difference = sin(h0) - center
		if (difference < -amplitude - 1e-15) return 'alwaysAbove'
		if (difference > amplitude + 1e-15) return 'alwaysBelow'
		if (amplitude <= 1e-15 || abs(abs(difference) - amplitude) <= 1e-15) return 'grazing'
		return acos(max(-1, min(1, difference / amplitude)))
	}

	// Estimates UT1 seconds in [0, DAYSEC) using fixed apparent equatorial ra/dec (radians).
	// theta0 is apparent Greenwich sidereal time at UT1 midnight, in seconds of time; h0 is radians.
	// Allocates a result. Polar classification ignores declination changes during the day.
	export function approxTimes(observer: Observer, h0: Angle, theta0: number, ra: Angle, dec: Angle): Result {
		const transit = pmod(((observer.lon + ra) * DAYSEC) / TAU - theta0, DAYSEC)
		const angle = hourAngle(observer.lat, h0, dec)
		if (typeof angle !== 'number') return { state: angle, transit }
		const offset = (angle * DAYSEC) / TAU
		return { state: 'normal', rise: pmod(transit - offset, DAYSEC), transit, set: pmod(transit + offset, DAYSEC) }
	}

	// Local signed hour angle (-PI..PI) at UT1 seconds m, for ra/lon in radians and theta0 in sidereal seconds.
	function localHourAngle(lon: Angle, ra: Angle, theta0: number, m: number) {
		const angle = ((theta0 + (m * 360.985647) / 360) * TAU) / DAYSEC - lon - ra
		return atan2(sin(angle), cos(angle))
	}

	// Refines approximate events once with Meeus's quadratic three-day interpolation; returns UT1
	// seconds in [0, DAYSEC). ra3/dec3 are radians at 0h TT on the previous, current and next dates,
	// with successive RA changes smaller than PI. deltaT is TT-UT1 seconds; theta0 is apparent Greenwich
	// sidereal seconds at UT1 midnight. Observer and h0 use radians. No inputs are mutated.
	// Near a grazing horizon the correction is ill-conditioned; a vanishing denominator reports grazing.
	// This is the chapter's single-correction approximation, not a search for rapidly changing polar events.
	export function times(observer: Observer, deltaT: number, h0: Angle, theta0: number, ra3: readonly [Angle, Angle, Angle], dec3: readonly [Angle, Angle, Angle]): Result {
		const initial = approxTimes(observer, h0, theta0, ra3[1], dec3[1])
		// Unwrap one RA sample to the nearest branch around the central sample.
		const unwrap = (a: Angle) => ra3[1] + atan2(sin(a - ra3[1]), cos(a - ra3[1]))
		const alpha = new Interpolation.Len3(-DAYSEC, DAYSEC, [unwrap(ra3[0]), ra3[1], unwrap(ra3[2])])
		const delta = new Interpolation.Len3(-DAYSEC, DAYSEC, dec3)
		const transit = pmod(initial.transit - (localHourAngle(observer.lon, alpha.interpolateX(initial.transit + deltaT), theta0, initial.transit) * DAYSEC) / TAU, DAYSEC)

		if (initial.state !== 'normal') return { state: initial.state, transit }

		const sLat = sin(observer.lat)
		const cLat = cos(observer.lat)

		// One altitude correction at UT1 second m; undefined denotes a singular grazing correction.
		const adjust = (m: number) => {
			const dec = delta.interpolateX(m + deltaT)
			const H = localHourAngle(observer.lon, alpha.interpolateX(m + deltaT), theta0, m)
			const denominator = cos(dec) * cLat * sin(H)
			if (abs(denominator) < 1e-15) return undefined
			const h = asin(max(-1, min(1, sLat * sin(dec) + cLat * cos(dec) * cos(H))))
			return pmod(m + (DAYSEC * (h - h0)) / (TAU * denominator), DAYSEC)
		}

		const rise = adjust(initial.rise)
		const set = adjust(initial.set)
		return rise === undefined || set === undefined ? { state: 'grazing', transit } : { state: 'normal', rise, transit, set }
	}

	// Output representation and horizon refraction for planetary rise/set calculations.
	export interface PlanetRiseOptions {
		// If true, return fresh proleptic Gregorian Dates with UT1 labels; otherwise return UT1 JD.
		readonly date?: boolean
		// Positive horizon refraction in radians; omitted uses 34 arcminutes, zero disables it.
		readonly refraction?: Angle
	}

	// Computes one UT1 day's planetary events with VSOP87E apparent equatorial coordinates.
	// Each call allocates its result; observer angles are radians and longitude is west-positive.
	export class PlanetRise {
		// UT1 JD at midnight on the requested day.
		readonly jd: number
		// Observer latitude and west-positive longitude in radians.
		readonly #observer: Observer
		// Observed planet; Earth cannot be observed geocentrically.
		readonly #planet: Exclude<PlanetPosition.Planet, 'earth'>
		// TT - UT1 in seconds at midnight, fixed at construction.
		readonly #deltaT: number
		// Standard apparent center altitude in radians.
		readonly #h0: Angle
		// Whether calls return Date objects rather than Julian days.
		readonly #date: boolean

		// Selects the UT1 day containing jd (or Date's Gregorian labels), latitude/longitude in radians,
		// observed planet and optional output/refraction settings. Copies settings; no input is mutated.
		constructor(jd: number | Date, lat: Angle, lon: Angle, planet: Exclude<PlanetPosition.Planet, 'earth'>, options?: PlanetRiseOptions) {
			this.jd = floor((jd instanceof Date ? Julian.dateToJD(jd) : jd) - 0.5) + 0.5
			this.#observer = { lat, lon }
			this.#planet = planet
			this.#deltaT = Julian.deltaTSeconds(new Julian.CalendarGregorian().fromJD(this.jd).toYear())
			this.#h0 = stdh0Stellar(options?.refraction)
			this.#date = options?.date ?? false
		}

		// Returns approximate events from the planet's apparent position at UT1 midnight, as JD or Date.
		approxTimes(): Result<number | Date> {
			const [ra, dec] = Elliptic.position(this.#planet, this.jd + this.#deltaT / DAYSEC)
			return this.convert(approxTimes(this.#observer, this.#h0, Sidereal.apparent0UT(this.jd), ra, dec))
		}

		// Returns interpolated events as JD or Date. Samples are at TT midnight, so times applies delta-T once.
		times(): Result<number | Date> {
			const a = Elliptic.position(this.#planet, this.jd - 1)
			const b = Elliptic.position(this.#planet, this.jd)
			const c = Elliptic.position(this.#planet, this.jd + 1)
			return this.convert(times(this.#observer, this.#deltaT, this.#h0, Sidereal.apparent0UT(this.jd), [a[0], b[0], c[0]], [a[1], b[1], c[1]]))
		}

		// Allocates the requested representation for each defined UT1 event, preserving the horizon state.
		private convert(result: Result): Result<number | Date> {
			const transit = this.convertTime(result.transit)
			return result.state === 'normal' ? { state: 'normal', rise: this.convertTime(result.rise), transit, set: this.convertTime(result.set) } : { state: result.state, transit }
		}

		// Converts UT1 seconds after midnight to JD or a fresh Gregorian Date with UT1 labels.
		private convertTime(seconds: number) {
			const jd = this.jd + seconds / DAYSEC
			return this.#date ? Julian.jdToDate(jd) : jd
		}
	}
}

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
	// Returns angular separation in radians [0, PI] for two spherical coordinates (radians).
	// Uses Pauwels near coincidence to handle longitude wrapping and polar geometry without cancellation.
	export function sep(c1: Coord, c2: Coord) {
		const [sind1, cosd1] = Base.sincos(c1[1])
		const [sind2, cosd2] = Base.sincos(c2[1])

		const cd = sind1 * sind2 + cosd1 * cosd2 * cos(c1[0] - c2[0]) // (17.1) p. 109

		if (cd < Base.COS_SMALL_ANGLE) {
			return acos(max(-1, cd))
		} else {
			return sepPauwels(c1, c2)
		}
	}

	// Computes the minimum separation between two moving objects.
	export function minSep(jd1: number, jd3: number, cs1: readonly [Coord, Coord, Coord], cs2: readonly [Coord, Coord, Coord], fnSep: typeof sep = sep) {
		const y = new Float64Array(3)

		for (let x = 0; x < cs1.length; x++) {
			y[x] = fnSep(cs1[x], cs2[x])
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

	// Returns the dimensionless haversine of angle a in radians; sin²(a/2) avoids cancellation near zero.
	export function hav(a: number) {
		const s = sin(a / 2)
		return s * s
	}

	// Computes the angular separation between two celestial bodies.
	export function sepHav(c1: Coord, c2: Coord) {
		// using (17.5) p. 115
		return 2 * asin(sqrt(max(0, min(1, hav(c2[1] - c1[1]) + cos(c1[1]) * cos(c2[1]) * hav(c2[0] - c1[0])))))
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
	// Angular differences must vary by less than PI per row; removes wrapping before interpolation.
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
	// Successive longitudes/RA must differ by less than PI; angles are radians and may wrap at TAU.
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

	// Returns fresh [conjunction time, latitude/declination difference in radians]. Times use the
	// units of t1/t5. Unwraps private scratch differences dr in place around the central row's nearest
	// conjunction branch; dd is unchanged. The five equally spaced rows must bracket a conjunction
	// (Len5 interpolating factor n in [-2, 2]); Δδ uses the same table domain as zero().
	function conj(t1: number, t5: number, dr: NumberArray, dd: NumberArray) {
		for (let i = 1; i < dr.length; i++) dr[i] = dr[i - 1] + atan2(sin(dr[i] - dr[i - 1]), cos(dr[i] - dr[i - 1]))
		const shift = TAU * round(dr[2] / TAU)
		for (let i = 0; i < dr.length; i++) dr[i] -= shift
		const t = new Interpolation.Len5(t1, t5, dr).zero(true)
		const deltad = new Interpolation.Len5(t1, t5, dd).interpolateX(t)
		return [t, deltad] as const
	}
}

// Chapter 19: Bodies in Straight Line
export namespace Line {
	// Computes the time at which a moving body is on a straight line (great
	// circle) between two fixed points, such as stars.
	export function time(r1: Angle, d1: Angle, r2: Angle, d2: Angle, r3: readonly Angle[], d3: readonly [Angle, Angle, Angle, Angle, Angle], t1: number, t5: number) {
		const gc = new Array<number>(5)

		for (let i = 0; i < 5; i++) {
			// (19.1) p. 121
			const r3i = r3[i]
			gc[i] = tan(d1) * sin(r2 - r3i) + tan(d2) * sin(r3i - r1) + tan(d3[i]) * sin(r1 - r2)
		}

		return new Interpolation.Len5(t1, t5, gc).zero(false)
	}

	// Computes the angle between great circles defined by three points.
	export function angle(r1: Angle, d1: Angle, r2: Angle, d2: Angle, r3: Angle, d3: Angle) {
		const [sd2, cd2] = Base.sincos(d2)
		const [sr21, cr21] = Base.sincos(r2 - r1)
		const [sr32, cr32] = Base.sincos(r3 - r2)
		const C1 = atan2(sr21, cd2 * tan(d1) - sd2 * cr21)
		const C2 = atan2(sr32, cd2 * tan(d3) - sd2 * cr32)
		return C1 + C2
	}

	// Returns signed angular distance (radians) of r0/d0 from the oriented great circle through
	// r1/d1 and r2/d2 (radians). The defining points must be distinct and non-antipodal.
	export function error(r1: Angle, d1: Angle, r2: Angle, d2: Angle, r0: Angle, d0: Angle) {
		const [sr1, cr1] = Base.sincos(r1)
		const [sd1, cd1] = Base.sincos(d1)
		const [sr2, cr2] = Base.sincos(r2)
		const [sd2, cd2] = Base.sincos(d2)
		const X1 = cd1 * cr1
		const X2 = cd2 * cr2
		const Y1 = cd1 * sr1
		const Y2 = cd2 * sr2
		const Z1 = sd1
		const Z2 = sd2
		const A = Y1 * Z2 - Z1 * Y2
		const B = Z1 * X2 - X1 * Z2
		const C = X1 * Y2 - Y1 * X2
		const [sr0, cr0] = Base.sincos(r0)
		const [sd0, cd0] = Base.sincos(d0)
		return asin(max(-1, min(1, (A * cd0 * cr0 + B * cd0 * sr0 + C * sd0) / hypot(A, B, C))))
	}

	// Returns fresh [angle between oriented great-circle normals in 0..PI, signed middle-point
	// error] in radians for r1/d1, r2/d2 and r3/d3 in radians. Each point pair must define a unique
	// great circle. Cross/dot products preserve the angle at collinearity without acos roundoff.
	export function angleError(r1: Angle, d1: Angle, r2: Angle, d2: Angle, r3: Angle, d3: Angle) {
		const [sr1, cr1] = Base.sincos(r1)
		const [c1, cd1] = Base.sincos(d1)
		const [sr2, cr2] = Base.sincos(r2)
		const [c2, cd2] = Base.sincos(d2)
		const [sr3, cr3] = Base.sincos(r3)
		const [c3, cd3] = Base.sincos(d3)
		const a1 = cd1 * cr1
		const a2 = cd2 * cr2
		const a3 = cd3 * cr3
		const b1 = cd1 * sr1
		const b2 = cd2 * sr2
		const b3 = cd3 * sr3
		const l1 = b1 * c2 - b2 * c1
		const l2 = b2 * c3 - b3 * c2
		const l3 = b1 * c3 - b3 * c1
		const m1 = c1 * a2 - c2 * a1
		const m2 = c2 * a3 - c3 * a2
		const m3 = c1 * a3 - c3 * a1
		const n1 = a1 * b2 - a2 * b1
		const n2 = a2 * b3 - a3 * b2
		const n3 = a1 * b3 - a3 * b1
		const psi = atan2(hypot(m1 * n2 - n1 * m2, n1 * l2 - l1 * n2, l1 * m2 - m1 * l2), l1 * l2 + m1 * m2 + n1 * n2)
		const omega = asin(max(-1, min(1, (a2 * l3 + b2 * m3 + c2 * n3) / (hypot(a2, b2, c2) * hypot(l3, m3, n3)))))
		return [psi, omega] as const
	}
}

// Chapter 20: Smallest Circle containing three Celestial Bodies.
export namespace Circle {
	// Returns fresh [angular diameter in radians, type I] for three spherical coordinates (radians).
	// Meeus 20.1 uses a planar triangle of angular side lengths, intended for compact groups.
	// Type I uses the longest side as diameter; otherwise the three points define the circle.
	export function smallest(c1: Coord, c2: Coord, c3: Coord) {
		let a = AngularSeparation.sepPauwels(c1, c2)
		let b = AngularSeparation.sepPauwels(c2, c3)
		let c = AngularSeparation.sepPauwels(c3, c1)

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

// Chapter 21: Precession.
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
		const da = m + na * sa * tan(declination) // seconds of RA
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
			const ra = atan2(A, B) + this.#z
			const dec = atan2(C, hypot(A, B)) // stable in both hemispheres, including near either pole
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
			this.#sEta = sin(eta)
			this.#cEta = cos(eta)
		}

		// Precesses coordinates eclFrom, leaving result in eclTo.
		precess(longitude: Angle, latitude: Angle) {
			// (21.7) p. 137
			const [sBeta, cBeta] = Base.sincos(latitude)
			const [sd, cd] = Base.sincos(this.#pi - longitude)
			const A = this.#cEta * cBeta * sd - this.#sEta * sBeta
			const B = cBeta * cd
			const C = this.#cEta * sBeta + this.#sEta * cBeta * sd
			const lon = this.#p + this.#pi - atan2(A, B)
			const lat = atan2(C, hypot(A, B)) // stable in both hemispheres, including near either pole
			return [lon, lat]
		}

		// Reduces orbital elements of a solar system body from one equinox to another.
		// eFrom is [inclination, node, perihelion argument] in radians; returns a fresh tuple with
		// inclination in 0..PI, retaining precision for nearly coplanar or retrograde target planes.
		reduceElements(eFrom: EquinoxOrbitalElements): EquinoxOrbitalElements {
			const psi = this.#pi + this.#p
			const [si, ci] = Base.sincos(eFrom[0])
			const [snp, cnp] = Base.sincos(eFrom[1] - this.#pi)
			// (24.1) p. 159
			const inc = atan2(hypot(si * snp, this.#cEta * si * cnp - this.#sEta * ci), ci * this.#cEta + si * this.#sEta * cnp)
			// (24.2) p. 159
			const node = atan2(si * snp, this.#cEta * si * cnp - this.#sEta * ci) + psi
			// (24.3) p. 159
			const peri = atan2(-this.#sEta * snp, si * this.#cEta - ci * this.#sEta * cnp) + eFrom[2]
			return [inc, node, peri]
		}
	}

	// Precesses ecliptic coordinates from one epoch to another, including proper motions.
	export function eclipticPosition(p: EclipticPrecessor, longitude: Angle, latitude: Angle, pmRA: Angle = 0, pmDEC: Angle = 0) {
		if (pmRA !== 0 || pmDEC !== 0) {
			const [lon, lat] = properMotion(pmRA, pmDEC, p.epochFrom, longitude, latitude)
			const t = p.epochTo - p.epochFrom
			longitude += lon * t
			latitude += lat * t
		}

		return p.precess(longitude, latitude)
	}

	// Converts equatorial pmRA/pmDEC (radians per Julian year, pmRA without cos(dec)) to fresh
	// ecliptic angular rates at Julian epoch and longitude/latitude (radians); excludes coordinate poles.
	// Zero input rates return zero rates, independently of the position.
	export function properMotion(pmRA: Angle, pmDEC: Angle, epoch: number, longitude: Angle, latitude: Angle) {
		if (pmRA === 0 && pmDEC === 0) return [0, 0] as const
		const epsilon = Nutation.meanObliquity(Base.julianYearToJDE(epoch))
		const [epsilonsin, epsiloncos] = Base.sincos(epsilon)
		const [ra, dec] = Coords.eclipticToEquatorial(longitude, latitude, epsilon)
		const [sAlpha, cAlpha] = Base.sincos(ra)
		const [sDelta, cDelta] = Base.sincos(dec)
		const cBeta = cos(latitude)
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
		const ra = atan2(yp, xp)
		const dec = atan2(zp, hypot(xp, yp))
		return [ra, dec] as const
	}
}

// Chapter 22: Nutation and the Obliquity of the Ecliptic.
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

// Chapter 23: Apparent Place of a Star. First-order corrections are invalid near coordinate poles.
export namespace Apparent {
	// Constant of annual aberration (radians), Meeus chapter 23.
	const KAPPA = 20.49552 * ASEC2RAD
	// Light speed in units of 1e-8 AU/day used by the Ron–Vondrak velocity series.
	const SPEED_OF_LIGHT = 17314463350

	// Fundamental angles (radians) and time for the Ron–Vondrak series in equatorial J2000 axes.
	interface RVArguments {
		// Julian centuries of TT from J2000.
		T: number
		// Venus mean longitude.
		L2: Angle
		// Earth mean longitude.
		L3: Angle
		// Mars mean longitude.
		L4: Angle
		// Jupiter mean longitude.
		L5: Angle
		// Saturn mean longitude.
		L6: Angle
		// Uranus mean longitude.
		L7: Angle
		// Neptune mean longitude.
		L8: Angle
		// Lunar mean longitude.
		Lp: Angle
		// Lunar mean elongation from the Sun.
		D: Angle
		// Lunar mean anomaly.
		Mp: Angle
		// Lunar mean argument of latitude.
		F: Angle
	}

	const PERIHELION = [102.93735 * DEG2RAD, 1.71946 * DEG2RAD, 0.00046 * DEG2RAD] as const

	// Returns Earth's unwrapped perihelion longitude (radians) for T Julian centuries from J2000.
	export function perihelion(T: number) {
		return Base.horner(T, PERIHELION)
	}

	// Returns fresh nutation corrections [dRA, dDec] (radians) to mean equatorial alpha/delta
	// (radians) of date at jd (TT); first-order Meeus (23.1), away from celestial poles.
	export function nutation(alpha: Angle, delta: Angle, jd: number): readonly [Angle, Angle] {
		const epsilon = Nutation.meanObliquity(jd)
		const [sinEpsilon, cosEpsilon] = Base.sincos(epsilon)
		const [deltaPsi, deltaEpsilon] = Nutation.nutation(jd)
		const [sinAlpha, cosAlpha] = Base.sincos(alpha)
		const tanDelta = tan(delta)
		// (23.1) p. 151
		const deltaAlpha1 = (cosEpsilon + sinEpsilon * sinAlpha * tanDelta) * deltaPsi - cosAlpha * tanDelta * deltaEpsilon
		const deltaDelta1 = sinEpsilon * cosAlpha * deltaPsi + sinAlpha * deltaEpsilon
		return [deltaAlpha1, deltaDelta1]
	}

	// Returns fresh annual-aberration corrections [dLongitude, dLatitude] (radians) for ecliptic
	// lambda/beta (radians) of date at jd (TT), Meeus (23.2); invalid near ecliptic poles.
	export function eclipticAberration(lambda: Angle, beta: Angle, jd: number): readonly [Angle, Angle] {
		const T = Base.j2000Century(jd)
		const [lon] = Solar.trueLongitude(T)
		const e = Solar.eccentricity(T)
		const pi = perihelion(T)
		const [sBeta, cBeta] = Base.sincos(beta)
		const [ssLambda, csLambda] = Base.sincos(lon - lambda)
		const [sinPiLambda, cosPiLambda] = Base.sincos(pi - lambda)
		// (23.2) p. 151
		const deltaLambda = (KAPPA * (e * cosPiLambda - csLambda)) / cBeta
		const deltaBeta = -KAPPA * sBeta * (ssLambda - e * sinPiLambda)
		return [deltaLambda, deltaBeta]
	}

	// Returns fresh annual-aberration corrections [dRA, dDec] (radians) for mean equatorial
	// alpha/delta (radians) of date at jd (TT), Meeus (23.3); invalid near celestial poles.
	export function aberration(alpha: Angle, delta: Angle, jd: number): readonly [Angle, Angle] {
		const epsilon = Nutation.meanObliquity(jd)
		const T = Base.j2000Century(jd)
		const [lon] = Solar.trueLongitude(T)
		const e = Solar.eccentricity(T)
		const pi = perihelion(T)
		const [sinAlpha, cosAlpha] = Base.sincos(alpha)
		const [sinDelta, cosDelta] = Base.sincos(delta)
		const [sins, coss] = Base.sincos(lon)
		const [sinPi, cosPi] = Base.sincos(pi)
		const cosEpsilon = cos(epsilon)
		const q1 = cosAlpha * cosEpsilon
		// (23.3) p. 152
		const deltaAlpha2 = (KAPPA * (e * (q1 * cosPi + sinAlpha * sinPi) - (q1 * coss + sinAlpha * sins))) / cosDelta
		const q2 = cosEpsilon * (tan(epsilon) * cosDelta - sinAlpha * sinDelta)
		const q3 = cosAlpha * sinDelta
		const deltaDelta2 = KAPPA * (e * (cosPi * q2 + sinPi * q3) - (coss * q2 + sins * q3))
		return [deltaAlpha2, deltaDelta2]
	}

	// Returns fresh Ron–Vondrak aberration corrections [dRA, dDec] (radians) for equatorial
	// J2000 alpha/delta (radians), at jd (TT); Meeus (23.4), invalid near celestial poles.
	export function aberrationRonVondrak(alpha: Angle, delta: Angle, jd: number): readonly [Angle, Angle] {
		const T = Base.j2000Century(jd)
		const r = {
			T,
			L2: 3.1761467 + 1021.3285546 * T,
			L3: 1.7534703 + 628.3075849 * T,
			L4: 6.2034809 + 334.0612431 * T,
			L5: 0.5995465 + 52.9690965 * T,
			L6: 0.8740168 + 21.3299095 * T,
			L7: 5.4812939 + 7.4781599 * T,
			L8: 5.3118863 + 3.8133036 * T,
			Lp: 3.8103444 + 8399.6847337 * T,
			D: 5.1984667 + 7771.3771486 * T,
			Mp: 2.3555559 + 8328.6914289 * T,
			F: 1.6279052 + 8433.4661601 * T,
		}

		let Xp = 0
		let Yp = 0
		let Zp = 0

		// sum smaller terms first
		for (let i = 35; i >= 0; i--) {
			const term = RV_TERMS[i](r)
			Xp += term[0]
			Yp += term[1]
			Zp += term[2]
		}

		const [sinAlpha, cosAlpha] = Base.sincos(alpha)
		const [sinDelta, cosDelta] = Base.sincos(delta)
		// (23.4) p. 156
		return [(Yp * cosAlpha - Xp * sinAlpha) / (SPEED_OF_LIGHT * cosDelta), -((Xp * cosAlpha + Yp * sinAlpha) * sinDelta - Zp * cosDelta) / SPEED_OF_LIGHT]
	}

	// Returns a fresh apparent [RA, declination] (radians, RA [0, TAU)) from mean equatorial
	// coordinates ra/dec at Julian epochFrom (year) to epochTo (year). Proper motions pmRA/pmDEC
	// are radians per Julian year (pmRA is dRA/dt, without cos(dec)); includes precession, nutation
	// and annual aberration. The first-order corrections require coordinates away from the poles.
	export function position(ra: Angle, dec: Angle, epochFrom: number, epochTo: number, pmRA: Angle = 0, pmDEC: Angle = 0): readonly [Angle, Angle] {
		const [a, d] = Precession.position(new Precession.Precessor(epochFrom, epochTo), ra, dec, pmRA, pmDEC)
		const jde = Base.julianYearToJDE(epochTo)
		const [na, nd] = nutation(a, d, jde)
		const [aa, ad] = aberration(a, d, jde)
		return [normalizeAngle(a + na + aa), d + nd + ad]
	}

	// Returns a fresh apparent [RA, declination] (radians, RA [0, TAU)) at Julian epochTo (year)
	// from J2000 mean coordinates ra/dec. Proper motions pmRA/pmDEC are radians per Julian year
	// (pmRA is dRA/dt). Applies motion and Ron–Vondrak aberration in J2000 before precession and
	// nutation of date; inputs must be away from the celestial poles.
	export function positionRonVondrak(ra: Angle, dec: Angle, epochTo: number, pmRA: Angle = 0, pmDEC: Angle = 0): readonly [Angle, Angle] {
		const t = epochTo - 2000
		ra += pmRA * t
		dec += pmDEC * t
		const jde = Base.julianYearToJDE(epochTo)
		const [aa, ad] = aberrationRonVondrak(ra, dec, jde)
		const [a, d] = new Precession.Precessor(2000, epochTo).precess(ra + aa, dec + ad)
		const [na, nd] = nutation(a, d, jde)
		return [normalizeAngle(a + na), d + nd]
	}

	// Ron–Vondrak velocity terms, Meeus table 23.A; accumulated from the smallest terms first.
	const RV_TERMS: ((r: RVArguments) => Vec3)[] = [
		// Velocity term 1 in 1e-8 AU/day for angular arguments r; returns a fresh XYZ tuple.
		(r) => {
			const [sinA, cosA] = Base.sincos(r.L3)
			return [(-1719914 - 2 * r.T) * sinA - 25 * cosA, (25 - 13 * r.T) * sinA + (1578089 + 156 * r.T) * cosA, (10 + 32 * r.T) * sinA + (684185 - 358 * r.T) * cosA]
		},
		// Velocity term 2 in 1e-8 AU/day for angular arguments r; returns a fresh XYZ tuple.
		(r) => {
			const [sinA, cosA] = Base.sincos(2 * r.L3)
			return [(6434 + 141 * r.T) * sinA + (28007 - 107 * r.T) * cosA, (25697 - 95 * r.T) * sinA + (-5904 - 130 * r.T) * cosA, (11141 - 48 * r.T) * sinA + (-2559 - 55 * r.T) * cosA]
		},
		// Velocity term 3 in 1e-8 AU/day for angular arguments r; returns a fresh XYZ tuple.
		(r) => {
			const [sinA, cosA] = Base.sincos(r.L5)
			return [715 * sinA, 6 * sinA - 657 * cosA, -15 * sinA - 282 * cosA]
		},
		// Velocity term 4 in 1e-8 AU/day for angular arguments r; returns a fresh XYZ tuple.
		(r) => {
			const [sinA, cosA] = Base.sincos(r.Lp)
			return [715 * sinA, -656 * cosA, -285 * cosA]
		},
		// Velocity term 5 in 1e-8 AU/day for angular arguments r; returns a fresh XYZ tuple.
		(r) => {
			const [sinA, cosA] = Base.sincos(3 * r.L3)
			return [(486 - 5 * r.T) * sinA + (-236 - 4 * r.T) * cosA, (-216 - 4 * r.T) * sinA + (-446 + 5 * r.T) * cosA, -94 * sinA - 193 * cosA]
		},
		// Velocity term 6 in 1e-8 AU/day for angular arguments r; returns a fresh XYZ tuple.
		(r) => {
			const [sinA, cosA] = Base.sincos(r.L6)
			return [159 * sinA, 2 * sinA - 147 * cosA, -6 * sinA - 61 * cosA]
		},
		// Velocity term 7 in 1e-8 AU/day for angular arguments r; returns a fresh XYZ tuple.
		(r) => {
			const cosA = cos(r.F)
			return [0, 26 * cosA, -59 * cosA]
		},
		// Velocity term 8 in 1e-8 AU/day for angular arguments r; returns a fresh XYZ tuple.
		(r) => {
			const [sinA, cosA] = Base.sincos(r.Lp + r.Mp)
			return [39 * sinA, -36 * cosA, -16 * cosA]
		},
		// Velocity term 9 in 1e-8 AU/day for angular arguments r; returns a fresh XYZ tuple.
		(r) => {
			const [sinA, cosA] = Base.sincos(2 * r.L5)
			return [33 * sinA - 10 * cosA, -9 * sinA - 30 * cosA, -5 * sinA - 13 * cosA]
		},
		// Velocity term 10 in 1e-8 AU/day for angular arguments r; returns a fresh XYZ tuple.
		(r) => {
			const [sinA, cosA] = Base.sincos(2 * r.L3 - r.L5)
			return [31 * sinA + cosA, sinA - 28 * cosA, -12 * cosA]
		},
		// Velocity term 11 in 1e-8 AU/day for angular arguments r; returns a fresh XYZ tuple.
		(r) => {
			const [sinA, cosA] = Base.sincos(3 * r.L3 - 8 * r.L4 + 3 * r.L5)
			return [8 * sinA - 28 * cosA, 25 * sinA + 8 * cosA, 11 * sinA + 3 * cosA]
		},
		// Velocity term 12 in 1e-8 AU/day for angular arguments r; returns a fresh XYZ tuple.
		(r) => {
			const [sinA, cosA] = Base.sincos(5 * r.L3 - 8 * r.L4 + 3 * r.L5)
			return [8 * sinA - 28 * cosA, -25 * sinA - 8 * cosA, -11 * sinA + -3 * cosA]
		},
		// Velocity term 13 in 1e-8 AU/day for angular arguments r; returns a fresh XYZ tuple.
		(r) => {
			const [sinA, cosA] = Base.sincos(2 * r.L2 - r.L3)
			return [21 * sinA, -19 * cosA, -8 * cosA]
		},
		// Velocity term 14 in 1e-8 AU/day for angular arguments r; returns a fresh XYZ tuple.
		(r) => {
			const [sinA, cosA] = Base.sincos(r.L2)
			return [-19 * sinA, 17 * cosA, 8 * cosA]
		},
		// Velocity term 15 in 1e-8 AU/day for angular arguments r; returns a fresh XYZ tuple.
		(r) => {
			const [sinA, cosA] = Base.sincos(r.L7)
			return [17 * sinA, -16 * cosA, -7 * cosA]
		},
		// Velocity term 16 in 1e-8 AU/day for angular arguments r; returns a fresh XYZ tuple.
		(r) => {
			const [sinA, cosA] = Base.sincos(r.L3 - 2 * r.L5)
			return [16 * sinA, 15 * cosA, sinA + 7 * cosA]
		},
		// Velocity term 17 in 1e-8 AU/day for angular arguments r; returns a fresh XYZ tuple.
		(r) => {
			const [sinA, cosA] = Base.sincos(r.L8)
			return [16 * sinA, sinA - 15 * cosA, -3 * sinA - 6 * cosA]
		},
		// Velocity term 18 in 1e-8 AU/day for angular arguments r; returns a fresh XYZ tuple.
		(r) => {
			const [sinA, cosA] = Base.sincos(r.L3 + r.L5)
			return [11 * sinA - cosA, -sinA - 10 * cosA, -sinA - 5 * cosA]
		},
		// Velocity term 19 in 1e-8 AU/day for angular arguments r; returns a fresh XYZ tuple.
		(r) => {
			const [sinA, cosA] = Base.sincos(2 * r.L2 - 2 * r.L3)
			return [-11 * cosA, -10 * sinA, -4 * sinA]
		},
		// Velocity term 20 in 1e-8 AU/day for angular arguments r; returns a fresh XYZ tuple.
		(r) => {
			const [sinA, cosA] = Base.sincos(r.L3 - r.L5)
			return [-11 * sinA - 2 * cosA, -2 * sinA + 9 * cosA, -sinA + 4 * cosA]
		},
		// Velocity term 21 in 1e-8 AU/day for angular arguments r; returns a fresh XYZ tuple.
		(r) => {
			const [sinA, cosA] = Base.sincos(4 * r.L3)
			return [-7 * sinA - 8 * cosA, -8 * sinA + 6 * cosA, -3 * sinA + 3 * cosA]
		},
		// Velocity term 22 in 1e-8 AU/day for angular arguments r; returns a fresh XYZ tuple.
		(r) => {
			const [sinA, cosA] = Base.sincos(3 * r.L3 - 2 * r.L5)
			return [-10 * sinA, 9 * cosA, 4 * cosA]
		},
		// Velocity term 23 in 1e-8 AU/day for angular arguments r; returns a fresh XYZ tuple.
		(r) => {
			const [sinA, cosA] = Base.sincos(r.L2 - 2 * r.L3)
			return [-9 * sinA, -9 * cosA, -4 * cosA]
		},
		// Velocity term 24 in 1e-8 AU/day for angular arguments r; returns a fresh XYZ tuple.
		(r) => {
			const [sinA, cosA] = Base.sincos(2 * r.L2 - 3 * r.L3)
			return [-9 * sinA, -8 * cosA, -4 * cosA]
		},
		// Velocity term 25 in 1e-8 AU/day for angular arguments r; returns a fresh XYZ tuple.
		(r) => {
			const [sinA, cosA] = Base.sincos(2 * r.L6)
			return [-9 * cosA, -8 * sinA, -3 * sinA]
		},
		// Velocity term 26 in 1e-8 AU/day for angular arguments r; returns a fresh XYZ tuple.
		(r) => {
			const [sinA, cosA] = Base.sincos(2 * r.L2 - 4 * r.L3)
			return [-9 * cosA, 8 * sinA, 3 * sinA]
		},
		// Velocity term 27 in 1e-8 AU/day for angular arguments r; returns a fresh XYZ tuple.
		(r) => {
			const [sinA, cosA] = Base.sincos(3 * r.L3 - 2 * r.L4)
			return [8 * sinA, -8 * cosA, -3 * cosA]
		},
		// Velocity term 28 in 1e-8 AU/day for angular arguments r; returns a fresh XYZ tuple.
		(r) => {
			const [sinA, cosA] = Base.sincos(r.Lp + 2 * r.D - r.Mp)
			return [8 * sinA, -7 * cosA, -3 * cosA]
		},
		// Velocity term 29 in 1e-8 AU/day for angular arguments r; returns a fresh XYZ tuple.
		(r) => {
			const [sinA, cosA] = Base.sincos(8 * r.L2 - 12 * r.L3)
			return [-4 * sinA - 7 * cosA, -6 * sinA + 4 * cosA, -3 * sinA + 2 * cosA]
		},
		// Velocity term 30 in 1e-8 AU/day for angular arguments r; returns a fresh XYZ tuple.
		(r) => {
			const [sinA, cosA] = Base.sincos(8 * r.L2 - 14 * r.L3)
			return [-4 * sinA - 7 * cosA, 6 * sinA - 4 * cosA, 3 * sinA - 2 * cosA]
		},
		// Velocity term 31 in 1e-8 AU/day for angular arguments r; returns a fresh XYZ tuple.
		(r) => {
			const [sinA, cosA] = Base.sincos(2 * r.L4)
			return [-6 * sinA - 5 * cosA, -4 * sinA + 5 * cosA, -2 * sinA + 2 * cosA]
		},
		// Velocity term 32 in 1e-8 AU/day for angular arguments r; returns a fresh XYZ tuple.
		(r) => {
			const [sinA, cosA] = Base.sincos(3 * r.L2 - 4 * r.L3)
			return [-sinA - cosA, -2 * sinA - 7 * cosA, sinA - 4 * cosA]
		},
		// Velocity term 33 in 1e-8 AU/day for angular arguments r; returns a fresh XYZ tuple.
		(r) => {
			const [sinA, cosA] = Base.sincos(2 * r.L3 - 2 * r.L5)
			return [4 * sinA - 6 * cosA, -5 * sinA - 4 * cosA, -2 * sinA - 2 * cosA]
		},
		// Velocity term 34 in 1e-8 AU/day for angular arguments r; returns a fresh XYZ tuple.
		(r) => {
			const [sinA, cosA] = Base.sincos(3 * r.L2 - 3 * r.L3)
			return [-7 * cosA, -6 * sinA, -3 * sinA]
		},
		// Velocity term 35 in 1e-8 AU/day for angular arguments r; returns a fresh XYZ tuple.
		(r) => {
			const [sinA, cosA] = Base.sincos(2 * r.L3 - 2 * r.L4)
			return [5 * sinA - 5 * cosA, -4 * sinA - 5 * cosA, -2 * sinA - 2 * cosA]
		},
		// Velocity term 36 in 1e-8 AU/day for angular arguments r; returns a fresh XYZ tuple.
		(r) => {
			const [sinA, cosA] = Base.sincos(r.Lp - 2 * r.D)
			return [5 * sinA, -5 * cosA, -2 * cosA]
		},
	]
}

// Chapter 24: Reduction of Ecliptical Elements from one Equinox to another one.
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
		const inc = atan2(hypot(A, B), C * ci + S * si * cW)
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
	// Input/output tuples contain inclination, node and perihelion argument in radians. Allocates
	// a tuple; inclination is 0..PI and node/perihelion are 0..TAU, including nearly coplanar cases.
	export function reduceB1950FK4ToJ2000FK5(from: EquinoxOrbitalElements): EquinoxOrbitalElements {
		const W = L + from[1]
		const [si, ci] = Base.sincos(from[0])
		const [sW, cW] = Base.sincos(W)
		const inc = atan2(hypot(si * sW, ci * SJ + si * CJ * cW), ci * CJ - si * SJ * cW)
		const node = normalizeAngle(atan2(si * sW, ci * SJ + si * CJ * cW) - Lp)
		const peri = normalizeAngle(from[2] + atan2(SJ * sW, si * CJ + ci * SJ * cW))
		return [inc, node, peri]
	}
}

// Chapter 25: Solar Coordinates. Low-order formulae and VSOP87E geocentric solar positions.
export namespace Solar {
	const TRUE_LONGITUDE_L0 = [280.46646 * DEG2RAD, 36000.76983 * DEG2RAD, 0.0003032 * DEG2RAD] as const
	const TRUE_LONGITUDE_C = [1.914602 * DEG2RAD, -0.004817 * DEG2RAD, -0.000014 * DEG2RAD] as const
	const MEAN_ANOMALY = [357.52911 * DEG2RAD, 35999.05029 * DEG2RAD, -0.0001537 * DEG2RAD] as const
	const ECCENTRICITY = [0.016708634, -0.000042037, -0.0000001267] as const

	// Returns fresh [true longitude, true anomaly] in radians, normalized to [0, TAU),
	// for `T` Julian centuries of TT from J2000; mean equinox of date, about 0.01 degree over 1900–2100.
	export function trueLongitude(T: number): readonly [Angle, Angle] {
		const L0 = Base.horner(T, TRUE_LONGITUDE_L0)
		const m = meanAnomaly(T)
		const C = Base.horner(T, TRUE_LONGITUDE_C) * sin(m) + (0.019993 * DEG2RAD - 0.000101 * DEG2RAD * T) * sin(2 * m) + 0.000289 * DEG2RAD * sin(3 * m)
		return [normalizeAngle(L0 + C), normalizeAngle(m + C)]
	}

	// Returns the unwrapped Earth mean anomaly (radians) for `T` TT Julian centuries from J2000.
	export function meanAnomaly(T: number) {
		return Base.horner(T, MEAN_ANOMALY)
	}

	// Returns Earth's orbital eccentricity for `T` TT Julian centuries from J2000, near the modern epoch.
	export function eccentricity(T: number) {
		return Base.horner(T, ECCENTRICITY)
	}

	// Returns the approximate Sun–Earth distance in AU for `T` TT Julian centuries from J2000.
	export function radius(T: number) {
		const [, anomaly] = trueLongitude(T)
		const e = eccentricity(T)
		return (1.000001018 * (1 - e * e)) / (1 + e * cos(anomaly))
	}

	// Returns approximate apparent solar longitude (radians, [0, TAU)), including nutation and aberration,
	// for `T` TT Julian centuries from J2000; true equinox of date, about 0.01 degree over 1900–2100.
	export function apparentLongitude(T: number) {
		return normalizeAngle(trueLongitude(T)[0] - (0.00569 * DEG2RAD + 0.00478 * DEG2RAD * sin(node(T))))
	}

	// Returns the approximate lunar ascending node longitude (radians) for `T` TT Julian centuries.
	function node(T: number) {
		return 125.04 * DEG2RAD - 1934.136 * DEG2RAD * T
	}

	// Returns fresh [solar longitude in J2000, true anomaly] in radians, normalized to [0, TAU),
	// for `T` TT Julian centuries from J2000; about 0.01 degree accuracy over 1900–2100.
	export function true2000(T: number): readonly [Angle, Angle] {
		const [lon, anomaly] = trueLongitude(T)
		return [normalizeAngle(lon - 1.397 * DEG2RAD * T), anomaly]
	}

	// Returns fresh geometric [RA, declination] in radians at `jde` (TT), in the mean equator/equinox
	// of date. RA is [0, TAU); this uses the low-order longitude and neglects solar ecliptic latitude.
	export function trueEquatorial(jde: number): readonly [Angle, Angle] {
		return Coords.eclipticToEquatorial(trueLongitude(Base.j2000Century(jde))[0], 0, Nutation.meanObliquity(jde))
	}

	// Returns fresh apparent [RA, declination] in radians at `jde` (TT), in the true equator/equinox
	// of date. RA is [0, TAU); uses low-order longitude, aberration and nutation over 1900–2100.
	export function apparentEquatorial(jde: number): readonly [Angle, Angle] {
		const T = Base.j2000Century(jde)
		const epsilon = Nutation.meanObliquity(jde) + 0.00256 * DEG2RAD * cos(node(T))
		return Coords.eclipticToEquatorial(apparentLongitude(T), 0, epsilon)
	}

	// Returns fresh geocentric [longitude, latitude, distance] (radians, radians, AU) at `jde` (TT),
	// in the mean ecliptic/equinox of date with Meeus's solar FK5 correction. Longitude is [0, TAU).
	// Uses VSOP87E Earth-minus-Sun, reversed; excludes nutation and aberration (Meeus 25.9).
	export function trueVSOP87(jde: number): readonly [Angle, Angle, Distance] {
		const [lon, lat, distance] = PlanetPosition.position('earth', jde)
		const s = lon + PI
		const T = Base.j2000Century(jde)
		const lp = s - (1.397 + 0.00031 * T) * T * DEG2RAD
		return [normalizeAngle(s - 0.09033 * ASEC2RAD), 0.03916 * ASEC2RAD * (cos(lp) - sin(lp)) - lat, distance]
	}

	// Returns fresh apparent geocentric [longitude, latitude, distance] (radians, radians, AU) at
	// `jde` (TT), true ecliptic/equinox of date, FK5; includes nutation and low-order aberration.
	// Longitude is [0, TAU); latitude is unaffected by the nutation-in-longitude correction.
	export function apparentVSOP87(jde: number): readonly [Angle, Angle, Distance] {
		const [lon, lat, distance] = trueVSOP87(jde)
		return [normalizeAngle(lon + Nutation.nutation(jde)[0] + aberration(distance)), lat, distance]
	}

	// Returns fresh apparent geocentric [RA, declination, distance] (radians, radians, AU) at `jde`
	// (TT), true equator/equinox of date, FK5. RA is [0, TAU); includes nutation and low-order aberration.
	export function apparentEquatorialVSOP87(jde: number): readonly [Angle, Angle, Distance] {
		const [lon, lat, distance] = trueVSOP87(jde)
		const [dpsi, deps] = Nutation.nutation(jde)
		const [ra, dec] = Coords.eclipticToEquatorial(lon + dpsi + aberration(distance), lat, Nutation.meanObliquity(jde) + deps)
		return [ra, dec, distance]
	}

	// Returns the low-order solar aberration in longitude (radians) for Sun–Earth `range` (AU, > 0),
	// Meeus (25.10); omits the higher-order variation-of-longitude terms of p. 168.
	export function aberration(range: Distance) {
		return (-20.4898 * ASEC2RAD) / range
	}
}

// Chapter 26: Rectangular Coordinates of the Sun. All vectors are geocentric, in AU, and newly allocated.
export namespace SolarXYZ {
	// Returns the geometric Sun vector at `jde` (TT), in the mean equator/equinox of date, FK5.
	// Includes solar FK5 correction but no nutation or aberration; retains the full latitude factors.
	export function position(jde: number): Vec3 {
		const [lon, lat, range] = Solar.trueVSOP87(jde)
		const [se, ce] = Base.sincos(Nutation.meanObliquity(jde))
		const [sl, cl] = Base.sincos(lon)
		const [sb, cb] = Base.sincos(lat)
		return [range * cb * cl, range * (cb * sl * ce - sb * se), range * (cb * sl * se + sb * ce)]
	}

	// Returns solar geometric longitude (radians, [0, TAU)) at `jde` (TT), J2000 with the solar FK5 correction.
	export function longitudeJ2000(jde: number) {
		return normalizeAngle(PlanetPosition.position2000('earth', jde)[0] + PI - 0.09033 * ASEC2RAD)
	}

	// Returns the geometric Sun vector at `jde` (TT), in the dynamical ecliptic/equinox J2000.
	// The barycentric Sun and Earth are evaluated at the same instant; no light-time correction is applied.
	export function xyz(jde: number): Vec3 {
		const t = time(jde, 0, Timescale.TT)
		const [e] = vsop87e.earth(t, MEEUS_VSOP87_FRAME)
		const [s] = vsop87e.sun(t, MEEUS_VSOP87_FRAME)
		return [s[0] - e[0], s[1] - e[1], s[2] - e[2]]
	}

	// Returns the geometric Sun vector at `jde` (TT), in the mean equator/equinox J2000, FK5.
	// Uses the VSOP87-to-FK5 rotation of Meeus (26.3), not the ICRF rotation in the VSOP87E module.
	export function positionJ2000(jde: number): Vec3 {
		const [x, y, z] = xyz(jde)
		return [x + 0.00000044036 * y - 0.000000190919 * z, -0.000000479966 * x + 0.917482137087 * y - 0.397776982902 * z, 0.397776982902 * y + 0.917482137087 * z]
	}

	// Returns the geometric Sun vector at `jde` (TT), in the mean equator/equinox B1950 in FK5, not FK4.
	export function positionB1950(jde: number): Vec3 {
		const [x, y, z] = xyz(jde)
		return [0.999925702634 * x + 0.012189716217 * y + 0.000011134016 * z, -0.011179418036 * x + 0.917413998946 * y - 0.397777041885 * z, -0.004859003787 * x + 0.397747363646 * y + 0.917482111428 * z]
	}

	const POSITION_EQUINOX_ZETA = [2306.2181 * ASEC2RAD, 0.30188 * ASEC2RAD, 0.017998 * ASEC2RAD] as const
	const POSITION_EQUINOX_Z = [2306.2181 * ASEC2RAD, 1.09468 * ASEC2RAD, 0.018203 * ASEC2RAD] as const
	const POSITION_EQUINOX_THETA = [2004.3109 * ASEC2RAD, -0.42665 * ASEC2RAD, -0.041833 * ASEC2RAD] as const

	// Returns the geometric Sun vector at `jde` (TT), in the mean equator/equinox of Julian `epoch`
	// (year), FK5, using Meeus chapter 21 polynomial precession about J2000. Rotation preserves distance.
	export function positionEquinox(jde: number, epoch: number): Vec3 {
		const [x0, y0, z0] = positionJ2000(jde)
		const t = (epoch - 2000) * 0.01
		const zeta = Base.horner(t, POSITION_EQUINOX_ZETA) * t
		const z = Base.horner(t, POSITION_EQUINOX_Z) * t
		const theta = Base.horner(t, POSITION_EQUINOX_THETA) * t
		const [sZeta, cZeta] = Base.sincos(zeta)
		const [sz, cz] = Base.sincos(z)
		const [sTheta, cTheta] = Base.sincos(theta)
		const x = cZeta * x0 - sZeta * y0
		const y = sZeta * x0 + cZeta * y0
		const xx = cTheta * x - sTheta * z0
		return [cz * xx - sz * y, sz * xx + cz * y, sTheta * x + cTheta * z0]
	}
}

// Chapter 27: Equinoxes and Solstices. Event times are Julian ephemeris days in TT.
export namespace Solstice {
	// Meeus table 27.A: March, June, September, December polynomials for years -1000 to 1000.
	const EARLY = [
		[1721139.29189, 365242.1374, 0.06134, 0.00111, -0.00071],
		[1721233.25401, 365241.72562, -0.05323, 0.00907, 0.00025],
		[1721325.70455, 365242.49558, -0.11677, -0.00297, 0.00074],
		[1721414.39987, 365242.88257, -0.00769, -0.00933, -0.00006],
	] as const

	// Meeus table 27.B: corresponding polynomials for years 1000 to 3000, centered on 2000.
	const LATE = [
		[2451623.80984, 365242.37404, 0.05169, -0.00411, -0.00057],
		[2451716.56767, 365241.62603, 0.00325, 0.00888, -0.0003],
		[2451810.21715, 365242.01767, -0.11575, 0.00337, 0.00078],
		[2451900.05952, 365242.74049, -0.06223, -0.00823, 0.00032],
	] as const

	// Meeus table 27.C: amplitude in 1e-5 days, phase in degrees, frequency in degrees per Julian century.
	const TERMS = [
		[485, 324.96 * DEG2RAD, 1934.136 * DEG2RAD],
		[203, 337.23 * DEG2RAD, 32964.467 * DEG2RAD],
		[199, 342.08 * DEG2RAD, 20.186 * DEG2RAD],
		[182, 27.85 * DEG2RAD, 445267.112 * DEG2RAD],
		[156, 73.14 * DEG2RAD, 45036.886 * DEG2RAD],
		[136, 171.52 * DEG2RAD, 22518.443 * DEG2RAD],
		[77, 222.54 * DEG2RAD, 65928.934 * DEG2RAD],
		[74, 296.72 * DEG2RAD, 3034.906 * DEG2RAD],
		[70, 243.58 * DEG2RAD, 9037.513 * DEG2RAD],
		[58, 119.81 * DEG2RAD, 33718.147 * DEG2RAD],
		[52, 297.17 * DEG2RAD, 150.678 * DEG2RAD],
		[50, 21.02 * DEG2RAD, 2281.226 * DEG2RAD],
		[45, 247.54 * DEG2RAD, 29929.562 * DEG2RAD],
		[44, 325.15 * DEG2RAD, 31555.956 * DEG2RAD],
		[29, 60.93 * DEG2RAD, 4443.417 * DEG2RAD],
		[18, 155.12 * DEG2RAD, 67555.328 * DEG2RAD],
		[17, 288.79 * DEG2RAD, 4562.452 * DEG2RAD],
		[16, 198.04 * DEG2RAD, 62894.029 * DEG2RAD],
		[14, 199.76 * DEG2RAD, 31436.921 * DEG2RAD],
		[12, 95.39 * DEG2RAD, 14577.848 * DEG2RAD],
		[12, 287.11 * DEG2RAD, 31931.756 * DEG2RAD],
		[12, 320.81 * DEG2RAD, 34777.259 * DEG2RAD],
		[9, 227.73 * DEG2RAD, 1222.114 * DEG2RAD],
		[8, 15.45 * DEG2RAD, 16859.074 * DEG2RAD],
	] as const

	// Evaluates the season `index` (March=0 through December=3) polynomial for integer calendar `year`.
	function estimate(year: number, index: number) {
		return Base.horner((year < 1000 ? year : year - 2000) * 0.001, (year < 1000 ? EARLY : LATE)[index])
	}

	// Adds periodic corrections to the season `index` estimate for integer calendar `year`.
	function approximate(year: number, index: number) {
		const jde = estimate(year, index)
		const T = Base.j2000Century(jde)
		const W = 35999.373 * DEG2RAD * T - 2.47 * DEG2RAD
		let sum = 0

		for (let i = TERMS.length - 1; i >= 0; i--) {
			const [a, b, c] = TERMS[i]
			sum += a * cos(b + c * T)
		}

		return jde + (0.00001 * sum) / (1 + 0.0334 * cos(W) + 0.0007 * cos(2 * W))
	}

	// Returns the March equinox JDE (TT) for integer `year`, -1000..3000; within a minute over 1951–2050.
	export function march(year: number) {
		return approximate(year, 0)
	}

	// Returns the June solstice JDE (TT) for integer `year`, -1000..3000; within a minute over 1951–2050.
	export function june(year: number) {
		return approximate(year, 1)
	}

	// Returns the September equinox JDE (TT) for integer `year`, -1000..3000; within a minute over 1951–2050.
	export function september(year: number) {
		return approximate(year, 2)
	}

	// Returns the December solstice JDE (TT) for integer `year`, -1000..3000; within a minute over 1951–2050.
	export function december(year: number) {
		return approximate(year, 3)
	}

	// Returns the VSOP87E March equinox JDE (TT) for integer `year`, or undefined if refinement fails; see longitude.
	export function march2(year: number) {
		return longitude(year, 0)
	}

	// Returns the VSOP87E June solstice JDE (TT) for integer `year`, or undefined if refinement fails; see longitude.
	export function june2(year: number) {
		return longitude(year, PIOVERTWO)
	}

	// Returns the VSOP87E September equinox JDE (TT) for integer `year`, or undefined if refinement fails; see longitude.
	export function september2(year: number) {
		return longitude(year, PI)
	}

	// Returns the VSOP87E December solstice JDE (TT) for integer `year`, or undefined if refinement fails; see longitude.
	export function december2(year: number) {
		return longitude(year, 3 * PIOVERTWO)
	}

	// Returns the JDE (TT) when apparent geocentric solar longitude reaches `lon` (radians, wrapped).
	// The solar year begins with the March equinox of integer `year`: targets after December can fall
	// in January–March of the next calendar year. Uses Meeus (27.1), with a 0.432-second step tolerance;
	// absolute accuracy also depends on VSOP87E and precession. Returns undefined after 32 iterations
	// to prevent non-convergence from hanging for epochs outside the model's useful range.
	export function longitude(year: number, lon: Angle): number | undefined {
		lon = normalizeAngle(lon)
		let jde = estimate(year, floor(lon / PIOVERTWO))

		for (let i = 0; i < 32; i++) {
			const step = 58 * sin(lon - Solar.apparentVSOP87(jde)[0])
			jde += step
			if (abs(step) < 0.000005) return jde
		}

		return undefined
	}
}

// Chapter 28: Equation of Time. Positive values mean apparent solar time leads mean solar time.
export namespace EquationOfTime {
	const MEAN_LONGITUDE = [280.4664567 * DEG2RAD, 360007.6982779 * DEG2RAD, 0.03032028 * DEG2RAD, (1 / 49931) * DEG2RAD, (-1 / 15300) * DEG2RAD, (-1 / 2000000) * DEG2RAD] as const

	// Returns unwrapped solar mean longitude (radians) for `tau` TT Julian millennia from J2000, Meeus (28.2).
	function meanLongitude(tau: number) {
		return Base.horner(tau, MEAN_LONGITUDE)
	}

	// Returns apparent minus mean solar time as an hour angle (radians, [-PI, PI)) at `jde` (TT),
	// using VSOP87E, nutation and solar aberration. Multiply by 43200/PI to obtain seconds of time.
	export function e(jde: number) {
		const L0 = meanLongitude(Base.j2000Century(jde) * 0.1)
		const [lon, lat, range] = Solar.trueVSOP87(jde)
		const [dp, de] = Nutation.nutation(jde)
		const epsilon = Nutation.meanObliquity(jde) + de
		const [ra] = Coords.eclipticToEquatorial(lon + dp + Solar.aberration(range), lat, epsilon)
		return pmod(L0 - 0.0057183 * DEG2RAD - ra + dp * cos(epsilon) + PI, TAU) - PI
	}

	// Returns approximate apparent minus mean solar time as an hour angle (radians) at `jde` (TT).
	// Uses the low-order eccentricity/obliquity formula (28.3), near the modern epoch; no VSOP evaluation.
	export function eSmart(jde: number) {
		const t = tan(Nutation.meanObliquity(jde) * 0.5)
		const y = t * t
		const T = Base.j2000Century(jde)
		const L0 = meanLongitude(T * 0.1)
		const eccentricity = Solar.eccentricity(T)
		const M = Solar.meanAnomaly(T)
		const [s2L0, c2L0] = Base.sincos(2 * L0)
		return y * s2L0 - 2 * eccentricity * sin(M) + 4 * eccentricity * y * sin(M) * c2L0 - y * y * s2L0 * c2L0 - 1.25 * eccentricity * eccentricity * sin(2 * M)
	}
}

// Chapter 29: Ephemeris for Physical Observations of the Sun.
export namespace SolarDisk {
	// Returns fresh [P, B0, L0] in radians at `jde` (TT): apparent position angle of solar north
	// eastward from celestial north, heliographic disk-center latitude, and Carrington disk-center
	// longitude ([0, TAU)). Uses VSOP87E, nutation and low-order solar aberration, Meeus chapter 29.
	export function ephemeris(jde: number): readonly [Angle, Angle, Angle] {
		const theta = ((jde - 2398220) * TAU) / 25.38
		const I = 7.25 * DEG2RAD
		const K = 73.6667 * DEG2RAD + (1.3958333 * DEG2RAD * (jde - 2396758)) / Base.JULIAN_CENTURY
		const [L, , R] = Solar.trueVSOP87(jde)
		const [dp, de] = Nutation.nutation(jde)
		const epsilon = Nutation.meanObliquity(jde) + de
		const lambda = L + Solar.aberration(R)
		const [slk, clk] = Base.sincos(lambda - K)
		const [si, ci] = Base.sincos(I)
		const P = atan(-cos(lambda + dp) * tan(epsilon)) + atan(-clk * tan(I))
		return [P, asin(slk * si), normalizeAngle(atan2(-slk * ci, -clk) - theta)]
	}

	// Returns the Julian ephemeris day (TT) of the start of Carrington rotation number `c`
	// (integer), using the synodic-period approximation and periodic correction of Meeus chapter 29.
	export function cycle(c: number) {
		const jde = 2398140.227 + 27.2752316 * c
		const m = 281.96 * DEG2RAD + 26.882476 * DEG2RAD * c
		return jde + 0.1454 * sin(m) - 0.0085 * sin(2 * m) - 0.0141 * cos(2 * m)
	}
}

// Chapter 30: Equation of Kepler.
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
			m = TAU - m
		}

		let E0 = PIOVERTWO
		let d = PIOVERFOUR

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

// Chapter 31: Elements of Planetary Orbits.
// Partial: Only implemented for mean equinox of date.
export namespace PlanetElements {
	export interface Elements {
		L: Angle // mean longitude
		a: Distance // semimajor axis
		e: Angle // eccentricity
		i: Angle // inclination
		omega: Angle // longitude of ascending node
		w: Angle // longitude of perihelion (Meeus likes pi better)
	}

	// Table 31.A, p. 212
	const CMEAN = {
		mercury: {
			L: [252.250906, 149474.0722491, 0.0003035, 0.000000018],
			a: [0.38709831],
			e: [0.20563175, 0.000020407, -0.0000000283, -0.00000000018],
			i: [7.004986, 0.0018215, -0.0000181, 0.000000056],
			omega: [48.330893, 1.1861883, 0.00017542, 0.000000215],
			w: [77.456119, 1.5564776, 0.00029544, 0.000000009],
		},
		venus: {
			L: [181.979801, 58519.2130302, 0.00031014, 0.000000015],
			a: [0.72332982],
			e: [0.00677192, -0.000047765, 0.0000000981, 0.00000000046],
			i: [3.394662, 0.0010037, -0.00000088, -0.000000007],
			omega: [76.67992, 0.9011206, 0.00040618, -0.000000093],
			w: [131.563703, 1.4022288, -0.00107618, -0.000005678],
		},
		earth: {
			L: [100.466457, 36000.7698278, 0.00030322, 0.00000002],
			a: [1.000001018],
			e: [0.01670863, -0.000042037, -0.0000001267, 0.00000000014],
			i: [0],
			omega: undefined,
			w: [102.937348, 1.7195366, 0.00045688, -0.000000018],
		},
		mars: {
			L: [355.433, 19141.6964471, 0.00031052, 0.000000016],
			a: [1.523679342],
			e: [0.09340065, 0.000090484, -0.0000000806, -0.00000000025],
			i: [1.849726, -0.0006011, 0.00001276, -0.000000007],
			omega: [49.558093, 0.7720959, 0.00001557, 0.000002267],
			w: [336.060234, 1.8410449, 0.00013477, 0.000000536],
		},
		jupiter: {
			L: [34.351519, 3036.3027748, 0.0002233, 0.000000037],
			a: [5.202603209, 0.0000001913],
			e: [0.04849793, 0.000163225, -0.0000004714, -0.00000000201],
			i: [1.303267, -0.0054965, 0.00000466, -0.000000002],
			omega: [100.464407, 1.0209774, 0.00040315, 0.000000404],
			w: [14.331207, 1.6126352, 0.00103042, -0.000004464],
		},
		saturn: {
			L: [50.077444, 1223.5110686, 0.00051908, -0.00000003],
			a: [9.554909192, -0.000002139, 0.000000004],
			e: [0.05554814, -0.000346641, -0.0000006436, 0.0000000034],
			i: [2.488879, -0.0037362, -0.00001519, 0.000000087],
			omega: [113.665503, 0.877088, -0.00012176, -0.000002249],
			w: [93.057237, 1.9637613, 0.00083753, 0.000004928],
		},
		uranus: {
			L: [314.055005, 429.8640561, 0.0003039, 0.000000026],
			a: [19.218446062, -0.0000000372, 0.00000000098],
			e: [0.04638122, -0.000027293, 0.0000000789, 0.00000000024],
			i: [0.773197, 0.0007744, 0.00003749, -0.000000092],
			omega: [74.005957, 0.5211278, 0.00133947, 0.000018484],
			w: [173.005291, 1.486379, 0.00021406, 0.000000434],
		},
		neptune: {
			L: [304.348665, 219.8833092, 0.00030882, 0.000000018],
			a: [30.110386869, -0.0000001663, 0.00000000069],
			e: [0.00945575, 0.000006033, 0, -0.00000000005],
			i: [1.769953, -0.0093082, -0.00000708, 0.000000027],
			omega: [131.784057, 1.1022039, 0.00025952, -0.000000637],
			w: [48.120276, 1.4262957, 0.00038434, 0.00000002],
		},
	} as const

	// Returns mean orbital elements for a planet
	// Results are referenced to mean dynamical ecliptic and equinox of date.
	export function mean(p: keyof typeof CMEAN, jde: number, o?: Elements): Elements {
		const T = Base.j2000Century(jde)
		const c = CMEAN[p]
		o ??= {} as Elements
		o.L = normalizeAngle(Base.horner(T, c.L) * DEG2RAD)
		o.a = Base.horner(T, c.a)
		o.e = Base.horner(T, c.e)
		o.i = Base.horner(T, c.i) * DEG2RAD
		o.omega = c.omega !== undefined ? Base.horner(T, c.omega) * DEG2RAD : 0
		o.w = Base.horner(T, c.w) * DEG2RAD
		return o
	}

	// Returns mean inclination for a planet at a date.
	export function inc(p: keyof typeof CMEAN, jde: number) {
		return Base.horner(Base.j2000Century(jde), CMEAN[p].i) * DEG2RAD
	}

	// Returns mean longitude of ascending node for a planet at a date.
	export function node(p: keyof typeof CMEAN, jde: number) {
		return p === 'earth' ? 0 : Base.horner(Base.j2000Century(jde), CMEAN[p].omega) * DEG2RAD
	}
}

// Chapter 32: Positions of the Planets.
export namespace PlanetPosition {
	// VSOP87E evaluators for the eight planets; the Sun is evaluated separately to shift the origin.
	const PLANETS = {
		mercury: vsop87e.mercury,
		venus: vsop87e.venus,
		earth: vsop87e.earth,
		mars: vsop87e.mars,
		jupiter: vsop87e.jupiter,
		saturn: vsop87e.saturn,
		uranus: vsop87e.uranus,
		neptune: vsop87e.neptune,
	} as const

	// Planet supported by the VSOP87E solution; Earth denotes its center, not the Earth-Moon barycenter.
	export type Planet = keyof typeof PLANETS

	// Heliocentric ecliptic longitude (radians, [0, TAU)), latitude (radians, [-PI/2, PI/2]), and distance (AU).
	export type Position = readonly [longitude: Angle, latitude: Angle, distance: Distance]

	// Computes the geometric heliocentric position of `planet` at Julian ephemeris day `jde` (TT).
	// Returns a fresh tuple in the dynamical ecliptic and equinox J2000, using VSOP87E planet-minus-Sun
	// vectors at the same instant. This replaces VSOP87B with equivalent coordinates, not identical series.
	// No light-time, aberration, nutation, or FK5 correction is applied.
	export function position2000(planet: Planet, jde: number): Position {
		const t = time(jde, 0, Timescale.TT)
		const [p] = PLANETS[planet](t, MEEUS_VSOP87_FRAME)
		const [s] = vsop87e.sun(t, MEEUS_VSOP87_FRAME)
		const x = p[0] - s[0]
		const y = p[1] - s[1]
		const z = p[2] - s[2]
		return [normalizeAngle(atan2(y, x)), atan2(z, hypot(x, y)), hypot(x, y, z)]
	}

	// Computes the geometric heliocentric position of `planet` at Julian ephemeris day `jde` (TT).
	// Returns a fresh tuple in the mean dynamical ecliptic and equinox of date, using the Meeus chapter 21
	// polynomial precession approximation about J2000. Distance is unchanged by precession.
	// No light-time, aberration, nutation, or FK5 correction is applied.
	export function position(planet: Planet, jde: number): Position {
		const [lon, lat, distance] = position2000(planet, jde)
		const p = new Precession.EclipticPrecessor(2000, Base.jdeToJulianYear(jde))
		const [longitude, latitude] = p.precess(lon, lat)
		return [normalizeAngle(longitude), latitude, distance]
	}

	// Applies Meeus's first-order dynamical-to-FK5 correction to nonpolar ecliptic longitude `lon`
	// and latitude `lat` (radians), referred to the mean equinox of `jde` (Julian ephemeris day, TT).
	// Returns a fresh [longitude, latitude] tuple in radians, with longitude normalized to [0, TAU).
	// This changes the reference system, not the equinox; no precession or apparent-place corrections occur.
	export function toFK5(lon: Angle, lat: Angle, jde: number): readonly [Angle, Angle] {
		// Formula (32.3), Meeus, Astronomical Algorithms, p. 219.
		const T = Base.j2000Century(jde)
		const lp = lon - (1.397 + 0.00031 * T) * T * DEG2RAD
		const slp = sin(lp)
		const clp = cos(lp)
		const longitude = lon + (-0.09033 + 0.03916 * (clp + slp) * tan(lat)) * ASEC2RAD
		const latitude = lat + 0.03916 * (clp - slp) * ASEC2RAD
		return [normalizeAngle(longitude), latitude]
	}
}

// Chapter 33: Elliptic Motion. Solar orbits, geometric light time and apparent planet positions.
export namespace Elliptic {
	// Returns fresh apparent geocentric [RA, declination] (radians, RA [0, TAU)) for planet
	// other than Earth at jde (TT). Includes one light-time refinement, aberration, FK5 and nutation.
	export function position(planet: Exclude<PlanetPosition.Planet, 'earth'>, jde: number): readonly [Angle, Angle] {
		const [L0, B0, R0] = PlanetPosition.position('earth', jde)
		const X = R0 * cos(B0) * cos(L0)
		const Y = R0 * cos(B0) * sin(L0)
		const Z = R0 * sin(B0)
		let x = 0
		let y = 0
		let z = 0
		let tau = 0

		for (let i = 0; i < 2; i++) {
			// Keep the retarded planet and reception-time Earth in the same ecliptic of date.
			const [l, b, r] = PlanetPosition.position2000(planet, jde - tau)
			const [L, B] = new Precession.EclipticPrecessor(2000, Base.jdeToJulianYear(jde)).precess(l, b)
			x = r * cos(B) * cos(L) - X
			y = r * cos(B) * sin(L) - Y
			z = r * sin(B) - Z
			tau = Base.lightTime(hypot(x, y, z))
		}

		const lambda = atan2(y, x)
		const beta = atan2(z, hypot(x, y))
		const [dl, db] = Apparent.eclipticAberration(lambda, beta, jde)
		const [lon, lat] = PlanetPosition.toFK5(lambda + dl, beta + db, jde)
		const [dp, de] = Nutation.nutation(jde)
		return Coords.eclipticToEquatorial(lon + dp, lat, Nutation.meanObliquity(jde) + de)
	}

	// Fixed heliocentric Keplerian elements referred to the mean ecliptic and equinox J2000.
	export class Elements {
		// Creates an elliptic solar orbit with axis > 0 AU, 0 <= ecc < 1, angles in radians
		// and perihelion time timeP as a TT Julian day; no perturbations are modeled.
		constructor(
			// Semimajor axis in AU.
			readonly axis: Distance,
			// Dimensionless eccentricity, [0, 1).
			readonly ecc: number,
			// Inclination to the J2000 ecliptic in radians.
			readonly inc: Angle,
			// Argument of perihelion in radians.
			readonly argP: Angle,
			// Ascending-node longitude in radians.
			readonly node: Angle,
			// Perihelion TT Julian day.
			readonly timeP: number,
		) {}

		// Returns fresh astrometric geocentric [RA, declination, elongation] in radians at jde (TT),
		// in equatorial J2000 axes; RA is [0, TAU). Uses one light-time refinement.
		position(jde: number): readonly [Angle, Angle, Angle] {
			const n = Base.K / this.axis / sqrt(this.axis)
			const [so, co] = Base.sincos(this.node)
			const [si, ci] = Base.sincos(this.inc)
			const se = Base.SIN_OBL_J2000
			const ce = Base.COS_OBL_J2000
			const F = co
			const G = so * ce
			const H = so * se
			const P = -so * ci
			const Q = co * ci * ce - si * se
			const R = co * ci * se + si * ce

			// Returns a fresh heliocentric equatorial J2000 vector in AU at TT day t.
			const f = (t: number): Vec3 => {
				const M = normalizeAngle(n * (t - this.timeP))
				let E = 0

				try {
					E = Kepler.kepler2b(this.ecc, M, 15)
				} catch {
					E = Kepler.kepler3(this.ecc, M)
				}

				const u = this.argP + Kepler.trueAnomaly(E, this.ecc)
				const r = Kepler.radius(E, this.ecc, this.axis)
				return [r * (F * cos(u) + P * sin(u)), r * (G * cos(u) + Q * sin(u)), r * (H * cos(u) + R * sin(u))]
			}

			return astrometricJ2000(f, jde)
		}
	}

	// Returns fresh astrometric geocentric [RA, declination, solar elongation] in radians
	// (RA [0, TAU)) at jde (TT). f(t) supplies heliocentric equatorial J2000 XYZ in AU at TT day t.
	// Uses Earth's reception-time position and one light-time refinement; the body must not
	// coincide with Earth. Does not apply aberration, nutation or gravitational deflection.
	export function astrometricJ2000(f: (jde: number) => Vec3, jde: number): readonly [Angle, Angle, Angle] {
		const [X, Y, Z] = SolarXYZ.positionJ2000(jde)
		let x = 0
		let y = 0
		let z = 0
		let tau = 0

		for (let i = 0; i < 2; i++) {
			const v = f(jde - tau)
			x = X + v[0]
			y = Y + v[1]
			z = Z + v[2]
			tau = Base.lightTime(hypot(x, y, z))
		}

		const elongation = atan2(hypot(y * Z - z * Y, z * X - x * Z, x * Y - y * X), x * X + y * Y + z * Z)
		return [normalizeAngle(atan2(y, x)), atan2(z, hypot(x, y)), elongation]
	}

	// Returns instantaneous solar orbital speed in km/s for semimajor axis a and radius r in AU.
	export function velocity(a: Distance, r: Distance) {
		return 42.1219 * sqrt(1 / r - 0.5 / a)
	}

	// Returns aphelion speed in km/s for semimajor axis a > 0 AU and eccentricity e in [0, 1).
	export function vAphelion(a: Distance, e: number) {
		return 29.7847 * sqrt((1 - e) / (1 + e) / a)
	}

	// Returns perihelion speed in km/s for semimajor axis a > 0 AU and eccentricity e in [0, 1).
	export function vPerihelion(a: Distance, e: number) {
		return 29.7847 * sqrt((1 + e) / (1 - e) / a)
	}

	// Returns Ramanujan's approximate circumference for semimajor axis a > 0 and 0 <= e < 1,
	// in the units of a. Accuracy degrades as eccentricity approaches one.
	export function length1(a: number, e: number) {
		const b = a * sqrt(1 - e * e)
		return PI * (3 * (a + b) - sqrt((a + 3 * b) * (3 * a + b)))
	}

	// Returns Meeus's alternate approximate circumference, in units of semimajor axis a > 0,
	// for 0 <= e < 1; accuracy degrades as eccentricity approaches one.
	export function length2(a: number, e: number) {
		const b = a * sqrt(1 - e * e)
		const s = a + b
		const p = a * b
		return PI * (21 * s * 0.5 - 2 * sqrt(p) - (6 * p) / s) * 0.125
	}

	// Returns the convergent-series circumference in units of semimajor axis a > 0, for 0 <= e < 1.
	// Stops at floating-point convergence; returns undefined after 10000 terms to bound work.
	export function length4(a: number, e: number) {
		const b = a * sqrt(1 - e * e)
		const m = (a - b) / (a + b)
		const m2 = m * m
		let sum = 1
		let term = m2 * 0.25

		for (let i = 1; i <= 10000; i++) {
			const next = sum + term
			if (next === sum) return (TAU * a * sum) / (1 + m)
			sum = next
			term *= ((2 * i - 1) ** 2 * m2) / (2 * i + 2) ** 2
		}

		return undefined
	}
}

// Chapter 34: Parabolic Motion.
export namespace Parabolic {
	// Elements holds parabolic elements needed for computing true anomaly and distance.
	export class Elements {
		constructor(
			readonly T: number,
			readonly q: Distance,
		) {}

		// Returns fresh [true anomaly in -PI..PI radians, distance in AU] at TT jde for perihelion
		// T (TT JD) and q > 0 AU. Barker's hyperbolic form avoids cancellation on the inbound branch.
		anomalyDistance(jde: number): readonly [Angle, Distance] {
			const W = (((3 * Base.K) / SQRT2) * (jde - this.T)) / this.q / sqrt(this.q)
			const G = W * 0.5
			const s = 2 * sinh(asinh(G) / 3)
			const nu = 2 * atan(s)
			const r = this.q * (1 + s * s)
			return [nu, r]
		}
	}
}

// Chapter 35: Near-parabolic Motion.
export namespace NearParabolic {
	// Holds orbital elements for near-parabolic orbits: time of Perihelion [T], Perihelion distance, [q] and eccentricity [e].
	export class Elements {
		constructor(
			readonly T: number,
			readonly q: Distance,
			readonly e: number,
		) {}

		// Returns true anomaly (nu) and distance for near-parabolic orbits.
		// An error is returned if the algorithm fails to converge.
		anomalyDistance(jde: number): readonly [Angle, Distance, string?] {
			// Fairly literal translation of code on p. 246
			const q1 = (Base.K * sqrt((1 + this.e) / this.q)) / (2 * this.q)
			const g = (1 - this.e) / (1 + this.e)
			const t = jde - this.T

			if (t === 0) return [0, this.q]

			const d1 = 1e4
			const d = 1e-9
			const q2 = q1 * t
			let s = 2 / (3 * abs(q2))
			s = 2 / tan(2 * atan(cbrt(tan(atan(s) / 2))))

			if (t < 0) {
				s = -s
			}

			if (this.e !== 1) {
				let l = 0

				while (true) {
					const s0 = s
					let z = 1
					const y = s * s
					let g1 = -y * s
					let q3 = q2 + (2 * g * s * y) / 3

					while (true) {
						z += 1
						g1 = -g1 * g * y
						const z1 = (z - (z + 1) * g) / (2 * z + 1)
						const f = z1 * g1
						q3 += f

						if (z > 50 || abs(f) > d1) {
							return [0, 0, 'no convergence']
						}

						if (abs(f) <= d) break
					}

					l++

					if (l > 50) {
						return [0, 0, 'no convergence']
					}

					while (true) {
						const s1 = s

						s = ((2 * s * s * s) / 3 + q3) / (s * s + 1)

						if (abs(s - s1) <= d) break
					}

					if (abs(s - s0) <= d) break
				}
			}

			let nu = 2 * atan(s)
			const r = (this.q * (1 + this.e)) / (1 + this.e * cos(nu))

			if (nu < 0) {
				nu += TAU
			}

			return [nu, r]
		}
	}
}

// Chapter 36: The Calculation of some Planetary Phenomena.
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

// Chapter 38: Planets in Perihelion and Aphelion. Polynomial estimates and bounded VSOP87 refinement.
export namespace Perihelion {
	// Bodies supported by the chapter 38 estimates; embary is the Earth–Moon barycenter.
	export type Planet = PlanetPosition.Planet | 'embary'

	// Meeus chapter 38: cycles per year, reference decimal year, and TT Julian-day polynomial in k.
	const COEFFICIENTS = {
		mercury: [4.15201, 2000.12, [2451590.257, 87.96934963]],
		venus: [1.62549, 2000.53, [2451738.233, 224.7008188, -0.0000000327]],
		earth: [0.99997, 2000.01, [2451547.507, 365.2596358, 0.0000000156]],
		mars: [0.53166, 2001.78, [2452195.026, 686.9957857, -0.0000001187]],
		jupiter: [0.0843, 2011.2, [2455636.936, 4332.897065, 0.0001367]],
		saturn: [0.03393, 2003.52, [2452830.12, 10764.21676, 0.000827]],
		uranus: [0.0119, 2051.1, [2470213.5, 30694.8767, -0.00541]],
		neptune: [0.00607, 2047.5, [2468895.1, 60190.33, 0.03429]],
	} as const

	// Earth correction terms: argument intercept/rate (degrees per cycle), perihelion/aphelion amplitudes (days).
	const EARTH_TERMS = [
		[328.41, 132.788585, 1.278, -1.352],
		[316.13, 584.903153, -0.055, 0.061],
		[346.2, 450.380738, -0.091, 0.062],
		[136.95, 659.306737, -0.056, 0.029],
		[249.52, 329.653368, -0.045, 0.031],
	] as const

	// Returns the approximate perihelion TT Julian day for body p near decimal year year,
	// using Meeus chapter 38 (roughly 1600–2400). Outer-planet errors can be months or years.
	export function perihelion(p: Planet, year: number) {
		return approximate(p, year, false)
	}

	// Returns the approximate aphelion TT Julian day for body p near decimal year year,
	// using Meeus chapter 38 (roughly 1600–2400). Outer-planet errors can be months or years.
	export function aphelion(p: Planet, year: number) {
		return approximate(p, year, true)
	}

	// Evaluates the apsis polynomial for p near decimal year year; ap selects aphelion.
	// Returns a TT Julian day, applying lunar perturbations only to Earth, not embary.
	function approximate(p: Planet, year: number, ap: boolean) {
		const [rate, epoch, c] = COEFFICIENTS[p === 'embary' ? 'earth' : p]
		const cycles = rate * (year - epoch)
		const k = ap ? floor(cycles) + 0.5 : floor(cycles + 0.5)
		let jde = Base.horner(k, c)
		if (p === 'earth') for (const [a, b, peri, aph] of EARTH_TERMS) jde += (ap ? aph : peri) * sin((a + b * k) * DEG2RAD)
		return jde
	}

	// Returns fresh [TT Julian day, heliocentric distance AU] for planet's perihelion near decimal
	// year year, or undefined if no bracket/refinement converges. precision > 0 is a time tolerance
	// in days, independent of ephemeris accuracy. See refine() for the bounded search window.
	// For Neptune, returns the closer-to-Sun member of its double minimum, as in Meeus chapter 38.
	export function perihelion2(planet: PlanetPosition.Planet, year: number, precision: number = 0.01): readonly [number, Distance] | undefined {
		return refine(planet, year, precision, false)
	}

	// Returns fresh [TT Julian day, heliocentric distance AU] for planet's aphelion near decimal
	// year year, or undefined if no bracket/refinement converges. precision > 0 is a time tolerance
	// in days, independent of ephemeris accuracy. See refine() for the bounded search window.
	// For Neptune, returns the farther-from-Sun member of its double maximum, as in Meeus chapter 38.
	export function aphelion2(planet: PlanetPosition.Planet, year: number, precision: number = 0.01): readonly [number, Distance] | undefined {
		return refine(planet, year, precision, true)
	}

	// Refines the chapter 38 estimate for planet/year with ap selecting aphelion and positive
	// precision in days. Samples 128 intervals over +/- one eighth of an orbital period, or
	// +/- 5000 days for Neptune's double extrema; refines each sampled local extremum with at
	// most 100 Brent iterations and selects the most extreme distance. This covers the broad
	// apsides near the estimate in 1600–2400, not arbitrary high-frequency perturbation extrema.
	// Returns undefined when no interior extremum is bracketed or any refinement fails.
	function refine(planet: PlanetPosition.Planet, year: number, precision: number, ap: boolean): readonly [number, Distance] | undefined {
		const center = approximate(planet, year, ap)
		const span = planet === 'neptune' ? 5000 : COEFFICIENTS[planet][2][1] / 8
		const step = span / 64
		const sign = ap ? -1 : 1
		// Signed radius in AU at offset t days from center; minimization handles both apsis kinds.
		const f = (t: number) => sign * PlanetPosition.position2000(planet, center + t)[2]
		let left = -span
		let middle = left + step
		let fl = f(left)
		let fm = f(middle)
		let best: readonly [number, Distance] | undefined

		for (let i = 2; i <= 128; i++) {
			const right = -span + i * step
			const fr = f(right)

			if (fm < fl && fm < fr) {
				const result = brentMinimize(f, left, right, { tolerance: precision, maxIterations: 100 })
				if (!result.converged) return undefined
				const radius = sign * result.value
				if (!best || result.value < sign * best[1]) best = [center + result.minimum, radius]
			}

			left = middle
			middle = right
			fl = fm
			fm = fr
		}

		return best
	}
}

// Chapter 39: Passages through the Nodes.
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

// Chapter 40: Correction for Parallax.
export namespace Parallax {
	export const HOR_PAR = 8.794 * ASEC2RAD

	// Computes equatorial horizontal parallax of a body.
	export function horizontal(delta: Distance): Angle {
		// (40.1) p. 279
		return asin(sin(HOR_PAR) / delta)
		// return horPar / delta // with sufficient accuracy
	}

	// Returns fresh topocentric [RA, declination] in radians from geocentric RA/declination,
	// distance (AU), dimensionless parallax constants, west-positive longitude (radians) and jde.
	// RA follows the input branch plus its correction; vector components preserve polar quadrants.
	export function topocentric(rightAscension: Angle, declination: Angle, distance: Distance, rhosPhi: number, rhocPhi: number, longitude: Angle, jde: number) {
		const pi = horizontal(distance)
		const theta0 = secondsOfTime(Sidereal.apparent(jde))
		const H = normalizeAngle(theta0 - longitude - rightAscension)
		const sPi = sin(pi)
		const [sH, cH] = Base.sincos(H)
		const [sDelta, cDelta] = Base.sincos(declination)
		const deltaAlpha = atan2(-rhocPhi * sPi * sH, cDelta - rhocPhi * sPi * cH) // (40.2) p. 279
		const alpha = rightAscension + deltaAlpha
		const delta = atan2(sDelta - rhosPhi * sPi, hypot(cDelta - rhocPhi * sPi * cH, rhocPhi * sPi * sH)) // (40.3), preserving the polar quadrant
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
		const sPi = sin(pi)
		const [sH, cH] = Base.sincos(H)
		const [sDelta, cDelta] = Base.sincos(declination)
		const A = cDelta * sH
		const B = cDelta * cH - rhocPhi * sPi
		const C = sDelta - rhosPhi * sPi
		return [atan2(A, B), atan2(C, hypot(A, B))] as const
	}

	// Computes topocentric ecliptical coordinates including parallax given geocentric ecliptical longitude and latitude of a body,
	// the geocentric semidiameter (s), the observer's latitude and and height above the ellipsoid (phi and h),
	// the obliquity of the ecliptic (epsilon), the local sidereal time (theta), and the equatorial horizontal parallax of the body (pi).
	// All angles, including s and theta, are radians; height h is AU. Returns a fresh [longitude in
	// 0..TAU, latitude, semidiameter] in radians for an observer outside the body. Uses the translated
	// vector's norm to avoid division by its vanishing X component at longitude PI/2 or 3*PI/2.
	export function topocentricEcliptical(longitude: Angle, latitude: Angle, s: Angle, phi: Angle, h: Distance, epsilon: Angle, theta: Angle, pi: Angle) {
		const [S, C] = Globe.EARTH76.parallaxConstants(phi, h)
		const [sLambda, cLambda] = Base.sincos(longitude)
		const [sBeta, cBeta] = Base.sincos(latitude)
		const [sEpsilon, cEpsilon] = Base.sincos(epsilon)
		const [sTheta, cTheta] = Base.sincos(theta)
		const sPi = sin(pi)
		const N = cLambda * cBeta - C * sPi * cTheta
		const Y = sLambda * cBeta - sPi * (S * sEpsilon + C * cEpsilon * sTheta)
		const Z = sBeta - sPi * (S * cEpsilon - C * sEpsilon * sTheta)
		const lambda = normalizeAngle(atan2(Y, N))
		const beta = atan2(Z, hypot(N, Y))
		const s_ = asin(min(1, sin(s) / hypot(N, Y, Z)))
		return [lambda, beta, s_]
	}
}

// Chapter 41: Illuminated Fraction of the Disk and Magnitude of a Planet.
export namespace Illuminated {
	// Computes the phase angle of a planet.
	// r is planet's distance to Sun, delta its distance to Earth, and R the distance from Sun to Earth. All distances in AU.
	export function phaseAngle(r: Distance, delta: Distance, R: Distance) {
		return acos(max(-1, min(1, (r * r + delta * delta - R * R) / (2 * r * delta))))
	}

	// Computes the illuminated fraction of the disk of a planet.
	// r is planet's distance to Sun, delta its distance to Earth, and R the distance from Sun to Earth. All distances in AU.
	export function fraction(r: Distance, delta: Distance, R: Distance) {
		// (41.2) p. 283
		const s = r + delta
		return max(0, min(1, ((s - R) * (s + R)) / (4 * r * delta)))
	}

	// Computes the phase angle of a planet.
	// L, B, R are heliocentric ecliptical coordinates of the planet.
	// L0, R0 are longitude and radius for Earth, delta is distance from Earth to the planet.
	export function phaseAngle2(L: Angle, B: Angle, R: Distance, L0: Angle, R0: Distance, delta: Distance) {
		// (41.3) p. 283
		return acos(max(-1, min(1, (R - R0 * cos(B) * cos(L - L0)) / delta)))
	}

	// Computes the phase angle of a planet.
	// L, B are heliocentric ecliptical longitude and latitude. x, y, z are geocentric Cartesian
	// coordinates in the same ecliptic frame; delta is their norm. Distances are AU, angles radians.
	// Returns phase in 0..PI, clamping roundoff in the normalized dot product at alignment.
	export function phaseAngle3(L: Angle, B: Angle, x: Distance, y: Distance, z: Distance, delta: Distance) {
		// (41.4) p. 283
		const [sL, cL] = Base.sincos(L)
		const [sB, cB] = Base.sincos(B)
		return acos(max(-1, min(1, (x * cB * cL + y * cB * sL + z * sB) / delta)))
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

// Chapter 42: Physical Ephemeris of Mars. Meeus rotation models.
export namespace Mars {
	// Returns a fresh tuple at jde (TT), using VSOP87E and two light-time iterations.
	// [Earth declination, solar declination, central meridian, north-pole position angle,
	// greatest-defect position angle, angular diameter, illuminated fraction, angular defect].
	// Angles are radians, longitudes and position angles [0, TAU); fraction is dimensionless.
	export function physical(jde: number): readonly [Angle, Angle, Angle, Angle, Angle, Angle, number, Angle] {
		// Step 1
		const T = Base.j2000Century(jde)
		// (42.1) p. 288
		let lambda0 = 352.9065 * DEG2RAD + 1.1733 * DEG2RAD * T
		const beta0 = 63.2818 * DEG2RAD - 0.00394 * DEG2RAD * T
		// Step 2
		const [L0, B0, R] = PlanetPosition.position('earth', jde)
		const [l0, b0] = PlanetPosition.toFK5(L0, B0, jde)
		// Steps 3-4
		const [sl0, cl0] = Base.sincos(l0)
		const sb0 = sin(b0)
		const cb0 = cos(b0)
		const precessor = new Precession.EclipticPrecessor(2000, Base.jdeToJulianYear(jde))
		let distance = 0.5 // surely better than 0.0
		let tau = Base.lightTime(distance)
		let l = 0
		let b = 0
		let r = 0
		let x = 0
		let y = 0
		let z = 0

		// Refines light time (days) and planet coordinates in the reception-time ecliptic.
		function f() {
			const [L, B, range] = PlanetPosition.position2000('mars', jde - tau)
			r = range
			const [lon, lat] = precessor.precess(L, B)
			;[l, b] = PlanetPosition.toFK5(lon, lat, jde)
			const [sb, cb] = Base.sincos(b)
			const [sl, cl] = Base.sincos(l)
			// (42.2) p. 289
			x = r * cb * cl - R * cb0 * cl0
			y = r * cb * sl - R * cb0 * sl0
			z = r * sb - R * sb0
			// (42.3) p. 289
			distance = sqrt(x * x + y * y + z * z)
			tau = Base.lightTime(distance)
		}

		f()
		f()

		// Step 5
		let lambda = atan2(y, x)
		let beta = atan2(z, hypot(x, y))
		// Step 6
		const [sBeta0, cBeta0] = Base.sincos(beta0)
		const [sBeta, cBeta] = Base.sincos(beta)
		const DE = asin(-sBeta0 * sBeta - cBeta0 * cBeta * cos(lambda0 - lambda))
		// Step 7
		const N = 49.5581 * DEG2RAD + 0.7721 * DEG2RAD * T
		const lPrime = l - (0.00697 * DEG2RAD) / r
		const bPrime = b - (0.000225 * DEG2RAD * cos(l - N)) / r
		// Step 8
		const [sbPrime, cbPrime] = Base.sincos(bPrime)
		const DS = asin(-sBeta0 * sbPrime - cBeta0 * cbPrime * cos(lambda0 - lPrime))
		// Step 9
		const W = 11.504 * DEG2RAD + 350.89200025 * DEG2RAD * (jde - tau - 2433282.5)
		// Step 10
		const epsilon0 = Nutation.meanObliquity(jde)
		const [sEpsilon0, cEpsilon0] = Base.sincos(epsilon0)
		const [alpha0, delta0] = Coords.eclipticToEquatorial(lambda0, beta0, epsilon0)
		// Step 11
		const u = y * cEpsilon0 - z * sEpsilon0
		const v = y * sEpsilon0 + z * cEpsilon0
		const alpha = atan2(u, x)
		const delta = atan2(v, hypot(x, u))
		const [sDelta, cDelta] = Base.sincos(delta)
		const [sDelta0, cDelta0] = Base.sincos(delta0)
		const [sAlpha0Alpha, cAlpha0Alpha] = Base.sincos(alpha0 - alpha)
		const zeta = atan2(sDelta0 * cDelta * cAlpha0Alpha - sDelta * cDelta0, cDelta * sAlpha0Alpha)
		// Step 12
		const omega = normalizeAngle(W - zeta)
		// Step 13
		const [deltaPsi, deltaEpsilon] = Nutation.nutation(jde)
		// Step 14
		const [sl0Lambda, cl0Lambda] = Base.sincos(l0 - lambda)
		lambda += (0.005693 * DEG2RAD * cl0Lambda) / cBeta
		beta += 0.005693 * DEG2RAD * sl0Lambda * sBeta
		// Step 15
		lambda0 += deltaPsi
		lambda += deltaPsi
		const epsilon = epsilon0 + deltaEpsilon
		// Step 16
		const [sEpsilon, cEpsilon] = Base.sincos(epsilon)
		const [alpha0Prime, delta0Prime] = Coords.eclipticToEquatorial(lambda0, beta0, epsilon)
		const [alphaPrime, deltaPrime] = Coords.eclipticToEquatorial(lambda, beta, epsilon)
		// Step 17
		const [sDelta0Prime, cDelta0Prime] = Base.sincos(delta0Prime)
		const [sDeltaPrime, cDeltaPrime] = Base.sincos(deltaPrime)
		const [sAlpha0PrimealphaPrime, cAlpha0PrimealphaPrime] = Base.sincos(alpha0Prime - alphaPrime)
		// (42.4) p. 290
		let P = atan2(cDelta0Prime * sAlpha0PrimealphaPrime, sDelta0Prime * cDeltaPrime - cDelta0Prime * sDeltaPrime * cAlpha0PrimealphaPrime)
		if (P < 0) P += TAU
		// Step 18
		const s = l0 + PI
		const [ss, cs] = Base.sincos(s)
		const alphas = atan2(cEpsilon * ss, cs)
		const deltas = asin(sEpsilon * ss)
		const [sDeltas, cDeltas] = Base.sincos(deltas)
		const [sAlphasAlpha, cAlphasAlpha] = Base.sincos(alphas - alpha)
		const chi = atan2(cDeltas * sAlphasAlpha, sDeltas * cDelta - cDeltas * sDelta * cAlphasAlpha)
		const Q = normalizeAngle(chi + PI)
		// Step 19
		const d = ((9.36 / 60 / 60) * DEG2RAD) / distance
		const k = Illuminated.fraction(r, distance, R)
		const q = (1 - k) * d
		return [DE, DS, omega, P, Q, d, k, q]
	}
}

// Chapter 43: Physical Ephemeris of Jupiter. Meeus rotation models.
export namespace Jupiter {
	// Returns a fresh tuple at jde (TT), using VSOP87E and two light-time iterations.
	// [solar declination, Earth declination, System I meridian, System II meridian, north-pole position angle],
	// all planetocentric or geocentric angles in radians; meridians and position angle are [0, TAU).
	export function physical(jde: number): readonly [Angle, Angle, Angle, Angle, Angle] {
		// Step 1
		const d = jde - 2433282.5
		const T1 = d / Base.JULIAN_CENTURY
		const alpha0 = 268 * DEG2RAD + 0.1061 * DEG2RAD * T1
		const delta0 = 64.5 * DEG2RAD - 0.0164 * DEG2RAD * T1
		// Step 2
		const W1 = 17.71 * DEG2RAD + 877.90003539 * DEG2RAD * d
		const W2 = 16.838 * DEG2RAD + 870.27003539 * DEG2RAD * d
		// Step 3
		const [L0, B0, R] = PlanetPosition.position('earth', jde)
		const [l0, b0] = PlanetPosition.toFK5(L0, B0, jde)
		// Steps 4-7.
		const [sl0, cl0] = Base.sincos(l0)
		const sb0 = sin(b0)
		const cb0 = cos(b0)
		const precessor = new Precession.EclipticPrecessor(2000, Base.jdeToJulianYear(jde))
		let distance = 4 // Initial Earth–Jupiter distance in AU for light-time refinement.

		let l = 0
		let b = 0
		let r = 0
		let x = 0
		let y = 0
		let z = 0

		// Refines distance (AU) and planet coordinates in the reception-time ecliptic.
		const f = function () {
			const tau = Base.lightTime(distance)
			const [L, B, range] = PlanetPosition.position2000('jupiter', jde - tau)
			r = range
			const [lon, lat] = precessor.precess(L, B)
			;[l, b] = PlanetPosition.toFK5(lon, lat, jde)
			const [sb, cb] = Base.sincos(b)
			const [sl, cl] = Base.sincos(l)
			// (42.2) p. 289
			x = r * cb * cl - R * cb0 * cl0
			y = r * cb * sl - R * cb0 * sl0
			z = r * sb - R * sb0
			// (42.3) p. 289
			distance = sqrt(x * x + y * y + z * z)
		}

		f()
		f()

		// Step 8
		const epsilon0 = Nutation.meanObliquity(jde)
		// Step 9
		const [sEpsilon0, cEpsilon0] = Base.sincos(epsilon0)
		const [sl, cl] = Base.sincos(l)
		const [sb, cb] = Base.sincos(b)
		const alphas = atan2(cEpsilon0 * sl - (sEpsilon0 * sb) / cb, cl)
		const deltas = asin(cEpsilon0 * sb + sEpsilon0 * cb * sl)
		// Step 10
		const [sDeltas, cDeltas] = Base.sincos(deltas)
		const [sDelta0, cDelta0] = Base.sincos(delta0)
		const DS = asin(-sDelta0 * sDeltas - cDelta0 * cDeltas * cos(alpha0 - alphas))
		// Step 11
		const u = y * cEpsilon0 - z * sEpsilon0
		const v = y * sEpsilon0 + z * cEpsilon0
		let alpha = atan2(u, x)
		let delta = atan2(v, hypot(x, u))
		const [sDelta, cDelta] = Base.sincos(delta)
		const [sAlpha0Alpha, cAlpha0Alpha] = Base.sincos(alpha0 - alpha)
		const zeta = atan2(sDelta0 * cDelta * cAlpha0Alpha - sDelta * cDelta0, cDelta * sAlpha0Alpha)
		// Step 12
		const DE = asin(-sDelta0 * sDelta - cDelta0 * cDelta * cos(alpha0 - alpha))
		// Step 13
		let omega1 = W1 - zeta - 5.07033 * DEG2RAD * distance
		let omega2 = W2 - zeta - 5.02626 * DEG2RAD * distance
		// Step 14
		let C = (2 * r * distance + R * R - r * r - distance * distance) / (4 * r * distance)
		if (sin(l - l0) < 0) C = -C
		omega1 = normalizeAngle(omega1 + C)
		omega2 = normalizeAngle(omega2 + C)
		// Step 15
		const [deltaPsi, deltaEpsilon] = Nutation.nutation(jde)
		const epsilon = epsilon0 + deltaEpsilon
		// Step 16
		const [sEpsilon, cEpsilon] = Base.sincos(epsilon)
		const [sAlpha, cAlpha] = Base.sincos(alpha)
		alpha += (0.005693 * DEG2RAD * (cAlpha * cl0 * cEpsilon + sAlpha * sl0)) / cDelta
		delta += 0.005693 * DEG2RAD * (cl0 * cEpsilon * ((sEpsilon / cEpsilon) * cDelta - sAlpha * sDelta) + cAlpha * sDelta * sl0)
		// Step 17
		const tDelta = sDelta / cDelta
		const deltaAlpha = (cEpsilon + sEpsilon * sAlpha * tDelta) * deltaPsi - cAlpha * tDelta * deltaEpsilon
		const deltaDelta = sEpsilon * cAlpha * deltaPsi + sAlpha * deltaEpsilon
		const alphaPrime = alpha + deltaAlpha
		const deltaPrime = delta + deltaDelta
		const [sAlpha0, cAlpha0] = Base.sincos(alpha0)
		const tDelta0 = sDelta0 / cDelta0
		const deltaAlpha0 = (cEpsilon + sEpsilon * sAlpha0 * tDelta0) * deltaPsi - cAlpha0 * tDelta0 * deltaEpsilon
		const deltaDelta0 = sEpsilon * cAlpha0 * deltaPsi + sAlpha0 * deltaEpsilon
		const alpha0Prime = alpha0 + deltaAlpha0
		const delta0Prime = delta0 + deltaDelta0
		// Step 18
		const [sDeltaPrime, cDeltaPrime] = Base.sincos(deltaPrime)
		const [sDelta0Prime, cDelta0Prime] = Base.sincos(delta0Prime)
		const [sAlpha0PrimealphaPrime, cAlpha0PrimealphaPrime] = Base.sincos(alpha0Prime - alphaPrime)
		// (42.4) p. 290
		let P = atan2(cDelta0Prime * sAlpha0PrimealphaPrime, sDelta0Prime * cDeltaPrime - cDelta0Prime * sDeltaPrime * cAlpha0PrimealphaPrime)
		if (P < 0) P += TAU
		return [DS, DE, omega1, omega2, P]
	}

	// Returns lower-accuracy [solar declination, Earth declination, System I meridian, System II meridian]
	// in radians at jde (TT), using the chapter 43 analytic approximation; meridians are [0, TAU).
	export function physical2(jde: number): readonly [Angle, Angle, Angle, Angle] {
		const d = jde - Base.J2000
		const V = 172.74 * DEG2RAD + 0.00111588 * DEG2RAD * d
		const M = 357.529 * DEG2RAD + 0.9856003 * DEG2RAD * d
		const sV = sin(V)
		const N = 20.02 * DEG2RAD + 0.0830853 * DEG2RAD * d + 0.329 * DEG2RAD * sV
		const J = 66.115 * DEG2RAD + 0.9025179 * DEG2RAD * d - 0.329 * DEG2RAD * sV
		const [sM, cM] = Base.sincos(M)
		const [sN, cN] = Base.sincos(N)
		const [s2M, c2M] = Base.sincos(2 * M)
		const [s2N, c2N] = Base.sincos(2 * N)
		const A = 1.915 * DEG2RAD * sM + 0.02 * DEG2RAD * s2M
		const B = 5.555 * DEG2RAD * sN + 0.168 * DEG2RAD * s2N
		const K = J + A - B
		const R = 1.00014 - 0.01671 * cM - 0.00014 * c2M
		const r = 5.20872 - 0.25208 * cN - 0.00611 * c2N
		const [sK, cK] = Base.sincos(K)
		const delta = sqrt(r * r + R * R - 2 * r * R * cK)
		const psi = asin((R / delta) * sK)
		const dd = d - delta / 173
		let omega1 = 210.98 * DEG2RAD + 877.8169088 * DEG2RAD * dd + psi - B
		let omega2 = 187.23 * DEG2RAD + 870.1869088 * DEG2RAD * dd + psi - B
		let C = sin(psi / 2)
		C *= C
		if (sK > 0) C = -C
		omega1 = normalizeAngle(omega1 + C)
		omega2 = normalizeAngle(omega2 + C)
		const lambda = 34.35 * DEG2RAD + 0.083091 * DEG2RAD * d + 0.329 * DEG2RAD * sV + B
		const DS = 3.12 * DEG2RAD * sin(lambda + 42.8 * DEG2RAD)
		const DE = DS - 2.22 * DEG2RAD * sin(psi) * cos(lambda + 22 * DEG2RAD) - ((1.3 * DEG2RAD * (r - delta)) / delta) * sin(lambda - 100.5 * DEG2RAD)
		return [DS, DE, omega1, omega2]
	}
}

// Chapter 44: Positions of the Galilean Satellites of Jupiter. Meeus approximations and E5 theory.
export namespace JupiterMoons {
	// Mutable ordered container of planet-centered XYZ vectors: Io, Europa, Ganymede, Callisto.
	export type MutPositions = [Vec3, Vec3, Vec3, Vec3]
	// Readonly view of the four satellite vectors, in Jupiter equatorial radii.
	export type Positions = Readonly<MutPositions>

	// Index of io in the returned satellite tuple.
	export const IO = 0
	// Index of europa in the returned satellite tuple.
	export const EUROPA = 1
	// Index of ganymede in the returned satellite tuple.
	export const GANYMEDE = 2
	// Index of callisto in the returned satellite tuple.
	export const CALLISTO = 3

	// Differential light-time denominators for Io, Europa, Ganymede and Callisto (Meeus 44).
	const K = [17295, 21819, 27558, 36548]

	// Returns newly allocated approximate positions at jde (TT), in Jupiter equatorial radii.
	// Coordinates are planet-centered: X west, Y north along the projected rotation axis, Z away
	// from Earth; ordered Io, Europa, Ganymede, Callisto. Meeus chapter 44 low-accuracy method.
	export function positions(jde: number): MutPositions {
		const d = jde - Base.J2000
		const V = 172.74 * DEG2RAD + 0.00111588 * DEG2RAD * d
		const M = 357.529 * DEG2RAD + 0.9856003 * DEG2RAD * d
		const sV = sin(V)
		const N = 20.02 * DEG2RAD + 0.0830853 * DEG2RAD * d + 0.329 * DEG2RAD * sV
		const J = 66.115 * DEG2RAD + 0.9025179 * DEG2RAD * d - 0.329 * DEG2RAD * sV
		const [sM, cM] = Base.sincos(M)
		const [sN, cN] = Base.sincos(N)
		const [s2M, c2M] = Base.sincos(2 * M)
		const [s2N, c2N] = Base.sincos(2 * N)
		const A = 1.915 * DEG2RAD * sM + 0.02 * DEG2RAD * s2M
		const B = 5.555 * DEG2RAD * sN + 0.168 * DEG2RAD * s2N
		const K = J + A - B
		const R = 1.00014 - 0.01671 * cM - 0.00014 * c2M
		const r = 5.20872 - 0.25208 * cN - 0.00611 * c2N
		const [sK, cK] = Base.sincos(K)
		const delta = sqrt(r * r + R * R - 2 * r * R * cK)
		const psi = asin((R / delta) * sK)
		const lambda = 34.35 * DEG2RAD + 0.083091 * DEG2RAD * d + 0.329 * DEG2RAD * sV + B
		const DS = 3.12 * DEG2RAD * sin(lambda + 42.8 * DEG2RAD)
		const DE = DS - 2.22 * DEG2RAD * sin(psi) * cos(lambda + 22 * DEG2RAD) - ((1.3 * DEG2RAD * (r - delta)) / delta) * sin(lambda - 100.5 * DEG2RAD)
		const dd = d - delta / 173
		const u1 = 163.8069 * DEG2RAD + 203.4058646 * DEG2RAD * dd + psi - B
		const u2 = 358.414 * DEG2RAD + 101.2916335 * DEG2RAD * dd + psi - B
		const u3 = 5.7176 * DEG2RAD + 50.234518 * DEG2RAD * dd + psi - B
		const u4 = 224.8092 * DEG2RAD + 21.48798 * DEG2RAD * dd + psi - B
		const G = 331.18 * DEG2RAD + 50.310482 * DEG2RAD * dd
		const H = 87.45 * DEG2RAD + 21.569231 * DEG2RAD * dd
		const [s212, c212] = Base.sincos(2 * (u1 - u2))
		const [s223, c223] = Base.sincos(2 * (u2 - u3))
		const [sG, cG] = Base.sincos(G)
		const [sH, cH] = Base.sincos(H)
		const c1 = 0.473 * DEG2RAD * s212
		const c2 = 1.065 * DEG2RAD * s223
		const c3 = 0.165 * DEG2RAD * sG
		const c4 = 0.843 * DEG2RAD * sH
		const r1 = 5.9057 - 0.0244 * c212
		const r2 = 9.3966 - 0.0882 * c223
		const r3 = 14.9883 - 0.0216 * cG
		const r4 = 26.3627 - 0.1939 * cH
		const sDE = sin(DE)
		const cDE = cos(DE)

		// Projects orbital longitude u (radians) and radius r (Jupiter radii) into a fresh XYZ tuple.
		const xy = function (u: Angle, r: number): Vec3 {
			const [su, cu] = Base.sincos(u)
			return [r * su, -r * cu * sDE, -r * cu * cDE]
		}

		return [xy(u1 + c1, r1), xy(u2 + c2, r2), xy(u3 + c3, r3), xy(u4 + c4, r4)]
	}

	// Returns E5 positions at jde (TT) in Jupiter equatorial radii, with the same axes and order as
	// positions(). Includes light time, differential light time and perspective; allocates a tuple
	// unless pos is supplied, in which case replaces its four vectors and returns pos itself.
	export function e5(
		jde: number,
		pos: MutPositions = [
			[0, 0, 0],
			[0, 0, 0],
			[0, 0, 0],
			[0, 0, 0],
		],
	): MutPositions {
		// variables assigned in following block
		let lambda0 = 0
		let beta0 = 0
		let t = 0
		let delta = 5

		{
			const [s, beta, R] = Solar.trueVSOP87(jde)
			const precessor = new Precession.EclipticPrecessor(2000, Base.jdeToJulianYear(jde))
			const [ss, cs] = Base.sincos(s)
			const sBeta = sin(beta)
			const cBeta = cos(beta)
			let tau = Base.lightTime(delta)
			let x = 0
			let y = 0
			let z = 0

			// Refines Jupiter light time in days in the reception-time FK5 ecliptic.
			function f() {
				const [L, B, range] = PlanetPosition.position2000('jupiter', jde - tau)
				const ecl = precessor.precess(L, B)
				const [lon, lat] = PlanetPosition.toFK5(ecl[0], ecl[1], jde)
				const [sl, cl] = Base.sincos(lon)
				const [sb, cb] = Base.sincos(lat)
				x = range * cb * cl + R * cBeta * cs
				y = range * cb * sl + R * cBeta * ss
				z = range * sb + R * sBeta
				delta = sqrt(x * x + y * y + z * z)
				tau = Base.lightTime(delta)
			}

			f()
			f()

			lambda0 = atan2(y, x)
			beta0 = atan2(z, hypot(x, y))
			t = jde - 2443000.5 - tau
		}

		const l1 = 106.07719 * DEG2RAD + 203.48895579 * DEG2RAD * t
		const l2 = 175.73161 * DEG2RAD + 101.374724735 * DEG2RAD * t
		const l3 = 120.55883 * DEG2RAD + 50.317609207 * DEG2RAD * t
		const l4 = 84.44459 * DEG2RAD + 21.571071177 * DEG2RAD * t
		const pi1 = 97.0881 * DEG2RAD + 0.16138586 * DEG2RAD * t
		const pi2 = 154.8663 * DEG2RAD + 0.04726307 * DEG2RAD * t
		const pi3 = 188.184 * DEG2RAD + 0.00712734 * DEG2RAD * t
		const pi4 = 335.2868 * DEG2RAD + 0.00184 * DEG2RAD * t
		const omega1 = 312.3346 * DEG2RAD - 0.13279386 * DEG2RAD * t
		const omega2 = 100.4411 * DEG2RAD - 0.03263064 * DEG2RAD * t
		const omega3 = 119.1942 * DEG2RAD - 0.00717703 * DEG2RAD * t
		const omega4 = 322.6186 * DEG2RAD - 0.00175934 * DEG2RAD * t
		const gamma = 0.33033 * DEG2RAD * sin(163.679 * DEG2RAD + 0.0010512 * DEG2RAD * t) + 0.03439 * DEG2RAD * sin(34.486 * DEG2RAD - 0.0161731 * DEG2RAD * t)
		const phiLambda = 199.6766 * DEG2RAD + 0.1737919 * DEG2RAD * t
		let psi = 316.5182 * DEG2RAD - 0.00000208 * DEG2RAD * t
		const G = 30.23756 * DEG2RAD + 0.0830925701 * DEG2RAD * t + gamma
		const GPrime = 31.97853 * DEG2RAD + 0.0334597339 * DEG2RAD * t
		const pi = 13.469942 * DEG2RAD

		const sigma1 =
			0.47259 * DEG2RAD * sin(2 * (l1 - l2)) +
			-0.03478 * DEG2RAD * sin(pi3 - pi4) +
			0.01081 * DEG2RAD * sin(l2 - 2 * l3 + pi3) +
			0.00738 * DEG2RAD * sin(phiLambda) +
			0.00713 * DEG2RAD * sin(l2 - 2 * l3 + pi2) +
			-0.00674 * DEG2RAD * sin(pi1 + pi3 - 2 * pi - 2 * G) +
			0.00666 * DEG2RAD * sin(l2 - 2 * l3 + pi4) +
			0.00445 * DEG2RAD * sin(l1 - pi3) +
			-0.00354 * DEG2RAD * sin(l1 - l2) +
			-0.00317 * DEG2RAD * sin(2 * psi - 2 * pi) +
			0.00265 * DEG2RAD * sin(l1 - pi4) +
			-0.00186 * DEG2RAD * sin(G) +
			0.00162 * DEG2RAD * sin(pi2 - pi3) +
			0.00158 * DEG2RAD * sin(4 * (l1 - l2)) +
			-0.00155 * DEG2RAD * sin(l1 - l3) +
			-0.00138 * DEG2RAD * sin(psi + omega3 - 2 * pi - 2 * G) +
			-0.00115 * DEG2RAD * sin(2 * (l1 - 2 * l2 + omega2)) +
			0.00089 * DEG2RAD * sin(pi2 - pi4) +
			0.00085 * DEG2RAD * sin(l1 + pi3 - 2 * pi - 2 * G) +
			0.00083 * DEG2RAD * sin(omega2 - omega3) +
			0.00053 * DEG2RAD * sin(psi - omega2)
		const sigma2 =
			1.06476 * DEG2RAD * sin(2 * (l2 - l3)) +
			0.04256 * DEG2RAD * sin(l1 - 2 * l2 + pi3) +
			0.03581 * DEG2RAD * sin(l2 - pi3) +
			0.02395 * DEG2RAD * sin(l1 - 2 * l2 + pi4) +
			0.01984 * DEG2RAD * sin(l2 - pi4) +
			-0.01778 * DEG2RAD * sin(phiLambda) +
			0.01654 * DEG2RAD * sin(l2 - pi2) +
			0.01334 * DEG2RAD * sin(l2 - 2 * l3 + pi2) +
			0.01294 * DEG2RAD * sin(pi3 - pi4) +
			-0.01142 * DEG2RAD * sin(l2 - l3) +
			-0.01057 * DEG2RAD * sin(G) +
			-0.00775 * DEG2RAD * sin(2 * (psi - pi)) +
			0.00524 * DEG2RAD * sin(2 * (l1 - l2)) +
			-0.0046 * DEG2RAD * sin(l1 - l3) +
			0.00316 * DEG2RAD * sin(psi - 2 * G + omega3 - 2 * pi) +
			-0.00203 * DEG2RAD * sin(pi1 + pi3 - 2 * pi - 2 * G) +
			0.00146 * DEG2RAD * sin(psi - omega3) +
			-0.00145 * DEG2RAD * sin(2 * G) +
			0.00125 * DEG2RAD * sin(psi - omega4) +
			-0.00115 * DEG2RAD * sin(l1 - 2 * l3 + pi3) +
			-0.00094 * DEG2RAD * sin(2 * (l2 - omega2)) +
			0.00086 * DEG2RAD * sin(2 * (l1 - 2 * l2 + omega2)) +
			-0.00086 * DEG2RAD * sin(5 * GPrime - 2 * G + 52.225 * DEG2RAD) +
			-0.00078 * DEG2RAD * sin(l2 - l4) +
			-0.00064 * DEG2RAD * sin(3 * l3 - 7 * l4 + 4 * pi4) +
			0.00064 * DEG2RAD * sin(pi1 - pi4) +
			-0.00063 * DEG2RAD * sin(l1 - 2 * l3 + pi4) +
			0.00058 * DEG2RAD * sin(omega3 - omega4) +
			0.00056 * DEG2RAD * sin(2 * (psi - pi - G)) +
			0.00056 * DEG2RAD * sin(2 * (l2 - l4)) +
			0.00055 * DEG2RAD * sin(2 * (l1 - l3)) +
			0.00052 * DEG2RAD * sin(3 * l3 - 7 * l4 + pi3 + 3 * pi4) +
			-0.00043 * DEG2RAD * sin(l1 - pi3) +
			0.00041 * DEG2RAD * sin(5 * (l2 - l3)) +
			0.00041 * DEG2RAD * sin(pi4 - pi) +
			0.00032 * DEG2RAD * sin(omega2 - omega3) +
			0.00032 * DEG2RAD * sin(2 * (l3 - G - pi))
		const sigma3 =
			0.1649 * DEG2RAD * sin(l3 - pi3) +
			0.09081 * DEG2RAD * sin(l3 - pi4) +
			-0.06907 * DEG2RAD * sin(l2 - l3) +
			0.03784 * DEG2RAD * sin(pi3 - pi4) +
			0.01846 * DEG2RAD * sin(2 * (l3 - l4)) +
			-0.0134 * DEG2RAD * sin(G) +
			-0.01014 * DEG2RAD * sin(2 * (psi - pi)) +
			0.00704 * DEG2RAD * sin(l2 - 2 * l3 + pi3) +
			-0.0062 * DEG2RAD * sin(l2 - 2 * l3 + pi2) +
			-0.00541 * DEG2RAD * sin(l3 - l4) +
			0.00381 * DEG2RAD * sin(l2 - 2 * l3 + pi4) +
			0.00235 * DEG2RAD * sin(psi - omega3) +
			0.00198 * DEG2RAD * sin(psi - omega4) +
			0.00176 * DEG2RAD * sin(phiLambda) +
			0.0013 * DEG2RAD * sin(3 * (l3 - l4)) +
			0.00125 * DEG2RAD * sin(l1 - l3) +
			-0.00119 * DEG2RAD * sin(5 * GPrime - 2 * G + 52.225 * DEG2RAD) +
			0.00109 * DEG2RAD * sin(l1 - l2) +
			-0.001 * DEG2RAD * sin(3 * l3 - 7 * l4 + 4 * pi4) +
			0.00091 * DEG2RAD * sin(omega3 - omega4) +
			0.0008 * DEG2RAD * sin(3 * l3 - 7 * l4 + pi3 + 3 * pi4) +
			-0.00075 * DEG2RAD * sin(2 * l2 - 3 * l3 + pi3) +
			0.00072 * DEG2RAD * sin(pi1 + pi3 - 2 * pi - 2 * G) +
			0.00069 * DEG2RAD * sin(pi4 - pi) +
			-0.00058 * DEG2RAD * sin(2 * l3 - 3 * l4 + pi4) +
			-0.00057 * DEG2RAD * sin(l3 - 2 * l4 + pi4) +
			0.00056 * DEG2RAD * sin(l3 + pi3 - 2 * pi - 2 * G) +
			-0.00052 * DEG2RAD * sin(l2 - 2 * l3 + pi1) +
			-0.0005 * DEG2RAD * sin(pi2 - pi3) +
			0.00048 * DEG2RAD * sin(l3 - 2 * l4 + pi3) +
			-0.00045 * DEG2RAD * sin(2 * l2 - 3 * l3 + pi4) +
			-0.00041 * DEG2RAD * sin(pi2 - pi4) +
			-0.00038 * DEG2RAD * sin(2 * G) +
			-0.00037 * DEG2RAD * sin(pi3 - pi4 + omega3 - omega4) +
			-0.00032 * DEG2RAD * sin(3 * l3 - 7 * l4 + 2 * pi3 + 2 * pi4) +
			0.0003 * DEG2RAD * sin(4 * (l3 - l4)) +
			0.00029 * DEG2RAD * sin(l3 + pi4 - 2 * pi - 2 * G) +
			-0.00028 * DEG2RAD * sin(omega3 + psi - 2 * pi - 2 * G) +
			0.00026 * DEG2RAD * sin(l3 - pi - G) +
			0.00024 * DEG2RAD * sin(l2 - 3 * l3 + 2 * l4) +
			0.00021 * DEG2RAD * sin(2 * (l3 - pi - G)) +
			-0.00021 * DEG2RAD * sin(l3 - pi2) +
			0.00017 * DEG2RAD * sin(2 * (l3 - pi3))
		const sigma4 =
			0.84287 * DEG2RAD * sin(l4 - pi4) +
			0.03431 * DEG2RAD * sin(pi4 - pi3) +
			-0.03305 * DEG2RAD * sin(2 * (psi - pi)) +
			-0.03211 * DEG2RAD * sin(G) +
			-0.01862 * DEG2RAD * sin(l4 - pi3) +
			0.01186 * DEG2RAD * sin(psi - omega4) +
			0.00623 * DEG2RAD * sin(l4 + pi4 - 2 * G - 2 * pi) +
			0.00387 * DEG2RAD * sin(2 * (l4 - pi4)) +
			-0.00284 * DEG2RAD * sin(5 * GPrime - 2 * G + 52.225 * DEG2RAD) +
			-0.00234 * DEG2RAD * sin(2 * (psi - pi4)) +
			-0.00223 * DEG2RAD * sin(l3 - l4) +
			-0.00208 * DEG2RAD * sin(l4 - pi) +
			0.00178 * DEG2RAD * sin(psi + omega4 - 2 * pi4) +
			0.00134 * DEG2RAD * sin(pi4 - pi) +
			0.00125 * DEG2RAD * sin(2 * (l4 - G - pi)) +
			-0.00117 * DEG2RAD * sin(2 * G) +
			-0.00112 * DEG2RAD * sin(2 * (l3 - l4)) +
			0.00107 * DEG2RAD * sin(3 * l3 - 7 * l4 + 4 * pi4) +
			0.00102 * DEG2RAD * sin(l4 - G - pi) +
			0.00096 * DEG2RAD * sin(2 * l4 - psi - omega4) +
			0.00087 * DEG2RAD * sin(2 * (psi - omega4)) +
			-0.00085 * DEG2RAD * sin(3 * l3 - 7 * l4 + pi3 + 3 * pi4) +
			0.00085 * DEG2RAD * sin(l3 - 2 * l4 + pi4) +
			-0.00081 * DEG2RAD * sin(2 * (l4 - psi)) +
			0.00071 * DEG2RAD * sin(l4 + pi4 - 2 * pi - 3 * G) +
			0.00061 * DEG2RAD * sin(l1 - l4) +
			-0.00056 * DEG2RAD * sin(psi - omega3) +
			-0.00054 * DEG2RAD * sin(l3 - 2 * l4 + pi3) +
			0.00051 * DEG2RAD * sin(l2 - l4) +
			0.00042 * DEG2RAD * sin(2 * (psi - G - pi)) +
			0.00039 * DEG2RAD * sin(2 * (pi4 - omega4)) +
			0.00036 * DEG2RAD * sin(psi + pi - pi4 - omega4) +
			0.00035 * DEG2RAD * sin(2 * GPrime - G + 188.37 * DEG2RAD) +
			-0.00035 * DEG2RAD * sin(l4 - pi4 + 2 * pi - 2 * psi) +
			-0.00032 * DEG2RAD * sin(l4 + pi4 - 2 * pi - G) +
			0.0003 * DEG2RAD * sin(2 * GPrime - 2 * G + 149.15 * DEG2RAD) +
			0.00029 * DEG2RAD * sin(3 * l3 - 7 * l4 + 2 * pi3 + 2 * pi4) +
			0.00028 * DEG2RAD * sin(l4 - pi4 + 2 * psi - 2 * pi) +
			-0.00028 * DEG2RAD * sin(2 * (l4 - omega4)) +
			-0.00027 * DEG2RAD * sin(pi3 - pi4 + omega3 - omega4) +
			-0.00026 * DEG2RAD * sin(5 * GPrime - 3 * G + 188.37 * DEG2RAD) +
			0.00025 * DEG2RAD * sin(omega4 - omega3) +
			-0.00025 * DEG2RAD * sin(l2 - 3 * l3 + 2 * l4) +
			-0.00023 * DEG2RAD * sin(3 * (l3 - l4)) +
			0.00021 * DEG2RAD * sin(2 * l4 - 2 * pi - 3 * G) +
			-0.00021 * DEG2RAD * sin(2 * l3 - 3 * l4 + pi4) +
			0.00019 * DEG2RAD * sin(l4 - pi4 - G) +
			-0.00019 * DEG2RAD * sin(2 * l4 - pi3 - pi4) +
			-0.00018 * DEG2RAD * sin(l4 - pi4 + G) +
			-0.00016 * DEG2RAD * sin(l4 + pi3 - 2 * pi - 2 * G)

		const L1 = l1 + sigma1
		const L2 = l2 + sigma2
		const L3 = l3 + sigma3
		const L4 = l4 + sigma4

		// variables assigned in following block
		let I = 0
		const X = new Float64Array(5)
		const Y = new Float64Array(5)
		const Z = new Float64Array(5)
		const R = new Float64Array(4)

		{
			const B = new Float64Array(4)
			const L = [L1, L2, L3, L4]

			B[0] = atan(0.0006393 * sin(L1 - omega1) + 0.0001825 * sin(L1 - omega2) + 0.0000329 * sin(L1 - omega3) + -0.0000311 * sin(L1 - psi) + 0.0000093 * sin(L1 - omega4) + 0.0000075 * sin(3 * L1 - 4 * l2 - 1.9927 * sigma1 + omega2) + 0.0000046 * sin(L1 + psi - 2 * pi - 2 * G))
			B[1] = atan(
				0.0081004 * sin(L2 - omega2) +
					0.0004512 * sin(L2 - omega3) +
					-0.0003284 * sin(L2 - psi) +
					0.000116 * sin(L2 - omega4) +
					0.0000272 * sin(l1 - 2 * l3 + 1.0146 * sigma2 + omega2) +
					-0.0000144 * sin(L2 - omega1) +
					0.0000143 * sin(L2 + psi - 2 * pi - 2 * G) +
					0.0000035 * sin(L2 - psi + G) +
					-0.0000028 * sin(l1 - 2 * l3 + 1.0146 * sigma2 + omega3),
			)
			B[2] = atan(
				0.0032402 * sin(L3 - omega3) +
					-0.0016911 * sin(L3 - psi) +
					0.0006847 * sin(L3 - omega4) +
					-0.0002797 * sin(L3 - omega2) +
					0.0000321 * sin(L3 + psi - 2 * pi - 2 * G) +
					0.0000051 * sin(L3 - psi + G) +
					-0.0000045 * sin(L3 - psi - G) +
					-0.0000045 * sin(L3 + psi - 2 * pi) +
					0.0000037 * sin(L3 + psi - 2 * pi - 3 * G) +
					0.000003 * sin(2 * l2 - 3 * L3 + 4.03 * sigma3 + omega2) +
					-0.0000021 * sin(2 * l2 - 3 * L3 + 4.03 * sigma3 + omega3),
			)
			B[3] = atan(-0.0076579 * sin(L4 - psi) + 0.0044134 * sin(L4 - omega4) + -0.0005112 * sin(L4 - omega3) + 0.0000773 * sin(L4 + psi - 2 * pi - 2 * G) + 0.0000104 * sin(L4 - psi + G) + -0.0000102 * sin(L4 - psi - G) + 0.0000088 * sin(L4 + psi - 2 * pi - 3 * G) + -0.0000038 * sin(L4 + psi - 2 * pi - G))

			R[0] = 5.90569 * (1 + -0.0041339 * cos(2 * (l1 - l2)) + -0.0000387 * cos(l1 - pi3) + -0.0000214 * cos(l1 - pi4) + 0.000017 * cos(l1 - l2) + -0.0000131 * cos(4 * (l1 - l2)) + 0.0000106 * cos(l1 - l3) + -0.0000066 * cos(l1 + pi3 - 2 * pi - 2 * G))
			R[1] =
				9.39657 *
				(1 +
					0.0093848 * cos(l1 - l2) +
					-0.0003116 * cos(l2 - pi3) +
					-0.0001744 * cos(l2 - pi4) +
					-0.0001442 * cos(l2 - pi2) +
					0.0000553 * cos(l2 - l3) +
					0.0000523 * cos(l1 - l3) +
					-0.000029 * cos(2 * (l1 - l2)) +
					0.0000164 * cos(2 * (l2 - omega2)) +
					0.0000107 * cos(l1 - 2 * l3 + pi3) +
					-0.0000102 * cos(l2 - pi1) +
					-0.0000091 * cos(2 * (l1 - l3)))
			R[2] =
				14.98832 *
				(1 +
					-0.0014388 * cos(l3 - pi3) +
					-0.0007917 * cos(l3 - pi4) +
					0.0006342 * cos(l2 - l3) +
					-0.0001761 * cos(2 * (l3 - l4)) +
					0.0000294 * cos(l3 - l4) +
					-0.0000156 * cos(3 * (l3 - l4)) +
					0.0000156 * cos(l1 - l3) +
					-0.0000153 * cos(l1 - l2) +
					0.000007 * cos(2 * l2 - 3 * l3 + pi3) +
					-0.0000051 * cos(l3 + pi3 - 2 * pi - 2 * G))
			R[3] =
				26.36273 *
				(1 +
					-0.0073546 * cos(l4 - pi4) +
					0.0001621 * cos(l4 - pi3) +
					0.0000974 * cos(l3 - l4) +
					-0.0000543 * cos(l4 + pi4 - 2 * pi - 2 * G) +
					-0.0000271 * cos(2 * (l4 - pi4)) +
					0.0000182 * cos(l4 - pi) +
					0.0000177 * cos(2 * (l3 - l4)) +
					-0.0000167 * cos(2 * l4 - psi - omega4) +
					0.0000167 * cos(psi - omega4) +
					-0.0000155 * cos(2 * (l4 - pi - G)) +
					0.0000142 * cos(2 * (l4 - psi)) +
					0.0000105 * cos(l1 - l4) +
					0.0000092 * cos(l2 - l4) +
					-0.0000089 * cos(l4 - pi - G) +
					-0.0000062 * cos(l4 + pi4 - 2 * pi - 3 * G) +
					0.0000048 * cos(2 * (l4 - omega4)))

			// p. 311
			const T0 = (jde - 2433282.423) / Base.JULIAN_CENTURY
			const P = (1.3966626 * DEG2RAD + 0.0003088 * DEG2RAD * T0) * T0
			for (let i = 0; i < 4; i++) L[i] += P
			psi += P
			const T = (jde - Base.J1900) / Base.JULIAN_CENTURY
			I = 3.120262 * DEG2RAD + 0.0006 * DEG2RAD * T

			for (let i = 0; i < 4; i++) {
				const [sLPsi, cLPsi] = Base.sincos(L[i] - psi)
				const [sB, cB] = Base.sincos(B[i])
				X[i] = R[i] * cLPsi * cB
				Y[i] = R[i] * sLPsi * cB
				Z[i] = R[i] * sB
			}
		}

		Z[4] = 1

		// p. 312
		const A = new Float64Array(5)
		const B = new Float64Array(5)
		const C = new Float64Array(5)
		const [sI, cI] = Base.sincos(I)
		const omega = PlanetElements.node('jupiter', jde)
		const [sOmega, cOmega] = Base.sincos(omega)
		const [sPhi, cPhi] = Base.sincos(psi - omega)
		const [si, ci] = Base.sincos(PlanetElements.inc('jupiter', jde))
		const [sLambda0, cLambda0] = Base.sincos(lambda0)
		const [sBeta0, cBeta0] = Base.sincos(beta0)

		for (let i = 0; i < 5; i++) {
			// step 1
			let a = X[i]
			let b = Y[i] * cI - Z[i] * sI
			let c = Y[i] * sI + Z[i] * cI
			// step 2
			let a0 = a * cPhi - b * sPhi
			b = a * sPhi + b * cPhi
			a = a0
			// step 3
			const b0 = b * ci - c * si
			c = b * si + c * ci
			b = b0
			// step 4
			a0 = a * cOmega - b * sOmega
			b = a * sOmega + b * cOmega
			a = a0
			// step 5
			a0 = a * sLambda0 - b * cLambda0
			b = a * cLambda0 + b * sLambda0
			a = a0
			// step 6
			A[i] = a
			B[i] = c * sBeta0 + b * cBeta0
			C[i] = c * cBeta0 - b * sBeta0
		}

		const [sD, cD] = Base.sincos(atan2(A[4], C[4]))

		// p. 313
		for (let i = 0; i < 4; i++) {
			let x = A[i] * cD - C[i] * sD
			const y = A[i] * sD + C[i] * cD
			const z = B[i]
			// differential light time
			const d = x / R[i]
			x += (abs(z) / K[i]) * sqrt(max(0, 1 - d * d))
			// perspective effect
			const W = delta / (delta + z / 2095)
			pos[i] = [x * W, y * W, z]
		}

		return pos
	}
}

// Chapter 45: The Ring of Saturn. Geocentric orientation and angular dimensions.
export namespace SaturnRing {
	const RING_I = [28.075216 * DEG2RAD, -0.012998 * DEG2RAD, 0.000004 * DEG2RAD] as const
	const RING_OMEGA = [169.50847 * DEG2RAD, 1.394681 * DEG2RAD, 0.000412 * DEG2RAD] as const

	// Returns a fresh [Earth latitude, solar latitude, longitude difference, pole position angle,
	// outer-ring major diameter, outer-ring minor diameter] tuple at jde (TT), all in radians.
	// Latitudes refer to Saturn's ring plane; the longitude difference is [0, PI] and position
	// angle [-PI, PI]. Uses VSOP87E, FK5, two light-time iterations, aberration and nutation.
	export function ring(jde: number): readonly [Angle, Angle, Angle, Angle, Angle, Angle] {
		const T = Base.j2000Century(jde)
		const i = Base.horner(T, RING_I)
		const omega = Base.horner(T, RING_OMEGA)
		const [L0, B0, R] = PlanetPosition.position('earth', jde)
		const [l0, b0] = PlanetPosition.toFK5(L0, B0, jde)
		const X = R * cos(b0) * cos(l0)
		const Y = R * cos(b0) * sin(l0)
		const Z = R * sin(b0)
		const precessor = new Precession.EclipticPrecessor(2000, Base.jdeToJulianYear(jde))
		let distance = 9
		let l = 0
		let b = 0
		let r = 0
		let x = 0
		let y = 0
		let z = 0

		for (let k = 0; k < 2; k++) {
			const [L, B, range] = PlanetPosition.position2000('saturn', jde - Base.lightTime(distance))
			r = range
			const ecl = precessor.precess(L, B)
			const fk5 = PlanetPosition.toFK5(ecl[0], ecl[1], jde)
			l = fk5[0]
			b = fk5[1]
			x = r * cos(b) * cos(l) - X
			y = r * cos(b) * sin(l) - Y
			z = r * sin(b) - Z
			distance = hypot(x, y, z)
		}

		let lambda = atan2(y, x)
		let beta = atan2(z, hypot(x, y))
		const [si, ci] = Base.sincos(i)
		const [sb, cb] = Base.sincos(beta)
		const sB = si * cb * sin(lambda - omega) - ci * sb
		const B = asin(sB)
		const N = (113.6655 + 0.8771 * T) * DEG2RAD
		const lp = l - (0.01759 * DEG2RAD) / r
		const bp = b - (0.000764 * DEG2RAD * cos(l - N)) / r
		const [sbp, cbp] = Base.sincos(bp)
		const [slp, clp] = Base.sincos(lp - omega)
		const U1 = atan2(si * sbp + ci * cbp * slp, cbp * clp)
		const U2 = atan2(si * sb + ci * cb * sin(lambda - omega), cb * cos(lambda - omega))
		// Wrap before taking the absolute difference: atan2 longitudes can straddle the antimeridian.
		const deltaU = abs(atan2(sin(U1 - U2), cos(U1 - U2)))
		const a = (375.35 * ASEC2RAD) / distance
		const minor = a * abs(sB)
		const Bp = asin(si * cbp * slp - ci * sbp)
		const [dp, de] = Nutation.nutation(jde)
		const epsilon = Nutation.meanObliquity(jde) + de
		const [sl, cl] = Base.sincos(l0 - lambda)
		lambda += (0.005693 * DEG2RAD * cl) / cb + dp
		beta += 0.005693 * DEG2RAD * sl * sb
		const [ra0, dec0] = Coords.eclipticToEquatorial(omega - PIOVERTWO + dp, PIOVERTWO - i, epsilon)
		const [ra, dec] = Coords.eclipticToEquatorial(lambda, beta, epsilon)
		const P = atan2(cos(dec0) * sin(ra0 - ra), sin(dec0) * cos(dec) - cos(dec0) * sin(dec) * cos(ra0 - ra))
		return [B, Bp, deltaU, P, a, minor]
	}

	// Returns fresh [longitude difference, Earth latitude] in radians at jde (TT), as needed by
	// Illuminated.saturn; same ring-plane quantities as ring(), with difference in [0, PI].
	export function ub(jde: number): readonly [Angle, Angle] {
		const r = ring(jde)
		return [r[2], r[0]]
	}
}

// Chapter 46: Positions of the Satellites of Saturn. Dourneau theory and Earth-view projection.
export namespace SaturnMoons {
	// Readonly XYZ tuples for Mimas through Iapetus, in Saturn equatorial radii.
	export type Positions = readonly [Vec3, Vec3, Vec3, Vec3, Vec3, Vec3, Vec3, Vec3]

	// Index of mimas in the returned satellite tuple.
	export const MIMAS = 0
	// Index of enceladus in the returned satellite tuple.
	export const ENCELADUS = 1
	// Index of tethys in the returned satellite tuple.
	export const TETHYS = 2
	// Index of dione in the returned satellite tuple.
	export const DIONE = 3
	// Index of rhea in the returned satellite tuple.
	export const RHEA = 4
	// Index of titan in the returned satellite tuple.
	export const TITAN = 5
	// Index of hyperion in the returned satellite tuple.
	export const HYPERION = 6
	// Index of iapetus in the returned satellite tuple.
	export const IAPETUS = 7

	// Differential light-time denominators, Meeus chapter 46; index zero is the fictitious pole.
	const K = [0, 20947, 23715, 26382, 29876, 35313, 53800, 59222, 91820]

	// Returns newly allocated positions at jde (TT), in Saturn equatorial radii, ordered Mimas,
	// Enceladus, Tethys, Dione, Rhea, Titan, Hyperion, Iapetus. Planet-centered axes are X west,
	// Y north along the projected rotation axis, Z away from Earth. Includes light time,
	// differential light time and perspective, using the Dourneau theory in Meeus chapter 46.
	export function positions(jde: number): Positions {
		const [s, beta, R] = Solar.trueVSOP87(jde)
		const precessor = new Precession.EclipticPrecessor(2000, Base.jdeToJulianYear(jde))
		const [ss, cs] = Base.sincos(s)
		const sBeta = sin(beta)
		const cBeta = cos(beta)
		let delta = 9
		let x = 0
		let y = 0
		let z = 0
		let _jde = jde

		// Refines light time and Saturn geometry in the reception-time FK5 ecliptic.
		const f = function () {
			const tau = Base.lightTime(delta)
			_jde = jde - tau
			const [L, B, range] = PlanetPosition.position2000('saturn', _jde)
			const ecl = precessor.precess(L, B)
			const [l, b] = PlanetPosition.toFK5(ecl[0], ecl[1], jde)
			const [sl, cl] = Base.sincos(l)
			const [sb, cb] = Base.sincos(b)
			x = range * cb * cl + R * cBeta * cs
			y = range * cb * sl + R * cBeta * ss
			z = range * sb + R * sBeta
			delta = sqrt(x * x + y * y + z * z)
		}

		f()
		f()

		const [lambda0, beta0] = new Precession.EclipticPrecessor(Base.jdeToJulianYear(jde), Base.jdeToJulianYear(Base.B1950)).precess(atan2(y, x), atan2(z, hypot(x, y)))
		const q = new Qs(_jde)
		const s4 = [
			new R4(), // 0 unused
			q.mimas(),
			q.enceladus(),
			q.tethys(),
			q.dione(),
			q.rhea(),
			q.titan(),
			q.hyperion(),
			q.iapetus(),
		] as const

		const X = new Float64Array(9)
		const Y = new Float64Array(9)
		const Z = new Float64Array(9)

		for (let j = 1; j <= 8; j++) {
			const u = s4[j].lambda - s4[j].omega
			const w = s4[j].omega - 168.8112 * DEG2RAD
			const [su, cu] = Base.sincos(u)
			const [sw, cw] = Base.sincos(w)
			const [sGamma, cGamma] = Base.sincos(s4[j].gamma)
			const r = s4[j].r
			X[j] = r * (cu * cw - su * cGamma * sw)
			Y[j] = r * (su * cw * cGamma + cu * sw)
			Z[j] = r * su * sGamma
		}

		Z[0] = 1

		const [sLambda0, cLambda0] = Base.sincos(lambda0)
		const [sBeta0, cBeta0] = Base.sincos(beta0)
		const A = new Float64Array(9)
		const B = new Float64Array(9)
		const C = new Float64Array(9)

		for (let j = 0; j < 9; j++) {
			let a = X[j]
			let b = q.c1 * Y[j] - q.s1 * Z[j]
			const c = q.s1 * Y[j] + q.c1 * Z[j]
			const a0 = q.c2 * a - q.s2 * b
			b = q.s2 * a + q.c2 * b
			a = a0

			A[j] = a * sLambda0 - b * cLambda0
			b = a * cLambda0 + b * sLambda0

			B[j] = b * cBeta0 + c * sBeta0
			C[j] = c * cBeta0 - b * sBeta0
		}

		const pos: [Vec3, Vec3, Vec3, Vec3, Vec3, Vec3, Vec3, Vec3] = [
			[0, 0, 0],
			[0, 0, 0],
			[0, 0, 0],
			[0, 0, 0],
			[0, 0, 0],
			[0, 0, 0],
			[0, 0, 0],
			[0, 0, 0],
		]
		const D = atan2(A[0], C[0])
		const [sD, cD] = Base.sincos(D)

		for (let j = 1; j <= 8; j++) {
			X[j] = A[j] * cD - C[j] * sD
			Y[j] = A[j] * sD + C[j] * cD
			Z[j] = B[j]
			const d = X[j] / s4[j].r
			X[j] += (abs(Z[j]) / K[j]) * sqrt(max(0, 1 - d * d))
			const W = delta / (delta + Z[j] / 2475)
			pos[j - 1] = [X[j] * W, Y[j] * W, Z[j]]
		}

		return pos
	}

	// Saturn-centered orbital coordinates, chapter 46; angles refer to the B1950 ecliptic/ring frame.
	export class R4 {
		// Creates coordinates with longitude lambda, latitude-related inclination gamma and node omega
		// in radians (unwrapped), and orbital radius r in Saturn equatorial radii; allocates a new value.
		constructor(
			// Satellite longitude in radians.
			public lambda: Angle = 0,
			// Orbital radius in Saturn radii.
			public r: number = 0,
			// Inclination to Saturn's equator in radians.
			public gamma: Angle = 0,
			// Ascending node in radians.
			public omega: Angle = 0,
		) {}
	}

	// Cached time arguments for the eight Dourneau satellite series at a single TT day.
	export class Qs {
		// Time argument t1 in days.
		readonly t1: number
		// Time argument t2 in Julian years.
		readonly t2: number
		// Time argument t3 in Julian years.
		readonly t3: number
		// Time argument t4 in days.
		readonly t4: number
		// Time argument t5 in Julian years.
		readonly t5: number
		// Time argument t6 in days.
		readonly t6: number
		// Time argument t7 in Julian centuries.
		readonly t7: number
		// Time argument t8 in Julian years.
		readonly t8: number
		// Time argument t9 in Julian years.
		readonly t9: number
		// Time argument t10 in days.
		readonly t10: number
		// Time argument t11 in Julian centuries.
		readonly t11: number
		// Unwrapped fundamental angle W0.
		readonly W0: Angle
		// Unwrapped fundamental angle W1.
		readonly W1: Angle
		// Unwrapped fundamental angle W2.
		readonly W2: Angle
		// Unwrapped fundamental angle W3.
		readonly W3: Angle
		// Unwrapped fundamental angle W4.
		readonly W4: Angle
		// Unwrapped fundamental angle W5.
		readonly W5: Angle
		// Unwrapped fundamental angle W6.
		readonly W6: Angle
		// Unwrapped fundamental angle W7.
		readonly W7: Angle
		// Unwrapped fundamental angle W8.
		readonly W8: Angle
		// Cached dimensionless trigonometric factor s1.
		readonly s1: number
		// Cached dimensionless trigonometric factor c1.
		readonly c1: number
		// Cached dimensionless trigonometric factor s2.
		readonly s2: number
		// Cached dimensionless trigonometric factor c2.
		readonly c2: number
		// Dimensionless Saturn orbital eccentricity.
		readonly e1: number
		// Cached dimensionless trigonometric factor sW0.
		readonly sW0: number
		// Cached dimensionless trigonometric factor s3W0.
		readonly s3W0: number
		// Cached dimensionless trigonometric factor s5W0.
		readonly s5W0: number
		// Cached dimensionless trigonometric factor sW1.
		readonly sW1: number
		// Cached dimensionless trigonometric factor sW2.
		readonly sW2: number
		// Cached dimensionless trigonometric factor sW3.
		readonly sW3: number
		// Cached dimensionless trigonometric factor cW3.
		readonly cW3: number
		// Cached dimensionless trigonometric factor sW4.
		readonly sW4: number
		// Cached dimensionless trigonometric factor cW4.
		readonly cW4: number
		// Cached dimensionless trigonometric factor sW7.
		readonly sW7: number
		// Cached dimensionless trigonometric factor cW7.
		readonly cW7: number

		// Precomputes the time arguments at emission-time TT Julian day jde.
		constructor(jde: number) {
			this.t1 = jde - 2411093
			this.t2 = this.t1 / 365.25
			this.t3 = (jde - 2433282.423) / 365.25 + 1950
			this.t4 = jde - 2411368
			this.t5 = this.t4 / 365.25
			this.t6 = jde - 2415020
			this.t7 = this.t6 / 36525
			this.t8 = this.t6 / 365.25
			this.t9 = (jde - 2442000.5) / 365.25
			this.t10 = jde - 2409786
			this.t11 = this.t10 / 36525
			this.W0 = 5.095 * DEG2RAD * (this.t3 - 1866.39)
			this.W1 = 74.4 * DEG2RAD + 32.39 * DEG2RAD * this.t2
			this.W2 = 134.3 * DEG2RAD + 92.62 * DEG2RAD * this.t2
			this.W3 = 42 * DEG2RAD - 0.5118 * DEG2RAD * this.t5
			this.W4 = 276.59 * DEG2RAD + 0.5118 * DEG2RAD * this.t5
			this.W5 = 267.2635 * DEG2RAD + 1222.1136 * DEG2RAD * this.t7
			this.W6 = 175.4762 * DEG2RAD + 1221.5515 * DEG2RAD * this.t7
			this.W7 = 2.4891 * DEG2RAD + 0.002435 * DEG2RAD * this.t7
			this.W8 = 113.35 * DEG2RAD - 0.2597 * DEG2RAD * this.t7
			this.s1 = sin(28.0817 * DEG2RAD)
			this.c1 = cos(28.0817 * DEG2RAD)
			this.s2 = sin(168.8112 * DEG2RAD)
			this.c2 = cos(168.8112 * DEG2RAD)
			this.e1 = 0.05589 - 0.000346 * this.t7
			this.sW0 = sin(this.W0)
			this.s3W0 = sin(3 * this.W0)
			this.s5W0 = sin(5 * this.W0)
			this.sW1 = sin(this.W1)
			this.sW2 = sin(this.W2)
			this.sW3 = sin(this.W3)
			this.cW3 = cos(this.W3)
			this.sW4 = sin(this.W4)
			this.cW4 = cos(this.W4)
			this.sW7 = sin(this.W7)
			this.cW7 = cos(this.W7)
		}

		// Returns newly allocated orbital coordinates for mimas at the cached emission time.
		mimas(): R4 {
			const r = new R4()
			const L = 127.64 * DEG2RAD + 381.994497 * DEG2RAD * this.t1 - 43.57 * DEG2RAD * this.sW0 - 0.72 * DEG2RAD * this.s3W0 - 0.02144 * DEG2RAD * this.s5W0
			const p = 106.1 * DEG2RAD + 365.549 * DEG2RAD * this.t2
			const M = L - p
			const C = 2.18287 * DEG2RAD * sin(M) + 0.025988 * DEG2RAD * sin(2 * M) + 0.00043 * DEG2RAD * sin(3 * M)
			r.lambda = L + C
			r.r = 3.06879 / (1 + 0.01905 * cos(M + C))
			r.gamma = 1.563 * DEG2RAD
			r.omega = 54.5 * DEG2RAD - 365.072 * DEG2RAD * this.t2
			return r
		}

		// Returns newly allocated orbital coordinates for enceladus at the cached emission time.
		enceladus(): R4 {
			const r = new R4()
			const L = 200.317 * DEG2RAD + 262.7319002 * DEG2RAD * this.t1 + 0.25667 * DEG2RAD * this.sW1 + 0.20883 * DEG2RAD * this.sW2
			const p = 309.107 * DEG2RAD + 123.44121 * DEG2RAD * this.t2
			const M = L - p
			const C = 0.55577 * DEG2RAD * sin(M) + 0.00168 * DEG2RAD * sin(2 * M)
			r.lambda = L + C
			r.r = 3.94118 / (1 + 0.00485 * cos(M + C))
			r.gamma = 0.0262 * DEG2RAD
			r.omega = 348 * DEG2RAD - 151.95 * DEG2RAD * this.t2
			return r
		}

		// Returns newly allocated orbital coordinates for tethys at the cached emission time.
		tethys(): R4 {
			const r = new R4()
			r.lambda = 285.306 * DEG2RAD + 190.69791226 * DEG2RAD * this.t1 + 2.063 * DEG2RAD * this.sW0 + 0.03409 * DEG2RAD * this.s3W0 + 0.001015 * DEG2RAD * this.s5W0
			r.r = 4.880998
			r.gamma = 1.0976 * DEG2RAD
			r.omega = 111.33 * DEG2RAD - 72.2441 * DEG2RAD * this.t2
			return r
		}

		// Returns newly allocated orbital coordinates for dione at the cached emission time.
		dione(): R4 {
			const r = new R4()
			const L = 254.712 * DEG2RAD + 131.53493193 * DEG2RAD * this.t1 - 0.0215 * DEG2RAD * this.sW1 - 0.01733 * DEG2RAD * this.sW2
			const p = 174.8 * DEG2RAD + 30.82 * DEG2RAD * this.t2
			const M = L - p
			const C = 0.24717 * DEG2RAD * sin(M) + 0.00033 * DEG2RAD * sin(2 * M)
			r.lambda = L + C
			r.r = 6.24871 / (1 + 0.002157 * cos(M + C))
			r.gamma = 0.0139 * DEG2RAD
			r.omega = 232 * DEG2RAD - 30.27 * DEG2RAD * this.t2
			return r
		}

		// Returns newly allocated orbital coordinates for rhea at the cached emission time.
		rhea(): R4 {
			const pPrime = 342.7 * DEG2RAD + 10.057 * DEG2RAD * this.t2
			const [spPrime, cpPrime] = Base.sincos(pPrime)
			const a1 = 0.000265 * spPrime + 0.001 * this.sW4
			const a2 = 0.000265 * cpPrime + 0.001 * this.cW4
			const e = hypot(a1, a2)
			const p = atan2(a1, a2)
			const N = 345 * DEG2RAD - 10.057 * DEG2RAD * this.t2
			const [sN, cN] = Base.sincos(N)
			const lambdaPrime = 359.244 * DEG2RAD + 79.6900472 * DEG2RAD * this.t1 + 0.086754 * DEG2RAD * sN
			const i = 28.0362 * DEG2RAD + 0.346898 * DEG2RAD * cN + 0.0193 * DEG2RAD * this.cW3
			const omega = 168.8034 * DEG2RAD + 0.736936 * DEG2RAD * sN + 0.041 * DEG2RAD * this.sW3
			const a = 8.725924
			return this.subr(lambdaPrime, p, e, a, omega, i)
		}

		// Reduces ecliptic elements to Saturn-equator coordinates; lambdaPrime, periapsis p, node omega
		// and inclination i are radians, eccentricity e is dimensionless, semimajor axis a is Saturn radii.
		// Returns a fresh R4 using the chapter 46 fifth-order equation of center.
		subr(lambdaPrime: Angle, p: Angle, e: number, a: number, omega: Angle, i: Angle): R4 {
			const r = new R4()
			const M = lambdaPrime - p
			const e2 = e * e
			const e3 = e2 * e
			const e4 = e2 * e2
			const e5 = e3 * e2
			const C = (2 * e - 0.25 * e3 + 0.0520833333 * e5) * sin(M) + (1.25 * e2 - 0.458333333 * e4) * sin(2 * M) + (1.083333333 * e3 - 0.671875 * e5) * sin(3 * M) + 1.072917 * e4 * sin(4 * M) + 1.142708 * e5 * sin(5 * M)
			r.r = (a * (1 - e2)) / (1 + e * cos(M + C)) // return value
			const g = omega - 168.8112 * DEG2RAD
			const [si, ci] = Base.sincos(i)
			const [sg, cg] = Base.sincos(g)
			const a1 = si * sg
			const a2 = this.c1 * si * cg - this.s1 * ci
			r.gamma = asin(min(1, hypot(a1, a2))) // return value
			const u = atan2(a1, a2)
			r.omega = 168.8112 * DEG2RAD + u // return value (w)
			const h = this.c1 * si - this.s1 * ci * cg
			const psi = atan2(this.s1 * sg, h)
			r.lambda = lambdaPrime + C + u - g - psi // return value
			return r
		}

		// Returns newly allocated orbital coordinates for titan at the cached emission time.
		titan(): R4 {
			const L = 261.1582 * DEG2RAD + 22.57697855 * DEG2RAD * this.t4 + 0.074025 * DEG2RAD * this.sW3
			const iPrime = 27.45141 * DEG2RAD + 0.295999 * DEG2RAD * this.cW3
			const omegaPrime = 168.66925 * DEG2RAD + 0.628808 * DEG2RAD * this.sW3
			const [siPrime, ciPrime] = Base.sincos(iPrime)
			const [sOmegaPrimeW8, cOmegaPrimeW8] = Base.sincos(omegaPrime - this.W8)
			const a1 = this.sW7 * sOmegaPrimeW8
			const a2 = this.cW7 * siPrime - this.sW7 * ciPrime * cOmegaPrimeW8
			const g0 = 102.8623 * DEG2RAD
			const psi = atan2(a1, a2)
			const s = hypot(a1, a2)
			let g = this.W4 - omegaPrime - psi
			let varpi = 0
			const [s2g0, c2g0] = Base.sincos(2 * g0)
			// Refines Titan periapsis in radians; called exactly three times.
			const f = () => {
				varpi = this.W4 + 0.37515 * DEG2RAD * (sin(2 * g) - s2g0)
				g = varpi - omegaPrime - psi
			}
			f()
			f()
			f()
			const ePrime = 0.029092 + 0.00019048 * (cos(2 * g) - c2g0)
			const qq = 2 * (this.W5 - varpi)
			const b1 = siPrime * sOmegaPrimeW8
			const b2 = this.cW7 * siPrime * cOmegaPrimeW8 - this.sW7 * ciPrime
			const theta = atan2(b1, b2) + this.W8
			const [sq, cq] = Base.sincos(qq)
			const e = ePrime + 0.002778797 * ePrime * cq
			const p = varpi + 0.159215 * DEG2RAD * sq
			const u = 2 * this.W5 - 2 * theta + psi
			const [su, cu] = Base.sincos(u)
			const h = 0.9375 * ePrime * ePrime * sq + 0.1875 * s * s * sin(2 * (this.W5 - theta))
			const lambdaPrime = L - 0.254744 * DEG2RAD * (this.e1 * sin(this.W6) + 0.75 * this.e1 * this.e1 * sin(2 * this.W6) + h)
			const i = iPrime + 0.031843 * DEG2RAD * s * cu
			const omega = omegaPrime + (0.031843 * DEG2RAD * s * su) / siPrime
			const a = 20.216193
			return this.subr(lambdaPrime, p, e, a, omega, i)
		}

		// Returns newly allocated orbital coordinates for hyperion at the cached emission time.
		hyperion(): R4 {
			const eta = 92.39 * DEG2RAD + 0.5621071 * DEG2RAD * this.t6
			const zeta = 148.19 * DEG2RAD - 19.18 * DEG2RAD * this.t8
			const theta = 184.8 * DEG2RAD - 35.41 * DEG2RAD * this.t9
			const thetaPrime = theta - 7.5 * DEG2RAD
			const as = 176 * DEG2RAD + 12.22 * DEG2RAD * this.t8
			const bs = 8 * DEG2RAD + 24.44 * DEG2RAD * this.t8
			const cs = bs + 5 * DEG2RAD
			const varpi = 69.898 * DEG2RAD - 18.67088 * DEG2RAD * this.t8
			const phi = 2 * (varpi - this.W5)
			const chi = 94.9 * DEG2RAD - 2.292 * DEG2RAD * this.t8
			const [sEta, cEta] = Base.sincos(eta)
			const [sZeta, cZeta] = Base.sincos(zeta)
			const [s2Zeta, c2Zeta] = Base.sincos(2 * zeta)
			const [s3Zeta, c3Zeta] = Base.sincos(3 * zeta)
			const [sZetapEta, cZetapEta] = Base.sincos(zeta + eta)
			const [sZetamEta, cZetamEta] = Base.sincos(zeta - eta)
			const [sPhi, cPhi] = Base.sincos(phi)
			const [sChi, cChi] = Base.sincos(chi)
			const [scs, ccs] = Base.sincos(cs)
			const a = 24.50601 - 0.08686 * cEta - 0.00166 * cZetapEta + 0.00175 * cZetamEta
			const e = 0.103458 - 0.004099 * cEta - 0.000167 * cZetapEta + 0.000235 * cZetamEta + 0.02303 * cZeta - 0.00212 * c2Zeta + 0.000151 * c3Zeta + 0.00013 * cPhi
			const p = varpi + 0.15648 * DEG2RAD * sChi - 0.4457 * DEG2RAD * sEta - 0.2657 * DEG2RAD * sZetapEta - 0.3573 * DEG2RAD * sZetamEta - 12.872 * DEG2RAD * sZeta + 1.668 * DEG2RAD * s2Zeta - 0.2419 * DEG2RAD * s3Zeta - 0.07 * DEG2RAD * sPhi
			const lambdaPrime =
				177.047 * DEG2RAD +
				16.91993829 * DEG2RAD * this.t6 +
				0.15648 * DEG2RAD * sChi +
				9.142 * DEG2RAD * sEta +
				0.007 * DEG2RAD * sin(2 * eta) -
				0.014 * DEG2RAD * sin(3 * eta) +
				0.2275 * DEG2RAD * sZetapEta +
				0.2112 * DEG2RAD * sZetamEta -
				0.26 * DEG2RAD * sZeta -
				0.0098 * DEG2RAD * s2Zeta -
				0.013 * DEG2RAD * sin(as) +
				0.017 * DEG2RAD * sin(bs) -
				0.0303 * DEG2RAD * sPhi
			const i = 27.3347 * DEG2RAD + 0.6434886 * DEG2RAD * cChi + 0.315 * DEG2RAD * this.cW3 + 0.018 * DEG2RAD * cos(theta) - 0.018 * DEG2RAD * ccs
			const omega = 168.6812 * DEG2RAD + 1.40136 * DEG2RAD * cChi + 0.68599 * DEG2RAD * this.sW3 - 0.0392 * DEG2RAD * scs + 0.0366 * DEG2RAD * sin(thetaPrime)
			return this.subr(lambdaPrime, p, e, a, omega, i)
		}

		// Returns newly allocated orbital coordinates for iapetus at the cached emission time.
		iapetus(): R4 {
			const L = 261.1582 * DEG2RAD + 22.57697855 * DEG2RAD * this.t4
			const varpiPrime = 91.796 * DEG2RAD + 0.562 * DEG2RAD * this.t7
			const psi = 4.367 * DEG2RAD - 0.195 * DEG2RAD * this.t7
			const theta = 146.819 * DEG2RAD - 3.198 * DEG2RAD * this.t7
			// Keep phi and Phi distinct (Meeus 46; soniakeys/meeus v3/saturnmoons).
			// The legacy transliteration swapped their definitions and merged gT's argument.
			const phi = 60.47 * DEG2RAD + 1.521 * DEG2RAD * this.t7
			const Phi = 205.055 * DEG2RAD - 2.091 * DEG2RAD * this.t7
			const ePrime = 0.028298 + 0.001156 * this.t11
			const varpi0 = 352.91 * DEG2RAD + 11.71 * DEG2RAD * this.t11
			const mu = 76.3852 * DEG2RAD + 4.53795125 * DEG2RAD * this.t10
			const iPrime = Base.horner(this.t11, [18.4602 * DEG2RAD, -0.9518 * DEG2RAD, -0.072 * DEG2RAD, 0.0054 * DEG2RAD])
			const omegaPrime = Base.horner(this.t11, [143.198 * DEG2RAD, -3.919 * DEG2RAD, 0.116 * DEG2RAD, 0.008 * DEG2RAD])
			const l = mu - varpi0
			const g = varpi0 - omegaPrime - psi
			const g1 = varpi0 - omegaPrime - phi
			const ls = this.W5 - varpiPrime
			const gs = varpiPrime - theta
			const lT = L - this.W4
			const gT = this.W4 - Phi
			const u1 = 2 * (l + g - ls - gs)
			const u2 = l + g1 - lT - gT
			const u3 = l + 2 * (g - ls - gs)
			const u4 = lT + gT - g1
			const u5 = 2 * (ls + gs)
			const [sl, cl] = Base.sincos(l)
			const [su1, cu1] = Base.sincos(u1)
			const [su2, cu2] = Base.sincos(u2)
			const [su3, cu3] = Base.sincos(u3)
			const [su4, cu4] = Base.sincos(u4)
			const [slu2, clu2] = Base.sincos(l + u2)
			const [sg1gT, cg1gT] = Base.sincos(g1 - gT)
			const [su52g, cu52g] = Base.sincos(u5 - 2 * g)
			const [su5Psi, cu5Psi] = Base.sincos(u5 + psi)
			const [su2Phi, cu2Phi] = Base.sincos(u2 + phi)
			const [s5, c5] = Base.sincos(l + g1 + lT + gT + phi)
			const a = 58.935028 + 0.004638 * cu1 + 0.058222 * cu2
			const e = ePrime - 0.0014097 * cg1gT + 0.0003733 * cu52g + 0.000118 * cu3 + 0.0002408 * cl + 0.0002849 * clu2 + 0.000619 * cu4
			const w = 0.08077 * DEG2RAD * sg1gT + 0.02139 * DEG2RAD * su52g - 0.00676 * DEG2RAD * su3 + 0.0138 * DEG2RAD * sl + 0.01632 * DEG2RAD * slu2 + 0.03547 * DEG2RAD * su4
			const p = varpi0 + w / ePrime
			const lambdaPrime = mu - 0.04299 * DEG2RAD * su2 - 0.00789 * DEG2RAD * su1 - 0.06312 * DEG2RAD * sin(ls) - 0.00295 * DEG2RAD * sin(2 * ls) - 0.02231 * DEG2RAD * sin(u5) + 0.0065 * DEG2RAD * su5Psi
			const i = iPrime + 0.04204 * DEG2RAD * cu5Psi + 0.00235 * DEG2RAD * c5 + 0.0036 * DEG2RAD * cu2Phi
			const wPrime = 0.04204 * DEG2RAD * su5Psi + 0.00235 * DEG2RAD * s5 + 0.00358 * DEG2RAD * su2Phi
			const omega = omegaPrime + wPrime / sin(iPrime)
			return this.subr(lambdaPrime, p, e, a, omega, i)
		}
	}
}

// Chapter 47: Position of the Moon.
export namespace MoonPosition {
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

	// Computes the longitude of perigee of the lunar orbit.
	export function perigee(jde: number) {
		return normalizeAngle(Base.horner(Base.j2000Century(jde), [83.3532465 * DEG2RAD, 4069.0137287 * DEG2RAD, -0.01032 * DEG2RAD, -DEG2RAD / 80053, DEG2RAD / 18999000]))
	}

	// Computes the longitude of the true ascending node. That is, the node of the instantaneous lunar orbit.
	export function trueNode(jde: number) {
		const [d, m, m_, f] = dmf(Base.j2000Century(jde))
		return moonMeanAscendingNode(time(jde, 0, Timescale.TT)) - 1.4979 * DEG2RAD * sin(2 * (d - f)) - 0.15 * DEG2RAD * sin(m) - 0.1226 * DEG2RAD * sin(2 * d) + 0.1176 * DEG2RAD * sin(2 * f) - 0.0801 * DEG2RAD * sin(2 * (m_ - f))
	}
}

// Chapter 48: Illuminated Fraction of the Moon's Disk
export namespace MoonIlluminated {
	// Computes the phase angle of the Moon given geocentric equatorial coordinates.
	export function phaseAngleEquatorial(cMoon: Coord, cSun: Coord) {
		return pa(cMoon[2]!, cSun[2]!, cosEq(cMoon[0], cMoon[1], cSun[0], cSun[1]))
	}

	// Computes the cosine of the elongation from equatorial coordinates.
	function cosEq(alpha0: Angle, delta0: Angle, alpha1: Angle, delta1: Angle) {
		const [sDelta0, cDelta0] = Base.sincos(delta0)
		const [sDelta1, cDelta1] = Base.sincos(delta1)
		return sDelta1 * sDelta0 + cDelta1 * cDelta0 * cos(alpha1 - alpha0)
	}

	// Returns lunar phase angle [0, PI] in radians from lunar/solar distances delta/R in the same
	// units and cosine of elongation cPsi; clamps roundoff and preserves the new-Moon quadrant at zero elongation.
	function pa(delta: Distance, R: Distance, cPsi: Angle) {
		cPsi = max(-1, min(1, cPsi))
		const sPsi = sqrt((1 - cPsi) * (1 + cPsi))
		return atan2(R * sPsi, delta - R * cPsi)
	}

	// Computes the phase angle of the Moon given equatorial coordinates. Less accurate than phaseAngleEquatorial.
	export function phaseAngleEquatorial2(cMoon: Coord, cSun: Coord) {
		return acos(max(-1, min(1, -cosEq(cMoon[0], cMoon[1], cSun[0], cSun[1]))))
	}

	// Computes the phase angle of the Moon given ecliptic coordinates.
	export function phaseAngleEcliptic(cMoon: Coord, cSun: Coord) {
		return pa(cMoon[2]!, cSun[2]!, cosEcl(cMoon[0], cMoon[1], cSun[0]))
	}

	// Computes the cosine of the elongation from ecliptic coordinates
	function cosEcl(lambda: Angle, beta: Angle, lambda0: Angle) {
		return cos(beta) * cos(lambda - lambda0)
	}

	// Computes the phase angle of the Moon given ecliptic coordinates. Less accurate than phaseAngleEcliptic.
	export function phaseAngleEcliptic2(cMoon: Coord, cSun: Coord) {
		return acos(max(-1, min(1, -cosEcl(cMoon[0], cMoon[1], cSun[0]))))
	}

	const PA3_D = [297.8501921 * DEG2RAD, 445267.1114034 * DEG2RAD, -0.0018819 * DEG2RAD, DEG2RAD / 545868, -DEG2RAD / 113065000] as const
	const PA3_m = [357.5291092 * DEG2RAD, 35999.0502909 * DEG2RAD, -0.0001536 * DEG2RAD, DEG2RAD / 24490000] as const
	const PA3_M = [134.9633964 * DEG2RAD, 477198.8675055 * DEG2RAD, 0.0087414 * DEG2RAD, DEG2RAD / 69699, -DEG2RAD / 14712000] as const

	// Computes the phase angle of the Moon given a julian day. Less accurate than phaseAngle functions taking coordinates.
	export function phaseAngle3(jde: number) {
		const T = Base.j2000Century(jde)
		const D = Base.horner(T, PA3_D)
		const m = Base.horner(T, PA3_m)
		const M = Base.horner(T, PA3_M)
		return PI - normalizeAngle(D) - 6.289 * DEG2RAD * sin(M) + 2.1 * DEG2RAD * sin(m) - 1.274 * DEG2RAD * sin(2 * D - M) - 0.658 * DEG2RAD * sin(2 * D) - 0.214 * DEG2RAD * sin(2 * M) - 0.11 * DEG2RAD * sin(D)
	}
}

// Chapter 53: Physical Observations of the Moon. Geocentric librations and lunar solar geometry.
export namespace Moon {
	// Selenographic east longitude and north latitude in radians; longitude normalization is caller-specific.
	export type Coordinates = readonly [longitude: Angle, latitude: Angle]

	// IAU inclination of the mean lunar equator to the ecliptic, radians (Meeus chapter 53).
	const _I = 1.54242 * DEG2RAD // IAU value of inclination of mean lunar equator

	// Dimensionless sine and cosine of the mean lunar-equator inclination.
	const [sI, cI] = Base.sincos(_I)

	// Returns fresh [libration coordinates, rotation-axis position angle, subsolar coordinates]
	// at jde (TT). All angles are radians; longitude is east-positive [-PI, PI), position angle
	// [0, TAU). Includes optical and physical geocentric librations, without topocentric corrections.
	export function physical(jde: number): readonly [Coordinates, Angle, Coordinates] {
		const [lon, lat, range] = MoonPosition.position(jde) // (lambda without nutation)
		// [lambda, beta, delta]
		const m = new PhysicalEphemeris(jde)
		const [l, b] = m.lib(lon, lat)
		const P = m.pa(lon, lat, b)
		const [l0, b0] = m.sun(lon, lat, range)
		return [[l, b], P, [l0, b0]]
	}

	// Cached lunar nutation and physical-libration terms at a single TT day (Meeus chapter 53).
	export class PhysicalEphemeris {
		// TT Julian day of the cached ephemeris.
		readonly jde: number
		// Nutation in longitude, radians.
		readonly deltaPsi: Angle
		// Unwrapped lunar argument of latitude, radians.
		readonly F: Angle
		// Unwrapped ascending-node longitude, radians.
		readonly omega: Angle
		// True obliquity of the ecliptic, radians.
		readonly epsilon: Angle
		// Dimensionless sine of true obliquity.
		readonly sEpsilon: number
		// Dimensionless cosine of true obliquity.
		readonly cEpsilon: number
		// Physical-libration coefficient rho, radians.
		readonly rho: Angle
		// Physical-libration coefficient sigma, radians.
		readonly sigma: Angle
		// Physical-libration coefficient tau, radians.
		readonly tau: Angle

		// Precomputes the periodic terms at jde (TT); does not evaluate Earth or Moon positions.
		constructor(jde: number) {
			this.jde = jde
			// deltaPsi, F, omega, p. 372.0
			const [deltaPsi, deltaEpsilon] = Nutation.nutation(jde)
			this.deltaPsi = deltaPsi
			const T = Base.j2000Century(jde)
			const F = (this.F = Base.horner(T, [93.272095 * DEG2RAD, 483202.0175233 * DEG2RAD, -0.0036539 * DEG2RAD, -DEG2RAD / 3526000, DEG2RAD / 863310000]))
			this.omega = Base.horner(T, [125.0445479 * DEG2RAD, -1934.1362891 * DEG2RAD, 0.0020754 * DEG2RAD, DEG2RAD / 467441, -DEG2RAD / 60616000])
			// true ecliptic
			this.epsilon = Nutation.meanObliquity(jde) + deltaEpsilon
			this.sEpsilon = sin(this.epsilon)
			this.cEpsilon = cos(this.epsilon)
			// rho, sigma, tau, p. 372,373
			const D = Base.horner(T, [297.8501921 * DEG2RAD, 445267.1114034 * DEG2RAD, -0.0018819 * DEG2RAD, DEG2RAD / 545868, -DEG2RAD / 113065000])
			const M = Base.horner(T, [357.5291092 * DEG2RAD, 35999.0502909 * DEG2RAD, -0.0001536 * DEG2RAD, DEG2RAD / 24490000])
			const M_ = Base.horner(T, [134.9633964 * DEG2RAD, 477198.8675055 * DEG2RAD, 0.0087414 * DEG2RAD, DEG2RAD / 69699, -DEG2RAD / 14712000])
			const E = Base.horner(T, [1, -0.002516, -0.0000074])
			const K1 = 119.75 * DEG2RAD + 131.849 * DEG2RAD * T
			const K2 = 72.56 * DEG2RAD + 20.186 * DEG2RAD * T
			this.rho =
				-0.02752 * DEG2RAD * cos(M_) +
				-0.02245 * DEG2RAD * sin(F) +
				0.00684 * DEG2RAD * cos(M_ - 2 * F) +
				-0.00293 * DEG2RAD * cos(2 * F) +
				-0.00085 * DEG2RAD * cos(2 * (F - D)) +
				-0.00054 * DEG2RAD * cos(M_ - 2 * D) +
				-0.0002 * DEG2RAD * sin(M_ + F) +
				-0.0002 * DEG2RAD * cos(M_ + 2 * F) +
				-0.0002 * DEG2RAD * cos(M_ - F) +
				0.00014 * DEG2RAD * cos(M_ + 2 * (F - D))
			this.sigma =
				-0.02816 * DEG2RAD * sin(M_) +
				0.02244 * DEG2RAD * cos(F) +
				-0.00682 * DEG2RAD * sin(M_ - 2 * F) +
				-0.00279 * DEG2RAD * sin(2 * F) +
				-0.00083 * DEG2RAD * sin(2 * (F - D)) +
				0.00069 * DEG2RAD * sin(M_ - 2 * D) +
				0.0004 * DEG2RAD * cos(M_ + F) +
				-0.00025 * DEG2RAD * sin(2 * M_) +
				-0.00023 * DEG2RAD * sin(M_ + 2 * F) +
				0.0002 * DEG2RAD * cos(M_ - F) +
				0.00019 * DEG2RAD * sin(M_ - F) +
				0.00013 * DEG2RAD * sin(M_ + 2 * (F - D)) +
				-0.0001 * DEG2RAD * cos(M_ - 3 * F)
			this.tau =
				0.0252 * DEG2RAD * sin(M) * E +
				0.00473 * DEG2RAD * sin(2 * (M_ - F)) +
				-0.00467 * DEG2RAD * sin(M_) +
				0.00396 * DEG2RAD * sin(K1) +
				0.00276 * DEG2RAD * sin(2 * (M_ - D)) +
				0.00196 * DEG2RAD * sin(this.omega) +
				-0.00183 * DEG2RAD * cos(M_ - F) +
				0.00115 * DEG2RAD * sin(M_ - 2 * D) +
				-0.00096 * DEG2RAD * sin(M_ - D) +
				0.00046 * DEG2RAD * sin(2 * (F - D)) +
				-0.00039 * DEG2RAD * sin(M_ - F) +
				-0.00032 * DEG2RAD * sin(M_ - M - D) +
				0.00027 * DEG2RAD * sin(2 * (M_ - D) - M) +
				0.00023 * DEG2RAD * sin(K2) +
				-0.00014 * DEG2RAD * sin(2 * D) +
				0.00014 * DEG2RAD * cos(2 * (M_ - F)) +
				-0.00012 * DEG2RAD * sin(M_ - 2 * F) +
				-0.00012 * DEG2RAD * sin(2 * M_) +
				0.00011 * DEG2RAD * sin(2 * (M_ - M - D))
		}

		// Returns fresh combined librations or subsolar [longitude, latitude] (radians), depending on
		// the supplied mean-ecliptic direction lambda/beta (radians); longitude is east-positive [-PI, PI).
		lib(lambda: Angle, beta: Angle): Coordinates {
			const [l_, b_, A] = this.optical(lambda, beta)
			const [l$, b$] = this.physical(A, b_)
			const l = normalizeAngle(l_ + l$ + PI) - PI
			const b = b_ + b$
			return [l, b]
		}

		// Returns fresh optical [longitude, latitude, auxiliary angle A] (radians) for mean-ecliptic
		// direction lambda/beta at the cached time; longitude is [0, TAU).
		optical(lambda: Angle, beta: Angle): readonly [Angle, Angle, Angle] {
			// (53.1) p. 372
			const W = lambda - this.omega // (lambda without nutation)
			const [sW, cW] = Base.sincos(W)
			const [sBeta, cBeta] = Base.sincos(beta)
			const A = atan2(sW * cBeta * cI - sBeta * sI, cW * cBeta)
			const l_ = normalizeAngle(A - this.F)
			const b_ = asin(-sW * cBeta * sI - sBeta * cI)
			return [l_, b_, A]
		}

		// Returns fresh physical corrections [dLongitude, dLatitude] (radians) for optical auxiliary
		// angle A and optical latitude b_ (radians); first-order approximation away from lunar poles.
		physical(A: Angle, b_: Angle): Coordinates {
			// (53.2) p. 373
			const [sA, cA] = Base.sincos(A)
			const l$ = -this.tau + (this.rho * cA + this.sigma * sA) * tan(b_)
			const b$ = this.sigma * cA - this.rho * sA
			return [l$, b$]
		}

		// Returns the geocentric north-pole position angle [0, TAU) in radians for mean-ecliptic
		// lunar direction lambda/beta and combined libration latitude b, all in radians.
		pa(lambda: Angle, beta: Angle, b: Angle) {
			const V = this.omega + this.deltaPsi + this.sigma / sI
			const [sV, cV] = Base.sincos(V)
			const [sIRho, cIRho] = Base.sincos(_I + this.rho)
			const X = sIRho * sV
			const Y = sIRho * cV * this.cEpsilon - cIRho * this.sEpsilon
			const omega = atan2(X, Y)
			const [ra] = Coords.eclipticToEquatorial(lambda + this.deltaPsi, beta, this.epsilon)
			let P = asin(max(-1, min(1, (hypot(X, Y) * cos(ra - omega)) / cos(b))))
			if (P < 0) P += TAU
			return P
		}

		// Returns fresh east-positive subsolar [longitude, latitude] in radians from geocentric
		// lunar mean-ecliptic lambda/beta (radians) and distance delta (AU) at the cached time.
		// Uses the first-order lunar parallax approximation in Meeus chapter 53.
		sun(lambda: Angle, beta: Angle, delta: Distance): Coordinates {
			const [lon, , range] = Solar.apparentVSOP87(this.jde)
			const deltaR = delta / range
			const lambdaH = lon + PI + 57.296 * DEG2RAD * deltaR * cos(beta) * sin(lon - lambda)
			const betaH = deltaR * beta
			return this.lib(lambdaH, betaH)
		}
	}

	// Returns geometric solar-center altitude in radians above a spherical lunar horizon, given
	// east-positive selenographic [longitude, latitude] cOnMoon and subsolar cSun, both in radians.
	export function sunAltitude(cOnMoon: Coordinates, cSun: Coordinates) {
		const c0 = PIOVERTWO - cSun[0]
		const [sb0, cb0] = Base.sincos(cSun[1])
		const [sTheta, cTheta] = Base.sincos(cOnMoon[1])
		return asin(max(-1, min(1, sb0 * sTheta + cb0 * cTheta * sin(c0 + cOnMoon[0]))))
	}

	// Returns an approximate TT Julian day of solar-center sunrise at cOnMoon, an east-positive
	// selenographic [longitude, latitude] in radians. The initial jde (TT) must be close to sunrise
	// (within about a day) at a nonpolar site; applies exactly two Meeus corrections, no terrain/refraction.
	export function sunrise(cOnMoon: Coordinates, jde: number) {
		jde -= srCorr(cOnMoon, jde)
		return jde - srCorr(cOnMoon, jde)
	}

	// Returns an approximate TT Julian day of solar-center sunset at cOnMoon, an east-positive
	// selenographic [longitude, latitude] in radians. The initial jde (TT) must be close to sunset
	// (within about a day) at a nonpolar site; applies exactly two Meeus corrections, no terrain/refraction.
	export function sunset(cOnMoon: Coordinates, jde: number) {
		jde += srCorr(cOnMoon, jde)
		return jde + srCorr(cOnMoon, jde)
	}

	// Returns the linear horizon-crossing correction in days for nonpolar lunar site cOnMoon
	// (east longitude/latitude, radians) at jde (TT), using Meeus mean synodic rotation rate.
	function srCorr(cOnMoon: Coordinates, jde: number) {
		const phy = physical(jde)
		const h = sunAltitude(cOnMoon, phy[2])
		return h / (12.19075 * DEG2RAD * cos(cOnMoon[1]))
	}

	// East-positive longitude and north latitude (selenographic coordinates) in radians of lunar features, Meeus table 53.A.
	export const selenographic = Object.freeze({
		archimedes: [-3.9 * DEG2RAD, 29.7 * DEG2RAD],
		aristarchus: [-47.5 * DEG2RAD, 23.7 * DEG2RAD],
		aristillus: [1.2 * DEG2RAD, 33.9 * DEG2RAD],
		aristoteles: [17.3 * DEG2RAD, 50.1 * DEG2RAD],
		arzachel: [-1.9 * DEG2RAD, -17.7 * DEG2RAD],
		autolycus: [1.5 * DEG2RAD, 30.7 * DEG2RAD],
		billy: [-50 * DEG2RAD, -13.8 * DEG2RAD],
		birt: [-8.5 * DEG2RAD, -22.3 * DEG2RAD],
		campanus: [-27.7 * DEG2RAD, -28 * DEG2RAD],
		censorinus: [32.7 * DEG2RAD, -0.4 * DEG2RAD],
		clavius: [-14 * DEG2RAD, -58 * DEG2RAD],
		copernicus: [-20 * DEG2RAD, 9.7 * DEG2RAD],
		delambre: [17.5 * DEG2RAD, -1.9 * DEG2RAD],
		dionysius: [17.3 * DEG2RAD, 2.8 * DEG2RAD],
		endymion: [56.4 * DEG2RAD, 53.6 * DEG2RAD],
		eratosthenes: [-11.3 * DEG2RAD, 14.5 * DEG2RAD],
		eudoxus: [16.3 * DEG2RAD, 44.3 * DEG2RAD],
		fracastorius: [33.2 * DEG2RAD, -21 * DEG2RAD],
		fraMauro: [-17 * DEG2RAD, -6 * DEG2RAD],
		gassendi: [-39.9 * DEG2RAD, -17.5 * DEG2RAD],
		goclenius: [45 * DEG2RAD, -10.1 * DEG2RAD],
		grimaldi: [-68.5 * DEG2RAD, -5.8 * DEG2RAD],
		harpalus: [-43.4 * DEG2RAD, 52.6 * DEG2RAD],
		horrocks: [5.9 * DEG2RAD, -4 * DEG2RAD],
		kepler: [-38 * DEG2RAD, 8.1 * DEG2RAD],
		langrenus: [60.9 * DEG2RAD, -8.9 * DEG2RAD],
		lansberg: [-26.6 * DEG2RAD, -0.3 * DEG2RAD],
		letronne: [-43 * DEG2RAD, -10 * DEG2RAD],
		macrobius: [46 * DEG2RAD, 21.2 * DEG2RAD],
		manilius: [9.1 * DEG2RAD, 14.5 * DEG2RAD],
		menelaus: [16 * DEG2RAD, 16.3 * DEG2RAD],
		messier: [47.6 * DEG2RAD, -1.9 * DEG2RAD],
		petavius: [61 * DEG2RAD, -25 * DEG2RAD],
		pico: [-8.8 * DEG2RAD, 45.8 * DEG2RAD],
		pitatus: [-13.5 * DEG2RAD, -29.8 * DEG2RAD],
		piton: [-0.8 * DEG2RAD, 40.8 * DEG2RAD],
		plato: [-9.2 * DEG2RAD, 51.4 * DEG2RAD],
		plinius: [23.6 * DEG2RAD, 15.3 * DEG2RAD],
		posidonius: [30 * DEG2RAD, 31.9 * DEG2RAD],
		proclus: [46.9 * DEG2RAD, 16.1 * DEG2RAD],
		ptolemeusA: [-0.8 * DEG2RAD, -8.5 * DEG2RAD],
		pytheas: [-20.6 * DEG2RAD, 20.5 * DEG2RAD],
		reinhold: [-22.8 * DEG2RAD, 3.2 * DEG2RAD],
		riccioli: [-74.3 * DEG2RAD, -3.2 * DEG2RAD],
		schickard: [-54.5 * DEG2RAD, -44 * DEG2RAD],
		schiller: [-39 * DEG2RAD, -52 * DEG2RAD],
		tauruntius: [46.5 * DEG2RAD, 5.6 * DEG2RAD],
		theophilus: [26.5 * DEG2RAD, -11.4 * DEG2RAD],
		timocharis: [-13.1 * DEG2RAD, 26.7 * DEG2RAD],
		tycho: [-11 * DEG2RAD, -43.2 * DEG2RAD],
		vitruvius: [31.3 * DEG2RAD, 17.6 * DEG2RAD],
		walter: [1 * DEG2RAD, -33 * DEG2RAD],
	} as const)
}

// Chapter 55: Semidiameters of the Sun, Moon, and Planets.
export namespace Semidiameter {
	// Standard semidiameters at unit distance of 1 AU, scaled to radians.
	export const SUN = 959.63 * ASEC2RAD
	export const MERCURY = 3.36 * ASEC2RAD
	export const VENUS_SURFACE = 8.34 * ASEC2RAD
	export const VENUS_CLOUD = 8.41 * ASEC2RAD
	export const MARS = 4.68 * ASEC2RAD
	export const JUPITER_EQUATORIAL = 98.44 * ASEC2RAD
	export const JUPITER_POLAR = 92.06 * ASEC2RAD
	export const SATURN_EQUATORIAL = 82.73 * ASEC2RAD
	export const SATURN_POLAR = 73.82 * ASEC2RAD
	export const URANUS = 35.02 * ASEC2RAD
	export const NEPTUNE = 33.5 * ASEC2RAD
	export const PLUTO = 2.07 * ASEC2RAD

	// Computes the semidiameter at specified distance.
	export function semidiameter(s0: number, delta: Distance) {
		return s0 / delta
	}

	// Computes apparent polar semidiameter of Saturn at specified distance.
	// Argument delta must be observer-Saturn distance in AU. Argument B is
	// Saturnicentric latitude of the observer as given by function saturnring.UB
	export function saturnApparentPolar(delta: Distance, B: Angle) {
		let k = SATURN_POLAR / SATURN_EQUATORIAL
		k = 1 - k * k
		const cB = cos(B)
		return (SATURN_EQUATORIAL / delta) * sqrt(1 - k * cB * cB)
	}

	// Computes the approximate diameter in km given absolute magnitude H and albedo A.
	export function asteroidDiameter(H: number, A: number) {
		return 10 ** (3.12 - 0.2 * H - 0.5 * log10(A))
	}

	// Returns angular semidiameter in radians for physical diameter d in km and center distance
	// delta in AU. Uses the small-angle approximation radius/distance, valid for distant asteroids.
	export function asteroid(d: number, delta: Distance) {
		return d / (2 * AU_KM * delta)
	}
}

// Chapter 56: Stellar Magnitudes.
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

// Chapter 57: Binary Stars
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
		if (theta < 0) theta += TAU
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

// Chapter 58: Calculation of a Planar Sundial.
export namespace Sundial {
	// holds data to draw an hour line on the sundial.
	export interface Line {
		readonly hour: number // 0 to 24
		// One or more points corresponding to the hour.
		readonly points: readonly Point[]
	}

	const m = [-23.44 * DEG2RAD, -20.15 * DEG2RAD, -11.47 * DEG2RAD, 0, 11.47 * DEG2RAD, 20.15 * DEG2RAD, 23.44 * DEG2RAD] as const

	// Computes data for the general case of a planar sundial.
	// "phi" is geographic latitude at which the sundial will be located.
	// "D" is gnomonic declination, the azimuth of the perpendicular to the plane
	// of the sundial, measured from the southern meridian towards the west.
	// "a" is the length of a straight stylus perpendicular to the plane
	// of the sundial, "z" is zenithal distance of the direction defined by the stylus.
	// Results consist of a set of lines, a center point, u, the length of a
	// polar stylus, and psi, the angle which the polar stylus makes with the plane
	// of the sundial. The center point, the points defining the hour lines, and
	// u are in units of "a", the stylus length.
	export function general(phi: Angle, D: Angle, a: number, z: Angle) {
		const [sPhi, cPhi] = Base.sincos(phi)
		const [sD, cD] = Base.sincos(D)
		const [sz, cz] = Base.sincos(z)
		const P = sPhi * cz - cPhi * sz * cD
		const lines: Line[] = []

		for (let hour = 0; hour < 24; hour++) {
			const H = (hour - 12) * 15 * DEG2RAD
			const [sH, cH] = Base.sincos(H)
			const points: Point[] = []

			for (const d of m) {
				const tDelta = tan(d)

				if (sPhi * tDelta + cPhi * cH <= 0) continue // sun at or below horizon, including polar night

				const Q = sD * sz * sH + (cPhi * cz + sPhi * sz * cD) * cH + P * tDelta
				if (Q < 0) continue // sun below plane of sundial

				const Nx = cD * sH - sD * (sPhi * cH - cPhi * tDelta)
				const Ny = cz * sD * sH - (cPhi * sz - sPhi * cz * cD) * cH - (sPhi * sz + cPhi * cz * cD) * tDelta
				points.push({ x: (a * Nx) / Q, y: (a * Ny) / Q })
			}

			if (points.length > 0) {
				lines.push({ hour, points })
			}
		}

		const x = (a / P) * cPhi * sD
		const y = (-a / P) * (sPhi * sz + cPhi * cz * cD)
		const center: Point = { x, y }

		const aP = abs(P)
		const length = a / aP // u
		const angle = asin(aP) // psi

		return { lines, center, length, angle } as const
	}

	// Computes data for a sundial level with the equator.
	// "phi" is geographic latitude at which the sundial will be located;
	// "a" is the length of a straight stylus perpendicular to the plane of the sundial.
	// The sundial will have two sides, north and south. Results define/ lines on the
	// north and south sides of the sundial. Result coordinates are in units of a, the stylus length.
	export function equatorial(phi: Angle, a: number) {
		const [sPhi, cPhi] = Base.sincos(phi)
		const north: Line[] = []
		const south: Line[] = []

		for (let hour = 0; hour < 24; hour++) {
			const H = (hour - 12) * 15 * DEG2RAD
			const [sH, cH] = Base.sincos(H)
			const sl: Point[] = []
			const nl: Point[] = []

			for (const d of m) {
				const tDelta = tan(d)

				if (sPhi * tDelta + cPhi * cH <= 0 || tDelta === 0) continue

				const x = (-a * sH) / tDelta
				const yy = (a * cH) / tDelta

				if (tDelta < 0) {
					sl.push({ x, y: yy })
				} else {
					nl.push({ x, y: -yy })
				}
			}

			if (nl.length > 0) north.push({ hour, points: nl })
			if (sl.length > 0) south.push({ hour, points: sl })
		}

		return { north, south } as const
	}

	// Computes data for a horizontal sundial.
	// Argument phi is geographic latitude at which the sundial will be located,
	// a is the length of a straight stylus perpendicular to the plane of the sundial.
	// Results consist of a set of lines, a center point, and u, the length of a
	// polar stylus. They are in units of a, the stylus length.
	export function horizontal(phi: Angle, a: number) {
		const [sPhi, cPhi] = Base.sincos(phi)
		const tPhi = sPhi / cPhi
		const lines: Line[] = []

		for (let hour = 0; hour < 24; hour++) {
			const H = (hour - 12) * 15 * DEG2RAD
			const [sH, cH] = Base.sincos(H)
			const points: Point[] = []

			for (const d of m) {
				const tDelta = tan(d)
				if (sPhi * tDelta + cPhi * cH <= 0) {
					continue // sun below horizon
				}
				const Q = cPhi * cH + sPhi * tDelta
				const x = (a * sH) / Q
				const y = (a * (sPhi * cH - cPhi * tDelta)) / Q
				points.push({ x, y })
			}

			if (points.length > 0) lines.push({ hour, points })
		}

		const center: Point = { x: 0, y: -a / tPhi }
		const length = a / abs(sPhi) // u

		return { lines, center, length } as const
	}

	// Computes data for a vertical sundial.
	// "phi" is geographic latitude at which the sundial will be located.
	// "D" is gnomonic declination, the azimuth of the perpendicular to the plane
	// of the sundial, measured from the southern meridian towards the west.
	// "a" is the length of a straight stylus perpendicular to the plane of the sundial.
	// Results consist of a set of lines, a center point, and u, the length of a
	// polar stylus. They are in units of a, the stylus length.
	export function vertical(phi: Angle, D: Angle, a: number) {
		const [sPhi, cPhi] = Base.sincos(phi)
		const tPhi = sPhi / cPhi
		const [sD, cD] = Base.sincos(D)
		const lines = []

		for (let hour = 0; hour < 24; hour++) {
			const H = (hour - 12) * 15 * DEG2RAD
			const [sH, cH] = Base.sincos(H)
			const points: Point[] = []

			for (const d of m) {
				const tDelta = tan(d)

				if (sPhi * tDelta + cPhi * cH <= 0) continue // sun at or below horizon, including polar night

				const Q = sD * sH + sPhi * cD * cH - cPhi * cD * tDelta

				if (Q < 0) continue // sun below plane of sundial

				const x = (a * (cD * sH - sPhi * sD * cH + cPhi * sD * tDelta)) / Q
				const y = (-a * (cPhi * cH + sPhi * tDelta)) / Q
				points.push({ x, y })
			}

			if (points.length > 0) lines.push({ hour, points })
		}

		const x = (-a * sD) / cD
		const y = (a * tPhi) / cD
		const center: Point = { x, y }
		const length = a / abs(cPhi * cD) // u

		return { lines, center, length } as const
	}
}

// Approximate solar rise/set, twilight and golden-hour events, including a bounded search through polar seasons.
export namespace Sunrise {
	// Conventional geometric solar center altitudes in radians; limb thresholds contain 34 arcminutes of refraction.
	const STANDARD_ALTITUDES = {
		// Solar lower limb at the horizon: 16-arcminute semidiameter minus mean refraction.
		limbEnd: (-18 / 60) * DEG2RAD,
		// Civil twilight, geometric solar center 6 degrees below the horizon.
		civil: -6 * DEG2RAD,
		// Nautical twilight, geometric solar center 12 degrees below the horizon.
		nautical: -12 * DEG2RAD,
		// Astronomical twilight, geometric solar center 18 degrees below the horizon.
		night: -18 * DEG2RAD,
		// Golden-hour boundary, geometric solar center 6 degrees above the horizon.
		golden: 6 * DEG2RAD,
	} as const

	// Solar events for the solar cycle associated with the input UT1 date. Normal events use two
	// evaluations of Meeus's low-order solar position/equation of time. During polar day return the
	// previous rising and next setting; during polar night return the next rising and previous setting.
	// Polar search examines at most 366 adjacent days and is approximate near grazing seasonal contacts.
	// Latitudes within about 0.4 degrees of either pole may have no resolvable event (undefined).
	export class Sunrise {
		// TT epoch corresponding to midnight of the selected UT1 calendar day.
		readonly #jde: number
		// Geodetic latitude in radians, north positive.
		readonly #lat: Angle
		// Geographic longitude in radians, west positive, normalized to [-PI, PI).
		readonly #lon: Angle
		// Optional positive horizon refraction in radians for solar limb events.
		readonly #refraction: Angle | undefined

		// Copies date's UT1 day without mutating its calendar. Latitude and west-positive longitude
		// are radians; refraction replaces the default 34 arcminutes for limb events only. Twilight
		// and golden-hour boundaries retain their conventional geometric altitudes.
		constructor(date: Julian.Calendar, lat: Angle, lon: Angle, refraction?: Angle) {
			const jd = floor(date.toJD() - 0.5) + 0.5
			this.#jde = new Julian.Calendar().fromJD(jd).toJDE()
			this.#lat = lat
			this.#lon = pmod(lon + PI, TAU) - PI
			this.#refraction = refraction
		}

		// Returns solar-noon offset in days from UT1 midnight, evaluated at TT jde.
		// Keeps negative/over-one-day offsets so antimeridian events retain the correct adjacent date.
		private calcNoon(jde: number) {
			return 0.5 + (this.#lon - EquationOfTime.eSmart(jde)) / TAU
		}

		// Returns a rising/setting offset in days, or a horizon state, evaluated at TT jde for h0 radians.
		private calcRiseOrSet(jde: number, h0: Angle, isSet: boolean): number | Rise.HorizonState {
			const dec = Solar.apparentEquatorial(jde)[1]
			const angle = Rise.hourAngle(this.#lat, h0, dec)
			if (typeof angle !== 'number') return angle
			return this.calcNoon(jde) + (isSet ? angle : -angle) / TAU
		}

		// Applies the two solar evaluations for the selected day and h0. If circumpolar, searches at
		// most 366 days in the direction implied by the actual horizon state (no seasonal date heuristic).
		// Returns fresh Gregorian UT1 labels; undefined means no crossing resolved within the bounded search.
		private calc(h0: Angle, isSet: boolean): Julian.CalendarGregorian | undefined {
			const first = this.calcRiseOrSet(this.#jde, h0, isSet)
			const second = typeof first === 'number' ? this.calcRiseOrSet(this.#jde + first, h0, isSet) : first
			if (typeof second === 'number') return new Julian.CalendarGregorian().fromJDE(this.#jde + second)
			if (second === 'grazing') return undefined
			const step = (isSet ? -1 : 1) * (second === 'alwaysAbove' ? -1 : 1)

			for (let i = 1; i <= 366; i++) {
				const jde = this.#jde + i * step
				const a = this.calcRiseOrSet(jde, h0, isSet)
				if (typeof a !== 'number') continue
				const b = this.calcRiseOrSet(jde + a, h0, isSet)
				if (typeof b === 'number') return new Julian.CalendarGregorian().fromJDE(jde + b)
			}

			return undefined
		}

		// Returns a fresh Gregorian UT1 calendar at upper solar transit; the UTC-like labels omit UT1-UTC.
		noon(): Julian.CalendarGregorian {
			const a = this.calcNoon(this.#jde + this.#lon / TAU)
			const b = this.calcNoon(this.#jde + a)
			return new Julian.CalendarGregorian().fromJDE(this.#jde + b)
		}

		// First appearance of the solar upper limb; returns fresh UT1 labels or undefined near the poles.
		rise() {
			return this.calc(Rise.stdh0Solar(this.#refraction), false)
		}

		// Disappearance of the solar upper limb; returns fresh UT1 labels or undefined near the poles.
		set() {
			return this.calc(Rise.stdh0Solar(this.#refraction), true)
		}

		// Entire disk first visible after rising; returns fresh UT1 labels or undefined near the poles.
		riseEnd() {
			return this.calc(Rise.refraction(STANDARD_ALTITUDES.limbEnd, this.#refraction), false)
		}

		// Disk starts disappearing before setting; returns fresh UT1 labels or undefined near the poles.
		setStart() {
			return this.calc(Rise.refraction(STANDARD_ALTITUDES.limbEnd, this.#refraction), true)
		}

		// Start of civil dawn at geometric solar altitude -6 degrees; fresh UT1 labels or undefined.
		dawn() {
			return this.calc(STANDARD_ALTITUDES.civil, false)
		}

		// End of civil dusk at geometric solar altitude -6 degrees; fresh UT1 labels or undefined.
		dusk() {
			return this.calc(STANDARD_ALTITUDES.civil, true)
		}

		// Start of nautical dawn at geometric solar altitude -12 degrees; fresh UT1 labels or undefined.
		nauticalDawn() {
			return this.calc(STANDARD_ALTITUDES.nautical, false)
		}

		// End of nautical dusk at geometric solar altitude -12 degrees; fresh UT1 labels or undefined.
		nauticalDusk() {
			return this.calc(STANDARD_ALTITUDES.nautical, true)
		}

		// Start of astronomical night at geometric solar altitude -18 degrees; fresh UT1 labels or undefined.
		nightStart() {
			return this.calc(STANDARD_ALTITUDES.night, true)
		}

		// End of astronomical night at geometric solar altitude -18 degrees; fresh UT1 labels or undefined.
		nightEnd() {
			return this.calc(STANDARD_ALTITUDES.night, false)
		}

		// Start of evening golden hour at geometric solar altitude +6 degrees; fresh UT1 labels or undefined.
		goldenHourStart() {
			return this.calc(STANDARD_ALTITUDES.golden, true)
		}

		// End of morning golden hour at geometric solar altitude +6 degrees; fresh UT1 labels or undefined.
		goldenHourEnd() {
			return this.calc(STANDARD_ALTITUDES.golden, false)
		}
	}
}
