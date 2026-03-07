import { type Distance, fromPressure } from './distance'
import type { NumberArray } from './math'
import { type Pressure, pascal } from './pressure'
import type { Temperature } from './temperature'

// https://github.com/firmata/protocol/blob/master/protocol.md

export type AnalogMapping = Record<number, number>

export type TwoWireAutoRestartMode = 'stop' | 'restart'

export type TwoWireAddressMode = 7 | 10

export type TwoWireOperationMode = 'write' | 'read' | 'readContinuously' | 'stop'

export type HardwareListener<D extends Hardware<D>> = (device: D) => void

export interface Transport {
	readonly write: (data: string | Bun.BufferSource, byteOffset?: number, byteLength?: number) => void
	readonly flush: () => void
	readonly close: () => void
}

export interface Board {
	readonly name: string
	readonly isPinLED: (pin: number) => boolean
	readonly isPinDigital: (pin: number) => boolean
	readonly isPinAnalog: (pin: number) => boolean
	readonly isPinPWM: (pin: number) => boolean
	readonly isPinServo: (pin: number) => boolean
	readonly isPinTwoWire: (pin: number) => boolean
	readonly isPinSPI: (pin: number) => boolean
	readonly isPinSerial: (pin: number) => boolean
	readonly pinToDigital: (pin: number) => number
	readonly pinToAnalog: (pin: number) => number
	readonly pinToPWM: (pin: number) => number
	readonly pinToServo: (pin: number) => number
}

export interface Pin {
	readonly id: number
	readonly modes: Set<PinMode>
	mode: PinMode
	value: number
}

export interface Hardware<D extends Hardware<D>> extends Disposable {
	readonly client: FirmataClient
	readonly addListener: (listener: HardwareListener<D>) => void
	readonly removeListener: (listener: HardwareListener<D>) => void
	readonly start: () => void
	readonly stop: () => void
}

export interface Thermometer {
	readonly temperature: Temperature
}

export interface Hygrometer {
	readonly humidity: number
}

export interface Barometer {
	readonly pressure: Pressure
}

export interface Altimeter {
	readonly altitude: Distance
}

export interface FirmataClientHandler {
	readonly ready?: (client: FirmataClient) => void
	readonly pinChange?: (client: FirmataClient, pin: Pin) => void

	readonly customMessage?: (client: FirmataClient, data: Buffer) => void
	readonly version?: (client: FirmataClient, major: number, minor: number) => void
	readonly firmwareMessage?: (client: FirmataClient, major: number, minor: number, name: string) => void
	readonly systemReset?: (client: FirmataClient) => void
	readonly error?: (client: FirmataClient, command: number) => void
	readonly digitalMessage?: (client: FirmataClient, id: number, value: number) => void
	readonly analogMessage?: (client: FirmataClient, port: number, value: number) => void
	readonly pinCapability?: (client: FirmataClient, id: number, modes: Set<PinMode>) => void
	readonly pinCapabilitiesFinished?: (client: FirmataClient) => void
	readonly analogMapping?: (client: FirmataClient, mapping: AnalogMapping) => void
	readonly pinState?: (client: FirmataClient, id: number, mode: PinMode, value: number) => void
	readonly textMessage?: (client: FirmataClient, message: string) => void
	readonly twoWireMessage?: (client: FirmataClient, address: number, register: number, data: Buffer) => void
}

export interface FirmataFsmState {
	readonly process: (byte: number, fsm: FirmataFsm) => void
}

export enum PinMode {
	INPUT,
	OUTPUT,
	ANALOG,
	PWM,
	SERVO,
	SHIFT,
	I2C,
	ONE_WIRE,
	STEPPER,
	ENCODER,
	SERIAL,
	PULL_UP,
	// Extended modes
	SPI,
	SONAR,
	TONE,
	DHT,
	UNSUPPORTED = 126,
	IGNORED = 127,
}

export enum BMP180Mode {
	ULTRA_LOW_POWER, // 5 ms
	STANDARD, // 8 ms
	HIGH_RESOLUTION, // 14 ms
	ULTRA_HIGH_RESOLUTION, // 26 ms
}

// PROTOCOL

function resolvePinMode(mode: number) {
	if (mode === PIN_MODE_IGNORE) return PinMode.IGNORED
	else if (mode >= TOTAL_PIN_MODES) return PinMode.UNSUPPORTED
	else return mode as PinMode
}

export class FirmataParser {
	constructor(private readonly fsm: FirmataFsm) {}

	process(data: Buffer) {
		for (let i = 0; i < data.byteLength; i++) {
			this.processByte(data[i])
		}
	}

	processByte(b: number) {
		this.fsm.process(b)
	}
}

// Message command bytes (128-255/0x80-0xFF).
const DIGITAL_MESSAGE = 0x90
const ANALOG_MESSAGE = 0xe0
const REPORT_ANALOG = 0xc0
const REPORT_DIGITAL = 0xd0
const SET_PIN_MODE = 0xf4
const SET_DIGITAL_PIN_VALUE = 0xf5
const REPORT_VERSION = 0xf9
const SYSTEM_RESET = 0xff
const START_SYSEX = 0xf0
const END_SYSEX = 0xf7

