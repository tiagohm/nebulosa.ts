import { matMul, matRotZ } from '../../math/linear-algebra/mat3'
import { greenwichApparentSiderealTime, precessionNutationMatrix, type Time } from '../time/time'
import type { Frame } from './frame'

// Computes the TIRS rotation matrix at time.
export function tirsRotationAt(time: Time) {
	const m = matRotZ(greenwichApparentSiderealTime(time))
	return matMul(m, precessionNutationMatrix(time), m)
}

export const TIRS: Frame = {
	rotationAt: tirsRotationAt,
}
