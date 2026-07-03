import { expect, test } from 'bun:test'
import type { PositionAndVelocity } from '../../../src/astronomy/coordinates/astrometry'
import { observerState } from '../../../src/astronomy/coordinates/correction'
import { earth, mercury, sun, venus } from '../../../src/astronomy/ephemeris/models/analytical/vsop87e'
import { planetaryTransits } from '../../../src/astronomy/events/transit'
import { Ellipsoid, geodeticLocation } from '../../../src/astronomy/observer/location'
import { type Time, Timescale, timeYMDHMS, toJulianDay, tt } from '../../../src/astronomy/time/time'
import { DAYSEC, SUN_RADIUS_AU } from '../../../src/core/constants'
import { deg, toArcsec, toDeg } from '../../../src/math/units/angle'
import { kilometer } from '../../../src/math/units/distance'

// Physical radii (AU) of the Sun and the two inner planets.
const MERCURY_RADIUS = kilometer(2439.7)
const VENUS_RADIUS = kilometer(6051.8)

// Greenwich and Tokyo, the observing sites for the two validated transits.
const GREENWICH = geodeticLocation(deg(-0.0015), deg(51.4779), kilometer(0.047), Ellipsoid.WGS84)
const TOKYO = geodeticLocation(deg(139.6503), deg(35.6762), kilometer(0.04), Ellipsoid.WGS84)

// Barycentric topocentric observer at `site` (Earth centre plus the diurnal offset).
function observerAt(site: typeof GREENWICH): (time: Time) => PositionAndVelocity {
	return (time: Time) => observerState(time, earth(time), site) as PositionAndVelocity
}

// Offset of a contact from a Skyfield reference instant, in seconds. The reference is DE440 with astrometric
// (light-time only) places — no aberration or deflection — matching the engine; the reference Julian days are
// TT, so the contact is compared in TT. Returns +Infinity for a missing contact so a test fails loudly.
function contactError(contact: Time | undefined, referenceJdTt: number): number {
	if (contact === undefined) return Number.POSITIVE_INFINITY
	return Math.abs(toJulianDay(tt(contact)) - referenceJdTt) * DAYSEC
}

// The two transits below are cross-checked against Skyfield (DE440, topocentric astrometric separation): the
// four contacts land within ~1 s, the impact parameter within ~0.1", and the contact position angles within
// ~0.1 deg. VSOP87E holds this accuracy even at the 2117 epoch.

test('predicts the four contacts of the 2032-11-13 Mercury transit from Greenwich', () => {
	const observer = observerAt(GREENWICH)
	const [transit, ...rest] = planetaryTransits(mercury, sun, observer, timeYMDHMS(2032, 11, 13, 5, 0, 0, Timescale.UTC), timeYMDHMS(2032, 11, 13, 12, 0, 0, Timescale.UTC), { sunRadius: SUN_RADIUS_AU, planetRadius: MERCURY_RADIUS })
	expect(rest.length).toBe(0)
	expect(transit).toBeDefined()
	expect(transit.full).toBe(true)

	// Contacts I, II, III, IV versus Skyfield (TT), within ~1 s.
	expect(contactError(transit.exteriorIngress, 2463549.779682)).toBeLessThan(2)
	expect(contactError(transit.interiorIngress, 2463549.781121)).toBeLessThan(2)
	expect(contactError(transit.interiorEgress, 2463549.963249)).toBeLessThan(2)
	expect(contactError(transit.exteriorEgress, 2463549.964686)).toBeLessThan(2)

	// Impact parameter (least centre-to-centre separation) and the exterior-contact position angles (N->E).
	expect(toArcsec(transit.minSeparation)).toBeCloseTo(569.44, 1)
	expect(toDeg(transit.ingressPositionAngle!)).toBeCloseTo(77.78, 1)
	expect(toDeg(transit.egressPositionAngle!)).toBeCloseTo(329.23, 1)

	// Total contact I -> IV duration, ~4.44 h, equals the exterior-egress minus exterior-ingress span.
	expect(transit.duration! / 3600).toBeCloseTo(4.44, 1)
})

