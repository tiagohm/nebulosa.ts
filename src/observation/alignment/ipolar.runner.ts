import { unlink } from 'fs/promises'
import type { PlateSolution } from '../../astrometry/solvers/platesolver'
import { timeUnix } from '../../astronomy/time/time'
import type { MountCommander } from '../../devices/commanders/mount'
import type { Camera, Mount, PierSide } from '../../devices/indi/device'
import { failedOperationResult, type OperationContext, type OperationResult, type OperationScope, successfulOperationResult } from '../../devices/orchestration/operation'
import { abortReason, awaitCooperativeJob, type CooperativeJobHealth } from '../../devices/orchestration/operation.wait'
import { type Angle, toDeg } from '../../math/units/angle'
import type { CameraCapturer } from '../capture/capture'
import type { CameraCaptureListener } from '../capture/reporter'
import { type CenteringCaptureOptions, type CenteringClock, centeringCaptureRequest, exposureMidpoint, solveResult } from '../mount/centering'
import {
	advanceIPolarConvergence,
	calibrateIPolar,
	DEFAULT_IPOLAR_CONVERGENCE,
	DEFAULT_IPOLAR_LIMITS,
	type IPolarAcceptedMeasurement,
	type IPolarCalibration,
	type IPolarCalibrationQuality,
	type IPolarConvergence,
	IPOLAR_CONVERGENCE_START,
	type IPolarConvergenceOptions,
	type IPolarFrame,
	type IPolarLimits,
	type IPolarMeasurement,
	type IPolarRejection,
	type IPolarSensorGeometry,
	measureIPolar,
} from './ipolar'
import type { IPolarObserver } from './ipolar.geometry'
import { type PolarAlignmentDirection, polarAlignmentTimedMotion } from './polaralignment'

// Acquisition and refinement of a camera-based (iPolar) polar alignment, reusable outside the
// application. Calibration captures and solves a first frame where the mount stands, then reaches a
// second pose by an RA rotation: in manual mode the operator turns the RA axis and confirms through
// `rotationConfirmed`, and the runner never commands the mount; in automatic mode it turns the mount
// with bounded timed manual motions at a slew-rate preset, sizing each from the rotation measured so
// far and accepting the pose only from the rotation fitted between the solves, never from motion
// time. Refinement only captures and solves, measuring every frame against the calibration and
// keeping the reversible convergence streak; it never commands the mount. A mount, when given, is
// watched for a declination or pier-side change (a motion that is not RA); without one the motion
// is the operator's statement. The mount is snooped into the frames as a pointing hint only while
// its reported pointing follows the camera: in automatic calibration, and in a refinement that asks
// for it. The runner leases nothing itself: the commander and the capturer lease per command. It
// changes the slew rate only in automatic mode and reports the preset it
// replaced, never restoring it, because a cancelled operation commands nothing more; the caller
// restores it once the devices are free. Angles are radians, durations seconds, wall instants Unix ms.

// How the RA axis is rotated between the calibration frames.
export type IPolarMode = 'manual' | 'automatic'

// Settings of the automatic RA rotation; every duration is in seconds.
export interface IPolarMotionOptions {
	// Direction of every RA motion.
	readonly direction: PolarAlignmentDirection
	// Name of the slew-rate preset of the motions; one the mount announces.
	readonly slewRate: string
	// RA rotation aimed at between the calibration frames, in radians, within the limits.
	readonly targetRotation: Angle
	// Duration of the first motion, before any rotation rate is known; finite > 0.
	readonly initialMotion: number
	// Longest single motion; finite ≥ `initialMotion`.
	readonly maximumMotion: number
	// Longest total motion of the calibration; finite ≥ `initialMotion`.
	readonly maximumTotalMotion: number
}

// Calibration settings; every duration is in seconds.
export interface IPolarCalibrationOptions {
	// Manual (the operator turns RA and confirms) or automatic rotation.
	readonly mode: IPolarMode
	// Camera settings of the auxiliary frames.
	readonly capture: CenteringCaptureOptions
	// Site and atmosphere of the calibration and every measurement.
	readonly observer: IPolarObserver
	// Automatic rotation; required in automatic mode, ignored in manual mode.
	readonly motion?: IPolarMotionOptions
	// Wait after the rotation and before the second exposure; finite ≥ 0.
	readonly settle: number
	// Captures allowed while looking for the second pose; safe integer ≥ 1.
	readonly maximumAttempts: number
	// Largest change of the mount's reported declination tolerated during the calibration, in radians.
	readonly maximumDeclinationChange: Angle
	// Cooperative timeout of one solve; finite > 0.
	readonly solveTimeout: number
	// Watchdog after an aborted solve before the solver is reported unresponsive; finite > 0.
	readonly abortGrace: number
	// Quality gates; defaults to DEFAULT_IPOLAR_LIMITS.
	readonly limits?: Readonly<IPolarLimits>
	// Disposition of each auxiliary frame once its solve ended. Default 'delete'.
	readonly auxiliary?: 'delete' | 'keep'
}

