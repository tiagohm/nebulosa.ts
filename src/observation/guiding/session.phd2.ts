import { GUIDE_PULSE_STOP_SETTLE_TIMEOUT } from '../../devices/commanders/guideoutput'
import { DEFAULT_PHD2_PORT, type PHD2AppState, type PHD2Client, type PHD2ClientHandler, type PHD2CommandResult, type PHD2Events } from '../../devices/guiding/phd2'
import type { GuideOutput } from '../../devices/indi/device'
import type { DeviceHandler, DeviceManager } from '../../devices/indi/manager/device'
import { failedOperationResult, type OperationContext, type OperationHandle, type OperationResult, type OperationScope, successfulOperationResult } from '../../devices/orchestration/operation'
import { type AbortableDelay, abortableDelay, abortReason, waitForDeviceState } from '../../devices/orchestration/operation.wait'
import type { ResourceRequest } from '../../devices/orchestration/resource'
import { toArcsec } from '../../math/units/angle'
import type { CameraCaptureClock } from '../capture/types'
import { type Ditherer, type DitherPhase, type DitherRequest, type DitherResult, settleOnAbort } from './ditherer'
// oxfmt-ignore
import { DEFAULT_GUIDING_CLOCK, type GuidingInterruptionKind, GuidingInterruptionHistory, type GuidingSession, type GuidingSessionResources, type GuidingSessionState, type GuidingSettle, GuidingSettleListeners, type GuidingStartOptions, guidingSettleWaitTimeout, waitForGuidingSettle } from './session'

// Guiding session and ditherer over a remote PHD2 (`PHD2GuidingSession`), through its JSON-RPC client. The only
// resource is the logical `logical:phd2:{host}:{port}`, reserved and held by the root `guiding`: the guider devices
// belong to the PHD2 process, so their loss arrives as a closed socket, never through the device lifecycle of this
// process. The application state of PHD2 is reconciled with `get_app_state` whenever the session connects and is then
// followed through the PHD2 events.
//
// The pause bound is an operational premise on every actor of that PHD2 (PHD2 itself, other clients, `guide_pulse`
// callers): no pulse lasts longer than `maxGuidePulse`. The pause waits for the Paused event within
// `pausedEventAllowance` and then, when the guide output is a device observed by this process, for it to report no
// pulse; otherwise for `maxGuidePulse` from the last instant PHD2 could pulse. Without telemetry a longer pulse passes
// unnoticed; with it, it becomes a timeout. There is no pulse admission on the PHD2 side. Durations are milliseconds
// unless stated; interruptions are stamped with the clock of the start.

// Options of a PHD2 guiding session.
export interface PHD2GuidingSessionOptions {
	// Host of the PHD2 server, also part of the logical resource.
	readonly host: string
	// Port of the PHD2 server; default `DEFAULT_PHD2_PORT`.
	readonly port?: number
	// Longest guide pulse any actor of this PHD2 may emit, in ms; finite > 0. An operational premise, not enforced.
	readonly maxGuidePulse: number
	// Longest wait for the Paused event after asking PHD2 to pause, in ms; finite > 0. Default 2000.
	readonly pausedEventAllowance?: number
	// Guide output PHD2 pulses through, when it is a device this process observes, with its manager.
	readonly guideOutput?: { readonly device: GuideOutput; readonly manager: DeviceManager<GuideOutput> }
	// Pixel scale of the guide camera, in arcsec/pixel; default the one PHD2 reports when the session connects.
	readonly pixelScale?: number
	// Capacity of the interruption history; default `DEFAULT_GUIDING_INTERRUPTION_CAPACITY`.
	readonly interruptionCapacity?: number
	// Abortable wait of the settle timeouts and of the pulse premise; default `abortableDelay`.
	readonly delay?: AbortableDelay
}

// Default wait for the Paused event, in ms.
export const DEFAULT_PHD2_PAUSED_EVENT_ALLOWANCE = 2000

// Logical resource of a PHD2 server.
export function phd2ResourceKey(host: string, port: number = DEFAULT_PHD2_PORT) {
	return `logical:phd2:${host}:${port}`
}

// Root `guiding` while it lives.
interface GuidingRoot {
	readonly handle: OperationHandle<void>
	readonly context: OperationContext
	// Ends the root with `result`.
	readonly finish: (result: OperationResult<void>) => void
}

