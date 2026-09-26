import type { NumberArray } from '../../math/numerical/math'
import type { FirmataClient } from './client'
import type { DhtReport, EncoderPosition, FrequencyReport, SchedulerTaskReply, StepperPosition, SystemVariableReply } from './codecs/replies'
import type { SpiReply } from './codecs/spi'

// Public Firmata contracts for board pins, transports, command options and handler events.
// Handler callback values follow their protocol units; pin objects are live client state.

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
