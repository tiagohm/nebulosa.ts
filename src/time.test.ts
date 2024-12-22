import { expect, test, type CustomMatcher } from 'bun:test'
import { J2000 } from './constants'
import { normalize, tai, tcb, tcg, tdb, tdbMinusTt, tdbMinusTtByFairheadAndBretagnon1990, time, timeBesselian, timeGPS, timeJulian, timeMJD, Timescale, timeUnix, timeYMDHMS, tt, ut1, utc, type Time } from './time'

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
	const t = timeMJD(51544.0, Timescale.UT1)
	expect(t.day).toBe(J2000)
	expect(t.fraction).toBe(-0.5)
	expect(t.scale).toBe(Timescale.UT1)
})

test('timeYMDHMS', () => {
	let t = timeYMDHMS(2022, 1, 1, 12, 0, 0.0)
	expect(t.day).toBe(2459581)
	expect(t.fraction).toBeCloseTo(0, 14)
	expect(t.scale).toBe(Timescale.UTC)

	t = timeYMDHMS(2023, 6, 1, 23, 59, 59.0)
	expect(t.day).toBe(2460097)
	expect(t.fraction).toBeCloseTo(0.49998842592592596, 14)
	expect(t.scale).toBe(Timescale.UTC)

	t = timeYMDHMS(2024, 1, 1, 0, 0, 0.0)
	expect(t.day).toBe(2460311)
	expect(t.fraction).toBeCloseTo(-0.5, 14)
	expect(t.scale).toBe(Timescale.UTC)

	t = timeYMDHMS(2025, 12, 31, 17, 59, 43.0, Timescale.TDB)
	expect(t.day).toBe(2461041)
	expect(t.fraction).toBeCloseTo(0.24980324074074078, 14)
	expect(t.scale).toBe(Timescale.TDB)
})

test('timeJulian', () => {
	const t = timeJulian(2024.0, Timescale.TCG)
	expect(t.day).toBe(2460311)
	expect(t.fraction).toBe(0)
	expect(t.scale).toBe(Timescale.TCG)
})

test('timeBesselian', () => {
	const t = timeBesselian(1950.0, Timescale.TCB)
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

	expect(ut1(t)).toMatchTime(time(2459130.0, 0.0, Timescale.UT1, false))
	// expect(utc(t)).toMatchTime(time(2459130.0, 0.000001988640612458, Timescale.UTC, false))
	// expect(tai(t)).toMatchTime(time(2459130.0, 0.000430229381353175, Timescale.TAI, false))
	// expect(tt(t)).toMatchTime(time(2459130.0, 0.000802729381353175, Timescale.TT, false))
	// expect(tcg(t)).toMatchTime(time(2459130.0, 0.000813870140404485, Timescale.TCG, false))
	// expect(tdb(t)).toMatchTime(time(2459130.0, 0.000802709826729233, Timescale.TDB, false))
	// expect(tcb(t)).toMatchTime(time(2459130.0, 0.001050568932858317, Timescale.TCB, false))
})

test('utc', () => {
	const t = timeYMDHMS(2020, 10, 7, 12, 0, 0, Timescale.UTC)
	expect(t.day).toBe(2459130)
	expect(t.fraction).toBe(0)

	// expect(ut1(t)).toMatchTime(time(2459130.0, -0.00000198864062497, Timescale.UT1, false))
	expect(utc(t)).toMatchTime(time(2459130.0, 0.0, Timescale.UTC, false))
	expect(tai(t)).toMatchTime(time(2459130.0, 0.000428240740740771, Timescale.TAI, false))
	expect(tt(t)).toMatchTime(time(2459130.0, 0.000800740740740771, Timescale.TT, false))
	expect(tcg(t)).toMatchTime(time(2459130.0, 0.000811881499790694, Timescale.TCG, false))
	expect(tdb(t)).toMatchTime(time(2459130.0, 0.000800721186116808, Timescale.TDB, false))
	expect(tcb(t)).toMatchTime(time(2459130.0, 0.001048580292215058, Timescale.TCB, false))
})

test('tai', () => {
	const t = timeYMDHMS(2020, 10, 7, 12, 0, 0, Timescale.TAI)
	expect(t.day).toBe(2459130)
	expect(t.fraction).toBe(0)

	// expect(ut1(t)).toMatchTime(time(2459130.0, -0.000430229384066532, Timescale.UT1, false))
	expect(utc(t)).toMatchTime(time(2459130.0, -0.000428240740740715, Timescale.UTC, false))
	expect(tai(t)).toMatchTime(time(2459130.0, 0.0, Timescale.TAI, false))
	expect(tt(t)).toMatchTime(time(2459130.0, 0.0003725, Timescale.TT, false))
	expect(tcg(t)).toMatchTime(time(2459130.0, 0.00038364075875147, Timescale.TCG, false))
	expect(tdb(t)).toMatchTime(time(2459130.0, 0.000372480445371678, Timescale.TDB, false))
	expect(tcb(t)).toMatchTime(time(2459130.0, 0.000620339544829971, Timescale.TCB, false))
})

