import { type Angle, normalizeAngle, normalizePI } from './angle'
import type { PositionAndVelocityOverTime } from './astrometry'
import { AU_KM, DAYSEC, DAYSPERJY, DEG2RAD, EARTH_RADIUS_KM, J2000, LIGHT_TIME_AU, PI, PIOVERTWO, RAD2DEG, SPEED_OF_LIGHT_AU_DAY, TAU } from './constants'
import { deltaTByEspenakMeeus2006 } from './deltat'
import { eraAb, eraP2s, eraS2p } from './erfa'
import { sphericalInterpolate, sphericalSeparation, type Point } from './geometry'
import { matMulVec } from './mat3'
import { clamp, type NumberArray } from './math'
import { bisection, type RootFindingOptions } from './optimization'
import { projectPolygon, projectPolyline, type Projection, type ProjectionPolylineOptions } from './projection'
import { polynomialRegression } from './regression'
import type { SolarEclipse } from './sun'
import { precessionNutationMatrix, timeShift, timeSubtract, toJulianDay, type Time } from './time'
import type { Writable } from './types'
import { vecDivScalar, vecDot, vecLength, vecMinus, vecMulScalar, vecNormalizeMut } from './vec3'

// That code planned and implemented by Codex, using https://github.com/Astrarium/Astrarium as inspiration.

const EARTH_E2 = 0.006694385
const F_CONST = 0.99664719
const INV_F_CONST_APPROX = 1.00336409
const DELTA_T_LONGITUDE_FACTOR = 0.00417807 * DEG2RAD
const DEFAULT_LONGITUDE_STEP = 1 * DEG2RAD
const DEFAULT_MAX_ANGULAR_STEP = 1 * DEG2RAD
const DEFAULT_RISE_SET_STEP_SECONDS = 30
const DEFAULT_CONTACT_SEARCH_SPAN_SECONDS = 6 * 3600
const CONTACT_TOLERANCE_DAYS = 1e-8
const SOLVER_MAX_ITERATIONS = 50
const SOLVER_TOLERANCE = 1e-4
const CENTRAL_ECLIPSE_GAMMA_LIMIT = 0.9972
const LIMB_INTERSECTION_STEPS = 128
const LIMB_INTERSECTION_TOLERANCE = 1e-12
const LIMB_TANGENCY_TOLERANCE = 1e-9
const SUN_RADIUS_EARTH_RADII = 109.076370706
// Lunar radius k1 used for penumbral contacts, per NASA/Espenak convention.
const MOON_RADIUS_PENUMBRA_EARTH_RADII = 0.272488
// Lunar radius k2 used for umbral contacts (total/annular path), per NASA/Espenak convention.
const MOON_RADIUS_UMBRA_EARTH_RADII = 0.272281
const BOUNDARY_REFINEMENT_STEPS = 18
// Sub-divisions of the first and last central-line interval used to extend the umbral limits toward
// the C1/C2 endpoints, where one edge stays above the horizon after the last coarse central sample.
const UMBRA_LIMIT_END_REFINEMENT_STEPS = 8
// Maximum recursion depth when subdividing the central-line time interval to densify an umbral limit.
// The limit can move far faster than the central line per time step (e.g. circumpolar eclipses), so
// the angular spacing of the central samples does not bound the limit's, and it is refined separately.
const UMBRA_LIMIT_REFINE_MAX_DEPTH = 12
// A circumpolar umbral limit can leave the sunlit hemisphere and reappear, leaving genuine gaps in its
// time-parametrization. After densification, continuous stretches stay within maxAngularStep, so any
// consecutive gap beyond this multiple of it is a real discontinuity at which the limit must be broken
// into separate polylines instead of bridged by a straight chord.
const UMBRA_LIMIT_GAP_SPLIT_FACTOR = 2
// Minimum Julian Day separation between distinct points on a time-parametrized curve; points closer
// than this in time (~0.1 s, far below the minutes-apart sampling of any curve) are the same instant
// reached from different seeds or seeding stages, and are collapsed to one.
const CURVE_TIME_EPSILON_DAYS = 1e-6
// Latitude seeds used to acquire the partial-eclipse (penumbra) limit during the meridian scan.
// Unlike the umbral limits, which hug the central line and are seeded from it, the partial limit can
// sit at any mid-latitude, so a spread of starting guesses is tried before continuation takes over.
const PARTIAL_LIMIT_LATITUDE_SEEDS = [0, 20 * DEG2RAD, -20 * DEG2RAD, 40 * DEG2RAD, -40 * DEG2RAD, 60 * DEG2RAD, -60 * DEG2RAD, 80 * DEG2RAD, -80 * DEG2RAD] as const

// Polynomial Besselian elements fitted around the eclipse maximum.
export interface PolynomialBesselianElements {
	// Time of the polynomial origin.
	readonly time0: Time
	// Time of maximum eclipse.
	readonly maximumTime: Time
	// Delta T in seconds.
	readonly deltaT: number
	// Optional Delta T longitude correction in radians for geographic projection.
	readonly deltaTLongitudeCorrection?: Angle
	// Polynomial time unit in days.
	readonly stepDays: number
	// X coordinate of the shadow axis in Earth equatorial radii.
	readonly x: readonly number[]
	// Y coordinate of the shadow axis in Earth equatorial radii.
	readonly y: readonly number[]
	// Penumbral cone radius in the fundamental plane, in Earth equatorial radii.
	readonly l1: readonly number[]
	// Umbral or antumbral cone radius in the fundamental plane, in Earth equatorial radii.
	readonly l2: readonly number[]
	// Shadow-axis declination in radians.
	readonly d: readonly Angle[]
	// Ephemeris hour angle parameter in radians.
	readonly mu: readonly Angle[]
	// Tangent of the penumbral cone angle.
	readonly tanF1: number
	// Tangent of the umbral or antumbral cone angle.
	readonly tanF2: number
}

// Instantaneous Besselian elements at one time.
export interface InstantBesselianElements {
	// Time of this evaluation.
	readonly time: Time
	// Delta T in seconds.
	readonly deltaT: number
	// Optional Delta T longitude correction in radians for geographic projection.
	readonly deltaTLongitudeCorrection?: Angle
	// X coordinate of the shadow axis in Earth equatorial radii.
	readonly x: number
	// Y coordinate of the shadow axis in Earth equatorial radii.
	readonly y: number
	// Penumbral cone radius in the fundamental plane, in Earth equatorial radii.
	readonly l1: number
	// Umbral or antumbral cone radius in the fundamental plane, in Earth equatorial radii.
	readonly l2: number
	// Shadow-axis declination in radians.
	readonly d: Angle
	// Ephemeris hour angle parameter in radians, normalized to [0, TAU).
	readonly mu: Angle
	// Derivative of x with respect to normalized polynomial time.
	readonly dx: number
	// Derivative of y with respect to normalized polynomial time.
	readonly dy: number
	// Tangent of the penumbral cone angle.
	readonly tanF1: number
	// Tangent of the umbral or antumbral cone angle.
	readonly tanF2: number
}

// Apparent or geocentric Sun and Moon position sample used to generate Besselian elements.
export interface SunMoonPosition {
	// Apparent or geocentric Sun right ascension in radians.
	readonly sunRightAscension: Angle
	// Apparent or geocentric Sun declination in radians.
	readonly sunDeclination: Angle
	// Sun distance from the observer origin in Earth equatorial radii.
	readonly sunDistance: number
	// Apparent or geocentric Moon right ascension in radians.
	readonly moonRightAscension: Angle
	// Apparent or geocentric Moon declination in radians.
	readonly moonDeclination: Angle
	// Moon distance from the observer origin in Earth equatorial radii.
	readonly moonDistance: number
	// Optional Delta T in seconds for this sample.
	readonly deltaT?: number
}

// Geographic point returned by the eclipse geometry engine.
export interface GeoPoint {
	// Longitude in radians, east-positive, normalized to [-PI, PI].
	readonly x: Angle
	// Latitude in radians, normalized to [-PI/2, PI/2].
	readonly y: Angle
	// Optional Julian Day associated with this point.
	readonly jd?: number
}

// Named eclipse contact and central-path endpoints.
export interface SolarEclipseContactPoints {
	// First external penumbral contact (partial eclipse begins on Earth).
	readonly P1?: GeoPoint
	// First internal penumbral contact (penumbra wholly on Earth).
	readonly P2?: GeoPoint
	// Last internal penumbral contact (penumbra wholly on Earth).
	readonly P3?: GeoPoint
	// Last external penumbral contact (partial eclipse ends on Earth).
	readonly P4?: GeoPoint
	// First external umbral contact: the umbra first touches Earth (total or annular eclipse begins).
	readonly U1?: GeoPoint
	// First internal umbral contact: the umbra lies wholly on Earth.
	readonly U2?: GeoPoint
	// Last internal umbral contact: the umbra lies wholly on Earth.
	readonly U3?: GeoPoint
	// Last external umbral contact: the umbra last touches Earth (total or annular eclipse ends).
	readonly U4?: GeoPoint
	// First central-line contact with Earth (the shadow axis grazes the limb where the central line begins).
	readonly C1?: GeoPoint
	// Last central-line contact with Earth (the shadow axis grazes the limb where the central line ends).
	readonly C2?: GeoPoint
	// Greatest eclipse point.
	readonly Max?: GeoPoint
}

// Projection-agnostic solar eclipse map geometry.
export interface SolarEclipseMapGeometry {
	// Named contact points and greatest-eclipse point.
	readonly points: SolarEclipseContactPoints
	// Drawable geographic polylines, still unprojected.
	readonly lines: {
		// Central line of totality or annularity.
		readonly centerLine: readonly GeoPoint[]
		// Northern totality or annularity limits, split at polar/circumpolar breaks.
		readonly umbraNorth: readonly GeoPoint[][]
		// Southern totality or annularity limits, split at polar/circumpolar breaks.
		readonly umbraSouth: readonly GeoPoint[][]
		// Northern partial eclipse limit.
		readonly penumbraNorth: readonly GeoPoint[]
		// Southern partial eclipse limit.
		readonly penumbraSouth: readonly GeoPoint[]
		// Sunrise and sunset eclipse curves.
		readonly riseSetCurves: readonly GeoPoint[][]
	}
	// Geographic polygon rings, still unprojected.
	readonly polygons: {
		// Totality or annularity path rings.
		readonly totalityPath: readonly GeoPoint[][]
	}
}

// Options for computing the full eclipse map geometry.
export interface SolarEclipseMapGeometryOptions {
	// Longitude scan step in radians.
	readonly longitudeStep?: Angle
	// Maximum angular spacing between neighboring curve points in radians.
	readonly maxAngularStep?: Angle
	// Half-width of the contact root search window around maximumTime, in seconds.
	readonly contactSearchSpan?: number
	// Rise/set curve sampling step in seconds.
	readonly riseSetStep?: number
	// Whether to include sunrise and sunset curves.
	readonly includeRiseSetCurves?: boolean
	// Whether to include totality or annularity path polygons.
	readonly includePolygons?: boolean
}

// Options for generating one family of eclipse curve points.
export interface SolarEclipseCurveOptions {
	// Longitude scan step in radians.
	readonly longitudeStep?: Angle
	// Maximum angular spacing between neighboring curve points in radians.
	readonly maxAngularStep?: Angle
	// Half-width of the contact root search window around maximumTime, in seconds.
	readonly contactSearchSpan?: number
}

// Options for finding eclipse contact roots.
export interface SolarEclipseContactOptions {
	// Half-width of the root search window around maximumTime, in seconds.
	readonly contactSearchSpan?: number
}

// Options for computing rise and set curves.
export interface SolarEclipseRiseSetCurveOptions {
	// Sampling step in seconds.
	readonly step?: number
	// Whether to adaptively refine large angular gaps.
	readonly adaptive?: boolean
}

// Options for projecting eclipse map geometry onto a (cylindrical) SVG.
export interface SolarEclipseMapSvgProjectionOptions extends ProjectionPolylineOptions {
	// Number of decimal places kept in the path coordinates (default 2).
	readonly precision?: number
}

