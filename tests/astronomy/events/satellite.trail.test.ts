import { expect, test } from 'bun:test'
import { sensorTrails } from '../../../src/astronomy/events/satellite.trail'
import { ARCSEC_PER_RADIAN, DEG2RAD, PIOVERTWO, TAU } from '../../../src/core/constants'

test('a straight equatorial track enters and leaves a one-degree sensor on the east-west edges', () => {
	const trails = sensorTrails(
		0,
		0,
		{ width: DEG2RAD, height: DEG2RAD },
		[
			{ time: 0, rightAscension: -DEG2RAD, declination: 0 },
			{ time: 1, rightAscension: DEG2RAD, declination: 0 },
		],
		{ arcsecPerPixel: 2 },
	)
	expect(trails).toHaveLength(1)
	expect(trails[0].entry.time).toBeCloseTo(0.25, 8)
	expect(trails[0].exit.time).toBeCloseTo(0.75, 8)
	expect(trails[0].entry.rightAscension).toBeCloseTo(TAU - 0.5 * DEG2RAD, 8)
	expect(trails[0].exit.rightAscension).toBeCloseTo(0.5 * DEG2RAD, 8)
	expect(trails[0].length).toBeCloseTo(DEG2RAD, 8)
	expect(trails[0].positionAngle).toBeCloseTo(PIOVERTWO, 8)
	expect(trails[0].lengthPixels).toBeCloseTo((DEG2RAD * ARCSEC_PER_RADIAN) / 2, 6)
	expect(
		sensorTrails(0, 0, { width: 0.1 * DEG2RAD, height: 0.1 * DEG2RAD }, [
			{ time: 0, rightAscension: DEG2RAD, declination: DEG2RAD },
			{ time: 1, rightAscension: 2 * DEG2RAD, declination: DEG2RAD },
		]),
	).toEqual([])
})

test('samples that stay on the sensor join into one chord', () => {
	const trails = sensorTrails(0, 0, { width: 5 * DEG2RAD, height: 5 * DEG2RAD }, [
		{ time: 0, rightAscension: -DEG2RAD, declination: 0 },
		{ time: 1, rightAscension: 0, declination: 0 },
		{ time: 2, rightAscension: DEG2RAD, declination: 0 },
	])
	expect(trails).toHaveLength(1)
	expect(trails[0].entry.time).toBeCloseTo(0, 12)
	expect(trails[0].exit.time).toBeCloseTo(2, 12)
	expect(trails[0].length).toBeCloseTo(2 * DEG2RAD, 8)
})
