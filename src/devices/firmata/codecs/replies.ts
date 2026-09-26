import { decodePacked7Bit, decodeSigned32, decodeStepperPosition, decodeUnsigned7 } from './numeric'

// Decoders for optional Firmata SysEx replies. Each accepts the bytes after its feature ID,
// ignores truncated payloads, and allocates only for complete variable-length reports.

// System-variable operation and status from a 0x66 response.
export interface SystemVariableReply {
	// Zero queries a value; one sets a value.
	readonly operation: 0 | 1
	// Firmata data type; currently 1 identifies a signed int32.
	readonly dataType: number
	// Firmware status: 0 success, 1 read-only, 2 write-only, 3 unknown type,
	// 4 unknown ID, or 5 another firmware error.
	readonly status: number
	// Variable identifier, 0-16383.
	readonly id: number
	// Pin identifier, or undefined for a board-wide variable.
	readonly pin?: number
	// Signed int32 value when the response carries one.
	readonly value?: number
}

// One incremental encoder position and its last reported direction.
export interface EncoderPosition {
	// Encoder number, 0-63.
	readonly id: number
	// Signed step count reconstructed from the 28-bit magnitude and direction bit.
	readonly position: number
	// Whether the reported direction is negative.
	readonly negative: boolean
}

// AccelStepper position or move-complete event, in whole motor steps.
export interface StepperPosition {
	// Motor number, 0-9.
	readonly device: number
	// Signed position in motor steps from the last zero command.
	readonly position: number
	// True for a completed move (also sent after stop), false for a requested report.
	readonly complete: boolean
}

// Sensor report in physical units after Firmata's factor-of-ten encoding.
export interface DhtReport {
	// Board pin, 0-127.
	readonly pin: number
	// Temperature in degrees Celsius.
	readonly temperature: number
	// Relative humidity in percent.
	readonly humidity: number
}

// Scheduler reply when the queried task does not exist.
export interface SchedulerTaskMissing {
	// Task identifier, 0-127.
	readonly id: number
	// A missing task has no timing, position or data fields.
	readonly found: false
	// True when this is an execution error response.
	readonly error: boolean
}

// Scheduler reply containing an existing task and its stored command bytes.
export interface SchedulerTaskPresent {
	// Task identifier, 0-127.
	readonly id: number
	// Existing task marker.
	readonly found: true
	// Delay until execution in milliseconds.
	readonly time: number
	// Allocated task length in bytes.
	readonly length: number
	// Next task-data insertion position in bytes.
	readonly position: number
	// Encoded Firmata task messages already stored by the board.
	readonly data: Buffer
	// True when the firmware reported a task execution error.
	readonly error: boolean
}

// Scheduler task query or execution error, with task data only when found.
export type SchedulerTaskReply = SchedulerTaskMissing | SchedulerTaskPresent

// Raw frequency counters. Deltas of ticks and timestamps can yield hertz when
// the selected edge mode and counter rollover are handled by the caller.
export interface FrequencyReport {
	// Measured pin, 0-127.
	readonly pin: number
	// Unsigned measurement timestamp in milliseconds, modulo 2^32.
	readonly timestamp: number
	// Unsigned accumulated edge count, modulo 2^32.
	readonly ticks: number
}

// Decodes a Serial 1.0 reply, including its hardware/software port nibble.
export function decodeSerialReply(payload: Buffer): { port: number; data: Buffer } | undefined {
	if (payload.length === 0 || (payload[0] & 0x70) !== 0x40 || (payload.length - 1) % 2 !== 0) return undefined
	const data = Buffer.alloc((payload.length - 1) / 2)
	for (let i = 0; i < data.length; i++) data[i] = payload[1 + 2 * i] | (payload[2 + 2 * i] << 7)
	return { port: payload[0] & 15, data }
}

// Decodes a single or batched 0x61 encoder report; incomplete groups are discarded.
export function decodeEncoderPositions(payload: Buffer): readonly EncoderPosition[] | undefined {
	if (payload.length === 0 || payload.length % 5 !== 0) return undefined
	const positions: EncoderPosition[] = []
	for (let i = 0; i < payload.length; i += 5) {
		const negative = (payload[i] & 0x40) !== 0
		const magnitude = decodeUnsigned7(payload, i + 1, 4)
		positions.push({ id: payload[i] & 0x3f, position: negative ? -magnitude : magnitude, negative })
	}
	return positions
}

// Decodes 0x62 position and completion reports; other commands are host-only.
export function decodeStepperReply(payload: Buffer): StepperPosition | { group: number } | undefined {
	if (payload.length === 2 && payload[0] === 0x24) return { group: payload[1] }
	if (payload.length !== 7 || (payload[0] !== 0x06 && payload[0] !== 0x0a)) return undefined
	return { device: payload[1], position: decodeStepperPosition(payload, 2), complete: payload[0] === 0x0a }
}

// Decodes a signed 14-bit temperature and unsigned humidity from 0x74.
export function decodeDhtReport(payload: Buffer): DhtReport | undefined {
	if (payload.length !== 6 || payload[0] !== 0) return undefined
	const rawTemperature = decodeUnsigned7(payload, 2, 2)
	return { pin: payload[1], temperature: (rawTemperature >= 0x2000 ? rawTemperature - 0x4000 : rawTemperature) / 10, humidity: decodeUnsigned7(payload, 4, 2) / 10 }
}

// Decodes task inventory (0x09), task details (0x0a) and task errors (0x08).
export function decodeSchedulerReply(payload: Buffer): { ids: readonly number[] } | SchedulerTaskReply | undefined {
	if (payload.length === 0) return undefined
	if (payload[0] === 9) return { ids: Array.from(payload.subarray(1)) }
	if ((payload[0] === 8 || payload[0] === 10) && payload.length === 2) return { id: payload[1], found: false, error: payload[0] === 8 }
	if ((payload[0] !== 8 && payload[0] !== 10) || payload.length < 12) return undefined
	const fields = decodePacked7Bit(payload, 2)
	if (fields.length < 8) return undefined
	return { id: payload[1], found: true, time: fields.readUInt32LE(0), length: fields.readUInt16LE(4), position: fields.readUInt16LE(6), data: fields.subarray(8), error: payload[0] === 8 }
}

// Decodes a frequency report with two full unsigned 32-bit counters.
export function decodeFrequencyReport(payload: Buffer): FrequencyReport | undefined {
	if (payload.length !== 12 || payload[0] !== 2) return undefined
	return { pin: payload[1], timestamp: decodeUnsigned7(payload, 2, 5), ticks: decodeUnsigned7(payload, 7, 5) }
}

// Decodes a system-variable status and optional signed int32 value.
export function decodeSystemVariableReply(payload: Buffer): SystemVariableReply | undefined {
	if ((payload.length !== 6 && payload.length !== 11) || (payload[0] !== 0 && payload[0] !== 1)) return undefined
	if ((payload[2] === 0 || payload[2] === 1) && payload.length !== 11) return undefined
	return { operation: payload[0], dataType: payload[1], status: payload[2], id: decodeUnsigned7(payload, 3, 2), pin: payload[5] === 127 ? undefined : payload[5], value: payload.length === 11 ? decodeSigned32(payload, 6) : undefined }
}
