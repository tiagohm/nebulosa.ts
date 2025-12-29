import { ALPACA_DISCOVERY_DATA, ALPACA_DISCOVERY_PORT, AlpacaCameraState, type AlpacaConfiguredDevice, type AlpacaDeviceType, AlpacaException, type AlpacaResponse, type AlpacaServerDescription, type AlpacaServerOptions, type AlpacaServerStartOptions, type AlpacaStateValue } from './alpaca.types'
import { Bitpix, bitpixInBytes, bitpixKeyword, type Fits, readFits } from './fits'
import type { IndiClient } from './indi'
import { type Camera, type Device, isCamera } from './indi.device'
import type { DeviceHandler, DeviceManager } from './indi.manager'
import { bufferSource } from './io'

export class AlpacaDiscoveryServer {
	private socket?: Bun.udp.Socket<'buffer'>
	private readonly ports = new Set<number>()

	addPort(port: number) {
		this.ports.add(port)
	}

	removePort(port: number) {
		this.ports.delete(port)
	}

	async start(hostname: string = '0.0.0.0', port: number = ALPACA_DISCOVERY_PORT) {
		if (this.socket) return false

		this.socket = await Bun.udpSocket({
			hostname,
			port,
			socket: {
				data: (socket, data, port, address) => {
					// ignore localhost
					if (address === '127.0.0.1' || address === 'localhost') return

					if (data.toString('utf-8') === ALPACA_DISCOVERY_DATA) {
						this.send(socket, port, address)
					}
				},
				error: (socket, error) => {
					console.error(error)
				},
			},
		})

		return true
	}

	stop() {
		if (this.socket) {
			this.socket.close()
			this.socket = undefined
		}
	}

	private send(socket: Bun.udp.Socket<'buffer'>, port: number, address: string) {
		this.ports.forEach((p) => socket.send(`{"AlpacaPort": ${p.toFixed(0)}}`, port, address))
	}
}

interface AlpacaDeviceState {
	// Camera
	data?: string
	lastExposureDuration: number
	ccdTemperature: number
	readonly frame: [number, number, number, number]
}

export class AlpacaServer {
	private server?: Bun.Server<undefined>
	private readonly devices = new Map<Device, AlpacaConfiguredDevice>()
	private readonly states = new Map<Device, AlpacaDeviceState>()
	private readonly connecting = new Map<Device, ReturnType<typeof promiseWithTimeout<boolean>>>()
	private readonly deviceManager: DeviceManager<Device>

	private readonly cameraHandler: DeviceHandler<Camera> = {
		added: (client: IndiClient, device: Camera) => {
			console.info('camera added:', device.name)
			this.devices.set(device, this.makeConfiguredDeviceFromDevice(device, 'Camera'))
		},
		updated: (client, device, property) => {
			if (property === 'frame') {
				const { frame } = this.states.get(device)!
				frame[0] = device.frame.x.value
				frame[1] = device.frame.y.value
				frame[2] = device.frame.width.value
				frame[3] = device.frame.height.value
			} else if (property === 'connected') {
				const resolver = this.connecting.get(device)

				if (resolver) {
					resolver.clear()

					// wait for all properties to be received
					if (device.connected) {
						console.info('device connected:', device.name)

						Bun.sleep(500).then(() => {
							resolver.resolve(device.connected)
							this.connecting.delete(device)
						})
					} else {
						console.info('device disconnected:', device.name)
						resolver.resolve(false)
						this.connecting.delete(device)
					}
				}
			}
		},
		removed: (client: IndiClient, device: Camera) => {
			console.info('camera removed:', device.name)
			this.devices.delete(device)
			this.states.delete(device)
		},
		blobReceived: (client, device, data) => {
			console.info('camera image received', device.name, data.length)
			this.states.get(device)!.data = data
		},
	}