// Refinement settings; every duration is in seconds.
export interface IPolarRefinementOptions {
	// Camera settings of the auxiliary frames; the same sensor geometry as the calibration.
	readonly capture: CenteringCaptureOptions
	// Wait before each refinement exposure; finite ≥ 0.
	readonly delay: number
	// Consecutive frames without a solution tolerated before the refinement fails; safe integer ≥ 0.
	readonly maximumFailures: number
	// Largest change of the mount's reported declination since the calibration, in radians.
	readonly maximumDeclinationChange: Angle
	// Cooperative timeout of one solve; finite > 0.
	readonly solveTimeout: number
	// Watchdog after an aborted solve before the solver is reported unresponsive; finite > 0.
	readonly abortGrace: number
	// Quality gates; defaults to DEFAULT_IPOLAR_LIMITS.
	readonly limits?: Readonly<IPolarLimits>
	// Convergence streak; defaults to DEFAULT_IPOLAR_CONVERGENCE.
	readonly convergence?: Readonly<IPolarConvergenceOptions>
	// Whether the mount is snooped into the frames, its reported pointing a hint for the solver; false when that
	// pointing is stale, as after a manual RA rotation. Default false.
	readonly snoop?: boolean
	// Disposition of each auxiliary frame once its solve ended. Default 'delete'.
	readonly auxiliary?: 'delete' | 'keep'
}

// Stage an auxiliary frame belongs to.
export type IPolarStage = 'calibration' | 'refinement'

// Frame handed to the solver: a complete FITS file on disk and where it belongs in the session.
export interface IPolarRunnerFrame {
	// Path of the FITS file; read-only, and left in place until the solve ended.
	readonly path: string
	// Astronomical midpoint of the exposure, in Unix ms (wall).
	readonly observedAt: number
	// Stage of the session.
	readonly stage: IPolarStage
	// 1-based number of the frame within its stage, counting every capture.
	readonly index: number
	// Calibration pose being captured (1 or 2); absent during refinement.
	readonly pose?: 1 | 2
}

// Plate solver provided by the caller; same contract as `CenteringSolver`. The solution must be the
// solution of exactly this frame.
export type IPolarSolver = (frame: IPolarRunnerFrame, signal: AbortSignal) => Promise<PlateSolution | undefined>

// Mount state the calibration began with, which the refinement keeps watching.
export interface IPolarMountReference {
	// Reported declination when the calibration began, in radians.
	readonly declination: Angle
	// Reported pier side when the calibration began.
	readonly pierSide: PierSide
}

// Synchronous progress of a run, in order of occurrence.
export type IPolarEvent =
	| {
			readonly type: 'slewRate'
			// Preset the mount used before the run changed it, or undefined when it reported none.
			readonly previous?: string
			// Preset now applied.
			readonly applied: string
	  }
	| {
			readonly type: 'capture'
			// Frame about to be exposed (without its midpoint, which is not known yet).
			readonly stage: IPolarStage
			// 1-based number of the frame within its stage.
			readonly index: number
			// Calibration pose; absent during refinement.
			readonly pose?: 1 | 2
	  }
	| {
			readonly type: 'solved'
			// Frame that was solved.
			readonly frame: IPolarRunnerFrame
			// Solution, or undefined when the frame did not solve.
			readonly solution?: PlateSolution
	  }
	| {
			readonly type: 'waitingForRotation'
			// 1-based attempt at the second pose the operator is asked to rotate for.
			readonly attempt: number
	  }
	| {
			readonly type: 'move'
			// Direction of the automatic motion.
			readonly direction: PolarAlignmentDirection
			// Commanded duration, in seconds.
			readonly duration: number
	  }
	| {
			readonly type: 'calibrationRejected'
			// Solved frame that did not calibrate.
			readonly frame: IPolarRunnerFrame
			// Why it did not.
			readonly reason: IPolarRejection
			// Diagnostics of the attempt, the fitted rotation included when reached.
			readonly quality: IPolarCalibrationQuality
			// Whether another second pose is tried; false ends the run.
			readonly retry: boolean
	  }
	| {
			readonly type: 'calibrationAccepted'
			// Accepted calibration.
			readonly calibration: IPolarCalibration
			// Frame of the second pose.
			readonly frame: IPolarRunnerFrame
			// Measurement of the second pose.
			readonly measurement: IPolarMeasurement
			// Solution of the second pose.
			readonly solution: PlateSolution
			// Whether a mount reported its declination and pier side throughout, which rules out a
			// declination motion; false when the RA-only motion rests on the operator's word.
			readonly verified: boolean
	  }
	| {
			readonly type: 'measurement'
			// Refinement frame that was measured.
			readonly frame: IPolarRunnerFrame
			// Its measurement, accepted or rejected.
			readonly measurement: IPolarMeasurement
			// Convergence after it.
			readonly convergence: IPolarConvergence
			// Its solution.
			readonly solution: PlateSolution
	  }

