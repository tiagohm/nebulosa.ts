import type { EquatorialCoordinate } from '../../../astronomy/coordinates/coordinate'
import type { EquatorialPointingModel } from '../../../astronomy/coordinates/pointing'
import { SIDEREAL_DRIFT_RATE } from '../../../core/constants'
import { type Angle, normalizePI } from '../../../math/units/angle'
import type { IndiClientHandler } from '../client'
import { DeviceInterfaceType, type GuideDirection, type NameAndLabel, type PierSide, type TrackMode, type UTCTime } from '../device'
import type { NewNumberVector, NewSwitchVector, NewTextVector } from '../types'
import type { ClientSimulator } from './client'
import { assignComponentDevice, type ComponentBus, componentProperties, routeNumber, routeSwitch, routeText, type SimulatorComponent, transientComponentProperties } from './component'
import { TICK_INTERVAL_MS } from './constants'
import { DeviceSimulator } from './device'
import { MountAlignment } from './mount.alignment'
import { MountBoresight } from './mount.boresight'
import { MountClock } from './mount.clock'
import { circuitSeed, type MountSimulatorConfig, type MountSimulatorConfigOverride, mountSimulatorConfig } from './mount.config'
import { MountDrive } from './mount.drive'
import { MountErrorFeatures } from './mount.errors'
import { MountFlexure } from './mount.flexure'
import { MountGuidePort } from './mount.guiding'
import { MountMechanics } from './mount.mechanics'
import { MountMeridianFlip } from './mount.meridianflip'
import { MountPeriodicError } from './mount.periodic'
import { MountSettling } from './mount.settling'
import { MountSite } from './mount.site'
import { MountTracking } from './mount.tracking'
import { MountWind } from './mount.wind'
import type { DeviceSimulatorOptions, MountPointingState, SimulatorProperty } from './types'

// Simulated equatorial mount: a backplane of circuits, each owning its properties, its state and its
// commands. The drive moves the axes; the clock and the site give time and place; tracking, the guide
// port and the meridian policy command the drive; the error families perturb the motion or the optical
// axis; the boresight evaluates and records where the optical axis really points. The backplane routes
// commands, steps the simulation and carries the couplings between circuits. Angles are radians and
// times milliseconds of the simulated clock unless stated.

// Options of a simulated mount.
export interface MountSimulatorOptions extends DeviceSimulatorOptions {
	// Override of DEFAULT_MOUNT_SIMULATOR_CONFIG.
	readonly config?: MountSimulatorConfigOverride
	// Wall clock that drives the ticking, milliseconds since the Unix epoch. Defaults to Date.now.
	readonly now?: () => number
}

// Seed offsets of the circuits that draw random numbers, so each has its own generator.
const GUIDING_SEED = 0
const WIND_SEED = 1
const MECHANICS_SEED = 2
const TRACKING_SEED = 3

// Simulated German equatorial mount with an ST-4 port.
export class MountSimulator extends DeviceSimulator {
	readonly type = 'mount'

	// Configuration the mount was built with.
	readonly configuration: MountSimulatorConfig

	readonly #clock: MountClock
	readonly #site: MountSite
	readonly #errors: MountErrorFeatures
	readonly #alignment: MountAlignment
	readonly #flexure: MountFlexure
	readonly #periodicError: MountPeriodicError
	readonly #settling: MountSettling
	readonly #wind: MountWind
	readonly #mechanics: MountMechanics
	readonly #tracking: MountTracking
	readonly #guidePort: MountGuidePort
	readonly #meridian: MountMeridianFlip
	readonly #boresight: MountBoresight
	readonly #drive: MountDrive
	readonly #components: readonly SimulatorComponent[]
	// Wall clock that drives the ticking, milliseconds.
	readonly #now: () => number

	protected readonly properties: readonly SimulatorProperty[]
	protected readonly propertiesToNotSave: readonly SimulatorProperty[]

	#timer?: NodeJS.Timeout
	// Wall-clock instant of the previous tick, milliseconds.
	#lastTick = 0
	// Reported hour angle captured before a command changes the site, radians.
	#hourAngleBeforeChange: Angle = 0

