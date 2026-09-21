import type { MutVec3, Vec3 } from '../../math/linear-algebra/vec3'
import type { Angle } from '../../math/units/angle'
import type { Distance } from '../../math/units/distance'
import type { PositionAndVelocity, PositionAndVelocityOverTime } from '../coordinates/astrometry'
import { frameToBase, type Frame } from '../coordinates/frame'
import type { Time } from '../time/time'

// Generic body-surface locations on a rotating tri-axial ellipsoid. A fixed planetocentric
// longitude/latitude/elevation is converted once into a body-fixed Cartesian point and then
// transformed through any `Frame` (IAU/WGCCRE via bodyFixedFrame, or a SPICE/PCK frame) to the
// library base. The resulting body-relative inertial state includes the rotational velocity from
// Frame.dRdtTimesRtAt; composing with a body-center ephemeris yields a normal
// PositionAndVelocityOverTime. Angles are radians, distances AU, velocities AU/day. Elevation is a
// radial offset along the planetocentric direction, not a planetographic/geodetic height.

// Zero body-fixed velocity of a crust-fixed point. frameToBase reads it and writes the inertial
// velocity into a separate output, so this shared rest vector is not mutated.
const BODY_FIXED_REST: Vec3 = [0, 0, 0]

// Reference tri-axial ellipsoid in a body-fixed frame.
export interface BodyShape {
	// Semi-axes along body-fixed +X, +Y and +Z, in AU.
	readonly radii: readonly [Distance, Distance, Distance]
}

// A crust-fixed point in planetocentric coordinates on `shape`, oriented by `frame`.
export interface BodySurfaceLocation {
	// Planetocentric east-positive longitude around body-fixed +Z, in radians.
	readonly longitude: Angle
	// Planetocentric latitude from the body-fixed equatorial plane toward +Z, in radians.
	readonly latitude: Angle
	// Radial distance above the reference tri-axial ellipsoid, in AU.
	readonly elevation: Distance
	// Body-fixed frame relative to the library base (GCRS/ICRS-oriented).
	readonly frame: Frame
	// Reference tri-axial ellipsoid in the body-fixed frame.
	readonly shape: BodyShape
	// Cached body-fixed Cartesian position (AU). Filled by bodySurfaceLocation and reused by
	// bodySurfaceState; longitude, latitude, elevation, and shape are treated as immutable after
	// construction.
	bodyFixed?: Vec3
}

// Builds a BodyShape from a 3-vector of AU semi-axes or from a {x, y, z} radii record such as
// the BODY{id}_RADII values returned by bodyRadii. Does not import the kernel parser.
export function bodyShape(radii: readonly [Distance, Distance, Distance] | { readonly x: Distance; readonly y: Distance; readonly z: Distance }): BodyShape {
	if ('x' in radii) return { radii: [radii.x, radii.y, radii.z] }
	return { radii: [radii[0], radii[1], radii[2]] }
}

// Planetocentric Cartesian position (AU) of a surface point in the body-fixed frame.
//
// For unit direction u = [cos(lat) cos(lon), cos(lat) sin(lon), sin(lat)] the ray/ellipsoid
// intersection scale is s = 1 / sqrt(ux²/a² + uy²/b² + uz²/c²) and the point is (s + elevation) u.
// Latitude is planetocentric (angle from the body-fixed equatorial plane), not planetographic.
// Longitude is east-positive around +Z; cos/sin make it 2π-periodic, including wrap and the
// conventional unused longitude at the poles.
function planetocentricPosition(location: BodySurfaceLocation): MutVec3 {
	const [a, b, c] = location.shape.radii
	const cosLat = Math.cos(location.latitude)
	const ux = cosLat * Math.cos(location.longitude)
	const uy = cosLat * Math.sin(location.longitude)
	const uz = Math.sin(location.latitude)
	const s = 1 / Math.sqrt((ux * ux) / (a * a) + (uy * uy) / (b * b) + (uz * uz) / (c * c))
	const r = s + location.elevation
	return [r * ux, r * uy, r * uz]
}

// Cached body-fixed Cartesian position of `location`, computing it on first use.
function bodyFixedPosition(location: BodySurfaceLocation): Vec3 {
	return (location.bodyFixed ??= planetocentricPosition(location))
}

// Creates a crust-fixed planetocentric location and caches its body-fixed Cartesian position.
// Longitude, latitude, elevation, and shape are treated as immutable after construction so the
// cached point needs no per-call trigonometry.
export function bodySurfaceLocation(longitude: Angle, latitude: Angle, elevation: Distance, shape: BodyShape, frame: Frame): BodySurfaceLocation {
	const location: BodySurfaceLocation = { longitude, latitude, elevation, shape, frame }
	location.bodyFixed = planetocentricPosition(location)
	return location
}

// Body-relative inertial position (AU) and rotational velocity (AU/day) of a crust-fixed point.
//
// The cached body-fixed Cartesian position is treated as the stationary state [r_fixed, 0] and
// transformed with frameToBase, so a rotating Frame contributes v = Rᵀ (ω × r_fixed) through
// W = dR/dt·Rᵀ rather than a finite-difference of positions. Pass `out` to reuse a state pair;
// `out` may alias a previous return from this function. The result is relative to the body
// center, in the library base (GCRS/ICRS-oriented) axes.
export function bodySurfaceState(location: BodySurfaceLocation, time: Time, out?: PositionAndVelocity): PositionAndVelocity {
	return frameToBase([bodyFixedPosition(location), BODY_FIXED_REST], location.frame, time, out)
}

// Composes a body-center ephemeris with a crust-fixed location into a PositionAndVelocityOverTime.
//
// At each time the sampler returns p_body + p_surface and v_body + v_surface in the shared
// barycentric ICRS/BCRS axes, so the surface point can be passed anywhere a body ephemeris is
// already accepted. Each call allocates a fresh state pair; the body-fixed point stays cached
// on `location`.
export function bodySurfacePositionAndVelocity(body: PositionAndVelocityOverTime, location: BodySurfaceLocation): PositionAndVelocityOverTime {
	const surface: PositionAndVelocity = [
		[0, 0, 0],
		[0, 0, 0],
	]

	return (time) => {
		const [bp, bv] = body(time)
		const [sp, sv] = bodySurfaceState(location, time, surface)
		return [
			[bp[0] + sp[0], bp[1] + sp[1], bp[2] + sp[2]],
			[bv[0] + sv[0], bv[1] + sv[1], bv[2] + sv[2]],
		]
	}
}
