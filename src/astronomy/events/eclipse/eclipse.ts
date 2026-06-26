import { AU_KM, DAYSEC, DEG2RAD, EARTH_RADIUS_KM, LIGHT_TIME_AU, PI, SPEED_OF_LIGHT_AU_DAY, TAU, WGS84_FLATTENING } from '../../../core/constants'
import { matMulVec } from '../../../math/linear-algebra/mat3'
import { vecDivScalar, vecDot, vecMinus, vecLength, vecMulScalar } from '../../../math/linear-algebra/vec3'
import type { Point } from '../../../math/numerical/geometry'
import { clamp } from '../../../math/numerical/math'
import { type RootFindingOptions, bisection, brentRoot } from '../../../math/numerical/optimization'
import { normalizeAngle, normalizePI, type Angle } from '../../../math/units/angle'
import type { PositionAndVelocity, PositionAndVelocityOverTime } from '../../coordinates/astrometry'
import type { EquatorialCoordinate } from '../../coordinates/coordinate'
import { eraAb, eraP2s, eraEpj } from '../../coordinates/erfa/erfa'
import { eraEpv00 } from '../../coordinates/erfa/erfa.earth'
import { eraMoon98 } from '../../coordinates/erfa/erfa.moon'
import type { CylindricalProjection, ProjectionOptions, RaAxisDirection } from '../../projections/projection'
import { deltaT } from '../../time/deltat'
import { precessionNutationMatrix, timeShift, tt, type Time } from '../../time/time'

// Earth polar/equatorial radius ratio (1 - flattening).
export const F = 1 - WGS84_FLATTENING
// Reciprocal of F, used by the geographic-latitude conversion.
export const INV_F = 1 / F
// Squared eccentricity of the Earth ellipsoid used for limb flattening, e^2 = 1 - (b/a)^2.
export const EARTH_E2 = 1 - F * F
// Callers building PolynomialBesselianElements from a dynamical-time (TDT) tabulation set deltaTLongitudeCorrection to
// DELTA_T_LONGITUDE_FACTOR * deltaT; elements with UT-based mu (this module's own) use 0.
export const DELTA_T_LONGITUDE_FACTOR = 0.00417807 * DEG2RAD

const AU_IN_EARTH_RADII = AU_KM / EARTH_RADIUS_KM
// Light travel time per AU in days, used to retard body positions to their emission epoch.
const LIGHT_TIME_DAYS_PER_AU = LIGHT_TIME_AU / DAYSEC
// Light-time iterations. Two passes converge the retarded geocentric position well below the map's
// angular resolution for the Sun (~8.3 min one-way) and the Moon (~1.3 s one-way).
const LIGHT_TIME_ITERATIONS = 2

// Numerical tolerance for tangential circle/ellipse intersections: a squared half-chord slightly below
// zero is treated as a grazing (single) contact rather than no contact.
export const GEOMETRY_TANGENCY_EPSILON = 1e-14
// Residual tolerance (squared Earth radii) for a tangential circle/limb-ellipse intersection detected as
// a near-zero local extremum of g(theta) = distanceSquared - radius^2 that never changes sign. A genuine
// tangency is a double root; this catches it when it does not land exactly on a scan sample.
const LIMB_TANGENCY_RESIDUAL = 1e-9

// Apparent/Geocentric Sun/Moon position provider at a dynamical time (TT/TDB), as produced by computeSunMoonPositionAt.
export type SunMoonProvider = (time: Time) => SunMoonPosition

// Geographic point returned by the eclipse geometry engine.
export type EclipseGeoPoint<T extends Record<string, unknown> = {}> = T & {
	// Longitude in radians, east-positive, normalized to [-PI, PI].
	readonly x: Angle
	// Latitude in radians, normalized to [-PI/2, PI/2].
	readonly y: Angle
	// Optional Julian Day associated with this point.
	readonly jd?: number
}

export type EclipseGeoBranch<P extends EclipseGeoPoint = EclipseGeoPoint> = P[]

export type EclipseGeoCurve<P extends EclipseGeoPoint = EclipseGeoPoint> = EclipseGeoBranch<P>[]

// Apparent or geocentric Sun and Moon position sample used to generate Besselian elements.
export interface SunMoonPosition {
	// Apparent or geocentric Sun equatorial coordinate.
	readonly sun: Required<EquatorialCoordinate>
	// Apparent or geocentric Moon equatorial coordinate.
	readonly moon: Required<EquatorialCoordinate>
	// Delta T in seconds for this sample.
	readonly deltaT?: number
}

