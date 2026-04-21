import type { NumberArray } from './math'

// https://github.com/firmata/protocol/blob/master/protocol.md

export type AnalogMapping = Record<number, number>

export type TwoWireAutoRestartMode = 'stop' | 'restart'

export type TwoWireAddressMode = 7 | 10

export type TwoWireOperationMode = 'write' | 'read' | 'readContinuously' | 'stop'

export type OneWirePowerMode = 'normal' | 'parasitic'

export type OneWireSearchMode = 'all' | 'alarms'

export interface OneWireCommandOptions {
	readonly reset?: boolean
	readonly skip?: boolean
	readonly address?: Readonly<NumberArray> | Buffer
	readonly bytesToRead?: number
	readonly correlationId?: number
	readonly delay?: number
	readonly data?: Readonly<NumberArray> | Buffer
}

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
	readonly oneWireSearchReply?: (client: FirmataClient, pin: number, addresses: readonly Buffer[], alarms: boolean) => void
	readonly oneWireReadReply?: (client: FirmataClient, pin: number, correlationId: number, data: Buffer) => void

	readonly close?: (client: FirmataClient) => void
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

export const DEFAULT_ONE_WIRE_COMMAND_OPTIONS: OneWireCommandOptions = {
	reset: false,
	skip: false,
}

// PROTOCOL

function resolvePinMode(mode: number) {
	if (mode === PIN_MODE_IGNORE) return PinMode.IGNORED
	else if (mode >= TOTAL_PIN_MODES) return PinMode.UNSUPPORTED
	else return mode as PinMode
}

export class FirmataParser {
	readonly #fsm: FirmataFsm

	constructor(fsm: FirmataFsm) {
		this.#fsm = fsm
	}

	process(data: Buffer) {
		for (let i = 0; i < data.byteLength; i++) {
			this.processByte(data[i])
		}
	}

