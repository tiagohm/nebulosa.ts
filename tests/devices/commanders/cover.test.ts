import { afterAll, afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { CoverCommander } from '../../../src/devices/commanders/cover'
import { IndiClientHandlerSet } from '../../../src/devices/indi/client'
import type { Cover } from '../../../src/devices/indi/device'
import { CoverManager } from '../../../src/devices/indi/manager/cover'
import { ClientSimulator } from '../../../src/devices/indi/simulator/client'
import { CoverSimulator } from '../../../src/devices/indi/simulator/cover'
import { DeviceLifecycle } from '../../../src/devices/orchestration/device.lifecycle'
import { OperationCoordinator, failedOperationResult } from '../../../src/devices/orchestration/operation'
import { ResourceArbiter, resourceKey } from '../../../src/devices/orchestration/resource'
import { waitUntil } from '../../util'

const coverManager = new CoverManager()
const resourceArbiter = new ResourceArbiter()
const operationCoordinator = new OperationCoordinator(resourceArbiter)
const coverCommander = new CoverCommander(coverManager)
const deviceLifecycle = new DeviceLifecycle(resourceArbiter, operationCoordinator)
deviceLifecycle.observe(coverManager)
const handler = new IndiClientHandlerSet([coverManager])
const client = new ClientSimulator('Client Simulator', handler)
const simulator = new CoverSimulator('Cover Simulator', client)

afterAll(() => {
	deviceLifecycle.dispose()
	simulator.dispose()
})

beforeEach(() => {
	coverManager.disconnect(getCover())
})

afterEach(async () => {
	await operationCoordinator.cancelAll()
	coverManager.disconnect(getCover())
})

function getCover() {
	const device = coverManager.get(client, simulator.name)
	expect(device).toBeDefined()
	return device!
}

function isFree(cover: Cover) {
	return resourceArbiter.availability(resourceKey(cover)) === 'available'
}

async function connected() {
	const cover = getCover()
	coverManager.connect(cover)
	await waitUntil(() => cover.connected && cover.canPark && cover.canAbort)
	if (cover.parked) {
		coverManager.unpark(cover)
		await waitUntil(() => !cover.parked && !cover.parking)
	}
	return cover
}

async function stop(cover: Cover) {
	await operationCoordinator.cancelByResource(resourceKey(cover))
	return await coverCommander.stopMotion(cover, { settleTimeout: 500 })
}

test('parks and unparks only after the cover reports its final state', async () => {
	const cover = await connected()

	expect(await coverCommander.park(operationCoordinator, cover, { timeout: 2000 })).toMatchObject({ ok: true })
	expect(cover.parked).toBeTrue()
	expect(cover.parking).toBeFalse()

	expect(await coverCommander.unpark(operationCoordinator, cover, { timeout: 2000 })).toMatchObject({ ok: true })
	expect(cover.parked).toBeFalse()
	expect(cover.parking).toBeFalse()
})

test('resolves a command already at the requested cover state', async () => {
	const cover = await connected()
	const unpark = spyOn(coverManager, 'unpark')

	try {
		expect(await coverCommander.unpark(operationCoordinator, cover, { timeout: 50 })).toMatchObject({ ok: true })
		expect(unpark).toHaveBeenCalledWith(cover)
		expect(isFree(cover)).toBeTrue()
	} finally {
		unpark.mockRestore()
	}
})

test('stops a canceled cover motion before releasing the cover', async () => {
	const cover = await connected()
	const moving = coverCommander.park(operationCoordinator, cover, { timeout: 2000 })

	await waitUntil(() => cover.parking)
	const stopped = await stop(cover)

	expect(stopped).toMatchObject({ ok: true })
	expect(await moving).toMatchObject(failedOperationResult('aborted'))
	expect(cover.parking).toBeFalse()
	expect(cover.parked).toBeFalse()
	await waitUntil(() => isFree(cover))
})

test('reports a driver Alert from the cover motion', async () => {
	const cover = await connected()
	const moving = coverCommander.park(operationCoordinator, cover, { timeout: 2000 })

	await waitUntil(() => cover.parking)
	simulator.stop()

	expect(await moving).toMatchObject(failedOperationResult('alert'))
	expect(cover.parking).toBeFalse()
	await waitUntil(() => isFree(cover))
})

test('times out a motion that the driver never starts and still releases the cover', async () => {
	const cover = await connected()
	const park = spyOn(coverManager, 'park').mockImplementation(() => {})

	try {
		expect(await coverCommander.park(operationCoordinator, cover, { timeout: 20, settleTimeout: 20 })).toMatchObject(failedOperationResult('timeout'))
		expect(park).toHaveBeenCalledWith(cover)
		expect(isFree(cover)).toBeTrue()
	} finally {
		park.mockRestore()
	}
})

test('rejects parking without the capability and stops directly when disconnected', async () => {
	const cover = await connected()
	const park = spyOn(coverManager, 'park').mockImplementation(() => {})

	try {
		cover.canPark = false
		expect(await coverCommander.park(operationCoordinator, cover)).toMatchObject(failedOperationResult('unexpectedState'))
		expect(park).not.toHaveBeenCalled()
	} finally {
		park.mockRestore()
		cover.canPark = true
	}

	coverManager.disconnect(cover)
	await waitUntil(() => !cover.connected)
	expect(await coverCommander.stopMotion(cover)).toMatchObject(failedOperationResult('disconnected'))
})
