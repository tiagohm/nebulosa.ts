import type { Socket, TCPSocketListener } from 'bun'
import type { Camera, GuideOutput } from '../../../devices/indi/device'
import type { ImageRawType } from '../../../imaging/model/types'
import { DEFAULT_MAX_PENDING_WRITE, SocketWriteQueue } from '../../../io/socket'
import type { GuiderClient, GuiderClientConnectOptions, GuiderClientHandler } from '../client'
// oxfmt-ignore
import { DEFAULT_PHD2_PORT, PHD2_MSG_VERSION, PHD2_OVERLAP_SUPPORT, PHD2_SUBVER, PHD2_VERSION, type PHD2DeclinationGuideMode, type PHD2Equipment, type PHD2Error, type PHD2EventMap, type PHD2GuideDirection, type PHD2LockShiftParams, type PHD2RateUnit, type PHD2Settle, type PHD2ShiftAxis, type PHD2StarImage } from './types'

// PHD2-compatible TCP server over a local GuiderClient. It speaks PHD2's event-monitoring / JSON-RPC 2.0 protocol
// (newline-delimited JSON, `\r\n` on output): every request is executed on the GuiderClient and answered on the
// same socket, and every PHD2 event the GuiderClient emits is broadcast to every connected socket, so any PHD2
// client (PHD2Client, PHD2GuidingSession, imaging applications) can drive the local guider. The server does not
// own the GuiderClient: its tracker, devices and lifecycle stay with the caller. Commands are synchronous on the
// GuiderClient, so a reply is written after the events its command emitted, as PHD2 does. Units follow PHD2:
// exposures and pulses in milliseconds, distances in guide pixels, settle times in seconds, pixel scale in
// arcsec/pixel. Each socket keeps its own bounded input and output buffers.

// Equipment `set_connected(true)` binds to the GuiderClient, with its connection options.
export interface PHD2ServerDevices {
	// Guide camera.
	readonly camera: Camera
	// Guide output (mount ST4 or camera port).
	readonly guideOutput: GuideOutput
	// Optics used to derive the pixel scale.
	readonly options?: GuiderClientConnectOptions
}

// The single equipment profile the server reports.
export interface PHD2ServerProfile {
	// Profile id; `set_profile` accepts only this id.
	readonly id: number
	// Profile name.
	readonly name: string
}

// Construction options of a PHD2Server.
export interface PHD2ServerOptions {
	// Equipment bound by `set_connected(true)`; without it `set_connected(true)` fails unless already connected.
	readonly devices?: PHD2ServerDevices
	// Reported profile; default `DEFAULT_PHD2_SERVER_PROFILE`.
	readonly profile?: PHD2ServerProfile
	// Exposure durations offered by `get_exposure_durations`, in ms; default `DEFAULT_PHD2_EXPOSURE_DURATIONS`.
	readonly exposureDurations?: readonly number[]
	// Longest unterminated input line kept per socket, in bytes; longer closes the socket. Default 1 MiB.
	readonly maxLineLength?: number
	// Most output bytes queued for a socket that does not read; more closes the socket. Default 16 MiB.
	readonly maxPendingWrite?: number
}

// Id of a JSON-RPC request: a string or number, or null when it could not be read.
export type PHD2RequestId = string | number | null

// A JSON-RPC request received by the server. `id` is undefined for a notification, which gets no reply.
export interface PHD2ServerRequest {
	readonly id?: PHD2RequestId
	readonly method: string
	readonly params?: unknown
}

// Outcome of one request: its result, or the JSON-RPC error replied.
export type PHD2ServerResponse = { readonly result: unknown; readonly error?: never } | { readonly error: PHD2Error; readonly result?: never }

// Observers of the server, registered with `PHD2Server.addHandler`. Every handler receives every notification in
// registration order; an exception thrown by one is caught and logged. `connection` is a per-server sequence
// number of the socket, starting at 1.
export interface PHD2ServerHandler {
	// A socket connected and was greeted.
	readonly connect?: (server: PHD2Server, connection: number) => void
	// A socket closed, or the server stopped while it was open.
	readonly disconnect?: (server: PHD2Server, connection: number) => void
	// A well-formed request was executed, with its outcome; called before the reply is written.
	readonly command?: (server: PHD2Server, connection: number, request: PHD2ServerRequest, response: PHD2ServerResponse) => void
	// A client requested `shutdown`; called after the reply is written. Without such a handler `shutdown` fails.
	readonly shutdown?: (server: PHD2Server) => void
}

