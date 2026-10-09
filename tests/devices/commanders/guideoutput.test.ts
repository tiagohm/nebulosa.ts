import { afterAll, afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { GuideOutputCommander } from '../../../src/devices/commanders/guideoutput'
import { IndiClientHandlerSet } from '../../../src/devices/indi/client'
import type { GuideOutput, Camera } from '../../../src/devices/indi/device'
import { CameraManager } from '../../../src/devices/indi/manager/camera'
import type { DeviceProvider } from '../../../src/devices/indi/manager/device'
import { GuideOutputManager } from '../../../src/devices/indi/manager/guideoutput'
import { CameraSimulator } from '../../../src/devices/indi/simulator/camera'
import { ClientSimulator } from '../../../src/devices/indi/simulator/client'
import type { PropertyState } from '../../../src/devices/indi/types'
import { DeviceLifecycle } from '../../../src/devices/orchestration/device.lifecycle'
import { OperationCoordinator, failedOperationResult, successfulOperationResult } from '../../../src/devices/orchestration/operation'
import { ResourceArbiter, resourceKey } from '../../../src/devices/orchestration/resource'
import { waitUntil } from '../../util'

const cameraManager = new CameraManager()
const guideOutputProvider: DeviceProvider<GuideOutput> = { get: (client, name) => cameraManager.get(client, name) }
const guideOutputManager = new GuideOutputManager(guideOutputProvider)
const resourceArbiter = new ResourceArbiter()
const operationCoordinator = new OperationCoordinator(resourceArbiter)
const guideOutputCommander = new GuideOutputCommander(guideOutputManager)
const deviceLifecycle = new DeviceLifecycle(resourceArbiter, operationCoordinator)
deviceLifecycle.observe(cameraManager)
deviceLifecycle.observe(guideOutputManager)
const handler = new IndiClientHandlerSet([cameraManager, guideOutputManager])
const client = new ClientSimulator('Client Simulator', handler)
const simulator = new CameraSimulator('Camera Simulator', client, { guideOutputManager })

afterAll(() => {
	deviceLifecycle.dispose()
	simulator.dispose()
})

beforeEach(() => {
	cameraManager.disconnect(getCamera())
})

afterEach(async () => {
	await operationCoordinator.cancelAll()
	cameraManager.disconnect(getCamera())
})

function getCamera() {
	const device = cameraManager.get(client, simulator.name)
	expect(device).toBeDefined()
	return device!
}

function isFree(camera: Camera) {
	return resourceArbiter.availability(resourceKey(camera)) === 'available'
}

async function connected() {
	const camera = getCamera()
	cameraManager.connect(camera)
	await waitUntil(() => camera.connected && camera.canPulseGuide)
	camera.canSetGuideRate = true
	return camera
}

// Feeds one timed-guide vector through the manager, as the driver would publish it.
function guideVector(camera: Camera, name: 'TELESCOPE_TIMED_GUIDE_NS' | 'TELESCOPE_TIMED_GUIDE_WE', state: PropertyState) {
	guideOutputManager.numberVector(client, { device: camera.name, name, state, elements: {} }, 'setNumberVector')
}

async function stop(camera: Camera) {
	await operationCoordinator.cancelByResource(resourceKey(camera))
	return await guideOutputCommander.stopPulses(camera, ['NORTH', 'WEST'], { settleTimeout: 500 })
}

test('pulses one direction for its complete duration', async () => {
	const camera = await connected()

	expect(await guideOutputCommander.pulse(operationCoordinator, camera, 'NORTH', 50, { settleTimeout: 500 })).toMatchObject({ ok: true })
	expect(camera.pulsing).toBeFalse()
	await waitUntil(() => isFree(camera))
})

test('runs perpendicular pulses in one operation and waits for both', async () => {
	const camera = await connected()

	expect(
		await guideOutputCommander.pulseAxes(
			operationCoordinator,
			camera,
			[
				{ direction: 'NORTH', duration: 30 },
				{ direction: 'EAST', duration: 60 },
			],
			{ settleTimeout: 500 },
		),
	).toMatchObject({ ok: true })
	expect(camera.pulsing).toBeFalse()
	await waitUntil(() => isFree(camera))
})

test('sets both guide rates under the camera resource', async () => {
	const camera = await connected()
	const guideRate = spyOn(guideOutputManager, 'guideRate').mockImplementation(() => {})

	try {
		expect(await guideOutputCommander.setGuideRate(operationCoordinator, camera, 0.25, 0.75)).toMatchObject({ ok: true })
		expect(guideRate).toHaveBeenCalledWith(camera, 0.25, 0.75)
	} finally {
		guideRate.mockRestore()
	}
})

test('zeros both directions of every selected guide axis when stopping pulses', async () => {
	const camera = await connected()
	const pulse = spyOn(guideOutputManager, 'pulse').mockImplementation(() => {})

	try {
		expect(await guideOutputCommander.stopPulses(camera, ['NORTH', 'WEST'], { settleTimeout: 50 })).toMatchObject({ ok: true })
		expect(pulse).toHaveBeenCalledTimes(4)
		expect(pulse).toHaveBeenCalledWith(camera, 'NORTH', 0)
		expect(pulse).toHaveBeenCalledWith(camera, 'SOUTH', 0)
		expect(pulse).toHaveBeenCalledWith(camera, 'WEST', 0)
		expect(pulse).toHaveBeenCalledWith(camera, 'EAST', 0)
	} finally {
		pulse.mockRestore()
	}
})

test('stops all axes when a pulse operation is canceled', async () => {
	const camera = await connected()
	const pulsing = guideOutputCommander.pulse(operationCoordinator, camera, 'SOUTH', 1000, { settleTimeout: 500 })

	await waitUntil(() => camera.pulsing)
	const stopped = await stop(camera)

	expect(stopped).toMatchObject({ ok: true })
	expect(await pulsing).toMatchObject(failedOperationResult('aborted'))
	expect(camera.pulsing).toBeFalse()
	await waitUntil(() => isFree(camera))
})

test('fails a pulse immediately when the driver reports an Alert', async () => {
	const camera = await connected()
	const pulse = spyOn(guideOutputManager, 'pulse').mockImplementation((device, direction, duration) => {
		if (duration > 0) guideOutputCommander.updated(device, 'pulsing', 'Alert')
	})

	try {
		expect(await guideOutputCommander.pulse(operationCoordinator, camera, 'EAST', 100, { settleTimeout: 100 })).toMatchObject(failedOperationResult('alert'))
		// The pulse vector already zeroes the opposite direction, so nothing is sent before it.
		expect(pulse.mock.calls[0]).toEqual([camera, 'EAST', 100])
		expect(isFree(camera)).toBeTrue()
	} finally {
		pulse.mockRestore()
	}
})

test('cancels sibling pulses when one axis reports an Alert', async () => {
	const camera = await connected()
	const pulse = spyOn(guideOutputManager, 'pulse').mockImplementation((device, direction, duration) => {
		if (direction === 'NORTH' && duration > 0) guideOutputCommander.updated(device, 'pulsing', 'Alert')
	})

	try {
		const started = performance.now()
		const result = await guideOutputCommander.pulseAxes(
			operationCoordinator,
			camera,
			[
				{ direction: 'NORTH', duration: 1000 },
				{ direction: 'EAST', duration: 1000 },
			],
			{ settleTimeout: 50 },
		)

		expect(result).toMatchObject(failedOperationResult('alert'))
		expect(performance.now() - started).toBeLessThan(500)
		expect(camera.pulsing).toBeFalse()
		await waitUntil(() => isFree(camera))
	} finally {
		pulse.mockRestore()
	}
})

test('fails a pulse the driver refuses without ever reporting it busy', async () => {
	const camera = await connected()
	const pulse = spyOn(guideOutputManager, 'pulse').mockImplementation((device, direction, duration) => {
		if (duration > 0) guideVector(camera, 'TELESCOPE_TIMED_GUIDE_WE', 'Alert')
	})

	try {
		const started = performance.now()
		expect(await guideOutputCommander.pulse(operationCoordinator, camera, 'WEST', 1000, { settleTimeout: 100 })).toMatchObject(failedOperationResult('alert'))
		expect(performance.now() - started).toBeLessThan(500)
	} finally {
		pulse.mockRestore()
	}
})

test('fails a diagonal nudge when one axis reports an Alert while the other is still pulsing', async () => {
	const camera = await connected()
	const timers: Timer[] = []
	const pulse = spyOn(guideOutputManager, 'pulse').mockImplementation((device, direction, duration) => {
		if (duration <= 0) return

		if (direction === 'NORTH') {
			guideVector(camera, 'TELESCOPE_TIMED_GUIDE_NS', 'Busy')
			timers.push(setTimeout(() => guideVector(camera, 'TELESCOPE_TIMED_GUIDE_NS', 'Alert'), 20))
		} else {
			guideVector(camera, 'TELESCOPE_TIMED_GUIDE_WE', 'Busy')
			timers.push(setTimeout(() => guideVector(camera, 'TELESCOPE_TIMED_GUIDE_WE', 'Ok'), duration))
		}
	})

	try {
		const result = await guideOutputCommander.pulseAxes(
			operationCoordinator,
			camera,
			[
				{ direction: 'NORTH', duration: 200 },
				{ direction: 'WEST', duration: 300 },
			],
			{ settleTimeout: 500 },
		)

		expect(result).toMatchObject(failedOperationResult('alert'))
		expect(camera.pulsing).toBeFalse()
	} finally {
		for (const timer of timers) clearTimeout(timer)
		pulse.mockRestore()
	}
})

test('waits out a pulse the driver cannot cut short when stopping it', async () => {
	const camera = await connected()
	const timers: Timer[] = []
	// Like the standard INDI guider interface, a zero duration is ignored and the pulse runs to its end.
	const pulse = spyOn(guideOutputManager, 'pulse').mockImplementation((device, direction, duration) => {
		if (duration <= 0) return
		guideVector(camera, 'TELESCOPE_TIMED_GUIDE_NS', 'Busy')
		timers.push(setTimeout(() => guideVector(camera, 'TELESCOPE_TIMED_GUIDE_NS', 'Ok'), duration))
	})

	try {
		const started = performance.now()
		const pulsing = guideOutputCommander.pulse(operationCoordinator, camera, 'NORTH', 600)

		await waitUntil(() => camera.pulsing)

		// The stop's own allowance counts from the end of the pulse, so it outlasts the pulse instead of
		// failing while the axis is still legitimately being driven.
		expect(await guideOutputCommander.stopPulse(camera, 'NORTH', { settleTimeout: 100 })).toEqual(successfulOperationResult(undefined))
		expect(performance.now() - started).toBeGreaterThanOrEqual(550)
		expect(camera.pulsing).toBeFalse()

		expect(await pulsing).toEqual(successfulOperationResult(undefined))
		await waitUntil(() => isFree(camera))
	} finally {
		for (const timer of timers) clearTimeout(timer)
		pulse.mockRestore()
	}
})

test('rejects pulses without capability and reports a disconnected output', async () => {
	const camera = await connected()
	camera.canPulseGuide = false

	expect(await guideOutputCommander.pulse(operationCoordinator, camera, 'NORTH', 10)).toMatchObject(failedOperationResult('unexpectedState'))
	expect(await guideOutputCommander.stopPulses(camera, ['NORTH'])).toMatchObject({ ok: true })

	camera.canPulseGuide = true
	cameraManager.disconnect(camera)
	await waitUntil(() => !camera.connected)
	expect(await guideOutputCommander.stopPulse(camera, 'NORTH')).toMatchObject(failedOperationResult('disconnected'))
})

test('refuses guide-rate changes while a pulse owns the physical camera', async () => {
	const camera = await connected()
	const pulsing = guideOutputCommander.pulse(operationCoordinator, camera, 'NORTH', 1000, { settleTimeout: 500 })

	await waitUntil(() => camera.pulsing)
	expect(await guideOutputCommander.setGuideRate(operationCoordinator, camera, 0.5, 0.5)).toMatchObject(failedOperationResult('busy'))

	await stop(camera)
	await pulsing
})

test('stops observing the manager once disposed', () => {
	const device = getCamera()
	const commander = new GuideOutputCommander(guideOutputManager)
	const updated = spyOn(commander, 'updated')

	guideOutputManager.updated(device, 'name')
	expect(updated).toHaveBeenCalledTimes(1)

	commander.dispose()
	commander.dispose()
	guideOutputManager.updated(device, 'name')
	expect(updated).toHaveBeenCalledTimes(1)

	const removeHandler = spyOn(guideOutputManager, 'removeHandler')

	try {
		let scoped: GuideOutputCommander | undefined

		{
			using commander = new GuideOutputCommander(guideOutputManager)
			scoped = commander
		}

		expect(removeHandler).toHaveBeenCalledWith(scoped)
	} finally {
		removeHandler.mockRestore()
	}
})
