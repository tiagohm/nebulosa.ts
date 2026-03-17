import type { Angle } from './angle'
import { deg, hour, normalizeAngle, normalizePI } from './angle'
import { DAYSEC, DEG2RAD, MOON_SIDEREAL_DAYS, PIOVERTWO, SIDEREAL_DAYSEC, TAU } from './constants'
import type { EquatorialCoordinate } from './coordinate'
import { CLIENT, type Client, type ClientInfo, type Device, type DeviceType, type DriverInfo, expectedPierSide, type GuideDirection, type Mount, type NameAndLabel, type PierSide, type TrackMode, type UTCTime } from './indi.device'
import type { DeviceManager } from './indi.manager'
import type { EnableBlob, GetProperties, NewNumberVector, NewSwitchVector, NewTextVector } from './indi.types'
import { type GeographicCoordinate, localSiderealTime } from './location'
import { clamp } from './math'
import { timeUnix } from './time'

const TICK_INTERVAL_MS = 100
const SIDEREAL_DRIFT_RATE = TAU / SIDEREAL_DAYSEC
const KING_DRIFT_RATE = TAU / 86188
const SOLAR_DRIFT_RATE = TAU / (365.2422 * DAYSEC)
const LUNAR_DRIFT_RATE = TAU / (MOON_SIDEREAL_DAYS * DAYSEC)
const MAX_GUIDE_RATE = 1

const SLEW_RATES = [
	{ name: '1x', label: '1x', speed: 0.5 * DEG2RAD },
	{ name: '2x', label: '2x', speed: 1.0 * DEG2RAD },
	{ name: '3x', label: '3x', speed: 2.0 * DEG2RAD },
	{ name: '4x', label: '4x', speed: 4.0 * DEG2RAD },
] as const

type CoordSetMode = 'SLEW' | 'SYNC'

type SlewMode = 'GOTO' | 'HOME' | 'PARK'

type AxisDirection = -1 | 0 | 1

// Routes MountManager commands back into the simulator.
export class ClientSimulator implements Client {
	readonly type = 'SIMULATOR'

	#managers = new Set<Pick<DeviceSimulator<Device>, 'sendNumber' | 'sendSwitch' | 'sendText' | 'dispose'>>()

	constructor(
		readonly id: string,
		readonly description: string = 'Client Simulator',
	) {}

	getProperties(command?: GetProperties) {}

	enableBlob(command: EnableBlob) {}

