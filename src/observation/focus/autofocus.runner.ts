import { unlink } from 'fs/promises'
import { basename, dirname } from 'path'
import type { FocuserCommandOptions, FocuserMover } from '../../devices/commanders/focuser'
import type { Camera, Focuser } from '../../devices/indi/device'
import { type FailedOperationResult, failedOperationResult, type OperationContext, type OperationResult, type OperationScope, successfulOperationResult } from '../../devices/orchestration/operation'
import { type AbortableDelay, abortReason, awaitCooperativeJob, type CooperativeJobHealth, type CooperativeJobOutcome } from '../../devices/orchestration/operation.wait'
import { resourceKey } from '../../devices/orchestration/resource'
import type { CameraCapturer } from '../capture/capture'
import { type CameraCaptureStart, type CameraCaptureClock, DEFAULT_CAMERA_CAPTURE_START } from '../capture/types'
import { AutoFocus, type AutoFocusOptions, type AutoFocusStep } from './autofocus'

// Physical loop of a camera autofocus, reusable outside the Sequencer: the `AutoFocus` state machine decides every
// focuser position, this module moves the focuser there through its mover, exposes one auxiliary FITS frame, hands
// its path to a caller-provided HFD measurer and feeds the measurement back, until the machine completes (the focuser
// is moved to the best position) or fails (the focuser is moved back to the position the machine names, its start).
//
// Every auxiliary frame is one FITS exposure (`exposureMode: 'single'`, `count: 1`, `delay: 0`,
// `transferFormat: 'FITS'`) auto-saved by the default writer of the capturer at the path the caller names, with the
// focuser snooped into its header. The measurer receives only the path of the complete file, after the capture result,
// with the signal of the `autofocus` operation; its timeout is cooperative (the signal is aborted and the measurement
// awaited to its end) and only then is the file removed or kept. A measurement that is undefined, not finite or not
// positive, or a rejected one, is an invalid point of the curve, never an exception. Curve fitting belongs to
// `AutoFocus`; star detection, Workers and plate solvers belong to the measurer of the caller. An optional listener
// observes every move, exposure, measurement and sample synchronously, with the machine and its fitted curves.
//
// A cancelled run never commands anything more: the commanders stop the motion they own, so a cancelled autofocus
// leaves the focuser quiescent at an indeterminate position, and a caller that needs the original position reads it
// before and restores it after the cancellation. Positions are focuser steps (integers sent to the commander), HFD is
// in pixels, configured durations are seconds turned into milliseconds only at the clock. Each capture allocates its
// request and a few small objects.

// Camera settings of an autofocus frame, with the names of the mount, filter wheel and rotator the driver stamps into its
// header (an absent one is cleared). Every operational field (mode, count, delay, transfer format, destination) is fixed
// by the autofocus, and the focuser snooped is always the one the run moves.
export type AutoFocusCaptureOptions = Readonly<Pick<CameraCaptureStart, 'exposureTime' | 'exposureTimeUnit' | 'frameType' | 'x' | 'y' | 'width' | 'height' | 'subframe' | 'binX' | 'binY' | 'frameFormat' | 'gain' | 'offset' | 'compressed' | 'mount' | 'wheel' | 'rotator'>>

// Frame handed to the measurer: a complete FITS file on disk, never its bytes.
export interface AutoFocusFrame {
	// Path of the FITS file; read-only, and left in place until the measurement ended.
	readonly path: string
}

// HFD measurer provided by the caller (star detection in a Worker, an external process). It must yield the event loop,
// honor the signal and stop reading the file once it settled. It resolves the half-flux diameter of the frame in pixels;
// undefined, a non-finite or a non-positive value marks the frame as an invalid point of the curve.
export type AutoFocusMeasurer = (frame: AutoFocusFrame, signal: AbortSignal) => Promise<number | undefined>

