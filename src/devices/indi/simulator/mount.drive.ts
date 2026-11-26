import type { EquatorialCoordinate } from '../../../astronomy/coordinates/coordinate'
import { PIOVERTWO, SIDEREAL_DRIFT_RATE } from '../../../core/constants'
import { clamp } from '../../../math/numerical/math'
import { type Angle, normalizeAngle, normalizePI, toDeg, toHour } from '../../../math/units/angle'
import { expectedPierSide, type NameAndLabel, type PierSide } from '../device'
import { findOnSwitch, makeNumberVector, makeSwitchVector, type NewNumberVector, type NewSwitchVector, type PropertyState, selectOnSwitch } from '../types'
import { type ComponentBus, SimulatorComponent } from './component'
import { MAIN_CONTROL, SLEW_RATES, SLEW_SPEED_FACTOR } from './constants'
import type { MountAlignment } from './mount.alignment'
import { advanceMechanicalAxis, clearMechanicalAxis, driveMechanicalAxis, resetMechanicalAxisMotion } from './mount.axis'
import type { MountBoresight } from './mount.boresight'
import type { MountClock } from './mount.clock'
import type { MountDriveConfig } from './mount.config'
import type { MountGuidePort } from './mount.guiding'
import type { MountMechanics } from './mount.mechanics'
import type { MountMeridianFlip } from './mount.meridianflip'
import type { MountPeriodicError } from './mount.periodic'
import type { MountSettling } from './mount.settling'
import {
	DECLINATION_SHAFT_POLE_TOLERANCE,
	declinationFromShaftAngle,
	declinationShaftAngle,
	declinationShaftFrameSign,
	isMirroredDeclinationShaftFrame,
	normalizeShaftDelta,
	retainsPoleRightAscensionFrame,
	rightAscensionFromShaftPose,
	rightAscensionShaftAngle,
	rightAscensionShaftFrameTravel,
	SHAFT_HALF_TURN_TIE_TOLERANCE,
} from './mount.shaft'
import type { MountSite } from './mount.site'
import type { MountTracking } from './mount.tracking'
import type { MountWind } from './mount.wind'
import type { AxisDirection, CoordSetMode, SlewMode } from './types'
import { applyExclusiveSwitchValues, clampDeclination } from './util'

// Drive circuit of the simulated mount: the two axes and everything that moves them. It owns the
// mechanical orientation, which is the authoritative state: tracking, slewing, manual motion and guiding
// all move it, and both the reported coordinate and the boresight derive from it. It runs goto, flip,
// sync, home and park as physical shaft motion, manual motion at the slew rate, and the free motion of
// tracking and guiding through the transmission, with the ring-down of the structure on top. Angles are
// radians; times are milliseconds on the simulated clock unless stated as seconds.
//
// The side of the pier is the physical side of the tube, not the side a coordinate would predict: it
// changes only when the mount really moves to the other side (a goto, a flip, home or park arriving
// there) or crosses a pole, and a target tracked through the meridian keeps it.

// Active home command; only FIND acquires a new physical sensor reference.
type HomeAction = 'GO' | 'FIND'

// Simulated seconds spent latching the home index after the axes reach it.
const HOME_ACQUIRE_DURATION = 0.5

// Modes of ON_COORD_SET.
const COORD_SET_MODES: readonly CoordSetMode[] = ['SLEW', 'TRACK', 'FLIP', 'SYNC']

// Circuits the drive moves and reads.
export interface MountDriveCircuits {
	readonly clock: MountClock
	readonly site: MountSite
	readonly alignment: MountAlignment
	readonly tracking: MountTracking
	readonly guidePort: MountGuidePort
	readonly mechanics: MountMechanics
	readonly settling: MountSettling
	readonly wind: MountWind
	readonly periodicError: MountPeriodicError
	readonly meridian: MountMeridianFlip
}

// Axes, slews and the motion of the mount.
export class MountDrive extends SimulatorComponent {
	readonly #onCoordSet = makeSwitchVector('', 'ON_COORD_SET', 'On Set', MAIN_CONTROL, 'OneOfMany', 'rw', ['SLEW', 'Slew', true], ['TRACK', 'Track', false], ['FLIP', 'Flip', false], ['SYNC', 'Sync', false])
	readonly #coordinate = makeNumberVector('', 'EQUATORIAL_EOD_COORD', 'Eq. Coordinates', MAIN_CONTROL, 'rw', ['RA', 'RA (hours)', 0, 0, 24, 0.1, '%10.6f'], ['DEC', 'DEC (deg)', 0, -90, 90, 0.1, '%10.6f'])
	readonly #abort = makeSwitchVector('', 'TELESCOPE_ABORT_MOTION', 'Abort', MAIN_CONTROL, 'AtMostOne', 'rw', ['ABORT', 'Abort', false])
	// INDI Home operations: FIND reacquires the sensor, SET saves this pose, GO uses the current reference.
	readonly #home = makeSwitchVector('', 'TELESCOPE_HOME', 'Home', MAIN_CONTROL, 'AtMostOne', 'rw', ['FIND', 'Find', false], ['SET', 'Set', false], ['GO', 'Go', false])
	readonly #motionNS = makeSwitchVector('', 'TELESCOPE_MOTION_NS', 'Motion N/S', MAIN_CONTROL, 'AtMostOne', 'rw', ['MOTION_NORTH', 'North', false], ['MOTION_SOUTH', 'South', false])
	readonly #motionWE = makeSwitchVector('', 'TELESCOPE_MOTION_WE', 'Motion W/E', MAIN_CONTROL, 'AtMostOne', 'rw', ['MOTION_WEST', 'West', false], ['MOTION_EAST', 'East', false])
	readonly #slewRate = makeSwitchVector('', 'TELESCOPE_SLEW_RATE', 'Slew Rate', MAIN_CONTROL, 'OneOfMany', 'rw', ...SLEW_RATES.map((rate): [string, string, boolean] => [rate.name, rate.label, false]))
	readonly #park = makeSwitchVector('', 'TELESCOPE_PARK', 'Parking', MAIN_CONTROL, 'OneOfMany', 'rw', ['PARK', 'Park', false], ['UNPARK', 'Unpark', true])
	readonly #parkOptions = makeSwitchVector('', 'TELESCOPE_PARK_OPTION', 'Park Options', MAIN_CONTROL, 'AtMostOne', 'rw', ['PARK_CURRENT', 'Current', false])
	readonly #pierSide = makeSwitchVector('', 'TELESCOPE_PIER_SIDE', 'Pier Side', MAIN_CONTROL, 'AtMostOne', 'ro', ['PIER_EAST', 'East', false], ['PIER_WEST', 'West', false])
	readonly #mountType = makeSwitchVector('', 'TELESCOPE_MOUNT_TYPE', 'Mount Type', MAIN_CONTROL, 'OneOfMany', 'ro', ['ALTAZ', 'Alt/Az', false], ['EQ_FORK', 'Fork (Eq)', false], ['EQ_GEM', 'GEM', true])

