import { ECLIPTIC_J2000_MATRIX, GM_EARTH, PIOVERTWO } from '../../core/constants'
import { matTransposeMulVec } from '../../math/linear-algebra/mat3'
import { type MutVec3, type Vec3, vecCross, vecDot, vecLength, vecNormalize } from '../../math/linear-algebra/vec3'
import { sphericalGreatCirclePole, sphericalInterpolate } from '../../math/numerical/geometry'
import { type Angle, normalizeAngle } from '../../math/units/angle'
import { kilometer, type Distance } from '../../math/units/distance'
import type { Velocity } from '../../math/units/velocity'
import { equatorial } from '../coordinates/astrometry'
import { equatorialToJ2000, horizontalToEquatorial } from '../coordinates/coordinate'
import { itrs } from '../coordinates/itrs'
import { Ellipsoid, geodeticLocation, localSiderealTime, type GeographicPosition } from '../observer/location'
import { gcrsToItrsRotationMatrix, instantaneousEarthAngularVelocity, type Time } from '../time/time'
import { meteorRadiantHorizontal, meteorRadiantVector } from './radiant'
import type { MeteorGravityOptions, MeteorHorizontalInput, MeteorHorizontalRadiant, MeteorRadiant, MeteorTrack } from './types'

// Meteor trajectory corrections in the local horizontal system and GCRS velocity frame. Speeds are
// AU/day, distances AU, and zenith angles radians. Atmospheric drag is excluded; the entry height
// is always measured from an explicit reference ellipsoid.

// Computes the speed at geocentric distance from an asymptotic geocentric speed using Earth's GM.
export function meteorSpeedAtDistance(geocentricSpeed: Velocity, distanceFromCenter: Distance): Velocity {
	return Math.sqrt(geocentricSpeed * geocentricSpeed + (2 * GM_EARTH) / distanceFromCenter)
}

// Computes the geocentric radius of a geodetic latitude and entry height on an ellipsoid.
export function meteorGeocentricRadius(latitude: Angle, entryAltitude: Distance = 0, ellipsoid: Ellipsoid = Ellipsoid.IERS2010): Distance {
	const position = geodeticLocation(0, latitude, entryAltitude, ellipsoid)
	return vecLength(itrs(position))
}

// Computes the speed at a geodetic entry altitude, deriving the ellipsoidal center distance first.
export function meteorSpeedAtGeodeticAltitude(geocentricSpeed: Velocity, latitude: Angle, entryAltitude: Distance, ellipsoid: Ellipsoid = Ellipsoid.IERS2010): Velocity {
	return meteorSpeedAtDistance(geocentricSpeed, meteorGeocentricRadius(latitude, entryAltitude, ellipsoid))
}

// Concise alias for the ellipsoid-aware entry-speed calculation.
export const meteorSpeedAtEntry = meteorSpeedAtGeodeticAltitude

// Computes Schiaparelli's zenith attraction Δz for an apparent entry zenith angle.
export function meteorZenithAttraction(apparentZenith: Angle, geocentricSpeed: Velocity, entrySpeed: Velocity): Angle {
	return 2 * Math.atan2((entrySpeed - geocentricSpeed) * Math.tan(apparentZenith * 0.5), entrySpeed + geocentricSpeed)
}

// Converts an apparent entry zenith angle to its asymptotic geocentric zenith angle.
export function geocentricZenithAngleFromApparent(apparentZenith: Angle, geocentricSpeed: Velocity, entrySpeed: Velocity): Angle {
	return apparentZenith + meteorZenithAttraction(apparentZenith, geocentricSpeed, entrySpeed)
}

// Concise alias for the forward Schiaparelli transformation.
export const meteorGeocentricZenithAngle = geocentricZenithAngleFromApparent

