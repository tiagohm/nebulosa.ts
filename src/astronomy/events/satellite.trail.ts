import { ARCSEC_PER_RADIAN } from '../../core/constants'
import { type Angle, normalizeAngle, normalizePI } from '../../math/units/angle'
import { angularDistance, positionAngleBetween } from '../coordinates/coordinate'

// Geometry of a known track across a rectangular sensor. The caller supplies the bore-sight and the
// track as equatorial samples over the exposure; this module does not propagate a satellite. The
// sensor is a gnomonic rectangle: half-width and half-height are tan of half the field, so a 1° field
// is the tangent of 0.5° on the plane. Position angle rotates sensor +Y from celestial north toward
// east, and sensor +X is 90° from that toward the east, matching the mosaic planner. Angles are radians.

// Rectangular field centered on a bore-sight.
export interface SensorField {
	// Angular width of the sensor, in radians.
	readonly width: Angle
	// Angular height of the sensor, in radians.
	readonly height: Angle
	// Position angle of sensor +Y from celestial north toward east, in radians. Defaults to 0.
	readonly positionAngle?: Angle
}

// One equatorial sample of a track. Time is any uniform unit shared by the samples.
export interface SensorTrackSample {
	// Time in the caller's unit.
	readonly time: number
	// Right ascension in radians.
	readonly rightAscension: Angle
	// Declination in radians.
	readonly declination: Angle
}

// One end of the visible chord, on the sky and on the sensor plane.
export interface SensorTrailPoint {
	// Time in the track's unit.
	readonly time: number
	// Right ascension in radians.
	readonly rightAscension: Angle
	// Declination in radians.
	readonly declination: Angle
	// Dimensionless sensor-plane X gnomonic coordinate. Positive is sensor +X.
	readonly sensorX: number
	// Dimensionless sensor-plane Y gnomonic coordinate. Positive is sensor +Y.
	readonly sensorY: number
}

// The portion of a track that lies on the sensor.
export interface SensorTrail {
	// First visible point in time.
	readonly entry: SensorTrailPoint
	// Last visible point in time.
	readonly exit: SensorTrailPoint
	// Great-circle length of the visible chord, in radians.
	readonly length: Angle
	// Position angle of the chord from entry toward exit, from celestial north toward east, in [0, 2π).
	readonly positionAngle: Angle
	// Length in pixels. Present when an image scale was supplied.
	readonly lengthPixels?: number
}

// Options for projecting a track onto a sensor.
export interface SensorTrailOptions {
	// Image scale in arcseconds per pixel. When set, each trail also carries lengthPixels.
	readonly arcsecPerPixel?: number
}

// East/north gnomonic coordinates, or undefined when the point is not on the forward hemisphere.
function tangentPlane(rightAscension: Angle, declination: Angle, centerRightAscension: Angle, centerDeclination: Angle) {
	const deltaRightAscension = normalizePI(rightAscension - centerRightAscension)
	const sinDeclination = Math.sin(declination)
	const cosDeclination = Math.cos(declination)
	const sinCenter = Math.sin(centerDeclination)
	const cosCenter = Math.cos(centerDeclination)
	const cosDelta = Math.cos(deltaRightAscension)
	const denominator = sinDeclination * sinCenter + cosDeclination * cosCenter * cosDelta
	if (!(denominator > 1e-12)) return undefined
	return { east: (cosDeclination * Math.sin(deltaRightAscension)) / denominator, north: (sinDeclination * cosCenter - cosDeclination * sinCenter * cosDelta) / denominator }
}

// Rotates east/north into sensor axes. Position angle zero leaves +X east and +Y north.
function sensorAxes(east: number, north: number, positionAngle: Angle) {
	const sin = Math.sin(positionAngle)
	const cos = Math.cos(positionAngle)
	return { x: east * cos - north * sin, y: east * sin + north * cos }
}

// Liang–Barsky clip of a segment against the centered rectangle. Returns the parameter interval inside it.
function clipSegment(x0: number, y0: number, x1: number, y1: number, halfWidth: number, halfHeight: number) {
	let t0 = 0
	let t1 = 1

	const dx = x1 - x0
	const dy = y1 - y0
	const p = [-dx, dx, -dy, dy]
	const q = [x0 + halfWidth, halfWidth - x0, y0 + halfHeight, halfHeight - y0]

	for (let edge = 0; edge < 4; edge++) {
		const direction = p[edge]
		const distance = q[edge]

		if (direction === undefined || distance === undefined) return undefined

		if (direction === 0) {
			if (distance < 0) return undefined
			continue
		}

		const ratio = distance / direction

		if (direction < 0) {
			if (ratio > t1) return undefined
			if (ratio > t0) t0 = ratio
		} else {
			if (ratio < t0) return undefined
			if (ratio < t1) t1 = ratio
		}
	}

	return t0 <= t1 ? { t0, t1 } : undefined
}

