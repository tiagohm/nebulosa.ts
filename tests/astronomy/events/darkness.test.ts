import { expect, test } from 'bun:test'
import { earth, sun } from '../../../src/astronomy/ephemeris/models/analytical/vsop87e'
import { darknessWindows } from '../../../src/astronomy/events/darkness'
import { ASTRONOMICAL_TWILIGHT, CIVIL_TWILIGHT, NAUTICAL_TWILIGHT, riseTransitSet } from '../../../src/astronomy/events/horizon'
import { Ellipsoid, geodeticLocation } from '../../../src/astronomy/observer/location'
import { type Time, Timescale, timeShift, timeSubtract, timeYMDHMS } from '../../../src/astronomy/time/time'
import { PIOVERTWO } from '../../../src/core/constants'
import { vecMinus } from '../../../src/math/linear-algebra/vec3'
import { deg } from '../../../src/math/units/angle'
import { kilometer } from '../../../src/math/units/distance'

const SITE = geodeticLocation(deg(-46.633), deg(-23.55), kilometer(0.76), Ellipsoid.WGS84)
const DAY = timeYMDHMS(2026, 6, 29, 0, 0, 0, Timescale.UTC)

function sunDirection(time: Time) {
	return vecMinus(sun(time)[0], earth(time)[0])
}

function secondsBetween(a: Time, b: Time) {
	return Math.abs(timeSubtract(a, b) * 86400)
}

test('twilight intervals nest and meet the rise and set of the same depression', () => {
	const windows = darknessWindows(sunDirection, SITE, DAY, timeShift(DAY, 1))
	const astronomical = riseTransitSet(sunDirection, SITE, DAY, { horizon: ASTRONOMICAL_TWILIGHT })
	if (astronomical.rise === undefined || astronomical.set === undefined) throw new Error('expected astronomical twilight crossings')
	expect(windows.astronomical).toHaveLength(2)
	expect(secondsBetween(windows.astronomical[0].end, astronomical.rise)).toBeLessThan(2)
	expect(secondsBetween(windows.astronomical[1].start, astronomical.set)).toBeLessThan(2)
	expect(timeSubtract(windows.nautical[0].end, windows.astronomical[0].end)).toBeGreaterThan(0)
	expect(timeSubtract(windows.civil[0].end, windows.nautical[0].end)).toBeGreaterThan(0)
	expect(windows.dark).toEqual(windows.astronomical)

	const civil = riseTransitSet(sunDirection, SITE, DAY, { horizon: CIVIL_TWILIGHT })
	const nautical = riseTransitSet(sunDirection, SITE, DAY, { horizon: NAUTICAL_TWILIGHT })
	if (civil.rise === undefined || nautical.rise === undefined) throw new Error('expected twilight crossings')
	expect(secondsBetween(windows.civil[0].end, civil.rise)).toBeLessThan(2)
	expect(secondsBetween(windows.nautical[0].end, nautical.rise)).toBeLessThan(2)
})

test('a lunar ceiling and an illumination ceiling cut only the dark intervals', () => {
	const end = timeShift(DAY, 1)
	const moonAt = () => sunDirection(DAY)
	expect(darknessWindows(sunDirection, SITE, DAY, end, { moonAt, maximumMoonAltitude: -PIOVERTWO }).dark).toEqual([])
	const allowed = darknessWindows(sunDirection, SITE, DAY, end, { moonAt, maximumMoonAltitude: PIOVERTWO })
	expect(allowed.dark).toEqual(allowed.astronomical)
	expect(darknessWindows(sunDirection, SITE, DAY, end, { moonIlluminationAt: () => 1, maximumMoonIllumination: 0.5 }).dark).toEqual([])
	const faint = darknessWindows(sunDirection, SITE, DAY, end, { moonIlluminationAt: () => 0.2, maximumMoonIllumination: 0.5 })
	expect(faint.dark).toEqual(faint.astronomical)
	expect(() => darknessWindows(sunDirection, SITE, DAY, end, { maximumMoonAltitude: 0 })).toThrow('moon direction is required')
})