export interface SolarEclipseMapPoints {
	readonly P1?: Point
	readonly P2?: Point
	readonly P3?: Point
	readonly P4?: Point
	readonly U1?: Point
	readonly U2?: Point
	readonly U3?: Point
	readonly U4?: Point
	readonly C1?: Point
	readonly C2?: Point
	readonly Max?: Point
}

// SVG path data strings per eclipse map feature, plus projected pixel coordinates of named points.
export interface SolarEclipseMapSvgPaths {
	// Central line of totality or annularity.
	readonly centerLine: string
	// Northern totality or annularity limit.
	readonly umbraNorth: string
	// Southern totality or annularity limit.
	readonly umbraSouth: string
	// Northern partial eclipse limit.
	readonly penumbraNorth: string
	// Southern partial eclipse limit.
	readonly penumbraSouth: string
	// Sunrise and sunset eclipse curves.
	readonly riseSetCurves: string
	// Totality or annularity path, as closed polygon rings.
	readonly totalityPath: string
	// Projected pixel coordinates of the named contact and greatest-eclipse points, when present.
	readonly points: SolarEclipseMapPoints
}

function finitePoint(point: GeoPoint | undefined): point is GeoPoint {
	return !!point && Number.isFinite(point.x) && Number.isFinite(point.y) && point.y >= -PIOVERTWO && point.y <= PIOVERTWO && point.x >= -PI && point.x <= PI
}

function samePoint(a: GeoPoint, b: GeoPoint) {
	return Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9 && Math.abs((a.jd ?? 0) - (b.jd ?? 0)) < 1e-10
}

function pushDistinct(points: GeoPoint[], point: GeoPoint | undefined) {
	if (!finitePoint(point)) return
	if (points.length === 0 || !samePoint(points.at(-1)!, point)) points.push(point)
}

function evaluatePolynomial(coefficients: readonly number[], t: number) {
	let value = 0
	for (let i = coefficients.length - 1; i >= 0; i--) value = value * t + coefficients[i]
	return value
}

function evaluatePolynomialDerivative(coefficients: readonly number[], t: number) {
	let value = 0
	for (let i = coefficients.length - 1; i >= 1; i--) value = value * t + i * coefficients[i]
	return value
}

function unwrapAngles(values: number[]) {
	let offset = 0
	let previous = values[0]

	for (let i = 1; i < values.length; i++) {
		let current = values[i] + offset
		const delta = current - previous

		if (delta > PI) {
			current -= TAU
			offset -= TAU
		} else if (delta < -PI) {
			current += TAU
			offset += TAU
		}

		values[i] = current
		previous = current
	}
}

function fitCubic(x: Readonly<NumberArray>, y: Readonly<NumberArray>) {
	return polynomialRegression(x, y, 3).coefficients
}

function angularDistance(a: GeoPoint, b: GeoPoint) {
	return sphericalSeparation(a.x, a.y, b.x, b.y)
}

function interpolateGreatCirclePoint(a: GeoPoint, b: GeoPoint, fraction: number): GeoPoint {
	const [longitude, latitude] = sphericalInterpolate(a.x, a.y, b.x, b.y, fraction)

	return {
		x: normalizePI(longitude),
		y: latitude,
		jd: a.jd !== undefined && b.jd !== undefined ? a.jd + (b.jd - a.jd) * fraction : undefined,
	}
}

function validStep(value: number | undefined, fallback: number) {
	return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback
}

function contactSearchSpanDays(options?: SolarEclipseContactOptions) {
	return validStep(options?.contactSearchSpan, DEFAULT_CONTACT_SEARCH_SPAN_SECONDS) / DAYSEC
}

function timeAtJulianDay(reference: Time, julianDay: number) {
	return timeShift(reference, julianDay - reference.day - reference.fraction, false)
}

// Interpolates between two geographic points along the great-circle arc.
export function intermediateGreatCircle(a: GeoPoint, b: GeoPoint, fraction: number): GeoPoint {
	return interpolateGreatCirclePoint(a, b, clamp(fraction, 0, 1))
}

function centralLinePointAtJulianDay(pbe: PolynomialBesselianElements, jd: number) {
	const be = evaluateBesselianSample(pbe, timeAtJulianDay(pbe.time0, jd))
	return projectFundamentalPoint(be, be.x, be.y)
}

// Besselian element positions at one time, without the velocity derivatives that only the curve
// solver needs. Projection, contact and rise/set paths read only these fields.
interface BesselianSample {
	readonly time: Time
	readonly deltaT: number
	readonly deltaTLongitudeCorrection?: Angle
	readonly x: number
	readonly y: number
	readonly l1: number
	readonly l2: number
	readonly d: Angle
	readonly mu: Angle
	readonly tanF1: number
	readonly tanF2: number
}

// Besselian element values at one normalized polynomial time, with velocity derivatives.
interface BesselianValues {
	x: number
	y: number
	l1: number
	l2: number
	d: Angle
	mu: Angle
	dx: number
	dy: number
	// Derivative of mu with respect to normalized polynomial time.
	dmu: number
	tanF1: number
	tanF2: number
}

// Evaluates Besselian positions and velocity derivatives directly from the normalized polynomial
// time, avoiding Time allocation in hot solver loops where the normalized time is already known.
function evaluateBesselianAtT(pbe: PolynomialBesselianElements, t: number): BesselianValues {
	return {
		x: evaluatePolynomial(pbe.x, t),
		y: evaluatePolynomial(pbe.y, t),
		l1: evaluatePolynomial(pbe.l1, t),
		l2: evaluatePolynomial(pbe.l2, t),
		d: evaluatePolynomial(pbe.d, t),
		mu: normalizeAngle(evaluatePolynomial(pbe.mu, t)),
		dx: evaluatePolynomialDerivative(pbe.x, t),
		dy: evaluatePolynomialDerivative(pbe.y, t),
		dmu: evaluatePolynomialDerivative(pbe.mu, t),
		tanF1: pbe.tanF1,
		tanF2: pbe.tanF2,
	}
}

// Evaluates Besselian element positions at one time, skipping the velocity derivatives.
function evaluateBesselianSample(pbe: PolynomialBesselianElements, time: Time): BesselianSample {
	const t = timeSubtract(time, pbe.time0) / pbe.stepDays

	return {
		time,
		deltaT: pbe.deltaT,
		deltaTLongitudeCorrection: deltaTLongitudeCorrection(pbe),
		x: evaluatePolynomial(pbe.x, t),
		y: evaluatePolynomial(pbe.y, t),
		l1: evaluatePolynomial(pbe.l1, t),
		l2: evaluatePolynomial(pbe.l2, t),
		d: evaluatePolynomial(pbe.d, t),
		mu: normalizeAngle(evaluatePolynomial(pbe.mu, t)),
		tanF1: pbe.tanF1,
		tanF2: pbe.tanF2,
	}
}

// Evaluates polynomial Besselian elements at one time, including velocity derivatives.
export function evaluateBesselian(pbe: PolynomialBesselianElements, time: Time): InstantBesselianElements {
	const t = timeSubtract(time, pbe.time0) / pbe.stepDays

	return {
		...evaluateBesselianSample(pbe, time),
		dx: evaluatePolynomialDerivative(pbe.x, t),
		dy: evaluatePolynomialDerivative(pbe.y, t),
	}
}

// Computes approximate polynomial Besselian elements from caller-provided Sun and Moon samples.
export function computePolynomialBesselianElements(maximumTime: Time, getSunMoonPosition: (time: Time) => SunMoonPosition): PolynomialBesselianElements {
	const maximumJulianDay = toJulianDay(maximumTime)
	const julianDay0 = Math.round(maximumJulianDay * 24) / 24
	const time0 = timeAtJulianDay(maximumTime, julianDay0)
	const stepDays = 3 / 24
	const offsets = [-2, -1, 0, 1, 2] as const
	const t = new Float64Array(offsets)
	const x = new Float64Array(offsets.length)
	const y = new Float64Array(offsets.length)
	const l1 = new Float64Array(offsets.length)
	const l2 = new Float64Array(offsets.length)
	const d = new Float64Array(offsets.length)
	const mu = new Float64Array(offsets.length)
	let tanF1 = 0
	let tanF2 = 0
	let deltaT = 0

	for (let i = 0; i < offsets.length; i++) {
		const offset = offsets[i]
		const sampleTime = timeShift(time0, offset * stepDays)
		const sample = getSunMoonPosition(sampleTime)
		const instant = instantBesselianFromSunMoon(sampleTime, sample)
		t[i] = offset
		x[i] = instant.x
		y[i] = instant.y
		l1[i] = instant.l1
		l2[i] = instant.l2
		d[i] = instant.d
		mu[i] = instant.mu
		tanF1 += instant.tanF1
		tanF2 += instant.tanF2
		deltaT += sample.deltaT ?? 0
	}

	const muValues = Array.from(mu)
	unwrapAngles(muValues)

	return {
		time0,
		maximumTime,
		deltaT: deltaT / offsets.length,
		deltaTLongitudeCorrection: 0,
		stepDays,
		x: fitCubic(t, x),
		y: fitCubic(t, y),
		l1: fitCubic(t, l1),
		l2: fitCubic(t, l2),
		d: fitCubic(t, d),
		mu: fitCubic(t, muValues),
		tanF1: tanF1 / offsets.length,
		tanF2: tanF2 / offsets.length,
	}
}

function instantBesselianFromSunMoon(time: Time, sample: SunMoonPosition): InstantBesselianElements {
	const projection = besselianShadowProjection(sample)
	const deltaT = sample.deltaT ?? 0
	const sunSemidiameter = Math.asin(clamp(SUN_RADIUS_EARTH_RADII / sample.sunDistance, -1, 1))
	const moonPenumbraSemidiameter = Math.asin(clamp(MOON_RADIUS_PENUMBRA_EARTH_RADII / sample.moonDistance, -1, 1))
	const moonUmbraSemidiameter = Math.asin(clamp(MOON_RADIUS_UMBRA_EARTH_RADII / sample.moonDistance, -1, 1))
	const moonParallax = Math.asin(clamp(1 / sample.moonDistance, -1, 1))
	const invParallax = moonParallax === 0 ? 0 : 1 / moonParallax
	const sunMoonDistance = projection.sunMoonDistance
	const invSunMoonDistance = sunMoonDistance > 0 ? 1 / sunMoonDistance : 0
	const l1 = (sunSemidiameter + moonPenumbraSemidiameter) * invParallax
	const l2 = (sunSemidiameter - moonUmbraSemidiameter) * invParallax
	const siderealTime = timeShift(time, -deltaT / DAYSEC)
	const gmst = normalizeAngle(280.46061837 * DEG2RAD + 360.98564736629 * DEG2RAD * (siderealTime.day - J2000 + siderealTime.fraction))
	const mu = normalizeAngle(gmst - projection.rightAscension)

	return {
		time,
		deltaT,
		deltaTLongitudeCorrection: 0,
		x: projection.x,
		y: projection.y,
		l1,
		l2,
		d: projection.declination,
		mu,
		dx: 0,
		dy: 0,
		tanF1: (SUN_RADIUS_EARTH_RADII + MOON_RADIUS_PENUMBRA_EARTH_RADII) * invSunMoonDistance,
		tanF2: (SUN_RADIUS_EARTH_RADII - MOON_RADIUS_UMBRA_EARTH_RADII) * invSunMoonDistance,
	}
}

