import { beforeEach, describe, expect, test } from 'bun:test'
import { pixelScale } from '../../../src/astronomy/formulas'
import type { PHD2Events } from '../../../src/devices/guiding/phd2'
import { type Camera, DEFAULT_CAMERA, DEFAULT_GUIDE_OUTPUT, type GuideDirection, type GuideOutput } from '../../../src/devices/indi/device'
import type { CameraManager, DeviceHandler, GuideOutputManager } from '../../../src/devices/indi/manager'
import { writeImageToFits } from '../../../src/imaging/model/image'
import type { Image } from '../../../src/imaging/model/types'
import { bufferSink } from '../../../src/io/io'
import { GuiderClient, type GuiderClientConnectOptions, type GuiderClientOptions } from '../../../src/observation/guiding/client'

// One recorded pulse issued through the fake guide-output manager.
interface PulseRecord {
	readonly direction: GuideDirection
	readonly duration: number
}

// Records the camera-manager calls the GuiderClient makes and captures the blob handler so tests can feed frames.
class FakeCameraManager {
	handler?: DeviceHandler<Camera>
	blobEnabled = false
	readonly startExposureCalls: number[] = []
	stopExposureCount = 0
	enableBlobCount = 0
	disableBlobCount = 0
	removeHandlerCount = 0

	addHandler(handler: DeviceHandler<Camera>) {
		this.handler = handler
	}

	removeHandler() {
		this.removeHandlerCount++
		this.handler = undefined
	}

	enableBlob() {
		this.enableBlobCount++
		this.blobEnabled = true
	}

	disableBlob() {
		this.disableBlobCount++
		this.blobEnabled = false
	}

	startExposure(_camera: Camera, exposure: number) {
		this.startExposureCalls.push(exposure)
	}

	stopExposure() {
		this.stopExposureCount++
	}
}

// Records every pulse the GuiderClient routes through the guide output.
class FakeGuideOutputManager {
	readonly pulses: PulseRecord[] = []

	pulse(_device: GuideOutput, direction: GuideDirection, duration: number) {
		this.pulses.push({ direction, duration })
	}
}

// Star centers (image pixels) plotted into the synthetic guide frame.
const STAR_A = [70, 70] as const
const STAR_B = [165, 150] as const
const FRAME_WIDTH = 240
const FRAME_HEIGHT = 240

// Adds one circular Gaussian star to a flat float background, in ADU.
function plotGaussianStar(raw: Float32Array, width: number, height: number, cx: number, cy: number, peak: number, sigma: number) {
	const radius = Math.ceil(sigma * 5)
	const twoSigmaSq = 2 * sigma * sigma

	for (let dy = -radius; dy <= radius; dy++) {
		for (let dx = -radius; dx <= radius; dx++) {
			const x = cx + dx
			const y = cy + dy
			if (x < 0 || y < 0 || x >= width || y >= height) continue
			raw[y * width + x] += peak * Math.exp(-(dx * dx + dy * dy) / twoSigmaSq)
		}
	}
}

// Builds an in-memory FITS buffer with two well-separated stars on a flat background.
// The flat background keeps star detection deterministic (exactly the two plotted centroids).
async function buildFrameBuffer(): Promise<Buffer> {
	const raw = new Float32Array(FRAME_WIDTH * FRAME_HEIGHT).fill(300)
	plotGaussianStar(raw, FRAME_WIDTH, FRAME_HEIGHT, STAR_A[0], STAR_A[1], 30000, 1.5)
	plotGaussianStar(raw, FRAME_WIDTH, FRAME_HEIGHT, STAR_B[0], STAR_B[1], 21000, 1.6)

	const image: Image = {
		header: { SIMPLE: true, BITPIX: -32, NAXIS: 2, NAXIS1: FRAME_WIDTH, NAXIS2: FRAME_HEIGHT },
		metadata: { width: FRAME_WIDTH, height: FRAME_HEIGHT, channels: 1, pixelCount: FRAME_WIDTH * FRAME_HEIGHT, pixelSizeInBytes: 4, strideInBytes: FRAME_WIDTH * 4, stride: FRAME_WIDTH, bitpix: -32, bayer: undefined },
		raw,
	}

	const buffer = Buffer.alloc(FRAME_WIDTH * FRAME_HEIGHT * 4 + 100000)
	await writeImageToFits(image, bufferSink(buffer))
	return buffer
}

