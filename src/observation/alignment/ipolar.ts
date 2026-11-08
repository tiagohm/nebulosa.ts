import type { Parity, PlateSolution } from '../../astrometry/solvers/platesolver'
import { eraS2c } from '../../astronomy/coordinates/erfa/erfa'
import { type Time, Timescale, timeSubtract } from '../../astronomy/time/time'
import { DAYSEC } from '../../core/constants'
import { matMulVec, matToVec3, matTranspose } from '../../math/linear-algebra/mat3'
import { fitRotation, type RotationFit } from '../../math/linear-algebra/rotation.fit'
import { type Vec3, vecAngle, vecDot, vecLength } from '../../math/linear-algebra/vec3'
import { type Angle, arcsec, deg } from '../../math/units/angle'
import { type IPolarError, ipolarEarthFixedRays, ipolarError, ipolarFrameContext, type IPolarObserver, ipolarProject, type IPolarProjection, ipolarTargetPole } from './ipolar.geometry'

// Camera-based (iPolar) polar alignment from plate solutions, modelled as one rigid rotation of the
// camera about the mechanical RA axis in the Earth-fixed frame. Calibration takes two solved frames
// of a camera rigid with the RA axis, separated by an RA-only rotation; each frame's sample rays
// are taken to ITRS at its own mid-exposure instant (see ipolar.geometry), and the proper rotation
// fitted between them gives the mechanical axis and the rotation actually achieved, so the frames
// need not overlap and the axis need not fall inside the image. The axis is stored in the sensor
// frame of the first frame, so every later frame of the same sensor geometry yields the current
// axis from its own attitude alone: adjusting the mount base moves it, rotating in RA does not.
// Hard quality gates reject frames rather than report a doubtful error; the convergence streak is
// reversible. Two poses cannot prove the motion was pure RA: a small mixed RA/DEC motion tilts the
// axis undetected. Angles are radians, times are `Time` instants with intervals in seconds, and
// pixels are FITS 1-based. Results are fresh immutable values.

// Sensor geometry a frame was read out with; two frames are comparable only when equal.
export interface IPolarSensorGeometry {
	// Image width, in pixels of the frame.
	readonly width: number
	// Image height, in pixels of the frame.
	readonly height: number
	// Horizontal binning factor.
	readonly binX: number
	// Vertical binning factor.
	readonly binY: number
	// Left edge of the subframe, in unbinned sensor pixels.
	readonly x: number
	// Top edge of the subframe, in unbinned sensor pixels.
	readonly y: number
}

// One solved exposure of the calibrated camera.
export interface IPolarFrame {
	// Mid-exposure instant; its scale may be any the toolkit converts.
	readonly time: Time
	// Plate solution of exactly this exposure, with its image dimensions.
	readonly solution: PlateSolution
	// Sensor geometry the exposure was read out with.
	readonly sensor: IPolarSensorGeometry
}

// Quality gates of the calibration and the measurements; all are hard rejections.
export interface IPolarLimits {
	// Smallest fitted RA rotation accepted between the calibration frames, in radians.
	readonly minimumRotation: Angle
	// Largest fitted RA rotation accepted between the calibration frames, in radians, below π.
	readonly maximumRotation: Angle
	// Fitted rotations reported as preferred in the quality, in radians: [minimum, maximum].
	readonly preferredRotation: readonly [Angle, Angle]
	// Largest angle between the mechanical axis and the target pole, in radians: the rough
	// alignment envelope beyond which the axis is a wrong rotation, not a large polar error.
	readonly maximumAxisOffset: Angle
	// Largest angle between a fitted and an observed sample ray, in pixels of the plate scale.
	readonly maximumResidual: number
	// Smallest half-diagonal field radius of a usable plate solution, in radians.
	readonly minimumFieldRadius: Angle
	// Smallest conditioning of a rotation fit (see RotationFit), in [0, 1].
	readonly minimumConditioning: number
	// Longest interval between the calibration frames, in seconds.
	readonly maximumCalibrationInterval: number
	// Largest change of the mechanical axis between consecutive measurements, in radians; more is a
	// DEC, rotator or camera motion, not an adjustment of the base.
	readonly maximumAxisJump: Angle
	// Largest change of the field center between consecutive measurements, in radians; more is a
	// slew of the mount.
	readonly maximumShift: Angle
}

