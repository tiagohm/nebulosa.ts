import { describe, expect, test } from 'bun:test'
// oxfmt-ignore
import { Solar, SolarXYZ, EquationOfTime, SolarDisk, Solstice, Apparent, Elliptic, Jupiter, Mars, SaturnRing, JupiterMoons, SaturnMoons, Moon, Perihelion, Sunrise, Rise, AngularSeparation, Base, BinaryStars, Circle, Conjunction, Coords, ElementEquinox, Fit, Globe, Illuminated, Interpolation, Iteration, Julian, Kepler, Line, MoonIlluminated, MoonPosition, NearParabolic, Node, Nutation, Parabolic, Parallactic, Parallax, Planetary, PlanetElements, PlanetPosition, Precession, Refraction, Semidiameter, Sidereal, Stellar, Sundial, Easter, } from '../../../src/astronomy/ephemeris/meeus'
import { moonParallax } from '../../../src/astronomy/bodies/moon'
import { deltaT, deltaTByEspenakMeeus2006 } from '../../../src/astronomy/time/deltat'
import { time, timeToDate, timeUnix, timeYMD, tt } from '../../../src/astronomy/time/time'
import { ASEC2RAD, DAYSEC, DEG2RAD, PI, PIOVERTWO, RAD2DEG, TAU } from '../../../src/core/constants'
import { modf, roundToNthDecimal } from '../../../src/math/numerical/math'
import { deg, dms, formatALT, formatRA, hms, normalizeAngle, secondsOfTime, signedDms, toArcsec, toDeg, toDms, toHms, toSecondsOfTime } from '../../../src/math/units/angle'
import { meter, toKilometer, toMeter } from '../../../src/math/units/distance'

function strictEqual(actual: number, expected: number, numDigits: number = 12) {
	expect(actual).toBeCloseTo(expected, numDigits)
}

// https://github.com/commenthol/astronomia/blob/master/test/

describe('Base', () => {
	test('small-angle cosine matches the ten-arcminute threshold', () => {
		expect(Base.COS_SMALL_ANGLE).toBeCloseTo(Math.cos(Base.SMALL_ANGLE), 15)
	})

	test('illuminated', () => {
		expect(Base.illuminated(Math.acos(0.29312))).toBe(0.64656)
		expect(Base.illuminated(deg(69.0756))).toBe(0.6785679037959225)
	})

	test('lightTime', () => {
		const res = Base.lightTime(0.910845)
		strictEqual(res, 0.0052606019659635)
	})

	test('limb', () => {
		expect(Base.limb(deg(134.6885), deg(13.7684), deg(20.6579), deg(8.6964))).toBeCloseTo(deg(285.04418687158426), 14)
	})

	test('horner', () => {
		expect(Base.horner(3, [-1, 2, -6, 2])).toBe(5) // 2x³-6x²+2x-1 at x=3
	})

	test('julianYearToJDE J2000', () => {
		const res = Base.julianYearToJDE(2000)
		strictEqual(res, Base.J2000)
	})

	test('julianYearToJDE J2050', () => {
		expect(Math.abs((Base.julianYearToJDE(2050) - 2469807.5) / 2469807.5) < 1e-15).toBeTrue()
	})

	test('jdeToJulianYear', () => {
		const tmp = Base.julianYearToJDE(2000)
		const res = Base.jdeToJulianYear(tmp)
		strictEqual(res, 2000)
	})

	test('besselianYearToJDE B1900', () => {
		const res = Base.besselianYearToJDE(1900)
		strictEqual(res, Base.B1900)
	})

	test('besselianYearToJDE B1950', () => {
		expect(Math.abs(Base.besselianYearToJDE(1950) - 2433282.4235) < 1e-4).toBeTrue()
	})

	test('jdeToBesselianYear', () => {
		const tmp = Base.besselianYearToJDE(1900)
		const res = Base.jdeToBesselianYear(tmp)
		strictEqual(res, 1900)
	})

	test('j2000Century', () => {
		const res = Base.j2000Century(0)
		strictEqual(res, -67.11964407939767)
	})
})

describe('Interpolation', () => {
	test('linear follows each segment, including knots and extrapolation', () => {
		for (const [x, y] of [
			[-1, -1],
			[0, 0],
			[0.5, 0.5],
			[1, 1],
			[1.5, 2.5],
			[2, 4],
			[3, 7],
		])
			expect(Interpolation.linear(x, 0, 2, [0, 1, 4])).toBeCloseTo(y, 14)
	})

	test('zeros and extrema at the central sample converge', () => {
		for (const strong of [false, true]) {
			expect(new Interpolation.Len3(0, 2, [-1, 0, 1]).zero(strong)).toBe(1)
			expect(new Interpolation.Len3(0, 2, [1, 0, 1]).zero(strong)).toBe(1)
			expect(new Interpolation.Len5(0, 4, [-2, -1, 0, 1, 2]).zero(strong)).toBe(2)
			expect(new Interpolation.Len5(0, 4, [4, 1, 0, 1, 4]).zero(strong)).toBe(2)
		}
		expect(new Interpolation.Len5(0, 4, [4, 1, 0, 1, 4]).extremum()).toEqual([2, 0])
		expect(Interpolation.iterate(1, () => 0)).toEqual([0, true])
	})

	describe('Len3', () => {
		test('interpolateN', () => {
			// Example 3.a, p. 25.0
			const d3 = new Interpolation.Len3(7, 9, [0.884226, 0.877366, 0.870531])
			const y = d3.interpolateN(4.35 / 24)
			strictEqual(y, 0.876125, 6)
		})

		test('interpolateX', () => {
			// Example 3.a, p. 25.0
			const d3 = new Interpolation.Len3(7, 9, [0.884226, 0.877366, 0.870531])
			const x = 8 + (4 * 60 * 60 + 21 * 60) / DAYSEC // 8th day at 4:21
			const y = d3.interpolateX(x)
			strictEqual(y, 0.876125, 6)
		})

		test('extremum', () => {
			// Example 3.b, p. 26.0
			const d3 = new Interpolation.Len3(12, 20, [1.3814294, 1.3812213, 1.3812453])
			const [x, y] = d3.extremum()
			strictEqual(y, 1.381203, 7) // distance: 1.3812030 AU
			strictEqual(x, 17.5864, 4) // date:     17.5864 TD
		})

		test('extremum #2', () => {
			// Example 3.d, p. 26.0
			// y = 3 + 2x - 3x^2
			const d3 = new Interpolation.Len3(-1, 1, [-2, 3, 2])
			const [x, y] = d3.extremum()
			strictEqual(x, 0.3333, 4)
			strictEqual(y, 3.3333, 4)
		})

		test('zero', () => {
			// Example 3.c, p. 26.0
			// the y unit doesn't matter.  working in degrees is fine
			const yTable = [signedDms(true, 0, 28, 13.4), signedDms(false, 0, 6, 46.3), signedDms(false, 0, 38, 23.2)]
			const d3 = new Interpolation.Len3(26, 28, yTable)
			const x = d3.zero(false)

			strictEqual(x, 26.79873, 5) // February 26.79873
		})

		test('zero strong', () => {
			// Example 3.d, p. 27.0
			const d3 = new Interpolation.Len3(-1, 1, [-2, 3, 2])
			const x = d3.zero(true)
			strictEqual(x, -0.720759220056, 12)
		})
	})

	describe('Len5', () => {
		test('interpolateX', () => {
			// Example 3.e, p. 28.0
			// work in radians to get answer in radians
			const yTable = [signedDms(false, 0, 54, 36.125), signedDms(false, 0, 54, 24.606), signedDms(false, 0, 54, 15.486), signedDms(false, 0, 54, 8.694), signedDms(false, 0, 54, 4.133)]
			const x = 28 + (3 + 20 / 60) / 24
			const d5 = new Interpolation.Len5(27, 29, yTable)
			const y = d5.interpolateX(x)
			expect(formatALT(y)).toBe('+00 54 13.37')
		})

		test('extremum', () => {
			// Example 3.d, p. 26.0
			// y = 3 + 2x - 3x^2
			const d5 = new Interpolation.Len5(-2, 2, [-13, -2, 3, 2, -5])
			const [x, y] = d5.extremum()
			strictEqual(x, 0.3333, 4)
			strictEqual(y, 3.3333, 4)
		})

		test('zero', () => {
			// Exercise, p. 30.0
			const yTable = [signedDms(true, 1, 11, 21.23), signedDms(true, 0, 28, 12.31), signedDms(false, 0, 16, 7.02), signedDms(false, 1, 1, 0.13), signedDms(false, 1, 45, 46.33)]
			const d5 = new Interpolation.Len5(25, 29, yTable)
			const z = d5.zero(false)
			// 1988 January 26.638587
			strictEqual(z, 26.638587, 6)

			// compare result to that from just three central values
			const d3 = new Interpolation.Len3(26, 28, yTable.slice(1, 4))
			const z3 = d3.zero(false)
			const dz = z - z3

			strictEqual(dz, 0.000753, 6) // da, 6y
			strictEqual(dz * 24 * 60, 1.1, 1) // minute
		})
	})

	test('len4Half', () => {
		// Example 3.f, p. 32.0
		const half = Interpolation.len4Half([hms(10, 18, 48.732), hms(10, 23, 22.835), hms(10, 27, 57.247), hms(10, 32, 31.983)])
		expect(formatRA(half)).toEqual('10 25 40.00')
	})

	test('lagrange', () => {
		// exercise, p. 34.0
		const table = [
			[29.43, 0.4913598528],
			[30.97, 0.5145891926],
			[27.69, 0.4646875083],
			[28.11, 0.4711658342],
			[31.58, 0.5236885653],
			[33.05, 0.5453707057],
		]
		// 10 significant digits in input, no more than 10 expected in output
		strictEqual(Interpolation.lagrange(30, table), 0.5, 10)
		strictEqual(Interpolation.lagrange(0, table), 0.0000512249, 10)
		strictEqual(Interpolation.lagrange(90, table), 0.99996481, 10)
	})

	test('lagrangePoly', () => {
		// Example 3.g, p, 34.0
		const table = [
			[1, -6],
			[3, 6],
			[4, 9],
			[6, 15],
		]
		const p = Interpolation.lagrangePoly(table)
		const exp = [-87 / 5, 69 / 5, -13 / 5, 1 / 5]

		for (let i = 0; i < p.length; i++) {
			strictEqual(p[i], exp[i], 2)
		}

		strictEqual(Base.horner(1, p), -6) // result at x=1
	})

	const t = [0.2, 0.4, 0.7, -1.5, 15]

	for (const x of t) {
		test(`linear at ${x}`, () => {
			const y = Interpolation.linear(x, 0, 1, [0, 1])
			strictEqual(y, x)
		})
	}

	for (const x of t) {
		test(`linear + 1 at ${x}`, () => {
			const y = Interpolation.linear(x, 0, 1, [1, 1.25, 1.5, 1.75, 2])
			strictEqual(y, x + 1)
		})
	}
})

describe('Iteration', () => {
	test('fullPrecision accepts zero fixed points', () => {
		expect(Iteration.fullPrecision((x) => x, 0, 10)).toBe(0)
		expect(Iteration.fullPrecision(() => 0, 1, 10)).toBe(0)
	})

	test('decimalPlaces', () => {
		// Example 5.a, p. 48.0
		const betterSqrt = (n: number) => (n + 159 / n) / 2
		const n = Iteration.decimalPlaces(betterSqrt, 12, 8, 20)
		strictEqual(n, 12.60952021, 8)
	})

	test('fullPrecision', () => {
		// Example 5.b, p. 48.0
		const betterRoot = (x: number) => (8 - x ** 5) / 17
		const x = Iteration.fullPrecision(betterRoot, 0, 20)
		strictEqual(x, 0.4692498784547387)
	})

	test('fullPrecision diverging', () => {
		// Example 5.c, p. 49.0
		const betterRoot = (x: number) => (8 - x ** 5) / 3
		expect(() => Iteration.fullPrecision(betterRoot, 0, 20)).toThrow('maximum iterations reached')
	})

	test('fullPrecision converging', () => {
		// Example 5.d, p.49.
		const betterRoot = (x: number) => (8 - 3 * x) ** 0.2
		const x = Iteration.fullPrecision(betterRoot, 0, 30)
		strictEqual(x, 1.321785627117658)
	})

	test('binaryRoot', () => {
		// Example  from p. 53.0
		const f = (x: number) => x ** 5 + 17 * x - 8
		const x = Iteration.binaryRoot(f, 0, 1)
		strictEqual(x, 0.46924987845473876)
	})
})

describe('Julian', () => {
	describe('gregorian', () => {
		const dates = [
			[2000, 1, 1.5, 2451545], // more examples, p. 62
			[1999, 1, 1, 2451179.5],
			[1987, 1, 27, 2446822.5],
			[1987, 6, 19.5, 2446966],
			[1988, 1, 27, 2447187.5],
			[1988, 6, 19.5, 2447332],
			[1900, 1, 1, 2415020.5],
			[1600, 1, 1, 2305447.5],
			[1600, 12, 31, 2305812.5],
			[1582, 10, 15.5, 2299161], // 1st day in Gregorian Calendar
			[1582, 10, 4.5, 2299150],
			[333, 1, 27.5, 1842712],
			[-584, 5, 28.62999999988824, 1507906.13],
		] as const

		describe('calendarGregorianToJD', () => {
			test('Sputnik', () => {
				const jd = Julian.calendarGregorianToJD(1957, 10, 4.81)
				strictEqual(jd, 2436116.31)
			})

			test('Halley', () => {
				// Example 7.c, p. 64.
				const jd1 = Julian.calendarGregorianToJD(1910, 4, 20)
				const jd2 = Julian.calendarGregorianToJD(1986, 2, 9)
				strictEqual(jd2 - jd1, 27689)
			})

			for (const date of dates) {
				const name = [date[0], date[1], date[2]].join('-')

				test(name, () => {
					const jd = Julian.calendarGregorianToJD(date[0], date[1], date[2])
					strictEqual(jd, date[3])
				})
			}
		})

		describe('jdToCalendarGregorian', () => {
			for (const date of dates) {
				const name = [date[0], date[1], date[2]].join('-')

				test(name, () => {
					const [year, month, day] = Julian.jdToCalendarGregorian(date[3])
					strictEqual(year, date[0])
					strictEqual(month, date[1])
					strictEqual(day, date[2])
				})
			}
		})
	})

	describe('julian', () => {
		const dates = [
			[-4712, 1, 1.5, 0],
			[-1000, 7, 12.5, 1356001],
			[-1000, 2, 29, 1355866.5],
			[-1001, 8, 17.9, 1355671.4],
			[-123, 12, 31, 1676496.5],
			[-122, 1, 1, 1676497.5],
			[-584, 5, 28.63, 1507900.13],
			[333, 1, 27.5, 1842713],
			[837, 4, 10.3, 2026871.8], // more examples, p. 62
			[1582, 10, 5.5, 2299161], // 1st day in Gregorian Calendar => 1582-10-15
			[1582, 10, 4.5, 2299160],
			[2000, 12, 24, 2451915.5],
		] as const

		describe('calendarJulianToJD', () => {
			test('sample', () => {
				// Example 7.b, p. 61.
				const jd = Julian.calendarJulianToJD(333, 1, 27.5)
				strictEqual(jd, 1842713)
			})

			for (const date of dates) {
				test(date.join('-'), () => {
					const jd = Julian.calendarJulianToJD(date[0], date[1], date[2])
					strictEqual(jd, date[3])
				})
			}
		})

		describe('jdToCalendarJulian', () => {
			for (const date of dates) {
				test(date.join(' '), () => {
					const [year, month, day] = Julian.jdToCalendarJulian(date[3])
					strictEqual(year, date[0], 8)
					strictEqual(month, date[1], 8)
					strictEqual(day, date[2], 8)
				})
			}
		})
	})

	describe('isLeapYearJulian', () => {
		const years = [
			[900, true],
			[1236, true],
			[750, false],
			[1429, false],
		] as const

		for (const year of years) {
			test(year[0].toFixed(0), () => {
				expect(Julian.isLeapYearJulian(year[0])).toBe(year[1])
			})
		}
	})

	describe('isLeapYearGregorian', () => {
		const years = [
			[1700, false],
			[1800, false],
			[1900, false],
			[2100, false],
			[1600, true],
			[2400, true],
			[2000, true],
		] as const

		for (const year of years) {
			test(year[0].toFixed(0), () => {
				expect(Julian.isLeapYearGregorian(year[0])).toBe(year[1])
			})
		}
	})

	describe('DayOf', () => {
		test('dayOfWeek', () => {
			// Example 7.e, p. 65.
			const res = Julian.dayOfWeek(2434923.5)
			strictEqual(res, 3) // Wednesday
		})

		const dates = [
			[1978, 11, 14, false, 318],
			[1988, 4, 22, true, 113],
		] as const

		describe('dayOfYear', () => {
			for (const date of dates) {
				const [year, month, day, leap, dayOfYear] = date

				test([year, month, day].join(' '), () => {
					// Example 7.f, p. 65.
					const res = Julian.dayOfYear(year, month, day, leap)
					strictEqual(res, dayOfYear)
				})
			}
		})
	})

	describe('check Gregorian calendar', () => {
		test('1582-10-15 GC', () => {
			const jd = Julian.calendarGregorianToJD(1582, 10, 15)
			expect(Julian.isJDCalendarGregorian(jd)).toBeTrue()
		})

		test('1582-10-14 GC', () => {
			const jd = Julian.calendarGregorianToJD(1582, 10, 14)
			expect(Julian.isJDCalendarGregorian(jd)).toBeFalse()
		})

		test('1582-10-04 JC', () => {
			const jd = Julian.calendarJulianToJD(1582, 10, 4)
			expect(Julian.isJDCalendarGregorian(jd)).toBeFalse()
		})

		test('1582-10-05 JC', () => {
			const jd = Julian.calendarJulianToJD(1582, 10, 5)
			expect(Julian.isJDCalendarGregorian(jd)).toBeTrue()
		})
	})

	test.concurrent.each([
		[2451545, '2000-01-01T12:00:00.000Z'],
		[2451915.5, '2001-01-06T00:00:00.000Z'],
		[2436116.31, '1957-10-04T19:26:24.000Z'],
		[1842712, '0333-01-27T12:00:00.000Z'],
		[1507900.13, '-000584-05-22T15:07:12.000Z'],
	] as const)('Date conversion at JD %f', (jd, iso) => {
		expect(Julian.jdToDate(jd).toISOString()).toBe(iso)
		expect(Julian.dateToJD(new Date(iso))).toBeCloseTo(jd, 8)
	})

	test('construction, calendar labels, midnight and noon', () => {
		expect(new Julian.Calendar(2015).getDate()).toEqual({ year: 2015, month: 1, day: 1 })
		const c = new Julian.Calendar(new Date('2015-10-20T12:00:00Z'))
		expect([c.year, c.month, c.day]).toEqual([2015, 10, 20.5])
		expect(new Julian.Calendar().fromDate(new Date('2000-01-01T12:00:00Z')).toJD()).toBe(Base.J2000)
		expect(new Julian.Calendar().fromJD(Base.J2000).toDate().toISOString()).toBe('2000-01-01T12:00:00.000Z')
		c.day = 20.4
		expect(c.getDate()).toEqual({ year: 2015, month: 10, day: 20 })
		expect(c.midnight()).toBe(c)
		expect(c.toISOString()).toBe('2015-10-20T00:00:00.000Z')
		expect(c.noon()).toBe(c)
		expect(c.toDate().toISOString()).toBe('2015-10-20T12:00:00.000Z')
	})

	test('time truncation and early Gregorian years', () => {
		expect(new Julian.Calendar(new Date('2015-10-20T08:00:00Z')).getTime()).toEqual({ hour: 8, minute: 0, second: 0, millisecond: 0 })
		expect(new Julian.Calendar(2015, 10, 20.33333333).getTime()).toEqual({ hour: 7, minute: 59, second: 59, millisecond: 999 })
		for (const iso of ['0000-02-29T00:00:00.000Z', '0099-12-31T23:59:59.999Z', '-000584-05-22T15:07:12.000Z']) {
			const c = new Julian.CalendarGregorian(new Date(iso))
			expect(c.toDate().toISOString()).toBe(iso)
			expect(Julian.jdToDate(c.toJD()).toISOString()).toBe(iso)
		}
		expect(new Julian.CalendarGregorian(-584, 5, 22.5).toISOString()).toBe('-000584-05-22T12:00:00.000Z')
	})

	test.concurrent.each([
		[1978, 11, 14, 318],
		[1988, 4, 22, 113],
		[1236, 11, 14, 319],
		[750, 11, 14, 318],
	] as const)('ordinal reference in %d', (y, m, d, n) => {
		expect(Julian.dayOfYearToCalendarJulian(y, n)).toEqual(new Julian.CalendarJulian(y, m, d))
		if (y >= 1582) expect(Julian.dayOfYearToCalendarGregorian(y, n)).toEqual(new Julian.CalendarGregorian(y, m, d))
		expect(Julian.dayOfYearToCalendar(n, Julian.isLeapYearJulian(y))).toEqual({ month: m, day: d })
	})

	test.concurrent.each([Julian.CalendarGregorian, Julian.CalendarJulian])('all ordinal boundaries for %p', (Calendar) => {
		for (const year of [-4, 0, 1700, 1900, 1977, 1988, 2000]) {
			const start = new Calendar(year).toJD()
			const days = new Calendar(year).isLeapYear() ? 366 : 365
			for (let n = 1; n <= days; n++) {
				const c = new Calendar().fromJD(start + n - 1)
				expect(c.dayOfYear()).toBe(n)
				expect(Julian.dayOfYearToCalendar(n, days === 366)).toEqual({ month: c.month, day: c.day })
				expect(Julian.dayOfYearToCalendar(n + 0.5, days === 366)).toEqual({ month: c.month, day: c.day + 0.5 })
			}
		}
	})

	test.concurrent.each([
		[1977, 2, 14, 1977.12055],
		[1977, 1, 1, 1977],
		[1977, 12, 31.999, 1977.999997260274],
	] as const)('decimal year %d-%d-%f', (y, m, d, decimal) => {
		const c = new Julian.CalendarGregorian(y, m, d)
		expect(c.toYear()).toBeCloseTo(decimal, 5)
		expect(new Julian.CalendarGregorian().fromYear(decimal).getDate()).toEqual({ year: y, month: m, day: Math.floor(d) })
	})

	test('decimal years at leap days, month starts and BCE dates', () => {
		expect(new Julian.CalendarGregorian().fromYear(2000.999999999999).getDate()).toEqual({ year: 2001, month: 1, day: 1 })
		expect(new Julian.CalendarJulian(1977, 2, 14).toYear()).toBeCloseTo(1977.12055, 5)
		expect(new Julian.Calendar(2000, 7, 2).toYear()).toBe(2000.5)
		for (const Calendar of [Julian.CalendarGregorian, Julian.CalendarJulian]) {
			for (const [y, m, d] of [
				[1977, 2, 1],
				[2000, 2, 29],
				[2000, 3, 1],
				[-1000, 7, 12.5],
			]) {
				const c = new Calendar(y, m, d)
				const back = new Calendar().fromYear(c.toYear())
				expect(back.getDate()).toEqual(c.getDate())
				expect(back.day).toBeCloseTo(d, 7)
			}
		}
	})

	test('calendar reform, fixed calendar rules, weekday and MJD', () => {
		expect(new Julian.CalendarGregorian(1582, 10, 15).toJulian().getDate()).toEqual({ year: 1582, month: 10, day: 5 })
		expect(new Julian.CalendarJulian(1582, 10, 5).toGregorian().getDate()).toEqual({ year: 1582, month: 10, day: 15 })
		expect(new Julian.Calendar().fromJD(2299159.5).getDate()).toEqual({ year: 1582, month: 10, day: 4 })
		expect(new Julian.Calendar().fromJD(2299160.5).getDate()).toEqual({ year: 1582, month: 10, day: 15 })
		expect(new Julian.Calendar(1582, 10, 14).isGregorian()).toBe(false)
		expect(new Julian.Calendar(new Date('1582-10-15T00:00:00Z')).isGregorian()).toBe(true)
		expect(new Julian.CalendarGregorian(1400).isGregorian()).toBe(true)
		expect(new Julian.CalendarGregorian(1400).isLeapYear()).toBe(false)
		expect(new Julian.CalendarJulian(1900).isGregorian()).toBe(false)
		expect(new Julian.CalendarJulian(1900).isLeapYear()).toBe(true)
		expect(new Julian.Calendar(1400, 12, 24).dayOfYear()).toBe(359)
		expect(new Julian.Calendar(1400, 12, 24).dayOfWeek()).toBe(5)
		expect(Julian.jdToMJD(new Julian.CalendarGregorian(1858, 11, 17).toJD())).toBe(0)
		expect(Julian.jdToCalendarGregorian(Julian.mjdToJD(0))).toEqual([1858, 11, 17])
	})

	test('TT conversion is nonmutating, repeatable and normalizes the calendar', () => {
		const c = new Julian.CalendarGregorian(2000, 12, 31.9999)
		const before = [c.year, c.month, c.day]
		const jd = c.toJD()
		const jde = c.toJDE()
		expect((jde - jd) * DAYSEC).toBeCloseTo(Julian.deltaTSeconds(c.toYear()), 4)
		expect(c.toJDE()).toBe(jde)
		expect([c.year, c.month, c.day]).toEqual(before)
		expect(new Julian.CalendarGregorian().fromJDE(jde).toJD()).toBeCloseTo(jd, 8)
		c.deltaT()
		expect(c.getDate()).toEqual({ year: 2001, month: 1, day: 1 })
		c.deltaT(true)
		expect(c.toJD()).toBeCloseTo(jd, 8)
		const date = new Date('1977-02-18T03:36:52.351Z')
		expect(Math.abs(Julian.jdeToDate(Julian.dateToJDE(date)).getTime() - date.getTime())).toBeLessThanOrEqual(1)
	})

	test('upstream TT fixtures with an explicit delta-T model', () => {
		try {
			// Meeus 10.a fixture gives TT-UT = 47.649 seconds; fix the model to isolate calendar conversion.
			Julian.setDeltaTProvider(() => 47.649)
			const jde = Julian.dateToJD(new Date('1977-02-18T03:37:40Z'))
			expect(Julian.jdeToDate(jde).toISOString()).toBe('1977-02-18T03:36:52.351Z')
			// The ancient upstream example uses Espenak-Meeus; the project defaults to the S15 model.
			Julian.setDeltaTProvider(deltaTByEspenakMeeus2006)
			const c = new Julian.Calendar(1, 1, 1)
			const jd = c.toJD()
			expect(c.toISOString()).toBe('0001-01-01T00:00:00.000Z')
			c.deltaT()
			expect(c.toISOString()).toBe('0001-01-01T02:56:13.459Z')
			c.deltaT(true)
			expect(c.toJD()).toBeCloseTo(jd, 8)
		} finally {
			Julian.setDeltaTProvider()
		}

		expect(Julian.deltaTSeconds(2000)).toBe(deltaT(2000))
	})
})