const FRAME_BUFFER = await buildFrameBuffer()

// Builds a connected-capable camera with sensible defaults overridable per test.
function makeCamera(overrides: Partial<Camera> = {}): Camera {
	const camera = structuredClone(DEFAULT_CAMERA)
	camera.id = 'camera-1'
	camera.name = 'Guide Camera'
	camera.connected = true
	camera.canPulseGuide = true
	camera.frame.width.value = FRAME_WIDTH
	camera.frame.height.value = FRAME_HEIGHT
	camera.bin.x.value = 1
	camera.bin.y.value = 1
	return Object.assign(camera, overrides)
}

// Builds a connected guide-output device.
function makeGuideOutput(overrides: Partial<GuideOutput> = {}): GuideOutput {
	const output = structuredClone(DEFAULT_GUIDE_OUTPUT)
	output.id = 'guide-1'
	output.name = 'Mount'
	output.connected = true
	output.canPulseGuide = true
	return Object.assign(output, overrides)
}

interface Harness {
	readonly client: GuiderClient
	readonly cameraManager: FakeCameraManager
	readonly guideOutputManager: FakeGuideOutputManager
	readonly events: PHD2Events[]
	readonly camera: Camera
	readonly guideOutput: GuideOutput
	frameCount: number
}

// Creates a fresh client wired to fake managers and an event recorder.
function makeHarness(options: GuiderClientOptions = {}): Harness {
	const cameraManager = new FakeCameraManager()
	const guideOutputManager = new FakeGuideOutputManager()
	const events: PHD2Events[] = []
	const client = new GuiderClient(cameraManager as unknown as CameraManager, guideOutputManager as unknown as GuideOutputManager, {
		...options,
		handler: { event: (_client, event) => events.push(event) },
	})

	return { client, cameraManager, guideOutputManager, events, camera: makeCamera(), guideOutput: makeGuideOutput(), frameCount: 0 }
}

// Connects the harness client to its camera/guide output.
function connect(harness: Harness, options?: GuiderClientConnectOptions) {
	return harness.client.connect(harness.camera, harness.guideOutput, options)
}

// Feeds one synthetic frame through the captured blob handler and waits until the client has processed it.
async function feedFrame(harness: Harness) {
	const handler = harness.cameraManager.handler
	expect(handler?.blobReceived).toBeDefined()

	const expected = ++harness.frameCount
	handler!.blobReceived!(harness.camera, FRAME_BUFFER as Buffer<ArrayBuffer>)

	for (let i = 0; i < 1000; i++) {
		const image = harness.client.getStarImage()
		if (image !== undefined && image.frame >= expected) return image
		await Bun.sleep(1)
	}

	throw new Error('frame was not processed in time')
}

// Returns all recorded events of one type.
function eventsOf<T extends PHD2Events['Event']>(events: readonly PHD2Events[], type: T) {
	return events.filter((event) => event.Event === type) as Extract<PHD2Events, { Event: T }>[]
}

let harness: Harness

beforeEach(() => {
	harness = makeHarness()
})

describe('construction', () => {
	test('clamps the search region into the supported pixel range', () => {
		expect(makeHarness({ searchRegion: 4 }).client.getSearchRegion()).toBe(16)
		expect(makeHarness({ searchRegion: 1000 }).client.getSearchRegion()).toBe(128)
		expect(makeHarness({ searchRegion: 80 }).client.getSearchRegion()).toBe(80)
	})

	test('defaults the search region when none or zero is provided', () => {
		expect(makeHarness().client.getSearchRegion()).toBe(64)
		expect(makeHarness({ searchRegion: 0 }).client.getSearchRegion()).toBe(64)
	})

	test('applies sticky lock and dither-mode options', () => {
		const sticky = makeHarness({ stickyLockPosition: true, ditherMode: 'spiral' })
		expect(sticky.client.getStickyLockPositionEnabled()).toBeTrue()
		expect(sticky.client.getDitherMode()).toBe('spiral')

		const defaults = makeHarness()
		expect(defaults.client.getStickyLockPositionEnabled()).toBeFalse()
		expect(defaults.client.getDitherMode()).toBe('random')
	})

	test('starts stopped, uncalibrated, unpaused and without a lock', () => {
		expect(harness.client.getAppState()).toBe('Stopped')
		expect(harness.client.getCalibrated()).toBeFalse()
		expect(harness.client.getPaused()).toBeFalse()
		expect(harness.client.getSettling()).toBeFalse()
		expect(harness.client.getLockPosition()).toBeUndefined()
		expect(harness.client.getStarImage()).toBeUndefined()
		expect(harness.client.getConnected()).toBeFalse()
	})
})