// Extended command set using sysex (0-127/0x00-0x7F)
// 0x00-0x0F reserved for user-defined commands
const RESERVED_COMMAND = 0x00
const SERIAL_MESSAGE = 0x60
const ENCODER_DATA = 0x61
const SERVO_CONFIG = 0x70
const STRING_DATA = 0x71
const STEPPER_DATA = 0x72
const ONE_WIRE_DATA = 0x73
const SHIFT_DATA = 0x75
const TWO_WIRE_REQUEST = 0x76
const TWO_WIRE_REPLY = 0x77
const TWO_WIRE_CONFIG = 0x78
const EXTENDED_ANALOG = 0x6f
const PIN_STATE_QUERY = 0x6d
const PIN_STATE_RESPONSE = 0x6e
const CAPABILITY_QUERY = 0x6b
const CAPABILITY_RESPONSE = 0x6c
const ANALOG_MAPPING_QUERY = 0x69
const ANALOG_MAPPING_RESPONSE = 0x6a
const REPORT_FIRMWARE = 0x79
const SAMPLING_INTERVAL = 0x7a
const SCHEDULER_DATA = 0x7b
const SYSEX_NON_REALTIME = 0x7e
const SYSEX_REALTIME = 0x7f

// Pin modes.
const PIN_MODE_INPUT = 0x00
const PIN_MODE_OUTPUT = 0x01
const PIN_MODE_ANALOG = 0x02
const PIN_MODE_PWM = 0x03
const PIN_MODE_SERVO = 0x04
const PIN_MODE_SHIFT = 0x05
const PIN_MODE_TWO_WIRE = 0x06
const PIN_MODE_ONEWIRE = 0x07
const PIN_MODE_STEPPER = 0x08
const PIN_MODE_ENCODER = 0x09
const PIN_MODE_SERIAL = 0x0a
const PIN_MODE_PULLUP = 0x0b
const PIN_MODE_IGNORE = 0x7f
const TOTAL_PIN_MODES = 16

const TWO_WIRE_WRITE = 0x00
const TWO_WIRE_READ = 0x08
const TWO_WIRE_READ_CONTINUOUS = 0x10
const TWO_WIRE_STOP_READ = 0x18

const MIN_SAMPLING_INTERVAL = 1
const MAX_SAMPLING_INTERVAL = 4294967295

export function decodeByteAs7Bit(input: Readonly<NumberArray> | Buffer, offset: number) {
	return (input[offset] & 0x7f) | ((input[offset + 1] & 0x01) << 7)
}

export function encodeByteAs7Bit(data: number, output: NumberArray | Buffer, offset: number = 0) {
	output[offset++] = data & 0x7f
	output[offset] = (data >>> 7) & 1
}

class ParsingVersionMessageState implements FirmataFsmState {
	process(b: number, fsm: FirmataFsm) {
		if (fsm.offset === 0) {
			fsm.write(b)
		} else {
			fsm.version(fsm.read(0), b)
			fsm.transitTo(WAITING_FOR_MESSAGE_STATE)
		}
	}
}

const PARSING_VERSION_MESSAGE_STATE = new ParsingVersionMessageState()

class ParsingCustomSysexMessageState implements FirmataFsmState {
	process(b: number, fsm: FirmataFsm) {
		if (b === END_SYSEX) {
			fsm.customMessage(fsm.buffer)
			fsm.transitTo(WAITING_FOR_MESSAGE_STATE)
		} else {
			fsm.write(b)
		}
	}
}

const PARSING_CUSTOM_SYSEX_MESSAGE_STATE = new ParsingCustomSysexMessageState()

class ParsingFirmwareMessageState implements FirmataFsmState {
	process(b: number, fsm: FirmataFsm) {
		if (b === END_SYSEX) {
			fsm.firmwareMessage(fsm.read(0), fsm.read(1), fsm.readText(2))
			fsm.transitTo(WAITING_FOR_MESSAGE_STATE)
		} else {
			fsm.write(b)
		}
	}
}

const PARSING_FIRMWARE_MESSAGE_STATE = new ParsingFirmwareMessageState()

class ParsingExtendedAnalogMessageState implements FirmataFsmState {
	process(b: number, fsm: FirmataFsm) {
		if (b === END_SYSEX) {
			const portId = fsm.read(0)
			let value = fsm.read(1)

			for (let i = 2; i < fsm.offset; i++) {
				value = value | (fsm.read(i) << (7 * (i - 1)))
			}

			fsm.analogMessage(portId, value)
			fsm.transitTo(WAITING_FOR_MESSAGE_STATE)
		} else {
			fsm.write(b)
		}
	}
}

const PARSING_EXTENDED_ANALOG_MESSAGE_STATE = new ParsingExtendedAnalogMessageState()