	constructor(
		private readonly client: IndiClient,
		private readonly options: AlpacaServerOptions,
	) {
		this.deviceManager = (options.camera ?? options.mount ?? options.focuser ?? options.wheel ?? options.flatPanel ?? options.cover ?? options.rotator) as unknown as DeviceManager<Device>

		if (!this.deviceManager) throw new Error('at least one device manager must be provided.')

		options.camera?.addHandler(this.cameraHandler)

		this.configuredDevices()
	}

	get port() {
		return this.server?.port ?? -1
	}

	readonly routes: Bun.Serve.Routes<undefined, string> = {
		// https://ascom-standards.org/api/?urls.primaryName=ASCOM+Alpaca+Management+API
		'/management/apiversions': { GET: () => this.apiVersions() },
		'/management/v1/description': { GET: () => this.apiDescription() },
		'/management/v1/configureddevices': { GET: () => this.configuredDevices() },
		// https://ascom-standards.org/api/?urls.primaryName=ASCOM+Alpaca+Device+API
		// Device
		'/api/v1/:type/:id/interfaceversion': { GET: (req) => this.deviceGetInterfaceVersion(req.params.type as never) },
		'/api/v1/:type/:id/description': { GET: (req) => this.deviceGetDescription(+req.params.id) },
		'/api/v1/:type/:id/name': { GET: (req) => this.deviceGetName(+req.params.id) },
		'/api/v1/:type/:id/driverinfo': { GET: (req) => this.deviceGetDriverInfo(+req.params.id) },
		'/api/v1/:type/:id/driverversion': { GET: (req) => this.deviceGetDriverVersion(+req.params.id) },
		'/api/v1/:type/:id/connect': { PUT: (req) => this.deviceConnect(+req.params.id, { Connected: 'True' }) },
		'/api/v1/:type/:id/connected': { GET: (req) => this.deviceIsConnected(+req.params.id), PUT: async (req) => this.deviceConnect(+req.params.id, await params(req)) },
		'/api/v1/:type/:id/connecting': { GET: (req) => this.deviceIsConnecting(+req.params.id) },
		'/api/v1/:type/:id/disconnect': { PUT: (req) => this.deviceConnect(+req.params.id, { Connected: 'False' }) },
		'/api/v1/:type/:id/supportedactions': { GET: () => this.deviceGetSupportedActions() },
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
		'/api/v1/camera/:id/ispulseguiding': { GET: (req) => this.cameraIsPulseGuiding(+req.params.id) },
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
		'/api/v1/camera/:id/pulseguide': { PUT: async (req) => this.cameraPulseGuide(+req.params.id, await params(req)) },
		'/api/v1/camera/:id/startexposure': { PUT: async (req) => this.cameraStart(+req.params.id, await params(req)) },
		'/api/v1/camera/:id/stopexposure': { PUT: (req) => this.cameraStop(+req.params.id) },
		'/api/v1/camera/:id/imagearray': { GET: (req) => this.cameraGetImageArray(+req.params.id, req.headers.get('accept')) },
	}

	start(hostname: string = '0.0.0.0', port: number = 0, options?: AlpacaServerStartOptions) {
		if (this.server) return false

		this.server = Bun.serve({
			...options,
			hostname,
			port,
			development: false,
			error: (error) => {
				console.error(error)
			},
			websocket: undefined,
			fetch: (req) => {
				console.error(req)
				return new Response('Not Found', { status: 404 })
			},
			routes: this.routes,
		})
	}

	stop() {
		if (this.server) {
			this.server.stop(true)
			this.server = undefined
		}

		this.options?.camera?.removeHandler(this.cameraHandler)
	}

	private device<T extends Device = Device>(id: number) {
		for (const device of this.devices) if (device[1].DeviceNumber === id) return device[0] as T
		return undefined
	}

	// Management API

	// https://ascom-standards.org/newdocs/exceptions.html
	private makeAlpacaResponse<T>(data: T, code: AlpacaException | 0 = 0, message: string = ''): AlpacaResponse<T> {
		return { Value: data, ClientTransactionID: 0, ServerTransactionID: 0, ErrorNumber: code, ErrorMessage: message }
	}

	private makeAlpacaErrorResponse(code: AlpacaException, message: string) {
		return this.makeAlpacaResponse(undefined, code, message)
	}