	sendText(vector: NewTextVector) {
		for (const manager of this.#managers) manager.sendText(vector)
	}

	sendNumber(vector: NewNumberVector) {
		for (const manager of this.#managers) manager.sendNumber(vector)
	}

	sendSwitch(vector: NewSwitchVector) {
		for (const manager of this.#managers) manager.sendSwitch(vector)
	}

	register(manager: Pick<DeviceSimulator<Device>, 'sendNumber' | 'sendSwitch' | 'sendText' | 'dispose'>) {
		this.#managers.add(manager)
	}

	unregister(manager: Pick<DeviceSimulator<Device>, 'sendNumber' | 'sendSwitch' | 'sendText' | 'dispose'>) {
		this.#managers.delete(manager)
	}

	[Symbol.dispose]() {
		for (const manager of this.#managers) manager.dispose()
	}
}

abstract class DeviceSimulator<D extends Device> implements Device, Disposable {
	#connected = false

	abstract readonly id: string
	abstract readonly type: DeviceType
	abstract readonly name: string
	abstract readonly driver: DriverInfo
	abstract readonly manager: DeviceManager<D>

	readonly client: ClientInfo
	readonly [CLIENT]: ClientSimulator

	constructor(client: ClientSimulator) {
		this[CLIENT] = client
		this.client = { id: client.id, type: client.type }
	}

	get connected() {
		return this.#connected
	}

	abstract sendText(vector: NewTextVector): void
	abstract sendNumber(vector: NewNumberVector): void
	abstract sendSwitch(vector: NewSwitchVector): void
	abstract dispose(): void

	// Connects the simulated mount.
	connect() {
		if (this.#connected) return
		this.#connected = true
		this.emit('connected')
	}

	// Disconnects the simulated mount and cancels active motion.
	disconnect() {
		if (!this.#connected) return
		this.#connected = false
		this.emit('connected')
	}

	[Symbol.dispose]() {
		this.dispose()
	}

	// Emits a MountManager update for the requested property.
	protected emit(property: keyof D & string) {
		this.manager.updated(this as never, property)
	}
}

export class MountSimulator extends DeviceSimulator<Mount> implements Mount {
	readonly type = 'MOUNT'
	readonly canAbort = true
	readonly canSync = true
	readonly canGoTo = true
	readonly canFlip = false
	readonly canHome = true
	readonly canFindHome = false
	readonly canSetHome = true
	readonly canTracking = true
	readonly canMove = true
	readonly slewRates: readonly NameAndLabel[] = SLEW_RATES
	readonly mountType = 'EQ_GEM'
	readonly trackModes = ['SIDEREAL', 'SOLAR', 'LUNAR', 'KING'] as const
	readonly canSetPierSide = true
	readonly canPulseGuide = true
	readonly hasGuideRate = true
	readonly canSetGuideRate = true
	readonly driver = { executable: 'mount_simulator', version: '0.1.0' } as const
	readonly hasGPS = true
	readonly canPark = true
	readonly canSetPark = true
	readonly hasPierSide = true

	slewing = false
	tracking = false
	homing = false
	trackMode: TrackMode = 'SIDEREAL'
	pierSide: PierSide = 'NEITHER'
	slewRate = '3x'
	equatorialCoordinate: EquatorialCoordinate<Angle> = { rightAscension: 0, declination: PIOVERTWO }
	pulsing = false
	guideRate: EquatorialCoordinate<number> = { rightAscension: 0.5, declination: 0.5 }
	geographicCoordinate: GeographicCoordinate = { latitude: 0, longitude: 0, elevation: 0 }
	time: UTCTime = { utc: Date.now(), offset: 0 }
	parking = false
	parked = false

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
	#manager: DeviceManager<Mount>

	constructor(
		client: ClientSimulator,
		manager: DeviceManager<Mount>,
		readonly name: string,
		readonly id: string,
	) {
		super(client)
		this.#manager = manager
	}

	get manager() {
		return this.#manager
	}

	sendText(vector: NewTextVector) {
		if (vector.device !== this.name) return

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
		if (vector.device !== this.name) return

		switch (vector.name) {
			case 'EQUATORIAL_EOD_COORD': {
				const rightAscension = vector.elements.RA !== undefined ? hour(vector.elements.RA) : this.equatorialCoordinate.rightAscension
				const declination = vector.elements.DEC !== undefined ? deg(vector.elements.DEC) : this.equatorialCoordinate.declination

				if (this.#coordSetMode === 'SYNC') this.syncTo(rightAscension, declination)
				else this.goTo(rightAscension, declination)

				return
			}
			case 'GEOGRAPHIC_COORD':
				this.setGeographicCoordinate({
					latitude: vector.elements.LAT !== undefined ? deg(vector.elements.LAT) : this.geographicCoordinate.latitude,
					longitude: vector.elements.LONG !== undefined ? normalizePI(deg(vector.elements.LONG)) : this.geographicCoordinate.longitude,
					elevation: vector.elements.ELEV ?? this.geographicCoordinate.elevation,
				})

				return
			case 'GUIDE_RATE':
				this.setGuideRate(vector.elements.GUIDE_RATE_WE ?? this.guideRate.rightAscension, vector.elements.GUIDE_RATE_NS ?? this.guideRate.declination)

				return
			case 'TELESCOPE_TIMED_GUIDE_NS':
				if ((vector.elements.TIMED_GUIDE_N ?? 0) > 0) this.pulse('NORTH', vector.elements.TIMED_GUIDE_N)
				if ((vector.elements.TIMED_GUIDE_S ?? 0) > 0) this.pulse('SOUTH', vector.elements.TIMED_GUIDE_S)
				return
			case 'TELESCOPE_TIMED_GUIDE_WE':
				if ((vector.elements.TIMED_GUIDE_W ?? 0) > 0) this.pulse('WEST', vector.elements.TIMED_GUIDE_W)
				if ((vector.elements.TIMED_GUIDE_E ?? 0) > 0) this.pulse('EAST', vector.elements.TIMED_GUIDE_E)
				return
		}
	}

	sendSwitch(vector: NewSwitchVector) {
		if (vector.device !== this.name) return

		switch (vector.name) {
			case 'CONNECTION':
				if (vector.elements.CONNECT === true) this.connect()
				if (vector.elements.DISCONNECT === true) this.disconnect()
				return
			case 'TELESCOPE_ABORT_MOTION':
				if (vector.elements.ABORT === true) this.stop()
				return
			case 'TELESCOPE_HOME':
				if (vector.elements.GO === true || vector.elements.FIND === true) this.home()
				if (vector.elements.SET === true) this.setHome()
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
				if (vector.elements.UNPARK === true) this.unpark()
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
				if (vector.elements.TRACK_OFF === true) this.setTrackingEnabled(false)
				return
			case 'ON_COORD_SET':
				if (vector.elements.SYNC === true) this.#coordSetMode = 'SYNC'
				else if (vector.elements.SLEW === true) this.#coordSetMode = 'SLEW'
				return
		}
	}

	// Starts the simulation clock and publishes the device in the manager.
	start() {
		if (this.#timer) return false

		this.#lastTick = Date.now()
		this.refreshDynamicCoordinates(false)
		this[CLIENT].register(this)
		this.manager.add(this)
		this.#timer = setInterval(this.tick.bind(this), TICK_INTERVAL_MS)
		return true
	}

	// Disconnects the simulated mount and cancels active motion.
	disconnect() {
		super.disconnect()
		this.stop()
		this.setTrackingEnabled(false)
	}

	// Starts a time-based slew to the requested equatorial coordinate.
	goTo(rightAscension: Angle, declination: Angle) {
		if (!this.connected || this.parked) return

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
		if (!this.connected) return
		this.setCoordinate(normalizeAngle(rightAscension), clampDeclination(declination), true)
	}

	// Slews to the configured home position.
	home() {
		if (!this.connected || this.parked) return
		this.#slewMode = 'HOME'
		this.#slewTarget = { rightAscension: this.#homeCoordinate.rightAscension, declination: this.#homeCoordinate.declination }
		this.setSlewing(true)
		this.setHoming(true)
		this.setParking(false)
	}

	// Stores the current coordinate as the new home position.
	setHome() {
		this.#homeCoordinate.rightAscension = this.equatorialCoordinate.rightAscension
		this.#homeCoordinate.declination = this.equatorialCoordinate.declination
	}

	// Parks the mount at the configured park position.
	park() {
		if (!this.connected || this.parked) return
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
		if (this.parked) {
			this.parked = false
			this.emit('parked')
		}

		this.setParking(false)
	}

	// Stores the current coordinate as the park position.
	setPark() {
		this.#parkCoordinate.rightAscension = this.equatorialCoordinate.rightAscension
		this.#parkCoordinate.declination = this.equatorialCoordinate.declination
	}

	// Enables or disables sidereal-style tracking.
	setTrackingEnabled(enable: boolean) {
		if (this.parked) enable = false
		if (this.tracking === enable) return
		this.tracking = enable
		this.emit('tracking')
	}

	// Changes the simulated tracking mode.
	setTrackMode(mode: TrackMode) {
		if (!this.trackModes.includes(mode as never) || this.trackMode === mode) return
		this.trackMode = mode
		this.emit('trackMode')
	}

	// Changes the manual slew rate selection.
	setSlewRate(rate: NameAndLabel | string) {
		const name = typeof rate === 'string' ? rate : rate.name
		if (!SLEW_RATES.some((entry) => entry.name === name) || this.slewRate === name) return
		this.slewRate = name
		this.emit('slewRate')
	}

	// Changes the simulated guide rate multipliers.
	setGuideRate(rightAscension: number, declination: number) {
		rightAscension = clamp(rightAscension, 0, MAX_GUIDE_RATE)
		declination = clamp(declination, 0, MAX_GUIDE_RATE)
		let updated = false

		if (this.guideRate.rightAscension !== rightAscension) {
			this.guideRate.rightAscension = rightAscension
			updated = true
		}

		if (this.guideRate.declination !== declination) {
			this.guideRate.declination = declination
			updated = true
		}

		if (updated) this.emit('guideRate')
	}

	// Updates the simulated site coordinate.
	setGeographicCoordinate(coordinate: GeographicCoordinate) {
		let updated = false

		if (this.geographicCoordinate.latitude !== coordinate.latitude) {
			this.geographicCoordinate.latitude = coordinate.latitude
			updated = true
		}

		if (this.geographicCoordinate.longitude !== coordinate.longitude) {
			this.geographicCoordinate.longitude = normalizePI(coordinate.longitude)
			updated = true
		}

		if (this.geographicCoordinate.elevation !== coordinate.elevation) {
			this.geographicCoordinate.elevation = coordinate.elevation
			updated = true
		}

		if (updated) {
			this.updatePierSide(true)
			this.emit('geographicCoordinate')
		}
	}

	// Updates the simulated UTC clock.
	setTime(value: UTCTime) {
		if (this.time.utc === value.utc && this.time.offset === value.offset) return
		this.time.utc = value.utc
		this.time.offset = value.offset
		this.#lastTick = Date.now()
		this.updatePierSide(true)
		this.emit('time')
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
		if (!this.connected || this.parked || duration <= 0) return
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

		this.updatePulsing(true)
	}

	// Aborts any active slew or manual motion.
	stop() {
		const wasSlewing = this.slewing
		const wasHoming = this.homing
		const wasParking = this.parking

		this.#slewMode = undefined
		this.#slewTarget = undefined
		this.clearManualMotion()
		this.clearPulseGuide()
		this.slewing = false
		this.homing = false
		this.parking = false

		if (wasSlewing) this.emit('slewing')
		if (wasHoming) this.emit('homing')
		if (wasParking) this.emit('parking')
	}

	// Stops the simulation clock and removes the device from the manager.
	dispose() {
		if (this.#timer) {
			clearInterval(this.#timer)
			this.#timer = undefined
		}

		this.stop()
		this.disconnect()
		this[CLIENT].unregister(this)
		this.manager.remove(this)
	}

	// Advances the simulated state using wall-clock time.
	private tick() {
		const now = Date.now()
		const dtSeconds = Math.max(0, (now - this.#lastTick) / 1000)
		this.#lastTick = now

		if (dtSeconds <= 0) return

		this.time.utc += Math.trunc(dtSeconds * 1000)

		if (!this.connected) return

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
		const deltaRightAscension = normalizePI(target.rightAscension - this.equatorialCoordinate.rightAscension)
		const deltaDeclination = target.declination - this.equatorialCoordinate.declination
		const span = Math.max(Math.abs(deltaRightAscension), Math.abs(deltaDeclination))

		if (span <= maxStep || span === 0) {
			this.setCoordinate(target.rightAscension, target.declination, true)
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
		this.setCoordinate(this.equatorialCoordinate.rightAscension + deltaRightAscension * scale, this.equatorialCoordinate.declination + deltaDeclination * scale, true)
	}

	// Advances tracking, manual motion and pulse guiding when not slewing.
	private advanceFreeMotion(dtSeconds: number) {
		let rightAscension = this.equatorialCoordinate.rightAscension
		let declination = this.equatorialCoordinate.declination
		const trackingDrift = this.trackingDriftRate()
		let moved = trackingDrift !== 0

		rightAscension += trackingDrift * dtSeconds

		if (this.#manualWestEast !== 0) {
			rightAscension += this.#manualWestEast * this.manualSlewSpeed() * dtSeconds
			moved = true
		}

		if (this.#manualNorthSouth !== 0) {
			declination += this.#manualNorthSouth * this.manualSlewSpeed() * dtSeconds
			moved = true
		}

		if (this.#pulseWestEast !== 0) {
			rightAscension += this.#pulseWestEast * this.guideRate.rightAscension * SIDEREAL_DRIFT_RATE * dtSeconds
			moved = true
		}

		if (this.#pulseNorthSouth !== 0) {
			declination += this.#pulseNorthSouth * this.guideRate.declination * SIDEREAL_DRIFT_RATE * dtSeconds
			moved = true
		}

		rightAscension = normalizeAngle(rightAscension)
		declination = clampDeclination(declination)

		if (moved) {
			this.setCoordinate(rightAscension, declination, true)
		}
	}

	// Applies a coordinate update and notifies listeners when required.
	private setCoordinate(rightAscension: Angle, declination: Angle, notify: boolean) {
		rightAscension = normalizeAngle(rightAscension)
		declination = clampDeclination(declination)

		const coordinate = this.equatorialCoordinate
		const changed = coordinate.rightAscension !== rightAscension || coordinate.declination !== declination

		coordinate.rightAscension = rightAscension
		coordinate.declination = declination

		const pierSideChanged = this.updatePierSide(notify)

		if (notify && changed) this.emit('equatorialCoordinate')
		if (notify && pierSideChanged) this.emit('pierSide')
	}

	// Keeps the simulated pier side consistent with the current sky position.
	private updatePierSide(notify: boolean) {
		const pierSide = expectedPierSide(this.equatorialCoordinate.rightAscension, this.equatorialCoordinate.declination, this.siderealTime())
		if (pierSide === this.pierSide) return false
		this.pierSide = pierSide
		return notify
	}

	// Computes the current local sidereal time from the simulated clock.
	private siderealTime() {
		return localSiderealTime(timeUnix(this.time.utc / 1000, undefined, true), this.geographicCoordinate)
	}

	// Returns the active free-slew speed in radians per second.
	private manualSlewSpeed() {
		return SLEW_RATES.find((entry) => entry.name === this.slewRate)?.speed ?? SLEW_RATES[2].speed
	}

	// Returns the RA drift implied by the current tracking state.
	private trackingDriftRate() {
		if (!this.tracking) return SIDEREAL_DRIFT_RATE
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

		if (changed) this.updatePulsing(true)
	}

	// Updates the combined pulse-guiding state.
	private updatePulsing(notify: boolean) {
		const pulsing = this.#pulseNorthSouth !== 0 || this.#pulseWestEast !== 0

		if (this.pulsing !== pulsing) {
			this.pulsing = pulsing
			if (notify) this.emit('pulsing')
		}
	}

	// Sets the active north/south manual motion state.
	private setManualNorthSouth(direction: AxisDirection) {
		if (!this.connected || this.parked) direction = 0
		if (this.#manualNorthSouth === direction) return
		if (direction !== 0) this.abortSlew()
		this.#manualNorthSouth = direction
		this.refreshSlewingState()
	}

	// Sets the active west/east manual motion state.
	private setManualWestEast(direction: AxisDirection) {
		if (!this.connected || this.parked) direction = 0
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
		const pulsing = this.pulsing
		this.#pulseNorthSouth = 0
		this.#pulseWestEast = 0
		this.#pulseNorthSouthUntil = 0
		this.#pulseWestEastUntil = 0
		this.pulsing = false
		if (pulsing) this.emit('pulsing')
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
		if (this.slewing === value) return
		this.slewing = value
		this.emit('slewing')
	}

	// Updates the homing flag and notifies listeners.
	private setHoming(value: boolean) {
		if (this.homing === value) return
		this.homing = value
		this.emit('homing')
	}

	// Updates the parking state and notifies listeners.
	private setParking(parking: boolean, parked?: boolean) {
		if (this.parking !== parking) {
			this.parking = parking
			this.emit('parking')
		}

		if (parked !== undefined && this.parked !== parked) {
			this.parked = parked
			this.emit('parked')
		}
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