// Bounds and behavior of one autofocus run.
export interface AutoFocusRunOptions {
	// Curve-fitting options of the state machine; its upper position bound is the maximum of the focuser.
	readonly algorithm: Readonly<Omit<AutoFocusOptions, 'maxPosition'>>
	// Camera settings of the auxiliary frames.
	readonly capture: AutoFocusCaptureOptions
	// Cooperative timeout of one measurement, in seconds; finite > 0.
	readonly measureTimeout: number
	// Watchdog after an aborted measurement before the measurer is reported unresponsive, in seconds; finite > 0.
	readonly abortGrace: number
	// Disposition of each auxiliary frame once its measurement ended (or its capture failed). Default 'delete'.
	readonly auxiliary?: 'delete' | 'keep'
	// Timing of every focuser move, in ms, passed to `FocuserMover.moveTo`.
	readonly move?: FocuserCommandOptions
}

// Clock of an autofocus: `wallNow` and `monotonicNow` stamp the auxiliary captures, `delay` measures the measurement
// timeout and its watchdog in the monotonic domain, in ms.
export interface AutoFocusClock extends CameraCaptureClock {
	// Abortable wait in the monotonic domain, in ms.
	readonly delay: AbortableDelay
}

// Why the run moves the focuser: to a sample position the machine asked for, to the best focus, or back to the position
// a failure restores.
export type AutoFocusMovePurpose = 'sample' | 'best' | 'restore'

// Progress of one autofocus run, reported synchronously in the order it happens: a move before it is commanded (never
// for a target outside the focuser range), an exposure before its capture starts, a measurement before the measurer
// receives the frame, and a sample once the machine took the measurement. Positions are focuser steps, HFD in pixels,
// `capture` is the 1-based ordinal of the auxiliary frame.
export type AutoFocusRunEvent =
	| { readonly type: 'move'; readonly purpose: AutoFocusMovePurpose; readonly target: number }
	| { readonly type: 'expose'; readonly capture: number; readonly position: number; readonly path: string }
	| { readonly type: 'measure'; readonly capture: number; readonly position: number; readonly path: string }
	| {
			readonly type: 'sample'
			readonly capture: number
			readonly position: number
			// Valid HFD of the frame, in pixels; undefined for an invalid point.
			readonly hfd?: number
			// Step the machine returned for this sample.
			readonly step: AutoFocusStep
			// Machine of the run, with the curves fitted so far; read it during the call only, never mutate it.
			readonly autoFocus: AutoFocus
	  }

// Listener of the progress of a run; called synchronously, it must neither throw nor block.
export type AutoFocusRunListener = (event: AutoFocusRunEvent) => void

// Services of an autofocus run.
export interface AutoFocusServices {
	// Moves of the focuser, in its logical position counter: the focuser commander, or a service that compensates the
	// backlash of every move.
	readonly focuserMover: FocuserMover
	// Auxiliary captures.
	readonly cameraCapturer: CameraCapturer
	// HFD measurer of the auxiliary frames.
	readonly measurer: AutoFocusMeasurer
	// Absolute path of the auxiliary FITS of capture `capture` (1-based); its directory exists and the file does not.
	readonly auxiliaryPath: (capture: number) => string
	// Clock of the captures and of the measurement timeout.
	readonly clock: AutoFocusClock
	// Health of the measurer across the runs of its owner; a faulted measurer is never called again. Absent treats each
	// run alone.
	readonly measurerHealth?: CooperativeJobHealth
	// Progress of the run, such as the samples and curves of a focus chart. Absent reports nothing.
	readonly listener?: AutoFocusRunListener
}

// Outcome of a successful autofocus.
export interface AutoFocusRunResult {
	// Best focus, in steps (rounded to an integer); the focuser stands there.
	readonly position: number
	// HFD of the fitted curve at the best focus, in pixels.
	readonly hfd: number
	// Focuser position when the run started, in steps.
	readonly initialPosition: number
	// Auxiliary frames captured.
	readonly captures: number
}