function besselianShadowProjection(sample: SunMoonPosition) {
	if (!(sample.sunDistance > 0) || !(sample.moonDistance > 0)) {
		return { x: 0, y: 0, rightAscension: sample.sunRightAscension, declination: sample.sunDeclination, sunMoonDistance: 0 }
	}

	const sun = eraS2p(sample.sunRightAscension, sample.sunDeclination, sample.sunDistance)
	const moon = eraS2p(sample.moonRightAscension, sample.moonDeclination, sample.moonDistance)
	const sunMinusMoon = vecMinus(sun, moon)
	const sunMoonDistance = vecLength(sunMinusMoon)

	if (!(sunMoonDistance > 0) || !Number.isFinite(sunMoonDistance)) {
		return { x: 0, y: 0, rightAscension: sample.sunRightAscension, declination: sample.sunDeclination, sunMoonDistance: 0 }
	}

	const axis = vecNormalizeMut(sunMinusMoon)
	const rightAscension = normalizeAngle(Math.atan2(axis[1], axis[0]))
	const declination = Math.asin(clamp(axis[2], -1, 1))
	const sinA = Math.sin(rightAscension)
	const cosA = Math.cos(rightAscension)
	const sinD = Math.sin(declination)
	const cosD = Math.cos(declination)
	const east = [-sinA, cosA, 0] as const
	const north = [-cosA * sinD, -sinA * sinD, cosD] as const
	const zeta = vecDot(moon, axis)
	const foot = [moon[0] - zeta * axis[0], moon[1] - zeta * axis[1], moon[2] - zeta * axis[2]] as const

	return {
		x: vecDot(foot, east),
		y: vecDot(foot, north),
		rightAscension,
		declination,
		sunMoonDistance,
	}
}

// Computes the flattening scale for the Earth-limb ellipse in the fundamental plane.
function earthLimbOmega(be: Pick<BesselianSample, 'd'>) {
	const cosD = Math.cos(be.d)
	return 1 / Math.sqrt(1 - EARTH_E2 * cosD * cosD)
}

function deltaTLongitudeCorrection(elements: { readonly deltaT: number; readonly deltaTLongitudeCorrection?: Angle }) {
	return elements.deltaTLongitudeCorrection ?? DELTA_T_LONGITUDE_FACTOR * elements.deltaT
}

// Finds the closest point on the oblate Earth limb x² + (omega*y)² = 1 and returns
// its signed Euclidean distance from the supplied fundamental-plane point.
function closestEarthLimbPoint(be: Pick<BesselianSample, 'd'>, x: number, y: number) {
	const omega = earthLimbOmega(be)
	const a = 1
	const b = 1 / omega
	let theta = Math.atan2(y / b, x / a)

	if (!Number.isFinite(theta)) theta = PIOVERTWO
	else if (Math.hypot(x / a, y / b) < 1e-15) theta = PIOVERTWO

	for (let iteration = 0; iteration < 12; iteration++) {
		const sinTheta = Math.sin(theta)
		const cosTheta = Math.cos(theta)
		// Newton solve of d/dθ[(a*cosθ-x)² + (b*sinθ-y)²] = 0.
		const f = (b * b - a * a) * sinTheta * cosTheta + a * x * sinTheta - b * y * cosTheta
		const df = (b * b - a * a) * (cosTheta * cosTheta - sinTheta * sinTheta) + a * x * cosTheta + b * y * sinTheta

		if (df === 0) break

		const delta = f / df
		theta -= delta
		if (Math.abs(delta) < 1e-14) break
	}

	const limbX = a * Math.cos(theta)
	const limbY = b * Math.sin(theta)
	const distance = Math.hypot(x - limbX, y - limbY)
	const outside = x * x + y * y * omega * omega >= 1

	return { x: limbX, y: limbY, signedDistance: outside ? distance : -distance }
}

// Projects one fundamental-plane point to geographic longitude and latitude.
export function projectFundamentalPoint(be: BesselianSample, x: number, y: number): GeoPoint | undefined {
	if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined

	const sinD = Math.sin(be.d)
	const cosD = Math.cos(be.d)
	const omega = earthLimbOmega(be)
	let px = x
	let y1 = omega * y
	const b1 = omega * sinD
	const b2 = F_CONST * omega * cosD
	let bSquared = 1 - px * px - y1 * y1

	if (bSquared < 0) {
		const positionAngle = Math.atan2(y1, px)
		px = Math.cos(positionAngle)
		y1 = Math.sin(positionAngle)
		bSquared = 0
	}

	const B = Math.sqrt(bSquared)
	const H = normalizeAngle(Math.atan2(px, B * b2 - y1 * b1))
	const phi1 = Math.asin(clamp(B * b1 + y1 * b2, -1, 1))
	const lat = Math.atan(INV_F_CONST_APPROX * Math.tan(phi1))
	const lon = H - be.mu + deltaTLongitudeCorrection(be)

	if (!Number.isFinite(lon) || !Number.isFinite(lat)) return undefined

	return { x: normalizePI(lon), y: lat, jd: toJulianDay(be.time) }
}

const BISECT_ROOT_OPTIONS: RootFindingOptions = { tolerance: CONTACT_TOLERANCE_DAYS }

function bisectRoot(f: (x: number) => number, min: number, max: number) {
	try {
		return bisection(f, min, max, BISECT_ROOT_OPTIONS).root
	} catch {
		return undefined
	}
}

// Finds P1/P2/P3/P4 penumbral contact points.
export function findPenumbraContactPoints(pbe: PolynomialBesselianElements, options?: SolarEclipseContactOptions): Pick<SolarEclipseContactPoints, 'P1' | 'P2' | 'P3' | 'P4'> {
	const maximumJulianDay = toJulianDay(pbe.maximumTime)
	const searchSpanDays = contactSearchSpanDays(options)
	const from = maximumJulianDay - searchSpanDays
	const to = maximumJulianDay + searchSpanDays

	// Penumbral contacts occur when the penumbral shadow circle is tangent to the
	// flattened Earth limb, not to a unit circle centered at the geocenter.
	function external(jd: number) {
		const be = evaluateBesselianSample(pbe, timeAtJulianDay(pbe.time0, jd))
		return closestEarthLimbPoint(be, be.x, be.y).signedDistance - be.l1
	}

	function internal(jd: number) {
		const be = evaluateBesselianSample(pbe, timeAtJulianDay(pbe.time0, jd))
		return closestEarthLimbPoint(be, be.x, be.y).signedDistance + be.l1
	}

	return {
		P1: projectContactRoot(pbe, bisectRoot(external, from, maximumJulianDay)),
		P2: projectContactRoot(pbe, bisectRoot(internal, from, maximumJulianDay)),
		P3: projectContactRoot(pbe, bisectRoot(internal, maximumJulianDay, to)),
		P4: projectContactRoot(pbe, bisectRoot(external, maximumJulianDay, to)),
	}
}

// Finds U1/U2/U3/U4 umbral contact points: the instants the umbral shadow cone is tangent to the
// flattened Earth limb. U1 and U4 are the first and last external tangencies, where the umbra just
// touches Earth and the total or annular eclipse begins and ends; U2 and U3 are the first and last
// internal tangencies, where the umbra lies wholly on Earth. They are left undefined when the umbra
// never reaches Earth (a partial eclipse), as the tangency roots then do not exist.
export function findUmbraContactPoints(pbe: PolynomialBesselianElements, options?: SolarEclipseContactOptions): Pick<SolarEclipseContactPoints, 'U1' | 'U2' | 'U3' | 'U4'> {
	const maximumJulianDay = toJulianDay(pbe.maximumTime)
	const searchSpanDays = contactSearchSpanDays(options)
	const from = maximumJulianDay - searchSpanDays
	const to = maximumJulianDay + searchSpanDays

	// The umbral shadow radius on the fundamental plane is |l2| (l2 is negative for a total eclipse and
	// positive for an annular one), tangent to the flattened Earth limb just like the penumbra's l1.
	function external(jd: number) {
		const be = evaluateBesselianSample(pbe, timeAtJulianDay(pbe.time0, jd))
		return closestEarthLimbPoint(be, be.x, be.y).signedDistance - Math.abs(be.l2)
	}

	function internal(jd: number) {
		const be = evaluateBesselianSample(pbe, timeAtJulianDay(pbe.time0, jd))
		return closestEarthLimbPoint(be, be.x, be.y).signedDistance + Math.abs(be.l2)
	}

	return {
		U1: projectContactRoot(pbe, bisectRoot(external, from, maximumJulianDay)),
		U2: projectContactRoot(pbe, bisectRoot(internal, from, maximumJulianDay)),
		U3: projectContactRoot(pbe, bisectRoot(internal, maximumJulianDay, to)),
		U4: projectContactRoot(pbe, bisectRoot(external, maximumJulianDay, to)),
	}
}

function projectContactRoot(pbe: PolynomialBesselianElements, jd: number | undefined) {
	if (jd === undefined) return undefined

	const be = evaluateBesselianSample(pbe, timeAtJulianDay(pbe.time0, jd))
	const limb = closestEarthLimbPoint(be, be.x, be.y)
	return projectFundamentalPoint(be, limb.x, limb.y)
}

// Finds the greatest eclipse point.
export function findMaximumPoint(pbe: PolynomialBesselianElements): GeoPoint | undefined {
	const be = evaluateBesselianSample(pbe, pbe.maximumTime)
	return projectFundamentalPoint(be, be.x, be.y)
}

// Finds one extreme endpoint of the central line.
export function findExtremeLimitOfCentralLine(pbe: PolynomialBesselianElements, begin: boolean, options?: SolarEclipseContactOptions) {
	const maximumJulianDay = toJulianDay(pbe.maximumTime)
	const searchSpanDays = contactSearchSpanDays(options)
	const from = begin ? maximumJulianDay - searchSpanDays : maximumJulianDay
	const to = begin ? maximumJulianDay : maximumJulianDay + searchSpanDays

	function fn(jd: number) {
		const be = evaluateBesselianSample(pbe, timeAtJulianDay(pbe.time0, jd))
		// Earth's limb in the fundamental plane is the flattened ellipse x^2 + (omega*y)^2 = 1,
		// matching the on-Earth test used in projectFundamentalPoint.
		const cosD = Math.cos(be.d)
		const omega = 1 / Math.sqrt(1 - EARTH_E2 * cosD * cosD)
		const y1 = omega * be.y
		return be.x * be.x + y1 * y1 - 1
	}

	const jd = bisectRoot(fn, from, to)

	if (jd === undefined) return undefined

	const be = evaluateBesselianSample(pbe, timeAtJulianDay(pbe.time0, jd))
	return projectFundamentalPoint(be, be.x, be.y)
}

// Solves one eclipse curve point at fixed longitude.
// i = 0, G ignored -> central line
// i = +1, G = 1 -> northern limit of total/annular path
// i = -1, G = 1 -> southern limit of total/annular path
// i = +1, G = 0 -> northern limit of partial eclipse
// i = -1, G = 0 -> southern limit of partial eclipse
// i = ±1, 0<G<1 -> equal-magnitude curve
export function findEclipseCurvePoint(pbe: PolynomialBesselianElements, longitude: Angle, initialLatitude: Angle, i: -1 | 0 | 1, G: number) {
	return solveEclipseCurvePoint(pbe, longitude, initialLatitude, i, G, 0)
}

