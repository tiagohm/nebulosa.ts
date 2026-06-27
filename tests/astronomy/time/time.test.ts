import { expect, test, describe } from 'bun:test'
import { Ellipsoid, geodeticLocation } from '../../../src/astronomy/observer/location'
import { DAYSEC, J2000 } from '../../../src/core/constants'
import { deg, hour } from '../../../src/math/units/angle'
import { meter } from '../../../src/math/units/distance'
// oxfmt-ignore
import { earthRotationAngle, equationOfOrigins, greenwichApparentSiderealTime, greenwichMeanSiderealTime, meanObliquity, nutationAngles, pmAngles, pmMatrix, type PolarMotion, precessionMatrix, precessionNutationMatrix, type Time, Timescale, tai, tcb, tcg, tdb, tdbMinusTtByFairheadAndBretagnon1990, time, timeBesselianYear, timeConvert, timeGPS, timeJulianYear, timeMJD, timeNormalize, timeSubtract, timeToDate, timeToUnix, timeToUnixMillis, timeUnix, timeYMD, timeYMDHMS, toJulianDay, tt, ut1, utc, DEFAULT_TIME_PROVIDERS, dut1 } from '../../../src/astronomy/time/time'
import { downloadPerTag } from '../../download'

await downloadPerTag('time')

function expectTimeClose(actual: Readonly<{ day: number; fraction: number; scale?: Timescale }>, expected: Readonly<{ day: number; fraction: number; scale?: Timescale }>): void {
	expect(actual.day).toBeCloseTo(expected.day, 15)
	expect(actual.fraction).toBeCloseTo(expected.fraction, 15)
	expect(actual.scale).toBe(expected.scale)

	expect(actual.fraction).toBeGreaterThanOrEqual(-0.5)
	expect(actual.fraction).toBeLessThanOrEqual(0.5)
}

test('time', () => {
	const t = time(2449353.623, 0, Timescale.TT)
	expect(t.day).toBe(2449354)
	expect(t.fraction).toBeCloseTo(-0.377, 3)
	expect(t.scale).toBe(Timescale.TT)
})

test('time unix', () => {
	let t = timeUnix(0, undefined)
	expect(t.day).toBe(2440588)
	expect(t.fraction).toBe(-0.5)
	expect(t.scale).toBe(Timescale.UTC)

	t = timeUnix(946684800)
	expect(t.day).toBe(J2000)
	expect(t.fraction).toBe(-0.5)
	expect(t.scale).toBe(Timescale.UTC)

	t = timeUnix(946684800, true)
	expect(t.day).toBe(J2000)
	expect(t.fraction).toBe(-0.5)
	expect(t.scale).toBe(Timescale.UTC)
})

test('time unix fast mode must match normal mode', () => {
	for (const seconds of [0, 86399.75, 1692447927.896736, -0.001, -86400.5]) {
		const precise = timeUnix(seconds, false)
		const fast = timeUnix(seconds, true)
		expectTimeClose(fast, precise)
	}
})

test('time MJD', () => {
	const t = timeMJD(51544, Timescale.UT1)
	expect(t.day).toBe(J2000)
	expect(t.fraction).toBe(-0.5)
	expect(t.scale).toBe(Timescale.UT1)
})

test('time YMDHMS', () => {
	let t = timeYMDHMS(2022, 1, 1, 12, 0, 0)
	expect(t.day).toBe(2459581)
	expect(t.fraction).toBeCloseTo(0, 14)
	expect(t.scale).toBe(Timescale.UTC)

	t = timeYMDHMS(2023, 6, 1, 23, 59, 59)
	expect(t.day).toBe(2460097)
	expect(t.fraction).toBeCloseTo(0.49998842592592596, 14)
	expect(t.scale).toBe(Timescale.UTC)

	t = timeYMDHMS(2024, 1, 1, 0, 0, 0)
	expect(t.day).toBe(2460311)
	expect(t.fraction).toBeCloseTo(-0.5, 14)
	expect(t.scale).toBe(Timescale.UTC)

	t = timeYMDHMS(2025, 12, 31, 17, 59, 43, Timescale.TDB)
	expect(t.day).toBe(2461041)
	expect(t.fraction).toBeCloseTo(0.24980324074074078, 14)
	expect(t.scale).toBe(Timescale.TDB)

	t = timeYMDHMS(1975, 1, 1, 12, 0, 0, Timescale.TCG)
	expect(t.day).toBe(2442414)
	expect(t.fraction).toBeCloseTo(0, 14)
	expect(t.scale).toBe(Timescale.TCG)
})

