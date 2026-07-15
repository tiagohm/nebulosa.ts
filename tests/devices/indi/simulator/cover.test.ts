import { describe, expect, test } from 'bun:test'
import { IndiClientHandlerSet } from '../../../../src/devices/indi/client'
import { CoverManager } from '../../../../src/devices/indi/manager'
import { ClientSimulator } from '../../../../src/devices/indi/simulator/client'
import { CoverSimulator } from '../../../../src/devices/indi/simulator/cover'
import { isTimeConsumingTestSkipped, waitUntil } from '../../../util'

// Integration coverage for simulated telescope-cover park and abort capabilities.

const SKIP = isTimeConsumingTestSkipped()

describe.skipIf(SKIP)('cover simulator', () => {
	test('integrates park and unpark controls with cover manager', async () => {
		const handler = new IndiClientHandlerSet()
		const manager = new CoverManager()
		handler.add(manager)

		using client = new ClientSimulator('cover', handler)
		using simulator = new CoverSimulator('Dust Cap Simulator', client)
		const cover = manager.get(client, simulator.name)!

		manager.connect(cover)
		await waitUntil(() => cover.connected)

		expect(manager.properties.length).toBe(1)
		expect(cover.canPark).toBeTrue()
		expect(cover.canAbort).toBeTrue()
		expect(cover.parked).toBeFalse()

		manager.park(cover)
		await waitUntil(() => cover.parking)
		await waitUntil(() => cover.parked, 3000)
		manager.unpark(cover)
		await waitUntil(() => cover.parking)
		await waitUntil(() => !cover.parked, 3000)

		simulator.dispose()
		expect(manager.has(client, cover.name)).toBeFalse()
		expect(manager.properties.length).toBe(0)
	}, 3000)
})
