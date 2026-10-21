import { errorMessage } from '../../core/util'
import { GUIDE_PULSE_STOP_SETTLE_TIMEOUT, type GuideOutputCommander, guidePulseReleaseBound } from '../../devices/commanders/guideoutput'
import type { PHD2Events } from '../../devices/guiding/phd2'
import type { Camera, GuideDirection, GuideOutput } from '../../devices/indi/device'
import { failedOperationResult, type OperationContext, type OperationHandle, type OperationResult, type OperationScope, successfulOperationResult } from '../../devices/orchestration/operation'
import { type AbortableDelay, abortableDelay, abortReason } from '../../devices/orchestration/operation.wait'
import { type ResourceRequest, resourceKey } from '../../devices/orchestration/resource'
import { toArcsec } from '../../math/units/angle'
import type { CameraCaptureClock } from '../capture/types'
import type { GuidePulseAdmission, GuiderClient, GuiderClientConnectOptions, GuiderClientHandler } from './client'
import { type Ditherer, type DitherPhase, type DitherRequest, type DitherResult, settleOnAbort } from './ditherer'
// oxfmt-ignore
import { DEFAULT_GUIDING_CLOCK, type GuidingInterruptionKind, GuidingInterruptionHistory, type GuidingSession, type GuidingSessionResources, type GuidingSessionState, type GuidingSettle, GuidingSettleListeners, type GuidingStartOptions, guidingSettleWaitTimeout, waitForGuidingSettle } from './session'

// Guiding session and ditherer over the local `GuiderClient` (`LocalGuidingSession`). The guide camera is a physical
// resource held by the root `guiding` for the life of the guiding: the client exposes it directly, so only that lease
// keeps a second owner off it. The guide output is held through a logical lifecycle resource that names it as its
// device, so losing the guide output (or the mount or camera that publishes it) cancels the root without conflicting
// with the slews and captures of the observation session on the same hardware; its exclusion against mount motion is
// the pause, which closes the pulse admission of the client and waits for the physical end of the pulses already sent.
//
// The pulse ceiling is frozen at construction (`pulseCeiling`, ms) and installed by `beginRun` as the exclusive pulse
// admission of the client, created closed: from then on every pulse, from guiding, calibration, the guiding assistant or
// any `guidePulse` caller, is refused unless the session opened the gate, and none exceeds the ceiling. Only `start` and
// `resume` open the gate, synchronously right before asking the client to guide; `pause`, `stop`, a refused command and
// the loss of the root close it; `endRun` disposes of it. Pulse windows are in `performance.now()` milliseconds, as the
// client keeps them, and never compared with the session clock; interruptions are stamped with the clock of the start.
// The session never disconnects the client it connected: the client belongs to its caller.

// Methods of `GuiderClient` the session uses; the client itself in production.
export type LocalGuidingClient = Pick<GuiderClient, 'camera' | 'guideOutput' | 'connect' | 'addHandler' | 'removeHandler' | 'admitPulses' | 'pulseQuiescenceWindow' | 'maxPulseDuration' | 'getAppState' | 'getSettling' | 'getPixelScale' | 'guide' | 'setPaused' | 'stopCapture' | 'flipCalibration' | 'dither'>

// Options of a local guiding session.
export interface LocalGuidingSessionOptions {
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

// Every direction of a guide output, zeroed by a pause.
const ALL_DIRECTIONS: readonly GuideDirection[] = ['NORTH', 'SOUTH', 'WEST', 'EAST']

// Logical lifecycle resource of a guide output: never conflicts with the physical key of the device that publishes it,
// but names the guide output as its device, so the device lifecycle cancels its owner when the guide output is lost.
export function guideOutputLifecycleKey(guideOutput: GuideOutput) {
	return `logical:guide-output:${resourceKey(guideOutput)}`
}

// Root `guiding` while it lives.
interface GuidingRoot {
	readonly handle: OperationHandle<void>
	readonly context: OperationContext
	// Ends the root normally, as `stop` does.
	readonly finish: VoidFunction
}

// Guiding session and ditherer over one `GuiderClient`, one guide camera and one guide output.
export class LocalGuidingSession implements GuidingSession, Ditherer {
	// Pulse ceiling of every run, in ms (integer ≥ 1); frozen at construction.
	readonly pulseCeiling: number
	readonly #history: GuidingInterruptionHistory
	readonly #settle = new GuidingSettleListeners()
	readonly #delay: AbortableDelay
	#admission?: GuidePulseAdmission
	#root?: GuidingRoot
	// Whether the root was lost (device lifecycle) since the last start.
	#lost = false
	// Clock of the last start.
	#clock: CameraCaptureClock = DEFAULT_GUIDING_CLOCK
	// Whether the client delivers its events to the session.
	#observing = false
	// Own command being issued, whose Paused or GuidingStopped event is not an interruption.
	#expecting?: 'pause' | 'stop'
	// Whether a dither of this session is running.
	#dithering = false