describe('Easter', () => {
	test('gregorian', () => {
		expect(Easter.gregorian(1991)).toEqual([1991, 3, 31])
		expect(Easter.gregorian(1992)).toEqual([1992, 4, 19])
		expect(Easter.gregorian(1993)).toEqual([1993, 4, 11])
		expect(Easter.gregorian(1954)).toEqual([1954, 4, 18])
		expect(Easter.gregorian(2000)).toEqual([2000, 4, 23])
		expect(Easter.gregorian(2026)).toEqual([2026, 4, 5])
		// The minimum extreme date is Mar 22
		expect(Easter.gregorian(1818)).toEqual([1818, 3, 22])
		expect(Easter.gregorian(2285)).toEqual([2285, 3, 22])
		// The maximum extreme date is Apr 25
		expect(Easter.gregorian(1886)).toEqual([1886, 4, 25])
		expect(Easter.gregorian(1943)).toEqual([1943, 4, 25])
		expect(Easter.gregorian(2038)).toEqual([2038, 4, 25])
		// A period of 5700000 years is required for the cyclical recurrence
		expect(Easter.gregorian(1991 + 5700000)).toEqual([1991 + 5700000, 3, 31])
		expect(Easter.gregorian(1992 + 5700000)).toEqual([1992 + 5700000, 4, 19])
		expect(Easter.gregorian(1993 + 5700000)).toEqual([1993 + 5700000, 4, 11])
	})

	test('julian', () => {
		// The date of Julian Easter has a periodicity of 532 years.
		expect(Easter.julian(179)).toEqual([179, 4, 12])
		expect(Easter.julian(711)).toEqual([711, 4, 12])
		expect(Easter.julian(1243)).toEqual([1243, 4, 12])
	})
})

describe('Fit', () => {
	test('linear', () => {
		// Example 4.a, p. 37.0
		const x = [0.2982, 0.2969, 0.2918, 0.2905, 0.2707, 0.2574, 0.2485, 0.2287, 0.2238, 0.2156, 0.1992, 0.1948, 0.1931, 0.1889, 0.1781, 0.1772, 0.177, 0.1755, 0.1746]
		const y = [10.92, 11.01, 10.99, 10.78, 10.87, 10.8, 10.75, 10.14, 10.21, 9.97, 9.69, 9.57, 9.66, 9.63, 9.65, 9.44, 9.44, 9.32, 9.2]

		const [a, b] = Fit.linear(x, y)

		strictEqual(a, 13.67, 2)
		strictEqual(b, 7.03, 2)
	})

	test('correlationCoefficient', () => {
		// Example 4.b, p. 40.0
		const x = [73, 38, 35, 42, 78, 68, 74, 42, 52, 54, 39, 61, 42, 49, 50, 62, 44, 39, 43, 54, 44, 37]
		const y = [90.4, 125.3, 161.8, 143.4, 52.5, 50.8, 71.5, 152.8, 131.3, 98.5, 144.8, 78.1, 89.5, 63.9, 112.1, 82, 119.8, 161.2, 208.4, 111.6, 167.1, 162.1]
		const [a, b] = Fit.linear(x, y)

		// y = -2.49x + 244.18
		strictEqual(a, -2.49, 2)
		strictEqual(b, 244.18, 2)
		strictEqual(Fit.correlationCoefficient(x, y), -0.767, 3)
	})

	// example data p. 40.0
	const qdatax = [-4, -3, -2, -1, 0, 1, 2]
	const qdatay = [-6, -1, 2, 3, 2, -1, -6]

	test('quadratic', () => {
		const [a, b, c] = Fit.quadratic(qdatax, qdatay)
		strictEqual(a, -1)
		strictEqual(b, -2)
		strictEqual(c, 2)
	})

	test('func3', () => {
		const [a, b, c] = Fit.func3(
			qdatax,
			qdatay,
			(x) => x * x,
			(x) => x,
			() => 1,
		)

		strictEqual(a, -1)
		strictEqual(b, -2)
		strictEqual(c, 2)
	})

	test('func3 sin', () => {
		// Example 4.c, p. 44.0
		const x = [3, 20, 34, 50, 75, 88, 111, 129, 143, 160, 183, 200, 218, 230, 248, 269, 290, 303, 320, 344].map(deg)
		const y = [0.0433, 0.2532, 0.3386, 0.356, 0.4983, 0.7577, 1.4585, 1.8628, 1.8264, 1.2431, -0.2043, -1.2431, -1.8422, -1.8726, -1.4889, -0.8372, -0.4377, -0.364, -0.3508, -0.2126]

		const res = Fit.func3(
			x,
			y,
			Math.sin,
			(x) => Math.sin(2 * x),
			(x) => Math.sin(3 * x),
		)

		strictEqual(res[0], 1.2, 4)
		strictEqual(res[1], -0.77, 4)
		strictEqual(res[2], 0.39, 4)
	})

	test('func1', () => {
		const a = Fit.func1([0, 1, 2, 3, 4, 5], [0, 1.2, 1.4, 1.7, 2.1, 2.2], Math.sqrt)
		strictEqual(a, 1.016, 3) // y = 1.016√x
	})
})

describe('Globe', () => {
	test('Earth dimensions and surface speed retain kilometer scale', () => {
		// IAU 1976 / Meeus 11: equatorial radius is 6378.14 km, not meters.
		expect(toKilometer(Globe.EARTH76.A)).toBeCloseTo(6378.14, 8)
		expect(toKilometer(Globe.oneDegreeOfLongitude(Globe.EARTH76.radiusAtLatitude(0)))).toBeCloseTo(111.319543153, 8)
		expect(toMeter(Globe.EARTH76.radiusAtLatitude(0)) * Globe.ROTATION_RATE_1996_5).toBeCloseTo(465.1013, 3)
	})

	test('parallax height ratio uses the same units as any ellipsoid radius', () => {
		const earth = new Globe.Ellipsoid(meter(6378140), 1 / 298.257)
		expect(earth.parallaxConstants(0, meter(1000))[1]).toBeCloseTo(1 + 1000 / 6378140, 14)
		const sphere = new Globe.Ellipsoid(meter(2000), 0)
		expect(sphere.parallaxConstants(0, meter(500))).toEqual([0, 1.25])
	})

	test('coincident and nearby geodesics remain finite', () => {
		for (const [lon, lat] of [
			[0, 0],
			[1, 0.5],
			[-2, -0.8],
		]) {
			expect(Globe.EARTH76.distance(lon, lat, lon, lat)).toBe(0)
		}
		// Along the equator, distance is the equatorial radius times longitude separation.
		expect(toMeter(Globe.EARTH76.distance(0, 0, 1e-9, 0))).toBeCloseTo(0.00637814, 10)
	})

	const rm = Globe.EARTH76.radiusOfCurvature(deg(42))
	const rp = Globe.EARTH76.radiusAtLatitude(deg(42))

	test('parallaxConstants', () => {
		// Example 11.a, p 82.
		const φ = signedDms(false, 33, 21, 22)
		const res = Globe.EARTH76.parallaxConstants(φ, meter(1706))
		strictEqual(res[0], 0.5468608240604509)
		strictEqual(res[1], 0.8363392323525684)
	})

	test('geocentricLatitudeDifference', () => {
		// p. 83
		const φ0 = signedDms(false, 45, 5, 46.36)
		const diff = Globe.geocentricLatitudeDifference(φ0)
		expect(formatALT(diff)).toBe('+00 11 32.73')
	})

	describe('radius', () => {
		// Example 11.b p 84.

		test('radiusAtLatitude', () => {
			strictEqual(toKilometer(rp), 4747.001, 3)
		})

		test('RotationRate1996_5', () => {
			const wRp = toKilometer(rp) * Globe.ROTATION_RATE_1996_5
			strictEqual(wRp, 0.34616, 5)
		})

		test('radiusOfCurvature', () => {
			strictEqual(toKilometer(rm), 6364.033, 3)
		})

		test('oneDegreeOfLongitude', () => {
			strictEqual(toKilometer(Globe.oneDegreeOfLongitude(rp)), 82.8508, 4)
		})

		test('oneDegreeOfLatitude', () => {
			strictEqual(toKilometer(Globe.oneDegreeOfLatitude(rm)), 111.0733, 4)
		})
	})

	describe('distance', () => {
		// Example 11.c p 85.
		const c1 = [signedDms(true, 2, 20, 14), signedDms(false, 48, 50, 11)] as const
		const c2 = [signedDms(false, 77, 3, 56), signedDms(false, 38, 55, 17)] as const

		test('distance', () => {
			const distance = Globe.EARTH76.distance(...c1, ...c2)
			strictEqual(toKilometer(distance), 6181.63, 2)
		})

		test('approxAngularDistance', () => {
			const cos = Globe.approxAngularDistance(...c1, ...c2)
			const d = Math.acos(cos)
			strictEqual(cos, 0.567146, 6)
			expect(formatALT(d)).toBe('+55 26 54.77')
		})

		test('approxLinearDistance', () => {
			// d = acos(approxAngularDistance)
			const ld = Globe.approxLinearDistance(0.9677597323715493)
			strictEqual(toKilometer(ld), 6166, 0)
		})
	})
})

describe('Sidereal', () => {
	test('apparent0UT ignores time of day and agrees with apparent at midnight', () => {
		const jd = 2451544.5
		const expected = Sidereal.apparent(jd)
		for (const fraction of [0, 0.25, 0.5, 0.999]) expect(Sidereal.apparent0UT(jd + fraction)).toBeCloseTo(expected, 10)
		expect(Sidereal.apparent0UT(jd + 1)).not.toBeCloseTo(expected, 0)
	})

	test('mean', () => {
		// Example 12.a, p. 88.
		const s = Sidereal.mean(2446895.5)
		expect(formatRA(secondsOfTime(s), 5)).toBe('13 10 46.36683')
	})

	test('apparent', () => {
		// Example 12.a, p. 88.
		const a = Sidereal.apparent(2446895.5)
		expect(formatRA(secondsOfTime(a), 5)).toBe('13 10 46.13514')
	})
})

describe('Coords', () => {
	test('rotations preserve latitude near both poles and the zenith', () => {
		for (const epsilon of [0.0002, deg(23.4392911)]) {
			for (const offset of [0, 1e-10]) {
				const latitude = PIOVERTWO - epsilon - offset
				expect(Coords.eclipticToEquatorial(PIOVERTWO, latitude, epsilon)[1]).toBeCloseTo(PIOVERTWO - offset, 14)
				expect(Coords.eclipticToEquatorial(-PIOVERTWO, -latitude, epsilon)[1]).toBeCloseTo(-PIOVERTWO + offset, 14)
				expect(Coords.equatorialToEcliptic(-PIOVERTWO, latitude, epsilon)[1]).toBeCloseTo(PIOVERTWO - offset, 14)
				expect(Coords.equatorialToEcliptic(PIOVERTWO, -latitude, epsilon)[1]).toBeCloseTo(-PIOVERTWO + offset, 14)
				expect(Coords.equatorialToHorizontal(0, epsilon + offset, 0, epsilon, 0)[1]).toBeCloseTo(PIOVERTWO - offset, 14)
				expect(Coords.horizontalToEquatorial(PI, epsilon + offset, 0, epsilon, 0)[1]).toBeCloseTo(PIOVERTWO - offset, 14)
			}
		}
	})

	test('galactic rotations preserve proximity to their target poles', () => {
		for (const offset of [0, 1e-10]) {
			expect(Coords.equatorialToGalactic(Coords.GALACTIC_NORTH_RA, Coords.GALACTIC_NORTH_DEC + offset)[1]).toBeCloseTo(PIOVERTWO - offset, 14)
			expect(Coords.galacticToEquatorial(Coords.GALACTIC_LON_0 + PIOVERTWO, Coords.GALACTIC_NORTH_DEC + offset)[1]).toBeCloseTo(PIOVERTWO - offset, 14)
		}
	})

	test('horizontal coordinates reproduce Meeus 13.b and invert', () => {
		const jd = Julian.calendarGregorianToJD(1987, 4, 10 + (19 * 3600 + 21 * 60) / DAYSEC)
		const st = Sidereal.apparent(jd)
		const ra = hms(23, 9, 16.641),
			dec = signedDms(true, 6, 43, 11.61)
		const lon = dms(77, 3, 56),
			lat = dms(38, 55, 17)
		const horizontal = Coords.equatorialToHorizontal(ra, dec, lon, lat, st)
		expect(toDeg(horizontal[0])).toBeCloseTo(68.0337, 3)
		expect(toDeg(horizontal[1])).toBeCloseTo(15.1249, 3)
		const equatorial = Coords.horizontalToEquatorial(...horizontal, lon, lat, st)
		expect(equatorial[0]).toBeCloseTo(ra, 14)
		expect(equatorial[1]).toBeCloseTo(dec, 14)
	})

	test('Equatorial.toEcliptic', () => {
		// Example 13.a, p. 95.
		const [lon, lat] = Coords.equatorialToEcliptic(hms(7, 45, 18.946), signedDms(false, 28, 1, 34.26), deg(23.4392911))
		strictEqual(toDeg(lon), 113.21563, 5)
		strictEqual(toDeg(lat), 6.68417, 5)
	})

	test('Equatorial.toEcliptic.toEquatorial', () => {
		// repeat example above
		const eq = Coords.equatorialToEcliptic(hms(7, 45, 18.946), signedDms(false, 28, 1, 34.26), deg(23.4392911))
		const [ra, dec] = Coords.eclipticToEquatorial(...eq, deg(23.4392911))

		expect(toHms(ra).map((e) => roundToNthDecimal(e, 3))).toEqual([7, 45, 18.946])
		expect(toDms(dec).map((e) => roundToNthDecimal(e, 3))).toEqual([28, 1, 34.26, 1])
	})

	test('Equatorial.toGalactic', () => {
		// Exercise, p. 96.
		const [lon, lat] = Coords.equatorialToGalactic(hms(17, 48, 59.74), signedDms(true, 14, 43, 8.2))
		strictEqual(toDeg(lon), 12.9593, 4)
		strictEqual(toDeg(lat), 6.0463, 4)
	})

	test('Equatorial.toGalactic.toEquatorial', () => {
		const g = Coords.equatorialToGalactic(hms(17, 48, 59.74), signedDms(true, 14, 43, 8.2))
		const [ra, dec] = Coords.galacticToEquatorial(...g)
		expect(toHms(ra).map((e) => roundToNthDecimal(e, 3))).toEqual([17, 48, 59.74])
		expect(formatALT(dec)).toBe('-14 43 08.20')
	})
})

