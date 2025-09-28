import { expect, test } from 'bun:test'
import { ariel, miranda, oberon, titania, umbriel } from '../src/gust86'
import { vector } from '../src/horizons'
import { Timescale, timeYMDHMS } from '../src/time'

const TIME = timeYMDHMS(2025, 9, 28, 12, 0, 0, Timescale.TT)

test('ariel', () => {
	const [p, v] = ariel(TIME)

	expect(p[0]).toBeCloseTo(-1.176959043222043e-3, 5)
	expect(p[1]).toBeCloseTo(3.591875744834239e-4, 5)
	expect(p[2]).toBeCloseTo(-3.399079844950596e-4, 5)
	expect(v[0]).toBeCloseTo(-1.032967573691629e-3, 4)
	expect(v[1]).toBeCloseTo(-5.88432519592446e-4, 5)
	expect(v[2]).toBeCloseTo(2.950341416356814e-3, 5)
})

test('umbriel', () => {
	const [p, v] = umbriel(TIME)

	expect(p[0]).toBeCloseTo(1.497765362082782e-3, 5)
	expect(p[1]).toBeCloseTo(-5.53025982283717e-4, 5)
	expect(p[2]).toBeCloseTo(7.831394549174959e-4, 5)
	expect(v[0]).toBeCloseTo(1.346982940304562e-3, 4)
	expect(v[1]).toBeCloseTo(3.412368689531574e-4, 5)
	expect(v[2]).toBeCloseTo(-2.309213846473641e-3, 4)
})

test('titania', () => {
	const [p, v] = titania(TIME)

	expect(p[0]).toBeCloseTo(2.809910171647295e-4, 4)
	expect(p[1]).toBeCloseTo(7.152993528105209e-4, 5)
	expect(p[2]).toBeCloseTo(-2.808657800130356e-3, 5)
	expect(v[0]).toBeCloseTo(-2.049775064716261e-3, 5)
	expect(v[1]).toBeCloseTo(4.848805265829087e-4, 5)
	expect(v[2]).toBeCloseTo(-8.408924486963512e-5, 4)
})

test('oberon', () => {
	const [p, v] = oberon(TIME)

	expect(p[0]).toBeCloseTo(1.534800427208653e-3, 4)
	expect(p[1]).toBeCloseTo(-1.264457786703036e-3, 5)
	expect(p[2]).toBeCloseTo(3.355592164681754e-3, 5)
	expect(v[0]).toBeCloseTo(1.627887714386045e-3, 5)
	expect(v[1]).toBeCloseTo(-1.443218131337613e-4, 5)
	expect(v[2]).toBeCloseTo(-8.005521054987265e-4, 5)
})

test('miranda', () => {
	const [p, v] = miranda(TIME)

	expect(p[0]).toBeCloseTo(7.451056793265872e-4, 5)
	expect(p[1]).toBeCloseTo(-1.191573068968481e-4, 5)
	expect(p[2]).toBeCloseTo(-4.311182384003686e-4, 5)
	expect(v[0]).toBeCloseTo(-1.66579592795593e-3, 5)
	expect(v[1]).toBeCloseTo(1.272465492156063e-3, 4)
	expect(v[2]).toBeCloseTo(-3.233572351139157e-3, 5)
})

test.skip('horizons', async () => {
	const v = await vector('701', '500@799', false, 1759060800000, 1759060860000, { stepSize: 1, referencePlane: 'FRAME' })

	for (let i = 0; i < 3; i++) {
		console.info(`expect(p[${i}]).toBeCloseTo(${v[0][2 + i]}, 5)`)
	}
	for (let i = 0; i < 3; i++) {
		console.info(`expect(v[${i}]).toBeCloseTo(${v[0][5 + i]}, 5)`)
	}
})
