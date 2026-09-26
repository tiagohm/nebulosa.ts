import { expect, test } from 'bun:test'
import { MCP4725 } from '../../../../src/devices/firmata/components/dac'
import { MockFirmataClient } from '../util'

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
