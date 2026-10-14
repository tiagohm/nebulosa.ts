import { ONE_SECOND, PIOVERTWO, SUN_RADIUS_AU } from '../../core/constants'
import { type Mat3, matMulVec } from '../../math/linear-algebra/mat3'
import { type MutVec3, type Vec3, vecAngle, vecCross, vecDot, vecLength, vecNormalizeMut, vecZero } from '../../math/linear-algebra/vec3'
import { clamp } from '../../math/numerical/math'
import { type Angle, normalizeAngle } from '../../math/units/angle'
import type { Distance } from '../../math/units/distance'
import type { PositionOverTime } from '../coordinates/astrometry'
import { frameAt } from '../coordinates/frame'
import { bodyFixedPosition, type BodySurfaceLocation, bodySurfaceNormal } from '../observer/body'
import { type HorizonSample, horizonMinimumAltitudeLookup } from '../observer/horizon'
import { type Time, timeShift } from '../time/time'
import { searchIntervals, searchRoots, type TimeInterval, type TimeSearchOptions } from './search'

// Solar illumination on rotating tri-axial reference surfaces. Locations have east-positive
// planetocentric longitude; the local vertical is the reference ellipsoid normal. Angles are
// radians, with no relief or refraction. The sunrise/set helpers use the solar center without a
// finite disk, and treat the explicit body-center-to-Sun direction as parallel across the body, so
// finite-distance surface parallax is omitted there.
//
// Surface-feature illumination evaluates one prepared crust-fixed feature against explicit
// body-center-to-Sun and body-center-to-observer position vectors (AU, library-base axes) at one
// instant. Vectors are taken from the feature point itself, so observer parallax is included; light
// time and aberration are not applied unless the caller's providers include them. The local horizon
// frame has +Z along the reference ellipsoid normal and north along body +Z projected onto the tangent
// plane; azimuth runs north through east in [0, TAU). Smooth-ellipsoid mode cannot predict terrain
// shadows. An optional caller-supplied terrain horizon mask, in the same local frame, adds horizon
// occlusion at its own resolution and provenance; it does not model cast-shadow length.
// surface.terrain derives masks, facets and shadow rays from a caller-supplied DEM.

// A solar-center crossing of a body-surface reference horizon.
export interface BodySurfaceSunEvent {
	// Refined epoch of the crossing.
	readonly time: Time
	// Rising or falling local solar altitude; tangential touches are omitted.
	readonly kind: 'sunrise' | 'sunset'
	// Resolved solar-center altitude above the ellipsoid tangent plane, radians.
	readonly altitude: Angle
}

// Surface horizon and time-scanner controls.
export interface BodySurfaceSunOptions extends TimeSearchOptions {
	// Solar-center altitude in radians that defines sunrise/set; defaults to zero.
	readonly horizon?: Angle
}

// Builds a sampler with one normal and reusable direction workspace for a fixed location.
// sunAt is body-center-to-Sun in library-base axes; it may reuse its output buffer.
function solarAltitudeAt(location: BodySurfaceLocation, sunAt: PositionOverTime) {
	const normal = bodySurfaceNormal(location)
	const direction = vecZero()
	return (time: Time) => {
		frameAt(sunAt(time), location.frame, time, direction)
		return Math.asin(clamp(vecDot(normal, vecNormalizeMut(direction)), -1, 1))
	}
}

// Solar-center altitude in radians at time on a location fixed to its rotating body frame.
// sunAt supplies the body-center-to-Sun direction in library-base axes. Uses a normalized reference
// ellipsoid normal, ignoring terrain, relief, refraction, solar radius and surface parallax.
export function bodySurfaceSolarAltitude(location: BodySurfaceLocation, sunAt: PositionOverTime, time: Time): Angle {
	return solarAltitudeAt(location, sunAt)(time)
}

// Finds chronological sunrise/set crossings inside start/stop at options.horizon (radians).
// sunAt supplies body-center-to-Sun base-frame directions. Uses searchRoots with caller step and
// tolerance; steps must resolve crossings. The local slope across one second (or twice tolerance,
// whichever is greater) classifies each root, requiring providers just beyond window boundaries.
// Tangential touches are omitted. One normal and vector workspace are reused throughout the scan.
export function bodySurfaceSunEvents(location: BodySurfaceLocation, sunAt: PositionOverTime, start: Time, stop: Time, { horizon = 0, ...options }: BodySurfaceSunOptions = {}): BodySurfaceSunEvent[] {
	const altitudeAt = solarAltitudeAt(location, sunAt)
	const events: BodySurfaceSunEvent[] = []
	const halfStep = Math.max(ONE_SECOND, 2 * (options.tolerance ?? 1e-6))
	for (const time of searchRoots((epoch) => altitudeAt(epoch) - horizon, start, stop, options)) {
		const before = altitudeAt(timeShift(time, -halfStep)) - horizon
		const after = altitudeAt(timeShift(time, halfStep)) - horizon
		if (before < 0 && after > 0) events.push({ time, kind: 'sunrise', altitude: altitudeAt(time) })
		else if (before > 0 && after < 0) events.push({ time, kind: 'sunset', altitude: altitudeAt(time) })
	}
	return events
}

