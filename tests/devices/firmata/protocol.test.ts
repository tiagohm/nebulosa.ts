import { afterEach, describe, expect, test } from 'bun:test'
import { ESP8266 } from '../../../src/devices/firmata/board'
import { decodeStepperFloat, encodeStepperFloat } from '../../../src/devices/firmata/codecs/numeric'
import { FirmataClient, type FirmataClientHandler, PinMode, type StepperConfig, type Transport } from '../../../src/devices/firmata/firmata'

const sent: Buffer[] = []
const transport: Transport = {
	write: (data) => sent.push(Buffer.from(data as Uint8Array)),
	flush: () => {},
	close: () => {},
}
const client = new FirmataClient(transport, new ESP8266())
const events: unknown[] = []
const handler: FirmataClientHandler = {
	pinCapability: (_, id, modes, resolutions) => events.push([id, [...modes], [...resolutions]]),
	samplingIntervalReply: (_, value) => events.push(['sampling', value]),
	systemVariableReply: (_, reply) => events.push(['variable', reply]),
	spiReply: (_, reply) => events.push(['spi', reply]),
	serialReply: (_, port, data) => events.push(['serial', port, data]),
	encoderPositions: (_, positions) => events.push(['encoder', positions]),
	stepperPosition: (_, report) => events.push(['stepper', report]),
	analogMessage: (_, channel, value) => events.push(['analog', channel, value]),
	multiStepperComplete: (_, group) => events.push(['multi', group]),
	dhtReport: (_, report) => events.push(['dht', report]),
	schedulerTasks: (_, ids) => events.push(['tasks', ids]),
	schedulerTask: (_, reply) => events.push(['task', reply]),
	frequencyReport: (_, report) => events.push(['frequency', report]),
}
client.addHandler(handler)

afterEach(() => {
	sent.length = 0
	events.length = 0
	client.reset()
})

function receive(command: number, payload: readonly number[]) {
	client.process(Buffer.from([0xf0, command, ...payload, 0xf7]))
}

