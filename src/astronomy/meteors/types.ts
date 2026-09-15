import type { Mat3 } from '../../math/linear-algebra/mat3'
import type { Vec3 } from '../../math/linear-algebra/vec3'
import type { Angle } from '../../math/units/angle'
import type { Distance } from '../../math/units/distance'
import type { Velocity } from '../../math/units/velocity'
import type { RiseTransitSet, RiseTransitSetOptions } from '../events/horizon'
import type { TimeSearchOptions } from '../events/search'
import type { Ellipsoid, GeographicPosition } from '../observer/location'
import type { Time } from '../time/time'

// Normalized meteor-shower records and the value objects shared by catalog, activity,
// observation, trajectory and orbital computations. Angles are radians, distances AU,
// velocities AU/day, and times retain their explicit Timescale.

// Public interpretation of an IAU MDC shower status.
export type MeteorShowerStatus = 'working' | 'established' | 'toBeEstablished' | 'removed' | 'unknown'

// Provenance of an imported meteor catalog.
export interface MeteorCatalogMetadata {
	// Human-readable catalog source.
	readonly source: string
	// Source version or release identifier.
	readonly version?: string
	// Stable source URL, when supplied by the adapter.
	readonly url?: string
	// Instant at which a remote source was retrieved.
	readonly retrievedAt?: Date
}

// A normalized meteor shower with all of its catalog solutions preserved in source order.
export interface MeteorShower {
	// Catalog's record identifier, such as the MDC LP value.
	readonly catalogRecordId?: string
	// IAU shower number, when numeric.
	readonly number?: number
	// IAU three-letter code.
	readonly code?: string
	// Final or source shower name.
	readonly name: string
	// Provisional shower designation.
	readonly provisionalName?: string
	// Normalized record status.
	readonly status: MeteorShowerStatus
	// Original integer status flag.
	readonly sourceStatus?: number
	// Every published solution, without merging records.
	readonly solutions: readonly MeteorShowerSolution[]
}

// Explicit policy for selecting one solution; no implicit merging of solution properties is allowed.
export type MeteorShowerSolutionSelector = 'largestSample' | ((solutions: readonly MeteorShowerSolution[]) => MeteorShowerSolution | undefined)

// Activity label attached to one MDC solution; it is not a ZHR profile.
export interface MeteorShowerActivity {
	// Interpreted activity family.
	readonly kind: 'annual' | 'yearSpecific' | 'outburst' | 'variable' | 'irregular' | 'unknown'
	// Original source text, including unrecognized values.
	readonly source: string
	// First calendar year for a year-specific activity label.
	readonly year?: number
}

// A circular interval of geocentric solar longitude in the J2000 ecliptic.
export interface MeteorSolarLongitudeInterval {
	// Start longitude in radians; the interval advances in increasing longitude.
	readonly start: Angle
	// End longitude in radians; equality is not interpreted as a full circle.
	readonly end: Angle
}

// Published, partial stream-orbit elements in the J2000 ecliptic frame.
export interface MeteorStreamOrbit {
	// Semi-major axis in AU.
	readonly semiMajorAxis?: Distance
	// Perihelion distance q in AU.
	readonly perihelionDistance?: Distance
	// Eccentricity.
	readonly eccentricity?: number
	// Argument of perihelion in radians.
	readonly argumentOfPerihelion?: Angle
	// Longitude of ascending node in radians.
	readonly longitudeOfAscendingNode?: Angle
	// Inclination in radians.
	readonly inclination?: Angle
}

// Complete stream elements required by geometric node-encounter calculations. Unlike
// MeteorStreamOrbit, these fields cannot be absent because the two nodal positions need q, e, i, Ω
// and ω; the type carries no epoch or mean anomaly and is therefore not a propagation state.
export interface MeteorCompleteStreamOrbit extends MeteorStreamOrbit {
	// Perihelion distance q in AU.
	readonly perihelionDistance: Distance
	// Eccentricity.
	readonly eccentricity: number
	// Argument of perihelion in radians.
	readonly argumentOfPerihelion: Angle
	// Longitude of ascending node in radians.
	readonly longitudeOfAscendingNode: Angle
	// Inclination in radians.
	readonly inclination: Angle
}

// Unit-aware radiant drift published either per day or per solar-longitude radian.
export type MeteorRadiantDrift =
	| {
			// The rates are radians per day.
			readonly basis: 'day'
			readonly rightAscensionRate: number
			readonly declinationRate: number
	  }
	| {
			// The rates are radians per radian of solar longitude.
			readonly basis: 'solarLongitude'
			readonly rightAscensionRate: number
			readonly declinationRate: number
	  }

