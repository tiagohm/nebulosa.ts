import { expect, test, type CustomMatcher } from 'bun:test'
import { J2000 } from './constants'
import { normalize, tai, tcb, tcg, tdb, time, timeBesselian, timeGPS, timeJulian, timeMJD, Timescale, timeUnix, timeYMDHMS, tt, ut1, utc, type Time } from './time'

const toMatchTime: CustomMatcher<Time, Time[]> = (actual, expected) => {
	const b = normalize(expected[0], expected[1])

	if (actual[0] !== b[0]) {
		return { pass: false, message: () => `failed to match day. expected ${b[0]}, but ${actual[0]}` }
	}
	if (Math.abs(actual[1] - b[1]) > 1e-16) {
		return { pass: false, message: () => `failed to match fraction of day. expected ${b[1]}, but ${actual[1]}` }
	}
	if (actual[2] !== expected[2]) {
		return { pass: false, message: () => `failed to match timescale. expected ${expected[2]}, but ${actual[2]}` }
	}

	return { pass: true }
}

expect.extend({
	toMatchTime: toMatchTime as CustomMatcher<unknown, unknown[]>,
})

declare module 'bun:test' {
	interface Matchers {
		toMatchTime(expected: Time): void
	}
}

test('time', () => {
	const t = time(2449353.623, 0, Timescale.TT)
	expect(t[0]).toBe(2449354)
	expect(t[1]).toBeCloseTo(-0.377, 3)
	expect(t[2]).toBe(Timescale.TT)
})

test('timeUnix', () => {
	let t = timeUnix(0)
	expect(t[0]).toBe(2440588)
	expect(t[1]).toBe(-0.5)
	expect(t[2]).toBe(Timescale.UTC)

	t = timeUnix(946684800, Timescale.TAI)
	expect(t[0]).toBe(J2000)
	expect(t[1]).toBe(-0.5)
	expect(t[2]).toBe(Timescale.TAI)
})

test('timeMJD', () => {
	const t = timeMJD(51544.0, Timescale.UT1)
	expect(t[0]).toBe(J2000)
	expect(t[1]).toBe(-0.5)
	expect(t[2]).toBe(Timescale.UT1)
})

test('timeYMDHMS', () => {
	let t = timeYMDHMS(2022, 1, 1, 12, 0, 0.0)
	expect(t[0]).toBe(2459581)
	expect(t[1]).toBeCloseTo(0, 14)
	expect(t[2]).toBe(Timescale.UTC)

	t = timeYMDHMS(2023, 6, 1, 23, 59, 59.0)
	expect(t[0]).toBe(2460097)
	expect(t[1]).toBeCloseTo(0.49998842592592596, 14)
	expect(t[2]).toBe(Timescale.UTC)

	t = timeYMDHMS(2024, 1, 1, 0, 0, 0.0)
	expect(t[0]).toBe(2460311)
	expect(t[1]).toBeCloseTo(-0.5, 14)
	expect(t[2]).toBe(Timescale.UTC)

	t = timeYMDHMS(2025, 12, 31, 17, 59, 43.0, Timescale.TDB)
	expect(t[0]).toBe(2461041)
	expect(t[1]).toBeCloseTo(0.24980324074074078, 14)
	expect(t[2]).toBe(Timescale.TDB)
})

test('timeJulian', () => {
	const t = timeJulian(2024.0, Timescale.TCG)
	expect(t[0]).toBe(2460311)
	expect(t[1]).toBe(0)
	expect(t[2]).toBe(Timescale.TCG)
})

test('timeBesselian', () => {
	const t = timeBesselian(1950.0, Timescale.TCB)
	expect(t[0]).toBe(2433282)
	expect(t[1]).toBe(0.42345904977992177)
	expect(t[2]).toBe(Timescale.TCB)
})

test('timGPS', () => {
	const t = timeGPS(630720013)
	expect(t[0]).toBe(J2000)
	expect(t[1]).toBe(-0.4996296167373657)
	expect(t[2]).toBe(Timescale.TAI)
})

test('ut1', () => {
	const time = timeYMDHMS(2020, 10, 7, 12, 0, 0, Timescale.UT1)
	expect(time[0]).toBe(2459130)
	expect(time[1]).toBe(0)

	expect(ut1(time)).toMatchTime([2459130.0, 0.0, Timescale.UT1])
	// expect(utc(time)).toMatchTime([2459130.0, 0.000001988640612458, Timescale.UTC])
	// expect(tai(time)).toMatchTime([2459130.0, 0.000430229381353175, Timescale.TAI])
	// expect(tt(time)).toMatchTime([2459130.0, 0.000802729381353175, Timescale.TT])
	// expect(tcg(time)).toMatchTime([2459130.0, 0.000813870140404485, Timescale.TCG])
	// expect(tdb(time)).toMatchTime([2459130.0, 0.000802709826729233, Timescale.TDB])
	// expect(tcb(time)).toMatchTime([2459130.0, 0.001050568932858317, Timescale.TCB])
})

