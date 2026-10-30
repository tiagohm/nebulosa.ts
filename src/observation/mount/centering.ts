import { unlink } from 'fs/promises'
import { basename, dirname } from 'path'
import type { PlateSolution } from '../../astrometry/solvers/platesolver'
import { angularDistance, equatorialToJ2000 } from '../../astronomy/coordinates/coordinate'
import { timeUnix } from '../../astronomy/time/time'
import type { MountCommander, MountCommandOptions } from '../../devices/commanders/mount'
import type { Camera, Mount } from '../../devices/indi/device'
import { failedOperationResult, type OperationContext, type OperationResult, type OperationScope, successfulOperationResult } from '../../devices/orchestration/operation'
import { type AbortableDelay, abortReason, awaitCooperativeJob, type CooperativeJobHealth, type CooperativeJobOutcome } from '../../devices/orchestration/operation.wait'
import { type Angle, toDeg } from '../../math/units/angle'
import type { CameraCapturer } from '../capture/capture'
import type { CameraCaptureListener } from '../capture/reporter'
import { type CameraCaptureStart, type CameraCaptureClock, DEFAULT_CAMERA_CAPTURE_START, type CameraFrameEvent, exposureTimeInMilliseconds } from '../capture/types'
import { applyPointingOffset, computePointingError } from './pointing'

// Plate-solved centering of a mount on a fixed ICRS target, reusable outside the Sequencer: capture an auxiliary FITS,
// solve it through a caller-provided solver, measure the great-circle distance between the solved center and the
// target, and correct with an optional sync and a corrective slew followed by a mechanical settle, until a solve after
// the last correction lands within tolerance. Success is always measured, never assumed after a slew.
//
// Every auxiliary frame is one FITS exposure (`exposureMode: 'single'`, `count: 1`, `delay: 0`,
// `transferFormat: 'FITS'`) auto-saved by the default writer of the capturer at the path the caller names. The solver
// receives only the path of the complete file and the astronomical midpoint of the exposure, after the capture
// result, with the signal of the `centering` operation (never the one of the capture); its timeout is cooperative:
// the signal is aborted and the solve awaited to its end, and only then is the file removed or kept. The target is
// compared directly with the ICRS center of the solution. A correction sends the mount, in J2000 converted at the wall
// instant of the injected clock, to the target after a sync to the solved center, or without sync from the position it
// reports moved against the measured error. Sky offsets use the tangent basis, never a right-ascension difference
// divided by the cosine of the declination. With no correction allowed it only measures, commanding nothing. A caller
// follows and gates the loop through an observer, and runs it inside an operation of its own, which holds the devices
// between the commands, by passing that operation's context as the scope.
//
// Conventions: angles in radians, configured durations in seconds turned into milliseconds only at the clock or the
// commander, wall instants in Unix ms. Each iteration allocates its capture request and a few small objects.

// Camera settings of an auxiliary centering frame. Every operational field (mode, count, delay, transfer format,
// destination) is fixed by the centering.
export type CenteringCaptureOptions = Readonly<Pick<CameraCaptureStart, 'exposureTime' | 'exposureTimeUnit' | 'frameType' | 'x' | 'y' | 'width' | 'height' | 'subframe' | 'binX' | 'binY' | 'frameFormat' | 'gain' | 'offset' | 'compressed'>>