test('time YMD', () => {
	const t = timeYMD(2025, 5, 5, 0, Timescale.TT)
	expect(toJulianDay(t)).toBe(2460800.5)
	expect(t.scale).toBe(Timescale.TT)
})

test('time julian year', () => {
	let t = timeJulianYear(2024)
	expect(toJulianDay(t)).toBe(2460311)
	expect(t.scale).toBe(Timescale.TT)

	t = timeJulianYear(1975, Timescale.TCG)
	expect(toJulianDay(t)).toBe(2442413.75)
	expect(t.scale).toBe(Timescale.TCG)
})

test('time besselian year', () => {
	const t = timeBesselianYear(1950, Timescale.TCB)
	expect(toJulianDay(t)).toBe(2433282.42345904977992177)
	expect(t.scale).toBe(Timescale.TCB)
})

test('time gregorian year', () => {
	const t = timeYMD(2001)
	expect(toJulianDay(t)).toBe(2451910.5)
	expect(t.scale).toBe(Timescale.UTC)
})

test('time GPS', () => {
	const t = timeGPS(630720013)
	expect(toJulianDay(t)).toBeCloseTo(J2000 - 0.4996296296296296, 14)
	expect(t.scale).toBe(Timescale.TAI)
})

test('subtract', () => {
	const dt = timeSubtract(timeYMDHMS(2020, 1, 1, 12, 0, 0), timeYMDHMS(2020, 1, 1, 10, 0, 0))
	expect(dt).toBeCloseTo((2 * 60 * 60) / DAYSEC, 16)
})

test('time convert to tcb', () => {
	const t = timeYMDHMS(2020, 10, 7, 12, 0, 0, Timescale.TT)
	expectTimeClose(timeConvert(t, Timescale.TCB), tcb(t))
})

test('time convert dispatches to the matching scale converter', () => {
	const t = timeYMDHMS(2020, 10, 7, 12, 0, 0, Timescale.TT)
	const converters = [
		[Timescale.UT1, ut1],
		[Timescale.UTC, utc],
		[Timescale.TAI, tai],
		[Timescale.TT, tt],
		[Timescale.TCG, tcg],
		[Timescale.TDB, tdb],
		[Timescale.TCB, tcb],
	] as const

	for (const [scale, converter] of converters) {
		expectTimeClose(timeConvert(t, scale), converter(t))
	}
})

test('to date', () => {
	expect(timeToDate(timeYMDHMS(2020, 1, 1, 12, 0, 0))).toEqual([2020, 1, 1, 12, 0, 0, 0])
	expect(timeToDate(timeYMDHMS(2020, 1, 1, 23, 59, 59))).toEqual([2020, 1, 1, 23, 59, 59, 0])
	expect(timeToDate(timeYMDHMS(2020, 1, 1, 23, 59, 59.5))).toEqual([2020, 1, 1, 23, 59, 59, 500000000])
	expect(timeToDate(time(2460677, 0.503116, 0))).toEqual([2025, 1, 2, 0, 4, 29, 222400000])
	expect(timeToDate(time(2460678, -0.496884, 0))).toEqual([2025, 1, 2, 0, 4, 29, 222400000])
	expect(timeToDate(timeJulianYear(2000))).toEqual([2000, 1, 1, 12, 0, 0, 0])
})

test('to unix', () => {
	expect(timeToUnix(timeYMDHMS(2020, 1, 1, 12, 0, 0))).toBe(1577880000)
})

test('to unix milliseconds', () => {
	expect(timeToUnixMillis(timeYMDHMS(2020, 1, 1, 12, 0, 0.005))).toBe(1577880000005)
})

