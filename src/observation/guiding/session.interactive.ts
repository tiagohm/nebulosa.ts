import { errorMessage } from '../../core/util'
import { GUIDE_PULSE_STOP_SETTLE_TIMEOUT, type GuideOutputCommander, guidePulseReleaseBound } from '../../devices/commanders/guideoutput'
import type { Camera, GuideDirection, GuideOutput } from '../../devices/indi/device'
import { failedOperationResult, type OperationContext, type OperationFailureReason, type OperationHandle, type OperationResult, type OperationScope, successfulOperationResult } from '../../devices/orchestration/operation'
import { type AbortableDelay, abortableDelay, abortReason } from '../../devices/orchestration/operation.wait'
import { type ResourceRequest, resourceKey } from '../../devices/orchestration/resource'
import { toArcsec } from '../../math/units/angle'
import { type CameraExposureConfiguration, configureCameraExposure } from '../capture/capture'
import type { CameraCaptureClock } from '../capture/types'
import type { GuidePulseAdmission, GuiderClient, GuiderClientConnectOptions, GuiderClientHandler } from './client'
import { type DitherPhase, type DitherRequest, type DitherResult, settleOnAbort } from './ditherer'
import type { GuiderState, GuidingEvent } from './events'
// oxfmt-ignore
import { DEFAULT_GUIDING_CLOCK, type GuidingInterruptionKind, GuidingInterruptionHistory, type GuidingSettle, GuidingSettleListeners, type GuidingStartOptions, guidingSettleWaitTimeout, waitForGuidingSettle } from './session'

// Interactive guiding over the local `GuiderClient` (`InteractiveGuidingSession`): one long-lived session that begins
// with the first looped guide exposure and ends only with `stop` or the loss of a device, so preview, target
// selection, calibration, guiding, pauses and dithers all run under one root operation. Two operations carry its
// resources:
// - the root `guiding`, opened by `startLoop`, holds the physical key of the guide camera for the whole session, since
//   the client exposes the camera directly and only that lease keeps a second owner off it;
// - its child `guidingRun`, opened by `startGuiding` (or a `resume` after a releasing pause) and ended by
//   `stopGuiding`, holds the physical key of the guide output and its logical lifecycle resource, so the mount or
//   camera behind the guide output is only taken while guiding is wanted, and losing it cancels the run.
//
// Every pulse of the client goes through its pulse admission, installed closed by `beginRun` (or `startLoop`) with a
// ceiling frozen at construction (`pulseCeiling`, ms), and is dispatched through `GuideOutputCommander.dispatch` under
// the open `guidingRun`: the commander records the physical evidence of each pulse and, when the run ends, zeroes both
// axes, waits for the observed end of every pulse and blocks the key with the `guidePulse` cause while that end stays
// unobserved. Only `startGuiding` and `resume` open the gate, synchronously right before asking the client to guide;
// every pause, stop, refusal and loss closes it. Ending a run (`stopGuiding`, a releasing pause, `stop`) resolves only
// once its cleanup proved the guide output at a standstill, and fails `commandFailed` otherwise.
//
// The loss of a device of the session (the device lifecycle cancelling the root or the run) is terminal: the gate
// closes, the client pauses and stops capturing, the interruption is recorded and the session reports `lost` until
// the next `startLoop`. Pulse windows are `performance.now()` milliseconds, exposures milliseconds, distances guide
// pixels; interruptions are stamped with the clock of the last start. The session never disconnects the client it
// connected: the client belongs to its caller.

// Methods of `GuiderClient` the session uses; the client itself in production.
export type InteractiveGuidingClient = Pick<
	GuiderClient,
	| 'cameraManager'
	| 'camera'
	| 'guideOutput'
	| 'state'
	| 'connect'
	| 'addHandler'
	| 'removeHandler'
	| 'admitPulses'
	| 'maxPulseDuration'
	| 'getAppState'
	| 'getSettling'
	| 'getCalibrated'
	| 'getLockPosition'
	| 'getPixelScale'
	| 'loop'
	| 'guide'
	| 'setPaused'
	| 'stopCapture'
	| 'setExposure'
	| 'findTarget'
	| 'setLockPosition'
	| 'deselectStar'
	| 'clearCalibration'
	| 'flipCalibration'
	| 'dither'