	// Binds the session to its client, the guide camera and the guide output the client guides with, and the commander
	// of that guide output, which proves the end of the pulses in a pause.
	constructor(
		readonly client: LocalGuidingClient,
		readonly camera: Camera,
		readonly guideOutput: GuideOutput,
		readonly guideOutputCommander: Pick<GuideOutputCommander, 'stopPulses'>,
		readonly options: LocalGuidingSessionOptions = {},
	) {
		this.pulseCeiling = Math.max(1, Math.round(options.pulseCeiling ?? client.maxPulseDuration()))
		this.#history = new GuidingInterruptionHistory(options.interruptionCapacity)
		this.#delay = options.delay ?? abortableDelay
	}

	// Reserves the guide camera, the guide output and its lifecycle resource; holds the guide camera (physical key) and
	// the lifecycle resource of the guide output.
	resources(): GuidingSessionResources {
		const camera: ResourceRequest = { key: resourceKey(this.camera), device: this.camera }
		const lifecycle: ResourceRequest = { key: guideOutputLifecycleKey(this.guideOutput), device: this.guideOutput }
		return { reserve: [camera, { key: resourceKey(this.guideOutput), device: this.guideOutput }, lifecycle], hold: [camera, lifecycle] }
	}

	// State from the client: Calibrating, Guiding (settling while a settle runs), Paused, LostLock, and stopped for
	// Stopped, Looping and Selected; 'lost' after the root was lost, until the next start.
	state(): GuidingSessionState {
		if (this.#lost) return 'lost'

		switch (this.client.getAppState()) {
			case 'Calibrating':
				return 'calibrating'
			case 'Guiding':
				return this.client.getSettling() ? 'settling' : 'guiding'
			case 'Paused':
				return 'paused'
			case 'LostLock':
				return 'lost'
			default:
				return 'stopped'
		}
	}

	// Installs the closed pulse admission with the frozen ceiling, commanding nothing. 'busy' when another admission (or
	// this run) is active; 'unexpectedState' when the client configuration already allows a longer pulse.
	beginRun(): OperationResult<void> {
		if (this.#admission !== undefined) return failedOperationResult('busy', 'the guiding run already began')

		let admission: GuidePulseAdmission | undefined

		try {
			admission = this.client.admitPulses(this.pulseCeiling)
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

	// Disposes of the admission of the run, closing its gate for good. Idempotent.
	endRun() {
		this.#admission?.[Symbol.dispose]()
		this.#admission = undefined
	}

	// Connects the client when needed, opens the root `guiding` when it does not live, then, in one synchronous block,
	// opens the gate and asks the client to guide (closing the gate again when it refuses), and waits for the settle
	// after that call as a child of `task`. 'unexpectedState' without a begun run. The gate stays open after a settle
	// that failed or a cancelled wait: the client is guiding.
	async start(task: OperationScope, reservation: OperationScope, options: GuidingStartOptions): Promise<OperationResult<void>> {
		const admission = this.#admission
		if (admission === undefined) return failedOperationResult('unexpectedState', 'the guiding run was not begun')

		this.#clock = options.clock ?? DEFAULT_GUIDING_CLOCK
		this.#observe()

		const connected = this.#connect()
		if (!connected.ok) return connected

		const rooted = await this.#openRoot(reservation)
		if (!rooted.ok) return rooted
		this.#lost = false

		const { recalibrate, settle } = options
		const started = await waitForGuidingSettle(task, 'guidingStart', this.#settle, guidingSettleWaitTimeout(settle), this.#delay, () => {
			admission.open()
			if (this.client.guide(recalibrate, settle)) return successfulOperationResult(undefined)
			admission.close()
			return failedOperationResult('unexpectedState', 'the guider refused to guide')
		})

		return started.ok ? successfulOperationResult(undefined) : started
	}

	// Closes the gate, stops the client capture, ends the root `guiding` and stops observing the client.
	async stop(_scope: OperationScope): Promise<OperationResult<void>> {
		this.#admission?.close()
		this.#expect('stop', () => this.client.stopCapture())

		const root = this.#root
		this.#root = undefined
		root?.finish()
		if (root !== undefined) await root.handle.result

		this.#unobserve()
		return successfulOperationResult(undefined)
	}

	// Closes the gate (and pauses a guiding client fully, leaving the app state of a stopped or lost one untouched), then
	// zeroes every direction of the guide output and waits, through its commander, for the end of every pulse the client
	// delivered: no standstill before the latest Busy deadline of those pulses, and at most until their latest `endsBy`
	// plus `GUIDE_PULSE_STOP_SETTLE_TIMEOUT`, never more than `pulseQuiescenceBound()`. Ok only with the guide output
	// observed stopped after that deadline. Runs as the child `guidingPause` of `scope`; its cancellation resolves at
	// once while the commander finishes its wait on its own within the same bound.
	async pause(scope: OperationScope): Promise<OperationResult<void>> {
		return await scope.start<void>('guidingPause', [], async (context) => {
			this.#admission?.close()

			const state = this.state()
			if (state === 'calibrating' || state === 'guiding' || state === 'settling') this.#expect('pause', () => this.client.setPaused(true, true))

			const window = this.client.pulseQuiescenceWindow()
			const settleTimeout = Math.min(Math.max(0, (window?.endsBy ?? 0) - performance.now()) + GUIDE_PULSE_STOP_SETTLE_TIMEOUT, this.pulseQuiescenceBound())
			const stopped = await settleOnAbort(this.guideOutputCommander.stopPulses(this.guideOutput, ALL_DIRECTIONS, { busyAckDeadline: window?.busyAckDeadline, settleTimeout }), context.signal)

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

	// In one synchronous block opens the gate, resumes the client and asks it to guide (a running guiding then only
	// settles again); a refusal closes the gate and pauses the client again in the same block. Then waits for the settle
	// after that call. The gate stays open after a settle that failed or a cancelled wait.
	async resume(scope: OperationScope, settle: GuidingSettle): Promise<OperationResult<void>> {
		const admission = this.#admission
		if (admission === undefined) return failedOperationResult('unexpectedState', 'the guiding run was not begun')

		this.#observe()

		const resumed = await waitForGuidingSettle(scope, 'guidingResume', this.#settle, guidingSettleWaitTimeout(settle), this.#delay, () => {
			admission.open()
			this.client.setPaused(false)
			if (this.client.guide(false, settle)) return successfulOperationResult(undefined)
			admission.close()
			this.#expect('pause', () => this.client.setPaused(true, true))
			return failedOperationResult('unexpectedState', 'the guider refused to resume')
		})

		return resumed.ok ? successfulOperationResult(undefined) : resumed
	}

	// Flips the calibration of the client for a meridian flip.
	flipCalibration(_scope: OperationScope): Promise<OperationResult<void>> {
		return Promise.resolve(this.client.flipCalibration() ? successfulOperationResult(undefined) : failedOperationResult('unexpectedState', 'the guider has no calibration to flip'))
	}

	// Interruptions of the monotonic window, from the bounded history.
	interruptions(fromMonotonic: number, toMonotonic: number) {
		return this.#history.query(fromMonotonic, toMonotonic)
	}

	// Id of the root `guiding` while it lives.
	operationId() {
		return this.#root?.context.id
	}

	// Guided settles, in guide pixels or in angles when the pixel scale of the guide camera is known.
	accepts(request: DitherRequest) {
		return request.settle.kind === 'guided' && (request.amount.unit === 'guidePixel' || this.client.getPixelScale() > 0)
	}

	// Whether the client guides (or settles).
	ready() {
		const state = this.state()
		return state === 'guiding' || state === 'settling'
	}

	// Dithers through the client and waits for its settle, as the child `guidingDither` of `scope` without resources:
	// one at a time ('busy' otherwise); a settle already running is waited for first; an angular amount is converted with
	// the pixel scale of the guide camera; a refused dither fails 'unexpectedState' at once; only the first SettleDone
	// after the dispatch counts (status 0 succeeds, any other fails 'commandFailed'); the settle timeout plus
	// `GUIDING_SETTLE_TIMEOUT_MARGIN` fails 'timeout'. A cancelled dither leaves its settle running in the client.
	async dither(scope: OperationScope, request: DitherRequest, onPhase?: (phase: DitherPhase) => void): Promise<OperationResult<DitherResult>> {
		const { amount, raOnly, settle } = request
		if (settle.kind !== 'guided') return failedOperationResult('unexpectedState', 'a guider dither needs a guided settle')
		if (this.#dithering) return failedOperationResult('busy', 'a dither is already running')

		this.#dithering = true
		this.#observe()

		try {
			return await scope.start<DitherResult>('guidingDither', [], async (context) => {
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

	// Handler of the client events: settle progress for the waits, and the interruptions nobody of the session caused.
	readonly #handler: GuiderClientHandler = {
		event: (_, event) => this.#onEvent(event),
	}

	#onEvent(event: PHD2Events) {
		switch (event.Event) {
			case 'StarLost':
				this.#interrupt('starLost', event.Status)
				return
			case 'LockPositionLost':
				this.#interrupt('lockPositionLost')
				return
			case 'Paused':
				if (this.#expecting !== 'pause') this.#interrupt('paused', 'guiding paused outside the session')
				return
			case 'GuidingStopped':
				if (this.#expecting !== 'stop') this.#interrupt('stopped', 'guiding stopped outside the session')
				return
			case 'GuidingDithered':
				this.#settle.notify({ kind: 'dithered', dx: event.dx, dy: event.dy })
				return
			case 'SettleBegin':
			case 'Settling':
				this.#settle.notify({ kind: 'settling' })
				return
			case 'SettleDone':
				this.#settle.notify({ kind: 'done', status: event.Status, error: event.Error })
		}
	}

	// Records an interruption at its reception, with the clock of the last start.
	#interrupt(kind: GuidingInterruptionKind, detail?: string) {
		const { wallNow, monotonicNow } = this.#clock
		this.#history.record(detail === undefined ? { kind, receivedMonotonic: monotonicNow(), receivedAt: wallNow() } : { kind, receivedMonotonic: monotonicNow(), receivedAt: wallNow(), detail })
	}

	// Runs an own command whose Paused or GuidingStopped event must not count as an interruption.
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

	// Connects the client to the guide camera and guide output of the session, unless it already is.
	#connect(): OperationResult<void> {
		const { client, camera, guideOutput } = this
		if (client.camera === camera && client.guideOutput === guideOutput) return successfulOperationResult(undefined)
		if (client.camera !== undefined || client.guideOutput !== undefined) return failedOperationResult('unexpectedState', 'the guider is connected to other devices')
		return client.connect(camera, guideOutput, this.options.connect) ? successfulOperationResult(undefined) : failedOperationResult('unexpectedState', 'the guider could not connect')
	}

	// Opens the root `guiding` under the reservation, leasing `hold`, unless it lives. Its executor stays pending until
	// `stop` ends it; a cancellation (the device lifecycle losing the guide output or the guide camera) closes the gate,
	// pauses and stops the client capture, records the interruption and leaves the session lost.
	async #openRoot(reservation: OperationScope): Promise<OperationResult<void>> {
		if (this.#root !== undefined) return successfulOperationResult(undefined)

		let opened: { context: OperationContext; finish: VoidFunction } | undefined

		const handle = reservation.start<void>(
			'guiding',
			this.resources().hold,
			(context) =>
				new Promise((resolve) => {
					const finish = () => resolve(successfulOperationResult(undefined))
					opened = { context, finish }

					context.signal.addEventListener('abort', () => resolve(failedOperationResult(abortReason(context.signal))), { once: true })

					context.onCleanup(() => {
						if (!context.signal.aborted) return
						const reason = abortReason(context.signal)
						if (this.#root?.context === context) this.#root = undefined
						this.#lost = true
						this.#admission?.close()
						this.#expect('pause', () => this.client.setPaused(true, true))
						this.#expect('stop', () => this.client.stopCapture())
						this.#interrupt(reason === 'removed' ? 'removed' : reason === 'disconnected' ? 'disconnected' : 'stopped', `guiding cancelled: ${reason}`)
						this.#settle.notify({ kind: 'lost', reason, detail: 'the guiding operation was cancelled' })
					})
				}),
		)

		if (opened === undefined) {
			const refused = await handle.result
			return refused.ok ? failedOperationResult('unexpectedState', 'the guiding operation ended at once') : refused
		}

		this.#root = { handle, ...opened }
		return successfulOperationResult(undefined)
	}
}
