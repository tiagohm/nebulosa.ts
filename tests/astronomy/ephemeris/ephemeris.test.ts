import { expect, test } from 'bun:test'
import type { PositionAndVelocity } from '../../../src/astronomy/coordinates/astrometry'
import { ellipticToRectangular, ellipticToRectangularA, ellipticToRectangularN } from '../../../src/astronomy/ephemeris/ephemeris'
import { PI, TAU } from '../../../src/core/constants'

// Circular, equatorial orbit: K=H=Q=P=0, so the body sits on a radius-a circle
// in the reference plane with speed a*n. With a=2, n=0.5 the speed is exactly 1.
const CIRCULAR = [0, 0, 0, 0, 0, 0] as const

test('circular orbit at the initial epoch', () => {
	const [p, v] = ellipticToRectangular(2, 0.5, CIRCULAR, 0)

	expect(p[0]).toBeCloseTo(2, 15)
	expect(p[1]).toBeCloseTo(0, 15)
	expect(p[2]).toBeCloseTo(0, 15)
	expect(v[0]).toBeCloseTo(0, 15)
	expect(v[1]).toBeCloseTo(1, 15)
	expect(v[2]).toBeCloseTo(0, 15)
})

test('circular orbit after a quarter revolution', () => {
	// n*dt = PI/2 advances the mean longitude by a quarter turn.
	const [p, v] = ellipticToRectangular(2, 0.5, CIRCULAR, PI)

	expect(p[0]).toBeCloseTo(0, 14)
	expect(p[1]).toBeCloseTo(2, 14)
	expect(p[2]).toBeCloseTo(0, 14)
	expect(v[0]).toBeCloseTo(-1, 14)
	expect(v[1]).toBeCloseTo(0, 14)
	expect(v[2]).toBeCloseTo(0, 14)
})

// Eccentric planar orbit with the pericenter on the +x axis (K=e, H=Q=P=0).
// a=2, e=0.5, n=0.5: pericenter distance a(1-e)=1, apocenter distance a(1+e)=3,
// and the vis-viva speeds n*a*sqrt((1+e)/(1-e)) and n*a*sqrt((1-e)/(1+e)).
const ECCENTRIC = [0, 0, 0.5, 0, 0, 0] as const

test('eccentric orbit at pericenter', () => {
	const [p, v] = ellipticToRectangular(2, 0.5, ECCENTRIC, 0)

	expect(p[0]).toBeCloseTo(1, 14)
	expect(p[1]).toBeCloseTo(0, 14)
	expect(p[2]).toBeCloseTo(0, 14)
	expect(v[0]).toBeCloseTo(0, 14)
	expect(v[1]).toBeCloseTo(Math.sqrt(3), 14)
	expect(v[2]).toBeCloseTo(0, 14)
})

test('eccentric orbit at apocenter', () => {
	// L advances by PI (half a mean revolution) to reach apocenter on the -x axis.
	const [p, v] = ellipticToRectangular(2, 0.5, ECCENTRIC, TAU)

	expect(p[0]).toBeCloseTo(-3, 13)
	expect(p[1]).toBeCloseTo(0, 13)
	expect(v[0]).toBeCloseTo(0, 13)
	expect(v[1]).toBeCloseTo(-Math.sqrt(1 / 3), 13)
})

test('the N and A entry points reconstruct the same a and n', () => {
	// mu chosen so that a=2, n=0.5 are mutually consistent (mu = a^3 * n^2 = 2).
	const byN = ellipticToRectangularN(2, [0.5, 0, 0, 0, 0, 0], 0)
	const byA = ellipticToRectangularA(2, [2, 0, 0, 0, 0, 0], 0)

	for (let i = 0; i < 3; i++) {
		expect(byN[0][i]).toBeCloseTo(byA[0][i], 15)
		expect(byN[1][i]).toBeCloseTo(byA[1][i], 15)
	}

	expect(byN[0][0]).toBeCloseTo(2, 15)
	expect(byN[1][1]).toBeCloseTo(1, 15)
})

test('writes into and returns the provided output buffer', () => {
	const o: PositionAndVelocity = [
		[9, 9, 9],
		[9, 9, 9],
	]
	const result = ellipticToRectangular(2, 0.5, CIRCULAR, 0, o)

	expect(result).toBe(o)
	expect(o[0][0]).toBeCloseTo(2, 15)
	expect(o[1][1]).toBeCloseTo(1, 15)
})

test('wrapper entry points also write into the provided output buffer', () => {
	const o: PositionAndVelocity = [
		[9, 9, 9],
		[9, 9, 9],
	]
	const result = ellipticToRectangularA(2, [2, 0, 0, 0, 0, 0], 0, o)

	expect(result).toBe(o)
	expect(o[0][0]).toBeCloseTo(2, 15)
	expect(o[1][1]).toBeCloseTo(1, 15)
})

test('terminates on a non-finite element instead of looping forever', () => {
	// A NaN element makes the Newton step non-finite; without the iteration cap
	// the convergence test never passes and the call would hang. The cap makes it
	// return (with non-finite output), so simply completing proves termination.
	const [p, v] = ellipticToRectangular(2, 0.5, [0, 0, Number.NaN, 0, 0, 0], 0)

	expect(p).toHaveLength(3)
	expect(v).toHaveLength(3)
})