// Bounds and behavior of one centering.
export interface CenteringOptions {
	// Accepted great-circle distance between the solved center and the target, in radians; finite > 0.
	readonly tolerance: Angle
	// Capture-and-solve iterations, the first one included; safe integer ≥ 1.
	readonly maximumAttempts: number
	// Corrections allowed, each a sync or slew followed by a new measurement; safe integer ≥ 0. Zero only measures and
	// never commands the mount. Default `maximumAttempts - 1`.
	readonly maximumCorrections?: number
	// Frames in a row without a solution, at one position, before the centering fails; safe integer ≥ 1. Default:
	// bounded only by `maximumAttempts`.
	readonly maximumUnsolved?: number
	// Corrections in a row that did not shrink the measured distance before the centering fails; safe integer ≥ 1.
	// Default: bounded only by `maximumCorrections`.
	readonly stallLimit?: number
	// Mechanical settle after each corrective slew, in seconds; finite ≥ 0.
	readonly settle: number
	// Syncs the mount to the solved center before each corrective slew to the target; without it the slew goes to
	// the target offset by the measured error.
	readonly syncMount: boolean
	// Camera settings of the auxiliary frames.
	readonly capture: CenteringCaptureOptions
	// Cooperative timeout of one solve, in seconds; finite > 0.
	readonly solveTimeout: number
	// Watchdog after an aborted solve before the solver is reported unresponsive, in seconds; finite > 0.
	readonly abortGrace: number
	// Disposition of each auxiliary frame once its solve ended (or its capture failed). Default 'delete'.
	readonly auxiliary?: 'delete' | 'keep'
	// Timing of the corrective slews, in ms, passed to `MountCommander.goTo` (`settleTimeout` is the bound of a
	// physical stop of a failed or cancelled slew).
	readonly slew?: Pick<MountCommandOptions, 'timeout' | 'settleTimeout'>
}

// Clock of a centering: `wallNow` (Unix ms) for the exposure midpoint and the
// conversion instant of the mount commands, `monotonicNow` and `delay` for the settle and the solve timeout.
export interface CenteringClock extends CameraCaptureClock {
	// Abortable wait in the monotonic domain, in ms.
	readonly delay: AbortableDelay
}

// Fixed ICRS target ('J2000'), in radians. JNOW is not accepted: a caller holding an
// equinox-of-date coordinate converts it first, with the instant that defines it.
export interface CenteringTarget {
	// Equatorial frame; only 'J2000' (ICRS).
	readonly frame: 'J2000'
	// Right ascension, in radians, in [0, 2π).
	readonly rightAscension: Angle
	// Declination, in radians, in [−π/2, π/2].
	readonly declination: Angle
}

// Frame handed to the solver: a complete FITS file on disk, never its bytes.
export interface CenteringFrame {
	// Path of the FITS file; read-only, and left in place until the solve ended.
	readonly path: string
	// Astronomical midpoint of the exposure, in Unix ms (wall): the first observed Busy plus half the requested
	// exposure time.
	readonly observedAt: number
}

// Plate solver provided by the caller (ASTAP, astrometry.net, a Worker, a process). It must yield the event loop,
// honor the signal and stop reading the file once it settled. It resolves the solution of `plateSolutionFrom` (an
// ICRS center of a TAN/TAN-SIP solution with known dimensions), or undefined when the frame did not solve.
export type CenteringSolver = (frame: CenteringFrame, signal: AbortSignal) => Promise<PlateSolution | undefined>

// Step a centering is entering, reported before it starts.
export type CenteringStep = 'exposing' | 'solving' | 'correcting' | 'settling'

// Outcome of one capture-and-solve iteration. Every field past `attempt` is absent when the frame did not solve.
export interface CenteringMeasurement {
	// Iteration, 1-based.
	readonly attempt: number
	// Solution of the frame.
	readonly solution?: PlateSolution
	// Great-circle distance between the solved center and the target, in radians.
	readonly separation?: Angle
	// Eastward offset of the solved center from the target on the plane tangent at the target, in radians.
	readonly dx?: number
	// Northward offset of the solved center from the target on the plane tangent at the target, in radians.
	readonly dy?: number
}

// Correction a centering is about to command.
export interface CenteringCorrection extends Required<Omit<CenteringMeasurement, 'solution'>> {
	// Right ascension the mount will be sent to, J2000, in radians.
	readonly rightAscension: Angle
	// Declination the mount will be sent to, J2000, in radians.
	readonly declination: Angle
}