function solveEclipseCurvePoint(pbe: PolynomialBesselianElements, longitude: Angle, initialLatitude: Angle, i: -1 | 0 | 1, G: number, initialT: number): GeoPoint | undefined {
	let t = initialT
	let phi = initialLatitude
	const julianDay0 = toJulianDay(pbe.time0)
	const longitudeCorrection = deltaTLongitudeCorrection(pbe)
	let jd = julianDay0

	for (let iteration = 0; iteration < SOLVER_MAX_ITERATIONS; iteration++) {
		jd = julianDay0 + t * pbe.stepDays
		const be = evaluateBesselianAtT(pbe, t)
		const H = longitude + be.mu - longitudeCorrection
		const sinD = Math.sin(be.d)
		const cosD = Math.cos(be.d)
		const sinH = Math.sin(H)
		const cosH = Math.cos(H)
		const sinPhi = Math.sin(phi)
		const cosPhi = Math.cos(phi)
		const U = Math.atan(F_CONST * Math.tan(phi))
		const rhoSinPhi = F_CONST * Math.sin(U)
		const rhoCosPhi = Math.cos(U)
		let ksi = rhoCosPhi * sinH
		let eta = rhoSinPhi * cosD - rhoCosPhi * cosH * sinD
		let zeta = rhoSinPhi * sinD + rhoCosPhi * cosH * cosD
		const sinh = sinD * sinPhi + cosD * cosPhi * cosH
		const h = Math.asin(clamp(sinh, -1, 1))

		if (!Number.isFinite(h) || h < 0) return undefined

		const hD = h * RAD2DEG

		// Empirical horizon-refraction correction that lifts the observer; it applies to any
		// curve whose point lies near the horizon, regardless of the limit family.
		if (hD <= 10) {
			const sigma = 1.000012 + 0.0002282559 * Math.exp(-0.5035747 * hD)
			ksi *= sigma
			eta *= sigma
			zeta *= sigma
		}

		// Diurnal rate of the observer's hour angle dmu/dt, in radians per normalized time unit,
		// taken from the fitted mu polynomial instead of the 2*pi/day approximation.
		const ksiPrime = rhoCosPhi * cosH * be.dmu
		const etaPrime = rhoCosPhi * sinH * sinD * be.dmu
		const u = be.x - ksi
		const v = be.y - eta
		const a = be.dx - ksiPrime
		const b = be.dy - etaPrime
		const nSquared = a * a + b * b

		if (!(nSquared > 0) || !Number.isFinite(nSquared)) return undefined

		const n = Math.sqrt(nSquared)
		const tau = -(u * a + v * b) / nSquared
		const W = (v * a - u * b) / n
		// Exact d/dphi of the reduced-latitude functions including flattening, replacing the
		// spherical approximation -d(rhoCosPhi)/dphi ~ rhoSinPhi and d(rhoSinPhi)/dphi ~ rhoCosPhi:
		//   -d(rhoCosPhi)/dphi = rhoSinPhi / (cos^2 phi + F^2 sin^2 phi)
		//    d(rhoSinPhi)/dphi = F^2 rhoCosPhi / (cos^2 phi + F^2 sin^2 phi)
		const latDenom = cosPhi * cosPhi + F_CONST * F_CONST * sinPhi * sinPhi
		const dRhoCos = rhoSinPhi / latDenom
		const dRhoSin = (F_CONST * F_CONST * rhoCosPhi) / latDenom
		const Q1 = b * sinH * dRhoCos
		const Q2 = a * (cosH * sinD * dRhoCos + cosD * dRhoSin)
		// dW/dphi = -(Q1 + Q2) / n in radians, so the Newton latitude step is residual / (dW/dphi).
		const Q = (Q1 + Q2) / n
		const dL1 = be.l1 - zeta * be.tanF1
		const dL2 = be.l2 - zeta * be.tanF2
		const E = dL1 - G * (dL1 + dL2)
		const residual = W + i * Math.abs(E)
		const deltaPhi = Q === 0 ? Number.NaN : residual / Q

		if (!Number.isFinite(tau) || !Number.isFinite(deltaPhi)) return undefined

		t += tau
		phi += deltaPhi

		if (!Number.isFinite(t) || !Number.isFinite(phi) || Math.abs(phi) > PIOVERTWO) return undefined
		if (Math.abs(tau) < SOLVER_TOLERANCE && Math.abs(deltaPhi) < SOLVER_TOLERANCE * DEG2RAD) {
			return { x: normalizePI(longitude), y: phi, jd }
		}
	}

	return undefined
}

// Finds a drawable eclipse curve for the selected limit family. When the time-sampled central
// line is already available it can be supplied to avoid recomputing it for umbral seeding.
export function findCurvePoints(pbe: PolynomialBesselianElements, i: -1 | 0 | 1, G: number, options: SolarEclipseCurveOptions = {}, centerLineSamples?: readonly GeoPoint[]): readonly GeoPoint[] {
	// The central line is fully described by its time parametrization, whose adaptive subdivision
	// already enforces maxAngularStep, so the meridian scan below is only needed for the limits.
	if (i === 0) return centerLineSamples ?? sampleCentralLineByTime(pbe, options)

	const points: GeoPoint[] = findCentralSeededCurvePoints(pbe, i, G, options, centerLineSamples)

	// The umbral limits (G = 1) are traced robustly by the geometric central-line seeding above and,
	// for non-central eclipses, by the time-seeded fallback in computeSolarEclipseMapGeometry. The
	// meridian Newton scan below is reserved for the other magnitude curves; running it for the umbra
	// only sprinkles sparse, partially converged points over a tiny path and pre-empts that fallback.
	if (G !== 1) {
		const longitudeStep = validStep(options.longitudeStep, DEFAULT_LONGITUDE_STEP)
		const maxAngularStep = validStep(options.maxAngularStep, DEFAULT_MAX_ANGULAR_STEP)
		const seeds = [0, Math.sign(pbe.y[0] || 1) * (89.9 * DEG2RAD)] as const
		const previousBySeed: (GeoPoint | undefined)[] = [undefined, undefined]

		for (let longitude = -PI; longitude <= PI + 1e-12; longitude += longitudeStep) {
			const lon = Math.min(longitude, PI)

			for (let seedIndex = 0; seedIndex < seeds.length; seedIndex++) {
				const previousSeed = previousBySeed[seedIndex]
				const seed = previousSeed ? previousSeed.y : seeds[seedIndex]
				const point = findEclipseCurvePoint(pbe, lon, seed, i, G)
				const previous = previousBySeed[seedIndex]

				if (previous && !point) pushDistinct(points, refineCurveBoundary(pbe, previous.x, lon, previous.y, true, i, G))
				else if (!previous && point && lon > -PI) pushDistinct(points, refineCurveBoundary(pbe, lon - longitudeStep, lon, point.y, false, i, G))

				if (previous && point) appendRefinedSegment(points, pbe, previous, point, i, G, maxAngularStep)
				pushDistinct(points, point)
				previousBySeed[seedIndex] = point
			}
		}
	}

	return orderCurvePoints(deduplicatePoints(points))
}

// Solves the partial-eclipse (penumbra, G = 0) limit point at one longitude, preferring continuation
// from the previously found latitude and otherwise sweeping the mid-latitude acquisition seeds.
function solvePartialLimitAtLongitude(pbe: PolynomialBesselianElements, longitude: Angle, previous: GeoPoint | undefined, i: -1 | 1) {
	if (previous) {
		const continued = findEclipseCurvePoint(pbe, longitude, previous.y, i, 0)
		if (continued) return continued
	}

	for (const seed of PARTIAL_LIMIT_LATITUDE_SEEDS) {
		const point = findEclipseCurvePoint(pbe, longitude, seed, i, 0)
		if (point) return point
	}

	return undefined
}

// Finds the northern (i = +1) or southern (i = -1) limit of the partial eclipse, the curve where the
// penumbral cone edge is tangent to the surface with the Sun above the horizon (magnitude 0). It uses
// the correctly-scaled Newton solver and a meridian scan with continuation, mirroring findCurvePoints
// but with partial-limit seeding. The collected points are chained by proximity so the curve stays
// continuous across folds at its turning points and across the antimeridian, where neither longitude
// nor time ordering stays monotonic.
export function findPartialEclipseLimit(pbe: PolynomialBesselianElements, i: -1 | 1, options: SolarEclipseCurveOptions = {}): readonly GeoPoint[] {
	const longitudeStep = validStep(options.longitudeStep, DEFAULT_LONGITUDE_STEP)
	const maxAngularStep = validStep(options.maxAngularStep, DEFAULT_MAX_ANGULAR_STEP)
	const points: GeoPoint[] = []
	let previous: GeoPoint | undefined = undefined

	for (let longitude = -PI; longitude <= PI + 1e-12; longitude += longitudeStep) {
		const lon = Math.min(longitude, PI)
		const point = solvePartialLimitAtLongitude(pbe, lon, previous, i)

		// Refine the longitudes where the limit appears or disappears so the arc ends on Earth rather
		// than at the last coarse sample that happened to converge.
		if (previous && !point) pushDistinct(points, refineCurveBoundary(pbe, previous.x, lon, previous.y, true, i, 0))
		else if (!previous && point && lon > -PI) pushDistinct(points, refineCurveBoundary(pbe, lon - longitudeStep, lon, point.y, false, i, 0))

		if (previous && point) appendRefinedSegment(points, pbe, previous, point, i, 0, maxAngularStep)
		pushDistinct(points, point)
		previous = point
	}

	return chainCurvePointsByProximity(deduplicatePoints(points))
}

function refineCurveBoundary(pbe: PolynomialBesselianElements, aLon: Angle, bLon: Angle, seed: Angle, validLow: boolean, i: -1 | 0 | 1, G: number) {
	let low = aLon
	let high = bLon
	let best: GeoPoint | undefined = undefined

	for (let step = 0; step < BOUNDARY_REFINEMENT_STEPS; step++) {
		const mid = (low + high) * 0.5
		const point = findEclipseCurvePoint(pbe, mid, seed, i, G)

		if (point && validLow) {
			best = point
			low = mid
		} else if (point) {
			best = point
			high = mid
		} else if (validLow) {
			high = mid
		} else {
			low = mid
		}
	}

	return best
}

function appendCentralLineTimeSegment(points: GeoPoint[], pbe: PolynomialBesselianElements, a: GeoPoint, b: GeoPoint, maxAngularStep: Angle, depth = 0) {
	if (a.jd === undefined || b.jd === undefined || depth >= 12 || angularDistance(a, b) <= maxAngularStep) return

	const mid = centralLinePointAtJulianDay(pbe, (a.jd + b.jd) * 0.5)
	if (!mid) return

	appendCentralLineTimeSegment(points, pbe, a, mid, maxAngularStep, depth + 1)
	pushDistinct(points, mid)
	appendCentralLineTimeSegment(points, pbe, mid, b, maxAngularStep, depth + 1)
}

function sampleCentralLineByTime(pbe: PolynomialBesselianElements, options: SolarEclipseCurveOptions) {
	const begin = findExtremeLimitOfCentralLine(pbe, true, options)
	const end = findExtremeLimitOfCentralLine(pbe, false, options)
	if (!begin || !end) return []

	const points: GeoPoint[] = []
	pushDistinct(points, begin)
	appendCentralLineTimeSegment(points, pbe, begin, end, validStep(options.maxAngularStep, DEFAULT_MAX_ANGULAR_STEP))
	pushDistinct(points, end)

	return orderCurvePoints(deduplicatePoints(points))
}

function findCentralSeededCurvePoints(pbe: PolynomialBesselianElements, i: -1 | 0 | 1, G: number, options: SolarEclipseCurveOptions, centerLineSamples?: readonly GeoPoint[]) {
	if (i === 0 || G !== 1) return []

	// Solve the umbral limit at each central-line time sample, seeding the Newton iteration from the
	// central point itself (fixed at its meridian). Seeding from the instantaneous shadow-footprint
	// edge diverges near the path ends, where the grazing footprint elongates far from the
	// perpendicular path limit and the solver locks onto that distant, wrong-side tip.
	const centerLine = centerLineSamples ?? sampleCentralLineByTime(pbe, options)
	const maxAngularStep = validStep(options.maxAngularStep, DEFAULT_MAX_ANGULAR_STEP)
	const points: GeoPoint[] = []
	const julianDay0 = toJulianDay(pbe.time0)

	function solveAtCenter(center: GeoPoint) {
		if (center.jd === undefined) return undefined
		const point = solveEclipseCurvePoint(pbe, center.x, center.y, i, G, (center.jd - julianDay0) / pbe.stepDays)
		pushDistinct(points, point)
		return point
	}

	// Recursively subdivide the central-line time interval while the limit points solved at its ends are
	// farther apart than maxAngularStep, so a fast-moving limit (e.g. a circumpolar path whose limit
	// swings tens of degrees between two adjacent central samples) is traced as a smooth curve instead
	// of a straight chord. The central samples bound only the central line's spacing, not the limit's.
	function densify(aJd: number, a: GeoPoint, bJd: number, b: GeoPoint, depth: number) {
		if (depth >= UMBRA_LIMIT_REFINE_MAX_DEPTH || angularDistance(a, b) <= maxAngularStep) return
		const midJd = (aJd + bJd) * 0.5
		const center = centralLinePointAtJulianDay(pbe, midJd)
		const mid = center && solveAtCenter(center)
		if (!mid) return
		densify(aJd, a, midJd, mid, depth + 1)
		densify(midJd, mid, bJd, b, depth + 1)
	}

	let previous: GeoPoint | undefined
	let previousJd: number | undefined
	for (const center of centerLine) {
		if (center.jd === undefined) continue
		const point = solveAtCenter(center)
		if (!point) continue
		if (previous && previousJd !== undefined) densify(previousJd, previous, center.jd, point, 0)
		previous = point
		previousJd = center.jd
	}

	// One edge of the path stays above the horizon past the last coarse central sample near C1/C2, so
	// subdivide the first and last central intervals in time and solve there, extending the limit as
	// close to the endpoints as it remains visible instead of stopping at the last coarse sample.
	if (centerLine.length >= 2) {
		for (const [endIndex, neighborIndex] of [
			[0, 1],
			[centerLine.length - 1, centerLine.length - 2],
		] as const) {
			const endpoint = centerLine[endIndex]
			const neighbor = centerLine[neighborIndex]
			if (endpoint.jd === undefined || neighbor.jd === undefined) continue

			for (let step = 1; step < UMBRA_LIMIT_END_REFINEMENT_STEPS; step++) {
				const jd = endpoint.jd + (neighbor.jd - endpoint.jd) * (step / UMBRA_LIMIT_END_REFINEMENT_STEPS)
				const center = centralLinePointAtJulianDay(pbe, jd)
				if (center) solveAtCenter(center)
			}
		}
	}

	return points
}

