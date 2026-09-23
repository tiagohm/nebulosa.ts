import { DAYSEC, LIGHT_TIME_AU } from '../../core/constants'
import { type MutVec3, type Vec3, vecClone, vecDistance, vecDivScalar, vecLength } from '../../math/linear-algebra/vec3'
import type { Distance } from '../../math/units/distance'
import { type Time, timeShift } from '../time/time'
import { DEFAULT_LIGHT_TIME_ITERATIONS, lightTime, type PositionAndVelocityOverTime, topocentricDirection, validateLightTimeIterations } from './astrometry'
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

	const [observerPosition, observerVelocity] = observer(time)
	const iterations = options?.lightTimeIterations ?? DEFAULT_LIGHT_TIME_ITERATIONS
	// Rejects Infinity (unbounded loop), negatives (silent undefined), and fractions
	// (truncated iteration count) before delegating to topocentricDirection.
	validateLightTimeIterations(iterations)
	const astrometricVector = topocentricDirection(target, observer, time, iterations)
	const distance = vecLength(astrometricVector)
	if (!(distance > 0)) return undefined

	const tau = lightTime(astrometricVector)
	const emissionTime = timeShift(time, -tau)
	const astrometric = vecDivScalar(astrometricVector, distance)
	let apparent: MutVec3 = vecClone(astrometric)

	const deflectors = options?.deflectors
	if (deflectors && deflectors.length > 0) {
		const targetEmission: Vec3 = [observerPosition[0] + astrometricVector[0], observerPosition[1] + astrometricVector[1], observerPosition[2] + astrometricVector[2]]
		applyFiniteLightDeflection(apparent, targetEmission, observerPosition, time, tau, deflectors)
	}

	if (aberration && sun) {
		const sunDistance = vecDistance(observerPosition, sun(time)[0])
		apparent = annualAberration(apparent, observerVelocity, sunDistance)
	} else {
		const len = vecLength(apparent)
		if (len > 0) vecDivScalar(apparent, len, apparent)
	}

	return { astrometric, apparent, distance, lightTime: tau, emissionTime }
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
function applyFiniteLightDeflection(direction: MutVec3, targetEmission: Vec3, observerPosition: Vec3, time: Time, lightTimeDays: number, deflectors: readonly LightDeflector[]) {
	const [ox, oy, oz] = observerPosition
	const [tx, ty, tz] = targetEmission
	const e: MutVec3 = [0, 0, 0]
	const q: MutVec3 = [0, 0, 0]

	for (const deflector of deflectors) {
		const [bp, bv] = deflector.state(time)
		const observerToBodyX = bp[0] - ox
		const observerToBodyY = bp[1] - oy
		const observerToBodyZ = bp[2] - oz

		// Time since the photon passed closest to the body, in days. Negative means the body
		// lies behind the observer along the incoming ray and is not backtracked.
		let delay = (direction[0] * observerToBodyX + direction[1] * observerToBodyY + direction[2] * observerToBodyZ) * LIGHT_TIME_DAYS_PER_AU
		if (!(delay > 0)) delay = 0
		else if (delay > lightTimeDays) delay = lightTimeDays

		// Linear backtrack of the body to the closest-approach epoch, as in ERFA eraLdn.
		const bcx = bp[0] - delay * bv[0]
		const bcy = bp[1] - delay * bv[1]
		const bcz = bp[2] - delay * bv[2]

		e[0] = ox - bcx
		e[1] = oy - bcy
		e[2] = oz - bcz
		const em = Math.hypot(e[0], e[1], e[2])
		if (!(em > 0)) continue

		q[0] = tx - bcx
		q[1] = ty - bcy
		q[2] = tz - bcz
		const qm = Math.hypot(q[0], q[1], q[2])
		if (!(qm > 0)) continue

		vecDivScalar(e, em, e)
		vecDivScalar(q, qm, q)
		eraLd(deflector.mass, direction, q, e, em, deflector.limiter, direction)
	}
}
