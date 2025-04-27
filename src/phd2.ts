import type { Socket } from 'bun'

export const DEFAULT_PHD2_PORT = 4400

export type Phd2EventType =
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

export type AppState = 'Stopped' | 'Selected' | 'Calibrating' | 'Guiding' | 'LostLock' | 'Paused' | 'Looping'

export type AlertType = 'INFO' | 'QUESTION' | 'WARNING' | 'ERROR'

export type GuideDirection = 'NORTH' | 'SOUTH' | 'WEST' | 'EAST'

export type WhichMount = 'MOUNT' | 'AO' | 'BOTH'

export type Phd2ConfigurationChangeEvent = Phd2Event<'ConfigurationChange'>

export type Phd2GuidingStoppedEvent = Phd2Event<'GuidingStopped'>

export type Phd2LockPositionLostEvent = Phd2Event<'LockPositionLost'>

export type Phd2LockPositionShiftLimitReachedEvent = Phd2Event<'LockPositionShiftLimitReached'>

export type Phd2LoopingExposuresStoppedEvent = Phd2Event<'LoopingExposuresStopped'>

export type Phd2PausedEvent = Phd2Event<'Paused'>

export type Phd2ResumedEvent = Phd2Event<'Resumed'>

export type Phd2SettleBeginEvent = Phd2Event<'SettleBegin'>

export type Phd2StartGuidingEvent = Phd2Event<'StartGuiding'>

export type Phd2CommandResult<T> = { success: false; error: Phd2Error | 'timeout' } | { success: true; result: T }

export interface Phd2Event<E extends Phd2EventType> {
	readonly Event: E
	readonly Timestamp: number
	readonly Host: string
	readonly Inst: number
}

export interface Phd2VersionEvent extends Phd2Event<'Version'> {
	readonly PHD2Version: string
	readonly PHD2Subver: string
	readonly OverlapSupport: boolean
	readonly MsgVersion: number
}

export interface Phd2AlertEvent extends Phd2Event<'Alert'> {
	readonly Msg: string
	readonly Type: AlertType
}

export interface Phd2AppStateEvent extends Phd2Event<'AppState'> {
	readonly State: AppState
}

export interface Phd2CalibratingEvent extends Phd2Event<'Calibrating'> {
	readonly Mount: string
	readonly dir: string
	readonly dist: number
	readonly dx: number
	readonly dy: number
	readonly pos: unknown
	readonly step: number
	readonly State: string
}

export interface Phd2CalibrationCompleteEvent extends Phd2Event<'CalibrationComplete'> {
	readonly Mount: string
}

export interface Phd2CalibrationDataFlippedEvent extends Phd2Event<'CalibrationDataFlipped'> {
	readonly Mount: string
}

export interface Phd2CalibrationFailedEvent extends Phd2Event<'CalibrationFailed'> {
	readonly Reason: string
}

export interface Phd2GuideParamChangeEvent extends Phd2Event<'GuideParamChange'> {
	readonly Name: string
	readonly Value?: unknown
}

export interface Phd2GuideStepEvent extends Phd2Event<'GuideStep'> {
	readonly Frame: number
	readonly Time: number
	readonly Mount: string
	readonly dx: number
	readonly dy: number
	readonly RADistanceRaw: number
	readonly DECDistanceRaw: number
	readonly RADuration: number
	readonly RADirection: GuideDirection
	readonly DECDuration: number
	readonly DECDirection: GuideDirection
	readonly StarMass: number
	readonly SNR: number
	readonly HFD: number
	readonly AvgDist: number
	readonly RALimited: boolean
	readonly DecLimited: boolean
	readonly ErrorCode: number
}

export interface Phd2GuidingDitheredEvent extends Phd2Event<'GuidingDithered'> {
	readonly dx: number
	readonly dy: number
}

export interface Phd2LockPositionSetEvent extends Phd2Event<'LockPositionSet'> {
	readonly X: number
	readonly Y: number
}

export interface Phd2LoopingExposuresEvent extends Phd2Event<'LoopingExposures'> {
	readonly Frame: number
}

export interface Phd2SettleDoneEvent extends Phd2Event<'SettleDone'> {
	readonly Status: number
	readonly TotalFrames: number
	readonly DroppedFrames: number
	readonly Error?: string
}

export interface Phd2SettlingEvent extends Phd2Event<'Settling'> {
	readonly Distance: number
	readonly Time: number
	readonly SettleTime: number
	readonly StarLocked: boolean
}

export interface Phd2StarLostEvent extends Phd2Event<'StarLost'> {
	readonly Frame: number
	readonly Time: number
	readonly StarMass: number
	readonly SNR: number
	readonly AvgDist: number
	readonly ErrorCode: number
	readonly Status: string
}

export interface Phd2StarSelectedEvent extends Phd2Event<'StarSelected'> {
	readonly X: number
	readonly Y: number
}

export interface Phd2StartCalibrationEvent extends Phd2Event<'StartCalibration'> {
	readonly Mount: string
}