// Inverts the zenith-attraction relation numerically. The monotone bisection is stable at the zenith
// and at the horizon, where directly subtracting a correction evaluated at the wrong angle is biased.
export function apparentZenithAngleFromGeocentric(geocentricZenith: Angle, geocentricSpeed: Velocity, entrySpeed: Velocity, tolerance: Angle = 1e-12): Angle | undefined {
	if (geocentricZenith < 0 || geocentricZenith > PIOVERTWO) return undefined
	let low = 0
	let high = geocentricZenith
	for (let iteration = 0; iteration < 100; iteration++) {
		const middle = (low + high) * 0.5
		const value = geocentricZenithAngleFromApparent(middle, geocentricSpeed, entrySpeed)
		if (value > geocentricZenith) high = middle
		else low = middle
		if (high - low <= tolerance) break
	}
	return (low + high) * 0.5
}

// Concise alias for the numerically inverted Schiaparelli transformation.
export const meteorApparentZenithAngle = apparentZenithAngleFromGeocentric

// Applies gravitational attraction to a geocentric J2000 radiant and returns its apparent local
// horizontal radiant. A geocentric radiant below the geometric horizon is outside this approximation.
export function apparentMeteorRadiantHorizontal(radiant: MeteorRadiant, observer: GeographicPosition, time: Time, options: MeteorGravityOptions): MeteorHorizontalRadiant | undefined {
	const geometric = meteorRadiantHorizontal(radiant, observer, time)
	if (!(geometric.altitude > 0)) return undefined
	const entrySpeed = meteorSpeedAtGeodeticAltitude(options.geocentricSpeed, observer.latitude, options.entryAltitude, options.ellipsoid ?? Ellipsoid.IERS2010)
	const geocentricZenith = PIOVERTWO - geometric.altitude
	const apparentZenith = apparentZenithAngleFromGeocentric(geocentricZenith, options.geocentricSpeed, entrySpeed)
	if (apparentZenith === undefined) return undefined
	const altitude = PIOVERTWO - apparentZenith
	const corrected = horizontalToEquatorial(geometric.azimuth, altitude, observer.latitude, localSiderealTime(time, observer))
	const [rightAscension, declination] = equatorialToJ2000(corrected[0], corrected[1], time)
	return { rightAscension: normalizeAngle(rightAscension), declination, rightAscensionOfDate: normalizeAngle(corrected[0]), declinationOfDate: corrected[1], azimuth: geometric.azimuth, altitude, time }
}

// Converts an apparent horizontal radiant back to the geocentric J2000 radiant by numerically
// removing zenith attraction. Refraction is not part of this inverse.
export function geocentricMeteorRadiantFromHorizontal(horizontal: MeteorHorizontalInput | MeteorHorizontalRadiant, observer: GeographicPosition, time: Time, options: MeteorGravityOptions): MeteorRadiant | undefined {
	if (!(horizontal.altitude > 0)) return undefined
	const entrySpeed = meteorSpeedAtGeodeticAltitude(options.geocentricSpeed, observer.latitude, options.entryAltitude, options.ellipsoid ?? Ellipsoid.IERS2010)
	const apparentZenith = PIOVERTWO - horizontal.altitude
	const geocentricZenith = geocentricZenithAngleFromApparent(apparentZenith, options.geocentricSpeed, entrySpeed)
	if (geocentricZenith > PIOVERTWO) return undefined
	const [rightAscensionOfDate, declinationOfDate] = horizontalToEquatorial(horizontal.azimuth, PIOVERTWO - geocentricZenith, observer.latitude, localSiderealTime(time, observer))
	const [rightAscension, declination] = equatorialToJ2000(rightAscensionOfDate, declinationOfDate, time)
	return { rightAscension: normalizeAngle(rightAscension), declination }
}

// Returns the observer's rotational velocity in GCRS, using the ITRS position and instantaneous
// Earth angular velocity. This is a velocity-frame correction only and contains no gravity term.
export function meteorObserverRotationVelocity(observer: GeographicPosition, time: Time): Vec3 {
	const itrsPosition = itrs(observer)
	const rotationalItrs = vecCross(instantaneousEarthAngularVelocity(time), itrsPosition)
	return matTransposeMulVec(gcrsToItrsRotationMatrix(time), rotationalItrs)
}

