import { afterEach, describe, expect, test } from 'bun:test'
import { type AnalogMapping, decodePacked7Bit, encodePacked7Bit, FirmataClient, type FirmataClientHandler, PinMode, type Transport, type TwoWireAddressMode, type TwoWireAutoRestartMode } from '../src/firmata'
import { ESP8266 } from '../src/firmata.board'
import { BMP180, BMP280, MAX44009 } from '../src/firmata.peripheral'

type MockFirmataMessage = readonly ['config', number] | readonly ['write', number, Buffer] | readonly ['read', number, number, number, boolean, TwoWireAddressMode, TwoWireAutoRestartMode]

class MockFirmataClient {
	readonly messages: MockFirmataMessage[] = []
	readonly handlers = new Set<FirmataClientHandler>()

	addHandler(handler: FirmataClientHandler) {
		this.handlers.add(handler)
	}

	removeHandler(handler: FirmataClientHandler) {
		this.handlers.delete(handler)
	}

	twoWireConfig(delayInMicroseconds: number) {
		this.messages.push(['config', delayInMicroseconds])
	}

	twoWireWrite(address: number, data?: Buffer | readonly number[]) {
		this.messages.push(['write', address, Buffer.from(data ?? [])])
	}

	twoWireRead(address: number, register: number, bytesToRead: number, continuous: boolean = false, addressMode: 7 | 10 = 7, autoRestart: 'stop' | 'restart' = 'stop') {
		this.messages.push(['read', address, register, bytesToRead, continuous, addressMode, autoRestart])
	}
}

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
		oneWireSearchReply: (_, pin, addresses, alarms) => result.push(pin, alarms, addresses),
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
		expect(result[0]).toBeTrue()
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
		expect(result[4]).toBeTrue()
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
		expect(result[1]).toBeFalse()
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

	test('request command messages', () => {
		client.requestFirmware()
		client.requestPinCapability()
		client.requestPinState(12)
		client.requestAnalogMapping()

		expect(messages[0]).toEqual(Buffer.from([0xf0, 0x79, 0xf7]))
		expect(messages[1]).toEqual(Buffer.from([0xf0, 0x6b, 0xf7]))
		expect(messages[2]).toEqual(Buffer.from([0xf0, 0x6d, 12, 0xf7]))
		expect(messages[3]).toEqual(Buffer.from([0xf0, 0x69, 0xf7]))
	})

	test('digital and analog report commands', () => {
		client.requestDigitalReport(true)
		client.requestDigitalPinReport(6, false)
		client.requestAnalogReport(false)
		client.requestAnalogPinReport(ESP8266.A0, true)

		const digitalReport = Buffer.alloc(32)
		for (let i = 0, p = 0; i < 16; i++) {
			digitalReport[p++] = 0xd0 | i
			digitalReport[p++] = 1
		}

		const analogReport = Buffer.alloc(32)
		for (let i = 0, p = 0; i < 16; i++) {
			analogReport[p++] = 0xc0 | i
			analogReport[p++] = 0
		}

		expect(messages[0]).toEqual(digitalReport)
		expect(messages[1]).toEqual(Buffer.from([0xd6, 0]))
		expect(messages[2]).toEqual(analogReport)
		expect(messages[3]).toEqual(Buffer.from([0xc0, 1]))
	})

	test('pin mode and digital write', () => {
		client.pinMode(2, PinMode.PULL_UP)
		client.digitalWrite(2, false)
		client.digitalWrite(2, 123)

		expect(messages[0]).toEqual(Buffer.from([0xf4, 2, PinMode.PULL_UP]))
		expect(messages[1]).toEqual(Buffer.from([0xf5, 2, 0]))
		expect(messages[2]).toEqual(Buffer.from([0xf5, 2, 1]))
	})

	test('analog write uses extended analog encoding', () => {
		client.analogWrite(2, 127)
		client.analogWrite(2, 128)
		client.analogWrite(17, 0x12345)

		expect(messages[0]).toEqual(Buffer.from([0xf0, 0x6f, 2, 0x7f, 0xf7]))
		expect(messages[1]).toEqual(Buffer.from([0xf0, 0x6f, 2, 0x00, 0x01, 0xf7]))
		expect(messages[2]).toEqual(Buffer.from([0xf0, 0x6f, 17, 0x45, 0x46, 0x04, 0xf7]))
	})

	test('sampling interval is clamped to minimum', () => {
		client.samplingInterval(0)
		expect(messages[0]).toEqual(Buffer.from([0xf0, 0x7a, 1, 0, 0xf7]))
	})

	test('two-wire config keeps max delay', () => {
		client.twoWireConfig(10)
		client.twoWireConfig(4)
		client.twoWireConfig(130)

		expect(messages[0]).toEqual(Buffer.from([0xf0, 0x78, 10, 0, 0xf7]))
		expect(messages[1]).toEqual(Buffer.from([0xf0, 0x78, 10, 0, 0xf7]))
		expect(messages[2]).toEqual(Buffer.from([0xf0, 0x78, 2, 1, 0xf7]))
	})

	test('two-wire write/read/stop command encodings', () => {
		client.twoWireWrite(0x123, Buffer.from([0xaa, 0xbb]))
		client.twoWireRead(0x1aa, 0x10, 3, false, 10, 'restart')
		client.twoWireStop(0x55)

		expect(messages[0]).toEqual(Buffer.from([0xf0, 0x76, 0x23, 0x42, 0x2a, 0x01, 0x3b, 0x01, 0xf7]))
		expect(messages[1]).toEqual(Buffer.from([0xf0, 0x76, 0x2a, 0x2b, 0x10, 0, 0x03, 0, 0xf7]))
		expect(messages[2]).toEqual(Buffer.from([0xf0, 0x76, 0x55, 0x58, 0xf7]))
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

	test('one-wire write wrapper uses skip when address is omitted', () => {
		client.oneWireWrite(9, Buffer.from([0x44, 0xbe]))
		expect(messages[0]).toEqual(Buffer.from([0xf0, 0x73, 0x23, 9, ...encodePacked7Bit(Buffer.from([0x44, 0xbe])), 0xf7]))
	})

	test('one-wire write wrapper uses select when address is provided', () => {
		const address = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8])
		const payload = Buffer.concat([address, Buffer.from([0x44])])
		client.oneWireWrite(9, Buffer.from([0x44]), address)
		expect(messages[0]).toEqual(Buffer.from([0xf0, 0x73, 0x25, 9, ...encodePacked7Bit(payload), 0xf7]))
	})

	test('one-wire command validates skip/address combination and address length', () => {
		expect(() => client.oneWireCommand(1, { skip: true, address: Buffer.alloc(8) })).toThrow(RangeError)
		expect(() => client.oneWireCommand(1, { address: Buffer.alloc(7) })).toThrow(RangeError)
		expect(messages.length).toBe(0)
	})

	test('one-wire command clamps read length, correlation id and delay', () => {
		const correlationId = client.oneWireCommand(2, { bytesToRead: 0x10000, correlationId: 0x1ffff, delay: 0x1_0000_0000 })

		expect(correlationId).toBe(0xffff)
		expect(messages[0].subarray(0, 4)).toEqual(Buffer.from([0xf0, 0x73, 0x18, 2]))
		expect(decodePacked7Bit(messages[0], 4, messages[0].length - 5)).toEqual(Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]))
	})

	test('one-wire read generates auto correlation id', () => {
		const first = client.oneWireRead(4, 2)
		const second = client.oneWireRead(4, 2)

		expect(messages[0].subarray(0, 4)).toEqual(Buffer.from([0xf0, 0x73, 0x0b, 4]))
		expect(messages[1].subarray(0, 4)).toEqual(Buffer.from([0xf0, 0x73, 0x0b, 4]))
		const payload0 = decodePacked7Bit(messages[0], 4, messages[0].length - 5)
		const payload1 = decodePacked7Bit(messages[1], 4, messages[1].length - 5)
		const firstCorrelationId = payload0[2] | (payload0[3] << 8)
		const secondCorrelationId = payload1[2] | (payload1[3] << 8)

		expect(payload0.subarray(0, 2)).toEqual(Buffer.from([2, 0]))
		expect(payload1.subarray(0, 2)).toEqual(Buffer.from([2, 0]))
		expect(first).toBe(firstCorrelationId)
		expect(second).toBe(secondCorrelationId)
		expect(secondCorrelationId).toBe((firstCorrelationId + 1) & 0xffff)
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

test('MAX44009 calculate lux', () => {
	const max44009 = new MAX44009(undefined as never)
	expect(max44009.calculateLux(0x00, 0x01)).toBeCloseTo(0.045, 6)
	expect(max44009.calculateLux(0x01, 0x00)).toBeCloseTo(0.72, 6)
	expect(max44009.calculateLux(0x10, 0x01)).toBeCloseTo(0.09, 6)
	expect(max44009.calculateLux(0xef, 0x0f)).toBeCloseTo(188006.4, 1)
	expect(max44009.calculateLux(0xf0, 0x00)).toBe(MAX44009.MAX_LUX)
})

test('MAX44009 configures i2c reads and emits lux updates', () => {
	const client = new MockFirmataClient()
	const max44009 = new MAX44009(client as never, MAX44009.ADDRESS, 1000)
	let updates = 0

	max44009.addListener(() => {
		updates++
	})

	max44009.start()

	expect(client.messages).toEqual([
		['config', 0],
		['write', MAX44009.ADDRESS, Buffer.from([MAX44009.CONFIGURATION_REG, MAX44009.DEFAULT_CONFIGURATION])],
		['read', MAX44009.ADDRESS, MAX44009.LUX_HIGH_REG, 2, false, 7, 'restart'],
	])

	max44009.twoWireMessage(client as never, MAX44009.ADDRESS, MAX44009.LUX_HIGH_REG, Buffer.from([0x10, 0x01]))
	expect(max44009.lux).toBeCloseTo(0.09, 6)
	expect(updates).toBe(1)

	max44009.twoWireMessage(client as never, MAX44009.ADDRESS, MAX44009.LUX_HIGH_REG, Buffer.from([0x10, 0x01]))
	expect(updates).toBe(1)

	max44009.stop()
	expect(client.handlers.size).toBe(0)
})
