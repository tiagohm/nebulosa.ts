import { type EquatorialCoordinate, equatorialToHorizontal, horizontalToEquatorial } from '../../astronomy/coordinates/coordinate'
import { eraC2s, eraS2c } from '../../astronomy/coordinates/erfa/erfa'
import { enuVectorToHorizontal, horizontalToEnuVector } from '../../astronomy/coordinates/frame.local'
import { localSiderealTime } from '../../astronomy/observer/location'
import type { Time } from '../../astronomy/time/time'
import type { PierSide } from '../../devices/indi/device'
import type { Vec3 } from '../../math/linear-algebra/vec3'
import { sphericalUnprojectTangentPlane } from '../../math/numerical/geometry'
import type { Angle } from '../../math/units/angle'
import { applyDirectionAlignment, type DirectionAlignmentResult } from './alignment'
import { mountDirectionFromEncoders, type MountEncoderPosition, type MountEncoderSolution, type MountEncoderSolveOptions, solveMountEncoders, type TwoAxisMountGeometry } from './kinematics'
import { type CorrectionResult, correctPointingCoordinate, type FittedPointingModel, type PointingCorrectionOptions, type PredictedPointingError, predictPointingModelError } from './pointing'
import type { PointingFrame } from './pointing.basis'

// Composes the three mount layers into the two conversions an application actually performs: sky
// position to encoder counts and back. Nothing here computes geometry; it wires the rigid base
// alignment (`alignment.ts`), the two-axis kinematics (`kinematics.ts`) and the residual pointing
// error model (`pointing.ts`) in the order that keeps each one's contract intact.
//
// Angles are radians throughout. The pointing model's convention is `error = solved - target`, where
// `target` is the coordinate the ideal kinematics was commanded to and `solved` is where the mount
// really ends up, so the forward direction subtracts the error and the reverse direction adds it.

// Frame in which the mount geometry and the fitted alignment express their world directions.
//
// `fitMountAlignment` builds its world directions from azimuth/altitude through `horizontalToEnuVector`,
// so a chain calibrated that way is `horizontalEnu`. Use `equatorial` only when the alignment was fitted
// with `fitDirectionAlignment` against equatorial unit vectors.
export type MountWorldFrame = 'horizontalEnu' | 'equatorial'

// The full pointing chain of one mount: rigid base orientation, axis geometry and residual error model.
export interface MountPointingChain {
	// Zero-state axis geometry. Its `baseToWorld` rotation is replaced by the alignment, so only its
	// translation survives; express the axes in the mount base frame at encoder zero.
	readonly geometry: TwoAxisMountGeometry
	// Fitted mount-base to world rotation.
	readonly alignment: DirectionAlignmentResult
	// Residual pointing model. Without it the chain is purely kinematic and no correction is applied.
	readonly model?: FittedPointingModel
	// World frame of `alignment` and `geometry`. Defaults to `horizontalEnu`.
	readonly worldFrame?: MountWorldFrame
}

// Observing state needed to relate a celestial coordinate to the local horizon and to the model basis.
export interface MountObservingContext {
	// Observation time, required for the `horizontalEnu` frame and for hour-angle dependent model terms.
	readonly time?: Time
	// Site geodetic latitude (radians).
	readonly latitude?: Angle
	// Site longitude (radians, positive east).
	readonly longitude?: Angle
	// Mount pier side, forwarded to the pointing model.
	readonly pierSide?: PierSide
	// Frame the celestial coordinates are expressed in. Forwarded to the pointing model, which warns
	// when it differs from the frame it was fitted in.
	readonly frame?: PointingFrame
}

// Numerical controls for the whole forward conversion.
export interface MountPointingSolveOptions extends MountEncoderSolveOptions {
	// Overrides for the iterative command inversion performed by the pointing model.
	readonly correction?: PointingCorrectionOptions
}

// Encoder solution plus the pointing correction that produced the direction it was solved for.
export interface MountEncoderTarget extends MountEncoderSolution {
	// Commanded coordinate and inversion diagnostics. Check `clamped` and `converged` before slewing:
	// a truncated correction means the model was extrapolating well outside its training coverage.
	readonly correction: CorrectionResult
}

// Celestial position a set of encoder counts corresponds to, before and after the residual error.
export interface MountCelestialPosition extends Readonly<EquatorialCoordinate> {
	// Coordinate the ideal kinematics reads from the encoders, before the residual error is added.
	readonly commanded: Readonly<EquatorialCoordinate>
	// Residual error predicted at `commanded` and added to obtain the returned coordinate.
	readonly predictedError: PredictedPointingError
}

