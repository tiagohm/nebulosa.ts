import type { Angle } from './angle'
import { arcsec, deg, formatDEC, formatRA, hour, normalizeAngle, normalizePI, toDeg, toHour } from './angle'
import { ASEC2RAD, DAYSEC, DEG2RAD, MOON_SIDEREAL_DAYS, PIOVERTWO, SIDEREAL_DAYSEC, SIDEREAL_RATE, TAU } from './constants'
import type { EquatorialCoordinate } from './coordinate'
import { equatorialToJ2000 } from './coordinate'
import { meter } from './distance'
import type { FitsHeader } from './fits'
import type { Point } from './geometry'
import { writeImageToFits, writeImageToXisf } from './image'
import { type AstronomicalImageNoiseConfig, type AstronomicalImageStar, DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG, generateNoiseImage, generateStarImage } from './image.generator'
import type { CfaPattern, Image, ImageRawType } from './image.types'
import { handleDefNumberVector, handleDefSwitchVector, handleDefTextVector, handleDelProperty, handleSetBlobVector, handleSetNumberVector, handleSetSwitchVector, handleSetTextVector, type IndiClientHandler } from './indi.client'
import { type Client, DeviceInterfaceType, type DeviceType, expectedPierSide, type FrameType, type GuideDirection, type NameAndLabel, type PierSide, type TrackMode, type UTCTime } from './indi.device'
import type { FocuserManager, GuideOutputManager, MountManager, RotatorManager } from './indi.manager'
import { type DefNumberVector, type DefSwitchVector, type DefTextVector, type EnableBlob, findOnSwitch, type GetProperties, makeBlobVector, makeNumberVector, makeSwitchVector, makeTextVector, type NewNumberVector, type NewSwitchVector, type NewTextVector, selectOnSwitch } from './indi.types'
import { bufferSink } from './io'
import { localSiderealTime } from './location'
import { clamp } from './math'
import { polarAlignmentError } from './polaralignment'
import { gnomonicProject } from './projection'
import { mulberry32 } from './random'
import type { PlotStarOptions } from './star.generator'
import { formatTemporal, TIMEZONE } from './temporal'
import { timeUnix } from './time'
import { angularSizeOfPixel } from './util'

const TICK_INTERVAL_MS = 100
const SIDEREAL_DRIFT_RATE = TAU / SIDEREAL_DAYSEC
const SOLAR_DRIFT_RATE = TAU / (365.2422 * DAYSEC)
const LUNAR_DRIFT_RATE = TAU / (MOON_SIDEREAL_DAYS * DAYSEC)
const KING_DRIFT_RATE = (SIDEREAL_RATE - 15.0369) * ASEC2RAD
const MAX_GUIDE_RATE = 1
const CAMERA_SENSOR_WIDTH = 1280
const CAMERA_SENSOR_HEIGHT = 1024
const CAMERA_PIXEL_SIZE = 5.2
const CAMERA_MAX_BIN = 4
const CAMERA_MIN_EXPOSURE = 0.001
const CAMERA_MAX_EXPOSURE = 3600
const CAMERA_AMBIENT_TEMPERATURE = 18
const CAMERA_DEFAULT_TARGET_TEMPERATURE = 0
const CAMERA_SCENE_SEED = 0x1d0f3a57
const CAMERA_BLOB_PADDING = 16384
const FOCUSER_MAX_POSITION = 100000
const FOCUSER_INITIAL_POSITION = 50000
const FOCUSER_MOVE_RATE = 20000
const FOCUSER_TEMPERATURE_AMPLITUDE = 4
const FOCUSER_TEMPERATURE_PERIOD_SECONDS = 40
const FOCUSER_TEMPERATURE_COMPENSATION_STEPS = -250
const FOCUSER_TEMPERATURE_COMPENSATION_HYSTERESIS = 0.05
const FILTER_WHEEL_SLOT_NAMES = ['L', 'R', 'G', 'B', 'Ha', 'SII', 'OIII', 'Dark'] as const
const FILTER_WHEEL_MOVE_TIME_MS = 250
const ROTATOR_MOVE_RATE = 90
const COVER_MOVE_TIME_MS = 500
const PANEL_MAX_INTENSITY = 255

const SLEW_RATES = [
	{ name: 'SPEED_1', label: ' 0.5°', speed: 0.5 * DEG2RAD },
	{ name: 'SPEED_2', label: ' 1.0°', speed: 1 * DEG2RAD },
	{ name: 'SPEED_3', label: ' 2.0°', speed: 2 * DEG2RAD },
	{ name: 'SPEED_4', label: ' 4.0°', speed: 4 * DEG2RAD },
	{ name: 'SPEED_5', label: ' 8.0°', speed: 8 * DEG2RAD },
	{ name: 'SPEED_6', label: '16.0°', speed: 16 * DEG2RAD },
	{ name: 'SPEED_7', label: '32.0°', speed: 32 * DEG2RAD },
] as const

type CoordSetMode = 'SLEW' | 'SYNC'

type SlewMode = 'GOTO' | 'HOME' | 'PARK'

type AxisDirection = -1 | 0 | 1

export type TransferFormat = 'FITS' | 'XISF'

export type ReadoutMode = 'MONO' | 'RGB'

type CatalogSourceType = 'RANDOM' | (string & {})

export type SimulatorProperty = ReturnType<typeof makeNumberVector> | ReturnType<typeof makeSwitchVector> | ReturnType<typeof makeTextVector> | ReturnType<typeof makeBlobVector>

export type CatalogSourceStar = Omit<AstronomicalImageStar, 'x' | 'y'> & Required<EquatorialCoordinate>

export type CatalogSource = (rightAscension: Angle, declination: Angle, radius: Angle) => PromiseLike<readonly CatalogSourceStar[]> | readonly CatalogSourceStar[]

export interface DeviceSimulatorOptions {
	readonly save?: (name: string, properties: readonly SimulatorProperty[]) => void
	readonly load?: (name: string) => PromiseLike<readonly SimulatorProperty[]> | readonly SimulatorProperty[]
}

export interface CameraSimulatorOptions extends DeviceSimulatorOptions {
	readonly catalogSources?: Record<string, CatalogSource | undefined | null>
	readonly mountManager?: MountManager
	readonly guideOutputManager?: GuideOutputManager
	readonly focuserManager?: FocuserManager
	readonly rotatorManager?: RotatorManager
}

// Routes MountManager commands back into the simulator.
export class ClientSimulator implements Client {
	readonly type = 'SIMULATOR'

	#devices = new Map<string, DeviceSimulator>()

	constructor(
		readonly id: string,
		readonly handler: IndiClientHandler,
		readonly description: string = 'Client Simulator',
	) {}

	getProperties(command?: GetProperties) {}

	enableBlob(command: EnableBlob) {}

