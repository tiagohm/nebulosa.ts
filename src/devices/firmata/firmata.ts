import type { NumberArray } from '../../math/numerical/math'
import { decodePacked7Bit, decodeUnsigned7, encodePacked7Bit, encodeSigned32, encodeStepperFloat, encodeStepperPosition, encodeUnsigned7 } from './codecs/numeric'
import { decodeDhtReport, decodeEncoderPositions, decodeFrequencyReport, decodeSchedulerReply, decodeSerialReply, decodeStepperReply, decodeSystemVariableReply, type DhtReport, type EncoderPosition, type FrequencyReport, type SchedulerTaskReply, type StepperPosition, type SystemVariableReply } from './codecs/replies'
import { decodeSpiReply, encodeSpiConfig, encodeSpiWords, spiSelector, type SpiChannel, type SpiDeviceOptions, type SpiReply } from './codecs/spi'

export { decodePacked7Bit, encodePacked7Bit } from './codecs/numeric'
export type { DhtReport, EncoderPosition, FrequencyReport, SchedulerTaskReply, StepperPosition, SystemVariableReply } from './codecs/replies'
export type { SpiChannel, SpiDataMode, SpiDeviceOptions, SpiReply } from './codecs/spi'

// Firmata protocol implementation: a byte-stream state machine that parses incoming Firmata and sysex
// messages, and a FirmataClient that encodes pin, bus, motion, sensor, timing, and system commands over a
// pluggable transport. Protocol codecs own the 7-bit wire formats and allocate decoded reply values.
// https://github.com/firmata/protocol/blob/master/protocol.md

// Mapping from analog channel index to its underlying pin id, as reported by the board.
export type AnalogMapping = Record<number, number>

// Whether an I2C transaction releases the bus ('stop') or issues a repeated start ('restart').
export type TwoWireAutoRestartMode = 'stop' | 'restart'

// I2C address width in bits.
export type TwoWireAddressMode = 7 | 10

// I2C transaction kind selecting the two-wire request sub-command.
export type TwoWireOperationMode = 'write' | 'read' | 'readContinuously' | 'stop'

// 1-Wire bus power scheme: externally powered ('normal') or parasitic.
export type OneWirePowerMode = 'normal' | 'parasitic'

// 1-Wire search scope: all devices or only those signalling an alarm.
export type OneWireSearchMode = 'all' | 'alarms'

// Options assembling a single 1-Wire command (reset/skip/select prefixes, optional write/read/delay).
export interface OneWireCommandOptions {
	// Issue a bus reset before the command.
	readonly reset?: boolean
	// Use SKIP ROM instead of addressing a specific device.
	readonly skip?: boolean
	// 8-byte ROM address to SELECT (when not skipping).
	readonly address?: Readonly<NumberArray> | Buffer
	// Number of bytes to read after the write.
	readonly bytesToRead?: number
	// Correlation id echoed in the read reply.
	readonly correlationId?: number
	// Microsecond delay inserted before reading.
	readonly delay?: number
	// Bytes to write to the bus.
	readonly data?: Readonly<NumberArray> | Buffer
}

// Byte-stream transport abstraction (TCP, serial, etc.) used to send/receive Firmata bytes.
export interface Transport {
	// Writes `data` to the board; byte offset and length select a source-buffer slice.
	readonly write: (data: string | Bun.BufferSource, byteOffset?: number, byteLength?: number) => void
	// Flushes bytes queued by `write` to the underlying connection.
	readonly flush: () => void
	// Closes the underlying connection and releases its resources.
	readonly close: () => void
}

// Board capability description: pin-classification predicates and per-mode channel-index conversions.
export interface Board {
	// Human-readable board model name.
	readonly name: string
	// Whether physical `pin` drives a board LED.
	readonly isPinLED: (pin: number) => boolean
	// Whether physical `pin` supports digital input or output.
	readonly isPinDigital: (pin: number) => boolean
	// Whether physical `pin` supports an analog input channel.
	readonly isPinAnalog: (pin: number) => boolean
	// Whether physical `pin` supports pulse-width-modulated output.
	readonly isPinPWM: (pin: number) => boolean
	// Whether physical `pin` supports servo output.
	readonly isPinServo: (pin: number) => boolean
	// Whether physical `pin` belongs to an I2C bus.
	readonly isPinTwoWire: (pin: number) => boolean
	// Whether physical `pin` belongs to an SPI bus.
	readonly isPinSPI: (pin: number) => boolean
	// Whether physical `pin` belongs to a hardware UART.
	readonly isPinSerial: (pin: number) => boolean
	// Converts physical `pin` to its digital channel number.
	readonly pinToDigital: (pin: number) => number
	// Converts physical `pin` to its analog input channel number.
	readonly pinToAnalog: (pin: number) => number
	// Converts physical `pin` to its PWM output identifier.
	readonly pinToPWM: (pin: number) => number
	// Converts physical `pin` to its servo output identifier.
	readonly pinToServo: (pin: number) => number
}

// Runtime state of one board pin: its id, supported modes, current mode, and last value.
export interface Pin {
	// Physical pin identifier reported by the board, starting at zero.
	readonly id: number
	// Supported pin modes discovered from the capability response.
	readonly modes: Set<PinMode>
	// Resolution or feature-specific capability value for each supported mode.
	readonly resolutions: ReadonlyMap<PinMode, number>
	// Current mode reported by the board or assigned by `pinMode`.
	mode: PinMode
	// Last raw value reported by the board, in that mode's units.
	value: number
}

// Serial 1.0 hardware ports 0-7 and software ports 8-15.
export type SerialPort = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15

// DHT sensor variants supported by the Firmata DHT feature.
export type DhtModel = 'dht11' | 'dht22'

// Shared AccelStepper pins and optional enable/inversion controls.
interface StepperConfigBase {
	// Motor number, 0-9.
	readonly device: number
	// First motor or step pin, 0-127.
	readonly pin1: number
	// Second motor or direction pin, 0-127.
	readonly pin2: number
	// Optional driver-enable pin, 0-127.
	readonly enablePin?: number
	// Pin-inversion mask: bits 0-3 motor pins, bit 4 enable pin.
	readonly invertPins?: number
}

// AccelStepper interface choice with its exact number of required motor pins.
export type StepperConfig = StepperConfigBase &
	(
		| {
				// Driver or two-wire motor requiring only pin1 and pin2.
				readonly interface: 'driver' | 'twoWire'
				// These interfaces do not select a step size in the bundled firmware.
				readonly stepType?: never
		  }
		| {
				// Three-wire motor requiring one additional physical pin.
				readonly interface: 'threeWire'
				// Whole (0) or half (1) steps; other values have no firmware constructor.
				readonly stepType?: 0 | 1
				// Third motor pin, 0-127.
				readonly pin3: number
		  }
		| {
				// Four-wire motor requiring two additional physical pins.
				readonly interface: 'fourWire'
				// Whole (0) or half (1) steps; other values have no firmware constructor.
				readonly stepType?: 0 | 1
				// Third motor pin, 0-127.
				readonly pin3: number
				// Fourth motor pin, 0-127.
				readonly pin4: number
		  }
	)

// Optional callbacks for Firmata events. Every method is optional so handlers subscribe only to the
// messages they care about; each receives the originating client. Mirrors the protocol message set.
export interface FirmataClientHandler {
	// Called once after the firmware, capability, pin-state and analog-mapping handshake.
	readonly ready?: (client: FirmataClient) => void
	// Updated cached pin state after a reported value changes; `pin` aliases client state.
	readonly pinChange?: (client: FirmataClient, pin: Pin) => void

