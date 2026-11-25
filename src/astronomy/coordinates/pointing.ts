import { DEG2RAD } from '../../core/constants'
import { type Mat3, matMul, matMulVec, matRodriguesRotation, type MutMat3 } from '../../math/linear-algebra/mat3'
import { vecLatitude, type MutVec3 } from '../../math/linear-algebra/vec3'
import { clamp } from '../../math/numerical/math'
import { type Angle, normalizeAngle } from '../../math/units/angle'
import { parallacticAngle } from './astrometry'
import { eraS2c } from './erfa/erfa'

// Geometric pointing-error model for equatorial mounts, following the six basic TPoint terms.
// Describes how the mechanical orientation of the axes maps to the direction the optical axis
// actually points. All coefficients and returned deltas are radians. Functions are pure and never
// mutate their inputs; the optional output parameter aliases the returned tuple when provided.

// Maximum declination used by the sec δ / tan δ terms of the pointing model.
// Beyond this the spherical formulation is degenerate: near the pole a hour-angle displacement maps
// to a negligible on-sky angle, while tan δ and sec δ diverge and would produce meaningless deltas.
// Clamping keeps the model finite at δ = ±90°, at the cost of understating the (unobservable)
// hour-angle error in the last tenth of a degree before the pole.
export const MAX_POINTING_DECLINATION: Angle = 89.9 * DEG2RAD

// Six basic geometric terms of the TPoint equatorial pointing model. Every coefficient is an angle
// in radians and defaults to zero meaning "perfect geometry".
export interface EquatorialPointingModel {
	// IH — constant index offset in hour angle, from an incorrect encoder zero or an imperfect sync.
	readonly indexHourAngle: Angle
	// ID — constant index offset in declination.
	readonly indexDeclination: Angle
	// CH — collimation (cone) error: the optical axis is not perpendicular to the declination axis.
	// Enters the hour-angle error as CH·sec δ, so it is negligible at the equator and grows near the pole.
	readonly coneError: Angle
	// NP — the right-ascension axis is not perpendicular to the declination axis.
	// Enters the hour-angle error as NP·tan δ.
	readonly axisNonPerpendicularity: Angle
	// MA — polar axis misalignment in the horizontal plane (azimuth), positive towards east.
	readonly polarAzimuthError: Angle
	// ME — polar axis misalignment in the vertical plane (elevation). This is the TPoint ME coefficient:
	// positive when the pole of the mounting is below the true pole. A polar axis pointed above the
	// true pole is a positive `altitudeError` to `polarAlignmentPointingModel`, which stores ME as
	// −altitude.
	readonly polarAltitudeError: Angle
}

// A pointing model with perfect geometry: every term zero. Useful as a default and as the identity
// case in tests, where applying it must leave coordinates bit-for-bit unchanged.
export const IDENTITY_EQUATORIAL_POINTING_MODEL: EquatorialPointingModel = {
	indexHourAngle: 0,
	indexDeclination: 0,
	coneError: 0,
	axisNonPerpendicularity: 0,
	polarAzimuthError: 0,
	polarAltitudeError: 0,
}

// Builds the pointing model of a mount whose polar axis is misaligned by the given knob errors.
//
// `azimuthError` and `altitudeError` are the misalignment of the polar axis in the horizontal and
// vertical planes as an observer would read them off the adjusters, and `latitude` is the site
// latitude; all radians. They map onto the model as MA = azimuth·cos(latitude) and
// ME = -altitude, plus a constant hour-angle term azimuth·sin(latitude).
//
// That last term is the addition Ralph Pass makes to the Trueblood and Genet formulation. It is not
// part of the canonical six-term TPoint model, and it is carried in `indexHourAngle` because that is
// where a constant hour-angle offset belongs; callers wanting to add an encoder zero error of their
// own must sum it in rather than overwrite it.
export function polarAlignmentPointingModel(azimuthError: Angle, altitudeError: Angle, latitude: Angle): EquatorialPointingModel {
	return {
		...IDENTITY_EQUATORIAL_POINTING_MODEL,
		polarAzimuthError: azimuthError * Math.cos(latitude),
		polarAltitudeError: -altitudeError,
		indexHourAngle: azimuthError * Math.sin(latitude),
	}
}

