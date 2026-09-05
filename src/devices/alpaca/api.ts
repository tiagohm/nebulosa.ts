import { errorMessage } from '../../core/util'
// oxfmt-ignore
import type { AlpacaAxisRate, AlpacaCameraSensorType, AlpacaCameraState, AlpacaConfiguredDevice, AlpacaDomeShutterState, AlpacaGuideDirection, AlpacaRequestFailedResult, AlpacaRequestResult, AlpacaResponse, AlpacaStateItem, AlpacaTelescopeAlignmentMode, AlpacaTelescopeAxis, AlpacaTelescopeEquatorialCoordinateType, AlpacaTelescopePierSide, AlpacaTelescopeTrackingRate } from './types'

// Thin typed HTTP client for the ASCOM Alpaca REST API. Each class wraps one device type and exposes a
// method per Alpaca property/operation; the methods are intentionally one-line mappings onto the shared
// request() helper, so they are self-documenting and not individually commented. Values are passed
// through unchanged (units follow the Alpaca spec). See the class comments for per-device scope.
//
// Every method returns an AlpacaRequestResult rather than collapsing a failure to undefined, because the
// distinction matters: ErrorNumber 1024 means the member does not exist on that driver and is a permanent
// capability fact, while a timeout, a 5xx, or ValueNotSet is transient and must not disable anything.
// https://ascom-standards.org/api/

// Accept header that requests the binary ImageBytes encoding for camera image downloads.
const IMAGE_ARRAY_HEADERS: HeadersInit = {
	Accept: 'application/imagebytes',
}

// Aggregate client bundling one API wrapper per Alpaca device type, all sharing the same base URL.
export class AlpacaApi {
	readonly management: AlpacaManagementApi
	readonly telescope: AlpacaTelescopeApi
	readonly camera: AlpacaCameraApi
	readonly filterWheel: AlpacaFilterWheelApi
	readonly focuser: AlpacaFocuserApi
	readonly coverCalibrator: AlpacaCoverCalibratorApi
	readonly rotator: AlpacaRotatorApi
	readonly dome: AlpacaDomeApi
	readonly safetyMonitor: AlpacaSafetyMonitorApi
	readonly observingConditions: AlpacaObservingConditionsApi

	constructor(readonly url: string | URL) {
		this.management = new AlpacaManagementApi(url)
		this.camera = new AlpacaCameraApi(url)
		this.telescope = new AlpacaTelescopeApi(url)
		this.filterWheel = new AlpacaFilterWheelApi(url)
		this.focuser = new AlpacaFocuserApi(url)
		this.coverCalibrator = new AlpacaCoverCalibratorApi(url)
		this.rotator = new AlpacaRotatorApi(url)
		this.dome = new AlpacaDomeApi(url)
		this.safetyMonitor = new AlpacaSafetyMonitorApi(url)
		this.observingConditions = new AlpacaObservingConditionsApi(url)
	}
}

// Alpaca management API: server-wide endpoints not tied to a single device.
export class AlpacaManagementApi {
	constructor(readonly url: string | URL) {}

	// Lists the devices the server exposes, normalizing DeviceType to lowercase to match AlpacaDeviceType.
	async configuredDevices() {
		const result = await request<readonly AlpacaConfiguredDevice[]>(this.url, 'management/v1/configureddevices', 'GET')
		if (result.ok) for (const device of result.value) (device as unknown as Record<string, string>).DeviceType = device.DeviceType.toLowerCase()
		return result
	}
}

// Base class with the connection endpoints common to every Alpaca device type.
export class AlpacaDeviceApi {
	constructor(readonly url: string | URL) {}

	isConnected(id: number) {
		return request<boolean>(this.url, `${id}/connected`, 'GET')
	}

	connect(id: number) {
		return request<true>(this.url, `${id}/connected`, 'PUT', { Connected: true }, undefined, true)
	}

	disconnect(id: number) {
		return request<true>(this.url, `${id}/connected`, 'PUT', { Connected: false }, undefined, true)
	}

	deviceState(id: number) {
		return request<readonly AlpacaStateItem[]>(this.url, `${id}/devicestate`, 'GET')
	}
}

// SafetyMonitor device endpoints. IsSafe is read-only and false includes warning/unknown conditions.
export class AlpacaSafetyMonitorApi extends AlpacaDeviceApi {
	constructor(url: string | URL) {
		super(new URL('/api/v1/safetymonitor/', url))
	}

	isSafe(id: number) {
		return request<boolean>(this.url, `${id}/issafe`, 'GET')
	}
}

// ObservingConditions device endpoints (ASCOM IObservingConditionsV2). Every sensor is optional, so this
// is the device where telling 1024 apart from a transient fault decides what gets polled at all.
//
// Units follow the ASCOM spec: percent for CloudCover and Humidity, degrees Celsius for DewPoint,
// SkyTemperature and Temperature, hPa for Pressure, mm/h for RainRate, lux for SkyBrightness,
// mag/arcsec² for SkyQuality, arcsec for StarFWHM, m/s for WindSpeed and WindGust, and hours for
// AveragePeriod. WindDirection is degrees clockwise from north, where north is reported as 360 and 0 is
// reserved for calm (WindSpeed of zero).
export class AlpacaObservingConditionsApi extends AlpacaDeviceApi {
	constructor(url: string | URL) {
		super(new URL('/api/v1/observingconditions/', url))
	}

