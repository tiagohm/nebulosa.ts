import { normalizeAngle, normalizePI, type Angle } from './angle'
import { DAYSEC, TAU, WGS84_FLATTENING, WGS84_RADIUS } from './constants'
import type { Distance } from './distance'
import { moon as geocentricMoon } from './elpmpp02'
import { eraGst06a } from './erfa'
import { matMulVec } from './mat3'
import { clamp } from './math'
import { moonSemidiameter } from './moon'
import { polynomialRegression } from './regression'
import { type SolarEclipseType, sunSemidiameter } from './sun'
import { type Time, Timescale, greenwichApparentSiderealTime, precessionNutationMatrix, timeConvert, timeNormalize, timeShift, tt, ut1 } from './time'
import { NumberComparator } from './util'
import { type MutVec3, type Vec3, vecDistance, vecDot, vecLength, vecMinus } from './vec3'
import { earth as barycentricEarth, sun as barycentricSun } from './vsop87e'

// Besselian elements describe the lunar shadow axis relative to a fundamental
// plane through Earth's center. They are a compact, serializable basis for
// later solar-eclipse map curves and local circumstances.

// This implementation uses TT for ephemerides and UT1 for Earth rotation. When
// deltaTSeconds is supplied, UT1 is approximated as TT - deltaT for the
// sidereal angle; otherwise the repository time-scale conversion providers are
// used. Default Sun and Moon positions are geocentric vectors in AU, rotated to
// the true equator and equinox of date. Cone radii use straight-line tangent
// cone geometry, suitable for interactive maps rather than final ephemeris
// bulletins.

// The fundamental-plane axes are tied to the shadow axis: positive x points
// east in increasing right ascension and positive y points north. Generated
// elements use the repository's internal l2 convention where positive l2 is
// total/umbral and negative l2 is annular/antumbral. Published NASA/EclipseWise
// Besselian tables use the opposite l2 sign; callers can pass those tables
// directly by leaving l2SignConvention unset or setting it to "negativeTotal".

// CONVENTIONS
// x: Fundamental-plane coordinate in Earth equatorial radii; positive x points east toward increasing right ascension.
// y: Fundamental-plane coordinate in Earth equatorial radii; positive y points north.
// d: Declination of the lunar shadow axis in the apparent equatorial frame of date, radians.
// mu: Greenwich hour-angle-like rotation parameter GAST - alpha of the shadow axis, radians, unwrapped before fitting.
// l1: Penumbral cone radius on the fundamental plane in Earth equatorial radii.
// l2: Umbra or antumbra cone radius on the fundamental plane in Earth equatorial radii; interpreted according to l2SignConvention.
// tanF1: Tangent of the penumbral cone half-angle from straight-line external tangent geometry.
// tanF2: Tangent of the umbral or antumbral cone half-angle from straight-line internal tangent geometry.
// time: Ephemerides are evaluated in TT. Earth rotation uses UT1, or TT - deltaTSeconds when deltaTSeconds is supplied.
// angles: Angles are radians. Distances inside vector geometry are AU and fitted plane coordinates are scaled by the stored Earth equatorial radius.

const DEFAULT_INTERVAL_HOURS = 6
const DEFAULT_STEP_MINUTES = 10
const DEFAULT_POLYNOMIAL_DEGREE = 3
const MIN_VECTOR_LENGTH = 1e-15

const BESSELIAN_QUANTITIES = ['x', 'y', 'd', 'mu', 'l1', 'l2', 'tanF1', 'tanF2'] as const

type BesselianQuantity = (typeof BESSELIAN_QUANTITIES)[number]

export type BesselianL2SignConvention = 'positiveTotal' | 'negativeTotal'

// Polynomial coefficients in ascending powers of tauHours.
export interface BesselianPolynomial {
	readonly degree: number
	readonly coefficients: number[]
}

