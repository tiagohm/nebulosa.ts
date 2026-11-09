import { expect, test } from 'bun:test'
import { eraNut06a, eraPnm06a } from '../../../src/astronomy/coordinates/erfa/erfa'
import { ECLIPTIC, frameToBase } from '../../../src/astronomy/coordinates/frame'
import { earth, jupiter, mars, mercury, saturn, sun, venus } from '../../../src/astronomy/ephemeris/models/analytical/vsop87e'
import {
	planetaryAppulses,
	planetaryBrightnessMaxima,
	planetaryClosestApproaches,
	planetaryConjunctions,
	planetaryGreatestElongations,
	planetaryIlluminationCrossings,
	planetaryInnerConjunctions,
	planetaryLongitudeConjunctions,
	planetaryLongitudeCrossings,
	planetaryLongitudeOppositions,
	planetaryLongitudeQuadratures,
	planetaryOppositions,
	planetaryQuadratures,
	planetaryStations,
} from '../../../src/astronomy/events/planetary'
import { type Time, Timescale, timeShift, timeSubtract, timeYMDHMS } from '../../../src/astronomy/time/time'
import { PI, TAU } from '../../../src/core/constants'
import { type MutVec3, vecClone, vecMinus, vecX, vecZero } from '../../../src/math/linear-algebra/vec3'
import { deg, normalizePI, toDeg } from '../../../src/math/units/angle'

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
	const targetScratch = vecZero()
	const sunScratch = vecX()
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
	expect(sunScratch).toEqual(vecX())
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
	const targetScratch = vecZero()
	const sunScratch = vecX(3)
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
	expect(sunScratch).toEqual(vecX(3))
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

// Skyfield 1.55 / JPL DE421 (Mars, Jupiter and Saturn system barycenters), scipy 1.16.2 brentq and
// bounded minimization: same-epoch geometric geocentric vectors in skyfield.framelib.ecliptic_frame
// (true ecliptic and equinox of date). Venus magnitudes use skyfield.magnitudelib._venus_magnitude
// on the same geometric r, delta and phase angle. Offsets are TT days from 2020-01-01 00:00 TT.
const MERCURY = (time: Time) => vecMinus(mercury(time)[0], earth(time)[0])
const JUPITER = (time: Time) => vecMinus(jupiter(time)[0], earth(time)[0])
const SATURN = (time: Time) => vecMinus(saturn(time)[0], earth(time)[0])

// Unit direction at ecliptic-of-date longitude and latitude, in ICRS-oriented axes.
function eclipticDirection(longitude: number, latitude: number, time: Time) {
	return frameToBase([Math.cos(longitude) * Math.cos(latitude), Math.sin(longitude) * Math.cos(latitude), Math.sin(latitude)], ECLIPTIC, time)
}

test('longitude conjunctions differ from separation minima and keep the inferior/superior label', () => {
	const events = planetaryLongitudeConjunctions(VENUS, SUN, EPOCH, timeShift(EPOCH, 480), OPTIONS)
	expect(events.map((event) => event.kind)).toEqual(['inferior', 'superior'])
	expectEpoch(events[0].time, 154.735233641)
	expectEpoch(events[1].time, 450.264553875)
	expect(Math.abs(toDeg(events[0].separation) - 0.48709003)).toBeLessThan(0.002)
	expect(Math.abs(toDeg(events[1].separation) - 1.35294383)).toBeLessThan(0.002)
	expect(toDeg(events[0].latitudeDifference)).toBeCloseTo(0.487, 2)
	expect(toDeg(events[1].latitudeDifference)).toBeCloseTo(-1.353, 2)
	expect(Math.abs(events[0].longitudeDifference)).toBeLessThan(1e-9)
	// The separation minimum of the same inferior conjunction is about an hour later.
	const [minimum] = planetaryInnerConjunctions(VENUS, SUN, EPOCH, STOP, OPTIONS)
	expect(timeSubtract(minimum.time, events[0].time)).toBeGreaterThan(0.03)

	const [mercuryConjunction] = planetaryLongitudeConjunctions(MERCURY, SUN, timeShift(EPOCH, 40), timeShift(EPOCH, 70), { step: 1, tolerance: 1e-7 })
	expect(mercuryConjunction.kind).toBe('inferior')
	expectEpoch(mercuryConjunction.time, 56.068870483)
	expect(Math.abs(toDeg(mercuryConjunction.separation) - 3.72041302)).toBeLessThan(0.002)
})

test('Mars longitude opposition precedes its separation maximum by more than two hours', () => {
	const start = timeShift(EPOCH, 250)
	const stop = timeShift(EPOCH, 330)
	const [opposition] = planetaryLongitudeOppositions(MARS, SUN, start, stop, OPTIONS)
	expectEpoch(opposition.time, 286.972187658)
	expect(Math.abs(toDeg(opposition.separation) - 177.00408216)).toBeLessThan(0.002)
	expect(toDeg(opposition.latitudeDifference)).toBeCloseTo(-2.996, 2)
	expect(Math.abs(normalizePI(opposition.longitudeDifference - PI))).toBeLessThan(1e-9)
	const [maximum] = planetaryOppositions(MARS, SUN, start, stop, OPTIONS)
	expect(timeSubtract(maximum.time, opposition.time)).toBeGreaterThan(0.1)
	expect(planetaryLongitudeConjunctions(MARS, SUN, start, stop, OPTIONS)).toEqual([])
})