	getAveragePeriod(id: number) {
		return request<number>(this.url, `${id}/averageperiod`, 'GET')
	}

	setAveragePeriod(id: number, AveragePeriod: number) {
		return request<void>(this.url, `${id}/averageperiod`, 'PUT', { AveragePeriod })
	}

	getCloudCover(id: number) {
		return request<number>(this.url, `${id}/cloudcover`, 'GET')
	}

	getDewPoint(id: number) {
		return request<number>(this.url, `${id}/dewpoint`, 'GET')
	}

	getHumidity(id: number) {
		return request<number>(this.url, `${id}/humidity`, 'GET')
	}

	getPressure(id: number) {
		return request<number>(this.url, `${id}/pressure`, 'GET')
	}

	getRainRate(id: number) {
		return request<number>(this.url, `${id}/rainrate`, 'GET')
	}

	getSkyBrightness(id: number) {
		return request<number>(this.url, `${id}/skybrightness`, 'GET')
	}

	getSkyQuality(id: number) {
		return request<number>(this.url, `${id}/skyquality`, 'GET')
	}

	getSkyTemperature(id: number) {
		return request<number>(this.url, `${id}/skytemperature`, 'GET')
	}

	getStarFWHM(id: number) {
		return request<number>(this.url, `${id}/starfwhm`, 'GET')
	}

	getTemperature(id: number) {
		return request<number>(this.url, `${id}/temperature`, 'GET')
	}

	getWindDirection(id: number) {
		return request<number>(this.url, `${id}/winddirection`, 'GET')
	}

	getWindGust(id: number) {
		return request<number>(this.url, `${id}/windgust`, 'GET')
	}

	getWindSpeed(id: number) {
		return request<number>(this.url, `${id}/windspeed`, 'GET')
	}

	refresh(id: number) {
		return request<void>(this.url, `${id}/refresh`, 'PUT')
	}

	sensorDescription(id: number, SensorName: string) {
		return request<string>(this.url, `${id}/sensordescription`, 'GET', { SensorName })
	}

	// An empty SensorName asks for the time since the most recent update of any sensor.
	timeSinceLastUpdate(id: number, SensorName: string = '') {
		return request<number>(this.url, `${id}/timesincelastupdate`, 'GET', { SensorName })
	}
}

// Camera device endpoints (binning, cooling, gain/offset, subframe, exposure, image download).
export class AlpacaCameraApi extends AlpacaDeviceApi {
	constructor(url: string | URL) {
		super(new URL('/api/v1/camera/', url))
	}

	getBayerOffsetX(id: number) {
		return request<number>(this.url, `${id}/bayeroffsetx`, 'GET')
	}

	getBayerOffsetY(id: number) {
		return request<number>(this.url, `${id}/bayeroffsety`, 'GET')
	}

	getBinX(id: number) {
		return request<number>(this.url, `${id}/binx`, 'GET')
	}

	setBinX(id: number, BinX: number) {
		return request<void>(this.url, `${id}/binx`, 'PUT', { BinX })
	}

	getBinY(id: number) {
		return request<number>(this.url, `${id}/biny`, 'GET')
	}

	setBinY(id: number, BinY: number) {
		return request<void>(this.url, `${id}/biny`, 'PUT', { BinY })
	}

	getCameraState(id: number) {
		return request<AlpacaCameraState>(this.url, `${id}/camerastate`, 'GET')
	}

	getCameraXSize(id: number) {
		return request<number>(this.url, `${id}/cameraxsize`, 'GET')
	}

	getCameraYSize(id: number) {
		return request<number>(this.url, `${id}/cameraysize`, 'GET')
	}

	canAbortExposure(id: number) {
		return request<boolean>(this.url, `${id}/canabortexposure`, 'GET')
	}

	canAsymmetricBin(id: number) {
		return request<boolean>(this.url, `${id}/canasymmetricbin`, 'GET')
	}

	canFastReadout(id: number) {
		return request<boolean>(this.url, `${id}/canfastreadout`, 'GET')
	}

	canGetCoolerPower(id: number) {
		return request<boolean>(this.url, `${id}/cangetcoolerpower`, 'GET')
	}

	canPulseGuide(id: number) {
		return request<boolean>(this.url, `${id}/canpulseguide`, 'GET')
	}

	canSetCcdTemperature(id: number) {
		return request<boolean>(this.url, `${id}/cansetccdtemperature`, 'GET')
	}

	canStopExposure(id: number) {
		return request<boolean>(this.url, `${id}/canstopexposure`, 'GET')
	}

	getCcdTemperature(id: number) {
		return request<number>(this.url, `${id}/ccdtemperature`, 'GET')
	}

	isCoolerOn(id: number) {
		return request<boolean>(this.url, `${id}/cooleron`, 'GET')
	}

	setCoolerOn(id: number, CoolerOn: boolean) {
		return request<void>(this.url, `${id}/cooleron`, 'PUT', { CoolerOn })
	}

