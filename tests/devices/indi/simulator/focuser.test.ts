import { describe, expect, test } from 'bun:test'
import { IndiClientHandlerSet } from '../../../../src/devices/indi/client'
import { FocuserManager, ThermometerManager } from '../../../../src/devices/indi/manager'
import { ClientSimulator } from '../../../../src/devices/indi/simulator/client'
import { FocuserSimulator } from '../../../../src/devices/indi/simulator/focuser'
import { isTimeConsumingTestSkipped, waitUntil } from '../../../util'

// Integration coverage for simulated focuser movement, temperature, and manager projection.

const SKIP = isTimeConsumingTestSkipped()

describe.skipIf(SKIP)('focuser simulator', () => {
	test('integrates motion and temperature compensation with focuser managers', async () => {
		const handler = new IndiClientHandlerSet()
		const focuserManager = new FocuserManager()
		const thermometerManager = new ThermometerManager(focuserManager)

		handler.add(focuserManager)
		handler.add(thermometerManager)

		using client = new ClientSimulator('focuser', handler)
		using simulator = new FocuserSimulator('Focuser Simulator', client)
		const focuser = focuserManager.get(client, simulator.name)!

		focuserManager.connect(focuser)
		await waitUntil(() => focuser.connected)

		expect(focuserManager.properties.length).toBe(1)
		expect(thermometerManager.properties.length).toBe(1)
		expect(focuser.hasThermometer).toBeTrue()
		expect(focuser.canAbsoluteMove).toBeTrue()
		expect(focuser.canRelativeMove).toBeTrue()
		expect(focuser.canAbort).toBeTrue()
		expect(focuser.canReverse).toBeTrue()
		expect(focuser.canSync).toBeTrue()
		expect(focuser.position.value).toBe(50000)

		const properties = focuserManager.properties.get(focuser)!
		expect(properties.FOCUS_TEMPERATURE).toBeDefined()
		expect(properties.FOCUS_TEMPERATURE_COMPENSATION).toBeDefined()

		const initialTemperature = Number(properties.FOCUS_TEMPERATURE.elements.TEMPERATURE.value)
		await waitUntil(() => Math.abs(Number(properties.FOCUS_TEMPERATURE.elements.TEMPERATURE.value) - initialTemperature) >= 0.05, 3000)

		const compensatedStart = focuser.position.value
		client.sendSwitch({ device: focuser.name, name: 'FOCUS_TEMPERATURE_COMPENSATION', elements: { INDI_ENABLED: true } })
		await waitUntil(() => properties.FOCUS_TEMPERATURE_COMPENSATION.elements.INDI_ENABLED.value === true)
		await waitUntil(() => focuser.position.value !== compensatedStart, 4000)
		await waitUntil(() => !focuser.moving, 3000)

		client.sendSwitch({ device: focuser.name, name: 'FOCUS_TEMPERATURE_COMPENSATION', elements: { INDI_DISABLED: true } })
		await waitUntil(() => properties.FOCUS_TEMPERATURE_COMPENSATION.elements.INDI_DISABLED.value === true)

		focuserManager.moveTo(focuser, 62000)
		await waitUntil(() => !focuser.moving, 3000)
		expect(focuser.position.value).toBeCloseTo(62000, 6)

		focuserManager.moveIn(focuser, 2000)
		await waitUntil(() => !focuser.moving, 3000)
		expect(focuser.position.value).toBeCloseTo(60000, 6)

		focuserManager.reverse(focuser, true)
		await waitUntil(() => focuser.reversed)
		focuserManager.moveIn(focuser, 1000)
		await waitUntil(() => !focuser.moving, 3000)
		expect(focuser.position.value).toBeCloseTo(61000, 6)

		focuserManager.syncTo(focuser, 12345)
		await waitUntil(() => focuser.position.value === 12345)

		const thermometer = thermometerManager.get(client, focuser.name)!
		expect(thermometer.type).toBe('thermometer')
		expect(thermometer.id).not.toBe(focuser.id)
		expect(thermometer.parentId).toBe(focuser.id)

		simulator.dispose()
		expect(focuserManager.has(client, focuser.name)).toBeFalse()
		expect(thermometerManager.has(client, focuser.name)).toBeFalse()
		expect(focuserManager.properties.length).toBe(0)
		expect(thermometerManager.properties.length).toBe(0)
	}, 7000)
})
