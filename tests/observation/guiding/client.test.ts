import { beforeEach, describe, expect, test } from 'bun:test'
import { pixelScale } from '../../../src/astronomy/formulas'
import { DEG2RAD, PIOVERTWO } from '../../../src/core/constants'
import type { PHD2Events } from '../../../src/devices/guiding/phd2'
import { type Camera, DEFAULT_CAMERA, DEFAULT_GUIDE_OUTPUT, type GuideDirection, type GuideOutput } from '../../../src/devices/indi/device'
import type { CameraManager, DeviceHandler, GuideOutputManager } from '../../../src/devices/indi/manager'
import { writeImageToFits } from '../../../src/imaging/model/image'
import type { Image } from '../../../src/imaging/model/types'
import { plotStar } from '../../../src/imaging/stars/generator'
import { bufferSink } from '../../../src/io/io'
import type { GuidingCalibrationResult } from '../../../src/observation/guiding/calibrator'
import { GuiderClient, type GuideFrameImage, type GuiderClientConnectOptions, type GuiderClientOptions } from '../../../src/observation/guiding/client'
import { ditherPulsePlanFromCalibration } from '../../../src/observation/guiding/dither.pulse'
import type { GuideDirectionDEC, GuideDirectionRA } from '../../../src/observation/guiding/guider'

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
	// Extra milliseconds the fake guide output stays Busy after the commanded pulse duration, to
	// model INDI driver latency after Busy has already been reported.
	pulseBusyOverhangMs = 0
	// Milliseconds after the nominal pulse duration before `pulsing` becomes true, to model a
	// delayed INDI Busy acknowledgement. Zero reports Busy immediately.
	pulseBusyAckLagMs = 0
	lastBusyAt = 0
	lastIdleAt = 0

	pulse(device: GuideOutput, direction: GuideDirection, duration: number) {
		this.pulses.push({ direction, duration })
		const ackLag = this.pulseBusyAckLagMs
		const hold = duration + this.pulseBusyOverhangMs

		if (ackLag <= 0) {
			device.pulsing = true
			this.lastBusyAt = performance.now()
			setTimeout(
				() => {
					device.pulsing = false
					this.lastIdleAt = performance.now()
				},
				Math.max(hold, 1),
			)
			return
		}

		setTimeout(() => {
			device.pulsing = true
			this.lastBusyAt = performance.now()
		}, duration + ackLag)
		setTimeout(
			() => {
				device.pulsing = false
				this.lastIdleAt = performance.now()
			},
			duration + ackLag + Math.max(this.pulseBusyOverhangMs, 10),
		)
	}
}

// Star centers (image pixels) plotted into the synthetic guide frame at zero mount offset.
const STAR_A = [70, 70] as const
const STAR_B = [165, 150] as const
const FRAME_WIDTH = 240
const FRAME_HEIGHT = 240

// Integrated flux of the primary synthetic star, in normalized full-scale units. Chosen so the
// detector measures SNR ~3 with a peak near 0.6: above the guide-star filter thresholds while
// staying clear of the saturation ceiling.
const STAR_FLUX = 10
// Flux of the secondary star as a fraction of the primary, keeping the two stars distinguishable.
const SECONDARY_STAR_FLUX_RATIO = 0.6
// Half-flux diameter of the synthetic stars, in pixels.
const STAR_HFD = 3
// Nominal SNR requested from the star plotter; high enough that the rendered profile is noise-free
// and the detector recovers the plotted centroid exactly.
const STAR_PLOT_SNR = 80
// Flat background level under the stars, in normalized full-scale units.
const FRAME_BACKGROUND = 0.005

// Builds an in-memory FITS buffer with two well-separated stars on a flat background, both shifted
// by the same image-space offset (pixels) so a whole-frame mount motion can be simulated. Passing
// no stars renders an empty background frame, which the detector reports as a lost star.
async function buildFrameBuffer(offsetX = 0, offsetY = 0, stars = true): Promise<Buffer> {
	const raw = new Float32Array(FRAME_WIDTH * FRAME_HEIGHT).fill(FRAME_BACKGROUND)

	if (stars) {
		const options = { background: FRAME_BACKGROUND, saturationLevel: 1 }
		plotStar(raw, FRAME_WIDTH, FRAME_HEIGHT, 1, STAR_A[0] + offsetX, STAR_A[1] + offsetY, STAR_FLUX, STAR_HFD, STAR_PLOT_SNR, 0, undefined, options)
		plotStar(raw, FRAME_WIDTH, FRAME_HEIGHT, 1, STAR_B[0] + offsetX, STAR_B[1] + offsetY, STAR_FLUX * SECONDARY_STAR_FLUX_RATIO, STAR_HFD, STAR_PLOT_SNR, 0, undefined, options)
	}

	const image: Image = {
		header: { SIMPLE: true, BITPIX: -32, NAXIS: 2, NAXIS1: FRAME_WIDTH, NAXIS2: FRAME_HEIGHT },
		metadata: { width: FRAME_WIDTH, height: FRAME_HEIGHT, channels: 1, pixelCount: FRAME_WIDTH * FRAME_HEIGHT, pixelSizeInBytes: 4, strideInBytes: FRAME_WIDTH * 4, stride: FRAME_WIDTH, bitpix: -32, bayer: undefined },
		raw,
	}

	const buffer = Buffer.alloc(FRAME_WIDTH * FRAME_HEIGHT * 4 + 100000)
	await writeImageToFits(image, bufferSink(buffer))
	return buffer
}

// Builds a FITS buffer with stars at explicit image-pixel centers, used when a test needs a
// geometry that the default two-star field cannot produce.
async function buildFrameBufferAt(positions: readonly (readonly [number, number])[]) {
	const raw = new Float32Array(FRAME_WIDTH * FRAME_HEIGHT).fill(FRAME_BACKGROUND)
	const options = { background: FRAME_BACKGROUND, saturationLevel: 1 }

	for (const [x, y] of positions) {
		plotStar(raw, FRAME_WIDTH, FRAME_HEIGHT, 1, x, y, STAR_FLUX, STAR_HFD, STAR_PLOT_SNR, 0, undefined, options)
	}

	const image: Image = {
		header: { SIMPLE: true, BITPIX: -32, NAXIS: 2, NAXIS1: FRAME_WIDTH, NAXIS2: FRAME_HEIGHT },
		metadata: { width: FRAME_WIDTH, height: FRAME_HEIGHT, channels: 1, pixelCount: FRAME_WIDTH * FRAME_HEIGHT, pixelSizeInBytes: 4, strideInBytes: FRAME_WIDTH * 4, stride: FRAME_WIDTH, bitpix: -32, bayer: undefined },
		raw,
	}

	const buffer = Buffer.alloc(FRAME_WIDTH * FRAME_HEIGHT * 4 + 100000)
	await writeImageToFits(image, bufferSink(buffer))
	return buffer
}

// Frame with both stars at their nominal positions, reused by tests that never move the mount.
const FRAME_BUFFER = await buildFrameBuffer()

// Image-space star displacement produced by one millisecond of guide pulse on either axis, in
// pixels/ms. The calibrator's default 650 ms pulses then move the star ~7.5 px per step: below its
// 8 px maximum accepted frame jump, yet large enough that two steps already exceed the minimum net
// travel each axis requires, which keeps the wall-clock cost of a calibration run low.
const MOUNT_RATE_PX_PER_MS = 0.0115
// Camera rotation relative to the mount axes, in radians. A non-zero angle keeps the solved
// calibration matrix off-diagonal, so an axis mix-up cannot pass unnoticed.
const MOUNT_ANGLE = 20 * DEG2RAD
// Unit vector, in image space, along which a west pulse moves the star.
const RA_AXIS = [Math.cos(MOUNT_ANGLE), Math.sin(MOUNT_ANGLE)] as const
// Unit vector, in image space, along which a north pulse moves the star; orthogonal to RA_AXIS so
// the two calibration legs are always well separated.
const DEC_AXIS = [-Math.sin(MOUNT_ANGLE), Math.cos(MOUNT_ANGLE)] as const

// Turns the pulses recorded by the fake guide output into image-space star motion, so calibration
// and guiding run against frames that actually respond to the commands the client issues.
// West and north move the star along the positive axis unit vectors; east and south reverse it.
class MountSimulator {
	// Accumulated star displacement, in pixels.
	offsetX = 0
	offsetY = 0
	// Constant open-loop drift added once per rendered frame, in pixels; models a mount the guider
	// has to correct for.
	driftX = 0
	driftY = 0

	// Number of recorded pulses already converted into motion.
	#consumed = 0

	// Applies every pulse recorded since the previous frame, then the per-frame drift.
	advance(pulses: readonly PulseRecord[]) {
		for (let i = this.#consumed; i < pulses.length; i++) {
			const { direction, duration } = pulses[i]
			const travel = duration * MOUNT_RATE_PX_PER_MS
			const axis = direction === 'WEST' || direction === 'EAST' ? RA_AXIS : DEC_AXIS
			const sign = direction === 'WEST' || direction === 'NORTH' ? 1 : -1

			this.offsetX += sign * travel * axis[0]
			this.offsetY += sign * travel * axis[1]
		}

		this.#consumed = pulses.length
		this.offsetX += this.driftX
		this.offsetY += this.driftY
	}
}

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
	readonly mount: MountSimulator
	frameCount: number
}