// A crust-fixed feature prepared once for repeated illumination geometry. All vectors are unit
// vectors in the body-fixed frame of location.frame and are treated as immutable.
export interface SurfaceFeature {
	// Feature point on its reference body; its cached body-fixed position is the vantage point.
	readonly location: BodySurfaceLocation
	// Local zenith: the outward reference-ellipsoid normal at the feature.
	readonly up: Vec3
	// Local north: body +Z projected onto the tangent plane; at an exact pole, the limit along the
	// location's meridian.
	readonly north: Vec3
	// Local east, completing the right-handed east/north/up triad (east = north × up).
	readonly east: Vec3
	// Facet normal used for incidence and emission; equals up for a zero-slope feature.
	readonly normal: Vec3
	// Reference-surface radius below the feature (body-fixed position length minus elevation), AU.
	readonly radius: Distance
	// Interpolated terrain horizon altitude (radians) by local azimuth (radians); undefined in
	// smooth-ellipsoid mode, where the reference tangent plane is the horizon.
	readonly horizonAltitudeAt?: (azimuth: Angle) => Angle
}

// Optional facet tilt and terrain horizon for surfaceFeature.
export interface SurfaceFeatureOptions {
	// Facet tilt from the local zenith in radians, normally in [0, PI/2]; defaults to zero.
	readonly slope?: Angle
	// Local azimuth the facet faces (its down-slope direction), north through east in radians;
	// defaults to zero and is irrelevant when slope is zero.
	readonly aspect?: Angle
	// Terrain horizon mask seen from the feature in its local horizon frame (altitude above the
	// reference tangent plane by azimuth north through east, radians). Its resolution and source,
	// such as a DEM-derived profile, are the caller's responsibility.
	readonly horizon?: readonly HorizonSample[]
}

// Instantaneous illumination and viewing geometry of a surface feature.
export interface SurfaceFeatureIllumination {
	// Solar-center altitude above the reference tangent plane, radians in [-PI/2, PI/2].
	readonly solarAltitude: Angle
	// Solar-center azimuth in the local horizon frame, north through east, radians in [0, TAU);
	// zero when the Sun is exactly at the zenith or nadir.
	readonly solarAzimuth: Angle
	// Apparent solar radius seen from the feature, radians, for limb-based thresholds.
	readonly solarAngularRadius: Angle
	// Angle between the facet normal and the feature-to-Sun direction, radians in [0, PI].
	readonly incidence: Angle
	// Angle between the facet normal and the feature-to-observer direction, radians in [0, PI].
	readonly emission: Angle
	// Sun-feature-observer angle, radians in [0, PI].
	readonly phase: Angle
	// Observer altitude above the reference tangent plane, radians in [-PI/2, PI/2].
	readonly observerAltitude: Angle
	// Observer azimuth in the local horizon frame, north through east, radians in [0, TAU).
	readonly observerAzimuth: Angle
	// Altitude of the terrain horizon at the solar azimuth, radians; zero in smooth-ellipsoid mode.
	readonly solarHorizon: Angle
	// Altitude of the terrain horizon at the observer azimuth, radians; zero in smooth-ellipsoid mode.
	readonly observerHorizon: Angle
	// Signed surface distance to the terminator in AU, radius × solarAltitude: positive on the day
	// side. Exact for a sphere and a parallel Sun; a local spherical approximation on a tri-axial body.
	readonly terminatorDistance: Distance
	// Whether the solar center clears the horizon (terrain mask or reference plane) and the facet
	// faces it (incidence below PI/2). Smooth-ellipsoid mode cannot see crater or relief shadows.
	readonly sunlit: boolean
	// Whether the observer clears the horizon and the facet faces it (emission below PI/2).
	readonly visible: boolean
}