function findTimeSeededShadowLimitPoints(pbe: PolynomialBesselianElements, contacts: Pick<SolarEclipseContactPoints, 'P1' | 'P4'>, i: -1 | 1, options: SolarEclipseCurveOptions) {
	if (contacts.P1?.jd === undefined || contacts.P4?.jd === undefined || contacts.P4.jd < contacts.P1.jd) return []

	const points: GeoPoint[] = []
	const stepDays = pbe.stepDays / 24
	const maximumJulianDay = toJulianDay(pbe.maximumTime)

	for (let jd = contacts.P1.jd; jd <= contacts.P4.jd + stepDays * 0.5; jd += stepDays) {
		const be = evaluateBesselianSample(pbe, timeAtJulianDay(pbe.time0, Math.min(jd, contacts.P4.jd)))
		pushDistinct(points, projectShadowLimitPoint(be, i))
	}

	if (maximumJulianDay >= contacts.P1.jd && maximumJulianDay <= contacts.P4.jd) {
		const be = evaluateBesselianSample(pbe, pbe.maximumTime)
		pushDistinct(points, projectShadowLimitPoint(be, i))
	}

	return orderCurvePoints(deduplicatePoints(points))
}

function projectShadowLimitPoint(be: BesselianSample, i: -1 | 1) {
	const radius = shadowLimitRadius(be, undefined)
	if (!(radius > 0) || !Number.isFinite(radius)) return undefined

	let best: GeoPoint | undefined = undefined

	for (let index = 0; index < 32; index++) {
		const angle = (TAU * index) / 32
		const cosAngle = Math.cos(angle)
		const sinAngle = Math.sin(angle)
		let currentRadius = radius
		let point: GeoPoint | undefined = undefined

		for (let iteration = 0; iteration < 8; iteration++) {
			const x = be.x + currentRadius * cosAngle
			const y = be.y + currentRadius * sinAngle
			if (x * x + y * y > 1 + 1e-12) {
				point = undefined
				break
			}

			point = projectFundamentalPoint(be, x, y) ?? undefined
			if (!finitePoint(point)) break

			const nextRadius = shadowLimitRadius(be, point)
			if (!Number.isFinite(nextRadius) || nextRadius <= 0) {
				point = undefined
				break
			}
			if (Math.abs(nextRadius - currentRadius) < 1e-9) break
			currentRadius = nextRadius
		}

		if (!finitePoint(point)) continue
		if (!best || (i > 0 ? point.y > best.y : point.y < best.y)) best = point
	}

	return best
}

function shadowLimitRadius(be: BesselianSample, point: GeoPoint | undefined) {
	return Math.abs(be.l2 - (point ? surfaceZeta(be, point) : 0) * be.tanF2)
}

function surfaceZeta(be: BesselianSample, point: GeoPoint) {
	const H = point.x + be.mu - deltaTLongitudeCorrection(be)
	const U = Math.atan(F_CONST * Math.tan(point.y))
	const rhoSinPhi = F_CONST * Math.sin(U)
	const rhoCosPhi = Math.cos(U)
	const sinD = Math.sin(be.d)
	const cosD = Math.cos(be.d)
	const cosH = Math.cos(H)

	return rhoSinPhi * sinD + rhoCosPhi * cosH * cosD
}

function appendRefinedSegment(points: GeoPoint[], pbe: PolynomialBesselianElements, a: GeoPoint, b: GeoPoint, i: -1 | 0 | 1, G: number, maxAngularStep: Angle) {
	const distance = angularDistance(a, b)
	if (!(distance > maxAngularStep)) return

	const steps = Math.min(16, Math.ceil(distance / maxAngularStep))
	for (let step = 1; step < steps; step++) {
		const intermediate = interpolateGreatCirclePoint(a, b, step / steps)
		// Seed from the great-circle-interpolated latitude (closer to the true curve point than
		// the segment's start latitude) to keep convergence stable across steep latitude changes.
		pushDistinct(points, findEclipseCurvePoint(pbe, intermediate.x, intermediate.y, i, G))
	}
}

function deduplicatePoints(points: readonly GeoPoint[]) {
	const out: GeoPoint[] = []
	for (const point of points) pushDistinct(out, point)
	return out
}

function orderCurvePoints(points: GeoPoint[]): readonly GeoPoint[] {
	if (points.length <= 2) return points

	if (points.every((point) => point.jd !== undefined)) {
		points.sort((a, b) => a.jd! - b.jd!)

		// Each instant maps to a single location on these time-parametrized curves, so points sharing a
		// Julian Day are the same place reached twice (e.g. by the geometric central-line seeding and
		// the meridian scan, which can land microscopically apart). Keep one per instant so the curve
		// stays strictly increasing in time with no zero-length steps.
		const ordered: GeoPoint[] = []
		for (const point of points) if (ordered.length === 0 || point.jd! - ordered.at(-1)!.jd! > CURVE_TIME_EPSILON_DAYS) ordered.push(point)
		return ordered
	}

	points.sort((a, b) => a.x - b.x || a.y - b.y)
	return deduplicatePoints(points)
}

// Greedy nearest-neighbor walk over the remaining points, starting at startIndex.
function greedyNearestNeighborChain(points: readonly GeoPoint[], startIndex: number): GeoPoint[] {
	const remaining = points.slice()
	const ordered: GeoPoint[] = [remaining.splice(startIndex, 1)[0]]

	while (remaining.length > 0) {
		const last = ordered.at(-1)!
		let bestIndex = 0
		let bestDistance = Number.POSITIVE_INFINITY

		for (let i = 0; i < remaining.length; i++) {
			const distance = angularDistance(last, remaining[i])
			if (distance < bestDistance) {
				bestDistance = distance
				bestIndex = i
			}
		}

		ordered.push(remaining.splice(bestIndex, 1)[0])
	}

	return ordered
}

// Orders scattered points along an open curve by proximity, robust to folds and antimeridian
// crossings where neither longitude nor time ordering stays monotonic. A first greedy walk from an
// arbitrary point ends at a genuine endpoint of the curve; walking again from that endpoint then
// traces the curve cleanly end to end.
function chainCurvePointsByProximity(points: readonly GeoPoint[]): readonly GeoPoint[] {
	if (points.length <= 2) return points

	const endpoint = greedyNearestNeighborChain(points, 0).at(-1)!
	const startIndex = points.indexOf(endpoint)
	return greedyNearestNeighborChain(points, Math.max(0, startIndex))
}

// Breaks a time-ordered umbral limit into drawable polylines, first at genuine discontinuities (where
// the limit leaves the sunlit hemisphere and reappears, leaving a gap far wider than the densified
// continuous spacing) and then folding each resulting piece at its latitude apex. Without the gap split
// a circumpolar limit would be drawn as a straight chord jumping across the discontinuity.
function splitUmbraLimit(points: readonly GeoPoint[], maxAngularStep: Angle): GeoPoint[][] {
	if (points.length <= 2) return splitAtMaxAbsLatitude(points)

	const threshold = maxAngularStep * UMBRA_LIMIT_GAP_SPLIT_FACTOR
	const pieces: GeoPoint[][] = []
	let current: GeoPoint[] = [points[0]]

	for (let i = 1; i < points.length; i++) {
		if (angularDistance(points[i - 1], points[i]) > threshold) {
			pieces.push(current)
			current = []
		}
		current.push(points[i])
	}
	pieces.push(current)

	return pieces.flatMap((piece) => splitAtMaxAbsLatitude(piece))
}

// Splits a polar/circumpolar limit at its largest absolute latitude.
export function splitAtMaxAbsLatitude(points: readonly GeoPoint[]): GeoPoint[][] {
	if (points.length <= 2) return [Array.from(points)]

	let index = 0
	let maxAbsLatitude = -1

	for (let i = 0; i < points.length; i++) {
		const absLatitude = Math.abs(points[i].y)
		if (absLatitude > maxAbsLatitude) {
			maxAbsLatitude = absLatitude
			index = i
		}
	}

	// The extreme latitude sits at an endpoint, so the limit does not fold back: keep it whole
	// instead of emitting a degenerate single-point segment.
	if (index <= 0 || index >= points.length - 1) return [Array.from(points)]

	// Share the apex point between both branches so they meet without a visible gap.
	return [points.slice(0, index + 1), points.slice(index)]
}

// Maximum recursion depth when subdividing a rise/set step in time to trace the true curve.
const RISE_SET_REFINE_MAX_DEPTH = 10

// One sampled instant of a rise/set phase: the two limb crossings (branches) at that Julian Day.
interface RiseSetSample {
	jd: number
	upper: GeoPoint
	lower: GeoPoint
}

// Computes sunrise and sunset eclipse curves from where the penumbra edge crosses the Earth's limb.
// The penumbra meets the limb in two phases — around sunrise (P1->P2) and sunset (P3->P4) — separated
// by the interval where it lies wholly on the day side (P2->P3, no horizon crossing). Each phase
// yields two branches (the two limb crossings) that meet at the tangency cusps; they are tracked by
// continuity, split at the day-side gap, and anchored to the P1/P2/P3/P4 contacts so they pass
// through them. Fast-moving stretches near the cusps are densified by subdividing in time so the
// curve follows the geometry rather than a straight chord.
export function computeRiseSetCurves(pbe: PolynomialBesselianElements, P1: GeoPoint, P4: GeoPoint, optionalContacts: { P2?: GeoPoint; P3?: GeoPoint } = {}, options: SolarEclipseRiseSetCurveOptions = {}): GeoPoint[][] {
	if (P1.jd === undefined || P4.jd === undefined || P4.jd < P1.jd) return []

	const stepDays = validStep(options.step, DEFAULT_RISE_SET_STEP_SECONDS) / 86400
	const adaptive = options.adaptive ?? true
	const contacts = [P1, optionalContacts.P2, optionalContacts.P3, P4].filter((contact): contact is GeoPoint => finitePoint(contact) && contact.jd !== undefined)

	// Collect the raw limb crossings of each phase, split where the penumbra leaves the limb, with the
	// two branches tracked by continuity. Densification happens later, on the true curve.
	const phases: RiseSetSample[][] = []
	let current: RiseSetSample[] | undefined
	let previousUpper: GeoPoint | undefined
	let previousLower: GeoPoint | undefined

	for (let jd = P1.jd; jd <= P4.jd + stepDays * 0.5; jd += stepDays) {
		const sampleJd = Math.min(jd, P4.jd)
		const crossings = riseSetCrossings(pbe, sampleJd)

		if (crossings.length < 2) {
			current = undefined
			previousUpper = undefined
			previousLower = undefined
			continue
		}

		let upper = crossings[0]
		let lower = crossings[1]

		// Keep each branch continuous: swap when the crossings exchange order across a step.
		if (previousUpper && previousLower && angularDistance(previousUpper, lower) + angularDistance(previousLower, upper) < angularDistance(previousUpper, upper) + angularDistance(previousLower, lower)) {
			;[upper, lower] = [lower, upper]
		}

		if (!current) {
			current = []
			phases.push(current)
		}

		current.push({ jd: sampleJd, upper, lower })
		previousUpper = upper
		previousLower = lower
	}

	// The tangency cusp bounding a phase falls within one sampling step of the phase's last crossing, so
	// match cusps to contacts by time (near the tangent the crossings can still be far apart in space).
	const snapJd = 2 * stepDays
	const curves: GeoPoint[][] = []

	for (const phase of phases) {
		const start = nearestContactByJd(phase[0].jd, contacts, snapJd)
		const end = nearestContactByJd(phase.at(-1)!.jd, contacts, snapJd)
		const [upper, lower] = buildRiseSetBranches(pbe, phase, start, end, adaptive)
		if (upper.length > 1) curves.push(upper)
		if (lower.length > 1) curves.push(lower)
	}

	return curves
}

