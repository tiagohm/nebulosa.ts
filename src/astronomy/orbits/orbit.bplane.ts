import { GM_EARTH } from '../../core/constants'
import { type Vec3, vecCross, vecDivScalar, vecDot, vecLength, vecMinus, vecMulScalar, vecPlus } from '../../math/linear-algebra/vec3'

// B-plane (target-plane) reduction of a planetary close approach. Near a flyby the small body's motion
// relative to the planet is, for a few hours, a two-body hyperbola; the B-plane is the plane through the
// planet centre perpendicular to the incoming asymptote, and the B-vector runs from the planet centre to
// where that asymptote pierces it. Its length is the impact parameter and its components on the (T, R)
// axes are the standard coordinates used for flyby targeting, gravity-assist design and asteroid impact
// and keyhole analysis. Distances are AU, velocities AU/day, gravitational parameters AU^3/day^2.
//
// The reduction takes the planetocentric relative state (body minus planet) near the encounter and forms
// the osculating hyperbola with the planet's mu. The incoming asymptote unit vector S, the B-vector, the
// hyperbolic excess speed and the closest-approach distance follow from the eccentricity vector and
// angular momentum. The (S, T, R) frame uses a reference pole: T = S x pole (normalized), R = S x T, so T
// lies in the plane the pole is normal to (the equatorial plane for the default pole).

// The B-plane geometry of a close encounter.
export interface BPlane {
	// Impact parameter |B| (AU): the perpendicular miss distance of the incoming asymptote from the planet
	// centre. Larger than the closest-approach distance because of gravitational focusing.
	readonly impactParameter: number
	// B-vector component on the T axis (AU).
	readonly bt: number
	// B-vector component on the R axis (AU).
	readonly br: number
	// Hyperbolic excess speed v-infinity (AU/day): the relative speed far from the planet.
	readonly vInfinity: number
	// Closest-approach distance, the hyperbola's periapsis radius (AU).
	readonly periapsisDistance: number
	// Incoming asymptote unit vector S (the direction the body travels far before the encounter).
	readonly sHat: Vec3
	// T axis unit vector (in the plane normal to the reference pole).
	readonly tHat: Vec3
	// R axis unit vector, completing the right-handed (S, T, R) frame.
	readonly rHat: Vec3
	// The B-vector itself (AU), from the planet centre to the asymptote's piercing point.
	readonly bVector: Vec3
}

// Options for closeApproachBPlane.
export interface BPlaneOptions {
	// Gravitational parameter of the planet (AU^3/day^2). Defaults to the Earth's.
	readonly mu?: number
	// Reference pole for the T/R axes. Defaults to the frame's north pole [0, 0, 1] (equatorial for an
	// ICRF-equatorial state), so T lies in the equatorial plane. Use the ecliptic pole to match the
	// ecliptic B-plane convention.
	readonly pole?: Vec3
}

// Below this magnitude of S x pole the reference pole is treated as parallel to the asymptote and a
// fallback reference axis is used so the T/R axes stay defined.
const POLE_PARALLEL_TOLERANCE = 1e-8

// Computes the B-plane coordinates of a hyperbolic close encounter from the planetocentric relative state.
//
// `relativePosition` and `relativeVelocity` are the body's position and velocity minus the planet's (AU,
// AU/day), taken near the encounter (ideally inside the planet's sphere of influence, where the two-body
// approximation holds). The relative orbit must be hyperbolic (positive energy); a bound relative orbit
// has no incoming asymptote and throws. The result gives the impact parameter, the (T, R) B-vector
// components, the hyperbolic excess speed and the closest-approach distance.
export function closeApproachBPlane(relativePosition: Vec3, relativeVelocity: Vec3, options?: BPlaneOptions): BPlane {
	const mu = options?.mu ?? GM_EARTH
	const pole = options?.pole ?? [0, 0, 1]

	const r = vecLength(relativePosition)
	const vSquared = vecDot(relativeVelocity, relativeVelocity)
	const energy = 0.5 * vSquared - mu / r
	if (energy <= 0) throw new Error('the relative orbit is not hyperbolic; a close approach has no incoming asymptote')

	const vInfinity = Math.sqrt(2 * energy)
	const semiMajorAxis = -mu / (2 * energy) // negative for a hyperbola

	// Angular momentum and eccentricity vector of the relative orbit.
	const angularMomentum = vecCross(relativePosition, relativeVelocity)
	const h = vecLength(angularMomentum)
	const radialVelocity = vecDot(relativePosition, relativeVelocity)
	const eccentricityVector = vecDivScalar(vecMinus(vecMulScalar(relativePosition, vSquared - mu / r), vecMulScalar(relativeVelocity, radialVelocity)), mu)
	const e = vecLength(eccentricityVector)

	const periapsisDistance = semiMajorAxis * (1 - e) // > 0 since a < 0 and e > 1
	const impactParameter = Math.abs(semiMajorAxis) * Math.sqrt(e * e - 1)

	// Orbit-plane basis: eHat toward periapsis, hHat the orbit normal, nHat the in-plane direction of
	// motion at periapsis.
	const eHat = vecDivScalar(eccentricityVector, e)
	const hHat = vecDivScalar(angularMomentum, h)
	const nHat = vecCross(hHat, eHat)

	// Incoming asymptote S = (1/e) eHat + (sqrt(e^2 - 1)/e) nHat, and the B-vector B = |B| (S x hHat).
	const branch = Math.sqrt(e * e - 1) / e
	const sHat = vecPlus(vecMulScalar(eHat, 1 / e), vecMulScalar(nHat, branch))
	const bVector = vecMulScalar(vecCross(sHat, hHat), impactParameter)

	// (S, T, R) frame: T = S x pole (normalized), R = S x T. Fall back if the pole is parallel to S.
	let tHat = vecCross(sHat, pole)
	if (vecLength(tHat) < POLE_PARALLEL_TOLERANCE) tHat = vecCross(sHat, Math.abs(sHat[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0])
	tHat = vecDivScalar(tHat, vecLength(tHat))
	const rHat = vecCross(sHat, tHat)

	return { impactParameter, bt: vecDot(bVector, tHat), br: vecDot(bVector, rHat), vInfinity, periapsisDistance, sHat, tHat, rHat, bVector }
}
