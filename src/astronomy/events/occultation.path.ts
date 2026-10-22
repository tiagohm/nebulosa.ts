import { ANGVEL_PER_DAY, DAYSEC, ELLIPSOID_PARAMETERS, ONE_SECOND, PI, SPEED_OF_LIGHT_AU_DAY, TAU } from '../../core/constants'
import type { Mat2 } from '../../math/linear-algebra/mat2'
import { type Mat3, matClone, matMulVec, matRotZ, matTransposeMulVec } from '../../math/linear-algebra/mat3'
import { type MutVec3, type Vec3, vecCross, vecDot, vecLength, vecNormalizeMut, vecX, vecY, vecZ, vecZero } from '../../math/linear-algebra/vec3'
import { clamp } from '../../math/numerical/math'
import { type Angle, normalizePI } from '../../math/units/angle'
import type { Distance } from '../../math/units/distance'
import { type PositionAndVelocityOverTime, validateLightTimeIterations } from '../coordinates/astrometry'
import { eraGc2Gde, eraLd } from '../coordinates/erfa/erfa'
import { Ellipsoid } from '../observer/location'
import { gcrsToItrsRotationMatrix, type Time, timeConvert, timeShift, timeSubtract, tdb } from '../time/time'
import { searchIntervals, type TimeInterval } from './search'

// Global ground track of a stellar (or any point-source) occultation: the shadow that an occulting body
// casts from a point source onto the Earth reference ellipsoid, sampled over time as a geodetic centerline,
// two limit lines and an optional N-sigma uncertainty corridor. It complements occultationCandidates, which
// answers the per-site question, by solving where on Earth the event is visible.
//
// Geometry. All ephemerides are barycentric ICRS samplers (AU, AU/day) evaluated at TDB instants: the
// occulting `target`, the geocenter `earth` and, for a finite-distance source, `source`. A source given as a
// Vec3 is a direction at infinity (a star, with proper motion and parallax already folded in), which casts a
// cylinder of the body's radius; a source sampler is a point at finite distance, which casts a cone whose
// radius grows with the distance behind the body. The shadow is formed in BCRS: light emitted by the source
// grazes the body at the retarded emission epoch and reaches the Earth's fundamental plane (the plane through
// the geocenter perpendicular to the shadow axis) at the reception epoch t. Each snapshot is rotated into ITRS
// with the full GCRS -> ITRS matrix at t (precession-nutation from TT, sidereal angle from UT1 through the
// time's Earth-orientation providers, polar motion), and the axis, the limit lines and the corridor lines are
// intersected in closed form with the ellipsoid, optionally inflated by a uniform height. The intersection on
// the source-facing side is the ground point; a line that misses the ellipsoid has no ground point at t. The
// ray must also be causal, source -> body -> ground: a body downstream of the Earth (or a finite source between
// the Earth and the body) casts no shadow, and a ground point upstream of the body is not occulted.
//
// Modes. 'rigorous' (default) retards the body and a finite source by fixed-point light time, tilts the
// instantaneous shadow axis by the light-time aberration of the moving shadow (direction ~ s + v_body / c,
// worth up to ~0.5 km on the ground near the limb), varies the cone radius with depth, optionally applies the
// differential solar light deflection of source and body (when `sun` is given), and locates the limit lines
// on the true envelope of the moving shadow, using the shadow velocity relative to the rotating ground point.
// 'approximate' is the classical fundamental-plane construction: geocentric light time to the body, the
// source at the reception epoch, an untilted axis along the geocentric source direction, a constant shadow
// radius and limit offsets perpendicular to the shadow motion relative to the geocenter (Earth rotation
// ignored), which can shift the limits by a few hundred metres for slow shadows. Neither mode models
// refraction, the topography, the source's angular diameter, diffraction or the body's shape and limb
// profile: the body is a sphere of radius `radius` and the source a point.
//
// Conventions. Angles are radians; longitude is geodetic east-positive in (-PI, PI], latitude geodetic
// north-positive; distances AU; speeds AU/day; durations and timing sigmas seconds. "Left" and "right" limits
// are relative to the direction of the shadow motion over the ground, seen from above with the source
// overhead: left = axis x shadow velocity. Sample times are returned in the timescale of `start`; contact and
// central intervals are refined roots of continuous margins, and the endpoints of every line on the limb are
// refined by a bracketing root search. Uncertainty is propagated linearly from caller covariances to the
// fundamental plane and reported separately from the nominal geometry; it never moves the centerline.

// Default sampling step: 10 s. An asteroid shadow moves 5-30 km/s, so consecutive centerline points are a
// few hundred km apart, fine enough to resolve the gently curved track and every limb transition.
const DEFAULT_STEP = 10 * ONE_SECOND
// Default refinement tolerance for contacts and limb endpoints: ~1 ms, in days, i.e. ~20 m of shadow motion.
const DEFAULT_TOLERANCE = 1e-8
// Default light-time fixed-point refinements: enough for any solar-system body to converge below 1 ns.
const DEFAULT_LIGHT_TIME_ITERATIONS = 3
// Half-step for the shadow-velocity central difference: 1 s, small enough that the shadow motion is linear.
const VELOCITY_STEP = ONE_SECOND
// Fixed-point iterations that move a limit point to the envelope of the moving shadow. The offset direction
// depends on the ground point only through Earth rotation (<0.5 km/s against 5-30 km/s shadows), so it
// converges to sub-metre after two passes; the third leaves margin for slow lunar shadows.
const LIMIT_ITERATIONS = 3
// Iteration cap for a limb endpoint refinement, which normally stops at `tolerance` after a few steps; every
// other step is a bisection, so 120 steps shrink any bracket below double resolution and only bound the work.
const MAX_TRANSITION_ITERATIONS = 120

// Selects the physical model; see the module description.
export type OccultationPathMode = 'rigorous' | 'approximate'

// Caller-supplied astrometric uncertainty used to build the corridor. Both covariances are assumed fixed over
// the event and mutually independent; a missing one contributes nothing.
export interface OccultationPathUncertainty {
	// Covariance of the occulting body's barycentric ICRS position at the event, AU², row-major 3x3.
	readonly body?: Mat3
	// Covariance of the source direction in its tangent plane, rad², row-major 2x2 over (east, north) offsets,
	// i.e. (Δα·cosδ, Δδ). For a star this is the catalog position error propagated to the event epoch.
	readonly source?: Mat2
	// Corridor half-width multiplier N: the corridor lines sit N cross-track sigmas outside each limit.
	// Defaults to 1.
	readonly sigma?: number
}

