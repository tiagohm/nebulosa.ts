import { unlink } from 'fs/promises'
import type { PlateSolution } from '../../astrometry/solvers/platesolver'
import { DEFAULT_REFRACTION_PARAMETERS, type RefractionParameters } from '../../astronomy/coordinates/astrometry'
import { angularDistance } from '../../astronomy/coordinates/coordinate'
import type { GeographicPosition } from '../../astronomy/observer/location'
import { Timescale, timeSubtract, timeUnix } from '../../astronomy/time/time'
import { DAYSEC, SIDEREAL_DRIFT_RATE } from '../../core/constants'
import type { MountCommander } from '../../devices/commanders/mount'
import type { Camera, Mount, PierSide } from '../../devices/indi/device'
import { failedOperationResult, type OperationContext, type OperationResult, type OperationScope, successfulOperationResult } from '../../devices/orchestration/operation'
import { awaitCooperativeJob, type CooperativeJobHealth } from '../../devices/orchestration/operation.wait'
import { type Angle, toDeg } from '../../math/units/angle'
import type { CameraCapturer } from '../capture/capture'
import type { CameraCaptureListener } from '../capture/reporter'
import { type CenteringCaptureOptions, type CenteringClock, centeringCaptureRequest, exposureMidpoint, solveResult } from '../mount/centering'
import { type PolarAlignmentDirection, polarAlignmentMountRefusal, polarAlignmentTimedMotion } from './polaralignment'
import { ThreePointPolarAlignment, type ThreePointPolarAlignmentInput, type ThreePointPolarAlignmentResult } from './tppa'
import {
	classifyPolarAlignmentCandidate,
	DEFAULT_POLAR_ALIGNMENT_GEOMETRY_LIMITS,
	type PolarAlignmentCandidateClassification,
	type PolarAlignmentGeometryLimits,
	type PolarAlignmentGeometryQuality,
	polarAlignmentDisplacement,
	polarAlignmentEarthFixedVector,
	polarAlignmentGeometryQuality,
	polarAlignmentPolarDistance,
} from './tppa.geometry'

// Automatic acquisition and refinement of a three-point polar alignment, reusable outside the
// application: the runner rotates the mount in RA with timed manual motions at a chosen slew-rate
// preset, captures one auxiliary FITS per pose, solves it through a caller-provided solver, and
// accepts a pose only once the solved rotation since the previous accepted pose reaches the geometry
// limits; the duration of each motion is estimated from the rotation observed per second of motion,
// but never trusted in place of the measurement. After three accepted poses the geometry is checked
// as a whole before seeding `ThreePointPolarAlignment`. Refinement only captures and solves; it never
// commands the mount.
//
// The runner leases nothing itself: the commander and the capturer lease the mount and the camera
// per command, so a caller that holds both in its own operation runs every step as a nested scope.
// It changes the slew rate and reports the preset it replaced through its listener, but never
// restores it, because a cancelled operation commands nothing more; the caller restores it once the
// devices are free. Angles are radians, configured durations seconds, wall instants Unix ms.

// Acquisition settings; every duration is in seconds.
export interface ThreePointPolarAlignmentAcquisitionOptions {
	// Direction of every RA motion.
	readonly direction: PolarAlignmentDirection
	// Name of the slew-rate preset of the motions; one the mount announces.
	readonly slewRate: string
	// Camera settings of the auxiliary frames.
	readonly capture: CenteringCaptureOptions
	// Wait after the mount stopped and before the next exposure; finite ≥ 0.
	readonly settle: number
	// Duration of the first motion, before any rotation rate is known; finite > 0.
	readonly initialMotion: number
	// Longest single motion; finite ≥ `initialMotion`.
	readonly maximumMotion: number
	// Captures allowed while looking for the second and for the third pose, each; safe integer ≥ 1.
	readonly maximumAttempts: number
	// Cooperative timeout of one solve; finite > 0.
	readonly solveTimeout: number
	// Watchdog after an aborted solve before the solver is reported unresponsive; finite > 0.
	readonly abortGrace: number
	// Geometry limits; defaults to `DEFAULT_POLAR_ALIGNMENT_GEOMETRY_LIMITS`.
	readonly limits?: Readonly<PolarAlignmentGeometryLimits>
	// Atmospheric model of the reported errors, or false for the geometric pole. Default atmosphere.
	readonly refraction?: RefractionParameters | false
	// Disposition of each auxiliary frame once its solve ended. Default 'delete'.
	readonly auxiliary?: 'delete' | 'keep'
}

