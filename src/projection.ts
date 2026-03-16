import { normalizeAngle } from '../src/angle'
import type { Point } from '../src/geometry'

// Projects a spherical point onto a tangent plane using the gnomonic projection.
export function gnomonicProject(longitude: number, latitude: number, centerLongitude: number, centerLatitude: number, out?: Point): Point | false {
	const dLongitude = longitude - centerLongitude
	const sinLatitude = Math.sin(latitude)
	const cosLatitude = Math.cos(latitude)
	const sinCenterLatitude = Math.sin(centerLatitude)
	const cosCenterLatitude = Math.cos(centerLatitude)
	const cosDLongitude = Math.cos(dLongitude)
	const denominator = sinCenterLatitude * sinLatitude + cosCenterLatitude * cosLatitude * cosDLongitude

	if (denominator <= 0) return false

	out ??= { x: 0, y: 0 }
	out.x = (cosLatitude * Math.sin(dLongitude)) / denominator
	out.y = (cosCenterLatitude * sinLatitude - sinCenterLatitude * cosLatitude * cosDLongitude) / denominator
	return out
}

// Unprojects tangent-plane coordinates into spherical coordinates using the gnomonic projection.
export function gnomonicUnproject(x: number, y: number, centerLongitude: number, centerLatitude: number) {
	if (x === 0 && y === 0) return [normalizeAngle(centerLongitude), centerLatitude] as const

	const rho = Math.hypot(x, y)
	const c = Math.atan(rho)
	const sinC = Math.sin(c)
	const cosC = Math.cos(c)
	const sinCenterLatitude = Math.sin(centerLatitude)
	const cosCenterLatitude = Math.cos(centerLatitude)
	const latitude = Math.asin(cosC * sinCenterLatitude + (y * sinC * cosCenterLatitude) / rho)
	const longitude = normalizeAngle(centerLongitude + Math.atan2(x * sinC, rho * cosCenterLatitude * cosC - y * sinCenterLatitude * sinC))
	return [longitude, latitude] as const
}