// Runs one autofocus of `focuser` with `camera` inside an operation `autofocus` of `scope`, which holds the focuser for
// the whole run, so nothing outside it can move the focuser between a move and the frame measured there; the moves of
// the mover inherit that lease, and the capturer leases the camera per capture. Every position the state
// machine asks for is checked against the focuser range before the focuser moves; then one auxiliary frame is
// captured and measured cooperatively, and the measurement fed back. On COMPLETED the focuser is moved to the rounded
// best position. A failure that is not a cancellation (the curve rejected, a position out of range, a failed move,
// capture or measurement) moves the focuser back to the position the machine names (its start) before resolving; a
// cancellation commands nothing more. Failures: the move or capture failure as is; 'commandFailed' when the curve was
// rejected; 'unexpectedState' for a position outside the focuser range or a faulted measurer; 'timeout' when a
// measurement timed out; the reason of the operation signal when cancelled. Never rejects.
export async function runAutoFocus(scope: OperationScope, focuser: Focuser, camera: Camera, options: AutoFocusRunOptions, services: AutoFocusServices): Promise<OperationResult<AutoFocusRunResult>> {
	return await scope.start<AutoFocusRunResult>('autofocus', [{ key: resourceKey(focuser), device: focuser }], (context) => autoFocusLoop(context, focuser, camera, options, services)).result
}

// Captures of one autofocus inside its operation.
async function autoFocusLoop(context: OperationContext, focuser: Focuser, camera: Camera, options: AutoFocusRunOptions, services: AutoFocusServices): Promise<OperationResult<AutoFocusRunResult>> {
	if (!focuser.connected) return failedOperationResult('disconnected')

	const autoFocus = new AutoFocus({ ...options.algorithm, maxPosition: focuser.position.max })
	const initialPosition = services.focuserMover.position(focuser)
	let position = initialPosition
	let step: AutoFocusStep = autoFocus.add(position, 0)
	let captures = 0

	// A failure that is not a cancellation leaves the focuser where the machine started it.
	const fail = (failure: FailedOperationResult) => failAndRestore(context, focuser, initialPosition, failure, options, services)

	while (step.type === 'MOVE') {
		const target = step.absolute ?? position + step.relative!
		const moved = await moveWithinRange(context, focuser, target, 'sample', options, services)
		if (!moved.ok) return await fail(moved)

		position = target
		const measured = await captureAndMeasure(context, focuser, camera, ++captures, position, options, services)
		if (!measured.ok) return await fail(measured)

		step = autoFocus.add(position, measured.value ?? Number.NaN)
		services.listener?.({ type: 'sample', capture: captures, position, hfd: measured.value, step, autoFocus })
	}

	if (step.type === 'FAILED') return await failAndRestore(context, focuser, step.absolute ?? initialPosition, failedOperationResult('commandFailed', `the focus curve of ${captures} frames was rejected`), options, services)

	const best = Math.round(step.absolute!)
	const moved = await moveWithinRange(context, focuser, best, 'best', options, services)
	if (!moved.ok) return await fail(moved)

	return successfulOperationResult({ position: best, hfd: autoFocus.focusPoint?.y ?? Number.NaN, initialPosition, captures })
}

// Moves the focuser to `target` (steps) for `purpose` unless it stands there; a target outside the published range
// fails before anything is commanded or reported.
async function moveWithinRange(context: OperationContext, focuser: Focuser, target: number, purpose: AutoFocusMovePurpose, options: AutoFocusRunOptions, services: AutoFocusServices): Promise<OperationResult<void>> {
	const { min, max } = focuser.position
	if (!(target >= min && target <= max)) return failedOperationResult('unexpectedState', `focus position ${target} is outside the range [${min}, ${max}] of ${focuser.name}`)
	services.listener?.({ type: 'move', purpose, target })
	if (!focuser.moving && services.focuserMover.position(focuser) === target) return successfulOperationResult(undefined)
	return await services.focuserMover.moveTo(context, focuser, target, options.move)
}

// Resolves `failure` after moving the focuser back to `position` when the operation is still alive; a cancelled
// operation commands nothing and resolves its own reason. A failed restore is reported in the detail of `failure`.
async function failAndRestore(context: OperationContext, focuser: Focuser, position: number, failure: FailedOperationResult, options: AutoFocusRunOptions, services: AutoFocusServices): Promise<FailedOperationResult> {
	if (context.signal.aborted) return failedOperationResult(abortReason(context.signal))
	if (!focuser.connected) return failure

	const restored = await moveWithinRange(context, focuser, position, 'restore', options, services)
	if (restored.ok) return failure

	if (context.signal.aborted) return failedOperationResult(abortReason(context.signal))
	return failedOperationResult(failure.reason, `${failure.error ?? failure.reason}; the focuser was not restored to ${position}: ${restored.error ?? restored.reason}`)
}

