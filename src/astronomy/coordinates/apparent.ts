import { DAYSEC, LIGHT_TIME_AU } from '../../core/constants'
import { type MutVec3, type Vec3, vecClone, vecDistance, vecDivScalar, vecDot, vecLength, vecMinus, vecMulScalar, vecNormalizeMut } from '../../math/linear-algebra/vec3'
import type { Distance } from '../../math/units/distance'
import type { Time } from '../time/time'
import { DEFAULT_LIGHT_TIME_ITERATIONS, lightTimeSolution, type PositionAndVelocityOverTime } from './astrometry'
import { annualAberration } from './correction'
import { eraLd, eraLdn, type LdBody } from './erfa/erfa'

// High-level apparent-place pipeline in barycentric ICRS/BCRS axes: light-time-corrected
// astrometric direction, then gravitational deflection by explicitly supplied Solar-System
// bodies, then observer aberration. Distances are AU, velocities AU/day, angles radians, and
// light time days. The output apparent vector is a unit direction; the light-time distance is
// kept separately and is never recovered from the normalized result. Precession, nutation,
// Earth rotation, horizontal conversion, and atmospheric refraction are not applied. There is
// no hidden ephemeris: every body state, including the Sun, is a caller-supplied provider.

// Light time for 1 AU, in days. Matches ERFA eraLdn's CR = AULT/DAYSEC.
const LIGHT_TIME_DAYS_PER_AU = LIGHT_TIME_AU / DAYSEC

// Mass of the Sun in solar masses, the unit of LightDeflector.mass.
// ERFA eraLdn note 4.
export const SUN_LIGHT_DEFLECTOR_MASS = 1

// Jupiter mass in solar masses. ERFA eraLdn note 4.
export const JUPITER_LIGHT_DEFLECTOR_MASS = 0.00095435

// Saturn mass in solar masses. ERFA eraLdn note 4.
export const SATURN_LIGHT_DEFLECTOR_MASS = 0.00028574

// ERFA-style solar deflection limiter, in radians^2 / 2. ERFA eraLdn note 4.
export const SUN_LIGHT_DEFLECTOR_LIMITER = 6e-6

// ERFA-style Jupiter deflection limiter, in radians^2 / 2. ERFA eraLdn note 4.
export const JUPITER_LIGHT_DEFLECTOR_LIMITER = 3e-9

// ERFA-style Saturn deflection limiter, in radians^2 / 2. ERFA eraLdn note 4.
export const SATURN_LIGHT_DEFLECTOR_LIMITER = 3e-10

// A Solar-System body whose gravity may bend the line of sight. The caller supplies the
// barycentric state; nothing is fetched or defaulted to a particular ephemeris.
export interface LightDeflector {
	// Mass relative to the Sun, in solar masses.
	readonly mass: number
	// Barycentric ICRS position (AU) and velocity (AU/day) as a function of time.
	readonly state: PositionAndVelocityOverTime
	// ERFA-style deflection limiter, in radians^2 / 2. Caps the deflection as the source
	// approaches the body, reaching zero at coincidence.
	readonly limiter: number
}

// An owned barycentric deflector sample at reception: mass in solar masses,
// limiter in radians squared / 2, position AU, and velocity AU/day.
export interface LightDeflectorSnapshot {
	// Mass relative to the Sun.
	readonly mass: number
	// ERFA-style near-body deflection limiter, in radians squared / 2.
	readonly limiter: number
	// Barycentric position at reception, in AU.
	readonly position: Vec3
	// Barycentric velocity at reception, in AU/day.
	readonly velocity: Vec3
}

// Explicit correction inputs for an already solved astrometric direction.
export interface ApparentDirectionCorrections {
	// Apply observer aberration; default true. Requires sunPosition when enabled.
	readonly aberration?: boolean
	// Sun barycentric position at reception, in AU, for the aberration potential.
	readonly sunPosition?: Vec3
	// Deflectors in photon encounter order, all sampled at reception.
	readonly deflectors?: readonly LightDeflectorSnapshot[]
}

// Optional corrections for apparentDirection. Omitted fields keep the documented defaults.
export interface ApparentDirectionOptions {
	// Fixed-point light-time iterations for finite targets. 0 is the geometric same-epoch
	// direction. Default 3. Must be an integer in [0, 16]; other values throw rather than
	// clamp, truncate, or hang.
	readonly lightTimeIterations?: number
	// Bodies whose gravity bends the line of sight, in the order the photon encounters them.
	// Empty or omitted applies no gravitational deflection. The Sun is included only if listed.
	readonly deflectors?: readonly LightDeflector[]
	// Apply observer aberration from the full barycentric observer velocity. Default true.
	readonly aberration?: boolean
	// Sun barycentric state used for the observer-Sun distance in the aberration potential
	// term. Required when aberration is enabled; there is no 1 AU fallback.
	readonly sun?: PositionAndVelocityOverTime
}

// Light-time-corrected astrometric place and the apparent ICRS/BCRS unit direction after the
// requested gravitational deflection and aberration. Distance and light time come from the
// converged retarded solution, not from the normalized apparent vector.
export interface ApparentDirection {
	// Observer -> target unit direction after light time and before deflection or aberration.
	readonly astrometric: Vec3
	// Final ICRS/BCRS unit direction after the requested corrections.
	readonly apparent: Vec3
	// Target distance at the converged light-time solution, in AU.
	readonly distance: Distance
	// One-way light time of that distance, in days.
	readonly lightTime: number
	// Retarded target-emission time, `time - lightTime`.
	readonly emissionTime: Time
}

