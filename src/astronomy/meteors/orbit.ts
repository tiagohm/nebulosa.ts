import { ECLIPTIC_J2000_MATRIX, GM_SUN_PITJEVA_2005, PI, TAU } from '../../core/constants'
import { matIdentity, matMulVec, matTransposeMulVec } from '../../math/linear-algebra/mat3'
import { type Vec3, vecAngle, vecLength, vecNormalize } from '../../math/linear-algebra/vec3'
import { type Angle, normalizeAngle, normalizePI } from '../../math/units/angle'
import type { Velocity } from '../../math/units/velocity'
import { equatorial, relativePositionAndVelocity } from '../coordinates/astrometry'
import { earth, sun } from '../ephemeris/models/analytical/vsop87e'
import { KeplerOrbit } from '../orbits/asteroid'
import type { Time } from '../time/time'
import { meteorRadiantVector } from './radiant'
import type { MeteorComparableOrbit, MeteorCompleteStreamOrbit, MeteorHeliocentricState, MeteorNodeEncounter, MeteorRadiant } from './types'

// Meteor-stream orbital reconstruction and orbit-comparison criteria. States are heliocentric in the
// ecliptic J2000 frame, while radiants are geocentric equatorial J2000. Partial catalog elements are
// never propagated as if they carried an epoch; node encounters are evaluated geometrically instead.

// Reconstructs a heliocentric ecliptic-J2000 state from a geocentric radiant and asymptotic speed.
export function meteorHeliocentricState(radiant: MeteorRadiant, geocentricSpeed: Velocity, time: Time): MeteorHeliocentricState {
	const earthState = relativePositionAndVelocity(earthEcliptic, sunEcliptic, time)
	const radiantEquatorial = meteorRadiantVector(radiant)
	const radiantEcliptic = matMulVec(ECLIPTIC_J2000_MATRIX, radiantEquatorial)
	const velocity: Vec3 = [earthState[1][0] - geocentricSpeed * radiantEcliptic[0], earthState[1][1] - geocentricSpeed * radiantEcliptic[1], earthState[1][2] - geocentricSpeed * radiantEcliptic[2]]
	return { position: earthState[0], velocity, earthPosition: earthState[0], earthVelocity: earthState[1] }
}

// Builds a KeplerOrbit from a geocentric radiant. The input state is already ecliptic J2000, so an
// identity output rotation keeps q, i, Ω and ω in the same frame as the MDC stream elements.
export function meteorOrbitFromRadiant(radiant: MeteorRadiant, geocentricSpeed: Velocity, time: Time, mu: number = GM_SUN_PITJEVA_2005): KeplerOrbit {
	const state = meteorHeliocentricState(radiant, geocentricSpeed, time)
	return new KeplerOrbit(state.position, state.velocity, time, mu, matIdentity())
}

// Evaluates both ascending and descending stream-node encounter candidates at an instant. No
// candidate is silently selected based on distance; the caller decides the physical encounter limit.
export function meteorStreamOrbitNodeEncounters(stream: MeteorCompleteStreamOrbit, time: Time, mu: number = GM_SUN_PITJEVA_2005): readonly MeteorNodeEncounter[] {
	const q = stream.perihelionDistance
	const e = stream.eccentricity

	if (!(q > 0) || !(e >= 0)) return []

	const inclination = stream.inclination
	const node = stream.longitudeOfAscendingNode
	const argument = stream.argumentOfPerihelion

	const earthState = relativePositionAndVelocity(earthEcliptic, sunEcliptic, time)
	const candidates: MeteorNodeEncounter[] = []

	for (const [kind, trueAnomaly] of [
		['ascending', -argument],
		['descending', PI - argument],
	] as const) {
		if (!(1 + e * Math.cos(trueAnomaly) > 0)) continue

		const nodeOrbit = KeplerOrbit.trueAnomaly(q * (1 + e), e, inclination, node, argument, trueAnomaly, time, mu, matIdentity())
		const position = nodeOrbit.position
		const velocity = nodeOrbit.velocity
		const relativeVelocity: Vec3 = [velocity[0] - earthState[1][0], velocity[1] - earthState[1][1], velocity[2] - earthState[1][2]]

		const speed = vecLength(relativeVelocity)
		if (!(speed > 0)) continue

		const incomingEcliptic = vecNormalize([-relativeVelocity[0], -relativeVelocity[1], -relativeVelocity[2]])
		const incomingEquatorial = matTransposeMulVec(ECLIPTIC_J2000_MATRIX, incomingEcliptic)
		const [rightAscension, declination] = equatorial(incomingEquatorial)
		candidates.push({ node: kind, radiant: { rightAscension: normalizeAngle(rightAscension), declination }, geocentricSpeed: speed, earthNodeDistance: vecLength([position[0] - earthState[0][0], position[1] - earthState[0][1], position[2] - earthState[0][2]]) })
	}

	return candidates
}