describe('AngularSeparation', () => {
	test('haversine retains sub-milliarcsecond separations and finite antipodes', () => {
		expect(AngularSeparation.hav(1e-9)).toBeCloseTo(2.5e-19, 30)
		expect(AngularSeparation.sepHav([0, 0], [1e-9, 0])).toBeCloseTo(1e-9, 20)
		for (const lat of [0, 0.0002, 0.4, 1.2]) expect(AngularSeparation.sepHav([0, lat], [PI, -lat])).toBeCloseTo(PI, 7)
	})

	test('small separation crosses longitude zero in either direction', () => {
		const a = [deg(359.9999), 0] as const
		const b = [deg(0.0001), 0] as const
		expect(AngularSeparation.sep(a, b)).toBeCloseTo(deg(0.0002), 14)
		expect(AngularSeparation.sep(b, a)).toBeCloseTo(deg(0.0002), 14)
		expect(AngularSeparation.sep([0, PIOVERTWO], [PI, PIOVERTWO])).toBeCloseTo(0, 14)
	})

	test('minimum separation respects a supplied distance function', () => {
		const fixed = [
			[0, 0],
			[0, 0],
			[0, 0],
		] as const
		const moving = [
			[0.2, 0],
			[0.1, 0],
			[0.2, 0],
		] as const
		const result = AngularSeparation.minSep(0, 2, fixed, moving, (a, b) => 2 * AngularSeparation.sepPauwels(a, b))
		expect(result).toBeCloseTo(0.2, 14)
	})

	test('minimum separation variants work across longitude zero', () => {
		const fixed = [
			[0, 0],
			[0, 0],
			[0, 0],
		] as const
		const moving = [
			[deg(359.9997), 0],
			[deg(359.9999), 0],
			[deg(359.9997), 0],
		] as const
		expect(AngularSeparation.minSepPauwels(0, 2, fixed, moving)).toBeCloseTo(deg(0.0001), 14)
		expect(AngularSeparation.minSepHav(0, 2, fixed, moving)).toBeCloseTo(deg(0.0001), 9)
	})

	describe('single functions', () => {
		const c1 = [hms(14, 15, 39.7), signedDms(false, 19, 10, 57)] as const
		const c2 = [hms(13, 25, 11.6), signedDms(true, 11, 9, 41)] as const

		test('sep', () => {
			// Example 17.a, p. 110.0
			const d = AngularSeparation.sep(c1, c2)
			expect(formatALT(d, false)).toBe('+32 47 35')
		})

		test('sepHav', () => {
			// Example 17.a, p. 110.0
			const d = AngularSeparation.sepHav(c1, c2)
			expect(formatALT(d, false)).toBe('+32 47 35')
		})

		test('sepPauwels', () => {
			// Example 17.b, p. 116.0
			const d = AngularSeparation.sepPauwels(c1, c2)
			expect(formatALT(d, false)).toBe('+32 47 35')
		})

		test('relativePosition', () => {
			const p = AngularSeparation.relativePosition(c1, c2)
			expect(formatALT(p, false)).toBe('+22 23 25')
		})
	})

	describe('movement of two celestial bodies', () => {
		const jd1 = Julian.calendarGregorianToJD(1978, 9, 13)
		const coords1 = [
			[hms(10, 29, 44.27), signedDms(false, 11, 2, 5.9)],
			[hms(10, 36, 19.63), signedDms(false, 10, 29, 51.7)],
			[hms(10, 43, 1.75), signedDms(false, 9, 55, 16.7)],
		] as const

		const jd3 = Julian.calendarGregorianToJD(1978, 9, 15)
		const coords2 = [
			[hms(10, 33, 29.64), signedDms(false, 10, 40, 13.2)],
			[hms(10, 33, 57.97), signedDms(false, 10, 37, 33.4)],
			[hms(10, 34, 26.22), signedDms(false, 10, 34, 53.9)],
		] as const

		// First exercise, p. 110.0
		test('sep', () => {
			const c1 = [hms(4, 35, 55.2), signedDms(false, 16, 30, 33)] as const
			const c2 = [hms(16, 29, 24), signedDms(true, 26, 25, 55)] as const
			const d = AngularSeparation.sep(c1, c2)
			const answer = signedDms(false, 169, 58, 0)
			expect(Math.abs(d - answer) < 1e-4).toBeTrue()
		})

		// Second exercise, p. 110.0
		test('minSep', () => {
			const sep = AngularSeparation.minSep(jd1, jd3, coords1, coords2)
			const exp = (0.5017 * PI) / 180 // on p. 111
			expect(Math.abs((sep - exp) / sep) < 1e-3).toBeTrue()
		})

		test('minSepHav', () => {
			const sep = AngularSeparation.minSepHav(jd1, jd3, coords1, coords2)
			const exp = (0.5017 * PI) / 180 // on p. 111
			expect(Math.abs((sep - exp) / sep) < 1e-3).toBeTrue()
		})

		test('minSepPauwels', () => {
			const sep = AngularSeparation.minSepPauwels(jd1, jd3, coords1, coords2)
			const exp = (0.5017 * PI) / 180 // on p. 111
			expect(Math.abs((sep - exp) / sep) < 1e-3).toBeTrue()
		})

		test('minSepRect', () => {
			const sep = AngularSeparation.minSepRect(jd1, jd3, coords1, coords2)
			const exp = (224 * PI) / 180 / 3600 // on p. 111
			expect(Math.abs((sep - exp) / sep) < 1e-2).toBeTrue()
		})
	})
})

describe('Conjunction', () => {
	test('conjunction interpolates continuous angles through zero without mutating samples', () => {
		for (const offset of [0, TAU, -TAU]) {
			const fixed = Object.freeze([offset, 0] as const)
			const moving = [359.7, 359.9, 0.1, 0.3, 0.5].map((ra, i) => Object.freeze([deg(ra), 0.01 * i] as const))
			const snapshot = moving.map((c) => [...c] as const)
			for (const result of [Conjunction.stellar(0, 4, fixed, moving), Conjunction.planetary(0, 4, [fixed, fixed, fixed, fixed, fixed], moving)]) {
				expect(result[0]).toBeCloseTo(1.5, 10)
				expect(result[1]).toBeCloseTo(0.015, 12)
			}
			expect(moving).toEqual(snapshot)
		}
	})

	test('longitude wrap near opposition does not become a conjunction', () => {
		const moving = [179.7, 179.9, 180.1, 180.3, 180.5].map((ra) => [deg(ra), 0] as const)
		expect(() => Conjunction.stellar(0, 4, [0, 0], moving)).toThrow()
	})

	test('conjunction in the first interval of a five-point table', () => {
		const fixed = [0, 0] as const
		const moving = [-0.2, 0.5, 1.2, 1.9, 2.6].map((ra, i) => [deg(ra), 0.01 * i] as const)
		for (const result of [Conjunction.stellar(0, 4, fixed, moving), Conjunction.planetary(0, 4, [fixed, fixed, fixed, fixed, fixed], moving)]) {
			expect(result[0]).toBeCloseTo(2 / 7, 12)
			expect(result[1]).toBeCloseTo(0.02 / 7, 12)
		}
	})

	test('planetary', () => {
		// Example 18.a, p. 117.0

		// Text asks for Mercury-Venus conjunction, so r1, d1 is Venus ephemeris,
		// r2, d2 is Mercury ephemeris.

		// Venus
		const cs1 = [
			[hms(10, 27, 27.175), signedDms(false, 4, 4, 41.83)],
			[hms(10, 26, 32.41), signedDms(false, 3, 55, 54.66)],
			[hms(10, 25, 29.042), signedDms(false, 3, 48, 3.51)],
			[hms(10, 24, 17.191), signedDms(false, 3, 41, 10.25)],
			[hms(10, 22, 57.024), signedDms(false, 3, 35, 16.61)],
		] as const

		// Mercury
		const cs2 = [
			[hms(10, 24, 30.125), signedDms(false, 6, 26, 32.05)],
			[hms(10, 25, 0.342), signedDms(false, 6, 10, 57.72)],
			[hms(10, 25, 12.515), signedDms(false, 5, 57, 33.08)],
			[hms(10, 25, 6.235), signedDms(false, 5, 46, 27.07)],
			[hms(10, 24, 41.185), signedDms(false, 5, 37, 48.45)],
		] as const

		// Compute conjunction
		// Day of month is sufficient for a time scale.
		const a = Conjunction.planetary(5, 9, cs1, cs2)

		// 1991-08-07T05:42:40.908Z
		const [d, f] = modf(a[0])
		const { day, fraction } = timeYMD(1991, 8, d)
		expect(timeToDate(time(day, fraction + f))).toEqual([1991, 8, 7, 5, 42, 40, 907])
		expect(formatALT(a[1], true), '+02 08 22')
	})

	test('stellar', () => {
		// Exercise, p. 119.0

		const cs2 = [
			[hms(15, 3, 51.937), signedDms(true, 8, 57, 34.51)], // 1996-02-07
			[hms(15, 9, 57.327), signedDms(true, 9, 9, 3.88)], // 1996-02-12
			[hms(15, 15, 37.898), signedDms(true, 9, 17, 37.94)], // 1996-02-17
			[hms(15, 20, 50.632), signedDms(true, 9, 23, 16.25)], // 1996-02-22
			[hms(15, 25, 32.695), signedDms(true, 9, 26, 1.01)], // 1996-02-27
		] as const

		const jd = Julian.calendarGregorianToJD(1996, 2, 17)
		const dt = jd - Base.J2000
		const dy = dt / Base.JULIAN_YEAR
		const dc = dy / 100

		const pmr = -0.649 // sec/cen
		const pmd = -1.91 // sec/cen
		// Careful with quick and dirty way of applying correction to seconds
		// component before converting to radians. The dec here is negative
		// so correction must be subtracted. Alternative, less error-prone,
		// way would be to convert both to radians, then add.
		const c1 = [hms(15, 17, 0.421 + pmr * dc), signedDms(true, 9, 22, 58.54 - pmd * dc)] as const

		const a = Conjunction.stellar(7, 27, c1, cs2)

		// 1996-02-18T06:36:55.352Z
		const [d, f] = modf(a[0])
		const { day, fraction } = timeYMD(1996, 2, d)
		expect(timeToDate(time(day, fraction + f))).toEqual([1996, 2, 18, 6, 36, 55, 352])
		expect(formatALT(a[1], true), '+00 03 38')
	})
})

describe('Line', () => {
	test('signed great-circle error is invariant under rotation in longitude', () => {
		for (const offset of [0, PIOVERTWO - 0.5, PI, -PI]) {
			expect(Line.error(offset, 0, offset + 1, 0, offset + 0.5, 0.01)).toBeCloseTo(0.01, 14)
			expect(Line.error(offset + 1, 0, offset, 0, offset + 0.5, 0.01)).toBeCloseTo(-0.01, 14)
		}
	})

	test('collinear great-circle normals have a finite zero angle', () => {
		// Three points on a great circle tilted by 0.4 rad to the equator.
		const coord = (t: number) => [Math.atan2(Math.sin(t) * Math.cos(0.4), Math.cos(t)), Math.asin(Math.sin(t) * Math.sin(0.4))] as const
		const start = 0.0001
		const result = Line.angleError(...coord(start), ...coord(start + 0.1), ...coord(start + 0.2))
		expect(result[0]).toBeCloseTo(0, 14)
		expect(result[1]).toBeCloseTo(0, 14)
	})

	test('time', () => {
		// Example 19.a, p. 121.0

		// apparent equatorial coordinates Castor
		const r1 = 113.56833 * DEG2RAD
		const d1 = 31.89756 * DEG2RAD
		// apparent equatorial coordinates Pollux
		const r2 = 116.25042 * DEG2RAD
		const d2 = 28.03681 * DEG2RAD
		// apparent equatorial coordinates Mars from 29/9 to 3/10/1994
		const r3 = [118.98067 * DEG2RAD, 119.59396 * DEG2RAD, 120.20413 * DEG2RAD, 120.81108 * DEG2RAD, 121.41475 * DEG2RAD] as const
		const d3 = [21.68417 * DEG2RAD, 21.58983 * DEG2RAD, 21.49394 * DEG2RAD, 21.39653 * DEG2RAD, 21.29761 * DEG2RAD] as const

		// use JD as time to handle month boundary
		const day = Line.time(r1, d1, r2, d2, r3, d3, Julian.calendarGregorianToJD(1994, 9, 29), Julian.calendarGregorianToJD(1994, 10, 3))

		expect(timeToDate({ day, fraction: 0, scale: 1 })).toEqual([1994, 10, 1, 5, 21, 33, 530])
	})

	test('angle', () => {
		// Example p. 123.0
		const rδ = hms(5, 32, 0.4)
		const dδ = signedDms(true, 0, 17, 56.9)
		const rε = hms(5, 36, 12.81)
		const dε = signedDms(true, 1, 12, 7)
		const rζ = hms(5, 40, 45.52)
		const dζ = signedDms(true, 1, 56, 33.3)

		const n = Line.angle(rδ, dδ, rε, dε, rζ, dζ)
		strictEqual(toDeg(n), 172.483, 4)
	})

	test('error', () => {
		// Example p. 124.0
		const rδ = hms(5, 32, 0.4)
		const dδ = signedDms(true, 0, 17, 56.9)
		const rε = hms(5, 36, 12.81)
		const dε = signedDms(true, 1, 12, 7)
		const rζ = hms(5, 40, 45.52)
		const dζ = signedDms(true, 1, 56, 33.3)

		const ω = Line.error(rζ, dζ, rδ, dδ, rε, dε)
		strictEqual(toArcsec(ω), 324, 0)
	})

	test('angleError', () => {
		// Example p. 125.0
		const rδ = hms(5, 32, 0.4)
		const dδ = signedDms(true, 0, 17, 56.9)
		const rε = hms(5, 36, 12.81)
		const dε = signedDms(true, 1, 12, 7)
		const rζ = hms(5, 40, 45.52)
		const dζ = signedDms(true, 1, 56, 33.3)

		const [n, ω] = Line.angleError(rδ, dδ, rε, dε, rζ, dζ)
		expect(formatALT(n, false)).toBe('+07 31 01')
		expect(formatALT(ω, false)).toBe('-00 05 24')
	})
})

describe('Parallactic', () => {
	test('eclipticAtHorizon', () => {
		const [L1, L2, I] = Parallactic.eclipticAtHorizon(deg(23.44), deg(51), deg(75))

		expect(formatALT(L1, false)).toBe('+169 21 30')
		expect(formatALT(L2, false)).toBe('+349 21 30')
		expect(formatALT(I, false)).toBe('+61 53 14')
	})

	test('diurnalPathAtHorizon', () => {
		const phi = deg(40)
		let J = Parallactic.diurnalPathAtHorizon(phi, 0) // 0.8726646259971648
		let Jexp = PIOVERTWO - phi
		expect(Math.abs((J - Jexp) / Jexp) < 1e-15).toBeTrue()
		J = Parallactic.diurnalPathAtHorizon(phi, deg(23.44)) // 0.794553542331993
		Jexp = dms(45, 31, 0)
		expect(Math.abs((J - Jexp) / Jexp) < 1e-3).toBeTrue()
	})
})

describe('Refraction', () => {
	test('bennett', () => {
		// Example 16.a, p. 107.0
		const h0 = (0.5 * PI) / 180
		const R = Refraction.bennett(h0)
		const cMin = (60 * 180) / PI
		strictEqual(R * cMin, 28.754, 3) // R Lower: 28.754
		const hLower = h0 - R
		strictEqual(hLower * cMin, 1.246, 3) // h Lower: 1.246
		const hUpper = hLower + (32 * PI) / (180 * 60)
		strictEqual(hUpper * cMin, 33.246, 3) // h Upper: 33.246
		const Rh = Refraction.saemundsson(hUpper)
		strictEqual(Rh * cMin, 24.618, 3) // R Upper: 24.618
	})

	// Test two values for zenith given on p. 106.0
	test('bennett2', () => {
		let R = Refraction.bennett(PI / 2)
		const cSec = (3600 * 180) / PI
		expect(Math.abs(0.08 + R * cSec) < 0.01).toBeTrue()
		R = Refraction.bennett2(PI / 2)
		expect(Math.abs(0.89 + R * cSec) < 0.01).toBeTrue()
	})
})

describe('Circle', () => {
	test('smallest circle retains tiny angular diameter', () => {
		const result = Circle.smallest([0, 0], [1e-9, 0], [2e-9, 0])
		expect(result[0]).toBeCloseTo(2e-9, 20)
		expect(result[1]).toBeTrue()
	})

	test('smallest type I', () => {
		// Exercise, p. 128.0
		const c1 = [hms(9, 5, 41.44), signedDms(false, 18, 30, 30)] as const
		const c2 = [hms(9, 9, 29), signedDms(false, 17, 43, 56.7)] as const
		const c3 = [hms(8, 59, 47.14), signedDms(false, 17, 49, 36.8)] as const
		const a = Circle.smallest(c1, c2, c3)
		expect(formatALT(a[0], false)).toBe('+02 18 38')
		expect(a[1]).toBeTrue() // type I
	})

	test('smallest type II', () => {
		// Example 20.a, p. 128.0
		const c1 = [hms(12, 41, 8.64), signedDms(true, 5, 37, 54.2)] as const
		const c2 = [hms(12, 52, 5.21), signedDms(true, 4, 22, 26.2)] as const
		const c3 = [hms(12, 39, 28.11), signedDms(true, 1, 50, 3.7)] as const
		const a = Circle.smallest(c1, c2, c3)
		expect(formatALT(a[0], false)).toBe('+04 15 49')
		expect(a[1]).toBeFalse() // type II
	})
})