	getCoolerPower(id: number) {
		return request<number>(this.url, `${id}/coolerpower`, 'GET')
	}

	getElectronsPerAdu(id: number) {
		return request<number>(this.url, `${id}/electronsperadu`, 'GET')
	}

	getExposureMax(id: number) {
		return request<number>(this.url, `${id}/exposuremax`, 'GET')
	}

	getExposureMin(id: number) {
		return request<number>(this.url, `${id}/exposuremin`, 'GET')
	}

	getExposureResolution(id: number) {
		return request<number>(this.url, `${id}/exposureresolution`, 'GET')
	}

	isFastReadout(id: number) {
		return request<boolean>(this.url, `${id}/fastreadout`, 'GET')
	}

	setFastReadout(id: number, FastReadout: boolean) {
		return request<void>(this.url, `${id}/fastreadout`, 'PUT', { FastReadout })
	}

	getFullwellCapacity(id: number) {
		return request<number>(this.url, `${id}/fullwellcapacity`, 'GET')
	}

	getGain(id: number) {
		return request<number>(this.url, `${id}/gain`, 'GET')
	}

	setGain(id: number, Gain: number) {
		return request<void>(this.url, `${id}/gain`, 'PUT', { Gain })
	}

	getGainMax(id: number) {
		return request<number>(this.url, `${id}/gainmax`, 'GET')
	}

	getGainMin(id: number) {
		return request<number>(this.url, `${id}/gainmin`, 'GET')
	}

	getGains(id: number) {
		return request<readonly number[]>(this.url, `${id}/gains`, 'GET')
	}

	hasShutter(id: number) {
		return request<boolean>(this.url, `${id}/hasshutter`, 'GET')
	}

	getHeatSinkTemperature(id: number) {
		return request<number>(this.url, `${id}/heatsinktemperature`, 'GET')
	}

	// Downloads the last exposure as a raw ImageBytes ArrayBuffer. The response is binary rather than the
	// JSON envelope, so this is the one endpoint that cannot go through request, but it reports the
	// same result shape. Decoding the header and pixels is the caller's responsibility.
	async getImageArray(id: number): Promise<AlpacaRequestResult<ArrayBuffer>> {
		const url = new URL(`${id}/imagearray`, this.url)

		try {
			const response = await fetch(url, { headers: IMAGE_ARRAY_HEADERS })
			if (!response.ok) return failed('GET', url, (await response.text()) || `status ${response.status}`)
			return { ok: true, value: await response.arrayBuffer() }
		} catch (e) {
			return failed('GET', url, e instanceof Error ? e.message : String(e))
		}
	}

	isImageReady(id: number) {
		return request<boolean>(this.url, `${id}/imageready`, 'GET')
	}

	isPulseGuiding(id: number) {
		return request<boolean>(this.url, `${id}/ispulseguiding`, 'GET')
	}

	getLastExposureDuration(id: number) {
		return request<number>(this.url, `${id}/lastexposureduration`, 'GET')
	}

	getLastExposureStartTime(id: number) {
		return request<number>(this.url, `${id}/lastexposurestarttime`, 'GET')
	}

	getMaxAdu(id: number) {
		return request<number>(this.url, `${id}/maxadu`, 'GET')
	}

	getMaxBinX(id: number) {
		return request<number>(this.url, `${id}/maxbinx`, 'GET')
	}

	getMaxBinY(id: number) {
		return request<number>(this.url, `${id}/maxbiny`, 'GET')
	}

	getNumX(id: number) {
		return request<number>(this.url, `${id}/numx`, 'GET')
	}

	setNumX(id: number, NumX: number) {
		return request<void>(this.url, `${id}/numx`, 'PUT', { NumX })
	}

	getNumY(id: number) {
		return request<number>(this.url, `${id}/numy`, 'GET')
	}

	setNumY(id: number, NumY: number) {
		return request<void>(this.url, `${id}/numy`, 'PUT', { NumY })
	}

	getOffset(id: number) {
		return request<number>(this.url, `${id}/offset`, 'GET')
	}

	setOffset(id: number, Offset: number) {
		return request<void>(this.url, `${id}/offset`, 'PUT', { Offset })
	}

	getOffsetMax(id: number) {
		return request<number>(this.url, `${id}/offsetmax`, 'GET')
	}

	getOffsetMin(id: number) {
		return request<number>(this.url, `${id}/offsetmin`, 'GET')
	}

	getOffsets(id: number) {
		return request<readonly string[]>(this.url, `${id}/offsets`, 'GET')
	}

	getPercentCompleted(id: number) {
		return request<number>(this.url, `${id}/percentcompleted`, 'GET')
	}

	getPixelSizeX(id: number) {
		return request<number>(this.url, `${id}/pixelsizex`, 'GET')
	}

	getPixelSizeY(id: number) {
		return request<number>(this.url, `${id}/pixelsizey`, 'GET')
	}

	getReadoutMode(id: number) {
		return request<number>(this.url, `${id}/readoutmode`, 'GET')
	}

	setReadoutMode(id: number, ReadoutMode: number) {
		return request<void>(this.url, `${id}/readoutmode`, 'PUT', { ReadoutMode })
	}

