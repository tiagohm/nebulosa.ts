import { type Angle, normalizePI } from './angle'
import { cirsToObserved, DEFAULT_REFRACTION_PARAMETERS, type RefractionParameters } from './astrometry'
import { PI } from './constants'
import { equatorialFromJ2000, type HorizontalCoordinate } from './coordinate'
import { eraS2c } from './erfa'
import type { GeographicPosition } from './location'
import { earthRotationAngle, type Time } from './time'
import { type Vec3, vecCross, vecDivScalarMut, vecDot, vecLength, vecNegateMut, vecNormalizeMut, vecPlane, vecRotateByRodrigues, vecRotY } from './vec3'

export interface ThreePointPolarAlignmentResult extends Readonly<HorizontalCoordinate> {
	readonly azimuthError: Angle
	readonly altitudeError: Angle
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

export function threePointPolarAlignmentError(p1: readonly [Angle, Angle], p2: readonly [Angle, Angle], p3: readonly [Angle, Angle], time: Time, refraction: RefractionParameters | false = DEFAULT_REFRACTION_PARAMETERS, location: GeographicPosition = time.location!): ThreePointPolarAlignmentResult {
	const isNorthern = location.latitude > 0

	// The normal vector is the direction of the mount pole
	const pole = vecNormalizeMut(vecPlane(eraS2c(...p1), eraS2c(...p2), eraS2c(...p3)))

	// Compute pole ⋅ Z to ensure the mount pole is pointing "up" (above the horizon)
	if ((pole[2] < 0 && isNorthern) || (pole[2] > 0 && !isNorthern)) vecNegateMut(pole)

	// Find the azimuth and altitude of the mount pole (normal to the plane defined by the three reference stars)
	const { azimuth, altitude } = cirsToObserved(pole, time, refraction, location)

	// Compute the azimuth and altitude error
	const latitude = Math.abs(location.latitude) // ChatGPT doesn't recommend to refract the latitude!
	const azimuthError = isNorthern ? normalizePI(azimuth) : normalizePI(azimuth + PI)
	const altitudeError = isNorthern ? altitude - latitude : latitude - altitude

	return { azimuth, altitude, pole, azimuthError, altitudeError }
}

// Based on https://github.com/KDE/kstars/blob/57c2cf84c4cb38eb7cbdd0bfd77359a66c74b93b/kstars/ekos/align/polaralign.cpp#L238

// Compute the polar-alignment azimuth and altitude error by comparing the new image's coordinates
// with the coordinates from the 3rd measurement image. Use the difference to infer a rotation angle,
// and rotate the originally computed polar-alignment axis by that angle to find the new axis
// around which RA now rotates.
export function threePointPolarAlignmentAfterAdjustment(
	result: ThreePointPolarAlignmentResult, // 3rd measurement image alignment result
	from: readonly [Angle, Angle], // 3rd measurement image solution CIRS coordinates
	timeFrom: Time,
	to: readonly [Angle, Angle], // actual measurement image solution CIRS coordinates
	timeTo: Time,
	refraction: RefractionParameters | false = DEFAULT_REFRACTION_PARAMETERS,
	location: GeographicPosition = timeTo.location!,
): ThreePointPolarAlignmentResult | false {
	const isNorthern = location.latitude > 0

	// Angle corresponding to that interval assuming the sidereal rate.
	const siderealAngle = normalizePI(earthRotationAngle(timeTo) - earthRotationAngle(timeFrom))

	// Rotate the original 3rd point around that axis, simulating the mount's tracking movements (mount is actually unaligned).
	const p3Expected = vecRotateByRodrigues(eraS2c(from[0], from[1]), result.pole, siderealAngle)
	const pNew = eraS2c(to[0], to[1])

	// Find the adjustment the user must have made by examining the change from point3 to newPoint
	// (i.e. the rotation caused by the user adjusting the azimuth and altitude knobs).
	const p3Cross = vecCross(p3Expected, pNew)
	const sinRot = vecLength(p3Cross) // ∥a × b∥ = ∥a∥ * ∥b∥ * sinθ, a and b are unitary, so ∥a × b∥ = sinθ
	const cosRot = vecDot(p3Expected, pNew) // a ⋅ b = cosθ

	// sinθ = 0 and cosθ > 0 will only occur if the mount rotates 0°
	// sinθ = 0 and cosθ < 0 will only occur if the mount rotates 180°
	if (sinRot === 0 && cosRot > 0) {
		console.info('no rotation applied')
		return result
	}

	// Rotate the original RA axis position by the above adjustments.
	const rotAxis = vecDivScalarMut(p3Cross, sinRot)
	const rotAngle = Math.atan2(sinRot, cosRot) // θ = atan2(sinθ, cosθ)
	const newPole = vecRotateByRodrigues(result.pole, rotAxis, rotAngle)
	const observedPole = cirsToObserved(newPole, timeTo, refraction, location)

	// Recompute the azimuth and altitude error
	const { azimuth, altitude } = observedPole
	const latitude = Math.abs(location.latitude) // ChatGPT doesn't recommend to refract the latitude!
	const azimuthError = isNorthern ? normalizePI(azimuth) : normalizePI(azimuth + PI)
	const altitudeError = isNorthern ? altitude - latitude : latitude - altitude

	return { azimuth, altitude, pole: newPole, azimuthError, altitudeError }
}

function decomposeAzAltAdjustment(poleLocal: Vec3, newPoleLocal: Vec3): Readonly<{ azimuthAdjustment: number; altitudeAdjustment: number }> {
	// --- 1) Resolver altitude ---
	const numAlt = poleLocal[0] * newPoleLocal[2] - poleLocal[2] * newPoleLocal[0]
	const denAlt = poleLocal[0] * newPoleLocal[0] + poleLocal[2] * newPoleLocal[2]
	const altitudeAdjustment = Math.atan2(numAlt, denAlt)

	// --- 2) Aplicar rotação de altitude ---
	const poleAfterAlt = vecRotY(poleLocal, altitudeAdjustment)

	// --- 3) Resolver azimute ---
	const numAz = poleAfterAlt[0] * newPoleLocal[1] - poleAfterAlt[1] * newPoleLocal[0]
	const denAz = poleAfterAlt[0] * newPoleLocal[0] + poleAfterAlt[1] * newPoleLocal[1]

	const azimuthAdjustment = Math.atan2(numAz, denAz)

	return { azimuthAdjustment, altitudeAdjustment }
}

export class ThreePointPolarAlignment {
	private readonly points = new Array<readonly [Angle, Angle]>(3)
	private readonly times = new Array<Time>(3)

	private position = 0
	private initialError: ThreePointPolarAlignmentResult | false = false
	private currentError: ThreePointPolarAlignmentResult | false = false

	constructor(private refraction: RefractionParameters | false = DEFAULT_REFRACTION_PARAMETERS) {}

	add(rightAscension: Angle, declination: Angle, time: Time, isJ2000: boolean) {
		const point = isJ2000 ? equatorialFromJ2000(rightAscension, declination, time) : ([rightAscension, declination] as const)

		if (this.position < 3) {
			this.points[this.position] = point
			this.times[this.position] = time
		}

		this.position++

		// When we have three points, compute the initial polar alignment error.
		// After that, each new point is used to compute the adjusted error
		if (this.position === 3) {
			this.currentError = this.initialError = threePointPolarAlignmentError(this.points[0], this.points[1], this.points[2], time, this.refraction)
		} else if (this.position > 3 && this.initialError !== false) {
			this.currentError = threePointPolarAlignmentAfterAdjustment(this.initialError, this.points[2], this.times[2], point, time, this.refraction)
		}

		return this.currentError
	}

	reset() {
		this.position = 0
		this.initialError = false
		this.currentError = false
	}
}
