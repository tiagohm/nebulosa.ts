import type { Frame } from './frame'
import { mul, rotZ, type MutMat3 } from './matrix'
import { gast, precessionNutation, type Time } from './time'

// Computes the TIRS rotation matrix at time.
export function rotationAt(time: Time): MutMat3 {
	const m = rotZ(gast(time))
	return mul(m, precessionNutation(time), m)
}

export const TIRS_FRAME: Frame = {
	rotationAt,
}
