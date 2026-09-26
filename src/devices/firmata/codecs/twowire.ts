import type { NumberArray } from '../../../math/numerical/math'
import * as Firmata from '../protocol'
import type { TwoWireAddressMode, TwoWireAutoRestartMode, TwoWireOperationMode } from '../types'
import { encodeByteAs7Bit, writeValueAsTwo7bitBytes } from './numeric'

// I2C Firmata command codecs. Each call allocates one complete outbound SysEx frame;
// the client owns the shared maximum read delay and transport writes.

// Encodes the effective I2C read delay in microseconds as a 14-bit configuration frame.
export function encodeTwoWireConfig(delayInMicroseconds: number): Uint8Array {
	const message = new Uint8Array([Firmata.START_SYSEX, Firmata.TWO_WIRE_CONFIG, 0, 0, Firmata.END_SYSEX])
	writeValueAsTwo7bitBytes(message, 2, delayInMicroseconds)
	return message
}

// Encodes one I2C operation with seven- or ten-bit addressing and optional raw data.
export function encodeTwoWireReadWrite(address: number, operationMode: TwoWireOperationMode, data?: Readonly<NumberArray> | Buffer, addressMode: TwoWireAddressMode = 7, autoRestart: TwoWireAutoRestartMode = 'stop'): Buffer {
	const message = Buffer.alloc(5 + (data !== undefined ? data.length * 2 : 0))
	message[0] = Firmata.START_SYSEX
	message[1] = Firmata.TWO_WIRE_REQUEST
	message[2] = address & 0x7f
	message[3] =
		((address >>> 7) & 0x7) | (operationMode === 'write' ? Firmata.TWO_WIRE_WRITE : operationMode === 'read' ? Firmata.TWO_WIRE_READ : operationMode === 'readContinuously' ? Firmata.TWO_WIRE_READ_CONTINUOUS : Firmata.TWO_WIRE_STOP_READ) | (addressMode === 7 ? 0 : 0x20) | (autoRestart === 'restart' ? 0x40 : 0)

	if (data !== undefined) for (let i = 0, offset = 4; i < data.length; i++, offset += 2) encodeByteAs7Bit(data[i], message, offset)
	message[message.byteLength - 1] = Firmata.END_SYSEX
	return message
}