	// Unrecognized SysEx bytes including the feature ID; data aliases parser scratch storage.
	readonly customMessage?: (client: FirmataClient, data: Buffer) => void
	// Protocol major and minor version from REPORT_VERSION.
	readonly version?: (client: FirmataClient, major: number, minor: number) => void
	// Firmware major/minor version and decoded name from REPORT_FIRMWARE.
	readonly firmwareMessage?: (client: FirmataClient, major: number, minor: number, name: string) => void
	// SYSTEM_RESET notification received from the board.
	readonly systemReset?: (client: FirmataClient) => void
	// Unrecognized command byte encountered by the parser outside a SysEx frame.
	readonly error?: (client: FirmataClient, command: number) => void
	// Digital pin ID and latest logic level (zero or one).
	readonly digitalMessage?: (client: FirmataClient, id: number, value: number) => void
	// Analog channel number and latest unsigned sample in the board's ADC units.
	readonly analogMessage?: (client: FirmataClient, port: number, value: number) => void
	// Pin ID, supported mode set and per-mode resolution or feature-specific capability.
	readonly pinCapability?: (client: FirmataClient, id: number, modes: Set<PinMode>, resolutions: ReadonlyMap<PinMode, number>) => void
	// End of the per-pin capability response, after the final pin event.
	readonly pinCapabilitiesFinished?: (client: FirmataClient) => void
	// Analog-channel-to-pin mapping discovered from ANALOG_MAPPING_RESPONSE.
	readonly analogMapping?: (client: FirmataClient, mapping: AnalogMapping) => void
	// Pin ID, current mode and raw signed/unsigned state value returned by PIN_STATE_RESPONSE.
	readonly pinState?: (client: FirmataClient, id: number, mode: PinMode, value: number) => void
	// UTF-8 text decoded from STRING_DATA.
	readonly textMessage?: (client: FirmataClient, message: string) => void
	// I2C device address, register number and newly allocated reply bytes.
	readonly twoWireMessage?: (client: FirmataClient, address: number, register: number, data: Buffer) => void
	// 1-Wire pin, ROM addresses and whether this was an alarm search.
	readonly oneWireSearchReply?: (client: FirmataClient, pin: number, addresses: readonly Buffer[], alarms: boolean) => void
	// 1-Wire pin, read correlation ID and returned data bytes.
	readonly oneWireReadReply?: (client: FirmataClient, pin: number, correlationId: number, data: Buffer) => void
	// Current sampling interval in milliseconds after a 0x7c query.
	readonly samplingIntervalReply?: (client: FirmataClient, milliseconds: number) => void
	// System-variable query/set result and firmware status.
	readonly systemVariableReply?: (client: FirmataClient, reply: SystemVariableReply) => void
	// SPI reply with device and request identifiers for asynchronous correlation.
	readonly spiReply?: (client: FirmataClient, reply: SpiReply) => void
	// Bytes received from a Serial 1.0 hardware/software port.
	readonly serialReply?: (client: FirmataClient, port: SerialPort, data: Buffer) => void
	// Single or batched encoder positions in reported order.
	readonly encoderPositions?: (client: FirmataClient, positions: readonly EncoderPosition[]) => void
	// Motor position after a query or completed move.
	readonly stepperPosition?: (client: FirmataClient, report: StepperPosition) => void
	// Completion notification for a coordinated MultiStepper group.
	readonly multiStepperComplete?: (client: FirmataClient, group: number) => void
	// DHT temperature in degrees Celsius and humidity in percent.
	readonly dhtReport?: (client: FirmataClient, report: DhtReport) => void
	// Identifiers of all currently registered scheduler tasks.
	readonly schedulerTasks?: (client: FirmataClient, ids: readonly number[]) => void
	// Scheduler task query or execution error.
	readonly schedulerTask?: (client: FirmataClient, reply: SchedulerTaskReply) => void
	// Raw timestamp in milliseconds and accumulated edge count, both unsigned 32-bit.
	readonly frequencyReport?: (client: FirmataClient, report: FrequencyReport) => void

	// Transport closure; the client resets its local handshake state after notification.
	readonly close?: (client: FirmataClient) => void
}

// One state of the parser FSM: consumes a byte and may transition the machine.
export interface FirmataFsmState {
	readonly process: (byte: number, fsm: FirmataFsm) => void
}

// Firmata pin modes (values match the protocol). Unknown future numeric modes retain their value;
// UNSUPPORTED and IGNORED are explicit sentinels.
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
	FREQUENCY,
	UNSUPPORTED = 126,
	IGNORED = 127,
}

// Default 1-Wire command options: no reset, address a specific device (no skip).
export const DEFAULT_ONE_WIRE_COMMAND_OPTIONS: OneWireCommandOptions = {
	reset: false,
	skip: false,
}

// PROTOCOL

