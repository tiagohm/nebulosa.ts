import type { FirmataClient } from './client'
import { decodeByteAs7Bit, decodePacked7Bit, decodeUnsigned7 } from './codecs/numeric'
import { decodeDhtReport, decodeEncoderPositions, decodeFrequencyReport, decodeSchedulerReply, decodeSerialReply, decodeStepperReply, decodeSystemVariableReply } from './codecs/replies'
import * as Firmata from './protocol'
import { type AnalogMapping, type FirmataClientHandler, type Pin, PinMode, type SerialPort } from './types'

// Byte-stream Firmata parser and event dispatcher. The FSM accumulates bounded SysEx
// messages and emits decoded values without owning the client handshake or transport.

// One state of the parser FSM: consumes a byte and may transition the machine.
export interface FirmataFsmState {
	readonly process: (byte: number, fsm: FirmataFsm) => void
}

// Maps a raw protocol mode byte to a PinMode while preserving future numeric mode IDs.
function resolvePinMode(mode: number): PinMode {
	if (mode === Firmata.PIN_MODE_IGNORE) return PinMode.IGNORED
	if (mode === PinMode.UNSUPPORTED) return PinMode.UNSUPPORTED
	// Keep unknown future modes by numeric identity so their resolution survives discovery.
	return mode
}

// Thin adapter feeding an incoming byte buffer into the parser FSM one byte at a time.
export class FirmataParser {
	readonly #fsm: FirmataFsm

	constructor(fsm: FirmataFsm) {
		this.#fsm = fsm
	}

	// Processes every byte of a chunk through the FSM.
	process(data: Buffer) {
		for (let i = 0; i < data.byteLength; i++) {
			this.processByte(data[i])
		}
	}

	// Processes a single byte through the FSM.
	processByte(b: number) {
		this.#fsm.process(b)
	}
}

// Parses the two-byte protocol version (major, minor) and emits a version event.
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

// Reused parser for the two-byte protocol version.
const PARSING_VERSION_MESSAGE_STATE = new ParsingVersionMessageState()

// Buffers an unrecognized sysex payload until Wire.END_SYSEX and emits it as a custom message.
class ParsingCustomSysexMessageState implements FirmataFsmState {
	process(b: number, fsm: FirmataFsm) {
		if (b === Firmata.END_SYSEX) {
			fsm.customMessage(fsm.buffer)
			fsm.transitTo(WAITING_FOR_MESSAGE_STATE)
		} else {
			fsm.write(b)
		}
	}
}

// Reused parser for unknown SysEx payloads.
const PARSING_CUSTOM_SYSEX_MESSAGE_STATE = new ParsingCustomSysexMessageState()

// Parses the firmware report (version bytes plus name) and emits a firmwareMessage event.
class ParsingFirmwareMessageState implements FirmataFsmState {
	process(b: number, fsm: FirmataFsm) {
		if (b === Firmata.END_SYSEX) {
			fsm.firmwareMessage(fsm.read(0), fsm.read(1), fsm.readText(2))
			fsm.transitTo(WAITING_FOR_MESSAGE_STATE)
		} else {
			fsm.write(b)
		}
	}
}

// Reused parser for firmware name and version.
const PARSING_FIRMWARE_MESSAGE_STATE = new ParsingFirmwareMessageState()

// Parses an extended (multi-byte) analog value for one pin and emits an analogMessage event.
class ParsingExtendedAnalogMessageState implements FirmataFsmState {
	process(b: number, fsm: FirmataFsm) {
		if (b === Firmata.END_SYSEX) {
			if (fsm.offset >= 2 && fsm.offset <= 6) fsm.analogMessage(fsm.read(0), decodeUnsigned7(fsm.buffer, 1, fsm.offset - 1))
			fsm.transitTo(WAITING_FOR_MESSAGE_STATE)
		} else {
			fsm.write(b)
		}
	}
}

// Reused parser for extended analog samples.
const PARSING_EXTENDED_ANALOG_MESSAGE_STATE = new ParsingExtendedAnalogMessageState()

