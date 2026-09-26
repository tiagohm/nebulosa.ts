import type { NumberArray } from '../../../math/numerical/math'
import { decodePacked7Bit, encodePacked7Bit, encodeUnsigned7 } from './numeric'

// SPI Firmata 0x68 payload codecs. A configured device uses eight-bit words; outgoing
// transfer encoders allocate a new wire payload and reply decoding allocates received data.

// SPI channel, numbered 0-7 by the protocol; the bundled ESP8266 firmware accepts channel 0.
export type SpiChannel = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7

// Clock polarity and phase mode, 0-3.
export type SpiDataMode = 0 | 1 | 2 | 3

// Device configuration; bit order and CS polarity use their electrical meanings.
export interface SpiDeviceOptions {
	// Bus channel; the bundled firmware supports only 0.
	readonly channel: SpiChannel
	// Device number within the channel, 0-15.
	readonly deviceId: number
	// Least-significant or most-significant bit first; defaults to MSB.
	readonly bitOrder?: 'lsb' | 'msb'
	// SPI CPOL/CPHA mode; defaults to 0.
	readonly dataMode?: SpiDataMode
	// Maximum clock rate in hertz; zero requests the firmware default.
	readonly maxSpeed?: number
	// Word size in bits; the bundled firmware accepts 0 (default eight) or 8.
	readonly wordSize?: 0 | 8
	// Whether firmware controls chip select; defaults to true when a CS pin is supplied.
	readonly controlCs?: boolean
	// Whether chip select is active high; defaults to false. The bundled ESP8266
	// SpiFirmata currently drives LOW/HIGH regardless of this flag.
	readonly csActiveHigh?: boolean
	// Chip-select pin, 0-127; ignored when firmware CS control is disabled.
	readonly csPin?: number
	// Whether data uses dense 7-bit packing; defaults to ordinary two-byte encoding.
	readonly packed?: boolean
}

// Reply to a transfer, read or acknowledged write. Data is newly allocated and may be empty.
export interface SpiReply {
	// Bus channel, 0-7.
	readonly channel: SpiChannel
	// Device identifier, 0-15.
	readonly deviceId: number
	// Per-client request identifier, 0-127.
	readonly requestId: number
	// Received eight-bit words in transfer order.
	readonly data: Buffer
}

// Combines channel and device into the protocol's seven-bit selector.
export function spiSelector(channel: SpiChannel, deviceId: number): number {
	return (deviceId << 3) | channel
}

// Encodes a device configuration payload after SPI_DATA, including its 32-bit speed.
export function encodeSpiConfig(options: SpiDeviceOptions): number[] {
	const { channel, deviceId, bitOrder = 'msb', dataMode = 0, maxSpeed = 0, wordSize = 0, controlCs = options.csPin !== undefined, csActiveHigh = false, csPin = 0, packed = false } = options
	return [1, spiSelector(channel, deviceId), (packed ? 8 : 0) | (dataMode << 1) | (bitOrder === 'msb' ? 1 : 0), ...encodeUnsigned7(maxSpeed, 5), wordSize, (controlCs ? 1 : 0) | (csActiveHigh ? 2 : 0), csPin]
}

// Encodes transfer/write words with the requested packing and a single 7-bit word count.
export function encodeSpiWords(command: 2 | 3 | 4 | 7, selector: number, requestId: number, data: Readonly<NumberArray> | Buffer, packed: boolean, deselectCs: boolean): number[] {
	const output = [command, selector, requestId, deselectCs ? 1 : 0, data.length]
	if (packed) for (const byte of encodePacked7Bit(data)) output.push(byte)
	else for (const byte of data) output.push(byte & 0x7f, byte >>> 7)
	return output
}

// Decodes one complete SPI_REPLY payload, or ignores malformed lengths and unknown framing.
export function decodeSpiReply(payload: Buffer, packed: boolean): SpiReply | undefined {
	if (payload.length < 4 || payload[0] !== 5) return undefined
	const count = payload[3]
	const wireLength = packed ? Math.ceil((count * 8) / 7) : count * 2
	if (payload.length !== 4 + wireLength) return undefined
	const data = packed ? decodePacked7Bit(payload, 4, wireLength) : Buffer.alloc(count)
	if (!packed) for (let i = 0; i < count; i++) data[i] = payload[4 + i * 2] | (payload[5 + i * 2] << 7)
	return { channel: (payload[1] & 7) as SpiChannel, deviceId: payload[1] >>> 3, requestId: payload[2], data }
}
