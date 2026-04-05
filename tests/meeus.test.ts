import { describe, expect, test } from 'bun:test'
import { deg } from '../src/angle'
import { Base } from '../src/meeus'

// https://github.com/commenthol/astronomia/blob/master/test/

describe('base', () => {
	test('illuminated', () => {
		expect(Base.illuminated(Math.acos(0.29312))).toBe(0.64656)
		expect(Base.illuminated(deg(69.0756))).toBe(0.6785679037959225)
	})

	test('limb', () => {
		expect(Base.limb(deg(134.6885), deg(13.7684), deg(20.6579), deg(8.6964))).toBeCloseTo(deg(285.04418687158426), 14)
	})

	test('horner', () => {
		expect(Base.horner(3, [-1, 2, -6, 2])).toBe(5) // 2x³-6x²+2x-1 at x=3
	})
})