	getReadoutModes(id: number) {
		return request<readonly string[]>(this.url, `${id}/readoutmodes`, 'GET')
	}

	getSensorName(id: number) {
		return request<string>(this.url, `${id}/sensorname`, 'GET')
	}

	getSensorType(id: number) {
		return request<AlpacaCameraSensorType>(this.url, `${id}/sensortype`, 'GET')
	}

	getSetCcdTemperature(id: number) {
		return request<number>(this.url, `${id}/setccdtemperature`, 'GET')
	}

	setSetCcdTemperature(id: number, SetCCDTemperature: number) {
		return request<void>(this.url, `${id}/setccdtemperature`, 'PUT', { SetCCDTemperature })
	}

	getStartX(id: number) {
		return request<number>(this.url, `${id}/startx`, 'GET')
	}

	setStartX(id: number, StartX: number) {
		return request<void>(this.url, `${id}/startx`, 'PUT', { StartX })
	}

	getStartY(id: number) {
		return request<number>(this.url, `${id}/starty`, 'GET')
	}

	setStartY(id: number, StartY: number) {
		return request<void>(this.url, `${id}/starty`, 'PUT', { StartY })
	}

	getSubExposureDuration(id: number) {
		return request<number>(this.url, `${id}/subexposureduration`, 'GET')
	}

	setSubExposureDuration(id: number, SubExposureDuration: number) {
		return request<void>(this.url, `${id}/subexposureduration`, 'PUT', { SubExposureDuration })
	}

	abortExposure(id: number) {
		return request<void>(this.url, `${id}/abortexposure`, 'PUT')
	}

	pulseGuide(id: number, Direction: AlpacaGuideDirection, Duration: number) {
		return request<void>(this.url, `${id}/pulseguide`, 'PUT', { Direction, Duration })
	}

	startExposure(id: number, Duration: number, Light: boolean) {
		return request<true>(this.url, `${id}/startexposure`, 'PUT', { Duration, Light }, undefined, true)
	}

	stopExposure(id: number) {
		return request<void>(this.url, `${id}/stopexposure`, 'PUT')
	}
}

// Telescope/mount device endpoints (coordinates, rates, parking, slewing, syncing, pulse guiding).
export class AlpacaTelescopeApi extends AlpacaDeviceApi {
	constructor(url: string | URL) {
		super(new URL('/api/v1/telescope/', url))
	}

	getAlignmentMode(id: number) {
		return request<AlpacaTelescopeAlignmentMode>(this.url, `${id}/alignmentmode`, 'GET')
	}

	getAltitude(id: number) {
		return request<number>(this.url, `${id}/altitude`, 'GET')
	}

	getApertureArea(id: number) {
		return request<number>(this.url, `${id}/aperturearea`, 'GET')
	}

	getApertureDiameter(id: number) {
		return request<number>(this.url, `${id}/aperturediameter`, 'GET')
	}

	isAtHome(id: number) {
		return request<boolean>(this.url, `${id}/athome`, 'GET')
	}

	isAtPark(id: number) {
		return request<boolean>(this.url, `${id}/atpark`, 'GET')
	}

	getAzimuth(id: number) {
		return request<number>(this.url, `${id}/azimuth`, 'GET')
	}

	canFindHome(id: number) {
		return request<boolean>(this.url, `${id}/canfindhome`, 'GET')
	}

	canPark(id: number) {
		return request<boolean>(this.url, `${id}/canpark`, 'GET')
	}

	canPulseGuide(id: number) {
		return request<boolean>(this.url, `${id}/canpulseguide`, 'GET')
	}

	canSetDeclinationRate(id: number) {
		return request<boolean>(this.url, `${id}/cansetdeclinationrate`, 'GET')
	}

	canSetGuideRates(id: number) {
		return request<boolean>(this.url, `${id}/cansetguiderates`, 'GET')
	}

	canSetPark(id: number) {
		return request<boolean>(this.url, `${id}/cansetpark`, 'GET')
	}

	canSetSideOfPier(id: number) {
		return request<boolean>(this.url, `${id}/cansetpierside`, 'GET')
	}

	canSetRightAscensionRate(id: number) {
		return request<boolean>(this.url, `${id}/cansetrightascensionrate`, 'GET')
	}

	canSetTracking(id: number) {
		return request<boolean>(this.url, `${id}/cansettracking`, 'GET')
	}

	canSlew(id: number) {
		return request<boolean>(this.url, `${id}/canslew`, 'GET')
	}

	canSlewAltaz(id: number) {
		return request<boolean>(this.url, `${id}/canslewaltaz`, 'GET')
	}

	canSlewAltazAsync(id: number) {
		return request<boolean>(this.url, `${id}/canslewaltazasync`, 'GET')
	}

	canSlewAsync(id: number) {
		return request<boolean>(this.url, `${id}/canslewasync`, 'GET')
	}

	canSync(id: number) {
		return request<boolean>(this.url, `${id}/cansync`, 'GET')
	}

	canSyncAltaz(id: number) {
		return request<boolean>(this.url, `${id}/cansyncaltaz`, 'GET')
	}

