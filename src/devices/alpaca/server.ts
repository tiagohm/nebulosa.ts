// oxfmt-ignore
import { type AlpacaAxisRate, AlpacaCameraState, type AlpacaConfiguredDevice, type AlpacaDeviceNumberProvider, type AlpacaDeviceType, AlpacaError, AlpacaException, type AlpacaFocuserAction, AlpacaImageElementType, type AlpacaServerStartOptions, type AlpacaStateItem, type AlpacaWheelAction, defaultDeviceNumberProvider, SUPPORTED_FOCUSER_ACTIONS, SUPPORTED_WHEEL_ACTIONS } from './types'
import { observedToCirs } from '../../astronomy/coordinates/astrometry'
import { type EquatorialCoordinate, equatorialToHorizontal } from '../../astronomy/coordinates/coordinate'
import { Bitpix, computeRemainingBytes, FitsKeywordReader } from '../../io/formats/fits/fits'
import { bitpixInBytes } from '../../io/formats/fits/util'
import { type Angle, deg, hour, toDeg, toHour } from '../../math/units/angle'
import { meter, toMeter } from '../../math/units/distance'
// oxfmt-ignore
import { type Camera, type Cover, type Device, type DeviceType, expectedPierSide, type FlatPanel, type Focuser, type GuideDirection, type GuideOutput, isCamera, isFocuser, isMount, isWheel, type Mount, type NameAndLabel, type PierSide, type Rotator, type TrackMode, type Wheel } from '../indi/device'
import { type GeographicCoordinate, localSiderealTime } from '../../astronomy/observer/location'
import { type Time, timeNow } from '../../astronomy/time/time'
import type { CameraManager, CoverManager, DeviceHandler, DeviceManager, FlatPanelManager, FocuserManager, GuideOutputManager, MountManager, RotatorManager, WheelManager } from '../indi/manager'

// Embedded ASCOM Alpaca server: exposes the app's INDI devices (camera, mount, focuser, wheel, rotator,
// cover/calibrator) over the Alpaca REST API so external Alpaca clients can control them. Subscribes to
// the device managers to track devices, maintains per-device Alpaca state, and serves the management and
// per-device endpoints via Bun.serve. Internal radians/AU/etc. are converted to the Alpaca spec units.

// Notification hooks fired when a device is registered with or removed from the server.
export interface AlpacaServerHandler {
	readonly deviceAdded?: (server: AlpacaServer, device: Device, configuredDevice: AlpacaConfiguredDevice) => void
	readonly deviceRemoved?: (server: AlpacaServer, device: Device, configuredDevice: AlpacaConfiguredDevice) => void
}

// Server configuration: identity strings plus the device managers to expose (at least one required).
export interface AlpacaServerOptions {
	name?: string
	version?: string
	manufacturer?: string
	camera?: CameraManager
	mount?: MountManager
	focuser?: FocuserManager
	wheel?: WheelManager
	rotator?: RotatorManager
	flatPanel?: FlatPanelManager
	cover?: CoverManager
	guideOutput?: GuideOutputManager
	// Strategy for assigning Alpaca device numbers; defaults to a stable hash of type+name.
	deviceNumberProvider?: AlpacaDeviceNumberProvider
	handler?: AlpacaServerHandler
}

// Per-device server-side state cache holding pending async tasks and the latest Alpaca-facing values.
// Extends geographic + equatorial coordinates; comments group the fields by device type.
interface AlpacaDeviceState extends GeographicCoordinate, EquatorialCoordinate {
	// Device
	tasks: Partial<Record<'connect' | 'position', ReturnType<typeof promiseWithTimeout>>>
	// Camera
	data?: string | Buffer<ArrayBuffer>
	lastExposureDuration: number
	ccdTemperature: number
	frame: [number, number, number, number]
	// Wheel
	position: number // target position
	// Mount
	doesRefraction: boolean
	slewSettleTime: number
	readonly ellipsoid: 3 // IERS2010
	time?: Time
	lst: Angle
}

// One device registered with the server: the underlying INDI device, its Alpaca descriptor, and state.
interface AlpacaRegisteredDevice<D extends Device = Device> {
	readonly device: D
	readonly configuredDevice: AlpacaConfiguredDevice
	readonly state: AlpacaDeviceState
}

// Initial values copied into each device's state on registration.
const DEFAULT_ALPACA_DEVICE_STATE: AlpacaDeviceState = {
	tasks: {},
	lastExposureDuration: 0,
	ccdTemperature: 0,
	frame: [0, 0, 0, 0],
	position: 0,
	doesRefraction: false,
	slewSettleTime: 0,
	latitude: 0,
	longitude: 0,
	elevation: 0,
	ellipsoid: 3,
	rightAscension: 0,
	declination: 0,
	lst: 0,
}

// Alpaca REST server over the app's INDI device managers. Subscribes to device add/update/remove events
// per device type, maps each device to an Alpaca registration, and serves the management and per-device
// endpoints. The many per-property #<type>GetX/#<type>SetX route handlers are self-describing thin
// adapters between INDI device properties and AlpacaResponse envelopes, so they are not commented
// individually; the non-trivial lifecycle, lookup, and conversion helpers are.
export class AlpacaServer {
	#server?: Bun.Server<undefined>

