import { ARCSEC_PER_RADIAN } from '../../src/core/constants'
import { type Camera, DEFAULT_CAMERA, DEFAULT_GUIDE_OUTPUT, type GuideDirection, type GuideOutput } from '../../src/devices/indi/device'
import type { CameraManager } from '../../src/devices/indi/manager/camera'
import type { DeviceHandler } from '../../src/devices/indi/manager/device'
import type { GuideOutputManager } from '../../src/devices/indi/manager/guideoutput'
import { GuiderClient, type GuiderClientOptions } from '../../src/observation/guiding/client'
import { PHD2Server, type PHD2ServerOptions, type PHD2ServerRequest, type PHD2ServerResponse } from '../../src/observation/guiding/phd2/server'
import { StarTracker } from '../../src/observation/guiding/tracker.star'

// A PHD2Server on a free local port over a real GuiderClient whose camera and guide-output managers are fakes: the
// camera exposes nothing unless a test feeds a BLOB through `cameraManager.handler`, and the guide output only
// records its pulses.

// Camera manager that records the exposures and keeps the handler of the GuiderClient, so a test can feed BLOBs.
export class FakeGuideCameraManager {
	handler?: DeviceHandler<Camera>
	readonly exposures: number[] = []
	stopped = 0

	addHandler(handler: DeviceHandler<Camera>) {
		this.handler = handler
	}

	removeHandler() {
		this.handler = undefined
	}

	enableBlob() {}

	disableBlob() {}

	startExposure(_camera: Camera, exposure: number) {
		this.exposures.push(exposure)
	}

	stopExposure() {
		this.stopped++
	}
}

// Guide-output manager that records every pulse and never reports one as running.
export class FakeGuideOutputManager {
	readonly pulses: { readonly direction: GuideDirection; readonly duration: number }[] = []

	addHandler() {}

	removeHandler() {}

	pulse(_device: GuideOutput, direction: GuideDirection, duration: number) {
		this.pulses.push({ direction, duration })
	}
}

// Pixel scale of the guide camera of the rig, in arcsec/pixel.
export const PHD2_RIG_PIXEL_SCALE = 1.5

// Guide-camera pixel size of the rig, in µm; the focal length follows from PHD2_RIG_PIXEL_SCALE.
const PIXEL_SIZE = 3

// One request the server executed, with its outcome.
export interface PHD2RigRequest {
	readonly connection: number
	readonly request: PHD2ServerRequest
	readonly response: PHD2ServerResponse
}

// A started server over a GuiderClient, its fakes and the requests it executed.
export interface PHD2Rig extends Disposable {
	readonly guider: GuiderClient
	readonly server: PHD2Server
	readonly cameraManager: FakeGuideCameraManager
	readonly guideOutputManager: FakeGuideOutputManager
	readonly camera: Camera
	readonly guideOutput: GuideOutput
	readonly requests: PHD2RigRequest[]
	// Methods of the executed requests, in order.
	readonly methods: () => string[]
}

// Options of the rig: whether the guider starts connected to its devices, and the guider and server options.
export interface PHD2RigOptions {
	readonly connected?: boolean
	readonly guider?: GuiderClientOptions
	readonly server?: PHD2ServerOptions
}

// Builds a connected-capable guide camera of `width` x `height` pixels.
export function makeGuideCamera(width = 240, height = 240): Camera {
	const camera = structuredClone(DEFAULT_CAMERA)
	camera.id = 'Guide Camera'
	camera.name = 'Guide Camera'
	camera.connected = true
	camera.frame.width.value = width
	camera.frame.height.value = height
	camera.bin.x.value = 1
	camera.bin.y.value = 1
	return camera
}

// Builds a connected guide output able to pulse.
export function makeGuideOutput(): GuideOutput {
	const output = structuredClone(DEFAULT_GUIDE_OUTPUT)
	output.id = 'Mount'
	output.name = 'Mount'
	output.connected = true
	output.canPulseGuide = true
	return output
}

// Starts a server on 127.0.0.1 and a free port. The guider is connected to the devices unless `connected` is false;
// the devices (with optics giving PHD2_RIG_PIXEL_SCALE) are also those of `set_connected`.
export function createPHD2Rig(options: PHD2RigOptions = {}): PHD2Rig {
	const cameraManager = new FakeGuideCameraManager()
	const guideOutputManager = new FakeGuideOutputManager()
	const guider = new GuiderClient(cameraManager as unknown as CameraManager, guideOutputManager as unknown as GuideOutputManager, new StarTracker(), options.guider)
	const camera = makeGuideCamera()
	const guideOutput = makeGuideOutput()
	const connectOptions = { pixelSize: PIXEL_SIZE, focalLength: (ARCSEC_PER_RADIAN / 1000) * (PIXEL_SIZE / PHD2_RIG_PIXEL_SCALE) }
	const server = new PHD2Server(guider, { devices: { camera, guideOutput, options: connectOptions }, ...options.server })
	const requests: PHD2RigRequest[] = []

	server.addHandler({ command: (_, connection, request, response) => void requests.push({ connection, request, response }) })
	if (options.connected !== false) guider.connect(camera, guideOutput, connectOptions)
	server.start('127.0.0.1', 0)

	return {
		guider,
		server,
		cameraManager,
		guideOutputManager,
		camera,
		guideOutput,
		requests,
		methods: () => requests.map((entry) => entry.request.method),
		[Symbol.dispose]: () => {
			server.stop()
			guider.stopCapture()
			guider.disconnect()
		},
	}
}