// Profile reported when none is configured.
export const DEFAULT_PHD2_SERVER_PROFILE: Readonly<PHD2ServerProfile> = { id: 1, name: 'Nebulosa' }

// Exposure durations offered when none are configured, in ms; the PHD2 drop-down list.
export const DEFAULT_PHD2_EXPOSURE_DURATIONS: readonly number[] = [10, 20, 50, 100, 200, 500, 1000, 1500, 2000, 2500, 3000, 3500, 4000, 4500, 5000, 6000, 7000, 8000, 9000, 10000, 15000, 20000, 25000, 30000]

// Default longest unterminated input line, in bytes.
const DEFAULT_MAX_LINE_LENGTH = 1024 * 1024

// JSON-RPC 2.0 error codes.
const PARSE_ERROR = -32700
const INVALID_REQUEST = -32600
const METHOD_NOT_FOUND = -32601
const INVALID_PARAMS = -32602
const INTERNAL_ERROR = -32603

// PHD2 application error codes: a refused command, and no selected star for `get_star_image`.
const COMMAND_FAILED = 1
const NO_STAR_SELECTED = 2

// Line feed byte that terminates every JSON message.
const LF = 10

// PHD2 methods the local guider cannot serve: replied with COMMAND_FAILED instead of METHOD_NOT_FOUND.
const UNSUPPORTED_METHODS = new Set(['get_algo_param_names', 'get_algo_param', 'set_algo_param', 'save_image'])

// Marker of a parameter that is present with a wrong type or out of its domain.
const INVALID = Symbol('invalid')

// Parameters of a request: positional, named, or absent.
type Params = readonly unknown[] | Readonly<Record<string, unknown>> | undefined

// State of one connected socket: its input tail, whether it skips a malformed line, and its output queue.
interface Connection {
	readonly id: number
	readonly socket: Socket<unknown>
	// Unconsumed input after the last complete message.
	buffer?: Buffer
	// Whether the rest of a malformed line is dropped until its line feed.
	discarding: boolean
	// Output not yet accepted by the socket, in order.
	readonly output: SocketWriteQueue
}

// PHD2-compatible JSON-RPC server delegating to one GuiderClient.
// https://github.com/OpenPHDGuiding/phd2/wiki/EventMonitoring
export class PHD2Server implements Disposable {
	readonly #connections = new Map<Socket<unknown>, Connection>()
	readonly #handlers = new Set<PHD2ServerHandler>()
	readonly #maxLineLength: number
	readonly #maxPendingWrite: number
	#server?: TCPSocketListener
	#sequence = 0