test('to unix with scale', () => {
	expect(timeToUnix(timeYMDHMS(2020, 1, 1, 12, 0, 0, Timescale.TAI))).toBe(1577879963)
	expect(timeToUnix(timeYMDHMS(2020, 1, 1, 12, 0, 0, Timescale.TT))).toBe(1577879930)
	expect(timeToUnix(timeYMDHMS(2020, 1, 1, 12, 0, 0, Timescale.TCG))).toBe(1577879929)
	expect(timeToUnix(timeYMDHMS(2020, 1, 1, 12, 0, 0, Timescale.TDB))).toBe(1577879930)
	expect(timeToUnix(timeYMDHMS(2020, 1, 1, 12, 0, 0, Timescale.UT1))).toBe(1577880000)
	expect(timeToUnix(timeYMDHMS(2020, 1, 1, 12, 0, 0, Timescale.UTC))).toBe(1577880000)
})

test('ut1', () => {
	const t = timeYMDHMS(2020, 10, 7, 12, 0, 0, Timescale.UT1)
	expect(t.day).toBe(2459130)
	expect(t.fraction).toBe(0)

	expectTimeClose(ut1(t), { day: 2459130, fraction: 0, scale: Timescale.UT1 })
	expectTimeClose(utc(t), { day: 2459130, fraction: 0.000001988640612458, scale: Timescale.UTC })
	expectTimeClose(tai(t), { day: 2459130, fraction: 0.000430229381353175, scale: Timescale.TAI })
	expectTimeClose(tt(t), { day: 2459130, fraction: 0.000802729381353175, scale: Timescale.TT })
	expectTimeClose(tcg(t), { day: 2459130, fraction: 0.000813870140404485, scale: Timescale.TCG })
	expectTimeClose(tdb(t), { day: 2459130, fraction: 0.000802709826729233, scale: Timescale.TDB })
	expectTimeClose(tcb(t), { day: 2459130, fraction: 0.001050568932858317, scale: Timescale.TCB })

	expect(t.cache?.ut1MinusUtc).toBeDefined()
	expect(t.cache?.ut1MinusTai).toBeDefined()
	expect(t.cache?.tdbMinusTt).toBeDefined()
})

test('utc', () => {
	const t = timeYMDHMS(2020, 10, 7, 12, 0, 0, Timescale.UTC)
	expect(t.day).toBe(2459130)
	expect(t.fraction).toBe(0)

	expectTimeClose(ut1(t), { day: 2459130, fraction: -0.00000198864062497, scale: Timescale.UT1 })
	expectTimeClose(utc(t), { day: 2459130, fraction: 0, scale: Timescale.UTC })
	expectTimeClose(tai(t), { day: 2459130, fraction: 0.000428240740740771, scale: Timescale.TAI })
	expectTimeClose(tt(t), { day: 2459130, fraction: 0.000800740740740771, scale: Timescale.TT })
	expectTimeClose(tcg(t), { day: 2459130, fraction: 0.000811881499790694, scale: Timescale.TCG })
	expectTimeClose(tdb(t), { day: 2459130, fraction: 0.000800721186116808, scale: Timescale.TDB })
	expectTimeClose(tcb(t), { day: 2459130, fraction: 0.001048580292215058, scale: Timescale.TCB })

	expect(t.cache?.ut1MinusUtc).toBeDefined()
	expect(t.cache?.tdbMinusTt).toBeDefined()
})

