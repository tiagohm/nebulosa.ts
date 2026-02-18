import { describe, expect, test } from 'bun:test'
import { arcmin, deg, hour, toArcmin, toDeg } from '../src/angle'
import { DEFAULT_REFRACTION_PARAMETERS } from '../src/astrometry'
import { meter } from '../src/distance'
import { geodeticLocation, localSiderealTime } from '../src/location'
import { polarAlignmentError, ThreePointPolarAlignment, threePointPolarAlignmentError } from '../src/polaralignment'
import { timeYMDHMS } from '../src/time'

describe('computed polar alignment error', () => {
	const time = timeYMDHMS(2025, 9, 7, 12, 0, 0)
	const northLocation = geodeticLocation(deg(-45), deg(22), meter(800))
	const southLocation = geodeticLocation(deg(-45), deg(-22), meter(800))
	time.location = northLocation
	const LST = localSiderealTime(time, undefined, true) // mean sidereal time

	const P1_RA = LST - hour(1)
	const P2_RA = LST
	const P3_RA = LST + hour(1)

	const precision = -Math.log10(2 * 2) // -log(2 * precision)

	test('northern hemisphere', () => {
		time.location = northLocation

		for (let orie = 0; orie <= 1; orie++) {
			for (let az = -60; az <= 60; az += 10) {
				for (let al = -60; al <= 60; al += 10) {
					for (let dec = -40; dec <= 40; dec += 10) {
						const [p1, p2, p3] = [orie === 0 ? P3_RA : P1_RA, P2_RA, orie === 0 ? P1_RA : P3_RA].map((ra) => [...polarAlignmentError(ra, deg(dec), time.location!.latitude, LST, arcmin(az), arcmin(al)), time] as const)
						const result = threePointPolarAlignmentError(p1, p2, p3, false)

						expect(toArcmin(result.azimuthError)).toBeCloseTo(az, precision)
						expect(toArcmin(result.altitudeError)).toBeCloseTo(al, precision)
					}
				}
			}
		}
	})

	test('southern hemisphere', () => {
		time.location = southLocation

		for (let orie = 0; orie <= 1; orie++) {
			for (let az = -60; az <= 60; az += 10) {
				for (let al = -60; al <= 60; al += 10) {
					for (let dec = -40; dec <= 40; dec += 10) {
						const [p1, p2, p3] = [orie === 0 ? P3_RA : P1_RA, P2_RA, orie === 0 ? P1_RA : P3_RA].map((ra) => [...polarAlignmentError(ra, deg(dec), time.location!.latitude, LST, arcmin(az), arcmin(al)), time] as const)
						const result = threePointPolarAlignmentError(p1, p2, p3, false)

						expect(toArcmin(result.azimuthError)).toBeCloseTo(az, precision)
						expect(toArcmin(result.altitudeError)).toBeCloseTo(al, precision)
					}
				}
			}
		}
	})
})

// https://bitbucket.org/Isbeorn/nina.plugin.polaralignment/src/master/NINA.Plugins.PolarAlignment.Test/PolarErrorDeterminationTest.cs

test('initial mount error for both point directions', () => {
	const time = timeYMDHMS(2000, 1, 1, 0, 0, 0)
	time.location = geodeticLocation(deg(7), deg(49), meter(250))

	const pa1 = new ThreePointPolarAlignment(false)
	pa1.add(deg(20), deg(40), time, true)
	pa1.add(deg(60), deg(41), time, true)
	const error1 = pa1.add(deg(90), deg(42), time, true)

	const pa2 = new ThreePointPolarAlignment(false)
	pa2.add(deg(90), deg(42), time, true)
	pa2.add(deg(60), deg(41), time, true)
	const error2 = pa2.add(deg(20), deg(40), time, true)

	expect(error1).not.toBeFalse()
	expect(error2).not.toBeFalse()

	if (!error1 || !error2) return

	const totalError = Math.hypot(error1.altitudeError, error1.azimuthError)

	expect(toDeg(totalError)).not.toBeCloseTo(0, 8)
	expect(error1.altitudeError).toBeCloseTo(error2.altitudeError, 8)
	expect(error1.azimuthError).toBeCloseTo(error2.azimuthError, 8)
})

test('no declination error', () => {
	const time = timeYMDHMS(2000, 1, 1, 0, 0, 0)
	time.location = geodeticLocation(deg(7), deg(49), meter(250))

	const pa = new ThreePointPolarAlignment(false)
	pa.add(deg(20), deg(40), time, true)
	pa.add(deg(60), deg(40), time, true)
	const error = pa.add(deg(90), deg(40), time, true)

	expect(error).not.toBeFalse()

	if (!error) return

	const precision = -Math.log10(2 * 0.0001)

	expect(error.altitudeError).toBeCloseTo(0, precision)
	expect(error.azimuthError).toBeCloseTo(0, precision)
})

test('very different altitude points and true pole', () => {
	const time = timeYMDHMS(2000, 1, 1, 0, 0, 0)
	time.location = geodeticLocation(deg(0), deg(40), meter(250))

	const pa = new ThreePointPolarAlignment({ pressure: 1005, temperature: 7, relativeHumidity: 0.8, wl: 0.574 })
	// values calculated with Astropy and quaternion rotations
	pa.add(deg(186.4193401), deg(27.75369312), time, true)
	pa.add(deg(156.6798968), deg(27.40124463), time, true)
	const error = pa.add(deg(127.00972423), deg(27.34989335), time, true)

	expect(error).not.toBeFalse()

	if (!error) return

	const precision = -Math.log10(2 * 0.045)

	expect(toDeg(error.altitudeError)).toBeCloseTo(1, precision)
	expect(toDeg(error.azimuthError)).toBeCloseTo(1, precision)
})

