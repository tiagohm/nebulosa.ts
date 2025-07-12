import type { Frame } from './frame'
import { Mat3 } from './matrix'
import { gast, precessionNutationMatrix, type Time } from './time'

// Computes the TIRS rotation matrix at time.
export function tirsRotationAt(time: Time) {
	const m = Mat3.rotZ(gast(time))
	return Mat3.mul(m, precessionNutationMatrix(time), m)
}

export const TIRS_FRAME: Frame = {
	rotationAt: tirsRotationAt,
}
