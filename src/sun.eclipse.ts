import { type Angle, normalizeAngle, normalizePI } from './angle'
import type { PositionAndVelocityOverTime } from './astrometry'
import { AU_KM, DAYSEC, DAYSPERJY, DEG2RAD, EARTH_RADIUS_KM, J2000, LIGHT_TIME_AU, PI, PIOVERTWO, RAD2DEG, SPEED_OF_LIGHT_AU_DAY, TAU } from './constants'
import { deltaTByEspenakMeeus2006 } from './deltat'
import { eraAb, eraGst06a, eraP2s, eraS2p } from './erfa'
import { sphericalInterpolate, sphericalSeparation, type Point } from './geometry'
import { matMulVec } from './mat3'
import { clamp, type NumberArray } from './math'
import { bisection, brentMinimize, brentRoot, type RootFindingOptions } from './optimization'
import type { Projection, ProjectionPolylineOptions } from './projection'
import { polynomialRegression } from './regression'
import type { SolarEclipse } from './sun'
import { precessionNutationMatrix, timeShift, timeSubtract, toJulianDay, tt, type Time } from './time'
import type { Writable } from './types'
import { vecDivScalar, vecDot, vecLength, vecMinus, vecMulScalar, vecNormalizeMut } from './vec3'

// Solar eclipse map geometry engine, structured after Astrarium's SolarEclipses.cs
// (https://github.com/Astrarium/Astrarium). The module is layered as:
//   A. Besselian elements (polynomial fit, instant elements, evaluation).
//   B. Projection and Earth geometry (fundamental plane -> geographic).
//   C. Contacts and central endpoints (P1..P4, U1..U4, C1/C2, Max).
//   D. Curve solver (findEclipseCurvePoint / findCurvePoints and splitters).
//   E. Rise/set curves (Earth limb x penumbral circle intersections).
//   F. Public assembly and optional SVG serialization.
// Every physical curve family comes only from the curve solver (D); the umbra and penumbra limits are
// never capped, bridged, or welded. Visual fill geometry is isolated in computeSolarEclipseFillGeometry.
//
// Unit conventions (audited):
//   - angles (right ascension, declination, d, mu, longitude, latitude) in radians;
//   - x, y, l1, l2 and their derivatives in Earth equatorial radii (derivatives per normalized step);
//   - Delta T in seconds; times as Time or Julian Day; distances in Earth equatorial radii;
//   - longitude is east-positive in [-PI, PI] (Astrarium uses the west-positive mirror).

// All Earth-ellipsoid constants derive from a single flattening definition (WGS84) so the limb,
// projection and contact geometry stay mutually consistent.
const EARTH_FLATTENING = 1 / 298.257223563
// Earth polar/equatorial radius ratio (1 - flattening).
const F_CONST = 1 - EARTH_FLATTENING
// Reciprocal of F_CONST, used by the geographic-latitude conversion.
const INV_F_CONST = 1 / F_CONST
// Squared eccentricity of the Earth ellipsoid used for limb flattening, e^2 = 1 - (b/a)^2.
const EARTH_E2 = 1 - F_CONST * F_CONST
// Astrarium's 0.00417807 deg of longitude per second of Delta T, converted to radians. Callers building
// PolynomialBesselianElements from a dynamical-time (TDT) tabulation set deltaTLongitudeCorrection to
// DELTA_T_LONGITUDE_FACTOR * deltaT; elements with UT-based mu (this module's own) use 0.
export const DELTA_T_LONGITUDE_FACTOR = 0.00417807 * DEG2RAD
const DEFAULT_LONGITUDE_STEP = 1 * DEG2RAD
const DEFAULT_MAX_ANGULAR_STEP = 1 * DEG2RAD
const DEFAULT_RISE_SET_STEP_SECONDS = 30
// Half-width of the contact/endpoint root search window, in seconds. Capped at 3 h to stay inside the
// 6 h (t0 +- 3 h) polynomial fit window, so contact and central-axis searches never extrapolate the
// cubic beyond its fitted span (see report section 1.1).
const DEFAULT_CONTACT_SEARCH_SPAN_SECONDS = 3 * 3600
// Root tolerance for contact and central-endpoint instants, in days (~1 ms; stricter than
// Astrarium's 0.0001 day, affordable because the iterations converge quadratically).
const CONTACT_TOLERANCE_DAYS = 1e-8
const SOLVER_MAX_ITERATIONS = 50
// Curve solver latitude convergence threshold: |deltaPhi| < 1e-4 deg expressed in radians (Astrarium
// converges on the same 1e-4 deg threshold).
const SOLVER_TOLERANCE = 1e-4
// Curve solver time convergence threshold, expressed directly in days (~0.1 s) instead of normalized
// step units, so it is independent of the polynomial step (see report section 2.4).
const SOLVER_TIME_TOLERANCE_DAYS = 0.1 / DAYSEC
// Numerical tolerance for tangential circle/ellipse intersections: a squared half-chord slightly below
// zero is treated as a grazing (single) contact rather than no contact.
const GEOMETRY_TANGENCY_EPSILON = 1e-14
const SUN_RADIUS_EARTH_RADII = 109.076370706
// Lunar radius k1 used for penumbral contacts and the penumbral cone, per NASA/Espenak convention.
const MOON_RADIUS_PENUMBRA_EARTH_RADII = 0.272488
// Lunar radius k2 used for umbral contacts and the umbral cone, per NASA/Espenak convention.
const MOON_RADIUS_UMBRA_EARTH_RADII = 0.272281
// Bisection steps used to refine the longitude where a curve family appears or disappears
// (the equivalent of Astrarium's FindFunctionEnd).
const BOUNDARY_REFINEMENT_STEPS = 18
// A solved curve is split into separate polylines wherever two consecutive points (in time order) are
// farther apart than this multiple of maxAngularStep: densification keeps continuous stretches within
// maxAngularStep, so a wider gap is a genuine discontinuity (the curve left the sunlit hemisphere)
// that must not be bridged by a straight chord.
const CURVE_GAP_SPLIT_FACTOR = 4
// Minimum Julian Day separation between distinct points on a time-parametrized curve; points closer
// than this in time (~0.1 s, far below the minutes-apart sampling of any curve) are the same instant
// reached from different seeds and are collapsed to one.
const CURVE_TIME_EPSILON_DAYS = 1e-6
// Symmetric latitude seeds (radians) for the meridian scan, covering both hemispheres so polar,
// non-central and hybrid families are not missed by a single shadow-side seed (report section 2.3).
// The poleward seeds stay short of +-90 deg to keep tan(phi) finite.
const CURVE_SEED_LATITUDES = [0, 30, -30, 60, -60, 80, -80, 89.5, -89.5].map((degrees) => degrees * DEG2RAD)
// Two curve points reached from different seeds at the same instant are the same location; they are
// collapsed only when also within this angular distance (~0.6 km), so a genuine time fold that places
// two distinct locations at nearly the same instant keeps both (report section 2.2).
const CURVE_SPATIAL_EPSILON = 1e-4

