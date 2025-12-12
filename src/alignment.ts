import { type Angle, arcsec, normalizePI } from './angle'
import { cirsToObserved, DEFAULT_REFRACTION_PARAMETERS, type RefractionParameters, refractedAltitude } from './astrometry'
import { PI, SIDEREAL_RATE, TAU } from './constants'
import type { HorizontalCoordinate } from './coordinate'
import { eraC2s, eraS2c } from './erfa'
import { precessFk5FromJ2000 } from './fk5'
import { type Time, timeToUnix } from './time'
import { type Vec3, vecNegateMut, vecPlane, vecRotateByRodrigues, vecRotY, vecRotZ } from './vec3'

export interface ThreePointPolarAlignmentResult extends Readonly<HorizontalCoordinate> {
	readonly azimuthError: Angle
	readonly altitudeError: Angle
	readonly azimuthAdjustment: Angle
	readonly altitudeAdjustment: Angle
	readonly pole: Vec3 // Normal vector of the plane defined by the three points
}

// https://sourceforge.net/p/sky-simulator/code/ci/default/tree/sky_annotation.pas
// Polar error calculation based on two celestial reference points and the error of the telescope mount at these point(s).
// Based on formulas from Ralph Pass documented at https://rppass.com/align.pdf.
// They are based on the book "Telescope Control" by Trueblood and Genet, p.111
// Ralph added sin(latitude) term in the equation for the error in RA.
export function polarAlignmentError(rightAscension: Angle, declination: Angle, latitude: Angle, lst: Angle, azimuthError: Angle, altitudeError: Angle): readonly [Angle, Angle] {
	const ha = lst - rightAscension
	const cosHA = Math.cos(ha)
	const sinHA = Math.sin(ha)
	const tanDEC = Math.tan(declination)
	const cosLat = Math.cos(latitude)
	const sinLat = Math.sin(latitude)
	const dRA = -altitudeError * (tanDEC * sinHA) + azimuthError * (sinLat - cosLat * tanDEC * cosHA)
	const dDEC = -altitudeError * cosHA + azimuthError * cosLat * sinHA
	return [rightAscension - dRA, declination + dDEC]
}

export function threePointPolarAlignmentError(p1: readonly [Angle, Angle, Time], p2: readonly [Angle, Angle, Time], p3: readonly [Angle, Angle, Time], refraction: RefractionParameters | false = DEFAULT_REFRACTION_PARAMETERS): ThreePointPolarAlignmentResult {
	// The normal vector is the direction of the mount pole
	let pole = vecPlane(eraS2c(p1[0], p1[1]), eraS2c(p2[0], p2[1]), eraS2c(p3[0], p3[1]))
	// Compute pole ⋅ Z to ensure the mount pole is pointing "up" (above the horizon)
	if (pole[2] < 0) pole = vecNegateMut(pole)
	// Find the azimuth and altitude of the mount pole (normal to the plane defined by the three reference stars)
	const { azimuth, altitude } = cirsToObserved(pole, p3[2], refraction)

	// Compute the azimuth and altitude error
	const latitude = refraction === false ? refractedAltitude(p3[2].location!.latitude, DEFAULT_REFRACTION_PARAMETERS) : p3[2].location!.latitude
	const azimuthError = normalizePI(azimuth)
	const altitudeError = altitude - latitude

	return { azimuth, altitude, pole, azimuthError, altitudeError, azimuthAdjustment: 0, altitudeAdjustment: 0 }
}

// Based on https://github.com/KDE/kstars/blob/master/kstars/ekos/align/polaralign.cpp

// Compute the polar-alignment azimuth and altitude error by comparing the new image's coordinates
// with the coordinates from the 3rd measurement image. Use the difference to infer a rotation angle,
// and rotate the originally computed polar-alignment axis by that angle to find the new axis
// around which RA now rotates.
export function threePointPolarAlignmentAfterAdjustment(result: ThreePointPolarAlignmentResult, from: readonly [Angle, Angle, Time], to: readonly [Angle, Angle, Time], refraction: RefractionParameters | false = DEFAULT_REFRACTION_PARAMETERS): ThreePointPolarAlignmentResult | false {
	// Mount is tracking over an unaligned polar axis.
	// Figure out what the ra/dec would be if the user hadn't modified the knobs.
	// That is, just rotate the 3rd measurement point around the mount's original RA axis.
	const p3Seconds = timeToUnix(to[2]) - timeToUnix(from[2]) // Time since third point in seconds

	// Angle corresponding to that interval assuming the sidereal rate.
	const p3Angle = arcsec(-SIDEREAL_RATE * p3Seconds) // Negative because the sky appears to rotate westward

	// Rotate the original 3rd point around that axis, simulating the mount's tracking movements (mount is actually unaligned).
	const p3Point = vecRotateByRodrigues(eraS2c(from[0], from[1]), result.pole, p3Angle)

	const p3AzAltPoint = cirsToObserved(p3Point, from[2], refraction)
	const newAzAltPoint = cirsToObserved(eraS2c(to[0], to[1]), to[2], refraction)

	// Find the adjustment the user must have made by examining the change from point3 to newPoint
	// (i.e. the rotation caused by the user adjusting the azimuth and altitude knobs).
	// We assume that this was a rotation around a level mount's y axis and z axis.
	const zyAdjustment = rotationAngles(eraS2c(p3AzAltPoint.azimuth, p3AzAltPoint.altitude), eraS2c(newAzAltPoint.azimuth, newAzAltPoint.altitude))

	if (zyAdjustment === false) return false

	// Rotate the original RA axis position by the above adjustments.
	const azimuthAdjustment = zyAdjustment[0]
	const altitudeAdjustment = zyAdjustment[1]
	const pole = vecRotZ(vecRotY(eraS2c(result.azimuth, result.altitude), altitudeAdjustment), azimuthAdjustment)

	// Recompute the azimuth and altitude error
	const [azimuth, altitude] = eraC2s(...pole)
	const latitude = refraction === false ? refractedAltitude(to[2].location!.latitude, DEFAULT_REFRACTION_PARAMETERS) : to[2].location!.latitude
	const azimuthError = normalizePI(azimuth)
	const altitudeError = altitude - latitude

	return { azimuth, altitude, pole: result.pole, azimuthError, altitudeError, azimuthAdjustment, altitudeAdjustment }
}

