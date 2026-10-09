import { afterAll, describe, expect, test } from 'bun:test'
import { IndiClientHandlerSet } from '../../../src/devices/indi/client'
import type { Camera } from '../../../src/devices/indi/device'
import { CameraManager } from '../../../src/devices/indi/manager/camera'
import type { DeviceHandler } from '../../../src/devices/indi/manager/device'
import { CameraSimulator } from '../../../src/devices/indi/simulator/camera'
import { ClientSimulator } from '../../../src/devices/indi/simulator/client'
import { CameraCaptureReporter, type CameraCaptureReporterOptions, type CameraExposureTransition } from '../../../src/devices/runners/camera.capture.reporter'
import type { CameraCaptureEvent } from '../../../src/devices/runners/camera.capture.types'
import { waitUntil } from '../../util'

const cameraManager = new CameraManager()
const client = new ClientSimulator('Client Simulator', new IndiClientHandlerSet([cameraManager]))
const simulator = new CameraSimulator('Camera Simulator', client)

afterAll(() => {
	simulator.dispose()
})

function getCamera() {
	const camera = cameraManager.get(client, simulator.name)
	expect(camera).toBeDefined()
	return camera!
}

function createHarness(options: Partial<CameraCaptureReporterOptions> = {}) {
	const camera = getCamera()
	const events: CameraCaptureEvent[] = []
	const paths: (string | undefined)[] = []
	const reporter = new CameraCaptureReporter({
		operation: 'operation-id',
		camera,
		listener: (event, path) => {
			events.push(event)
			paths.push(path)
		},
		loop: false,
		count: 2,
		frameExposureTime: 1_000_000,
		totalExposureTime: 2_000_000,
		...options,
	})

	// Exposure remaining time, in seconds, as the driver reports it on the camera model.
	function exposing(remainingTime: number) {
		camera.exposure.value = remainingTime
		return reporter.applyExposureUpdate('Busy')
	}

	return { camera, events, paths, reporter, exposing }
}

describe('initial state', () => {
	test('seeds the snapshot from the requested capture', () => {
		const { camera, reporter, events, exposing } = createHarness()

		expect(reporter.generation).toBe(0)
		expect(reporter.remainingCount).toBe(2)
		expect(reporter.frameExposureTime).toBe(1_000_000)
		expect(reporter.session).not.toBeEmpty()
		expect(events).toBeEmpty()

		reporter.beginFrame()
		exposing(1)

		expect(events[0].operation).toBe('operation-id')
		expect(events[0].camera).toBe(camera.id)
		expect(events[0].session).toBe(reporter.session)
	})

	test('gives every reporter its own session', () => {
		expect(createHarness().reporter.session).not.toBe(createHarness().reporter.session)
	})

	test('leaves the aggregate exposure undefined for a loop', () => {
		const { reporter, events } = createHarness({ loop: true, count: Number.MAX_SAFE_INTEGER, totalExposureTime: 2_000_000 })

		reporter.beginFrame()

		expect(events[0].loop).toBeTrue()
		expect(events[0].totalExposureTime).toBe(0)
		expect(events[0].totalProgress.remainingTime).toBe(0)
		expect(events[0].totalProgress.progress).toBe(0)
	})
})

