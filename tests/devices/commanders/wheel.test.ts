import { afterAll, afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { WheelCommander } from '../../../src/devices/commanders/wheel'
import { IndiClientHandlerSet } from '../../../src/devices/indi/client'
import type { Wheel } from '../../../src/devices/indi/device'
import { WheelManager } from '../../../src/devices/indi/manager/wheel'
import { ClientSimulator } from '../../../src/devices/indi/simulator/client'
import { WheelSimulator } from '../../../src/devices/indi/simulator/wheel'
import { DeviceLifecycle } from '../../../src/devices/orchestration/device.lifecycle'
import { OperationCoordinator, failedOperationResult } from '../../../src/devices/orchestration/operation'
import { ResourceArbiter, resourceKey } from '../../../src/devices/orchestration/resource'
import { waitUntil } from '../../util'

const DEFAULT_NAMES = ['L', 'R', 'G', 'B', 'Ha', 'SII', 'OIII', 'Dark']
const wheelManager = new WheelManager()
const resourceArbiter = new ResourceArbiter()
const operationCoordinator = new OperationCoordinator(resourceArbiter)
const wheelCommander = new WheelCommander(wheelManager)
const deviceLifecycle = new DeviceLifecycle(resourceArbiter, operationCoordinator)
deviceLifecycle.observe(wheelManager)
const handler = new IndiClientHandlerSet([wheelManager])
const client = new ClientSimulator('Client Simulator', handler)
const simulator = new WheelSimulator('Wheel Simulator', client)

afterAll(() => {
	deviceLifecycle.dispose()
	simulator.dispose()
})

beforeEach(async () => {
	const wheel = getWheel()
	wheelManager.disconnect(wheel)
	await waitUntil(() => !wheel.connected)
})

afterEach(async () => {
	const wheel = getWheel()
	await operationCoordinator.cancelAll()
	wheelManager.disconnect(wheel)
	await waitUntil(() => !wheel.connected)
})

function getWheel() {
	const device = wheelManager.get(client, simulator.name)
	expect(device).toBeDefined()
	return device!
}

function isFree(wheel: Wheel) {
	return resourceArbiter.availability(resourceKey(wheel)) === 'available'
}

async function connected() {
	const wheel = getWheel()
	await waitUntil(() => !wheel.connected)
	wheelManager.connect(wheel)

	await waitUntil(() => wheel.connected && wheel.count === DEFAULT_NAMES.length && wheel.canSetNames)

	if (wheel.position !== 0) {
		wheelManager.moveTo(wheel, 0)
		await waitUntil(() => wheel.position === 0 && !wheel.moving, 5000)
	}

	if (wheel.names.join('\0') !== DEFAULT_NAMES.join('\0')) {
		wheelManager.slots(wheel, DEFAULT_NAMES)
		await waitUntil(() => wheel.names.join('\0') === DEFAULT_NAMES.join('\0'))
	}

	return wheel
}

test('moves to a zero-based slot and waits for the wheel to stop', async () => {
	const wheel = await connected()

	expect(await wheelCommander.moveTo(operationCoordinator, wheel, 3, { timeout: 2000 })).toMatchObject({ ok: true })
	expect(wheel.position).toBe(3)
	expect(wheel.moving).toBeFalse()
	await waitUntil(() => isFree(wheel))
})

test('resolves immediately when the wheel already holds the requested slot', async () => {
	const wheel = await connected()
	const moveTo = spyOn(wheelManager, 'moveTo')

	try {
		expect(await wheelCommander.moveTo(operationCoordinator, wheel, 0, { timeout: 50 })).toMatchObject({ ok: true })
		expect(moveTo).toHaveBeenCalledWith(wheel, 0)
	} finally {
		moveTo.mockRestore()
	}
})

test('rounds and clips slots before dispatching zero-based targets', async () => {
	const wheel = await connected()
	const moveTo = spyOn(wheelManager, 'moveTo').mockImplementation((_wheel, target) => {
		wheel.position = target
		wheel.moving = false
	})

	try {
		expect(await wheelCommander.moveTo(operationCoordinator, wheel, 100.8, { timeout: 50 })).toMatchObject({ ok: true })
		expect(moveTo).toHaveBeenCalledWith(wheel, wheel.count - 1)
		expect(wheel.position).toBe(wheel.count - 1)
	} finally {
		moveTo.mockRestore()
	}
})

test('renames slots and rejects renaming without the capability', async () => {
	const wheel = await connected()
	const names = ['Luminance', 'Red', 'Green', 'Blue']

	expect(await wheelCommander.setNames(operationCoordinator, wheel, names)).toMatchObject({ ok: true })
	await waitUntil(() => wheel.names.slice(0, names.length).join('\0') === names.join('\0'))
	expect(wheel.names.slice(0, names.length)).toEqual(names)

	const slots = spyOn(wheelManager, 'slots').mockImplementation(() => {})
	try {
		wheel.canSetNames = false
		expect(await wheelCommander.setNames(operationCoordinator, wheel, DEFAULT_NAMES)).toMatchObject(failedOperationResult('unexpectedState'))
		expect(slots).not.toHaveBeenCalled()
	} finally {
		wheel.canSetNames = true
		slots.mockRestore()
	}
})

test('keeps a canceled wheel move leased until the physical move finishes', async () => {
	const wheel = await connected()
	const moving = wheelCommander.moveTo(operationCoordinator, wheel, wheel.count - 1, { timeout: 3000 })

	await waitUntil(() => wheel.moving)
	const canceling = operationCoordinator.cancelByResource(resourceKey(wheel))
	await Bun.sleep(50)
	expect(isFree(wheel)).toBeFalse()
	await canceling

	expect(await moving).toMatchObject(failedOperationResult('aborted'))
	expect(wheel.position).toBe(wheel.count - 1)
	expect(wheel.moving).toBeFalse()
	await waitUntil(() => isFree(wheel))
})

test('reports a wheel Alert without leaving a cleanup wait behind', async () => {
	const wheel = await connected()
	const moveTo = spyOn(wheelManager, 'moveTo').mockImplementation((_wheel, target) => {
		wheel.position = target
		wheel.moving = false
		wheelCommander.updated(wheel, 'position', 'Alert')
	})

	try {
		expect(await wheelCommander.moveTo(operationCoordinator, wheel, 4, { timeout: 50 })).toMatchObject(failedOperationResult('alert'))
		expect(moveTo).toHaveBeenCalledTimes(1)
		expect(isFree(wheel)).toBeTrue()
	} finally {
		moveTo.mockRestore()
	}
})

test('reports a disconnected wheel before dispatching a command', async () => {
	const wheel = getWheel()
	wheelManager.connect(wheel)
	await waitUntil(() => wheel.connected)
	wheelManager.disconnect(wheel)
	await waitUntil(() => !wheel.connected)

	const isolatedArbiter = new ResourceArbiter()
	wheel.connected = true
	isolatedArbiter.markAvailable({ key: resourceKey(wheel), device: wheel })
	wheel.connected = false
	isolatedArbiter.markAvailable(resourceKey(wheel))
	const isolatedCoordinator = new OperationCoordinator(isolatedArbiter)
	const moveTo = spyOn(wheelManager, 'moveTo').mockImplementation(() => {})

	try {
		expect(await wheelCommander.moveTo(isolatedCoordinator, wheel, 1)).toMatchObject(failedOperationResult('disconnected'))
		expect(moveTo).not.toHaveBeenCalled()
	} finally {
		moveTo.mockRestore()
	}
})

test('refuses a second wheel command while the first one owns the device', async () => {
	const wheel = await connected()
	const moving = wheelCommander.moveTo(operationCoordinator, wheel, wheel.count - 1, { timeout: 3000 })

	await waitUntil(() => wheel.moving)
	expect(await wheelCommander.setNames(operationCoordinator, wheel, DEFAULT_NAMES)).toMatchObject(failedOperationResult('busy'))

	await operationCoordinator.cancelByResource(resourceKey(wheel))
	await moving
})

test('stops observing the manager once disposed', () => {
	const device = getWheel()
	const commander = new WheelCommander(wheelManager)
	const updated = spyOn(commander, 'updated')

	wheelManager.updated(device, 'name')
	expect(updated).toHaveBeenCalledTimes(1)

	commander.dispose()
	commander.dispose()
	wheelManager.updated(device, 'name')
	expect(updated).toHaveBeenCalledTimes(1)

	const removeHandler = spyOn(wheelManager, 'removeHandler')

	try {
		let scoped: WheelCommander | undefined

		{
			using commander = new WheelCommander(wheelManager)
			scoped = commander
		}

		expect(removeHandler).toHaveBeenCalledWith(scoped)
	} finally {
		removeHandler.mockRestore()
	}
})
