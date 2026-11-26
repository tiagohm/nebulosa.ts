import { DEG2RAD } from '../../../core/constants'
import { handleSetBlobVector, type IndiClientHandler } from '../client'
import { DeviceInterfaceType, type GuideDirection } from '../device'
import type { GuideOutputManager } from '../manager/guideoutput'
import type { EnableBlob, NewNumberVector, NewSwitchVector } from '../types'
import { type CameraSimulatorConfig, type CameraSimulatorConfigOverride, cameraSimulatorConfig } from './camera.config'
import { CameraCooler } from './camera.cooler'
import { CameraFlatField } from './camera.flat'
import { CameraGuidePort } from './camera.guideport'
import { type CameraLinkManagers, CameraLinks, type ExposurePointing } from './camera.links'
import { CameraNoise } from './camera.noise'
import { CameraOptics, cameraPixelScale } from './camera.optics'
import { cameraFrameHeader, CameraOutput, encodeCameraFrame } from './camera.output'
import { CameraPsf } from './camera.psf'
import { CameraReadout } from './camera.readout'
import { type CameraFrameInput, renderCameraFrame } from './camera.renderer'
import { CameraSensor } from './camera.sensor'
import { CameraShutter } from './camera.shutter'
import { CameraSky } from './camera.sky'
import { exposureTrail } from './camera.trail'
import type { ClientSimulator } from './client'
import { assignComponentDevice, type ComponentBus, componentProperties, routeNumber, routeSwitch, type SimulatorComponent, transientComponentProperties } from './component'
import { TICK_INTERVAL_MS } from './constants'
import { DeviceSimulator } from './device'
import type { CatalogSource, CatalogSourceType, DeviceSimulatorOptions, SimulatorProperty } from './types'

// Simulated astronomical camera, built as a board of independent circuits: sensor, readout, cooler,
// shutter, guide port, optics, point spread function, sky, noise, flat field and output, with the
// links to the snooped mount, focuser, rotator and filter wheel. The camera routes commands to its
// circuits, ticks them, and turns each closed exposure into a frame: it takes everything the frame is
// drawn from as the shutter closes, reads the trail the mount recorded, fetches the stars and draws,
// encodes and delivers the frame.

// Camera simulator options: persistence, the managers of the snooped devices, the catalog sources and
// the configuration.
export interface CameraSimulatorOptions extends DeviceSimulatorOptions, CameraLinkManagers {
	// Catalog sources by name; those present become selectable besides 'RANDOM'.
	readonly catalogSources?: Record<string, CatalogSource | undefined | null>
	// Relays the pulses of the guide port to the snooped mount.
	readonly guideOutputManager?: GuideOutputManager
	// Override of DEFAULT_CAMERA_SIMULATOR_CONFIG.
	readonly config?: CameraSimulatorConfigOverride
	// Clock of the camera, milliseconds since the Unix epoch. Defaults to Date.now.
	readonly now?: () => number
}

// Simulated camera with a CCD and a guide port.
export class CameraSimulator extends DeviceSimulator {
	readonly type = 'camera'

	// Configuration the camera was built with.
	readonly configuration: CameraSimulatorConfig

	readonly #sensor: CameraSensor
	readonly #readout: CameraReadout
	readonly #cooler: CameraCooler
	readonly #shutter: CameraShutter
	readonly #guidePort: CameraGuidePort
	readonly #output: CameraOutput
	readonly #optics: CameraOptics
	readonly #psf: CameraPsf
	readonly #sky: CameraSky
	readonly #noise: CameraNoise
	readonly #flat: CameraFlatField
	readonly #components: readonly SimulatorComponent[]
	readonly #links: CameraLinks
	// Clock of the camera, milliseconds.
	readonly #now: () => number

	protected readonly properties: readonly SimulatorProperty[]
	protected readonly propertiesToNotSave: readonly SimulatorProperty[]

	#timer?: NodeJS.Timeout
	// Where the open exposure looked, taken as its shutter opened.
	#pointing?: ExposurePointing
	// Boresight samples of the trail, reused across frames.
	readonly #trailBuffer: Float64Array

