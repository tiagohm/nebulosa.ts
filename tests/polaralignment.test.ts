import { describe, expect, test } from 'bun:test'
import { arcmin, deg, hour, toArcmin, toDeg } from '../src/angle'
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
	const LST = localSiderealTime(time, undefined, true) // mean sidereal time

	const P1_RA = LST - hour(1)
	const P2_RA = LST
	const P3_RA = LST + hour(1)

	const precision = -Math.log10(2 * 3.5) // -log(2 * precision)

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

	const precision = -Math.log10(2 * 0.0003)

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

test('after adjustment', () => {
	const location = geodeticLocation(deg(-45.5), deg(-22.5), meter(900))
	const pa = new ThreePointPolarAlignment(DEFAULT_REFRACTION_PARAMETERS)

	const data = [
		[1.8256976480896927, -0.5599113045784648, 2461092, 0.5822071759264779],
		[1.612136209787311, -0.5607337617175503, 2461092, 0.5823885416653422],
		[1.4034595005569215, -0.5615333930198793, 2461092, 0.5825668287028869],
		[1.4034590516660916, -0.5615378647033467, 2461092, 0.5827182060176576],
		[1.4034570523947498, -0.5615721924619829, 2461092, 0.5828698726853838],
		[1.4029846936604762, -0.5621320411744465, 2461092, 0.5831333333336645],
		[1.402992508403618, -0.5621143905705348, 2461092, 0.5832858564815036],
		[1.4041061452046575, -0.56091971604369, 2461092, 0.5835510879617046],
		[1.4045334284745254, -0.560447048940281, 2461092, 0.5837032523144174],
		[1.404576661659431, -0.5602763229197412, 2461092, 0.5838589004620358],
		[1.4045800236890893, -0.5601844274383506, 2461092, 0.5840089814806426],
		[1.4045810266132221, -0.5601419731511296, 2461092, 0.5841615393509467],
		[1.4045855331524857, -0.5599739421294415, 2461092, 0.5843143634249767],
		[1.4046125976110404, -0.5594769737792072, 2461092, 0.5844648379639343],
	] as const

	for (const step of data) {
		const result = pa.add(step[0], step[1], { day: step[2], fraction: step[3], scale: 1, location }, true)
		result && console.info(toArcmin(result.azimuthError), toArcmin(result.altitudeError))
	}
})

describe('Sky Simulator', () => {
	const location = geodeticLocation(deg(-45.5), deg(-22.5), meter(900))

	test('without error', () => {
		const pa = new ThreePointPolarAlignment(false)

		const data = [
			[1.6701784921280316, 0.0002591904646892741, 2461092, 1.3678486458322516],
			[1.774898254327445, 0.0005220205480995465, 2461092, 1.3680159374988743],
			[1.8796171960625867, 0.0007790743317534916, 2461092, 1.3681737037030635],
			[1.8796171602798464, 0.0007790259089444543, 2461092, 1.3683120833337306],
		] as const

		for (const step of data) {
			const result = pa.add(step[0], step[1], { day: step[2], fraction: step[3], scale: 1, location }, true)

			if (result) {
				expect(toArcmin(result.azimuthError)).toBeCloseTo(0, 0)
				expect(toArcmin(result.altitudeError)).toBeCloseTo(0, 0)
			}
		}
	})

	test('with error', () => {
		const pa = new ThreePointPolarAlignment(false)

		const data = [
			[1.8812872235744413, 0.0007338374862794161, 2461092, 1.3725453124995584],
			[1.776566292029562, 0.0011117842708233908, 2461092, 1.372702870371717],
			[1.6718452273212965, 0.0014700676429002613, 2461092, 1.3728476620382732],
			[1.671845221477934, 0.0014699660717346456, 2461092, 1.3729754282396147],
		] as const

		for (const step of data) {
			const result = pa.add(step[0], step[1], { day: step[2], fraction: step[3], scale: 1, location }, true)

			if (result) {
				expect(toArcmin(result.azimuthError)).toBeCloseTo(13.9, 0)
				expect(toArcmin(result.altitudeError)).toBeCloseTo(-17, 0)
			}
		}
	})
})
