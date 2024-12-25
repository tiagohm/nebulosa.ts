import { beforeAll, expect, test, type CustomMatcher } from 'bun:test'
import { hour } from './angle'
import { J2000 } from './constants'
import { iersa, iersb } from './iers'
import { equationOfOrigins, era, gast, gmst, meanObliquity, normalize, nutation, precession, precessionNutation, tai, tcb, tcg, tdb, tdbMinusTt, tdbMinusTtByFairheadAndBretagnon1990, time, timeBesselian, timeGPS, timeJulian, timeMJD, Timescale, timeUnix, timeYMDHMS, tt, ut1, utc, type Time } from './time'

const toMatchTime: CustomMatcher<Time, never[]> = (actual, expected: Time, precision?: number) => {
	const b = normalize(expected.day, expected.fraction)

	if (actual.day !== b.day) {
		return { pass: false, message: () => `failed to match day. expected ${b.day}, but ${actual.day}` }
	}
	if (Math.abs(actual.fraction - b.fraction) > (precision ?? 1e-16)) {
		return { pass: false, message: () => `failed to match fraction of day. expected ${b.fraction}, but ${actual.fraction}` }
	}
	if (actual.scale !== expected.scale) {
		return { pass: false, message: () => `failed to match timescale. expected ${expected.scale}, but ${actual.scale}` }
	}

	return { pass: true }
}

expect.extend({
	toMatchTime: toMatchTime as CustomMatcher<unknown, unknown[]>,
})

declare module 'bun:test' {
	interface Matchers {
		toMatchTime(expected: Time, precision?: number): void
	}
}

beforeAll(async () => {
	await iersa.load(await Bun.file('data/finals2000A.txt').arrayBuffer())
	await iersb.load(await Bun.file('data/eopc04.1962-now.txt').arrayBuffer())
})

test('time', () => {
	const t = time(2449353.623, 0, Timescale.TT)
	expect(t.day).toBe(2449354)
	expect(t.fraction).toBeCloseTo(-0.377, 3)
	expect(t.scale).toBe(Timescale.TT)
})

test('timeUnix', () => {
	let t = timeUnix(0)
	expect(t.day).toBe(2440588)
	expect(t.fraction).toBe(-0.5)
	expect(t.scale).toBe(Timescale.UTC)

	t = timeUnix(946684800, Timescale.TAI)
	expect(t.day).toBe(J2000)
	expect(t.fraction).toBe(-0.5)
	expect(t.scale).toBe(Timescale.TAI)
})

test('timeMJD', () => {
	const t = timeMJD(51544, Timescale.UT1)
	expect(t.day).toBe(J2000)
	expect(t.fraction).toBe(-0.5)
	expect(t.scale).toBe(Timescale.UT1)
})

test('timeYMDHMS', () => {
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
})

test('timeJulian', () => {
	const t = timeJulian(2024, Timescale.TCG)
	expect(t.day).toBe(2460311)
	expect(t.fraction).toBe(0)
	expect(t.scale).toBe(Timescale.TCG)
})

test('timeBesselian', () => {
	const t = timeBesselian(1950, Timescale.TCB)
	expect(t.day).toBe(2433282)
	expect(t.fraction).toBe(0.42345904977992177)
	expect(t.scale).toBe(Timescale.TCB)
})

test('timGPS', () => {
	const t = timeGPS(630720013)
	expect(t.day).toBe(J2000)
	expect(t.fraction).toBe(-0.4996296167373657)
	expect(t.scale).toBe(Timescale.TAI)
})