export class ThreePointPolarAlignment {
	private readonly points = new Array<readonly [Angle, Angle, Time]>(3)
	private position = 0
	private initialError: ThreePointPolarAlignmentResult | false = false
	private currentError: ThreePointPolarAlignmentResult | false = false

	constructor(private refraction: RefractionParameters | false = DEFAULT_REFRACTION_PARAMETERS) {}

	add(rightAscension: Angle, declination: Angle, time: Time, isJ2000: boolean = false) {
		const point = isJ2000 ? ([...eraC2s(...precessFk5FromJ2000(eraS2c(rightAscension, declination), time)), time] as const) : ([rightAscension, declination, time] as const)

		if (this.position < 3) {
			this.points[this.position] = point
		}

		this.position++

		// When we have three points, compute the initial polar alignment error.
		// After that, each new point is used to compute the adjusted error
		if (this.position === 3) {
			this.currentError = this.initialError = threePointPolarAlignmentError(this.points[0], this.points[1], this.points[2], this.refraction)
		} else if (this.position > 3 && this.initialError !== false) {
			this.currentError = threePointPolarAlignmentAfterAdjustment(this.initialError, this.points[2], point, this.refraction)
		}

		return this.currentError
	}

	reset() {
		this.position = 0
		this.initialError = false
		this.currentError = false
		this.points.length = 0
	}
}

// Calculates the smallest rotation angle around the Y axis (modeling a turn of the mount's altitude knob)
// that corresponds to a rotation from "from" to "goal". Note: the rotation won't reach "goal", it would still need
// another rotation around the Z axis (modeling a turn of the mount's azimuth knob).
function findSmallestThetaY(from: Vec3, goal: Vec3): Angle | false {
	const [x, , z] = from
	const zPrime = goal[2]

	// If vectors are nearly identical, use small-angle approximation
	if (Math.abs(zPrime - z) < 1e-6 && Math.abs(x) > 1e-6) {
		return (z - zPrime) / x // x cannot be 0.
	}

	// Otherwise, use the general solution
	const A = -x
	const B = z
	const C = zPrime
	const D = Math.hypot(A, B)

	if (Math.abs(C) > D + 1e-6 || D === 0) {
		console.debug('no solution: |C| > D')
		return 0
	}

	const phi = Math.atan2(B, A) // range is -pi to pi
	const alpha = Math.acos(C / D) // range is 0 to pi
	const thetaY1 = phi + alpha // range is -pi to 2pi
	const thetaY2 = phi - alpha // range is -2pi to pi

	// Find all equivalent angles in [-pi, pi)
	const allAngles = [thetaY1, thetaY2, thetaY1 - TAU, thetaY2 - TAU, thetaY1 + TAU, thetaY2 + TAU]
	const angles: number[] = []

	for (const angle of allAngles) {
		if (angle > -PI && angle < PI) {
			angles.push(angle)
		}
	}

	// no solution in [-pi, pi)
	if (angles.length === 0) {
		return false
	}

	// Pick the angle with the smallest absolute value
	let thetaY = angles[0]

	for (let i = 1; i < angles.length; i++) {
		if (Math.abs(angles[i]) < Math.abs(thetaY)) {
			thetaY = angles[i]
		}
	}

	// If the vectors are nearly identical, the small-angle approximation is better
	// So, if the angle is large, but the vectors are nearly identical, use the small-angle approximation
	if (Math.abs(zPrime - z) < 0.01 && Math.abs(x) > 1e-6 && Math.abs(thetaY) > 0.1) {
		thetaY = (z - zPrime) / x
	}

	return thetaY
}

// This computes the exact rotation angles directly (Thanks AI!)
// yAngle corresponds to a change in the mount's altitude control.
// zAngle corresponds to a change in the mount's azimuth control.
function rotationAngles(from: Vec3, goal: Vec3): readonly [Angle, Angle] | false {
	const yAngle = findSmallestThetaY(from, goal)

	if (yAngle === false) return false

	const fromAfterY = vecRotY(from, yAngle)
	const zAngle = Math.atan2(goal[1], goal[0]) - Math.atan2(fromAfterY[1], fromAfterY[0])
	return [zAngle, yAngle]
}