// Options for the ground-track solver.
export interface OccultationPathOptions {
	// Physical radius of the occulting body, AU. The shadow radius is this for a source at infinity.
	readonly radius: Distance
	// Coarse sampling step, days. Defaults to 10 s. It must resolve each limb crossing of each line; a line
	// that touches the Earth only between two samples is missed.
	readonly step?: number
	// Refinement tolerance for contacts and limb endpoints, days. Defaults to ~1 ms.
	readonly tolerance?: number
	// Reference ellipsoid of the ground points. Defaults to IERS2010.
	readonly ellipsoid?: Ellipsoid
	// Uniform height of the ground surface above the ellipsoid, AU, modelled by inflating both semi-axes.
	// Defaults to 0. The error of this approximation is of order flattening x height.
	readonly height?: Distance
	// Physical model. Defaults to 'rigorous'.
	readonly mode?: OccultationPathMode
	// Fixed-point light-time refinements for the body and a finite source, an integer in [0, 16]. Defaults to 3;
	// 0 uses geometric positions at the reception epoch.
	readonly lightTimeIterations?: number
	// Barycentric Sun sampler. In 'rigorous' mode it enables the differential solar light deflection of the
	// source and the body. Omit it when the source is the Sun itself.
	readonly sun?: PositionAndVelocityOverTime
	// Astrometric covariances for the corridor. Omitted: samples carry no uncertainty.
	readonly uncertainty?: OccultationPathUncertainty
}

// A point of a track on the reference ellipsoid (or on the inflated surface when `height` is set).
export interface OccultationGroundPoint {
	// Geodetic east longitude, radians in (-PI, PI].
	readonly longitude: Angle
	// Geodetic latitude, radians.
	readonly latitude: Angle
	// Geometric altitude of the source above the ellipsoid horizon at the point, radians; 0 on the limb.
	readonly altitude: Angle
}

// Motion of the centerline point over the ground.
export interface OccultationGroundVelocity {
	// Horizontal speed of the ground point, AU/day. It exceeds the shadow speed at low source altitude.
	readonly speed: number
	// Direction of motion, radians clockwise from geodetic north (east = PI/2), in [0, TAU).
	readonly azimuth: Angle
}

// One-sigma uncertainty of a sample and its N-sigma corridor lines.
export interface OccultationPathSampleUncertainty {
	// Cross-track sigma of the shadow axis in the fundamental plane, AU.
	readonly crossTrack: Distance
	// Along-track sigma of the shadow axis in the fundamental plane, AU.
	readonly alongTrack: Distance
	// Event-time sigma at a fixed site, seconds: alongTrack divided by the shadow speed.
	readonly timing: number
	// Left corridor line (limit offset outward by N cross-track sigmas), when it meets the Earth.
	readonly left?: OccultationGroundPoint
	// Right corridor line, when it meets the Earth.
	readonly right?: OccultationGroundPoint
}

// The shadow geometry at one reception epoch.
export interface OccultationPathSample {
	// Reception epoch, in the timescale of `start`.
	readonly time: Time
	// Centerline point (the shadow axis on the ground), when the axis meets the Earth.
	readonly center?: OccultationGroundPoint
	// Left limit point, when the left limit line meets the Earth.
	readonly left?: OccultationGroundPoint
	// Right limit point, when the right limit line meets the Earth.
	readonly right?: OccultationGroundPoint
	// Shadow radius in the fundamental plane at the geocenter's depth, AU.
	readonly radius: Distance
	// Shadow speed relative to the ground in the fundamental plane, AU/day, at the centerline point (or at the
	// axis' closest approach to the ellipsoid when the axis misses). Zero for a shadow at rest.
	readonly speed: number
	// Longest occultation, on the centerline, seconds: shadow diameter over speed.
	readonly duration?: number
	// Straight-line distance between the simultaneous left and right limit points, AU: the ground width of the
	// path, which exceeds the shadow diameter where the source is low.
	readonly width?: Distance
	// Motion of the centerline point over the ground, when the axis meets the Earth around this epoch.
	readonly groundVelocity?: OccultationGroundVelocity
	// Uncertainty and corridor, when `uncertainty` was supplied.
	readonly uncertainty?: OccultationPathSampleUncertainty
}

// The sampled ground track of an occultation over a window.
export interface OccultationPath {
	// Model used.
	readonly mode: OccultationPathMode
	// Samples in chronological order, covering every `coverage` interval, including refined samples where a line
	// meets or leaves the limb.
	readonly samples: readonly OccultationPathSample[]
	// Intervals in which any part of the shadow touches the Earth (first to last external contact).
	readonly shadow: readonly TimeInterval[]
	// Intervals in which the shadow axis meets the Earth (central start to central end).
	readonly central: readonly TimeInterval[]
	// Intervals spanned by the samples, one per pass: the `shadow` intervals, or, with `uncertainty`, the wider
	// intervals in which the N-sigma corridor may touch the Earth, so the corridor lines are not cut at the nominal
	// contacts. Samples outside `shadow` carry only the line points that genuinely meet the Earth.
	readonly coverage: readonly TimeInterval[]
}

// Line families that can be extracted as polylines.
export type OccultationPathLine = 'center' | 'left' | 'right' | 'corridorLeft' | 'corridorRight'

// A vertex of an extracted polyline.
export interface OccultationPathVertex {
	// Reception epoch, in the timescale of the samples (interpolated at an antimeridian vertex).
	readonly time: Time
	// Geodetic east longitude, radians: in [-PI, PI] when split at the antimeridian, otherwise unwrapped.
	readonly longitude: Angle
	// Geodetic latitude, radians.
	readonly latitude: Angle
}