test('ut1', () => {
	const t = timeYMDHMS(2020, 10, 7, 12, 0, 0, Timescale.UT1)
	expect(t.day).toBe(2459130)
	expect(t.fraction).toBe(0)

	expect(ut1(t)).toMatchTime(time(2459130, 0, Timescale.UT1, false))
	expect(utc(t)).toMatchTime(time(2459130, 0.000001988640612458, Timescale.UTC, false), 1e-13)
	expect(tai(t)).toMatchTime(time(2459130, 0.000430229381353175, Timescale.TAI, false), 1e-13)
	expect(tt(t)).toMatchTime(time(2459130, 0.000802729381353175, Timescale.TT, false), 1e-13)
	expect(tcg(t)).toMatchTime(time(2459130, 0.000813870140404485, Timescale.TCG, false), 1e-13)
	expect(tdb(t)).toMatchTime(time(2459130, 0.000802709826729233, Timescale.TDB, false), 1e-13)
	expect(tcb(t)).toMatchTime(time(2459130, 0.001050568932858317, Timescale.TCB, false), 1e-13)
})

test('utc', () => {
	const t = timeYMDHMS(2020, 10, 7, 12, 0, 0, Timescale.UTC)
	expect(t.day).toBe(2459130)
	expect(t.fraction).toBe(0)

	expect(ut1(t)).toMatchTime(time(2459130, -0.00000198864062497, Timescale.UT1, false))
	expect(utc(t)).toMatchTime(time(2459130, 0, Timescale.UTC, false))
	expect(tai(t)).toMatchTime(time(2459130, 0.000428240740740771, Timescale.TAI, false))
	expect(tt(t)).toMatchTime(time(2459130, 0.000800740740740771, Timescale.TT, false))
	expect(tcg(t)).toMatchTime(time(2459130, 0.000811881499790694, Timescale.TCG, false))
	expect(tdb(t)).toMatchTime(time(2459130, 0.000800721186116808, Timescale.TDB, false))
	expect(tcb(t)).toMatchTime(time(2459130, 0.001048580292215058, Timescale.TCB, false))
})

test('tai', () => {
	const t = timeYMDHMS(2020, 10, 7, 12, 0, 0, Timescale.TAI)
	expect(t.day).toBe(2459130)
	expect(t.fraction).toBe(0)

	expect(ut1(t)).toMatchTime(time(2459130, -0.000430229384066532, Timescale.UT1, false), 1e-11)
	expect(utc(t)).toMatchTime(time(2459130, -0.000428240740740715, Timescale.UTC, false))
	expect(tai(t)).toMatchTime(time(2459130, 0, Timescale.TAI, false))
	expect(tt(t)).toMatchTime(time(2459130, 0.0003725, Timescale.TT, false))
	expect(tcg(t)).toMatchTime(time(2459130, 0.00038364075875147, Timescale.TCG, false))
	expect(tdb(t)).toMatchTime(time(2459130, 0.000372480445371678, Timescale.TDB, false))
	expect(tcb(t)).toMatchTime(time(2459130, 0.000620339544829971, Timescale.TCB, false))
})

test('tt', () => {
	const t = timeYMDHMS(2020, 10, 7, 12, 0, 0, Timescale.TT)
	expect(t.day).toBe(2459130)
	expect(t.fraction).toBe(0)

	expect(ut1(t)).toMatchTime(time(2459130, -0.000802729386415781, Timescale.UT1, false))
	expect(utc(t)).toMatchTime(time(2459130, -0.000800740740740721, Timescale.UTC, false))
	expect(tai(t)).toMatchTime(time(2459130, -0.0003725, Timescale.TAI, false))
	expect(tt(t)).toMatchTime(time(2459130, 0, Timescale.TT, false))
	expect(tcg(t)).toMatchTime(time(2459130, 0.000011140758491864, Timescale.TCG, false))
	expect(tdb(t)).toMatchTime(time(2459130, -0.000000019554632113, Timescale.TDB, false))
	expect(tcb(t)).toMatchTime(time(2459130, 0.000247839539050494, Timescale.TCB, false))
})

