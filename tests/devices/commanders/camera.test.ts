import { afterAll, afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { CameraCommander } from '../../../src/devices/commanders/camera'
import { IndiClientHandlerSet } from '../../../src/devices/indi/client'
import type { Camera } from '../../../src/devices/indi/device'
import { CameraManager } from '../../../src/devices/indi/manager/camera'
import { CameraSimulator } from '../../../src/devices/indi/simulator/camera'
import { ClientSimulator } from '../../../src/devices/indi/simulator/client'
import { DeviceLifecycle } from '../../../src/devices/orchestration/device.lifecycle'
import { OperationCoordinator, failedOperationResult } from '../../../src/devices/orchestration/operation'
import { ResourceArbiter, resourceKey } from '../../../src/devices/orchestration/resource'
import { waitUntil } from '../../util'

const cameraManager = new CameraManager()
const resourceArbiter = new ResourceArbiter()
const operationCoordinator = new OperationCoordinator(resourceArbiter)
const cameraCommander = new CameraCommander(cameraManager)
const deviceLifecycle = new DeviceLifecycle(resourceArbiter, operationCoordinator)
deviceLifecycle.observe(cameraManager)
const handler = new IndiClientHandlerSet([cameraManager])
const client = new ClientSimulator('Client Simulator', handler)
const simulator = new CameraSimulator('Camera Simulator', client)

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
	await waitUntil(() => camera.connected && camera.hasCoolerControl && camera.canSetTemperature)
	if (camera.cooler) {
		cameraManager.cooler(camera, false)
		await waitUntil(() => !camera.cooler)
	}
	return camera
}

test('switches the cooler and sets the target temperature', async () => {
	const camera = await connected()
	const cooler = spyOn(cameraManager, 'cooler').mockImplementation(() => {})
	const temperature = spyOn(cameraManager, 'temperature').mockImplementation(() => {})

	try {
		expect(await cameraCommander.cooler(operationCoordinator, camera, true)).toMatchObject({ ok: true })
		expect(cooler).toHaveBeenCalledWith(camera, true)

		expect(await cameraCommander.temperature(operationCoordinator, camera, -15)).toMatchObject({ ok: true })
		expect(temperature).toHaveBeenCalledWith(camera, -15)
	} finally {
		cooler.mockRestore()
		temperature.mockRestore()
	}
})

test('rejects thermal commands when their capabilities are absent', async () => {
	const camera = await connected()
	const cooler = spyOn(cameraManager, 'cooler').mockImplementation(() => {})
	const temperature = spyOn(cameraManager, 'temperature').mockImplementation(() => {})

	try {
		camera.hasCoolerControl = false
		expect(await cameraCommander.cooler(operationCoordinator, camera, true)).toMatchObject(failedOperationResult('unexpectedState'))
		expect(cooler).not.toHaveBeenCalled()

		camera.hasCoolerControl = true
		camera.canSetTemperature = false
		expect(await cameraCommander.temperature(operationCoordinator, camera, -15)).toMatchObject(failedOperationResult('unexpectedState'))
		expect(temperature).not.toHaveBeenCalled()
	} finally {
		camera.hasCoolerControl = true
		camera.canSetTemperature = true
		cooler.mockRestore()
		temperature.mockRestore()
	}
})

test('reports a disconnected camera before dispatching a command', async () => {
	const camera = getCamera()
	cameraManager.connect(camera)
	await waitUntil(() => camera.connected)
	cameraManager.disconnect(camera)
	await waitUntil(() => !camera.connected)

	const cooler = spyOn(cameraManager, 'cooler').mockImplementation(() => {})
	try {
		const isolatedArbiter = new ResourceArbiter()
		camera.connected = true
		isolatedArbiter.markAvailable({ key: resourceKey(camera), device: camera })
		camera.connected = false
		isolatedArbiter.markAvailable(resourceKey(camera))
		const isolatedCoordinator = new OperationCoordinator(isolatedArbiter)
		expect(await cameraCommander.cooler(isolatedCoordinator, camera, true)).toMatchObject(failedOperationResult('disconnected'))
		expect(cooler).not.toHaveBeenCalled()
	} finally {
		cooler.mockRestore()
	}
})

test('refuses a thermal command while another operation owns the camera', async () => {
	const camera = await connected()
	const held = operationCoordinator.start<void>(
		'hold',
		[{ key: resourceKey(camera), device: camera }],
		(context) =>
			new Promise((resolve) => {
				context.signal.addEventListener('abort', () => resolve(failedOperationResult('aborted')), { once: true })
			}),
	)

	expect(await cameraCommander.cooler(operationCoordinator, camera, true)).toMatchObject(failedOperationResult('busy'))
	await held.cancel()
	expect(isFree(camera)).toBeTrue()
})