// Sampled Besselian element set and fitted polynomials.
export interface BesselianElements {
	readonly t0: Time
	readonly deltaTSeconds: number
	readonly validFrom: Time
	readonly validTo: Time
	readonly polynomialDegree: number
	readonly x: BesselianPolynomial
	readonly y: BesselianPolynomial
	readonly d: BesselianPolynomial
	readonly mu: BesselianPolynomial
	readonly l1: BesselianPolynomial
	readonly l2: BesselianPolynomial
	// Defaults to the published NASA/EclipseWise convention, where negative l2 is total.
	readonly l2SignConvention?: BesselianL2SignConvention
	readonly tanF1: BesselianPolynomial
	readonly tanF2: BesselianPolynomial
	readonly eclipseTypeApprox: SolarEclipseType | 'UNKNOWN'
	readonly geocentricMaximum: Time
	readonly earth: {
		readonly equatorialRadius: number
		readonly flattening: number
	}
	readonly samples?: readonly BesselianSample[]
}

// Input context for generating solar-eclipse Besselian elements.
export interface SolarEclipseBesselianContext {
	maximumApprox: Time
	intervalHours?: number
	stepMinutes?: number
	polynomialDegree?: 3 | 4
	deltaTSeconds?: number
	earthEquatorialRadius?: Distance
	earthFlattening?: number
	solarSemidiameter?: Angle
	lunarSemidiameter?: Angle
	computeApparentGeocentricSun?: (time: Time) => Vec3
	computeApparentGeocentricMoon?: (time: Time) => Vec3
}

// Raw Besselian quantities at a TT sample instant.
export interface BesselianSample {
	time: Time
	tauHours: number
	x: number
	y: number
	d: number
	mu: number
	l1: number
	l2: number
	tanF1: number
	tanF2: number
}

// Evaluated Besselian state at an arbitrary time.
export interface BesselianState {
	readonly time: Time
	readonly tauHours: number
	readonly x: number
	readonly y: number
	readonly d: number
	readonly mu: number
	readonly l1: number
	readonly l2: number
	readonly tanF1: number
	readonly tanF2: number
}

// First derivative of a Besselian state with respect to tauHours.
export interface BesselianStateDerivative {
	readonly time: Time
	readonly tauHours: number
	readonly dx: number
	readonly dy: number
	readonly dd: number
	readonly dmu: number
	readonly dl1: number
	readonly dl2: number
	readonly dtanF1: number
	readonly dtanF2: number
}

interface ResolvedBesselianContext {
	readonly maximumTT: Time
	readonly intervalHours: number
	readonly stepMinutes: number
	readonly polynomialDegree: 3 | 4
	readonly deltaTSeconds: number
	readonly earthEquatorialRadius: number
	readonly earthFlattening: number
	readonly solarSemidiameter?: number
	readonly lunarSemidiameter?: number
	readonly siderealDeltaTSeconds?: number
	readonly computeApparentGeocentricSun?: (time: Time) => Vec3
	readonly computeApparentGeocentricMoon?: (time: Time) => Vec3
}

// Generates fitted Besselian elements around an approximate geocentric maximum.
export function generateBesselianElements(input: SolarEclipseBesselianContext): BesselianElements {
	const context = resolveContext(input)
	const halfIntervalHours = context.intervalHours / 2
	const tauHours = sampleTauHours(context.intervalHours, context.stepMinutes)
	const samples = tauHours.map((tau) => computeSample(shiftTT(context.maximumTT, tau), tau, context))

	if (samples.length < context.polynomialDegree + 1) {
		throw new Error(`at least ${context.polynomialDegree + 1} Besselian samples are required for degree ${context.polynomialDegree}`)
	}

	unwrapSamples(samples, 'mu')

	const elements: BesselianElements = {
		t0: context.maximumTT,
		deltaTSeconds: context.deltaTSeconds,
		validFrom: shiftTT(context.maximumTT, -halfIntervalHours),
		validTo: shiftTT(context.maximumTT, halfIntervalHours),
		polynomialDegree: context.polynomialDegree,
		x: fitPolynomial(samples, 'x', context.polynomialDegree),
		y: fitPolynomial(samples, 'y', context.polynomialDegree),
		d: fitPolynomial(samples, 'd', context.polynomialDegree),
		mu: fitPolynomial(samples, 'mu', context.polynomialDegree),
		l1: fitPolynomial(samples, 'l1', context.polynomialDegree),
		l2: fitPolynomial(samples, 'l2', context.polynomialDegree),
		l2SignConvention: 'positiveTotal',
		tanF1: fitPolynomial(samples, 'tanF1', context.polynomialDegree),
		tanF2: fitPolynomial(samples, 'tanF2', context.polynomialDegree),
		eclipseTypeApprox: classifyEclipse(samples),
		geocentricMaximum: context.maximumTT,
		earth: {
			equatorialRadius: context.earthEquatorialRadius,
			flattening: context.earthFlattening,
		},
		samples,
	}

	return elements
}

