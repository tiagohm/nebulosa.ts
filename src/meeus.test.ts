import { expect, test } from 'bun:test'
import { deg } from './angle'
import { horner, illuminated, limb } from './meeus'

// https://github.com/commenthol/astronomia/blob/master/test/base.test.js

test('illuminated', () => {
	expect(illuminated(Math.acos(0.29312))).toBe(0.64656)
	expect(illuminated(deg(69.0756))).toBe(0.6785679037959225)
})

test('limb', () => {
	expect(limb(deg(134.6885), deg(13.7684), deg(20.6579), deg(8.6964))).toBeCloseTo(deg(285.04418687158426), 14)
})

test('horner', () => {
	expect(horner(3, -1, 2, -6, 2)).toBe(5) // 2x³-6x²+2x-1 at x=3
})