// One normalized solution from the IAU MDC stream catalog.
export interface MeteorShowerSolution {
	// Source record identifier.
	readonly catalogRecordId?: string
	// Source solution identifier, normally AdNo.
	readonly solutionId?: string
	// Solution status, when different from the record status.
	readonly status?: MeteorShowerStatus
	// Original solution status integer.
	readonly sourceStatus?: number
	// Open-ended activity classification.
	readonly activity: MeteorShowerActivity
	// Published activity support in solar longitude.
	readonly activityInterval?: MeteorSolarLongitudeInterval
	// Mean activity solar longitude, not a ZHR maximum.
	readonly referenceSolarLongitude?: Angle
	// Geocentric J2000 right ascension in radians.
	readonly rightAscension?: Angle
	// Geocentric J2000 declination in radians.
	readonly declination?: Angle
	// Radiant drift with an explicit unit basis.
	readonly radiantDrift?: MeteorRadiantDrift
	// Asymptotic geocentric speed Vg in AU/day.
	readonly geocentricSpeed?: Velocity
	// J2000 ecliptic radiant longitude in radians.
	readonly eclipticLongitude?: Angle
	// J2000 ecliptic radiant latitude in radians.
	readonly eclipticLatitude?: Angle
	// Sun-centered ecliptic radiant longitude in radians.
	readonly sunCenteredEclipticLongitude?: Angle
	// Partial J2000 ecliptic stream-orbit elements.
	readonly orbit?: MeteorStreamOrbit
	// Number of identified stream members.
	readonly memberCount?: number
	// Parent-body source text.
	readonly parentBody?: string
	// Main complex-group code.
	readonly group?: number
	// Normalized observation technique.
	readonly observationTechnique?: MeteorObservationTechnique
	// Source submission date text.
	readonly submissionDate?: string
	// Source flags text.
	readonly sourceFlags?: string
	// Source references preserved as text.
	readonly reference?: string
	// Source remarks text.
	readonly remarks?: string
}

// Normalized observation-technique label.
export type MeteorObservationTechnique = 'ccd' | 'photo' | 'radar' | 'tv' | 'visual' | 'unknown'

// Geocentric radiant in the equatorial J2000 frame.
export interface MeteorRadiant {
	// Right ascension in radians, normally [0, 2π).
	readonly rightAscension: Angle
	// Declination in radians.
	readonly declination: Angle
}

// Shared per-instant values used by batch radiant and activity calculations.
export interface MeteorComputationContext {
	// Evaluation instant.
	readonly time: Time
	// Geocentric geometric solar longitude in the J2000 ecliptic.
	readonly solarLongitude: Angle
	// Apparent local sidereal time in radians, when an observer is involved.
	readonly localSiderealTime?: Angle
	// Optional geocentric J2000 Sun vector.
	readonly sun?: Vec3
	// Optional geocentric J2000 Moon vector.
	readonly moon?: Vec3
}

// Radiant result with an explicit indication that a catalog value was extrapolated.
export interface MeteorRadiantResult {
	// Computed geocentric J2000 radiant.
	readonly radiant: MeteorRadiant
	// True when a drift was evaluated away from its reference point.
	readonly extrapolated: boolean
}

// Options for drift evaluation.
export interface MeteorRadiantOptions {
	// Permit applying a drift away from the catalog reference; defaults to true.
	readonly extrapolate?: boolean
	// Maximum allowed extrapolation in days for a daily drift.
	readonly maxExtrapolationDays?: number
	// Maximum allowed signed solar-longitude displacement for a longitude drift.
	readonly maxExtrapolationSolarLongitude?: Angle
	// Solar-longitude inversion options used by a daily drift.
	readonly solarLongitudeSearch?: TimeSearchOptions
}

// A radiant after conversion to the true equator of date and the local geometric horizon.
export interface MeteorHorizontalRadiant extends MeteorRadiant {
	// Right ascension in the equator/equinox of date, radians.
	readonly rightAscensionOfDate: Angle
	// Declination in the equator/equinox of date, radians.
	readonly declinationOfDate: Angle
	// North-through-east azimuth in radians.
	readonly azimuth: Angle
	// Geometric altitude in radians, without atmospheric refraction.
	readonly altitude: Angle
	// Instant at which the horizontal coordinates were evaluated.
	readonly time: Time
}

