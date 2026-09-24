import { expect, test } from 'bun:test'
import { icrs } from '../../../src/astronomy/coordinates/icrs'
import { earth, sun } from '../../../src/astronomy/ephemeris/models/analytical/vsop87e'
import { ASTRONOMICAL_TWILIGHT, riseTransitSet } from '../../../src/astronomy/events/horizon'
import { visibilityWindows } from '../../../src/astronomy/events/visibility'
import { airmassKastenYoung } from '../../../src/astronomy/formulas'
import { Ellipsoid, geodeticLocation } from '../../../src/astronomy/observer/location'
import { type Time, Timescale, timeShift, timeSubtract, timeYMDHMS } from '../../../src/astronomy/time/time'
import { type Vec3, vecMinus } from '../../../src/math/linear-algebra/vec3'
import { deg, hms } from '../../../src/math/units/angle'
import { kilometer } from '../../../src/math/units/distance'

const SITE = geodeticLocation(deg(-46.633), deg(-23.55), kilometer(0.76), Ellipsoid.WGS84)
const DAY = timeYMDHMS(2026, 6, 29, 0, 0, 0, Timescale.UTC)
const SIRIUS = icrs(hms(6, 45, 8.917), deg(-16.716116))

function sunDirection(time: Time) {
	return vecMinus(sun(time)[0], earth(time)[0])
}

function secondsBetween(a: Time, b: Time) {
	return Math.abs(timeSubtract(a, b) * 86400)
}

test('an altitude limit agrees with rise and set, and airmass uses the same altitude', () => {
	const end = timeShift(DAY, 1)
	const altitude = deg(30)
	const byAltitude = visibilityWindows(() => SIRIUS, SITE, DAY, end, { minimumAltitude: altitude })
	const riseSet = riseTransitSet(() => SIRIUS, SITE, DAY, { horizon: altitude })
	if (riseSet.rise === undefined || riseSet.set === undefined) throw new Error('expected altitude crossings')
	expect(byAltitude).toHaveLength(1)
	expect(secondsBetween(byAltitude[0].start, riseSet.rise)).toBeLessThan(2)
	expect(secondsBetween(byAltitude[0].end, riseSet.set)).toBeLessThan(2)

	const byAirmass = visibilityWindows(() => SIRIUS, SITE, DAY, end, { maximumAirmass: airmassKastenYoung(altitude) })
	expect(secondsBetween(byAirmass[0].start, byAltitude[0].start)).toBeLessThan(2)
	expect(secondsBetween(byAirmass[0].end, byAltitude[0].end)).toBeLessThan(2)
})

test('solar altitude and lunar separation add and remove stretches', () => {
	const end = timeShift(DAY, 1)
	const solar = visibilityWindows(() => SIRIUS, SITE, DAY, end, { maximumSunAltitude: ASTRONOMICAL_TWILIGHT }, { sunAt: sunDirection })
	const dusk = riseTransitSet(sunDirection, SITE, DAY, { horizon: ASTRONOMICAL_TWILIGHT })
	if (dusk.rise === undefined) throw new Error('expected morning twilight crossing')
	expect(solar.length).toBeGreaterThan(0)
	expect(secondsBetween(solar[0].end, dusk.rise)).toBeLessThan(2)

	const same = () => SIRIUS
	expect(visibilityWindows(same, SITE, DAY, end, { minimumMoonSeparation: deg(10) }, { moonAt: same })).toEqual([])
	const perpendicular = (): Vec3 => [0, 0, 1]
	expect(visibilityWindows(() => [1, 0, 0], SITE, DAY, end, { minimumMoonSeparation: deg(10) }, { moonAt: perpendicular })).toHaveLength(1)
	expect(() => visibilityWindows(same, SITE, DAY, end, { maximumSunAltitude: 0 })).toThrow('sun direction is required')
	expect(visibilityWindows(same, SITE, DAY, end, { maximumAirmass: 0.5 })).toEqual([])
})