// Evaluates a Besselian polynomial at tauHours.
export function evaluateBesselianPolynomial(poly: BesselianPolynomial, tauHours: number) {
	let value = 0

	for (let i = poly.coefficients.length - 1; i >= 0; i--) {
		value = value * tauHours + poly.coefficients[i]
	}

	return value
}

// Evaluates the derivative of a Besselian polynomial at tauHours.
export function derivativeBesselianPolynomial(poly: BesselianPolynomial, tauHours: number) {
	let value = 0

	for (let i = poly.coefficients.length - 1; i >= 1; i--) {
		value = value * tauHours + i * poly.coefficients[i]
	}

	return value
}

// Normalizes a time to hours from the element epoch t0.
export function normalizeBesselianTime(elements: BesselianElements, time: Time) {
	time = timeConvert(time, Timescale.TT)
	return (time.day - elements.t0.day + time.fraction - elements.t0.fraction) * 24
}

// Evaluates fitted Besselian elements at an arbitrary time.
export function evaluateBesselian(elements: BesselianElements, time: Time): BesselianState {
	const tauHours = normalizeBesselianTime(elements, time)
	const l2Scale = besselianL2Scale(elements)

	return {
		time: timeConvert(time, Timescale.TT),
		tauHours,
		x: evaluateBesselianPolynomial(elements.x, tauHours),
		y: evaluateBesselianPolynomial(elements.y, tauHours),
		d: evaluateBesselianPolynomial(elements.d, tauHours),
		mu: evaluateBesselianPolynomial(elements.mu, tauHours),
		l1: evaluateBesselianPolynomial(elements.l1, tauHours),
		l2: evaluateBesselianPolynomial(elements.l2, tauHours) * l2Scale,
		tanF1: evaluateBesselianPolynomial(elements.tanF1, tauHours),
		tanF2: evaluateBesselianPolynomial(elements.tanF2, tauHours),
	}
}

// Evaluates first derivatives of fitted Besselian elements at an arbitrary time.
export function derivativeBesselian(elements: BesselianElements, time: Time): BesselianStateDerivative {
	const tauHours = normalizeBesselianTime(elements, time)
	const l2Scale = besselianL2Scale(elements)

	return {
		time: timeConvert(time, Timescale.TT),
		tauHours,
		dx: derivativeBesselianPolynomial(elements.x, tauHours),
		dy: derivativeBesselianPolynomial(elements.y, tauHours),
		dd: derivativeBesselianPolynomial(elements.d, tauHours),
		dmu: derivativeBesselianPolynomial(elements.mu, tauHours),
		dl1: derivativeBesselianPolynomial(elements.l1, tauHours),
		dl2: derivativeBesselianPolynomial(elements.l2, tauHours) * l2Scale,
		dtanF1: derivativeBesselianPolynomial(elements.tanF1, tauHours),
		dtanF2: derivativeBesselianPolynomial(elements.tanF2, tauHours),
	}
}

