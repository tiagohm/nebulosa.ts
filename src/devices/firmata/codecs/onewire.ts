import * as Firmata from '../protocol'
import type { OneWireCommandOptions, OneWirePowerMode, OneWireSearchMode } from '../types'
import { encodePacked7Bit } from './numeric'

// 1-Wire Firmata command codecs. Frames are newly allocated, while the caller owns
// the per-client read correlation cursor returned with each encoded command.

// Frames the power mode for a physical 1-Wire pin.
export function encodeOneWireConfig(pin: number, powerMode: OneWirePowerMode): Uint8Array {
	return new Uint8Array([Firmata.START_SYSEX, Firmata.ONE_WIRE_DATA, Firmata.ONE_WIRE_CONFIG_REQUEST, pin, powerMode === 'parasitic' ? 0 : 1, Firmata.END_SYSEX])
}

// Frames an all-ROM or alarm-ROM search on a physical 1-Wire pin.
export function encodeOneWireSearch(pin: number, mode: OneWireSearchMode): Uint8Array {
	return new Uint8Array([Firmata.START_SYSEX, Firmata.ONE_WIRE_DATA, mode === 'alarms' ? Firmata.ONE_WIRE_SEARCH_ALARMS_REQUEST : Firmata.ONE_WIRE_SEARCH_REQUEST, pin, Firmata.END_SYSEX])
}

// Encodes a reset/selection/read/delay/write command. Invalid ROM combinations throw
// before advancing the supplied 16-bit correlation cursor; explicit IDs leave it alone.
export function encodeOneWireCommand(pin: number, options: OneWireCommandOptions, nextCorrelationId: number): { message: Buffer; readCorrelationId?: number; nextCorrelationId: number } {
	const { reset = false, skip = false, address, bytesToRead, correlationId, delay, data } = options
	if (skip && address !== undefined) throw new RangeError('One-Wire command cannot skip ROM and select ROM at the same time')
	if (address !== undefined && address.length !== 8) throw new RangeError(`One-Wire address must contain 8 bytes. Received ${address.length}`)

	let command = 0
	if (reset) command |= Firmata.ONE_WIRE_RESET_REQUEST_BIT
	if (skip) command |= Firmata.ONE_WIRE_SKIP_REQUEST_BIT

	const payload: number[] = []
	if (address !== undefined) {
		command |= Firmata.ONE_WIRE_SELECT_REQUEST_BIT
		for (let i = 0; i < address.length; i++) payload.push(address[i] & 0xff)
	}

	let readCorrelationId: number | undefined
	if (bytesToRead !== undefined) {
		command |= Firmata.ONE_WIRE_READ_REQUEST_BIT
		const n = Math.max(0, Math.min(0xffff, bytesToRead))
		readCorrelationId = (correlationId ?? nextCorrelationId) & 0xffff
		if (correlationId === undefined) nextCorrelationId = (nextCorrelationId + 1) & 0xffff
		payload.push(n & 0xff, (n >>> 8) & 0xff, readCorrelationId & 0xff, (readCorrelationId >>> 8) & 0xff)
	}

	if (delay !== undefined) {
		command |= Firmata.ONE_WIRE_DELAY_REQUEST_BIT
		const ms = Math.max(0, Math.min(0xffffffff, delay))
		payload.push(ms & 0xff, (ms >>> 8) & 0xff, (ms >>> 16) & 0xff, (ms >>> 24) & 0xff)
	}

	if (data !== undefined) {
		command |= Firmata.ONE_WIRE_WRITE_REQUEST_BIT
		for (let i = 0; i < data.length; i++) payload.push(data[i] & 0xff)
	}

	const encodedData = payload.length > 0 ? encodePacked7Bit(payload) : undefined
	const message = Buffer.alloc(5 + (encodedData?.length ?? 0))
	message[0] = Firmata.START_SYSEX
	message[1] = Firmata.ONE_WIRE_DATA
	message[2] = command
	message[3] = pin
	if (encodedData) encodedData.copy(message, 4)
	message[message.length - 1] = Firmata.END_SYSEX
	return { message, readCorrelationId, nextCorrelationId }
}
