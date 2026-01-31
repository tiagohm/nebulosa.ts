import type { Mutable, Optional } from 'utility-types'
import type { Point, Size } from './geometry'

export const DEFAULT_PHD2_PORT = 4400

export type PHD2EventType =
	| 'Alert'
	| 'AppState'
	| 'Calibrating'
	| 'CalibrationComplete'
	| 'CalibrationDataFlipped'
	| 'CalibrationFailed'
	| 'ConfigurationChange'
	| 'GuideParamChange'
	| 'GuideStep'
	| 'GuidingDithered'
	| 'GuidingStopped'
	| 'LockPositionLost'
	| 'LockPositionSet'
	| 'LockPositionShiftLimitReached'
	| 'LoopingExposures'
	| 'LoopingExposuresStopped'
	| 'Paused'
	| 'Resumed'
	| 'SettleBegin'
	| 'SettleDone'
	| 'Settling'
	| 'StarLost'
	| 'StarSelected'
	| 'StartCalibration'
	| 'StartGuiding'
	| 'Version'

export type PHD2AppState = 'Stopped' | 'Selected' | 'Calibrating' | 'Guiding' | 'LostLock' | 'Paused' | 'Looping'

export type PHD2AlertType = 'Info' | 'Question' | 'Warning' | 'Error'

export type PHD2GuideDirection = 'North' | 'South' | 'West' | 'East'

export type PHD2WhichMount = 'MOUNT' | 'AO' | 'BOTH'

export type PHD2DeclinationGuideMode = 'Off' | 'Auto' | 'North' | 'South'

export type PHD2RateUnit = 'arcsec/hr' | 'pixels/hr'

export type PHD2ShiftAxis = 'RA/Dec' | 'X/Y'

export type PHD2GuideAxis = 'RA' | 'DEC'

export type PHD2ConfigurationChangeEvent = PHD2Event<'ConfigurationChange'>

export type PHD2GuidingStoppedEvent = PHD2Event<'GuidingStopped'>

export type PHD2LockPositionLostEvent = PHD2Event<'LockPositionLost'>

export type PHD2LockPositionShiftLimitReachedEvent = PHD2Event<'LockPositionShiftLimitReached'>

export type PHD2LoopingExposuresStoppedEvent = PHD2Event<'LoopingExposuresStopped'>

export type PHD2PausedEvent = PHD2Event<'Paused'>

export type PHD2ResumedEvent = PHD2Event<'Resumed'>

export type PHD2SettleBeginEvent = PHD2Event<'SettleBegin'>

export type PHD2StartGuidingEvent = PHD2Event<'StartGuiding'>

export type PHD2CommandResult<T> = { success: false; error: PHD2Error | 'timeout'; result?: never } | { success: true; result: T }

export interface PHD2Event<E extends PHD2EventType> {
	readonly Event: E
	readonly Timestamp: number
	readonly Host: string
	readonly Inst: number
}

export interface PHD2VersionEvent extends PHD2Event<'Version'> {
	readonly PHD2Version: string
	readonly PHD2Subver: string
	readonly OverlapSupport: boolean
	readonly MsgVersion: number
}

export interface PHD2AlertEvent extends PHD2Event<'Alert'> {
	readonly Msg: string
	readonly Type: PHD2AlertType
}

export interface PHD2AppStateEvent extends PHD2Event<'AppState'> {
	readonly State: PHD2AppState
}

export interface PHD2CalibratingEvent extends PHD2Event<'Calibrating'> {
	readonly Mount: string
	readonly dir: string
	readonly dist: number
	readonly dx: number
	readonly dy: number
	readonly pos: unknown
	readonly step: number
	readonly State: string
}

export interface PHD2CalibrationCompleteEvent extends PHD2Event<'CalibrationComplete'> {
	readonly Mount: string
}

export interface PHD2CalibrationDataFlippedEvent extends PHD2Event<'CalibrationDataFlipped'> {
	readonly Mount: string
}

export interface PHD2CalibrationFailedEvent extends PHD2Event<'CalibrationFailed'> {
	readonly Reason: string
}

export interface PHD2GuideParamChangeEvent extends PHD2Event<'GuideParamChange'> {
	readonly Name: string
	readonly Value?: unknown
}

export interface PHD2GuideStepEvent extends PHD2Event<'GuideStep'> {
	readonly Frame: number
	readonly Time: number
	readonly Mount: string
	readonly dx: number
	readonly dy: number
	readonly RADistanceRaw: number
	readonly DECDistanceRaw: number
	readonly RADuration: number
	readonly RADirection: PHD2GuideDirection
	readonly DECDuration: number
	readonly DECDirection: PHD2GuideDirection
	readonly StarMass: number
	readonly SNR: number
	readonly HFD: number
	readonly AvgDist: number
	readonly RALimited: boolean
	readonly DecLimited: boolean
	readonly ErrorCode: number
}

export interface PHD2GuidingDitheredEvent extends PHD2Event<'GuidingDithered'> {
	readonly dx: number
	readonly dy: number
}