	private apiVersions() {
		return Response.json(this.makeAlpacaResponse([1]))
	}

	private apiDescription() {
		return Response.json(this.makeAlpacaResponse<AlpacaServerDescription>({ ServerName: this.options.name || 'Nebulosa', Manufacturer: this.options.manufacturer || 'Tiago Melo', ManufacturerVersion: this.options.version || '1.0.0', Location: 'None' }))
	}

	private configuredDevices() {
		const configuredDevices = new Set<AlpacaConfiguredDevice>()

		this.options.camera?.list().forEach((e) => configuredDevices.add(this.makeConfiguredDeviceFromDevice(e, 'Camera')))
		this.options.mount?.list().forEach((e) => configuredDevices.add(this.makeConfiguredDeviceFromDevice(e, 'Telescope')))
		this.options.focuser?.list().forEach((e) => configuredDevices.add(this.makeConfiguredDeviceFromDevice(e, 'Focuser')))
		this.options.wheel?.list().forEach((e) => configuredDevices.add(this.makeConfiguredDeviceFromDevice(e, 'FilterWheel')))
		this.options.rotator?.list().forEach((e) => configuredDevices.add(this.makeConfiguredDeviceFromDevice(e, 'Rotator')))
		this.options.flatPanel?.list().forEach((e) => configuredDevices.add(this.makeConfiguredDeviceFromDevice(e, 'CoverCalibrator')))
		this.options.cover?.list().forEach((e) => configuredDevices.add(this.makeConfiguredDeviceFromDevice(e, 'CoverCalibrator')))

		return Response.json(this.makeAlpacaResponse(Array.from(configuredDevices)))
	}

	// Device API

	private deviceGetInterfaceVersion(type: Lowercase<AlpacaDeviceType>) {
		const version = type === 'camera' || type === 'focuser' || type === 'rotator' || type === 'telescope' ? 4 : type === 'dome' || type === 'filterwheel' || type === 'safetymonitor' || type === 'switch' ? 3 : 2
		return Response.json(this.makeAlpacaResponse(version))
	}

	private deviceGetDescription(id: number) {
		return Response.json(this.makeAlpacaResponse(this.device(id)!.name))
	}

	private deviceGetName(id: number) {
		return Response.json(this.makeAlpacaResponse(this.device(id)!.name))
	}

	private deviceGetDriverInfo(id: number) {
		return Response.json(this.makeAlpacaResponse(this.device(id)!.driver.executable))
	}

	private deviceGetDriverVersion(id: number) {
		return Response.json(this.makeAlpacaResponse(this.device(id)!.driver.version))
	}

	private deviceIsConnected(id: number) {
		return Response.json(this.makeAlpacaResponse(!!this.device(id)?.connected))
	}

	private deviceIsConnecting(id: number) {
		const device = this.device<Camera>(id)!
		return Response.json(this.makeAlpacaResponse(this.connecting.has(device)))
	}

	private deviceConnect(id: number, data: { Connected: string }) {
		const device = this.device(id)!

		const makeResponse = (connected: boolean) => {
			return connected ? Response.json(this.makeAlpacaResponse(undefined)) : Response.json(this.makeAlpacaErrorResponse(AlpacaException.NotConnected, 'Unable to connect'))
		}

		if (this.connecting.has(device)) {
			return this.connecting.get(device)!.promise.then(makeResponse)
		}

		const connect = data.Connected.toLowerCase() === 'true'

		if (connect !== device.connected) {
			const resolver = promiseWithTimeout<boolean>(() => {
				console.warn('timed out on connecting device:', device.name)
				this.connecting.delete(device)
				return false
			}, 10000)

			this.connecting.set(device, resolver)

			console.info(connect ? 'device connecting:' : 'device disconnecting:', device.name)

			if (connect) this.deviceManager.connect(this.client, device as never)
			else this.deviceManager.disconnect(this.client, device as never)

			return resolver.promise.then(makeResponse)
		}

		return makeResponse(true)
	}

