import { GuideOutputCommander } from '../../src/devices/commanders/guideoutput'
import { MountCommander } from '../../src/devices/commanders/mount'
import { IndiClientHandlerSet } from '../../src/devices/indi/client'
import type { Camera, GuideOutput, Mount } from '../../src/devices/indi/device'
import { CameraManager } from '../../src/devices/indi/manager/camera'
import { GuideOutputManager } from '../../src/devices/indi/manager/guideoutput'
import { MountManager } from '../../src/devices/indi/manager/mount'
import { CameraSimulator } from '../../src/devices/indi/simulator/camera'
import { ClientSimulator } from '../../src/devices/indi/simulator/client'
import { MountSimulator } from '../../src/devices/indi/simulator/mount'
import type { CatalogSource, CatalogSourceStar } from '../../src/devices/indi/simulator/types'
import type { BlobEncoding } from '../../src/devices/indi/types'
import { DeviceLifecycle } from '../../src/devices/orchestration/device.lifecycle'
import { OperationCoordinator } from '../../src/devices/orchestration/operation'
import { ResourceArbiter, resourceKey } from '../../src/devices/orchestration/resource'
import { readImageFromBuffer, readImageFromSource } from '../../src/imaging/model/image'
import type { Image } from '../../src/imaging/model/types'
import { detectStars } from '../../src/imaging/stars/detector'
import { base64Source, bufferSource } from '../../src/io/io'
import { arcmin, deg, hour, normalizeAngle } from '../../src/math/units/angle'
import { CameraCapturer } from '../../src/observation/capture/capture'
import { GuiderClient } from '../../src/observation/guiding/client'
import { enrichGuideStars, StarTracker } from '../../src/observation/guiding/tracker.star'
import { waitUntil } from '../util'

// Two-camera guiding rig of the guiding integration tests: one mount simulator whose ST4 port is the guide output,
// a main imaging camera and a guide camera, both snooping that mount, with the real managers, arbiter, coordinator,
// device lifecycle, guide output and mount commanders, a capturer for the main camera and a GuiderClient on the guide
// camera that decodes the simulator FITS BLOBs and detects stars with the toolkit detector. The guide camera renders a
// fixed star field in J2000 around the initial pointing, so guide pulses and slews move it across the sensor as the
// mount's boresight moves; the mount error models are off, so the field only moves by what the mount is commanded to
// do. Everything runs on the real-time simulators.

// Pointing the rig syncs the mount to: RA 6h, Dec +20°, in radians.
export const GUIDING_RIG_POINTING = { rightAscension: hour(6), declination: deg(20) } as const

// Focal length of the guide camera, in millimeters: about 1.07 arcsec per 5.2 µm pixel.
export const GUIDING_RIG_GUIDE_FOCAL_LENGTH = 1000

// Guide camera subframe, in unbinned sensor pixels, centred on the sensor.
export const GUIDING_RIG_GUIDE_FRAME = { x: 320, y: 272, width: 640, height: 480 } as const

// Offsets of the guide stars from the field centre, east and north in arcminutes, with their flux.
const GUIDE_FIELD: readonly (readonly [number, number, number])[] = [
	[0, 0, 3000],
	[1.4, 0.6, 1200],
	[-1.6, -0.9, 900],
	[2.1, -1.3, 700],
	[-2.4, 1.5, 600],
	[0.8, -2, 500],
]

// Device names of the rig.
export const GUIDING_RIG_NAMES = {
	mount: 'Guiding Rig Mount',
	main: 'Guiding Rig Main Camera',
	guide: 'Guiding Rig Guide Camera',
} as const

// Builds the star field of the guide camera: fixed J2000 positions around the first centre the camera queries (the rig
// pointing, converted by the simulator to J2000), whatever centre is queried afterwards.
function guideField(): CatalogSource {
	let field: readonly CatalogSourceStar[] | undefined

	return (rightAscension, declination) => {
		const cosDeclination = Math.cos(declination)
		field ??= GUIDE_FIELD.map(([east, north, flux]) => ({ rightAscension: normalizeAngle(rightAscension + arcmin(east) / cosDeclination), declination: declination + arcmin(north), hfd: 2.5, snr: 80, flux }))
		return field
	}
}

// Decodes a simulator camera BLOB, which is FITS either base64-encoded or as raw bytes.
export async function decodeGuideImage(data: Buffer, encoding: BlobEncoding) {
	return encoding === 'base64' ? await readImageFromSource(base64Source(bufferSource(data))) : await readImageFromBuffer(data)
}

// Detects stars in a guide image and samples their peaks for the StarTracker saturation filter.
export function detectGuideStars(image: Image) {
	return enrichGuideStars(detectStars(image), image)
}

// The rig, created once per test file and disposed after it.
export interface GuidingRig extends AsyncDisposable {
	readonly client: ClientSimulator
	readonly cameraManager: CameraManager
	readonly mountManager: MountManager
	readonly guideOutputManager: GuideOutputManager
	readonly arbiter: ResourceArbiter
	readonly coordinator: OperationCoordinator
	readonly lifecycle: DeviceLifecycle
	readonly mountCommander: MountCommander
	readonly guideOutputCommander: GuideOutputCommander
	readonly capturer: CameraCapturer
	readonly mountSimulator: MountSimulator
	readonly mainSimulator: CameraSimulator
	readonly guideSimulator: CameraSimulator
	readonly guider: GuiderClient
	readonly mount: () => Mount
	readonly main: () => Camera
	readonly guide: () => Camera
	readonly guideOutput: () => GuideOutput
}

