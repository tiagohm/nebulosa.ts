import type { Frame } from './frame'
import { type MutMat3, mulMat, rotZ } from './matrix'
import { type Time, gast, precessionNutationMatrix } from './time'

// Computes the TIRS rotation matrix at time.
export function tirsRotationAt(time: Time): MutMat3 {
	const m = rotZ(gast(time))
	return mulMat(m, precessionNutationMatrix(time), m)
}

export const TIRS_FRAME: Frame = {
	rotationAt: tirsRotationAt,
}