	// Registered devices grouped by Alpaca device type.
	readonly #equipment = {
		camera: new Map<Device, AlpacaRegisteredDevice<Camera>>(),
		telescope: new Map<Device, AlpacaRegisteredDevice<Mount>>(),
		focuser: new Map<Device, AlpacaRegisteredDevice<Focuser>>(),
		filterwheel: new Map<Device, AlpacaRegisteredDevice<Wheel>>(),
		rotator: new Map<Device, AlpacaRegisteredDevice<Rotator>>(),
		dome: new Map<Device, AlpacaRegisteredDevice>(),
		switch: new Map<Device, AlpacaRegisteredDevice>(),
		covercalibrator: new Map<Device, AlpacaRegisteredDevice<Cover | FlatPanel>>(),
		observingconditions: new Map<Device, AlpacaRegisteredDevice>(),
		safetymonitor: new Map<Device, AlpacaRegisteredDevice>(),
		video: new Map<Device, AlpacaRegisteredDevice>(),
	} as const

	readonly #deviceManager: DeviceManager<Device>
	readonly #deviceNumberProvider: AlpacaDeviceNumberProvider
	#timer?: NodeJS.Timeout

	// Subscriptions to each device manager that register/unregister devices and mirror property changes
	// (connection, frame, position, geographic coordinate, BLOB) into the per-device state.
	readonly #cameraHandler: DeviceHandler<Camera> = {
		added: (device: Camera) => {
			this.#makeConfiguredDeviceFromDevice(device, 'camera')
		},
		updated: (device, property) => {
			if (property === 'connected') {
				this.#handleConnectedEvent(device, 'camera')
			} else if (property === 'frame') {
				const { frame } = this.#camera(device).state
				frame[0] = device.frame.x.value
				frame[1] = device.frame.y.value
				frame[2] = device.frame.width.value
				frame[3] = device.frame.height.value
			}
		},
		removed: (device: Camera) => {
			this.#removeConfiguredDevice(device, 'camera')
		},
		blobReceived: (device, data) => {
			const { state } = this.#camera(device)

			// Has the capture started?
			if (state.lastExposureDuration) {
				// console.info('camera image received', device.name, data.length)
				state.data = data
			}
		},
	}

	readonly #wheelHandler: DeviceHandler<Wheel> = {
		added: (device: Wheel) => {
			this.#makeConfiguredDeviceFromDevice(device, 'filterwheel')
		},
		updated: (device, property) => {
			if (property === 'connected') {
				this.#handleConnectedEvent(device, 'filterwheel')
			} else if (property === 'position') {
				const { state } = this.#equipment.filterwheel.get(device)!
				const task = state.tasks.position

				task?.clear()
				task?.resolve(true)
			}
		},
		removed: (device: Wheel) => {
			this.#removeConfiguredDevice(device, 'filterwheel')
		},
	}

	readonly #mountHandler: DeviceHandler<Mount> = {
		added: (device: Mount) => {
			this.#makeConfiguredDeviceFromDevice(device, 'telescope')
		},
		updated: (device, property) => {
			if (property === 'connected') {
				this.#handleConnectedEvent(device, 'telescope')
			} else if (property === 'geographicCoordinate') {
				Object.assign(this.#equipment.telescope.get(device)!.state, device.geographicCoordinate)
			}
		},
		removed: (device: Mount) => {
			this.#removeConfiguredDevice(device, 'telescope')
		},
	}

	readonly #focuserHandler: DeviceHandler<Focuser> = {
		added: (device: Focuser) => {
			this.#makeConfiguredDeviceFromDevice(device, 'focuser')
		},
		updated: (device, property) => {
			if (property === 'connected') {
				this.#handleConnectedEvent(device, 'focuser')
			}
		},
		removed: (device: Focuser) => {
			this.#removeConfiguredDevice(device, 'focuser')
		},
	}

	readonly #coverHandler: DeviceHandler<Cover> = {
		added: (device: Cover) => {
			this.#makeConfiguredDeviceFromDevice(device, 'covercalibrator')
		},
		updated: (device, property) => {
			if (property === 'connected') {
				this.#handleConnectedEvent(device, 'covercalibrator')
			}
		},
		removed: (device: Cover) => {
			this.#removeConfiguredDevice(device, 'covercalibrator')
		},
	}

	readonly #flatPanelHandler: DeviceHandler<FlatPanel> = {
		added: (device: FlatPanel) => {
			this.#makeConfiguredDeviceFromDevice(device, 'covercalibrator')
		},
		updated: (device, property) => {
			if (property === 'connected') {
				this.#handleConnectedEvent(device, 'covercalibrator')
			}
		},
		removed: (device: FlatPanel) => {
			this.#removeConfiguredDevice(device, 'covercalibrator')
		},
	}

	constructor(readonly options: AlpacaServerOptions) {
		this.#deviceManager = (options.camera ?? options.mount ?? options.focuser ?? options.wheel ?? options.flatPanel ?? options.cover ?? options.rotator) as unknown as DeviceManager<Device>

		if (!this.#deviceManager) throw new Error('at least one device manager must be provided.')

		this.#deviceNumberProvider = options.deviceNumberProvider ?? defaultDeviceNumberProvider
	}

	// Bound HTTP port, or -1 when stopped.
	get port() {
		return this.#server?.port ?? -1
	}

	// Bound hostname, or undefined when stopped.
	get host() {
		return this.#server?.hostname
	}

	// Whether the HTTP server is currently listening.
	get running() {
		return !!this.#server
	}

	// Bun route table mapping Alpaca management and per-device REST paths to the corresponding handlers.
	readonly routes: Readonly<Bun.Serve.Routes<undefined, string>> = {
		// https://ascom-standards.org/api/?urls.primaryName=ASCOM+Alpaca+Management+API
		'/management/apiversions': { GET: () => this.#apiVersions() },
		'/management/v1/description': { GET: () => this.#apiDescription() },
		'/management/v1/configureddevices': { GET: () => makeAlpacaResponse(Array.from(this.configuredDevices())) },
		// https://ascom-standards.org/api/?urls.primaryName=ASCOM+Alpaca+Device+API
		// Device
		'/api/v1/:type/:id/interfaceversion': { GET: (req) => this.#deviceGetInterfaceVersion(req.params.type.toLowerCase() as never) },
		'/api/v1/:type/:id/description': { GET: (req) => this.#deviceGetDescription(+req.params.id, req.params.type.toLowerCase() as never) },
		'/api/v1/:type/:id/name': { GET: (req) => this.#deviceGetName(+req.params.id, req.params.type.toLowerCase() as never) },
		'/api/v1/:type/:id/driverinfo': { GET: (req) => this.#deviceGetDriverInfo(+req.params.id, req.params.type.toLowerCase() as never) },
		'/api/v1/:type/:id/driverversion': { GET: (req) => this.#deviceGetDriverVersion(+req.params.id, req.params.type.toLowerCase() as never) },
		'/api/v1/:type/:id/connect': { PUT: (req) => this.#deviceConnect(+req.params.id, req.params.type.toLowerCase() as never, { Connected: 'True' }) },
		'/api/v1/:type/:id/connected': { GET: (req) => this.#deviceIsConnected(+req.params.id, req.params.type.toLowerCase() as never), PUT: async (req) => this.#deviceConnect(+req.params.id, req.params.type.toLowerCase() as never, await params(req)) },
		'/api/v1/:type/:id/connecting': { GET: (req) => this.#deviceIsConnecting(+req.params.id, req.params.type.toLowerCase() as never) },
		'/api/v1/:type/:id/disconnect': { PUT: (req) => this.#deviceConnect(+req.params.id, req.params.type.toLowerCase() as never, { Connected: 'False' }) },
		'/api/v1/:type/:id/supportedactions': { GET: (req) => this.#deviceGetSupportedActions(+req.params.id, req.params.type.toLowerCase() as never) },
		'/api/v1/:type/:id/action': { PUT: async (req) => this.#deviceAction(+req.params.id, req.params.type.toLowerCase() as never, await params(req)) },
		// Camera
		'/api/v1/camera/:id/bayeroffsetx': { GET: (req) => this.#cameraGetBayerOffsetX(+req.params.id) },
		'/api/v1/camera/:id/bayeroffsety': { GET: (req) => this.#cameraGetBayerOffsetY(+req.params.id) },
		'/api/v1/camera/:id/binx': { GET: (req) => this.#cameraGetBinX(+req.params.id), PUT: async (req) => this.#cameraSetBinX(+req.params.id, await params(req)) },
		'/api/v1/camera/:id/biny': { GET: (req) => this.#cameraGetBinY(+req.params.id), PUT: async (req) => this.#cameraSetBinY(+req.params.id, await params(req)) },
		'/api/v1/camera/:id/camerastate': { GET: (req) => this.#cameraGetState(+req.params.id) },
		'/api/v1/camera/:id/cameraxsize': { GET: (req) => this.#cameraGetXSize(+req.params.id) },
		'/api/v1/camera/:id/cameraysize': { GET: (req) => this.#cameraGetYSize(+req.params.id) },
		'/api/v1/camera/:id/canabortexposure': { GET: (req) => this.#cameraCanStopExposure(+req.params.id) },
		'/api/v1/camera/:id/canasymmetricbin': { GET: () => this.#cameraCanAsymmetricBin() },
		'/api/v1/camera/:id/canfastreadout': { GET: () => this.#cameraCanFastReadout() },
		'/api/v1/camera/:id/cangetcoolerpower': { GET: (req) => this.#cameraCanGetCoolerPower(+req.params.id) },
		'/api/v1/camera/:id/canpulseguide': { GET: (req) => this.#cameraCanPulseGuide(+req.params.id) },
		'/api/v1/camera/:id/cansetccdtemperature': { GET: (req) => this.#cameraCanSetCCDTemperature(+req.params.id) },
		'/api/v1/camera/:id/canstopexposure': { GET: (req) => this.#cameraCanStopExposure(+req.params.id) },
		'/api/v1/camera/:id/ccdtemperature': { GET: (req) => this.#cameraGetCcdTemperature(+req.params.id) },
		'/api/v1/camera/:id/cooleron': { GET: (req) => this.#cameraIsCoolerOn(+req.params.id), PUT: async (req) => this.#cameraSetCoolerOn(+req.params.id, await params(req)) },
		'/api/v1/camera/:id/coolerpower': { GET: (req) => this.#cameraGetCoolerPower(+req.params.id) },
		'/api/v1/camera/:id/devicestate': { GET: (req) => this.#cameraGetDeviceState(+req.params.id) },
		'/api/v1/camera/:id/electronsperadu': { GET: () => this.#cameraGetEletronsPerADU() },
		'/api/v1/camera/:id/exposuremax': { GET: (req) => this.#cameraGetExposureMax(+req.params.id) },
		'/api/v1/camera/:id/exposuremin': { GET: (req) => this.#cameraGetExposureMin(+req.params.id) },
		'/api/v1/camera/:id/exposureresolution': { GET: (req) => this.#cameraGetExposureResolution() },
		'/api/v1/camera/:id/fastreadout': { GET: () => this.#cameraIsFastReadout(), PUT: () => this.#cameraSetFastReadout() },
		'/api/v1/camera/:id/fullwellcapacity': { GET: () => this.#cameraGetFullwellCapacity() },
		'/api/v1/camera/:id/gain': { GET: (req) => this.#cameraGetGain(+req.params.id), PUT: async (req) => this.#cameraSetGain(+req.params.id, await params(req)) },
		'/api/v1/camera/:id/gainmax': { GET: (req) => this.#cameraGetGainMax(+req.params.id) },
		'/api/v1/camera/:id/gainmin': { GET: (req) => this.#cameraGetGainMin(+req.params.id) },
		'/api/v1/camera/:id/gains': { GET: () => this.#cameraGetGains() },
		'/api/v1/camera/:id/hasshutter': { GET: () => this.#cameraHasShutter() },
		'/api/v1/camera/:id/heatsinktemperature': { GET: (req) => this.#cameraGetCcdTemperature(+req.params.id) },
		'/api/v1/camera/:id/imageready': { GET: (req) => this.#cameraIsImageReady(+req.params.id) },
		'/api/v1/camera/:id/ispulseguiding': { GET: (req) => this.#guideOutputIsPulseGuiding(+req.params.id, 'camera') },
		'/api/v1/camera/:id/lastexposureduration': { GET: (req) => this.#cameraGetLastExposureDuration(+req.params.id) },
		'/api/v1/camera/:id/maxadu': { GET: () => this.#cameraGetMaxADU() },
		'/api/v1/camera/:id/maxbinx': { GET: (req) => this.#cameraGetMaxBinX(+req.params.id) },
		'/api/v1/camera/:id/maxbiny': { GET: (req) => this.#cameraGetMaxBinY(+req.params.id) },
		'/api/v1/camera/:id/numx': { GET: (req) => this.#cameraGetNumX(+req.params.id), PUT: async (req) => this.#cameraSetNumX(+req.params.id, await params(req)) },
		'/api/v1/camera/:id/numy': { GET: (req) => this.#cameraGetNumY(+req.params.id), PUT: async (req) => this.#cameraSetNumY(+req.params.id, await params(req)) },
		'/api/v1/camera/:id/offset': { GET: (req) => this.#cameraGetOffset(+req.params.id), PUT: async (req) => this.#cameraSetOffset(+req.params.id, await params(req)) },
		'/api/v1/camera/:id/offsetmax': { GET: (req) => this.#cameraGetOffsetMax(+req.params.id) },
		'/api/v1/camera/:id/offsetmin': { GET: (req) => this.#cameraGetOffsetMin(+req.params.id) },
		'/api/v1/camera/:id/offsets': { GET: () => this.#cameraGetOffsets() },
		'/api/v1/camera/:id/percentcompleted': { GET: (req) => this.#cameraGetPercentCompleted(+req.params.id) },
		'/api/v1/camera/:id/pixelsizex': { GET: (req) => this.#cameraGetPixelSizeX(+req.params.id) },
		'/api/v1/camera/:id/pixelsizey': { GET: (req) => this.#cameraGetPixelSizeY(+req.params.id) },
		'/api/v1/camera/:id/readoutmode': { GET: (req) => this.#cameraGetReadoutMode(+req.params.id), PUT: async (req) => this.#cameraSetReadoutMode(+req.params.id, await params(req)) },
		'/api/v1/camera/:id/readoutmodes': { GET: (req) => this.#cameraGetReadoutModes(+req.params.id) },
		'/api/v1/camera/:id/sensorname': { GET: () => this.#cameraGetSensorName() },
		'/api/v1/camera/:id/sensortype': { GET: (req) => this.#cameraGetSensorType(+req.params.id) },
		'/api/v1/camera/:id/setccdtemperature': { GET: (req) => this.#cameraGetSetCcdTemperature(+req.params.id), PUT: async (req) => this.#cameraSetCcdTemperature(+req.params.id, await params(req)) },
		'/api/v1/camera/:id/startx': { GET: (req) => this.#cameraGetStartX(+req.params.id), PUT: async (req) => this.#cameraSetStartX(+req.params.id, await params(req)) },
		'/api/v1/camera/:id/starty': { GET: (req) => this.#cameraGetStartY(+req.params.id), PUT: async (req) => this.#cameraSetStartY(+req.params.id, await params(req)) },
		'/api/v1/camera/:id/abortexposure': { PUT: (req) => this.#cameraStop(+req.params.id) },
		'/api/v1/camera/:id/pulseguide': { PUT: async (req) => this.#guideOutputPulseGuide(+req.params.id, 'camera', await params(req)) },
		'/api/v1/camera/:id/startexposure': { PUT: async (req) => this.#cameraStart(+req.params.id, await params(req)) },
		'/api/v1/camera/:id/stopexposure': { PUT: (req) => this.#cameraStop(+req.params.id) },
		'/api/v1/camera/:id/imagearray': { GET: (req) => this.#cameraGetImageArray(+req.params.id, req.headers.get('accept')) },
		// Filter Wheel
		'/api/v1/filterwheel/:id/devicestate': { GET: (req) => this.#wheelGetDeviceState(+req.params.id) },
		'/api/v1/filterwheel/:id/focusoffsets': { GET: (req) => this.#wheelGetFocusOffsets(+req.params.id) },
		'/api/v1/filterwheel/:id/names': { GET: (req) => this.#wheelGetNames(+req.params.id) },
		'/api/v1/filterwheel/:id/position': { GET: (req) => this.#wheelGetPosition(+req.params.id), PUT: async (req) => this.#wheelSetPosition(+req.params.id, await params(req)) },
		// Mount
		'/api/v1/telescope/:id/alignmentmode': { GET: () => this.#mountGetAlignmentMode() },
		'/api/v1/telescope/:id/altitude': { GET: (req) => this.#mountGetAltitude(+req.params.id) },
		'/api/v1/telescope/:id/aperturearea': { GET: () => this.#mountGetApertureArea() },
		'/api/v1/telescope/:id/aperturediameter': { GET: () => this.#mountGetApertureDiameter() },
		'/api/v1/telescope/:id/athome': { GET: (req) => this.#mountIsAtHome(+req.params.id) },
		'/api/v1/telescope/:id/atpark': { GET: (req) => this.#mountIsAtPark(+req.params.id) },
		'/api/v1/telescope/:id/azimuth': { GET: (req) => this.#mountGetAzimuth(+req.params.id) },
		'/api/v1/telescope/:id/canfindhome': { GET: (req) => this.#mountCanFindHome(+req.params.id) },
		'/api/v1/telescope/:id/canpark': { GET: (req) => this.#mountCanPark(+req.params.id) },
		'/api/v1/telescope/:id/canpulseguide': { GET: (req) => this.#mountCanPulseGuide(+req.params.id) },
		'/api/v1/telescope/:id/cansetdeclinationrate': { GET: (req) => this.#mountCanSetDeclinationRate(+req.params.id) },
		'/api/v1/telescope/:id/cansetguiderates': { GET: (req) => this.#mountCanSetGuideRates(+req.params.id) },
		'/api/v1/telescope/:id/cansetpark': { GET: (req) => this.#mountCanSetPark(+req.params.id) },
		'/api/v1/telescope/:id/cansetpierside': { GET: (req) => this.#mountCanSetPierSide(+req.params.id) },
		'/api/v1/telescope/:id/cansetrightascensionrate': { GET: (req) => this.#mountCanSetRightAscensionRate(+req.params.id) },
		'/api/v1/telescope/:id/cansettracking': { GET: (req) => this.#mountCanSetTracking(+req.params.id) },
		'/api/v1/telescope/:id/canslew': { GET: (req) => this.#mountCanSlew(+req.params.id) },
		'/api/v1/telescope/:id/canslewaltaz': { GET: (req) => this.#mountCanSlewAltAz(+req.params.id) },
		'/api/v1/telescope/:id/canslewaltazasync': { GET: (req) => this.#mountCanSlewAltAzAsync(+req.params.id) },
		'/api/v1/telescope/:id/canslewasync': { GET: (req) => this.#mountCanSlewAsync(+req.params.id) },
		'/api/v1/telescope/:id/cansync': { GET: (req) => this.#mountCanSync(+req.params.id) },
		'/api/v1/telescope/:id/cansyncaltaz': { GET: (req) => this.#mountCanSyncAltAz(+req.params.id) },
		'/api/v1/telescope/:id/canunpark': { GET: (req) => this.#mountCanUnpark(+req.params.id) },
		'/api/v1/telescope/:id/declination': { GET: (req) => this.#mountGetDeclination(+req.params.id) },
		'/api/v1/telescope/:id/declinationrate': { GET: (req) => this.#mountGetDeclinationRate(+req.params.id), PUT: async (req) => this.#mountSetDeclinationRate(+req.params.id, await params(req)) },
		'/api/v1/telescope/:id/devicestate': { GET: (req) => this.#mountGetDeviceState(+req.params.id) },
		'/api/v1/telescope/:id/doesrefraction': { GET: (req) => this.#mountGetDoesRefraction(+req.params.id), PUT: async (req) => this.#mountSetDoesRefraction(+req.params.id, await params(req)) },
		'/api/v1/telescope/:id/equatorialsystem': { GET: (req) => this.#mountGetEquatorialSystem() },
		'/api/v1/telescope/:id/focallength': { GET: () => this.#mountGetFocalLength() },
		'/api/v1/telescope/:id/guideratedeclination': { GET: () => this.#mountGetGuideRateDeclination(), PUT: async (req) => this.#mountSetGuideRateDeclination(+req.params.id, await params(req)) },
		'/api/v1/telescope/:id/guideraterightascension': { GET: () => this.#mountGetGuideRateRightAscension(), PUT: async (req) => this.#mountSetGuideRateRightAscension(+req.params.id, await params(req)) },
		'/api/v1/telescope/:id/ispulseguiding': { GET: (req) => this.#guideOutputIsPulseGuiding(+req.params.id, 'telescope') },
		'/api/v1/telescope/:id/rightascension': { GET: (req) => this.#mountGetRightAscension(+req.params.id) },
		'/api/v1/telescope/:id/rightascensionrate': { GET: (req) => this.#mountGetRightAscensionRate(+req.params.id), PUT: async (req) => this.#mountSetRightAscensionRate(+req.params.id, await params(req)) },
		'/api/v1/telescope/:id/sideofpier': { GET: (req) => this.#mountGetSideOfPier(+req.params.id), PUT: async (req) => this.#mountSetSideOfPier(+req.params.id, await params(req)) },
		'/api/v1/telescope/:id/siderealtime': { GET: (req) => this.#mountGetSiderealTime(+req.params.id) },
		'/api/v1/telescope/:id/siteelevation': { GET: (req) => this.#mountGetSiteElevation(+req.params.id), PUT: async (req) => this.#mountSetSiteElevation(+req.params.id, await params(req)) },
		'/api/v1/telescope/:id/sitelatitude': { GET: (req) => this.#mountGetSiteLatitude(+req.params.id), PUT: async (req) => this.#mountSetSiteLatitude(+req.params.id, await params(req)) },
		'/api/v1/telescope/:id/sitelongitude': { GET: (req) => this.#mountGetSiteLongitude(+req.params.id), PUT: async (req) => this.#mountSetSiteLongitude(+req.params.id, await params(req)) },
		'/api/v1/telescope/:id/slewing': { GET: (req) => this.#mountIsSlewing(+req.params.id) },
		'/api/v1/telescope/:id/slewsettletime': { GET: (req) => this.#mountGetSlewSettleTime(+req.params.id), PUT: async (req) => this.#mountSetSlewSettleTime(+req.params.id, await params(req)) },
		'/api/v1/telescope/:id/targetdeclination': { GET: (req) => this.#mountGetTargetDeclination(+req.params.id), PUT: async (req) => this.#mountSetTargetDeclination(+req.params.id, await params(req)) },
		'/api/v1/telescope/:id/targetrightascension': { GET: (req) => this.#mountGetTargetRightAscension(+req.params.id), PUT: async (req) => this.#mountSetTargetRightAscension(+req.params.id, await params(req)) },
		'/api/v1/telescope/:id/tracking': { GET: (req) => this.#mountIsTracking(+req.params.id), PUT: async (req) => this.#mountSetTracking(+req.params.id, await params(req)) },
		'/api/v1/telescope/:id/trackingrate': { GET: (req) => this.#mountGetTrackingRate(+req.params.id), PUT: async (req) => this.#mountSetTrackingRate(+req.params.id, await params(req)) },
		'/api/v1/telescope/:id/trackingrates': { GET: (req) => this.#mountGetTrackingRates(+req.params.id) },
		'/api/v1/telescope/:id/utcdate': { GET: (req) => this.#mountGetUTCDate(+req.params.id), PUT: async (req) => this.#mountSetUTCDate(+req.params.id, await params(req)) },
		'/api/v1/telescope/:id/abortslew': { PUT: (req) => this.#mountStop(+req.params.id) },
		'/api/v1/telescope/:id/axisrates': { GET: async (req) => this.#mountGetAxisRates(+req.params.id, await params(req)) },
		'/api/v1/telescope/:id/canmoveaxis': { GET: async (req) => this.#mountCanMoveAxis(+req.params.id, await params(req)) },
		'/api/v1/telescope/:id/destinationsideofpier': { GET: (req) => this.#mountGetDestinationSideOfPier(+req.params.id) },
		'/api/v1/telescope/:id/findhome': { PUT: (req) => this.#mountFindHome(+req.params.id) },
		'/api/v1/telescope/:id/moveaxis': { PUT: async (req) => this.#mountMoveAxis(+req.params.id, await params(req)) },
		'/api/v1/telescope/:id/park': { PUT: (req) => this.#mountPark(+req.params.id) },
		'/api/v1/telescope/:id/pulseguide': { PUT: async (req) => this.#guideOutputPulseGuide(+req.params.id, 'telescope', await params(req)) },
		'/api/v1/telescope/:id/setpark': { PUT: (req) => this.#mountSetPark(+req.params.id) },
		'/api/v1/telescope/:id/slewtoaltaz': { PUT: async (req) => this.#mountSlewToAltAz(+req.params.id, await params(req)) },
		'/api/v1/telescope/:id/slewtoaltazasync': { PUT: async (req) => this.#mountSlewToAltAzAsync(+req.params.id, await params(req)) },
		'/api/v1/telescope/:id/slewtocoordinates': { PUT: async (req) => this.#mountSlewToCoordinates(+req.params.id, await params(req)) },
		'/api/v1/telescope/:id/slewtocoordinatesasync': { PUT: async (req) => this.#mountSlewToCoordinatesAsync(+req.params.id, await params(req)) },
		'/api/v1/telescope/:id/slewtotarget': { PUT: (req) => this.#mountSlewToTarget(+req.params.id) },
		'/api/v1/telescope/:id/slewtotargetasync': { PUT: (req) => this.#mountSlewToTargetAsync(+req.params.id) },
		'/api/v1/telescope/:id/synctoaltaz': { PUT: async (req) => this.#mountSyncToAltAz(+req.params.id, await params(req)) },
		'/api/v1/telescope/:id/synctocoordinates': { PUT: async (req) => this.#mountSyncToCoordinates(+req.params.id, await params(req)) },
		'/api/v1/telescope/:id/synctotarget': { PUT: (req) => this.#mountSyncToTarget(+req.params.id) },
		'/api/v1/telescope/:id/unpark': { PUT: (req) => this.#mountUnpark(+req.params.id) },
		// Focuser
		'/api/v1/focuser/:id/absolute': { GET: (req) => this.#focuserCanAbsolute(+req.params.id) },
		'/api/v1/focuser/:id/devicestate': { GET: (req) => this.#focuserGetDeviceState(+req.params.id) },
		'/api/v1/focuser/:id/ismoving': { GET: (req) => this.#focuserIsMoving(+req.params.id) },
		'/api/v1/focuser/:id/maxincrement': { GET: (req) => this.#focuserGetMaxIncrement(+req.params.id) },
		'/api/v1/focuser/:id/maxstep': { GET: (req) => this.#focuserGetMaxStep(+req.params.id) },
		'/api/v1/focuser/:id/position': { GET: (req) => this.#focuserGetPosition(+req.params.id) },
		'/api/v1/focuser/:id/stepsize': { GET: () => this.#focuserGetStepSize() },
		'/api/v1/focuser/:id/tempcomp': { GET: () => this.#focuserGetTempComp(), PUT: () => this.#focuserSetTempComp() },
		'/api/v1/focuser/:id/tempcompavailable': { GET: () => this.#focuserGetTempCompAvailable() },
		'/api/v1/focuser/:id/temperature': { GET: (req) => this.#focuserGetTemperature(+req.params.id) },
		'/api/v1/focuser/:id/halt': { PUT: (req) => this.#focuserHalt(+req.params.id) },
		'/api/v1/focuser/:id/move': { PUT: async (req) => this.#focuserMove(+req.params.id, await params(req)) },
		// Cover Calibrator
		'/api/v1/covercalibrator/:id/brightness': { GET: (req) => this.#coverCalibratorGetBrightness(+req.params.id) },
		'/api/v1/covercalibrator/:id/calibratorchanging': { GET: () => this.#coverCalibratorIsChanging() },
		'/api/v1/covercalibrator/:id/calibratorstate': { GET: (req) => this.#coverCalibratorGetCalibratorState(+req.params.id) },
		'/api/v1/covercalibrator/:id/covermoving': { GET: (req) => this.#coverCalibratorIsMoving(+req.params.id) },
		'/api/v1/covercalibrator/:id/coverstate': { GET: (req) => this.#coverCalibratorGetCoverState(+req.params.id) },
		'/api/v1/covercalibrator/:id/devicestate': { GET: (req) => this.#coverCalibratorGetDeviceState(+req.params.id) },
		'/api/v1/covercalibrator/:id/maxbrightness': { GET: (req) => this.#coverCalibratorGetMaxBrightness(+req.params.id) },
		'/api/v1/covercalibrator/:id/calibratoroff': { PUT: (req) => this.#coverCalibratorOff(+req.params.id) },
		'/api/v1/covercalibrator/:id/calibratoron': { PUT: async (req) => this.#coverCalibratorOn(+req.params.id, await params(req)) },
		'/api/v1/covercalibrator/:id/closecover': { PUT: (req) => this.#coverCalibratorClose(+req.params.id) },
		'/api/v1/covercalibrator/:id/haltcover': { PUT: (req) => this.#coverCalibratorHalt(+req.params.id) },
		'/api/v1/covercalibrator/:id/opencover': { PUT: (req) => this.#coverCalibratorOpen(+req.params.id) },
	}

	// Starts the HTTP server on the given host/port (0 = ephemeral) and begins listening for devices.
	// Returns false if already started.
	start(hostname: string = '0.0.0.0', port: number = 0, options?: AlpacaServerStartOptions) {
		if (this.#server) return false

		this.#server = Bun.serve({
			...options,
			hostname,
			port,
			reusePort: options?.reusePort ?? false,
			development: false,
			error: (error) => {
				console.error('server error:', error)
			},
			websocket: undefined,
			fetch: (req) => {
				console.error(req)
				return new Response('Not Found', { status: 404 })
			},
			routes: this.routes,
		})

		this.listen()

		return true
	}

	// Subscribes to all configured device managers, seeds the current devices, and starts the 30 s tick
	// that refreshes mount time/LST.
	listen() {
		this.options.camera?.addHandler(this.#cameraHandler)
		this.options.wheel?.addHandler(this.#wheelHandler)
		this.options.mount?.addHandler(this.#mountHandler)
		this.options.focuser?.addHandler(this.#focuserHandler)
		this.options.cover?.addHandler(this.#coverHandler)
		this.options.flatPanel?.addHandler(this.#flatPanelHandler)

		this.configuredDevices()

		clearInterval(this.#timer)
		this.#timer = setInterval(() => this.#tick(), 30000)
		this.#tick()
	}

	// Unsubscribes from the device managers, clears all registrations, and stops the tick.
	unlisten() {
		this.options.camera?.removeHandler(this.#cameraHandler)
		this.options.wheel?.removeHandler(this.#wheelHandler)
		this.options.mount?.removeHandler(this.#mountHandler)
		this.options.focuser?.removeHandler(this.#focuserHandler)
		this.options.cover?.removeHandler(this.#coverHandler)
		this.options.flatPanel?.removeHandler(this.#flatPanelHandler)

		this.#equipment.camera.clear()
		this.#equipment.telescope.clear()
		this.#equipment.filterwheel.clear()
		this.#equipment.focuser.clear()
		this.#equipment.rotator.clear()
		this.#equipment.covercalibrator.clear()
		// this.equipment.dome.clear()
		// this.equipment.switch.clear()
		// this.equipment.observingconditions.clear()
		// this.equipment.safetymonitor.clear()
		// this.equipment.video.clear()

		clearInterval(this.#timer)
		this.#timer = undefined
	}

	// Stops the HTTP server and unsubscribes from device managers.
	stop() {
		if (this.#server) {
			void this.#server.stop(true)
			this.#server = undefined
		}

		this.unlisten()
	}

	// Periodic refresh of each mount's current time and apparent local sidereal time.
	#tick() {
		// Mount
		const time = timeNow(true)

		for (const { state } of this.#equipment.telescope.values()) {
			state.time = time
			state.lst = localSiderealTime(time, state, false) // Apparent LST
		}
	}

	// Resolves a registered device by INDI device instance or by Alpaca device number, optionally
	// filtering by INDI device subtype. Returns undefined (cast) when not found.
	#device<D extends Device>(key: Device | number, type: AlpacaDeviceType, deviceType?: DeviceType): AlpacaRegisteredDevice<D> {
		if (typeof key === 'object') return this.#equipment[type].get(key)! as never
		else for (const item of this.#equipment[type].values()) if (item.configuredDevice.DeviceNumber === key && (!deviceType || item.device.type === deviceType)) return item as never
		return undefined as never
	}

	// Typed device lookups by Alpaca type (covercalibrator splits into cover and flat-panel subtypes).
	#camera(key: Device | number) {
		return this.#device<Camera>(key, 'camera')
	}

	#telescope(key: Device | number) {
		return this.#device<Mount>(key, 'telescope')
	}

	#wheel(key: Device | number) {
		return this.#device<Wheel>(key, 'filterwheel')
	}

	#focuser(key: Device | number) {
		return this.#device<Focuser>(key, 'focuser')
	}

	#cover(key: Device | number) {
		return this.#device<Cover>(key, 'covercalibrator', 'cover')
	}

	#flatPanel(key: Device | number) {
		return this.#device<FlatPanel>(key, 'covercalibrator', 'flatPanel')
	}

	#guideOutput(key: Device | number, type: 'camera' | 'telescope') {
		return this.#device<GuideOutput>(key, type)
	}

	// Resolves a pending connect/disconnect task when the device's connection state changes, waiting
	// briefly after a connect so the device's properties are fully populated first.
	#handleConnectedEvent(device: Device, type: AlpacaDeviceType) {
		const task = this.#device(device, type).state.tasks.connect

		if (task?.running) {
			task.clear()

			// wait for all properties to be received
			if (device.connected) {
				console.info('device connected:', device.name)
				void Bun.sleep(500).then(() => task.resolve(device.connected))
			} else {
				console.info('device disconnected:', device.name)
				task.resolve(true)
			}
		}
	}

	// Management API

	// Supported Alpaca API versions.
	#apiVersions() {
		return makeAlpacaResponse([1])
	}

	// Server identity for the management description endpoint.
	#apiDescription() {
		return makeAlpacaResponse({ ServerName: this.options.name || 'Nebulosa', Manufacturer: this.options.manufacturer || 'Tiago Melo', ManufacturerVersion: this.options.version || '1.0.0', Location: 'None' })
	}

	// Builds and returns the deduplicated set of configured devices across all managers, registering any
	// not yet known. Also called on listen() to seed registrations.
	configuredDevices() {
		const deviceNumbers = new Set<string>()
		const configuredDevices = new Set<AlpacaConfiguredDevice>()

		const add = (device: Device, type: AlpacaDeviceType) => {
			const { configuredDevice } = this.#makeConfiguredDeviceFromDevice(device, type)
			const key = `${type}.${configuredDevice.DeviceNumber}`

			if (!deviceNumbers.has(key)) {
				configuredDevices.add(configuredDevice)
				deviceNumbers.add(key)
			}
		}

		if (this.options.camera) for (const e of this.options.camera.list()) add(e, 'camera')
		if (this.options.mount) for (const e of this.options.mount.list()) add(e, 'telescope')
		if (this.options.focuser) for (const e of this.options.focuser.list()) add(e, 'focuser')
		if (this.options.wheel) for (const e of this.options.wheel.list()) add(e, 'filterwheel')
		if (this.options.rotator) for (const e of this.options.rotator.list()) add(e, 'rotator')
		if (this.options.flatPanel) for (const e of this.options.flatPanel.list()) add(e, 'covercalibrator')
		if (this.options.cover) for (const e of this.options.cover.list()) add(e, 'covercalibrator')

		return configuredDevices
	}

	// Device API

	#deviceGetInterfaceVersion(type: AlpacaDeviceType) {
		const version = type === 'camera' || type === 'focuser' || type === 'rotator' || type === 'telescope' ? 4 : type === 'dome' || type === 'filterwheel' || type === 'safetymonitor' || type === 'switch' ? 3 : 2
		return makeAlpacaResponse(version)
	}

	#deviceGetDescription(id: number, type: AlpacaDeviceType) {
		return makeAlpacaResponse(this.#device(id, type).device.name)
	}

	#deviceGetName(id: number, type: AlpacaDeviceType) {
		return makeAlpacaResponse(this.#device(id, type).device.name)
	}

	#deviceGetDriverInfo(id: number, type: AlpacaDeviceType) {
		return makeAlpacaResponse(this.#device(id, type).device.driver.executable)
	}

	#deviceGetDriverVersion(id: number, type: AlpacaDeviceType) {
		return makeAlpacaResponse(this.#device(id, type).device.driver.version)
	}

	// Connects or disconnects the device, coalescing concurrent requests onto one pending task and timing
	// out after 10 s. Returns the Alpaca response once the connection state settles.
	async #deviceConnect(id: number, type: AlpacaDeviceType, data: { Connected: string }) {
		const { state, device } = this.#device(id, type)

		if (!device) return makeAlpacaErrorResponse(AlpacaException.InvalidOperation, 'Device is not present')

		if (state.tasks.connect?.running) {
			return await state.tasks.connect.promise.then(makeResponseForTask)
		}

		const connect = isTrue(data.Connected)

		if (connect !== device.connected) {
			const task = promiseWithTimeout(AlpacaException.NotConnected, `Unable to connect to ${device.name}`, 10000)

			state.tasks.connect = task

			console.info(connect ? 'device connecting:' : 'device disconnecting:', device.name)

			if (connect) this.#deviceManager.connect(device as never)
			else this.#deviceManager.disconnect(device as never)

			return await task.promise.then(makeResponseForTask)
		}

		return makeResponseForTask(true)
	}

	#deviceIsConnected(id: number, type: AlpacaDeviceType) {
		return makeAlpacaResponse(this.#device(id, type)?.device.connected)
	}

	#deviceIsConnecting(id: number, type: AlpacaDeviceType) {
		return makeAlpacaResponse(!!this.#device(id, type).state.tasks.connect?.running)
	}

	#deviceGetSupportedActions(id: number, type: AlpacaDeviceType) {
		const { device } = this.#device(id, type)

		if (isFocuser(device)) {
			return makeAlpacaResponse(SUPPORTED_FOCUSER_ACTIONS)
		} else if (isWheel(device)) {
			return makeAlpacaResponse(SUPPORTED_WHEEL_ACTIONS)
		}

		return makeAlpacaResponse([])
	}

	// Dispatches a vendor-specific Alpaca action to the device; returns ActionNotImplemented otherwise.
	#deviceAction(id: number, type: AlpacaDeviceType, data: { Action: string; Parameters: string }) {
		const { device } = this.#device(id, type)
		const action = data.Action.toLowerCase() as Lowercase<AlpacaFocuserAction | AlpacaWheelAction>

		if (isFocuser(device)) {
			if (action === 'togglereverse') return this.#focuserToggleReverse(device)
		}

		return makeAlpacaErrorResponse(AlpacaException.ActionNotImplemented, 'Unknown action')
	}

	// Guide Output API

	#guideOutputPulseGuide(id: number, type: 'camera' | 'telescope', data: { Duration: string; Direction: string }) {
		this.options.guideOutput?.pulse(this.#guideOutput(id, type).device, mapAlpacaEnumToGuideDirection(+data.Direction), +data.Duration)
		return makeAlpacaResponse(undefined)
	}

	#guideOutputIsPulseGuiding(id: number, type: 'camera' | 'telescope') {
		return makeAlpacaResponse(this.#guideOutput(id, type).device.pulsing)
	}

	// Camera API

	#cameraGetBayerOffsetX(id: number) {
		return makeAlpacaResponse(this.#camera(id).device.cfa.offsetX)
	}

	#cameraGetBayerOffsetY(id: number) {
		return makeAlpacaResponse(this.#camera(id).device.cfa.offsetY)
	}

	#cameraGetBinX(id: number) {
		return makeAlpacaResponse(this.#camera(id).device.bin.x.value)
	}

	#cameraSetBinX(id: number, data: { BinX: string }) {
		return this.#cameraSetBin(id, data)
	}

	#cameraGetBinY(id: number) {
		return makeAlpacaResponse(this.#camera(id).device.bin.y.value)
	}

	#cameraSetBinY(id: number, data: { BinY: string }) {
		return this.#cameraSetBin(id, data)
	}

	#cameraSetBin(id: number, data: { BinX?: string; BinY?: string }) {
		const bin = +(data.BinX || data.BinY || 1)
		this.options.camera?.bin(this.#camera(id).device, bin, bin)
		return makeAlpacaResponse(undefined)
	}

	// https://ascom-standards.org/newdocs/camera.html#Camera.CameraStates
	#cameraGetState(id: number) {
		return makeAlpacaResponse(this.#camera(id).device.exposuring ? AlpacaCameraState.EXPOSING : AlpacaCameraState.IDLE)
	}

	#cameraGetXSize(id: number) {
		return makeAlpacaResponse(this.#camera(id).device.frame.width.value)
	}

	#cameraGetYSize(id: number) {
		return makeAlpacaResponse(this.#camera(id).device.frame.height.value)
	}

	#cameraCanStopExposure(id: number) {
		return makeAlpacaResponse(this.#camera(id).device.canAbort)
	}

	#cameraCanAsymmetricBin() {
		return makeAlpacaResponse(false)
	}

	#cameraCanFastReadout() {
		return makeAlpacaResponse(false)
	}

	#cameraCanGetCoolerPower(id: number) {
		return makeAlpacaResponse(this.#camera(id).device.hasCoolerControl)
	}

	#cameraCanPulseGuide(id: number) {
		return makeAlpacaResponse(this.#camera(id).device.canPulseGuide)
	}

	#cameraCanSetCCDTemperature(id: number) {
		return makeAlpacaResponse(this.#camera(id).device.canSetTemperature)
	}

	#cameraGetCcdTemperature(id: number) {
		return makeAlpacaResponse(this.#camera(id).device.temperature)
	}

	#cameraIsCoolerOn(id: number) {
		return makeAlpacaResponse(this.#camera(id).device.cooler)
	}

	#cameraSetCoolerOn(id: number, data: { CoolerOn: string }) {
		this.options.camera?.cooler(this.#camera(id).device, isTrue(data.CoolerOn))
		return makeAlpacaResponse(undefined)
	}

	#cameraGetCoolerPower(id: number) {
		return makeAlpacaResponse(this.#camera(id).device.coolerPower)
	}

	// Bulk DeviceState array for a camera: operational state, temperatures, image-ready, guiding, and
	// exposure progress (PercentCompleted derived from remaining vs. total exposure time).
	#cameraGetDeviceState(id: number) {
		const { state, device } = this.#camera(id)
		const res = new Array<AlpacaStateItem>(8)
		res[0] = { Name: 'CameraState', Value: device.exposuring ? AlpacaCameraState.EXPOSING : AlpacaCameraState.IDLE }
		res[1] = { Name: 'CCDTemperature', Value: device.temperature }
		res[2] = { Name: 'CoolerPower', Value: device.coolerPower }
		res[3] = { Name: 'HeatSinkTemperature', Value: device.temperature }
		res[4] = { Name: 'ImageReady', Value: !!state.data }
		res[5] = { Name: 'IsPulseGuiding', Value: device.pulsing }
		res[6] = { Name: 'PercentCompleted', Value: state.lastExposureDuration === 0 ? 0 : (1 - device.exposure.value / state.lastExposureDuration) * 100 }
		res[7] = { Name: 'TimeStamp', Value: '' }
		return makeAlpacaResponse(res)
	}

	#cameraGetEletronsPerADU() {
		return makeAlpacaResponse(1)
	}

	#cameraGetExposureMax(id: number) {
		return makeAlpacaResponse(this.#camera(id).device.exposure.max)
	}

	#cameraGetExposureMin(id: number) {
		return makeAlpacaResponse(this.#camera(id).device.exposure.min)
	}

	#cameraGetExposureResolution() {
		return makeAlpacaResponse(1e-6)
	}

	#cameraIsFastReadout() {
		return makeAlpacaResponse(false)
	}

	#cameraSetFastReadout() {
		return makeAlpacaResponse(undefined)
	}

	#cameraGetFullwellCapacity() {
		return makeAlpacaResponse(65535)
	}

	#cameraGetGain(id: number) {
		return makeAlpacaResponse(this.#camera(id).device.gain.value)
	}

	#cameraSetGain(id: number, data: { Gain: string }) {
		this.options.camera?.gain(this.#camera(id).device, +data.Gain)
		return makeAlpacaResponse(undefined)
	}

	#cameraGetGainMax(id: number) {
		return makeAlpacaResponse(this.#camera(id).device.gain.max)
	}

	#cameraGetGainMin(id: number) {
		return makeAlpacaResponse(this.#camera(id).device.gain.min)
	}

	#cameraGetGains() {
		return makeAlpacaResponse([], AlpacaException.MethodOrPropertyNotImplemented, 'Gain modes is not supported')
	}

	#cameraHasShutter() {
		return makeAlpacaResponse(false)
	}

	#cameraIsImageReady(id: number) {
		return makeAlpacaResponse(this.#camera(id).state.data !== undefined)
	}

	#cameraGetLastExposureDuration(id: number) {
		return makeAlpacaResponse(this.#camera(id).state.lastExposureDuration)
	}

	#cameraGetMaxADU() {
		return makeAlpacaResponse(65535)
	}

	#cameraGetMaxBinX(id: number) {
		return makeAlpacaResponse(this.#camera(id).device.bin.x.max)
	}

	#cameraGetMaxBinY(id: number) {
		return makeAlpacaResponse(this.#camera(id).device.bin.y.max)
	}

	// Updates the cached subframe [startX, startY, width, height] with whichever fields are provided and
	// applies the combined frame to the device. Shared by the StartX/StartY/NumX/NumY setters.
	#cameraSetFrame(id: number, data: { NumX?: string; NumY?: string; StartX?: string; StartY?: string }) {
		const { state, device } = this.#camera(id)
		const { frame } = state
		if (data.StartX) frame[0] = +data.StartX
		if (data.StartY) frame[1] = +data.StartY
		if (data.NumX) frame[2] = +data.NumX
		if (data.NumY) frame[3] = +data.NumY
		this.options.camera?.frame(device, ...frame)
		return makeAlpacaResponse(undefined)
	}

	#cameraGetNumX(id: number) {
		const { frame, bin } = this.#camera(id).device
		return makeAlpacaResponse(Math.trunc(frame.width.value / bin.x.value))
	}

	#cameraSetNumX(id: number, data: { NumX: string }) {
		return this.#cameraSetFrame(id, data)
	}

	#cameraGetNumY(id: number) {
		const { frame, bin } = this.#camera(id).device
		return makeAlpacaResponse(Math.trunc(frame.height.value / bin.y.value))
	}

	#cameraSetNumY(id: number, data: { NumY: string }) {
		return this.#cameraSetFrame(id, data)
	}

	#cameraGetOffset(id: number) {
		return makeAlpacaResponse(this.#camera(id).device.offset.value)
	}

	#cameraSetOffset(id: number, data: { Offset: string }) {
		this.options.camera?.offset(this.#camera(id).device, +data.Offset)
		return makeAlpacaResponse(undefined)
	}

	#cameraGetOffsetMax(id: number) {
		return makeAlpacaResponse(this.#camera(id).device.offset.max)
	}

	#cameraGetOffsetMin(id: number) {
		return makeAlpacaResponse(this.#camera(id).device.offset.min)
	}

	#cameraGetOffsets() {
		return makeAlpacaResponse([], AlpacaException.MethodOrPropertyNotImplemented, 'Offset modes is not supported')
	}

	#cameraGetPercentCompleted(id: number) {
		const { state, device } = this.#camera(id)
		return makeAlpacaResponse(state.lastExposureDuration === 0 ? 0 : (1 - device.exposure.value / state.lastExposureDuration) * 100)
	}

	#cameraGetPixelSizeX(id: number) {
		return makeAlpacaResponse(this.#camera(id).device.pixelSize.x)
	}

	#cameraGetPixelSizeY(id: number) {
		return makeAlpacaResponse(this.#camera(id).device.pixelSize.y)
	}

	#cameraGetReadoutMode(id: number) {
		return makeAlpacaResponse(this.#camera(id).device.frameFormat)
	}

	#cameraSetReadoutMode(id: number, data: { ReadoutMode: string }) {
		const { device } = this.#camera(id)
		const mode = +data.ReadoutMode

		if (Number.isFinite(mode) && mode >= 0 && mode < device.frameFormats.length) {
			this.options.camera?.frameFormat(device, device.frameFormats[mode].name)
		} else {
			this.options.camera?.frameFormat(device, data.ReadoutMode)
		}

		return makeAlpacaResponse(undefined)
	}

	#cameraGetReadoutModes(id: number) {
		return makeAlpacaResponse(this.#camera(id).device.frameFormats)
	}

	#cameraGetSensorName() {
		return makeAlpacaResponse('')
	}

	// https://ascom-standards.org/newdocs/camera.html#Camera.SensrType
	#cameraGetSensorType(id: number) {
		return makeAlpacaResponse(this.#camera(id).device.cfa.type ? 2 : 0)
	}

	#cameraGetSetCcdTemperature(id: number) {
		return makeAlpacaResponse(this.#camera(id).state.ccdTemperature)
	}

	#cameraSetCcdTemperature(id: number, data: { SetCCDTemperature: string }) {
		const { state, device } = this.#camera(id)
		state.ccdTemperature = +data.SetCCDTemperature
		this.options.camera?.temperature(device, state.ccdTemperature)
		return makeAlpacaResponse(this.#camera(id).device.temperature)
	}

	#cameraGetStartX(id: number) {
		const { frame, bin } = this.#camera(id).device
		return makeAlpacaResponse(Math.trunc(frame.x.value / bin.x.value))
	}

	#cameraSetStartX(id: number, data: { StartX: string }) {
		return this.#cameraSetFrame(id, data)
	}

	#cameraGetStartY(id: number) {
		const { frame, bin } = this.#camera(id).device
		return makeAlpacaResponse(Math.trunc(frame.y.value / bin.y.value))
	}

	#cameraSetStartY(id: number, data: { StartY: string }) {
		return this.#cameraSetFrame(id, data)
	}

	#cameraStop(id: number) {
		const { device } = this.#camera(id)
		this.options.camera?.stopExposure(device)
		this.options.camera?.disableBlob(device)
		return makeAlpacaResponse(undefined)
	}

	// Starts an exposure: enables the BLOB channel, sets the frame type, records the duration, and triggers
	// capture. Duration is seconds; non-positive durations are ignored.
	#cameraStart(id: number, data: { Duration: string; Light: string }) {
		const { device, state } = this.#camera(id)
		const { camera } = this.options
		const duration = +data.Duration

		if (camera && duration > 0) {
			camera.enableBlob(device)
			camera.frameType(device, isTrue(data.Light) ? 'LIGHT' : 'DARK')
			state.lastExposureDuration = duration
			camera.startExposure(device, duration)
		}

		return makeAlpacaResponse(undefined)
	}

	// Returns the last captured frame as Alpaca ImageBytes (only the binary encoding is supported; the JSON
	// array form is rejected). Always clears the buffered image and disables the BLOB channel afterward.
	#cameraGetImageArray(id: number, accept?: string | null) {
		const { state, device } = this.#camera(id)

		try {
			if (accept?.includes('imagebytes')) {
				// const data = Buffer.from(await Bun.file('c:\\Users\\tiago\\Documents\\Nebulosa\\Captures\\SVBONY CCD SV305.fit').arrayBuffer())
				const { data } = state
				const image = makeImageBytesFromFits(Buffer.isBuffer(data) ? data : Buffer.from(data!, 'base64'))
				return new Response(image.buffer, { headers: { 'Content-Type': 'application/imagebytes' } })
			}
		} finally {
			state.data = undefined
			state.lastExposureDuration = 0
			this.options.camera?.disableBlob(device)
		}

		return makeAlpacaErrorResponse(AlpacaException.Driver, 'Image bytes as JSON array is not supported')
	}

	// Filter Wheel API

	// Bulk DeviceState array for a filter wheel: current slot position.
	#wheelGetDeviceState(id: number) {
		const { device } = this.#wheel(id)
		const res = new Array<AlpacaStateItem>(2)
		res[0] = { Name: 'Position', Value: device.position }
		res[1] = { Name: 'TimeStamp', Value: '' }
		return makeAlpacaResponse(res)
	}

	#wheelGetFocusOffsets(id: number) {
		const offsets = new Array<number>(this.#wheel(id).device.count)
		for (let i = 0; i < offsets.length; i++) offsets[i] = 0
		return makeAlpacaResponse(offsets)
	}

	#wheelGetNames(id: number) {
		const names = new Array<string>(this.#wheel(id).device.count)
		for (let i = 0; i < names.length; i++) names[i] = `Filter ${i + 1}`
		return makeAlpacaResponse(names)
	}

	#wheelGetPosition(id: number) {
		const { device } = this.#wheel(id)
		return makeAlpacaResponse(device.moving ? -1 : device.position)
	}

	// Moves the wheel to the requested slot and awaits the position-reached event (or a timeout).
	async #wheelSetPosition(id: number, data: { Position: string }) {
		const { state, device } = this.#wheel(id)
		state.position = +data.Position
		const task = promiseWithTimeout(AlpacaException.ValueNotSet, 'Unable to set wheel position')
		state.tasks.position = task
		this.options.wheel?.moveTo(device, state.position)
		return await task.promise.then(makeResponseForTask)
	}

	// Telescope API

	// https://ascom-standards.org/newdocs/telescope.html#Telescope.AlignmentModes
	#mountGetAlignmentMode() {
		return makeAlpacaResponse(2) // TODO: INDI doesn't support it
	}

	#mountGetAltitude(id: number) {
		const { state, device } = this.#telescope(id)
		const [, altitude] = equatorialToHorizontal(device.equatorialCoordinate.rightAscension, device.equatorialCoordinate.declination, state.latitude, state.lst)
		return makeAlpacaResponse(toDeg(altitude))
	}

	#mountGetApertureArea() {
		return makeAlpacaErrorResponse(AlpacaException.MethodOrPropertyNotImplemented, 'Telescope does not have aperture area')
	}

	#mountGetApertureDiameter() {
		return makeAlpacaErrorResponse(AlpacaException.MethodOrPropertyNotImplemented, 'Telescope does not have aperture diameter')
	}

	#mountIsAtHome(id: number) {
		return makeAlpacaResponse(false) // TODO: INDI doesn't support it?
	}

	#mountIsAtPark(id: number) {
		return makeAlpacaResponse(this.#telescope(id).device.parked)
	}

	#mountGetAzimuth(id: number) {
		const { state, device } = this.#telescope(id)
		const [azimuth] = equatorialToHorizontal(device.equatorialCoordinate.rightAscension, device.equatorialCoordinate.declination, state.latitude, state.lst)
		return makeAlpacaResponse(toDeg(azimuth))
	}

	#mountCanFindHome(id: number) {
		return makeAlpacaResponse(this.#telescope(id).device.canFindHome)
	}

	#mountCanPark(id: number) {
		return makeAlpacaResponse(this.#telescope(id).device.canPark)
	}

	#mountCanPulseGuide(id: number) {
		return makeAlpacaResponse(this.#telescope(id).device.canPulseGuide)
	}

	#mountCanSetDeclinationRate(id: number) {
		return makeAlpacaResponse(false) // TODO: INDI doesn't support it?
	}

	#mountCanSetGuideRates(id: number) {
		return makeAlpacaResponse(false) // TODO: INDI doesn't support it?
	}

	#mountCanSetPark(id: number) {
		return makeAlpacaResponse(this.#telescope(id).device.canSetPark)
	}

	#mountCanSetPierSide(id: number) {
		return makeAlpacaResponse(false) // TODO: INDI doesn't support it!
	}

	#mountCanSetRightAscensionRate(id: number) {
		return makeAlpacaResponse(false) // TODO: INDI doesn't support it?
	}

	#mountCanSetTracking(id: number) {
		return makeAlpacaResponse(this.#telescope(id).device.canTracking)
	}

	#mountCanSlew(id: number) {
		return makeAlpacaResponse(this.#telescope(id).device.canGoTo)
	}

	#mountCanSlewAltAz(id: number) {
		return this.#mountCanSlew(id)
	}

	#mountCanSlewAltAzAsync(id: number) {
		return this.#mountCanSlewAltAz(id)
	}

	#mountCanSlewAsync(id: number) {
		return this.#mountCanSlew(id)
	}

	#mountCanSync(id: number) {
		return makeAlpacaResponse(this.#telescope(id).device.canSync)
	}

	#mountCanSyncAltAz(id: number) {
		return this.#mountCanSync(id)
	}

	#mountCanUnpark(id: number) {
		return this.#mountCanPark(id)
	}

	#mountGetDeclination(id: number) {
		return makeAlpacaResponse(toDeg(this.#telescope(id).device.equatorialCoordinate.declination))
	}

	#mountGetDeclinationRate(id: number) {
		return makeAlpacaErrorResponse(AlpacaException.MethodOrPropertyNotImplemented, 'Telescope does not have declination rate')
	}

	#mountSetDeclinationRate(id: number, data: { DeclinationRate: string }) {
		return makeAlpacaErrorResponse(AlpacaException.MethodOrPropertyNotImplemented, 'Telescope does not have declination rate')
	}

	// Bulk DeviceState array for a mount: park/home, equatorial coordinates (RA hours, Dec degrees), pier
	// side, slewing/tracking/guiding flags, and UTC time. Altitude/azimuth/sidereal time are placeholders.
	#mountGetDeviceState(id: number) {
		const { device } = this.#telescope(id)
		const res = new Array<AlpacaStateItem>(13)
		res[0] = { Name: 'Altitude', Value: 0 }
		res[1] = { Name: 'AtHome', Value: false }
		res[2] = { Name: 'AtPark', Value: device.parked }
		res[3] = { Name: 'Azimuth', Value: 0 }
		res[4] = { Name: 'Declination', Value: toDeg(device.equatorialCoordinate.declination) }
		res[5] = { Name: 'IsPulseGuiding', Value: device.pulsing }
		res[6] = { Name: 'RightAscension', Value: toHour(device.equatorialCoordinate.rightAscension) }
		res[7] = { Name: 'SideOfPier', Value: mapPierSideToAlpacaEnum(device.pierSide) }
		res[8] = { Name: 'SiderealTime', Value: 0 }
		res[9] = { Name: 'Slewing', Value: device.slewing }
		res[10] = { Name: 'Tracking', Value: device.tracking }
		res[11] = { Name: 'UTCDate', Value: new Date(device.time.utc).toISOString() }
		res[12] = { Name: 'TimeStamp', Value: '' }
		return makeAlpacaResponse(res)
	}

	#mountGetDoesRefraction(id: number) {
		return makeAlpacaResponse(this.#telescope(id).state.doesRefraction)
	}

	#mountSetDoesRefraction(id: number, data: { DoesRefraction: string }) {
		this.#telescope(id).state.doesRefraction = isTrue(data.DoesRefraction)
		return makeAlpacaResponse(undefined)
	}

	// https://ascom-standards.org/newdocs/telescope.html#Telescope.EquatorialCoordinateType
	#mountGetEquatorialSystem() {
		return makeAlpacaResponse(1) // Topocentric coordinates
	}

	#mountGetFocalLength() {
		return makeAlpacaErrorResponse(AlpacaException.MethodOrPropertyNotImplemented, 'Telescope does not have focal length')
	}

	#mountGetGuideRateDeclination() {
		return makeAlpacaErrorResponse(AlpacaException.MethodOrPropertyNotImplemented, 'Telescope does not have guide rate declination')
	}

	#mountSetGuideRateDeclination(id: number, data: { GuideRateDeclination: string }) {
		return makeAlpacaErrorResponse(AlpacaException.MethodOrPropertyNotImplemented, 'Telescope does not have guide rate declination')
	}

	#mountGetGuideRateRightAscension() {
		return makeAlpacaErrorResponse(AlpacaException.MethodOrPropertyNotImplemented, 'Telescope does not have guide rate right ascension')
	}

	#mountSetGuideRateRightAscension(id: number, data: { GuideRateRightAscension: string }) {
		return makeAlpacaErrorResponse(AlpacaException.MethodOrPropertyNotImplemented, 'Telescope does not have guide rate right ascension')
	}

	#mountGetRightAscension(id: number) {
		return makeAlpacaResponse(toHour(this.#telescope(id).device.equatorialCoordinate.rightAscension))
	}

	#mountGetRightAscensionRate(id: number) {
		return makeAlpacaErrorResponse(AlpacaException.MethodOrPropertyNotImplemented, 'Telescope does not have right ascension rate')
	}

	#mountSetRightAscensionRate(id: number, data: { RightAscensionRate: string }) {
		return makeAlpacaErrorResponse(AlpacaException.MethodOrPropertyNotImplemented, 'Telescope does not have right ascension rate')
	}

	// https://ascom-standards.org/newdocs/telescope.html#Telescope.PierSide
	#mountGetSideOfPier(id: number) {
		return makeAlpacaResponse(mapPierSideToAlpacaEnum(this.#telescope(id).device.pierSide))
	}

	#mountSetSideOfPier(id: number, data: { SideOfPier: string }) {
		return makeAlpacaErrorResponse(AlpacaException.MethodOrPropertyNotImplemented, 'Telescope does not support set side of pier')
	}

	#mountGetSiderealTime(id: number) {
		return makeAlpacaResponse(toHour(this.#telescope(id).state.lst))
	}

	#mountGetSiteElevation(id: number) {
		return makeAlpacaResponse(toMeter(this.#telescope(id).device.geographicCoordinate.elevation))
	}

	#mountSetSiteElevation(id: number, data: { SiteElevation: string }) {
		const { state, device } = this.#telescope(id)
		state.elevation = meter(+data.SiteElevation)
		this.options.mount?.geographicCoordinate(device, state)
		return makeAlpacaResponse(undefined)
	}

	#mountGetSiteLatitude(id: number) {
		return makeAlpacaResponse(toDeg(this.#telescope(id).device.geographicCoordinate.latitude))
	}

	#mountSetSiteLatitude(id: number, data: { SiteLatitude: string }) {
		const { state, device } = this.#telescope(id)
		state.latitude = deg(+data.SiteLatitude)
		this.options.mount?.geographicCoordinate(device, state)
		return makeAlpacaResponse(undefined)
	}

	#mountGetSiteLongitude(id: number) {
		return makeAlpacaResponse(toDeg(this.#telescope(id).device.geographicCoordinate.longitude))
	}

	#mountSetSiteLongitude(id: number, data: { SiteLongitude: string }) {
		const { state, device } = this.#telescope(id)
		state.longitude = deg(+data.SiteLongitude)
		this.options.mount?.geographicCoordinate(device, state)
		return makeAlpacaResponse(undefined)
	}

	#mountIsSlewing(id: number) {
		return makeAlpacaResponse(this.#telescope(id).device.slewing)
	}

	#mountGetSlewSettleTime(id: number) {
		return makeAlpacaResponse(this.#telescope(id).state.slewSettleTime)
	}

	#mountSetSlewSettleTime(id: number, data: { SlewSettleTime: string }) {
		const { state } = this.#telescope(id)
		state.slewSettleTime = +data.SlewSettleTime
		return makeAlpacaResponse(undefined)
	}

	#mountGetTargetDeclination(id: number) {
		return makeAlpacaResponse(toDeg(this.#telescope(id).state.declination))
	}

	#mountSetTargetDeclination(id: number, data: { TargetDeclination: string }) {
		this.#telescope(id).state.declination = deg(+data.TargetDeclination)
		return makeAlpacaResponse(undefined)
	}

	#mountGetTargetRightAscension(id: number) {
		return makeAlpacaResponse(toHour(this.#telescope(id).state.rightAscension))
	}

	#mountSetTargetRightAscension(id: number, data: { TargetRightAscension: string }) {
		this.#telescope(id).state.rightAscension = hour(+data.TargetRightAscension)
		return makeAlpacaResponse(undefined)
	}

	#mountIsTracking(id: number) {
		return makeAlpacaResponse(this.#telescope(id).device.tracking)
	}

	#mountSetTracking(id: number, data: { Tracking: string }) {
		this.options.mount?.tracking(this.#telescope(id).device, isTrue(data.Tracking))
		return makeAlpacaResponse(undefined)
	}

	// https://ascom-standards.org/newdocs/telescope.html#Telescope.DriveRates
	#mountGetTrackingRate(id: number) {
		return makeAlpacaResponse(mapTrackModeToAlpacaEnum(this.#telescope(id).device.trackMode))
	}

	#mountSetTrackingRate(id: number, data: { TrackingRate: string }) {
		this.options.mount?.trackMode(this.#telescope(id).device, mapAlpacaEnumToTrackMode(+data.TrackingRate & 0xff))
		return makeAlpacaResponse(undefined)
	}

	#mountGetTrackingRates(id: number) {
		return makeAlpacaResponse(this.#telescope(id).device.trackModes.map(mapTrackModeToAlpacaEnum))
	}

	#mountGetUTCDate(id: number) {
		return makeAlpacaResponse(new Date().toISOString())
	}

	#mountSetUTCDate(id: number, data: { UTCDate: string }) {
		const { device } = this.#telescope(id)
		const utc = new Date(data.UTCDate).getTime()
		this.options.mount?.time(device, { utc, offset: device.time.offset })
		return makeAlpacaResponse(undefined)
	}

	#mountStop(id: number) {
		this.options.mount?.stop(this.#telescope(id).device)
		return makeAlpacaResponse(undefined)
	}

	#mountGetAxisRates(id: number, data: { Axis: string }) {
		return makeAlpacaResponse(this.#telescope(id).device.slewRates.map(mapSlewRateToAlpacaAxisRate))
	}

	#mountCanMoveAxis(id: number, data: { Axis: string }) {
		return makeAlpacaResponse(this.#telescope(id).device.canMove)
	}

	// Predicts the pier side the mount would adopt for its current coordinates given the local sidereal time.
	#mountGetDestinationSideOfPier(id: number) {
		const { state, device } = this.#telescope(id)
		const pierSide = expectedPierSide(device.equatorialCoordinate.rightAscension, device.equatorialCoordinate.declination, state.lst)
		return makeAlpacaResponse(mapPierSideToAlpacaEnum(pierSide))
	}

	#mountFindHome(id: number) {
		this.options.mount?.findHome(this.#telescope(id).device)
		return makeAlpacaResponse(undefined)
	}

	// Starts or stops slewing on one axis. Rate sign chooses direction (primary: east/west, secondary:
	// north/south); rate 0 stops both directions on that axis.
	#mountMoveAxis(id: number, data: { Axis: string; Rate: string }) {
		const rate = +data.Rate
		const isPrimaryAxis = +data.Axis === 0
		const { device } = this.#telescope(id)

		if (rate === 0) {
			if (isPrimaryAxis) {
				this.options.mount?.moveEast(device, false)
				this.options.mount?.moveWest(device, false)
			} else {
				this.options.mount?.moveNorth(device, false)
				this.options.mount?.moveSouth(device, false)
			}
		} else if (isPrimaryAxis) {
			if (rate > 0) {
				this.options.mount?.moveEast(device, true)
			} else {
				this.options.mount?.moveWest(device, true)
			}
		} else if (rate > 0) {
			this.options.mount?.moveNorth(device, true)
		} else {
			this.options.mount?.moveSouth(device, true)
		}

		return makeAlpacaResponse(undefined)
	}

	#mountPark(id: number) {
		this.options.mount?.park(this.#telescope(id).device)
		return makeAlpacaResponse(undefined)
	}

	#mountSetPark(id: number) {
		this.options.mount?.setPark(this.#telescope(id).device)
		return makeAlpacaResponse(undefined)
	}

	#mountSlewToAltAz(id: number, data: { Azimuth: string; Altitude: string }) {
		return this.#mountSlewToAltAzAsync(id, data)
	}

	// Slews to an alt/az target by converting observed horizontal coordinates (degrees) to CIRS RA/Dec,
	// applying refraction only when the device has it enabled.
	#mountSlewToAltAzAsync(id: number, data: { Azimuth: string; Altitude: string }) {
		const { state, device } = this.#telescope(id)
		const [rightAscension, declination] = observedToCirs(deg(+data.Azimuth), deg(+data.Altitude), state.time!, state.doesRefraction ? undefined : false, state)
		this.options.mount?.goTo(device, rightAscension, declination)
		return makeAlpacaResponse(undefined)
	}

	#mountSlewToCoordinates(id: number, data: { RightAscension: string | number; Declination: string | number }) {
		return this.#mountSlewToCoordinatesAsync(id, data)
	}

	#mountSlewToCoordinatesAsync(id: number, data: { RightAscension: string | number; Declination: string | number }) {
		this.options.mount?.goTo(this.#telescope(id).device, hour(+data.RightAscension), deg(+data.Declination))
		return makeAlpacaResponse(undefined)
	}

	#mountSlewToTarget(id: number) {
		return this.#mountSlewToTargetAsync(id)
	}

	#mountSlewToTargetAsync(id: number) {
		const { state } = this.#telescope(id)
		return this.#mountSlewToCoordinatesAsync(id, { RightAscension: state.rightAscension, Declination: state.declination })
	}

	#mountSyncToAltAz(id: number, data: { Azimuth: string; Altitude: string }) {
		return makeAlpacaErrorResponse(AlpacaException.MethodOrPropertyNotImplemented, 'Telescope does not support slew alt/az') // TODO: Compute this!
	}

	#mountSyncToCoordinates(id: number, data: { RightAscension: string | number; Declination: string | number }) {
		this.options.mount?.syncTo(this.#telescope(id).device, hour(+data.RightAscension), deg(+data.Declination))
		return makeAlpacaResponse(undefined)
	}

	#mountSyncToTarget(id: number) {
		const { state } = this.#telescope(id)
		return this.#mountSyncToCoordinates(id, { RightAscension: state.rightAscension, Declination: state.declination })
	}

	#mountUnpark(id: number) {
		this.options.mount?.unpark(this.#telescope(id).device)
		return makeAlpacaResponse(undefined)
	}

	// Focuser

	#focuserCanAbsolute(id: number) {
		return makeAlpacaResponse(this.#focuser(id).device.canAbsoluteMove)
	}

	// Bulk DeviceState array for a focuser: motion flag, position (0 for relative-only focusers), and temp.
	#focuserGetDeviceState(id: number) {
		const { device } = this.#focuser(id)
		const res = new Array<AlpacaStateItem>(4)
		res[0] = { Name: 'IsMoving', Value: device.moving }
		res[1] = { Name: 'Position', Value: device.canAbsoluteMove ? device.position.value : 0 }
		res[2] = { Name: 'Temperature', Value: device.temperature }
		res[3] = { Name: 'TimeStamp', Value: '' }
		return makeAlpacaResponse(res)
	}

	#focuserIsMoving(id: number) {
		return makeAlpacaResponse(this.#focuser(id).device.moving)
	}

	#focuserGetMaxIncrement(id: number) {
		return this.#focuserGetMaxStep(id)
	}

	#focuserGetMaxStep(id: number) {
		return makeAlpacaResponse(this.#focuser(id).device.position.max)
	}

	#focuserGetPosition(id: number) {
		return makeAlpacaResponse(this.#focuser(id).device.position.value)
	}

	#focuserGetStepSize() {
		return makeAlpacaErrorResponse(AlpacaException.MethodOrPropertyNotImplemented, 'Focuser does not support step size')
	}

	#focuserGetTempComp() {
		return makeAlpacaResponse(false)
	}

	#focuserSetTempComp() {
		return makeAlpacaResponse(undefined)
	}

	#focuserGetTempCompAvailable() {
		return makeAlpacaResponse(false)
	}

	#focuserGetTemperature(id: number) {
		return makeAlpacaResponse(this.#focuser(id).device.temperature)
	}

	#focuserHalt(id: number) {
		this.options.focuser?.stop(this.#focuser(id).device)
		return makeAlpacaResponse(undefined)
	}

	// Moves the focuser: absolute target for absolute focusers, otherwise relative in/out steps by sign.
	#focuserMove(id: number, data: { Position: string }) {
		const { device } = this.#focuser(id)
		const position = +data.Position

		if (device.canAbsoluteMove) {
			this.options.focuser?.moveTo(device, position)
		} else if (position > 0) {
			this.options.focuser?.moveIn(device, position)
		} else {
			this.options.focuser?.moveOut(device, position)
		}

		return makeAlpacaResponse(undefined)
	}

	#focuserToggleReverse(focuser: Focuser) {
		this.options.focuser?.reverse(focuser, !focuser.reversed)
		return makeAlpacaResponse('OK')
	}

	// Cover Calibrator API

	#coverCalibratorGetBrightness(id: number) {
		return makeAlpacaResponse(this.#flatPanel(id)?.device.intensity.value ?? 0)
	}

	#coverCalibratorIsChanging() {
		return makeAlpacaResponse(false) // INDI does not support it!
	}

	// https://ascom-standards.org/newdocs/covercalibrator.html#CalibratorStatus
	#coverCalibratorGetCalibratorState(id: number) {
		return makeAlpacaResponse(mapToCalibratorState(this.#flatPanel(id)?.device))
	}

	#coverCalibratorIsMoving(id: number) {
		return makeAlpacaResponse(this.#cover(id)?.device.parking)
	}

	// https://ascom-standards.org/newdocs/covercalibrator.html#CoverStatus
	#coverCalibratorGetCoverState(id: number) {
		return makeAlpacaResponse(mapToCoverState(this.#cover(id)?.device))
	}

	// Bulk DeviceState array for a cover-calibrator: brightness, calibrator state, and cover state/motion.
	#coverCalibratorGetDeviceState(id: number) {
		const cover = this.#cover(id)?.device
		const flatPanel = this.#flatPanel(id)?.device
		const res = new Array<AlpacaStateItem>(6)
		res[0] = { Name: 'Brightness', Value: flatPanel?.intensity.value ?? 0 }
		res[1] = { Name: 'CalibratorChanging', Value: false }
		res[2] = { Name: 'CalibratorState', Value: mapToCalibratorState(flatPanel) }
		res[3] = { Name: 'CoverMoving', Value: cover?.parking ?? false }
		res[4] = { Name: 'CoverState', Value: mapToCoverState(cover) }
		res[5] = { Name: 'TimeStamp', Value: '' }
		return makeAlpacaResponse(res)
	}

	#coverCalibratorGetMaxBrightness(id: number) {
		return makeAlpacaResponse(this.#flatPanel(id).device.intensity.max)
	}

	#coverCalibratorOn(id: number, data: { Brightness: string }) {
		const { device } = this.#flatPanel(id)
		const { flatPanel } = this.options
		flatPanel?.enable(device)
		flatPanel?.intensity(device, +data.Brightness)
		return makeAlpacaResponse(undefined)
	}

	#coverCalibratorOff(id: number) {
		this.options.flatPanel?.disable(this.#flatPanel(id).device)
		return makeAlpacaResponse(undefined)
	}

	#coverCalibratorClose(id: number) {
		this.options.cover?.park(this.#cover(id).device)
		return makeAlpacaResponse(undefined)
	}

	#coverCalibratorHalt(id: number) {
		this.options.cover?.stop(this.#cover(id).device)
		return makeAlpacaResponse(undefined)
	}

	#coverCalibratorOpen(id: number) {
		this.options.cover?.unpark(this.#cover(id).device)
		return makeAlpacaResponse(undefined)
	}

	// Registers a device (idempotently) under its Alpaca type: assigns a device number, seeds its state
	// from the device (frame for cameras, coordinates for mounts), stores it, and fires deviceAdded.
	#makeConfiguredDeviceFromDevice(device: Device, DeviceType: AlpacaDeviceType): AlpacaRegisteredDevice {
		const type = DeviceType.toLowerCase() as AlpacaDeviceType

		let registeredDevice = this.#equipment[type].get(device)
		if (registeredDevice) return registeredDevice

		const DeviceNumber = this.#deviceNumberProvider(device, DeviceType)
		const configuredDevice: AlpacaConfiguredDevice = { DeviceName: device.name, DeviceNumber, UniqueID: device.id, DeviceType }

		const state = structuredClone(DEFAULT_ALPACA_DEVICE_STATE)

		if (isCamera(device)) {
			state.frame = [device.frame.x.value, device.frame.y.value, device.frame.width.value, device.frame.height.value]
		} else if (isMount(device)) {
			Object.assign(state, device.geographicCoordinate)
			Object.assign(state, device.equatorialCoordinate)
		}

		registeredDevice = { device, configuredDevice, state }
		this.#equipment[type].set(device, registeredDevice as never)

		console.info(device.type, 'added:', JSON.stringify(configuredDevice))
		this.options.handler?.deviceAdded?.(this, device, configuredDevice)

		return registeredDevice
	}

	// Unregisters a device from its Alpaca type bucket and fires deviceRemoved if it was present.
	#removeConfiguredDevice(device: Device, DeviceType: AlpacaDeviceType) {
		const type = DeviceType.toLowerCase() as AlpacaDeviceType
		const registeredDevice = this.#equipment[type].get(device)

		if (registeredDevice !== undefined && this.#equipment[type].delete(device)) {
			console.info(device.type, 'removed:', JSON.stringify(registeredDevice.configuredDevice))
			this.options.handler?.deviceRemoved?.(this, device, registeredDevice.configuredDevice)
		}
	}
}

// Merges path params with any form-urlencoded body fields into a single record for a PUT handler.
async function params<T extends Record<string, string | number | boolean | undefined>>(req: Bun.BunRequest) {
	const data = req.headers.get('Content-Type')?.startsWith('application/x-www-form-urlencoded') ? await req.formData() : undefined
	const res: Record<string, string> = req.params
	if (data !== undefined) for (const [key, value] of data) if (typeof value === 'string') res[key] = value
	return res as T
}

// Creates a resolvable task that auto-fails with the given Alpaca error after `delay` ms. Exposes
// resolve(), the settled promise (mapping false/rejection to an AlpacaError), running/completed flags,
// and a clear() to cancel the timeout. Used to await device connect/move completion via events.
function promiseWithTimeout(code: AlpacaException, message: string, delay: number = 30000) {
	const { promise, resolve } = Promise.withResolvers<AlpacaError | boolean>()

	let completed = false

	const timer = setTimeout(() => {
		if (!completed) {
			console.warn('task timed out after', delay, 'ms:', message)
			resolve(new AlpacaError(code, message))
		}
	}, delay)

	return {
		resolve,
		promise: promise.then(
			(value) => {
				completed = true
				clearTimeout(timer)
				return value === false ? new AlpacaError(code, message) : value
			},
			(error) => {
				completed = true
				clearTimeout(timer)
				return error instanceof AlpacaError ? error : new AlpacaError(code, message)
			},
		),
		get running() {
			return !completed
		},
		get completed() {
			return completed
		},
		clear: clearTimeout.bind(undefined, timer),
	} as const
}

// Encodes an in-memory FITS image into the Alpaca ImageBytes binary format: writes the 44/48-byte
// metadata header then the pixel data transposed into Alpaca's column-major [x][y][channel] order and
// rebiased to unsigned (BZERO) values. Big-endian FITS samples are byte-swapped around the copy. The
// transmitted element type is forced to a 32-bit width to satisfy clients like MaxIm DL.
// https://github.com/ASCOMInitiative/ASCOMRemote/blob/main/Documentation/AlpacaImageBytes.pdf
export function makeImageBytesFromFits(source: Buffer<ArrayBuffer>) {
	const reader = new FitsKeywordReader()
	let position = 0

	let bitpix = Bitpix.BYTE
	let numX = 0
	let numY = 0
	let numZ = 0

	while (true) {
		const [key, value] = reader.read(source, position)

		position += 80

		if (key === 'BITPIX') bitpix = value as number
		else if (key === 'NAXIS1') numX = value as number
		else if (key === 'NAXIS2') numY = value as number
		else if (key === 'NAXIS3') numZ = value as number
		else if (key === 'END') {
			position += computeRemainingBytes(position)
			break
		}
	}

	const channels = numZ || 1
	const bytesPerPixel = bitpixInBytes(bitpix)
	const numberOfPixels = numX * numY
	const dataStart = bitpix === -64 ? 48 : 44 // 64-bit must be aligned (48 % 8 === 0)
	const output = Buffer.allocUnsafe(dataStart + numberOfPixels * channels * bytesPerPixel)

	output.writeInt32LE(1, 0) // Bytes 0..3 - Metadata version = 1
	output.writeInt32LE(0, 4) // Bytes 4..7 - Alpaca error number or zero for success
	output.writeInt32LE(0, 8) // Bytes 8..11 - Client's transaction ID
	output.writeInt32LE(0, 12) // Bytes 12..15 - Device's transaction ID
	output.writeInt32LE(dataStart, 16) // Bytes 16..19 - Offset of the start of the data bytes
	output.writeInt32LE(AlpacaImageElementType.Int32, 20) // Bytes 20..23 - Element type of the source image array. It's always 2 (Int32)? Because MaxIm DL crashes if it's not!
	output.writeInt32LE(bitpix === 8 ? AlpacaImageElementType.Byte : bitpix === 16 ? AlpacaImageElementType.UInt16 : bitpix === 32 ? AlpacaImageElementType.UInt32 : bitpix === -32 ? AlpacaImageElementType.Single : AlpacaImageElementType.Double, 24) // Bytes 24..27 - Element type as sent over the network.
	output.writeInt32LE(numZ || 2, 28) // Bytes 28..31 - Image array rank (2 or 3)
	output.writeInt32LE(numX, 32) // Bytes 32..35 - Length of image array first dimension
	output.writeInt32LE(numY, 36) // Bytes 36..39 - Length of image array second dimension
	output.writeInt32LE(numZ, 40) // Bytes 40..43 - Length of image array third dimension (0 for 2D array)

	const zero = bitpix === 16 ? 32768 : bitpix === 32 ? 2147483648 : 0

	if (bytesPerPixel === 2) source.swap16()
	else if (bytesPerPixel === 4) source.swap32()
	else if (bytesPerPixel === 8) source.swap64()

	const sourceLength = (source.byteLength - position) / bytesPerPixel
	const SourceTypedArray = bitpix === 8 ? Uint8Array : bitpix === 16 ? Int16Array : bitpix === 32 ? Int32Array : bitpix === -32 ? Float32Array : Float64Array
	const sourceArray = new SourceTypedArray(source.buffer, position, sourceLength)
	const outputLength = (output.byteLength - dataStart) / bytesPerPixel
	const OutputTypedArray = bitpix === 8 ? Uint8Array : bitpix === 16 ? Uint16Array : bitpix === 32 ? Uint32Array : bitpix === -32 ? Float32Array : Float64Array
	const outputArray = new OutputTypedArray(output.buffer, dataStart, outputLength)

	for (let x = 0, p = 0; x < numX; x++) {
		for (let y = 0, n = 0; y < numY; y++, n += numX) {
			for (let c = 0, m = n + x; c < channels; c++, m += numberOfPixels, p++) {
				outputArray[p] = sourceArray[m] + zero
			}
		}
	}

	if (bytesPerPixel === 2) source.swap16()
	else if (bytesPerPixel === 4) source.swap32()
	else if (bytesPerPixel === 8) source.swap64()

	return output
}

// Case-insensitive boolean parse of an Alpaca 'True'/'False' form value.
function isTrue(value: string) {
	return value.toLowerCase() === 'true'
}

// Wraps a value in the Alpaca JSON response envelope.
function makeAlpacaResponse(data: unknown, code: AlpacaException | 0 = 0, message: string = '') {
	return Response.json({ Value: data, ClientTransactionID: 0, ServerTransactionID: 0, ErrorNumber: code, ErrorMessage: message })
}

// Builds an Alpaca error response (no value, with code and message).
function makeAlpacaErrorResponse(code: AlpacaException, message: string) {
	return makeAlpacaResponse(undefined, code, message)
}

// Converts a settled task result into a success or error Alpaca response.
function makeResponseForTask(result: true | AlpacaError) {
	return result === true ? makeAlpacaResponse(undefined) : makeAlpacaErrorResponse(result.code, result.message)
}

// Pier side → Alpaca enum: EAST=0, WEST=1, unknown=-1.
function mapPierSideToAlpacaEnum(value: PierSide) {
	return value === 'EAST' ? 0 : value === 'WEST' ? 1 : -1
}

// Guide direction → Alpaca enum: NORTH=0, SOUTH=1, EAST=2, WEST=3.
function mapGuideDirectionToAlpacaEnum(value: GuideDirection) {
	return value === 'NORTH' ? 0 : value === 'SOUTH' ? 1 : value === 'EAST' ? 2 : 3
}

// Alpaca enum → guide direction (inverse of mapGuideDirectionToAlpacaEnum).
function mapAlpacaEnumToGuideDirection(value: number): GuideDirection {
	return value === 0 ? 'NORTH' : value === 1 ? 'SOUTH' : value === 2 ? 'EAST' : 'WEST'
}

// Track mode → Alpaca enum: SIDEREAL=0, LUNAR=1, SOLAR=2, KING=3.
function mapTrackModeToAlpacaEnum(value: TrackMode) {
	return value === 'SIDEREAL' ? 0 : value === 'LUNAR' ? 1 : value === 'SOLAR' ? 2 : 3
}

// Alpaca enum → track mode (inverse of mapTrackModeToAlpacaEnum).
function mapAlpacaEnumToTrackMode(value: number): TrackMode {
	return value === 0 ? 'SIDEREAL' : value === 1 ? 'LUNAR' : value === 2 ? 'SOLAR' : 'KING'
}

// Represents each named slew rate as a unit Alpaca axis rate keyed by its 1-based index.
function mapSlewRateToAlpacaAxisRate(rate: NameAndLabel, index: number): AlpacaAxisRate {
	return { Minimum: index + 1, Maximum: index + 1 }
}

// Flat panel → Alpaca calibrator state: 0 not present, 3 ready.
function mapToCalibratorState(device?: FlatPanel) {
	return device === undefined ? 0 : device.intensity.max !== 0 ? 3 : 0 // 0 = Not present, 3 = Ready
}

// Cover → Alpaca cover state: 0 not present, 1 closed, 2 moving, 3 open.
function mapToCoverState(device?: Cover) {
	return device === undefined ? 0 : !device.canPark ? 0 : device.parking ? 2 : device.parked ? 1 : 3 // 0 = Not Present, 1 = Closed, 2 = Moving, 3 = Open
}
