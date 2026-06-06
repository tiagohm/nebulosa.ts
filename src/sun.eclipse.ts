import { type Angle, deg, normalizeAngle, normalizePI } from './angle'
import { DAYSEC, DEG2RAD, J2000, PI, PIOVERTWO, RAD2DEG, TAU } from './constants'
import { sphericalInterpolate, sphericalSeparation, type Point } from './geometry'
import { clamp, type NumberArray } from './math'
import { bisection, type RootFindingOptions } from './optimization'
import { polynomialRegression } from './regression'
import type { SolarEclipse } from './sun'
import { timeShift, timeSubtract, toJulianDay, type Time } from './time'
import type { Writable } from './types'

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
const MOON_RADIUS_EARTH_RADII = 0.2725076
const BOUNDARY_REFINEMENT_STEPS = 18

// Polynomial Besselian elements fitted around the eclipse maximum.
export interface PolynomialBesselianElements {
	// Time of the polynomial origin.
	readonly time0: Time
	// Time of maximum eclipse.
	readonly maximumTime: Time
	// Delta T in seconds.
	readonly deltaT: number
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
	// Half-width of the contact root search window around time0, in seconds.
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
	// Half-width of the contact root search window around time0, in seconds.
	readonly contactSearchSpan?: number
}

// Options for finding eclipse contact roots.
export interface EclipseContactOptions {
	// Half-width of the root search window around time0, in seconds.
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

function finitePoint(point: GeoPoint | null | undefined): point is GeoPoint {
	return !!point && Number.isFinite(point.longitude) && Number.isFinite(point.latitude) && point.latitude >= -PIOVERTWO && point.latitude <= PIOVERTWO && point.longitude >= -PI && point.longitude <= PI
}

function samePoint(a: GeoPoint, b: GeoPoint) {
	return Math.abs(a.longitude - b.longitude) < 1e-9 && Math.abs(a.latitude - b.latitude) < 1e-9 && Math.abs((a.jd ?? 0) - (b.jd ?? 0)) < 1e-10
}

function pushDistinct(points: GeoPoint[], point: GeoPoint | null | undefined) {
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
	const be = evaluateBesselian(pbe, timeAtJulianDay(pbe.time0, jd))
	return projectFundamentalPoint(be, be.x, be.y)
}

// Evaluates polynomial Besselian elements at one time.
export function evaluateBesselian(pbe: PolynomialBesselianElements, time: Time): InstantBesselianElements {
	const t = timeSubtract(time, pbe.time0) / pbe.stepDays
	const x = evaluatePolynomial(pbe.x, t)
	const y = evaluatePolynomial(pbe.y, t)

	return {
		time,
		deltaT: pbe.deltaT,
		x,
		y,
		l1: evaluatePolynomial(pbe.l1, t),
		l2: evaluatePolynomial(pbe.l2, t),
		d: evaluatePolynomial(pbe.d, t),
		mu: normalizeAngle(evaluatePolynomial(pbe.mu, t)),
		dx: evaluatePolynomialDerivative(pbe.x, t),
		dy: evaluatePolynomialDerivative(pbe.y, t),
		tanF1: pbe.tanF1,
		tanF2: pbe.tanF2,
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
	const deltaRA = normalizePI(sample.moonRightAscension - sample.sunRightAscension)
	const x = sample.moonDistance * Math.cos(sample.sunDeclination) * deltaRA
	const y = sample.moonDistance * (sample.moonDeclination - sample.sunDeclination)
	const sunSemidiameter = Math.asin(clamp(SUN_RADIUS_EARTH_RADII / sample.sunDistance, -1, 1))
	const moonSemidiameter = Math.asin(clamp(MOON_RADIUS_EARTH_RADII / sample.moonDistance, -1, 1))
	const moonParallax = Math.asin(clamp(1 / sample.moonDistance, -1, 1))
	const invParallax = moonParallax === 0 ? 0 : 1 / moonParallax
	const sunMoonDistance = physicalSunMoonDistance(sample)
	const invSunMoonDistance = sunMoonDistance > 0 ? 1 / sunMoonDistance : 0
	const l1 = (sunSemidiameter + moonSemidiameter) * invParallax
	const l2 = (sunSemidiameter - moonSemidiameter) * invParallax
	// const gmst = greenwichMeanSiderealTime(time)
	const gmst = normalizeAngle(280.46061837 * DEG2RAD + 360.98564736629 * DEG2RAD * (time.day - J2000 + time.fraction))
	const mu = normalizeAngle(gmst - sample.sunRightAscension)

	return {
		time,
		deltaT: sample.deltaT ?? 0,
		x,
		y,
		l1,
		l2,
		d: sample.sunDeclination,
		mu,
		dx: 0,
		dy: 0,
		tanF1: (SUN_RADIUS_EARTH_RADII + MOON_RADIUS_EARTH_RADII) * invSunMoonDistance,
		tanF2: (SUN_RADIUS_EARTH_RADII - MOON_RADIUS_EARTH_RADII) * invSunMoonDistance,
	}
}

function physicalSunMoonDistance(sample: SunMoonPosition) {
	if (!(sample.sunDistance > 0) || !(sample.moonDistance > 0)) return 0

	const separation = sphericalSeparation(sample.sunRightAscension, sample.sunDeclination, sample.moonRightAscension, sample.moonDeclination)
	const chord = 2 * Math.sin(0.5 * separation)
	const distance = Math.sqrt((sample.sunDistance - sample.moonDistance) ** 2 + sample.sunDistance * sample.moonDistance * chord * chord)
	return Number.isFinite(distance) ? distance : 0
}

// Projects one fundamental-plane point to geographic longitude and latitude.
export function projectFundamentalPoint(be: InstantBesselianElements, x: number, y: number): GeoPoint | null {
	if (!Number.isFinite(x) || !Number.isFinite(y)) return null

	const sinD = Math.sin(be.d)
	const cosD = Math.cos(be.d)
	const omega = 1 / Math.sqrt(1 - EARTH_E2 * cosD * cosD)
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
	const lon = H - be.mu + DELTA_T_LONGITUDE_FACTOR * be.deltaT

	if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null

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
	const julianDay0 = toJulianDay(pbe.time0)
	const searchSpanDays = contactSearchSpanDays(options)
	const from = julianDay0 - searchSpanDays
	const to = julianDay0 + searchSpanDays
	const mid = (from + to) * 0.5

	function external(jd: number) {
		const be = evaluateBesselian(pbe, timeAtJulianDay(pbe.time0, jd))
		return Math.hypot(be.x, be.y) - 1 - be.l1
	}

	function internal(jd: number) {
		const be = evaluateBesselian(pbe, timeAtJulianDay(pbe.time0, jd))
		return Math.hypot(be.x, be.y) - 1 + be.l1
	}

	return {
		P1: projectContactRoot(pbe, bisectRoot(external, from, mid)),
		P2: projectContactRoot(pbe, bisectRoot(internal, from, mid)),
		P3: projectContactRoot(pbe, bisectRoot(internal, mid, to)),
		P4: projectContactRoot(pbe, bisectRoot(external, mid, to)),
	}
}

function projectContactRoot(pbe: PolynomialBesselianElements, jd: number | undefined) {
	if (jd === undefined) return undefined

	const be = evaluateBesselian(pbe, timeAtJulianDay(pbe.time0, jd))
	const angle = Math.atan2(be.y, be.x)
	return projectFundamentalPoint(be, Math.cos(angle), Math.sin(angle)) ?? undefined
}

// Finds the greatest eclipse point.
export function findMaximumPoint(pbe: PolynomialBesselianElements): GeoPoint | undefined {
	const be = evaluateBesselian(pbe, pbe.maximumTime)
	return projectFundamentalPoint(be, be.x, be.y) ?? undefined
}

// Finds one extreme endpoint of the central line.
export function findExtremeLimitOfCentralLine(pbe: PolynomialBesselianElements, begin: boolean, options?: EclipseContactOptions): GeoPoint | null {
	const julianDay0 = toJulianDay(pbe.time0)
	const searchSpanDays = contactSearchSpanDays(options)
	const from = begin ? julianDay0 - searchSpanDays : julianDay0
	const to = begin ? julianDay0 : julianDay0 + searchSpanDays

	function fn(jd: number) {
		const be = evaluateBesselian(pbe, timeAtJulianDay(pbe.time0, jd))
		return be.x * be.x + be.y * be.y - 1
	}

	const jd = bisectRoot(fn, from, to)

	if (jd === undefined) return null

	const be = evaluateBesselian(pbe, timeAtJulianDay(pbe.time0, jd))
	return projectFundamentalPoint(be, be.x, be.y)
}

// Solves one eclipse curve point at fixed longitude.
// i = 0, G ignored -> central line
// i = +1, G = 1 -> northern limit of total/annular path
// i = -1, G = 1 -> southern limit of total/annular path
// i = +1, G = 0 -> northern limit of partial eclipse
// i = -1, G = 0 -> southern limit of partial eclipse
// i = ±1, 0<G<1 -> equal-magnitude curve
export function findEclipseCurvePoint(pbe: PolynomialBesselianElements, longitude: Angle, initialLatitude: Angle, i: -1 | 0 | 1, G: number): GeoPoint | null {
	let t = 0
	let phi = initialLatitude
	const julianDay0 = toJulianDay(pbe.time0)
	let jd = julianDay0

	for (let iteration = 0; iteration < SOLVER_MAX_ITERATIONS; iteration++) {
		jd = julianDay0 + t * pbe.stepDays
		const be = evaluateBesselian(pbe, timeAtJulianDay(pbe.time0, jd))
		const H = longitude + be.mu - DELTA_T_LONGITUDE_FACTOR * pbe.deltaT
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

		if (!Number.isFinite(h) || h < 0) return null

		const hD = h * RAD2DEG

		if (G !== 0 && hD <= 10) {
			const sigma = 1.000012 + 0.0002282559 * Math.exp(-0.5035747 * hD)
			ksi *= sigma
			eta *= sigma
			zeta *= sigma
		}

		const ksiPrime = rhoCosPhi * cosH * TAU * pbe.stepDays
		const etaPrime = rhoCosPhi * sinH * sinD * TAU * pbe.stepDays
		const u = be.x - ksi
		const v = be.y - eta
		const a = be.dx - ksiPrime
		const b = be.dy - etaPrime
		const nSquared = a * a + b * b

		if (!(nSquared > 0) || !Number.isFinite(nSquared)) return null

		const n = Math.sqrt(nSquared)
		const tau = -(u * a + v * b) / nSquared
		const W = (v * a - u * b) / n
		const Q1 = b * sinH * rhoSinPhi
		const Q2 = a * (cosH * sinD * rhoSinPhi + cosD * rhoCosPhi)
		const Q = (Q1 + Q2) / (n * DEG2RAD)
		const dL1 = be.l1 - zeta * be.tanF1
		const dL2 = be.l2 - zeta * be.tanF2
		const E = dL1 - G * (dL1 + dL2)
		const deltaPhi = Q === 0 ? Number.NaN : deg((W + i * Math.abs(E)) / Q)

		if (!Number.isFinite(tau) || !Number.isFinite(deltaPhi)) return null

		t += tau
		phi += deltaPhi

		if (!Number.isFinite(t) || !Number.isFinite(phi) || Math.abs(phi) > PIOVERTWO) return null
		if (Math.abs(tau) < SOLVER_TOLERANCE && Math.abs(deltaPhi) < SOLVER_TOLERANCE * DEG2RAD) {
			return { longitude: normalizePI(longitude), latitude: phi, jd }
		}
	}

	return null
}

// Finds a drawable eclipse curve for the selected limit family.
export function findCurvePoints(pbe: PolynomialBesselianElements, i: -1 | 0 | 1, G: number, options: EclipseCurveOptions = {}): GeoPoint[] {
	const longitudeStep = validStep(options.longitudeStep, DEFAULT_LONGITUDE_STEP)
	const maxAngularStep = validStep(options.maxAngularStep, DEFAULT_MAX_ANGULAR_STEP)
	const seeds = [0, Math.sign(pbe.y[0] || 1) * (89.9 * DEG2RAD)] as const
	const points: GeoPoint[] = i === 0 ? sampleCentralLineByTime(pbe, options) : findCentralSeededCurvePoints(pbe, i, G, options)
	const previousBySeed: (GeoPoint | null)[] = [null, null]

	for (let longitude = -PI; longitude <= PI + 1e-12; longitude += longitudeStep) {
		const lon = Math.min(longitude, PI)

		for (let seedIndex = 0; seedIndex < seeds.length; seedIndex++) {
			const previousSeed = previousBySeed[seedIndex]
			const seed = previousSeed ? previousSeed.latitude : seeds[seedIndex]
			const point = findEclipseCurvePoint(pbe, lon, seed, i, G)
			const previous = previousBySeed[seedIndex]

			if (previous && !point) pushDistinct(points, refineCurveBoundary(pbe, previous.longitude, lon, previous.latitude, i, G))
			else if (!previous && point && lon > -PI) pushDistinct(points, refineCurveBoundary(pbe, lon - longitudeStep, lon, point.latitude, i, G))

			if (previous && point) appendRefinedSegment(points, pbe, previous, point, seed, i, G, maxAngularStep)
			pushDistinct(points, point)
			previousBySeed[seedIndex] = point
		}
	}

	return orderCurvePoints(deduplicatePoints(points))
}

function refineCurveBoundary(pbe: PolynomialBesselianElements, aLon: Angle, bLon: Angle, seed: Angle, i: -1 | 0 | 1, G: number) {
	let low = aLon
	let high = bLon
	let best: GeoPoint | null = null

	for (let step = 0; step < BOUNDARY_REFINEMENT_STEPS; step++) {
		const mid = (low + high) * 0.5
		const point = findEclipseCurvePoint(pbe, mid, seed, i, G)

		if (point) {
			best = point
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

function findCentralSeededCurvePoints(pbe: PolynomialBesselianElements, i: -1 | 0 | 1, G: number, options: EclipseCurveOptions) {
	if (i === 0 || G !== 1) return []

	// Narrow central paths can fall between coarse longitude samples, so seed umbral
	// limits from the time-parametrized central path before the meridian scan.
	const centerLine = sampleCentralLineByTime(pbe, options)
	const points: GeoPoint[] = []

	for (const center of centerLine) {
		if (center.jd === undefined) continue
		const be = evaluateBesselian(pbe, timeAtJulianDay(pbe.time0, center.jd))
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
		const be = evaluateBesselian(pbe, timeAtJulianDay(pbe.time0, Math.min(jd, contacts.P4.jd)))
		pushDistinct(points, projectShadowLimitPoint(be, i))
	}

	if (maximumJulianDay >= contacts.P1.jd && maximumJulianDay <= contacts.P4.jd) {
		const be = evaluateBesselian(pbe, pbe.maximumTime)
		pushDistinct(points, projectShadowLimitPoint(be, i))
	}

	return orderCurvePoints(deduplicatePoints(points))
}

function projectShadowLimitPoint(be: InstantBesselianElements, i: -1 | 1) {
	const radius = Math.abs(be.l2)
	if (!(radius > 0) || !Number.isFinite(radius)) return null

	let best: GeoPoint | null = null

	for (let index = 0; index < 32; index++) {
		const angle = (TAU * index) / 32
		const x = be.x + radius * Math.cos(angle)
		const y = be.y + radius * Math.sin(angle)
		if (x * x + y * y > 1 + 1e-12) continue

		const point = projectFundamentalPoint(be, x, y)
		if (!finitePoint(point)) continue
		if (!best || (i > 0 ? point.latitude > best.latitude : point.latitude < best.latitude)) best = point
	}

	return best
}

function appendRefinedSegment(points: GeoPoint[], pbe: PolynomialBesselianElements, a: GeoPoint, b: GeoPoint, seed: Angle, i: -1 | 0 | 1, G: number, maxAngularStep: Angle) {
	const distance = angularDistance(a, b)
	if (!(distance > maxAngularStep)) return

	const steps = Math.min(16, Math.ceil(distance / maxAngularStep))
	for (let step = 1; step < steps; step++) {
		const intermediate = interpolateGreatCirclePoint(a, b, step / steps)
		pushDistinct(points, findEclipseCurvePoint(pbe, intermediate.longitude, seed, i, G))
	}
}

function deduplicatePoints(points: readonly GeoPoint[]) {
	const out: GeoPoint[] = []
	for (const point of points) pushDistinct(out, point)
	return out
}

function orderCurvePoints(points: GeoPoint[]) {
	if (points.length <= 2) return points

	if (points.every((point) => point.jd !== undefined)) {
		points.sort((a, b) => a.jd! - b.jd!)
	} else {
		points.sort((a, b) => a.longitude - b.longitude || a.latitude - b.latitude)
	}

	return points
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

	return [points.slice(0, index + 1), points.slice(Math.max(0, index - 1))].filter((segment) => segment.length > 0)
}

// Computes sunrise and sunset eclipse curves from penumbra/Earth intersections.
export function computeRiseSetCurves(pbe: PolynomialBesselianElements, P1: GeoPoint, P4: GeoPoint, _optionalContacts: { P2?: GeoPoint; P3?: GeoPoint } = {}, options: RiseSetCurveOptions = {}): GeoPoint[][] {
	if (P1.jd === undefined || P4.jd === undefined || P4.jd < P1.jd) return []

	const stepDays = validStep(options.step, DEFAULT_RISE_SET_STEP_SECONDS) / 86400
	const adaptive = options.adaptive ?? true
	const north: GeoPoint[] = []
	const south: GeoPoint[] = []

	for (let jd = P1.jd; jd <= P4.jd + stepDays * 0.5; jd += stepDays) {
		const be = evaluateBesselian(pbe, timeAtJulianDay(pbe.time0, Math.min(jd, P4.jd)))
		const intersections = intersectUnitCircleWithCircle(be.x, be.y, Math.abs(be.l1))
		const projected = intersections.map(([x, y]) => projectFundamentalPoint(be, x, y)).filter(finitePoint)

		if (projected[0]) appendRiseSetPoint(north, projected[0], adaptive)
		if (projected[1]) appendRiseSetPoint(south, projected[1], adaptive)
	}

	return [north, south].filter((line) => line.length > 0)
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
	let centerLine: GeoPoint[] = []
	let umbraNorth: GeoPoint[][] = []
	let umbraSouth: GeoPoint[][] = []
	let totalityPath: GeoPoint[][] = []

	if (isCentralEclipse(eclipse)) {
		const U1 = findExtremeLimitOfCentralLine(pbe, true, options)
		const U2 = findExtremeLimitOfCentralLine(pbe, false, options)
		if (U1) points.U1 = U1
		if (U2) points.U2 = U2

		centerLine = findCurvePoints(pbe, 0, 0, curveOptions)
	}

	if (hasUmbralPath(eclipse)) {
		const north = findCurvePoints(pbe, 1, 1, curveOptions)
		const south = findCurvePoints(pbe, -1, 1, curveOptions)
		umbraNorth = splitAtMaxAbsLatitude(north.length > 0 ? north : findTimeSeededShadowLimitPoints(pbe, contacts, 1, curveOptions))
		umbraSouth = splitAtMaxAbsLatitude(south.length > 0 ? south : findTimeSeededShadowLimitPoints(pbe, contacts, -1, curveOptions))
		if (options.includePolygons ?? true) totalityPath = buildTotalityPathPolygons(umbraNorth, umbraSouth, points.U1, points.U2)
	}

	const penumbraNorth = findCurvePoints(pbe, 1, 0, curveOptions)
	const penumbraSouth = findCurvePoints(pbe, -1, 0, curveOptions)
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
