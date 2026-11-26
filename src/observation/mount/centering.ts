import { unlink } from 'fs/promises'
import { basename, dirname } from 'path'
import type { Parity, PlateSolution } from '../../astrometry/solvers/platesolver'
import { imageTopPositionAngleAt } from '../../astrometry/wcs/orientation'
import { angularDistance, equatorialToJ2000 } from '../../astronomy/coordinates/coordinate'
import { timeUnix } from '../../astronomy/time/time'
import { PI, TAU } from '../../core/constants'
import type { MountCommander, MountCommandOptions } from '../../devices/commanders/mount'
import { reachableRotatorAngle, type RotatorCommander, type RotatorCommandOptions } from '../../devices/commanders/rotator'
import type { Camera, Mount, Rotator } from '../../devices/indi/device'
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
// Optionally the same loop brings the field to a requested orientation, the position angle of the image top (PA, from
// north through east, ICRS, imageTopPositionAngleAt) measured at the pixel of the target, and turns a rotator to reach
// it. The rotator is closed-loop: for θ = s·M + φ (M the mechanical angle the driver reports, in degrees) the required
// move from one measurement is M + s·e, so only the sense s is needed, never the offset φ, and the driver's angle is
// never synced. An unknown sense is learned from a small probe; every rotation is followed by a response check that
// the field turned with the rotator, which learns or corrects the sense or fails. Within an iteration the rotator turns
// before the mount is corrected, and a frame taken after the last motion of either proves both position and
// orientation. With halfTurn, θ and θ + π are the same framing, so the rotator never travels more than a quarter turn
// past its limits and a meridian flip leaves the orientation satisfied.
//
// Conventions: angles in radians, rotator angles in degrees, configured durations in seconds turned into milliseconds
// only at the clock or the commander, wall instants in Unix ms. Each iteration allocates its capture request and a few
// small objects.

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
	// Orientation to reach and verify besides the position; absent centers the position only.
	readonly orientation?: CenteringOrientation
	// Rotator that turns the camera toward the orientation; ignored without one. Absent, the orientation is only measured.
	readonly rotation?: CenteringRotation
}

// Requested orientation of a centering.
export interface CenteringOrientation {
	// Position angle of the image top, from north through east, ICRS, in radians, [0, 2π).
	readonly positionAngle: Angle
	// Accepted absolute difference between the measured and the requested position angle, in radians; finite > 0.
	readonly tolerance: Angle
	// Whether θ and θ + π are the same framing (a rectangular sensor); the error is then wrapped to (−π/2, π/2].
	readonly halfTurn: boolean
}

// Sense of a rotator: the sign of the change of the sky position angle of the image top per mechanical degree, and the
// parity of the frames it was learned from, since a mirror added or removed from the optical train reverses it.
export interface CenteringRotationSense {
	// +1 when the PA grows with the mechanical angle, −1 when it shrinks.
	readonly value: 1 | -1
	// Parity of the frames the sense was learned from; absent when unknown, which never discards it.
	readonly parity?: Parity
}

// Rotator a centering turns, with what is known about it.
export interface CenteringRotation {
	// Rotator carrying the camera; idle when the centering starts.
	readonly rotator: Rotator
	// Known sense; absent probes it. Discarded before any rotation when a solution's parity differs from its own.
	readonly sense?: CenteringRotationSense
	// Bounds of the probe that learns an unknown sense, in mechanical degrees; default 2 and 10. The probe turns by the
	// error clamped to them.
	readonly probe?: { readonly minimum: number; readonly maximum: number }
	// Timing of the rotations, in ms, passed to `RotatorCommander.moveTo`.
	readonly move?: Pick<RotatorCommandOptions, 'timeout' | 'settleTimeout'>
}

