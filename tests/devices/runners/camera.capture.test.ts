import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { basename, dirname, join, sep } from 'path'
import { parseTemporal } from '../../../src/astronomy/time/temporal'
import { IndiClientHandlerSet } from '../../../src/devices/indi/client'
import type { Camera } from '../../../src/devices/indi/device'
import { CameraManager } from '../../../src/devices/indi/manager/camera'
import { FocuserManager } from '../../../src/devices/indi/manager/focuser'
import { MountManager } from '../../../src/devices/indi/manager/mount'
import { RotatorManager } from '../../../src/devices/indi/manager/rotator'
import { WheelManager } from '../../../src/devices/indi/manager/wheel'
import { CameraSimulator } from '../../../src/devices/indi/simulator/camera'
import { ClientSimulator } from '../../../src/devices/indi/simulator/client'
import { FocuserSimulator } from '../../../src/devices/indi/simulator/focuser'
import { MountSimulator } from '../../../src/devices/indi/simulator/mount'
import { RotatorSimulator } from '../../../src/devices/indi/simulator/rotator'
import { WheelSimulator } from '../../../src/devices/indi/simulator/wheel'
import type { BlobEncoding, PropertyState } from '../../../src/devices/indi/types'
import { DeviceLifecycle } from '../../../src/devices/orchestration/device.lifecycle'
import { failedOperationResult, OperationCoordinator, type OperationResult, successfulOperationResult } from '../../../src/devices/orchestration/operation'
import { ResourceArbiter, resourceKey } from '../../../src/devices/orchestration/resource'
import { autoSubFolderName, type CameraCaptureResult, CameraCapturer, type CameraCapturerOptions, type CameraDitherer, type CameraDitherOptions, decodeCameraBlobFromBase64 } from '../../../src/devices/runners/camera.capture'
import type { CameraCaptureListener } from '../../../src/devices/runners/camera.capture.reporter'
import { type CameraCaptureEvent, type CameraCaptureStart, type CameraDither, DEFAULT_CAMERA_CAPTURE_START } from '../../../src/devices/runners/camera.capture.types'
import { readImageFromBuffer, readImageFromPath } from '../../../src/imaging/model/image'
import { isFits } from '../../../src/io/formats/fits/fits'
import { isXisf, readXisf } from '../../../src/io/formats/xisf/xisf'
import { bufferSource } from '../../../src/io/io'
import { deg, hour } from '../../../src/math/units/angle'
import { meter } from '../../../src/math/units/distance'
import { waitUntil } from '../../util'

// Every capture runs on the INDI simulators. Only driver misbehaviour the simulator cannot produce, such as an
// exposure command that never turns Busy, a stop that never quiesces, or a BLOB that is late, is staged by
// intercepting the real manager command or the callback the manager delivers to the capturer.

type CaptureOverrides = Omit<Partial<CameraCaptureStart>, 'dither'> & { readonly dither?: Partial<CameraDither> }

interface CaptureRecord {
	readonly event: CameraCaptureEvent
	readonly path?: string
}

const cameraManager = new CameraManager()
const mountManager = new MountManager()
const wheelManager = new WheelManager()
const focuserManager = new FocuserManager()
const rotatorManager = new RotatorManager()
const arbiter = new ResourceArbiter()
const coordinator = new OperationCoordinator(arbiter)
const lifecycle = new DeviceLifecycle(arbiter, coordinator)
lifecycle.observe(cameraManager)

const handlers = new IndiClientHandlerSet([cameraManager, mountManager, wheelManager, focuserManager, rotatorManager])
const client = new ClientSimulator('Client Simulator', handlers)
const simulators = [new MountSimulator('Mount Simulator', client), new WheelSimulator('Wheel Simulator', client), new FocuserSimulator('Focuser Simulator', client), new RotatorSimulator('Rotator Simulator', client)] as const
let cameraSimulator = createCameraSimulator()

const capturesDir = await mkdtemp(join(tmpdir(), 'nebulosa-capture-'))
// Decoded frames handed to `publish`, by published path.
const published = new Map<string, Buffer>()
const capturer = createCapturer()

afterAll(async () => {
	capturer.dispose()
	lifecycle.dispose()
	cameraSimulator.dispose()
	for (const simulator of simulators) simulator.dispose()
	await rm(capturesDir, { recursive: true, force: true })
})

beforeEach(() => {
	published.clear()
})

afterEach(async () => {
	await coordinator.cancelAll()
	cameraManager.disconnect(getCamera())
	await waitUntil(() => !getCamera().connected, 5000, 10)
})

function createCameraSimulator() {
	return new CameraSimulator('Camera Simulator', client, { mountManager, focuserManager, rotatorManager, wheelManager })
}

// Creates a capturer registered on the shared camera manager. Extra capturers are disposed by their tests.
function createCapturer(options: Partial<CameraCapturerOptions> = {}, resourceArbiter = arbiter) {
	return new CameraCapturer(cameraManager, resourceArbiter, {
		capturesDir,
		publish: (frame, path) => published.set(path, frame),
		devices: { mount: mountManager, focuser: focuserManager, wheel: wheelManager, rotator: rotatorManager },
		frameGraceTime: 5000,
		quiesceTimeout: 2000,
		lateBlobDrainTime: 0,
		...options,
	})
}

function getCamera() {
	const camera = cameraManager.get(client, 'Camera Simulator')
	expect(camera).toBeDefined()
	return camera!
}

function keyOf(camera: Camera) {
	return resourceKey(camera)
}

// Connects the simulator camera and waits until lifecycle verification made it acquirable.
async function connected() {
	const camera = getCamera()
	cameraManager.connect(camera)
	await waitUntil(() => camera.connected && camera.frame.width.max > 0 && arbiter.availability(keyOf(camera)) === 'available', 5000, 10)
	return camera
}

function request(overrides: CaptureOverrides = {}): CameraCaptureStart {
	const value = structuredClone(DEFAULT_CAMERA_CAPTURE_START)
	Object.assign(value, { exposureTime: 100, exposureTimeUnit: 'millisecond', x: 0, y: 0, width: 16, height: 16, subframe: true, frameFormat: 'MONO' }, overrides)
	value.dither = { ...DEFAULT_CAMERA_CAPTURE_START.dither, ...overrides.dither }
	return value
}

function recorder() {
	const records: CaptureRecord[] = []
	const listener: CameraCaptureListener = (event, path) => records.push({ event, path })

	return {
		records,
		listener,
		get events() {
			return records.map((record) => record.event)
		},
		get states() {
			return records.map((record) => record.event.state)
		},
		get paths() {
			return records.filter((record) => record.path !== undefined).map((record) => record.path!)
		},
	} as const
}

function expectSuccessfulEventFlow(records: readonly CaptureRecord[], frameCount: number) {
	const states = records.map(({ event }) => event.state)

	expect(records.filter(({ path }) => path !== undefined)).toHaveLength(frameCount)
	expect(states.filter((state) => state === 'exposureStarted')).toHaveLength(frameCount)
	expect(states[0]).toBe('exposureStarted')
	expect(states).toContain('exposing')
	expect(states).toContain('exposureFinished')
	expect(states).not.toContain('error')
	expect(states.at(-1)).toBe('idle')

	const final = records.at(-1)!.event
	expect(final.elapsedCount).toBe(frameCount)
	expect(final.remainingCount).toBe(0)
	expect(final.stopped).toBeFalse()
}

// Holds every exposure update matching `state` instead of letting the capturer see it.
function holdExposureUpdates(target: CameraCapturer, state: PropertyState) {
	const original = target.updated.bind(target)
	const held: Parameters<CameraCapturer['updated']>[] = []
	const spy = spyOn(target, 'updated').mockImplementation((camera, property, update) => {
		if (property === 'exposure' && update === state) held.push([camera, property, update])
		else original(camera, property, update)
	})

	const release = () => {
		for (const args of held) original(...args)
	}

	return { held, spy, release } as const
}

// Holds every BLOB the capturer would receive.
function holdBlobs(target: CameraCapturer) {
	const original = target.blobReceived.bind(target)
	const held: [Camera, Buffer, BlobEncoding][] = []
	const spy = spyOn(target, 'blobReceived').mockImplementation((camera, data, encoding) => {
		held.push([camera, data, encoding])
	})

	return { held, spy, original } as const
}

async function readPublishedImage(path: string) {
	const buffer = published.get(path)
	expect(buffer).toBeDefined()
	const image = await readImageFromBuffer(buffer!, 32)
	expect(image).toBeDefined()
	return { buffer: buffer!, image: image! } as const
}

