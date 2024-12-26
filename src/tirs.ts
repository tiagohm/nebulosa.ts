import { EARTH_ANGULAR_VELOCITY_MATRIX } from './itrs'
import { mul, rotZ, type MutMat3 } from './matrix'
import { gast, precessionNutation, type Time } from './time'

// Computes the TIRS rotation matrix at time.
export function rotationAt(time: Time): MutMat3 {
	const m = rotZ(gast(time))
	return mul(m, precessionNutation(time), m)
}

export function dRdtTimesRtAt(time: Time): MutMat3 {
	// TODO: taking the derivative of the instantaneous angular velocity provides a more accurate transform.
	return [...EARTH_ANGULAR_VELOCITY_MATRIX]
}