// Shadow axis snapshot at one reception epoch.
interface ShadowAxis {
	// Axis point near the geocenter's depth, ITRS, AU.
	readonly anchor: MutVec3
	// Unit axis direction pointing toward the source, ITRS.
	readonly axis: MutVec3
	// Axis point, GCRS-oriented (ICRS axes), geocentric, AU.
	readonly anchorGcrs: MutVec3
	// Unit axis direction, GCRS-oriented.
	readonly axisGcrs: MutVec3
	// GCRS -> ITRS rotation at the reception epoch.
	readonly rotation: Mat3
	// Shadow radius at the anchor's depth, AU.
	readonly radius: number
	// Radius decrease per unit depth toward the source (tangent of the cone half-angle), 0 for a cylinder.
	readonly slope: number
	// Signed depth of the body above the geocenter's fundamental plane, toward the source along the ray, AU: the
	// light path from the body to that plane. It is negative when the Earth is upstream of the body.
	readonly distance: number
	// Lateral displacement of the axis at the anchor per radian of source-direction error, AU.
	readonly sourceLever: number
	// Lateral displacement of the axis at the anchor per unit lateral body displacement (1 for a cylinder).
	readonly bodyLever: number
}

// Immutable solver configuration shared by all evaluations.
interface ShadowContext {
	readonly target: PositionAndVelocityOverTime
	readonly source: PositionAndVelocityOverTime | undefined
	// Unit vector toward a source at infinity, when the source is a direction.
	readonly direction: Vec3 | undefined
	readonly earth: PositionAndVelocityOverTime
	readonly sun: PositionAndVelocityOverTime | undefined
	readonly radius: number
	readonly iterations: number
	readonly rigorous: boolean
	// Semi-axes of the (inflated) intersection ellipsoid, AU.
	readonly equatorialRadius: number
	readonly polarRadius: number
	// Geodetic parameters used to convert ITRS points.
	readonly geodeticRadius: number
	readonly flattening: number
	readonly uncertainty: OccultationPathUncertainty | undefined
	readonly sigma: number
}

// A ground line evaluated at one epoch: the surface hit (or the line's closest approach to the ellipsoid when
// it misses) and a margin that is non-negative exactly when the line meets the ellipsoid.
interface LineSolution {
	readonly point: MutVec3
	readonly margin: number
	// Unit offset direction of a limit line (ITRS); the shadow normal for the centerline.
	readonly normal?: MutVec3
}

// A sample with the internal margins needed to refine limb transitions.
interface EvaluatedSample {
	readonly offset: number
	readonly sample: OccultationPathSample
	readonly margins: readonly number[]
}

// Ordered line families evaluated per sample, matching EvaluatedSample.margins.
const LINES: readonly OccultationPathLine[] = ['center', 'left', 'right', 'corridorLeft', 'corridorRight']

// Intersects the line origin + mu * axis with the ellipsoid x²/a² + y²/a² + z²/b² = 1. Writes the hit on the
// source-facing side (largest mu) into `out`, or the line's scaled closest approach (vertex of the quadratic)
// when it misses, so the point varies continuously through tangency. Returns the scaled discriminant
// (non-negative on a hit). Coordinates are ITRS AU.
function intersectGround(origin: Vec3, axis: Vec3, a: number, b: number, out: MutVec3): number {
	const ox = origin[0] / a
	const oy = origin[1] / a
	const oz = origin[2] / b
	const dx = axis[0] / a
	const dy = axis[1] / a
	const dz = axis[2] / b
	const qa = dx * dx + dy * dy + dz * dz
	const qb = 2 * (ox * dx + oy * dy + oz * dz)
	const qc = ox * ox + oy * oy + oz * oz - 1
	const discriminant = qb * qb - 4 * qa * qc
	let mu: number

	if (discriminant >= 0) {
		// Stable roots; the larger one is the entry point facing the source.
		const root = Math.sqrt(discriminant)
		const q = -0.5 * (qb + (qb >= 0 ? root : -root))
		mu = q === 0 ? 0 : Math.max(q / qa, qc / q)
	} else {
		mu = -qb / (2 * qa)
	}

	out[0] = origin[0] + mu * axis[0]
	out[1] = origin[1] + mu * axis[1]
	out[2] = origin[2] + mu * axis[2]
	return discriminant / (4 * qa)
}

// Ground point of the line origin + mu * axis (see intersectGround) with a causal margin: the light must pass the
// body before the ground point (source -> body -> ground), i.e. the body lies deeper toward the source than the
// point. The returned margin is the smaller of the scaled discriminant and that depth difference in equatorial
// radii, so it is non-negative exactly for a causal hit and stays continuous through tangency and through the
// causal boundary. Coordinates are ITRS AU with the geocenter at the origin.
function groundLine(context: ShadowContext, current: ShadowAxis, origin: Vec3, out: MutVec3): number {
	const discriminant = intersectGround(origin, current.axis, context.equatorialRadius, context.polarRadius, out)
	return Math.min(discriminant, causalDepth(current, out) / context.equatorialRadius)
}

// Height of the body above `point` (ITRS AU) along the axis toward the source, AU: positive when the light
// reaches the point after passing the body.
function causalDepth(current: ShadowAxis, point: Vec3) {
	return current.distance - vecDot(point, current.axis)
}

// Radial distance (AU) from the axis to the Earth's silhouette in the fundamental plane, negative inside it.
// The silhouette is the ellipse pᵀMp = 1 with M = Q - (Qk)(Qk)ᵀ / (kᵀQk), Q = diag(1/a², 1/a², 1/b²). The
// radial distance differs from the normal distance by a factor cos(angle between radius and normal), at most
// ~f²/2 relative, i.e. metres for the shadow radii of interest.
function silhouetteDistance(context: ShadowContext, { anchor, axis }: ShadowAxis) {
	const ia = 1 / (context.equatorialRadius * context.equatorialRadius)
	const ib = 1 / (context.polarRadius * context.polarRadius)
	const along = vecDot(anchor, axis)
	let cx = anchor[0] - along * axis[0]
	let cy = anchor[1] - along * axis[1]
	let cz = anchor[2] - along * axis[2]
	const length = Math.sqrt(cx * cx + cy * cy + cz * cz)

	if (length > 0) {
		cx /= length
		cy /= length
		cz /= length
	} else {
		// Axis through the geocenter: any in-plane direction gives the (signed) radius.
		const e = Math.abs(axis[2]) < 0.9 ? vecNormalizeMut(vecCross(axis, vecZ())) : vecNormalizeMut(vecCross(axis, vecX()))
		cx = e[0]
		cy = e[1]
		cz = e[2]
	}

	const kq = axis[0] * axis[0] * ia + axis[1] * axis[1] * ia + axis[2] * axis[2] * ib
	const cq = cx * cx * ia + cy * cy * ia + cz * cz * ib
	const ckq = cx * axis[0] * ia + cy * axis[1] * ia + cz * axis[2] * ib
	const boundary = 1 / Math.sqrt(cq - (ckq * ckq) / kq)
	return length - boundary
}

