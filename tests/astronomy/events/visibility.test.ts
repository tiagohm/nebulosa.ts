import { expect, test } from 'bun:test'
import type { PositionOverTime } from '../../../src/astronomy/coordinates/astrometry'
import { icrs } from '../../../src/astronomy/coordinates/icrs'
import { earth, sun } from '../../../src/astronomy/ephemeris/models/analytical/vsop87e'
import { ASTRONOMICAL_TWILIGHT, riseTransitSet } from '../../../src/astronomy/events/horizon'
import { visibilityWindows } from '../../../src/astronomy/events/visibility'
import { airmassKastenYoung } from '../../../src/astronomy/formulas'
import { Ellipsoid, geodeticLocation } from '../../../src/astronomy/observer/location'
import { type Time, Timescale, timeShift, timeSubtract, timeYMDHMS } from '../../../src/astronomy/time/time'
import { PIOVERTWO } from '../../../src/core/constants'
import { type MutVec3, vecMinus, vecXAxis, vecYAxis } from '../../../src/math/linear-algebra/vec3'
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

test('solar avoidance requires a source and keeps a single snapshot per provider', () => {
	const end = timeShift(DAY, 1)
	expect(() => visibilityWindows(() => SIRIUS, SITE, DAY, end, { minimumSunSeparation: deg(30) })).toThrow('sun direction is required')
	const TARGET = vecXAxis()
	const target = () => TARGET
	const SOLAR = vecYAxis()
	const solar = () => SOLAR
	const MOON = vecYAxis()
	const lunar = () => MOON
	expect(visibilityWindows(target, SITE, DAY, end, { minimumSunSeparation: deg(80), minimumMoonSeparation: deg(80) }, { sunAt: solar, moonAt: lunar })).toHaveLength(1)
	expect(visibilityWindows(target, SITE, DAY, end, { minimumSunSeparation: deg(100) }, { sunAt: solar })).toEqual([])
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
	const perpendicular: PositionOverTime = () => vecYAxis()
	expect(visibilityWindows(() => vecXAxis(), SITE, DAY, end, { minimumMoonSeparation: deg(10) }, { moonAt: perpendicular })).toHaveLength(1)
	expect(() => visibilityWindows(same, SITE, DAY, end, { maximumSunAltitude: 0 })).toThrow('sun direction is required')
	expect(visibilityWindows(same, SITE, DAY, end, { maximumAirmass: 0.5 })).toEqual([])
})

test('combined target constraints evaluate the target provider once per epoch', () => {
	let targetCalls = 0
	let moonCalls = 0
	const target: PositionOverTime = () => {
		targetCalls++
		return vecXAxis()
	}
	const moon: PositionOverTime = () => {
		moonCalls++
		return vecYAxis()
	}
	const windows = visibilityWindows(target, SITE, DAY, timeShift(DAY, 0.01), { minimumAltitude: -PIOVERTWO, minimumMoonSeparation: 0 }, { moonAt: moon, step: 0.005 })
	expect(windows).toHaveLength(1)
	expect(targetCalls).toBeGreaterThan(0)
	expect(targetCalls).toBe(moonCalls)
})

test('independent constraints find a hidden overlap with provider-local singletons', () => {
	const targetScratch: MutVec3 = [0, 0, 0]
	const sunScratch: MutVec3 = [0, 0, 0]
	const moonScratch: MutVec3 = [0, 0, 0]
	let targetCalls = 0
	let sunCalls = 0
	let moonCalls = 0
	const epochs: number[] = []
	const target: PositionOverTime = (time) => {
		targetCalls++
		epochs.push(timeSubtract(time, DAY))
		targetScratch[0] = 1
		return targetScratch
	}
	const solar: PositionOverTime = (time) => {
		sunCalls++
		const angle = 0.5 + timeSubtract(time, DAY) - 0.2
		sunScratch[0] = Math.cos(angle)
		sunScratch[1] = Math.sin(angle)
		return sunScratch
	}
	const lunar: PositionOverTime = (time) => {
		moonCalls++
		const angle = 0.5 + 0.4 - timeSubtract(time, DAY)
		moonScratch[0] = Math.cos(angle)
		moonScratch[1] = Math.sin(angle)
		return moonScratch
	}
	const end = timeShift(DAY, 0.5)
	const windows = visibilityWindows(target, SITE, DAY, end, { minimumSunSeparation: 0.5, minimumMoonSeparation: 0.5 }, { sunAt: solar, moonAt: lunar, step: 0.5, tolerance: 1e-9 })
	expect(windows).toHaveLength(1)
	expect(timeSubtract(windows[0].start, DAY)).toBeCloseTo(0.2, 8)
	expect(timeSubtract(windows[0].end, DAY)).toBeCloseTo(0.4, 8)
	expect(targetCalls).toBe(sunCalls)
	expect(targetCalls).toBe(moonCalls)
	// Consecutive margins at the same epoch reuse the cache, including refined midpoints.
	for (let i = 1; i < epochs.length; i++) expect(epochs[i]).not.toBe(epochs[i - 1])
	expect(target(DAY)).toBe(target(end))
	expect(solar(DAY)).toBe(solar(end))
	expect(lunar(DAY)).toBe(lunar(end))
	expect(targetScratch).not.toBe(sunScratch)
	expect(targetScratch).not.toBe(moonScratch)
	expect(sunScratch).not.toBe(moonScratch)
	expect(targetScratch).toEqual([1, 0, 0])
	expect(sunScratch).toEqual([Math.cos(0.8), Math.sin(0.8), 0])
	expect(moonScratch).toEqual([Math.cos(0.4), Math.sin(0.4), 0])
})