test('tt', () => {
	const t = timeYMDHMS(2020, 10, 7, 12, 0, 0, Timescale.TT)
	expect(t.day).toBe(2459130)
	expect(t.fraction).toBe(0)

	// expect(ut1(t)).toMatchTime(time(2459130.0, -0.000802729386415781, Timescale.UT1, false))
	expect(utc(t)).toMatchTime(time(2459130.0, -0.000800740740740721, Timescale.UTC, false))
	expect(tai(t)).toMatchTime(time(2459130.0, -0.0003725, Timescale.TAI, false))
	expect(tt(t)).toMatchTime(time(2459130.0, 0.0, Timescale.TT, false))
	expect(tcg(t)).toMatchTime(time(2459130.0, 0.000011140758491864, Timescale.TCG, false))
	expect(tdb(t)).toMatchTime(time(2459130.0, -0.000000019554632113, Timescale.TDB, false))
	expect(tcb(t)).toMatchTime(time(2459130.0, 0.000247839539050494, Timescale.TCB, false))
})

test('tcg', () => {
	const t = timeYMDHMS(2020, 10, 7, 12, 0, 0, Timescale.TCG)
	expect(t.day).toBe(2459130)
	expect(t.fraction).toBe(0)

	// expect(ut1(t)).toMatchTime(time(2459130.0, -0.000813870144970116, Timescale.UT1, false))
	expect(utc(t)).toMatchTime(time(2459130.0, -0.000811881499224787, Timescale.UTC, false))
	expect(tai(t)).toMatchTime(time(2459130.0, -0.0003836407584841, Timescale.TAI, false))
	expect(tt(t)).toMatchTime(time(2459130.0, -0.0000111407584841, Timescale.TT, false))
	expect(tcg(t)).toMatchTime(time(2459130.0, 0.0, Timescale.TCG, false))
	expect(tdb(t)).toMatchTime(time(2459130.0, -0.000011160313116326, Timescale.TDB, false))
	expect(tcb(t)).toMatchTime(time(2459130.0, 0.000236698780393541, Timescale.TCB, false))
})

test('tdb', () => {
	const t = timeYMDHMS(2020, 10, 7, 12, 0, 0, Timescale.TDB)
	expect(t.day).toBe(2459130)
	expect(t.fraction).toBe(0)

	// expect(ut1(t)).toMatchTime(time(2459130.0, -0.000802709831783577, Timescale.UT1, false))
	expect(utc(t)).toMatchTime(time(2459130.0, -0.000800721186108623, Timescale.UTC, false))
	expect(tai(t)).toMatchTime(time(2459130.0, -0.000372480445367887, Timescale.TAI, false))
	expect(tt(t)).toMatchTime(time(2459130.0, 0.000000019554632113, Timescale.TT, false))
	expect(tcg(t)).toMatchTime(time(2459130.0, 0.00001116031312399, Timescale.TCG, false))
	expect(tdb(t)).toMatchTime(time(2459130.0, 0.0, Timescale.TDB, false))
	expect(tcb(t)).toMatchTime(time(2459130.0, 0.00024785909368291, Timescale.TCB, false))
})

test('tcb', () => {
	const t = timeYMDHMS(2020, 10, 7, 12, 0, 0, Timescale.TCB)
	expect(t.day).toBe(2459130)
	expect(t.fraction).toBe(0)

	// expect(ut1(t)).toMatchTime(time(2459130.0, -0.001050568923184019, Timescale.UT1, false))
	expect(utc(t)).toMatchTime(time(2459130.0, -0.001048580275945906, Timescale.UTC, false))
	expect(tai(t)).toMatchTime(time(2459130.0, -0.000620339535205171, Timescale.TAI, false))
	expect(tt(t)).toMatchTime(time(2459130.0, -0.000247839535205171, Timescale.TT, false))
	expect(tcg(t)).toMatchTime(time(2459130.0, -0.000236698776886034, Timescale.TCG, false))
	expect(tdb(t)).toMatchTime(time(2459130.0, -0.000247859089839806, Timescale.TDB, false))
	expect(tcb(t)).toMatchTime(time(2459130.0, 0.0, Timescale.TCB, false))
})

test('tdbMinusTtByFairheadAndBretagnon1990', () => {
	expect(tdbMinusTtByFairheadAndBretagnon1990(time(2448031, 0.5, Timescale.TDB))).toBeCloseTo(0.0011585185926349208, 16)

	const t0 = timeYMDHMS(2020, 10, 7, 12, 0, 0, Timescale.TDB)
	t0.tdbMinusTt = tdbMinusTtByFairheadAndBretagnon1990
	expect(tt(t0)).toMatchTime(time(2459130.0, 0.000000019554632113, Timescale.TT, false), 1e-10)

	const t1 = timeYMDHMS(2020, 10, 7, 12, 0, 0, Timescale.TT)
	t1.tdbMinusTt = tdbMinusTtByFairheadAndBretagnon1990
	expect(tdb(t1)).toMatchTime(time(2459130.0, -0.000000019554632113, Timescale.TDB, false), 1e-10)

	expect(tdbMinusTtByFairheadAndBretagnon1990(t0)).toBeCloseTo(tdbMinusTt(t0), 5)
})