test('tai', () => {
	const t = timeYMDHMS(2020, 10, 7, 12, 0, 0, Timescale.TAI)
	expect(t.day).toBe(2459130)
	expect(t.fraction).toBe(0)

	expectTimeClose(ut1(t), { day: 2459130, fraction: -0.0004302293813657407, scale: Timescale.UT1 })
	expectTimeClose(utc(t), { day: 2459130, fraction: -0.000428240740740715, scale: Timescale.UTC })
	expectTimeClose(tai(t), { day: 2459130, fraction: 0, scale: Timescale.TAI })
	expectTimeClose(tt(t), { day: 2459130, fraction: 0.0003725, scale: Timescale.TT })
	expectTimeClose(tcg(t), { day: 2459130, fraction: 0.00038364075875147, scale: Timescale.TCG })
	expectTimeClose(tdb(t), { day: 2459130, fraction: 0.000372480445371678, scale: Timescale.TDB })
	expectTimeClose(tcb(t), { day: 2459130, fraction: 0.000620339544829971, scale: Timescale.TCB })

	expect(t.cache?.ut1MinusUtc).toBeDefined()
	expect(t.cache?.ut1MinusTai).toBeDefined()
	expect(t.cache?.tdbMinusTt).toBeDefined()
})

test('tt', () => {
	const t = timeYMDHMS(2020, 10, 7, 12, 0, 0, Timescale.TT)
	expect(t.day).toBe(2459130)
	expect(t.fraction).toBe(0)

	expectTimeClose(ut1(t), { day: 2459130, fraction: -0.000802729386415781, scale: Timescale.UT1 })
	expectTimeClose(utc(t), { day: 2459130, fraction: -0.000800740740740721, scale: Timescale.UTC })
	expectTimeClose(tai(t), { day: 2459130, fraction: -0.0003725, scale: Timescale.TAI })
	expectTimeClose(tt(t), { day: 2459130, fraction: 0, scale: Timescale.TT })
	expectTimeClose(tcg(t), { day: 2459130, fraction: 0.000011140758491864, scale: Timescale.TCG })
	expectTimeClose(tdb(t), { day: 2459130, fraction: -0.000000019554632113, scale: Timescale.TDB })
	expectTimeClose(tcb(t), { day: 2459130, fraction: 0.000247839539050494, scale: Timescale.TCB })

	expect(t.cache?.ut1MinusUtc).toBeDefined()
	expect(t.cache?.tdbMinusTt).toBeDefined()
})

test('tcg', () => {
	const t = timeYMDHMS(2020, 10, 7, 12, 0, 0, Timescale.TCG)
	expect(t.day).toBe(2459130)
	expect(t.fraction).toBe(0)

	expectTimeClose(ut1(t), { day: 2459130, fraction: -0.000813870144970116, scale: Timescale.UT1 })
	expectTimeClose(utc(t), { day: 2459130, fraction: -0.000811881499224787, scale: Timescale.UTC })
	expectTimeClose(tai(t), { day: 2459130, fraction: -0.0003836407584841, scale: Timescale.TAI })
	expectTimeClose(tt(t), { day: 2459130, fraction: -0.0000111407584841, scale: Timescale.TT })
	expectTimeClose(tcg(t), { day: 2459130, fraction: 0, scale: Timescale.TCG })
	expectTimeClose(tdb(t), { day: 2459130, fraction: -0.000011160313116326, scale: Timescale.TDB })
	expectTimeClose(tcb(t), { day: 2459130, fraction: 0.000236698780393541, scale: Timescale.TCB })

	expect(t.cache?.ut1MinusUtc).toBeDefined()
	expect(t.cache?.tdbMinusTt).toBeDefined()
})

test('tdb', () => {
	const t = timeYMDHMS(2020, 10, 7, 12, 0, 0, Timescale.TDB)
	expect(t.day).toBe(2459130)
	expect(t.fraction).toBe(0)

	expectTimeClose(ut1(t), { day: 2459130, fraction: -0.000802709831783577, scale: Timescale.UT1 })
	expectTimeClose(utc(t), { day: 2459130, fraction: -0.000800721186108623, scale: Timescale.UTC })
	expectTimeClose(tai(t), { day: 2459130, fraction: -0.000372480445367887, scale: Timescale.TAI })
	expectTimeClose(tt(t), { day: 2459130, fraction: 0.000000019554632113, scale: Timescale.TT })
	expectTimeClose(tcg(t), { day: 2459130, fraction: 0.00001116031312399, scale: Timescale.TCG })
	expectTimeClose(tdb(t), { day: 2459130, fraction: 0, scale: Timescale.TDB })
	expectTimeClose(tcb(t), { day: 2459130, fraction: 0.00024785909368291, scale: Timescale.TCB })

	expect(t.cache?.ut1MinusUtc).toBeDefined()
	expect(t.cache?.tdbMinusTt).toBeDefined()
})

