import { afterAll, afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { GuideOutputCommander } from '../../../src/devices/commanders/guideoutput'
import { IndiClientHandlerSet } from '../../../src/devices/indi/client'
import type { GuideOutput, Camera } from '../../../src/devices/indi/device'
import { CameraManager } from '../../../src/devices/indi/manager/camera'
import type { DeviceProvider } from '../../../src/devices/indi/manager/device'
import { GuideOutputManager } from '../../../src/devices/indi/manager/guideoutput'
import { CameraSimulator } from '../../../src/devices/indi/simulator/camera'
import { ClientSimulator } from '../../../src/devices/indi/simulator/client'
import { DeviceLifecycle } from '../../../src/devices/orchestration/device.lifecycle'
import { OperationCoordinator, failedOperationResult } from '../../../src/devices/orchestration/operation'
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
		expect(pulse).toHaveBeenCalledWith(camera, 'WEST', 0)
		expect(pulse).toHaveBeenCalledWith(camera, 'EAST', 100)
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
