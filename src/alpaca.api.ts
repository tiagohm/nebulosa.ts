import type { AlpacaAxisRate, AlpacaConfiguredDevice, AlpacaResponse, AlpacaStateItem } from './alpaca.types'

// https://ascom-standards.org/api/

export class AlpacaApi {
	readonly management: AlpacaManagementApi
	readonly telescope: AlpacaTelescopeApi
	readonly filterWheel: AlpacaFilterWheelApi
	readonly focuser: AlpacaFocuserApi
	readonly coverCalibrator: AlpacaCoverCalibratorApi

	constructor(readonly url: string | URL) {
		this.management = new AlpacaManagementApi(url)
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

export class AlpacaTelescopeApi extends AlpacaDeviceApi {
	constructor(url: string | URL) {
		super(new URL('/api/v1/telescope/', url))
	}

	getAlignmentMode(id: number) {
		return request<number>(this.url, `${id}/alignmentmode`, 'GET')
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

	canSetPierSide(id: number) {
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
		return request<number>(this.url, `${id}/equatorialsystem`, 'GET')
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
		return request<number>(this.url, `${id}/sideofpier`, 'GET')
	}

	setSideOfPier(id: number, SideOfPier: number) {
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
		return request<number>(this.url, `${id}/trackingrate`, 'GET')
	}

	setTrackingRate(id: number, TrackingRate: number) {
		return request<void>(this.url, `${id}/trackingrate`, 'PUT', { TrackingRate })
	}

	getTrackingRates(id: number) {
		return request<readonly number[]>(this.url, `${id}/trackingrates`, 'GET')
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

	getAxisRates(id: number, Axis: number) {
		return request<readonly AlpacaAxisRate[]>(this.url, `${id}/axisrates?Axis=${Axis}`, 'GET')
	}

	canMoveAxis(id: number, Axis: number) {
		return request<boolean>(this.url, `${id}/canmoveaxis?Axis=${Axis}`, 'GET')
	}

	getDestinationSideOfPier(id: number) {
		return request<number>(this.url, `${id}/destinationsideofpier`, 'GET')
	}

	findHome(id: number) {
		return request<void>(this.url, `${id}/findhome`, 'PUT')
	}

	moveAxis(id: number, Axis: number, Rate: number) {
		return request<void>(this.url, `${id}/moveaxis`, 'PUT', { Axis, Rate })
	}

	park(id: number) {
		return request<void>(this.url, `${id}/park`, 'PUT')
	}

	pulseGuide(id: number, Direction: number, Duration: number) {
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
		const response = await fetch(new URL(path, url), { method, headers, body: body && method === 'PUT' ? makeFormDataFromParams(body) : undefined })

		const text = await response.text()

		if (response.ok) {
			if (text) {
				const json = JSON.parse(text) as AlpacaResponse<T>

				if (json.ErrorNumber === 0) {
					return json.Value ?? defaultValue
				}

				console.error('response error:', url, path, json.ErrorNumber, json.ErrorMessage)
			} else {
				console.error('request without response:', url, path)
			}
		} else {
			console.error('request failed:', url, path, text)
		}
	} catch (e) {
		console.error('failed to fetch:', url, path, e)
	}

	return undefined
}
