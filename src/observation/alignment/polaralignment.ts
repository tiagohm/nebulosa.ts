import { DEFAULT_REFRACTION_PARAMETERS, observedToCirs, type RefractionParameters, refractedAltitude } from '../../astronomy/coordinates/astrometry'
import { eraS2c } from '../../astronomy/coordinates/erfa/erfa'
import { applyEquatorialPointingError, polarAlignmentPointingModel } from '../../astronomy/coordinates/pointing'
import type { GeographicPosition } from '../../astronomy/observer/location'
import { cirsRotationMatrix, gcrsToItrsRotationMatrix, type Time } from '../../astronomy/time/time'
import { PI } from '../../core/constants'
import type { MountCommander } from '../../devices/commanders/mount'
import type { Mount } from '../../devices/indi/device'
import { failedOperationResult, type OperationContext, type OperationResult, successfulOperationResult } from '../../devices/orchestration/operation'
import { matMulVec, matTransposeMulVec } from '../../math/linear-algebra/mat3'
import { type Vec3, vecAngleUnit, vecCross, vecDot, vecLength, vecNormalize, vecNormalizeMut, vecRotateByRodrigues } from '../../math/linear-algebra/vec3'
import type { Angle } from '../../math/units/angle'
import type { CenteringClock } from '../mount/centering'

// Method-agnostic polar alignment shared by the three-point (`tppa`), DARV (`darv`), Challis,
// iPolar and exposure modules. Geometry lives in the inertial frame used by plate solutions: the
// module locates the refracted observing target, converts altitude-error references, builds and
// applies mount-base rotations, solves knob deltas from a star displacement, decomposes a spherical
// error into signed mechanical tangent components, and evaluates the classic two-star pointing
// error. It also holds the mount primitives of the runners: the RA motion direction, the mount
// refusal and the timed manual motion. All angles are radians and returned vectors are newly
// allocated unit vectors unless stated otherwise.

// Minimum usable vector or tangent-axis length for public polar-alignment geometry.
const VECTOR_EPSILON = 1e-14

// Maximum accepted absolute dot product between normalized mount adjustment axes.
const AXIS_ORTHOGONALITY_TOLERANCE = 1e-10

// Angular distance from the antipode below which the spherical logarithm is undefined.
const ANTIPODAL_EPSILON = 1e-10

// Exact signed decomposition of a polar error in the mount's local tangent directions.
export interface PolarAlignmentErrorComponents {
	// Great-circle separation between the current and target poles, in radians.
	readonly total: Angle
	// Signed component along positive azimuth adjustment, in radians.
	readonly azimuth: Angle
	// Signed component along positive altitude adjustment, in radians.
	readonly altitude: Angle
}

// Returns the above-horizon celestial-pole target altitude in radians for geographic latitude
// in [-PI/2, PI/2]. False selects the geometric pole; otherwise uses the shared atmospheric model.
export function polarAlignmentReferenceAltitude(latitude: Angle, refraction: RefractionParameters | false = DEFAULT_REFRACTION_PARAMETERS): Angle {
	const altitude = Math.abs(latitude)
	return refraction === false ? altitude : refractedAltitude(altitude, refraction)
}

// Converts a signed altitude error (radians) between geometric (false) and refracted references.
// Latitude is geographic radians; positive error raises the pole in the north and lowers it in
// the south, using the northern convention at zero latitude. Defaults convert geometric DARV
// errors to the three-point display's default atmosphere. Swap from/to for the inverse conversion.
// Both the mount-pole altitude and target are refracted, not just the target. Matches the three-point
// display's ERFA vector refraction and refractedAltitude target (including their near-horizon
// approximation difference); does not model time-dependent frames, polar motion or drift
// caused by changing refraction during a DARV exposure. Intended for small alignment errors and
// terrestrial atmospheric parameters. Inversion uses at most 12 fixed-point steps with a 2e-15 rad
// stopping tolerance. Inputs are unchanged and the returned value is a scalar angle.
export function convertPolarAlignmentAltitudeError(error: Angle, latitude: Angle, from: RefractionParameters | false = false, to: RefractionParameters | false = DEFAULT_REFRACTION_PARAMETERS): Angle {
	if (from === to) return error
	const sign = latitude >= 0 ? 1 : -1
	const sourceAltitude = polarAlignmentReferenceAltitude(latitude, from) + sign * error
	let geometricAltitude = sourceAltitude
	if (from !== false) {
		for (let i = 0; i < 12; i++) {
			const correction = sourceAltitude - observedPoleAltitude(geometricAltitude, from)
			geometricAltitude += correction
			if (Math.abs(correction) <= 2e-15) break
		}
	}
	const altitude = to === false ? geometricAltitude : observedPoleAltitude(geometricAltitude, to)
	return sign * (altitude - polarAlignmentReferenceAltitude(latitude, to))
}