	canUnpark(id: number) {
		return request<boolean>(this.url, `${id}/canunpark`, 'GET')
	}

	getDeclination(id: number) {
		return request<number>(this.url, `${id}/declination`, 'GET')
	}

	getDeclinationRate(id: number) {
		return request<number>(this.url, `${id}/declinationrate`, 'GET')
	}

	setDeclinationRate(id: number, DeclinationRate: number) {
		return request<void>(this.url, `${id}/declinationrate`, 'PUT', { DeclinationRate })
	}

	getDoesRefraction(id: number) {
		return request<boolean>(this.url, `${id}/doesrefraction`, 'GET')
	}

	setDoesRefraction(id: number, DoesRefraction: boolean) {
		return request<void>(this.url, `${id}/doesrefraction`, 'PUT', { DoesRefraction })
	}

	getEquatorialSystem(id: number) {
		return request<AlpacaTelescopeEquatorialCoordinateType>(this.url, `${id}/equatorialsystem`, 'GET')
	}

	getFocalLength(id: number) {
		return request<number>(this.url, `${id}/focallength`, 'GET')
	}

	getGuideRateDeclination(id: number) {
		return request<number>(this.url, `${id}/guideratedeclination`, 'GET')
	}

	setGuideRateDeclination(id: number, GuideRateDeclination: number) {
		return request<void>(this.url, `${id}/guideratedeclination`, 'PUT', { GuideRateDeclination })
	}

	getGuideRateRightAscension(id: number) {
		return request<number>(this.url, `${id}/guideraterightascension`, 'GET')
	}

	setGuideRateRightAscension(id: number, GuideRateRightAscension: number) {
		return request<void>(this.url, `${id}/guideraterightascension`, 'PUT', { GuideRateRightAscension })
	}

	isPulseGuiding(id: number) {
		return request<boolean>(this.url, `${id}/ispulseguiding`, 'GET')
	}

	getRightAscension(id: number) {
		return request<number>(this.url, `${id}/rightascension`, 'GET')
	}

	getRightAscensionRate(id: number) {
		return request<number>(this.url, `${id}/rightascensionrate`, 'GET')
	}

	setRightAscensionRate(id: number, RightAscensionRate: number) {
		return request<void>(this.url, `${id}/rightascensionrate`, 'PUT', { RightAscensionRate })
	}

	getSideOfPier(id: number) {
		return request<AlpacaTelescopePierSide>(this.url, `${id}/sideofpier`, 'GET')
	}

	setSideOfPier(id: number, SideOfPier: AlpacaTelescopePierSide) {
		return request<void>(this.url, `${id}/sideofpier`, 'PUT', { SideOfPier })
	}

	getSiderealTime(id: number) {
		return request<number>(this.url, `${id}/siderealtime`, 'GET')
	}

	getSiteElevation(id: number) {
		return request<number>(this.url, `${id}/siteelevation`, 'GET')
	}

	setSiteElevation(id: number, SiteElevation: number) {
		return request<void>(this.url, `${id}/siteelevation`, 'PUT', { SiteElevation })
	}

	getSiteLatitude(id: number) {
		return request<number>(this.url, `${id}/sitelatitude`, 'GET')
	}

	setSiteLatitude(id: number, SiteLatitude: number) {
		return request<void>(this.url, `${id}/sitelatitude`, 'PUT', { SiteLatitude })
	}

	getSiteLongitude(id: number) {
		return request<number>(this.url, `${id}/sitelongitude`, 'GET')
	}

	setSiteLongitude(id: number, SiteLongitude: number) {
		return request<void>(this.url, `${id}/sitelongitude`, 'PUT', { SiteLongitude })
	}

	isSlewing(id: number) {
		return request<boolean>(this.url, `${id}/slewing`, 'GET')
	}

	getSlewSettleTime(id: number) {
		return request<number>(this.url, `${id}/slewsettletime`, 'GET')
	}

	setSlewSettleTime(id: number, SlewSettleTime: number) {
		return request<void>(this.url, `${id}/slewsettletime`, 'PUT', { SlewSettleTime })
	}

	getTargetDeclination(id: number) {
		return request<number>(this.url, `${id}/targetdeclination`, 'GET')
	}

	setTargetDeclination(id: number, TargetDeclination: number) {
		return request<void>(this.url, `${id}/targetdeclination`, 'PUT', { TargetDeclination })
	}

	getTargetRightAscension(id: number) {
		return request<number>(this.url, `${id}/targetrightascension`, 'GET')
	}

	setTargetRightAscension(id: number, TargetRightAscension: number) {
		return request<void>(this.url, `${id}/targetrightascension`, 'PUT', { TargetRightAscension })
	}

	isTracking(id: number) {
		return request<boolean>(this.url, `${id}/tracking`, 'GET')
	}

	setTracking(id: number, Tracking: boolean) {
		return request<void>(this.url, `${id}/tracking`, 'PUT', { Tracking })
	}

	getTrackingRate(id: number) {
		return request<AlpacaTelescopeTrackingRate>(this.url, `${id}/trackingrate`, 'GET')
	}

