import type { NumberArray } from '../../../math/numerical/math'
import type { SerialPort } from '../types'
import { encodeUnsigned7 } from './numeric'

// Serial 1.0 payload codecs. Returned arrays contain only seven-bit bytes and are
// framed by the client with the SERIAL_MESSAGE feature command.

// Encodes baud and optional paired RX/TX pins for hardware or software serial.
export function encodeSerialConfig(port: SerialPort, baud: number, rx?: number, tx?: number): number[] {
	if ((rx === undefined) !== (tx === undefined)) throw new RangeError('Serial RX and TX pins must be configured together')
	const payload = [0x10 | port, ...encodeUnsigned7(baud, 3)]
	if (rx !== undefined && tx !== undefined) payload.push(rx, tx)
	return payload
}

// Encodes raw bytes into 7-bit pairs for a Serial 1.0 port.
export function encodeSerialWrite(port: SerialPort, data: Readonly<NumberArray> | Buffer): number[] {
	const payload = [0x20 | port]
	for (const byte of data) payload.push(byte & 127, byte >>> 7)
	return payload
}
