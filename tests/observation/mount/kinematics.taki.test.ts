import { expect, test } from 'bun:test'
import { deg } from '../../../src/math/units/angle'
import { createCanonicalEquatorialGeometry, mountDirectionFromEncoders } from '../../../src/observation/mount/kinematics'
import { applyTakiFabricationErrors } from '../../../src/observation/mount/kinematics.taki'

// Tests the exact sign mapping from Taki fabrication errors into vector mount geometry.

// Compares one three-component vector at the requested decimal precision.
function expectVectorClose(actual: readonly number[], expected: readonly number[], precision: number = 12): void {
	for (let i = 0; i < 3; i++) expect(actual[i]).toBeCloseTo(expected[i], precision)
}

test('zero Taki errors preserve the nominal geometry exactly', () => {
	const nominal = createCanonicalEquatorialGeometry()
	expect(applyTakiFabricationErrors(nominal, {})).toBe(nominal)
	expect(applyTakiFabricationErrors(nominal, { axisNonPerpendicularity: 0, collimation: 0, secondaryIndex: 0 })).toBe(nominal)
})

test('Taki equation 5.3-1 reproduces the published exact example', () => {
	const geometry = applyTakiFabricationErrors(createCanonicalEquatorialGeometry(), {
		axisNonPerpendicularity: deg(0.15),
		collimation: deg(-0.08),
		secondaryIndex: deg(0.2),
	})
	// Taki j is counterclockwise-positive, whereas the canonical primary encoder is west-positive H=-j.
	const direction = mountDirectionFromEncoders(geometry, { primary: deg(-53.5), secondary: deg(62.3) })
	expectVectorClose(direction, [0.27764743, 0.36896762, 0.88700327], 7)
})

test('small fabrication errors follow their first-order directions', () => {
	const epsilon = 1e-7
	const nominal = createCanonicalEquatorialGeometry()
	const collimated = applyTakiFabricationErrors(nominal, { collimation: epsilon })
	const indexed = applyTakiFabricationErrors(nominal, { secondaryIndex: epsilon })
	const nonPerpendicular = applyTakiFabricationErrors(nominal, { axisNonPerpendicularity: epsilon })

	expectVectorClose(mountDirectionFromEncoders(collimated, { primary: 0, secondary: 0 }), [1, epsilon, 0], 12)
	expectVectorClose(mountDirectionFromEncoders(indexed, { primary: 0, secondary: 0 }), [1, 0, epsilon], 12)
	expectVectorClose(mountDirectionFromEncoders(nonPerpendicular, { primary: 0, secondary: Math.PI / 2 }), [0, -epsilon, 1], 12)
})

test('non-finite Taki errors are rejected', () => {
	const nominal = createCanonicalEquatorialGeometry()
	expect(() => applyTakiFabricationErrors(nominal, { axisNonPerpendicularity: Number.NaN })).toThrow()
	expect(() => applyTakiFabricationErrors(nominal, { collimation: Number.POSITIVE_INFINITY })).toThrow()
	expect(() => applyTakiFabricationErrors(nominal, { secondaryIndex: Number.NEGATIVE_INFINITY })).toThrow()
})