export interface Phd2Error {
	readonly code: number
	readonly message: string
}

export interface Phd2JsonRpcEvent {
	readonly jsonrpc: string
	readonly id: string
	readonly result: unknown
	readonly error?: Phd2Error
}

export type Phd2Events =
	| Phd2AlertEvent
	| Phd2AppStateEvent
	| Phd2CalibratingEvent
	| Phd2CalibrationCompleteEvent
	| Phd2CalibrationDataFlippedEvent
	| Phd2CalibrationFailedEvent
	| Phd2ConfigurationChangeEvent
	| Phd2GuideParamChangeEvent
	| Phd2GuideStepEvent
	| Phd2GuidingDitheredEvent
	| Phd2GuidingStoppedEvent
	| Phd2LockPositionLostEvent
	| Phd2LockPositionSetEvent
	| Phd2LockPositionShiftLimitReachedEvent
	| Phd2LoopingExposuresEvent
	| Phd2LoopingExposuresStoppedEvent
	| Phd2PausedEvent
	| Phd2ResumedEvent
	| Phd2SettleBeginEvent
	| Phd2SettleDoneEvent
	| Phd2SettlingEvent
	| Phd2StarLostEvent
	| Phd2StarSelectedEvent
	| Phd2StartCalibrationEvent
	| Phd2StartGuidingEvent
	| Phd2VersionEvent
	| Phd2JsonRpcEvent

export interface Phd2Command {
	readonly id: string
	readonly method: string
	readonly params?: Record<string, unknown> | unknown[]
}

export interface Phd2Device {
	readonly name: string
	readonly connected: boolean
}

export interface Phd2Equipment {
	readonly camera: Phd2Device
	readonly mount: Phd2Device
	readonly aux_mount: Phd2Device
	readonly AO: Phd2Device
	readonly rotator: Phd2Device
}

export interface Phd2ClientOptions {
	handler?: Phd2ClientHandler
}

export interface Phd2ClientHandler {
	event?: (client: Phd2Client, event: Exclude<Phd2Events, Phd2JsonRpcEvent>) => void
	command?: (client: Phd2Client, command: Phd2Command, success: boolean, result: Phd2Error | unknown) => void
}

const CLRF = Buffer.from([13, 10])

export class Phd2Client {
	// biome-ignore lint/suspicious/noExplicitAny:
	private readonly commands = new Map<string, { promise: PromiseWithResolvers<Phd2CommandResult<any>>; timer: any; command: Phd2Command }>()
	private socket?: Socket

	constructor(private readonly options?: Phd2ClientOptions) {}

	async connect(hostname: string, port: number = DEFAULT_PHD2_PORT) {
		if (this.socket) return

		this.socket = await Bun.connect({
			hostname,
			port,
			socket: {
				data: (_, data) => {
					if (this.options?.handler) {
						this.process(data)
					}
				},
				error: (_, error) => {
					console.error(error)
				},
			},
		})
	}

	close() {
		this.socket?.terminate()
		this.socket = undefined
	}

	send<T>(method: string, params?: Record<string, unknown> | unknown[], timeout: number = 15000) {
		if (!this.socket) return undefined

		const id = Bun.randomUUIDv7()
		const command: Phd2Command = { method, params, id }
		let promise: PromiseWithResolvers<Phd2CommandResult<T>> | undefined

		if (timeout) {
			promise = Promise.withResolvers()
			const timer = setTimeout(() => promise!.resolve({ success: false, error: 'timeout' }), timeout)
			this.commands.set(id, { promise, timer, command })
		}

		this.socket.write(Buffer.from(JSON.stringify(command)))
		this.socket.write(CLRF)

		return promise?.promise
	}

	findStar(x: number = 0, y: number = 0, width: number = 0, height: number = 0) {
		const subframe = x !== undefined && y !== undefined && width && height ? [x, y, width, height] : undefined
		return this.send<[number, number]>('find_star', subframe)
	}

	startCapture(exposure: number, x: number = 0, y: number = 0, width: number = 0, height: number = 0) {
		const subframe = x !== undefined && y !== undefined && width && height ? [x, y, width, height] : undefined
		return this.send<number>('capture_single_frame', { exposure, subframe })
	}

	stopCapture() {
		return this.send<number>('stop_capture')
	}

	clearCalibration(which: WhichMount) {
		return this.send<number>('clear_calibration', [which])
	}

	deselectStar() {
		return this.send<number>('deselect_star')
	}

	shutdown() {
		return this.send<number>('shutdown')
	}

	private process(data: Buffer) {
		let offset = 0

		while (offset < data.byteLength) {
			const index = data.indexOf(10, offset)

			if (index >= 0) {
				this.processEvent(data.toString('utf-8', offset, index))
				offset = index + 1
			} else {
				console.warn('incomplete buffer data')
				break
			}
		}
	}

	private processEvent(data: string) {
		const event = JSON.parse(data) as Phd2Events

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
			this.options!.handler!.event?.(this, event)
		}
	}
}
