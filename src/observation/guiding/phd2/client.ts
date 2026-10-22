import type { PartialOnly, Writable } from '../../../core/types'
import { SocketWriteQueue } from '../../../io/socket'
import type { Point, Size } from '../../../math/numerical/geometry'
// oxfmt-ignore
import { DEFAULT_PHD2_PORT, DEFAULT_PHD2_SETTLE, DEFAULT_ROI, type PHD2AppState, type PHD2CalibrationData, type PHD2Command, type PHD2DeclinationGuideMode, type PHD2Equipment, type PHD2Error, type PHD2Events, type PHD2GuideAxis, type PHD2GuideDirection, type PHD2JsonRpcEvent, type PHD2LockShiftParams, type PHD2Profile, type PHD2Settle, type PHD2StarImage, type PHD2WhichMount } from './types'

// Client for PHD2's TCP event-monitoring / JSON-RPC interface. A PHD2Client issues RPC commands (each a thin
// wrapper over send()) and dispatches async events and command replies to every registered handler. The protocol
// types live in `./types`; field names mirror the PHD2 protocol. Output the socket does not take at once is queued
// until it drains; a server that stops reading for more than the queue bound is disconnected.

// Outcome of an RPC command: a typed result on success, or an error/timeout on failure.
export type PHD2CommandResult<T> = { success: false; error: PHD2Error | 'timeout' | 'socketUnavailable' | 'socketError'; result?: never } | { success: true; result: T }

// Callbacks for PHD2 events, command replies, and connection close, registered with `PHD2Client.addHandler`.
// Every handler receives every notification in registration order; an exception thrown by one is caught and
// logged, so a failing observer can neither break the socket parsing nor keep the other handlers from being called.
export interface PHD2ClientHandler {
	readonly event?: (client: PHD2Client, event: PHD2Events) => void
	readonly command?: (client: PHD2Client, command: PHD2Command, success: boolean, result: unknown) => void
	readonly close?: (client: PHD2Client, error?: Error) => void
}

const DEFAULT_TIMEOUT = 15000

// An in-flight command awaiting its JSON-RPC reply, with its resolver, timeout, and original command.
interface PendingPHD2Command<T> {
	readonly promise: PromiseWithResolvers<PHD2CommandResult<T>>
	readonly timer: ReturnType<typeof setTimeout>
	readonly command: PHD2Command
}

// PHD2 JSON-RPC client over TCP. Connects to PHD2, sends commands and correlates their replies by id,
// and dispatches asynchronous events to every registered handler. The command methods below are thin,
// self-describing wrappers over send(); only the connection/transport internals are commented in detail.
export class PHD2Client implements Disposable {
	readonly #commands = new Map<string, PendingPHD2Command<unknown>>()
	#socket?: Bun.Socket
	// Output of the current connection not yet taken by its socket.
	readonly #output = new SocketWriteQueue()
	#buffer?: Buffer
	#id?: string
	// Observers of events, command replies and closes, notified in registration order.
	readonly #handlers = new Set<PHD2ClientHandler>()

	get remoteAddress() {
		return this.#socket?.remoteAddress
	}

	get remotePort() {
		return this.#socket?.remotePort
	}

	get localAddress() {
		return this.#socket?.localAddress
	}

	get localPort() {
		return this.#socket?.localPort
	}

	get id() {
		return this.#id
	}

	// Registers an observer of this client. Registering the same handler twice changes nothing; a handler added
	// while a notification is being delivered may receive it.
	addHandler(handler: PHD2ClientHandler) {
		this.#handlers.add(handler)
	}

	// Unregisters an observer; idempotent, and safe while a notification is being delivered.
	removeHandler(handler: PHD2ClientHandler) {
		this.#handlers.delete(handler)
	}

	// Connects to the PHD2 server, wiring socket events into the line parser. Returns false if already connected.
	async connect(hostname: string, port: number = DEFAULT_PHD2_PORT) {
		if (this.#socket) return false
		this.#buffer = undefined
		this.#output.clear()

		this.#socket = await Bun.connect({
			hostname,
			port,
			socket: {
				data: (_, data) => {
					this.#processData(data)
				},
				drain: (socket) => {
					this.#output.drain(socket)
				},
				error: (_, error) => {
					console.error('socket error:', error)
				},
				connectError: (_, error) => {
					console.error('connection failed:', error)
				},
				close: (_, error) => {
					console.info('connection closed:', error?.message)
					this.#notify('close', (handler) => handler.close?.(this, error))
					this.close()
				},
			},
		})

		this.#id = Bun.MD5.hash(`PHD2:${this.remoteAddress}:${this.remotePort}`, 'hex')

