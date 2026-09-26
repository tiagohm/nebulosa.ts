import { expect, test } from 'bun:test'
import { PCF8574 } from '../../../../src/devices/firmata/components/io'
import { MockFirmataClient } from '../util'

test('PCF8574 stages port writes and configures registerless reads on start', () => {
	const client = new MockFirmataClient()
	const expander = new PCF8574(client as never, PCF8574.ADDRESS, 1000)

	expander.pinWrite(0, false)
	expander.start()

	// expect(expander.output).toBe(0xfe)
	// expect(expander.inputMask).toBe(0xfe)
	expect(client.messages).toEqual([
		['config', 0],
		['write', PCF8574.ADDRESS, Buffer.from([0xfe])],
		['read', PCF8574.ADDRESS, -1, 1, false, 7, 'stop'],
	])

	expander.stop()
	expect(client.handlers.size).toBe(0)
})

test('PCF8574 releases input pins and updates the cached port state from I2C replies', () => {
	const client = new MockFirmataClient()
	using expander = new PCF8574(client as never, PCF8574.ADDRESS, 1000)
	let updates = 0

	expander.addListener(() => {
		updates++
	})

	expander.start()
	client.messages.length = 0

	expander.pinWrite(0, false)

	// expect(expander.output).toBe(0xfe)
	// expect(expander.inputMask).toBe(0xfe)
	expect(client.messages).toEqual([
		['write', PCF8574.ADDRESS, Buffer.from([0xfe])],
		['read', PCF8574.ADDRESS, -1, 1, false, 7, 'stop'],
	])

	client.messages.length = 0
	expander.pinMode(0, 0)

	// expect(expander.inputMask).toBe(0xff)
	expect(client.messages).toEqual([
		['write', PCF8574.ADDRESS, Buffer.from([0xff])],
		['read', PCF8574.ADDRESS, -1, 1, false, 7, 'stop'],
	])

	expander.twoWireMessage(client as never, PCF8574.ADDRESS, 0xff, Buffer.from([0xaa]))
	// expect(expander.state).toBe(0xaa)
	expect(expander.pinRead(0)).toBeFalse()
	expect(expander.pinRead(1)).toBeTrue()
	expect(expander.pinRead(7)).toBeTrue()
	expect(updates).toBe(1)

	expander.twoWireMessage(client as never, PCF8574.ADDRESS, 0, Buffer.from([0xaa]))
	expect(updates).toBe(1)
})
