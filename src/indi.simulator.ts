import type { Angle } from './angle'
import { deg, hour, normalizeAngle, normalizePI, toDeg, toHour } from './angle'
import { ASEC2RAD, DAYSEC, DEG2RAD, MOON_SIDEREAL_DAYS, PIOVERTWO, SIDEREAL_DAYSEC, SIDEREAL_RATE, TAU } from './constants'
import type { EquatorialCoordinate } from './coordinate'
import { meter, toMeter } from './distance'
import { handleDefNumberVector, handleDefSwitchVector, handleDefTextVector, handleDelProperty, handleSetNumberVector, handleSetSwitchVector, handleSetTextVector, type IndiClientHandler } from './indi.client'
import { type Client, DeviceInterfaceType, type DeviceType, expectedPierSide, type GuideDirection, type NameAndLabel, type PierSide, type TrackMode, type UTCTime } from './indi.device'
import { type EnableBlob, findOnSwitch, type GetProperties, makeNumberVector, makeSwitchVector, makeTextVector, type NewNumberVector, type NewSwitchVector, type NewTextVector, type SetVector, selectOnSwitch } from './indi.types'
import { type GeographicCoordinate, localSiderealTime } from './location'
import { clamp } from './math'
import { formatTemporal, TIMEZONE } from './temporal'
import { timeUnix } from './time'

const TICK_INTERVAL_MS = 100
const SIDEREAL_DRIFT_RATE = TAU / SIDEREAL_DAYSEC
const SOLAR_DRIFT_RATE = TAU / (365.2422 * DAYSEC)
const LUNAR_DRIFT_RATE = TAU / (MOON_SIDEREAL_DAYS * DAYSEC)
const KING_DRIFT_RATE = (SIDEREAL_RATE - 15.0369) * ASEC2RAD
const MAX_GUIDE_RATE = 1

const SLEW_RATES = [
	{ name: '1x', label: '0.5°', speed: 0.5 * DEG2RAD },
	{ name: '2x', label: '1.0°', speed: 1.0 * DEG2RAD },
	{ name: '4x', label: '2.0°', speed: 2.0 * DEG2RAD },
	{ name: '8x', label: '4.0°', speed: 4.0 * DEG2RAD },
	{ name: '16x', label: '8.0°', speed: 8.0 * DEG2RAD },
	{ name: '32x', label: '16.0°', speed: 16.0 * DEG2RAD },
	{ name: '64x', label: '32.0°', speed: 32.0 * DEG2RAD },
] as const

type CoordSetMode = 'SLEW' | 'SYNC'

type SlewMode = 'GOTO' | 'HOME' | 'PARK'

type AxisDirection = -1 | 0 | 1

// Routes MountManager commands back into the simulator.
export class ClientSimulator implements Client {
	readonly type = 'SIMULATOR'

	#devices = new Map<DeviceType, DeviceSimulator>()

	constructor(
		readonly id: string,
		readonly handler: IndiClientHandler,
		readonly description: string = 'Client Simulator',
	) {}

	getProperties(command?: GetProperties) {}

	enableBlob(command: EnableBlob) {}