export interface PHD2LockPositionSetEvent extends PHD2Event<'LockPositionSet'> {
	readonly X: number
	readonly Y: number
}

export interface PHD2LoopingExposuresEvent extends PHD2Event<'LoopingExposures'> {
	readonly Frame: number
    readonly StarMass: number
	readonly SNR: number
	readonly HFD: number
}

export interface PHD2SettleDoneEvent extends PHD2Event<'SettleDone'> {
	readonly Status: number
	readonly TotalFrames: number
	readonly DroppedFrames: number
	readonly Error?: string
}

export interface PHD2SettlingEvent extends PHD2Event<'Settling'> {
	readonly Distance: number
	readonly Time: number
	readonly SettleTime: number
	readonly StarLocked: boolean
}

export interface PHD2StarLostEvent extends PHD2Event<'StarLost'> {
	readonly Frame: number
	readonly Time: number
	readonly StarMass: number
	readonly SNR: number
	readonly AvgDist: number
	readonly ErrorCode: number
	readonly Status: string
}

export interface PHD2StarSelectedEvent extends PHD2Event<'StarSelected'> {
	readonly X: number
	readonly Y: number
}

export interface PHD2StartCalibrationEvent extends PHD2Event<'StartCalibration'> {
	readonly Mount: string
}

export interface PHD2Error {
	readonly code: number
	readonly message: string
}

export interface PHD2JsonRpcEvent {
	readonly jsonrpc: string
	readonly id: string
	readonly result: unknown
	readonly error?: PHD2Error
}

export type PHD2Events =
	| PHD2AlertEvent
	| PHD2AppStateEvent
	| PHD2CalibratingEvent
	| PHD2CalibrationCompleteEvent
	| PHD2CalibrationDataFlippedEvent
	| PHD2CalibrationFailedEvent
	| PHD2ConfigurationChangeEvent
	| PHD2GuideParamChangeEvent
	| PHD2GuideStepEvent
	| PHD2GuidingDitheredEvent
	| PHD2GuidingStoppedEvent
	| PHD2LockPositionLostEvent
	| PHD2LockPositionSetEvent
	| PHD2LockPositionShiftLimitReachedEvent
	| PHD2LoopingExposuresEvent
	| PHD2LoopingExposuresStoppedEvent
	| PHD2PausedEvent
	| PHD2ResumedEvent
	| PHD2SettleBeginEvent
	| PHD2SettleDoneEvent
	| PHD2SettlingEvent
	| PHD2StarLostEvent
	| PHD2StarSelectedEvent
	| PHD2StartCalibrationEvent
	| PHD2StartGuidingEvent
	| PHD2VersionEvent

export interface PHD2Command {
	readonly id: string
	readonly method: string
	readonly params?: Readonly<Record<string, unknown> | unknown[]>
}

export interface PHD2Device {
	readonly name: string
	readonly connected: boolean
}

export interface PHD2Equipment {
	readonly camera?: PHD2Device
	readonly mount?: PHD2Device
	readonly aux_mount?: PHD2Device
	readonly AO?: PHD2Device
	readonly rotator?: PHD2Device
}

export interface PHD2Settle {
	pixels: number
	time: number
	timeout: number
}

export interface PHD2CalibrationData {
	readonly calibrated: boolean
	readonly xAngle: number
	readonly xRate: number
	readonly xParity: '+' | '-'
	readonly yAngle: number
	readonly yRate: number
	readonly yParity: '+' | '-'
}

export interface PHD2LockShiftParams {
	readonly enabled: boolean
	readonly rate: readonly [number, number]
	readonly units: PHD2RateUnit
	readonly axes: PHD2ShiftAxis
}

export interface PHD2Profile {
	readonly id: number
	readonly name: string
	readonly selected: boolean
}

export interface PHD2StarImage extends Readonly<Size> {
	readonly frame: number
	readonly star_pos: Readonly<Point>
	readonly pixels: string
}

export interface PHD2ClientOptions {
	handler?: PHD2ClientHandler
}

export interface PHD2ClientHandler {
	readonly event?: (client: PHD2Client, event: PHD2Events) => void
	readonly command?: (client: PHD2Client, command: PHD2Command, success: boolean, result: PHD2Error | unknown) => void
	readonly close?: (client: PHD2Client, error?: Error) => void
}

export const DEFAULT_ROI: Readonly<Point & Size> = {
	x: 0,
	y: 0,
	width: 0,
	height: 0,
}

export const DEFAULT_SETTLE: Readonly<PHD2Settle> = {
	pixels: 1.5, // px
	time: 10, // s
	timeout: 30, // s
}

export class PHD2Client implements Disposable {
	// biome-ignore lint/suspicious/noExplicitAny: any
	private readonly commands = new Map<string, { promise: PromiseWithResolvers<PHD2CommandResult<any>>; timer: any; command: PHD2Command }>()
	private socket?: Bun.Socket
	private buffer?: Buffer<ArrayBufferLike>

	constructor(private readonly options?: PHD2ClientOptions) {}