// Projects the (up to two) points where the penumbra edge crosses the Earth's limb at one instant,
// ordered by descending fundamental-plane y.
function riseSetCrossings(pbe: PolynomialBesselianElements, jd: number): GeoPoint[] {
	const be = evaluateBesselianSample(pbe, timeAtJulianDay(pbe.time0, jd))
	return intersectEarthLimbWithCircle(be, be.x, be.y, Math.abs(be.l1))
		.map(([x, y]): GeoPoint | undefined => projectFundamentalPoint(be, x, y))
		.filter(finitePoint)
}

// Builds the two branches of one phase, anchoring the cusps to the tangency contacts and densifying
// each step by subdividing in time so both branches trace the true curve into the cusps.
function buildRiseSetBranches(pbe: PolynomialBesselianElements, phase: readonly RiseSetSample[], start: GeoPoint | undefined, end: GeoPoint | undefined, adaptive: boolean): [GeoPoint[], GeoPoint[]] {
	const upper: GeoPoint[] = []
	const lower: GeoPoint[] = []
	let previous: RiseSetSample | undefined

	function advance(sample: RiseSetSample) {
		if (adaptive && previous) refineRiseSetGap(pbe, previous, sample, upper, lower, 0)
		pushDistinct(upper, sample.upper)
		pushDistinct(lower, sample.lower)
		previous = sample
	}

	// A cusp contact is a degenerate sample where both branches meet at the contact point.
	if (start) advance({ jd: start.jd!, upper: start, lower: start })
	for (const sample of phase) advance(sample)
	if (end) advance({ jd: end.jd!, upper: end, lower: end })

	return [upper, lower]
}

// Recursively inserts true limb crossings between two consecutive rise/set samples while the branch
// step exceeds the angular limit, so the curve bends into the cusps instead of jumping in a straight line.
function refineRiseSetGap(pbe: PolynomialBesselianElements, a: RiseSetSample, b: RiseSetSample, upper: GeoPoint[], lower: GeoPoint[], depth: number) {
	if (depth >= RISE_SET_REFINE_MAX_DEPTH) return
	if (angularDistance(a.upper, b.upper) <= DEFAULT_MAX_ANGULAR_STEP && angularDistance(a.lower, b.lower) <= DEFAULT_MAX_ANGULAR_STEP) return

	const jd = (a.jd + b.jd) * 0.5
	const crossings = riseSetCrossings(pbe, jd)
	if (crossings.length < 2) return

	// Assign the midpoint crossings using whichever endpoint still has two distinct branches as the
	// continuity reference; a cusp endpoint has them merged and cannot disambiguate.
	const reference = angularDistance(a.upper, a.lower) >= angularDistance(b.upper, b.lower) ? a : b
	let midUpper = crossings[0]
	let midLower = crossings[1]
	if (angularDistance(reference.upper, midLower) + angularDistance(reference.lower, midUpper) < angularDistance(reference.upper, midUpper) + angularDistance(reference.lower, midLower)) {
		;[midUpper, midLower] = [midLower, midUpper]
	}

	const mid: RiseSetSample = { jd, upper: midUpper, lower: midLower }
	refineRiseSetGap(pbe, a, mid, upper, lower, depth + 1)
	pushDistinct(upper, midUpper)
	pushDistinct(lower, midLower)
	refineRiseSetGap(pbe, mid, b, upper, lower, depth + 1)
}

function nearestContactByJd(jd: number | undefined, contacts: readonly GeoPoint[], toleranceJd: number) {
	if (jd === undefined) return undefined

	let best: GeoPoint | undefined
	let bestDelta = toleranceJd

	for (const contact of contacts) {
		const delta = Math.abs(contact.jd! - jd)
		if (delta < bestDelta) {
			bestDelta = delta
			best = contact
		}
	}

	return best
}

function intersectEarthLimbWithCircle(be: Pick<BesselianSample, 'd'>, cx: number, cy: number, radius: number): [number, number][] {
	if (!Number.isFinite(cx) || !Number.isFinite(cy) || !Number.isFinite(radius) || radius < 0) return []

	const omega = earthLimbOmega(be)
	const invOmega = 1 / omega
	const radiusSquared = radius * radius
	const values = new Float64Array(LIMB_INTERSECTION_STEPS)
	const step = TAU / LIMB_INTERSECTION_STEPS
	const roots: number[] = []

	function residual(theta: number) {
		const dx = Math.cos(theta) - cx
		const dy = Math.sin(theta) * invOmega - cy
		return dx * dx + dy * dy - radiusSquared
	}

	function pushRoot(theta: number) {
		const root = normalizeAngle(theta)
		for (const existing of roots) {
			if (Math.abs(normalizePI(root - existing)) < 1e-7) return
		}
		roots.push(root)
	}

	for (let i = 0; i < LIMB_INTERSECTION_STEPS; i++) values[i] = residual(i * step)

	for (let i = 0; i < LIMB_INTERSECTION_STEPS; i++) {
		const next = (i + 1) % LIMB_INTERSECTION_STEPS
		const theta = i * step
		const nextTheta = (i + 1) * step
		const value = values[i]
		const nextValue = values[next]

		if (Math.abs(value) <= LIMB_INTERSECTION_TOLERANCE) pushRoot(theta)
		if (value * nextValue < 0) pushRoot(bisectLimbIntersection(residual, theta, nextTheta, value, nextValue))
	}

	for (let i = 0; i < LIMB_INTERSECTION_STEPS; i++) {
		const previousValue = values[(i + LIMB_INTERSECTION_STEPS - 1) % LIMB_INTERSECTION_STEPS]
		const value = values[i]
		const nextValue = values[(i + 1) % LIMB_INTERSECTION_STEPS]

		if (value > previousValue || value > nextValue) continue

		const theta = i * step
		const minimum = minimizeLimbIntersectionResidual(residual, theta - step, theta + step)

		if (minimum.value < -LIMB_INTERSECTION_TOLERANCE) {
			const leftTheta = theta - step
			const rightTheta = theta + step
			const leftValue = residual(leftTheta)
			const rightValue = residual(rightTheta)

			if (leftValue * minimum.value <= 0) pushRoot(bisectLimbIntersection(residual, leftTheta, minimum.theta, leftValue, minimum.value))
			if (minimum.value * rightValue <= 0) pushRoot(bisectLimbIntersection(residual, minimum.theta, rightTheta, minimum.value, rightValue))
		} else if (Math.abs(minimum.value) <= LIMB_TANGENCY_TOLERANCE) {
			pushRoot(minimum.theta)
		}

		if (value < previousValue || value < nextValue) continue

		const maximum = maximizeLimbIntersectionResidual(residual, theta - step, theta + step)
		if (Math.abs(maximum.value) <= LIMB_TANGENCY_TOLERANCE) pushRoot(maximum.theta)
	}

	const points = roots.map((theta) => [Math.cos(theta), Math.sin(theta) * invOmega] as [number, number])
	points.sort((a, b) => b[1] - a[1] || a[0] - b[0])
	return points
}

function bisectLimbIntersection(f: (theta: number) => number, min: number, max: number, minValue: number, maxValue: number) {
	let a = min
	let b = max
	let fa = minValue
	let fb = maxValue

	if (Math.abs(fa) <= LIMB_INTERSECTION_TOLERANCE) return a
	if (Math.abs(fb) <= LIMB_INTERSECTION_TOLERANCE) return b

	for (let iteration = 0; iteration < 48; iteration++) {
		const mid = (a + b) * 0.5
		const fm = f(mid)

		if (Math.abs(fm) <= LIMB_INTERSECTION_TOLERANCE) return mid
		if (fa * fm <= 0) {
			b = mid
			fb = fm
		} else {
			a = mid
			fa = fm
		}
	}

	return Math.abs(fa) < Math.abs(fb) ? a : b
}

function minimizeLimbIntersectionResidual(f: (theta: number) => number, min: number, max: number) {
	let a = min
	let b = max

	for (let iteration = 0; iteration < 40; iteration++) {
		const left = a + (b - a) / 3
		const right = b - (b - a) / 3

		if (f(left) < f(right)) b = right
		else a = left
	}

	const theta = (a + b) * 0.5
	return { theta, value: f(theta) }
}

function maximizeLimbIntersectionResidual(f: (theta: number) => number, min: number, max: number) {
	let a = min
	let b = max

	for (let iteration = 0; iteration < 40; iteration++) {
		const left = a + (b - a) / 3
		const right = b - (b - a) / 3

		if (f(left) > f(right)) b = right
		else a = left
	}

	const theta = (a + b) * 0.5
	return { theta, value: f(theta) }
}

// Collects the Julian Day spans a time-ordered limit curve is missing from: consecutive samples more
// than the threshold apart bracket a gap where the limit has left the sunlit hemisphere (circumpolar
// paths). Each gap is returned as [last present instant before it, first present instant after it].
function limitGaps(points: readonly GeoPoint[], threshold: Angle): [number, number][] {
	const gaps: [number, number][] = []
	let previous: GeoPoint | undefined

	for (const point of points) {
		if (point.jd === undefined) continue
		if (previous?.jd !== undefined && angularDistance(previous, point) > threshold) gaps.push([previous.jd, point.jd])
		previous = point
	}

	return gaps
}

// Drops a ring's trailing point when it duplicates the first; the polygon is closed at serialization time.
function closeRing(ring: GeoPoint[]) {
	if (ring.length > 1 && samePoint(ring[0], ring.at(-1)!)) ring.pop()
}

// Finest time subdivision (as a fraction of the gap) when tracing the umbral footprint across a gap.
const UMBRA_GAP_BRIDGE_MIN_STEPS = 1024