describe('registration', () => {
	test('receives the camera callbacks of its manager until disposed', async () => {
		const own = createCapturer()
		const updated = spyOn(own, 'updated')

		try {
			await connected()
			expect(updated).toHaveBeenCalled()

			own.dispose()
			own.dispose()
			updated.mockClear()

			cameraManager.disconnect(getCamera())
			await waitUntil(() => !getCamera().connected, 5000, 10)
			expect(updated).not.toHaveBeenCalled()
		} finally {
			updated.mockRestore()
			own[Symbol.dispose]()
		}
	})

	test('routes updates to a watcher only while no capture owns the camera', async () => {
		const camera = await connected()
		const watched: (keyof Camera & string)[] = []
		const replaced: string[] = []
		const unwatchReplaced = capturer.watch(camera, { updated: (_, property) => replaced.push(property) })
		const unwatch = capturer.watch(camera, { updated: (_, property) => watched.push(property) })

		try {
			cameraManager.gain(camera, 3)
			await waitUntil(() => watched.includes('gain'), 5000, 10)
			// Registering another watcher for the same camera replaced the first one.
			expect(replaced).toBeEmpty()

			watched.length = 0
			const handle = capturer.start(coordinator, camera, request())
			expect((await handle.result).ok).toBeTrue()
			expect(watched).not.toContain('exposure')

			// The replaced registration cannot remove the current one.
			unwatchReplaced()
			cameraManager.gain(camera, 4)
			await waitUntil(() => watched.includes('gain'), 5000, 10)

			unwatch()
			unwatch()
			watched.length = 0
			cameraManager.gain(camera, 5)
			await Bun.sleep(50)
			expect(watched).toBeEmpty()
		} finally {
			unwatch()
			unwatchReplaced()
		}
	})

	test('releases its quarantines when disposed', async () => {
		const camera = await connected()
		const key = keyOf(camera)
		const own = createCapturer()
		const blobs = holdBlobs(own)

		try {
			const handle = own.start(coordinator, camera, request())
			await waitUntil(() => blobs.held.length > 0 && camera.exposure.state === 'Ok', 5000, 10)
			await handle.cancel()
			expect(arbiter.availability(key)).toBe('unavailable')

			// Nobody else could ever discard the stale BLOB, so disposal must not leave the camera blocked.
			own.dispose()
			expect(arbiter.availability(key)).toBe('available')
			expect((await capturer.start(coordinator, camera, request()).result).ok).toBeTrue()
		} finally {
			blobs.spy.mockRestore()
			own.dispose()
		}
	})
})

