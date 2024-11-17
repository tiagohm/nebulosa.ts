import { expect, test } from 'bun:test'
import { J2000 } from './constants'
import { time, timeMJD, timeUnix } from './time'

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