		return true
	}

	// Closes the socket and clears all pending commands and their timers.
	close() {
		this.#socket?.close()
		this.#socket = undefined
		this.#output.clear()

		for (const command of this.#commands.values()) {
			clearTimeout(command.timer)
			command.promise.resolve({ success: false, error: 'socketUnavailable' })
		}

		this.#commands.clear()
		this.#buffer = undefined
	}

	[Symbol.dispose]() {
		this.close()
	}

	// Sends a JSON-RPC command and awaits its reply, returning the PHD2 command result.
	// Each command is tracked by a generated id until its reply arrives.
	async send<T>(method: string, params?: Record<string, unknown> | unknown[], timeout: number = DEFAULT_TIMEOUT): Promise<PHD2CommandResult<T>> {
		if (!this.#socket) return { success: false, error: 'socketUnavailable' }

		const id = Bun.randomUUIDv7()
		const command: PHD2Command = { method, params, id }

		const promise = Promise.withResolvers<PHD2CommandResult<T>>()
		const timer = setTimeout(
			() => {
				if (this.#commands.delete(id)) promise.resolve({ success: false, error: 'timeout' })
			},
			timeout <= 0 || !Number.isFinite(timeout) ? DEFAULT_TIMEOUT : timeout,
		)
		this.#commands.set(id, { promise, timer, command } as PendingPHD2Command<unknown>)

		try {
			// One write per command, so a backpressured socket never queues a command apart from its terminator.
			if (!this.#output.write(this.#socket, `${JSON.stringify(command)}\r\n`)) {
				console.error('socket error: output queue full')
				clearTimeout(timer)
				this.#commands.delete(id)
				this.close()
				return { success: false, error: 'socketError' }
			}
		} catch (e) {
			console.error('socket error:', e)
			clearTimeout(timer)
			this.#commands.delete(id)
			return { success: false, error: 'socketError' }
		}

		const result = await promise.promise

		if (result.success) return result

		if (result.error === 'timeout') console.error(method, 'command timed out after', timeout, 'ms')
		else console.error(method, 'command failed:', result.error)

		return result
	}

	// RPC command wrappers. Each maps to a PHD2 method of the same intent and returns the typed result.
	findStar(roi: Partial<Point & Size> = DEFAULT_ROI) {
		const { x, y, width, height } = Object.assign({}, DEFAULT_ROI, roi)
		const subframe = width && height ? [x, y, width, height] : undefined
		return this.send<readonly [number, number]>('find_star', subframe ? { roi: subframe } : undefined)
	}

	startCapture(exposure: number, roi: Partial<Point & Size> = DEFAULT_ROI) {
		const { x, y, width, height } = Object.assign({}, DEFAULT_ROI, roi)
		const subframe = width && height ? [x, y, width, height] : undefined
		return this.send<number>('capture_single_frame', { exposure, subframe })
	}

	stopCapture() {
		return this.send<number>('stop_capture')
	}

	clearCalibration(which: PHD2WhichMount = 'BOTH') {
		return this.send<number>('clear_calibration', [which])
	}

	deselectStar() {
		return this.send<number>('deselect_star')
	}

	dither(amount: number, raOnly: boolean = false, settle: Partial<PHD2Settle> = DEFAULT_PHD2_SETTLE, timeout: number = DEFAULT_TIMEOUT) {
		settle = { ...DEFAULT_PHD2_SETTLE, ...settle }
		return this.send<number>('dither', { amount, raOnly, settle }, timeout)
	}

	flipCalibration() {
		return this.send<number>('flip_calibration')
	}

	getAlgorithmParam(axis: PHD2GuideAxis, name: string) {
		return this.send<unknown>('get_algo_param', { axis, name })
	}

	getAlgorithmParamNames(axis: PHD2GuideAxis) {
		return this.send<readonly string[]>('get_algo_param_names', { axis })
	}

	getAppState() {
		return this.send<PHD2AppState>('get_app_state')
	}

	getCalibrated() {
		return this.send<boolean>('get_calibrated')
	}

	getCalibrationData(which: PHD2WhichMount = 'MOUNT') {
		return this.send<PHD2CalibrationData>('get_calibration_data', [which])
	}

	getCameraBinning() {
		return this.send<number>('get_camera_binning')
	}

	getCameraFrameSize() {
		return this.send<readonly [number, number]>('get_camera_frame_size')
	}

	getConnected() {
		return this.send<boolean>('get_connected')
	}

	getCurrentEquipment() {
		return this.send<PHD2Equipment>('get_current_equipment')
	}

	getDeclinationGuideMode() {
		return this.send<PHD2DeclinationGuideMode>('get_dec_guide_mode')
	}

	getExposure() {
		return this.send<number>('get_exposure')
	}

	getExposureDurations() {
		return this.send<readonly number[]>('get_exposure_durations')
	}

	getGuideOutputEnabled() {
		return this.send<boolean>('get_guide_output_enabled')
	}

	getLockPosition() {
		return this.send<readonly [number, number] | null>('get_lock_position')
	}

	getLockShiftEnabled() {
		return this.send<boolean>('get_lock_shift_enabled')
	}

	getLockShiftParams() {
		return this.send<PHD2LockShiftParams>('get_lock_shift_params')
	}

	getPaused() {
		return this.send<boolean>('get_paused')
	}

	getPixelScale() {
		return this.send<number>('get_pixel_scale')
	}

	getProfile() {
		return this.send<Omit<PHD2Profile, 'selected'>>('get_profile')
	}

	getProfiles() {
		return this.send<readonly PHD2Profile[]>('get_profiles')
	}

	getSearchRegion() {
		return this.send<number>('get_search_region')
	}

	getSettling() {
		return this.send<boolean>('get_settling')
	}

	getStarImage() {
		return this.send<PHD2StarImage<string>>('get_star_image')
	}

	getUseSubframes() {
		return this.send<boolean>('get_use_subframes')
	}

	guide(recalibrate: boolean = false, settle: PHD2Settle = DEFAULT_PHD2_SETTLE, roi: Point & Size = DEFAULT_ROI) {
		const x = roi.x ?? DEFAULT_ROI.x
		const y = roi.y ?? DEFAULT_ROI.y
		const width = roi.width ?? DEFAULT_ROI.width
		const height = roi.height ?? DEFAULT_ROI.height
		const subframe = width && height ? [x, y, width, height] : undefined
		settle = { ...DEFAULT_PHD2_SETTLE, ...settle }
		return this.send<number>('guide', { recalibrate, roi: subframe, settle })
	}

	guidePulse(amount: number, direction: PHD2GuideDirection, which: PHD2WhichMount = 'MOUNT') {
		return this.send<number>('guide_pulse', [amount, direction, which])
	}

	loop() {
		return this.send<number>('loop')
	}

	saveImage() {
		return this.send<{ readonly filename: string }>('save_image')
	}

	setAlgorithmParam(axis: PHD2GuideAxis, name: string, value: unknown) {
		return this.send<number>('set_algo_param', [axis, name, value])
	}

	setConnected(connected: boolean) {
		return this.send<number>('set_connected', [connected])
	}

	setDeclinationGuideMode(mode: PHD2DeclinationGuideMode) {
		return this.send<number>('set_dec_guide_mode', [mode])
	}

	setExposure(exposure: number) {
		return this.send<number>('set_exposure', [exposure])
	}

	setGuideOutputEnabled(enabled: boolean) {
		return this.send<number>('set_guide_output_enabled', [enabled])
	}

	setLockPosition(x: number, y: number, exact: boolean = false) {
		return this.send<number>('set_lock_position', [x, y, exact])
	}

	setLockShiftEnabled(enabled: boolean) {
		return this.send<number>('set_lock_shift_enabled', [enabled])
	}

	setLockShiftParams(params: PartialOnly<Omit<Writable<PHD2LockShiftParams>, 'enabled'>, 'units'>) {
		const units = params.units || (params.axes === 'RA/Dec' ? 'arcsec/hr' : 'pixels/hr')
		return this.send<number>('set_lock_shift_params', { ...params, units })
	}

	setPaused(paused: boolean, full: boolean = true) {
		return this.send<number>('set_paused', full ? [paused, 'full'] : [paused])
	}

	setProfile(profile: number | PHD2Profile) {
		const id = typeof profile === 'number' ? profile : profile.id
		return this.send<number>('set_profile', [id])
	}

	shutdown() {
		return this.send<number>('shutdown')
	}

	// Buffers incoming bytes and parses complete JSON lines (PHD2 sends newline-delimited JSON), keeping
	// any partial trailing line for the next chunk.
	#processData(data: Buffer) {
		let buffer = this.#buffer === undefined ? data : Buffer.concat([this.#buffer, data])

		while (buffer.length > 0) {
			const result = Bun.JSONL.parseChunk(buffer)

			for (const event of result.values) {
				this.#processEvent(event as never)
			}

			if (result.error) {
				const newline = buffer.indexOf(10, result.read)
				if (newline < 0) {
					this.#buffer = undefined
					return
				}

				buffer = buffer.subarray(newline + 1)
				continue
			}

			if (result.done) {
				this.#buffer = undefined
			} else {
				// Keep only the unconsumed portion
				this.#buffer = buffer.subarray(result.read)
			}

			return
		}

		this.#buffer = undefined
	}

	// Routes a parsed message: a JSON-RPC reply resolves the matching pending command (and fires the
	// command handler); anything else is delivered as an asynchronous event.
	#processEvent(event: PHD2Events | PHD2JsonRpcEvent) {
		if ('jsonrpc' in event) {
			const { id, error, result } = event
			const command = this.#commands.get(id)

			if (command) {
				clearTimeout(command.timer)
				this.#commands.delete(id)

				if (error) {
					command.promise.resolve({ success: false, error })
					this.#notify('command', (handler) => handler.command?.(this, command.command, false, error))
				} else {
					command.promise.resolve({ success: true, result })
					this.#notify('command', (handler) => handler.command?.(this, command.command, true, result))
				}
			}
		} else {
			this.#notify('event', (handler) => handler.event?.(this, event))
		}
	}

	// Calls `notify` for every registered handler in registration order. Handlers are user code: a throw is
	// logged under `kind` and must neither unwind the socket parsing nor skip the remaining handlers.
	#notify(kind: keyof PHD2ClientHandler, notify: (handler: PHD2ClientHandler) => void) {
		for (const handler of this.#handlers) {
			try {
				notify(handler)
			} catch (e) {
				console.error(`PHD2 ${kind} handler failed:`, e)
			}
		}
	}
}
