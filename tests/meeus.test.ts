import { describe, expect, test } from 'bun:test'
import { deg, formatALT, formatRA, hms, normalizeAngle, signedDms, toArcsec, toDeg } from '../src/angle'
import { DAYSEC, PI } from '../src/constants'
import { toKilometer } from '../src/distance'
import { AngularSeparation, Apsis, Base, Circle, Interpolation, Julian, MoonPosition, Refraction, Stellar } from '../src/meeus'

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
			const x = 28 + (3 + 20.0 / 60) / 24
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

			dates.forEach((date) => {
				const name = [date[0], date[1], date[2]].join('-')

				test(name, () => {
					const jd = Julian.calendarGregorianToJD(date[0], date[1], date[2])
					strictEqual(jd, date[3])
				})
			})
		})

		describe('jdToCalendarGregorian', () => {
			dates.forEach((date) => {
				const name = [date[0], date[1], date[2]].join('-')

				test(name, () => {
					const [year, month, day] = Julian.jdToCalendarGregorian(date[3])
					strictEqual(year, date[0])
					strictEqual(month, date[1])
					strictEqual(day, date[2])
				})
			})
		})
	})
})

describe('AngularSeparation', () => {
	describe('single functions', () => {
		const c1 = [hms(14, 15, 39.7), signedDms(false, 19, 10, 57)] as const
		const c2 = [hms(13, 25, 11.6), signedDms(true, 11, 9, 41)] as const

		test('sep', () => {
			// Example 17.a, p. 110.0
			const d = AngularSeparation.sep(c1, c2)
			expect(formatALT(d, true)).toBe('+32 47 35')
		})

		test('sepHav', () => {
			// Example 17.a, p. 110.0
			const d = AngularSeparation.sepHav(c1, c2)
			expect(formatALT(d, true)).toBe('+32 47 35')
		})

		test('sepPauwels', () => {
			// Example 17.b, p. 116.0
			const d = AngularSeparation.sepPauwels(c1, c2)
			expect(formatALT(d, true)).toBe('+32 47 35')
		})

		test('relativePosition', () => {
			const p = AngularSeparation.relativePosition(c1, c2)
			expect(formatALT(p, true)).toBe('+22 23 25')
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
		expect(formatALT(a[0], true)).toBe('+02 18 38') // Δ = 2°.31054 = 2°19′
		expect(a[1]).toBeTrue() // type I
	})

	test('smallest type II', () => {
		// Example 20.a, p. 128.0
		const c1 = [hms(12, 41, 8.64), signedDms(true, 5, 37, 54.2)] as const
		const c2 = [hms(12, 52, 5.21), signedDms(true, 4, 22, 26.2)] as const
		const c3 = [hms(12, 39, 28.11), signedDms(true, 1, 50, 3.7)] as const
		const a = Circle.smallest(c1, c2, c3)
		expect(formatALT(a[0], true)).toBe('+04 15 49') // Δ = 4°.26363 = 4°16′
		expect(a[1]).toBeFalse() // type II
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

		dates.forEach(([y, m, d, dy]) => {
			test(dy.toString(), () => {
				const ref = Julian.calendarGregorianToJD(y, m, d)
				const j = Apsis.perigee(dy)
				expect(Math.abs(j - ref) < 0.1).toBeTrue()
			})
		})
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

describe('stellar', () => {
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