>

// Options of an interactive guiding session.
export interface InteractiveGuidingSessionOptions {
	// Pulse ceiling of every run, in ms; default the longest pulse the client configuration allows when constructed.
	// Rounded like a dispatched pulse and frozen.
	readonly pulseCeiling?: number
	// Optics of the guide camera, passed to the client when the session connects it.
	readonly connect?: GuiderClientConnectOptions
	// Capacity of the interruption history; default `DEFAULT_GUIDING_INTERRUPTION_CAPACITY`.
	readonly interruptionCapacity?: number
	// Abortable wait of the settle timeouts; default `abortableDelay`.
	readonly delay?: AbortableDelay
}

// Options of `startLoop`.
export interface GuidingLoopOptions {
	// Guide exposure, in milliseconds; the client keeps its current one when absent.
	readonly exposure?: number
	// Sensor configuration sent to the guide camera once, before the first exposure; none is sent when absent.
	readonly camera?: CameraExposureConfiguration
	// Clock that stamps the interruptions from this start on; default `DEFAULT_GUIDING_CLOCK`.
	readonly clock?: CameraCaptureClock
}

// What a pause stops: only the corrections (exposures go on) or the whole capture.
export type GuidingPauseMode = 'corrections' | 'all'

// Options of `pause`.
export interface GuidingPauseOptions {
	// Ends the `guidingRun` too, once the pulses stopped, so the guide output is free for another operation (such as a
	// slew of the same reservation) until `resume` opens a new run.
	readonly releaseGuideOutput?: boolean
}

// Small serializable projection of the session.
export interface InteractiveGuidingSnapshot {
	// Whether the root `guiding` lives.
	readonly active: boolean
	// Whether the last session ended by losing a device, until the next `startLoop`.
	readonly lost: boolean
	// Why the last session ended, when it did not end by `stop`.
	readonly failure?: { readonly reason: OperationFailureReason; readonly detail?: string }
	// State of the client.
	readonly state: GuiderState
	// Whether a `guidingRun` holds the guide output.
	readonly guideOutputHeld: boolean
	// Whether the pulse gate is open.
	readonly pulsesAdmitted: boolean
	// Whether the client is settling.
	readonly settling: boolean
	// Whether a dither of the session is running.
	readonly dithering: boolean
	// Whether the client holds a solved calibration.
	readonly calibrated: boolean
	// Current lock position, in guide-image pixels.
	readonly lockPosition?: readonly [number, number]
	// Id of the root `guiding` while it lives.
	readonly operationId?: string
	// Id of the open `guidingRun`.
	readonly runId?: string
}

// Every direction of a guide output, zeroed by a pause.
const ALL_DIRECTIONS: readonly GuideDirection[] = ['NORTH', 'SOUTH', 'WEST', 'EAST']

// Logical lifecycle resource of a guide output: never conflicts with the physical key of the device that publishes it,
// but names the guide output as its device, so the device lifecycle cancels its owner when the guide output is lost.
export function guideOutputLifecycleKey(guideOutput: GuideOutput) {
	return `logical:guide-output:${resourceKey(guideOutput)}`
}

// A pending operation of the session while it lives.
interface PendingOperation {
	readonly handle: OperationHandle<void>
	readonly context: OperationContext
	// Ends the operation normally.
	readonly finish: VoidFunction
}