describe('connect / disconnect', () => {
	test('binds devices, enables blobs and registers a handler', () => {
		expect(connect(harness)).toBeTrue()
		expect(harness.cameraManager.blobEnabled).toBeTrue()
		expect(harness.cameraManager.handler).toBeDefined()
		expect(harness.client.getConnected()).toBeTrue()
		expect(eventsOf(harness.events, 'ConfigurationChange')).toHaveLength(1)
	})

	test('rejects a second connect while already connected', () => {
		expect(connect(harness)).toBeTrue()
		expect(connect(harness)).toBeFalse()
		expect(harness.cameraManager.enableBlobCount).toBe(1)
	})

	test('getConnected requires both devices to report a live connection', () => {
		connect(harness)
		expect(harness.client.getConnected()).toBeTrue()

		harness.camera.connected = false
		expect(harness.client.getConnected()).toBeFalse()

		harness.camera.connected = true
		harness.guideOutput.connected = false
		expect(harness.client.getConnected()).toBeFalse()
	})

	test('disconnect tears down the session and stops the camera', () => {
		connect(harness)
		expect(harness.client.disconnect()).toBeTrue()
		expect(harness.cameraManager.removeHandlerCount).toBe(1)
		expect(harness.cameraManager.stopExposureCount).toBe(1)
		expect(harness.cameraManager.disableBlobCount).toBe(1)
		expect(harness.client.getConnected()).toBeFalse()
		expect(harness.client.getAppState()).toBe('Stopped')
	})

	test('disconnect on an idle client is a no-op', () => {
		expect(harness.client.disconnect()).toBeFalse()
		expect(harness.cameraManager.stopExposureCount).toBe(0)
	})
})

describe('capture control', () => {
	test('startCapture requires a bound camera', () => {
		expect(harness.client.startCapture(2)).toBeFalse()
		connect(harness)
		expect(harness.client.startCapture(2)).toBeTrue()
		expect(harness.cameraManager.startExposureCalls.at(-1)).toBe(2)
	})

	test('startCapture keeps the previous cadence for non-positive or non-finite exposures', () => {
		connect(harness)
		harness.client.startCapture(3)
		harness.client.startCapture(0)
		harness.client.startCapture(Number.NaN)
		expect(harness.cameraManager.startExposureCalls).toEqual([3, 3, 3])
		expect(harness.client.getExposure()).toBe(3)
	})

	test('stopCapture stops exposures, returns to Stopped and emits the looping stop', () => {
		connect(harness)
		harness.client.loop()
		harness.client.stopCapture()
		expect(harness.client.getAppState()).toBe('Stopped')
		expect(harness.cameraManager.stopExposureCount).toBeGreaterThanOrEqual(1)
		expect(eventsOf(harness.events, 'LoopingExposuresStopped')).toHaveLength(1)
	})
})

describe('exposure', () => {
	test('setExposure rejects invalid values and keeps the last cadence', () => {
		expect(harness.client.setExposure(0)).toBeFalse()
		expect(harness.client.setExposure(-1)).toBeFalse()
		expect(harness.client.setExposure(Number.POSITIVE_INFINITY)).toBeFalse()
		expect(harness.client.getExposure()).toBe(1)
	})

	test('setExposure stores the cadence and emits parameter-change events', () => {
		expect(harness.client.setExposure(2.5)).toBeTrue()
		expect(harness.client.getExposure()).toBe(2.5)
		const changes = eventsOf(harness.events, 'GuideParamChange')
		expect(changes.at(-1)).toMatchObject({ Name: 'Exposure', Value: 2.5 })
	})

	test('getExposure prefers a live camera exposure when reported', () => {
		connect(harness)
		harness.client.setExposure(4)
		harness.camera.exposure.value = 7
		expect(harness.client.getExposure()).toBe(7)
		harness.camera.exposure.value = 0
		expect(harness.client.getExposure()).toBe(4)
	})
})

