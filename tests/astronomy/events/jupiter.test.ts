import { expect, test } from 'bun:test'
import { earth, jupiter } from '../../../src/astronomy/ephemeris/models/analytical/vsop87e'
import { greatRedSpotTransits, jupiterCentralMeridian } from '../../../src/astronomy/events/jupiter'
import { type Time, Timescale, timeSubtract, timeYMDHMS } from '../../../src/astronomy/time/time'
import { type Vec3, vecMinus } from '../../../src/math/linear-algebra/vec3'
import { deg, toDeg } from '../../../src/math/units/angle'

// Reference central-meridian longitudes and transit times come from PyEphem 4.x (ephem.Jupiter cmlI /
// cmlII), which computes the geocentric System I and II longitudes directly. The residuals are ~0.001 deg
// and sub-second, the difference between the VSOP87E + IAU-orientation pipeline here and PyEphem's own
// Jupiter model.

// Vector from Jupiter's centre to the geocentric observer (AU, ICRF) at a time.
function jupiterToEarth(time: Time): Vec3 {
	return vecMinus(earth(time)[0], jupiter(time)[0])
}

// Window start for the transit test, and a small set of instants for the central-meridian checks.
const T0 = timeYMDHMS(2026, 6, 29, 0, 0, 0, Timescale.UTC)

test('the System II central meridian matches PyEphem', () => {
	// PyEphem cmlII (deg): 328.2794, 4.5304, 118.3048, 58.3570 at the four instants below.
	expect(toDeg(jupiterCentralMeridian('II', T0, jupiterToEarth(T0)))).toBeCloseTo(328.2794, 2)
	const t1 = timeYMDHMS(2026, 6, 29, 1, 0, 0, Timescale.UTC)
	expect(toDeg(jupiterCentralMeridian('II', t1, jupiterToEarth(t1)))).toBeCloseTo(4.5304, 2)
	const t2 = timeYMDHMS(2026, 6, 30, 0, 0, 0, Timescale.UTC)
	expect(toDeg(jupiterCentralMeridian('II', t2, jupiterToEarth(t2)))).toBeCloseTo(118.3048, 2)
	const t3 = timeYMDHMS(2026, 7, 2, 0, 0, 0, Timescale.UTC)
	expect(toDeg(jupiterCentralMeridian('II', t3, jupiterToEarth(t3)))).toBeCloseTo(58.357, 2)
})

test('the System I central meridian matches PyEphem', () => {
	// PyEphem cmlI (deg): 15.8210, 52.3899 one hour later; System I turns faster than System II.
	expect(toDeg(jupiterCentralMeridian('I', T0, jupiterToEarth(T0)))).toBeCloseTo(15.821, 2)
	const t1 = timeYMDHMS(2026, 6, 29, 1, 0, 0, Timescale.UTC)
	expect(toDeg(jupiterCentralMeridian('I', t1, jupiterToEarth(t1)))).toBeCloseTo(52.3899, 2)
})

test('Great Red Spot transits match PyEphem', () => {
	// PyEphem transit times of a spot at System II longitude 50 deg over the 48 h from T0, as offsets in
	// hours: +2.2542, +12.1850, +22.1156, +32.0464, +41.9772 (~9h56m apart, the System II rotation).
	const grsLongitude = deg(50)
	const transits = greatRedSpotTransits(grsLongitude, jupiterToEarth, T0, timeYMDHMS(2026, 7, 1, 0, 0, 0, Timescale.UTC))
	expect(transits.length).toBe(5)

	const reference = [2.2542, 12.185, 22.1156, 32.0464, 41.9772]
	for (let i = 0; i < transits.length; i++) {
		const hours = timeSubtract(transits[i], T0, Timescale.UTC) * 24
		expect(Math.abs(hours - reference[i]) * 3600).toBeLessThan(3)
		// At every transit the System II central meridian coincides with the spot's longitude.
		expect(toDeg(jupiterCentralMeridian('II', transits[i], jupiterToEarth(transits[i])))).toBeCloseTo(50, 1)
	}

	// Transits are chronological and one System II rotation (~9.93 h) apart, with no anti-transits mixed in.
	for (let i = 1; i < transits.length; i++) {
		const gap = timeSubtract(transits[i], transits[i - 1], Timescale.UTC) * 24
		expect(gap).toBeCloseTo(9.93, 1)
	}
})
