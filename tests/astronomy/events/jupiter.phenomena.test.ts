import { describe, expect, test } from 'bun:test'
import { analyticalJovianEphemeris, type GalileanMoon, interpolatedJovianEphemeris } from '../../../src/astronomy/ephemeris/jovian'
import { jovianMoonMargins, jovianShadowPoint, jovianSystemState } from '../../../src/astronomy/events/jupiter.geometry'
import { type JovianPhenomenon, type JovianPhenomenonKind, jovianPhenomena } from '../../../src/astronomy/events/jupiter.phenomena'
import { type Time, Timescale, timeShift, timeSubtract, timeYMDHMS } from '../../../src/astronomy/time/time'

// Reference contacts come from JPL Horizons observer tables, quantity 12 (satellite visibility codes),
// fetched 2026-11-07 at 10 s steps (jup365_merged + DE441). Horizons tests limb-to-limb contacts with a
// spherical Jupiter of equatorial radius and the satellites' equatorial radii, so the oblate model here
// agrees within seconds for paths near Jupiter's equator and tens of seconds for Callisto's high paths;
// the L1.2 theory adds its own few-second difference from JUP365. Each reference is the midpoint of the
// 10 s interval in which the Horizons code changes.

const EPHEMERIS = interpolatedJovianEphemeris(analyticalJovianEphemeris)
const START = timeYMDHMS(2026, 12, 1, 0, 0, 0, Timescale.UTC)
const STOP = timeYMDHMS(2026, 12, 4, 0, 0, 0, Timescale.UTC)
const PHENOMENA = jovianPhenomena(EPHEMERIS, START, STOP)

// The phenomenon of a moon and kind whose maximum is nearest to an instant.
function find(moon: GalileanMoon, kind: JovianPhenomenonKind, near: Time): JovianPhenomenon {
	const candidates = PHENOMENA.filter((p) => p.moon === moon && p.kind === kind)
	candidates.sort((a, b) => Math.abs(timeSubtract(a.maximum, near)) - Math.abs(timeSubtract(b.maximum, near)))
	expect(candidates.length).toBeGreaterThan(0)
	return candidates[0]
}

// Seconds from b to a.
function seconds(a: Time, b: Time) {
	return timeSubtract(a, b) * 86400
}

function utc(day: number, hour: number, minute: number, second: number) {
	return timeYMDHMS(2026, 12, day, hour, minute, second, Timescale.UTC)
}

describe('contacts agree with JPL Horizons', () => {
	test('Io transit on 2026-12-01', () => {
		const p = find('io', 'satelliteTransit', utc(1, 9, 0, 0))
		expect(Math.abs(seconds(p.external1!, utc(1, 7, 46, 21)))).toBeLessThan(15)
		expect(Math.abs(seconds(p.external2!, utc(1, 10, 7, 18)))).toBeLessThan(15)
	})

	test('Europa transit on 2026-12-01', () => {
		const p = find('europa', 'satelliteTransit', utc(1, 7, 36, 0))
		expect(Math.abs(seconds(p.external1!, utc(1, 6, 7, 29)))).toBeLessThan(15)
		expect(Math.abs(seconds(p.external2!, utc(1, 9, 5, 0)))).toBeLessThan(15)
	})

	test('Io eclipse and occultation on 2026-12-02', () => {
		// Horizons "p" -> "u": Io fully inside the umbra, the internal contact.
		const eclipse = find('io', 'satelliteEclipse', utc(2, 5, 0, 0))
		expect(Math.abs(seconds(eclipse.internal1!, utc(2, 3, 48, 13)))).toBeLessThan(15)
		// Before opposition the reappearance happens behind the disk: the eclipse ends during the occultation.
		const occultation = find('io', 'satelliteOccultation', utc(2, 6, 0, 0))
		expect(Math.abs(seconds(occultation.external1!, utc(2, 4, 58, 23)))).toBeLessThan(15)
		expect(Math.abs(seconds(occultation.external2!, utc(2, 7, 20, 38)))).toBeLessThan(15)
		expect(seconds(eclipse.external2!, occultation.external1!)).toBeGreaterThan(0)
	})

	test('Ganymede transit and Europa eclipse on 2026-12-02', () => {
		const transit = find('ganymede', 'satelliteTransit', utc(3, 0, 0, 0))
		expect(Math.abs(seconds(transit.external1!, utc(2, 22, 8, 35)))).toBeLessThan(15)
		expect(Math.abs(seconds(transit.external2!, utc(3, 1, 54, 30)))).toBeLessThan(25)

		const eclipse = find('europa', 'satelliteEclipse', utc(2, 23, 54, 0))
		expect(Math.abs(seconds(eclipse.internal1!, utc(2, 22, 30, 59)))).toBeLessThan(15)
		expect(Math.abs(seconds(eclipse.internal2!, utc(3, 1, 18, 5)))).toBeLessThan(15)
	})

	test('Callisto eclipse and occultation on 2026-12-02 and 03', () => {
		const eclipse = find('callisto', 'satelliteEclipse', utc(2, 23, 13, 0))
		expect(Math.abs(seconds(eclipse.internal1!, utc(2, 20, 55, 3)))).toBeLessThan(40)
		expect(Math.abs(seconds(eclipse.internal2!, utc(3, 1, 31, 46)))).toBeLessThan(40)

		const occultation = find('callisto', 'satelliteOccultation', utc(3, 10, 51, 0))
		expect(Math.abs(seconds(occultation.external1!, utc(3, 8, 23, 13)))).toBeLessThan(40)
		// Callisto's path crosses high on the disk, where the spherical Horizons limb stands farthest out.
		expect(Math.abs(seconds(occultation.external2!, utc(3, 13, 19, 43)))).toBeLessThan(60)
	})
})