	// Broadcasts the PHD2 events of the guider. Version is only sent by the greeting; the Guiding Assistant events
	// are not part of the PHD2 protocol.
	readonly #guiderHandler: GuiderClientHandler = {
		event: (_, event) => {
			const name: string = event.Event
			if (name === 'Version' || name.startsWith('GuidingAssistant')) return
			this.#broadcast(event)
		},
	}

	constructor(
		readonly guider: GuiderClient,
		readonly options: PHD2ServerOptions = {},
	) {
		this.#maxLineLength = options.maxLineLength ?? DEFAULT_MAX_LINE_LENGTH
		this.#maxPendingWrite = options.maxPendingWrite ?? DEFAULT_MAX_PENDING_WRITE
	}

	// Bound hostname, or undefined when stopped.
	get hostname() {
		return this.#server?.hostname
	}

	// Bound port, or -1 when stopped.
	get port() {
		return this.#server?.port ?? -1
	}

	// Number of connected sockets.
	get connections() {
		return this.#connections.size
	}

	// Registers an observer; registering the same handler twice changes nothing.
	addHandler(handler: PHD2ServerHandler) {
		this.#handlers.add(handler)
	}

	// Unregisters an observer; idempotent.
	removeHandler(handler: PHD2ServerHandler) {
		this.#handlers.delete(handler)
	}

	// Listens on `hostname:port` (port 0 picks a free one) and starts forwarding the guider events. Returns false if
	// already started; throws when the address cannot be bound.
	start(hostname: string = '0.0.0.0', port: number = DEFAULT_PHD2_PORT) {
		if (this.#server) return false

		this.#server = Bun.listen({
			hostname,
			port,
			allowHalfOpen: false,
			socket: {
				open: (socket) => this.#open(socket),
				data: (socket, data) => this.#receive(socket, data),
				drain: (socket) => this.#drain(socket),
				close: (socket) => this.#close(socket),
				error: (_, error) => console.error('PHD2 server socket error:', error),
			},
		})

		this.guider.addHandler(this.#guiderHandler)

		return true
	}

	// Stops listening, closes every socket (notifying `disconnect`) and stops forwarding the guider events. Idempotent.
	stop() {
		if (!this.#server) return

		this.guider.removeHandler(this.#guiderHandler)
		const connections = [...this.#connections.values()]
		this.#connections.clear()
		for (const connection of connections) connection.socket.end()
		this.#server.stop(true)
		this.#server = undefined

		for (const connection of connections) {
			this.#notify('disconnect', (handler) => handler.disconnect?.(this, connection.id))
		}
	}

	[Symbol.dispose]() {
		this.stop()
	}

	// Greets a new socket like PHD2: Version, the lock position and calibration when known, then the app state.
	#open(socket: Socket<unknown>) {
		const connection: Connection = { id: ++this.#sequence, socket, discarding: false, output: new SocketWriteQueue(this.#maxPendingWrite) }
		this.#connections.set(socket, connection)

		this.#send(connection, event('Version', { PHDVersion: PHD2_VERSION, PHDSubver: PHD2_SUBVER, OverlapSupport: PHD2_OVERLAP_SUPPORT, MsgVersion: PHD2_MSG_VERSION }))

		const lock = this.guider.getLockPosition()
		if (lock !== undefined) this.#send(connection, event('LockPositionSet', { X: lock[0], Y: lock[1] }))
		if (this.guider.getCalibrated()) this.#send(connection, event('CalibrationComplete', { Mount: this.guider.guideOutput?.name ?? '' }))
		this.#send(connection, event('AppState', { State: this.guider.getAppState() }))

		if (this.#connections.has(socket)) this.#notify('connect', (handler) => handler.connect?.(this, connection.id))
	}

	#close(socket: Socket<unknown>) {
		const connection = this.#connections.get(socket)
		if (connection === undefined) return
		this.#connections.delete(socket)
		this.#notify('disconnect', (handler) => handler.disconnect?.(this, connection.id))
	}

	// Drops a socket that broke a transport bound.
	#drop(connection: Connection, reason: string) {
		console.warn('PHD2 server closing connection', connection.id, reason)
		connection.buffer = undefined
		connection.output.clear()
		connection.socket.end()
		this.#close(connection.socket)
	}

	// Decodes the newline-delimited JSON of a socket with Bun.JSONL, keeping an incomplete trailing message for the
	// next chunk. A malformed line is answered with a parse error and skipped up to its line feed.
	#receive(socket: Socket<unknown>, data: Buffer) {
		const connection = this.#connections.get(socket)
		if (connection === undefined) return

		let buffer = connection.buffer === undefined ? data : Buffer.concat([connection.buffer, data])
		connection.buffer = undefined

		while (buffer.byteLength > 0) {
			if (connection.discarding) {
				const newline = buffer.indexOf(LF)
				if (newline < 0) return
				connection.discarding = false
				buffer = buffer.subarray(newline + 1)
				continue
			}

			const result = Bun.JSONL.parseChunk(buffer)

			for (const value of result.values) {
				if (!this.#connections.has(socket)) return
				this.#handle(connection, value)
			}

			if (!this.#connections.has(socket)) return

			if (result.error) {
				this.#send(connection, failure(null, PARSE_ERROR, 'parse error'))
				connection.discarding = true
				// `read` stops right after the last good value, before its line terminator: skip it so the
				// malformed line itself is the one discarded.
				buffer = buffer.subarray(skipWhitespace(buffer, result.read))
				continue
			}

			if (!result.done) {
				const rest = buffer.subarray(result.read)
				// An unterminated line must not grow without bound.
				if (rest.byteLength > this.#maxLineLength) this.#drop(connection, 'line too long')
				else connection.buffer = rest
			}

			return
		}
	}

	// Executes one message (a request or a batch) and writes its reply, if any.
	#handle(connection: Connection, message: unknown) {
		if (!Array.isArray(message)) {
			const reply = this.#execute(connection, message)
			if (reply !== undefined) this.#send(connection, reply)
			return
		}

		if (message.length === 0) {
			this.#send(connection, failure(null, INVALID_REQUEST, 'empty batch'))
			return
		}

		const replies: object[] = []

		for (const request of message) {
			const reply = this.#execute(connection, request)
			if (reply !== undefined) replies.push(reply)
		}

		if (replies.length > 0) this.#send(connection, replies)
	}

	// Executes one request: returns its reply, or undefined for a notification.
	#execute(connection: Connection, message: unknown) {
		if (!isRecord(message) || typeof message.method !== 'string') {
			const id = isRecord(message) && isRequestId(message.id) ? message.id : null
			return failure(id, INVALID_REQUEST, 'invalid request')
		}

		const { method, params } = message
		const id = isRequestId(message.id) ? message.id : message.id === undefined ? undefined : null
		const request: PHD2ServerRequest = { id, method, params }
		let response: PHD2ServerResponse

		if (params !== undefined && params !== null && typeof params !== 'object') {
			response = error(INVALID_PARAMS, 'params must be an array or an object')
		} else {
			try {
				response = this.#dispatch(method, (params ?? undefined) as Params)
			} catch (e) {
				console.error('PHD2 server command failed:', method, e)
				response = error(INTERNAL_ERROR, e instanceof Error ? e.message : String(e))
			}
		}

		this.#notify('command', (handler) => handler.command?.(this, connection.id, request, response))

		if (method === 'shutdown' && response.error === undefined) {
			queueMicrotask(() => this.#notify('shutdown', (handler) => handler.shutdown?.(this)))
		}

		if (id === undefined) return undefined
		return response.error === undefined ? { jsonrpc: '2.0', result: response.result, id } : failure(id, response.error.code, response.error.message)
	}

	// Maps one PHD2 method to the GuiderClient.
	#dispatch(method: string, params: Params): PHD2ServerResponse {
		const { guider } = this

		switch (method) {
			case 'get_app_state':
				return ok(guider.getAppState())
			case 'get_calibrated':
				return ok(guider.getCalibrated())
			case 'get_camera_binning':
				return ok(guider.getCameraBinning())
			case 'get_camera_frame_size':
				return ok(guider.getCameraFrameSize())
			case 'get_connected':
				return ok(guider.getConnected())
			case 'get_dec_guide_mode':
				return ok(guider.getDeclinationGuideMode())
			case 'get_exposure':
				return ok(guider.getExposure())
			case 'get_exposure_durations':
				return ok(this.options.exposureDurations ?? DEFAULT_PHD2_EXPOSURE_DURATIONS)
			case 'get_guide_output_enabled':
				return ok(guider.getGuideOutputEnabled())
			case 'get_lock_position':
				return ok(guider.getLockPosition() ?? null)
			case 'get_lock_shift_enabled':
				return ok(guider.getLockShiftEnabled())
			case 'get_lock_shift_params':
				return ok(guider.getLockShiftParams())
			case 'get_paused':
				return ok(guider.getPaused())
			case 'get_pixel_scale':
				return ok(guider.getPixelScale())
			case 'get_search_region':
				return ok(guider.getSearchRegion())
			case 'get_settling':
				return ok(guider.getSettling())
			case 'get_use_subframes':
				return ok(false)
			case 'get_current_equipment':
				return ok(this.#equipment())
			case 'get_profile': {
				const { id, name } = this.#profile()
				return ok({ id, name })
			}
			case 'get_profiles': {
				const { id, name } = this.#profile()
				return ok([{ id, name, selected: true }])
			}
			case 'set_profile': {
				const id = read(params, 0, 'id', isInteger)
				if (id === INVALID) return invalid('id')
				return id === this.#profile().id ? ok(0) : error(COMMAND_FAILED, `invalid profile id: ${id}`)
			}
			case 'get_calibration_data': {
				const which = read(params, 0, 'which', isWhich, 'MOUNT')
				if (which === INVALID || which === 'BOTH') return invalid('which')
				return which === 'AO' ? error(COMMAND_FAILED, 'AO not connected') : ok(guider.getCalibrationData())
			}
			case 'clear_calibration': {
				const which = read(params, 0, 'which', isWhich, 'BOTH')
				if (which === INVALID) return invalid('which')
				// There is no AO: clearing it alone changes nothing.
				if (which !== 'AO') guider.clearCalibration()
				return ok(0)
			}
			case 'flip_calibration':
				return refused(guider.flipCalibration(), 'no calibration data to flip')
			case 'set_connected': {
				const connected = read(params, 0, 'connected', isBoolean)
				if (connected === INVALID) return invalid('connected')
				return this.#setConnected(connected)
			}
			case 'set_exposure': {
				const exposure = read(params, 0, 'exposure', isPositive)
				if (exposure === INVALID) return invalid('exposure')
				return refused(guider.setExposure(exposure), 'invalid exposure')
			}
			case 'set_dec_guide_mode': {
				const mode = read(params, 0, 'mode', isDeclinationGuideMode)
				if (mode === INVALID) return invalid('mode')
				guider.setDeclinationGuideMode(mode)
				return ok(0)
			}
			case 'set_guide_output_enabled': {
				const enabled = read(params, 0, 'enabled', isBoolean)
				if (enabled === INVALID) return invalid('enabled')
				guider.setGuideOutputEnabled(enabled)
				return ok(0)
			}
			case 'set_lock_position': {
				const x = read(params, 0, 'x', isFiniteNumber)
				const y = read(params, 1, 'y', isFiniteNumber)
				// PHD2 sets the exact position unless told otherwise.
				const exact = read(params, 2, 'exact', isBoolean, true)
				if (x === INVALID || y === INVALID || exact === INVALID) return invalid('x, y, exact')
				return refused(guider.setLockPosition(x, y, exact), 'could not set lock position')
			}
			case 'set_lock_shift_enabled': {
				const enabled = read(params, 0, 'enabled', isBoolean)
				if (enabled === INVALID) return invalid('enabled')
				return refused(guider.setLockShiftEnabled(enabled), 'lock shift needs a known pixel scale')
			}
			case 'set_lock_shift_params': {
				const rate = read(params, 0, 'rate', isRate)
				const axes = read(params, 2, 'axes', isShiftAxis)
				const units = read(params, 1, 'units', isRateUnit, axes === 'RA/Dec' ? 'arcsec/hr' : 'pixels/hr')
				if (rate === INVALID || axes === INVALID || units === INVALID) return invalid('rate, units, axes')
				return refused(guider.setLockShiftParams({ rate, units, axes }), 'invalid lock shift params')
			}
			case 'set_paused': {
				const paused = read(params, 0, 'paused', isBoolean)
				const type = read(params, 1, 'type', isString, '')
				if (paused === INVALID || type === INVALID) return invalid('paused, type')
				guider.setPaused(paused, type === 'full')
				return ok(0)
			}
			case 'loop':
				return refused(guider.loop(), 'cannot start looping: camera not connected')
			case 'stop_capture':
				guider.stopCapture()
				return ok(0)
			case 'deselect_star':
				guider.deselectStar()
				return ok(0)
			case 'find_star': {
				// The local guider has no search region of interest: `roi` is accepted and ignored.
				const position = guider.findStar()
				return position === undefined ? error(COMMAND_FAILED, 'could not find star') : ok(position)
			}
			case 'capture_single_frame': {
				const exposure = read(params, 0, 'exposure', isPositive, guider.getExposure())
				if (exposure === INVALID) return invalid('exposure')
				if (guider.getAppState() !== 'Stopped') return error(COMMAND_FAILED, 'cannot capture single frame when capture is currently active')
				// The subframe is accepted and ignored; the exposure also becomes the guider cadence.
				return refused(guider.startExposureLoop(exposure), 'camera not connected')
			}
			case 'guide': {
				const settle = read(params, 0, 'settle', isSettle, {})
				const recalibrate = read(params, 1, 'recalibrate', isBoolean, false)
				if (settle === INVALID || recalibrate === INVALID) return invalid('settle, recalibrate')
				// The local guider selects its star from the whole frame: `roi` is accepted and ignored.
				return refused(guider.guide(recalibrate, settle), 'cannot guide: equipment not connected or unable to pulse')
			}
			case 'dither': {
				const amount = read(params, 0, 'amount', isPositive)
				const raOnly = read(params, 1, 'raOnly', isBoolean, false)
				const settle = read(params, 2, 'settle', isSettle, {})
				if (amount === INVALID || raOnly === INVALID || settle === INVALID) return invalid('amount, raOnly, settle')
				return refused(guider.dither(amount, raOnly, settle), 'cannot dither when not guiding')
			}
			case 'guide_pulse': {
				const amount = read(params, 0, 'amount', isPositive)
				const direction = read(params, 1, 'direction', isString)
				const which = read(params, 2, 'which', isWhich, 'MOUNT')
				const guideDirection = direction === INVALID ? undefined : toGuideDirection(direction)
				if (amount === INVALID || guideDirection === undefined || which === INVALID || which === 'BOTH') return invalid('amount, direction, which')
				if (which === 'AO') return error(COMMAND_FAILED, 'AO not connected')
				return refused(guider.guidePulse(amount, guideDirection), 'guide pulse refused')
			}
			case 'get_star_image': {
				if (guider.getLockPosition() === undefined) return error(NO_STAR_SELECTED, 'no star selected')
				const image = guider.getStarImage()
				return image === undefined ? error(NO_STAR_SELECTED, 'no star image') : ok(encodeStarImage(image))
			}
			case 'shutdown':
				return [...this.#handlers].some((handler) => handler.shutdown !== undefined) ? ok(0) : error(COMMAND_FAILED, 'shutdown is not supported')
			default:
				return UNSUPPORTED_METHODS.has(method) ? error(COMMAND_FAILED, `${method} is not supported by this guider`) : error(METHOD_NOT_FOUND, `method not found: ${method}`)
		}
	}

	#profile() {
		return this.options.profile ?? DEFAULT_PHD2_SERVER_PROFILE
	}

	// Bound devices, or the configured ones (disconnected) before `set_connected(true)`.
	#equipment(): PHD2Equipment {
		const camera = this.guider.camera ?? this.options.devices?.camera
		const mount = this.guider.guideOutput ?? this.options.devices?.guideOutput
		const bound = this.guider.camera !== undefined

		return {
			camera: camera === undefined ? undefined : { name: camera.name, connected: bound && camera.connected },
			mount: mount === undefined ? undefined : { name: mount.name, connected: bound && mount.connected },
		}
	}

	// Binds the configured devices, or stops the capture and releases them.
	#setConnected(connected: boolean): PHD2ServerResponse {
		const { guider } = this

		if (connected) {
			if (guider.camera !== undefined) return ok(0)
			const devices = this.options.devices
			if (devices === undefined) return error(COMMAND_FAILED, 'no equipment configured')
			return refused(guider.connect(devices.camera, devices.guideOutput, devices.options), 'could not connect equipment')
		}

		guider.stopCapture()
		guider.disconnect()
		return ok(0)
	}

	// Writes one event to every socket, serialized once.
	#broadcast(message: object) {
		if (this.#connections.size === 0) return
		const data = encode(message)
		for (const connection of this.#connections.values()) this.#write(connection, data)
	}

	#send(connection: Connection, message: object) {
		this.#write(connection, encode(message))
	}

	// Writes as much as the socket accepts and queues the rest until `drain`, closing a socket whose queue
	// exceeds `maxPendingWrite`: Bun does not buffer the bytes a write could not take.
	#write(connection: Connection, data: Buffer) {
		if (!this.#connections.has(connection.socket)) return
		if (!connection.output.write(connection.socket, data)) this.#drop(connection, 'output queue full')
	}

	// Flushes the output queue of a socket that can take more bytes.
	#drain(socket: Socket<unknown>) {
		this.#connections.get(socket)?.output.drain(socket)
	}

	// Calls `notify` for every handler; a throw is logged under `kind` and does not skip the others.
	#notify(kind: keyof PHD2ServerHandler, notify: (handler: PHD2ServerHandler) => void) {
		for (const handler of this.#handlers) {
			try {
				notify(handler)
			} catch (e) {
				console.error(`PHD2 server ${kind} handler failed:`, e)
			}
		}
	}
}