// Whether the model has any non-zero term. Callers use it to skip the whole computation on the
// common perfect-geometry path.
export function isIdentityEquatorialPointingModel(model: EquatorialPointingModel) {
	return model.indexHourAngle === 0 && model.indexDeclination === 0 && model.coneError === 0 && model.axisNonPerpendicularity === 0 && model.polarAzimuthError === 0 && model.polarAltitudeError === 0
}

// Computes the pointing error of an equatorial mount at a given mechanical orientation.
//
// `hourAngle` and `declination` (radians) describe where the axes mechanically are; `latitude`
// (radians) is the observing site latitude. Returns `[ΔH, Δδ]` in radians, the error to be added to
// the mechanical orientation to obtain the direction the optical axis really points:
//
//   ΔH = IH + CH·sec δ + NP·tan δ − MA·cos H·tan δ + ME·sin H·tan δ
//   Δδ = ID + MA·sin H + ME·cos H
//
// The declination fed to the sec δ / tan δ terms is clamped to ±MAX_POINTING_DECLINATION, so the
// result stays finite at the poles. When `out` is provided it receives the result and is returned.
export function equatorialPointingError(hourAngle: Angle, declination: Angle, model: EquatorialPointingModel, out?: [Angle, Angle]): [Angle, Angle] {
	const cosHourAngle = Math.cos(hourAngle)
	const sinHourAngle = Math.sin(hourAngle)

	// Clamped away from the pole so tan/sec stay bounded; see MAX_POINTING_DECLINATION.
	const clampedDeclination = clamp(declination, -MAX_POINTING_DECLINATION, MAX_POINTING_DECLINATION)
	const tanDeclination = Math.tan(clampedDeclination)
	const secDeclination = 1 / Math.cos(clampedDeclination)

	const deltaHourAngle = model.indexHourAngle + model.coneError * secDeclination + model.axisNonPerpendicularity * tanDeclination - model.polarAzimuthError * cosHourAngle * tanDeclination + model.polarAltitudeError * sinHourAngle * tanDeclination
	const deltaDeclination = model.indexDeclination + model.polarAzimuthError * sinHourAngle + model.polarAltitudeError * cosHourAngle

	if (out) {
		out[0] = deltaHourAngle
		out[1] = deltaDeclination
		return out
	}

	return [deltaHourAngle, deltaDeclination]
}

// On-sky east and north components of tube flexure, in radians. East is the direction of increasing
// right ascension. Both stay finite at the poles: the east component is the tangent-plane displacement
// `−droop·sin q`, not that quantity divided by cos δ. A zero flexure returns `[0, 0]`.
function tubeFlexureSkyOffset(hourAngle: Angle, declination: Angle, latitude: Angle, flexure: Angle): readonly [Angle, Angle] {
	if (flexure === 0) return [0, 0]

	const cosZenithDistance = Math.sin(latitude) * Math.sin(declination) + Math.cos(latitude) * Math.cos(declination) * Math.cos(hourAngle)
	// From the cosine rather than an inverse trig call, and clamped because rounding can push the
	// dot product a hair outside [-1, 1] when the target passes through the zenith or the nadir.
	const sinZenithDistance = Math.sqrt(Math.max(0, 1 - cosZenithDistance * cosZenithDistance))
	const droop = flexure * sinZenithDistance
	const q = parallacticAngle(hourAngle, declination, latitude)
	return [-droop * Math.sin(q), -droop * Math.cos(q)]
}

