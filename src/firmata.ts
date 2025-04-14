import type { Socket } from 'bun'

// https://github.com/firmata/protocol/blob/master/protocol.md

export type AnalogMapping = Record<number, number>

export interface FirmataClient {
	handler: FirmataClientHandler
}

export interface FirmataClientHandler {
	readonly customMessage?: (data: Buffer, length: number) => void
	readonly version?: (major: number, minor: number) => void
	readonly firmwareMessage?: (major: number, minor: number, name: string) => void
	readonly systemReset?: () => void
	readonly error?: (command: number) => void
	readonly digitalMessage?: (pin: number, value: number) => void
	readonly analogMessage?: (portId: number, value: number) => void
	readonly pinCapability?: (pin: number, modes: Set<PinMode>) => void
	readonly pinCapabilitiesFinished?: () => void
	readonly analogMapping?: (mapping: AnalogMapping) => void
	readonly pinState?: (pin: number, mode: PinMode, value: number) => void
	readonly textMessage?: (message: string) => void
	readonly twoWireMessage?: (address: number, register: number, data: Int8Array) => void
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
	UNSUPPORTED,
	IGNORED,
}

function resolvePinMode(mode: number) {
	if (mode === PIN_MODE_IGNORE) return PinMode.IGNORED
	else if (mode >= TOTAL_PIN_MODES) return PinMode.UNSUPPORTED
	else return mode as PinMode
}

export class FirmataParser {
	constructor(private readonly fsm: FirmataFsm) {}

	parse(data: Buffer) {
		for (let i = 0; i < data.byteLength; i++) {
			this.process(data.readUInt8(i))
		}
	}