test('tcb', () => {
	const t = timeYMDHMS(2020, 10, 7, 12, 0, 0, Timescale.TCB)
	expect(t.day).toBe(2459130)
	expect(t.fraction).toBe(0)

	expectTimeClose(ut1(t), { day: 2459130, fraction: -0.001050568923184019, scale: Timescale.UT1 })
	expectTimeClose(utc(t), { day: 2459130, fraction: -0.001048580275945906, scale: Timescale.UTC })
	expectTimeClose(tai(t), { day: 2459130, fraction: -0.000620339535205171, scale: Timescale.TAI })
	expectTimeClose(tt(t), { day: 2459130, fraction: -0.000247839535205171, scale: Timescale.TT })
	expectTimeClose(tcg(t), { day: 2459130, fraction: -0.000236698776886034, scale: Timescale.TCG })
	expectTimeClose(tdb(t), { day: 2459130, fraction: -0.000247859089839806, scale: Timescale.TDB })
	expectTimeClose(tcb(t), { day: 2459130, fraction: 0, scale: Timescale.TCB })

	expect(t.cache?.ut1MinusUtc).toBeDefined()
	expect(t.cache?.tdbMinusTt).toBeDefined()
})

test('normalize', () => {
	const epochOffset = timeNormalize(946684800, 0, DAYSEC)
	expect(epochOffset.day).toBe(10957)
	expect(epochOffset.fraction).toBe(0)

	const t = timeYMDHMS(2020, 10, 7, 0, 0, 0, Timescale.TCB)

	const a = ut1(t)
	expect(a.day).toBe(2459129)
	expect(a.fraction).toBeCloseTo(0.498949435681883102, 14)

	const b = utc(t)
	expect(b.day).toBe(2459129)
	expect(b.fraction).toBeCloseTo(0.498951427480941123, 14)

	const c = tai(t)
	expect(c.day).toBe(2459129)
	expect(c.fraction).toBeCloseTo(0.499379668221681894, 14)

	const d = tt(t)
	expect(d.day).toBe(2459129)
	expect(d.fraction).toBeCloseTo(0.499752168221681892, 14)

	const e = tcg(t)
	expect(e.day).toBe(2459129)
	expect(e.fraction).toBeCloseTo(0.499763308631536507, 14)

	const f = tdb(t)
	expect(f.day).toBe(2459129)
	expect(f.fraction).toBeCloseTo(0.499752148662759077, 14)
})