// Polynomial Besselian elements fitted around the eclipse maximum.
export interface PolynomialBesselianElements {
	// Time of the polynomial origin.
	readonly time0: Time
	// Time of maximum eclipse.
	readonly maximumTime: Time
	// Delta T in seconds.
	readonly deltaT: number
	// Delta T longitude correction in radians applied during geographic projection. Mandatory so the
	// hour-angle convention is never ambiguous: pass 0 when mu was already computed from UT1/UT (as the
	// elements generated by this module are), or DELTA_T_LONGITUDE_FACTOR * deltaT for elements imported
	// from an ephemeris/TDT tabulation whose mu is in dynamical time (see report section 1.2).
	readonly deltaTLongitudeCorrection: Angle
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
	// Delta T longitude correction in radians (see PolynomialBesselianElements.deltaTLongitudeCorrection).
	readonly deltaTLongitudeCorrection: Angle
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

// Local eclipse character along the central line, used to mark the total/annular transition of a
// hybrid eclipse (report section 3.3).
export type EclipseKind = 'total' | 'annular'

// Geographic point returned by the eclipse geometry engine.
export interface GeoPoint {
	// Longitude in radians, east-positive, normalized to [-PI, PI].
	readonly x: Angle
	// Latitude in radians, normalized to [-PI/2, PI/2].
	readonly y: Angle
	// Optional Julian Day associated with this point.
	readonly jd?: number
	// Optional local eclipse character at this point; set on central-line points so a hybrid eclipse's
	// total and annular stretches can be distinguished where the local umbral cone radius changes sign.
	readonly kind?: EclipseKind
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
	// First external umbral/antumbral cone tangency with the limb. Informational only: it never
	// controls the umbra-limit polylines.
	readonly U1?: GeoPoint
	// First internal umbral/antumbral cone tangency with the limb (umbra wholly on Earth). Informational only.
	readonly U2?: GeoPoint
	// Last internal umbral/antumbral cone tangency with the limb. Informational only.
	readonly U3?: GeoPoint
	// Last external umbral/antumbral cone tangency with the limb. Informational only.
	readonly U4?: GeoPoint
	// First central-line contact with Earth (the shadow axis grazes the limb where the central line begins).
	readonly C1?: GeoPoint
	// Last central-line contact with Earth (the shadow axis grazes the limb where the central line ends).
	readonly C2?: GeoPoint
	// Greatest eclipse point.
	readonly Max?: GeoPoint
	// Northern penumbral-limit extreme. Informational only: it never controls the penumbra-limit
	// polylines. When both penumbral limits reach Earth, N1/N2 are the northern limit's two endpoints
	// ordered chronologically; for a grazing partial N1 is the single curve's poleward extreme.
	readonly N1?: GeoPoint
	// Second endpoint of the northern penumbral limit. Absent for a grazing partial. Informational only.
	readonly N2?: GeoPoint
	// Southern penumbral-limit extreme; S1/S2 mirror N1/N2 for the southern limit. Informational only.
	readonly S1?: GeoPoint
	// Second endpoint of the southern penumbral limit. Absent for a grazing partial. Informational only.
	readonly S2?: GeoPoint
}

// Projection-agnostic solar eclipse map geometry: the physically meaningful points and polylines only.
export interface SolarEclipseMapGeometry {
	// Named contact points and greatest-eclipse point.
	readonly points: SolarEclipseContactPoints
	// Drawable geographic polylines, still unprojected.
	readonly lines: {
		// Central line of totality or annularity. Empty for partial and non-central eclipses.
		readonly centerLine: readonly GeoPoint[]
		// Northern totality or annularity limit (G = 1), split at discontinuities and at its latitude
		// apex. Empty for partial and non-central eclipses.
		readonly umbraNorth: readonly GeoPoint[][]
		// Southern totality or annularity limit (G = 1), split like umbraNorth.
		readonly umbraSouth: readonly GeoPoint[][]
		// Northern partial eclipse limit (G = 0).
		readonly penumbraNorth: readonly GeoPoint[]
		// Southern partial eclipse limit (G = 0).
		readonly penumbraSouth: readonly GeoPoint[]
		// Sunrise and sunset eclipse curves.
		readonly riseSetCurves: readonly GeoPoint[][]
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
}

// Options for generating one family of eclipse curve points.
export interface SolarEclipseCurveOptions {
	// Longitude scan step in radians.
	readonly longitudeStep?: Angle
	// Maximum angular spacing between neighboring curve points in radians.
	readonly maxAngularStep?: Angle
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
	readonly N1?: Point
	readonly N2?: Point
	readonly S1?: Point
	readonly S2?: Point
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

// A. BESSELIAN ELEMENTS

// Besselian element positions at one time, without the velocity derivatives that only the curve
// solver needs. Projection, contact and rise/set paths read only these fields.
interface BesselianSample {
	readonly time: Time
	readonly deltaT: number
	readonly deltaTLongitudeCorrection: Angle
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
	// Derivative of the declination d with respect to normalized polynomial time.
	dd: number
	// Derivative of l1 with respect to normalized polynomial time.
	dl1: number
	// Derivative of l2 with respect to normalized polynomial time.
	dl2: number
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
		dd: evaluatePolynomialDerivative(pbe.d, t),
		dl1: evaluatePolynomialDerivative(pbe.l1, t),
		dl2: evaluatePolynomialDerivative(pbe.l2, t),
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

function besselianSampleAtJulianDay(pbe: PolynomialBesselianElements, jd: number) {
	return evaluateBesselianSample(pbe, timeAtJulianDay(pbe.time0, jd))
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
	// Classical solar Besselian fit: five samples uniformly spread over a 6 h window centered on t0
	// (t0 +- 3 h), with the polynomial time unit fixed at one hour so the coefficients match the
	// NASA/Espenak hourly tabulation (see report section 1.1).
	const stepDays = 1 / 24
	const offsets = [-3, -1.5, 0, 1.5, 3] as const
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

// Computes instantaneous Besselian elements from one Sun and Moon position sample, following the
// Astrarium cone geometry: the shadow axis is the Sun-Moon direction, the cone half-angles come from
// sinF1 = (rSun + rMoon) / |Sun - Moon| and sinF2 = (rSun - rMoon) / |Sun - Moon|, the cone vertices
// sit at zv1 = zm + rMoon / sinF1 and zv2 = zm - rMoon / sinF2 along the axis, and the fundamental
// plane radii are l1 = zv1 * tanF1 and l2 = zv2 * tanF2. The NASA k1/k2 lunar radii are kept for the
// penumbral/umbral cones respectively (an intentional refinement over Astrarium's single radius).
export function instantBesselianFromSunMoon(time: Time, sample: SunMoonPosition): InstantBesselianElements {
	const projection = besselianShadowProjection(sample)
	const deltaT = sample.deltaT ?? 0
	const sunMoonDistance = projection.sunMoonDistance
	let tanF1 = 0
	let tanF2 = 0
	let l1 = 0
	let l2 = 0

	if (sunMoonDistance > 0) {
		const sinF1 = (SUN_RADIUS_EARTH_RADII + MOON_RADIUS_PENUMBRA_EARTH_RADII) / sunMoonDistance
		const sinF2 = (SUN_RADIUS_EARTH_RADII - MOON_RADIUS_UMBRA_EARTH_RADII) / sunMoonDistance
		tanF1 = Math.tan(Math.asin(clamp(sinF1, -1, 1)))
		tanF2 = Math.tan(Math.asin(clamp(sinF2, -1, 1)))
		const zv1 = projection.zm + MOON_RADIUS_PENUMBRA_EARTH_RADII / sinF1
		const zv2 = projection.zm - MOON_RADIUS_UMBRA_EARTH_RADII / sinF2
		l1 = zv1 * tanF1
		l2 = zv2 * tanF2
	}

	// The shadow-axis right ascension is apparent (true equator and equinox of date), so the matching
	// sidereal angle is the Greenwich apparent sidereal time, not bare GMST. UT1 is recovered from TT via
	// the Besselian Delta T (Delta T = TT - UT1); both feed eraGst06a, keeping mu = GAST - alpha_apparent
	// consistent with the precession/nutation rotation applied to the positions (see report section 1.3).
	const ttTime = tt(time)
	const ut1Fraction = ttTime.fraction - deltaT / DAYSEC
	const gast = eraGst06a(ttTime.day, ut1Fraction, ttTime.day, ttTime.fraction)
	const mu = normalizeAngle(gast - projection.rightAscension)

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
		tanF1,
		tanF2,
	}
}

// Projects the Moon onto the fundamental plane of the Sun-Moon shadow axis, returning the axis
// right ascension/declination, the Moon's (x, y) in the plane and its zm coordinate along the axis.
function besselianShadowProjection(sample: SunMoonPosition) {
	if (!(sample.sunDistance > 0) || !(sample.moonDistance > 0)) {
		return { x: 0, y: 0, zm: 0, rightAscension: sample.sunRightAscension, declination: sample.sunDeclination, sunMoonDistance: 0 }
	}

	const sun = eraS2p(sample.sunRightAscension, sample.sunDeclination, sample.sunDistance)
	const moon = eraS2p(sample.moonRightAscension, sample.moonDeclination, sample.moonDistance)
	const sunMinusMoon = vecMinus(sun, moon)
	const sunMoonDistance = vecLength(sunMinusMoon)

	if (!(sunMoonDistance > 0) || !Number.isFinite(sunMoonDistance)) {
		return { x: 0, y: 0, zm: 0, rightAscension: sample.sunRightAscension, declination: sample.sunDeclination, sunMoonDistance: 0 }
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
	const zm = vecDot(moon, axis)
	const foot = [moon[0] - zm * axis[0], moon[1] - zm * axis[1], moon[2] - zm * axis[2]] as const

	return {
		x: vecDot(foot, east),
		y: vecDot(foot, north),
		zm,
		rightAscension,
		declination,
		sunMoonDistance,
	}
}

// B. PROJECTION AND EARTH GEOMETRY

// Computes the flattening scale for the Earth-limb ellipse in the fundamental plane:
// the limb is x^2 + (omega*y)^2 = 1 with omega = 1 / sqrt(1 - e^2 cos^2 d).
export function earthLimbOmega(d: Angle) {
	const cosD = Math.cos(d)
	return 1 / Math.sqrt(1 - EARTH_E2 * cosD * cosD)
}

// Derivative d(omega)/d(d) of the limb flattening scale, used to carry the d-dependence of the limb
// into the central-line endpoint solver (report section 2.1): omega = s^(-1/2), s = 1 - e^2 cos^2 d,
// so d(omega)/dd = -e^2 cos d sin d * s^(-3/2).
export function derivativeEarthLimbOmega(d: Angle) {
	const cosD = Math.cos(d)
	const sinD = Math.sin(d)
	const s = 1 - EARTH_E2 * cosD * cosD
	return (-EARTH_E2 * cosD * sinD) / (s * Math.sqrt(s))
}

// Number of uniform theta samples used to bracket extrema and crossings on the Earth-limb ellipse. The
// limb is smooth and nearly circular (flattening ~1/298), so a 2 deg scan reliably brackets every
// extremum/intersection basin before local refinement (ternary search for extrema, bisection for
// crossings), which then converges to full precision independently of this resolution.
const LIMB_SCAN_STEPS = 180

// Returns the point on the Earth-limb ellipse x^2 + (omega y)^2 = 1 at parameter theta.
export function earthLimbPoint(theta: number, omega: number): [number, number] {
	return [Math.cos(theta), Math.sin(theta) / omega]
}

function earthLimbDistanceSquared(theta: number, cx: number, cy: number, omega: number) {
	const dx = Math.cos(theta) - cx
	const dy = Math.sin(theta) / omega - cy
	return dx * dx + dy * dy
}

// Refines a limb extremum (minimum or maximum of the squared distance to (cx, cy)) by ternary search in
// a one-step bracket around a scan guess, where the squared-distance function is unimodal.
function refineLimbExtreme(thetaGuess: number, halfWidth: number, cx: number, cy: number, omega: number, minimize: boolean) {
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

// Nearest and farthest points of the Earth-limb ellipse to a fundamental-plane point, with the signed
// inside/outside flag (report section 1.4). This replaces the unit-circle distance used previously for
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

export function earthLimbExtremes(cx: number, cy: number, omega: number): EarthLimbExtremes {
	const step = TAU / LIMB_SCAN_STEPS
	let minTheta = 0
	let maxTheta = 0
	let minD2 = Infinity
	let maxD2 = -Infinity

	for (let k = 0; k < LIMB_SCAN_STEPS; k++) {
		const theta = k * step
		const d2 = earthLimbDistanceSquared(theta, cx, cy, omega)
		if (d2 < minD2) {
			minD2 = d2
			minTheta = theta
		}
		if (d2 > maxD2) {
			maxD2 = d2
			maxTheta = theta
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
function earthLimbSignedDistance(cx: number, cy: number, omega: number) {
	const extremes = earthLimbExtremes(cx, cy, omega)
	return extremes.inside ? -extremes.minDistance : extremes.minDistance
}

// Intersections of a circle of the given radius centered at (cx, cy) with the Earth-limb ellipse,
// returned as limb points (cos theta, sin theta / omega) ordered by descending y. Solves
// earthLimbDistanceSquared(theta) - radius^2 = 0 by uniform scan plus bisection on each sign change,
// the ellipse counterpart of findCircleIntersections for rise/set (report section 1.4).
export function earthLimbCircleIntersections(cx: number, cy: number, omega: number, radius: number): [number, number][] {
	if (!Number.isFinite(radius) || radius < 0 || !Number.isFinite(cx) || !Number.isFinite(cy)) return []

	const r2 = radius * radius
	const g = (theta: number) => earthLimbDistanceSquared(theta, cx, cy, omega) - r2
	const step = TAU / LIMB_SCAN_STEPS
	const thetas: number[] = []
	let previousTheta = 0
	let previousValue = g(0)

	for (let k = 1; k <= LIMB_SCAN_STEPS; k++) {
		const theta = k * step
		const value = g(theta)

		if (Math.abs(previousValue) <= GEOMETRY_TANGENCY_EPSILON) thetas.push(previousTheta)
		else if (previousValue * value < 0) {
			const root = bisectRoot(g, previousTheta, theta)
			if (root !== undefined) thetas.push(root)
		}

		previousTheta = theta
		previousValue = value
	}

	const points = thetas.map((theta): [number, number] => earthLimbPoint(theta, omega))
	points.sort((a, b) => b[1] - a[1])
	return points
}

// Reads the mandatory hour-angle longitude correction. The convention is fixed at construction time
// (0 for UT-based mu, DELTA_T_LONGITUDE_FACTOR * deltaT for dynamical-time mu), so this is a plain read.
function deltaTLongitudeCorrection(elements: { readonly deltaTLongitudeCorrection: Angle }) {
	return elements.deltaTLongitudeCorrection
}

// Single source of truth for the hour-angle -> longitude conversion. The project uses east-positive
// longitude, so lambda = H - mu + correction, where the correction is 0.00417807 deg per second of
// Delta T in radians (Astrarium's west-positive form is lambda = mu - H - correction). The sign is
// pinned by tests against NASA eclipse path tables and the subsolar point.
export function longitudeFromHourAngle(hourAngle: Angle, mu: Angle, correction: Angle): Angle {
	return normalizePI(hourAngle - mu + correction)
}

// Inverse of longitudeFromHourAngle: local hour angle of the shadow axis at an east-positive longitude.
export function hourAngleFromLongitude(longitude: Angle, mu: Angle, correction: Angle): Angle {
	return longitude + mu - correction
}

// Projects one fundamental-plane point on or inside the Earth limb to geographic longitude and latitude.
// This is the single source of truth for the fundamental plane -> geographic conversion: every contact,
// curve and rise/set point goes through it. A point outside the limb returns undefined (only a
// numerically grazing point, within GEOMETRY_TANGENCY_EPSILON, is snapped to the limb): callers that
// need a representative on-Earth point for an outside input must request it explicitly via
// projectClosestEarthLimbPoint, instead of relying on a hidden clamp (report section 1.5).
export function projectFundamentalPoint(be: BesselianSample, x: number, y: number): GeoPoint | undefined {
	if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined

	const sinD = Math.sin(be.d)
	const cosD = Math.cos(be.d)
	const omega = earthLimbOmega(be.d)
	const px = x
	const y1 = omega * y
	const b1 = omega * sinD
	const b2 = F_CONST * omega * cosD
	let bSquared = 1 - px * px - y1 * y1

	if (bSquared < 0) {
		if (bSquared < -GEOMETRY_TANGENCY_EPSILON) return undefined
		bSquared = 0
	}

	const B = Math.sqrt(bSquared)
	const H = Math.atan2(px, B * b2 - y1 * b1)
	const phi1 = Math.asin(clamp(B * b1 + y1 * b2, -1, 1))
	const lat = Math.atan(INV_F_CONST * Math.tan(phi1))
	const lon = longitudeFromHourAngle(H, be.mu, deltaTLongitudeCorrection(be))

	if (!Number.isFinite(lon) || !Number.isFinite(lat)) return undefined

	return { x: lon, y: lat, jd: toJulianDay(be.time) }
}

// Projects the point of the Earth-limb ellipse closest to a fundamental-plane point. Used when the
// requested point lies outside the Earth (e.g. the shadow axis of a partial or non-central eclipse) and
// a representative on-limb location is still wanted, making the former implicit clamp explicit.
export function projectClosestEarthLimbPoint(be: BesselianSample, x: number, y: number): GeoPoint | undefined {
	if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined

	const omega = earthLimbOmega(be.d)
	const [limbX, limbY] = earthLimbPoint(earthLimbExtremes(x, y, omega).nearestTheta, omega)
	return projectFundamentalPoint(be, limbX, limbY)
}

// C. CONTACTS AND CENTRAL ENDPOINTS

const BISECT_ROOT_OPTIONS: RootFindingOptions = { tolerance: CONTACT_TOLERANCE_DAYS }

function bisectRoot(f: (x: number) => number, min: number, max: number) {
	try {
		return bisection(f, min, max, BISECT_ROOT_OPTIONS).root
	} catch {
		return undefined
	}
}

// Refines a bracketed root, preferring Brent (superlinear) and falling back to bisection if Brent
// rejects the bracket.
function refineRoot(f: (x: number) => number, min: number, max: number) {
	try {
		return brentRoot(f, min, max, BISECT_ROOT_OPTIONS).root
	} catch {
		return bisectRoot(f, min, max)
	}
}

// Number of uniform sub-intervals used to scan the contact search window for sign changes before
// refinement. A grazing or nearly-tangent contact is easily missed by a single bisection over the whole
// window, so every root is bracketed by scanning first (report section 6.3).
const CONTACT_SCAN_STEPS = 96

// Finds every root of f in [from, to] by scanning for sign changes and refining each bracket. Exact
// zeros landing on a sample are captured once.
function findRootsInInterval(f: (x: number) => number, from: number, to: number, steps: number) {
	const roots: number[] = []
	const h = (to - from) / steps
	let previousX = from
	let previousValue = f(from)

	for (let k = 1; k <= steps; k++) {
		const x = k === steps ? to : from + k * h
		const value = f(x)

		if (previousValue === 0) roots.push(previousX)
		else if (previousValue * value < 0) {
			const root = refineRoot(f, previousX, x)
			if (root !== undefined) roots.push(root)
		}

		previousX = x
		previousValue = value
	}

	if (previousValue === 0) roots.push(to)
	return roots
}

// Projects a shadow contact instant: the contact happens where the shadow circle is tangent to the
// Earth-limb ellipse, i.e. at the limb point nearest the shadow axis (cx, cy). Earth flattening enters
// both the contact-root equation (via the ellipse signed distance) and the geographic projection.
function projectContactRoot(pbe: PolynomialBesselianElements, jd: number | undefined) {
	if (jd === undefined) return undefined

	const be = besselianSampleAtJulianDay(pbe, jd)
	return projectClosestEarthLimbPoint(be, be.x, be.y)
}

// Finds the four contact instants of a shadow circle of the given radius with the Earth-limb ellipse:
// the external roots of signedDistance(x, y) - r = 0 (first/last touch, axis outside the limb) and the
// internal roots of signedDistance(x, y) + r = 0 (shadow wholly on Earth, axis inside), scanned across
// the whole search window so grazing contacts are not missed. signedDistance is the ellipse counterpart
// of the unit-circle hypot - 1 used previously (report sections 1.4 and 6.3).
function findShadowContactPoints(pbe: PolynomialBesselianElements, radius: (be: BesselianSample) => number, options?: SolarEclipseContactOptions) {
	const maximumJulianDay = toJulianDay(pbe.maximumTime)
	const searchSpanDays = contactSearchSpanDays(options)
	const from = maximumJulianDay - searchSpanDays
	const to = maximumJulianDay + searchSpanDays

	function external(jd: number) {
		const be = besselianSampleAtJulianDay(pbe, jd)
		return earthLimbSignedDistance(be.x, be.y, earthLimbOmega(be.d)) - radius(be)
	}

	function internal(jd: number) {
		const be = besselianSampleAtJulianDay(pbe, jd)
		return earthLimbSignedDistance(be.x, be.y, earthLimbOmega(be.d)) + radius(be)
	}

	const externalRoots = findRootsInInterval(external, from, to, CONTACT_SCAN_STEPS)
	const internalRoots = findRootsInInterval(internal, from, to, CONTACT_SCAN_STEPS)

	return {
		first: projectContactRoot(pbe, externalRoots[0]),
		firstInternal: projectContactRoot(pbe, internalRoots[0]),
		lastInternal: projectContactRoot(pbe, internalRoots.at(-1)),
		last: projectContactRoot(pbe, externalRoots.at(-1)),
	}
}

// Finds the P1/P2/P3/P4 penumbral contact points: the roots of sqrt(x^2 + y^2) - 1 -+ l1 = 0,
// external (P1/P4) and internal (P2/P3), before and after the eclipse maximum.
export function findPenumbraContactPoints(pbe: PolynomialBesselianElements, options?: SolarEclipseContactOptions): Pick<SolarEclipseContactPoints, 'P1' | 'P2' | 'P3' | 'P4'> {
	const contacts = findShadowContactPoints(pbe, (be) => be.l1, options)
	return { P1: contacts.first, P2: contacts.firstInternal, P3: contacts.lastInternal, P4: contacts.last }
}

// Finds the U1/U2/U3/U4 umbral/antumbral cone tangency contacts with the limb: the roots of
// sqrt(x^2 + y^2) - 1 -+ |l2| = 0 (l2 is negative for a total eclipse, positive for an annular one).
// They are informational markers only and never control the umbra-limit polylines.
export function findUmbraContactPoints(pbe: PolynomialBesselianElements, options?: SolarEclipseContactOptions): Pick<SolarEclipseContactPoints, 'U1' | 'U2' | 'U3' | 'U4'> {
	const contacts = findShadowContactPoints(pbe, (be) => Math.abs(be.l2), options)
	return { U1: contacts.first, U2: contacts.firstInternal, U3: contacts.lastInternal, U4: contacts.last }
}

// Squared distance from the shadow axis to the Earth-limb ellipse center at normalized time t, i.e.
// x(t)^2 + (omega(d(t)) y(t))^2. It is <= 1 exactly when the axis pierces the ellipsoid at t.
function centralAxisDistanceSquaredAtT(pbe: PolynomialBesselianElements, t: number) {
	const be = evaluateBesselianAtT(pbe, t)
	const y1 = earthLimbOmega(be.d) * be.y
	return be.x * be.x + y1 * y1
}

// Tests whether the shadow axis intersects the Earth ellipsoid anywhere in the fitted window, replacing
// the gamma-threshold heuristic with the actual geometry: minimize x^2 + (omega y)^2 over the fit span
// and report central when the minimum drops to or below 1 (report section 3.1).
export function centralAxisIntersectsEarth(pbe: PolynomialBesselianElements): boolean {
	const f = (t: number) => centralAxisDistanceSquaredAtT(pbe, t)
	const span = contactSearchSpanDays() / pbe.stepDays
	const steps = 64
	let bestT = 0
	let best = Infinity

	for (let k = 0; k <= steps; k++) {
		const t = -span + (2 * span * k) / steps
		const value = f(t)
		if (value < best) {
			best = value
			bestT = t
		}
	}

	if (best <= 1) return true

	const half = (2 * span) / steps
	try {
		const minimum = brentMinimize(f, bestT - half, bestT + half)
		if (minimum.value < best) best = minimum.value
	} catch {
		// Keep the coarse-scan minimum if the refinement bracket is rejected.
	}

	return best <= 1
}

// Finds the greatest eclipse point. For a central eclipse the shadow axis pierces the ellipsoid, so the
// greatest-eclipse location is the strict projection of the axis at maximum time. For a partial or
// non-central eclipse the axis misses the Earth, so the greatest eclipse is on the limb nearest the axis
// (report section 3.2) rather than an implicit clamp inside the projector.
export function findMaximumPoint(pbe: PolynomialBesselianElements): GeoPoint | undefined {
	const be = evaluateBesselianSample(pbe, pbe.maximumTime)
	const strict = projectFundamentalPoint(be, be.x, be.y)
	return strict ?? projectClosestEarthLimbPoint(be, be.x, be.y)
}

// Finds one extreme endpoint of the central line (C1 when begin is true, C2 otherwise): the instant
// the shadow axis grazes the flattened Earth limb x^2 + (omega*y)^2 = 1. Primary method is the
// Astrarium iteration on the axis position (u, v) and velocity (a, b):
//   S = (a*v - u*b) / n, t1 = -(u*a + v*b) / n^2, t2 = sqrt(1 - S^2) / n, tau = t1 -+ t2,
// converging when |tau| is below CONTACT_TOLERANCE_DAYS. A sign-bisection on the limb residual is
// kept as fallback for when the iteration leaves the fitted span or S^2 exceeds 1 near tangency.
export function findCentralLineExtremePoint(pbe: PolynomialBesselianElements, begin: boolean, options?: SolarEclipseContactOptions): GeoPoint | undefined {
	const julianDay0 = toJulianDay(pbe.time0)
	const maximumJulianDay = toJulianDay(pbe.maximumTime)
	const searchSpanDays = contactSearchSpanDays(options)
	let t = (maximumJulianDay - julianDay0) / pbe.stepDays

	for (let iteration = 0; iteration < SOLVER_MAX_ITERATIONS; iteration++) {
		const be = evaluateBesselianAtT(pbe, t)
		const omega = earthLimbOmega(be.d)
		const u = be.x
		const v = omega * be.y
		const a = be.dx
		// Velocity of v = omega(d) * y carries the d-dependence of the limb flattening: the omega term
		// is no longer constant because d varies with time (report section 2.1).
		const b = omega * be.dy + be.y * derivativeEarthLimbOmega(be.d) * be.dd
		const nSquared = a * a + b * b

		if (!(nSquared > 0) || !Number.isFinite(nSquared)) break

		const n = Math.sqrt(nSquared)
		const S = (a * v - u * b) / n

		// The axis never crosses the limb (non-central eclipse) or the iteration degenerated.
		if (!(S * S <= 1)) break

		const t1 = -(u * a + v * b) / nSquared
		const t2 = Math.sqrt(1 - S * S) / n
		const tau = begin ? t1 - t2 : t1 + t2
		t += tau

		if (!Number.isFinite(t)) break
		if (Math.abs(tau) * pbe.stepDays <= CONTACT_TOLERANCE_DAYS) return projectCentralAxisPoint(pbe, julianDay0 + t * pbe.stepDays)
	}

	// Fallback: bisection of the limb residual between the maximum and the search window edge.
	function residual(jd: number) {
		const be = besselianSampleAtJulianDay(pbe, jd)
		const y1 = earthLimbOmega(be.d) * be.y
		return be.x * be.x + y1 * y1 - 1
	}

	const from = begin ? maximumJulianDay - searchSpanDays : maximumJulianDay
	const to = begin ? maximumJulianDay : maximumJulianDay + searchSpanDays
	const jd = bisectRoot(residual, from, to)

	return jd === undefined ? undefined : projectCentralAxisPoint(pbe, jd)
}

function projectCentralAxisPoint(pbe: PolynomialBesselianElements, jd: number) {
	const be = besselianSampleAtJulianDay(pbe, jd)
	// At the C1/C2 endpoints the axis is tangent to the limb and converges a hair (~1e-7) outside it, so
	// the strict projector rejects it; fall back to the nearest limb point, which is that same tangency.
	return projectFundamentalPoint(be, be.x, be.y) ?? projectClosestEarthLimbPoint(be, be.x, be.y)
}

// D. CURVE SOLVER

// Solves one eclipse curve point at fixed longitude, following Astrarium's FindEclipseCurvePoint:
// a coupled Newton iteration on the normalized time t and the latitude phi that drives the observer
// onto the requested magnitude curve at the instant of closest approach.
//   longitude: east-positive longitude of the meridian to solve on, in radians.
//   initialLatitude: latitude seed in radians.
//   i = 0 -> central line (G ignored); i = +1/-1 -> northern/southern limit.
//   G = 1 -> totality/annularity limit; G = 0 -> partiality limit; 0 < G < 1 -> equal-magnitude curve.
// Atmospheric refraction (an empirical observer-lifting factor) applies to every family near the
// horizon (solar altitude between 0 and 10 deg), including the G = 0 partial limit, so its extremes
// match the refracted EclipseWise/Espenak references (a documented divergence from bare Astrarium,
// which skips it on G = 0). A negative solar altitude is rejected only after convergence, so
// intermediate night-side iterates can still converge to a day-side solution.
export function findEclipseCurvePoint(pbe: PolynomialBesselianElements, longitude: Angle, initialLatitude: Angle, i: -1 | 0 | 1, G: number): GeoPoint | undefined {
	let t = 0
	let phi = initialLatitude
	const julianDay0 = toJulianDay(pbe.time0)
	const longitudeCorrection = deltaTLongitudeCorrection(pbe)

	for (let iteration = 0; iteration < SOLVER_MAX_ITERATIONS; iteration++) {
		const be = evaluateBesselianAtT(pbe, t)
		const H = hourAngleFromLongitude(longitude, be.mu, longitudeCorrection)
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
		const hD = h * RAD2DEG

		// Empirical horizon-refraction correction that lifts the observer near the horizon. It is
		// applied to every limit family, including the partial limit (G = 0): the published
		// EclipseWise/Espenak penumbral-limit extremes N1/S1 are refracted positions, so omitting it on
		// the G = 0 curves (as bare Astrarium does) drifts those extremes by a degree or more. This is a
		// documented divergence from Astrarium, kept because the reference extremes assume refraction.
		if (hD >= 0 && hD <= 10) {
			const sigma = 1.000012 + 0.0002282559 * Math.exp(-0.5035747 * hD)
			ksi *= sigma
			eta *= sigma
			zeta *= sigma
		}

		// Diurnal rate of the observer's coordinates in the fundamental plane, in radians per normalized
		// time unit. ksi has no declination dependence, so only the hour-angle rate dmu/dt enters; eta
		// additionally carries the declination rate dd via -dd * zeta, completing the derivative that the
		// previous code dropped (report section 2.1).
		const ksiPrime = rhoCosPhi * cosH * be.dmu
		const etaPrime = rhoCosPhi * sinH * sinD * be.dmu - zeta * be.dd
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
		// Time convergence is tested in days (independent of the polynomial step), latitude in radians.
		if (Math.abs(tau) * pbe.stepDays < SOLVER_TIME_TOLERANCE_DAYS && Math.abs(deltaPhi) < SOLVER_TOLERANCE * DEG2RAD) {
			// Reject only after convergence: the curve point must lie on the sunlit hemisphere.
			if (h < 0) return undefined
			return { x: normalizePI(longitude), y: phi, jd: julianDay0 + t * pbe.stepDays }
		}
	}

	return undefined
}

// Traces one eclipse curve family across longitude, following Astrarium's tracing model: the scan
// runs from -PI to +PI with a symmetric set of latitude seeds (CURVE_SEED_LATITUDES) covering both
// hemispheres, preferring continuation from the previous solution on each seed track. Existence
// transitions are refined by longitude bisection and gaps wider than maxAngularStep are densified by
// solving at intermediate longitudes. The collected points are deduplicated and ordered by Julian Day,
// collapsing only points coincident in both time and space (so time folds keep both branches);
// disconnected stretches are NOT joined here, so callers can split them with splitDisconnectedPolylines.
//   i = 0 -> central line; i = +1/-1 -> northern/southern limit.
//   G = 1 -> totality/annularity limit; G = 0 -> partiality limit.
export function findCurvePoints(pbe: PolynomialBesselianElements, i: -1 | 0 | 1, G: number, options: SolarEclipseCurveOptions = {}): readonly GeoPoint[] {
	const longitudeStep = validStep(options.longitudeStep, DEFAULT_LONGITUDE_STEP)
	const maxAngularStep = validStep(options.maxAngularStep, DEFAULT_MAX_ANGULAR_STEP)
	const seeds = CURVE_SEED_LATITUDES
	const points: GeoPoint[] = []
	const previousBySeed: (GeoPoint | undefined)[] = new Array(seeds.length).fill(undefined)

	for (let longitude = -PI; longitude <= PI + 1e-12; longitude += longitudeStep) {
		const lon = Math.min(longitude, PI)

		for (let seedIndex = 0; seedIndex < seeds.length; seedIndex++) {
			const previous = previousBySeed[seedIndex]
			// Continuation from the previous latitude keeps the Newton iteration on the same branch;
			// when it fails (or there is no previous point) retry from the fixed seed.
			let point = previous && findEclipseCurvePoint(pbe, lon, previous.y, i, G)
			point ??= findEclipseCurvePoint(pbe, lon, seeds[seedIndex], i, G)

			if (previous && !point) pushDistinct(points, refineCurveBoundary(pbe, previous.x, lon, previous.y, true, i, G))
			else if (!previous && point && lon > -PI) pushDistinct(points, refineCurveBoundary(pbe, lon - longitudeStep, lon, point.y, false, i, G))

			if (previous && point) appendRefinedSegment(points, pbe, previous, point, i, G, maxAngularStep)
			pushDistinct(points, point)
			previousBySeed[seedIndex] = point
		}
	}

	return orderCurvePoints(deduplicatePoints(points))
}

// Refines the longitude where a curve family appears or disappears by bisection between the last
// longitude where the solver converged and the first where it did not (Astrarium's FindFunctionEnd).
function refineCurveBoundary(pbe: PolynomialBesselianElements, aLon: Angle, bLon: Angle, seed: Angle, validLow: boolean, i: -1 | 0 | 1, G: number) {
	let low = aLon
	let high = bLon
	let best: GeoPoint | undefined

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

// Maximum recursion depth when densifying a curve gap: 2^8 interior points per scan interval.
const SEGMENT_REFINEMENT_MAX_DEPTH = 8

// Inserts solved points at intermediate longitudes while two consecutive curve points are farther
// apart than maxAngularStep, by recursive bisection: each midpoint is seeded from the
// great-circle-interpolated coordinates and solved, so the inserted points are physical solutions
// (never interpolated artifacts) and every emitted step honors maxAngularStep up to the depth limit.
function appendRefinedSegment(points: GeoPoint[], pbe: PolynomialBesselianElements, a: GeoPoint, b: GeoPoint, i: -1 | 0 | 1, G: number, maxAngularStep: Angle, depth = 0) {
	if (depth >= SEGMENT_REFINEMENT_MAX_DEPTH || !(angularDistance(a, b) > maxAngularStep)) return

	const intermediate = interpolateGreatCirclePoint(a, b, 0.5)
	const mid = findEclipseCurvePoint(pbe, intermediate.x, intermediate.y, i, G)
	if (!mid) return

	appendRefinedSegment(points, pbe, a, mid, i, G, maxAngularStep, depth + 1)
	pushDistinct(points, mid)
	appendRefinedSegment(points, pbe, mid, b, i, G, maxAngularStep, depth + 1)
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

		// Two seeds reaching the same instant yield the same location, so collapse a point only when it
		// coincides with the previous one both in time AND space. A fold can place two distinct locations
		// at nearly the same instant; those are kept so the branch is not silently merged (section 2.2).
		const ordered: GeoPoint[] = []
		for (const point of points) {
			const last = ordered.at(-1)
			if (last && point.jd! - last.jd! <= CURVE_TIME_EPSILON_DAYS && angularDistance(last, point) <= CURVE_SPATIAL_EPSILON) continue
			ordered.push(point)
		}
		return ordered
	}

	points.sort((a, b) => a.x - b.x || a.y - b.y)
	return deduplicatePoints(points)
}

// Splits a curve into separate polylines at genuine discontinuities: wherever two consecutive points
// are farther apart than maxGap the curve has left the sunlit hemisphere (or the solver family is
// physically disconnected there), so the pieces must not be joined by a straight chord. Pieces with
// fewer than two points are dropped as undrawable.
export function splitDisconnectedPolylines(points: readonly GeoPoint[], maxGap: Angle): GeoPoint[][] {
	if (points.length === 0) return []

	const pieces: GeoPoint[][] = []
	let current: GeoPoint[] = [points[0]]

	for (let i = 1; i < points.length; i++) {
		if (angularDistance(points[i - 1], points[i]) > maxGap) {
			if (current.length > 1) pieces.push(current)
			current = []
		}
		current.push(points[i])
	}

	if (current.length > 1) pieces.push(current)

	return pieces
}

// Splits a polar/circumpolar limit at its largest absolute latitude, matching Astrarium's two-piece
// rendering of a limit that folds back over itself near a pole.
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

// Splits a raw umbra/antumbra limit into drawable polylines: first at genuine discontinuities, then
// each piece at its latitude apex when it folds back (more than two points).
function splitUmbraLimit(points: readonly GeoPoint[], maxAngularStep: Angle): GeoPoint[][] {
	return splitDisconnectedPolylines(points, maxAngularStep * CURVE_GAP_SPLIT_FACTOR).flatMap((piece) => splitAtMaxAbsLatitude(piece))
}

// E. RISE/SET CURVES

// Maximum recursion depth when subdividing a rise/set step in time to trace the true curve.
const RISE_SET_REFINE_MAX_DEPTH = 10

// One sampled instant of a rise/set phase: the two limb crossings (branches) at that Julian Day.
interface RiseSetSample {
	jd: number
	upper: GeoPoint
	lower: GeoPoint
}

// Finds the intersections of the Earth unit circle with a circle of the given radius centered at
// (cx, cy) in the fundamental plane, ordered by descending y. Returns two points, one tangency
// point, or none. All outputs lie on the unit circle, ready for projectFundamentalPoint.
export function findCircleIntersections(cx: number, cy: number, radius: number): [number, number][] {
	const dSquared = cx * cx + cy * cy

	if (!Number.isFinite(dSquared) || !(dSquared > 0) || !Number.isFinite(radius) || radius < 0) return []

	const d = Math.sqrt(dSquared)
	// Distance from the origin to the chord of intersection, along the center direction.
	const a = (dSquared + 1 - radius * radius) / (2 * d)
	const hSquared = 1 - a * a

	// A numerically grazing intersection can leave hSquared slightly negative; treat it as tangency
	// instead of rejecting the contact (report section 6.2).
	if (hSquared < -GEOMETRY_TANGENCY_EPSILON) return []

	const h = Math.sqrt(Math.max(0, hSquared))
	const ux = cx / d
	const uy = cy / d
	const first: [number, number] = [a * ux - h * uy, a * uy + h * ux]

	if (h === 0) return [first]

	const second: [number, number] = [a * ux + h * uy, a * uy - h * ux]
	return first[1] >= second[1] ? [first, second] : [second, first]
}

// Projects the points where the penumbra edge crosses the Earth's limb at one instant, ordered by
// descending fundamental-plane y. The crossing is solved against the flattened limb ellipse rather than
// the unit circle, so the oblique projection of the ellipsoid is honored (report section 1.4).
function riseSetCrossings(pbe: PolynomialBesselianElements, jd: number): GeoPoint[] {
	const be = besselianSampleAtJulianDay(pbe, jd)
	return earthLimbCircleIntersections(be.x, be.y, earthLimbOmega(be.d), Math.abs(be.l1))
		.map(([x, y]): GeoPoint | undefined => projectFundamentalPoint(be, x, y))
		.filter(finitePoint)
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

	const stepDays = validStep(options.step, DEFAULT_RISE_SET_STEP_SECONDS) / DAYSEC
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

// F. PUBLIC ASSEMBLY

// Local eclipse character on the central line at one instant: total where the umbral cone vertex lies
// beyond the surface point (local umbral radius l2 - zeta * tanF2 < 0), annular otherwise. zeta is the
// surface point's distance from the fundamental plane along the axis, recovered from the flattened limb
// (report section 3.3).
function centralLineKind(pbe: PolynomialBesselianElements, jd: number): EclipseKind {
	const be = besselianSampleAtJulianDay(pbe, jd)
	const y1 = earthLimbOmega(be.d) * be.y
	const zeta = Math.sqrt(Math.max(0, 1 - be.x * be.x - y1 * y1))
	return be.l2 - zeta * be.tanF2 < 0 ? 'total' : 'annular'
}

// Computes serializable geographic geometry for a solar eclipse map. Every curve family comes from
// findEclipseCurvePoint via findCurvePoints. The umbra/antumbra limits exist for every non-partial
// eclipse (including non-central total/annular ones whose axis misses the Earth), while the central
// line and its C1/C2 endpoints exist only when the shadow axis actually pierces the ellipsoid. The
// penumbra limits exist for every eclipse.
export function computeSolarEclipseMapGeometry(eclipse: SolarEclipse, pbe: PolynomialBesselianElements, options: SolarEclipseMapGeometryOptions = {}): SolarEclipseMapGeometry {
	const contacts = findPenumbraContactPoints(pbe, options)
	const points: Writable<SolarEclipseContactPoints> = { ...contacts, Max: findMaximumPoint(pbe) }
	const longitudeStep = validStep(options.longitudeStep, DEFAULT_LONGITUDE_STEP)
	const maxAngularStep = validStep(options.maxAngularStep, DEFAULT_MAX_ANGULAR_STEP)
	const curveOptions: SolarEclipseCurveOptions = { longitudeStep, maxAngularStep }

	let centerLine: readonly GeoPoint[] = []
	let umbraNorth: GeoPoint[][] = []
	let umbraSouth: GeoPoint[][] = []

	// Whether the umbra/antumbra touches Earth at all, and whether the shadow axis truly intersects the
	// ellipsoid (the latter is the real geometric test that replaces the former gamma threshold).
	const hasUmbralLimits = eclipse.type !== 'partial'
	const hasCentralLine = hasUmbralLimits && centralAxisIntersectsEarth(pbe)

	if (hasUmbralLimits) {
		// The umbral/antumbral cone tangency contacts exist whenever the umbra reaches Earth; they are
		// informational markers and never control the umbra-limit polylines. The G = 1 limits are traced
		// for every non-partial eclipse, even non-central ones with no central line.
		Object.assign(points, findUmbraContactPoints(pbe, options))
		umbraNorth = splitUmbraLimit(findCurvePoints(pbe, 1, 1, curveOptions), maxAngularStep)
		umbraSouth = splitUmbraLimit(findCurvePoints(pbe, -1, 1, curveOptions), maxAngularStep)
	}

	if (hasCentralLine) {
		const C1 = findCentralLineExtremePoint(pbe, true, options)
		const C2 = findCentralLineExtremePoint(pbe, false, options)
		if (C1) points.C1 = C1
		if (C2) points.C2 = C2

		const line = assembleCenterLine(pbe, C1, C2, findCurvePoints(pbe, 0, 0, curveOptions), maxAngularStep)
		// Tag each central-line point with its local total/annular character so a hybrid eclipse's
		// transition is recoverable from the geometry.
		centerLine = line.map((point) => (point.jd === undefined ? point : { x: point.x, y: point.y, jd: point.jd, kind: centralLineKind(pbe, point.jd) }))
	}

	// Partial-eclipse (penumbra) north/south limits: the day-side curves where the penumbral cone
	// grazes the surface (magnitude 0), bounding the region where any partial eclipse is seen.
	const penumbraNorth = findCurvePoints(pbe, 1, 0, curveOptions)
	const penumbraSouth = findCurvePoints(pbe, -1, 0, curveOptions)

	// Expose the penumbral-limit extremes as named, informational points. When both penumbral limits
	// reach Earth, each branch contributes its two endpoints ordered chronologically (N1/S1 begin,
	// N2/S2 end). When only one limit reaches Earth (a grazing partial eclipse), that single curve
	// carries the eclipse's two extremes: the poleward one is N1, the equatorward one is S1, matching
	// the EclipseWise convention. They never control the curve geometry.
	const hasNorthPenumbraLimit = penumbraNorth.length >= 2
	const hasSouthPenumbraLimit = penumbraSouth.length >= 2
	if (hasNorthPenumbraLimit && hasSouthPenumbraLimit) {
		;[points.N1, points.N2] = penumbralLimitEndpointsByTime(pbe, penumbraNorth)
		;[points.S1, points.S2] = penumbralLimitEndpointsByTime(pbe, penumbraSouth)
	} else if (hasNorthPenumbraLimit || hasSouthPenumbraLimit) {
		const branch = hasNorthPenumbraLimit ? penumbraNorth : penumbraSouth
		const [a, b] = penumbralLimitCusps(pbe, branch)
		points.N1 = Math.abs(a.y) >= Math.abs(b.y) ? a : b
		points.S1 = Math.abs(a.y) >= Math.abs(b.y) ? b : a
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
	}
}

// Assembles the drawn central line: the time-ordered scanned points strictly between the C1/C2
// instants, with the C1/C2 endpoints added explicitly and the end intervals densified with solved
// points (never artificial connectors). Near the limb the projected line moves arbitrarily fast, so
// scan points within the time-collapse epsilon of an endpoint are dropped in favor of the exact
// C1/C2 contact, keeping them as the true endpoints of the polyline.
function assembleCenterLine(pbe: PolynomialBesselianElements, C1: GeoPoint | undefined, C2: GeoPoint | undefined, scan: readonly GeoPoint[], maxAngularStep: Angle): readonly GeoPoint[] {
	function insideWindow(point: GeoPoint) {
		return point.jd !== undefined && (C1?.jd === undefined || point.jd > C1.jd + CURVE_TIME_EPSILON_DAYS) && (C2?.jd === undefined || point.jd < C2.jd - CURVE_TIME_EPSILON_DAYS)
	}

	let interior = scan.filter(insideWindow)

	if (C1 && interior.length > 0) {
		const head: GeoPoint[] = []
		appendRefinedSegment(head, pbe, C1, interior[0], 0, 0, maxAngularStep)
		interior = [...head.filter(insideWindow), ...interior]
	}

	if (C2 && interior.length > 0) {
		const tail: GeoPoint[] = []
		appendRefinedSegment(tail, pbe, interior.at(-1)!, C2, 0, 0, maxAngularStep)
		interior = [...interior, ...tail.filter(insideWindow)]
	}

	interior = Array.from(orderCurvePoints(deduplicatePoints(interior)))
	if (C1) interior.unshift(C1)
	if (C2) interior.push(C2)

	return deduplicatePoints(interior)
}

// Geometric solar altitude (radians) of an observer at a limit point at its own instant. The two named
// extremes of a grazing penumbral limit are its terminator cusps, where this drops to ~0.
function solarAltitudeAtPoint(pbe: PolynomialBesselianElements, point: GeoPoint) {
	const be = besselianSampleAtJulianDay(pbe, point.jd!)
	const H = hourAngleFromLongitude(point.x, be.mu, deltaTLongitudeCorrection(be))
	const sinh = Math.sin(be.d) * Math.sin(point.y) + Math.cos(be.d) * Math.cos(point.y) * Math.cos(H)
	return Math.asin(clamp(sinh, -1, 1))
}

// Minimum spatial separation (radians) required between the two named cusps of a single penumbral
// limit, so both end up on different terminator cusps rather than two samples of the same one.
const PENUMBRAL_CUSP_MIN_SEPARATION = 5 * DEG2RAD

// The two terminator cusps of a single grazing penumbral limit: the points where the limit meets the
// horizon (lowest solar altitude). This is robust against the curve solver returning the points in
// Julian-Day order, which can interleave two spatial branches near a fold and bury a cusp in the middle
// of the array (so the raw first/last endpoints are not the cusps; see report section 2.2).
function penumbralLimitCusps(pbe: PolynomialBesselianElements, curve: readonly GeoPoint[]): [GeoPoint, GeoPoint] {
	if (curve.length <= 2) return [curve[0], curve.at(-1)!]

	const byAltitude = Array.from(curve, (point) => ({ point, altitude: solarAltitudeAtPoint(pbe, point) })).sort((p, q) => p.altitude - q.altitude)
	const first = byAltitude[0].point
	// The second cusp is the lowest-altitude point that is also far enough from the first; falling back to
	// the chronological endpoints if the curve never folds into two separated cusps.
	const second = byAltitude.find((entry) => sphericalSeparation(first.x, first.y, entry.point.x, entry.point.y) > PENUMBRAL_CUSP_MIN_SEPARATION)?.point
	return second ? [first, second] : [curve[0], curve.at(-1)!]
}

// The two terminator cusps of a penumbral limit ordered by ascending time (earliest first), falling
// back to ascending latitude when either lacks a Julian Day. The penumbral-limit extremes are named by
// the eclipse chronology (N1/S1 begin, N2/S2 end), matching the EclipseWise/Espenak convention. Using
// the cusps rather than the raw array endpoints keeps the markers on the horizon even when the curve
// solver returns the limit's points jd-interleaved across a fold (report section 2.2).
function penumbralLimitEndpointsByTime(pbe: PolynomialBesselianElements, curve: readonly GeoPoint[]): [GeoPoint, GeoPoint] {
	const [a, b] = penumbralLimitCusps(pbe, curve)
	if (a.jd !== undefined && b.jd !== undefined) return a.jd <= b.jd ? [a, b] : [b, a]
	return a.y <= b.y ? [a, b] : [b, a]
}

// Julian Day span of a branch, or undefined when its points carry no time.
function branchTimeRange(branch: readonly GeoPoint[]) {
	let start = Infinity
	let end = -Infinity
	for (const point of branch) {
		if (point.jd === undefined) return undefined
		if (point.jd < start) start = point.jd
		if (point.jd > end) end = point.jd
	}
	return start <= end ? { start, end } : undefined
}

// Pairing cost between a north and a south umbra-limit branch: Infinity when their time spans do not
// overlap (so unrelated polar/antimeridian pieces are never welded), otherwise the smaller of the two
// endpoint-to-endpoint matchings.
function branchPairScore(north: readonly GeoPoint[], south: readonly GeoPoint[]) {
	const northRange = branchTimeRange(north)
	const southRange = branchTimeRange(south)

	if (northRange && southRange && Math.min(northRange.end, southRange.end) - Math.max(northRange.start, southRange.start) <= 0) return Infinity

	const aligned = angularDistance(north[0], south[0]) + angularDistance(north.at(-1)!, south.at(-1)!)
	const reversed = angularDistance(north[0], south.at(-1)!) + angularDistance(north.at(-1)!, south[0])
	return Math.min(aligned, reversed)
}

// Builds one fill ring from a north branch and its paired south branch: the north traversed forward,
// then the south oriented so it returns from the north's end back toward the north's start.
function buildFillRing(north: readonly GeoPoint[], south: readonly GeoPoint[]): GeoPoint[] {
	const ring: GeoPoint[] = []
	for (const point of north) pushDistinct(ring, point)

	const northStart = north[0]
	const northEnd = north.at(-1)!
	const forward = south
	const backward = south.toReversed()
	const forwardScore = angularDistance(northEnd, forward[0]) + angularDistance(northStart, forward.at(-1)!)
	const backwardScore = angularDistance(northEnd, backward[0]) + angularDistance(northStart, backward.at(-1)!)
	const oriented = forwardScore <= backwardScore ? forward : backward

	for (const point of oriented) pushDistinct(ring, point)

	// Drop a trailing point duplicating the first; the ring is closed at serialization time.
	if (ring.length > 1 && samePoint(ring[0], ring.at(-1)!)) ring.pop()
	return ring
}

// Derives visual-only fill rings for the totality/annularity band by pairing each northern umbra-limit
// branch with the southern branch it overlaps in time and space, instead of flattening all branches
// into one ring. Flattening (the previous approach) reconnected pieces that the curve solver had
// correctly separated at discontinuities, antimeridian wraps or polar folds, producing rings that cross
// the map; pairing keeps each disconnected band closed on its own (report section 4.1). It is a
// secondary, presentational artifact: the physical boundary polylines are never mutated.
export function computeSolarEclipseFillGeometry(geometry: SolarEclipseMapGeometry): GeoPoint[][] {
	const norths = geometry.lines.umbraNorth.filter((branch) => branch.length >= 2)
	const souths = geometry.lines.umbraSouth.filter((branch) => branch.length >= 2)

	if (norths.length === 0 || souths.length === 0) return []

	const rings: GeoPoint[][] = []
	const usedSouth = new Set<number>()

	for (const north of norths) {
		let bestIndex = -1
		let bestScore = Infinity

		for (let s = 0; s < souths.length; s++) {
			if (usedSouth.has(s)) continue
			const score = branchPairScore(north, souths[s])
			if (score < bestScore) {
				bestScore = score
				bestIndex = s
			}
		}

		if (bestIndex < 0 || !Number.isFinite(bestScore)) continue
		usedSouth.add(bestIndex)

		const ring = buildFillRing(north, souths[bestIndex])
		if (ring.length >= 3) rings.push(ring)
	}

	return rings
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

	// For a closed ring whose first vertex is not on the seam, the opening arc (the first segment) and
	// the closing arc (the last segment) both belong to the start hemisphere and were split apart at
	// line[0]; rejoin them so the hemisphere closes along the antimeridian seam rather than across the
	// map interior (report section 4.2). Each remaining segment already enters and leaves on the same
	// seam, so closing it with Z follows the seam edge.
	if (close && segments.length >= 2) {
		const firstSegment = segments[0]
		const lastSegment = segments.at(-1)!
		if (samePoint(firstSegment[0], lastSegment.at(-1)!)) {
			lastSegment.pop()
			segments[0] = [...lastSegment, ...firstSegment]
			segments.pop()
		}
	}

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
//
// Time-scale contract (report section 5.1): the dynamical steps (ephemeris sampling, precession and
// nutation) are dynamical-time operations, so the input time should be TT/TDB; the providers and
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
	// epoch, so the Earth displacement Earth(t) - Earth(t - tau) is added back (report section 5.2).
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

// Splits one geographic line (or ring when close is true) at the antimeridian with the exact +-180
// crossing inserted, then projects each piece. Inserting the crossing keeps every piece reaching the map
// edge instead of stopping at the last sample before the wrap, which otherwise leaves a visible gap or
// angular "beak" near +-180. The 'pi'-mode projection preserves an exact +-PI seam vertex, so the post-wrap
// piece resumes on the left edge (-PI) rather than being folded back onto the right one (+PI). The split
// happens only here, at serialization time: the geographic geometry itself is never mutated.
function projectSplitPieces(geo: readonly GeoPoint[], close: boolean, projection: Projection, options: ProjectionPolylineOptions) {
	const pieces: Point[][] = []

	for (const segment of splitGeoLineAtAntimeridian(geo, close)) {
		const piece: Point[] = []

		for (const point of segment) {
			const projected = projection.project(point.x, point.y, undefined, options)
			if (projected !== undefined) piece.push({ x: projected.x, y: projected.y })
		}

		if (piece.length >= 2) pieces.push(piece)
	}

	return pieces
}

// Projects geographic polylines and serializes them into one SVG path data string of open subpaths,
// split at the antimeridian during projection only.
export function geoPolylinesToSvgPathData(lines: readonly (readonly GeoPoint[])[], projection: Projection, { precision = 2, ...options }: SolarEclipseMapSvgProjectionOptions = {}): string {
	const pieces: Point[][] = []
	for (const line of lines) for (const piece of projectSplitPieces(line, false, projection, options)) pieces.push(piece)
	return pointsToSvgPathData(pieces, false, precision)
}

// Projects geographic polygon rings and serializes them into one SVG path data string of closed
// subpaths, split at the antimeridian during projection only.
export function geoPolygonsToSvgPathData(rings: readonly (readonly GeoPoint[])[], projection: Projection, { precision = 2, ...options }: SolarEclipseMapSvgProjectionOptions = {}): string {
	const pieces: Point[][] = []
	for (const ring of rings) for (const piece of projectSplitPieces(ring, true, projection, options)) pieces.push(piece)
	return pointsToSvgPathData(pieces, true, precision)
}

// Projects solar eclipse map geometry and serializes each polyline feature into SVG path data strings,
// aligned to the given projection. Antimeridian wraps are split into separate subpaths at projection
// time only; no synthetic connector is ever added. Fill rings (computeSolarEclipseFillGeometry) are
// serialized separately with geoPolygonsToSvgPathData.
export function solarEclipseMapToSvgPaths(geometry: SolarEclipseMapGeometry, projection: Projection, options: SolarEclipseMapSvgProjectionOptions = {}): SolarEclipseMapSvgPaths {
	function projectPoint(point: GeoPoint | undefined) {
		return point ? projection.project(point.x, point.y, undefined) : undefined
	}

	const { points, lines } = geometry

	return {
		centerLine: geoPolylinesToSvgPathData([lines.centerLine], projection, options),
		umbraNorth: geoPolylinesToSvgPathData(lines.umbraNorth, projection, options),
		umbraSouth: geoPolylinesToSvgPathData(lines.umbraSouth, projection, options),
		penumbraNorth: geoPolylinesToSvgPathData([lines.penumbraNorth], projection, options),
		penumbraSouth: geoPolylinesToSvgPathData([lines.penumbraSouth], projection, options),
		riseSetCurves: geoPolylinesToSvgPathData(lines.riseSetCurves, projection, options),
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
			N1: projectPoint(points.N1),
			N2: projectPoint(points.N2),
			S1: projectPoint(points.S1),
			S2: projectPoint(points.S2),
		},
	}
}