// Builds the shadow axis at reception epoch `time` (TDB). `rotation` overrides the GCRS -> ITRS matrix.
function shadowAxis(context: ShadowContext, time: Time, rotation: Mat3 = gcrsToItrsRotationMatrix(time)): ShadowAxis {
	const { target, source, direction, earth, rigorous, iterations } = context
	const [earthPosition] = earth(time)
	const ex = earthPosition[0]
	const ey = earthPosition[1]
	const ez = earthPosition[2]

	// Ray direction u (source -> body, the light propagation direction) and the retarded epochs as offsets
	// (days) before reception: lt for the body, lt + ls for the source.
	const u: MutVec3 = direction !== undefined ? [-direction[0], -direction[1], -direction[2]] : vecZero()
	const body = vecZero()
	const bodyVelocity = vecZero()
	const sourcePosition = vecZero()
	const sourceVelocity = vecZero()
	let lt = 0
	let ls = 0
	let sampledLt = 0
	let sourceDistance = Number.POSITIVE_INFINITY

	for (let k = 0; k <= iterations; k++) {
		sampledLt = lt
		const emission = lt === 0 ? time : timeShift(time, -lt)
		const [p, v] = target(emission)
		body[0] = p[0]
		body[1] = p[1]
		body[2] = p[2]
		bodyVelocity[0] = v[0]
		bodyVelocity[1] = v[1]
		bodyVelocity[2] = v[2]

		if (source !== undefined) {
			const [s, sv] = source(rigorous && lt + ls !== 0 ? timeShift(time, -lt - ls) : time)
			sourceVelocity[0] = sv[0]
			sourceVelocity[1] = sv[1]
			sourceVelocity[2] = sv[2]
			sourcePosition[0] = s[0]
			sourcePosition[1] = s[1]
			sourcePosition[2] = s[2]
			u[0] = body[0] - s[0]
			u[1] = body[1] - s[1]
			u[2] = body[2] - s[2]
			sourceDistance = vecLength(u)
			u[0] /= sourceDistance
			u[1] /= sourceDistance
			u[2] /= sourceDistance
			if (rigorous) ls = sourceDistance / SPEED_OF_LIGHT_AU_DAY
		}

		if (iterations === 0) break

		const bx = body[0] - ex
		const by = body[1] - ey
		const bz = body[2] - ez
		// Rigorous: light time to the geocenter's depth plane along the ray; approximate: geocentric range. A body
		// downstream of the Earth casts no shadow on it; its light time is held at zero rather than sampling the
		// body in the future, and the causal margin of groundLine rejects the geometry.
		lt = (rigorous ? Math.max(0, -(bx * u[0] + by * u[1] + bz * u[2])) : Math.sqrt(bx * bx + by * by + bz * bz)) / SPEED_OF_LIGHT_AU_DAY
	}

	// Axis direction toward the source (GCRS) before deflection.
	const axisGcrs: MutVec3 = [-u[0], -u[1], -u[2]]

	if (rigorous && iterations > 0) {
		// The instantaneous shadow is the locus X(τ) = B(τ) + c (t - τ) u(τ) of rays that grazed the body at
		// emission τ, and its tangent dX/dτ = v_body - c u + c (t - τ) du/dτ is the true axis at reception: the
		// source direction tilted by v_body / c (the light-time aberration of the moving shadow), plus, for a
		// finite source, the turning of the source -> body direction, du/dτ = (Δv - u (u·Δv)) / L.
		let tx = bodyVelocity[0] / SPEED_OF_LIGHT_AU_DAY - u[0]
		let ty = bodyVelocity[1] / SPEED_OF_LIGHT_AU_DAY - u[1]
		let tz = bodyVelocity[2] / SPEED_OF_LIGHT_AU_DAY - u[2]

		if (source !== undefined) {
			const dvx = bodyVelocity[0] - sourceVelocity[0]
			const dvy = bodyVelocity[1] - sourceVelocity[1]
			const dvz = bodyVelocity[2] - sourceVelocity[2]
			const radial = dvx * u[0] + dvy * u[1] + dvz * u[2]
			const factor = sampledLt / sourceDistance
			tx += (dvx - radial * u[0]) * factor
			ty += (dvy - radial * u[1]) * factor
			tz += (dvz - radial * u[2]) * factor
		}

		axisGcrs[0] = tx
		axisGcrs[1] = ty
		axisGcrs[2] = tz
		vecNormalizeMut(axisGcrs)
	}

	// Differential solar light deflection: occultation needs the apparent source and body directions to agree,
	// equivalent to rotating the geometric source direction by (deflection of source - deflection of body).
	if (rigorous && context.sun !== undefined) {
		const sun = context.sun(time)[0]
		const e: MutVec3 = [ex - sun[0], ey - sun[1], ez - sun[2]]
		const em = vecLength(e)
		const limiter = 1e-6 / Math.max(1, em * em)
		e[0] /= em
		e[1] /= em
		e[2] /= em

		const pb: MutVec3 = [body[0] - ex, body[1] - ey, body[2] - ez]
		const qb: MutVec3 = [body[0] - sun[0], body[1] - sun[1], body[2] - sun[2]]
		vecNormalizeMut(pb)
		vecNormalizeMut(qb)
		const db = eraLd(1, pb, qb, e, em, limiter)

		const ps: MutVec3 = source !== undefined ? [sourcePosition[0] - ex, sourcePosition[1] - ey, sourcePosition[2] - ez] : [-u[0], -u[1], -u[2]]
		const qs: MutVec3 = source !== undefined ? [sourcePosition[0] - sun[0], sourcePosition[1] - sun[1], sourcePosition[2] - sun[2]] : [-u[0], -u[1], -u[2]]
		vecNormalizeMut(ps)
		const qsLength = vecLength(qs)

		// A source at the Sun's centre has no defined deflection; it is left undeflected.
		if (qsLength > 0) {
			qs[0] /= qsLength
			qs[1] /= qsLength
			qs[2] /= qsLength
			const ds = eraLd(1, ps, qs, e, em, limiter)
			const sx = ds[0] - ps[0] - (db[0] - pb[0])
			const sy = ds[1] - ps[1] - (db[1] - pb[1])
			const sz = ds[2] - ps[2] - (db[2] - pb[2])
			axisGcrs[0] += sx
			axisGcrs[1] += sy
			axisGcrs[2] += sz
			vecNormalizeMut(axisGcrs)
			u[0] -= sx
			u[1] -= sy
			u[2] -= sz
			vecNormalizeMut(u)
		}
	}

	// Distance from the body to the geocenter's depth plane along the ray, AU.
	const distance = (ex - body[0]) * u[0] + (ey - body[1]) * u[1] + (ez - body[2]) * u[2]
	// Rigorous: the ray point at reception for the sampled emission epoch, which lies on the axis locus near the
	// geocenter's depth. Approximate: the axis through the light-time-corrected body, moved along itself to the
	// fundamental plane so the ground intersection does not cancel AU-scale terms.
	const travel = rigorous ? sampledLt * SPEED_OF_LIGHT_AU_DAY : 0
	const anchorGcrs: MutVec3 = [body[0] + travel * u[0] - ex, body[1] + travel * u[1] - ey, body[2] + travel * u[2] - ez]

	if (!rigorous) {
		const along = vecDot(anchorGcrs, axisGcrs)
		anchorGcrs[0] -= along * axisGcrs[0]
		anchorGcrs[1] -= along * axisGcrs[1]
		anchorGcrs[2] -= along * axisGcrs[2]
	}

	let radius = context.radius
	let slope = 0
	let sourceLever = distance
	let bodyLever = 1

	if (source !== undefined) {
		// Cone with apex at the point source: radius = (distance from apex) * tan(half-angle).
		const tangent = context.radius / Math.sqrt(sourceDistance * sourceDistance - context.radius * context.radius)
		const apexDistance = sourceDistance + (rigorous ? distance - vecDot(anchorGcrs, axisGcrs) : distance)
		radius = apexDistance * tangent
		if (rigorous) slope = tangent
		sourceLever = (distance * (sourceDistance + distance)) / sourceDistance
		bodyLever = (sourceDistance + distance) / sourceDistance
	}

	return { anchor: matMulVec(rotation, anchorGcrs), axis: matMulVec(rotation, axisGcrs), anchorGcrs, axisGcrs, rotation, radius, slope, distance, sourceLever, bodyLever }
}