describe('core and capability', () => {
	test('preserves capability resolutions including frequency and future modes', () => {
		receive(0x6c, [PinMode.SERIAL, 2, PinMode.FREQUENCY, 32, 0x30, 7, 0x7f])
		expect(events[0]).toEqual([
			0,
			[PinMode.SERIAL, PinMode.FREQUENCY, 0x30],
			[
				[PinMode.SERIAL, 2],
				[PinMode.FREQUENCY, 32],
				[0x30, 7],
			],
		])
		expect(client.pinAt(0)?.resolutions.get(PinMode.SERIAL)).toBe(2)
		expect(client.pinAt(0)?.resolutions.get(PinMode.FREQUENCY)).toBe(32)
	})

	test('requests version, resets board, sends text and queries sampling interval', () => {
		client.requestProtocolVersion()
		client.sendSystemReset()
		client.sendString('é')
		client.querySamplingInterval()
		expect(sent).toEqual([Buffer.from([0xf9]), Buffer.from([0xff]), Buffer.from([0xf0, 0x79, 0xf7]), Buffer.from([0xf0, 0x71, 0x43, 1, 0x29, 1, 0xf7]), Buffer.from([0xf0, 0x7c, 0xf7])])
		receive(0x7a, [0x68, 7])
		expect(events).toEqual([['sampling', 1000]])
	})

	test('system reset invalidates board configuration and repeats the readiness handshake', async () => {
		const writes: Buffer[] = []
		using resetClient = new FirmataClient({ write: (data) => writes.push(Buffer.from(data as Uint8Array)), flush: () => {}, close: () => {} }, new ESP8266())
		const readyPinCounts: number[] = []
		resetClient.addHandler({ ready: () => readyPinCounts.push(resetClient.pinCount) })
		const reply = (command: number, payload: readonly number[]) => resetClient.process(Buffer.from([0xf0, command, ...payload, 0xf7]))
		const handshake = (pins: number) => {
			reply(0x79, [2, 3])
			reply(0x6c, new Array(pins).fill(0x7f))
			reply(0x6a, new Array(pins).fill(0x7f))
		}

		resetClient.requestFirmware()
		handshake(2)
		expect(await resetClient.ensureInitializationIsDone(0)).toBeTrue()
		resetClient.spiConfig({ channel: 0, deviceId: 1, packed: true })
		resetClient.multiStepperConfig(0, [1, 2])
		resetClient.twoWireConfig(300)
		const writesBeforeReset = writes.length

		resetClient.sendSystemReset()
		expect(writes.slice(writesBeforeReset)).toEqual([Buffer.from([0xff]), Buffer.from([0xf0, 0x79, 0xf7])])
		expect(resetClient.pinCount).toBe(0)
		expect(resetClient.pinAt(1)).toBeUndefined()
		const initialization = resetClient.ensureInitializationIsDone(0)
		let settled = false
		void initialization.then(() => {
			settled = true
		})
		await Promise.resolve()
		expect(settled).toBeFalse()

		handshake(1)
		expect(await initialization).toBeTrue()
		expect(readyPinCounts).toEqual([2, 1])
		expect(resetClient.pinAt(1)).toBeUndefined()
		resetClient.spiTransfer(0, 1, Buffer.from([0x80, 1]))
		expect(writes.at(-1)).toEqual(Buffer.from([0xf0, 0x68, 2, 8, 0, 1, 2, 0, 1, 1, 0, 0xf7]))
		resetClient.twoWireConfig(10)
		expect(writes.at(-1)).toEqual(Buffer.from([0xf0, 0x78, 10, 0, 0xf7]))
		resetClient.multiStepperConfig(0, [1])
		resetClient.multiStepperMoveTo(0, [100])
	})

	test('supports unsigned 32-bit extended analog and analog channels above 15', () => {
		client.analogWrite(2, 0x10000000)
		client.analogWrite(2, 0xffffffff)
		expect(sent).toEqual([Buffer.from([0xf0, 0x6f, 2, 0, 0, 0, 0, 1, 0xf7]), Buffer.from([0xf0, 0x6f, 2, 127, 127, 127, 127, 15, 0xf7])])
		const board = new ESP8266()
		board.pinToAnalog = () => 16
		const extendedClient = new FirmataClient(transport, board)
		extendedClient.requestAnalogPinReport(17, true)
		expect(sent[2]).toEqual(Buffer.from([0xf0, 0x64, 16, 1, 0xf7]))
		receive(0x6f, [16, 127, 127, 127, 127, 15])
		expect(events).toEqual([['analog', 16, 0xffffffff]])
	})

	test('encodes system-variable query/set and decodes signed replies and errors', () => {
		client.querySystemVariable(101, 4)
		client.setSystemVariable(101, -1, 4)
		client.querySystemVariable(1)
		expect(sent).toEqual([Buffer.from([0xf0, 0x66, 0, 1, 0, 101, 0, 4, 0, 0, 0, 0, 0, 0xf7]), Buffer.from([0xf0, 0x66, 1, 1, 0, 101, 0, 4, 127, 127, 127, 127, 15, 0xf7]), Buffer.from([0xf0, 0x66, 0, 1, 0, 1, 0, 127, 0, 0, 0, 0, 0, 0xf7])])
		receive(0x66, [1, 1, 0, 101, 0, 4, 127, 127, 127, 127, 15])
		receive(0x66, [0, 1, 4, 101, 0, 127, 0, 0, 0, 0, 0])
		expect(events).toEqual([
			['variable', { operation: 1, dataType: 1, status: 0, id: 101, pin: 4, value: -1 }],
			['variable', { operation: 0, dataType: 1, status: 4, id: 101, pin: undefined, value: 0 }],
		])
	})

	test('encodes 14-bit servo pulse limits', () => {
		client.servoConfig(4, 0, 16383)
		expect(sent[0]).toEqual(Buffer.from([0xf0, 0x70, 4, 0, 0, 127, 127, 0xf7]))
	})
})

