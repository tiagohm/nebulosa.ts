import { afterAll, afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { CameraCommander } from '../../../src/devices/commanders/camera'
import { IndiClientHandlerSet } from '../../../src/devices/indi/client'
import type { Camera } from '../../../src/devices/indi/device'
import { CameraManager } from '../../../src/devices/indi/manager/camera'
import { CameraSimulator } from '../../../src/devices/indi/simulator/camera'
import { ClientSimulator } from '../../../src/devices/indi/simulator/client'
import type { PropertyState } from '../../../src/devices/indi/types'
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

test('switches the cooler and sets the target temperature once the driver answers them', async () => {
	const camera = await connected()
	const cooler = spyOn(cameraManager, 'cooler')
	const temperature = spyOn(cameraManager, 'temperature')

	try {
		expect(await cameraCommander.cooler(operationCoordinator, camera, true)).toMatchObject({ ok: true })
		expect(cooler).toHaveBeenCalledWith(camera, true)
		expect(camera.cooler).toBeTrue()

		expect(await cameraCommander.temperature(operationCoordinator, camera, -15)).toMatchObject({ ok: true })
		expect(temperature).toHaveBeenCalledWith(camera, -15)

		expect(await cameraCommander.cooler(operationCoordinator, camera, false)).toMatchObject({ ok: true })
		expect(camera.cooler).toBeFalse()
		expect(isFree(camera)).toBeTrue()
	} finally {
		cooler.mockRestore()
		temperature.mockRestore()
	}
})

test('resolves a cooler switch only after the driver reports it', async () => {
	const camera = await connected()
	const cooler = spyOn(cameraManager, 'cooler').mockImplementation(() => {})

	try {
		let settled = false
		const command = cameraCommander.cooler(operationCoordinator, camera, true).then((result) => {
			settled = true
			return result
		})

		await Bun.sleep(30)
		expect(settled).toBeFalse()
		cooler.mockRestore()
		cameraManager.cooler(camera, true)
		expect(await command).toMatchObject({ ok: true })
		expect(camera.cooler).toBeTrue()
	} finally {
		cooler.mockRestore()
	}
})

test('times out when the driver never answers a thermal command', async () => {
	const camera = await connected()
	const cooler = spyOn(cameraManager, 'cooler').mockImplementation(() => {})
	const temperature = spyOn(cameraManager, 'temperature').mockImplementation(() => {})

	try {
		expect(await cameraCommander.cooler(operationCoordinator, camera, true, { timeout: 30 })).toMatchObject(failedOperationResult('timeout'))
		expect(await cameraCommander.temperature(operationCoordinator, camera, -15, { timeout: 30 })).toMatchObject(failedOperationResult('timeout'))
		expect(isFree(camera)).toBeTrue()
	} finally {
		cooler.mockRestore()
		temperature.mockRestore()
	}
})

test('reads back a cooling target from the state of CCD_TEMPERATURE', async () => {
	const camera = await connected()
	const answer = (state: PropertyState, value: number) => cameraManager.numberVector(client, { device: camera.name, name: 'CCD_TEMPERATURE', state, elements: { CCD_TEMPERATURE_VALUE: { name: 'CCD_TEMPERATURE_VALUE', value } } }, 'setNumberVector')
	let reply: (() => void) | undefined
	const temperature = spyOn(cameraManager, 'temperature').mockImplementation(() => reply?.())

	try {
		// Ramping towards the target.
		reply = () => answer('Busy', 10)
		expect(await cameraCommander.temperature(operationCoordinator, camera, -15, { timeout: 1000 })).toMatchObject({ ok: true })

		// Already at the target.
		reply = () => answer('Ok', -14.8)
		expect(await cameraCommander.temperature(operationCoordinator, camera, -15, { timeout: 1000 })).toMatchObject({ ok: true })

		// An Ok reading far from the new target is a poll from before the command, not its answer.
		reply = () => answer('Ok', 10)
		expect(await cameraCommander.temperature(operationCoordinator, camera, -15, { timeout: 50 })).toMatchObject(failedOperationResult('timeout'))

		// Refused.
		reply = () => answer('Alert', 10)
		expect(await cameraCommander.temperature(operationCoordinator, camera, -15, { timeout: 1000 })).toMatchObject(failedOperationResult('alert'))
	} finally {
		temperature.mockRestore()
	}
})

test('stops observing the manager once disposed', () => {
	const commander = new CameraCommander(cameraManager)
	const removeHandler = spyOn(cameraManager, 'removeHandler')

	try {
		commander.dispose()
		commander[Symbol.dispose]()
		expect(removeHandler).toHaveBeenCalledTimes(2)
		expect(removeHandler).toHaveBeenCalledWith(commander)
	} finally {
		removeHandler.mockRestore()
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