describe('successful captures', () => {
	test('single capture emits one frame, publishes it and correlates the identifiers', async () => {
		const camera = await connected()
		const recording = recorder()

		const handle = capturer.start(coordinator, camera, request({ exposureMode: 'single', count: 100 }), { listener: recording.listener })
		expect(await handle.started).toEqual(successfulOperationResult(undefined))
		const result = await handle.result

		expect(result.ok).toBeTrue()
		if (!result.ok) return

		const path = join(capturesDir, `${camera.name}.fit`)
		expect(result.value.frameCount).toBe(1)
		expect(result.value.frames).toEqual([{ operation: handle.id, session: recording.events[0].session, generation: 1, camera: camera.id, path }])
		expect(recording.paths).toEqual([path])
		expect(recording.events.every((event) => event.operation === handle.id && event.camera === camera.id)).toBeTrue()
		expect(recording.events[0].generation).toBe(1)
		expectSuccessfulEventFlow(recording.records, 1)

		const { buffer, image } = await readPublishedImage(path)
		expect(isFits(buffer)).toBeTrue()
		expect(image.metadata.width).toBe(16)
		expect(image.metadata.height).toBe(16)
		// Without auto-save the path only names the published frame.
		expect(await Bun.file(path).exists()).toBeFalse()
		expect(arbiter.availability(keyOf(camera))).toBe('available')
	})

	test('fixed capture emits the requested frame count in consecutive generations', async () => {
		const camera = await connected()
		const recording = recorder()

		const result = await capturer.start(coordinator, camera, request({ exposureMode: 'fixed', count: 2 }), { listener: recording.listener }).result

		expect(result.ok).toBeTrue()
		if (result.ok) expect(result.value.frames.map((frame) => frame.generation)).toEqual([1, 2])
		expectSuccessfulEventFlow(recording.records, 2)
		const final = recording.events.at(-1)!
		expect(final.totalProgress.remainingTime).toBe(0)
		expect(final.totalProgress.progress).toBe(100)
	})

	test('loop capture runs until it is stopped', async () => {
		const camera = await connected()
		const recording = recorder()

		const handle = capturer.start(coordinator, camera, request({ exposureMode: 'loop' }), { listener: recording.listener })
		await waitUntil(() => recording.paths.length >= 2, 5000, 10)
		await handle.cancel()

		expect(await handle.result).toEqual(failedOperationResult('aborted'))
		expect(recording.events[0].loop).toBeTrue()
		expect(recording.events[0].count).toBe(Number.MAX_SAFE_INTEGER)
		expect(recording.events[0].totalExposureTime).toBe(0)
		expect(recording.states.slice(-2)).toEqual(['error', 'idle'])
		expect(recording.events.at(-1)!.stopped).toBeTrue()
	})

	test('computes exposure timing from mode, count, delay, and units', async () => {
		const camera = await connected()
		const cases = [
			[request({ exposureMode: 'single', exposureTime: 2, exposureTimeUnit: 'second', count: 7, delay: 5 }), 1, false, 2000000, 2000000],
			[request({ exposureMode: 'fixed', exposureTime: 250, exposureTimeUnit: 'millisecond', count: 3, delay: 2 }), 3, false, 250000, 4750000],
			[request({ exposureMode: 'loop', exposureTime: 1000, exposureTimeUnit: 'microsecond', count: 3, delay: 1 }), Number.MAX_SAFE_INTEGER, true, 1000, 0],
			[request({ exposureMode: 'fixed', exposureTime: 1, exposureTimeUnit: 'minute', count: 2, delay: 0 }), 2, false, 60000000, 120000000],
		] as const

		for (const [capture, count, loop, frameExposureTime, totalRemainingTime] of cases) {
			const recording = recorder()
			const handle = capturer.start(coordinator, camera, capture, { listener: recording.listener })
			await waitUntil(() => recording.events.length > 0, 5000, 10)
			await handle.cancel()

			const first = recording.events[0]
			expect(first.count).toBe(count)
			expect(first.remainingCount).toBe(count - 1)
			expect(first.loop).toBe(loop)
			expect(first.frameExposureTime).toBe(frameExposureTime)
			expect(first.totalExposureTime).toBe(totalRemainingTime)
			expect(first.totalProgress.remainingTime).toBe(totalRemainingTime)
			// The cancelled exposure was aborted to Idle by the driver, so nothing is left to quarantine.
			await waitUntil(() => arbiter.availability(keyOf(camera)) === 'available', 5000, 10)
		}
	})

	test('emits waiting progress between delayed fixed captures', async () => {
		const camera = await connected()
		const recording = recorder()

		const result = await capturer.start(coordinator, camera, request({ exposureMode: 'fixed', exposureTime: 1, exposureTimeUnit: 'millisecond', delay: 1, count: 2 }), { listener: recording.listener }).result
		const waiting = recording.events.filter((event) => event.state === 'waiting')
		const totalProgress = waiting.map((event) => event.totalProgress.progress)

		expect(result.ok).toBeTrue()
		expect(waiting[0].frameProgress.remainingTime).toBe(1000000)
		expect(waiting.map((event) => event.totalProgress.elapsedTime)).toEqual([1000, 251000, 501000, 751000])
		expect(waiting.map((event) => event.totalProgress.remainingTime)).toEqual([1001000, 751000, 501000, 251000])
		expect(waiting.map((event) => event.frameProgress.progress)).toEqual([0, 25, 50, 75])
		expect(totalProgress).toEqual(totalProgress.toSorted((a, b) => a - b))
		expectSuccessfulEventFlow(recording.records, 2)
		expect(recording.events.at(-1)!.totalProgress.remainingTime).toBe(0)
	}, 10000)

	test('waits a sub-second delay silently and still completes the aggregate progress', async () => {
		const camera = await connected()
		const recording = recorder()
		const times: number[] = []
		const listener: CameraCaptureListener = (event, path) => {
			if (path !== undefined || event.state === 'exposureStarted') times.push(performance.now())
			recording.listener(event, path)
		}

		const result = await capturer.start(coordinator, camera, request({ exposureMode: 'fixed', delay: 0.3, count: 2 }), { listener }).result

		expect(result.ok).toBeTrue()
		expect(recording.states).not.toContain('waiting')
		// times: first exposureStarted, first frame, second exposureStarted, second frame.
		expect(times[2] - times[1]).toBeGreaterThanOrEqual(290)
		expect(recording.events[0].totalExposureTime).toBe(500000)
		const final = recording.events.at(-1)!
		expect(final.totalProgress.remainingTime).toBe(0)
		expect(final.totalProgress.progress).toBe(100)
		expect(final.totalProgress.elapsedTime).toBe(500000)
	})

	test('applies the full frame unless a subframe is enabled', async () => {
		const camera = await connected()
		const frame = spyOn(cameraManager, 'frame')

		try {
			const capture = request({ subframe: false, x: 3, y: 5, width: 17, height: 19, binX: 4, binY: 4 })
			expect((await capturer.start(coordinator, camera, capture).result).ok).toBeTrue()
			expect(frame).toHaveBeenLastCalledWith(camera, 0, 0, 1280, 1024)

			capture.subframe = true
			expect((await capturer.start(coordinator, camera, capture).result).ok).toBeTrue()
			expect(frame).toHaveBeenLastCalledWith(camera, 3, 5, 17, 19)

			// A subframe without a size falls back to the full frame.
			expect((await capturer.start(coordinator, camera, request({ subframe: true, width: 0, height: 0, binX: 4, binY: 4 })).result).ok).toBeTrue()
			expect(frame).toHaveBeenLastCalledWith(camera, 0, 0, 1280, 1024)
		} finally {
			frame.mockRestore()
		}
	}, 15000)

	test('applies camera, device, save, transfer, and compression options and writes XISF', async () => {
		const savePath = await mkdtemp(join(capturesDir, 'capture-'))
		const camera = await connected()
		const mount = mountManager.get(client, 'Mount Simulator')
		const wheel = wheelManager.get(client, 'Wheel Simulator')
		const focuser = focuserManager.get(client, 'Focuser Simulator')
		const rotator = rotatorManager.get(client, 'Rotator Simulator')
		const snoop = spyOn(cameraManager, 'snoop')
		const compression = spyOn(cameraManager, 'compression')
		const recording = recorder()

		const capture = request({
			exposureTime: 25,
			exposureTimeUnit: 'millisecond',
			frameType: 'DARK',
			x: 11,
			y: 13,
			width: 64,
			height: 48,
			subframe: true,
			binX: 2,
			binY: 3,
			frameFormat: 'RGB',
			gain: 42,
			offset: 7,
			autoSave: true,
			savePath,
			autoSubFolderMode: 'midnight',
			mount: 'Mount Simulator',
			wheel: 'Wheel Simulator',
			focuser: 'Focuser Simulator',
			rotator: 'Rotator Simulator',
			transferFormat: 'XISF',
			compressed: true,
		})

		try {
			const result = await capturer.start(coordinator, camera, capture, { listener: recording.listener }).result
			const path = recording.paths[0]

			expect(result.ok).toBeTrue()
			expect(recording.paths).toHaveLength(1)
			expect(path.endsWith('.xisf')).toBeTrue()
			expect(dirname(path)).toBe(join(savePath, autoSubFolderName(Date.now(), 'midnight')!))
			expect(await Bun.file(path).exists()).toBeTrue()

			const stored = Buffer.from(await Bun.file(path).arrayBuffer())
			const { buffer, image } = await readPublishedImage(path)
			const xisf = await readXisf(bufferSource(buffer))

			expect(Buffer.compare(stored, buffer)).toBe(0)
			expect(isXisf(buffer)).toBeTrue()
			expect(xisf?.images).toHaveLength(1)
			expect(xisf?.images[0].geometry).toEqual({ width: 32, height: 16, channels: 3 })
			expect(xisf?.images[0].colorSpace).toBe('RGB')
			expect(image.metadata.width).toBe(32)
			expect(image.metadata.height).toBe(16)
			expect(image.metadata.channels).toBe(3)
			expect(image.metadata.bitpix).toBe(16)
			expect(image.raw).toHaveLength(32 * 16 * 3)
			expect(image.header.INSTRUME).toBe('Camera Simulator')
			expect(image.header.EXPTIME as number).toBeCloseTo(0.025, 6)
			expect(image.header.XBINNING).toBe(capture.binX)
			expect(image.header.YBINNING).toBe(capture.binY)
			expect(image.header.XPIXSZ).toBe(camera.pixelSize.x * capture.binX)
			expect(image.header.YPIXSZ).toBe(camera.pixelSize.y * capture.binY)
			expect(image.header.GAIN).toBe(capture.gain)
			expect(image.header.OFFSET).toBe(capture.offset)
			expect(image.header.FRAME).toBe(capture.frameType)
			expect(image.header.IMAGETYP).toBe('Dark Frame')
			expect(image.header.XORGSUBF).toBe(capture.x)
			expect(image.header.YORGSUBF).toBe(capture.y)
			expect(image.header['DATE-OBS']).toBeDefined()
			expect(image.header['DATE-END']).toBeDefined()
			expectSuccessfulEventFlow(recording.records, 1)

			expect(snoop).toHaveBeenCalledWith(camera, mount, focuser, wheel, rotator)
			expect(compression).toHaveBeenCalledWith(camera, true)
			expect(camera.frameType).toBe(capture.frameType)
			expect(camera.frameFormat).toBe(capture.frameFormat)
			expect(camera.frame.x.value).toBe(capture.x)
			expect(camera.frame.y.value).toBe(capture.y)
			expect(camera.frame.width.value).toBe(capture.width)
			expect(camera.frame.height.value).toBe(capture.height)
			expect(camera.bin.x.value).toBe(capture.binX)
			expect(camera.bin.y.value).toBe(capture.binY)
			expect(camera.gain.value).toBe(capture.gain)
			expect(camera.offset.value).toBe(capture.offset)
		} finally {
			snoop.mockRestore()
			compression.mockRestore()
		}
	})

	test('writes FITS files with mono dimensions and headers into the save path', async () => {
		const savePath = await mkdtemp(join(capturesDir, 'fits-'))
		const camera = await connected()
		const recording = recorder()
		const capture = request({ exposureTime: 20, frameType: 'FLAT', x: 2, y: 4, width: 40, height: 30, binX: 2, binY: 2, gain: 9, offset: 4, autoSave: true, savePath, autoSubFolderMode: 'off', transferFormat: 'FITS' })
		const startedAt = Date.now()

		const result = await capturer.start(coordinator, camera, capture, { listener: recording.listener }).result
		const path = recording.paths[0]

		expect(result.ok).toBeTrue()
		expect(dirname(path)).toBe(savePath)
		expect(path.endsWith('.fit')).toBeTrue()
		expectSuccessfulEventFlow(recording.records, 1)

		// The automatic name is the local timestamp of the instant the exposure was commanded.
		const named = parseTemporal(basename(path, '.fit'), 'YYYYMMDD.HHmmssSSS') + new Date().getTimezoneOffset() * 60000
		expect(named).toBeGreaterThanOrEqual(startedAt - 1)
		expect(named).toBeLessThanOrEqual(Date.now())

		const stored = Buffer.from(await Bun.file(path).arrayBuffer())
		const { buffer, image } = await readPublishedImage(path)
		const storedImage = await readImageFromPath(path, 32)

		expect(Buffer.compare(stored, buffer)).toBe(0)
		expect(isFits(buffer)).toBeTrue()
		expect(storedImage?.metadata).toEqual(image.metadata)
		expect(image.metadata.width).toBe(20)
		expect(image.metadata.height).toBe(15)
		expect(image.metadata.channels).toBe(1)
		expect(image.raw).toHaveLength(20 * 15)
		expect(image.header.NAXIS).toBe(2)
		expect(image.header.FRAME).toBe('FLAT')
		expect(image.header.IMAGETYP).toBe('Flat Frame')
		expect(image.header.XORGSUBF).toBe(capture.x)
		expect(image.header.YORGSUBF).toBe(capture.y)
	})

	test('falls back to the captures directory when the save path is not a directory', async () => {
		const camera = await connected()
		const missing = join(capturesDir, 'missing', 'directory')
		const recording = recorder()

		const result = await capturer.start(coordinator, camera, request({ autoSave: true, savePath: missing, autoSubFolderMode: 'off' }), { listener: recording.listener }).result

		expect(result.ok).toBeTrue()
		expect(dirname(recording.paths[0])).toBe(capturesDir)
		expect(await Bun.file(recording.paths[0]).exists()).toBeTrue()
	})

	test('creates the noon subfolder of the night the frame belongs to', async () => {
		const camera = await connected()
		const savePath = await mkdtemp(join(capturesDir, 'noon-'))
		const recording = recorder()

		const result = await capturer.start(coordinator, camera, request({ autoSave: true, savePath, autoSubFolderMode: 'noon' }), { listener: recording.listener }).result

		expect(result.ok).toBeTrue()
		expect(dirname(recording.paths[0])).toBe(join(savePath, autoSubFolderName(Date.now(), 'noon')!))
		expect(await Bun.file(recording.paths[0]).exists()).toBeTrue()
	})

	test('stamps the snooped devices into the frame headers', async () => {
		const camera = await connected()
		const mount = mountManager.get(client, 'Mount Simulator')!
		const wheel = wheelManager.get(client, 'Wheel Simulator')!
		const focuser = focuserManager.get(client, 'Focuser Simulator')!
		const rotator = rotatorManager.get(client, 'Rotator Simulator')!

		try {
			mountManager.connect(mount)
			wheelManager.connect(wheel)
			focuserManager.connect(focuser)
			rotatorManager.connect(rotator)
			await waitUntil(() => mount.connected && wheel.connected && focuser.connected && rotator.connected, 5000, 10)

			mountManager.geographicCoordinate(mount, { latitude: deg(-22), longitude: deg(-45), elevation: meter(890) })
			mountManager.syncTo(mount, hour(5), deg(-30))
			focuserManager.syncTo(focuser, 54321)
			rotatorManager.syncTo(rotator, 123.45)
			wheelManager.moveTo(wheel, 4)
			await waitUntil(() => focuser.position.value === 54321 && Math.abs(rotator.angle.value - 123.45) < 1e-6 && wheel.position === 4 && !wheel.moving, 5000, 10)

			const recording = recorder()
			const result = await capturer.start(coordinator, camera, request({ width: 24, height: 18, mount: mount.name, wheel: wheel.name, focuser: focuser.name, rotator: rotator.name }), { listener: recording.listener }).result
			const { image } = await readPublishedImage(recording.paths[0])

			expect(result.ok).toBeTrue()
			expect(image.header.TELESCOP).toBe(mount.name)
			expect(image.header.SITELAT as number).toBeCloseTo(-22, 6)
			expect(image.header.SITELONG as number).toBeCloseTo(-45, 6)
			expect(image.header.FOCUSPOS).toBe(54321)
			expect(image.header.ROTATANG as number).toBeCloseTo(123.45, 6)
			expect(image.header.FILTER).toBe(wheel.names[4])
		} finally {
			rotatorManager.disconnect(rotator)
			focuserManager.disconnect(focuser)
			wheelManager.disconnect(wheel)
			mountManager.disconnect(mount)
		}
	})

	test('resolves snooped devices only through the configured lookups', async () => {
		const camera = await connected()
		const mount = mountManager.get(client, 'Mount Simulator')
		const snoop = spyOn(cameraManager, 'snoop')
		const bare = createCapturer({ devices: undefined })

		try {
			expect((await bare.start(coordinator, camera, request({ mount: 'Mount Simulator', focuser: 'Focuser Simulator' })).result).ok).toBeTrue()
			expect(snoop).toHaveBeenLastCalledWith(camera, undefined, undefined, undefined, undefined)

			expect((await capturer.start(coordinator, camera, request({ mount: 'Mount Simulator', wheel: 'Missing Wheel' })).result).ok).toBeTrue()
			expect(snoop).toHaveBeenLastCalledWith(camera, mount, undefined, undefined, undefined)
		} finally {
			snoop.mockRestore()
			bare.dispose()
		}
	})

	test('waits for exposure completion after an early BLOB', async () => {
		const camera = await connected()
		const recording = recorder()
		const blobs = spyOn(capturer, 'blobReceived')
		const completion = holdExposureUpdates(capturer, 'Ok')

		try {
			const handle = capturer.start(coordinator, camera, request(), { listener: recording.listener })
			expect((await handle.started).ok).toBeTrue()
			await waitUntil(() => completion.held.length > 0 && blobs.mock.calls.length > 0, 5000, 10)

			let settled = false
			void handle.result.then(() => {
				settled = true
			})
			await Bun.sleep(50)
			expect(settled).toBeFalse()

			completion.release()
			expect((await handle.result).ok).toBeTrue()
			expect(recording.states).toContain('exposureFinished')
			expect(recording.states.at(-1)).toBe('idle')
		} finally {
			completion.spy.mockRestore()
			blobs.mockRestore()
		}
	})

	test('waits for a delayed BLOB after exposure completion', async () => {
		const camera = await connected()
		const recording = recorder()
		const blobs = holdBlobs(capturer)

		try {
			const handle = capturer.start(coordinator, camera, request(), { listener: recording.listener })
			expect((await handle.started).ok).toBeTrue()
			await waitUntil(() => blobs.held.length > 0 && recording.states.includes('exposureFinished'), 5000, 10)

			let settled = false
			void handle.result.then(() => {
				settled = true
			})
			await Bun.sleep(50)
			expect(settled).toBeFalse()

			blobs.original(...blobs.held[0])
			expect((await handle.result).ok).toBeTrue()
			expect(recording.paths).toHaveLength(1)
		} finally {
			blobs.spy.mockRestore()
		}
	})

	test('decodes a base64 transport payload into the frame the driver produced', async () => {
		const camera = await connected()
		const recording = recorder()
		const raw: Buffer[] = []
		const blobs = holdBlobs(capturer)
		blobs.spy.mockImplementation((device, data) => {
			raw.push(data)
			blobs.original(device, Buffer.from(`\n${data.toString('base64')}\r\n`), 'base64')
		})

		try {
			expect((await capturer.start(coordinator, camera, request(), { listener: recording.listener }).result).ok).toBeTrue()
			expect(Buffer.compare(published.get(recording.paths[0])!, raw[0])).toBe(0)
		} finally {
			blobs.spy.mockRestore()
		}
	})
})

