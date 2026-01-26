// biome-ignore format: too long!
import { type AlpacaAxisRate, AlpacaCameraState, type AlpacaConfiguredDevice, type AlpacaDeviceNumberProvider, type AlpacaDeviceType, AlpacaError, AlpacaException, type AlpacaFocuserAction, AlpacaImageElementType, type AlpacaServerDescription, type AlpacaServerOptions, type AlpacaServerStartOptions, type AlpacaStateItem, type AlpacaWheelAction, defaultDeviceNumberProvider, SUPPORTED_FOCUSER_ACTIONS, SUPPORTED_WHEEL_ACTIONS } from './alpaca.types'
import { type Angle, deg, hour, toDeg, toHour } from './angle'
import { observedToCirs } from './astrometry'
import { type EquatorialCoordinate, equatorialToHorizontal } from './coordinate'
import { meter, toMeter } from './distance'
import { Bitpix, bitpixInBytes, computeRemainingBytes, FitsKeywordReader } from './fits'
// biome-ignore format: too long!
import { type Camera, type Cover, type Device, type DeviceType, expectedPierSide, type FlatPanel, type Focuser, type GuideDirection, type GuideOutput, isCamera, isFocuser, isMount, isWheel, type Mount, type PierSide, type Rotator, type SlewRate, type TrackMode, type Wheel } from './indi.device'
import type { DeviceHandler, DeviceManager } from './indi.manager'
import { type GeographicCoordinate, localSiderealTime } from './location'
import { type Time, timeNow } from './time'

interface AlpacaDeviceState extends GeographicCoordinate, EquatorialCoordinate {
	// Device
	tasks: Partial<Record<'connect' | 'position', ReturnType<typeof promiseWithTimeout>>>
	// Camera
	data?: string
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

interface AlpacaRegisteredDevice<D extends Device = Device> {
	readonly device: D
	readonly configuredDevice: AlpacaConfiguredDevice
	readonly state: AlpacaDeviceState
}

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

export class AlpacaServer {
	private server?: Bun.Server<undefined>
	private readonly Camera = new Map<Device, AlpacaRegisteredDevice<Camera>>()
	private readonly Telescope = new Map<Device, AlpacaRegisteredDevice<Mount>>()
	private readonly Focuser = new Map<Device, AlpacaRegisteredDevice<Focuser>>()
	private readonly FilterWheel = new Map<Device, AlpacaRegisteredDevice<Wheel>>()
	private readonly Rotator = new Map<Device, AlpacaRegisteredDevice<Rotator>>()
	private readonly Dome = new Map<Device, AlpacaRegisteredDevice<Device>>()
	private readonly Switch = new Map<Device, AlpacaRegisteredDevice<Device>>()
	private readonly CoverCalibrator = new Map<Device, AlpacaRegisteredDevice<Cover | FlatPanel>>()
	private readonly ObservingConditions = new Map<Device, AlpacaRegisteredDevice<Device>>()
	private readonly SafetyMonitor = new Map<Device, AlpacaRegisteredDevice<Device>>()
	private readonly Video = new Map<Device, AlpacaRegisteredDevice<Device>>()

	private readonly deviceManager: DeviceManager<Device>
	private readonly deviceNumberProvider: AlpacaDeviceNumberProvider
	private timer?: NodeJS.Timeout

	private readonly cameraHandler: DeviceHandler<Camera> = {
		added: (device: Camera) => {
			console.info('camera added:', device.name)
			this.makeConfiguredDeviceFromDevice(device, 'Camera')
		},
		updated: (device, property) => {
			if (property === 'connected') {
				this.handleConnectedEvent(device, 'Camera')
			} else if (property === 'frame') {
				const { frame } = this.camera(device).state
				frame[0] = device.frame.x.value
				frame[1] = device.frame.y.value
				frame[2] = device.frame.width.value
				frame[3] = device.frame.height.value
			}
		},
		removed: (device: Camera) => {
			console.info('camera removed:', device.name)
			this.Camera.delete(device)
		},
		blobReceived: (device, data) => {
			const { state } = this.camera(device)

			// Has the capture started?
			if (state.lastExposureDuration) {
				// console.info('camera image received', device.name, data.length)
				state.data = data
			}
		},
	}

	private readonly wheelHandler: DeviceHandler<Wheel> = {
		added: (device: Wheel) => {
			console.info('wheel added:', device.name)
			this.makeConfiguredDeviceFromDevice(device, 'FilterWheel')
		},
		updated: (device, property) => {
			if (property === 'connected') {
				this.handleConnectedEvent(device, 'FilterWheel')
			} else if (property === 'position') {
				const { state } = this.FilterWheel.get(device)!
				const task = state.tasks.position

				task?.clear()
				task?.resolve(true)
			}
		},
		removed: (device: Wheel) => {
			console.info('wheel removed:', device.name)
			this.FilterWheel.delete(device)
		},
	}

	private readonly mountHandler: DeviceHandler<Mount> = {
		added: (device: Mount) => {
			console.info('mount added:', device.name)
			this.makeConfiguredDeviceFromDevice(device, 'Telescope')
		},
		updated: (device, property) => {
			if (property === 'connected') {
				this.handleConnectedEvent(device, 'Telescope')
			} else if (property === 'geographicCoordinate') {
				Object.assign(this.Telescope.get(device)!.state, device.geographicCoordinate)
			}
		},
		removed: (device: Mount) => {
			console.info('mount removed:', device.name)
			this.Telescope.delete(device)
		},
	}

	private readonly focuserHandler: DeviceHandler<Focuser> = {
		added: (device: Focuser) => {
			console.info('focuser added:', device.name)
			this.makeConfiguredDeviceFromDevice(device, 'Focuser')
		},
		updated: (device, property) => {
			if (property === 'connected') {
				this.handleConnectedEvent(device, 'Focuser')
			}
		},
		removed: (device: Focuser) => {
			console.info('focuser removed:', device.name)
			this.Focuser.delete(device)
		},
	}

	private readonly coverHandler: DeviceHandler<Cover> = {
		added: (device: Cover) => {
			console.info('cover added:', device.name)
			this.makeConfiguredDeviceFromDevice(device, 'CoverCalibrator')
		},
		updated: (device, property) => {
			if (property === 'connected') {
				this.handleConnectedEvent(device, 'CoverCalibrator')
			}
		},
		removed: (device: Cover) => {
			console.info('cover removed:', device.name)
			this.CoverCalibrator.delete(device)
		},
	}

	private readonly flatPanelHandler: DeviceHandler<FlatPanel> = {
		added: (device: FlatPanel) => {
			console.info('flat panel added:', device.name)
			this.makeConfiguredDeviceFromDevice(device, 'CoverCalibrator')
		},
		updated: (device, property) => {
			if (property === 'connected') {
				this.handleConnectedEvent(device, 'CoverCalibrator')
			}
		},
		removed: (device: FlatPanel) => {
			console.info('flat panel removed:', device.name)
			this.CoverCalibrator.delete(device)
		},
	}

	constructor(private readonly options: AlpacaServerOptions) {
		this.deviceManager = (options.camera ?? options.mount ?? options.focuser ?? options.wheel ?? options.flatPanel ?? options.cover ?? options.rotator) as unknown as DeviceManager<Device>

		if (!this.deviceManager) throw new Error('at least one device manager must be provided.')

		this.deviceNumberProvider = options.deviceNumberProvider ?? defaultDeviceNumberProvider
	}

	get port() {
		return this.server?.port ?? -1
	}

	get host() {
		return this.server?.hostname
	}

	get running() {
		return !!this.server
	}