// Services of a run.
export interface IPolarServices {
	// Slew rate and the timed RA motions; required in automatic mode, never used in manual mode.
	readonly mountCommander?: MountCommander
	// Auxiliary captures.
	readonly cameraCapturer: CameraCapturer
	// Receives the events of every auxiliary capture, such as the progress of its exposure.
	readonly captureListener?: CameraCaptureListener
	// Plate solver of the auxiliary frames.
	readonly solver: IPolarSolver
	// Absolute path of an auxiliary FITS; its directory exists and the file does not.
	readonly auxiliaryPath: (stage: IPolarStage, index: number) => string
	// Clock of the midpoints, the motions, the settle and the solve timeout.
	readonly clock: CenteringClock
	// Manual mode: resolves true once the operator says the RA rotation ended, false when `signal`
	// aborted first. Required in manual mode.
	readonly rotationConfirmed?: (signal: AbortSignal) => Promise<boolean>
	// Progress listener, called synchronously.
	readonly listener?: (event: IPolarEvent) => void
	// Health of the solver across runs of its owner; absent treats each run alone.
	readonly solverHealth?: CooperativeJobHealth
}

// Outcome of a successful calibration.
export interface IPolarCalibrationRun {
	// Accepted calibration.
	readonly calibration: IPolarCalibration
	// Measurement of the second pose, the first measurement of the session.
	readonly measurement: IPolarMeasurement
	// Solution of the second pose.
	readonly solution: PlateSolution
	// Mount state when the calibration began; absent without a mount.
	readonly mount?: IPolarMountReference
	// Captures of the calibration, the accepted ones included.
	readonly captures: number
}

// State a refinement continues from, so a resumed refinement keeps its history.
export interface IPolarRefinementState {
	// Latest accepted measurement, against which jumps are checked.
	readonly previous?: IPolarAcceptedMeasurement
	// Convergence streak so far.
	readonly convergence: IPolarConvergence
}

// Shortest motion commanded, in seconds; drivers ignore motions far below their update period.
const MINIMUM_MOTION = 0.2

// Fitted rotation per motion below which the mount is considered not to have moved, in radians (0.05°).
const NO_MOTION_ROTATION = 0.05 * (Math.PI / 180)

// Growth of the motion while no rotation was measured yet, as in the three-point runner.
const PROBE_GROWTH = 4

// Rejections a further second pose may cure: too little rotation, or a poor solve of the candidate.
const RETRYABLE: ReadonlySet<IPolarRejection> = new Set(['insufficientRotation', 'badWcs', 'poorConditioning', 'unstableFit'])

// Reason the mount cannot run the automatic RA rotation at `slewRate`, 'disconnected', or undefined
// when it can: a connected, unparked equatorial mount that can move west-east and abort, and
// announces the preset. Tracking is not required, since the Earth-fixed fit does not depend on it.
export function ipolarMountRefusal(mount: Mount, slewRate: string) {
	if (!mount.connected) return 'disconnected'
	if (mount.mountType === 'ALTAZ') return `mount ${mount.name} is not equatorial`
	if (!mount.canMove || !mount.canMoveWE) return `mount ${mount.name} cannot move west-east`
	if (!mount.canAbort) return `mount ${mount.name} cannot abort a motion`
	if (mount.parked || mount.parking) return `mount ${mount.name} is parked`
	if (!mount.slewRates.some((e) => e.name === slewRate)) return `mount ${mount.name} has no slew rate ${slewRate}`
	return undefined
}

