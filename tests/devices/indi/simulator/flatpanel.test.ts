import { describe, expect, test } from 'bun:test'
import { IndiClientHandlerSet } from '../../../../src/devices/indi/client'
import { FlatPanelManager } from '../../../../src/devices/indi/manager'
import { ClientSimulator } from '../../../../src/devices/indi/simulator/client'
import { FlatPanelSimulator } from '../../../../src/devices/indi/simulator/flatpanel'
import { isTimeConsumingTestSkipped, waitUntil } from '../../../util'

// Integration coverage for simulated flat-panel power and intensity.

const SKIP = isTimeConsumingTestSkipped()

describe.skipIf(SKIP)('flat-panel simulator', () => {
	test('integrates light and intensity controls with flat-panel manager', async () => {
		const handler = new IndiClientHandlerSet()
		const manager = new FlatPanelManager()
		handler.add(manager)

		using client = new ClientSimulator('flat-panel', handler)
		using simulator = new FlatPanelSimulator('Light Box Simulator', client)
		const panel = manager.get(client, simulator.name)!

		manager.connect(panel)
		await waitUntil(() => panel.connected)

		expect(manager.properties.length).toBe(1)
		expect(panel.enabled).toBeFalse()
		expect(panel.intensity.max).toBe(255)
		manager.enable(panel)
		await waitUntil(() => panel.enabled)
		manager.intensity(panel, 99)
		await waitUntil(() => panel.intensity.value === 99)
		manager.disable(panel)
		await waitUntil(() => !panel.enabled)

		simulator.dispose()
		expect(manager.has(client, panel.name)).toBeFalse()
		expect(manager.properties.length).toBe(0)
	}, 2000)
})