// Observer of a centering. Its callbacks run synchronously inside the loop, so they must not await or command devices.
export interface CenteringObserver {
	// Receives each step before it starts.
	readonly step?: (step: CenteringStep, attempt: number) => void
	// Receives each measurement before it is judged, so the last one is known however the centering ends.
	readonly measured?: (measurement: CenteringMeasurement) => void
	// Receives the events of each auxiliary capture.
	readonly captureListener?: CameraCaptureListener
	// Last decision before a correction: a text refuses it, nothing is commanded and the centering fails with that text.
	readonly beforeCorrection?: (correction: CenteringCorrection) => string | undefined
}

// Services of a centering.
export interface CenteringServices {
	// Sync and corrective slews.
	readonly mountCommander: MountCommander
	// Auxiliary captures.
	readonly cameraCapturer: CameraCapturer
	// Plate solver of the auxiliary frames.
	readonly solver: CenteringSolver
	// Absolute path of the auxiliary FITS of iteration `attempt` (1-based); its directory exists and the file does not.
	readonly auxiliaryPath: (attempt: number) => string
	// Clock of the midpoint, the command instants, the settle and the solve timeout.
	readonly clock: CenteringClock
	// Health of the solver across the centerings of its owner; a faulted solver is never called again. Absent treats
	// each centering alone.
	readonly solverHealth?: CooperativeJobHealth
	// Observer of the steps, the measurements and the corrections.
	readonly observer?: CenteringObserver
}

// Outcome of a successful centering.
export interface CenteringResult {
	// Capture-and-solve iterations used, ≥ 1.
	readonly attempts: number
	// Great-circle distance between the last solved center and the target, in radians; ≤ the tolerance.
	readonly separation: Angle
	// Last solution, the one that verified the centering.
	readonly solution: PlateSolution
}

// Centers `mount` on `target` inside an operation `centering` of `scope`, which leases nothing itself: the capturer
// and the commander lease camera and mount per command. Each iteration captures the auxiliary frame of its attempt,
// solves it cooperatively with the signal of the operation, disposes of the file after the solve, and either
// succeeds (distance ≤ tolerance), fails (last attempt), or corrects: a sync to the solved center and a slew to the
// target, or without sync a slew from the reported position against the measured error, both J2000 with
// `MountCommandOptions.time` read from the clock, then the mechanical settle. A frame
// without a solution (undefined, non-finite or a rejected solve) consumes its attempt without commanding anything.
// Failures: the capture or mount failure as is; 'timeout' when a solve timed out; 'commandFailed' when no attempt
// solved or `maximumUnsolved` frames in a row did not; 'unexpectedState' when the last solution is still off target
// with no attempt or correction left, the distance stalled for `stallLimit` corrections, the observer refused a
// correction, or the solver is faulted; the reason of the operation signal when cancelled. Never rejects.
export async function centerTarget(scope: OperationScope, mount: Mount, camera: Camera, target: CenteringTarget, options: CenteringOptions, services: CenteringServices): Promise<OperationResult<CenteringResult>> {
	return await scope.start<CenteringResult>('centering', [], (context) => centeringLoop(context, mount, camera, target, options, services)).result
}