// Calibrates the mechanical RA axis inside an operation `ipolarCalibration` of `scope`, which leases
// nothing itself. `mount` is the mount the camera rides on, when known: required in automatic mode,
// optional in manual mode, where it is only watched. Fails as `unexpectedState` on a declination or
// pier-side change of the mount, a terminal calibration rejection (a different sensor, a wrong axis,
// too much rotation), a mount that does not move, the exhaustion of the attempts or of the motion
// budget; as `commandFailed` when the first frame does not solve. Never rejects.
export async function runIPolarCalibration(scope: OperationScope, camera: Camera, mount: Mount | undefined, options: IPolarCalibrationOptions, services: IPolarServices): Promise<OperationResult<IPolarCalibrationRun>> {
	return await scope.start<IPolarCalibrationRun>('ipolarCalibration', [], (context) => calibrationLoop(context, camera, mount, options, services)).result
}

// Captures and measures refinement frames inside an operation `ipolarRefinement` of `scope` until
// it is cancelled, reporting each through a `measurement` event; it never commands the mount. A
// frame without a solution is skipped, clearing the convergence streak, until `maximumFailures`
// consecutive ones fail the run as `commandFailed`; a measurement that invalidates the
// calibration, or a declination or pier-side
// change of `mount` since `reference`, fails it as `unexpectedState`. `state` is where a resumed
// refinement continues from. Resolves the failure of its cancellation when cancelled. Never rejects.
export async function runIPolarRefinement(
	scope: OperationScope,
	camera: Camera,
	mount: Mount | undefined,
	reference: IPolarMountReference | undefined,
	calibration: IPolarCalibration,
	state: IPolarRefinementState,
	options: IPolarRefinementOptions,
	services: IPolarServices,
	firstIndex: number = 1,
): Promise<OperationResult<void>> {
	return await scope.start<void>('ipolarRefinement', [], (context) => refinementLoop(context, camera, mount, reference, calibration, state, options, services, firstIndex)).result
}