	setTrackingRate(id: number, TrackingRate: AlpacaTelescopeTrackingRate) {
		return request<void>(this.url, `${id}/trackingrate`, 'PUT', { TrackingRate })
	}

	getTrackingRates(id: number) {
		return request<readonly AlpacaTelescopeTrackingRate[]>(this.url, `${id}/trackingrates`, 'GET')
	}

	getUtcDate(id: number) {
		return request<string>(this.url, `${id}/utcdate`, 'GET')
	}

	setUtcDate(id: number, UTCDate: string) {
		return request<void>(this.url, `${id}/utcdate`, 'PUT', { UTCDate })
	}

	abortSlew(id: number) {
		return request<void>(this.url, `${id}/abortslew`, 'PUT')
	}

	getAxisRates(id: number, Axis: AlpacaTelescopeAxis) {
		return request<readonly AlpacaAxisRate[]>(this.url, `${id}/axisrates?Axis=${Axis}`, 'GET')
	}

	canMoveAxis(id: number, Axis: AlpacaTelescopeAxis) {
		return request<boolean>(this.url, `${id}/canmoveaxis?Axis=${Axis}`, 'GET')
	}

	getDestinationSideOfPier(id: number, RightAscension: number, Declination: number) {
		return request<AlpacaTelescopePierSide>(this.url, `${id}/destinationsideofpier?RightAscension=${RightAscension}&Declination=${Declination}`, 'GET')
	}

	findHome(id: number) {
		return request<void>(this.url, `${id}/findhome`, 'PUT')
	}

	moveAxis(id: number, Axis: AlpacaTelescopeAxis, Rate: number) {
		return request<void>(this.url, `${id}/moveaxis`, 'PUT', { Axis, Rate })
	}

	park(id: number) {
		return request<void>(this.url, `${id}/park`, 'PUT')
	}

	pulseGuide(id: number, Direction: AlpacaGuideDirection, Duration: number) {
		return request<void>(this.url, `${id}/pulseguide`, 'PUT', { Direction, Duration })
	}

	setPark(id: number) {
		return request<void>(this.url, `${id}/setpark`, 'PUT')
	}

	slewToAltaz(id: number, Azimuth: number, Altitude: number) {
		return request<void>(this.url, `${id}/slewtoaltaz`, 'PUT', { Azimuth, Altitude })
	}

	slewToAltazAsync(id: number, Azimuth: number, Altitude: number) {
		return request<void>(this.url, `${id}/slewtoaltazasync`, 'PUT', { Azimuth, Altitude })
	}

	slewToCoordinates(id: number, RightAscension: number, Declination: number) {
		return request<void>(this.url, `${id}/slewtocoordinates`, 'PUT', { RightAscension, Declination })
	}

	slewToCoordinatesAsync(id: number, RightAscension: number, Declination: number) {
		return request<void>(this.url, `${id}/slewtocoordinatesasync`, 'PUT', { RightAscension, Declination })
	}

	slewToTarget(id: number) {
		return request<void>(this.url, `${id}/slewtotarget`, 'PUT')
	}

	slewToTargetAsync(id: number) {
		return request<void>(this.url, `${id}/slewtotargetasync`, 'PUT')
	}

	syncToAltaz(id: number, Azimuth: number, Altitude: number) {
		return request<void>(this.url, `${id}/synctoaltaz`, 'PUT', { Azimuth, Altitude })
	}

	syncToCoordinates(id: number, RightAscension: number, Declination: number) {
		return request<void>(this.url, `${id}/synctocoordinates`, 'PUT', { RightAscension, Declination })
	}

	syncToTarget(id: number) {
		return request<void>(this.url, `${id}/synctotarget`, 'PUT')
	}

	unpark(id: number) {
		return request<void>(this.url, `${id}/unpark`, 'PUT')
	}
}

// Filter-wheel device endpoints (slot names, focus offsets, position).
export class AlpacaFilterWheelApi extends AlpacaDeviceApi {
	constructor(url: string | URL) {
		super(new URL('/api/v1/filterwheel/', url))
	}

	getFocusOffsets(id: number) {
		return request<readonly number[]>(this.url, `${id}/focusoffsets`, 'GET')
	}

	getNames(id: number) {
		return request<readonly string[]>(this.url, `${id}/names`, 'GET')
	}

	getPosition(id: number) {
		return request<number>(this.url, `${id}/position`, 'GET')
	}

	setPosition(id: number, Position: number) {
		return request<void>(this.url, `${id}/position`, 'PUT', { Position })
	}
}

// Focuser device endpoints (absolute/relative move, limits, temperature compensation).
export class AlpacaFocuserApi extends AlpacaDeviceApi {
	constructor(url: string | URL) {
		super(new URL('/api/v1/focuser/', url))
	}

	isAbsolute(id: number) {
		return request<boolean>(this.url, `${id}/absolute`, 'GET')
	}

	isMoving(id: number) {
		return request<boolean>(this.url, `${id}/ismoving`, 'GET')
	}

	getMaxIncrement(id: number) {
		return request<number>(this.url, `${id}/maxincrement`, 'GET')
	}

	getMaxStep(id: number) {
		return request<number>(this.url, `${id}/maxstep`, 'GET')
	}

