import { expect, test } from 'bun:test'
import { PI, PIOVERFOUR, PIOVERTWO } from '../../../../src/core/constants'
import { bahtinovAxialAngleDistance, bahtinovAxialBisectors, bahtinovFocusProximity, bahtinovGlobalLineDistance, canonicalizeBahtinovLine, clipBahtinovLineToArea, computeBahtinovFocusGeometry, intersectBahtinovLines } from '../../../../src/imaging/analysis/bahtinov/geometry'

test('canonicalizes equivalent normal-form lines', () => {
	expect(canonicalizeBahtinovLine(PI * 1.25, 7)).toEqual({ normalAngle: PI * 0.25, distance: -7 })
	expect(canonicalizeBahtinovLine(-PI * 0.75, 7)).toEqual({ normalAngle: PI * 0.25, distance: -7 })
	expect(canonicalizeBahtinovLine(PI * 2.25, 7)).toEqual({ normalAngle: PI * 0.25, distance: 7 })
})

test('computes axial distance across the canonical boundary', () => {
	expect(bahtinovAxialAngleDistance(0.01, PI - 0.01)).toBeCloseTo(0.02, 14)
	expect(bahtinovAxialAngleDistance(0, PIOVERTWO)).toBeCloseTo(PIOVERTWO, 14)
	const extreme = bahtinovAxialAngleDistance(Number.MAX_VALUE, -Number.MAX_VALUE)
	expect(Number.isFinite(extreme)).toBeTrue()
	expect(extreme).toBeGreaterThanOrEqual(0)
	expect(extreme).toBeLessThanOrEqual(PIOVERTWO)
})

test('converts local normal distance to global coordinates', () => {
	const angle = PI / 3
	const area = { left: 11, top: 17, right: 41, bottom: 57 }
	const global = bahtinovGlobalLineDistance(5, angle, area)
	expect(global).toBeCloseTo(5 + 11 * Math.cos(angle) + 17 * Math.sin(angle), 14)
})

test('intersects finite lines and rejects near-parallel lines', () => {
	const intersection = intersectBahtinovLines({ normalAngle: 0, distance: 4 }, { normalAngle: PIOVERTWO, distance: 9 })
	expect(intersection?.point.x).toBeCloseTo(4, 14)
	expect(intersection?.point.y).toBeCloseTo(9, 14)
	expect(intersection?.condition).toBeCloseTo(1, 14)
	expect(intersectBahtinovLines({ normalAngle: 0, distance: 4 }, { normalAngle: 1e-10, distance: 9 })).toBeUndefined()
})

test('computes both external-line bisectors', () => {
	const [primary, secondary] = bahtinovAxialBisectors(PI - 0.2, 0.2)
	expect(bahtinovAxialAngleDistance(primary, 0)).toBeCloseTo(0, 14)
	expect(bahtinovAxialAngleDistance(primary, secondary)).toBeCloseTo(PIOVERTWO, 14)
})

test('clips horizontal vertical and diagonal lines to pixel centers', () => {
	const area = { left: 10, top: 20, right: 15, bottom: 25 }
	expect(clipBahtinovLineToArea({ normalAngle: PIOVERTWO, distance: 22 }, area)).toEqual([
		{ x: 10, y: 22 },
		{ x: 14, y: 22 },
	])
	expect(clipBahtinovLineToArea({ normalAngle: 0, distance: 12 }, area)).toEqual([
		{ x: 12, y: 20 },
		{ x: 12, y: 24 },
	])

	const diagonal = clipBahtinovLineToArea({ normalAngle: -PIOVERFOUR, distance: -Math.sqrt(50) }, area)
	expect(diagonal?.[0].x).toBeCloseTo(10, 14)
	expect(diagonal?.[0].y).toBeCloseTo(20, 14)
	expect(diagonal?.[1].x).toBeCloseTo(14, 14)
	expect(diagonal?.[1].y).toBeCloseTo(24, 14)
})

test('computes signed focus error and stable proximity', () => {
	const geometry = computeBahtinovFocusGeometry({ normalAngle: 0, distance: 4.5 }, { normalAngle: PIOVERFOUR, distance: 0 }, { normalAngle: (PI * 3) / 4, distance: 0 }, 0.5)
	expect(geometry?.reference.x).toBeCloseTo(0, 14)
	expect(geometry?.reference.y).toBeCloseTo(0, 14)
	expect(geometry?.error).toBeCloseTo(-4.5, 14)
	expect(geometry?.absoluteError).toBeCloseTo(4.5, 14)
	expect(geometry?.focusProximity).toBeCloseTo(0.1, 14)
	expect(bahtinovFocusProximity(0, 0.5)).toBe(1)
	expect(bahtinovFocusProximity(0.5, 0.5)).toBe(0.5)
	expect(bahtinovFocusProximity(5, 0.5)).toBeCloseTo(1 / 11, 14)
	expect(bahtinovFocusProximity(Number.MAX_VALUE, Number.MIN_VALUE)).toBe(0)
	expect(computeBahtinovFocusGeometry({ normalAngle: 0, distance: -Number.MAX_VALUE }, { normalAngle: 0, distance: Number.MAX_VALUE }, { normalAngle: PIOVERTWO, distance: 0 }, 0.5)).toBeUndefined()
})

test('validates focus tolerance before rejecting parallel external lines', () => {
	const central = { normalAngle: 0, distance: 0 }
	const externalFirst = { normalAngle: PIOVERTWO, distance: 1 }
	const externalSecond = { normalAngle: PIOVERTWO, distance: 2 }
	expect(() => computeBahtinovFocusGeometry(central, externalFirst, externalSecond, -1)).toThrow(RangeError)
	expect(() => computeBahtinovFocusGeometry(central, externalFirst, externalSecond, Number.NaN)).toThrow(RangeError)
})