	private deviceGetSupportedActions() {
		return Response.json(this.makeAlpacaResponse([]))
	}

	// Camera API

	private cameraGetXSize(id: number) {
		return Response.json(this.makeAlpacaResponse(this.device<Camera>(id)!.frame.width.value))
	}

	private cameraGetYSize(id: number) {
		return Response.json(this.makeAlpacaResponse(this.device<Camera>(id)!.frame.height.value))
	}

	private cameraCanAsymmetricBin() {
		return Response.json(this.makeAlpacaResponse(false))
	}

	private cameraCanFastReadout() {
		return Response.json(this.makeAlpacaResponse(false))
	}

	private cameraCanStopExposure(id: number) {
		return Response.json(this.makeAlpacaResponse(this.device<Camera>(id)!.canAbort))
	}

	private cameraGetSensorName() {
		return Response.json(this.makeAlpacaResponse(''))
	}

	// https://ascom-standards.org/newdocs/camera.html#Camera.SensrType
	private cameraGetSensorType(id: number) {
		const device = this.device<Camera>(id)!
		return Response.json(this.makeAlpacaResponse(device.cfa.type ? 2 : 0))
	}

	private cameraGetDeviceState(id: number) {
		const device = this.device<Camera>(id)!
		const state = this.states.get(device)!
		const res = new Array<AlpacaStateValue>(8)
		res.push({ Name: 'CameraState', Value: device.exposuring ? AlpacaCameraState.Exposing : AlpacaCameraState.Idle })
		res.push({ Name: 'CCDTemperature', Value: device.temperature })
		res.push({ Name: 'CoolerPower', Value: device.coolerPower })
		res.push({ Name: 'HeatSinkTemperature', Value: device.temperature })
		res.push({ Name: 'ImageReady', Value: !!state.data })
		res.push({ Name: 'IsPulseGuiding', Value: device.pulsing })
		res.push({ Name: 'PercentCompleted', Value: (1 - device.exposure.value / state.lastExposureDuration) * 100 })
		res.push({ Name: 'TimeStamp', Value: '' })
		return Response.json(this.makeAlpacaResponse(res))
	}

	private cameraGetEletronsPerADU() {
		return Response.json(this.makeAlpacaResponse(1))
	}

	private cameraIsFastReadout() {
		return Response.json(this.makeAlpacaResponse(false))
	}

	private cameraSetFastReadout() {
		return Response.json(this.makeAlpacaResponse(undefined))
	}

	private cameraGetFullwellCapacity() {
		return Response.json(this.makeAlpacaResponse(65535))
	}

	private cameraGetMaxADU() {
		return Response.json(this.makeAlpacaResponse(65535))
	}

	private cameraIsImageReady(id: number) {
		return Response.json(this.makeAlpacaResponse(this.states.get(this.device<Camera>(id)!)?.data !== undefined))
	}

	private cameraIsPulseGuiding(id: number) {
		return Response.json(this.makeAlpacaResponse(this.device<Camera>(id)!.pulsing))
	}

	private cameraGetLastExposureDuration(id: number) {
		return Response.json(this.makeAlpacaResponse(this.states.get(this.device<Camera>(id)!)?.lastExposureDuration))
	}

	private cameraGetGain(id: number) {
		return Response.json(this.makeAlpacaResponse(this.device<Camera>(id)!.gain.value))
	}

	private cameraGetGainMax(id: number) {
		return Response.json(this.makeAlpacaResponse(this.device<Camera>(id)!.gain.max))
	}

	private cameraGetGainMin(id: number) {
		return Response.json(this.makeAlpacaResponse(this.device<Camera>(id)!.gain.min))
	}

	private cameraGetGains() {
		return Response.json(this.makeAlpacaResponse([], AlpacaException.MethodNotImplemented, 'Gain modes is not supported'))
	}

	private cameraGetOffsets() {
		return Response.json(this.makeAlpacaResponse([], AlpacaException.MethodNotImplemented, 'Offset modes is not supported'))
	}

