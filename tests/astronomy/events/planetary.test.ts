import { expect, test } from 'bun:test'
import { eraNut06a, eraPnm06a } from '../../../src/astronomy/coordinates/erfa/erfa'
import { ECLIPTIC, frameToBase } from '../../../src/astronomy/coordinates/frame'
import { earth, mars, sun, venus } from '../../../src/astronomy/ephemeris/models/analytical/vsop87e'
import { planetaryClosestApproaches, planetaryConjunctions, planetaryGreatestElongations, planetaryInnerConjunctions, planetaryOppositions, planetaryQuadratures, planetaryStations } from '../../../src/astronomy/events/planetary'
import { type Time, Timescale, timeShift, timeSubtract, timeYMDHMS } from '../../../src/astronomy/time/time'
import { PI } from '../../../src/core/constants'
import { type MutVec3, vecClone, vecMinus } from '../../../src/math/linear-algebra/vec3'
import { deg, toDeg } from '../../../src/math/units/angle'

// Skyfield 1.55 / JPL DE421, scipy 1.16.2 bounded scalar minimization and brentq.
// Same-epoch geometric geocentric positions, true ecliptic of date, no light time/aberration.
// Offsets below are TT days from 2020-01-01 00:00 TT. VSOP87E vs DE421 permits 0.01 day
// in event epochs and 0.002 degree in elongation; stations use a 0.05-day centered derivative.
const EPOCH = timeYMDHMS(2020, 1, 1, 0, 0, 0, Timescale.TT)
// tests/setup.ts rounds orientation matrices to whole days. A longitude derivative needs
// continuous orientation; use per-Time providers (preserved by timeShift) without global mutation.
EPOCH.providers = { pnm: (time) => eraPnm06a(time.day, time.fraction), nut: (time) => eraNut06a(time.day, time.fraction) }
const STOP = timeShift(EPOCH, 366)
const VENUS = (time: Time) => vecMinus(venus(time)[0], earth(time)[0])
const MARS = (time: Time) => vecMinus(mars(time)[0], earth(time)[0])
const SUN = (time: Time) => vecMinus(sun(time)[0], earth(time)[0])
const OPTIONS = { step: 2, tolerance: 1e-7 }

function expectEpoch(time: Time, days: number) {
	expect(Math.abs(timeSubtract(time, EPOCH) - days)).toBeLessThan(0.01)
}

test('Venus east/west greatest elongations agree with geometric DE421 references', () => {
	const events = planetaryGreatestElongations(VENUS, SUN, EPOCH, STOP, OPTIONS)
	expect(events).toHaveLength(2)
	for (const [i, days, angle, kind] of [
		[0, 83.916118221, 46.075742861, 'east'],
		[1, 225.000380137, 45.792698341, 'west'],
	] as const) {
		expectEpoch(events[i].time, days)
		expect(Math.abs(toDeg(events[i].elongation) - angle)).toBeLessThan(0.002)
		expect(events[i].kind).toBe(kind)
	}
})

test('greatest elongations agree for allocating and provider-local singleton vectors', () => {
	const targetScratch: MutVec3 = [0, 0, 0]
	const sunScratch: MutVec3 = [1, 0, 0]
	const target = (time: Time) => {
		const angle = 0.6 - (timeSubtract(time, EPOCH) - 0.5) ** 2
		targetScratch[0] = 2 * Math.cos(angle)
		targetScratch[1] = 2 * Math.sin(angle)
		return targetScratch
	}
	const solar = () => sunScratch
	const end = timeShift(EPOCH, 1)
	const expected = planetaryGreatestElongations(
		(time) => vecClone(target(time)),
		() => vecClone(solar()),
		EPOCH,
		end,
		{ step: 0.1 },
	)
	const actual = planetaryGreatestElongations(target, solar, EPOCH, end, { step: 0.1 })
	expect(actual).toHaveLength(1)
	expect(timeSubtract(actual[0].time, expected[0].time)).toBeCloseTo(0, 10)
	expect(actual[0].elongation).toBeCloseTo(expected[0].elongation, 12)
	expect(actual[0].kind).toBe(expected[0].kind)
	expect(target(EPOCH)).toBe(target(end))
	expect(solar()).toBe(solar())
	expect(targetScratch).not.toBe(sunScratch)
	expect(sunScratch).toEqual([1, 0, 0])
})