	processByte(b: number) {
		this.#fsm.process(b)
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

const ONE_WIRE_SEARCH_REQUEST = 0x40
const ONE_WIRE_CONFIG_REQUEST = 0x41
const ONE_WIRE_SEARCH_REPLY = 0x42
const ONE_WIRE_READ_REPLY = 0x43
const ONE_WIRE_SEARCH_ALARMS_REQUEST = 0x44
const ONE_WIRE_SEARCH_ALARMS_REPLY = 0x45

const ONE_WIRE_RESET_REQUEST_BIT = 0x01
const ONE_WIRE_SKIP_REQUEST_BIT = 0x02
const ONE_WIRE_SELECT_REQUEST_BIT = 0x04
const ONE_WIRE_READ_REQUEST_BIT = 0x08
const ONE_WIRE_DELAY_REQUEST_BIT = 0x10
const ONE_WIRE_WRITE_REQUEST_BIT = 0x20

const MIN_SAMPLING_INTERVAL = 1
const MAX_SAMPLING_INTERVAL = 16383

export function decodeByteAs7Bit(input: Readonly<NumberArray> | Buffer, offset: number) {
	return (input[offset] & 0x7f) | ((input[offset + 1] & 0x01) << 7)
}

export function encodeByteAs7Bit(data: number, output: NumberArray | Buffer, offset: number = 0) {
	output[offset++] = data & 0x7f
	output[offset] = (data >>> 7) & 1
}

export function decodePacked7Bit(input: Readonly<NumberArray> | Buffer, offset: number = 0, length: number = input.length - offset) {
	const output = Buffer.alloc(Math.floor(Math.max(0, length) * 0.875))

	for (let i = 0; i < output.length; i++) {
		const bitOffset = i << 3
		const p = Math.floor(bitOffset / 7)
		const s = bitOffset % 7
		const lo = input[offset + p] ?? 0
		const hi = input[offset + p + 1] ?? 0
		output[i] = ((lo >>> s) | (hi << (7 - s))) & 0xff
	}

	return output
}

export function encodePacked7Bit(input: Readonly<NumberArray> | Buffer, offset: number = 0, length: number = input.length - offset) {
	const output = Buffer.alloc(Math.ceil((Math.max(0, length) << 3) / 7))

	for (let i = 0; i < length; i++) {
		const value = input[offset + i] & 0xff
		const bitOffset = i << 3
		const p = Math.floor(bitOffset / 7)
		const s = bitOffset % 7
		output[p] |= (value << s) & 0x7f
		if (p + 1 < output.length) output[p + 1] |= (value >>> (7 - s)) & 0x7f
	}

	return output
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

class ParsingOneWireMessageState implements FirmataFsmState {
	process(b: number, fsm: FirmataFsm) {
		if (b === END_SYSEX) {
			if (fsm.offset >= 2) {
				const command = fsm.read(0)
				const pin = fsm.read(1)

				if (command === ONE_WIRE_SEARCH_REPLY || command === ONE_WIRE_SEARCH_ALARMS_REPLY) {
					const data = decodePacked7Bit(fsm.buffer, 2, fsm.offset - 2)
					const addresses: Buffer[] = []

					for (let i = 0; i + 7 < data.length; i += 8) {
						addresses.push(Buffer.from(data.subarray(i, i + 8)))
					}

					fsm.oneWireSearchReply(pin, addresses, command === ONE_WIRE_SEARCH_ALARMS_REPLY)
				} else if (command === ONE_WIRE_READ_REPLY) {
					const data = decodePacked7Bit(fsm.buffer, 2, fsm.offset - 2)

					if (data.length >= 2) {
						fsm.oneWireReadReply(pin, data.readUInt16LE(0), data.subarray(2))
					}
				}
			}

			fsm.transitTo(WAITING_FOR_MESSAGE_STATE)
		} else {
			fsm.write(b)
		}
	}
}

const PARSING_ONE_WIRE_MESSAGE_STATE = new ParsingOneWireMessageState()

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
		else if (b === ONE_WIRE_DATA) next = PARSING_ONE_WIRE_MESSAGE_STATE

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
	readonly #handlers = new Set<FirmataClientHandler>()

	#buffer = Buffer.alloc(256)
	#offset = 0
	#state: FirmataFsmState

	constructor(
		state: FirmataFsmState,
		readonly client: FirmataClient,
	) {
		this.#state = state
	}

	get offset() {
		return this.#offset
	}

	get buffer() {
		return this.#buffer.subarray(0, this.#offset)
	}

	addHandler(handler: FirmataClientHandler) {
		this.#handlers.add(handler)
	}

	removeHandler(handler: FirmataClientHandler) {
		this.#handlers.delete(handler)
	}

	process(byte: number) {
		this.#state.process(byte, this)
	}

	transitTo(state: FirmataFsmState) {
		this.#offset = 0
		this.#state = state
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
		this.#handlers.forEach((handler) => handler.ready?.(this.client))
	}

	pinChange(pin: Pin) {
		this.#handlers.forEach((handler) => handler.pinChange?.(this.client, pin))
	}

	customMessage(data: Buffer) {
		this.#handlers.forEach((handler) => handler.customMessage?.(this.client, data))
	}

	version(major: number, minor: number) {
		this.#handlers.forEach((handler) => handler.version?.(this.client, major, minor))
	}

	firmwareMessage(major: number, minor: number, name: string) {
		this.#handlers.forEach((handler) => handler.firmwareMessage?.(this.client, major, minor, name))
	}

	systemReset() {
		this.#handlers.forEach((handler) => handler.systemReset?.(this.client))
	}

	error(command: number) {
		this.#handlers.forEach((handler) => handler.error?.(this.client, command))
	}

	digitalMessage(id: number, value: number) {
		this.#handlers.forEach((handler) => handler.digitalMessage?.(this.client, id, value))
	}

	analogMessage(port: number, value: number) {
		this.#handlers.forEach((handler) => handler.analogMessage?.(this.client, port, value))
	}

	pinCapability(id: number, modes: Set<PinMode>) {
		this.#handlers.forEach((handler) => handler.pinCapability?.(this.client, id, modes))
	}

	pinCapabilitiesFinished() {
		this.#handlers.forEach((handler) => handler.pinCapabilitiesFinished?.(this.client))
	}

	analogMapping(mapping: AnalogMapping) {
		this.#handlers.forEach((handler) => handler.analogMapping?.(this.client, mapping))
	}

	pinState(id: number, mode: PinMode, value: number) {
		this.#handlers.forEach((handler) => handler.pinState?.(this.client, id, mode, value))
	}

	textMessage(message: string) {
		this.#handlers.forEach((handler) => handler.textMessage?.(this.client, message))
	}

	twoWireMessage(address: number, register: number, data: Buffer) {
		this.#handlers.forEach((handler) => handler.twoWireMessage?.(this.client, address, register, data))
	}

	oneWireSearchReply(pin: number, addresses: readonly Buffer[], alarms: boolean) {
		this.#handlers.forEach((handler) => handler.oneWireSearchReply?.(this.client, pin, addresses, alarms))
	}

	oneWireReadReply(pin: number, correlationId: number, data: Buffer) {
		this.#handlers.forEach((handler) => handler.oneWireReadReply?.(this.client, pin, correlationId, data))
	}

	close() {
		this.#handlers.forEach((handler) => handler.close?.(this.client))
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
	readonly #fsm: FirmataFsm
	readonly #parser: FirmataParser
	readonly #transport: Transport
	readonly #board: Board

	#initializing = true
	#maxTwoWireDelay = 0
	#oneWireCorrelationId = 0

	readonly #pinStateRequestQueue: number[] = []
	readonly #pinMap = new Map<number, Pin>()
	readonly #analogPins: AnalogMapping = {}
	readonly #initialization = Promise.withResolvers<boolean>()

	readonly #handler: FirmataClientHandler = {
		customMessage: (client: FirmataClient, data: Buffer) => {
			//
		},
		firmwareMessage: (client: FirmataClient, major: number, minor: number, name: string) => {
			this.#initializing && this.requestPinCapability()
		},
		systemReset: (client: FirmataClient) => {
			//
		},
		error: (client: FirmataClient, command: number) => {
			//
		},
		digitalMessage: (client: FirmataClient, id: number, value: number) => {},
		analogMessage: (client: FirmataClient, port: number, value: number) => {
			const pin = this.#pinMap.get(this.#analogPins[port])

			if (pin?.mode === PinMode.ANALOG && pin.value !== value) {
				pin.value = value
				this.#fsm.pinChange(pin)
			}
		},
		pinCapability: (client: FirmataClient, id: number, modes: Set<PinMode>) => {
			this.#pinMap.set(id, { id, modes, mode: PinMode.UNSUPPORTED, value: 0 })

			// if the pin supports some modes, we will ask for its current mode and value.
			if (modes.size > 0) this.#pinStateRequestQueue.push(id)
		},
		pinCapabilitiesFinished: (client: FirmataClient) => {
			if (this.#pinStateRequestQueue.length) {
				this.requestPinState(this.#pinStateRequestQueue.shift()!)
			} else if (this.#initializing) {
				this.requestAnalogMapping()
			}
		},
		analogMapping: (client: FirmataClient, mapping: AnalogMapping) => {
			Object.assign(this.#analogPins, mapping)

			if (this.#initializing) {
				this.#initializing = false
				this.#initialization.resolve(true)
				this.#fsm.ready()
			}
		},
		pinState: (client: FirmataClient, id: number, mode: PinMode, value: number) => {
			const pin = this.#pinMap.get(id)

			if (pin) {
				pin.mode = mode
				pin.value = value

				if (this.#pinStateRequestQueue.length) {
					this.requestPinState(this.#pinStateRequestQueue.shift()!)
				} else if (this.#initializing) {
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
		oneWireSearchReply: (client: FirmataClient, pin: number, addresses: readonly Buffer[], alarms: boolean) => {
			//
		},
		oneWireReadReply: (client: FirmataClient, pin: number, correlationId: number, data: Buffer) => {
			//
		},
	}

	constructor(transport: Transport, board: Board) {
		this.#transport = transport
		this.#board = board
		this.#fsm = new FirmataFsm(WAITING_FOR_MESSAGE_STATE, this)
		this.#parser = new FirmataParser(this.#fsm)
		this.addHandler(this.#handler)
	}

	[Symbol.dispose]() {
		this.disconnect()
	}

	get pinCount() {
		return this.#pinMap.size
	}

	get pins(): MapIterator<Readonly<Pin>> {
		return this.#pinMap.values()
	}

	pinAt(id: number): Readonly<Pin> | undefined {
		return this.#pinMap.get(id)
	}

	addHandler(handler: FirmataClientHandler) {
		this.#fsm.addHandler(handler)
	}

	removeHandler(handler: FirmataClientHandler) {
		this.#fsm.removeHandler(handler)
	}

	disconnect() {
		this.#transport.close()
		this.reset()
	}

	process(data: Buffer) {
		this.#parser.process(data)
	}

	processByte(b: number) {
		this.#parser.processByte(b)
	}

	ensureInitializationIsDone(timeout: number) {
		const timer = timeout > 0 ? setTimeout(this.#initialization.resolve, timeout, false) : undefined
		void this.#initialization.promise.then(clearTimeout.bind(undefined, timer))
		return this.#initialization.promise
	}

	reset() {
		this.#fsm.transitTo(WAITING_FOR_MESSAGE_STATE)
	}

	send(message: string | Bun.BufferSource, byteOffset?: number, byteLength?: number) {
		this.#transport.write(message, byteOffset, byteLength)
		this.#transport.flush()
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
		this.send(new Uint8Array([REPORT_DIGITAL | this.#board.pinToDigital(pin), enable ? 1 : 0]))
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
		this.send(new Uint8Array([REPORT_ANALOG | this.#board.pinToAnalog(pin), enable ? 1 : 0]))
	}

	pinMode(pin: number, mode: PinMode) {
		this.send(new Uint8Array([SET_PIN_MODE, pin, mode]))
	}

	digitalWrite(pin: number, value: boolean | number) {
		this.send(new Uint8Array([SET_DIGITAL_PIN_VALUE, pin, value ? 1 : 0]))
	}

	analogWrite(pin: number, value: number) {
		const data = Math.max(0, Math.min(0x0fffffff, Math.trunc(value)))

		if (data < 0x80) {
			this.send(new Uint8Array([START_SYSEX, EXTENDED_ANALOG, this.#board.pinToPWM(pin), data, END_SYSEX]))
		} else if (data < 0x4000) {
			this.send(new Uint8Array([START_SYSEX, EXTENDED_ANALOG, this.#board.pinToPWM(pin), data & 0x7f, (data >>> 7) & 0x7f, END_SYSEX]))
		} else if (data < 0x200000) {
			this.send(new Uint8Array([START_SYSEX, EXTENDED_ANALOG, this.#board.pinToPWM(pin), data & 0x7f, (data >>> 7) & 0x7f, (data >>> 14) & 0x7f, END_SYSEX]))
		} else {
			this.send(new Uint8Array([START_SYSEX, EXTENDED_ANALOG, this.#board.pinToPWM(pin), data & 0x7f, (data >>> 7) & 0x7f, (data >>> 14) & 0x7f, (data >>> 21) & 0x7f, END_SYSEX]))
		}
	}

	samplingInterval(milliseconds: number) {
		const message = new Uint8Array([START_SYSEX, SAMPLING_INTERVAL, 0, 0, END_SYSEX])
		encodeByteAs7Bit(Math.max(MIN_SAMPLING_INTERVAL, Math.min(milliseconds, MAX_SAMPLING_INTERVAL)), message, 2)
		this.send(message)
	}

	twoWireConfig(delayInMicroseconds: number) {
		this.#maxTwoWireDelay = Math.max(this.#maxTwoWireDelay, delayInMicroseconds)
		const message = new Uint8Array([START_SYSEX, TWO_WIRE_CONFIG, 0, 0, END_SYSEX])
		encodeByteAs7Bit(this.#maxTwoWireDelay, message, 2)
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

	twoWireWrite(address: number, data?: Readonly<NumberArray> | Buffer, addressMode: TwoWireAddressMode = 7) {
		this.twoWireReadWrite(address, 'write', data, addressMode)
	}

	twoWireStop(address: number, addressMode: TwoWireAddressMode = 7) {
		this.twoWireReadWrite(address, 'stop', undefined, addressMode)
	}

	#nextOneWireCorrelationId() {
		const correlationId = this.#oneWireCorrelationId
		this.#oneWireCorrelationId = (this.#oneWireCorrelationId + 1) & 0xffff
		return correlationId
	}

	oneWireConfig(pin: number, powerMode: OneWirePowerMode = 'normal') {
		this.send(new Uint8Array([START_SYSEX, ONE_WIRE_DATA, ONE_WIRE_CONFIG_REQUEST, pin, powerMode === 'parasitic' ? 0 : 1, END_SYSEX]))
	}

	oneWireSearch(pin: number, mode: OneWireSearchMode = 'all') {
		this.send(new Uint8Array([START_SYSEX, ONE_WIRE_DATA, mode === 'alarms' ? ONE_WIRE_SEARCH_ALARMS_REQUEST : ONE_WIRE_SEARCH_REQUEST, pin, END_SYSEX]))
	}

	oneWireCommand(pin: number, options: OneWireCommandOptions = DEFAULT_ONE_WIRE_COMMAND_OPTIONS) {
		const { reset = false, skip = false, address, bytesToRead, correlationId, delay, data } = options

		if (skip && address !== undefined) {
			throw new RangeError('One-Wire command cannot skip ROM and select ROM at the same time')
		}

		let command = 0

		if (reset) command |= ONE_WIRE_RESET_REQUEST_BIT
		if (skip) command |= ONE_WIRE_SKIP_REQUEST_BIT

		const payload: number[] = []

		if (address !== undefined) {
			if (address.length !== 8) {
				throw new RangeError(`One-Wire address must contain 8 bytes. Received ${address.length}`)
			}

			command |= ONE_WIRE_SELECT_REQUEST_BIT

			for (let i = 0; i < address.length; i++) {
				payload.push(address[i] & 0xff)
			}
		}

		let readCorrelationId: number | undefined

		if (bytesToRead !== undefined) {
			command |= ONE_WIRE_READ_REQUEST_BIT
			const n = Math.max(0, Math.min(0xffff, bytesToRead))
			readCorrelationId = (correlationId ?? this.#nextOneWireCorrelationId()) & 0xffff
			payload.push(n & 0xff, (n >>> 8) & 0xff, readCorrelationId & 0xff, (readCorrelationId >>> 8) & 0xff)
		}

		if (delay !== undefined) {
			command |= ONE_WIRE_DELAY_REQUEST_BIT
			const ms = Math.max(0, Math.min(0xffffffff, delay))
			payload.push(ms & 0xff, (ms >>> 8) & 0xff, (ms >>> 16) & 0xff, (ms >>> 24) & 0xff)
		}

		if (data !== undefined) {
			command |= ONE_WIRE_WRITE_REQUEST_BIT

			for (let i = 0; i < data.length; i++) {
				payload.push(data[i] & 0xff)
			}
		}

		const encodedData = payload.length ? encodePacked7Bit(payload) : undefined
		const message = Buffer.alloc(5 + (encodedData?.length ?? 0))

		message[0] = START_SYSEX
		message[1] = ONE_WIRE_DATA
		message[2] = command
		message[3] = pin

		if (encodedData) encodedData.copy(message, 4)

		message[message.length - 1] = END_SYSEX

		this.send(message)

		return readCorrelationId
	}

	oneWireReset(pin: number) {
		this.oneWireCommand(pin, { reset: true })
	}

	oneWireWrite(pin: number, data: Readonly<NumberArray> | Buffer, address?: Readonly<NumberArray> | Buffer) {
		this.oneWireCommand(pin, { reset: true, skip: address === undefined, address, data })
	}

	oneWireRead(pin: number, bytesToRead: number, address?: Readonly<NumberArray> | Buffer, correlationId?: number) {
		return this.oneWireCommand(pin, { reset: true, skip: address === undefined, address, bytesToRead, correlationId })
	}

	oneWireWriteAndRead(pin: number, data: Readonly<NumberArray> | Buffer, bytesToRead: number, address?: Readonly<NumberArray> | Buffer, correlationId?: number) {
		return this.oneWireCommand(pin, { reset: true, skip: address === undefined, address, bytesToRead, correlationId, data })
	}

	close() {
		this.#fsm.close()
	}
}

export class FirmataClientOverTcp extends FirmataClient {
	#socket?: Bun.Socket

	constructor(board: Board) {
		super(
			{
				write: (data, byteOffset, byteLength) => {
					this.#socket?.write(data, byteOffset, byteLength)
				},
				flush: () => {
					this.#socket?.flush()
				},
				close: () => {
					this.close()
				},
			},
			board,
		)
	}

	async connect(hostname: string, port: number, options?: Omit<Bun.TCPSocketConnectOptions<undefined>, 'hostname' | 'port' | 'socket'>) {
		if (this.#socket) return false

		this.#socket = await Bun.connect({
			...options,
			hostname,
			port,
			socket: {
				data: (_, buffer) => {
					this.process(buffer)
				},
				error: (_, error) => {
					console.error('firmata socket error:', error)
					this.reset()
				},
				connectError: (_, error) => {
					console.error('firmata connection failed:', error)
					this.reset()
				},
				end: () => {
					console.info('firmata socket ended')
					super.close()
				},
				open(socket) {
					console.info('firmata socket open at %s:%s', socket.remoteAddress, socket.localPort)
				},
				timeout() {
					console.info('firmata socket timed out')
				},
				close: (_, error) => {
					console.info('firmata socket closed:', error)
					super.close()
				},
			},
		})

		this.requestFirmware()

		return true
	}

	close() {
		this.#socket?.close()
		this.#socket = undefined
	}
}