// Refinement settings; every duration is in seconds.
export interface ThreePointPolarAlignmentRefinementOptions {
	// Camera settings of the auxiliary frames.
	readonly capture: CenteringCaptureOptions
	// Wait before each refinement exposure; finite ≥ 0.
	readonly delay: number
	// Consecutive frames without a solution tolerated before the refinement fails; safe integer ≥ 0.
	readonly maximumFailures: number
	// Largest great-circle shift of the ICRF center between consecutive refinement solves, in radians,
	// beyond which the mount is considered to have slewed and the estimate invalidated; finite > 0.
	readonly maximumShift: Angle
	// Cooperative timeout of one solve; finite > 0.
	readonly solveTimeout: number
	// Watchdog after an aborted solve before the solver is reported unresponsive; finite > 0.
	readonly abortGrace: number
	// Disposition of each auxiliary frame once its solve ended. Default 'delete'.
	readonly auxiliary?: 'delete' | 'keep'
}

// Stage an auxiliary frame belongs to.
export type ThreePointPolarAlignmentStage = 'acquisition' | 'refinement'

// Frame handed to the solver: a complete FITS file on disk and where it belongs in the session.
export interface ThreePointPolarAlignmentFrame {
	// Path of the FITS file; read-only, and left in place until the solve ended.
	readonly path: string
	// Astronomical midpoint of the exposure, in Unix ms (wall).
	readonly observedAt: number
	// Stage of the session.
	readonly stage: ThreePointPolarAlignmentStage
	// 1-based number of the frame within its stage, counting every capture.
	readonly index: number
	// Pose being acquired (1, 2 or 3) during acquisition; absent during refinement.
	readonly point?: 1 | 2 | 3
}

// Plate solver provided by the caller; same contract as `CenteringSolver`.
export type ThreePointPolarAlignmentSolver = (frame: ThreePointPolarAlignmentFrame, signal: AbortSignal) => Promise<PlateSolution | undefined>

// Synchronous progress of a run, in order of occurrence.
export type ThreePointPolarAlignmentEvent =
	| {
			readonly type: 'slewRate'
			// Preset the mount used before the run changed it, or undefined when it reported none.
			readonly previous?: string
			// Preset now applied.
			readonly applied: string
	  }
	| {
			readonly type: 'move'
			// Pose being acquired.
			readonly point: 2 | 3
			// Direction of the motion.
			readonly direction: PolarAlignmentDirection
			// Commanded duration, in seconds.
			readonly duration: number
	  }
	| {
			readonly type: 'capture'
			// Frame about to be exposed (without its midpoint, which is not known yet).
			readonly stage: ThreePointPolarAlignmentStage
			// 1-based number of the frame within its stage.
			readonly index: number
			// Pose being acquired; absent during refinement.
			readonly point?: 1 | 2 | 3
	  }
	| {
			readonly type: 'solved'
			// Frame that was solved.
			readonly frame: ThreePointPolarAlignmentFrame
			// Solution, or undefined when the frame did not solve.
			readonly solution?: PlateSolution
	  }
	| {
			readonly type: 'candidate'
			// Pose being acquired.
			readonly point: 2 | 3
			// Timestamped solve of the candidate.
			readonly sample: ThreePointPolarAlignmentInput
			// Classification against the first and the previous accepted poses.
			readonly classification: PolarAlignmentCandidateClassification
	  }
	| {
			readonly type: 'accepted'
			// Pose accepted.
			readonly point: 1 | 2 | 3
			// Timestamped solve of the pose.
			readonly sample: ThreePointPolarAlignmentInput
			// Solution of the pose.
			readonly solution: PlateSolution
	  }
	| {
			readonly type: 'geometry'
			// Conditioning of the three accepted poses.
			readonly quality: PolarAlignmentGeometryQuality
	  }
	| {
			readonly type: 'result'
			// Stage that produced the estimate.
			readonly stage: ThreePointPolarAlignmentStage
			// Current estimate, at the epoch of the last solve.
			readonly result: ThreePointPolarAlignmentResult
			// Solution of the frame the estimate belongs to.
			readonly solution: PlateSolution
			// Timestamped solve of that frame.
			readonly sample: ThreePointPolarAlignmentInput
	  }

