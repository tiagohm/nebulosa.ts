import { type Angle, normalizeAngle, normalizePI } from './angle'
import type { PositionAndVelocityOverTime } from './astrometry'
import { AU_KM, DAYSEC, DEG2RAD, EARTH_RADIUS_KM, LIGHT_TIME_AU, PI, PIOVERTWO, RAD2DEG, SPEED_OF_LIGHT_AU_DAY, TAU, WGS84_FLATTENING } from './constants'
import type { EquatorialCoordinate } from './coordinate'
import { deltaTByEspenakMeeus2006 } from './deltat'
import { eraAb, eraEpj, eraGst06a, eraP2s, eraS2p } from './erfa'
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

// Solar eclipse map geometry engine. The module is layered as:
//   A. Besselian elements (polynomial fit, instant elements, evaluation).
//   B. Projection and Earth geometry (fundamental plane -> geographic).
//   C. Contacts and central endpoints (P1..P4, U1..U4, C1/C2, Max).
//   D. Curve solver (findEclipseCurvePoint / findCurvePoints and splitters).
//   E. Rise/set curves (Earth limb x penumbral circle intersections).
//   F. Public assembly and optional SVG serialization.
//
// Every physical curve family comes only from the curve solver (D); the umbra and penumbra limits are
// never capped, bridged, or welded.
//
// Unit conventions (audited):
//   - angles (right ascension, declination, d, mu, longitude, latitude) in radians;
//   - x, y, l1, l2 and their derivatives in Earth equatorial radii (derivatives per normalized step);
//   - Delta T in seconds; times as Time or Julian Day; distances in Earth equatorial radii;
//   - longitude is east-positive in [-PI, PI].

// Earth polar/equatorial radius ratio (1 - flattening).
export const F = 1 - WGS84_FLATTENING
// Reciprocal of F, used by the geographic-latitude conversion.
export const INV_F = 1 / F
// Squared eccentricity of the Earth ellipsoid used for limb flattening, e^2 = 1 - (b/a)^2.
export const EARTH_E2 = 1 - F * F
// Callers building PolynomialBesselianElements from a dynamical-time (TDT) tabulation set deltaTLongitudeCorrection to
// DELTA_T_LONGITUDE_FACTOR * deltaT; elements with UT-based mu (this module's own) use 0.
export const DELTA_T_LONGITUDE_FACTOR = 0.00417807 * DEG2RAD
const DEFAULT_LONGITUDE_STEP = 1 * DEG2RAD
const DEFAULT_MAX_ANGULAR_STEP = 1 * DEG2RAD
const DEFAULT_RISE_SET_STEP_SECONDS = 30
// Default half-width of the contact/endpoint root search window, in seconds. The external penumbral
// contacts P1/P4 (the global start/end of the partial eclipse) sit near the edge of the 6 h (t0 +- 3 h)
// fit and, because the search is centered on maximumTime while the fit is centered on the rounded t0, can
// land just past +-3 h of the maximum (e.g. the 2009-01-26 annular at +-3.04 h). 3.5 h covers them with
// only a mild cubic extrapolation past the fit edge, so rise/set curves (which need P1 and P4) are drawn.
// This is a default, NOT a hard cap: a caller may pass any contactSearchSpan (synthetic fixtures fit over a
// much wider range and do), in which case the search follows the supplied span.
const DEFAULT_CONTACT_SEARCH_SPAN_SECONDS = 3.5 * 3600
// Maximum half-width (seconds) the external contact search may grow to. A near-central eclipse's large
// penumbra keeps the partial phase longer than the default 3.5 h, so a P1/P4 can sit just past it (e.g. the
// 3163-07-23 annular at gamma -0.014, whose P4 lands at +3.51 h while P1 stays at -2.6 h). The Besselian
// cubic stays accurate a little past its +-3 h fit (it matches the true Sun/Moon external residual to five
// digits out to ~4.5 h there), so expanding the window to bracket such a contact is reliable; this cap
// bounds the extrapolation so a degenerate residual can never drive an unbounded search.
const CONTACT_SEARCH_MAX_SPAN_SECONDS = 5.5 * 3600
// Hard cap (seconds) on the half-width the greatest-eclipse closest-approach search may grow to. Unlike the
// contacts, the greatest-eclipse instant must be found even when a far-future maximumTime sits many hours
// before the actual eclipse (the published epoch is only a coarse label), so the search window grows past the
// contact cap until the minimum is bracketed. This bounds that growth: 12 h covers the worst observed offset
// (the 6100-09-30 closest approach ~5.9 h out) with margin, while a genuinely monotone residual stops here
// instead of extrapolating the cubic without limit.
const GREATEST_ECLIPSE_SEARCH_MAX_SPAN_SECONDS = 12 * 3600
// Step (seconds) by which each external contact-search edge is pushed outward while the shadow is still on
// Earth there. Small enough to land just past the contact, then the root scan refines within the bracket.
const CONTACT_SEARCH_EXPANSION_STEP_SECONDS = 15 * 60
// Root tolerance for contact and central-endpoint instants, in days (~1 ms, affordable because the iterations converge quadratically).
const CONTACT_TOLERANCE_DAYS = 1e-8
const SOLVER_MAX_ITERATIONS = 50
// Curve solver latitude convergence threshold: |deltaPhi| < 1e-4 deg expressed in radians.
const SOLVER_TOLERANCE = 1e-4
// Curve solver time convergence threshold, expressed directly in days (~0.1 s) instead of normalized
// step units, so it is independent of the polynomial step.
const SOLVER_TIME_TOLERANCE_DAYS = 0.1 / DAYSEC
// Final physical-residual gate (Earth radii) for a converged curve point. Newton can stop on a tiny
// latitude step in an ill-conditioned zone (steep dW/dphi) while the eclipse-condition residual W + i*|E|
// is still far from zero; such a false positive is rejected. Kept looser than the < 1e-3 tangency tolerance
// the acceptance tests assert, so every genuine solution is preserved.
const CURVE_RESIDUAL_TOLERANCE = 1e-4
// Numerical tolerance for tangential circle/ellipse intersections: a squared half-chord slightly below
// zero is treated as a grazing (single) contact rather than no contact.
const GEOMETRY_TANGENCY_EPSILON = 1e-14
// Residual tolerance (squared Earth radii) for a tangential circle/limb-ellipse intersection detected as
// a near-zero local extremum of g(theta) = distanceSquared - radius^2 that never changes sign. A genuine
// tangency is a double root; this catches it when it does not land exactly on a scan sample.
const LIMB_TANGENCY_RESIDUAL = 1e-9
// Residual tolerance (Earth radii) for a grazing temporal contact: a local extremum of the contact
// residual whose |value| drops to or below this is taken as a tangential (double) root even without a
// sign change. Kept tight so a non-central eclipse, whose internal residual stays well above zero, never
// gains spurious internal contacts.
const CONTACT_RESIDUAL_TOLERANCE = 1e-8
// Sun radius in Earth equatorial radii (NASA/Espenak convention), used for the apparent solar angular radius.
export const SUN_RADIUS_EARTH_RADII = 109.076370706
// Lunar radius k1 used for penumbral contacts and the penumbral cone, per NASA/Espenak convention.
export const MOON_RADIUS_PENUMBRA_EARTH_RADII = 0.272488
// Lunar radius k2 used for umbral contacts and the umbral cone, per NASA/Espenak convention.
export const MOON_RADIUS_UMBRA_EARTH_RADII = 0.272281
// Bisection steps used to refine the longitude where a curve family appears or disappears.
const BOUNDARY_REFINEMENT_STEPS = 18
// A solved curve is split into separate polylines wherever two consecutive points (in time order) are
// farther apart than this multiple of maxAngularStep: densification keeps continuous stretches within
// maxAngularStep, so a wider gap is a genuine discontinuity (the curve left the sunlit hemisphere)
// that must not be bridged by a straight chord.
const CURVE_GAP_SPLIT_FACTOR = 4
// Near the poles, a short great-circle step can still span many degrees of longitude and render as a kink
// in cylindrical maps, so bridge densification also watches longitude above this latitude.
const CURVE_POLAR_LONGITUDE_REFINEMENT_LATITUDE = 80 * DEG2RAD
// Minimum Julian Day separation between distinct points on a time-parametrized curve; points closer
// than this in time (~0.1 s, far below the minutes-apart sampling of any curve) are the same instant
// reached from different seeds and are collapsed to one.
const CURVE_TIME_EPSILON_DAYS = 1e-6
// Symmetric latitude seeds (radians) for the meridian scan, covering both hemispheres so polar,
// non-central and hybrid families are not missed by a single shadow-side seed.
// The poleward seeds stay short of +-90 deg to keep tan(phi) finite.
const CURVE_SEED_LATITUDES = [0, 30 * DEG2RAD, -30 * DEG2RAD, 60 * DEG2RAD, -60 * DEG2RAD, 80 * DEG2RAD, -80 * DEG2RAD, 89.5 * DEG2RAD, -89.5 * DEG2RAD] as const
const CURVE_SEED_LATITUDES_LENGTH = CURVE_SEED_LATITUDES.length
// Denser latitude seeds (radians) used only by the midpoint-bridging solver (solveCurveMidpointBetween),
// not by the per-longitude scan. Reconnecting two branches across a near-pole fold needs a finer sweep than
// CURVE_SEED_LATITUDES: the in-between curve point can sit in a narrow Newton convergence basin between the
// coarse seeds (notably the 80..89.5 deg gap), and missing it leaves a genuinely continuous limit drawn as
// two split arcs (e.g. the 4671-01-16 grazing annular umbra-north limit, whose bridge point converges only
// near -82 deg). The 3 deg grid spans -88..89 deg so both poles and that gap are covered; kept off the hot
// scan so the common case pays nothing.
const CURVE_BRIDGE_SEED_LATITUDES: number[] = []
for (let degrees = -88; degrees <= 89; degrees += 3) CURVE_BRIDGE_SEED_LATITUDES.push(degrees * DEG2RAD)
// Two curve points reached from different seeds at the same instant are the same location; they are
// collapsed only when also within this angular distance (~0.6 km), so a genuine time fold that places
// two distinct locations at nearly the same instant keeps both.
const CURVE_SPATIAL_EPSILON = 1e-4
// Time window (days, ~5 min) for matching a geometric umbral/antumbral contact (U1..U4) to the umbra-limit
// cusp it marks. The contacts are unrefracted while the limits carry the empirical horizon lift, so near a
// grazing terminator the limit curve runs almost tangent to the limb and a sub-minute refraction time shift
// maps to several degrees of position: the spatial snap then misses the cusp even though it is the same
// event. Matching by time recovers it. Kept far below the U2..U3 internal-contact separation (tens of
// minutes) so distinct contacts are never confused.
const UMBRAL_CONTACT_TIME_TOLERANCE_DAYS = 5 / 1440

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
	// from an ephemeris/TDT tabulation whose mu is in dynamical time.
	readonly deltaTLongitudeCorrection: Angle
	// Polynomial time unit in days.
	readonly step: number
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
	// Apparent or geocentric Sun equatorial coordinate.
	readonly sun: Required<EquatorialCoordinate>
	// Apparent or geocentric Moon equatorial coordinate.
	readonly moon: Required<EquatorialCoordinate>
	// Delta T in seconds for this sample.
	readonly deltaT?: number
}

// Local eclipse character along the central line, used to mark the total/annular transition of a hybrid eclipse.
export type HybridEclipseKind = 'total' | 'annular'

// Atmospheric-refraction model used by the curve solver near the horizon:
//   'empirical' lifts the observer with an exponential horizon-refraction factor so the limit extremes
//   (notably the penumbral N1/S1) match the refracted EclipseWise/Espenak references — the default and the
//   compatibility behavior;
//   'none' solves the pure geometric eclipse with no observer lift, for callers that want unrefracted
//   geometry. The empirical factor's time/latitude derivatives are intentionally omitted (an accepted
//   first-order approximation of this compatibility layer), so the modes must not be mixed silently.
export type RefractionMode = 'none' | 'empirical'

// Default refraction model: the empirical horizon lift, matching the published refracted references.
const DEFAULT_REFRACTION_MODE: RefractionMode = 'empirical'

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
	readonly kind?: HybridEclipseKind
}

export type GeoBranch = GeoPoint[]
export type GeoCurve = GeoBranch[]

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
	// polylines. When both penumbral limits reach Earth, N1/N2 are the northern limit's two terminator
	// cusps ordered chronologically; for a grazing partial, N1 is the earlier cusp of the single limit
	// (chronological, not poleward — both cusps may share a hemisphere).
	readonly N1?: GeoPoint
	// Second endpoint of the northern penumbral limit. Absent for a grazing partial. Informational only.
	readonly N2?: GeoPoint
	// Southern penumbral-limit extreme; for a grazing partial, S1 is the later cusp of the single limit.
	// S1/S2 otherwise mirror N1/N2 for the southern limit. Informational only.
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
		readonly centerLine: GeoBranch
		// Northern totality or annularity limit (G = 1), split at discontinuities and at its latitude
		// apex. Empty for partial eclipses; may still exist for non-central total/annular eclipses whose
		// axis misses the Earth (so centerLine is empty) but whose umbra still grazes the limb.
		readonly umbraNorth: GeoCurve
		// Southern totality or annularity limit (G = 1), split like umbraNorth.
		readonly umbraSouth: GeoCurve
		// Northern partial eclipse limit (G = 0), as continuity branches. Points within a branch may be
		// connected; separate branches (e.g. the two arcs meeting at a longitude-fold cusp the solver could
		// not trace through) must never be joined, so a near-pole fold is drawn as distinct arcs rather than a
		// straight spike across the map.
		readonly penumbraNorth: GeoCurve
		// Southern partial eclipse limit (G = 0), as continuity branches like penumbraNorth.
		readonly penumbraSouth: GeoCurve
		// Sunrise and sunset eclipse curves.
		readonly riseSetCurves: GeoCurve
	}
}

// Options for computing the full eclipse map geometry.
export interface SolarEclipseMapGeometryOptions {
	// Longitude scan step in radians.
	readonly longitudeStep?: Angle
	// Maximum angular spacing between neighboring curve points in radians.
	readonly maxAngularStep?: Angle
	// Rise/set curve sampling step in seconds.
	readonly riseSetStep?: number
	// Whether to include sunrise and sunset curves.
	readonly includeRiseSetCurves?: boolean
	// Atmospheric-refraction model for the curve solver. Defaults to 'empirical' (refracted references).
	readonly refractionMode?: RefractionMode
}