test('tcg', () => {
	const t = timeYMDHMS(2020, 10, 7, 12, 0, 0, Timescale.TCG)
	expect(t.day).toBe(2459130)
	expect(t.fraction).toBe(0)

	expect(ut1(t)).toMatchTime(time(2459130, -0.000813870144970116, Timescale.UT1, false))
	expect(utc(t)).toMatchTime(time(2459130, -0.000811881499224787, Timescale.UTC, false))
	expect(tai(t)).toMatchTime(time(2459130, -0.0003836407584841, Timescale.TAI, false))
	expect(tt(t)).toMatchTime(time(2459130, -0.0000111407584841, Timescale.TT, false))
	expect(tcg(t)).toMatchTime(time(2459130, 0, Timescale.TCG, false))
	expect(tdb(t)).toMatchTime(time(2459130, -0.000011160313116326, Timescale.TDB, false))
	expect(tcb(t)).toMatchTime(time(2459130, 0.000236698780393541, Timescale.TCB, false))
})

test('tdb', () => {
	const t = timeYMDHMS(2020, 10, 7, 12, 0, 0, Timescale.TDB)
	expect(t.day).toBe(2459130)
	expect(t.fraction).toBe(0)

	expect(ut1(t)).toMatchTime(time(2459130, -0.000802709831783577, Timescale.UT1, false))
	expect(utc(t)).toMatchTime(time(2459130, -0.000800721186108623, Timescale.UTC, false))
	expect(tai(t)).toMatchTime(time(2459130, -0.000372480445367887, Timescale.TAI, false))
	expect(tt(t)).toMatchTime(time(2459130, 0.000000019554632113, Timescale.TT, false))
	expect(tcg(t)).toMatchTime(time(2459130, 0.00001116031312399, Timescale.TCG, false))
	expect(tdb(t)).toMatchTime(time(2459130, 0, Timescale.TDB, false))
	expect(tcb(t)).toMatchTime(time(2459130, 0.00024785909368291, Timescale.TCB, false))
})

test('tcb', () => {
	const t = timeYMDHMS(2020, 10, 7, 12, 0, 0, Timescale.TCB)
	expect(t.day).toBe(2459130)
	expect(t.fraction).toBe(0)

	expect(ut1(t)).toMatchTime(time(2459130, -0.001050568923184019, Timescale.UT1, false))
	expect(utc(t)).toMatchTime(time(2459130, -0.001048580275945906, Timescale.UTC, false))
	expect(tai(t)).toMatchTime(time(2459130, -0.000620339535205171, Timescale.TAI, false))
	expect(tt(t)).toMatchTime(time(2459130, -0.000247839535205171, Timescale.TT, false))
	expect(tcg(t)).toMatchTime(time(2459130, -0.000236698776886034, Timescale.TCG, false))
	expect(tdb(t)).toMatchTime(time(2459130, -0.000247859089839806, Timescale.TDB, false))
	expect(tcb(t)).toMatchTime(time(2459130, 0, Timescale.TCB, false))
})

test('extra', () => {
	const t = timeYMDHMS(2020, 10, 7, 12, 0, 0, Timescale.TCB)

	for (let i = 0; i < 10000; i++) {
		const a = ut1(t)
		expect(a.extra?.tcb).toBe(t)
		expect(t.extra?.ut1).toBe(a)

		const b = utc(t)
		expect(b.extra?.tcb).toBe(t)
		expect(t.extra?.utc).toBe(b)

		const c = tai(t)
		expect(c.extra?.tcb).toBe(t)
		expect(t.extra?.tai).toBe(c)

		const d = tt(t)
		expect(d.extra?.tcb).toBe(t)
		expect(t.extra?.tt).toBe(d)

		const e = tcg(t)
		expect(e.extra?.tcb).toBe(t)
		expect(t.extra?.tcg).toBe(e)

		const f = tdb(t)
		expect(f.extra?.tcb).toBe(t)
		expect(t.extra?.tdb).toBe(f)
	}
})