// Computes the pointing error produced by gravitational flexure of the tube.
//
// `hourAngle` and `declination` describe where the axes mechanically are, `latitude` is the site
// latitude and `flexure` the droop at the horizon; all radians. Returns `[ΔH, Δδ]` in radians, on the
// same convention as `equatorialPointingError`, so the two can simply be summed away from the poles.
//
// Unlike the six geometric terms, flexure is not a property of the mount's axes but of gravity, so it
// acts in the vertical: the tube sags away from the zenith by `flexure·sin z`, which vanishes when
// pointing straight up and is largest near the horizon. That is the TF term of the TPoint model.
// Expressing a vertical displacement in equatorial coordinates needs the parallactic angle q, the
// position angle of the zenith at that point, since the zenith direction is `cos q` north plus
// `sin q` east:
//
//   Δδ = −flexure·sin z·cos q
//   ΔH = +flexure·sin z·sin q / cos δ
//
// The sign of ΔH is opposite because H = LST − RA. The declination fed to the `cos δ` division is
// clamped to ±MAX_POINTING_DECLINATION so the hour-angle pair stays finite. Applying that pair as a
// turn about the polar axis still drops the east-west droop at the pole itself, where rotating in H
// does not move the optical axis; `applyTubeFlexureError` keeps that component as a great-circle
// offset. A zero flexure returns exactly `[0, 0]`. When `out` is provided it receives the result and is
// returned.
export function tubeFlexureError(hourAngle: Angle, declination: Angle, latitude: Angle, flexure: Angle, out?: [Angle, Angle]): [Angle, Angle] {
	let deltaHourAngle = 0
	let deltaDeclination = 0

	if (flexure !== 0) {
		const [east, north] = tubeFlexureSkyOffset(hourAngle, declination, latitude, flexure)
		const clampedDeclination = clamp(declination, -MAX_POINTING_DECLINATION, MAX_POINTING_DECLINATION)

		// east = −ΔH·cos δ, so recovering ΔH divides by cos δ; the clamp is only for this representation.
		deltaHourAngle = -east / Math.cos(clampedDeclination)
		deltaDeclination = north
	}

	if (out) {
		out[0] = deltaHourAngle
		out[1] = deltaDeclination
		return out
	}

	return [deltaHourAngle, deltaDeclination]
}

// Applies the pointing model to an equatorial coordinate, returning `[rightAscension, declination]`
// in radians of the direction the optical axis really points.
//
// `rightAscension`/`declination` are the mechanical orientation and `lst` the local sidereal time,
// all radians. Since `H = LST − RA`, a positive hour-angle error corresponds to a negative right
// ascension error, hence `RA − ΔH`. The returned right ascension is normalized to [0, TAU); the
// declination is left unwrapped so callers can detect and handle a crossing of the pole themselves.
// When `out` is provided it receives the result and is returned.
export function applyEquatorialPointingError(rightAscension: Angle, declination: Angle, lst: Angle, model: EquatorialPointingModel, out?: [Angle, Angle]): readonly [Angle, Angle] {
	const hourAngle = lst - rightAscension
	const error = equatorialPointingError(hourAngle, declination, model, out)

	if (Math.abs(declination) > MAX_POINTING_DECLINATION) {
		return applyPolarPointingError(rightAscension, declination, hourAngle, model, error)
	}

	error[0] = normalizeAngle(rightAscension - error[0])
	error[1] += declination
	return error
}

// Applies tube flexure to an equatorial coordinate, returning `[rightAscension, declination]` in
// radians of the direction the optical axis really points after the tube has sagged.
//
// `rightAscension`/`declination` are the orientation before flexure, `lst` the local sidereal time,
// `latitude` the site latitude and `flexure` the droop at the horizon; all radians. Same `RA − ΔH`
// convention as `applyEquatorialPointingError` away from the poles. Within MAX_POINTING_DECLINATION
// of a pole, a hour-angle turn no longer moves the optical axis, so the east-west droop is applied
// as a great-circle offset instead. A zero flexure returns the input with right ascension normalized
// to [0, TAU). When `out` is provided it receives the result and is returned.
export function applyTubeFlexureError(rightAscension: Angle, declination: Angle, lst: Angle, latitude: Angle, flexure: Angle, out?: [Angle, Angle]): readonly [Angle, Angle] {
	const hourAngle = lst - rightAscension

	if (Math.abs(declination) > MAX_POINTING_DECLINATION) {
		const [east, north] = tubeFlexureSkyOffset(hourAngle, declination, latitude, flexure)
		return applySkyOffset(rightAscension, declination, east, north, out ?? [0, 0])
	}

	const error = tubeFlexureError(hourAngle, declination, latitude, flexure, out)
	error[0] = normalizeAngle(rightAscension - error[0])
	error[1] += declination
	return error
}