// Interactive guiding session over one `GuiderClient`, one guide camera and one guide output.
export class InteractiveGuidingSession {
	// Pulse ceiling of every run, in ms (integer ≥ 1); frozen at construction.
	readonly pulseCeiling: number
	readonly #history: GuidingInterruptionHistory
	readonly #settle = new GuidingSettleListeners()
	readonly #delay: AbortableDelay
	#admission?: GuidePulseAdmission
	// Whether `startLoop` installed the admission, so `stop` disposes of it.
	#ownsAdmission = false
	#root?: PendingOperation
	#run?: PendingOperation
	// Whether the last session ended by losing a device, until the next start.
	#lost = false
	#failure?: { readonly reason: OperationFailureReason; readonly detail?: string }
	// Clock of the last start.
	#clock: CameraCaptureClock = DEFAULT_GUIDING_CLOCK
	// Whether the client delivers its events to the session.
	#observing = false
	// Own command being issued, whose paused or guidingStopped event is not an interruption.
	#expecting?: 'pause' | 'stop'
	// Whether a dither of this session is running.
	#dithering = false
	// Whether the pause in effect interrupted a calibration, which `resume` restarts instead of continuing.
	#pausedCalibrating = false

	// Binds the session to its client, the guide camera and the guide output the client guides with, and the commander
	// of that guide output, which dispatches the pulses and proves their end.
	constructor(
		readonly client: InteractiveGuidingClient,
		readonly camera: Camera,
		readonly guideOutput: GuideOutput,
		readonly guideOutputCommander: Pick<GuideOutputCommander, 'dispatch' | 'stopPulses'>,
		readonly options: InteractiveGuidingSessionOptions = {},
	) {
		this.pulseCeiling = Math.max(1, Math.round(options.pulseCeiling ?? client.maxPulseDuration()))
		this.#history = new GuidingInterruptionHistory(options.interruptionCapacity)
		this.#delay = options.delay ?? abortableDelay
	}

	// Physical key of the guide camera, held by the root, and the physical key and lifecycle resource of the guide
	// output, held by the run; together what an owner reserves for the session.
	resources() {
		const camera: ResourceRequest = { key: resourceKey(this.camera), device: this.camera }
		const guideOutput: ResourceRequest = { key: resourceKey(this.guideOutput), device: this.guideOutput }
		const lifecycle: ResourceRequest = { key: guideOutputLifecycleKey(this.guideOutput), device: this.guideOutput }
		return { camera, guideOutput, lifecycle } as const
	}

	// Current projection of the session.
	snapshot(): InteractiveGuidingSnapshot {
		const lockPosition = this.client.getLockPosition()

		return {
			active: this.#root !== undefined,
			lost: this.#lost,
			failure: this.#failure,
			state: this.client.state,
			guideOutputHeld: this.#run !== undefined,
			pulsesAdmitted: this.#admission?.isOpen === true,
			settling: this.client.getSettling(),
			dithering: this.#dithering,
			calibrated: this.client.getCalibrated(),
			lockPosition: lockPosition === undefined ? undefined : [lockPosition[0], lockPosition[1]],
			operationId: this.#root?.context.id,
			runId: this.#run?.context.id,
		}
	}

	// Whether the last session ended by losing a device, until the next start.
	get lost() {
		return this.#lost
	}

	// Whether a pulse admission is installed (by `beginRun` or `startLoop`).
	get admitted() {
		return this.#admission !== undefined
	}

	// Id of the root `guiding` while it lives.
	operationId() {
		return this.#root?.context.id
	}