// Nearest and farthest points of the Earth-limb ellipse to a fundamental-plane point, with the signed
// inside/outside flag. This replaces the unit-circle distance used previously for
// contacts and rise/set, so the oblique projection of the ellipsoid is honored exactly.
export interface EarthLimbExtremes {
	// Distance to the nearest limb point, in Earth equatorial radii.
	readonly minDistance: number
	// Distance to the farthest limb point, in Earth equatorial radii.
	readonly maxDistance: number
	// theta of the nearest limb point, in radians.
	readonly nearestTheta: number
	// theta of the farthest limb point, in radians.
	readonly farthestTheta: number
	// Whether (cx, cy) lies inside the limb ellipse.
	readonly inside: boolean
}

// Computes the apparent geocentric Sun and Moon positions used to derive Besselian elements. Both bodies
// are corrected for light-time (retarded emission position) and annual aberration (the geocenter's
// barycentric velocity), then rotated from ICRF/J2000 into the true equator and equinox of date. Delta T
// is taken from the Espenak and Meeus 2006 polynomials for the sample epoch.
//
// Time-scale contract: the dynamical steps (ephemeris sampling, precession and nutation) are
// dynamical-time operations, so the input time should be TT/TDB; the providers and
// precessionNutationMatrix convert internally and the scale difference is sub-millisecond either way.
// Earth rotation enters only later, in instantBesselianFromSunMoon, where mu is built from UT1 (= TT -
// Delta T) and Greenwich apparent sidereal time, keeping the rotation strictly in UT.
//   time: instant of evaluation in a dynamical scale (TT or TDB); other scales convert internally.
//   sun: barycentric Sun position and velocity provider, in AU and AU/day, equatorial ICRF/J2000.
//   earth: barycentric Earth position and velocity provider, in AU and AU/day, equatorial ICRF/J2000.
//   moon: geocentric Moon position and velocity provider, in AU and AU/day, equatorial ICRF/J2000.
export function computeSunMoonPositionAt(time: Time, sun: PositionAndVelocityOverTime, earth: PositionAndVelocityOverTime, moon: PositionAndVelocityOverTime): SunMoonPosition {
	const earthBarycentric = earth(time)
	const earthPosition = earthBarycentric[0]

	// Observer (geocenter) barycentric velocity in units of the speed of light, plus the reciprocal Lorentz
	// factor, both consumed by eraAb for annual aberration.
	const aberrationVelocity = vecDivScalar(earthBarycentric[1], SPEED_OF_LIGHT_AU_DAY)
	const reciprocalLorentz = Math.sqrt(1 - vecDot(aberrationVelocity, aberrationVelocity))

	// Light-time corrected geocentric Sun position: seen where it was when its light departed.
	let sunGeometric = vecMinus(sun(time)[0], earthPosition)

	for (let i = 0; i < LIGHT_TIME_ITERATIONS; i++) {
		const tau = vecLength(sunGeometric) * LIGHT_TIME_DAYS_PER_AU
		sunGeometric = vecMinus(sun(timeShift(time, -tau))[0], earthPosition)
	}

	const sunDistance = vecLength(sunGeometric)

	// Light-time corrected geocentric Moon position. The Moon provider is geocentric (Moon - Earth at the
	// sampled epoch); retarding it alone would also recede the origin, yielding Moon(t - tau) - Earth(t -
	// tau). The apparent geocentric vector must keep the observer at the geocenter of the observation
	// epoch, so the Earth displacement Earth(t) - Earth(t - tau) is added back.
	let moonGeometric = moon(time)[0]

	for (let i = 0; i < LIGHT_TIME_ITERATIONS; i++) {
		const tau = vecLength(moonGeometric) * LIGHT_TIME_DAYS_PER_AU
		const retarded = timeShift(time, -tau)
		moonGeometric = vecMinus(moon(retarded)[0], vecMinus(earthPosition, earth(retarded)[0]))
	}

	const moonDistance = vecLength(moonGeometric)
	const pnm = precessionNutationMatrix(time)

	// Apply annual aberration to the unit direction (the Sun-observer distance drives the relativistic
	// deflection term), restore the body distance, then rotate ICRF/J2000 into the true equator of date.
	const sunApparent = vecDivScalar(sunGeometric, sunDistance)
	eraAb(sunApparent, aberrationVelocity, sunDistance, reciprocalLorentz, sunApparent)
	vecMulScalar(sunApparent, sunDistance, sunApparent)
	matMulVec(pnm, sunApparent, sunApparent)

	const moonApparent = vecDivScalar(moonGeometric, moonDistance)
	eraAb(moonApparent, aberrationVelocity, sunDistance, reciprocalLorentz, moonApparent)
	vecMulScalar(moonApparent, moonDistance, moonApparent)
	matMulVec(pnm, moonApparent, moonApparent)

	const [sRA, sDEC, sD] = eraP2s(...sunApparent)
	const [mRA, mDEC, mD] = eraP2s(...moonApparent)

	// Decimal year for the Delta T model. The sub-minute scale difference between time scales is irrelevant
	// for Delta T, which varies on the order of a second per year.
	const year = eraEpj(time.day, time.fraction)

	return {
		sun: {
			rightAscension: sRA,
			declination: sDEC,
			distance: sD * AU_IN_EARTH_RADII,
		},
		moon: {
			rightAscension: mRA,
			declination: mDEC,
			distance: mD * AU_IN_EARTH_RADII,
		},
		deltaT: deltaT(year),
	}
}

