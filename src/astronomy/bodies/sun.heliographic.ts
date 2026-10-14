import { SPEED_OF_LIGHT_AU_DAY, SUN_RADIUS_AU } from '../../core/constants'
import { matMulVec, matTransposeMulVec } from '../../math/linear-algebra/mat3'
import { type Vec3, vecLength, vecPositionAngle } from '../../math/linear-algebra/vec3'
import { clamp } from '../../math/numerical/math'
import { type Angle, normalizeAngle, normalizePI } from '../../math/units/angle'
import type { Distance } from '../../math/units/distance'
import type { PositionAndVelocity } from '../coordinates/astrometry'
import { annualAberration } from '../coordinates/correction'
import { Solar, SolarDisk } from '../ephemeris/meeus'
import { precessionNutationMatrix, type Time, Timescale, timeSubtract, toJulianDay, tt } from '../time/time'
import { orientation, SUN_ROTATION, subObserverPoint } from './orientation'

// Observed solar-disk geometry and heliographic feature coordinates. Computes the position angle P
// of the solar rotation axis, the heliographic latitude B0 and the Carrington longitude L0 of the
// disk centre seen by an observer, maps helioprojective directions and image pixels onto the visible
// solar sphere (Stonyhurst and Carrington longitudes) and back, and propagates features by
// differential rotation. Angles are radians, distances AU and rotation rates radians per day.
//
// Conventions: heliographic latitude is positive toward solar north. Stonyhurst longitude is
// measured from the observer's central meridian, positive toward solar west (the direction of
// rotation), in (-PI, PI]. Carrington longitude is the IAU planetocentric east longitude of
// SUN_ROTATION (W0 = 84.176 deg, 14.1844 deg/day sidereal), in [0, TAU); at the disk centre it
// decreases with time, and Carrington = Stonyhurst + L0. Helioprojective tx/ty are observer-centred
// angles from the disk centre, tx positive toward solar west and ty toward the projected solar
// north. Image pixels have centres at integers, origin upper left, +X right and +Y down. The solar
// sphere has the IAU 2015 nominal radius. Every result is freshly allocated; no input is mutated.

// Longitude system of a heliographic coordinate.
export type HeliographicLongitudeSystem = 'stonyhurst' | 'carrington'

// Solar-disk orientation model: the IAU rotation elements with a caller ephemeris, or Meeus ch. 29.
export type SolarDiskModel = 'iau' | 'meeus'

// Celestial north that an image position angle is measured from: the true equator and equinox of
// date, or ICRS (a J2000/ICRS plate solution).
export type SolarImageNorth = 'date' | 'icrs'

// Observed orientation and size of the solar disk at one instant for one observer.
export interface SolarDiskGeometry {
	// Model that produced the angles.
	readonly model: SolarDiskModel
	// Observation (reception) instant.
	readonly time: Time
	// Position angle of the solar north pole at the apparent disk centre, measured from the north of
	// the true equator and equinox of date toward east, in (-PI, PI].
	readonly p: Angle
	// The same position angle measured from ICRS north, in (-PI, PI].
	readonly pIcrs: Angle
	// Heliographic latitude of the disk centre (sub-observer point), in [-PI/2, PI/2].
	readonly b0: Angle
	// Carrington longitude of the disk centre, in [0, TAU). Not the fractional Carrington rotation number.
	readonly l0: Angle
	// Observer to Sun-centre distance, in AU.
	readonly distance: Distance
	// Apparent angular radius of the IAU nominal photosphere, asin(R_sun / distance), in radians.
	readonly semidiameter: Angle
}

// Heliographic coordinates of a point on the solar sphere.
export interface HeliographicCoordinate {
	// Heliographic latitude, positive toward solar north, in [-PI/2, PI/2].
	readonly latitude: Angle
	// Longitude from the observer's central meridian, positive toward solar west, in (-PI, PI].
	readonly stonyhurstLongitude: Angle
	// Carrington longitude, in [0, TAU).
	readonly carringtonLongitude: Angle
}

// A line of sight that meets the observer-facing hemisphere of the solar sphere.
export interface SolarDiskSurfacePoint extends HeliographicCoordinate {
	// Discriminant: the line of sight meets the photosphere.
	readonly onDisk: true
	// Cosine of the heliocentric angle between the local vertical and the direction to the observer,
	// in [0, 1]: 1 at the disk centre, 0 on the limb.
	readonly mu: number
}