// Builds a PHD2 event stamped now, in seconds since the Unix epoch.
function event<T extends keyof PHD2EventMap>(Event: T, data: Omit<PHD2EventMap[T], 'Event' | 'Timestamp' | 'Host' | 'Inst'>) {
	return { Event, Timestamp: Date.now() / 1000, Host: '', Inst: 1, ...data }
}

// Index of the first byte at or after `start` that is not JSON whitespace (space, tab, CR, LF).
function skipWhitespace(buffer: Buffer, start: number) {
	let i = start
	while (i < buffer.byteLength && (buffer[i] === 32 || buffer[i] === 9 || buffer[i] === 13 || buffer[i] === LF)) i++
	return i
}

// Serializes one message as a `\r\n`-terminated line.
function encode(message: object) {
	return Buffer.from(`${JSON.stringify(message)}\r\n`)
}

function ok(result: unknown): PHD2ServerResponse {
	return { result }
}

function error(code: number, message: string): PHD2ServerResponse {
	return { error: { code, message } }
}

function invalid(names: string) {
	return error(INVALID_PARAMS, `invalid params: ${names}`)
}

// PHD2 replies 0 for an accepted command.
function refused(accepted: boolean, message: string) {
	return accepted ? ok(0) : error(COMMAND_FAILED, message)
}

