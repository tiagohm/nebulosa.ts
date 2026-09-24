import { SIDEREAL_DRIFT_RATE } from '../../core/constants'
import { type Angle, normalizePI } from '../../math/units/angle'
import { parallacticAngle } from './astrometry'

// Alt-az field rotation and the instrument-rotator angle that cancels it. Rates are radians per SI
// second about the optical axis. The derotator command is a mechanical offset minus the parallactic
// angle, in radians, so its motion cancels the field rotation. Nothing here moves hardware.

// Cosine magnitude below which the field-rotation denominator cos(altitude) is treated as the zenith.
// Math.cos(π/2) is about 6e-17, so an exact zenith is caught without rejecting ordinary altitudes.
const ZENITH_COSINE_EPSILON = 1e-12
// Cosines below this magnitude represent exact east/west or polar zeros blurred by trig roundoff.
const ZERO_RATE_COSINE_EPSILON = 1e-15
// Largest derotator schedule accepted. A smaller step over a long duration would allocate without bound.
const MAX_DEROTATOR_SAMPLES = 100_000

// Field-rotation rate of an alt-az mount and, when a smear budget is supplied, the exposure it allows.
export interface FieldRotation {
	// Parallactic-angle rate in radians per SI second. The sign follows cos(azimuth): positive on the
	// north side of the sky for the usual north-through-east azimuth.
	readonly radiansPerSecond: Angle
	// The same rate in radians per minute.
	readonly radiansPerMinute: Angle
	// Longest exposure, in seconds, that keeps a point at the requested sensor radius inside the pixel
	// smear budget. Present only when both were supplied. +Infinity at the rotation center or when the
	// field is not rotating.
	readonly maxExposureSeconds?: number
}

// One commanded derotator angle along a sidereal track.
export interface DerotatorSample {
	// Seconds after the epoch of the supplied hour angle.
	readonly seconds: number
	// Derotator angle in radians, normalized to (-π, π].
	readonly angle: Angle
}

// Field-rotation rate of an alt-az mount, dq/dt = Ω · cos(latitude) · cos(azimuth) / cos(altitude).
// Parameters: latitude, azimuth, and altitude are radians. Azimuth is north through east. Ω is the
// sidereal rate. Returns undefined at the zenith, where cos(altitude) vanishes and the parallactic
// angle is undefined. The rate is signed.
export function fieldRotationRate(latitude: Angle, azimuth: Angle, altitude: Angle): Angle | undefined {
	const cosine = Math.cos(altitude)
	if (!(Math.abs(cosine) > ZENITH_COSINE_EPSILON)) return undefined
	const latitudeCosine = Math.cos(latitude)
	const azimuthCosine = Math.cos(azimuth)
	if (!(Math.abs(latitudeCosine) > ZERO_RATE_COSINE_EPSILON) || !(Math.abs(azimuthCosine) > ZERO_RATE_COSINE_EPSILON)) return 0
	return (SIDEREAL_DRIFT_RATE * latitudeCosine * azimuthCosine) / cosine
}

// Field rotation of an alt-az mount, with the exposure limit for a pixel smear budget.
// Parameters: latitude, azimuth, and altitude are radians. smearLimitPixels and radiusPixels together
// request the exposure, where radiusPixels is the distance from the rotation center to the point being
// protected (normally a sensor corner); omitting either leaves maxExposureSeconds unset. Returns
// undefined at the zenith. The exposure follows smear = |rate| * time * radius in the sensor plane.
export function fieldRotation(latitude: Angle, azimuth: Angle, altitude: Angle, smearLimitPixels?: number, radiusPixels?: number): FieldRotation | undefined {
	const radiansPerSecond = fieldRotationRate(latitude, azimuth, altitude)
	if (radiansPerSecond === undefined) return undefined
	const rotation: FieldRotation = { radiansPerSecond, radiansPerMinute: radiansPerSecond * 60 }
	if (smearLimitPixels === undefined || radiusPixels === undefined) return rotation
	const pixelRate = Math.abs(radiansPerSecond * radiusPixels)
	return { ...rotation, maxExposureSeconds: pixelRate === 0 ? Number.POSITIVE_INFINITY : Math.abs(smearLimitPixels) / pixelRate }
}

// Derotator angle that holds a fixed sky orientation on an alt-az mount or an instrument rotator.
// Parameters: hourAngle and declination describe the target, latitude is the observer, and
// mechanicalOffset is the rotator zero plus any fixed sky position angle to hold, all in radians.
// Positive rotator angle follows the same sense as positive position angle, so cancellation subtracts
// the parallactic angle. The offset defaults to zero. Returns the commanded angle in (-π, π].
export function derotatorAngle(hourAngle: Angle, declination: Angle, latitude: Angle, mechanicalOffset: Angle = 0): Angle {
	return normalizePI(mechanicalOffset - parallacticAngle(hourAngle, declination, latitude))
}

// Derotator angle at a uniform sidereal step across a duration.
// Parameters: hourAngle is the target hour angle at seconds zero, in radians, positive west.
// declination and latitude are radians. durationSeconds is the track length and may be zero.
// stepSeconds is the positive sample spacing. mechanicalOffset follows derotatorAngle. The hour
// angle advances at the sidereal rate; the target's own motion is not included. Returns one sample
// at the start and one at the end, plus the steps in between. A non-positive step would not advance,
// so it is rejected. A step so fine that the sample count would exceed 100_000 is rejected before
// the array is allocated.
export function derotatorTrack(hourAngle: Angle, declination: Angle, latitude: Angle, durationSeconds: number, stepSeconds: number, mechanicalOffset: Angle = 0): readonly DerotatorSample[] {
	const angleAt = (seconds: number) => derotatorAngle(hourAngle + SIDEREAL_DRIFT_RATE * seconds, declination, latitude, mechanicalOffset)
	if (!(durationSeconds > 0)) return [{ seconds: 0, angle: angleAt(0) }]
	if (!(stepSeconds > 0) || !Number.isFinite(stepSeconds)) throw new RangeError('derotator step must be positive')
	const count = Math.floor(durationSeconds / stepSeconds) + 2
	if (count > MAX_DEROTATOR_SAMPLES) throw new RangeError('derotator track has too many samples')

	const samples: DerotatorSample[] = []
	for (let seconds = 0; seconds < durationSeconds; seconds += stepSeconds) samples.push({ seconds, angle: angleAt(seconds) })
	const last = samples.at(-1)
	if (last === undefined || durationSeconds - last.seconds > stepSeconds * 1e-9) samples.push({ seconds: durationSeconds, angle: angleAt(durationSeconds) })
	return samples
}
