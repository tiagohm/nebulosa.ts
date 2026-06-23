import { expect, test } from 'bun:test'
import type { PositionAndVelocity } from '../src/astrometry'
import { PI } from '../src/constants'
import { ellipticToRectangular, ellipticToRectangularA, ellipticToRectangularN } from '../src/ephemeris'

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

test('terminates on a non-finite element instead of looping forever', () => {
	// A NaN element makes the Newton step non-finite; without the iteration cap
	// the convergence test never passes and the call would hang. The cap makes it
	// return (with non-finite output), so simply completing proves termination.
	const [p, v] = ellipticToRectangular(2, 0.5, [0, 0, Number.NaN, 0, 0, 0], 0)

	expect(p).toHaveLength(3)
	expect(v).toHaveLength(3)
})