// A JSON-RPC error reply.
function failure(id: PHD2RequestId, code: number, message: string) {
	return { jsonrpc: '2.0', error: { code, message }, id }
}

// Reads the parameter at `index` of a positional list or named `name` of an object. A missing parameter yields
// `fallback`, or INVALID when it is required (no fallback); a present one must pass `guard`.
function read<T>(params: Params, index: number, name: string, guard: (value: unknown) => value is T, fallback?: T): T | typeof INVALID {
	const value = params === undefined ? undefined : Array.isArray(params) ? params[index] : (params as Readonly<Record<string, unknown>>)[name]
	if (value === undefined || value === null) return fallback ?? INVALID
	return guard(value) ? value : INVALID
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isRequestId(value: unknown): value is PHD2RequestId {
	return typeof value === 'string' || typeof value === 'number' || value === null
}

function isBoolean(value: unknown): value is boolean {
	return typeof value === 'boolean'
}

function isString(value: unknown): value is string {
	return typeof value === 'string'
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value)
}

function isInteger(value: unknown): value is number {
	return Number.isInteger(value)
}

function isPositive(value: unknown): value is number {
	return isFiniteNumber(value) && value > 0
}

function isWhich(value: unknown): value is 'MOUNT' | 'AO' | 'BOTH' {
	return typeof value === 'string' && (value.toUpperCase() === 'MOUNT' || value.toUpperCase() === 'AO' || value.toUpperCase() === 'BOTH')
}