	constructor(
		name: string,
		client: ClientSimulator,
		readonly options?: CameraSimulatorOptions,
		handler: IndiClientHandler = client.handler,
	) {
		super(name, client, handler, DeviceInterfaceType.CCD | DeviceInterfaceType.GUIDER, 'camera.simulator')

		const config = cameraSimulatorConfig(options?.config)
		const now = options?.now ?? Date.now
		const bus: ComponentBus = { notify: (property) => this.notify(property), now }
		const snoop = this.snoopDevices.elements

		this.configuration = config
		this.#now = now
		this.#links = new CameraLinks(client, () => ({ telescope: snoop.ACTIVE_TELESCOPE.value, focuser: snoop.ACTIVE_FOCUSER.value, wheel: snoop.ACTIVE_FILTER.value, rotator: snoop.ACTIVE_ROTATOR.value }), options ?? {}, now)
		this.#sensor = new CameraSensor(bus, config.sensor)
		this.#readout = new CameraReadout(bus, this.#sensor, config.readout)
		this.#cooler = new CameraCooler(bus, config.cooler)
		this.#shutter = new CameraShutter(bus, config.shutter, { canOpen: () => this.isConnected, opened: () => this.#opened(), closed: (duration) => void this.#closed(duration) })
		this.#guidePort = new CameraGuidePort(bus, { enabled: () => this.isConnected, pulse: (direction, duration) => this.#relayPulse(direction, duration) })
		this.#output = new CameraOutput(bus, (property) => handleSetBlobVector(this.client, this.handler, property))
		this.#optics = new CameraOptics(bus, config.optics)
		this.#psf = new CameraPsf(bus, config.psf)
		this.#sky = new CameraSky(bus, config.scene, options?.catalogSources ?? {})
		this.#noise = new CameraNoise(bus, config.noise, config.shutter.minExposure, config.shutter.maxExposure)
		this.#flat = new CameraFlatField(bus, config.flat)
		this.#components = [this.#sensor, this.#cooler, this.#readout, this.#shutter, this.#guidePort, this.#output, this.#optics, this.#psf, this.#sky, this.#noise, this.#flat]
		this.#trailBuffer = new Float64Array(Math.max(2, config.trail.vertices) * 2)

		assignComponentDevice(this.#components, name)
		this.properties = componentProperties(this.#components)
		this.propertiesToNotSave = transientComponentProperties(this.#components)
	}

	// Snooped mount, when connected.
	get activeMount() {
		return this.#links.mount
	}

	// Simulator behind the snooped mount, when it is one.
	get activeMountSimulator() {
		return this.#links.mountSimulator
	}

	// Snooped focuser, when connected.
	get activeFocuser() {
		return this.#links.focuser
	}

	// Snooped rotator, when connected.
	get activeRotator() {
		return this.#links.rotator
	}

	// Snooped filter wheel, when connected.
	get activeFilter() {
		return this.#links.wheel
	}

	// Selected star source.
	get catalogSourceType(): CatalogSourceType {
		return this.#sky.catalogSourceType
	}

	// Kind of frame the next exposure produces.
	get frameType() {
		return this.#readout.frameType
	}

	// Whether an exposure is open.
	get isExposuring() {
		return this.#shutter.isExposing
	}

	// Whether the guide port is pulsing.
	get isPulsing() {
		return this.#guidePort.isPulsing
	}

	// Focal length of the telescope, millimetres.
	get telescopeFocalLength() {
		return this.#optics.focalLength
	}

	// Aperture of the telescope, millimetres.
	get telescopeAperture() {
		return this.#optics.aperture
	}

	// Sensor width and height, unbinned pixels.
	get sensorWidth() {
		return this.#sensor.width
	}

	get sensorHeight() {
		return this.#sensor.height
	}

	// Colour filter array of a monochrome readout.
	get cfaPattern() {
		return this.#sensor.cfa
	}

	// Selected transfer format.
	get transferFormat() {
		return this.#readout.transferFormat
	}

	// Colour channels of the delivered image.
	get channels() {
		return this.#readout.channels
	}

	// Size of the delivered image, binned pixels.
	get imageWidth() {
		return this.#readout.imageWidth
	}

	get imageHeight() {
		return this.#readout.imageHeight
	}

	// Applies the client's BLOB policy.
	enableBlob(command: EnableBlob) {
		this.#output.enableBlob(command)
	}

	// Publishes a property unless the client asked for BLOBs only.
	protected notify(message: SimulatorProperty) {
		if (this.#output.onlyBlob) return
		super.notify(message)
	}

	// Routes a number command to the circuit that owns it.
	sendNumber(vector: NewNumberVector) {
		routeNumber(this.#components, vector)
	}

	// Handles connection and configuration, then routes the command to the circuit that owns it.
	sendSwitch(vector: NewSwitchVector) {
		super.sendSwitch(vector)

		if (vector.name === 'CONNECTION') {
			if (vector.elements.CONNECT === true) this.connect()
			else if (vector.elements.DISCONNECT === true) this.disconnect()
			return
		}

		routeSwitch(this.#components, vector)
	}

	// Connects the camera and starts ticking its circuits.
	connect() {
		if (this.#timer) return
		super.connect()
		if (!this.isConnected) return
		this.#timer = setInterval(this.#tick.bind(this), TICK_INTERVAL_MS)
	}

	// Stops ticking, returns every circuit to rest and disconnects the camera.
	disconnect() {
		if (!this.#timer) return
		clearInterval(this.#timer)
		this.#timer = undefined
		for (const component of this.#components) component.reset()
		super.disconnect()
	}

	// Disconnects and unregisters the camera.
	dispose() {
		this.disconnect()
		super.dispose()
	}

	// Opens the shutter for `duration` seconds.
	startExposure(duration: number) {
		this.#shutter.open(duration)
	}

	// Aborts the open exposure, ending it Alert when `alert`.
	abortExposure(alert: boolean = false) {
		this.#shutter.abort(alert)
	}

	// Sets the cooling target, °C.
	setTargetTemperature(value: number) {
		this.#cooler.setTargetTemperature(value)
	}

	// Moves the subframe, unbinned pixels.
	setFrame(x?: number, y?: number, width?: number, height?: number) {
		this.#readout.setFrame(x, y, width, height)
	}

	// Sets the binning.
	setBin(horizontal?: number, vertical?: number) {
		this.#readout.setBin(horizontal, vertical)
	}

	// Issues a guide pulse of `duration` milliseconds towards `direction`.
	pulse(direction: GuideDirection, duration: number) {
		this.#guidePort.pulse(direction, duration)
	}

	// Lets every circuit rebuild what it derived from the persisted values.
	protected onPropertiesLoaded() {
		for (const component of this.#components) component.loaded()
	}

	// Advances every circuit to the present.
	#tick() {
		const now = this.#now()
		for (const component of this.#components) component.tick(now)
	}

	// Relays a guide pulse to the snooped mount.
	#relayPulse(direction: GuideDirection, duration: number) {
		const mount = this.#links.mount
		if (mount !== undefined) this.options?.guideOutputManager?.pulse(mount, direction, duration)
	}

	// Takes where the mount points as the shutter opens and clears the previous frame.
	#opened() {
		this.#pointing = this.#links.pointing()
		this.#output.begin()
	}

	// Produces and delivers the frame of an exposure of `duration` seconds whose shutter just closed.
	//
	// Everything the frame is drawn from is taken before the first await: the shutter is already free
	// and a new exposure, or a new setting, may arrive while the stars are being fetched, and the frame
	// must describe the exposure that was taken. The trail is read here too, from what the mount
	// recorded while the shutter was open.
	async #closed(duration: number) {
		const pointing = this.#pointing
		this.#pointing = undefined
		this.#output.close()

		if (pointing === undefined || this.#output.ignoresBlob) {
			this.#shutter.complete(pointing !== undefined)
			return
		}

		const config = this.configuration
		const sensor = this.#sensor
		const readout = this.#readout.snapshot()
		const optics = this.#optics.snapshot()
		const scene = this.#sky.snapshot()
		const accessories = this.#links.accessories()
		const temperature = this.#cooler.temperature
		const reference = this.#noise.referenceExposure
		const exposureScale = duration / reference
		const pixelScale = cameraPixelScale(sensor.pixelSize, optics.focalLength)
		const trail = exposureTrail(pointing, duration, pixelScale, config.trail, this.#trailBuffer)
		const radius = (Math.hypot(sensor.width, sensor.height) / 2) * pixelScale + trail.extent
		const input: CameraFrameInput = {
			sensorWidth: sensor.width,
			sensorHeight: sensor.height,
			readout,
			optics,
			psf: this.#psf.snapshot(),
			seeing: scene.seeing,
			pixelScale,
			rotation: optics.cameraAngle + (accessories.rotatorAngle ?? 0) * DEG2RAD,
			focusPosition: accessories.focusPosition ?? optics.bestFocus,
			maxFocusPosition: accessories.maxFocuserPosition,
			fluxScale: (1 + readout.gain / 100) * exposureScale,
			snrScale: Math.sqrt(Math.max(exposureScale, 0.01)),
			noise: this.#noise.configFor({ frameType: readout.frameType, exposureTime: duration, temperature, gain: readout.gain, offset: readout.offset, seed: scene.seed }),
			flat: readout.frameType === 'FLAT' ? { config: this.#flat.snapshot(), seed: scene.seed, signalScale: duration / Math.max(reference, config.shutter.minExposure) } : undefined,
		}
		const header = cameraFrameHeader({ instrument: this.name, pointing, exposureTime: duration, readout, pixelSize: sensor.pixelSize, temperature, accessories })

		try {
			const stars = readout.frameType === 'LIGHT' ? await this.#sky.stars([trail.reference.rightAscension, trail.reference.declination], radius, pixelScale, pointing.center !== undefined) : []
			const raw = renderCameraFrame(input, stars, trail, config.trail.spacing, config.trail.maxPoints)
			const blob = await encodeCameraFrame(raw, header, readout, sensor.cfa, readout.transferFormat)
			this.#output.deliver(blob, readout.transferFormat)
			this.#shutter.complete(true)
		} catch (e) {
			this.#output.fail()
			this.#shutter.complete(false)
			console.error('failed to render image', e)
		}
	}
}