describe('SPI', () => {
	test('begin, config, ordinary transfer/write/read and end use exact wire fields', () => {
		client.spiBegin()
		client.spiConfig({ channel: 0, deviceId: 2, maxSpeed: 5000000, csPin: 15 })
		expect(client.spiTransfer(0, 2, Buffer.from([0x80, 1]), false)).toBe(0)
		expect(client.spiWrite(0, 2, Buffer.from([0xff]))).toBe(1)
		expect(client.spiWriteAck(0, 2, Buffer.from([0]))).toBe(2)
		expect(client.spiRead(0, 2, 3)).toBe(3)
		client.spiEnd()
		expect(sent).toEqual([
			Buffer.from([0xf0, 0x68, 0, 0, 0xf7]),
			Buffer.from([0xf0, 0x68, 1, 16, 1, 64, 22, 49, 2, 0, 0, 1, 15, 0xf7]),
			Buffer.from([0xf0, 0x68, 2, 16, 0, 0, 2, 0, 1, 1, 0, 0xf7]),
			Buffer.from([0xf0, 0x68, 3, 16, 1, 1, 1, 127, 1, 0xf7]),
			Buffer.from([0xf0, 0x68, 7, 16, 2, 1, 1, 0, 0, 0xf7]),
			Buffer.from([0xf0, 0x68, 4, 16, 3, 1, 3, 0xf7]),
			Buffer.from([0xf0, 0x68, 6, 0, 0xf7]),
		])
		client.spiConfig({ channel: 0, deviceId: 2 })
		receive(0x68, [5, 16, 3, 2, 0, 1, 127, 1])
		expect(events[0]).toEqual(['spi', { channel: 0, deviceId: 2, requestId: 3, data: Buffer.from([0x80, 0xff]) }])
		receive(0x68, [5, 16, 2, 0])
		expect(events[1]).toEqual(['spi', { channel: 0, deviceId: 2, requestId: 2, data: Buffer.alloc(0) }])
		client.spiConfig({ channel: 0, deviceId: 3, bitOrder: 'lsb', dataMode: 3, maxSpeed: 0xffffffff, wordSize: 8, csPin: 15, csActiveHigh: true, packed: true })
		expect(sent.at(-1)).toEqual(Buffer.from([0xf0, 0x68, 1, 24, 14, 127, 127, 127, 127, 15, 8, 3, 15, 0xf7]))
	})

	test('packs words, parses correlated replies, and wraps the 7-bit request ID', () => {
		client.spiConfig({ channel: 0, deviceId: 1, packed: true, wordSize: 8, controlCs: false })
		client.spiTransfer(0, 1, Buffer.from([0x80, 1]))
		expect(sent[1]).toEqual(Buffer.from([0xf0, 0x68, 2, 8, 0, 1, 2, 0, 3, 0, 0xf7]))
		receive(0x68, [5, 8, 0, 2, 0, 3, 0])
		expect(events[0]).toEqual(['spi', { channel: 0, deviceId: 1, requestId: 0, data: Buffer.from([0x80, 1]) }])
		for (let i = 1; i < 128; i++) client.spiRead(0, 1, 1)
		expect(client.spiRead(0, 1, 1)).toBe(0)
		expect(() => client.spiRead(0, 1, 65)).toThrow(RangeError)
		expect(() => client.spiTransfer(0, 1, Buffer.alloc(128))).toThrow(RangeError)
		expect(() => client.spiConfig({ channel: 0, deviceId: 1, controlCs: true })).toThrow(RangeError)
		client.reset()
		expect(client.spiRead(0, 1, 1)).toBe(0)
	})

	test('limits transfer frames to the ESP8266 input buffer', () => {
		client.spiConfig({ channel: 0, deviceId: 1 })
		expect(client.spiTransfer(0, 1, Buffer.alloc(29))).toBe(0)
		expect(client.spiWrite(0, 1, Buffer.alloc(29))).toBe(1)
		expect(client.spiWriteAck(0, 1, Buffer.alloc(29))).toBe(2)
		expect(sent[1].length).toBe(66)
		for (const write of [(data: Buffer) => client.spiTransfer(0, 1, data), (data: Buffer) => client.spiWrite(0, 1, data), (data: Buffer) => client.spiWriteAck(0, 1, data)]) {
			expect(() => write(Buffer.alloc(30))).toThrow(RangeError)
			expect(() => write(Buffer.alloc(0))).toThrow(RangeError)
		}
		client.spiConfig({ channel: 0, deviceId: 1, packed: true })
		expect(client.spiTransfer(0, 1, Buffer.alloc(50))).toBe(3)
		expect(sent.at(-1)?.length).toBe(66)
		expect(() => client.spiTransfer(0, 1, Buffer.alloc(51))).toThrow(RangeError)
		expect(client.spiRead(0, 1, 64)).toBe(4)
		expect(sent.at(-1)).toEqual(Buffer.from([0xf0, 0x68, 4, 8, 4, 1, 64, 0xf7]))
	})
})