	private cameraSetGain(id: number, data: { Gain: string }) {
		const device = this.device<Camera>(id)!
		this.options.camera?.gain(this.client, device, +data.Gain)
		return Response.json(this.makeAlpacaResponse(undefined))
	}

	private cameraGetOffset(id: number) {
		return Response.json(this.makeAlpacaResponse(this.device<Camera>(id)!.offset.value))
	}

	private cameraGetOffsetMax(id: number) {
		return Response.json(this.makeAlpacaResponse(this.device<Camera>(id)!.offset.max))
	}

	private cameraGetOffsetMin(id: number) {
		return Response.json(this.makeAlpacaResponse(this.device<Camera>(id)!.offset.min))
	}

	private cameraSetOffset(id: number, data: { Offset: string }) {
		const device = this.device<Camera>(id)!
		this.options.camera?.offset(this.client, device, +data.Offset)
		return Response.json(this.makeAlpacaResponse(undefined))
	}

	private cameraGetMaxBinX(id: number) {
		return Response.json(this.makeAlpacaResponse(this.device<Camera>(id)!.bin.x.max))
	}

	private cameraGetMaxBinY(id: number) {
		return Response.json(this.makeAlpacaResponse(this.device<Camera>(id)!.bin.y.max))
	}

	private cameraGetNumX(id: number) {
		return Response.json(this.makeAlpacaResponse(this.device<Camera>(id)!.frame.width.value))
	}

	cameraSetFrame(id: number, data: { NumX?: string; NumY?: string; StartX?: string; StartY?: string }) {
		const device = this.device<Camera>(id)!
		const { frame } = this.states.get(device)!
		if (data.StartX) frame[0] = +data.StartX
		if (data.StartY) frame[1] = +data.StartY
		if (data.NumX) frame[2] = +data.NumX
		if (data.NumY) frame[3] = +data.NumY
		this.options.camera?.frame(this.client, device, ...frame)
		return Response.json(this.makeAlpacaResponse(undefined))
	}

	private cameraSetNumX(id: number, data: { NumX: string }) {
		return this.cameraSetFrame(id, data)
	}

	private cameraGetNumY(id: number) {
		return Response.json(this.makeAlpacaResponse(this.device<Camera>(id)!.frame.height.value))
	}

	private cameraSetNumY(id: number, data: { NumY: string }) {
		return this.cameraSetFrame(id, data)
	}

	private cameraGetStartX(id: number) {
		return Response.json(this.makeAlpacaResponse(this.device<Camera>(id)!.frame.x.value))
	}

	private cameraSetStartX(id: number, data: { StartX: string }) {
		return this.cameraSetFrame(id, data)
	}

	private cameraGetStartY(id: number) {
		return Response.json(this.makeAlpacaResponse(this.device<Camera>(id)!.frame.y.value))
	}

	private cameraSetStartY(id: number, data: { StartY: string }) {
		return this.cameraSetFrame(id, data)
	}

	private cameraGetPercentCompleted(id: number) {
		const device = this.device<Camera>(id)!
		const state = this.states.get(device)!
		return Response.json(this.makeAlpacaResponse((1 - device.exposure.value / state.lastExposureDuration) * 100))
	}

	private cameraGetPixelSizeX(id: number) {
		return Response.json(this.makeAlpacaResponse(this.device<Camera>(id)!.pixelSize.x))
	}

	private cameraGetPixelSizeY(id: number) {
		return Response.json(this.makeAlpacaResponse(this.device<Camera>(id)!.pixelSize.y))
	}

	private cameraGetReadoutMode(id: number) {
		const device = this.device<Camera>(id)!
		return Response.json(this.makeAlpacaResponse(device.frameFormat))
	}

	private cameraSetReadoutMode(id: number, data: { ReadoutMode: string }) {
		const device = this.device<Camera>(id)!
		this.options.camera?.frameFormat(this.client, device, data.ReadoutMode)
		return Response.json(this.makeAlpacaResponse(undefined))
	}

	private cameraGetReadoutModes(id: number) {
		const device = this.device<Camera>(id)!
		return Response.json(this.makeAlpacaResponse(device.frameFormats))
	}