// Converts a finite-distance target and barycentric observer into a light-time-corrected
// astrometric direction, then optionally applies gravitational deflection and observer
// aberration. `target` and `observer` must share the barycentric ICRS/BCRS origin and
// AU / AU-day units. Correction order is light time, then each deflector in the given
// (photon-path) order via eraLd with finite-source geometry, then annualAberration.
// Returns undefined when the retarded observer-target vector is the zero vector, which
// has no sky direction. Throws if aberration is enabled (the default) and `options.sun`
// is omitted, or if `lightTimeIterations` is not an integer in [0, 16]. Returned vectors
// are freshly allocated and do not alias each other.
export function apparentDirection(target: PositionAndVelocityOverTime, observer: PositionAndVelocityOverTime, time: Time, options?: ApparentDirectionOptions): ApparentDirection | undefined {
	const aberration = options?.aberration ?? true
	const sun = options?.sun
	if (aberration && !sun) throw new Error('sun barycentric state is required when aberration is enabled')

	const iterations = options?.lightTimeIterations ?? DEFAULT_LIGHT_TIME_ITERATIONS
	const solution = lightTimeSolution(target, observer, time, iterations)
	if (!solution) return undefined

	const astrometric = vecDivScalar(solution.position, solution.distance)
	const deflectors = options?.deflectors?.map((body): LightDeflectorSnapshot => {
		const [position, velocity] = body.state(time)
		return { mass: body.mass, limiter: body.limiter, position, velocity }
	})
	const sunPosition = aberration && sun ? vecClone(sun(time)[0]) : undefined
	const apparent = applyApparentDirectionCorrections(astrometric, solution.targetEmissionPosition, solution.observerPosition, solution.observerVelocity, solution.lightTime, { aberration, sunPosition, deflectors })
	return { astrometric, apparent, distance: solution.distance, lightTime: solution.lightTime, emissionTime: solution.emissionTime }
}

// Applies finite-distance deflection followed by observer aberration to a unit
// retarded direction in ICRS/BCRS axes. Inputs are snapshots: positions AU,
// observer velocity AU/day, and light time days. Returns a fresh unit vector;
// the input direction and snapshots are not mutated.
export function applyApparentDirectionCorrections(astrometric: Vec3, targetEmissionPosition: Vec3, observerPosition: Vec3, observerVelocity: Vec3, lightTimeDays: number, options: ApparentDirectionCorrections): MutVec3 {
	const aberration = options.aberration ?? true
	if (aberration && options.sunPosition === undefined) throw new Error('sun barycentric state is required when aberration is enabled')

	let apparent = vecClone(astrometric)
	if (options.deflectors?.length) applyFiniteLightDeflection(apparent, targetEmissionPosition, observerPosition, lightTimeDays, options.deflectors)

	if (aberration && options.sunPosition !== undefined) {
		const sunDistance = vecDistance(observerPosition, options.sunPosition)
		apparent = annualAberration(apparent, observerVelocity, sunDistance)
	} else {
		vecNormalizeMut(apparent)
	}

	return apparent
}

// Applies ERFA multi-body light deflection for a star at infinity. `direction` is the
// observer -> star coordinate direction (unit vector, ICRS/BCRS), `observerBarycentricPosition`
// is the observer's barycentric position in AU, and `deflectors` are snapshot LdBody states at
// the epoch of observation. Returns a freshly allocated natural direction; the input is not
// mutated. This is the eraLdn fast path and must not be used for finite-distance Solar-System
// targets, which need a distinct deflector -> source vector.
export function deflectStarlight(direction: Vec3, observerBarycentricPosition: Vec3, deflectors: readonly LdBody[]): MutVec3 {
	return eraLdn(deflectors, observerBarycentricPosition, direction)
}

// Applies gravitational deflection for a finite-distance source, writing the corrected unit-ish
// direction into `direction` in place. For each body the photon is backtracked to closest
// approach, clipped to the observer-target light time so a deflector beyond the target is
// evaluated at emission rather than treated as a star-at-infinity mass on the ray. `p` is the
// current observer -> target direction; `q` is deflector -> target at that retarded epoch.
function applyFiniteLightDeflection(direction: MutVec3, targetEmission: Vec3, observerPosition: Vec3, lightTimeDays: number, deflectors: readonly LightDeflectorSnapshot[]) {
	const op = observerPosition
	const te = targetEmission
	const e: MutVec3 = [0, 0, 0]
	const q: MutVec3 = [0, 0, 0]

	for (const deflector of deflectors) {
		const bp = deflector.position
		const bv = deflector.velocity
		const observerToBody = vecMinus(bp, op)

		// Time since the photon passed closest to the body, in days. Negative means the body
		// lies behind the observer along the incoming ray and is not backtracked.
		let delay = vecDot(direction, observerToBody) * LIGHT_TIME_DAYS_PER_AU
		if (!(delay > 0)) delay = 0
		else if (delay > lightTimeDays) delay = lightTimeDays

		// Linear backtrack of the body to the closest-approach epoch, as in ERFA eraLdn.
		vecMinus(bp, vecMulScalar(bv, delay, e), e)

		vecMinus(te, e, q)
		const qm = vecLength(q)
		if (!(qm > 0)) continue

		vecMinus(op, e, e)
		const em = vecLength(e)
		if (!(em > 0)) continue

		vecDivScalar(e, em, e)
		vecDivScalar(q, qm, q)
		eraLd(deflector.mass, direction, q, e, em, deflector.limiter, direction)
	}
}
