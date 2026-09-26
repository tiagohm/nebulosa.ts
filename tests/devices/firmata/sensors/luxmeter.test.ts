import { expect, test } from 'bun:test'
import { BH1750, MAX44009, TEMT6000, TSL2561 } from '../../../../src/devices/firmata/sensors/luxmeter'
import { PinMode } from '../../../../src/devices/firmata/types'
import { MockFirmataClient } from '../util'

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

	temt6000.pinChange(client as never, { id: 3, modes: new Set([PinMode.ANALOG]), resolutions: new Map(), mode: PinMode.ANALOG, value: 1023 })
	expect(temt6000.lux).toBeCloseTo(1000, 6)
	expect(updates).toBe(1)

	temt6000.pinChange(client as never, { id: 3, modes: new Set([PinMode.ANALOG]), resolutions: new Map(), mode: PinMode.ANALOG, value: 1023 })
	expect(updates).toBe(1)

	temt6000.stop()
	expect(client.handlers.size).toBe(0)
	expect(client.messages.at(-1)).toEqual(['analogReport', 3, false])
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

	bh1750.twoWireMessage(client as never, BH1750.ADDRESS, 0, Buffer.from([0x00, 0x78]))
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
	expect(tsl2561.calculateLux(65535, 12)).toBe(TSL2561.SATURATED_LUX)
})

test('TSL2561 configures i2c reads and emits lux updates', async () => {
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
	])

	await Bun.sleep(420)

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

	tsl2561.twoWireMessage(client as never, TSL2561.ADDRESS, TSL2561.COMMAND_BIT | TSL2561.BLOCK_BIT | TSL2561.DATA0LOW_REG, Buffer.from([0xff, 0xff, 0x0c, 0x00]))
	expect(tsl2561.lux).toBe(TSL2561.SATURATED_LUX)
	expect(updates).toBe(2)

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
		['read', MAX44009.ADDRESS, MAX44009.LUX_HIGH_REG, 1, false, 7, 'restart'],
	])

	max44009.twoWireMessage(client as never, MAX44009.ADDRESS, MAX44009.LUX_HIGH_REG, Buffer.from([0x12]))
	expect(max44009.lux).toBeCloseTo(2.88, 6)
	expect(updates).toBe(1)

	max44009.twoWireMessage(client as never, MAX44009.ADDRESS, MAX44009.LUX_HIGH_REG, Buffer.from([0x12]))
	expect(updates).toBe(1)

	max44009.stop()
	expect(client.handlers.size).toBe(0)
})