// What a response check after a rotation found: the sense it learned, corrected, or confirmed, with its evidence.
export interface CenteringRotationCheck {
	// Iteration whose measurement followed the rotation, 1-based.
	readonly attempt: number
	// Sense in force after the check.
	readonly sense: 1 | -1
	// Parity of the frame that checked it.
	readonly parity: Parity
	// Measured change of the PA per commanded change of the mechanical angle, in the sense's direction: about 1 for a
	// rotator carrying the camera.
	readonly gain: number
	// learned when no sense was known, relearned when the known one was reversed, confirmed when it held.
	readonly source: 'learned' | 'relearned' | 'confirmed'
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
export type CenteringStep = 'exposing' | 'solving' | 'rotating' | 'correcting' | 'settling'

// Outcome of one capture-and-solve iteration. Every field past `rotatorAngle` is absent when the frame did not solve.
export interface CenteringMeasurement {
	// Iteration, 1-based.
	readonly attempt: number
	// Mechanical angle of the rotator during the exposure, in degrees; absent without a rotation.
	readonly rotatorAngle?: number
	// Solution of the frame.
	readonly solution?: PlateSolution
	// Great-circle distance between the solved center and the target, in radians.
	readonly separation?: Angle
	// Eastward offset of the solved center from the target on the plane tangent at the target, in radians.
	readonly dx?: number
	// Northward offset of the solved center from the target on the plane tangent at the target, in radians.
	readonly dy?: number
	// Position angle of the image top at the target's pixel, ICRS, in radians, [0, 2π); absent without an orientation.
	readonly positionAngle?: Angle
	// Requested minus measured position angle, in radians, wrapped as the orientation asks; absent without one.
	readonly positionAngleError?: Angle
}

// Correction a centering is about to command: a rotation, a mount correction, or both, the rotation first.
export interface CenteringCorrection {
	// Iteration, 1-based.
	readonly attempt: number
	// Great-circle distance between the solved center and the target, in radians.
	readonly separation: Angle
	// Eastward offset of the solved center from the target on the plane tangent at the target, in radians.
	readonly dx: number
	// Northward offset of the solved center from the target on the plane tangent at the target, in radians.
	readonly dy: number
	// Requested minus measured position angle, in radians; absent without an orientation.
	readonly positionAngleError?: Angle
	// Where the mount will be sent, J2000, in radians; absent when the position is within tolerance.
	readonly mount?: { readonly rightAscension: Angle; readonly declination: Angle }
	// Mechanical angles the rotator turns between, in degrees; absent when the orientation needs no rotation.
	readonly rotator?: { readonly from: number; readonly to: number }
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
	// Receives every response check that passed after a rotation, before the measurement that made it is judged.
	readonly rotationChecked?: (check: CenteringRotationCheck) => void
	// Told that the requested orientation lies outside the rotator's limits, right before the centering fails for it.
	readonly rotationUnreachable?: () => void
}

// Services of a centering.
export interface CenteringServices {
	// Sync and corrective slews.
	readonly mountCommander: MountCommander
	// Rotations; required with `CenteringOptions.rotation`.
	readonly rotatorCommander?: RotatorCommander
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
	// Position angle of the image top of the last solution, ICRS, in radians; absent without an orientation.
	readonly positionAngle?: Angle
	// Requested minus measured position angle of the last solution, in radians; absent without an orientation.
	readonly positionAngleError?: Angle
	// Sense of the rotator in force at the end, known or learned; absent when none was known or learned.
	readonly sense?: 1 | -1
}

// Default bounds of the probe that learns an unknown rotation sense, in mechanical degrees.
const DEFAULT_PROBE = { minimum: 2, maximum: 10 } as const

// Relative part of the response check: the measured change of the PA may differ from the commanded rotation by this
// fraction of it (provisional), absorbing the pivot shift and the stop a step away.
const RESPONSE_RELATIVE_TOLERANCE = 0.15

// Absolute part of the response check, in degrees (provisional): the noise of two PA measurements and a rotator step.
const RESPONSE_ABSOLUTE_TOLERANCE = 0.5

// Smallest rotation, in degrees, a response check judges; a smaller one cannot tell the sense from the noise.
const RESPONSE_MINIMUM_ROTATION = 1e-3

// Returns the requested minus the measured position angle, both in radians, wrapped to (−π/2, π/2] when θ and θ + π are
// the same framing (halfTurn), else to (−π, π].
export function positionAngleError(requested: Angle, measured: Angle, halfTurn: boolean): Angle {
	const period = halfTurn ? PI : TAU
	let error = (requested - measured) % period
	if (error > period / 2) error -= period
	else if (error <= -period / 2) error += period
	return error
}

// Centers `mount` on `target` inside an operation `centering` of `scope`, which leases nothing itself: the capturer
// and the commanders lease camera, mount and rotator per command. Each iteration captures the auxiliary frame of its
// attempt, solves it cooperatively with the signal of the operation, disposes of the file after the solve, and either
// succeeds (distance ≤ tolerance, and the orientation within its tolerance when one is asked), fails (last attempt), or
// corrects: first a rotation toward the orientation, when one is asked, a rotator given and the error over tolerance,
// then, when the position is off, a sync to the solved center and a slew to the target, or without sync a slew from the
// reported position against the measured error, both J2000 with `MountCommandOptions.time` read from the clock, then
// the mechanical settle. A frame without a solution (undefined, non-finite, a rejected solve, or a WCS whose
// orientation cannot be measured when one is asked) consumes its attempt without commanding anything.
// Failures: the capture, mount or rotator failure as is; 'timeout' when a solve timed out; 'commandFailed' when no
// attempt solved or `maximumUnsolved` frames in a row did not; 'unexpectedState' when the last solution is still off
// target or orientation with no attempt or correction left, the distance or the orientation error stalled for
// `stallLimit` corrections, the observer refused a correction, the orientation lies outside the rotator's limits, the
// field did not turn with the rotator, or the solver is faulted; the reason of the operation signal when cancelled.
// Never rejects.
export async function centerTarget(scope: OperationScope, mount: Mount, camera: Camera, target: CenteringTarget, options: CenteringOptions, services: CenteringServices): Promise<OperationResult<CenteringResult>> {
	return await scope.start<CenteringResult>('centering', [], (context) => centeringLoop(context, mount, camera, target, options, services)).result
}

// Measurement before the latest rotation, which the response check of the next solved frame compares with.
interface RotationReference {
	// Position angle of the image top measured before the rotation, in radians.
	readonly positionAngle: Angle
	// Mechanical angle of that exposure, in degrees.
	readonly angle: number
}

// Iterations of one centering inside its operation.
async function centeringLoop(context: OperationContext, mount: Mount, camera: Camera, target: CenteringTarget, options: CenteringOptions, services: CenteringServices): Promise<OperationResult<CenteringResult>> {
	const { tolerance, maximumAttempts, maximumCorrections = maximumAttempts - 1, maximumUnsolved, stallLimit, settle, syncMount, orientation } = options
	const { mountCommander, rotatorCommander, clock, observer } = services
	const rotation = orientation === undefined ? undefined : options.rotation
	const rotator = rotation?.rotator
	// The types cannot tie the commander to the rotation, and a rotation without one would never turn.
	if (rotation !== undefined && rotatorCommander === undefined) return failedOperationResult('unexpectedState', 'a rotation needs a rotator commander')

	let unsolved = 0
	let unsolvedInARow = 0
	let corrections = 0
	let stalled = 0
	let orientationStalled = 0
	let previous: Angle | undefined
	let previousError: Angle | undefined
	// What the latest correction moved, so its next measurement judges only the stall of what it moved.
	let mountMoved = false
	let rotated = false
	let sense = rotation?.sense
	let reference: RotationReference | undefined

	for (let attempt = 1; attempt <= maximumAttempts; attempt++) {
		// The rotator is idle here: the loop exposes only once a rotation completed.
		const rotatorAngle = rotator?.angle.value
		const solved = await captureAndSolve(context, mount, camera, attempt, options, services)
		if (!solved.ok) return solved

		const solution = solved.value
		const positionAngle = solution !== undefined && orientation !== undefined ? imageTopPositionAngleAt(solution, target.rightAscension, target.declination) : undefined

		if (solution === undefined || (orientation !== undefined && positionAngle === undefined)) {
			unsolved++
			unsolvedInARow++
			observer?.measured?.({ attempt, ...(rotatorAngle !== undefined && { rotatorAngle }) })
			if (attempt === maximumAttempts) return failedOperationResult('commandFailed', `no plate solution in ${unsolved} of ${maximumAttempts} attempts`)
			if (unsolvedInARow === maximumUnsolved) return failedOperationResult('commandFailed', `no plate solution in ${unsolvedInARow} frames in a row`)
			continue
		}

		unsolvedInARow = 0

		const separation = angularDistance(target.rightAscension, target.declination, solution.rightAscension, solution.declination)
		const { dx, dy } = computePointingError(target.rightAscension, target.declination, solution.rightAscension, solution.declination)
		const error = positionAngle !== undefined ? positionAngleError(orientation!.positionAngle, positionAngle, orientation!.halfTurn) : undefined

		// A mirror added to or removed from the optical train reverses a sense learned without it.
		if (sense?.parity !== undefined && sense.parity !== solution.parity) sense = undefined

		// Whether this frame learned or reversed the sense, whose error then follows a probe or a move the wrong way.
		let senseChanged = false

		if (reference !== undefined && positionAngle !== undefined && rotatorAngle !== undefined) {
			const before = reference
			reference = undefined
			const commanded = normalizeDegrees(rotatorAngle - before.angle)

			if (Math.abs(commanded) >= RESPONSE_MINIMUM_ROTATION) {
				const turned = toDeg(positionAngleError(positionAngle, before.positionAngle, false))
				const check = responseCheck(attempt, turned, commanded, sense?.value, solution.parity)
				if (check === undefined) return failedOperationResult('unexpectedState', `the field did not turn with rotator ${rotator!.name}: it turned ${turned.toFixed(2)}° for a rotation of ${commanded.toFixed(2)}°`)

				if (check !== 'inconclusive') {
					senseChanged = check.source !== 'confirmed'
					sense = { value: check.sense, parity: check.parity }
					observer?.rotationChecked?.(check)
				}
			}
		}

		observer?.measured?.({ attempt, ...(rotatorAngle !== undefined && { rotatorAngle }), solution, separation, dx, dy, ...(positionAngle !== undefined && { positionAngle }), ...(error !== undefined && { positionAngleError: error }) })

		const positionOk = separation <= tolerance
		const orientationOk = error === undefined || Math.abs(error) <= orientation!.tolerance

		if (positionOk && orientationOk) return successfulOperationResult({ attempts: attempt, separation, solution, ...(positionAngle !== undefined && { positionAngle }), ...(error !== undefined && { positionAngleError: error }), ...(sense !== undefined && { sense: sense.value }) })
		if (attempt === maximumAttempts || corrections === maximumCorrections) return failedOperationResult('unexpectedState', `${offTarget(separation, positionOk, error, orientationOk)} after ${attempt} attempts`)
		if (!orientationOk && rotation === undefined) return failedOperationResult('unexpectedState', `${offTarget(separation, positionOk, error, orientationOk)}, and no rotator turns the camera`)

		if (!positionOk && mountMoved) {
			stalled = centeringStalled(previous, separation) ? stalled + 1 : 0
			if (stalled === stallLimit) return failedOperationResult('unexpectedState', `the distance to the target did not shrink in ${stalled} corrections`)
		}

		previous = separation

		// A probe, or a move made with a sense this frame reversed, may well have grown the error.
		if (!orientationOk && rotated && !senseChanged) {
			orientationStalled = centeringStalled(previousError === undefined ? undefined : Math.abs(previousError), Math.abs(error)) ? orientationStalled + 1 : 0
			if (orientationStalled === stallLimit) return failedOperationResult('unexpectedState', `the orientation error did not shrink in ${orientationStalled} rotations`)
		}

		let turn: { readonly from: number; readonly to: number } | undefined

		if (!orientationOk) {
			const to = plannedRotation(rotator!, rotatorAngle!, toDeg(error), orientation!.halfTurn, sense?.value, rotation!.probe ?? DEFAULT_PROBE)

			if (to === undefined) {
				observer?.rotationUnreachable?.()
				return failedOperationResult('unexpectedState', `PA ${toDeg(orientation!.positionAngle).toFixed(2)}° is outside the limits of rotator ${rotator!.name} (${rotator!.angle.min}° to ${rotator!.angle.max}°)`)
			}

			turn = { from: rotatorAngle!, to }
		}

		// One conversion instant for the whole correction, read from the wall clock of the caller.
		const time = timeUnix(clock.wallNow() / 1000)
		let destination: { rightAscension: Angle; declination: Angle } | undefined

		if (!positionOk) {
			destination = { rightAscension: target.rightAscension, declination: target.declination }

			if (!syncMount) {
				if (!mount.hasEquatorialCoordinate) return failedOperationResult('unexpectedState', `mount ${mount.name} publishes no position to correct from`)
				// Where the mount believes it points, in J2000 at the instant of the slew below.
				const [rightAscension, declination] = equatorialToJ2000(mount.equatorialCoordinate.rightAscension, mount.equatorialCoordinate.declination, time)
				// The sky stands at the measured error from what the mount reports, so the mount is sent from where it believes
				// it is by the offset that brings the solved center onto the target, both in the tangent basis.
				destination = applyPointingOffset(rightAscension, declination, -dx, -dy)
			}
		}

		const refused = observer?.beforeCorrection?.({ attempt, separation, dx, dy, ...(error !== undefined && { positionAngleError: error }), ...(destination !== undefined && { mount: destination }), ...(turn !== undefined && { rotator: turn }) })
		if (refused !== undefined) return failedOperationResult('unexpectedState', refused)

		rotated = turn !== undefined
		mountMoved = destination !== undefined

		if (turn !== undefined) {
			observer?.step?.('rotating', attempt)
			// Kept before the motion: a rotation that fails half-way is never judged, the loop ends with it.
			reference = { positionAngle: positionAngle!, angle: rotatorAngle! }
			previousError = error
			const turned = await rotatorCommander!.moveTo(context, rotator!, turn.to, rotation!.move)
			if (!turned.ok) return turned
		}

		if (destination !== undefined) {
			observer?.step?.('correcting', attempt)

			if (syncMount) {
				const synced = await mountCommander.sync(context, mount, j2000(solution.rightAscension, solution.declination), { time })
				if (!synced.ok) return synced
			}

			// The tolerance below the measured error makes the commander slew instead of answering "already there".
			const slewed = await mountCommander.goTo(context, mount, j2000(destination.rightAscension, destination.declination), { ...options.slew, tolerance, time })
			if (!slewed.ok) return slewed
		}

		corrections++
		observer?.step?.('settling', attempt)

		const settled = await clock.delay(settle * 1000, context.signal)
		if (!settled.ok) return settled
	}

	return failedOperationResult('unexpectedState', 'no centering attempt ran')
}

// Returns the response check of a rotation: the field turned by `turned` degrees (measured change of the PA, (−180,
// 180]) for a commanded change of the mechanical angle of `commanded` degrees (non-zero). The check passes when the
// field turned by ±commanded within RESPONSE_RELATIVE_TOLERANCE of it plus RESPONSE_ABSOLUTE_TOLERANCE, and the sign
// that fits is the sense: an unknown one is learned and a known one reversed by it. A rotation too small for only one
// sign to fit is inconclusive and changes nothing. Returns undefined when neither fits: the rotator does not carry
// this camera, or it slips.
export function responseCheck(attempt: number, turned: number, commanded: number, known: 1 | -1 | undefined, parity: Parity): CenteringRotationCheck | 'inconclusive' | undefined {
	const bound = RESPONSE_RELATIVE_TOLERANCE * Math.abs(commanded) + RESPONSE_ABSOLUTE_TOLERANCE
	const positive = Math.abs(turned - commanded) <= bound
	const negative = Math.abs(turned + commanded) <= bound
	if (!positive && !negative) return undefined
	if (positive && negative) return 'inconclusive'
	const observed: 1 | -1 = positive ? 1 : -1
	const source = known === undefined ? 'learned' : known === observed ? 'confirmed' : 'relearned'
	return { attempt, sense: observed, parity, gain: turned / (observed * commanded), source }
}

// Returns the mechanical angle, in degrees, a rotator standing at `from` degrees must be sent to for an orientation error
// of `error` degrees (requested minus measured PA), or undefined when no reachable angle corrects it. With a known sense
// s, the candidates are from + s·(error + k·period), period 180° with halfTurn (k ∈ {−1, 0, 1}) and 360° without, and the
// reachable one with the shortest travel wins. Without a sense, a probe of the error clamped to `probe` turns the way of
// the error's sign, or the other way when only that one is reachable, and is refused only when the orientation is
// reachable with neither sense.
export function plannedRotation(rotator: Pick<Rotator, 'angle'>, from: number, error: number, halfTurn: boolean, sense: 1 | -1 | undefined, probe: { readonly minimum: number; readonly maximum: number }): number | undefined {
	if (sense !== undefined) return shortestRotation(rotator, from, error, halfTurn, sense)
	if (shortestRotation(rotator, from, error, halfTurn, 1) === undefined && shortestRotation(rotator, from, error, halfTurn, -1) === undefined) return undefined

	const step = Math.min(Math.max(Math.abs(error), probe.minimum), probe.maximum)
	const sign = error >= 0 ? 1 : -1
	return reachableRotatorAngle(rotator, from + sign * step) ?? reachableRotatorAngle(rotator, from - sign * step)
}

// Returns the reachable mechanical angle, in degrees, of shortest travel from `from` that corrects an error of `error`
// degrees with the sense `sense`, or undefined when none is reachable (see plannedRotation).
function shortestRotation(rotator: Pick<Rotator, 'angle'>, from: number, error: number, halfTurn: boolean, sense: 1 | -1) {
	const period = halfTurn ? 180 : 360
	let best: number | undefined

	for (let k = -1; k <= 1; k++) {
		const to = reachableRotatorAngle(rotator, from + sense * (error + k * period))
		if (to !== undefined && (best === undefined || Math.abs(to - from) < Math.abs(best - from))) best = to
	}

	return best
}

// Returns an angle in degrees wrapped to (−180, 180].
function normalizeDegrees(angle: number) {
	const wrapped = angle % 360
	return wrapped > 180 ? wrapped - 360 : wrapped <= -180 ? wrapped + 360 : wrapped
}

// Describes what is still off: the distance to the target in arcseconds when out of tolerance, the PA error in degrees
// when out of tolerance.
function offTarget(separation: Angle, positionOk: boolean, error: Angle | undefined, orientationOk: boolean) {
	const parts: string[] = []
	if (!positionOk) parts.push(`still ${(toDeg(separation) * 3600).toFixed(1)}″ from the target`)
	if (!orientationOk) parts.push(`PA still ${toDeg(error!).toFixed(2)}° from the requested one`)
	return parts.join(' and ')
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
	const request = centeringCaptureRequest(options.capture, path, mount, options.orientation === undefined ? undefined : options.rotation?.rotator)

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
// FITS frame, auto-saved under the exact name), the mount snooped so the solver may read its pointing hint, and the
// rotator, when given, so the frame carries its angle (ROTATANG) for diagnostics; the loop itself reads the device.
export function centeringCaptureRequest(capture: CenteringCaptureOptions, path: string, mount: Pick<Mount, 'name'>, rotator?: Pick<Rotator, 'name'>): CameraCaptureStart {
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
		...(rotator !== undefined && { rotator: rotator.name }),
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
