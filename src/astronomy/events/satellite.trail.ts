import { ARCSEC_PER_RADIAN, DAYSEC } from '../../core/constants'
import { validatePositiveFinite, validatePositiveInteger } from '../../core/validation'
import { type Vec3, vecAngle, vecNormalize, vecPlus } from '../../math/linear-algebra/vec3'
import { type Angle, normalizeAngle, normalizePI } from '../../math/units/angle'
import { angularDistance, positionAngleBetween } from '../coordinates/coordinate'
import { customEphemerisEndpoint, relativeEphemerisPath } from '../ephemeris/path'
import { earthObserverEphemerisPath, sgp4EphemerisPath } from '../ephemeris/path.adapter'
import { ephemerisAt, equatorialPosition } from '../ephemeris/position'
import type { GeographicPosition } from '../observer/location'
import type { SatRec } from '../orbits/propagation/sgp4'
import { type Time, Timescale, timeShift, timeSubtract, tt } from '../time/time'

// Geometry of a known track across a rectangular sensor, with adaptive geometric topocentric SGP4
// prediction or caller-supplied equatorial samples. Results allocate geometry only, without images. The
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

// One predicted geometric topocentric point in library-base ICRS-oriented axes.
export interface SatelliteTrailPredictionPoint {
	// Evaluation instant, in TT (including exposure-clipped endpoints).
	readonly time: Time
	// Right ascension in radians, in [0, TAU).
	readonly rightAscension: Angle
	// Declination in radians, in [-PI/2, PI/2].
	readonly declination: Angle
	// Dimensionless gnomonic X, centered on the sensor, positive toward sensor +X.
	readonly sensorX: number
	// Dimensionless gnomonic Y, centered on the sensor, positive toward sensor +Y.
	readonly sensorY: number
}

// One continuous sensor visit, represented by its entry-to-exit chord.
export interface SatelliteTrailPrediction {
	// First on-sensor instant, clipped to the exposure start when already inside.
	readonly entry: SatelliteTrailPredictionPoint
	// Last on-sensor instant, clipped to the exposure stop when still inside.
	readonly exit: SatelliteTrailPredictionPoint
	// Great-circle entry-to-exit chord length in radians, not integrated curved arc length.
	readonly length: Angle
	// Entry-to-exit position angle, north toward east, in radians in [0, TAU).
	readonly positionAngle: Angle
	// Chord length in pixels, present only when arcsecPerPixel is supplied.
	readonly lengthPixels?: number
}

// Bounded adaptive sampling controls for satellite exposure prediction.
export interface SatelliteTrailPredictionOptions extends SensorTrailOptions {
	// Maximum accepted sampling span in SI seconds; positive, default 1 second.
	readonly maxStep?: number
	// Maximum midpoint angular interpolation residual in radians; positive, default 0.1 arcsecond.
	// This is a local error estimate, not a certified bound between samples or on grazing-contact time.
	readonly maxInterpolationError?: Angle
	// Maximum propagated instants, including endpoints and refinement probes; positive integer,
	// default 65537. Exhaustion throws RangeError instead of returning an undersampled prediction.
	readonly maxSamples?: number
}

// Cached sample in seconds from the TT exposure start; direction is an owned unit vector.
interface SatelliteTrailSample extends SensorTrackSample {
	// Same-epoch observer-to-satellite direction in library-base ICRS-oriented axes.
	readonly direction: Vec3
}