describe('caller destinations', () => {
	test('writes the frame to the destination the caller decided', async () => {
		const camera = await connected()
		const directory = await mkdtemp(join(capturesDir, 'session-'))
		const path = join(directory, 'm42-lum-0.fit')

		const result = await capturer.start(coordinator, camera, request({ autoSave: true, outputPath: directory, outputName: 'm42-lum-0.fit' })).result

		expect(result.ok).toBeTrue()
		if (result.ok) expect(result.value.frames.map((frame) => frame.path)).toEqual([path])
		expect(await Bun.file(path).exists()).toBeTrue()
		expect([...published.keys()]).toEqual([path])
	})

	test('writes the temporary and publishes the final path a caller asked for', async () => {
		const camera = await connected()
		const directory = await mkdtemp(join(capturesDir, 'session-'))
		const staged = join(directory, 'm42-lum-0.fit.partial')
		const final = join(directory, 'm42-lum-0.fit')
		const recording = recorder()

		const result = await capturer.start(coordinator, camera, request({ autoSave: true, outputPath: directory, outputName: 'm42-lum-0.fit.partial', publishPath: final }), { listener: recording.listener }).result

		expect(result.ok).toBeTrue()
		if (result.ok) expect(result.value.frames.map((frame) => frame.path)).toEqual([final])
		expect(recording.paths).toEqual([final])
		expect(await Bun.file(staged).exists()).toBeTrue()
		expect(await Bun.file(final).exists()).toBeFalse()
		expect([...published.keys()]).toEqual([final])
	})

	test('names a frame after the caller without a directory inside the captures directory', async () => {
		const camera = await connected()
		const recording = recorder()

		expect((await capturer.start(coordinator, camera, request({ outputName: 'named.fit' }), { listener: recording.listener }).result).ok).toBeTrue()
		expect(recording.paths).toEqual([join(capturesDir, 'named.fit')])
	})

	test('refuses a fixed output name asking for more than one frame', async () => {
		const camera = await connected()
		const startExposure = spyOn(cameraManager, 'startExposure')

		try {
			expect(await capturer.start(coordinator, camera, request({ exposureMode: 'fixed', count: 2, outputName: 'm42-lum-0.fit' })).result).toEqual(failedOperationResult('commandFailed', 'a fixed output name captures a single frame'))
			expect(await capturer.start(coordinator, camera, request({ exposureMode: 'loop', outputName: 'm42-lum-0.fit' })).result).toEqual(failedOperationResult('commandFailed', 'a fixed output name captures a single frame'))
			expect(startExposure).not.toHaveBeenCalled()
		} finally {
			startExposure.mockRestore()
		}
	})

	test('refuses a destination that would write outside the directory it names', async () => {
		const camera = await connected()
		const startExposure = spyOn(cameraManager, 'startExposure')

		try {
			const escaping = capturer.start(coordinator, camera, request({ outputPath: join(capturesDir, 'session'), outputName: `..${sep}..${sep}authorized_keys` }))
			expect(await escaping.result).toEqual(failedOperationResult('commandFailed', `the output name "..${sep}..${sep}authorized_keys" is not a valid file name`))

			const reserved = capturer.start(coordinator, camera, request({ outputPath: join(capturesDir, 'session'), outputName: 'nul.fit' }))
			expect(await reserved.result).toEqual(failedOperationResult('commandFailed', 'the output name "nul.fit" is not a valid file name'))

			const relative = capturer.start(coordinator, camera, request({ outputPath: 'session', outputName: 'm42-lum-0.fit' }))
			expect(await relative.result).toEqual(failedOperationResult('commandFailed', 'the output path "session" is not an absolute path'))

			expect(startExposure).not.toHaveBeenCalled()
		} finally {
			startExposure.mockRestore()
		}
	})

	test('refuses to overwrite the file a caller-supplied name already addresses', async () => {
		const camera = await connected()
		const directory = await mkdtemp(join(capturesDir, 'existing-'))
		const path = join(directory, 'm42-lum-0.fit')
		await Bun.write(path, 'a frame that is not this one')
		const startExposure = spyOn(cameraManager, 'startExposure')

		try {
			expect(await capturer.start(coordinator, camera, request({ autoSave: true, outputPath: directory, outputName: 'm42-lum-0.fit' })).result).toEqual(failedOperationResult('commandFailed', `the output file "${path}" already exists`))
			expect(startExposure).not.toHaveBeenCalled()
			expect(await Bun.file(path).text()).toBe('a frame that is not this one')
		} finally {
			startExposure.mockRestore()
		}
	})
})

