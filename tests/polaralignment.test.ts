import { describe, expect, test } from 'bun:test'
import { arcmin, deg, formatALT, formatDEC, formatRA, hour, toArcmin, toDeg } from '../src/angle'
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

	expect(toDeg(totalError)).not.toBeCloseTo(0, 8)
	expect(error1.altitudeError).toBeCloseTo(error2.altitudeError, 8)
	expect(error1.azimuthError).toBeCloseTo(error2.azimuthError, 8)
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

	const precision = -Math.log10(2 * 0.00025)

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

	const precision = -Math.log10(2 * 0.045)

	expect(toDeg(error.altitudeError)).toBeCloseTo(1, precision)
	expect(toDeg(error.azimuthError)).toBeCloseTo(1, precision)
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
		const result = pa.add(step[0], step[1], { day: step[2], fraction: step[3], scale: 1, location })
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
			const result = pa.add(step[0], step[1], { day: step[2], fraction: step[3], scale: 1, location })

			if (result) {
				console.info(formatRA(step[0]), formatDEC(step[1]), formatALT(result.azimuthError), formatALT(result.altitudeError))
			} else {
				console.info(formatRA(step[0]), formatDEC(step[1]))
			}
		}
	})

	test('azimuth = 30, altitude = 0', () => {
		const pa = new ThreePointPolarAlignment(false)

		const data = [
			[2.3536822964160624, 0.001255097646035349, 2461102, -0.4525923728942871],
			[2.222780221890879, 0.002102239721985069, 2461102, -0.4524266719818115],
			[2.091878273348797, 0.0028781852732267417, 2461102, -0.45232391357421875],
			[2.0918786522562867, 0.0028780341805446355, 2461102, -0.45218706130981445],
			[2.091878330159264, 0.002878298557026267, 2461102, -0.45204687118530273],
			[2.0918785129318884, 0.002878319369089741, 2461102, -0.4519081115722656],
			[2.0918784238450474, 0.0028783866334036704, 2461102, -0.4517800807952881],
			[2.091878601083233, 0.002877992767846874, 2461102, -0.45165157318115234],
			[2.0918783389103446, 0.0028782398652076276, 2461102, -0.4515233039855957],
			[2.0918782100945736, 0.0028782642759061445, 2461102, -0.45139384269714355],
			[2.0918786683901103, 0.0028779300989778835, 2461102, -0.451265811920166],
			[2.0918786784466974, 0.0028780158800570796, 2461102, -0.4511375427246094],
			[2.0918783532639327, 0.0028783246823554398, 2461102, -0.4510078430175781],
		] as const

		for (const step of data) {
			const result = pa.add(step[0], step[1], { day: step[2], fraction: step[3], scale: 1, location })

			if (result) {
				console.info(formatRA(step[0]), formatDEC(step[1]), formatALT(result.azimuthError), formatALT(result.altitudeError))
			} else {
				console.info(formatRA(step[0]), formatDEC(step[1]))
			}
		}
	})
})

describe('practical', () => {
	const location = geodeticLocation(deg(-45.5), deg(-22.5), meter(900))

	test('west direction, no refraction', () => {
		const pa = new ThreePointPolarAlignment(false)

		const data = [
			// RA (J2000), DEC (J2000), TIME DAY, TIME FRACTION, AZIMUTH ERROR, ALTITUDE ERROR
			[0.8541181762984157, -0.7191145082752964, 2461100, 1.448749375001148],
			[0.6427503686567583, -0.7199835064300145, 2461100, 1.4489302314817905],
			[0.42936960870395086, -0.7208578590707454, 2461100, 1.4491105555549817],
			[0.42938913065110834, -0.7208633551291406, 2461100, 1.4492600115747365],
			[0.4294029200844089, -0.7208662811245878, 2461100, 1.4494085648159185],
			[0.4294069036031242, -0.7208721288162128, 2461100, 1.4495592939826074],
			[0.42941161554599844, -0.7208748413510856, 2461100, 1.4497074305542088],
			[0.4294220950868146, -0.7208768079825018, 2461100, 1.4498544560179667],
			[0.42941707496644194, -0.7208775571115016, 2461100, 1.4500029629634485],
			[0.42941667017100676, -0.7208792433756701, 2461100, 1.4501506828709885],
			[0.42941486937257317, -0.7208799205817458, 2461100, 1.4502994791666666],
			[0.4294270142274982, -0.7208811535331184, 2461100, 1.4504478587955236],
			[0.4294378773342626, -0.7208864897888182, 2461100, 1.4505966319447314],
		] as const

		for (const step of data) {
			const result = pa.add(step[0], step[1], { day: step[2], fraction: step[3], scale: 1, location })

			if (result) {
				console.info(formatRA(step[0]), formatDEC(step[1]), formatALT(result.azimuthError), formatALT(result.altitudeError))
			} else {
				console.info(formatRA(step[0]), formatDEC(step[1]))
			}
		}
	})

	test('east direction, no refraction', () => {
		const pa = new ThreePointPolarAlignment(false)

		const data = [
			[0.42927666555586463, -0.7210501707534495, 2461100, 1.460255752313468],
			[0.644389902955939, -0.7202209639669505, 2461100, 1.4604322569430979],
			[0.8544213130428252, -0.7192986773866983, 2461100, 1.4606088888893525],
			[0.8544458011639734, -0.7192988602799252, 2461100, 1.4607548032397473],
			[0.854459171421024, -0.7192997427456221, 2461100, 1.4609045833321632],
			[0.8544820519145113, -0.7192996153142466, 2461100, 1.4610537731481923],
			[0.8544962804642741, -0.7193018099666462, 2461100, 1.4612050231490974],
			[0.8545292895612107, -0.7193043281495075, 2461100, 1.461355578703461],
			[0.8545578419445433, -0.719305466513634, 2461100, 1.4615022916677924],
			[0.8545766164605572, -0.7193058557798278, 2461100, 1.4616471874989845],
			[0.8545925008947639, -0.7193108892371338, 2461100, 1.4617958912032623],
			[0.8546065912114829, -0.7193131309893378, 2461100, 1.4619467013881162],
			[0.8546186979154303, -0.7193145420999063, 2461100, 1.4620965624986977],
		] as const

		for (const step of data) {
			const result = pa.add(step[0], step[1], { day: step[2], fraction: step[3], scale: 1, location })

			if (result) {
				console.info(formatRA(step[0]), formatDEC(step[1]), formatALT(result.azimuthError), formatALT(result.altitudeError))
			} else {
				console.info(formatRA(step[0]), formatDEC(step[1]))
			}
		}
	})
})
