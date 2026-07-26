import type { EquatorialCoordinate } from '../../../astronomy/coordinates/coordinate'
import { applyEquatorialPointingError, type EquatorialPointingModel, IDENTITY_EQUATORIAL_POINTING_MODEL, MAX_POINTING_DECLINATION, polarAlignmentPointingModel, tubeFlexureError } from '../../../astronomy/coordinates/pointing'
import { localSiderealTime } from '../../../astronomy/observer/location'
import { formatTemporal, TIMEZONE } from '../../../astronomy/time/temporal'
import { timeUnix } from '../../../astronomy/time/time'
import { ASEC2RAD, DAYSEC, PIOVERTWO, TAU } from '../../../core/constants'
import { clamp } from '../../../math/numerical/math'
import { mulberry32, normal } from '../../../math/numerical/random'
import { type Angle, deg, hour, normalizeAngle, normalizePI, toDeg, toHour } from '../../../math/units/angle'
import { meter } from '../../../math/units/distance'
import { handleDefNumberVector, type IndiClientHandler } from '../client'
import { DeviceInterfaceType, expectedPierSide, type GuideDirection, type NameAndLabel, type PierSide, type TrackMode, type UTCTime } from '../device'
import { findOnSwitch, makeNumberVector, makeSwitchVector, makeTextVector, type NewNumberVector, type NewSwitchVector, type NewTextVector, selectOnSwitch } from '../types'
import type { ClientSimulator } from './client'
import { GUIDE_JITTER_SEED, KING_DRIFT_RATE, LUNAR_DRIFT_RATE, MAIN_CONTROL, MAX_GUIDE_RATE, MAX_QUEUED_GUIDE_PULSES, MOUNT_TRAJECTORY_CAPACITY, SIDEREAL_DRIFT_RATE, SIMULATION, SLEW_RATES, SLEW_SPEED_FACTOR, SOLAR_DRIFT_RATE, TICK_INTERVAL_MS } from './constants'
import { DeviceSimulator } from './device'
import { advanceMechanicalAxis, clearMechanicalAxis, driveMechanicalAxis, IDENTITY_MECHANICAL_AXIS_CONFIG, type MechanicalAxisConfig, mechanicalAxisState, resetMechanicalAxisMotion } from './mount.axis'
import { type GuidePulse, type GuideResponseConfig, IDENTITY_GUIDE_RESPONSE_CONFIG, integrateGuidePulses, quantizeGuideDuration, retireGuidePulses } from './mount.guiding'
import { IDENTITY_PERIODIC_ERROR_CURVE, PERIODIC_ERROR_HARMONICS, periodicErrorAt, periodicErrorBound, type PeriodicErrorCurve, trainPeriodicErrorCorrection } from './mount.periodic'
import { advanceSettling, exciteSettling, IDENTITY_SETTLING_CONFIG, resetSettling, type SettlingConfig, settlingState } from './mount.settling'
import { advanceTrackingRateError, IDENTITY_TRACKING_RATE_ERROR_CONFIG, resetTrackingRateError, TRACKING_RATE_CALIBRATION_TEMPERATURE, type TrackingRateErrorConfig, trackingRateErrorState } from './mount.tracking'
import { boresightHistory, boresightPathLength, clearBoresightHistory, recordBoresightSample, sampleBoresightPath, sampleBoresightTrajectory } from './mount.trajectory'
import { advanceWind, IDENTITY_WIND_CONFIG, resetWind, type WindConfig, windState } from './mount.wind'
import type { AxisDirection, CoordSetMode, DeviceSimulatorOptions, MountPointingState, SimulatorProperty, SlewMode } from './types'
import { applyMultiSwitchValues, applyNumberVectorValues, clampDeclination } from './util'

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
	readonly #time = makeTextVector('', 'TIME_UTC', 'UTC', MAIN_CONTROL, 'rw', ['UTC', 'UTC Time', formatTemporal(Date.now(), 'YYYY-MM-DDTHH:mm:ss.SSSZ')], ['OFFSET', 'UTC Offset', (TIMEZONE / 60).toFixed(2)])
	readonly #geographicCoordinate = makeNumberVector('', 'GEOGRAPHIC_COORD', 'Location', MAIN_CONTROL, 'rw', ['LAT', 'Latitude (deg)', 0, -90, 90, 0.1, '%12.8f'], ['LONG', 'Longitude (deg)', 0, 0, 360, 0.1, '%12.8f'], ['ELEV', 'Elevation (m)', 0, -200, 10000, 1, '%.1f'])
	readonly #park = makeSwitchVector('', 'TELESCOPE_PARK', 'Parking', MAIN_CONTROL, 'OneOfMany', 'rw', ['PARK', 'Park', false], ['UNPARK', 'Unpark', true])
	readonly #parkOptions = makeSwitchVector('', 'TELESCOPE_PARK_OPTION', 'Park Options', MAIN_CONTROL, 'AtMostOne', 'rw', ['PARK_CURRENT', 'Current', false])
	readonly #pierSide = makeSwitchVector('', 'TELESCOPE_PIER_SIDE', 'Pier Side', MAIN_CONTROL, 'AtMostOne', 'ro', ['PIER_EAST', 'East', false], ['PIER_WEST', 'West', false])
	readonly #guideRate = makeNumberVector('', 'GUIDE_RATE', 'Guiding Rate', MAIN_CONTROL, 'rw', ['GUIDE_RATE_WE', 'W/E Rate', 0.5, 0, 1, 0.1, '%.8f'], ['GUIDE_RATE_NS', 'N/E Rate', 0.5, 0, 1, 0.1, '%.0f'])
	readonly #guideNS = makeNumberVector('', 'TELESCOPE_TIMED_GUIDE_NS', 'Guide N/S', MAIN_CONTROL, 'rw', ['TIMED_GUIDE_N', 'North (ms)', 0, 0, 60000, 1, '%.0f'], ['TIMED_GUIDE_S', 'South (ms)', 0, 0, 60000, 1, '%.0f'])
	readonly #guideWE = makeNumberVector('', 'TELESCOPE_TIMED_GUIDE_WE', 'Guide W/E', MAIN_CONTROL, 'rw', ['TIMED_GUIDE_W', 'West (ms)', 0, 0, 60000, 1, '%.0f'], ['TIMED_GUIDE_E', 'East (ms)', 0, 0, 60000, 1, '%.0f'])
	// oxfmt-ignore
	readonly #errorFeatures = makeSwitchVector('', 'SIMULATOR_ERROR_FEATURES', 'Error Features', SIMULATION, 'AnyOfMany', 'rw', ['ALIGNMENT', 'Alignment', false], ['PERIODIC_ERROR', 'Periodic Error', false], ['MECHANICS', 'Mechanics', false], ['GUIDING', 'Guiding', false], ['SETTLING', 'Settling', false], ['FLEXURE', 'Flexure', false], ['WIND', 'Wind', false], ['TRACKING_RATE', 'Tracking Rate', false])
	// Geometric imperfections of the mount, all signed arcseconds. The polar-axis range spans ten
	// degrees, far beyond any usable alignment, so gross misalignment can be exercised.
	// Two groups that act in different places. The polar-axis, cone and non-perpendicularity errors are
	// optical geometry: they move the boresight away from where the axes mechanically point. The index
	// errors are encoder zero offsets: they do not move the telescope at all, they change what the
	// controller reports about it. Together they are the six basic TPoint terms, MA, ME, CH, NP, IH and ID.
	// oxfmt-ignore
	readonly #alignment = makeNumberVector('', 'MOUNT_ALIGNMENT', 'Alignment', SIMULATION, 'rw', ['POLAR_AZIMUTH_ERROR', 'Polar Azimuth Error (arcsec)', 120, -36000, 36000, 0.1, '%.3f'], ['POLAR_ALTITUDE_ERROR', 'Polar Altitude Error (arcsec)', 120, -36000, 36000, 0.1, '%.3f'], ['CONE_ERROR', 'Cone Error (arcsec)', 60, -3600, 3600, 0.1, '%.3f'], ['AXIS_NON_ORTHOGONALITY', 'Axis Non-orthogonality (arcsec)', 30, -3600, 3600, 0.1, '%.3f'], ['RA_INDEX_ERROR', 'RA Index Error (arcsec)', 120, -3600, 3600, 0.1, '%.3f'], ['DEC_INDEX_ERROR', 'DEC Index Error (arcsec)', 120, -3600, 3600, 0.1, '%.3f'])
	// Periodic error of the right-ascension worm: the time it takes to complete one revolution while
	// tracking at the sidereal rate, in seconds, and the harmonic content of the resulting error, as a
	// semi-amplitude in arcseconds and a phase in degrees per order. Order 1 turns once per worm
	// revolution, order 2 twice and order 3 three times; a real curve is lumpy because the wheel teeth
	// and the gears driving the worm add to its own eccentricity. A zero period disables the whole term.
	// There is deliberately no declination counterpart. Classic periodic error comes from the worm of
	// the axis that turns continuously, which during tracking is only right ascension; the declination
	// axis stands still and moves only for corrections, dithers and slews, so what dominates there is
	// backlash and stiction, not a periodic term.
	// oxfmt-ignore
	readonly #periodicError = makeNumberVector('', 'MOUNT_PERIODIC_ERROR', 'Periodic Error', SIMULATION, 'rw', ['RA_PERIOD', 'Worm Period (s)', 480, 0, DAYSEC, 1, '%.0f'], ['RA_AMPLITUDE', 'Amplitude (arcsec)', 7.5, 0, 3600, 0.1, '%.3f'], ['RA_PHASE', 'Phase (deg)', 0, 0, 360, 1, '%.1f'], ['RA_AMPLITUDE_2', '2nd Harmonic (arcsec)', 2.5, 0, 3600, 0.1, '%.3f'], ['RA_PHASE_2', '2nd Harmonic Phase (deg)', 60, 0, 360, 1, '%.1f'], ['RA_AMPLITUDE_3', '3rd Harmonic (arcsec)', 1, 0, 3600, 0.1, '%.3f'], ['RA_PHASE_3', '3rd Harmonic Phase (deg)', 210, 0, 360, 1, '%.1f'])
	// Periodic error correction the controller plays back. SAMPLES is the length of the recorded table
	// over one worm revolution and GAIN how much of the error the recording captured; zero samples means
	// an untrained mount. A short table cannot represent the higher harmonics, so they survive playback,
	// which is why a trained mount still shows residual error.
	// oxfmt-ignore
	readonly #periodicErrorCorrection = makeNumberVector('', 'MOUNT_PEC', 'PEC', SIMULATION, 'rw', ['SAMPLES', 'Recorded Samples', 0, 0, 1024, 1, '%.0f'], ['GAIN', 'Playback Gain', 1, 0, 1, 0.01, '%.3f'])
	// Live phase of the right-ascension worm, in degrees. Read-only: it is integrated from the motion of
	// the axis, not from the clock, so it stands still while the mount is parked and speeds up during a slew.
	readonly #wormPhaseVector = makeNumberVector('', 'MOUNT_WORM_PHASE', 'Worm Phase', SIMULATION, 'ro', ['PHASE', 'Phase (deg)', 0, 0, 360, 0.1, '%.3f'])
	// Imperfections of the transmission between motor and axis, per axis and in arcseconds. Backlash is
	// the slack a reversal has to run through; stiction is the motor travel a stopped axis needs before
	// it breaks free. Declination is normally the worse of the two, since that axis spends most of its
	// time stopped and reverses on every dither.
	// oxfmt-ignore
	readonly #mechanics = makeNumberVector('', 'MOUNT_MECHANICS', 'Mechanics', SIMULATION, 'rw', ['BACKLASH_RA', 'RA Backlash (arcsec)', 30, 0, 3600, 0.1, '%.3f'], ['BACKLASH_DEC', 'DEC Backlash (arcsec)', 60, 0, 3600, 0.1, '%.3f'], ['TAKE_UP_RATE', 'Backlash Take-up Rate', 0.7, 0.01, 1, 0.01, '%.3f'], ['STICTION_RA', 'RA Stiction (arcsec)', 1, 0, 60, 0.01, '%.3f'], ['STICTION_DEC', 'DEC Stiction (arcsec)', 2, 0, 60, 0.01, '%.3f'], ['HOME_SCATTER', 'Home Repeatability (arcsec)', 20, 0, 600, 0.1, '%.3f'])
	// Fidelity of the guide-pulse path between the command and the motor: how late it starts, how much
	// of the requested duration survives, and how the real rate compares to the configured one in each
	// direction. Unlike the other families this one is not an error but a degree of realism, so the
	// feature being off means a perfect controller rather than an absent one.
	// oxfmt-ignore
	readonly #guiding = makeNumberVector('', 'MOUNT_GUIDING', 'Guiding', SIMULATION, 'rw', ['LATENCY', 'Latency (ms)', 250, 0, 5000, 1, '%.0f'], ['LATENCY_JITTER', 'Latency Jitter (ms)', 50, 0, 1000, 1, '%.0f'], ['MINIMUM_PULSE', 'Minimum Pulse (ms)', 20, 0, 1000, 1, '%.0f'], ['QUANTIZATION', 'Duration Quantization (ms)', 10, 0, 1000, 1, '%.0f'], ['GAIN_NORTH', 'North Gain', 0.95, 0, 2, 0.01, '%.3f'], ['GAIN_SOUTH', 'South Gain', 1.05, 0, 2, 0.01, '%.3f'], ['GAIN_EAST', 'East Gain', 1, 0, 2, 0.01, '%.3f'], ['GAIN_WEST', 'West Gain', 1, 0, 2, 0.01, '%.3f'])
	// Elastic response of the structure to an abrupt stop: a telescope on a tripod is a spring, so it
	// overshoots and rings before coming to rest. A zero overshoot or frequency makes it perfectly
	// stiff, as does leaving the feature off.
	// oxfmt-ignore
	readonly #settling = makeNumberVector('', 'MOUNT_SETTLING', 'Settling', SIMULATION, 'rw', ['OVERSHOOT', 'Overshoot (arcsec)', 3, 0, 600, 0.1, '%.3f'], ['FREQUENCY', 'Frequency (Hz)', 2, 0, 50, 0.1, '%.2f'], ['DAMPING_RATIO', 'Damping Ratio', 0.2, 0, 1, 0.01, '%.3f'])
	// Effects that depend on where the tube is rather than on the geometry of the axes. TUBE_FLEXURE is
	// the droop of the optical axis at the horizon, falling to nothing at the zenith, and acts in the
	// vertical, so converting it to equatorial coordinates goes through the parallactic angle. The pier
	// terms are the constant offset of the west side relative to the east, from the tube hanging on the
	// other side of the mount; they are right-ascension and declination offsets, not on-sky angles, on
	// the same convention as the index errors.
	// oxfmt-ignore
	readonly #flexure = makeNumberVector('', 'MOUNT_FLEXURE', 'Flexure', SIMULATION, 'rw', ['TUBE_FLEXURE', 'Tube Flexure (arcsec)', 30, -3600, 3600, 0.1, '%.3f'], ['PIER_WEST_RA', 'Pier West RA Offset (arcsec)', 20, -3600, 3600, 0.1, '%.3f'], ['PIER_WEST_DEC', 'Pier West DEC Offset (arcsec)', 20, -3600, 3600, 0.1, '%.3f'])
	// Buffeting of the telescope by wind, as a bounded random deflection of the optical axis with a
	// memory of its own. Distinct from every other term here: static geometry cannot produce it, the
	// worm repeats too regularly, and the tracking-rate walk has no bound. A zero amplitude makes the
	// site perfectly still. Doubles as the centroid wander of seeing, which behaves the same way.
	// oxfmt-ignore
	readonly #wind = makeNumberVector('', 'MOUNT_WIND', 'Wind', SIMULATION, 'rw', ['AMPLITUDE', 'Amplitude (arcsec)', 1.5, 0, 600, 0.1, '%.3f'], ['CORRELATION_TIME', 'Correlation Time (s)', 3, 0.1, 300, 0.1, '%.2f'])
	// Relative error of the tracking drive, in parts per million of the commanded rate, as a constant
	// bias plus a temperature term plus a random wander. The temperature is the ambient one seen by the
	// drive; the coefficient acts on its departure from TRACKING_RATE_CALIBRATION_TEMPERATURE.
	// oxfmt-ignore
	readonly #trackingRate = makeNumberVector('', 'MOUNT_TRACKING_RATE', 'Tracking Rate', SIMULATION, 'rw', ['BIAS', 'Rate Bias (ppm)', 50, -10000, 10000, 1, '%.2f'], ['TEMPERATURE_COEFFICIENT', 'Temperature Coefficient (ppm/C)', 2, -1000, 1000, 0.1, '%.3f'], ['TEMPERATURE', 'Temperature (C)', TRACKING_RATE_CALIBRATION_TEMPERATURE, -60, 60, 0.1, '%.1f'], ['RANDOM_WALK', 'Random Walk (ppm/sqrt(s))', 0.5, 0, 1000, 0.1, '%.3f'])

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
		this.#errorFeatures,
		this.#alignment,
		this.#periodicError,
		this.#periodicErrorCorrection,
		this.#wormPhaseVector,
		this.#mechanics,
		this.#guiding,
		this.#settling,
		this.#flexure,
		this.#wind,
		this.#trackingRate,
	]
	// The error-model configuration is persisted along with track mode and guide rate, so a simulated
	// mount keeps its mechanical character across reconnections. The worm phase is not: it is live
	// mechanical state, and a power cycle is exactly when a real mount loses track of it.
	protected propertiesToNotSave = this.properties.filter(
		(e) =>
			e !== this.#trackMode &&
			e !== this.#guideRate &&
			e !== this.#errorFeatures &&
			e !== this.#alignment &&
			e !== this.#periodicError &&
			e !== this.#periodicErrorCorrection &&
			e !== this.#mechanics &&
			e !== this.#guiding &&
			e !== this.#settling &&
			e !== this.#trackingRate &&
			e !== this.#flexure &&
			e !== this.#wind,
	)

	#timer?: NodeJS.Timeout
	#lastTick = 0
	#coordSetMode: CoordSetMode = 'SLEW'
	#slewMode?: SlewMode
	#slewTarget?: EquatorialCoordinate
	#manualNorthSouth: AxisDirection = 0
	#manualWestEast: AxisDirection = 0
	// Accepted guide pulses per axis, ordered by acceptance and retired once the simulated clock has
	// passed them. A queue rather than a single deadline, so that a pulse arriving before the previous
	// one finishes adds to it instead of silently replacing it.
	readonly #northSouthPulses: GuidePulse[] = []
	readonly #westEastPulses: GuidePulse[] = []
	// Guide contribution of the interval just integrated, radians per second per axis. Kept so that the
	// motor rate, the worm phase and the transmission all see the same value within a step.
	#guideRateNorthSouth = 0
	#guideRateWestEast = 0
	// Deterministic source for the latency jitter, so a simulated session is reproducible.
	readonly #random = mulberry32(GUIDE_JITTER_SEED)
	// Standard normal source for the wander of the tracking rate, drawn from the same seeded generator.
	readonly #normal = normal(this.#random)
	// Wandering component of the tracking-rate error, and the total error of the interval just stepped,
	// both in parts per million.
	readonly #trackingRateErrorState = trackingRateErrorState()
	#trackingRateError = 0
	// Scratch tuple for the flexure term, reused because the boresight is evaluated on every tick and
	// once per trajectory sample of an exposure.
	readonly #flexureError: [Angle, Angle] = [0, 0]
	// Harmonic content of the worm and the trained correction, rebuilt from MOUNT_PERIODIC_ERROR and
	// MOUNT_PEC whenever either changes, so evaluating the boresight allocates nothing.
	#periodicErrorCurve: PeriodicErrorCurve = IDENTITY_PERIODIC_ERROR_CURVE
	// Rate-error configuration, rebuilt from MOUNT_TRACKING_RATE whenever it changes.
	#trackingRateErrorConfig: TrackingRateErrorConfig = IDENTITY_TRACKING_RATE_ERROR_CONFIG
	// Current deflection of the optical axis by the wind, and the conditions producing it.
	readonly #windState = windState()
	#windConfig: WindConfig = IDENTITY_WIND_CONFIG
	// How far the axes really sat from the home position the last time the mount homed, radians. A home
	// sensor has hysteresis, so the mount zeroes its encoders a little short of where it did last time
	// and every subsequent coordinate inherits the difference. This is where index errors come from.
	#homeScatterRightAscension: Angle = 0
	#homeScatterDeclination: Angle = 0
	// Travel the drive has delivered beyond what the encoders counted, radians of right ascension.
	// Unbounded on purpose: an uncorrected rate error walks away without limit, which is exactly the
	// failure an unguided exposure shows.
	#trackingRateOffset: Angle = 0
	// Rolling record of where the optical axis actually pointed, so a camera can integrate an exposure
	// over the motion that happened rather than over a single instant.
	readonly #boresightHistory = boresightHistory(MOUNT_TRAJECTORY_CAPACITY)
	// Elastic ring-down of each axis after an abrupt stop.
	readonly #rightAscensionSettling = settlingState()
	readonly #declinationSettling = settlingState()
	// Settling configuration, rebuilt from MOUNT_SETTLING whenever it changes so the step allocates nothing.
	#settlingConfig: SettlingConfig = IDENTITY_SETTLING_CONFIG
	// True orientation of the mechanical axes. This is the authoritative state: tracking, slewing,
	// manual motion and guiding all move it, and both the reported coordinate and the boresight are
	// derived from it.
	readonly #mechanical: EquatorialCoordinate = { rightAscension: 0, declination: PIOVERTWO }
	// Home and park are stored as mechanical positions, since that is what the axes return to.
	readonly #homeCoordinate: EquatorialCoordinate = { rightAscension: 0, declination: PIOVERTWO }
	readonly #parkCoordinate: EquatorialCoordinate = { rightAscension: 0, declination: PIOVERTWO }
	#utcTime = Date.now()
	// Fraction of a millisecond not yet handed to the clock, in [0, 1). Carried between steps so a run
	// of intervals shorter than the clock resolution still adds up to the time that really passed.
	#utcTimeRemainder = 0
	#utcOffset = TIMEZONE / 60
	#notifyCoordinateLastTime = 0
	// Simulated time the worm phase was last published at, throttled separately from the coordinate
	// because the phase keeps moving in the very mode that holds the coordinate still.
	#notifyWormPhaseLastTime = 0
	// Accumulated angle of the right-ascension worm, radians in [0, TAU). Physical state integrated
	// from the motion of the axis, so it survives a disconnection and only a new simulator resets it.
	#wormPhase: Angle = 0
	// Live transmission state of each axis: how much slack is open, which flank is loaded, and whether
	// the axis is currently stuck.
	readonly #rightAscensionAxis = mechanicalAxisState()
	readonly #declinationAxis = mechanicalAxisState()
	// Transmission configuration per axis, rebuilt from MOUNT_MECHANICS whenever it changes so that the
	// simulation step allocates nothing.
	#rightAscensionTransmission: MechanicalAxisConfig = IDENTITY_MECHANICAL_AXIS_CONFIG
	#declinationTransmission: MechanicalAxisConfig = IDENTITY_MECHANICAL_AXIS_CONFIG

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

	// Whether a family of error is being simulated. Every consumer gates on one of these rather than on
	// a value being zero, so a family is off when the switch says so and not when somebody happened to
	// leave a number blank.
	get #simulatesAlignment() {
		return this.#errorFeatures.elements.ALIGNMENT.value
	}

	get #simulatesPeriodicError() {
		return this.#errorFeatures.elements.PERIODIC_ERROR.value
	}

	get #simulatesMechanics() {
		return this.#errorFeatures.elements.MECHANICS.value
	}

	get #simulatesGuiding() {
		return this.#errorFeatures.elements.GUIDING.value
	}

	get #simulatesSettling() {
		return this.#errorFeatures.elements.SETTLING.value
	}

	get #simulatesFlexure() {
		return this.#errorFeatures.elements.FLEXURE.value
	}

	get #simulatesWind() {
		return this.#errorFeatures.elements.WIND.value
	}

	get #simulatesTrackingRate() {
		return this.#errorFeatures.elements.TRACKING_RATE.value
	}

	// Reported equatorial coordinate (radians) decoded from the RA-hours/Dec-degrees property. This is
	// what the controller believes and what INDI clients see, not the true orientation of the axes; see
	// `mechanical` and `boresight` for those.
	get rightAscension() {
		return hour(this.#equatorialCoordinate.elements.RA.value)
	}

	get declination() {
		return deg(this.#equatorialCoordinate.elements.DEC.value)
	}

	// True orientation of the mechanical axes (radians). Aliases internal state, so callers must treat
	// it as read-only and copy it if they need to keep it.
	get mechanical(): Readonly<EquatorialCoordinate> {
		return this.#mechanical
	}

	// The three directions of the mount at this instant, evaluated on the simulated clock.
	get pointingState(): MountPointingState {
		return {
			reported: { rightAscension: this.rightAscension, declination: this.declination },
			mechanical: { rightAscension: this.#mechanical.rightAscension, declination: this.#mechanical.declination },
			boresight: this.boresight,
		}
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

	// Simulated UTC clock, in milliseconds since the epoch. Advances with the ticks and is what
	// TIME_UTC sets, so consumers that need the mount's notion of time must read it instead of the
	// wall clock.
	get utcTime() {
		return this.#utcTime
	}

	// Direction the optical axis really points at this instant: the mechanical orientation perturbed by
	// every error being simulated.
	//
	// Evaluated at the present and only at the present. The mount cannot say where it pointed a moment
	// ago from its current state alone, since backlash, the guide queue and the wind are all
	// path-dependent, and `sampleBoresightTrajectory` answers that from the recorded history instead;
	// for the same reason it cannot say where it will point either.
	//
	// The offsets are absolute rather than incremental, so evaluating twice without advancing the
	// simulation yields the same result. The declination is left unclamped; a polar error pushing it
	// past the pole is a real, if degenerate, configuration and clamping would silently hide it.
	get boresight(): EquatorialCoordinate {
		const model = this.pointingModel
		const flexureEnabled = this.#simulatesFlexure
		const { TUBE_FLEXURE, PIER_WEST_RA, PIER_WEST_DEC } = this.#flexure.elements
		let rightAscension = this.#mechanical.rightAscension
		let declination = this.#mechanical.declination

		if (model !== IDENTITY_EQUATORIAL_POINTING_MODEL || (flexureEnabled && (TUBE_FLEXURE.value !== 0 || PIER_WEST_RA.value !== 0 || PIER_WEST_DEC.value !== 0))) {
			const lst = this.#siderealTime()

			if (model !== IDENTITY_EQUATORIAL_POINTING_MODEL) {
				;[rightAscension, declination] = applyEquatorialPointingError(rightAscension, declination, lst, model)
			}

			if (flexureEnabled && TUBE_FLEXURE.value !== 0) {
				// Evaluated at the mechanical orientation rather than at the partly corrected one: the tube
				// sags according to where it is actually aimed, and the geometric terms are arcseconds, far
				// too small to change how much it sags.
				const flexure = tubeFlexureError(lst - this.#mechanical.rightAscension, this.#mechanical.declination, this.latitude, TUBE_FLEXURE.value * ASEC2RAD, this.#flexureError)
				rightAscension -= flexure[0]
				declination += flexure[1]
			}

			// The pier offset applies on one side only, so what it really configures is the difference
			// between the two sides. That difference is what a pointing model fitted across a meridian
			// flip has to absorb, and what a client that forgets to re-solve after one walks into.
			if (flexureEnabled && (PIER_WEST_RA.value !== 0 || PIER_WEST_DEC.value !== 0) && expectedPierSide(this.#mechanical.rightAscension, this.#mechanical.declination, lst) === 'WEST') {
				rightAscension += PIER_WEST_RA.value * ASEC2RAD
				declination += PIER_WEST_DEC.value * ASEC2RAD
			}
		}

		if (this.#periodicErrorCurve !== IDENTITY_PERIODIC_ERROR_CURVE) {
			rightAscension += periodicErrorAt(this.#wormPhase, this.#periodicErrorCurve)
		}

		// Held constant across the extrapolation window rather than projected forward: over the fraction
		// of a second a caller extrapolates by, a part-per-million rate error moves nothing measurable.
		// The same applies to the wind and to the home scatter, which is constant until the next home.
		rightAscension += this.#trackingRateOffset + this.#homeScatterRightAscension
		declination += this.#homeScatterDeclination

		if (this.#windState.rightAscension !== 0 || this.#windState.declination !== 0) {
			// The wind pushes the tube by an angle on the sky, so the east-west component has to be
			// divided by the cosine of the declination to become a right-ascension offset. The home
			// scatter above needs no such conversion: it is an error of the axis angles themselves.
			rightAscension += this.#windState.rightAscension / Math.cos(clamp(declination, -MAX_POINTING_DECLINATION, MAX_POINTING_DECLINATION))
			declination += this.#windState.declination
		}

		// Normalized once here rather than after the geometric terms, so every contribution is inside the
		// wrap. The terms that follow them are small but signed, and a mount sitting just east of zero
		// used to come back with a negative right ascension.
		return { rightAscension: normalizeAngle(rightAscension), declination }
	}

	// Right ascension the drive has delivered beyond what the encoders counted, radians. Grows while
	// tracking with a non-zero rate error and is cleared by a sync, which is what re-registers the
	// bookkeeping against the sky.
	get trackingRateOffset(): Angle {
		return this.#trackingRateOffset
	}

	// Live phase of the right-ascension worm, in radians normalized to [0, TAU). Integrated from the
	// motion of the axis rather than from the clock.
	get wormPhase(): Angle {
		return this.#wormPhase
	}

	// Samples where the optical axis pointed across `[startTime, endTime]`, both milliseconds on the
	// simulated clock, writing `count` consecutive right ascension and declination pairs into `out` and
	// returning how many were written.
	//
	// Reads the recorded history rather than recomputing, because backlash, stiction and the guide
	// queue have no closed form to run backwards. Times before the retained window clamp to its oldest
	// sample, so an exposure longer than the history trails only over the part that is still known.
	// Returns 0 when nothing has been recorded yet, which is the case until the first tick.
	sampleBoresightTrajectory(startTime: number, endTime: number, count: number, out: Float64Array) {
		return sampleBoresightTrajectory(this.#boresightHistory, startTime, endTime, count, out)
	}

	// Samples where the optical axis pointed across `[startTime, endTime]`, both milliseconds on the
	// simulated clock, spacing `count` samples by equal path length rather than by equal time and
	// writing right ascension, declination and time-weight triples into `out`.
	//
	// This is what an exposure integrates over: the samples land where the motion is, so a brief
	// excursion is drawn rather than falling between them, and each carries its own share of the
	// exposure time so that the trail is bright where the mount lingered. Returns how many were written.
	sampleBoresightPath(startTime: number, endTime: number, count: number, out: Float64Array) {
		return sampleBoresightPath(this.#boresightHistory, startTime, endTime, count, out)
	}

	// Length of the path the optical axis swept across `[startTime, endTime]`, radians on the sky, both
	// milliseconds on the simulated clock.
	//
	// Measured over every sample the history retains inside the window, so a consumer deciding how
	// finely to integrate an exposure gets the real path rather than one read off a grid of its own
	// choosing, which can alias against a periodic error and report a swinging field as a still one.
	boresightPathLength(startTime: number, endTime: number): Angle {
		return boresightPathLength(this.#boresightHistory, startTime, endTime)
	}

	// Optical pointing model built from the configured geometric errors: how far the boresight sits
	// from where the axes mechanically point.
	//
	// Covers the polar-axis misalignment, the cone error and the non-perpendicularity of the two axes.
	// The encoder index errors are deliberately absent: they change what the controller reports, not
	// where the telescope looks, and are applied when the reported coordinate is derived instead.
	//
	// Returns the shared identity model when nothing is configured, so callers can skip the whole
	// computation with a reference comparison.
	get pointingModel(): EquatorialPointingModel {
		if (!this.#simulatesAlignment) return IDENTITY_EQUATORIAL_POINTING_MODEL

		const { POLAR_AZIMUTH_ERROR, POLAR_ALTITUDE_ERROR, CONE_ERROR, AXIS_NON_ORTHOGONALITY } = this.#alignment.elements
		if (POLAR_AZIMUTH_ERROR.value === 0 && POLAR_ALTITUDE_ERROR.value === 0 && CONE_ERROR.value === 0 && AXIS_NON_ORTHOGONALITY.value === 0) return IDENTITY_EQUATORIAL_POINTING_MODEL

		const model = polarAlignmentPointingModel(POLAR_AZIMUTH_ERROR.value * ASEC2RAD, POLAR_ALTITUDE_ERROR.value * ASEC2RAD, this.latitude)
		return { ...model, coneError: CONE_ERROR.value * ASEC2RAD, axisNonPerpendicularity: AXIS_NON_ORTHOGONALITY.value * ASEC2RAD }
	}

	// Encoder zero offsets, radians, added to the mechanical orientation to obtain what the controller
	// reports. Not an optical effect: the telescope does not move, the bookkeeping is off, which is what
	// a bad home sensor, an imperfect sync or a miscalibrated controller leave behind.
	get #indexErrorRightAscension(): Angle {
		return this.#simulatesAlignment ? this.#alignment.elements.RA_INDEX_ERROR.value * ASEC2RAD : 0
	}

	get #indexErrorDeclination(): Angle {
		return this.#simulatesAlignment ? this.#alignment.elements.DEC_INDEX_ERROR.value * ASEC2RAD : 0
	}

	// Upper bound (radians) of how far the configured errors can displace the optical axis, over all
	// hour angles. The polar-alignment terms contribute at most the sum of their magnitudes to each of
	// the two axes, hence the sqrt(2) on their combined magnitude, and the worm adds the sum of its
	// harmonic amplitudes to right ascension. Consumers use it to size buffers and margins without
	// having to know the error model.
	get pointingErrorBound(): Angle {
		const { POLAR_AZIMUTH_ERROR, POLAR_ALTITUDE_ERROR, CONE_ERROR, AXIS_NON_ORTHOGONALITY, RA_INDEX_ERROR, DEC_INDEX_ERROR } = this.#alignment.elements
		// Each family counts only while it is being simulated, so a disabled one cannot inflate the
		// margin a camera sizes from this.
		const alignmentScale = this.#simulatesAlignment ? 1 : 0
		const flexureScale = this.#simulatesFlexure ? 1 : 0
		// The cone and non-perpendicularity terms scale as sec and tan of the declination, which cancel
		// against the cos that converts a hour-angle error to an on-sky angle, so each is bounded by its
		// own coefficient. The index errors count too, because consumers compare the boresight against
		// the reported coordinate and the offsets sit between them.
		const polar = alignmentScale * Math.SQRT2 * (Math.abs(POLAR_AZIMUTH_ERROR.value) + Math.abs(POLAR_ALTITUDE_ERROR.value))
		const geometry = alignmentScale * (Math.abs(CONE_ERROR.value) + Math.abs(AXIS_NON_ORTHOGONALITY.value))
		const index = alignmentScale * (Math.abs(RA_INDEX_ERROR.value) + Math.abs(DEC_INDEX_ERROR.value))
		// Flexure peaks at the horizon and the pier offset applies on one side, so both count in full.
		const { TUBE_FLEXURE, PIER_WEST_RA, PIER_WEST_DEC } = this.#flexure.elements
		const gravity = flexureScale * (Math.abs(TUBE_FLEXURE.value) + Math.abs(PIER_WEST_RA.value) + Math.abs(PIER_WEST_DEC.value))
		// The rate drift and the home scatter are added as they stand rather than bounded: neither has a
		// bound, so the only honest figure is how far each has actually gone. The wind has no hard bound
		// either, being Gaussian, so it contributes three standard deviations, which it stays within
		// better than 99% of the time.
		const realized = Math.abs(this.#trackingRateOffset) + Math.abs(this.#homeScatterRightAscension) + Math.abs(this.#homeScatterDeclination)
		return (polar + geometry + index + gravity) * ASEC2RAD + periodicErrorBound(this.#periodicErrorCurve) + realized + 3 * this.#windConfig.amplitude
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
				return
			case 'MOUNT_ALIGNMENT':
				if (applyNumberVectorValues(this.#alignment, vector.elements)) {
					// The index errors sit between the axes and what the controller reports, and the reported
					// coordinate is derived once and cached. Changing them has to re-derive it: the telescope
					// has not moved, but what the mount believes about it just changed.
					this.#refreshReportedCoordinate()
					this.notify(this.#alignment)
				}
				return
			case 'MOUNT_PERIODIC_ERROR':
				if (applyNumberVectorValues(this.#periodicError, vector.elements)) {
					this.#refreshPeriodicError()
					this.notify(this.#periodicError)
				}
				return
			case 'MOUNT_PEC':
				if (applyNumberVectorValues(this.#periodicErrorCorrection, vector.elements)) {
					this.#refreshPeriodicError()
					this.notify(this.#periodicErrorCorrection)
				}
				return
			case 'MOUNT_FLEXURE':
				if (applyNumberVectorValues(this.#flexure, vector.elements)) this.notify(this.#flexure)
				return
			case 'MOUNT_WIND':
				if (applyNumberVectorValues(this.#wind, vector.elements)) {
					this.#refreshWind()
					this.notify(this.#wind)
				}
				return
			case 'MOUNT_MECHANICS':
				if (applyNumberVectorValues(this.#mechanics, vector.elements)) {
					this.#refreshTransmission()
					this.notify(this.#mechanics)
				}
				return
			case 'MOUNT_GUIDING':
				if (applyNumberVectorValues(this.#guiding, vector.elements)) this.notify(this.#guiding)
				return
			case 'MOUNT_SETTLING':
				if (applyNumberVectorValues(this.#settling, vector.elements)) {
					this.#refreshSettling()
					this.notify(this.#settling)
				}
				return
			case 'MOUNT_TRACKING_RATE':
				if (applyNumberVectorValues(this.#trackingRate, vector.elements)) {
					this.#refreshTrackingRate()
					this.notify(this.#trackingRate)
				}
		}
	}

	// Rebuilds the tracking-rate error configuration from MOUNT_TRACKING_RATE. Called only when the
	// property changes, so the per-step path reads a plain field.
	#refreshTrackingRate() {
		if (!this.#simulatesTrackingRate) {
			this.#trackingRateErrorConfig = IDENTITY_TRACKING_RATE_ERROR_CONFIG
			return
		}

		const { BIAS, TEMPERATURE_COEFFICIENT, TEMPERATURE, RANDOM_WALK } = this.#trackingRate.elements
		this.#trackingRateErrorConfig = { bias: BIAS.value, temperatureCoefficient: TEMPERATURE_COEFFICIENT.value, temperature: TEMPERATURE.value, randomWalk: RANDOM_WALK.value }
	}

	// Rebuilds every cached configuration after a persisted set of properties has been restored, since
	// loading writes the vectors directly instead of going through `sendNumber`.
	protected onPropertiesLoaded() {
		this.#refreshErrorConfigurations()
	}

	// Rebuilds every configuration cached from a property vector. Called whenever a persisted set of
	// properties is restored, since loading writes the vectors directly instead of going through
	// `sendNumber`, and whenever an error feature is switched, since each of these is gated by one.
	#refreshErrorConfigurations() {
		this.#discardDisabledErrorState()
		this.#refreshTransmission()
		this.#refreshSettling()
		this.#refreshTrackingRate()
		this.#refreshPeriodicError()
		this.#refreshWind()
		this.#refreshReportedCoordinate()
	}

	// Throws away the state a disabled family had accumulated, so switching one off leaves an ideal
	// mount rather than one frozen wherever the error had already carried it.
	//
	// Most families are derived from their vector on every evaluation and stop contributing the moment
	// the switch does. These two are not: they integrate over time into state of their own, and without
	// this the drift a drive had walked away, or the offset a home sensor had left, would go on being
	// added to the boresight by a family that is no longer being simulated. The rate error is worse
	// still, since the wander of the rate survives in its own state and would keep the drift growing.
	#discardDisabledErrorState() {
		if (!this.#simulatesTrackingRate) {
			resetTrackingRateError(this.#trackingRateErrorState)
			this.#trackingRateError = 0
			this.#trackingRateOffset = 0
		}

		if (!this.#simulatesMechanics) {
			this.#homeScatterRightAscension = 0
			this.#homeScatterDeclination = 0
			// Slack that is open, the flank it is open on, and a stopped axis waiting to break free are
			// all live state of the transmission. Replacing its configuration with the identity stops any
			// of it growing but leaves what was already there, so re-enabling the family would resume
			// from slack that was taken up under a mount that no longer had any.
			clearMechanicalAxis(this.#rightAscensionAxis)
			clearMechanicalAxis(this.#declinationAxis)
		}

		if (!this.#simulatesSettling) {
			// A ring-down in progress is likewise only frozen by an identity configuration, and would
			// carry its old offset and velocity into whatever the mount does next.
			resetSettling(this.#rightAscensionSettling)
			resetSettling(this.#declinationSettling)
		}
	}

	// Re-derives the reported coordinate from the axes without moving them, which is what has to happen
	// when the encoder index errors change: the telescope stays where it is and only the bookkeeping
	// between it and the controller moves.
	//
	// Notified unconditionally rather than on the usual coordinate cadence. That cadence exists to keep
	// continuous motion from flooding clients, and it works because motion keeps calling back. This has
	// no such follow-up: a mount tracking perfectly at the sidereal rate never moves an axis, so
	// `#setMechanical` is never reached again and a throttled notification here would simply be lost,
	// leaving clients on the old coordinate for as long as the mount kept tracking.
	#refreshReportedCoordinate() {
		this.#setMechanical(this.#mechanical.rightAscension, this.#mechanical.declination, true, true)
	}

	// Rebuilds the wind configuration from MOUNT_WIND, reseeding the deflection from the settled
	// distribution when the conditions actually changed, so a change of weather takes effect at once
	// instead of spending several correlation times warming up from whatever the old one had left.
	//
	// Only when they changed, because this runs whenever any cached configuration is rebuilt, including
	// on an unrelated feature switch. Reseeding unconditionally teleported the optical axis by about an
	// arcsecond every time some other family was toggled, and an exposure straddling that jump would
	// integrate across it and paint a trail the telescope never followed.
	#refreshWind() {
		const { AMPLITUDE, CORRELATION_TIME } = this.#wind.elements
		const previous = this.#windConfig
		this.#windConfig = this.#simulatesWind && AMPLITUDE.value > 0 ? { amplitude: AMPLITUDE.value * ASEC2RAD, correlationTime: CORRELATION_TIME.value } : IDENTITY_WIND_CONFIG

		if (this.#windConfig.amplitude !== previous.amplitude || this.#windConfig.correlationTime !== previous.correlationTime) {
			resetWind(this.#windState, this.#windConfig, this.#normal)
		}
	}

	// Rebuilds the worm curve from MOUNT_PERIODIC_ERROR and retrains the correction from MOUNT_PEC.
	//
	// Retraining on every change is what a controller does when the mechanics change under it, and it
	// keeps the table consistent with the curve it is meant to cancel. Collapses to the shared identity
	// curve when no harmonic has any amplitude, so the boresight path can skip it by reference.
	//
	// A worm that never turns collapses the same way. The period is what turns axis travel into phase,
	// so without one the phase is frozen wherever it stood and the harmonics stop being periodic at all:
	// they become a constant offset of the boresight, which is an index error rather than a periodic
	// one. The property documents a zero period as disabling the term, and this is where that holds.
	#refreshPeriodicError() {
		const { RA_PERIOD, RA_AMPLITUDE, RA_PHASE, RA_AMPLITUDE_2, RA_PHASE_2, RA_AMPLITUDE_3, RA_PHASE_3 } = this.#periodicError.elements

		if (!this.#simulatesPeriodicError || RA_PERIOD.value <= 0 || (RA_AMPLITUDE.value === 0 && RA_AMPLITUDE_2.value === 0 && RA_AMPLITUDE_3.value === 0)) {
			this.#periodicErrorCurve = IDENTITY_PERIODIC_ERROR_CURVE
			return
		}

		const amplitudes = new Float64Array(PERIODIC_ERROR_HARMONICS)
		const phases = new Float64Array(PERIODIC_ERROR_HARMONICS)
		amplitudes[0] = RA_AMPLITUDE.value * ASEC2RAD
		amplitudes[1] = RA_AMPLITUDE_2.value * ASEC2RAD
		amplitudes[2] = RA_AMPLITUDE_3.value * ASEC2RAD
		phases[0] = deg(RA_PHASE.value)
		phases[1] = deg(RA_PHASE_2.value)
		phases[2] = deg(RA_PHASE_3.value)

		const { SAMPLES, GAIN } = this.#periodicErrorCorrection.elements
		this.#periodicErrorCurve = trainPeriodicErrorCorrection({ amplitudes, phases }, SAMPLES.value, GAIN.value)
	}

	// Rebuilds the settling configuration from MOUNT_SETTLING. Called only when the property changes,
	// so the per-step path reads a plain field.
	#refreshSettling() {
		if (!this.#simulatesSettling) {
			this.#settlingConfig = IDENTITY_SETTLING_CONFIG
			return
		}

		const { OVERSHOOT, FREQUENCY, DAMPING_RATIO } = this.#settling.elements
		this.#settlingConfig = { overshoot: OVERSHOOT.value * ASEC2RAD, frequency: FREQUENCY.value, dampingRatio: DAMPING_RATIO.value }
	}

	// Rebuilds the per-axis transmission configuration from MOUNT_MECHANICS. Called only when the
	// property changes, so the per-step path reads plain fields and allocates nothing.
	#refreshTransmission() {
		if (!this.#simulatesMechanics) {
			this.#rightAscensionTransmission = IDENTITY_MECHANICAL_AXIS_CONFIG
			this.#declinationTransmission = IDENTITY_MECHANICAL_AXIS_CONFIG
			return
		}

		const { BACKLASH_RA, BACKLASH_DEC, TAKE_UP_RATE, STICTION_RA, STICTION_DEC } = this.#mechanics.elements
		this.#rightAscensionTransmission = { backlash: BACKLASH_RA.value * ASEC2RAD, takeUpRate: TAKE_UP_RATE.value, staticThreshold: STICTION_RA.value * ASEC2RAD }
		this.#declinationTransmission = { backlash: BACKLASH_DEC.value * ASEC2RAD, takeUpRate: TAKE_UP_RATE.value, staticThreshold: STICTION_DEC.value * ASEC2RAD }
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
			case 'SIMULATOR_ERROR_FEATURES':
				if (applyMultiSwitchValues(this.#errorFeatures, vector.elements)) {
					// Every cached configuration is gated by one of these, so they all have to be rebuilt
					// rather than only the one whose switch moved.
					this.#refreshErrorConfigurations()
					this.notify(this.#errorFeatures)
				}
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
		// A power cycle leaves the drive where it was but forgets how far its rate had wandered.
		resetTrackingRateError(this.#trackingRateErrorState)
		this.#trackingRateError = 0
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
	//
	// The target is given in reported coordinates, which is what a client commands, so it is converted
	// back through the encoder offsets into the mechanical orientation the axes must reach for the
	// controller to end up reporting it.
	goTo(rightAscension: Angle, declination: Angle) {
		if (!this.isConnected || this.isParked) return

		this.#clearManualMotion()
		this.#clearPulseGuide()
		this.#takeSlewControl()
		this.#slewMode = 'GOTO'
		this.#slewTarget = { rightAscension: normalizeAngle(rightAscension - this.#indexErrorRightAscension), declination: clampDeclination(declination - this.#indexErrorDeclination) }
		this.#setSlewing(true)
		this.#setHoming(false)
		this.#setParking(false)
	}

	// Applies a sync immediately without any slew time.
	//
	// Places the axes so that the controller ends up reporting the requested coordinate, which with a
	// configured index error is not the same orientation. A real sync leaves the mount where it is and
	// only rewrites its bookkeeping, but here it is also how the simulated mount gets positioned at
	// all: doing it the other way would strand the axes at the pole they home to, where declination is
	// clamped and the geometry is degenerate. The index errors carry the "bad bookkeeping" behaviour
	// instead, as a configured quantity rather than a side effect of syncing.
	syncTo(rightAscension: Angle, declination: Angle) {
		if (!this.isConnected) return
		this.#setMechanical(rightAscension - this.#indexErrorRightAscension, declination - this.#indexErrorDeclination)
		// A sync is a discontinuity rather than motion, so the recorded past no longer describes where
		// this telescope has been. Keeping it would let an exposure straddling the sync integrate a jump
		// across the sky as if the tube had swept through it, and it is also where the errors that live
		// in the bookkeeping are re-registered against the sky.
		this.#absorbAccumulatedError()
	}

	// Slews to the configured home position.
	home() {
		if (!this.isConnected || this.isParked) return
		this.#takeSlewControl()
		this.#slewMode = 'HOME'
		this.#slewTarget = { rightAscension: this.#homeCoordinate.rightAscension, declination: this.#homeCoordinate.declination }
		this.#setSlewing(true)
		this.#setHoming(true)
		this.#setParking(false)
	}

	// Stores the current mechanical orientation as the new home position.
	setHome() {
		this.#homeCoordinate.rightAscension = this.#mechanical.rightAscension
		this.#homeCoordinate.declination = this.#mechanical.declination
	}

	// Parks the mount at the configured park position.
	park() {
		if (!this.isConnected || this.isParked) return
		this.#clearManualMotion()
		this.#clearPulseGuide()
		this.#takeSlewControl()
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

	// Stores the current mechanical orientation as the park position.
	setPark() {
		this.#parkCoordinate.rightAscension = this.#mechanical.rightAscension
		this.#parkCoordinate.declination = this.#mechanical.declination
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
		// The carried fraction belongs to the clock that was just replaced.
		this.#utcTimeRemainder = 0
		this.#utcOffset = value.offset
		this.#time.elements.UTC.value = formatTemporal(value.utc, 'YYYY-MM-DDTHH:mm:ss.SSSZ')
		this.#time.elements.OFFSET.value = (value.offset / 60).toFixed(2)
		this.#lastTick = Date.now()
		this.#updatePierSide()
		// The recorded trajectory is indexed by the simulated clock and searched assuming its timestamps
		// only ever increase. Setting the clock backwards would append a sample older than the ones
		// already held and break that, leaving an exposure to clamp onto a stale sample or interpolate
		// the wrong pair; setting it forward leaves a gap the mount never actually travelled. Either way
		// the history no longer describes this telescope, which is the same reason a sync drops it.
		//
		// Only the history, though. A sync also absorbs the errors that live in the bookkeeping, and
		// saying what time it is does not: the drift the drive had walked away and any ring-down in
		// progress are facts about the mount, and clearing them here made the optical axis jump back
		// towards the reported coordinate whenever a client set the clock or its UTC offset.
		this.#resetBoresightHistory()
		// Coordinate notifications are throttled against the simulated clock, so moving it invalidates
		// the epoch they are measured from. A rewind is the dangerous direction: every later update
		// would see a negative interval and publish nothing until simulated time caught up with where it
		// had been, which can be hours of a mount moving in silence. Republishing here both hands
		// clients the coordinate for the new sidereal time and re-registers that epoch.
		this.#refreshReportedCoordinate()
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

	// Queues a pulse-guiding correction for the requested direction, with `duration` in milliseconds.
	//
	// The command passes through the configured response first: pulses shorter than the minimum are
	// discarded outright, the surviving duration is rounded to the controller's step, and the start is
	// pushed out by the latency and its jitter. Everything is timed on the simulated clock, so stepping
	// the simulation directly behaves exactly as the timer does.
	//
	// The pulse is appended rather than replacing whatever is already running on that axis, so
	// overlapping corrections add up. A queue that is already full drops the new pulse, which is the
	// behaviour of a controller being commanded faster than it can execute.
	pulse(direction: GuideDirection, duration: number) {
		if (!this.isConnected || this.isParked) return

		const config = this.#guideResponse
		const executed = quantizeGuideDuration(duration, config)
		if (executed <= 0) return

		const northSouth = direction === 'NORTH' || direction === 'SOUTH'
		const pulses = northSouth ? this.#northSouthPulses : this.#westEastPulses
		if (pulses.length >= MAX_QUEUED_GUIDE_PULSES) return

		const sign = direction === 'NORTH' || direction === 'EAST' ? 1 : -1
		const gain = direction === 'NORTH' ? config.northGain : direction === 'SOUTH' ? config.southGain : direction === 'EAST' ? config.eastGain : config.westGain
		const guideRate = northSouth ? this.guideRateDeclination : this.guideRateRightAscension
		// Uniform over the full jitter width, centred on the configured latency and never negative.
		const jitter = config.latencyJitter > 0 ? (this.#random() * 2 - 1) * config.latencyJitter : 0
		// Timed from the exact clock, remainder included: a command issued after a partial step happens
		// at the instant the axes have reached, not at the last whole millisecond behind them.
		const start = this.#utcTime + this.#utcTimeRemainder + Math.max(0, config.latency + jitter)

		pulses.push({ start, end: start + executed, rate: sign * gain * guideRate * SIDEREAL_DRIFT_RATE })
		this.#updatePulsing()
	}

	// Guide-pulse response assembled from MOUNT_GUIDING. Read once per command, which is a cold path.
	get #guideResponse(): GuideResponseConfig {
		if (!this.#simulatesGuiding) return IDENTITY_GUIDE_RESPONSE_CONFIG

		const { LATENCY, LATENCY_JITTER, MINIMUM_PULSE, QUANTIZATION, GAIN_NORTH, GAIN_SOUTH, GAIN_EAST, GAIN_WEST } = this.#guiding.elements

		if (LATENCY.value === 0 && LATENCY_JITTER.value === 0 && MINIMUM_PULSE.value === 0 && QUANTIZATION.value === 0 && GAIN_NORTH.value === 1 && GAIN_SOUTH.value === 1 && GAIN_EAST.value === 1 && GAIN_WEST.value === 1) {
			return IDENTITY_GUIDE_RESPONSE_CONFIG
		}

		return {
			latency: LATENCY.value,
			latencyJitter: LATENCY_JITTER.value,
			minimumPulse: MINIMUM_PULSE.value,
			durationQuantization: QUANTIZATION.value,
			northGain: GAIN_NORTH.value,
			southGain: GAIN_SOUTH.value,
			eastGain: GAIN_EAST.value,
			westGain: GAIN_WEST.value,
		}
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

	// Advances the simulated state by the wall-clock interval elapsed since the previous tick.
	#tick() {
		const now = Date.now()
		const dtSeconds = Math.max(0, (now - this.#lastTick) / 1000)
		this.#lastTick = now
		this.advance(dtSeconds)
	}

	// Advances the whole simulation by `dtSeconds`: the simulated clock, the guide pulses, the worm
	// phase and the motion of both axes.
	//
	// Driven by the timer during normal operation, and callable directly to step the simulation
	// deterministically without waiting on real time, which is how the mechanical behaviour is covered
	// by tests. A non-positive interval is a no-op, and so is one that is not a finite number: the
	// simulation is stepped by a timer, and turning a bad reading of the clock into a coordinate of
	// `NaN` would poison the mechanical state permanently rather than costing one step.
	advance(dtSeconds: number) {
		if (!(dtSeconds > 0) || !Number.isFinite(dtSeconds)) return

		// The published clock is whole milliseconds, since that is what INDI timestamps are expressed in,
		// but the remainder is carried rather than discarded. Truncating each step on its own would let a
		// sub-millisecond interval move the axes while leaving the clock still, so two half-millisecond
		// steps would not add up to one of a millisecond.
		const startTime = this.#utcTime + this.#utcTimeRemainder
		this.#utcTimeRemainder += dtSeconds * 1000
		const elapsed = Math.trunc(this.#utcTimeRemainder)
		this.#utcTimeRemainder -= elapsed
		this.#utcTime += elapsed
		// The guide queue is timed on the exact clock rather than the published one, so its interval is
		// the interval the axes were actually advanced over. Rounding it down to whole milliseconds made
		// a pulse issued after a partial step start retroactively, at the beginning of a stretch that had
		// already elapsed, and delivered more of it than the step was long.
		const endTime = this.#utcTime + this.#utcTimeRemainder

		if (!this.isConnected) return

		// Guide pulses are integrated over the interval that just elapsed rather than sampled at its
		// end, so a pulse shorter than the step still delivers exactly its own share of motion. The
		// result is reduced to an equivalent rate for the rest of the step, which lets the transmission
		// see the travel a partly covered interval really produced.
		this.#guideRateWestEast = integrateGuidePulses(this.#westEastPulses, startTime, endTime) / dtSeconds
		this.#guideRateNorthSouth = integrateGuidePulses(this.#northSouthPulses, startTime, endTime) / dtSeconds

		// Sampled once per step, so every consumer of the interval sees the same rate error.
		this.#trackingRateError = advanceTrackingRateError(this.#trackingRateErrorState, dtSeconds, this.#trackingRateErrorConfig, this.#normal)

		// The wind blows regardless of what the mount is doing, so this runs even while parked.
		advanceWind(this.#windState, dtSeconds, this.#windConfig, this.#normal)

		// A slew reports how much of the step was left once it arrived, so a ring-down excited partway
		// through is integrated only over the time that actually followed the stop. At the default tick a
		// few-hertz resonance covers a good part of a cycle in one step, so charging it the whole
		// interval would shift its phase or swallow the first overshoot.
		let settlingSeconds = dtSeconds

		if (this.#slewTarget) {
			// The worm follows the axis, so it turns only while the axis does. The rate has to be read
			// before the move, since arriving clears the target that defines it, and the phase is then
			// charged for the part of the step the axis spent travelling. Charging the whole step instead
			// let a goto shorter than one tick spin the worm through the slew rate for the entire
			// interval — tens of degrees of phase for an axis that moved a few arcseconds — and step the
			// periodic error to somewhere unrelated to where the mount actually stopped.
			const slewRate = this.#rightAscensionMotorRate()
			settlingSeconds = this.#advanceSlew(dtSeconds)
			this.#advanceWormPhase(slewRate, dtSeconds - settlingSeconds)
		} else {
			// Integrated before the motion advances, so the phase covers the interval the axes are about
			// to run at the rate the motion is about to apply.
			this.#advanceWormPhase(this.#rightAscensionMotorRate(), dtSeconds)
			this.#advanceFreeMotion(dtSeconds)
		}

		// Applied as the change in the residual offset rather than as the offset itself, so the ringing
		// rides on top of whatever the axes are doing and pays itself back: once it has died away the
		// mount sits exactly where it was commanded.
		const rightAscensionRing = advanceSettling(this.#rightAscensionSettling, settlingSeconds, this.#settlingConfig)
		const declinationRing = advanceSettling(this.#declinationSettling, settlingSeconds, this.#settlingConfig)

		if (rightAscensionRing !== 0 || declinationRing !== 0) {
			this.#setMechanical(this.#mechanical.rightAscension + rightAscensionRing, this.#mechanical.declination + declinationRing)
		}

		// Retired only after the interval has been accounted for, so the tail of a pulse is never lost.
		// Both axes are always visited: short-circuiting the second call would leave its queue growing.
		const westEastPending = retireGuidePulses(this.#westEastPulses, endTime)
		const northSouthPending = retireGuidePulses(this.#northSouthPulses, endTime)
		this.#setPulsing(westEastPending || northSouthPending)

		this.#notifyWormPhase()

		// Recorded last, so the sample reflects the state at the end of the interval just simulated.
		const boresight = this.boresight
		recordBoresightSample(this.#boresightHistory, this.#utcTime, boresight.rightAscension, boresight.declination)
	}

	// Rate of the right-ascension motor, in radians per second of its contribution to the coordinate.
	//
	// This is not the rate at which the coordinate changes. While tracking at the sidereal rate the
	// motor runs at full speed westward and the coordinate stands still, and with the motor stopped the
	// coordinate drifts eastward at the sidereal rate as the sky turns underneath. The motor rate is
	// therefore negative while tracking, and zero when tracking is off and nothing else is commanded.
	//
	// During a slew the axis runs at the slew speed, which is what makes the worm spin far faster than
	// while tracking.
	#rightAscensionMotorRate() {
		if (this.#slewTarget) return this.#slewAxisRates()[0]

		let rate = this.isTracking ? this.#trackingDriftRate() - SIDEREAL_DRIFT_RATE : 0
		if (this.#manualWestEast !== 0) rate += this.#manualWestEast * this.#manualSlewSpeed()
		rate += this.#guideRateWestEast
		return rate
	}

	// Advances the physical worm phase over `dtSeconds` at the given motor rate (radians per second).
	//
	// The worm completes one revolution per configured period while the motor runs at the sidereal
	// tracking rate, hence the ratio to SIDEREAL_DRIFT_RATE; the sign is chosen so that ordinary
	// tracking advances the phase. Because the phase follows the axis and not the clock, it stands
	// still when the mount is parked or not tracking, and it speeds up during a slew.
	#advanceWormPhase(motorRate: number, dtSeconds: number) {
		const period = this.#periodicError.elements.RA_PERIOD.value
		if (period <= 0 || !this.#simulatesPeriodicError) return
		this.#wormPhase = normalizeAngle(this.#wormPhase + (-motorRate / SIDEREAL_DRIFT_RATE) * (TAU / period) * dtSeconds)
	}

	// Signed rates of both axes during a slew, in radians per second. The step is normalized by the
	// larger of the two deltas, so the axes arrive together and the faster one runs at the full slew
	// speed.
	#slewAxisRates(): readonly [number, number] {
		const target = this.#slewTarget
		if (!target) return [0, 0]

		const speed = this.#manualSlewSpeed() * SLEW_SPEED_FACTOR
		// Measured from the axes, not from the reported coordinate. The target was converted into a
		// mechanical orientation when the slew was commanded, so comparing it against what the
		// controller reports mixes the two sides of the encoder index error: a goto to the coordinate
		// already being reported would come back with a non-zero rate and spin the worm while
		// `#advanceSlew`, which does use the axes, correctly finds nothing to travel.
		const deltaRightAscension = normalizePI(target.rightAscension - this.#mechanical.rightAscension)
		const deltaDeclination = target.declination - this.#mechanical.declination
		const span = Math.max(Math.abs(deltaRightAscension), Math.abs(deltaDeclination))
		if (span === 0) return [0, 0]

		const scale = speed / span
		return [deltaRightAscension * scale, deltaDeclination * scale]
	}

	// Moves the mount along the commanded slew vector, returning how many seconds of the step were left
	// unspent once it arrived, which is zero while the slew is still running.
	#advanceSlew(dtSeconds: number) {
		const target = this.#slewTarget

		if (!target) return dtSeconds

		// Time left in the step after the slew ends, which is none while it is still running.
		let remaining = 0
		const speed = this.#manualSlewSpeed() * SLEW_SPEED_FACTOR
		const maxStep = speed * dtSeconds
		const deltaRightAscension = normalizePI(target.rightAscension - this.#mechanical.rightAscension)
		const deltaDeclination = target.declination - this.#mechanical.declination
		const span = Math.max(Math.abs(deltaRightAscension), Math.abs(deltaDeclination))

		// A slew drives the axes directly rather than through the transmission model, since backlash is
		// negligible against a slew and its own dynamics belong with the slew profile. The travel is still
		// reported to the transmission, which leaves it in the state a real mount is in after a goto: the
		// slack taken up on the flank the slew ran on, so continuing that way is immediate and reversing
		// costs the full backlash.
		//
		// Reported before the arrival branch, because a goto short enough to fit inside one step goes
		// through that branch and never reaches the code below it. The transmission was then left loaded
		// by whatever moved the axes before the goto, so a reversing pulse afterwards moved at once
		// instead of spending itself on the slack the slew had just opened.
		const travelled = span > 0 ? Math.min(1, maxStep / span) : 0
		driveMechanicalAxis(this.#rightAscensionAxis, Math.sign(deltaRightAscension) as AxisDirection, Math.abs(deltaRightAscension) * travelled, this.#rightAscensionTransmission)
		driveMechanicalAxis(this.#declinationAxis, Math.sign(deltaDeclination) as AxisDirection, Math.abs(deltaDeclination) * travelled, this.#declinationTransmission)

		if (span <= maxStep || span === 0) {
			// Fraction of the step still unspent when the axes reach the target. The ring-down excited
			// below starts at that instant, not at the beginning of the step, and at the default tick a
			// few-hertz resonance covers a good part of a cycle in one step, so integrating it over the
			// whole interval would shift its phase or swallow the first overshoot outright.
			remaining = maxStep > 0 ? dtSeconds * (1 - span / maxStep) : 0
			this.#setMechanical(target.rightAscension, target.declination)
			// The axes come to a stop, so static friction has to be overcome again before the tracking
			// or guiding that follows produces any motion.
			resetMechanicalAxisMotion(this.#rightAscensionAxis)
			resetMechanicalAxisMotion(this.#declinationAxis)
			// Arriving is abrupt, so the structure carries on and rings. How hard depends on how fast the
			// axes were running, which is why a slow slew settles more gently than a fast one; each axis
			// is excited in proportion to its own share of the motion. A zero span means the mount was
			// already on target and never moved, so nothing is excited.
			//
			// The share is signed, because an overshoot carries on in the direction the axis was
			// travelling. Feeding the magnitude alone made every stop ring north and west first, so a
			// southward slew began by moving north of its target, which is a rebound rather than an
			// overshoot.
			if (span > 0) {
				const severity = this.#manualSlewSpeed() / SLEW_RATES.at(-1)!.speed
				exciteSettling(this.#rightAscensionSettling, (severity * deltaRightAscension) / span, this.#settlingConfig)
				exciteSettling(this.#declinationSettling, (severity * deltaDeclination) / span, this.#settlingConfig)
			}

			const mode = this.#slewMode
			this.#slewMode = undefined
			this.#slewTarget = undefined
			this.#setSlewing(false)
			this.#setHoming(false)

			// Homing zeroes the encoders on a sensor that does not trip in exactly the same place twice,
			// so the mount ends up believing it is at the home position while the axes sit a little off
			// it. Every coordinate derived afterwards inherits that difference, which is where an index
			// error comes from in the first place. Redrawn on each home, so two homings in a row disagree.
			if (mode === 'HOME') this.#scatterHome()

			if (mode === 'PARK') {
				this.#setParking(false, true)
				this.setTrackingEnabled(false)
			} else {
				this.#setParking(false)
			}

			return remaining
		}

		const scale = maxStep / span
		this.#setMechanical(this.#mechanical.rightAscension + deltaRightAscension * scale, this.#mechanical.declination + deltaDeclination * scale)
		return 0
	}

	// Advances tracking, manual motion and pulse guiding when not slewing.
	//
	// The motors and the sky are accounted for separately, because backlash and stiction sit between
	// the motor and the axis while the sky turns regardless of what the transmission does. The motor
	// rates go through the transmission model, and the sidereal drift is added to the result: with the
	// motors stopped the coordinate still drifts eastward, and a perfectly tracking mount is one whose
	// motor exactly cancels that drift.
	#advanceFreeMotion(dtSeconds: number) {
		const rightAscensionMotorRate = this.#rightAscensionMotorRate()
		let declinationMotorRate = 0

		if (this.#manualNorthSouth !== 0) declinationMotorRate += this.#manualNorthSouth * this.#manualSlewSpeed()
		declinationMotorRate += this.#guideRateNorthSouth

		const rightAscensionStep = advanceMechanicalAxis(this.#rightAscensionAxis, rightAscensionMotorRate, dtSeconds, this.#rightAscensionTransmission)
		const declinationStep = advanceMechanicalAxis(this.#declinationAxis, declinationMotorRate, dtSeconds, this.#declinationTransmission)
		const rightAscensionDelta = SIDEREAL_DRIFT_RATE * dtSeconds + rightAscensionStep

		// The drive delivers the travel the transmission let through, times one plus its rate error; the
		// encoders count only the nominal part. The excess therefore never reaches the reported
		// coordinate and accumulates as an unmodelled displacement of the optical axis. Scaling the
		// travel actually delivered rather than the commanded rate means a stuck or backlashed axis
		// contributes nothing, which is right: a drive that is not moving cannot run fast.
		if (this.#trackingRateError !== 0 && rightAscensionStep !== 0) {
			this.#trackingRateOffset += rightAscensionStep * this.#trackingRateError * 1e-6
		}

		if (rightAscensionDelta !== 0 || declinationStep !== 0) {
			this.#setMechanical(this.#mechanical.rightAscension + rightAscensionDelta, this.#mechanical.declination + declinationStep)
		}
	}

	// Moves the mechanical axes and republishes everything derived from them.
	//
	// The reported coordinate is the mechanical orientation seen through the encoder zero offsets, so a
	// configured index error makes the controller disagree with the axes without the telescope having
	// moved. Clients are never handed the boresight: a frame whose true centre differs from the
	// reported coordinate is precisely what lets plate solving measure the error.
	#setMechanical(rightAscension: Angle, declination: Angle, notify: boolean = true, force: boolean = false) {
		this.#mechanical.rightAscension = normalizeAngle(rightAscension)
		this.#mechanical.declination = clampDeclination(declination)
		this.#equatorialCoordinate.elements.RA.value = toHour(normalizeAngle(this.#mechanical.rightAscension + this.#indexErrorRightAscension))
		this.#equatorialCoordinate.elements.DEC.value = toDeg(clampDeclination(this.#mechanical.declination + this.#indexErrorDeclination))
		const pierSideChanged = this.#updatePierSide()

		if (notify && (force || this.#utcTime - this.#notifyCoordinateLastTime >= this.minimumNotifyCoordinateInterval)) {
			this.#notifyCoordinateLastTime = this.#utcTime
			this.notify(this.#equatorialCoordinate)
		}

		if (notify && pierSideChanged) this.notify(this.#pierSide)
	}

	// Publishes the live worm phase, at most once per coordinate interval.
	//
	// Driven from the simulation step rather than from `#setMechanical`, because the mount's primary
	// mode is exactly the one in which the coordinate stands still: while tracking at the sidereal rate
	// the motor travel and the sky cancel, nothing calls `#setMechanical`, and the phase that the
	// periodic error is being computed from would sit at its old published value indefinitely.
	//
	// A clock set backwards makes the elapsed interval negative, which publishes and re-registers the
	// epoch rather than going quiet until simulated time catches up.
	#notifyWormPhase() {
		if (!this.#simulatesPeriodicError || this.#periodicError.elements.RA_PERIOD.value <= 0) return

		const elapsed = this.#utcTime - this.#notifyWormPhaseLastTime
		if (elapsed >= 0 && elapsed < this.minimumNotifyCoordinateInterval) return

		this.#notifyWormPhaseLastTime = this.#utcTime
		this.#wormPhaseVector.elements.PHASE.value = toDeg(this.#wormPhase)
		this.notify(this.#wormPhaseVector)
	}

	// Draws how far the axes really sat from the home position on this homing, in radians.
	//
	// Gaussian on each axis with the configured repeatability as its standard deviation. A zero
	// repeatability makes the sensor perfect and clears any scatter left by an earlier home.
	#scatterHome() {
		const scatter = this.#simulatesMechanics ? this.#mechanics.elements.HOME_SCATTER.value * ASEC2RAD : 0

		if (scatter > 0) {
			this.#homeScatterRightAscension = this.#normal() * scatter
			this.#homeScatterDeclination = this.#normal() * scatter
		} else {
			this.#homeScatterRightAscension = 0
			this.#homeScatterDeclination = 0
		}
	}

	// Keeps the simulated pier side consistent with the current sky position.
	#updatePierSide() {
		// Derived from the mechanical orientation: which side of the pier the tube is on is a fact about
		// the axes, not about what the controller believes it is reporting.
		const pierSide = expectedPierSide(this.#mechanical.rightAscension, this.#mechanical.declination, this.#siderealTime())
		if (pierSide === this.pierSide) return false

		this.#pierSide.elements.PIER_EAST.value = pierSide === 'EAST'
		this.#pierSide.elements.PIER_WEST.value = pierSide === 'WEST'

		return true
	}

	// Computes the current local sidereal time from the simulated clock.
	#siderealTime() {
		return this.siderealTimeAt(this.#utcTime)
	}

	// Local sidereal time at `utcTime` (milliseconds since the epoch) for the configured site.
	siderealTimeAt(utcTime: number) {
		return localSiderealTime(timeUnix(utcTime / 1000, true), this.longitude)
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

	// Updates the combined pulse-guiding state from the queues.
	#updatePulsing() {
		this.#setPulsing(this.#northSouthPulses.length > 0 || this.#westEastPulses.length > 0)
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
		this.#northSouthPulses.length = 0
		this.#westEastPulses.length = 0
		this.#guideRateNorthSouth = 0
		this.#guideRateWestEast = 0
		this.#setPulsing(false)
	}

	// Hands the structure over to a slew that is taking control of the axes.
	//
	// A ring-down is a residual offset the axes carry away from where they were commanded, and the
	// oscillator pays it back as it decays so that the episode nets out to nothing. A slew that
	// interrupts one drives to its own target from wherever the axes happen to be, which absorbs that
	// residual into the move: there is no longer anything owed. Leaving the oscillator running would
	// subtract the old offset a second time as it decayed, so the mount would settle permanently short
	// of the new target by however far it had sprung from the previous one.
	#takeSlewControl() {
		resetSettling(this.#rightAscensionSettling)
		resetSettling(this.#declinationSettling)
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
		this.#setMechanical(this.#homeCoordinate.rightAscension, this.#homeCoordinate.declination, notify)
		this.#absorbAccumulatedError()
	}

	// Drops the recorded trajectory and seeds it with the present.
	//
	// Used wherever the recorded past stops describing this telescope: connecting, syncing, and setting
	// the clock the samples are indexed by. The seed sample makes the trajectory usable before the
	// first tick has run.
	//
	// Nothing but the trajectory is touched here. Rewinding or advancing the clock is a statement about
	// what time it is, not a command to the mount, so the drift a drive had walked away and the
	// excursion a structure was in the middle of both have to survive it.
	#resetBoresightHistory() {
		clearBoresightHistory(this.#boresightHistory)
		const boresight = this.boresight
		recordBoresightSample(this.#boresightHistory, this.#utcTime, boresight.rightAscension, boresight.declination)
	}

	// Re-registers the bookkeeping against the sky, as a sync does, and drops the trajectory with it.
	//
	// Every error that lives in the bookkeeping is absorbed into the new zero: the travel the drive
	// walked away silently, the offset the home sensor left behind, and any ring-down in progress,
	// which belongs to the position that was just abandoned.
	//
	// Two things deliberately survive it. The wander of the rate itself, because the drive is still the
	// same drive and starts walking again from where its rate was. And the wind, because it is a live
	// disturbance rather than an accumulated error: syncing does not make the air still.
	#absorbAccumulatedError() {
		resetSettling(this.#rightAscensionSettling)
		resetSettling(this.#declinationSettling)
		this.#trackingRateOffset = 0
		this.#homeScatterRightAscension = 0
		this.#homeScatterDeclination = 0
		this.#resetBoresightHistory()
	}
}