	private cameraGetExposureMax(id: number) {
		return Response.json(this.makeAlpacaResponse(this.device<Camera>(id)!.exposure.max))
	}

	private cameraGetExposureMin(id: number) {
		return Response.json(this.makeAlpacaResponse(this.device<Camera>(id)!.exposure.min))
	}

	private cameraGetExposureResolution() {
		return Response.json(this.makeAlpacaResponse(1e-6))
	}

	private cameraCanGetCoolerPower(id: number) {
		return Response.json(this.makeAlpacaResponse(this.device<Camera>(id)!.hasCoolerControl))
	}

	private cameraCanPulseGuide(id: number) {
		return Response.json(this.makeAlpacaResponse(this.device<Camera>(id)!.canPulseGuide))
	}

	private cameraCanSetCCDTemperature(id: number) {
		return Response.json(this.makeAlpacaResponse(this.device<Camera>(id)!.canSetTemperature))
	}

	private cameraHasShutter() {
		return Response.json(this.makeAlpacaResponse(false))
	}

	private cameraGetCcdTemperature(id: number) {
		return Response.json(this.makeAlpacaResponse(this.device<Camera>(id)!.temperature))
	}

	private cameraGetSetCcdTemperature(id: number) {
		const device = this.device<Camera>(id)!
		return Response.json(this.makeAlpacaResponse(this.states.get(device)!.ccdTemperature))
	}

	private cameraSetCcdTemperature(id: number, data: { SetCCDTemperature: string }) {
		const device = this.device<Camera>(id)!
		const state = this.states.get(device)!
		state.ccdTemperature = +data.SetCCDTemperature
		this.options.camera?.temperature(this.client, device, state.ccdTemperature)
		return Response.json(this.makeAlpacaResponse(this.device<Camera>(id)!.temperature))
	}

	private cameraGetBayerOffsetX(id: number) {
		return Response.json(this.makeAlpacaResponse(this.device<Camera>(id)!.cfa.offsetX))
	}

	private cameraGetBayerOffsetY(id: number) {
		return Response.json(this.makeAlpacaResponse(this.device<Camera>(id)!.cfa.offsetY))
	}

	private cameraGetBinX(id: number) {
		return Response.json(this.makeAlpacaResponse(this.device<Camera>(id)!.bin.x.value))
	}

	private cameraGetBinY(id: number) {
		return Response.json(this.makeAlpacaResponse(this.device<Camera>(id)!.bin.y.value))
	}

	private cameraSetBin(id: number, data: { BinX?: string; BinY?: string }) {
		const device = this.device<Camera>(id)!
		const bin = +(data.BinX || data.BinY || 1)
		this.options.camera?.bin(this.client, device, bin, bin)
		return Response.json(this.makeAlpacaResponse(undefined))
	}

	private cameraSetBinX(id: number, data: { BinX: string }) {
		return this.cameraSetBin(id, data)
	}

	private cameraSetBinY(id: number, data: { BinY: string }) {
		return this.cameraSetBin(id, data)
	}

	private cameraIsCoolerOn(id: number) {
		return Response.json(this.makeAlpacaResponse(this.device<Camera>(id)!.cooler))
	}

	private cameraSetCoolerOn(id: number, data: { CoolerOn: string }) {
		const device = this.device<Camera>(id)!
		this.options.camera?.cooler(this.client, device, data.CoolerOn.toLowerCase() === 'true')
		return Response.json(this.makeAlpacaResponse(undefined))
	}

	private cameraGetCoolerPower(id: number) {
		return Response.json(this.makeAlpacaResponse(this.device<Camera>(id)!.coolerPower))
	}

	// https://ascom-standards.org/newdocs/camera.html#Camera.CameraStates
	private cameraGetState(id: number) {
		return Response.json(this.makeAlpacaResponse(this.device<Camera>(id)!.exposuring ? AlpacaCameraState.Exposing : AlpacaCameraState.Idle))
	}