describe('auto subfolder', () => {
	test('rolls a midnight folder over at local midnight', () => {
		expect(autoSubFolderName(Date.UTC(2026, 9, 9, 20), 'midnight', 0)).toBe('2026-10-09')
		expect(autoSubFolderName(Date.UTC(2026, 9, 9, 23, 59, 59, 999), 'midnight', 0)).toBe('2026-10-09')
		expect(autoSubFolderName(Date.UTC(2026, 9, 10, 0), 'midnight', 0)).toBe('2026-10-10')
		expect(autoSubFolderName(Date.UTC(2026, 9, 10, 2), 'midnight', 0)).toBe('2026-10-10')
	})

	test('keeps a whole night in the noon folder of the evening it began', () => {
		expect(autoSubFolderName(Date.UTC(2026, 9, 9, 12), 'noon', 0)).toBe('2026-10-09')
		expect(autoSubFolderName(Date.UTC(2026, 9, 9, 20), 'noon', 0)).toBe('2026-10-09')
		expect(autoSubFolderName(Date.UTC(2026, 9, 10, 2), 'noon', 0)).toBe('2026-10-09')
		expect(autoSubFolderName(Date.UTC(2026, 9, 10, 11, 59, 59, 999), 'noon', 0)).toBe('2026-10-09')
		expect(autoSubFolderName(Date.UTC(2026, 9, 10, 12), 'noon', 0)).toBe('2026-10-10')
	})

	test('applies the time zone offset before choosing the folder', () => {
		// 01:00 UTC on October 10 is 22:00 on October 9 three hours west of Greenwich.
		expect(autoSubFolderName(Date.UTC(2026, 9, 10, 1), 'midnight', -180)).toBe('2026-10-09')
		expect(autoSubFolderName(Date.UTC(2026, 9, 10, 1), 'noon', -180)).toBe('2026-10-09')
		// 23:00 UTC on October 9 is 08:00 on October 10 nine hours east, still the night of October 9.
		expect(autoSubFolderName(Date.UTC(2026, 9, 9, 23), 'midnight', 540)).toBe('2026-10-10')
		expect(autoSubFolderName(Date.UTC(2026, 9, 9, 23), 'noon', 540)).toBe('2026-10-09')
	})

	test('defaults to the local offset of the instant and has no folder when off', () => {
		const time = Date.UTC(2026, 9, 10, 2)
		expect(autoSubFolderName(time, 'noon')).toBe(autoSubFolderName(time, 'noon', -new Date(time).getTimezoneOffset()))
		expect(autoSubFolderName(time, 'off')).toBeUndefined()
	})
})

describe('base64 decoding', () => {
	test('decodes padded, unpadded and whitespace-wrapped payloads to their exact length', async () => {
		for (const length of [0, 1, 2, 3, 4, 5, 1000, 1001, 1002]) {
			const raw = Buffer.from(Array.from({ length }, (_, i) => (i * 37) & 255))
			const padded = raw.toString('base64')
			const unpadded = padded.replace(/=+$/, '')

			for (const encoded of [padded, unpadded, ` \r\n${padded}\n\t `]) {
				const decoded = await decodeCameraBlobFromBase64(Buffer.from(encoded))
				expect(decoded.byteLength).toBe(length)
				expect(Buffer.compare(decoded, raw)).toBe(0)
			}
		}
	})
})

describe('request validation', () => {
	test('fails both milestones and reports a rejected start when the capture cannot run', async () => {
		const camera = await connected()
		const startExposure = spyOn(cameraManager, 'startExposure')
		const cases = [
			[request({ exposureTime: 0 }), 'exposure time must be positive and finite'],
			[request({ exposureTime: -1 }), 'exposure time must be positive and finite'],
			[request({ exposureTime: Number.NaN }), 'exposure time must be positive and finite'],
			[request({ exposureTime: Number.POSITIVE_INFINITY }), 'exposure time must be positive and finite'],
			[request({ delay: -1 }), 'delay must be non-negative and finite'],
			[request({ delay: Number.NaN }), 'delay must be non-negative and finite'],
			[request({ delay: Number.POSITIVE_INFINITY }), 'delay must be non-negative and finite'],
			[request({ exposureMode: 'fixed', count: 0 }), 'frame count must be a positive integer'],
			[request({ exposureMode: 'fixed', count: 2.5 }), 'frame count must be a positive integer'],
			[request({ exposureMode: 'fixed', count: Number.NaN }), 'frame count must be a positive integer'],
		] as const

		try {
			for (const [capture, error] of cases) {
				const recording = recorder()
				const handle = capturer.start(coordinator, camera, capture, { listener: recording.listener })

				expect(await handle.started).toEqual(failedOperationResult('commandFailed', error))
				expect(await handle.result).toEqual(failedOperationResult('commandFailed', error))
				expect(recording.states).toEqual(['error', 'idle'])
				// An invalid request publishes finite, empty totals rather than whatever its fields would give.
				for (const event of recording.events) {
					expect(event.count).toBe(0)
					expect(event.totalExposureTime).toBe(0)
					expect(event.totalProgress.remainingTime).toBe(0)
					expect(event.frameExposureTime).toBe(0)
				}
			}

			// Mode-irrelevant fields are not validated.
			expect((await capturer.start(coordinator, camera, request({ exposureMode: 'single', count: Number.NaN })).result).ok).toBeTrue()
			expect(startExposure).toHaveBeenCalledTimes(1)
		} finally {
			startExposure.mockRestore()
		}
	})

	test('refuses a disconnected camera before a session exists', async () => {
		const camera = getCamera()
		const rejected = recorder()
		const accepted = recorder()

		const handle = capturer.start(coordinator, camera, request(), { listener: accepted.listener, rejectedListener: rejected.listener })

		expect(await handle.started).toMatchObject(failedOperationResult('busy'))
		expect(await handle.result).toMatchObject(failedOperationResult('busy'))
		expect(rejected.states).toEqual(['error', 'idle'])
		expect(rejected.events.every((event) => event.operation === handle.id && event.camera === camera.id && event.generation === 0)).toBeTrue()
		expect(rejected.events[0].session).not.toBeEmpty()
		expect(rejected.events.at(-1)!.stopped).toBeTrue()
		expect(accepted.records).toBeEmpty()
	})

	test('fails a camera that disconnected inside a composite that already holds it', async () => {
		const camera = await connected()
		const recording = recorder()

		const feature = coordinator.start('feature', [{ key: keyOf(camera), device: camera }], async (context) => {
			cameraManager.disconnect(camera)
			await waitUntil(() => !camera.connected, 5000, 10)
			return await capturer.start(context, camera, request(), { listener: recording.listener }).result
		})

		const result = await feature.result
		expect(result.ok).toBeFalse()
		expect(recording.states.slice(-2)).toEqual(['error', 'idle'])
	})
})