describe('Precession', () => {
	test('identity reduction retains nearly coplanar orbital inclinations', () => {
		const p = new Precession.EclipticPrecessor(2000, 2000)
		for (const inclination of [1e-9, PI - 1e-9]) expect(p.reduceElements([inclination, 1, 2])[0]).toBeCloseTo(inclination, 15)
	})

	test('one-component proper motion is retained in ecliptic positions', () => {
		// At RA=Dec=0, the equatorial/ecliptic tangent-plane conversion is a rotation by obliquity.
		const eps = Nutation.meanObliquity(Base.J2000)
		const p = new Precession.EclipticPrecessor(2000, 2100)
		for (const [pmRA, pmDEC] of [
			[ASEC2RAD, 0],
			[0, ASEC2RAD],
		]) {
			const lon = 100 * (pmRA * Math.cos(eps) + pmDEC * Math.sin(eps))
			const lat = 100 * (-pmRA * Math.sin(eps) + pmDEC * Math.cos(eps))
			const expected = p.precess(lon, lat)
			const actual = Precession.eclipticPosition(p, 0, 0, pmRA, pmDEC)
			expect(actual[0]).toBeCloseTo(expected[0], 14)
			expect(actual[1]).toBeCloseTo(expected[1], 14)
		}
		expect(Precession.properMotion(0, 0, 2000, 1, 0.5)).toEqual([0, 0])
	})

	test('equatorial precession remains finite at both rotated poles', () => {
		// Inputs are the inverse rotation of the 2081 south pole under Meeus 21.4.
		const p = new Precession.Precessor(2000, 2081)
		const ra = 3.13253514967851,
			dec = -1.5629268811938901
		expect(p.precess(ra, dec)[1]).toBeCloseTo(-PIOVERTWO, 14)
		expect(p.precess(ra + PI, -dec)[1]).toBeCloseTo(PIOVERTWO, 14)
	})

	test('ecliptic precession remains finite at both rotated poles', () => {
		const p = new Precession.EclipticPrecessor(2000, 2060)
		const lon = 4.620434901763646,
			lat = -1.5706596584690056
		expect(p.precess(lon, lat)[1]).toBeCloseTo(-PIOVERTWO, 14)
		expect(p.precess(lon + PI, -lat)[1]).toBeCloseTo(PIOVERTWO, 14)
	})

	describe('mn', () => {
		// test data from p. 132.
		const dates = [
			[1700, 3.069, 1.338, 20.07],
			[1800, 3.071, 1.337, 20.06],
			[1900, 3.073, 1.337, 20.05],
			[2000, 3.075, 1.336, 20.04],
			[2100, 3.077, 1.336, 20.03],
			[2200, 3.079, 1.335, 20.03],
		] as const

		for (const [epoch, m, na, nd] of dates) {
			const a = Precession.mn(2000, epoch)

			test(epoch.toFixed(0), () => {
				expect(Math.abs(a[0] - m) < 1e-3).toBeTrue()
				expect(Math.abs(a[1] - na) < 1e-3).toBeTrue()
				expect(Math.abs(a[2] - nd) < 1e-2).toBeTrue()
			})
		}
	})

	test('approxAnnualPrecession', () => {
		// Example 21.a, p. 132.
		const [ra, dec] = Precession.approxAnnualPrecession(hms(10, 8, 22.3), signedDms(false, 11, 58, 2), 2000, 1978)
		expect(formatRA(ra, 3)).toBe('00 00 03.207')
		expect(formatALT(dec)).toBe('-00 00 17.71')
	})

	test('approxPosition', () => {
		// Example 21.a, p. 132.
		const ma = -hms(0, 0, 0.0169)
		const md = signedDms(false, 0, 0, 0.006)
		const [ra, dec] = Precession.approxPosition(hms(10, 8, 22.3), signedDms(false, 11, 58, 2), 2000, 1978, ma, md)
		expect(formatRA(ra, 1)).toBe('10 07 12.1')
		expect(formatALT(dec, 0)).toBe('+12 04 32')
	})

	test('position', () => {
		// Example 21.b, p. 135.
		const jdTo = Julian.calendarGregorianToJD(2028, 11, 13.19)
		const epochTo = Base.jdeToJulianYear(jdTo)
		const p = new Precession.Precessor(2000, epochTo)
		const [ra, dec] = Precession.position(p, hms(2, 44, 11.986), signedDms(false, 49, 13, 42.48), hms(0, 0, 0.03425), signedDms(true, 0, 0, 0.0895))
		expect(formatRA(ra, 3)).toBe('02 46 11.331')
		expect(formatALT(dec, 2)).toBe('+49 20 54.54')
	})

	test('properMotion', () => {
		// Test with proper motion of Regulus, with equatorial motions given
		// in Example 21.a, p. 132, and ecliptic motions given in table 21.A, p. 138.
		const ε = Nutation.meanObliquity(Base.J2000)
		const [lon, lat] = Precession.properMotion(-hms(0, 0, 0.0169), signedDms(false, 0, 0, 0.006), 2000, ...Coords.equatorialToEcliptic(hms(10, 8, 22.3), signedDms(false, 11, 58, 2), ε))

		let d = Math.abs((lon - signedDms(true, 0, 0, 0.2348)) / lon)
		expect(d * 169 < 1).toBeTrue() // 169 = significant digits of given lon
		d = Math.abs((lat - signedDms(true, 0, 0, 0.0813)) / lat)
		expect(d * 6 < 1).toBeTrue() // 6 = significant digit of given lat
	})

	describe('position JDE', () => {
		// Exercise, p. 136.
		const eqFrom = [hms(2, 31, 48.704), signedDms(false, 89, 15, 50.72)] as const
		const ma = hms(0, 0, 0.19877)
		const md = signedDms(true, 0, 0, 0.0152)

		const dates = [
			[Base.besselianYearToJDE(1900), '01 22 33.9', '+88 46 26.18'],
			[Base.julianYearToJDE(2050), '03 48 16.43', '+89 27 15.38'],
			[Base.julianYearToJDE(2100), '05 53 29.17', '+89 32 22.18'],
		] as const

		for (const [date, ra, dec] of dates) {
			test(date.toFixed(0), () => {
				const epochTo = Base.jdeToJulianYear(date)
				const p = new Precession.Precessor(2000, epochTo)
				const eqTo = Precession.position(p, ...eqFrom, ma, md)
				expect(formatRA(eqTo[0]), ra)
				expect(formatALT(eqTo[1]), dec)
			})
		}
	})

	describe('position Epochs', () => {
		// Exercise, p. 136.
		const eqFrom = [hms(2, 31, 48.704), signedDms(false, 89, 15, 50.72)] as const
		const ma = hms(0, 0, 0.19877)
		const md = signedDms(false, 0, 0, -0.0152)
		const epochs = [
			[Base.jdeToJulianYear(Base.B1900), '1 22 33.9', '88 46 26.18'],
			[2050, '3 48 16.43', '89 27 15.38'],
			[2100, '5 53 29.17', '89 32 22.18'],
		] as const

		for (const [epochTo, ra, dec] of epochs) {
			test(epochTo.toFixed(0), () => {
				const p = new Precession.Precessor(2000, epochTo)
				const eqTo = Precession.position(p, ...eqFrom, ma, md)
				expect(formatRA(eqTo[0]), ra)
				expect(formatALT(eqTo[1]), dec)
			})
		}
	})

	describe('eclipticPosition', () => {
		test('example', () => {
			// Example 21.c, p. 137.
			const epochTo = Base.jdeToJulianYear(Julian.calendarJulianToJD(-214, 6, 30))
			const p = new Precession.EclipticPrecessor(2000, epochTo)
			const [lon, lat] = Precession.eclipticPosition(p, deg(149.48194), deg(1.76549))
			strictEqual(toDeg(lon), 118.70416774861883)
			strictEqual(toDeg(lat), 1.6153320055611455)
		})

		test('reduceElements', () => {
			// Example 24.a, p. 160.
			let ele = [47.122 * DEG2RAD, 45.7481 * DEG2RAD, 151.4486 * DEG2RAD] as const

			const JFrom = Base.jdeToJulianYear(Base.besselianYearToJDE(1744))
			const JTo = Base.jdeToJulianYear(Base.besselianYearToJDE(1950))
			const p = new Precession.EclipticPrecessor(JFrom, JTo)
			ele = p.reduceElements(ele)

			strictEqual(toDeg(ele[0]), 47.13795835860312)
			strictEqual(toDeg(ele[1]), 48.6036896626305)
			strictEqual(toDeg(ele[2]), 151.47823843361917)
		})
	})

	describe('properMotion3D', () => {
		// Example 21.d, p. 141.
		const eqFrom = [hms(6, 45, 8.871), signedDms(true, 16, 42, 57.99)] as const
		const mra = hms(0, 0, -0.03847)
		const mdec = signedDms(false, 0, 0, -1.2053)
		const r = 2.64 // given in correct unit
		const mr = -7.6 / 977792 // magic conversion factor

		const epochs = [
			[1000, '6 45 47.16', '-16 22 56.03'],
			[0, '6 46 25.09', '-16 3 .77'],
			[-1000, '6 47 2.67', '-15 43 12.27'],
			[-2000, '6 47 39.91', '-15 23 30.57'],
			[-10000, '6 52 25.72', '-12 50 6.7'],
		] as const

		for (const [epoch, ra, dec] of epochs) {
			test(epoch.toFixed(0), () => {
				const eqTo = Precession.properMotion3D(...eqFrom, 2000, epoch, r, mr, mra, mdec)
				expect(formatRA(eqTo[0]), ra)
				expect(formatALT(eqTo[1]), dec)
			})
		}
	})
})

describe('Nutation', () => {
	test('nutation and meanObliquity', () => {
		// Example 22.a, p. 148.
		const jd = Julian.calendarGregorianToJD(1987, 4, 10)
		const nu = Nutation.nutation(jd)
		const Δε = nu[1]
		const ε0 = Nutation.meanObliquity(jd)
		const ε = ε0 + Δε
		expect(formatALT(nu[0])).toBe('-00 00 03.79')
		expect(formatALT(nu[1])).toBe('+00 00 09.44')
		expect(formatALT(ε0)).toBe('+23 26 27.41')
		expect(formatALT(ε)).toBe('+23 26 36.85')
	})

	test('approxNutation', () => {
		const jd = Julian.calendarGregorianToJD(1987, 4, 10)
		const nu = Nutation.approxNutation(jd)
		expect(formatALT(nu[0])).toBe('-00 00 03.86')
		expect(Math.abs(nu[0] * RAD2DEG * 3600 + 3.788) < 0.5).toBeTrue()
		expect(formatALT(nu[1])).toBe('+00 00 09.47')
		expect(Math.abs(nu[1] * RAD2DEG * 3600 - 9.443) < 0.1).toBeTrue()
	})

	test('nutationInRA', () => {
		const jd = Julian.calendarGregorianToJD(1987, 4, 10)
		const a = Nutation.nutationInRA(jd)
		strictEqual(a, -0.000016848469493116356)
	})

	describe('meanObliquityLaskar', () => {
		for (const y of [1000, 2000, 3000] as const) {
			test(y.toFixed(0), () => {
				const jd = Julian.calendarGregorianToJD(y, 0, 0)
				const i = Nutation.meanObliquity(jd)
				const l = Nutation.meanObliquityLaskar(jd)
				expect(Math.abs(i - l) * RAD2DEG * 3600 < 1).toBeTrue()
			})
		}

		for (const y of [0, 4000] as const) {
			test(y.toFixed(0), () => {
				const jd = Julian.calendarGregorianToJD(y, 0, 0)
				const i = Nutation.meanObliquity(jd)
				const l = Nutation.meanObliquityLaskar(jd)
				expect(Math.abs(i - l) * RAD2DEG * 3600 < 10).toBeTrue()
			})
		}
	})
})

describe('ElementeEuinox', () => {
	test('FK4 reduction resolves a nearly coplanar target orbit', () => {
		const tilt = deg(0.00651966)
		const result = ElementEquinox.reduceB1950FK4ToJ2000FK5([tilt + 1e-9, PI - deg(5.19856209), 0])
		expect(result[0]).toBeCloseTo(1e-9, 16)
	})

	test('B1950 reduction preserves retrograde orbital orientation', () => {
		// For node=174.298782 degrees, W=0: the plane rotation subtracts its small tilt from inclination.
		const tilt = Math.atan2(0.0001139788, 0.9999999935)
		for (const inc of [deg(60), deg(120), deg(179)]) {
			const result = ElementEquinox.reduceB1950ToJ2000([inc, deg(174.298782), 0])
			expect(result[0]).toBeCloseTo(inc - tilt, 14)
		}
	})

	test('reduceB1950ToJ2000', () => {
		// Example 24.b, p. 161.
		const from = [deg(11.93911), deg(334.04096), deg(186.24444)] as const
		const to = ElementEquinox.reduceB1950ToJ2000(from)
		// Rounded S/C coefficients are not exactly unit length; atan2 preserves the quadrant
		// and agrees with an independently rotated unit normal within 1e-9 degree.
		strictEqual(toDeg(to[0]), 11.945236764689536, 9)
		strictEqual(toDeg(to[1]), 334.7500602425115)
		strictEqual(toDeg(to[2]), 186.23351531378918)
	})

	test('reduceB1950FK4ToJ2000FK5', () => {
		// Example 24.c, p. 162.
		const from = [deg(11.93911), deg(334.04096), deg(186.24444)] as const
		const to = ElementEquinox.reduceB1950FK4ToJ2000FK5(from)
		strictEqual(toDeg(to[0]), 11.945206561406797)
		strictEqual(toDeg(to[1]), 334.75042895869086)
		strictEqual(toDeg(to[2]), 186.23327459848562)
	})
})

describe('Kepler', () => {
	test('kepler1', () => {
		// Example 30.a, p. 196
		const E = Kepler.kepler1(0.1, deg(5), 8)
		strictEqual(toDeg(E), 5.554589, 6)
	})

	test('kepler2', () => {
		// Example 30.b, p. 199
		const E = Kepler.kepler2(0.1, deg(5), 11)
		strictEqual(toDeg(E), 5.554589254, 9)
	})

	test('kepler2a', () => {
		// Example data from p. 205
		const E = Kepler.kepler2a(0.99, 0.2, 14)
		strictEqual(E, 1.066997365282, 12)
	})

	test('kepler2b', () => {
		// Example data from p. 205
		const E = Kepler.kepler2b(0.99, 0.2, 14)
		strictEqual(E, 1.066997365282, 12)
	})

	test('kepler3', () => {
		// Example data from p. 205
		const E = Kepler.kepler3(0.99, 0.2)
		strictEqual(E, 1.066997365282, 12)
	})

	test('kepler4', () => {
		// Input data from example 30.a, p. 196,
		// result from p. 207
		const E = Kepler.kepler4(0.1, deg(5))
		strictEqual(toDeg(E), 5.554599, 6)
	})
})

describe('PlanetElements', () => {
	test('mean', () => {
		// Example 31.a, p. 211
		const j = Julian.calendarGregorianToJD(2065, 6, 24)
		const e = PlanetElements.mean('mercury', j)
		strictEqual(toDeg(e.L), 203.494701, 6)
		strictEqual(e.a, 0.38709831, 9)
		strictEqual(e.e, 0.2056451, 8)
		strictEqual(toDeg(e.i), 7.006171, 6)
		strictEqual(toDeg(e.omega), 49.10765, 6)
		strictEqual(toDeg(e.w), 78.475382, 6)
	})

	test('inc', () => {
		const j = Julian.calendarGregorianToJD(2065, 6, 24)
		const e = PlanetElements.mean('mercury', j)
		strictEqual(PlanetElements.inc('mercury', j), e.i)
	})

	test('node', () => {
		const j = Julian.calendarGregorianToJD(2065, 6, 24)
		const e = PlanetElements.mean('mercury', j)
		strictEqual(PlanetElements.node('mercury', j), e.omega)
	})
})

describe('PlanetPosition', () => {
	// Bretagnon/Francou VSOP87B and VSOP87D reference positions at numerical dynamical JD 2415020.0.
	// https://github.com/ctdk/vsop87/blob/master/vsop87.chk
	// Each row gives heliocentric [longitude (rad), latitude (rad), range (AU)] in J2000 and of date.
	// Allow 0.01 arcsec/1e-6 AU for differences among series, and 0.05 arcsec for Meeus precession.
	const cases = [
		['mercury', [3.5095041512, 0.0564907883, 0.4183426276], [3.4851161911, 0.0565906173, 0.4183426275]],
		['venus', [5.9993518124, -0.0591709804, 0.7274719352], [5.9749622238, -0.0591260014, 0.7274719359]],
		['earth', [1.7634989198, 0.000218691, 0.9832689762], [1.7391225563, -0.0000005679, 0.9832689778]],
		['mars', [5.0185792656, -0.02740735, 1.4218777718], [4.9942005211, -0.0271965869, 1.4218777705]],
		['jupiter', [4.1171308454, 0.015945665, 5.3850276351], [4.0927527024, 0.0161446618, 5.3850276671]],
		['saturn', [4.6756597986, 0.0190423976, 10.0668532372], [4.6512836347, 0.0192701409, 10.0668531997]],
		['uranus', [4.3641525628, 0.000936861, 18.9927163179], [4.3397761173, 0.0011570307, 18.992716362]],
		['neptune', [1.5199957208, -0.0217331273, 29.8710344515], [1.4956195225, -0.021961003, 29.8710345051]],
	] as const

	test.concurrent.each(cases)('%s position2000 matches VSOP87B', (planet, expected) => {
		const [lon, lat, distance] = PlanetPosition.position2000(planet, 2415020)
		expect(Math.abs(lon - expected[0])).toBeLessThan(0.01 * ASEC2RAD)
		expect(Math.abs(lat - expected[1])).toBeLessThan(0.01 * ASEC2RAD)
		expect(Math.abs(distance - expected[2])).toBeLessThan(1e-6)
	})

	test.concurrent.each(cases)('%s position matches VSOP87D', (planet, _, expected) => {
		const [lon, lat, distance] = PlanetPosition.position(planet, 2415020)
		expect(Math.abs(lon - expected[0])).toBeLessThan(0.05 * ASEC2RAD)
		expect(Math.abs(lat - expected[1])).toBeLessThan(0.05 * ASEC2RAD)
		expect(Math.abs(distance - expected[2])).toBeLessThan(1e-6)
	})

	test.concurrent.each(cases)('%s precession is identity at J2000', (planet) => {
		const expected = PlanetPosition.position2000(planet, Base.J2000)
		const actual = PlanetPosition.position(planet, Base.J2000)
		for (let i = 0; i < 3; i++) expect(actual[i]).toBeCloseTo(expected[i], 14)
	})

	test('Venus example 32.a', () => {
		// Astronomia's full VSOP87B results for Meeus example 32.a, 1992-12-20 00:00 TT.
		// https://github.com/commenthol/astronomia/blob/master/test/planetposition.test.js
		const jde = Julian.calendarGregorianToJD(1992, 12, 20)
		const [lon2000, lat2000, range2000] = PlanetPosition.position2000('venus', jde)
		expect(lon2000).toBeCloseTo(0.45749253478276586, 7)
		expect(lat2000).toBeCloseTo(-0.045729822980889484, 7)
		expect(range2000).toBeCloseTo(0.7246016739689574, 7)

		const [lon, lat, distance] = PlanetPosition.position('venus', jde)
		expect(toDeg(lon)).toBeCloseTo(26.11412, 5)
		expect(toDeg(lat)).toBeCloseTo(-2.6206, 5)
		expect(distance).toBe(range2000)

		const [fk5lon, fk5lat] = PlanetPosition.toFK5(lon, lat, jde)
		expect(toDeg(fk5lon)).toBeCloseTo(26.11409, 5)
		expect(toDeg(fk5lat)).toBeCloseTo(-2.6206, 5)
	})

	test('Mars crosses zero longitude after J2000', () => {
		for (const position of [PlanetPosition.position2000, PlanetPosition.position]) {
			const [before] = position('mars', Base.J2000)
			const [after] = position('mars', Base.J2000 + 2)
			expect(before).toBeGreaterThan(TAU - 0.02)
			expect(before).toBeLessThan(TAU)
			expect(after).toBeGreaterThanOrEqual(0)
			expect(after).toBeLessThan(0.02)
		}
	})

	test('toFK5 wraps longitude and preserves the correction signs', () => {
		const [lon, lat] = PlanetPosition.toFK5(0, 0, Base.J2000)
		expect(lon).toBeCloseTo(TAU - 0.09033 * ASEC2RAD, 14)
		expect(lat).toBeCloseTo(0.03916 * ASEC2RAD, 14)
	})

	test('toFK5 uses the date and nonzero latitude', () => {
		// At T = 1 century, this longitude makes L-prime zero in Meeus (32.3).
		const longitude = deg(1.39731)
		const [lon, lat] = PlanetPosition.toFK5(longitude, PI / 4, Base.J2000 + Base.JULIAN_CENTURY)
		expect(lon).toBeCloseTo(longitude - 0.05117 * ASEC2RAD, 14)
		expect(lat).toBeCloseTo(PI / 4 + 0.03916 * ASEC2RAD, 14)
	})
})

describe('Parabolic', () => {
	test('inbound and outbound motion satisfy Barker equation symmetrically', () => {
		const q = 0.005,
			T = Base.J2000
		const orbit = new Parabolic.Elements(T, q)
		for (const dt of [0.001, 36525, 3652500]) {
			const before = orbit.anomalyDistance(T - dt)
			const after = orbit.anomalyDistance(T + dt)
			expect(before[0]).toBeCloseTo(-after[0], 14)
			expect(before[1] / after[1]).toBeCloseTo(1, 14)
			for (const sign of [-1, 1]) {
				const [nu, radius] = sign < 0 ? before : after
				const tangent = Math.tan(nu / 2)
				const recovered = (Math.sqrt(2 * q ** 3) / Base.K) * (tangent + tangent ** 3 / 3)
				expect(recovered / (T + sign * dt - T)).toBeCloseTo(1, 11)
				expect(radius / (q * (1 + tangent * tangent))).toBeCloseTo(1, 11)
			}
		}
	})

	test('anomaly distance', () => {
		// Example 34.a, p. 243
		const e = new Parabolic.Elements(Julian.calendarGregorianToJD(1998, 4, 14.4358), 1.487469)
		const j = Julian.calendarGregorianToJD(1998, 8, 5)
		const [ano, dist] = e.anomalyDistance(j)
		strictEqual(toDeg(ano), 66.78862, 5)
		strictEqual(dist, 2.133911, 6)
	})
})

describe('NearParabolic', () => {
	describe('anomaly distance', () => {
		const data = [
			// test data p. 247
			{ q: 0.921326, e: 1, t: 138.4783, v: 102.74426, r: 2.364192 },
			{ q: 0.1, e: 0.987, t: 254.9, v: 164.50029, r: 4.063777 },
			{ q: 0.123456, e: 0.99997, t: -30.47, v: 221.9119, r: 0.965053 },
			{ q: 3.363943, e: 1.05731, t: 1237.1, v: 109.40598, r: 10.668551 },
			{ q: 0.5871018, e: 0.9672746, t: 20, v: 52.85331, r: 0.729116 },
			{ q: 0.5871018, e: 0.9672746, t: 0, v: 0, r: 0.5871018 },
		] as const

		for (const { q, e, t, v, r } of data) {
			test(t.toString(), () => {
				const elements = new NearParabolic.Elements(Base.J2000 + Math.random() * Base.JULIAN_CENTURY, q, e)
				const [ano, dist, err] = elements.anomalyDistance(elements.T + t)

				if (!err) {
					expect(Math.abs(toDeg(ano) - v) < 1e-5).toBeTrue()
					expect(Math.abs(dist - r) < 1e-6).toBeTrue()
				}
			})
		}
	})

	describe('anomaly distance II', () => {
		const data = [
			// test data p. 248
			{ q: 0.1, e: 0.9, t: 10, v: 126, p: 0, c: true },
			{ q: 0.1, e: 0.9, t: 20, v: 142, p: 0, c: true },
			{ q: 0.1, e: 0.9, t: 30, v: 0, p: 0, c: false },
			{ q: 0.1, e: 0.987, t: 10, v: 123, p: 0, c: true },
			{ q: 0.1, e: 0.987, t: 20, v: 137, p: 0, c: true },
			{ q: 0.1, e: 0.987, t: 30, v: 143, p: 0, c: true },
			{ q: 0.1, e: 0.987, t: 60, v: 152, p: 0, c: true },
			{ q: 0.1, e: 0.987, t: 100, v: 157, p: 0, c: true },
			{ q: 0.1, e: 0.987, t: 200, v: 163, p: 0, c: true },
			{ q: 0.1, e: 0.987, t: 400, v: 167, p: 0, c: true },
			{ q: 0.1, e: 0.987, t: 500, v: 0, p: 0, c: false },
			{ q: 0.1, e: 0.999, t: 100, v: 156, p: 0, c: true },
			{ q: 0.1, e: 0.999, t: 200, v: 161, p: 0, c: true },
			{ q: 0.1, e: 0.999, t: 500, v: 166, p: 0, c: true },
			{ q: 0.1, e: 0.999, t: 1000, v: 169, p: 0, c: true },
			{ q: 0.1, e: 0.999, t: 5000, v: 174, p: 0, c: true },
			{ q: 1, e: 0.99999, t: 100000, v: 172.5, p: 1, c: true },
			{ q: 1, e: 0.99999, t: 10000000, v: 178.41, p: 2, c: true },
			{ q: 1, e: 0.99999, t: 14000000, v: 178.58, p: 2, c: true },
			{ q: 1, e: 0.99999, t: 17000000, v: 178.68, p: 2, c: true },
			{ q: 1, e: 0.99999, t: 18000000, v: 0, p: 2, c: false },
		] as const

		for (const { q, e, t, v, p, c } of data) {
			test(t.toString(), () => {
				const elements = new NearParabolic.Elements(Base.J2000 + Math.random() * Base.JULIAN_CENTURY, q, e)
				const [ano, , err] = elements.anomalyDistance(elements.T + t)

				expect(!err).toBe(c)

				if (!err) {
					expect(Math.abs(toDeg(ano) - v) < 10 ** -p).toBeTrue()
				}
			})
		}
	})
})