// Shadow velocity relative to the ground point `point` (ITRS AU), AU/day, projected on the fundamental plane.
// Rigorous: the rate of change of the point's offset from the axis seen from the rotating Earth. Approximate:
// the inertial motion of the axis relative to the geocenter, ignoring Earth rotation.
function shadowVelocity(context: ShadowContext, before: ShadowAxis, current: ShadowAxis, after: ShadowAxis, point: Vec3): MutVec3 {
	const k = current.axis
	const scale = 1 / (2 * VELOCITY_STEP)
	let wx: number
	let wy: number
	let wz: number

	if (context.rigorous) {
		const ob = axisOffset(point, before)
		const oa = axisOffset(point, after)
		// The offset of the ground point from the axis changes as -w.
		wx = (ob[0] - oa[0]) * scale
		wy = (ob[1] - oa[1]) * scale
		wz = (ob[2] - oa[2]) * scale
	} else {
		const g: Vec3 = [(after.anchorGcrs[0] - before.anchorGcrs[0]) * scale, (after.anchorGcrs[1] - before.anchorGcrs[1]) * scale, (after.anchorGcrs[2] - before.anchorGcrs[2]) * scale]
		const w = matMulVec(current.rotation, g)
		wx = w[0]
		wy = w[1]
		wz = w[2]
	}

	const along = wx * k[0] + wy * k[1] + wz * k[2]
	return [wx - along * k[0], wy - along * k[1], wz - along * k[2]]
}

// Offset of `point` from the axis, perpendicular to it (ITRS AU).
function axisOffset(point: Vec3, { anchor, axis }: ShadowAxis): MutVec3 {
	const dx = point[0] - anchor[0]
	const dy = point[1] - anchor[1]
	const dz = point[2] - anchor[2]
	const along = dx * axis[0] + dy * axis[1] + dz * axis[2]
	return [dx - along * axis[0], dy - along * axis[1], dz - along * axis[2]]
}

// Solves a limit line on side +1 (left) or -1 (right), offset `extra` AU beyond the shadow edge, starting from
// the ground point `seed`. Each pass recomputes the offset direction perpendicular to the shadow velocity at
// the current point (the envelope condition) and re-intersects the ellipsoid. Undefined for a shadow at rest.
function solveLimit(context: ShadowContext, before: ShadowAxis, current: ShadowAxis, after: ShadowAxis, seed: Vec3, side: number, extra: number): LineSolution | undefined {
	const { anchor, axis } = current
	const point: MutVec3 = [seed[0], seed[1], seed[2]]
	const origin = vecZero()
	let normal: MutVec3 | undefined
	let margin = 0

	for (let i = 0; i < LIMIT_ITERATIONS; i++) {
		const w = shadowVelocity(context, before, current, after, point)
		if (!(vecLength(w) > 0)) return undefined

		normal = vecNormalizeMut(vecCross(axis, w))
		normal[0] *= side
		normal[1] *= side
		normal[2] *= side

		const depth = (point[0] - anchor[0]) * axis[0] + (point[1] - anchor[1]) * axis[1] + (point[2] - anchor[2]) * axis[2]
		const offset = current.radius - depth * current.slope + extra
		origin[0] = anchor[0] + offset * normal[0]
		origin[1] = anchor[1] + offset * normal[1]
		origin[2] = anchor[2] + offset * normal[2]
		margin = groundLine(context, current, origin, point)
	}

	return { point, margin, normal }
}