class ParsingCapabilityResponseState implements FirmataFsmState {
	process(b: number, fsm: FirmataFsm) {
		if (b === END_SYSEX) {
			fsm.pinCapabilitiesFinished()
			fsm.transitTo(WAITING_FOR_MESSAGE_STATE)
		} else if (b === 127) {
			const pin = fsm.read(0)

			const modes = new Set<PinMode>()

			for (let i = 1; i < fsm.offset; i += 2) {
				// Every second byte contains mode's resolution of pin.
				modes.add(resolvePinMode(fsm.read(i)))
			}

			fsm.pinCapability(pin, modes)
			fsm.transitTo(this)
			fsm.write(pin + 1) // next pin at byte 0
		} else {
			if (fsm.offset === 0) fsm.write(0) // first pin is 0
			fsm.write(b)
		}
	}
}

const PARSING_CAPABILITY_RESPONSE_STATE = new ParsingCapabilityResponseState()

class ParsingAnalogMappingState implements FirmataFsmState {
	process(b: number, fsm: FirmataFsm) {
		if (b === END_SYSEX) {
			const mapping: AnalogMapping = {}

			for (let i = 0; i < fsm.offset; i++) {
				const m = fsm.read(i)
				if (m !== 127) mapping[m] = i
			}

			fsm.analogMapping(mapping)
			return fsm.transitTo(WAITING_FOR_MESSAGE_STATE)
		}

		// If pin does support analog, corresponding analog id is in the byte.
		fsm.write(b)
	}
}

const PARSING_ANALOG_MAPPING_STATE = new ParsingAnalogMappingState()

class PinStateParsingState implements FirmataFsmState {
	process(b: number, fsm: FirmataFsm) {
		if (b === END_SYSEX) {
			let value = 0

			for (let i = 2; i < fsm.offset; i++) {
				value = value | (fsm.read(i) << ((i - 2) * 7))
			}

			fsm.pinState(fsm.read(0), resolvePinMode(fsm.read(1)), value)
			fsm.transitTo(WAITING_FOR_MESSAGE_STATE)
		} else {
			fsm.write(b)
		}
	}
}

const PIN_STATE_PARSING_STATE = new PinStateParsingState()

class ParsingStringMessageState implements FirmataFsmState {
	process(b: number, fsm: FirmataFsm) {
		if (b === END_SYSEX) {
			fsm.textMessage(fsm.readText())
			fsm.transitTo(WAITING_FOR_MESSAGE_STATE)
		} else {
			fsm.write(b)
		}
	}
}

const PARSING_STRING_MESSAGE_STATE = new ParsingStringMessageState()

class ParsingTwoWireMessageState implements FirmataFsmState {
	process(b: number, fsm: FirmataFsm) {
		if (b === END_SYSEX) {
			const address = fsm.read7Bit(0)
			const register = fsm.read7Bit(2)
			const size = (fsm.offset - 4) >>> 1
			const data = Buffer.allocUnsafe(size)
			for (let i = 0; i < size; i++) data[i] = fsm.read7Bit(i * 2 + 4)
			fsm.twoWireMessage(address, register, data)
			fsm.transitTo(WAITING_FOR_MESSAGE_STATE)
		} else {
			fsm.write(b)
		}
	}
}

const PARSING_TWO_WIRE_MESSAGE_STATE = new ParsingTwoWireMessageState()

class ParsingSysexMessageState implements FirmataFsmState {
	process(b: number, fsm: FirmataFsm) {
		let next: FirmataFsmState | undefined

		if (b === REPORT_FIRMWARE) next = PARSING_FIRMWARE_MESSAGE_STATE
		else if (b === EXTENDED_ANALOG) next = PARSING_EXTENDED_ANALOG_MESSAGE_STATE
		else if (b === CAPABILITY_RESPONSE) next = PARSING_CAPABILITY_RESPONSE_STATE
		else if (b === ANALOG_MAPPING_RESPONSE) next = PARSING_ANALOG_MAPPING_STATE
		else if (b === PIN_STATE_RESPONSE) next = PIN_STATE_PARSING_STATE
		else if (b === STRING_DATA) next = PARSING_STRING_MESSAGE_STATE
		else if (b === TWO_WIRE_REPLY) next = PARSING_TWO_WIRE_MESSAGE_STATE

		if (!next) {
			const state = PARSING_CUSTOM_SYSEX_MESSAGE_STATE
			fsm.transitTo(state)
			state.process(b, fsm)
		} else {
			fsm.transitTo(next)
		}
	}
}

const PARSING_SYSEX_MESSAGE_STATE = new ParsingSysexMessageState()

class ParsingDigitalMessageState implements FirmataFsmState {
	constructor(readonly portId: number) {}

	process(b: number, fsm: FirmataFsm) {
		if (fsm.offset === 0) {
			fsm.write(b)
		} else if (fsm.offset === 1) {
			const value = fsm.read(0) | (b << 7)
			const pin = this.portId * 8

			for (let i = 0; i < 8; i++) {
				fsm.digitalMessage(pin + i, (value >>> i) & 0x01)
			}

			fsm.transitTo(WAITING_FOR_MESSAGE_STATE)
		}
	}
}

