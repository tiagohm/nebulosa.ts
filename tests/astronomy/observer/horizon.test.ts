import { expect, test } from 'bun:test'
import { horizonCrossings, horizonMinimumAltitude, isAboveHorizon } from '../../../src/astronomy/observer/horizon'
import { DEG2RAD, PI, PIOVERFOUR, PIOVERTWO } from '../../../src/core/constants'

test('horizon altitude interpolates around the circle and an empty mask clears the sky', () => {
	const mask = [
		{ azimuth: PI, minimumAltitude: 30 * DEG2RAD },
		{ azimuth: 0, minimumAltitude: 10 * DEG2RAD },
	]
	expect(horizonMinimumAltitude(mask, PIOVERTWO)).toBeCloseTo(20 * DEG2RAD, 12)
	expect(horizonMinimumAltitude(mask, 0)).toBeCloseTo(10 * DEG2RAD, 12)
	expect(horizonMinimumAltitude([], 0)).toBeCloseTo(-PIOVERTWO, 12)
	expect(isAboveHorizon(mask, 20 * DEG2RAD, PIOVERTWO)).toBeTrue()
	expect(isAboveHorizon(mask, 19 * DEG2RAD, PIOVERTWO)).toBeFalse()
	expect(isAboveHorizon([], 0, 0)).toBeTrue()
})

test('a path reports the instants it passes behind the mask and comes back out', () => {
	const mask = [
		{ azimuth: 0, minimumAltitude: 10 * DEG2RAD },
		{ azimuth: PI, minimumAltitude: 30 * DEG2RAD },
	]
	const crossings = horizonCrossings(
		[
			{ time: 1, altitude: 15 * DEG2RAD, azimuth: PI },
			{ time: 0, altitude: 15 * DEG2RAD, azimuth: 0 },
		],
		mask,
	)
	expect(crossings).toHaveLength(1)
	expect(crossings[0]?.kind).toBe('set')
	expect(crossings[0]?.time).toBeCloseTo(0.25, 6)
	expect(crossings[0]?.azimuth).toBeCloseTo(PIOVERFOUR, 6)

	const rising = horizonCrossings(
		[
			{ time: 0, altitude: 15 * DEG2RAD, azimuth: PI },
			{ time: 1, altitude: 15 * DEG2RAD, azimuth: 0 },
		],
		mask,
	)
	expect(rising[0]?.kind).toBe('rise')
	expect(horizonCrossings([{ time: 0, altitude: 0, azimuth: 0 }], mask)).toEqual([])
})