describe('normalize time', () => {
	test('preserva o erro de twoSum para uma fração não representável em JD', () => {
		expectTimeClose(timeNormalize(2451545, 0.1, 0), { day: 2451545, fraction: 0.1, scale: 1 })
	})

	test('preserva o erro de twoSum para 1/3 em JD', () => {
		expectTimeClose(timeNormalize(2451545, 1 / 3, 0), { day: 2451545, fraction: 1 / 3, scale: 1 })
	})

	test('corrige uma fração pouco abaixo de +0.5 que foi arredondada para +0.5 no sum', () => {
		expectTimeClose(timeNormalize(2451545, 0.4999999999, 0), { day: 2451545, fraction: 0.4999999999, scale: 1 })
	})

	test('normaliza uma fração pouco acima de +0.5 para o dia seguinte', () => {
		expectTimeClose(timeNormalize(2451545, 0.5000000001, 0), { day: 2451546, fraction: -0.4999999999, scale: 1 })
	})

	test('corrige uma fração pouco acima de -0.5 sem trocar de dia', () => {
		expectTimeClose(timeNormalize(-2451545, -0.4999999999, 0), { day: -2451545, fraction: -0.4999999999, scale: 1 })
	})

	test('normaliza uma fração pouco abaixo de -0.5 para o dia anterior', () => {
		expectTimeClose(timeNormalize(-2451545, -0.5000000001, 0), { day: -2451546, fraction: 0.4999999999, scale: 1 })
	})

	test('preserva o termo de erro durante a divisão por inteiro', () => {
		expectTimeClose(timeNormalize(2451545, 0.1, 7), { day: 350221, fraction: -0.2714285714285714, scale: 1 })
	})

	test('preserva o termo de erro durante a divisão por divisor não inteiro', () => {
		expectTimeClose(timeNormalize(2451545, 0.1, Math.PI), { day: 780351, fraction: 0.04175542975065355, scale: 1 })
	})

	test('normaliza corretamente após divisão por um número grande', () => {
		expectTimeClose(timeNormalize(2451545, 0.123456789012345, 36525), { day: 67, fraction: 0.11964745946034257, scale: 1 })
	})

	test('aceita divisor negativo', () => {
		expectTimeClose(timeNormalize(-2451545, 0.123456789012345, -7), { day: 350221, fraction: -0.3033509698589064, scale: 1 })
	})

	test('preserva uma fração pequena mesmo quando day não consegue representá-la sozinho', () => {
		expectTimeClose(timeNormalize(1e16, 0.1, 0), { day: 1e16, fraction: 0.1, scale: 1 })
	})

	test('funciona quando a parte day já contém uma fração, como Julian Date .5', () => {
		expectTimeClose(timeNormalize(2440587.5, 1e-9, 0), { day: 2440588, fraction: -0.499999999, scale: 1 })
	})

	test('returns an already normalized time unchanged', () => {
		for (const [day, fraction, divisor] of [
			[0, 0, 0],
			[2451545, 0.1, 0],
			[1e16, 0.1, 0],
			[-2451545, -0.5, 0],
			[2451545, 0.49999999999999994, 0],
		]) {
			const result = timeNormalize(day, fraction, divisor)

			expect(result.day).toBeCloseTo(day, 15)
			expect(result.fraction).toBeCloseTo(fraction, 15)
		}
	})
})

test('location', () => {
	let t = timeYMDHMS(2020, 10, 7, 12, 0, 0, Timescale.TDB)
	t.location = geodeticLocation(deg(-45), deg(-23), meter(890), Ellipsoid.WGS84)

	expect(t.day).toBe(2459130)
	expect(t.fraction).toBe(0)

	expectTimeClose(ut1(t), { day: 2459130, fraction: -0.000802709843032912, scale: Timescale.UT1 })
	expectTimeClose(utc(t), { day: 2459130, fraction: -0.000800721197357957, scale: Timescale.UTC })
	expectTimeClose(tai(t), { day: 2459130, fraction: -0.000372480456617236, scale: Timescale.TAI })
	expectTimeClose(tt(t), { day: 2459130, fraction: 0.000000019543382764, scale: Timescale.TT })
	expectTimeClose(tcg(t), { day: 2459130, fraction: 0.000011160301874642, scale: Timescale.TCG })
	expectTimeClose(tdb(t), { day: 2459130, fraction: 0, scale: Timescale.TDB })
	expectTimeClose(tcb(t), { day: 2459130, fraction: 0.00024785909368291, scale: Timescale.TCB })

	t = timeYMDHMS(2020, 10, 7, 12, 0, 0, Timescale.UT1)
	t.location = geodeticLocation(deg(-45), deg(-23), meter(890), Ellipsoid.WGS84)

	expect(t.day).toBe(2459130)
	expect(t.fraction).toBe(0)

	expectTimeClose(ut1(t), { day: 2459130, fraction: 0, scale: Timescale.UT1 })
	expectTimeClose(utc(t), { day: 2459130, fraction: 0.000001988640612458, scale: Timescale.UTC })
	expectTimeClose(tai(t), { day: 2459130, fraction: 0.000430229381353175, scale: Timescale.TAI })
	expectTimeClose(tt(t), { day: 2459130, fraction: 0.000802729381353175, scale: Timescale.TT })
	expectTimeClose(tcg(t), { day: 2459130, fraction: 0.000813870140404485, scale: Timescale.TCG })
	expectTimeClose(tdb(t), { day: 2459130, fraction: 0.000802709837905048, scale: Timescale.TDB })
	expectTimeClose(tcb(t), { day: 2459130, fraction: 0.001050568944034133, scale: Timescale.TCB })
})