class ParsingAnalogMessageState implements FirmataFsmState {
	constructor(readonly portId: number) {}

	process(b: number, fsm: FirmataFsm) {
		if (fsm.offset === 0) {
			fsm.write(b)
		} else if (fsm.offset === 1) {
			const value = fsm.read(0) | (b << 7)
			fsm.analogMessage(this.portId, value)

			fsm.transitTo(WAITING_FOR_MESSAGE_STATE)
		}
	}
}

class WaitingForMessageState implements FirmataFsmState {
	process(b: number, fsm: FirmataFsm) {
		// First byte may contain not only command but additional information as well.
		const command = b < 0xf0 ? b & 0xf0 : b

		switch (command) {
			case DIGITAL_MESSAGE:
				fsm.transitTo(new ParsingDigitalMessageState(b & 0x0f))
				break
			case ANALOG_MESSAGE:
				fsm.transitTo(new ParsingAnalogMessageState(b & 0x0f))
				break
			case REPORT_VERSION:
				fsm.transitTo(PARSING_VERSION_MESSAGE_STATE)
				break
			case START_SYSEX:
				fsm.transitTo(PARSING_SYSEX_MESSAGE_STATE)
				break
			case SYSTEM_RESET:
				fsm.systemReset()
				break
			// Skip non control token.
			default:
				fsm.error(command)
				break
		}
	}
}

const WAITING_FOR_MESSAGE_STATE = new WaitingForMessageState()

export class FirmataFsm {
	private readonly handlers = new Set<FirmataClientHandler>()

	#buffer = Buffer.alloc(256)
	#offset = 0

	constructor(
		private state: FirmataFsmState,
		readonly client: FirmataClient,
	) {}

	get offset() {
		return this.#offset
	}

	get buffer() {
		return this.#buffer.subarray(0, this.#offset)
	}

	addHandler(handler: FirmataClientHandler) {
		this.handlers.add(handler)
	}

	removeHandler(handler: FirmataClientHandler) {
		this.handlers.delete(handler)
	}

	process(byte: number) {
		this.state.process(byte, this)
	}

	transitTo(state: FirmataFsmState) {
		this.#offset = 0
		this.state = state
	}

	write(b: number) {
		this.#buffer.writeUInt8(b, this.#offset++)
	}

	read(offset: number) {
		return this.#buffer.readUInt8(offset)
	}

	read7Bit(offset: number) {
		return decodeByteAs7Bit(this.#buffer, offset)
	}

	readText(offset: number = 0, encoding?: BufferEncoding) {
		const length = this.#offset - offset
		let n = 0

		for (let i = 0; i < length; i += 2, n++) {
			this.#buffer.writeUInt8(this.read7Bit(offset + i), offset + n)
		}

		return this.#buffer.toString(encoding, offset, offset + n)
	}

	ready() {
		this.handlers.forEach((handler) => handler.ready?.(this.client))
	}

	pinChange(pin: Pin) {
		this.handlers.forEach((handler) => handler.pinChange?.(this.client, pin))
	}

	customMessage(data: Buffer) {
		this.handlers.forEach((handler) => handler.customMessage?.(this.client, data))
	}

	version(major: number, minor: number) {
		this.handlers.forEach((handler) => handler.version?.(this.client, major, minor))
	}

	firmwareMessage(major: number, minor: number, name: string) {
		this.handlers.forEach((handler) => handler.firmwareMessage?.(this.client, major, minor, name))
	}

	systemReset() {
		this.handlers.forEach((handler) => handler.systemReset?.(this.client))
	}

	error(command: number) {
		this.handlers.forEach((handler) => handler.error?.(this.client, command))
	}

	digitalMessage(id: number, value: number) {
		this.handlers.forEach((handler) => handler.digitalMessage?.(this.client, id, value))
	}

	analogMessage(port: number, value: number) {
		this.handlers.forEach((handler) => handler.analogMessage?.(this.client, port, value))
	}

	pinCapability(id: number, modes: Set<PinMode>) {
		this.handlers.forEach((handler) => handler.pinCapability?.(this.client, id, modes))
	}

	pinCapabilitiesFinished() {
		this.handlers.forEach((handler) => handler.pinCapabilitiesFinished?.(this.client))
	}

	analogMapping(mapping: AnalogMapping) {
		this.handlers.forEach((handler) => handler.analogMapping?.(this.client, mapping))
	}

	pinState(id: number, mode: PinMode, value: number) {
		this.handlers.forEach((handler) => handler.pinState?.(this.client, id, mode, value))
	}

	textMessage(message: string) {
		this.handlers.forEach((handler) => handler.textMessage?.(this.client, message))
	}

	twoWireMessage(address: number, register: number, data: Buffer) {
		this.handlers.forEach((handler) => handler.twoWireMessage?.(this.client, address, register, data))
	}
}

// Writes a 14-bit value as two 7-bit bytes.
export function writeValueAsTwo7bitBytes(data: Uint8Array, offset: number, value: number) {
	data[offset] = value & 0x7f
	data[offset + 1] = (value >> 7) & 0x7f
}

const REQUEST_FIRMWARE_DATA = new Uint8Array([START_SYSEX, REPORT_FIRMWARE, END_SYSEX])
const REQUEST_PIN_CAPABILITY_DATA = new Uint8Array([START_SYSEX, CAPABILITY_QUERY, END_SYSEX])
const REQUEST_ANALOG_MAPPING_DATA = new Uint8Array([START_SYSEX, ANALOG_MAPPING_QUERY, END_SYSEX])

export class FirmataClient implements Disposable {
	private readonly fsm: FirmataFsm
	private readonly parser: FirmataParser

