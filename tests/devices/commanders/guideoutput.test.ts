import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { GUIDE_PULSE_ACK_MARGIN, GUIDE_PULSE_STOP_SETTLE_TIMEOUT, GuideOutputCommander, guidePulseReleaseBound, guidePulseWindow } from '../../../src/devices/commanders/guideoutput'
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
const guideOutputCommander = new GuideOutputCommander(guideOutputManager, resourceArbiter)
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
	// A pulse of an earlier test may still be running in the simulator across the reconnection.
	await waitUntil(() => camera.connected && camera.canPulseGuide && !camera.pulsing)
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
	// The driver refuses the north leg and honors the zero that stops the east one.
	const pulse = spyOn(guideOutputManager, 'pulse').mockImplementation((device, direction, duration) => {
		if (direction === 'NORTH' && duration > 0) guideVector(camera, 'TELESCOPE_TIMED_GUIDE_NS', 'Alert')
		else if (direction === 'EAST' && duration > 0) guideVector(camera, 'TELESCOPE_TIMED_GUIDE_WE', 'Busy')
		else if ((direction === 'EAST' || direction === 'WEST') && duration === 0 && camera.pulsingWE) guideVector(camera, 'TELESCOPE_TIMED_GUIDE_WE', 'Ok')
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
	const commander = new GuideOutputCommander(guideOutputManager, resourceArbiter)
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
			using commander = new GuideOutputCommander(guideOutputManager, resourceArbiter)
			scoped = commander
		}

		expect(removeHandler).toHaveBeenCalledWith(scoped)
	} finally {
		removeHandler.mockRestore()
	}
})

// The guide output view the manager registered for the camera.
function getView() {
	const view = guideOutputManager.get(client, simulator.name)
	expect(view).toBeDefined()
	return view!
}

// Stands in for a driver that publishes nothing on its own: pulses are only recorded, and the test publishes
// the timed-guide states itself.
function silentDriver() {
	const pulses: [string, number][] = []
	const spy = spyOn(guideOutputManager, 'pulse').mockImplementation((_, direction, duration) => {
		pulses.push([direction, duration])
	})
	return { pulses, spy } as const
}

function causesOf(camera: Camera) {
	return resourceArbiter.snapshot(resourceKey(camera)).causes
}

describe('pulse window', () => {
	test('derives every window from the dispatch, the duration and the acknowledgement margin', () => {
		expect(GUIDE_PULSE_ACK_MARGIN).toBe(250)
		expect(GUIDE_PULSE_STOP_SETTLE_TIMEOUT).toBe(15000)
		expect(guidePulseWindow(0, 2000)).toEqual({ busyAckDeadline: 2250, endsBy: 4500 })
		expect(guidePulseWindow(1000, 1)).toEqual({ busyAckDeadline: 1251, endsBy: 1502 })
		expect(guidePulseWindow(10, 0)).toEqual({ busyAckDeadline: 260, endsBy: 510 })
		expect(guidePulseReleaseBound(2500)).toBe(20500)
		expect(guidePulseReleaseBound(1)).toBe(2 + 500 + 15000)
	})
})