test('cache', () => {
	const t = timeYMDHMS(2020, 10, 7, 12, 0, 0, Timescale.TCB)

	for (let i = 0; i < 1000; i++) {
		const a = ut1(t)
		expect(a.cache?.tcb).toBe(t)
		expect(t.cache?.ut1).toBe(a)

		const b = utc(t)
		expect(b.cache?.tcb).toBe(t)
		expect(t.cache?.utc).toBe(b)

		const c = tai(t)
		expect(c.cache?.tcb).toBe(t)
		expect(t.cache?.tai).toBe(c)

		const d = tt(t)
		expect(d.cache?.tcb).toBe(t)
		expect(t.cache?.tt).toBe(d)

		const e = tcg(t)
		expect(e.cache?.tcb).toBe(t)
		expect(t.cache?.tcg).toBe(e)

		const f = tdb(t)
		expect(f.cache?.tcb).toBe(t)
		expect(t.cache?.tdb).toBe(f)
	}
}, 50)

test('providers', () => {
	const providers = { ...DEFAULT_TIME_PROVIDERS }

	for (let scale = 0; scale <= 6; scale++) {
		const t = timeYMDHMS(2020, 10, 7, 12, 0, 0, scale)
		t.providers = providers

		const a = ut1(t)
		expect(a.providers).toBe(providers)

		const b = utc(a)
		expect(b.providers).toBe(providers)

		const c = tai(b)
		expect(c.providers).toBe(providers)

		const d = tt(c)
		expect(d.providers).toBe(providers)

		const e = tcg(d)
		expect(e.providers).toBe(providers)

		const f = tdb(e)
		expect(f.providers).toBe(providers)
	}
}, 100)

test('polar motion override does not reuse cached default values', () => {
	const customPolarMotion: PolarMotion = () => [1, 2]

	const a = timeYMDHMS(2020, 10, 7, 12, 0, 0, Timescale.UTC)
	pmAngles(a)
	const actualAngles = pmAngles(a, customPolarMotion)
	const expectedAngles = pmAngles(timeYMDHMS(2020, 10, 7, 12, 0, 0, Timescale.UTC), customPolarMotion)
	expect(actualAngles[0]).toBeCloseTo(expectedAngles[0], 16)
	expect(actualAngles[1]).toBeCloseTo(expectedAngles[1], 16)
	expect(actualAngles[2]).toBeCloseTo(expectedAngles[2], 16)

	const b = timeYMDHMS(2020, 10, 7, 12, 0, 0, Timescale.UTC)
	pmMatrix(b)
	const actualMatrix = pmMatrix(b, customPolarMotion)
	const expectedMatrix = pmMatrix(timeYMDHMS(2020, 10, 7, 12, 0, 0, Timescale.UTC), customPolarMotion)
	for (let i = 0; i < actualMatrix.length; i++) expect(actualMatrix[i]).toBeCloseTo(expectedMatrix[i], 16)
})

test('zero-valued DUT1 is cached', () => {
	const t = timeYMDHMS(2020, 1, 1, 0, 0, 0, Timescale.UTC)

	let callCount = 0

	const _dut1 = (_time: Time) => {
		callCount++
		return 0
	}

	t.providers = { ...DEFAULT_TIME_PROVIDERS, dut1: _dut1 }

	expect(dut1(t)).toBe(0)
	expect(dut1(t)).toBe(0)
	expect(callCount).toBe(1)
})