// Converts an ITRS surface point into a ground point with the source altitude along `axis`.
function groundPoint(context: ShadowContext, point: Vec3, axis: Vec3): OccultationGroundPoint {
	const [longitude, latitude] = eraGc2Gde(context.geodeticRadius, context.flattening, point[0], point[1], point[2])
	const cl = Math.cos(latitude)
	const up0 = cl * Math.cos(longitude)
	const up1 = cl * Math.sin(longitude)
	const up2 = Math.sin(latitude)
	const altitude = Math.asin(clamp(axis[0] * up0 + axis[1] * up1 + axis[2] * up2, -1, 1))
	return { longitude: normalizePI(longitude), latitude, altitude }
}

// One-sigma quadratic form of the caller covariances along the GCRS unit vector `direction` (in the plane).
function projectedSigma(context: ShadowContext, current: ShadowAxis, direction: Vec3) {
	const { body, source } = context.uncertainty!
	let variance = 0

	if (body !== undefined) {
		const m = matMulVec(body, direction)
		variance += vecDot(direction, m) * current.bodyLever * current.bodyLever
	}

	if (source !== undefined) {
		// Tangent basis at the source direction (east, north); the axis moves by -lever * angular error.
		const k = current.axisGcrs
		const east = Math.abs(k[2]) < 1 - 1e-12 ? vecNormalizeMut(vecCross(vecZ(), k)) : vecNormalizeMut(vecCross(vecY(), k))
		const north = vecCross(k, east)
		const ce = vecDot(direction, east) * current.sourceLever
		const cn = vecDot(direction, north) * current.sourceLever
		variance += ce * ce * source[0] + ce * cn * (source[1] + source[2]) + cn * cn * source[3]
	}

	return Math.sqrt(Math.max(variance, 0))
}

// Upper bound (AU) of how far beyond the shadow edge a corridor line can sit: sigma times a bound of the
// cross-track sigma. The cross-track variance is a quadratic form of the in-plane covariance along one direction,
// so it never exceeds the trace of that covariance projected on the fundamental plane (body) or of the tangent-
// plane covariance (source), each scaled by its lever arm. Conservative by up to sqrt(2) for isotropic errors.
function corridorReach(context: ShadowContext, current: ShadowAxis) {
	if (context.uncertainty === undefined) return 0
	const { body, source } = context.uncertainty
	let variance = 0

	if (body !== undefined) {
		const trace = body[0] + body[4] + body[8]
		const along = vecDot(current.axisGcrs, matMulVec(body, current.axisGcrs))
		variance += (trace - along) * current.bodyLever * current.bodyLever
	}

	if (source !== undefined) variance += (source[0] + source[3]) * current.sourceLever * current.sourceLever

	return context.sigma * Math.sqrt(Math.max(variance, 0))
}

// Evaluates every line family at the TDB epoch `time` (an `offset` days after the TDB start).
function evaluateSample(context: ShadowContext, time: Time, offset: number, scale: Time['scale']): EvaluatedSample {
	// Over the ±1 s stencil only the Earth rotation angle changes appreciably (precession, nutation and polar
	// motion move < 1e-11 rad), so the neighbouring rotations are the central one turned about the ITRS pole.
	const current = shadowAxis(context, time)
	const before = shadowAxis(context, timeShift(time, -VELOCITY_STEP), matRotZ(-ANGVEL_PER_DAY * VELOCITY_STEP, matClone(current.rotation)))
	const after = shadowAxis(context, timeShift(time, VELOCITY_STEP), matRotZ(ANGVEL_PER_DAY * VELOCITY_STEP, matClone(current.rotation)))
	const margins = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY]

	const centerPoint = vecZero()
	margins[0] = groundLine(context, current, current.anchor, centerPoint)
	const hit = margins[0] >= 0

	const velocity = shadowVelocity(context, before, current, after, centerPoint)
	const speed = vecLength(velocity)

	const left = solveLimit(context, before, current, after, centerPoint, 1, 0)
	const right = solveLimit(context, before, current, after, centerPoint, -1, 0)
	if (left !== undefined) margins[1] = left.margin
	if (right !== undefined) margins[2] = right.margin

	const center = hit ? groundPoint(context, centerPoint, current.axis) : undefined
	const leftHit = left !== undefined && left.margin >= 0
	const rightHit = right !== undefined && right.margin >= 0

	let duration: number | undefined
	let groundVelocity: OccultationGroundVelocity | undefined

	if (hit) {
		const depth = (centerPoint[0] - current.anchor[0]) * current.axis[0] + (centerPoint[1] - current.anchor[1]) * current.axis[1] + (centerPoint[2] - current.anchor[2]) * current.axis[2]
		if (speed > 0) duration = ((2 * (current.radius - depth * current.slope)) / speed) * DAYSEC

		const pb = vecZero()
		const pa = vecZero()

		if (groundLine(context, before, before.anchor, pb) >= 0 && groundLine(context, after, after.anchor, pa) >= 0) {
			const scaleVelocity = 1 / (2 * VELOCITY_STEP)
			const vx = (pa[0] - pb[0]) * scaleVelocity
			const vy = (pa[1] - pb[1]) * scaleVelocity
			const vz = (pa[2] - pb[2]) * scaleVelocity
			const sl = Math.sin(center!.longitude)
			const cl = Math.cos(center!.longitude)
			const sp = Math.sin(center!.latitude)
			const cp = Math.cos(center!.latitude)
			const east = -sl * vx + cl * vy
			const north = -sp * cl * vx - sp * sl * vy + cp * vz
			const azimuth = Math.atan2(east, north)
			groundVelocity = { speed: Math.hypot(east, north), azimuth: azimuth < 0 ? azimuth + TAU : azimuth }
		}
	}

	let uncertainty: OccultationPathSampleUncertainty | undefined

	if (context.uncertainty !== undefined) {
		// Cross-track direction from the left limit (or the shadow normal at the centerline), along-track from
		// the shadow velocity, both rotated back to GCRS where the covariances live.
		const crossItrs = left?.normal ?? (speed > 0 ? vecNormalizeMut(vecCross(current.axis, velocity)) : undefined)

		if (crossItrs !== undefined && speed > 0) {
			const cross = matTransposeMulVec(current.rotation, crossItrs)
			const along = matTransposeMulVec(current.rotation, [velocity[0] / speed, velocity[1] / speed, velocity[2] / speed])
			const crossTrack = projectedSigma(context, current, cross)
			const alongTrack = projectedSigma(context, current, along)
			const extra = context.sigma * crossTrack
			const corridorLeft = solveLimit(context, before, current, after, left?.point ?? centerPoint, 1, extra)
			const corridorRight = solveLimit(context, before, current, after, right?.point ?? centerPoint, -1, extra)
			if (corridorLeft !== undefined) margins[3] = corridorLeft.margin
			if (corridorRight !== undefined) margins[4] = corridorRight.margin

			uncertainty = {
				crossTrack,
				alongTrack,
				timing: (alongTrack / speed) * DAYSEC,
				left: corridorLeft !== undefined && corridorLeft.margin >= 0 ? groundPoint(context, corridorLeft.point, current.axis) : undefined,
				right: corridorRight !== undefined && corridorRight.margin >= 0 ? groundPoint(context, corridorRight.point, current.axis) : undefined,
			}
		}
	}

	const sample: OccultationPathSample = {
		time: timeConvert(time, scale),
		center,
		left: leftHit ? groundPoint(context, left.point, current.axis) : undefined,
		right: rightHit ? groundPoint(context, right.point, current.axis) : undefined,
		radius: current.radius,
		speed,
		duration,
		width: leftHit && rightHit ? Math.hypot(left.point[0] - right.point[0], left.point[1] - right.point[1], left.point[2] - right.point[2]) : undefined,
		groundVelocity,
		uncertainty,
	}

	return { offset, sample, margins }
}