function resolveContext(input: SolarEclipseBesselianContext): ResolvedBesselianContext {
	if (!input.maximumApprox) throw new Error('maximumApprox is required')

	const maximumTT = resolveMaximumTT(input.maximumApprox)
	const intervalHours = input.intervalHours ?? DEFAULT_INTERVAL_HOURS
	const stepMinutes = input.stepMinutes ?? DEFAULT_STEP_MINUTES
	const polynomialDegree = input.polynomialDegree ?? DEFAULT_POLYNOMIAL_DEGREE
	const earthEquatorialRadius = input.earthEquatorialRadius ?? WGS84_RADIUS
	const earthFlattening = input.earthFlattening ?? WGS84_FLATTENING
	const deltaTSeconds = input.deltaTSeconds ?? computeDeltaTSeconds(maximumTT)

	validatePositiveFinite('intervalHours', intervalHours)
	validatePositiveFinite('stepMinutes', stepMinutes)
	validatePositiveFinite('earthEquatorialRadius', earthEquatorialRadius)
	validateFinite('deltaTSeconds', deltaTSeconds)

	if (polynomialDegree !== 3 && polynomialDegree !== 4) throw new Error('polynomialDegree must be 3 or 4')
	if (!Number.isFinite(earthFlattening) || earthFlattening < 0 || earthFlattening >= 0.02) throw new Error('earthFlattening must be finite and in the plausible [0, 0.02) range')
	if (input.solarSemidiameter !== undefined) validatePositiveFinite('solarSemidiameter', input.solarSemidiameter)
	if (input.lunarSemidiameter !== undefined) validatePositiveFinite('lunarSemidiameter', input.lunarSemidiameter)

	return {
		maximumTT,
		intervalHours,
		stepMinutes,
		polynomialDegree,
		deltaTSeconds,
		earthEquatorialRadius,
		earthFlattening,
		solarSemidiameter: input.solarSemidiameter,
		lunarSemidiameter: input.lunarSemidiameter,
		siderealDeltaTSeconds: input.deltaTSeconds,
		computeApparentGeocentricSun: input.computeApparentGeocentricSun,
		computeApparentGeocentricMoon: input.computeApparentGeocentricMoon,
	}
}

function resolveMaximumTT(maximumApprox: Time): Time {
	validateTime(maximumApprox, 'maximumApprox')

	const time = tt(maximumApprox)
	const normalized = timeNormalize(time.day, time.fraction, 0, Timescale.TT)
	return { day: normalized.day, fraction: normalized.fraction, scale: Timescale.TT, polarMotion: maximumApprox.polarMotion, dut1: maximumApprox.dut1, tdbMinusTt: maximumApprox.tdbMinusTt, ut1MinusTai: maximumApprox.ut1MinusTai, location: maximumApprox.location }
}

function computeDeltaTSeconds(time: Time) {
	const UT1 = ut1(time)
	const TT = tt(time)
	return (TT.day - UT1.day + TT.fraction - UT1.fraction) * DAYSEC
}

function sampleTauHours(intervalHours: number, stepMinutes: number) {
	const halfIntervalHours = intervalHours / 2
	const stepHours = stepMinutes / 60
	const values: number[] = []

	for (let tau = -halfIntervalHours; tau <= halfIntervalHours + stepHours * 1e-12; tau += stepHours) {
		values.push(clampTinyTau(tau))
	}

	values.push(-halfIntervalHours, 0, halfIntervalHours)
	values.sort(NumberComparator)

	let write = 0

	for (let read = 0; read < values.length; read++) {
		if (write === 0 || Math.abs(values[read] - values[write - 1]) > 1e-12) {
			values[write++] = values[read]
		}
	}

	values.length = write

	return values
}

function clampTinyTau(tauHours: number) {
	return Math.abs(tauHours) < 1e-12 ? 0 : tauHours
}