	private initializing = true
	private maxTwoWireDelay = 0

	private readonly pinStateRequestQueue: number[] = []
	private readonly pinMap = new Map<number, Pin>()
	private readonly analogPins: AnalogMapping = {}
	private readonly initialization = Promise.withResolvers<boolean>()

	private readonly handler: FirmataClientHandler = {
		customMessage: (client: FirmataClient, data: Buffer) => {
			//
		},
		firmwareMessage: (client: FirmataClient, major: number, minor: number, name: string) => {
			this.initializing && this.requestPinCapability()
		},
		systemReset: (client: FirmataClient) => {
			//
		},
		error: (client: FirmataClient, command: number) => {
			//
		},
		digitalMessage: (client: FirmataClient, id: number, value: number) => {},
		analogMessage: (client: FirmataClient, port: number, value: number) => {
			const pin = this.pinMap.get(this.analogPins[port])

			if (pin?.mode === PinMode.ANALOG && pin.value !== value) {
				pin.value = value
				this.fsm.pinChange(pin)
			}
		},
		pinCapability: (client: FirmataClient, id: number, modes: Set<PinMode>) => {
			this.pinMap.set(id, { id, modes, mode: PinMode.UNSUPPORTED, value: 0 })

			// if the pin supports some modes, we will ask for its current mode and value.
			if (modes.size > 0) this.pinStateRequestQueue.push(id)
		},
		pinCapabilitiesFinished: (client: FirmataClient) => {
			if (this.pinStateRequestQueue.length) {
				this.requestPinState(this.pinStateRequestQueue.shift()!)
			} else if (this.initializing) {
				this.requestAnalogMapping()
			}
		},
		analogMapping: (client: FirmataClient, mapping: AnalogMapping) => {
			Object.assign(this.analogPins, mapping)

			if (this.initializing) {
				this.initializing = false
				this.initialization.resolve(true)
				this.fsm.ready()
			}
		},
		pinState: (client: FirmataClient, id: number, mode: PinMode, value: number) => {
			const pin = this.pinMap.get(id)

			if (pin) {
				pin.mode = mode
				pin.value = value

				if (this.pinStateRequestQueue.length) {
					this.requestPinState(this.pinStateRequestQueue.shift()!)
				} else if (this.initializing) {
					this.requestAnalogMapping()
				}
			}
		},
		textMessage: (client: FirmataClient, message: string) => {
			//
		},
		twoWireMessage: (client: FirmataClient, address: number, register: number, data: Buffer) => {
			//
		},
	}

	constructor(
		private readonly transport: Transport,
		private readonly board: Board,
	) {
		this.fsm = new FirmataFsm(WAITING_FOR_MESSAGE_STATE, this)
		this.parser = new FirmataParser(this.fsm)
		this.addHandler(this.handler)
	}

	[Symbol.dispose]() {
		this.disconnect()
	}

	get pinCount() {
		return this.pinMap.size
	}

	get pins(): MapIterator<Readonly<Pin>> {
		return this.pinMap.values()
	}

	pinAt(id: number): Readonly<Pin> | undefined {
		return this.pinMap.get(id)
	}

	addHandler(handler: FirmataClientHandler) {
		this.fsm.addHandler(handler)
	}

	removeHandler(handler: FirmataClientHandler) {
		this.fsm.removeHandler(handler)
	}

	disconnect() {
		this.transport.close()
		this.reset()
	}

	process(data: Buffer) {
		this.parser.process(data)
	}

	processByte(b: number) {
		this.parser.processByte(b)
	}

	ensureInitializationIsDone(timeout: number) {
		const timer = timeout > 0 ? setTimeout(this.initialization.resolve, timeout, false) : undefined
		this.initialization.promise.then(clearTimeout.bind(undefined, timer))
		return this.initialization.promise
	}

	reset() {
		this.fsm.transitTo(WAITING_FOR_MESSAGE_STATE)
	}

	send(message: string | Bun.BufferSource, byteOffset?: number, byteLength?: number) {
		this.transport.write(message, byteOffset, byteLength)
		this.transport.flush()
	}

	requestFirmware() {
		this.send(REQUEST_FIRMWARE_DATA)
	}

