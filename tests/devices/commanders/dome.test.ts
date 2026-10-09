import { afterAll, afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { DomeCommander } from '../../../src/devices/commanders/dome'
import { IndiClientHandlerSet } from '../../../src/devices/indi/client'
import type { Dome } from '../../../src/devices/indi/device'
import { DomeManager } from '../../../src/devices/indi/manager/dome'
import { ClientSimulator } from '../../../src/devices/indi/simulator/client'
import { DomeSimulator } from '../../../src/devices/indi/simulator/dome'
import type { PropertyState } from '../../../src/devices/indi/types'
import { DeviceLifecycle } from '../../../src/devices/orchestration/device.lifecycle'
import { OperationCoordinator, failedOperationResult, successfulOperationResult } from '../../../src/devices/orchestration/operation'
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

// Feeds one azimuth vector, in degrees, through the manager, as the driver would publish it.
function azimuthVector(dome: Dome, state: PropertyState, azimuth: number) {
	domeManager.numberVector(client, { device: dome.name, name: 'ABS_DOME_POSITION', state, elements: { DOME_ABSOLUTE_POSITION: { name: 'DOME_ABSOLUTE_POSITION', value: azimuth } } }, 'setNumberVector')
}

test('accepts a move that stops at the encoder step nearest the commanded azimuth', async () => {
	const dome = await connected()
	const timers: Timer[] = []
	// A dome with a half-degree encoder stops at 42.5° for 42°.
	const moveTo = spyOn(domeManager, 'moveTo').mockImplementation(() => {
		azimuthVector(dome, 'Busy', 10)
		timers.push(setTimeout(() => azimuthVector(dome, 'Ok', 42.5), 50))
	})
	const stop = spyOn(domeManager, 'stop')

	try {
		expect(await domeCommander.moveTo(operationCoordinator, dome, deg(42), { timeout: 2000 })).toEqual(successfulOperationResult(undefined))
		// A successful move sends no abort afterwards.
		expect(stop).not.toHaveBeenCalled()
	} finally {
		for (const timer of timers) clearTimeout(timer)
		stop.mockRestore()
		moveTo.mockRestore()
	}
})

test('fails a move that stops far from the commanded azimuth', async () => {
	const dome = await connected()
	const timers: Timer[] = []
	const moveTo = spyOn(domeManager, 'moveTo').mockImplementation(() => {
		azimuthVector(dome, 'Busy', 10)
		timers.push(setTimeout(() => azimuthVector(dome, 'Ok', 30), 50))
	})

	try {
		const result = await domeCommander.moveTo(operationCoordinator, dome, deg(90), { timeout: 2000 })
		expect(result).toMatchObject(failedOperationResult('unexpectedState'))
		expect(result.ok ? '' : result.error).toContain('away from the target')
	} finally {
		for (const timer of timers) clearTimeout(timer)
		moveTo.mockRestore()
	}
})

test('fails a move the driver refuses without ever reporting it busy', async () => {
	const dome = await connected()
	const moveTo = spyOn(domeManager, 'moveTo').mockImplementation(() => azimuthVector(dome, 'Alert', (dome.azimuth.value * 180) / Math.PI))

	try {
		const started = performance.now()
		expect(await domeCommander.moveTo(operationCoordinator, dome, deg(90), { timeout: 5000 })).toMatchObject(failedOperationResult('alert'))
		expect(performance.now() - started).toBeLessThan(1000)
	} finally {
		moveTo.mockRestore()
	}
})

test('resolves without commanding a dome already in the requested state', async () => {
	const dome = await connected()

	expect(await domeCommander.home(operationCoordinator, dome, { timeout: 3000 })).toMatchObject({ ok: true })
	expect(dome.atHome).toBeTrue()

	const home = spyOn(domeManager, 'home')
	const moveTo = spyOn(domeManager, 'moveTo')

	try {
		expect(await domeCommander.home(operationCoordinator, dome, { timeout: 50 })).toEqual(successfulOperationResult(undefined))
		expect(await domeCommander.moveTo(operationCoordinator, dome, dome.azimuth.value, { timeout: 50 })).toEqual(successfulOperationResult(undefined))
		expect(home).not.toHaveBeenCalled()
		expect(moveTo).not.toHaveBeenCalled()
		expect(dome.homing).toBeFalse()
	} finally {
		moveTo.mockRestore()
		home.mockRestore()
	}
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

test('starts a new manual motion while the previous one is still stopping', async () => {
	const dome = await connected()
	const first = await domeCommander.startManualMove(operationCoordinator, dome, 'CLOCKWISE', { settleTimeout: 500 })

	expect(first.ok).toBeTrue()
	if (!first.ok) return

	await waitUntil(() => dome.moving)

	const stopping = first.value.stop()
	const second = await domeCommander.startManualMove(operationCoordinator, dome, 'COUNTER_CLOCKWISE', { settleTimeout: 500 })

	expect(await stopping).toMatchObject({ ok: true })
	expect(second.ok).toBeTrue()
	if (!second.ok) return

	expect(second.value.id).not.toBe(first.value.id)
	expect(second.value.direction()).toBe('COUNTER_CLOCKWISE')
	expect(await second.value.stop()).toMatchObject({ ok: true })
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

test('stops observing the manager once disposed', () => {
	const device = getDome()
	const commander = new DomeCommander(domeManager)
	const updated = spyOn(commander, 'updated')

	domeManager.updated(device, 'name')
	expect(updated).toHaveBeenCalledTimes(1)

	commander.dispose()
	commander.dispose()
	domeManager.updated(device, 'name')
	expect(updated).toHaveBeenCalledTimes(1)

	const removeHandler = spyOn(domeManager, 'removeHandler')

	try {
		let scoped: DomeCommander | undefined

		{
			using commander = new DomeCommander(domeManager)
			scoped = commander
		}

		expect(removeHandler).toHaveBeenCalledWith(scoped)
	} finally {
		removeHandler.mockRestore()
	}
})
