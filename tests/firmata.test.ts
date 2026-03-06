import { afterEach, describe, expect, test } from 'bun:test'
import { type AnalogMapping, FirmataClient, type FirmataClientHandler, PinMode, type Transport } from '../src/firmata'

describe('process', () => {
	const result: unknown[] = []

	const protocol: FirmataClientHandler = {
		version: (_, a, b) => result.push(a, b),
		firmwareMessage: (_, a, b, c) => result.push(a, b, c),
		systemReset: () => result.push(true),
		digitalMessage: (_, a, b) => result.push(a, b),
		analogMessage: (_, a, b) => result.push(a, b),
		pinCapability: (_, a, b) => result.push(a, [...b]),
		pinCapabilitiesFinished: () => result.push(true),
		analogMapping: (_, a) => result.push(a),
		pinState: (_, a, b, c) => result.push(a, b, c),
		textMessage: (_, a) => result.push(a),
		customMessage: (_, a) => result.push(a),
		twoWireMessage: (_, a, b, c) => result.push(a, b, c),
	}

	const transport: Transport = {
		write: () => {},
		flush: () => {},
		close: () => {},
	}

	using client = new FirmataClient(transport)
	client.addHandler(protocol)

	afterEach(() => {
		result.length = 0
	})

	test('version', () => {
		client.process(Buffer.from([0xf9, 1, 2]))
		expect(result[0]).toBe(1)
		expect(result[1]).toBe(2)
	})

	test('firmware message', () => {
		client.process(Buffer.from([0xf0, 0x79, 2, 3, 65, 0, 66, 0, 67, 0, 0xf7]))
		expect(result[0]).toBe(2)
		expect(result[1]).toBe(3)
		expect(result[2]).toBe('ABC')
	})

	test('system reset', () => {
		client.process(Buffer.from([0xff]))
		expect(result[0]).toBe(true)
	})

	test('digital message', () => {
		client.process(Buffer.from([0x91, 0x55, 0]))

		for (let i = 0; i < 16; i += 2) {
			expect(result[i]).toBe(8 + i / 2)
			expect(result[i + 1]).toBe(~(i / 2) & 1)
		}
	})

	test('analog message', () => {
		client.process(Buffer.from([0xf0, 0x6f, 1, 4, 4, 0xf7]))
		expect(result[0]).toBe(1)
		expect(result[1]).toBe(516)
	})

	test('pin capability', () => {
		client.process(Buffer.from([0xf0, 0x6c, 1, 0, 2, 0, 11, 0, 0x7f, 3, 0, 4, 0, 0x7f, 0xf7]))
		expect(result[0]).toBe(0)
		expect(result[1]).toEqual([1, 2, 11])
		expect(result[2]).toBe(1)
		expect(result[3]).toEqual([3, 4])
		expect(result[4]).toBe(true)
	})

	test('analog mapping', () => {
		client.process(Buffer.from([0xf0, 0x6a, 0x7f, 0x7f, 1, 2, 3, 0xf7]))
		const mapping = result[0] as AnalogMapping
		expect(Object.keys(mapping)).toEqual(['1', '2', '3'])
		expect(mapping[1]).toBe(2)
		expect(mapping[2]).toBe(3)
		expect(mapping[3]).toBe(4)
	})

	test('pin state', () => {
		client.process(Buffer.from([0xf0, 0x6e, 5, 1, 3, 0xf7]))
		expect(result[0]).toBe(5)
		expect(result[1]).toBe(PinMode.OUTPUT)
		expect(result[2]).toBe(3)
	})

	test('text message', () => {
		client.process(Buffer.from([0xf0, 0x71, 112, 1, 31, 1, 24, 1, 10, 1, 0xf7]))
		expect(result[0]).toBe('😊')
	})

	test('custom message', () => {
		client.process(Buffer.from([0xf0, 1, 65, 0, 66, 0, 67, 0, 0xf7]))
		const buffer = result[0] as Buffer
		expect(buffer[0]).toBe(1)
		expect(buffer.toString('utf-16le', 1, 7)).toBe('ABC')
	})

	test('two-wire message', () => {
		client.process(Buffer.from([0xf0, 0x77, 0x22, 0x00, 0x44, 0x00, 0x01, 0x00, 0x02, 0x00, 0x03, 0x00, 0xf7]))
		expect(result[0]).toBe(0x22)
		expect(result[1]).toBe(0x44)
		expect(result[2]).toEqual(Buffer.from([1, 2, 3]))
	})
})
