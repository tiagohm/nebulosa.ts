import { describe, expect, test } from 'bun:test'
import { IndiClientHandlerSet } from '../../../../src/devices/indi/client'
import { WheelManager } from '../../../../src/devices/indi/manager'
import { ClientSimulator } from '../../../../src/devices/indi/simulator/client'
import { WheelSimulator } from '../../../../src/devices/indi/simulator/wheel'
import { isTimeConsumingTestSkipped, waitUntil } from '../../../util'

// Integration coverage for simulated filter-wheel slots, labels, and movement.

const SKIP = isTimeConsumingTestSkipped()

describe.skipIf(SKIP)('wheel simulator', () => {
	test('integrates slot movement and names with wheel manager', async () => {
		const handler = new IndiClientHandlerSet()
		const manager = new WheelManager()
		handler.add(manager)

		using client = new ClientSimulator('wheel', handler)
		using simulator = new WheelSimulator('Wheel Simulator', client)
		const wheel = manager.get(client, simulator.name)!

		manager.connect(wheel)
		await waitUntil(() => wheel.connected)

		expect(manager.properties.length).toBe(1)
		expect(wheel.count).toBe(8)
		expect(wheel.position).toBe(0)
		expect(wheel.names).toEqual(['L', 'R', 'G', 'B', 'Ha', 'SII', 'OIII', 'Dark'])
		expect(wheel.canSetNames).toBeTrue()

		manager.moveTo(wheel, 3)
		await waitUntil(() => wheel.moving)
		await waitUntil(() => !wheel.moving, 3000)
		expect(wheel.position).toBe(3)

		manager.slots(wheel, ['Lum', 'Red', 'Green', 'Blue', 'OIII'])
		await waitUntil(() => wheel.names[4] === 'OIII')
		expect(wheel.names).toEqual(['Lum', 'Red', 'Green', 'Blue', 'OIII', 'SII', 'OIII', 'Dark'])

		simulator.dispose()
		expect(manager.has(client, wheel.name)).toBeFalse()
		expect(manager.properties.length).toBe(0)
	}, 3000)
})
