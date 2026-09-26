import type { NumberArray } from '../../../math/numerical/math'

// Numeric Firmata wire codecs. Values are carried least-significant 7-bit group first;
// these helpers allocate small command payloads and never use 32-bit bitwise shifts for unsigned values.

// Encodes an unsigned integer into a fixed number of 7-bit wire bytes.
export function encodeUnsigned7(value: number, bytes: number): number[] {
	const output = new Array<number>(bytes)
	let remaining = value
	for (let i = 0; i < bytes; i++) {
		output[i] = remaining % 128
		remaining = Math.floor(remaining / 128)
	}
	return output
}

// Decodes `bytes` least-significant-first 7-bit groups from `offset` as an unsigned integer.
export function decodeUnsigned7(input: Uint8Array, offset: number, bytes: number): number {
	let value = 0
	let place = 1
	for (let i = 0; i < bytes; i++) {
		value += input[offset + i] * place
		place *= 128
	}
	return value
}

// Encodes a signed 32-bit system variable using its two's-complement bit pattern.
export function encodeSigned32(value: number): number[] {
	return encodeUnsigned7(value >>> 0, 5)
}

// Decodes a five-byte 32-bit two's-complement value without losing its sign.
export function decodeSigned32(input: Uint8Array, offset: number): number {
	const unsigned = decodeUnsigned7(input, offset, 5)
	return unsigned >= 0x80000000 ? unsigned - 0x100000000 : unsigned
}

// Encodes an AccelStepper position as 31-bit magnitude plus sign bit 3 of byte five.
// The upstream firmware cannot represent -2^31 in this format.
export function encodeStepperPosition(value: number): number[] {
	const bytes = encodeUnsigned7(Math.abs(value), 5)
	if (value < 0) bytes[4] |= 8
	return bytes
}

// Decodes an AccelStepper position from its sign-magnitude wire representation.
export function decodeStepperPosition(input: Uint8Array, offset: number): number {
	const magnitude = decodeUnsigned7(input, offset, 4) + (input[offset + 4] & 7) * 0x10000000
	return input[offset + 4] & 8 ? -magnitude : magnitude
}

// Encodes AccelStepper steps/s or steps/s² as a 23-bit decimal significand, four-bit
// exponent biased by 11, and sign bit. Values outside the format's range saturate.
export function encodeStepperFloat(value: number): number[] {
	if (value === 0) return [0, 0, 0, 0]
	const magnitude = Math.abs(value)
	let exponent = 0
	while (exponent < 15 && magnitude / 10 ** (exponent - 11) > 0x7fffff) exponent++
	const significand = Math.min(0x7fffff, Math.trunc(magnitude / 10 ** (exponent - 11)))
	return [significand & 127, Math.floor(significand / 128) & 127, Math.floor(significand / 16384) & 127, Math.floor(significand / 0x200000) | (exponent << 2) | (value < 0 ? 64 : 0)]
}

// Decodes the AccelStepper custom decimal float into steps/s or steps/s².
export function decodeStepperFloat(input: Uint8Array, offset: number): number {
	const tail = input[offset + 3]
	const significand = decodeUnsigned7(input, offset, 3) + (tail & 3) * 0x200000
	return significand * 10 ** (((tail >>> 2) & 15) - 11) * (tail & 64 ? -1 : 1)
}

// Unpacks dense 7-bit data (seven raw bytes occupy eight wire bytes).
export function decodePacked7Bit(input: Readonly<NumberArray> | Buffer, offset: number = 0, length: number = input.length - offset): Buffer {
	const output = Buffer.alloc(Math.floor(Math.max(0, length) * 0.875))
	for (let i = 0; i < output.length; i++) {
		const bitOffset = i * 8
		const p = Math.floor(bitOffset / 7)
		const s = bitOffset % 7
		output[i] = (((input[offset + p] ?? 0) >>> s) | ((input[offset + p + 1] ?? 0) << (7 - s))) & 0xff
	}
	return output
}

// Packs raw bytes densely into 7-bit-safe wire bytes.
export function encodePacked7Bit(input: Readonly<NumberArray> | Buffer, offset: number = 0, length: number = input.length - offset): Buffer {
	const output = Buffer.alloc(Math.ceil((Math.max(0, length) * 8) / 7))
	for (let i = 0; i < length; i++) {
		const value = input[offset + i] & 0xff
		const bitOffset = i * 8
		const p = Math.floor(bitOffset / 7)
		const s = bitOffset % 7
		output[p] |= (value << s) & 0x7f
		if (p + 1 < output.length) output[p + 1] |= (value >>> (7 - s)) & 0x7f
	}
	return output
}