// Creates the rig, connects its devices and waits until each is connected, acquirable and publishing what the tests
// read: the frame limits of both cameras and the position and guide port of the mount.
export async function createGuidingRig(capturesDir: string): Promise<GuidingRig> {
	const cameraManager = new CameraManager()
	const mountManager = new MountManager()
	const guideOutputManager = new GuideOutputManager({ get: (client, name) => mountManager.get(client, name) ?? cameraManager.get(client, name) })
	const arbiter = new ResourceArbiter()
	const coordinator = new OperationCoordinator(arbiter)
	const lifecycle = new DeviceLifecycle(arbiter, coordinator)
	lifecycle.observe(cameraManager)
	lifecycle.observe(mountManager)
	lifecycle.observe(guideOutputManager)

	const client = new ClientSimulator('Guiding Rig', new IndiClientHandlerSet([cameraManager, mountManager, guideOutputManager]))
	const mountSimulator = new MountSimulator(GUIDING_RIG_NAMES.mount, client)
	const mainSimulator = new CameraSimulator(GUIDING_RIG_NAMES.main, client, { mountManager, guideOutputManager })
	const guideSimulator = new CameraSimulator(GUIDING_RIG_NAMES.guide, client, { mountManager, guideOutputManager, catalogSources: { GUIDING: guideField() }, catalogSource: 'GUIDING', focalLength: GUIDING_RIG_GUIDE_FOCAL_LENGTH })

	const mountCommander = new MountCommander(mountManager)
	const guideOutputCommander = new GuideOutputCommander(guideOutputManager, arbiter)
	const capturer = new CameraCapturer(cameraManager, arbiter, { capturesDir, frameGraceTime: 10000, quiesceTimeout: 2000, lateBlobDrainTime: 0 })
	const guider = new GuiderClient(cameraManager, guideOutputManager, new StarTracker({ detector: detectGuideStars }), {
		decodeImage: decodeGuideImage,
		calibrator: { clearingMoveEnabled: false, settleFramesAfterMove: 1, raPulse: 400, decPulse: 400, minMovePerStepPx: 0.5, minNetRaTravelPx: 8, minNetDecTravelPx: 8 },
	})

	const require = <D>(device: D | undefined, name: string) => {
		if (device === undefined) throw new Error(`guiding rig device ${name} is not available`)
		return device
	}

	const mount = () => require(mountManager.get(client, GUIDING_RIG_NAMES.mount), GUIDING_RIG_NAMES.mount)
	const main = () => require(cameraManager.get(client, GUIDING_RIG_NAMES.main), GUIDING_RIG_NAMES.main)
	const guide = () => require(cameraManager.get(client, GUIDING_RIG_NAMES.guide), GUIDING_RIG_NAMES.guide)
	const guideOutput = () => require(guideOutputManager.get(client, GUIDING_RIG_NAMES.mount), GUIDING_RIG_NAMES.mount)

	mountSimulator.connect()
	mainSimulator.connect()
	guideSimulator.connect()

	await waitUntil(() => mountManager.get(client, GUIDING_RIG_NAMES.mount)?.connected === true && cameraManager.get(client, GUIDING_RIG_NAMES.main)?.connected === true && cameraManager.get(client, GUIDING_RIG_NAMES.guide)?.connected === true, 5000, 10)
	await waitUntil(() => main().frame.width.max > 0 && guide().frame.width.max > 0 && mount().hasEquatorialCoordinate && mount().canPulseGuide && guideOutputManager.get(client, GUIDING_RIG_NAMES.mount) !== undefined, 5000, 10)
	for (const device of [mount(), main(), guide()]) await waitUntil(() => arbiter.availability(resourceKey(device)) === 'available', 5000, 10)

	cameraManager.snoop(main(), mount())
	cameraManager.snoop(guide(), mount())
	mountSimulator.syncTo(GUIDING_RIG_POINTING.rightAscension, GUIDING_RIG_POINTING.declination)
	mountSimulator.setTrackingEnabled(true)
	client.sendNumber({ device: GUIDING_RIG_NAMES.mount, name: 'GUIDE_RATE', elements: { GUIDE_RATE_WE: 1, GUIDE_RATE_NS: 1 } })
	client.sendSwitch({ device: GUIDING_RIG_NAMES.guide, name: 'SIMULATOR_NOISE_FEATURES', elements: { SKY_ENABLED: false, LIGHT_POLLUTION_ENABLED: false, MOON_ENABLED: false, AMP_GLOW_ENABLED: false } })
	await waitUntil(() => mount().tracking && Math.abs(mount().equatorialCoordinate.declination - GUIDING_RIG_POINTING.declination) < deg(0.01), 5000, 10)

	return {
		client,
		cameraManager,
		mountManager,
		guideOutputManager,
		arbiter,
		coordinator,
		lifecycle,
		mountCommander,
		guideOutputCommander,
		capturer,
		mountSimulator,
		mainSimulator,
		guideSimulator,
		guider,
		mount,
		main,
		guide,
		guideOutput,
		[Symbol.asyncDispose]: async () => {
			await coordinator.cancelAll()
			guider.stopCapture()
			guider.disconnect()
			capturer.dispose()
			mountCommander.dispose()
			guideOutputCommander.dispose()
			lifecycle.dispose()
			for (const simulator of [guideSimulator, mainSimulator, mountSimulator]) simulator[Symbol.dispose]()
		},
	}
}
