import type { Frame } from './frame'
import { matMul, matRotZ } from './mat3'
import { greenwichApparentSiderealTime, precessionNutationMatrix, type Time } from './time'

// Computes the TIRS rotation matrix at time.
export function tirsRotationAt(time: Time) {
	const m = matRotZ(greenwichApparentSiderealTime(time))
	return matMul(m, precessionNutationMatrix(time), m)
}

export const TIRS: Frame = {
	rotationAt: tirsRotationAt,
}