describe('device failures', () => {
	test('times out when exposure completion never arrives', async () => {
		const camera = await connected()
		const own = createCapturer({ frameGraceTime: 200 })
		const completion = holdExposureUpdates(own, 'Ok')
		const blobs = holdBlobs(own)
		const stopExposure = spyOn(cameraManager, 'stopExposure')
		const disableBlob = spyOn(cameraManager, 'disableBlob')
		const recording = recorder()

		try {
			const handle = own.start(coordinator, camera, request(), { listener: recording.listener })
			expect(await handle.started).toEqual(successfulOperationResult(undefined))
			expect(await handle.result).toEqual(failedOperationResult('timeout'))
			expect(recording.states.slice(-2)).toEqual(['error', 'idle'])
			expect(recording.states.filter((state) => state === 'error')).toHaveLength(1)
			expect(recording.states.filter((state) => state === 'idle')).toHaveLength(1)
			expect(stopExposure).toHaveBeenCalledTimes(1)
			expect(disableBlob).toHaveBeenCalledTimes(1)
			expect(published).toBeEmpty()
			// The frame the driver produced never reached the session, so the camera waits for it.
			expect(arbiter.availability(keyOf(camera))).toBe('unavailable')
		} finally {
			completion.spy.mockRestore()
			blobs.spy.mockRestore()
			stopExposure.mockRestore()
			disableBlob.mockRestore()
			own.dispose()
		}
	})

	test('times out when exposure completes without a BLOB', async () => {
		const camera = await connected()
		const own = createCapturer({ frameGraceTime: 200 })
		const blobs = holdBlobs(own)
		const recording = recorder()

		try {
			const handle = own.start(coordinator, camera, request(), { listener: recording.listener })
			expect((await handle.started).ok).toBeTrue()
			expect(await handle.result).toEqual(failedOperationResult('timeout'))
			expect(recording.states).toContain('exposureFinished')
			expect(recording.paths).toBeEmpty()
			expect(published).toBeEmpty()
		} finally {
			blobs.spy.mockRestore()
			own.dispose()
		}
	})

	test('quarantines a dispatched exposure whose Busy was never observed until a payload arrives', async () => {
		const camera = await connected()
		const own = createCapturer({ frameGraceTime: 200 })
		const startExposure = spyOn(cameraManager, 'startExposure').mockImplementation(() => {})
		const key = keyOf(camera)

		try {
			const handle = own.start(coordinator, camera, request())

			expect(await handle.started).toEqual(failedOperationResult('timeout'))
			expect(await handle.result).toEqual(failedOperationResult('timeout'))
			expect(arbiter.availability(key)).toBe('unavailable')
			expect(await own.start(coordinator, camera, request()).result).toMatchObject(failedOperationResult('busy'))

			// A real frame from the driver is the payload the quarantine waits for, and it is discarded. Cleanup
			// disabled BLOB delivery, so whoever exposes next enables it again.
			startExposure.mockRestore()
			cameraManager.enableBlob(camera)
			cameraManager.startExposure(camera, 0.1)
			await waitUntil(() => arbiter.availability(key) === 'available', 5000, 10)
			expect(published).toBeEmpty()

			expect((await own.start(coordinator, camera, request()).result).ok).toBeTrue()
		} finally {
			startExposure.mockRestore()
			own.dispose()
		}
	})

	test('fails with alert when the driver reports the exposure failed', async () => {
		const camera = await connected()
		const recording = recorder()

		const handle = capturer.start(coordinator, camera, request({ exposureTime: 2, exposureTimeUnit: 'second' }), { listener: recording.listener })

		expect((await handle.started).ok).toBeTrue()
		cameraSimulator.abortExposure(true)
		expect(await handle.result).toEqual(failedOperationResult('alert'))
		expect(recording.paths).toBeEmpty()
		expect(published).toBeEmpty()
		// Alert settles the payload debt, so the camera is immediately usable again.
		expect(arbiter.availability(keyOf(camera))).toBe('available')
		expect((await capturer.start(coordinator, camera, request()).result).ok).toBeTrue()
	})

	test('fails immediately when an active exposure becomes idle', async () => {
		const camera = await connected()
		const stopExposure = spyOn(cameraManager, 'stopExposure')

		try {
			const handle = capturer.start(coordinator, camera, request({ exposureTime: 2, exposureTimeUnit: 'second' }))
			expect((await handle.started).ok).toBeTrue()
			cameraSimulator.abortExposure()

			expect(await handle.result).toEqual(failedOperationResult('unexpectedState', 'exposure became idle before completion'))
			expect(stopExposure).not.toHaveBeenCalled()
			expect(arbiter.availability(keyOf(camera))).toBe('available')
		} finally {
			stopExposure.mockRestore()
		}
	})

	test('fails the active session when the camera disconnects', async () => {
		const camera = await connected()
		const disableBlob = spyOn(cameraManager, 'disableBlob')

		try {
			const handle = capturer.start(coordinator, camera, request({ exposureTime: 2, exposureTimeUnit: 'second' }))
			expect((await handle.started).ok).toBeTrue()
			cameraManager.disconnect(camera)

			// The simulator aborts the exposure to Idle on its way down, which only adds detail to the cause.
			expect(await handle.result).toMatchObject(failedOperationResult('disconnected'))
			expect(arbiter.availability(keyOf(camera))).toBe('unavailable')
			expect(disableBlob).not.toHaveBeenCalled()

			await connected()
			expect((await capturer.start(coordinator, camera, request()).result).ok).toBeTrue()
		} finally {
			disableBlob.mockRestore()
		}
	})

	test('fails the active session when the camera is removed', async () => {
		const camera = await connected()
		const key = keyOf(camera)
		const stopExposure = spyOn(cameraManager, 'stopExposure')
		const disableBlob = spyOn(cameraManager, 'disableBlob')

		try {
			const handle = capturer.start(coordinator, camera, request({ exposureTime: 2, exposureTimeUnit: 'second' }))
			expect((await handle.started).ok).toBeTrue()
			// The server deletes the device while it is still connected and exposing, as when its driver dies.
			handlers.delProperty(client, { device: camera.name })

			expect(await handle.result).toEqual(failedOperationResult('removed'))
			expect(arbiter.availability(key)).toBe('unavailable')
			expect(stopExposure).not.toHaveBeenCalled()
			expect(disableBlob).not.toHaveBeenCalled()
		} finally {
			stopExposure.mockRestore()
			disableBlob.mockRestore()
			cameraSimulator.dispose()
			cameraSimulator = createCameraSimulator()
		}

		const rediscovered = await connected()
		expect(rediscovered).not.toBe(camera)
		expect((await capturer.start(coordinator, rediscovered, request()).result).ok).toBeTrue()
	})

	test('fails without waiting the delay out when the camera disconnects between frames', async () => {
		// No lifecycle here, so nothing but the session itself can end the delay.
		const isolated = new ResourceArbiter()
		const isolatedCoordinator = new OperationCoordinator(isolated)
		const own = createCapturer({}, isolated)
		const camera = await connected()
		const recording = recorder()
		const listener: CameraCaptureListener = (event, path) => {
			if (event.state === 'waiting' && camera.connected) cameraManager.disconnect(camera)
			recording.listener(event, path)
		}

		try {
			const start = performance.now()
			const result = await own.start(isolatedCoordinator, camera, request({ exposureMode: 'fixed', count: 2, delay: 10 }), { listener }).result

			expect(result).toEqual(failedOperationResult('disconnected'))
			expect(performance.now() - start).toBeLessThan(3000)
			expect(recording.paths).toHaveLength(1)
			expect(recording.states.slice(-2)).toEqual(['error', 'idle'])
		} finally {
			own.dispose()
		}
	})

	test('does not override an external busy verdict when a property update arrives', async () => {
		const camera = await connected()
		const key = keyOf(camera)

		try {
			cameraManager.startExposure(camera, 2)
			await waitUntil(() => arbiter.availability(key) === 'unavailable', 5000, 10)

			capturer.updated(camera, 'connected')

			expect(arbiter.availability(key)).toBe('unavailable')
		} finally {
			cameraManager.stopExposure(camera)
		}
	})
})

