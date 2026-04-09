import { type Angle, normalizeAngle } from './angle'
import { ASEC2RAD, AU_KM, DEG2RAD, PI, PIOVERTWO, TAU } from './constants'
import type { Distance } from './distance'
import { floorDiv, modf, type NumberArray } from './math'

const { sin, cos, tan, asin, acos, atan, atan2, sqrt, hypot, log10, abs, trunc, floor } = Math

// https://github.com/commenthol/astronomia/blob/master/src/

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
		// Mentioned in ch 41, p. 283.  Formula (48.5) p. 346
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
	// Converts a Gregorian year, month, and day of month to Julian day.
	// Negative years are valid, back to JD 0.  The result is not valid for dates before JD 0.
	export function calendarGregorianToJD(y: number, m: number, d: number) {
		return calendarToJD(y, m, d, false)
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

		let month = 0

		if (e === 14 || e === 15) {
			month = e - 13
		} else {
			month = e - 1
		}

		let year = 0

		if (month < 3) {
			year = trunc(c) - 4715
		} else {
			year = trunc(c) - 4716
		}

		return [year, month, day] as const
	}

	// Returns the calendar date for the given jd in the Gregorian Calendar.
	export function jdToCalendarGregorian(jd: number) {
		return jdToCalendar(jd, false)
	}
}

// Rise: Chapter 15, Rising, Transit, and Setting.
export namespace Rise {}

export type Coord = readonly [Angle, Angle]

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

// Chapter 20, Smallest Circle containing three Celestial Bodies.
export namespace Circle {
	// Finds the smallest circle containing three points.
	export function smallest(c1: Coord, c2: Coord, c3: Coord) {
		// Using haversine formula
		const cd1 = cos(c1[1])
		const cd2 = cos(c2[1])
		const cd3 = cos(c3[1])
		let a = 2 * asin(sqrt(AngularSeparation.hav(c2[1] - c1[1]) + cd1 * cd2 * AngularSeparation.hav(c2[0] - c1[0])))
		let b = 2 * asin(Math.sqrt(AngularSeparation.hav(c3[1] - c2[1]) + cd2 * cd3 * AngularSeparation.hav(c3[0] - c2[0])))
		let c = 2 * Math.asin(Math.sqrt(AngularSeparation.hav(c1[1] - c3[1]) + cd3 * cd1 * AngularSeparation.hav(c1[0] - c3[0])))

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
		return [(2 * a * b * c) / Math.sqrt((a + b + c) * (a + b - c) * (b + c - a) * (a + c - b)), false] as const
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
		const f = (E0: number) => m + e * Math.sin(E0)
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