	constructor(
		name: string,
		client: ClientSimulator,
		readonly options?: MountSimulatorOptions,
		handler: IndiClientHandler = client.handler,
	) {
		super(name, client, handler, DeviceInterfaceType.TELESCOPE | DeviceInterfaceType.GUIDER, 'mount.simulator')

		const config = mountSimulatorConfig(options?.config)
		const now = options?.now ?? Date.now
		const bus: ComponentBus = { notify: (property) => this.notify(property), now: () => this.#clock.exact }

		this.configuration = config
		this.#now = now
		this.#clock = new MountClock(bus, now(), (value) => this.setTime(value))
		this.#site = new MountSite(bus, config.site, { changing: () => this.#captureHourAngle(), changed: () => this.#siteChanged() })
		this.#errors = new MountErrorFeatures(bus, config.errors, () => this.#featuresChanged())
		this.#alignment = new MountAlignment(bus, config.alignment, () => this.#alignmentChanged())
		this.#flexure = new MountFlexure(bus, config.flexure, () => this.#recordBoresight())
		this.#periodicError = new MountPeriodicError(bus, config.periodicError, () => this.#recordBoresight())
		this.#settling = new MountSettling(bus, config.settling)
		this.#wind = new MountWind(bus, config.wind, circuitSeed(config.seed, WIND_SEED), () => this.#recordBoresight())
		this.#mechanics = new MountMechanics(bus, config.mechanics, circuitSeed(config.seed, MECHANICS_SEED))
		this.#tracking = new MountTracking(bus, config.drive, config.trackingRate, circuitSeed(config.seed, TRACKING_SEED), () => this.#drive.isParked)
		this.#guidePort = new MountGuidePort(bus, config.drive, config.guiding, circuitSeed(config.seed, GUIDING_SEED), {
			accepts: () => this.isConnected && !this.#drive.isParked && !this.#drive.hasSlewTarget,
			now: () => this.#clock.exact,
			ended: () => this.#drive.publishCoordinate(),
		})
		this.#meridian = new MountMeridianFlip(bus, config.meridian)
		this.#boresight = new MountBoresight({ site: this.#site, alignment: this.#alignment, flexure: this.#flexure, periodicError: this.#periodicError, tracking: this.#tracking, mechanics: this.#mechanics, wind: this.#wind }, () => this.#drive.mechanical)
		// oxfmt-ignore
		this.#drive = new MountDrive(bus, config.drive, { clock: this.#clock, site: this.#site, alignment: this.#alignment, tracking: this.#tracking, guidePort: this.#guidePort, mechanics: this.#mechanics, settling: this.#settling, wind: this.#wind, periodicError: this.#periodicError, meridian: this.#meridian }, this.#boresight, () => this.isConnected)
		this.#components = [this.#drive, this.#tracking, this.#clock, this.#site, this.#guidePort, this.#meridian, this.#errors, this.#alignment, this.#periodicError, this.#mechanics, this.#settling, this.#flexure, this.#wind]