function earth(time: Time) {
	const { day, fraction } = tt(time)
	return eraEpv00(day, fraction)[0]
}

function sun(time: Time): PositionAndVelocity {
	const { day, fraction } = tt(time)
	const [pvb, pvh] = eraEpv00(day, fraction)
	return [vecMinus(pvb[0], pvh[0]), vecMinus(pvb[1], pvh[1])]
}

function moon(time: Time) {
	return eraMoon98(time.day, time.fraction) as PositionAndVelocity
}

// Apparent Sun/Moon position provider from the analytical ERFA/Meeus ephemerides (significantly faster).
export function sunMoonPosition(time: Time) {
	return computeSunMoonPositionAt(time, sun, earth, moon)
}

const BISECT_ROOT_OPTIONS: RootFindingOptions = { tolerance: 1e-8 }

export function bisectRoot(f: (x: number) => number, min: number, max: number) {
	try {
		return bisection(f, min, max, BISECT_ROOT_OPTIONS).root
	} catch {
		return undefined
	}
}

// Refines a bracketed root, preferring Brent (superlinear) and falling back to bisection if Brent rejects the bracket.
export function refineRoot(f: (x: number) => number, min: number, max: number) {
	try {
		return brentRoot(f, min, max, BISECT_ROOT_OPTIONS).root
	} catch {
		return bisectRoot(f, min, max)
	}
}

// Number of uniform theta samples used to bracket extrema and crossings on the Earth-limb ellipse. The
// limb is smooth and nearly circular (flattening ~1/298), so a 2 deg scan reliably brackets every
// extremum/intersection basin before local refinement (ternary search for extrema, bisection for
// crossings), which then converges to full precision independently of this resolution.
const LIMB_SCAN_STEPS = 180

// Precomputed cos/sin of the uniform limb scan grid (theta = TAU*k/LIMB_SCAN_STEPS), since those angles are
// always the same; the continuous refinements still call Math.cos/sin on off-grid theta.
const LIMB_SCAN_COS = new Float64Array(LIMB_SCAN_STEPS)
const LIMB_SCAN_SIN = new Float64Array(LIMB_SCAN_STEPS)

for (let k = 0; k < LIMB_SCAN_STEPS; k++) {
	const theta = (TAU * k) / LIMB_SCAN_STEPS
	LIMB_SCAN_COS[k] = Math.cos(theta)
	LIMB_SCAN_SIN[k] = Math.sin(theta)
}

// Reused scan buffer for earthLimbCircleIntersections, avoiding a Float64Array allocation per call. Safe as
// a single module workspace: the function is synchronous and never re-enters itself.
const LIMB_SCAN_VALUES = new Float64Array(LIMB_SCAN_STEPS)

// Squared distance to (cx, cy) from a limb-scan grid point given its precomputed cos/sin.
export function limbDistanceSquaredFromCosSin(cos: number, sin: number, cx: number, cy: number, omega: number) {
	const dx = cos - cx
	const dy = sin / omega - cy
	return dx * dx + dy * dy
}

function EarthLimbCircleIntersectionPointComparator(a: readonly [number, number], b: readonly [number, number]) {
	return b[1] - a[1]
}