// Services of a run.
export interface ThreePointPolarAlignmentServices {
	// Slew rate and the timed RA motions.
	readonly mountCommander: MountCommander
	// Auxiliary captures.
	readonly cameraCapturer: CameraCapturer
	// Receives the events of every auxiliary capture, such as the progress of its exposure. Absent reports nothing.
	readonly captureListener?: CameraCaptureListener
	// Plate solver of the auxiliary frames.
	readonly solver: ThreePointPolarAlignmentSolver
	// Absolute path of an auxiliary FITS; its directory exists and the file does not.
	readonly auxiliaryPath: (stage: ThreePointPolarAlignmentStage, index: number) => string
	// Clock of the midpoints, the motions, the settle and the solve timeout.
	readonly clock: CenteringClock
	// Observing site; geodetic, radians.
	readonly location: GeographicPosition
	// Progress listener, called synchronously.
	readonly listener?: (event: ThreePointPolarAlignmentEvent) => void
	// Health of the solver across runs of its owner; absent treats each run alone.
	readonly solverHealth?: CooperativeJobHealth
}

// Outcome of a successful acquisition.
export interface ThreePointPolarAlignmentAcquisition {
	// Driver of the session, seeded with the three accepted poses; feed refinement solves to it.
	readonly alignment: ThreePointPolarAlignment
	// The three accepted poses, in order.
	readonly points: readonly [ThreePointPolarAlignmentInput, ThreePointPolarAlignmentInput, ThreePointPolarAlignmentInput]
	// Conditioning of the three poses.
	readonly quality: PolarAlignmentGeometryQuality
	// Initial estimate at the epoch of the third pose.
	readonly result: ThreePointPolarAlignmentResult
	// Solution of the third pose.
	readonly solution: PlateSolution
	// Pier side observed at the start, which refinement must keep.
	readonly pierSide: PierSide
	// Captures of the acquisition, the accepted ones included.
	readonly captures: number
}

// Shortest motion commanded, in seconds; drivers ignore motions far below their update period.
const MINIMUM_MOTION = 0.2

// Rotation per motion below which the mount is considered not to have moved, in radians (0.05°).
const NO_MOTION_ROTATION = 0.05 * (Math.PI / 180)

// Growth of the motion while no rotation was measured yet. A motion that rotated less than
// NO_MOTION_ROTATION bounds the rate, so the next, PROBE_GROWTH times longer, rotates less than
// PROBE_GROWTH × NO_MOTION_ROTATION (0.2°) at the same preset, however slow it is.
const PROBE_GROWTH = 4

// Acquires the three poses of a polar alignment inside an operation `polarAlignmentAcquisition` of
// `scope`, which leases nothing itself. The mount must be a connected, unparked equatorial mount that
// tracks at the sidereal rate (when it reports track modes), can move west-east and abort, and
// announces `options.slewRate`. The preset is applied and confirmed first; then the first pose is
// captured where the mount stands, and each further pose is reached by timed motions in
// `options.direction` (a first pose near the pole is refused before any motion), every one followed by the mechanical settle, a capture and a solve that
// decides whether to accept the pose, move further, or fail. A pier-side or tracking change fails the
// run as `unexpectedState`, as does a geometry rejection that further motion cannot cure, the
// exhaustion of the attempts, or a mount that does not move. Never rejects.
export async function acquireThreePointPolarAlignment(scope: OperationScope, mount: Mount, camera: Camera, options: ThreePointPolarAlignmentAcquisitionOptions, services: ThreePointPolarAlignmentServices): Promise<OperationResult<ThreePointPolarAlignmentAcquisition>> {
	return await scope.start<ThreePointPolarAlignmentAcquisition>('polarAlignmentAcquisition', [], (context) => acquisitionLoop(context, mount, camera, options, services)).result
}