describe('Serial, encoder and stepper', () => {
	test('Serial 1.0 configuration, data, controls and reply', () => {
		client.serialConfig(1, 115200, 2, 3)
		client.serialWrite(1, Buffer.from([0x80, 0xff]))
		client.serialStartRead(1, 256)
		client.serialStopRead(1)
		client.serialClose(1)
		client.serialFlush(1)
		client.serialListen(9)
		expect(sent).toEqual([
			Buffer.from([0xf0, 0x60, 0x11, 0, 4, 7, 2, 3, 0xf7]),
			Buffer.from([0xf0, 0x60, 0x21, 0, 1, 127, 1, 0xf7]),
			Buffer.from([0xf0, 0x60, 0x31, 0, 0, 2, 0xf7]),
			Buffer.from([0xf0, 0x60, 0x31, 1, 0xf7]),
			Buffer.from([0xf0, 0x60, 0x51, 0xf7]),
			Buffer.from([0xf0, 0x60, 0x61, 0xf7]),
			Buffer.from([0xf0, 0x60, 0x79, 0xf7]),
		])
		receive(0x60, [0x41, 0, 1, 127, 1])
		expect(events[0]).toEqual(['serial', 1, Buffer.from([0x80, 0xff])])
	})

	test('discovers UART pins by capability resolution', () => {
		receive(0x6c, [PinMode.SERIAL, 2, 127, PinMode.SERIAL, 3, 127])
		expect(client.serialPins(1)).toEqual({ rx: 0, tx: 1 })
		client.serialConfig(1, 9600)
		expect(sent.at(-1)).toEqual(Buffer.from([0xf0, 0x60, 0x11, 0, 75, 0, 0, 1, 0xf7]))
	})

	test('encoder commands and signed batched position reports', () => {
		client.encoderAttach(1, 2, 3)
		client.encoderDetach(1)
		client.encoderReport(1)
		client.encoderReportAll()
		client.encoderReset(1)
		client.encoderAutoReport(true)
		expect(sent).toEqual([Buffer.from([0xf0, 0x61, 0, 1, 2, 3, 0xf7]), Buffer.from([0xf0, 0x61, 5, 1, 0xf7]), Buffer.from([0xf0, 0x61, 1, 1, 0xf7]), Buffer.from([0xf0, 0x61, 2, 0xf7]), Buffer.from([0xf0, 0x61, 3, 1, 0xf7]), Buffer.from([0xf0, 0x61, 4, 1, 0xf7])])
		receive(0x61, [1, 5, 0, 0, 0, 0x42, 7, 0, 0, 0])
		expect(events[0]).toEqual([
			'encoder',
			[
				{ id: 1, position: 5, negative: false },
				{ id: 2, position: -7, negative: true },
			],
		])
		receive(0x61, [0x40, 127, 127, 127, 127])
		expect(events[1]).toEqual(['encoder', [{ id: 0, position: -0x0fffffff, negative: true }]])
	})

	test('signed 32-bit stepper moves, custom floats and completion replies', () => {
		// Wire vectors for 1 step/hour and 100 steps/second are from firmata/protocol
		// accelStepperFirmata.md; sign-magnitude positions match ConfigurableFirmata 3.4.0.
		expect(decodeStepperFloat(Buffer.from([0x31, 0x45, 0x29, 0x05]), 0)).toBeCloseTo(0.0002777777, 9)
		expect(decodeStepperFloat(Buffer.from([1, 0, 0, 0x34]), 0)).toBe(100)
		expect(encodeStepperFloat(1 / 3600)).toEqual([0x31, 0x45, 0x29, 0x05])
		expect(encodeStepperFloat(-1 / 3600)).toEqual([0x31, 0x45, 0x29, 0x45])
		client.stepperConfig({ device: 2, interface: 'driver', pin1: 4, pin2: 5, enablePin: 6 })
		client.stepperZero(2)
		client.stepperMove(2, -1)
		client.stepperMoveTo(2, 0x7fffffff)
		client.stepperEnable(2, true)
		client.stepperStop(2)
		client.stepperReportPosition(2)
		client.stepperSetAcceleration(2, 1 / 3600)
		client.stepperSetMaxSpeed(2, 100)
		client.multiStepperConfig(0, [2, 3])
		client.multiStepperMoveTo(0, [-1, 0])
		client.multiStepperStop(0)
		expect(sent[0]).toEqual(Buffer.from([0xf0, 0x62, 0, 2, 0x11, 4, 5, 6, 0xf7]))
		expect(sent[1]).toEqual(Buffer.from([0xf0, 0x62, 1, 2, 0xf7]))
		expect(sent[2]).toEqual(Buffer.from([0xf0, 0x62, 2, 2, 1, 0, 0, 0, 8, 0xf7]))
		expect(sent[3]).toEqual(Buffer.from([0xf0, 0x62, 3, 2, 127, 127, 127, 127, 7, 0xf7]))
		expect(sent[4]).toEqual(Buffer.from([0xf0, 0x62, 4, 2, 1, 0xf7]))
		expect(sent[5]).toEqual(Buffer.from([0xf0, 0x62, 5, 2, 0xf7]))
		expect(sent[6]).toEqual(Buffer.from([0xf0, 0x62, 6, 2, 0xf7]))
		expect(sent[7]).toEqual(Buffer.from([0xf0, 0x62, 8, 2, 0x31, 0x45, 0x29, 0x05, 0xf7]))
		expect(sent[9]).toEqual(Buffer.from([0xf0, 0x62, 0x20, 0, 2, 3, 0xf7]))
		expect(sent[10]).toEqual(Buffer.from([0xf0, 0x62, 0x21, 0, 1, 0, 0, 0, 8, 0, 0, 0, 0, 0, 0xf7]))
		expect(sent[11]).toEqual(Buffer.from([0xf0, 0x62, 0x23, 0, 0xf7]))
		receive(0x62, [6, 2, 1, 0, 0, 0, 8])
		receive(0x62, [0x0a, 2, 1, 0, 0, 0, 0])
		receive(0x62, [0x24, 0])
		expect(events).toEqual([
			['stepper', { device: 2, position: -1, complete: false }],
			['stepper', { device: 2, position: 1, complete: true }],
			['multi', 0],
		])
	})

	test('stepper configurations omit optional inversion and limit 3/4-wire step size', () => {
		client.stepperConfig({ device: 0, interface: 'driver', pin1: 2, pin2: 3 })
		client.stepperConfig({ device: 1, interface: 'twoWire', pin1: 2, pin2: 3, enablePin: 6 })
		client.stepperConfig({ device: 2, interface: 'threeWire', stepType: 0, pin1: 2, pin2: 3, pin3: 4 })
		client.stepperConfig({ device: 3, interface: 'threeWire', stepType: 1, pin1: 2, pin2: 3, pin3: 4 })
		client.stepperConfig({ device: 4, interface: 'fourWire', stepType: 0, pin1: 2, pin2: 3, pin3: 4, pin4: 5 })
		client.stepperConfig({ device: 5, interface: 'fourWire', stepType: 1, pin1: 2, pin2: 3, pin3: 4, pin4: 5, invertPins: 0x13 })
		expect(sent).toEqual([
			Buffer.from([0xf0, 0x62, 0, 0, 0x10, 2, 3, 0xf7]),
			Buffer.from([0xf0, 0x62, 0, 1, 0x21, 2, 3, 6, 0xf7]),
			Buffer.from([0xf0, 0x62, 0, 2, 0x30, 2, 3, 4, 0xf7]),
			Buffer.from([0xf0, 0x62, 0, 3, 0x32, 2, 3, 4, 0xf7]),
			Buffer.from([0xf0, 0x62, 0, 4, 0x40, 2, 3, 4, 5, 0xf7]),
			Buffer.from([0xf0, 0x62, 0, 5, 0x42, 2, 3, 4, 5, 0x13, 0xf7]),
		])
		type UnsupportedThreeWire = { interface: 'threeWire'; stepType: 2; device: number; pin1: number; pin2: number; pin3: number } extends StepperConfig ? true : false
		type UnsupportedFourWire = { interface: 'fourWire'; stepType: 7; device: number; pin1: number; pin2: number; pin3: number; pin4: number } extends StepperConfig ? true : false
		const threeWireAllowsUnsupported: UnsupportedThreeWire = false
		const fourWireAllowsUnsupported: UnsupportedFourWire = false
		expect(threeWireAllowsUnsupported).toBeFalse()
		expect(fourWireAllowsUnsupported).toBeFalse()
	})
})