describe('exposure updates', () => {
	test('opens a generation and reports its progress', () => {
		const { reporter, events, exposing } = createHarness()

		expect(reporter.beginFrame()).toBe(1)
		expect(events[0].state).toBe('exposureStarted')
		expect(events[0].generation).toBe(1)
		expect(events[0].elapsedCount).toBe(1)
		expect(events[0].remainingCount).toBe(1)
		expect(events[0].frameProgress.remainingTime).toBe(1_000_000)

		expect(exposing(0.75)).toBe('started')
		expect(events[1].state).toBe('exposing')
		expect(events[1].frameProgress.remainingTime).toBe(750_000)
		expect(events[1].frameProgress.elapsedTime).toBe(250_000)
		expect(events[1].frameProgress.progress).toBeCloseTo(25, 6)
		expect(events[1].totalProgress.elapsedTime).toBe(250_000)
		expect(events[1].totalProgress.progress).toBeCloseTo(12.5, 6)

		expect(exposing(0.5)).toBe('exposing')
		expect(events[2].frameProgress.progress).toBeCloseTo(50, 6)
	})

	test('applies a frame exposure override to the opened generation', () => {
		const { reporter, events } = createHarness()

		reporter.beginFrame(3_000_000)

		expect(reporter.frameExposureTime).toBe(3_000_000)
		expect(events[0].frameExposureTime).toBe(3_000_000)
		expect(events[0].frameProgress.remainingTime).toBe(3_000_000)
	})

	test('ignores an exposure update outside a generation', () => {
		const { reporter, events, exposing } = createHarness()

		expect(exposing(1)).toBe('ignored')
		expect(reporter.applyExposureUpdate('Ok')).toBe('ignored')
		expect(reporter.applyExposureUpdate('Alert')).toBe('ignored')
		expect(events).toBeEmpty()
	})

	test('ignores an update without a terminal or busy state', () => {
		const { reporter, events } = createHarness()

		reporter.beginFrame()

		expect(reporter.applyExposureUpdate()).toBe('ignored')
		expect(events).toHaveLength(1)
	})

	test('opens a generation on the first busy update when the frame is not dispatched here', () => {
		const { reporter, events, exposing } = createHarness({ autoFrame: true })

		expect(exposing(3)).toBe('started')
		expect(reporter.generation).toBe(1)
		expect(events[0].state).toBe('exposureStarted')
		// The remaining time of the first update is the exposure the driver actually accepted.
		expect(events[0].frameExposureTime).toBe(3_000_000)
		expect(events[1].state).toBe('exposing')
		expect(events[1].frameProgress.progress).toBe(0)
	})

	test('falls back to the requested exposure when the driver reports no remaining time', () => {
		const { events, exposing } = createHarness({ autoFrame: true })

		expect(exposing(0)).toBe('started')
		expect(events[0].frameExposureTime).toBe(1_000_000)
	})

	test('closes the generation once the exposure finishes', () => {
		const { reporter, events, exposing } = createHarness()

		reporter.beginFrame()
		exposing(0.5)

		expect(reporter.applyExposureUpdate('Ok')).toBe('finished')
		expect(events[2].state).toBe('exposureFinished')
		expect(events[2].frameProgress.remainingTime).toBe(0)
		expect(events[2].frameProgress.elapsedTime).toBe(1_000_000)
		expect(events[2].frameProgress.progress).toBe(100)

		// A late update belonging to the closed generation cannot advance progress again.
		expect(exposing(0.5)).toBe('ignored')
		expect(reporter.applyExposureUpdate('Ok')).toBe('ignored')
		expect(events).toHaveLength(3)
	})

	test('closes the generation on a failed exposure without publishing it', () => {
		const alert = createHarness()

		alert.reporter.beginFrame()

		expect(alert.reporter.applyExposureUpdate('Alert')).toBe('alert')
		expect(alert.events).toHaveLength(1)
		expect(alert.exposing(0.5)).toBe('ignored')

		const idle = createHarness()

		idle.reporter.beginFrame()

		expect(idle.reporter.applyExposureUpdate('Idle')).toBe('idle')
		expect(idle.events).toHaveLength(1)
	})

	test('reopens a generation after the previous one was closed', () => {
		const { reporter, events, exposing } = createHarness({ autoFrame: true })

		exposing(1)
		reporter.applyExposureUpdate('Ok')

		expect(exposing(2)).toBe('started')
		expect(reporter.generation).toBe(2)
		expect(reporter.remainingCount).toBe(0)
		expect(events.at(-2)!.state).toBe('exposureStarted')
	})

	test('follows a real simulator exposure on its own when the frame is not dispatched here', async () => {
		const camera = getCamera()
		const { reporter, events } = createHarness({ autoFrame: true, loop: true, count: Number.MAX_SAFE_INTEGER })
		const transitions: CameraExposureTransition[] = []
		const handler: DeviceHandler<Camera> = {
			added: () => {},
			removed: () => {},
			updated: (device, property, state) => {
				if (device === camera && property === 'exposure') transitions.push(reporter.applyExposureUpdate(state))
			},
		}

		cameraManager.addHandler(handler)

		try {
			cameraManager.connect(camera)
			await waitUntil(() => camera.connected, 5000, 10)
			cameraManager.startExposure(camera, 0.3)
			await waitUntil(() => transitions.includes('finished'), 5000, 10)

			// Exposure updates published while connecting precede the frame and open nothing.
			expect(transitions.find((transition) => transition !== 'ignored')).toBe('started')
			expect(transitions.at(-1)).toBe('finished')
			expect(reporter.generation).toBe(1)
			expect(events[0].state).toBe('exposureStarted')
			expect(events[0].frameExposureTime).toBeCloseTo(300_000, 0)
			expect(events.at(-1)!.state).toBe('exposureFinished')
			expect(events.at(-1)!.frameProgress.progress).toBe(100)
			// Progress only moves forward over the whole exposure.
			const progress = events.map((event) => event.frameProgress.progress)
			expect(progress).toEqual(progress.toSorted((a, b) => a - b))
		} finally {
			cameraManager.removeHandler(handler)
			cameraManager.disconnect(camera)
		}
	})
})

