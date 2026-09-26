import { expect, test } from 'bun:test'
import { ACS712 } from '../../../../src/devices/firmata/sensors/ammeter'
import { PinMode } from '../../../../src/devices/firmata/types'
import { MockFirmataClient } from '../util'

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

	acs712.pinChange(client as never, { id: 4, modes: new Set([PinMode.ANALOG]), resolutions: new Map(), mode: PinMode.ANALOG, value: 549.351 })
	expect(acs712.current).toBeCloseTo(1, 3)
	expect(updates).toBe(1)

	acs712.pinChange(client as never, { id: 4, modes: new Set([PinMode.ANALOG]), resolutions: new Map(), mode: PinMode.ANALOG, value: 549.351 })
	expect(updates).toBe(1)

	acs712.stop()
	expect(client.handlers.size).toBe(0)
	expect(client.messages.at(-1)).toEqual(['analogReport', 4, false])
})
