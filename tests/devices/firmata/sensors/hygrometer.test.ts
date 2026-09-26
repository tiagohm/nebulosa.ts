import { expect, test } from 'bun:test'
import { AM2320, SHT21 } from '../../../../src/devices/firmata/sensors/hygrometer'
import { MockFirmataClient } from '../util'

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

test('SHT21 clamps relative humidity to the Hygrometer domain', () => {
	const client = new MockFirmataClient()
	const sht21 = new SHT21(client as never, 1000)

	sht21.twoWireMessage(client as never, SHT21.ADDRESS, 0xe5, Buffer.from([0xd9, 0x30]))
	expect(sht21.humidity).toBe(100)

	sht21.twoWireMessage(client as never, SHT21.ADDRESS, 0xe5, Buffer.from([0x00, 0x00]))
	expect(sht21.humidity).toBe(0)
})

test('SHT21 ignores incomplete and unrelated I2C replies', () => {
	const client = new MockFirmataClient()
	const otherClient = new MockFirmataClient()
	const sht21 = new SHT21(client as never, 1000)

	for (const data of [Buffer.alloc(0), Buffer.from([0x68])]) {
		sht21.twoWireMessage(client as never, SHT21.ADDRESS, 0xe3, data)
		sht21.twoWireMessage(client as never, SHT21.ADDRESS, 0xe5, data)
	}
	sht21.twoWireMessage(otherClient as never, SHT21.ADDRESS, 0xe3, Buffer.from([0x68, 0xac]))

	expect(sht21.temperature).toBe(0)
	expect(sht21.humidity).toBe(0)
	expect(sht21.samples).toBe(0)
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

	await Bun.sleep(60)

	expect(client.messages[2]).toEqual(['write', AM2320.ADDRESS, Buffer.from([AM2320.READ_HOLDING_REGISTERS_CMD, AM2320.START_REGISTER, AM2320.REGISTER_COUNT])])
	expect(client.messages[3]).toEqual(['read', AM2320.ADDRESS, -1, AM2320.FRAME_SIZE, false, 7, 'stop'])

	const validFrame = Buffer.from([AM2320.READ_HOLDING_REGISTERS_CMD, AM2320.REGISTER_COUNT, 0x02, 0x2b, 0x80, 0x7b, 0xa1, 0xbb])
	am2320.twoWireMessage(client as never, AM2320.ADDRESS, -1, validFrame)
	expect(am2320.humidity).toBeCloseTo(55.5, 6)
	expect(am2320.temperature).toBeCloseTo(-12.3, 6)
	expect(updates).toBe(1)
	expect(am2320.samples).toBe(1)

	am2320.twoWireMessage(client as never, AM2320.ADDRESS, -1, Buffer.from([AM2320.READ_HOLDING_REGISTERS_CMD, AM2320.REGISTER_COUNT, 0x02, 0x2b, 0x80, 0x7b, 0x00, 0x00]))
	expect(am2320.humidity).toBeCloseTo(55.5, 6)
	expect(am2320.temperature).toBeCloseTo(-12.3, 6)
	expect(updates).toBe(1)
	expect(am2320.samples).toBe(1)

	am2320.twoWireMessage(client as never, AM2320.ADDRESS, -1, validFrame)
	expect(updates).toBe(1)
	expect(am2320.samples).toBe(2)

	am2320.stop()
	expect(client.handlers.size).toBe(0)
})
