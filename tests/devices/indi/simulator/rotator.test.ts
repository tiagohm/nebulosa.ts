import { describe, expect, test } from 'bun:test'
import { IndiClientHandlerSet } from '../../../../src/devices/indi/client'
import { RotatorManager } from '../../../../src/devices/indi/manager/rotator'
import { ClientSimulator } from '../../../../src/devices/indi/simulator/client'
import { RotatorSimulator } from '../../../../src/devices/indi/simulator/rotator'
import { isTimeConsumingTestSkipped, waitUntil } from '../../../util'

// Integration coverage for simulated rotator movement, reverse, sync, and home.

const SKIP = isTimeConsumingTestSkipped()

describe.skipIf(SKIP)('rotator simulator', () => {
	test('integrates rotation controls with rotator manager', async () => {
		const handler = new IndiClientHandlerSet()
		const manager = new RotatorManager()
		handler.add(manager)

		using client = new ClientSimulator('rotator', handler)
		using simulator = new RotatorSimulator('Rotator Simulator', client)
		const rotator = manager.get(client, simulator.name)!

		manager.connect(rotator)
		await waitUntil(() => rotator.connected)

		expect(manager.properties.length).toBe(1)
		expect(rotator.canAbort).toBeTrue()
		expect(rotator.canReverse).toBeTrue()
		expect(rotator.canSync).toBeTrue()
		expect(rotator.canHome).toBeTrue()
		expect(rotator.hasBacklashCompensation).toBeFalse()

		manager.moveTo(rotator, 42.5)
		await waitUntil(() => rotator.moving)
		await waitUntil(() => !rotator.moving, 3000)
		expect(rotator.angle.value).toBeCloseTo(42.5, 2)

		manager.reverse(rotator, true)
		await waitUntil(() => rotator.reversed)
		client.sendSwitch({ device: rotator.name, name: 'ROTATOR_BACKLASH_TOGGLE', elements: { INDI_ENABLED: true } })
		await waitUntil(() => rotator.hasBacklashCompensation)

		manager.syncTo(rotator, 90)
		await waitUntil(() => Math.abs(rotator.angle.value - 90) < 1e-9)
		manager.home(rotator)
		await waitUntil(() => rotator.moving)
		await waitUntil(() => !rotator.moving, 3000)
		expect(rotator.angle.value).toBeCloseTo(0, 2)

		simulator.dispose()
		expect(manager.has(client, rotator.name)).toBeFalse()
		expect(manager.properties.length).toBe(0)
	}, 4000)

	test('retargets an active slew to the current angle', async () => {
		const handler = new IndiClientHandlerSet()
		const manager = new RotatorManager()
		handler.add(manager)

		using client = new ClientSimulator('rotator', handler)
		using simulator = new RotatorSimulator('Rotator Simulator', client)
		const rotator = manager.get(client, simulator.name)!

		manager.connect(rotator)
		await waitUntil(() => rotator.connected)

		manager.moveTo(rotator, 180)
		await waitUntil(() => rotator.angle.value >= 20 && rotator.angle.value <= 90, 1000, 20)
		const current = rotator.angle.value

		manager.moveTo(rotator, current)
		await waitUntil(() => !rotator.moving)
		await Bun.sleep(200)

		expect(rotator.angle.value).toBeCloseTo(current, 12)
	}, 3000)

	test('normalizes the 360-degree boundary', async () => {
		const handler = new IndiClientHandlerSet()
		const manager = new RotatorManager()
		handler.add(manager)

		using client = new ClientSimulator('rotator', handler)
		using simulator = new RotatorSimulator('Rotator Simulator', client)
		const rotator = manager.get(client, simulator.name)!

		manager.connect(rotator)
		await waitUntil(() => rotator.connected)

		manager.syncTo(rotator, 360)
		await waitUntil(() => rotator.angle.value === 0)
		expect(rotator.moving).toBeFalse()

		manager.syncTo(rotator, 90)
		manager.moveTo(rotator, 360)
		await waitUntil(() => rotator.moving)
		await waitUntil(() => !rotator.moving, 2000)
		expect(rotator.angle.value).toBeCloseTo(0, 12)

		manager.moveTo(rotator, 360)
		await Bun.sleep(200)
		expect(rotator.moving).toBeFalse()
		expect(rotator.angle.value).toBeCloseTo(0, 12)
	}, 4000)
})