test('inner conjunction classification uses the actual observer-Sun range', () => {
	const inferior = planetaryInnerConjunctions(VENUS, SUN, EPOCH, STOP, OPTIONS)
	expect(inferior).toHaveLength(1)
	expect(inferior[0].kind).toBe('inferior')
	expectEpoch(inferior[0].time, 154.780008494)
	const superior = planetaryInnerConjunctions(VENUS, SUN, timeShift(EPOCH, 400), timeShift(EPOCH, 480), OPTIONS)
	expect(superior).toHaveLength(1)
	expect(superior[0].kind).toBe('superior')
	expectEpoch(superior[0].time, 450.548503648)
	// Both bodies are farther than 1 AU, with a separate reusable buffer per provider.
	const targetScratch: MutVec3 = [0, 0, 0]
	const sunScratch: MutVec3 = [3, 0, 0]
	const target = (time: Time) => {
		const angle = (timeSubtract(time, EPOCH) - 0.5) ** 2 + 0.1
		targetScratch[0] = 2 * Math.cos(angle)
		targetScratch[1] = 2 * Math.sin(angle)
		return targetScratch
	}
	const solar = () => sunScratch
	const classified = planetaryInnerConjunctions(target, solar, EPOCH, timeShift(EPOCH, 1), { step: 0.1 })
	expect(classified).toHaveLength(1)
	expect(classified[0].kind).toBe('inferior')
	expect(timeSubtract(classified[0].time, EPOCH)).toBeCloseTo(0.5, 5)
	expect(target(EPOCH)).toBe(target(timeShift(EPOCH, 1)))
	expect(targetScratch).not.toBe(solar())
	expect(sunScratch).toEqual([3, 0, 0])
})

test('Mars opposition and closest range agree with independent DE421 extrema', () => {
	const start = timeShift(EPOCH, 250)
	const stop = timeShift(EPOCH, 330)
	const opposition = planetaryOppositions(MARS, SUN, start, stop, OPTIONS)
	expect(opposition).toHaveLength(1)
	expectEpoch(opposition[0].time, 287.084742844)
	expect(Math.abs(toDeg(opposition[0].elongation) - 177.0077081)).toBeLessThan(0.002)
	const closest = planetaryClosestApproaches(MARS, start, stop, OPTIONS)
	expect(closest).toHaveLength(1)
	expectEpoch(closest[0].time, 279.596701129)
	expect(closest[0].distance).toBeCloseTo(0.414915619309, 5)
	expect(planetaryOppositions(VENUS, SUN, EPOCH, STOP, { step: 5 })).toEqual([])
})

test('Mars direct/retrograde stations agree with independent true-ecliptic derivative roots', () => {
	const events = planetaryStations(MARS, timeShift(EPOCH, 230), timeShift(EPOCH, 340), { ...OPTIONS, derivativeHalfStep: 0.05 })
	expect(events).toHaveLength(2)
	expect(events[0].kind).toBe('directToRetrograde')
	expect(events[1].kind).toBe('retrogradeToDirect')
	expectEpoch(events[0].time, 252.930323737)
	expectEpoch(events[1].time, 318.022558238)
})

test('Mars quadrature is a 90-degree crossing with an east/west label', () => {
	const events = planetaryQuadratures(MARS, SUN, timeShift(EPOCH, 140), timeShift(EPOCH, 410), OPTIONS)
	expect(events).toHaveLength(2)
	expectEpoch(events[0].time, 157.793667019)
	expect(events[0].kind).toBe('west')
	expectEpoch(events[1].time, 397.436498047)
	expect(events[1].kind).toBe('east')
	expect(toDeg(events[0].elongation)).toBeCloseTo(90, 5)
	expect(toDeg(events[1].elongation)).toBeCloseTo(90, 5)
})

test('longitude wrap does not invent a station or reverse quadrature labels', () => {
	const solar = (time: Time) => frameToBase([Math.cos(deg(359)), Math.sin(deg(359)), 0], ECLIPTIC, time)
	const target = (time: Time) => {
		const angle = deg(359) + (timeSubtract(time, EPOCH) - 0.5) * 4
		return frameToBase([Math.cos(angle), Math.sin(angle), 0], ECLIPTIC, time)
	}
	const stop = timeShift(EPOCH, 1)
	expect(planetaryStations(target, EPOCH, stop, { step: 0.03, derivativeHalfStep: 0.001 })).toEqual([])
	const quadratures = planetaryQuadratures(target, solar, EPOCH, stop, { step: 0.03 })
	expect(quadratures.map((event) => event.kind)).toEqual(['west', 'east'])
	expect(timeSubtract(quadratures[0].time, EPOCH)).toBeCloseTo(0.5 - PI / 8, 6)
	expect(timeSubtract(quadratures[1].time, EPOCH)).toBeCloseTo(0.5 + PI / 8, 6)
})

test('empty, reversed, no-event and non-advancing search windows are handled', () => {
	for (const stop of [EPOCH, timeShift(EPOCH, -1)]) {
		expect(planetaryConjunctions(VENUS, SUN, EPOCH, stop, OPTIONS)).toEqual([])
		expect(planetaryStations(MARS, EPOCH, stop)).toEqual([])
	}
	expect(planetaryConjunctions(VENUS, SUN, EPOCH, timeShift(EPOCH, 2), { step: 0.1 })).toEqual([])
	expect(() => planetaryQuadratures(MARS, SUN, EPOCH, STOP, { step: Number.MIN_VALUE })).toThrow('too small')
	expect(() => planetaryStations(MARS, EPOCH, STOP, { derivativeHalfStep: 0 })).toThrow()
})
