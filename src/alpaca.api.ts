// biome-ignore format: too long!
import type { AlpacaAxisRate, AlpacaCameraSensorType, AlpacaCameraState, AlpacaConfiguredDevice, AlpacaGuideDirection, AlpacaResponse, AlpacaStateItem, AlpacaTelescopeAlignmentMode, AlpacaTelescopeAxis, AlpacaTelescopeEquatorialCoordinateType, AlpacaTelescopePierSide, AlpacaTelescopeTrackingRate } from './alpaca.types'

// https://ascom-standards.org/api/

const IMAGE_ARRAY_HEADERS: HeadersInit = {
	Accept: 'application/imagebytes',
}

export class AlpacaApi {
	readonly management: AlpacaManagementApi
	readonly telescope: AlpacaTelescopeApi
	readonly camera: AlpacaCameraApi
	readonly filterWheel: AlpacaFilterWheelApi
	readonly focuser: AlpacaFocuserApi
	readonly coverCalibrator: AlpacaCoverCalibratorApi

	constructor(readonly url: string | URL) {
		this.management = new AlpacaManagementApi(url)
		this.camera = new AlpacaCameraApi(url)
		this.telescope = new AlpacaTelescopeApi(url)
		this.filterWheel = new AlpacaFilterWheelApi(url)
		this.focuser = new AlpacaFocuserApi(url)
		this.coverCalibrator = new AlpacaCoverCalibratorApi(url)
	}
}

export class AlpacaManagementApi {
	constructor(readonly url: string | URL) {}

	async configuredDevices() {
		const devices = await request<readonly AlpacaConfiguredDevice[]>(this.url, 'management/v1/configureddevices', 'GET')
		if (devices) for (const device of devices) (device as unknown as Record<string, string>).DeviceType = device.DeviceType.toLowerCase()
		return devices
	}
}

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
		return request<number>(this.url, `${id}/hasshutter`, 'GET')
	}

	getHeatSinkTemperature(id: number) {
		return request<number>(this.url, `${id}/heatsinktemperature`, 'GET')
	}

	async getImageArray(id: number) {
		const response = await fetch(new URL(`${id}/imagearray`, this.url), { headers: IMAGE_ARRAY_HEADERS })

		if (response.ok) {
			return await response.arrayBuffer()
		}

		console.error('failed to fetch image array:', await response.text())

		return undefined
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
		return request<void>(this.url, `${id}/startexposure`, 'PUT', { Duration, Light })
	}

	stopExposure(id: number) {
		return request<void>(this.url, `${id}/stopexposure`, 'PUT')
	}
}

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

	getDestinationSideOfPier(id: number) {
		return request<number>(this.url, `${id}/destinationsideofpier`, 'GET')
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
		return request(this.url, `${id}/position`, 'PUT', { Position })
	}
}

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

const CLIENT_ID = (Date.now() & 0x7fffffff).toFixed(0)

function makeFormDataFromParams(params: Record<string, string | number | boolean>) {
	const body = new FormData()

	body.set('ClientID', CLIENT_ID)
	body.set('ClientTransactionID', '0')

	for (const [name, value] of Object.entries(params)) {
		body.set(name, typeof value === 'string' ? value : typeof value === 'number' ? `${value}` : value ? 'True' : 'False')
	}

	return body
}

async function request<T>(url: string | URL, path: string, method: 'GET' | 'PUT', body?: Record<string, string | number | boolean>, headers?: HeadersInit, defaultValue?: T) {
	try {
		url = new URL(path, url)
		const response = await fetch(url, { method, headers, body: body && method === 'PUT' ? makeFormDataFromParams(body) : undefined })

		const text = await response.text()

		if (response.ok) {
			if (text) {
				const json = JSON.parse(text) as AlpacaResponse<T>

				if (json.ErrorNumber === 0) {
					return json.Value ?? defaultValue
				}

				console.error('response error:', url.href, json.ErrorNumber, json.ErrorMessage)
			} else {
				console.error('request without response:', url.href)
			}
		} else {
			console.error('request failed:', url.href, text)
		}
	} catch (e) {
		console.error('failed to fetch:', url, e)
	}

	return undefined
}
