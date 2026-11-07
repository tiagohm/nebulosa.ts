import { expect, test } from 'bun:test'
import { analyticalSaturnianEphemeris, interpolatedSaturnianEphemeris } from '../../../src/astronomy/ephemeris/saturnian'
import { saturnianView } from '../../../src/astronomy/events/saturn.geometry'
import { type SaturnianPhenomenon, saturnianPhenomena } from '../../../src/astronomy/events/saturn.phenomena'
import { type Time, Timescale, timeShift, timeSubtract, timeYMDHMS } from '../../../src/astronomy/time/time'
import { DAYSEC } from '../../../src/core/constants'

const EPHEMERIS = interpolatedSaturnianEphemeris(analyticalSaturnianEphemeris)

function utc(month: number, day: number, hour = 0, minute = 0, year = 2025) {
	return timeYMDHMS(year, month, day, hour, minute, 0, Timescale.UTC)
}

function minutes(a: Time, b: Time) {
	return timeSubtract(a, b) * 1440
}

const APRIL = saturnianPhenomena(EPHEMERIS, utc(4, 1), utc(4, 14))

function find(moon: SaturnianPhenomenon['moon'], kind: SaturnianPhenomenon['kind'], near: Time) {
	const found = APRIL.find((p) => p.moon === moon && p.kind === kind && Math.abs(minutes(p.maximum, near)) < 6 * 60)
	expect(found).toBeDefined()
	return found!
}

// JPL Horizons API 1.2 quantity 12 (satellite visibility codes at 1-minute steps, 500@399, sat441l), retrieved
// 2026-11-07. Each reference is the first minute showing the new code, so the contact lies in the minute before it.
// Transits ('*'→'t'→'*') of the inner moons cross near the disk's centre, where the limb model barely matters; the
// eclipse references are the moon becoming wholly umbral ('p'→'u'), and the occultation ends ('O'→'*').
test('inner-moon transits match JPL Horizons within the accuracy of TASS 1.7', () => {
	const references = [
		['tethys', utc(4, 2, 12, 56), utc(4, 2, 15, 56)],
		['dione', utc(4, 1, 21, 24), utc(4, 2, 0, 47)],
		['rhea', utc(4, 4, 3, 9), utc(4, 4, 7, 9)],
	] as const

	for (const [moon, start, end] of references) {
		const transit = find(moon, 'satelliteTransit', timeShift(start, 0.07))
		expect(Math.abs(minutes(transit.external1!, timeShift(start, -0.5 / 1440)))).toBeLessThan(2)
		expect(Math.abs(minutes(transit.external2!, timeShift(end, -0.5 / 1440)))).toBeLessThan(2)
	}
})

test('eclipses and occultations match JPL Horizons within the accuracy of TASS 1.7', () => {
	const umbral = [
		['tethys', utc(4, 1, 14, 7)],
		['dione', utc(4, 3, 6, 5)],
		['rhea', utc(4, 1, 20, 28)],
		['titan', utc(4, 5, 11, 14)],
	] as const

	for (const [moon, reference] of umbral) {
		const eclipse = find(moon, 'satelliteEclipse', timeShift(reference, 0.06))
		expect(Math.abs(minutes(eclipse.internal1!, timeShift(reference, -0.5 / 1440)))).toBeLessThan(2)
		// The penumbral contact comes first, then the centre on the umbra's edge, then wholly umbral.
		expect(minutes(eclipse.center1!, eclipse.external1!)).toBeGreaterThan(0)
		expect(minutes(eclipse.internal1!, eclipse.center1!)).toBeGreaterThan(0)
	}

	const reappearances = [
		['tethys', utc(4, 1, 17, 16)],
		['dione', utc(4, 3, 9, 43)],
		['rhea', utc(4, 2, 0, 52)],
	] as const

	for (const [moon, reference] of reappearances) {
		const occultation = find(moon, 'satelliteOccultation', timeShift(reference, -0.06))
		expect(Math.abs(minutes(occultation.external2!, timeShift(reference, -0.5 / 1440)))).toBeLessThan(2)
	}
})

test('Titan and Iapetus phenomena get their whole contacts despite their length', () => {
	// Titan's 2025-04-13 transit lasts about 5.6 hours, beyond a six-hour walk from either side of a long event.
	const transit = find('titan', 'satelliteTransit', utc(4, 13, 17))
	expect(transit.external1).toBeDefined()
	expect(transit.external2).toBeDefined()
	expect(minutes(transit.external2!, transit.external1!) / 60).toBeGreaterThan(5)
	const shadow = find('titan', 'shadowTransit', utc(4, 13, 14))
	expect(shadow.visibleStart).toBeDefined()
	// After conjunction with the Sun the shadow runs ahead of the moon.
	expect(minutes(transit.external1!, shadow.external1!)).toBeGreaterThan(0)
})

test('every contact sequence is ordered', () => {
	for (const p of APRIL) {
		const order = [p.external1, p.center1, p.internal1, p.maximum, p.internal2, p.center2, p.external2].filter((t) => t !== undefined)
		for (let i = 1; i < order.length; i++) expect(timeSubtract(order[i], order[i - 1])).toBeGreaterThanOrEqual(-1e-9)
		expect(p.grazing).toBeFalse()
		expect(p.depth).toBeLessThan(0)
	}
})

test('every sampled disk overlap belongs to a found transit or occultation', () => {
	const start = utc(4, 1)
	const stop = utc(4, 2, 12)
	const found = saturnianPhenomena(EPHEMERIS, timeShift(start, -0.5), timeShift(stop, 0.5), { kinds: ['satelliteTransit', 'satelliteOccultation'] })

	for (let x = 0; x <= timeSubtract(stop, start); x += 10 / 1440) {
		const time = timeShift(start, x)

		for (const moon of saturnianView(EPHEMERIS, time).moons) {
			if (moon.disk === 'clear') continue
			const kind = moon.disk === 'transit' ? 'satelliteTransit' : 'satelliteOccultation'
			const holder = found.find((p) => p.moon === moon.moon && p.kind === kind && timeSubtract(time, p.external1!) >= -1e-6 && timeSubtract(p.external2!, time) >= -1e-6)
			expect(holder).toBeDefined()
		}
	}
})

test('consecutive half-open windows partition the phenomena', () => {
	const split = utc(4, 5, 13, 58)
	const whole = saturnianPhenomena(EPHEMERIS, utc(4, 5), utc(4, 6), { moons: ['titan', 'tethys'] })
	const parts = [...saturnianPhenomena(EPHEMERIS, utc(4, 5), split, { moons: ['titan', 'tethys'] }), ...saturnianPhenomena(EPHEMERIS, split, utc(4, 6), { moons: ['titan', 'tethys'] })]
	expect(parts.map((p) => `${p.moon}|${p.kind}`)).toEqual(whole.map((p) => `${p.moon}|${p.kind}`))
	for (const [i, p] of parts.entries()) expect(timeSubtract(p.maximum, whole[i].maximum) * DAYSEC).toBeCloseTo(0, 1)
})

test('no phenomenon happens with the rings wide open', () => {
	// In June 2017 the rings were open by 26°: every moon passes well north of the disk and its shadow.
	expect(saturnianPhenomena(EPHEMERIS, utc(6, 1, 0, 0, 2017), utc(6, 4, 0, 0, 2017))).toEqual([])
})