test('very different altitude points and refracted pole', () => {
	const time = timeYMDHMS(2000, 1, 1, 0, 0, 0)
	time.location = geodeticLocation(deg(0), deg(40), meter(250))

	const pa = new ThreePointPolarAlignment(false)
	// values calculated with Astropy and quaternion rotations
	pa.add(deg(186.4193401), deg(27.75369312), time, true)
	pa.add(deg(156.6798968), deg(27.40124463), time, true)
	const error = pa.add(deg(127.00972423), deg(27.34989335), time, true)

	expect(error).not.toBeFalse()

	if (!error) return

	const precision = -Math.log10(2 * 0.045)

	expect(toDeg(error.altitudeError)).toBeCloseTo(1 - 69.3 / 3600, precision)
	expect(toDeg(error.azimuthError)).toBeCloseTo(1, precision)
})

// https://github.com/KDE/kstars/blob/4d8d1eed3071090aeeaf9eb3980eb30242342c34/Tests/polaralign/test_polaralign.cpp#L673
describe.skip('after adjustment I', () => {
	const location = geodeticLocation(deg(-121.956), deg(37.363)) // sillicon valley

	const input = [
		[211.174, 60.8994, 2022, 5, 30, 5, 11, 11],
		[233.324, 60.632, 2022, 5, 30, 5, 11, 34],
		[254.451, 60.3434, 2022, 5, 30, 5, 11, 57],

		// right at start Estimated current adjustment: Az 0.0' Alt 0.0' residual 4a-s"
		[254.454, 60.346, 2022, 5, 30, 5, 13, 3],
		// refresh 25, Estimated current adjustment: Az 0.0' Alt -28.0' residual 23a-s"
		[253.841, 60.054, 2022, 5, 30, 5, 14, 31],
		// refresh 26, Estimated current adjustment: Az 0.0' Alt -28.0' residual 26a-s"
		[253.842, 60.054, 2022, 5, 30, 5, 14, 34],

		// refresh 27, Estimated current adjustment: Az 11.0' Alt -23.0' residual 220a-s"
		[253.769, 60.207, 2022, 5, 30, 5, 14, 48],
		// refresh 28, Estimated current adjustment: Az 10.0' Alt -22.0' residual 265a-s"
		[253.769, 60.206, 2022, 5, 30, 5, 14, 52],
		// refresh 29, Estimated current adjustment: Az 17.0' Alt -19.0' residual 409a-s"
		[253.724, 60.297, 2022, 5, 30, 5, 15, 2],
		// refresh 36, Estimated current adjustment: Az 27.0' Alt -15.0' residual 607a-s"
		[253.656, 60.429, 2022, 5, 30, 5, 15, 28],
	] as const

	test('refraction', () => {
		const pa = new ThreePointPolarAlignment(DEFAULT_REFRACTION_PARAMETERS)

		const output = [
			[0.630769, -0.455568, 0.0, -0.001389],
			[0.640625, 0.001814, -0.006021, -0.458798],
			[0.643341, -0.001003, -0.00876, -0.455982],
			[0.38739, 0.002737, 0.247222, -0.459722],
			[0.391545, 0.001349, 0.243056, -0.458333],
			[0.236025, 0.005515, 0.398611, -0.4625],
			[0.015507, 0.007205, 0.619144, -0.46419],
		] as const

		let i = 0
		const precision = -Math.log10(2 * 0.01)

		for (const step of input) {
			i++

			const time = timeYMDHMS(step[2], step[3], step[4], step[5], step[6], step[7])
			time.location = location

			const result = pa.add(deg(step[0]), deg(step[1]), time, true)

			if (result && i >= 4) {
				const o = output[i - 4]

				expect(toDeg(result.azimuthError)).toBeCloseTo(o[0], precision)
				expect(toDeg(result.altitudeError)).toBeCloseTo(o[1], precision)
				expect(toDeg(result.azimuthAdjustment)).toBeCloseTo(o[2], precision)
				expect(toDeg(result.altitudeAdjustment)).toBeCloseTo(o[3], precision)
			}
		}
	})

	test('no refraction', () => {
		const pa = new ThreePointPolarAlignment(false)

		const output = [
			[0.629487, -0.46887, 0.0, -0.001389],
			[0.638555, -0.010883, -0.005237, -0.459403],
			[0.64266, -0.013699, -0.009365, -0.456587],
			[0.384722, -0.009175, 0.248611, -0.461111],
			[0.390254, -0.011953, 0.243056, -0.458333],
			[0.234734, -0.007787, 0.398611, -0.4625],
			[0.0136, -0.00533, 0.619766, -0.464956],
		] as const

		let i = 0
		const precision = -Math.log10(2 * 0.01)

		for (const step of input) {
			i++

			const time = timeYMDHMS(step[2], step[3], step[4], step[5], step[6], step[7])
			time.location = location

			const result = pa.add(deg(step[0]), deg(step[1]), time, true)

			if (result && i >= 4) {
				const o = output[i - 4]

				expect(toDeg(result.azimuthError)).toBeCloseTo(o[0], precision)
				expect(toDeg(result.altitudeError)).toBeCloseTo(o[1], precision)
				expect(toDeg(result.azimuthAdjustment)).toBeCloseTo(o[2], precision)
				expect(toDeg(result.altitudeAdjustment)).toBeCloseTo(o[3], precision)
			}
		}
	})
})