test('contacts are ordered and complete for central phenomena', () => {
	expect(PHENOMENA.length).toBe(15)

	for (const p of PHENOMENA) {
		expect(p.grazing).toBeFalse()
		expect(p.depth).toBeLessThan(0)
		const order = [p.external1, p.internal1 ?? p.center1, p.maximum, p.internal2 ?? p.center2, p.external2]
		for (let i = 1; i < order.length; i++) expect(seconds(order[i]!, order[i - 1]!)).toBeGreaterThan(0)
		expect(seconds(p.center1!, p.external1!)).toBeGreaterThan(0)
		expect(seconds(p.external2!, p.center2!)).toBeGreaterThan(0)
	}

	// Results are chronological by maximum.
	for (let i = 1; i < PHENOMENA.length; i++) expect(seconds(PHENOMENA[i].maximum, PHENOMENA[i - 1].maximum)).toBeGreaterThanOrEqual(0)
})

test('the shadow transit precedes the transit before opposition, and its centre contacts match a ray scan', () => {
	const shadow = find('io', 'shadowTransit', utc(1, 7, 44, 0))
	const transit = find('io', 'satelliteTransit', utc(1, 9, 0, 0))
	// Before opposition the shadow leads the moon across the disk by about an hour.
	expect(seconds(transit.maximum, shadow.maximum)).toBeGreaterThan(3600)
	expect(shadow.visibleStart).toBeDefined()
	expect(shadow.visibleEnd).toBeDefined()

	// Independent method: step the shadow axis against the spheroid itself, one second at a time.
	const hits = (time: Time) => {
		const state = jovianSystemState(EPHEMERIS, time)
		return jovianShadowPoint(state, jovianMoonMargins(EPHEMERIS, state, 'io').shadow) !== undefined
	}

	for (const [contact, inside] of [
		[shadow.center1!, 1],
		[shadow.center2!, -1],
	] as const) {
		expect(hits(timeShift(contact, (inside * 2) / 86400))).toBeTrue()
		expect(hits(timeShift(contact, (-inside * 2) / 86400))).toBeFalse()
	}
})

test('the window is half-open on the maximum and keeps contacts beyond it', () => {
	const transit = find('io', 'satelliteTransit', utc(1, 9, 0, 0))
	// A window that starts after the first contact but before the maximum still reports the full transit...
	const late = jovianPhenomena(EPHEMERIS, timeShift(transit.maximum, -0.02), timeShift(transit.maximum, 0.02), { moons: ['io'], kinds: ['satelliteTransit'] })
	expect(late.length).toBe(1)
	expect(Math.abs(seconds(late[0].external1!, transit.external1!))).toBeLessThan(0.5)
	// ...and one that ends just before the maximum does not.
	expect(jovianPhenomena(EPHEMERIS, timeShift(transit.maximum, -0.1), timeShift(transit.maximum, -1e-5), { moons: ['io'], kinds: ['satelliteTransit'] }).length).toBe(0)
})

test('filters by moon and kind', () => {
	const only = jovianPhenomena(EPHEMERIS, START, STOP, { moons: ['europa'], kinds: ['satelliteEclipse'] })
	expect(only.length).toBe(PHENOMENA.filter((p) => p.moon === 'europa' && p.kind === 'satelliteEclipse').length)
	expect(only.every((p) => p.moon === 'europa' && p.kind === 'satelliteEclipse')).toBeTrue()
	expect(jovianPhenomena(EPHEMERIS, START, STOP, { moons: [] }).length).toBe(0)
})

test('Callisto misses the disk and the shadow when Jupiter is far from equinox', () => {
	// Mid-2024 the Earth and the Sun stood ~3° from Jupiter's equatorial plane.
	const callisto = jovianPhenomena(EPHEMERIS, timeYMDHMS(2024, 6, 1, 0, 0, 0, Timescale.UTC), timeYMDHMS(2024, 7, 1, 0, 0, 0, Timescale.UTC), { moons: ['callisto'] })
	expect(callisto.length).toBe(0)
})

test('the default step finds every phenomenon of a finer oracle scan', () => {
	const start = timeYMDHMS(2026, 11, 1, 0, 0, 0, Timescale.UTC)
	const stop = timeYMDHMS(2026, 11, 21, 0, 0, 0, Timescale.UTC)
	const coarse = jovianPhenomena(EPHEMERIS, start, stop)
	const fine = jovianPhenomena(EPHEMERIS, start, stop, { step: 2 / 1440 })
	expect(coarse.length).toBe(fine.length)

	for (let i = 0; i < fine.length; i++) {
		expect(coarse[i].kind).toBe(fine[i].kind)
		expect(coarse[i].moon).toBe(fine[i].moon)
		expect(Math.abs(seconds(coarse[i].maximum, fine[i].maximum))).toBeLessThan(1)
		expect(Math.abs(seconds(coarse[i].external1!, fine[i].external1!))).toBeLessThan(1)
	}
})