// Returns the point on the Earth-limb ellipse x^2 + (omega y)^2 = 1 at parameter theta.
export function earthLimbPoint(theta: number, omega: number) {
	return [Math.cos(theta), Math.sin(theta) / omega] as const
}

export function earthLimbDistanceSquared(theta: number, cx: number, cy: number, omega: number) {
	const dx = Math.cos(theta) - cx
	const dy = Math.sin(theta) / omega - cy
	return dx * dx + dy * dy
}

// Intersections of a circle of the given radius centered at (cx, cy) with the Earth-limb ellipse,
// returned as limb points (cos theta, sin theta / omega) ordered by descending y. The circle and the
// ellipse can meet in up to four points, so g(theta) = earthLimbDistanceSquared(theta) - radius^2 is
// scanned uniformly and every root is captured: exact zeros and sign changes (the transversal crossings),
// plus near-zero local extrema that never change sign (tangencies, which are double roots and would
// otherwise be missed unless they landed exactly on a sample). This is the ellipse counterpart of
// findCircleIntersections for rise/set.
export function earthLimbCircleIntersections(cx: number, cy: number, omega: number, radius: number) {
	if (!Number.isFinite(radius) || radius < 0 || !Number.isFinite(cx) || !Number.isFinite(cy)) return []

	const r2 = radius * radius
	const g = (theta: number) => earthLimbDistanceSquared(theta, cx, cy, omega) - r2
	const step = TAU / LIMB_SCAN_STEPS

	// g is TAU-periodic, so sample [0, TAU) once (reusing the scan buffer) and read neighbors modularly.
	const values = LIMB_SCAN_VALUES
	for (let k = 0; k < LIMB_SCAN_STEPS; k++) values[k] = limbDistanceSquaredFromCosSin(LIMB_SCAN_COS[k], LIMB_SCAN_SIN[k], cx, cy, omega) - r2

	const thetas: number[] = []

	// Transversal crossings: exact zeros on a sample and sign changes between neighbors.
	for (let k = 0; k < LIMB_SCAN_STEPS; k++) {
		const value = values[k]
		const next = values[(k + 1) % LIMB_SCAN_STEPS]

		if (Math.abs(value) <= GEOMETRY_TANGENCY_EPSILON) thetas.push(k * step)
		else if (value * next < 0) {
			const root = bisectRoot(g, k * step, (k + 1) * step)
			if (root !== undefined) thetas.push(root)
		}
	}

	// Tangencies: a strict local minimum or maximum of g whose refined extremum value is within tolerance
	// of zero is a grazing (double) contact that the sign-change pass cannot see.
	for (let k = 0; k < LIMB_SCAN_STEPS; k++) {
		const previous = values[(k - 1 + LIMB_SCAN_STEPS) % LIMB_SCAN_STEPS]
		const value = values[k]
		const next = values[(k + 1) % LIMB_SCAN_STEPS]
		const isMinimum = value < previous && value < next
		const isMaximum = value > previous && value > next

		if (isMinimum || isMaximum) {
			const extreme = refineLimbExtreme(k * step, step, cx, cy, omega, isMinimum)
			if (Math.abs(g(extreme)) <= LIMB_TANGENCY_RESIDUAL) thetas.push(extreme)
		}
	}

	const roots = deduplicateAngularRoots(thetas, 1e-7)
	const points: (readonly [number, number])[] = []
	for (const theta of roots) points.push(earthLimbPoint(theta, omega))
	points.sort(EarthLimbCircleIntersectionPointComparator)
	return points
}

export function earthLimbExtremes(cx: number, cy: number, omega: number): EarthLimbExtremes {
	const step = TAU / LIMB_SCAN_STEPS
	let minTheta = 0
	let maxTheta = 0
	let minD2 = Infinity
	let maxD2 = -Infinity

	for (let k = 0; k < LIMB_SCAN_STEPS; k++) {
		const d2 = limbDistanceSquaredFromCosSin(LIMB_SCAN_COS[k], LIMB_SCAN_SIN[k], cx, cy, omega)
		if (d2 < minD2) {
			minD2 = d2
			minTheta = k * step
		}
		if (d2 > maxD2) {
			maxD2 = d2
			maxTheta = k * step
		}
	}

	const nearestTheta = refineLimbExtreme(minTheta, step, cx, cy, omega, true)
	const farthestTheta = refineLimbExtreme(maxTheta, step, cx, cy, omega, false)
	const omegaCy = omega * cy

	return {
		minDistance: Math.sqrt(earthLimbDistanceSquared(nearestTheta, cx, cy, omega)),
		maxDistance: Math.sqrt(earthLimbDistanceSquared(farthestTheta, cx, cy, omega)),
		nearestTheta,
		farthestTheta,
		inside: cx * cx + omegaCy * omegaCy < 1,
	}
}

