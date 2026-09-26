import type { NumberArray } from '../../../math/numerical/math'
import { encodePacked7Bit, encodeUnsigned7 } from './numeric'

// Scheduler Firmata payload encoding. Messages are packed into seven-bit bytes;
// delays use the firmware's signed 32-bit millisecond range.

// Encodes a task message as dense seven-bit bytes.
export function encodeSchedulerAdd(id: number, message: Readonly<NumberArray> | Buffer): number[] {
	return [2, id, ...encodePacked7Bit(message)]
}

// Encodes a non-negative scheduler delay within the firmware's signed 32-bit range.
export function encodeSchedulerDelay(milliseconds: number): number[] {
	if (!(Number.isInteger(milliseconds) && milliseconds >= 0 && milliseconds <= 0x7fffffff)) throw new RangeError('Scheduler delay must be 0-2147483647 milliseconds')
	return [3, ...encodeUnsigned7(milliseconds, 5)]
}

// Encodes scheduling task `id` after a signed 32-bit delay in milliseconds.
export function encodeSchedulerSchedule(id: number, milliseconds: number): number[] {
	if (!(Number.isInteger(milliseconds) && milliseconds >= 0 && milliseconds <= 0x7fffffff)) throw new RangeError('Scheduler delay must be 0-2147483647 milliseconds')
	return [4, id, ...encodeUnsigned7(milliseconds, 5)]
}