	async connect(hostname: string, port: number = DEFAULT_PHD2_PORT) {
		if (this.socket) return false

		this.socket = await Bun.connect({
			hostname,
			port,
			socket: {
				data: (_, data) => {
					this.process(data)
				},
				error: (_, error) => {
					console.error('socket error:', error)
				},
				connectError: (_, error) => {
					console.error('connection failed:', error)
				},
				close: (_, error) => {
					console.info('connection closed:', error?.message)
					this.options?.handler?.close?.(this, error)
					this.socket = undefined
				},
			},
		})

		return true
	}

	close() {
		this.socket?.close()
		this.socket = undefined
	}

	[Symbol.dispose]() {
		this.close()
	}

	async send<T>(method: string, params?: Record<string, unknown> | unknown[], timeout: number = 15000) {
		if (!this.socket) return undefined

		const id = Bun.randomUUIDv7()
		const command: PHD2Command = { method, params, id }

		const promise = Promise.withResolvers<PHD2CommandResult<T>>()
		const timer = setTimeout(() => promise.resolve({ success: false, error: 'timeout' }), timeout <= 0 ? 15000 : timeout)
		this.commands.set(id, { promise, timer, command })

		this.socket.write(Buffer.from(JSON.stringify(command)))
		this.socket.write('\r\n')

		const result = await promise.promise

		if (result.success) return result.result
		else if (result.error === 'timeout') console.error(method, 'command timed out after', timeout, 'ms')
		else console.error(method, 'command failed:', result.error.code, result.error.message)

		return undefined
	}

	findStar(roi: Partial<Point & Size> = DEFAULT_ROI) {
		const { x, y, width, height } = Object.assign({}, DEFAULT_ROI, roi)
		const subframe = width && height ? [x, y, width, height] : undefined
		return this.send<readonly [number, number]>('find_star', subframe)
	}

	startCapture(exposure: number, roi: Partial<Point & Size> = DEFAULT_ROI) {
		const { x, y, width, height } = Object.assign({}, DEFAULT_ROI, roi)
		const subframe = width && height ? [x, y, width, height] : undefined
		return this.send<number>('capture_single_frame', { exposure, subframe })
	}

	stopCapture() {
		return this.send<number>('stop_capture')
	}

	clearCalibration(which: PHD2WhichMount) {
		return this.send<number>('clear_calibration', [which])
	}

	deselectStar() {
		return this.send<number>('deselect_star')
	}

	dither(amount: number, raOnly: boolean = false, settle: Partial<PHD2Settle> = DEFAULT_SETTLE) {
		settle = Object.assign({}, DEFAULT_SETTLE, settle)
		return this.send<number>('shutdown', { amount, raOnly, settle })
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

	getCalibrationData(which: PHD2WhichMount) {
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
		return this.send<PHD2StarImage>('get_star_image')
	}

	getUseSubframes() {
		return this.send<boolean>('get_use_subframes')
	}

	guide(recalibrate: boolean = false, roi: Point & Size = DEFAULT_ROI, settle: PHD2Settle = DEFAULT_SETTLE) {
		settle = Object.assign({}, DEFAULT_SETTLE, settle)
		const { x, y, width, height } = Object.assign({}, DEFAULT_ROI, roi)
		const subframe = width && height ? [x, y, width, height] : undefined
		return this.send<number>('guide', { recalibrate, roi: subframe, settle })
	}

	guidePulse(amount: number, direction: PHD2GuideDirection, which: PHD2WhichMount) {
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

	setConnected(connected: number) {
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

	setLockShiftParams(params: Optional<Omit<Mutable<PHD2LockShiftParams>, 'enabled'>, 'units'>) {
		params.units ||= params.axes === 'RA/Dec' ? 'arcsec/hr' : 'pixels/hr'
		return this.send<number>('set_lock_shift_params', params)
	}

	setPaused(paused: boolean, full: boolean = true) {
		return this.send<number>('set_paused', [paused, full ? 'full' : null])
	}

	setProfile(profile: number | PHD2Profile) {
		const id = typeof profile === 'number' ? profile : profile.id
		return this.send<number>('set_profile', [id])
	}

	shutdown() {
		return this.send<number>('shutdown')
	}

	private process(data: Buffer) {
		const buffer = this.buffer === undefined ? data : Buffer.concat([this.buffer, data])

		const result = Bun.JSONL.parseChunk(buffer)

		for (const event of result.values) {
			this.processEvent(event as never)
		}

		if (result.done) {
			this.buffer = undefined
		} else {
			// Keep only the unconsumed portion
			this.buffer = buffer.subarray(result.read)
		}
	}

	private processEvent(event: PHD2Events | PHD2JsonRpcEvent) {
		if ('jsonrpc' in event) {
			const { id, error, result } = event
			const command = this.commands.get(id)

			if (command) {
				clearTimeout(command.timer)
				this.commands.delete(id)

				if (error) {
					command.promise.resolve({ success: false, error })
					this.options?.handler?.command?.(this, command.command, false, error)
				} else {
					command.promise.resolve({ success: true, result })
					this.options?.handler?.command?.(this, command.command, true, result)
				}
			}
		} else {
			this.options?.handler?.event?.(this, event)
		}
	}
}
