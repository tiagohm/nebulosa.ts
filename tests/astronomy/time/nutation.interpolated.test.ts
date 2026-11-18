import { expect, test } from 'bun:test'
import { eraNut06a, eraPnm06a } from '../../../src/astronomy/coordinates/erfa/erfa'
import { interpolatedNutationProviders } from '../../../src/astronomy/time/nutation.interpolated'
import { time, Timescale } from '../../../src/astronomy/time/time'
import type { Mat3 } from '../../../src/math/linear-algebra/mat3'

const MAS = Math.PI / 180 / 3600 / 1000

// Rotation angle between two rotation matrices, in radians.
function rotationBetween(a: Mat3, b: Mat3) {
	const r = (i: number, j: number) => a[i * 3] * b[j * 3] + a[i * 3 + 1] * b[j * 3 + 1] + a[i * 3 + 2] * b[j * 3 + 2]
	return Math.hypot(r(2, 1) - r(1, 2), r(0, 2) - r(2, 0), r(1, 0) - r(0, 1)) / 2
}

test('stays within 0.05 mas of the full series between 1900 and 2100', () => {
	const { nut, pnm } = interpolatedNutationProviders()

	for (let i = 0; i < 2000; i++) {
		// Golden-ratio spread over 200 years, so the instants fall everywhere between the nodes.
		const t = time(2415021, ((i * 0.6180339887498949) % 1) * 73050 - 0.5, Timescale.TT)
		const [dpsi, deps] = nut(t)
		const [edpsi, edeps] = eraNut06a(t.day, t.fraction)
		expect(Math.abs(dpsi - edpsi)).toBeLessThan(0.05 * MAS)
		expect(Math.abs(deps - edeps)).toBeLessThan(0.05 * MAS)
		expect(rotationBetween(pnm(t), eraPnm06a(t.day, t.fraction))).toBeLessThan(0.05 * MAS)
	}
})

test('is exact at a node', () => {
	const { nut } = interpolatedNutationProviders()
	const t = time(2461000, 0.25, Timescale.TT)
	const [dpsi, deps] = nut(t)
	const [edpsi, edeps] = eraNut06a(t.day, t.fraction)
	expect(dpsi).toBeCloseTo(edpsi, 15)
	expect(deps).toBeCloseTo(edeps, 15)
})

test('does not depend on the call order nor on the cached nodes', () => {
	const t = time(2461000, 0.1234, Timescale.TT)
	const cold = interpolatedNutationProviders().nut(t)

	const warm = interpolatedNutationProviders({ capacity: 4 })
	for (let i = 0; i < 100; i++) warm.nut(time(2461000, i / 37, Timescale.TT))
	expect(warm.nut(t)).toEqual(cold)

	warm.clear()
	expect(warm.nut(t)).toEqual(cold)
})
