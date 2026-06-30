import { expect, test } from 'bun:test'
import { icrs } from '../../../src/astronomy/coordinates/icrs'
import { earth, sun } from '../../../src/astronomy/ephemeris/models/analytical/vsop87e'
import { ASTRONOMICAL_TWILIGHT, riseTransitSet, STANDARD_HORIZON, SUN_HORIZON } from '../../../src/astronomy/events/horizon'
import { Ellipsoid, geodeticLocation } from '../../../src/astronomy/observer/location'
import { type Time, Timescale, timeToDate, timeYMDHMS, utc } from '../../../src/astronomy/time/time'
import { vecMinus } from '../../../src/math/linear-algebra/vec3'
import { deg, hms, toDeg } from '../../../src/math/units/angle'
import { kilometer } from '../../../src/math/units/distance'

// São Paulo observer (longitude east-positive) and a UTC midnight window start.
const SITE = geodeticLocation(deg(-46.633), deg(-23.55), kilometer(0.76), Ellipsoid.WGS84)
const DAY = timeYMDHMS(2026, 6, 29, 0, 0, 0, Timescale.UTC)

// Geocentric apparent direction toward the Sun from the VSOP87E ephemeris.
function sunDirection(time: Time) {
	return vecMinus(sun(time)[0], earth(time)[0])
}

// Sirius (ICRS J2000) as a fixed geocentric direction.
const SIRIUS = icrs(hms(6, 45, 8.917), deg(-16.716116))

// Reference values from Astropy (geometric AltAz, pressure=0) for the same site and day.
function utcMinute(time?: Time) {
	return time && timeToDate(utc(time)).slice(0, 5)
}

test('riseTransitSet of the Sun matches the Astropy almanac to the minute', () => {
	const rts = riseTransitSet(sunDirection, SITE, DAY, { horizon: SUN_HORIZON })
	// Astropy: rise 09:49:06, transit 15:10:06, set 20:31:04, max altitude 43.246 deg.
	expect(utcMinute(rts.rise)).toEqual([2026, 6, 29, 9, 49])
	expect(utcMinute(rts.transit)).toEqual([2026, 6, 29, 15, 10])
	expect(utcMinute(rts.set)).toEqual([2026, 6, 29, 20, 31])
	expect(toDeg(rts.transitAltitude)).toBeCloseTo(43.246, 1)
	expect(rts.alwaysUp).toBeFalse()
	expect(rts.alwaysDown).toBeFalse()
})

test('astronomical twilight is the Sun crossing -18 deg', () => {
	const rts = riseTransitSet(sunDirection, SITE, DAY, { horizon: ASTRONOMICAL_TWILIGHT })
	// The rising crossing is dawn, the setting crossing is dusk.
	// Astropy: dawn 08:28:34, dusk 21:51:35.
	expect(utcMinute(rts.rise)).toEqual([2026, 6, 29, 8, 28])
	expect(utcMinute(rts.set)).toEqual([2026, 6, 29, 21, 51])
})

test('riseTransitSet of a star uses the point-source horizon', () => {
	const rts = riseTransitSet(() => SIRIUS, SITE, DAY, { horizon: STANDARD_HORIZON })
	// Astropy: rise 08:50:16, transit 15:21:57, set 21:53:37, max altitude 83.19 deg.
	expect(utcMinute(rts.rise)).toEqual([2026, 6, 29, 8, 50])
	expect(utcMinute(rts.transit)).toEqual([2026, 6, 29, 15, 21])
	expect(utcMinute(rts.set)).toEqual([2026, 6, 29, 21, 53])
	expect(toDeg(rts.transitAltitude)).toBeCloseTo(83.19, 1)
})

test('a south-circumpolar star never sets at a southern site', () => {
	// Declination -85 deg stays above the horizon for the whole day at latitude -23.55 deg.
	const rts = riseTransitSet(() => icrs(deg(90), deg(-85)), SITE, DAY, { horizon: STANDARD_HORIZON })
	expect(rts.alwaysUp).toBeTrue()
	expect(rts.alwaysDown).toBeFalse()
	expect(rts.rise).toBeUndefined()
	expect(rts.set).toBeUndefined()
	// The culmination is still reported, above the horizon.
	expect(rts.transit).toBeDefined()
	expect(rts.transitAltitude).toBeGreaterThan(STANDARD_HORIZON)
})

test('a far-northern star never rises at a southern site', () => {
	// Declination +85 deg never reaches the horizon at latitude -23.55 deg.
	const rts = riseTransitSet(() => icrs(deg(90), deg(85)), SITE, DAY, { horizon: STANDARD_HORIZON })
	expect(rts.alwaysDown).toBeTrue()
	expect(rts.alwaysUp).toBeFalse()
	expect(rts.rise).toBeUndefined()
	expect(rts.set).toBeUndefined()
	expect(rts.transitAltitude).toBeLessThan(STANDARD_HORIZON)
})