// Creates a fresh client wired to fake managers and an event recorder.
function makeHarness(options: GuiderClientOptions = {}): Harness {
	const cameraManager = new FakeCameraManager()
	const guideOutputManager = new FakeGuideOutputManager()
	const events: PHD2Events[] = []
	const client = new GuiderClient(cameraManager as unknown as CameraManager, guideOutputManager as unknown as GuideOutputManager, {
		...options,
		handler: {
			event: (client, event) => {
				options.handler?.event?.(client, event)
				events.push(event)
			},
			frame: options.handler?.frame,
		},
	})

	return { client, cameraManager, guideOutputManager, events, camera: makeCamera(), guideOutput: makeGuideOutput(), mount: new MountSimulator(), frameCount: 0 }
}

// Connects the harness client to its camera/guide output.
function connect(harness: Harness, options?: GuiderClientConnectOptions) {
	return harness.client.connect(harness.camera, harness.guideOutput, options)
}

// Feeds one already-built BLOB through the captured blob handler and waits until the client has
// fully processed it. Completion is detected by the request for the next exposure, which the client
// only issues after the frame has been processed and any commanded pulse has elapsed; feeding the
// next BLOB earlier would simply be dropped as a concurrent frame. States that stop the exposure
// loop never request another exposure, so a processed frame that produced events also completes.
async function feedBuffer(harness: Harness, buffer: Buffer) {
	const handler = harness.cameraManager.handler
	expect(handler?.blobReceived).toBeDefined()

	const expected = ++harness.frameCount

	for (let attempt = 0; attempt < 100; attempt++) {
		const eventsBefore = harness.events.length
		const exposuresBefore = harness.cameraManager.startExposureCalls.length
		handler!.blobReceived!(harness.camera, buffer, 'raw')

		// Every processed frame emits at least one event while it is being handled, so a short silence
		// means the BLOB arrived while the previous frame was still processing and was dropped: retry.
		let accepted = false

		for (let i = 0; i < 100 && !accepted; i++) {
			accepted = harness.events.length > eventsBefore
			if (!accepted) await Bun.sleep(1)
		}

		if (!accepted) continue

		// The frame is only fully processed once the client asks for the next exposure, which happens
		// after any commanded pulse has elapsed.
		for (let i = 0; i < 10000; i++) {
			if (harness.cameraManager.startExposureCalls.length > exposuresBefore) break
			await Bun.sleep(1)
		}

		const image = harness.client.getStarImage()
		return image !== undefined && image.frame >= expected ? image : undefined
	}

	throw new Error('frame was not processed in time')
}

// Advances the simulated mount with the pulses issued so far, renders the resulting frame and feeds
// it to the client. This closes the loop: the corrections the client commands move the next frame.
async function feedFrame(harness: Harness) {
	harness.mount.advance(harness.guideOutputManager.pulses)
	return await feedBuffer(harness, await buildFrameBuffer(harness.mount.offsetX, harness.mount.offsetY))
}