// Solves the umbral path limit point for branch i (+1 north, -1 south) at the fixed instant jd,
// parametrized by time instead of longitude. It places the observer where the shadow axis is at closest
// approach (the along-track offset vanishes) and exactly on the umbra edge (the cross-track offset equals
// the umbra radius), the same two conditions the longitude-fixed solver enforces, so both trace the
// identical curve and join without a kink. Being argued by time it stays single-valued and well
// -conditioned through the curve's longitude fold near a pole, where the longitude-fixed solver is
// degenerate and leaves the gap this fills. The seed (seedLon, seedLat) carries continuity from the
// previous point. Refraction is omitted here (sub-0.05 deg at these solar altitudes, far below the
// sampling step), so the bridged stretch can differ from the refraction-corrected solved stretch by that
// negligible amount at the junctions.
function solveTimeFixedLimitPoint(pbe: PolynomialBesselianElements, jd: number, i: -1 | 1, seedLon: Angle, seedLat: Angle): GeoPoint | undefined {
	const t = (jd - toJulianDay(pbe.time0)) / pbe.stepDays
	const be = evaluateBesselianAtT(pbe, t)
	const sample = evaluateBesselianSample(pbe, timeAtJulianDay(pbe.time0, jd))
	const longitudeCorrection = deltaTLongitudeCorrection(pbe)
	const sinD = Math.sin(be.d)
	const cosD = Math.cos(be.d)
	let phi = seedLat
	let lon = seedLon
	let result: GeoPoint | undefined

	for (let iteration = 0; iteration < SOLVER_MAX_ITERATIONS; iteration++) {
		const H = lon + be.mu - longitudeCorrection
		const sinH = Math.sin(H)
		const cosH = Math.cos(H)
		const U = Math.atan(F_CONST * Math.tan(phi))
		const rhoSinPhi = F_CONST * Math.sin(U)
		const rhoCosPhi = Math.cos(U)
		const zeta = rhoSinPhi * sinD + rhoCosPhi * cosH * cosD
		// Diurnal rate of the observer's hour angle, matching the longitude-fixed solver's relative velocity.
		const ksiPrime = rhoCosPhi * cosH * be.dmu
		const etaPrime = rhoCosPhi * sinH * sinD * be.dmu
		const a = be.dx - ksiPrime
		const b = be.dy - etaPrime
		const nSquared = a * a + b * b

		if (!(nSquared > 0) || !Number.isFinite(nSquared)) return undefined

		const n = Math.sqrt(nSquared)
		// Umbra radius on the fundamental plane at this surface height; |l2| as l2 flips sign total/annular.
		const radius = Math.abs(be.l2 - zeta * be.tanF2)
		// Observer offset perpendicular to the relative motion, of one umbra radius on side i: this places
		// the point on the umbra edge (cross-track residual zero) at the instant of closest approach
		// (along-track residual zero), i.e. exactly on the path limit for branch i at this instant.
		const ksi = be.x - (i * radius * b) / n
		const eta = be.y + (i * radius * a) / n
		const next = projectFundamentalPoint(sample, ksi, eta)

		if (!next) return undefined

		const move = Math.hypot(normalizePI(next.x - lon), next.y - phi)
		lon = next.x
		phi = next.y
		result = next

		if (move < SOLVER_TOLERANCE * DEG2RAD) break
	}

	return result
}

// Traces one band edge across a limit gap by marching forward in time and solving the path limit at each
// instant with the time-parametrized solver, seeded by continuity from the previous point. The gap is a
// longitude-fold region where the longitude-fixed solver is degenerate (which is what leaves the gap), so
// the time-parametrized solve traces it cleanly and joins the solved stretches without a kink. Only solved
// (physical) points are emitted: an instant the solver cannot resolve is skipped, leaving the gap there for
// splitUmbraLimit to break, rather than filled with a non-physical nearest footprint point. The step is
// halved whenever the edge moved more than maxAngularStep between samples, so the traced edge stays as
// dense as the rest of the limit. The gap is normally a solver artifact (the umbra stays fully on the
// sunlit disk), so the limit has a true position throughout it.
function bridgeUmbraFootprint(out: GeoPoint[], pbe: PolynomialBesselianElements, from: GeoPoint, to: GeoPoint, maxAngularStep: Angle, i: -1 | 1) {
	if (from.jd === undefined || to.jd === undefined || to.jd <= from.jd) return

	const span = to.jd - from.jd
	const minStep = span / UMBRA_GAP_BRIDGE_MIN_STEPS
	let previous = from
	let jd = from.jd
	let dt = span / 8

	while (jd + minStep < to.jd) {
		const nextJd = Math.min(jd + dt, to.jd)
		const edge = solveTimeFixedLimitPoint(pbe, nextJd, i, previous.x, previous.y)
		const stepSize = edge ? angularDistance(previous, edge) : 0

		// Refine while the edge moved too far in one step; otherwise accept it and ease the step back up.
		if (edge && nextJd < to.jd && stepSize > maxAngularStep && dt > minStep) {
			dt = Math.max(dt / 2, minStep)
			continue
		}

		jd = nextJd
		if (edge && nextJd < to.jd) {
			pushDistinct(out, edge)
			previous = edge
			if (stepSize < maxAngularStep * 0.5) dt = Math.min(dt * 2, span / 8)
		}
	}
}

// Fills an umbral limit's pole-side gaps in place by tracing the umbral footprint across each of them,
// returning a continuous curve. Where the latitude-based limit solver fails (near a pole) the curve
// switches source, from solved limit to footprint edge, but stays continuous and on the same physical
// edge. Used for both the drawn limit lines and the totality fill, so they stay consistent. A non-polar
// limit has no gaps and is returned unchanged.
function bridgeUmbraLimit(pbe: PolynomialBesselianElements, limit: readonly GeoPoint[], maxAngularStep: Angle, i: -1 | 1): readonly GeoPoint[] {
	if (limit.length < 2) return limit

	const gaps = limitGaps(limit, maxAngularStep * UMBRA_LIMIT_GAP_SPLIT_FACTOR)
	if (gaps.length === 0) return limit

	const out: GeoPoint[] = []
	let g = 0

	for (let index = 0; index < limit.length; index++) {
		const point = limit[index]
		// Collapse a bridge endpoint that lands within an instant of the solved point it abuts: both name the
		// same place on this time-parametrized curve, and the duplicate would leave a zero-length step that
		// reads as a 180-degree spike and degenerate self-intersection downstream.
		if (out.length === 0 || point.jd === undefined || out.at(-1)!.jd === undefined || point.jd - out.at(-1)!.jd! > CURVE_TIME_EPSILON_DAYS) pushDistinct(out, point)
		// On reaching the last present point before a gap, trace the footprint across to the limit's next
		// present point; the two bracket the gap in time.
		if (g < gaps.length && point.jd !== undefined && Math.abs(point.jd - gaps[g][0]) <= CURVE_TIME_EPSILON_DAYS) {
			const next = limit[index + 1]
			if (next) bridgeUmbraFootprint(out, pbe, point, next, maxAngularStep, i)
			g++
		}
	}

	return out
}

// Adaptively time-marches one umbral path edge (i = +1 north, -1 south) from fromJd to toJd, solving each
// point with the time-parametrized limit solver seeded by continuity from the previous one. Where the
// perpendicular edge lies on Earth this is the totality limit; where it lies beyond the terminator the
// solver's projection clamps it to the Earth limb, so the same march yields the physical limb cap near the
// tangential contacts without any artificial chord. The step halves whenever the edge moved more than
// maxAngularStep, keeping the cap as smooth as the rest of the band after densification.
function marchUmbraEdge(pbe: PolynomialBesselianElements, fromJd: number, toJd: number, i: -1 | 1, start: GeoPoint, maxAngularStep: Angle): GeoPoint[] {
	const out: GeoPoint[] = [start]
	const span = toJd - fromJd
	if (!(span > 0)) return out

	const minStep = span / UMBRA_GAP_BRIDGE_MIN_STEPS
	let previous = start
	let jd = fromJd
	let dt = span / 8

	while (jd + minStep < toJd) {
		const nextJd = Math.min(jd + dt, toJd)
		const edge = solveTimeFixedLimitPoint(pbe, nextJd, i, previous.x, previous.y)
		const stepSize = edge ? angularDistance(previous, edge) : 0

		// Halve while the edge moved too far in one step; otherwise accept it and ease the step back up.
		if (edge && stepSize > maxAngularStep && dt > minStep) {
			dt = Math.max(dt / 2, minStep)
			continue
		}

		jd = nextJd
		if (edge) {
			pushDistinct(out, edge)
			previous = edge
			if (stepSize < maxAngularStep * 0.5) dt = Math.min(dt * 2, span / 8)
		}
	}

	return out
}

// Builds the totality/annularity path as a single closed ring from the gap-bridged north and south limit
// curves plus four physical end caps. The limits trace the band's body where both perpendicular edges lie
// on Earth; near each external contact U1/U4 one edge runs off beyond the terminator, so the cap there is
// the Earth-limb arc the umbra sweeps, traced by marching that edge in time between the contact and the
// limit's endpoint (the same edge, so cap and limit join continuously). A normal eclipse's contacts sit at
// the limit endpoints, collapsing every cap to that single tangential point, so its band keeps its old
// taper; a grazing/circumpolar eclipse grows real caps that keep the central line (the shadow-axis foot,
// always inside the umbra) within the fill all the way to C1/C2. The only sharp turns are the tangential
// cusps at U1/U4. The whole contour is physical: there is no artificial closure to keep out of limit
// tests. Antimeridian wraps are split later at projection time.
function buildCappedTotalityRing(pbe: PolynomialBesselianElements, north: readonly GeoPoint[], south: readonly GeoPoint[], u1: GeoPoint, u4: GeoPoint, maxAngularStep: Angle): GeoPoint[][] {
	if (north.length < 2 || south.length < 2) return []

	const northStart = north[0]
	const northEnd = north.at(-1)!
	const southStart = south[0]
	const southEnd = south.at(-1)!

	if ([northStart, northEnd, southStart, southEnd, u1, u4].some((point) => point.jd === undefined)) {
		return buildSingleTotalityRing(north, south, u1, u4)
	}

	// Cap arcs from each contact to the abutting limit endpoint, marched along the same edge so they meet the
	// limit without a seam. A cap is built only where the limit endpoint sits more than one step from the
	// contact (the umbra grazed the terminator there): otherwise the contact already caps the band as a
	// single tangential vertex, and marching the near-degenerate interval would only jitter near the cusp.
	const startCapNorth = umbraCapArc(pbe, u1, northStart, 1, maxAngularStep)
	const endCapNorth = umbraCapArc(pbe, northEnd, u4, 1, maxAngularStep)
	const startCapSouth = umbraCapArc(pbe, u1, southStart, -1, maxAngularStep)
	const endCapSouth = umbraCapArc(pbe, southEnd, u4, -1, maxAngularStep)

	const ring: GeoPoint[] = []
	// U1 cusp -> north start cap -> north limit -> north end cap -> U4 cusp -> south end cap -> south limit
	// -> south start cap -> back to U1 cusp. The U1/U4 cusps are pushed explicitly so they anchor the band
	// even where a cap is degenerate (empty).
	pushDistinct(ring, u1)
	for (const point of startCapNorth) pushDistinct(ring, point)
	for (const point of north) pushDistinct(ring, point)
	for (const point of endCapNorth) pushDistinct(ring, point)
	pushDistinct(ring, u4)
	for (let k = endCapSouth.length - 1; k >= 0; k--) pushDistinct(ring, endCapSouth[k])
	for (let k = south.length - 1; k >= 0; k--) pushDistinct(ring, south[k])
	for (let k = startCapSouth.length - 1; k >= 0; k--) pushDistinct(ring, startCapSouth[k])
	closeRing(ring)

	return ring.length >= 3 ? [ring] : []
}

// Marches the cap arc along umbral edge i between a tangential contact and the abutting limit endpoint, in
// whichever time order runs forward. Returns an empty arc when the endpoint is within one step of the
// contact, so a band whose limit already reaches the contact keeps its single-vertex taper there.
function umbraCapArc(pbe: PolynomialBesselianElements, contact: GeoPoint, limitEnd: GeoPoint, i: -1 | 1, maxAngularStep: Angle): GeoPoint[] {
	if (contact.jd === undefined || limitEnd.jd === undefined || angularDistance(contact, limitEnd) <= maxAngularStep) return []
	const [from, to] = contact.jd < limitEnd.jd ? [contact, limitEnd] : [limitEnd, contact]
	return marchUmbraEdge(pbe, from.jd!, to.jd!, i, from, maxAngularStep)
}

// Builds one closed ring tracing the north limit forward, through the end tip, back along the south
// limit and through the start tip. The tip points (the path endpoints U1/U4, or the central-line
// endpoints C1/C2 when the umbral contacts are unavailable) taper the band to a point at each end. Used as
// a fallback when the umbral external contacts U1/U4 are unavailable to drive the time-marched ring.
function buildSingleTotalityRing(north: readonly GeoPoint[], south: readonly GeoPoint[], startTip?: GeoPoint, endTip?: GeoPoint): GeoPoint[][] {
	const ring: GeoPoint[] = []
	pushDistinct(ring, startTip)
	for (const point of north) pushDistinct(ring, point)
	pushDistinct(ring, endTip)
	for (let i = south.length - 1; i >= 0; i--) pushDistinct(ring, south[i])
	closeRing(ring)

	return ring.length >= 3 ? [ring] : []
}