describe('Planetary', () => {
	test('mercuryInfConj', () => {
		// Example 36.a, p. 252
		const j = Planetary.mercuryInfConj(1993.75)
		strictEqual(j, 2449297.645, 3)
	})

	test('saturnConj', () => {
		// Example 36.b, p. 252
		const j = Planetary.saturnConj(2125.5)
		strictEqual(j, 2497437.904, 3)
	})

	test('mercuryWestElongation', () => {
		// Example 36.c, p. 253
		const res = Planetary.mercuryWestElongation(1993.9)
		const j = res[0]
		const e = res[1]
		strictEqual(j, 2449314.14, 2)
		strictEqual(toDeg(e), 19.7506, 4)
		expect(formatALT(e, false)).toBe('+19 45 02')
	})

	test('marsStation2', () => {
		// Example 36.d, p. 254
		const j = Planetary.marsStation2(1997.3)
		strictEqual(j, 2450566.255, 3)
	})

	const dates = [
		[Planetary.mercuryInfConj, Julian.calendarGregorianToJD(1631, 11, 7), 7],
		[Planetary.venusInfConj, Julian.calendarGregorianToJD(1882, 12, 6), 17],
		[Planetary.marsOpp, Julian.calendarGregorianToJD(2729, 9, 9), 3],
		[Planetary.jupiterOpp, Julian.calendarJulianToJD(-6, 9, 15), 7],
		[Planetary.saturnOpp, Julian.calendarJulianToJD(-6, 9, 14), 9],
		[Planetary.uranusOpp, Julian.calendarGregorianToJD(1780, 12, 17), 14],
		[Planetary.neptuneOpp, Julian.calendarGregorianToJD(1846, 8, 20), 4],
	] as const

	for (const d of dates) {
		test(d[0].name, () => {
			const f = modf(0.5 + d[0](Base.jdeToJulianYear(d[1])))[1]
			strictEqual(Math.floor(f * 24 + 0.5), d[2])
		})
	}
})

describe('Node', () => {
	test('EllipticAscending', () => {
		// Example 39.a, p. 276
		const res = Node.ellipticAscending(17.9400782, 0.96727426, (111.84644 * PI) / 180, Julian.calendarGregorianToJD(1986, 2, 9.45891))
		const t = res[0]
		const r = res[1]
		const d = Julian.jdToCalendar(t)
		strictEqual(d[0], 1985)
		strictEqual(d[1], 11)
		strictEqual(d[2], 9.16, 2)
		strictEqual(r, 1.8045, 4) // AU
	})

	test('EllipticDescending', () => {
		// Example 39.a, p. 276
		const res = Node.ellipticDescending(17.9400782, 0.96727426, (111.84644 * PI) / 180, Julian.calendarGregorianToJD(1986, 2, 9.45891))
		const t = res[0]
		const r = res[1]
		const d = Julian.jdToCalendar(t)
		strictEqual(d[0], 1986)
		strictEqual(d[1], 3)
		strictEqual(d[2], 10.37, 2)
		strictEqual(r, 0.8493, 4) // AU
	})

	test('parabolicAscending', () => {
		// Example 29.b, p. 277
		const res = Node.parabolicAscending(1.324502, (154.9103 * PI) / 180, Julian.calendarGregorianToJD(1989, 8, 20.291))
		const t = res[0]
		const r = res[1]
		const d = Julian.jdToCalendar(t)
		strictEqual(d[0], 1977)
		strictEqual(d[1], 9)
		strictEqual(d[2], 17.6, 1)
		strictEqual(r, 28.07, 2) // AU
	})

	test('parabolicDescending', () => {
		// Example 29.b, p. 277
		const res = Node.parabolicDescending(1.324502, (154.9103 * PI) / 180, Julian.calendarGregorianToJD(1989, 8, 20.291))
		const t = res[0]
		const r = res[1]
		const d = Julian.jdToCalendar(t)
		strictEqual(d[0], 1989)
		strictEqual(d[1], 9)
		strictEqual(d[2], 17.636, 3)
		strictEqual(r, 1.3901, 4) // AU
	})

	// TODO: test('ellipticAscending of venus', () => {
	// 	// Example 39.c, p. 278
	// 	const k = planetelements.mean(planetelements.venus, Julian.calendarGregorianToJD(1979, 1, 1))
	// 	const res = Node.ellipticAscending(
	// 		k.axis,
	// 		k.ecc,
	// 		k.peri - k.node,
	// 		perihelion.perihelion(perihelion.venus, 1979),
	// 	)
	// 	const t = res[0]
	// 	const d = Julian.jDToCalendar(t)
	// 	strictEqual(d[0], 1978)
	// 	strictEqual(d[1], 11)
	// 	strictEqual(d[2], 27.409, 3)
	// })
})

describe('Parallax', () => {
	test('topocentric declination retains its hemisphere across a pole', () => {
		const jd = Base.J2000,
			theta = secondsOfTime(Sidereal.apparent(jd)),
			distance = 0.00257
		for (const sign of [-1, 1]) {
			const dec = sign * deg(89.9)
			const result = Parallax.topocentric(theta, dec, distance, 0, 1, 0, jd)
			const alternative = Parallax.topocentric3(theta, dec, distance, 0, 1, 0, jd)
			// Observer at equatorial meridian: subtract its X component from the geocentric unit vector.
			const x = Math.cos(dec) - Math.sin(Parallax.horizontal(distance)),
				z = Math.sin(dec)
			expect(result[1]).toBeCloseTo(Math.atan2(z, Math.abs(x)), 14)
			expect(alternative[1]).toBeCloseTo(result[1], 14)
			expect(Math.cos(result[0] - theta)).toBeCloseTo(-1, 14)
		}
	})

	test('ecliptic parallax is finite when the translated X component vanishes', () => {
		const lon = deg(89.5),
			radius = 0.004
		const result = Parallax.topocentricEcliptical(lon, 0, radius, 0, 0, 0, 0, Math.asin(Math.cos(lon)))
		expect(result[0]).toBeCloseTo(PIOVERTWO, 14)
		expect(result[1]).toBeCloseTo(0, 14)
		expect(result[2]).toBeCloseTo(Math.asin(Math.sin(radius) / Math.sin(lon)), 14)
	})

	test('horizontal', () => {
		// Example 40.a, p. 280
		const π = Parallax.horizontal(0.37276)
		strictEqual(toArcsec(π), 23.592, 3)
	})

	test('horizontal from moonposition', () => {
		// example from moonParallax, ch 47, p. 342
		const jd = Julian.calendarGregorianToJD(1992, 4, 12)
		const range = MoonPosition.position(jd)[2]
		const πMoon = moonParallax(range) * RAD2DEG
		const π = Parallax.horizontal(range) * RAD2DEG
		// The generic and lunar helpers use slightly different reference Earth radii.
		expect(Math.abs(π - πMoon) < 0.001).toBeTrue()
	})

	describe('RA, Dec of Mars', () => {
		// UT at Palomar Observatory on '2003-08-28T03:17:00Z'
		const jd = Julian.calendarGregorianToJD(2003, 8, 28 + toSecondsOfTime(hms(3, 17, 0)) / DAYSEC)
		// lat = 33°.356; lon = 116°.8625; altitude = 1706m
		const lon = hms(7, 47, 27)
		// let ρsφʹ = 0.546861
		// let ρcφʹ = 0.836339
		const [ps, pc] = Globe.EARTH76.parallaxConstants(dms(33, 21, 22), meter(1706))
		// Mars geocentric apparent equatorial coordinates at `jd`
		const marsCoord = [339.530208 * DEG2RAD, -15.771083 * DEG2RAD, 0.37276] as const

		test('topocentric', () => {
			// Example 40.a, p. 280
			const [ra, dec] = Parallax.topocentric(...marsCoord, ps, pc, lon, jd)
			expect(formatRA(ra)).toBe('22 38 08.54')
			expect(formatALT(dec)).toBe('-15 46 30.04')
		})

		test('topocentric2', () => {
			// Example 40.a, p. 280
			const [ra, dec] = Parallax.topocentric2(...marsCoord, ps, pc, lon, jd)
			strictEqual(toArcsec(ra) / 15, 1.29, 2)
			strictEqual(toArcsec(dec), -14.14, 2)
		})

		test('topocentric3', () => {
			// same test case as example 40.a, p. 280
			// reference result
			const [ra, dec] = Parallax.topocentric(...marsCoord, ps, pc, lon, jd)
			// result to test
			const [a, b] = Parallax.topocentric3(...marsCoord, ps, pc, lon, jd)
			// test
			const θ0 = secondsOfTime(Sidereal.apparent(jd))
			const err = Math.abs(normalizeAngle(a - (θ0 - lon - ra) + 1) - 1)
			expect(err < 1e-15).toBeTrue()
			expect(Math.abs(b - dec) < 1e-15).toBeTrue()
		})
	})

	test('topocentricEcliptical', () => {
		// exercise, p. 282
		const [l, b, s] = Parallax.topocentricEcliptical(dms(181, 46, 22.5), dms(2, 17, 26.2), dms(0, 16, 15.5), dms(50, 5, 7.8), 0, dms(23, 28, 0.8), dms(209, 46, 7.9), dms(0, 59, 27.7))
		let err = Math.abs(l - dms(181, 48, 5))
		expect(err < 0.1 * ASEC2RAD).toBeTrue()
		err = Math.abs(b - dms(1, 29, 7.1))
		expect(err < 0.1 * ASEC2RAD).toBeTrue()
		err = Math.abs(s - dms(0, 16, 25.5))
		expect(err < 0.1 * ASEC2RAD).toBeTrue()
	})
})

describe('Illuminated', () => {
	test('aligned planetary phase angles and fractions remain physical under roundoff', () => {
		for (const r of [0.1, 0.3, 0.7]) {
			expect(Illuminated.phaseAngle(r, r + 1, 1)).toBeCloseTo(0, 7)
			expect(Illuminated.fraction(r, r + 1, 1)).toBeCloseTo(1, 14)
			expect(Illuminated.fraction(r, 1 - r, 1)).toBeCloseTo(0, 14)
		}
		expect(Illuminated.phaseAngle2(0, 0, 1.1, 0, 1, 0.1)).toBeCloseTo(0, 14)
		const b = 0.0002
		expect(Illuminated.phaseAngle3(0, b, Math.cos(b), 0, Math.sin(b), 1)).toBeCloseTo(0, 14)
	})

	test('phaseAngle', () => {
		// Example 41.a, p. 284
		const i = Illuminated.phaseAngle(0.724604, 0.910947, 0.983824)
		strictEqual(Math.cos(i), 0.29312, 5)
	})

	test('fraction', () => {
		// Example 41.a, p. 284
		const k = Illuminated.fraction(0.724604, 0.910947, 0.983824)
		strictEqual(k, 0.647, 3)
	})

	test('phaseAngle2', () => {
		// Example 41.a, p. 284
		const i = Illuminated.phaseAngle2(deg(26.10588), deg(-2.62102), 0.724604, deg(88.35704), 0.983824, 0.910947)
		strictEqual(Math.cos(i), 0.29312, 5)
	})

	test('phaseAngle3', () => {
		// Example 41.a, p. 284
		const i = Illuminated.phaseAngle3(deg(26.10588), deg(-2.62102), 0.621794, -0.664905, -0.033138, 0.910947)
		strictEqual(Math.cos(i), 0.29312, 5)
	})

	test('fractionVenus', () => {
		// Example 41.b, p. 284
		const k = Illuminated.fractionVenus(2448976.5)
		strictEqual(k, 0.64, 3)
	})

	test('venus', () => {
		// Example 41.c, p. 285
		const v = Illuminated.venus(0.724604, 0.910947, deg(72.96))
		strictEqual(v, -3.8, 1)
	})

	test('saturn', () => {
		// Example 41.d, p. 285
		const v = Illuminated.saturn(9.867882, 10.464606, deg(16.442), deg(4.198))
		strictEqual(v, 0.9, 1)
	})

	test('venus84', () => {
		// modified Example 41.c, p. 285
		const v = Illuminated.venus84(0.724604, 0.910947, deg(72.96))
		strictEqual(v, -4.2, 1)
	})

	test('saturn84', () => {
		// modified Example 41.d, p. 285
		const v = Illuminated.saturn84(9.867882, 10.464606, deg(16.442), deg(4.198))
		strictEqual(v, 0.7, 1)
	})
})

describe('Moon Position', () => {
	test('position', () => {
		// Example 47.a, p. 342.
		const jde = Julian.calendarGregorianToJD(1992, 4, 12)
		const res = MoonPosition.position(jde)
		strictEqual(toDeg(res[0]), 133.162655, 6)
		strictEqual(toDeg(res[1]), -3.229126, 6)
		strictEqual(toKilometer(res[2]), 368409.7, 1)
	})
})

describe('MoonIlluminated', () => {
	test('approximate equatorial phase remains finite for aligned inclined directions', () => {
		const latitude = 0.0002
		expect(MoonIlluminated.phaseAngleEquatorial2([0, latitude], [0, latitude])).toBeCloseTo(PI, 14)
		expect(MoonIlluminated.phaseAngleEquatorial2([PI, -latitude], [0, latitude])).toBeCloseTo(0, 14)
	})

	test('aligned Moon and Sun preserve new and full phase quadrants', () => {
		const distance = meter(384400000)
		for (const phase of [MoonIlluminated.phaseAngleEquatorial, MoonIlluminated.phaseAngleEcliptic]) {
			const newMoon = phase([0, 0, distance], [0, 0, 1])
			const fullMoon = phase([PI, 0, distance], [0, 0, 1])
			expect(newMoon).toBeCloseTo(PI, 14)
			expect(Base.illuminated(newMoon)).toBeCloseTo(0, 14)
			expect(fullMoon).toBeCloseTo(0, 14)
			expect(Base.illuminated(fullMoon)).toBeCloseTo(1, 14)
			expect(phase([1e-6, 0, distance], [0, 0, 1])).toBeCloseTo(PI, 5)
		}
	})

	const j = Julian.calendarGregorianToJD(1992, 4, 12)

	test('phaseAngleEquatorial', () => {
		const i = MoonIlluminated.phaseAngleEquatorial([134.6885 * DEG2RAD, 13.7684 * DEG2RAD, 368410], [20.6579 * DEG2RAD, 8.6964 * DEG2RAD, 149971520])
		strictEqual(toDeg(i), 69.0756, 4)
	})

	test('phaseAngleEquatorial2', () => {
		const i = MoonIlluminated.phaseAngleEquatorial2([134.6885 * DEG2RAD, 13.7684 * DEG2RAD], [20.6579 * DEG2RAD, 8.6964 * DEG2RAD])
		const k = Base.illuminated(i)
		strictEqual(k, 0.6775, 4)
	})

	test('phaseAngleEcliptic', () => {
		const pos = MoonPosition.position(j)
		// const T = Base.j2000Century(j)
		const λ0 = 0.3898991881696717 // Solar.apparentLongitude(T)
		const R = 1.0024972371630392 // Solar.radius(T)
		const i = MoonIlluminated.phaseAngleEcliptic(pos, [λ0, 0, R])
		const ref = deg(69.0756)
		const err = Math.abs((i - ref) / ref)
		expect(err < 1e-4).toBeTrue()
	})

	test('phaseAngleEcliptic2', () => {
		const pos = MoonPosition.position(j)
		const λ0 = 0.3898991881696717 // Solar.apparentLongitude(Base.j2000Century(j))
		const i = MoonIlluminated.phaseAngleEcliptic2(pos, [λ0, 0])
		const k = Base.illuminated(i)
		const err = Math.abs(k - 0.6775)
		expect(err < 1e-4).toBeTrue()
	})

	test('phaseAngle3', () => {
		const i = MoonIlluminated.phaseAngle3(j)
		const k = Base.illuminated(i)
		strictEqual(toDeg(i), 68.88, 2)
		strictEqual(k, 0.6801, 4)
	})
})

describe('Semidiameter', () => {
	test('asteroid semidiameter is its radius divided by distance', () => {
		// 1 AU = 149597870.7 km; a 100 km diameter has a 50 km radius.
		expect(Semidiameter.asteroid(100, 1)).toBeCloseTo(50 / 149597870.7, 18)
		expect(Semidiameter.asteroid(100, 2)).toBeCloseTo(25 / 149597870.7, 18)
	})

	test('asteroidDiameter', () => {
		strictEqual(Semidiameter.asteroidDiameter(26.76, 0.15), 0.015, 3)
	})
})

describe('Stellar', () => {
	test('sum', () => {
		// Example 56.a, p. 393
		const res = Stellar.sum(1.96, 2.89)
		strictEqual(res, 1.58, 2)
	})

	test('sumN triple', () => {
		// Example 56.b, p. 394
		const res = Stellar.sumN([4.73, 5.22, 5.6])
		strictEqual(res, 3.93, 2)
	})

	test('sumN cluster', () => {
		// Example 56.c, p. 394
		const c: number[] = []

		for (let i = 0; i < 4; i++) c.push(5)
		for (let i = 0; i < 14; i++) c.push(6)
		for (let i = 0; i < 23; i++) c.push(7)
		for (let i = 0; i < 38; i++) c.push(8)

		const res = Stellar.sumN(c)
		strictEqual(res, 2.02, 2)
	})

	test('ratio', () => {
		// Example 56.d, p. 395
		const res = Stellar.ratio(0.14, 2.12)
		strictEqual(res, 6.19, 2)
	})

	test('difference', () => {
		// Example 56.e, p. 395
		const res = Stellar.difference(500)
		strictEqual(res, 6.75, 2)
	})
})

describe('BinaryStars', () => {
	test('position', () => {
		// Example 57.1, p. 398
		const M = BinaryStars.meanAnomaly(1980, 1934.008, 41.623)
		const E = Kepler.kepler1(0.2763, M, 6)
		const a = BinaryStars.position(0.907, 0.2763, deg(59.025), deg(23.717), deg(219.907), E)
		strictEqual(toDeg(M), 37.788, 3)
		strictEqual(toDeg(a[0]), 318.4, 1)
		strictEqual(a[1], 0.411, 3)
	})

	test('apparentEccentricity', () => {
		// Example 57.b, p. 400
		const res = BinaryStars.apparentEccentricity(0.2763, deg(59.025), deg(219.907))
		strictEqual(res, 0.86, 3)
	})
})

