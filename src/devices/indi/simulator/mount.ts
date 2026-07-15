import type { EquatorialCoordinate } from '../../../astronomy/coordinates/coordinate'
import { localSiderealTime } from '../../../astronomy/observer/location'
import { formatTemporal, TIMEZONE } from '../../../astronomy/time/temporal'
import { timeUnix } from '../../../astronomy/time/time'
import { PIOVERTWO } from '../../../core/constants'
import { clamp } from '../../../math/numerical/math'
import { type Angle, deg, hour, normalizeAngle, normalizePI, toDeg, toHour } from '../../../math/units/angle'
import { meter } from '../../../math/units/distance'
import { handleDefNumberVector, type IndiClientHandler } from '../client'
import { DeviceInterfaceType, expectedPierSide, type GuideDirection, type NameAndLabel, type PierSide, type TrackMode, type UTCTime } from '../device'
import { findOnSwitch, makeNumberVector, makeSwitchVector, makeTextVector, type NewNumberVector, type NewSwitchVector, type NewTextVector, selectOnSwitch } from '../types'
import type { ClientSimulator } from './client'
import { KING_DRIFT_RATE, LUNAR_DRIFT_RATE, MAIN_CONTROL, MAX_GUIDE_RATE, SIDEREAL_DRIFT_RATE, SLEW_RATES, SOLAR_DRIFT_RATE, TICK_INTERVAL_MS } from './constants'
import { DeviceSimulator } from './device'
import type { AxisDirection, CoordSetMode, DeviceSimulatorOptions, SimulatorProperty, SlewMode } from './types'
import { applyNumberVectorValues, clampDeclination } from './util'

// Simulated equatorial mount, tracking, slewing, site, and pulse-guiding behavior.

// Simulated equatorial mount. Models tracking drift per track mode, manual axis motion, slew/sync/goto,
// park/home, pier side, site location and time, and pulse guiding, advancing the equatorial coordinate
// on each tick and emitting the corresponding INDI vectors.
export class MountSimulator extends DeviceSimulator {
	readonly type = 'mount'
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
		this.#guideNS,
		this.#guideWE,
		this.#guideRate,
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
	readonly #homeCoordinate: EquatorialCoordinate = { rightAscension: 0, declination: PIOVERTWO }
	readonly #parkCoordinate: EquatorialCoordinate = { rightAscension: 0, declination: PIOVERTWO }
	#utcTime = Date.now()
	#utcOffset = TIMEZONE / 60
	#notifyCoordinateLastTime = 0

	minimumNotifyCoordinateInterval = 1000

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

	// Current equatorial coordinate (radians) decoded from the RA-hours/Dec-degrees property.
	get rightAscension() {
		return hour(this.#equatorialCoordinate.elements.RA.value)
	}

	get declination() {
		return deg(this.#equatorialCoordinate.elements.DEC.value)
	}

	// Park/track/home/slew/pulse/parking state flags derived from the corresponding property values/states.
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

	// Selected tracking mode.
	get trackMode(): TrackMode {
		const { TRACK_SIDEREAL, TRACK_SOLAR, TRACK_LUNAR } = this.#trackMode.elements
		return TRACK_SIDEREAL.value ? 'SIDEREAL' : TRACK_SOLAR.value ? 'SOLAR' : TRACK_LUNAR.value ? 'LUNAR' : 'KING'
	}

	// Site geographic coordinate components (longitude/latitude in radians, elevation in metres).
	get longitude() {
		return deg(this.#geographicCoordinate.elements.LONG.value)
	}

	get latitude() {
		return deg(this.#geographicCoordinate.elements.LAT.value)
	}

	get elevation() {
		return meter(this.#geographicCoordinate.elements.ELEV.value)
	}

	// Guide rates (fraction of sidereal) for the RA/Dec axes.
	get guideRateRightAscension() {
		return this.#guideRate.elements.GUIDE_RATE_WE.value
	}

	get guideRateDeclination() {
		return this.#guideRate.elements.GUIDE_RATE_NS.value
	}

	// Name of the selected slew-rate preset.
	get slewRate() {
		return findOnSwitch(this.#slewRate)[0]
	}

	// Current pier side derived from the pier-side property.
	get pierSide(): PierSide {
		return this.#pierSide.elements.PIER_EAST.value ? 'EAST' : this.#pierSide.elements.PIER_WEST.value ? 'WEST' : 'NEITHER'
	}

	// Handles mount text commands: the UTC time/offset property.
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

	// Handles mount number commands: slew/sync to equatorial target, site geographic coordinate, guide
	// rate, and timed pulse-guiding (milliseconds).
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

	// Handles mount switch commands: connection, slew/sync mode, abort, track mode/state, home, park,
	// axis motion, and slew-rate selection.
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

		if (notify && this.#lastTick - this.#notifyCoordinateLastTime >= this.minimumNotifyCoordinateInterval) {
			this.#notifyCoordinateLastTime = this.#lastTick
			this.notify(this.#equatorialCoordinate)
		}

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
		return localSiderealTime(timeUnix(this.#utcTime / 1000, true), this.longitude)
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

	// Sets the pulse-guiding Busy/Idle state on the timed-guide vectors and notifies on change.
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