	requestPinCapability() {
		this.send(REQUEST_PIN_CAPABILITY_DATA)
	}

	requestPinState(pinId: number) {
		this.send(new Uint8Array([START_SYSEX, PIN_STATE_QUERY, pinId, END_SYSEX]))
	}

	requestAnalogMapping() {
		this.send(REQUEST_ANALOG_MAPPING_DATA)
	}

	requestDigitalReport(enable: boolean) {
		const message = new Uint8Array(32)

		for (let i = 0, p = 0; i < 16; i++) {
			message[p++] = REPORT_DIGITAL | i
			message[p++] = enable ? 1 : 0
		}

		this.send(message)
	}

	requestDigitalPinReport(pin: number, enable: boolean) {
		this.send(new Uint8Array([REPORT_DIGITAL | this.board.pinToDigital(pin), enable ? 1 : 0]))
	}

	requestAnalogReport(enable: boolean) {
		const message = new Uint8Array(32)

		for (let i = 0, p = 0; i < 16; i++) {
			message[p++] = REPORT_ANALOG | i
			message[p++] = enable ? 1 : 0
		}

		this.send(message)
	}

	requestAnalogPinReport(pin: number, enable: boolean) {
		this.send(new Uint8Array([REPORT_ANALOG | this.board.pinToAnalog(pin), enable ? 1 : 0]))
	}

	pinMode(pin: number, mode: PinMode) {
		this.send(new Uint8Array([SET_PIN_MODE, pin, mode]))
	}

	digitalWrite(pin: number, value: boolean | number) {
		this.send(new Uint8Array([SET_DIGITAL_PIN_VALUE, pin, value ? 1 : 0]))
	}

	samplingInterval(milliseconds: number) {
		const message = new Uint8Array([START_SYSEX, SAMPLING_INTERVAL, 0, 0, END_SYSEX])
		encodeByteAs7Bit(Math.max(MIN_SAMPLING_INTERVAL, Math.min(milliseconds, MAX_SAMPLING_INTERVAL)), message, 2)
		this.send(message)
	}

	twoWireConfig(delayInMicroseconds: number) {
		this.maxTwoWireDelay = Math.max(this.maxTwoWireDelay, delayInMicroseconds)
		const message = new Uint8Array([START_SYSEX, TWO_WIRE_CONFIG, 0, 0, END_SYSEX])
		encodeByteAs7Bit(this.maxTwoWireDelay, message, 2)
		this.send(message)
	}

	twoWireReadWrite(address: number, operationMode: TwoWireOperationMode, data?: Readonly<NumberArray> | Buffer, addressMode: TwoWireAddressMode = 7, autoRestart: TwoWireAutoRestartMode = 'stop') {
		const message = Buffer.alloc(5 + (data !== undefined ? data.length * 2 : 0))

		message[0] = START_SYSEX
		message[1] = TWO_WIRE_REQUEST
		message[2] = address & 0x7f
		message[3] = ((address >>> 7) & 0x7) | (operationMode === 'write' ? TWO_WIRE_WRITE : operationMode === 'read' ? TWO_WIRE_READ : operationMode === 'readContinuously' ? TWO_WIRE_READ_CONTINUOUS : TWO_WIRE_STOP_READ) | (addressMode === 7 ? 0 : 0x20) | (autoRestart === 'stop' ? 0x40 : 0)

		if (data !== undefined) {
			for (let i = 0, offset = 4; i < data.length; i++, offset += 2) {
				encodeByteAs7Bit(data[i], message, offset)
			}
		}

		message[message.byteLength - 1] = END_SYSEX

		this.send(message)
	}

	twoWireRead(address: number, register: number, bytesToRead: number, continuous: boolean = false, addressMode: TwoWireAddressMode = 7, autoRestart: TwoWireAutoRestartMode = 'stop') {
		const data = new Uint8Array(register >= 0 ? [register, bytesToRead] : [bytesToRead])
		this.twoWireReadWrite(address, continuous ? 'readContinuously' : 'read', data, addressMode, autoRestart)
	}

	twoWireWrite(address: number, data: Readonly<NumberArray> | Buffer, addressMode: TwoWireAddressMode = 7) {
		this.twoWireReadWrite(address, 'write', data, addressMode)
	}

	twoWireStop(address: number, addressMode: TwoWireAddressMode = 7) {
		this.twoWireReadWrite(address, 'stop', undefined, addressMode)
	}
}

export class FirmataClientOverTcp extends FirmataClient {
	private socket?: Bun.Socket

	constructor(board: Board) {
		super(
			{
				write: (data, byteOffset, byteLength) => {
					this.socket?.write(data, byteOffset, byteLength)
				},
				flush: () => {
					this.socket?.flush()
				},
				close: () => {
					this.socket?.close()
					this.socket = undefined
				},
			},
			board,
		)
	}

