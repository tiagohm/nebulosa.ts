import { describe, expect, spyOn, test } from 'bun:test'
import { CLIENT, type Camera, type Cover, type Device, type Dome, type GuideOutput, type Mount, type SubDevice, DEFAULT_CAMERA, DEFAULT_COVER, DEFAULT_DOME, DEFAULT_GUIDE_OUTPUT, DEFAULT_MOUNT } from '../../../src/devices/indi/device'
import type { DeviceHandler } from '../../../src/devices/indi/manager/device'
import { DomeManager } from '../../../src/devices/indi/manager/dome'
import type { DefSwitchVector } from '../../../src/devices/indi/types'
import { DeviceLifecycle, isDeviceQuiescent } from '../../../src/devices/orchestration/device.lifecycle'
import { failedOperationResult, OperationCoordinator, type OperationContext, type OperationResult } from '../../../src/devices/orchestration/operation'
import { ResourceArbiter, resourceKey } from '../../../src/devices/orchestration/resource'
import { flushMicrotasks } from '../../util'
import { client, defSwitch } from '../indi/manager/util'

class TestDeviceManager<D extends Device> {
	readonly #devices = new Set<D>()
	readonly #handlers = new Set<DeviceHandler<D>>()

	addHandler(handler: DeviceHandler<D>) {
		this.#handlers.add(handler)
	}

	removeHandler(handler: DeviceHandler<D>) {
		this.#handlers.delete(handler)
	}

	list() {
		return this.#devices
	}