// Applies the observer-rotation correction to a geocentric incoming meteor velocity and returns the
// corrected incoming radiant in the same GCRS/J2000 equatorial frame.
export function meteorRadiantWithEarthRotation(radiant: MeteorRadiant, geocentricSpeed: Velocity, observer: GeographicPosition, time: Time): MeteorRadiant | undefined {
	const direction = meteorRadiantVector(radiant)
	const geocentricVelocity: Vec3 = [-geocentricSpeed * direction[0], -geocentricSpeed * direction[1], -geocentricSpeed * direction[2]]
	const observerVelocity = meteorObserverRotationVelocity(observer, time)
	const relative: MutVec3 = [geocentricVelocity[0] - observerVelocity[0], geocentricVelocity[1] - observerVelocity[1], geocentricVelocity[2] - observerVelocity[2]]
	const relativeSpeed = vecLength(relative)
	if (!(relativeSpeed > 0)) return undefined
	const corrected = vecNormalize([-relative[0], -relative[1], -relative[2]])
	const [rightAscension, declination] = equatorial(corrected)
	return { rightAscension: normalizeAngle(rightAscension), declination }
}

// Alias for applications that describe the same correction as a topocentric velocity adjustment.
export const meteorRadiantRotationCorrection = meteorRadiantWithEarthRotation
export const meteorRadiantWithRotation = meteorRadiantWithEarthRotation

// Returns the unit pole of a non-degenerate great circle through a J2000 equatorial track. A
// coincident or antipodal pair does not define a unique plane and therefore returns undefined.
export function meteorTrackGreatCircle(track: MeteorTrack): Vec3 | undefined {
	const start = meteorRadiantVector(track.start)
	const end = meteorRadiantVector(track.end)
	const pole = sphericalGreatCirclePole(start, end)
	return vecLength(pole) <= 1e-15 || vecDot(start, end) <= -1 + 1e-15 ? undefined : pole
}

// Returns the angular residual of a radiant from the track great-circle plane, in radians.
export function meteorRadiantTrackResidual(radiant: MeteorRadiant, track: MeteorTrack): Angle | undefined {
	const pole = meteorTrackGreatCircle(track)
	if (pole === undefined) return undefined
	const value = Math.min(1, Math.max(-1, Math.abs(vecDot(meteorRadiantVector(radiant), pole))))
	return Math.asin(value)
}

// Checks whether the observed trail moves away from the radiant along its short observed arc.
// Degenerate tracks have no direction and return undefined.
export function meteorTrackDirectionCompatible(radiant: MeteorRadiant, track: MeteorTrack): boolean | undefined {
	const start = meteorRadiantVector(track.start)
	const end = meteorRadiantVector(track.end)
	const distance = vecLength(vecCross(start, end))
	if (!(distance > 1e-15)) return undefined
	return angularSeparationVectors(meteorRadiantVector(radiant), end) > angularSeparationVectors(meteorRadiantVector(radiant), start)
}

// Returns the observed great-circle length in radians.
export function meteorTrackLength(track: MeteorTrack): Angle | undefined {
	return meteorTrackGreatCircle(track) === undefined ? undefined : angularSeparationVectors(meteorRadiantVector(track.start), meteorRadiantVector(track.end))
}

// Returns a point along the short great-circle trail, or undefined for a degenerate/antipodal pair.
export function meteorTrackPoint(track: MeteorTrack, fraction: number): MeteorRadiant | undefined {
	const length = meteorTrackLength(track)
	if (length === undefined) return undefined
	const [rightAscension, declination] = sphericalInterpolate(track.start.rightAscension, track.start.declination, track.end.rightAscension, track.end.declination, fraction)
	return { rightAscension, declination }
}

function angularSeparationVectors(first: Vec3, second: Vec3): Angle {
	return Math.atan2(vecLength(vecCross(first, second)), vecDot(first, second))
}

// Distance-unit convenience for callers expressing an entry height in kilometers.
export function meteorEntryAltitudeKilometers(value: number): Distance {
	return kilometer(value)
}