// Light-angle and viewing constraints for surfaceFeatureWindows. Every bound is inclusive.
export interface SurfaceFeatureWindowOptions extends TimeSearchOptions {
	// Minimum solar-center altitude above the reference tangent plane, radians; defaults to zero.
	// Use -solarAngularRadius to admit the upper limb; -PI/2 disables the bound.
	readonly minSolarAltitude?: Angle
	// Maximum solar-center altitude, radians, for grazing-light windows; unbounded when omitted.
	readonly maxSolarAltitude?: Angle
	// Maximum facet incidence, radians; defaults to PI/2 (the facet faces the Sun); PI disables it.
	readonly maxIncidence?: Angle
	// Minimum observer altitude above the reference tangent plane, radians; defaults to zero.
	readonly minObserverAltitude?: Angle
	// Maximum facet emission, radians; defaults to PI/2 (the facet faces the observer).
	readonly maxEmission?: Angle
}

// Mutable per-epoch geometry shared by one sampler's margins. Angles are radians; distance is AU.
interface FeatureGeometry {
	// Solar-center altitude above the reference tangent plane.
	solarAltitude: number
	// Solar-center azimuth, north through east, in [0, TAU).
	solarAzimuth: number
	// Feature-to-Sun distance.
	solarDistance: number
	// Facet-normal to Sun angle.
	incidence: number
	// Facet-normal to observer angle; NaN without an observer.
	emission: number
	// Sun-feature-observer angle; NaN without an observer.
	phase: number
	// Observer altitude above the reference tangent plane; NaN without an observer.
	observerAltitude: number
	// Observer azimuth, north through east; NaN without an observer.
	observerAzimuth: number
}

// Prepares a crust-fixed feature for illumination geometry. The local frame is built from the
// reference ellipsoid normal at location's planetocentric longitude/latitude (elevation does not
// tilt it). The facet normal is cos(slope)·up + sin(slope)·(cos(aspect)·north + sin(aspect)·east).
// An optional horizon mask is prepared once into an interpolating lookup. Allocates a new feature;
// location is not mutated beyond filling its cached body-fixed position when absent.
export function surfaceFeature(location: BodySurfaceLocation, { slope = 0, aspect = 0, horizon }: SurfaceFeatureOptions = {}): SurfaceFeature {
	const up = bodySurfaceNormal(location)
	// East is z × up; it vanishes only when the normal is exactly polar, where the meridian limit is used.
	const horizontal = Math.hypot(up[0], up[1])
	const east: MutVec3 = horizontal > 0 ? [-up[1] / horizontal, up[0] / horizontal, 0] : [-Math.sin(location.longitude), Math.cos(location.longitude), 0]
	const north = vecNormalizeMut(vecCross(up, east))

	const cosSlope = Math.cos(slope)
	const sinSlope = Math.sin(slope)
	const n = sinSlope * Math.cos(aspect)
	const e = sinSlope * Math.sin(aspect)
	const normal = vecNormalizeMut([cosSlope * up[0] + n * north[0] + e * east[0], cosSlope * up[1] + n * north[1] + e * east[1], cosSlope * up[2] + n * north[2] + e * east[2]])

	const radius = vecLength(bodyFixedPosition(location)) - location.elevation
	const horizonAltitudeAt = horizon === undefined ? undefined : horizonMinimumAltitudeLookup(horizon)

	return { location, up, north, east, normal, radius, horizonAltitudeAt }
}

// Builds a sampler of feature geometry. sunAt and observerAt return body-center-to-target vectors in
// AU and library-base axes; observerAt may be omitted, leaving observer fields NaN. Repeated calls
// with the same Time object reuse the previous evaluation, so margins sharing one coarse epoch share
// one rotation and ephemeris call. Returns the same mutable geometry record on every call.
function featureGeometryAt(feature: SurfaceFeature, sunAt: PositionOverTime, observerAt: PositionOverTime | undefined) {
	const point = bodyFixedPosition(feature.location)
	const { up, north, east, normal } = feature
	const sun = vecZero()
	const observer = vecZero()
	const geometry: FeatureGeometry = { solarAltitude: 0, solarAzimuth: 0, solarDistance: 0, incidence: 0, emission: Number.NaN, phase: Number.NaN, observerAltitude: Number.NaN, observerAzimuth: Number.NaN }
	let last: Time | undefined

	// Feature-to-target body-fixed vector from a body-center-to-target base-axes vector; mutates out.
	function topocentric(target: Vec3, rotation: Mat3, out: MutVec3) {
		matMulVec(rotation, target, out)
		out[0] -= point[0]
		out[1] -= point[1]
		out[2] -= point[2]
	}

	return (time: Time) => {
		if (time === last) return geometry
		last = time

		const rotation = feature.location.frame.rotationAt(time)
		topocentric(sunAt(time), rotation, sun)
		const sunNorth = vecDot(north, sun)
		const sunEast = vecDot(east, sun)
		geometry.solarAltitude = Math.atan2(vecDot(up, sun), Math.hypot(sunNorth, sunEast))
		geometry.solarAzimuth = normalizeAngle(Math.atan2(sunEast, sunNorth))
		geometry.solarDistance = vecLength(sun)
		geometry.incidence = vecAngle(normal, sun)

		if (observerAt !== undefined) {
			topocentric(observerAt(time), rotation, observer)
			const observerNorth = vecDot(north, observer)
			const observerEast = vecDot(east, observer)
			geometry.observerAltitude = Math.atan2(vecDot(up, observer), Math.hypot(observerNorth, observerEast))
			geometry.observerAzimuth = normalizeAngle(Math.atan2(observerEast, observerNorth))
			geometry.emission = vecAngle(normal, observer)
			geometry.phase = vecAngle(sun, observer)
		}

		return geometry
	}
}