	readonly properties = [this.#onCoordSet, this.#coordinate, this.#abort, this.#home, this.#motionNS, this.#motionWE, this.#slewRate, this.#park, this.#parkOptions, this.#pierSide, this.#mountType]
	readonly transient = [this.#onCoordSet, this.#coordinate, this.#abort, this.#home, this.#motionNS, this.#motionWE, this.#park, this.#parkOptions, this.#pierSide, this.#mountType]

	// Shortest interval between two coordinate publications of continuous motion, milliseconds of
	// simulated time.
	minimumNotifyCoordinateInterval = 1000

	// True orientation of the mechanical axes.
	readonly #mechanical: EquatorialCoordinate = { rightAscension: 0, declination: PIOVERTWO }
	#notifyCoordinateLastTime = 0
	#slewMode?: SlewMode
	#slewTarget?: EquatorialCoordinate
	// Whether the active goto turns tracking on when it arrives (ON_COORD_SET TRACK).
	#slewTracks = false
	// Side committed only when the active slew arrives.
	#slewTargetPierSide?: PierSide
	// Physical speed of the active slew, radians per second.
	#slewSpeed = 0
	// Current and target physical shaft angles of the active slew, radians.
	#slewRightAscensionShaft: Angle = 0
	#slewDeclinationShaft: Angle = 0
	#slewTargetRightAscensionShaft: Angle = 0
	#slewTargetDeclinationShaft: Angle = 0
	// Prior side to record at the exact arrival instant after the dynamic errors have reached it.
	#arrivalBoresightPierSide?: PierSide
	// Mid-slew shaft sample waiting for the worm and the wind to reach its instant.
	#slewMidpointSample?: { time: number; rightAscension: Angle; declination: Angle; pierSide: PierSide }
	// Active home command, including the sensor acquisition after a FIND slew.
	#homeAction?: HomeAction
	// Acquisition time still to spend, simulated seconds.
	#homeAcquireRemaining = 0
	#manualNorthSouth: AxisDirection = 0
	#manualWestEast: AxisDirection = 0
	// Home and park: the local orientation of the RA shaft as an hour angle, the declination and the
	// side. A fixed physical RA axis follows sidereal time in celestial coordinates even with its motor
	// stopped, so both are kept on the mount rather than on the sky.
	#homeHourAngle: Angle = 0
	#homeDeclination: Angle = PIOVERTWO
	#homePierSide: PierSide = 'NEITHER'
	#parkHourAngle: Angle = 0
	#parkDeclination: Angle = PIOVERTWO
	#parkPierSide: PierSide = 'NEITHER'
	// Whether the axes still stand at the pole they power up at, untouched this session, so a change of
	// site can move that pose to the visible pole of the new site.
	#atStartupPose = false

	// `config` gives the initial slew rate; `circuits` are moved and read; `boresight` records the axis;
	// `connected` says whether the device is connected.
	constructor(
		bus: ComponentBus,
		config: MountDriveConfig,
		readonly circuits: MountDriveCircuits,
		readonly boresight: MountBoresight,
		readonly connected: () => boolean,
	) {
		super(bus)
		const rate = SLEW_RATES.some((e) => e.name === config.slewRate) ? config.slewRate : 'SPEED_2'
		selectOnSwitch(this.#slewRate, rate)
	}

	// True orientation of the mechanical axes; aliases internal state.
	get mechanical(): Readonly<EquatorialCoordinate> {
		return this.#mechanical
	}

	// Reported coordinate, radians: the mechanical orientation seen through the encoder zero offsets.
	get rightAscension(): Angle {
		return (this.#coordinate.elements.RA.value * Math.PI) / 12
	}

	get declination(): Angle {
		return (this.#coordinate.elements.DEC.value * Math.PI) / 180
	}

	// Physical side of the pier the tube is on.
	get pierSide(): PierSide {
		return this.#pierSide.elements.PIER_EAST.value ? 'EAST' : this.#pierSide.elements.PIER_WEST.value ? 'WEST' : 'NEITHER'
	}

	get isParked() {
		return this.#park.elements.PARK.value
	}

	get isParking() {
		return this.#park.state === 'Busy'
	}

	get isHoming() {
		return this.#home.state === 'Busy'
	}

	get isSlewing() {
		return this.#coordinate.state === 'Busy'
	}

	// Whether a goto, flip, home or park is moving the axes.
	get hasSlewTarget() {
		return this.#slewTarget !== undefined
	}

	// Name of the selected slew-rate preset.
	get slewRate() {
		return findOnSwitch(this.#slewRate)[0]
	}

	// Mode the next EQUATORIAL_EOD_COORD command is applied with.
	get coordSetMode(): CoordSetMode {
		return COORD_SET_MODES.find((mode) => this.#onCoordSet.elements[mode].value) ?? 'SLEW'
	}

	// Side of the pier used for the boresight of an arrival instant still being recorded.
	get arrivalBoresightPierSide() {
		return this.#arrivalBoresightPierSide
	}

	// Local sidereal time at the whole-millisecond clock, radians.
	#siderealTime() {
		return this.circuits.site.siderealTimeAt(this.circuits.clock.utc)
	}

	// Mechanical target that makes the controller report (`rightAscension`, `declination`).
	#mechanicalTarget(rightAscension: Angle, declination: Angle): EquatorialCoordinate {
		const { alignment } = this.circuits
		return { rightAscension: normalizeAngle(rightAscension - alignment.rightAscensionIndexError), declination: clampDeclination(declination - alignment.declinationIndexError) }
	}

	// Reported hour angle, radians in [-PI, PI), at `time`.
	reportedHourAngle(time: number = this.circuits.clock.utc) {
		return normalizePI(this.circuits.site.siderealTimeAt(time) - this.rightAscension)
	}

	// ---- Placement ----

	// Places the axes at the pole of the site they power up at, home and park with them, and
	// re-registers the bookkeeping. The pole is the visible one: the south celestial pole south of the
	// equator, where the north one is below the horizon.
	placeAtStartupPose() {
		const pole = this.circuits.site.hemisphere * PIOVERTWO
		this.#homeHourAngle = 0
		this.#homeDeclination = pole
		this.#homePierSide = 'NEITHER'
		this.#parkHourAngle = 0
		this.#parkDeclination = pole
		this.#parkPierSide = 'NEITHER'
		this.setMechanical(this.#siderealTime(), pole, false)
		this.setPierSide('NEITHER')
		this.absorbAccumulatedError()
		this.#atStartupPose = true
	}

	// Moves the startup pose to the visible pole when the site changed while the axes stand untouched,
	// returning whether it did.
	followSite() {
		if (!this.#atStartupPose || this.#slewTarget || this.#manualNorthSouth !== 0 || this.#manualWestEast !== 0) return false
		this.placeAtStartupPose()
		return true
	}

	// Moves the mechanical axes and republishes what derives from them, at most once per
	// `minimumNotifyCoordinateInterval` unless `force`.
	setMechanical(rightAscension: Angle, declination: Angle, notify: boolean = true, force: boolean = false) {
		const { alignment, clock } = this.circuits
		this.#mechanical.rightAscension = normalizeAngle(rightAscension)
		this.#mechanical.declination = clampDeclination(declination)
		this.#coordinate.elements.RA.value = toHour(normalizeAngle(this.#mechanical.rightAscension + alignment.rightAscensionIndexError))
		this.#coordinate.elements.DEC.value = toDeg(clampDeclination(this.#mechanical.declination + alignment.declinationIndexError))

		if (notify && (force || clock.utc - this.#notifyCoordinateLastTime >= this.minimumNotifyCoordinateInterval)) {
			this.#notifyCoordinateLastTime = clock.utc
			this.bus.notify(this.#coordinate)
		}
	}

	// Re-derives the reported coordinate without moving the axes, publishing it at once: a tracking
	// mount never moves an axis, so a throttled publication here would be lost.
	refreshReportedCoordinate() {
		this.setMechanical(this.#mechanical.rightAscension, this.#mechanical.declination, true, true)
	}

	// Publishes the coordinate now, as a driver polling its position does when a pulse ends.
	publishCoordinate() {
		this.#notifyCoordinateLastTime = this.circuits.clock.utc
		this.bus.notify(this.#coordinate)
	}

	// Publishes an explicit physical side.
	setPierSide(pierSide: PierSide) {
		if (pierSide === this.pierSide) return
		this.#pierSide.elements.PIER_EAST.value = pierSide === 'EAST'
		this.#pierSide.elements.PIER_WEST.value = pierSide === 'WEST'
		this.bus.notify(this.#pierSide)
	}

	// Re-registers the bookkeeping against the sky and drops the trajectory, as a sync does: the drift
	// of the drive, the residual of the home sensor and any ring-down are absorbed. The wander of the
	// rate and the wind survive: the drive is the same drive, and syncing does not still the air.
	absorbAccumulatedError() {
		this.circuits.settling.reset()
		this.circuits.tracking.offset = 0
		this.circuits.mechanics.clearHomeScatter()
		this.boresight.reset(this.circuits.clock.exact, this.pierSide)
	}

	// Re-registers the hour angle of the meridian policy at `time`.
	resetMeridianHourAngle(time: number = this.circuits.clock.utc, rearm: boolean = true) {
		this.circuits.meridian.rebase(this.reportedHourAngle(time), rearm)
	}

	// ---- Commands ----

	// Starts a goto to the reported coordinate, turning tracking on at arrival when `track`.
	goTo(rightAscension: Angle, declination: Angle, track: boolean = false) {
		if (!this.connected() || this.isParked) return
		const target = this.#mechanicalTarget(rightAscension, declination)
		this.#startCoordinateSlew('GOTO', target, this.#gotoPierSide(target), false)
		this.#slewTracks = track
	}

	// Side a goto target will be valid on when the axes arrive.
	//
	// The current side is kept when the target is acceptable on it at arrival: on its normal side, and
	// with a meridian limit also up to the limit past the meridian, counterweights up. Otherwise the
	// other side is taken if the target is valid there at arrival; if the target transits during a
	// would-be flip and neither route is self-consistent, the current side avoids an obsolete flip.
	#gotoPierSide(target: EquatorialCoordinate): PierSide {
		const expectedNow = expectedPierSide(target.rightAscension, target.declination, this.#siderealTime())
		if (expectedNow === 'NEITHER') return 'NEITHER'

		const current = this.pierSide
		if (current === 'NEITHER') return this.#expectedPierSideAtArrival(target, expectedNow)
		if (this.#acceptsAtArrival(target, current)) return current

		const opposite = current === 'EAST' ? 'WEST' : 'EAST'
		if (this.#expectedPierSideAtArrival(target, opposite) === opposite) return opposite
		return current
	}

	// Whether a goto to `target` on `pierSide` stays acceptable on that side when it arrives.
	#acceptsAtArrival(target: EquatorialCoordinate, pierSide: PierSide) {
		const { meridian, site, clock } = this.circuits
		if (meridian.limit <= 0) return this.#expectedPierSideAtArrival(target, pierSide) === pierSide
		const duration = this.#coordinateSlewDuration(target, pierSide)
		return meridian.accepts(pierSide, normalizePI(site.siderealTimeAt(clock.utc) + SIDEREAL_DRIFT_RATE * duration - target.rightAscension))
	}

	// Side `target` predicts at the end of the route to it on `targetPierSide`.
	#expectedPierSideAtArrival(target: EquatorialCoordinate, targetPierSide: PierSide): PierSide {
		const duration = this.#coordinateSlewDuration(target, targetPierSide)
		return expectedPierSide(target.rightAscension, target.declination, this.#siderealTime() + SIDEREAL_DRIFT_RATE * duration)
	}

	// Current shaft pose: the in-flight one of an active slew, which survives replacement, or the one of
	// the axes at rest.
	#currentShaftPose(): readonly [Angle, Angle] {
		if (this.#slewTarget !== undefined) return [this.#slewRightAscensionShaft, this.#slewDeclinationShaft]
		const pierSide = this.pierSide
		return [rightAscensionShaftAngle(pierSide, this.#mechanical.rightAscension), pierSide === 'NEITHER' ? this.#mechanical.declination : declinationShaftAngle(pierSide, this.#mechanical.declination, this.circuits.site.hemisphere)]
	}

	// Shaft travel of a route from the current pose to `target` on `targetPierSide`: the current and
	// target shaft angles. The RA shaft turns freely, so the celestial displacement and any half-turn
	// frame change are composed before choosing the nearest congruent angle. The declination shaft keeps
	// to its range between the two sides, through the pole the mount's axis points at, so it never swings
	// the tube through the other pole; a pole target is reached in the frame the shaft is already in.
	#routeTo(target: EquatorialCoordinate, targetPierSide: PierSide): readonly [Angle, Angle, Angle, Angle] {
		const [rightAscensionShaft, declinationShaft] = this.#currentShaftPose()
		const currentRightAscension = this.#slewTarget !== undefined ? rightAscensionFromShaftPose(rightAscensionShaft, declinationShaft) : this.#mechanical.rightAscension
		const frameSide = targetPierSide !== 'NEITHER' ? targetPierSide : isMirroredDeclinationShaftFrame(declinationShaft) ? 'EAST' : 'WEST'
		const targetDeclinationShaft = declinationShaftAngle(frameSide, target.declination, this.circuits.site.hemisphere)
		const frameTravel = retainsPoleRightAscensionFrame(targetPierSide, target.declination, declinationFromShaftAngle(declinationShaft)) ? 0 : rightAscensionShaftFrameTravel(declinationShaft, targetDeclinationShaft)
		const targetRightAscensionShaft = rightAscensionShaft + normalizeShaftDelta(normalizePI(target.rightAscension - currentRightAscension) + frameTravel)
		return [rightAscensionShaft, declinationShaft, targetRightAscensionShaft, targetDeclinationShaft]
	}

	// Physical duration of a route to `target` on `targetPierSide`, seconds.
	#coordinateSlewDuration(target: EquatorialCoordinate, targetPierSide: PierSide) {
		const [rightAscensionShaft, declinationShaft, targetRightAscensionShaft, targetDeclinationShaft] = this.#routeTo(target, targetPierSide)
		return Math.max(Math.abs(targetRightAscensionShaft - rightAscensionShaft), Math.abs(targetDeclinationShaft - declinationShaft)) / (this.#manualSlewSpeed() * SLEW_SPEED_FACTOR)
	}

	// Starts a forced side change while slewing to the reported coordinate, so the same coordinate ends
	// on the other side of the pier. A pole has no side and is answered Alert.
	flipTo(rightAscension: Angle, declination: Angle) {
		if (!this.connected() || this.isParked) return

		const pierSide = this.pierSide
		const target = this.#mechanicalTarget(rightAscension, declination)
		if (pierSide === 'NEITHER' || expectedPierSide(target.rightAscension, target.declination, this.#siderealTime()) === 'NEITHER') {
			if (!this.isSlewing) this.#setCoordinateState('Alert')
			return
		}

		this.#startCoordinateSlew('FLIP', target, pierSide === 'EAST' ? 'WEST' : 'EAST', false)
	}

	// Starts the automatic flip of the meridian policy to the coordinate the axes hold.
	startAutomaticFlip() {
		this.#startCoordinateSlew('FLIP', { rightAscension: this.#mechanical.rightAscension, declination: this.#mechanical.declination }, 'EAST', true)
	}

	// Gives a slew exclusive control of both axes from the current shaft pose. The in-flight mechanical
	// coordinate follows the interpolated shaft pose, so a trajectory sees the tube sweep away from and
	// back to a same-coordinate flip target.
	#startCoordinateSlew(mode: SlewMode, target: EquatorialCoordinate, targetPierSide: PierSide, automatic: boolean) {
		const [rightAscensionShaft, declinationShaft, targetRightAscensionShaft, targetDeclinationShaft] = this.#routeTo(target, targetPierSide)
		this.#clearManualMotion()
		this.circuits.guidePort.clear()
		// A ring-down a slew interrupts is absorbed into the move: nothing is owed afterwards.
		this.circuits.settling.reset()
		this.#clearSlewMotion()
		this.#homeAction = undefined
		this.#homeAcquireRemaining = 0
		this.#slewMode = mode
		this.#slewTarget = target
		this.#slewTargetPierSide = targetPierSide
		this.#slewSpeed = this.#manualSlewSpeed() * SLEW_SPEED_FACTOR
		this.#slewRightAscensionShaft = rightAscensionShaft
		this.#slewDeclinationShaft = declinationShaft
		this.#slewTargetRightAscensionShaft = targetRightAscensionShaft
		this.#slewTargetDeclinationShaft = targetDeclinationShaft
		this.#atStartupPose = false
		if (automatic) this.circuits.meridian.armed = false
		this.#setSlewing(true)
		this.#setHoming(false)
		this.#setParking(false)
	}

	// Syncs to the reported coordinate at once, without slew time.
	//
	// A real sync rewrites only the bookkeeping, but here it is also how the mount is placed at all, so
	// the axes move to where the controller reports the coordinate; the index errors carry the "bad
	// bookkeeping" as a configured quantity instead. The side of the pier stays the one the tube is
	// physically on: a sync moves no axis across the pier, so only a mount at a pole, which has no side,
	// takes the side of the coordinate.
	syncTo(rightAscension: Angle, declination: Angle) {
		if (!this.connected()) return
		const pierSide = this.pierSide
		this.#abortSlew()
		this.#refreshSlewingState()
		this.#setHoming(false)
		this.#setParking(false)
		const target = this.#mechanicalTarget(rightAscension, declination)
		// Published at once: a sync is a discontinuity, and a tracking mount would otherwise never republish it.
		this.setMechanical(target.rightAscension, target.declination, true, true)
		const derived = expectedPierSide(this.#mechanical.rightAscension, this.#mechanical.declination, this.#siderealTime())
		if (pierSide === 'NEITHER' || derived === 'NEITHER') this.setPierSide(derived)
		// A placement rather than motion through the reversal of the declination shaft frame, so no
		// loaded flank, open backlash or pending stiction is meaningful afterwards.
		if (this.pierSide !== pierSide) clearMechanicalAxis(this.circuits.mechanics.declinationAxis)
		this.#atStartupPose = false
		this.resetMeridianHourAngle()
		this.absorbAccumulatedError()
	}

	// Goes to the stored home pose without acquiring the sensor (GO), or seeks it and spends
	// HOME_ACQUIRE_DURATION acquiring the index (FIND), staying Busy through both.
	home(action: HomeAction = 'GO') {
		if (!this.connected() || this.isParked) return
		this.#startCoordinateSlew('HOME', this.#fixedTarget(this.#homeHourAngle, this.#homeDeclination, this.#homePierSide), this.#homePierSide, false)
		this.#homeAction = action
		this.#homeAcquireRemaining = 0
		this.#setHoming(true)
	}

	// Stores the current pose as home, changing neither the sensor residual nor the drift of the drive.
	setHome() {
		const pierSide = this.#storedPosePierSide()

		if (this.#homeAction !== undefined) {
			this.#abortSlew()
			this.#refreshSlewingState()
		}

		this.#homeHourAngle = normalizePI(this.#siderealTime() - this.#mechanical.rightAscension)
		this.#homeDeclination = this.#mechanical.declination
		this.#homePierSide = pierSide
		this.#setHomeState('Ok')
	}

	// Mechanical target of a pose fixed on the mount, at hour angle `hourAngle` and `declination` on
	// `pierSide`, predicted at the slew arrival. Three predictions bound the sidereal motion during it.
	#fixedTarget(hourAngle: Angle, declination: Angle, pierSide: PierSide): EquatorialCoordinate {
		const { clock, site } = this.circuits
		const start = clock.exact
		const target = { rightAscension: normalizeAngle(site.siderealTimeAt(start) - hourAngle), declination }

		for (let prediction = 0; prediction < 3; prediction++) {
			const duration = this.#coordinateSlewDuration(target, pierSide)
			target.rightAscension = normalizeAngle(site.siderealTimeAt(start + duration * 1000) - hourAngle)
		}

		return target
	}

	// Parks the mount at the stored park pose.
	park() {
		if (!this.connected() || this.isParked) return
		this.#startCoordinateSlew('PARK', this.#fixedTarget(this.#parkHourAngle, this.#parkDeclination, this.#parkPierSide), this.#parkPierSide, false)
		this.#setParking(true, false)
	}

	// Unparks the mount without moving it.
	unpark() {
		if (this.#slewMode === 'PARK') {
			this.#abortSlew()
			this.#refreshSlewingState()
		}

		if (this.isParked && selectOnSwitch(this.#park, 'UNPARK')) this.bus.notify(this.#park)
		this.#setParking(false)
	}

	// Stores the current pose as park, on the mount, and answers TELESCOPE_PARK_OPTION Ok.
	setPark() {
		this.#parkHourAngle = normalizePI(this.#siderealTime() - this.#mechanical.rightAscension)
		this.#parkDeclination = this.#mechanical.declination
		this.#parkPierSide = this.#storedPosePierSide()
		this.#parkOptions.elements.PARK_CURRENT.value = false
		this.#parkOptions.state = 'Ok'
		this.bus.notify(this.#parkOptions)
	}

	// Physical side of a pose saved now: during a slew the published side stays the origin's until
	// arrival, so the continuous declination shaft selects the branch; a shaft at a pole has no side.
	#storedPosePierSide() {
		if (!this.#slewTarget) return this.pierSide
		if (Math.abs(Math.cos(this.#slewDeclinationShaft)) <= DECLINATION_SHAFT_POLE_TOLERANCE) return 'NEITHER'
		return isMirroredDeclinationShaftFrame(this.#slewDeclinationShaft) ? 'EAST' : 'WEST'
	}

	// Selects a slew-rate preset by name.
	setSlewRate(rate: NameAndLabel | string) {
		const name = typeof rate === 'string' ? rate : rate.name
		if (!SLEW_RATES.some((entry) => entry.name === name) || this.slewRate === name) return
		if (selectOnSwitch(this.#slewRate, name)) this.bus.notify(this.#slewRate)
	}

	// Sets manual motion of declination: 1 north, -1 south, 0 stop.
	setManualNorthSouth(direction: AxisDirection) {
		if (!this.connected() || this.isParked) direction = 0
		if (this.#manualNorthSouth === direction) return
		if (direction !== 0) {
			this.#abortSlew()
			this.#atStartupPose = false
		}
		this.#manualNorthSouth = direction
		this.#publishManualMotion(this.#motionNS, direction > 0 ? 'MOTION_NORTH' : direction < 0 ? 'MOTION_SOUTH' : undefined)
		this.#refreshSlewingState()
	}

	// Sets manual motion of right ascension: 1 east, -1 west, 0 stop.
	setManualWestEast(direction: AxisDirection) {
		if (!this.connected() || this.isParked) direction = 0
		if (this.#manualWestEast === direction) return
		if (direction !== 0) {
			this.#abortSlew()
			this.#atStartupPose = false
		}
		this.#manualWestEast = direction
		this.#publishManualMotion(this.#motionWE, direction > 0 ? 'MOTION_EAST' : direction < 0 ? 'MOTION_WEST' : undefined)
		this.#refreshSlewingState()
	}

	// Aborts every slew, manual motion and pulse.
	stop() {
		this.#abortSlew()
		this.#clearManualMotion()
		this.circuits.guidePort.clear()
		this.#setSlewing(false)
		this.#setHoming(false)
		this.#setParking(false)
	}

	// Handles EQUATORIAL_EOD_COORD by the mode of ON_COORD_SET; a missing element keeps the reported one.
	handleNumber(vector: NewNumberVector) {
		if (vector.name !== this.#coordinate.name) return false

		const rightAscension = vector.elements.RA !== undefined ? (vector.elements.RA * Math.PI) / 12 : this.rightAscension
		const declination = vector.elements.DEC !== undefined ? (vector.elements.DEC * Math.PI) / 180 : this.declination
		const mode = this.coordSetMode

		if (mode === 'SYNC') this.syncTo(rightAscension, declination)
		else if (mode === 'FLIP') this.flipTo(rightAscension, declination)
		else this.goTo(rightAscension, declination, mode === 'TRACK')

		return true
	}

	// Handles ON_COORD_SET, TELESCOPE_ABORT_MOTION, TELESCOPE_HOME, TELESCOPE_MOTION_NS/WE,
	// TELESCOPE_PARK, TELESCOPE_PARK_OPTION and TELESCOPE_SLEW_RATE.
	handleSwitch(vector: NewSwitchVector) {
		const { elements } = vector

		switch (vector.name) {
			case this.#onCoordSet.name:
				if (applyExclusiveSwitchValues(this.#onCoordSet, elements)) this.bus.notify(this.#onCoordSet)
				return true
			case this.#abort.name:
				if (elements.ABORT === true) {
					this.stop()
					this.#abort.elements.ABORT.value = false
					this.#abort.state = 'Ok'
					this.bus.notify(this.#abort)
				}
				return true
			case this.#home.name:
				if (elements.FIND === true) this.home('FIND')
				else if (elements.SET === true) this.setHome()
				else if (elements.GO === true) this.home('GO')
				return true
			case this.#motionNS.name:
				this.setManualNorthSouth(elements.MOTION_NORTH === true ? 1 : elements.MOTION_SOUTH === true ? -1 : 0)
				return true
			case this.#motionWE.name:
				this.setManualWestEast(elements.MOTION_WEST === true ? -1 : elements.MOTION_EAST === true ? 1 : 0)
				return true
			case this.#park.name:
				if (elements.PARK === true) this.park()
				else if (elements.UNPARK === true) this.unpark()
				return true
			case this.#parkOptions.name:
				if (elements.PARK_CURRENT === true) this.setPark()
				return true
			case this.#slewRate.name: {
				const rate = Object.keys(elements).find((key) => elements[key] === true)
				if (rate !== undefined) this.setSlewRate(rate)
				return true
			}
		}

		return false
	}

	// Stops every motion when the device disconnects.
	reset() {
		this.stop()
		this.circuits.tracking.setEnabled(false)
	}

	// ---- Simulation step ----

	// Advances the motion over the step [`startTime`, `endTime`] of `dtSeconds`.
	//
	// A slew reports how much of the step was left once it arrived, and everything that is not the slew
	// itself — home acquisition, guiding, the wind and a ring-down excited by the arrival — is then walked
	// over exactly that remainder, so a resonance of a few hertz is neither shifted nor swallowed.
	advance(dtSeconds: number, startTime: number, endTime: number) {
		const { periodicError, wind, tracking, guidePort, meridian } = this.circuits
		tracking.advance(dtSeconds)
		let settlingSeconds = dtSeconds

		if (this.#slewTarget) {
			// The worm follows the axis, read before the move since arriving clears the target, and is
			// charged only for the part of the step the axis spent travelling.
			const slewRate = this.#rightAscensionMotorRate()
			settlingSeconds = this.#advanceSlew(dtSeconds, endTime)
			const slewSeconds = dtSeconds - settlingSeconds
			const midpoint = this.#slewMidpointSample

			if (midpoint && slewSeconds > 0) {
				const midpointSeconds = clamp((midpoint.time - startTime) / 1000, 0, slewSeconds)
				periodicError.advance(slewRate, midpointSeconds)
				wind.advance(midpointSeconds)
				const finalRightAscension = this.#mechanical.rightAscension
				const finalDeclination = this.#mechanical.declination
				this.setMechanical(midpoint.rightAscension, midpoint.declination, false)
				this.boresight.record(midpoint.time, midpoint.pierSide)
				this.setMechanical(finalRightAscension, finalDeclination, false)
				periodicError.advance(slewRate, slewSeconds - midpointSeconds)
				wind.advance(slewSeconds - midpointSeconds)
			} else {
				periodicError.advance(slewRate, slewSeconds)
				wind.advance(slewSeconds)
			}

			this.#slewMidpointSample = undefined

			// The arrival is an instant inside the step, and the trajectory has to say so.
			if (settlingSeconds > 0) {
				const arrivalTime = endTime - settlingSeconds * 1000
				this.recordArrivalBoresightAt(arrivalTime)
				this.boresight.record(arrivalTime, this.pierSide)
			}
		}

		let freeStartTime = endTime - settlingSeconds * 1000
		if (this.#homeAcquireRemaining > 0) freeStartTime = this.#advanceHomeAcquire(freeStartTime, endTime)
		if (freeStartTime < endTime) this.#advanceGuidedMotion(freeStartTime, endTime)

		// Retired only after the interval was accounted for, so the tail of a pulse is never lost.
		guidePort.retire(endTime)

		// Tracking on the west side stops at the meridian limit, as a real mount protects its pier.
		if (meridian.exceeded(this.pierSide) && tracking.enabled && !this.#slewTarget) {
			tracking.setEnabled(false)
			this.#setCoordinateState('Alert')
		}
	}

	// Records the old side of an instantaneous side change at `time`, after the dynamic errors reached it,
	// without moving the published side backwards.
	recordArrivalBoresightAt(time: number) {
		if (this.#arrivalBoresightPierSide === undefined) return
		this.boresight.record(time, this.#arrivalBoresightPierSide)
		this.#arrivalBoresightPierSide = undefined
	}

	// Holds the motors at home while the sensor latches, returning the first free-motion time. The
	// celestial RA drifts with the sky while the stopped worm stays still.
	#advanceHomeAcquire(startTime: number, endTime: number) {
		// An arrival at the end of the step has no acquisition interval yet.
		if (startTime >= endTime) return endTime
		const { wind, settling, tracking, mechanics } = this.circuits
		const duration = Math.min(this.#homeAcquireRemaining, (endTime - startTime) / 1000)
		const acquisitionTime = startTime + duration * 1000
		const steps = settling.steps(duration)

		for (let step = 1; step <= steps; step++) {
			const stepSeconds = duration / steps
			const stepTime = startTime + ((acquisitionTime - startTime) * step) / steps
			wind.advance(stepSeconds)
			const priorPierSide = this.pierSide
			this.setMechanical(this.#mechanical.rightAscension + SIDEREAL_DRIFT_RATE * stepSeconds, this.#mechanical.declination)
			this.reconcilePierSideAfterPoleMotion(priorPierSide, 0, stepTime)
			this.#advanceRingDown(stepSeconds, stepTime)
			this.boresight.record(stepTime, this.pierSide)
		}

		this.#homeAcquireRemaining -= duration
		if (this.#homeAcquireRemaining <= 1e-12) this.#homeAcquireRemaining = 0

		if (this.#homeAcquireRemaining === 0) {
			tracking.offset = 0
			mechanics.scatterHome()
			this.#homeAction = undefined
			this.#setHomeState('Ok')
			this.boresight.record(acquisitionTime, this.pierSide)
		}

		return acquisitionTime
	}

	// Rate of the right-ascension motor, radians per second of its contribution to the coordinate:
	// negative while tracking, zero when stopped, the slew rate minus the sky during a slew.
	#rightAscensionMotorRate() {
		if (this.#slewTarget) return this.#slewAxisRates()[0] - SIDEREAL_DRIFT_RATE
		let rate = this.circuits.tracking.motorRate
		if (this.#manualWestEast !== 0) rate += this.#manualWestEast * this.#manualSlewSpeed()
		return rate + this.circuits.guidePort.rateWestEast
	}

	// Signed rates of both shafts during a slew, radians per second: normalized by the larger travel, so
	// neither exceeds the slew speed and both arrive together.
	#slewAxisRates(): readonly [number, number] {
		if (!this.#slewTarget) return [0, 0]
		const rightAscensionDelta = this.#slewTargetRightAscensionShaft - this.#slewRightAscensionShaft
		const declinationDelta = this.#slewTargetDeclinationShaft - this.#slewDeclinationShaft
		const span = Math.max(Math.abs(rightAscensionDelta), Math.abs(declinationDelta))
		if (span === 0) return [0, 0]
		const scale = this.#slewSpeed / span
		return [rightAscensionDelta * scale, declinationDelta * scale]
	}

	// Moves the axes along the slew, returning the seconds of the step left once it arrived, zero while
	// it runs. `endTime` registers the arrival at its exact instant.
	#advanceSlew(dtSeconds: number, endTime: number) {
		const target = this.#slewTarget
		if (!target) return dtSeconds
		this.#slewMidpointSample = undefined

		const { mechanics, settling, tracking } = this.circuits
		const speed = this.#slewSpeed
		const maxStep = speed * dtSeconds
		const initialRightAscensionShaft = this.#slewRightAscensionShaft
		const initialDeclinationShaft = this.#slewDeclinationShaft
		const rightAscensionMotorDelta = this.#slewTargetRightAscensionShaft - this.#slewRightAscensionShaft
		const declinationMotorDelta = this.#slewTargetDeclinationShaft - this.#slewDeclinationShaft
		const span = Math.max(Math.abs(rightAscensionMotorDelta), Math.abs(declinationMotorDelta))

		// A slew drives the axes directly, but its travel is reported to the transmission, which leaves the
		// slack taken up on the flank it ran on: continuing is immediate, reversing costs the backlash.
		// Reported before the arrival branch, which a goto shorter than a step goes through.
		const travelled = span > 0 ? Math.min(1, maxStep / span) : 0
		const slewSeconds = span > 0 && speed > 0 ? Math.min(dtSeconds, span / speed) : 0
		const rightAscensionMotorTravel = rightAscensionMotorDelta * travelled - SIDEREAL_DRIFT_RATE * slewSeconds
		const declinationMotorTravel = declinationMotorDelta * travelled
		driveMechanicalAxis(mechanics.rightAscensionAxis, Math.sign(rightAscensionMotorTravel) as AxisDirection, Math.abs(rightAscensionMotorTravel), mechanics.rightAscensionTransmission)
		driveMechanicalAxis(mechanics.declinationAxis, Math.sign(declinationMotorTravel) as AxisDirection, Math.abs(declinationMotorTravel), mechanics.declinationTransmission)
		this.#slewRightAscensionShaft += rightAscensionMotorDelta * travelled
		this.#slewDeclinationShaft += declinationMotorDelta * travelled

		if (span <= maxStep + SHAFT_HALF_TURN_TIE_TOLERANCE || span === 0) {
			// A half-turn reconstructed as current+PI can measure one ulp longer than PI; that leftover is
			// snapped here rather than leaving the slew Busy or running the clock backwards.
			const remaining = span === 0 ? dtSeconds : maxStep > 0 && span <= maxStep ? dtSeconds * (1 - span / maxStep) : 0
			const priorPierSide = this.pierSide

			if (span > 0 && slewSeconds > 0) {
				const sampleRightAscensionShaft = initialRightAscensionShaft + rightAscensionMotorDelta * travelled * 0.5
				const sampleDeclinationShaft = initialDeclinationShaft + declinationMotorDelta * travelled * 0.5
				this.#slewMidpointSample = { time: endTime - (remaining + slewSeconds / 2) * 1000, rightAscension: rightAscensionFromShaftPose(sampleRightAscensionShaft, sampleDeclinationShaft, initialDeclinationShaft), declination: declinationFromShaftAngle(sampleDeclinationShaft), pierSide: priorPierSide }
			}

			this.setMechanical(target.rightAscension, target.declination)
			// The side was chosen before the slew began, so the old one holds through the half-turn and the
			// new one is committed only now.
			const targetPierSide = this.#slewTargetPierSide ?? priorPierSide
			const arrivalBoresightPierSide = targetPierSide !== priorPierSide ? priorPierSide : undefined
			this.setPierSide(targetPierSide)
			if (priorPierSide !== 'NEITHER' && this.pierSide === 'NEITHER') clearMechanicalAxis(mechanics.declinationAxis)
			// The axes stop, so static friction has to be overcome again before tracking moves them.
			resetMechanicalAxisMotion(mechanics.rightAscensionAxis)
			resetMechanicalAxisMotion(mechanics.declinationAxis)

			// Arriving is abrupt, so the structure rings, harder after a faster slew, each axis by its own
			// signed share of the motion: an overshoot carries on in the direction of travel.
			if (span > 0) {
				const severity = speed / (SLEW_SPEED_FACTOR * (SLEW_RATES.at(-1)?.speed ?? 1))
				const rightAscensionShare = clamp(rightAscensionMotorDelta / span, -1, 1)
				const declinationSide = this.pierSide === 'NEITHER' ? priorPierSide : this.pierSide
				const declinationShare = clamp((declinationMotorDelta * declinationShaftFrameSign(declinationSide)) / span, -1, 1)
				settling.excite(severity * rightAscensionShare, severity * declinationShare)
			}

			const mode = this.#slewMode
			const tracks = this.#slewTracks
			this.resetMeridianHourAngle(endTime - remaining * 1000)
			this.#slewMode = undefined
			this.#slewTarget = undefined
			this.#clearSlewMotion()
			this.#arrivalBoresightPierSide = arrivalBoresightPierSide
			this.#setSlewing(false)

			if (mode === 'HOME' && this.#homeAction === 'GO') {
				this.#homeAction = undefined
				this.#setHomeState('Ok')
			} else if (mode === 'HOME' && this.#homeAction === 'FIND') {
				this.#homeAcquireRemaining = HOME_ACQUIRE_DURATION
			} else {
				this.#setHoming(false)
			}

			if (mode === 'PARK') {
				this.#setParking(false, true)
				tracking.setEnabled(false)
			} else {
				this.#setParking(false)
				if (tracks) tracking.setEnabled(true)
			}

			return remaining
		}

		this.setMechanical(rightAscensionFromShaftPose(this.#slewRightAscensionShaft, this.#slewDeclinationShaft, initialDeclinationShaft), declinationFromShaftAngle(this.#slewDeclinationShaft))
		return 0
	}

	// Advances what the mount does when it is not slewing over [`startTime`, `endTime`], cut at every
	// instant a pulse starts or ends so each piece runs at the guiding in force across it: backlash and
	// stiction depend on the order of the commands, which a single net rate would lose. Each piece is
	// walked in sub-steps fast enough for a ring-down and recorded at every one.
	#advanceGuidedMotion(startTime: number, endTime: number) {
		const { guidePort, periodicError, wind, settling } = this.circuits
		let from = startTime

		while (from < endTime) {
			const to = guidePort.boundary(from, endTime)
			guidePort.integrate(from, to)
			const dtSeconds = (to - from) / 1000
			const steps = settling.steps(dtSeconds)
			const stepSeconds = dtSeconds / steps
			const stepMilliseconds = (to - from) / steps

			for (let step = 1; step <= steps; step++) {
				periodicError.advance(this.#rightAscensionMotorRate(), stepSeconds)
				wind.advance(stepSeconds)
				const stepTime = from + stepMilliseconds * step
				this.#advanceFreeMotion(stepSeconds, stepTime)
				this.#advanceRingDown(stepSeconds, stepTime)
				this.boresight.record(stepTime, this.pierSide)
			}

			from = to
		}
	}

	// Advances both oscillators over `dtSeconds` and moves the axes by however much of their excursion
	// is not already in the coordinate. Measured against what the coordinate received, since the
	// declination is clamped at the poles and only motion that happened is owed back.
	#advanceRingDown(dtSeconds: number, time: number) {
		const { settling, meridian } = this.circuits
		settling.advance(dtSeconds)

		const rightAscensionRing = settling.rightAscension.offset - settling.appliedRightAscension
		const declinationRing = settling.declination.offset - settling.appliedDeclination
		if (rightAscensionRing === 0 && declinationRing === 0) return

		const rightAscension = this.#mechanical.rightAscension
		const declination = this.#mechanical.declination
		const priorPierSide = this.pierSide
		this.setMechanical(rightAscension + rightAscensionRing, declination + declinationRing)
		const appliedRightAscension = normalizePI(this.#mechanical.rightAscension - rightAscension)
		meridian.advance(-appliedRightAscension)
		settling.appliedRightAscension += appliedRightAscension
		const appliedDeclination = this.#mechanical.declination - declination
		settling.appliedDeclination += appliedDeclination
		this.reconcilePierSideAfterPoleMotion(priorPierSide, appliedDeclination, time)
	}

	// Takes the excursion of a ring-down back out of the coordinate when settling is switched off,
	// returning whether that rebased the hour angle of the meridian policy.
	withdrawRingDown() {
		const { settling, clock } = this.circuits
		let rebased = false

		if (settling.appliedRightAscension !== 0 || settling.appliedDeclination !== 0) {
			const priorPierSide = this.pierSide
			const declinationStep = -settling.appliedDeclination
			this.setMechanical(this.#mechanical.rightAscension - settling.appliedRightAscension, this.#mechanical.declination - settling.appliedDeclination)
			rebased = this.reconcilePierSideAfterPoleMotion(priorPierSide, declinationStep, clock.exact)
		}

		settling.reset()
		return rebased
	}

	// Advances tracking, manual motion and guiding. The motors go through the transmission and the sky's
	// turn is added afterwards: with the motors stopped the coordinate drifts east, and a mount tracking
	// perfectly is one whose motor cancels that drift.
	#advanceFreeMotion(dtSeconds: number, time: number) {
		const { mechanics, guidePort, tracking, meridian } = this.circuits
		const rightAscensionMotorRate = this.#rightAscensionMotorRate()
		const priorPierSide = this.pierSide
		let declinationRate = guidePort.rateNorthSouth
		if (this.#manualNorthSouth !== 0) declinationRate += this.#manualNorthSouth * this.#manualSlewSpeed()

		const frameSign = declinationShaftFrameSign(this.pierSide)
		const rightAscensionStep = advanceMechanicalAxis(mechanics.rightAscensionAxis, rightAscensionMotorRate, dtSeconds, mechanics.rightAscensionTransmission)
		const declinationStep = advanceMechanicalAxis(mechanics.declinationAxis, declinationRate * frameSign, dtSeconds, mechanics.declinationTransmission) * frameSign
		const rightAscensionDelta = SIDEREAL_DRIFT_RATE * dtSeconds + rightAscensionStep
		meridian.advance(-rightAscensionStep)
		tracking.accrue(rightAscensionStep)

		if (rightAscensionDelta !== 0 || declinationStep !== 0) {
			this.setMechanical(this.#mechanical.rightAscension + rightAscensionDelta, this.#mechanical.declination + declinationStep)
			this.reconcilePierSideAfterPoleMotion(priorPierSide, declinationStep, time)
		}
	}

	// Reconciles the side for motion into or out of a pole after a step of `declinationStep` that
	// reached the current coordinate at `time`. A pole has no side, so entering it clears the
	// side-specific declination transmission; leaving it establishes a side. Returns whether leaving
	// rebased the hour angle of the meridian policy.
	reconcilePierSideAfterPoleMotion(priorPierSide: PierSide, declinationStep: Angle, time: number) {
		const { site, mechanics } = this.circuits
		const pierSide = expectedPierSide(this.#mechanical.rightAscension, this.#mechanical.declination, site.siderealTimeAt(time))
		if (priorPierSide !== 'NEITHER' && pierSide !== 'NEITHER') return false

		this.setPierSide(pierSide)
		let rebased = false

		if (priorPierSide === 'NEITHER' && pierSide !== 'NEITHER') {
			this.resetMeridianHourAngle(time)
			rebased = true
		}

		if (priorPierSide === 'NEITHER' && pierSide === 'EAST' && declinationStep !== 0) {
			// The pole-neutral step was integrated in the WEST shaft frame; EAST mirrors it.
			clearMechanicalAxis(mechanics.declinationAxis)
			driveMechanicalAxis(mechanics.declinationAxis, Math.sign(-declinationStep) as AxisDirection, Math.abs(declinationStep), mechanics.declinationTransmission)
		} else if (priorPierSide !== 'NEITHER' && pierSide === 'NEITHER') {
			clearMechanicalAxis(mechanics.declinationAxis)
		}

		return rebased
	}

	// ---- State ----

	// Speed of the selected slew preset, radians per second.
	#manualSlewSpeed() {
		return SLEW_RATES.find((entry) => entry.name === this.slewRate)?.speed ?? SLEW_RATES[3].speed
	}

	// Publishes the manual motion of an axis: its direction switch, Busy while it moves.
	#publishManualMotion(vector: ReturnType<typeof makeSwitchVector>, direction: string | undefined) {
		for (const name in vector.elements) vector.elements[name].value = name === direction
		vector.state = direction === undefined ? 'Idle' : 'Busy'
		this.bus.notify(vector)
	}

	// Clears manual motion of both axes.
	#clearManualMotion() {
		this.setManualNorthSouth(0)
		this.setManualWestEast(0)
	}

	// Clears the travel, speed and arrival record of a superseded or completed slew, keeping the side.
	#clearSlewMotion() {
		this.#slewTracks = false
		this.#slewTargetPierSide = undefined
		this.#slewSpeed = 0
		this.#slewRightAscensionShaft = 0
		this.#slewDeclinationShaft = 0
		this.#slewTargetRightAscensionShaft = 0
		this.#slewTargetDeclinationShaft = 0
		this.#arrivalBoresightPierSide = undefined
	}

	// Cancels any goto, flip, home or park without committing a pending side change.
	#abortSlew() {
		const hadSlew = this.#slewTarget !== undefined
		this.#slewMode = undefined
		this.#slewTarget = undefined
		this.#homeAction = undefined
		this.#homeAcquireRemaining = 0
		this.#clearSlewMotion()
		if (hadSlew) this.resetMeridianHourAngle(this.circuits.clock.exact, false)
		this.#setHoming(false)
		this.#setParking(false)
	}

	// Publishes the coordinate Busy while any slew or manual motion runs, Idle otherwise.
	#refreshSlewingState() {
		this.#setSlewing(this.#slewTarget !== undefined || this.#manualNorthSouth !== 0 || this.#manualWestEast !== 0)
	}

	#setSlewing(value: boolean) {
		this.#setCoordinateState(value ? 'Busy' : 'Idle')
	}

	// Publishes the state of the coordinate, Alert for a rejected command.
	#setCoordinateState(state: PropertyState) {
		if (this.#coordinate.state === state) return
		this.#coordinate.state = state
		this.bus.notify(this.#coordinate)
	}

	#setHoming(value: boolean) {
		this.#setHomeState(value ? 'Busy' : 'Idle')
	}

	// Publishes the state of the home command.
	#setHomeState(state: PropertyState) {
		if (this.#home.state === state) return
		this.#home.state = state
		this.bus.notify(this.#home)
	}

	// Publishes parking (Busy while moving to park) and, when given, parked.
	#setParking(parking: boolean, parked?: boolean) {
		let updated = false

		if (this.isParking !== parking) {
			this.#park.state = parking ? 'Busy' : 'Idle'
			updated = true
		}

		if (parked !== undefined && this.isParked !== parked) updated = selectOnSwitch(this.#park, parked ? 'PARK' : 'UNPARK')
		if (updated) this.bus.notify(this.#park)
	}
}