// Options shared by the gravitational radiant transformations.
export interface MeteorGravityOptions {
	// Geocentric asymptotic speed Vg in AU/day.
	readonly geocentricSpeed: Velocity
	// Height above the selected ellipsoid in AU.
	readonly entryAltitude: Distance
	// Reference ellipsoid used for the entry radius.
	readonly ellipsoid?: Ellipsoid
}

// An observed visual meteor count and its correction factors.
export interface MeteorVisualObservation {
	// Number of meteors counted.
	readonly count: number
	// Effective observing time in hours.
	readonly effectiveTime: number
	// Limiting stellar magnitude.
	readonly limitingMagnitude: number
	// Population index r.
	readonly populationIndex: number
	// Obstruction correction F, with F >= 1.
	readonly obstructionCorrection: number
	// Mean geometric radiant altitude in radians.
	readonly radiantAltitude: Angle
	// Exponent γ in the altitude correction.
	readonly altitudeExponent?: number
}

// Time-dependent observing conditions returned to an application.
export interface MeteorObservingConditions {
	// Instant of evaluation.
	readonly time: Time
	// Geometric solar altitude in radians.
	readonly sunAltitude: Angle
	// Geometric lunar altitude in radians.
	readonly moonAltitude: Angle
	// Lunar illuminated fraction in [0, 1].
	readonly moonIllumination: number
	// Angular separation between Moon and radiant in radians.
	readonly moonRadiantSeparation: Angle
	// Current geometric horizontal radiant.
	readonly radiant: MeteorHorizontalRadiant
}

// A visual rate plus the local conditions used to compute it.
export interface MeteorVisualRate {
	// Corrected ZHR inferred from the observation.
	readonly zhr: number
	// Expected idealized local hourly rate.
	readonly localHourlyRate: number
	// Observation inputs retained for provenance.
	readonly observation: MeteorVisualObservation
}

// A continuous interval returned by the observing planner.
export interface MeteorObservingWindow {
	// Window start.
	readonly start: Time
	// Window end.
	readonly end: Time
	// Duration in hours.
	readonly durationHours: number
	// Expected integrated local count.
	readonly expectedCount: number
	// Time of the best instantaneous local rate, when finite.
	readonly bestTime?: Time
	// Best local hourly rate.
	readonly bestLocalHourlyRate: number
	// Lunar illumination at bestTime, with its instant identified by bestTime.
	readonly moonIlluminationAtBest?: number
}

// User-selectable activity profile for a shower.
export type MeteorActivityProfile = MeteorExponentialActivityProfile | MeteorSampledActivityProfile | MeteorMultiPeakActivityProfile

// Piecewise exponential ZHR profile around one maximum.
export interface MeteorExponentialActivityProfile {
	// Profile discriminator.
	readonly type: 'exponential'
	// Solar-longitude support of this component.
	readonly support: MeteorSolarLongitudeInterval
	// Solar longitude of the component maximum.
	readonly solarLongitude: Angle
	// Peak ZHR in meteors per hour.
	readonly zhr: number
	// Decay slope before maximum, per degree of solar longitude.
	readonly slopeBefore: number
	// Decay slope after maximum, per degree of solar longitude.
	readonly slopeAfter: number
}

// PCHIP-interpolated ZHR samples over a bounded support.
export interface MeteorSampledActivityProfile {
	// Profile discriminator.
	readonly type: 'sampled'
	// Solar-longitude support of the samples.
	readonly support: MeteorSolarLongitudeInterval
	// Strictly increasing samples after unwrapping within support.
	readonly samples: readonly {
		// Solar longitude of this sample in radians.
		readonly solarLongitude: Angle
		// ZHR at this sample in meteors per hour.
		readonly zhr: number
		// Optional population index at this sample.
		readonly populationIndex?: number
	}[]
}

// Sum of several exponential components.
export interface MeteorMultiPeakActivityProfile {
	// Profile discriminator.
	readonly type: 'multiPeak'
	// Components whose ZHR contributions are summed.
	readonly components: readonly MeteorExponentialActivityProfile[]
}

// A great-circle meteor trail in one declared equatorial frame.
export interface MeteorTrack {
	// Start of the observed trail.
	readonly start: MeteorRadiant
	// End of the observed trail.
	readonly end: MeteorRadiant
	// Coordinate frame; only J2000 is accepted by the geometry helpers.
	readonly frame?: 'j2000'
}

