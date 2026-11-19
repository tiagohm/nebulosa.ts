import { expect, test } from 'bun:test'
import fs from 'fs/promises'
import { moonSemidiameter, nearestLunarApsis, nearestLunarPhase } from '../../../src/astronomy/bodies/moon'
import { season } from '../../../src/astronomy/bodies/sun'
import { ecliptic } from '../../../src/astronomy/coordinates/frame'
import { readDaf } from '../../../src/astronomy/ephemeris/kernels/daf'
import { inspectSpk } from '../../../src/astronomy/ephemeris/kernels/spk.inspect'
import { prepareSpkKernelSet } from '../../../src/astronomy/ephemeris/kernels/spk.kernelset'
import { analyticalEphemerisSource, apparentGeocentricPosition, type EphemerisSource, relativeEphemerisState, spkEphemerisSource } from '../../../src/astronomy/ephemeris/source'
import { nearestLunarApsisOf, nearestLunarPhaseOf, seasonOf } from '../../../src/astronomy/events/almanac'
import { type Time, Timescale, timeShift, timeSubtract, timeYMDHMS } from '../../../src/astronomy/time/time'
import { PI, PIOVERTWO } from '../../../src/core/constants'
import { fileHandleSource } from '../../../src/io/file'
import { vecLength, vecLongitude } from '../../../src/math/linear-algebra/vec3'
import { normalizePI } from '../../../src/math/units/angle'
import { downloadPerTag } from '../../download'

await downloadPerTag('spk')

const handle = fileHandleSource(await fs.open('data/de440s.bsp'))
const daf = await readDaf(handle)
const inspection = inspectSpk(daf, (await fs.stat('data/de440s.bsp')).size)
if (!inspection.ok) throw new Error(inspection.error)
const DE440S = spkEphemerisSource(await prepareSpkKernelSet([{ id: 'de440s', daf, segments: inspection.segments }]))

const TIME = timeYMDHMS(2026, 11, 19, 0, 0, 0, Timescale.TT)
const SECOND = 1 / 86400

function seconds(a: Time, b: Time) {
	return timeSubtract(a, b) * 86400
}

function apparentLongitude(source: EphemerisSource, naif: number, time: Time) {
	return vecLongitude(ecliptic(apparentGeocentricPosition(source, naif, time), time))
}

function moonDistance(source: EphemerisSource, time: Time) {
	return vecLength(relativeEphemerisState(source, 301, 399, time)[0])
}

test('the principal phases reach their elongation on the source, seconds from the series', () => {
	const phases = [
		['NEW', 0],
		['FIRST_QUARTER', PIOVERTWO],
		['FULL', PI],
		['LAST_QUARTER', PI + PIOVERTWO],
	] as const

	for (const [phase, elongation] of phases) {
		const time = nearestLunarPhaseOf(DE440S, TIME, phase, true)
		expect(time.scale).toBe(Timescale.TT)
		expect(timeSubtract(time, TIME)).toBeGreaterThan(0)
		expect(timeSubtract(time, TIME)).toBeLessThan(29.6)
		expect(normalizePI(apparentLongitude(DE440S, 301, time) - apparentLongitude(DE440S, 10, time) - elongation)).toBeCloseTo(0, 7)
		expect(Math.abs(seconds(time, nearestLunarPhase(TIME, phase, true)))).toBeLessThan(5)
	}
})

test('a phase is strictly after the instant when next, and at or before it otherwise', () => {
	const full = nearestLunarPhaseOf(DE440S, TIME, 'FULL', true)
	expect(seconds(nearestLunarPhaseOf(DE440S, full, 'FULL', false), full)).toBeCloseTo(0, 3)
	expect(seconds(nearestLunarPhaseOf(DE440S, timeShift(full, -SECOND), 'FULL', true), full)).toBeCloseTo(0, 3)
	expect(timeSubtract(nearestLunarPhaseOf(DE440S, full, 'FULL', true), full)).toBeCloseTo(29.5, 0)
	expect(timeSubtract(full, nearestLunarPhaseOf(DE440S, timeShift(full, -SECOND), 'FULL', false))).toBeCloseTo(29.5, 0)
})

test('the analytical source gives the phases of the kernels within a second', () => {
	const kernels = nearestLunarPhaseOf(DE440S, TIME, 'NEW', true)
	const theories = nearestLunarPhaseOf(analyticalEphemerisSource, TIME, 'NEW', true)
	expect(Math.abs(seconds(theories, kernels))).toBeLessThan(1)
})

test('an apsis is the extremum of the geometric distance, minutes from the perigee series', () => {
	const [perigee, perigeeDistance, perigeeDiameter] = nearestLunarApsisOf(DE440S, TIME, 'PERIGEE', true)
	expect(timeSubtract(perigee, TIME)).toBeGreaterThan(0)
	expect(perigeeDistance).toBeCloseTo(moonDistance(DE440S, perigee), 12)
	expect(perigeeDiameter).toBeCloseTo(2 * moonSemidiameter(perigeeDistance), 12)
	expect(moonDistance(DE440S, timeShift(perigee, -1 / 24))).toBeGreaterThan(perigeeDistance)
	expect(moonDistance(DE440S, timeShift(perigee, 1 / 24))).toBeGreaterThan(perigeeDistance)
	// The perigee series truncates periodic terms worth minutes: this one is about 3.5 min early.
	expect(seconds(perigee, nearestLunarApsis(TIME, 'PERIGEE', true)[0])).toBeCloseTo(207, -1)

	const [apogee, apogeeDistance] = nearestLunarApsisOf(DE440S, TIME, 'APOGEE', true)
	expect(moonDistance(DE440S, timeShift(apogee, -1 / 24))).toBeLessThan(apogeeDistance)
	expect(moonDistance(DE440S, timeShift(apogee, 1 / 24))).toBeLessThan(apogeeDistance)
	expect(Math.abs(seconds(apogee, nearestLunarApsis(TIME, 'APOGEE', true)[0]))).toBeLessThan(60)
})

test('a season starts when the apparent longitude of the Sun reaches its quadrant, seconds from the series', () => {
	const seasons = [
		['spring', 0],
		['summer', PIOVERTWO],
		['autumn', PI],
		['winter', PI + PIOVERTWO],
	] as const

	for (const [name, longitude] of seasons) {
		const time = seasonOf(DE440S, 2026, name)
		expect(normalizePI(apparentLongitude(DE440S, 10, time) - longitude)).toBeCloseTo(0, 9)
		expect(Math.abs(seconds(time, season(2026, name)))).toBeLessThan(60)
		expect(Math.abs(seconds(seasonOf(analyticalEphemerisSource, 2026, name), time))).toBeLessThan(2)
	}
})