describe('Sundial', () => {
	for (const latitude of [80, -80] as const) {
		test('polar sundial excludes winter shadows at latitude ' + latitude, () => {
			const result = Sundial.equatorial(deg(latitude), 1)
			const summer = latitude > 0 ? result.north : result.south
			const winter = latitude > 0 ? result.south : result.north
			expect(winter).toEqual([])
			expect(summer).toHaveLength(24)
			for (const line of summer) expect(line.points).toHaveLength(3)
		})

		test('polar planar sundials omit below-horizon rays at latitude ' + latitude, () => {
			const phi = deg(latitude)
			const horizontal = Sundial.horizontal(phi, 1)
			const general = Sundial.general(phi, deg(20), 1, 0)
			// Horizontal and general-horizontal planes must agree; at midnight only the three summer rays exist.
			expect(horizontal.lines.find((l) => l.hour === 0)?.points).toHaveLength(3)
			expect(general.lines.find((l) => l.hour === 0)?.points).toHaveLength(3)
			// A wall facing the winter noon Sun would be illuminated if the horizon filter were absent.
			const vertical = Sundial.vertical(phi, deg(latitude > 0 ? 0 : 180), 1)
			expect(vertical.lines.find((l) => l.hour === 12)?.points).toHaveLength(4)
		})
	}

	test('general a', () => {
		// Example 58.a, p. 404.0
		const res = Sundial.general(40 * DEG2RAD, 70 * DEG2RAD, 1, 50 * DEG2RAD)

		const hours = res.lines.map(mapHour)
		expect(hours).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19])

		for (const l of res.lines) {
			if (l.hour === 11) {
				strictEqual(l.points[2].x, -2.0007, 4)
				strictEqual(l.points[2].y, -1.1069, 4)
			} else if (l.hour === 14) {
				strictEqual(l.points[6].x, -0.039, 4)
				strictEqual(l.points[6].y, -0.3615, 4)
			}
		}

		strictEqual(res.center.x, 3.388, 4)
		strictEqual(res.center.y, -3.1102, 4)
		strictEqual(toDeg(res.angle), 12.2672, 4)
	})

	test('general b', () => {
		// Example 58.b, p. 404.0
		const res = Sundial.general(-35 * DEG2RAD, 160 * DEG2RAD, 1, 90 * DEG2RAD)

		const hours = res.lines.map(mapHour)
		expect(hours).toEqual([7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18])

		for (const l of res.lines) {
			if (l.hour === 12) {
				strictEqual(l.points[5].x, 0.364, 4)
				strictEqual(l.points[5].y, -0.741, 4)
			} else if (l.hour === 15) {
				strictEqual(l.points[3].x, -0.8439, 4)
				strictEqual(l.points[3].y, -0.9298, 4)
			}
		}

		strictEqual(res.center.x, 0.364, 4)
		strictEqual(res.center.y, 0.7451, 4)
		strictEqual(res.length, 1.2991, 4)
		strictEqual(toDeg(res.angle), 50.3315, 4)
	})

	test('general c', () => {
		// Example 58.c, p. 405.0
		const res = Sundial.general(40 * DEG2RAD, 160 * DEG2RAD, 1, 75 * DEG2RAD)
		const hours = res.lines.map(mapHour)
		expect(hours).toEqual([5, 6, 13, 14, 15, 16, 17, 18, 19])
		strictEqual(res.center.x, 0.3041, 4)
		strictEqual(res.center.y, -0.5043, 4)
		strictEqual(toDeg(res.angle), 59.5062, 4)
	})

	function mapHour(line: Sundial.Line) {
		return line.hour
	}

	function mapPoints(hour: number, lines: readonly Sundial.Line[]) {
		for (const line of lines) {
			if (line.hour === hour) {
				return line.points.flatMap((point) => [roundToNthDecimal(point.x, 4), roundToNthDecimal(point.y, 4)])
			}
		}

		return []
	}

	test('equatorial', () => {
		const res = Sundial.equatorial(40 * DEG2RAD, 1)

		let hours = res.north.map(mapHour)
		expect(hours).toEqual([5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19])
		expect(mapPoints(5, res.north)).toEqual([2.6324, 0.7053, 2.2279, 0.597])
		expect(mapPoints(12, res.north)).toEqual([0, -4.9284, 0, -2.7253, 0, -2.3064])
		expect(mapPoints(19, res.north)).toEqual([-2.6324, 0.7053, -2.2279, 0.597])

		hours = res.south.map(mapHour)
		expect(hours).toEqual([7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17])
		expect(mapPoints(7, res.south)).toEqual([-4.7604, -1.2756])
		expect(mapPoints(12, res.south)).toEqual([0, -2.3064, 0, -2.7253, 0, -4.9284])
		expect(mapPoints(17, res.south)).toEqual([4.7604, -1.2756])
	})

	test('horizontal', () => {
		const res = Sundial.horizontal(40 * DEG2RAD, 1)

		const hours = res.lines.map(mapHour)
		expect(hours).toEqual([5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19])
		expect(mapPoints(5, res.lines)).toEqual([-25.6921, -11.9016, -12.0103, -6.1983])
		expect(mapPoints(12, res.lines)).toEqual([0, 2.0004, 0, 1.7426, 0, 1.2558, 0, 0.8391, 0, 0.5436, 0, 0.361, 0, 0.2974])
		expect(mapPoints(19, res.lines)).toEqual([25.6921, -11.9016, 12.0103, -6.1983])
		strictEqual(res.center.x, 0, 4)
		strictEqual(res.center.y, -1.1918, 4)
		strictEqual(res.length, 1.5557, 4)
	})

	test('vertical', () => {
		const res = Sundial.vertical(40 * DEG2RAD, 70 * DEG2RAD, 1)

		const hours = res.lines.map(mapHour)
		expect(hours).toEqual([11, 12, 13, 14, 15, 16, 17, 18, 19])
		expect(mapPoints(11, res.lines)).toEqual([-11.8933, -5.5746, -14.339, -7.7214, -36.6711, -27.3239])
		expect(mapPoints(15, res.lines)).toEqual([-0.5328, -0.2817, -0.4906, -0.3338, -0.3795, -0.471, -0.226, -0.6606, -0.0511, -0.8766, 0.109, -1.0743, 0.1796, -1.1615])
		expect(mapPoints(19, res.lines)).toEqual([0.995, -0.0498, 1.0836, -0.1091])
		strictEqual(res.center.x, -2.7475, 4)
		strictEqual(res.center.y, 2.4534, 4)
		strictEqual(res.length, 3.8168, 4)
	})
})

describe('Solar', () => {
	const jde = 2448908.5
	const T = Base.j2000Century(jde)

	test('Meeus example 25.a low-order coordinates', () => {
		const [lon, anomaly] = Solar.trueLongitude(T)
		expect(toDeg(lon)).toBeCloseTo(199.90987, 5)
		expect(anomaly).toBeCloseTo(4.83625, 5)
		expect(toDeg(Solar.meanAnomaly(T))).toBeCloseTo(-2241.00603, 5)
		expect(Solar.eccentricity(T)).toBeCloseTo(0.016711668, 9)
		expect(Solar.radius(T)).toBeCloseTo(0.99766, 5)
		expect(toArcsec(Solar.apparentLongitude(T))).toBeCloseTo(199 * 3600 + 54 * 60 + 32, 0)
		const [ra, dec] = Solar.apparentEquatorial(jde)
		expect(toSecondsOfTime(ra)).toBeCloseTo(13 * 3600 + 13 * 60 + 31.4, 1)
		expect(toArcsec(dec)).toBeCloseTo(-(7 * 3600 + 47 * 60 + 6), 0)
	})

	test.concurrent.each([
		['B', 30.749, 1.741, 0.997608521657578],
		['D', 30.748, 1.74, 0.9976085202355945],
	] as const)('VSOP87%s reference for example 25.b', (_, secondsRA, secondsDEC, range) => {
		// Both upstream model fixtures describe the same apparent equatorial position.
		// Our VSOP87E implementation differs from B/D by up to 0.001 s in RA,
		// 0.002 arcsec in declination and 1e-8 AU in range at this epoch.
		const [ra, dec, distance] = Solar.apparentEquatorialVSOP87(jde)
		expect(Math.abs(toSecondsOfTime(ra) - (13 * 3600 + 13 * 60 + secondsRA))).toBeLessThan(0.001)
		expect(Math.abs(toArcsec(dec) + (7 * 3600 + 47 * 60 + secondsDEC))).toBeLessThan(0.002)
		expect(Math.abs(distance - range)).toBeLessThan(1e-8)
		const [lon, lat] = Solar.apparentVSOP87(jde)
		const [dp, de] = Nutation.nutation(jde)
		const eq = Coords.eclipticToEquatorial(lon, lat, Nutation.meanObliquity(jde) + de)
		expect(eq[0]).toBeCloseTo(ra, 14)
		expect(eq[1]).toBeCloseTo(dec, 14)
		expect(lon - Solar.trueVSOP87(jde)[0]).toBeCloseTo(dp + Solar.aberration(distance), 14)
	})

	test('geometric declination is an angle near the solstice', () => {
		const [ra, dec] = Solar.trueEquatorial(Julian.calendarGregorianToJD(2000, 6, 21))
		expect(toDeg(ra)).toBeCloseTo(90, 0)
		expect(toDeg(dec)).toBeCloseTo(23.439, 3)
		const [lon2000, anomaly] = Solar.true2000(T)
		expect(lon2000).toBeCloseTo(Solar.trueLongitude(T)[0] - 1.397 * DEG2RAD * T, 14)
		expect(anomaly).toBe(Solar.trueLongitude(T)[1])
	})
})

describe('SolarXYZ', () => {
	// Meeus examples 26.a/b, Astronomia solarxyz.test.js. Allow 2e-8 AU for the
	// VSOP87E/B difference and rounding of the eight-decimal-place reference vectors.
	test.concurrent.each([
		['of date', SolarXYZ.position, [-0.9379963, -0.3116537, -0.1351207]],
		['J2000', SolarXYZ.positionJ2000, [-0.93739707, -0.31316724, -0.13577841]],
		['B1950', SolarXYZ.positionB1950, [-0.94148805, -0.30266488, -0.13121349]],
	] as const)('%s reference', (_, position, expected) => {
		const p = position(2448908.5)
		for (let i = 0; i < 3; i++) expect(Math.abs(p[i] - expected[i])).toBeLessThan(position === SolarXYZ.position ? 5e-8 : 2e-8)
	})

	test('arbitrary equinox and identity', () => {
		const expected = [-0.933681, -0.32237347, -0.13977803]
		const p = SolarXYZ.positionEquinox(2448908.5, 2044)
		for (let i = 0; i < 3; i++) expect(Math.abs(p[i] - expected[i])).toBeLessThan(2e-8)
		expect(SolarXYZ.positionEquinox(2448908.5, 2000)).toEqual(SolarXYZ.positionJ2000(2448908.5))
	})

	test('ecliptic vector and geometric range', () => {
		const jde = 2448908.5
		const [x, y, z] = SolarXYZ.xyz(jde)
		expect(Math.hypot(x, y, z)).toBeCloseTo(0.997608521657578, 7)
		expect(SolarXYZ.longitudeJ2000(jde)).toBeCloseTo(normalizeAngle(Math.atan2(y, x) - 0.09033 * ASEC2RAD), 14)
		expect(Math.hypot(...SolarXYZ.position(jde))).toBeCloseTo(Math.hypot(x, y, z), 14)
	})
})

describe('EquationOfTime', () => {
	test('Meeus example 28.a', () => {
		// 1992-10-13 00:00 TT; chapter 28, Astronomia eqtime.test.js.
		expect(toSecondsOfTime(EquationOfTime.e(2448908.5))).toBeCloseTo(13 * 60 + 42.6, 1)
		expect(EquationOfTime.eSmart(2448908.5)).toBeCloseTo(0.0598256, 7)
		expect(toSecondsOfTime(EquationOfTime.eSmart(2448908.5))).toBeCloseTo(13 * 60 + 42.7, 1)
	})

	test('continuous across solar longitude wrap', () => {
		const before = EquationOfTime.e(Julian.calendarGregorianToJD(2000, 3, 19))
		const after = EquationOfTime.e(Julian.calendarGregorianToJD(2000, 3, 21))
		expect(Math.abs(toSecondsOfTime(after - before))).toBeLessThan(60)
		expect(toSecondsOfTime(before)).toBeLessThan(0)
		expect(toSecondsOfTime(after)).toBeLessThan(0)
	})
})

describe('SolarDisk', () => {
	test('Meeus chapter 29 orientation', () => {
		const [p, b, l] = SolarDisk.ephemeris(2448908.50068)
		expect(toDeg(p)).toBeCloseTo(26.27, 2)
		expect(toDeg(b)).toBeCloseTo(5.99, 2)
		expect(toDeg(l)).toBeCloseTo(238.63, 2)
	})

	test('Carrington rotation 1699', () => {
		expect(SolarDisk.cycle(1699)).toBeCloseTo(2444480.723, 4)
		expect(SolarDisk.cycle(1699) - Julian.calendarGregorianToJD(1980, 8, 1)).toBeCloseTo(29.22 - 1, 2)
		const period = SolarDisk.cycle(1700) - SolarDisk.cycle(1699)
		expect(period).toBeGreaterThan(27)
		expect(period).toBeLessThan(28)
	})
})

describe('Solstice', () => {
	test('Meeus example 27.a', () => {
		expect(Solstice.june(1962)).toBeCloseTo(2437837.39245, 5)
	})

	// All 40 dynamical dates from Astronomia solstice.test.js (1996-2005).
	test.concurrent.each([
		['march', 1996, Solstice.march, Solstice.march2, 3, 20, 8, 4, 7, 0],
		['march', 1997, Solstice.march, Solstice.march2, 3, 20, 13, 55, 42, 0],
		['march', 1998, Solstice.march, Solstice.march2, 3, 20, 19, 55, 35, 0],
		['march', 1999, Solstice.march, Solstice.march2, 3, 21, 1, 46, 53, 0],
		['march', 2000, Solstice.march, Solstice.march2, 3, 20, 7, 36, 19, 0],
		['march', 2001, Solstice.march, Solstice.march2, 3, 20, 13, 31, 47, 0],
		['march', 2002, Solstice.march, Solstice.march2, 3, 20, 19, 17, 13, 0],
		['march', 2003, Solstice.march, Solstice.march2, 3, 21, 1, 0, 50, 0],
		['march', 2004, Solstice.march, Solstice.march2, 3, 20, 6, 49, 42, 0],
		['march', 2005, Solstice.march, Solstice.march2, 3, 20, 12, 34, 29, 0],
		['june', 1996, Solstice.june, Solstice.june2, 6, 21, 2, 24, 46, PIOVERTWO],
		['june', 1997, Solstice.june, Solstice.june2, 6, 21, 8, 20, 59, PIOVERTWO],
		['june', 1998, Solstice.june, Solstice.june2, 6, 21, 14, 3, 38, PIOVERTWO],
		['june', 1999, Solstice.june, Solstice.june2, 6, 21, 19, 50, 11, PIOVERTWO],
		['june', 2000, Solstice.june, Solstice.june2, 6, 21, 1, 48, 46, PIOVERTWO],
		['june', 2001, Solstice.june, Solstice.june2, 6, 21, 7, 38, 48, PIOVERTWO],
		['june', 2002, Solstice.june, Solstice.june2, 6, 21, 13, 25, 29, PIOVERTWO],
		['june', 2003, Solstice.june, Solstice.june2, 6, 21, 19, 11, 32, PIOVERTWO],
		['june', 2004, Solstice.june, Solstice.june2, 6, 21, 0, 57, 57, PIOVERTWO],
		['june', 2005, Solstice.june, Solstice.june2, 6, 21, 6, 47, 12, PIOVERTWO],
		['september', 1996, Solstice.september, Solstice.september2, 9, 22, 18, 1, 8, PI],
		['september', 1997, Solstice.september, Solstice.september2, 9, 22, 23, 56, 49, PI],
		['september', 1998, Solstice.september, Solstice.september2, 9, 23, 5, 38, 15, PI],
		['september', 1999, Solstice.september, Solstice.september2, 9, 23, 11, 32, 34, PI],
		['september', 2000, Solstice.september, Solstice.september2, 9, 22, 17, 28, 40, PI],
		['september', 2001, Solstice.september, Solstice.september2, 9, 22, 23, 5, 32, PI],
		['september', 2002, Solstice.september, Solstice.september2, 9, 23, 4, 56, 28, PI],
		['september', 2003, Solstice.september, Solstice.september2, 9, 23, 10, 47, 53, PI],
		['september', 2004, Solstice.september, Solstice.september2, 9, 22, 16, 30, 54, PI],
		['september', 2005, Solstice.september, Solstice.september2, 9, 22, 22, 24, 14, PI],
		['december', 1996, Solstice.december, Solstice.december2, 12, 21, 14, 6, 56, 3 * PIOVERTWO],
		['december', 1997, Solstice.december, Solstice.december2, 12, 21, 20, 8, 5, 3 * PIOVERTWO],
		['december', 1998, Solstice.december, Solstice.december2, 12, 22, 1, 57, 31, 3 * PIOVERTWO],
		['december', 1999, Solstice.december, Solstice.december2, 12, 22, 7, 44, 52, 3 * PIOVERTWO],
		['december', 2000, Solstice.december, Solstice.december2, 12, 21, 13, 38, 30, 3 * PIOVERTWO],
		['december', 2001, Solstice.december, Solstice.december2, 12, 21, 19, 22, 34, 3 * PIOVERTWO],
		['december', 2002, Solstice.december, Solstice.december2, 12, 22, 1, 15, 26, 3 * PIOVERTWO],
		['december', 2003, Solstice.december, Solstice.december2, 12, 22, 7, 4, 53, 3 * PIOVERTWO],
		['december', 2004, Solstice.december, Solstice.december2, 12, 21, 12, 42, 40, 3 * PIOVERTWO],
		['december', 2005, Solstice.december, Solstice.december2, 12, 21, 18, 36, 1, 3 * PIOVERTWO],
	] as const)('%s reference for %d', (_, year, approx, refine, month, day, h, m, sec, lon) => {
		const expected = Julian.calendarGregorianToJD(year, month, day) + (h * 3600 + m * 60 + sec) / DAYSEC
		expect(Math.abs(approx(year) - expected) * DAYSEC).toBeLessThan(60)
		const actual = refine(year)
		expect(actual).toBeDefined()
		if (actual === undefined) throw new Error('No event')
		expect(Math.abs(actual - expected) * DAYSEC).toBeLessThan(1.5)
		const error = Solar.apparentVSOP87(actual)[0] - lon
		expect(Math.abs(Math.atan2(Math.sin(error), Math.cos(error)))).toBeLessThan(1e-8)
	})

	// The active full-VSOP87 table upstream spans -4000 to 6500; the commented
	// truncated-series table 27.F has different reference values and is not used.
	test.concurrent.each([
		[-4000, 93.543, 89.189, 89.077, 93.433],
		[-3500, 93.813, 89.534, 88.827, 93.066],
		[-3000, 94.041, 89.917, 88.616, 92.67],
		[-2500, 94.195, 90.33, 88.472, 92.242],
		[-2000, 94.287, 90.764, 88.394, 91.804],
		[-1500, 94.298, 91.198, 88.384, 91.365],
		[-1000, 94.25, 91.63, 88.422, 90.941],
		[-500, 94.134, 92.045, 88.534, 90.521],
		[0, 93.964, 92.45, 88.693, 90.137],
		[500, 93.726, 92.82, 88.913, 89.78],
		[1000, 93.449, 93.148, 89.182, 89.466],
		[1500, 93.117, 93.425, 89.5, 89.201],
		[2000, 92.759, 93.653, 89.84, 88.995],
		[2500, 92.372, 93.811, 90.221, 88.839],
		[3000, 91.976, 93.913, 90.603, 88.749],
		[3500, 91.571, 93.954, 91.004, 88.706],
		[4000, 91.178, 93.934, 91.401, 88.729],
		[4500, 90.788, 93.846, 91.797, 88.816],
		[5000, 90.432, 93.699, 92.154, 88.96],
		[5500, 90.11, 93.493, 92.494, 89.144],
		[6000, 89.827, 93.253, 92.783, 89.382],
		[6500, 89.579, 92.968, 93.043, 89.652],
	] as const)('season lengths in year %d', (year, spring, summer, autumn, winter) => {
		const dates = [Solstice.march2(year), Solstice.june2(year), Solstice.september2(year), Solstice.december2(year), Solstice.march2(year + 1)]
		const expected = [spring, summer, autumn, winter]
		for (let i = 0; i < 4; i++) {
			const from = dates[i]
			const to = dates[i + 1]
			expect(from).toBeDefined()
			expect(to).toBeDefined()
			if (from === undefined || to === undefined) throw new Error('No season boundary')
			expect(Math.abs(to - from - expected[i])).toBeLessThan(0.01)
		}
	})

	// Hong Kong Observatory minute-rounded UTC+08:00 dates reproduced upstream.
	// Convert UTC to TT with the leap-second table; no unfinished Julian class
	// or predicted delta-T polynomial is needed for these historical dates.
	for (const [longitude, ...dates] of [
		[285, '2014-01-05T18:24+0800', '2015-01-06T00:21+0800', '2016-01-06T06:08+0800', '2017-01-05T11:56+0800'],
		[300, '2014-01-20T11:51+0800', '2015-01-20T17:43+0800', '2016-01-20T23:27+0800', '2017-01-20T05:24+0800'],
		[315, '2014-02-04T06:03+0800', '2015-02-04T11:58+0800', '2016-02-04T17:46+0800', '2017-02-03T23:34+0800'],
		[330, '2014-02-19T01:59+0800', '2015-02-19T07:50+0800', '2016-02-19T13:34+0800', '2017-02-18T19:31+0800'],
		[345, '2014-03-06T00:02+0800', '2015-03-06T05:56+0800', '2016-03-05T11:44+0800', '2017-03-05T17:33+0800'],
		[0, '2014-03-21T00:57+0800', '2015-03-21T06:45+0800', '2016-03-20T12:30+0800', '2017-03-20T18:29+0800'],
		[15, '2014-04-05T04:47+0800', '2015-04-05T10:39+0800', '2016-04-04T16:28+0800', '2017-04-04T22:17+0800'],
		[30, '2014-04-20T11:56+0800', '2015-04-20T17:42+0800', '2016-04-19T23:29+0800', '2017-04-20T05:27+0800'],
		[45, '2014-05-05T21:59+0800', '2015-05-06T03:53+0800', '2016-05-05T09:42+0800', '2017-05-05T15:31+0800'],
		[60, '2014-05-21T10:59+0800', '2015-05-21T16:45+0800', '2016-05-20T22:36+0800', '2017-05-21T04:31+0800'],
		[75, '2014-06-06T02:03+0800', '2015-06-06T07:58+0800', '2016-06-05T13:49+0800', '2017-06-05T19:37+0800'],
		[90, '2014-06-21T18:51+0800', '2015-06-22T00:38+0800', '2016-06-21T06:34+0800', '2017-06-21T12:24+0800'],
		[105, '2014-07-07T12:15+0800', '2015-07-07T18:12+0800', '2016-07-07T00:03+0800', '2017-07-07T05:51+0800'],
		[120, '2014-07-23T05:41+0800', '2015-07-23T11:30+0800', '2016-07-22T17:30+0800', '2017-07-22T23:15+0800'],
		[135, '2014-08-07T22:02+0800', '2015-08-08T04:01+0800', '2016-08-07T09:53+0800', '2017-08-07T15:40+0800'],
		[150, '2014-08-23T12:46+0800', '2015-08-23T18:37+0800', '2016-08-23T00:38+0800', '2017-08-23T06:20+0800'],
		[165, '2014-09-08T01:01+0800', '2015-09-08T07:00+0800', '2016-09-07T12:51+0800', '2017-09-07T18:39+0800'],
		[180, '2014-09-23T10:29+0800', '2015-09-23T16:21+0800', '2016-09-22T22:21+0800', '2017-09-23T04:02+0800'],
		[195, '2014-10-08T16:47+0800', '2015-10-08T22:43+0800', '2016-10-08T04:33+0800', '2017-10-08T10:22+0800'],
		[210, '2014-10-23T19:57+0800', '2015-10-24T01:47+0800', '2016-10-23T07:46+0800', '2017-10-23T13:27+0800'],
		[225, '2014-11-07T20:07+0800', '2015-11-08T01:59+0800', '2016-11-07T07:48+0800', '2017-11-07T13:38+0800'],
		[240, '2014-11-22T17:38+0800', '2015-11-22T23:25+0800', '2016-11-22T05:22+0800', '2017-11-22T11:05+0800'],
		[255, '2014-12-07T13:04+0800', '2015-12-07T18:53+0800', '2016-12-07T00:41+0800', '2017-12-07T06:33+0800'],
		[270, '2014-12-22T07:03+0800', '2015-12-22T12:48+0800', '2016-12-21T18:44+0800', '2017-12-22T00:28+0800'],
	] as const) {
		test.concurrent.each(dates)(`solar term ${longitude} degrees at %s`, (date) => {
			const year = Number(date.slice(0, 4))
			const actual = Solstice.longitude(year - (longitude >= 285 ? 1 : 0), deg(longitude))
			expect(actual).toBeDefined()
			if (actual === undefined) throw new Error('No solar term')
			const expected = tt(timeUnix(Date.parse(date) / 1000))
			expect(Math.abs(actual - expected.day - expected.fraction) * DAYSEC).toBeLessThan(31)
		})
	}

	test('early polynomial endpoints and season ordering', () => {
		for (const year of [-1000, 0, 999, 1000, 3000]) {
			const seasons = [Solstice.march(year), Solstice.june(year), Solstice.september(year), Solstice.december(year)]
			for (let i = 1; i < seasons.length; i++) {
				expect(seasons[i] - seasons[i - 1]).toBeGreaterThan(85)
				expect(seasons[i] - seasons[i - 1]).toBeLessThan(96)
			}
		}
	})

	test('arbitrary longitude uses the solar year and wraps negative angles', () => {
		const jde = Solstice.longitude(2000, deg(300))
		expect(jde).toBeDefined()
		if (jde === undefined) throw new Error('No event')
		expect(jde).toBeGreaterThan(Julian.calendarGregorianToJD(2001, 1, 1))
		expect(jde).toBeLessThan(Julian.calendarGregorianToJD(2001, 2, 1))
		expect(Solstice.longitude(2000, deg(-60))).toBeCloseTo(jde, 8)
	})
})

