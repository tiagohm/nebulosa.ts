import { type Angle, deg, normalizeAngle, normalizePI } from './angle'
import { DAYSEC, DEG2RAD, J2000, PI, PIOVERTWO, RAD2DEG, TAU } from './constants'
import { eraS2p } from './erfa'
import { sphericalInterpolate, sphericalSeparation, type Point } from './geometry'
import { clamp, type NumberArray } from './math'
import { bisection, type RootFindingOptions } from './optimization'
import { polynomialRegression } from './regression'
import type { SolarEclipse } from './sun'
import { timeShift, timeSubtract, toJulianDay, type Time } from './time'
import type { Writable } from './types'
import { vecDot, vecLength, vecMinus, vecNormalizeMut } from './vec3'

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
const SUN_RADIUS_EARTH_RADII = 109.076370706
// Lunar radius k1 used for penumbral contacts, per NASA/Espenak convention.
const MOON_RADIUS_PENUMBRA_EARTH_RADII = 0.272488
// Lunar radius k2 used for umbral contacts (total/annular path), per NASA/Espenak convention.
const MOON_RADIUS_UMBRA_EARTH_RADII = 0.272281
const BOUNDARY_REFINEMENT_STEPS = 18

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
	readonly longitude: Angle
	// Latitude in radians, normalized to [-PI/2, PI/2].
	readonly latitude: Angle
	// Optional Julian Day associated with this point.
	readonly jd?: number
}

// Named eclipse contact and central-path endpoints.
export interface EclipseContactPoints {
	// First external penumbral contact.
	readonly P1?: GeoPoint
	// First internal penumbral contact.
	readonly P2?: GeoPoint
	// Last internal penumbral contact.
	readonly P3?: GeoPoint
	// Last external penumbral contact.
	readonly P4?: GeoPoint
	// First central-line contact with Earth.
	readonly U1?: GeoPoint
	// Last central-line contact with Earth.
	readonly U2?: GeoPoint
	// Greatest eclipse point.
	readonly Max?: GeoPoint
}