test('tdbMinusTtByFairheadAndBretagnon1990', () => {
	expect(tdbMinusTtByFairheadAndBretagnon1990(time(2448031, 0.5, Timescale.TDB))).toBeCloseTo(0.0011585185926349208, 16)

	const t0 = timeYMDHMS(2020, 10, 7, 12, 0, 0, Timescale.TDB)
	t0.tdbMinusTt = tdbMinusTtByFairheadAndBretagnon1990
	expect(tt(t0)).toMatchTime(time(2459130, 0.000000019554632113, Timescale.TT, false), 1e-10)

	const t1 = timeYMDHMS(2020, 10, 7, 12, 0, 0, Timescale.TT)
	t1.tdbMinusTt = tdbMinusTtByFairheadAndBretagnon1990
	expect(tdb(t1)).toMatchTime(time(2459130, -0.000000019554632113, Timescale.TDB, false), 1e-10)

	expect(tdbMinusTtByFairheadAndBretagnon1990(t0)).toBeCloseTo(tdbMinusTt(t0), 5)
})

test('gast', () => {
	const t = timeYMDHMS(2020, 10, 7, 12, 0, 0, Timescale.UTC)
	expect(gast(t)).toBe(t.extra!.gast!)
	expect(t.extra?.gast).toBeCloseTo(hour(13.106038262872143463), 15)
})

test('gmst', () => {
	const t = timeYMDHMS(2020, 10, 7, 12, 0, 0, Timescale.UTC)
	expect(gmst(t)).toBe(t.extra!.gmst!)
	expect(t.extra?.gmst).toBeCloseTo(hour(13.106345240224241522), 15)
})

test('era', () => {
	const t = timeYMDHMS(2020, 10, 7, 12, 0, 0, Timescale.UTC)
	expect(era(t)).toBe(t.extra!.era!)
	expect(t.extra?.era).toBeCloseTo(hour(13.088607043262001639), 15)
})

test('meanObliquity', () => {
	const t = timeYMDHMS(2020, 10, 7, 12, 0, 0, Timescale.UTC)
	expect(meanObliquity(t)).toBe(t.extra!.meanObliquity!)
	expect(t.extra?.meanObliquity).toBeCloseTo(0.409045445708786315, 15)
})

test('nutation', () => {
	const t = timeYMDHMS(2020, 10, 7, 12, 0, 0, Timescale.UTC)
	expect(nutation(t)).toBe(t.extra!.nutation!)
	expect(t.extra?.nutation).toEqual([-0.00008760676099523273, 0.00000755771193699156])
})

test('precession', () => {
	const t = timeYMDHMS(2020, 10, 7, 12, 0, 0, Timescale.UTC)
	expect(precession(t)).toBe(t.extra!.precession!)
	expect(t.extra?.precession).toEqual([0.9999871819115399, -0.004643833528063321, -0.0020176280083981767, 0.004643833647273387, 0.9999892173356966, -0.000004625710173677966, 0.0020176277340206686, -0.000004743877952184672, 0.9999979645758397])
})

test('precessionNutation', () => {
	const t = timeYMDHMS(2020, 10, 7, 12, 0, 0, Timescale.UTC)
	expect(precessionNutation(t)).toBe(t.extra!.precessionNutation!)
	expect(t.extra?.precessionNutation).toEqual([0.9999876216446774, -0.004563455260357874, -0.0019827842818092144, 0.004563440392430343, 0.9999895873794092, -0.000012022632120134435, 0.001982818500572567, 0.0000029741654186676847, 0.9999980342090419])
})

test('equationOfOrigins', () => {
	const t = timeYMDHMS(2020, 10, 7, 12, 0, 0, Timescale.UTC)
	expect(equationOfOrigins(t)).toBe(t.extra!.equationOfOrigins!)
	expect(t.extra?.equationOfOrigins).toEqual([0.9999980342134646, 0.000000011522914443798382, -0.001982818500615607, -0.00000001742012200722093, 0.9999999999955772, -0.0000029741367242157103, 0.001982818500572567, 0.0000029741654186676847, 0.9999980342090419])
})
