import type { MountCommander } from '../../devices/commanders/mount'
import type { Camera, Mount } from '../../devices/indi/device'
import { failedOperationResult, type OperationContext, type OperationResult, type OperationScope, successfulOperationResult } from '../../devices/orchestration/operation'
import type { CameraCapturer, CameraCaptureHandle } from '../capture/capture'
import type { CameraFrameEvent } from '../capture/types'
import { type CenteringCaptureOptions, type CenteringClock, centeringCaptureRequest } from '../mount/centering'
import { DEFAULT_DARV_LEADING_MARGIN, darvExposureTime } from './polaralignment.darv'
import type { PolarAlignmentDirection } from './polaralignment.geometry'
import { polarAlignmentMountRefusal } from './polaralignment.runner'

// One DARV (Drift Alignment by Robert Vice) measurement, reusable outside the application: the
// runner applies a slew-rate preset, opens one exposure long enough for the whole sequence, and while
// the shutter is open waits a stationary lead, moves the mount in RA one way for the leg duration,
// stops, moves back for the same duration and stops, so every star draws an outbound and a return
// trail whose separation is the declination drift caused by the polar error. It neither solves nor
// analyzes the frame; `analyzeDarvImage` takes the measured timing it reports.
//
// The runner leases nothing itself: the commander and the capturer lease the mount and the camera
// per command, so a caller that holds both in its own operation runs every step as a nested scope.
// It changes the slew rate and reports the preset it replaced through its listener, but never
// restores it, as in the three-point runner. Configured durations are seconds; instants come from
// the monotonic domain of the clock, in milliseconds, shared with the capturer.

// Camera settings of the DARV frame; the exposure time is derived from the timing, and the frame
// type is always LIGHT.
export type DarvCaptureOptions = Omit<CenteringCaptureOptions, 'exposureTime' | 'exposureTimeUnit' | 'frameType'>

// Settings of one measurement; every duration is in seconds.
export interface DarvRunOptions {
	// Direction of the outbound RA motion; the return goes the other way.
	readonly direction: PolarAlignmentDirection
	// Name of the slew-rate preset of the motions; one the mount announces.
	readonly slewRate: string
	// Duration of each RA motion; finite > 0.
	readonly legDuration: number
	// Camera settings of the frame.
	readonly capture: DarvCaptureOptions
	// Stationary wait before the outbound motion; finite ≥ 0. Default `DEFAULT_DARV_LEADING_MARGIN` (polaralignment.darv).
	readonly leadingMargin?: number
	// Budget of the turn; finite ≥ 0. Default `DEFAULT_DARV_TURNAROUND_MARGIN`.
	readonly turnaroundMargin?: number
	// Budget after the return motion; finite ≥ 0. Default `DEFAULT_DARV_TRAILING_MARGIN`.
	readonly trailingMargin?: number
}

// Phase of a measurement, in order of occurrence.
export type DarvRunPhase = 'exposing' | 'outbound' | 'reversing' | 'inbound' | 'finishing'

// Synchronous progress of a run, in order of occurrence.
export type DarvRunEvent =
	| {
			readonly type: 'slewRate'
			// Preset the mount used before the run changed it, or undefined when it reported none.
			readonly previous?: string
			// Preset now applied.
			readonly applied: string
	  }
	| {
			readonly type: 'phase'
			// Phase entered.
			readonly phase: DarvRunPhase
			// Monotonic instant the phase was entered, in milliseconds.
			readonly at: number
			// Requested exposure, in seconds; only on `exposing`.
			readonly exposure?: number
	  }

// Services of a run.
export interface DarvRunServices {
	// Slew rate and the timed RA motions.
	readonly mountCommander: MountCommander
	// The single exposure.
	readonly cameraCapturer: CameraCapturer
	// Clock of the motions and of the capture, which must share its monotonic domain.
	readonly clock: CenteringClock
	// Absolute path of the frame; its directory exists and the file does not. The caller owns the file.
	readonly framePath: string
	// Progress listener, called synchronously.
	readonly listener?: (event: DarvRunEvent) => void
}

// Measured timing of one DARV frame, in seconds. The five intervals add up to `exposure`, which is
// what `analyzeDarvImage` expects as its leading, outbound, turnaround, return and trailing durations.
export interface DarvRunTiming {
	// Requested shutter-open time.
	readonly exposure: number
	// From the exposure seen Busy to the outbound motion started; ≥ 0.
	readonly leading: number
	// From the outbound motion started to its stop sent.
	readonly outbound: number
	// From the outbound stop sent to the return motion started, the deceleration and restart included.
	readonly turnaround: number
	// From the return motion started to its stop sent.
	readonly inbound: number
	// Remainder of the exposure after the return stop was sent, the deceleration included; ≥ 0.
	readonly trailing: number
}

// Outcome of a successful measurement.
export interface DarvRun {
	// The written frame; its file is at `DarvRunServices.framePath`.
	readonly frame: CameraFrameEvent
	// Direction of the outbound motion.
	readonly direction: PolarAlignmentDirection
	// Measured timing.
	readonly timing: DarvRunTiming
}

// Runs one DARV measurement inside an operation `darv` of `scope`, which leases nothing itself. The
// mount must be one `polarAlignmentMountRefusal` accepts and the camera connected. The preset is
// applied and confirmed first; then the exposure starts and, once it is seen Busy, the lead, the
// outbound and the return motions run, each stopped in a `finally` that waits for the mount to be
// quiescent. Any failure or cancellation after the exposure started aborts it, so no frame of an
// incomplete sequence is produced. A return motion that ended later than the earliest possible end of
// the shutter fails as `unexpectedState`, as does a mount that disconnected or stopped tracking.
// Never rejects.
export async function runDarv(scope: OperationScope, mount: Mount, camera: Camera, options: DarvRunOptions, services: DarvRunServices): Promise<OperationResult<DarvRun>> {
	return await scope.start<DarvRun>('darv', [], (context) => measurement(context, mount, camera, options, services)).result
}

