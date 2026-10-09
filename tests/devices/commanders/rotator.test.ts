import { afterAll, afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { RotatorCommander, rotatorAngle } from '../../../src/devices/commanders/rotator'
import { IndiClientHandlerSet } from '../../../src/devices/indi/client'
import type { Rotator } from '../../../src/devices/indi/device'
import { RotatorManager } from '../../../src/devices/indi/manager/rotator'
import { ClientSimulator } from '../../../src/devices/indi/simulator/client'
import { RotatorSimulator } from '../../../src/devices/indi/simulator/rotator'
import type { PropertyState } from '../../../src/devices/indi/types'
import { DeviceLifecycle } from '../../../src/devices/orchestration/device.lifecycle'
import { OperationCoordinator, failedOperationResult, successfulOperationResult } from '../../../src/devices/orchestration/operation'
import { ResourceArbiter, resourceKey } from '../../../src/devices/orchestration/resource'
import { waitUntil } from '../../util'

const rotatorManager = new RotatorManager()
const resourceArbiter = new ResourceArbiter()
const operationCoordinator = new OperationCoordinator(resourceArbiter)
const rotatorCommander = new RotatorCommander(rotatorManager)
const deviceLifecycle = new DeviceLifecycle(resourceArbiter, operationCoordinator)
deviceLifecycle.observe(rotatorManager)
const handler = new IndiClientHandlerSet([rotatorManager])
const client = new ClientSimulator('Client Simulator', handler)
const simulator = new RotatorSimulator('Rotator Simulator', client)

afterAll(() => {
	deviceLifecycle.dispose()
	simulator.dispose()
})

beforeEach(() => {
	rotatorManager.disconnect(getRotator())
})

afterEach(async () => {
	await operationCoordinator.cancelAll()
	rotatorManager.disconnect(getRotator())
})

function getRotator() {
	const device = rotatorManager.get(client, simulator.name)
	expect(device).toBeDefined()
	return device!
}

function isFree(rotator: Rotator) {
	return resourceArbiter.availability(resourceKey(rotator)) === 'available'
}

async function connected() {
	const rotator = getRotator()
	rotatorManager.connect(rotator)
	await waitUntil(() => rotator.connected && rotator.canAbort && rotator.canHome && rotator.canSync && rotator.canReverse)
	rotatorManager.syncTo(rotator, 0)
	await waitUntil(() => rotator.angle.value === 0 && !rotator.moving)
	if (rotator.reversed) {
		rotatorManager.reverse(rotator, false)
		await waitUntil(() => !rotator.reversed)
	}
	return rotator
}

async function stop(rotator: Rotator) {
	await operationCoordinator.cancelByResource(resourceKey(rotator))
	return await rotatorCommander.stopMotion(rotator, { settleTimeout: 500 })
}

test('moves to an angle and resolves after the rotator stops there', async () => {
	const rotator = await connected()

	expect(await rotatorCommander.moveTo(operationCoordinator, rotator, 42.5, { timeout: 2000 })).toMatchObject({ ok: true })
	expect(rotator.angle.value).toBeCloseTo(42.5, 2)
	expect(rotator.moving).toBeFalse()
	await waitUntil(() => isFree(rotator))
})

test('resolves without commanding when the rotator already holds the requested angle', async () => {
	const rotator = await connected()
	const moveTo = spyOn(rotatorManager, 'moveTo')

	try {
		expect(await rotatorCommander.moveTo(operationCoordinator, rotator, 0, { timeout: 50 })).toMatchObject({ ok: true })
		expect(moveTo).not.toHaveBeenCalled()
	} finally {
		moveTo.mockRestore()
	}
})

// Feeds one angle vector through the manager, as the driver would publish it.
function angleVector(rotator: Rotator, state: PropertyState, angle: number) {
	rotatorManager.numberVector(client, { device: rotator.name, name: 'ABS_ROTATOR_ANGLE', state, elements: { ANGLE: { name: 'ANGLE', value: angle } } }, 'setNumberVector')
}

test('accepts a rotation that stops at the step nearest the commanded angle', async () => {
	const rotator = await connected()
	const timers: Timer[] = []
	// A driver with 0.01° resolution stops at 123.46° for 123.456°.
	const moveTo = spyOn(rotatorManager, 'moveTo').mockImplementation(() => {
		angleVector(rotator, 'Busy', rotator.angle.value)
		timers.push(setTimeout(() => angleVector(rotator, 'Ok', 123.46), 50))
	})
	const stop = spyOn(rotatorManager, 'stop')

	try {
		expect(await rotatorCommander.moveTo(operationCoordinator, rotator, 123.456, { timeout: 2000 })).toEqual(successfulOperationResult(undefined))
		// A successful rotation sends no abort afterwards.
		expect(stop).not.toHaveBeenCalled()
	} finally {
		for (const timer of timers) clearTimeout(timer)
		stop.mockRestore()
		moveTo.mockRestore()
	}
})

test('fails a rotation that stops far from the commanded angle', async () => {
	const rotator = await connected()
	const timers: Timer[] = []
	const moveTo = spyOn(rotatorManager, 'moveTo').mockImplementation(() => {
		angleVector(rotator, 'Busy', rotator.angle.value)
		timers.push(setTimeout(() => angleVector(rotator, 'Ok', 30), 50))
	})

	try {
		expect(await rotatorCommander.moveTo(operationCoordinator, rotator, 90, { timeout: 2000 })).toMatchObject(failedOperationResult('unexpectedState'))
	} finally {
		for (const timer of timers) clearTimeout(timer)
		moveTo.mockRestore()
	}
})

test('fails a rotation the driver refuses without ever reporting it busy', async () => {
	const rotator = await connected()
	const moveTo = spyOn(rotatorManager, 'moveTo').mockImplementation(() => angleVector(rotator, 'Alert', rotator.angle.value))

	try {
		const started = performance.now()
		expect(await rotatorCommander.moveTo(operationCoordinator, rotator, 90, { timeout: 5000 })).toMatchObject(failedOperationResult('alert'))
		expect(performance.now() - started).toBeLessThan(1000)
	} finally {
		moveTo.mockRestore()
	}
})

test('wraps an angle outside the rotator range before dispatching it', async () => {
	const rotator = await connected()
	const moveTo = spyOn(rotatorManager, 'moveTo').mockImplementation(() => {})

	try {
		expect(await rotatorCommander.moveTo(operationCoordinator, rotator, 500, { timeout: 20, settleTimeout: 20 })).toMatchObject(failedOperationResult('timeout'))
		expect(moveTo).toHaveBeenCalledWith(rotator, 140)
		await waitUntil(() => isFree(rotator))
	} finally {
		moveTo.mockRestore()
	}
})

test('resolves an angle to the equivalent one the driver publishes', () => {
	const signed = { angle: { value: 0, min: -180, max: 180 } } as unknown as Rotator
	const unsigned = { angle: { value: 0, min: 0, max: 360 } } as unknown as Rotator
	const limited = { angle: { value: 0, min: 0, max: 180 } } as unknown as Rotator

	expect(rotatorAngle(signed, 350)).toBe(-10)
	expect(rotatorAngle(signed, 45)).toBe(45)
	expect(rotatorAngle(signed, -190)).toBe(170)
	expect(rotatorAngle(unsigned, -10)).toBe(350)
	expect(rotatorAngle(unsigned, 400)).toBe(40)
	expect(rotatorAngle(limited, 270)).toBe(180)
})

test('answers an unreachable direction with the limit fewest degrees away from it', () => {
	const shifted = { angle: { value: 0, min: 10, max: 350 } } as unknown as Rotator
	const narrow = { angle: { value: 0, min: 90, max: 200 } } as unknown as Rotator

	expect(rotatorAngle(shifted, -5)).toBe(350)
	expect(rotatorAngle(shifted, 355)).toBe(350)
	expect(rotatorAngle(shifted, 1)).toBe(10)
	expect(rotatorAngle(shifted, 361)).toBe(10)
	expect(rotatorAngle(narrow, 210)).toBe(200)
	expect(rotatorAngle(narrow, 80)).toBe(90)
	expect(rotatorAngle(narrow, -300)).toBe(90)
	expect(rotatorAngle(narrow, 305)).toBe(200)
})

test('homes after observing the homing motion and supports synchronization and reversal', async () => {
	const rotator = await connected()

	expect(await rotatorCommander.syncTo(operationCoordinator, rotator, 90)).toMatchObject({ ok: true })
	await waitUntil(() => rotator.angle.value === 90)

	expect(await rotatorCommander.reverse(operationCoordinator, rotator, true)).toMatchObject({ ok: true })
	await waitUntil(() => rotator.reversed)

	expect(await rotatorCommander.home(operationCoordinator, rotator, { timeout: 2000 })).toMatchObject({ ok: true })
	expect(rotator.moving).toBeFalse()
	expect(rotator.angle.value).toBeCloseTo(0, 2)

	expect(await rotatorCommander.reverse(operationCoordinator, rotator, false)).toMatchObject({ ok: true })
	await waitUntil(() => !rotator.reversed)
})

test('stops a canceled rotation before releasing the rotator', async () => {
	const rotator = await connected()
	const moving = rotatorCommander.moveTo(operationCoordinator, rotator, 180, { timeout: 3000 })

	await waitUntil(() => rotator.moving)
	const stopped = await stop(rotator)

	expect(stopped).toMatchObject({ ok: true })
	expect(await moving).toMatchObject(failedOperationResult('aborted'))
	expect(rotator.moving).toBeFalse()
	await waitUntil(() => isFree(rotator))
})

test('reports an Alert from an interrupted rotation', async () => {
	const rotator = await connected()
	const moving = rotatorCommander.moveTo(operationCoordinator, rotator, 180, { timeout: 3000 })

	await waitUntil(() => rotator.moving)
	simulator.stop()

	expect(await moving).toMatchObject(failedOperationResult('alert'))
	expect(rotator.moving).toBeFalse()
	await waitUntil(() => isFree(rotator))
})

test('times out a rotation that the driver never starts', async () => {
	const rotator = await connected()
	const moveTo = spyOn(rotatorManager, 'moveTo').mockImplementation(() => {})

	try {
		expect(await rotatorCommander.moveTo(operationCoordinator, rotator, 30, { timeout: 20, settleTimeout: 20 })).toMatchObject(failedOperationResult('timeout'))
		expect(moveTo).toHaveBeenCalledTimes(1)
		expect(isFree(rotator)).toBeTrue()
	} finally {
		moveTo.mockRestore()
	}
})

test('rejects unsupported operations and stops directly when disconnected', async () => {
	const rotator = await connected()
	const home = spyOn(rotatorManager, 'home').mockImplementation(() => {})

	try {
		rotator.canHome = false
		expect(await rotatorCommander.home(operationCoordinator, rotator)).toMatchObject(failedOperationResult('unexpectedState'))
		expect(home).not.toHaveBeenCalled()
	} finally {
		home.mockRestore()
		rotator.canHome = true
	}

	rotatorManager.disconnect(rotator)
	await waitUntil(() => !rotator.connected)
	expect(await rotatorCommander.stopMotion(rotator)).toMatchObject(failedOperationResult('disconnected'))
})

test('refuses a second rotator command while the first one owns the device', async () => {
	const rotator = await connected()
	const moving = rotatorCommander.moveTo(operationCoordinator, rotator, 180, { timeout: 3000 })

	await waitUntil(() => rotator.moving)
	expect(await rotatorCommander.reverse(operationCoordinator, rotator, true)).toMatchObject(failedOperationResult('busy'))

	await stop(rotator)
	await moving
})

test('stops observing the manager once disposed', () => {
	const device = getRotator()
	const commander = new RotatorCommander(rotatorManager)
	const updated = spyOn(commander, 'updated')

	rotatorManager.updated(device, 'name')
	expect(updated).toHaveBeenCalledTimes(1)

	commander.dispose()
	commander.dispose()
	rotatorManager.updated(device, 'name')
	expect(updated).toHaveBeenCalledTimes(1)

	const removeHandler = spyOn(rotatorManager, 'removeHandler')

	try {
		let scoped: RotatorCommander | undefined

		{
			using commander = new RotatorCommander(rotatorManager)
			scoped = commander
		}

		expect(removeHandler).toHaveBeenCalledWith(scoped)
	} finally {
		removeHandler.mockRestore()
	}
})
