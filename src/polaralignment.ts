import { type Angle, normalizePI } from './angle'
import { cirsToObserved, DEFAULT_REFRACTION_PARAMETERS, type RefractionParameters } from './astrometry'
import { ASEC2RAD, DAYSEC, PI, SIDEREAL_RATE } from './constants'
import { equatorialFromJ2000, type HorizontalCoordinate } from './coordinate'
import { eraC2s, eraS2c } from './erfa'
import type { GeographicPosition } from './location'
import { type Time, timeSubtract } from './time'
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

export function threePointPolarAlignmentError(p1: readonly [Angle, Angle, Time], p2: readonly [Angle, Angle, Time], p3: readonly [Angle, Angle, Time], refraction: RefractionParameters | false = DEFAULT_REFRACTION_PARAMETERS, location: GeographicPosition = p3[2].location!): ThreePointPolarAlignmentResult {
	const isNorthern = location.latitude > 0

	// The normal vector is the direction of the mount pole
	let pole = vecPlane(eraS2c(p1[0], p1[1]), eraS2c(p2[0], p2[1]), eraS2c(p3[0], p3[1]))

	// Compute pole ⋅ Z to ensure the mount pole is pointing "up" (above the horizon)
	if ((pole[2] < 0 && isNorthern) || (pole[2] > 0 && !isNorthern)) pole = vecNegateMut(pole)

	// Find the azimuth and altitude of the mount pole (normal to the plane defined by the three reference stars)
	const { azimuth, altitude } = cirsToObserved(pole, p3[2], refraction, location)

	// Compute the azimuth and altitude error
	// TODO: How to test it? const latitude = refraction === false ? refractedAltitude(Math.abs(location.latitude), DEFAULT_REFRACTION_PARAMETERS) : Math.abs(location.latitude)
	const latitude = Math.abs(location.latitude)
	const azimuthError = isNorthern ? normalizePI(azimuth) : normalizePI(azimuth + PI)
	const altitudeError = isNorthern ? altitude - latitude : latitude - altitude

	return { azimuth, altitude, pole, azimuthError, altitudeError, azimuthAdjustment: 0, altitudeAdjustment: 0 }
}

// Based on https://github.com/KDE/kstars/blob/master/kstars/ekos/align/polaralign.cpp

// Compute the polar-alignment azimuth and altitude error by comparing the new image's coordinates
// with the coordinates from the 3rd measurement image. Use the difference to infer a rotation angle,
// and rotate the originally computed polar-alignment axis by that angle to find the new axis
// around which RA now rotates.
export function threePointPolarAlignmentAfterAdjustment(
	result: ThreePointPolarAlignmentResult,
	from: readonly [Angle, Angle, Time],
	to: readonly [Angle, Angle, Time],
	refraction: RefractionParameters | false = DEFAULT_REFRACTION_PARAMETERS,
	location: GeographicPosition = to[2].location!,
): ThreePointPolarAlignmentResult | false {
	const isNorthern = location.latitude > 0

	// Mount is tracking over an unaligned polar axis.
	// Figure out what the ra/dec would be if the user hadn't modified the knobs.
	// That is, just rotate the 3rd measurement point around the mount's original RA axis.
	const p3Time = timeSubtract(to[2], from[2]) // Time since third point in days

	// Angle corresponding to that interval assuming the sidereal rate.
	const p3Angle = -SIDEREAL_RATE * ASEC2RAD * DAYSEC * p3Time // Negative because the sky appears to rotate westward

	// Rotate the original 3rd point around that axis, simulating the mount's tracking movements (mount is actually unaligned).
	const p3Point = vecRotateByRodrigues(eraS2c(from[0], from[1]), result.pole, -p3Angle)

	const p3AzAltPoint = cirsToObserved(p3Point, from[2], refraction)
	const newAzAltPoint = cirsToObserved(eraS2c(to[0], to[1]), to[2], refraction)

	// Find the adjustment the user must have made by examining the change from point3 to newPoint
	// (i.e. the rotation caused by the user adjusting the azimuth and altitude knobs).
	// We assume that this was a rotation around a level mount's y axis and z axis.
	const zyAdjustment = rotationAngles(eraS2c(p3AzAltPoint.azimuth, p3AzAltPoint.altitude), eraS2c(newAzAltPoint.azimuth, newAzAltPoint.altitude))

	if (zyAdjustment === false) return false

	// Rotate the original RA axis position by the above adjustments.
	const [azimuthAdjustment, altitudeAdjustment] = zyAdjustment
	const pole = vecRotZ(vecRotY(eraS2c(result.azimuth, result.altitude), altitudeAdjustment), azimuthAdjustment)

	// Recompute the azimuth and altitude error
	const [azimuth, altitude] = eraC2s(...pole)
	const latitude = Math.abs(location.latitude)
	const azimuthError = isNorthern ? normalizePI(azimuth) : normalizePI(azimuth + PI)
	const altitudeError = isNorthern ? altitude - latitude : latitude - altitude

	return { azimuth, altitude, pole, azimuthError, altitudeError, azimuthAdjustment, altitudeAdjustment }
}