describe('cleanup', () => {
	test('aborts a dispatched exposure before Busy is observed', async () => {
		const camera = await connected()
		const startExposure = spyOn(cameraManager, 'startExposure').mockImplementation(() => {})
		const stopExposure = spyOn(cameraManager, 'stopExposure')

		try {
			const handle = capturer.start(coordinator, camera, request())
			await waitUntil(() => startExposure.mock.calls.length === 1, 5000, 10)
			await handle.cancel()

			expect(await handle.started).toEqual(failedOperationResult('aborted'))
			expect(await handle.result).toEqual(failedOperationResult('aborted'))
			expect(stopExposure).toHaveBeenCalledTimes(1)
		} finally {
			startExposure.mockRestore()
			stopExposure.mockRestore()
		}
	})

	test('allows another capture right after the driver aborts the exposure to idle', async () => {
		const camera = await connected()
		const handle = capturer.start(coordinator, camera, request({ exposureTime: 2, exposureTimeUnit: 'second' }))
		expect((await handle.started).ok).toBeTrue()
		await handle.cancel()

		expect(await handle.result).toEqual(failedOperationResult('aborted'))
		expect(camera.exposuring).toBeFalse()
		expect(arbiter.availability(keyOf(camera))).toBe('available')
		expect((await capturer.start(coordinator, camera, request()).result).ok).toBeTrue()
	})

	test('quarantines a camera until its outstanding BLOB is discarded', async () => {
		const camera = await connected()
		const key = keyOf(camera)
		const blobs = holdBlobs(capturer)
		const recording = recorder()

		try {
			const handle = capturer.start(coordinator, camera, request(), { listener: recording.listener })
			expect((await handle.started).ok).toBeTrue()
			await waitUntil(() => blobs.held.length > 0 && camera.exposure.state === 'Ok', 5000, 10)
			await handle.cancel()

			expect(await handle.result).toEqual(failedOperationResult('aborted'))
			expect(arbiter.availability(key)).toBe('unavailable')
			expect(await capturer.start(coordinator, camera, request()).result).toMatchObject(failedOperationResult('busy'))

			blobs.spy.mockRestore()
			capturer.blobReceived(...blobs.held[0])
			expect(arbiter.availability(key)).toBe('available')
			expect(recording.paths).toBeEmpty()
			expect(published).toBeEmpty()

			expect((await capturer.start(coordinator, camera, request()).result).ok).toBeTrue()
		} finally {
			blobs.spy.mockRestore()
		}
	})

	test('releases a quarantine when the driver ends an exposure without a payload', async () => {
		const camera = await connected()
		const key = keyOf(camera)
		const blobs = holdBlobs(capturer)

		try {
			const handle = capturer.start(coordinator, camera, request())
			await waitUntil(() => blobs.held.length > 0 && camera.exposure.state === 'Ok', 5000, 10)
			await handle.cancel()
			expect(arbiter.availability(key)).toBe('unavailable')
			blobs.spy.mockRestore()

			// The driver later reports a failed exposure, so the payload being waited for will never come.
			cameraManager.startExposure(camera, 2)
			await waitUntil(() => camera.exposuring, 5000, 10)
			cameraSimulator.abortExposure(true)

			await waitUntil(() => arbiter.availability(key) === 'available', 5000, 10)
			expect((await capturer.start(coordinator, camera, request()).result).ok).toBeTrue()
		} finally {
			blobs.spy.mockRestore()
		}
	})

	test('keeps an externally exposing camera unavailable after discarding a stale BLOB', async () => {
		const camera = await connected()
		const key = keyOf(camera)
		const blobs = holdBlobs(capturer)

		try {
			const handle = capturer.start(coordinator, camera, request())
			await waitUntil(() => blobs.held.length > 0 && camera.exposure.state === 'Ok', 5000, 10)
			await handle.cancel()
			blobs.spy.mockRestore()

			// Lifecycle observes external activity while the payload is still outstanding.
			cameraManager.startExposure(camera, 2)
			await waitUntil(() => camera.exposuring, 5000, 10)
			capturer.blobReceived(...blobs.held[0])

			expect(arbiter.availability(key)).toBe('unavailable')
			expect(await capturer.start(coordinator, camera, request()).result).toMatchObject(failedOperationResult('busy'))
		} finally {
			blobs.spy.mockRestore()
			cameraManager.stopExposure(camera)
		}
	})

	test('quarantines a pending BLOB when disabling delivery fails', async () => {
		const camera = await connected()
		const key = keyOf(camera)
		const blobs = holdBlobs(capturer)
		const disableBlob = spyOn(cameraManager, 'disableBlob').mockImplementation(() => {
			throw new Error('disable BLOB failed')
		})

		try {
			const handle = capturer.start(coordinator, camera, request())
			await waitUntil(() => blobs.held.length > 0 && camera.exposure.state === 'Ok', 5000, 10)
			await handle.cancel()

			expect(await handle.result).toEqual({ ok: false, reason: 'aborted', error: 'cleanup failed: disable BLOB failed' })
			expect(arbiter.availability(key)).toBe('unavailable')
			expect(await capturer.start(coordinator, camera, request()).result).toMatchObject(failedOperationResult('busy'))
		} finally {
			blobs.spy.mockRestore()
			disableBlob.mockRestore()
		}
	})

	test('blocks the camera when a cancelled exposure never quiesces', async () => {
		const camera = await connected()
		const key = keyOf(camera)
		const own = createCapturer({ quiesceTimeout: 100 })
		const stopExposure = spyOn(cameraManager, 'stopExposure').mockImplementation(() => {})

		try {
			const handle = own.start(coordinator, camera, request({ exposureTime: 500 }))
			expect((await handle.started).ok).toBeTrue()
			await handle.cancel()

			expect(await handle.result).toEqual({ ok: false, reason: 'aborted', error: 'cleanup failed: camera exposure did not quiesce before cleanup timeout' })
			expect(arbiter.availability(key)).toBe('unavailable')
			expect(await own.start(coordinator, camera, request()).result).toMatchObject(failedOperationResult('busy'))

			// The exposure runs on to its end with BLOB delivery disabled, so only a payload already in flight can
			// clear the quarantine; lifecycle then finds the camera at rest.
			await waitUntil(() => camera.exposure.state === 'Ok', 5000, 10)
			expect(arbiter.availability(key)).toBe('unavailable')
			own.blobReceived(camera, Buffer.from('frame in flight'), 'raw')
			await waitUntil(() => arbiter.availability(key) === 'available', 5000, 10)
			expect(published).toBeEmpty()
		} finally {
			stopExposure.mockRestore()
			own.dispose()
		}
	})

	test('degrades a completed capture whose camera never quiesces', async () => {
		const camera = await connected()
		const key = keyOf(camera)
		const stopExposure = spyOn(cameraManager, 'stopExposure').mockImplementation(() => {})
		// Someone else starts exposing while the frame is still being written.
		const own = createCapturer({
			quiesceTimeout: 100,
			write: async () => {
				cameraManager.startExposure(camera, 0.5)
				await waitUntil(() => camera.exposuring, 5000, 10)
			},
		})

		try {
			const result = await own.start(coordinator, camera, request({ autoSave: true })).result

			expect(result).toEqual({ ok: false, reason: 'timeout', error: 'cleanup failed: camera exposure did not quiesce before cleanup timeout' })
			expect(arbiter.availability(key)).toBe('unavailable')
		} finally {
			stopExposure.mockRestore()
			own.dispose()
			await waitUntil(() => !camera.exposuring, 5000, 10)
		}
	})

	test('retains the lease through cleanup and discards a late BLOB', async () => {
		const camera = await connected()
		const recording = recorder()
		const active = capturer.start(coordinator, camera, request({ exposureMode: 'loop', exposureTime: 500 }), { listener: recording.listener })
		expect((await active.started).ok).toBeTrue()

		const cancellation = active.cancel()
		capturer.blobReceived(camera, Buffer.from('late frame'), 'raw')
		expect(await capturer.start(coordinator, camera, request()).result).toMatchObject(failedOperationResult('busy'))
		await cancellation

		expect(recording.paths).toBeEmpty()
		expect(published).toBeEmpty()
		expect((await capturer.start(coordinator, camera, request()).result).ok).toBeTrue()
	})

	test('retains ownership until a cancelled decode settles', async () => {
		const camera = await connected()
		const key = keyOf(camera)
		const decoding = Promise.withResolvers<Buffer>()
		let decodeStarted = false
		const own = createCapturer({
			decode: () => {
				decodeStarted = true
				return decoding.promise
			},
		})
		const blobs = holdBlobs(own)
		blobs.spy.mockImplementation((device, data) => blobs.original(device, Buffer.from(data.toString('base64')), 'base64'))
		const recording = recorder()

		try {
			const handle = own.start(coordinator, camera, request(), { listener: recording.listener })
			await waitUntil(() => decodeStarted, 5000, 10)

			let cancelled = false
			const cancellation = handle.cancel().then(() => {
				cancelled = true
			})
			await Bun.sleep(20)
			expect(cancelled).toBeFalse()
			expect(arbiter.availability(key)).toBe('leased')

			decoding.resolve(Buffer.from('frame'))
			await cancellation
			expect(await handle.result).toEqual(failedOperationResult('aborted'))
			expect(recording.paths).toBeEmpty()
			expect(published).toBeEmpty()
		} finally {
			blobs.spy.mockRestore()
			own.dispose()
		}
	})

	test('retains ownership until a cancelled auto-save write settles', async () => {
		const camera = await connected()
		const key = keyOf(camera)
		const writing = Promise.withResolvers<number>()
		let writeStarted = false
		const own = createCapturer({
			write: () => {
				writeStarted = true
				return writing.promise
			},
		})
		const recording = recorder()

		try {
			const handle = own.start(coordinator, camera, request({ autoSave: true }), { listener: recording.listener })
			await waitUntil(() => writeStarted, 5000, 10)

			let cancelled = false
			const cancellation = handle.cancel().then(() => {
				cancelled = true
			})
			await Bun.sleep(20)
			expect(cancelled).toBeFalse()
			expect(arbiter.availability(key)).toBe('leased')

			writing.resolve(1)
			await cancellation
			expect(await handle.result).toEqual(failedOperationResult('aborted'))
			expect(recording.paths).toBeEmpty()
		} finally {
			own.dispose()
		}
	})

	test('fails the frame when the auto-save write fails', async () => {
		const camera = await connected()
		const own = createCapturer({ write: () => Promise.reject(new Error('disk full')) })
		const recording = recorder()

		try {
			const result = await own.start(coordinator, camera, request({ autoSave: true }), { listener: recording.listener }).result

			expect(result).toEqual(failedOperationResult('commandFailed', 'disk full'))
			expect(recording.paths).toBeEmpty()
			expect(recording.states.slice(-2)).toEqual(['error', 'idle'])
		} finally {
			own.dispose()
		}
	})

	test('cancels an inter-frame delay before dispatching another exposure', async () => {
		const camera = await connected()
		const startExposure = spyOn(cameraManager, 'startExposure')
		const waiting = Promise.withResolvers<void>()
		const recording = recorder()
		const listener: CameraCaptureListener = (event, path) => {
			if (event.state === 'waiting') waiting.resolve()
			recording.listener(event, path)
		}

		try {
			const handle = capturer.start(coordinator, camera, request({ exposureMode: 'fixed', count: 2, delay: 1 }), { listener })
			await waiting.promise
			await handle.cancel()

			expect(await handle.result).toEqual(failedOperationResult('aborted'))
			expect(startExposure).toHaveBeenCalledTimes(1)
			expect(recording.states.slice(-2)).toEqual(['error', 'idle'])
		} finally {
			startExposure.mockRestore()
		}
	})
})