// Refracts a geometric mount-pole altitude in radians using eraAtioq's vector update. The scalar
// refractedAltitude supplies its Newton-corrected angle, but adding that angle alone differs from
// the observed vector near the capped horizon. Preserves the same r/z floors without changing the
// shared target-altitude approximation or requiring a time/location astrometry context.
function observedPoleAltitude(altitude: Angle, refraction: RefractionParameters): Angle {
	const correction = refractedAltitude(altitude, refraction) - altitude
	const cos = Math.cos(altitude)
	const sin = Math.sin(altitude)
	const r = Math.max(1e-6, cos)
	const z = Math.max(0.05, sin)
	const cosCorrection = 1 - (correction * correction) / 2
	const horizontal = cos * (cosCorrection - (correction * z) / r)
	const vertical = cosCorrection * sin + correction * r
	return Math.atan2(vertical, Math.abs(horizontal))
}

// Computes the celestial-pole direction in the inertial J2000/ICRS frame used by plate solutions.
// `location` is geodetic and angles are radians. Refraction changes the observed target altitude;
// passing `false` selects the geometric pole. The returned vector is normalized and newly allocated.
export function celestialPoleVector(time: Time, location: GeographicPosition = time.location!, refraction: RefractionParameters | false = DEFAULT_REFRACTION_PARAMETERS): Vec3 {
	const azimuth = location.latitude >= 0 ? 0 : PI
	const altitude = polarAlignmentReferenceAltitude(location.latitude, refraction)
	const [rightAscension, declination] = observedToCirs(azimuth, altitude, time, refraction, location)
	return vecNormalizeMut(matTransposeMulVec(cirsRotationMatrix(time), eraS2c(rightAscension, declination)))
}

// Re-expresses an ICRF direction attached to the Earth from `from` to `to`, preserving its ITRS
// orientation. Returns `vector` itself when the Time object is unchanged, otherwise a fresh vector.
export function transportEarthFixed(vector: Vec3, from: Time, to: Time): Vec3 {
	if (from === to) return vector
	const transported = matMulVec(gcrsToItrsRotationMatrix(from), vector)
	return matTransposeMulVec(gcrsToItrsRotationMatrix(to), transported, transported)
}

// Applies azimuth about local up, then altitude about the east axis carried by the rotated mount
// base. Inputs are inertial vectors and angles are radians. The returned unit vector is fresh.
export function applyMountAdjustment(vector: Vec3, upAxis: Vec3, eastAxis: Vec3, azimuth: Angle, altitude: Angle): Vec3 {
	validateAdjustmentGeometry(vector, upAxis, eastAxis)
	const afterAzimuth = vecRotateByRodrigues(vector, upAxis, azimuth)
	const altitudeAxis = vecRotateByRodrigues(eastAxis, upAxis, azimuth)
	return vecNormalizeMut(vecRotateByRodrigues(afterAzimuth, altitudeAxis, altitude))
}

// Applies the inverse of `applyMountAdjustment`. Inputs are inertial vectors and angles are radians;
// rotations are undone in reverse order and the returned unit vector is fresh.
export function applyInverseMountAdjustment(vector: Vec3, upAxis: Vec3, eastAxis: Vec3, azimuth: Angle, altitude: Angle): Vec3 {
	validateAdjustmentGeometry(vector, upAxis, eastAxis)
	const altitudeAxis = vecRotateByRodrigues(eastAxis, upAxis, azimuth)
	const beforeAltitude = vecRotateByRodrigues(vector, altitudeAxis, -altitude)
	return vecNormalizeMut(vecRotateByRodrigues(beforeAltitude, upAxis, -azimuth))
}