	private cameraStart(id: number, data: { Duration: string; Light: string }) {
		const device = this.device<Camera>(id)!
		const camera = this.options.camera
		if (!camera) return Response.json(this.makeAlpacaErrorResponse(AlpacaException.InvalidOperation, 'Camera manager is not present'))
		camera.enableBlob(this.client, device)
		camera.frameType(this.client, device, data.Light.toLowerCase() !== 'true' ? 'DARK' : 'LIGHT')
		camera.startExposure(this.client, device, +data.Duration)
		return Response.json(this.makeAlpacaResponse(undefined))
	}

	private cameraPulseGuide(id: number, data: { Duration: string; Direction: string }) {
		const device = this.device<Camera>(id)!
		this.options.guideOutput?.pulse(this.client, device, data.Direction === '0' ? 'NORTH' : data.Direction === '1' ? 'SOUTH' : data.Direction === '2' ? 'EAST' : 'WEST', +data.Duration)
		return Response.json(this.makeAlpacaResponse(undefined))
	}

	private cameraStop(id: number) {
		const device = this.device<Camera>(id)!
		this.options.camera?.stopExposure(this.client, device)
		return Response.json(this.makeAlpacaResponse(undefined))
	}

	private async cameraGetImageArray(id: number, accept?: string | null) {
		const device = this.device<Camera>(id)!
		const state = this.states.get(device)!

		try {
			const buffer = Buffer.from(state.data!, 'base64')
			const fits = await readFits(bufferSource(buffer))

			if (!fits) return Response.json(this.makeAlpacaErrorResponse(AlpacaException.Driver, 'Unable to read FITS image'))

			if (accept?.includes('imagebytes')) {
				const image = makeImageBytesFromFits(fits, buffer)
				return new Response(image, { headers: { 'Content-Type': 'application/imagebytes' } })
			}
		} finally {
			state.data = undefined
		}

		return Response.json(this.makeAlpacaErrorResponse(AlpacaException.Driver, 'Image bytes as JSON array is not supported'))
	}

	private makeConfiguredDeviceFromDevice(device: Device, type: AlpacaDeviceType): AlpacaConfiguredDevice {
		let configuredDevice = this.devices.get(device)
		if (configuredDevice) return configuredDevice
		const uid = `${device.type}:${device.name}`
		configuredDevice = { DeviceName: device.name, DeviceNumber: Bun.hash.cityHash32(uid), DeviceType: type, UniqueID: Bun.MD5.hash(uid, 'hex') }
		console.info('device found:', JSON.stringify(configuredDevice))
		this.devices.set(device, configuredDevice)
		const frame: AlpacaDeviceState['frame'] = isCamera(device) ? [device.frame.x.value, device.frame.y.value, device.frame.width.value, device.frame.height.value] : [0, 0, 0, 0]
		this.states.set(device, { lastExposureDuration: 0, ccdTemperature: 0, frame })
		return configuredDevice
	}
}

async function params<T extends Record<string, string | undefined>>(req: Bun.BunRequest) {
	const data = await req.formData()
	const res: Record<string, string> = req.params
	data.forEach((value, key) => typeof value === 'string' && (res[key] = value))
	return res as T
}

function promiseWithTimeout<T>(callback: () => T | PromiseLike<T> | Error, delay: number) {
	const resolver = Promise.withResolvers<T>()

	const timer = setTimeout(() => {
		const value = callback()
		if (Error.isError(value)) resolver.reject(value)
		else resolver.resolve(value)
	}, delay)

	return { ...resolver, clear: () => clearTimeout(timer) } as const
}