// Calibration inside its operation.
async function calibrationLoop(context: OperationContext, camera: Camera, mount: Mount | undefined, options: IPolarCalibrationOptions, services: IPolarServices): Promise<OperationResult<IPolarCalibrationRun>> {
	const { mode, motion } = options
	const { clock, listener, mountCommander } = services
	const limits = options.limits ?? DEFAULT_IPOLAR_LIMITS

	// The two modes are exclusive: manual never reaches the commander, automatic never waits for the operator.
	if (mode === 'automatic') {
		if (mount === undefined || motion === undefined || mountCommander === undefined) return failedOperationResult('unexpectedState', 'automatic rotation needs a mount, its motion settings and a commander')
		const refused = ipolarMountRefusal(mount, motion.slewRate)
		if (refused) return failedOperationResult(refused === 'disconnected' ? 'disconnected' : 'unexpectedState', refused === 'disconnected' ? undefined : refused)
	} else if (services.rotationConfirmed === undefined) {
		return failedOperationResult('unexpectedState', 'manual rotation needs the confirmation of the operator')
	}

	if (mount !== undefined && !mount.connected) return failedOperationResult('disconnected')
	const reference: IPolarMountReference | undefined = mount && { declination: mount.equatorialCoordinate.declination, pierSide: mount.pierSide }
	// A mount turned by hand keeps reporting the pointing it had, a stale hint that could keep the second pose from solving.
	const snooped = mode === 'automatic' ? mount : undefined

	if (mode === 'automatic') {
		const previous = mount!.slewRate
		const applied = await mountCommander!.setSlewRate(context, mount!, motion!.slewRate)
		if (!applied.ok) return applied
		listener?.({ type: 'slewRate', previous, applied: motion!.slewRate })
	}

	let captures = 0
	const first = await captureAndSolve(context, camera, snooped, 'calibration', ++captures, 1, options, services)
	if (!first.ok) return first
	if (first.value === undefined) return failedOperationResult('commandFailed', 'the first frame did not solve')

	// Automatic motion state: the fitted rotation so far, its rate per second of motion, the next probe.
	let rotated = 0
	let rate: number | undefined
	let probe = motion?.initialMotion ?? 0
	let moved = 0

	for (let attempt = 1; attempt <= options.maximumAttempts; attempt++) {
		if (mode === 'manual') {
			listener?.({ type: 'waitingForRotation', attempt })
			const confirmed = await services.rotationConfirmed!(context.signal)
			if (!confirmed || context.signal.aborted) return failedOperationResult(abortReason(context.signal))
		} else {
			const remaining = motion!.maximumTotalMotion - moved
			if (!(remaining >= MINIMUM_MOTION)) return failedOperationResult('unexpectedState', `the RA rotation did not reach ${toDeg(motion!.targetRotation).toFixed(1)}° within ${motion!.maximumTotalMotion} s of motion`)
			const wanted = rate === undefined ? probe : (motion!.targetRotation - rotated) / rate
			const duration = Math.min(remaining, motion!.maximumMotion, Math.max(MINIMUM_MOTION, wanted))
			listener?.({ type: 'move', direction: motion!.direction, duration })
			const motioned = await polarAlignmentTimedMotion(context, mountCommander!, mount!, motion!.direction, duration, clock)
			if (!motioned.ok) return motioned
			moved += duration
			probe = duration
		}

		const changed = mount && reference && mountChanged(mount, reference, options.maximumDeclinationChange)
		if (changed) return failedOperationResult('unexpectedState', changed)

		const settled = await clock.delay(options.settle * 1000, context.signal)
		if (!settled.ok) return settled

		const second = await captureAndSolve(context, camera, snooped, 'calibration', ++captures, 2, options, services)
		if (!second.ok) return second
		// An unsolved frame leaves the first pose and the rate unchanged.
		if (second.value === undefined) continue

		const result = calibrateIPolar(first.value.frame, second.value.frame, options.observer, limits)

		if (result.accepted) {
			const measurement = measureIPolar(result.calibration, second.value.frame, undefined, limits)
			listener?.({ type: 'calibrationAccepted', calibration: result.calibration, frame: second.value.runner, measurement, solution: second.value.solution, verified: mount !== undefined })
			return successfulOperationResult({ calibration: result.calibration, measurement, solution: second.value.solution, mount: reference, captures })
		}

		const retry = RETRYABLE.has(result.reason) && attempt < options.maximumAttempts
		listener?.({ type: 'calibrationRejected', frame: second.value.runner, reason: result.reason, quality: result.quality, retry })
		if (!RETRYABLE.has(result.reason)) return failedOperationResult('unexpectedState', `the second pose was rejected: ${result.reason}`)

		if (mode === 'automatic' && result.quality.rotation !== undefined) {
			const increment = result.quality.rotation - rotated
			rotated = result.quality.rotation

			if (increment < NO_MOTION_ROTATION) {
				// A mount that moved before and stands still now is stuck; one that never moved yet may run a slow preset.
				if (rate !== undefined || probe >= motion!.maximumMotion) return failedOperationResult('unexpectedState', `mount ${mount!.name} did not rotate in RA`)
				probe = Math.min(motion!.maximumMotion, probe * PROBE_GROWTH)
			} else {
				rate = increment / probe
			}
		}
	}

	return failedOperationResult('unexpectedState', `the second pose was not reached in ${options.maximumAttempts} attempts`)
}

// Refinement inside its operation.
async function refinementLoop(context: OperationContext, camera: Camera, mount: Mount | undefined, reference: IPolarMountReference | undefined, calibration: IPolarCalibration, state: IPolarRefinementState, options: IPolarRefinementOptions, services: IPolarServices, firstIndex: number): Promise<OperationResult<void>> {
	const { clock, listener } = services
	const limits = options.limits ?? DEFAULT_IPOLAR_LIMITS
	const convergenceOptions = options.convergence ?? DEFAULT_IPOLAR_CONVERGENCE
	let { previous, convergence } = state
	let failures = 0

	for (let index = firstIndex; ; index++) {
		const waited = await clock.delay(options.delay * 1000, context.signal)
		if (!waited.ok) return waited

		const changed = mount && reference && mountChanged(mount, reference, options.maximumDeclinationChange)
		if (changed) return failedOperationResult('unexpectedState', changed)

		const solved = await captureAndSolve(context, camera, options.snoop ? mount : undefined, 'refinement', index, undefined, options, services)
		if (!solved.ok) return solved

		if (solved.value === undefined) {
			// A frame that gave no measurement leaves no current guidance, so it breaks the streak like a rejection.
			convergence = IPOLAR_CONVERGENCE_START
			if (++failures > options.maximumFailures) return failedOperationResult('commandFailed', `${failures} refinement frames in a row did not solve`)
			continue
		}

		failures = 0
		const measurement = measureIPolar(calibration, solved.value.frame, previous, limits)
		convergence = advanceIPolarConvergence(convergence, measurement, convergenceOptions)
		listener?.({ type: 'measurement', frame: solved.value.runner, measurement, convergence, solution: solved.value.solution })

		if (measurement.valid) previous = measurement
		else if (measurement.invalidatesCalibration) return failedOperationResult('unexpectedState', `the calibration no longer matches the camera: ${measurement.reason}`)
	}
}