// Builds the totality/annularity path from the gap-bridged, time-ordered north and south limit curves
// as a single closed ring, tapering it to the start and end tips (the umbral external contacts U1/U4
// where totality begins and ends as a point). Because the limits are already continuous (their pole-side
// gaps filled by the umbral footprint), the band is one simple ring of the path's true finite width, not
// split into disconnected blocks. Antimeridian wraps are split later at projection time.
function buildTotalityPathPolygon(north: readonly GeoPoint[], south: readonly GeoPoint[], startTip?: GeoPoint, endTip?: GeoPoint): GeoPoint[][] {
	if (north.length < 2 || south.length < 2) return []

	return buildSingleTotalityRing(north, south, startTip, endTip)
}

// TODO: Quando mesclar o codex/meeus, remover isso e usar eclipse.central
function isCentralEclipse(eclipse: SolarEclipse) {
	return eclipse.type !== 'partial' && Math.abs(eclipse.gamma) < CENTRAL_ECLIPSE_GAMMA_LIMIT
}

function hasUmbralPath(eclipse: SolarEclipse) {
	return eclipse.type !== 'partial'
}

// Computes serializable geographic geometry for a solar eclipse map.
export function computeSolarEclipseMapGeometry(eclipse: SolarEclipse, pbe: PolynomialBesselianElements, options: SolarEclipseMapGeometryOptions = {}): SolarEclipseMapGeometry {
	const contacts = findPenumbraContactPoints(pbe, options)
	const points: Writable<SolarEclipseContactPoints> = { ...contacts, Max: findMaximumPoint(pbe) }
	const longitudeStep = validStep(options.longitudeStep, DEFAULT_LONGITUDE_STEP)
	const maxAngularStep = validStep(options.maxAngularStep, DEFAULT_MAX_ANGULAR_STEP)
	const curveOptions = { longitudeStep, maxAngularStep, contactSearchSpan: options.contactSearchSpan }

	let centerLine: readonly GeoPoint[] = []
	let umbraNorth: GeoPoint[][] = []
	let umbraSouth: GeoPoint[][] = []
	let totalityPath: GeoPoint[][] = []

	// The time-sampled central line (and thus its C1/C2 endpoints) is shared across the central
	// line and both umbral limits, so compute it once for any non-partial eclipse.
	const centerLineSamples = hasUmbralPath(eclipse) ? sampleCentralLineByTime(pbe, curveOptions) : []

	if (isCentralEclipse(eclipse)) {
		const C1 = centerLineSamples[0]
		const C2 = centerLineSamples.at(-1)
		if (C1) points.C1 = C1
		if (C2) points.C2 = C2

		centerLine = findCurvePoints(pbe, 0, 0, curveOptions, centerLineSamples)
	}

	if (hasUmbralPath(eclipse)) {
		Object.assign(points, findUmbraContactPoints(pbe, options))

		const north = findCurvePoints(pbe, 1, 1, curveOptions, centerLineSamples)
		const south = findCurvePoints(pbe, -1, 1, curveOptions, centerLineSamples)
		// Fill each limit's pole-side solver gaps with the umbral footprint, then use the continuous curves
		// for both the drawn limit lines and the totality fill so they stay consistent.
		const fullNorth = bridgeUmbraLimit(pbe, north.length > 0 ? north : findTimeSeededShadowLimitPoints(pbe, contacts, 1, curveOptions), maxAngularStep, 1)
		const fullSouth = bridgeUmbraLimit(pbe, south.length > 0 ? south : findTimeSeededShadowLimitPoints(pbe, contacts, -1, curveOptions), maxAngularStep, -1)
		umbraNorth = splitUmbraLimit(fullNorth, maxAngularStep)
		umbraSouth = splitUmbraLimit(fullSouth, maxAngularStep)
		// Trace the fill by marching both umbral edges between the external contacts U1/U4, so it grows true
		// physical caps at grazing ends and contains the central line up to C1/C2. When the umbral contacts
		// are unavailable, fall back to the simple chord taper toward the central-line endpoints C1/C2.
		if (options.includePolygons ?? true) {
			totalityPath = points.U1 && points.U4 ? buildCappedTotalityRing(pbe, fullNorth, fullSouth, points.U1, points.U4, maxAngularStep) : buildTotalityPathPolygon(fullNorth, fullSouth, points.C1, points.C2)
		}
	}

	// Partial-eclipse (penumbra) north/south limits are produced for eclipses with an umbral path,
	// where the penumbra sweeps a well-defined day-side tangency curve. Pure partial eclipses leave
	// these empty, their boundary being described by the sunrise/sunset curves instead.
	let penumbraNorth: readonly GeoPoint[] = []
	let penumbraSouth: readonly GeoPoint[] = []
	if (hasUmbralPath(eclipse)) {
		penumbraNorth = findPartialEclipseLimit(pbe, 1, curveOptions)
		penumbraSouth = findPartialEclipseLimit(pbe, -1, curveOptions)
	}
	const riseSetCurves = (options.includeRiseSetCurves ?? false) && points.P1 && points.P4 ? computeRiseSetCurves(pbe, points.P1, points.P4, contacts, { step: options.riseSetStep }) : []

	return {
		points,
		lines: {
			centerLine,
			umbraNorth,
			umbraSouth,
			penumbraNorth,
			penumbraSouth,
			riseSetCurves,
		},
		polygons: {
			totalityPath,
		},
	}
}

// Splits a geographic polyline into drawable antimeridian-safe segments.
export function splitPolylineAtAntimeridian(line: readonly GeoPoint[]) {
	return splitGeoLineAtAntimeridian(line, false)
}

// Splits a geographic polygon ring into antimeridian-safe drawable rings.
export function splitPolygonAtAntimeridian(ring: readonly GeoPoint[]) {
	return splitGeoLineAtAntimeridian(ring, true)
}

function splitGeoLineAtAntimeridian(line: readonly GeoPoint[], close: boolean) {
	if (line.length === 0) return []

	const segments: GeoPoint[][] = []
	let current: GeoPoint[] = [line[0]]
	const count = close ? line.length + 1 : line.length

	for (let i = 1; i < count; i++) {
		const previous = line[(i - 1) % line.length]
		const point = line[i % line.length]
		const delta = point.x - previous.x

		if (Math.abs(delta) > PI) {
			const crossingLon = delta > 0 ? -PI : PI
			const oppositeLon = -crossingLon
			const t = (crossingLon - previous.x) / (point.x + (delta > 0 ? -TAU : TAU) - previous.x)
			const lat = previous.y + (point.y - previous.y) * clamp(t, 0, 1)
			const jd = previous.jd !== undefined && point.jd !== undefined ? previous.jd + (point.jd - previous.jd) * clamp(t, 0, 1) : undefined
			current.push({ x: crossingLon, y: lat, jd })
			if (current.length > 1) segments.push(current)
			current = [{ x: oppositeLon, y: lat, jd }, point]
		} else {
			current.push(point)
		}
	}

	if (current.length > 1) segments.push(current)

	return segments
}

const AU_IN_EARTH_RADII = AU_KM / EARTH_RADIUS_KM
// Light travel time per AU in days, used to retard body positions to their emission epoch.
const LIGHT_TIME_DAYS_PER_AU = LIGHT_TIME_AU / DAYSEC
// Light-time iterations. Two passes converge the retarded geocentric position well below the map's
// angular resolution for the Sun (~8.3 min one-way) and the Moon (~1.3 s one-way).
const LIGHT_TIME_ITERATIONS = 2

// Computes the apparent geocentric Sun and Moon positions used to derive Besselian elements. Both bodies
// are corrected for light-time (retarded emission position) and annual aberration (the geocenter's
// barycentric velocity), then rotated from ICRF/J2000 into the true equator and equinox of date. Delta T
// is taken from the Espenak and Meeus 2006 polynomials for the sample epoch.
//   time: instant of evaluation, any time scale (ephemerides convert internally).
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

	// Light-time corrected geocentric Moon position. The Moon provider is already geocentric, so retarding
	// its time directly yields the emission-epoch geocentric vector.
	let moonGeometric = moon(time)[0]
	for (let i = 0; i < LIGHT_TIME_ITERATIONS; i++) {
		const tau = vecLength(moonGeometric) * LIGHT_TIME_DAYS_PER_AU
		moonGeometric = moon(timeShift(time, -tau))[0]
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
	const year = 2000 + (toJulianDay(time) - J2000) / DAYSPERJY

	return {
		sunRightAscension: sRA,
		sunDeclination: sDEC,
		sunDistance: sD * AU_IN_EARTH_RADII,
		moonRightAscension: mRA,
		moonDeclination: mDEC,
		moonDistance: mD * AU_IN_EARTH_RADII,
		deltaT: deltaTByEspenakMeeus2006(year),
	}
}

// Serializes projected polyline or polygon pieces into an SVG path data string. Each piece becomes one
// subpath (M ... L ...); pieces with fewer than two points are skipped. When close is true each subpath
// is closed with Z, suitable for filled polygons.
export function pointsToSvgPathData(pieces: readonly (readonly Point[])[], close = false, precision = 2): string {
	const subpaths: string[] = []

	function formatCoordinate(value: number) {
		return Number(value.toFixed(precision)).toString()
	}

	for (const piece of pieces) {
		if (piece.length < 2) continue

		let data = `M${formatCoordinate(piece[0].x)} ${formatCoordinate(piece[0].y)}`
		for (let i = 1; i < piece.length; i++) data += `L${formatCoordinate(piece[i].x)} ${formatCoordinate(piece[i].y)}`
		if (close) data += 'Z'

		subpaths.push(data)
	}

	return subpaths.join('')
}

// Projects solar eclipse map geometry and serializes each feature into SVG path data strings, aligned
// to an equirectangular world map of the given width and height. Antimeridian wraps are split into
// separate subpaths by the underlying projection.
export function solarEclipseMapToSvgPaths(geometry: SolarEclipseMapGeometry, projection: Projection, { precision = 2, ...options }: SolarEclipseMapSvgProjectionOptions = {}): SolarEclipseMapSvgPaths {
	function polylinePath(geo: readonly GeoPoint[]) {
		return pointsToSvgPathData(projectPolyline(projection, geo), false, precision)
	}

	function segmentedPath(segments: readonly (readonly GeoPoint[])[]) {
		const pieces: Point[][] = []
		for (const segment of segments) for (const piece of projectPolyline(projection, segment, options)) pieces.push(piece)
		return pointsToSvgPathData(pieces, false, precision)
	}

	function polygonsPath(rings: readonly (readonly GeoPoint[])[]) {
		const pieces: Point[][] = []
		for (const ringPieces of projectPolygon(projection, rings)) for (const piece of ringPieces) pieces.push(piece)
		return pointsToSvgPathData(pieces, true, precision)
	}

	function projectPoint(point: GeoPoint | undefined) {
		return point ? projection.project(point.x, point.y, undefined) : undefined
	}

	const { points, lines, polygons } = geometry

	return {
		centerLine: polylinePath(lines.centerLine),
		umbraNorth: segmentedPath(lines.umbraNorth),
		umbraSouth: segmentedPath(lines.umbraSouth),
		penumbraNorth: polylinePath(lines.penumbraNorth),
		penumbraSouth: polylinePath(lines.penumbraSouth),
		riseSetCurves: segmentedPath(lines.riseSetCurves),
		totalityPath: polygonsPath(polygons.totalityPath),
		points: {
			P1: projectPoint(points.P1),
			P2: projectPoint(points.P2),
			P3: projectPoint(points.P3),
			P4: projectPoint(points.P4),
			U1: projectPoint(points.U1),
			U2: projectPoint(points.U2),
			U3: projectPoint(points.U3),
			U4: projectPoint(points.U4),
			C1: projectPoint(points.C1),
			C2: projectPoint(points.C2),
			Max: projectPoint(points.Max),
		},
	}
}