describe('guide output enable', () => {
	test('toggles output and emits parameter-change events', () => {
		expect(harness.client.getGuideOutputEnabled()).toBeTrue()
		harness.client.setGuideOutputEnabled(false)
		expect(harness.client.getGuideOutputEnabled()).toBeFalse()
		expect(eventsOf(harness.events, 'GuideParamChange').at(-1)).toMatchObject({ Name: 'GuideOutputEnabled', Value: false })
	})
})

describe('guidePulse', () => {
	test('requires a connected guide output, output enabled and a positive finite amount', () => {
		expect(harness.client.guidePulse(100, 'North')).toBeFalse() // not connected

		connect(harness)
		expect(harness.client.guidePulse(0, 'North')).toBeFalse()
		expect(harness.client.guidePulse(Number.NaN, 'North')).toBeFalse()

		harness.client.setGuideOutputEnabled(false)
		expect(harness.client.guidePulse(100, 'North')).toBeFalse()
		expect(harness.guideOutputManager.pulses).toHaveLength(0)
	})

	test('routes a rounded, uppercased pulse to the guide output', () => {
		connect(harness)
		expect(harness.client.guidePulse(149.4, 'East')).toBeTrue()
		expect(harness.guideOutputManager.pulses).toEqual([{ direction: 'EAST', duration: 149 }])
	})

	test('clamps tiny pulse durations up to one millisecond', () => {
		connect(harness)
		expect(harness.client.guidePulse(0.2, 'West')).toBeTrue()
		expect(harness.guideOutputManager.pulses.at(-1)).toEqual({ direction: 'WEST', duration: 1 })
	})
})

describe('declination guide mode', () => {
	test('stores the requested mode and emits parameter-change events', () => {
		expect(harness.client.getDeclinationGuideMode()).toBe('Auto')
		harness.client.setDeclinationGuideMode('North')
		expect(harness.client.getDeclinationGuideMode()).toBe('North')
		expect(eventsOf(harness.events, 'GuideParamChange').at(-1)).toMatchObject({ Name: 'DecGuideMode', Value: 'North' })
	})
})

describe('dither mode', () => {
	test('stores the selected pattern and emits parameter-change events', () => {
		harness.client.setDitherMode('spiral')
		expect(harness.client.getDitherMode()).toBe('spiral')
		expect(eventsOf(harness.events, 'GuideParamChange').at(-1)).toMatchObject({ Name: 'DitherMode', Value: 'spiral' })
	})

	test('dither is rejected without a calibration or active guiding', () => {
		connect(harness)
		expect(harness.client.dither(5)).toBeFalse()
		harness.client.loop()
		expect(harness.client.dither(5)).toBeFalse()
		expect(harness.client.dither(0)).toBeFalse()
	})
})

describe('sticky lock position', () => {
	test('toggles the flag and emits parameter-change events', () => {
		expect(harness.client.setStickyLockPositionEnabled(true)).toBeTrue()
		expect(harness.client.getStickyLockPositionEnabled()).toBeTrue()
		expect(eventsOf(harness.events, 'GuideParamChange').at(-1)).toMatchObject({ Name: 'StickyLockPosition', Value: true })
	})
})

describe('pixel scale', () => {
	test('returns zero without a camera or focal length', () => {
		expect(harness.client.getPixelScale()).toBe(0)
		connect(harness)
		expect(harness.client.getPixelScale()).toBe(0)
	})

	test('derives the scale from focal length and configured pixel size', () => {
		connect(harness, { focalLength: 1000, pixelSize: 5 })
		expect(harness.client.getPixelScale()).toBeCloseTo(pixelScale(5, 1000), 10)
	})

	test('derives focal length from aperture and focal ratio when no focal length is given', () => {
		connect(harness, { aperture: 200, focalRatio: 5, pixelSize: 4 })
		expect(harness.client.getPixelScale()).toBeCloseTo(pixelScale(4, 1000), 10)
	})

	test('prefers camera pixel metadata and scales by binning', () => {
		harness.camera.pixelSize.x = 3.8
		harness.camera.pixelSize.y = 3.8
		harness.camera.bin.x.value = 2
		harness.camera.bin.y.value = 2
		connect(harness, { focalLength: 1000, pixelSize: 5 })
		expect(harness.client.getPixelScale()).toBeCloseTo(pixelScale(3.8 * 2, 1000), 10)
	})

	test('averages asymmetric binned camera pixel metadata', () => {
		harness.camera.pixelSize.x = 3
		harness.camera.pixelSize.y = 5
		harness.camera.bin.x.value = 2
		harness.camera.bin.y.value = 3
		connect(harness, { focalLength: 1000, pixelSize: 4 })
		expect(harness.client.getPixelScale()).toBeCloseTo(pixelScale((3 * 2 + 5 * 3) / 2, 1000), 10)
	})
})

