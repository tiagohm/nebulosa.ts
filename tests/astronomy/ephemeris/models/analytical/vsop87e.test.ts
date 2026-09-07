import { expect, test } from 'bun:test'
import { vector } from '../../../../../src/adapters/ephemeris/horizons'
import { earth, jupiter, mars, mercury, neptune, saturn, sun, uranus, venus } from '../../../../../src/astronomy/ephemeris/models/analytical/vsop87e'
import { time, Timescale, timeShift } from '../../../../../src/astronomy/time/time'

// Bretagnon/Francou VSOP87E, vsop87.chk: barycentric dynamical ecliptic/equinox J2000,
// positions in AU and velocities in AU/day at dynamical JD 2415020.0 (nonzero series time).
// https://github.com/ctdk/vsop87/blob/master/vsop87.chk
// Use the published numerical time argument directly in TT, without a TT/TDB offset.
const TIME = time(2415020, 0, Timescale.TT)

const ECLIPTIC_CASES = [
	['sun', sun, [0.0031876597, 0.0063575996, -0.0001036885], [-0.0000073486, 0.0000037875, 0.0000001748]],
	['mercury', mercury, [-0.3865370327, -0.1438666201, 0.0235162485], [0.0042941824, -0.0250124495, -0.0024360336]],
	['venus', venus, [0.7003304925, -0.1970055158, -0.0431238022], [0.0055497756, 0.0193312684, -0.0000622747]],
	['earth', earth, [-0.1851203046, 0.9714264843, 0.0001113443], [-0.0171823836, -0.0033539678, -0.0000016179]],
	['mars', mars, [0.4316209101, -1.3488778274, -0.0390687101], [0.0138728496, 0.0054168276, -0.0002307836]],
	['jupiter', jupiter, [-3.015934774, -4.4518987729, 0.0857605014], [0.0061580622, -0.003875629, -0.0001223731]],
	['saturn', saturn, [-0.3664097224, -10.0518822109, 0.1915817572], [0.005266511, -0.0002253719, -0.000204856]],
	['uranus', uranus, [-6.4778956413, -17.8463318322, 0.0176898373], [0.0036668409, -0.0015250649, -0.0000533417]],
	['neptune', neptune, [1.5196434117, 29.8318114919, -0.6492437025], [-0.0031531984, 0.0001800719, 0.0000689285]],
] as const

// NASA JPL Horizons.
const ICRF_CASES = [
	['sun', sun, [0.003186851564713337, 0.005880337317042721, 0.00243684546543871], [-0.000007349501671140852, 0.000003405360348480811, 0.000001666935679987435]],
	['mercury', mercury, [-0.3865379111973964, -0.1413430217534487, -0.03564799956005415], [0.004294172731506083, -0.02197947854131485, -0.012184393904347]],
	['venus', venus, [0.7003295847855556, -0.1635896475189734, -0.1179265506833069], [0.005549784494988452, 0.01776086165221989, 0.007632397712700966]],
	['mars', mars, [0.4316195602154773, -1.222024711681322, -0.5723943682656563], [0.0138728508355957, 0.00506163719714786, 0.001942948790628144]],
	['jupiter', jupiter, [-3.015935895278338, -4.118643863954253, -1.692174776268683], [0.006158396172112774, -0.003506194780650265, -0.001653451062003078]],
	['saturn', saturn, [-0.3664165490743639, -9.298620495398872, -3.822631378717441], [0.005265758461380229, -0.0001253291301835685, -0.000277535501519078]],
	['uranus', uranus, [-6.477935048546072, -16.38069886331891, -7.082623693609421], [0.003666762465025589, -0.001377986875767123, -0.000655612566582102]],
	['neptune', neptune, [1.519630472023036, 27.62844554754698, 11.27075166603728], [-0.003153387850857982, 0.0001375504655162702, 0.0001344556706646119]],
] as const

test.each(ECLIPTIC_CASES)('%s ecliptic J2000 reference', (_, body, expectedPosition, expectedVelocity) => {
	const [p, v] = body(TIME, 'eclipticJ2000')

	for (let i = 0; i < 3; i++) {
		// Reference values are printed to ten decimal places.
		expect(p[i]).toBeCloseTo(expectedPosition[i], 9)
		expect(v[i]).toBeCloseTo(expectedVelocity[i], 9)
	}
})

test.each(ICRF_CASES)('%s ICRF reference', (_, body, expectedPosition, expectedVelocity) => {
	const [p, v] = body(TIME)

	for (let i = 0; i < 3; i++) {
		// Reference values are printed to ten decimal places.
		expect(p[i]).toBeCloseTo(expectedPosition[i], 4)
		expect(v[i]).toBeCloseTo(expectedVelocity[i], 5)
	}
})

test.skip('horizons', async () => {
	const planets = {
		sun: '10',
		mercury: '199',
		venus: '299',
		mars: '499',
		jupiter: '599',
		saturn: '699',
		uranus: '799',
		neptune: '899',
	} as const

	for (const [name, code] of Object.entries(planets)) {
		const v = await vector(code, '500@0', false, TIME, timeShift(TIME, 1 / 24), { stepSize: 1, stepSizeUnit: 'h', referencePlane: 'FRAME' })
		const pv = v[0].slice(2, 8).map(Number)
		const line = `['${name}', ${name}, [${pv.slice(0, 3)}], [${pv.slice(3)}]],`
		console.info(line)
	}
})