describe('Apparent', () => {
	const jde = Julian.calendarGregorianToJD(2028, 11, 13.19)

	test('Meeus example 23.a corrections', () => {
		const ra = hms(2, 46, 11.331)
		const dec = deg(49 + 20 / 60 + 54.54 / 3600)
		const n = Apparent.nutation(ra, dec, jde)
		const a = Apparent.aberration(ra, dec, jde)
		expect(toArcsec(n[0])).toBeCloseTo(15.843, 3)
		expect(toArcsec(n[1])).toBeCloseTo(6.217, 3)
		expect(toArcsec(a[0])).toBeCloseTo(30.045, 3)
		expect(toArcsec(a[1])).toBeCloseTo(6.697, 3)
	})

	test('Meeus example 23.b Ron-Vondrak correction', () => {
		const result = Apparent.aberrationRonVondrak(hms(2, 44, 12.9747), deg(49 + 13 / 60 + 39.896 / 3600), jde)
		expect(result[0]).toBeCloseTo(0.000145252, 9)
		expect(result[1]).toBeCloseTo(0.000032723, 9)
	})

	test('apparent star positions including proper motion', () => {
		const ra = hms(2, 44, 11.986)
		const dec = deg(49 + 13 / 60 + 42.48 / 3600)
		const epoch = Base.jdeToJulianYear(jde)
		const pmRA = secondsOfTime(0.03425)
		const pmDEC = -0.0895 * ASEC2RAD
		const low = Apparent.position(ra, dec, 2000, epoch, pmRA, pmDEC)
		const rv = Apparent.positionRonVondrak(ra, dec, epoch, pmRA, pmDEC)
		expect(toSecondsOfTime(low[0])).toBeCloseTo(2 * 3600 + 46 * 60 + 14.39, 3)
		expect(toSecondsOfTime(rv[0])).toBeCloseTo(2 * 3600 + 46 * 60 + 14.392, 3)
		expect(toArcsec(low[1])).toBeCloseTo(49 * 3600 + 21 * 60 + 7.45, 2)
		expect(toArcsec(rv[1])).toBeCloseTo(49 * 3600 + 21 * 60 + 7.45, 2)
	})

	test('ecliptic aberration at the equator has zero latitude correction', () => {
		const T = Base.j2000Century(jde)
		const lon = Solar.trueLongitude(T)[0]
		const [dl, db] = Apparent.eclipticAberration(lon, 0, jde)
		expect(db).toBeCloseTo(0, 14)
		expect(dl).toBeLessThan(0)
		expect(Math.abs(toArcsec(dl))).toBeGreaterThan(20)
		expect(Math.abs(toArcsec(dl))).toBeLessThan(21)
	})
})

describe('Elliptic', () => {
	test('Meeus example 33.a apparent Venus', () => {
		const [ra, dec] = Elliptic.position('venus', 2448976.5)
		expect(toSecondsOfTime(ra)).toBeCloseTo(21 * 3600 + 4 * 60 + 41.454, 3)
		expect(toArcsec(dec)).toBeCloseTo(-(18 * 3600 + 53 * 60 + 16.84), 2)
	})
	test('Meeus example 33.b astrometric comet position', () => {
		const orbit = new Elliptic.Elements(2.2091404, 0.8502196, deg(11.94524), deg(186.23352), deg(334.75006), Julian.calendarGregorianToJD(1990, 10, 28.54502))
		const [ra, dec, elongation] = orbit.position(Julian.calendarGregorianToJD(1990, 10, 6))
		expect(toSecondsOfTime(ra)).toBeCloseTo(10 * 3600 + 34 * 60 + 14.2, 1)
		expect(toArcsec(dec)).toBeCloseTo(19 * 3600 + 9 * 60 + 31, 0)
		expect(elongation * RAD2DEG).toBeCloseTo(40.51, 2)
	})
	test('Meeus examples 33.c and 33.d speeds and circumferences', () => {
		const a = 17.9400782
		const e = 0.96727426
		expect(Elliptic.velocity(a, 1)).toBeCloseTo(41.53, 2)
		expect(Elliptic.vPerihelion(a, e)).toBeCloseTo(54.52, 2)
		expect(Elliptic.vAphelion(a, e)).toBeCloseTo(0.91, 2)
		expect(Elliptic.length1(a, e)).toBeCloseTo(77.06, 2)
		expect(Elliptic.length2(a, e)).toBeCloseTo(77.09, 2)
		expect(Elliptic.length4(a, e)).toBeCloseTo(77.07, 2)
	})
	test('circular limit and solar conjunction', () => {
		for (const f of [Elliptic.length1, Elliptic.length2, Elliptic.length4]) expect(f(2, 0)).toBeCloseTo(4 * PI, 14)
		expect(Elliptic.astrometricJ2000(() => [0, 0, 0], Base.J2000)[2]).toBe(0)
		expect(Elliptic.length4(1, 0.999999)).toBeCloseTo(4.00002979, 7)
	})
})

describe('Jupiter', () => {
	test('Meeus example 43.a physical ephemeris', () => {
		const result = Jupiter.physical(2448972.50068)
		const expected = [-2.2, -2.48, 268.06, 72.74, 24.8]
		for (let i = 0; i < expected.length; i++) expect(result[i] * RAD2DEG).toBeCloseTo(expected[i], 2)
	})

	test('Meeus example 43.b approximate ephemeris', () => {
		const result = Jupiter.physical2(2448972.50068)
		const expected = [-2.194, -2.5, 268.12, 72.79]
		for (let i = 0; i < expected.length; i++) expect(result[i] * RAD2DEG).toBeCloseTo(expected[i], i === 0 ? 3 : 2)
	})
})

describe('Mars', () => {
	test('Meeus example 42.a physical ephemeris', () => {
		const result = Mars.physical(2448935.500683)
		const expected = [12.44, -2.76, 111.55, 347.64, 279.91, 10.75, 0.9012, 1.06]
		for (let i = 0; i < expected.length; i++) {
			const factor = i === 6 ? 1 : i === 5 || i === 7 ? RAD2DEG * 3600 : RAD2DEG
			expect(result[i] * factor).toBeCloseTo(expected[i], i === 6 ? 4 : 2)
		}
	})
})

describe('SaturnRing', () => {
	test('Meeus example 45.a', () => {
		const r = SaturnRing.ring(2448972.50068)
		const expected = [16.442, 14.679, 4.198, 6.741]
		for (let i = 0; i < 4; i++) expect(r[i] * RAD2DEG).toBeCloseTo(expected[i], 3)
		expect(toArcsec(r[4])).toBeCloseTo(35.87, 2)
		expect(toArcsec(r[5])).toBeCloseTo(10.15, 2)
		expect(SaturnRing.ub(2448972.50068)).toEqual([r[2], r[0]])
	})

	test('longitude difference stays small across the antimeridian', () => {
		// Saturn's geocentric solar elongation as viewed from Saturn cannot exceed about 7 degrees.
		for (let year = 1995; year <= 2030; year++) {
			const r = SaturnRing.ring(Julian.calendarGregorianToJD(year, 1, 1))
			expect(r[2]).toBeGreaterThanOrEqual(0)
			expect(r[2]).toBeLessThan(deg(8))
			expect(r[5]).toBeLessThanOrEqual(r[4])
		}
	})
})

describe('JupiterMoons', () => {
	test('Meeus chapter 44 approximate positions', () => {
		const result = JupiterMoons.positions(2448972.50068)
		const expected = [
			[-3.44, 0.21, -4.82],
			[7.44, 0.25, -5.74],
			[1.24, 0.65, -14.94],
			[7.08, 1.1, -25.22],
		]
		for (let i = 0; i < 4; i++) for (let j = 0; j < 3; j++) expect(result[i][j]).toBeCloseTo(expected[i][j], 2)
	})

	test('Meeus chapter 44 E5 positions and output reuse', () => {
		const result = JupiterMoons.positions(2448972.50068)
		expect(JupiterMoons.e5(2448972.50068, result)).toBe(result)
		const expected = [
			[-3.4503, 0.2137, -4.8189],
			[7.4418, 0.2752, -5.7472],
			[1.201, 0.59, -14.9406],
			[7.072, 1.029, -25.2244],
		]
		// VSOP87E and a common reception-time FK5 frame differ slightly from the original VSOP87B example.
		for (let i = 0; i < 4; i++) for (let j = 0; j < 3; j++) expect(Math.abs(result[i][j] - expected[i][j])).toBeLessThan(0.0001)
	})

	test.concurrent.each([
		['approximate Ganymede', JupiterMoons.positions, JupiterMoons.GANYMEDE, 7, 28, [-0.0016, -0.8424, -14.9444]],
		['approximate Callisto', JupiterMoons.positions, JupiterMoons.CALLISTO, 5, 15, [0.0555, 1.4811, 26.2743]],
		['E5 Ganymede', JupiterMoons.e5, JupiterMoons.GANYMEDE, 7, 28, [0.0032, -0.8042, -14.9433]],
		['E5 Callisto', JupiterMoons.e5, JupiterMoons.CALLISTO, 5, 15, [0.0002, 1.399, 26.2732]],
	] as const)('Meeus conjunction exercise: %s', (_, position, index, h, m, expected) => {
		// Astronomia jupitermoons.test.js, exercise p. 314. Times are UT;
		// TT-UT is approximately 56 seconds in November 1988.
		const jde = Julian.calendarGregorianToJD(1988, 11, 23) + (h * 3600 + m * 60 + 56) / DAYSEC
		const result = position(jde)[index]
		for (let i = 0; i < 3; i++) expect(result[i]).toBeCloseTo(expected[i], 4)
	})
})

describe('SaturnMoons', () => {
	test('Meeus example 46.a all eight satellite positions', () => {
		const result = SaturnMoons.positions(2451439.50074)
		const expected = [
			[3.102, -0.204, 0.295],
			[3.823, 0.318, -0.833],
			[4.027, -1.061, 2.545],
			[-5.365, -1.148, 3.004],
			[-0.972, -3.136, 8.08],
			[14.568, 4.738, -12.755],
			[-18.001, -5.328, 15.121],
			[-48.76, 4.137, 32.738],
		]
		expect(result).toHaveLength(8)
		for (let i = 0; i < 8; i++) for (let j = 0; j < 3; j++) expect(result[i][j]).toBeCloseTo(expected[i][j], 3)
		expect(result[SaturnMoons.RHEA][0]).toBeCloseTo(-0.972, 3)
	})

	test('ring plane crossing produces finite coordinates for each satellite', () => {
		for (const jde of [2451545, 2455078.5, 2460757.5]) {
			const p = SaturnMoons.positions(jde)
			expect(p).toHaveLength(8)
			for (const v of p) {
				for (const c of v) expect(Number.isFinite(c)).toBe(true)
				expect(Math.hypot(...v)).toBeGreaterThan(2)
				expect(Math.hypot(...v)).toBeLessThan(65)
			}
		}
	})
})

describe('Moon', () => {
	test('Meeus example 53.a physical ephemeris', () => {
		const [libration, pole, sun] = Moon.physical(Julian.calendarGregorianToJD(1992, 4, 12))
		expect(libration[0] * RAD2DEG).toBeCloseTo(-1.23, 2)
		expect(libration[1] * RAD2DEG).toBeCloseTo(4.2, 2)
		expect(pole * RAD2DEG).toBeCloseTo(15.08, 2)
		expect(sun[0] * RAD2DEG).toBeCloseTo(67.9, 2)
		expect(sun[1] * RAD2DEG).toBeCloseTo(1.46, 2)
		expect(Moon.sunAltitude(Moon.selenographic.copernicus, sun) * RAD2DEG).toBeCloseTo(2.318, 3)
	})

	test('Meeus example 53.c sunrise at Copernicus', () => {
		const jde = Moon.sunrise(Moon.selenographic.copernicus, Julian.calendarGregorianToJD(1992, 4, 12))
		const expected = Julian.calendarGregorianToJD(1992, 4, 11.806921077892184)
		// Astronomia moon.test.js uses VSOP87B; allow 0.01 s for our VSOP87E solar position.
		expect(Math.abs(jde - expected) * DAYSEC).toBeLessThan(0.01)
		expect(Math.abs(Moon.sunAltitude(Moon.selenographic.copernicus, Moon.physical(jde)[2]))).toBeLessThan(deg(0.001))
	})

	test('sunset correction and altitude extrema', () => {
		const site = Moon.selenographic.copernicus
		const jde = Moon.sunset(site, Julian.calendarGregorianToJD(1992, 4, 26.5))
		const h = (t: number) => Moon.sunAltitude(site, Moon.physical(t)[2])
		expect(Math.abs(h(jde))).toBeLessThan(deg(0.01))
		expect(h(jde - 0.01)).toBeGreaterThan(h(jde + 0.01))
		expect(Moon.sunAltitude([0, 0], [0, 0])).toBeCloseTo(PI / 2, 14)
		expect(Moon.sunAltitude([PI, 0], [0, 0])).toBeCloseTo(-PI / 2, 14)
		expect(Moon.sunAltitude([0, PI / 2], [0, PI / 2])).toBeCloseTo(PI / 2, 14)
	})
})

describe('Perihelion', () => {
	test('Meeus examples 38.a and 38.b polynomial estimates', () => {
		expect(Perihelion.perihelion('venus', 1978.79)).toBeCloseTo(2443873.704, 3)
		expect(Perihelion.aphelion('mars', 2032.5)).toBeCloseTo(2463530.456, 3)
	})

	// All six calendar-time assertions in Astronomia perihelion.test.js.
	// These are TT calendar labels, not UTC instants; retain millisecond rounding.
	test.concurrent.each([
		['venus', false, 1978.79, 1978, 12, 31, 4, 54, 11.688],
		['mars', true, 2032.5, 2032, 10, 24, 22, 57, 15.702],
		['jupiter', true, 1981.5, 1981, 7, 19, 4, 39, 38.178],
		['saturn', false, 1944.5, 1944, 7, 30, 4, 33, 17.683],
		['embary', false, 1990, 1990, 1, 3, 9, 51, 19.604],
		['earth', false, 1990, 1990, 1, 4, 16, 6, 49.591],
	] as const)('%s polynomial estimate (aphelion=%p) for %f', (planet, ap, year, y, m, d, h, min, sec) => {
		const actual = ap ? Perihelion.aphelion(planet, year) : Perihelion.perihelion(planet, year)
		const expected = Julian.calendarGregorianToJD(y, m, d) + (h * 3600 + min * 60 + sec) / DAYSEC
		expect(Math.abs(actual - expected) * DAYSEC).toBeLessThan(0.001)
	})

	// Upstream JS2: Jupiter 1981-07-28 06:08:00.824 TT and Saturn 1944-09-08 02:34:29.611 TT.
	// Independent analytic radial-velocity roots explain the model displacement:
	// VSOP87B R-series roots are 2444813.755569 and 2431341.607300; VSOP87E
	// heliocentric dot(position, velocity) roots are the E values in this table.
	test.concurrent.each([
		['jupiter', true, 1981.5, 2444813.7555650924, 2444813.7572116987, 0.002],
		['saturn', false, 1944.5, 2431341.6072871643, 2431341.5874451827, 0.021],
	] as const)('%s refined JS2 reference', (planet, ap, year, referenceB, referenceE, modelTolerance) => {
		const result = ap ? Perihelion.aphelion2(planet, year, 0.0004) : Perihelion.perihelion2(planet, year, 0.0004)
		expect(result).toBeDefined()
		if (!result) throw new Error('No apsis')
		expect(Math.abs(result[0] - referenceB)).toBeLessThan(modelTolerance)
		expect(Math.abs(result[0] - referenceE)).toBeLessThan(0.001)
	})

	// Complete outer-planet tables, including every optional SLOWTESTS row.
	// The synchronous bounded search replaces the upstream callback-based crawl.
	test.concurrent.each([
		['saturn', 'a', 1929, 11, 11, 10.0467],
		['saturn', 'p', 1944, 9, 8, 9.0288],
		['saturn', 'a', 1959, 5, 29, 10.0664],
		['saturn', 'p', 1974, 1, 8, 9.0153],
		['saturn', 'a', 1988, 9, 11, 10.0444],
		['saturn', 'p', 2003, 7, 26, 9.0309],
		['saturn', 'a', 2018, 4, 17, 10.0656],
		['saturn', 'p', 2032, 11, 28, 9.0149],
		['saturn', 'a', 2047, 7, 15, 10.0462],
		['uranus', 'a', 1756, 11, 27, 20.0893],
		['uranus', 'p', 1798, 3, 3, 18.289],
		['uranus', 'a', 1841, 3, 16, 20.0976],
		['uranus', 'p', 1882, 3, 23, 18.2807],
		['uranus', 'a', 1925, 4, 1, 20.0973],
		['uranus', 'p', 1966, 5, 21, 18.2848],
		['uranus', 'a', 2009, 2, 27, 20.0989],
		['uranus', 'p', 2050, 8, 17, 18.283],
		['uranus', 'a', 2092, 11, 23, 20.0994],
		['neptune', 'p', 1876, 8, 28, 29.8148],
		['neptune', 'a', 1959, 7, 13, 30.3317],
		['neptune', 'p', 2042, 9, 5, 29.8064],
	] as const)('%s %s in %d', (planet, apsis, y, m, d, r) => {
		const ap = apsis === 'a'
		const year = y + (m - 0.5) / 12
		const result = ap ? Perihelion.aphelion2(planet, year, 0.0004) : Perihelion.perihelion2(planet, year, 0.0004)

		expect(result).toBeDefined()
		if (!result) throw new Error('No apsis')
		const midnight = Julian.calendarGregorianToJD(y, m, d)

		if (planet === 'neptune' && ap) {
			// B's maximum is JD 2436763.286705; E's analytic radial-velocity zero is
			// 2436763.856579. Their radii differ by just 8.2e-8 AU at the flat maximum.
			expect(Math.abs(result[0] - 2436763.286705)).toBeLessThan(0.58)
			expect(Math.abs(result[0] - 2436763.856579)).toBeLessThan(0.001)
		} else if (planet === 'uranus' && y === 1882) {
			// B's R-series derivative vanishes at 2408528.411030 (March 23 TT).
			// E's heliocentric radial velocity vanishes at 2408528.514531 (March 24 TT).
			// The radius displacement is 3.65e-7 AU; preserve both model references.
			expect(Math.abs(result[0] - 2408528.41103)).toBeLessThan(0.105)
			expect(Math.abs(result[0] - 2408528.514531)).toBeLessThan(0.001)
		} else {
			expect(result[0]).toBeGreaterThanOrEqual(midnight)
			expect(result[0]).toBeLessThan(midnight + 1)
		}

		expect(Math.abs(result[1] - r)).toBeLessThan(0.0001)

		for (const dt of [-1, 1]) {
			const nearby = PlanetPosition.position2000(planet, result[0] + dt)[2]
			if (ap) expect(result[1]).toBeGreaterThan(nearby)
			else expect(result[1]).toBeLessThan(nearby)
		}
	})

	// Complete 1991-2010 Earth table, including SLOWTESTS: time in TT decimal hours,
	// range in AU, with the original 0.01-hour and 1e-6-AU tolerances.
	test.concurrent.each([
		['p', 1991, 1, 3, 3, 0.983281],
		['p', 1992, 1, 3, 15.06, 0.983324],
		['p', 1993, 1, 4, 3.08, 0.983283],
		['p', 1994, 1, 2, 5.92, 0.983301],
		['p', 1995, 1, 4, 11.1, 0.983302],
		['p', 1996, 1, 4, 7.43, 0.983223],
		['p', 1997, 1, 1, 23.29, 0.983267],
		['p', 1998, 1, 4, 21.27, 0.9833],
		['p', 1999, 1, 3, 13.02, 0.983281],
		['p', 2000, 1, 3, 5.31, 0.983321],
		['p', 2001, 1, 4, 8.89, 0.983286],
		['p', 2002, 1, 2, 14.17, 0.98329],
		['p', 2003, 1, 4, 5.04, 0.98332],
		['p', 2004, 1, 4, 17.72, 0.983265],
		['p', 2005, 1, 2, 0.61, 0.983297],
		['p', 2006, 1, 4, 15.52, 0.983327],
		['p', 2007, 1, 3, 19.74, 0.98326],
		['p', 2008, 1, 2, 23.87, 0.98328],
		['p', 2009, 1, 4, 15.51, 0.983273],
		['p', 2010, 1, 3, 0.18, 0.98329],
		['a', 1991, 7, 6, 15.46, 1.016703],
		['a', 1992, 7, 3, 12.14, 1.01674],
		['a', 1993, 7, 4, 22.37, 1.016666],
		['a', 1994, 7, 5, 19.3, 1.016724],
		['a', 1995, 7, 4, 2.29, 1.016742],
		['a', 1996, 7, 5, 19.02, 1.016717],
		['a', 1997, 7, 4, 19.34, 1.016754],
		['a', 1998, 7, 3, 23.86, 1.016696],
		['a', 1999, 7, 6, 22.86, 1.016718],
		['a', 2000, 7, 3, 23.84, 1.016741],
		['a', 2001, 7, 4, 13.65, 1.016643],
		['a', 2002, 7, 6, 3.8, 1.016688],
		['a', 2003, 7, 4, 5.67, 1.016728],
		['a', 2004, 7, 5, 10.9, 1.016694],
		['a', 2005, 7, 5, 4.98, 1.016742],
		['a', 2006, 7, 3, 23.18, 1.016697],
		['a', 2007, 7, 6, 23.89, 1.016706],
		['a', 2008, 7, 4, 7.71, 1.016754],
		['a', 2009, 7, 4, 1.69, 1.016666],
		['a', 2010, 7, 6, 11.52, 1.016702],
	] as const)('Earth %s in %d', (apsis, y, m, d, h, r) => {
		const year = y + (m - 0.5) / 12
		const result = apsis === 'a' ? Perihelion.aphelion2('earth', year, 0.0004) : Perihelion.perihelion2('earth', year, 0.0004)
		expect(result).toBeDefined()
		if (!result) throw new Error('No apsis')
		const expected = Julian.calendarGregorianToJD(y, m, d) + h / 24
		expect(Math.abs(result[0] - expected) * 24).toBeLessThan(0.01)
		expect(Math.abs(result[1] - r)).toBeLessThan(0.000001)
	})
})