describe('camera metadata', () => {
	test('reports binning and frame size from the active camera', () => {
		harness.camera.bin.x.value = 2
		harness.camera.frame.width.value = 1920
		harness.camera.frame.height.value = 1080
		connect(harness)
		expect(harness.client.getCameraBinning()).toBe(2)
		expect(harness.client.getCameraFrameSize()).toEqual([1920, 1080])
	})

	test('reports zeros without a bound camera', () => {
		expect(harness.client.getCameraBinning()).toBe(0)
		expect(harness.client.getCameraFrameSize()).toEqual([0, 0])
	})
})

describe('calibration data', () => {
	test('returns an empty, uncalibrated snapshot before any solution', () => {
		const data = harness.client.getCalibrationData()
		expect(data.calibrated).toBeFalse()
		expect(data).toMatchObject({ xAngle: 0, xRate: 0, xParity: '+', yAngle: 0, yRate: 0, yParity: '+' })
	})

	test('flipCalibration is rejected without a calibration', () => {
		connect(harness)
		expect(harness.client.flipCalibration()).toBeFalse()
	})
})

describe('lock-shift parameters', () => {
	test('maps the shift axis to the matching rate unit', () => {
		harness.client.setLockShiftParams({ rate: [1, 2], axes: 'X/Y' })
		expect(harness.client.getLockShiftParams().units).toBe('pixels/hr')

		harness.client.setLockShiftParams({ rate: [1, 2], axes: 'RA/Dec' })
		expect(harness.client.getLockShiftParams().units).toBe('arcsec/hr')
	})

	test('stores rate and axis and emits parameter-change events', () => {
		expect(harness.client.setLockShiftParams({ rate: [3, -4], axes: 'X/Y' })).toBeTrue()
		const params = harness.client.getLockShiftParams()
		expect(params.rate).toEqual([3, -4])
		expect(params.axes).toBe('X/Y')
		expect(eventsOf(harness.events, 'GuideParamChange').at(-1)).toMatchObject({ Name: 'LockShiftParams' })
	})

	test('rejects non-finite drift rates and leaves the previous rate untouched', () => {
		harness.client.setLockShiftParams({ rate: [3, -4], axes: 'X/Y' })
		expect(harness.client.setLockShiftParams({ rate: [Number.NaN, 0], axes: 'X/Y' })).toBeFalse()
		expect(harness.client.setLockShiftParams({ rate: [0, Number.POSITIVE_INFINITY], axes: 'X/Y' })).toBeFalse()
		expect(harness.client.getLockShiftParams().rate).toEqual([3, -4])
	})

	test('pixels-per-hour shifting can be enabled without a known pixel scale', () => {
		expect(harness.client.setLockShiftParams({ rate: [1, 1], axes: 'X/Y' })).toBeTrue()
		expect(harness.client.setLockShiftEnabled(true)).toBeTrue()
		expect(harness.client.getLockShiftEnabled()).toBeTrue()
	})

	test('arcsec-per-hour shifting is rejected when the pixel scale is unknown', () => {
		harness.client.setLockShiftParams({ rate: [10, 10], axes: 'RA/Dec' })
		expect(harness.client.setLockShiftEnabled(true)).toBeFalse()
		expect(harness.client.getLockShiftEnabled()).toBeFalse()
	})

	test('arcsec-per-hour shifting is rejected when changing rates while enabled without a scale', () => {
		harness.client.setLockShiftParams({ rate: [1, 1], axes: 'X/Y' })
		harness.client.setLockShiftEnabled(true)
		expect(harness.client.setLockShiftParams({ rate: [5, 5], axes: 'RA/Dec' })).toBeFalse()
	})

	test('arcsec-per-hour shifting is allowed once a pixel scale is available', () => {
		connect(harness, { focalLength: 1000, pixelSize: 5 })
		harness.client.setLockShiftParams({ rate: [10, 10], axes: 'RA/Dec' })
		expect(harness.client.setLockShiftEnabled(true)).toBeTrue()
	})
})