// Refines the epoch where line `index` meets or leaves the limb between two samples, returning the sample on
// the side where the line still meets the Earth, within `tolerance` days of the transition. The margin is
// nearly linear in time through tangency, so Illinois false-position steps converge in a few evaluations;
// they alternate with bisections, which guarantee the bracket keeps shrinking whatever the margin's shape.
function refineTransition(context: ShadowContext, start: Time, a: EvaluatedSample, b: EvaluatedSample, index: number, tolerance: number, scale: Time['scale']) {
	let inside = a.margins[index] >= 0 ? a : b
	let outside = inside === a ? b : a
	let insideWeight = 1
	let outsideWeight = 1
	let retained = 0

	for (let i = 0; i < MAX_TRANSITION_ITERATIONS && Math.abs(outside.offset - inside.offset) > tolerance; i++) {
		const width = outside.offset - inside.offset
		const mi = inside.margins[index] * insideWeight
		const mo = outside.margins[index] * outsideWeight
		let fraction = i % 2 === 0 && Number.isFinite(mo) && mi - mo > 0 ? mi / (mi - mo) : 0.5
		// Keep the probe at least half a tolerance inside the bracket so a converged step still shrinks it.
		const guard = (0.5 * tolerance) / Math.abs(width)
		fraction = clamp(fraction, guard, 1 - guard)

		const offset = inside.offset + fraction * width
		const probe = evaluateSample(context, timeShift(start, offset), offset, scale)

		if (probe.margins[index] >= 0) {
			inside = probe
			insideWeight = 1
			if (retained === 1) outsideWeight *= 0.5
			retained = 1
		} else {
			outside = probe
			outsideWeight = 1
			if (retained === -1) insideWeight *= 0.5
			retained = -1
		}
	}

	return inside
}

