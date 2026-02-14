// https://github.com/firmata/protocol/blob/master/protocol.md

export type AnalogMapping = Record<number, number>

export interface Transport {
	readonly write: (data: string | ArrayBufferLike | NodeJS.TypedArray<ArrayBufferLike> | DataView<ArrayBufferLike>, byteOffset?: number, byteLength?: number) => void
	readonly close: () => void
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

	readonly customMessage?: (client: FirmataClient, data: Buffer, length: number) => void
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
	readonly twoWireMessage?: (client: FirmataClient, address: number, register: number, data: Int8Array) => void
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

	process(data: Buffer) {
		for (let i = 0; i < data.byteLength; i++) {
			this.processByte(data.readUInt8(i))
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
	const byte = typeof data === 'number' ? data : data.readUInt8(offset)
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
			fsm.version(fsm.read(0), b)
			fsm.transitTo(WAITING_FOR_MESSAGE_STATE)
		}
	}
}

const PARSING_VERSION_MESSAGE_STATE = new ParsingVersionMessageState()

class ParsingCustomSysexMessageState implements FirmataFsmState {
	process(b: number, fsm: FirmataFsm) {
		if (b === END_SYSEX) {
			fsm.customMessage(fsm.buffer, fsm.offset)
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
			const data = new Int8Array((fsm.offset - 4) / 2)
			for (let i = 0; i < data.length; i++) data[i] = fsm.read7Bit(i * 2 + 4)
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
	process(b: number, fsm: FirmataFsm) {
		if (fsm.offset === 0) {
			fsm.write(b)
		} else if (fsm.offset === 1) {
			const value = fsm.read(0) | (b << 7)
			const portId = fsm.data as number
			const pin = portId * 8

			for (let i = 0; i < 8; i++) {
				fsm.digitalMessage(pin + i, (value >>> i) & 0x01)
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
			const value = fsm.read(0) | (b << 7)
			const portId = fsm.data as number
			fsm.analogMessage(portId, value)

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
	readonly buffer = Buffer.alloc(256)
	readonly handlers = new Set<FirmataClientHandler>()

	offset = 0
	data?: unknown

	constructor(
		private state: FirmataFsmState,
		readonly client: FirmataClient,
	) {}

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

	ready() {
		this.handlers.forEach((handler) => handler.ready?.(this.client))
	}

	pinChange(pin: Pin) {
		this.handlers.forEach((handler) => handler.pinChange?.(this.client, pin))
	}

	customMessage(data: Buffer, length: number) {
		this.handlers.forEach((handler) => handler.customMessage?.(this.client, data, length))
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

	twoWireMessage(address: number, register: number, data: Int8Array) {
		this.handlers.forEach((handler) => handler.twoWireMessage?.(this.client, address, register, data))
	}
}

// Writes a 14-bit value as two 7-bit bytes.
export function writeValueAsTwo7bitBytes(data: Uint8Array, offset: number, value: number) {
	data[offset] = value & 0x7f
	data[offset + 1] = (value >> 7) & 0x7f
}

export class FirmataClient {
	private readonly fsm: FirmataFsm
	private readonly parser: FirmataParser

	private initializing = true
	private readonly pinStateRequestQueue: number[] = []
	private readonly pinMap = new Map<number, Pin>()
	private readonly analogPins: AnalogMapping = {}

	private readonly handler: FirmataClientHandler = {
		customMessage: (client: FirmataClient, data: Buffer, length: number) => {
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

		twoWireMessage: (client: FirmataClient, address: number, register: number, data: Int8Array) => {
			//
		},
	}

	constructor(private readonly transport: Transport) {
		this.fsm = new FirmataFsm(WAITING_FOR_MESSAGE_STATE, this)
		this.parser = new FirmataParser(this.fsm)
		this.addHandler(this.handler)
	}

	get pinCount() {
		return this.pinMap.size
	}

	get pins(): Readonly<Pin>[] {
		return [...this.pinMap.values()]
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

	reset() {
		this.fsm.transitTo(WAITING_FOR_MESSAGE_STATE)
	}

	send(data: string | ArrayBufferLike | NodeJS.TypedArray<ArrayBufferLike> | DataView<ArrayBufferLike>, byteOffset?: number, byteLength?: number) {
		this.transport.write(data)
	}

	requestFirmware() {
		this.send(new Uint8Array([START_SYSEX, REPORT_FIRMWARE, END_SYSEX]))
	}

	requestPinCapability() {
		this.send(new Uint8Array([START_SYSEX, CAPABILITY_QUERY, END_SYSEX]))
	}

	requestPinState(pinId: number) {
		this.send(new Uint8Array([START_SYSEX, PIN_STATE_QUERY, pinId, END_SYSEX]))
	}

	requestAnalogMapping() {
		this.send(new Uint8Array([START_SYSEX, ANALOG_MAPPING_QUERY, END_SYSEX]))
	}

	requestDigitalReport(enable: boolean) {
		const data = new Uint8Array(32)

		for (let i = 0; i < 16; i += 2) {
			data[i] = REPORT_DIGITAL | i
			data[i + 1] = enable ? 1 : 0
		}

		this.send(data)
	}

	requestDigitalPinReport(pin: Pin | number, enable: boolean, pinToDigital: (pin: Pin | number) => number) {
		this.send(new Uint8Array([REPORT_DIGITAL | pinToDigital(pin), enable ? 1 : 0]))
	}

	requestAnalogReport(enable: boolean) {
		const data = new Uint8Array(32)

		for (let i = 0; i < 16; i += 2) {
			data[i] = REPORT_ANALOG | i
			data[i + 1] = enable ? 1 : 0
		}

		this.send(data)
	}

	requestAnalogPinReport(pin: Pin | number, enable: boolean, pinToAnalog: (pin: Pin | number) => number) {
		this.send(new Uint8Array([REPORT_ANALOG | pinToAnalog(pin), enable ? 1 : 0]))
	}

	pinMode(pinId: number, mode: PinMode) {
		this.send(new Uint8Array([SET_PIN_MODE, pinId, mode]))
	}

	digitalWrite(pinId: number, value: boolean | number) {
		this.send(new Uint8Array([DIGITAL_MESSAGE | (pinId & 0x0f), value ? 1 : 0, 0]))
	}
}

export class FirmataClientOverTcp extends FirmataClient {
	private socket?: Bun.Socket

	constructor() {
		super({
			write: (data) => {
				this.socket?.write(data)
			},
			close: () => {
				this.socket?.close()
				this.socket = undefined
			},
		})
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

function pinId(pin: Pin | number) {
	return typeof pin === 'number' ? pin : pin.id
}

// https://github.com/firmata/arduino/blob/main/Boards.h#L998

export namespace ESP8266 {
	export const D0 = 16
	export const D1 = 5
	export const D2 = 4
	export const D3 = 0
	export const D4 = 2
	export const D5 = 14
	export const D6 = 12
	export const D7 = 13
	export const D8 = 15
	export const D9 = 3
	export const D10 = 1

	export const A0 = 17

	export const SDA = D2
	export const SCL = D1

	export const RX = D9
	export const TX = D10

	export const SS = D8
	export const MOSI = D7
	export const MISO = D6
	export const SCK = D5

	export const MAX_SERVOS = 9

	export const LED_BUILTIN = D4
	export const LED_BUILTIN_AUX = D0

	export const NUMBER_OF_DIGITAL_PINS = 17
	export const NUMBER_OF_ANALOG_PINS = 1

	export function isPinLED(pin: Pin | number) {
		const id = pinId(pin)
		return id === LED_BUILTIN || id === LED_BUILTIN_AUX
	}

	export function isPinDigital(pin: Pin | number) {
		const id = pinId(pin)
		return (id >= D3 && id <= D1) || (id >= D6 && id < A0)
	}

	export function isPinAnalog(pin: Pin | number) {
		return pinId(pin) === A0
	}

	export function isPinPWM(pin: Pin | number) {
		return pinId(pin) < A0
	}

	export function isPinServo(pin: Pin | number) {
		return isPinDigital(pin) && pinId(pin) < MAX_SERVOS
	}

	export function isPinTwoWire(pin: Pin | number) {
		const id = pinId(pin)
		return id === SDA || id === SCL
	}

	export function isPinSPI(pin: Pin | number) {
		const id = pinId(pin)
		return id === SS || id === MOSI || id === MISO || id === SCK
	}

	export function isPinSerial(pin: Pin | number) {
		const id = pinId(pin)
		return id === RX || id === TX
	}

	export function pinToDigital(pin: Pin | number) {
		return pinId(pin)
	}

	export function pinToAnalog(pin: Pin | number) {
		return pinId(pin) - A0
	}

	export function pinToPWM(pin: Pin | number) {
		return pinToDigital(pin)
	}

	export function pinToServo(pin: Pin | number) {
		return pinId(pin)
	}
}