// Decomposes `currentPole -> targetPole` with the exact spherical logarithm at the target. The
// tangent basis follows positive azimuth (`up × target`) and altitude (`east × target`) mount
// rotations. Returns undefined for zero, antipodal, or mechanically singular geometry.
export function decomposePolarErrorGeodesic(currentPole: Vec3, targetPole: Vec3, upAxis: Vec3, eastAxis: Vec3): PolarAlignmentErrorComponents | undefined {
	if (!isFiniteNonZeroVector(currentPole) || !isFiniteNonZeroVector(targetPole) || !isFiniteNonZeroVector(upAxis) || !isFiniteNonZeroVector(eastAxis)) return undefined

	const current = vecNormalize(currentPole)
	const target = vecNormalize(targetPole)
	const total = vecAngleUnit(target, current)
	if (!Number.isFinite(total) || PI - total <= ANTIPODAL_EPSILON) return undefined
	if (total <= VECTOR_EPSILON) return { total: 0, azimuth: 0, altitude: 0 }

	const azimuthTangent = vecCross(upAxis, target)
	const azimuthLength = vecLength(azimuthTangent)
	if (!Number.isFinite(azimuthLength) || azimuthLength <= VECTOR_EPSILON) return undefined
	azimuthTangent[0] /= azimuthLength
	azimuthTangent[1] /= azimuthLength
	azimuthTangent[2] /= azimuthLength

	const altitudeDerivative = vecCross(eastAxis, target)
	const projection = vecDot(altitudeDerivative, azimuthTangent)
	const altitudeTangent: [number, number, number] = [altitudeDerivative[0] - projection * azimuthTangent[0], altitudeDerivative[1] - projection * azimuthTangent[1], altitudeDerivative[2] - projection * azimuthTangent[2]]
	const altitudeLength = vecLength(altitudeTangent)
	if (!Number.isFinite(altitudeLength) || altitudeLength <= VECTOR_EPSILON) return undefined
	altitudeTangent[0] /= altitudeLength
	altitudeTangent[1] /= altitudeLength
	altitudeTangent[2] /= altitudeLength

	const dot = Math.max(-1, Math.min(1, vecDot(target, current)))
	const sin = Math.sin(total)
	const scale = total < 1e-6 ? 1 + (total * total) / 6 : total / sin
	const tangentX = scale * (current[0] - dot * target[0])
	const tangentY = scale * (current[1] - dot * target[1])
	const tangentZ = scale * (current[2] - dot * target[2])
	const azimuth = tangentX * azimuthTangent[0] + tangentY * azimuthTangent[1] + tangentZ * azimuthTangent[2]
	const altitude = tangentX * altitudeTangent[0] + tangentY * altitudeTangent[1] + tangentZ * altitudeTangent[2]

	if (!Number.isFinite(azimuth) || !Number.isFinite(altitude)) return undefined
	return { total, azimuth, altitude }
}

// https://sourceforge.net/p/sky-simulator/code/ci/default/tree/sky_annotation.pas#l1189
// Polar error calculation based on two celestial reference points and the error of the telescope mount at these point(s).
// Based on formulas from Ralph Pass documented at https://rppass.com/align.pdf.
// They are based on the book "Telescope Control" by Trueblood and Genet, p.111
// Ralph added sin(latitude) term in the equation for the error in RA.
//
// Expressed through the shared TPoint model in `astronomy/coordinates/pointing`, which carries the
// same terms and clamps the declination away from the pole, where tan diverges and the hour-angle
// error would otherwise come back meaningless.
export function polarAlignmentError(rightAscension: Angle, declination: Angle, latitude: Angle, lst: Angle, azimuthError: Angle, altitudeError: Angle): readonly [Angle, Angle] {
	return applyEquatorialPointingError(rightAscension, declination, lst, polarAlignmentPointingModel(azimuthError, altitudeError, latitude))
}

// Builds the two mechanical correction axes in ICRF for the given instant/location:
// azimuth knob rotates around local "up", altitude knob around local east-west.
// This was needed because the previous approach inferred a generic 3D rotation from one star vector,
// which is underconstrained and produced systematic azimuth drift after adjustments.
export function mountAdjustmentAxes(time: Time, { longitude, latitude }: GeographicPosition) {
	const cosLat = Math.cos(latitude)
	const sinLat = Math.sin(latitude)
	const cosLon = Math.cos(longitude)
	const sinLon = Math.sin(longitude)

	const upItrs: Vec3 = [cosLat * cosLon, cosLat * sinLon, sinLat]
	const eastItrs: Vec3 = [-sinLon, cosLon, 0]
	const gcrsToItrs = gcrsToItrsRotationMatrix(time)
	const upAxis = vecNormalizeMut(matTransposeMulVec(gcrsToItrs, upItrs))
	const eastAxis = vecNormalizeMut(matTransposeMulVec(gcrsToItrs, eastItrs))

	return { upAxis, eastAxis } as const
}

// Estimates knob deltas (azimuth/altitude) that best explain the observed star displacement.
// We solve a 2x2 least-squares system in the tangent space, constrained to mount mechanics,
// instead of applying an unconstrained Rodrigues rotation from "from -> to".
export function solveAzAltAdjustment(from: Vec3, to: Vec3, upAxis: Vec3, eastAxis: Vec3) {
	// Small-angle least squares in the tangent space around fromVec:
	// d ≈ az * (up × from) + alt * (east × from).
	const azBasis = vecCross(upAxis, from)
	const altBasis = vecCross(eastAxis, from)
	const dx = to[0] - from[0]
	const dy = to[1] - from[1]
	const dz = to[2] - from[2]
	const a11 = vecDot(azBasis, azBasis)
	const a12 = vecDot(azBasis, altBasis)
	const a22 = vecDot(altBasis, altBasis)
	const y1 = azBasis[0] * dx + azBasis[1] * dy + azBasis[2] * dz
	const y2 = altBasis[0] * dx + altBasis[1] * dy + altBasis[2] * dz
	const det = a11 * a22 - a12 * a12

	// Degenerate geometry (nearly collinear basis): keep previous pole to avoid unstable jumps.
	if (Math.abs(det) <= 1e-18) return { azimuthAdjustment: 0, altitudeAdjustment: 0 }

	const azimuthAdjustment = (y1 * a22 - y2 * a12) / det
	const altitudeAdjustment = (-y1 * a12 + y2 * a11) / det

	return { azimuthAdjustment, altitudeAdjustment } as const
}