	async connect(hostname: string, port: number, options?: Omit<Bun.TCPSocketConnectOptions<undefined>, 'hostname' | 'port' | 'socket'>) {
		if (this.socket) return false

		this.socket = await Bun.connect({
			...options,
			hostname,
			port,
			socket: {
				data: (_, buffer) => {
					this.process(buffer)
				},
				error: (_, error) => {
					console.error('socket error:', error)
					this.reset()
				},
				connectError: (_, error) => {
					console.error('connection failed:', error)
					this.reset()
				},
			},
		})

		this.requestFirmware()

		return true
	}
}

// BOARD

// https://github.com/firmata/arduino/blob/main/Boards.h#L998

export class ESP8266 implements Board {
	static readonly D0 = 16
	static readonly D1 = 5
	static readonly D2 = 4
	static readonly D3 = 0
	static readonly D4 = 2
	static readonly D5 = 14
	static readonly D6 = 12
	static readonly D7 = 13
	static readonly D8 = 15
	static readonly D9 = 3
	static readonly D10 = 1

	static readonly A0 = 17

	static readonly SDA = this.D2
	static readonly SCL = this.D1

	static readonly RX = this.D9
	static readonly TX = this.D10

	static readonly SS = this.D8
	static readonly MOSI = this.D7
	static readonly MISO = this.D6
	static readonly SCK = this.D5

	static readonly MAX_SERVOS = 9

	static readonly LED_BUILTIN = this.D4
	static readonly LED_BUILTIN_AUX = this.D0

	static readonly NUMBER_OF_DIGITAL_PINS = 17
	static readonly NUMBER_OF_ANALOG_PINS = 1

	static readonly TOTAL_PINS = 18
	static readonly DEFAULT_PWM_RESOLUTION = 10

	readonly name = 'ESP8266'

	isPinLED(pin: number) {
		return pin === ESP8266.LED_BUILTIN || pin === ESP8266.LED_BUILTIN_AUX
	}

	isPinDigital(pin: number) {
		return (pin >= ESP8266.D3 && pin <= ESP8266.D1) || (pin >= ESP8266.D6 && pin < ESP8266.A0)
	}

	isPinAnalog(pin: number) {
		return pin === ESP8266.A0
	}

	isPinPWM(pin: number) {
		return pin < ESP8266.A0
	}

	isPinServo(pin: number) {
		return this.isPinDigital(pin) && pin < ESP8266.MAX_SERVOS
	}

	isPinTwoWire(pin: number) {
		return pin === ESP8266.SDA || pin === ESP8266.SCL
	}

	isPinSPI(pin: number) {
		return pin === ESP8266.SS || pin === ESP8266.MOSI || pin === ESP8266.MISO || pin === ESP8266.SCK
	}

	isPinSerial(pin: number) {
		return pin === ESP8266.RX || pin === ESP8266.TX
	}

	pinToDigital(pin: number) {
		return pin
	}

	pinToAnalog(pin: number) {
		return pin - ESP8266.A0
	}

	pinToPWM(pin: number) {
		return this.pinToDigital(pin)
	}

	pinToServo(pin: number) {
		return pin
	}
}

// HARDWARE (SENSORS, BUTTONS, LEDs)

abstract class HardwareBase<D extends Hardware<D>> {
	protected readonly listeners = new Set<HardwareListener<D>>()

	abstract client: FirmataClient
	abstract start(): void
	abstract stop(): void

	[Symbol.dispose]() {
		this.stop()
	}

	addListener(listener: HardwareListener<D>) {
		this.listeners.add(listener)
	}

	removeListener(listener: HardwareListener<D>) {
		this.listeners.delete(listener)
	}

	protected fire() {
		for (const listener of this.listeners) listener(this as never)
	}
}

// THERMOMETER

export class LM35 extends HardwareBase<LM35> implements Thermometer, FirmataClientHandler {
	temperature = 0

	constructor(
		readonly client: FirmataClient,
		readonly pin: number,
		readonly aref: number = 5,
	) {
		super()
	}

	pinChange(client: FirmataClient, pin: Pin) {
		if (this.client === client && pin.id === this.pin) {
			const temperature = (this.aref * 100 * pin.value) / 1023

			if (temperature !== this.temperature) {
				this.temperature = temperature
				this.fire()
			}
		}
	}

	start() {
		this.client.addHandler(this)
		this.client.pinMode(this.pin, PinMode.ANALOG)
		this.client.requestAnalogPinReport(this.pin, true)
	}

	stop() {
		this.client.removeHandler(this)
		this.client.requestAnalogPinReport(this.pin, false)
	}
}

// BAROMETER

// https://cdn-shop.adafruit.com/datasheets/BST-BMP180-DS000-09.pdf

export class BMP180 extends HardwareBase<BMP180> implements Barometer, Altimeter, Thermometer, FirmataClientHandler {
	pressure = 0
	altitude = 0
	temperature = 0

	// Initial values from datasheet (for test only)
	private AC1 = 408
	private AC2 = -72
	private AC3 = -14383
	private AC4 = 32741
	private AC5 = 32757
	private AC6 = 23153

	private B1 = 6190
	private B2 = 4

	private MB = -32768
	private MC = -8711
	private MD = 2868

