import { afterAll, afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { FocuserCommander } from '../../../src/devices/commanders/focuser'
import { IndiClientHandlerSet } from '../../../src/devices/indi/client'
import type { Focuser } from '../../../src/devices/indi/device'
import { FocuserManager } from '../../../src/devices/indi/manager/focuser'
import { ClientSimulator } from '../../../src/devices/indi/simulator/client'
import { FocuserSimulator } from '../../../src/devices/indi/simulator/focuser'
import { DeviceLifecycle } from '../../../src/devices/orchestration/device.lifecycle'
import { OperationCoordinator, failedOperationResult } from '../../../src/devices/orchestration/operation'
import { ResourceArbiter, resourceKey } from '../../../src/devices/orchestration/resource'
import { waitUntil } from '../../util'

const focuserManager = new FocuserManager()
const resourceArbiter = new ResourceArbiter()
const operationCoordinator = new OperationCoordinator(resourceArbiter)
const focuserCommander = new FocuserCommander(focuserManager)
const deviceLifecycle = new DeviceLifecycle(resourceArbiter, operationCoordinator)
deviceLifecycle.observe(focuserManager)
const handler = new IndiClientHandlerSet([focuserManager])
const client = new ClientSimulator('Client Simulator', handler)
const simulator = new FocuserSimulator('Focuser Simulator', client)

afterAll(() => {
	deviceLifecycle.dispose()
	simulator.dispose()
})

beforeEach(() => {
	focuserManager.disconnect(getFocuser())
})

afterEach(async () => {
	await operationCoordinator.cancelAll()
	focuserManager.disconnect(getFocuser())
})

function getFocuser() {
	const device = focuserManager.get(client, 'Focuser Simulator')
	expect(device).toBeDefined()
	return device!
}

function isFree(focuser: Focuser) {
	return resourceArbiter.availability(resourceKey(focuser)) === 'available'
}

async function connected() {
	const device = getFocuser()
	focuserManager.connect(device)

	expect(device.connected).toBeTrue()

	focuserManager.syncTo(device, 50000)

	await waitUntil(() => device.position.value === 50000 && isFree(device))

	return device
}

async function stop(focuser: Focuser) {
	await operationCoordinator.cancelByResource(resourceKey(focuser))
	return await focuserCommander.stopMotion(focuser)
}

test('moves to a position and resolves after the focuser stops there', async () => {
	const device = await connected()
	const target = device.position.value + 500
	const result = await focuserCommander.moveTo(operationCoordinator, device, target)

	expect(result.ok).toBeTrue()
	expect(device.moving).toBeFalse()
	expect(device.position.value).toBe(target)
	await waitUntil(() => isFree(device))
})

test('resolves without waiting when the focuser already stands at the position', async () => {
	const device = await connected()
	const result = await focuserCommander.moveTo(operationCoordinator, device, device.position.value)

	expect(result.ok).toBeTrue()
	expect(device.moving).toBeFalse()
})

test('moves inward and outward by relative steps', async () => {
	const device = await connected()

	expect(await focuserCommander.moveIn(operationCoordinator, device, 500)).toMatchObject({ ok: true })
	expect(device.position.value).toBe(49500)

	expect(await focuserCommander.moveOut(operationCoordinator, device, 1500)).toMatchObject({ ok: true })
	expect(device.position.value).toBe(51000)
})

test('inverts the relative direction while the focuser is reversed', async () => {
	const device = await connected()

	expect(await focuserCommander.reverse(operationCoordinator, device, true)).toMatchObject({ ok: true })

	try {
		expect(await focuserCommander.moveIn(operationCoordinator, device, 500)).toMatchObject({ ok: true })
		expect(device.position.value).toBe(50500)
	} finally {
		await focuserCommander.reverse(operationCoordinator, device, false)
	}
})

test('syncs the reported position and honors capability gates', async () => {
	const device = await connected()
	const capabilities = {
		canSync: device.canSync,
		canReverse: device.canReverse,
		canRelativeMove: device.canRelativeMove,
		canAbsoluteMove: device.canAbsoluteMove,
	}

	try {
		expect(await focuserCommander.syncTo(operationCoordinator, device, 42000)).toMatchObject({ ok: true })
		expect(device.position.value).toBe(42000)

		device.canSync = false
		expect(await focuserCommander.syncTo(operationCoordinator, device, 43000)).toMatchObject(failedOperationResult('unexpectedState'))

		device.canReverse = false
		expect(await focuserCommander.reverse(operationCoordinator, device, true)).toMatchObject(failedOperationResult('unexpectedState'))

		device.canRelativeMove = false
		expect(await focuserCommander.moveIn(operationCoordinator, device, 100)).toMatchObject(failedOperationResult('unexpectedState'))

		device.canAbsoluteMove = false
		expect(await focuserCommander.moveTo(operationCoordinator, device, 43000)).toMatchObject(failedOperationResult('unexpectedState'))
	} finally {
		device.canSync = capabilities.canSync
		device.canReverse = capabilities.canReverse
		device.canRelativeMove = capabilities.canRelativeMove
		device.canAbsoluteMove = capabilities.canAbsoluteMove
	}
})

test('commands only the steps left before the range limit', async () => {
	const device = await connected()

	focuserManager.syncTo(device, device.position.min + 100)

	await waitUntil(() => device.position.value === device.position.min + 100)
	expect(await focuserCommander.moveIn(operationCoordinator, device, 500)).toMatchObject({ ok: true })
	expect(device.position.value).toBe(device.position.min)
})

test('rejects a relative move without a direction to express it', async () => {
	const device = await connected()
	const moveIn = spyOn(focuserManager, 'moveIn')

	try {
		expect(await focuserCommander.moveIn(operationCoordinator, device, 0)).toMatchObject(failedOperationResult('unexpectedState'))
		expect(moveIn).not.toHaveBeenCalled()
	} finally {
		moveIn.mockRestore()
	}
})

test('refuses a move while the focuser is disconnected', async () => {
	const device = getFocuser()
	const moveTo = spyOn(focuserManager, 'moveTo')

	try {
		expect(await focuserCommander.moveTo(operationCoordinator, device, 1000)).toMatchObject(failedOperationResult('busy'))
		expect(await focuserCommander.stopMotion(device)).toMatchObject(failedOperationResult('disconnected'))
		expect(moveTo).not.toHaveBeenCalled()
	} finally {
		moveTo.mockRestore()
	}
})

test('reports a driver Alert and releases the focuser', async () => {
	const device = await connected()
	const moveTo = spyOn(focuserManager, 'moveTo').mockImplementation(() => {
		focuserCommander.updated(device, 'moving', 'Alert')
	})

	try {
		expect(await focuserCommander.moveTo(operationCoordinator, device, 51000)).toMatchObject(failedOperationResult('alert'))
		await waitUntil(() => isFree(device))
	} finally {
		moveTo.mockRestore()
	}
})

test('stops and releases the focuser after a move timeout', async () => {
	const device = await connected()
	const moveTo = spyOn(focuserManager, 'moveTo').mockImplementation(() => {})

	try {
		expect(await focuserCommander.moveTo(operationCoordinator, device, 51000, { timeout: 20, settleTimeout: 20 })).toMatchObject(failedOperationResult('timeout'))
		await waitUntil(() => isFree(device))
	} finally {
		moveTo.mockRestore()
	}
})

test('stopping by device cancels the move and leaves the focuser stopped', async () => {
	const device = await connected()
	const moving = focuserCommander.moveTo(operationCoordinator, device, device.position.max)

	await waitUntil(() => device.moving)

	const stopped = await stop(device)

	expect(stopped).toMatchObject({ ok: true })
	expect(await moving).toMatchObject(failedOperationResult('aborted'))
	expect(device.moving).toBeFalse()
	await waitUntil(() => isFree(device))
})

test('refuses a second command while another operation owns the focuser', async () => {
	const device = await connected()
	const moving = focuserCommander.moveTo(operationCoordinator, device, device.position.max)

	await waitUntil(() => device.moving)
	expect(await focuserCommander.syncTo(operationCoordinator, device, 1000)).toMatchObject(failedOperationResult('busy'))

	await stop(device)
	await moving
})