		assignComponentDevice(this.#components, name)
		this.properties = componentProperties(this.#components)
		this.propertiesToNotSave = transientComponentProperties(this.#components)

		// Nothing has ticked yet, so the first connection catches the clock up with the wall clock.
		this.#clock.suspend(now())
		this.#refreshConfigurations()
		this.#drive.placeAtStartupPose()
	}

	// ---- State ----

	// Reported coordinate, radians: what the controller believes and what INDI clients see, not the true
	// orientation of the axes; see `mechanical` and `boresight` for those.
	get rightAscension(): Angle {
		return this.#drive.rightAscension
	}

	get declination(): Angle {
		return this.#drive.declination
	}

	// True orientation of the mechanical axes, radians. Aliases internal state, so callers must treat it
	// as read-only and copy it to keep it.
	get mechanical(): Readonly<EquatorialCoordinate> {
		return this.#drive.mechanical
	}

	// Direction the optical axis really points now: the mechanical orientation perturbed by every error
	// being simulated. Evaluated at the present only, since backlash, the guide queue and the wind are
	// path-dependent; `sampleBoresightTrajectory` answers for the past from the record.
	get boresight(): EquatorialCoordinate {
		return this.#boresight.at(this.#clock.exact, this.pierSide)
	}

	// The three directions of the mount at this instant.
	get pointingState(): MountPointingState {
		const { rightAscension, declination } = this.#drive.mechanical
		return { reported: { rightAscension: this.rightAscension, declination: this.declination }, mechanical: { rightAscension, declination }, boresight: this.boresight }
	}

	// Position angle of the tube's up direction at the boresight, radians east of north in the frame of
	// date: it turns with the right-ascension axis about the mount's own axis, which is what a
	// camera-based polar alignment measures.
	get tubeOrientation(): Angle {
		return this.#boresight.orientation(this.#clock.exact, this.pierSide)
	}

	// First-order pointing model of the cone and non-perpendicularity errors; the shared identity when
	// none is simulated.
	get pointingModel(): EquatorialPointingModel {
		return this.#alignment.pointingModel
	}

	// Right ascension the drive delivered beyond what the encoders counted, radians; cleared by a sync
	// or a successful FIND.
	get trackingRateOffset(): Angle {
		return this.#tracking.offset
	}

	// Phase of the right-ascension worm, radians in [0, TAU).
	get wormPhase(): Angle {
		return this.#periodicError.phase
	}

	// Physical side of the pier the tube is on.
	get pierSide(): PierSide {
		return this.#drive.pierSide
	}

	get isParked() {
		return this.#drive.isParked
	}

	get isTracking() {
		return this.#tracking.enabled
	}

	get isHoming() {
		return this.#drive.isHoming
	}

	get isSlewing() {
		return this.#drive.isSlewing
	}

	get isPulsing() {
		return this.#guidePort.isPulsing
	}

	get isParking() {
		return this.#drive.isParking
	}

	// Selected tracking mode.
	get trackMode(): TrackMode {
		return this.#tracking.mode
	}

	// Site: longitude east and latitude north, radians, and elevation, metres.
	get longitude() {
		return this.#site.longitude
	}

	get latitude() {
		return this.#site.latitude
	}

	get elevation() {
		return this.#site.elevation
	}

	// Guide rates, fractions of the sidereal rate.
	get guideRateRightAscension() {
		return this.#guidePort.rateRightAscension
	}

	get guideRateDeclination() {
		return this.#guidePort.rateDeclination
	}

	// Name of the selected slew-rate preset.
	get slewRate() {
		return this.#drive.slewRate
	}

	// Simulated UTC, whole milliseconds since the epoch. Advances with the ticks and is what TIME_UTC
	// sets, so anything that needs the mount's time must read it instead of the wall clock.
	get utcTime() {
		return this.#clock.utc
	}

	// Shortest interval between two publications of the coordinate during continuous motion,
	// milliseconds of simulated time.
	get minimumNotifyCoordinateInterval() {
		return this.#drive.minimumNotifyCoordinateInterval
	}

	set minimumNotifyCoordinateInterval(value: number) {
		this.#drive.minimumNotifyCoordinateInterval = value
	}

	// Local sidereal time at `utcTime`, milliseconds since the epoch, radians.
	siderealTimeAt(utcTime: number) {
		return this.#site.siderealTimeAt(utcTime)
	}

	// Writes `count` boresight right ascension and declination pairs, evenly spaced over
	// [`startTime`, `endTime`], into `out`, returning how many were written; 0 before anything was
	// recorded. Times before the retained record clamp to its oldest sample.
	sampleBoresightTrajectory(startTime: number, endTime: number, count: number, out: Float64Array) {
		return this.#boresight.sample(startTime, endTime, count, out)
	}

	// ---- Commands ----

	// Routes a text command to the circuit that owns it.
	sendText(vector: NewTextVector) {
		super.sendText(vector)
		routeText(this.#components, vector)
	}

	// Routes a number command to the circuit that owns it.
	sendNumber(vector: NewNumberVector) {
		routeNumber(this.#components, vector)
	}

	// Handles connection, then routes the command to the circuit that owns it.
	sendSwitch(vector: NewSwitchVector) {
		super.sendSwitch(vector)

		if (vector.name === 'CONNECTION') {
			if (vector.elements.CONNECT === true) this.connect()
			else if (vector.elements.DISCONNECT === true) this.disconnect()
			return
		}

		routeSwitch(this.#components, vector)
	}

	// Starts a goto to the reported coordinate; with `track`, as ON_COORD_SET TRACK, tracking turns on
	// at arrival.
	goTo(rightAscension: Angle, declination: Angle, track: boolean = false) {
		this.#drive.goTo(rightAscension, declination, track)
	}

	// Slews the same coordinate onto the other side of the pier.
	flipTo(rightAscension: Angle, declination: Angle) {
		this.#drive.flipTo(rightAscension, declination)
	}

	// Syncs to the reported coordinate, keeping the physical side of the pier.
	syncTo(rightAscension: Angle, declination: Angle) {
		this.#drive.syncTo(rightAscension, declination)
	}

	// Goes to the stored home pose without acquiring the sensor.
	home() {
		this.#drive.home('GO')
	}

	// Seeks the home sensor and acquires its index.
	findHome() {
		this.#drive.home('FIND')
	}

	// Stores the current pose as home.
	setHome() {
		this.#drive.setHome()
	}

	// Parks the mount at the stored park pose.
	park() {
		this.#drive.park()
	}

	// Unparks the mount without moving it.
	unpark() {
		this.#drive.unpark()
	}

	// Stores the current pose as park.
	setPark() {
		this.#drive.setPark()
	}

	// Starts or stops tracking; a parked mount never tracks.
	setTrackingEnabled(enable: boolean) {
		this.#tracking.setEnabled(enable)
	}

	// Selects a tracking mode.
	setTrackMode(mode: TrackMode) {
		this.#tracking.setMode(mode)
	}

	// Selects a slew-rate preset.
	setSlewRate(rate: NameAndLabel | string) {
		this.#drive.setSlewRate(rate)
	}

	// Sets the guide rates, fractions of the sidereal rate.
	setGuideRate(rightAscension: number, declination: number) {
		this.#guidePort.setRate(rightAscension, declination)
	}

	// Sets the simulated clock. Queued pulses keep their durations, the meridian policy follows the sky,
	// and the recorded trajectory, indexed by the clock and searched assuming it only increases, is
	// dropped. What is physical survives: the drift of the drive and any ring-down are facts about the
	// mount, not about what time it is. The UTC offset alone moves nothing.
	setTime(value: UTCTime) {
		if (value.utc === this.#clock.utc && value.offset === this.#clock.offset) return

		const delta = this.#clock.apply(value)
		if (delta === 0) return

		this.#guidePort.shift(delta)
		this.#meridian.advance((delta / 1000) * SIDEREAL_DRIFT_RATE, delta < 0)
		this.#lastTick = this.#now()
		this.#boresight.reset(this.#clock.exact, this.pierSide)
		// The coordinate is published against the simulated clock, so moving it re-registers that epoch.
		this.#drive.refreshReportedCoordinate()
	}

	// Manual motion of each direction at the slew rate.
	moveNorth(enable: boolean) {
		this.#drive.setManualNorthSouth(enable ? 1 : 0)
	}

	moveSouth(enable: boolean) {
		this.#drive.setManualNorthSouth(enable ? -1 : 0)
	}

	moveWest(enable: boolean) {
		this.#drive.setManualWestEast(enable ? -1 : 0)
	}

	moveEast(enable: boolean) {
		this.#drive.setManualWestEast(enable ? 1 : 0)
	}

	// Queues a guide pulse of `duration` milliseconds towards `direction`.
	pulse(direction: GuideDirection, duration: number) {
		this.#guidePort.pulse(direction, duration)
	}

	// Aborts every slew, manual motion and pulse.
	stop() {
		this.#drive.stop()
	}

	// ---- Lifecycle ----

	// Connects the mount at the visible pole of its site and starts ticking. The clock catches up with
	// the wall time it spent disconnected.
	connect() {
		if (this.isConnected) return

		super.connect()

		if (!this.isConnected) return

		this.#clock.resume(this.#now())
		this.#lastTick = this.#now()
		// A power cycle leaves the drive where it was but forgets how far its rate had wandered.
		this.#tracking.forgetWalk()
		this.#drive.placeAtStartupPose()
		this.#drive.resetMeridianHourAngle()
		this.#timer = setInterval(this.#tick.bind(this), TICK_INTERVAL_MS)
	}

	// Stops every motion, suspends the clock and disconnects the mount.
	disconnect() {
		this.pauseAutomaticTicking()
		if (!this.isConnected) return
		for (const component of this.#components) component.reset()
		this.#clock.suspend(this.#now())
		super.disconnect()
	}

	// Disconnects and unregisters the mount.
	dispose() {
		this.disconnect()
		super.dispose()
	}

	// Stops the wall-clock interval while keeping the mount connected, so a test stepping it with
	// `advance` keeps exact slew boundaries.
	pauseAutomaticTicking() {
		if (!this.#timer) return
		clearInterval(this.#timer)
		this.#timer = undefined
	}

	// Notes a persisted property about to replace a live one.
	protected onPropertyLoading(actual: SimulatorProperty, persisted: SimulatorProperty) {
		this.#meridian.loading(actual, persisted)
	}

	// Loads the persisted properties while preserving the abort latch of the automatic flip.
	override async loadProperties() {
		this.#meridian.beginLoad()
		await super.loadProperties()
		this.#meridian.endLoad()
	}

	// Rebuilds what the circuits derived from the persisted values and moves an untouched startup pose to
	// the visible pole of a persisted site.
	protected onPropertiesLoaded() {
		for (const component of this.#components) component.loaded()
		this.#refreshConfigurations()
		if (!this.#drive.followSite()) this.#drive.resetMeridianHourAngle(this.#clock.utc, false)
		else this.#drive.resetMeridianHourAngle()
	}

	// ---- Simulation ----

	// Advances the wall-clock interval elapsed since the previous tick.
	#tick() {
		const now = this.#now()
		const dtSeconds = Math.max(0, (now - this.#lastTick) / 1000)
		this.#lastTick = now
		this.advance(dtSeconds)
	}

	// Advances the whole simulation by `dtSeconds`: the clock, the drive and the record of the optical
	// axis, and then the meridian policy. Called by the timer, and directly to step the simulation
	// deterministically. A non-positive or non-finite interval is a no-op, since a bad reading of the
	// clock turned into a NaN coordinate would poison the state permanently.
	advance(dtSeconds: number) {
		if (!(dtSeconds > 0) || !Number.isFinite(dtSeconds)) return

		const [startTime, endTime] = this.#clock.step(dtSeconds)
		if (!this.isConnected) return

		this.#drive.advance(dtSeconds, startTime, endTime)
		this.#periodicError.publish(this.#clock.utc, this.minimumNotifyCoordinateInterval)

		// Recorded last, so the sample reflects the end of the interval just simulated.
		this.#drive.recordArrivalBoresightAt(this.#clock.exact)
		this.#recordBoresight()

		// The automatic flip starts after the interval was accounted for, as a Busy operation of the
		// next tick rather than one consuming time that already elapsed.
		const idle = this.#tracking.enabled && !this.isParked && !this.isSlewing && !this.isHoming && !this.isParking
		if (this.#meridian.due(this.pierSide, idle)) this.#drive.startAutomaticFlip()
	}

	// ---- Couplings ----

	// Appends where the optical axis points now, after a change that moved it without the clock
	// advancing, so an exposure starting right after it sees it at once.
	#recordBoresight() {
		this.#boresight.record(this.#clock.exact, this.pierSide)
	}

	// Captures the reported hour angle before a change of frame. The published coordinate is read, which
	// a change of the index errors has not re-derived yet.
	#captureHourAngle() {
		this.#hourAngleBeforeChange = this.#drive.reportedHourAngle()
	}

	// Carries the hour angle of the meridian policy into the changed reported frame, keeping the
	// crossings accumulated before it.
	#shiftHourAngle() {
		this.#meridian.shift(normalizePI(this.#drive.reportedHourAngle() - this.#hourAngleBeforeChange))
	}

	// After a change of site: an untouched startup pose moves to the new visible pole, and otherwise the
	// meridian policy follows the new sidereal time and the optical axis is recorded where the
	// site-dependent errors now put it.
	#siteChanged() {
		if (this.#drive.followSite()) {
			this.#drive.resetMeridianHourAngle()
			return
		}

		this.#shiftHourAngle()
		this.#recordBoresight()
	}

	// After a change of alignment: the index errors sit between the axes and what the controller
	// reports, so the reported coordinate is re-derived although the telescope has not moved.
	#alignmentChanged() {
		this.#captureHourAngle()
		this.#drive.refreshReportedCoordinate()
		this.#shiftHourAngle()
		this.#recordBoresight()
	}

	// After an error family was switched: every configuration it gates is rebuilt.
	#featuresChanged() {
		this.#captureHourAngle()
		if (!this.#refreshConfigurations()) this.#shiftHourAngle()
	}

	// Rebuilds every configuration gated by an error family, returning whether withdrawing a ring-down
	// rebased the hour angle of the meridian policy. Switching a family off leaves an ideal mount rather
	// than one frozen wherever the error had carried it.
	#refreshConfigurations() {
		const enabled = this.#errors.enabled
		this.#alignment.enabled = enabled.alignment
		this.#flexure.enabled = enabled.flexure
		this.#guidePort.enabled = enabled.guiding
		this.#periodicError.refresh(enabled.periodicError)
		this.#mechanics.refresh(enabled.mechanics)
		this.#tracking.refresh(enabled.trackingRate)
		this.#wind.refresh(enabled.wind)
		const rebased = !enabled.settling && this.#drive.withdrawRingDown()
		this.#settling.refresh(enabled.settling)
		this.#drive.refreshReportedCoordinate()
		this.#recordBoresight()
		return rebased
	}
}