// Predicts the ground track of an occultation of a point source by a spherical body over [start, stop].
//
// `target` (the occulting body) and `earth` (the geocenter) are barycentric ICRS samplers, AU and AU/day,
// called with TDB epochs. `source` is either the ICRS direction to a source at infinity (need not be unit) or
// a barycentric sampler of a finite-distance source (for example a star with parallax via spaceMotion, or
// the Sun's centre). `start` and `stop` may use any timescale; Earth orientation is evaluated from it (UT1
// through the time's providers), and sample and interval times are returned in the timescale of `start`.
//
// The window is first scanned at `options.step` for the intervals where the shadow touches the Earth and where
// its axis does, each refined to `options.tolerance`; samples then cover every shadow interval on the step grid
// plus both interval endpoints, and every epoch where a line meets or leaves the limb is refined and added.
// With `lightTimeIterations` > 0 the target (and source) are sampled before `start` by the light time.
export function occultationPath(target: PositionAndVelocityOverTime, source: Vec3 | PositionAndVelocityOverTime, earth: PositionAndVelocityOverTime, start: Time, stop: Time, options: OccultationPathOptions): OccultationPath {
	const { radius, step = DEFAULT_STEP, tolerance = DEFAULT_TOLERANCE, ellipsoid = Ellipsoid.IERS2010, height = 0, mode = 'rigorous', lightTimeIterations = DEFAULT_LIGHT_TIME_ITERATIONS, sun, uncertainty } = options
	validateLightTimeIterations(lightTimeIterations)

	const { radius: geodeticRadius, flattening, oneMinusFlattening } = ELLIPSOID_PARAMETERS[ellipsoid]
	let direction: Vec3 | undefined

	if (typeof source !== 'function') {
		const length = vecLength(source)
		direction = [source[0] / length, source[1] / length, source[2] / length]
	}

	const context: ShadowContext = {
		target,
		source: typeof source === 'function' ? source : undefined,
		direction,
		earth,
		sun,
		radius,
		iterations: lightTimeIterations,
		rigorous: mode === 'rigorous',
		equatorialRadius: geodeticRadius + height,
		polarRadius: geodeticRadius * oneMinusFlattening + height,
		geodeticRadius,
		flattening,
		uncertainty: uncertainty !== undefined && (uncertainty.body !== undefined || uncertainty.source !== undefined) ? uncertainty : undefined,
		sigma: uncertainty?.sigma ?? 1,
	}

	const scale = start.scale
	const begin = tdb(start)
	const end = tdb(stop)

	// Both scans visit the same coarse epochs, so each snapshot is solved once. The cache lives only for the
	// two scans and holds one entry per evaluated epoch.
	const scanned = new Map<string, ShadowAxis>()
	const scannedAxis = (time: Time) => {
		const key = `${time.day}:${time.fraction}`
		let axis = scanned.get(key)
		if (axis === undefined) scanned.set(key, (axis = shadowAxis(context, time)))
		return axis
	}
	// The silhouette margins are gated by the causal depth at the axis point (its ground hit or closest approach),
	// so a body downstream of the Earth yields no contact. For a body within an Earth radius of the fundamental
	// plane the gate uses that single point, and the per-line margins of the samples decide each ground point.
	const axisPoint = vecZero()
	const causalMargin = (axis: ShadowAxis) => {
		intersectGround(axis.anchor, axis.axis, context.equatorialRadius, context.polarRadius, axisPoint)
		return causalDepth(axis, axisPoint)
	}
	const shadowMargin = (time: Time) => {
		const axis = scannedAxis(time)
		return Math.min(axis.radius - silhouetteDistance(context, axis), causalMargin(axis))
	}
	const centralMargin = (time: Time) => {
		const axis = scannedAxis(time)
		return Math.min(-silhouetteDistance(context, axis), causalMargin(axis))
	}
	// The widest offset a line can reach: the cone radius at the near side of the Earth plus the corridor reach.
	const coverageMargin = (time: Time) => {
		const axis = scannedAxis(time)
		const reach = axis.radius + context.equatorialRadius * axis.slope + corridorReach(context, axis)
		return Math.min(reach - silhouetteDistance(context, axis), causalMargin(axis))
	}

	const shadow = searchIntervals([shadowMargin], begin, end, { step, tolerance })
	const central = searchIntervals([centralMargin], begin, end, { step, tolerance })
	const coverage = context.uncertainty === undefined ? shadow : searchIntervals([coverageMargin], begin, end, { step, tolerance })
	scanned.clear()

	const evaluated: EvaluatedSample[] = []

	for (const interval of coverage) {
		const first = timeSubtract(interval.start, begin)
		const last = timeSubtract(interval.end, begin)
		const offsets = [first]
		for (let k = Math.floor(first / step) + 1; k * step < last; k++) offsets.push(k * step)
		offsets.push(last)

		let previous: EvaluatedSample | undefined

		for (let i = 0; i < offsets.length; i++) {
			const offset = offsets[i]
			// The interval endpoints are evaluated at the refined contact instants themselves, so the first and last
			// samples of a pass carry exactly the times reported in `coverage`.
			const time = i === 0 ? interval.start : i === offsets.length - 1 ? interval.end : timeShift(begin, offset)
			const current = evaluateSample(context, time, offset, scale)

			if (previous !== undefined) {
				for (let index = 0; index < LINES.length; index++) {
					if (previous.margins[index] >= 0 !== current.margins[index] >= 0) evaluated.push(refineTransition(context, begin, previous, current, index, tolerance, scale))
				}
			}

			evaluated.push(current)
			previous = current
		}
	}

	evaluated.sort((a, b) => a.offset - b.offset)
	const samples: OccultationPathSample[] = []
	for (let i = 0; i < evaluated.length; i++) if (i === 0 || evaluated[i].offset !== evaluated[i - 1].offset) samples.push(evaluated[i].sample)

	const convert = (interval: TimeInterval): TimeInterval => ({ start: timeConvert(interval.start, scale), end: timeConvert(interval.end, scale) })
	const convertedShadow = shadow.map(convert)
	return { mode, samples, shadow: convertedShadow, central: central.map(convert), coverage: coverage === shadow ? convertedShadow : coverage.map(convert) }
}

// Selects the ground point of a line family from a sample.
function linePoint(sample: OccultationPathSample, line: OccultationPathLine) {
	switch (line) {
		case 'center':
			return sample.center
		case 'left':
			return sample.left
		case 'right':
			return sample.right
		case 'corridorLeft':
			return sample.uncertainty?.left
		case 'corridorRight':
			return sample.uncertainty?.right
	}
}

// Extracts one line family of a path as polylines for mapping. A polyline breaks wherever the line leaves the
// Earth and between two passes: a sample opens a new polyline when it belongs to a later `coverage` interval
// than the previous one, so separate passes are never joined across a time when neither the shadow nor its
// corridor touches the Earth. With `unwrap` false (default) longitudes stay in [-PI, PI] and a polyline is also
// split where it crosses the antimeridian, ending and restarting on the seam at a latitude and time interpolated
// linearly in longitude between the two samples. With `unwrap` true each polyline keeps continuous unwrapped longitudes.
// A track passing directly over a pole has a longitude jump near PI between the two samples bracketing it,
// which is preserved. Rendering (SVG, GeoJSON) is left to the caller.
export function occultationPathPolylines(path: OccultationPath, line: OccultationPathLine, unwrap: boolean = false): OccultationPathVertex[][] {
	const polylines: OccultationPathVertex[][] = []
	let polyline: OccultationPathVertex[] | undefined
	let previous: OccultationPathVertex | undefined
	// Index of the coverage interval holding the current sample; samples are chronological, so it only advances.
	let pass = 0

	for (const sample of path.samples) {
		const point = linePoint(sample, line)
		let next = pass
		while (next + 1 < path.coverage.length && timeSubtract(sample.time, path.coverage[next + 1].start) >= 0) next++

		if (next !== pass) {
			pass = next
			polyline = undefined
			previous = undefined
		}

		if (point === undefined) {
			polyline = undefined
			previous = undefined
			continue
		}

		if (polyline === undefined || previous === undefined) {
			previous = { time: sample.time, longitude: point.longitude, latitude: point.latitude }
			polyline = [previous]
			polylines.push(polyline)
			continue
		}

		const delta = normalizePI(point.longitude - normalizePI(previous.longitude))

		if (unwrap) {
			previous = { time: sample.time, longitude: previous.longitude + delta, latitude: point.latitude }
			polyline.push(previous)
			continue
		}

		if (Math.abs(point.longitude - previous.longitude) > PI && delta !== 0) {
			// Crossing the antimeridian: interpolate the seam vertex in unwrapped longitude.
			const seam = delta > 0 ? PI : -PI
			const fraction = (seam - previous.longitude) / delta
			const latitude = previous.latitude + fraction * (point.latitude - previous.latitude)
			const time = timeShift(previous.time, fraction * timeSubtract(sample.time, previous.time))
			polyline.push({ time, longitude: seam, latitude })
			polyline = [{ time, longitude: -seam, latitude }]
			polylines.push(polyline)
		}

		previous = { time: sample.time, longitude: point.longitude, latitude: point.latitude }
		polyline.push(previous)
	}

	return polylines
}