// Direction of the timed RA motion of a polar-alignment runner: towards the west or the east horizon.
export type PolarAlignmentDirection = 'WEST' | 'EAST'

// Monotonic instants of one timed motion, in milliseconds of the clock's monotonic domain.
export interface PolarAlignmentMotionInstants {
	// The motion was started.
	readonly startedAt: number
	// The stop was sent.
	readonly stoppedAt: number
	// The mount was reported quiescent after the stop.
	readonly settledAt: number
}

// Reason the mount cannot run the timed RA motions of a polar alignment (three-point or DARV) at
// `slewRate`, 'disconnected', or undefined when it can: a connected, unparked equatorial mount that
// tracks at the sidereal rate (when it reports track modes), can move west-east and abort, and
// announces the preset.
export function polarAlignmentMountRefusal(mount: Mount, slewRate: string) {
	if (!mount.connected) return 'disconnected'
	if (mount.mountType === 'ALTAZ') return `mount ${mount.name} is not equatorial`
	if (!mount.canMove || !mount.canMoveWE) return `mount ${mount.name} cannot move west-east`
	if (!mount.canAbort) return `mount ${mount.name} cannot abort a motion`
	if (mount.parked || mount.parking) return `mount ${mount.name} is parked`
	if (!mount.tracking) return `mount ${mount.name} is not tracking`
	if (mount.trackModes.length > 0 && mount.trackMode !== 'SIDEREAL') return `mount ${mount.name} is not tracking at the sidereal rate`
	if (!mount.slewRates.some((e) => e.name === slewRate)) return `mount ${mount.name} has no slew rate ${slewRate}`
	return undefined
}

// Moves the mount in `direction` for `duration` seconds, then stops it and waits until it is
// quiescent; the stop is sent even when the wait is cancelled. `onStarted` receives the monotonic
// instant the motion started. Resolves the instants of the motion or the first failure.
export async function polarAlignmentTimedMotion(context: OperationContext, mountCommander: MountCommander, mount: Mount, direction: PolarAlignmentDirection, duration: number, clock: CenteringClock, onStarted?: (at: number) => void): Promise<OperationResult<PolarAlignmentMotionInstants>> {
	const started = await mountCommander.startManualMove(context, mount, direction)
	if (!started.ok) return started
	const startedAt = clock.monotonicNow()
	onStarted?.(startedAt)

	let waited: OperationResult<void> = failedOperationResult('unexpectedState', 'the motion wait did not settle')
	let stoppedAt = startedAt

	try {
		waited = await clock.delay(duration * 1000, context.signal)
	} finally {
		stoppedAt = clock.monotonicNow()
		const stopped = await started.value.stop()
		if (waited.ok) waited = stopped
	}

	if (!waited.ok) return waited
	return successfulOperationResult({ startedAt, stoppedAt, settledAt: clock.monotonicNow() })
}

// Rejects degenerate mount-adjustment geometry. A zero axis would make the Rodrigues rotations
// undefined, and non-orthogonal axes would silently mix azimuth and altitude into a plausible-looking
// but mechanically wrong polar correction.
function validateAdjustmentGeometry(vector: Vec3, upAxis: Vec3, eastAxis: Vec3): void {
	const vectorLength = vecLength(vector)
	const upLength = vecLength(upAxis)
	const eastLength = vecLength(eastAxis)
	if (!Number.isFinite(vectorLength) || !Number.isFinite(upLength) || !Number.isFinite(eastLength) || !(vectorLength > VECTOR_EPSILON) || !(upLength > VECTOR_EPSILON) || !(eastLength > VECTOR_EPSILON)) throw new RangeError('polar-alignment vectors and axes must be finite and non-zero')
	const normalizedDot = vecDot(upAxis, eastAxis) / (upLength * eastLength)
	if (!Number.isFinite(normalizedDot) || !(Math.abs(normalizedDot) <= AXIS_ORTHOGONALITY_TOLERANCE)) throw new RangeError('mount adjustment axes must be orthogonal')
}

// Reports whether a vector is finite and has a numerically meaningful direction.
function isFiniteNonZeroVector(vector: Vec3): boolean {
	const length = vecLength(vector)
	return Number.isFinite(vector[0]) && Number.isFinite(vector[1]) && Number.isFinite(vector[2]) && Number.isFinite(length) && length > VECTOR_EPSILON
}