// Visible chords of a track across a sensor.
// Parameters: centerRightAscension and centerDeclination are the bore-sight in radians. field is the
// sensor. track is the equatorial path in time order; it is sorted by time. options.arcsecPerPixel
// adds a pixel length. Returns one trail per continuous visit to the sensor, in time order. A track
// that misses the rectangle returns an empty list. Samples on the far hemisphere are breaks in the
// path. The length is the great-circle distance between the entry and exit, and the position angle
// runs from the entry toward the exit.
export function sensorTrails(centerRightAscension: Angle, centerDeclination: Angle, field: SensorField, track: readonly SensorTrackSample[], options: SensorTrailOptions = {}): readonly SensorTrail[] {
	if (track.length < 2 || !(field.width > 0) || !(field.height > 0)) return []
	const ordered = track.toSorted((a, b) => a.time - b.time)
	const positionAngle = field.positionAngle ?? 0
	const halfWidth = Math.tan(field.width * 0.5)
	const halfHeight = Math.tan(field.height * 0.5)
	const trails: SensorTrail[] = []

	const project = (sample: SensorTrackSample) => {
		const tangent = tangentPlane(sample.rightAscension, sample.declination, centerRightAscension, centerDeclination)
		if (tangent === undefined) return undefined
		const sensor = sensorAxes(tangent.east, tangent.north, positionAngle)
		return { sample, ...sensor }
	}

	const sampleAt = (from: SensorTrackSample, to: SensorTrackSample, fraction: number): SensorTrackSample => ({
		time: from.time + (to.time - from.time) * fraction,
		rightAscension: normalizeAngle(from.rightAscension + normalizePI(to.rightAscension - from.rightAscension) * fraction),
		declination: from.declination + (to.declination - from.declination) * fraction,
	})

	const boundaryMargin = (from: SensorTrackSample, to: SensorTrackSample, fraction: number) => {
		const point = project(sampleAt(from, to, fraction))
		if (point === undefined) return Number.POSITIVE_INFINITY
		return Math.max(Math.abs(point.x) / halfWidth, Math.abs(point.y) / halfHeight) - 1
	}

	const refineBoundary = (from: SensorTrackSample, to: SensorTrackSample, outside: number, inside: number) => {
		let low = outside
		let high = inside

		for (let step = 0; step < 52; step++) {
			const middle = (low + high) * 0.5
			if (boundaryMargin(from, to, middle) > 0) low = middle
			else high = middle
		}

		return high
	}

	for (let i = 0; i < ordered.length - 1; i++) {
		const from = ordered[i]
		const to = ordered[i + 1]
		if (from === undefined || to === undefined || !(to.time > from.time)) continue

		const start = project(from)
		const end = project(to)
		if (start === undefined || end === undefined) continue

		const clipped = clipSegment(start.x, start.y, end.x, end.y, halfWidth, halfHeight)
		if (clipped === undefined) continue

		const middle = (clipped.t0 + clipped.t1) * 0.5
		const entryFraction = clipped.t0 === 0 ? 0 : refineBoundary(from, to, 0, middle)
		const exitFraction = clipped.t1 === 1 ? 1 : refineBoundary(from, to, 1, middle)
		const interpolate = (fraction: number): SensorTrailPoint => {
			const sample = sampleAt(from, to, fraction)
			const sensor = project(sample)
			return {
				time: sample.time,
				rightAscension: sample.rightAscension,
				declination: sample.declination,
				sensorX: sensor?.x ?? Number.NaN,
				sensorY: sensor?.y ?? Number.NaN,
			}
		}
		const entry = interpolate(entryFraction)
		const exit = interpolate(exitFraction)
		const length = angularDistance(entry.rightAscension, entry.declination, exit.rightAscension, exit.declination)
		const trail: SensorTrail = { entry, exit, length, positionAngle: positionAngleBetween(entry.rightAscension, entry.declination, exit.rightAscension, exit.declination) }
		trails.push(options.arcsecPerPixel === undefined ? trail : { ...trail, lengthPixels: (length * ARCSEC_PER_RADIAN) / options.arcsecPerPixel })
	}

	return joinVisits(trails, options.arcsecPerPixel)
}

// Joins successive clipped segments that meet at a shared sample, so a track that stays on the sensor
// is one chord from its first entry to its last exit.
function joinVisits(trails: readonly SensorTrail[], arcsecPerPixel: number | undefined) {
	const joined: SensorTrail[] = []

	for (let i = 0; i < trails.length; i++) {
		const trail = trails[i]
		if (trail === undefined) continue

		const previous = joined.at(-1)
		const continuous = previous !== undefined && Math.abs(previous.exit.time - trail.entry.time) <= 1e-9 * Math.max(1, Math.abs(trail.entry.time))

		if (!continuous || previous === undefined) {
			joined.push(trail)
			continue
		}

		const length = angularDistance(previous.entry.rightAscension, previous.entry.declination, trail.exit.rightAscension, trail.exit.declination)
		const combined: SensorTrail = { entry: previous.entry, exit: trail.exit, length, positionAngle: positionAngleBetween(previous.entry.rightAscension, previous.entry.declination, trail.exit.rightAscension, trail.exit.declination) }
		joined[joined.length - 1] = arcsecPerPixel === undefined ? combined : { ...combined, lengthPixels: (length * ARCSEC_PER_RADIAN) / arcsecPerPixel }
	}

	return joined
}