// Default quality gates. The preferred rotation of 20° to 40° and the 10° minimum keep the axis
// conditioned against ordinary plate-solution noise (its error grows as 1/sin(θ/2)); 60° bounds the
// travel a camera usually clears. A 5° envelope covers a rough alignment by eye, and 2 px of fit
// residual allows for ordinary SIP differences between two solutions of one optical train.
export const DEFAULT_IPOLAR_LIMITS: Readonly<IPolarLimits> = {
	minimumRotation: deg(10),
	maximumRotation: deg(60),
	preferredRotation: [deg(20), deg(40)],
	maximumAxisOffset: deg(5),
	maximumResidual: 2,
	minimumFieldRadius: deg(0.1),
	minimumConditioning: 1e-9,
	maximumCalibrationInterval: 3600,
	maximumAxisJump: deg(3),
	maximumShift: deg(5),
}

// Why a calibration or a measurement was rejected:
// - inconsistentSensor: the calibration frames differ in sensor geometry, dimensions or parity;
// - badTime: an instant is not after the previous one, or the calibration took too long;
// - badWcs: a sample pixel of a solution cannot be mapped to a finite direction;
// - poorConditioning: the field is too small or the fit leaves the rotation undetermined;
// - unstableFit: the frames are not related by a rigid rotation within the residual limit;
// - insufficientRotation, excessiveRotation: the fitted rotation is out of the limits;
// - wrongAxis: the axis lies outside the rough alignment envelope of the target pole;
// - geometryMismatch: the sensor geometry, parity, or the axis itself changed after calibration;
// - fieldJump: the field moved like a slew between measurements;
// - singularGeometry: the error has no altitude direction (a pole at the zenith).
export type IPolarRejection = 'inconsistentSensor' | 'badTime' | 'badWcs' | 'poorConditioning' | 'unstableFit' | 'insufficientRotation' | 'excessiveRotation' | 'wrongAxis' | 'geometryMismatch' | 'fieldJump' | 'singularGeometry'

// Factual diagnostics of a calibration attempt; a field is absent when not reached.
export interface IPolarCalibrationQuality {
	// Fitted rotation between the frames, in radians, [0, π].
	readonly rotation?: Angle
	// Root-mean-square angular residual of the fit, in radians.
	readonly residual?: Angle
	// Largest angular residual of the fit, in radians.
	readonly maximumResidual?: Angle
	// Conditioning of the fit, in [0, 1].
	readonly conditioning?: number
	// Angle between the mechanical axis and the target pole, in radians.
	readonly axisOffset?: Angle
	// Interval between the frames, in seconds.
	readonly interval?: number
	// Whether the rotation lies in the preferred range.
	readonly preferred?: boolean
}

// An accepted calibration: the mechanical axis in the sensor frame of its first frame.
export interface IPolarCalibration {
	// Earth-fixed sample rays of the first frame, which define the sensor frame (ITRS at that
	// instant), in sample-grid order.
	readonly reference: readonly Vec3[]
	// Unit mechanical RA axis in the sensor frame, oriented towards the target pole.
	readonly axis: Vec3
	// Sensor geometry every later frame must match.
	readonly sensor: IPolarSensorGeometry
	// Image parity every later frame must match.
	readonly parity: Parity
	// Site and atmosphere of the calibration, used by every measurement.
	readonly observer: IPolarObserver
	// Mid-exposure instant of the first frame.
	readonly time: Time
	// Diagnostics of the accepted fit; every field is present.
	readonly quality: Required<IPolarCalibrationQuality>
}

// Outcome of a calibration attempt.
export type IPolarCalibrationResult = { readonly accepted: true; readonly calibration: IPolarCalibration } | { readonly accepted: false; readonly reason: IPolarRejection; readonly quality: IPolarCalibrationQuality }

// A measurement of the polar error on one frame.
export interface IPolarAcceptedMeasurement {
	readonly valid: true
	// Mid-exposure instant of the frame.
	readonly time: Time
	// Signed error from the target pole to the mechanical axis.
	readonly error: IPolarError
	// Unit mechanical RA axis, in ITRS.
	readonly axis: Vec3
	// Unit target pole, in ITRS.
	readonly target: Vec3
	// Largest angular residual of the frame's attitude fit, in radians.
	readonly residual: Angle
	// The mechanical axis in the frame's pixels.
	readonly axisPoint: IPolarProjection
	// The target pole in the frame's pixels.
	readonly polePoint: IPolarProjection
	// ICRS unit direction of the field center, used to detect slews.
	readonly center: Vec3
}

// A frame that gave no measurement; when `invalidatesCalibration`, the camera geometry no longer
// matches the calibration and only a new calibration can measure again.
export interface IPolarRejectedMeasurement {
	readonly valid: false
	// Mid-exposure instant of the frame.
	readonly time: Time
	// Why the frame was rejected.
	readonly reason: IPolarRejection
	// Whether the calibration can no longer be used.
	readonly invalidatesCalibration: boolean
}