test('predicts the four contacts of the 2117-12-11 Venus transit from Tokyo', () => {
	const observer = observerAt(TOKYO)
	const [transit, ...rest] = planetaryTransits(venus, sun, observer, timeYMDHMS(2117, 12, 10, 23, 0, 0, Timescale.UTC), timeYMDHMS(2117, 12, 11, 6, 0, 0, Timescale.UTC), { sunRadius: SUN_RADIUS_AU, planetRadius: VENUS_RADIUS })
	expect(rest.length).toBe(0)
	expect(transit).toBeDefined()
	expect(transit.full).toBe(true)

	expect(contactError(transit.exteriorIngress, 2494622.501878)).toBeLessThan(3)
	expect(contactError(transit.interiorIngress, 2494622.517027)).toBeLessThan(3)
	expect(contactError(transit.interiorEgress, 2494622.724164)).toBeLessThan(3)
	expect(contactError(transit.exteriorEgress, 2494622.739285)).toBeLessThan(3)

	expect(toArcsec(transit.minSeparation)).toBeCloseTo(703.28, 0)
	expect(toDeg(transit.ingressPositionAngle!)).toBeCloseTo(59.81, 1)
	expect(toDeg(transit.egressPositionAngle!)).toBeCloseTo(328.81, 1)
	expect(transit.duration! / 3600).toBeCloseTo(5.698, 1)
})

test('reports no transit for a window with no inferior conjunction crossing', () => {
	const observer = observerAt(GREENWICH)
	// A month after the real transit: Mercury has moved well off the Sun, so the separation never reaches the
	// disk and no transit is reported.
	const transits = planetaryTransits(mercury, sun, observer, timeYMDHMS(2032, 12, 13, 0, 0, 0, Timescale.UTC), timeYMDHMS(2032, 12, 14, 0, 0, 0, Timescale.UTC), { sunRadius: SUN_RADIUS_AU, planetRadius: MERCURY_RADIUS })
	expect(transits.length).toBe(0)
})

test('leaves ingress contacts undefined when the window opens after ingress', () => {
	const observer = observerAt(GREENWICH)
	// Window opens at 07:30, after both ingress contacts (06:41, 06:44) but before mid-transit (08:55): the
	// appulse and both egress contacts are in-window, the ingress contacts and the I->IV duration are not.
	const [transit] = planetaryTransits(mercury, sun, observer, timeYMDHMS(2032, 11, 13, 7, 30, 0, Timescale.UTC), timeYMDHMS(2032, 11, 13, 12, 0, 0, Timescale.UTC), { sunRadius: SUN_RADIUS_AU, planetRadius: MERCURY_RADIUS })
	expect(transit).toBeDefined()
	expect(transit.full).toBe(true)
	expect(transit.exteriorIngress).toBeUndefined()
	expect(transit.interiorIngress).toBeUndefined()
	expect(transit.duration).toBeUndefined()
	expect(contactError(transit.interiorEgress, 2463549.963249)).toBeLessThan(2)
	expect(contactError(transit.exteriorEgress, 2463549.964686)).toBeLessThan(2)
})

test('leaves egress contacts undefined when the window closes before egress', () => {
	const observer = observerAt(GREENWICH)
	// Window closes at 09:00, after mid-transit (08:55) but before the egress contacts: the appulse and both
	// ingress contacts are in-window, the egress contacts and the I->IV duration are not. Truncation is
	// symmetric with the opens-after-ingress case above.
	const [transit] = planetaryTransits(mercury, sun, observer, timeYMDHMS(2032, 11, 13, 5, 0, 0, Timescale.UTC), timeYMDHMS(2032, 11, 13, 9, 0, 0, Timescale.UTC), { sunRadius: SUN_RADIUS_AU, planetRadius: MERCURY_RADIUS })
	expect(transit).toBeDefined()
	expect(transit.full).toBe(true)
	expect(transit.exteriorEgress).toBeUndefined()
	expect(transit.interiorEgress).toBeUndefined()
	expect(transit.duration).toBeUndefined()
	expect(contactError(transit.exteriorIngress, 2463549.779682)).toBeLessThan(2)
	expect(contactError(transit.interiorIngress, 2463549.781121)).toBeLessThan(2)
})

