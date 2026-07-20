import { validateFinite } from '../../core/validation'
import { matMulVec, matRodriguesRotation } from '../../math/linear-algebra/mat3'
import type { Angle } from '../../math/units/angle'
import type { TwoAxisMountGeometry } from './kinematics'

// Adapter from Toshimi Taki's three mount-fabrication errors to the vector geometry consumed by
// the shared two-axis kinematics. Angles follow equation 5.3-1 of Matrix Method, revision E.
// https://www.astrovox.gr/applications/core/interface/file/attachment.php?id=30983

// Incremental Taki fabrication errors in radians.
export interface TakiFabricationErrors {
	// Taki D: non-perpendicularity between primary and secondary axes.
	readonly axisNonPerpendicularity?: Angle
	// Taki D': collimation between the primary axis and optical axis.
	readonly collimation?: Angle
	// Taki D'': apparent secondary-encoder zero offset.
	readonly secondaryIndex?: Angle
}

// Materializes Taki D, D', and D'' into secondaryAxis, opticalDirection, and secondaryIndex.
// For the canonical Taki triad this yields Rz(-H) Rx(D) Ry(-q-D'') Rz(D') applied to +X.
export function applyTakiFabricationErrors(nominal: Readonly<TwoAxisMountGeometry>, errors: Readonly<TakiFabricationErrors>): TwoAxisMountGeometry {
	const axisNonPerpendicularity = errors.axisNonPerpendicularity ?? 0
	const collimation = errors.collimation ?? 0
	const secondaryIndex = errors.secondaryIndex ?? 0
	validateFinite(axisNonPerpendicularity)
	validateFinite(collimation)
	validateFinite(secondaryIndex)
	if (axisNonPerpendicularity === 0 && collimation === 0 && secondaryIndex === 0) return nominal

	const nonPerpendicularityRotation = matRodriguesRotation(nominal.opticalDirection, axisNonPerpendicularity)
	const secondaryAxis = matMulVec(nonPerpendicularityRotation, nominal.secondaryAxis)
	const collimatedDirection = matMulVec(matRodriguesRotation(nominal.primaryAxis, collimation), nominal.opticalDirection)
	const opticalDirection = matMulVec(nonPerpendicularityRotation, collimatedDirection)
	return { ...nominal, secondaryAxis, opticalDirection, secondaryIndex: (nominal.secondaryIndex ?? 0) + (nominal.secondaryDirection ?? 1) * secondaryIndex }
}
