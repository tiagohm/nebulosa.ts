import { afterAll, afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { DomeCommander } from '../../../src/devices/commanders/dome'
import { IndiClientHandlerSet } from '../../../src/devices/indi/client'
import type { Dome } from '../../../src/devices/indi/device'
import { DomeManager } from '../../../src/devices/indi/manager/dome'
import { ClientSimulator } from '../../../src/devices/indi/simulator/client'
import { DomeSimulator } from '../../../src/devices/indi/simulator/dome'
import { DeviceLifecycle } from '../../../src/devices/orchestration/device.lifecycle'
import { OperationCoordinator, failedOperationResult } from '../../../src/devices/orchestration/operation'
import { ResourceArbiter, resourceKey } from '../../../src/devices/orchestration/resource'
import { deg } from '../../../src/math/units/angle'
import { waitUntil } from '../../util'

const domeManager = new DomeManager()
const resourceArbiter = new ResourceArbiter()
const operationCoordinator = new OperationCoordinator(resourceArbiter)
const domeCommander = new DomeCommander(domeManager)
const deviceLifecycle = new DeviceLifecycle(resourceArbiter, operationCoordinator)
deviceLifecycle.observe(domeManager)
const handler = new IndiClientHandlerSet([domeManager])
const client = new ClientSimulator('Client Simulator', handler)
const simulator = new DomeSimulator('Dome Simulator', client)

afterAll(() => {
	deviceLifecycle.dispose()
	simulator.dispose()
})

beforeEach(() => {
	domeManager.disconnect(getDome())
})

afterEach(async () => {
	await operationCoordinator.cancelAll()
	domeManager.disconnect(getDome())
})

function getDome() {
	const device = domeManager.get(client, simulator.name)
	expect(device).toBeDefined()
	return device!
}

function isFree(dome: Dome) {
	return resourceArbiter.availability(resourceKey(dome)) === 'available'
}

async function connected() {
	const dome = getDome()
	domeManager.connect(dome)
	await waitUntil(() => dome.connected && dome.canSetAzimuth && dome.canAbort && dome.canSetShutter)
	domeManager.speed(dome, 12)
	await waitUntil(() => dome.speed.value === 12)
	if (dome.parked) {
		domeManager.unpark(dome)
		await waitUntil(() => !dome.parked && !dome.parking)
	}
	return dome
}

async function stop(dome: Dome) {
	await operationCoordinator.cancelByResource(resourceKey(dome))
	return await domeCommander.stopMotion(dome, { settleTimeout: 500 })
}

test('moves to absolute and relative azimuths and waits for standstill', async () => {
	const dome = await connected()

	expect(await domeCommander.moveTo(operationCoordinator, dome, deg(42), { timeout: 3000 })).toMatchObject({ ok: true })
	expect(dome.azimuth.value).toBeCloseTo(deg(42), 2)
	expect(dome.slewing).toBeFalse()

	expect(await domeCommander.moveBy(operationCoordinator, dome, deg(18), { timeout: 3000 })).toMatchObject({ ok: true })
	expect(dome.azimuth.value).toBeCloseTo(deg(60), 2)
	await waitUntil(() => isFree(dome))
})

test('synchronizes and updates dome configuration through scoped commands', async () => {
	const dome = await connected()

	expect(await domeCommander.setSpeed(operationCoordinator, dome, 20)).toMatchObject({ ok: true })
	await waitUntil(() => dome.speed.value === dome.speed.max)

	expect(await domeCommander.syncTo(operationCoordinator, dome, deg(30))).toMatchObject({ ok: true })
	expect(dome.azimuth.value).toBeCloseTo(deg(30), 8)

	expect(await domeCommander.setBacklashSteps(operationCoordinator, dome, 14)).toMatchObject({ ok: true })
	await waitUntil(() => dome.backlash.value === 14)
	expect(await domeCommander.setBacklash(operationCoordinator, dome, true)).toMatchObject({ ok: true })
	await waitUntil(() => dome.backlashEnabled)

	expect(await domeCommander.setPark(operationCoordinator, dome)).toMatchObject({ ok: true })
	await waitUntil(() => Math.abs(dome.parkPosition.value - dome.azimuth.value) < 1e-9)
})

test('homes, parks, and unparks after the corresponding state transitions', async () => {
	const dome = await connected()

	expect(await domeCommander.home(operationCoordinator, dome, { timeout: 3000 })).toMatchObject({ ok: true })
	expect(dome.atHome).toBeTrue()
	expect(dome.homing).toBeFalse()

	expect(await domeCommander.park(operationCoordinator, dome, { timeout: 4000 })).toMatchObject({ ok: true })
	expect(dome.parked).toBeTrue()
	expect(dome.parking).toBeFalse()

	expect(await domeCommander.unpark(operationCoordinator, dome, { timeout: 1000 })).toMatchObject({ ok: true })
	expect(dome.parked).toBeFalse()
	await waitUntil(() => isFree(dome))
})

test('opens and closes the shutter after the terminal shutter state', async () => {
	const dome = await connected()

	expect(await domeCommander.openShutter(operationCoordinator, dome, { timeout: 3000 })).toMatchObject({ ok: true })
	expect(dome.shutterState).toBe('OPEN')

	expect(await domeCommander.closeShutter(operationCoordinator, dome, { timeout: 3000 })).toMatchObject({ ok: true })
	expect(dome.shutterState).toBe('CLOSED')
	await waitUntil(() => isFree(dome))
})

test('keeps a manual motion leased until it is stopped', async () => {
	const dome = await connected()
	const started = await domeCommander.startManualMove(operationCoordinator, dome, 'CLOCKWISE', { settleTimeout: 500 })

	expect(started.ok).toBeTrue()
	if (!started.ok) return

	expect(started.value.direction()).toBe('CLOCKWISE')
	await waitUntil(() => dome.moving)
	expect(await domeCommander.syncTo(operationCoordinator, dome, deg(20))).toMatchObject(failedOperationResult('busy'))

	expect(await started.value.stop()).toMatchObject({ ok: true })
	expect(dome.moving).toBeFalse()
	expect(domeCommander.manualMoveOf(dome)).toBeUndefined()
	await waitUntil(() => isFree(dome))
})

test('stops a canceled movement before releasing the dome', async () => {
	const dome = await connected()
	const moving = domeCommander.moveTo(operationCoordinator, dome, deg(90), { timeout: 5000 })

	await waitUntil(() => dome.moving)
	expect(await stop(dome)).toMatchObject({ ok: true })
	expect(await moving).toMatchObject(failedOperationResult('aborted'))
	expect(dome.moving).toBeFalse()
	await waitUntil(() => isFree(dome))
})

test('reports unsupported commands and a disconnected emergency stop', async () => {
	const dome = await connected()
	const moveTo = spyOn(domeManager, 'moveTo').mockImplementation(() => {})

	try {
		dome.canSetAzimuth = false
		expect(await domeCommander.moveTo(operationCoordinator, dome, deg(20))).toMatchObject(failedOperationResult('unexpectedState'))
		expect(moveTo).not.toHaveBeenCalled()
	} finally {
		dome.canSetAzimuth = true
		moveTo.mockRestore()
	}

	domeManager.disconnect(dome)
	await waitUntil(() => !dome.connected)
	expect(await domeCommander.stopMotion(dome)).toMatchObject(failedOperationResult('disconnected'))
})