	// Installs the closed pulse admission with the frozen ceiling, dispatching through the open run, commanding
	// nothing. 'busy' when another admission (or this run) is active; 'unexpectedState' when the client configuration
	// already allows a longer pulse.
	beginRun(): OperationResult<void> {
		if (this.#admission !== undefined) return failedOperationResult('busy', 'the guiding run already began')

		let admission: GuidePulseAdmission | undefined

		try {
			admission = this.client.admitPulses(this.pulseCeiling, { dispatch: (output, direction, duration) => this.#dispatch(output, direction, duration) })
		} catch (error) {
			return failedOperationResult('unexpectedState', errorMessage(error))
		}

		if (admission === undefined) {
			const longest = this.client.maxPulseDuration()
			if (longest > this.pulseCeiling) return failedOperationResult('unexpectedState', `the guider configuration allows ${longest} ms pulses, above the ceiling of ${this.pulseCeiling} ms`)
			return failedOperationResult('busy', 'another owner holds the pulse admission of the guider')
		}

		this.#admission = admission
		return successfulOperationResult(undefined)
	}

	// Disposes of the admission, closing its gate for good. Idempotent.
	endRun() {
		this.#admission?.[Symbol.dispose]()
		this.#admission = undefined
		this.#ownsAdmission = false
	}

	// Begins the session when it does not live: installs the admission unless one was begun, connects the client when
	// needed, opens the root `guiding` under `scope` holding the guide camera, sends the sensor configuration and the
	// exposure, and starts looping. A living session only applies the exposure and loops again. Refusals undo what this
	// call installed.
	async startLoop(scope: OperationScope, options: GuidingLoopOptions = {}): Promise<OperationResult<void>> {
		const opened = await this.#open(scope, options.clock)
		if (!opened.ok) return opened

		if (options.camera !== undefined) configureCameraExposure(this.client.cameraManager, this.camera, options.camera)
		if (options.exposure !== undefined && !this.client.setExposure(options.exposure)) return failedOperationResult('unexpectedState', `invalid guide exposure: ${options.exposure} ms`)
		if (!this.client.loop()) return failedOperationResult('unexpectedState', 'the guider could not start looping')

		return successfulOperationResult(undefined)
	}

	// Selects the target: the star nearest (`x`, `y`), in guide-image pixels of the current frame, or the best one the
	// tracker offers when no position is given. Resolves to the lock position, or 'unexpectedState' when nothing could
	// be selected. The pulse gate is not touched.
	selectTarget(position?: readonly [number, number]): OperationResult<readonly [number, number]> {
		if (this.#root === undefined) return failedOperationResult('unexpectedState', 'the guiding session is not looping')

		if (position !== undefined && !this.client.setLockPosition(position[0], position[1], false)) return failedOperationResult('unexpectedState', 'invalid target position')
		const selected = position === undefined ? this.client.findTarget() : this.client.getLockPosition()

		return selected === undefined ? failedOperationResult('unexpectedState', 'no target could be selected') : successfulOperationResult(selected)
	}

	// Clears the selected target; refused while guiding, which needs it.
	clearTarget(): OperationResult<void> {
		if (this.#run !== undefined) return failedOperationResult('unexpectedState', 'the target is in use while guiding')
		this.client.deselectStar()
		return successfulOperationResult(undefined)
	}

	// Sets the guide exposure of the next captures, in milliseconds.
	setExposure(exposure: number): OperationResult<void> {
		return this.client.setExposure(exposure) ? successfulOperationResult(undefined) : failedOperationResult('unexpectedState', `invalid guide exposure: ${exposure} ms`)
	}

	// Clears the solved calibration; refused while guiding, which needs it.
	clearCalibration(): OperationResult<void> {
		if (this.#run !== undefined) return failedOperationResult('unexpectedState', 'the calibration is in use while guiding')
		this.client.clearCalibration()
		return successfulOperationResult(undefined)
	}

	// Flips the calibration of the client for a meridian flip.
	flipCalibration(): OperationResult<void> {
		return this.client.flipCalibration() ? successfulOperationResult(undefined) : failedOperationResult('unexpectedState', 'the guider has no calibration to flip')
	}

	// Starts calibrating or guiding the selected target (the client selects one when none is): begins the session when
	// it does not live, opens the `guidingRun` holding the guide output unless it is open ('busy' when the guide output
	// is taken), then in one synchronous block opens the gate and asks the client to guide, closing the gate (and
	// ending a run this call opened) when it refuses, and waits for the settle after that call as a child of `task`. The
	// gate stays open after a settle that failed or a cancelled wait: the client is guiding.
	async startGuiding(task: OperationScope, scope: OperationScope, options: GuidingStartOptions): Promise<OperationResult<void>> {
		const opened = await this.#open(scope, options.clock)
		if (!opened.ok) return opened

		const admission = this.#admission!
		const reopened = this.#run === undefined
		const run = await this.#openRun()
		if (!run.ok) return run
		this.#pausedCalibrating = false

		const { recalibrate, settle } = options
		const started = await waitForGuidingSettle(task, 'guidingStart', this.#settle, guidingSettleWaitTimeout(settle), this.#delay, () => {
			admission.open()
			if (this.client.guide(recalibrate, settle)) return successfulOperationResult(undefined)
			admission.close()
			return failedOperationResult('unexpectedState', 'the guider refused to guide')
		})

		if (!started.ok && reopened && admission.isOpen === false) await this.#endRun()
		return started.ok ? successfulOperationResult(undefined) : started
	}

	// Stops the corrections and keeps looping: closes the gate, returns the client to looping (the target stays
	// selected) and ends the `guidingRun`, resolving once its cleanup proved the guide output at a standstill. A
	// session without a run only closes the gate.
	async stopGuiding(_task: OperationScope): Promise<OperationResult<void>> {
		this.#admission?.close()
		this.#pausedCalibrating = false
		if (this.#root !== undefined) this.#expect('stop', () => this.client.loop())
		return await this.#endRun()
	}

	// Closes the gate and pauses a calibrating or guiding client, fully for `all` and always while calibrating, whose
	// interrupted attempt `resume` restarts; leaves the state of a looping or stopped one untouched. Then proves the
	// guide output at a standstill: zeroes every direction and waits, through the commander, for the end of every
	// pulse dispatched, at most `pulseQuiescenceBound()`; with `releaseGuideOutput` it ends the `guidingRun` instead,
	// whose cleanup proves the same. Runs as the child `guidingPause` of `task`; its cancellation resolves at once
	// while the commander finishes its wait on its own within the same bound.
	async pause(task: OperationScope, mode: GuidingPauseMode = 'all', options: GuidingPauseOptions = {}): Promise<OperationResult<void>> {
		return await task.start<void>('guidingPause', [], async (context) => {
			this.#admission?.close()

			const state = this.client.state
			const calibrating = state === 'calibrating' || (state === 'paused' && this.#pausedCalibrating)

			if (state === 'calibrating' || state === 'guiding' || state === 'lostLock') {
				this.#pausedCalibrating = calibrating
				this.#expect('pause', () => this.client.setPaused(true, mode === 'all' || calibrating))
			}

			const stopped = await settleOnAbort(options.releaseGuideOutput === true ? this.#endRun() : this.guideOutputCommander.stopPulses(this.guideOutput, ALL_DIRECTIONS, { settleTimeout: Math.min(GUIDE_PULSE_STOP_SETTLE_TIMEOUT, this.pulseQuiescenceBound()) }), context.signal)

			if (!stopped.ok) return stopped
			if (this.guideOutput.pulsing) return failedOperationResult('unexpectedState', `guide output ${this.guideOutput.name} is still pulsing`)
			return successfulOperationResult(undefined)
		}).result
	}

	// `guidePulseReleaseBound(pulseCeiling)`: a ceiling pulse whose Busy came at its last accepted instant, kept whole by
	// a driver that ignores the zero, plus the time a driver is given to clear its flag.
	pulseQuiescenceBound() {
		return guidePulseReleaseBound(this.pulseCeiling)
	}

	// Resumes guiding: opens a new `guidingRun` when a releasing pause ended it ('busy' when the guide output is taken),
	// then in one synchronous block opens the gate, resumes the client and asks it to guide, recalibrating when the
	// pause interrupted a calibration (a running guiding then only settles again); a refusal closes the gate, pauses the
	// client again and ends a run this call opened. Then waits for the settle after that call as a child of `task`. The
	// gate stays open after a settle that failed or a cancelled wait.
	async resume(task: OperationScope, settle: GuidingSettle): Promise<OperationResult<void>> {
		const admission = this.#admission
		if (admission === undefined || this.#root === undefined) return failedOperationResult('unexpectedState', 'the guiding session is not looping')

		this.#observe()
		const reopened = this.#run === undefined
		const run = await this.#openRun()
		if (!run.ok) return run

		const recalibrate = this.#pausedCalibrating
		this.#pausedCalibrating = false

		const resumed = await waitForGuidingSettle(task, 'guidingResume', this.#settle, guidingSettleWaitTimeout(settle), this.#delay, () => {
			admission.open()
			this.client.setPaused(false)
			if (this.client.guide(recalibrate, settle)) return successfulOperationResult(undefined)
			admission.close()
			this.#pausedCalibrating = recalibrate
			this.#expect('pause', () => this.client.setPaused(true, true))
			return failedOperationResult('unexpectedState', 'the guider refused to resume')
		})

		if (!resumed.ok && reopened && !admission.isOpen) await this.#endRun()
		return resumed.ok ? successfulOperationResult(undefined) : resumed
	}

	// Guided dithers, in guide pixels or in angles when the pixel scale of the guide camera is known.
	accepts(request: DitherRequest) {
		return request.settle.kind === 'guided' && (request.amount.unit === 'guidePixel' || this.client.getPixelScale() > 0)
	}

	// Dithers through the client and waits for its settle, as the child `guidingDither` of `task` without resources:
	// one at a time ('busy' otherwise); a settle already running is waited for first; an angular amount (radians) is
	// converted with the pixel scale of the guide camera; a refused dither fails 'unexpectedState' at once; only the
	// first settleDone after the dispatch counts (a failed settle fails 'commandFailed'); the settle timeout plus
	// `GUIDING_SETTLE_TIMEOUT_MARGIN` fails 'timeout'. A cancelled dither leaves its settle running in the client, and
	// the lock shift already applied stays.
	async dither(task: OperationScope, request: DitherRequest, onPhase?: (phase: DitherPhase) => void): Promise<OperationResult<DitherResult>> {
		const { amount, raOnly, settle } = request
		if (settle.kind !== 'guided') return failedOperationResult('unexpectedState', 'a guider dither needs a guided settle')
		if (this.#dithering) return failedOperationResult('busy', 'a dither is already running')

		this.#dithering = true
		this.#observe()

		try {
			return await task.start<DitherResult>('guidingDither', [], async (context) => {
				const timeout = guidingSettleWaitTimeout(settle)

				if (this.client.getSettling()) {
					const previous = await waitForGuidingSettle(context, 'guidingPreviousSettle', this.#settle, timeout, this.#delay, () => successfulOperationResult(undefined))
					if (!previous.ok && previous.reason !== 'commandFailed') return previous
				}

				const scale = this.client.getPixelScale()
				const pixels = amount.unit === 'guidePixel' ? amount.value : toArcsec(amount.value) / scale
				if (!(pixels > 0 && Number.isFinite(pixels))) return failedOperationResult('unexpectedState', 'the dither amount has no guide-pixel size')

				onPhase?.('dithering')
				const settled = await waitForGuidingSettle(context, 'guidingDitherSettle', this.#settle, timeout, this.#delay, () => (this.client.dither(pixels, raOnly, settle) ? successfulOperationResult(undefined) : failedOperationResult('unexpectedState', 'the guider refused to dither')), onPhase)
				return settled.ok ? successfulOperationResult({ kind: 'guider', lockShift: settled.value.lockShift ?? [0, 0] }) : settled
			}).result
		} finally {
			this.#dithering = false
		}
	}

	// Ends the session: closes the gate, ends the `guidingRun` (proving the standstill), stops the capture, ends the
	// root `guiding`, stops observing the client and disposes of an admission `startLoop` installed. Resolves with the
	// result of ending the run: 'commandFailed' when the end of a pulse stayed unobserved, in which case the commander
	// keeps the guide output blocked with the `guidePulse` cause. Idempotent.
	async stop(_task: OperationScope): Promise<OperationResult<void>> {
		this.#admission?.close()
		this.#pausedCalibrating = false
		const ended = await this.#endRun()
		this.#expect('stop', () => this.client.stopCapture())

		const root = this.#root
		this.#root = undefined
		root?.finish()
		if (root !== undefined) await root.handle.result

		this.#unobserve()
		if (this.#ownsAdmission) this.endRun()
		return ended
	}

	// Interruptions of the monotonic window, from the bounded history.
	interruptions(fromMonotonic: number, toMonotonic: number) {
		return this.#history.query(fromMonotonic, toMonotonic)
	}

	// Handler of the client events: settle progress for the waits, and the interruptions nobody of the session caused.
	readonly #handler: GuiderClientHandler = {
		event: (_, event) => this.#onEvent(event),
	}

	#onEvent(event: GuidingEvent) {
		switch (event.type) {
			case 'starLost':
				this.#interrupt('starLost', event.notes.join(','))
				return
			case 'lockLost':
				this.#interrupt('lockPositionLost')
				return
			case 'paused':
				if (this.#expecting !== 'pause') this.#interrupt('paused', 'guiding paused outside the session')
				return
			case 'guidingStopped':
				if (this.#expecting !== 'stop') this.#interrupt('stopped', 'guiding stopped outside the session')
				return
			case 'dithered':
				this.#settle.notify({ kind: 'dithered', dx: event.dx, dy: event.dy })
				return
			case 'settleStarted':
			case 'settling':
				this.#settle.notify({ kind: 'settling' })
				return
			case 'settleDone':
				this.#settle.notify({ kind: 'done', status: event.succeeded ? 0 : 1, error: event.error })
		}
	}

	// Sends one admitted pulse through the commander under the open run; refused without one.
	#dispatch(output: GuideOutput, direction: GuideDirection, duration: number) {
		const run = this.#run
		return run !== undefined && output === this.guideOutput && this.guideOutputCommander.dispatch(run.context, output, direction, duration) !== undefined
	}

	// Records an interruption at its reception, with the clock of the last start.
	#interrupt(kind: GuidingInterruptionKind, detail?: string) {
		const { wallNow, monotonicNow } = this.#clock
		this.#history.record(detail === undefined ? { kind, receivedMonotonic: monotonicNow(), receivedAt: wallNow() } : { kind, receivedMonotonic: monotonicNow(), receivedAt: wallNow(), detail })
	}

	// Runs an own command whose paused or guidingStopped event must not count as an interruption.
	#expect(command: 'pause' | 'stop', run: VoidFunction) {
		const previous = this.#expecting
		this.#expecting = command

		try {
			run()
		} finally {
			this.#expecting = previous
		}
	}

	// Starts observing the client; idempotent.
	#observe() {
		if (this.#observing) return
		this.#observing = true
		this.client.addHandler(this.#handler)
	}

	// Stops observing the client; idempotent.
	#unobserve() {
		if (!this.#observing) return
		this.#observing = false
		this.client.removeHandler(this.#handler)
	}

	// Installs the admission when none was begun, observes and connects the client, and opens the root under `scope`
	// unless it lives. Undoes the admission it installed when the root cannot open.
	async #open(scope: OperationScope, clock: CameraCaptureClock | undefined): Promise<OperationResult<void>> {
		if (clock !== undefined || this.#root === undefined) this.#clock = clock ?? DEFAULT_GUIDING_CLOCK
		if (this.#root !== undefined) return successfulOperationResult(undefined)

		const installed = this.#admission === undefined

		if (installed) {
			const begun = this.beginRun()
			if (!begun.ok) return begun
			this.#ownsAdmission = true
		}

		this.#observe()

		const connected = this.#connect()
		const rooted = connected.ok ? await this.#openRoot(scope) : connected

		if (!rooted.ok) {
			if (installed) this.endRun()
			return rooted
		}

		this.#lost = false
		this.#failure = undefined
		return successfulOperationResult(undefined)
	}

	// Connects the client to the guide camera and guide output of the session, unless it already is.
	#connect(): OperationResult<void> {
		const { client, camera, guideOutput } = this
		if (client.camera === camera && client.guideOutput === guideOutput) return successfulOperationResult(undefined)
		if (client.camera !== undefined || client.guideOutput !== undefined) return failedOperationResult('unexpectedState', 'the guider is connected to other devices')
		return client.connect(camera, guideOutput, this.options.connect) ? successfulOperationResult(undefined) : failedOperationResult('unexpectedState', 'the guider could not connect')
	}

	// Opens the root `guiding` under `scope`, leasing the guide camera. Its executor stays pending until `stop` ends it;
	// a cancellation (the device lifecycle losing the guide camera, or the loss of the run) ends the session as lost.
	async #openRoot(scope: OperationScope): Promise<OperationResult<void>> {
		const opened = await this.#pending(scope, 'guiding', [this.resources().camera], (context) => {
			const reason = abortReason(context.signal)
			if (this.#root?.context === context) this.#root = undefined
			this.#lost = true
			this.#failure = { reason, detail: 'the guiding operation was cancelled' }
			this.#pausedCalibrating = false
			this.#admission?.close()
			this.#expect('pause', () => this.client.setPaused(true, true))
			this.#expect('stop', () => this.client.stopCapture())
			this.#interrupt(reason === 'removed' ? 'removed' : reason === 'disconnected' ? 'disconnected' : 'stopped', `guiding cancelled: ${reason}`)
			this.#settle.notify({ kind: 'lost', reason, detail: 'the guiding operation was cancelled' })
			if (this.#ownsAdmission) this.endRun()
		})

		if (!opened.ok) return opened
		this.#root = opened.value
		return successfulOperationResult(undefined)
	}

	// Opens the `guidingRun` under the root, leasing the guide output and its lifecycle resource, unless it is open. A
	// cancellation from outside (the device lifecycle losing the guide output) closes the gate and ends the whole
	// session as lost.
	async #openRun(): Promise<OperationResult<void>> {
		if (this.#run !== undefined) return successfulOperationResult(undefined)

		const root = this.#root
		if (root === undefined) return failedOperationResult('unexpectedState', 'the guiding session is not looping')

		const { guideOutput, lifecycle } = this.resources()

		const opened = await this.#pending(root.context, 'guidingRun', [guideOutput, lifecycle], (context) => {
			if (this.#run?.context === context) this.#run = undefined
			this.#admission?.close()
			// Cancelling the root waits for this run, so it is not awaited here; the root ends the session as lost.
			if (this.#root === root && !root.context.signal.aborted) void root.handle.cancel(abortReason(context.signal))
		})

		if (!opened.ok) return opened
		this.#run = opened.value
		return successfulOperationResult(undefined)
	}

	// Ends the `guidingRun` normally and resolves with its result once its cleanup released the guide output; a run
	// whose pulse end stayed unobserved resolves 'commandFailed'. Without a run it resolves at once.
	async #endRun(): Promise<OperationResult<void>> {
		const run = this.#run
		if (run === undefined) return successfulOperationResult(undefined)

		this.#admission?.close()
		this.#run = undefined
		run.finish()
		return await run.handle.result
	}

	// Starts an operation of `kind` under `scope` leasing `resources`, whose executor stays pending until its `finish`
	// is called; `onCancelled` runs in its cleanup when it was cancelled instead. Resolves to the pending operation, or
	// to the refusal of the scope ('busy' when a resource is taken).
	async #pending(scope: OperationScope, kind: string, resources: readonly ResourceRequest[], onCancelled: (context: OperationContext) => void): Promise<OperationResult<PendingOperation>> {
		let opened: { context: OperationContext; finish: VoidFunction } | undefined

		const handle = scope.start<void>(
			kind,
			resources,
			(context) =>
				new Promise((resolve) => {
					const finish = () => resolve(successfulOperationResult(undefined))
					opened = { context, finish }

					context.signal.addEventListener('abort', () => resolve(failedOperationResult(abortReason(context.signal))), { once: true })

					context.onCleanup(() => {
						if (context.signal.aborted) onCancelled(context)
					})
				}),
		)

		if (opened === undefined) {
			const refused = await handle.result
			return refused.ok ? failedOperationResult('unexpectedState', `the ${kind} operation ended at once`) : refused
		}

		return successfulOperationResult({ handle, ...opened })
	}
}