	add(device: D) {
		this.#devices.add(device)
		for (const handler of this.#handlers) handler.added(device)
	}

	update(device: D, property: keyof D & string) {
		for (const handler of this.#handlers) handler.updated?.(device, property)
	}

	remove(device: D) {
		for (const handler of this.#handlers) handler.removed(device)
		this.#devices.delete(device)
	}
}

function camera(): Camera {
	return {
		...structuredClone(DEFAULT_CAMERA),
		id: 'camera-1',
		name: 'camera-1',
		connected: true,
		client: { type: 'SIMULATOR', id: 'client-1' },
	} satisfies Camera
}

function guideOutput(): GuideOutput {
	return {
		...structuredClone(DEFAULT_GUIDE_OUTPUT),
		id: 'guide-output-1',
		name: 'guide-output-1',
		connected: true,
		client: { type: 'SIMULATOR', id: 'client-1' },
	}
}

function mount(): Mount {
	return {
		...structuredClone(DEFAULT_MOUNT),
		id: 'mount-1',
		name: 'mount-1',
		connected: true,
		client: { type: 'SIMULATOR', id: 'client-1' },
	}
}

function guideOutputProxy(parent: Mount): SubDevice<GuideOutput, Mount> {
	return {
		...structuredClone(DEFAULT_GUIDE_OUTPUT),
		id: 'guide-output-1',
		parentId: parent.id,
		parent,
		name: parent.name,
		connected: true,
		client: parent.client,
	}
}

function cover(): Cover {
	return {
		...structuredClone(DEFAULT_COVER),
		id: 'cover-1',
		name: 'cover-1',
		connected: true,
		client: { type: 'SIMULATOR', id: 'client-1' },
	}
}

function dome(): Dome {
	return {
		...structuredClone(DEFAULT_DOME),
		id: 'dome-1',
		name: 'dome-1',
		connected: true,
		client: { type: 'SIMULATOR', id: 'client-1' },
	}
}

function waitForAbort(context: OperationContext): Promise<OperationResult<void>> {
	return new Promise((resolve) => {
		context.signal.addEventListener('abort', () => resolve(failedOperationResult('aborted')), { once: true })
	})
}

describe('device lifecycle', () => {
	test('cancels the resource owner synchronously on disconnect', async () => {
		const manager = new TestDeviceManager<Camera>()
		const arbiter = new ResourceArbiter()
		const coordinator = new OperationCoordinator(arbiter)
		const lifecycle = new DeviceLifecycle(arbiter, coordinator)
		const device = camera()
		const key = resourceKey(device)

		lifecycle.observe(manager)
		manager.add(device)
		expect(arbiter.availability(key)).toBe('available')

		const handle = coordinator.start('capture', [{ key, device }], waitForAbort)

		device.connected = false
		manager.update(device, 'connected')

		expect(handle.signal.aborted).toBeTrue()
		expect(arbiter.availability(key)).toBe('unavailable')
		expect(await handle.result).toEqual(failedOperationResult('disconnected'))

		lifecycle.dispose()
	})

	test('cancels an owner that reserved the device under a logical resource', async () => {
		const manager = new TestDeviceManager<Camera>()
		const arbiter = new ResourceArbiter()
		const coordinator = new OperationCoordinator(arbiter)
		const lifecycle = new DeviceLifecycle(arbiter, coordinator)
		const device = camera()
		const key = resourceKey(device)

		lifecycle.observe(manager)
		manager.add(device)

		const handle = coordinator.start('guiderSession', [{ key: `logical:guider:local:camera:${key}`, device }], waitForAbort)

		expect(arbiter.availability(key)).toBe('available')

		device.connected = false
		manager.update(device, 'connected')

		expect(handle.signal.aborted).toBeTrue()
		expect(await handle.result).toEqual(failedOperationResult('disconnected'))

		lifecycle.dispose()
	})

	test('keeps logical resources unavailable until a disconnected device reconnects', async () => {
		const manager = new TestDeviceManager<Camera>()
		const arbiter = new ResourceArbiter()
		const coordinator = new OperationCoordinator(arbiter)
		const lifecycle = new DeviceLifecycle(arbiter, coordinator)
		const device = camera()
		const key = resourceKey(device)
		const logicalKey = `logical:guider:local:camera:${key}`
		let invoked = false

		lifecycle.observe(manager)
		manager.add(device)

		const active = coordinator.start('guiderSession', [{ key: logicalKey, device }], waitForAbort)
		device.connected = false
		manager.update(device, 'connected')

		expect(await active.result).toEqual(failedOperationResult('disconnected'))
		expect(arbiter.availability(logicalKey)).toBe('unavailable')

		const blocked = coordinator.start('retry', [{ key: logicalKey, device }], () => {
			invoked = true
			return failedOperationResult('unexpectedState')
		})

		expect(await blocked.result).toMatchObject(failedOperationResult('busy'))
		expect(invoked).toBeFalse()

		device.connected = true
		manager.update(device, 'connected')
		expect(arbiter.availability(logicalKey)).toBe('available')

		const retried = coordinator.start('retry', [{ key: logicalKey, device }], () => {
			invoked = true
			return failedOperationResult('unexpectedState')
		})

		expect(await retried.result).toMatchObject(failedOperationResult('unexpectedState'))
		expect(invoked).toBeTrue()

		lifecycle.dispose()
	})

	test('cancels every owner associated with a disconnected device', async () => {
		const manager = new TestDeviceManager<Camera>()
		const arbiter = new ResourceArbiter()
		const coordinator = new OperationCoordinator(arbiter)
		const lifecycle = new DeviceLifecycle(arbiter, coordinator)
		const device = camera()
		const key = resourceKey(device)
		const logicalKey = `logical:guider:local:camera:${key}`

		lifecycle.observe(manager)
		manager.add(device)

		const physical = coordinator.start('capture', [{ key, device }], waitForAbort)
		const logical = coordinator.start('guiderSession', [{ key: logicalKey, device }], waitForAbort)

		device.connected = false
		manager.update(device, 'connected')

		expect(physical.signal.aborted).toBeTrue()
		expect(logical.signal.aborted).toBeTrue()
		expect(await physical.result).toEqual(failedOperationResult('disconnected'))
		expect(await logical.result).toEqual(failedOperationResult('disconnected'))
		expect(arbiter.ownersOfDevice(key)).toEqual([])

		lifecycle.dispose()
	})

	test('keeps reconnecting devices unavailable until they are quiescent', () => {
		const manager = new TestDeviceManager<Camera>()
		const arbiter = new ResourceArbiter()
		const coordinator = new OperationCoordinator(arbiter)
		const lifecycle = new DeviceLifecycle(arbiter, coordinator)
		const device = camera()
		const key = resourceKey(device)

		lifecycle.observe(manager)
		manager.add(device)

		device.connected = false
		manager.update(device, 'connected')
		expect(arbiter.availability(key)).toBe('unavailable')

		device.connected = true
		device.exposuring = true
		device.exposure.state = 'Busy'
		manager.update(device, 'connected')
		expect(arbiter.availability(key)).toBe('unavailable')

		device.exposuring = false
		device.exposure.state = 'Idle'
		manager.update(device, 'exposuring')
		expect(arbiter.availability(key)).toBe('available')

		lifecycle.dispose()
	})

	test('tracks external busy and quiescent state updates', () => {
		const manager = new TestDeviceManager<Camera>()
		const arbiter = new ResourceArbiter()
		const coordinator = new OperationCoordinator(arbiter)
		const lifecycle = new DeviceLifecycle(arbiter, coordinator)
		const device = camera()
		const key = resourceKey(device)

		lifecycle.observe(manager)
		manager.add(device)
		expect(arbiter.availability(key)).toBe('available')

		device.exposuring = true
		device.exposure.state = 'Busy'
		manager.update(device, 'exposuring')
		expect(arbiter.availability(key)).toBe('unavailable')

		device.exposuring = false
		device.exposure.state = 'Idle'
		manager.update(device, 'exposuring')
		expect(arbiter.availability(key)).toBe('available')

		lifecycle.dispose()
	})

	test('cancels the owner with removed before forgetting the device', async () => {
		const manager = new TestDeviceManager<Camera>()
		const arbiter = new ResourceArbiter()
		const coordinator = new OperationCoordinator(arbiter)
		const lifecycle = new DeviceLifecycle(arbiter, coordinator)
		const device = camera()
		const key = resourceKey(device)
		const executorStopped = Promise.withResolvers<void>()

		lifecycle.observe(manager)
		manager.add(device)

		const handle = coordinator.start('capture', [{ key, device }], async (context) => {
			const result = await waitForAbort(context)
			await executorStopped.promise
			return result
		})
		manager.remove(device)

		expect(handle.signal.aborted).toBeTrue()
		expect(arbiter.availability(key)).toBe('unavailable')
		expect(arbiter.ownersOfClient('client-1')).toEqual([])

		executorStopped.resolve()
		expect(await handle.result).toEqual(failedOperationResult('removed'))

		lifecycle.dispose()
	})

	test('cancels an owner of a standalone guide-output resource', async () => {
		const manager = new TestDeviceManager<GuideOutput>()
		const arbiter = new ResourceArbiter()
		const coordinator = new OperationCoordinator(arbiter)
		const lifecycle = new DeviceLifecycle(arbiter, coordinator)
		const device = guideOutput()
		const key = resourceKey(device)

		lifecycle.observe(manager)
		manager.add(device)

		const handle = coordinator.start('guide-output', [{ key, device }], waitForAbort)
		manager.remove(device)

		expect(handle.signal.aborted).toBeTrue()
		expect(arbiter.availability(key)).toBe('unavailable')
		expect(await handle.result).toEqual(failedOperationResult('removed'))

		lifecycle.dispose()
	})

	test('aggregates parent and subdevice busy states under one physical resource', () => {
		const mountManager = new TestDeviceManager<Mount>()
		const guideOutputManager = new TestDeviceManager<GuideOutput>()
		const arbiter = new ResourceArbiter()
		const coordinator = new OperationCoordinator(arbiter)
		const lifecycle = new DeviceLifecycle(arbiter, coordinator)
		const parent = mount()
		const proxy = guideOutputProxy(parent)
		const key = resourceKey(parent)

		lifecycle.observe(mountManager)
		lifecycle.observe(guideOutputManager)
		mountManager.add(parent)
		guideOutputManager.add(proxy)

		expect(resourceKey(proxy)).toBe(key)
		expect(arbiter.availability(key)).toBe('available')

		parent.slewing = true
		mountManager.update(parent, 'slewing')
		expect(arbiter.availability(key)).toBe('unavailable')

		parent.slewing = false
		mountManager.update(parent, 'slewing')
		expect(arbiter.availability(key)).toBe('available')

		proxy.pulsing = true
		guideOutputManager.update(proxy, 'pulsing')
		expect(arbiter.availability(key)).toBe('unavailable')

		proxy.pulsing = false
		guideOutputManager.update(proxy, 'pulsing')
		expect(arbiter.availability(key)).toBe('available')

		lifecycle.dispose()
	})

	test('keeps the verifier of the observer that contributed a view', () => {
		const mountManager = new TestDeviceManager<Mount>()
		const guideOutputManager = new TestDeviceManager<GuideOutput>()
		const arbiter = new ResourceArbiter()
		const coordinator = new OperationCoordinator(arbiter)
		const lifecycle = new DeviceLifecycle(arbiter, coordinator)
		const parent = mount()
		const proxy = guideOutputProxy(parent)
		const key = resourceKey(parent)

		lifecycle.observe(mountManager, { verify: (device) => isDeviceQuiescent(device) && !device.tracking })
		lifecycle.observe(guideOutputManager)
		parent.tracking = true
		mountManager.add(parent)
		guideOutputManager.add(proxy)
		expect(arbiter.availability(key)).toBe('unavailable')

		// The guide output manager also reports the parent behind its proxy, as GuideOutputManager does.
		proxy.pulsing = true
		guideOutputManager.update(proxy, 'pulsing')
		guideOutputManager.update(parent, 'pulsing')
		proxy.pulsing = false
		guideOutputManager.update(proxy, 'pulsing')
		guideOutputManager.update(parent, 'connected')
		expect(arbiter.availability(key)).toBe('unavailable')

		parent.tracking = false
		mountManager.update(parent, 'connected')
		expect(arbiter.availability(key)).toBe('available')

		lifecycle.dispose()
	})

	test('cancels on proxy removal while retaining the parent lifecycle view', async () => {
		const mountManager = new TestDeviceManager<Mount>()
		const guideOutputManager = new TestDeviceManager<GuideOutput>()
		const arbiter = new ResourceArbiter()
		const coordinator = new OperationCoordinator(arbiter)
		const lifecycle = new DeviceLifecycle(arbiter, coordinator)
		const parent = mount()
		const proxy = guideOutputProxy(parent)
		const key = resourceKey(parent)

		lifecycle.observe(mountManager)
		lifecycle.observe(guideOutputManager)
		mountManager.add(parent)
		guideOutputManager.add(proxy)

		const handle = coordinator.start('guide-output', [{ key, device: proxy }], waitForAbort)
		guideOutputManager.remove(proxy)

		expect(handle.signal.aborted).toBeTrue()
		expect(await handle.result).toEqual(failedOperationResult('removed'))
		expect(arbiter.availability(key)).toBe('available')

		parent.slewing = true
		mountManager.update(parent, 'slewing')
		expect(arbiter.availability(key)).toBe('unavailable')

		mountManager.remove(parent)
		expect(arbiter.ownersOfClient(parent.client.id)).toEqual([])

		lifecycle.dispose()
	})

	test('ignores stale subdevice verification after retaining its parent', async () => {
		const mountManager = new TestDeviceManager<Mount>()
		const guideOutputManager = new TestDeviceManager<GuideOutput>()
		const arbiter = new ResourceArbiter()
		const coordinator = new OperationCoordinator(arbiter)
		const lifecycle = new DeviceLifecycle(arbiter, coordinator)
		const verified = Promise.withResolvers<boolean>()
		const parent = mount()
		const proxy = guideOutputProxy(parent)
		const key = resourceKey(parent)

		lifecycle.observe(mountManager)
		lifecycle.observe(guideOutputManager, { verify: () => verified.promise })
		mountManager.add(parent)
		guideOutputManager.add(proxy)
		expect(arbiter.availability(key)).toBe('unavailable')

		guideOutputManager.remove(proxy)
		expect(arbiter.availability(key)).toBe('available')

		verified.resolve(false)
		await verified.promise
		await Promise.resolve()

		expect(arbiter.availability(key)).toBe('available')

		lifecycle.dispose()
	})

	test('ignores stale asynchronous verification after removal', async () => {
		const manager = new TestDeviceManager<Camera>()
		const arbiter = new ResourceArbiter()
		const coordinator = new OperationCoordinator(arbiter)
		const lifecycle = new DeviceLifecycle(arbiter, coordinator)
		const verified = Promise.withResolvers<boolean>()
		const device = camera()
		const key = resourceKey(device)

		lifecycle.observe(manager, { verify: () => verified.promise })
		manager.add(device)
		manager.remove(device)
		verified.resolve(true)
		await verified.promise
		await Promise.resolve()

		expect(arbiter.availability(key)).toBe('unavailable')

		lifecycle.dispose()
	})

	test('discards an older asynchronous verdict after a newer validation', async () => {
		const manager = new TestDeviceManager<Camera>()
		const arbiter = new ResourceArbiter()
		const coordinator = new OperationCoordinator(arbiter)
		const lifecycle = new DeviceLifecycle(arbiter, coordinator)
		const checks: PromiseWithResolvers<boolean>[] = []
		const device = camera()
		const key = resourceKey(device)

		lifecycle.observe(manager, {
			verify: () => {
				const check = Promise.withResolvers<boolean>()
				checks.push(check)
				return check.promise
			},
		})
		manager.add(device)
		expect(checks).toHaveLength(1)

		device.exposuring = true
		manager.update(device, 'exposuring')
		expect(checks).toHaveLength(2)

		checks[1].resolve(false)
		await flushMicrotasks()
		expect(arbiter.availability(key)).toBe('unavailable')

		checks[0].resolve(true)
		await flushMicrotasks()
		expect(arbiter.availability(key)).toBe('unavailable')

		device.exposuring = false
		manager.update(device, 'exposuring')
		expect(checks).toHaveLength(3)

		checks[2].resolve(true)
		await flushMicrotasks()
		expect(arbiter.availability(key)).toBe('available')

		lifecycle.dispose()
	})

	test('requires every live physical view to pass asynchronous verification', async () => {
		const mountManager = new TestDeviceManager<Mount>()
		const guideOutputManager = new TestDeviceManager<GuideOutput>()
		const arbiter = new ResourceArbiter()
		const coordinator = new OperationCoordinator(arbiter)
		const lifecycle = new DeviceLifecycle(arbiter, coordinator)
		const checks: PromiseWithResolvers<boolean>[] = []
		const parent = mount()
		const proxy = guideOutputProxy(parent)
		const key = resourceKey(parent)

		lifecycle.observe(mountManager)
		lifecycle.observe(guideOutputManager, {
			verify: () => {
				const check = Promise.withResolvers<boolean>()
				checks.push(check)
				return check.promise
			},
		})
		mountManager.add(parent)
		guideOutputManager.add(proxy)

		expect(checks).toHaveLength(1)
		expect(arbiter.availability(key)).toBe('unavailable')

		checks[0].resolve(true)
		await flushMicrotasks()
		expect(arbiter.availability(key)).toBe('available')

		proxy.pulsing = true
		guideOutputManager.update(proxy, 'pulsing')
		expect(checks).toHaveLength(2)

		checks[1].resolve(false)
		await flushMicrotasks()
		expect(arbiter.availability(key)).toBe('unavailable')

		lifecycle.dispose()
	})

	test('observes devices already present when registration begins', () => {
		const manager = new TestDeviceManager<Camera>()
		const arbiter = new ResourceArbiter()
		const coordinator = new OperationCoordinator(arbiter)
		const lifecycle = new DeviceLifecycle(arbiter, coordinator)
		const device = camera()
		const key = resourceKey(device)

		manager.add(device)
		lifecycle.observe(manager)

		expect(arbiter.availability(key)).toBe('available')

		device.exposuring = true
		manager.update(device, 'exposuring')
		expect(arbiter.availability(key)).toBe('unavailable')

		lifecycle.dispose()
	})

	test('stops observing a manager through its own registration', () => {
		const manager = new TestDeviceManager<Camera>()
		const arbiter = new ResourceArbiter()
		const coordinator = new OperationCoordinator(arbiter)
		const lifecycle = new DeviceLifecycle(arbiter, coordinator)
		const device = camera()
		const key = resourceKey(device)

		const stop = lifecycle.observe(manager)
		manager.add(device)
		expect(arbiter.availability(key)).toBe('available')

		stop()
		stop()

		// The unobserved device is blocked, and a quiescent update no longer revalidates it.
		expect(arbiter.availability(key)).toBe('unavailable')

		manager.update(device, 'exposuring')

		expect(arbiter.availability(key)).toBe('unavailable')

		lifecycle.dispose()
	})

	test('forgets device views when the lifecycle is disposed', () => {
		const arbiter = new ResourceArbiter()
		const coordinator = new OperationCoordinator(arbiter)
		const lifecycle = new DeviceLifecycle(arbiter, coordinator)
		const stale = camera()
		const key = resourceKey(stale)
		const manager = new TestDeviceManager<Camera>()

		lifecycle.observe(manager)
		manager.add(stale)
		stale.exposuring = true
		stale.exposure.state = 'Busy'
		manager.update(stale, 'exposuring')
		expect(arbiter.availability(key)).toBe('unavailable')

		lifecycle.dispose()

		// A later observation of a quiescent instance must not aggregate the busy view left behind.
		const replacement = camera()
		const next = new TestDeviceManager<Camera>()

		lifecycle.observe(next)
		next.add(replacement)

		expect(arbiter.availability(key)).toBe('available')

		lifecycle.dispose()
	})

	test('forgets only the views of a disposed observer', () => {
		const mountManager = new TestDeviceManager<Mount>()
		const guideOutputManager = new TestDeviceManager<GuideOutput>()
		const arbiter = new ResourceArbiter()
		const coordinator = new OperationCoordinator(arbiter)
		const lifecycle = new DeviceLifecycle(arbiter, coordinator)
		const parent = mount()
		const proxy = guideOutputProxy(parent)
		const key = resourceKey(parent)

		const disposeMount = lifecycle.observe(mountManager)
		const disposeGuideOutput = lifecycle.observe(guideOutputManager)
		mountManager.add(parent)
		guideOutputManager.add(proxy)
		parent.slewing = true
		mountManager.update(parent, 'slewing')
		expect(arbiter.availability(key)).toBe('unavailable')

		// The busy mount view leaves with its observer; the guide output view alone is quiescent.
		disposeMount()
		expect(arbiter.availability(key)).toBe('available')

		// Without any observer left, nothing would cancel owners on disconnect, so the device is blocked.
		disposeGuideOutput()
		expect(arbiter.availability(key)).toBe('unavailable')

		lifecycle.dispose()
	})

	test('does not cancel running owners when an observer is disposed', async () => {
		const manager = new TestDeviceManager<Camera>()
		const arbiter = new ResourceArbiter()
		const coordinator = new OperationCoordinator(arbiter)
		const lifecycle = new DeviceLifecycle(arbiter, coordinator)
		const device = camera()
		const key = resourceKey(device)

		const dispose = lifecycle.observe(manager)
		manager.add(device)

		const handle = coordinator.start('capture', [{ key, device }], waitForAbort)

		dispose()

		expect(handle.signal.aborted).toBeFalse()
		expect(arbiter.availability(key)).toBe('unavailable')

		await handle.cancel()
		lifecycle.dispose()
	})

	test('ignores asynchronous verification started before disposal', async () => {
		const arbiter = new ResourceArbiter()
		const coordinator = new OperationCoordinator(arbiter)
		const lifecycle = new DeviceLifecycle(arbiter, coordinator)
		const stale = Promise.withResolvers<boolean>()
		const fresh = Promise.withResolvers<boolean>()
		const device = camera()
		const key = resourceKey(device)
		const first = new TestDeviceManager<Camera>()

		lifecycle.observe(first, { verify: () => stale.promise })
		first.add(device)
		lifecycle.dispose()

		const second = new TestDeviceManager<Camera>()
		lifecycle.observe(second, { verify: () => fresh.promise })
		second.add(device)

		// A verification of the first registration must not decide the availability of the second one.
		stale.resolve(true)
		await flushMicrotasks()
		expect(arbiter.availability(key)).toBe('unavailable')

		fresh.resolve(true)
		await flushMicrotasks()
		expect(arbiter.availability(key)).toBe('available')

		lifecycle.dispose()
	})

	test('skips verification for updates that cannot change quiescence', async () => {
		const manager = new TestDeviceManager<Camera>()
		const arbiter = new ResourceArbiter()
		const coordinator = new OperationCoordinator(arbiter)
		const lifecycle = new DeviceLifecycle(arbiter, coordinator)
		const verified = Promise.withResolvers<boolean>()
		const device = camera()
		const key = resourceKey(device)
		let checks = 0

		lifecycle.observe(manager, {
			verify: () => {
				checks++
				return verified.promise
			},
		})
		manager.add(device)
		expect(checks).toBe(1)

		manager.update(device, 'temperature')
		manager.update(device, 'coolerPower')
		expect(checks).toBe(1)

		// The in-flight verification survives unrelated traffic and still applies its verdict.
		verified.resolve(true)
		await verified.promise
		await Bun.sleep(1)
		expect(arbiter.availability(key)).toBe('available')

		manager.update(device, 'exposuring')
		expect(checks).toBe(2)

		lifecycle.dispose()
	})

	test('reports a verifier that cannot decide and keeps the device blocked', async () => {
		const manager = new TestDeviceManager<Camera>()
		const arbiter = new ResourceArbiter()
		const coordinator = new OperationCoordinator(arbiter)
		const lifecycle = new DeviceLifecycle(arbiter, coordinator)
		const error = spyOn(console, 'error').mockImplementation(() => {})
		const device = camera()
		const key = resourceKey(device)

		try {
			lifecycle.observe(manager, {
				verify: () => {
					throw new Error('cannot read device state')
				},
			})
			manager.add(device)

			expect(arbiter.availability(key)).toBe('unavailable')
			expect(error).toHaveBeenCalled()

			error.mockClear()
			lifecycle.observe(manager, { verify: () => Promise.reject(new Error('transport lost')) })
			manager.add(device)
			await Bun.sleep(1)

			expect(arbiter.availability(key)).toBe('unavailable')
			expect(error).toHaveBeenCalled()
		} finally {
			error.mockRestore()
			lifecycle.dispose()
		}
	})

	test('keeps a dome unavailable until its shutter stops', () => {
		const manager = new DomeManager()
		const arbiter = new ResourceArbiter()
		const coordinator = new OperationCoordinator(arbiter)
		const lifecycle = new DeviceLifecycle(arbiter, coordinator)
		const device = dome()
		const key = resourceKey(device)
		Object.defineProperty(device, CLIENT, { value: client })
		manager.add(device)

		const motion: DefSwitchVector = { device: device.name, name: 'DOME_MOTION', permission: 'rw', rule: 'OneOfMany', state: 'Busy', elements: { DOME_CW: defSwitch('DOME_CW', true), DOME_CCW: defSwitch('DOME_CCW', false) } }
		const shutter: DefSwitchVector = { device: device.name, name: 'DOME_SHUTTER', permission: 'rw', rule: 'OneOfMany', state: 'Busy', elements: { SHUTTER_OPEN: defSwitch('SHUTTER_OPEN', true), SHUTTER_CLOSE: defSwitch('SHUTTER_CLOSE', false) } }

		lifecycle.observe(manager)
		expect(arbiter.availability(key)).toBe('available')

		manager.switchVector(client, motion, 'defSwitchVector')
		manager.switchVector(client, shutter, 'defSwitchVector')
		expect(arbiter.availability(key)).toBe('unavailable')

		// The rotation ends while the shutter is still opening.
		manager.switchVector(client, { ...motion, state: 'Ok', elements: { DOME_CW: defSwitch('DOME_CW', false), DOME_CCW: defSwitch('DOME_CCW', false) } }, 'setSwitchVector')
		expect(device.shutterState).toBe('OPENING')
		expect(arbiter.availability(key)).toBe('unavailable')

		manager.switchVector(client, { ...shutter, state: 'Ok' }, 'setSwitchVector')
		expect(device.shutterState).toBe('OPEN')
		expect(arbiter.availability(key)).toBe('available')

		manager.switchVector(client, { ...shutter, elements: { SHUTTER_OPEN: defSwitch('SHUTTER_OPEN', false), SHUTTER_CLOSE: defSwitch('SHUTTER_CLOSE', true) } }, 'setSwitchVector')
		expect(device.shutterState).toBe('CLOSING')
		expect(arbiter.availability(key)).toBe('unavailable')

		lifecycle.dispose()
	})

	test('treats a slewing dome as busy', () => {
		const device = dome()
		expect(isDeviceQuiescent(device)).toBeTrue()

		device.slewing = true
		expect(isDeviceQuiescent(device)).toBeFalse()
	})

	test('treats a parking cover as busy', () => {
		const device = cover()

		device.parking = true
		expect(isDeviceQuiescent(device)).toBeFalse()

		device.parking = false
		expect(isDeviceQuiescent(device)).toBeTrue()
	})

	test('treats every mount motion state as busy', () => {
		const device = mount()

		device.slewing = true
		expect(isDeviceQuiescent(device)).toBeFalse()
		device.slewing = false

		device.moving = true
		expect(isDeviceQuiescent(device)).toBeFalse()
		device.moving = false

		device.homing = true
		expect(isDeviceQuiescent(device)).toBeFalse()
		device.homing = false

		device.parking = true
		expect(isDeviceQuiescent(device)).toBeFalse()
		device.parking = false

		device.pulsing = true
		expect(isDeviceQuiescent(device)).toBeFalse()
	})
})
