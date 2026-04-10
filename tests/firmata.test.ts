import { afterEach, describe, expect, test } from 'bun:test'
import { deg } from '../src/angle'
import { G } from '../src/constants'
import { CRC } from '../src/crc'
import { type AnalogMapping, decodePacked7Bit, encodePacked7Bit, FirmataClient, type FirmataClientHandler, type OneWirePowerMode, type OneWireSearchMode, PinMode, type Transport, type TwoWireAddressMode, type TwoWireAutoRestartMode } from '../src/firmata'
import { MPU6050 } from '../src/firmata.accelerometer'
import { ACS712 } from '../src/firmata.ammeter'
import { BMP180, BMP280 } from '../src/firmata.barometer'
import { ESP8266 } from '../src/firmata.board'
import { MCP4725 } from '../src/firmata.dac'
import { AM2320, SHT21 } from '../src/firmata.hygrometer'
import { BH1750, MAX44009, TEMT6000, TSL2561 } from '../src/firmata.luxmeter'
import { HMC5883L } from '../src/firmata.magnetometer'
import { KT0803L, RDA5807, TEA5767 } from '../src/firmata.radio'
import { DS18B20, LM35 } from '../src/firmata.thermometer'

type MockFirmataMessage =
	| readonly ['mode', number, PinMode]
	| readonly ['analogReport', number, boolean]
	| readonly ['config', number]
	| readonly ['write', number, Buffer]
	| readonly ['read', number, number, number, boolean, TwoWireAddressMode, TwoWireAutoRestartMode]
	| readonly ['oneWireConfig', number, OneWirePowerMode]
	| readonly ['oneWireSearch', number, OneWireSearchMode]
	| readonly ['oneWireWrite', number, Buffer, Buffer | undefined]
	| readonly ['oneWireWriteAndRead', number, Buffer, number, Buffer | undefined, number]

class MockFirmataClient {
	readonly messages: MockFirmataMessage[] = []
	readonly handlers = new Set<FirmataClientHandler>()

	#oneWireCorrelationId = 0x4000

	addHandler(handler: FirmataClientHandler) {
		this.handlers.add(handler)
	}

	removeHandler(handler: FirmataClientHandler) {
		this.handlers.delete(handler)
	}

	pinMode(pin: number, mode: PinMode) {
		this.messages.push(['mode', pin, mode])
	}

