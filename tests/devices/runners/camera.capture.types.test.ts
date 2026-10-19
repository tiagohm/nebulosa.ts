import { expect, test } from 'bun:test'
import { type CameraExposureTimeUnit, exposureTimeIn, exposureTimeInMicroseconds, exposureTimeInMilliseconds, exposureTimeInMinutes, exposureTimeInSeconds, exposureTimeUnitFactor } from '../../../src/devices/runners/camera.capture.types'

const UNITS: readonly CameraExposureTimeUnit[] = ['minute', 'second', 'millisecond', 'microsecond']

test('counts each unit in one minute', () => {
	expect(UNITS.map(exposureTimeUnitFactor)).toEqual([1, 60, 60000, 60000000])
})

test('converts an exposure time to every unit', () => {
	expect(exposureTimeInMinutes(90, 'second')).toBe(1.5)
	expect(exposureTimeInSeconds(1.5, 'minute')).toBe(90)
	expect(exposureTimeInSeconds(250, 'millisecond')).toBe(0.25)
	expect(exposureTimeInSeconds(1000, 'microsecond')).toBe(0.001)
	expect(exposureTimeInMilliseconds(2, 'second')).toBe(2000)
	expect(exposureTimeInMilliseconds(1500, 'microsecond')).toBe(1.5)
	expect(exposureTimeInMicroseconds(1, 'minute')).toBe(60000000)
	expect(exposureTimeInMicroseconds(250, 'millisecond')).toBe(250000)
	expect(exposureTimeInMicroseconds(7, 'microsecond')).toBe(7)
})

test('round-trips between every pair of units', () => {
	for (const from of UNITS) {
		for (const to of UNITS) {
			expect(exposureTimeIn(exposureTimeIn(3.25, from, to), to, from)).toBeCloseTo(3.25, 12)
		}

		expect(exposureTimeIn(3.25, from, 'second')).toBeCloseTo(exposureTimeInSeconds(3.25, from), 12)
		expect(exposureTimeIn(3.25, from, from)).toBe(3.25)
	}
})

test('converts whole sub-second times to the nearest seconds', () => {
	expect(exposureTimeInSeconds(100, 'microsecond')).toBe(0.0001)
	expect(exposureTimeIn(100, 'microsecond', 'second')).toBe(0.0001)
	expect(exposureTimeInSeconds(1, 'microsecond')).toBe(0.000001)
	expect(exposureTimeInMicroseconds(0.0001, 'second')).toBe(100)

	for (let i = 1; i <= 10000; i++) {
		expect(exposureTimeInSeconds(i, 'microsecond')).toBe(i / 1000000)
	}
})