test('Mars longitude quadratures are labelled by the signed longitude difference', () => {
	const events = planetaryLongitudeQuadratures(MARS, SUN, timeShift(EPOCH, 140), timeShift(EPOCH, 410), OPTIONS)
	expect(events.map((event) => event.kind)).toEqual(['west', 'east'])
	expectEpoch(events[0].time, 157.79367173)
	expectEpoch(events[1].time, 397.436505738)
	expect(toDeg(events[0].longitudeDifference)).toBeCloseTo(-90, 6)
	expect(toDeg(events[1].longitudeDifference)).toBeCloseTo(90, 6)
})

test('the 2020 Jupiter-Saturn great conjunction and appulse agree with DE421', () => {
	const start = timeShift(EPOCH, 340)
	const stop = timeShift(EPOCH, 370)
	const [conjunction] = planetaryLongitudeConjunctions(JUPITER, SATURN, start, stop, OPTIONS)
	expectEpoch(conjunction.time, 355.758279214)
	expect(Math.abs(toDeg(conjunction.separation) - 0.10174434)).toBeLessThan(0.002)
	expect(conjunction.latitudeDifference).toBeLessThan(0)
	const [appulse] = planetaryAppulses(JUPITER, SATURN, start, stop, OPTIONS)
	expectEpoch(appulse.time, 355.758542331)
	expect(Math.abs(toDeg(appulse.separation) - 0.10174434)).toBeLessThan(0.002)
	const [swapped] = planetaryAppulses(SATURN, JUPITER, start, stop, OPTIONS)
	expect(timeSubtract(swapped.time, appulse.time)).toBeCloseTo(0, 6)
	expect(swapped.separation).toBeCloseTo(appulse.separation, 12)
})

test('Venus dichotomies and greatest brightness agree with DE421 geometry', () => {
	const dichotomies = planetaryIlluminationCrossings(VENUS, SUN, EPOCH, STOP, 0.5, OPTIONS)
	expect(dichotomies.map((event) => event.kind)).toEqual(['decreasing', 'increasing'])
	expectEpoch(dichotomies[0].time, 86.032947603)
	expectEpoch(dichotomies[1].time, 224.867131809)
	for (const event of dichotomies) expect(toDeg(event.phaseAngle)).toBeCloseTo(90, 6)

	// The two minima on the crescent branch (phase angles 90 to 163.7 degrees) are the greatest
	// brilliancies; the forward-scattering branch adds two faint minima around inferior conjunction,
	// and the low-phase polynomial shallow ones near superior conjunction (none in this window).
	const minima = planetaryBrightnessMaxima('venus', VENUS, SUN, EPOCH, STOP, OPTIONS)
	expect(minima.filter((event) => event.phaseAngle > deg(163.7))).toHaveLength(2)
	const brightest = minima.filter((event) => event.phaseAngle > deg(90) && event.phaseAngle < deg(163.7))
	expect(brightest).toHaveLength(2)
	for (const [i, days, magnitude, phase] of [
		[0, 122.363410816, -4.753237705, 121.731900706],
		[1, 186.524636626, -4.717127058, 122.924923136],
	] as const) {
		// A brightness maximum is flat: 0.1 day moves the magnitude by about 1e-5.
		expect(Math.abs(timeSubtract(brightest[i].time, EPOCH) - days)).toBeLessThan(0.1)
		expect(brightest[i].magnitude).toBeCloseTo(magnitude, 3)
		expect(Math.abs(toDeg(brightest[i].phaseAngle) - phase)).toBeLessThan(0.05)
	}
})

test('longitude crossings are seam-safe, reject the opposite alignment and find repeated retrograde roots', () => {
	const stop = timeShift(EPOCH, 1)
	const reference = (time: Time) => eclipticDirection(0, 0, time)
	// Oscillates across longitude 0 (and the 0/TAU seam) three times: direct, retrograde, direct.
	const looping = (time: Time) => eclipticDirection(0.2 * Math.sin(3 * PI * (timeSubtract(time, EPOCH) - 0.1)), 0.01, time)
	const roots = planetaryLongitudeConjunctions(looping, reference, EPOCH, stop, { step: 0.01 })
	expect(roots).toHaveLength(3)
	for (const [i, offset] of [0.1, 0.1 + 1 / 3, 0.1 + 2 / 3].entries()) expect(timeSubtract(roots[i].time, EPOCH)).toBeCloseTo(offset, 6)
	expect(planetaryLongitudeOppositions(looping, reference, EPOCH, stop, { step: 0.01 })).toEqual([])

	// A full sweep passes both 0 and PI once: each finder keeps only its own alignment.
	const sweeping = (time: Time) => eclipticDirection(-1 + TAU * timeSubtract(time, EPOCH), 0, time)
	const [conjunction] = planetaryLongitudeConjunctions(sweeping, reference, EPOCH, stop, { step: 0.01 })
	expect(timeSubtract(conjunction.time, EPOCH)).toBeCloseTo(1 / TAU, 6)
	const oppositions = planetaryLongitudeOppositions(sweeping, reference, EPOCH, stop, { step: 0.01 })
	expect(oppositions).toHaveLength(1)
	expect(timeSubtract(oppositions[0].time, EPOCH)).toBeCloseTo((1 + PI) / TAU, 6)
	const offset = planetaryLongitudeCrossings(sweeping, reference, EPOCH, stop, deg(-30), { step: 0.01 })
	expect(timeSubtract(offset[0].time, EPOCH)).toBeCloseTo((1 - deg(30)) / TAU, 6)
	expect(planetaryLongitudeQuadratures(sweeping, reference, EPOCH, stop, { step: 0.01 }).map((event) => event.kind)).toEqual(['east', 'west'])
})

