import { afterEach, describe, expect, test } from 'bun:test'
import { type AnalogMapping, type FirmataClientHandler, FirmataSimpleClient, PinMode, decodeBufferAs7Bit, encodeBufferAs7Bit } from '../src/firmata'

describe('simple', () => {
	const result: unknown[] = []

	const protocol: FirmataClientHandler = {
		version: (a, b) => result.push(a, b),
		firmwareMessage: (a, b, c) => result.push(a, b, c),
		systemReset: () => result.push(true),
		digitalMessage: (a, b) => result.push(a, b),
		analogMessage: (a, b) => result.push(a, b),
		pinCapability: (a, b) => result.push(a, Array.from(b.values())),
		pinCapabilitiesFinished: () => result.push(true),
		analogMapping: (a) => result.push(a),
		pinState: (a, b, c) => result.push(a, b, c),
		textMessage: (a) => result.push(a),
		customMessage: (a, b) => result.push(a, b),
	}

	const client = new FirmataSimpleClient(protocol)

	afterEach(() => {
		result.length = 0
	})

	test('version', () => {
		client.parse(Buffer.from([0xf9, 1, 2]))
		expect(result[0]).toBe(1)
		expect(result[1]).toBe(2)
	})

	test('firmwareMessage', () => {
		client.parse(Buffer.from([0xf0, 0x79, 2, 3, 65, 0, 66, 0, 67, 0, 0xf7]))
		expect(result[0]).toBe(2)
		expect(result[1]).toBe(3)
		expect(result[2]).toBe('ABC')
	})

	test('systemReset', () => {
		const client = new FirmataSimpleClient(protocol)
		client.parse(Buffer.from([0xff]))
		expect(result[0]).toBe(true)
	})

	test('digitalMessage', () => {
		client.parse(Buffer.from([0x91, 0x55, 0]))

		for (let i = 0; i < 16; i += 2) {
			expect(result[i]).toBe(8 + i / 2)
			expect(result[i + 1]).toBe(~(i / 2) & 1)
		}
	})

	test('analogMessage', () => {
		client.parse(Buffer.from([0xf0, 0x6f, 1, 4, 4, 0xf7]))
		expect(result[0]).toBe(1)
		expect(result[1]).toBe(516)
	})

	test('pinCapability', () => {
		client.parse(Buffer.from([0xf0, 0x6c, 1, 0, 2, 0, 11, 0, 0x7f, 3, 0, 4, 0, 0x7f, 0xf7]))
		expect(result[0]).toBe(0)
		expect(result[1]).toEqual([1, 2, 11])
		expect(result[2]).toBe(1)
		expect(result[3]).toEqual([3, 4])
		expect(result[4]).toBe(true)
	})

	test('analogMapping', () => {
		client.parse(Buffer.from([0xf0, 0x6a, 0x7f, 0x7f, 1, 2, 3, 0xf7]))
		const mapping = result[0] as AnalogMapping
		expect(Object.keys(mapping)).toEqual(['1', '2', '3'])
		expect(mapping[1]).toBe(2)
		expect(mapping[2]).toBe(3)
		expect(mapping[3]).toBe(4)
	})

	test('pinState', () => {
		client.parse(Buffer.from([0xf0, 0x6e, 5, 1, 3, 0xf7]))
		expect(result[0]).toBe(5)
		expect(result[1]).toBe(PinMode.OUTPUT)
		expect(result[2]).toBe(3)
	})

	test('textMessage', () => {
		client.parse(Buffer.from([0xf0, 0x71, 112, 1, 31, 1, 24, 1, 10, 1, 0xf7]))
		expect(result[0]).toBe('😊')
	})

	test('customMessage', () => {
		client.parse(Buffer.from([0xf0, 1, 65, 0, 66, 0, 67, 0, 0xf7]))
		const buffer = result[0] as Buffer
		expect(buffer.readInt8(0)).toBe(1)
		expect(buffer.toString('utf-16le', 1, 7)).toBe('ABC')
		expect(result[1]).toBe(7)
	})
})

test('encode & decode', () => {
	const data = encodeBufferAs7Bit(Buffer.from('😊'))
	expect(decodeBufferAs7Bit(data).toString()).toBe('😊')
})