	readonly routes: Readonly<Bun.Serve.Routes<undefined, string>> = {
		// https://ascom-standards.org/api/?urls.primaryName=ASCOM+Alpaca+Management+API
		'/management/apiversions': { GET: () => this.apiVersions() },
		'/management/v1/description': { GET: () => this.apiDescription() },
		'/management/v1/configureddevices': { GET: () => makeAlpacaResponse(Array.from(this.configuredDevices())) },
		// https://ascom-standards.org/api/?urls.primaryName=ASCOM+Alpaca+Device+API
		// Device
		'/api/v1/:type/:id/interfaceversion': { GET: (req) => this.deviceGetInterfaceVersion(req.params.type as never) },
		'/api/v1/:type/:id/description': { GET: (req) => this.deviceGetDescription(+req.params.id, mapToAlpacaDeviceType(req.params.type)) },
		'/api/v1/:type/:id/name': { GET: (req) => this.deviceGetName(+req.params.id, mapToAlpacaDeviceType(req.params.type)) },
		'/api/v1/:type/:id/driverinfo': { GET: (req) => this.deviceGetDriverInfo(+req.params.id, mapToAlpacaDeviceType(req.params.type)) },
		'/api/v1/:type/:id/driverversion': { GET: (req) => this.deviceGetDriverVersion(+req.params.id, mapToAlpacaDeviceType(req.params.type)) },
		'/api/v1/:type/:id/connect': { PUT: (req) => this.deviceConnect(+req.params.id, mapToAlpacaDeviceType(req.params.type), { Connected: 'True' }) },
		'/api/v1/:type/:id/connected': { GET: (req) => this.deviceIsConnected(+req.params.id, mapToAlpacaDeviceType(req.params.type)), PUT: async (req) => this.deviceConnect(+req.params.id, mapToAlpacaDeviceType(req.params.type), await params(req)) },
		'/api/v1/:type/:id/connecting': { GET: (req) => this.deviceIsConnecting(+req.params.id, mapToAlpacaDeviceType(req.params.type)) },
		'/api/v1/:type/:id/disconnect': { PUT: (req) => this.deviceConnect(+req.params.id, mapToAlpacaDeviceType(req.params.type), { Connected: 'False' }) },
		'/api/v1/:type/:id/supportedactions': { GET: (req) => this.deviceGetSupportedActions(+req.params.id, mapToAlpacaDeviceType(req.params.type)) },
		'/api/v1/:type/:id/action': { PUT: async (req) => this.deviceAction(+req.params.id, mapToAlpacaDeviceType(req.params.type), await params(req)) },
		// Camera
		'/api/v1/camera/:id/bayeroffsetx': { GET: (req) => this.cameraGetBayerOffsetX(+req.params.id) },
		'/api/v1/camera/:id/bayeroffsety': { GET: (req) => this.cameraGetBayerOffsetY(+req.params.id) },
		'/api/v1/camera/:id/binx': { GET: (req) => this.cameraGetBinX(+req.params.id), PUT: async (req) => this.cameraSetBinX(+req.params.id, await params(req)) },
		'/api/v1/camera/:id/biny': { GET: (req) => this.cameraGetBinY(+req.params.id), PUT: async (req) => this.cameraSetBinY(+req.params.id, await params(req)) },
		'/api/v1/camera/:id/camerastate': { GET: (req) => this.cameraGetState(+req.params.id) },
		'/api/v1/camera/:id/cameraxsize': { GET: (req) => this.cameraGetXSize(+req.params.id) },
		'/api/v1/camera/:id/cameraysize': { GET: (req) => this.cameraGetYSize(+req.params.id) },
		'/api/v1/camera/:id/canabortexposure': { GET: (req) => this.cameraCanStopExposure(+req.params.id) },
		'/api/v1/camera/:id/canasymmetricbin': { GET: () => this.cameraCanAsymmetricBin() },
		'/api/v1/camera/:id/canfastreadout': { GET: () => this.cameraCanFastReadout() },
		'/api/v1/camera/:id/cangetcoolerpower': { GET: (req) => this.cameraCanGetCoolerPower(+req.params.id) },
		'/api/v1/camera/:id/canpulseguide': { GET: (req) => this.cameraCanPulseGuide(+req.params.id) },
		'/api/v1/camera/:id/cansetccdtemperature': { GET: (req) => this.cameraCanSetCCDTemperature(+req.params.id) },
		'/api/v1/camera/:id/canstopexposure': { GET: (req) => this.cameraCanStopExposure(+req.params.id) },
		'/api/v1/camera/:id/ccdtemperature': { GET: (req) => this.cameraGetCcdTemperature(+req.params.id) },
		'/api/v1/camera/:id/cooleron': { GET: (req) => this.cameraIsCoolerOn(+req.params.id), PUT: async (req) => this.cameraSetCoolerOn(+req.params.id, await params(req)) },
		'/api/v1/camera/:id/coolerpower': { GET: (req) => this.cameraGetCoolerPower(+req.params.id) },
		'/api/v1/camera/:id/devicestate': { GET: (req) => this.cameraGetDeviceState(+req.params.id) },
		'/api/v1/camera/:id/electronsperadu': { GET: () => this.cameraGetEletronsPerADU() },
		'/api/v1/camera/:id/exposuremax': { GET: (req) => this.cameraGetExposureMax(+req.params.id) },
		'/api/v1/camera/:id/exposuremin': { GET: (req) => this.cameraGetExposureMin(+req.params.id) },
		'/api/v1/camera/:id/exposureresolution': { GET: (req) => this.cameraGetExposureResolution() },
		'/api/v1/camera/:id/fastreadout': { GET: () => this.cameraIsFastReadout(), PUT: () => this.cameraSetFastReadout() },
		'/api/v1/camera/:id/fullwellcapacity': { GET: () => this.cameraGetFullwellCapacity() },
		'/api/v1/camera/:id/gain': { GET: (req) => this.cameraGetGain(+req.params.id), PUT: async (req) => this.cameraSetGain(+req.params.id, await params(req)) },
		'/api/v1/camera/:id/gainmax': { GET: (req) => this.cameraGetGainMax(+req.params.id) },
		'/api/v1/camera/:id/gainmin': { GET: (req) => this.cameraGetGainMin(+req.params.id) },
		'/api/v1/camera/:id/gains': { GET: () => this.cameraGetGains() },
		'/api/v1/camera/:id/hasshutter': { GET: () => this.cameraHasShutter() },
		'/api/v1/camera/:id/heatsinktemperature': { GET: (req) => this.cameraGetCcdTemperature(+req.params.id) },
		'/api/v1/camera/:id/imageready': { GET: (req) => this.cameraIsImageReady(+req.params.id) },
		'/api/v1/camera/:id/ispulseguiding': { GET: (req) => this.guideOutputIsPulseGuiding(+req.params.id, 'Camera') },
		'/api/v1/camera/:id/lastexposureduration': { GET: (req) => this.cameraGetLastExposureDuration(+req.params.id) },
		'/api/v1/camera/:id/maxadu': { GET: () => this.cameraGetMaxADU() },
		'/api/v1/camera/:id/maxbinx': { GET: (req) => this.cameraGetMaxBinX(+req.params.id) },
		'/api/v1/camera/:id/maxbiny': { GET: (req) => this.cameraGetMaxBinY(+req.params.id) },
		'/api/v1/camera/:id/numx': { GET: (req) => this.cameraGetNumX(+req.params.id), PUT: async (req) => this.cameraSetNumX(+req.params.id, await params(req)) },
		'/api/v1/camera/:id/numy': { GET: (req) => this.cameraGetNumY(+req.params.id), PUT: async (req) => this.cameraSetNumY(+req.params.id, await params(req)) },
		'/api/v1/camera/:id/offset': { GET: (req) => this.cameraGetOffset(+req.params.id), PUT: async (req) => this.cameraSetOffset(+req.params.id, await params(req)) },
		'/api/v1/camera/:id/offsetmax': { GET: (req) => this.cameraGetOffsetMax(+req.params.id) },
		'/api/v1/camera/:id/offsetmin': { GET: (req) => this.cameraGetOffsetMin(+req.params.id) },
		'/api/v1/camera/:id/offsets': { GET: () => this.cameraGetOffsets() },
		'/api/v1/camera/:id/percentcompleted': { GET: (req) => this.cameraGetPercentCompleted(+req.params.id) },
		'/api/v1/camera/:id/pixelsizex': { GET: (req) => this.cameraGetPixelSizeX(+req.params.id) },
		'/api/v1/camera/:id/pixelsizey': { GET: (req) => this.cameraGetPixelSizeY(+req.params.id) },
		'/api/v1/camera/:id/readoutmode': { GET: (req) => this.cameraGetReadoutMode(+req.params.id), PUT: async (req) => this.cameraSetReadoutMode(+req.params.id, await params(req)) },
		'/api/v1/camera/:id/readoutmodes': { GET: (req) => this.cameraGetReadoutModes(+req.params.id) },
		'/api/v1/camera/:id/sensorname': { GET: () => this.cameraGetSensorName() },
		'/api/v1/camera/:id/sensortype': { GET: (req) => this.cameraGetSensorType(+req.params.id) },
		'/api/v1/camera/:id/setccdtemperature': { GET: (req) => this.cameraGetSetCcdTemperature(+req.params.id), PUT: async (req) => this.cameraSetCcdTemperature(+req.params.id, await params(req)) },
		'/api/v1/camera/:id/startx': { GET: (req) => this.cameraGetStartX(+req.params.id), PUT: async (req) => this.cameraSetStartX(+req.params.id, await params(req)) },
		'/api/v1/camera/:id/starty': { GET: (req) => this.cameraGetStartY(+req.params.id), PUT: async (req) => this.cameraSetStartY(+req.params.id, await params(req)) },
		'/api/v1/camera/:id/abortexposure': { PUT: (req) => this.cameraStop(+req.params.id) },
		'/api/v1/camera/:id/pulseguide': { PUT: async (req) => this.guideOutputPulseGuide(+req.params.id, 'Camera', await params(req)) },
		'/api/v1/camera/:id/startexposure': { PUT: async (req) => this.cameraStart(+req.params.id, await params(req)) },
		'/api/v1/camera/:id/stopexposure': { PUT: (req) => this.cameraStop(+req.params.id) },
		'/api/v1/camera/:id/imagearray': { GET: (req) => this.cameraGetImageArray(+req.params.id, req.headers.get('accept')) },
		// Filter Wheel
		'/api/v1/filterwheel/:id/devicestate': { GET: (req) => this.wheelGetDeviceState(+req.params.id) },
		'/api/v1/filterwheel/:id/focusoffsets': { GET: (req) => this.wheelGetFocusOffsets(+req.params.id) },
		'/api/v1/filterwheel/:id/names': { GET: (req) => this.wheelGetNames(+req.params.id) },
		'/api/v1/filterwheel/:id/position': { GET: (req) => this.wheelGetPosition(+req.params.id), PUT: async (req) => this.wheelSetPosition(+req.params.id, await params(req)) },
		// Mount
		'/api/v1/telescope/:id/alignmentmode': { GET: () => this.mountGetAlignmentMode() },
		'/api/v1/telescope/:id/altitude': { GET: (req) => this.mountGetAltitude(+req.params.id) },
		'/api/v1/telescope/:id/aperturearea': { GET: () => this.mountGetApertureArea() },
		'/api/v1/telescope/:id/aperturediameter': { GET: () => this.mountGetApertureDiameter() },
		'/api/v1/telescope/:id/athome': { GET: (req) => this.mountIsAtHome(+req.params.id) },
		'/api/v1/telescope/:id/atpark': { GET: (req) => this.mountIsAtPark(+req.params.id) },
		'/api/v1/telescope/:id/azimuth': { GET: (req) => this.mountGetAzimuth(+req.params.id) },
		'/api/v1/telescope/:id/canfindhome': { GET: (req) => this.mountCanFindHome(+req.params.id) },
		'/api/v1/telescope/:id/canpark': { GET: (req) => this.mountCanPark(+req.params.id) },
		'/api/v1/telescope/:id/canpulseguide': { GET: (req) => this.mountCanPulseGuide(+req.params.id) },
		'/api/v1/telescope/:id/cansetdeclinationrate': { GET: (req) => this.mountCanSetDeclinationRate(+req.params.id) },
		'/api/v1/telescope/:id/cansetguiderates': { GET: (req) => this.mountCanSetGuideRates(+req.params.id) },
		'/api/v1/telescope/:id/cansetpark': { GET: (req) => this.mountCanSetPark(+req.params.id) },
		'/api/v1/telescope/:id/cansetpierside': { GET: (req) => this.mountCanSetPierSide(+req.params.id) },
		'/api/v1/telescope/:id/cansetrightascensionrate': { GET: (req) => this.mountCanSetRightAscensionRate(+req.params.id) },
		'/api/v1/telescope/:id/cansettracking': { GET: (req) => this.mountCanSetTracking(+req.params.id) },
		'/api/v1/telescope/:id/canslew': { GET: (req) => this.mountCanSlew(+req.params.id) },
		'/api/v1/telescope/:id/canslewaltaz': { GET: (req) => this.mountCanSlewAltAz(+req.params.id) },
		'/api/v1/telescope/:id/canslewaltazasync': { GET: (req) => this.mountCanSlewAltAzAsync(+req.params.id) },
		'/api/v1/telescope/:id/canslewasync': { GET: (req) => this.mountCanSlewAsync(+req.params.id) },
		'/api/v1/telescope/:id/cansync': { GET: (req) => this.mountCanSync(+req.params.id) },
		'/api/v1/telescope/:id/cansyncaltaz': { GET: (req) => this.mountCanSyncAltAz(+req.params.id) },
		'/api/v1/telescope/:id/canunpark': { GET: (req) => this.mountCanUnpark(+req.params.id) },
		'/api/v1/telescope/:id/declination': { GET: (req) => this.mountGetDeclination(+req.params.id) },
		'/api/v1/telescope/:id/declinationrate': { GET: (req) => this.mountGetDeclinationRate(+req.params.id), PUT: async (req) => this.mountSetDeclinationRate(+req.params.id, await params(req)) },
		'/api/v1/telescope/:id/devicestate': { GET: (req) => this.mountGetDeviceState(+req.params.id) },
		'/api/v1/telescope/:id/doesrefraction': { GET: (req) => this.mountGetDoesRefraction(+req.params.id), PUT: async (req) => this.mountSetDoesRefraction(+req.params.id, await params(req)) },
		'/api/v1/telescope/:id/equatorialsystem': { GET: (req) => this.mountGetEquatorialSystem() },
		'/api/v1/telescope/:id/focallength': { GET: () => this.mountGetFocalLength() },
		'/api/v1/telescope/:id/guideratedeclination': { GET: () => this.mountGetGuideRateDeclination(), PUT: async (req) => this.mountSetGuideRateDeclination(+req.params.id, await params(req)) },
		'/api/v1/telescope/:id/guideraterightascension': { GET: () => this.mountGetGuideRateRightAscension(), PUT: async (req) => this.mountSetGuideRateRightAscension(+req.params.id, await params(req)) },
		'/api/v1/telescope/:id/ispulseguiding': { GET: (req) => this.guideOutputIsPulseGuiding(+req.params.id, 'Telescope') },
		'/api/v1/telescope/:id/rightascension': { GET: (req) => this.mountGetRightAscension(+req.params.id) },
		'/api/v1/telescope/:id/rightascensionrate': { GET: (req) => this.mountGetRightAscensionRate(+req.params.id), PUT: async (req) => this.mountSetRightAscensionRate(+req.params.id, await params(req)) },
		'/api/v1/telescope/:id/sideofpier': { GET: (req) => this.mountGetSideOfPier(+req.params.id), PUT: async (req) => this.mountSetSideOfPier(+req.params.id, await params(req)) },
		'/api/v1/telescope/:id/siderealtime': { GET: (req) => this.mountGetSiderealTime(+req.params.id) },
		'/api/v1/telescope/:id/siteelevation': { GET: (req) => this.mountGetSiteElevation(+req.params.id), PUT: async (req) => this.mountSetSiteElevation(+req.params.id, await params(req)) },
		'/api/v1/telescope/:id/sitelatitude': { GET: (req) => this.mountGetSiteLatitude(+req.params.id), PUT: async (req) => this.mountSetSiteLatitude(+req.params.id, await params(req)) },
		'/api/v1/telescope/:id/sitelongitude': { GET: (req) => this.mountGetSiteLongitude(+req.params.id), PUT: async (req) => this.mountSetSiteLongitude(+req.params.id, await params(req)) },
		'/api/v1/telescope/:id/slewing': { GET: (req) => this.mountIsSlewing(+req.params.id) },
		'/api/v1/telescope/:id/slewsettletime': { GET: (req) => this.mountGetSlewSettleTime(+req.params.id), PUT: async (req) => this.mountSetSlewSettleTime(+req.params.id, await params(req)) },
		'/api/v1/telescope/:id/targetdeclination': { GET: (req) => this.mountGetTargetDeclination(+req.params.id), PUT: async (req) => this.mountSetTargetDeclination(+req.params.id, await params(req)) },
		'/api/v1/telescope/:id/targetrightascension': { GET: (req) => this.mountGetTargetRightAscension(+req.params.id), PUT: async (req) => this.mountSetTargetRightAscension(+req.params.id, await params(req)) },
		'/api/v1/telescope/:id/tracking': { GET: (req) => this.mountIsTracking(+req.params.id), PUT: async (req) => this.mountSetTracking(+req.params.id, await params(req)) },
		'/api/v1/telescope/:id/trackingrate': { GET: (req) => this.mountGetTrackingRate(+req.params.id), PUT: async (req) => this.mountSetTrackingRate(+req.params.id, await params(req)) },
		'/api/v1/telescope/:id/trackingrates': { GET: (req) => this.mountGetTrackingRates(+req.params.id) },
		'/api/v1/telescope/:id/utcdate': { GET: (req) => this.mountGetUTCDate(+req.params.id), PUT: async (req) => this.mountSetUTCDate(+req.params.id, await params(req)) },
		'/api/v1/telescope/:id/abortslew': { PUT: (req) => this.mountStop(+req.params.id) },
		'/api/v1/telescope/:id/axisrates': { GET: async (req) => this.mountGetAxisRates(+req.params.id, await params(req)) },
		'/api/v1/telescope/:id/canmoveaxis': { GET: async (req) => this.mountCanMoveAxis(+req.params.id, await params(req)) },
		'/api/v1/telescope/:id/destinationsideofpier': { GET: (req) => this.mountGetDestinationSideOfPier(+req.params.id) },
		'/api/v1/telescope/:id/findhome': { PUT: (req) => this.mountFindHome(+req.params.id) },
		'/api/v1/telescope/:id/moveaxis': { PUT: async (req) => this.mountMoveAxis(+req.params.id, await params(req)) },
		'/api/v1/telescope/:id/park': { PUT: (req) => this.mountPark(+req.params.id) },
		'/api/v1/telescope/:id/pulseguide': { PUT: async (req) => this.guideOutputPulseGuide(+req.params.id, 'Telescope', await params(req)) },
		'/api/v1/telescope/:id/setpark': { PUT: (req) => this.mountSetPark(+req.params.id) },
		'/api/v1/telescope/:id/slewtoaltaz': { PUT: async (req) => this.mountSlewToAltAz(+req.params.id, await params(req)) },
		'/api/v1/telescope/:id/slewtoaltazasync': { PUT: async (req) => this.mountSlewToAltAzAsync(+req.params.id, await params(req)) },
		'/api/v1/telescope/:id/slewtocoordinates': { PUT: async (req) => this.mountSlewToCoordinates(+req.params.id, await params(req)) },
		'/api/v1/telescope/:id/slewtocoordinatesasync': { PUT: async (req) => this.mountSlewToCoordinatesAsync(+req.params.id, await params(req)) },
		'/api/v1/telescope/:id/slewtotarget': { PUT: (req) => this.mountSlewToTarget(+req.params.id) },
		'/api/v1/telescope/:id/slewtotargetasync': { PUT: (req) => this.mountSlewToTargetAsync(+req.params.id) },
		'/api/v1/telescope/:id/synctoaltaz': { PUT: async (req) => this.mountSyncToAltAz(+req.params.id, await params(req)) },
		'/api/v1/telescope/:id/synctocoordinates': { PUT: async (req) => this.mountSyncToCoordinates(+req.params.id, await params(req)) },
		'/api/v1/telescope/:id/synctotarget': { PUT: (req) => this.mountSyncToTarget(+req.params.id) },
		'/api/v1/telescope/:id/unpark': { PUT: (req) => this.mountUnpark(+req.params.id) },
		// Focuser
		'/api/v1/focuser/:id/absolute': { GET: (req) => this.focuserCanAbsolute(+req.params.id) },
		'/api/v1/focuser/:id/devicestate': { GET: (req) => this.focuserGetDeviceState(+req.params.id) },
		'/api/v1/focuser/:id/ismoving': { GET: (req) => this.focuserIsMoving(+req.params.id) },
		'/api/v1/focuser/:id/maxincrement': { GET: (req) => this.focuserGetMaxIncrement(+req.params.id) },
		'/api/v1/focuser/:id/maxstep': { GET: (req) => this.focuserGetMaxStep(+req.params.id) },
		'/api/v1/focuser/:id/position': { GET: (req) => this.focuserGetPosition(+req.params.id) },
		'/api/v1/focuser/:id/stepsize': { GET: () => this.focuserGetStepSize() },
		'/api/v1/focuser/:id/tempcomp': { GET: () => this.focuserGetTempComp(), PUT: () => this.focuserSetTempComp() },
		'/api/v1/focuser/:id/tempcompavailable': { GET: () => this.focuserGetTempCompAvailable() },
		'/api/v1/focuser/:id/temperature': { GET: (req) => this.focuserGetTemperature(+req.params.id) },
		'/api/v1/focuser/:id/halt': { PUT: (req) => this.focuserHalt(+req.params.id) },
		'/api/v1/focuser/:id/move': { PUT: async (req) => this.focuserMove(+req.params.id, await params(req)) },
		// Cover Calibrator
		'/api/v1/covercalibrator/:id/brightness': { GET: (req) => this.coverCalibratorGetBrightness(+req.params.id) },
		'/api/v1/covercalibrator/:id/calibratorchanging': { GET: () => this.coverCalibratorIsChanging() },
		'/api/v1/covercalibrator/:id/calibratorstate': { GET: (req) => this.coverCalibratorGetCalibratorState(+req.params.id) },
		'/api/v1/covercalibrator/:id/covermoving': { GET: (req) => this.coverCalibratorIsMoving(+req.params.id) },
		'/api/v1/covercalibrator/:id/coverstate': { GET: (req) => this.coverCalibratorGetCoverState(+req.params.id) },
		'/api/v1/covercalibrator/:id/devicestate': { GET: (req) => this.coverCalibratorGetDeviceState(+req.params.id) },
		'/api/v1/covercalibrator/:id/maxbrightness': { GET: (req) => this.coverCalibratorGetMaxBrightness(+req.params.id) },
		'/api/v1/covercalibrator/:id/calibratoroff': { PUT: (req) => this.coverCalibratorOff(+req.params.id) },
		'/api/v1/covercalibrator/:id/calibratoron': { PUT: async (req) => this.coverCalibratorOn(+req.params.id, await params(req)) },
		'/api/v1/covercalibrator/:id/closecover': { PUT: (req) => this.coverCalibratorClose(+req.params.id) },
		'/api/v1/covercalibrator/:id/haltcover': { PUT: (req) => this.coverCalibratorHalt(+req.params.id) },
		'/api/v1/covercalibrator/:id/opencover': { PUT: (req) => this.coverCalibratorOpen(+req.params.id) },
	}