describe('Rise', () => {
	const observer = { lat: deg(42 + 20 / 60), lon: deg(71 + 5 / 60) }
	const jd = Julian.calendarGregorianToJD(1988, 3, 20)
	const ra = [hms(2, 42, 43.25), hms(2, 46, 55.51), hms(2, 51, 7.69)] as const
	const dec = [deg(18 + 2 / 60 + 51.4 / 3600), deg(18 + 26 / 60 + 27.3 / 3600), deg(18 + 49 / 60 + 38.7 / 3600)] as const

	test('standard altitudes and replacing atmospheric refraction', () => {
		expect(Rise.STDH0.stellar).toBeCloseTo(deg(-0.5666666666666667), 15)
		expect(Rise.stdh0Stellar()).toBe(-Rise.MEAN_REFRACTION)
		expect(Rise.stdh0Solar()).toBeCloseTo(-0.01454441043328608, 15)
		expect(Rise.stdh0LunarMean()).toBe(deg(0.125))
		expect(Rise.STDH0.lunar).toBe(0.7275)
		expect(Rise.stdh0Stellar(0)).toBe(0)
		expect(Rise.stdh0Stellar(deg(1))).toBeCloseTo(deg(-1), 15)
		expect(Rise.stdh0Solar(Rise.MEAN_REFRACTION)).toBeCloseTo(Rise.stdh0Solar(), 15)
		expect(Rise.stdh0LunarMean(0)).toBeCloseTo(deg(0.125) + Rise.MEAN_REFRACTION, 15)
	})

	test.concurrent.each([359861, 405948, (359861 + 405948) / 2])('lunar altitude at %f km', (km) => {
		// Meeus p. 101, independently stated in Sonia Keys' rise.Stdh0Lunar.
		// Astronomia's tests accidentally convert the dimensionless 0.7275 coefficient to radians.
		const parallax = Math.asin(6378.14 / km)
		expect(Rise.stdh0Lunar(parallax)).toBeCloseTo(0.7275 * parallax - deg(34 / 60), 15)
		expect(Rise.stdh0Lunar(parallax, 0)).toBeCloseTo(0.7275 * parallax, 15)
		expect(toDeg(Rise.stdh0Lunar(parallax))).toBeGreaterThan(0.08)
	})

	test('Meeus 15.a approximate and refined reference times', () => {
		const theta = Sidereal.apparent0UT(jd)
		const approx = Rise.approxTimes(observer, Rise.stdh0Stellar(), theta, ra[1], dec[1])
		const precise = Rise.times(observer, Julian.deltaTSeconds(new Julian.Calendar().fromJD(jd).toYear()), Rise.stdh0Stellar(), theta, ra, dec)
		expect(approx.state).toBe('normal')
		expect(precise.state).toBe('normal')
		if (approx.state !== 'normal' || precise.state !== 'normal') throw new Error('No crossing')
		expect(approx.rise / DAYSEC).toBeCloseTo(0.51816, 5)
		expect(approx.transit / DAYSEC).toBeCloseTo(0.81965, 5)
		expect(approx.set / DAYSEC).toBeCloseTo(0.12113, 5)
		expect(precise.rise).toBeCloseTo(12 * 3600 + 25 * 60 + 26, 0)
		expect(precise.transit).toBeCloseTo(19 * 3600 + 40 * 60 + 30, 0)
		expect(precise.set).toBeCloseTo(2 * 3600 + 54 * 60 + 40, 0)
	})

	test.concurrent.each([
		['approxTimes', ['1988-03-20T12:26:09.270Z', '1988-03-20T19:40:17.578Z', '1988-03-20T02:54:25.885Z']],
		['times', ['1988-03-20T12:25:25.629Z', '1988-03-20T19:40:30.555Z', '1988-03-20T02:54:40.159Z']],
	] as const)('PlanetRise %s upstream Venus reference', (method, dates) => {
		// The VSOP87B fixtures use a different delta-T model and apply it twice in times().
		// Our TT-midnight samples and VSOP87E positions retain subsecond agreement.
		const result = new Rise.PlanetRise(jd, observer.lat, observer.lon, 'venus')[method]()
		const dateResult = new Rise.PlanetRise(new Date('1988-03-20T14:00:00Z'), observer.lat, observer.lon, 'venus', { date: true })[method]()
		if (result.state !== 'normal' || dateResult.state !== 'normal') throw new Error('No crossing')
		for (const [i, key] of (['rise', 'transit', 'set'] as const).entries()) {
			const value = result[key]
			const date = dateResult[key]
			if (typeof value !== 'number' || !(date instanceof Date)) throw new Error('Wrong representation')
			expect(Math.abs(value - Julian.dateToJD(new Date(dates[i]))) * DAYSEC).toBeLessThan(1)
			expect(date.getTime()).toBe(Julian.jdToDate(value).getTime())
		}
	})

	test('planetary crossings apply delta-T exactly once', () => {
		try {
			// Amplify TT-UT to expose accidental double application in the three-day samples.
			Julian.setDeltaTProvider(() => 3600)
			const result = new Rise.PlanetRise(jd, observer.lat, observer.lon, 'venus').times()
			if (result.state !== 'normal') throw new Error('No crossing')
			for (const key of ['rise', 'set'] as const) {
				const event = result[key]
				if (typeof event !== 'number') throw new Error('Expected JD')
				const [ra, dec] = Elliptic.position('venus', event + 3600 / DAYSEC)
				const H = (Sidereal.apparent(event) * TAU) / DAYSEC - observer.lon - ra
				const altitude = Math.asin(Math.sin(observer.lat) * Math.sin(dec) + Math.cos(observer.lat) * Math.cos(dec) * Math.cos(H))
				expect(Math.abs(toArcsec(altitude - Rise.stdh0Stellar()))).toBeLessThan(1)
			}
		} finally {
			Julian.setDeltaTProvider()
		}
	})

	test('polar and grazing horizons return explicit states', () => {
		expect(Rise.hourAngle(deg(80), 0, deg(20))).toBe('alwaysAbove')
		expect(Rise.hourAngle(deg(80), 0, deg(-20))).toBe('alwaysBelow')
		expect(Rise.hourAngle(deg(45), 0, deg(45))).toBe('grazing')
		expect(Rise.hourAngle(deg(45), 0, deg(-45))).toBe('grazing')
		expect(Rise.hourAngle(PI / 2, 0, 0)).toBe('grazing')
		expect(Rise.hourAngle(PI / 2, 0, deg(10))).toBe('alwaysAbove')
		expect(Rise.hourAngle(0, 0, 0)).toBeCloseTo(PI / 2, 15)
		const result = Rise.times({ lat: deg(80), lon: 0 }, 60, 0, 0, [0, 0, 0], [deg(20), deg(20), deg(20)])
		expect(result.state).toBe('alwaysAbove')
		expect(Number.isFinite(result.transit)).toBe(true)
		expect('rise' in result).toBe(false)
	})

	test('right ascension and longitude wrapping preserve event times', () => {
		const p = { lat: deg(30), lon: deg(179) }
		const wrapped = [deg(359), 0, deg(1)] as const
		const unwrapped = [deg(-1), 0, deg(1)] as const
		const dec = [deg(10), deg(10), deg(10)] as const
		const a = Rise.times(p, 60, Rise.stdh0Stellar(), 86000, wrapped, dec)
		const b = Rise.times({ lat: p.lat, lon: p.lon - TAU }, 60, Rise.stdh0Stellar(), 86000, unwrapped, dec)
		if (a.state !== 'normal' || b.state !== 'normal') throw new Error('No crossing')
		for (const key of ['rise', 'transit', 'set'] as const) {
			expect(a[key]).toBeCloseTo(b[key], 8)
			expect(a[key]).toBeGreaterThanOrEqual(0)
			expect(a[key]).toBeLessThan(DAYSEC)
		}
	})
})

describe('Sunrise', () => {
	// All 78 active fixtures from Astronomia sunrise.test.js at.
	// The project S15 delta-T model and normalized UT1/TT conversion differ by less than 0.1 second here.
	for (const [label, date, lat, lon, events] of [
		[
			'northern hemisphere',
			'1935-09-24T00:00:00Z',
			50.7977,
			4.35916,
			[
				['nightEnd', '1935-09-24T03:38:18.262Z'],
				['nauticalDawn', '1935-09-24T04:18:34.713Z'],
				['dawn', '1935-09-24T04:57:20.768Z'],
				['rise', '1935-09-24T05:30:10.710Z'],
				['riseEnd', '1935-09-24T05:33:33.452Z'],
				['goldenHourEnd', '1935-09-24T06:13:35.023Z'],
				['noon', '1935-09-24T11:34:53.328Z'],
				['goldenHourStart', '1935-09-24T16:55:19.587Z'],
				['setStart', '1935-09-24T17:35:15.569Z'],
				['set', '1935-09-24T17:38:37.766Z'],
				['dusk', '1935-09-24T18:11:21.681Z'],
				['nauticalDusk', '1935-09-24T18:49:58.457Z'],
				['nightStart', '1935-09-24T19:30:01.647Z'],
			],
		],
		[
			'in northern polar night',
			'2015-01-01T00:00:00Z',
			78.22236,
			15.65257,
			[
				['nightEnd', '2015-01-01T06:33:13.220Z'],
				['nauticalDawn', '2015-01-01T09:34:31.168Z'],
				['dawn', '2015-01-31T10:11:44.907Z'],
				['rise', '2015-02-16T10:23:28.354Z'],
				['riseEnd', '2015-02-18T10:09:44.989Z'],
				['goldenHourEnd', '2015-03-07T10:04:07.300Z'],
				['noon', '2015-01-01T11:00:48.437Z'],
				['goldenHourStart', '2014-10-07T11:28:04.511Z'],
				['setStart', '2014-10-24T11:30:38.481Z'],
				['set', '2014-10-26T11:13:10.669Z'],
				['dusk', '2014-11-12T11:01:08.845Z'],
				['nauticalDusk', '2015-01-01T12:27:38.115Z'],
				['nightStart', '2015-01-01T15:29:02.898Z'],
			],
		],
		[
			'in northern polar day',
			'2015-06-01T00:00:00Z',
			78.22236,
			15.65257,
			[
				['nightEnd', '2015-03-04T23:28:52.385Z'],
				['nauticalDawn', '2015-03-19T23:42:05.887Z'],
				['dawn', '2015-04-03T23:51:59.979Z'],
				['rise', '2015-04-17T23:50:12.249Z'],
				['riseEnd', '2015-04-19T23:33:48.086Z'],
				['goldenHourEnd', '2015-05-10T23:14:34.642Z'],
				['noon', '2015-06-01T10:55:10.698Z'],
				['goldenHourStart', '2015-08-03T22:03:19.928Z'],
				['setStart', '2015-08-24T21:50:49.943Z'],
				['set', '2015-08-25T22:04:01.888Z'],
				['dusk', '2015-09-09T21:40:24.860Z'],
				['nauticalDusk', '2015-09-24T21:50:06.675Z'],
				['nightStart', '2015-10-10T21:34:35.396Z'],
			],
		],
		[
			'southern hemisphere',
			'2015-02-21T00:00:00Z',
			-44.7787668,
			-65.7178918,
			[
				['nightEnd', '2015-02-21T08:00:34.926Z'],
				['nauticalDawn', '2015-02-21T08:40:43.950Z'],
				['dawn', '2015-02-21T09:18:04.318Z'],
				['rise', '2015-02-21T09:48:50.431Z'],
				['riseEnd', '2015-02-21T09:51:57.843Z'],
				['goldenHourEnd', '2015-02-21T10:28:19.885Z'],
				['noon', '2015-02-21T16:36:30.110Z'],
				['goldenHourStart', '2015-02-21T22:43:55.794Z'],
				['setStart', '2015-02-21T23:20:11.095Z'],
				['set', '2015-02-21T23:23:17.844Z'],
				['dusk', '2015-02-21T23:53:56.555Z'],
				['nauticalDusk', '2015-02-22T00:31:05.190Z'],
				['nightStart', '2015-02-22T01:10:56.478Z'],
			],
		],
		[
			'in southern polar day',
			'2015-12-21T00:00:00Z',
			-77.8460468,
			166.6753,
			[
				['nightEnd', '2015-09-07T13:33:38.473Z'],
				['nauticalDawn', '2015-09-22T13:48:42.893Z'],
				['dawn', '2015-10-08T13:29:23.426Z'],
				['rise', '2015-10-22T13:26:47.879Z'],
				['riseEnd', '2015-10-23T13:40:48.562Z'],
				['goldenHourEnd', '2015-11-13T13:19:49.695Z'],
				['noon', '2015-12-21T00:51:00.379Z'],
				['goldenHourStart', '2016-01-29T12:27:53.315Z'],
				['setStart', '2016-02-19T12:01:27.640Z'],
				['set', '2016-02-20T12:14:26.259Z'],
				['dusk', '2016-03-05T12:06:29.863Z'],
				['nauticalDusk', '2016-03-20T12:11:04.915Z'],
				['nightStart', '2016-04-05T11:51:07.900Z'],
			],
		],
		[
			'in southern polar night',
			'2015-06-21T00:00:00Z',
			-77.8460468,
			166.6753,
			[
				['nightEnd', '2015-06-20T20:32:23.851Z'],
				['nauticalDawn', '2015-06-20T23:32:36.264Z'],
				['dawn', '2015-08-01T00:46:43.715Z'],
				['rise', '2015-08-19T00:35:21.630Z'],
				['riseEnd', '2015-08-21T00:17:34.775Z'],
				['goldenHourEnd', '2015-09-08T00:03:13.503Z'],
				['noon', '2015-06-21T00:54:55.443Z'],
				['goldenHourStart', '2015-04-05T01:43:39.589Z'],
				['setStart', '2015-04-23T01:19:04.778Z'],
				['set', '2015-04-24T01:41:35.328Z'],
				['dusk', '2015-05-12T01:25:36.458Z'],
				['nauticalDusk', '2015-06-21T02:17:12.851Z'],
				['nightStart', '2015-06-21T05:17:24.954Z'],
			],
		],
	] as const) {
		describe(label, () => {
			for (const [method, expected] of events) {
				test(method, () => {
					const sr = new Sunrise.Sunrise(new Julian.Calendar(new Date(date)), deg(lat), deg(-lon))
					const result = sr[method]()
					expect(result).toBeDefined()
					if (!result) throw new Error('Missing solar event')
					expect(Math.abs(result.toDate().getTime() - Date.parse(expected))).toBeLessThan(100)
				})
			}
		})
	}

	test('construction and event calls do not mutate the input calendar', () => {
		const date = new Julian.CalendarGregorian(2015, 2, 21.75)
		const sr = new Sunrise.Sunrise(date, deg(-44.7787668), deg(65.7178918))
		const expected = sr.noon().toJD()
		expect(date.day).toBe(21.75)
		date.day = 1
		sr.noon().midnight()
		expect(sr.noon().toJD()).toBe(expected)
		expect(sr.noon()).not.toBe(sr.noon())
	})

	test('antimeridian noon keeps its adjacent UT1 date', () => {
		const date = new Julian.CalendarGregorian(2015, 11, 3)
		const east = new Sunrise.Sunrise(date, 0, -PI)
		const west = new Sunrise.Sunrise(date, 0, deg(179.9))
		expect(east.noon().getDate()).toEqual({ year: 2015, month: 11, day: 2 })
		expect(east.noon().getTime().hour).toBe(23)
		expect(west.noon().getDate()).toEqual({ year: 2015, month: 11, day: 3 })
		expect(west.noon().getTime().hour).toBe(23)
		expect(new Sunrise.Sunrise(date, 0, 3 * PI).noon().toJD()).toBe(east.noon().toJD())
	})

	test('polar twilight selects direction from altitude rather than the equinox date', () => {
		// At Svalbard astronomical night already ceases before the March equinox.
		const date = new Julian.CalendarGregorian(2015, 3, 10)
		const sr = new Sunrise.Sunrise(date, deg(78.22236), deg(-15.65257))
		const morning = sr.nightEnd()
		const evening = sr.nightStart()
		if (!morning || !evening) throw new Error('No seasonal transition')
		expect(morning.toJD()).toBeLessThan(date.toJD())
		expect(evening.toJD()).toBeGreaterThan(date.toJD())
		expect(morning.month).toBe(3)
		expect(evening.month).toBe(10)
	})

	test('explicit zero refraction affects solar limbs but not geometric twilight', () => {
		const date = new Julian.CalendarGregorian(2015, 2, 21)
		const a = new Sunrise.Sunrise(date, deg(45), 0)
		const b = new Sunrise.Sunrise(date, deg(45), 0, 0)
		const riseA = a.rise(),
			riseB = b.rise(),
			setA = a.set(),
			setB = b.set()
		if (!riseA || !riseB || !setA || !setB) throw new Error('No crossing')
		expect(riseB.toJD()).toBeGreaterThan(riseA.toJD())
		expect(setB.toJD()).toBeLessThan(setA.toJD())
		expect(b.noon().toJD()).toBe(a.noon().toJD())
		expect(b.dawn()?.toJD()).toBe(a.dawn()?.toJD())
		expect(b.goldenHourEnd()?.toJD()).toBe(a.goldenHourEnd()?.toJD())
	})

	test.concurrent.each([-PIOVERTWO, PIOVERTWO])('unresolved diurnal crossing at pole %f', (lat) => {
		const sr = new Sunrise.Sunrise(new Julian.CalendarGregorian(2015, 6, 21), lat, 0)
		expect(sr.rise()).toBeUndefined()
		expect(sr.set()).toBeUndefined()
		expect(Number.isFinite(sr.noon().toJD())).toBe(true)
	})
})
