import { describe, expect, test } from 'bun:test'
import { arcmin, deg, hour, parseAngle, toArcmin, toArcsec, toDeg } from '../src/angle'
import { DEFAULT_REFRACTION_PARAMETERS } from '../src/astrometry'
import { meter } from '../src/distance'
import { geodeticLocation, localSiderealTime } from '../src/location'
import { polarAlignmentError, ThreePointPolarAlignment, threePointPolarAlignmentError } from '../src/polaralignment'
import { timeYMDHMS } from '../src/time'

describe('computed polar alignment error', () => {
	const time = timeYMDHMS(2000, 1, 1, 12, 0, 0)
	const northLocation = geodeticLocation(deg(-45), deg(22), meter(800))
	const southLocation = geodeticLocation(deg(-45), deg(-22), meter(800))
	time.location = northLocation
	const LST = localSiderealTime(time)

	const P1_RA = LST - hour(1)
	const P2_RA = LST
	const P3_RA = LST + hour(1)

	const precision = -Math.log10(2 * 1.1) // -log(2 * precision)

	test('northern hemisphere without refraction', () => {
		time.location = northLocation

		for (let orie = 0; orie <= 1; orie++) {
			for (let az = -60; az <= 60; az += 10) {
				for (let al = -60; al <= 60; al += 10) {
					for (let dec = -40; dec <= 40; dec += 10) {
						const [p1, p2, p3] = [orie === 0 ? P3_RA : P1_RA, P2_RA, orie === 0 ? P1_RA : P3_RA].map((ra) => polarAlignmentError(ra, deg(dec), time.location!.latitude, LST, arcmin(az), arcmin(al)))
						const result = threePointPolarAlignmentError(p1, p2, p3, time, false)

						expect(toArcmin(result.azimuthError)).toBeCloseTo(az, precision)
						expect(toArcmin(result.altitudeError)).toBeCloseTo(al, precision)
					}
				}
			}
		}
	})

	test('northern hemisphere with refraction', () => {
		time.location = northLocation

		for (let orie = 0; orie <= 1; orie++) {
			for (let az = -60; az <= 60; az += 10) {
				for (let al = -60; al <= 60; al += 10) {
					for (let dec = -40; dec <= 40; dec += 10) {
						const [p1, p2, p3] = [orie === 0 ? P3_RA : P1_RA, P2_RA, orie === 0 ? P1_RA : P3_RA].map((ra) => polarAlignmentError(ra, deg(dec), time.location!.latitude, LST, arcmin(az), arcmin(al)))
						const result = threePointPolarAlignmentError(p1, p2, p3, time, DEFAULT_REFRACTION_PARAMETERS)

						expect(toArcmin(result.azimuthError)).toBeCloseTo(az, precision)
						expect(toArcmin(result.altitudeError)).toBeCloseTo(al, precision)
					}
				}
			}
		}
	})

	test('southern hemisphere without refraction', () => {
		time.location = southLocation

		for (let orie = 0; orie <= 1; orie++) {
			for (let az = -60; az <= 60; az += 10) {
				for (let al = -60; al <= 60; al += 10) {
					for (let dec = -40; dec <= 40; dec += 10) {
						const [p1, p2, p3] = [orie === 0 ? P3_RA : P1_RA, P2_RA, orie === 0 ? P1_RA : P3_RA].map((ra) => polarAlignmentError(ra, deg(dec), time.location!.latitude, LST, arcmin(az), arcmin(al)))
						const result = threePointPolarAlignmentError(p1, p2, p3, time, false)

						expect(toArcmin(result.azimuthError)).toBeCloseTo(az, precision)
						expect(toArcmin(result.altitudeError)).toBeCloseTo(al, precision)
					}
				}
			}
		}
	})

	test('southern hemisphere with refraction', () => {
		time.location = southLocation

		for (let orie = 0; orie <= 1; orie++) {
			for (let az = -60; az <= 60; az += 10) {
				for (let al = -60; al <= 60; al += 10) {
					for (let dec = -40; dec <= 40; dec += 10) {
						const [p1, p2, p3] = [orie === 0 ? P3_RA : P1_RA, P2_RA, orie === 0 ? P1_RA : P3_RA].map((ra) => polarAlignmentError(ra, deg(dec), time.location!.latitude, LST, arcmin(az), arcmin(al)))
						const result = threePointPolarAlignmentError(p1, p2, p3, time, DEFAULT_REFRACTION_PARAMETERS)

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
	pa1.add(deg(20), deg(40), time)
	pa1.add(deg(60), deg(41), time)
	const error1 = pa1.add(deg(90), deg(42), time)

	const pa2 = new ThreePointPolarAlignment(false)
	pa2.add(deg(90), deg(42), time)
	pa2.add(deg(60), deg(41), time)
	const error2 = pa2.add(deg(20), deg(40), time)

	expect(error1).not.toBeFalse()
	expect(error2).not.toBeFalse()

	if (!error1 || !error2) return

	const totalError = Math.hypot(error1.altitudeError, error1.azimuthError)

	expect(toDeg(totalError)).not.toBeCloseTo(0, 12)
	expect(error1.altitudeError).toBeCloseTo(error2.altitudeError, 12)
	expect(error1.azimuthError).toBeCloseTo(error2.azimuthError, 12)
})

test('no declination error', () => {
	const time = timeYMDHMS(2000, 1, 1, 0, 0, 0)
	time.location = geodeticLocation(deg(7), deg(49), meter(250))

	const pa = new ThreePointPolarAlignment(false)
	pa.add(deg(20), deg(40), time)
	pa.add(deg(60), deg(40), time)
	const error = pa.add(deg(90), deg(40), time)

	expect(error).not.toBeFalse()

	if (!error) return

	const precision = -Math.log10(2 * 0.00006)

	expect(error.altitudeError).toBeCloseTo(0, precision)
	expect(error.azimuthError).toBeCloseTo(0, precision)
})

test('very different altitude points and true pole', () => {
	const time = timeYMDHMS(2000, 1, 1, 0, 0, 0)
	time.location = geodeticLocation(deg(0), deg(40), meter(250))

	const pa = new ThreePointPolarAlignment({ pressure: 1005, temperature: 7, relativeHumidity: 0.8, wl: 0.574 })
	// values calculated with Astropy and quaternion rotations
	pa.add(deg(186.4193401), deg(27.75369312), time)
	pa.add(deg(156.6798968), deg(27.40124463), time)
	const error = pa.add(deg(127.00972423), deg(27.34989335), time)

	expect(error).not.toBeFalse()

	if (!error) return

	const precision = -Math.log10(2 * 3)

	expect(toArcmin(error.altitudeError)).toBeCloseTo(60, precision)
	expect(toArcmin(error.azimuthError)).toBeCloseTo(60, precision)
})

test('very different altitude points and refracted pole', () => {
	const time = timeYMDHMS(2000, 1, 1, 0, 0, 0)
	time.location = geodeticLocation(deg(0), deg(40), meter(250))

	const pa = new ThreePointPolarAlignment(false)
	// values calculated with Astropy and quaternion rotations
	pa.add(deg(186.4193401), deg(27.75369312), time)
	pa.add(deg(156.6798968), deg(27.40124463), time)
	const error = pa.add(deg(127.00972423), deg(27.34989335), time)

	expect(error).not.toBeFalse()

	if (!error) return

	const precision = -Math.log10(2 * 0.041)

	expect(toDeg(error.altitudeError)).toBeCloseTo(1 - 69.3 / 3600, precision)
	expect(toDeg(error.azimuthError)).toBeCloseTo(1, precision)
})

test('change orientation', () => {
	const location = geodeticLocation(deg(-45.5), deg(-22.5), meter(900))
	const time = { day: 2461092, fraction: 0.578802280092129, scale: 1, location }

	const a = [1.418966489892447, -0.5613841311820498] as const
	const b = [1.4971924601152036, -0.5611006782686236] as const
	const c = [1.5767801876529501, -0.5608213650948436] as const

	const pa1 = threePointPolarAlignmentError(a, b, c, time, DEFAULT_REFRACTION_PARAMETERS, location)
	const pa2 = threePointPolarAlignmentError(c, b, a, time, DEFAULT_REFRACTION_PARAMETERS, location)

	expect(toArcmin(pa1.azimuthError)).toBe(toArcmin(pa2.azimuthError))
	expect(toArcmin(pa1.altitudeError)).toBe(toArcmin(pa2.altitudeError))
})

// https://github.com/KDE/kstars/blob/4d8d1eed3071090aeeaf9eb3980eb30242342c34/Tests/polaralign/test_polaralign.cpp#L673

test('after adjustment I', () => {
	const location = geodeticLocation(parseAngle('-122 10'), parseAngle('37 26 30'))

	const solution = [
		[137.15604, 65.20169, 2025, 5, 20, 5, 5, 29],
		[160.27582, 65.41191, 2025, 5, 20, 5, 5, 46],
		[184.14282, 65.60488, 2025, 5, 20, 5, 6, 3],
	] as const

	const input = [
		// RA ICRF, DEC ICRF, year, month, day, hour, minute, second
		[184.145, 65.603, 2025, 5, 20, 5, 7, 11],
		[184.145, 65.603, 2025, 5, 20, 5, 7, 17],
		[184.21, 65.486, 2025, 5, 20, 5, 7, 23],
		[184.21, 65.486, 2025, 5, 20, 5, 7, 30],
		[184.232, 65.442, 2025, 5, 20, 5, 7, 36],
		[184.231, 65.441, 2025, 5, 20, 5, 7, 42],
		[184.274, 65.353, 2025, 5, 20, 5, 7, 48],
		[184.279, 65.344, 2025, 5, 20, 5, 7, 54],
		[184.279, 65.344, 2025, 5, 20, 5, 8, 1],
		[184.273, 65.347, 2025, 5, 20, 5, 8, 7],
		[184.273, 65.346, 2025, 5, 20, 5, 8, 13],
		[184.257, 65.366, 2025, 5, 20, 5, 8, 19],
		[184.256, 65.367, 2025, 5, 20, 5, 8, 26],
		[184.252, 65.376, 2025, 5, 20, 5, 8, 32],
		[184.252, 65.376, 2025, 5, 20, 5, 8, 38],
		[184.252, 65.377, 2025, 5, 20, 5, 8, 44],
		[184.255, 65.378, 2025, 5, 20, 5, 8, 50],
		[184.252, 65.377, 2025, 5, 20, 5, 8, 57],
		[184.253, 65.377, 2025, 5, 20, 5, 9, 3],
		[184.263, 65.377, 2025, 5, 20, 5, 9, 9],
		[184.384, 65.394, 2025, 5, 20, 5, 9, 15],
		[184.542, 65.414, 2025, 5, 20, 5, 9, 21],
		[184.543, 65.414, 2025, 5, 20, 5, 9, 28],
		[184.586, 65.42, 2025, 5, 20, 5, 9, 34],
		[184.692, 65.434, 2025, 5, 20, 5, 9, 40],
		[184.692, 65.434, 2025, 5, 20, 5, 9, 46],
		[184.752, 65.442, 2025, 5, 20, 5, 9, 53],
		[184.753, 65.442, 2025, 5, 20, 5, 9, 59],
		[184.759, 65.444, 2025, 5, 20, 5, 10, 5],
		[184.766, 65.446, 2025, 5, 20, 5, 10, 11],
		[184.739, 65.5, 2025, 5, 20, 5, 10, 17],
		[184.74, 65.502, 2025, 5, 20, 5, 10, 24],
		[184.728, 65.509, 2025, 5, 20, 5, 10, 30],
		[184.736, 65.518, 2025, 5, 20, 5, 10, 36],
		[184.766, 65.466, 2025, 5, 20, 5, 10, 42],
		[184.772, 65.453, 2025, 5, 20, 5, 10, 48],
		[184.776, 65.447, 2025, 5, 20, 5, 10, 55],
		[184.779, 65.44, 2025, 5, 20, 5, 11, 1],
		[184.783, 65.434, 2025, 5, 20, 5, 11, 7],
		[184.783, 65.435, 2025, 5, 20, 5, 11, 13],
		[184.783, 65.434, 2025, 5, 20, 5, 11, 19],
		[184.784, 65.435, 2025, 5, 20, 5, 11, 26],
		[184.785, 65.434, 2025, 5, 20, 5, 11, 32],
		[184.785, 65.434, 2025, 5, 20, 5, 11, 38],
		[184.745, 65.427, 2025, 5, 20, 5, 11, 44],
		[184.745, 65.427, 2025, 5, 20, 5, 11, 51],
		[184.745, 65.427, 2025, 5, 20, 5, 11, 57],
		[184.77, 65.432, 2025, 5, 20, 5, 12, 3],
		[184.77, 65.432, 2025, 5, 20, 5, 12, 9],
		[184.794, 65.434, 2025, 5, 20, 5, 12, 15],
		[184.794, 65.434, 2025, 5, 20, 5, 12, 22],
		[184.767, 65.43, 2025, 5, 20, 5, 12, 28],
		[184.748, 65.427, 2025, 5, 20, 5, 12, 34],
		[184.758, 65.429, 2025, 5, 20, 5, 12, 40],
		[184.757, 65.429, 2025, 5, 20, 5, 12, 47],
		[184.757, 65.429, 2025, 5, 20, 5, 12, 53],
		[184.757, 65.429, 2025, 5, 20, 5, 12, 59],
		[184.757, 65.429, 2025, 5, 20, 5, 13, 5],
		[184.757, 65.429, 2025, 5, 20, 5, 13, 11],
		[184.757, 65.429, 2025, 5, 20, 5, 13, 18],
		[184.757, 65.429, 2025, 5, 20, 5, 13, 24],
		[184.757, 65.429, 2025, 5, 20, 5, 13, 30],
	] as const

	const output = [
		// az error (deg), alt error (deg), az adj, alt adj
		[-0.488333, -0.233333, -0.001667, 0.0],
		[-0.486667, -0.233333, -0.001667, 0.0],
		[-0.463333, -0.111667, -0.026667, -0.121667],
		[-0.463333, -0.111667, -0.026667, -0.12],
		[-0.458333, -0.066667, -0.031667, -0.165],
		[-0.456667, -0.066667, -0.035, -0.166667],
		[-0.445, 0.025, -0.046667, -0.256667],
		[-0.443333, 0.033333, -0.048333, -0.266667],
		[-0.443333, 0.033333, -0.046667, -0.266667],
		[-0.448333, 0.028333, -0.041667, -0.261667],
		[-0.446667, 0.03, -0.043333, -0.261667],
		[-0.455, 0.008333, -0.035, -0.241667],
		[-0.458333, 0.006667, -0.033333, -0.24],
		[-0.458333, -0.003333, -0.031667, -0.23],
		[-0.458333, -0.001667, -0.031667, -0.23],
		[-0.455, -0.003333, -0.035, -0.23],
		[-0.455, -0.003333, -0.036667, -0.23],
		[-0.458333, -0.003333, -0.033333, -0.228333],
		[-0.456667, -0.003333, -0.033333, -0.23],
		[-0.446667, -0.003333, -0.045, -0.23],
		[-0.336667, -0.006667, -0.155, -0.226667],
		[-0.191667, -0.01, -0.298333, -0.223333],
		[-0.191667, -0.01, -0.298333, -0.221667],
		[-0.153333, -0.01, -0.336667, -0.221667],
		[-0.053333, -0.015, -0.436667, -0.218333],
		[-0.055, -0.015, -0.436667, -0.218333],
		[-0.0, -0.016667, -0.49, -0.216667],
		[0.0, -0.016667, -0.49, -0.215],
		[0.003333, -0.016667, -0.495, -0.215],
		[0.013333, -0.018333, -0.503333, -0.215],
		[0.005, -0.073333, -0.495, -0.158333],
		[0.005, -0.075, -0.496667, -0.156667],
		[-0.005, -0.085, -0.486667, -0.148333],
		[0.008333, -0.091667, -0.498333, -0.141667],
		[0.018333, -0.038333, -0.51, -0.195],
		[0.02, -0.025, -0.511667, -0.208333],
		[0.021667, -0.018333, -0.511667, -0.215],
		[0.021667, -0.01, -0.511667, -0.221667],
		[0.026667, -0.005, -0.516667, -0.228333],
		[0.025, -0.005, -0.516667, -0.226667],
		[0.025, -0.003333, -0.516667, -0.228333],
		[0.026667, -0.005, -0.516667, -0.228333],
		[0.025, -0.005, -0.515, -0.228333],
		[0.028333, -0.005, -0.518333, -0.228333],
		[-0.01, -0.001667, -0.48, -0.23],
		[-0.01, -0.001667, -0.48, -0.23],
		[-0.011667, -0.001667, -0.478333, -0.23],
		[0.015, -0.003333, -0.505, -0.228333],
		[0.013333, -0.005, -0.505, -0.228333],
		[0.035, -0.003333, -0.526667, -0.23],
		[0.035, -0.005, -0.525, -0.228333],
		[0.008333, -0.003333, -0.5, -0.23],
		[-0.006667, -0.001667, -0.485, -0.23],
		[0.001667, -0.001667, -0.493333, -0.23],
		[0.0, -0.003333, -0.491667, -0.23],
		[-0.0, -0.001667, -0.49, -0.23],
		[-0.001667, -0.003333, -0.488333, -0.23],
		[0.001667, -0.003333, -0.491667, -0.23],
		[0.001667, -0.003333, -0.491667, -0.23],
		[0.001667, -0.003333, -0.491667, -0.23],
		[0.0, -0.003333, -0.49, -0.23],
		[0.003333, -0.003333, -0.493333, -0.23],
	] as const

	const pa = new ThreePointPolarAlignment(DEFAULT_REFRACTION_PARAMETERS)

	for (const step of solution) {
		const time = timeYMDHMS(step[2], step[3], step[4], step[5], step[6], step[7])
		time.location = location
		pa.add(deg(step[0]), deg(step[1]), time)
	}

	for (let i = 0; i < input.length; i++) {
		const step = input[i]

		const time = timeYMDHMS(step[2], step[3], step[4], step[5], step[6], step[7])
		time.location = location

		const result = pa.add(deg(step[0]), deg(step[1]), time)

		expect(result).not.toBeFalse()

		if (!result) continue

		const expectedAz = deg(output[i][0])
		const expectedAlt = deg(output[i][1])

		expect(Math.abs(toDeg(result.azimuthError - expectedAz) * 3600)).toBeLessThan(15)
		expect(Math.abs(toDeg(result.altitudeError - expectedAlt) * 3600)).toBeLessThan(45)
	}
})

// https://github.com/KDE/kstars/blob/4d8d1eed3071090aeeaf9eb3980eb30242342c34/Tests/polaralign/test_polaralign.cpp#L615

test('after adjustment II', () => {
	const location = geodeticLocation(parseAngle('-122 10'), parseAngle('37 26 30'))

	const solution = [
		[211.174, 60.8994, 2022, 5, 30, 5, 11, 11],
		[233.324, 60.632, 2022, 5, 30, 5, 11, 34],
		[254.451, 60.3434, 2022, 5, 30, 5, 11, 57],
	] as const

	const input = [
		// RA ICRF, DEC ICRF, year, month, day, hour, minute, second
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

	const outputRefracted = [
		// az error (deg), alt error (deg), az adj, alt adj
		[0.630769, -0.455568, 0.0, -0.001389],
		[0.640625, 0.001814, -0.006021, -0.458798],
		[0.643341, -0.001003, -0.00876, -0.455982],
		[0.38739, 0.002737, 0.247222, -0.459722],
		[0.391545, 0.001349, 0.243056, -0.458333],
		[0.236025, 0.005515, 0.398611, -0.4625],
		[0.015507, 0.007205, 0.619144, -0.46419],
	] as const

	const outputNoRefraction = [
		// az error (deg), alt error (deg), az adj, alt adj
		[0.629487, -0.46887, 0.0, -0.001389],
		[0.638555, -0.010883, -0.005237, -0.459403],
		[0.64266, -0.013699, -0.009365, -0.456587],
		[0.384722, -0.009175, 0.248611, -0.461111],
		[0.390254, -0.011953, 0.243056, -0.458333],
		[0.234734, -0.007787, 0.398611, -0.4625],
		[0.0136, -0.00533, 0.619766, -0.464956],
	] as const

	const outputs = [outputNoRefraction, outputRefracted]

	for (const output of outputs) {
		const pa = new ThreePointPolarAlignment(output === outputNoRefraction ? false : DEFAULT_REFRACTION_PARAMETERS)

		for (const step of solution) {
			const time = timeYMDHMS(step[2], step[3], step[4], step[5], step[6], step[7])
			time.location = location
			pa.add(deg(step[0]), deg(step[1]), time)
		}

		for (let i = 0; i < input.length; i++) {
			const step = input[i]

			const time = timeYMDHMS(step[2], step[3], step[4], step[5], step[6], step[7])
			time.location = location

			const result = pa.add(deg(step[0]), deg(step[1]), time)

			expect(result).not.toBeFalse()

			if (!result) continue

			const expectedAz = deg(output[i][0])
			const expectedAlt = deg(output[i][1])

			expect(Math.abs(toArcsec(result.azimuthError - expectedAz))).toBeLessThan(35)
			expect(Math.abs(toArcsec(result.altitudeError - expectedAlt))).toBeLessThan(35)
		}
	}
})

// https://github.com/KDE/kstars/blob/4d8d1eed3071090aeeaf9eb3980eb30242342c34/Tests/polaralign/test_polaralign.cpp#L818

test('after adjustment III', () => {
	const location = geodeticLocation(parseAngle('-122 1 59'), parseAngle('37 22 36'))

	const solution = [
		[46.42805, 88.04574, 2025, 9, 10, 4, 41, 56],
		[359.67454, 87.4738, 2025, 9, 10, 4, 42, 8],
		[323.05585, 86.88579, 2025, 9, 10, 4, 42, 20],
	] as const

	const input = [
		// RA ICRF, DEC ICRF, year, month, day, hour, minute, second
		[323.044, 86.886, 2025, 9, 10, 4, 42, 33],
		[323.042, 86.886, 2025, 9, 10, 4, 42, 35],
		[323.043, 86.886, 2025, 9, 10, 4, 42, 36],
		[323.046, 86.886, 2025, 9, 10, 4, 42, 38],
		[323.04, 86.886, 2025, 9, 10, 4, 42, 39],
		[323.041, 86.886, 2025, 9, 10, 4, 42, 41],
		[323.047, 86.886, 2025, 9, 10, 4, 42, 42],
		[323.044, 86.885, 2025, 9, 10, 4, 42, 44],
		[323.045, 86.886, 2025, 9, 10, 4, 42, 45],
		[323.045, 86.886, 2025, 9, 10, 4, 42, 47],
		[323.048, 86.885, 2025, 9, 10, 4, 42, 49],
		[323.048, 86.886, 2025, 9, 10, 4, 42, 50],
		[323.047, 86.885, 2025, 9, 10, 4, 42, 52],
		[323.043, 86.886, 2025, 9, 10, 4, 42, 53],
		[323.045, 86.885, 2025, 9, 10, 4, 42, 55],
		[323.042, 86.885, 2025, 9, 10, 4, 42, 56],
		[323.045, 86.885, 2025, 9, 10, 4, 42, 58],
		[323.046, 86.885, 2025, 9, 10, 4, 42, 59],
		[323.042, 86.885, 2025, 9, 10, 4, 43, 1],
		[323.045, 86.885, 2025, 9, 10, 4, 43, 2],
		[323.049, 86.885, 2025, 9, 10, 4, 43, 4],
		[323.045, 86.885, 2025, 9, 10, 4, 43, 5],
		[323.051, 86.885, 2025, 9, 10, 4, 43, 7],
		[323.05, 86.885, 2025, 9, 10, 4, 43, 8],
		[323.051, 86.885, 2025, 9, 10, 4, 43, 10],
		[323.05, 86.885, 2025, 9, 10, 4, 43, 11],
		[323.044, 86.884, 2025, 9, 10, 4, 43, 13],
		[323.068, 86.885, 2025, 9, 10, 4, 43, 14],
		[324.322, 86.85, 2025, 9, 10, 4, 43, 17],
		[325.264, 86.823, 2025, 9, 10, 4, 43, 19],
		[325.728, 86.808, 2025, 9, 10, 4, 43, 24],
		[326.817, 86.772, 2025, 9, 10, 4, 43, 28],
		[326.829, 86.772, 2025, 9, 10, 4, 43, 30],
		[328.166, 86.726, 2025, 9, 10, 4, 43, 32],
		[328.167, 86.726, 2025, 9, 10, 4, 43, 33],
		[328.889, 86.699, 2025, 9, 10, 4, 43, 35],
		[328.89, 86.699, 2025, 9, 10, 4, 43, 36],
		[328.898, 86.698, 2025, 9, 10, 4, 43, 38],
		[329.344, 86.682, 2025, 9, 10, 4, 43, 40],
		[329.371, 86.681, 2025, 9, 10, 4, 43, 41],
		[329.825, 86.664, 2025, 9, 10, 4, 43, 44],
		[329.831, 86.664, 2025, 9, 10, 4, 43, 46],
		[329.837, 86.664, 2025, 9, 10, 4, 43, 47],
		[329.847, 86.66, 2025, 9, 10, 4, 43, 49],
		[329.454, 86.699, 2025, 9, 10, 4, 43, 51],
		[329.457, 86.7, 2025, 9, 10, 4, 43, 52],
		[329.454, 86.7, 2025, 9, 10, 4, 43, 54],
		[330.282, 86.668, 2025, 9, 10, 4, 43, 59],
		[330.29, 86.668, 2025, 9, 10, 4, 44, 0],
		[330.719, 86.651, 2025, 9, 10, 4, 44, 2],
		[330.721, 86.651, 2025, 9, 10, 4, 44, 3],
		[330.985, 86.64, 2025, 9, 10, 4, 44, 5],
		[330.976, 86.639, 2025, 9, 10, 4, 44, 6],
		[331.25, 86.606, 2025, 9, 10, 4, 44, 8],
		[331.254, 86.606, 2025, 9, 10, 4, 44, 9],
		[331.258, 86.607, 2025, 9, 10, 4, 44, 11],
		[331.365, 86.603, 2025, 9, 10, 4, 44, 13],
		[331.365, 86.602, 2025, 9, 10, 4, 44, 14],
		[331.369, 86.603, 2025, 9, 10, 4, 44, 16],
		[331.334, 86.605, 2025, 9, 10, 4, 44, 18],
		[331.135, 86.614, 2025, 9, 10, 4, 44, 20],
		[331.136, 86.614, 2025, 9, 10, 4, 44, 23],
		[331.136, 86.615, 2025, 9, 10, 4, 44, 25],
		[331.052, 86.618, 2025, 9, 10, 4, 44, 27],
		[331.037, 86.618, 2025, 9, 10, 4, 44, 29],
		[331.039, 86.618, 2025, 9, 10, 4, 44, 31],
		[331.039, 86.618, 2025, 9, 10, 4, 44, 32],
		[331.054, 86.618, 2025, 9, 10, 4, 44, 34],
		[331.146, 86.615, 2025, 9, 10, 4, 44, 36],
		[331.231, 86.609, 2025, 9, 10, 4, 44, 38],
		[331.667, 86.621, 2025, 9, 10, 4, 44, 40],
		[331.952, 86.679, 2025, 9, 10, 4, 44, 45],
		[331.946, 86.679, 2025, 9, 10, 4, 44, 46],
		[331.962, 86.68, 2025, 9, 10, 4, 44, 48],
		[333.351, 86.806, 2025, 9, 10, 4, 44, 49],
		[333.379, 86.808, 2025, 9, 10, 4, 44, 52],
		[335.707, 86.981, 2025, 9, 10, 4, 44, 58],
		[335.723, 86.981, 2025, 9, 10, 4, 45, 0],
		[336.691, 87.044, 2025, 9, 10, 4, 45, 2],
		[336.702, 87.045, 2025, 9, 10, 4, 45, 3],
		[337.433, 87.09, 2025, 9, 10, 4, 45, 5],
		[337.438, 87.09, 2025, 9, 10, 4, 45, 6],
		[338.117, 87.13, 2025, 9, 10, 4, 45, 9],
		[338.933, 87.175, 2025, 9, 10, 4, 45, 14],
		[338.937, 87.176, 2025, 9, 10, 4, 45, 17],
		[339.814, 87.222, 2025, 9, 10, 4, 45, 20],
		[339.826, 87.222, 2025, 9, 10, 4, 45, 22],
		[339.549, 87.207, 2025, 9, 10, 4, 45, 25],
		[339.549, 87.207, 2025, 9, 10, 4, 45, 28],
		[339.541, 87.207, 2025, 9, 10, 4, 45, 30],
		[339.825, 87.198, 2025, 9, 10, 4, 45, 32],
		[339.766, 87.197, 2025, 9, 10, 4, 45, 35],
		[339.801, 87.191, 2025, 9, 10, 4, 45, 37],
		[339.648, 87.19, 2025, 9, 10, 4, 45, 40],
		[339.621, 87.191, 2025, 9, 10, 4, 45, 43],
		[339.613, 87.193, 2025, 9, 10, 4, 45, 48],
		[339.619, 87.193, 2025, 9, 10, 4, 45, 50],
		[339.619, 87.193, 2025, 9, 10, 4, 45, 52],
		[339.628, 87.193, 2025, 9, 10, 4, 45, 58],
		[339.616, 87.192, 2025, 9, 10, 4, 46, 1],
		[339.613, 87.193, 2025, 9, 10, 4, 46, 4],
		[339.63, 87.193, 2025, 9, 10, 4, 46, 6],
		[339.63, 87.192, 2025, 9, 10, 4, 46, 12],
		[339.62, 87.192, 2025, 9, 10, 4, 46, 14],
	] as const

	const output = [
		// az error (deg), alt error (deg), az adj, alt adj
		[-40.7 / 60, 44.6 / 60, 0.1 / 60, 0.0 / 60],
		[-40.7 / 60, 44.6 / 60, 0.1 / 60, 0.0 / 60],
		[-40.8 / 60, 44.5 / 60, 0.1 / 60, 0.0 / 60],
		[-40.7 / 60, 44.6 / 60, 0.1 / 60, 0.0 / 60],
		[-40.8 / 60, 44.6 / 60, 0.1 / 60, 0.0 / 60],
		[-40.8 / 60, 44.6 / 60, 0.2 / 60, 0.0 / 60],
		[-40.7 / 60, 44.6 / 60, 0.1 / 60, 0.0 / 60],
		[-40.8 / 60, 44.6 / 60, 0.1 / 60, 0.0 / 60],
		[-40.8 / 60, 44.6 / 60, 0.2 / 60, 0.0 / 60],
		[-40.8 / 60, 44.6 / 60, 0.2 / 60, 0.0 / 60],
		[-40.8 / 60, 44.6 / 60, 0.1 / 60, 0.0 / 60],
		[-40.8 / 60, 44.5 / 60, 0.2 / 60, 0.0 / 60],
		[-40.8 / 60, 44.6 / 60, 0.2 / 60, 0.0 / 60],
		[-40.8 / 60, 44.5 / 60, 0.2 / 60, 0.0 / 60],
		[-40.8 / 60, 44.6 / 60, 0.2 / 60, 0.0 / 60],
		[-40.8 / 60, 44.5 / 60, 0.2 / 60, 0.0 / 60],
		[-40.8 / 60, 44.6 / 60, 0.2 / 60, 0.0 / 60],
		[-40.8 / 60, 44.5 / 60, 0.2 / 60, 0.0 / 60],
		[-40.8 / 60, 44.6 / 60, 0.2 / 60, 0.0 / 60],
		[-40.8 / 60, 44.5 / 60, 0.2 / 60, 0.0 / 60],
		[-40.8 / 60, 44.5 / 60, 0.2 / 60, 0.1 / 60],
		[-40.8 / 60, 44.5 / 60, 0.2 / 60, 0.0 / 60],
		[-40.8 / 60, 44.5 / 60, 0.2 / 60, 0.0 / 60],
		[-40.8 / 60, 44.5 / 60, 0.2 / 60, 0.0 / 60],
		[-40.8 / 60, 44.5 / 60, 0.2 / 60, 0.1 / 60],
		[-40.8 / 60, 44.5 / 60, 0.2 / 60, 0.1 / 60],
		[-40.8 / 60, 44.6 / 60, 0.2 / 60, 0.0 / 60],
		[-40.8 / 60, 44.5 / 60, 0.1 / 60, 0.1 / 60],
		[-34.7 / 60, 44.5 / 60, -5.9 / 60, 0.1 / 60],
		[-30.2 / 60, 44.5 / 60, -10.5 / 60, 0.1 / 60],
		[-27.8 / 60, 44.5 / 60, -12.8 / 60, 0.1 / 60],
		[-22.3 / 60, 44.6 / 60, -18.3 / 60, -0.0 / 60],
		[-22.3 / 60, 44.6 / 60, -18.3 / 60, 0.0 / 60],
		[-15.3 / 60, 44.6 / 60, -25.3 / 60, -0.0 / 60],
		[-15.3 / 60, 44.6 / 60, -25.3 / 60, -0.0 / 60],
		[-11.4 / 60, 44.7 / 60, -29.2 / 60, -0.1 / 60],
		[-11.5 / 60, 44.7 / 60, -29.1 / 60, -0.1 / 60],
		[-11.4 / 60, 44.7 / 60, -29.2 / 60, -0.1 / 60],
		[-9.0 / 60, 44.7 / 60, -31.6 / 60, -0.1 / 60],
		[-8.9 / 60, 44.7 / 60, -31.7 / 60, -0.1 / 60],
		[-6.4 / 60, 44.7 / 60, -34.2 / 60, -0.1 / 60],
		[-6.4 / 60, 44.7 / 60, -34.2 / 60, -0.1 / 60],
		[-6.4 / 60, 44.7 / 60, -34.2 / 60, -0.1 / 60],
		[-6.2 / 60, 44.8 / 60, -34.4 / 60, -0.2 / 60],
		[-9.3 / 60, 43.6 / 60, -31.3 / 60, 1.0 / 60],
		[-9.4 / 60, 43.6 / 60, -31.2 / 60, 1.0 / 60],
		[-9.4 / 60, 43.6 / 60, -31.2 / 60, 1.0 / 60],
		[-4.9 / 60, 43.6 / 60, -35.7 / 60, 1.0 / 60],
		[-4.9 / 60, 43.6 / 60, -35.7 / 60, 1.0 / 60],
		[-2.5 / 60, 43.6 / 60, -38.1 / 60, 1.0 / 60],
		[-2.5 / 60, 43.6 / 60, -38.1 / 60, 1.0 / 60],
		[-1.0 / 60, 43.6 / 60, -39.6 / 60, 1.0 / 60],
		[-1.0 / 60, 43.7 / 60, -39.6 / 60, 0.9 / 60],
		[1.4 / 60, 44.8 / 60, -42.1 / 60, -0.2 / 60],
		[1.4 / 60, 44.8 / 60, -42.1 / 60, -0.2 / 60],
		[1.4 / 60, 44.7 / 60, -42.0 / 60, -0.1 / 60],
		[2.0 / 60, 44.7 / 60, -42.6 / 60, -0.1 / 60],
		[2.0 / 60, 44.7 / 60, -42.6 / 60, -0.1 / 60],
		[2.0 / 60, 44.7 / 60, -42.7 / 60, -0.1 / 60],
		[1.8 / 60, 44.7 / 60, -42.4 / 60, -0.1 / 60],
		[0.6 / 60, 44.6 / 60, -41.2 / 60, -0.0 / 60],
		[0.6 / 60, 44.6 / 60, -41.2 / 60, -0.0 / 60],
		[0.6 / 60, 44.6 / 60, -41.2 / 60, 0.0 / 60],
		[0.1 / 60, 44.6 / 60, -40.7 / 60, 0.0 / 60],
		[0.0 / 60, 44.6 / 60, -40.6 / 60, -0.0 / 60],
		[0.0 / 60, 44.6 / 60, -40.6 / 60, -0.0 / 60],
		[0.0 / 60, 44.6 / 60, -40.6 / 60, -0.0 / 60],
		[0.0 / 60, 44.6 / 60, -40.7 / 60, 0.0 / 60],
		[0.5 / 60, 44.6 / 60, -41.2 / 60, 0.0 / 60],
		[1.1 / 60, 44.7 / 60, -41.7 / 60, -0.1 / 60],
		[2.3 / 60, 43.2 / 60, -42.9 / 60, 1.4 / 60],
		[0.8 / 60, 39.8 / 60, -41.4 / 60, 4.8 / 60],
		[0.8 / 60, 39.8 / 60, -41.4 / 60, 4.8 / 60],
		[0.8 / 60, 39.7 / 60, -41.4 / 60, 4.9 / 60],
		[0.4 / 60, 30.8 / 60, -40.9 / 60, 13.8 / 60],
		[0.4 / 60, 30.7 / 60, -40.9 / 60, 13.9 / 60],
		[0.3 / 60, 17.7 / 60, -40.7 / 60, 26.8 / 60],
		[0.4 / 60, 17.7 / 60, -40.7 / 60, 26.9 / 60],
		[0.5 / 60, 12.8 / 60, -40.8 / 60, 31.8 / 60],
		[0.5 / 60, 12.8 / 60, -40.8 / 60, 31.8 / 60],
		[0.5 / 60, 9.2 / 60, -40.8 / 60, 35.3 / 60],
		[0.5 / 60, 9.2 / 60, -40.8 / 60, 35.4 / 60],
		[0.6 / 60, 6.0 / 60, -40.9 / 60, 38.6 / 60],
		[0.8 / 60, 2.4 / 60, -41.0 / 60, 42.2 / 60],
		[0.8 / 60, 2.3 / 60, -41.0 / 60, 42.3 / 60],
		[0.015443, -0.02496, -0.685451, 0.768001],
		[0.016016, -0.025357, -0.68602, 0.768398],
		[0.9 / 60, -0.3 / 60, -41.1 / 60, 44.9 / 60],
		[0.9 / 60, -0.3 / 60, -41.1 / 60, 44.9 / 60],
		[0.9 / 60, -0.3 / 60, -41.1 / 60, 44.9 / 60],
		[0.036518, -0.007494, -0.706682, 0.750534],
		[2.1 / 60, -0.3 / 60, -42.3 / 60, 44.9 / 60],
		[2.4 / 60, -0.1 / 60, -42.7 / 60, 44.7 / 60],
		[2.1 / 60, 0.3 / 60, -42.3 / 60, 44.3 / 60],
		[2.0 / 60, 0.3 / 60, -42.2 / 60, 44.3 / 60],
		[1.8 / 60, 0.2 / 60, -42.0 / 60, 44.4 / 60],
		[1.9 / 60, 0.2 / 60, -42.1 / 60, 44.4 / 60],
		[1.8 / 60, 0.2 / 60, -42.1 / 60, 44.4 / 60],
		[1.9 / 60, 0.2 / 60, -42.1 / 60, 44.4 / 60],
		[1.9 / 60, 0.2 / 60, -42.1 / 60, 44.3 / 60],
		[1.8 / 60, 0.2 / 60, -42.0 / 60, 44.4 / 60],
		[1.9 / 60, 0.2 / 60, -42.1 / 60, 44.4 / 60],
		[1.9 / 60, 0.2 / 60, -42.1 / 60, 44.4 / 60],
		[1.9 / 60, 0.2 / 60, -42.1 / 60, 44.4 / 60],
	] as const

	const pa = new ThreePointPolarAlignment(DEFAULT_REFRACTION_PARAMETERS)

	for (const step of solution) {
		const time = timeYMDHMS(step[2], step[3], step[4], step[5], step[6], step[7])
		time.location = location
		pa.add(deg(step[0]), deg(step[1]), time)
	}

	for (let i = 0; i < input.length; i++) {
		const step = input[i]

		const time = timeYMDHMS(step[2], step[3], step[4], step[5], step[6], step[7])
		time.location = location

		const result = pa.add(deg(step[0]), deg(step[1]), time)

		expect(result).not.toBeFalse()

		if (!result) continue

		const expectedAz = deg(output[i][0])
		const expectedAlt = deg(output[i][1])

		expect(Math.abs(toArcsec(result.azimuthError - expectedAz))).toBeLessThan(40)
		expect(Math.abs(toArcsec(result.altitudeError - expectedAlt))).toBeLessThan(70)
	}
})
