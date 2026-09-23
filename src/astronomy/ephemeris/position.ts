import { type Vec3, vecClone, vecDivScalar } from '../../math/linear-algebra/vec3'
import type { Distance } from '../../math/units/distance'
import { applyApparentDirectionCorrections, type LightDeflectorSnapshot } from '../coordinates/apparent'
import { DEFAULT_LIGHT_TIME_ITERATIONS, lightTimeSolution } from '../coordinates/astrometry'
import type { Time } from '../time/time'
import { type EphemerisEndpoint, type EphemerisPath, sameEphemerisEndpoint, SOLAR_SYSTEM_BARYCENTER } from './path'

// Owned geometric and retarded astrometric positions from prepared synchronous
// ephemeris paths. Vectors use ICRS/BCRS-oriented axes, positions AU, velocities
// AU/day, and light time days. No implicit ephemeris or frame conversion occurs.

// A same-epoch target state relative to its declared center.
export interface GeometricPosition {
	// Discriminant for the uncorrected Cartesian stage.
	readonly kind: 'geometric'
	// Evaluation epoch.
	readonly time: Time
	// Origin of position and velocity.
	readonly center: EphemerisEndpoint
	// Body or point represented by the state.
	readonly target: EphemerisEndpoint
	// Center-to-target position, in AU.
	readonly position: Vec3
	// Center-to-target velocity, in AU/day.
	readonly velocity: Vec3
}

// A retarded observer-to-target state before gravitational deflection or aberration.
// The target is sampled at emission; the observer is sampled at reception.
export interface AstrometricPosition {
	// Discriminant for the light-time-corrected direction stage.
	readonly kind: 'astrometric'
	// Reception epoch at the observer.
	readonly time: Time
	// Emission epoch inferred from the final light-time vector.
	readonly emissionTime: Time
	// Observer endpoint, represented by an SSB-centered path.
	readonly center: EphemerisEndpoint
	// Target endpoint, represented by an SSB-centered path.
	readonly target: EphemerisEndpoint
	// Retarded observer-to-target vector, in AU.
	readonly position: Vec3
	// Unit direction toward the retarded target in ICRS/BCRS-oriented axes.
	readonly direction: Vec3
	// Retarded observer-target distance, in AU.
	readonly distance: Distance
	// One-way light time of that distance, in days.
	readonly lightTime: number
	// Observer barycentric position at reception, in AU.
	readonly observerPosition: Vec3
	// Observer barycentric velocity at reception, in AU/day.
	readonly observerVelocity: Vec3
	// Target barycentric position from the last emission sample, in AU.
	readonly targetEmissionPosition: Vec3
}

// Options for the bounded fixed-point retarded observation.
export interface EphemerisObserveOptions {
	// Number of refinements, an integer in [0, 16]; default 3.
	readonly lightTimeIterations?: number
}

// A body whose gravity bends light from a finite-distance target. Its path
// must be SSB-centered and is sampled at the observer's reception epoch.
export interface EphemerisLightDeflector {
	// Body mass relative to the Sun.
	readonly mass: number
	// ERFA near-body limiter, in radians squared / 2.
	readonly limiter: number
	// SSB-to-body state provider in AU and AU/day.
	readonly path: EphemerisPath
}

// Explicit correction sources for the high-level apparent stage.
export interface EphemerisApparentOptions {
	// Apply observer aberration; default true. Requires an SSB-to-Sun path.
	readonly aberration?: boolean
	// SSB-to-Sun path used for the aberration potential term.
	readonly sun?: EphemerisPath
	// SSB-centered deflectors in photon encounter order; none are implicit.
	readonly deflectors?: readonly EphemerisLightDeflector[]
}