// Applies the pointing model within MAX_POINTING_DECLINATION of a pole, where the hour-angle
// convention it is written in cannot express the error at all.
//
// The sec δ and tan δ terms describe a real tilt of the optical axis, and their displacement on the
// sky is that expression times cos δ, which stays finite everywhere: a cone error moves the tube by
// CH whatever it is pointing at. Written as a hour-angle offset and applied at the true declination
// it is multiplied by cos δ again, so it faded out over the last tenth of a degree and vanished
// exactly at the pole, where turning the mount about its polar axis moves nothing. A mount homed to
// the pole came back pointing exactly at it however badly its optics were aligned.
//
// Here the same displacement is applied as a great-circle offset from the mechanical direction, which
// is what the axes physically do and is well defined at the pole itself: the east basis of the tangent
// plane still exists there, it is simply the meridian the hour angle picks out. The result crosses the
// pole by itself when the error pushes it past, coming back on the opposite meridian rather than as a
// declination beyond ±90°.
//
// `error` receives the result and is returned. Only used where cos δ is below a thousandth, so the
// cost of the vector form is never paid on the ordinary path.
function applyPolarPointingError(rightAscension: Angle, declination: Angle, hourAngle: Angle, model: EquatorialPointingModel, error: [Angle, Angle]): readonly [Angle, Angle] {
	const cosHourAngle = Math.cos(hourAngle)
	const sinHourAngle = Math.sin(hourAngle)
	const cosDeclination = Math.cos(declination)
	const sinDeclination = Math.sin(declination)

	// The same six terms as `equatorialPointingError`, each multiplied by cos δ so that it becomes a
	// displacement on the sky rather than one in hour angle, which is what removes the divergence: sec δ
	// becomes one and tan δ becomes sin δ. Negated because H = LST − RA, so a positive hour-angle error
	// displaces the tube towards the east, which is the direction of increasing right ascension.
	const east = -(model.indexHourAngle * cosDeclination + model.coneError + (model.axisNonPerpendicularity - model.polarAzimuthError * cosHourAngle + model.polarAltitudeError * sinHourAngle) * sinDeclination)
	const north = model.indexDeclination + model.polarAzimuthError * sinHourAngle + model.polarAltitudeError * cosHourAngle
	return applySkyOffset(rightAscension, declination, east, north, error)
}

// Rotates the mechanical direction by the tangent-plane displacement `(east, north)`, both radians,
// along the great circle they point along. East is increasing right ascension; north is increasing
// declination. `error` receives the result and is returned. A zero offset normalizes the right
// ascension and leaves the declination unchanged.
function applySkyOffset(rightAscension: Angle, declination: Angle, east: Angle, north: Angle, error: [Angle, Angle]): readonly [Angle, Angle] {
	const offset = Math.hypot(east, north)

	if (offset === 0) {
		error[0] = normalizeAngle(rightAscension)
		error[1] = declination
		return error
	}

	// Rotation of the unit vector by `offset` towards the direction of the displacement. Both basis
	// vectors are perpendicular to it and to each other, so the rotated vector is simply the two scaled
	// by the cosine and the sine, and no normalization is needed.
	const cosRightAscension = Math.cos(rightAscension)
	const sinRightAscension = Math.sin(rightAscension)
	const cosDeclination = Math.cos(declination)
	const sinDeclination = Math.sin(declination)
	const scale = Math.sin(offset) / offset
	const cosOffset = Math.cos(offset)

	// Unit vector of the mechanical direction, and the east and north tangent vectors at it.
	const x = cosDeclination * cosRightAscension * cosOffset + scale * (-east * sinRightAscension - north * sinDeclination * cosRightAscension)
	const y = cosDeclination * sinRightAscension * cosOffset + scale * (east * cosRightAscension - north * sinDeclination * sinRightAscension)
	const z = sinDeclination * cosOffset + scale * north * cosDeclination

	error[0] = normalizeAngle(Math.atan2(y, x))
	error[1] = Math.atan2(z, Math.hypot(x, y))
	return error
}

const Y_AXIS = [0, 1, 0] as const

