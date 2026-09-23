import { type Vec3, vecClone, vecDivScalar } from '../../math/linear-algebra/vec3'
import type { Distance } from '../../math/units/distance'
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