describe('progress accumulation', () => {
	test('hands a finished frame to the listener and advances the aggregate progress', () => {
		const { reporter, events, paths, exposing } = createHarness()

		reporter.beginFrame()
		exposing(0.5)
		reporter.applyExposureUpdate('Ok')
		reporter.completeFrame('/captures/frame.fit')

		expect(paths.at(-1)!).toBe('/captures/frame.fit')
		expect(paths.slice(0, -1).every((path) => path === undefined)).toBeTrue()
		expect(events.at(-1)!.state).toBe('exposureFinished')

		reporter.beginFrame()
		exposing(0.5)

		expect(events.at(-1)!.totalProgress.elapsedTime).toBe(1_500_000)
		expect(events.at(-1)!.totalProgress.remainingTime).toBe(500_000)
		expect(events.at(-1)!.totalProgress.progress).toBeCloseTo(75, 6)
	})

	test('publishes the inter-frame delay and carries it into the aggregate progress', () => {
		const { reporter, events } = createHarness({ frameExposureTime: 0, totalExposureTime: 1_000_000 })

		reporter.waiting(750_000, 250_000, 1_000_000)

		expect(events[0].state).toBe('waiting')
		expect(events[0].frameProgress.remainingTime).toBe(750_000)
		expect(events[0].frameProgress.elapsedTime).toBe(250_000)
		expect(events[0].frameProgress.progress).toBeCloseTo(25, 6)
		expect(events[0].totalProgress.elapsedTime).toBe(250_000)

		reporter.setState('settling')

		expect(events[1].state).toBe('settling')

		reporter.completeDelay(1_000_000)
		reporter.waiting(500_000, 0, 500_000)

		expect(events[2].totalProgress.elapsedTime).toBe(1_000_000)
		expect(events[2].totalProgress.remainingTime).toBe(0)
		expect(events[2].totalProgress.progress).toBe(100)
	})

	test('hands every listener an independent snapshot', () => {
		const { reporter, events } = createHarness()

		reporter.beginFrame()
		events[0].state = 'error'
		events[0].frameProgress.progress = 99
		reporter.setState('dithering')

		expect(events[1].state).toBe('dithering')
		expect(events[1].frameProgress.progress).toBe(0)
	})
})

describe('terminal presentation', () => {
	test('ends an interrupted capture with an error before going idle', () => {
		const { reporter, events, exposing } = createHarness()

		reporter.beginFrame()
		reporter.terminal(true)

		expect(events[1].state).toBe('error')
		expect(events[2].state).toBe('idle')
		expect(events[2].stopped).toBeTrue()
		// The open generation was closed by the terminal, so a trailing device update publishes nothing.
		expect(exposing(0.5)).toBe('ignored')
		expect(events).toHaveLength(3)
	})

	test('ends a completed capture with a single idle snapshot', () => {
		const { reporter, events } = createHarness()

		reporter.terminal(false)

		expect(events).toHaveLength(1)
		expect(events[0].state).toBe('idle')
		expect(events[0].stopped).toBeFalse()
	})
})