	getPosition(id: number) {
		return request<number>(this.url, `${id}/position`, 'GET')
	}

	getStepSize(id: number) {
		return request<number>(this.url, `${id}/stepsize`, 'GET')
	}

	isTemperatureCompensation(id: number) {
		return request<boolean>(this.url, `${id}/tempcomp`, 'GET')
	}

	setTemperatureCompensation(id: number, TempComp: boolean) {
		return request<void>(this.url, `${id}/tempcomp`, 'PUT', { TempComp })
	}

	isTemperatureCompensationAvailable(id: number) {
		return request<boolean>(this.url, `${id}/tempcompavailable`, 'GET')
	}

	getTemperature(id: number) {
		return request<number>(this.url, `${id}/temperature`, 'GET')
	}

	halt(id: number) {
		return request<void>(this.url, `${id}/halt`, 'PUT')
	}

	move(id: number, Position: number) {
		return request<void>(this.url, `${id}/move`, 'PUT', { Position })
	}
}

// Cover-calibrator device endpoints (cover open/close, calibrator brightness on/off).
export class AlpacaCoverCalibratorApi extends AlpacaDeviceApi {
	constructor(url: string | URL) {
		super(new URL('/api/v1/covercalibrator/', url))
	}

	getBrightness(id: number) {
		return request<number>(this.url, `${id}/brightness`, 'GET')
	}

	getCalibratorState(id: number) {
		return request<number>(this.url, `${id}/calibratorstate`, 'GET')
	}

	getCoverState(id: number) {
		return request<number>(this.url, `${id}/coverstate`, 'GET')
	}

	isChanging(id: number) {
		return request<boolean>(this.url, `${id}/calibratorchanging`, 'GET')
	}

	isMoving(id: number) {
		return request<boolean>(this.url, `${id}/covermoving`, 'GET')
	}

	getMaxBrightness(id: number) {
		return request<number>(this.url, `${id}/maxbrightness`, 'GET')
	}

	off(id: number) {
		return request<void>(this.url, `${id}/calibratoroff`, 'PUT')
	}

	on(id: number, Brightness: number) {
		return request<void>(this.url, `${id}/calibratoron`, 'PUT', { Brightness })
	}

	close(id: number) {
		return request<void>(this.url, `${id}/closecover`, 'PUT')
	}

	halt(id: number) {
		return request<void>(this.url, `${id}/haltcover`, 'PUT')
	}

	open(id: number) {
		return request<void>(this.url, `${id}/opencover`, 'PUT')
	}
}

// Rotator device endpoints (mechanical/sky position, reverse, absolute/relative/mechanical move, sync).
export class AlpacaRotatorApi extends AlpacaDeviceApi {
	constructor(url: string | URL) {
		super(new URL('/api/v1/rotator/', url))
	}

	canReverse(id: number) {
		return request<boolean>(this.url, `${id}/canreverse`, 'GET')
	}

	getMechanicalPosition(id: number) {
		return request<number>(this.url, `${id}/mechanicalposition`, 'GET')
	}

	getPosition(id: number) {
		return request<number>(this.url, `${id}/position`, 'GET')
	}

	isMoving(id: number) {
		return request<boolean>(this.url, `${id}/ismoving`, 'GET')
	}

	isReverse(id: number) {
		return request<boolean>(this.url, `${id}/reverse`, 'GET')
	}

	setReverse(id: number, Reverse: boolean) {
		return request<boolean>(this.url, `${id}/reverse`, 'PUT', { Reverse })
	}

	getStepSize(id: number) {
		return request<number>(this.url, `${id}/stepsize`, 'GET')
	}

	getTargetPosition(id: number) {
		return request<number>(this.url, `${id}/targetposition`, 'GET')
	}

	halt(id: number) {
		return request<void>(this.url, `${id}/halt`, 'PUT')
	}

	move(id: number, Position: number) {
		return request<void>(this.url, `${id}/move`, 'PUT', { Position })
	}

	moveAbsolute(id: number, Position: number) {
		return request<void>(this.url, `${id}/moveabsolute`, 'PUT', { Position })
	}

	moveMechanical(id: number, Position: number) {
		return request<void>(this.url, `${id}/movemechanical`, 'PUT', { Position })
	}

	sync(id: number, Position: number) {
		return request<void>(this.url, `${id}/sync`, 'PUT', { Position })
	}
}

// Alpaca Dome endpoints: altitude/azimuth, home/park, shutter, slaving, and asynchronous motion.
export class AlpacaDomeApi extends AlpacaDeviceApi {
	constructor(url: string | URL) {
		super(new URL('/api/v1/dome/', url))
	}

	getAltitude(id: number) {
		return request<number>(this.url, `${id}/altitude`, 'GET')
	}

	isAtHome(id: number) {
		return request<boolean>(this.url, `${id}/athome`, 'GET')
	}

	isAtPark(id: number) {
		return request<boolean>(this.url, `${id}/atpark`, 'GET')
	}

	getAzimuth(id: number) {
		return request<number>(this.url, `${id}/azimuth`, 'GET')
	}

	canFindHome(id: number) {
		return request<boolean>(this.url, `${id}/canfindhome`, 'GET')
	}