// Signed distance from a fundamental-plane point to the Earth-limb ellipse boundary: negative inside,
// positive outside. The classical contact equations on the unit circle (hypot - 1 -+ r) become
// signedDistance -+ r on the ellipse.
export function earthLimbSignedDistance(cx: number, cy: number, omega: number) {
	const extremes = earthLimbExtremes(cx, cy, omega)
	return extremes.inside ? -extremes.minDistance : extremes.minDistance
}

// Computes the flattening scale for the Earth-limb ellipse in the fundamental plane:
// the limb is x^2 + (omega*y)^2 = 1 with omega = 1 / sqrt(1 - e^2 cos^2 d).
export function earthLimbOmega(d: Angle) {
	const cosD = Math.cos(d)
	return 1 / Math.sqrt(1 - EARTH_E2 * cosD * cosD)
}

// Derivative d(omega)/d(d) of the limb flattening scale, used to carry the d-dependence of the limb
// into the central-line endpoint solver: omega = s^(-1/2), s = 1 - e^2 cos^2 d,
// so d(omega)/dd = -e^2 cos d sin d * s^(-3/2).
export function derivativeEarthLimbOmega(d: Angle) {
	const cosD = Math.cos(d)
	const sinD = Math.sin(d)
	const s = 1 - EARTH_E2 * cosD * cosD
	return (-EARTH_E2 * cosD * sinD) / (s * Math.sqrt(s))
}

// Ternary search of a unimodal limb extremum within a one-step bracket. Robust fallback for refineLimbExtreme.
function ternaryLimbExtreme(thetaGuess: number, halfWidth: number, cx: number, cy: number, omega: number, minimize: boolean) {
	let lo = thetaGuess - halfWidth
	let hi = thetaGuess + halfWidth

	for (let i = 0; i < 60 && hi - lo > 1e-12; i++) {
		const m1 = lo + (hi - lo) / 3
		const m2 = hi - (hi - lo) / 3
		const f1 = earthLimbDistanceSquared(m1, cx, cy, omega)
		const f2 = earthLimbDistanceSquared(m2, cx, cy, omega)
		if (minimize ? f1 < f2 : f1 > f2) hi = m2
		else lo = m1
	}

	return (lo + hi) * 0.5
}

// Refines a limb extremum (minimum or maximum of the squared distance to (cx, cy)) from a scan guess.
// Newton on the first derivative of D^2(theta) converges in a handful of evaluations (the limb is nearly
// circular, so the basin is convex), replacing the 60-step ternary search; it falls back to ternary
// whenever the curvature has the wrong sign or a step would leave the one-step bracket.
function refineLimbExtreme(thetaGuess: number, halfWidth: number, cx: number, cy: number, omega: number, minimize: boolean) {
	const lo = thetaGuess - halfWidth
	const hi = thetaGuess + halfWidth
	let theta = thetaGuess

	for (let i = 0; i < 12; i++) {
		const cos = Math.cos(theta)
		const sin = Math.sin(theta)
		const dx = cos - cx
		const dy = sin / omega - cy
		// First and second derivatives of D^2(theta) = dx^2 + dy^2.
		const first = 2 * (dx * -sin + (dy * cos) / omega)
		const second = 2 * (sin * sin - dx * cos + (cos * cos) / (omega * omega) - (dy * sin) / omega)

		// A minimum needs positive curvature, a maximum negative; otherwise Newton would walk the wrong way.
		if (!Number.isFinite(second) || second === 0 || (minimize ? second < 0 : second > 0)) break

		const step = first / second
		theta -= step

		if (!Number.isFinite(theta) || theta < lo || theta > hi) break
		if (Math.abs(step) < 1e-13) return theta
	}

	return ternaryLimbExtreme(thetaGuess, halfWidth, cx, cy, omega, minimize)
}

