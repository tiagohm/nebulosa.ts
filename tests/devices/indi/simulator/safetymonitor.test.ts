import { describe, expect, test } from 'bun:test'
import { IndiClientHandlerSet } from '../../../../src/devices/indi/client'
import { SafetyMonitorManager } from '../../../../src/devices/indi/manager'
import { ClientSimulator } from '../../../../src/devices/indi/simulator/client'
import { SafetyMonitorSimulator } from '../../../../src/devices/indi/simulator/safetymonitor'
import { waitUntil } from '../../../util'

describe('safety-monitor simulator', () => {
	test('publishes fail-closed LightVector states through SafetyMonitorManager', async () => {
		const handler = new IndiClientHandlerSet()
		const manager = new SafetyMonitorManager({ get: () => undefined })
		handler.add(manager)

		using client = new ClientSimulator('safety-monitor', handler)
		using simulator = new SafetyMonitorSimulator('Safety Monitor Simulator', client)

		expect(manager.get(client, simulator.name)).toBeUndefined()
		simulator.connect()
		await waitUntil(() => manager.has(client, simulator.name))

		const safety = manager.get(client, simulator.name)!
		expect(safety.connected).toBeTrue()
		expect(safety.safe).toBeFalse()

		simulator.setSafe(true)
		await waitUntil(() => safety.safe)

		client.sendSwitch({ device: simulator.name, name: 'SIMULATOR_SAFETY', elements: { WARNING: true } })
		await waitUntil(() => !safety.safe)

		const property = manager.properties.get(safety)!.SAFETY_STATUS
		expect(property.type).toBe('LIGHT')
		expect(property.state).toBe('Busy')
		expect(property.elements.SAFETY.value).toBe('Busy')

		simulator.dispose()
		expect(manager.has(client, safety.name)).toBeFalse()
	})
})