// Options for generating one family of eclipse curve points.
export interface SolarEclipseCurveOptions {
	// Longitude scan step in radians.
	readonly longitudeStep?: Angle
	// Maximum angular spacing between neighboring curve points in radians.
	readonly maxAngularStep?: Angle
	// Atmospheric-refraction model for the curve solver. Defaults to 'empirical' (refracted references).
	readonly refractionMode?: RefractionMode
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

// Geographic-only point equality (ignores jd and uses spherical separation, so +PI and -PI on the
// antimeridian and points coincident only in space are treated as one). Used when chaining curve branches
// by spatial continuity, where two branches can meet at the same location carrying slightly different times.
function sameGeoPoint(a: GeoPoint, b: GeoPoint) {
	return angularDistance(a, b) < 1e-9
}

function pushDistinct(points: GeoBranch, point: GeoPoint | undefined) {
	if (!finitePoint(point)) return
	if (points.length === 0 || !samePoint(points.at(-1)!, point)) points.push(point)
}

function evaluatePolynomial(coefficients: Readonly<NumberArray>, t: number) {
	let value = 0
	for (let i = coefficients.length - 1; i >= 0; i--) value = value * t + coefficients[i]
	return value
}

function evaluatePolynomialDerivative(coefficients: Readonly<NumberArray>, t: number) {
	let value = 0
	for (let i = coefficients.length - 1; i >= 1; i--) value = value * t + i * coefficients[i]
	return value
}

function unwrapAngles(values: NumberArray) {
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

	return values
}

function fitCubic(x: Readonly<NumberArray>, y: Readonly<NumberArray>) {
	return polynomialRegression(x, y, 3).coefficients
}

function angularDistance(a: GeoPoint, b: GeoPoint) {
	return sphericalSeparation(a.x, a.y, b.x, b.y)
}

function longitudeGap(a: GeoPoint, b: GeoPoint) {
	const gap = Math.abs(a.x - b.x)
	return gap > PI ? TAU - gap : gap
}

function curveGapNeedsRefinement(a: GeoPoint, b: GeoPoint, maxAngularStep: Angle) {
	if (angularDistance(a, b) > maxAngularStep) return true
	if (Math.max(Math.abs(a.y), Math.abs(b.y)) <= CURVE_POLAR_LONGITUDE_REFINEMENT_LATITUDE) return false
	return Math.hypot(longitudeGap(a, b), a.y - b.y) > maxAngularStep
}

function curveBridgeGapNeedsRefinement(a: GeoPoint, b: GeoPoint, maxAngularStep: Angle) {
	if (curveGapNeedsRefinement(a, b, maxAngularStep)) return true
	return Math.max(Math.abs(a.y), Math.abs(b.y)) > CURVE_POLAR_LONGITUDE_REFINEMENT_LATITUDE && Math.hypot(longitudeGap(a, b), a.y - b.y) > maxAngularStep * 0.25
}

function interpolateGreatCirclePoint(a: GeoPoint, b: GeoPoint, fraction: number): GeoPoint {
	const [longitude, latitude] = sphericalInterpolate(a.x, a.y, b.x, b.y, fraction)

	return {
		x: normalizeLongitude(longitude),
		y: latitude,
		jd: a.jd !== undefined && b.jd !== undefined ? a.jd + (b.jd - a.jd) * fraction : undefined,
	}
}

function validStep(value: number | undefined, fallback: number) {
	return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback
}

function timeAtJulianDay(reference: Time, julianDay: number) {
	return timeShift(reference, julianDay - reference.day - reference.fraction)
}

// Interpolates between two geographic points along the great-circle arc.
export function intermediateGreatCircle(a: GeoPoint, b: GeoPoint, fraction: number) {
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
interface BesselianElements {
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

// Allocates a zeroed BesselianElements buffer for reuse across hot solver iterations.
function createBesselianElements(): BesselianElements {
	return { x: 0, y: 0, l1: 0, l2: 0, d: 0, mu: 0, dx: 0, dy: 0, dmu: 0, dd: 0, dl1: 0, dl2: 0, tanF1: 0, tanF2: 0 }
}

// Reused buffer. Safe as a single module scratch: those scans are sequential and never re-enter each other.
const BESSELIAN_ELEMENTS_SCRATCH = createBesselianElements()

// Evaluates Besselian positions and velocity derivatives directly from the normalized polynomial time into
// a caller-owned output buffer, avoiding per-iteration allocation in hot solver loops.
function evaluateBesselianAtTInto(out: BesselianElements, pbe: PolynomialBesselianElements, t: number): BesselianElements {
	out.x = evaluatePolynomial(pbe.x, t)
	out.y = evaluatePolynomial(pbe.y, t)
	out.l1 = evaluatePolynomial(pbe.l1, t)
	out.l2 = evaluatePolynomial(pbe.l2, t)
	out.d = evaluatePolynomial(pbe.d, t)
	out.mu = normalizeAngle(evaluatePolynomial(pbe.mu, t))
	out.dx = evaluatePolynomialDerivative(pbe.x, t)
	out.dy = evaluatePolynomialDerivative(pbe.y, t)
	out.dmu = evaluatePolynomialDerivative(pbe.mu, t)
	out.dd = evaluatePolynomialDerivative(pbe.d, t)
	out.dl1 = evaluatePolynomialDerivative(pbe.l1, t)
	out.dl2 = evaluatePolynomialDerivative(pbe.l2, t)
	out.tanF1 = pbe.tanF1
	out.tanF2 = pbe.tanF2
	return out
}

// Evaluates Besselian element positions at one time, skipping the velocity derivatives.
function evaluateBesselianSample(pbe: PolynomialBesselianElements, time: Time): BesselianSample {
	const t = timeSubtract(time, pbe.time0) / pbe.step

	return {
		time,
		deltaT: pbe.deltaT,
		deltaTLongitudeCorrection: pbe.deltaTLongitudeCorrection,
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

export function besselianSampleAtJulianDay(pbe: PolynomialBesselianElements, jd: number) {
	return evaluateBesselianSample(pbe, timeAtJulianDay(pbe.time0, jd))
}

// Evaluates polynomial Besselian elements at one time, including velocity derivatives.
export function evaluateBesselian(pbe: PolynomialBesselianElements, time: Time): InstantBesselianElements {
	const t = timeSubtract(time, pbe.time0) / pbe.step
	const be = evaluateBesselianSample(pbe, time) as Writable<InstantBesselianElements>
	be.dx = evaluatePolynomialDerivative(pbe.x, t)
	be.dy = evaluatePolynomialDerivative(pbe.y, t)
	return be
}

// Classical solar Besselian fit: five samples uniformly spread over a 6 h window centered on t0
// (t0 +- 3 h), with the polynomial time unit fixed at one hour so the coefficients match the
// NASA/Espenak hourly tabulation.
const PBE_STEP_DAYS = 1 / 24
const PBE_OFFSETS = [-3, -1.5, 0, 1.5, 3] as const

// Computes approximate polynomial Besselian elements from caller-provided Sun and Moon samples.
export function computePolynomialBesselianElements(maximumTime: Time, getSunMoonPosition: (time: Time) => SunMoonPosition): PolynomialBesselianElements {
	const maximumJulianDay = toJulianDay(maximumTime)
	const julianDay0 = Math.round(maximumJulianDay * 24) / 24
	const time0 = timeAtJulianDay(maximumTime, julianDay0)
	const t = new Float64Array(PBE_OFFSETS)
	const n = PBE_OFFSETS.length
	const x = new Float64Array(n)
	const y = new Float64Array(n)
	const l1 = new Float64Array(n)
	const l2 = new Float64Array(n)
	const d = new Float64Array(n)
	const mu = new Float64Array(n)
	let tanF1 = 0
	let tanF2 = 0
	let deltaT = 0

	for (let i = 0; i < n; i++) {
		const offset = PBE_OFFSETS[i]
		const sampleTime = timeShift(time0, offset * PBE_STEP_DAYS)
		const position = getSunMoonPosition(sampleTime)
		const instant = instantBesselianFromSunMoon(sampleTime, position)
		x[i] = instant.x
		y[i] = instant.y
		l1[i] = instant.l1
		l2[i] = instant.l2
		d[i] = instant.d
		mu[i] = instant.mu
		tanF1 += instant.tanF1
		tanF2 += instant.tanF2
		deltaT += position.deltaT ?? 0
	}

	return {
		time0,
		maximumTime,
		deltaT: deltaT / n,
		deltaTLongitudeCorrection: 0,
		step: PBE_STEP_DAYS,
		x: fitCubic(t, x),
		y: fitCubic(t, y),
		l1: fitCubic(t, l1),
		l2: fitCubic(t, l2),
		d: fitCubic(t, d),
		mu: fitCubic(t, unwrapAngles(mu)),
		tanF1: tanF1 / n,
		tanF2: tanF2 / n,
	}
}

// Computes instantaneous Besselian elements from one Sun and Moon position sample:
// the shadow axis is the Sun-Moon direction, the cone half-angles come from
// sinF1 = (rSun + rMoon) / |Sun - Moon| and sinF2 = (rSun - rMoon) / |Sun - Moon|, the cone vertices
// sit at zv1 = zm + rMoon / sinF1 and zv2 = zm - rMoon / sinF2 along the axis, and the fundamental
// plane radii are l1 = zv1 * tanF1 and l2 = zv2 * tanF2. The NASA k1/k2 lunar radii are kept for the
// penumbral/umbral cones respectively (an intentional refinement).
export function instantBesselianFromSunMoon(time: Time, position: SunMoonPosition): InstantBesselianElements {
	const projection = besselianShadowProjection(position)
	const deltaT = position.deltaT ?? 0
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
	// consistent with the precession/nutation rotation applied to the positions.
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
function besselianShadowProjection(position: SunMoonPosition) {
	if (!(position.sun.distance > 0) || !(position.moon.distance > 0)) {
		return { x: 0, y: 0, zm: 0, rightAscension: position.sun.rightAscension, declination: position.sun.declination, sunMoonDistance: 0 }
	}

	const sun = eraS2p(position.sun.rightAscension, position.sun.declination, position.sun.distance)
	const moon = eraS2p(position.moon.rightAscension, position.moon.declination, position.moon.distance)
	const sunMinusMoon = vecMinus(sun, moon)
	const sunMoonDistance = vecLength(sunMinusMoon)

	if (!(sunMoonDistance > 0) || !Number.isFinite(sunMoonDistance)) {
		return { x: 0, y: 0, zm: 0, rightAscension: position.sun.rightAscension, declination: position.sun.declination, sunMoonDistance: 0 }
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
// into the central-line endpoint solver: omega = s^(-1/2), s = 1 - e^2 cos^2 d,
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
export function earthLimbPoint(theta: number, omega: number) {
	return [Math.cos(theta), Math.sin(theta) / omega] as const
}

function earthLimbDistanceSquared(theta: number, cx: number, cy: number, omega: number) {
	const dx = Math.cos(theta) - cx
	const dy = Math.sin(theta) / omega - cy
	return dx * dx + dy * dy
}

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
function limbDistanceSquaredFromCosSin(cos: number, sin: number, cx: number, cy: number, omega: number) {
	const dx = cos - cx
	const dy = sin / omega - cy
	return dx * dx + dy * dy
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
function earthLimbSignedDistance(cx: number, cy: number, omega: number) {
	const extremes = earthLimbExtremes(cx, cy, omega)
	return extremes.inside ? -extremes.minDistance : extremes.minDistance
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

function EarthLimbCircleIntersectionPointComparator(a: readonly [number, number], b: readonly [number, number]) {
	return b[1] - a[1]
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

// Projects one fundamental-plane point on or inside the Earth limb to geographic longitude and latitude.
// This is the single source of truth for the fundamental plane -> geographic conversion: every contact,
// curve and rise/set point goes through it. A point outside the limb returns undefined (only a
// numerically grazing point, within GEOMETRY_TANGENCY_EPSILON, is snapped to the limb): callers that
// need a representative on-Earth point for an outside input must request it explicitly via
// projectClosestEarthLimbPoint, instead of relying on a hidden clamp.
export function projectFundamentalPoint(be: BesselianSample, x: number, y: number): GeoPoint | undefined {
	if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined

	const sinD = Math.sin(be.d)
	const cosD = Math.cos(be.d)
	const omega = earthLimbOmega(be.d)
	const px = x
	const y1 = omega * y
	const b1 = omega * sinD
	const b2 = F * omega * cosD
	let bSquared = 1 - px * px - y1 * y1

	if (bSquared < 0) {
		if (bSquared < -GEOMETRY_TANGENCY_EPSILON) return undefined
		bSquared = 0
	}

	const B = Math.sqrt(bSquared)
	const H = Math.atan2(px, B * b2 - y1 * b1)
	const phi1 = Math.asin(clamp(B * b1 + y1 * b2, -1, 1))
	const lat = Math.atan(INV_F * Math.tan(phi1))
	const lon = longitudeFromHourAngle(H, be.mu, be.deltaTLongitudeCorrection)

	if (!Number.isFinite(lon) || !Number.isFinite(lat)) return undefined

	return { x: lon, y: lat, jd: toJulianDay(be.time) }
}

// Projects the point of the Earth-limb ellipse closest to a fundamental-plane point. Used when the
// requested point lies outside the Earth (e.g. the shadow axis of a partial or non-central eclipse) and
// a representative on-limb location is still wanted, making the former implicit clamp explicit.
export function projectClosestEarthLimbPoint(be: BesselianSample, x: number, y: number) {
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

// Refines a bracketed root, preferring Brent (superlinear) and falling back to bisection if Brent rejects the bracket.
function refineRoot(f: (x: number) => number, min: number, max: number) {
	try {
		return brentRoot(f, min, max, BISECT_ROOT_OPTIONS).root
	} catch {
		return bisectRoot(f, min, max)
	}
}

function NumberComparator(a: number, b: number) {
	return a - b
}

// Number of uniform sub-intervals used to scan the contact search window for sign changes before
// refinement. A grazing or nearly-tangent contact is easily missed by a single bisection over the whole
// window, so every root is bracketed by scanning first.
const CONTACT_SCAN_STEPS = 96

// Finds every root of f in [from, to] by scanning for sign changes and refining each bracket. Exact
// zeros landing on a sample are captured once. When tangencyTolerance is given, a strict local extremum of
// f whose minimized |f| stays within that tolerance is also reported as a (grazing) double root, so a
// contact that touches zero without changing sign is not missed. Roots are returned sorted and deduplicated.
function findRootsInInterval(f: (x: number) => number, from: number, to: number, steps: number, tangencyTolerance?: number) {
	const h = (to - from) / steps
	const xs = new Float64Array(steps + 1)
	const values = new Float64Array(steps + 1)

	for (let k = 0; k <= steps; k++) {
		xs[k] = k === steps ? to : from + k * h
		values[k] = f(xs[k])
	}

	const roots: number[] = []

	// Transversal roots: exact zeros on a sample and sign changes between neighbors.
	for (let k = 0; k < steps; k++) {
		if (values[k] === 0) {
			roots.push(xs[k])
		} else if (values[k] * values[k + 1] < 0) {
			const root = refineRoot(f, xs[k], xs[k + 1])
			if (root !== undefined) roots.push(root)
		}
	}

	if (values[steps] === 0) roots.push(xs[steps])

	// Grazing roots: a strict interior local extremum whose minimized |f| is within tolerance of zero.
	if (tangencyTolerance !== undefined) {
		for (let k = 1; k < steps; k++) {
			const isMinimum = values[k] < values[k - 1] && values[k] < values[k + 1]
			const isMaximum = values[k] > values[k - 1] && values[k] > values[k + 1]

			if (!isMinimum && !isMaximum) continue

			try {
				const minimum = brentMinimize((x) => Math.abs(f(x)), xs[k - 1], xs[k + 1])
				if (minimum.value <= tangencyTolerance) roots.push(minimum.minimum)
			} catch {
				// Bracket rejected: keep the transversal roots already collected.
			}
		}
	}

	roots.sort(NumberComparator)

	// Collapse roots a sign change and a tangency pass can both report for the same grazing contact.
	const out: number[] = []

	for (const root of roots) {
		if (out.length === 0 || root - out.at(-1)! > CONTACT_TOLERANCE_DAYS) out.push(root)
	}

	return out
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
// of the unit-circle hypot - 1 used previously.
function findShadowContactPoints(pbe: PolynomialBesselianElements, radius: (be: BesselianSample) => number) {
	const julianDay0 = toJulianDay(pbe.time0)
	const publishedMaximumJulianDay = toJulianDay(pbe.maximumTime)
	const searchSpanDays = DEFAULT_CONTACT_SEARCH_SPAN_SECONDS / DAYSEC
	// Center the contact window on the fitted closest approach when the published maximumTime is materially
	// inconsistent with it (the same recentering findMaximumPoint and findCentralLineExtremePoint apply). A
	// maximumTime offset by hours from the true closest approach pushes the far external contact past the
	// window cap measured from maximumTime, so it is never bracketed and the egress contact collapses onto the
	// ingress one (P3/P4 then out of chronological order, e.g. the 4621-03-28 annular whose published maximum
	// is ~2.4 h before the closest approach, leaving P4 just past the +5.5 h cap). Only for the default span,
	// so an explicit-span caller still gets the window centered exactly on maximumTime.
	const tMaximum = (publishedMaximumJulianDay - julianDay0) / pbe.step
	const tBest = findGreatestEclipseT(pbe)
	const maximumJulianDay = Math.abs(tBest - tMaximum) * pbe.step <= MAXIMUM_TIME_CONSISTENCY_DAYS ? publishedMaximumJulianDay : julianDay0 + tBest * pbe.step

	function external(jd: number) {
		const be = besselianSampleAtJulianDay(pbe, jd)
		return earthLimbSignedDistance(be.x, be.y, earthLimbOmega(be.d)) - radius(be)
	}

	function internal(jd: number) {
		const be = besselianSampleAtJulianDay(pbe, jd)
		return earthLimbSignedDistance(be.x, be.y, earthLimbOmega(be.d)) + radius(be)
	}

	// The external residual is negative while the shadow is still on Earth, so a negative value at a window
	// edge means the external contact (P1/P4, U1/U4) lies beyond it; push that edge outward (bounded by the
	// expansion cap) until the shadow has left, so the contact is bracketed instead of being clamped to the
	// other one. Edges where the shadow has already left are kept. Expansion applies only to the default span:
	// a caller that passes an explicit contactSearchSpan gets exactly that window, so it is never widened past
	// the request.
	const maxSpanDays = CONTACT_SEARCH_MAX_SPAN_SECONDS / DAYSEC
	const stepDays = CONTACT_SEARCH_EXPANSION_STEP_SECONDS / DAYSEC
	// Gate the expansion on the edge reaching its cap, using the exact cap the Math.min clamps to, not on
	// `to - maximumJulianDay < maxSpanDays`. Once the edge saturates at the cap, that algebraic guard can stay
	// true forever from floating-point rounding ((cap - maximumJulianDay) rounding just under maxSpanDays),
	// and when the shadow still covers the cap (external < 0 there, e.g. the wide penumbra of the 4621-03-28
	// annular) the loop would spin in place. Comparing against the cap directly always terminates.
	const toCap = maximumJulianDay + maxSpanDays
	const fromCap = maximumJulianDay - maxSpanDays
	let from = maximumJulianDay - searchSpanDays
	let to = maximumJulianDay + searchSpanDays
	while (to < toCap && external(to) < 0) to = Math.min(to + stepDays, toCap)
	while (from > fromCap && external(from) < 0) from = Math.max(from - stepDays, fromCap)

	// Keep the scan resolution constant as the window grows so a narrow internal bracket is never skipped.
	const steps = Math.max(CONTACT_SCAN_STEPS, Math.round((CONTACT_SCAN_STEPS * (to - from)) / ((2 * DEFAULT_CONTACT_SEARCH_SPAN_SECONDS) / DAYSEC)))
	const externalRoots = findRootsInInterval(external, from, to, steps, CONTACT_RESIDUAL_TOLERANCE)
	const internalRoots = findRootsInInterval(internal, from, to, steps, CONTACT_RESIDUAL_TOLERANCE)

	return {
		first: projectContactRoot(pbe, externalRoots[0]),
		firstInternal: projectContactRoot(pbe, internalRoots[0]),
		lastInternal: projectContactRoot(pbe, internalRoots.at(-1)),
		last: projectContactRoot(pbe, externalRoots.at(-1)),
	}
}

// Finds the P1/P2/P3/P4 penumbral contact points: the roots of the signed distance from the shadow-axis
// center to the Earth-limb ellipse, external (P1/P4: signedDistance - l1 = 0) and internal
// (P2/P3: signedDistance + l1 = 0), before and after the eclipse maximum. The classical unit-circle
// hypot - 1 -+ l1 is replaced by the ellipse signed distance so Earth flattening is honored.
export function findPenumbraContactPoints(pbe: PolynomialBesselianElements) {
	const contacts = findShadowContactPoints(pbe, (be) => be.l1)
	return { P1: contacts.first, P2: contacts.firstInternal, P3: contacts.lastInternal, P4: contacts.last } as const
}

// Finds the U1/U2/U3/U4 umbral/antumbral cone tangency contacts with the limb: the roots of the signed
// distance from the shadow-axis center to the Earth-limb ellipse, external (U1/U4: signedDistance - |l2|
// = 0) and internal (U2/U3: signedDistance + |l2| = 0). l2 is negative for a total eclipse, positive for
// an annular one. They are informational markers only and never control the umbra-limit polylines.
export function findUmbraContactPoints(pbe: PolynomialBesselianElements) {
	const contacts = findShadowContactPoints(pbe, (be) => Math.abs(be.l2))
	return { U1: contacts.first, U2: contacts.firstInternal, U3: contacts.lastInternal, U4: contacts.last } as const
}

// Squared distance from the shadow axis to the Earth-limb ellipse center at normalized time t, i.e.
// x(t)^2 + (omega(d(t)) y(t))^2. It is <= 1 exactly when the axis pierces the ellipsoid at t.
function centralAxisDistanceSquaredAtT(pbe: PolynomialBesselianElements, t: number) {
	const be = evaluateBesselianAtTInto(BESSELIAN_ELEMENTS_SCRATCH, pbe, t)
	const y1 = earthLimbOmega(be.d) * be.y
	return be.x * be.x + y1 * y1
}

// Tests whether the shadow axis intersects the Earth ellipsoid, replacing the gamma-threshold heuristic with
// the actual geometry: the axis pierces the ellipsoid exactly when its closest approach to the limb center,
// min x^2 + (omega y)^2, drops to or below 1. The minimum is located by findGreatestEclipseT, whose window
// grows to track a far-future maximumTime that sits hours from the eclipse; evaluating the distance there
// keeps the central classification, the greatest-eclipse point and the central-line endpoints (all built on
// findGreatestEclipseT) consistent. A fixed window centered on a coarse maximumTime would miss the real
// closest approach and wrongly classify a central eclipse as non-central (e.g. the 6255-06-02 total at
// gamma 0.899, whose axis closest approach of 0.90 sits ~6.4 h past maximumTime, well beyond a 3.5 h window).
export function centralAxisIntersectsEarth(pbe: PolynomialBesselianElements) {
	return centralAxisDistanceSquaredAtT(pbe, findGreatestEclipseT(pbe)) <= 1
}

// Maximum allowed gap (days) between maximumTime and the fitted closest-approach instant before
// maximumTime is treated as inconsistent and the greatest-eclipse location is recomputed at the minimized
// instant. Generous (60 s) so a published greatest-eclipse epoch, which already is the closest approach,
// is always kept verbatim and the returned jd stays exactly the authoritative instant.
const MAXIMUM_TIME_CONSISTENCY_DAYS = 60 / DAYSEC

// Normalized polynomial time of the greatest eclipse: the instant of closest shadow-axis approach to the
// Earth-limb ellipse center (minimum of x^2 + (omega y)^2) over the fitted span, seeded by a uniform scan
// and refined with Brent inside the span.
function findGreatestEclipseT(pbe: PolynomialBesselianElements) {
	const f = (t: number) => centralAxisDistanceSquaredAtT(pbe, t)
	// Search the closest approach in a window centered on maximumTime, matching centralAxisIntersectsEarth
	// and the contact searches, rather than around time0 (t = 0).
	const tMaximum = (toJulianDay(pbe.maximumTime) - toJulianDay(pbe.time0)) / pbe.step
	// Start at the contact expansion cap and grow while the minimum sits at a window edge: a far-future
	// maximumTime can sit hours before the eclipse, past even that cap, so a fixed window ends short of the
	// real minimum and pins the greatest-eclipse instant to the edge — leaving Max out of order with the
	// internal contacts P2/P3 the contact search reaches by recentering (e.g. the 6100-09-30 total, whose
	// closest approach is ~5.9 h past maximumTime, beyond the 5.5 h cap, with P1 itself ~3.4 h after it). The
	// window grows until the minimum is interior or the hard cap is reached, so the search walks out to the
	// eclipse the same way the recentered contact search does.
	const maxSpan = GREATEST_ECLIPSE_SEARCH_MAX_SPAN_SECONDS / DAYSEC / pbe.step
	const steps = 64
	let span = Math.min(CONTACT_SEARCH_MAX_SPAN_SECONDS / DAYSEC / pbe.step, maxSpan)
	let from = tMaximum - span
	let to = tMaximum + span
	let bestT = tMaximum
	let best = Infinity

	while (true) {
		from = tMaximum - span
		to = tMaximum + span
		best = Infinity
		bestT = tMaximum

		for (let k = 0; k <= steps; k++) {
			const t = from + ((to - from) * k) / steps
			const value = f(t)
			if (value < best) {
				best = value
				bestT = t
			}
		}

		const edge = (to - from) / steps
		// Stop once the minimum is strictly interior (the closest approach is bracketed) or the window has
		// reached the cap, so a genuinely monotone residual cannot grow the window without bound.
		if ((bestT > from + edge && bestT < to - edge) || span >= maxSpan) break
		span = Math.min(span * 2, maxSpan)
	}

	const half = (to - from) / steps

	try {
		const minimum = brentMinimize(f, Math.max(from, bestT - half), Math.min(to, bestT + half))
		if (minimum.value < best) bestT = minimum.minimum
	} catch {
		// Keep the coarse-scan argmin if the refinement bracket is rejected.
	}

	return bestT
}

// Finds the greatest eclipse point. The greatest-eclipse instant stays the authoritative maximumTime (the
// published greatest-eclipse epoch) whenever it agrees with the fitted closest approach; a materially
// inconsistent maximumTime (more than MAXIMUM_TIME_CONSISTENCY_DAYS from the fitted minimum of
// x^2 + (omega y)^2) is replaced by the fitted instant, so Max comes from the same Besselian fit as the
// contacts and central line. Otherwise a maximumTime offset by minutes from the fit can leave Max out of
// chronological order with the penumbral internal contacts P2/P3 (e.g. the 2732-03-18 total eclipse, whose
// maximumTime sits ~11 min before the fitted closest approach that P2/P3 bracket). At the chosen instant a
// central eclipse projects the axis strictly (it pierces the ellipsoid); a partial or non-central one
// projects the nearest limb point instead, since the axis misses the Earth.
export function findMaximumPoint(pbe: PolynomialBesselianElements) {
	const julianDay0 = toJulianDay(pbe.time0)
	const tMaximum = (toJulianDay(pbe.maximumTime) - julianDay0) / pbe.step
	const tBest = findGreatestEclipseT(pbe)

	const be = evaluateBesselianSample(pbe, pbe.maximumTime)
	const atMaximum = projectFundamentalPoint(be, be.x, be.y) ?? projectClosestEarthLimbPoint(be, be.x, be.y)
	if (Math.abs(tBest - tMaximum) * pbe.step <= MAXIMUM_TIME_CONSISTENCY_DAYS) return atMaximum

	const beBest = besselianSampleAtJulianDay(pbe, julianDay0 + tBest * pbe.step)
	return projectFundamentalPoint(beBest, beBest.x, beBest.y) ?? projectClosestEarthLimbPoint(beBest, beBest.x, beBest.y) ?? atMaximum
}

// Finds one extreme endpoint of the central line (C1 when begin is true, C2 otherwise): the instant
// the shadow axis grazes the flattened Earth limb x^2 + (omega*y)^2 = 1. Primary method is the
// iteration on the axis position (u, v) and velocity (a, b):
//   S = (a*v - u*b) / n, t1 = -(u*a + v*b) / n^2, t2 = sqrt(1 - S^2) / n, tau = t1 -+ t2,
// converging when |tau| is below CONTACT_TOLERANCE_DAYS. A sign-bisection on the limb residual is
// kept as fallback for when the iteration leaves the fitted span or S^2 exceeds 1 near tangency.
export function findCentralLineExtremePoint(pbe: PolynomialBesselianElements, begin: boolean) {
	const be = BESSELIAN_ELEMENTS_SCRATCH
	const julianDay0 = toJulianDay(pbe.time0)
	const maximumJulianDay = toJulianDay(pbe.maximumTime)
	const searchSpanDays = DEFAULT_CONTACT_SEARCH_SPAN_SECONDS / DAYSEC
	const tMaximum = (maximumJulianDay - julianDay0) / pbe.step
	// Center the endpoint search on the fitted closest approach when the published maximumTime is materially
	// inconsistent with it (the same recentering findMaximumPoint applies). The closest approach is where the
	// axis is deepest inside the limb and the central chord is widest, so begin (t1 - t2) and end (t1 + t2)
	// diverge to the two real limb crossings from there. Seeding both at a maximumTime that actually sits at
	// one crossing collapses them onto it: e.g. the 4245-06-08 total, whose published maximum is ~1.75 h before
	// the true closest approach and lands on C1, so the end search (bounded to maximumTime + span) stops just
	// short of C2 and brackets C1 instead, leaving C1/C2 coincident and out of chronological order.
	const tBest = findGreatestEclipseT(pbe)
	const tCenter = Math.abs(tBest - tMaximum) * pbe.step <= MAXIMUM_TIME_CONSISTENCY_DAYS ? tMaximum : tBest
	const centerJulianDay = julianDay0 + tCenter * pbe.step
	// Normalized half-width of the fitted contact window: the same span the bisection fallback below
	// brackets. The endpoint must lie inside it (measured from the search center).
	const spanNormalized = searchSpanDays / pbe.step
	let t = tCenter

	for (let iteration = 0; iteration < SOLVER_MAX_ITERATIONS; iteration++) {
		evaluateBesselianAtTInto(be, pbe, t)
		const omega = earthLimbOmega(be.d)
		const u = be.x
		const v = omega * be.y
		const a = be.dx
		// Velocity of v = omega(d) * y carries the d-dependence of the limb flattening: the omega term
		// is no longer constant because d varies with time.
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

		// The Newton step can converge onto a spurious tangency produced by the cubic extrapolation
		// outside the fitted window. The documented contract is to fall back to the bracketed bisection
		// when the iteration leaves the fitted span, so detect that here instead of returning the stray
		// root.
		if (!Number.isFinite(t) || Math.abs(t - tCenter) > spanNormalized) break
		if (Math.abs(tau) * pbe.step <= CONTACT_TOLERANCE_DAYS) return projectCentralAxisPoint(pbe, julianDay0 + t * pbe.step)
	}

	// Fallback: bisection of the limb residual between the search center and the window edge.
	function residual(jd: number) {
		const be = besselianSampleAtJulianDay(pbe, jd)
		const y1 = earthLimbOmega(be.d) * be.y
		return be.x * be.x + y1 * y1 - 1
	}

	const from = begin ? centerJulianDay - searchSpanDays : centerJulianDay
	const to = begin ? centerJulianDay : centerJulianDay + searchSpanDays
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

// Newton step plus physical diagnostics of the curve solver at one (t, phi), reused across iterations to
// avoid allocation in the hot loop.
interface CurveIterationState {
	// Newton step in normalized polynomial time.
	tau: number
	// Newton step in latitude, in radians.
	deltaPhi: number
	// Geometric solar altitude at (t, phi), in radians.
	h: number
	// Eclipse-condition residual W + i*|E|, in Earth radii.
	residual: number
}

const CURVE_ITERATION_STATE: CurveIterationState = { tau: 0, deltaPhi: 0, h: 0, residual: 0 }

// Evaluates the Newton step (tau, deltaPhi) and the physical diagnostics (solar altitude h, eclipse
// residual) at one (t, phi) into a reusable state, returning false when the geometry degenerates. It never
// advances t/phi, so the caller can re-evaluate the final converged state before accepting a point: the
// altitude and residual validated must belong to the returned point, not to the previous iterate (P0.1).
function evaluateCurveIterationState(state: CurveIterationState, be: BesselianElements, pbe: PolynomialBesselianElements, longitude: Angle, longitudeCorrection: Angle, t: number, phi: number, i: -1 | 0 | 1, G: number, refractionMode: RefractionMode) {
	evaluateBesselianAtTInto(be, pbe, t)
	const H = hourAngleFromLongitude(longitude, be.mu, longitudeCorrection)
	const sinD = Math.sin(be.d)
	const cosD = Math.cos(be.d)
	const sinH = Math.sin(H)
	const cosH = Math.cos(H)
	const sinPhi = Math.sin(phi)
	const cosPhi = Math.cos(phi)
	const U = Math.atan(F * Math.tan(phi))
	const rhoSinPhi = F * Math.sin(U)
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
	// the G = 0 curves drifts those extremes by a degree or more.
	if (hD >= 0 && hD <= 10 && refractionMode === 'empirical') {
		const sigma = 1.000012 + 0.0002282559 * Math.exp(-0.5035747 * hD)
		ksi *= sigma
		eta *= sigma
		zeta *= sigma
	}

	// Diurnal rate of the observer's coordinates in the fundamental plane, in radians per normalized
	// time unit. ksi has no declination dependence, so only the hour-angle rate dmu/dt enters; eta
	// additionally carries the declination rate dd via -dd * zeta, completing the derivative that the
	// previous code dropped.
	const ksiPrime = rhoCosPhi * cosH * be.dmu
	const etaPrime = rhoCosPhi * sinH * sinD * be.dmu - zeta * be.dd
	const u = be.x - ksi
	const v = be.y - eta
	const a = be.dx - ksiPrime
	const b = be.dy - etaPrime
	const nSquared = a * a + b * b

	if (!(nSquared > 0) || !Number.isFinite(nSquared)) return false

	const n = Math.sqrt(nSquared)
	const tau = -(u * a + v * b) / nSquared
	const W = (v * a - u * b) / n
	// Exact d/dphi of the reduced-latitude functions including flattening, replacing the
	// spherical approximation -d(rhoCosPhi)/dphi ~ rhoSinPhi and d(rhoSinPhi)/dphi ~ rhoCosPhi:
	//   -d(rhoCosPhi)/dphi = rhoSinPhi / (cos^2 phi + F^2 sin^2 phi)
	//    d(rhoSinPhi)/dphi = F^2 rhoCosPhi / (cos^2 phi + F^2 sin^2 phi)
	const latDenom = cosPhi * cosPhi + F * F * sinPhi * sinPhi
	const dRhoCos = rhoSinPhi / latDenom
	const dRhoSin = (F * F * rhoCosPhi) / latDenom
	const Q1 = b * sinH * dRhoCos
	const Q2 = a * (cosH * sinD * dRhoCos + cosD * dRhoSin)
	// dW/dphi = -(Q1 + Q2) / n in radians, so the Newton latitude step is residual / (dW/dphi).
	const Q = (Q1 + Q2) / n
	const dL1 = be.l1 - zeta * be.tanF1
	const dL2 = be.l2 - zeta * be.tanF2
	const E = dL1 - G * (dL1 + dL2)
	const residual = W + i * Math.abs(E)
	const deltaPhi = Q === 0 ? Number.NaN : residual / Q

	if (!Number.isFinite(tau) || !Number.isFinite(deltaPhi)) return false

	state.tau = tau
	state.deltaPhi = deltaPhi
	state.h = h
	state.residual = residual
	return true
}

// Solves one eclipse curve point at fixed longitude:
// a coupled Newton iteration on the normalized time t and the latitude phi that drives the observer
// onto the requested magnitude curve at the instant of closest approach.
//   longitude: east-positive longitude of the meridian to solve on, in radians.
//   initialLatitude: latitude seed in radians.
//   i = 0 -> central line (G ignored); i = +1/-1 -> northern/southern limit.
//   G = 1 -> totality/annularity limit; G = 0 -> partiality limit; 0 < G < 1 -> equal-magnitude curve.
// Atmospheric refraction (an empirical observer-lifting factor) applies to every family near the
// horizon (solar altitude between 0 and 10 deg), including the G = 0 partial limit, so its extremes
// match the refracted EclipseWise/Espenak references. Pass refractionMode 'none' for a pure geometric
// solve. A negative solar altitude is rejected only after convergence, so intermediate night-side iterates
// can still converge to a day-side solution. On convergence the final (t, phi) is re-evaluated so the
// altitude and residual gate the actual returned point, not the previous iterate.
export function findEclipseCurvePoint(pbe: PolynomialBesselianElements, longitude: Angle, initialLatitude: Angle, i: -1 | 0 | 1, G: number, refractionMode: RefractionMode = DEFAULT_REFRACTION_MODE) {
	let t = 0
	let phi = initialLatitude
	const julianDay0 = toJulianDay(pbe.time0)
	const longitudeCorrection = pbe.deltaTLongitudeCorrection
	const be = BESSELIAN_ELEMENTS_SCRATCH
	const state = CURVE_ITERATION_STATE

	for (let iteration = 0; iteration < SOLVER_MAX_ITERATIONS; iteration++) {
		if (!evaluateCurveIterationState(state, be, pbe, longitude, longitudeCorrection, t, phi, i, G, refractionMode)) return undefined

		const tau = state.tau
		const deltaPhi = state.deltaPhi
		const nextT = t + tau
		const nextPhi = phi + deltaPhi

		if (!Number.isFinite(nextT) || !Number.isFinite(nextPhi) || Math.abs(nextPhi) > PIOVERTWO) return undefined

		// Time convergence is tested in days (independent of the polynomial step), latitude in radians.
		if (Math.abs(tau) * pbe.step < SOLVER_TIME_TOLERANCE_DAYS && Math.abs(deltaPhi) < SOLVER_TOLERANCE * DEG2RAD) {
			// Re-evaluate at the final (nextT, nextPhi) and gate on THAT altitude/residual: the curve point
			// must lie on the sunlit hemisphere and actually satisfy the eclipse condition (a tiny step in an
			// ill-conditioned zone is not a real solution).
			if (!evaluateCurveIterationState(state, be, pbe, longitude, longitudeCorrection, nextT, nextPhi, i, G, refractionMode)) return undefined
			if (state.h < 0 || Math.abs(state.residual) > CURVE_RESIDUAL_TOLERANCE) return undefined
			return { x: normalizeLongitude(longitude), y: nextPhi, jd: julianDay0 + nextT * pbe.step }
		}

		t = nextT
		phi = nextPhi
	}

	return undefined
}

// Traces one eclipse curve family across longitude: the scan runs from -PI to +PI with a symmetric set
// of latitude seeds (CURVE_SEED_LATITUDES) covering both hemispheres, preferring continuation from the
// previous solution on each seed track. Existence transitions are refined by longitude bisection and gaps
// wider than maxAngularStep are densified by solving at intermediate longitudes. The collected points are
// deduplicated and ordered by Julian Day, collapsing only points coincident in both time and space
// (so time folds keep both branches); disconnected stretches are NOT joined here, so callers can split them
// with splitDisconnectedPolylines.
//   i = 0 -> central line; i = +1/-1 -> northern/southern limit.
//   G = 1 -> totality/annularity limit; G = 0 -> partiality limit.
export function findCurvePoints(pbe: PolynomialBesselianElements, i: -1 | 0 | 1, G: number, options: SolarEclipseCurveOptions = {}) {
	const maxAngularStep = validStep(options.maxAngularStep, DEFAULT_MAX_ANGULAR_STEP)
	const refractionMode = options.refractionMode ?? DEFAULT_REFRACTION_MODE
	const points: GeoBranch = []
	for (const branch of findCurveBranches(pbe, i, G, options)) for (const point of branch) points.push(point)
	return mendCurveCusps(orderCurvePoints(deduplicatePoints(points)), pbe, i, G, maxAngularStep, refractionMode)
}

// Densifies the gaps between arc-adjacent points of a time-ordered curve, so a longitude-fold cusp is not
// left as a sparse straight chord. Used for the central line (findCurvePoints), whose points are ordered by
// Julian Day; consecutive points are physically adjacent and a wide gap between them is either a re-solvable
// cusp (continuous) or a genuine discontinuity (not re-solvable). bridgeCurveGap inserts solved points only
// for the former, leaving real discontinuities as gaps.
function mendCurveCusps(points: GeoBranch, pbe: PolynomialBesselianElements, i: -1 | 0 | 1, G: number, maxAngularStep: Angle, refractionMode: RefractionMode) {
	if (points.length < 2) return points

	const out: GeoBranch = [points[0]]

	for (let k = 1; k < points.length; k++) {
		bridgeCurveGap(out, pbe, points[k - 1], points[k], i, G, maxAngularStep, refractionMode, 0)
		pushDistinct(out, points[k])
	}

	return out
}

// Recursively inserts solved curve points between two arc-adjacent points while their separation exceeds
// maxAngularStep, like appendRefinedSegment, but with a betweenness guard: a re-solved midpoint is accepted
// only when it lies strictly between the endpoints (both sub-distances shrink). A midpoint that does not
// (the solver landed on an unrelated arc that merely exists at the interpolated longitude) means the two
// endpoints belong to disconnected components, so the gap is left unbridged. This makes the pass safe to
// run across seed-branch boundaries, where appendRefinedSegment (used inside a single, already continuous
// branch) cannot tell a cusp from a discontinuity. At a longitude-fold cusp the two arcs share the
// intermediate longitude, so the midpoint is sought from several latitude seeds (the interpolated latitude,
// then each endpoint) and the first one that satisfies betweenness is kept, preventing a seed from
// snapping onto the other arc and dropping the bridge.
function bridgeCurveGap(out: GeoBranch, pbe: PolynomialBesselianElements, a: GeoPoint, b: GeoPoint, i: -1 | 0 | 1, G: number, maxAngularStep: Angle, refractionMode: RefractionMode, depth: number) {
	if (depth >= SEGMENT_REFINEMENT_MAX_DEPTH || !curveBridgeGapNeedsRefinement(a, b, maxAngularStep)) return

	const mid = solveCurveMidpointBetween(pbe, a, b, i, G, refractionMode)
	if (!mid) return

	bridgeCurveGap(out, pbe, a, mid, i, G, maxAngularStep, refractionMode, depth + 1)
	pushDistinct(out, mid)
	bridgeCurveGap(out, pbe, mid, b, i, G, maxAngularStep, refractionMode, depth + 1)
}

// Solves a curve point on the great-circle meridian halfway between a and b and returns it only when it
// lies strictly between them (both sub-distances shrink). A longitude fold places two arcs at the same
// intermediate longitude, so several latitude seeds are tried (the interpolated latitude, each endpoint,
// then the global curve seeds) and the first in-between solution is returned; undefined means no curve point
// connects a and b there, i.e. they belong to disconnected arcs. Shared by the cusp-mend densifier and the
// silent-arc-switch detector, so both decide continuity the same way.
// Fraction of the endpoint gap that the larger sub-distance of an accepted midpoint may reach. A real
// in-between point roughly bisects (both sub-distances near half the gap); a midpoint hugging one endpoint
// (the solver landed on the far endpoint's own arc) is rejected, so a silent arc switch is not mistaken for
// a bridgeable cusp.
const MIDPOINT_BALANCE = 0.75

function solveCurveMidpointBetween(pbe: PolynomialBesselianElements, a: GeoPoint, b: GeoPoint, i: -1 | 0 | 1, G: number, refractionMode: RefractionMode) {
	const ab = angularDistance(a, b)
	const limit = MIDPOINT_BALANCE * ab
	const intermediate = interpolateGreatCirclePoint(a, b, 0.5)

	let candidate = findEclipseCurvePoint(pbe, intermediate.x, intermediate.y, i, G, refractionMode)
	if (candidate && angularDistance(a, candidate) <= limit && angularDistance(candidate, b) <= limit) return candidate

	candidate = findEclipseCurvePoint(pbe, intermediate.x, b.y, i, G, refractionMode)
	if (candidate && angularDistance(a, candidate) <= limit && angularDistance(candidate, b) <= limit) return candidate

	candidate = findEclipseCurvePoint(pbe, intermediate.x, a.y, i, G, refractionMode)
	if (candidate && angularDistance(a, candidate) <= limit && angularDistance(candidate, b) <= limit) return candidate

	// Denser fallback sweep (off the hot scan): a near-pole fold's in-between point can sit in a narrow basin
	// the coarse seeds skip, which would otherwise leave a continuous limit split into two arcs.
	for (let s = 0; s < CURVE_BRIDGE_SEED_LATITUDES.length; s++) {
		const candidate = findEclipseCurvePoint(pbe, intermediate.x, CURVE_BRIDGE_SEED_LATITUDES[s], i, G, refractionMode)
		if (candidate && angularDistance(a, candidate) <= limit && angularDistance(candidate, b) <= limit) return candidate
	}

	return undefined
}

// Floor on the angular gap (radians, ~5 deg) above which a residual jump inside a single branch is treated
// as a drawable discontinuity and split. Normal cusp sparsity stays around the angular step (~2 deg at the
// default resolution), well below this, so clean eclipses are never split; only a solver jump or an
// unsampled fold cusp (e.g. the 2005-04-08 southern penumbral spike) exceeds it.
export const BRANCH_MAX_DRAWABLE_GAP = 5 * DEG2RAD

// Traces one drawable eclipse curve family as branches, preserving the solver's continuity arcs instead of
// flattening them into a single polyline. Each branch from findCurveBranches is already a densified,
// spatially continuous stretch where the seed stayed on one solution. Flattening and ordering by Julian Day
// is correct only while jd is monotonic along the arc; a near-pole terminator cusp folds jd (the 2005-04-08
// southern penumbral limit dips to a jd minimum at a longitude cusp), so a flat jd-ordered array places a
// polar endpoint next to a far point and draws a long straight spike. Globally chaining branches by nearest
// endpoint removes that spike but invents false connections elsewhere (a north-pole spike on 2024-04-08).
// Keeping the physical branches and never connecting across them avoids both. Redundant sub-arcs from
// overlapping seeds are dropped, then each branch is defensively split where a residual angular gap is too
// large to be a continuous step (a solver jump or an unsampled fold). Named endpoints (N1/N2/S1/S2) are
// derived from the flattened points downstream, so chronological naming is unaffected by the branch order.
function findCurveBranchPoints(pbe: PolynomialBesselianElements, i: -1 | 0 | 1, G: number, options: SolarEclipseCurveOptions = {}) {
	const maxAngularStep = validStep(options.maxAngularStep, DEFAULT_MAX_ANGULAR_STEP)
	const refractionMode = options.refractionMode ?? DEFAULT_REFRACTION_MODE
	const maxDrawableGap = Math.max(BRANCH_MAX_DRAWABLE_GAP, maxAngularStep * CURVE_GAP_SPLIT_FACTOR)
	const branches: GeoCurve = []

	// The continuation scan traces smooth arcs; the fixed-seed scan recovers arcs it orphans at near-polar
	// folds. Both feed the same cleanup/dedup/reconnect pipeline, which collapses the arcs they share.
	for (const branch of findCurveBranches(pbe, i, G, options)) {
		const cleaned = cleanCurveBranch(branch)
		if (cleaned.length >= 2) branches.push(cleaned)
	}
	for (const branch of findFixedSeedCurveArcs(pbe, i, G, options)) {
		const cleaned = cleanCurveBranch(branch)
		if (cleaned.length >= 2) branches.push(cleaned)
	}

	const deduped = deduplicateBranches(branches, maxAngularStep)
	const reconnected = reconnectBranchCusps(deduped, pbe, i, G, maxAngularStep, maxDrawableGap, refractionMode)
	let pieces = splitCurveBranches(reconnected, maxDrawableGap)
	const reconnectedPieces = reconnectBranchCusps(deduplicateBranches(pieces, maxAngularStep), pbe, i, G, maxAngularStep, maxDrawableGap, refractionMode)
	pieces = splitCurveBranches(reconnectedPieces, maxDrawableGap)
	const foldStep = maxAngularStep * CURVE_GAP_SPLIT_FACTOR
	const finalPieces = trimCurveBranchArtifacts(trimRetracedBranchEnds(pieces, maxAngularStep, maxDrawableGap), foldStep, maxAngularStep)
	const finalReconnected = reconnectBranchCusps(deduplicateBranches(finalPieces, maxAngularStep), pbe, i, G, maxAngularStep, maxDrawableGap, refractionMode)
	pieces = splitCurveBranches(finalReconnected, maxDrawableGap)
	const trimmed = trimCurveBranchArtifacts(trimRetracedBranchEnds(pieces, maxAngularStep, maxDrawableGap), foldStep, maxAngularStep)
	// Reconnect once more after the final trim. Trimming a retrace loop exposes a branch's true cusp
	// endpoint, which can be bridgeable to a neighbour even though it was buried inside the loop (and so
	// unbridgeable) during the previous reconnection pass. Without this the branches stay split across a
	// genuinely continuous gap (e.g. the near-polar 3160-09-22 penumbra-south limit, whose trimmed endpoint
	// sits ~5.9 deg from the adjacent branch with a continuous curve between them).
	const reconnectedTrimmed = reconnectBranchCusps(deduplicateBranches(trimmed, maxAngularStep), pbe, i, G, maxAngularStep, maxDrawableGap, refractionMode)
	pieces = splitCurveBranches(reconnectedTrimmed, maxDrawableGap)
	return deduplicateBranches(trimCurveBranchArtifacts(trimRetracedBranchEnds(pieces, maxAngularStep, maxDrawableGap), foldStep, maxAngularStep), maxAngularStep)
}

// Drops a stray endpoint vertex that folds the branch back onto an earlier part of itself. At a longitude
// fold of a grazing limit (a tiny closed loop, e.g. a non-central total eclipse whose umbra only grazes the
// limb) the curve tracer can append a single closure vertex that duplicates an interior vertex, leaving a
// long chord from the true endpoint back to a visited location — a visible spike. Such a vertex coincides
// (within CURVE_SPATIAL_EPSILON) with a non-adjacent vertex of the branch and is reached by a step larger
// than the fold threshold; trimming it keeps the branch a simple open arc without moving any retained point.
// foldStep: minimum step (radians) that flags an endpoint connection as an anomalous fold-back jump.
function trimFoldBackEndpoints(branch: GeoBranch, foldStep: Angle) {
	let start = 0
	let end = branch.length - 1

	while (end - start >= 2 && angularDistance(branch[end - 1], branch[end]) > foldStep && coincidesWithRange(branch, branch[end], start, end - 2)) end--
	while (end - start >= 2 && angularDistance(branch[start], branch[start + 1]) > foldStep && coincidesWithRange(branch, branch[start], start + 2, end)) start++

	return start === 0 && end === branch.length - 1 ? branch : branch.slice(start, end + 1)
}

// Applies branch-level cleanup that removes drawable solver artifacts without changing valid samples.
// foldStep is the minimum angular jump treated as a fold; closeTolerance joins near-coincident neighbours.
function trimCurveBranchArtifacts(branches: GeoCurve, foldStep: Angle, closeTolerance: Angle) {
	const out: GeoCurve = []

	for (const branch of branches) {
		const trimmed = trimInteriorFoldBackSpikes(trimFoldBackEndpoints(branch, foldStep), foldStep, closeTolerance)
		if (trimmed.length >= 2) out.push(trimmed)
	}

	return out
}

// Drops isolated one-vertex solver branch switches inside a curve. The pattern A -> B -> C with A and C
// nearly coincident but B several angular steps away is not a sampled cusp; it is a transient jump to the
// neighbouring solution that would draw a short spike and then return to the original arc.
// foldStep: minimum distance from the spike vertex to both neighbours; closeTolerance: A/C coincidence.
function trimInteriorFoldBackSpikes(branch: GeoBranch, foldStep: Angle, closeTolerance: Angle) {
	let current = branch

	while (current.length >= 3) {
		let removed = false
		const out: GeoBranch = [current[0]]

		for (let k = 1; k < current.length - 1; k++) {
			const previous = out.at(-1)!
			const point = current[k]
			const next = current[k + 1]

			if (angularDistance(previous, next) <= closeTolerance && angularDistance(previous, point) > foldStep && angularDistance(point, next) > foldStep) {
				removed = true
				continue
			}

			out.push(point)
		}

		out.push(current.at(-1)!)
		if (!removed) return current
		current = out
	}

	return current
}

// Whether point coincides geographically (within CURVE_SPATIAL_EPSILON) with any branch vertex in [from, to].
function coincidesWithRange(branch: GeoBranch, point: GeoPoint, from: number, to: number) {
	for (let k = from; k <= to; k++) if (angularDistance(branch[k], point) <= CURVE_SPATIAL_EPSILON) return true
	return false
}

// Removes consecutive points that coincide geographically (ignoring jd), preserving the branch's order.
// Where two seed tracks meet they can deposit the same vertex with slightly different times; collapsing the
// duplicate keeps the branch a clean polyline without moving any point. Never sorts and never reverses, so
// the solver's continuity order is preserved.
function cleanCurveBranch(branch: GeoBranch) {
	const out: GeoBranch = []
	for (const point of branch) pushCleanCurvePoint(out, point)
	return out
}

const EMPTY_GEO_POINTS: GeoBranch = []
const BRANCH_ENDPOINTS = [0, 1] as const

function pushCleanCurvePoint(out: GeoBranch, point: GeoPoint) {
	if (out.length === 0 || !sameGeoPoint(out.at(-1)!, point)) out.push(point)
}

function appendBranchPoints(out: GeoBranch, branch: GeoBranch, reverse: boolean) {
	if (reverse) {
		for (let k = branch.length - 1; k >= 0; k--) pushCleanCurvePoint(out, branch[k])
	} else {
		for (let k = 0; k < branch.length; k++) pushCleanCurvePoint(out, branch[k])
	}
}

function mergeBranchesAtCusp(a: GeoBranch, b: GeoBranch, bridge: GeoBranch, endpointA: 0 | 1, endpointB: 0 | 1) {
	const out: GeoBranch = []
	appendBranchPoints(out, a, endpointA === 0)
	for (const point of bridge) pushCleanCurvePoint(out, point)
	appendBranchPoints(out, b, endpointB === 1)
	return out
}

// Re-anchors a bridge that solved between endA and b's far endpoint but actually threads through b's near
// endpoint first. A limit folding around a pole connects branchA's endpoint to b's near endpoint by an arc
// that does not cross the great-circle meridian between those two near endpoints (so bridging them directly
// finds nothing), yet bridging to b's FAR endpoint succeeds — its midpoint meridian does cross the fold — and
// then runs along b to reach it. Splicing that whole bridge doubles back over b (a retrace). Instead keep the
// bridge only up to where it first reaches b's near endpoint (the genuine fold arc) and append b forward from
// there, giving branchA -> fold -> b as one arc. Returns undefined when the bridge never reaches that
// endpoint, i.e. the overlap is a real retrace and not a fold. e.g. the 6174-10-22 annular umbra-north limit.
function mergeFoldThroughBranchEndpoint(branchA: GeoBranch, branchB: GeoBranch, bridge: GeoBranch, endpointA: 0 | 1, endpointB: 0 | 1, tolerance: Angle) {
	if (bridge.length === 0) return undefined

	// b's near (re-anchor) endpoint is the one opposite the joint endB.
	const nearEndpoint = endpointB === 1 ? branchB[0] : branchB.at(-1)!
	let cut = -1
	let cutDistance = tolerance

	for (let k = 1; k < bridge.length; k++) {
		const distance = angularDistance(bridge[k], nearEndpoint)
		if (distance <= cutDistance) {
			cutDistance = distance
			cut = k
		}
	}

	// The bridge must reach b's near endpoint after a real fold prefix; otherwise this is a genuine retrace.
	if (cut <= 0) return undefined

	const foldBridge = bridge.slice(0, cut)
	return mergeBranchesAtCusp(branchA, branchB, foldBridge, endpointA, endpointB === 1 ? 0 : 1)
}

// Maximum endpoint gap (radians) a cusp reconnection will attempt to bridge. The fully continuous re-solve
// below is the real gate; this only bounds the work so obviously unrelated far branches are not probed.
const CUSP_RECONNECT_LIMIT = 20 * DEG2RAD

// Minimum along-curve arc length (radians) separating two points before a spatial coincidence counts as the
// branch retracing itself. A tight cusp brings points close in space but also close in arc length (the curve
// just turned around), so it is not flagged; a merge that doubles an arc back over itself revisits a location
// far away in arc length and is.
const CUSP_RECONNECT_OVERLAP_ARC = 10 * DEG2RAD

// Latitude (radians) beyond which a cusp reconnection is not attempted. Near a pole the longitude/latitude
// representation degenerates (meridians converge), so a bridge whose joint or inserted points enter this
// cap can zigzag across the seam. The gate is local to the proposed bridge: a branch may later reach the
// polar cap and still be reconnected through a lower-latitude endpoint.
const CUSP_RECONNECT_POLE_LATITUDE = 85 * DEG2RAD
const CUSP_RECONNECT_POLAR_LONGITUDE_LIMIT = 30 * DEG2RAD

function pointInReconnectPolarCap(point: GeoPoint) {
	return Math.abs(point.y) > CUSP_RECONNECT_POLE_LATITUDE
}

function bridgeEntersReconnectPolarCap(bridge: GeoBranch) {
	for (const point of bridge) if (pointInReconnectPolarCap(point)) return true
	return false
}

function bridgeHasLargePolarLongitudeStep(a: GeoPoint, b: GeoPoint, bridge: GeoBranch) {
	let previous = a

	for (const point of bridge) {
		if (Math.min(Math.abs(previous.y), Math.abs(point.y)) > CUSP_RECONNECT_POLE_LATITUDE && longitudeGap(previous, point) > CUSP_RECONNECT_POLAR_LONGITUDE_LIMIT) return true
		previous = point
	}

	return Math.min(Math.abs(previous.y), Math.abs(b.y)) > CUSP_RECONNECT_POLE_LATITUDE && longitudeGap(previous, b) > CUSP_RECONNECT_POLAR_LONGITUDE_LIMIT
}

function canReconnectPolarCusp(a: GeoPoint, b: GeoPoint, bridge: GeoBranch, gap: Angle, maxDrawableGap: Angle) {
	if (!pointInReconnectPolarCap(a) && !pointInReconnectPolarCap(b) && !bridgeEntersReconnectPolarCap(bridge)) return true
	return (gap <= maxDrawableGap || bridge.length > 0) && !bridgeHasLargePolarLongitudeStep(a, b, bridge)
}

// Re-solves the densified arc strictly between a and b, returning it only when the whole chain a -> arc -> b
// is continuous: every consecutive step is within continuityGap. The arc is densified to maxAngularStep, but
// a vertical-tangent fold cusp leaves one irreducible step near the tip, so continuityGap is the looser
// drawable-gap threshold; a true discontinuity inserts no points and leaves the full (larger) gap, so it is
// still rejected.
function solveContinuousBridge(pbe: PolynomialBesselianElements, a: GeoPoint, b: GeoPoint, i: -1 | 0 | 1, G: number, maxAngularStep: Angle, continuityGap: Angle, refractionMode: RefractionMode) {
	const bridge: GeoBranch = []
	bridgeCurveGap(bridge, pbe, a, b, i, G, maxAngularStep, refractionMode, 0)

	let previous = a
	for (const point of bridge) {
		if (angularDistance(previous, point) > continuityGap) return undefined
		previous = point
	}

	return angularDistance(previous, b) > continuityGap ? undefined : bridge
}

// Whether a branch doubles back over itself: two points close in space but far apart in arc length. Near the
// degenerate poles a re-solved bridge can fold an arc back onto an existing one; such a merge is rejected.
function branchRetraces(branch: GeoBranch, tolerance: Angle, minArcSeparation: Angle) {
	const arc = new Float64Array(branch.length)
	for (let k = 1; k < branch.length; k++) arc[k] = arc[k - 1] + angularDistance(branch[k - 1], branch[k])

	for (let a = 0; a < branch.length; a++) {
		for (let b = a + 1; b < branch.length; b++) {
			if (arc[b] - arc[a] < minArcSeparation) continue
			if (angularDistance(branch[a], branch[b]) < tolerance) return true
		}
	}

	return false
}

// Removes endpoint loops that trace away from an endpoint, return to it, then continue along the real
// outgoing arc. These are not physical closed limits: they are artifacts left after reconnecting longitude
// folds where one seed branch already covered the first arm. Trimming to the farthest point of the loop
// exposes the missing cusp endpoint so the final reconnection can bridge the adjacent branch without
// drawing a visible gap.
// tolerance: endpoint coincidence threshold in radians; minLoopArc: minimum along-branch loop length.
function trimRetracedBranchEnds(branches: GeoCurve, tolerance: Angle, minLoopArc: Angle) {
	const out: GeoCurve = []

	for (const branch of branches) {
		// Start-trim and end-trim each gate on the OTHER endpoint leaving the trimmed loop, so a branch that
		// winds back near both ends (a near-pole double fold, e.g. the 0994-02-18 grazing annular umbra) can
		// hide a start retrace behind a tail that loops back near the start: the start-trim's "tail leaves the
		// endpoint" guard fails until the tail is trimmed, but a single start-then-end pass trims the tail only
		// after the start-trim already gave up. Iterate both to a fixed point so an exposed retrace at either
		// end is still removed. Every successful trim strictly shortens the branch, so the branch length bounds
		// the iteration.
		let trimmed = branch
		for (let pass = 0; pass < branch.length; pass++) {
			const next = trimRetracedBranchEnd(trimRetracedBranchStart(trimmed, tolerance, minLoopArc), tolerance, minLoopArc)
			if (next.length === trimmed.length) break
			trimmed = next
		}
		if (trimmed.length >= 2) out.push(trimmed)
	}

	return out
}

// Trims a loop at the start of a branch when a later point revisits the start after a meaningful arc and
// the remaining tail leaves that endpoint. The returned array aliases the original points.
function trimRetracedBranchStart(branch: GeoBranch, tolerance: Angle, minLoopArc: Angle) {
	if (branch.length < 4) return branch

	const start = branch[0]
	const minTailDistance = tolerance * CURVE_GAP_SPLIT_FACTOR
	let arc = 0
	let farthestDistance = 0
	let farthestIndex = 0

	for (let k = 1; k < branch.length - 1; k++) {
		arc += angularDistance(branch[k - 1], branch[k])
		const distanceFromStart = angularDistance(start, branch[k])
		if (distanceFromStart > farthestDistance) {
			farthestDistance = distanceFromStart
			farthestIndex = k
		}

		if (arc >= minLoopArc && distanceFromStart <= tolerance && farthestDistance > tolerance && angularDistance(branch[k], branch.at(-1)!) > minTailDistance) return branch.slice(farthestIndex)
	}

	return branch
}

// Trims a loop at the end of a branch using the same criterion as trimRetracedBranchStart, scanning the
// branch in reverse. The returned array aliases the original points.
function trimRetracedBranchEnd(branch: GeoBranch, tolerance: Angle, minLoopArc: Angle) {
	if (branch.length < 4) return branch

	const end = branch.at(-1)!
	const minTailDistance = tolerance * CURVE_GAP_SPLIT_FACTOR
	let arc = 0
	let farthestDistance = 0
	let farthestIndex = branch.length - 1

	for (let k = branch.length - 2; k > 0; k--) {
		arc += angularDistance(branch[k + 1], branch[k])
		const distanceFromEnd = angularDistance(end, branch[k])
		if (distanceFromEnd > farthestDistance) {
			farthestDistance = distanceFromEnd
			farthestIndex = k
		}

		if (arc >= minLoopArc && distanceFromEnd <= tolerance && farthestDistance > tolerance && angularDistance(branch[k], branch[0]) > minTailDistance) return branch.slice(0, farthestIndex + 1)
	}

	return branch
}

// Merges branches that are one physical limit the solver under-sampled across a fold cusp. At a longitude
// fold every latitude seed can leave the cusp on the same arc, so the other arc out of the cusp is never
// traced and the limit arrives as two branches with an unsampled gap between their cusp endpoints (e.g. the
// 2005-04-08 penumbra-south, S1 -> cusp ... cusp -> S2). For the closest eligible endpoint pair the missing
// arc is re-solved, and the branches are merged only when that arc is continuous (solveContinuousBridge
// succeeds) and the merged branch does not retrace itself: a true discontinuity has no connecting curve, and
// a pole-degenerate bridge folds back, so both are left as separate branches and no spike is ever drawn.
// Pairs that already touch are skipped so nothing is retraced.
function reconnectBranchCusps(branches: GeoCurve, pbe: PolynomialBesselianElements, i: -1 | 0 | 1, G: number, maxAngularStep: Angle, maxDrawableGap: Angle, refractionMode: RefractionMode, allowTouchingMerge = true) {
	const result: GeoCurve = []
	for (const branch of branches) result.push(branch.slice())

	while (true) {
		let bestGap = Infinity
		let bestA = -1
		let bestB = -1
		let bestMerged: GeoBranch | undefined

		for (let a = 0; a < result.length; a++) {
			const branchA = result[a]
			const aStart = branchA[0]
			const aEnd = branchA.at(-1)!

			for (let b = a + 1; b < result.length; b++) {
				const branchB = result[b]
				const bStart = branchB[0]
				const bEnd = branchB.at(-1)!

				for (const ea of BRANCH_ENDPOINTS) {
					const endA = ea === 0 ? aStart : aEnd

					for (const eb of BRANCH_ENDPOINTS) {
						const endB = eb === 0 ? bStart : bEnd
						const gap = angularDistance(endA, endB)
						if (gap > CUSP_RECONNECT_LIMIT || gap >= bestGap) continue
						if (!allowTouchingMerge && gap < CURVE_SPATIAL_EPSILON) continue

						const bridge = gap <= maxAngularStep ? EMPTY_GEO_POINTS : solveContinuousBridge(pbe, endA, endB, i, G, maxAngularStep, maxDrawableGap, refractionMode)
						if (!bridge || !canReconnectPolarCusp(endA, endB, bridge, gap, maxDrawableGap)) continue

						// Orient A so endpoint ea is the joint (reverse when it is the start) and B so endpoint eb
						// is the joint (reverse when it is the end), then splice the bridge between them.
						let merged = mergeBranchesAtCusp(branchA, branchB, bridge, ea, eb)
						if (branchRetraces(merged, maxAngularStep, CUSP_RECONNECT_OVERLAP_ARC)) {
							// A pole-encircling fold's bridge reaches branchB's far endpoint by running along it,
							// so the straight splice doubles back. Retry anchoring at branchB's near endpoint with
							// just the fold arc; if that still retraces it is a real overlap, so leave them split.
							// Only in the pre-split reconnect (allowTouchingMerge true): the post-split pass must
							// keep the apex-split halves of one limit separate, and they touch at the apex with a
							// fold continuity that this would otherwise re-merge, undoing the split.
							const folded = allowTouchingMerge ? mergeFoldThroughBranchEndpoint(branchA, branchB, bridge, ea, eb, maxAngularStep) : undefined
							if (!folded || branchRetraces(folded, maxAngularStep, CUSP_RECONNECT_OVERLAP_ARC)) continue
							merged = folded
						}

						bestGap = gap
						bestA = a
						bestB = b
						bestMerged = merged
					}
				}
			}
		}

		if (bestA < 0 || !bestMerged) break

		result.splice(bestB, 1)
		result.splice(bestA, 1, bestMerged)
	}

	return result
}

// A branch point counts as lying on another branch when within this multiple of the angular step of one of
// that branch's samples; one step is the in-branch sample spacing, so 1.5 absorbs the half-step offset
// between two seeds sampling the same arc at shifted longitudes.
const BRANCH_CONTAINMENT_STEPS = 1.5

// Whether a point lies on a branch, i.e. within tolerance of any of its samples.
function pointOnBranch(point: GeoPoint, branch: GeoBranch, tolerance: Angle) {
	for (const sample of branch) if (angularDistance(point, sample) <= tolerance) return true
	return false
}

// Whether host makes branch redundant: branch is the same arc as part of host, up to a short overhang the
// host did not reach. Every interior point of branch must lie on host (so two genuinely distinct arcs that
// merely meet at a shared cusp, diverging immediately, are never collapsed), while a contiguous uncovered run
// at either end is tolerated as long as its arc length stays within maxOverhang — a seed that traced the same
// limit a couple of steps past the host's endpoint (e.g. the 5578-05-13 penumbra-south sub-arc that lies on
// the main branch but overshoots its start by ~1.5 deg). Independent of orientation, since proximity ignores
// order.
function branchCoveredBy(branch: GeoBranch, host: GeoBranch, tolerance: Angle, maxOverhang: Angle) {
	let firstCovered = -1
	let lastCovered = -1

	for (let k = 0; k < branch.length; k++) {
		if (pointOnBranch(branch[k], host, tolerance)) {
			if (firstCovered < 0) firstCovered = k
			lastCovered = k
		}
	}

	if (firstCovered < 0) return false

	// Reject an interior uncovered point: branch leaves host in the middle, so it is a distinct arc.
	for (let k = firstCovered + 1; k < lastCovered; k++) {
		if (!pointOnBranch(branch[k], host, tolerance)) return false
	}

	// The remaining uncovered points are the contiguous end overhangs [0, firstCovered) and (lastCovered, end].
	return overhangArcLength(branch, 0, firstCovered) <= maxOverhang && overhangArcLength(branch, lastCovered, branch.length - 1) <= maxOverhang
}

// Arc length (radians) of the branch points in [from, to], used to bound an uncovered end overhang.
function overhangArcLength(branch: GeoBranch, from: number, to: number) {
	let arc = 0
	for (let k = from + 1; k <= to; k++) arc += angularDistance(branch[k - 1], branch[k])
	return arc
}

function BranchComparatorByLengthDescending(a: GeoBranch, b: GeoBranch) {
	return b.length - a.length
}

// Drops redundant branches that another kept branch already covers. Several latitude seeds converge to one
// limit, emitting the same arc as a full copy and as shorter sub-arcs that start where each seed first
// acquired the solution; left in, the continuity chainer would retrace those overlaps and fold the arc back
// on itself (sharp 180-degree kinks). Considering branches longest first keeps the densest, most complete
// copy and discards every sub-arc covered by it.
function deduplicateBranches(branches: GeoCurve, maxAngularStep: Angle) {
	const tolerance = maxAngularStep * BRANCH_CONTAINMENT_STEPS
	// A redundant sub-arc may overshoot the host's endpoint by a short stub (a seed tracing the same limit a
	// few steps further); tolerate an overhang up to the fold-gap threshold so the duplicate is still dropped.
	const maxOverhang = maxAngularStep * CURVE_GAP_SPLIT_FACTOR
	const byLength = branches.toSorted(BranchComparatorByLengthDescending)
	const kept: GeoCurve = []

	for (const branch of byLength) {
		let found = false

		for (let i = 0; i < kept.length; i++) {
			if (branchCoveredBy(branch, kept[i], tolerance, maxOverhang)) {
				found = true
				break
			}
		}

		if (!found) kept.push(branch)
	}

	return kept
}

// Traces one eclipse curve family as separate continuity branches, one per uninterrupted stretch a seed
// stays on a solution. Each seed keeps its own active branch: while its solver keeps converging the points
// accumulate in that branch; when the solution disappears the branch is closed (its exit longitude refined
// first), and a fresh branch opens when the seed reacquires a solution (its entry longitude refined too).
// Densification happens inside a branch, so a branch is a spatially continuous arc and distinct spatial
// branches are never interleaved. findCurvePoints flattens and time-orders these for
// the time-parametrized public contract; consumers that need the raw arcs can use the branches directly.
function findCurveBranches(pbe: PolynomialBesselianElements, i: -1 | 0 | 1, G: number, options: SolarEclipseCurveOptions = {}) {
	const longitudeStep = validStep(options.longitudeStep, DEFAULT_LONGITUDE_STEP)
	const maxAngularStep = validStep(options.maxAngularStep, DEFAULT_MAX_ANGULAR_STEP)
	const refractionMode = options.refractionMode ?? DEFAULT_REFRACTION_MODE
	const seeds = CURVE_SEED_LATITUDES
	const branches: GeoCurve = []
	const previousBySeed = new Array<GeoPoint | undefined>(CURVE_SEED_LATITUDES_LENGTH)
	const activeBySeed = new Array<GeoBranch | undefined>(CURVE_SEED_LATITUDES_LENGTH)

	// Returns the seed's open branch, starting a new one when it has none (a branch begins or reappears).
	function openBranch(seedIndex: number) {
		let branch = activeBySeed[seedIndex]

		if (!branch) {
			branch = []
			branches.push(branch)
			activeBySeed[seedIndex] = branch
		}

		return branch
	}

	for (let longitude = -PI; longitude <= PI + 1e-12; longitude += longitudeStep) {
		const lon = Math.min(longitude, PI)

		for (let seedIndex = 0; seedIndex < CURVE_SEED_LATITUDES_LENGTH; seedIndex++) {
			let previous = previousBySeed[seedIndex]
			// Continuation from the previous latitude keeps the Newton iteration on the same branch;
			// when it fails (or there is no previous point) retry from the fixed seed.
			let point = previous && findEclipseCurvePoint(pbe, lon, previous.y, i, G, refractionMode)

			// Silent arc switch: at a longitude fold the seed's arc terminates while the other arc still
			// exists, and the Newton continuation snaps onto that far arc. Detect the jump (a large step with
			// no curve point in between) and treat it as the old arc disappearing here, closing the branch so
			// the two arcs are never welded by an internal chord; the block below then opens a fresh branch for
			// the new arc, and the missing fold segment is recovered later by the continuity assembler/mend.
			if (previous && point && angularDistance(previous, point) > maxAngularStep * CURVE_GAP_SPLIT_FACTOR && !solveCurveMidpointBetween(pbe, previous, point, i, G, refractionMode)) {
				const seeded = findEclipseCurvePoint(pbe, lon, seeds[seedIndex], i, G, refractionMode)
				const seededGap = seeded ? angularDistance(previous, seeded) : Infinity
				const switchedGap = angularDistance(previous, point)
				const seededContinues = seeded !== undefined && seededGap < switchedGap && (seededGap <= maxAngularStep * CURVE_GAP_SPLIT_FACTOR || solveCurveMidpointBetween(pbe, previous, seeded, i, G, refractionMode) !== undefined)

				if (seededContinues) {
					point = seeded
				} else {
					if (activeBySeed[seedIndex]) pushDistinct(activeBySeed[seedIndex]!, refineCurveBoundary(pbe, previous.x, lon, previous, true, i, G, refractionMode))
					activeBySeed[seedIndex] = undefined
					previous = undefined
				}
			}

			point ??= findEclipseCurvePoint(pbe, lon, seeds[seedIndex], i, G, refractionMode)

			if (previous && !point) {
				// The family just disappeared: refine the exit longitude into the open branch, then close it.
				if (activeBySeed[seedIndex]) pushDistinct(activeBySeed[seedIndex]!, refineCurveBoundary(pbe, previous.x, lon, previous, true, i, G, refractionMode))
				activeBySeed[seedIndex] = undefined
			} else if (!previous && point && lon > -PI) {
				// The family just appeared: open a new branch and refine the entry longitude into it first.
				pushDistinct(openBranch(seedIndex), refineCurveBoundary(pbe, lon - longitudeStep, lon, point, false, i, G, refractionMode))
			}

			if (point) {
				const branch = openBranch(seedIndex)
				if (previous) appendRefinedSegment(branch, pbe, previous, point, i, G, maxAngularStep, refractionMode)
				pushDistinct(branch, point)
			}

			previousBySeed[seedIndex] = point
		}
	}

	return branches
}

// Independent fixed-seed longitude scan that recovers limit arcs the continuation scan in findCurveBranches
// can orphan. When a limit folds near a pole the two arcs of the fold meet at the entry longitude, so every
// seed's continuation commits to whichever arc Newton picks there (typically the poleward one) and the
// fixed-seed fallback never fires because continuation keeps converging. The far arc, although reachable
// from a fixed seed nearer its own latitude band, is then never traced (e.g. the C2-side annularity limit of
// the near-polar 2471-03-22 annular eclipse, leaving U3/U4 with no curve to attach to). Solving each fixed
// seed independently at every longitude re-anchors it to the arc nearest its band; consecutive in-longitude
// solutions are linked while within the fold step and split otherwise. Every emitted point already satisfies
// the magnitude, altitude and residual gates of findEclipseCurvePoint, so the worst case is a duplicate of an
// arc the continuation scan already found; the caller merges both through deduplicateBranches/reconnect.
function findFixedSeedCurveArcs(pbe: PolynomialBesselianElements, i: -1 | 0 | 1, G: number, options: SolarEclipseCurveOptions = {}) {
	const longitudeStep = validStep(options.longitudeStep, DEFAULT_LONGITUDE_STEP)
	const maxAngularStep = validStep(options.maxAngularStep, DEFAULT_MAX_ANGULAR_STEP)
	const refractionMode = options.refractionMode ?? DEFAULT_REFRACTION_MODE
	const foldStep = maxAngularStep * CURVE_GAP_SPLIT_FACTOR
	const branches: GeoCurve = []

	for (let s = 0; s < CURVE_SEED_LATITUDES_LENGTH; s++) {
		let current: GeoBranch | undefined
		let previous: GeoPoint | undefined

		for (let longitude = -PI; longitude <= PI + 1e-12; longitude += longitudeStep) {
			const lon = Math.min(longitude, PI)
			const point = findEclipseCurvePoint(pbe, lon, CURVE_SEED_LATITUDES[s], i, G, refractionMode)

			if (point && previous && angularDistance(previous, point) <= foldStep) {
				appendRefinedSegment(current!, pbe, previous, point, i, G, maxAngularStep, refractionMode)
				pushDistinct(current!, point)
			} else if (point) {
				current = [point]
				branches.push(current)
			} else {
				current = undefined
			}

			previous = point
		}
	}

	return branches
}

function findNearestCurvePointAtLongitude(pbe: PolynomialBesselianElements, longitude: Angle, anchor: GeoPoint, i: -1 | 0 | 1, G: number, refractionMode: RefractionMode) {
	let best: GeoPoint | undefined
	let bestDistance = Infinity

	const point = findEclipseCurvePoint(pbe, longitude, anchor.y, i, G, refractionMode)
	if (point) {
		best = point
		bestDistance = angularDistance(anchor, point)
	}

	for (const seedLatitude of CURVE_SEED_LATITUDES) {
		const point = findEclipseCurvePoint(pbe, longitude, seedLatitude, i, G, refractionMode)
		if (!point) continue

		const distance = angularDistance(anchor, point)
		if (distance < bestDistance) {
			best = point
			bestDistance = distance
		}
	}

	return best
}

// Refines the longitude where a curve family appears or disappears by bisection between the last
// longitude where the solver converged and the first where it did not. A fold can have two roots at the
// same longitude, so each midpoint is selected by proximity to the branch anchor instead of a single Newton
// seed; otherwise the endpoint can jump to the other side of the fold and leave a visible cusp gap.
function refineCurveBoundary(pbe: PolynomialBesselianElements, aLon: Angle, bLon: Angle, anchor: GeoPoint, validLow: boolean, i: -1 | 0 | 1, G: number, refractionMode: RefractionMode = DEFAULT_REFRACTION_MODE) {
	let low = aLon
	let high = bLon
	let best: GeoPoint | undefined

	for (let step = 0; step < BOUNDARY_REFINEMENT_STEPS; step++) {
		const mid = (low + high) * 0.5
		const point = G === 1 ? findNearestCurvePointAtLongitude(pbe, mid, anchor, i, G, refractionMode) : findEclipseCurvePoint(pbe, mid, anchor.y, i, G, refractionMode)

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
function appendRefinedSegment(points: GeoBranch, pbe: PolynomialBesselianElements, a: GeoPoint, b: GeoPoint, i: -1 | 0 | 1, G: number, maxAngularStep: Angle, refractionMode: RefractionMode = DEFAULT_REFRACTION_MODE, depth = 0) {
	if (depth >= SEGMENT_REFINEMENT_MAX_DEPTH || !curveGapNeedsRefinement(a, b, maxAngularStep)) return

	const intermediate = interpolateGreatCirclePoint(a, b, 0.5)
	const mid = findEclipseCurvePoint(pbe, intermediate.x, intermediate.y, i, G, refractionMode)
	if (!mid) return

	appendRefinedSegment(points, pbe, a, mid, i, G, maxAngularStep, refractionMode, depth + 1)
	pushDistinct(points, mid)
	appendRefinedSegment(points, pbe, mid, b, i, G, maxAngularStep, refractionMode, depth + 1)
}

function deduplicatePoints(points: GeoBranch) {
	const out: GeoBranch = []
	for (const point of points) pushDistinct(out, point)
	return out
}

function GeoPointComparatorByJDAscending(a: GeoPoint, b: GeoPoint) {
	return a.jd! - b.jd!
}

function GeoPointComparatorByXOrYAscending(a: GeoPoint, b: GeoPoint) {
	return a.x - b.x || a.y - b.y
}

function orderCurvePoints(points: GeoBranch) {
	if (points.length <= 2) return points

	let allHaveJulianDay = true
	for (const point of points) {
		if (point.jd === undefined) {
			allHaveJulianDay = false
			break
		}
	}

	if (allHaveJulianDay) {
		points.sort(GeoPointComparatorByJDAscending)

		// Two seeds reaching the same instant yield the same location, so collapse a point only when it
		// coincides with the previous one both in time AND space. A fold can place two distinct locations
		// at nearly the same instant; those are kept so the branch is not silently merged (section 2.2).
		const ordered: GeoBranch = []

		for (const point of points) {
			const last = ordered.at(-1)
			if (last && point.jd! - last.jd! <= CURVE_TIME_EPSILON_DAYS && angularDistance(last, point) <= CURVE_SPATIAL_EPSILON) continue
			ordered.push(point)
		}

		return ordered
	}

	points.sort(GeoPointComparatorByXOrYAscending)
	return deduplicatePoints(points)
}

// Appends the drawable pieces of one curve to `out`, splitting only at physical discontinuities.
function pushSplitDisconnectedPolylines(out: GeoCurve, points: GeoBranch, maxGap: Angle) {
	if (points.length === 0) return

	let current: GeoBranch = [points[0]]

	for (let i = 1; i < points.length; i++) {
		if (angularDistance(points[i - 1], points[i]) > maxGap) {
			if (current.length > 1) out.push(current)
			current = []
		}

		current.push(points[i])
	}

	if (current.length > 1) out.push(current)
}

// Splits every branch into drawable pieces without allocating a callback result per branch.
function splitCurveBranches(branches: readonly GeoBranch[], maxGap: Angle) {
	const pieces: GeoCurve = []
	for (const branch of branches) pushSplitDisconnectedPolylines(pieces, branch, maxGap)
	return pieces
}

// Splits a curve into separate polylines at genuine discontinuities: wherever two consecutive points
// are farther apart than maxGap the curve has left the sunlit hemisphere (or the solver family is
// physically disconnected there), so the pieces must not be joined by a straight chord. Pieces with
// fewer than two points are dropped as undrawable.
export function splitDisconnectedPolylines(points: GeoBranch, maxGap: Angle) {
	const pieces: GeoCurve = []
	pushSplitDisconnectedPolylines(pieces, points, maxGap)
	return pieces
}

// Splits a polar/circumpolar limit at its largest absolute latitude, a two-piece
// rendering of a limit that folds back over itself near a pole.
export function splitAtMaxAbsLatitude(points: GeoBranch) {
	if (points.length <= 2) return [points.slice()]

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
	if (index <= 0 || index >= points.length - 1) return [points.slice()]

	// Share the apex point between both branches so they meet without a visible gap.
	return [points.slice(0, index + 1), points.slice(index)]
}

// Splits each branch at its latitude apex without allocating a callback fan-out pass.
function splitBranchesAtMaxAbsLatitude(branches: GeoCurve) {
	const out: GeoCurve = []
	for (const branch of branches) {
		for (const piece of splitAtMaxAbsLatitude(branch)) out.push(piece)
	}
	return out
}

function reconnectSplitCurveCusps(branches: GeoCurve, pbe: PolynomialBesselianElements, i: -1 | 0 | 1, G: number, maxAngularStep: Angle, refractionMode: RefractionMode) {
	const maxDrawableGap = Math.max(BRANCH_MAX_DRAWABLE_GAP, maxAngularStep * CURVE_GAP_SPLIT_FACTOR)
	const reconnected = reconnectBranchCusps(deduplicateBranches(branches, maxAngularStep), pbe, i, G, maxAngularStep, maxDrawableGap, refractionMode, false)
	const pieces = splitCurveBranches(reconnected, maxDrawableGap)
	const trimmed = trimRetracedBranchEnds(pieces, maxAngularStep, maxDrawableGap)
	// Trimming a retrace loop exposes a branch's true cusp endpoint, which can now be bridgeable to the
	// neighbour it was buried behind during the reconnection above (e.g. the near-pole 0994-02-18 grazing
	// annular umbra, whose two G = 1 arcs join through a continuous curve only after the winding loop on one
	// arc is trimmed). Reconnect once more, then split and trim again so an exposed-but-unbridged gap is
	// closed without re-introducing a loop. Mirrors the post-trim reconnection in findCurveBranchPoints.
	const reconnectedTrimmed = reconnectBranchCusps(deduplicateBranches(trimmed, maxAngularStep), pbe, i, G, maxAngularStep, maxDrawableGap, refractionMode, false)
	const finalPieces = splitCurveBranches(reconnectedTrimmed, maxDrawableGap)
	return deduplicateBranches(trimRetracedBranchEnds(finalPieces, maxAngularStep, maxDrawableGap), maxAngularStep)
}

// Nearest curve sample to a point across every branch, with its angular distance. Unlike a capped search
// the caller decides acceptance, so a spatially distant but temporally matching grazing cusp can still be
// taken (see alignUmbralContactPoints).
function nearestCurveSample(point: GeoPoint, branches: readonly GeoBranch[], out: { sample: GeoPoint; distance: number }) {
	let best: GeoPoint | undefined
	let bestDistance = Infinity

	for (const branch of branches) {
		for (const sample of branch) {
			const distance = angularDistance(point, sample)

			if (distance < bestDistance) {
				best = sample
				bestDistance = distance
			}
		}
	}

	if (best !== undefined) {
		out.sample = best
		out.distance = bestDistance
		return out
	}

	return undefined
}

const UMBRA_CONTACT_POINTS = ['U1', 'U2', 'U3', 'U4'] as const

// Branch endpoint nearest in time to a contact, within timeTolerance (days), or undefined when none is.
// U1..U4 mark terminator cusps that coincide with umbra-limit branch endpoints, so when the grazing-limb
// geometry makes spatial distance unreliable the cusp is identified by endpoint time. Considers only the two
// endpoints of each branch, since an interior sample at a coincidentally close time is not the cusp.
function nearestEndpointByTime(point: GeoPoint, branches: readonly GeoBranch[], timeTolerance: number) {
	if (point.jd === undefined) return undefined

	let best: GeoPoint | undefined
	let bestDelta = timeTolerance

	for (const branch of branches) {
		if (branch.length === 0) continue

		for (const sample of [branch[0], branch.at(-1)!]) {
			if (sample.jd === undefined) continue
			const delta = Math.abs(sample.jd - point.jd)
			if (delta < bestDelta) {
				best = sample
				bestDelta = delta
			}
		}
	}

	return best
}

// Snaps the informational U1..U4 markers onto the drawn (refracted) umbra-limit family so they sit on the
// curve rather than at their unrefracted geometric position. A contact is snapped to the nearest curve
// sample when that sample is spatially close; otherwise, near a grazing limb where the refracted curve runs
// almost tangent to the limb, it is snapped to the branch endpoint nearest in time. The temporally nearest
// cusp can be several degrees away and need not be the spatially nearest sample (another branch's flank may
// pass marginally closer), so the time match is required, not just probed on the spatial pick. jd is preserved.
function alignUmbralContactPoints(points: Writable<SolarEclipseContactPoints>, branches: readonly GeoBranch[], maxAngularStep: Angle) {
	const spatialLimit = maxAngularStep * CURVE_GAP_SPLIT_FACTOR
	const best: Parameters<typeof nearestCurveSample>[2] = { sample: undefined as never, distance: 0 }

	for (const key of UMBRA_CONTACT_POINTS) {
		const point = points[key]
		if (!point) continue

		const nearest = nearestCurveSample(point, branches, best)
		if (nearest && nearest.distance <= spatialLimit) {
			points[key] = { x: nearest.sample.x, y: nearest.sample.y, jd: point.jd }
			continue
		}

		const cusp = nearestEndpointByTime(point, branches, UMBRAL_CONTACT_TIME_TOLERANCE_DAYS)
		if (cusp) points[key] = { x: cusp.x, y: cusp.y, jd: point.jd }
	}
}

// E. RISE/SET CURVES

// Maximum recursion depth when subdividing a rise/set step in time to trace the true curve.
const RISE_SET_REFINE_MAX_DEPTH = 10

// One sampled instant of a rise/set phase: every limb crossing of the penumbra circle at that Julian Day,
// ordered by descending fundamental-plane y. A circle and the Earth-limb ellipse can meet in up to four
// points, so the crossings are kept as a list instead of a fixed upper/lower pair.
interface RiseSetSample {
	readonly jd: number
	readonly crossings: GeoBranch
}

// One traced rise/set branch: a continuous run of limb crossings with the last appended point cached for
// the nearest-neighbour continuity match against the next sample's crossings.
interface RiseSetBranch {
	points: GeoBranch
	last: GeoPoint
}

// Finds the intersections of the Earth unit circle with a circle of the given radius centered at
// (cx, cy) in the fundamental plane, ordered by descending y. Returns two points, one tangency
// point, or none. All outputs lie on the unit circle, ready for projectFundamentalPoint.
export function findCircleIntersections(cx: number, cy: number, radius: number) {
	const dSquared = cx * cx + cy * cy

	if (!Number.isFinite(dSquared) || !(dSquared > 0) || !Number.isFinite(radius) || radius < 0) return []

	const d = Math.sqrt(dSquared)
	// Distance from the origin to the chord of intersection, along the center direction.
	const a = (dSquared + 1 - radius * radius) / (2 * d)
	const hSquared = 1 - a * a

	// A numerically grazing intersection can leave hSquared slightly negative; treat it as tangency
	// instead of rejecting the contact.
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
// the unit circle, so the oblique projection of the ellipsoid is honored.
function riseSetCrossings(pbe: PolynomialBesselianElements, jd: number) {
	const be = besselianSampleAtJulianDay(pbe, jd)
	const crossings = earthLimbCircleIntersections(be.x, be.y, earthLimbOmega(be.d), Math.abs(be.l1))
	const points: GeoBranch = []

	for (const crossing of crossings) {
		const point = projectFundamentalPoint(be, crossing[0], crossing[1])
		if (finitePoint(point)) points.push(point)
	}

	return points
}

function isGeoPoint(point?: Point | GeoPoint): point is GeoPoint {
	return finitePoint(point) && point.jd !== undefined
}

function RiseSetBranchComparatorByHigherLatitude(a: RiseSetBranch, b: RiseSetBranch) {
	return b.points[0].y - a.points[0].y
}

// Computes sunrise and sunset eclipse curves from where the penumbra edge crosses the Earth's limb.
// The penumbra meets the limb in two phases — around sunrise (P1->P2) and sunset (P3->P4) — separated
// by the interval where it lies wholly on the day side (P2->P3, no horizon crossing). Each phase is split
// at the day-side gap, its variable set of crossings (0..4) is tracked into continuity branches, and each
// branch is anchored to the P1/P2/P3/P4 contacts so it passes through them. Fast-moving stretches near the
// cusps are densified by subdividing in time so the curve follows the geometry rather than a straight chord.
export function computeRiseSetCurves(pbe: PolynomialBesselianElements, P1: GeoPoint, P4: GeoPoint, optionalContacts: Pick<SolarEclipseContactPoints, 'P2' | 'P3' | 'N1' | 'N2' | 'S1' | 'S2'> = {}, options?: SolarEclipseRiseSetCurveOptions) {
	if (P1.jd === undefined || P4.jd === undefined || P4.jd < P1.jd) return []

	const stepDays = validStep(options?.step, DEFAULT_RISE_SET_STEP_SECONDS) / DAYSEC
	const adaptive = options?.adaptive ?? true
	const contacts: GeoBranch = []
	if (isGeoPoint(P1)) contacts.push(P1)
	if (isGeoPoint(optionalContacts.P2)) contacts.push(optionalContacts.P2)
	if (isGeoPoint(optionalContacts.P3)) contacts.push(optionalContacts.P3)
	if (isGeoPoint(P4)) contacts.push(P4)

	// Split the P1..P4 span into phases: maximal runs of sampled instants where the penumbra circle meets
	// the limb at all. The day-side gap P2..P3, where the penumbra lies wholly on Earth, yields no crossing
	// and separates the sunrise phase from the sunset phase.
	const phases: RiseSetSample[][] = []
	let current: RiseSetSample[] | undefined

	// Force the phase break across the known internal-contact interval [P2, P3] even when no sample lands in
	// it: for a near-threshold hybrid that gap can be shorter than the sampling step (the 5309-10-09 gap is
	// ~6.5 min under a 10 min step), so the no-crossing test alone never splits the phases. Left merged, the
	// sunrise and sunset tracks join through one coarse step that jumps across the cusp, and P2/P3 (the
	// tangency cusps on the rise/set locus) are neither branch endpoints nor close enough to a sample to be
	// inserted, so they end up detached from the drawn curve. Breaking here makes the sunrise phase end at P2
	// and the sunset phase begin at P3, which anchorRiseSetBranch then bends the curve into.
	const gapStartJd = optionalContacts.P2?.jd
	const gapEndJd = optionalContacts.P3?.jd
	let previousSampleJd: number | undefined

	for (let jd = P1.jd; jd <= P4.jd + stepDays * 0.5; jd += stepDays) {
		const sampleJd = Math.min(jd, P4.jd)
		const crossings = riseSetCrossings(pbe, sampleJd)

		if (crossings.length === 0) {
			current = undefined
			previousSampleJd = sampleJd
			continue
		}

		// A step that jumps over the whole [P2, P3] day-side gap (previous sample at/before P2, this one
		// at/after P3) closes the sunrise phase so the sunset phase reopens at P3.
		if (gapStartJd !== undefined && gapEndJd !== undefined && previousSampleJd !== undefined && previousSampleJd <= gapStartJd + CURVE_TIME_EPSILON_DAYS && sampleJd >= gapEndJd - CURVE_TIME_EPSILON_DAYS) {
			current = undefined
		}

		if (!current) {
			current = []
			phases.push(current)
		}

		current.push({ jd: sampleJd, crossings })
		previousSampleJd = sampleJd
	}

	// The tangency cusp bounding a phase falls within one sampling step of the phase's last crossing, so
	// match cusps to contacts by time (near the tangent the crossings can still be far apart in space).
	const snapJd = 2 * stepDays
	const curves: GeoCurve = []

	for (const phase of phases) {
		const branches = traceRiseSetBranches(pbe, phase, adaptive)
		// Emit upper branches (higher fundamental-plane latitude) first, preserving the previous
		// upper-before-lower ordering for the common two-crossing phase.
		branches.sort(RiseSetBranchComparatorByHigherLatitude)

		for (const branch of branches) {
			const start = nearestContactByJd(branch.points[0].jd, contacts, snapJd, -1)
			const end = nearestContactByJd(branch.points.at(-1)!.jd, contacts, snapJd, 1)
			const curve = anchorRiseSetBranch(pbe, branch.points, start, end, adaptive)
			if (curve.length > 1) curves.push(curve)
		}
	}

	const withCusps = insertRiseSetCuspPoints(curves, [optionalContacts.N1, optionalContacts.N2, optionalContacts.S1, optionalContacts.S2])
	return splitCurveBranches(withCusps, BRANCH_MAX_DRAWABLE_GAP)
}

// Keeps only drawable rise/set branches, matching the previous final filter without an extra pass.
function pushDrawableRiseSetBranch(out: RiseSetBranch[], branch: RiseSetBranch) {
	if (branch.points.length >= 2) out.push(branch)
}

// Tracks the variable set of limb crossings of one phase into continuity branches. Each sample's crossings
// are matched to the active branches by nearest fundamental-plane neighbour (greedy, since at most four
// crossings exist); unmatched crossings open new branches and unmatched branches close. This supports the
// 0..4 crossings a circle and the limb ellipse can have, instead of assuming a fixed upper/lower pair.
function traceRiseSetBranches(pbe: PolynomialBesselianElements, phase: readonly RiseSetSample[], adaptive: boolean) {
	const active: RiseSetBranch[] = []
	const completed: RiseSetBranch[] = []

	for (const crossing of phase[0].crossings) active.push({ points: [crossing], last: crossing })

	for (let s = 1; s < phase.length; s++) {
		const { jd, crossings } = phase[s]
		let matchedBranchMask = 0
		let matchedCrossingMask = 0

		// Greedy minimum-cost assignment without allocating pair objects or sorting: repeatedly take the
		// cheapest unmatched branch/crossing pair. This yields the same assignment as sorting all pairs by
		// cost and skipping reused ones; with <= 4 crossings it matches an exact optimum in practice.
		const matchCount = Math.min(active.length, crossings.length)
		for (let m = 0; m < matchCount; m++) {
			let bestBranch = -1
			let bestCrossing = -1
			let bestCost = Infinity

			for (let b = 0; b < active.length; b++) {
				if ((matchedBranchMask & (1 << b)) !== 0) continue
				for (let c = 0; c < crossings.length; c++) {
					if ((matchedCrossingMask & (1 << c)) !== 0) continue
					const cost = angularDistance(active[b].last, crossings[c])
					if (cost < bestCost) {
						bestCost = cost
						bestBranch = b
						bestCrossing = c
					}
				}
			}

			if (bestBranch < 0) break

			matchedBranchMask |= 1 << bestBranch
			matchedCrossingMask |= 1 << bestCrossing
			const branch = active[bestBranch]
			const crossing = crossings[bestCrossing]
			if (adaptive) refineRiseSetBranchGap(pbe, branch.last.jd!, branch.last, jd, crossing, branch.points, 0)
			pushDistinct(branch.points, crossing)
			branch.last = crossing
		}

		// Close branches with no crossing this step, then open a branch for every unmatched crossing.
		for (let b = active.length - 1; b >= 0; b--) {
			if ((matchedBranchMask & (1 << b)) === 0) {
				pushDrawableRiseSetBranch(completed, active[b])
				active.splice(b, 1)
			}
		}
		for (let c = 0; c < crossings.length; c++) {
			if ((matchedCrossingMask & (1 << c)) === 0) active.push({ points: [crossings[c]], last: crossings[c] })
		}
	}

	for (const branch of active) pushDrawableRiseSetBranch(completed, branch)
	return completed
}

// Prepends and appends the phase's tangency-cusp contacts to a traced branch, densifying the cusp
// approaches in time so the branch bends into the contacts rather than jumping in a straight chord.
function anchorRiseSetBranch(pbe: PolynomialBesselianElements, points: GeoBranch, start: GeoPoint | undefined, end: GeoPoint | undefined, adaptive: boolean) {
	const out: GeoBranch = []

	if (start) {
		out.push(start)
		if (adaptive) refineRiseSetBranchGap(pbe, start.jd!, start, points[0].jd!, points[0], out, 0)
	}

	for (const point of points) pushDistinct(out, point)

	if (end) {
		if (adaptive) refineRiseSetBranchGap(pbe, points.at(-1)!.jd!, points.at(-1)!, end.jd!, end, out, 0)
		pushDistinct(out, end)
	}

	return out
}

// Recursively inserts true limb crossings between two consecutive points of one branch while the step
// exceeds the angular limit, so the curve bends smoothly into the cusps instead of jumping in a straight
// line. At each midpoint the crossing nearest the great-circle-interpolated target stays on the branch.
function refineRiseSetBranchGap(pbe: PolynomialBesselianElements, jdA: number, aPoint: GeoPoint, jdB: number, bPoint: GeoPoint, out: GeoBranch, depth: number) {
	if (depth >= RISE_SET_REFINE_MAX_DEPTH || !(angularDistance(aPoint, bPoint) > DEFAULT_MAX_ANGULAR_STEP)) return

	const jd = (jdA + jdB) * 0.5
	const crossings = riseSetCrossings(pbe, jd)
	if (crossings.length === 0) return

	const target = interpolateGreatCirclePoint(aPoint, bPoint, 0.5)
	let mid = crossings[0]
	let bestCost = angularDistance(target, mid)

	for (let c = 1; c < crossings.length; c++) {
		const cost = angularDistance(target, crossings[c])
		if (cost < bestCost) {
			bestCost = cost
			mid = crossings[c]
		}
	}

	refineRiseSetBranchGap(pbe, jdA, aPoint, jd, mid, out, depth + 1)
	pushDistinct(out, mid)
	refineRiseSetBranchGap(pbe, jd, mid, jdB, bPoint, out, depth + 1)
}

// Nearest contact in time to a branch endpoint, within toleranceJd. direction pins which side of the
// endpoint the contact must lie on so the anchored curve stays chronological: -1 for a phase start (the
// contact is at or before the branch's first sample), +1 for a phase end (at or after the last sample), 0
// for either side. A tiny CURVE_TIME_EPSILON_DAYS slack admits a bounding cusp that sits a hair past the
// endpoint. Without the direction guard a single-sample phase (a very short grazing partial) can snap both
// its start and end to the same contact whichever is nearest, drawing a backward then forward spike (e.g.
// the 2893-12-29 partial, whose lone sunset crossing is closest to P4, so P4 was used as the start too).
function nearestContactByJd(jd: number | undefined, contacts: GeoBranch, toleranceJd: number, direction: -1 | 0 | 1 = 0) {
	if (jd === undefined) return undefined

	let best: GeoPoint | undefined
	let bestDelta = toleranceJd

	for (const contact of contacts) {
		const signed = contact.jd! - jd
		if (direction < 0 && signed > CURVE_TIME_EPSILON_DAYS) continue
		if (direction > 0 && signed < -CURVE_TIME_EPSILON_DAYS) continue

		const delta = Math.abs(signed)
		if (delta < bestDelta) {
			bestDelta = delta
			best = contact
		}
	}

	return best
}

const RISE_SET_CUSP_INSERT_MAX_GAP = DEFAULT_MAX_ANGULAR_STEP * CURVE_GAP_SPLIT_FACTOR

// Maximum detour (radians) a cusp insertion may add to a rise/set curve. A penumbral-limit terminator cusp
// lies on the rise/set locus where that locus is correctly traced, so a genuine insertion barely bends the
// curve (the detour is near zero). A large detour means the cusp is the OTHER limb crossing at that instant
// — an upper track the branch tracer did not follow — so splicing it in would draw a spurious triangular
// spike from the curve up to the cusp. Such an insertion is rejected; the cusp remains a marker only.
const RISE_SET_CUSP_MAX_DETOUR = DEFAULT_MAX_ANGULAR_STEP

function insertRiseSetCuspPoints(curves: GeoCurve, cusps: readonly (GeoPoint | undefined)[]) {
	const out: GeoCurve = []
	for (const curve of curves) out.push(curve.slice())

	for (const cusp of cusps) {
		if (cusp?.jd === undefined) continue

		let bestCurve = -1
		let bestIndex = -1
		let bestCost = Infinity

		for (let c = 0; c < out.length; c++) {
			const curve = out[c]
			for (let i = 1; i < curve.length; i++) {
				const a = curve[i - 1]
				const b = curve[i]
				if (a.jd === undefined || b.jd === undefined || cusp.jd < a.jd - CURVE_TIME_EPSILON_DAYS || cusp.jd > b.jd + CURVE_TIME_EPSILON_DAYS) continue

				const da = angularDistance(a, cusp)
				const db = angularDistance(cusp, b)
				if (da > RISE_SET_CUSP_INSERT_MAX_GAP || db > RISE_SET_CUSP_INSERT_MAX_GAP) continue

				const cost = da + db - angularDistance(a, b)
				if (cost < bestCost) {
					bestCost = cost
					bestCurve = c
					bestIndex = i
				}
			}
		}

		// Reject an off-curve cusp whose insertion would spike the rise/set curve toward a point it does not pass through.
		if (bestCurve < 0 || bestCost > RISE_SET_CUSP_MAX_DETOUR) continue

		const curve = out[bestCurve]
		// Slide to the jd-sorted slot before splicing. The +-CURVE_TIME_EPSILON_DAYS slack in the segment test
		// can select a slot where the cusp is a fraction of CURVE_TIME_EPSILON_DAYS out of order with the traced
		// sample nearest it (the same instant, a sampling step apart in space): splicing there would make the
		// rise/set curve step backward in time. Sliding keeps the polyline chronological without moving any point.
		let index = bestIndex
		while (index < curve.length && curve[index].jd! < cusp.jd) index++
		while (index > 0 && curve[index - 1].jd! > cusp.jd) index--
		const before = index > 0 ? curve[index - 1] : undefined
		const after = index < curve.length ? curve[index] : undefined
		if ((!before || !samePoint(before, cusp)) && (!after || !samePoint(after, cusp))) curve.splice(index, 0, cusp)
	}

	return out
}

// F. PUBLIC ASSEMBLY

// Local umbral-radius residual on the central line at one instant: l2 - zeta * tanF2, where zeta is the
// surface point's distance from the fundamental plane along the axis, recovered from the flattened limb.
// Negative means the umbral cone vertex lies beyond the surface (total), non-negative means annular.
function centralLineKindResidual(pbe: PolynomialBesselianElements, jd: number) {
	const be = besselianSampleAtJulianDay(pbe, jd)
	const y1 = earthLimbOmega(be.d) * be.y
	const zeta = Math.sqrt(Math.max(0, 1 - be.x * be.x - y1 * y1))
	return be.l2 - zeta * be.tanF2
}

// Local eclipse character on the central line at one instant: total where the local umbral radius is
// negative, annular otherwise.
export function centralLineKind(pbe: PolynomialBesselianElements, jd: number) {
	return centralLineKindResidual(pbe, jd) < 0 ? 'total' : 'annular'
}

// Resolves the exact total<->annular transition instant between two bracketing central-line samples (where
// the local umbral radius crosses zero) and projects the shadow axis there, giving the precise crossover
// point on the central line.
function solveCentralLineTransition(pbe: PolynomialBesselianElements, jdA: number, jdB: number) {
	const f = (jd: number) => centralLineKindResidual(pbe, jd)
	const root = refineRoot(f, jdA, jdB)
	return root === undefined ? undefined : projectCentralAxisPoint(pbe, root)
}

// A kind-tagged central line split into its total and annular sub-polylines. centerLine stays flat for
// compatibility; this is the per-character view of a hybrid eclipse, whose central line alternates total <-> annular.
export interface CentralLineByKind {
	// Total-eclipse sub-polylines of the central line, in chronological order.
	readonly total: GeoCurve
	// Annular-eclipse sub-polylines of the central line, in chronological order.
	readonly annular: GeoCurve
}

// Keeps only drawable central-line segments, matching the previous final filter without an extra pass.
function pushDrawableSegment(out: GeoCurve, segment: GeoBranch) {
	if (segment.length >= 2) out.push(segment)
}

// Splits a kind-tagged central line into total and annular sub-polylines so a hybrid eclipse can be drawn
// per character. Each maximal run of consecutive points sharing a kind becomes one homogeneous segment, so
// every point of a returned segment carries that segment's kind. Untagged points (no jd, so no kind) are
// skipped, and runs shorter than two points (undrawable) are dropped. When pbe is given, the exact
// total<->annular crossover (where the local umbral radius is zero) is root-solved between the two
// bracketing samples and inserted as a shared seam, so the total and annular segments meet without a gap;
// each side gets its own copy tagged with that side's kind to keep segments homogeneous.
export function splitCentralLineByKind(centerLine: GeoBranch, pbe?: PolynomialBesselianElements): CentralLineByKind {
	const total: GeoCurve = []
	const annular: GeoCurve = []
	let current: GeoBranch | undefined
	let currentKind: HybridEclipseKind | undefined
	let previous: GeoPoint | undefined

	for (const point of centerLine) {
		const kind = point.kind
		if (kind === undefined) continue

		if (kind !== currentKind) {
			// Resolve the exact crossover between the previous (other-kind) sample and this one, sharing it
			// as the seam point that closes the prior segment and opens the new one.
			const seam = pbe && current && previous?.jd !== undefined && point.jd !== undefined ? solveCentralLineTransition(pbe, previous.jd, point.jd) : undefined
			if (seam && currentKind !== undefined) current!.push({ x: seam.x, y: seam.y, jd: seam.jd, kind: currentKind })

			current = []
			if (seam) current.push({ x: seam.x, y: seam.y, jd: seam.jd, kind })
			current.push(point)
			;(kind === 'total' ? total : annular).push(current)
			currentKind = kind
		} else {
			current!.push(point)
		}

		previous = point
	}

	const drawableTotal: GeoCurve = []
	const drawableAnnular: GeoCurve = []
	for (const segment of total) pushDrawableSegment(drawableTotal, segment)
	for (const segment of annular) pushDrawableSegment(drawableAnnular, segment)
	return { total: drawableTotal, annular: drawableAnnular }
}

// Computes serializable geographic geometry for a solar eclipse map. Every curve family comes from
// findEclipseCurvePoint via findCurvePoints. The umbra/antumbra limits exist for every non-partial
// eclipse (including non-central total/annular ones whose axis misses the Earth), while the central
// line and its C1/C2 endpoints exist only when the shadow axis actually pierces the ellipsoid. The
// penumbra limits exist for every eclipse.
export function computeSolarEclipseMapGeometry(eclipse: SolarEclipse, pbe: PolynomialBesselianElements, options?: SolarEclipseMapGeometryOptions): SolarEclipseMapGeometry {
	const contacts = findPenumbraContactPoints(pbe)
	const points: Writable<SolarEclipseContactPoints> = { ...contacts, Max: findMaximumPoint(pbe) }
	const longitudeStep = validStep(options?.longitudeStep, DEFAULT_LONGITUDE_STEP)
	const maxAngularStep = validStep(options?.maxAngularStep, DEFAULT_MAX_ANGULAR_STEP)
	const refractionMode = options?.refractionMode ?? DEFAULT_REFRACTION_MODE
	const curveOptions: SolarEclipseCurveOptions = { longitudeStep, maxAngularStep, refractionMode }

	let centerLine: GeoBranch = []
	let umbraNorth: GeoCurve = []
	let umbraSouth: GeoCurve = []

	// Whether the umbra/antumbra touches Earth at all, and whether the shadow axis truly intersects the
	// ellipsoid (the latter is the real geometric test that replaces the former gamma threshold).
	const hasUmbralLimits = eclipse.type !== 'partial'
	const hasCentralLine = hasUmbralLimits && centralAxisIntersectsEarth(pbe)

	if (hasUmbralLimits) {
		// The umbral/antumbral cone tangency contacts exist whenever the umbra reaches Earth; they are
		// informational markers and never control the umbra-limit polylines. The G = 1 limits are traced
		// for every non-partial eclipse, even non-central ones with no central line.
		Object.assign(points, findUmbraContactPoints(pbe))
		// Each G = 1 branch is a continuity arc; split only at its latitude apex so a polar fold renders as
		// two sub-polylines that meet at the apex. Branches are never joined across a discontinuity.
		umbraNorth = reconnectSplitCurveCusps(splitBranchesAtMaxAbsLatitude(findCurveBranchPoints(pbe, 1, 1, curveOptions)), pbe, 1, 1, maxAngularStep, refractionMode)
		umbraSouth = reconnectSplitCurveCusps(splitBranchesAtMaxAbsLatitude(findCurveBranchPoints(pbe, -1, 1, curveOptions)), pbe, -1, 1, maxAngularStep, refractionMode)
		const umbraBranches: GeoCurve = []
		for (const branch of umbraNorth) umbraBranches.push(branch)
		for (const branch of umbraSouth) umbraBranches.push(branch)
		alignUmbralContactPoints(points, umbraBranches, maxAngularStep)
	}

	if (hasCentralLine) {
		const C1 = findCentralLineExtremePoint(pbe, true)
		const C2 = findCentralLineExtremePoint(pbe, false)
		if (C1) points.C1 = C1
		if (C2) points.C2 = C2

		const line = assembleCenterLine(pbe, C1, C2, findCurvePoints(pbe, 0, 0, curveOptions), maxAngularStep, refractionMode)
		// Tag each central-line point with its local total/annular character so a hybrid eclipse's
		// transition is recoverable from the geometry.
		const taggedCenterLine: GeoBranch = []
		for (const point of line) taggedCenterLine.push(point.jd === undefined ? point : { x: point.x, y: point.y, jd: point.jd, kind: centralLineKind(pbe, point.jd) })
		centerLine = taggedCenterLine
	}

	// Partial-eclipse (penumbra) north/south limits: the day-side curves where the penumbral cone
	// grazes the surface (magnitude 0), bounding the region where any partial eclipse is seen. Kept as
	// continuity branches so a near-pole fold is never bridged by a spike.
	const penumbraNorth = findCurveBranchPoints(pbe, 1, 0, curveOptions)
	const penumbraSouth = findCurveBranchPoints(pbe, -1, 0, curveOptions)

	// Expose the penumbral-limit extremes as named, informational points, always the limits' terminator
	// cusps ordered chronologically. The cusps are found over all branch points flattened (label naming is
	// chronological and independent of the branch draw order). When both penumbral limits reach Earth, each
	// contributes its two cusps (N1/S1 begin, N2/S2 end). When only one limit reaches Earth (a grazing
	// partial), that single limit carries the eclipse's two extremes, again chronological: N1 is the earlier
	// cusp, S1 the later one, matching the EclipseWise convention (not a poleward/equatorward rule). They
	// never control the curve geometry.
	const hasNorthPenumbraLimit = penumbraNorth.length > 0
	const hasSouthPenumbraLimit = penumbraSouth.length > 0
	if (hasNorthPenumbraLimit && hasSouthPenumbraLimit) {
		;[points.N1, points.N2] = penumbralLimitEndpointsByTime(pbe, penumbraNorth.flat())
		;[points.S1, points.S2] = penumbralLimitEndpointsByTime(pbe, penumbraSouth.flat())
	} else if (hasNorthPenumbraLimit || hasSouthPenumbraLimit) {
		// A grazing partial with a single penumbral limit: its two terminator cusps are named
		// chronologically (N1 begins, S1 ends), matching EclipseWise. This is NOT a poleward/equatorward
		// rule: for 2003-05-31 both cusps are in the northern hemisphere and the equatorward one (N1)
		// comes first in time, so a latitude-based label would swap them.
		const limit = (hasNorthPenumbraLimit ? penumbraNorth : penumbraSouth).flat()
		;[points.N1, points.S1] = penumbralLimitEndpointsByTime(pbe, limit)
	}

	const riseSetCurves = (options?.includeRiseSetCurves ?? false) && points.P1 && points.P4 ? computeRiseSetCurves(pbe, points.P1, points.P4, points, { step: options?.riseSetStep }) : []

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
function assembleCenterLine(pbe: PolynomialBesselianElements, C1: GeoPoint | undefined, C2: GeoPoint | undefined, scan: GeoBranch, maxAngularStep: Angle, refractionMode: RefractionMode = DEFAULT_REFRACTION_MODE) {
	const interior: GeoBranch = []
	for (const point of scan) if (isCenterLineInteriorPoint(point, C1, C2)) interior.push(point)
	const assembled: GeoBranch = []

	if (C1 && interior.length > 0) {
		const head: GeoBranch = []
		appendRefinedSegment(head, pbe, C1, interior[0], 0, 0, maxAngularStep, refractionMode)
		for (const p of head) if (isCenterLineInteriorPoint(p, C1, C2)) assembled.push(p)
	}

	for (const p of interior) assembled.push(p)

	if (C2 && interior.length > 0) {
		const tail: GeoBranch = []
		appendRefinedSegment(tail, pbe, interior.at(-1)!, C2, 0, 0, maxAngularStep, refractionMode)
		for (const p of tail) if (isCenterLineInteriorPoint(p, C1, C2)) assembled.push(p)
	}

	const ordered = orderCurvePoints(deduplicatePoints(assembled))
	if (C1) ordered.unshift(C1)
	if (C2) ordered.push(C2)
	return deduplicatePoints(ordered)
}

// Whether a scanned central-line point belongs strictly between the solved C1/C2 endpoint instants.
function isCenterLineInteriorPoint(point: GeoPoint, C1: GeoPoint | undefined, C2: GeoPoint | undefined) {
	return point.jd !== undefined && (C1?.jd === undefined || point.jd > C1.jd + CURVE_TIME_EPSILON_DAYS) && (C2?.jd === undefined || point.jd < C2.jd - CURVE_TIME_EPSILON_DAYS)
}

// Geometric solar altitude (radians) of an observer at a limit point at its own instant. The two named
// extremes of a grazing penumbral limit are its terminator cusps, where this drops to ~0.
export function solarAltitudeAtPoint(pbe: PolynomialBesselianElements, point: GeoPoint) {
	const be = besselianSampleAtJulianDay(pbe, point.jd!)
	const H = hourAngleFromLongitude(point.x, be.mu, be.deltaTLongitudeCorrection)
	const sinh = Math.sin(be.d) * Math.sin(point.y) + Math.cos(be.d) * Math.cos(point.y) * Math.cos(H)
	return Math.asin(clamp(sinh, -1, 1))
}

// Minimum spatial separation (radians) required between the two named cusps of a single penumbral
// limit, so both end up on different terminator cusps rather than two samples of the same one.
const PENUMBRAL_CUSP_MIN_SEPARATION = 5 * DEG2RAD

// The two terminator cusps of a single grazing penumbral limit: the points where the limit meets the
// horizon (lowest solar altitude). This is robust against the curve solver returning the points in
// Julian-Day order, which can interleave two spatial branches near a fold and bury a cusp in the middle
// of the array (so the raw first/last endpoints are not the cusps).
function penumbralLimitCusps(pbe: PolynomialBesselianElements, curve: GeoBranch) {
	if (curve.length <= 2) return [curve[0], curve.at(-1)!]

	// Compute each point's altitude once, then take the two cusps by two linear scans instead of a full
	// sort: the lowest-altitude point, then the lowest-altitude point at least PENUMBRAL_CUSP_MIN_SEPARATION
	// away from it. This is the same result as sorting by altitude and taking the first separated pair.
	const altitudes = new Float64Array(curve.length)
	for (let k = 0; k < curve.length; k++) altitudes[k] = solarAltitudeAtPoint(pbe, curve[k])
	let firstIndex = 0
	for (let k = 1; k < curve.length; k++) {
		if (altitudes[k] < altitudes[firstIndex]) firstIndex = k
	}

	const first = curve[firstIndex]
	let second: GeoPoint | undefined
	let secondAltitude = Infinity

	for (let k = 0; k < curve.length; k++) {
		if (altitudes[k] < secondAltitude && sphericalSeparation(first.x, first.y, curve[k].x, curve[k].y) > PENUMBRAL_CUSP_MIN_SEPARATION) {
			secondAltitude = altitudes[k]
			second = curve[k]
		}
	}

	// Fall back to the chronological endpoints if the curve never folds into two separated cusps.
	return second ? [first, second] : [curve[0], curve.at(-1)!]
}

// The two terminator cusps of a penumbral limit ordered by ascending time (earliest first), falling
// back to ascending latitude when either lacks a Julian Day. The penumbral-limit extremes are named by
// the eclipse chronology (N1/S1 begin, N2/S2 end), matching the EclipseWise/Espenak convention. Using
// the cusps rather than the raw array endpoints keeps the markers on the horizon even when the curve
// solver returns the limit's points jd-interleaved across a fold.
function penumbralLimitEndpointsByTime(pbe: PolynomialBesselianElements, curve: GeoBranch) {
	const [a, b] = penumbralLimitCusps(pbe, curve)
	if (a.jd !== undefined && b.jd !== undefined) return a.jd <= b.jd ? [a, b] : [b, a]
	return a.y <= b.y ? [a, b] : [b, a]
}

// Splits a geographic polyline into drawable antimeridian-safe segments.
export function splitPolylineAtAntimeridian(line: GeoBranch) {
	return splitGeoLineAtAntimeridian(line, false)
}

// Splits a geographic polygon ring into antimeridian-safe drawable rings.
export function splitPolygonAtAntimeridian(ring: GeoBranch) {
	return splitGeoLineAtAntimeridian(ring, true)
}

function splitGeoLineAtAntimeridian(line: GeoBranch, close: boolean) {
	if (line.length < 2) return []

	const segments: GeoCurve = []
	let current: GeoBranch = [line[0]]
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
			const joined: GeoBranch = []
			for (const point of lastSegment) joined.push(point)
			for (const point of firstSegment) joined.push(point)
			segments[0] = joined
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
		deltaT: deltaTByEspenakMeeus2006(year),
	}
}

// Serializes projected polyline or polygon pieces into an SVG path data string. Each piece becomes one
// subpath (M ... L ...); pieces with fewer than two points are skipped. When close is true each subpath
// is closed with Z, suitable for filled polygons.
export function pointsToSvgPathData(pieces: readonly (readonly Point[])[], close = false, precision = 2) {
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

// Splits one geographic line (or ring when close is true) at the antimeridian with the exact +-180
// crossing inserted, then projects each piece. Inserting the crossing keeps every piece reaching the map
// edge instead of stopping at the last sample before the wrap, which otherwise leaves a visible gap or
// angular "beak" near +-180. The 'pi'-mode projection preserves an exact +-PI seam vertex, so the post-wrap
// piece resumes on the left edge (-PI) rather than being folded back onto the right one (+PI). The split
// happens only here, at serialization time: the geographic geometry itself is never mutated.
function projectSplitPieces(geo: GeoBranch, close: boolean, projection: Projection, options: ProjectionPolylineOptions) {
	const pieces: Point[][] = []

	for (const segment of splitGeoLineAtAntimeridian(geo, close)) {
		let piece: Point[] = []

		for (const point of segment) {
			const projected = projection.project(point.x, point.y, undefined, options)
			if (projected === undefined) {
				if (piece.length >= 2) pieces.push(piece)
				piece = []
			} else {
				piece.push({ x: projected.x, y: projected.y })
			}
		}

		if (piece.length >= 2) pieces.push(piece)
	}

	return pieces
}

// Projects geographic polylines and serializes them into one SVG path data string of open subpaths,
// split at the antimeridian during projection only.
export function geoPolylinesToSvgPathData(lines: readonly GeoBranch[], projection: Projection, { precision = 2, ...options }: SolarEclipseMapSvgProjectionOptions = {}) {
	const pieces: Point[][] = []
	for (const line of lines) for (const piece of projectSplitPieces(line, false, projection, options)) pieces.push(piece)
	return pointsToSvgPathData(pieces, false, precision)
}

// Projects solar eclipse map geometry and serializes each polyline feature into SVG path data strings,
// aligned to the given projection. Antimeridian wraps are split into separate subpaths at projection time
// only; no synthetic connector is ever added. Each penumbra limit is a set of continuity branches, and every
// branch is serialized as its own subpath (M ... L ...): the end of one branch is never connected to the
// start of another, so a near-pole fold the solver could not trace through is drawn as separate arcs rather
// than a straight spike. The geometry itself is never mutated.
export function solarEclipseMapToSvgPaths(geometry: SolarEclipseMapGeometry, projection: Projection, options: SolarEclipseMapSvgProjectionOptions = {}): SolarEclipseMapSvgPaths {
	// Project named points with the same options as the curves, so points and lines stay aligned (P0.3).
	function projectPoint(point: GeoPoint | undefined) {
		return point ? projection.project(point.x, point.y, undefined, options) : undefined
	}

	const { points, lines } = geometry

	return {
		centerLine: geoPolylinesToSvgPathData([lines.centerLine], projection, options),
		umbraNorth: geoPolylinesToSvgPathData(lines.umbraNorth, projection, options),
		umbraSouth: geoPolylinesToSvgPathData(lines.umbraSouth, projection, options),
		penumbraNorth: geoPolylinesToSvgPathData(lines.penumbraNorth, projection, options),
		penumbraSouth: geoPolylinesToSvgPathData(lines.penumbraSouth, projection, options),
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