	sendText(vector: NewTextVector) {
		for (const device of this.#devices) device[1].name === vector.device && device[1].sendText(vector)
	}

	sendNumber(vector: NewNumberVector) {
		for (const device of this.#devices) device[1].name === vector.device && device[1].sendNumber(vector)
	}

	sendSwitch(vector: NewSwitchVector) {
		for (const device of this.#devices) device[1].name === vector.device && device[1].sendSwitch(vector)
	}

	register(device: DeviceSimulator) {
		this.#devices.set(device.type, device)
	}

	unregister(device: DeviceSimulator) {
		this.#devices.delete(device.type)
	}

	[Symbol.dispose]() {
		for (const device of this.#devices) device[1].dispose()
	}
}

const MAIN_CONTROL = 'Main Control'
const GENERAL_INFO = 'General Info'
const SIMULATION = 'Simulation'

export abstract class DeviceSimulator implements Disposable {
	abstract readonly type: DeviceType

	protected readonly driverInfo = makeTextVector('', 'DRIVER_INFO', 'Driver Info', GENERAL_INFO, 'ro', ['DRIVER_INTERFACE', 'Interface', ''], ['DRIVER_EXEC', 'Exec', ''], ['DRIVER_VERSION', 'Version', '1.0'], ['DRIVER_NAME', 'Name', ''])
	protected readonly connection = makeSwitchVector('', 'CONNECTION', 'Connection', MAIN_CONTROL, 'OneOfMany', 'rw', ['CONNECT', 'Connect', false], ['DISCONNECT', 'Disconnect', true])

	constructor(
		readonly name: string,
		readonly client: ClientSimulator,
		readonly handler: IndiClientHandler,
		interfaceType: DeviceInterfaceType,
	) {
		this.driverInfo.device = name
		this.driverInfo.elements.DRIVER_INTERFACE.value = interfaceType.toFixed(0)
		this.connection.device = name
		client.register(this)

		handleDefTextVector(client, handler, this.driverInfo)
		handleDefSwitchVector(client, handler, this.connection)
	}

	get isConnected() {
		return this.connection.elements.CONNECT.value
	}

	abstract sendText(vector: NewTextVector): void
	abstract sendNumber(vector: NewNumberVector): void
	abstract sendSwitch(vector: NewSwitchVector): void
	abstract dispose(): void

	// Connects the simulated device.
	connect() {
		if (this.isConnected) return
		selectOnSwitch(this.connection, 'CONNECT') && handleSetSwitchVector(this.client, this.handler, this.connection)
	}

	// Disconnects the simulated device.
	disconnect() {
		if (!this.isConnected) return
		selectOnSwitch(this.connection, 'DISCONNECT') && handleSetSwitchVector(this.client, this.handler, this.connection)
	}

	notify(message: SetVector & { type: 'SWITCH' | 'TEXT' | 'NUMBER' }) {
		const type = message.type[0]

		if (type === 'S') handleSetSwitchVector(this.client, this.handler, message as never)
		else if (type === 'N') handleSetNumberVector(this.client, this.handler, message as never)
		else if (type === 'T') handleSetTextVector(this.client, this.handler, message as never)
	}

	[Symbol.dispose]() {
		this.dispose()
	}
}

export class MountSimulator extends DeviceSimulator {
	readonly type = 'MOUNT'
	readonly trackModes = ['SIDEREAL', 'SOLAR', 'LUNAR', 'KING'] as const

	readonly #onCoordSet = makeSwitchVector('', 'ON_COORD_SET', 'On Set', MAIN_CONTROL, 'OneOfMany', 'rw', ['SLEW', 'Slew', false], ['SYNC', 'Sync', false])
	readonly #equatorialCoordinate = makeNumberVector('', 'EQUATORIAL_EOD_COORD', 'Eq. Coordinates', MAIN_CONTROL, 'rw', ['RA', 'RA (hours)', 0, 0, 24, 0.1, '%10.6f'], ['DEC', 'DEC (deg)', 0, -90, 90, 0.1, '%10.6f'])
	readonly #abort = makeSwitchVector('', 'TELESCOPE_ABORT_MOTION', 'Abort', MAIN_CONTROL, 'AtMostOne', 'rw', ['ABORT', 'Abort', false])
	readonly #trackMode = makeSwitchVector('', 'TELESCOPE_TRACK_MODE', 'Track Mode', MAIN_CONTROL, 'OneOfMany', 'rw', ['TRACK_SIDEREAL', 'Sidereal', true], ['TRACK_SOLAR', 'Solar', false], ['TRACK_LUNAR', 'Lunar', false], ['TRACK_KING', 'King', false])
	readonly #tracking = makeSwitchVector('', 'TELESCOPE_TRACK_STATE', 'Tracking', MAIN_CONTROL, 'OneOfMany', 'rw', ['TRACK_ON', 'On', false], ['TRACK_OFF', 'Off', true])
	readonly #home = makeSwitchVector('', 'TELESCOPE_HOME', 'Home', MAIN_CONTROL, 'AtMostOne', 'rw', ['GO', 'Go', false], ['SET', 'Set', false])
	readonly #motionNS = makeSwitchVector('', 'TELESCOPE_MOTION_NS', 'Motion N/S', MAIN_CONTROL, 'AtMostOne', 'rw', ['MOTION_NORTH', 'North', false], ['MOTION_SOUTH', 'South', false])
	readonly #motionWE = makeSwitchVector('', 'TELESCOPE_MOTION_WE', 'Motion W/E', MAIN_CONTROL, 'AtMostOne', 'rw', ['MOTION_WEST', 'West', false], ['MOTION_EAST', 'East', false])
	readonly #slewRate = makeSwitchVector('', 'TELESCOPE_SLEW_RATE', 'Slew Rate', MAIN_CONTROL, 'OneOfMany', 'rw')
	readonly #time = makeTextVector('', 'TIME_UTC', 'UTC', MAIN_CONTROL, 'rw', ['UTC', 'UTC Time', formatTemporal(Date.now(), 'YYYY-MM-DDTHH:mm:ss.SSSZ', 0)], ['OFFSET', 'UTC Offset', (TIMEZONE / 60).toFixed(2)])
	readonly #geographicCoordinate = makeNumberVector('', 'GEOGRAPHIC_COORD', 'Location', MAIN_CONTROL, 'rw', ['LAT', 'Latitude (deg)', 0, -90, 90, 0.1, '%12.8f'], ['LONG', 'Longitude (deg)', 0, 0, 360, 0.1, '%12.8f'], ['ELEV', 'Elevation (m)', 0, -200, 10000, 1, '%.1f'])
	readonly #park = makeSwitchVector('', 'TELESCOPE_PARK', 'Parking', MAIN_CONTROL, 'OneOfMany', 'rw', ['PARK', 'Park', false], ['UNPARK', 'Unpark', true])
	readonly #parkOptions = makeSwitchVector('', 'TELESCOPE_PARK_OPTION', 'Park Options', MAIN_CONTROL, 'AtMostOne', 'rw', ['PARK_CURRENT', 'Current', false])
	readonly #pierSide = makeSwitchVector('', 'TELESCOPE_PIER_SIDE', 'Pier Side', MAIN_CONTROL, 'AtMostOne', 'ro', ['PIER_EAST', 'East', false], ['PIER_WEST', 'West', false])
	readonly #guideRate = makeNumberVector('', 'GUIDE_RATE', 'Guiding Rate', MAIN_CONTROL, 'ro', ['GUIDE_RATE_WE', 'W/E Rate', 0.5, 0, 1, 0.1, '%.8f'], ['GUIDE_RATE_NS', 'N/E Rate', 0.5, 0, 1, 0.1, '%.0f'])
	readonly #guideNS = makeNumberVector('', 'TELESCOPE_TIMED_GUIDE_NS', 'Guide N/S', MAIN_CONTROL, 'rw', ['TIMED_GUIDE_N', 'North (ms)', 0, 0, 60000, 1, '%.0f'], ['TIMED_GUIDE_S', 'South (ms)', 0, 0, 60000, 1, '%.0f'])
	readonly #guideWE = makeNumberVector('', 'TELESCOPE_TIMED_GUIDE_WE', 'Guide W/E', MAIN_CONTROL, 'rw', ['TIMED_GUIDE_W', 'West (ms)', 0, 0, 60000, 1, '%.0f'], ['TIMED_GUIDE_E', 'East (ms)', 0, 0, 60000, 1, '%.0f'])

	#timer?: NodeJS.Timeout
	#lastTick = 0
	#coordSetMode: CoordSetMode = 'SLEW'
	#slewMode?: SlewMode
	#slewTarget?: EquatorialCoordinate<Angle>
	#manualNorthSouth: AxisDirection = 0
	#manualWestEast: AxisDirection = 0
	#pulseNorthSouth: AxisDirection = 0
	#pulseWestEast: AxisDirection = 0
	#pulseNorthSouthUntil = 0
	#pulseWestEastUntil = 0
	#homeCoordinate: EquatorialCoordinate<Angle> = { rightAscension: 0, declination: PIOVERTWO }
	#parkCoordinate: EquatorialCoordinate<Angle> = { rightAscension: 0, declination: PIOVERTWO }
	#utcTime = Date.now()
	#utcOffset = TIMEZONE / 60

	constructor(name: string, client: ClientSimulator, handler: IndiClientHandler = client.handler) {
		super(name, client, handler, DeviceInterfaceType.TELESCOPE)

		this.#onCoordSet.device = name
		this.#equatorialCoordinate.device = name
		this.#abort.device = name
		this.#trackMode.device = name
		this.#tracking.device = name
		this.#home.device = name
		this.#motionNS.device = name
		this.#motionWE.device = name
		this.#slewRate.device = name
		this.#time.device = name
		this.#geographicCoordinate.device = name
		this.#park.device = name
		this.#parkOptions.device = name
		this.#pierSide.device = name
		this.#guideRate.device = name
		this.#guideNS.device = name
		this.#guideWE.device = name

		const { elements } = this.#slewRate

		for (const rate of SLEW_RATES) {
			elements[rate.name] = { name: rate.name, label: rate.label, value: rate.name === '8x' }
		}
	}

	get rightAscension() {
		return hour(this.#equatorialCoordinate.elements.RA.value)
	}

	get declination() {
		return deg(this.#equatorialCoordinate.elements.DEC.value)
	}

	get isParked() {
		return this.#park.elements.PARK.value
	}

	get isTracking() {
		return this.#tracking.elements.TRACK_ON.value
	}

	get isHoming() {
		return this.#home.state === 'Busy'
	}

	get isSlewing() {
		return this.#equatorialCoordinate.state === 'Busy'
	}

	get isPulsing() {
		return this.#guideNS.state === 'Busy'
	}

	get isParking() {
		return this.#park.state === 'Busy'
	}

	get trackMode(): TrackMode {
		const { TRACK_SIDEREAL, TRACK_SOLAR, TRACK_LUNAR } = this.#trackMode.elements
		return TRACK_SIDEREAL.value ? 'SIDEREAL' : TRACK_SOLAR.value ? 'SOLAR' : TRACK_LUNAR.value ? 'LUNAR' : 'KING'
	}

	get longitude() {
		return deg(this.#geographicCoordinate.elements.LONG.value)
	}

	get latitude() {
		return deg(this.#geographicCoordinate.elements.LAT.value)
	}

	get elevation() {
		return meter(this.#geographicCoordinate.elements.ELEV.value)
	}

	get guideRateRightAscension() {
		return this.#guideRate.elements.GUIDE_RATE_WE.value
	}

	get guideRateDeclination() {
		return this.#guideRate.elements.GUIDE_RATE_NS.value
	}

	get slewRate() {
		return findOnSwitch(this.#slewRate)[0]
	}

	get pierSide(): PierSide {
		return this.#pierSide.elements.PIER_EAST.value ? 'EAST' : this.#pierSide.elements.PIER_WEST.value ? 'WEST' : 'NEITHER'
	}

	sendText(vector: NewTextVector) {
		switch (vector.name) {
			case 'TIME_UTC':
				if (vector.elements.UTC) {
					const utc = Date.parse(`${vector.elements.UTC}Z`)
					const offset = Math.trunc(+vector.elements.OFFSET * 60)
					if (!Number.isNaN(utc)) this.setTime({ utc, offset })
				}

				return
		}
	}

	sendNumber(vector: NewNumberVector) {
		switch (vector.name) {
			case 'EQUATORIAL_EOD_COORD': {
				const rightAscension = vector.elements.RA !== undefined ? hour(vector.elements.RA) : this.rightAscension
				const declination = vector.elements.DEC !== undefined ? deg(vector.elements.DEC) : this.declination

				if (this.#coordSetMode === 'SYNC') this.syncTo(rightAscension, declination)
				else this.goTo(rightAscension, declination)

				return
			}
			case 'GEOGRAPHIC_COORD':
				this.setGeographicCoordinate({
					latitude: vector.elements.LAT !== undefined ? deg(vector.elements.LAT) : this.latitude,
					longitude: vector.elements.LONG !== undefined ? normalizePI(deg(vector.elements.LONG)) : this.longitude,
					elevation: vector.elements.ELEV ?? this.elevation,
				})

				return
			case 'GUIDE_RATE':
				this.setGuideRate(vector.elements.GUIDE_RATE_WE ?? this.guideRateRightAscension, vector.elements.GUIDE_RATE_NS ?? this.guideRateDeclination)

				return
			case 'TELESCOPE_TIMED_GUIDE_NS':
				if ((vector.elements.TIMED_GUIDE_N ?? 0) > 0) this.pulse('NORTH', vector.elements.TIMED_GUIDE_N)
				else if ((vector.elements.TIMED_GUIDE_S ?? 0) > 0) this.pulse('SOUTH', vector.elements.TIMED_GUIDE_S)
				return
			case 'TELESCOPE_TIMED_GUIDE_WE':
				if ((vector.elements.TIMED_GUIDE_W ?? 0) > 0) this.pulse('WEST', vector.elements.TIMED_GUIDE_W)
				else if ((vector.elements.TIMED_GUIDE_E ?? 0) > 0) this.pulse('EAST', vector.elements.TIMED_GUIDE_E)
				return
		}
	}

	sendSwitch(vector: NewSwitchVector) {
		switch (vector.name) {
			case 'CONNECTION':
				if (vector.elements.CONNECT === true) this.connect()
				else if (vector.elements.DISCONNECT === true) this.disconnect()
				return
			case 'TELESCOPE_ABORT_MOTION':
				if (vector.elements.ABORT === true) this.stop()
				return
			case 'TELESCOPE_HOME':
				if (vector.elements.GO === true || vector.elements.FIND === true) this.home()
				else if (vector.elements.SET === true) this.setHome()
				return
			case 'TELESCOPE_MOTION_NS':
				if (vector.elements.MOTION_NORTH !== undefined) this.moveNorth(vector.elements.MOTION_NORTH)
				if (vector.elements.MOTION_SOUTH !== undefined) this.moveSouth(vector.elements.MOTION_SOUTH)
				return
			case 'TELESCOPE_MOTION_WE':
				if (vector.elements.MOTION_WEST !== undefined) this.moveWest(vector.elements.MOTION_WEST)
				if (vector.elements.MOTION_EAST !== undefined) this.moveEast(vector.elements.MOTION_EAST)
				return
			case 'TELESCOPE_PARK':
				if (vector.elements.PARK === true) this.park()
				else if (vector.elements.UNPARK === true) this.unpark()
				return
			case 'TELESCOPE_PARK_OPTION':
				if (vector.elements.PARK_CURRENT === true) this.setPark()
				return
			case 'TELESCOPE_SLEW_RATE': {
				for (const key in vector.elements) {
					if (vector.elements[key] === true) {
						this.setSlewRate(key)
						break
					}
				}

				return
			}
			case 'TELESCOPE_TRACK_MODE': {
				for (const key in vector.elements) {
					if (vector.elements[key] === true) {
						this.setTrackMode(key.replace('TRACK_', '') as TrackMode)
						break
					}
				}

				return
			}
			case 'TELESCOPE_TRACK_STATE':
				if (vector.elements.TRACK_ON === true) this.setTrackingEnabled(true)
				else if (vector.elements.TRACK_OFF === true) this.setTrackingEnabled(false)
				return
			case 'ON_COORD_SET':
				if (vector.elements.SYNC === true) this.#coordSetMode = 'SYNC'
				else if (vector.elements.SLEW === true) this.#coordSetMode = 'SLEW'
				return
		}
	}

	// Connects the simulated mount and adds its properties.
	connect() {
		if (this.#timer) return

		super.connect()

		if (!this.isConnected) return

		this.#lastTick = Date.now()
		this.refreshDynamicCoordinates(false)
		this.#timer = setInterval(this.tick.bind(this), TICK_INTERVAL_MS)

		handleDefSwitchVector(this.client, this.handler, this.#onCoordSet)
		handleDefNumberVector(this.client, this.handler, this.#equatorialCoordinate)
		handleDefSwitchVector(this.client, this.handler, this.#abort)
		handleDefSwitchVector(this.client, this.handler, this.#trackMode)
		handleDefSwitchVector(this.client, this.handler, this.#tracking)
		handleDefSwitchVector(this.client, this.handler, this.#home)
		handleDefSwitchVector(this.client, this.handler, this.#motionNS)
		handleDefSwitchVector(this.client, this.handler, this.#motionWE)
		handleDefSwitchVector(this.client, this.handler, this.#slewRate)
		handleDefTextVector(this.client, this.handler, this.#time)
		handleDefNumberVector(this.client, this.handler, this.#geographicCoordinate)
		handleDefSwitchVector(this.client, this.handler, this.#park)
		handleDefSwitchVector(this.client, this.handler, this.#parkOptions)
		handleDefSwitchVector(this.client, this.handler, this.#pierSide)
		handleDefNumberVector(this.client, this.handler, this.#guideRate)
		handleDefNumberVector(this.client, this.handler, this.#guideNS)
		handleDefNumberVector(this.client, this.handler, this.#guideWE)
	}

	// Disconnects the simulated mount, cancels active motion and deletes its properties.
	disconnect() {
		if (!this.#timer) return

		super.disconnect()
		this.stop()
		this.setTrackingEnabled(false)

		handleDelProperty(this.client, this.handler, this.#onCoordSet)
		handleDelProperty(this.client, this.handler, this.#equatorialCoordinate)
		handleDelProperty(this.client, this.handler, this.#abort)
		handleDelProperty(this.client, this.handler, this.#trackMode)
		handleDelProperty(this.client, this.handler, this.#tracking)
		handleDelProperty(this.client, this.handler, this.#home)
		handleDelProperty(this.client, this.handler, this.#motionNS)
		handleDelProperty(this.client, this.handler, this.#motionWE)
		handleDelProperty(this.client, this.handler, this.#slewRate)
		handleDelProperty(this.client, this.handler, this.#time)
		handleDelProperty(this.client, this.handler, this.#geographicCoordinate)
		handleDelProperty(this.client, this.handler, this.#park)
		handleDelProperty(this.client, this.handler, this.#parkOptions)
		handleDelProperty(this.client, this.handler, this.#pierSide)
		handleDelProperty(this.client, this.handler, this.#guideRate)
		handleDelProperty(this.client, this.handler, this.#guideNS)
		handleDelProperty(this.client, this.handler, this.#guideWE)
	}

	// Starts a time-based slew to the requested equatorial coordinate.
	goTo(rightAscension: Angle, declination: Angle) {
		if (!this.isConnected || this.isParked) return

		this.clearManualMotion()
		this.clearPulseGuide()
		this.#slewMode = 'GOTO'
		this.#slewTarget = { rightAscension: normalizeAngle(rightAscension), declination: clampDeclination(declination) }
		this.setSlewing(true)
		this.setHoming(false)
		this.setParking(false)
	}

	// Applies a sync immediately without any slew time.
	syncTo(rightAscension: Angle, declination: Angle) {
		if (!this.isConnected) return
		this.setCoordinate(normalizeAngle(rightAscension), clampDeclination(declination))
	}

	// Slews to the configured home position.
	home() {
		if (!this.isConnected || this.isParked) return
		this.#slewMode = 'HOME'
		this.#slewTarget = { rightAscension: this.#homeCoordinate.rightAscension, declination: this.#homeCoordinate.declination }
		this.setSlewing(true)
		this.setHoming(true)
		this.setParking(false)
	}

	// Stores the current coordinate as the new home position.
	setHome() {
		this.#homeCoordinate.rightAscension = this.rightAscension
		this.#homeCoordinate.declination = this.declination
	}

	// Parks the mount at the configured park position.
	park() {
		if (!this.isConnected || this.isParked) return
		this.clearManualMotion()
		this.clearPulseGuide()
		this.#slewMode = 'PARK'
		this.#slewTarget = { rightAscension: this.#parkCoordinate.rightAscension, declination: this.#parkCoordinate.declination }
		this.setSlewing(true)
		this.setHoming(false)
		this.setParking(true, false)
	}

	// Unparks the mount without changing the current coordinate.
	unpark() {
		this.isParked && selectOnSwitch(this.#park, 'UNPARK') && this.notify(this.#park)
		this.setParking(false)
	}

	// Stores the current coordinate as the park position.
	setPark() {
		this.#parkCoordinate.rightAscension = this.rightAscension
		this.#parkCoordinate.declination = this.declination
	}

	// Enables or disables sidereal-style tracking.
	setTrackingEnabled(enable: boolean) {
		if (this.isParked) enable = false
		if (this.isTracking === enable) return
		selectOnSwitch(this.#tracking, enable ? 'TRACK_ON' : 'TRACK_OFF') && this.notify(this.#tracking)
	}

	// Changes the simulated tracking mode.
	setTrackMode(mode: TrackMode) {
		if (!this.trackModes.includes(mode as never) || this.trackMode === mode) return
		selectOnSwitch(this.#trackMode, `TRACK_${mode}`) && this.notify(this.#trackMode)
	}

	// Changes the manual slew rate selection.
	setSlewRate(rate: NameAndLabel | string) {
		const name = typeof rate === 'string' ? rate : rate.name
		if (!SLEW_RATES.some((entry) => entry.name === name) || this.slewRate === name) return
		selectOnSwitch(this.#slewRate, name) && this.notify(this.#slewRate)
	}

	// Changes the simulated guide rate multipliers.
	setGuideRate(rightAscension: number, declination: number) {
		rightAscension = clamp(rightAscension, 0, MAX_GUIDE_RATE)
		declination = clamp(declination, 0, MAX_GUIDE_RATE)
		let updated = false

		if (this.guideRateRightAscension !== rightAscension) {
			this.#guideRate.elements.GUIDE_RATE_WE.value = rightAscension
			updated = true
		}

		if (this.guideRateDeclination !== declination) {
			this.#guideRate.elements.GUIDE_RATE_NS.value = declination
			updated = true
		}

		if (updated) {
			handleDefNumberVector(this.client, this.handler, this.#guideRate)
		}
	}

	// Updates the simulated site coordinate.
	setGeographicCoordinate(coordinate: GeographicCoordinate) {
		let updated = false

		if (this.latitude !== coordinate.latitude) {
			this.#geographicCoordinate.elements.LAT.value = toDeg(coordinate.latitude)
			updated = true
		}

		if (this.longitude !== coordinate.longitude) {
			this.#geographicCoordinate.elements.LONG.value = toDeg(normalizeAngle(coordinate.longitude))
			updated = true
		}

		if (this.elevation !== coordinate.elevation) {
			this.#geographicCoordinate.elements.ELEV.value = toMeter(coordinate.elevation)
			updated = true
		}

		if (updated) {
			this.updatePierSide()
			handleDefNumberVector(this.client, this.handler, this.#geographicCoordinate)
		}
	}

	// Updates the simulated UTC clock.
	setTime(value: UTCTime) {
		if (this.#utcTime === value.utc && this.#utcOffset === value.offset) return
		this.#utcTime = value.utc
		this.#utcOffset = value.offset
		this.#time.elements.UTC.value = formatTemporal(value.utc, 'YYYY-MM-DDTHH:mm:ss.SSSZ', 0)
		this.#time.elements.OFFSET.value = (value.offset / 60).toFixed(2)
		this.#lastTick = Date.now()
		this.updatePierSide()
		this.notify(this.#time)
	}

	// Sets manual northward motion.
	moveNorth(enable: boolean) {
		this.setManualNorthSouth(enable ? 1 : 0)
	}

	// Sets manual southward motion.
	moveSouth(enable: boolean) {
		this.setManualNorthSouth(enable ? -1 : 0)
	}

	// Sets manual westward motion.
	moveWest(enable: boolean) {
		this.setManualWestEast(enable ? -1 : 0)
	}

	// Sets manual eastward motion.
	moveEast(enable: boolean) {
		this.setManualWestEast(enable ? 1 : 0)
	}

	// Starts a pulse guiding correction for the requested direction.
	pulse(direction: GuideDirection, duration: number) {
		if (!this.isConnected || this.isParked || duration <= 0) return
		const until = Date.now() + duration

		if (direction === 'NORTH') {
			this.#pulseNorthSouth = 1
			this.#pulseNorthSouthUntil = until
		} else if (direction === 'SOUTH') {
			this.#pulseNorthSouth = -1
			this.#pulseNorthSouthUntil = until
		} else if (direction === 'EAST') {
			this.#pulseWestEast = 1
			this.#pulseWestEastUntil = until
		} else {
			this.#pulseWestEast = -1
			this.#pulseWestEastUntil = until
		}

		this.updatePulsing()
	}

	// Aborts any active slew or manual motion.
	stop() {
		this.#slewMode = undefined
		this.#slewTarget = undefined
		this.clearManualMotion()
		this.clearPulseGuide()
		this.setSlewing(false)
		this.setHoming(false)
		this.setParking(false)
	}

	// Stops the simulation clock and removes the device from the manager.
	dispose() {
		if (this.#timer) {
			clearInterval(this.#timer)
			this.disconnect()
			this.#timer = undefined
			this.handler.delProperty?.(this.client, { device: this.name })
		}
	}

	// Advances the simulated state using wall-clock time.
	private tick() {
		const now = Date.now()
		const dtSeconds = Math.max(0, (now - this.#lastTick) / 1000)
		this.#lastTick = now

		if (dtSeconds <= 0) return

		this.#utcTime += Math.trunc(dtSeconds * 1000)

		if (!this.isConnected) return

		this.expirePulseGuide(now)

		if (this.#slewTarget) {
			this.advanceSlew(dtSeconds)
		} else {
			this.advanceFreeMotion(dtSeconds)
		}
	}

	// Moves the mount along the commanded slew vector.
	private advanceSlew(dtSeconds: number) {
		const target = this.#slewTarget

		if (!target) return

		const speed = this.manualSlewSpeed() * 3
		const maxStep = speed * dtSeconds
		const deltaRightAscension = normalizePI(target.rightAscension - this.rightAscension)
		const deltaDeclination = target.declination - this.declination
		const span = Math.max(Math.abs(deltaRightAscension), Math.abs(deltaDeclination))

		if (span <= maxStep || span === 0) {
			this.setCoordinate(target.rightAscension, target.declination)
			const mode = this.#slewMode
			this.#slewMode = undefined
			this.#slewTarget = undefined
			this.setSlewing(false)
			this.setHoming(false)

			if (mode === 'PARK') {
				this.setParking(false, true)
				this.setTrackingEnabled(false)
			} else {
				this.setParking(false)
			}

			return
		}

		const scale = maxStep / span
		this.setCoordinate(this.rightAscension + deltaRightAscension * scale, this.declination + deltaDeclination * scale)
	}

	// Advances tracking, manual motion and pulse guiding when not slewing.
	private advanceFreeMotion(dtSeconds: number) {
		let { rightAscension, declination } = this
		let moved = false

		if (this.#manualWestEast !== 0) {
			rightAscension += this.#manualWestEast * this.manualSlewSpeed() * dtSeconds
			moved = true
		}

		if (this.#manualNorthSouth !== 0) {
			declination += this.#manualNorthSouth * this.manualSlewSpeed() * dtSeconds
			moved = true
		}

		if (this.#pulseWestEast !== 0) {
			rightAscension += this.#pulseWestEast * this.guideRateRightAscension * SIDEREAL_DRIFT_RATE * dtSeconds
			moved = true
		}

		if (this.#pulseNorthSouth !== 0) {
			declination += this.#pulseNorthSouth * this.guideRateDeclination * SIDEREAL_DRIFT_RATE * dtSeconds
			moved = true
		}

		if (!moved) {
			const trackingDrift = this.trackingDriftRate()

			if (trackingDrift !== 0) {
				rightAscension += trackingDrift * dtSeconds
				moved = true
			}
		}

		if (moved) {
			this.setCoordinate(normalizeAngle(rightAscension), clampDeclination(declination))
		}
	}

	// Applies a coordinate update and notifies listeners when required.
	private setCoordinate(rightAscension: Angle, declination: Angle, notify: boolean = true) {
		this.#equatorialCoordinate.elements.RA.value = toHour(normalizeAngle(rightAscension))
		this.#equatorialCoordinate.elements.DEC.value = toDeg(clampDeclination(declination))
		const pierSideChanged = this.updatePierSide()

		if (notify) this.notify(this.#equatorialCoordinate)
		if (notify && pierSideChanged) this.notify(this.#pierSide)
	}

	// Keeps the simulated pier side consistent with the current sky position.
	private updatePierSide() {
		const pierSide = expectedPierSide(this.rightAscension, this.declination, this.siderealTime())
		if (pierSide === this.pierSide) return false

		if (pierSide === 'EAST') selectOnSwitch(this.#pierSide, 'PIER_EAST')
		else if (pierSide === 'WEST') selectOnSwitch(this.#pierSide, 'PIER_WEST')
		else {
			this.#pierSide.elements.PIER_EAST.value = false
			this.#pierSide.elements.PIER_WEST.value = false
		}

		return true
	}

	// Computes the current local sidereal time from the simulated clock.
	private siderealTime() {
		return localSiderealTime(timeUnix(this.#utcTime / 1000, undefined, true), this.longitude)
	}

	// Returns the active free-slew speed in radians per second.
	private manualSlewSpeed() {
		return SLEW_RATES.find((entry) => entry.name === this.slewRate)?.speed ?? SLEW_RATES[3].speed
	}

	// Returns the RA drift implied by the current tracking state.
	private trackingDriftRate() {
		if (!this.isTracking) return SIDEREAL_DRIFT_RATE
		if (this.trackMode === 'SOLAR') return SOLAR_DRIFT_RATE
		if (this.trackMode === 'LUNAR') return LUNAR_DRIFT_RATE
		if (this.trackMode === 'KING') return KING_DRIFT_RATE
		return 0
	}

	// Expires pulse guide commands once their duration elapses.
	private expirePulseGuide(now: number) {
		let changed = false

		if (this.#pulseNorthSouth !== 0 && now >= this.#pulseNorthSouthUntil) {
			this.#pulseNorthSouth = 0
			this.#pulseNorthSouthUntil = 0
			changed = true
		}

		if (this.#pulseWestEast !== 0 && now >= this.#pulseWestEastUntil) {
			this.#pulseWestEast = 0
			this.#pulseWestEastUntil = 0
			changed = true
		}

		if (changed) {
			this.updatePulsing()
		}
	}

	// Updates the combined pulse-guiding state.
	private updatePulsing() {
		this.setPulsing(this.#pulseNorthSouth !== 0 || this.#pulseWestEast !== 0)
	}

	// Sets the active north/south manual motion state.
	private setManualNorthSouth(direction: AxisDirection) {
		if (!this.isConnected || this.isParked) direction = 0
		if (this.#manualNorthSouth === direction) return
		if (direction !== 0) this.abortSlew()
		this.#manualNorthSouth = direction
		this.refreshSlewingState()
	}

	// Sets the active west/east manual motion state.
	private setManualWestEast(direction: AxisDirection) {
		if (!this.isConnected || this.isParked) direction = 0
		if (this.#manualWestEast === direction) return
		if (direction !== 0) this.abortSlew()
		this.#manualWestEast = direction
		this.refreshSlewingState()
	}

	// Clears any manual motion command.
	private clearManualMotion() {
		this.#manualNorthSouth = 0
		this.#manualWestEast = 0
	}

	// Clears active pulse-guiding commands.
	private clearPulseGuide() {
		this.#pulseNorthSouth = 0
		this.#pulseWestEast = 0
		this.#pulseNorthSouthUntil = 0
		this.#pulseWestEastUntil = 0
		this.setPulsing(false)
	}

	// Cancels any goto, home or park slew.
	private abortSlew() {
		this.#slewMode = undefined
		this.#slewTarget = undefined
		this.setHoming(false)
		this.setParking(false)
	}

	// Recomputes the combined slewing flag.
	private refreshSlewingState() {
		this.setSlewing(this.#slewTarget !== undefined || this.#manualNorthSouth !== 0 || this.#manualWestEast !== 0)
	}

	// Updates the slewing flag and notifies listeners.
	private setSlewing(value: boolean) {
		if (this.isSlewing === value) return
		this.#equatorialCoordinate.state = value ? 'Busy' : 'Idle'
		this.notify(this.#equatorialCoordinate)
	}

	// Updates the homing flag and notifies listeners.
	private setHoming(value: boolean) {
		if (this.isHoming === value) return
		this.#home.state = value ? 'Busy' : 'Idle'
		this.notify(this.#home)
	}

	// Updates the parking state and notifies listeners.
	private setParking(parking: boolean, parked?: boolean) {
		let updated = false

		if (this.isParking !== parking) {
			this.#park.state = parking ? 'Busy' : 'Idle'
			updated = true
		}

		if (parked !== undefined && this.isParked !== parked) {
			updated = selectOnSwitch(this.#park, parked ? 'PARK' : 'UNPARK')
		}

		if (updated) {
			this.notify(this.#park)
		}
	}

	private setPulsing(pulsing: boolean) {
		if (this.isPulsing === pulsing) return
		this.#guideNS.state = pulsing ? 'Busy' : 'Idle'
		this.#guideWE.state = this.#guideNS.state
		this.notify(this.#guideNS)
		this.notify(this.#guideWE)
	}

	// Initializes the mount with a realistic pole-pointing home position.
	private refreshDynamicCoordinates(notify: boolean) {
		this.#homeCoordinate.rightAscension = this.siderealTime()
		this.#parkCoordinate.rightAscension = this.#homeCoordinate.rightAscension
		this.setCoordinate(this.#homeCoordinate.rightAscension, this.#homeCoordinate.declination, notify)
	}
}

function clampDeclination(value: number) {
	return clamp(value, -PIOVERTWO, PIOVERTWO)
}