test('catches an appulse in the last interval when the window ends just after mid-transit', () => {
	const observer = observerAt(GREENWICH)
	// Window ends at 08:55, ~12 s after mid-transit (08:54:48): the appulse sits in the last coarse interval,
	// which searchExtrema cannot bracket, so it is recovered by the in-window boundary minimization.
	const [transit, ...rest] = planetaryTransits(mercury, sun, observer, timeYMDHMS(2032, 11, 13, 5, 0, 0, Timescale.UTC), timeYMDHMS(2032, 11, 13, 8, 55, 0, Timescale.UTC), { sunRadius: SUN_RADIUS_AU, planetRadius: MERCURY_RADIUS })
	expect(rest.length).toBe(0)
	expect(transit).toBeDefined()
	expect(transit.full).toBe(true)
	// The true impact parameter is recovered (not a boundary-value artifact).
	expect(toArcsec(transit.minSeparation)).toBeCloseTo(569.44, 1)
	// Ingress contacts are in-window; egress contacts and the I->IV duration are not.
	expect(contactError(transit.exteriorIngress, 2463549.779682)).toBeLessThan(2)
	expect(contactError(transit.interiorIngress, 2463549.781121)).toBeLessThan(2)
	expect(transit.exteriorEgress).toBeUndefined()
	expect(transit.interiorEgress).toBeUndefined()
	expect(transit.duration).toBeUndefined()
})

test('catches an appulse in the first interval when the window starts just before mid-transit', () => {
	const observer = observerAt(GREENWICH)
	// Window starts at 08:54:30, ~18 s before mid-transit: the appulse sits in the first coarse interval, again
	// recovered by the boundary minimization. Egress contacts are in-window, ingress contacts are not.
	const [transit, ...rest] = planetaryTransits(mercury, sun, observer, timeYMDHMS(2032, 11, 13, 8, 54, 30, Timescale.UTC), timeYMDHMS(2032, 11, 13, 12, 0, 0, Timescale.UTC), { sunRadius: SUN_RADIUS_AU, planetRadius: MERCURY_RADIUS })
	expect(rest.length).toBe(0)
	expect(transit).toBeDefined()
	expect(transit.full).toBe(true)
	expect(toArcsec(transit.minSeparation)).toBeCloseTo(569.44, 1)
	expect(transit.exteriorIngress).toBeUndefined()
	expect(transit.interiorIngress).toBeUndefined()
	expect(contactError(transit.interiorEgress, 2463549.963249)).toBeLessThan(2)
	expect(contactError(transit.exteriorEgress, 2463549.964686)).toBeLessThan(2)
})

test('reports no transit when the window opens after mid-transit', () => {
	const observer = observerAt(GREENWICH)
	// Detection anchors on the appulse: a window from 09:30 (after mid-transit at 08:55) to 12:00 excludes the
	// closest approach, so no transit is reported even though the egress contacts (11:06, 11:08) are still
	// ahead. The window must bracket the mid-transit instant.
	const transits = planetaryTransits(mercury, sun, observer, timeYMDHMS(2032, 11, 13, 9, 30, 0, Timescale.UTC), timeYMDHMS(2032, 11, 13, 12, 0, 0, Timescale.UTC), { sunRadius: SUN_RADIUS_AU, planetRadius: MERCURY_RADIUS })
	expect(transits.length).toBe(0)
})

test('an empty window yields no transits', () => {
	const observer = observerAt(GREENWICH)
	const start = timeYMDHMS(2032, 11, 13, 12, 0, 0, Timescale.UTC)
	const stop = timeYMDHMS(2032, 11, 13, 5, 0, 0, Timescale.UTC)
	expect(planetaryTransits(mercury, sun, observer, start, stop, { sunRadius: SUN_RADIUS_AU, planetRadius: MERCURY_RADIUS }).length).toBe(0)
})