// A line of sight that misses the solar sphere (beyond the limb).
export interface SolarDiskOffLimbPoint {
	// Discriminant: the line of sight passes beyond the limb.
	readonly onDisk: false
	// Angular distance from the disk centre, in radians.
	readonly elongation: Angle
}

// Result of mapping a line of sight onto the solar sphere.
export type SolarDiskPoint = SolarDiskSurfacePoint | SolarDiskOffLimbPoint

// Helioprojective direction of a heliographic point.
export interface HelioprojectivePoint {
	// Angle from the disk centre toward solar west, in radians.
	readonly tx: Angle
	// Angle from the disk centre toward the projected solar north, in radians.
	readonly ty: Angle
	// Whether the point lies on the observer-facing hemisphere; hidden points still project inside the disk.
	readonly visible: boolean
}

// Image position of a heliographic point.
export interface SolarImagePoint {
	// Pixel column, +X right.
	readonly x: number
	// Pixel row, +Y down.
	readonly y: number
	// Whether the point lies on the observer-facing hemisphere; hidden points still project inside the disk.
	readonly visible: boolean
}

// Placement and orientation of the solar disk in an image. The image is treated as an ideal gnomonic
// (TAN) projection whose tangent point is the disk centre; lens distortion is not modelled.
export interface SolarImageCalibration {
	// Disk-centre column, in pixels (pixel centres at integers, +X right).
	readonly centerX: number
	// Disk-centre row, in pixels (+Y down).
	readonly centerY: number
	// Tangent-plane scale at the disk centre, in radians per pixel (square pixels).
	readonly scale: Angle
	// Position angle of the image "up" direction (-Y), measured from celestial north toward east.
	readonly positionAngle: Angle
	// Celestial north that positionAngle refers to. Default 'date'.
	readonly north?: SolarImageNorth
	// Whether the image is mirrored. Default false: celestial east lies 90 deg counter-clockwise from
	// north as displayed (east left when north is up), the normal sky view.
	readonly mirrored?: boolean
}

// Coefficients of the sidereal solar differential rotation law omega = A + B sin^2(lat) + C sin^4(lat).
export interface SolarDifferentialRotation {
	// Equatorial sidereal rate A, in radians per day.
	readonly a: number
	// sin^2(latitude) coefficient B, in radians per day.
	readonly b: number
	// sin^4(latitude) coefficient C, in radians per day.
	readonly c: number
}

// Microradians per second to radians per day.
const MICRORADIAN_PER_SECOND = 86400e-6

// Degrees per day to radians per day.
const DEGREE_PER_DAY = Math.PI / 180

// Howard, Harvey & Forgach (1990), small magnetic features: A, B, C = 2.894, -0.428, -0.370 µrad/s
// sidereal, as tabulated by SunPy 8.0.1 sunpy.sun.models.differential_rotation ('howard', its default).
export const HOWARD_1990_DIFFERENTIAL_ROTATION: SolarDifferentialRotation = { a: 2.894 * MICRORADIAN_PER_SECOND, b: -0.428 * MICRORADIAN_PER_SECOND, c: -0.37 * MICRORADIAN_PER_SECOND }

// Snodgrass (1983), magnetic features: A, B, C = 2.851, -0.343, -0.474 µrad/s sidereal, as tabulated
// by SunPy 8.0.1 sunpy.sun.models.differential_rotation ('snodgrass').
export const SNODGRASS_1983_DIFFERENTIAL_ROTATION: SolarDifferentialRotation = { a: 2.851 * MICRORADIAN_PER_SECOND, b: -0.343 * MICRORADIAN_PER_SECOND, c: -0.474 * MICRORADIAN_PER_SECOND }

// Allen's Astrophysical Quantities, sunspots: A, B, C = 14.44, -3.0, 0 deg/day sidereal, as tabulated
// by SunPy 8.0.1 sunpy.sun.models.differential_rotation ('allen').
export const ALLEN_DIFFERENTIAL_ROTATION: SolarDifferentialRotation = { a: 14.44 * DEGREE_PER_DAY, b: -3 * DEGREE_PER_DAY, c: 0 }