	canPark(id: number) {
		return request<boolean>(this.url, `${id}/canpark`, 'GET')
	}

	canSetAltitude(id: number) {
		return request<boolean>(this.url, `${id}/cansetaltitude`, 'GET')
	}

	canSetAzimuth(id: number) {
		return request<boolean>(this.url, `${id}/cansetazimuth`, 'GET')
	}

	canSetPark(id: number) {
		return request<boolean>(this.url, `${id}/cansetpark`, 'GET')
	}

	canSetShutter(id: number) {
		return request<boolean>(this.url, `${id}/cansetshutter`, 'GET')
	}

	canSlave(id: number) {
		return request<boolean>(this.url, `${id}/canslave`, 'GET')
	}

	canSyncAzimuth(id: number) {
		return request<boolean>(this.url, `${id}/cansyncazimuth`, 'GET')
	}

	getShutterStatus(id: number) {
		return request<AlpacaDomeShutterState>(this.url, `${id}/shutterstatus`, 'GET')
	}

	isSlaved(id: number) {
		return request<boolean>(this.url, `${id}/slaved`, 'GET')
	}

	isSlewing(id: number) {
		return request<boolean>(this.url, `${id}/slewing`, 'GET')
	}

	setSlaved(id: number, Slaved: boolean) {
		return request<void>(this.url, `${id}/slaved`, 'PUT', { Slaved })
	}

	abortSlew(id: number) {
		return request<void>(this.url, `${id}/abortslew`, 'PUT')
	}

	closeShutter(id: number) {
		return request<void>(this.url, `${id}/closeshutter`, 'PUT')
	}

	findHome(id: number) {
		return request<void>(this.url, `${id}/findhome`, 'PUT')
	}

	openShutter(id: number) {
		return request<void>(this.url, `${id}/openshutter`, 'PUT')
	}

	park(id: number) {
		return request<void>(this.url, `${id}/park`, 'PUT')
	}

	setPark(id: number) {
		return request<void>(this.url, `${id}/setpark`, 'PUT')
	}

	slewToAltitude(id: number, Altitude: number) {
		return request<void>(this.url, `${id}/slewtoaltitude`, 'PUT', { Altitude })
	}

	slewToAzimuth(id: number, Azimuth: number) {
		return request<void>(this.url, `${id}/slewtoazimuth`, 'PUT', { Azimuth })
	}

	syncToAzimuth(id: number, Azimuth: number) {
		return request<void>(this.url, `${id}/synctoazimuth`, 'PUT', { Azimuth })
	}
}

// Per-process client identifier sent with every request, derived from the start time (positive int32).
const CLIENT_ID = (Date.now() & 0x7fffffff).toFixed(0)

// Encodes PUT parameters as Alpaca form data: booleans become 'True'/'False', numbers are stringified,
// and the ClientID/ClientTransactionID fields are appended. Mutates and returns the params as a query.
function makeFormDataFromParams(params: Record<string, string | number | boolean>) {
	for (const key in params) {
		const value = params[key]

		if (value === true) params[key] = 'True'
		else if (value === false) params[key] = 'False'
		else if (typeof value === 'number') params[key] = value.toString()
	}

	params.ClientID = CLIENT_ID
	params.ClientTransactionID = '0'

	return new URLSearchParams(params as never)
}

// Builds a failure result, logging everything except an unimplemented member.
//
// MethodOrPropertyNotImplemented (1024) is the normal answer for an optional Alpaca member, not an error:
// capability discovery hits it once per unsupported property, and logging those would flood the console
// on every connect for no benefit. Every other failure is a real one and stays visible.
function failed(method: string, url: URL, errorMessage: string, errorNumber?: number): AlpacaRequestFailedResult {
	if (errorNumber !== 1024) {
		console.error('request failed:', method, url.href, errorNumber ?? '', errorMessage)
	}

	return { ok: false, errorNumber, errorMessage }
}

// Performs one Alpaca REST call and unwraps the AlpacaResponse envelope, preserving why it failed so the
// caller can tell an unimplemented member from a transient fault. Parameters are sent as a form body on
// PUT and as a query string on GET, which is how ASCOM passes SensorName and friends.
async function request<T>(url: string | URL, path: string, method: 'GET' | 'PUT', body?: Record<string, string | number | boolean>, headers?: HeadersInit, defaultValue?: T): Promise<AlpacaRequestResult<T>> {
	const target = new URL(path, url)
	const params = body && makeFormDataFromParams(body)

	if (params && method === 'GET') target.search = params.toString()

	try {
		const response = await fetch(target, { method, headers, body: method === 'PUT' ? params : undefined })

		const text = await response.text()

		if (!response.ok) return failed(method, target, text || `status ${response.status}`)
		if (!text) return failed(method, target, 'empty response')

		const json = JSON.parse(text) as AlpacaResponse<T>

		if (json.ErrorNumber !== 0) return failed(method, target, json.ErrorMessage, json.ErrorNumber)

		return { ok: true, value: (json.Value ?? defaultValue) as T }
	} catch (e) {
		return failed(method, target, errorMessage(e))
	}
}