describe('operation trees', () => {
	test('captures inside a composite operation that already owns the camera', async () => {
		const camera = await connected()
		const key = keyOf(camera)
		const captured = Promise.withResolvers<OperationResult<CameraCaptureResult>>()

		const feature = coordinator.start('autofocus', [{ key, device: camera }], async (context) => {
			const result = await capturer.start(context, camera, request()).result
			captured.resolve(result)

			// The nested capture released its own lease, but the feature still owns the camera.
			expect(arbiter.availability(key)).toBe('leased')
			expect(context.owns(key)).toBeTrue()
			return result.ok ? successfulOperationResult(result.value.frameCount) : result
		})

		expect((await captured.promise).ok).toBeTrue()
		expect(await feature.result).toEqual(successfulOperationResult(1))
		expect(arbiter.availability(key)).toBe('available')
	})

	test('refuses a second capture nested in the same composite operation', async () => {
		const camera = await connected()
		const key = keyOf(camera)

		const feature = coordinator.start('autofocus', [{ key, device: camera }], async (context) => {
			const first = capturer.start(context, camera, request())
			expect((await first.started).ok).toBeTrue()

			// A sibling scope must not take a camera the tree is already exposing with.
			expect(await capturer.start(context, camera, request()).result).toMatchObject(failedOperationResult('busy'))
			return await first.result
		})

		expect((await feature.result).ok).toBeTrue()
		expect(arbiter.availability(key)).toBe('available')
	})

	test('cancelling by device stops a capture nested in another operation', async () => {
		const camera = await connected()
		const recording = recorder()

		const composite = coordinator.start('autofocus', [{ key: keyOf(camera), device: camera }], (context) => capturer.start(context, camera, request({ exposureMode: 'loop', exposureTime: 200 }), { listener: recording.listener }).result)
		await waitUntil(() => recording.states.includes('exposing'), 5000, 10)
		await coordinator.cancelByDevice(keyOf(camera))

		expect(await composite.result).toMatchObject(failedOperationResult('aborted'))
		expect(recording.events.some((event) => event.state === 'idle' && event.stopped)).toBeTrue()
	})

	test('rejects a conflicting capture without disturbing the active session', async () => {
		const camera = await connected()
		const active = recorder()
		const rejected = recorder()
		const snoop = spyOn(cameraManager, 'snoop')

		try {
			const handle = capturer.start(coordinator, camera, request({ exposureMode: 'loop', exposureTime: 200 }), { listener: active.listener })
			expect((await handle.started).ok).toBeTrue()

			const conflicting = capturer.start(coordinator, camera, request({ mount: 'Mount Simulator' }), { listener: rejected.listener })
			expect(await conflicting.started).toMatchObject(failedOperationResult('busy'))
			expect(await conflicting.result).toMatchObject(failedOperationResult('busy'))
			expect(rejected.states).toEqual(['error', 'idle'])
			expect(rejected.events.every((event) => event.operation === conflicting.id && event.generation === 0)).toBeTrue()
			expect(active.events.every((event) => event.operation === handle.id)).toBeTrue()
			expect(snoop).toHaveBeenCalledTimes(1)

			await handle.cancel()
			expect(await handle.result).toEqual(failedOperationResult('aborted'))
			expect(active.events.some((event) => event.state === 'idle' && event.stopped)).toBeTrue()
		} finally {
			snoop.mockRestore()
		}
	})
})

describe('dithering', () => {
	test('dithers before each exposure when the named guider is guiding', async () => {
		const camera = await connected()
		const calls: [string, CameraDither, AbortSignal | undefined][] = []
		const ditherer: CameraDitherer = {
			running: () => true,
			dither: (guider, dither, options) => {
				calls.push([guider, dither, options?.signal])
				options?.onPhase?.('dithered')
				options?.onPhase?.('settling')
				options?.onPhase?.('settled')
				return Promise.resolve(successfulOperationResult(undefined))
			},
		}
		const own = createCapturer({ ditherer })
		const recording = recorder()
		const capture = request({ exposureMode: 'fixed', count: 2, dither: { enabled: true, guider: 'guider-1', amount: 3, raOnly: true } })

		try {
			expect((await own.start(coordinator, camera, capture, { listener: recording.listener }).result).ok).toBeTrue()

			expect(calls).toHaveLength(2)
			expect(calls[0][0]).toBe('guider-1')
			expect(calls[0][1]).toEqual(capture.dither)
			expect(calls[0][2]).toBeInstanceOf(AbortSignal)
			expect(recording.states[0]).toBe('dithering')
			expect(recording.states.indexOf('settling')).toBeLessThan(recording.states.indexOf('exposureStarted'))
			expectSuccessfulEventFlow(
				recording.records.filter(({ event }) => event.state !== 'dithering' && event.state !== 'settling'),
				2,
			)
		} finally {
			own.dispose()
		}
	})

	test('does not expose when the dither fails', async () => {
		const camera = await connected()
		const ditherer: CameraDitherer = { running: () => true, dither: () => Promise.resolve(failedOperationResult('timeout', 'settle timed out')) }
		const own = createCapturer({ ditherer })
		const startExposure = spyOn(cameraManager, 'startExposure')
		const recording = recorder()

		try {
			const result = await own.start(coordinator, camera, request({ dither: { enabled: true, guider: 'guider-1' } }), { listener: recording.listener }).result

			expect(result).toEqual(failedOperationResult('commandFailed', 'settle timed out'))
			expect(startExposure).not.toHaveBeenCalled()
			expect(recording.states).toEqual(['dithering', 'error', 'idle'])
		} finally {
			startExposure.mockRestore()
			own.dispose()
		}
	})

	test('fails a dither the guider abandoned on its own instead of reporting a cancellation', async () => {
		const camera = await connected()
		const ditherer: CameraDitherer = { running: () => true, dither: () => Promise.resolve(failedOperationResult('aborted', 'guider stopped')) }
		const own = createCapturer({ ditherer })

		try {
			const result = await own.start(coordinator, camera, request({ dither: { enabled: true, guider: 'guider-1' } })).result
			expect(result).toEqual(failedOperationResult('commandFailed', 'guider stopped'))
		} finally {
			own.dispose()
		}
	})

	test('fails a dither that throws', async () => {
		const camera = await connected()
		const ditherer: CameraDitherer = {
			running: () => true,
			dither: () => {
				throw new Error('guider unreachable')
			},
		}
		const own = createCapturer({ ditherer })

		try {
			expect(await own.start(coordinator, camera, request({ dither: { enabled: true, guider: 'guider-1' } })).result).toEqual(failedOperationResult('commandFailed', 'guider unreachable'))
		} finally {
			own.dispose()
		}
	})

	test('does not expose when the named guider is not guiding', async () => {
		const camera = await connected()
		let dithered = false
		const ditherer: CameraDitherer = {
			running: () => false,
			dither: () => {
				dithered = true
				return Promise.resolve(successfulOperationResult(undefined))
			},
		}
		const own = createCapturer({ ditherer })
		const startExposure = spyOn(cameraManager, 'startExposure')

		try {
			const result = await own.start(coordinator, camera, request({ dither: { enabled: true, guider: 'guider-1' } })).result

			expect(result).toEqual(failedOperationResult('unexpectedState', 'guider guider-1 is not guiding'))
			expect(dithered).toBeFalse()
			expect(startExposure).not.toHaveBeenCalled()
		} finally {
			startExposure.mockRestore()
			own.dispose()
		}
	})

	test('skips the dither without failing when no guider was chosen or dithering is disabled', async () => {
		const camera = await connected()
		const ditherer: CameraDitherer = {
			running: () => {
				throw new Error('the capture must not ask about a guider it did not name')
			},
			dither: () => Promise.resolve(failedOperationResult('commandFailed')),
		}
		const own = createCapturer({ ditherer })

		try {
			for (const dither of [{ enabled: true }, { enabled: false, guider: 'guider-1' }]) {
				const recording = recorder()
				expect((await own.start(coordinator, camera, request({ dither }), { listener: recording.listener }).result).ok).toBeTrue()
				expect(recording.states).not.toContain('dithering')
			}

			// Without a ditherer there is nobody to ask, which is the same as not dithering.
			expect((await capturer.start(coordinator, camera, request({ dither: { enabled: true, guider: 'guider-1' } })).result).ok).toBeTrue()
		} finally {
			own.dispose()
		}
	})

	test('aborts the dither when the capture stops', async () => {
		const camera = await connected()
		let signal: AbortSignal | undefined
		const ditherer: CameraDitherer = {
			running: () => true,
			dither: (_, __, options?: CameraDitherOptions) => {
				signal = options?.signal
				return new Promise((resolve) => {
					options?.signal?.addEventListener('abort', () => resolve(failedOperationResult('aborted')), { once: true })
				})
			},
		}
		const own = createCapturer({ ditherer })
		const recording = recorder()

		try {
			const handle = own.start(coordinator, camera, request({ dither: { enabled: true, guider: 'guider-1' } }), { listener: recording.listener })
			await waitUntil(() => recording.states.includes('dithering'), 5000, 10)
			await handle.cancel()

			expect(await handle.result).toEqual(failedOperationResult('aborted'))
			expect(signal?.aborted).toBeTrue()
			expect(recording.states).not.toContain('exposureStarted')
			expect(recording.events.some((event) => event.state === 'idle' && event.stopped)).toBeTrue()
		} finally {
			own.dispose()
		}
	})
})
