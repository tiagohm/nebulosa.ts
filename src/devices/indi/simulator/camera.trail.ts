import { angularDistance, equatorialToJ2000, positionAngleBetween } from '../../../astronomy/coordinates/coordinate'
import type { Time } from '../../../astronomy/time/time'
import type { Angle } from '../../../math/units/angle'
import type { CameraTrailConfig } from './camera.config'
import type { ExposurePointing } from './camera.links'

// Trail circuit of the simulated camera: where the field sat while the shutter was open. The mount's
// recorded boresight is read at a few instants evenly spaced over the exposure, and the stars are drawn
// along the polyline through those positions, each stretch carrying the share of the exposure it
// lasted. Nothing depends on how fast the field moved: a stretch crossed in a slew spreads its share
// over so long a path that it fades into the noise by itself. Angles are radians and times
// milliseconds.

// Distance along the tube's up direction of the point that carries the orientation into J2000,
// radians: small enough to stay local, large enough to stay far above rounding.
const ORIENTATION_PROBE = 1e-4

// A position of the field during the exposure.
export interface TrailVertex {
	// Boresight, J2000.
	readonly rightAscension: Angle
	readonly declination: Angle
	// Position angle of the tube's up direction at the boresight, east of north in J2000.
	readonly positionAngle: Angle
}

// The path of the field over one exposure.
export interface ExposureTrail {
	// Positions evenly spaced in time, at least one. A single vertex is a field that stood still; with
	// more, each stretch between consecutive vertices carries an equal share of the exposure.
	readonly vertices: readonly TrailVertex[]
	// Vertex the scene is centred on: the one in the middle of the exposure.
	readonly reference: TrailVertex
	// Largest distance from the reference to a vertex, radians, capped at the configured extent.
	readonly extent: Angle
}

// Point `distance` radians from (`rightAscension`, `declination`) towards `positionAngle`, east of
// north, in the same frame. Built from the local north and east vectors, which stay defined at a pole,
// where the right ascension gives the basis.
export function offsetAlongPositionAngle(rightAscension: Angle, declination: Angle, positionAngle: Angle, distance: Angle): [Angle, Angle] {
	const cosRa = Math.cos(rightAscension)
	const sinRa = Math.sin(rightAscension)
	const cosDec = Math.cos(declination)
	const sinDec = Math.sin(declination)
	const cosDistance = Math.cos(distance)
	const sinDistance = Math.sin(distance)
	const north = Math.cos(positionAngle) * sinDistance
	const east = Math.sin(positionAngle) * sinDistance
	const x = cosDec * cosRa * cosDistance - north * sinDec * cosRa - east * sinRa
	const y = cosDec * sinRa * cosDistance - north * sinDec * sinRa + east * cosRa
	const z = sinDec * cosDistance + north * cosDec
	return [Math.atan2(y, x), Math.atan2(z, Math.hypot(x, y))]
}

// Takes a boresight and the position angle of the tube's up direction there, both in the equatorial
// frame of date at `time`, into J2000. Precession and nutation rotate the local basis as well as moving
// the point, by a degree or more near the pole, so the orientation is carried by a probe point.
export function trailVertexInJ2000(rightAscension: Angle, declination: Angle, positionAngle: Angle, time: Time): TrailVertex {
	const [probeRightAscension, probeDeclination] = offsetAlongPositionAngle(rightAscension, declination, positionAngle, ORIENTATION_PROBE)
	const [ra, dec] = equatorialToJ2000(rightAscension, declination, time)
	const [probeRa, probeDec] = equatorialToJ2000(probeRightAscension, probeDeclination, time)
	return { rightAscension: ra, declination: dec, positionAngle: positionAngleBetween(ra, dec, probeRa, probeDec) }
}

// Builds the trail of an exposure of `exposureTime` seconds that began as `pointing` describes, for a
// sensor of `pixelScale` radians per pixel. `buffer` receives the boresight samples and must hold
// 2 × `config.vertices` values.
//
// Without a simulated mount the field stands at the reported coordinate, and without any mount at an
// arbitrary point of the sky with north up. The trail is read as the mount recorded it: the camera
// notices the end of its exposure on its own tick, so the last stretch may end up to one mount tick
// short, which is far below anything a frame shows. A path shorter than `config.spacing` pixels is a
// field that stood still, drawn at its position in the middle of the exposure.
export function exposureTrail(pointing: ExposurePointing, exposureTime: number, pixelScale: Angle, config: CameraTrailConfig, buffer: Float64Array): ExposureTrail {
	const { center, source, time, orientation } = pointing
	if (center === undefined) return stationaryTrail({ rightAscension: 0, declination: 0, positionAngle: 0 })

	const count = source?.sampleBoresightTrajectory(pointing.startTime, pointing.startTime + Math.trunc(exposureTime * 1000), Math.max(2, config.vertices), buffer) ?? 0
	if (count === 0) return stationaryTrail(trailVertexInJ2000(center[0], center[1], orientation, time))

	let length = 0

	for (let i = 0; i < count - 1; i++) {
		length += angularDistance(buffer[i * 2], buffer[i * 2 + 1], buffer[i * 2 + 2], buffer[i * 2 + 3]) / pixelScale
	}

	const middle = count >> 1
	if (count === 1 || length < config.spacing) return stationaryTrail(trailVertexInJ2000(buffer[middle * 2], buffer[middle * 2 + 1], orientation, time))

	const vertices = new Array<TrailVertex>(count)
	for (let i = 0; i < count; i++) vertices[i] = trailVertexInJ2000(buffer[i * 2], buffer[i * 2 + 1], orientation, time)

	const reference = vertices[middle]
	let extent = 0
	for (const vertex of vertices) extent = Math.max(extent, angularDistance(reference.rightAscension, reference.declination, vertex.rightAscension, vertex.declination))

	return { vertices, reference, extent: Math.min(extent, config.maxExtent * pixelScale) }
}

// Trail of a field that stood still at `vertex` for the whole exposure.
function stationaryTrail(vertex: TrailVertex): ExposureTrail {
	return { vertices: [vertex], reference: vertex, extent: 0 }
}