	private B5 = 0

	private state = 0 // 0 = unitialized, 1 = calibrating, 2 = temperature, 3 = pressure

	static readonly ADDRESS = 0x77

	private static readonly COEFFICIENTS_REG = 0xaa
	private static readonly CONTROL_REG = 0xf4
	private static readonly TEMP_DATA_REG = 0xf6
	private static readonly PRES_DATA_REG = 0xf6

	private static readonly READ_TEMP_CMD = 0x2e
	private static readonly READ_PRES_CMD = 0x34

	private timer?: NodeJS.Timeout

	constructor(
		readonly client: FirmataClient,
		readonly mode: BMP180Mode = 0,
		readonly pollingInterval: number = 5000,
	) {
		super()
	}

	twoWireMessage(client: FirmataClient, address: number, register: number, data: Buffer) {
		if (address === BMP180.ADDRESS) {
			if (this.state === 1 && register === BMP180.COEFFICIENTS_REG && data.byteLength === 22) {
				this.AC1 = data.readInt16BE(0)
				this.AC2 = data.readInt16BE(2)
				this.AC3 = data.readInt16BE(4)
				this.AC4 = data.readUInt16BE(6)
				this.AC5 = data.readUInt16BE(8)
				this.AC6 = data.readUInt16BE(10)
				this.B1 = data.readInt16BE(12)
				this.B2 = data.readInt16BE(14)
				this.MB = data.readInt16BE(16)
				this.MC = data.readInt16BE(18)
				this.MD = data.readInt16BE(20)

				console.info(this.AC1, this.AC2, this.AC3, this.AC4, this.AC5, this.AC6, this.B1, this.B2, this.MB, this.MC, this.MD)

				this.timer = setInterval(this.readUncompensatedTemperature.bind(this), Math.max(1000, this.pollingInterval))

				this.state = 2
			} else if (this.state === 2 && register === BMP180.TEMP_DATA_REG && data.byteLength === 2) {
				const UT = data.readInt16BE(0)
				this.temperature = this.computeTrueTemperature(UT)
				this.state = 3
				void this.readUncompensatedPressure()
			} else if (this.state === 3 && register === BMP180.PRES_DATA_REG && data.byteLength === 3) {
				const UP = ((data.readUint8(0) << 16) | data.readUint16BE(1)) >> (8 - this.mode)
				this.pressure = pascal(this.computeTruePressure(UP))
				this.altitude = fromPressure(this.pressure, this.temperature)
				this.state = 2
				this.fire()
			} else {
				console.warn('invalid state: ', this.state)
			}
		}
	}

	start() {
		if (this.state === 0) {
			this.state = 1
			this.client.addHandler(this)
			this.client.twoWireConfig(0)
			this.readCalibrationData()
		}
	}

	stop() {
		this.state = 0
		this.client.removeHandler(this)
		clearInterval(this.timer)
		this.timer = undefined
	}

	private readCalibrationData() {
		this.client.twoWireRead(BMP180.ADDRESS, BMP180.COEFFICIENTS_REG, 22)
	}

	private async readUncompensatedTemperature() {
		this.client.twoWireWrite(BMP180.ADDRESS, [BMP180.CONTROL_REG, BMP180.READ_TEMP_CMD])
		await Bun.sleep(5)
		this.client.twoWireRead(BMP180.ADDRESS, BMP180.TEMP_DATA_REG, 2)
	}

	private async readUncompensatedPressure() {
		this.client.twoWireWrite(BMP180.ADDRESS, [BMP180.CONTROL_REG, BMP180.READ_PRES_CMD | (this.mode << 6)])
		await Bun.sleep(30)
		this.client.twoWireRead(BMP180.ADDRESS, BMP180.PRES_DATA_REG, 3)
	}

	computeTrueTemperature(UT: number) {
		const X1 = ((UT - this.AC6) * this.AC5) >> 15
		const X2 = Math.round((this.MC << 11) / (X1 + this.MD))
		this.B5 = X1 + X2
		return ((this.B5 + 8) >> 4) / 10
	}

	computeTruePressure(UP: number) {
		const B6 = this.B5 - 4000
		const K = (B6 * B6) >> 12
		let X3 = (this.B2 * K + this.AC2 * B6) >> 11
		const B3 = (((this.AC1 * 4 + X3) << this.mode) + 2) >> 2
		let X1 = (this.AC3 * B6) >> 13
		let X2 = (this.B1 * K) >> 16
		X3 = (X1 + X2 + 2) >> 2
		const B4 = (this.AC4 * (X3 + 32768)) >>> 15
		const B7 = (UP - B3) * (50000 >>> this.mode)
		const P = Math.round(B7 < 0x80000000 ? (B7 * 2) / B4 : (B7 / B4) * 2)
		X1 = (P >> 8) * (P >> 8)
		X1 = (X1 * 3038) >> 16
		X2 = (-7357 * P) >> 16
		return P + ((X1 + X2 + 3791) >> 4)
	}
}