// Maps a raw protocol mode byte to a PinMode while preserving future numeric mode IDs.
function resolvePinMode(mode: number): PinMode {
	if (mode === PIN_MODE_IGNORE) return PinMode.IGNORED
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
// AccelStepper and MultiStepper command/reply family.
const ACCELSTEPPER_DATA = 0x62
// Report an analog sample wider than the standard 14-bit command.
const EXTENDED_REPORT_ANALOG = 0x64
// Query or set a typed firmware system variable.
const SYSTEM_VARIABLE = 0x66
// Configure and exchange SPI words with selected devices.
const SPI_DATA = 0x68
const SERVO_CONFIG = 0x70
const STRING_DATA = 0x71
const ONE_WIRE_DATA = 0x73
// Attach, detach and report DHT humidity/temperature sensors.
const DHTSENSOR_DATA = 0x74
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
// Query the current firmware sampling interval.
const SAMPLING_INTERVAL_QUERY = 0x7c
// Configure and report raw frequency counter samples.
const FREQUENCY_COMMAND = 0x7d
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
// Initial and maximum wire-payload sizes retained by the parser for one message, in bytes. Larger
// sysex messages are discarded until END_SYSEX so malformed or unexpectedly large input cannot grow
// memory without bound.
const INITIAL_FIRMATA_BUFFER_SIZE = 256
const MAX_FIRMATA_BUFFER_SIZE = 1 << 20

// Decodes one byte from the two-7-bit-bytes layout (LSB nibble then MSB bit) at `offset`.
export function decodeByteAs7Bit(input: Readonly<NumberArray> | Buffer, offset: number) {
	return (input[offset] & 0x7f) | ((input[offset + 1] & 0x01) << 7)
}

// Encodes one byte as two 7-bit bytes (low 7 bits, then bit 7) into `output` at `offset`.
export function encodeByteAs7Bit(data: number, output: NumberArray | Buffer, offset: number = 0) {
	output[offset++] = data & 0x7f
	output[offset] = (data >>> 7) & 1
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

const PARSING_VERSION_MESSAGE_STATE = new ParsingVersionMessageState()

// Buffers an unrecognized sysex payload until END_SYSEX and emits it as a custom message.
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

// Parses the firmware report (version bytes plus name) and emits a firmwareMessage event.
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

// Parses an extended (multi-byte) analog value for one pin and emits an analogMessage event.
class ParsingExtendedAnalogMessageState implements FirmataFsmState {
	process(b: number, fsm: FirmataFsm) {
		if (b === END_SYSEX) {
			if (fsm.offset >= 2 && fsm.offset <= 6) fsm.analogMessage(fsm.read(0), decodeUnsigned7(fsm.buffer, 1, fsm.offset - 1))
			fsm.transitTo(WAITING_FOR_MESSAGE_STATE)
		} else {
			fsm.write(b)
		}
	}
}

const PARSING_EXTENDED_ANALOG_MESSAGE_STATE = new ParsingExtendedAnalogMessageState()

// Parses the per-pin capability report (mode/resolution pairs terminated by 127), emitting a
// pinCapability event per pin and pinCapabilitiesFinished at the end.
class ParsingCapabilityResponseState implements FirmataFsmState {
	process(b: number, fsm: FirmataFsm) {
		if (b === END_SYSEX) {
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

const PARSING_CAPABILITY_RESPONSE_STATE = new ParsingCapabilityResponseState()

// Parses the analog-mapping report (analog channel per pin, 127 = none) and emits an analogMapping event.
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

// Parses a pin-state response (pin, mode, multi-byte value) and emits a pinState event.
class PinStateParsingState implements FirmataFsmState {
	process(b: number, fsm: FirmataFsm) {
		if (b === END_SYSEX) {
			if (fsm.offset >= 2 && fsm.offset <= 7) fsm.pinState(fsm.read(0), resolvePinMode(fsm.read(1)), decodeUnsigned7(fsm.buffer, 2, fsm.offset - 2))
			fsm.transitTo(WAITING_FOR_MESSAGE_STATE)
		} else {
			fsm.write(b)
		}
	}
}

const PIN_STATE_PARSING_STATE = new PinStateParsingState()

// Parses a string-data sysex payload and emits a textMessage event.
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

// Parses an I2C reply (address, register, 7-bit-encoded data bytes) and emits a twoWireMessage event.
class ParsingTwoWireMessageState implements FirmataFsmState {
	process(b: number, fsm: FirmataFsm) {
		if (b === END_SYSEX) {
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

const PARSING_TWO_WIRE_MESSAGE_STATE = new ParsingTwoWireMessageState()

// Parses 1-Wire replies: search/alarm results (8-byte ROM addresses) emit oneWireSearchReply; read
// results (correlation id + data) emit oneWireReadReply. Payloads are densely 7-bit packed.
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

// Buffers one optional-feature payload and dispatches it only after a complete SysEx frame.
class ParsingFeatureSysexMessageState implements FirmataFsmState {
	constructor(readonly command: number) {}

	process(b: number, fsm: FirmataFsm) {
		if (b === END_SYSEX) {
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
const FEATURE_STATES = new Map<number, FirmataFsmState>([SYSTEM_VARIABLE, SPI_DATA, SERIAL_MESSAGE, ENCODER_DATA, ACCELSTEPPER_DATA, DHTSENSOR_DATA, SAMPLING_INTERVAL, SCHEDULER_DATA, FREQUENCY_COMMAND].map((command) => [command, new ParsingFeatureSysexMessageState(command)]))

// Dispatches the first byte after START_SYSEX to the matching sub-parser state, falling back to the
// custom-sysex parser for unknown commands.
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

// Discards an oversized sysex message until its terminator, then returns the parser to the idle state.
class DiscardingSysexMessageState implements FirmataFsmState {
	process(b: number, fsm: FirmataFsm) {
		if (b === END_SYSEX) fsm.transitTo(WAITING_FOR_MESSAGE_STATE)
	}
}

const DISCARDING_SYSEX_MESSAGE_STATE = new DiscardingSysexMessageState()

// The parser state machine: holds the active state, a scratch byte buffer, and the set of handlers.
// Parser states call its write/read helpers to accumulate bytes and its event methods to broadcast a
// decoded message to every registered handler.
export class FirmataFsm {
	readonly #handlers = new Set<FirmataClientHandler>()

	// Scratch accumulation buffer for the message currently being parsed, and the write cursor into it.
	#buffer = Buffer.alloc(INITIAL_FIRMATA_BUFFER_SIZE)
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
			if (this.#buffer.length >= MAX_FIRMATA_BUFFER_SIZE) {
				this.transitTo(DISCARDING_SYSEX_MESSAGE_STATE)
				return
			}

			const size = Math.min(this.#buffer.length * 2, MAX_FIRMATA_BUFFER_SIZE)
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
		if (command === SAMPLING_INTERVAL) {
			if (payload.length === 2) for (const handler of this.#handlers) handler.samplingIntervalReply?.(this.client, decodeUnsigned7(payload, 0, 2))
		} else if (command === SYSTEM_VARIABLE) {
			const reply = decodeSystemVariableReply(payload)
			if (reply) for (const handler of this.#handlers) handler.systemVariableReply?.(this.client, reply)
		} else if (command === SPI_DATA) {
			const reply = this.client.parseSpiReply(payload)
			if (reply) for (const handler of this.#handlers) handler.spiReply?.(this.client, reply)
		} else if (command === SERIAL_MESSAGE) {
			const reply = decodeSerialReply(payload)
			if (reply) for (const handler of this.#handlers) handler.serialReply?.(this.client, reply.port as SerialPort, reply.data)
		} else if (command === ENCODER_DATA) {
			const positions = decodeEncoderPositions(payload)
			if (positions) for (const handler of this.#handlers) handler.encoderPositions?.(this.client, positions)
		} else if (command === ACCELSTEPPER_DATA) {
			const reply = decodeStepperReply(payload)
			if (reply && 'group' in reply) for (const handler of this.#handlers) handler.multiStepperComplete?.(this.client, reply.group)
			else if (reply) for (const handler of this.#handlers) handler.stepperPosition?.(this.client, reply)
		} else if (command === DHTSENSOR_DATA) {
			const reply = decodeDhtReport(payload)
			if (reply) for (const handler of this.#handlers) handler.dhtReport?.(this.client, reply)
		} else if (command === SCHEDULER_DATA) {
			const reply = decodeSchedulerReply(payload)
			if (reply && 'ids' in reply) for (const handler of this.#handlers) handler.schedulerTasks?.(this.client, reply.ids)
			else if (reply) for (const handler of this.#handlers) handler.schedulerTask?.(this.client, reply)
		} else if (command === FREQUENCY_COMMAND) {
			const reply = decodeFrequencyReport(payload)
			if (reply) for (const handler of this.#handlers) handler.frequencyReport?.(this.client, reply)
		}
	}

	close() {
		for (const handler of this.#handlers) handler.close?.(this.client)
	}
}

// Writes a 14-bit value as two 7-bit bytes.
export function writeValueAsTwo7bitBytes(data: Uint8Array, offset: number, value: number) {
	data[offset] = value & 0x7f
	data[offset + 1] = (value >> 7) & 0x7f
}

// Pre-encoded sysex query messages reused for the firmware/capability/analog-mapping handshake.
const REQUEST_FIRMWARE_DATA = new Uint8Array([START_SYSEX, REPORT_FIRMWARE, END_SYSEX])
const REQUEST_PIN_CAPABILITY_DATA = new Uint8Array([START_SYSEX, CAPABILITY_QUERY, END_SYSEX])
const REQUEST_ANALOG_MAPPING_DATA = new Uint8Array([START_SYSEX, ANALOG_MAPPING_QUERY, END_SYSEX])

// High-level Firmata client over a Transport. Drives the startup handshake (firmware → pin capabilities →
// per-pin state → analog mapping → ready), tracks pin state, and encodes outgoing commands. The encode-
// side command methods (request*, pinMode, digitalWrite, twoWire*, oneWire*) are self-describing wrappers
// that frame and send the corresponding protocol message; only the non-obvious ones are commented.
export class FirmataClient implements Disposable {
	readonly #fsm: FirmataFsm
	readonly #parser: FirmataParser
	readonly #transport: Transport
	readonly #board: Board

	#initializing = true
	#maxTwoWireDelay = 0
	#oneWireCorrelationId = 0
	#spiRequestId = 0
	readonly #spiPackedBySelector = new Map<number, boolean>()
	readonly #pinStateRequestQueue: number[] = []
	readonly #pinMap = new Map<number, Pin>()
	// Reassigned on reset()/close() so a reconnect handshake does not inherit a stale analog mapping.
	#analogPins: AnalogMapping = {}
	// Re-armed on reset()/close() so a reconnect handshake can emit ready again. The handshake's
	// analog-mapping step resolves it once, so without re-arming it would stay resolved one-shot.
	#initialization = Promise.withResolvers<boolean>()

	// Internal handler implementing the startup handshake and pin-state bookkeeping: chains firmware →
	// capability → pin-state → analog-mapping requests, resolves initialization, and updates cached pins
	// on analog reports.
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

			if (pin?.mode === PinMode.ANALOG) {
				pin.value = value
				this.#fsm.pinChange(pin)
			}
		},
		pinCapability: (client: FirmataClient, id: number, modes: Set<PinMode>, resolutions: ReadonlyMap<PinMode, number>) => {
			this.#pinMap.set(id, { id, modes, resolutions, mode: PinMode.UNSUPPORTED, value: 0 })

			// if the pin supports some modes, we will ask for its current mode and value.
			if (modes.size > 0) this.#pinStateRequestQueue.push(id)
		},
		pinCapabilitiesFinished: (client: FirmataClient) => {
			if (this.#pinStateRequestQueue.length > 0) {
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

				if (this.#pinStateRequestQueue.length > 0) {
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

	// Binds a byte-stream transport and board pin map; no I/O occurs until a request is sent.
	constructor(transport: Transport, board: Board) {
		this.#transport = transport
		this.#board = board
		this.#fsm = new FirmataFsm(WAITING_FOR_MESSAGE_STATE, this)
		this.#parser = new FirmataParser(this.#fsm)
		this.addHandler(this.#handler)
	}

	// Closes the transport and releases local parser/session state.
	[Symbol.dispose]() {
		this.disconnect()
	}

	// Number of pins discovered during the capability handshake.
	get pinCount() {
		return this.#pinMap.size
	}

	// Live iterator over cached pins; pin objects may mutate after reports arrive.
	get pins(): MapIterator<Readonly<Pin>> {
		return this.#pinMap.values()
	}

	// Returns cached state for physical pin `id`, or undefined before discovery.
	pinAt(id: number): Readonly<Pin> | undefined {
		return this.#pinMap.get(id)
	}

	// Registers an external event handler; duplicate registrations are ignored.
	addHandler(handler: FirmataClientHandler) {
		this.#fsm.addHandler(handler)
	}

	// Stops delivering future events to `handler`.
	removeHandler(handler: FirmataClientHandler) {
		this.#fsm.removeHandler(handler)
	}

	// Closes the transport and resets parser/handshake state.
	disconnect() {
		this.#transport.close()
		this.reset()
	}

	// Feeds a received byte chunk into the parser; complete messages emit handler callbacks.
	process(data: Buffer) {
		this.#parser.process(data)
	}

	// Feeds one incoming transport byte to the parser.
	processByte(b: number) {
		this.#parser.processByte(b)
	}

	// Resolves once the startup handshake completes (ready), or false after `timeout` ms (0 = no timeout).
	ensureInitializationIsDone(timeout: number) {
		const timer = timeout > 0 ? setTimeout(this.#initialization.resolve, timeout, false) : undefined
		void this.#initialization.promise.then(clearTimeout.bind(undefined, timer))
		return this.#initialization.promise
	}

	// Clears local board metadata, I2C, SPI and MultiStepper session state and the parser, then rearms the
	// handshake; pending initialization resolves false. The board receives no reset command.
	reset() {
		// Re-arm the one-shot initialization gate so a subsequent (re)connect handshake runs the full
		// firmware/capability/analog-mapping sequence and emits ready again, and ensureInitializationIsDone
		// resolves freshly. Without this a reconnect on the same client would never become ready.
		this.#initializing = true
		// Settle the outgoing promise before replacing it: a caller awaiting ensureInitializationIsDone(0)
		// has no rescue timer, so without this it would be orphaned forever instead of observing the reset.
		this.#initialization.resolve(false)
		this.#initialization = Promise.withResolvers<boolean>()
		// Drop cached board metadata so a fresh handshake does not inherit stale pins/analog mapping:
		// pinCapability only adds/updates entries and analogMapping only assigns supplied ports, so a
		// reconnect to firmware with fewer pins or a different map would otherwise keep the old ones.
		this.#pinStateRequestQueue.length = 0
		this.#pinMap.clear()
		this.#analogPins = {}
		this.#maxTwoWireDelay = 0
		this.#spiRequestId = 0
		this.#spiPackedBySelector.clear()
		this.#fsm.transitTo(WAITING_FOR_MESSAGE_STATE)
	}

	// Writes a framed message or source-buffer slice to the transport and flushes it.
	send(message: string | Bun.BufferSource, byteOffset?: number, byteLength?: number) {
		this.#transport.write(message, byteOffset, byteLength)
		this.#transport.flush()
	}

	// Requests firmware name and version; this starts the client's readiness handshake.
	requestFirmware() {
		this.send(REQUEST_FIRMWARE_DATA)
	}

	// Requests the two-byte Firmata protocol version; the result arrives through `version`.
	requestProtocolVersion() {
		this.send(new Uint8Array([REPORT_VERSION]))
	}

	// Resets the board, invalidates cached configuration, and requests fresh firmware metadata
	// to restart the readiness handshake. `reset()` alone only clears local state.
	sendSystemReset() {
		this.send(new Uint8Array([SYSTEM_RESET]))
		this.reset()
		this.requestFirmware()
	}

	// Frames a feature `command` and its already 7-bit-safe `payload`, allocating
	// one outbound buffer before writing and flushing it.
	#sendSysex(command: number, payload: readonly number[]) {
		const message = new Uint8Array(payload.length + 3)
		message[0] = START_SYSEX
		message[1] = command
		message.set(payload, 2)
		message[message.length - 1] = END_SYSEX
		this.send(message)
	}

	// Sends UTF-8 `message` text using STRING_DATA's two-seven-bit-byte-per-octet layout.
	sendString(message: string) {
		const bytes = Buffer.from(message, 'utf8')
		const payload: number[] = []
		for (const byte of bytes) payload.push(byte & 0x7f, byte >>> 7)
		this.#sendSysex(STRING_DATA, payload)
	}

	// Requests supported modes and their resolution for every physical pin.
	requestPinCapability() {
		this.send(REQUEST_PIN_CAPABILITY_DATA)
	}

	// Requests current mode and raw value for physical pin `pinId`.
	requestPinState(pinId: number) {
		this.send(new Uint8Array([START_SYSEX, PIN_STATE_QUERY, pinId, END_SYSEX]))
	}

	// Requests the board's analog-channel-to-physical-pin map.
	requestAnalogMapping() {
		this.send(REQUEST_ANALOG_MAPPING_DATA)
	}

	// Enables or disables all 16 standard eight-pin digital reporting ports.
	requestDigitalReport(enable: boolean) {
		const message = new Uint8Array(32)

		for (let i = 0, p = 0; i < 16; i++) {
			message[p++] = REPORT_DIGITAL | i
			message[p++] = enable ? 1 : 0
		}

		this.send(message)
	}

	// Enables or disables reports for the eight-pin digital port containing `pin`.
	requestDigitalPinReport(pin: number, enable: boolean) {
		this.send(new Uint8Array([REPORT_DIGITAL | ((this.#board.pinToDigital(pin) >> 3) & 0x0f), enable ? 1 : 0]))
	}

	// Enables or disables reporting for all 16 standard analog channels.
	requestAnalogReport(enable: boolean) {
		const message = new Uint8Array(32)

		for (let i = 0, p = 0; i < 16; i++) {
			message[p++] = REPORT_ANALOG | i
			message[p++] = enable ? 1 : 0
		}

		this.send(message)
	}

	// Enables or disables reporting for physical `pin`'s analog channel; channels
	// above 15 use EXTENDED_REPORT_ANALOG and return samples through `analogMessage`.
	requestAnalogPinReport(pin: number, enable: boolean) {
		const channel = this.#board.pinToAnalog(pin)
		if (channel < 16) this.send(new Uint8Array([REPORT_ANALOG | channel, enable ? 1 : 0]))
		else this.#sendSysex(EXTENDED_REPORT_ANALOG, [channel, enable ? 1 : 0])
	}

	// Sets physical `pin` to `mode` and updates its cached mode immediately.
	pinMode(pin: number, mode: PinMode) {
		const state = this.#pinMap.get(pin)
		if (state) state.mode = mode

		this.send(new Uint8Array([SET_PIN_MODE, pin, mode]))
	}

	// Drives a physical digital pin low for zero/false or high for any other value.
	digitalWrite(pin: number, value: boolean | number) {
		this.send(new Uint8Array([SET_DIGITAL_PIN_VALUE, pin, value ? 1 : 0]))
	}

	// Writes `value` to physical PWM/servo `pin`, saturated to unsigned 32 bits,
	// using the shortest extended-analog encoding of up to five 7-bit bytes.
	analogWrite(pin: number, value: number) {
		const data = Math.max(0, Math.min(0xffffffff, Math.trunc(value)))
		const bytes = data === 0 ? 1 : Math.ceil((Math.floor(Math.log2(data)) + 1) / 7)
		this.#sendSysex(EXTENDED_ANALOG, [this.#board.pinToPWM(pin), ...encodeUnsigned7(data, bytes)])
	}

	// Sets the shared analog/I2C sampling interval in milliseconds, clamped to 1-16383.
	samplingInterval(milliseconds: number) {
		const message = new Uint8Array([START_SYSEX, SAMPLING_INTERVAL, 0, 0, END_SYSEX])
		// The interval is a 14-bit field (LSB+MSB, both 7-bit); encodeByteAs7Bit only keeps 8 bits.
		writeValueAsTwo7bitBytes(message, 2, Math.max(MIN_SAMPLING_INTERVAL, Math.min(milliseconds, MAX_SAMPLING_INTERVAL)))
		this.send(message)
	}

	// Requests the board's sampling interval in milliseconds.
	querySamplingInterval() {
		this.#sendSysex(SAMPLING_INTERVAL_QUERY, [])
	}

	// Queries signed int32 variable `id` (0-16383) for physical `pin`, or the whole
	// board when `pin` is omitted; the reply arrives through `systemVariableReply`.
	// The bundled firmware requires a five-byte zero value even for reads.
	querySystemVariable(id: number, pin?: number) {
		this.#sendSysex(SYSTEM_VARIABLE, [0, 1, 0, ...encodeUnsigned7(id, 2), pin ?? 127, 0, 0, 0, 0, 0])
	}

	// Sets signed int32 variable `id` (0-16383) to `value` for physical `pin`, or
	// the whole board when omitted; firmware reports the resulting status.
	setSystemVariable(id: number, value: number, pin?: number) {
		this.#sendSysex(SYSTEM_VARIABLE, [1, 1, 0, ...encodeUnsigned7(id, 2), pin ?? 127, ...encodeSigned32(value)])
	}

	// Configures physical servo `pin` with minimum and maximum pulse widths in
	// microseconds (0-16383); attach/detach uses `pinMode`.
	servoConfig(pin: number, minPulseMicroseconds: number, maxPulseMicroseconds: number) {
		this.#sendSysex(SERVO_CONFIG, [pin, ...encodeUnsigned7(minPulseMicroseconds, 2), ...encodeUnsigned7(maxPulseMicroseconds, 2)])
	}

	// Starts SPI `channel` (0-7); the bundled ESP8266 firmware accepts channel zero.
	spiBegin(channel: SpiChannel = 0) {
		this.#sendSysex(SPI_DATA, [0, channel])
	}

	// Configures an eight-bit SPI device from channel, device ID, clock and CS options;
	// remembers its reply packing until reset or `spiEnd`.
	spiConfig(options: SpiDeviceOptions) {
		if (options.controlCs && options.csPin === undefined) throw new RangeError('SPI firmware-controlled chip select requires a CS pin')
		const selector = spiSelector(options.channel, options.deviceId)
		this.#sendSysex(SPI_DATA, encodeSpiConfig(options))
		this.#spiPackedBySelector.set(selector, options.packed ?? false)
	}

	// Releases SPI `channel` and forgets device reply encoding for that channel.
	spiEnd(channel: SpiChannel = 0) {
		this.#sendSysex(SPI_DATA, [6, channel])
		for (const selector of this.#spiPackedBySelector.keys()) if ((selector & 7) === channel) this.#spiPackedBySelector.delete(selector)
	}

	// Allocates one 7-bit SPI request ID, wrapping from 127 to zero.
	#nextSpiRequestId(): number {
		const id = this.#spiRequestId
		this.#spiRequestId = (id + 1) & 127
		return id
	}

	// Sends `data` words (or a numeric read count) to a channel/device with the
	// chosen command. `deselectCs=false` keeps CS active; returns a 7-bit request ID.
	#spiData(command: 2 | 3 | 4 | 7, channel: SpiChannel, deviceId: number, data: Readonly<NumberArray> | Buffer | number, deselectCs: boolean): number {
		const selector = spiSelector(channel, deviceId)
		const packed = this.#spiPackedBySelector.get(selector) ?? false
		if (typeof data !== 'number') {
			// ESP8266 MAX_DATA_BYTES is 64; the feature ID and five command fields
			// leave at most 58 encoded data bytes before the parser drops the frame.
			const encodedLength = packed ? Math.ceil((data.length * 8) / 7) : data.length * 2
			if (!(data.length > 0 && 6 + encodedLength <= 64)) throw new RangeError('SPI transfer must fit the ESP8266 64-byte input frame')
		}
		const id = this.#nextSpiRequestId()
		const payload = typeof data === 'number' ? [command, selector, id, deselectCs ? 1 : 0, data] : encodeSpiWords(command, selector, id, data, packed, deselectCs)
		this.#sendSysex(SPI_DATA, payload)
		return id
	}

	// Exchanges eight-bit `data` words with a channel/device. Deselects CS by
	// default and returns the request ID echoed by `spiReply`.
	spiTransfer(channel: SpiChannel, deviceId: number, data: Readonly<NumberArray> | Buffer, deselectCs: boolean = true): number {
		return this.#spiData(2, channel, deviceId, data, deselectCs)
	}

	// Writes eight-bit `data` to a channel/device without a reply; optionally
	// keeps CS active and returns the allocated request ID.
	spiWrite(channel: SpiChannel, deviceId: number, data: Readonly<NumberArray> | Buffer, deselectCs: boolean = true): number {
		return this.#spiData(3, channel, deviceId, data, deselectCs)
	}

	// Writes eight-bit `data` to a channel/device, optionally keeping CS active;
	// returns the request ID echoed by an empty acknowledgement reply.
	spiWriteAck(channel: SpiChannel, deviceId: number, data: Readonly<NumberArray> | Buffer, deselectCs: boolean = true): number {
		return this.#spiData(7, channel, deviceId, data, deselectCs)
	}

	// Reads `words` eight-bit values from a channel/device by clocking zeroes.
	// At most 64 words protect the bundled firmware's stack buffer; returns a
	// request ID, and deselects CS unless `deselectCs` is false.
	spiRead(channel: SpiChannel, deviceId: number, words: number, deselectCs: boolean = true): number {
		// The bundled firmware's read path writes into a 64-byte stack buffer.
		if (!(Number.isInteger(words) && words >= 0 && words <= 64)) throw new RangeError('SPI read length must be 0-64 words')
		return this.#spiData(4, channel, deviceId, words, deselectCs)
	}

	// Decodes a complete SPI reply payload after 0x68 using its device's last
	// configured packing; returns undefined for malformed payloads.
	parseSpiReply(payload: Buffer): SpiReply | undefined {
		return decodeSpiReply(payload, this.#spiPackedBySelector.get(payload[1]) ?? false)
	}

	// Returns physical RX/TX pins for hardware `port` from serial capability
	// resolution (RX=2n, TX=2n+1); software ports return an empty object.
	serialPins(port: SerialPort): { rx?: number; tx?: number } {
		const pins: { rx?: number; tx?: number } = {}
		if (port >= 8) return pins
		for (const pin of this.#pinMap.values()) {
			const resolution = pin.resolutions.get(PinMode.SERIAL)
			if (resolution === port * 2) pins.rx = pin.id
			else if (resolution === port * 2 + 1) pins.tx = pin.id
		}
		return pins
	}

	// Configures a Serial 1.0 hardware/software `port` at `baud` bits/second.
	// Optional RX/TX pins are inferred from capabilities when available, and must
	// be supplied together if only one can be inferred.
	serialConfig(port: SerialPort, baud: number, rxPin?: number, txPin?: number) {
		const discovered = this.serialPins(port)
		const rx = rxPin ?? discovered.rx
		const tx = txPin ?? discovered.tx
		if ((rx === undefined) !== (tx === undefined)) throw new RangeError('Serial RX and TX pins must be configured together')
		const payload = [0x10 | port, ...encodeUnsigned7(baud, 3)]
		if (rx !== undefined && tx !== undefined) payload.push(rx, tx)
		this.#sendSysex(SERIAL_MESSAGE, payload)
	}

	// Writes raw `data` bytes to a Serial 1.0 `port` using 7-bit pairs.
	serialWrite(port: SerialPort, data: Readonly<NumberArray> | Buffer) {
		const payload = [0x20 | port]
		for (const byte of data) payload.push(byte & 127, byte >>> 7)
		this.#sendSysex(SERIAL_MESSAGE, payload)
	}

	// Starts continuous reads from `port`, limiting each report to `maxBytes` raw
	// bytes; zero reads all currently available bytes.
	serialStartRead(port: SerialPort, maxBytes: number = 0) {
		this.#sendSysex(SERIAL_MESSAGE, [0x30 | port, 0, ...encodeUnsigned7(maxBytes, 2)])
	}

	// Stops continuous reads from Serial 1.0 `port` without closing it.
	serialStopRead(port: SerialPort) {
		this.#sendSysex(SERIAL_MESSAGE, [0x30 | port, 1])
	}

	// Closes Serial 1.0 `port`; reconfiguration is required before reuse.
	serialClose(port: SerialPort) {
		this.#sendSysex(SERIAL_MESSAGE, [0x50 | port])
	}

	// Flushes Serial 1.0 `port` according to the board's serial implementation.
	serialFlush(port: SerialPort) {
		this.#sendSysex(SERIAL_MESSAGE, [0x60 | port])
	}

	// Selects `port` as the active software serial listener.
	serialListen(port: SerialPort) {
		this.#sendSysex(SERIAL_MESSAGE, [0x70 | port])
	}

	// Attaches encoder `id` to digital `pinA` and `pinB`; reports use step counts.
	encoderAttach(id: number, pinA: number, pinB: number) {
		this.#sendSysex(ENCODER_DATA, [0, id, pinA, pinB])
	}

	// Detaches encoder `id` from its pins.
	encoderDetach(id: number) {
		this.#sendSysex(ENCODER_DATA, [5, id])
	}

	// Requests encoder `id`'s signed position in steps.
	encoderReport(id: number) {
		this.#sendSysex(ENCODER_DATA, [1, id])
	}

	// Requests all encoder positions in one reply.
	encoderReportAll() {
		this.#sendSysex(ENCODER_DATA, [2])
	}

	// Sets encoder `id`'s current position to zero steps.
	encoderReset(id: number) {
		this.#sendSysex(ENCODER_DATA, [3, id])
	}

	// Enables or disables automatic position reports for all attached encoders at
	// the board sampling interval.
	encoderAutoReport(enable: boolean) {
		this.#sendSysex(ENCODER_DATA, [4, enable ? 1 : 0])
	}

	// Configures an AccelStepper motor from `options`; required motor pins follow
	// its driver/two-/three-/four-wire interface, followed by optional enable and inversion pins.
	stepperConfig(options: StepperConfig) {
		const wireCount = options.interface === 'driver' ? 1 : options.interface === 'twoWire' ? 2 : options.interface === 'threeWire' ? 3 : 4
		const control = (wireCount << 4) | ((options.stepType ?? 0) << 1) | (options.enablePin === undefined ? 0 : 1)
		const payload = [0, options.device, control, options.pin1, options.pin2]
		if (options.interface === 'threeWire' || options.interface === 'fourWire') payload.push(options.pin3)
		if (options.interface === 'fourWire') payload.push(options.pin4)
		if (options.enablePin !== undefined) payload.push(options.enablePin)
		if (options.invertPins !== undefined) payload.push(options.invertPins)
		this.#sendSysex(ACCELSTEPPER_DATA, payload)
	}

	// Makes motor `device`'s current position zero steps without moving it.
	stepperZero(device: number) {
		this.#sendSysex(ACCELSTEPPER_DATA, [1, device])
	}

	// Moves motor `device` by signed `steps` from its current position; the
	// firmware's sign-magnitude format supports -2147483647 through 2147483647.
	stepperMove(device: number, steps: number) {
		this.#sendSysex(ACCELSTEPPER_DATA, [2, device, ...encodeStepperPosition(steps)])
	}

	// Moves motor `device` to signed `position` steps from its zero position;
	// the sign-magnitude format supports -2147483647 through 2147483647.
	stepperMoveTo(device: number, position: number) {
		this.#sendSysex(ACCELSTEPPER_DATA, [3, device, ...encodeStepperPosition(position)])
	}

	// Energizes or disables motor `device` through its configured enable pin.
	stepperEnable(device: number, enable: boolean) {
		this.#sendSysex(ACCELSTEPPER_DATA, [4, device, enable ? 1 : 0])
	}

	// Stops motor `device`; the firmware later reports its completed position.
	stepperStop(device: number) {
		this.#sendSysex(ACCELSTEPPER_DATA, [5, device])
	}

	// Requests motor `device`'s signed position in steps.
	stepperReportPosition(device: number) {
		this.#sendSysex(ACCELSTEPPER_DATA, [6, device])
	}

	// Sets motor `device`'s acceleration in steps/second² using the protocol's
	// 23-bit decimal float (roughly seven significant digits).
	stepperSetAcceleration(device: number, acceleration: number) {
		this.#sendSysex(ACCELSTEPPER_DATA, [8, device, ...encodeStepperFloat(acceleration)])
	}

	// Sets motor `device`'s `speed` in steps/second (maximum while acceleration
	// is enabled), using the protocol's 23-bit decimal float.
	stepperSetMaxSpeed(device: number, speed: number) {
		this.#sendSysex(ACCELSTEPPER_DATA, [9, device, ...encodeStepperFloat(speed)])
	}

	// Appends `devices` (motor IDs 0-9) to MultiStepper `group` (0-4), preserving
	// their order for later absolute targets. At most ten motors fit a group.
	multiStepperConfig(group: number, devices: readonly number[]) {
		const size = devices.length
		// The firmware indexes five groups and ten motor slots without checking IDs;
		// MultiStepper itself stores at most ten motors.
		if (!(Number.isInteger(group) && group >= 0 && group < 5 && size > 0 && size <= 10 && devices.every((device) => Number.isInteger(device) && device >= 0 && device < 10))) throw new RangeError('MultiStepper requires group 0-4 and 1-10 motor IDs in 0-9')
		this.#sendSysex(ACCELSTEPPER_DATA, [0x20, group, ...devices])
	}

	// Coordinates `group` to absolute signed `positions` in configured motor
	// order; one position in steps is required per motor.
	multiStepperMoveTo(group: number, positions: readonly number[]) {
		const payload = [0x21, group]
		for (const position of positions) payload.push(...encodeStepperPosition(position))
		this.#sendSysex(ACCELSTEPPER_DATA, payload)
	}

	// Immediately stops every motor in MultiStepper `group` (0-4).
	multiStepperStop(group: number) {
		if (!(Number.isInteger(group) && group >= 0 && group < 5)) throw new RangeError('MultiStepper group must be 0-4')
		this.#sendSysex(ACCELSTEPPER_DATA, [0x23, group])
	}

	// Attaches `model` DHT11 or DHT22 to physical `pin`. `samplingMilliseconds`
	// controls reporting; blocking reads are opt-in because they stall the board
	// for roughly 18 ms.
	dhtAttach(pin: number, model: DhtModel, samplingMilliseconds: number = 500, blocking: boolean = false) {
		this.#sendSysex(DHTSENSOR_DATA, [model === 'dht11' ? 1 : 2, pin, blocking ? 1 : 0, ...encodeUnsigned7(samplingMilliseconds, 2)])
	}

	// Detaches the DHT sensor on physical `pin`.
	dhtDetach(pin: number) {
		this.#sendSysex(DHTSENSOR_DATA, [3, pin])
	}

	// Creates scheduler task `id` (0-127) with `length` bytes of message storage.
	schedulerCreate(id: number, length: number) {
		this.#sendSysex(SCHEDULER_DATA, [0, id, ...encodeUnsigned7(length, 2)])
	}

	// Deletes scheduler task `id` and its stored messages.
	schedulerDelete(id: number) {
		this.#sendSysex(SCHEDULER_DATA, [1, id])
	}

	// Appends raw Firmata `message` bytes to scheduler task `id` using dense
	// seven-bit packing; the task's declared capacity must accommodate them.
	schedulerAdd(id: number, message: Readonly<NumberArray> | Buffer) {
		this.#sendSysex(SCHEDULER_DATA, [2, id, ...encodePacked7Bit(message)])
	}

	// Delays the currently executing scheduler task by 0..2147483647 milliseconds;
	// larger wire values become negative signed `long` delays in the firmware.
	schedulerDelay(milliseconds: number) {
		if (!(Number.isInteger(milliseconds) && milliseconds >= 0 && milliseconds <= 0x7fffffff)) throw new RangeError('Scheduler delay must be 0-2147483647 milliseconds')
		this.#sendSysex(SCHEDULER_DATA, [3, ...encodeUnsigned7(milliseconds, 5)])
	}

	// Schedules task `id` after 0..2147483647 milliseconds, the positive signed
	// `long` range decoded by the reference firmware.
	schedulerSchedule(id: number, milliseconds: number) {
		if (!(Number.isInteger(milliseconds) && milliseconds >= 0 && milliseconds <= 0x7fffffff)) throw new RangeError('Scheduler delay must be 0-2147483647 milliseconds')
		this.#sendSysex(SCHEDULER_DATA, [4, id, ...encodeUnsigned7(milliseconds, 5)])
	}

	// Requests all currently registered task identifiers.
	schedulerQueryAll() {
		this.#sendSysex(SCHEDULER_DATA, [5])
	}

	// Requests task `id`'s delay, byte capacity, insertion position and messages.
	schedulerQuery(id: number) {
		this.#sendSysex(SCHEDULER_DATA, [6, id])
	}

	// Clears all scheduler tasks and pending executions.
	schedulerReset() {
		this.#sendSysex(SCHEDULER_DATA, [7])
	}

	// Enables raw edge-count reports for physical `pin` at `samplingMilliseconds`
	// intervals. Interrupt `mode` is LOW=1, HIGH=2, RISING=3, FALLING=4 or CHANGE=5.
	frequencyQuery(pin: number, mode: 1 | 2 | 3 | 4 | 5, samplingMilliseconds: number) {
		this.#sendSysex(FREQUENCY_COMMAND, [1, pin, mode, ...encodeUnsigned7(samplingMilliseconds, 2)])
	}

	// Disables frequency reporting on physical `pin`, or all pins when omitted.
	frequencyClear(pin: number = 127) {
		this.#sendSysex(FREQUENCY_COMMAND, [0, pin])
	}

	// Sets physical `pin`'s edge debounce interval in `microseconds`.
	frequencyFilter(pin: number, microseconds: number) {
		this.#sendSysex(FREQUENCY_COMMAND, [3, pin, ...encodeUnsigned7(microseconds, 5)])
	}

	// Configures the I2C read delay in microseconds; retains the greatest requested
	// delay for this client so multiple peripherals do not shorten each other's timing.
	twoWireConfig(delayInMicroseconds: number) {
		this.#maxTwoWireDelay = Math.max(this.#maxTwoWireDelay, delayInMicroseconds)
		const message = new Uint8Array([START_SYSEX, TWO_WIRE_CONFIG, 0, 0, END_SYSEX])
		// The I2C delay is a 14-bit field (LSB+MSB, both 7-bit); encodeByteAs7Bit only keeps 8 bits.
		writeValueAsTwo7bitBytes(message, 2, this.#maxTwoWireDelay)
		this.send(message)
	}

	// Sends one I2C transaction to `address` with 7- or 10-bit addressing. The
	// operation flag selects write, one-shot/continuous read or stop; `data` is raw
	// bytes, and `autoRestart` controls bus release after a read.
	twoWireReadWrite(address: number, operationMode: TwoWireOperationMode, data?: Readonly<NumberArray> | Buffer, addressMode: TwoWireAddressMode = 7, autoRestart: TwoWireAutoRestartMode = 'stop') {
		const message = Buffer.alloc(5 + (data !== undefined ? data.length * 2 : 0))

		message[0] = START_SYSEX
		message[1] = TWO_WIRE_REQUEST
		message[2] = address & 0x7f
		message[3] = ((address >>> 7) & 0x7) | (operationMode === 'write' ? TWO_WIRE_WRITE : operationMode === 'read' ? TWO_WIRE_READ : operationMode === 'readContinuously' ? TWO_WIRE_READ_CONTINUOUS : TWO_WIRE_STOP_READ) | (addressMode === 7 ? 0 : 0x20) | (autoRestart === 'restart' ? 0x40 : 0)

		if (data !== undefined) {
			for (let i = 0, offset = 4; i < data.length; i++, offset += 2) {
				encodeByteAs7Bit(data[i], message, offset)
			}
		}

		message[message.byteLength - 1] = END_SYSEX

		this.send(message)
	}

	// Reads `bytesToRead` bytes from an I2C device, optionally selecting `register`
	// (-1 omits it). `continuous` repeats reads until stopped; address width and bus
	// release are controlled by `addressMode` and `autoRestart`.
	twoWireRead(address: number, register: number, bytesToRead: number, continuous: boolean = false, addressMode: TwoWireAddressMode = 7, autoRestart: TwoWireAutoRestartMode = 'stop') {
		const data = new Uint8Array(register >= 0 ? [register, bytesToRead] : [bytesToRead])
		this.twoWireReadWrite(address, continuous ? 'readContinuously' : 'read', data, addressMode, autoRestart)
	}

	// Writes raw `data` bytes to a 7- or 10-bit I2C device address.
	twoWireWrite(address: number, data?: Readonly<NumberArray> | Buffer, addressMode: TwoWireAddressMode = 7) {
		this.twoWireReadWrite(address, 'write', data, addressMode)
	}

	// Stops a continuous read from the addressed 7- or 10-bit I2C device.
	twoWireStop(address: number, addressMode: TwoWireAddressMode = 7) {
		this.twoWireReadWrite(address, 'stop', undefined, addressMode)
	}

	// Returns a fresh 16-bit correlation id for matching 1-Wire read requests to their replies.
	#nextOneWireCorrelationId() {
		const correlationId = this.#oneWireCorrelationId
		this.#oneWireCorrelationId = (this.#oneWireCorrelationId + 1) & 0xffff
		return correlationId
	}

	// Configures a physical 1-Wire pin for external or parasitic device power.
	oneWireConfig(pin: number, powerMode: OneWirePowerMode = 'normal') {
		this.send(new Uint8Array([START_SYSEX, ONE_WIRE_DATA, ONE_WIRE_CONFIG_REQUEST, pin, powerMode === 'parasitic' ? 0 : 1, END_SYSEX]))
	}

	// Searches all or alarm-signalling ROM addresses on physical 1-Wire `pin`.
	oneWireSearch(pin: number, mode: OneWireSearchMode = 'all') {
		this.send(new Uint8Array([START_SYSEX, ONE_WIRE_DATA, mode === 'alarms' ? ONE_WIRE_SEARCH_ALARMS_REQUEST : ONE_WIRE_SEARCH_REQUEST, pin, END_SYSEX]))
	}

	// Assembles and sends one 1-Wire command on a pin: sets the reset/skip/select/read/delay/write bits,
	// builds the (7-bit packed) payload, and returns the read correlation id when a read was requested.
	// Throws if both skip-ROM and a specific ROM address are requested, or the address is not 8 bytes.
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

		const encodedData = payload.length > 0 ? encodePacked7Bit(payload) : undefined
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

	// Issues a bus reset on physical 1-Wire `pin`.
	oneWireReset(pin: number) {
		this.oneWireCommand(pin, { reset: true })
	}

	// Resets the 1-Wire bus and writes `data`, selecting an optional eight-byte ROM
	// address or broadcasting with SKIP ROM when `address` is omitted.
	oneWireWrite(pin: number, data: Readonly<NumberArray> | Buffer, address?: Readonly<NumberArray> | Buffer) {
		this.oneWireCommand(pin, { reset: true, skip: address === undefined, address, data })
	}

	// Resets the 1-Wire bus and reads `bytesToRead` bytes from an optional ROM;
	// returns the supplied or generated 16-bit correlation ID for the reply.
	oneWireRead(pin: number, bytesToRead: number, address?: Readonly<NumberArray> | Buffer, correlationId?: number) {
		return this.oneWireCommand(pin, { reset: true, skip: address === undefined, address, bytesToRead, correlationId })
	}

	// Writes `data` then reads `bytesToRead` bytes from an optional 1-Wire ROM;
	// returns the supplied or generated 16-bit correlation ID for the reply.
	oneWireWriteAndRead(pin: number, data: Readonly<NumberArray> | Buffer, bytesToRead: number, address?: Readonly<NumberArray> | Buffer, correlationId?: number) {
		return this.oneWireCommand(pin, { reset: true, skip: address === undefined, address, bytesToRead, correlationId, data })
	}

	// Emits the close event to handlers and re-arms initialization for a possible reconnect.
	close() {
		this.#fsm.close()
		// Re-arm initialization so a reconnect on the same client handshakes and becomes ready again.
		this.reset()
	}
}

// FirmataClient bound to a Bun TCP socket. Connects, pumps received bytes into the parser, and triggers
// the firmware request once connected.
export class FirmataClientOverTcp extends FirmataClient {
	#socket?: Bun.Socket
	#connectionId = 0

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

	// Opens the TCP connection and starts the handshake by requesting firmware. Returns false if already
	// connected.
	async connect(hostname: string, port: number, options?: Omit<Bun.TCPSocketConnectOptions, 'hostname' | 'port' | 'socket'>) {
		if (this.#socket) return false

		const connectionId = ++this.#connectionId
		const socket = await Bun.connect({
			...options,
			hostname,
			port,
			socket: {
				data: (_, buffer) => {
					if (connectionId === this.#connectionId) this.process(buffer)
				},
				error: (_, error) => {
					console.error('firmata socket error:', error)
					this.#closeConnection(connectionId)
				},
				connectError: (_, error) => {
					console.error('firmata connection failed:', error)
					if (connectionId === this.#connectionId) {
						this.#connectionId++
						this.#socket = undefined
						this.reset()
					}
				},
				end: () => {
					console.info('firmata socket ended')
					this.#closeConnection(connectionId)
				},
				open(socket) {
					console.info('firmata socket open at %s:%s', socket.remoteAddress, socket.localPort)
				},
				timeout() {
					console.info('firmata socket timed out')
				},
				close: (_, error) => {
					console.info('firmata socket closed:', error)
					this.#closeConnection(connectionId)
				},
			},
		})

		if (connectionId !== this.#connectionId) {
			socket.close()
			return false
		}

		this.#socket = socket

		this.requestFirmware()

		return true
	}

	// Closes and clears the underlying socket.
	close() {
		const socket = this.#socket
		this.#socket = undefined
		this.#connectionId++
		socket?.close()
	}

	// Invalidates one TCP connection, clears its socket, emits close, and ignores later callbacks from it.
	#closeConnection(connectionId: number) {
		if (connectionId !== this.#connectionId) return

		this.#connectionId++
		this.#socket = undefined
		super.close()
	}
}
