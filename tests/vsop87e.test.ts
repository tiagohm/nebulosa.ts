import { expect, test } from 'bun:test'
import { vector } from '../src/horizons'
import { Timescale, timeYMDHMS } from '../src/time'
import { earth, jupiter, mars, mercury, neptune, saturn, sun, uranus, venus } from '../src/vsop87e'

const TIME = timeYMDHMS(2025, 9, 28, 12, 0, 0, Timescale.TT)

test('sun', () => {
	const [p, v] = sun(TIME)

	expect(p[0]).toBeCloseTo(-3.756566982732465e-3, 4)
	expect(p[1]).toBeCloseTo(-5.108692898297777e-3, 4)
	expect(p[2]).toBeCloseTo(-2.057236065692544e-3, 4)
	expect(v[0]).toBeCloseTo(7.385958465734038e-6, 8)
	expect(v[1]).toBeCloseTo(-6.800888691183158e-7, 8)
	expect(v[2]).toBeCloseTo(-4.460508606528898e-7, 8)
})

test('mercury', () => {
	const [p, v] = mercury(TIME)

	expect(p[0]).toBeCloseTo(-3.278305714721105e-1, 4)
	expect(p[1]).toBeCloseTo(-2.892357712631268e-1, 4)
	expect(p[2]).toBeCloseTo(-1.202512659899455e-1, 4)
	expect(v[0]).toBeCloseTo(1.364674900403527e-2, 8)
	expect(v[1]).toBeCloseTo(-1.643106352874054e-2, 8)
	expect(v[2]).toBeCloseTo(-1.019119993575442e-2, 8)
})

test('venus', () => {
	const [p, v] = venus(TIME)

	expect(p[0]).toBeCloseTo(-4.162121797768538e-1, 4)
	expect(p[1]).toBeCloseTo(5.211432915972526e-1, 4)
	expect(p[2]).toBeCloseTo(2.608356782172044e-1, 4)
	expect(v[0]).toBeCloseTo(-1.66157925569794e-2, 8)
	expect(v[1]).toBeCloseTo(-1.108384626869926e-2, 8)
	expect(v[2]).toBeCloseTo(-3.935869134901029e-3, 8)
})

test('earth', () => {
	const [p, v] = earth(TIME)

	expect(p[0]).toBeCloseTo(9.940002383113462e-1, 4)
	expect(p[1]).toBeCloseTo(7.929677384409828e-2, 4)
	expect(p[2]).toBeCloseTo(3.452846899475152e-2, 4)
	expect(v[0]).toBeCloseTo(-1.857505097678384e-3, 8)
	expect(v[1]).toBeCloseTo(1.565957306376799e-2, 8)
	expect(v[2]).toBeCloseTo(6.787978596823867e-3, 8)
})

test('mars', () => {
	const [p, v] = mars(TIME)

	expect(p[0]).toBeCloseTo(-9.585963488687476e-1, 4)
	expect(p[1]).toBeCloseTo(-1.119795809347391, 4)
	expect(p[2]).toBeCloseTo(-4.875831546371381e-1, 4)
	expect(v[0]).toBeCloseTo(1.154019262489593e-2, 8)
	expect(v[1]).toBeCloseTo(-6.655626402941306e-3, 8)
	expect(v[2]).toBeCloseTo(-3.36398312521594e-3, 8)
})

test('jupiter', () => {
	const [p, v] = jupiter(TIME)

	expect(p[0]).toBeCloseTo(-1.000706953875676, 4)
	expect(p[1]).toBeCloseTo(4.655751711849623, 4)
	expect(p[2]).toBeCloseTo(2.019981914244129, 4)
	expect(v[0]).toBeCloseTo(-7.492564873687791e-3, 6)
	expect(v[1]).toBeCloseTo(-1.078368423989461e-3, 5)
	expect(v[2]).toBeCloseTo(-2.797998966238406e-4, 6)
})

test('saturn', () => {
	const [p, v] = saturn(TIME)

	expect(p[0]).toBeCloseTo(9.532809448678631, 4)
	expect(p[1]).toBeCloseTo(-1.021190567170288e-1, 4)
	expect(p[2]).toBeCloseTo(-4.527748909894636e-1, 4)
	expect(v[0]).toBeCloseTo(-1.482244057336e-4, 6)
	expect(v[1]).toBeCloseTo(5.140790102213202e-3, 5)
	expect(v[2]).toBeCloseTo(2.130149706896415e-3, 6)
})

test('uranus', () => {
	const [p, v] = uranus(TIME)

	expect(p[0]).toBeCloseTo(1.019857641706737e1, 3)
	expect(p[1]).toBeCloseTo(1.527691313686389e1, 3)
	expect(p[2]).toBeCloseTo(6.546623854315722, 3)
	expect(v[0]).toBeCloseTo(-3.381263670554054e-3, 7)
	expect(v[1]).toBeCloseTo(1.698886697706912e-3, 7)
	expect(v[2]).toBeCloseTo(7.919155475642336e-4, 7)
})

test('neptune', () => {
	const [p, v] = neptune(TIME)

	expect(p[0]).toBeCloseTo(2.98746238071638e1, 3)
	expect(p[1]).toBeCloseTo(4.729066404382924e-1, 3)
	expect(p[2]).toBeCloseTo(-5.502100412439903e-1, 3)
	expect(v[0]).toBeCloseTo(-4.320205954895582e-5, 6)
	expect(v[1]).toBeCloseTo(2.922397372840454e-3, 6)
	expect(v[2]).toBeCloseTo(1.196806657634609e-3, 5)
})

test.skip('horizons', async () => {
	const v = await vector('899', '500@0', false, 1759060800000, 1759060860000, { stepSize: 1, referencePlane: 'FRAME' })

	for (let i = 0; i < 3; i++) {
		console.info(`expect(p[${i}]).toBeCloseTo(${v[0][2 + i]}, 4)`)
	}
	for (let i = 0; i < 3; i++) {
		console.info(`expect(v[${i}]).toBeCloseTo(${v[0][5 + i]}, 8)`)
	}
})
