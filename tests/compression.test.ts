import { expect, test } from 'bun:test'
import { compressRice, decompressRice, type RiceTypedArray } from '../src/compression'

function makeSequence(length: number, seed = 1) {
	const sequence = new Int32Array(length)

	for (let i = 0; i < length; i++) {
		seed = seed * 1664525 + 1013904223
		sequence[i] = seed
	}

	return sequence
}

function roundTrip(input: RiceTypedArray, blockSize: number = 32) {
	const compressed = compressRice(input, blockSize)
	const decompressed = new (input.constructor as { new (length: number): RiceTypedArray })(input.length)
	decompressRice(compressed, decompressed, blockSize)
	expect(Array.from(decompressed)).toEqual(Array.from(input))
}

test('compress/decompress supports empty arrays', () => {
	const input = new Int16Array(0)
	const compressed = compressRice(input)
	expect(compressed.length).toBe(0)

	const decompressed = new Int16Array(0)
	expect(decompressRice(compressed, decompressed)).toBe(decompressed)
})

test('matches low-entropy 8-bit reference bytes', () => {
	const input = new Int8Array([5, 5, 5, 5])
	const compressed = compressRice(input)

	expect(Array.from(compressed)).toEqual([0x05, 0x00])

	const decompressed = new Int8Array(input.length)
	decompressRice(compressed, decompressed)
	expect(Array.from(decompressed)).toEqual(Array.from(input))
})

test('matches normal 8-bit reference bytes', () => {
	const input = new Int8Array([0, 1])
	const compressed = compressRice(input, 2)

	expect(Array.from(compressed)).toEqual([0x00, 0x32])

	const decompressed = new Int8Array(input.length)
	decompressRice(compressed, decompressed, 2)
	expect(Array.from(decompressed)).toEqual(Array.from(input))
})

test('matches high-entropy 8-bit reference bytes', () => {
	const input = new Int8Array([0, -128])
	const compressed = compressRice(input, 2)

	expect(Array.from(compressed)).toEqual([0x00, 0xe0, 0x1f, 0xe0])

	const decompressed = new Int8Array(input.length)
	decompressRice(compressed, decompressed, 2)
	expect(Array.from(decompressed)).toEqual(Array.from(input))
})

test('matches low-entropy 16-bit reference bytes', () => {
	const input = new Int16Array([0x1234, 0x1234])
	const compressed = compressRice(input, 2)

	expect(Array.from(compressed)).toEqual([0x12, 0x34, 0x00])

	const decompressed = new Int16Array(input.length)
	decompressRice(compressed, decompressed, 2)
	expect(Array.from(decompressed)).toEqual(Array.from(input))
})

test('matches low-entropy 32-bit reference bytes', () => {
	const input = new Int32Array([0x12345678, 0x12345678])
	const compressed = compressRice(input, 2)

	expect(Array.from(compressed)).toEqual([0x12, 0x34, 0x56, 0x78, 0x00])

	const decompressed = new Int32Array(input.length)
	decompressRice(compressed, decompressed, 2)
	expect(Array.from(decompressed)).toEqual(Array.from(input))
})

test('roundtrip int8 and uint8', () => {
	const source = makeSequence(257, 42)
	const i8 = new Int8Array(source.length)
	const u8 = new Uint8Array(source.length)

	for (let i = 0; i < source.length; i++) {
		i8[i] = source[i]
		u8[i] = source[i]
	}

	roundTrip(i8, 16)
	roundTrip(i8, 32)
	roundTrip(u8, 16)
	roundTrip(u8, 32)
})

test('roundtrip int16 and uint16', () => {
	const source = makeSequence(513, 7)
	const i16 = new Int16Array(source.length)
	const u16 = new Uint16Array(source.length)

	for (let i = 0; i < source.length; i++) {
		i16[i] = source[i]
		u16[i] = source[i]
	}

	roundTrip(i16, 16)
	roundTrip(i16, 32)
	roundTrip(u16, 16)
	roundTrip(u16, 32)
})

test('roundtrip int32 and uint32', () => {
	const source = makeSequence(513, 99)
	const i32 = new Int32Array(source)
	const u32 = new Uint32Array(source.length)

	for (let i = 0; i < source.length; i++) u32[i] = source[i]

	roundTrip(i32, 16)
	roundTrip(i32, 32)
	roundTrip(u32, 16)
	roundTrip(u32, 32)
})

test('decodes into caller-provided output buffer', () => {
	const input = new Int16Array([1, 1, 1, 2, 3, 5, 8, 13, 21])
	const compressed = compressRice(input, 4)
	const output = new Int16Array(input.length)

	const decompressed = decompressRice(compressed, output, 4)
	expect(decompressed).toBe(output)
	expect(Array.from(output)).toEqual(Array.from(input))
})