describe('dispatched pulse evidence', () => {
	test('resolves a leg without Busy only after the Busy deadline', async () => {
		const camera = await connected()
		const driver = silentDriver()

		try {
			const started = performance.now()
			expect(await guideOutputCommander.pulse(operationCoordinator, camera, 'NORTH', 200, { settleTimeout: 0 })).toEqual(successfulOperationResult(undefined))
			// A Busy could still begin until the pulse plus the margin, so nothing earlier proves it ended.
			expect(performance.now() - started).toBeGreaterThanOrEqual(200 + GUIDE_PULSE_ACK_MARGIN - 5)
			expect(guideOutputCommander.dispatchedPulseWindow(camera)).toBeUndefined()
			expect(causesOf(camera)).not.toContain('guidePulse')
		} finally {
			driver.spy.mockRestore()
		}
	})

	test('waits for the Idle of a Busy that arrives after the nominal end of the pulse', async () => {
		const camera = await connected()
		const driver = silentDriver()
		const timers = [setTimeout(() => guideVector(camera, 'TELESCOPE_TIMED_GUIDE_NS', 'Busy'), 300), setTimeout(() => guideVector(camera, 'TELESCOPE_TIMED_GUIDE_NS', 'Ok'), 600)]

		try {
			const started = performance.now()
			expect(await guideOutputCommander.pulse(operationCoordinator, camera, 'NORTH', 200, { settleTimeout: 0 })).toEqual(successfulOperationResult(undefined))
			expect(performance.now() - started).toBeGreaterThanOrEqual(595)
			expect(camera.pulsingNS).toBeFalse()
			await waitUntil(() => isFree(camera))
		} finally {
			for (const timer of timers) clearTimeout(timer)
			driver.spy.mockRestore()
		}
	})

	test('does not declare a standstill before the observation window a stop asks for', async () => {
		const camera = await connected()
		const started = performance.now()

		expect(await guideOutputCommander.stopPulses(camera, ['NORTH'], { busyAckDeadline: started + 200, settleTimeout: 1000 })).toEqual(successfulOperationResult(undefined))
		expect(performance.now() - started).toBeGreaterThanOrEqual(195)
	})

	test('concludes each leg of asymmetric axes on its own flag', async () => {
		const camera = await connected()
		const driver = silentDriver()
		const ends: Record<string, number> = {}
		const timers: Timer[] = []
		const updated = spyOn(guideOutputCommander, 'updated')

		driver.spy.mockImplementation((_, direction, duration) => {
			if (duration <= 0) return
			const vector = direction === 'NORTH' || direction === 'SOUTH' ? 'TELESCOPE_TIMED_GUIDE_NS' : 'TELESCOPE_TIMED_GUIDE_WE'
			guideVector(camera, vector, 'Busy')
			timers.push(
				setTimeout(() => {
					ends[direction] = performance.now()
					guideVector(camera, vector, 'Ok')
				}, duration),
			)
		})

		try {
			const started = performance.now()
			const result = await guideOutputCommander.pulseAxes(
				operationCoordinator,
				camera,
				[
					{ direction: 'WEST', duration: 100 },
					{ direction: 'NORTH', duration: 600 },
				],
				{ settleTimeout: 0 },
			)

			expect(result).toEqual(successfulOperationResult(undefined))
			expect(ends.WEST - started).toBeLessThan(400)
			expect(ends.NORTH - started).toBeGreaterThanOrEqual(595)
			expect(camera.pulsingNS || camera.pulsingWE || camera.pulsing).toBeFalse()
		} finally {
			for (const timer of timers) clearTimeout(timer)
			updated.mockRestore()
			driver.spy.mockRestore()
		}
	})

	test('gives a short leg the window of the longest one when a bridge mirrors one flag on both axes', async () => {
		const camera = await connected()
		const driver = silentDriver()
		const timers: Timer[] = []

		driver.spy.mockImplementation((_, __, duration) => {
			if (duration <= 0) return
			// Like the Alpaca bridge, a single IsPulseGuiding is mirrored on both vectors.
			guideVector(camera, 'TELESCOPE_TIMED_GUIDE_NS', 'Busy')
			guideVector(camera, 'TELESCOPE_TIMED_GUIDE_WE', 'Busy')

			if (duration >= 600) {
				timers.push(
					setTimeout(() => {
						guideVector(camera, 'TELESCOPE_TIMED_GUIDE_NS', 'Ok')
						guideVector(camera, 'TELESCOPE_TIMED_GUIDE_WE', 'Ok')
					}, duration),
				)
			}
		})

		try {
			const result = await guideOutputCommander.pulseAxes(
				operationCoordinator,
				camera,
				[
					{ direction: 'EAST', duration: 50 },
					{ direction: 'SOUTH', duration: 600 },
				],
				{ settleTimeout: 0 },
			)

			expect(result).toEqual(successfulOperationResult(undefined))
			expect(camera.pulsing).toBeFalse()
		} finally {
			for (const timer of timers) clearTimeout(timer)
			driver.spy.mockRestore()
		}
	})

	test('keeps the evidence of a pulse whose end a disconnect hid, and blocks the key', async () => {
		const camera = await connected()
		const driver = silentDriver()
		let dispatchedAt = Number.NaN
		driver.spy.mockImplementation((_, __, duration) => {
			if (duration > 0) dispatchedAt = performance.now()
		})

		try {
			const pulsing = guideOutputCommander.pulse(operationCoordinator, camera, 'WEST', 1000, { settleTimeout: 0 })
			await waitUntil(() => !Number.isNaN(dispatchedAt), 5000, 5)
			cameraManager.disconnect(camera)

			const result = await pulsing
			expect(result).toMatchObject(failedOperationResult('disconnected'))

			const window = guideOutputCommander.dispatchedPulseWindow(camera)
			expect(window).toBeDefined()
			expect(window!.busyAckDeadline).toBeCloseTo(guidePulseWindow(dispatchedAt, 1000).busyAckDeadline, 0)
			expect(window!.endsBy).toBeCloseTo(guidePulseWindow(dispatchedAt, 1000).endsBy, 0)
			expect(causesOf(camera)).toContain('guidePulse')
			// The lease was released all the same.
			expect(resourceArbiter.ownersOf(resourceKey(camera))).toBeEmpty()
		} finally {
			driver.spy.mockRestore()
		}

		// Reconnecting republishes both axes stopped, which ends the evidence once the Busy deadline passed.
		await connected()
		await waitUntil(() => guideOutputCommander.dispatchedPulseWindow(camera) === undefined, 5000, 10)
		expect(causesOf(camera)).not.toContain('guidePulse')
		await waitUntil(() => isFree(camera))
	})

	test('ends the evidence only through continuous observation by a registered view', async () => {
		const camera = await connected()
		const view = getView()
		const driver = silentDriver()

		try {
			// Forgetting the view breaks the continuity the connection published.
			guideOutputCommander.removed(view)
			guideOutputCommander.added(view)

			const window = guideOutputCommander.assumeDispatchedPulse(camera, 50)
			await waitUntil(() => performance.now() > window.busyAckDeadline + 20, 5000, 10)

			// Past the deadline, but nothing was published since: the frozen flags prove nothing.
			expect(camera.pulsing).toBeFalse()
			expect(guideOutputCommander.dispatchedPulseWindow(camera)).toBeDefined()

			// Notifications without a state, such as a reset or a guide rate, are not evidence either.
			guideOutputCommander.updated(view, 'pulsingNS')
			guideOutputCommander.updated(view, 'guideRate', 'Ok')
			expect(guideOutputCommander.dispatchedPulseWindow(camera)).toBeDefined()

			// One axis stopped does not prove the other.
			guideVector(camera, 'TELESCOPE_TIMED_GUIDE_NS', 'Idle')
			expect(guideOutputCommander.dispatchedPulseWindow(camera)).toBeDefined()

			guideVector(camera, 'TELESCOPE_TIMED_GUIDE_WE', 'Idle')
			expect(guideOutputCommander.dispatchedPulseWindow(camera)).toBeUndefined()
			expect(causesOf(camera)).not.toContain('guidePulse')
		} finally {
			driver.spy.mockRestore()
		}
	})

	test('keeps the evidence while an axis of the key was last published Busy', async () => {
		const camera = await connected()
		const driver = silentDriver()

		try {
			const window = guideOutputCommander.assumeDispatchedPulse(camera, 50)
			guideVector(camera, 'TELESCOPE_TIMED_GUIDE_WE', 'Busy')
			await waitUntil(() => performance.now() > window.busyAckDeadline + 20, 5000, 10)
			expect(guideOutputCommander.dispatchedPulseWindow(camera)).toBeDefined()

			guideVector(camera, 'TELESCOPE_TIMED_GUIDE_WE', 'Ok')
			expect(guideOutputCommander.dispatchedPulseWindow(camera)).toBeUndefined()
		} finally {
			driver.spy.mockRestore()
		}
	})

	test('ignores the notifications of an unregistered view and of a stopped state followed by a disconnect', async () => {
		const camera = await connected()
		const view = getView()
		const driver = silentDriver()

		try {
			guideOutputCommander.removed(view)
			const window = guideOutputCommander.assumeDispatchedPulse(camera, 50)
			guideVector(camera, 'TELESCOPE_TIMED_GUIDE_NS', 'Idle')
			guideVector(camera, 'TELESCOPE_TIMED_GUIDE_WE', 'Idle')
			await waitUntil(() => performance.now() > window.busyAckDeadline + 20, 5000, 10)
			expect(guideOutputCommander.dispatchedPulseWindow(camera)).toBeDefined()

			guideOutputCommander.added(view)
			guideVector(camera, 'TELESCOPE_TIMED_GUIDE_NS', 'Idle')
			guideVector(camera, 'TELESCOPE_TIMED_GUIDE_WE', 'Idle')
			expect(guideOutputCommander.dispatchedPulseWindow(camera)).toBeUndefined()

			// Stopped states published before a disconnect say nothing about the time after it.
			const second = guideOutputCommander.assumeDispatchedPulse(camera, 50)
			guideVector(camera, 'TELESCOPE_TIMED_GUIDE_NS', 'Idle')
			guideVector(camera, 'TELESCOPE_TIMED_GUIDE_WE', 'Idle')
			view.connected = false
			guideOutputCommander.updated(view, 'connected')
			view.connected = true
			await waitUntil(() => performance.now() > second.busyAckDeadline + 20, 5000, 10)
			expect(guideOutputCommander.dispatchedPulseWindow(camera)).toBeDefined()
		} finally {
			driver.spy.mockRestore()
			guideVector(camera, 'TELESCOPE_TIMED_GUIDE_NS', 'Idle')
			guideVector(camera, 'TELESCOPE_TIMED_GUIDE_WE', 'Idle')
		}
	})

	test('requires every axis a diagonal nudge dispatched', async () => {
		const camera = await connected()
		const driver = silentDriver()

		try {
			// The cleanup of a silent driver has nothing to observe beyond the stopped states of the connection.
			guideOutputCommander.removed(getView())
			guideOutputCommander.added(getView())

			const pulsing = guideOutputCommander.pulseAxes(
				operationCoordinator,
				camera,
				[
					{ direction: 'NORTH', duration: 20 },
					{ direction: 'EAST', duration: 20 },
				],
				{ settleTimeout: 0 },
			)

			await waitUntil(() => guideOutputCommander.dispatchedPulseWindow(camera) !== undefined, 5000, 5)
			guideVector(camera, 'TELESCOPE_TIMED_GUIDE_NS', 'Idle')
			await waitUntil(() => performance.now() > guideOutputCommander.dispatchedPulseWindow(camera)!.busyAckDeadline + 20, 5000, 10)
			expect(guideOutputCommander.dispatchedPulseWindow(camera)).toBeDefined()

			guideVector(camera, 'TELESCOPE_TIMED_GUIDE_WE', 'Idle')
			expect(await pulsing).toEqual(successfulOperationResult(undefined))
			expect(guideOutputCommander.dispatchedPulseWindow(camera)).toBeUndefined()
		} finally {
			driver.spy.mockRestore()
		}
	})

	test('records a barrier for pulses of a previous runtime without commanding anything', async () => {
		const camera = await connected()
		const pulse = spyOn(guideOutputManager, 'pulse')
		const ask = spyOn(guideOutputManager, 'ask')

		try {
			const before = performance.now()
			const window = guideOutputCommander.assumeDispatchedPulse(camera, 100)
			const after = performance.now()

			expect(window.busyAckDeadline).toBeGreaterThanOrEqual(guidePulseWindow(before, 100).busyAckDeadline)
			expect(window.busyAckDeadline).toBeLessThanOrEqual(guidePulseWindow(after, 100).busyAckDeadline)
			expect(window.endsBy - window.busyAckDeadline).toBe(100 + GUIDE_PULSE_ACK_MARGIN)
			expect(causesOf(camera)).toContain('guidePulse')
			expect(ask).toHaveBeenCalledWith(camera, 'TELESCOPE_TIMED_GUIDE_NS')
			expect(ask).toHaveBeenCalledWith(camera, 'TELESCOPE_TIMED_GUIDE_WE')
			expect(pulse).not.toHaveBeenCalled()

			// The driver republishes both axes stopped and no Busy comes, so the barrier ends at its deadline.
			await waitUntil(() => guideOutputCommander.dispatchedPulseWindow(camera) === undefined, 5000, 10)
			expect(performance.now()).toBeGreaterThanOrEqual(window.busyAckDeadline - 1)
			expect(causesOf(camera)).not.toContain('guidePulse')
		} finally {
			pulse.mockRestore()
			ask.mockRestore()
		}
	})

	test('dispatches pulses synchronously under the owning operation and waits for their end before releasing it', async () => {
		const camera = await connected()
		const windows: (ReturnType<typeof guideOutputCommander.dispatch> | undefined)[] = []

		const result = await operationCoordinator.start('guiding', [{ key: resourceKey(camera), device: camera }], (context) => {
			const dispatchedAt = performance.now()
			windows.push(guideOutputCommander.dispatch(context, camera, 'NORTH', 200))
			windows.push(guideOutputCommander.dispatch(context, camera, 'WEST', 100))
			expect(windows[0]!.busyAckDeadline).toBeCloseTo(guidePulseWindow(dispatchedAt, 200).busyAckDeadline, 0)
			expect(guideOutputCommander.dispatchedPulseWindow(camera)).toEqual({ busyAckDeadline: windows[0]!.busyAckDeadline, endsBy: windows[0]!.endsBy })
			return successfulOperationResult(undefined)
		}).result

		expect(result).toMatchObject({ ok: true })
		expect(windows.every((window) => window !== undefined)).toBeTrue()
		// The cleanup registered by the first dispatch held the lease until the end of both pulses was observed.
		expect(guideOutputCommander.dispatchedPulseWindow(camera)).toBeUndefined()
		expect(camera.pulsing).toBeFalse()
		expect(causesOf(camera)).not.toContain('guidePulse')
		await waitUntil(() => isFree(camera))
	})

	test('refuses to dispatch for an operation that does not own the device or is being canceled', async () => {
		const camera = await connected()
		const driver = silentDriver()

		try {
			const unrelated = await operationCoordinator.start('other', [], (context) => successfulOperationResult(guideOutputCommander.dispatch(context, camera, 'NORTH', 100))).result
			expect(unrelated).toMatchObject({ ok: true, value: undefined })

			let refused: unknown = 'not attempted'
			const holder = operationCoordinator.start('guiding', [{ key: resourceKey(camera), device: camera }], async (context) => {
				await new Promise((resolve) => {
					context.signal.addEventListener('abort', resolve, { once: true })
				})
				refused = guideOutputCommander.dispatch(context, camera, 'NORTH', 100)
				return failedOperationResult('aborted')
			})

			await holder.cancel()
			expect(refused).toBeUndefined()
			expect(driver.pulses).toBeEmpty()
			expect(guideOutputCommander.dispatchedPulseWindow(camera)).toBeUndefined()
		} finally {
			driver.spy.mockRestore()
		}
	})

	test('blocks the key when the end of a dispatched pulse is unobserved as its operation ends', async () => {
		const camera = await connected()
		const driver = silentDriver()

		try {
			const result = await operationCoordinator.start('guiding', [{ key: resourceKey(camera), device: camera }], (context) => {
				expect(guideOutputCommander.dispatch(context, camera, 'EAST', 1000)).toBeDefined()
				cameraManager.disconnect(camera)
				return successfulOperationResult(undefined)
			}).result

			expect(result.ok).toBeFalse()
			expect(guideOutputCommander.dispatchedPulseWindow(camera)).toBeDefined()
			expect(causesOf(camera)).toContain('guidePulse')
			expect(resourceArbiter.ownersOf(resourceKey(camera))).toBeEmpty()
		} finally {
			driver.spy.mockRestore()
		}

		await connected()
		await waitUntil(() => guideOutputCommander.dispatchedPulseWindow(camera) === undefined, 5000, 10)
		expect(causesOf(camera)).not.toContain('guidePulse')
	})

	test('keeps the guidePulse cause independent from the other causes and lifts only its own on dispose', async () => {
		const camera = await connected()
		const key = resourceKey(camera)
		const commander = new GuideOutputCommander(guideOutputManager, resourceArbiter)

		try {
			commander.assumeDispatchedPulse(camera, 60000)
			resourceArbiter.markUnavailable(key, 'quarantine')
			expect(causesOf(camera)).toEqual(['guidePulse', 'quarantine'])

			// Lifecycle revalidation only clears its own cause.
			resourceArbiter.markDeviceAvailable(key)
			resourceArbiter.markAvailable(key)
			expect(causesOf(camera)).toEqual(['guidePulse', 'quarantine'])

			commander.dispose()
			expect(causesOf(camera)).toEqual(['quarantine'])
		} finally {
			commander.dispose()
			resourceArbiter.markAvailable(key, 'quarantine')
		}
	})
})
