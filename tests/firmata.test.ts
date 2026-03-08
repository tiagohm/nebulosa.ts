import { afterEach, describe, expect, test } from 'bun:test'
import { type AnalogMapping, BMP180, BMP280, decodePacked7Bit, ESP8266, encodePacked7Bit, FirmataClient, type FirmataClientHandler, PinMode, type Transport } from '../src/firmata'

describe('command decoding', () => {
	const result: unknown[] = []

	const protocol: FirmataClientHandler = {
		version: (_, major, minor) => result.push(major, minor),
		firmwareMessage: (_, major, minor, name) => result.push(major, minor, name),
		systemReset: () => result.push(true),
		digitalMessage: (_, id, value) => result.push(id, value),
		analogMessage: (_, port, value) => result.push(port, value),
		pinCapability: (_, id, modes) => result.push(id, [...modes]),
		pinCapabilitiesFinished: () => result.push(true),
		analogMapping: (_, mapping) => result.push(mapping),
		pinState: (_, id, mode, value) => result.push(id, mode, value),
		textMessage: (_, message) => result.push(message),
		customMessage: (_, data) => result.push(data),
		twoWireMessage: (_, address, register, data) => result.push(address, register, data),
		oneWireSearchReply: (_, pin, addresses, alarms) => result.push(pin, alarms, addresses.map(Buffer.from)),
		oneWireReadReply: (_, pin, correlationId, data) => result.push(pin, correlationId, data),
	}

	const transport: Transport = {
		write: () => {},
		flush: () => {},
		close: () => {},
	}

	const esp8266 = new ESP8266()
	using client = new FirmataClient(transport, esp8266)
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

	test('one-wire search reply', () => {
		const addresses = Buffer.from([0x28, 0x1a, 0xbc, 0x4d, 0x2f, 0x00, 0x00, 0xc1, 0x28, 0xff, 0x2a, 0x01, 0x2f, 0x00, 0x00, 0x7e])

		client.process(Buffer.from([0xf0, 0x73, 0x42, 4, ...encodePacked7Bit(addresses), 0xf7]))
		expect(result[0]).toBe(4)
		expect(result[1]).toBe(false)
		expect(result[2]).toEqual([addresses.subarray(0, 8), addresses.subarray(8, 16)])
	})

	test('one-wire read reply', () => {
		client.process(Buffer.from([0xf0, 0x73, 0x43, 2, ...encodePacked7Bit(Buffer.from([0x34, 0x12, 0xaa, 0xbb, 0xcc])), 0xf7]))
		expect(result[0]).toBe(2)
		expect(result[1]).toBe(0x1234)
		expect(result[2]).toEqual(Buffer.from([0xaa, 0xbb, 0xcc]))
	})
})

describe('command encoding', () => {
	const transport: Transport = {
		write: () => {},
		flush: () => {},
		close: () => {},
	}

	const esp8266 = new ESP8266()
	using client = new FirmataClient(transport, esp8266)
	const messages: Buffer[] = []

	client.send = (message) => {
		if (typeof message === 'string') {
			messages.push(Buffer.from(message))
		} else if (ArrayBuffer.isView(message)) {
			messages.push(Buffer.from(message.buffer, message.byteOffset, message.byteLength))
		} else {
			messages.push(Buffer.from(message))
		}
	}

	afterEach(() => {
		messages.length = 0
	})

	test('one-wire config', () => {
		client.oneWireConfig(5)
		expect(messages[0]).toEqual(Buffer.from([0xf0, 0x73, 0x41, 5, 1, 0xf7]))
	})

	test('one-wire search alarms', () => {
		client.oneWireSearch(6, 'alarms')
		expect(messages[0]).toEqual(Buffer.from([0xf0, 0x73, 0x44, 6, 0xf7]))
	})

	test('one-wire command with select, read, delay and write', () => {
		const correlationId = client.oneWireCommand(7, {
			reset: true,
			address: Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]),
			bytesToRead: 3,
			correlationId: 0x2211,
			delay: 5,
			data: Buffer.from([0xaa, 0xbb]),
		})

		expect(correlationId).toBe(0x2211)

		const payload = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 3, 0, 0x11, 0x22, 5, 0, 0, 0, 0xaa, 0xbb])
		expect(messages[0]).toEqual(Buffer.from([0xf0, 0x73, 0x3d, 7, ...encodePacked7Bit(payload), 0xf7]))
	})

	test('one-wire read generates auto correlation id', () => {
		expect(client.oneWireRead(4, 2)).toBe(0)
		expect(client.oneWireRead(4, 2)).toBe(1)

		expect(messages[0].subarray(0, 4)).toEqual(Buffer.from([0xf0, 0x73, 0x0b, 4]))
		expect(messages[1].subarray(0, 4)).toEqual(Buffer.from([0xf0, 0x73, 0x0b, 4]))
		expect(decodePacked7Bit(messages[0], 4, messages[0].length - 5)).toEqual(Buffer.from([2, 0, 0, 0]))
		expect(decodePacked7Bit(messages[1], 4, messages[1].length - 5)).toEqual(Buffer.from([2, 0, 1, 0]))
	})
})

test('BMP180 calculate true temperature & pressure', () => {
	const bmp180 = new BMP180(undefined as never, 0)
	expect(bmp180.calculateTrueTemperature(27898)).toBe(15)
	expect(bmp180.calculateTruePressure(23843)).toBe(69964)
})

test('BMP280 compensate temperature & pressure', () => {
	const bmp280 = new BMP280(undefined as never, 0)
	expect(bmp280.compensateTemperature(519888)).toBeCloseTo(25.08, 2)
	expect(bmp280.compensatePressure(415148)).toBeCloseTo(100653.27, 2)
})
