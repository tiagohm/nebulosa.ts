import { describe, expect, test } from 'bun:test'
import { deg, dms, formatALT, formatRA, hms, normalizeAngle, secondsOfTime, signedDms, toArcsec, toDeg, toDms, toHms, toSecondsOfTime } from '../src/angle'
import { ASEC2RAD, DAYSEC, DEG2RAD, PI, RAD2DEG } from '../src/constants'
import { meter, toKilometer, toMeter } from '../src/distance'
import { modf, roundToNthDecimal } from '../src/math'
import { AngularSeparation, Apsis, Base, BinaryStars, Circle, Conjunction, Coords, ElementEquinox, Fit, Globe, Illuminated, Interpolation, Iteration, Julian, Kepler, Line, MoonPosition, Node, Nutation, Parallax, Planetary, Precession, Refraction, Semidiameter, Sidereal, Stellar } from '../src/meeus'
import { time, timeToDate, timeYMD } from '../src/time'

function strictEqual(actual: number, expected: number, numDigits: number = 12) {
	expect(actual).toBeCloseTo(expected, numDigits)
}

// https://github.com/commenthol/astronomia/blob/master/test/

describe('Base', () => {
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

	// TODO:
	// describe('date', () => {
	// 	const dates = [
	// 		[Base.J2000, new Date('2000-01-01T12:00:00Z')],
	// 		[2451915.5, new Date('2001-01-06T00:00:00Z')],
	// 		[2436116.31, new Date('1957-10-04T19:26:24.000Z')],
	// 		[1842712, new Date('0333-01-27T12:00:00.000Z')],
	// 		[1507900.13, new Date('-000584-05-22T15:07:12.000Z')],
	// 	] as const

	// 	describe('jdToDate', () => {
	// 		for (const date of dates) {
	// 			test(date[0].toFixed(0), () => {
	// 				deepStrictEqual(Julian.jDToDate(date[0]), date[1])
	// 			})
	// 		}
	// 	})

	// 	describe('dateToJD', () => {
	// 		for (const date of dates) {
	// 			test(date[1].toISOString(), () => {
	// 				deepStrictEqual(Base.round(Julian.dateToJD(date[1]), 2), date[0])
	// 			})
	// 		}
	// 	})

	// 	describe('jdeToDate', () => {
	// 		test('conversion', () => {
	// 			// Example 10.a p.78
	// 			const d = new Date('1977-02-18T03:37:40Z') // is in fact a jde
	// 			const jde = Julian.dateToJD(d)
	// 			const res = Julian.jdeToDate(jde)
	// 			strictEqual(res.toISOString(), '1977-02-18T03:36:52.351Z')
	// 		})
	// 	})
	// })

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

		// describe('dayOfYearToCalendar', () => {
		// 	for (const date of dates) {
		// 		const [year, month, day, leap, dayOfYear] = date

		// 		test([year, month, day].join(' '), () => {
		// 			// Example 7.f, p. 65.
		// 			const res = Julian.dayOfYearToCalendar(dayOfYear, leap)
		// 			deepStrictEqual(res, { month, day })
		// 		})
		// 	}
		// })

		// describe('dayOfYearToCalendarGregorian', () => {
		// 	for (const date of dates) {
		// 		const [year, month, day, leap, dayOfYear] = date
		// 		const name = [year, month, day].join(' ')
		// 		test(name, () => {
		// 			// Example 7.f, p. 65.
		// 			const res = Julian.dayOfYearToCalendarGregorian(year, dayOfYear)
		// 			deepStrictEqual(res, new Julian.calendarGregorian(year, month, day))
		// 		})
		// 	}
		// })

		// describe('dayOfYearToCalendarJulian', () => {
		// 	const dates = [
		// 		[1978, 11, 14, false, 318],
		// 		[1988, 4, 22, true, 113],
		// 		[1236, 11, 14, true, 319],
		// 		[750, 11, 14, false, 318],
		// 	] as const

		// 	for (const date of dates) {
		// 		const [year, month, day, leap, dayOfYear] = date

		// 		test([year, month, day].join(' '), () => {
		// 			// Example 7.f, p. 65.
		// 			const res = Julian.dayOfYearToCalendarJulian(year, dayOfYear)
		// 			deepStrictEqual(res, new Julian.calendarJulian(year, month, day))
		// 		})
		// 	}
		// })

		// describe('calendarGregorian.toYear', () => {
		// 	test('1977-02-14', () => {
		// 		const res = new Julian.calendarGregorian(1977, 2, 14).toYear()
		// 		strictEqual(res, 1977.12055, 5)
		// 	})

		//     test('1977-01-01', () => {
		// 		const res = new Julian.calendarGregorian(1977, 1, 1).toYear()
		// 		strictEqual(res, 1977.0, 5)

		//     test('1977-12-31', () => {
		// 		const res = new Julian.calendarGregorian(1977, 12, 31.999).toYear()
		// 		strictEqual(res, 1977.999997260274)
		// 	})
		// })

		// describe('calendarGregorian.fromYear', () => {
		// 	test('1977-02-14', () => {
		// 		const res = new Julian.calendarGregorian().fromYear(1977.12055)
		// 		deepStrictEqual(res.getDate(), { year: 1977, month: 2, day: 14 })
		// 	})

		// 	test('1977-01-01', () => {
		// 		const res = new Julian.calendarGregorian().fromYear(1977.0)
		// 		deepStrictEqual(res.getDate(), { year: 1977, month: 1, day: 1 })
		// 	})

		// 	test('1977-12-31', () => {
		// 		const res = new Julian.calendarGregorian().fromYear(1977.999997260274)
		// 		deepStrictEqual(res.getDate(), { year: 1977, month: 12, day: 31 })

		//     test('1977-02-01', () => {
		// 		const y = new Julian.calendarGregorian(1977, 2, 1).toYear()
		// 		const res = new Julian.calendarGregorian().fromYear(y)
		// 		deepStrictEqual(res.getDate(), { year: 1977, month: 2, day: 1 })
		// 	})
		// })

		// describe('calendarJulian.toYear', () => {
		// 	test('1977-02-14', () => {
		// 		const res = new Julian.calendarJulian(1977, 2, 14).toYear()
		// 		strictEqual(res, 1977.12055, 5)
		// 	})
		// })
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

	// TODO:
	// describe('Calendar', () => {
	// 	test('can instatiate with year', () => {
	// 		const d = new Julian.calendar(2015)
	// 		strictEqual(d.year, 2015)
	// 		strictEqual(d.month, 1)
	// 		strictEqual(d.day, 1)
	// 	})

	// 	test('can instatiate with Date', () => {
	// 		const d = new Julian.calendar(new Date('2015-10-20T12:00:00Z'))
	// 		strictEqual(d.year, 2015)
	// 		strictEqual(d.month, 10)
	// 		strictEqual(d.day, 20.5)
	// 	})

	// 	test('can convert from Date to JD', () => {
	// 		const d = new Julian.calendar().fromDate(new Date('2000-01-01T12:00:00Z'))
	// 		const jd = d.toJD()
	// 		strictEqual(jd, Base.J2000)
	// 	})

	// 	test('can convert from JD to Date', () => {
	// 		const d = new Julian.calendar().fromJD(Base.J2000)
	// 		const date = d.toDate()
	// 		strictEqual(date.toISOString(), '2000-01-01T12:00:00.000Z')
	// 	})

	// 	test('can set date to midnight of same day and convert date to iso string', () => {
	// 		const d = new Julian.calendar(2015, 10, 20.4)
	// 		const datestr = d.midnight().toISOString()
	// 		strictEqual(datestr, '2015-10-20T00:00:00.000Z')
	// 	})

	// 	test('can set date to noon of same day', () => {
	// 		const d = new Julian.calendar(2015, 10, 20.4)
	// 		const date = d.noon().toDate()
	// 		strictEqual(date.toISOString(), '2015-10-20T12:00:00.000Z')
	// 	})

	// 	test('can return date', () => {
	// 		const d = new Julian.calendar(2015, 10, 20.4)
	// 		deepStrictEqual(d.getDate(), { year: 2015, month: 10, day: 20 })
	// 	})

	// 	test('can return time', () => {
	// 		const d = new Julian.calendar(new Date('2015-10-20T08:00:00.000Z'))
	// 		deepStrictEqual(d.getTime(), { hour: 8, minute: 0, second: 0, millisecond: 0 })
	// 	})

	// 	test('can return time 2', () => {
	// 		const d = new Julian.calendar(2015, 10, 20.33333333)
	// 		deepStrictEqual(d.getTime(), { hour: 7, minute: 59, second: 59, millisecond: 999 })
	// 	})

	// 	test('can convert to Dynamical Time and back to Universal Time', () => {
	// 		const d = new Julian.calendar(1, 1, 1)
	// 		strictEqual(d.toISOString(), '0001-01-01T00:00:00.000Z')
	// 		d.deltaT() // convert to Dynamical Time
	// 		strictEqual(d.toISOString(), '0001-01-01T02:56:13.459Z')
	// 		d.deltaT(true) // convert back to Universal Time
	// 		strictEqual(d.toISOString(), '0001-01-01T00:00:00.003Z') // 3 ms precision error
	// 	})

	// 	test('can convert to decimal year', () => {
	// 		const d = new Julian.calendar(2000, 7, 2)
	// 		strictEqual(d.toYear(), 2000.5)
	// 	})

	// 	test('can get day of year', () => {
	// 		const d = new Julian.calendar(1400, 12, 24)
	// 		strictEqual(d.dayOfYear(), 359)
	// 	})

	// 	test('can get day of week', () => {
	// 		const d = new Julian.calendar(1400, 12, 24)
	// 		const weekday = 'sun mon tue wed thu fri sat'.split(' ')
	// 		strictEqual(weekday[d.dayOfWeek()], 'fri')
	// 	})

	// 	test('1582-10-15 GC', () => {
	// 		const d = new Julian.calendar(1582, 10, 15)
	// 		strictEqual(d.isGregorian(), true)
	// 	})

	// 	test('1582-10-14 JC', () => {
	// 		const d = new Julian.calendar(1582, 10, 14)
	// 		strictEqual(d.isGregorian(), false)
	// 	})

	// 	test('1582-10-15 GC using Date', () => {
	// 		const d = new Julian.calendar(new Date('1582-10-15T00:00:00Z'))
	// 		strictEqual(d.isGregorian(), true)
	// 	})
	// })

	// test('can convert date to Julian Calendar', () => {
	// 	const d = new Julian.calendarGregorian(1582, 10, 15)
	// 	deepStrictEqual(d.toJulian().getDate(), { year: 1582, month: 10, day: 5 })
	// })

	// test('can convert date to Gregorian Calendar', () => {
	// 	const d = new Julian.calendarJulian(1582, 10, 5)
	// 	deepStrictEqual(d.toGregorian().getDate(), { year: 1582, month: 10, day: 15 })
	// })

	// test('JD to MJD', () => {
	// 	const d = new Julian.calendarGregorian(1858, 11, 17)
	// 	strictEqual(Julian.jDToMJD(d.toJD()), 0.0)
	// })

	// test('MJD to JD', () => {
	// 	const d = Julian.jDToCalendarGregorian(Julian.mJDToJD(0))
	// 	deepStrictEqual(d, { year: 1858, month: 11, day: 17 })
	// })
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
			strictEqual(toMeter(rp), 4747.001, 3)
		})

		test('RotationRate1996_5', () => {
			const ωRp = toMeter(rp) * Globe.ROTATION_RATE_1996_5
			strictEqual(ωRp, 0.34616, 5)
		})

		test('radiusOfCurvature', () => {
			strictEqual(toMeter(rm), 6364.033, 3)
		})

		test('oneDegreeOfLongitude', () => {
			strictEqual(toMeter(Globe.oneDegreeOfLongitude(rp)), 82.8508, 4)
		})

		test('oneDegreeOfLatitude', () => {
			strictEqual(toMeter(Globe.oneDegreeOfLatitude(rm)), 111.0733, 4)
		})
	})

	describe('distance', () => {
		// Example 11.c p 85.
		const c1 = [signedDms(true, 2, 20, 14), signedDms(false, 48, 50, 11)] as const
		const c2 = [signedDms(false, 77, 3, 56), signedDms(false, 38, 55, 17)] as const

		test('distance', () => {
			const distance = Globe.EARTH76.distance(...c1, ...c2)
			strictEqual(toMeter(distance), 6181.63, 2)
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

	// TODO
	// test('Equatorial.toHorizontal', () => {
	// 	// Example 13.b, p. 95.
	// 	// Venus apparent equatorial coordinates
	// 	const jd = Julian.dateToJD(new Date(Date.UTC(1987, 3, 10, 19, 21, 0, 0)))
	// 	const st = Sidereal.apparent(jd)
	// 	// coordinates at Washington D.C. Longitude is measured positively westwards!
	// 	const [az, alt] = Coords.equatorialToHorizontal(hms(23, 9, 16.641), signedDms(true, 6, 43, 11.61), signedDms(false, 77, 3, 56), signedDms(false, 38, 55, 17), st)
	// 	strictEqual(toDeg(az), 68.034, 3)
	// 	strictEqual(toDeg(alt), 15.125, 3)
	// })

	// test('Equatorial.toHorizontal.toEquatorial', () => {
	// 	// Example 13.b, p. 95.
	// 	// Venus apparent equatorial coordinates
	// 	const jd = Julian.dateToJD(new Date(Date.UTC(1987, 3, 10, 19, 21, 0, 0)))
	// 	const st = Sidereal.apparent(jd)
	// 	// coordinates at Washington D.C. Longitude is measured positively westwards!
	// 	const hz = Coords.equatorialToHorizontal(hms(23, 9, 16.641), signedDms(true, 6, 43, 11.61), signedDms(false, 77, 3, 56), signedDms(false, 38, 55, 17), st)
	// 	const [ra, dec] = Coords.horizontalToEquatorial(...hz, signedDms(false, 77, 3, 56), signedDms(false, 38, 55, 17), st)
	// 	expect(toHms(ra)).toEqual([23, 9, 16.641])
	// 	expect(formatALT(dec)).toBe('-06 43 11.61')
	// })

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
		expect(timeToDate(time(day, fraction + f))).toEqual([1991, 8, 7, 5, 42, 40, 907996773])
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
		expect(timeToDate(time(day, fraction + f))).toEqual([1996, 2, 18, 6, 36, 55, 352058930])
		expect(formatALT(a[1], true), '+00 03 38')
	})
})