// Illumination and viewing geometry of a prepared feature at time. sunAt and observerAt return the
// body-center-to-Sun and body-center-to-observer position vectors in AU and library-base axes at the
// same instant; both are differenced against the feature point, so observer parallax is included.
// The body frame is evaluated at time with no light-time or aberration correction beyond what the
// providers apply. Angles use the solar center; solarAngularRadius supports limb-based thresholds.
// Allocates a fresh result.
export function surfaceFeatureIllumination(feature: SurfaceFeature, sunAt: PositionOverTime, observerAt: PositionOverTime, time: Time): SurfaceFeatureIllumination {
	const geometry = featureGeometryAt(feature, sunAt, observerAt)(time)
	const solarHorizon = feature.horizonAltitudeAt?.(geometry.solarAzimuth) ?? 0
	const observerHorizon = feature.horizonAltitudeAt?.(geometry.observerAzimuth) ?? 0

	return {
		solarAltitude: geometry.solarAltitude,
		solarAzimuth: geometry.solarAzimuth,
		solarAngularRadius: Math.asin(clamp(SUN_RADIUS_AU / geometry.solarDistance, 0, 1)),
		incidence: geometry.incidence,
		emission: geometry.emission,
		phase: geometry.phase,
		observerAltitude: geometry.observerAltitude,
		observerAzimuth: geometry.observerAzimuth,
		solarHorizon,
		observerHorizon,
		terminatorDistance: feature.radius * geometry.solarAltitude,
		sunlit: geometry.solarAltitude > solarHorizon && geometry.incidence < PIOVERTWO,
		visible: geometry.observerAltitude > observerHorizon && geometry.emission < PIOVERTWO,
	}
}

// Finds chronological intervals inside start/stop where every light-angle and viewing constraint
// holds for a prepared feature. Solar constraints always apply: options.minSolarAltitude and
// maxSolarAltitude on the reference tangent plane, options.maxIncidence on the facet, and, with a
// terrain mask, solar-center clearance of that mask. When observerAt is supplied, the observer must
// also satisfy options.minObserverAltitude, options.maxEmission and terrain-mask clearance; pass
// undefined for Sun-only windows. Uses searchIntervals with the caller's step and tolerance (days):
// the step must resolve every constraint crossing, and windows shorter than a step can be missed.
// Geometry is shared across margins at each coarse epoch; refinement re-evaluates per margin.
export function surfaceFeatureWindows(feature: SurfaceFeature, sunAt: PositionOverTime, observerAt: PositionOverTime | undefined, start: Time, stop: Time, options: SurfaceFeatureWindowOptions = {}): TimeInterval[] {
	const { minSolarAltitude = 0, maxSolarAltitude, maxIncidence = PIOVERTWO, minObserverAltitude = 0, maxEmission = PIOVERTWO, step, tolerance } = options
	const geometryAt = featureGeometryAt(feature, sunAt, observerAt)
	const horizonAt = feature.horizonAltitudeAt
	const margins: ((time: Time) => number)[] = [(time) => geometryAt(time).solarAltitude - minSolarAltitude, (time) => maxIncidence - geometryAt(time).incidence]

	if (maxSolarAltitude !== undefined) margins.push((time) => maxSolarAltitude - geometryAt(time).solarAltitude)

	if (horizonAt !== undefined) {
		margins.push((time) => {
			const geometry = geometryAt(time)
			return geometry.solarAltitude - horizonAt(geometry.solarAzimuth)
		})
	}

	if (observerAt !== undefined) {
		margins.push(
			(time) => geometryAt(time).observerAltitude - minObserverAltitude,
			(time) => maxEmission - geometryAt(time).emission,
		)

		if (horizonAt !== undefined) {
			margins.push((time) => {
				const geometry = geometryAt(time)
				return geometry.observerAltitude - horizonAt(geometry.observerAzimuth)
			})
		}
	}

	return searchIntervals(margins, start, stop, { step, tolerance })
}
