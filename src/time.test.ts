import { expect, test } from 'bun:test'
import { J2000 } from './constants'
import { time, timeJulian, timeMJD, timeUnix, timeYMDHMS } from './time'

test('time', () => {
	const t = time(2449353.623)
	expect(t[0]).toBe(2449354)
	expect(t[1]).toBeCloseTo(-0.377, 3)
})

test('timeUnix', () => {
	let t = timeUnix(0)
	expect(t[0]).toBe(2440588)
	expect(t[1]).toBe(-0.5)

	t = timeUnix(946684800)
	expect(t[0]).toBe(J2000)
	expect(t[1]).toBe(-0.5)
})

test('timeMJD', () => {
	const t = timeMJD(51544.0)
	expect(t[0]).toBe(J2000)
	expect(t[1]).toBe(-0.5)
})

test('timeYMDHMS', () => {
	let t = timeYMDHMS(2022, 1, 1, 12, 0, 0.0)
	expect(t[0]).toBe(2459581)
	expect(t[1]).toBeCloseTo(0, 14)

	t = timeYMDHMS(2023, 6, 1, 23, 59, 59.0)
	expect(t[0]).toBe(2460097)
	expect(t[1]).toBeCloseTo(0.49998842592592596, 14)

	t = timeYMDHMS(2024, 1, 1, 0, 0, 0.0)
	expect(t[0]).toBe(2460311)
	expect(t[1]).toBeCloseTo(-0.5, 14)

	t = timeYMDHMS(2025, 12, 31, 17, 59, 43.0)
	expect(t[0]).toBe(2461041)
	expect(t[1]).toBeCloseTo(0.24980324074074078, 14)
})

test('timeJulian', () => {
	const t = timeJulian(2024.0)
	expect(t[0]).toBe(2460311)
	expect(t[1]).toBe(0)
})