// Predicts all sampled sensor visits of a prepared satellite from a geographic Earth site during
// [start, stop]. The field center is geometric equatorial RA/Dec in library-base ICRS-oriented axes,
// in radians; field uses the same axes and sensor rotation as sensorTrails. Width/height are in (0, PI).
// No light time, aberration, refraction, occultation, illumination, or pointing correction is applied.
// Sampling uses uniform TT seconds and spherical midpoint residuals, also checking the wrapped
// RA/Dec interpolation used by sensorTrails near poles. Tighten the tolerance for very small fields
// or grazing contacts, and maxStep for fast motion. Accepted midpoints are retained in the track.
// Returns newly allocated Time-valued chords in chronological order; empty/reversed windows return [].
// The SatRec is shallow-copied to isolate SGP4's mutable propagation cache. Shared adaptive endpoints
// retain their evaluations, so each instant is propagated once. Work/storage are bounded by maxSamples;
// throws on budget exhaustion, time-resolution exhaustion, or propagation failure.
export function predictSatelliteTrails(satrec: SatRec, location: GeographicPosition, centerRightAscension: Angle, centerDeclination: Angle, field: SensorField, start: Time, stop: Time, options: SatelliteTrailPredictionOptions = {}): readonly SatelliteTrailPrediction[] {
	const origin = tt(start)
	const duration = timeSubtract(stop, origin, Timescale.TT) * DAYSEC
	if (!(duration > 0)) return []

	// Invalid controls could prevent refinement from terminating or disable its allocation bound.
	const maxStep = validatePositiveFinite(options.maxStep ?? 1)
	const maxError = validatePositiveFinite(options.maxInterpolationError ?? 0.1 / ARCSEC_PER_RADIAN)
	const maxSamples = validatePositiveInteger(options.maxSamples ?? 65537)
	const path = relativeEphemerisPath(sgp4EphemerisPath({ ...satrec }), earthObserverEphemerisPath(location, customEphemerisEndpoint('satellite-trail-observer')))
	const sensorRadius = Math.hypot(Math.tan(field.width / 2), Math.tan(field.height / 2))
	let evaluations = 0

	// Samples an uncached instant in TT seconds; the tree retains and shares this owned result.
	const evaluate = (seconds: number): SatelliteTrailSample => {
		if (evaluations >= maxSamples) throw new RangeError('satellite trail sample budget exhausted')
		evaluations++
		const position = ephemerisAt(path, timeShift(origin, seconds / DAYSEC))
		const [rightAscension, declination] = equatorialPosition(position)
		return { time: seconds, rightAscension, declination, direction: vecNormalize(position.position) }
	}

	// sensorTrails treats a nonprojectable endpoint as a path break. Refine such a segment until
	// its forward endpoint is beyond the sensor's circumscribed circle, so clipping sees the exit.
	const crossesProjectionBoundary = (from: SensorTrackSample, to: SensorTrackSample) => {
		const a = tangentPlane(from.rightAscension, from.declination, centerRightAscension, centerDeclination)
		const b = tangentPlane(to.rightAscension, to.declination, centerRightAscension, centerDeclination)
		if ((a === undefined) === (b === undefined)) return false
		const forward = a ?? b!
		return Math.hypot(forward.east, forward.north) <= sensorRadius
	}

	const first = evaluate(0)
	const last = evaluate(duration)
	const track: SensorTrackSample[] = [first]
	const pending: [SatelliteTrailSample, SatelliteTrailSample][] = [[first, last]]

	while (pending.length > 0) {
		const [from, to] = pending.pop()!
		const middleTime = from.time + (to.time - from.time) * 0.5
		if (!(middleTime > from.time && middleTime < to.time)) throw new RangeError('satellite trail refinement exhausted time resolution')
		const middle = evaluate(middleTime)
		const sphericalMiddle = vecPlus(from.direction, to.direction)
		const sphericalError = vecAngle(middle.direction, sphericalMiddle)
		const coordinateError = angularDistance(middle.rightAscension, middle.declination, from.rightAscension + normalizePI(to.rightAscension - from.rightAscension) * 0.5, (from.declination + to.declination) * 0.5)

		// Wide/antipodal arcs have an ambiguous spherical midpoint and must be split first.
		if (to.time - from.time > maxStep || vecAngle(from.direction, to.direction) > Math.PI / 2 || sphericalError > maxError || coordinateError > maxError || crossesProjectionBoundary(from, middle) || crossesProjectionBoundary(middle, to)) {
			pending.push([middle, to], [from, middle])
		} else {
			track.push(middle, to)
		}
	}

	// Converts clipping's relative seconds back to uniform TT without losing Julian-date precision.
	const point = (value: SensorTrailPoint): SatelliteTrailPredictionPoint => ({ ...value, time: timeShift(origin, value.time / DAYSEC) })
	const predictions: SatelliteTrailPrediction[] = []
	for (const trail of sensorTrails(centerRightAscension, centerDeclination, field, track, options)) {
		predictions.push({ ...trail, entry: point(trail.entry), exit: point(trail.exit) })
	}
	return predictions
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