export function makeImageBytesFromFits(fits: Fits, data: Buffer<ArrayBuffer>) {
	const hdu = fits.hdus[0]
	const { header } = hdu
	const bitpix = bitpixKeyword(header, 0)
	const elementType = bitpix === Bitpix.BYTE ? 6 : bitpix === Bitpix.SHORT ? 1 : bitpix === Bitpix.INTEGER ? 2 : bitpix === Bitpix.FLOAT ? 4 : 3
	const numX = header.NAXIS1 as number
	const numY = header.NAXIS2 as number
	const numZ = header.NAXIS3 as number | undefined
	const channels = numZ || 1
	const bytesPerPixel = bitpixInBytes(bitpix)
	const strideInBytes = numX * bytesPerPixel
	const planeInBytes = strideInBytes * numY
	const { offset = 0 } = hdu.data

	const output = Buffer.allocUnsafe(44 + planeInBytes * channels)

	output.writeInt32LE(1, 0) // Bytes 0..3 - Metadata version = 1
	output.writeInt32LE(0, 4) // Bytes 4..7 - Alpaca error number or zero for success
	output.writeInt32LE(0, 8) // Bytes 8..11 - Client's transaction ID
	output.writeInt32LE(0, 12) // Bytes 12..15 - Device's transaction ID
	output.writeInt32LE(44, 16) // Bytes 16..19 - Offset of the start of the data bytes
	output.writeInt32LE(elementType, 20) // Bytes 20..23 - Element type of the source image array
	output.writeInt32LE(elementType, 24) // Bytes 24..27 - Element type as sent over the network
	output.writeInt32LE(numZ || 2, 28) // Bytes 28..31 - Image array rank (2 or 3)
	output.writeInt32LE(numX, 32) // Bytes 32..35 - Length of image array first dimension
	output.writeInt32LE(numY, 36) // Bytes 36..39 - Length of image array second dimension
	output.writeInt32LE(numZ || 0, 40) // Bytes 40..43 - Length of image array third dimension (0 for 2D array)

	let b = 44

	const input = new DataView(data.buffer, data.byteOffset, data.byteLength)
	const out = new DataView(output.buffer, output.byteOffset, output.byteLength)

	if (channels === 1) {
		if (bytesPerPixel === 2) {
			for (let x = 0; x < numX; x++) {
				const ax = (x << 1) + offset

				for (let y = 0; y < numY; y++, b += 2) {
					const ay = y * strideInBytes + ax
					out.setUint16(b, input.getUint16(ay, false), true)
				}
			}
		} else if (bytesPerPixel === 1) {
			for (let x = 0; x < numX; x++) {
				const ax = x + offset

				for (let y = 0; y < numY; y++, b++) {
					const ay = y + ax
					out.setUint16(b, input.getUint16(ay, false), true)
				}
			}
		} else {
			for (let x = 0; x < numX; x++) {
				const ax = (x << 2) + offset

				for (let y = 0; y < numY; y++, b += 4) {
					const ay = y * strideInBytes + ax
					out.setUint16(b, input.getUint16(ay, false), true)
				}
			}
		}
	} else if (bytesPerPixel === 2) {
		for (let x = 0; x < numX; x++) {
			const ax = (x << 1) + offset

			for (let y = 0; y < numY; y++) {
				const ay = y * strideInBytes + ax
				out.setUint16(b, input.getUint16(ay, false), true)
				b += 2
				out.setUint16(b, input.getUint16(ay + planeInBytes, false), true)
				b += 2
				out.setUint16(b, input.getUint16(ay + planeInBytes * 2, false), true)
				b += 2
			}
		}
	} else if (bytesPerPixel === 1) {
		for (let x = 0; x < numX; x++) {
			const ax = x + offset

			for (let y = 0; y < numY; y++) {
				const ay = y + ax
				out.setUint16(b++, input.getUint16(ay, false), true)
				out.setUint16(b++, input.getUint16(ay + planeInBytes, false), true)
				out.setUint16(b++, input.getUint16(ay + planeInBytes * 2, false), true)
			}
		}
	} else {
		for (let x = 0; x < numX; x++) {
			const ax = (x << 2) + offset

			for (let y = 0; y < numY; y++) {
				const ay = y * strideInBytes + ax
				out.setUint32(b, input.getUint32(ay, false), true)
				b += 4
				out.setUint32(b, input.getUint32(ay + planeInBytes, false), true)
				b += 4
				out.setUint32(b, input.getUint32(ay + planeInBytes * 2, false), true)
				b += 4
			}
		}
	}

	return output.buffer
}