describe('mode transitions', () => {
	test('loop requires a connected camera and enters Looping', () => {
		expect(harness.client.loop()).toBeFalse()
		connect(harness)
		expect(harness.client.loop()).toBeTrue()
		expect(harness.client.getAppState()).toBe('Looping')
		expect(harness.cameraManager.startExposureCalls.length).toBeGreaterThanOrEqual(1)
	})

	test('guide requires a full connection and starts calibration without a solution', () => {
		expect(harness.client.guide()).toBeFalse()
		connect(harness)
		expect(harness.client.guide()).toBeTrue()
		expect(harness.client.getAppState()).toBe('Calibrating')
		expect(eventsOf(harness.events, 'StartCalibration')).toHaveLength(1)
		expect(eventsOf(harness.events, 'SettleBegin')).toHaveLength(1)
	})

	test('guiding assistant requires the internal guider to be locked', () => {
		connect(harness)
		expect(harness.client.guide(false)).toBeTrue()
		expect(harness.client.startGuidingAssistant()).toBeFalse()
		expect(eventsOf(harness.events, 'GuidingAssistantStarted')).toHaveLength(0)
	})

	test('clearCalibration leaves an uncalibrated client and emits configuration changes', () => {
		connect(harness)
		harness.client.clearCalibration()
		expect(harness.client.getCalibrated()).toBeFalse()
		expect(eventsOf(harness.events, 'ConfigurationChange').length).toBeGreaterThanOrEqual(1)
	})

	test('setPaused stops exposures on a full pause and resumes capture afterwards', () => {
		connect(harness)
		harness.client.loop()
		const stopsBeforePause = harness.cameraManager.stopExposureCount

		expect(harness.client.setPaused(true)).toBeTrue()
		expect(harness.client.getPaused()).toBeTrue()
		expect(harness.client.getAppState()).toBe('Paused')
		expect(harness.cameraManager.stopExposureCount).toBe(stopsBeforePause + 1)
		expect(eventsOf(harness.events, 'Paused')).toHaveLength(1)

		expect(harness.client.setPaused(false)).toBeTrue()
		expect(harness.client.getPaused()).toBeFalse()
		expect(harness.client.getAppState()).toBe('Looping')
		expect(eventsOf(harness.events, 'Resumed')).toHaveLength(1)
	})

	test('a partial pause keeps exposures running', () => {
		connect(harness)
		harness.client.loop()
		const stopsBeforePause = harness.cameraManager.stopExposureCount
		harness.client.setPaused(true, false)
		expect(harness.cameraManager.stopExposureCount).toBe(stopsBeforePause)
	})
})

describe('event envelope', () => {
	test('every emitted event carries the local PHD2 envelope fields', () => {
		harness.client.setExposure(2)
		const event = harness.events.at(-1)!
		expect(event.Host).toBe('')
		expect(event.Inst).toBe(1)
		expect(typeof event.Timestamp).toBe('number')
		expect(Number.isFinite(event.Timestamp)).toBeTrue()
	})
})

describe('lock position without frames', () => {
	test('findStar returns undefined while no frame has been decoded', () => {
		connect(harness)
		expect(harness.client.findStar()).toBeUndefined()
	})

	test('getStarImage returns undefined while no frame has been decoded', () => {
		connect(harness)
		expect(harness.client.getStarImage()).toBeUndefined()
	})

	test('setLockPosition rejects non-finite coordinates', () => {
		connect(harness)
		expect(harness.client.setLockPosition(Number.NaN, 10)).toBeFalse()
		expect(harness.client.setLockPosition(10, Number.POSITIVE_INFINITY)).toBeFalse()
	})

	test('setLockPosition stores the requested target and emits LockPositionSet without a frame', () => {
		connect(harness)
		expect(harness.client.setLockPosition(123, 45)).toBeTrue()
		expect(harness.client.getLockPosition()).toEqual([123, 45])
		expect(eventsOf(harness.events, 'LockPositionSet').at(-1)).toMatchObject({ X: 123, Y: 45 })
	})
})

