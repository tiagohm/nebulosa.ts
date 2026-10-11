import { afterAll, afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { timeYMDHMS } from '../../../src/astronomy/time/time'
import { MountCommander } from '../../../src/devices/commanders/mount'
import { IndiClientHandlerSet } from '../../../src/devices/indi/client'
import type { Mount, MountTargetCoordinate } from '../../../src/devices/indi/device'
import { MountManager, mountTargetEquatorial } from '../../../src/devices/indi/manager/mount'
import { ClientSimulator } from '../../../src/devices/indi/simulator/client'
import { MountSimulator } from '../../../src/devices/indi/simulator/mount'
import type { PropertyState, SetSwitchVector } from '../../../src/devices/indi/types'
import { DeviceLifecycle } from '../../../src/devices/orchestration/device.lifecycle'
import { OperationCoordinator, failedOperationResult, successfulOperationResult } from '../../../src/devices/orchestration/operation'
import { ResourceArbiter, resourceKey } from '../../../src/devices/orchestration/resource'
import { deg, hour, toDeg, toHour } from '../../../src/math/units/angle'
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

test('fails a goto the driver rejects without moving', async () => {
	const device = await connected()
	const RA = toHour(device.equatorialCoordinate.rightAscension)
	const DEC = toDeg(device.equatorialCoordinate.declination)
	const eod = (state: PropertyState) => mountManager.numberVector(client, { device: device.name, name: 'EQUATORIAL_EOD_COORD', state, elements: { RA: { name: 'RA', value: RA }, DEC: { name: 'DEC', value: DEC } } }, 'setNumberVector')

	// Published once beforehand so the rejection below repeats exactly the coordinate the mount holds.
	eod('Ok')

	// A driver that cannot reach the target republishes the coordinate it already had, in Alert.
	const goTo = spyOn(mountManager, 'goTo').mockImplementation(() => eod('Alert'))

	try {
		const started = performance.now()
		expect(await mountCommander.goTo(operationCoordinator, device, { type: 'JNOW', JNOW: { x: '05:00:00', y: '-28:00:00' } }, { timeout: 5000 })).toMatchObject(failedOperationResult('alert'))
		expect(performance.now() - started).toBeLessThan(1000)
		await waitUntil(() => isFree(device))
	} finally {
		goTo.mockRestore()
	}
})

test('reports a mount that disconnected under a composite operation without commanding it', async () => {
	const device = await connected()
	const goTo = spyOn(mountManager, 'goTo')
	const tracking = spyOn(mountManager, 'tracking')
	const slewRate = spyOn(mountManager, 'slewRate')

	try {
		// The feature already holds the mount, so its nested commands inherit the lease instead of being
		// refused by the arbiter, and only the commander can notice the device went away.
		const result = await operationCoordinator.start('feature', [{ key: resourceKey(device), device }], async (context) => {
			device.connected = false

			try {
				expect(await mountCommander.goTo(context, device, targetCoordinate())).toMatchObject(failedOperationResult('disconnected'))
				expect(await mountCommander.setTracking(context, device, true)).toMatchObject(failedOperationResult('disconnected'))
				expect(await mountCommander.park(context, device)).toMatchObject(failedOperationResult('disconnected'))
				expect(await mountCommander.setSlewRate(context, device, 'SPEED_1')).toMatchObject(failedOperationResult('disconnected'))
			} finally {
				device.connected = true
			}

			return successfulOperationResult(undefined)
		}).result

		expect(result).toMatchObject({ ok: true })
		expect(goTo).not.toHaveBeenCalled()
		expect(tracking).not.toHaveBeenCalled()
		expect(slewRate).not.toHaveBeenCalled()
	} finally {
		slewRate.mockRestore()
		tracking.mockRestore()
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

test('starts a new manual move while the previous one is still stopping', async () => {
	const device = await connected()
	const first = await mountCommander.startManualMove(operationCoordinator, device, 'NORTH')

	expect(first.ok).toBeTrue()
	if (!first.ok) return

	await waitUntil(() => device.slewing)

	const stopping = first.value.stop()
	const second = await mountCommander.startManualMove(operationCoordinator, device, 'SOUTH')

	expect(await stopping).toMatchObject({ ok: true })
	expect(second.ok).toBeTrue()
	if (!second.ok) return

	expect(second.value.id).not.toBe(first.value.id)
	expect(second.value.directions()).toEqual(['SOUTH'])
	expect(await second.value.stop()).toMatchObject({ ok: true })
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

test('converts the target at the instant the caller gives', async () => {
	const device = await connected()
	const target: MountTargetCoordinate<number> = { type: 'J2000', J2000: { x: hour(5), y: deg(-29) } }
	const time = timeYMDHMS(2031, 3, 20, 3, 0, 0)
	const expected = mountTargetEquatorial(device, target, time)
	const host = mountTargetEquatorial(device, target)
	const commanded: [string, number, number][] = []
	const record = (kind: string) => (_: Mount, rightAscension: number, declination: number) => {
		commanded.push([kind, rightAscension, declination])
		mountCommander.updated(device, 'slewing', 'Alert')
	}
	const goTo = spyOn(mountManager, 'goTo').mockImplementation(record('goTo'))
	const flipTo = spyOn(mountManager, 'flipTo').mockImplementation(record('flipTo'))
	const syncTo = spyOn(mountManager, 'syncTo').mockImplementation(record('syncTo'))
	device.canFlip = true

	try {
		await mountCommander.goTo(operationCoordinator, device, target, { time })
		await mountCommander.flip(operationCoordinator, device, target, { time })
		await mountCommander.sync(operationCoordinator, device, target, { time })
		expect(commanded).toEqual([
			['goTo', ...expected],
			['flipTo', ...expected],
			['syncTo', ...expected],
		])

		// Years of precession apart from the host clock, far beyond any rounding.
		expect(Math.abs(expected[0] - host[0])).toBeGreaterThan(deg(0.02))

		// Without a time the host clock is used, and a JNOW target is used as given whatever the time.
		commanded.length = 0
		await mountCommander.sync(operationCoordinator, device, target)
		await mountCommander.sync(operationCoordinator, device, targetCoordinate(), { time })
		expect(commanded[0][1]).toBeCloseTo(host[0], 6)
		expect(commanded[1].slice(1)).toEqual(mountTargetEquatorial(device, targetCoordinate()))
	} finally {
		syncTo.mockRestore()
		flipTo.mockRestore()
		goTo.mockRestore()
	}
})

test('selects a track mode only once the mount reports it', async () => {
	const device = await connected()

	expect(await mountCommander.setTrackMode(operationCoordinator, device, 'LUNAR')).toMatchObject({ ok: true })
	expect(device.trackMode).toBe('LUNAR')
	expect(await mountCommander.setTrackMode(operationCoordinator, device, 'SIDEREAL')).toMatchObject({ ok: true })
	expect(device.trackMode).toBe('SIDEREAL')
	expect(isFree(device)).toBeTrue()
})

test('fails a track mode the mount ignores, refuses or loses', async () => {
	const device = await connected()
	const trackModeVector = (state: PropertyState) => mountManager.switchVector(client, { device: device.name, name: 'TELESCOPE_TRACK_MODE', state, elements: { TRACK_SIDEREAL: { name: 'TRACK_SIDEREAL', value: device.trackMode === 'SIDEREAL' } } }, 'setSwitchVector')
	const trackMode = spyOn(mountManager, 'trackMode').mockImplementation(() => {})

	try {
		expect(device.trackMode).toBe('SIDEREAL')
		expect(await mountCommander.setTrackMode(operationCoordinator, device, 'SOLAR', { timeout: 100 })).toMatchObject(failedOperationResult('timeout'))
		expect(device.trackMode).toBe('SIDEREAL')

		trackMode.mockImplementation(() => trackModeVector('Alert'))
		expect(await mountCommander.setTrackMode(operationCoordinator, device, 'SOLAR', { timeout: 5000 })).toMatchObject(failedOperationResult('alert'))

		trackMode.mockImplementation(() => {
			device.connected = false
			mountCommander.updated(device, 'connected')
		})
		expect(await mountCommander.setTrackMode(operationCoordinator, device, 'SOLAR', { timeout: 5000 })).toMatchObject(failedOperationResult('disconnected'))
		device.connected = true

		// A canceled wait settles at the abort, long before its timeout.
		trackMode.mockImplementation(() => {})
		const started = performance.now()
		const pending = mountCommander.setTrackMode(operationCoordinator, device, 'SOLAR', { timeout: 60000 })
		await Bun.sleep(10)
		await operationCoordinator.cancelByResource(resourceKey(device))
		expect((await pending).ok).toBeFalse()
		expect(performance.now() - started).toBeLessThan(1000)
		await waitUntil(() => isFree(device))
	} finally {
		trackMode.mockRestore()
	}
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