test('an inclined pair reaches its longitude conjunction and least separation at different instants', () => {
	const stop = timeShift(EPOCH, 1)
	const reference = (time: Time) => eclipticDirection(0, 0, time)
	// Small-angle separation^2 = (0.1 u)^2 + (0.05 + 0.08 u)^2 with u = t - 0.5 is least at u = -0.244.
	const target = (time: Time) => {
		const u = timeSubtract(time, EPOCH) - 0.5
		return eclipticDirection(0.1 * u, 0.05 + 0.08 * u, time)
	}
	const [conjunction] = planetaryLongitudeConjunctions(target, reference, EPOCH, stop, { step: 0.05 })
	expect(timeSubtract(conjunction.time, EPOCH)).toBeCloseTo(0.5, 6)
	expect(conjunction.separation).toBeCloseTo(0.05, 6)
	expect(conjunction.latitudeDifference).toBeCloseTo(0.05, 6)
	const [appulse] = planetaryAppulses(target, reference, EPOCH, stop, { step: 0.05 })
	expect(timeSubtract(appulse.time, EPOCH)).toBeCloseTo(0.256, 2)
	expect(appulse.separation).toBeLessThan(conjunction.separation)
})

test('almanac finders keep borrowed buffers intact and return nothing for empty windows', () => {
	const targetScratch = vecZero()
	const referenceScratch: MutVec3 = [1, 0, 0]
	const target = (time: Time) => {
		const angle = timeSubtract(time, EPOCH) - 0.5
		targetScratch[0] = 2 * Math.cos(angle)
		targetScratch[1] = 2 * Math.sin(angle)
		targetScratch[2] = 0
		return targetScratch
	}
	const reference = () => referenceScratch
	const stop = timeShift(EPOCH, 1)
	const borrowed = planetaryLongitudeConjunctions(target, reference, EPOCH, stop, { step: 0.1 })
	const cloned = planetaryLongitudeConjunctions(
		(time) => vecClone(target(time)),
		() => vecClone(reference()),
		EPOCH,
		stop,
		{ step: 0.1 },
	)
	expect(borrowed).toHaveLength(1)
	expect(timeSubtract(borrowed[0].time, cloned[0].time)).toBeCloseTo(0, 10)
	expect(borrowed[0].kind).toBe('superior')
	expect(referenceScratch).toEqual([1, 0, 0])

	for (const end of [EPOCH, timeShift(EPOCH, -1)]) {
		expect(planetaryLongitudeCrossings(VENUS, SUN, EPOCH, end, 0, OPTIONS)).toEqual([])
		expect(planetaryAppulses(VENUS, SUN, EPOCH, end, OPTIONS)).toEqual([])
		expect(planetaryIlluminationCrossings(VENUS, SUN, EPOCH, end, 0.5, OPTIONS)).toEqual([])
		expect(planetaryBrightnessMaxima('venus', VENUS, SUN, EPOCH, end, OPTIONS)).toEqual([])
	}
})

test('brightness maxima never come from an undefined magnitude', () => {
	// Saturn 10 AU away with the Sun placed so the phase angle is 0.4 |t - 0.5| radians: the model
	// with rings is undefined beyond 6.5 degrees, |t - 0.5| > 0.284, and brightest at zero phase.
	const planet: MutVec3 = [10, 0, 0]
	const target = () => planet
	const solar = (time: Time): MutVec3 => {
		const phase = 0.4 * Math.abs(timeSubtract(time, EPOCH) - 0.5)
		return [10 - 9.5 * Math.cos(phase), 9.5 * Math.sin(phase), 0]
	}
	const events = planetaryBrightnessMaxima('saturn', target, solar, EPOCH, timeShift(EPOCH, 1), { step: 0.05 })
	expect(events).toHaveLength(1)
	expect(timeSubtract(events[0].time, EPOCH)).toBeCloseTo(0.5, 3)
	expect(Number.isFinite(events[0].magnitude)).toBeTrue()
})