// Converts a desired celestial position into the encoder counts that will actually reach it.
//
// Order matters: the residual error is inverted first, in the sky frame where it was fitted, and only
// the resulting command is handed to the kinematics. Correcting after the inverse kinematics would
// apply a sky-frame offset to encoder angles, which is not the same rotation away from the pole.
//
// `input` is where the telescope should end up. Returns the encoder solution together with the
// correction, so a caller can refuse to slew on a clamped or unconverged inversion.
export function celestialToEncoders(chain: Readonly<MountPointingChain>, input: Readonly<EquatorialCoordinate & MountObservingContext>, options: Readonly<MountPointingSolveOptions> = {}): MountEncoderTarget {
	const correction = chain.model ? correctPointingCoordinate(chain.model, input, options.correction) : identityCorrection(input)
	const direction = celestialToWorldDirection(chain.worldFrame ?? 'horizontalEnu', correction.rightAscension, correction.declination, input)
	const solution = solveMountEncoders(applyDirectionAlignment(chain.geometry, chain.alignment), direction, options)
	return { ...solution, correction }
}

// Converts encoder counts into the celestial position the telescope is really looking at.
//
// The kinematics yields the commanded direction, which is the model's `target`; the mount then suffers
// `error(target)` on top of it. This is the exact inverse of `celestialToEncoders`, so feeding one into
// the other returns the original coordinate to the tolerance of both solvers.
export function encodersToCelestial(chain: Readonly<MountPointingChain>, encoders: Readonly<MountEncoderPosition>, context: Readonly<MountObservingContext> = {}): MountCelestialPosition {
	const direction = mountDirectionFromEncoders(applyDirectionAlignment(chain.geometry, chain.alignment), encoders)
	const commanded = worldDirectionToCelestial(chain.worldFrame ?? 'horizontalEnu', direction, context)

	if (!chain.model) {
		return { ...commanded, commanded, predictedError: zeroPredictedError() }
	}

	const predictedError = predictPointingModelError(chain.model, { ...context, ...commanded })
	const [rightAscension, declination] = eraC2s(...sphericalOffset(commanded, predictedError.dx, predictedError.dy))
	return { rightAscension, declination, commanded, predictedError }
}

// Projects a celestial coordinate into the chain's world frame as a unit direction.
//
// The `horizontalEnu` frame needs the full observing context: without time, latitude and longitude
// there is no horizon to refer the direction to, and silently falling back to the equatorial frame
// would rotate every command by the site colatitude.
function celestialToWorldDirection(frame: MountWorldFrame, rightAscension: Angle, declination: Angle, context: Readonly<MountObservingContext>): Vec3 {
	if (frame === 'equatorial') return eraS2c(rightAscension, declination)

	const { time, latitude, longitude } = context

	if (time === undefined || latitude === undefined || longitude === undefined) {
		throw new Error('the horizontalEnu world frame requires time, latitude and longitude')
	}

	const [azimuth, altitude] = equatorialToHorizontal(rightAscension, declination, latitude, localSiderealTime(time, longitude, true))
	return horizontalToEnuVector(azimuth, altitude)
}

// Turns a world-frame unit direction back into a celestial coordinate, inverting `celestialToWorldDirection`.
function worldDirectionToCelestial(frame: MountWorldFrame, direction: Vec3, context: Readonly<MountObservingContext>): Readonly<EquatorialCoordinate> {
	if (frame === 'equatorial') {
		const [rightAscension, declination] = eraC2s(...direction)
		return { rightAscension, declination }
	}

	const { time, latitude, longitude } = context

	if (time === undefined || latitude === undefined || longitude === undefined) {
		throw new Error('the horizontalEnu world frame requires time, latitude and longitude')
	}

	const horizontal = enuVectorToHorizontal(direction)
	const [rightAscension, declination] = horizontalToEquatorial(horizontal.azimuth, horizontal.altitude, latitude, localSiderealTime(time, longitude, true))
	return { rightAscension, declination }
}

// Applies a tangent-plane offset (radians, east-positive and north-positive) around a coordinate.
function sphericalOffset(coordinate: Readonly<EquatorialCoordinate>, dx: number, dy: number) {
	return sphericalUnprojectTangentPlane(dx, dy, eraS2c(coordinate.rightAscension, coordinate.declination))
}

// Correction returned when the chain carries no model: the command is the target, exactly.
function identityCorrection(input: Readonly<EquatorialCoordinate>): CorrectionResult {
	return { rightAscension: input.rightAscension, declination: input.declination, predictedError: zeroPredictedError(), converged: true, iterations: 0, residual: 0, clamped: false }
}

// Zero-error prediction used on the purely kinematic path, where no model exists to consult.
function zeroPredictedError(): PredictedPointingError {
	return {
		dx: 0,
		dy: 0,
		offsetMagnitude: 0,
		representationUsed: 'vectorTangent',
		quality: { nearestSampleDistance: Number.POSITIVE_INFINITY, kthNeighborDistance: Number.POSITIVE_INFINITY, support: 0, extrapolating: true, pierSideCovered: false, warnings: ['the pointing chain carries no fitted model'] },
		components: {},
	}
}