// Collapses thetas that are within tolerance of each other (also across the 0/TAU wrap) into a single
// representative, keeping the input order. Used to drop duplicate circle/limb intersection angles that a
// sign-change and a tangency pass can both report for the same root.
function deduplicateAngularRoots(thetas: readonly number[], tolerance: number) {
	const out: number[] = []

	for (const theta of thetas) {
		const wrapped = normalizeAngle(theta)
		let duplicate = false

		for (const kept of out) {
			const delta = Math.abs(normalizePI(wrapped - kept))
			if (delta <= tolerance) {
				duplicate = true
				break
			}
		}

		if (!duplicate) out.push(wrapped)
	}

	return out
}

// Single source of truth for the hour-angle -> longitude conversion. The project uses east-positive
// longitude, so lambda = H - mu + correction, where the correction is 0.00417807 deg per second of
// Delta T in radians. The sign is pinned by tests against NASA eclipse path tables and the subsolar point.
export function longitudeFromHourAngle(hourAngle: Angle, mu: Angle, correction: Angle) {
	return normalizeLongitude(hourAngle - mu + correction)
}

export function normalizeLongitude(longitude: Angle) {
	return longitude === PI || longitude === -PI ? longitude : normalizePI(longitude)
}

// Inverse of longitudeFromHourAngle: local hour angle of the shadow axis at an east-positive longitude.
export function hourAngleFromLongitude(longitude: Angle, mu: Angle, correction: Angle) {
	return longitude + mu - correction
}

function samePoint(a: EclipseGeoPoint, b: EclipseGeoPoint) {
	return Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9 && Math.abs((a.jd ?? 0) - (b.jd ?? 0)) < 1e-10
}

// Splits a geographic polyline into drawable antimeridian-safe segments.
export function splitPolylineAtAntimeridian(line: EclipseGeoBranch) {
	return splitGeoLineAtAntimeridian(line, false)
}

// Splits a geographic polygon ring into antimeridian-safe drawable rings.
export function splitPolygonAtAntimeridian(ring: EclipseGeoBranch) {
	return splitGeoLineAtAntimeridian(ring, true)
}

export function splitGeoLineAtAntimeridian(line: EclipseGeoBranch, close: boolean) {
	if (line.length < 2) return []

	const segments: EclipseGeoCurve = []
	let current: EclipseGeoBranch = [line[0]]
	const count = close ? line.length + 1 : line.length

	for (let i = 1; i < count; i++) {
		const previous = line[(i - 1) % line.length]
		const point = line[i % line.length]
		const delta = point.x - previous.x

		if (Math.abs(delta) > PI) {
			const crossingLon = delta > 0 ? -PI : PI
			const oppositeLon = -crossingLon
			const t = (crossingLon - previous.x) / (point.x + (delta > 0 ? -TAU : TAU) - previous.x)
			const clampedT = clamp(t, 0, 1)
			const lat = previous.y + (point.y - previous.y) * clampedT
			const jd = previous.jd !== undefined && point.jd !== undefined ? previous.jd + (point.jd - previous.jd) * clampedT : undefined
			current.push({ x: crossingLon, y: lat, jd })
			if (current.length > 1) segments.push(current)
			current = [{ x: oppositeLon, y: lat, jd }, point]
		} else {
			current.push(point)
		}
	}

	if (current.length > 1) segments.push(current)

	// For a closed ring whose first vertex is not on the seam, the opening arc (the first segment) and
	// the closing arc (the last segment) both belong to the start hemisphere and were split apart at
	// line[0]; rejoin them so the hemisphere closes along the antimeridian seam rather than across the
	// map interior. Each remaining segment already enters and leaves on the same seam, so closing it with
	// Z follows the seam edge.
	if (close && segments.length >= 2) {
		const firstSegment = segments[0]
		const lastSegment = segments.at(-1)!

		if (samePoint(firstSegment[0], lastSegment.at(-1)!)) {
			lastSegment.pop()
			const joined: EclipseGeoBranch = []
			for (const point of lastSegment) joined.push(point)
			for (const point of firstSegment) joined.push(point)
			segments[0] = joined
			segments.pop()
		}
	}

	return segments
}