// An ICRS/BCRS-oriented apparent unit direction after explicit gravitational
// deflection and observer aberration. Distance and light time remain astrometric.
export interface ApparentPosition {
	// Discriminant for the corrected direction stage.
	readonly kind: 'apparent'
	// Observer reception epoch.
	readonly time: Time
	// Retarded target emission epoch.
	readonly emissionTime: Time
	// Observer endpoint.
	readonly center: EphemerisEndpoint
	// Target endpoint.
	readonly target: EphemerisEndpoint
	// Corrected unit direction in ICRS/BCRS-oriented axes.
	readonly direction: Vec3
	// Astrometric observer-target distance, in AU.
	readonly distance: Distance
	// One-way light time, in days.
	readonly lightTime: number
}

// Materializes a prepared path at one epoch and owns both returned vectors.
// No correction or coordinate-frame transform is applied.
export function ephemerisAt(path: EphemerisPath, time: Time): GeometricPosition {
	const [position, velocity] = path.stateAt(time)
	return { kind: 'geometric', time, center: path.center, target: path.target, position: vecClone(position), velocity: vecClone(velocity) }
}

// Observes an SSB-centered target from an SSB-centered observer. The two paths
// must use barycentric coordinates because moving-center states cannot be retarded
// independently without changing the observer's reception-time origin. Returns
// undefined for coincident points, which have no direction. All vectors are owned.
export function observeEphemeris(observer: EphemerisPath, target: EphemerisPath, time: Time, options?: EphemerisObserveOptions): AstrometricPosition | undefined {
	if (!sameEphemerisEndpoint(observer.center, SOLAR_SYSTEM_BARYCENTER)) throw new Error('observer ephemeris path must be SSB-centered')
	if (!sameEphemerisEndpoint(target.center, SOLAR_SYSTEM_BARYCENTER)) throw new Error('target ephemeris path must be SSB-centered')
	const iterations = options?.lightTimeIterations ?? DEFAULT_LIGHT_TIME_ITERATIONS
	const solution = lightTimeSolution(target.stateAt, observer.stateAt, time, iterations)
	if (!solution) return undefined
	return {
		kind: 'astrometric',
		time,
		emissionTime: solution.emissionTime,
		center: observer.target,
		target: target.target,
		position: solution.position,
		direction: vecDivScalar(solution.position, solution.distance),
		distance: solution.distance,
		lightTime: solution.lightTime,
		observerPosition: solution.observerPosition,
		observerVelocity: solution.observerVelocity,
		targetEmissionPosition: solution.targetEmissionPosition,
	}
}

// Applies explicit finite-distance gravitational deflection and observer
// aberration to an astrometric position. Requires an SSB-centered Sun path when
// aberration is enabled and SSB-centered paths for every deflector. Snapshots
// providers before correction; returns an owned direction and retains distance.
export function apparentPosition(position: AstrometricPosition, options?: EphemerisApparentOptions): ApparentPosition {
	const aberration = options?.aberration ?? true
	const sun = options?.sun
	if (aberration && !sun) throw new Error('sun barycentric state is required when aberration is enabled')
	if (aberration && sun && !sameEphemerisEndpoint(sun.center, SOLAR_SYSTEM_BARYCENTER)) throw new Error('sun ephemeris path must be SSB-centered')
	for (const body of options?.deflectors ?? []) {
		if (!sameEphemerisEndpoint(body.path.center, SOLAR_SYSTEM_BARYCENTER)) throw new Error('light deflector ephemeris path must be SSB-centered')
	}
	const deflectors = options?.deflectors?.map((body): LightDeflectorSnapshot => {
		const [bodyPosition, bodyVelocity] = body.path.stateAt(position.time)
		return { mass: body.mass, limiter: body.limiter, position: vecClone(bodyPosition), velocity: vecClone(bodyVelocity) }
	})
	const sunPosition = aberration && sun ? vecClone(sun.stateAt(position.time)[0]) : undefined
	const direction = applyApparentDirectionCorrections(position.direction, position.targetEmissionPosition, position.observerPosition, position.observerVelocity, position.lightTime, { aberration, sunPosition, deflectors })
	return { kind: 'apparent', time: position.time, emissionTime: position.emissionTime, center: position.center, target: position.target, direction, distance: position.distance, lightTime: position.lightTime }
}