// Captures and solves refinement frames inside an operation `polarAlignmentRefinement` of `scope`
// until it is cancelled, feeding each solve to `alignment` and reporting the estimate through the
// listener as a `result` event. It never commands the mount. A frame without a solution is skipped
// until `maximumFailures` consecutive ones fail the run as `commandFailed`; a pier-side change, a
// mount that stopped tracking or slewed (a shift beyond `maximumShift`) fails it as `unexpectedState`,
// because the estimate no longer describes the mount. `from` is the last solve fed to `alignment`.
// Resolves the failure of its cancellation when cancelled. Never rejects.
export async function refineThreePointPolarAlignment(
	scope: OperationScope,
	mount: Mount,
	camera: Camera,
	alignment: ThreePointPolarAlignment,
	from: ThreePointPolarAlignmentInput,
	pierSide: PierSide,
	options: ThreePointPolarAlignmentRefinementOptions,
	services: ThreePointPolarAlignmentServices,
	firstIndex: number = 1,
): Promise<OperationResult<void>> {
	return await scope.start<void>('polarAlignmentRefinement', [], (context) => refinementLoop(context, mount, camera, alignment, from, pierSide, options, services, firstIndex)).result
}

// Acquisition inside its operation.
async function acquisitionLoop(context: OperationContext, mount: Mount, camera: Camera, options: ThreePointPolarAlignmentAcquisitionOptions, services: ThreePointPolarAlignmentServices): Promise<OperationResult<ThreePointPolarAlignmentAcquisition>> {
	const refused = polarAlignmentMountRefusal(mount, options.slewRate)
	if (refused) return failedOperationResult(refused === 'disconnected' ? 'disconnected' : 'unexpectedState', refused === 'disconnected' ? undefined : refused)

	const { mountCommander, clock, listener } = services
	const limits = options.limits ?? DEFAULT_POLAR_ALIGNMENT_GEOMETRY_LIMITS
	const pierSide = mount.pierSide
	const previous = mount.slewRate

	const applied = await mountCommander.setSlewRate(context, mount, options.slewRate)
	if (!applied.ok) return applied
	listener?.({ type: 'slewRate', previous, applied: options.slewRate })

	let captures = 0

	const first = await acquireSample(context, mount, camera, 1, ++captures, options, services)
	if (!first.ok) return first
	if (first.value === undefined) return failedOperationResult('commandFailed', 'the first pose did not solve')
	// Refused before any motion: near the pole the rotation about it is no longer the mechanical one.
	if (polarAlignmentPolarDistance(polarAlignmentEarthFixedVector(first.value.sample)) < limits.minimumPolarDistance) return failedOperationResult('unexpectedState', 'pose 1 rejected: nearPole')
	listener?.({ type: 'accepted', point: 1, sample: first.value.sample, solution: first.value.solution })

	const points: ThreePointPolarAlignmentInput[] = [first.value.sample]
	let previousAccepted = first.value.sample
	let solution = first.value.solution
	// Last solved pose and the rotation rate, in radians per second of motion, observed so far.
	let last = first.value.sample
	let rate: number | undefined
	// Duration of the next motion while no rate is known, in seconds.
	let probe = options.initialMotion

	for (const point of [2, 3] as const) {
		let accepted = false

		for (let attempt = 1; attempt <= options.maximumAttempts && !accepted; attempt++) {
			const moved = sign(options.direction) * polarAlignmentDisplacement(previousAccepted, last).rotation
			const duration = rate === undefined ? probe : motionDuration(limits.targetRotation - moved, rate, options)
			listener?.({ type: 'move', point, direction: options.direction, duration })

			const motion = await polarAlignmentTimedMotion(context, mountCommander, mount, options.direction, duration, clock)
			if (!motion.ok) return motion

			const changed = poseChanged(mount, pierSide)
			if (changed) return failedOperationResult('unexpectedState', changed)

			const settled = await clock.delay(options.settle * 1000, context.signal)
			if (!settled.ok) return settled

			const solved = await acquireSample(context, mount, camera, point, ++captures, options, services)
			if (!solved.ok) return solved
			// An unsolved frame still moved the mount, but leaves the rate estimate unchanged.
			if (solved.value === undefined) continue

			const { sample } = solved.value
			const increment = sign(options.direction) * motorRotation(last, sample)
			last = sample

			if (Math.abs(increment) < NO_MOTION_ROTATION) {
				// A mount that moved before and stands still now is stuck; one that never moved yet may run a
				// slow preset, and is probed longer up to the longest motion.
				if (rate !== undefined || duration >= options.maximumMotion) return failedOperationResult('unexpectedState', `mount ${mount.name} did not rotate in RA`)
				probe = Math.min(options.maximumMotion, duration * PROBE_GROWTH)
			} else if (increment > 0) {
				// Only motion towards the requested direction calibrates the rate; a reversal is rejected below.
				rate = increment / duration
			}

			const classification = classifyPolarAlignmentCandidate(points[0], previousAccepted, sample, options.direction, limits)
			listener?.({ type: 'candidate', point, sample, classification })

			if (classification.accepted) {
				points.push(sample)
				previousAccepted = sample
				solution = solved.value.solution
				accepted = true
				listener?.({ type: 'accepted', point, sample, solution })
			} else if (!classification.retry) {
				return failedOperationResult('unexpectedState', `pose ${point} rejected: ${classification.reason}`)
			}
		}

		if (!accepted) return failedOperationResult('unexpectedState', `pose ${point} not reached in ${options.maximumAttempts} attempts`)
	}

	const [p1, p2, p3] = points as [ThreePointPolarAlignmentInput, ThreePointPolarAlignmentInput, ThreePointPolarAlignmentInput]
	const quality = polarAlignmentGeometryQuality(p1, p2, p3, options.direction, limits)
	listener?.({ type: 'geometry', quality })
	if (!quality.acceptable) return failedOperationResult('unexpectedState', `the three poses are ill conditioned: ${quality.reason}`)

	const alignment = new ThreePointPolarAlignment(options.refraction ?? DEFAULT_REFRACTION_PARAMETERS, SIDEREAL_DRIFT_RATE)
	alignment.add(...p1)
	alignment.add(...p2)
	const result = alignment.add(...p3)
	// Unreachable after an acceptable geometry, whose chords are far from collinear.
	if (result === false) return failedOperationResult('unexpectedState', 'the three poses define no mount pole')

	listener?.({ type: 'result', stage: 'acquisition', result, solution, sample: p3 })
	return successfulOperationResult({ alignment, points: [p1, p2, p3], quality, result, solution, pierSide, captures })
}