// Guiding session and ditherer over one PHD2 client.
export class PHD2GuidingSession implements GuidingSession, Ditherer {
	readonly #history: GuidingInterruptionHistory
	readonly #settle = new GuidingSettleListeners()
	readonly #paused = new Set<VoidFunction>()
	readonly #delay: AbortableDelay
	readonly #port: number
	#root?: GuidingRoot
	// Application state followed from the events; undefined while unknown (never connected, or the socket closed).
	#appState?: PHD2AppState
	// Whether PHD2 reports a running settle.
	#settling = false
	// Whether a cancelled dither left its settle running in PHD2.
	#settlePending = false
	// Whether the connection was lost while guiding, until the next start.
	#lost = false
	// Last `performance.now()` instant at which PHD2 could have been pulsing: the last guiding event or pause.
	#lastActiveAt?: number
	// Pixel scale PHD2 reported last, in arcsec/pixel.
	#pixelScale = 0
	#clock: CameraCaptureClock = DEFAULT_GUIDING_CLOCK
	#observing = false
	// Own command being issued, whose Paused or GuidingStopped event is not an interruption.
	#expecting?: 'pause' | 'stop'
	#dithering = false

	constructor(
		readonly client: PHD2Client,
		readonly options: PHD2GuidingSessionOptions,
	) {
		this.#history = new GuidingInterruptionHistory(options.interruptionCapacity)
		this.#delay = options.delay ?? abortableDelay
		this.#port = options.port ?? DEFAULT_PHD2_PORT
	}

