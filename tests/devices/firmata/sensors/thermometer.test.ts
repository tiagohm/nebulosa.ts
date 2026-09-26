import { expect, test } from 'bun:test'
import { DS18B20, LM35 } from '../../../../src/devices/firmata/sensors/thermometer'
import { PinMode } from '../../../../src/devices/firmata/types'
import { CRC } from '../../../../src/io/crc'
import { MockFirmataClient } from '../util'

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

	lm35.pinChange(client as never, { id: 2, modes: new Set([PinMode.ANALOG]), resolutions: new Map(), mode: PinMode.ANALOG, value: 51.15 })
	expect(lm35.temperature).toBeCloseTo(25, 6)
	expect(updates).toBe(1)

	lm35.pinChange(client as never, { id: 2, modes: new Set([PinMode.ANALOG]), resolutions: new Map(), mode: PinMode.ANALOG, value: 51.15 })
	expect(updates).toBe(1)

	lm35.stop()
	expect(client.handlers.size).toBe(0)
	expect(client.messages.at(-1)).toEqual(['analogReport', 2, false])
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

test('DS18B20 waits for a matching ROM search reply before measuring', async () => {
	const client = new MockFirmataClient()
	const otherClient = new MockFirmataClient()
	using ds18b20 = new DS18B20(client as never, 6, 1000, { resolution: 9 })
	const address = Buffer.from([DS18B20.FAMILY_CODE, 0x1a, 0xbc, 0x4d, 0x2f, 0x00, 0x00, 0xc1])
	const selectedAddress = Buffer.from(address)

	ds18b20.start()
	expect(client.messages).toEqual([
		['oneWireConfig', 6, 'normal'],
		['oneWireSearch', 6, 'all'],
	])

	ds18b20.oneWireSearchReply(otherClient as never, 6, [address], false)
	ds18b20.oneWireSearchReply(client as never, 7, [address], false)
	ds18b20.oneWireSearchReply(client as never, 6, [address], true)
	ds18b20.oneWireSearchReply(client as never, 6, [Buffer.from([0x10, 1, 2, 3, 4, 5, 6, 7])], false)
	expect(client.messages).toHaveLength(2)

	ds18b20.oneWireSearchReply(client as never, 6, [address], false)
	address[1] = 0xff
	ds18b20.oneWireSearchReply(client as never, 6, [selectedAddress], false)
	expect(client.messages.slice(2)).toEqual([
		['oneWireWrite', 6, Buffer.from([DS18B20.WRITE_SCRATCHPAD_CMD, DS18B20.DEFAULT_TH, DS18B20.DEFAULT_TL, 0x1f]), selectedAddress],
		['oneWireWrite', 6, Buffer.from(DS18B20.CONVERT_T_CMD), selectedAddress],
	])

	await Bun.sleep(110)
	const readMessage = client.messages[4] as readonly ['oneWireWriteAndRead', number, Buffer, number, Buffer | undefined, number]
	expect(readMessage).toEqual(['oneWireWriteAndRead', 6, Buffer.from(DS18B20.READ_SCRATCHPAD_CMD), DS18B20.SCRATCHPAD_SIZE, selectedAddress, 0x4000])
	ds18b20.oneWireReadReply(client as never, 6, readMessage[5], createDS18B20Scratchpad(-10.5))
	expect(ds18b20.temperature).toBeCloseTo(-10.5, 6)
})

test('DS18B20 cancels a conversion when stopped and restarts cleanly', async () => {
	const client = new MockFirmataClient()
	const address = Buffer.from([DS18B20.FAMILY_CODE, 0x1a, 0xbc, 0x4d, 0x2f, 0x00, 0x00, 0xc1])
	const ds18b20 = new DS18B20(client as never, 6, 1000, { address, resolution: 9 })

	ds18b20.start()
	ds18b20.stop()

	await Bun.sleep(110)
	expect(client.messages).toEqual([
		['oneWireConfig', 6, 'normal'],
		['oneWireWrite', 6, Buffer.from([DS18B20.WRITE_SCRATCHPAD_CMD, DS18B20.DEFAULT_TH, DS18B20.DEFAULT_TL, 0x1f]), address],
		['oneWireWrite', 6, Buffer.from(DS18B20.CONVERT_T_CMD), address],
	])

	ds18b20.start()
	await Bun.sleep(110)

	expect(client.messages).toEqual([
		['oneWireConfig', 6, 'normal'],
		['oneWireWrite', 6, Buffer.from([DS18B20.WRITE_SCRATCHPAD_CMD, DS18B20.DEFAULT_TH, DS18B20.DEFAULT_TL, 0x1f]), address],
		['oneWireWrite', 6, Buffer.from(DS18B20.CONVERT_T_CMD), address],
		['oneWireConfig', 6, 'normal'],
		['oneWireWrite', 6, Buffer.from([DS18B20.WRITE_SCRATCHPAD_CMD, DS18B20.DEFAULT_TH, DS18B20.DEFAULT_TL, 0x1f]), address],
		['oneWireWrite', 6, Buffer.from(DS18B20.CONVERT_T_CMD), address],
		['oneWireWriteAndRead', 6, Buffer.from(DS18B20.READ_SCRATCHPAD_CMD), DS18B20.SCRATCHPAD_SIZE, address, 0x4000],
	])

	ds18b20.stop()
})

function createDS18B20Scratchpad(temperature: number) {
	const scratchpad = Buffer.from([0, 0, DS18B20.DEFAULT_TH, DS18B20.DEFAULT_TL, 0x1f, 0xff, 0x0c, 0x10, 0])
	scratchpad.writeInt16LE(Math.round(temperature * 16), 0)
	scratchpad[8] = CRC.crc8maxim.compute(scratchpad, undefined, 0, 8)
	return scratchpad
}