// Refinement inside its operation.
async function refinementLoop(
	context: OperationContext,
	mount: Mount,
	camera: Camera,
	alignment: ThreePointPolarAlignment,
	from: ThreePointPolarAlignmentInput,
	pierSide: PierSide,
	options: ThreePointPolarAlignmentRefinementOptions,
	services: ThreePointPolarAlignmentServices,
	firstIndex: number,
): Promise<OperationResult<void>> {
	const { clock, listener } = services
	let reference = from
	let failures = 0

	for (let index = firstIndex; ; index++) {
		const waited = await clock.delay(options.delay * 1000, context.signal)
		if (!waited.ok) return waited

		const changed = poseChanged(mount, pierSide)
		if (changed) return failedOperationResult('unexpectedState', changed)

		const solved = await captureAndSolve(context, mount, camera, 'refinement', index, undefined, options, services)
		if (!solved.ok) return solved

		if (solved.value === undefined) {
			if (++failures > options.maximumFailures) return failedOperationResult('commandFailed', `${failures} refinement frames in a row did not solve`)
			continue
		}

		failures = 0
		const { sample, solution } = solved.value
		// Tracking keeps the field fixed on the sky, so a slew shows as a jump of the inertial center; in the
		// Earth-fixed frame the tracking itself would grow without bound while the refinement is paused.
		const shift = angularDistance(reference[0], reference[1], sample[0], sample[1])
		if (!(shift <= options.maximumShift)) return failedOperationResult('unexpectedState', `the field moved ${toDeg(shift).toFixed(2)}° between refinement frames`)

		const result = alignment.add(...sample)
		reference = sample
		if (result !== false) listener?.({ type: 'result', stage: 'refinement', result, solution, sample })
	}
}

// Captures and solves one acquisition frame of `point`.
async function acquireSample(context: OperationContext, mount: Mount, camera: Camera, point: 1 | 2 | 3, index: number, options: ThreePointPolarAlignmentAcquisitionOptions, services: ThreePointPolarAlignmentServices) {
	return await captureAndSolve(context, mount, camera, 'acquisition', index, point, options, services)
}