// Computes the observed solar-disk geometry from the IAU rotation elements and a caller ephemeris.
//
// `observer` and `sun` are barycentric ICRS position (AU) and velocity (AU/day) at `time`. Pass the
// Earth state for a geocentric observer or an observerState(...) result for a topocentric one; every
// angle refers to that observer. The Sun centre is retarded by its light time (to first order in the
// Sun's velocity). B0 and L0 are the sub-observer point of SUN_ROTATION with the rotation retarded
// by the light time from the nearest surface point, as in SunPy's default L0; limb features are
// emitted up to R_sun / c (about 2.3 s, 0.0004 deg of rotation) earlier. Stellar aberration is not
// applied to B0 or L0 because it does not move features relative to the disk centre; the
// Astronomical Almanac L0 includes it and is about 0.006 deg smaller. P is the axis position angle
// at the aberrated (apparent) disk centre, referred to the true equator of date and to ICRS.
export function solarDiskGeometry(time: Time, observer: PositionAndVelocity, sun: PositionAndVelocity): SolarDiskGeometry {
	const [observerPosition, observerVelocity] = observer
	const [sunPosition, sunVelocity] = sun

	const x = observerPosition[0] - sunPosition[0]
	const y = observerPosition[1] - sunPosition[1]
	const z = observerPosition[2] - sunPosition[2]
	const lightTime = Math.sqrt(x * x + y * y + z * z) / SPEED_OF_LIGHT_AU_DAY
	const sunToObserver: Vec3 = [x + sunVelocity[0] * lightTime, y + sunVelocity[1] * lightTime, z + sunVelocity[2] * lightTime]
	const distance = vecLength(sunToObserver)
	// subObserverPoint takes the light time from the vector length and the point from its direction:
	// shortening it by R_sun retards the rotation to the nearest surface point, as SunPy does.
	const surface = (distance - SUN_RADIUS_AU) / distance
	const { longitude, latitude } = subObserverPoint(SUN_ROTATION, time, [sunToObserver[0] * surface, sunToObserver[1] * surface, sunToObserver[2] * surface])

	const apparent = annualAberration([-sunToObserver[0] / distance, -sunToObserver[1] / distance, -sunToObserver[2] / distance], observerVelocity, distance)
	const { poleRa, poleDec } = orientation(SUN_ROTATION, time)
	const cosPoleDec = Math.cos(poleDec)
	const pole: Vec3 = [cosPoleDec * Math.cos(poleRa), cosPoleDec * Math.sin(poleRa), Math.sin(poleDec)]
	const pnm = precessionNutationMatrix(time)
	const p = positionAngle(matMulVec(pnm, pole), matMulVec(pnm, apparent))
	const pIcrs = positionAngle(pole, apparent)

	return { model: 'iau', time, p, pIcrs, b0: latitude, l0: longitude, distance, semidiameter: Math.asin(SUN_RADIUS_AU / distance) }
}

// Computes the geocentric solar-disk geometry from Meeus, Astronomical Algorithms ch. 29.
//
// A self-contained approximation for a geocentric observer: VSOP87 Sun, the Carrington elements
// (I = 7.25 deg, 25.38-day sidereal period) and low-order aberration, evaluated at the TT of `time`.
// Its L0 includes aberration and differs from the IAU model by a few hundredths of a degree in the
// 21st century; P and B0 agree to a few thousandths of a degree. Use solarDiskGeometry for
// topocentric observers or IAU/SunPy-consistent Carrington longitudes.
export function approximateSolarDiskGeometry(time: Time): SolarDiskGeometry {
	const jde = toJulianDay(tt(time))
	const [p, b0, l0] = SolarDisk.ephemeris(jde)
	const [ra, dec, distance] = Solar.apparentEquatorialVSOP87(jde)

	// Rotates the true-of-date disk centre and its local north into ICRS to refer P to ICRS north.
	const sinRa = Math.sin(ra)
	const cosRa = Math.cos(ra)
	const sinDec = Math.sin(dec)
	const cosDec = Math.cos(dec)
	const pnm = precessionNutationMatrix(time)
	const centre = matTransposeMulVec(pnm, [cosDec * cosRa, cosDec * sinRa, sinDec])
	const north = matTransposeMulVec(pnm, [-sinDec * cosRa, -sinDec * sinRa, cosDec])
	const pIcrs = normalizePI(p + positionAngle(north, centre))

	return { model: 'meeus', time, p: normalizePI(p), pIcrs, b0, l0, distance, semidiameter: Math.asin(SUN_RADIUS_AU / distance) }
}