function isDeclinationGuideMode(value: unknown): value is PHD2DeclinationGuideMode {
	return value === 'Off' || value === 'Auto' || value === 'North' || value === 'South'
}

function isShiftAxis(value: unknown): value is PHD2ShiftAxis {
	return value === 'RA/Dec' || value === 'X/Y'
}

function isRateUnit(value: unknown): value is PHD2RateUnit {
	return value === 'arcsec/hr' || value === 'pixels/hr'
}

function isRate(value: unknown): value is PHD2LockShiftParams['rate'] {
	return Array.isArray(value) && value.length === 2 && isFiniteNumber(value[0]) && isFiniteNumber(value[1])
}

// A settle object whose present fields are finite and not negative: pixels, time (s) and timeout (s).
function isSettle(value: unknown): value is Partial<PHD2Settle> {
	if (!isRecord(value)) return false
	const { pixels, time, timeout } = value
	return isSettleField(pixels) && isSettleField(time) && isSettleField(timeout)
}

function isSettleField(value: unknown) {
	return value === undefined || (isFiniteNumber(value) && value >= 0)
}

// Accepts PHD2's direction names and their initials, case-insensitively.
function toGuideDirection(value: string): PHD2GuideDirection | undefined {
	switch (value.toUpperCase()) {
		case 'N':
		case 'NORTH':
			return 'North'
		case 'S':
		case 'SOUTH':
			return 'South'
		case 'E':
		case 'EAST':
			return 'East'
		case 'W':
		case 'WEST':
			return 'West'
		default:
			return undefined
	}
}

// Encodes a guider star crop in PHD2's wire form: channels averaged to mono, normalized samples clamped to [0, 1]
// and scaled to unsigned 16-bit, row-major from the top-left, as base64 of little-endian bytes; `star_pos` is
// [x, y] in crop pixels.
function encodeStarImage(image: PHD2StarImage<ImageRawType>): PHD2StarImage<string> {
	const { frame, width, height, star_pos, pixels } = image
	const size = width * height
	const channels = size > 0 ? Math.max(1, Math.trunc(pixels.length / size)) : 1
	const mono = Buffer.alloc(size * 2)

	for (let i = 0, k = 0; i < size; i++) {
		let sum = 0
		for (let c = 0; c < channels; c++) sum += pixels[k++]
		const value = sum / channels
		mono.writeUInt16LE(Math.round(Math.max(0, Math.min(value, 1)) * 65535), i * 2)
	}

	return { frame, width, height, star_pos: [star_pos.x, star_pos.y], pixels: mono.toString('base64') }
}