	start(hostname: string = '0.0.0.0', port: number = 0, options?: AlpacaServerStartOptions) {
		if (this.server) return false

		this.server = Bun.serve({
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

	listen() {
		this.options.camera?.addHandler(this.cameraHandler)
		this.options.wheel?.addHandler(this.wheelHandler)
		this.options.mount?.addHandler(this.mountHandler)
		this.options.focuser?.addHandler(this.focuserHandler)
		this.options.cover?.addHandler(this.coverHandler)
		this.options.flatPanel?.addHandler(this.flatPanelHandler)

		this.configuredDevices()

		clearInterval(this.timer)
		this.timer = setInterval(() => this.tick(), 30000)
		this.tick()
	}

	unlisten() {
		this.options.camera?.removeHandler(this.cameraHandler)
		this.options.wheel?.removeHandler(this.wheelHandler)
		this.options.mount?.removeHandler(this.mountHandler)
		this.options.focuser?.removeHandler(this.focuserHandler)
		this.options.cover?.removeHandler(this.coverHandler)
		this.options.flatPanel?.removeHandler(this.flatPanelHandler)

		this.Camera.clear()
		this.Telescope.clear()
		this.FilterWheel.clear()
		this.Focuser.clear()
		this.Rotator.clear()
		this.CoverCalibrator.clear()
		// this.Dome.clear()
		// this.Switch.clear()
		// this.ObservingConditions.clear()
		// this.SafetyMonitor.clear()
		// this.Video.clear()

		clearInterval(this.timer)
		this.timer = undefined
	}

	stop() {
		if (this.server) {
			this.server.stop(true)
			this.server = undefined
		}

		this.unlisten()
	}

	private tick() {
		// Mount
		const time = timeNow(true)

		for (const { state } of this.Telescope.values()) {
			state.time = time
			state.lst = localSiderealTime(time, state, false) // Apparent LST
		}
	}

	private device<D extends Device>(key: Device | number, type: AlpacaDeviceType, deviceType?: DeviceType): AlpacaRegisteredDevice<D> {
		if (typeof key === 'object') return this[type].get(key)! as never
		else for (const item of this[type].values()) if (item.configuredDevice.DeviceNumber === key && (!deviceType || item.device.type === deviceType)) return item as never
		return undefined as never
	}

	private camera(key: Device | number) {
		return this.device<Camera>(key, 'Camera')
	}

	private telescope(key: Device | number) {
		return this.device<Mount>(key, 'Telescope')
	}

	private wheel(key: Device | number) {
		return this.device<Wheel>(key, 'FilterWheel')
	}

	private focuser(key: Device | number) {
		return this.device<Focuser>(key, 'Focuser')
	}

	private cover(key: Device | number) {
		return this.device<Cover>(key, 'CoverCalibrator', 'COVER')
	}

	private flatPanel(key: Device | number) {
		return this.device<FlatPanel>(key, 'CoverCalibrator', 'FLAT_PANEL')
	}

	private guideOutput(key: Device | number, type: 'Camera' | 'Telescope') {
		return this.device<GuideOutput>(key, type)
	}

	private handleConnectedEvent(device: Device, type: AlpacaDeviceType) {
		const task = this.device(device, type).state.tasks.connect

		if (task?.running) {
			task.clear()

			// wait for all properties to be received
			if (device.connected) {
				console.info('device connected:', device.name)

				Bun.sleep(500).then(() => {
					task.resolve(device.connected)
				})
			} else {
				console.info('device disconnected:', device.name)
				task.resolve(true)
			}
		}
	}

	// Management API

	private apiVersions() {
		return makeAlpacaResponse([1])
	}

	private apiDescription() {
		return makeAlpacaResponse<AlpacaServerDescription>({ ServerName: this.options.name || 'Nebulosa', Manufacturer: this.options.manufacturer || 'Tiago Melo', ManufacturerVersion: this.options.version || '1.0.0', Location: 'None' })
	}

	configuredDevices() {
		const deviceNumbers = new Set<string>()
		const configuredDevices = new Set<AlpacaConfiguredDevice>()

		const add = (device: Device, type: AlpacaDeviceType) => {
			const { configuredDevice } = this.makeConfiguredDeviceFromDevice(device, type)
			const key = `${type}.${configuredDevice.DeviceNumber}`

			if (!deviceNumbers.has(key)) {
				configuredDevices.add(configuredDevice)
				deviceNumbers.add(key)
			}
		}

		this.options.camera?.list().forEach((e) => add(e, 'Camera'))
		this.options.mount?.list().forEach((e) => add(e, 'Telescope'))
		this.options.focuser?.list().forEach((e) => add(e, 'Focuser'))
		this.options.wheel?.list().forEach((e) => add(e, 'FilterWheel'))
		this.options.rotator?.list().forEach((e) => add(e, 'Rotator'))
		this.options.flatPanel?.list().forEach((e) => add(e, 'CoverCalibrator'))
		this.options.cover?.list().forEach((e) => add(e, 'CoverCalibrator'))

		return configuredDevices
	}

	// Device API

	private deviceGetInterfaceVersion(type: AlpacaDeviceType) {
		const version = type === 'Camera' || type === 'Focuser' || type === 'Rotator' || type === 'Telescope' ? 4 : type === 'Dome' || type === 'FilterWheel' || type === 'SafetyMonitor' || type === 'Switch' ? 3 : 2
		return makeAlpacaResponse(version)
	}

	private deviceGetDescription(id: number, type: AlpacaDeviceType) {
		return makeAlpacaResponse(this.device(id, type).device.name)
	}

	private deviceGetName(id: number, type: AlpacaDeviceType) {
		return makeAlpacaResponse(this.device(id, type).device.name)
	}

	private deviceGetDriverInfo(id: number, type: AlpacaDeviceType) {
		return makeAlpacaResponse(this.device(id, type).device.driver.executable)
	}

	private deviceGetDriverVersion(id: number, type: AlpacaDeviceType) {
		return makeAlpacaResponse(this.device(id, type).device.driver.version)
	}

	private async deviceConnect(id: number, type: AlpacaDeviceType, data: { Connected: string }) {
		const { state, device } = this.device(id, type)

		if (!device) return makeAlpacaErrorResponse(AlpacaException.InvalidOperation, 'Device is not present')

		if (state.tasks.connect?.running) {
			return await state.tasks.connect.promise.then(makeResponseForTask)
		}

		const connect = isTrue(data.Connected)

		if (connect !== device.connected) {
			const task = promiseWithTimeout(AlpacaException.NotConnected, `Unable to connect to ${device.name}`, 10000)

			state.tasks.connect = task

			console.info(connect ? 'device connecting:' : 'device disconnecting:', device.name)

			if (connect) this.deviceManager.connect(device as never)
			else this.deviceManager.disconnect(device as never)

			return await task.promise.then(makeResponseForTask)
		}

		return makeResponseForTask(true)
	}

	private deviceIsConnected(id: number, type: AlpacaDeviceType) {
		return makeAlpacaResponse(!!this.device(id, type)?.device.connected)
	}

	private deviceIsConnecting(id: number, type: AlpacaDeviceType) {
		return makeAlpacaResponse(!!this.device(id, type).state.tasks.connect?.running)
	}

	private deviceGetSupportedActions(id: number, type: AlpacaDeviceType) {
		const { device } = this.device(id, type)

		if (isFocuser(device)) {
			return makeAlpacaResponse(SUPPORTED_FOCUSER_ACTIONS)
		} else if (isWheel(device)) {
			return makeAlpacaResponse(SUPPORTED_WHEEL_ACTIONS)
		}

		return makeAlpacaResponse([])
	}

	private deviceAction(id: number, type: AlpacaDeviceType, data: { Action: string; Parameters: string }) {
		const { device } = this.device(id, type)
		const action = data.Action.toLowerCase() as Lowercase<AlpacaFocuserAction | AlpacaWheelAction>

		if (isFocuser(device)) {
			if (action === 'togglereverse') return this.focuserToggleReverse(device)
		}

		return makeAlpacaErrorResponse(AlpacaException.ActionNotImplemented, 'Unknown action')
	}

	// Guide Output API

	private guideOutputPulseGuide(id: number, type: 'Camera' | 'Telescope', data: { Duration: string; Direction: string }) {
		this.options.guideOutput?.pulse(this.guideOutput(id, type).device, mapAlpacaEnumToGuideDirection(+data.Direction), +data.Duration)
		return makeAlpacaResponse(undefined)
	}

	private guideOutputIsPulseGuiding(id: number, type: 'Camera' | 'Telescope') {
		return makeAlpacaResponse(this.guideOutput(id, type).device.pulsing)
	}

	// Camera API

	private cameraGetBayerOffsetX(id: number) {
		return makeAlpacaResponse(this.camera(id).device.cfa.offsetX)
	}

	private cameraGetBayerOffsetY(id: number) {
		return makeAlpacaResponse(this.camera(id).device.cfa.offsetY)
	}

	private cameraGetBinX(id: number) {
		return makeAlpacaResponse(this.camera(id).device.bin.x.value)
	}

	private cameraSetBinX(id: number, data: { BinX: string }) {
		return this.cameraSetBin(id, data)
	}

	private cameraGetBinY(id: number) {
		return makeAlpacaResponse(this.camera(id).device.bin.y.value)
	}

	private cameraSetBinY(id: number, data: { BinY: string }) {
		return this.cameraSetBin(id, data)
	}

	private cameraSetBin(id: number, data: { BinX?: string; BinY?: string }) {
		const bin = +(data.BinX || data.BinY || 1)
		this.options.camera?.bin(this.camera(id).device, bin, bin)
		return makeAlpacaResponse(undefined)
	}

	// https://ascom-standards.org/newdocs/camera.html#Camera.CameraStates
	private cameraGetState(id: number) {
		return makeAlpacaResponse(this.camera(id).device.exposuring ? AlpacaCameraState.Exposing : AlpacaCameraState.Idle)
	}

	private cameraGetXSize(id: number) {
		return makeAlpacaResponse(this.camera(id).device.frame.width.value)
	}

	private cameraGetYSize(id: number) {
		return makeAlpacaResponse(this.camera(id).device.frame.height.value)
	}

	private cameraCanStopExposure(id: number) {
		return makeAlpacaResponse(this.camera(id).device.canAbort)
	}

	private cameraCanAsymmetricBin() {
		return makeAlpacaResponse(false)
	}

	private cameraCanFastReadout() {
		return makeAlpacaResponse(false)
	}

	private cameraCanGetCoolerPower(id: number) {
		return makeAlpacaResponse(this.camera(id).device.hasCoolerControl)
	}

	private cameraCanPulseGuide(id: number) {
		return makeAlpacaResponse(this.camera(id).device.canPulseGuide)
	}

	private cameraCanSetCCDTemperature(id: number) {
		return makeAlpacaResponse(this.camera(id).device.canSetTemperature)
	}

	private cameraGetCcdTemperature(id: number) {
		return makeAlpacaResponse(this.camera(id).device.temperature)
	}

	private cameraIsCoolerOn(id: number) {
		return makeAlpacaResponse(this.camera(id).device.cooler)
	}

	private cameraSetCoolerOn(id: number, data: { CoolerOn: string }) {
		this.options.camera?.cooler(this.camera(id).device, isTrue(data.CoolerOn))
		return makeAlpacaResponse(undefined)
	}

	private cameraGetCoolerPower(id: number) {
		return makeAlpacaResponse(this.camera(id).device.coolerPower)
	}

	private cameraGetDeviceState(id: number) {
		const { state, device } = this.camera(id)
		const res = new Array<AlpacaStateItem>(8)
		res[0] = { Name: 'CameraState', Value: device.exposuring ? AlpacaCameraState.Exposing : AlpacaCameraState.Idle }
		res[1] = { Name: 'CCDTemperature', Value: device.temperature }
		res[2] = { Name: 'CoolerPower', Value: device.coolerPower }
		res[3] = { Name: 'HeatSinkTemperature', Value: device.temperature }
		res[4] = { Name: 'ImageReady', Value: !!state.data }
		res[5] = { Name: 'IsPulseGuiding', Value: device.pulsing }
		res[6] = { Name: 'PercentCompleted', Value: state.lastExposureDuration === 0 ? 0 : (1 - device.exposure.value / state.lastExposureDuration) * 100 }
		res[7] = { Name: 'TimeStamp', Value: '' }
		return makeAlpacaResponse(res)
	}

	private cameraGetEletronsPerADU() {
		return makeAlpacaResponse(1)
	}

	private cameraGetExposureMax(id: number) {
		return makeAlpacaResponse(this.camera(id).device.exposure.max)
	}

	private cameraGetExposureMin(id: number) {
		return makeAlpacaResponse(this.camera(id).device.exposure.min)
	}

	private cameraGetExposureResolution() {
		return makeAlpacaResponse(1e-6)
	}

	private cameraIsFastReadout() {
		return makeAlpacaResponse(false)
	}

	private cameraSetFastReadout() {
		return makeAlpacaResponse(undefined)
	}

	private cameraGetFullwellCapacity() {
		return makeAlpacaResponse(65535)
	}

	private cameraGetGain(id: number) {
		return makeAlpacaResponse(this.camera(id).device.gain.value)
	}

	private cameraSetGain(id: number, data: { Gain: string }) {
		this.options.camera?.gain(this.camera(id).device, +data.Gain)
		return makeAlpacaResponse(undefined)
	}

	private cameraGetGainMax(id: number) {
		return makeAlpacaResponse(this.camera(id).device.gain.max)
	}

	private cameraGetGainMin(id: number) {
		return makeAlpacaResponse(this.camera(id).device.gain.min)
	}

	private cameraGetGains() {
		return makeAlpacaResponse([], AlpacaException.MethodNotImplemented, 'Gain modes is not supported')
	}

	private cameraHasShutter() {
		return makeAlpacaResponse(false)
	}

	private cameraIsImageReady(id: number) {
		return makeAlpacaResponse(this.camera(id).state.data !== undefined)
	}

	private cameraGetLastExposureDuration(id: number) {
		return makeAlpacaResponse(this.camera(id).state.lastExposureDuration)
	}

	private cameraGetMaxADU() {
		return makeAlpacaResponse(65535)
	}

	private cameraGetMaxBinX(id: number) {
		return makeAlpacaResponse(this.camera(id).device.bin.x.max)
	}

	private cameraGetMaxBinY(id: number) {
		return makeAlpacaResponse(this.camera(id).device.bin.y.max)
	}

	private cameraSetFrame(id: number, data: { NumX?: string; NumY?: string; StartX?: string; StartY?: string }) {
		const { state, device } = this.camera(id)
		const { frame } = state
		if (data.StartX) frame[0] = +data.StartX
		if (data.StartY) frame[1] = +data.StartY
		if (data.NumX) frame[2] = +data.NumX
		if (data.NumY) frame[3] = +data.NumY
		this.options.camera?.frame(device, ...frame)
		return makeAlpacaResponse(undefined)
	}

	private cameraGetNumX(id: number) {
		return makeAlpacaResponse(this.camera(id).device.frame.width.value)
	}

	private cameraSetNumX(id: number, data: { NumX: string }) {
		return this.cameraSetFrame(id, data)
	}

	private cameraGetNumY(id: number) {
		return makeAlpacaResponse(this.camera(id).device.frame.height.value)
	}

	private cameraSetNumY(id: number, data: { NumY: string }) {
		return this.cameraSetFrame(id, data)
	}

	private cameraGetOffset(id: number) {
		return makeAlpacaResponse(this.camera(id).device.offset.value)
	}

	private cameraSetOffset(id: number, data: { Offset: string }) {
		this.options.camera?.offset(this.camera(id).device, +data.Offset)
		return makeAlpacaResponse(undefined)
	}

	private cameraGetOffsetMax(id: number) {
		return makeAlpacaResponse(this.camera(id).device.offset.max)
	}

	private cameraGetOffsetMin(id: number) {
		return makeAlpacaResponse(this.camera(id).device.offset.min)
	}

	private cameraGetOffsets() {
		return makeAlpacaResponse([], AlpacaException.MethodNotImplemented, 'Offset modes is not supported')
	}

	private cameraGetPercentCompleted(id: number) {
		const { state, device } = this.camera(id)
		return makeAlpacaResponse(state.lastExposureDuration === 0 ? 0 : (1 - device.exposure.value / state.lastExposureDuration) * 100)
	}

	private cameraGetPixelSizeX(id: number) {
		return makeAlpacaResponse(this.camera(id).device.pixelSize.x)
	}

	private cameraGetPixelSizeY(id: number) {
		return makeAlpacaResponse(this.camera(id).device.pixelSize.y)
	}

	private cameraGetReadoutMode(id: number) {
		return makeAlpacaResponse(this.camera(id).device.frameFormat)
	}

	private cameraSetReadoutMode(id: number, data: { ReadoutMode: string }) {
		const { device } = this.camera(id)
		const mode = +data.ReadoutMode

		if (Number.isFinite(mode) && mode >= 0 && mode < device.frameFormats.length) {
			this.options.camera?.frameFormat(device, device.frameFormats[mode])
		} else if (device.frameFormats.includes(data.ReadoutMode)) {
			this.options.camera?.frameFormat(device, data.ReadoutMode)
		} else {
			console.warn('invalid readout mode:', data.ReadoutMode)
		}

		return makeAlpacaResponse(undefined)
	}

	private cameraGetReadoutModes(id: number) {
		return makeAlpacaResponse(this.camera(id).device.frameFormats)
	}

	private cameraGetSensorName() {
		return makeAlpacaResponse('')
	}

	// https://ascom-standards.org/newdocs/camera.html#Camera.SensrType
	private cameraGetSensorType(id: number) {
		return makeAlpacaResponse(this.camera(id).device.cfa.type ? 2 : 0)
	}

	private cameraGetSetCcdTemperature(id: number) {
		return makeAlpacaResponse(this.camera(id).state.ccdTemperature)
	}

	private cameraSetCcdTemperature(id: number, data: { SetCCDTemperature: string }) {
		const { state, device } = this.camera(id)
		state.ccdTemperature = +data.SetCCDTemperature
		this.options.camera?.temperature(device, state.ccdTemperature)
		return makeAlpacaResponse(this.camera(id).device.temperature)
	}

	private cameraGetStartX(id: number) {
		return makeAlpacaResponse(this.camera(id).device.frame.x.value)
	}

	private cameraSetStartX(id: number, data: { StartX: string }) {
		return this.cameraSetFrame(id, data)
	}

	private cameraGetStartY(id: number) {
		return makeAlpacaResponse(this.camera(id).device.frame.y.value)
	}

	private cameraSetStartY(id: number, data: { StartY: string }) {
		return this.cameraSetFrame(id, data)
	}

	private cameraStop(id: number) {
		const { device } = this.camera(id)
		this.options.camera?.stopExposure(device)
		this.options.camera?.disableBlob(device)
		return makeAlpacaResponse(undefined)
	}

	private cameraStart(id: number, data: { Duration: string; Light: string }) {
		const { device, state } = this.camera(id)
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

	private cameraGetImageArray(id: number, accept?: string | null) {
		const { state, device } = this.camera(id)

		try {
			if (accept?.includes('imagebytes')) {
				// const data = Buffer.from(await Bun.file('c:\\Users\\tiago\\Documents\\Nebulosa\\Captures\\SVBONY CCD SV305.fit').arrayBuffer())
				const image = makeImageBytesFromFits(Buffer.from(state.data!, 'base64'))
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

	private wheelGetDeviceState(id: number) {
		const { device } = this.wheel(id)
		const res = new Array<AlpacaStateItem>(2)
		res[0] = { Name: 'Position', Value: device.position }
		res[1] = { Name: 'TimeStamp', Value: '' }
		return makeAlpacaResponse(res)
	}

	private wheelGetFocusOffsets(id: number) {
		const offsets = new Array<number>(this.wheel(id).device.count)
		for (let i = 0; i < offsets.length; i++) offsets[i] = 0
		return makeAlpacaResponse(offsets)
	}

	private wheelGetNames(id: number) {
		const names = new Array<string>(this.wheel(id).device.count)
		for (let i = 0; i < names.length; i++) names[i] = `Filter ${i + 1}`
		return makeAlpacaResponse(names)
	}

	private wheelGetPosition(id: number) {
		const { device } = this.wheel(id)
		return makeAlpacaResponse(device.moving ? -1 : device.position)
	}

	private async wheelSetPosition(id: number, data: { Position: string }) {
		const { state, device } = this.wheel(id)
		state.position = +data.Position
		const task = promiseWithTimeout(AlpacaException.ValueNotSet, 'Unable to set wheel position')
		state.tasks.position = task
		this.options.wheel?.moveTo(device, state.position)
		return await task.promise.then(makeResponseForTask)
	}

	// Telescope API

	// https://ascom-standards.org/newdocs/telescope.html#Telescope.AlignmentModes
	private mountGetAlignmentMode() {
		return makeAlpacaResponse(2) // TODO: INDI doesn't support it
	}

	private mountGetAltitude(id: number) {
		const { state, device } = this.telescope(id)
		const [, altitude] = equatorialToHorizontal(device.equatorialCoordinate.rightAscension, device.equatorialCoordinate.declination, state.latitude, state.lst)
		return makeAlpacaResponse(toHour(altitude))
	}

	private mountGetApertureArea() {
		return makeAlpacaErrorResponse(AlpacaException.PropertyNotImplemented, 'Telescope does not have aperture area')
	}

	private mountGetApertureDiameter() {
		return makeAlpacaErrorResponse(AlpacaException.PropertyNotImplemented, 'Telescope does not have aperture diameter')
	}

	private mountIsAtHome(id: number) {
		return makeAlpacaResponse(false) // TODO: INDI doesn't support it?
	}

	private mountIsAtPark(id: number) {
		return makeAlpacaResponse(this.telescope(id).device.parked)
	}

	private mountGetAzimuth(id: number) {
		const { state, device } = this.telescope(id)
		const [azimuth] = equatorialToHorizontal(device.equatorialCoordinate.rightAscension, device.equatorialCoordinate.declination, state.latitude, state.lst)
		return makeAlpacaResponse(toHour(azimuth))
	}

	private mountCanFindHome(id: number) {
		return makeAlpacaResponse(this.telescope(id).device.canFindHome)
	}

	private mountCanPark(id: number) {
		return makeAlpacaResponse(this.telescope(id).device.canPark)
	}

	private mountCanPulseGuide(id: number) {
		return makeAlpacaResponse(this.telescope(id).device.canPulseGuide)
	}

	private mountCanSetDeclinationRate(id: number) {
		return makeAlpacaResponse(false) // TODO: INDI doesn't support it?
	}

	private mountCanSetGuideRates(id: number) {
		return makeAlpacaResponse(false) // TODO: INDI doesn't support it?
	}

	private mountCanSetPark(id: number) {
		return makeAlpacaResponse(this.telescope(id).device.canSetPark)
	}

	private mountCanSetPierSide(id: number) {
		return makeAlpacaResponse(false) // TODO: INDI doesn't support it!
	}

	private mountCanSetRightAscensionRate(id: number) {
		return makeAlpacaResponse(false) // TODO: INDI doesn't support it?
	}

	private mountCanSetTracking(id: number) {
		return makeAlpacaResponse(this.telescope(id).device.canTracking)
	}

	private mountCanSlew(id: number) {
		return makeAlpacaResponse(this.telescope(id).device.canGoTo)
	}

	private mountCanSlewAltAz(id: number) {
		return this.mountCanSlew(id)
	}

	private mountCanSlewAltAzAsync(id: number) {
		return this.mountCanSlewAltAz(id)
	}

	private mountCanSlewAsync(id: number) {
		return this.mountCanSlew(id)
	}

	private mountCanSync(id: number) {
		return makeAlpacaResponse(this.telescope(id).device.canSync)
	}

	private mountCanSyncAltAz(id: number) {
		return this.mountCanSync(id)
	}

	private mountCanUnpark(id: number) {
		return this.mountCanPark(id)
	}

	private mountGetDeclination(id: number) {
		return makeAlpacaResponse(toDeg(this.telescope(id).device.equatorialCoordinate.declination))
	}

	private mountGetDeclinationRate(id: number) {
		return makeAlpacaErrorResponse(AlpacaException.MethodNotImplemented, 'Telescope does not have declination rate')
	}

	private mountSetDeclinationRate(id: number, data: { DeclinationRate: string }) {
		return makeAlpacaErrorResponse(AlpacaException.MethodNotImplemented, 'Telescope does not have declination rate')
	}

	private mountGetDeviceState(id: number) {
		const { device } = this.telescope(id)
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

	private mountGetDoesRefraction(id: number) {
		return makeAlpacaResponse(this.telescope(id).state.doesRefraction)
	}

	private mountSetDoesRefraction(id: number, data: { DoesRefraction: string }) {
		this.telescope(id).state.doesRefraction = isTrue(data.DoesRefraction)
		return makeAlpacaResponse(undefined)
	}

	// https://ascom-standards.org/newdocs/telescope.html#Telescope.EquatorialCoordinateType
	private mountGetEquatorialSystem() {
		return makeAlpacaResponse(1) // Topocentric coordinates
	}

	private mountGetFocalLength() {
		return makeAlpacaErrorResponse(AlpacaException.PropertyNotImplemented, 'Telescope does not have focal length')
	}

	private mountGetGuideRateDeclination() {
		return makeAlpacaErrorResponse(AlpacaException.PropertyNotImplemented, 'Telescope does not have guide rate declination')
	}

	private mountSetGuideRateDeclination(id: number, data: { GuideRateDeclination: string }) {
		return makeAlpacaErrorResponse(AlpacaException.PropertyNotImplemented, 'Telescope does not have guide rate declination')
	}

	private mountGetGuideRateRightAscension() {
		return makeAlpacaErrorResponse(AlpacaException.PropertyNotImplemented, 'Telescope does not have guide rate right ascension')
	}

	private mountSetGuideRateRightAscension(id: number, data: { GuideRateRightAscension: string }) {
		return makeAlpacaErrorResponse(AlpacaException.PropertyNotImplemented, 'Telescope does not have guide rate right ascension')
	}

	private mountGetRightAscension(id: number) {
		return makeAlpacaResponse(toHour(this.telescope(id).device.equatorialCoordinate.rightAscension))
	}

	private mountGetRightAscensionRate(id: number) {
		return makeAlpacaErrorResponse(AlpacaException.MethodNotImplemented, 'Telescope does not have right ascension rate')
	}

	private mountSetRightAscensionRate(id: number, data: { RightAscensionRate: string }) {
		return makeAlpacaErrorResponse(AlpacaException.MethodNotImplemented, 'Telescope does not have right ascension rate')
	}

	// https://ascom-standards.org/newdocs/telescope.html#Telescope.PierSide
	private mountGetSideOfPier(id: number) {
		return makeAlpacaResponse(mapPierSideToAlpacaEnum(this.telescope(id).device.pierSide))
	}

	private mountSetSideOfPier(id: number, data: { SideOfPier: string }) {
		return makeAlpacaErrorResponse(AlpacaException.MethodNotImplemented, 'Telescope does not support set side of pier')
	}

	private mountGetSiderealTime(id: number) {
		return makeAlpacaResponse(toHour(this.telescope(id).state.lst))
	}

	private mountGetSiteElevation(id: number) {
		return makeAlpacaResponse(toMeter(this.telescope(id).device.geographicCoordinate.elevation))
	}

	private mountSetSiteElevation(id: number, data: { SiteElevation: string }) {
		const { state, device } = this.telescope(id)
		state.elevation = meter(+data.SiteElevation)
		this.options.mount?.geographicCoordinate(device, state)
		return makeAlpacaResponse(undefined)
	}

	private mountGetSiteLatitude(id: number) {
		return makeAlpacaResponse(toMeter(this.telescope(id).device.geographicCoordinate.elevation))
	}

	private mountSetSiteLatitude(id: number, data: { SiteLatitude: string }) {
		const { state, device } = this.telescope(id)
		state.latitude = deg(+data.SiteLatitude)
		this.options.mount?.geographicCoordinate(device, state)
		return makeAlpacaResponse(undefined)
	}

	private mountGetSiteLongitude(id: number) {
		return makeAlpacaResponse(toMeter(this.telescope(id).device.geographicCoordinate.elevation))
	}

	private mountSetSiteLongitude(id: number, data: { SiteLongitude: string }) {
		const { state, device } = this.telescope(id)
		state.longitude = deg(+data.SiteLongitude)
		this.options.mount?.geographicCoordinate(device, state)
		return makeAlpacaResponse(undefined)
	}

	private mountIsSlewing(id: number) {
		return makeAlpacaResponse(this.telescope(id).device.slewing)
	}

	private mountGetSlewSettleTime(id: number) {
		return makeAlpacaResponse(this.telescope(id).state.slewSettleTime)
	}

	private mountSetSlewSettleTime(id: number, data: { SlewSettleTime: string }) {
		const { state } = this.telescope(id)
		state.slewSettleTime = +data.SlewSettleTime
		return makeAlpacaResponse(undefined)
	}

	private mountGetTargetDeclination(id: number) {
		return makeAlpacaResponse(toDeg(this.telescope(id).state.declination))
	}

	private mountSetTargetDeclination(id: number, data: { TargetDeclination: string }) {
		this.telescope(id).state.declination = deg(+data.TargetDeclination)
		return makeAlpacaResponse(undefined)
	}

	private mountGetTargetRightAscension(id: number) {
		return makeAlpacaResponse(toHour(this.telescope(id).state.rightAscension))
	}

	private mountSetTargetRightAscension(id: number, data: { TargetRightAscension: string }) {
		this.telescope(id).state.rightAscension = hour(+data.TargetRightAscension)
		return makeAlpacaResponse(undefined)
	}

	private mountIsTracking(id: number) {
		return makeAlpacaResponse(this.telescope(id).device.tracking)
	}

	private mountSetTracking(id: number, data: { Tracking: string }) {
		this.options.mount?.tracking(this.telescope(id).device, isTrue(data.Tracking))
		return makeAlpacaResponse(undefined)
	}

	// https://ascom-standards.org/newdocs/telescope.html#Telescope.DriveRates
	private mountGetTrackingRate(id: number) {
		return makeAlpacaResponse(mapTrackModeToAlpacaEnum(this.telescope(id).device.trackMode))
	}

	private mountSetTrackingRate(id: number, data: { TrackingRate: string }) {
		this.options.mount?.trackMode(this.telescope(id).device, mapAlpacaEnumToTrackMode(+data.TrackingRate & 0xff))
		return makeAlpacaResponse(undefined)
	}

	private mountGetTrackingRates(id: number) {
		return makeAlpacaResponse(this.telescope(id).device.trackModes.map(mapTrackModeToAlpacaEnum))
	}

	private mountGetUTCDate(id: number) {
		return makeAlpacaResponse(new Date().toISOString())
	}

	private mountSetUTCDate(id: number, data: { UTCDate: string }) {
		const { device } = this.telescope(id)
		const utc = new Date(data.UTCDate).getTime()
		this.options.mount?.time(device, { utc, offset: device.time.offset })
		return makeAlpacaResponse(undefined)
	}

	private mountStop(id: number) {
		this.options.mount?.stop(this.telescope(id).device)
		return makeAlpacaResponse(undefined)
	}

	private mountGetAxisRates(id: number, data: { Axis: string }) {
		return makeAlpacaResponse(this.telescope(id).device.slewRates.map(mapSlewRateToAlpacaAxisRate))
	}

	private mountCanMoveAxis(id: number, data: { Axis: string }) {
		return makeAlpacaResponse(this.telescope(id).device.canMove)
	}

	private mountGetDestinationSideOfPier(id: number) {
		const { state, device } = this.telescope(id)
		const pierSide = expectedPierSide(device.equatorialCoordinate.rightAscension, device.equatorialCoordinate.declination, state.lst)
		return makeAlpacaResponse(mapPierSideToAlpacaEnum(pierSide))
	}

	private mountFindHome(id: number) {
		this.options.mount?.findHome(this.telescope(id).device)
		return makeAlpacaResponse(undefined)
	}

	private mountMoveAxis(id: number, data: { Axis: string; Rate: string }) {
		const rate = +data.Rate
		const isPrimaryAxis = +data.Axis === 0
		const { device } = this.telescope(id)

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

	private mountPark(id: number) {
		this.options.mount?.park(this.telescope(id).device)
		return makeAlpacaResponse(undefined)
	}

	private mountSetPark(id: number) {
		this.options.mount?.setPark(this.telescope(id).device)
		return makeAlpacaResponse(undefined)
	}

	private mountSlewToAltAz(id: number, data: { Azimuth: string; Altitude: string }) {
		return this.mountSlewToAltAzAsync(id, data)
	}

	private mountSlewToAltAzAsync(id: number, data: { Azimuth: string; Altitude: string }) {
		const { state, device } = this.telescope(id)
		const [rightAscension, declination] = observedToCirs(deg(+data.Azimuth), deg(+data.Altitude), state.time!, state, state.doesRefraction ? undefined : false)
		this.options.mount?.goTo(device, rightAscension, declination)
		return makeAlpacaResponse(undefined)
	}

	private mountSlewToCoordinates(id: number, data: { RightAscension: string | number; Declination: string | number }) {
		return this.mountSlewToCoordinatesAsync(id, data)
	}

	private mountSlewToCoordinatesAsync(id: number, data: { RightAscension: string | number; Declination: string | number }) {
		this.options.mount?.goTo(this.telescope(id).device, hour(+data.RightAscension), deg(+data.Declination))
		return makeAlpacaResponse(undefined)
	}

	private mountSlewToTarget(id: number) {
		return this.mountSlewToTargetAsync(id)
	}

	private mountSlewToTargetAsync(id: number) {
		const { state } = this.telescope(id)
		return this.mountSlewToCoordinatesAsync(id, { RightAscension: state.rightAscension, Declination: state.declination })
	}

	private mountSyncToAltAz(id: number, data: { Azimuth: string; Altitude: string }) {
		return makeAlpacaErrorResponse(AlpacaException.MethodNotImplemented, 'Telescope does not support slew alt/az') // TODO: Compute this!
	}

	private mountSyncToCoordinates(id: number, data: { RightAscension: string | number; Declination: string | number }) {
		this.options.mount?.syncTo(this.telescope(id).device, hour(+data.RightAscension), deg(+data.Declination))
		return makeAlpacaResponse(undefined)
	}

	private mountSyncToTarget(id: number) {
		const { state } = this.telescope(id)
		return this.mountSyncToCoordinates(id, { RightAscension: state.rightAscension, Declination: state.declination })
	}

	private mountUnpark(id: number) {
		this.options.mount?.unpark(this.telescope(id).device)
		return makeAlpacaResponse(undefined)
	}

	// Focuser

	private focuserCanAbsolute(id: number) {
		return makeAlpacaResponse(this.focuser(id).device.canAbsoluteMove)
	}

	private focuserGetDeviceState(id: number) {
		const { device } = this.focuser(id)
		const res = new Array<AlpacaStateItem>(4)
		res[0] = { Name: 'IsMoving', Value: device.moving }
		res[1] = { Name: 'Position', Value: device.canAbsoluteMove ? device.position.value : 0 }
		res[2] = { Name: 'Temperature', Value: device.temperature }
		res[3] = { Name: 'TimeStamp', Value: '' }
		return makeAlpacaResponse(res)
	}

	private focuserIsMoving(id: number) {
		return makeAlpacaResponse(this.focuser(id).device.moving)
	}

	private focuserGetMaxIncrement(id: number) {
		return this.focuserGetMaxStep(id)
	}

	private focuserGetMaxStep(id: number) {
		return makeAlpacaResponse(this.focuser(id).device.position.max)
	}

	private focuserGetPosition(id: number) {
		return makeAlpacaResponse(this.focuser(id).device.position.value)
	}

	private focuserGetStepSize() {
		return makeAlpacaErrorResponse(AlpacaException.PropertyNotImplemented, 'Focuser does not support step size')
	}

	private focuserGetTempComp() {
		return makeAlpacaResponse(false)
	}

	private focuserSetTempComp() {
		return makeAlpacaResponse(undefined)
	}

	private focuserGetTempCompAvailable() {
		return makeAlpacaResponse(false)
	}

	private focuserGetTemperature(id: number) {
		return makeAlpacaResponse(this.focuser(id).device.temperature)
	}

	private focuserHalt(id: number) {
		this.options.focuser?.stop(this.focuser(id).device)
		return makeAlpacaResponse(undefined)
	}

	private focuserMove(id: number, data: { Position: string }) {
		const { device } = this.focuser(id)
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

	private focuserToggleReverse(focuser: Focuser) {
		this.options.focuser?.reverse(focuser, !focuser.reversed)
		return makeAlpacaResponse('OK')
	}

	// Cover Calibrator API

	private coverCalibratorGetBrightness(id: number) {
		return makeAlpacaResponse(this.flatPanel(id)?.device.intensity.value ?? 0)
	}

	private coverCalibratorIsChanging() {
		return makeAlpacaResponse(false) // INDI does not support it!
	}

	// https://ascom-standards.org/newdocs/covercalibrator.html#CalibratorStatus
	private coverCalibratorGetCalibratorState(id: number) {
		return makeAlpacaResponse(mapToCalibratorState(this.flatPanel(id)?.device))
	}

	private coverCalibratorIsMoving(id: number) {
		return makeAlpacaResponse(this.cover(id)?.device.parking)
	}

	// https://ascom-standards.org/newdocs/covercalibrator.html#CoverStatus
	private coverCalibratorGetCoverState(id: number) {
		return makeAlpacaResponse(mapToCoverState(this.cover(id)?.device))
	}

	private coverCalibratorGetDeviceState(id: number) {
		const cover = this.cover(id)?.device
		const flatPanel = this.flatPanel(id)?.device
		const res = new Array<AlpacaStateItem>(6)
		res[0] = { Name: 'Brightness', Value: flatPanel?.intensity.value ?? 0 }
		res[1] = { Name: 'CalibratorChanging', Value: false }
		res[2] = { Name: 'CalibratorState', Value: mapToCalibratorState(flatPanel) }
		res[3] = { Name: 'CoverMoving', Value: cover?.parking ?? false }
		res[4] = { Name: 'CoverState', Value: mapToCoverState(cover) }
		res[5] = { Name: 'TimeStamp', Value: '' }
		return makeAlpacaResponse(res)
	}

	private coverCalibratorGetMaxBrightness(id: number) {
		return makeAlpacaResponse(this.flatPanel(id).device.intensity.max)
	}

	private coverCalibratorOn(id: number, data: { Brightness: string }) {
		const { device } = this.flatPanel(id)
		const { flatPanel } = this.options
		flatPanel?.enable(device)
		flatPanel?.intensity(device, +data.Brightness)
		return makeAlpacaResponse(undefined)
	}

	private coverCalibratorOff(id: number) {
		this.options.flatPanel?.disable(this.flatPanel(id).device)
		return makeAlpacaResponse(undefined)
	}

	private coverCalibratorClose(id: number) {
		this.options.cover?.park(this.cover(id).device)
		return makeAlpacaResponse(undefined)
	}

	private coverCalibratorHalt(id: number) {
		this.options.cover?.stop(this.cover(id).device)
		return makeAlpacaResponse(undefined)
	}

	private coverCalibratorOpen(id: number) {
		this.options.cover?.unpark(this.cover(id).device)
		return makeAlpacaResponse(undefined)
	}

	private makeConfiguredDeviceFromDevice(device: Device, DeviceType: AlpacaDeviceType): AlpacaRegisteredDevice {
		let registeredDevice = this[DeviceType].get(device)
		if (registeredDevice) return registeredDevice

		const DeviceNumber = this.deviceNumberProvider(device, DeviceType)
		const configuredDevice: AlpacaConfiguredDevice = { DeviceName: device.name, DeviceNumber, UniqueID: device.id, DeviceType }
		console.info('device configured:', JSON.stringify(configuredDevice))

		const state = structuredClone(DEFAULT_ALPACA_DEVICE_STATE)

		if (isCamera(device)) {
			state.frame = [device.frame.x.value, device.frame.y.value, device.frame.width.value, device.frame.height.value]
		} else if (isMount(device)) {
			const state = structuredClone(DEFAULT_ALPACA_DEVICE_STATE)
			Object.assign(state, device.geographicCoordinate)
			Object.assign(state, device.equatorialCoordinate)
		}

		registeredDevice = { device, configuredDevice, state }
		this[DeviceType].set(device, registeredDevice as never)

		return registeredDevice
	}
}

async function params<T extends Record<string, string | number | boolean | undefined>>(req: Bun.BunRequest) {
	const data = req.headers.get('Content-Type')?.startsWith('application/x-www-form-urlencoded') ? await req.formData() : undefined
	const res: Record<string, string> = req.params
	data?.forEach((value, key) => typeof value === 'string' && (res[key] = value))
	return res as T
}

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

export function makeImageBytesFromFits(source: Buffer) {
	const reader = new FitsKeywordReader()
	let position = 0

	let bitpix = Bitpix.BYTE
	let numX = 0
	let numY = 0
	let numZ = 0

	while (true) {
		const [key, value] = reader.read(source.subarray(position, position + 80))

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
	const inputBytesPerPixel = bitpixInBytes(bitpix)
	const readStrideInBytes = numX * inputBytesPerPixel
	const channelsInBytes = channels * inputBytesPerPixel
	const writeStrideInBytes = numY * channelsInBytes

	const output = Buffer.allocUnsafe(44 + numX * numY * channelsInBytes) // 16-bit

	output.writeInt32LE(1, 0) // Bytes 0..3 - Metadata version = 1
	output.writeInt32LE(0, 4) // Bytes 4..7 - Alpaca error number or zero for success
	output.writeInt32LE(0, 8) // Bytes 8..11 - Client's transaction ID
	output.writeInt32LE(0, 12) // Bytes 12..15 - Device's transaction ID
	output.writeInt32LE(44, 16) // Bytes 16..19 - Offset of the start of the data bytes
	output.writeInt32LE(AlpacaImageElementType.Int32, 20) // Bytes 20..23 - Element type of the source image array. It's always 2 (Int32)? Because MaxIm DL crashes if it's not!
	output.writeInt32LE(bitpix === Bitpix.BYTE ? AlpacaImageElementType.Byte : AlpacaImageElementType.UInt16, 24) // Bytes 24..27 - Element type as sent over the network.
	output.writeInt32LE(numZ || 2, 28) // Bytes 28..31 - Image array rank (2 or 3)
	output.writeInt32LE(numX, 32) // Bytes 32..35 - Length of image array first dimension
	output.writeInt32LE(numY, 36) // Bytes 36..39 - Length of image array second dimension
	output.writeInt32LE(numZ || 0, 40) // Bytes 40..43 - Length of image array third dimension (0 for 2D array)

	let b = 0

	const sourceView = new DataView(source.buffer, source.byteOffset, source.byteLength)
	const outputView = new DataView(output.buffer, 44, output.byteLength - 44)

	// const message = `converted FITS image to ASCOM format. bitpix=${bitpix}, channels=${channels}`
	// console.time(message)

	if (bitpix === Bitpix.BYTE) {
		for (let c = 0; c < channels; c++) {
			for (let y = 0; y < numY; y++, position += readStrideInBytes) {
				b = y * channels + c

				for (let x = 0, a = position; x < numX; x++, a++, b += writeStrideInBytes) {
					outputView.setUint8(b, sourceView.getUint8(a))
				}
			}
		}
	} else {
		for (let c = 0; c < channelsInBytes; c += 2) {
			for (let y = 0; y < numY; y++, position += readStrideInBytes) {
				b = y * channelsInBytes + c

				for (let x = 0, a = position; x < numX; x++, a += 2, b += writeStrideInBytes) {
					outputView.setUint16(b, sourceView.getInt16(a, false) + 32768, true)
				}
			}
		}
	}

	// console.timeEnd(message)

	return output
}

function mapToAlpacaDeviceType(type: string): AlpacaDeviceType {
	switch (type.toLowerCase()) {
		case 'camera':
			return 'Camera'
		case 'telescope':
			return 'Telescope'
		case 'focuser':
			return 'Focuser'
		case 'filterwheel':
			return 'FilterWheel'
		case 'rotator':
			return 'Rotator'
		case 'dome':
			return 'Dome'
		case 'switch':
			return 'Switch'
		case 'covercalibrator':
			return 'CoverCalibrator'
		case 'observingconditions':
			return 'ObservingConditions'
		case 'safetymonitor':
			return 'SafetyMonitor'
		case 'video':
			return 'Video'
	}

	throw new Error(`unknown type: ${type}`)
}

function isTrue(value: string) {
	return value.toLowerCase() === 'true'
}

function makeAlpacaResponse<T>(data: T, code: AlpacaException | 0 = 0, message: string = '') {
	return Response.json({ Value: data, ClientTransactionID: 0, ServerTransactionID: 0, ErrorNumber: code, ErrorMessage: message })
}

function makeAlpacaErrorResponse(code: AlpacaException, message: string) {
	return makeAlpacaResponse(undefined, code, message)
}

function makeResponseForTask(result: true | AlpacaError) {
	return result === true ? makeAlpacaResponse(undefined) : makeAlpacaErrorResponse(result.code, result.message)
}

function mapPierSideToAlpacaEnum(value: PierSide) {
	return value === 'EAST' ? 0 : value === 'WEST' ? 1 : -1
}

function mapGuideDirectionToAlpacaEnum(value: GuideDirection) {
	return value === 'NORTH' ? 0 : value === 'SOUTH' ? 1 : value === 'EAST' ? 2 : 3
}

function mapAlpacaEnumToGuideDirection(value: number): GuideDirection {
	return value === 0 ? 'NORTH' : value === 1 ? 'SOUTH' : value === 2 ? 'EAST' : 'WEST'
}

function mapTrackModeToAlpacaEnum(value: TrackMode) {
	return value === 'SIDEREAL' ? 0 : value === 'LUNAR' ? 1 : value === 'SOLAR' ? 2 : 3
}

function mapAlpacaEnumToTrackMode(value: number): TrackMode {
	return value === 0 ? 'SIDEREAL' : value === 1 ? 'LUNAR' : value === 2 ? 'SOLAR' : 'KING'
}

function mapSlewRateToAlpacaAxisRate(rate: SlewRate, index: number): AlpacaAxisRate {
	return { Minimum: index + 1, Maximum: index + 1 }
}

function mapToCalibratorState(device?: FlatPanel) {
	return device === undefined ? 0 : device.intensity.max !== 0 ? 3 : 0 // 0 = Not present, 3 = Ready
}

function mapToCoverState(device?: Cover) {
	return device === undefined ? 0 : !device.canPark ? 0 : device.parking ? 2 : device.parked ? 1 : 3 // 0 = Not Present, 1 = Closed, 2 = Moving, 3 = Open
}