// The measurement inside its operation.
async function measurement(context: OperationContext, mount: Mount, camera: Camera, options: DarvRunOptions, services: DarvRunServices): Promise<OperationResult<DarvRun>> {
	if (!camera.connected) return failedOperationResult('disconnected')
	const refused = polarAlignmentMountRefusal(mount, options.slewRate)
	if (refused) return failedOperationResult(refused === 'disconnected' ? 'disconnected' : 'unexpectedState', refused === 'disconnected' ? undefined : refused)

	const { mountCommander, cameraCapturer, clock, listener } = services
	const leadingMargin = options.leadingMargin ?? DEFAULT_DARV_LEADING_MARGIN
	const exposure = darvExposureTime(options.legDuration, leadingMargin, options.turnaroundMargin, options.trailingMargin)
	const previous = mount.slewRate

	const applied = await mountCommander.setSlewRate(context, mount, options.slewRate)
	if (!applied.ok) return applied
	listener?.({ type: 'slewRate', previous, applied: options.slewRate })

	const request = centeringCaptureRequest({ ...options.capture, exposureTime: exposure, exposureTimeUnit: 'second', frameType: 'LIGHT' }, services.framePath, mount)
	listener?.({ type: 'phase', phase: 'exposing', at: clock.monotonicNow(), exposure })
	const capture = cameraCapturer.start(context, camera, request, { clock })
	let completed = false

	try {
		const started = await capture.started
		if (!started.ok) return started

		const lead = await clock.delay(leadingMargin * 1000, context.signal)
		if (!lead.ok) return lead

		const reverse = options.direction === 'WEST' ? 'EAST' : 'WEST'
		const outbound = await leg(context, mountCommander, mount, options.direction, options.legDuration, clock, (at) => listener?.({ type: 'phase', phase: 'outbound', at }))
		if (!outbound.ok) return outbound

		const changed = trackingLost(mount)
		if (changed) return changed

		listener?.({ type: 'phase', phase: 'reversing', at: outbound.value.stoppedAt })
		const inbound = await leg(context, mountCommander, mount, reverse, options.legDuration, clock, (at) => listener?.({ type: 'phase', phase: 'inbound', at }))
		if (!inbound.ok) return inbound

		const lost = trackingLost(mount)
		if (lost) return lost

		listener?.({ type: 'phase', phase: 'finishing', at: clock.monotonicNow() })
		const captured = await capture.result
		completed = true
		if (!captured.ok) return captured

		const { frames } = captured.value
		if (frames.length !== 1) return failedOperationResult('unexpectedState', `a DARV capture produced ${frames.length} frames`)
		const frame = frames[0]

		// The shutter may have opened as early as the command was sent, so the motion must have ended by then
		// plus the exposure; otherwise the frame holds only part of the return trail.
		const opened = frame.exposureDispatchedMonotonic ?? frame.exposureStartedMonotonic
		if (inbound.value.settledAt > opened + exposure * 1000) return failedOperationResult('unexpectedState', 'the exposure may have ended before the mount stopped')

		const shutter = frame.exposureStartedMonotonic
		const leading = Math.max(0, outbound.value.startedAt - shutter) / 1000
		const outboundDuration = (outbound.value.stoppedAt - outbound.value.startedAt) / 1000
		const turnaround = (inbound.value.startedAt - outbound.value.stoppedAt) / 1000
		const inboundDuration = (inbound.value.stoppedAt - inbound.value.startedAt) / 1000
		const trailing = Math.max(0, exposure - leading - outboundDuration - turnaround - inboundDuration)
		const timing: DarvRunTiming = { exposure: leading + outboundDuration + turnaround + inboundDuration + trailing, leading, outbound: outboundDuration, turnaround, inbound: inboundDuration, trailing }

		return successfulOperationResult({ frame, direction: options.direction, timing })
	} finally {
		if (!completed) await abortCapture(capture)
	}
}

// Instants of one motion, in monotonic milliseconds.
interface DarvLegInstants {
	// The motion was started.
	readonly startedAt: number
	// The stop was sent.
	readonly stoppedAt: number
	// The mount was reported quiescent after the stop.
	readonly settledAt: number
}

// Moves the mount in `direction` for `duration` seconds, then stops it and waits until it is
// quiescent; the stop is sent even when the wait is cancelled. `onStarted` receives the monotonic
// instant the motion started. Resolves the instants of the motion or the first failure.
async function leg(context: OperationContext, mountCommander: MountCommander, mount: Mount, direction: PolarAlignmentDirection, duration: number, clock: CenteringClock, onStarted: (at: number) => void): Promise<OperationResult<DarvLegInstants>> {
	const started = await mountCommander.startManualMove(context, mount, direction)
	if (!started.ok) return started
	const startedAt = clock.monotonicNow()
	onStarted(startedAt)

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

// Failure of a mount that left the state a DARV frame assumes (connected and tracking), or undefined.
function trackingLost(mount: Mount): OperationResult<never> | undefined {
	if (!mount.connected) return failedOperationResult('disconnected')
	if (!mount.tracking) return failedOperationResult('unexpectedState', `mount ${mount.name} stopped tracking`)
	return undefined
}

// Aborts the exposure of an incomplete sequence and waits until the camera is released.
async function abortCapture(capture: CameraCaptureHandle) {
	await capture.cancel()
	await capture.result
}