// Computes the TAN image scale, in radians per pixel, from the measured photospheric disk radius in
// pixels (for example from measureLimb), so the limb of `geometry` falls on that radius.
export function solarImageScale(geometry: SolarDiskGeometry, radius: number): Angle {
	return Math.tan(geometry.semidiameter) / radius
}

// Maps a helioprojective direction (`tx` toward solar west, `ty` toward solar north, radians) onto
// the solar sphere. Returns the heliographic coordinates and mu of the nearest (observer-facing)
// intersection, or an off-limb flag with the angular distance from the disk centre.
export function helioprojectiveToHeliographic(tx: Angle, ty: Angle, geometry: SolarDiskGeometry): SolarDiskPoint {
	const cosTy = Math.cos(ty)
	return lineOfSightToHeliographic(cosTy * Math.sin(tx), Math.sin(ty), cosTy * Math.cos(tx), geometry)
}

// Projects a heliographic point to its helioprojective direction. `longitude` is Stonyhurst or
// Carrington according to `system`; `latitude` is heliographic. Points on the far hemisphere are
// projected through the sphere and flagged as not visible.
export function heliographicToHelioprojective(longitude: Angle, latitude: Angle, system: HeliographicLongitudeSystem, geometry: SolarDiskGeometry): HelioprojectivePoint {
	const [sx, sy, sz, visible] = heliographicToHeliocentric(longitude, latitude, system, geometry)
	const depth = geometry.distance - sz
	return { tx: Math.atan2(sx, depth), ty: Math.atan2(sy, Math.sqrt(sx * sx + depth * depth)), visible }
}

// Maps an image pixel (`x` right, `y` down) onto the solar sphere through `calibration`. Returns the
// heliographic coordinates and mu of the observer-facing intersection, or an off-limb flag.
export function solarImageToHeliographic(x: number, y: number, geometry: SolarDiskGeometry, calibration: SolarImageCalibration): SolarDiskPoint {
	const u = calibration.mirrored ? calibration.centerX - x : x - calibration.centerX
	const v = calibration.centerY - y
	const a = imageRotation(geometry, calibration)
	const cosA = Math.cos(a)
	const sinA = Math.sin(a)
	return lineOfSightToHeliographic((u * cosA - v * sinA) * calibration.scale, (v * cosA + u * sinA) * calibration.scale, 1, geometry)
}

// Projects a heliographic point into the image through `calibration`, the inverse of
// solarImageToHeliographic on the visible hemisphere. Far-side points are flagged as not visible.
export function heliographicToSolarImage(longitude: Angle, latitude: Angle, system: HeliographicLongitudeSystem, geometry: SolarDiskGeometry, calibration: SolarImageCalibration): SolarImagePoint {
	const [sx, sy, sz, visible] = heliographicToHeliocentric(longitude, latitude, system, geometry)
	const depth = (geometry.distance - sz) * calibration.scale
	const xi = sx / depth
	const eta = sy / depth
	const a = imageRotation(geometry, calibration)
	const cosA = Math.cos(a)
	const sinA = Math.sin(a)
	const u = xi * cosA + eta * sinA
	const v = eta * cosA - xi * sinA
	return { x: calibration.mirrored ? calibration.centerX - u : calibration.centerX + u, y: calibration.centerY - v, visible }
}

// Sidereal angular rotation rate of the solar surface at heliographic `latitude`, in radians per day,
// from omega = A + B sin^2(lat) + C sin^4(lat).
export function solarRotationRate(latitude: Angle, model: SolarDifferentialRotation = HOWARD_1990_DIFFERENTIAL_ROTATION) {
	const s = Math.sin(latitude)
	const s2 = s * s
	return model.a + s2 * (model.b + s2 * model.c)
}