// Outcome of measuring one frame.
export type IPolarMeasurement = IPolarAcceptedMeasurement | IPolarRejectedMeasurement

// Settings of the convergence streak.
export interface IPolarConvergenceOptions {
	// Largest total error of a converging measurement, in radians: a requested target, not a
	// statement of measurement accuracy.
	readonly threshold: Angle
	// Consecutive converging measurements that make the alignment converged, at least 1.
	readonly count: number
	// Longest interval between consecutive measurements of a streak, in seconds.
	readonly maximumInterval: number
}

// Default convergence: three consecutive fresh measurements within 30″, at most 5 min apart.
export const DEFAULT_IPOLAR_CONVERGENCE: Readonly<IPolarConvergenceOptions> = {
	threshold: arcsec(30),
	count: 3,
	maximumInterval: 300,
}

// State of the convergence streak.
export interface IPolarConvergence {
	// Consecutive accepted measurements within the threshold, ending with the latest one.
	readonly streak: number
	// Whether the streak reached the required count.
	readonly converged: boolean
	// Instant of the latest accepted measurement, absent after a rejection.
	readonly last?: Time
}

// Convergence before any measurement.
export const IPOLAR_CONVERGENCE_START: IPolarConvergence = { streak: 0, converged: false }

// Calibrates the mechanical RA axis from two frames of one rigid camera separated by an RA rotation
// of the mount. Returns the calibration, or the first failed gate of `limits` with the diagnostics
// gathered so far. `observer` is the site and atmosphere of every later measurement.
export function calibrateIPolar(first: IPolarFrame, second: IPolarFrame, observer: IPolarObserver, limits: Readonly<IPolarLimits> = DEFAULT_IPOLAR_LIMITS): IPolarCalibrationResult {
	if (!sameSensor(first.sensor, second.sensor) || !matchesSensor(first) || !matchesSensor(second) || first.solution.parity !== second.solution.parity) return rejected('inconsistentSensor', {})

	const interval = secondsBetween(first.time, second.time)
	if (!(interval > 0 && interval <= limits.maximumCalibrationInterval)) return rejected('badTime', { interval })
	if (!(first.solution.radius >= limits.minimumFieldRadius && second.solution.radius >= limits.minimumFieldRadius)) return rejected('poorConditioning', { interval })

	const firstContext = ipolarFrameContext(first.time, observer)
	const secondContext = ipolarFrameContext(second.time, observer)
	const reference = ipolarEarthFixedRays(first.solution, firstContext)
	const rays = ipolarEarthFixedRays(second.solution, secondContext)
	if (reference === undefined || rays === undefined) return rejected('badWcs', { interval })

	const fit = fitRotation(reference, rays)
	if (fit === undefined || !(fit.conditioning >= limits.minimumConditioning)) return rejected('poorConditioning', { interval, conditioning: fit?.conditioning })

	const quality = { interval, residual: fit.residual, maximumResidual: fit.maximumResidual, conditioning: fit.conditioning }
	if (!residualAccepted(fit, first.solution, second.solution, limits)) return rejected('unstableFit', quality)

	// matToVec3 works in the frame-rotation sense, so the transpose gives the active axis × angle.
	const vector = matToVec3(matTranspose(fit.rotation))
	const rotation = vecLength(vector)
	const preferred = rotation >= limits.preferredRotation[0] && rotation <= limits.preferredRotation[1]
	if (!(rotation >= limits.minimumRotation)) return rejected('insufficientRotation', { ...quality, rotation, preferred })
	if (!(rotation <= limits.maximumRotation)) return rejected('excessiveRotation', { ...quality, rotation, preferred })

	const target = ipolarTargetPole(second.time, observer, secondContext)
	const sign = vecDot(vector, target) >= 0 ? 1 : -1
	const axis: Vec3 = [(sign * vector[0]) / rotation, (sign * vector[1]) / rotation, (sign * vector[2]) / rotation]
	const axisOffset = vecAngle(axis, target)
	if (!(axisOffset <= limits.maximumAxisOffset)) return rejected('wrongAxis', { ...quality, rotation, preferred, axisOffset })

	return {
		accepted: true,
		calibration: { reference, axis, sensor: first.sensor, parity: first.solution.parity, observer, time: first.time, quality: { ...quality, rotation, preferred, axisOffset } },
	}
}

