import { expect, test } from 'bun:test'
import { deltaTByEspenakMeeus2006, s15 } from '../src/deltat'

test('s15', () => {
	const s = s15(2018)

	expect(s.lower).toBe(2016)
	expect(s.upper).toBe(2019)
	expect(s.compute(2020)).toBeCloseTo(69, 0)
})

test('espenak-meeus 2006', () => {
	// Polynomial origins evaluate to their leading constant term.
	expect(deltaTByEspenakMeeus2006(0)).toBeCloseTo(10583.6, 1)
	expect(deltaTByEspenakMeeus2006(1600)).toBeCloseTo(120, 6)
	expect(deltaTByEspenakMeeus2006(1700)).toBeCloseTo(8.83, 6)
	expect(deltaTByEspenakMeeus2006(1800)).toBeCloseTo(13.72, 6)
	expect(deltaTByEspenakMeeus2006(1900)).toBeCloseTo(-2.79, 6)
	expect(deltaTByEspenakMeeus2006(1950)).toBeCloseTo(29.07, 6)
	expect(deltaTByEspenakMeeus2006(2000)).toBeCloseTo(63.86, 6)

	// Reference values from the Espenak and Meeus tabulation.
	expect(deltaTByEspenakMeeus2006(1850)).toBeCloseTo(7.11, 1)
	expect(deltaTByEspenakMeeus2006(2024)).toBeCloseTo(73.87, 1)

	// Long-term parabola outside the fitted span stays finite and continuous.
	expect(deltaTByEspenakMeeus2006(2150)).toBeCloseTo(-20 + 32 * 3.3 * 3.3, 6)
	expect(deltaTByEspenakMeeus2006(-700)).toBeCloseTo(-20 + 32 * ((-700 - 1820) / 100) ** 2, 6)
})