// Captures the auxiliary frame `index` of `stage` and solves it cooperatively. Resolves the solution
// with its timestamped sample (the exposure midpoint, located at the observing site), undefined when
// the frame did not solve, or the failure of the capture, the solve timeout, a faulted solver or the
// cancellation. The file is disposed of only after the solve ended.
async function captureAndSolve(
	context: OperationContext,
	mount: Mount,
	camera: Camera,
	stage: ThreePointPolarAlignmentStage,
	index: number,
	point: 1 | 2 | 3 | undefined,
	options: Pick<ThreePointPolarAlignmentAcquisitionOptions, 'capture' | 'solveTimeout' | 'abortGrace' | 'auxiliary'>,
	services: ThreePointPolarAlignmentServices,
): Promise<OperationResult<{ readonly sample: ThreePointPolarAlignmentInput; readonly solution: PlateSolution } | undefined>> {
	const { cameraCapturer, captureListener, solver, clock, solverHealth, listener } = services
	const path = services.auxiliaryPath(stage, index)
	const request = centeringCaptureRequest(options.capture, path, mount)

	try {
		listener?.({ type: 'capture', stage, index, point })
		const captured = await cameraCapturer.start(context, camera, request, { clock, listener: captureListener }).result
		if (!captured.ok) return captured

		const { frames } = captured.value
		if (frames.length !== 1) return failedOperationResult('unexpectedState', `an auxiliary capture produced ${frames.length} frames`)

		const frame: ThreePointPolarAlignmentFrame = { path, observedAt: exposureMidpoint(frames[0], request), stage, index, point }
		const outcome = await awaitCooperativeJob((signal) => solver(frame, signal), { signal: context.signal, timeout: options.solveTimeout * 1000, abortGrace: options.abortGrace * 1000, delay: clock.delay, health: solverHealth })
		const solved = solveResult(outcome, context.signal, options.solveTimeout)
		if (!solved.ok) return solved

		listener?.({ type: 'solved', frame, solution: solved.value })
		if (solved.value === undefined) return successfulOperationResult(undefined)

		const time = timeUnix(frame.observedAt / 1000)
		time.location = services.location
		const sample: ThreePointPolarAlignmentInput = [solved.value.rightAscension, solved.value.declination, time]
		return successfulOperationResult({ sample, solution: solved.value })
	} finally {
		if (options.auxiliary !== 'keep') await removeAuxiliary(path)
	}
}

// Duration of the next motion, in seconds: the remaining rotation over the observed rate (radians
// per second, > 0), bounded by the minimum and the longest motion.
function motionDuration(remaining: Angle, rate: number, options: Pick<ThreePointPolarAlignmentAcquisitionOptions, 'maximumMotion'>) {
	return Math.max(MINIMUM_MOTION, Math.min(options.maximumMotion, remaining / rate))
}

// Reason the mount left the state the alignment model assumes (tracking on, same pier side), or
// undefined while it did not.
function poseChanged(mount: Mount, pierSide: PierSide) {
	if (!mount.connected) return `mount ${mount.name} disconnected`
	if (!mount.tracking) return `mount ${mount.name} stopped tracking`
	if (mount.hasPierSide && mount.pierSide !== pierSide) return `mount ${mount.name} changed pier side`
	return undefined
}

// Rotation the motor added between two solves of a tracking mount, in radians, positive towards the
// west: the measured change of hour angle less the sidereal tracking over the time between them, which
// is not motion of the manual axis and would otherwise pass for it at slow presets.
function motorRotation(from: ThreePointPolarAlignmentInput, to: ThreePointPolarAlignmentInput) {
	return polarAlignmentDisplacement(from, to).rotation - SIDEREAL_DRIFT_RATE * timeSubtract(to[2], from[2], Timescale.TAI) * DAYSEC
}

// Sign that makes a rotation in `direction` positive.
function sign(direction: PolarAlignmentDirection) {
	return direction === 'WEST' ? 1 : -1
}

// Removes an auxiliary file, if any. Best effort, as in centering.
async function removeAuxiliary(path: string) {
	try {
		await unlink(path)
	} catch {
		// Missing (the capture never wrote it) or not removable now.
	}
}