// Parses the per-pin capability report (mode/resolution pairs terminated by 127), emitting a
// pinCapability event per pin and pinCapabilitiesFinished at the end.
class ParsingCapabilityResponseState implements FirmataFsmState {
	process(b: number, fsm: FirmataFsm) {
		if (b === Firmata.END_SYSEX) {
			fsm.pinCapabilitiesFinished()
			fsm.transitTo(WAITING_FOR_MESSAGE_STATE)
		} else if (b === 127) {
			const pin = fsm.offset === 0 ? 0 : fsm.read(0)

			const modes = new Set<PinMode>()
			const resolutions = new Map<PinMode, number>()

			for (let i = 1; i + 1 < fsm.offset; i += 2) {
				const mode = resolvePinMode(fsm.read(i))
				modes.add(mode)
				resolutions.set(mode, fsm.read(i + 1))
			}

			if (fsm.offset === 0 || fsm.offset % 2 === 1) fsm.pinCapability(pin, modes, resolutions)
			fsm.transitTo(this)
			fsm.write(pin + 1) // next pin at byte 0
		} else {
			if (fsm.offset === 0) fsm.write(0) // first pin is 0
			fsm.write(b)
		}
	}
}

// Reused parser for per-pin mode and resolution reports.
const PARSING_CAPABILITY_RESPONSE_STATE = new ParsingCapabilityResponseState()