// Iterations of one centering inside its operation.
async function centeringLoop(context: OperationContext, mount: Mount, camera: Camera, target: CenteringTarget, options: CenteringOptions, services: CenteringServices): Promise<OperationResult<CenteringResult>> {
	const { tolerance, maximumAttempts, maximumCorrections = maximumAttempts - 1, maximumUnsolved, stallLimit, settle, syncMount } = options
	const { mountCommander, clock, observer } = services
	let unsolved = 0
	let unsolvedInARow = 0
	let corrections = 0
	let stalled = 0
	let previous: Angle | undefined

	for (let attempt = 1; attempt <= maximumAttempts; attempt++) {
		const solved = await captureAndSolve(context, mount, camera, attempt, options, services)
		if (!solved.ok) return solved

		const solution = solved.value

		if (solution === undefined) {
			unsolved++
			unsolvedInARow++
			observer?.measured?.({ attempt })
			if (attempt === maximumAttempts) return failedOperationResult('commandFailed', `no plate solution in ${unsolved} of ${maximumAttempts} attempts`)
			if (unsolvedInARow === maximumUnsolved) return failedOperationResult('commandFailed', `no plate solution in ${unsolvedInARow} frames in a row`)
			continue
		}

		unsolvedInARow = 0

		const separation = angularDistance(target.rightAscension, target.declination, solution.rightAscension, solution.declination)
		const { dx, dy } = computePointingError(target.rightAscension, target.declination, solution.rightAscension, solution.declination)
		observer?.measured?.({ attempt, solution, separation, dx, dy })

		if (separation <= tolerance) return successfulOperationResult({ attempts: attempt, separation, solution })
		if (attempt === maximumAttempts || corrections === maximumCorrections) return failedOperationResult('unexpectedState', `still ${(toDeg(separation) * 3600).toFixed(1)}″ from the target after ${attempt} attempts`)

		stalled = centeringStalled(previous, separation) ? stalled + 1 : 0
		if (stalled === stallLimit) return failedOperationResult('unexpectedState', `the distance to the target did not shrink in ${stalled} corrections`)
		previous = separation

		// One conversion instant for the whole correction, read from the wall clock of the caller.
		const time = timeUnix(clock.wallNow() / 1000)
		let destination = { rightAscension: target.rightAscension, declination: target.declination }

		if (!syncMount) {
			if (!mount.hasEquatorialCoordinate) return failedOperationResult('unexpectedState', `mount ${mount.name} publishes no position to correct from`)
			// Where the mount believes it points, in J2000 at the instant of the slew below.
			const [rightAscension, declination] = equatorialToJ2000(mount.equatorialCoordinate.rightAscension, mount.equatorialCoordinate.declination, time)
			// The sky stands at the measured error from what the mount reports, so the mount is sent from where it believes
			// it is by the offset that brings the solved center onto the target, both in the tangent basis.
			destination = applyPointingOffset(rightAscension, declination, -dx, -dy)
		}

		const refused = observer?.beforeCorrection?.({ attempt, separation, dx, dy, ...destination })
		if (refused !== undefined) return failedOperationResult('unexpectedState', refused)

		observer?.step?.('correcting', attempt)

		if (syncMount) {
			const synced = await mountCommander.sync(context, mount, j2000(solution.rightAscension, solution.declination), { time })
			if (!synced.ok) return synced
		}

		// The tolerance below the measured error makes the commander slew instead of answering "already there".
		const slewed = await mountCommander.goTo(context, mount, j2000(destination.rightAscension, destination.declination), { ...options.slew, tolerance, time })
		if (!slewed.ok) return slewed

		corrections++
		observer?.step?.('settling', attempt)

		const settled = await clock.delay(settle * 1000, context.signal)
		if (!settled.ok) return settled
	}

	return failedOperationResult('unexpectedState', 'no centering attempt ran')
}

// Returns whether a measurement taken after a correction is no closer to the target than the one before it, both in
// radians. `previous` is undefined for the first measurement of a centering, which follows no correction.
export function centeringStalled(previous: Angle | undefined, separation: Angle) {
	return previous !== undefined && separation >= previous
}

// Captures the auxiliary frame of `attempt` and solves it cooperatively; resolves the finite solution, undefined when
// the frame did not solve, or the failure of the capture, of the solve timeout, of a faulted solver or of the
// cancellation. The file is disposed of only after the solve ended, whatever its outcome.
async function captureAndSolve(context: OperationContext, mount: Mount, camera: Camera, attempt: number, options: CenteringOptions, services: CenteringServices): Promise<OperationResult<PlateSolution | undefined>> {
	const { cameraCapturer, solver, clock, solverHealth, observer } = services
	const path = services.auxiliaryPath(attempt)
	const request = centeringCaptureRequest(options.capture, path, mount)

	try {
		observer?.step?.('exposing', attempt)

		const captured = await cameraCapturer.start(context, camera, request, { clock, listener: observer?.captureListener }).result
		if (!captured.ok) return captured

		const { frames } = captured.value
		if (frames.length !== 1) return failedOperationResult('unexpectedState', `an auxiliary capture produced ${frames.length} frames`)

		observer?.step?.('solving', attempt)

		const frame: CenteringFrame = { path, observedAt: exposureMidpoint(frames[0], request) }
		const outcome = await awaitCooperativeJob((signal) => solver(frame, signal), { signal: context.signal, timeout: options.solveTimeout * 1000, abortGrace: options.abortGrace * 1000, delay: clock.delay, health: solverHealth })
		return solveResult(outcome, context.signal, options.solveTimeout)
	} finally {
		if (options.auxiliary !== 'keep') await removeAuxiliary(path)
	}
}

