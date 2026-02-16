import { expect, test } from 'bun:test'
import { arcmin, deg, dms, hour, toArcmin, toArcsec, toDeg } from '../src/angle'
import { equatorialFromJ2000 } from '../src/coordinate'
import { meter } from '../src/distance'
import { geodeticLocation, localSiderealTime } from '../src/location'
import { polarAlignmentError, ThreePointPolarAlignment, type ThreePointPolarAlignmentResult, threePointPolarAlignmentError } from '../src/polaralignment'
import { type Time, timeYMDHMS } from '../src/time'

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

test('Sky Simulator without PA error', () => {
	const steps = [
		[5.910052104952735, -0.030497350815813996, 2461088, 0.2197947567],
		[6.040961238025746, -0.03059715191766818, 2461088, 0.21991103],
		[6.171864914918518, -0.030653139880712953, 2461088, 0.220018958],
		[6.171864825603039, -0.030652761094732826, 2461088, 0.220097245],
		[6.17186538588689, -0.03065792457269777, 2461088, 0.220178669],
		[6.171865360837925, -0.03065825994726049, 2461088, 0.220260104],
		[6.171866413304625, -0.0306522270344886, 2461088, 0.2203417015],
		[6.1718656804112015, -0.030654830634304638, 2461088, 0.2204236807],
		[6.171864499608696, -0.030657555581662485, 2461088, 0.220504294],
		[6.171865002212907, -0.03065739313739383, 2461088, 0.2205866086],
		[6.171866416606788, -0.030657859054067396, 2461088, 0.2206678935],
		[6.1718639955610985, -0.03065797201329502, 2461088, 0.2207493633],
		[6.171864664950717, -0.03065770302313325, 2461088, 0.2208306016],
		[6.171865189221445, -0.03065797282883502, 2461088, 0.220912361],
		[6.1718650343583805, -0.03065830056093256, 2461088, 0.22099353],
		[6.171865178492906, -0.03065705193372811, 2461088, 0.2210749304],
		[6.171865043997833, -0.030656792368571193, 2461088, 0.221156887],
		[6.171864727969321, -0.03065305326157552, 2461088, 0.2212378937],
		[6.171864704993807, -0.030658366001546717, 2461088, 0.221319479],
		[6.1718645735198985, -0.030657682611629822, 2461088, 0.2214010647],
		[6.171865049420571, -0.03065690638520655, 2461088, 0.221482176],
		[6.171864503539178, -0.030657584094582874, 2461088, 0.2215640047],
		[6.1718641502409035, -0.03065821496754258, 2461088, 0.2216447336],
		[6.1718650538537085, -0.030657691273681443, 2461088, 0.221726817],
		[6.171864363593443, -0.03065808786540588, 2461088, 0.221807986],
		[6.171865320665681, -0.030658706157491288, 2461088, 0.2218895485],
		[6.171864763347144, -0.030657531088846227, 2461088, 0.221971875],
		[6.171865024026031, -0.03065752409714451, 2461088, 0.2220535185],
		[6.171864395276404, -0.030657607916756372, 2461088, 0.2221346525],
		[6.171865045821703, -0.030657577581258453, 2461088, 0.2222165046],
		[6.171864372908264, -0.03065811508786473, 2461088, 0.222296667],
		[6.171864717143043, -0.030652588686030408, 2461088, 0.2223789236],
		[6.171865185214169, -0.030657691254133757, 2461088, 0.222461412],
		[6.171865760671912, -0.030658389556876824, 2461088, 0.222542419],
		[6.171864873210385, -0.030656359944521632, 2461088, 0.222613009],
		[6.171864201633869, -0.030657994160929816, 2461088, 0.2226950577],
		[6.171865779959546, -0.0306575545260699, 2461088, 0.222776991],
		[6.171865498327983, -0.03065792915568804, 2461088, 0.222858044],
		[6.171865619879692, -0.03065852560134757, 2461088, 0.2229394675],
		[6.171865856000051, -0.0306567501225974, 2461088, 0.22302081],
		[6.171865438824472, -0.0306579082683555, 2461088, 0.223103912],
		[6.171863707852298, -0.030652999781737633, 2461088, 0.223196285],
		[6.1718661040218095, -0.03065315951886099, 2461088, 0.223280127],
		[6.171865041845843, -0.03065347657833997, 2461088, 0.2233711574],
		[6.171864543604955, -0.030656921037437605, 2461088, 0.2234531133],
		[6.171865911658601, -0.030656684499561427, 2461088, 0.223534745],
		[6.171864647331618, -0.0306581886129487, 2461088, 0.2236292707],
		[6.171864131220306, -0.030657723759704252, 2461088, 0.2237098725],
		[6.171865799894697, -0.030656583691857107, 2461088, 0.2237931597],
		[6.171864304725231, -0.03065747970832527, 2461088, 0.2238750346],
		[6.171865474671789, -0.030657916901853533, 2461088, 0.2239565626],
		[6.171864581230763, -0.03065787354049217, 2461088, 0.22403816],
	] as const

	const pa = new ThreePointPolarAlignment(false)
	const location = geodeticLocation(0, 0, 0)

	for (const step of steps) {
		const time: Time = { day: step[2], fraction: step[3], scale: 1 }
		time.location = location

		const result = pa.add(step[0], step[1], time, true)

		if (result) {
			expect(Math.abs(toArcsec(result.azimuthError))).toBeLessThanOrEqual(30)
			expect(Math.abs(toArcsec(result.altitudeError))).toBeLessThanOrEqual(8)
		}
	}
})