// Exact misalignment of a polar axis, as a rotation of the mount's own equatorial frame.
//
// The first-order terms of polarAlignmentPointingModel linearize this rotation in hour angle and
// declination, which is singular at the pole: within a few times the error of it, the boresight no
// longer turns about the mount's axis as the right-ascension axis turns. The rotation has no such
// limit. Both use the hour-angle frame fixed to the Earth: x towards hour angle 0 on the equator, y
// towards hour angle -6 h (east) and z towards the pole, so that (H, δ) is the unit vector
// (cos δ cos H, -cos δ sin H, sin δ).

// Rotation that takes a direction of the mount's mechanical frame to the sky, for a polar axis
// misaligned by `azimuthError` (positive towards east) and `altitudeError` (positive upwards) at
// `latitude`, all radians, the same knobs as polarAlignmentPointingModel and agreeing with it to first
// order. The axis is tilted in the meridian by the altitude error and then turned about the zenith by
// the azimuth error, which is what the adjusters of a real mount do and puts the axis exactly at the
// misaligned azimuth and altitude. Writes into `out` when given and returns it.
export function polarAxisRotation(azimuthError: Angle, altitudeError: Angle, latitude: Angle, out?: MutMat3): MutMat3 {
	const tilt = matRodriguesRotation(Y_AXIS, altitudeError)
	const turn = matRodriguesRotation([Math.cos(latitude), 0, Math.sin(latitude)], -azimuthError)
	return matMul(turn, tilt, out)
}

// Takes a mechanical orientation to the sky through a polar-axis `rotation` from polarAxisRotation.
// `rightAscension`, `declination` and the local sidereal time `lst` are radians. Returns the right
// ascension normalized to [0, TAU) and the declination; `out` receives them when given.
export function applyPolarAxisRotation(rightAscension: Angle, declination: Angle, lst: Angle, rotation: Mat3, out: [Angle, Angle] = [0, 0]): [Angle, Angle] {
	const v = matMulVec(rotation, eraS2c(rightAscension - lst, declination))
	out[0] = normalizeAngle(lst - Math.atan2(-v[1], v[0]))
	out[1] = vecLatitude(v)
	return out
}

// Position angle, radians east of north in [0, TAU), of the up direction of a tube on an equatorial
// mount, at the boresight (`boresightRightAscension`, `boresightDeclination`).
//
// The tube's up direction is the mechanical frame's north at the mechanical orientation
// (`rightAscension`, `declination`): towards the mount's pole, or away from it when `flipped`, which
// is the other side of the pier, where the declination axis is turned half a revolution. It is taken
// to the sky through `rotation` when the polar axis is misaligned. Turning the right-ascension axis by
// some angle therefore turns this direction by the same angle about the mount's axis, and a meridian
// flip turns it half a revolution. The north and east of the boresight use its own right ascension,
// so the result stays consistent with that coordinate at a pole. `lst` is the local sidereal time; all
// angles are radians.
export function tubePositionAngle(rightAscension: Angle, declination: Angle, lst: Angle, flipped: boolean, boresightRightAscension: Angle, boresightDeclination: Angle, rotation?: Mat3): Angle {
	const hourAngle = lst - rightAscension
	const sign = flipped ? -1 : 1
	const sinDeclination = Math.sin(declination)
	const up: MutVec3 = [-sign * sinDeclination * Math.cos(hourAngle), sign * sinDeclination * Math.sin(hourAngle), sign * Math.cos(declination)]
	if (rotation !== undefined) matMulVec(rotation, up, up)
	const boresightHourAngle = lst - boresightRightAscension
	const sinBoresightDeclination = Math.sin(boresightDeclination)
	const cosBoresightHourAngle = Math.cos(boresightHourAngle)
	const sinBoresightHourAngle = Math.sin(boresightHourAngle)
	const north = -up[0] * sinBoresightDeclination * cosBoresightHourAngle + up[1] * sinBoresightDeclination * sinBoresightHourAngle + up[2] * Math.cos(boresightDeclination)
	const east = up[0] * sinBoresightHourAngle + up[1] * cosBoresightHourAngle
	return normalizeAngle(Math.atan2(east, north))
}
