import { expect, test } from 'bun:test'
import { deg, toArcsec } from '../src/angle'
import { kilometer } from '../src/distance'
import { LunationSystem, lunation, moonParallax, moonSemidiameter } from '../src/moon'
import { timeYMDHMS } from '../src/time'

test('parallax', () => {
	expect(moonParallax(kilometer(368409.7))).toBeCloseTo(deg(0.99199), 7)
})

test('semi-diameter', () => {
	expect(toArcsec(moonSemidiameter(kilometer(368409.7)))).toBeCloseTo(973.029, 3)
})

test('lunation', () => {
	expect(lunation(timeYMDHMS(2000, 1, 6), LunationSystem.MEEUS)).toBe(0)
	expect(lunation(timeYMDHMS(2000, 1, 6, 18, 15), LunationSystem.MEEUS)).toBe(0)
	expect(lunation(timeYMDHMS(2001, 1, 24, 13, 6))).toBe(966)
	expect(lunation(timeYMDHMS(2001, 1, 24, 23, 7))).toBe(966)
	expect(lunation(timeYMDHMS(2001, 2, 23, 8, 21))).toBe(967)
	expect(lunation(timeYMDHMS(2021, 5, 11, 23))).toBe(1217)
	expect(lunation(timeYMDHMS(1900, 2, 17))).toBe(-283)
	expect(lunation(timeYMDHMS(2025, 6, 26))).toBe(1268)
})