// Captures the auxiliary frame `capture` at `position` (steps) and measures it cooperatively; resolves the HFD in
// pixels, undefined for an invalid point (no measurement, a non-finite or non-positive value, a rejection), or the
// failure of the capture, of the measurement timeout, of a faulted measurer or of the cancellation. The file is disposed
// of only after the measurement ended, whatever its outcome; a failed capture never calls the measurer.
async function captureAndMeasure(context: OperationContext, focuser: Focuser, camera: Camera, capture: number, position: number, options: AutoFocusRunOptions, services: AutoFocusServices): Promise<OperationResult<number | undefined>> {
	const { cameraCapturer, measurer, clock, measurerHealth, listener } = services
	const path = services.auxiliaryPath(capture)
	const request = autoFocusCaptureRequest(options.capture, path, focuser)

	try {
		listener?.({ type: 'expose', capture, position, path })
		const captured = await cameraCapturer.start(context, camera, request, { clock }).result
		if (!captured.ok) return captured

		const { frames } = captured.value
		if (frames.length !== 1) return failedOperationResult('unexpectedState', `an autofocus capture produced ${frames.length} frames`)

		const frame: AutoFocusFrame = { path }
		listener?.({ type: 'measure', capture, position, path })
		const outcome = await awaitCooperativeJob((signal) => measurer(frame, signal), { signal: context.signal, timeout: options.measureTimeout * 1000, abortGrace: options.abortGrace * 1000, delay: clock.delay, health: measurerHealth })
		return measureResult(outcome, context.signal, options.measureTimeout)
	} finally {
		if (options.auxiliary !== 'keep') await removeAuxiliary(path)
	}
}

// Result of one measurement: the HFD in pixels, undefined for an invalid point (no measurement, a non-finite or
// non-positive value, a rejection), or the failure of a timeout (`measureTimeout` in seconds), a cancellation or a
// faulted measurer.
function measureResult(outcome: CooperativeJobOutcome<number | undefined>, signal: AbortSignal, measureTimeout: number): OperationResult<number | undefined> {
	switch (outcome.kind) {
		case 'resolved': {
			// The measurer is a boundary: anything but a finite positive diameter is an invalid point.
			const hfd = outcome.value
			return successfulOperationResult(hfd !== undefined && Number.isFinite(hfd) && hfd > 0 ? hfd : undefined)
		}
		case 'rejected':
			return successfulOperationResult(undefined)
		case 'timeout':
			return signal.aborted ? failedOperationResult(abortReason(signal)) : failedOperationResult('timeout', `HFD measurement did not finish in ${measureTimeout} s`)
		case 'aborted':
			return failedOperationResult(abortReason(signal))
		case 'faulted':
			return failedOperationResult('unexpectedState', 'the HFD measurer is faulted')
	}
}

// Capture request of one autofocus frame at `path`: the camera settings with every operational field fixed (one FITS
// frame, auto-saved under the exact name) and the focuser snooped, so the header records the position it was taken at,
// along with the mount, filter wheel and rotator the settings name.
export function autoFocusCaptureRequest(capture: AutoFocusCaptureOptions, path: string, focuser: Pick<Focuser, 'name'>): CameraCaptureStart {
	const { exposureTime, exposureTimeUnit, frameType, x, y, width, height, subframe, binX, binY, frameFormat, gain, offset, compressed, mount, wheel, rotator } = capture

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
		mount,
		focuser: focuser.name,
		wheel,
		rotator,
	}
}

// Removes an auxiliary file, if any. Best effort: a file left behind is never read again and the owner of the auxiliary
// directory clears it on its next run.
async function removeAuxiliary(path: string) {
	try {
		await unlink(path)
	} catch {
		// Missing (the capture never wrote it) or not removable now.
	}
}