function computeSample(time: Time, tauHours: number, context: ResolvedBesselianContext): BesselianSample {
	const sun = apparentSun(time, context.computeApparentGeocentricSun)
	const moon = apparentMoon(time, context.computeApparentGeocentricMoon)
	validateVector('Sun ephemeris vector', sun)
	validateVector('Moon ephemeris vector', moon)

	const axis = shadowAxis(sun, moon)
	const axisRightAscension = Math.atan2(axis[1], axis[0])
	const d = Math.asin(clamp(axis[2], -1, 1))
	const sinAlpha = Math.sin(axisRightAscension)
	const cosAlpha = Math.cos(axisRightAscension)
	const sinD = Math.sin(d)
	const cosD = Math.cos(d)

	const east: MutVec3 = [-sinAlpha, cosAlpha, 0]
	const north: MutVec3 = [-sinD * cosAlpha, -sinD * sinAlpha, cosD]
	const moonToPlane = -vecDot(moon, axis)
	const intersection: MutVec3 = [moon[0] + moonToPlane * axis[0], moon[1] + moonToPlane * axis[1], moon[2] + moonToPlane * axis[2]]
	const x = vecDot(intersection, east) / context.earthEquatorialRadius
	const y = vecDot(intersection, north) / context.earthEquatorialRadius
	const mu = normalizeAngle(greenwichApparentSiderealTimeAt(time, context.siderealDeltaTSeconds) - axisRightAscension)

	const sunDistance = vecLength(sun)
	const moonDistance = vecLength(moon)
	const sunMoonDistance = vecDistance(sun, moon)

	if (!(sunMoonDistance > MIN_VECTOR_LENGTH)) throw new Error('Sun and Moon ephemeris vectors must not be coincident')

	const solarRadius = Math.tan(context.solarSemidiameter ?? sunSemidiameter(sunDistance)) * sunDistance
	const lunarRadius = Math.tan(context.lunarSemidiameter ?? moonSemidiameter(moonDistance)) * moonDistance
	const tanF1 = (solarRadius + lunarRadius) / sunMoonDistance
	const tanF2 = (solarRadius - lunarRadius) / sunMoonDistance
	const l1 = (lunarRadius + moonToPlane * tanF1) / context.earthEquatorialRadius
	const l2 = (lunarRadius - moonToPlane * tanF2) / context.earthEquatorialRadius

	const sample: BesselianSample = { time, tauHours, x, y, d, mu, l1, l2, tanF1, tanF2 }
	validateSample(sample)
	return sample
}

function apparentSun(time: Time, computeApparentGeocentricSun?: (time: Time) => Vec3): Vec3 {
	if (computeApparentGeocentricSun) return computeApparentGeocentricSun(time)

	const [sun] = barycentricSun(time)
	const [earth] = barycentricEarth(time)
	const geocentric = vecMinus(sun, earth, sun)
	return matMulVec(precessionNutationMatrix(time), geocentric, geocentric)
}

function apparentMoon(time: Time, computeApparentGeocentricMoon?: (time: Time) => Vec3): Vec3 {
	if (computeApparentGeocentricMoon) return computeApparentGeocentricMoon(time)

	const [moon] = geocentricMoon(time)
	return matMulVec(precessionNutationMatrix(time), moon, moon)
}

function shadowAxis(sun: Vec3, moon: Vec3): MutVec3 {
	const axis = vecMinus(moon, sun)
	const length = vecLength(axis)

	if (!(length > MIN_VECTOR_LENGTH)) throw new Error('shadow axis cannot be built from coincident Sun and Moon vectors')

	axis[0] /= length
	axis[1] /= length
	axis[2] /= length
	return axis
}

function greenwichApparentSiderealTimeAt(time: Time, deltaTSeconds?: number) {
	if (deltaTSeconds === undefined) return greenwichApparentSiderealTime(time)

	const timeUT1 = timeNormalize(time.day, time.fraction - deltaTSeconds / DAYSEC, 0, Timescale.UT1)
	return eraGst06a(timeUT1.day, timeUT1.fraction, time.day, time.fraction)
}

