import { afterAll, afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { FlatPanelCommander } from '../../../src/devices/commanders/flatpanel'
import { IndiClientHandlerSet } from '../../../src/devices/indi/client'
import type { FlatPanel } from '../../../src/devices/indi/device'
import { FlatPanelManager } from '../../../src/devices/indi/manager/flatpanel'
import { ClientSimulator } from '../../../src/devices/indi/simulator/client'
import { FlatPanelSimulator } from '../../../src/devices/indi/simulator/flatpanel'
import { DeviceLifecycle } from '../../../src/devices/orchestration/device.lifecycle'
import { OperationCoordinator, failedOperationResult } from '../../../src/devices/orchestration/operation'
import { ResourceArbiter, resourceKey } from '../../../src/devices/orchestration/resource'
import { waitUntil } from '../../util'

const flatPanelManager = new FlatPanelManager()
const resourceArbiter = new ResourceArbiter()
const operationCoordinator = new OperationCoordinator(resourceArbiter)
const flatPanelCommander = new FlatPanelCommander(flatPanelManager)
const deviceLifecycle = new DeviceLifecycle(resourceArbiter, operationCoordinator)
deviceLifecycle.observe(flatPanelManager)
const handler = new IndiClientHandlerSet([flatPanelManager])
const client = new ClientSimulator('Client Simulator', handler)
const simulator = new FlatPanelSimulator('Flat Panel Simulator', client)

afterAll(() => {
	deviceLifecycle.dispose()
	simulator.dispose()
})

beforeEach(() => {
	flatPanelManager.disconnect(getPanel())
})

afterEach(async () => {
	await operationCoordinator.cancelAll()
	flatPanelManager.disconnect(getPanel())
})

function getPanel() {
	const device = flatPanelManager.get(client, simulator.name)
	expect(device).toBeDefined()
	return device!
}

function isFree(panel: FlatPanel) {
	return resourceArbiter.availability(resourceKey(panel)) === 'available'
}

async function connected() {
	const panel = getPanel()
	flatPanelManager.connect(panel)
	await waitUntil(() => panel.connected)
	if (panel.enabled) {
		flatPanelManager.disable(panel)
		await waitUntil(() => !panel.enabled)
	}
	return panel
}

test('enables, disables, toggles, and clamps panel intensity', async () => {
	const panel = await connected()

	expect(await flatPanelCommander.enable(operationCoordinator, panel)).toMatchObject({ ok: true })
	await waitUntil(() => panel.enabled)

	expect(await flatPanelCommander.toggle(operationCoordinator, panel)).toMatchObject({ ok: true })
	await waitUntil(() => !panel.enabled)

	expect(await flatPanelCommander.toggle(operationCoordinator, panel)).toMatchObject({ ok: true })
	await waitUntil(() => panel.enabled)

	expect(await flatPanelCommander.intensity(operationCoordinator, panel, panel.intensity.max + 100)).toMatchObject({ ok: true })
	await waitUntil(() => panel.intensity.value === panel.intensity.max)

	expect(await flatPanelCommander.disable(operationCoordinator, panel)).toMatchObject({ ok: true })
	await waitUntil(() => !panel.enabled)
})

test('dispatches the clamped intensity value and resolves once it is reported', async () => {
	const panel = await connected()
	const intensity = spyOn(flatPanelManager, 'intensity')

	try {
		expect(await flatPanelCommander.intensity(operationCoordinator, panel, -1)).toMatchObject({ ok: true })
		expect(panel.intensity.value).toBe(panel.intensity.min)
		expect(await flatPanelCommander.intensity(operationCoordinator, panel, 12)).toMatchObject({ ok: true })
		expect(panel.intensity.value).toBe(12)
		expect(intensity).toHaveBeenNthCalledWith(1, panel, panel.intensity.min)
		expect(intensity).toHaveBeenNthCalledWith(2, panel, 12)
	} finally {
		intensity.mockRestore()
	}
})

test('resolves a light command only after the driver reports the state', async () => {
	const panel = await connected()
	const enable = spyOn(flatPanelManager, 'enable').mockImplementation(() => {})

	try {
		let settled = false
		const command = flatPanelCommander.enable(operationCoordinator, panel).then((result) => {
			settled = true
			return result
		})

		await Bun.sleep(30)
		expect(settled).toBeFalse()
		enable.mockRestore()
		flatPanelManager.enable(panel)
		expect(await command).toMatchObject({ ok: true })
		expect(panel.enabled).toBeTrue()
	} finally {
		enable.mockRestore()
	}
})

test('resolves at once when the panel already reports the commanded state', async () => {
	const panel = await connected()
	const disable = spyOn(flatPanelManager, 'disable').mockImplementation(() => {})

	try {
		expect(await flatPanelCommander.disable(operationCoordinator, panel, { timeout: 50 })).toMatchObject({ ok: true })
		expect(disable).toHaveBeenCalledTimes(1)
	} finally {
		disable.mockRestore()
	}
})

test('accepts an intensity quantized within half of the published step', async () => {
	const panel = await connected()
	const intensity = spyOn(flatPanelManager, 'intensity').mockImplementation((device, value) => {
		flatPanelManager.numberVector(client, { device: device.name, name: 'FLAT_LIGHT_INTENSITY', state: 'Ok', elements: { FLAT_LIGHT_INTENSITY_VALUE: { name: 'FLAT_LIGHT_INTENSITY_VALUE', value: Math.round(value) } } }, 'setNumberVector')
	})

	try {
		expect(panel.intensity.step).toBe(1)
		expect(await flatPanelCommander.intensity(operationCoordinator, panel, 20.4, { timeout: 50 })).toMatchObject({ ok: true })
		expect(panel.intensity.value).toBe(20)
	} finally {
		intensity.mockRestore()
	}
})

test('times out when the driver never reports the commanded state', async () => {
	const panel = await connected()
	const intensity = spyOn(flatPanelManager, 'intensity').mockImplementation(() => {})

	try {
		expect(await flatPanelCommander.intensity(operationCoordinator, panel, panel.intensity.value + 10, { timeout: 30 })).toMatchObject(failedOperationResult('timeout'))
		expect(isFree(panel)).toBeTrue()
	} finally {
		intensity.mockRestore()
	}
})

test('fails a command the driver answers with an Alert', async () => {
	const panel = await connected()
	const enable = spyOn(flatPanelManager, 'enable').mockImplementation((device) => {
		flatPanelManager.switchVector(client, { device: device.name, name: 'FLAT_LIGHT_CONTROL', state: 'Alert', elements: { FLAT_LIGHT_ON: { name: 'FLAT_LIGHT_ON', value: false }, FLAT_LIGHT_OFF: { name: 'FLAT_LIGHT_OFF', value: true } } }, 'setSwitchVector')
	})
	const intensity = spyOn(flatPanelManager, 'intensity').mockImplementation((device) => {
		flatPanelManager.numberVector(client, { device: device.name, name: 'FLAT_LIGHT_INTENSITY', state: 'Alert', elements: { FLAT_LIGHT_INTENSITY_VALUE: { name: 'FLAT_LIGHT_INTENSITY_VALUE', value: device.intensity.value } } }, 'setNumberVector')
	})

	try {
		expect(await flatPanelCommander.enable(operationCoordinator, panel, { timeout: 1000 })).toMatchObject(failedOperationResult('alert'))
		expect(await flatPanelCommander.intensity(operationCoordinator, panel, panel.intensity.value + 10, { timeout: 1000 })).toMatchObject(failedOperationResult('alert'))
	} finally {
		enable.mockRestore()
		intensity.mockRestore()
	}
})

test('fails a pending command when the panel disconnects', async () => {
	const panel = await connected()
	const enable = spyOn(flatPanelManager, 'enable').mockImplementation(() => {})

	try {
		const command = flatPanelCommander.enable(operationCoordinator, panel, { timeout: 1000 })
		await Bun.sleep(10)
		flatPanelManager.disconnect(panel)
		expect((await command).ok).toBeFalse()
	} finally {
		enable.mockRestore()
	}
})

test('reports a disconnected panel before dispatching a mutation', async () => {
	const panel = getPanel()
	flatPanelManager.connect(panel)
	await waitUntil(() => panel.connected)
	flatPanelManager.disconnect(panel)
	await waitUntil(() => !panel.connected)
	const enable = spyOn(flatPanelManager, 'enable').mockImplementation(() => {})

	try {
		const isolatedArbiter = new ResourceArbiter()
		panel.connected = true
		isolatedArbiter.markAvailable({ key: resourceKey(panel), device: panel })
		panel.connected = false
		isolatedArbiter.markAvailable(resourceKey(panel))
		const isolatedCoordinator = new OperationCoordinator(isolatedArbiter)
		expect(await flatPanelCommander.enable(isolatedCoordinator, panel)).toMatchObject(failedOperationResult('disconnected'))
		expect(enable).not.toHaveBeenCalled()
	} finally {
		enable.mockRestore()
	}
})

test('refuses a panel mutation while another operation owns the panel', async () => {
	const panel = await connected()
	const held = operationCoordinator.start<void>(
		'hold',
		[{ key: resourceKey(panel), device: panel }],
		(context) =>
			new Promise((resolve) => {
				context.signal.addEventListener('abort', () => resolve(failedOperationResult('aborted')), { once: true })
			}),
	)

	expect(await flatPanelCommander.disable(operationCoordinator, panel)).toMatchObject(failedOperationResult('busy'))
	await held.cancel()
	expect(isFree(panel)).toBeTrue()
})