// Measures the polar error on `frame` with `calibration`: the frame's attitude from its own WCS
// carries the calibrated axis to the frame's instant, compared with the target pole there.
// `previous` is the latest accepted measurement, against which time order, axis jumps and slews are
// checked. Returns the measurement or why the frame was rejected.
export function measureIPolar(calibration: IPolarCalibration, frame: IPolarFrame, previous?: IPolarAcceptedMeasurement, limits: Readonly<IPolarLimits> = DEFAULT_IPOLAR_LIMITS): IPolarMeasurement {
	const { time, solution } = frame
	if (!sameSensor(calibration.sensor, frame.sensor) || !matchesSensor(frame) || solution.parity !== calibration.parity) return { valid: false, time, reason: 'geometryMismatch', invalidatesCalibration: true }
	if (!(secondsBetween(previous?.time ?? calibration.time, time) > 0)) return refused(time, 'badTime')
	if (!(solution.radius >= limits.minimumFieldRadius)) return refused(time, 'poorConditioning')

	const context = ipolarFrameContext(time, calibration.observer)
	const rays = ipolarEarthFixedRays(solution, context)
	if (rays === undefined) return refused(time, 'badWcs')

	const fit = fitRotation(calibration.reference, rays)
	if (fit === undefined || !(fit.conditioning >= limits.minimumConditioning)) return refused(time, 'poorConditioning')
	if (!residualAccepted(fit, solution, solution, limits)) return refused(time, 'unstableFit')

	const center = eraS2c(solution.rightAscension, solution.declination)
	if (previous !== undefined && !(vecAngle(previous.center, center) <= limits.maximumShift)) return { valid: false, time, reason: 'fieldJump', invalidatesCalibration: true }

	const axis = matMulVec(fit.rotation, calibration.axis)
	if (previous !== undefined && !(vecAngle(previous.axis, axis) <= limits.maximumAxisJump)) return { valid: false, time, reason: 'geometryMismatch', invalidatesCalibration: true }

	const target = ipolarTargetPole(time, calibration.observer, context)
	if (!(vecAngle(axis, target) <= limits.maximumAxisOffset)) return { valid: false, time, reason: 'wrongAxis', invalidatesCalibration: true }

	const error = ipolarError(axis, target, context)
	if (error === undefined) return refused(time, 'singularGeometry')

	return { valid: true, time, error, axis, target, residual: fit.maximumResidual, axisPoint: ipolarProject(axis, solution, context), polePoint: ipolarProject(target, solution, context), center }
}

// Advances the convergence streak with `measurement`: a rejection clears it, an error above the
// threshold or a gap longer than the maximum interval restarts it, and the alignment is converged
// while the streak holds at least `count` measurements. Returns a fresh state.
export function advanceIPolarConvergence(state: IPolarConvergence, measurement: IPolarMeasurement, options: Readonly<IPolarConvergenceOptions> = DEFAULT_IPOLAR_CONVERGENCE): IPolarConvergence {
	if (!measurement.valid) return IPOLAR_CONVERGENCE_START
	if (!(measurement.error.total <= options.threshold)) return { streak: 0, converged: false, last: measurement.time }

	const continued = state.streak > 0 && state.last !== undefined && secondsBetween(state.last, measurement.time) <= options.maximumInterval
	const streak = continued ? state.streak + 1 : 1
	return { streak, converged: streak >= options.count, last: measurement.time }
}

// Seconds from `from` to `to` on the TT scale, which has no leap seconds.
function secondsBetween(from: Time, to: Time) {
	return timeSubtract(to, from, Timescale.TT) * DAYSEC
}

// Whether two sensor geometries are the same readout.
function sameSensor(a: IPolarSensorGeometry, b: IPolarSensorGeometry) {
	return a.width === b.width && a.height === b.height && a.binX === b.binX && a.binY === b.binY && a.x === b.x && a.y === b.y
}

// Whether the frame's plate solution has the dimensions of its sensor geometry.
function matchesSensor({ solution, sensor }: IPolarFrame) {
	return solution.widthInPixels === sensor.width && solution.heightInPixels === sensor.height
}

// Whether the largest residual of `fit` stays within the limit, in pixels of the coarser scale.
function residualAccepted(fit: RotationFit, a: PlateSolution, b: PlateSolution, limits: Readonly<IPolarLimits>) {
	return fit.maximumResidual <= limits.maximumResidual * Math.max(a.scale, b.scale)
}

// A rejected calibration with its diagnostics.
function rejected(reason: IPolarRejection, quality: IPolarCalibrationQuality): IPolarCalibrationResult {
	return { accepted: false, reason, quality }
}

// A rejected measurement that leaves the calibration usable.
function refused(time: Time, reason: IPolarRejection): IPolarRejectedMeasurement {
	return { valid: false, time, reason, invalidatesCalibration: false }
}