// Projection-agnostic solar eclipse map geometry.
export interface EclipseMapGeometry {
	// Named contact points and greatest-eclipse point.
	readonly points: EclipseContactPoints
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
export interface EclipseCurveOptions {
	// Longitude scan step in radians.
	readonly longitudeStep?: Angle
	// Maximum angular spacing between neighboring curve points in radians.
	readonly maxAngularStep?: Angle
	// Half-width of the contact root search window around maximumTime, in seconds.
	readonly contactSearchSpan?: number
}

// Options for finding eclipse contact roots.
export interface EclipseContactOptions {
	// Half-width of the root search window around maximumTime, in seconds.
	readonly contactSearchSpan?: number
}

// Options for computing rise and set curves.
export interface RiseSetCurveOptions {
	// Sampling step in seconds.
	readonly step?: number
	// Whether to adaptively refine large angular gaps.
	readonly adaptive?: boolean
}

// Projected point produced from a GeoPoint through the existing projection API.
export interface ProjectedGeoPoint extends Point {
	// Optional Julian Day copied from the source geographic point.
	jd?: number
}

function finitePoint(point: GeoPoint | undefined): point is GeoPoint {
	return !!point && Number.isFinite(point.longitude) && Number.isFinite(point.latitude) && point.latitude >= -PIOVERTWO && point.latitude <= PIOVERTWO && point.longitude >= -PI && point.longitude <= PI
}

function samePoint(a: GeoPoint, b: GeoPoint) {
	return Math.abs(a.longitude - b.longitude) < 1e-9 && Math.abs(a.latitude - b.latitude) < 1e-9 && Math.abs((a.jd ?? 0) - (b.jd ?? 0)) < 1e-10
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
	return sphericalSeparation(a.longitude, a.latitude, b.longitude, b.latitude)
}

function interpolateGreatCirclePoint(a: GeoPoint, b: GeoPoint, fraction: number): GeoPoint {
	const [longitude, latitude] = sphericalInterpolate(a.longitude, a.latitude, b.longitude, b.latitude, fraction)

	return {
		longitude: normalizePI(longitude),
		latitude,
		jd: a.jd !== undefined && b.jd !== undefined ? a.jd + (b.jd - a.jd) * fraction : undefined,
	}
}

function validStep(value: number | undefined, fallback: number) {
	return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback
}

function contactSearchSpanDays(options?: EclipseContactOptions) {
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
export function projectFundamentalPoint(be: BesselianSample, x: number, y: number) {
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

	return { longitude: normalizePI(lon), latitude: lat, jd: toJulianDay(be.time) }
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
export function findPenumbraContactPoints(pbe: PolynomialBesselianElements, options?: EclipseContactOptions): Pick<EclipseContactPoints, 'P1' | 'P2' | 'P3' | 'P4'> {
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
export function findExtremeLimitOfCentralLine(pbe: PolynomialBesselianElements, begin: boolean, options?: EclipseContactOptions) {
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
	let t = 0
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
		const Q = (Q1 + Q2) / (n * DEG2RAD)
		const dL1 = be.l1 - zeta * be.tanF1
		const dL2 = be.l2 - zeta * be.tanF2
		const E = dL1 - G * (dL1 + dL2)
		const deltaPhi = Q === 0 ? Number.NaN : deg((W + i * Math.abs(E)) / Q)

		if (!Number.isFinite(tau) || !Number.isFinite(deltaPhi)) return undefined

		t += tau
		phi += deltaPhi

		if (!Number.isFinite(t) || !Number.isFinite(phi) || Math.abs(phi) > PIOVERTWO) return undefined
		if (Math.abs(tau) < SOLVER_TOLERANCE && Math.abs(deltaPhi) < SOLVER_TOLERANCE * DEG2RAD) {
			return { longitude: normalizePI(longitude), latitude: phi, jd }
		}
	}

	return undefined
}

// Finds a drawable eclipse curve for the selected limit family. When the time-sampled central
// line is already available it can be supplied to avoid recomputing it for umbral seeding.
export function findCurvePoints(pbe: PolynomialBesselianElements, i: -1 | 0 | 1, G: number, options: EclipseCurveOptions = {}, centerLineSamples?: readonly GeoPoint[]): readonly GeoPoint[] {
	// The central line is fully described by its time parametrization, whose adaptive subdivision
	// already enforces maxAngularStep, so the meridian scan below is only needed for the limits.
	if (i === 0) return centerLineSamples ?? sampleCentralLineByTime(pbe, options)

	const longitudeStep = validStep(options.longitudeStep, DEFAULT_LONGITUDE_STEP)
	const maxAngularStep = validStep(options.maxAngularStep, DEFAULT_MAX_ANGULAR_STEP)
	const seeds = [0, Math.sign(pbe.y[0] || 1) * (89.9 * DEG2RAD)] as const
	const points: GeoPoint[] = findCentralSeededCurvePoints(pbe, i, G, options, centerLineSamples)
	const previousBySeed: (GeoPoint | undefined)[] = [undefined, undefined]

	for (let longitude = -PI; longitude <= PI + 1e-12; longitude += longitudeStep) {
		const lon = Math.min(longitude, PI)

		for (let seedIndex = 0; seedIndex < seeds.length; seedIndex++) {
			const previousSeed = previousBySeed[seedIndex]
			const seed = previousSeed ? previousSeed.latitude : seeds[seedIndex]
			const point = findEclipseCurvePoint(pbe, lon, seed, i, G)
			const previous = previousBySeed[seedIndex]

			if (previous && !point) pushDistinct(points, refineCurveBoundary(pbe, previous.longitude, lon, previous.latitude, true, i, G))
			else if (!previous && point && lon > -PI) pushDistinct(points, refineCurveBoundary(pbe, lon - longitudeStep, lon, point.latitude, false, i, G))

			if (previous && point) appendRefinedSegment(points, pbe, previous, point, i, G, maxAngularStep)
			pushDistinct(points, point)
			previousBySeed[seedIndex] = point
		}
	}

	return orderCurvePoints(deduplicatePoints(points))
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

function sampleCentralLineByTime(pbe: PolynomialBesselianElements, options: EclipseCurveOptions) {
	const begin = findExtremeLimitOfCentralLine(pbe, true, options)
	const end = findExtremeLimitOfCentralLine(pbe, false, options)
	if (!begin || !end) return []

	const points: GeoPoint[] = []
	pushDistinct(points, begin)
	appendCentralLineTimeSegment(points, pbe, begin, end, validStep(options.maxAngularStep, DEFAULT_MAX_ANGULAR_STEP))
	pushDistinct(points, end)

	return orderCurvePoints(deduplicatePoints(points))
}

function findCentralSeededCurvePoints(pbe: PolynomialBesselianElements, i: -1 | 0 | 1, G: number, options: EclipseCurveOptions, centerLineSamples?: readonly GeoPoint[]) {
	if (i === 0 || G !== 1) return []

	// Narrow central paths can fall between coarse longitude samples, so seed umbral
	// limits from the time-parametrized central path before the meridian scan.
	const centerLine = centerLineSamples ?? sampleCentralLineByTime(pbe, options)
	const points: GeoPoint[] = []

	for (const center of centerLine) {
		if (center.jd === undefined) continue
		const be = evaluateBesselianSample(pbe, timeAtJulianDay(pbe.time0, center.jd))
		const point = projectShadowLimitPoint(be, i)
		pushDistinct(points, point)
	}

	return points
}

function findTimeSeededShadowLimitPoints(pbe: PolynomialBesselianElements, contacts: Pick<EclipseContactPoints, 'P1' | 'P4'>, i: -1 | 1, options: EclipseCurveOptions) {
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
		if (!best || (i > 0 ? point.latitude > best.latitude : point.latitude < best.latitude)) best = point
	}

	return best
}

function shadowLimitRadius(be: BesselianSample, point: GeoPoint | undefined) {
	return Math.abs(be.l2 - (point ? surfaceZeta(be, point) : 0) * be.tanF2)
}

function surfaceZeta(be: BesselianSample, point: GeoPoint) {
	const H = point.longitude + be.mu - deltaTLongitudeCorrection(be)
	const U = Math.atan(F_CONST * Math.tan(point.latitude))
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
		pushDistinct(points, findEclipseCurvePoint(pbe, intermediate.longitude, intermediate.latitude, i, G))
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
	} else {
		points.sort((a, b) => a.longitude - b.longitude || a.latitude - b.latitude)
	}

	return points
}

// Angular gap between consecutive points that signals two interleaved, spatially disjoint branches
// (e.g. a partial-eclipse limit split into separate regions) rather than a continuous sweep.
const CURVE_DISCONTINUITY = 60 * DEG2RAD

// Re-chains a curve that the time/longitude ordering left with a large spatial discontinuity.
// Well-behaved (continuous) curves contain no such gap and are returned unchanged; only the
// pathological interleaved-branch case is reordered, via a greedy nearest-neighbor walk that
// keeps each disjoint branch contiguous instead of bridging back and forth between them.
function stitchDiscontinuousCurve(points: readonly GeoPoint[]): readonly GeoPoint[] {
	if (points.length <= 2) return points

	let discontinuous = false
	for (let i = 1; i < points.length; i++) {
		if (angularDistance(points[i - 1], points[i]) > CURVE_DISCONTINUITY) {
			discontinuous = true
			break
		}
	}

	if (!discontinuous) return points

	const remaining = points.slice()
	let startIndex = 0
	for (let i = 1; i < remaining.length; i++) if (remaining[i].longitude < remaining[startIndex].longitude) startIndex = i

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

// Splits a polar/circumpolar limit at its largest absolute latitude.
export function splitAtMaxAbsLatitude(points: readonly GeoPoint[]): GeoPoint[][] {
	if (points.length <= 2) return [Array.from(points)]

	let index = 0
	let maxAbsLatitude = -1

	for (let i = 0; i < points.length; i++) {
		const absLatitude = Math.abs(points[i].latitude)
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

// Computes sunrise and sunset eclipse curves from penumbra/Earth intersections.
export function computeRiseSetCurves(pbe: PolynomialBesselianElements, P1: GeoPoint, P4: GeoPoint, _optionalContacts: { P2?: GeoPoint; P3?: GeoPoint } = {}, options: RiseSetCurveOptions = {}): GeoPoint[][] {
	if (P1.jd === undefined || P4.jd === undefined || P4.jd < P1.jd) return []

	const stepDays = validStep(options.step, DEFAULT_RISE_SET_STEP_SECONDS) / 86400
	const adaptive = options.adaptive ?? true
	const north: GeoPoint[] = []
	const south: GeoPoint[] = []
	let lastJulianDay = P1.jd

	for (let jd = P1.jd; jd <= P4.jd + stepDays * 0.5; jd += stepDays) {
		lastJulianDay = Math.min(jd, P4.jd)
		appendRiseSetIntersections(pbe, lastJulianDay, north, south, adaptive)
	}

	if (lastJulianDay < P4.jd) appendRiseSetIntersections(pbe, P4.jd, north, south, adaptive)

	return [north, south].filter((line) => line.length > 0)
}

function appendRiseSetIntersections(pbe: PolynomialBesselianElements, jd: number, north: GeoPoint[], south: GeoPoint[], adaptive: boolean) {
	const be = evaluateBesselianSample(pbe, timeAtJulianDay(pbe.time0, jd))
	const intersections = intersectUnitCircleWithCircle(be.x, be.y, Math.abs(be.l1))
	const projected = intersections.map(([x, y]) => projectFundamentalPoint(be, x, y)).filter(finitePoint)

	if (projected.length === 1) {
		appendRiseSetPoint(north, projected[0]!, adaptive)
		appendRiseSetPoint(south, projected[0]!, adaptive)
	} else {
		if (projected[0]) appendRiseSetPoint(north, projected[0], adaptive)
		if (projected[1]) appendRiseSetPoint(south, projected[1], adaptive)
	}
}

function appendRiseSetPoint(line: GeoPoint[], point: GeoPoint, adaptive: boolean) {
	const previous = line.at(-1)

	if (adaptive && previous) {
		const distance = angularDistance(previous, point)
		if (distance > DEFAULT_MAX_ANGULAR_STEP) {
			const steps = Math.min(16, Math.ceil(distance / DEFAULT_MAX_ANGULAR_STEP))
			for (let step = 1; step < steps; step++) line.push(interpolateGreatCirclePoint(previous, point, step / steps))
		}
	}

	pushDistinct(line, point)
}

function intersectUnitCircleWithCircle(cx: number, cy: number, radius: number): [number, number][] {
	const d = Math.hypot(cx, cy)
	if (!(d > 0) || !Number.isFinite(d) || !Number.isFinite(radius) || radius < 0) return []
	if (d > 1 + radius || d < Math.abs(1 - radius)) return []

	const a = (1 - radius * radius + d * d) / (2 * d)
	const hSquared = 1 - a * a
	if (hSquared < -1e-12) return []

	const h = Math.sqrt(Math.max(0, hSquared))
	const x2 = (a * cx) / d
	const y2 = (a * cy) / d
	const rx = -cy * (h / d)
	const ry = cx * (h / d)
	const points: [number, number][] =
		h === 0
			? [[x2, y2]]
			: [
					[x2 + rx, y2 + ry],
					[x2 - rx, y2 - ry],
				]
	points.sort((a, b) => b[1] - a[1])
	return points
}

function buildTotalityPathPolygons(northSegments: readonly GeoPoint[][], southSegments: readonly GeoPoint[][], U1?: GeoPoint, U2?: GeoPoint) {
	const rings: GeoPoint[][] = []
	const count = Math.min(northSegments.length, southSegments.length)

	for (let i = 0; i < count; i++) {
		const north = northSegments[i]
		const south = southSegments[i]
		if (north.length < 2 || south.length < 2) continue

		const ring = [...north, ...south.toReversed()]
		if (count === 1 && U2) ring.push(U2)
		if (count === 1 && U1) ring.push(U1)
		rings.push(ring)
	}

	return rings
}

// TODO: Quando mesclar o codex/meeus, remover isso e usar eclipse.central
function isCentralEclipse(eclipse: SolarEclipse) {
	return eclipse.type !== 'partial' && Math.abs(eclipse.gamma) < CENTRAL_ECLIPSE_GAMMA_LIMIT
}

function hasUmbralPath(eclipse: SolarEclipse) {
	return eclipse.type !== 'partial'
}

// Computes serializable geographic geometry for a solar eclipse map.
export function computeSolarEclipseMapGeometry(eclipse: SolarEclipse, pbe: PolynomialBesselianElements, options: SolarEclipseMapGeometryOptions = {}): EclipseMapGeometry {
	const contacts = findPenumbraContactPoints(pbe, options)
	const points: Writable<EclipseContactPoints> = { ...contacts, Max: findMaximumPoint(pbe) }
	const longitudeStep = validStep(options.longitudeStep, DEFAULT_LONGITUDE_STEP)
	const maxAngularStep = validStep(options.maxAngularStep, DEFAULT_MAX_ANGULAR_STEP)
	const curveOptions = { longitudeStep, maxAngularStep, contactSearchSpan: options.contactSearchSpan }

	let centerLine: readonly GeoPoint[] = []
	let umbraNorth: GeoPoint[][] = []
	let umbraSouth: GeoPoint[][] = []
	let totalityPath: GeoPoint[][] = []

	// The time-sampled central line (and thus its U1/U2 endpoints) is shared across the central
	// line and both umbral limits, so compute it once for any non-partial eclipse.
	const centerLineSamples = hasUmbralPath(eclipse) ? sampleCentralLineByTime(pbe, curveOptions) : []

	if (isCentralEclipse(eclipse)) {
		const U1 = centerLineSamples[0]
		const U2 = centerLineSamples.at(-1)
		if (U1) points.U1 = U1
		if (U2) points.U2 = U2

		centerLine = findCurvePoints(pbe, 0, 0, curveOptions, centerLineSamples)
	}

	if (hasUmbralPath(eclipse)) {
		const north = findCurvePoints(pbe, 1, 1, curveOptions, centerLineSamples)
		const south = findCurvePoints(pbe, -1, 1, curveOptions, centerLineSamples)
		umbraNorth = splitAtMaxAbsLatitude(north.length > 0 ? north : findTimeSeededShadowLimitPoints(pbe, contacts, 1, curveOptions))
		umbraSouth = splitAtMaxAbsLatitude(south.length > 0 ? south : findTimeSeededShadowLimitPoints(pbe, contacts, -1, curveOptions))
		if (options.includePolygons ?? true) totalityPath = buildTotalityPathPolygons(umbraNorth, umbraSouth, points.U1, points.U2)
	}

	const penumbraNorth = stitchDiscontinuousCurve(findCurvePoints(pbe, 1, 0, curveOptions))
	const penumbraSouth = stitchDiscontinuousCurve(findCurvePoints(pbe, -1, 0, curveOptions))
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
		const delta = point.longitude - previous.longitude

		if (Math.abs(delta) > PI) {
			const crossingLon = delta > 0 ? -PI : PI
			const oppositeLon = -crossingLon
			const t = (crossingLon - previous.longitude) / (point.longitude + (delta > 0 ? -TAU : TAU) - previous.longitude)
			const lat = previous.latitude + (point.latitude - previous.latitude) * clamp(t, 0, 1)
			const jd = previous.jd !== undefined && point.jd !== undefined ? previous.jd + (point.jd - previous.jd) * clamp(t, 0, 1) : undefined
			current.push({ longitude: crossingLon, latitude: lat, jd })
			if (current.length > 1) segments.push(current)
			current = [{ longitude: oppositeLon, latitude: lat, jd }, point]
		} else {
			current.push(point)
		}
	}

	if (current.length > 1) segments.push(current)

	return segments
}