// Input to the rotation and gravity horizontal helpers.
export interface MeteorHorizontalInput {
	// North-through-east azimuth in radians.
	readonly azimuth: Angle
	// Geometric altitude in radians.
	readonly altitude: Angle
}

// Search options for converting a catalog longitude into a time.
export interface MeteorSolarLongitudeSearchOptions extends TimeSearchOptions {
	// Output time scale, UTC by default.
	readonly scale?: import('../time/time').Timescale
}

// Dates derived from catalog activity bounds and an optional external profile.
export interface MeteorShowerDates {
	// Start of catalog activity.
	readonly start?: Time
	// Time at the catalog reference solar longitude.
	readonly reference?: Time
	// End of catalog activity.
	readonly end?: Time
	// Maximum from an external activity profile only.
	readonly maximum?: Time
}

// Options for deriving shower dates.
export interface MeteorShowerDateOptions extends MeteorSolarLongitudeSearchOptions {
	// External activity profile that supplies a true maximum.
	readonly profile?: MeteorActivityProfile
	// Permit a year-specific solution to be used outside its source year.
	readonly extrapolateYearSpecific?: boolean
}

// A local visibility classification based on a complete RiseTransitSet result.
export type MeteorRadiantVisibility = 'alwaysDown' | 'alwaysUp' | 'risesAndSets' | 'risesOnly' | 'setsOnly' | 'unknown'

// Planner restrictions and numerical options.
export interface MeteorObservingWindowOptions extends TimeSearchOptions {
	// Minimum geometric radiant altitude in radians.
	readonly minimumRadiantAltitude?: Angle
	// Maximum geometric solar altitude for darkness.
	readonly maximumSolarAltitude?: Angle
	// Optional minimum Moon-radiant separation in radians.
	readonly minimumMoonRadiantSeparation?: Angle
	// Optional maximum lunar illumination.
	readonly maximumMoonIllumination?: number
	// Minimum duration in hours.
	readonly minimumDurationHours?: number
	// Observation model used to convert ZHR to a local expected rate.
	readonly limitingMagnitude?: number
	readonly populationIndex?: number
	readonly obstructionCorrection?: number
	readonly altitudeExponent?: number
	// Optional provider for explicit, time-varying rate corrections.
	readonly rateCorrection?: (time: Time, conditions: MeteorObservingConditions) => number
}

// Options used by local rise/transit/set evaluation.
export type MeteorRadiantRiseTransitSetOptions = RiseTransitSetOptions & MeteorRadiantOptions

// Result of a heliocentric radiant reconstruction.
export interface MeteorHeliocentricState {
	// Heliocentric J2000 ecliptic position in AU.
	readonly position: Vec3
	// Heliocentric J2000 ecliptic velocity in AU/day.
	readonly velocity: Vec3
	// Earth state used as the origin translation.
	readonly earthPosition: Vec3
	// Earth heliocentric velocity.
	readonly earthVelocity: Vec3
}

// Node encounter candidate generated from a partial stream orbit.
export interface MeteorNodeEncounter {
	// Geometric node selected from the stream orbit.
	readonly node: 'ascending' | 'descending'
	// Candidate geocentric radiant in J2000 equatorial coordinates.
	readonly radiant: MeteorRadiant
	// Relative geocentric speed at the node in AU/day.
	readonly geocentricSpeed: Velocity
	// Earth-to-node distance in AU at the requested instant.
	readonly earthNodeDistance: Distance
}

// A complete dimensionless orbital comparison input in the J2000 ecliptic.
export interface MeteorComparableOrbit {
	// Perihelion distance q in AU; required and positive.
	readonly perihelionDistance: Distance
	// Eccentricity; required and positive.
	readonly eccentricity: number
	// Inclination in radians.
	readonly inclination: Angle
	// Longitude of ascending node in radians.
	readonly longitudeOfAscendingNode: Angle
	// Argument of perihelion in radians.
	readonly argumentOfPerihelion: Angle
}

// Exact Poisson confidence interval for a count and its ZHR scale.
export interface MeteorGarwoodInterval {
	// Lower count-rate or ZHR bound.
	readonly lower: number
	// Upper count-rate or ZHR bound.
	readonly upper: number
}

// Keep these imports visible in generated declaration output for consumers that use the aliases.
export type { GeographicPosition, Mat3, RiseTransitSet, Time }