test('utc', () => {
	const time = timeYMDHMS(2020, 10, 7, 12, 0, 0, Timescale.UTC)
	expect(time[0]).toBe(2459130)
	expect(time[1]).toBe(0)

	// expect(ut1(time)).toMatchTime([2459130.0, -0.00000198864062497, Timescale.UT1])
	expect(utc(time)).toMatchTime([2459130.0, 0.0, Timescale.UTC])
	expect(tai(time)).toMatchTime([2459130.0, 0.000428240740740771, Timescale.TAI])
	expect(tt(time)).toMatchTime([2459130.0, 0.000800740740740771, Timescale.TT])
	expect(tcg(time)).toMatchTime([2459130.0, 0.000811881499790694, Timescale.TCG])
	expect(tdb(time)).toMatchTime([2459130.0, 0.000800721186116808, Timescale.TDB])
	expect(tcb(time)).toMatchTime([2459130.0, 0.001048580292215058, Timescale.TCB])
})

test('tai', () => {
	const time = timeYMDHMS(2020, 10, 7, 12, 0, 0, Timescale.TAI)
	expect(time[0]).toBe(2459130)
	expect(time[1]).toBe(0)

	// expect(ut1(time)).toMatchTime([2459130.0, -0.000430229384066532, Timescale.UT1])
	expect(utc(time)).toMatchTime([2459130.0, -0.000428240740740715, Timescale.UTC])
	expect(tai(time)).toMatchTime([2459130.0, 0.0, Timescale.TAI])
	expect(tt(time)).toMatchTime([2459130.0, 0.0003725, Timescale.TT])
	expect(tcg(time)).toMatchTime([2459130.0, 0.00038364075875147, Timescale.TCG])
	expect(tdb(time)).toMatchTime([2459130.0, 0.000372480445371678, Timescale.TDB])
	expect(tcb(time)).toMatchTime([2459130.0, 0.000620339544829971, Timescale.TCB])
})

test('tt', () => {
	const time = timeYMDHMS(2020, 10, 7, 12, 0, 0, Timescale.TT)
	expect(time[0]).toBe(2459130)
	expect(time[1]).toBe(0)

	// expect(ut1(time)).toMatchTime([2459130.0, -0.000802729386415781, Timescale.UT1])
	expect(utc(time)).toMatchTime([2459130.0, -0.000800740740740721, Timescale.UTC])
	expect(tai(time)).toMatchTime([2459130.0, -0.0003725, Timescale.TAI])
	expect(tt(time)).toMatchTime([2459130.0, 0.0, Timescale.TT])
	expect(tcg(time)).toMatchTime([2459130.0, 0.000011140758491864, Timescale.TCG])
	expect(tdb(time)).toMatchTime([2459130.0, -0.000000019554632113, Timescale.TDB])
	expect(tcb(time)).toMatchTime([2459130.0, 0.000247839539050494, Timescale.TCB])
})

test('tcg', () => {
	const time = timeYMDHMS(2020, 10, 7, 12, 0, 0, Timescale.TCG)
	expect(time[0]).toBe(2459130)
	expect(time[1]).toBe(0)

	// expect(ut1(time)).toMatchTime([2459130.0, -0.000813870144970116, Timescale.UT1])
	expect(utc(time)).toMatchTime([2459130.0, -0.000811881499224787, Timescale.UTC])
	expect(tai(time)).toMatchTime([2459130.0, -0.0003836407584841, Timescale.TAI])
	expect(tt(time)).toMatchTime([2459130.0, -0.0000111407584841, Timescale.TT])
	expect(tcg(time)).toMatchTime([2459130.0, 0.0, Timescale.TCG])
	expect(tdb(time)).toMatchTime([2459130.0, -0.000011160313116326, Timescale.TDB])
	expect(tcb(time)).toMatchTime([2459130.0, 0.000236698780393541, Timescale.TCB])
})

test('tdb', () => {
	const time = timeYMDHMS(2020, 10, 7, 12, 0, 0, Timescale.TDB)
	expect(time[0]).toBe(2459130)
	expect(time[1]).toBe(0)

	// expect(ut1(time)).toMatchTime([2459130.0, -0.000802709831783577, Timescale.UT1])
	expect(utc(time)).toMatchTime([2459130.0, -0.000800721186108623, Timescale.UTC])
	expect(tai(time)).toMatchTime([2459130.0, -0.000372480445367887, Timescale.TAI])
	expect(tt(time)).toMatchTime([2459130.0, 0.000000019554632113, Timescale.TT])
	expect(tcg(time)).toMatchTime([2459130.0, 0.00001116031312399, Timescale.TCG])
	expect(tdb(time)).toMatchTime([2459130.0, 0.0, Timescale.TDB])
	expect(tcb(time)).toMatchTime([2459130.0, 0.00024785909368291, Timescale.TCB])
})

test('tcb', () => {
	const time = timeYMDHMS(2020, 10, 7, 12, 0, 0, Timescale.TCB)
	expect(time[0]).toBe(2459130)
	expect(time[1]).toBe(0)

	// expect(ut1(time)).toMatchTime([2459130.0, -0.001050568923184019, Timescale.UT1])
	expect(utc(time)).toMatchTime([2459130.0, -0.001048580275945906, Timescale.UTC])
	expect(tai(time)).toMatchTime([2459130.0, -0.000620339535205171, Timescale.TAI])
	expect(tt(time)).toMatchTime([2459130.0, -0.000247839535205171, Timescale.TT])
	expect(tcg(time)).toMatchTime([2459130.0, -0.000236698776886034, Timescale.TCG])
	expect(tdb(time)).toMatchTime([2459130.0, -0.000247859089839806, Timescale.TDB])
	expect(tcb(time)).toMatchTime([2459130.0, 0.0, Timescale.TCB])
})
