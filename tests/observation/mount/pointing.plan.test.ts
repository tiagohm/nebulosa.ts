import { describe, expect, test } from 'bun:test'
import { sphericalSeparation } from '../../../src/math/numerical/geometry'
import { deg } from '../../../src/math/units/angle'
import { planPointingWaypoints, type PointingPlanOptions, type PointingWaypoint } from '../../../src/observation/mount/pointing.plan'

const SITE: Pick<PointingPlanOptions, 'latitude'> = { latitude: deg(-23) }

// Sum of the slews of a plan, in radians.
function pathLength(waypoints: readonly PointingWaypoint[]) {
	let length = 0
	for (let i = 1; i < waypoints.length; i++) length += sphericalSeparation(waypoints[i - 1].hourAngle, waypoints[i - 1].declination, waypoints[i].hourAngle, waypoints[i].declination)
	return length
}

// Smallest separation between two waypoints, in radians.
function smallestSeparation(waypoints: readonly PointingWaypoint[]) {
	let smallest = Number.POSITIVE_INFINITY

	for (let i = 0; i < waypoints.length; i++) {
		for (let j = i + 1; j < waypoints.length; j++) {
			smallest = Math.min(smallest, sphericalSeparation(waypoints[i].hourAngle, waypoints[i].declination, waypoints[j].hourAngle, waypoints[j].declination))
		}
	}

	return smallest
}

describe.each(['altAzGrid', 'goldenSpiral'] as const)('%s', (pattern) => {
	test('is deterministic and holds the waypoints asked for', () => {
		const plan = planPointingWaypoints({ ...SITE, pattern, count: 30 })
		expect(plan.waypoints).toHaveLength(30)
		expect(plan.requestedCount).toBe(30)
		expect(planPointingWaypoints({ ...SITE, pattern, count: 30 })).toEqual(plan)
		expect(plan.waypoints.map((waypoint) => waypoint.index)).toEqual(Array.from({ length: 30 }, (_, index) => index))
	})

	test('keeps a usable spacing without stacking the zenith', () => {
		const { waypoints } = planPointingWaypoints({ ...SITE, pattern, count: 60 })
		expect(smallestSeparation(waypoints)).toBeGreaterThan(deg(6))
		expect(waypoints.filter((waypoint) => waypoint.altitude > deg(70)).length).toBeLessThan(waypoints.length / 4)
	})

	test('stays inside the altitudes, meridian band, horizon, and limits', () => {
		const horizon = [
			{ azimuth: deg(0), minimumAltitude: deg(45) },
			{ azimuth: deg(90), minimumAltitude: deg(10) },
			{ azimuth: deg(180), minimumAltitude: deg(10) },
			{ azimuth: deg(270), minimumAltitude: deg(10) },
		]

		const { waypoints } = planPointingWaypoints({ ...SITE, pattern, count: 40, minimumAltitude: deg(25), maximumAltitude: deg(80), meridianAvoidance: deg(10), horizon, limits: { declination: [deg(-75), deg(40)] } })

		expect(waypoints).toHaveLength(40)

		for (const waypoint of waypoints) {
			expect(waypoint.altitude).toBeGreaterThanOrEqual(deg(25))
			expect(waypoint.altitude).toBeLessThanOrEqual(deg(80))
			expect(Math.abs(waypoint.hourAngle)).toBeGreaterThanOrEqual(deg(10))
			expect(waypoint.declination).toBeGreaterThanOrEqual(deg(-75))
			expect(waypoint.declination).toBeLessThanOrEqual(deg(40))
			if (waypoint.azimuth < deg(1)) expect(waypoint.altitude).toBeGreaterThanOrEqual(deg(44))
		}
	})

	test('reports the waypoints an allowed sky too small could not hold', () => {
		const plan = planPointingWaypoints({ ...SITE, pattern, count: 30, limits: { azimuth: [deg(10), deg(12)], altitude: [deg(30), deg(31)] } })
		expect(plan.requestedCount).toBe(30)
		expect(plan.waypoints.length).toBeLessThan(30)
	})

	test('spreads the withheld waypoints over both sides of the meridian', () => {
		const plan = planPointingWaypoints({ ...SITE, pattern, count: 40 })
		const heldOut = plan.waypoints.filter((waypoint) => waypoint.role === 'heldOut')
		expect(plan.heldOutCount).toBe(8)
		expect(heldOut).toHaveLength(8)
		expect(heldOut.some((waypoint) => waypoint.hourAngle >= 0)).toBeTrue()
		expect(heldOut.some((waypoint) => waypoint.hourAngle < 0)).toBeTrue()
		expect(smallestSeparation(heldOut)).toBeGreaterThan(deg(10))
	})
})

test('finishes one side of the meridian before the other, so the mount flips at most once', () => {
	const { waypoints, pierSideCounts } = planPointingWaypoints({ ...SITE, pattern: 'goldenSpiral', count: 30 })
	const sides = waypoints.map((waypoint) => waypoint.expectedPierSide)
	expect(sides.filter((side, index) => index > 0 && side !== sides[index - 1])).toHaveLength(1)
	expect(pierSideCounts.EAST + pierSideCounts.WEST).toBe(30)
	expect(pierSideCounts.EAST).toBeGreaterThan(0)
	expect(pierSideCounts.WEST).toBeGreaterThan(0)
})

test('expects the pier side opposite the side of the sky', () => {
	for (const waypoint of planPointingWaypoints({ ...SITE, pattern: 'altAzGrid', count: 20 }).waypoints) {
		expect(waypoint.expectedPierSide).toBe(waypoint.hourAngle > 0 ? 'EAST' : 'WEST')
	}
})

test('orders the slews much shorter than a sky-order traversal', () => {
	const { waypoints } = planPointingWaypoints({ ...SITE, pattern: 'goldenSpiral', count: 40 })
	const skyOrder = waypoints.toSorted((a, b) => b.altitude - a.altitude)
	expect(pathLength(waypoints)).toBeLessThan(pathLength(skyOrder) / 2)
})

test('starts from the position of the mount, on its side of the meridian', () => {
	const start = { hourAngle: deg(-60), declination: deg(-30) }
	const [first] = planPointingWaypoints({ ...SITE, pattern: 'goldenSpiral', count: 30, start }).waypoints
	expect(first.hourAngle).toBeLessThan(0)
	expect(sphericalSeparation(start.hourAngle, start.declination, first.hourAngle, first.declination)).toBeLessThan(deg(30))
})

test('withholds at most a third of a small plan', () => {
	const plan = planPointingWaypoints({ ...SITE, pattern: 'altAzGrid', count: 9 })
	expect(plan.heldOutCount).toBe(3)
})

test('withholds no waypoint when asked for none', () => {
	expect(planPointingWaypoints({ ...SITE, pattern: 'altAzGrid', count: 20, heldOutFraction: 0, minimumHeldOut: 0 }).heldOutCount).toBe(0)
})

test('plans the sky of both hemispheres and of the equator', () => {
	for (const latitude of [deg(52), deg(0), deg(-60)]) {
		const { waypoints } = planPointingWaypoints({ latitude, pattern: 'altAzGrid', count: 24 })
		expect(waypoints).toHaveLength(24)
		for (const waypoint of waypoints) expect(Number.isFinite(waypoint.hourAngle + waypoint.declination)).toBeTrue()
	}
})
