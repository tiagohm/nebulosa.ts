import type { Angle } from './angle'
import { PI, TAU } from './constants'
import type { Distance } from './distance'
import { floorDiv, modf, type NumberArray } from './math'

// https://github.com/commenthol/astronomia/blob/master/src/

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
		return (1 + Math.cos(i)) * 0.5
	}

	// Computes position angle of the midpoint of an illuminated limb.
	export function limb(bra: Angle, bdec: Angle, sra: Angle, sdec: Angle): Angle {
		// Mentioned in ch 41, p. 283.  Formula (48.5) p. 346
		const sδ = Math.sin(bdec)
		const cδ = Math.cos(bdec)
		const sδ0 = Math.sin(sdec)
		const cδ0 = Math.cos(sdec)
		const sa0a = Math.sin(sra - bra)
		const ca0a = Math.cos(sra - bra)
		const x = Math.atan2(cδ0 * sa0a, sδ0 * cδ - cδ0 * sδ * ca0a)
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
		return [Math.sin(epsilon), Math.cos(epsilon)]
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
			if (Math.abs((n1 - n0) / n0) < 1e-15) return [n1, true] as const

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

			let nearestX = Math.trunc((x - x1) / interval + 0.5)

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

		let nearestX = Math.floor((x - x1) / interval)

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
		return floorDiv(36525 * Math.trunc(y + 4716), 100) + (floorDiv(306 * (m + 1), 10) + b) + d - 1524.5
	}

	// Returns the calendar date for the given jd.
	export function jdToCalendar(jd: number, isJulian: boolean) {
		const [z, f] = modf(jd + 0.5)
		let a = z

		if (!isJulian) {
			const alpha = floorDiv(z * 100 - 186721625, 3652425)
			a = z + 1 + alpha - floorDiv(alpha, 4)
		}

		const b = a + 1524
		const c = floorDiv(b * 100 - 12210, 36525)
		const d = floorDiv(36525 * c, 100)
		const e = Math.trunc(floorDiv((b - d) * 1e4, 306001))

		const day = Math.trunc(b - d) - floorDiv(306001 * e, 1e4) + f

		let month = 0

		if (e === 14 || e === 15) {
			month = e - 13
		} else {
			month = e - 1
		}

		let year = 0

		if (month < 3) {
			year = Math.trunc(c) - 4715
		} else {
			year = Math.trunc(c) - 4716
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

		const cd = sind1 * sind2 + cosd1 * cosd2 * Math.cos(c1[0] - c2[0]) // (17.1) p. 109

		if (cd < Base.COS_SMALL_ANGLE) {
			return Math.acos(cd)
		} else {
			const cosd = Math.cos((c2[1] + c1[1]) / 2) // average dec of two bodies
			return Math.hypot((c2[0] - c1[0]) * cosd, c2[1] - c1[1]) // (17.2) p. 109
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
			const tanDeltar = Math.tan(deltar)
			const tanhDeltar = Math.tan(deltar / 2)
			const K = 1 / (1 + sind1 * sind1 * tanDeltar * tanhDeltar)
			const sinDeltad = Math.sin(c2[1] - c1[1])
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

			if (Math.abs(dn) < 1e-5) {
				return Math.hypot(u, v) // success
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
		return 0.5 * (1 - Math.cos(a))
	}

	// Computes the angular separation between two celestial bodies.
	export function sepHav(c1: Coord, c2: Coord) {
		// using (17.5) p. 115
		return 2 * Math.asin(Math.sqrt(hav(c2[1] - c1[1]) + Math.cos(c1[1]) * Math.cos(c2[1]) * hav(c2[0] - c1[0])))
	}

	// Computes the minimum separation between two moving objects.
	export function minSepHav(jd1: number, jd3: number, cs1: readonly [Coord, Coord, Coord], cs2: readonly [Coord, Coord, Coord]) {
		return minSep(jd1, jd3, cs1, cs2, sepHav)
	}

	// Computes the numerically stable angular separation between two celestial bodies.
	export function sepPauwels(c1: Coord, c2: Coord) {
		const [sind1, cosd1] = Base.sincos(c1[1])
		const [sind2, cosd2] = Base.sincos(c2[1])
		const cosdr = Math.cos(c2[0] - c1[0])
		const x = cosd1 * sind2 - sind1 * cosd2 * cosdr
		const y = cosd2 * Math.sin(c2[0] - c1[0])
		const z = sind1 * sind2 + cosd1 * cosd2 * cosdr
		return Math.atan2(Math.hypot(x, y), z)
	}

	// Computes the minimum separation between two moving objects.
	export function minSepPauwels(jd1: number, jd3: number, cs1: readonly [Coord, Coord, Coord], cs2: readonly [Coord, Coord, Coord]) {
		return minSep(jd1, jd3, cs1, cs2, sepPauwels)
	}

	// Computes the position angle of one body with respect to another.
	export function relativePosition(c1: Coord, c2: Coord) {
		const [sinDeltar, cosDeltar] = Base.sincos(c1[0] - c2[0])
		const [sind2, cosd2] = Base.sincos(c2[1])
		const p = Math.atan2(sinDeltar, cosd2 * Math.tan(c1[1]) - sind2 * cosDeltar)
		return p
	}
}