// Result of one solve: the finite solution, undefined for a frame that did not solve (no solution, a non-finite
// center, a rejection), or the failure of a timeout (`solveTimeout` in seconds), a cancellation or a faulted solver.
// Shared with the polar-alignment runner, whose solves follow the same cooperative contract.
export function solveResult(outcome: CooperativeJobOutcome<PlateSolution | undefined>, signal: AbortSignal, solveTimeout: number): OperationResult<PlateSolution | undefined> {
	switch (outcome.kind) {
		case 'resolved': {
			const solution = outcome.value
			// The solver is a boundary: a solution without a finite center is no solution.
			return successfulOperationResult(solution !== undefined && Number.isFinite(solution.rightAscension) && Number.isFinite(solution.declination) ? solution : undefined)
		}
		case 'rejected':
			return successfulOperationResult(undefined)
		case 'timeout':
			return signal.aborted ? failedOperationResult(abortReason(signal)) : failedOperationResult('timeout', `plate solve did not finish in ${solveTimeout} s`)
		case 'aborted':
			return failedOperationResult(abortReason(signal))
		case 'faulted':
			return failedOperationResult('unexpectedState', 'the plate solver is faulted')
	}
}

// Capture request of one auxiliary frame at `path`: the camera settings with every operational field fixed (one
// FITS frame, auto-saved under the exact name) and the mount snooped so the solver may read its pointing hint.
export function centeringCaptureRequest(capture: CenteringCaptureOptions, path: string, mount: Pick<Mount, 'name'>): CameraCaptureStart {
	const { exposureTime, exposureTimeUnit, frameType, x, y, width, height, subframe, binX, binY, frameFormat, gain, offset, compressed } = capture

	return {
		...DEFAULT_CAMERA_CAPTURE_START,
		exposureTime,
		exposureTimeUnit,
		frameType,
		x,
		y,
		width,
		height,
		subframe,
		binX,
		binY,
		frameFormat,
		gain,
		offset,
		compressed,
		exposureMode: 'single',
		count: 1,
		delay: 0,
		transferFormat: 'FITS',
		autoSave: true,
		autoSubFolderMode: 'off',
		outputPath: dirname(path),
		outputName: basename(path),
		mount: mount.name,
	}
}

// Astronomical midpoint of an exposure, in Unix ms: the wall instant of its first observed Busy plus half the
// requested exposure time. Never the mean of the observed start and end, whose end includes the readout.
export function exposureMidpoint(frame: Pick<CameraFrameEvent, 'exposureStartedAt'>, request: Pick<CameraCaptureStart, 'exposureTime' | 'exposureTimeUnit'>) {
	return frame.exposureStartedAt + exposureTimeInMilliseconds(request.exposureTime, request.exposureTimeUnit) / 2
}

// J2000 mount target.
function j2000(rightAscension: Angle, declination: Angle) {
	return { type: 'J2000' as const, J2000: { x: rightAscension, y: declination } }
}

// Removes an auxiliary file, if any. Best effort: a file left behind is never read again and the owner of the
// auxiliary directory clears it on its next run.
async function removeAuxiliary(path: string) {
	try {
		await unlink(path)
	} catch {
		// Missing (the capture never wrote it) or not removable now.
	}
}
