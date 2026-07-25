import { DEG2RAD } from '../../core/constants'
import { clamp } from '../../math/numerical/math'
import { type Angle, normalizeAngle } from '../../math/units/angle'

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
	// ME — polar axis misalignment in the vertical plane (elevation), positive when the axis points
	// above the true pole.
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
// result stays finite at the poles. When `o` is provided it receives the result and is returned.
export function equatorialPointingError(hourAngle: Angle, declination: Angle, model: EquatorialPointingModel, o?: [Angle, Angle]): [Angle, Angle] {
	const cosHourAngle = Math.cos(hourAngle)
	const sinHourAngle = Math.sin(hourAngle)

	// Clamped away from the pole so tan/sec stay bounded; see MAX_POINTING_DECLINATION.
	const clampedDeclination = clamp(declination, -MAX_POINTING_DECLINATION, MAX_POINTING_DECLINATION)
	const tanDeclination = Math.tan(clampedDeclination)
	const secDeclination = 1 / Math.cos(clampedDeclination)

	const deltaHourAngle = model.indexHourAngle + model.coneError * secDeclination + model.axisNonPerpendicularity * tanDeclination - model.polarAzimuthError * cosHourAngle * tanDeclination + model.polarAltitudeError * sinHourAngle * tanDeclination
	const deltaDeclination = model.indexDeclination + model.polarAzimuthError * sinHourAngle + model.polarAltitudeError * cosHourAngle

	if (o) {
		o[0] = deltaHourAngle
		o[1] = deltaDeclination
		return o
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
// When `o` is provided it receives the result and is returned.
export function applyEquatorialPointingError(rightAscension: Angle, declination: Angle, lst: Angle, model: EquatorialPointingModel, o?: [Angle, Angle]): readonly [Angle, Angle] {
	const error = equatorialPointingError(lst - rightAscension, declination, model, o)
	error[0] = normalizeAngle(rightAscension - error[0])
	error[1] += declination
	return error
}
