import { expect, test } from 'bun:test'
import { horizonCrossings, horizonMinimumAltitude, isAboveHorizon } from '../../../src/astronomy/observer/horizon'
import { DEG2RAD, PI, PIOVERFOUR, PIOVERTWO, TAU } from '../../../src/core/constants'

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

test('internal horizon knots can produce multiple crossings in one path segment', () => {
	const peak = [
		{ azimuth: 0, minimumAltitude: 0 },
		{ azimuth: 1, minimumAltitude: 30 * DEG2RAD },
		{ azimuth: 2, minimumAltitude: 0 },
	]
	const acrossPeak = horizonCrossings(
		[
			{ time: 0, altitude: 15 * DEG2RAD, azimuth: 0 },
			{ time: 1, altitude: 15 * DEG2RAD, azimuth: 2 },
		],
		peak,
	)
	expect(acrossPeak.map((crossing) => crossing.kind)).toEqual(['set', 'rise'])
	expect(acrossPeak.map((crossing) => crossing.time)).toEqual([0.25, 0.75])

	const valley = peak.map((sample) => ({ azimuth: sample.azimuth, minimumAltitude: 30 * DEG2RAD - sample.minimumAltitude }))
	const acrossValley = horizonCrossings(
		[
			{ time: 0, altitude: 15 * DEG2RAD, azimuth: 0 },
			{ time: 1, altitude: 15 * DEG2RAD, azimuth: 2 },
		],
		valley,
	)
	expect(acrossValley.map((crossing) => crossing.kind)).toEqual(['rise', 'set'])
	expect(acrossValley.map((crossing) => crossing.time)).toEqual([0.25, 0.75])
})

test('horizon crossings honor knots across north and do not duplicate a tangential knot', () => {
	const mask = [
		{ azimuth: TAU - 1, minimumAltitude: 0 },
		{ azimuth: 0, minimumAltitude: 30 * DEG2RAD },
		{ azimuth: 1, minimumAltitude: 0 },
	]
	const crossings = horizonCrossings(
		[
			{ time: 0, altitude: 15 * DEG2RAD, azimuth: TAU - 1 },
			{ time: 1, altitude: 15 * DEG2RAD, azimuth: 1 },
		],
		mask,
	)
	expect(crossings.map((crossing) => crossing.kind)).toEqual(['set', 'rise'])
	expect(crossings.map((crossing) => crossing.time)).toEqual([0.25, 0.75])

	const tangent = mask.map((sample) => (sample.azimuth === 0 ? { azimuth: sample.azimuth, minimumAltitude: 15 * DEG2RAD } : sample))
	expect(
		horizonCrossings(
			[
				{ time: 0, altitude: 15 * DEG2RAD, azimuth: TAU - 1 },
				{ time: 1, altitude: 15 * DEG2RAD, azimuth: 1 },
			],
			tangent,
		),
	).toEqual([])
})

test('one path segment is split at every horizon knot', () => {
	const mask = [0, 0.5, 1, 1.5, 2].map((azimuth, index) => ({ azimuth, minimumAltitude: (index % 2) * 30 * DEG2RAD }))
	const crossings = horizonCrossings(
		[
			{ time: 0, altitude: 15 * DEG2RAD, azimuth: 0 },
			{ time: 1, altitude: 15 * DEG2RAD, azimuth: 2 },
		],
		mask,
	)
	expect(crossings.map((crossing) => crossing.kind)).toEqual(['set', 'rise', 'set', 'rise'])
	expect(crossings.map((crossing) => crossing.time)).toEqual([0.125, 0.375, 0.625, 0.875])
})

test('a zero at a shared path sample is classified from both sides', () => {
	const horizon = [{ azimuth: 0, minimumAltitude: 0 }]
	const crossingsFor = (altitudes: readonly number[]) =>
		horizonCrossings(
			altitudes.map((altitude, time) => ({ time, altitude: altitude * DEG2RAD, azimuth: time })),
			horizon,
		).map((crossing) => crossing.kind)

	expect(crossingsFor([10, 0, 10])).toEqual([])
	expect(crossingsFor([-10, 0, -10])).toEqual([])
	expect(crossingsFor([10, 0, -10])).toEqual(['set'])
	expect(crossingsFor([-10, 0, 10])).toEqual(['rise'])
	expect(crossingsFor([10, 0, 0, 10])).toEqual([])
})