// Captures the auxiliary frame `index` of `stage` and solves it cooperatively. Resolves the solution
// with the frame of the engine (the exposure midpoint and the sensor geometry of the request),
// undefined when the frame did not solve, or the failure of the capture, the solve timeout, a
// faulted solver or the cancellation. The file is disposed of only after the solve ended.
// `snooped`, when given, is the mount whose reported pointing goes into the header as a hint for
// the solver.
async function captureAndSolve(
	context: OperationContext,
	camera: Camera,
	snooped: Mount | undefined,
	stage: IPolarStage,
	index: number,
	pose: 1 | 2 | undefined,
	options: Pick<IPolarCalibrationOptions, 'capture' | 'solveTimeout' | 'abortGrace' | 'auxiliary'>,
	services: IPolarServices,
): Promise<OperationResult<{ readonly frame: IPolarFrame; readonly runner: IPolarRunnerFrame; readonly solution: PlateSolution } | undefined>> {
	const { cameraCapturer, captureListener, solver, clock, solverHealth, listener } = services
	const path = services.auxiliaryPath(stage, index)
	// A name that resolves no device is snooped as empty.
	const request = centeringCaptureRequest(options.capture, path, { name: snooped?.name ?? '' })

	try {
		listener?.({ type: 'capture', stage, index, pose })
		const captured = await cameraCapturer.start(context, camera, request, { clock, listener: captureListener }).result
		if (!captured.ok) return captured

		const { frames } = captured.value
		if (frames.length !== 1) return failedOperationResult('unexpectedState', `an auxiliary capture produced ${frames.length} frames`)

		const runner: IPolarRunnerFrame = { path, observedAt: exposureMidpoint(frames[0], request), stage, index, pose }
		const outcome = await awaitCooperativeJob((signal) => solver(runner, signal), { signal: context.signal, timeout: options.solveTimeout * 1000, abortGrace: options.abortGrace * 1000, delay: clock.delay, health: solverHealth })
		const solved = solveResult(outcome, context.signal, options.solveTimeout)
		if (!solved.ok) return solved

		listener?.({ type: 'solved', frame: runner, solution: solved.value })
		if (solved.value === undefined) return successfulOperationResult(undefined)

		const solution = solved.value
		const time = timeUnix(runner.observedAt / 1000)
		const frame: IPolarFrame = { time, solution, sensor: sensorGeometry(options.capture, solution) }
		return successfulOperationResult({ frame, runner, solution })
	} finally {
		if (options.auxiliary !== 'keep') await removeAuxiliary(path)
	}
}

// Sensor geometry of a frame: its solved dimensions and the binning and subframe origin requested.
function sensorGeometry(capture: CenteringCaptureOptions, solution: PlateSolution): IPolarSensorGeometry {
	return { width: solution.widthInPixels, height: solution.heightInPixels, binX: capture.binX, binY: capture.binY, x: capture.subframe ? capture.x : 0, y: capture.subframe ? capture.y : 0 }
}

// Reason the mount left the state of the calibration (connected, the same declination and pier
// side), or undefined while it did not.
function mountChanged(mount: Mount, reference: IPolarMountReference, maximumDeclinationChange: Angle) {
	if (!mount.connected) return `mount ${mount.name} disconnected`
	if (mount.hasPierSide && mount.pierSide !== reference.pierSide) return `mount ${mount.name} changed pier side`
	const change = Math.abs(mount.equatorialCoordinate.declination - reference.declination)
	if (!(change <= maximumDeclinationChange)) return `mount ${mount.name} moved ${toDeg(change).toFixed(2)}° in declination`
	return undefined
}

// Removes an auxiliary file, if any. Best effort, as in centering.
async function removeAuxiliary(path: string) {
	try {
		await unlink(path)
	} catch {
		// Missing (the capture never wrote it) or not removable now.
	}
}