export class ThreePointPolarAlignment {
	private readonly points = new Array<readonly [Angle, Angle, Time]>(3)
	private position = 0
	private initialError: ThreePointPolarAlignmentResult | false = false
	private currentError: ThreePointPolarAlignmentResult | false = false

	constructor(private refraction: RefractionParameters | false = DEFAULT_REFRACTION_PARAMETERS) {}

	add(rightAscension: Angle, declination: Angle, time: Time, isJ2000: boolean = false) {
		const point = isJ2000 ? ([...equatorialFromJ2000(rightAscension, declination, time), time] as const) : ([rightAscension, declination, time] as const)

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
	}
}

// https://github.com/KDE/kstars/blob/168eee57d98935b7e7dc7e2932cf3aafc089fafe/kstars/ekos/align/polaralign.cpp#L147
// Calculates the smallest rotation angle around the Y axis (modeling a turn of the mount's altitude knob)
// that corresponds to a rotation from "from" to "goal". Note: the rotation won't reach "goal", it would still need
// another rotation around the Z axis (modeling a turn of the mount's azimuth knob).
// Returns the angle in radians.
// Gemini generated something close to this with this prompt.
//   I have a geometry problem I need a solution for (with c++ code):
//   I have two points on a unit sphere (x1, y1, z1) and (x2, y2, z2).
//   I want to rotate the sphere so that x1,y1,z1 moves to x2,y2,z2,
//   but I can only make rotations first around the Y axis and then around the Z axis.
//   I want to make the smallest rotations possible. First solve for the rotation around
//   the Y axis, then the rotation around the Z axis.
// This function is just y-axis rotation part.
// Here's a quick explanation. The function finds an intermediate point (after rotating around Y-axis,
// before rotating around Z-axis). That point, since it has a Y-axis rotation from the "from" point,
// shares the from point's y value. Similarly, that point, since it will be rotated around the Z-axis
// to become the goal point, shares the goal point's z value.
// So the intermediate point is (x_int, from[1], goal[2]).
// Since the point is on the unit circle, x_int^2 + from[1]^2 +goal[2]^2 = 1.0
// So below just solves for x_int by solving that equation,
// which has 2 solutions, +sqrt(radicand)  and -sqrt(radicand).
// Now that we know the values for the intermediate point, we can find the Y rotation by projecting on the X-Z plane,
// and can find the Z rotation by projecting on the X-Y plane. See the comment in the "Steps 2 & 3" loop.
function findSmallestThetaY(from: Vec3, goal: Vec3): Angle | false {
	let radicand = 1 - from[1] * from[1] - goal[2] * goal[2]

	// Use a small tolerance for floating point errors
	if (radicand < -1e-9) {
		console.warn('PAA refresh: No solution: |C| > D')
		return false
	}

	// Ensure radicand is not negative due to precision errors
	radicand = Math.max(0, radicand)

	const xia = Math.sqrt(radicand)
	const xib = -xia
	const solutions: number[] = []

	// Steps 2 & 3: Calculate angles for both possible solutions
	for (const xi of [xia, xib]) {
		const pi: Vec3 = [xi, from[1], goal[2]]

		// Calculate Z-axis rotation angle. See below comment.
		let thetaZ = Math.atan2(goal[1], goal[0]) - Math.atan2(pi[1], pi[0])

		// Calculate Y-axis rotation angle. This expression is simply the angle of the projection of
		// intermediate point onto the X-Z plane, minus the angle of the projection onto the X-Z plane
		// of the "from" point.
		let thetaY = Math.atan2(pi[0], pi[2]) - Math.atan2(from[0], from[2])

		// Normalize angles to the range [-pi, pi] to ensure we find the smallest rotation
		// Could do this with a simple loop
		// (e.g. "while (theta_z < -PI) theta_z += 2*PI; and the "> PI" loop")
		// but AI recommends the below.
		thetaZ = Math.atan2(Math.sin(thetaZ), Math.cos(thetaZ))
		thetaY = Math.atan2(Math.sin(thetaY), Math.cos(thetaY))

		solutions.push(thetaY)
		solutions.push(thetaZ)
	}

	// Step 4: Choose the solution with the smallest total rotation
	const cost1 = Math.abs(solutions[0]) + Math.abs(solutions[1])
	const cost2 = Math.abs(solutions[2]) + Math.abs(solutions[3])

	if (cost1 <= cost2) {
		return solutions[0]
	} else {
		return solutions[2]
	}
}

// https://github.com/KDE/kstars/blob/168eee57d98935b7e7dc7e2932cf3aafc089fafe/kstars/ekos/align/polaralign.cpp#L218
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