	requestAnalogPinReport(pin: number, enable: boolean) {
		this.messages.push(['analogReport', pin, enable])
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

	oneWireConfig(pin: number, powerMode: OneWirePowerMode = 'normal') {
		this.messages.push(['oneWireConfig', pin, powerMode])
	}

	oneWireSearch(pin: number, mode: OneWireSearchMode = 'all') {
		this.messages.push(['oneWireSearch', pin, mode])
	}

	oneWireWrite(pin: number, data: Buffer | readonly number[], address?: Buffer | readonly number[]) {
		this.messages.push(['oneWireWrite', pin, Buffer.from(data), address ? Buffer.from(address) : undefined])
	}

	oneWireWriteAndRead(pin: number, data: Buffer | readonly number[], bytesToRead: number, address?: Buffer | readonly number[]) {
		const correlationId = this.#oneWireCorrelationId
		this.#oneWireCorrelationId = (this.#oneWireCorrelationId + 1) & 0xffff
		this.messages.push(['oneWireWriteAndRead', pin, Buffer.from(data), bytesToRead, address ? Buffer.from(address) : undefined, correlationId])
		return correlationId
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

test('SHT21 configures i2c reads and emits temperature and humidity updates', () => {
	const client = new MockFirmataClient()
	const sht21 = new SHT21(client as never, 1000)
	let updates = 0

	sht21.addListener(() => {
		updates++
	})

	sht21.start()

	expect(client.messages).toEqual([
		['config', 0],
		['read', SHT21.ADDRESS, 0xe3, 2, false, 7, 'stop'],
		['read', SHT21.ADDRESS, 0xe5, 2, false, 7, 'stop'],
	])

	sht21.twoWireMessage(client as never, SHT21.ADDRESS, 0xe3, Buffer.from([0x68, 0xac]))
	expect(sht21.temperature).toBeCloseTo(25, 2)
	expect(updates).toBe(0)

	sht21.twoWireMessage(client as never, SHT21.ADDRESS, 0xe5, Buffer.from([0x7d, 0xf4]))
	expect(sht21.humidity).toBeCloseTo(55.5, 2)
	expect(updates).toBe(1)

	sht21.twoWireMessage(client as never, SHT21.ADDRESS, 0xe5, Buffer.from([0x7d, 0xf4]))
	expect(updates).toBe(1)

	sht21.reset()
	expect(client.messages.at(-1)).toEqual(['write', SHT21.ADDRESS, Buffer.from([0xfe])])

	sht21.stop()
	expect(client.handlers.size).toBe(0)
})

test('LM35 converts ADC counts to temperature', () => {
	const lm35 = new LM35(undefined as never, 0)
	expect(lm35.calculate(51.15)).toBeTrue()
	expect(lm35.temperature).toBeCloseTo(25, 6)
	expect(lm35.calculate(0)).toBeTrue()
	expect(lm35.temperature).toBe(0)
	expect(lm35.calculate(0)).toBeFalse()
})

test('LM35 configures analog reporting and emits temperature updates', () => {
	const client = new MockFirmataClient()
	const lm35 = new LM35(client as never, 2)
	let updates = 0

	lm35.addListener(() => {
		updates++
	})

	lm35.start()

	expect(client.messages).toEqual([
		['mode', 2, PinMode.ANALOG],
		['analogReport', 2, true],
	])

	lm35.pinChange(client as never, { id: 2, modes: new Set([PinMode.ANALOG]), mode: PinMode.ANALOG, value: 51.15 })
	expect(lm35.temperature).toBeCloseTo(25, 6)
	expect(updates).toBe(1)

	lm35.pinChange(client as never, { id: 2, modes: new Set([PinMode.ANALOG]), mode: PinMode.ANALOG, value: 51.15 })
	expect(updates).toBe(1)

	lm35.stop()
	expect(client.handlers.size).toBe(0)
	expect(client.messages.at(-1)).toEqual(['analogReport', 2, false])
})

test('TEMT6000 converts ADC counts to lux', () => {
	const temt6000 = new TEMT6000(undefined as never, 0)
	expect(temt6000.calculate(1023)).toBeTrue()
	expect(temt6000.lux).toBeCloseTo(1000, 6)
	expect(temt6000.calculate(0)).toBeTrue()
	expect(temt6000.lux).toBe(0)
	expect(temt6000.calculate(0)).toBeFalse()
})

test('TEMT6000 configures analog reporting and emits lux updates', () => {
	const client = new MockFirmataClient()
	const temt6000 = new TEMT6000(client as never, 3)
	let updates = 0

	temt6000.addListener(() => {
		updates++
	})

	temt6000.start()

	expect(client.messages).toEqual([
		['mode', 3, PinMode.ANALOG],
		['analogReport', 3, true],
	])

	temt6000.pinChange(client as never, { id: 3, modes: new Set([PinMode.ANALOG]), mode: PinMode.ANALOG, value: 1023 })
	expect(temt6000.lux).toBeCloseTo(1000, 6)
	expect(updates).toBe(1)

	temt6000.pinChange(client as never, { id: 3, modes: new Set([PinMode.ANALOG]), mode: PinMode.ANALOG, value: 1023 })
	expect(updates).toBe(1)

	temt6000.stop()
	expect(client.handlers.size).toBe(0)
	expect(client.messages.at(-1)).toEqual(['analogReport', 3, false])
})

test('ACS712 converts ADC counts to current', () => {
	const acs712 = new ACS712(undefined as never, 0)
	expect(acs712.calculate(549.351)).toBeTrue()
	expect(acs712.current).toBeCloseTo(1, 3)
	expect(acs712.calculate(511.5)).toBeTrue()
	expect(acs712.current).toBeCloseTo(0, 6)
	expect(acs712.calculate(511.5)).toBeFalse()
})

test('ACS712 configures analog reporting and emits current updates', () => {
	const client = new MockFirmataClient()
	const acs712 = new ACS712(client as never, 4)
	let updates = 0

	acs712.addListener(() => {
		updates++
	})

	acs712.start()

	expect(client.messages).toEqual([
		['mode', 4, PinMode.ANALOG],
		['analogReport', 4, true],
	])

	acs712.pinChange(client as never, { id: 4, modes: new Set([PinMode.ANALOG]), mode: PinMode.ANALOG, value: 549.351 })
	expect(acs712.current).toBeCloseTo(1, 3)
	expect(updates).toBe(1)

	acs712.pinChange(client as never, { id: 4, modes: new Set([PinMode.ANALOG]), mode: PinMode.ANALOG, value: 549.351 })
	expect(updates).toBe(1)

	acs712.stop()
	expect(client.handlers.size).toBe(0)
	expect(client.messages.at(-1)).toEqual(['analogReport', 4, false])
})

test('MPU6050 converts raw acceleration and angular velocity', () => {
	const mpu6050 = new MPU6050(undefined as never)
	expect(mpu6050.calculateAcceleration(16384)).toBeCloseTo(G, 6)
	expect(mpu6050.calculateAngularVelocity(131)).toBeCloseTo(deg(1), 6)
})

test('MPU6050 configures i2c reads and decodes motion updates', () => {
	const client = new MockFirmataClient()
	const mpu6050 = new MPU6050(client as never, MPU6050.ADDRESS, 1000)
	let updates = 0

	mpu6050.addListener(() => {
		updates++
	})

	mpu6050.start()

	expect(client.messages).toEqual([
		['config', 0],
		['write', MPU6050.ADDRESS, Buffer.from([MPU6050.PWR_MGMT_1_REG, MPU6050.WAKE_UP])],
		['write', MPU6050.ADDRESS, Buffer.from([MPU6050.ACCEL_CONFIG_REG, 0x00])],
		['write', MPU6050.ADDRESS, Buffer.from([MPU6050.GYRO_CONFIG_REG, 0x00])],
		['read', MPU6050.ADDRESS, MPU6050.ACCEL_XOUT_H_REG, 14, false, 7, 'stop'],
	])

	mpu6050.twoWireMessage(client as never, MPU6050.ADDRESS, MPU6050.ACCEL_XOUT_H_REG, Buffer.from([0x40, 0x00, 0xc0, 0x00, 0x20, 0x00, 0x00, 0x00, 0x00, 0x83, 0xfe, 0xfa, 0x02, 0x8f]))
	expect(mpu6050.ax).toBeCloseTo(G, 6)
	expect(mpu6050.ay).toBeCloseTo(-G, 6)
	expect(mpu6050.az).toBeCloseTo(G / 2, 6)
	expect(mpu6050.gx).toBeCloseTo(deg(1), 6)
	expect(mpu6050.gy).toBeCloseTo(deg(-2), 6)
	expect(mpu6050.gz).toBeCloseTo(deg(5), 6)
	expect(updates).toBe(1)

	mpu6050.twoWireMessage(client as never, MPU6050.ADDRESS, MPU6050.ACCEL_XOUT_H_REG, Buffer.from([0x40, 0x00, 0xc0, 0x00, 0x20, 0x00, 0x00, 0x00, 0x00, 0x83, 0xfe, 0xfa, 0x02, 0x8f]))
	expect(updates).toBe(1)

	mpu6050.stop()
	expect(client.handlers.size).toBe(0)
})

test('AM2320 configures i2c reads and emits humidity and temperature updates', async () => {
	const client = new MockFirmataClient()
	const am2320 = new AM2320(client as never, 1000)
	let updates = 0

	am2320.addListener(() => {
		updates++
	})

	am2320.start()

	expect(client.messages).toEqual([
		['config', 0],
		['write', AM2320.ADDRESS, Buffer.from([])],
	])

	await Bun.sleep(30)

	expect(client.messages[2]).toEqual(['write', AM2320.ADDRESS, Buffer.from([AM2320.READ_HOLDING_REGISTERS_CMD, AM2320.START_REGISTER, AM2320.REGISTER_COUNT])])
	expect(client.messages[3]).toEqual(['read', AM2320.ADDRESS, -1, AM2320.FRAME_SIZE, false, 7, 'stop'])

	am2320.twoWireMessage(client as never, AM2320.ADDRESS, -1, Buffer.from([AM2320.READ_HOLDING_REGISTERS_CMD, AM2320.REGISTER_COUNT, 0x02, 0x2b, 0x80, 0x7b, 0x00, 0x00]))
	expect(am2320.humidity).toBeCloseTo(55.5, 6)
	expect(am2320.temperature).toBeCloseTo(-12.3, 6)
	expect(updates).toBe(1)

	am2320.twoWireMessage(client as never, AM2320.ADDRESS, -1, Buffer.from([AM2320.READ_HOLDING_REGISTERS_CMD, AM2320.REGISTER_COUNT, 0x02, 0x2b, 0x80, 0x7b, 0x00, 0x00]))
	expect(updates).toBe(1)

	am2320.stop()
	expect(client.handlers.size).toBe(0)
})

test('HMC5883L converts raw values to gauss', () => {
	const hmc5883l = new HMC5883L(undefined as never)
	expect(hmc5883l.rawToGauss(1090)).toBeCloseTo(1, 6)
	expect(hmc5883l.rawToGauss(-1090)).toBeCloseTo(-1, 6)
})

test('HMC5883L configures i2c reads and decodes xyz updates', () => {
	const client = new MockFirmataClient()
	const hmc5883l = new HMC5883L(client as never, HMC5883L.ADDRESS, 1000)
	let updates = 0

	hmc5883l.addListener(() => {
		updates++
	})

	hmc5883l.start()

	expect(client.messages).toEqual([
		['config', 0],
		['write', HMC5883L.ADDRESS, Buffer.from([HMC5883L.CONFIG_A_REG, 0x10])],
		['write', HMC5883L.ADDRESS, Buffer.from([HMC5883L.CONFIG_B_REG, 0x20])],
		['write', HMC5883L.ADDRESS, Buffer.from([HMC5883L.MODE_REG, HMC5883L.CONTINUOUS_MEASUREMENT_MODE])],
		['read', HMC5883L.ADDRESS, HMC5883L.DATA_X_MSB_REG, 6, false, 7, 'stop'],
	])

	hmc5883l.twoWireMessage(client as never, HMC5883L.ADDRESS, HMC5883L.DATA_X_MSB_REG, Buffer.from([0x04, 0x42, 0xfb, 0xbe, 0x02, 0x21]))
	expect(hmc5883l.x).toBeCloseTo(1, 6)
	expect(hmc5883l.y).toBeCloseTo(0.5, 6)
	expect(hmc5883l.z).toBeCloseTo(-1, 6)
	expect(updates).toBe(1)

	hmc5883l.twoWireMessage(client as never, HMC5883L.ADDRESS, HMC5883L.DATA_X_MSB_REG, Buffer.from([0xf0, 0x00, 0x00, 0x00, 0x00, 0x00]))
	expect(hmc5883l.x).toBeCloseTo(1, 6)
	expect(hmc5883l.y).toBeCloseTo(0.5, 6)
	expect(hmc5883l.z).toBeCloseTo(-1, 6)
	expect(updates).toBe(1)

	hmc5883l.stop()
	expect(client.handlers.size).toBe(0)
})

test('BH1750 calculates lux from the raw reading', () => {
	const bh1750 = new BH1750(undefined as never)
	expect(bh1750.calculateLux(120)).toBeCloseTo(100, 6)
	expect(bh1750.calculateLux(0)).toBe(0)
})

test('BH1750 configures i2c measurements and emits lux updates', async () => {
	const client = new MockFirmataClient()
	const bh1750 = new BH1750(client as never, BH1750.ADDRESS, 1000, { mode: 'continuousLowResolution', measurementTime: 31 })
	let updates = 0

	bh1750.addListener(() => {
		updates++
	})

	bh1750.start()

	expect(client.messages).toEqual([
		['config', 0],
		['write', BH1750.ADDRESS, Buffer.from([BH1750.POWER_ON_CMD])],
		['write', BH1750.ADDRESS, Buffer.from([0x40])],
		['write', BH1750.ADDRESS, Buffer.from([0x7f])],
		['write', BH1750.ADDRESS, Buffer.from([BH1750.CONTINUOUS_LOW_RESOLUTION_CMD])],
	])

	await Bun.sleep(20)

	expect(client.messages[5]).toEqual(['read', BH1750.ADDRESS, -1, 2, false, 7, 'stop'])

	bh1750.twoWireMessage(client as never, BH1750.ADDRESS, -1, Buffer.from([0x00, 0x78]))
	expect(bh1750.raw).toBe(120)
	expect(bh1750.lux).toBeCloseTo(222.58064516129, 6)
	expect(updates).toBe(1)

	bh1750.twoWireMessage(client as never, BH1750.ADDRESS, -1, Buffer.from([0x00, 0x78]))
	expect(updates).toBe(1)

	bh1750.stop()
	expect(client.handlers.size).toBe(0)
	expect(client.messages.at(-1)).toEqual(['write', BH1750.ADDRESS, Buffer.from([BH1750.POWER_DOWN_CMD])])
})

test('TSL2561 calculates lux from channel data', () => {
	const tsl2561 = new TSL2561(undefined as never)
	expect(tsl2561.calculateLux(67, 12)).toBeCloseTo(26.605572786225, 6)
	expect(tsl2561.calculateLux(0, 0)).toBe(0)
})

test('TSL2561 configures i2c reads and emits lux updates', () => {
	const client = new MockFirmataClient()
	const tsl2561 = new TSL2561(client as never, TSL2561.ADDRESS, 1000)
	let updates = 0

	tsl2561.addListener(() => {
		updates++
	})

	tsl2561.start()

	expect(client.messages).toEqual([
		['config', 0],
		['write', TSL2561.ADDRESS, Buffer.from([TSL2561.COMMAND_BIT | TSL2561.CONTROL_REG, TSL2561.POWER_UP])],
		['write', TSL2561.ADDRESS, Buffer.from([TSL2561.COMMAND_BIT | TSL2561.TIMING_REG, 0x02])],
		['read', TSL2561.ADDRESS, TSL2561.COMMAND_BIT | TSL2561.BLOCK_BIT | TSL2561.DATA0LOW_REG, 4, false, 7, 'stop'],
	])

	tsl2561.twoWireMessage(client as never, TSL2561.ADDRESS, TSL2561.COMMAND_BIT | TSL2561.BLOCK_BIT | TSL2561.DATA0LOW_REG, Buffer.from([0x43, 0x00, 0x0c, 0x00]))
	expect(tsl2561.broadband).toBe(67)
	expect(tsl2561.infrared).toBe(12)
	expect(tsl2561.lux).toBeCloseTo(26.605572786225, 6)
	expect(updates).toBe(1)

	tsl2561.twoWireMessage(client as never, TSL2561.ADDRESS, TSL2561.COMMAND_BIT | TSL2561.BLOCK_BIT | TSL2561.DATA0LOW_REG, Buffer.from([0x43, 0x00, 0x0c, 0x00]))
	expect(updates).toBe(1)

	tsl2561.stop()
	expect(client.handlers.size).toBe(0)
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

test('MCP4725 clamps raw and normalized output values', () => {
	const dac = new MCP4725(undefined as never)

	expect(dac.value).toBe(0)

	dac.value = 5000
	expect(dac.value).toBe(MCP4725.MAX_VALUE)

	dac.powerDownMode = '1k'
	expect(dac.powerDownMode).toBe('1k')

	dac.powerDownMode = 'normal'
	expect(dac.powerDownMode).toBe('normal')
})

test('MCP4725 configures i2c writes, power-down mode and EEPROM persistence', () => {
	const client = new MockFirmataClient()
	const dac = new MCP4725(client as never, MCP4725.ADDRESS, { value: 0x123 })
	let updates = 0

	dac.addListener(() => {
		updates++
	})

	dac.start()

	expect(client.messages).toEqual([
		['config', 0],
		['write', MCP4725.ADDRESS, Buffer.from([0x01, 0x23])],
	])

	dac.value = 0x800
	expect(dac.value).toBe(0x800)
	expect(client.messages.at(-1)).toEqual(['write', MCP4725.ADDRESS, Buffer.from([0x08, 0x00])])
	expect(updates).toBe(1)

	const writesAfterValueChange = client.messages.length
	dac.value = 0x800
	expect(client.messages.length).toBe(writesAfterValueChange)
	expect(updates).toBe(1)

	dac.powerDownMode = '100k'
	expect(dac.powerDownMode).toBe('100k')
	expect(client.messages.at(-1)).toEqual(['write', MCP4725.ADDRESS, Buffer.from([0x28, 0x00])])
	expect(updates).toBe(2)

	dac.persist()
	expect(client.messages.at(-1)).toEqual(['write', MCP4725.ADDRESS, Buffer.from([0x64, 0x80, 0x00])])

	dac.stop()
	expect(client.handlers.size).toBe(0)
})

test('KT0803L tunes frequency steps and wraps within the supported band', () => {
	const transmitter = new KT0803L(undefined as never)

	expect(transmitter.frequency).toBe(89.7)

	transmitter.frequencyUp()
	expect(transmitter.frequency).toBe(89.75)

	transmitter.frequency = 107.98
	expect(transmitter.frequency).toBe(108)

	transmitter.frequencyUp()
	expect(transmitter.frequency).toBe(70)

	transmitter.frequencyDown()
	expect(transmitter.frequency).toBe(108)
})

test('KT0803L configures the transmitter and updates register-backed settings', () => {
	const client = new MockFirmataClient()
	const transmitter = new KT0803L(client as never, KT0803L.ADDRESS, {
		frequency: 100.1,
		muted: true,
		stereo: false,
		gain: 5,
		transmitPower: 9,
		bassBoost: 11,
		preEmphasis: 50,
		pilotToneHigh: true,
		automaticLevelControl: true,
		automaticPowerDown: true,
		powerAmplifierBias: false,
		deviation: 112.5,
		audioEnhancement: true,
	})

	let updates = 0

	transmitter.addListener(() => {
		updates++
	})

	transmitter.start()

	expect(client.messages).toEqual([
		['config', 0],
		['write', KT0803L.ADDRESS, Buffer.from([KT0803L.REG0B, 0x84])],
		['write', KT0803L.ADDRESS, Buffer.from([KT0803L.REG10, 0xa9])],
		['write', KT0803L.ADDRESS, Buffer.from([KT0803L.REG04, 0xc6])],
		['write', KT0803L.ADDRESS, Buffer.from([KT0803L.REG0E, 0x00])],
		['write', KT0803L.ADDRESS, Buffer.from([KT0803L.REG17, 0x60])],
		['write', KT0803L.ADDRESS, Buffer.from([KT0803L.REG13, 0x00])],
		['write', KT0803L.ADDRESS, Buffer.from([KT0803L.REG01, 0x73])],
		['write', KT0803L.ADDRESS, Buffer.from([KT0803L.REG02, 0x4d])],
		['write', KT0803L.ADDRESS, Buffer.from([KT0803L.REG00, 0xe9])],
		['write', KT0803L.ADDRESS, Buffer.from([KT0803L.REG0B, 0x04])],
	])

	transmitter.frequency = 70
	expect(transmitter.frequency).toBe(70)
	expect(client.messages.slice(-3)).toEqual([
		['write', KT0803L.ADDRESS, Buffer.from([KT0803L.REG01, 0x72])],
		['write', KT0803L.ADDRESS, Buffer.from([KT0803L.REG02, 0x4d])],
		['write', KT0803L.ADDRESS, Buffer.from([KT0803L.REG00, 0xbc])],
	])
	expect(updates).toBe(1)

	transmitter.transmitPower = 4
	expect(transmitter.transmitPower).toBe(4)
	expect(client.messages.slice(-3)).toEqual([
		['write', KT0803L.ADDRESS, Buffer.from([KT0803L.REG13, 0x80])],
		['write', KT0803L.ADDRESS, Buffer.from([KT0803L.REG01, 0x32])],
		['write', KT0803L.ADDRESS, Buffer.from([KT0803L.REG02, 0x0d])],
	])
	expect(updates).toBe(2)

	transmitter.gain = -3
	expect(transmitter.gain).toBe(-3)
	expect(client.messages.slice(-2)).toEqual([
		['write', KT0803L.ADDRESS, Buffer.from([KT0803L.REG01, 0x02])],
		['write', KT0803L.ADDRESS, Buffer.from([KT0803L.REG04, 0xf6])],
	])
	expect(updates).toBe(3)

	transmitter.unmute()
	expect(transmitter.muted).toBeFalse()
	expect(client.messages.at(-1)).toEqual(['write', KT0803L.ADDRESS, Buffer.from([KT0803L.REG02, 0x05])])
	expect(updates).toBe(4)

	transmitter.stop()
	expect(client.handlers.size).toBe(0)
	expect(client.messages.at(-1)).toEqual(['write', KT0803L.ADDRESS, Buffer.from([KT0803L.REG0B, 0x84])])
})

test('TEA5767 tunes frequency steps and wraps within the configured band', () => {
	const tuner = new TEA5767(undefined as never)

	expect(tuner.frequency).toBe(87.5)

	tuner.frequencyUp()
	expect(tuner.frequency).toBe(87.6)

	tuner.frequency = 107.95
	expect(tuner.frequency).toBe(108)

	tuner.frequencyUp()
	expect(tuner.frequency).toBe(87.5)

	tuner.frequencyDown()
	expect(tuner.frequency).toBe(108)
})

test('TEA5767 reports fixed volume support and mute state', () => {
	const tuner = new TEA5767(undefined as never)

	expect(tuner.volume).toBe(100)

	tuner.volumeDown()
	expect(tuner.volume).toBe(100)

	tuner.stereo = false
	expect(tuner.stereo).toBeFalse()

	tuner.mute()
	expect(tuner.muted).toBeTrue()

	tuner.unmute()
	expect(tuner.muted).toBeFalse()
})

test('TEA5767 configures the tuner and writes frequency and mute changes', () => {
	const client = new MockFirmataClient()
	const tuner = new TEA5767(client as never)

	tuner.start()

	expect(client.messages).toEqual([
		['config', 0],
		['write', TEA5767.ADDRESS, Buffer.from([0x29, 0xd5, 0xd0, 0x1e, 0x00])],
		['read', TEA5767.ADDRESS, -1, 5, false, 7, 'stop'],
	])

	tuner.frequency = 103.9
	expect(client.messages.slice(-2)).toEqual([
		['write', TEA5767.ADDRESS, Buffer.from([0x31, 0xa7, 0xd0, 0x1e, 0x00])],
		['read', TEA5767.ADDRESS, -1, 5, false, 7, 'stop'],
	])

	tuner.mute()
	expect(client.messages.at(-1)).toEqual(['write', TEA5767.ADDRESS, Buffer.from([0xb1, 0xa7, 0xd0, 0x1e, 0x00])])

	tuner.unmute()
	expect(client.messages.at(-1)).toEqual(['write', TEA5767.ADDRESS, Buffer.from([0x31, 0xa7, 0xd0, 0x1e, 0x00])])

	tuner.stop()
	expect(client.handlers.size).toBe(0)
	expect(client.messages.at(-1)).toEqual(['write', TEA5767.ADDRESS, Buffer.from([0x31, 0xa7, 0xd0, 0x5e, 0x00])])
})

test('TEA5767 seeks to the next station and updates stereo, rssi and station state', () => {
	const client = new MockFirmataClient()
	const tuner = new TEA5767(client as never, TEA5767.ADDRESS, 1000, { frequency: 100.9 })
	let updates = 0

	tuner.addListener(() => {
		updates++
	})

	tuner.start()
	client.messages.length = 0

	tuner.seek('up')

	expect(client.messages).toEqual([
		['write', TEA5767.ADDRESS, Buffer.from([0xf0, 0x45, 0xd0, 0x1e, 0x00])],
		['read', TEA5767.ADDRESS, -1, 5, false, 7, 'stop'],
	])

	tuner.twoWireMessage(client as never, TEA5767.ADDRESS, 0, Buffer.from([0xb0, 0x51, 0xb8, 0xa0, 0x00]))

	expect(tuner.frequency).toBe(101.1)
	expect(tuner.seekFailed).toBeFalse()
	expect(tuner.stereo).toBeTrue()
	expect(tuner.rssi).toBe(85)
	expect(tuner.station).toBeTrue()
	expect(updates).toBe(1)
	expect(client.messages.at(-1)).toEqual(['write', TEA5767.ADDRESS, Buffer.from([0x30, 0x51, 0xd0, 0x1e, 0x00])])
})

test('RDA5807 tunes frequency steps and wraps within the configured band', () => {
	const tuner = new RDA5807(undefined as never)

	expect(tuner.frequency).toBe(87)

	tuner.frequencyUp()
	expect(tuner.frequency).toBe(87.1)

	tuner.frequency = 107.95
	expect(tuner.frequency).toBe(108)

	tuner.frequencyUp()
	expect(tuner.frequency).toBe(87)

	tuner.frequencyDown()
	expect(tuner.frequency).toBe(108)
})

test('RDA5807 clamps volume and mute state', () => {
	const tuner = new RDA5807(undefined as never)

	tuner.volume = 7.8
	expect(tuner.volume).toBe(7)

	tuner.volumeUp()
	expect(tuner.volume).toBe(13)

	tuner.volumeDown()
	expect(tuner.volume).toBe(7)

	tuner.volume = 99
	expect(tuner.volume).toBe(100)

	tuner.volume = 1
	expect(tuner.volume).toBe(0)

	tuner.volume = 50
	expect(tuner.volume).toBe(53)

	tuner.mute()
	expect(tuner.muted).toBeTrue()

	tuner.unmute()
	expect(tuner.muted).toBeFalse()
})

test('RDA5807 configures the tuner and writes frequency and volume changes', () => {
	const client = new MockFirmataClient()
	const tuner = new RDA5807(client as never)

	tuner.start()

	expect(client.messages).toEqual([
		['config', 0],
		['write', RDA5807.ADDRESS, Buffer.from([RDA5807.CONTROL_REG, 0xc0, 0x01])],
		['write', RDA5807.ADDRESS, Buffer.from([RDA5807.AUDIO_REG, 0x08, 0x8f])],
		['write', RDA5807.ADDRESS, Buffer.from([RDA5807.TUNING_REG, 0x00, 0x10])],
		['read', RDA5807.ADDRESS, RDA5807.STATUS_REG, 4, false, 7, 'stop'],
	])

	tuner.frequency = 103.9
	expect(client.messages.slice(-3)).toEqual([
		['write', RDA5807.ADDRESS, Buffer.from([RDA5807.CONTROL_REG, 0xc0, 0x01])],
		['write', RDA5807.ADDRESS, Buffer.from([RDA5807.TUNING_REG, 0x2a, 0x40])],
		['write', RDA5807.ADDRESS, Buffer.from([RDA5807.TUNING_REG, 0x2a, 0x50])],
	])

	tuner.volume = 7
	expect(client.messages.at(-1)).toEqual(['write', RDA5807.ADDRESS, Buffer.from([RDA5807.AUDIO_REG, 0x08, 0x81])])

	tuner.mute()
	expect(client.messages.at(-1)).toEqual(['write', RDA5807.ADDRESS, Buffer.from([RDA5807.CONTROL_REG, 0x80, 0x01])])

	tuner.unmute()
	expect(client.messages.at(-1)).toEqual(['write', RDA5807.ADDRESS, Buffer.from([RDA5807.CONTROL_REG, 0xc0, 0x01])])

	tuner.stop()
	expect(client.handlers.size).toBe(0)
	expect(client.messages.at(-1)).toEqual(['write', RDA5807.ADDRESS, Buffer.from([RDA5807.CONTROL_REG, 0xc0, 0x00])])
})

test('RDA5807 applies stereo mode, bass boost, high-z output and east europe 50-65 MHz mode', () => {
	const client = new MockFirmataClient()
	const tuner = new RDA5807(client as never, RDA5807.ADDRESS, 1000, {
		band: 'eastEurope',
		eastEuropeMode: '50_65',
		frequency: 50,
		stereo: false,
		bassBoost: true,
		audioOutputHighZ: true,
	})

	tuner.start()

	expect(tuner.stereo).toBe(false)
	expect(tuner.bassBoost).toBeTrue()
	expect(tuner.frequency).toBe(50)

	expect(client.messages).toEqual([
		['config', 0],
		['write', RDA5807.ADDRESS, Buffer.from([RDA5807.CONTROL_REG, 0x70, 0x01])],
		['write', RDA5807.ADDRESS, Buffer.from([RDA5807.AUDIO_REG, 0x08, 0x8f])],
		['write', RDA5807.ADDRESS, Buffer.from([RDA5807.SYSTEM_REG, 0x60, 0x00])],
		['write', RDA5807.ADDRESS, Buffer.from([RDA5807.BAND_REG, 0x40, 0x02])],
		['write', RDA5807.ADDRESS, Buffer.from([RDA5807.TUNING_REG, 0x00, 0x1c])],
		['read', RDA5807.ADDRESS, RDA5807.STATUS_REG, 4, false, 7, 'stop'],
	])

	tuner.stop()
})

test('RDA5807 seeks to the next station and updates stereo, rssi and station state', () => {
	const client = new MockFirmataClient()
	const tuner = new RDA5807(client as never, RDA5807.ADDRESS, 1000, { frequency: 100.9, volume: 5 })
	let updates = 0

	tuner.addListener(() => {
		updates++
	})

	tuner.start()
	client.messages.length = 0

	tuner.seek('up')

	expect(client.messages).toEqual([
		['write', RDA5807.ADDRESS, Buffer.from([RDA5807.CONTROL_REG, 0xc0, 0x01])],
		['write', RDA5807.ADDRESS, Buffer.from([RDA5807.TUNING_REG, 0x22, 0xc0])],
		['write', RDA5807.ADDRESS, Buffer.from([RDA5807.CONTROL_REG, 0xc3, 0x01])],
		['read', RDA5807.ADDRESS, RDA5807.STATUS_REG, 4, false, 7, 'stop'],
	])

	tuner.twoWireMessage(client as never, RDA5807.ADDRESS, RDA5807.STATUS_REG, Buffer.from([0x44, 0x8d, 0x81, 0x80]))

	expect(tuner.frequency).toBe(101.1)
	expect(tuner.seekFailed).toBeFalse()
	expect(tuner.stereo).toBeTrue()
	expect(tuner.rssi).toBe(64)
	expect(tuner.station).toBeTrue()
	expect(updates).toBe(1)
	expect(client.messages.at(-1)).toEqual(['write', RDA5807.ADDRESS, Buffer.from([RDA5807.CONTROL_REG, 0xc0, 0x01])])
})

test('RDA5807 polls status frames', async () => {
	const client = new MockFirmataClient()
	const tuner = new RDA5807(client as never, RDA5807.ADDRESS, 10)

	tuner.start()
	client.messages.length = 0

	await Bun.sleep(130)

	expect(client.messages.length).toBeGreaterThan(0)
	expect(client.messages[0]).toEqual(['read', RDA5807.ADDRESS, RDA5807.STATUS_REG, 4, false, 7, 'stop'])
	tuner.stop()
})

test('DS18B20 validates scratchpad CRC', () => {
	const scratchpad = createDS18B20Scratchpad(23.5)
	expect(DS18B20.isScratchpadValid(scratchpad)).toBeTrue()
	scratchpad[8] ^= 0xff
	expect(DS18B20.isScratchpadValid(scratchpad)).toBeFalse()
})

test('DS18B20 configures one-wire reads and emits temperature updates', async () => {
	const client = new MockFirmataClient()
	const address = Buffer.from([DS18B20.FAMILY_CODE, 0x1a, 0xbc, 0x4d, 0x2f, 0x00, 0x00, 0xc1])
	const ds18b20 = new DS18B20(client as never, 6, 1000, { address, powerMode: 'parasitic', resolution: 9 })
	let updates = 0

	ds18b20.addListener(() => {
		updates++
	})

	ds18b20.start()

	expect(client.messages).toEqual([
		['oneWireConfig', 6, 'parasitic'],
		['oneWireWrite', 6, Buffer.from([DS18B20.WRITE_SCRATCHPAD_CMD, DS18B20.DEFAULT_TH, DS18B20.DEFAULT_TL, 0x1f]), address],
		['oneWireWrite', 6, Buffer.from(DS18B20.CONVERT_T_CMD), address],
	])

	await Bun.sleep(110)

	const readMessage = client.messages[3] as readonly ['oneWireWriteAndRead', number, Buffer, number, Buffer | undefined, number]
	expect(readMessage).toEqual(['oneWireWriteAndRead', 6, Buffer.from(DS18B20.READ_SCRATCHPAD_CMD), DS18B20.SCRATCHPAD_SIZE, address, 0x4000])

	ds18b20.oneWireReadReply(client as never, 6, readMessage[5], createDS18B20Scratchpad(23.5))
	expect(ds18b20.temperature).toBeCloseTo(23.5, 6)
	expect(updates).toBe(1)

	ds18b20.oneWireReadReply(client as never, 6, readMessage[5], createDS18B20Scratchpad(23.5))
	expect(updates).toBe(1)

	ds18b20.stop()
	expect(client.handlers.size).toBe(0)
})

function createDS18B20Scratchpad(temperature: number) {
	const scratchpad = Buffer.from([0, 0, DS18B20.DEFAULT_TH, DS18B20.DEFAULT_TL, 0x1f, 0xff, 0x0c, 0x10, 0])
	scratchpad.writeInt16LE(Math.round(temperature * 16), 0)
	scratchpad[8] = CRC.crc8maxim.compute(scratchpad, undefined, 0, 8)
	return scratchpad
}
