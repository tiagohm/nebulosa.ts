import { normalizeAngle, normalizePI } from './angle'
import type { Point } from './geometry'
import { clamp } from './math'

type RadialDistance = (sinC: number, cosC: number) => number | false

type AngularDistance = (rho: number) => number | false

// Projects a spherical point using a radial azimuthal scaling law.
function azimuthalProject(longitude: number, latitude: number, centerLongitude: number, centerLatitude: number, radialDistance: RadialDistance, out?: Point): Point | false {
	const dLongitude = normalizePI(longitude - centerLongitude)
	const sinLatitude = Math.sin(latitude)
	const cosLatitude = Math.cos(latitude)
	const sinCenterLatitude = Math.sin(centerLatitude)
	const cosCenterLatitude = Math.cos(centerLatitude)
	const sinDLongitude = Math.sin(dLongitude)
	const cosDLongitude = Math.cos(dLongitude)
	const x = cosLatitude * sinDLongitude
	const y = cosCenterLatitude * sinLatitude - sinCenterLatitude * cosLatitude * cosDLongitude
	const sinC = Math.hypot(x, y)
	const cosC = sinCenterLatitude * sinLatitude + cosCenterLatitude * cosLatitude * cosDLongitude

	if (sinC <= Number.EPSILON) {
		if (cosC < 0) return false

		out ??= { x: 0, y: 0 }
		out.x = 0
		out.y = 0
		return out
	}

	const rho = radialDistance(sinC, cosC)

	if (rho === false) return false

	const scale = rho / sinC
	out ??= { x: 0, y: 0 }
	out.x = x * scale
	out.y = y * scale
	return out
}

// Unprojects azimuthal plane coordinates using the inverse radial law.
function azimuthalUnproject(x: number, y: number, centerLongitude: number, centerLatitude: number, angularDistance: AngularDistance) {
	if (x === 0 && y === 0) return [normalizeAngle(centerLongitude), centerLatitude] as const

	const rho = Math.hypot(x, y)
	const c = angularDistance(rho)

	if (c === false) return false

	const sinC = Math.sin(c)
	const cosC = Math.cos(c)
	const sinCenterLatitude = Math.sin(centerLatitude)
	const cosCenterLatitude = Math.cos(centerLatitude)
	const latitude = Math.asin(clamp(cosC * sinCenterLatitude + (y * sinC * cosCenterLatitude) / rho, -1, 1))
	const longitude = normalizeAngle(centerLongitude + Math.atan2(x * sinC, rho * cosCenterLatitude * cosC - y * sinCenterLatitude * sinC))
	return [longitude, latitude] as const
}

function gnomonicRadialDistance(sinC: number, cosC: number) {
	return cosC <= 0 ? false : sinC / cosC
}

// Projects a spherical point onto a tangent plane using the gnomonic projection.
export function gnomonicProject(longitude: number, latitude: number, centerLongitude: number, centerLatitude: number, out?: Point): Point | false {
	return azimuthalProject(longitude, latitude, centerLongitude, centerLatitude, gnomonicRadialDistance, out)
}

// Unprojects tangent-plane coordinates into spherical coordinates using the gnomonic projection.
export function gnomonicUnproject(x: number, y: number, centerLongitude: number, centerLatitude: number) {
	return azimuthalUnproject(x, y, centerLongitude, centerLatitude, Math.atan)
}

function stereographicRadialDistance(sinC: number, cosC: number) {
	const denominator = 1 + cosC
	return denominator <= Number.EPSILON ? false : (2 * sinC) / denominator
}

function stereographicAngularDistance(rho: number) {
	return 2 * Math.atan(rho / 2)
}

// Projects a spherical point onto a perspective plane using the stereographic projection.
export function stereographicProject(longitude: number, latitude: number, centerLongitude: number, centerLatitude: number, out?: Point) {
	return azimuthalProject(longitude, latitude, centerLongitude, centerLatitude, stereographicRadialDistance, out)
}

// Unprojects perspective-plane coordinates into spherical coordinates using the stereographic projection.
export function stereographicUnproject(x: number, y: number, centerLongitude: number, centerLatitude: number) {
	return azimuthalUnproject(x, y, centerLongitude, centerLatitude, stereographicAngularDistance)
}

function orthographicRadialDistance(sinC: number, cosC: number) {
	return cosC < 0 ? false : sinC
}

function orthographicAngularDistance(rho: number) {
	return rho > 1 + Number.EPSILON ? false : Math.asin(clamp(rho, 0, 1))
}

// Projects a spherical point onto the visible hemisphere using the orthographic projection.
export function orthographicProject(longitude: number, latitude: number, centerLongitude: number, centerLatitude: number, out?: Point) {
	return azimuthalProject(longitude, latitude, centerLongitude, centerLatitude, orthographicRadialDistance, out)
}

// Unprojects orthographic-plane coordinates into spherical coordinates using the orthographic projection.
export function orthographicUnproject(x: number, y: number, centerLongitude: number, centerLatitude: number) {
	return azimuthalUnproject(x, y, centerLongitude, centerLatitude, orthographicAngularDistance)
}

function lambertAzimuthalEqualAreaRadialDistance(sinC: number, cosC: number) {
	const denominator = 1 + cosC
	return denominator <= Number.EPSILON ? false : sinC * Math.sqrt(2 / denominator)
}

function lambertAzimuthalEqualAreaAngularDistance(rho: number) {
	return rho > 2 + Number.EPSILON ? false : 2 * Math.asin(clamp(rho / 2, 0, 1))
}

// Projects a spherical point preserving area with the Lambert azimuthal equal-area projection.
export function lambertAzimuthalEqualAreaProject(longitude: number, latitude: number, centerLongitude: number, centerLatitude: number, out?: Point) {
	return azimuthalProject(longitude, latitude, centerLongitude, centerLatitude, lambertAzimuthalEqualAreaRadialDistance, out)
}

// Unprojects Lambert azimuthal equal-area plane coordinates into spherical coordinates.
export function lambertAzimuthalEqualAreaUnproject(x: number, y: number, centerLongitude: number, centerLatitude: number) {
	return azimuthalUnproject(x, y, centerLongitude, centerLatitude, lambertAzimuthalEqualAreaAngularDistance)
}

function azimuthalEquidistantRadialDistance(sinC: number, cosC: number) {
	return sinC <= Number.EPSILON && cosC < 0 ? false : Math.atan2(sinC, cosC)
}

function azimuthalEquidistantAngularDistance(rho: number) {
	return rho > Math.PI + Number.EPSILON ? false : rho
}

// Projects a spherical point preserving distance from the center with the azimuthal equidistant projection.
export function azimuthalEquidistantProject(longitude: number, latitude: number, centerLongitude: number, centerLatitude: number, out?: Point): Point | false {
	return azimuthalProject(longitude, latitude, centerLongitude, centerLatitude, azimuthalEquidistantRadialDistance, out)
}

// Unprojects azimuthal-equidistant plane coordinates into spherical coordinates.
export function azimuthalEquidistantUnproject(x: number, y: number, centerLongitude: number, centerLatitude: number) {
	return azimuthalUnproject(x, y, centerLongitude, centerLatitude, azimuthalEquidistantAngularDistance)
}
