import { expect, test } from 'bun:test'
import { arcmin, deg, dms, hour, toArcmin, toDeg } from '../src/angle'
import { equatorialFromJ2000 } from '../src/coordinate'
import { meter } from '../src/distance'
import { geodeticLocation, localSiderealTime } from '../src/location'
import { polarAlignmentError, ThreePointPolarAlignment, type ThreePointPolarAlignmentResult, threePointPolarAlignmentError } from '../src/polaralignment'
import { timeYMDHMS } from '../src/time'

const TIME = timeYMDHMS(2025, 9, 7, 12, 0, 0)
const NORTH_LOCATION = geodeticLocation(deg(-45), deg(22), meter(800))
const SOUTH_LOCATION = geodeticLocation(deg(-45), deg(-22), meter(800))
TIME.location = NORTH_LOCATION
const LST = localSiderealTime(TIME, undefined, true) // mean sidereal time

const P1_RA = hour(9)
const P2_RA = hour(8)
const P3_RA = hour(7)

test('northern hemisphere azimuth/altitude error', () => {
	TIME.location = NORTH_LOCATION
	const precision = -Math.log10(2 * 4) // -log(2 * precision)

	for (let p = 0; p <= 1; p++) {
		for (let a = -60; a <= 60; a += 10) {
			for (let e = -60; e <= 60; e += 10) {
				for (let d = -40; d <= 40; d += 10) {
					const [p1, p2, p3] = [p === 0 ? P3_RA : P1_RA, P2_RA, p === 0 ? P1_RA : P3_RA].map((ra) => [...polarAlignmentError(ra, deg(d), TIME.location!.latitude, LST, arcmin(a), arcmin(e)), TIME] as const)
					const result = threePointPolarAlignmentError(p1, p2, p3, false)

					expect(toArcmin(result.azimuthError)).toBeCloseTo(a, precision)
					expect(toArcmin(result.altitudeError)).toBeCloseTo(e, precision)
				}
			}
		}
	}
})

test('southern hemisphere azimuth/altitude error', () => {
	TIME.location = SOUTH_LOCATION
	const precision = -Math.log10(2 * 4) // -log(2 * precision)

	for (let p = 0; p <= 1; p++) {
		for (let a = -60; a <= 60; a += 10) {
			for (let e = -60; e <= 60; e += 10) {
				for (let d = -40; d <= 40; d += 10) {
					const [p1, p2, p3] = [p === 0 ? P3_RA : P1_RA, P2_RA, p === 0 ? P1_RA : P3_RA].map((ra) => [...polarAlignmentError(ra, deg(d), TIME.location!.latitude, LST, arcmin(a), arcmin(e)), TIME] as const)
					const result = threePointPolarAlignmentError(p1, p2, p3, false)

					expect(toArcmin(result.azimuthError)).toBeCloseTo(a, precision)
					expect(toArcmin(result.altitudeError)).toBeCloseTo(e, precision)
				}
			}
		}
	}
})