test('tdb minus tt by Fairhead and Bretagnon 1990', () => {
	expect(tdbMinusTtByFairheadAndBretagnon1990(time(2448031, 0.5, Timescale.TDB))).toBeCloseTo(0.0011585185926349208, 16)

	let callCount = 0

	const tdbMinusTt = (time: Time) => {
		callCount++
		return tdbMinusTtByFairheadAndBretagnon1990(time)
	}

	const providers = { ...DEFAULT_TIME_PROVIDERS, tdbMinusTt }

	const t0 = timeYMDHMS(2020, 10, 7, 12, 0, 0, Timescale.TDB)
	t0.providers = providers
	expectTimeClose(tt(t0), { day: 2459130, fraction: 0.0016862469909015424 / DAYSEC, scale: Timescale.TT })

	const t1 = timeYMDHMS(2020, 10, 7, 12, 0, 0, Timescale.TT)
	t1.providers = providers
	expectTimeClose(tdb(t1), { day: 2459130, fraction: -0.0016862469909015424 / DAYSEC, scale: Timescale.TDB })

	expect(callCount).toBe(2)
})

test('gast', () => {
	const t = timeYMDHMS(2020, 10, 7, 12, 0, 0, Timescale.UTC)
	expect(greenwichApparentSiderealTime(t)).toBe(t.cache!.gast!)
	expect(t.cache?.gast).toBeCloseTo(hour(13.106038262872143463), 15)
})

test('gmst', () => {
	const t = timeYMDHMS(2020, 10, 7, 12, 0, 0, Timescale.UTC)
	expect(greenwichMeanSiderealTime(t)).toBe(t.cache!.gmst!)
	expect(t.cache?.gmst).toBeCloseTo(hour(13.106345240224241522), 15)
})

test('era', () => {
	const t = timeYMDHMS(2020, 10, 7, 12, 0, 0, Timescale.UTC)
	expect(earthRotationAngle(t)).toBe(t.cache!.era!)
	expect(t.cache?.era).toBeCloseTo(hour(13.088607043262001639), 15)
})

test('mean obliquity', () => {
	const t = timeYMDHMS(2020, 10, 7, 12, 0, 0, Timescale.UTC)
	expect(meanObliquity(t)).toBe(t.cache!.meanObliquity!)
	expect(t.cache?.meanObliquity).toBeCloseTo(0.409045445708786315, 15)
})

test('nutation', () => {
	const t = timeYMDHMS(2020, 10, 7, 12, 0, 0, Timescale.UTC)
	expect(nutationAngles(t)).toBe(t.cache!.nutation!)
	expect(t.cache?.nutation).toEqual([-0.00008760676099523273, 0.00000755771193699156])
})

test('precession', () => {
	const t = timeYMDHMS(2020, 10, 7, 12, 0, 0, Timescale.UTC)
	expect(precessionMatrix(t)).toBe(t.cache!.precession!)
	expect(t.cache?.precession).toEqual([0.9999871819115399, -0.004643833528063321, -0.0020176280083981767, 0.004643833647273387, 0.9999892173356966, -0.000004625710173677966, 0.0020176277340206686, -0.000004743877952184672, 0.9999979645758397])
})

test('precession-nutation matrix', () => {
	const t = timeYMDHMS(2020, 10, 7, 12, 0, 0, Timescale.UTC)
	expect(precessionNutationMatrix(t)).toBe(t.cache!.precessionNutation!)
	expect(t.cache?.precessionNutation).toEqual([0.9999876216446774, -0.004563455260357874, -0.0019827842818092144, 0.004563440392430343, 0.9999895873794092, -0.000012022632120134435, 0.001982818500572567, 0.0000029741654186676847, 0.9999980342090419])
})

test('equation of origins', () => {
	const t = timeYMDHMS(2020, 10, 7, 12, 0, 0, Timescale.UTC)
	expect(equationOfOrigins(t)).toBe(t.cache!.equationOfOrigins!)
	expect(t.cache?.equationOfOrigins).toEqual([0.9999980342134646, 0.000000011522914443798382, -0.001982818500615607, -0.00000001742012200722093, 0.9999999999955772, -0.0000029741367242157103, 0.001982818500572567, 0.0000029741654186676847, 0.9999980342090419])
})

test('delta T', () => {
	const a = timeYMDHMS(2020, 10, 7, 12, 0, 0, Timescale.TT)
	const b = ut1(a)
	expect((a.day - b.day + (a.fraction - b.fraction)) * DAYSEC).toBeCloseTo(69, 0)
})