	// Reserves and holds only the logical resource of the PHD2 server.
	resources(): GuidingSessionResources {
		const server: ResourceRequest = { key: phd2ResourceKey(this.options.host, this.#port) }
		return { reserve: [server], hold: [server] }
	}

	// State from the followed application state: Calibrating, Guiding (settling while a settle runs), Paused, LostLock;
	// 'lost' after the connection closed while guiding, until the next start; stopped otherwise.
	state(): GuidingSessionState {
		if (this.#lost) return 'lost'

		switch (this.#appState) {
			case 'Calibrating':
				return 'calibrating'
			case 'Guiding':
				return this.#settling ? 'settling' : 'guiding'
			case 'Paused':
				return 'paused'
			case 'LostLock':
				return 'lost'
			default:
				return 'stopped'
		}
	}

	// Connects when needed, opens the root `guiding`, asks PHD2 to guide and waits for the SettleDone that follows.
	async start(task: OperationScope, reservation: OperationScope, options: GuidingStartOptions): Promise<OperationResult<void>> {
		this.#clock = options.clock ?? DEFAULT_GUIDING_CLOCK
		this.#observe()

		const connected = await this.#connect()
		if (!connected.ok) return connected

		const rooted = await this.#openRoot(reservation)
		if (!rooted.ok) return rooted
		this.#lost = false

		const { recalibrate, settle } = options
		const started = await waitForGuidingSettle(task, 'guidingStart', this.#settle, guidingSettleWaitTimeout(settle), this.#delay, async () => commandResult(await this.client.guide(recalibrate, { ...settle })))
		return started.ok ? successfulOperationResult(undefined) : started
	}

	// Stops the PHD2 capture, ends the root `guiding` and stops observing the client.
	async stop(_scope: OperationScope): Promise<OperationResult<void>> {
		this.#expecting = 'stop'
		const stopped = this.client.remoteAddress === undefined ? successfulOperationResult(undefined) : commandResult(await this.client.stopCapture())
		this.#expecting = undefined

		const root = this.#root
		this.#root = undefined
		root?.finish(successfulOperationResult(undefined))
		if (root !== undefined) await root.handle.result

		this.#unobserve()
		return stopped
	}

	// Connects when needed; for a guiding (or lost) PHD2 asks it to pause fully and waits for its Paused event within
	// `pausedEventAllowance`; then waits for the physical end of the pulses: the observed guide output reporting no pulse,
	// or `maxGuidePulse` from the last instant PHD2 could pulse. Runs as the child `guidingPause` of `scope`.
	async pause(scope: OperationScope): Promise<OperationResult<void>> {
		return await scope.start<void>('guidingPause', [], async (context) => {
			this.#observe()

			const connected = await settleOnAbort(this.#connect(), context.signal)
			if (!connected.ok) return connected

			const state = this.state()

			if (state !== 'stopped' && state !== 'paused') {
				const paused = await this.#requestPause(context.signal)
				if (!paused.ok) return paused
			}

			return await this.#quiesce(context.signal)
		}).result
	}

	// `maxGuidePulse + pausedEventAllowance`, plus `GUIDE_PULSE_STOP_SETTLE_TIMEOUT` with an observed guide output.
	pulseQuiescenceBound() {
		return this.options.maxGuidePulse + (this.options.pausedEventAllowance ?? DEFAULT_PHD2_PAUSED_EVENT_ALLOWANCE) + (this.options.guideOutput === undefined ? 0 : GUIDE_PULSE_STOP_SETTLE_TIMEOUT)
	}

	// Resumes PHD2 and asks it to settle again, then waits for that settle.
	async resume(scope: OperationScope, settle: GuidingSettle): Promise<OperationResult<void>> {
		this.#observe()

		const resumed = await waitForGuidingSettle(scope, 'guidingResume', this.#settle, guidingSettleWaitTimeout(settle), this.#delay, async () => {
			const unpaused = commandResult(await this.client.setPaused(false, false))
			return unpaused.ok ? commandResult(await this.client.guide(false, { ...settle })) : unpaused
		})

		return resumed.ok ? successfulOperationResult(undefined) : resumed
	}

	// Flips the PHD2 calibration for a meridian flip.
	async flipCalibration(_scope: OperationScope): Promise<OperationResult<void>> {
		return commandResult(await this.client.flipCalibration())
	}

	// Interruptions of the monotonic window, from the bounded history.
	interruptions(fromMonotonic: number, toMonotonic: number) {
		return this.#history.query(fromMonotonic, toMonotonic)
	}

	// Id of the root `guiding` while it lives.
	operationId() {
		return this.#root?.context.id
	}

	// Guided settles, in guide pixels or in angles when the pixel scale is known.
	accepts(request: DitherRequest) {
		return request.settle.kind === 'guided' && (request.amount.unit === 'guidePixel' || this.#scale() > 0)
	}

	// Whether PHD2 guides (or settles).
	ready() {
		const state = this.state()
		return state === 'guiding' || state === 'settling'
	}

	// Dithers through PHD2 and waits for its settle, as the child `guidingDither` of `scope` without resources: one at a
	// time ('busy' otherwise); a settle already running (or left by a cancelled dither) is waited for first; an RPC
	// error fails 'commandFailed' at once; only the first SettleDone after the dispatch counts, even when it arrives
	// before the RPC reply; the settle timeout plus `GUIDING_SETTLE_TIMEOUT_MARGIN` fails 'timeout'; a closed socket
	// fails 'disconnected'. A cancelled dither leaves its settle pending (PHD2 cannot cancel a dither).
	async dither(scope: OperationScope, request: DitherRequest, onPhase?: (phase: DitherPhase) => void): Promise<OperationResult<DitherResult>> {
		const { amount, raOnly, settle } = request
		if (settle.kind !== 'guided') return failedOperationResult('unexpectedState', 'a guider dither needs a guided settle')
		if (this.#dithering) return failedOperationResult('busy', 'a dither is already running')

		this.#dithering = true
		this.#observe()

		try {
			return await scope.start<DitherResult>('guidingDither', [], async (context) => {
				const timeout = guidingSettleWaitTimeout(settle)

				if (this.#settlePending || this.#settling || (await this.#remoteSettling())) {
					const previous = await waitForGuidingSettle(context, 'guidingPreviousSettle', this.#settle, timeout, this.#delay, () => successfulOperationResult(undefined))
					if (!previous.ok && previous.reason !== 'commandFailed') return previous
				}

				const pixels = amount.unit === 'guidePixel' ? amount.value : toArcsec(amount.value) / this.#scale()
				if (!(pixels > 0 && Number.isFinite(pixels))) return failedOperationResult('unexpectedState', 'the dither amount has no guide-pixel size')

				onPhase?.('dithering')
				const settled = await waitForGuidingSettle(context, 'guidingDitherSettle', this.#settle, timeout, this.#delay, async () => commandResult(await this.client.dither(pixels, raOnly, { pixels: settle.pixels, time: settle.time, timeout: settle.timeout })), onPhase)
				if (!settled.ok && settled.reason === 'aborted') this.#settlePending = true
				return settled.ok ? successfulOperationResult({ kind: 'guider', lockShift: settled.value.lockShift ?? [0, 0] }) : settled
			}).result
		} finally {
			this.#dithering = false
		}
	}

	// Handler of the PHD2 client: events and the close of the socket.
	readonly #handler: PHD2ClientHandler = {
		event: (_, event) => this.#onEvent(event),
		close: () => this.#onClose(),
	}

	// Follows the application state and the settle, and records the interruptions nobody of the session caused.
	#onEvent(event: PHD2Events) {
		switch (event.Event) {
			case 'AppState':
				this.#appState = event.State
				if (event.State === 'Paused') this.#notifyPaused()
				else if (isActive(event.State)) this.#lastActiveAt = performance.now()
				return
			case 'StartCalibration':
			case 'Calibrating':
				this.#active('Calibrating')
				return
			case 'StartGuiding':
			case 'GuideStep':
			case 'Resumed':
				this.#active('Guiding')
				return
			case 'Paused':
				this.#appState = 'Paused'
				this.#lastActiveAt = performance.now()
				if (this.#expecting !== 'pause') this.#interrupt('paused', 'guiding paused outside the session')
				this.#notifyPaused()
				return
			case 'StarLost':
				if (this.#appState === 'Guiding' || this.#appState === 'Calibrating') this.#appState = 'LostLock'
				this.#interrupt('starLost', event.Status)
				return
			case 'LockPositionLost':
				this.#interrupt('lockPositionLost')
				return
			case 'GuidingStopped':
				this.#appState = 'Looping'
				if (this.#expecting !== 'stop') this.#interrupt('stopped', 'guiding stopped outside the session')
				return
			case 'LoopingExposures':
				if (this.#appState === undefined || this.#appState === 'Stopped') this.#appState = 'Looping'
				return
			case 'LoopingExposuresStopped':
				this.#appState = 'Stopped'
				return
			case 'StarSelected':
				if (this.#appState === 'Stopped' || this.#appState === 'Looping') this.#appState = 'Selected'
				return
			case 'GuidingDithered':
				this.#settle.notify({ kind: 'dithered', dx: event.dx, dy: event.dy })
				return
			case 'SettleBegin':
			case 'Settling':
				this.#settling = true
				this.#settle.notify({ kind: 'settling' })
				return
			case 'SettleDone':
				this.#settling = false
				this.#settlePending = false
				this.#settle.notify({ kind: 'done', status: event.Status, error: event.Error })
		}
	}

	// A closed socket: the state is unknown again, a guiding one is lost, the waits fail 'disconnected' and the root ends.
	#onClose() {
		const guiding = this.#root !== undefined || (this.#appState !== undefined && isActive(this.#appState))
		this.#appState = undefined
		this.#settling = false

		if (guiding) {
			this.#lost = true
			this.#interrupt('disconnected', 'the PHD2 connection closed')
		}

		this.#settle.notify({ kind: 'lost', reason: 'disconnected', detail: 'the PHD2 connection closed' })

		const root = this.#root
		this.#root = undefined
		root?.finish(failedOperationResult('disconnected', 'the PHD2 connection closed'))
	}

	// Marks PHD2 in an active (pulsing) state, unless paused.
	#active(state: 'Calibrating' | 'Guiding') {
		if (this.#appState !== 'Paused') this.#appState = state
		this.#lastActiveAt = performance.now()
	}

	#notifyPaused() {
		for (const waiter of this.#paused) waiter()
	}

	// Records an interruption at its reception, with the clock of the last start.
	#interrupt(kind: GuidingInterruptionKind, detail?: string) {
		const { wallNow, monotonicNow } = this.#clock
		this.#history.record(detail === undefined ? { kind, receivedMonotonic: monotonicNow(), receivedAt: wallNow() } : { kind, receivedMonotonic: monotonicNow(), receivedAt: wallNow(), detail })
	}

	// Asks PHD2 to pause fully and waits for its Paused event within the allowance, counted from the request.
	async #requestPause(signal: AbortSignal): Promise<OperationResult<void>> {
		const allowance = this.options.pausedEventAllowance ?? DEFAULT_PHD2_PAUSED_EVENT_ALLOWANCE
		const event = Promise.withResolvers<void>()
		const waiter = () => event.resolve()
		const timer = new AbortController()
		this.#paused.add(waiter)
		this.#expecting = 'pause'

		try {
			const timeout = this.#delay(allowance, AbortSignal.any([signal, timer.signal])).then((elapsed) => (elapsed.ok ? failedOperationResult('timeout', `PHD2 reported no pause within ${allowance} ms`) : failedOperationResult(abortReason(signal))))
			const requested = this.client.setPaused(true, true).then((result) => (result.success ? undefined : commandResult(result)))
			const refused = requested.then((failure) => failure ?? new Promise<never>(() => {}))
			const outcome = await Promise.race([event.promise.then(() => successfulOperationResult(undefined)), timeout, refused])
			if (outcome.ok) this.#lastActiveAt = performance.now()
			return outcome
		} finally {
			timer.abort()
			this.#paused.delete(waiter)
			this.#expecting = undefined
		}
	}

	// Waits for the physical end of the pulses: the observed guide output reporting no pulse, or `maxGuidePulse` from the
	// last instant PHD2 could pulse.
	async #quiesce(signal: AbortSignal): Promise<OperationResult<void>> {
		const { maxGuidePulse, guideOutput } = this.options

		if (guideOutput !== undefined) {
			const { device, manager } = guideOutput
			const stopped = await waitForDeviceState<undefined>({
				signal,
				timeout: maxGuidePulse + GUIDE_PULSE_STOP_SETTLE_TIMEOUT,
				subscribe: (listener) => {
					const handler: DeviceHandler<GuideOutput> = {
						added: () => {},
						updated: (updated) => {
							if (updated === device) listener(undefined)
						},
						removed: (removed) => {
							if (removed === device) listener(undefined)
						},
					}

					manager.addHandler(handler)
					return () => manager.removeHandler(handler)
				},
				current: () => undefined,
				evaluate: () => (!device.connected ? 'disconnected' : device.pulsing ? 'pending' : 'success'),
				command: () => {},
			})

			return stopped.ok ? successfulOperationResult(undefined) : stopped
		}

		const remaining = this.#lastActiveAt === undefined ? 0 : this.#lastActiveAt + maxGuidePulse - performance.now()
		return remaining > 0 ? await this.#delay(remaining, signal) : successfulOperationResult(undefined)
	}

	// Whether PHD2 reports a running settle; false when it cannot be asked.
	async #remoteSettling() {
		if (this.client.remoteAddress === undefined) return false
		const settling = await this.client.getSettling()
		return settling.success && settling.result
	}

	// Pixel scale of the guide camera, in arcsec/pixel: the configured one, or the last reported by PHD2.
	#scale() {
		return this.options.pixelScale ?? this.#pixelScale
	}

	// Connects to PHD2 unless connected, then reconciles the application state and the pixel scale it reports.
	async #connect(): Promise<OperationResult<void>> {
		if (this.client.remoteAddress === undefined) {
			try {
				await this.client.connect(this.options.host, this.#port)
			} catch {
				return failedOperationResult('disconnected', `PHD2 is not reachable at ${this.options.host}:${this.#port}`)
			}

			this.#appState = undefined
		}

		if (this.#appState === undefined) {
			const state = await this.client.getAppState()
			if (!state.success) return commandResult(state)
			this.#appState = state.result
			if (isActive(state.result) || state.result === 'Paused') this.#lastActiveAt = performance.now()

			const scale = await this.client.getPixelScale()
			if (scale.success && scale.result > 0) this.#pixelScale = scale.result
		}

		return successfulOperationResult(undefined)
	}

	// Opens the root `guiding` under the reservation, leasing the logical PHD2 resource, unless it lives. Its executor
	// stays pending until `stop` ends it or the socket closes.
	async #openRoot(reservation: OperationScope): Promise<OperationResult<void>> {
		if (this.#root !== undefined) return successfulOperationResult(undefined)

		let opened: { context: OperationContext; finish: (result: OperationResult<void>) => void } | undefined

		const handle = reservation.start<void>(
			'guiding',
			this.resources().hold,
			(context) =>
				new Promise((resolve) => {
					opened = { context, finish: resolve }
					context.signal.addEventListener('abort', () => resolve(failedOperationResult(abortReason(context.signal))), { once: true })
					context.onCleanup(() => {
						if (this.#root?.context === context) this.#root = undefined
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

	#observe() {
		if (this.#observing) return
		this.#observing = true
		this.client.addHandler(this.#handler)
	}

	#unobserve() {
		if (!this.#observing) return
		this.#observing = false
		this.client.removeHandler(this.#handler)
	}
}

// Whether a PHD2 application state may emit guide pulses.
function isActive(state: PHD2AppState) {
	return state === 'Calibrating' || state === 'Guiding' || state === 'LostLock'
}

// Operation result of a PHD2 command: its RPC error, timeout or socket failure as a failure.
function commandResult(result: PHD2CommandResult<unknown>): OperationResult<void> {
	if (result.success) return successfulOperationResult(undefined)
	const { error } = result
	if (error === 'socketUnavailable' || error === 'socketError') return failedOperationResult('disconnected', `PHD2 ${error}`)
	if (error === 'timeout') return failedOperationResult('timeout', 'PHD2 did not reply')
	return failedOperationResult('commandFailed', `PHD2 error ${error.code}: ${error.message}`)
}