	sendText(vector: NewTextVector) {
		for (const device of this.#devices.values()) device.name === vector.device && device.sendText(vector)
	}

	sendNumber(vector: NewNumberVector) {
		for (const device of this.#devices.values()) device.name === vector.device && device.sendNumber(vector)
	}

	sendSwitch(vector: NewSwitchVector) {
		for (const device of this.#devices.values()) device.name === vector.device && device.sendSwitch(vector)
	}

	register(device: DeviceSimulator) {
		this.#devices.set(device.name, device)
	}

	unregister(device: DeviceSimulator) {
		this.#devices.delete(device.name)
	}

	[Symbol.dispose]() {
		for (const device of this.#devices.values()) device.dispose()
		this.#devices.clear()
	}
}

const MAIN_CONTROL = 'Main Control'
const GENERAL_INFO = 'General Info'
const SIMULATION = 'Simulation'

export abstract class DeviceSimulator implements Disposable {
	abstract readonly type: DeviceType

	protected readonly driverInfo = makeTextVector('', 'DRIVER_INFO', 'Driver Info', GENERAL_INFO, 'ro', ['DRIVER_INTERFACE', 'Interface', ''], ['DRIVER_EXEC', 'Exec', ''], ['DRIVER_VERSION', 'Version', '1.0'], ['DRIVER_NAME', 'Name', ''])
	protected readonly connection = makeSwitchVector('', 'CONNECTION', 'Connection', MAIN_CONTROL, 'OneOfMany', 'rw', ['CONNECT', 'Connect', false], ['DISCONNECT', 'Disconnect', true])
	protected readonly snoopDevices = makeTextVector('', 'ACTIVE_DEVICES', 'Snoop devices', MAIN_CONTROL, 'rw', ['ACTIVE_TELESCOPE', 'Mount', ''], ['ACTIVE_FOCUSER', 'Focuser', ''], ['ACTIVE_FILTER', 'Filter Wheel', ''], ['ACTIVE_ROTATOR', 'Rotator', ''])
	protected readonly config = makeSwitchVector('', 'CONFIG', 'Config', MAIN_CONTROL, 'AtMostOne', 'rw', ['LOAD', 'Load', false], ['SAVE', 'Save', false])

	protected abstract readonly properties: readonly SimulatorProperty[]
	protected abstract readonly propertiesToNotSave: readonly SimulatorProperty[]
	protected abstract readonly options?: DeviceSimulatorOptions

	constructor(
		readonly name: string,
		readonly client: ClientSimulator,
		readonly handler: IndiClientHandler,
		interfaceType: DeviceInterfaceType,
	) {
		this.driverInfo.device = name
		this.driverInfo.elements.DRIVER_INTERFACE.value = interfaceType.toFixed(0)
		this.driverInfo.elements.DRIVER_NAME.value = name
		this.connection.device = name
		this.snoopDevices.device = name
		this.config.device = name
		client.register(this)

		handleDefTextVector(client, handler, this.driverInfo)
		handleDefSwitchVector(client, handler, this.connection)
		handleDefTextVector(client, handler, this.snoopDevices)
		handleDefSwitchVector(client, handler, this.config)
	}

	get isConnected() {
		return this.connection.elements.CONNECT.value
	}

	sendText(vector: NewTextVector) {
		switch (vector.name) {
			case 'ACTIVE_DEVICES':
				applyTextVectorValues(this.snoopDevices, vector.elements) && this.notify(this.snoopDevices)
		}
	}

	abstract sendNumber(vector: NewNumberVector): void

	sendSwitch(vector: NewSwitchVector) {
		switch (vector.name) {
			case 'CONFIG':
				if (vector.elements.LOAD === true) void this.loadProperties()
				else if (vector.elements.SAVE === true) this.saveProperties()
		}
	}

	dispose() {
		this.handler.delProperty?.(this.client, { device: this.name })
		this.client.unregister(this)
	}

	// Connects the simulated device.
	connect() {
		if (this.isConnected) return
		selectOnSwitch(this.connection, 'CONNECT') && handleSetSwitchVector(this.client, this.handler, this.connection)
		if (!this.isConnected) return

		for (const property of this.properties) {
			sendDefinition(this.client, this.handler, property)
		}

		void this.loadProperties()
	}

	// Disconnects the simulated device.
	disconnect() {
		if (!this.isConnected) return
		selectOnSwitch(this.connection, 'DISCONNECT') && handleSetSwitchVector(this.client, this.handler, this.connection)

		for (const property of this.properties) {
			handleDelProperty(this.client, this.handler, property as never)
		}
	}

	protected notify(message: SimulatorProperty) {
		const type = message.type[0]

		if (type === 'S') handleSetSwitchVector(this.client, this.handler, message as never)
		else if (type === 'N') handleSetNumberVector(this.client, this.handler, message as never)
		else if (type === 'T') handleSetTextVector(this.client, this.handler, message as never)
	}

	saveProperties() {
		if (this.options?.save) {
			const properties = this.properties.filter((e) => !this.propertiesToNotSave.includes(e))
			this.options.save(this.name, properties)
		}
	}

	async loadProperties() {
		if (this.options?.load) {
			const properties = await this.options.load(this.name)

			for (const property of properties) {
				const actual = this.properties.find((e) => e.name === property.name)
				if (actual === undefined || this.propertiesToNotSave.includes(actual)) continue
				let updated = false

				for (const key in actual.elements) {
					const value = property.elements[key]
					if (value === undefined) continue
					const actualElement = actual.elements[key]

					if (actualElement.value !== value.value) {
						actualElement.value = value.value
						updated = true
					}
				}

				updated && this.notify(actual)
			}
		}
	}

	[Symbol.dispose]() {
		this.dispose()
	}
}

export class MountSimulator extends DeviceSimulator {
	readonly type = 'MOUNT'
	readonly #trackModes = ['SIDEREAL', 'SOLAR', 'LUNAR', 'KING'] as const

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
	readonly #guideRate = makeNumberVector('', 'GUIDE_RATE', 'Guiding Rate', MAIN_CONTROL, 'rw', ['GUIDE_RATE_WE', 'W/E Rate', 0.5, 0, 1, 0.1, '%.8f'], ['GUIDE_RATE_NS', 'N/E Rate', 0.5, 0, 1, 0.1, '%.0f'])
	readonly #guideNS = makeNumberVector('', 'TELESCOPE_TIMED_GUIDE_NS', 'Guide N/S', MAIN_CONTROL, 'rw', ['TIMED_GUIDE_N', 'North (ms)', 0, 0, 60000, 1, '%.0f'], ['TIMED_GUIDE_S', 'South (ms)', 0, 0, 60000, 1, '%.0f'])
	readonly #guideWE = makeNumberVector('', 'TELESCOPE_TIMED_GUIDE_WE', 'Guide W/E', MAIN_CONTROL, 'rw', ['TIMED_GUIDE_W', 'West (ms)', 0, 0, 60000, 1, '%.0f'], ['TIMED_GUIDE_E', 'East (ms)', 0, 0, 60000, 1, '%.0f'])

	protected readonly properties: readonly SimulatorProperty[] = [
		this.#onCoordSet,
		this.#equatorialCoordinate,
		this.#abort,
		this.#trackMode,
		this.#tracking,
		this.#home,
		this.#motionNS,
		this.#motionWE,
		this.#slewRate,
		this.#time,
		this.#geographicCoordinate,
		this.#park,
		this.#parkOptions,
		this.#pierSide,
		this.#guideRate,
		this.#guideNS,
		this.#guideWE,
	]
	protected propertiesToNotSave = this.properties.filter((e) => e !== this.#trackMode && e !== this.#guideRate)

	#timer?: NodeJS.Timeout
	#lastTick = 0
	#coordSetMode: CoordSetMode = 'SLEW'
	#slewMode?: SlewMode
	#slewTarget?: EquatorialCoordinate
	#manualNorthSouth: AxisDirection = 0
	#manualWestEast: AxisDirection = 0
	#pulseNorthSouth: AxisDirection = 0
	#pulseWestEast: AxisDirection = 0
	#pulseNorthSouthUntil = 0
	#pulseWestEastUntil = 0
	#homeCoordinate: EquatorialCoordinate = { rightAscension: 0, declination: PIOVERTWO }
	#parkCoordinate: EquatorialCoordinate = { rightAscension: 0, declination: PIOVERTWO }
	#utcTime = Date.now()
	#utcOffset = TIMEZONE / 60

	constructor(
		name: string,
		client: ClientSimulator,
		readonly options?: DeviceSimulatorOptions,
		handler: IndiClientHandler = client.handler,
	) {
		super(name, client, handler, DeviceInterfaceType.TELESCOPE | DeviceInterfaceType.GUIDER)

		for (const property of this.properties) {
			property.device = name
		}

		for (const rate of SLEW_RATES) {
			this.#slewRate.elements[rate.name] = { name: rate.name, label: rate.label, value: rate.name === 'SPEED_2' }
		}

		this.driverInfo.elements.DRIVER_EXEC.value = 'mount.simulator'
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
		super.sendText(vector)

		switch (vector.name) {
			case 'TIME_UTC':
				if (vector.elements.UTC) {
					const utc = Date.parse(`${vector.elements.UTC}Z`)
					const offset = Math.trunc(+vector.elements.OFFSET * 60)
					if (!Number.isNaN(utc)) this.setTime({ utc, offset })
				}
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
				if (applyNumberVectorValues(this.#geographicCoordinate, vector.elements)) {
					this.#updatePierSide()
					this.notify(this.#geographicCoordinate)
				}
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
		}
	}

	sendSwitch(vector: NewSwitchVector) {
		super.sendSwitch(vector)

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
		}
	}

	// Connects the simulated mount and publishes its supported properties.
	connect() {
		if (this.#timer) return

		super.connect()

		if (!this.isConnected) return

		this.#lastTick = Date.now()
		this.#refreshDynamicCoordinates(false)
		this.#timer = setInterval(this.#tick.bind(this), TICK_INTERVAL_MS)
	}

	// Disconnects the simulated mount and removes its dynamic properties.
	disconnect() {
		if (!this.#timer) return

		clearInterval(this.#timer)
		this.#timer = undefined
		this.stop()
		this.setTrackingEnabled(false)

		super.disconnect()
	}

	// Starts a time-based slew to the requested equatorial coordinate.
	goTo(rightAscension: Angle, declination: Angle) {
		if (!this.isConnected || this.isParked) return

		this.#clearManualMotion()
		this.#clearPulseGuide()
		this.#slewMode = 'GOTO'
		this.#slewTarget = { rightAscension: normalizeAngle(rightAscension), declination: clampDeclination(declination) }
		this.#setSlewing(true)
		this.#setHoming(false)
		this.#setParking(false)
	}

	// Applies a sync immediately without any slew time.
	syncTo(rightAscension: Angle, declination: Angle) {
		if (!this.isConnected) return
		this.#setCoordinate(normalizeAngle(rightAscension), clampDeclination(declination))
	}

	// Slews to the configured home position.
	home() {
		if (!this.isConnected || this.isParked) return
		this.#slewMode = 'HOME'
		this.#slewTarget = { rightAscension: this.#homeCoordinate.rightAscension, declination: this.#homeCoordinate.declination }
		this.#setSlewing(true)
		this.#setHoming(true)
		this.#setParking(false)
	}

	// Stores the current coordinate as the new home position.
	setHome() {
		this.#homeCoordinate.rightAscension = this.rightAscension
		this.#homeCoordinate.declination = this.declination
	}

	// Parks the mount at the configured park position.
	park() {
		if (!this.isConnected || this.isParked) return
		this.#clearManualMotion()
		this.#clearPulseGuide()
		this.#slewMode = 'PARK'
		this.#slewTarget = { rightAscension: this.#parkCoordinate.rightAscension, declination: this.#parkCoordinate.declination }
		this.#setSlewing(true)
		this.#setHoming(false)
		this.#setParking(true, false)
	}

	// Unparks the mount without changing the current coordinate.
	unpark() {
		this.isParked && selectOnSwitch(this.#park, 'UNPARK') && this.notify(this.#park)
		this.#setParking(false)
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
		if (!this.#trackModes.includes(mode as never) || this.trackMode === mode) return
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

	// Updates the simulated UTC clock.
	setTime(value: UTCTime) {
		if (this.#utcTime === value.utc && this.#utcOffset === value.offset) return
		this.#utcTime = value.utc
		this.#utcOffset = value.offset
		this.#time.elements.UTC.value = formatTemporal(value.utc, 'YYYY-MM-DDTHH:mm:ss.SSSZ', 0)
		this.#time.elements.OFFSET.value = (value.offset / 60).toFixed(2)
		this.#lastTick = Date.now()
		this.#updatePierSide()
		this.notify(this.#time)
	}

	// Sets manual northward motion.
	moveNorth(enable: boolean) {
		this.#setManualNorthSouth(enable ? 1 : 0)
	}

	// Sets manual southward motion.
	moveSouth(enable: boolean) {
		this.#setManualNorthSouth(enable ? -1 : 0)
	}

	// Sets manual westward motion.
	moveWest(enable: boolean) {
		this.#setManualWestEast(enable ? -1 : 0)
	}

	// Sets manual eastward motion.
	moveEast(enable: boolean) {
		this.#setManualWestEast(enable ? 1 : 0)
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

		this.#updatePulsing()
	}

	// Aborts any active slew or manual motion.
	stop() {
		this.#slewMode = undefined
		this.#slewTarget = undefined
		this.#clearManualMotion()
		this.#clearPulseGuide()
		this.#setSlewing(false)
		this.#setHoming(false)
		this.#setParking(false)
	}

	// Disposes the mount simulator and removes it from the manager view.
	dispose() {
		this.disconnect()
		super.dispose()
	}

	// Advances the simulated state using wall-clock time.
	#tick() {
		const now = Date.now()
		const dtSeconds = Math.max(0, (now - this.#lastTick) / 1000)
		this.#lastTick = now

		if (dtSeconds <= 0) return

		this.#utcTime += Math.trunc(dtSeconds * 1000)

		if (!this.isConnected) return

		this.#expirePulseGuide(now)

		if (this.#slewTarget) {
			this.#advanceSlew(dtSeconds)
		} else {
			this.#advanceFreeMotion(dtSeconds)
		}
	}

	// Moves the mount along the commanded slew vector.
	#advanceSlew(dtSeconds: number) {
		const target = this.#slewTarget

		if (!target) return

		const speed = this.#manualSlewSpeed() * 3
		const maxStep = speed * dtSeconds
		const deltaRightAscension = normalizePI(target.rightAscension - this.rightAscension)
		const deltaDeclination = target.declination - this.declination
		const span = Math.max(Math.abs(deltaRightAscension), Math.abs(deltaDeclination))

		if (span <= maxStep || span === 0) {
			this.#setCoordinate(target.rightAscension, target.declination)
			const mode = this.#slewMode
			this.#slewMode = undefined
			this.#slewTarget = undefined
			this.#setSlewing(false)
			this.#setHoming(false)

			if (mode === 'PARK') {
				this.#setParking(false, true)
				this.setTrackingEnabled(false)
			} else {
				this.#setParking(false)
			}

			return
		}

		const scale = maxStep / span
		this.#setCoordinate(this.rightAscension + deltaRightAscension * scale, this.declination + deltaDeclination * scale)
	}

	// Advances tracking, manual motion and pulse guiding when not slewing.
	#advanceFreeMotion(dtSeconds: number) {
		let { rightAscension, declination } = this
		let moved = false

		if (this.#manualWestEast !== 0) {
			rightAscension += this.#manualWestEast * this.#manualSlewSpeed() * dtSeconds
			moved = true
		}

		if (this.#manualNorthSouth !== 0) {
			declination += this.#manualNorthSouth * this.#manualSlewSpeed() * dtSeconds
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
			const trackingDrift = this.#trackingDriftRate()

			if (trackingDrift !== 0) {
				rightAscension += trackingDrift * dtSeconds
				moved = true
			}
		}

		if (moved) {
			this.#setCoordinate(normalizeAngle(rightAscension), clampDeclination(declination))
		}
	}

	// Applies a coordinate update and notifies listeners when required.
	#setCoordinate(rightAscension: Angle, declination: Angle, notify: boolean = true) {
		this.#equatorialCoordinate.elements.RA.value = toHour(normalizeAngle(rightAscension))
		this.#equatorialCoordinate.elements.DEC.value = toDeg(clampDeclination(declination))
		const pierSideChanged = this.#updatePierSide()

		if (notify) this.notify(this.#equatorialCoordinate)
		if (notify && pierSideChanged) this.notify(this.#pierSide)
	}

	// Keeps the simulated pier side consistent with the current sky position.
	#updatePierSide() {
		const pierSide = expectedPierSide(this.rightAscension, this.declination, this.#siderealTime())
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
	#siderealTime() {
		return localSiderealTime(timeUnix(this.#utcTime / 1000, undefined, true), this.longitude)
	}

	// Returns the active free-slew speed in radians per second.
	#manualSlewSpeed() {
		return SLEW_RATES.find((entry) => entry.name === this.slewRate)?.speed ?? SLEW_RATES[3].speed
	}

	// Returns the RA drift implied by the current tracking state.
	#trackingDriftRate() {
		if (!this.isTracking) return SIDEREAL_DRIFT_RATE
		if (this.trackMode === 'SOLAR') return SOLAR_DRIFT_RATE
		if (this.trackMode === 'LUNAR') return LUNAR_DRIFT_RATE
		if (this.trackMode === 'KING') return KING_DRIFT_RATE
		return 0
	}

	// Expires pulse guide commands once their duration elapses.
	#expirePulseGuide(now: number) {
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
			this.#updatePulsing()
		}
	}

	// Updates the combined pulse-guiding state.
	#updatePulsing() {
		this.#setPulsing(this.#pulseNorthSouth !== 0 || this.#pulseWestEast !== 0)
	}

	// Sets the active north/south manual motion state.
	#setManualNorthSouth(direction: AxisDirection) {
		if (!this.isConnected || this.isParked) direction = 0
		if (this.#manualNorthSouth === direction) return
		if (direction !== 0) this.#abortSlew()
		this.#manualNorthSouth = direction
		this.#refreshSlewingState()
	}

	// Sets the active west/east manual motion state.
	#setManualWestEast(direction: AxisDirection) {
		if (!this.isConnected || this.isParked) direction = 0
		if (this.#manualWestEast === direction) return
		if (direction !== 0) this.#abortSlew()
		this.#manualWestEast = direction
		this.#refreshSlewingState()
	}

	// Clears any manual motion command.
	#clearManualMotion() {
		this.#manualNorthSouth = 0
		this.#manualWestEast = 0
	}

	// Clears active pulse-guiding commands.
	#clearPulseGuide() {
		this.#pulseNorthSouth = 0
		this.#pulseWestEast = 0
		this.#pulseNorthSouthUntil = 0
		this.#pulseWestEastUntil = 0
		this.#setPulsing(false)
	}

	// Cancels any goto, home or park slew.
	#abortSlew() {
		this.#slewMode = undefined
		this.#slewTarget = undefined
		this.#setHoming(false)
		this.#setParking(false)
	}

	// Recomputes the combined slewing flag.
	#refreshSlewingState() {
		this.#setSlewing(this.#slewTarget !== undefined || this.#manualNorthSouth !== 0 || this.#manualWestEast !== 0)
	}

	// Updates the slewing flag and notifies listeners.
	#setSlewing(value: boolean) {
		if (this.isSlewing === value) return
		this.#equatorialCoordinate.state = value ? 'Busy' : 'Idle'
		this.notify(this.#equatorialCoordinate)
	}

	// Updates the homing flag and notifies listeners.
	#setHoming(value: boolean) {
		if (this.isHoming === value) return
		this.#home.state = value ? 'Busy' : 'Idle'
		this.notify(this.#home)
	}

	// Updates the parking state and notifies listeners.
	#setParking(parking: boolean, parked?: boolean) {
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

	#setPulsing(pulsing: boolean) {
		if (this.isPulsing === pulsing) return
		this.#guideNS.state = pulsing ? 'Busy' : 'Idle'
		this.#guideWE.state = this.#guideNS.state
		this.notify(this.#guideNS)
		this.notify(this.#guideWE)
	}

	// Initializes the mount with a realistic pole-pointing home position.
	#refreshDynamicCoordinates(notify: boolean) {
		this.#homeCoordinate.rightAscension = this.#siderealTime()
		this.#parkCoordinate.rightAscension = this.#homeCoordinate.rightAscension
		this.#setCoordinate(this.#homeCoordinate.rightAscension, this.#homeCoordinate.declination, notify)
	}
}

export class FocuserSimulator extends DeviceSimulator {
	readonly type = 'FOCUSER'

	readonly #position = makeNumberVector('', 'ABS_FOCUS_POSITION', 'Position', MAIN_CONTROL, 'rw', ['FOCUS_ABSOLUTE_POSITION', 'Position', FOCUSER_INITIAL_POSITION, 0, FOCUSER_MAX_POSITION, 1, '%.0f'])
	readonly #relativePosition = makeNumberVector('', 'REL_FOCUS_POSITION', 'Relative', MAIN_CONTROL, 'rw', ['FOCUS_RELATIVE_POSITION', 'Steps', 0, 0, FOCUSER_MAX_POSITION, 1, '%.0f'])
	readonly #motion = makeSwitchVector('', 'FOCUS_MOTION', 'Motion', MAIN_CONTROL, 'OneOfMany', 'rw', ['FOCUS_INWARD', 'Inward', false], ['FOCUS_OUTWARD', 'Outward', true])
	readonly #abort = makeSwitchVector('', 'FOCUS_ABORT_MOTION', 'Abort', MAIN_CONTROL, 'AtMostOne', 'rw', ['ABORT', 'Abort', false])
	readonly #reverse = makeSwitchVector('', 'FOCUS_REVERSE_MOTION', 'Reverse', MAIN_CONTROL, 'OneOfMany', 'rw', ['INDI_ENABLED', 'Enabled', false], ['INDI_DISABLED', 'Disabled', true])
	readonly #sync = makeNumberVector('', 'FOCUS_SYNC', 'Sync', MAIN_CONTROL, 'rw', ['FOCUS_SYNC_VALUE', 'Position', FOCUSER_INITIAL_POSITION, 0, FOCUSER_MAX_POSITION, 1, '%.0f'])
	readonly #temperature = makeNumberVector('', 'FOCUS_TEMPERATURE', 'Temperature', MAIN_CONTROL, 'ro', ['TEMPERATURE', 'Temperature', CAMERA_AMBIENT_TEMPERATURE, -50, 70, 0.1, '%6.2f'])
	readonly #temperatureCompensation = makeSwitchVector('', 'FOCUS_TEMPERATURE_COMPENSATION', 'Temperature Compensation', MAIN_CONTROL, 'OneOfMany', 'rw', ['INDI_ENABLED', 'On', false], ['INDI_DISABLED', 'Off', true])

	protected readonly properties: readonly SimulatorProperty[] = [this.#position, this.#relativePosition, this.#motion, this.#abort, this.#reverse, this.#sync, this.#temperature, this.#temperatureCompensation]
	protected propertiesToNotSave: readonly SimulatorProperty[] = this.properties.filter((e) => e !== this.#reverse && e !== this.#motion)

	#timer?: NodeJS.Timeout
	#lastTick = 0
	#targetPosition?: number
	#temperaturePhase = 0
	#lastCompensationTemperature = CAMERA_AMBIENT_TEMPERATURE

	constructor(
		name: string,
		client: ClientSimulator,
		readonly options?: DeviceSimulatorOptions,
		handler: IndiClientHandler = client.handler,
	) {
		super(name, client, handler, DeviceInterfaceType.FOCUSER)

		for (const property of this.properties) {
			property.device = name
		}

		this.driverInfo.elements.DRIVER_EXEC.value = 'focuser.simulator'
	}

	get position() {
		return this.#position.elements.FOCUS_ABSOLUTE_POSITION.value
	}

	get isMoving() {
		return this.#position.state === 'Busy'
	}

	get isTemperatureCompensationEnabled() {
		return this.#temperatureCompensation.elements.INDI_ENABLED.value
	}

	get temperature() {
		return this.#temperature.elements.TEMPERATURE.value
	}

	sendNumber(vector: NewNumberVector) {
		switch (vector.name) {
			case 'ABS_FOCUS_POSITION':
				if (vector.elements.FOCUS_ABSOLUTE_POSITION !== undefined) this.moveTo(vector.elements.FOCUS_ABSOLUTE_POSITION)
				return
			case 'REL_FOCUS_POSITION':
				if (vector.elements.FOCUS_RELATIVE_POSITION !== undefined) this.moveRelative(vector.elements.FOCUS_RELATIVE_POSITION)
				return
			case 'FOCUS_SYNC':
				if (vector.elements.FOCUS_SYNC_VALUE !== undefined) this.syncTo(vector.elements.FOCUS_SYNC_VALUE)
		}
	}

	sendSwitch(vector: NewSwitchVector) {
		super.sendSwitch(vector)

		switch (vector.name) {
			case 'CONNECTION':
				if (vector.elements.CONNECT === true) this.connect()
				else if (vector.elements.DISCONNECT === true) this.disconnect()
				return
			case 'FOCUS_MOTION':
				if (applyExclusiveSwitchValues(this.#motion, vector.elements)) this.notify(this.#motion)
				return
			case 'FOCUS_ABORT_MOTION':
				if (vector.elements.ABORT === true) this.stop()
				return
			case 'FOCUS_REVERSE_MOTION':
				if (applyExclusiveSwitchValues(this.#reverse, vector.elements)) this.notify(this.#reverse)
				return
			case 'FOCUS_TEMPERATURE_COMPENSATION':
				if (applyExclusiveSwitchValues(this.#temperatureCompensation, vector.elements)) {
					this.#lastCompensationTemperature = this.temperature
					this.notify(this.#temperatureCompensation)
				}
		}
	}

	// Connects the simulated focuser and publishes its supported properties.
	connect() {
		if (this.#timer) return

		super.connect()

		if (!this.isConnected) return

		this.#lastTick = Date.now()
		this.#lastCompensationTemperature = this.temperature
		this.#timer = setInterval(this.#tick.bind(this), TICK_INTERVAL_MS)
	}

	// Disconnects the simulated focuser and removes its dynamic properties.
	disconnect() {
		if (!this.#timer) return

		clearInterval(this.#timer)
		this.#timer = undefined
		this.stop(false)

		super.disconnect()
	}

	// Disposes the focuser simulator and removes it from the manager view.
	dispose() {
		this.disconnect()
		super.dispose()
	}

	// Starts an absolute focuser move.
	moveTo(position: number) {
		if (!this.isConnected) return

		position = clamp(position, this.#position.elements.FOCUS_ABSOLUTE_POSITION.min, this.#position.elements.FOCUS_ABSOLUTE_POSITION.max)
		if (position === this.position) return

		this.#targetPosition = position
		this.#relativePosition.elements.FOCUS_RELATIVE_POSITION.value = Math.abs(position - this.position)
		this.#setMoving(true)
	}

	// Starts a relative move using the selected motion direction.
	moveRelative(steps: number) {
		if (!this.isConnected || steps <= 0) return

		const direction = this.#relativeDirection()
		const target = clamp(this.position + steps * direction, this.#position.elements.FOCUS_ABSOLUTE_POSITION.min, this.#position.elements.FOCUS_ABSOLUTE_POSITION.max)
		if (target === this.position) return

		this.#relativePosition.elements.FOCUS_RELATIVE_POSITION.value = Math.abs(target - this.position)
		this.#targetPosition = target
		this.#setMoving(true)
	}

	// Applies a sync immediately without any slew time.
	syncTo(position: number) {
		if (!this.isConnected) return

		position = clamp(position, this.#position.elements.FOCUS_ABSOLUTE_POSITION.min, this.#position.elements.FOCUS_ABSOLUTE_POSITION.max)
		this.#sync.elements.FOCUS_SYNC_VALUE.value = position
		this.#position.elements.FOCUS_ABSOLUTE_POSITION.value = position
		this.#relativePosition.elements.FOCUS_RELATIVE_POSITION.value = 0
		this.stop(false)
		this.notify(this.#sync)
		this.notify(this.#position)
	}

	// Aborts the active move and leaves the focuser at its current position.
	stop(alert: boolean = true) {
		const wasMoving = this.isMoving
		this.#targetPosition = undefined
		this.#relativePosition.elements.FOCUS_RELATIVE_POSITION.value = 0
		this.#setMoving(false, alert)

		if (alert && wasMoving) {
			this.#abort.elements.ABORT.value = true
			this.notify(this.#abort)
			this.#abort.elements.ABORT.value = false
		}
	}

	// Advances the focuser position toward the requested target.
	#tick() {
		const now = Date.now()
		const dtSeconds = Math.max(0, (now - this.#lastTick) / 1000)
		this.#lastTick = now

		if (dtSeconds <= 0) return

		this.#advanceTemperature(dtSeconds)
		this.#applyTemperatureCompensation()

		if (this.#targetPosition === undefined) return

		const current = this.position
		const delta = this.#targetPosition - current
		const step = FOCUSER_MOVE_RATE * dtSeconds

		if (Math.abs(delta) <= step) {
			this.#position.elements.FOCUS_ABSOLUTE_POSITION.value = this.#targetPosition
			this.#relativePosition.elements.FOCUS_RELATIVE_POSITION.value = 0
			this.#targetPosition = undefined
			this.#setMoving(false)
			this.notify(this.#position)
			this.notify(this.#relativePosition)
			return
		}

		const next = current + Math.sign(delta) * step
		this.#position.elements.FOCUS_ABSOLUTE_POSITION.value = next
		this.#relativePosition.elements.FOCUS_RELATIVE_POSITION.value = Math.abs(this.#targetPosition - next)
		this.notify(this.#position)
		this.notify(this.#relativePosition)
	}

	// Updates the moving state reflected by both focuser motion vectors.
	#setMoving(moving: boolean, alert: boolean = false) {
		const state = alert ? 'Alert' : moving ? 'Busy' : 'Idle'
		let updated = false

		if (this.#position.state !== state) {
			this.#position.state = state
			updated = true
		}

		if (this.#relativePosition.state !== state) {
			this.#relativePosition.state = state
			updated = true
		}

		if (updated) {
			this.notify(this.#position)
			this.notify(this.#relativePosition)
		}
	}

	// Resolves the current relative-motion direction after reverse mode is applied.
	#relativeDirection() {
		const direction = this.#motion.elements.FOCUS_INWARD.value ? -1 : 1
		return this.#reverse.elements.INDI_ENABLED.value ? -direction : direction
	}

	// Advances the simulated ambient temperature with a smooth periodic waveform.
	#advanceTemperature(dtSeconds: number) {
		this.#temperaturePhase = normalizeAngle(this.#temperaturePhase + (dtSeconds * TAU) / FOCUSER_TEMPERATURE_PERIOD_SECONDS)
		const next = CAMERA_AMBIENT_TEMPERATURE + Math.sin(this.#temperaturePhase) * FOCUSER_TEMPERATURE_AMPLITUDE

		if (Math.abs(next - this.temperature) >= 0.1) {
			this.#temperature.elements.TEMPERATURE.value = next
			this.notify(this.#temperature)
		}
	}

	// Applies a simple temperature-compensation model by nudging focus position as ambient temperature drifts.
	#applyTemperatureCompensation() {
		if (!this.isTemperatureCompensationEnabled || this.isMoving) {
			this.#lastCompensationTemperature = this.temperature
			return
		}

		const delta = this.temperature - this.#lastCompensationTemperature
		if (Math.abs(delta) < FOCUSER_TEMPERATURE_COMPENSATION_HYSTERESIS) return

		const steps = Math.trunc(delta * FOCUSER_TEMPERATURE_COMPENSATION_STEPS)
		this.#lastCompensationTemperature = this.temperature
		if (steps === 0) return

		const target = clamp(this.position + steps, this.#position.elements.FOCUS_ABSOLUTE_POSITION.min, this.#position.elements.FOCUS_ABSOLUTE_POSITION.max)
		if (target === this.position) return

		this.#relativePosition.elements.FOCUS_RELATIVE_POSITION.value = Math.abs(target - this.position)
		this.#targetPosition = target
		this.#setMoving(true)
	}
}

export class FilterWheelSimulator extends DeviceSimulator {
	readonly type = 'WHEEL'

	readonly #position = makeNumberVector('', 'FILTER_SLOT', 'Slot', MAIN_CONTROL, 'rw', ['FILTER_SLOT_VALUE', 'Slot', 1, 1, FILTER_WHEEL_SLOT_NAMES.length, 1, '%.0f'])
	readonly #names = makeTextVector('', 'FILTER_NAME', 'Filter', MAIN_CONTROL, 'rw', ...FILTER_WHEEL_SLOT_NAMES.map((e, i) => [`FILTER_SLOT_NAME_${i + 1}`, `Slot ${i + 1}`, e] as never))

	protected readonly properties: readonly SimulatorProperty[] = [this.#position, this.#names]
	protected propertiesToNotSave: readonly SimulatorProperty[] = [this.#position]

	#moveTimer?: NodeJS.Timeout

	constructor(
		name: string,
		client: ClientSimulator,
		readonly options?: DeviceSimulatorOptions,
		handler: IndiClientHandler = client.handler,
	) {
		super(name, client, handler, DeviceInterfaceType.FILTER)

		for (const property of this.properties) {
			property.device = name
		}

		this.driverInfo.elements.DRIVER_EXEC.value = 'filterwheel.simulator'
	}

	sendText(vector: NewTextVector) {
		super.sendText(vector)

		if (vector.name === 'FILTER_NAME' && applyTextVectorValues(this.#names, vector.elements)) {
			this.notify(this.#names)
		}
	}

	sendNumber(vector: NewNumberVector) {
		if (vector.name === 'FILTER_SLOT' && vector.elements.FILTER_SLOT_VALUE !== undefined) {
			this.moveTo(vector.elements.FILTER_SLOT_VALUE)
		}
	}

	sendSwitch(vector: NewSwitchVector) {
		super.sendSwitch(vector)

		if (vector.name === 'CONNECTION') {
			if (vector.elements.CONNECT === true) this.connect()
			else if (vector.elements.DISCONNECT === true) this.disconnect()
		}
	}

	// Disconnects the simulated filter wheel and removes its dynamic properties.
	disconnect() {
		if (!this.isConnected) return

		if (this.#moveTimer) {
			clearTimeout(this.#moveTimer)
			this.#moveTimer = undefined
		}

		this.#position.state = 'Idle'

		super.disconnect()
	}

	// Disposes the filter wheel simulator and removes it from the manager view.
	dispose() {
		this.disconnect()
		super.dispose()
	}

	// Starts a slot change with a short time-based delay.
	moveTo(slot: number) {
		if (!this.isConnected) return

		slot = clamp(Math.round(slot), this.#position.elements.FILTER_SLOT_VALUE.min, this.#position.elements.FILTER_SLOT_VALUE.max)
		const current = this.#position.elements.FILTER_SLOT_VALUE.value
		if (slot === current) return

		if (this.#moveTimer) {
			clearTimeout(this.#moveTimer)
			this.#moveTimer = undefined
		}

		this.#position.state = 'Busy'
		this.notify(this.#position)

		this.#moveTimer = setTimeout(
			() => {
				this.#moveTimer = undefined
				this.#position.elements.FILTER_SLOT_VALUE.value = slot
				this.#position.state = 'Idle'
				this.notify(this.#position)
			},
			Math.max(150, Math.abs(slot - current) * FILTER_WHEEL_MOVE_TIME_MS),
		)
	}
}

export class RotatorSimulator extends DeviceSimulator {
	readonly type = 'ROTATOR'

	readonly #angle = makeNumberVector('', 'ABS_ROTATOR_ANGLE', 'Goto', MAIN_CONTROL, 'rw', ['ANGLE', 'Angle', 0, 0, 360, 0.01, '%.2f'])
	readonly #sync = makeNumberVector('', 'SYNC_ROTATOR_ANGLE', 'Sync', MAIN_CONTROL, 'rw', ['ANGLE', 'Angle', 0, 0, 360, 0.01, '%.2f'])
	readonly #home = makeSwitchVector('', 'ROTATOR_HOME', 'Home', MAIN_CONTROL, 'AtMostOne', 'rw', ['HOME', 'Home', false])
	readonly #abort = makeSwitchVector('', 'ROTATOR_ABORT_MOTION', 'Abort', MAIN_CONTROL, 'AtMostOne', 'rw', ['ABORT', 'Abort', false])
	readonly #reverse = makeSwitchVector('', 'ROTATOR_REVERSE', 'Reverse', MAIN_CONTROL, 'OneOfMany', 'rw', ['INDI_ENABLED', 'Enabled', false], ['INDI_DISABLED', 'Disabled', true])
	readonly #backlash = makeSwitchVector('', 'ROTATOR_BACKLASH_TOGGLE', 'Backlash', MAIN_CONTROL, 'OneOfMany', 'rw', ['INDI_ENABLED', 'Enabled', false], ['INDI_DISABLED', 'Disabled', true])

	protected readonly properties: readonly SimulatorProperty[] = [this.#angle, this.#sync, this.#home, this.#abort, this.#reverse, this.#backlash]
	protected propertiesToNotSave: readonly SimulatorProperty[] = [this.#sync, this.#home, this.#abort]

	#timer?: NodeJS.Timeout
	#lastTick = 0
	#targetAngle?: number
	#homing = false

	constructor(
		name: string,
		client: ClientSimulator,
		readonly options?: DeviceSimulatorOptions,
		handler: IndiClientHandler = client.handler,
	) {
		super(name, client, handler, DeviceInterfaceType.ROTATOR)

		for (const property of this.properties) {
			property.device = name
		}

		this.driverInfo.elements.DRIVER_EXEC.value = 'rotator.simulator'
	}

	get angle() {
		return this.#angle.elements.ANGLE.value
	}

	get isMoving() {
		return this.#angle.state === 'Busy'
	}

	sendNumber(vector: NewNumberVector) {
		switch (vector.name) {
			case 'ABS_ROTATOR_ANGLE':
				if (vector.elements.ANGLE !== undefined) this.moveTo(vector.elements.ANGLE)
				return
			case 'SYNC_ROTATOR_ANGLE':
				if (vector.elements.ANGLE !== undefined) this.syncTo(vector.elements.ANGLE)
		}
	}

	sendSwitch(vector: NewSwitchVector) {
		super.sendSwitch(vector)

		switch (vector.name) {
			case 'CONNECTION':
				if (vector.elements.CONNECT === true) this.connect()
				else if (vector.elements.DISCONNECT === true) this.disconnect()
				return
			case 'ROTATOR_HOME':
				if (vector.elements.HOME === true) this.home()
				return
			case 'ROTATOR_ABORT_MOTION':
				if (vector.elements.ABORT === true) this.stop()
				return
			case 'ROTATOR_REVERSE':
				if (applyExclusiveSwitchValues(this.#reverse, vector.elements)) this.notify(this.#reverse)
				return
			case 'ROTATOR_BACKLASH_TOGGLE':
				if (applyExclusiveSwitchValues(this.#backlash, vector.elements)) this.notify(this.#backlash)
		}
	}

	// Connects the simulated rotator and publishes its supported properties.
	connect() {
		if (this.#timer) return

		super.connect()

		if (!this.isConnected) return

		this.#lastTick = Date.now()
		this.#timer = setInterval(this.#tick.bind(this), TICK_INTERVAL_MS)
	}

	// Disconnects the simulated rotator and removes its dynamic properties.
	disconnect() {
		if (!this.#timer) return

		clearInterval(this.#timer)
		this.#timer = undefined
		this.stop(false)

		super.disconnect()
	}

	// Disposes the rotator simulator and removes it from the manager view.
	dispose() {
		this.disconnect()
		super.dispose()
	}

	// Starts a rotation to the requested angle.
	moveTo(angle: number) {
		if (!this.isConnected) return

		angle = clamp(angle, this.#angle.elements.ANGLE.min, this.#angle.elements.ANGLE.max)
		if (angle === this.angle) return

		this.#targetAngle = angle
		this.#homing = false
		this.#setMoving(true)
	}

	// Syncs the rotator immediately without moving.
	syncTo(angle: number) {
		if (!this.isConnected) return

		angle = clamp(angle, this.#angle.elements.ANGLE.min, this.#angle.elements.ANGLE.max)
		this.#sync.elements.ANGLE.value = angle
		this.#angle.elements.ANGLE.value = angle
		this.stop(false)
		this.notify(this.#sync)
		this.notify(this.#angle)
	}

	// Sends the rotator to the configured home angle.
	home() {
		if (!this.isConnected) return
		this.#targetAngle = 0
		this.#homing = true
		this.#setMoving(true)
	}

	// Aborts the active rotation.
	stop(alert: boolean = true) {
		const wasMoving = this.isMoving
		this.#targetAngle = undefined
		this.#homing = false
		this.#setMoving(false, alert)

		if (alert && wasMoving) {
			this.#abort.elements.ABORT.value = true
			this.notify(this.#abort)
			this.#abort.elements.ABORT.value = false
		}
	}

	// Advances the rotator toward the requested angle.
	#tick() {
		const now = Date.now()
		const dtSeconds = Math.max(0, (now - this.#lastTick) / 1000)
		this.#lastTick = now

		if (dtSeconds <= 0 || this.#targetAngle === undefined) return

		const current = this.angle
		const delta = shortestRotatorDelta(this.#targetAngle, current)
		const step = ROTATOR_MOVE_RATE * dtSeconds

		if (Math.abs(delta) <= step) {
			this.#angle.elements.ANGLE.value = this.#targetAngle
			this.notify(this.#angle)
			this.#targetAngle = undefined
			this.#homing = false
			this.#setMoving(false)
			return
		}

		this.#angle.elements.ANGLE.value = wrapRotatorAngle(current + Math.sign(delta) * step)
		this.notify(this.#angle)
	}

	// Updates the busy state reflected by the rotator angle and home properties.
	#setMoving(moving: boolean, alert: boolean = false) {
		const angleState = alert ? 'Alert' : moving ? 'Busy' : 'Idle'
		let updated = false

		if (this.#angle.state !== angleState) {
			this.#angle.state = angleState
			updated = true
		}

		const homeState = alert ? 'Alert' : this.#homing && moving ? 'Busy' : 'Idle'
		if (this.#home.state !== homeState) {
			this.#home.state = homeState
			this.#home.elements.HOME.value = this.#homing && moving
			updated = true
		} else if (this.#home.elements.HOME.value !== (this.#homing && moving)) {
			this.#home.elements.HOME.value = this.#homing && moving
			updated = true
		}

		if (updated) {
			this.notify(this.#angle)
			this.notify(this.#home)
		}
	}
}

export class FlatPanelSimulator extends DeviceSimulator {
	readonly type = 'FLAT_PANEL'

	readonly #light = makeSwitchVector('', 'FLAT_LIGHT_CONTROL', 'Light', MAIN_CONTROL, 'OneOfMany', 'rw', ['FLAT_LIGHT_ON', 'On', false], ['FLAT_LIGHT_OFF', 'Off', true])
	readonly #intensity = makeNumberVector('', 'FLAT_LIGHT_INTENSITY', 'Brightness', MAIN_CONTROL, 'rw', ['FLAT_LIGHT_INTENSITY_VALUE', 'Brightness', 0, 0, PANEL_MAX_INTENSITY, 1, '%.0f'])

	protected readonly properties: readonly SimulatorProperty[] = [this.#light, this.#intensity]
	protected propertiesToNotSave: readonly SimulatorProperty[] = []

	constructor(
		name: string,
		client: ClientSimulator,
		readonly options?: DeviceSimulatorOptions,
		handler: IndiClientHandler = client.handler,
	) {
		super(name, client, handler, DeviceInterfaceType.LIGHTBOX)

		for (const property of this.properties) {
			property.device = name
		}

		this.driverInfo.elements.DRIVER_EXEC.value = 'lightbox.simulator'
	}

	sendNumber(vector: NewNumberVector) {
		if (vector.name === 'FLAT_LIGHT_INTENSITY' && applyNumberVectorValues(this.#intensity, vector.elements)) {
			this.notify(this.#intensity)
		}
	}

	sendSwitch(vector: NewSwitchVector) {
		super.sendSwitch(vector)

		switch (vector.name) {
			case 'CONNECTION':
				if (vector.elements.CONNECT === true) this.connect()
				else if (vector.elements.DISCONNECT === true) this.disconnect()
				return
			case 'FLAT_LIGHT_CONTROL':
				if (applyExclusiveSwitchValues(this.#light, vector.elements)) this.notify(this.#light)
		}
	}

	// Disposes the flat-panel simulator and removes it from the manager view.
	dispose() {
		this.disconnect()
		super.dispose()
	}
}

export class CoverSimulator extends DeviceSimulator {
	readonly type = 'COVER'

	readonly #park = makeSwitchVector('', 'CAP_PARK', 'Park', MAIN_CONTROL, 'OneOfMany', 'rw', ['PARK', 'Park', false], ['UNPARK', 'Unpark', true])
	readonly #abort = makeSwitchVector('', 'CAP_ABORT', 'Abort', MAIN_CONTROL, 'AtMostOne', 'rw', ['ABORT', 'Abort', false])

	protected readonly properties: readonly SimulatorProperty[] = [this.#park, this.#abort]
	protected propertiesToNotSave: readonly SimulatorProperty[] = this.properties

	#moveTimer?: NodeJS.Timeout

	constructor(
		name: string,
		client: ClientSimulator,
		readonly options?: DeviceSimulatorOptions,
		handler: IndiClientHandler = client.handler,
	) {
		super(name, client, handler, DeviceInterfaceType.DUSTCAP)

		for (const property of this.properties) {
			property.device = name
		}

		this.driverInfo.elements.DRIVER_EXEC.value = 'dustcap.simulator'
	}

	sendNumber(vector: NewNumberVector) {}

	sendSwitch(vector: NewSwitchVector) {
		super.sendSwitch(vector)

		switch (vector.name) {
			case 'CONNECTION':
				if (vector.elements.CONNECT === true) this.connect()
				else if (vector.elements.DISCONNECT === true) this.disconnect()
				return
			case 'CAP_PARK':
				if (vector.elements.PARK === true) this.park()
				else if (vector.elements.UNPARK === true) this.unpark()
				return
			case 'CAP_ABORT':
				if (vector.elements.ABORT === true) this.stop()
		}
	}

	// Disconnects the simulated dust cap and removes its dynamic properties.
	disconnect() {
		if (!this.isConnected) return

		this.stop(false)
		super.disconnect()
	}

	// Disposes the dust-cap simulator and removes it from the manager view.
	dispose() {
		this.disconnect()
		super.dispose()
	}

	// Starts closing the dust cap.
	park() {
		if (!this.isConnected || this.#park.state === 'Busy' || this.#park.elements.PARK.value) return
		this.#startParkTransition(true)
	}

	// Starts opening the dust cap.
	unpark() {
		if (!this.isConnected || this.#park.state === 'Busy' || this.#park.elements.UNPARK.value) return
		this.#startParkTransition(false)
	}

	// Stops any active cap transition.
	stop(alert: boolean = true) {
		const wasMoving = this.#moveTimer !== undefined
		if (this.#moveTimer) {
			clearTimeout(this.#moveTimer)
			this.#moveTimer = undefined
		}

		if (this.#park.state !== 'Idle') {
			this.#park.state = alert && wasMoving ? 'Alert' : 'Idle'
			this.notify(this.#park)
		}

		if (alert && wasMoving) {
			this.#abort.elements.ABORT.value = true
			this.notify(this.#abort)
			this.#abort.elements.ABORT.value = false
		}
	}

	// Schedules the cap open or close transition.
	#startParkTransition(parked: boolean) {
		this.stop(false)
		this.#park.state = 'Busy'
		this.notify(this.#park)

		this.#moveTimer = setTimeout(() => {
			this.#moveTimer = undefined
			selectOnSwitch(this.#park, parked ? 'PARK' : 'UNPARK')
			this.#park.state = 'Idle'
			this.notify(this.#park)
		}, COVER_MOVE_TIME_MS)
	}
}

export { CoverSimulator as DustCapSimulator, FilterWheelSimulator as WheelSimulator, FlatPanelSimulator as LightBoxSimulator }

export class CameraSimulator extends DeviceSimulator {
	readonly type = 'CAMERA'

	// oxfmt-ignore
	readonly #info = makeNumberVector('', 'CCD_INFO', 'CCD Info', GENERAL_INFO, 'ro', ['CCD_MAX_X', 'Max X', CAMERA_SENSOR_WIDTH, 0, 16000, 1, '%.0f'],  ['CCD_MAX_Y', 'Max Y', CAMERA_SENSOR_HEIGHT, 0, 16000, 1, '%.0f'],  ['CCD_PIXEL_SIZE_X', 'Pixel size X', CAMERA_PIXEL_SIZE, 0, 40, 0.01, '%.2f'], ['CCD_PIXEL_SIZE_Y', 'Pixel size Y', CAMERA_PIXEL_SIZE, 0, 40, 0.01, '%.2f'], ['CCD_BITSPERPIXEL', 'Bits per pixel', 16, 8, 64, 1, '%.0f'])
	readonly #cooler = makeSwitchVector('', 'CCD_COOLER', 'Cooler', MAIN_CONTROL, 'OneOfMany', 'rw', ['COOLER_ON', 'On', false], ['COOLER_OFF', 'Off', true])
	readonly #frameType = makeSwitchVector('', 'CCD_FRAME_TYPE', 'Frame Type', MAIN_CONTROL, 'OneOfMany', 'rw', ['FRAME_LIGHT', 'Light', true], ['FRAME_DARK', 'Dark', false], ['FRAME_FLAT', 'Flat', false], ['FRAME_BIAS', 'Bias', false])
	readonly #frameFormat = makeSwitchVector('', 'CCD_CAPTURE_FORMAT', 'Readout Mode', MAIN_CONTROL, 'OneOfMany', 'rw', ['MONO', 'Mono', true], ['RGB', 'RGB', false])
	readonly #transferFormat = makeSwitchVector('', 'CCD_TRANSFER_FORMAT', 'Transfer Format', MAIN_CONTROL, 'OneOfMany', 'rw', ['FORMAT_FITS', 'FITS', true], ['FORMAT_XISF', 'XISF', false])
	readonly #abort = makeSwitchVector('', 'CCD_ABORT_EXPOSURE', 'Abort', MAIN_CONTROL, 'AtMostOne', 'rw', ['ABORT', 'Abort', false])
	readonly #exposure = makeNumberVector('', 'CCD_EXPOSURE', 'Exposure', MAIN_CONTROL, 'rw', ['CCD_EXPOSURE_VALUE', 'Exposure (s)', 0, CAMERA_MIN_EXPOSURE, CAMERA_MAX_EXPOSURE, 1e-3, '%.6f'])
	readonly #coolerPower = makeNumberVector('', 'CCD_COOLER_POWER', 'Cooler Power', MAIN_CONTROL, 'ro', ['CCD_COOLER_POWER', 'Power (%)', 0, 0, 100, 1, '%.0f'])
	readonly #temperature = makeNumberVector('', 'CCD_TEMPERATURE', 'Temperature', MAIN_CONTROL, 'rw', ['CCD_TEMPERATURE_VALUE', 'Temperature', CAMERA_AMBIENT_TEMPERATURE, -50, 70, 0.1, '%6.2f'])
	// oxfmt-ignore
	readonly #frame = makeNumberVector('', 'CCD_FRAME', 'Frame', MAIN_CONTROL, 'rw', ['X', 'X', 0, 0, CAMERA_SENSOR_WIDTH - 1, 1, '%.0f'], ['Y', 'Y', 0, 0, CAMERA_SENSOR_HEIGHT - 1, 1, '%.0f'], ['WIDTH', 'Width', CAMERA_SENSOR_WIDTH, 1, CAMERA_SENSOR_WIDTH, 1, '%.0f'], ['HEIGHT', 'Height', CAMERA_SENSOR_HEIGHT, 1, CAMERA_SENSOR_HEIGHT, 1, '%.0f'])
	readonly #bin = makeNumberVector('', 'CCD_BINNING', 'Bin', MAIN_CONTROL, 'rw', ['HOR_BIN', 'X', 1, 1, CAMERA_MAX_BIN, 1, '%.0f'], ['VER_BIN', 'Y', 1, 1, CAMERA_MAX_BIN, 1, '%.0f'])
	readonly #gain = makeNumberVector('', 'CCD_GAIN', 'Gain', MAIN_CONTROL, 'rw', ['GAIN', 'Gain', 0, 0, 400, 1, '%.0f'])
	readonly #offset = makeNumberVector('', 'CCD_OFFSET', 'Offset', MAIN_CONTROL, 'rw', ['OFFSET', 'Offset', 0, 0, 1000, 1, '%.0f'])
	readonly #cfa = makeTextVector('', 'CCD_CFA', 'CFA', GENERAL_INFO, 'ro', ['CFA_OFFSET_X', 'Offset X', '0'], ['CFA_OFFSET_Y', 'Offset Y', '0'], ['CFA_TYPE', 'Type', 'RGGB'])
	readonly #guideNS = makeNumberVector('', 'TELESCOPE_TIMED_GUIDE_NS', 'Guide N/S', MAIN_CONTROL, 'rw', ['TIMED_GUIDE_N', 'North (ms)', 0, 0, 60000, 1, '%.0f'], ['TIMED_GUIDE_S', 'South (ms)', 0, 0, 60000, 1, '%.0f'])
	readonly #guideWE = makeNumberVector('', 'TELESCOPE_TIMED_GUIDE_WE', 'Guide W/E', MAIN_CONTROL, 'rw', ['TIMED_GUIDE_W', 'West (ms)', 0, 0, 60000, 1, '%.0f'], ['TIMED_GUIDE_E', 'East (ms)', 0, 0, 60000, 1, '%.0f'])
	readonly #image = makeBlobVector('', 'CCD1', 'CCD Image', MAIN_CONTROL, 'ro', ['CCD1', 'Image'])

	// oxfmt-ignore
	readonly #scene = makeNumberVector('', 'SIMULATOR_SCENE', 'Scene', SIMULATION, 'rw', ['SCENE_SEED', 'Seed', CAMERA_SCENE_SEED, 0, 0xffffffff, 1, '%.0f'], ['STAR_DENSITY', 'Star Density', 0.0006, 0, 0.01, 0.0001, '%.6f'], ['SEEING', 'Seeing (px)', 1.2, 0, 20, 0.1, '%.2f'], ['HFD_MIN', 'HFD Min (px)', 1.2, 0.35, 10, 0.1, '%.2f'], ['HFD_MAX', 'HFD Max (px)', 3.6, 0.35, 20, 0.1, '%.2f'], ['FLUX_MIN', 'Flux Min', 0.002, 0, 10, 0.001, '%.4f'], ['FLUX_MAX', 'Flux Max', 0.85, 0, 100, 0.01, '%.4f'])
	readonly #catalogSource = makeSwitchVector('', 'SIMULATOR_CATALOG_SOURCE', 'Catalog Source', SIMULATION, 'OneOfMany', 'rw', ['RANDOM', 'Random', true], ['VIZIER', 'VizieR', false])
	// oxfmt-ignore
	readonly #noiseQuality = makeSwitchVector('', 'SIMULATOR_NOISE_QUALITY', 'Noise Quality', SIMULATION, 'OneOfMany', 'rw', ['FAST', 'Fast', false], ['BALANCED', 'Balanced', true], ['HIGH_REALISM', 'High Realism', false])
	// oxfmt-ignore
	readonly #noiseFeatures = makeSwitchVector('', 'SIMULATOR_NOISE_FEATURES', 'Noise Features', SIMULATION, 'AnyOfMany', 'rw', ['SKY_ENABLED', 'Sky', true], ['MOON_ENABLED', 'Moon', false], ['LIGHT_POLLUTION_ENABLED', 'Light Pollution', true], ['AMP_GLOW_ENABLED', 'Amp Glow', false], ['OUTPUT_QUANTIZE', 'Quantize', false])
	// oxfmt-ignore
	readonly #noiseExposure = makeNumberVector('', 'SIMULATOR_NOISE_EXPOSURE', 'Noise Exposure', SIMULATION, 'rw', ['EXPOSURE_TIME', 'Exposure Time', DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.exposure.exposureTime, CAMERA_MIN_EXPOSURE, CAMERA_MAX_EXPOSURE, 0.1, '%.3f'], ['ANALOG_GAIN', 'Analog Gain', DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.exposure.analogGain, 0.01, 20, 0.01, '%.3f'], ['DIGITAL_GAIN', 'Digital Gain', DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.exposure.digitalGain, 0.01, 20, 0.01, '%.3f'], ['ELECTRONS_PER_ADU', 'Electrons/ADU', DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.exposure.electronsPerAdu, 0.01, 100, 0.01, '%.3f'])
	// oxfmt-ignore
	readonly #noiseSky = makeNumberVector('', 'SIMULATOR_NOISE_SKY', 'Sky', SIMULATION, 'rw', ['BASE_RATE', 'Base Rate', DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.sky.baseRate, 0, 50, 0.01, '%.3f'], ['GLOBAL_OFFSET', 'Global Offset', DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.sky.globalOffset, -10, 10, 0.01, '%.3f'], ['GRADIENT_STRENGTH', 'Gradient Strength', DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.sky.gradientStrength, 0, 10, 0.01, '%.3f'], ['GRADIENT_DIRECTION', 'Gradient Direction', DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.sky.gradientDirection, -TAU, TAU, 0.01, '%.3f'], ['RADIAL_GRADIENT_STRENGTH', 'Radial Gradient', DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.sky.radialGradientStrength, 0, 10, 0.01, '%.3f'], ['LOW_FREQUENCY_VARIATION_STRENGTH', 'Low Freq Variation', DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.sky.lowFrequencyVariationStrength, 0, 10, 0.01, '%.3f'])
	// oxfmt-ignore
	readonly #noiseMoon = makeNumberVector('', 'SIMULATOR_NOISE_MOON', 'Moon', SIMULATION, 'rw', ['ILLUMINATION_FRACTION', 'Illumination', DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.moon.illuminationFraction, 0, 1, 0.01, '%.3f'], ['ALTITUDE', 'Altitude', DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.moon.altitude, -PIOVERTWO, PIOVERTWO, 0.01, '%.3f'], ['ANGULAR_DISTANCE', 'Angular Distance', DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.moon.angularDistance, 0, TAU, 0.01, '%.3f'], ['POSITION_ANGLE', 'Position Angle', DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.moon.positionAngle, -TAU, TAU, 0.01, '%.3f'], ['STRENGTH', 'Strength', DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.moon.strength, 0, 10, 0.01, '%.3f'])
	// oxfmt-ignore
	readonly #noiseLightPollution = makeNumberVector('', 'SIMULATOR_NOISE_LIGHT_POLLUTION', 'Light Pollution', SIMULATION, 'rw', ['STRENGTH', 'Strength', DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.lightPollution.strength, 0, 10, 0.01, '%.3f'], ['DIRECTION', 'Direction', DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.lightPollution.direction, -TAU, TAU, 0.01, '%.3f'], ['GRADIENT_STRENGTH', 'Gradient Strength', DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.lightPollution.gradientStrength, 0, 10, 0.01, '%.3f'], ['DOME_SHARPNESS', 'Dome Sharpness', DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.lightPollution.domeSharpness, 0, 20, 0.01, '%.3f'])
	// oxfmt-ignore
	readonly #noiseAtmosphere = makeNumberVector('', 'SIMULATOR_NOISE_ATMOSPHERE', 'Atmosphere', SIMULATION, 'rw', ['AIRGLOW_STRENGTH', 'Airglow', DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.atmosphere.airglowStrength, 0, 10, 0.01, '%.3f'], ['TRANSPARENCY', 'Transparency', DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.atmosphere.transparency, 0, 2, 0.01, '%.3f'], ['AIRMASS', 'Airmass', DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.atmosphere.airmass, 0, 10, 0.01, '%.3f'], ['HAZE', 'Haze', DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.atmosphere.haze, 0, 10, 0.01, '%.3f'], ['HUMIDITY', 'Humidity', DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.atmosphere.humidity, 0, 1, 0.01, '%.3f'], ['THIN_CLOUD_VEIL', 'Thin Cloud Veil', DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.atmosphere.thinCloudVeil, 0, 10, 0.01, '%.3f'], ['TWILIGHT_CONTRIBUTION', 'Twilight', DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.atmosphere.twilightContribution, 0, 10, 0.01, '%.3f'], ['HORIZON_GLOW', 'Horizon Glow', DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.atmosphere.horizonGlow, 0, 10, 0.01, '%.3f'], ['ZODIACAL_LIGHT_FACTOR', 'Zodiacal Light', DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.atmosphere.zodiacalLightFactor, 0, 10, 0.01, '%.3f'], ['MILKY_WAY_BACKGROUND_FACTOR', 'Milky Way', DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.atmosphere.milkyWayBackgroundFactor, 0, 10, 0.01, '%.3f'])
	// oxfmt-ignore
	readonly #noiseSensor = makeNumberVector('', 'SIMULATOR_NOISE_SENSOR', 'Sensor', SIMULATION, 'rw', ['READ_NOISE', 'Read Noise', DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.sensor.readNoise, 0, 100, 0.01, '%.3f'], ['BIAS_ELECTRONS', 'Bias Electrons', DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.sensor.biasElectrons, 0, 10000, 1, '%.0f'], ['BLACK_LEVEL_ELECTRONS', 'Black Level', DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.sensor.blackLevelElectrons, 0, 10000, 1, '%.0f'], ['DARK_CURRENT_AT_REFERENCE_TEMP', 'Dark Current', DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.sensor.darkCurrentAtReferenceTemp, 0, 100, 0.001, '%.4f'], ['REFERENCE_TEMPERATURE', 'Reference Temp', DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.sensor.referenceTemperature, -50, 70, 0.1, '%.2f'], ['TEMPERATURE', 'Sensor Temp', DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.sensor.temperature, -50, 70, 0.1, '%.2f'], ['TEMPERATURE_DOUBLING_INTERVAL', 'Doubling Interval', DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.sensor.temperatureDoublingInterval, 0.1, 50, 0.1, '%.2f'], ['DARK_SIGNAL_NON_UNIFORMITY', 'DSNU', DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.sensor.darkSignalNonUniformity, 0, 10, 0.001, '%.4f'], ['FULL_WELL_CAPACITY', 'Full Well', DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.sensor.fullWellCapacity, 1, 1000000, 1, '%.0f'], ['CHANNEL_CORRELATION', 'Channel Correlation', DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.sensor.channelCorrelation, 0, 1, 0.01, '%.3f'])
	// oxfmt-ignore
	readonly #noiseAmpGlow = makeNumberVector('', 'SIMULATOR_NOISE_AMP_GLOW', 'Amp Glow', SIMULATION, 'rw', ['STRENGTH', 'Strength', DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.sensor.ampGlow.strength, 0, 10, 0.001, '%.4f'], ['RADIUS_X', 'Radius X', DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.sensor.ampGlow.radiusX, 0.01, 2, 0.01, '%.3f'], ['RADIUS_Y', 'Radius Y', DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.sensor.ampGlow.radiusY, 0.01, 2, 0.01, '%.3f'], ['FALLOFF', 'Falloff', DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.sensor.ampGlow.falloff, 0.1, 20, 0.1, '%.2f'])
	// oxfmt-ignore
	readonly #noiseAmpGlowPosition = makeSwitchVector('', 'SIMULATOR_NOISE_AMP_GLOW_POSITION', 'Amp Glow Position', SIMULATION, 'OneOfMany', 'rw', ['TOP_LEFT', 'Top Left', false], ['TOP_RIGHT', 'Top Right', false], ['BOTTOM_LEFT', 'Bottom Left', false], ['BOTTOM_RIGHT', 'Bottom Right', false], ['LEFT', 'Left', false], ['RIGHT', 'Right', true], ['TOP', 'Top', false], ['BOTTOM', 'Bottom', false])
	// oxfmt-ignore
	readonly #noiseArtifacts = makeNumberVector('', 'SIMULATOR_NOISE_ARTIFACTS', 'Artifacts', SIMULATION, 'rw', ['FIXED_PATTERN_NOISE_STRENGTH', 'Fixed Pattern', DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.artifacts.fixedPatternNoiseStrength, 0, 10, 0.001, '%.4f'], ['ROW_NOISE_STRENGTH', 'Row Noise', DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.artifacts.rowNoiseStrength, 0, 10, 0.001, '%.4f'], ['COLUMN_NOISE_STRENGTH', 'Column Noise', DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.artifacts.columnNoiseStrength, 0, 10, 0.001, '%.4f'], ['BANDING_STRENGTH', 'Banding', DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.artifacts.bandingStrength, 0, 10, 0.001, '%.4f'], ['BANDING_FREQUENCY', 'Banding Frequency', DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.artifacts.bandingFrequency, 0, 100, 0.1, '%.3f'], ['HOT_PIXEL_RATE', 'Hot Pixel Rate', DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.artifacts.hotPixelRate, 0, 1, 0.00001, '%.5f'], ['WARM_PIXEL_RATE', 'Warm Pixel Rate', DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.artifacts.warmPixelRate, 0, 1, 0.00001, '%.5f'], ['DEAD_PIXEL_RATE', 'Dead Pixel Rate', DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.artifacts.deadPixelRate, 0, 1, 0.00001, '%.5f'], ['HOT_PIXEL_STRENGTH', 'Hot Pixel Strength', DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.artifacts.hotPixelStrength, 0, 10000, 1, '%.0f'], ['WARM_PIXEL_STRENGTH', 'Warm Pixel Strength', DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.artifacts.warmPixelStrength, 0, 10000, 1, '%.0f'], ['DEAD_PIXEL_RESIDUAL', 'Dead Pixel Residual', DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.artifacts.deadPixelResidual, 0, 1, 0.001, '%.4f'])
	readonly #noiseOutput = makeNumberVector('', 'SIMULATOR_NOISE_OUTPUT', 'Output', SIMULATION, 'rw', ['MAX_VALUE', 'Max Value', DEFAULT_ASTRONOMICAL_IMAGE_NOISE_CONFIG.output.maxValue, 1, 4294967295, 1, '%.0f'])
	readonly #noiseClampMode = makeSwitchVector('', 'SIMULATOR_NOISE_CLAMP_MODE', 'Clamp Mode', SIMULATION, 'OneOfMany', 'rw', ['CLAMP', 'Clamp', true], ['NORMALIZE', 'Normalize', false], ['NONE', 'None', false])
	// oxfmt-ignore
	readonly #plotOptions = makeNumberVector('', 'SIMULATOR_STAR_PLOT_OPTIONS', 'Star Plot', SIMULATION, 'rw', ['BACKGROUND', 'Background', 0, 0, 10, 0.001, '%.4f'], ['SATURATION_LEVEL', 'Saturation Level', 1, 0, 10, 0.01, '%.3f'], ['FOCUS_STEP', 'Focus Step', 50000, 0, 100000, 1, '%.0f'], ['BEST_FOCUS', 'Best Focus', 50000, 0, 100000, 1, '%.0f'], ['PEAK_SCALE', 'Peak Scale', 1, 0.01, 20, 0.01, '%.3f'], ['ELLIPTICITY', 'Ellipticity', 0, 0, 0.8, 0.01, '%.3f'], ['THETA', 'Theta', 0, -TAU, TAU, 0.01, '%.3f'], ['SOFT_CORE', 'Soft Core', 0, 0, 10, 0.01, '%.3f'], ['BETA', 'Beta', 2.5, 1.05, 20, 0.01, '%.3f'], ['HALO_STRENGTH', 'Halo Strength', 0, 0, 5, 0.01, '%.3f'], ['HALO_SCALE', 'Halo Scale', 2.8, 1.1, 20, 0.01, '%.3f'], ['JITTER_X', 'Jitter X', 0, -5, 5, 0.01, '%.3f'], ['JITTER_Y', 'Jitter Y', 0, -5, 5, 0.01, '%.3f'], ['GAIN', 'Plot Gain', 1, 0.01, 20, 0.01, '%.3f'], ['GAMMA_COMPENSATION', 'Gamma Compensation', 2.2, 0.1, 10, 0.01, '%.3f'], ['ADDITIVE_NOISE_HINT', 'Additive Noise Hint', 0, 0, 20, 0.01, '%.3f'], ['MIN_PLOT_RADIUS', 'Min Radius', 2, 0, 50, 1, '%.0f'], ['MAX_PLOT_RADIUS', 'Max Radius', 24, 0, 100, 1, '%.0f'], ['CUTOFF_SIGMA', 'Cutoff Sigma', 4.25, 2.5, 10, 0.01, '%.3f'])
	readonly #plotFlags = makeSwitchVector('', 'SIMULATOR_STAR_PLOT_FLAGS', 'Star Plot Flags', SIMULATION, 'AnyOfMany', 'rw', ['SATURATION_ENABLED', 'Saturation', false], ['GAMMA_ENABLED', 'Gamma', false])
	readonly #plotPsfModel = makeSwitchVector('', 'SIMULATOR_STAR_PLOT_PSF_MODEL', 'Star PSF Model', SIMULATION, 'OneOfMany', 'rw', ['GAUSSIAN', 'Gaussian', true], ['MOFFAT', 'Moffat', false])
	readonly #telescopeInfo = makeNumberVector('', 'TELESCOPE_INFO', 'Telescope Info', SIMULATION, 'rw', ['FOCAL_LENGTH', 'Focal Length (mm)', 500, 1, 10000, 1, '%.0f'], ['APERTURE', 'Aperture (mm)', 80, 1, 3000, 1, '%.0f'])
	readonly #telescopeEffects = makeNumberVector(
		'',
		'TELESCOPE_EFFECTS',
		'Telescope Effects',
		SIMULATION,
		'rw',
		['PAE_AZ', 'PAE Azimuth (arcsec)', 0, -36000, 36000, 0.1, '%.3f'],
		['PAE_AL', 'PAE Altitude (arcsec)', 0, -36000, 36000, 0.1, '%.3f'],
		['PE_WE_PERIOD', 'PE W/E Period (s)', 0, 0, DAYSEC, 1, '%.0f'],
		['PE_WE_AMPLITUDE', 'PE W/E Amplitude (arcsec)', 0, 0, 3600, 0.1, '%.3f'],
		['PE_NS_PERIOD', 'PE N/S Period (s)', 0, 0, DAYSEC, 1, '%.0f'],
		['PE_NS_AMPLITUDE', 'PE N/S Amplitude (arcsec)', 0, 0, 3600, 0.1, '%.3f'],
	)

	protected readonly properties: readonly SimulatorProperty[] = [
		this.#info,
		this.#cooler,
		this.#frameType,
		this.#frameFormat,
		this.#transferFormat,
		this.#abort,
		this.#exposure,
		this.#coolerPower,
		this.#temperature,
		this.#frame,
		this.#bin,
		this.#gain,
		this.#offset,
		this.#cfa,
		this.#guideNS,
		this.#guideWE,
		this.#image,
		this.#scene,
		this.#catalogSource,
		this.#noiseQuality,
		this.#noiseFeatures,
		this.#noiseExposure,
		this.#noiseSky,
		this.#noiseMoon,
		this.#noiseLightPollution,
		this.#noiseAtmosphere,
		this.#noiseSensor,
		this.#noiseAmpGlow,
		this.#noiseAmpGlowPosition,
		this.#noiseArtifacts,
		this.#noiseOutput,
		this.#noiseClampMode,
		this.#plotOptions,
		this.#plotFlags,
		this.#plotPsfModel,
		this.#telescopeInfo,
		this.#telescopeEffects,
	]

	protected readonly propertiesToNotSave: readonly SimulatorProperty[] = [this.#info, this.#cooler, this.#abort, this.#exposure, this.#coolerPower, this.#temperature, this.#cfa, this.#guideNS, this.#guideWE, this.#image]

	#timer?: NodeJS.Timeout
	#exposureEndTime = 0
	#exposureDuration = 0
	#targetTemperature = CAMERA_DEFAULT_TARGET_TEMPERATURE
	#catalog?: readonly (AstronomicalImageStar | undefined)[]
	#catalogKey = ''
	#catalogDirty = true
	#pulseNorthSouthUntil = 0
	#pulseWestEastUntil = 0
	#mountPeriodicWestEastOffset = 0
	#mountPeriodicNorthSouthOffset = 0

	readonly #mountManager?: MountManager
	readonly #focuserManager?: FocuserManager
	readonly #rotatorManager?: RotatorManager
	readonly #guideOutputManager?: GuideOutputManager

	constructor(
		name: string,
		client: ClientSimulator,
		readonly options?: CameraSimulatorOptions,
		handler: IndiClientHandler = client.handler,
	) {
		super(name, client, handler, DeviceInterfaceType.CCD | DeviceInterfaceType.GUIDER)

		for (const property of this.properties) {
			property.device = name
		}

		if (options?.catalogSources) {
			for (const name of Object.keys(options.catalogSources)) {
				if (options.catalogSources[name]) {
					this.#catalogSource.elements[name] = { name, label: name, value: name === 'RANDOM' }
				}
			}
		}

		this.driverInfo.elements.DRIVER_EXEC.value = 'camera.simulator'

		this.#mountManager = options?.mountManager
		this.#focuserManager = options?.focuserManager
		this.#rotatorManager = options?.rotatorManager
		this.#guideOutputManager = options?.guideOutputManager
	}

	get activeMount() {
		const mount = this.#mountManager?.get(this.client, this.snoopDevices.elements.ACTIVE_TELESCOPE.value)
		return mount?.connected ? mount : undefined
	}

	get activeFocuser() {
		const focuser = this.#focuserManager?.get(this.client, this.snoopDevices.elements.ACTIVE_FOCUSER.value)
		return focuser?.connected ? focuser : undefined
	}

	get activeRotator() {
		const rotator = this.#rotatorManager?.get(this.client, this.snoopDevices.elements.ACTIVE_ROTATOR.value)
		return rotator?.connected ? rotator : undefined
	}

	// Returns the selected catalog backend for light-frame stars.
	get catalogSourceType(): CatalogSourceType {
		return findOnSwitch(this.#catalogSource)[0]
	}

	get frameType(): FrameType {
		return this.#frameType.elements.FRAME_DARK.value ? 'DARK' : this.#frameType.elements.FRAME_FLAT.value ? 'FLAT' : this.#frameType.elements.FRAME_BIAS.value ? 'BIAS' : 'LIGHT'
	}

	get isExposuring() {
		return this.#exposure.state === 'Busy'
	}

	get isPulsing() {
		return this.#guideNS.state === 'Busy'
	}

	get telescopeFocalLength() {
		return this.#telescopeInfo.elements.FOCAL_LENGTH.value
	}

	get telescopeAperture() {
		return this.#telescopeInfo.elements.APERTURE.value
	}

	sendText(vector: NewTextVector) {
		super.sendText(vector)

		if (vector.name === 'ACTIVE_DEVICES') {
			this.#catalogDirty = true
		}
	}

	sendNumber(vector: NewNumberVector) {
		switch (vector.name) {
			case 'CCD_EXPOSURE':
				if (vector.elements.CCD_EXPOSURE_VALUE !== undefined) this.startExposure(vector.elements.CCD_EXPOSURE_VALUE)
				return
			case 'CCD_TEMPERATURE':
				if (vector.elements.CCD_TEMPERATURE_VALUE !== undefined) this.setTargetTemperature(vector.elements.CCD_TEMPERATURE_VALUE)
				return
			case 'CCD_FRAME':
				this.setFrame(vector.elements.X, vector.elements.Y, vector.elements.WIDTH, vector.elements.HEIGHT)
				return
			case 'CCD_BINNING':
				this.setBin(vector.elements.HOR_BIN, vector.elements.VER_BIN)
				return
			case 'CCD_GAIN':
				if (applyNumberVectorValues(this.#gain, vector.elements)) this.notify(this.#gain)
				return
			case 'CCD_OFFSET':
				if (applyNumberVectorValues(this.#offset, vector.elements)) this.notify(this.#offset)
				return
			case 'TELESCOPE_TIMED_GUIDE_NS':
				if ((vector.elements.TIMED_GUIDE_N ?? 0) > 0) this.pulse('NORTH', vector.elements.TIMED_GUIDE_N)
				else if ((vector.elements.TIMED_GUIDE_S ?? 0) > 0) this.pulse('SOUTH', vector.elements.TIMED_GUIDE_S)
				return
			case 'TELESCOPE_TIMED_GUIDE_WE':
				if ((vector.elements.TIMED_GUIDE_W ?? 0) > 0) this.pulse('WEST', vector.elements.TIMED_GUIDE_W)
				else if ((vector.elements.TIMED_GUIDE_E ?? 0) > 0) this.pulse('EAST', vector.elements.TIMED_GUIDE_E)
				return
			case 'SIMULATOR_SCENE':
				if (applyNumberVectorValues(this.#scene, vector.elements)) {
					if (this.catalogSourceType === 'RANDOM') this.#catalogDirty = true
					this.notify(this.#scene)
				}
				return
			case 'SIMULATOR_NOISE_EXPOSURE':
				if (applyNumberVectorValues(this.#noiseExposure, vector.elements)) this.notify(this.#noiseExposure)
				return
			case 'SIMULATOR_NOISE_SKY':
				if (applyNumberVectorValues(this.#noiseSky, vector.elements)) this.notify(this.#noiseSky)
				return
			case 'SIMULATOR_NOISE_MOON':
				if (applyNumberVectorValues(this.#noiseMoon, vector.elements)) this.notify(this.#noiseMoon)
				return
			case 'SIMULATOR_NOISE_LIGHT_POLLUTION':
				if (applyNumberVectorValues(this.#noiseLightPollution, vector.elements)) this.notify(this.#noiseLightPollution)
				return
			case 'SIMULATOR_NOISE_ATMOSPHERE':
				if (applyNumberVectorValues(this.#noiseAtmosphere, vector.elements)) this.notify(this.#noiseAtmosphere)
				return
			case 'SIMULATOR_NOISE_SENSOR':
				if (applyNumberVectorValues(this.#noiseSensor, vector.elements)) this.notify(this.#noiseSensor)
				return
			case 'SIMULATOR_NOISE_AMP_GLOW':
				if (applyNumberVectorValues(this.#noiseAmpGlow, vector.elements)) this.notify(this.#noiseAmpGlow)
				return
			case 'SIMULATOR_NOISE_ARTIFACTS':
				if (applyNumberVectorValues(this.#noiseArtifacts, vector.elements)) this.notify(this.#noiseArtifacts)
				return
			case 'SIMULATOR_NOISE_OUTPUT':
				if (applyNumberVectorValues(this.#noiseOutput, vector.elements)) this.notify(this.#noiseOutput)
				return
			case 'SIMULATOR_STAR_PLOT_OPTIONS':
				if (applyNumberVectorValues(this.#plotOptions, vector.elements)) this.notify(this.#plotOptions)
				return
			case 'TELESCOPE_INFO':
				if (applyNumberVectorValues(this.#telescopeInfo, vector.elements)) this.notify(this.#telescopeInfo)
				return
			case 'TELESCOPE_EFFECTS':
				if (applyNumberVectorValues(this.#telescopeEffects, vector.elements)) this.notify(this.#telescopeEffects)
		}
	}

	sendSwitch(vector: NewSwitchVector) {
		super.sendSwitch(vector)

		switch (vector.name) {
			case 'CONNECTION':
				if (vector.elements.CONNECT === true) this.connect()
				else if (vector.elements.DISCONNECT === true) this.disconnect()
				return
			case 'CCD_COOLER':
				if (applyExclusiveSwitchValues(this.#cooler, vector.elements)) this.notify(this.#cooler)
				return
			case 'CCD_CAPTURE_FORMAT':
				if (applyExclusiveSwitchValues(this.#frameFormat, vector.elements)) this.notify(this.#frameFormat)
				return
			case 'CCD_TRANSFER_FORMAT':
				if (applyExclusiveSwitchValues(this.#transferFormat, vector.elements)) this.notify(this.#transferFormat)
				return
			case 'CCD_ABORT_EXPOSURE':
				if (vector.elements.ABORT === true) this.abortExposure()
				return
			case 'CCD_FRAME_TYPE':
				if (applyExclusiveSwitchValues(this.#frameType, vector.elements)) this.notify(this.#frameType)
				return
			case 'SIMULATOR_CATALOG_SOURCE':
				if (applyExclusiveSwitchValues(this.#catalogSource, vector.elements)) {
					this.#catalogDirty = true
					this.notify(this.#catalogSource)
				}
				return
			case 'SIMULATOR_NOISE_QUALITY':
				if (applyExclusiveSwitchValues(this.#noiseQuality, vector.elements)) this.notify(this.#noiseQuality)
				return
			case 'SIMULATOR_NOISE_FEATURES':
				if (applyMultiSwitchValues(this.#noiseFeatures, vector.elements)) this.notify(this.#noiseFeatures)
				return
			case 'SIMULATOR_NOISE_AMP_GLOW_POSITION':
				if (applyExclusiveSwitchValues(this.#noiseAmpGlowPosition, vector.elements)) this.notify(this.#noiseAmpGlowPosition)
				return
			case 'SIMULATOR_NOISE_CLAMP_MODE':
				if (applyExclusiveSwitchValues(this.#noiseClampMode, vector.elements)) this.notify(this.#noiseClampMode)
				return
			case 'SIMULATOR_STAR_PLOT_FLAGS':
				if (applyMultiSwitchValues(this.#plotFlags, vector.elements)) this.notify(this.#plotFlags)
				return
			case 'SIMULATOR_STAR_PLOT_PSF_MODEL':
				if (applyExclusiveSwitchValues(this.#plotPsfModel, vector.elements)) this.notify(this.#plotPsfModel)
		}
	}

	// Connects the simulated camera and publishes its supported properties.
	connect() {
		if (this.#timer) return

		super.connect()

		if (!this.isConnected) return

		this.#timer = setInterval(this.#tick.bind(this), TICK_INTERVAL_MS)
	}

	// Disconnects the simulated camera and removes its dynamic properties.
	disconnect() {
		if (!this.#timer) return

		clearInterval(this.#timer)
		this.#timer = undefined
		this.abortExposure(false)
		this.#clearPulseGuide()
		super.disconnect()
	}

	// Disposes the camera simulator and removes it from the manager view.
	dispose() {
		this.disconnect()
		super.dispose()
	}

	// Starts an exposure countdown and schedules image synthesis at completion.
	startExposure(duration: number) {
		if (!this.isConnected || this.isExposuring) return

		duration = clamp(duration, this.#exposure.elements.CCD_EXPOSURE_VALUE.min, this.#exposure.elements.CCD_EXPOSURE_VALUE.max)
		this.#exposureDuration = duration
		this.#exposureEndTime = Date.now() + Math.trunc(duration * 1000)
		this.#exposure.state = 'Busy'
		this.#exposure.elements.CCD_EXPOSURE_VALUE.value = duration
		this.#image.state = 'Busy'
		this.#image.elements.CCD1.value = ''
		this.#image.elements.CCD1.size = '0'
		this.#abort.elements.ABORT.value = false
		this.notify(this.#exposure)
	}

	// Aborts the current exposure without producing a frame.
	abortExposure(alert: boolean = false) {
		if (!this.isExposuring && !this.#exposureEndTime) return
		this.#exposureEndTime = 0
		this.#exposureDuration = 0
		this.#image.state = alert ? 'Alert' : 'Idle'
		this.#exposure.state = alert ? 'Alert' : 'Idle'
		this.#exposure.elements.CCD_EXPOSURE_VALUE.value = 0
		this.notify(this.#exposure)
	}

	// Updates the simulated target temperature.
	setTargetTemperature(value: number) {
		value = clamp(value, this.#temperature.elements.CCD_TEMPERATURE_VALUE.min, this.#temperature.elements.CCD_TEMPERATURE_VALUE.max)
		if (this.#targetTemperature === value) return
		this.#targetTemperature = value
		this.#noiseSensor.elements.TEMPERATURE.value = value
		this.notify(this.#noiseSensor)
	}

	// Updates the active subframe within sensor bounds.
	setFrame(x?: number, y?: number, width?: number, height?: number) {
		const maxWidth = this.sensorWidth
		const maxHeight = this.sensorHeight
		const nextX = clamp(Math.trunc(x ?? this.#frame.elements.X.value), 0, maxWidth - 1)
		const nextY = clamp(Math.trunc(y ?? this.#frame.elements.Y.value), 0, maxHeight - 1)
		const nextWidth = clamp(Math.trunc(width ?? this.#frame.elements.WIDTH.value), 1, maxWidth - nextX)
		const nextHeight = clamp(Math.trunc(height ?? this.#frame.elements.HEIGHT.value), 1, maxHeight - nextY)
		let updated = false

		if (this.#frame.elements.X.value !== nextX) {
			this.#frame.elements.X.value = nextX
			updated = true
		}

		if (this.#frame.elements.Y.value !== nextY) {
			this.#frame.elements.Y.value = nextY
			updated = true
		}

		if (this.#frame.elements.WIDTH.value !== nextWidth) {
			this.#frame.elements.WIDTH.value = nextWidth
			updated = true
		}

		if (this.#frame.elements.HEIGHT.value !== nextHeight) {
			this.#frame.elements.HEIGHT.value = nextHeight
			updated = true
		}

		if (updated) {
			this.notify(this.#frame)
		}
	}

	// Updates hardware binning within the simulated camera limits.
	setBin(horizontal?: number, vertical?: number) {
		const nextHorizontal = clamp(Math.trunc(horizontal ?? this.#bin.elements.HOR_BIN.value), 1, this.#bin.elements.HOR_BIN.max)
		const nextVertical = clamp(Math.trunc(vertical ?? this.#bin.elements.VER_BIN.value), 1, this.#bin.elements.VER_BIN.max)
		let updated = false

		if (this.#bin.elements.HOR_BIN.value !== nextHorizontal) {
			this.#bin.elements.HOR_BIN.value = nextHorizontal
			updated = true
		}

		if (this.#bin.elements.VER_BIN.value !== nextVertical) {
			this.#bin.elements.VER_BIN.value = nextVertical
			updated = true
		}

		if (updated) {
			this.notify(this.#bin)
		}
	}

	// Starts a pulse-guiding interval on the requested axis.
	pulse(direction: GuideDirection, duration: number) {
		if (!this.isConnected || duration <= 0) return

		const mount = this.activeMount

		if (mount !== undefined) {
			this.#guideOutputManager?.pulse(mount, direction, duration)
		}

		const until = Date.now() + Math.trunc(duration)

		if (direction === 'NORTH' || direction === 'SOUTH') this.#pulseNorthSouthUntil = until
		else this.#pulseWestEastUntil = until

		this.#setPulsing(true)
	}

	// Advances temperature regulation, exposure progress, and guide-pulse state.
	#tick() {
		const now = Date.now()
		this.#advanceTemperature()
		this.#expirePulseGuide(now)

		if (!this.isExposuring) return

		const remaining = Math.max(0, (this.#exposureEndTime - now) / 1000)
		if (Math.abs(this.#exposure.elements.CCD_EXPOSURE_VALUE.value - remaining) >= 1e-3) {
			this.#exposure.elements.CCD_EXPOSURE_VALUE.value = remaining
			this.notify(this.#exposure)
		}

		if (remaining <= 0) {
			this.#exposureEndTime = 0
			void this.#finishExposure()
		}
	}

	// Applies a simple thermal model based on ambient temperature and cooler power.
	#advanceTemperature() {
		const current = this.#temperature.elements.CCD_TEMPERATURE_VALUE.value
		const coolerEnabled = this.#cooler.elements.COOLER_ON.value
		const target = coolerEnabled ? this.#targetTemperature : CAMERA_AMBIENT_TEMPERATURE
		const delta = target - current
		const step = delta * (coolerEnabled ? 0.12 : 0.04)
		const nextTemperature = Math.abs(delta) < 0.02 ? target : current + step
		const deltaFromAmbient = Math.max(0, CAMERA_AMBIENT_TEMPERATURE - nextTemperature)
		const nextCoolerPower = coolerEnabled ? clamp(deltaFromAmbient * 6.5, 0, 100) : 0
		let updated = false

		if (Math.abs(nextTemperature - current) >= 0.1) {
			this.#temperature.elements.CCD_TEMPERATURE_VALUE.value = nextTemperature
			updated = true
		}

		if (Math.abs(this.#coolerPower.elements.CCD_COOLER_POWER.value - nextCoolerPower) >= 0.5) {
			this.#coolerPower.elements.CCD_COOLER_POWER.value = nextCoolerPower
			this.notify(this.#coolerPower)
		}

		if (updated) {
			this.notify(this.#temperature)
		}
	}

	// Completes the exposure and publishes the encoded synthetic image BLOB.
	async #finishExposure() {
		const exposureTime = this.#exposureDuration || this.#noiseExposure.elements.EXPOSURE_TIME.value
		this.#exposureDuration = 0
		this.#exposure.elements.CCD_EXPOSURE_VALUE.value = 0
		this.notify(this.#exposure)

		try {
			this.#image.state = 'Ok'
			this.#exposure.state = 'Ok'
			const blob = await this.#renderImage(exposureTime)
			this.#image.elements.CCD1.size = blob.byteLength.toFixed(0)
			this.#image.elements.CCD1.format = this.transferFormat === 'XISF' ? '.xisf' : '.fits'
			this.#image.elements.CCD1.value = blob
			handleSetBlobVector(this.client, this.handler, this.#image)
		} catch {
			this.#image.state = 'Alert'
			this.#image.elements.CCD1.size = '0'
			this.#image.elements.CCD1.value = ''
			this.#exposure.state = 'Alert'
		}

		this.notify(this.#exposure)
	}

	// Renders the configured frame and encodes it as FITS or XISF.
	async #renderImage(exposureTime: number) {
		const channels = this.channels
		const width = this.imageWidth
		const height = this.imageHeight
		const raw = new Float32Array(width * height * channels)
		const frameType = this.frameType
		const noiseConfig = this.#noiseConfig(frameType, exposureTime)
		const rotatorAngle = (this.activeRotator?.angle.value ?? 0) * DEG2RAD

		if (frameType === 'LIGHT') {
			const stars = await this.#collectFrameStars(exposureTime, width, height, rotatorAngle)
			generateStarImage(raw, width, height, channels, stars, this.seeing, noiseConfig, this.#makePlotOptions())
		} else {
			if (frameType === 'FLAT') fillFlatField(raw, width, height, channels, exposureTime, this.#noiseExposure.elements.EXPOSURE_TIME.value)
			generateNoiseImage(raw, width, height, channels, noiseConfig)
		}

		const image = this.#imageModel(raw, width, height, channels, exposureTime)
		const output = Buffer.allocUnsafe(raw.length * 2 + CAMERA_BLOB_PADDING)
		const sink = bufferSink(output)

		if (this.transferFormat === 'XISF') await writeImageToXisf(image, sink)
		else await writeImageToFits(image, sink)

		return output.subarray(0, sink.position)
	}

	// Builds an image model suitable for the FITS/XISF writers.
	#imageModel(raw: ImageRawType, width: number, height: number, channels: 1 | 3, exposureTime: number): Image {
		const pixelSizeInBytes = 2

		return {
			raw,
			header: this.#imageHeader(width, height, channels, exposureTime),
			metadata: {
				width,
				height,
				channels,
				stride: width * channels,
				pixelCount: width * height,
				strideInBytes: width * pixelSizeInBytes,
				pixelSizeInBytes,
				bitpix: 16,
				bayer: channels === 1 ? this.cfaPattern : undefined,
			},
		}
	}

	// Builds a compact astronomical image header for synthetic output.
	#imageHeader(width: number, height: number, channels: 1 | 3, exposureTime: number): FitsHeader {
		const now = Date.now()
		const mount = this.activeMount
		const focuser = this.activeFocuser
		const rotator = this.activeRotator
		const start = now - Math.trunc(exposureTime * 1000)
		let rightAscension: Angle | undefined
		let declination: Angle | undefined

		if (mount) {
			;[rightAscension, declination] = equatorialToJ2000(mount.equatorialCoordinate.rightAscension, mount.equatorialCoordinate.declination)
		}

		return {
			SIMPLE: true,
			BITPIX: 16,
			NAXIS: channels === 1 ? 2 : 3,
			NAXIS1: width,
			NAXIS2: height,
			NAXIS3: channels === 3 ? 3 : undefined,
			INSTRUME: this.name,
			TELESCOP: mount?.name,
			EXPTIME: exposureTime,
			BZERO: 32768,
			BSCALE: 1,
			XBINNING: this.#bin.elements.HOR_BIN.value,
			YBINNING: this.#bin.elements.VER_BIN.value,
			XPIXSZ: this.#info.elements.CCD_PIXEL_SIZE_X.value * this.#bin.elements.HOR_BIN.value,
			YPIXSZ: this.#info.elements.CCD_PIXEL_SIZE_Y.value * this.#bin.elements.VER_BIN.value,
			GAIN: this.#gain.elements.GAIN.value,
			OFFSET: this.#offset.elements.OFFSET.value,
			FRAME: this.frameType,
			IMAGETYP: `${this.frameType} Frame`,
			'CCD-TEMP': this.#temperature.elements.CCD_TEMPERATURE_VALUE.value,
			SITELAT: mount ? toDeg(mount.geographicCoordinate.latitude) : undefined,
			SITELONG: mount ? toDeg(mount.geographicCoordinate.longitude) : undefined,
			OBJCTRA: rightAscension !== undefined ? formatRA(rightAscension) : undefined,
			OBJCTDEC: declination !== undefined ? formatDEC(declination) : undefined,
			RA: rightAscension !== undefined ? toDeg(normalizeAngle(rightAscension)) : undefined,
			DEC: declination !== undefined ? toDeg(declination) : undefined,
			EQUINOX: mount ? 2000 : undefined,
			PIERSIDE: mount && mount.pierSide !== 'NEITHER' ? mount.pierSide : undefined,
			DATEOBS: formatTemporal(start, 'YYYY-MM-DDTHH:mm:ss.SSS'),
			DATEEND: formatTemporal(now, 'YYYY-MM-DDTHH:mm:ss.SSS'),
			XORGSUBF: this.#frame.elements.X.value,
			YORGSUBF: this.#frame.elements.Y.value,
			FOCUSPOS: focuser?.position.value,
			FOCUSTEM: focuser?.hasThermometer ? focuser.temperature : undefined,
			ROTATANG: rotator ? rotator.angle.value : undefined,
			// BAYERPAT: channels === 1 ? this.#cfa.elements.CFA_TYPE.value : undefined,
		}
	}

	// Builds the active scalar noise configuration from simulator property vectors.
	#noiseConfig(frameType: FrameType, exposureTime: number): AstronomicalImageNoiseConfig {
		const gainFactor = 1 + this.#gain.elements.GAIN.value / 100
		const offsetBias = this.#offset.elements.OFFSET.value * 2
		const lightFrame = frameType === 'LIGHT'
		const flatFrame = frameType === 'FLAT'
		const biasFrame = frameType === 'BIAS'

		return {
			seed: this.#scene.elements.SCENE_SEED.value >>> 0,
			quality: this.noiseQuality,
			exposure: {
				exposureTime: biasFrame ? CAMERA_MIN_EXPOSURE : exposureTime,
				analogGain: this.#noiseExposure.elements.ANALOG_GAIN.value * gainFactor,
				digitalGain: this.#noiseExposure.elements.DIGITAL_GAIN.value,
				electronsPerAdu: this.#noiseExposure.elements.ELECTRONS_PER_ADU.value,
			},
			sky: {
				enabled: lightFrame && this.#noiseFeatures.elements.SKY_ENABLED.value,
				baseRate: this.#noiseSky.elements.BASE_RATE.value,
				globalOffset: flatFrame ? this.#noiseSky.elements.GLOBAL_OFFSET.value + 0.2 : this.#noiseSky.elements.GLOBAL_OFFSET.value,
				gradientStrength: this.#noiseSky.elements.GRADIENT_STRENGTH.value,
				gradientDirection: this.#noiseSky.elements.GRADIENT_DIRECTION.value,
				radialGradientStrength: this.#noiseSky.elements.RADIAL_GRADIENT_STRENGTH.value,
				lowFrequencyVariationStrength: this.#noiseSky.elements.LOW_FREQUENCY_VARIATION_STRENGTH.value,
			},
			moon: {
				enabled: lightFrame && this.#noiseFeatures.elements.MOON_ENABLED.value,
				illuminationFraction: this.#noiseMoon.elements.ILLUMINATION_FRACTION.value,
				altitude: this.#noiseMoon.elements.ALTITUDE.value,
				angularDistance: this.#noiseMoon.elements.ANGULAR_DISTANCE.value,
				positionAngle: this.#noiseMoon.elements.POSITION_ANGLE.value,
				strength: this.#noiseMoon.elements.STRENGTH.value,
			},
			lightPollution: {
				enabled: lightFrame && this.#noiseFeatures.elements.LIGHT_POLLUTION_ENABLED.value,
				strength: this.#noiseLightPollution.elements.STRENGTH.value,
				direction: this.#noiseLightPollution.elements.DIRECTION.value,
				gradientStrength: this.#noiseLightPollution.elements.GRADIENT_STRENGTH.value,
				domeSharpness: this.#noiseLightPollution.elements.DOME_SHARPNESS.value,
			},
			atmosphere: {
				airglowStrength: this.#noiseAtmosphere.elements.AIRGLOW_STRENGTH.value,
				transparency: this.#noiseAtmosphere.elements.TRANSPARENCY.value,
				airmass: this.#noiseAtmosphere.elements.AIRMASS.value,
				haze: this.#noiseAtmosphere.elements.HAZE.value,
				humidity: this.#noiseAtmosphere.elements.HUMIDITY.value,
				thinCloudVeil: this.#noiseAtmosphere.elements.THIN_CLOUD_VEIL.value,
				twilightContribution: flatFrame ? Math.max(this.#noiseAtmosphere.elements.TWILIGHT_CONTRIBUTION.value, 0.3) : this.#noiseAtmosphere.elements.TWILIGHT_CONTRIBUTION.value,
				horizonGlow: this.#noiseAtmosphere.elements.HORIZON_GLOW.value,
				zodiacalLightFactor: this.#noiseAtmosphere.elements.ZODIACAL_LIGHT_FACTOR.value,
				milkyWayBackgroundFactor: this.#noiseAtmosphere.elements.MILKY_WAY_BACKGROUND_FACTOR.value,
			},
			sensor: {
				readNoise: this.#noiseSensor.elements.READ_NOISE.value,
				biasElectrons: this.#noiseSensor.elements.BIAS_ELECTRONS.value + offsetBias,
				blackLevelElectrons: this.#noiseSensor.elements.BLACK_LEVEL_ELECTRONS.value,
				darkCurrentAtReferenceTemp: this.#noiseSensor.elements.DARK_CURRENT_AT_REFERENCE_TEMP.value,
				referenceTemperature: this.#noiseSensor.elements.REFERENCE_TEMPERATURE.value,
				temperature: this.#temperature.elements.CCD_TEMPERATURE_VALUE.value,
				temperatureDoublingInterval: this.#noiseSensor.elements.TEMPERATURE_DOUBLING_INTERVAL.value,
				darkSignalNonUniformity: this.#noiseSensor.elements.DARK_SIGNAL_NON_UNIFORMITY.value,
				fullWellCapacity: this.#noiseSensor.elements.FULL_WELL_CAPACITY.value,
				channelCorrelation: this.#noiseSensor.elements.CHANNEL_CORRELATION.value,
				ampGlow: {
					enabled: frameType !== 'BIAS' && this.#noiseFeatures.elements.AMP_GLOW_ENABLED.value,
					strength: this.#noiseAmpGlow.elements.STRENGTH.value,
					position: this.ampGlowPosition,
					radiusX: this.#noiseAmpGlow.elements.RADIUS_X.value,
					radiusY: this.#noiseAmpGlow.elements.RADIUS_Y.value,
					falloff: this.#noiseAmpGlow.elements.FALLOFF.value,
				},
			},
			artifacts: {
				fixedPatternNoiseStrength: this.#noiseArtifacts.elements.FIXED_PATTERN_NOISE_STRENGTH.value,
				rowNoiseStrength: this.#noiseArtifacts.elements.ROW_NOISE_STRENGTH.value,
				columnNoiseStrength: this.#noiseArtifacts.elements.COLUMN_NOISE_STRENGTH.value,
				bandingStrength: this.#noiseArtifacts.elements.BANDING_STRENGTH.value,
				bandingFrequency: this.#noiseArtifacts.elements.BANDING_FREQUENCY.value,
				hotPixelRate: this.#noiseArtifacts.elements.HOT_PIXEL_RATE.value,
				warmPixelRate: this.#noiseArtifacts.elements.WARM_PIXEL_RATE.value,
				deadPixelRate: this.#noiseArtifacts.elements.DEAD_PIXEL_RATE.value,
				hotPixelStrength: this.#noiseArtifacts.elements.HOT_PIXEL_STRENGTH.value,
				warmPixelStrength: this.#noiseArtifacts.elements.WARM_PIXEL_STRENGTH.value,
				deadPixelResidual: this.#noiseArtifacts.elements.DEAD_PIXEL_RESIDUAL.value,
			},
			output: {
				maxValue: this.#noiseOutput.elements.MAX_VALUE.value,
				clampMode: this.clampMode,
				quantize: this.#noiseFeatures.elements.OUTPUT_QUANTIZE.value,
			},
		}
	}

	// Builds the active plot-star configuration from simulator property vectors.
	#makePlotOptions(): PlotStarOptions {
		return {
			background: this.#plotOptions.elements.BACKGROUND.value,
			saturationLevel: this.#plotFlags.elements.SATURATION_ENABLED.value ? this.#plotOptions.elements.SATURATION_LEVEL.value : undefined,
			focusStep: this.activeFocuser?.position.value ?? this.#plotOptions.elements.FOCUS_STEP.value,
			bestFocus: this.#plotOptions.elements.BEST_FOCUS.value,
			maxFocusStep: this.activeFocuser?.position.max || undefined,
			peakScale: this.#plotOptions.elements.PEAK_SCALE.value,
			ellipticity: this.#plotOptions.elements.ELLIPTICITY.value,
			theta: this.#plotOptions.elements.THETA.value,
			softCore: this.#plotOptions.elements.SOFT_CORE.value,
			psfModel: this.#plotPsfModel.elements.MOFFAT.value ? 'moffat' : 'gaussian',
			beta: this.#plotOptions.elements.BETA.value,
			haloStrength: this.#plotOptions.elements.HALO_STRENGTH.value,
			haloScale: this.#plotOptions.elements.HALO_SCALE.value,
			jitterX: this.#plotOptions.elements.JITTER_X.value,
			jitterY: this.#plotOptions.elements.JITTER_Y.value,
			gain: this.#plotOptions.elements.GAIN.value * (1 + this.#gain.elements.GAIN.value / 100),
			gammaCompensation: this.#plotFlags.elements.GAMMA_ENABLED.value ? this.#plotOptions.elements.GAMMA_COMPENSATION.value : false,
			additiveNoiseHint: this.#plotOptions.elements.ADDITIVE_NOISE_HINT.value,
			minPlotRadius: this.#plotOptions.elements.MIN_PLOT_RADIUS.value,
			maxPlotRadius: this.#plotOptions.elements.MAX_PLOT_RADIUS.value,
			cutoffSigma: this.#plotOptions.elements.CUTOFF_SIGMA.value,
		}
	}

	// Projects the master catalog into the current subframe and binning.
	async #collectFrameStars(exposureTime: number, imageWidth: number, imageHeight: number, rotatorAngle: number) {
		const stars = await this.#ensureCatalog()
		const frameX = this.#frame.elements.X.value
		const frameY = this.#frame.elements.Y.value
		const frameWidth = this.#frame.elements.WIDTH.value
		const frameHeight = this.#frame.elements.HEIGHT.value
		const binX = this.#bin.elements.HOR_BIN.value
		const binY = this.#bin.elements.VER_BIN.value
		const hfdScale = (binX + binY) * 0.5
		const gainFactor = 1 + this.#gain.elements.GAIN.value / 100
		const exposureScale = exposureTime / this.#noiseExposure.elements.EXPOSURE_TIME.value
		const projected: AstronomicalImageStar[] = []
		const centerX = (imageWidth - 1) * 0.5
		const centerY = (imageHeight - 1) * 0.5
		const rotate = Math.abs(rotatorAngle) >= 1e-12
		const sinAngle = rotate ? Math.sin(rotatorAngle) : 0
		const cosAngle = rotate ? Math.cos(rotatorAngle) : 1

		for (let i = 0; i < stars.length; i++) {
			const star = stars[i]

			if (star === undefined) continue

			if (star.x < frameX || star.x >= frameX + frameWidth || star.y < frameY || star.y >= frameY + frameHeight) continue

			const projectedStar = {
				x: (star.x - frameX) / binX,
				y: (star.y - frameY) / binY,
				flux: star.flux * gainFactor * exposureScale,
				hfd: Math.max(0.35, star.hfd / hfdScale),
				snr: star.snr * Math.sqrt(Math.max(exposureScale, 0.01)),
				colorIndex: star.colorIndex,
			}

			if (rotate) {
				rotateImageCoordinate(projectedStar, centerX, centerY, sinAngle, cosAngle)
			}

			projected.push(projectedStar)
		}

		return projected
	}

	// Computes the current local sidereal time from the simulated clock.
	#siderealTime(utcTime: number, longitude: Angle) {
		return localSiderealTime(timeUnix(utcTime / 1000, undefined, true), longitude)
	}

	// Rebuilds the deterministic catalog only when scene parameters change.
	async #ensureCatalog() {
		const { elements } = this.#telescopeEffects
		const mount = this.activeMount
		let centerRightAscension = mount?.equatorialCoordinate.rightAscension
		let centerDeclination = mount?.equatorialCoordinate.declination

		if (mount !== undefined) {
			const now = Date.now()
			const latitude = mount.geographicCoordinate.latitude
			const longitude = mount.geographicCoordinate.longitude

			if (elements.PAE_AZ.value > 0 || elements.PAE_AL.value > 0) {
				;[centerRightAscension, centerDeclination] = polarAlignmentError(centerRightAscension!, centerDeclination!, latitude, this.#siderealTime(now, longitude), elements.PAE_AZ.value * ASEC2RAD, elements.PAE_AL.value * ASEC2RAD)
			}

			;[centerRightAscension, centerDeclination] = this.#applyTelescopePeriodicError(centerRightAscension!, centerDeclination!, now)
			;[centerRightAscension, centerDeclination] = equatorialToJ2000(centerRightAscension, centerDeclination)
		}

		const pixelScale = arcsec(angularSizeOfPixel(this.telescopeFocalLength, CAMERA_PIXEL_SIZE))
		const radius = Math.hypot(this.sensorWidth, this.sensorHeight) * pixelScale * 0.5
		const key = this.#makeCatalogKey(centerRightAscension, centerDeclination, radius)
		if (this.#catalog && !this.#catalogDirty && this.#catalogKey === key) return this.#catalog

		const type = this.catalogSourceType
		const catalogSource = this.options?.catalogSources?.[type]
		const stars =
			catalogSource !== undefined && catalogSource !== null && centerRightAscension !== undefined && centerDeclination !== undefined && radius > 0
				? this.#mapCatalogCatalogStarsToAstronomicalImageStars(await catalogSource(centerRightAscension, centerDeclination, radius), centerRightAscension, centerDeclination, pixelScale)
				: this.#randomSource()
		this.#catalog = stars
		this.#catalogKey = key
		this.#catalogDirty = false
		return stars
	}

	#mapCatalogCatalogStarsToAstronomicalImageStars(stars: readonly CatalogSourceStar[], centerRightAscension: Angle, centerDeclination: Angle, pixelScale: Angle): readonly (AstronomicalImageStar | undefined)[] {
		const sensorWidth = this.sensorWidth
		const sensorHeight = this.sensorHeight
		const halfWidth = sensorWidth * 0.5
		const halfHeight = sensorHeight * 0.5
		const point: Point = { x: 0, y: 0 }

		return stars.map((s) => {
			if (gnomonicProject(s.rightAscension, s.declination, centerRightAscension, centerDeclination, point) === false) {
				return undefined
			}

			const x = halfWidth - point.x / pixelScale
			const y = halfHeight - point.y / pixelScale
			if (x < 0 || x >= sensorWidth || y < 0 || y >= sensorHeight) return undefined
			point.x = x
			point.y = y
			Object.assign(s, point)
			return s as never
		})
	}

	// Builds a cache key for the currently selected catalog source.
	#makeCatalogKey(centerRightAscension?: Angle, centerDeclination?: Angle, radius?: Angle) {
		const catalogSource = this.catalogSourceType
		if (catalogSource === 'RANDOM' || centerRightAscension === undefined || centerDeclination === undefined || radius === undefined || radius === 0) return `RANDOM:${this.#scene.elements.SCENE_SEED.value}`
		else return `${catalogSource}:${toHour(normalizeAngle(centerRightAscension)).toFixed(6)}:${toDeg(centerDeclination).toFixed(6)}:${toDeg(radius).toFixed(6)}`
	}

	// Generates a deterministic in-memory star field.
	#randomSource() {
		const random = mulberry32(this.#scene.elements.SCENE_SEED.value >>> 0)
		const width = this.sensorWidth
		const height = this.sensorHeight
		const density = this.#scene.elements.STAR_DENSITY.value
		const count = Math.max(1, Math.trunc(width * height * density))
		const minHfd = this.#scene.elements.HFD_MIN.value
		const maxHfd = Math.max(minHfd, this.#scene.elements.HFD_MAX.value)
		const minFlux = this.#scene.elements.FLUX_MIN.value
		const maxFlux = Math.max(minFlux, this.#scene.elements.FLUX_MAX.value)
		const stars = new Array<AstronomicalImageStar>(count)

		for (let i = 0; i < count; i++) {
			const brightness = 1 - random()

			stars[i] = {
				x: random() * width,
				y: random() * height,
				flux: minFlux + (maxFlux - minFlux) * brightness ** 6,
				hfd: minHfd + (maxHfd - minHfd) * random(),
				snr: 12 + brightness * 180,
				colorIndex: -0.25 + random() * 1.9,
			}
		}

		return stars
	}

	// Clears pulse-guiding state once all timed pulses have expired.
	#expirePulseGuide(now: number) {
		let pulsing = false
		if (this.#pulseNorthSouthUntil > now) pulsing = true
		else this.#pulseNorthSouthUntil = 0
		if (this.#pulseWestEastUntil > now) pulsing = true
		else this.#pulseWestEastUntil = 0
		this.#setPulsing(pulsing)
	}

	// Updates the guide-pulse busy state.
	#setPulsing(pulsing: boolean) {
		if (this.isPulsing === pulsing) return
		this.#guideNS.state = pulsing ? 'Busy' : 'Idle'
		this.#guideWE.state = this.#guideNS.state
		this.notify(this.#guideNS)
		this.notify(this.#guideWE)
	}

	// Clears all outstanding pulse-guide intervals.
	#clearPulseGuide() {
		this.#pulseNorthSouthUntil = 0
		this.#pulseWestEastUntil = 0
		this.#setPulsing(false)
	}

	// Applies the configurable mount periodic error model.
	#applyTelescopePeriodicError(rightAscension: Angle, declination: Angle, utcTime: number) {
		const { elements } = this.#telescopeEffects

		const westEastPeriodicOffset = this.#periodicErrorOffset(elements.PE_WE_PERIOD.value, elements.PE_WE_AMPLITUDE.value, utcTime)
		const northSouthPeriodicOffset = this.#periodicErrorOffset(elements.PE_NS_PERIOD.value, elements.PE_NS_AMPLITUDE.value, utcTime)

		if (westEastPeriodicOffset !== this.#mountPeriodicWestEastOffset) {
			rightAscension += westEastPeriodicOffset - this.#mountPeriodicWestEastOffset
			this.#mountPeriodicWestEastOffset = westEastPeriodicOffset
		}

		if (northSouthPeriodicOffset !== this.#mountPeriodicNorthSouthOffset) {
			declination += northSouthPeriodicOffset - this.#mountPeriodicNorthSouthOffset
			this.#mountPeriodicNorthSouthOffset = northSouthPeriodicOffset
		}

		return [rightAscension, declination] as const
	}

	// Computes the current periodic offset for one axis in radians.
	#periodicErrorOffset(periodSeconds: number, amplitudeArcsec: number, utcTime: number) {
		if (periodSeconds <= 0 || amplitudeArcsec === 0) return 0
		const periodMilliseconds = periodSeconds * 1000
		const phase = ((utcTime % periodMilliseconds) * TAU) / periodMilliseconds
		return Math.sin(phase) * amplitudeArcsec * ASEC2RAD
	}

	get cfaPattern() {
		return this.#cfa.elements.CFA_TYPE.value as CfaPattern
	}

	// Returns the active sensor width in unbinned pixels.
	get sensorWidth() {
		return this.#info.elements.CCD_MAX_X.value
	}

	// Returns the active sensor height in unbinned pixels.
	get sensorHeight() {
		return this.#info.elements.CCD_MAX_Y.value
	}

	// Returns the transfer format selected by the capture-format vector.
	get transferFormat(): TransferFormat {
		return this.#transferFormat.elements.FORMAT_FITS.value ? 'FITS' : 'XISF'
	}

	// Returns the channel count implied by the current capture format.
	get channels() {
		return this.frameFormat === 'MONO' ? 1 : 3
	}

	// Returns the binned output width for the current frame selection.
	get imageWidth() {
		return Math.max(1, Math.ceil(this.#frame.elements.WIDTH.value / this.#bin.elements.HOR_BIN.value))
	}

	// Returns the binned output height for the current frame selection.
	get imageHeight() {
		return Math.max(1, Math.ceil(this.#frame.elements.HEIGHT.value / this.#bin.elements.VER_BIN.value))
	}

	// Returns the scene seeing term used by generateStarImage.
	get seeing() {
		return this.#scene.elements.SEEING.value / ((this.#bin.elements.HOR_BIN.value + this.#bin.elements.VER_BIN.value) * 0.5)
	}

	// Returns the selected readout-mode descriptor.
	get frameFormat() {
		return findOnSwitch(this.#frameFormat)[0] as ReadoutMode
	}

	// Returns the selected noise quality enum.
	get noiseQuality() {
		return this.#noiseQuality.elements.FAST.value ? 'fast' : this.#noiseQuality.elements.HIGH_REALISM.value ? 'high-realism' : 'balanced'
	}

	// Returns the selected output clamp mode enum.
	get clampMode() {
		return this.#noiseClampMode.elements.NORMALIZE.value ? 'normalize' : this.#noiseClampMode.elements.NONE.value ? 'none' : 'clamp'
	}

	// Returns the selected amp-glow edge or corner.
	get ampGlowPosition() {
		if (this.#noiseAmpGlowPosition.elements.TOP_LEFT.value) return 'top-left'
		if (this.#noiseAmpGlowPosition.elements.TOP_RIGHT.value) return 'top-right'
		if (this.#noiseAmpGlowPosition.elements.BOTTOM_LEFT.value) return 'bottom-left'
		if (this.#noiseAmpGlowPosition.elements.BOTTOM_RIGHT.value) return 'bottom-right'
		if (this.#noiseAmpGlowPosition.elements.LEFT.value) return 'left'
		if (this.#noiseAmpGlowPosition.elements.TOP.value) return 'top'
		if (this.#noiseAmpGlowPosition.elements.BOTTOM.value) return 'bottom'
		return 'right'
	}
}

function sendDefinition(client: ClientSimulator, handler: IndiClientHandler, property: SimulatorProperty) {
	if (property.type === 'NUMBER') handleDefNumberVector(client, handler, property)
	else if (property.type === 'SWITCH') handleDefSwitchVector(client, handler, property)
	else if (property.type === 'TEXT') handleDefTextVector(client, handler, property)
	// Don't handle DefBlobVector
}

function applyTextVectorValues(vector: DefTextVector, elements: Record<string, string>) {
	let updated = false

	for (const key in elements) {
		const element = vector.elements[key]
		if (!element) continue
		const next = elements[key]

		if (element.value !== next) {
			element.value = next
			updated = true
		}
	}

	return updated
}

function applyNumberVectorValues(vector: DefNumberVector, elements: Record<string, number>) {
	let updated = false

	for (const key in elements) {
		const element = vector.elements[key]
		if (!element || !Number.isFinite(elements[key])) continue
		const next = clamp(elements[key], element.min, element.max)

		if (element.value !== next) {
			element.value = next
			updated = true
		}
	}

	return updated
}

function applyExclusiveSwitchValues(vector: DefSwitchVector, elements: Record<string, boolean>) {
	let updated = false

	for (const key in elements) {
		if (elements[key] === true && key in vector.elements) {
			updated = selectOnSwitch(vector, key) || updated
		}
	}

	return updated
}

function applyMultiSwitchValues(vector: DefSwitchVector, elements: Record<string, boolean>) {
	let updated = false

	for (const key in elements) {
		const element = vector.elements[key]
		if (!element || element.value === elements[key]) continue
		element.value = elements[key]
		updated = true
	}

	return updated
}

function wrapRotatorAngle(value: number) {
	value %= 360
	return value < 0 ? value + 360 : value
}

function shortestRotatorDelta(target: number, current: number) {
	let delta = target - current

	if (delta > 180) delta -= 360
	else if (delta < -180) delta += 360

	return delta
}

function rotateImageCoordinate(point: { x: number; y: number }, centerX: number, centerY: number, sinAngle: number, cosAngle: number) {
	const dx = point.x - centerX
	const dy = point.y - centerY
	point.x = centerX + dx * cosAngle - dy * sinAngle
	point.y = centerY + dx * sinAngle + dy * cosAngle
}

function fillFlatField(raw: ImageRawType, width: number, height: number, channels: 1 | 3, exposureTime: number, referenceExposureTime: number) {
	const invWidth = width > 1 ? 2 / (width - 1) : 0
	const invHeight = height > 1 ? 2 / (height - 1) : 0
	// Scale the deterministic flat illumination against the simulator reference exposure.
	const exposureScale = exposureTime / Math.max(referenceExposureTime, CAMERA_MIN_EXPOSURE)

	for (let y = 0; y < height; y++) {
		const yc = y * invHeight - 1
		const row = y * width

		for (let x = 0; x < width; x++) {
			const xc = x * invWidth - 1
			const radius2 = xc * xc + yc * yc
			const illumination = clamp(0.72 - radius2 * 0.16 + (xc + yc) * 0.03, 0.15, 0.95) * exposureScale

			if (channels === 1) raw[row + x] = illumination
			else {
				const index = (row + x) * 3
				raw[index] = illumination * 1.02
				raw[index + 1] = illumination
				raw[index + 2] = illumination * 0.98
			}
		}
	}
}

function clampDeclination(value: number) {
	return clamp(value, -PIOVERTWO, PIOVERTWO)
}
