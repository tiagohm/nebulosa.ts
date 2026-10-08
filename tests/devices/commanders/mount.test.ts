import { afterAll, afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { MountCommander } from '../../../src/devices/commanders/mount'
import { IndiClientHandlerSet } from '../../../src/devices/indi/client'
import type { Mount, MountTargetCoordinate } from '../../../src/devices/indi/device'
import { MountManager } from '../../../src/devices/indi/manager/mount'
import { ClientSimulator } from '../../../src/devices/indi/simulator/client'
import { MountSimulator } from '../../../src/devices/indi/simulator/mount'
import type { PropertyState, SetSwitchVector } from '../../../src/devices/indi/types'
import { DeviceLifecycle } from '../../../src/devices/orchestration/device.lifecycle'
import { OperationCoordinator, failedOperationResult } from '../../../src/devices/orchestration/operation'
import { ResourceArbiter, resourceKey } from '../../../src/devices/orchestration/resource'
import { hour, deg } from '../../../src/math/units/angle'
import { meter } from '../../../src/math/units/distance'
import { waitUntil } from '../../util'

const mountManager = new MountManager()
const resourceArbiter = new ResourceArbiter()
const operationCoordinator = new OperationCoordinator(resourceArbiter)
const mountCommander = new MountCommander(mountManager)
const deviceLifecycle = new DeviceLifecycle(resourceArbiter, operationCoordinator)
deviceLifecycle.observe(mountManager)
const handler = new IndiClientHandlerSet([mountManager])
const client = new ClientSimulator('Client Simulator', handler)
const simulator = new MountSimulator('Mount Simulator', client)

afterAll(() => {
	deviceLifecycle.dispose()
	simulator.dispose()
})

beforeEach(() => {
	mountManager.disconnect(getMount())
})

afterEach(async () => {
	await operationCoordinator.cancelAll()
	mountManager.disconnect(getMount())
})

function getMount() {
	const device = mountManager.get(client, 'Mount Simulator')
	expect(device).toBeDefined()
	return device!
}

function isFree(mount: Mount) {
	return resourceArbiter.availability(resourceKey(mount)) === 'available'
}

async function stop(mount: Mount) {
	await operationCoordinator.cancelByResource(resourceKey(mount))
	return await mountCommander.stopMotion(mount)
}

function motionVector(mount: Mount, state: PropertyState, moving: boolean) {
	const message: SetSwitchVector = { device: mount.name, name: 'TELESCOPE_MOTION_NS', state, elements: { MOTION_NORTH: { name: 'MOTION_NORTH', value: moving } } }
	mountManager.switchVector(client, message, 'setSwitchVector')
}

function targetCoordinate(): MountTargetCoordinate {
	return { type: 'JNOW', JNOW: { x: '05:00:00', y: '-30:00:00' } }
}

async function connected() {
	const device = getMount()
	mountManager.connect(device)
	expect(device.connected).toBeTrue()
	mountManager.slewRate(device, 'SPEED_7')
	mountManager.syncTo(device, hour(5), deg(-30))
	// The sync is a round trip through the driver, so the reported coordinate only matches the request
	// once its notification has been applied.
	await waitUntil(() => Math.abs(device.equatorialCoordinate.declination - deg(-30)) < deg(0.01))
	return device
}

test('slews to a target and reports where the mount stopped', async () => {
	const device = await connected()
	const result = await mountCommander.goTo(operationCoordinator, device, { type: 'JNOW', JNOW: { x: '05:00:00', y: '-28:00:00' } })

	expect(result.ok).toBeTrue()

	if (result.ok) {
		expect(result.value.rightAscension).toBeCloseTo(hour(5), 3)
		expect(result.value.declination).toBeCloseTo(deg(-28), 3)
	}

	expect(device.slewing).toBeFalse()
	await waitUntil(() => isFree(device))
})

test('completes immediately when the mount already points at the target', async () => {
	const device = await connected()
	const goTo = spyOn(mountManager, 'goTo')

	try {
		const result = await mountCommander.goTo(operationCoordinator, device, { type: 'JNOW', JNOW: { x: '05:00:00', y: '-30:00:00' } })

		expect(result.ok).toBeTrue()
		expect(goTo).not.toHaveBeenCalled()
		expect(device.slewing).toBeFalse()
	} finally {
		goTo.mockRestore()
	}
})

test('stopping by device cancels the slew and leaves the mount stopped', async () => {
	const device = await connected()
	const slewing = mountCommander.goTo(operationCoordinator, device, { type: 'JNOW', JNOW: { x: '05:00:00', y: '30:00:00' } })

	await waitUntil(() => device.slewing)

	const stopped = await stop(device)

	expect(stopped).toMatchObject({ ok: true })
	expect(await slewing).toMatchObject(failedOperationResult('aborted'))
	expect(device.slewing).toBeFalse()
	await waitUntil(() => isFree(device))
})

test('fails a slew that stops short of its target', async () => {
	const device = await connected()
	const slewing = mountCommander.goTo(operationCoordinator, device, { type: 'JNOW', JNOW: { x: '05:00:00', y: '30:00:00' } })

	await waitUntil(() => device.slewing)

	simulator.stop()

	const result = await slewing

	expect(result).toMatchObject(failedOperationResult('unexpectedState'))
	expect(result.ok ? '' : result.error).toContain('short of the target')
	await waitUntil(() => isFree(device))
})

test('reports a driver Alert and releases the mount', async () => {
	const device = await connected()
	const goTo = spyOn(mountManager, 'goTo').mockImplementation(() => {
		mountCommander.updated(device, 'slewing', 'Alert')
	})

	try {
		expect(await mountCommander.goTo(operationCoordinator, device, { type: 'JNOW', JNOW: { x: '05:00:00', y: '-28:00:00' } })).toMatchObject(failedOperationResult('alert'))
		await waitUntil(() => isFree(device))
	} finally {
		goTo.mockRestore()
	}
})

test('refuses a second command while another operation owns the mount', async () => {
	const device = await connected()
	const slewing = mountCommander.goTo(operationCoordinator, device, { type: 'JNOW', JNOW: { x: '05:00:00', y: '30:00:00' } })

	await waitUntil(() => device.slewing)
	expect(await mountCommander.setTracking(operationCoordinator, device, true)).toMatchObject(failedOperationResult('busy'))

	await stop(device)
	await slewing
})

test('holds the mount through a manual move until every axis is stopped', async () => {
	const device = await connected()
	const started = await mountCommander.startManualMove(operationCoordinator, device, 'NORTH')

	expect(started.ok).toBeTrue()

	if (!started.ok) return

	const handle = started.value

	await waitUntil(() => device.slewing)
	expect(handle.directions()).toEqual(['NORTH'])
	expect(await mountCommander.goTo(operationCoordinator, device, targetCoordinate())).toMatchObject(failedOperationResult('busy'))

	const joined = await mountCommander.startManualMove(operationCoordinator, device, 'WEST')

	expect(joined).toMatchObject({ ok: true })
	expect(handle.directions()).toEqual(['NORTH', 'WEST'])
	expect(await handle.move('NORTH', false)).toMatchObject({ ok: true })
	expect(handle.directions()).toEqual(['WEST'])
	expect(device.slewing).toBeTrue()
	expect(await handle.stop()).toMatchObject({ ok: true })
	expect(device.slewing).toBeFalse()
	expect(mountCommander.manualMoveOf(device)).toBeUndefined()
	await waitUntil(() => isFree(device))
})

test('waits for the axis motion vector before releasing a manual move', async () => {
	const device = await connected()
	const started = await mountCommander.startManualMove(operationCoordinator, device, 'NORTH')

	expect(started.ok).toBeTrue()

	if (!started.ok) return

	const handle = started.value
	const moveNorth = spyOn(mountManager, 'moveNorth').mockImplementation(() => {})

	try {
		simulator.stop()

		await waitUntil(() => !device.slewing)

		motionVector(device, 'Busy', true)

		const stopping = handle.stop()

		await Bun.sleep(100)

		expect(isFree(device)).toBeFalse()

		motionVector(device, 'Ok', false)

		expect(await stopping).toMatchObject({ ok: true })
		await waitUntil(() => isFree(device))
	} finally {
		moveNorth.mockRestore()
	}
})

test('blocks acquisition while an axis moves outside any operation', async () => {
	const device = await connected()

	await waitUntil(() => isFree(device))

	motionVector(device, 'Busy', true)

	await waitUntil(() => !isFree(device))
	expect(await mountCommander.setTracking(operationCoordinator, device, true)).toMatchObject(failedOperationResult('busy'))

	motionVector(device, 'Ok', false)

	await waitUntil(() => isFree(device))
})

test('stops a manual move halted in the same tick it was started', async () => {
	const device = await connected()
	const starting = mountCommander.manualMove(operationCoordinator, device, 'NORTH', true)
	const halting = mountCommander.manualMove(operationCoordinator, device, 'NORTH', false)

	expect(await starting).toMatchObject({ ok: true })
	expect(await halting).toMatchObject({ ok: true })
	expect(mountCommander.manualMoveOf(device)).toBeUndefined()
	expect(device.slewing).toBeFalse()
	await waitUntil(() => isFree(device))
})

test('refuses to move through a handle whose motion already ended', async () => {
	const device = await connected()
	const started = await mountCommander.startManualMove(operationCoordinator, device, 'NORTH')

	expect(started.ok).toBeTrue()

	if (!started.ok) return

	const handle = started.value
	const moveSouth = spyOn(mountManager, 'moveSouth')

	try {
		expect(await handle.stop()).toMatchObject({ ok: true })
		expect(await handle.move('SOUTH', true)).toMatchObject(failedOperationResult('aborted'))
		expect(moveSouth).not.toHaveBeenCalled()
		expect(device.slewing).toBeFalse()
		await waitUntil(() => isFree(device))
	} finally {
		moveSouth.mockRestore()
	}
})

test('ends the manual move when the motion command cannot be sent', async () => {
	const device = await connected()
	const moveNorth = spyOn(mountManager, 'moveNorth').mockImplementation(() => {
		throw new Error('transport closed')
	})

	try {
		expect(await mountCommander.startManualMove(operationCoordinator, device, 'NORTH')).toMatchObject(failedOperationResult('commandFailed', 'transport closed'))
	} finally {
		moveNorth.mockRestore()
	}

	expect(mountCommander.manualMoveOf(device)).toBeUndefined()
	await waitUntil(() => isFree(device))
})

test('stops a manual move when the initial command starts motion before failing', async () => {
	const device = await connected()
	const moveNorth = spyOn(mountManager, 'moveNorth').mockImplementation((_mount, enabled) => {
		if (enabled) {
			device.slewing = true
			throw new Error('transport closed after dispatch')
		}

		device.slewing = false
	})

	try {
		expect(await mountCommander.startManualMove(operationCoordinator, device, 'NORTH', { settleTimeout: 50 })).toMatchObject(failedOperationResult('commandFailed', 'transport closed after dispatch'))
		await waitUntil(() => moveNorth.mock.calls.some(([, enabled]) => enabled === false))
		expect(device.slewing).toBeFalse()
	} finally {
		moveNorth.mockRestore()
	}

	expect(mountCommander.manualMoveOf(device)).toBeUndefined()
	await waitUntil(() => isFree(device))
})

test('replaces the opposite direction when an axis reverses', async () => {
	const device = await connected()
	const started = await mountCommander.startManualMove(operationCoordinator, device, 'NORTH')

	expect(started.ok).toBeTrue()

	if (!started.ok) return

	const handle = started.value

	expect(await mountCommander.startManualMove(operationCoordinator, device, 'SOUTH')).toMatchObject({ ok: true })
	expect(handle.directions()).toEqual(['SOUTH'])
	expect(await handle.move('SOUTH', false)).toMatchObject({ ok: true })
	expect(device.slewing).toBeFalse()
	expect(mountCommander.manualMoveOf(device)).toBeUndefined()
	await waitUntil(() => isFree(device))
})

test('waits for tracking to be observed before completing', async () => {
	const device = await connected()

	expect(device.tracking).toBeFalse()
	expect(await mountCommander.setTracking(operationCoordinator, device, true)).toMatchObject({ ok: true })
	expect(device.tracking).toBeTrue()
})

test('dispatches synchronization and mount configuration commands', async () => {
	const device = await connected()
	const coordinate = { latitude: deg(-22), longitude: deg(-45), elevation: meter(900) }
	const time = { utc: Math.trunc(Date.now() / 1000) * 1000, offset: 0 }

	expect(await mountCommander.sync(operationCoordinator, device, { type: 'JNOW', JNOW: { x: '06:00:00', y: '-20:00:00' } })).toMatchObject({ ok: true })
	await waitUntil(() => Math.abs(device.equatorialCoordinate.rightAscension - hour(6)) < deg(0.01))
	await waitUntil(() => Math.abs(device.equatorialCoordinate.declination - deg(-20)) < deg(0.01))

	expect(await mountCommander.setGeographicCoordinate(operationCoordinator, device, coordinate)).toMatchObject({ ok: true })
	await waitUntil(() => Math.abs(device.geographicCoordinate.latitude - coordinate.latitude) < 1e-9)
	await waitUntil(() => Math.abs(device.geographicCoordinate.longitude - coordinate.longitude) < 1e-9)
	await waitUntil(() => device.geographicCoordinate.elevation === coordinate.elevation)

	expect(await mountCommander.setTime(operationCoordinator, device, time)).toMatchObject({ ok: true })
	await waitUntil(() => device.time.utc === time.utc && device.time.offset === time.offset)

	expect(await mountCommander.setSlewRate(operationCoordinator, device, 'SPEED_6')).toMatchObject({ ok: true })
	await waitUntil(() => device.slewRate === 'SPEED_6')

	expect(await mountCommander.setTrackMode(operationCoordinator, device, 'SOLAR')).toMatchObject({ ok: true })
	await waitUntil(() => device.trackMode === 'SOLAR')

	expect(await mountCommander.setHome(operationCoordinator, device)).toMatchObject({ ok: true })
	expect(await mountCommander.setPark(operationCoordinator, device)).toMatchObject({ ok: true })
})

test('parks and unparks after the driver reports both transitions', async () => {
	const device = await connected()

	expect(await mountCommander.park(operationCoordinator, device, { timeout: 8000 })).toMatchObject({ ok: true })
	expect(device.parked).toBeTrue()
	expect(await mountCommander.unpark(operationCoordinator, device, { timeout: 8000 })).toMatchObject({ ok: true })
	expect(device.parked).toBeFalse()
})

test('homes and reports an supported mechanical-home search', async () => {
	const device = await connected()

	expect(await mountCommander.home(operationCoordinator, device, { timeout: 8000 })).toMatchObject({ ok: true })
	expect(device.homing).toBeFalse()
	expect(device.canFindHome).toBeTrue()
	expect(await mountCommander.findHome(operationCoordinator, device)).toMatchObject({ ok: true })
})

test('does not complete a flip the mount never started', async () => {
	const device = await connected()
	const flipTo = spyOn(mountManager, 'flipTo').mockImplementation(() => {})

	device.canFlip = true
	mountManager.syncTo(device, hour(5), deg(-30))

	try {
		const result = await mountCommander.flip(operationCoordinator, device, targetCoordinate(), { timeout: 300 })

		expect(result).toMatchObject(failedOperationResult('timeout'))
		expect(flipTo).toHaveBeenCalledTimes(1)
	} finally {
		flipTo.mockRestore()
		device.canFlip = false
	}
})

test('stops observing the manager once disposed', () => {
	const device = getMount()
	const commander = new MountCommander(mountManager)
	const updated = spyOn(commander, 'updated')

	mountManager.updated(device, 'name')
	expect(updated).toHaveBeenCalledTimes(1)

	commander.dispose()
	commander.dispose()
	mountManager.updated(device, 'name')
	expect(updated).toHaveBeenCalledTimes(1)

	const removeHandler = spyOn(mountManager, 'removeHandler')

	try {
		let scoped: MountCommander | undefined

		{
			using commander = new MountCommander(mountManager)
			scoped = commander
		}

		expect(removeHandler).toHaveBeenCalledWith(scoped)
	} finally {
		removeHandler.mockRestore()
	}
})