// Recenters a geographic line's longitudes onto the central meridian, mapping each into the signed wrapped offset
// in (-PI, PI] (east-positive). Latitude and jd are preserved. After recentering, the projection's antimeridian
// seam sits at +-PI, so the raw-+-PI antimeridian split lands where the map actually wraps.
//   centralMeridian: geographic longitude (radians) drawn at the map center.
//   direction: 'east' when longitude increases to the right (the usual map), 'west' otherwise.
function recenterGeoLine(line: EclipseGeoBranch, centralMeridian: Angle, direction: RaAxisDirection): EclipseGeoBranch {
	const out: EclipseGeoBranch = new Array(line.length)

	for (let i = 0; i < line.length; i++) {
		const point = line[i]
		const delta = direction === 'west' ? centralMeridian - point.x : point.x - centralMeridian
		out[i] = { x: normalizeLongitude(delta), y: point.y, jd: point.jd }
	}

	return out
}

// Splits one geographic line (or ring when close is true) at the antimeridian with the exact +-180
// crossing inserted, then projects each piece. Inserting the crossing keeps every piece reaching the map
// edge instead of stopping at the last sample before the wrap, which otherwise leaves a visible gap or
// angular "beak" near +-180. The 'pi'-mode projection preserves an exact +-PI seam vertex, so the post-wrap
// piece resumes on the left edge (-PI) rather than being folded back onto the right one (+PI). The split
// happens only here, at serialization time: the geographic geometry itself is never mutated.
//
// The split must land on the projection's antimeridian seam, which for a non-zero central meridian (or a west
// axis) is NOT at raw +-PI. The line is then recentered onto the central meridian (placing the seam at +-PI) and
// projected in a central-meridian-neutral frame; otherwise a segment crossing the real seam would be left unsplit
// and drawn as a full-width horizontal line across the map, with a spurious split appearing at the map center. A
// zero central meridian on an east axis is the identity and keeps the original behavior (and allocation) exactly.
export function projectSplitPieces(geo: EclipseGeoBranch, close: boolean, projection: CylindricalProjection, options?: ProjectionOptions) {
	const pieces: Point[][] = []

	const centralMeridian = options?.centralMeridian ?? projection.options?.centralMeridian ?? 0
	const direction: RaAxisDirection = options?.raAxisDirection ?? projection.options?.raAxisDirection ?? 'east'
	const neutral = centralMeridian === 0 && direction === 'east'
	const line = neutral ? geo : recenterGeoLine(geo, centralMeridian, direction)
	const projectOptions = neutral ? options : { ...options, centralMeridian: 0, raAxisDirection: 'east' as RaAxisDirection, longitudeWrapMode: 'pi' as const }

	for (const segment of splitGeoLineAtAntimeridian(line, close)) {
		let piece: Point[] = []

		for (const point of segment) {
			const projected = projection.project(point.x, point.y, undefined, projectOptions)

			if (projected === undefined) {
				if (piece.length >= 2) pieces.push(piece)
				piece = []
			} else {
				piece.push(projected)
			}
		}

		if (piece.length >= 2) pieces.push(piece)
	}

	return pieces
}

// Projects geographic polylines and serializes them into one SVG path data string of open subpaths,
// split at the antimeridian during projection only.
export function geoPolylinesToSvgPathData(lines: readonly EclipseGeoBranch[], projection: CylindricalProjection, precision: number = 2, projectionOptions?: ProjectionOptions) {
	const pieces: Point[][] = []
	for (const line of lines) for (const piece of projectSplitPieces(line, false, projection, projectionOptions)) pieces.push(piece)
	return pointsToSvgPathData(pieces, false, precision)
}

// Serializes projected polyline or polygon pieces into an SVG path data string. Each piece becomes one
// subpath (M ... L ...); pieces with fewer than two points are skipped. When close is true each subpath
// is closed with Z, suitable for filled polygons.
export function pointsToSvgPathData(pieces: readonly (readonly Point[])[], close = false, precision: number = 2) {
	const subpaths: string[] = []

	function formatCoordinate(value: number) {
		return Number(value.toFixed(precision)).toString()
	}

	for (const piece of pieces) {
		if (piece.length < 2) continue

		// Build each subpath from tokens joined once, instead of growing a string with repeated `+=`.
		const tokens: string[] = [`M${formatCoordinate(piece[0].x)} ${formatCoordinate(piece[0].y)}`]
		for (let i = 1; i < piece.length; i++) tokens.push(`L${formatCoordinate(piece[i].x)} ${formatCoordinate(piece[i].y)}`)
		if (close) tokens.push('Z')

		subpaths.push(tokens.join(''))
	}

	return subpaths.join('')
}