function unwrapSamples(samples: BesselianSample[], key: BesselianQuantity) {
	if (samples.length === 0) return

	let previous = samples[0][key]

	for (let i = 1; i < samples.length; i++) {
		const value = samples[i][key]
		const unwrapped = previous + normalizePI(value - previous)
		samples[i][key] = unwrapped
		previous = unwrapped
	}
}

function fitPolynomial(samples: readonly BesselianSample[], key: BesselianQuantity, degree: number): BesselianPolynomial {
	const x = new Float64Array(samples.length)
	const y = new Float64Array(samples.length)

	for (let i = 0; i < samples.length; i++) {
		x[i] = samples[i].tauHours
		y[i] = samples[i][key]
	}

	const regression = polynomialRegression(x, y, degree)

	return { degree, coefficients: regression.coefficients }
}

function besselianL2Scale(elements: BesselianElements) {
	return elements.l2SignConvention === 'positiveTotal' ? 1 : -1
}

function normalizeBesselianL2(l2: number, convention: BesselianL2SignConvention) {
	return convention === 'positiveTotal' ? l2 : -l2
}

function classifyEclipse(samples: readonly BesselianSample[]): SolarEclipseType | 'UNKNOWN' {
	if (samples.length === 0) return 'UNKNOWN'

	let closest = samples[0]
	let closestDistance = Number.POSITIVE_INFINITY

	for (let i = 0; i < samples.length; i++) {
		const sample = samples[i]
		const distance = Math.hypot(sample.x, sample.y)

		if (distance < closestDistance) {
			closestDistance = distance
			closest = sample
		}
	}

	if (!closest) return 'UNKNOWN'

	const umbralRadius = Math.abs(closest.l2)

	if (closestDistance <= 1 + umbralRadius) {
		if (Math.abs(closest.l2) <= 0.003) return 'HYBRID'
		return normalizeBesselianL2(closest.l2, 'positiveTotal') > 0 ? 'TOTAL' : 'ANNULAR'
	}

	if (closestDistance <= 1 + Math.max(0, closest.l1)) return 'PARTIAL'
	return 'UNKNOWN'
}

function shiftTT(time: Time, tauHours: number) {
	return timeShift(time, tauHours / 24)
}

function validateTime(time: Time, name: string) {
	if (!Number.isFinite(time.day) || !Number.isFinite(time.fraction)) throw new Error(`${name} must have finite day and fraction`)
	if (time.scale < Timescale.UT1 || time.scale > Timescale.TCB) throw new Error(`${name} must have a valid timescale`)
}

function validatePositiveFinite(name: string, value: number) {
	if (!(value > 0) || !Number.isFinite(value)) throw new Error(`${name} must be a positive finite number`)
}

function validateFinite(name: string, value: number) {
	if (!Number.isFinite(value)) throw new Error(`${name} must be finite`)
}

function validateVector(name: string, vector: Vec3) {
	if (vector.length !== 3) throw new Error(`${name} must have exactly three components`)
	for (let i = 0; i < 3; i++) validateFinite(`${name}[${i}]`, vector[i])
	if (!(vecLength(vector) > MIN_VECTOR_LENGTH)) throw new Error(`${name} must be non-zero`)
}

function validateSample(sample: BesselianSample) {
	validateTime(sample.time, 'sample.time')
	validateFinite('sample.tauHours', sample.tauHours)

	for (const key of BESSELIAN_QUANTITIES) {
		validateFinite(`sample.${key}`, sample[key])
	}

	if (!(sample.tanF1 > 0)) throw new Error('sample.tanF1 must be positive')
	if (!(sample.tanF2 > 0)) throw new Error('sample.tanF2 must be positive')
	if (!(sample.l1 > 0)) throw new Error('sample.l1 must be positive')
	if (Math.abs(sample.d) > TAU / 4) throw new Error('sample.d must be a valid declination')
}