// Converts a complete KeplerOrbit into the dimensionless element shape accepted by meteor criteria.
export function meteorComparableOrbitFromKepler(orbit: KeplerOrbit): MeteorComparableOrbit | undefined {
	return comparableOrbitOf({ perihelionDistance: orbit.periapsisDistance, eccentricity: orbit.eccentricity, inclination: orbit.inclination, longitudeOfAscendingNode: orbit.longitudeOfAscendingNode, argumentOfPerihelion: orbit.argumentOfPeriapsis })
}

// Returns the Southworth-Hawkins D criterion, or undefined for an orbit singularity where perihelion
// or the ascending node is not defined.
export function meteorDSouthworthHawkins(first: MeteorComparableOrbit, second: MeteorComparableOrbit): number | undefined {
	const values = criterionGeometry(first, second)
	if (values === undefined) return undefined
	const { planeAngle, perihelionAngle } = values
	const eccentricityMean = (first.eccentricity + second.eccentricity) * 0.5
	const value = square(first.perihelionDistance - second.perihelionDistance) + square(first.eccentricity - second.eccentricity) + square(2 * Math.sin(planeAngle * 0.5)) + square(eccentricityMean * 2 * Math.sin(perihelionAngle * 0.5))
	return Math.sqrt(value)
}

// Returns the Drummond D criterion using normalized q/e differences and the perihelion-direction angle.
export function meteorDDrummond(first: MeteorComparableOrbit, second: MeteorComparableOrbit): number | undefined {
	const values = criterionGeometry(first, second)
	if (values === undefined) return undefined
	const { planeAngle, perihelionDirectionAngle } = values
	const eccentricitySum = first.eccentricity + second.eccentricity
	const perihelionSum = first.perihelionDistance + second.perihelionDistance
	if (!(eccentricitySum > 0) || !(perihelionSum > 0)) return undefined
	const eccentricityMean = eccentricitySum * 0.5
	const value = square((first.eccentricity - second.eccentricity) / eccentricitySum) + square((first.perihelionDistance - second.perihelionDistance) / perihelionSum) + square(planeAngle / PI) + square((eccentricityMean * perihelionDirectionAngle) / PI)
	return Math.sqrt(value)
}

// Returns Jopek's hybrid D criterion, or undefined at an orbital-element singularity.
export function meteorDJopek(first: MeteorComparableOrbit, second: MeteorComparableOrbit): number | undefined {
	const values = criterionGeometry(first, second)
	if (values === undefined) return undefined
	const { planeAngle, perihelionAngle } = values
	const eccentricityMean = (first.eccentricity + second.eccentricity) * 0.5
	const perihelionSum = first.perihelionDistance + second.perihelionDistance
	if (!(perihelionSum > 0)) return undefined
	const value = square(first.eccentricity - second.eccentricity) + square((first.perihelionDistance - second.perihelionDistance) / perihelionSum) + square(2 * Math.sin(planeAngle * 0.5)) + square(eccentricityMean * 2 * Math.sin(perihelionAngle * 0.5))
	return Math.sqrt(value)
}