	process(b: number) {
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
const TOTAL_PIN_MODES = 13

const TWO_WIRE_WRITE = 0x00
const TWO_WIRE_READ = 0x08
const TWO_WIRE_READ_CONTINUOUS = 0x10
const TWO_WIRE_STOP_READ_CONTINUOUS = 0x18

const MIN_SAMPLING_INTERVAL = 10
const MAX_SAMPLING_INTERVAL = 100

export function decodeByteAs7Bit(data: Buffer, offset: number) {
	return ((data.readUInt8(offset + 1) & 0x01) << 7) | (data.readUInt8(offset) & 0x7f)
}

export function encodeByteAs7Bit(data: Buffer | number, offset: number) {
	const byte = typeof data === 'number' ? data : data.readUint8(offset)
	return [byte & 0x7f, (byte >>> 7) & 1] as const
}

export function decodeBufferAs7Bit(data: Buffer, offset: number = 0, length: number = data.byteLength - offset) {
	const output = Buffer.allocUnsafe(length / 2)

	for (let i = 0, k = 0; i < length; i += 2) {
		output.writeUInt8(decodeByteAs7Bit(data, offset + i), k++)
	}

	return output
}

export function encodeBufferAs7Bit(data: Buffer, offset: number = 0, length: number = data.byteLength - offset) {
	const output = Buffer.allocUnsafe(length * 2)

	for (let i = 0, k = 0; i < length; i++) {
		const [a, b] = encodeByteAs7Bit(data, offset + i)
		output.writeUInt8(a, k++)
		output.writeUInt8(b, k++)
	}

	return output
}

class ParsingVersionMessageState implements FirmataFsmState {
	process(b: number, fsm: FirmataFsm) {
		if (fsm.offset === 0) {
			fsm.write(b)
		} else {
			fsm.handler.version?.(fsm.read(0), b)
			fsm.transitTo(WAITING_FOR_MESSAGE_STATE)
		}
	}
}

const PARSING_VERSION_MESSAGE_STATE = new ParsingVersionMessageState()

class ParsingCustomSysexMessageState implements FirmataFsmState {
	process(b: number, fsm: FirmataFsm) {
		if (b === END_SYSEX) {
			fsm.handler.customMessage?.(fsm.buffer, fsm.offset)
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
			fsm.handler.firmwareMessage?.(fsm.read(0), fsm.read(1), fsm.readText(2))
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
			if (fsm.handler.analogMessage) {
				const portId = fsm.read(0)
				let value = fsm.read(1)

				for (let i = 2; i < fsm.offset; i++) {
					value = value | (fsm.read(i) << (7 * (i - 1)))
				}

				fsm.handler.analogMessage(portId, value)
			}

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
			fsm.handler.pinCapabilitiesFinished?.()
			fsm.transitTo(WAITING_FOR_MESSAGE_STATE)
		} else if (b === 127) {
			const pin = fsm.read(0)

			if (fsm.handler.pinCapability) {
				const modes = new Set<PinMode>()

				for (let i = 1; i < fsm.offset; i += 2) {
					// Every second byte contains mode's resolution of pin.
					modes.add(resolvePinMode(fsm.read(i)))
				}

				fsm.handler.pinCapability(pin, modes)
			}

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
			if (fsm.handler.analogMapping) {
				const mapping: AnalogMapping = {}

				for (let i = 0; i < fsm.offset; i++) {
					const m = fsm.read(i)
					if (m !== 127) mapping[m] = i
				}

				fsm.handler.analogMapping(mapping)
			}

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
			if (fsm.handler.pinState) {
				let value = 0

				for (let i = 2; i < fsm.offset; i++) {
					value = value | (fsm.read(i) << ((i - 2) * 7))
				}

				fsm.handler.pinState(fsm.read(0), resolvePinMode(fsm.read(1)), value)
			}

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
			fsm.handler.textMessage?.(fsm.readText())
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
			if (fsm.handler.twoWireMessage) {
				const address = fsm.read7Bit(0)
				const register = fsm.read7Bit(2)
				const data = new Int8Array((fsm.offset - 4) / 2)
				for (let i = 0; i < data.length; i++) data[i] = fsm.read7Bit(i * 2 + 4)
				fsm.handler.twoWireMessage(address, register, data)
			}

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
	process(b: number, fsm: FirmataFsm) {
		if (fsm.offset === 0) {
			fsm.write(b)
		} else if (fsm.offset === 1) {
			if (fsm.handler.digitalMessage) {
				const value = fsm.read(0) | (b << 7)
				const portId = fsm.data as number
				const pin = portId * 8

				for (let i = 0; i < 8; i++) {
					fsm.handler.digitalMessage(pin + i, (value >>> i) & 0x01)
				}
			}

			fsm.transitTo(WAITING_FOR_MESSAGE_STATE)
		}
	}
}

const PARSING_DIGITAL_MESSAGE_STATE = new ParsingDigitalMessageState()

class ParsingAnalogMessageState implements FirmataFsmState {
	process(b: number, fsm: FirmataFsm) {
		if (fsm.offset === 0) {
			fsm.write(b)
		} else if (fsm.offset === 1) {
			if (fsm.handler.analogMessage) {
				const value = fsm.read(0) | (b << 7)
				const portId = fsm.data as number
				fsm.handler.analogMessage(portId, value)
			}

			fsm.transitTo(WAITING_FOR_MESSAGE_STATE)
		}
	}
}

const PARSING_ANALOG_MESSAGE_STATE = new ParsingAnalogMessageState()

class WaitingForMessageState implements FirmataFsmState {
	process(b: number, fsm: FirmataFsm) {
		// First byte may contain not only command but additional information as well.
		const command = b < 0xf0 ? b & 0xf0 : b

		switch (command) {
			case DIGITAL_MESSAGE:
				fsm.data = b & 0x0f
				fsm.transitTo(PARSING_DIGITAL_MESSAGE_STATE)
				break
			case ANALOG_MESSAGE:
				fsm.data = b & 0x0f
				fsm.transitTo(PARSING_ANALOG_MESSAGE_STATE)
				break
			case REPORT_VERSION:
				fsm.transitTo(PARSING_VERSION_MESSAGE_STATE)
				break
			case START_SYSEX:
				fsm.transitTo(PARSING_SYSEX_MESSAGE_STATE)
				break
			case SYSTEM_RESET:
				fsm.handler.systemReset?.()
				break
			// Skip non control token.
			default:
				fsm.handler.error?.(command)
				break
		}
	}
}

const WAITING_FOR_MESSAGE_STATE = new WaitingForMessageState()

export class FirmataFsm {
	readonly buffer = Buffer.alloc(256)
	offset = 0
	data?: unknown

	constructor(
		private state: FirmataFsmState,
		readonly handler: FirmataClientHandler,
	) {}

	process(byte: number) {
		this.state.process(byte, this)
	}

	transitTo(state: FirmataFsmState) {
		this.offset = 0
		this.state = state
	}

	write(b: number) {
		this.buffer.writeUInt8(b, this.offset++)
	}

	read(offset: number) {
		return this.buffer.readUInt8(offset)
	}

	read7Bit(offset: number) {
		return decodeByteAs7Bit(this.buffer, offset)
	}

	readText(offset: number = 0, encoding?: BufferEncoding) {
		const length = this.offset - offset
		let n = 0

		for (let i = 0; i < length; i += 2, n++) {
			this.buffer.writeUInt8(this.read7Bit(offset + i), offset + n)
		}

		return this.buffer.toString(encoding, offset, offset + n)
	}
}

export class FirmataSimpleClient implements FirmataClient {
	private readonly fsm: FirmataFsm
	private readonly parser: FirmataParser

	constructor(readonly handler: FirmataClientHandler) {
		this.fsm = new FirmataFsm(WAITING_FOR_MESSAGE_STATE, handler)
		this.parser = new FirmataParser(this.fsm)
	}

	parse(data: Buffer) {
		this.parser.parse(data)
	}

	process(b: number) {
		this.parser.process(b)
	}

	reset() {
		this.fsm.transitTo(WAITING_FOR_MESSAGE_STATE)
	}
}

export class FirmataTcpClient implements FirmataClient {
	private socket?: Socket
	private readonly client: FirmataSimpleClient

	constructor(readonly handler: FirmataClientHandler) {
		this.client = new FirmataSimpleClient(handler)
	}

	async connect(hostname: string, port: number) {
		if (this.socket) return

		this.socket = await Bun.connect({
			hostname,
			port,
			socket: {
				data: (_, buffer) => {
					this.client.parse(buffer)
				},
				error: () => {
					this.client.reset()
				},
			},
		})
	}

	disconnect() {
		this.socket?.terminate()
		this.socket = undefined
		this.client.reset()
	}
}
