import { expect, test } from 'bun:test'
import { vector } from '../src/horizons'
import { dione, enceladus, hyperion, iapetus, mimas, rhea, tethys, titan } from '../src/tass17'
import { Timescale, timeYMDHMS } from '../src/time'

const TIME = timeYMDHMS(2025, 9, 28, 12, 0, 0, Timescale.TT)

test('mimas', () => {
	const [p, v] = mimas(TIME)

	expect(p[0]).toBeCloseTo(9.031245443324802e-4, 5)
	expect(p[1]).toBeCloseTo(8.330047265816174e-4, 5)
	expect(p[2]).toBeCloseTo(-1.154697162209327e-4, 5)
	expect(v[0]).toBeCloseTo(-5.527515854023323e-3, 6)
	expect(v[1]).toBeCloseTo(6.203463776325098e-3, 4)
	expect(v[2]).toBeCloseTo(-1.44448063177257e-4, 4)
})

test('enceladus', () => {
	const [p, v] = enceladus(TIME)

	expect(p[0]).toBeCloseTo(-1.503194579285282e-3, 5)
	expect(p[1]).toBeCloseTo(-4.769484887220645e-4, 4)
	expect(p[2]).toBeCloseTo(1.645774184566977e-4, 6)
	expect(v[0]).toBeCloseTo(2.26523787833599e-3, 4)
	expect(v[1]).toBeCloseTo(-6.955446739999229e-3, 4)
	expect(v[2]).toBeCloseTo(3.179857218431535e-4, 5)
})

test('tethys', () => {
	const [p, v] = tethys(TIME)

	expect(p[0]).toBeCloseTo(-4.383412897958286e-4, 5)
	expect(p[1]).toBeCloseTo(1.918523789133778e-3, 6)
	expect(p[2]).toBeCloseTo(-7.581369999811594e-5, 6)
	expect(v[0]).toBeCloseTo(-6.373052801069867e-3, 6)
	expect(v[1]).toBeCloseTo(-1.43395578649621e-3, 5)
	expect(v[2]).toBeCloseTo(5.689990947484036e-4, 5)
})

test('dione', () => {
	const [p, v] = dione(TIME)

	expect(p[0]).toBeCloseTo(1.948019092646909e-3, 6)
	expect(p[1]).toBeCloseTo(1.569496178251104e-3, 6)
	expect(p[2]).toBeCloseTo(-2.824073016578805e-4, 6)
	expect(v[0]).toBeCloseTo(-3.645274661821388e-3, 5)
	expect(v[1]).toBeCloseTo(4.516584467234301e-3, 5)
	expect(v[2]).toBeCloseTo(-1.730095837407608e-5, 5)
})

test('rhea', () => {
	const [p, v] = rhea(TIME)

	expect(p[0]).toBeCloseTo(-8.077023873405837e-5, 5)
	expect(p[1]).toBeCloseTo(-3.510377561976557e-3, 6)
	expect(p[2]).toBeCloseTo(2.787051213361912e-4, 5)
	expect(v[0]).toBeCloseTo(4.883826217196937e-3, 6)
	expect(v[1]).toBeCloseTo(-1.392926793637506e-4, 5)
	expect(v[2]).toBeCloseTo(-3.907384090488883e-4, 6)
})

test('titan', () => {
	const [p, v] = titan(TIME)

	expect(p[0]).toBeCloseTo(7.8355169005574e-3, 5)
	expect(p[1]).toBeCloseTo(1.076478518380957e-3, 5)
	expect(p[2]).toBeCloseTo(-7.669989861192896e-4, 6)
	expect(v[0]).toBeCloseTo(-4.352675479357954e-4, 6)
	expect(v[1]).toBeCloseTo(3.273109908877805e-3, 6)
	expect(v[2]).toBeCloseTo(-1.811836784431716e-4, 6)
})

test('iapetus', () => {
	const [p, v] = iapetus(TIME)

	expect(p[0]).toBeCloseTo(1.575669631015842e-2, 6)
	expect(p[1]).toBeCloseTo(1.707131056923016e-2, 5)
	expect(p[2]).toBeCloseTo(1.268032077162782e-5, 5)
	expect(v[0]).toBeCloseTo(-1.348738809505664e-3, 6)
	expect(v[1]).toBeCloseTo(1.28694985219912e-3, 6)
	expect(v[2]).toBeCloseTo(5.061573491871217e-4, 6)
})

test('hyperion', () => {
	const [p, v] = hyperion(TIME)

	expect(p[0]).toBeCloseTo(9.178919914977261e-3, 5)
	expect(p[1]).toBeCloseTo(4.769111055703129e-3, 4)
	expect(p[2]).toBeCloseTo(-1.035381070833417e-3, 4)
	expect(v[0]).toBeCloseTo(-1.081929004166007e-3, 4)
	expect(v[1]).toBeCloseTo(2.554959978815015e-3, 5)
	expect(v[2]).toBeCloseTo(-5.322383442015271e-5, 5)
})

test.skip('horizons', async () => {
	const v = await vector('604', '500@699', false, 1759060800000, 1759060860000, { stepSize: 1, referencePlane: 'FRAME' })

	for (let i = 0; i < 3; i++) {
		console.info(`expect(p[${i}]).toBeCloseTo(${v[0][2 + i]}, 6)`)
	}
	for (let i = 0; i < 3; i++) {
		console.info(`expect(v[${i}]).toBeCloseTo(${v[0][5 + i]}, 6)`)
	}
})