// Feeds a star-free frame, which the client must report as a lost star.
async function feedEmptyFrame(harness: Harness) {
	harness.mount.advance(harness.guideOutputManager.pulses)
	return await feedBuffer(harness, await buildFrameBuffer(0, 0, false))
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

	test('rejects a calibrator configuration the calibrator itself would reject', () => {
		// The overrides are merged over the calibrator defaults and validated at construction, so an
		// impossible combination fails immediately instead of on the first calibration frame.
		expect(() => makeHarness({ calibrator: { raPulse: 0 } })).toThrowError(/invalid guiding calibrator config/)
		expect(() => makeHarness({ calibrator: { maxRatePxPerMs: 1e-6 } })).toThrowError(/invalid guiding calibrator config/)
		expect(() => makeHarness({ calibrator: { raPulse: 250, decPulse: 250 } })).not.toThrow()
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

	test('greets a connecting client with Version and the current AppState', () => {
		connect(harness)

		// PHD2 sends Version as the first message, immediately followed by AppState.
		expect(harness.events[0]).toMatchObject({ Event: 'Version', PHDVersion: '2.6.13', MsgVersion: 1, OverlapSupport: false })
		expect(harness.events[1]).toMatchObject({ Event: 'AppState', State: 'Stopped' })
	})

	test('AppState is not re-emitted on later state transitions', () => {
		connect(harness)
		harness.client.loop()
		harness.client.setPaused(true)
		harness.client.setPaused(false)
		harness.client.stopCapture()

		// Clients track state through the individual lifecycle events after the initial handshake.
		expect(eventsOf(harness.events, 'AppState')).toHaveLength(1)
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

	test('disconnect during an in-flight exposure ignores a late BLOB', async () => {
		connect(harness)
		expect(harness.client.loop()).toBeTrue()

		const handler = harness.cameraManager.handler
		const camera = harness.camera
		const exposuresBefore = harness.cameraManager.startExposureCalls.length

		expect(harness.client.disconnect()).toBeTrue()
		expect(harness.client.getAppState()).toBe('Stopped')
		expect(harness.cameraManager.stopExposureCount).toBeGreaterThanOrEqual(1)

		// The cancelled exposure may still deliver its BLOB. The handler reference is the client's,
		// so this is the same callback disconnect unregistered — it must not process the frame or
		// start another capture after the session is gone.
		await handler!.blobReceived!(camera, FRAME_BUFFER, 'raw')
		await Bun.sleep(30)

		expect(eventsOf(harness.events, 'LoopingExposures')).toHaveLength(0)
		expect(harness.guideOutputManager.pulses).toHaveLength(0)
		expect(harness.cameraManager.startExposureCalls.length).toBe(exposuresBefore)
	})
})

describe('capture control', () => {
	test('startExposureLoop requires a bound camera', () => {
		expect(harness.client.startExposureLoop(2000)).toBeFalse()
		connect(harness)
		expect(harness.client.startExposureLoop(2000)).toBeTrue()
		expect(harness.cameraManager.startExposureCalls.at(-1)).toBe(2)
	})

	test('startExposureLoop does not start on a disconnected camera', () => {
		connect(harness)
		harness.camera.connected = false
		expect(harness.client.startExposureLoop(1000)).toBeFalse()
		expect(harness.cameraManager.startExposureCalls).toHaveLength(0)
	})

	test('startExposureLoop keeps the previous cadence for non-positive or non-finite exposures', () => {
		connect(harness)
		harness.client.startExposureLoop(3000)
		harness.client.startExposureLoop(0)
		harness.client.startExposureLoop(Number.NaN)
		expect(harness.cameraManager.startExposureCalls).toEqual([3])
		expect(harness.client.getExposure()).toBe(3000)
	})

	test('startExposureLoop does not start a second exposure while one is in flight', () => {
		connect(harness)
		expect(harness.client.startExposureLoop(1000)).toBeTrue()
		expect(harness.client.startExposureLoop(2000)).toBeTrue()
		expect(harness.cameraManager.startExposureCalls).toEqual([1])
		expect(harness.client.getExposure()).toBe(2000)
	})

	test('stopCapture stops exposures, returns to Stopped and emits the looping stop', () => {
		connect(harness)
		harness.client.loop()
		expect(harness.client.stopCapture()).toBeTrue()
		expect(harness.client.getAppState()).toBe('Stopped')
		expect(harness.cameraManager.stopExposureCount).toBeGreaterThanOrEqual(1)
		expect(eventsOf(harness.events, 'LoopingExposuresStopped')).toHaveLength(1)
		expect(eventsOf(harness.events, 'GuidingStopped')).toHaveLength(0)
	})

	test('stopCapture during a guiding session reports both guiding and looping stops', () => {
		connect(harness)
		harness.client.guide()
		expect(harness.client.getAppState()).toBe('Calibrating')

		expect(harness.client.stopCapture()).toBeTrue()
		// Guiding implies looping in PHD2, so both stop notifications are sent, guiding first.
		expect(eventsOf(harness.events, 'GuidingStopped')).toHaveLength(1)
		expect(eventsOf(harness.events, 'LoopingExposuresStopped')).toHaveLength(1)

		const stops = harness.events.filter((event) => event.Event === 'GuidingStopped' || event.Event === 'LoopingExposuresStopped')
		expect(stops.map((event) => event.Event)).toEqual(['GuidingStopped', 'LoopingExposuresStopped'])
	})

	test('stopCapture on an already stopped client emits no stop events', () => {
		connect(harness)
		expect(harness.client.stopCapture()).toBeTrue()
		expect(eventsOf(harness.events, 'GuidingStopped')).toHaveLength(0)
		expect(eventsOf(harness.events, 'LoopingExposuresStopped')).toHaveLength(0)
	})

	test('a repeated stopCapture during guiding emits each stop event only once', () => {
		connect(harness)
		harness.client.guide()
		expect(harness.client.stopCapture()).toBeTrue()
		expect(harness.client.stopCapture()).toBeTrue()

		expect(harness.client.getAppState()).toBe('Stopped')
		expect(eventsOf(harness.events, 'GuidingStopped')).toHaveLength(1)
		expect(eventsOf(harness.events, 'LoopingExposuresStopped')).toHaveLength(1)
	})

	test('a late BLOB after stopCapture issues no pulse and starts no exposure', async () => {
		connect(harness)
		harness.client.guide()
		const handler = harness.cameraManager.handler!
		const exposuresBefore = harness.cameraManager.startExposureCalls.length

		expect(harness.client.stopCapture()).toBeTrue()
		expect(harness.client.getAppState()).toBe('Stopped')

		await handler.blobReceived!(harness.camera, FRAME_BUFFER, 'raw')
		await Bun.sleep(30)

		expect(harness.guideOutputManager.pulses).toHaveLength(0)
		expect(harness.cameraManager.startExposureCalls.length).toBe(exposuresBefore)
		expect(eventsOf(harness.events, 'GuideStep')).toHaveLength(0)
		expect(eventsOf(harness.events, 'Calibrating')).toHaveLength(0)
	})

	test('stopCapture during settle emits SettleDone with an error', () => {
		connect(harness)
		harness.client.guide()
		expect(harness.client.getSettling()).toBeTrue()

		harness.client.stopCapture()

		const done = eventsOf(harness.events, 'SettleDone')
		expect(done).toHaveLength(1)
		expect(done[0].Status).not.toBe(0)
		expect(done[0].Error).toBe('capture stopped')
		expect(harness.client.getSettling()).toBeFalse()
	})
})

describe('exposure', () => {
	test('setExposure rejects invalid values and keeps the last cadence', () => {
		expect(harness.client.setExposure(0)).toBeFalse()
		expect(harness.client.setExposure(-1)).toBeFalse()
		expect(harness.client.setExposure(Number.POSITIVE_INFINITY)).toBeFalse()
		expect(harness.client.getExposure()).toBe(1000)
	})

	test('setExposure stores the cadence and emits parameter-change events', () => {
		expect(harness.client.setExposure(2.5)).toBeTrue()
		expect(harness.client.getExposure()).toBe(2.5)
		const changes = eventsOf(harness.events, 'GuideParamChange')
		expect(changes.at(-1)).toMatchObject({ Name: 'Exposure', Value: 2.5 })
	})

	test('getExposure returns the requested cadence, not the INDI countdown', () => {
		connect(harness)
		harness.client.setExposure(4000)
		harness.camera.exposure.value = 7
		expect(harness.client.getExposure()).toBe(4000)
		harness.camera.exposure.value = 0
		expect(harness.client.getExposure()).toBe(4000)
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
		harness.camera.connected = false
		expect(harness.client.loop()).toBeFalse()
		harness.camera.connected = true
		expect(harness.client.loop()).toBeTrue()
		expect(harness.client.getAppState()).toBe('Looping')
		expect(harness.cameraManager.startExposureCalls.length).toBeGreaterThanOrEqual(1)
	})

	test('loop during settle emits SettleDone with an error', () => {
		connect(harness)
		harness.client.guide()
		expect(harness.client.getSettling()).toBeTrue()

		harness.client.loop()

		const done = eventsOf(harness.events, 'SettleDone')
		expect(done).toHaveLength(1)
		expect(done[0].Status).not.toBe(0)
		expect(done[0].Error).toBe('looping started')
		expect(harness.client.getSettling()).toBeFalse()
	})

	test('clearCalibration during settle emits SettleDone with an error', () => {
		connect(harness)
		harness.client.guide()
		expect(harness.client.getSettling()).toBeTrue()

		harness.client.clearCalibration()

		const done = eventsOf(harness.events, 'SettleDone')
		expect(done).toHaveLength(1)
		expect(done[0].Status).not.toBe(0)
		expect(done[0].Error).toBe('calibration cleared')
		expect(harness.client.getSettling()).toBeFalse()
	})

	test('deselectStar during settle emits SettleDone with an error', () => {
		connect(harness)
		harness.client.guide()
		expect(harness.client.getSettling()).toBeTrue()

		harness.client.deselectStar()

		const done = eventsOf(harness.events, 'SettleDone')
		expect(done).toHaveLength(1)
		expect(done[0].Status).not.toBe(0)
		expect(done[0].Error).toBe('guide star deselected')
		expect(harness.client.getSettling()).toBeFalse()
	})

	test('disconnect during settle emits SettleDone with an error', () => {
		connect(harness)
		harness.client.guide()
		expect(harness.client.getSettling()).toBeTrue()

		harness.client.disconnect()

		const done = eventsOf(harness.events, 'SettleDone')
		expect(done).toHaveLength(1)
		expect(done[0].Status).not.toBe(0)
		expect(done[0].Error).toBe('device disconnected')
		expect(harness.client.getSettling()).toBeFalse()
	})

	test('guide requires a full connection and starts calibration without a solution', () => {
		expect(harness.client.guide()).toBeFalse()
		connect(harness)
		harness.guideOutput.canPulseGuide = false
		expect(harness.client.guide()).toBeFalse()
		harness.guideOutput.canPulseGuide = true
		harness.camera.connected = false
		expect(harness.client.guide()).toBeFalse()
		harness.camera.connected = true
		expect(harness.client.guide()).toBeTrue()
		expect(harness.client.getAppState()).toBe('Calibrating')
		expect(eventsOf(harness.events, 'StartCalibration')).toHaveLength(1)
		expect(eventsOf(harness.events, 'SettleBegin')).toHaveLength(1)
	})

	test('guide without a decoded frame cannot select a star and still starts', () => {
		connect(harness)

		expect(harness.client.guide()).toBeTrue()
		// The auto-selection attempt is a no-op until frames arrive; guiding still starts.
		expect(eventsOf(harness.events, 'StarSelected')).toHaveLength(0)
		expect(harness.client.getLockPosition()).toBeUndefined()
		expect(harness.client.getAppState()).toBe('Calibrating')
	})

	test('guide keeps an already selected star instead of reselecting', async () => {
		connect(harness)
		harness.client.loop()
		await feedFrame(harness)
		harness.client.setLockPosition(STAR_B[0], STAR_B[1], true)

		const exposuresBefore = harness.cameraManager.startExposureCalls.length
		expect(harness.client.guide()).toBeTrue()
		expect(harness.cameraManager.startExposureCalls.length).toBe(exposuresBefore)
		expect(eventsOf(harness.events, 'StarSelected')).toHaveLength(0)
		expect(harness.client.getLockPosition()).toEqual([STAR_B[0], STAR_B[1]])
	})

	test('a repeated guide request while still calibrating restarts calibration', () => {
		connect(harness)
		harness.client.guide()
		harness.client.guide()

		// The re-settle shortcut only applies to an established guiding session, never while the
		// calibration is still being solved.
		expect(eventsOf(harness.events, 'StartCalibration')).toHaveLength(2)
		expect(eventsOf(harness.events, 'SettleBegin')).toHaveLength(2)
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

	test('redundant pause and resume requests emit no extra events', () => {
		connect(harness)
		harness.client.loop()

		harness.client.setPaused(true)
		harness.client.setPaused(true)
		expect(eventsOf(harness.events, 'Paused')).toHaveLength(1)

		harness.client.setPaused(false)
		harness.client.setPaused(false)
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
	test('the primary star is the nearest detection inside the search box', async () => {
		const frames: GuideFrameImage[] = []
		const local = makeHarness({
			searchRegion: 64,
			handler: { frame: (_client, frame) => frames.push(frame) },
		})
		connect(local)
		local.client.loop()
		expect(local.client.setLockPosition(70, 70, true)).toBeTrue()

		const half = local.client.getSearchRegion() / 2
		const inside = [70 + half - 1, 70 + half - 1] as const
		const outside = [70 + half + 1, 70] as const
		expect(Math.hypot(outside[0] - 70, outside[1] - 70)).toBeLessThan(Math.hypot(inside[0] - 70, inside[1] - 70))

		await feedBuffer(local, await buildFrameBufferAt([inside, outside]))

		const frame = frames.at(-1)!
		expect(frame.star).toBeDefined()
		expect(frame.star!.x).toBeCloseTo(inside[0], 1)
		expect(frame.star!.y).toBeCloseTo(inside[1], 1)
		expect(frame.stars).toHaveLength(2)
		local.client.stopCapture()
	})

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
		const image = (await feedFrame(harness))!

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

	test('ignores a BLOB from a camera that is not the bound device', async () => {
		connect(harness)
		harness.client.loop()
		const handler = harness.cameraManager.handler!
		const other = makeCamera({ id: 'camera-other', name: 'Other Camera' })

		handler.blobReceived!(other, FRAME_BUFFER, 'raw')
		await Bun.sleep(30)

		expect(eventsOf(harness.events, 'LoopingExposures')).toHaveLength(0)
		expect(harness.client.getStarImage()).toBeUndefined()
		expect(harness.guideOutputManager.pulses).toHaveLength(0)
		harness.client.stopCapture()
	})

	test('drops a concurrent BLOB while a previous frame is still being processed', async () => {
		connect(harness)
		harness.client.loop()
		const handler = harness.cameraManager.handler!

		// Two BLOBs delivered back-to-back: the second must be dropped because the first is still
		// decoding, so only one frame is processed and the stateful guider is not mutated twice.
		handler.blobReceived!(harness.camera, FRAME_BUFFER, 'raw')
		handler.blobReceived!(harness.camera, FRAME_BUFFER, 'raw')

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
		handler.blobReceived!(harness.camera, Buffer.from('not a valid fits or xisf payload'), 'raw')

		await waitForLoopingExposures(before + 1)
		expect(harness.client.getStarImage()).toBeUndefined()
	})

	test('an event handler throw does not stop the exposure loop', async () => {
		const cameraManager = new FakeCameraManager()
		const guideOutputManager = new FakeGuideOutputManager()
		const events: PHD2Events[] = []
		const client = new GuiderClient(cameraManager as unknown as CameraManager, guideOutputManager as unknown as GuideOutputManager, {
			handler: {
				event: (_client, event) => {
					events.push(event)
					throw new Error('handler boom')
				},
			},
		})
		const local: Harness = { client, cameraManager, guideOutputManager, events, camera: makeCamera(), guideOutput: makeGuideOutput(), mount: new MountSimulator(), frameCount: 0 }

		connect(local)
		expect(local.client.loop()).toBeTrue()
		await feedFrame(local)
		const eventsAfterFirst = events.length
		expect(eventsAfterFirst).toBeGreaterThan(0)

		await feedFrame(local)
		expect(events.length).toBeGreaterThan(eventsAfterFirst)
		expect(local.client.getAppState()).toBe('Looping')
		expect(local.client.getStarImage()?.frame).toBe(2)
		local.client.stopCapture()
	})

	test('a disconnected camera does not receive watchdog retries', async () => {
		connect(harness)
		harness.client.loop()
		const exposuresBefore = harness.cameraManager.startExposureCalls.length
		expect(exposuresBefore).toBeGreaterThan(0)

		harness.camera.connected = false
		await Bun.sleep(Math.max(3 * harness.client.getExposure(), 5000) + 200)

		expect(harness.cameraManager.startExposureCalls.length).toBe(exposuresBefore)
		expect(eventsOf(harness.events, 'Alert').some((alert) => alert.Type === 'warning' && alert.Msg.includes('timed out'))).toBeFalse()
		harness.client.stopCapture()
	}, 15000)

	test('a missing guide frame retries the exposure after the watchdog', async () => {
		connect(harness)
		harness.client.loop()
		const exposuresBefore = harness.cameraManager.startExposureCalls.length
		expect(exposuresBefore).toBeGreaterThan(0)

		for (let i = 0; i < 200 && eventsOf(harness.events, 'Alert').length === 0; i++) {
			await Bun.sleep(50)
		}

		const alerts = eventsOf(harness.events, 'Alert')
		expect(alerts.some((alert) => alert.Type === 'warning' && alert.Msg.includes('timed out'))).toBeTrue()
		expect(harness.cameraManager.startExposureCalls.length).toBeGreaterThan(exposuresBefore)
		harness.client.stopCapture()
	}, 15000)

	test('a late BLOB after the exposure watchdog does not start a second capture chain', async () => {
		connect(harness)
		harness.client.loop()
		const exposuresBefore = harness.cameraManager.startExposureCalls.length
		expect(exposuresBefore).toBeGreaterThan(0)

		for (let i = 0; i < 200 && eventsOf(harness.events, 'Alert').length === 0; i++) {
			await Bun.sleep(50)
		}

		expect(eventsOf(harness.events, 'Alert').some((alert) => alert.Type === 'warning' && alert.Msg.includes('timed out'))).toBeTrue()
		const exposuresAfterRetry = harness.cameraManager.startExposureCalls.length
		expect(exposuresAfterRetry).toBeGreaterThan(exposuresBefore)

		const loopingBefore = eventsOf(harness.events, 'LoopingExposures').length
		const handler = harness.cameraManager.handler!
		// Past the previous one-cadence quarantine: a delayed original transfer still must not
		// become the retry's BLOB and start a second capture chain.
		await Bun.sleep(harness.client.getExposure() + 50)
		handler.blobReceived!(harness.camera, FRAME_BUFFER, 'raw')
		await Bun.sleep(50)

		expect(eventsOf(harness.events, 'LoopingExposures')).toHaveLength(loopingBefore)
		expect(harness.cameraManager.startExposureCalls.length).toBe(exposuresAfterRetry)
		expect(harness.client.getStarImage()).toBeUndefined()

		await feedBuffer(harness, FRAME_BUFFER)
		expect(harness.cameraManager.startExposureCalls.length).toBe(exposuresAfterRetry + 1)
		expect(harness.client.getStarImage()?.frame).toBe(1)

		await feedBuffer(harness, FRAME_BUFFER)
		expect(harness.cameraManager.startExposureCalls.length).toBe(exposuresAfterRetry + 2)
		expect(harness.client.getStarImage()?.frame).toBe(2)
		harness.client.stopCapture()
	}, 15000)

	test('a timeout Alert that stops capture does not start a replacement exposure', async () => {
		const local = makeHarness({
			handler: {
				event: (client, event) => {
					if (event.Event === 'Alert' && event.Type === 'warning' && event.Msg.includes('timed out')) client.stopCapture()
				},
			},
		})
		connect(local)
		local.client.loop()
		const exposuresBefore = local.cameraManager.startExposureCalls.length

		for (let i = 0; i < 200 && eventsOf(local.events, 'Alert').length === 0; i++) {
			await Bun.sleep(50)
		}

		expect(eventsOf(local.events, 'Alert').some((alert) => alert.Type === 'warning' && alert.Msg.includes('timed out'))).toBeTrue()
		expect(local.client.getAppState()).toBe('Stopped')
		expect(local.cameraManager.startExposureCalls.length).toBe(exposuresBefore)
	}, 15000)

	test('a timeout Alert that disconnects does not start a replacement exposure', async () => {
		const local = makeHarness({
			handler: {
				event: (client, event) => {
					if (event.Event === 'Alert' && event.Type === 'warning' && event.Msg.includes('timed out')) client.disconnect()
				},
			},
		})
		connect(local)
		local.client.loop()
		const exposuresBefore = local.cameraManager.startExposureCalls.length

		for (let i = 0; i < 200 && eventsOf(local.events, 'Alert').length === 0; i++) {
			await Bun.sleep(50)
		}

		expect(eventsOf(local.events, 'Alert').some((alert) => alert.Type === 'warning' && alert.Msg.includes('timed out'))).toBeTrue()
		expect(local.client.getConnected()).toBeFalse()
		expect(local.cameraManager.startExposureCalls.length).toBe(exposuresBefore)
	}, 15000)
})

describe('closed-loop calibration and guiding', () => {
	// Upper bound on the frames a calibration run may consume before the test gives up. The simulated
	// mount converges in about 14, so this only guards against a run that never completes.
	const MAX_CALIBRATION_FRAMES = 40
	// Frames fed after calibration so the guider finishes averaging its lock reference (the guider
	// default is 6) before a test asserts on measured errors.
	const LOCK_AVERAGING_FRAMES = 8
	// Settle parameters that complete as soon as the frame is inside tolerance, so tests do not wait
	// out the ten-second PHD2 default.
	const IMMEDIATE_SETTLE = { pixels: 5, time: 0, timeout: 5 } as const
	// Per-test timeout, in milliseconds. A closed-loop run feeds tens of frames, each waiting for the
	// commanded pulse to elapse before the next exposure is requested.
	const CLOSED_LOOP_TIMEOUT = 30000
	// Exponential smoothing factor the guider applies to the reported average distance, matching
	// PHD2's Guider::UpdateCurrentDistance.
	const AVG_DIST_ALPHA = 0.3
	// Calibrator overrides that cut the pulses a session has to command. Almost all of its wall time is
	// the client sleeping out those pulses, and their total is the required travel divided by the mount
	// rate. The clearing move only exists to undo the right ascension leg on a real mount, so dropping
	// it removes a third of the pulses without affecting the solve. The travel thresholds keep their
	// defaults: shortening them to a single sample per leg leaves the solved camera angle at the mercy
	// of the centroid error over a seven-pixel baseline.
	const FAST_CALIBRATION = { clearingMoveEnabled: false } as const

	// Creates a dedicated harness, runs a full calibration against its simulated mount and returns it
	// while the client is guiding. Every test owns its harness so the sessions, which spend nearly all
	// of their wall time asleep waiting for commanded pulses, can run concurrently without sharing
	// state through the module-level harness.
	async function calibrateAndGuide(options: GuiderClientOptions = {}) {
		const harness = makeHarness({ ...options, calibrator: FAST_CALIBRATION })

		connect(harness)
		harness.client.loop()
		await feedFrame(harness)
		expect(harness.client.guide(false, IMMEDIATE_SETTLE)).toBeTrue()

		for (let i = 0; i < MAX_CALIBRATION_FRAMES; i++) {
			await feedFrame(harness)
			if (harness.client.getCalibrated()) return harness
		}

		throw new Error('calibration did not converge against the simulated mount')
	}

	// Feeds enough frames for the guider to finish averaging its lock reference.
	async function establishLockReference(harness: Harness) {
		for (let i = 0; i < LOCK_AVERAGING_FRAMES; i++) await feedFrame(harness)
	}

	// Dither size, in pixels. Large enough that the resulting pulses dwarf the sub-pixel corrections
	// the guider keeps issuing, and small enough to stay well inside the maximum frame jump.
	const DITHER_AMOUNT_PX = 3
	// Frames fed after a dither: the guider first re-averages its lock reference and only then walks
	// the star onto the shifted target, which the aggressiveness and hysteresis filters spread out.
	const DITHER_SETTLE_FRAMES = 28
	// Band the accumulated pulse time on the driven axis must fall into, as a fraction of the duration
	// the standalone conversion computes. The guider approaches the shifted target asymptotically and
	// stops inside its minimum-move deadband, so it always commands slightly less than the closed form;
	// the band is still tight enough to catch a wrong rate, a wrong unit or a missing axis projection.
	const DITHER_PULSE_BAND = [0.6, 1.3] as const
	// Largest share of the driven axis' total pulse time the orthogonal axis may accumulate. The
	// residual corrections there are sub-pixel while the dither itself is DITHER_AMOUNT_PX.
	const CROSS_AXIS_PULSE_RATIO = 0.25
	// Pulse ceiling handed to the standalone conversion, matching the guider's own axis maximum.
	const MAX_DITHER_PULSE_MS = 2000

	// Rebuilds the calibration fields the standalone conversion reads from the solution the client
	// itself published, so the comparison uses the very calibration the guider is guiding with.
	function solvedCalibration(harness: Harness) {
		const { xRate, yRate, xParity, yParity } = harness.client.getCalibrationData()

		return {
			ra: { ratePxPerMs: xRate, direction: xParity === '+' ? 'WEST' : 'EAST' },
			dec: { ratePxPerMs: yRate, direction: yParity === '+' ? 'NORTH' : 'SOUTH' },
		} as unknown as GuidingCalibrationResult
	}

	// Collapses recorded pulses into signed milliseconds per axis, positive towards west and north.
	function axisPulseTotals(pulses: readonly PulseRecord[]) {
		let ra = 0
		let dec = 0

		for (const { direction, duration } of pulses) {
			if (direction === 'WEST') ra += duration
			else if (direction === 'EAST') ra -= duration
			else if (direction === 'NORTH') dec += duration
			else dec -= duration
		}

		return [ra, dec] as const
	}

	// Names the direction a signed axis total corresponds to, so it can be compared with a plan.
	function pulseDirection(total: number, positive: GuideDirectionRA | GuideDirectionDEC, negative: GuideDirectionRA | GuideDirectionDEC) {
		return total > 0 ? positive : negative
	}

	// Commands one dither, feeds the frames the guider needs to reach the shifted target and returns
	// the reported image-space offset together with the pulses the correction consumed.
	async function ditherAndSettle(harness: Harness, amount: number) {
		const from = harness.guideOutputManager.pulses.length
		expect(harness.client.dither(amount, false, IMMEDIATE_SETTLE)).toBeTrue()

		for (let i = 0; i < DITHER_SETTLE_FRAMES; i++) await feedFrame(harness)

		const { dx, dy } = eventsOf(harness.events, 'GuidingDithered').at(-1)!
		return { dx, dy, totals: axisPulseTotals(harness.guideOutputManager.pulses.slice(from)) }
	}

	// Lock-target displacement, in pixels, large enough that the right ascension share of it asks for
	// a pulse longer than the guider's 2000 ms maximum on the very first guided frame, even after the
	// hysteresis filter has damped it. At the simulated mount rate that takes a target well outside
	// the frame, which is fine: the star itself never moves, so nothing else about the frame changes.
	const LARGE_LOCK_OFFSET_PX = 250

	// Returns a displacement of `distance` pixels pointing from the star currently locked towards the
	// far side of it, that is, directly away from the other synthetic star. Moving the lock along it
	// keeps the locked star the one nearest to the new target, so the guider does not switch stars.
	function offsetAwayFromOtherStar(harness: Harness, lockX: number, lockY: number, distance: number) {
		const ax = STAR_A[0] + harness.mount.offsetX
		const ay = STAR_A[1] + harness.mount.offsetY
		const bx = STAR_B[0] + harness.mount.offsetX
		const by = STAR_B[1] + harness.mount.offsetY
		const lockedOnA = Math.hypot(lockX - ax, lockY - ay) <= Math.hypot(lockX - bx, lockY - by)
		const dx = lockedOnA ? ax - bx : bx - ax
		const dy = lockedOnA ? ay - by : by - ay
		const length = Math.hypot(dx, dy)
		return [(distance * dx) / length, (distance * dy) / length] as const
	}

	test.concurrent(
		'calibration recovers the simulated mount rate and camera angle on both axes',
		async () => {
			const harness = await calibrateAndGuide()

			const calibration = harness.client.getCalibrationData()
			expect(calibration.calibrated).toBeTrue()
			expect(calibration.xRate).toBeCloseTo(MOUNT_RATE_PX_PER_MS, 3)
			expect(calibration.yRate).toBeCloseTo(MOUNT_RATE_PX_PER_MS, 3)
			// Both axes are recovered with the camera rotation baked in, and stay orthogonal.
			expect(calibration.xAngle).toBeCloseTo(MOUNT_ANGLE, 1)
			expect(Math.abs(calibration.yAngle - calibration.xAngle)).toBeCloseTo(PIOVERTWO, 1)

			expect(eventsOf(harness.events, 'StartCalibration')).toHaveLength(1)
			expect(eventsOf(harness.events, 'CalibrationFailed')).toBeEmpty()
			expect(eventsOf(harness.events, 'Calibrating').length).toBeGreaterThan(1)
			expect(eventsOf(harness.events, 'CalibrationComplete')).toHaveLength(1)
			expect(eventsOf(harness.events, 'StartGuiding')).toHaveLength(1)
			expect(harness.client.getAppState()).toBe('Guiding')
		},
		CLOSED_LOOP_TIMEOUT,
	)

	test.concurrent(
		'a modest DEC reversal is held back by the converted backlash threshold',
		async () => {
			const harness = await calibrateAndGuide()
			await establishLockReference(harness)

			// Drive DEC far enough that the guider commits to north and records lastDecDirection.
			harness.mount.driftX = DEC_AXIS[0] * 0.5
			harness.mount.driftY = DEC_AXIS[1] * 0.5
			for (let i = 0; i < 8; i++) await feedFrame(harness)
			expect(harness.guideOutputManager.pulses.some((pulse) => pulse.direction === 'NORTH')).toBeTrue()

			// Let the hysteresis filter decay so the reverse is measured against a near-zero filtered DEC.
			harness.mount.driftX = 0
			harness.mount.driftY = 0
			for (let i = 0; i < 8; i++) await feedFrame(harness)

			// 0.25 px is above the 0.14 px DEC deadband but below the 0.32 px backlash accumulation
			// threshold. After converting those pixel defaults into milliseconds, the first reverse
			// frames must not pulse south; without the conversion a 0.32 ms accum threshold would let
			// them through immediately and excite DEC backlash.
			const from = harness.guideOutputManager.pulses.length
			harness.mount.driftX = -DEC_AXIS[0] * 0.25
			harness.mount.driftY = -DEC_AXIS[1] * 0.25
			for (let i = 0; i < 2; i++) await feedFrame(harness)

			expect(harness.guideOutputManager.pulses.slice(from).some((pulse) => pulse.direction === 'SOUTH')).toBeFalse()
		},
		CLOSED_LOOP_TIMEOUT,
	)

	test.concurrent(
		'flipping the calibration rotates the solved axes by half a turn',
		async () => {
			const harness = await calibrateAndGuide()

			const before = harness.client.getCalibrationData()
			expect(harness.client.flipCalibration()).toBeTrue()
			const after = harness.client.getCalibrationData()

			expect(after.xRate).toBeCloseTo(before.xRate, 6)
			expect(Math.cos(after.xAngle - before.xAngle)).toBeCloseTo(-1, 6)
			expect(eventsOf(harness.events, 'CalibrationDataFlipped')).toHaveLength(1)
		},
		CLOSED_LOOP_TIMEOUT,
	)

	test.concurrent(
		'flip and DEC mode keep the dithered lock',
		async () => {
			const harness = await calibrateAndGuide()
			await establishLockReference(harness)

			expect(harness.client.dither(3, false, IMMEDIATE_SETTLE)).toBeTrue()
			const dithered = harness.client.getLockPosition()!

			expect(harness.client.flipCalibration()).toBeTrue()
			harness.client.setDeclinationGuideMode('North')

			for (let i = 0; i < 3; i++) await feedFrame(harness)

			const lock = harness.client.getLockPosition()!
			expect(lock[0]).toBeCloseTo(dithered[0], 1)
			expect(lock[1]).toBeCloseTo(dithered[1], 1)
			expect(harness.client.getAppState()).toBe('Guiding')
		},
		CLOSED_LOOP_TIMEOUT,
	)

	test.concurrent(
		'startGuidingAssistant is allowed after a settled dither',
		async () => {
			const harness = await calibrateAndGuide()
			await establishLockReference(harness)

			expect(harness.client.dither(3, false, IMMEDIATE_SETTLE)).toBeTrue()
			expect(harness.client.startGuidingAssistant({ measureBacklash: false })).toBeFalse()

			for (let i = 0; i < 2; i++) await feedFrame(harness)

			expect(eventsOf(harness.events, 'SettleDone').length).toBeGreaterThan(0)
			expect(harness.client.startGuidingAssistant({ measureBacklash: false })).toBeTrue()
			harness.client.stopGuidingAssistant()
		},
		CLOSED_LOOP_TIMEOUT,
	)

	test.concurrent(
		'startGuidingAssistant is allowed while lock-shift holds a non-zero offset',
		async () => {
			const harness = await calibrateAndGuide()
			await establishLockReference(harness)

			expect(harness.client.setLockShiftParams({ rate: [3600000, 0], axes: 'X/Y' })).toBeTrue()
			expect(harness.client.setLockShiftEnabled(true)).toBeTrue()
			await feedFrame(harness)
			await feedFrame(harness)

			expect(harness.client.startGuidingAssistant({ measureBacklash: false })).toBeTrue()
			harness.client.stopGuidingAssistant()
		},
		CLOSED_LOOP_TIMEOUT,
	)

	test.concurrent(
		'finishing the guiding assistant keeps the lock',
		async () => {
			const harness = await calibrateAndGuide()
			await establishLockReference(harness)

			const lock = harness.client.getLockPosition()!
			harness.mount.driftX = RA_AXIS[0] * 0.8
			harness.mount.driftY = RA_AXIS[1] * 0.8
			for (let i = 0; i < 4; i++) await feedFrame(harness)

			expect(harness.client.startGuidingAssistant({ measureBacklash: false })).toBeTrue()
			expect(harness.client.stopGuidingAssistant()).toBeDefined()

			const from = harness.guideOutputManager.pulses.length
			for (let i = 0; i < 2; i++) await feedFrame(harness)

			const after = harness.client.getLockPosition()!
			expect(after[0]).toBeCloseTo(lock[0], 1)
			expect(after[1]).toBeCloseTo(lock[1], 1)
			expect(harness.guideOutputManager.pulses.length).toBeGreaterThan(from)
			expect(harness.client.getAppState()).toBe('Guiding')
		},
		CLOSED_LOOP_TIMEOUT,
	)

	test.concurrent(
		'guide steps timestamp their frames from the start of guiding',
		async () => {
			const harness = await calibrateAndGuide()
			await establishLockReference(harness)

			const steps = eventsOf(harness.events, 'GuideStep')
			expect(steps.length).toBeGreaterThan(1)

			// PHD2 reports the elapsed guiding time in seconds, so the first step is near zero rather
			// than an absolute epoch, and the sequence never goes backwards.
			expect(steps[0].Time).toBeGreaterThanOrEqual(0)
			expect(steps[0].Time).toBeLessThan(5)

			for (let i = 1; i < steps.length; i++) {
				expect(steps[i].Time).toBeGreaterThanOrEqual(steps[i - 1].Time)
				expect(steps[i].Frame).toBeGreaterThan(steps[i - 1].Frame)
			}

			expect(steps.at(-1)!.Time).toBeGreaterThan(0)
		},
		CLOSED_LOOP_TIMEOUT,
	)

	test.concurrent(
		'the reported average distance is a low-pass filter over the per-frame distance',
		async () => {
			const harness = await calibrateAndGuide()
			await establishLockReference(harness)

			// A steady drift larger than the residual the guider can remove in one frame keeps the
			// measured error non-zero, so the smoothing is observable.
			harness.mount.driftX = 3
			harness.mount.driftY = 2

			for (let i = 0; i < 8; i++) await feedFrame(harness)

			const steps = eventsOf(harness.events, 'GuideStep').slice(-6)
			expect(steps.length).toBe(6)

			expect(steps.at(-1)!.AvgDist).toBeGreaterThan(0)

			for (let i = 1; i < steps.length; i++) {
				const distance = Math.hypot(steps[i].dx, steps[i].dy)
				const expected = steps[i - 1].AvgDist + AVG_DIST_ALPHA * (distance - steps[i - 1].AvgDist)
				expect(steps[i].AvgDist).toBeCloseTo(expected, 6)
			}
		},
		CLOSED_LOOP_TIMEOUT,
	)

	test.concurrent(
		'a pulse throw still queues the next exposure',
		async () => {
			const harness = await calibrateAndGuide()
			await establishLockReference(harness)

			harness.mount.driftX = RA_AXIS[0] * 1.2
			harness.mount.driftY = RA_AXIS[1] * 1.2
			const originalPulse = harness.guideOutputManager.pulse.bind(harness.guideOutputManager)
			harness.guideOutputManager.pulse = () => {
				throw new Error('pulse failed')
			}

			const exposuresBefore = harness.cameraManager.startExposureCalls.length
			await feedFrame(harness)

			expect(eventsOf(harness.events, 'Alert').some((alert) => alert.Type === 'error' && alert.Msg.includes('pulse failed'))).toBeTrue()
			expect(harness.cameraManager.startExposureCalls.length).toBeGreaterThan(exposuresBefore)

			harness.guideOutputManager.pulse = originalPulse
			await feedFrame(harness)
			expect(harness.client.getAppState()).toBe('Guiding')
		},
		CLOSED_LOOP_TIMEOUT,
	)

	test.concurrent(
		'a later-axis pulse throw still waits for the issued pulse to finish',
		async () => {
			const harness = await calibrateAndGuide()
			await establishLockReference(harness)

			harness.mount.driftX = RA_AXIS[0] * 4 + DEC_AXIS[0] * 4
			harness.mount.driftY = RA_AXIS[1] * 4 + DEC_AXIS[1] * 4

			const originalPulse = harness.guideOutputManager.pulse.bind(harness.guideOutputManager)
			let firstDuration = 0
			let pulseAt = 0
			let pulseCalls = 0
			harness.guideOutputManager.pulse = (device, direction, duration) => {
				pulseCalls++
				if (pulseCalls > 1) throw new Error('second axis failed')
				firstDuration = duration
				pulseAt = performance.now()
				originalPulse(device, direction, duration)
			}

			let exposureAt = 0
			const originalStart = harness.cameraManager.startExposure.bind(harness.cameraManager)
			harness.cameraManager.startExposure = (camera, exposure) => {
				exposureAt = performance.now()
				originalStart(camera, exposure)
			}

			await feedFrame(harness)

			expect(firstDuration).toBeGreaterThan(0)
			expect(eventsOf(harness.events, 'Alert').some((alert) => alert.Type === 'error' && alert.Msg.includes('second axis failed'))).toBeTrue()
			expect(exposureAt - pulseAt).toBeGreaterThanOrEqual(firstDuration)
			expect(harness.guideOutput.pulsing).toBeFalse()
		},
		CLOSED_LOOP_TIMEOUT,
	)

	test.concurrent(
		'the next exposure waits until the guide output reports idle after a pulse',
		async () => {
			const harness = await calibrateAndGuide()
			await establishLockReference(harness)

			harness.guideOutputManager.pulseBusyOverhangMs = 80
			harness.mount.driftX = RA_AXIS[0] * 1.2
			harness.mount.driftY = RA_AXIS[1] * 1.2

			const pulsesBefore = harness.guideOutputManager.pulses.length
			const started = performance.now()
			await feedFrame(harness)

			expect(harness.guideOutputManager.pulses.length).toBeGreaterThan(pulsesBefore)
			expect(harness.guideOutput.pulsing).toBeFalse()
			expect(performance.now() - started).toBeGreaterThanOrEqual(80)
		},
		CLOSED_LOOP_TIMEOUT,
	)

	test.concurrent(
		'an arriving guide frame cancels the exposure watchdog',
		async () => {
			const harness = await calibrateAndGuide()
			await establishLockReference(harness)

			const exposuresBefore = harness.cameraManager.startExposureCalls.length
			const timeoutAlertsBefore = eventsOf(harness.events, 'Alert').filter((alert) => alert.Type === 'warning' && alert.Msg.includes('timed out')).length

			harness.guideOutputManager.pulseBusyOverhangMs = 400
			harness.mount.driftX = RA_AXIS[0] * 1.2
			harness.mount.driftY = RA_AXIS[1] * 1.2

			const pulsesBefore = harness.guideOutputManager.pulses.length
			harness.mount.advance(harness.guideOutputManager.pulses)
			const buffer = await buildFrameBuffer(harness.mount.offsetX, harness.mount.offsetY)
			await Bun.sleep(4700)
			await feedBuffer(harness, buffer)

			expect(harness.guideOutputManager.pulses.length).toBeGreaterThan(pulsesBefore)
			const timeoutAlerts = eventsOf(harness.events, 'Alert').filter((alert) => alert.Type === 'warning' && alert.Msg.includes('timed out'))
			expect(timeoutAlerts.length).toBe(timeoutAlertsBefore)
			expect(harness.cameraManager.startExposureCalls.length).toBe(exposuresBefore + 1)
		},
		CLOSED_LOOP_TIMEOUT,
	)

	test.concurrent(
		'the next exposure waits for a delayed Busy acknowledgement before starting',
		async () => {
			const harness = await calibrateAndGuide()
			await establishLockReference(harness)

			harness.guideOutputManager.pulseBusyAckLagMs = 40
			harness.mount.driftX = RA_AXIS[0] * 1.2
			harness.mount.driftY = RA_AXIS[1] * 1.2

			let exposureAt = 0
			const originalStart = harness.cameraManager.startExposure.bind(harness.cameraManager)
			harness.cameraManager.startExposure = (camera, exposure) => {
				exposureAt = performance.now()
				originalStart(camera, exposure)
			}

			const pulsesBefore = harness.guideOutputManager.pulses.length
			await feedFrame(harness)

			expect(harness.guideOutputManager.pulses.length).toBeGreaterThan(pulsesBefore)
			expect(harness.guideOutputManager.lastBusyAt).toBeGreaterThan(0)
			expect(harness.guideOutputManager.lastIdleAt).toBeGreaterThan(harness.guideOutputManager.lastBusyAt)
			expect(harness.guideOutput.pulsing).toBeFalse()
			expect(exposureAt).toBeGreaterThanOrEqual(harness.guideOutputManager.lastIdleAt)
		},
		CLOSED_LOOP_TIMEOUT,
	)

	test.concurrent(
		'the next exposure waits for Idle when Busy arrives near the latency margin',
		async () => {
			const harness = await calibrateAndGuide()
			await establishLockReference(harness)

			harness.guideOutputManager.pulseBusyAckLagMs = 240
			harness.guideOutputManager.pulseBusyOverhangMs = 80
			harness.mount.driftX = RA_AXIS[0] * 1.2
			harness.mount.driftY = RA_AXIS[1] * 1.2

			let exposureAt = 0
			const originalStart = harness.cameraManager.startExposure.bind(harness.cameraManager)
			harness.cameraManager.startExposure = (camera, exposure) => {
				exposureAt = performance.now()
				originalStart(camera, exposure)
			}

			const pulsesBefore = harness.guideOutputManager.pulses.length
			await feedFrame(harness)

			expect(harness.guideOutputManager.pulses.length).toBeGreaterThan(pulsesBefore)
			expect(harness.guideOutputManager.lastBusyAt).toBeGreaterThan(0)
			expect(harness.guideOutputManager.lastIdleAt).toBeGreaterThan(harness.guideOutputManager.lastBusyAt)
			expect(harness.guideOutput.pulsing).toBeFalse()
			expect(exposureAt).toBeGreaterThanOrEqual(harness.guideOutputManager.lastIdleAt)
		},
		CLOSED_LOOP_TIMEOUT,
	)

	test.concurrent(
		'changing the exposure cadence does not double the guide pulse for the same error',
		async () => {
			const harness = await calibrateAndGuide()
			await establishLockReference(harness)

			harness.mount.driftX = RA_AXIS[0] * 0.8
			harness.mount.driftY = RA_AXIS[1] * 0.8
			for (let i = 0; i < 4; i++) await feedFrame(harness)
			const atOneSecond = eventsOf(harness.events, 'GuideStep').at(-1)!.RADuration

			harness.client.setExposure(2000)
			for (let i = 0; i < 4; i++) await feedFrame(harness)
			const atTwoSeconds = eventsOf(harness.events, 'GuideStep').at(-1)!.RADuration

			// cadenceMs tracks the requested exposure, so a 2 s cadence must not apply the old
			// lastCadence/1000 scale cap of 2x. The two pulses chase the same per-frame drift.
			expect(atTwoSeconds).toBeGreaterThan(0)
			expect(atTwoSeconds).toBeLessThan(atOneSecond * 1.6 + 1)
		},
		CLOSED_LOOP_TIMEOUT,
	)

	test.concurrent(
		'an in-flight frame keeps the exposure duration that produced it',
		async () => {
			const harness = await calibrateAndGuide()
			await establishLockReference(harness)

			harness.mount.driftX = RA_AXIS[0] * 0.8
			harness.mount.driftY = RA_AXIS[1] * 0.8
			for (let i = 0; i < 4; i++) await feedFrame(harness)
			const atIssuedCadence = eventsOf(harness.events, 'GuideStep').at(-1)!.RADuration
			expect(atIssuedCadence).toBeGreaterThan(0)

			const exposuresBefore = harness.cameraManager.startExposureCalls.length
			expect(harness.client.setExposure(2000)).toBeTrue()
			expect(harness.cameraManager.startExposureCalls.length).toBe(exposuresBefore)

			await feedFrame(harness)
			const inFlight = eventsOf(harness.events, 'GuideStep').at(-1)!.RADuration
			expect(inFlight).toBeGreaterThan(0)
			expect(inFlight).toBeLessThan(atIssuedCadence * 0.75)
		},
		CLOSED_LOOP_TIMEOUT,
	)

	test.concurrent(
		'guide-step RA and DEC distances are pixel projections of the image offset',
		async () => {
			const harness = await calibrateAndGuide()
			await establishLockReference(harness)

			harness.mount.driftX = 2
			harness.mount.driftY = 1
			for (let i = 0; i < 4; i++) await feedFrame(harness)

			const steps = eventsOf(harness.events, 'GuideStep').slice(-4)
			expect(steps.length).toBe(4)

			for (const step of steps) {
				const imageDistance = Math.hypot(step.dx, step.dy)
				const axisDistance = Math.hypot(step.RADistanceRaw, step.DECDistanceRaw)
				// PHD2 reports axis distances in pixels, matching the image offset length on an
				// orthogonal calibration. Millisecond axis errors would be ~1/rate (~87x) larger.
				expect(axisDistance).toBeCloseTo(imageDistance, 3)
			}
		},
		CLOSED_LOOP_TIMEOUT,
	)

	test.concurrent(
		'axis limit flags are omitted while the pulses stay inside the maximum duration',
		async () => {
			const harness = await calibrateAndGuide()
			await establishLockReference(harness)

			const steps = eventsOf(harness.events, 'GuideStep')
			expect(steps.length).toBeGreaterThan(0)

			// PHD2 only serializes RALimited/DecLimited when the pulse was actually clipped.
			for (const step of steps) {
				expect(step).not.toHaveProperty('RALimited')
				expect(step).not.toHaveProperty('DecLimited')
			}
		},
		CLOSED_LOOP_TIMEOUT,
	)

	test.concurrent(
		'an error large enough to saturate the right ascension pulse reports RALimited',
		async () => {
			const harness = await calibrateAndGuide()
			await establishLockReference(harness)

			// Moving the lock target instead of the star creates an arbitrarily large guide error without
			// tripping the frame-jump rejection, and a sticky lock keeps the guider from re-averaging its
			// reference back onto the star. The offset points away from the other star so the guider keeps
			// tracking the same one, and its right ascension component alone exceeds the axis maximum.
			harness.client.setStickyLockPositionEnabled(true)
			const [lockX, lockY] = harness.client.getLockPosition()!
			const [awayX, awayY] = offsetAwayFromOtherStar(harness, lockX, lockY, LARGE_LOCK_OFFSET_PX)
			expect(harness.client.setLockPosition(lockX + awayX, lockY + awayY, true)).toBeTrue()

			let steps = eventsOf(harness.events, 'GuideStep')
			let limited: (typeof steps)[number] | undefined

			// The moved lock target restarts the reference averaging, so the first frames report no error.
			for (let i = 0; i < 14 && limited === undefined; i++) {
				await feedFrame(harness)
				steps = eventsOf(harness.events, 'GuideStep')
				limited = steps.find((step) => step.RALimited === true)
			}

			expect(limited).toBeDefined()
			// The clipped pulse is reported at exactly the configured right ascension maximum, while the
			// declination axis, which sees a much smaller share of the offset, is never clipped.
			expect(limited!.RADuration).toBe(2000)
			expect(limited!.DecLimited).toBeUndefined()
		},
		CLOSED_LOOP_TIMEOUT,
	)

	test.concurrent(
		'a star outside the search region is reported lost',
		async () => {
			const harness = await calibrateAndGuide({ searchRegion: 32 })
			await establishLockReference(harness)
			expect(harness.client.getAppState()).toBe('Guiding')

			// Half of the 32 px box is 16 px. A 24 px jump leaves the locked star outside the box
			// while still on the frame, so tracking must stop instead of following it or switching
			// to the neighbor.
			harness.mount.offsetX += 24

			for (let i = 0; i < 10; i++) await feedFrame(harness)

			expect(harness.client.getAppState()).toBe('LostLock')
			expect(eventsOf(harness.events, 'StarLost').length).toBeGreaterThan(0)
		},
		CLOSED_LOOP_TIMEOUT,
	)

	test.concurrent(
		'a star that stays inside the search region keeps the lock',
		async () => {
			const harness = await calibrateAndGuide({ searchRegion: 64 })
			await establishLockReference(harness)

			harness.mount.offsetX += 10
			for (let i = 0; i < 4; i++) await feedFrame(harness)

			expect(harness.client.getAppState()).toBe('Guiding')
			expect(eventsOf(harness.events, 'StarLost')).toBeEmpty()
		},
		CLOSED_LOOP_TIMEOUT,
	)

	test.concurrent(
		'stars outside the search box remain available for multi-star measurement',
		async () => {
			const frames: GuideFrameImage[] = []
			const harness = await calibrateAndGuide({
				handler: { frame: (_client, frame) => frames.push(frame) },
			})
			await establishLockReference(harness)
			await feedFrame(harness)

			const frame = frames.at(-1)!
			expect(frame.stars.length).toBeGreaterThanOrEqual(2)
			expect(frame.acceptedStars?.length).toBeGreaterThanOrEqual(2)
			expect(frame.star).toBeDefined()

			const primary = frame.star!
			const secondary = frame.stars.find((star) => Math.hypot(star.x - primary.x, star.y - primary.y) > harness.client.getSearchRegion() / 2)
			expect(secondary).toBeDefined()
			expect(harness.client.getAppState()).toBe('Guiding')
			expect(eventsOf(harness.events, 'StarLost')).toBeEmpty()
		},
		CLOSED_LOOP_TIMEOUT,
	)

	test.concurrent(
		'star-free frames report a lost star every frame but a lost lock position only once',
		async () => {
			const harness = await calibrateAndGuide()
			await establishLockReference(harness)

			// The guider tolerates a few missing frames before declaring the star lost, so the first
			// star-free frames produce no StarLost at all.
			for (let i = 0; i < 10; i++) await feedEmptyFrame(harness)

			expect(harness.client.getAppState()).toBe('LostLock')
			// PHD2 emits StarLost for every frame the star is missing, but LockPositionLost only on the
			// transition into the lost-lock state.
			expect(eventsOf(harness.events, 'StarLost').length).toBeGreaterThanOrEqual(6)
			expect(eventsOf(harness.events, 'LockPositionLost')).toHaveLength(1)

			const lost = eventsOf(harness.events, 'StarLost')

			for (let i = 1; i < lost.length; i++) expect(lost[i].Frame).toBeGreaterThan(lost[i - 1].Frame)
		},
		CLOSED_LOOP_TIMEOUT,
	)

	test.concurrent(
		'guiding recovers the star after a run of star-free frames',
		async () => {
			const harness = await calibrateAndGuide()
			await establishLockReference(harness)

			for (let i = 0; i < 8; i++) await feedEmptyFrame(harness)
			expect(harness.client.getAppState()).toBe('LostLock')

			const stepsWhileLost = eventsOf(harness.events, 'GuideStep').length

			for (let i = 0; i < 4; i++) await feedFrame(harness)

			expect(harness.client.getAppState()).toBe('Guiding')
			expect(eventsOf(harness.events, 'GuideStep').length).toBeGreaterThan(stepsWhileLost)
			// The recovery does not report a second lost lock position.
			expect(eventsOf(harness.events, 'LockPositionLost')).toHaveLength(1)
		},
		CLOSED_LOOP_TIMEOUT,
	)

	test.concurrent(
		'guide during a partial pause does not start a second exposure',
		async () => {
			const harness = await calibrateAndGuide()
			await establishLockReference(harness)

			const exposuresBefore = harness.cameraManager.startExposureCalls.length
			expect(harness.client.setPaused(true, false)).toBeTrue()
			expect(harness.cameraManager.startExposureCalls.length).toBe(exposuresBefore)

			expect(harness.client.guide(false, IMMEDIATE_SETTLE)).toBeTrue()
			expect(harness.client.getPaused()).toBeFalse()
			expect(harness.client.getAppState()).toBe('Guiding')
			expect(harness.cameraManager.startExposureCalls.length).toBe(exposuresBefore)

			await feedFrame(harness)
			expect(harness.cameraManager.startExposureCalls.length).toBe(exposuresBefore + 1)
		},
		CLOSED_LOOP_TIMEOUT,
	)

	test.concurrent(
		'guide while paused resumes without dropping the dither',
		async () => {
			const harness = await calibrateAndGuide()
			await establishLockReference(harness)

			expect(harness.client.dither(3, false, IMMEDIATE_SETTLE)).toBeTrue()
			const dithered = harness.client.getLockPosition()!
			const startGuiding = eventsOf(harness.events, 'StartGuiding').length
			const settleBegin = eventsOf(harness.events, 'SettleBegin').length

			expect(harness.client.setPaused(true)).toBeTrue()
			expect(harness.client.getAppState()).toBe('Paused')
			expect(harness.client.guide(false, IMMEDIATE_SETTLE)).toBeTrue()

			expect(harness.client.getPaused()).toBeFalse()
			expect(harness.client.getAppState()).toBe('Guiding')
			expect(eventsOf(harness.events, 'Resumed')).toHaveLength(1)
			expect(eventsOf(harness.events, 'StartGuiding')).toHaveLength(startGuiding)
			expect(eventsOf(harness.events, 'SettleBegin').length).toBe(settleBegin + 1)

			for (let i = 0; i < 3; i++) await feedFrame(harness)

			const lock = harness.client.getLockPosition()!
			expect(lock[0]).toBeCloseTo(dithered[0], 1)
			expect(lock[1]).toBeCloseTo(dithered[1], 1)
		},
		CLOSED_LOOP_TIMEOUT,
	)

	test.concurrent(
		'dithering offsets the lock position and starts a new settle cycle',
		async () => {
			const harness = await calibrateAndGuide()
			await establishLockReference(harness)

			const before = harness.client.getLockPosition()
			expect(before).toBeDefined()

			const settleEvents = eventsOf(harness.events, 'SettleBegin').length
			expect(harness.client.dither(3, false, IMMEDIATE_SETTLE)).toBeTrue()

			const dithered = eventsOf(harness.events, 'GuidingDithered')
			expect(dithered).toHaveLength(1)
			expect(Math.hypot(dithered[0].dx, dithered[0].dy)).toBeGreaterThan(0)
			expect(eventsOf(harness.events, 'SettleBegin').length).toBe(settleEvents + 1)

			const after = harness.client.getLockPosition()!
			expect(after[0]).toBeCloseTo(before![0] + dithered[0].dx, 6)
			expect(after[1]).toBeCloseTo(before![1] + dithered[0].dy, 6)

			// The dither moves the lock target, so the guider re-averages its reference before reporting
			// usable errors again; the settle cycle only completes after those frames.
			for (let i = 0; i < 10; i++) await feedFrame(harness)

			expect(eventsOf(harness.events, 'SettleDone')).not.toBeEmpty()
			expect(harness.client.getSettling()).toBeFalse()
		},
		CLOSED_LOOP_TIMEOUT,
	)

	test.concurrent(
		'a spiral dither walks the lattice and pulses the axes the standalone plan computes',
		async () => {
			const harness = await calibrateAndGuide({ ditherMode: 'spiral' })
			await establishLockReference(harness)

			const calibration = solvedCalibration(harness)
			const first = await ditherAndSettle(harness, DITHER_AMOUNT_PX)

			// The spiral opens with a declination-only step, so the guider must drive declination alone,
			// in the direction and for the duration the standalone conversion computes from the same
			// calibration. This is the end-to-end guard on the sign convention: an inverted rule would
			// keep the magnitudes and flip the direction.
			const decPlan = ditherPulsePlanFromCalibration({ rightAscension: 0, declination: DITHER_AMOUNT_PX }, calibration, MAX_DITHER_PULSE_MS)!
			expect(decPlan.rightAscension).toBeUndefined()
			expect(pulseDirection(first.totals[1], 'NORTH', 'SOUTH')).toBe(decPlan.declination!.direction)
			expect(Math.abs(first.totals[1])).toBeGreaterThan(DITHER_PULSE_BAND[0] * decPlan.declination!.duration)
			expect(Math.abs(first.totals[1])).toBeLessThan(DITHER_PULSE_BAND[1] * decPlan.declination!.duration)
			expect(Math.abs(first.totals[0])).toBeLessThan(CROSS_AXIS_PULSE_RATIO * Math.abs(first.totals[1]))
			expect(Math.hypot(first.dx, first.dy)).toBeCloseTo(DITHER_AMOUNT_PX, 6)

			const second = await ditherAndSettle(harness, DITHER_AMOUNT_PX)

			// The second lattice step is right ascension only and orthogonal to the first.
			const raPlan = ditherPulsePlanFromCalibration({ rightAscension: DITHER_AMOUNT_PX, declination: 0 }, calibration, MAX_DITHER_PULSE_MS)!
			expect(raPlan.declination).toBeUndefined()
			expect(pulseDirection(second.totals[0], 'WEST', 'EAST')).toBe(raPlan.rightAscension!.direction)
			expect(Math.abs(second.totals[0])).toBeGreaterThan(DITHER_PULSE_BAND[0] * raPlan.rightAscension!.duration)
			expect(Math.abs(second.totals[0])).toBeLessThan(DITHER_PULSE_BAND[1] * raPlan.rightAscension!.duration)
			expect(Math.abs(second.totals[1])).toBeLessThan(CROSS_AXIS_PULSE_RATIO * Math.abs(second.totals[0]))
			expect(first.dx * second.dx + first.dy * second.dy).toBeCloseTo(0, 6)

			// Re-selecting the same mode restarts the lattice, so the next dither repeats the first step.
			harness.client.setDitherMode('spiral')
			const third = await ditherAndSettle(harness, DITHER_AMOUNT_PX)

			expect(third.dx).toBeCloseTo(first.dx, 6)
			expect(third.dy).toBeCloseTo(first.dy, 6)
		},
		CLOSED_LOOP_TIMEOUT,
	)

	test.concurrent(
		'stopping a guiding session reports both stop events and keeps the calibration',
		async () => {
			const harness = await calibrateAndGuide()
			await establishLockReference(harness)

			harness.client.stopCapture()

			expect(harness.client.getAppState()).toBe('Stopped')
			expect(eventsOf(harness.events, 'GuidingStopped')).toHaveLength(1)
			expect(eventsOf(harness.events, 'LoopingExposuresStopped')).toHaveLength(1)
			// A stop does not invalidate the solved calibration, so guiding can resume without one.
			expect(harness.client.getCalibrated()).toBeTrue()
		},
		CLOSED_LOOP_TIMEOUT,
	)
})