describe('frame-driven behavior', () => {
	test('looping frames emit star metadata with the current frame number', async () => {
		connect(harness)
		harness.client.loop()
		await feedFrame(harness)

		const looping = eventsOf(harness.events, 'LoopingExposures').at(-1)!
		expect(looping.Frame).toBe(1)
		expect(looping.StarMass).toBeGreaterThan(0)
		expect(Number.isFinite(looping.SNR)).toBeTrue()
		expect(looping.SNR).toBeGreaterThanOrEqual(0)
	})

	test('getStarImage crops a square ROI sized by the search region', async () => {
		connect(harness)
		harness.client.loop()
		const image = await feedFrame(harness)

		expect(image.width).toBe(64)
		expect(image.height).toBe(64)
		expect(image.frame).toBe(1)
		expect(image.pixels.length).toBe(64 * 64)
		expect(image.star_pos.x).toBeGreaterThanOrEqual(0)
		expect(image.star_pos.x).toBeLessThan(64)
		expect(image.star_pos.y).toBeGreaterThanOrEqual(0)
		expect(image.star_pos.y).toBeLessThan(64)
	})

	test('non-exact setLockPosition snaps to the nearest detected star', async () => {
		connect(harness)
		harness.client.loop()
		await feedFrame(harness)

		expect(harness.client.setLockPosition(STAR_B[0] + 3, STAR_B[1] - 2)).toBeTrue()
		const lock = harness.client.getLockPosition()!
		expect(lock[0]).toBeCloseTo(STAR_B[0], 0)
		expect(lock[1]).toBeCloseTo(STAR_B[1], 0)
	})

	test('exact setLockPosition keeps the requested coordinates even with a detected frame', async () => {
		connect(harness)
		harness.client.loop()
		await feedFrame(harness)

		expect(harness.client.setLockPosition(40, 200, true)).toBeTrue()
		expect(harness.client.getLockPosition()).toEqual([40, 200])
	})

	test('deselectStar drops the lock and returns to plain looping', async () => {
		connect(harness)
		harness.client.loop()
		await feedFrame(harness)
		harness.client.setLockPosition(STAR_B[0], STAR_B[1], true)
		expect(harness.client.getLockPosition()).toBeDefined()

		harness.client.deselectStar()
		expect(harness.client.getLockPosition()).toBeUndefined()
		expect(harness.client.getAppState()).toBe('Looping')
	})
})

describe('frame processing robustness', () => {
	// Waits until the recorded LoopingExposures count grows past a baseline.
	async function waitForLoopingExposures(target: number) {
		for (let i = 0; i < 1000; i++) {
			if (eventsOf(harness.events, 'LoopingExposures').length >= target) return
			await Bun.sleep(1)
		}
		throw new Error('expected looping exposures were not emitted in time')
	}

	test('drops a concurrent BLOB while a previous frame is still being processed', async () => {
		connect(harness)
		harness.client.loop()
		const handler = harness.cameraManager.handler!

		// Two BLOBs delivered back-to-back: the second must be dropped because the first is still
		// decoding, so only one frame is processed and the stateful guider is not mutated twice.
		handler.blobReceived!(harness.camera, FRAME_BUFFER as Buffer<ArrayBuffer>)
		handler.blobReceived!(harness.camera, FRAME_BUFFER as Buffer<ArrayBuffer>)

		await waitForLoopingExposures(1)
		// Give any erroneously-spawned second processing a chance to surface before asserting.
		await Bun.sleep(20)

		expect(eventsOf(harness.events, 'LoopingExposures')).toHaveLength(1)
		expect(harness.client.getStarImage()!.frame).toBe(1)
	})

	test('a failed decode clears the cached star image instead of reusing stale pixels', async () => {
		connect(harness)
		harness.client.loop()
		await feedFrame(harness)
		expect(harness.client.getStarImage()).toBeDefined()

		const before = eventsOf(harness.events, 'LoopingExposures').length
		const handler = harness.cameraManager.handler!
		// An undecodable BLOB still advances the looping frame, but must not leave a stale image behind.
		handler.blobReceived!(harness.camera, Buffer.from('not a valid fits or xisf payload'))

		await waitForLoopingExposures(before + 1)
		expect(harness.client.getStarImage()).toBeUndefined()
	})
})