// Parses the analog-mapping report (analog channel per pin, 127 = none) and emits an analogMapping event.
class ParsingAnalogMappingState implements FirmataFsmState {
	process(b: number, fsm: FirmataFsm) {
		if (b === Firmata.END_SYSEX) {
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

// Reused parser for analog-channel mapping reports.
const PARSING_ANALOG_MAPPING_STATE = new ParsingAnalogMappingState()

// Parses a pin-state response (pin, mode, multi-byte value) and emits a pinState event.
class PinStateParsingState implements FirmataFsmState {
	process(b: number, fsm: FirmataFsm) {
		if (b === Firmata.END_SYSEX) {
			if (fsm.offset >= 2 && fsm.offset <= 7) fsm.pinState(fsm.read(0), resolvePinMode(fsm.read(1)), decodeUnsigned7(fsm.buffer, 2, fsm.offset - 2))
			fsm.transitTo(WAITING_FOR_MESSAGE_STATE)
		} else {
			fsm.write(b)
		}
	}
}

// Reused parser for a pin's reported mode and value.
const PIN_STATE_PARSING_STATE = new PinStateParsingState()

// Parses a string-data sysex payload and emits a textMessage event.
class ParsingStringMessageState implements FirmataFsmState {
	process(b: number, fsm: FirmataFsm) {
		if (b === Firmata.END_SYSEX) {
			fsm.textMessage(fsm.readText())
			fsm.transitTo(WAITING_FOR_MESSAGE_STATE)
		} else {
			fsm.write(b)
		}
	}
}

// Reused parser for 7-bit-paired text messages.
const PARSING_STRING_MESSAGE_STATE = new ParsingStringMessageState()

// Parses an I2C reply (address, register, 7-bit-encoded data bytes) and emits a twoWireMessage event.
class ParsingTwoWireMessageState implements FirmataFsmState {
	process(b: number, fsm: FirmataFsm) {
		if (b === Firmata.END_SYSEX) {
			if (fsm.offset < 4) {
				fsm.transitTo(WAITING_FOR_MESSAGE_STATE)
				return
			}

			const address = fsm.read7Bit(0)
			const register = fsm.read7Bit(2)
			const size = (fsm.offset - 4) >> 1
			const data = Buffer.allocUnsafe(size)
			for (let i = 0; i < size; i++) data[i] = fsm.read7Bit(i * 2 + 4)
			fsm.twoWireMessage(address, register, data)
			fsm.transitTo(WAITING_FOR_MESSAGE_STATE)
		} else {
			fsm.write(b)
		}
	}
}

// Reused parser for I2C data replies.
const PARSING_TWO_WIRE_MESSAGE_STATE = new ParsingTwoWireMessageState()

// Parses 1-Wire replies: search/alarm results (8-byte ROM addresses) emit oneWireSearchReply; read
// results (correlation id + data) emit oneWireReadReply. Payloads are densely 7-bit packed.
class ParsingOneWireMessageState implements FirmataFsmState {
	process(b: number, fsm: FirmataFsm) {
		if (b === Firmata.END_SYSEX) {
			if (fsm.offset >= 2) {
				const command = fsm.read(0)
				const pin = fsm.read(1)

				if (command === Firmata.ONE_WIRE_SEARCH_REPLY || command === Firmata.ONE_WIRE_SEARCH_ALARMS_REPLY) {
					const data = decodePacked7Bit(fsm.buffer, 2, fsm.offset - 2)
					const addresses: Buffer[] = []

					for (let i = 0; i + 7 < data.length; i += 8) {
						addresses.push(Buffer.from(data.subarray(i, i + 8)))
					}

					fsm.oneWireSearchReply(pin, addresses, command === Firmata.ONE_WIRE_SEARCH_ALARMS_REPLY)
				} else if (command === Firmata.ONE_WIRE_READ_REPLY) {
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

// Reused parser for 1-Wire search and read replies.
const PARSING_ONE_WIRE_MESSAGE_STATE = new ParsingOneWireMessageState()

// Buffers one optional-feature payload and dispatches it only after a complete SysEx frame.
class ParsingFeatureSysexMessageState implements FirmataFsmState {
	constructor(readonly command: number) {}

	process(b: number, fsm: FirmataFsm) {
		if (b === Firmata.END_SYSEX) {
			fsm.featureReply(this.command, fsm.buffer)
			fsm.transitTo(WAITING_FOR_MESSAGE_STATE)
		} else if (b >= 128) {
			// SysEx data must be seven-bit. A new command also recovers from a
			// missing terminator without swallowing the next frame.
			fsm.transitTo(WAITING_FOR_MESSAGE_STATE)
			WAITING_FOR_MESSAGE_STATE.process(b, fsm)
		} else {
			fsm.write(b)
		}
	}
}

// Shared parsers for optional SysEx feature replies, keyed by their command byte.
const FEATURE_STATES = new Map<number, FirmataFsmState>(
	[Firmata.SYSTEM_VARIABLE, Firmata.SPI_DATA, Firmata.SERIAL_MESSAGE, Firmata.ENCODER_DATA, Firmata.ACCELSTEPPER_DATA, Firmata.DHTSENSOR_DATA, Firmata.SAMPLING_INTERVAL, Firmata.SCHEDULER_DATA, Firmata.FREQUENCY_COMMAND].map((command) => [command, new ParsingFeatureSysexMessageState(command)]),
)

// Dispatches the first byte after Wire.START_SYSEX to the matching sub-parser state, falling back to the
// custom-sysex parser for unknown commands.
class ParsingSysexMessageState implements FirmataFsmState {
	process(b: number, fsm: FirmataFsm) {
		let next: FirmataFsmState | undefined

		if (b === Firmata.REPORT_FIRMWARE) next = PARSING_FIRMWARE_MESSAGE_STATE
		else if (b === Firmata.EXTENDED_ANALOG) next = PARSING_EXTENDED_ANALOG_MESSAGE_STATE
		else if (b === Firmata.CAPABILITY_RESPONSE) next = PARSING_CAPABILITY_RESPONSE_STATE
		else if (b === Firmata.ANALOG_MAPPING_RESPONSE) next = PARSING_ANALOG_MAPPING_STATE
		else if (b === Firmata.PIN_STATE_RESPONSE) next = PIN_STATE_PARSING_STATE
		else if (b === Firmata.STRING_DATA) next = PARSING_STRING_MESSAGE_STATE
		else if (b === Firmata.TWO_WIRE_REPLY) next = PARSING_TWO_WIRE_MESSAGE_STATE
		else if (b === Firmata.ONE_WIRE_DATA) next = PARSING_ONE_WIRE_MESSAGE_STATE
		else next = FEATURE_STATES.get(b)

		if (!next) {
			const state = PARSING_CUSTOM_SYSEX_MESSAGE_STATE
			fsm.transitTo(state)
			state.process(b, fsm)
		} else {
			fsm.transitTo(next)
		}
	}
}

// Reused dispatcher for the first byte of each SysEx frame.
const PARSING_SYSEX_MESSAGE_STATE = new ParsingSysexMessageState()

// Parses a digital port message (one bit per pin in an 8-pin port) and emits a digitalMessage per pin.
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

// Parses a two-byte analog channel value and emits an analogMessage event.
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

// Idle FSM state: classifies the leading command byte and transitions to the matching parser, or emits
// systemReset/error for control tokens.
class WaitingForMessageState implements FirmataFsmState {
	process(b: number, fsm: FirmataFsm) {
		// First byte may contain not only command but additional information as well.
		const command = b < 0xf0 ? b & 0xf0 : b

		switch (command) {
			case Firmata.DIGITAL_MESSAGE:
				fsm.transitTo(new ParsingDigitalMessageState(b & 0x0f))
				break
			case Firmata.ANALOG_MESSAGE:
				fsm.transitTo(new ParsingAnalogMessageState(b & 0x0f))
				break
			case Firmata.REPORT_VERSION:
				fsm.transitTo(PARSING_VERSION_MESSAGE_STATE)
				break
			case Firmata.START_SYSEX:
				fsm.transitTo(PARSING_SYSEX_MESSAGE_STATE)
				break
			case Firmata.SYSTEM_RESET:
				fsm.systemReset()
				break
			// Skip non control token.
			default:
				fsm.error(command)
				break
		}
	}
}

// Idle state shared by clients and used when resetting their parsers.
export const WAITING_FOR_MESSAGE_STATE = new WaitingForMessageState()

// Discards an oversized sysex message until its terminator, then returns the parser to the idle state.
class DiscardingSysexMessageState implements FirmataFsmState {
	process(b: number, fsm: FirmataFsm) {
		if (b === Firmata.END_SYSEX) fsm.transitTo(WAITING_FOR_MESSAGE_STATE)
	}
}

// Reused discard state for frames above the parser's capacity.
const DISCARDING_SYSEX_MESSAGE_STATE = new DiscardingSysexMessageState()

// The parser state machine: holds the active state, a scratch byte buffer, and the set of handlers.
// Parser states call its write/read helpers to accumulate bytes and its event methods to broadcast a
// decoded message to every registered handler.
export class FirmataFsm {
	readonly #handlers = new Set<FirmataClientHandler>()

	// Scratch accumulation buffer for the message currently being parsed, and the write cursor into it.
	#buffer = Buffer.alloc(Firmata.INITIAL_FIRMATA_BUFFER_SIZE)
	#offset = 0
	#state: FirmataFsmState

	constructor(
		state: FirmataFsmState,
		readonly client: FirmataClient,
	) {
		this.#state = state
	}

	// Number of bytes accumulated for the current message.
	get offset() {
		return this.#offset
	}

	// View of the bytes accumulated so far for the current message.
	get buffer() {
		return this.#buffer.subarray(0, this.#offset)
	}

	// Registers/unregisters an event handler.
	addHandler(handler: FirmataClientHandler) {
		this.#handlers.add(handler)
	}

	removeHandler(handler: FirmataClientHandler) {
		this.#handlers.delete(handler)
	}

	// Feeds one byte into the active state.
	process(byte: number) {
		this.#state.process(byte, this)
	}

	// Switches to a new state and resets the accumulation cursor.
	transitTo(state: FirmataFsmState) {
		this.#offset = 0
		this.#state = state
	}

	// Appends one byte to the accumulation buffer.
	write(b: number) {
		if (this.#offset >= this.#buffer.length) {
			if (this.#buffer.length >= Firmata.MAX_FIRMATA_BUFFER_SIZE) {
				this.transitTo(DISCARDING_SYSEX_MESSAGE_STATE)
				return
			}

			const size = Math.min(this.#buffer.length * 2, Firmata.MAX_FIRMATA_BUFFER_SIZE)
			const buffer = Buffer.alloc(size)
			this.#buffer.copy(buffer)
			this.#buffer = buffer
		}

		this.#buffer.writeUInt8(b, this.#offset++)
	}

	// Reads the raw byte at an offset in the accumulation buffer.
	read(offset: number) {
		return this.#buffer.readUInt8(offset)
	}

	// Reads a value stored as two 7-bit bytes at an offset.
	read7Bit(offset: number) {
		return decodeByteAs7Bit(this.#buffer, offset)
	}

	// Decodes a 7-bit-encoded text payload (two wire bytes per character) into a string in place.
	readText(offset: number = 0, encoding?: BufferEncoding) {
		const length = this.#offset - offset
		let n = 0

		for (let i = 0; i < length; i += 2, n++) {
			this.#buffer.writeUInt8(this.read7Bit(offset + i), offset + n)
		}

		return this.#buffer.toString(encoding, offset, offset + n)
	}

	// Event broadcasters: each forwards a decoded message to every registered handler.
	ready() {
		for (const handler of this.#handlers) handler.ready?.(this.client)
	}

	pinChange(pin: Pin) {
		for (const handler of this.#handlers) handler.pinChange?.(this.client, pin)
	}

	customMessage(data: Buffer) {
		for (const handler of this.#handlers) handler.customMessage?.(this.client, data)
	}

	version(major: number, minor: number) {
		for (const handler of this.#handlers) handler.version?.(this.client, major, minor)
	}

	firmwareMessage(major: number, minor: number, name: string) {
		for (const handler of this.#handlers) handler.firmwareMessage?.(this.client, major, minor, name)
	}

	systemReset() {
		for (const handler of this.#handlers) handler.systemReset?.(this.client)
	}

	error(command: number) {
		for (const handler of this.#handlers) handler.error?.(this.client, command)
	}

	digitalMessage(id: number, value: number) {
		for (const handler of this.#handlers) handler.digitalMessage?.(this.client, id, value)
	}

	analogMessage(port: number, value: number) {
		for (const handler of this.#handlers) handler.analogMessage?.(this.client, port, value)
	}

	pinCapability(id: number, modes: Set<PinMode>, resolutions: ReadonlyMap<PinMode, number>) {
		for (const handler of this.#handlers) handler.pinCapability?.(this.client, id, modes, resolutions)
	}

	pinCapabilitiesFinished() {
		for (const handler of this.#handlers) handler.pinCapabilitiesFinished?.(this.client)
	}

	analogMapping(mapping: AnalogMapping) {
		for (const handler of this.#handlers) handler.analogMapping?.(this.client, mapping)
	}

	pinState(id: number, mode: PinMode, value: number) {
		for (const handler of this.#handlers) handler.pinState?.(this.client, id, mode, value)
	}

	textMessage(message: string) {
		for (const handler of this.#handlers) handler.textMessage?.(this.client, message)
	}

	twoWireMessage(address: number, register: number, data: Buffer) {
		for (const handler of this.#handlers) handler.twoWireMessage?.(this.client, address, register, data)
	}

	oneWireSearchReply(pin: number, addresses: readonly Buffer[], alarms: boolean) {
		for (const handler of this.#handlers) handler.oneWireSearchReply?.(this.client, pin, addresses, alarms)
	}

	oneWireReadReply(pin: number, correlationId: number, data: Buffer) {
		for (const handler of this.#handlers) handler.oneWireReadReply?.(this.client, pin, correlationId, data)
	}

	// Validates optional-feature reply framing and broadcasts a typed event when complete.
	featureReply(command: number, payload: Buffer) {
		if (command === Firmata.SAMPLING_INTERVAL) {
			if (payload.length === 2) for (const handler of this.#handlers) handler.samplingIntervalReply?.(this.client, decodeUnsigned7(payload, 0, 2))
		} else if (command === Firmata.SYSTEM_VARIABLE) {
			const reply = decodeSystemVariableReply(payload)
			if (reply) for (const handler of this.#handlers) handler.systemVariableReply?.(this.client, reply)
		} else if (command === Firmata.SPI_DATA) {
			const reply = this.client.parseSpiReply(payload)
			if (reply) for (const handler of this.#handlers) handler.spiReply?.(this.client, reply)
		} else if (command === Firmata.SERIAL_MESSAGE) {
			const reply = decodeSerialReply(payload)
			if (reply) for (const handler of this.#handlers) handler.serialReply?.(this.client, reply.port as SerialPort, reply.data)
		} else if (command === Firmata.ENCODER_DATA) {
			const positions = decodeEncoderPositions(payload)
			if (positions) for (const handler of this.#handlers) handler.encoderPositions?.(this.client, positions)
		} else if (command === Firmata.ACCELSTEPPER_DATA) {
			const reply = decodeStepperReply(payload)
			if (reply && 'group' in reply) for (const handler of this.#handlers) handler.multiStepperComplete?.(this.client, reply.group)
			else if (reply) for (const handler of this.#handlers) handler.stepperPosition?.(this.client, reply)
		} else if (command === Firmata.DHTSENSOR_DATA) {
			const reply = decodeDhtReport(payload)
			if (reply) for (const handler of this.#handlers) handler.dhtReport?.(this.client, reply)
		} else if (command === Firmata.SCHEDULER_DATA) {
			const reply = decodeSchedulerReply(payload)
			if (reply && 'ids' in reply) for (const handler of this.#handlers) handler.schedulerTasks?.(this.client, reply.ids)
			else if (reply) for (const handler of this.#handlers) handler.schedulerTask?.(this.client, reply)
		} else if (command === Firmata.FREQUENCY_COMMAND) {
			const reply = decodeFrequencyReport(payload)
			if (reply) for (const handler of this.#handlers) handler.frequencyReport?.(this.client, reply)
		}
	}

	close() {
		for (const handler of this.#handlers) handler.close?.(this.client)
	}
}