// Propagates a feature's Carrington longitude from `from` to `to` (either order) by differential
// rotation, returning the new Carrington longitude in [0, TAU). The drift is the model's sidereal rate
// minus the rigid Carrington rate (14.1844 deg/day) over the TDB interval; latitude is unchanged.
// Map the result with the geometry of `to` to obtain its Stonyhurst longitude or image position.
export function rotateCarringtonLongitude(carringtonLongitude: Angle, latitude: Angle, from: Time, to: Time, model: SolarDifferentialRotation = HOWARD_1990_DIFFERENTIAL_ROTATION): Angle {
	const days = timeSubtract(to, from, Timescale.TDB)
	return normalizeAngle(carringtonLongitude + (solarRotationRate(latitude, model) - SUN_ROTATION.rotationRate) * days)
}

// Position angle of `direction` projected on the sky at `centre` (both in one equatorial frame), from
// the frame's north toward east, in (-PI, PI]. vecPositionAngle (ERFA eraPap) resolves direction -
// centre on the local north/east axes; centre is orthogonal to both, so only the projection of
// `direction` counts.
function positionAngle(direction: Vec3, centre: Vec3): Angle {
	return normalizePI(vecPositionAngle(centre, direction))
}

// Rotation from the image (right, up) axes to the solar (west, north) axes: the image "up" position
// angle minus P in the same celestial north.
function imageRotation(geometry: SolarDiskGeometry, calibration: SolarImageCalibration): Angle {
	return calibration.positionAngle - (calibration.north === 'icrs' ? geometry.pIcrs : geometry.p)
}

// Intersects the observer ray (dx west, dy north, dz toward the Sun centre; any positive length)
// with the solar sphere. With q = sqrt(R^2 - D^2 sin^2(elongation)) the near-side range is
// t = D cos - q and the heliocentric depth is sz = D sin^2 + q cos, which avoids subtracting the
// nearly equal D and t; mu reduces to q / R.
function lineOfSightToHeliographic(dx: number, dy: number, dz: number, geometry: SolarDiskGeometry): SolarDiskPoint {
	const n = Math.sqrt(dx * dx + dy * dy + dz * dz)
	const ux = dx / n
	const uy = dy / n
	const uz = dz / n
	const sideways = ux * ux + uy * uy
	const distance = geometry.distance
	const discriminant = SUN_RADIUS_AU * SUN_RADIUS_AU - distance * distance * sideways

	if (!(uz > 0 && discriminant >= 0)) return { onDisk: false, elongation: Math.atan2(Math.sqrt(sideways), uz) }

	const q = Math.sqrt(discriminant)
	const t = distance * uz - q
	// Heliocentric Cartesian: X west, Y projected solar north, Z toward the observer.
	const sx = t * ux
	const sy = t * uy
	const sz = distance * sideways + q * uz
	const sinB0 = Math.sin(geometry.b0)
	const cosB0 = Math.cos(geometry.b0)
	const latitude = Math.asin(clamp((sy * cosB0 + sz * sinB0) / SUN_RADIUS_AU, -1, 1))
	const stonyhurstLongitude = normalizePI(Math.atan2(sx, sz * cosB0 - sy * sinB0))
	return { onDisk: true, latitude, stonyhurstLongitude, carringtonLongitude: normalizeAngle(stonyhurstLongitude + geometry.l0), mu: clamp(q / SUN_RADIUS_AU, 0, 1) }
}

// Heliocentric Cartesian position (AU; X west, Y projected solar north, Z toward the observer) of a
// heliographic point on the solar sphere, plus whether it faces the observer (D * z >= R^2).
function heliographicToHeliocentric(longitude: Angle, latitude: Angle, system: HeliographicLongitudeSystem, geometry: SolarDiskGeometry): readonly [number, number, number, boolean] {
	const stonyhurstLongitude = system === 'carrington' ? longitude - geometry.l0 : longitude
	const cosLat = Math.cos(latitude)
	const sinLat = Math.sin(latitude)
	const cosLon = Math.cos(stonyhurstLongitude)
	const sinB0 = Math.sin(geometry.b0)
	const cosB0 = Math.cos(geometry.b0)
	const sx = SUN_RADIUS_AU * cosLat * Math.sin(stonyhurstLongitude)
	const sy = SUN_RADIUS_AU * (sinLat * cosB0 - cosLat * cosLon * sinB0)
	const sz = SUN_RADIUS_AU * (sinLat * sinB0 + cosLat * cosLon * cosB0)
	return [sx, sy, sz, geometry.distance * sz >= SUN_RADIUS_AU * SUN_RADIUS_AU]
}
