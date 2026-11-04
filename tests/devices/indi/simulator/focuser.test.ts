import { describe, expect, test } from 'bun:test'
import { IndiClientHandlerSet } from '../../../../src/devices/indi/client'
import { FocuserManager } from '../../../../src/devices/indi/manager/focuser'
import { ThermometerManager } from '../../../../src/devices/indi/manager/thermometer'
import { ClientSimulator } from '../../../../src/devices/indi/simulator/client'
import { FocuserSimulator } from '../../../../src/devices/indi/simulator/focuser'
import { isTimeConsumingTestSkipped, waitUntil } from '../../../util'

// Integration coverage for simulated focuser movement, backlash, temperature, and manager projection.

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
		expect(properties.SIMULATOR_BACKLASH).toBeDefined()
		expect(focuser.hasBacklash).toBeTrue()
		expect(focuser.backlashEnabled).toBeFalse()

		client.sendSwitch({ device: focuser.name, name: 'FOCUS_BACKLASH_TOGGLE', elements: { INDI_ENABLED: true } })
		client.sendNumber({ device: focuser.name, name: 'FOCUS_BACKLASH_STEPS', elements: { FOCUS_BACKLASH_VALUE: 30 } })
		await waitUntil(() => focuser.backlashEnabled && focuser.backlash.value === 30)
		client.sendSwitch({ device: focuser.name, name: 'FOCUS_BACKLASH_TOGGLE', elements: { INDI_DISABLED: true } })
		await waitUntil(() => !focuser.backlashEnabled)

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
		// Reverse inverts the motor, not the counter, so inward still decreases the position.
		focuserManager.moveIn(focuser, 1000)
		await waitUntil(() => !focuser.moving, 3000)
		expect(focuser.position.value).toBeCloseTo(59000, 6)

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
	})

	test('simulates gear play with persistent partial slack', async () => {
		using client = new ClientSimulator('focuser', new IndiClientHandlerSet())
		using simulator = new FocuserSimulator('Focuser Simulator', client, { backlash: 80 })

		expect(simulator.backlash).toBe(80)
		simulator.connect()
		client.sendNumber({ device: simulator.name, name: 'SIMULATOR_BACKLASH', elements: { BACKLASH: 150 } })
		expect(simulator.backlash).toBe(150)
		simulator.syncTo(50000)

		async function moveTo(position: number) {
			simulator.moveTo(position)
			await waitUntil(() => !simulator.isMoving)
			expect(simulator.position).toBe(position)
			expect(Math.abs(simulator.position - simulator.effectivePosition)).toBeLessThanOrEqual(simulator.backlash + 1e-9)
			return simulator.effectivePosition
		}

		// An unloaded gear train engages immediately.
		expect(await moveTo(51000)).toBeCloseTo(51000, 6)

		// A partial inward reversal opens 40 of the 150 steps of slack without moving the optics.
		expect(await moveTo(50960)).toBeCloseTo(51000, 6)

		// Returning outward only has to close the 40 steps opened on the other flank.
		expect(await moveTo(50980)).toBeCloseTo(51000, 6)
		expect(await moveTo(51020)).toBeCloseTo(51020, 6)

		// A full reversal costs the whole gap.
		expect(await moveTo(50870)).toBeCloseTo(51020, 6)
		expect(await moveTo(50820)).toBeCloseTo(50970, 6)

		// The play is the same in both directions, so IN/OUT cycles never drift the optics.
		const outward: number[] = []
		const inward: number[] = []

		for (let i = 0; i < 5; i++) {
			outward.push(await moveTo(51500))
			inward.push(await moveTo(50500))
		}

		for (let i = 0; i < 5; i++) {
			expect(outward[i]).toBeCloseTo(51500, 6)
			expect(inward[i]).toBeCloseTo(50650, 6)
		}

		// Shrinking the gap to 40 clamps the 50 steps of slack a partial reversal left open.
		expect(await moveTo(50600)).toBeCloseTo(50650, 6)
		client.sendNumber({ device: simulator.name, name: 'SIMULATOR_BACKLASH', elements: { BACKLASH: 40 } })
		expect(simulator.backlash).toBe(40)
		expect(await moveTo(50700)).toBeCloseTo(50710, 6)

		// Sync establishes a new optical reference and unloads the gear train.
		simulator.syncTo(30000)
		expect(simulator.effectivePosition).toBeCloseTo(30000, 6)
		expect(await moveTo(29950)).toBeCloseTo(29950, 6)
	})

	test('retargets an active move to the current position', async () => {
		using client = new ClientSimulator('focuser', new IndiClientHandlerSet())
		using simulator = new FocuserSimulator('Focuser Simulator', client)

		simulator.connect()
		const initial = simulator.position
		simulator.moveTo(initial + 40000)
		expect(simulator.isMoving).toBeTrue()
		simulator.moveTo(initial)
		expect(simulator.isMoving).toBeFalse()
		expect(simulator.position).toBe(initial)

		simulator.moveTo(initial + 30000)
		await waitUntil(() => simulator.position > initial)
		const current = simulator.position
		simulator.moveTo(current)
		expect(simulator.isMoving).toBeFalse()
		await Bun.sleep(250)
		expect(simulator.position).toBe(current)
	})

	test('keeps idle position vectors idle when aborting without motion', async () => {
		const handler = new IndiClientHandlerSet()
		const focuserManager = new FocuserManager()
		handler.add(focuserManager)

		using client = new ClientSimulator('focuser', handler)
		using simulator = new FocuserSimulator('Focuser Simulator', client)
		const focuser = focuserManager.get(client, simulator.name)!

		focuserManager.connect(focuser)
		await waitUntil(() => focuser.connected)
		const properties = focuserManager.properties.get(focuser)!

		simulator.stop()
		expect(properties.ABS_FOCUS_POSITION.state).toBe('Idle')
		expect(properties.REL_FOCUS_POSITION.state).toBe('Idle')

		focuserManager.moveTo(focuser, simulator.position + 40000)
		await waitUntil(() => focuser.moving)
		focuserManager.stop(focuser)
		await waitUntil(() => !focuser.moving)
		expect(properties.ABS_FOCUS_POSITION.state).toBe('Alert')
		expect(properties.REL_FOCUS_POSITION.state).toBe('Alert')
	})
})