function criterionGeometry(first: MeteorComparableOrbit, second: MeteorComparableOrbit) {
	if (!validComparableOrbit(first) || !validComparableOrbit(second)) return undefined
	const normal1 = orbitalNormal(first)
	const normal2 = orbitalNormal(second)
	const planeAngle = vecAngle(normal1, normal2)
	const perihelion1 = perihelionDirection(first)
	const perihelion2 = perihelionDirection(second)
	const perihelionAngle = mutualNodePerihelionAngle(first, second, planeAngle)
	if (perihelionAngle === undefined) return undefined
	return { planeAngle, perihelionAngle, perihelionDirectionAngle: vecAngle(perihelion1, perihelion2) }
}

// Computes the Southworth-Hawkins/Jopek longitude-of-perihelion separation Π from the mutual node.
// The denominator vanishes only when the plane orientations make that mutual-node direction singular.
function mutualNodePerihelionAngle(first: MeteorComparableOrbit, second: MeteorComparableOrbit, planeAngle: Angle): Angle | undefined {
	const cosineHalfPlaneAngle = Math.cos(planeAngle * 0.5)
	if (!(Math.abs(cosineHalfPlaneAngle) > 1e-12)) return undefined
	const nodeDifference = normalizePI(second.longitudeOfAscendingNode - first.longitudeOfAscendingNode)
	const numerator = Math.cos((first.inclination + second.inclination) * 0.5) * Math.sin(nodeDifference * 0.5)
	const correction = 2 * Math.asin(Math.max(-1, Math.min(1, numerator / cosineHalfPlaneAngle)))
	return second.argumentOfPerihelion - first.argumentOfPerihelion + correction
}

function comparableOrbitOf(orbit: MeteorComparableOrbit): MeteorComparableOrbit | undefined {
	return validComparableOrbit(orbit) ? orbit : undefined
}

function validComparableOrbit(orbit: MeteorComparableOrbit): boolean {
	return (
		orbit.perihelionDistance > 0 &&
		orbit.eccentricity > 0 &&
		Math.abs(Math.sin(orbit.inclination)) > 1e-12 &&
		Number.isFinite(orbit.perihelionDistance) &&
		Number.isFinite(orbit.eccentricity) &&
		Number.isFinite(orbit.inclination) &&
		Number.isFinite(orbit.longitudeOfAscendingNode) &&
		Number.isFinite(orbit.argumentOfPerihelion)
	)
}

function orbitalNormal(orbit: MeteorComparableOrbit): Vec3 {
	const sine = Math.sin(orbit.inclination)
	return [sine * Math.sin(orbit.longitudeOfAscendingNode), -sine * Math.cos(orbit.longitudeOfAscendingNode), Math.cos(orbit.inclination)]
}

function perihelionDirection(orbit: MeteorComparableOrbit): Vec3 {
	const longitude = orbit.longitudeOfAscendingNode
	const argument = orbit.argumentOfPerihelion
	const cosineInclination = Math.cos(orbit.inclination)
	const cosineArgument = Math.cos(argument)
	const sineArgument = Math.sin(argument)
	return [Math.cos(longitude) * cosineArgument - Math.sin(longitude) * sineArgument * cosineInclination, Math.sin(longitude) * cosineArgument + Math.cos(longitude) * sineArgument * cosineInclination, sineArgument * Math.sin(orbit.inclination)]
}

function square(value: number): number {
	return value * value
}

function earthEcliptic(time: Time) {
	return earth(time, 'eclipticJ2000')
}

function sunEcliptic(time: Time) {
	return sun(time, 'eclipticJ2000')
}

// Keep a direct identity use in this module explicit for consumers comparing orbital frame choices.
export const METEOR_ORBIT_FRAME_ROTATION = matIdentity()

// Avoid an accidental unused dependency in declaration generation while documenting the full-period
// angular range used by the nodal geometry.
export const METEOR_ORBIT_ANGLE_PERIOD = TAU