describe('DHT, scheduler and frequency', () => {
	test('DHT attach/detach and scaled signed reports', () => {
		client.dhtAttach(4, 'dht22', 500)
		client.dhtAttach(5, 'dht11', 500, true)
		client.dhtDetach(4)
		expect(sent).toEqual([Buffer.from([0xf0, 0x74, 2, 4, 0, 116, 3, 0xf7]), Buffer.from([0xf0, 0x74, 1, 5, 1, 116, 3, 0xf7]), Buffer.from([0xf0, 0x74, 3, 4, 0xf7])])
		receive(0x74, [0, 4, 2, 126, 55, 4])
		expect(events[0]).toEqual(['dht', { pin: 4, temperature: -25.4, humidity: 56.7 }])
		receive(0x74, [0, 4, 123, 1, 100, 5])
		expect(events[1]).toEqual(['dht', { pin: 4, temperature: 25.1, humidity: 74 }])
	})

	test('scheduler task commands, packed data and replies', () => {
		client.schedulerCreate(3, 300)
		client.schedulerAdd(3, Buffer.from([0xff, 0x01]))
		client.schedulerDelay(0x7fffffff)
		client.schedulerSchedule(3, 0x7fffffff)
		expect(() => client.schedulerDelay(-1)).toThrow(RangeError)
		expect(() => client.schedulerDelay(0x80000000)).toThrow(RangeError)
		expect(() => client.schedulerSchedule(3, 0x80000000)).toThrow(RangeError)
		client.schedulerQueryAll()
		client.schedulerQuery(3)
		client.schedulerDelete(3)
		client.schedulerReset()
		expect(sent).toEqual([
			Buffer.from([0xf0, 0x7b, 0, 3, 44, 2, 0xf7]),
			Buffer.from([0xf0, 0x7b, 2, 3, 127, 3, 0, 0xf7]),
			Buffer.from([0xf0, 0x7b, 3, 127, 127, 127, 127, 7, 0xf7]),
			Buffer.from([0xf0, 0x7b, 4, 3, 127, 127, 127, 127, 7, 0xf7]),
			Buffer.from([0xf0, 0x7b, 5, 0xf7]),
			Buffer.from([0xf0, 0x7b, 6, 3, 0xf7]),
			Buffer.from([0xf0, 0x7b, 1, 3, 0xf7]),
			Buffer.from([0xf0, 0x7b, 7, 0xf7]),
		])
		receive(0x7b, [9, 3, 4])
		receive(0x7b, [10, 3, 1, 0, 0, 0, 16, 0, 0, 0, 0, 0])
		receive(0x7b, [8, 3, 1, 0, 0, 0, 16, 0, 0, 0, 0, 0])
		expect(events[0]).toEqual(['tasks', [3, 4]])
		expect(events[1]).toEqual(['task', { id: 3, found: true, time: 1, length: 1, position: 0, data: Buffer.alloc(0), error: false }])
		expect(events[2]).toEqual(['task', { id: 3, found: true, time: 1, length: 1, position: 0, data: Buffer.alloc(0), error: true }])
		receive(0x7b, [8, 7])
		expect(events[3]).toEqual(['task', { id: 7, found: false, error: true }])
		receive(0x7b, [10, 3, 1, 0, 0, 0, 16, 0, 0, 0, 0, 126, 3])
		expect(events[4]).toEqual(['task', { id: 3, found: true, time: 1, length: 1, position: 0, data: Buffer.from([0xff]), error: false }])
	})

	test('frequency commands and full unsigned counters', () => {
		client.frequencyQuery(4, 3, 1000)
		client.frequencyClear(4)
		client.frequencyClear()
		client.frequencyFilter(4, 0xffffffff)
		expect(sent).toEqual([Buffer.from([0xf0, 0x7d, 1, 4, 3, 104, 7, 0xf7]), Buffer.from([0xf0, 0x7d, 0, 4, 0xf7]), Buffer.from([0xf0, 0x7d, 0, 127, 0xf7]), Buffer.from([0xf0, 0x7d, 3, 4, 127, 127, 127, 127, 15, 0xf7])])
		receive(0x7d, [2, 4, 127, 127, 127, 127, 15, 0, 0, 0, 0, 8])
		expect(events[0]).toEqual(['frequency', { pin: 4, timestamp: 0xffffffff, ticks: 0x80000000 }])
	})
})

test('truncated feature replies are ignored and the parser accepts the next frame', () => {
	for (const [command, payload] of [
		[0x66, [0, 1]],
		[0x68, [5, 1]],
		[0x60, [0x41, 1]],
		[0x61, [1, 2]],
		[0x62, [6, 1]],
		[0x74, [0, 1]],
		[0x7b, [10]],
		[0x7d, [2, 1]],
		[0x7a, [1]],
	] as const)
		receive(command, payload)
	expect(events).toEqual([])
	receive(0x7a, [19, 0])
	expect(events).toEqual([['sampling', 19]])
	client.process(Buffer.from([0xf0, 0x68, 5, 1, 0xf0, 0x7a, 20, 0, 0xf7]))
	expect(events).toEqual([
		['sampling', 19],
		['sampling', 20],
	])
})