test('auto polar alignment', () => {
	const inputs = [
		// ra | dec | minute | second
		[137.15604, 65.20169, 5, 29],
		[160.27582, 65.41191, 5, 46],
		[184.14282, 65.60488, 6, 3],
		[184.145, 65.603, 7, 11],
		[184.145, 65.603, 7, 17],
		[184.21, 65.486, 7, 23],
		[184.21, 65.486, 7, 30],
		[184.232, 65.442, 7, 36],
		[184.231, 65.441, 7, 42],
		[184.274, 65.353, 7, 48],
		[184.279, 65.344, 7, 54],
		[184.279, 65.344, 8, 1],
		[184.273, 65.347, 8, 7],
		[184.273, 65.346, 8, 13],
		[184.257, 65.366, 8, 19],
		[184.256, 65.367, 8, 26],
		[184.252, 65.376, 8, 32],
		[184.252, 65.376, 8, 38],
		[184.252, 65.377, 8, 44],
		[184.255, 65.378, 8, 50],
		[184.252, 65.377, 8, 57],
		[184.253, 65.377, 9, 3],
		[184.263, 65.377, 9, 9],
		[184.384, 65.394, 9, 15],
		[184.542, 65.414, 9, 21],
		[184.543, 65.414, 9, 28],
		[184.586, 65.42, 9, 34],
		[184.692, 65.434, 9, 40],
		[184.692, 65.434, 9, 46],
		[184.752, 65.442, 9, 53],
		[184.753, 65.442, 9, 59],
		[184.759, 65.444, 10, 5],
		[184.766, 65.446, 10, 11],
		[184.739, 65.5, 10, 17],
		[184.74, 65.502, 10, 24],
		[184.728, 65.509, 10, 30],
		[184.736, 65.518, 10, 36],
		[184.766, 65.466, 10, 42],
		[184.772, 65.453, 10, 48],
		[184.776, 65.447, 10, 55],
		[184.779, 65.44, 11, 1],
		[184.783, 65.434, 11, 7],
		[184.783, 65.435, 11, 13],
		[184.783, 65.434, 11, 19],
		[184.784, 65.435, 11, 26],
		[184.785, 65.434, 11, 32],
		[184.785, 65.434, 11, 38],
		[184.745, 65.427, 11, 44],
		[184.745, 65.427, 11, 51],
		[184.745, 65.427, 11, 57],
		[184.77, 65.432, 12, 3],
		[184.77, 65.432, 12, 9],
		[184.794, 65.434, 12, 15],
		[184.794, 65.434, 12, 22],
		[184.767, 65.43, 12, 28],
		[184.748, 65.427, 12, 34],
		[184.758, 65.429, 12, 40],
		[184.757, 65.429, 12, 47],
		[184.757, 65.429, 12, 53],
		[184.757, 65.429, 12, 59],
		[184.757, 65.429, 13, 5],
		[184.757, 65.429, 13, 11],
		[184.757, 65.429, 13, 18],
		[184.757, 65.429, 13, 24],
		[184.757, 65.429, 13, 30],
	] as const

	const outputs = [
		// az error | alt error | az adjustment | alt adjustment
		[-0.488333, -0.233333, -0.001667, 0],
		[-0.486667, -0.233333, -0.001667, 0],
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
		[-0, -0.016667, -0.49, -0.216667],
		[0, -0.016667, -0.49, -0.215],
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
		[0, -0.003333, -0.491667, -0.23],
		[-0, -0.001667, -0.49, -0.23],
		[-0.001667, -0.003333, -0.488333, -0.23],
		[0.001667, -0.003333, -0.491667, -0.23],
		[0.001667, -0.003333, -0.491667, -0.23],
		[0.001667, -0.003333, -0.491667, -0.23],
		[0, -0.003333, -0.49, -0.23],
		[0.003333, -0.003333, -0.493333, -0.23],
	] as const

	const location = geodeticLocation(dms(-122, 10), dms(37, 26, 30), 0)

	function makePointAndTime(input: (typeof inputs)[number]) {
		const [rightAscensionJ2000, declinationJ2000, minute, second] = input
		const time = timeYMDHMS(2025, 5, 20, 5, minute, second)
		time.location = location
		const point = equatorialFromJ2000(deg(rightAscensionJ2000), deg(declinationJ2000), time)
		return [...point, time] as const
	}

	const pa = new ThreePointPolarAlignment()

	let error: ThreePointPolarAlignmentResult | false = false

	for (let i = 0; i < 3; i++) {
		const point = makePointAndTime(inputs[i])
		error = pa.add(...point)
	}

	expect(error).not.toBeFalse()

	for (let i = 3; i < inputs.length; i++) {
		const point = makePointAndTime(inputs[i])
		error = pa.add(...point)
		expect(error).not.toBeFalse()

		if (error) {
			const output = outputs[i - 3]
			expect(toDeg(error.azimuthError)).toBeCloseTo(output[0], 1)
			expect(toDeg(error.altitudeError)).toBeCloseTo(output[1], 1)

			// NOTE: Why azimuthAdjustment sign is inverted?
			// console.info(toDeg(error.altitudeAdjustment), toDeg(error.azimuthAdjustment))
		}
	}
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

	const totalError = Math.sqrt(error1.altitudeError ** 2 + error1.azimuthError ** 2)

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

	expect(error.altitudeError).toBeCloseTo(0, 3)
	expect(error.azimuthError).toBeCloseTo(0, 3)
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

	expect(toDeg(error.altitudeError)).toBeCloseTo(1, 1)
	expect(toDeg(error.azimuthError)).toBeCloseTo(1, 1)
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

	expect(toDeg(error.altitudeError)).toBeCloseTo(1 - 69.3 / 3600, 1)
	expect(toDeg(error.azimuthError)).toBeCloseTo(1, 1)
})