describe('Line', () => {
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

		expect(timeToDate({ day, fraction: 0, scale: 1 })).toEqual([1994, 10, 1, 5, 21, 33, 530032038])
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
	test('reduceB1950ToJ2000', () => {
		// Example 24.b, p. 161.
		const from = [deg(11.93911), deg(334.04096), deg(186.24444)] as const
		const to = ElementEquinox.reduceB1950ToJ2000(from)
		strictEqual(toDeg(to[0]), 11.945236764689536)
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
	test('horizontal', () => {
		// Example 40.a, p. 280
		const π = Parallax.horizontal(0.37276)
		strictEqual(toArcsec(π), 23.592, 3)
	})

	test('horizontal from moonposition', () => {
		// example from MoonPosition.parallax, ch 47, p. 342
		const jd = Julian.calendarGregorianToJD(1992, 4, 12)
		const range = MoonPosition.position(jd)[2]
		const πMoon = MoonPosition.parallax(range) * RAD2DEG
		const π = Parallax.horizontal(range) * RAD2DEG
		// we don't quite get all the digits here.
		// for close objects we need that Arcsin that's in MoonPosition.Parallax.
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

	test('parallax', () => {
		// Example 47.a, p. 342.
		const jde = Julian.calendarGregorianToJD(1992, 4, 12)
		const res = MoonPosition.position(jde)
		const px = MoonPosition.parallax(res[2])
		strictEqual(toDeg(px), 0.99199, 6)
	})

	test('parallax 2', () => {
		// test case from chapter 40, p. 280
		const px = MoonPosition.parallax(0.37276)
		expect(Math.abs(toArcsec(px) - 23.592) < 0.001).toBeTrue()
	})

	describe('test node 0°', () => {
		// Test data p. 344.
		const n0 = [
			Julian.calendarGregorianToJD(1913, 5, 27),
			Julian.calendarGregorianToJD(1932, 1, 6),
			Julian.calendarGregorianToJD(1950, 8, 17),
			Julian.calendarGregorianToJD(1969, 3, 29),
			Julian.calendarGregorianToJD(1987, 11, 8),
			Julian.calendarGregorianToJD(2006, 6, 19),
			Julian.calendarGregorianToJD(2025, 1, 29),
			Julian.calendarGregorianToJD(2043, 9, 10),
			Julian.calendarGregorianToJD(2062, 4, 22),
			Julian.calendarGregorianToJD(2080, 12, 1),
			Julian.calendarGregorianToJD(2099, 7, 13),
		]

		for (const j of n0) {
			test(j.toFixed(0), () => {
				expect(Math.abs(normalizeAngle(MoonPosition.node(j) + 1) - 1) < 1e-3).toBeTrue()
			})
		}
	})

	describe('test node 180°', () => {
		// Test data p. 344.
		const n180 = [
			Julian.calendarGregorianToJD(1922, 9, 16),
			Julian.calendarGregorianToJD(1941, 4, 27),
			Julian.calendarGregorianToJD(1959, 12, 7),
			Julian.calendarGregorianToJD(1978, 7, 19),
			Julian.calendarGregorianToJD(1997, 2, 27),
			Julian.calendarGregorianToJD(2015, 10, 10),
			Julian.calendarGregorianToJD(2034, 5, 21),
			Julian.calendarGregorianToJD(2052, 12, 30),
			Julian.calendarGregorianToJD(2071, 8, 12),
			Julian.calendarGregorianToJD(2090, 3, 23),
			Julian.calendarGregorianToJD(2108, 11, 3),
		]

		for (const j of n180) {
			test(j.toFixed(0), () => {
				expect(Math.abs(MoonPosition.node(j) - PI) < 1e-3).toBeTrue()
			})
		}
	})
})

describe('Apsis', () => {
	test('meanApogee', () => {
		// Example 50.a, p. 357.0
		const res = Apsis.meanApogee(1988.75)
		strictEqual(res, 2447442.8191, 4)
	})

	test('apogee', () => {
		// Example 50.a, p. 357.0
		const j = Apsis.apogee(1988.75)
		strictEqual(j, 2447442.3543, 4)
	})

	test('apogeeParallax', () => {
		// Example 50.a, p. 357.0
		const p = Apsis.apogeeParallax(1988.75)
		strictEqual(toArcsec(p), 3240.679, 3)
	})

	// Test cases from p. 361.0
	describe('perigee', () => {
		const dates = [
			[1997, 12, 9 + 16.9 / 24, 1997.93],
			[1998, 1, 3 + 8.5 / 24, 1998.01],
			[1990, 12, 2 + 10.8 / 24, 1990.92],
			[1990, 12, 30 + 23.8 / 24, 1991],
		] as const

		for (const [y, m, d, dy] of dates) {
			test(dy.toString(), () => {
				const ref = Julian.calendarGregorianToJD(y, m, d)
				const j = Apsis.perigee(dy)
				expect(Math.abs(j - ref) < 0.1).toBeTrue()
			})
		}
	})

	test('perigeeParallax', () => {
		const p = Apsis.perigeeParallax(1997.93)
		strictEqual(toArcsec(p), 3566.637, 3)
	})

	test('perigeeDistance', () => {
		const y = 1997.93
		const p = Apsis.perigeeParallax(y)
		const d = Apsis.distance(p)
		strictEqual(toKilometer(d), 368877, 0)
		const per = Apsis.perigee(y)
		const dist = MoonPosition.position(per)
		strictEqual(toKilometer(dist[2]), 368881, 0)
	})

	test('comparing perigeeParallax with parallax from position', () => {
		const y = 1997.93
		const perPar = Apsis.perigeeParallax(y)
		const per = Apsis.perigee(y)
		const dist = MoonPosition.position(per)
		const par = MoonPosition.parallax(dist[2])
		expect(toArcsec(Math.abs(perPar - par)) < 0.1).toBeTrue()
	})

	test('apogeeDistance', () => {
		const y = 1997.9
		const p = Apsis.apogeeParallax(y)
		const d = Apsis.distance(p)
		strictEqual(toKilometer(d), 404695, 0)
		const apo = Apsis.apogee(y)
		const dist = MoonPosition.position(apo)
		strictEqual(toKilometer(dist[2]), 404697, 0)
	})

	test('comparing apogeeParallax with parallax from position', () => {
		const y = 1997.9
		const apoPar = Apsis.apogeeParallax(y)
		const apo = Apsis.apogee(y)
		const dist = MoonPosition.position(apo)
		const par = MoonPosition.parallax(dist[2])
		expect(toArcsec(Math.abs(apoPar - par)) < 0.1).toBeTrue()
	})
})

describe('Semidiameter', () => {
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
