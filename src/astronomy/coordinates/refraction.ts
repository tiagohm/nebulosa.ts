import { ARCSEC_PER_RADIAN, PIOVERTWO } from '../../core/constants'
import type { Angle } from '../../math/units/angle'
import { DEFAULT_REFRACTION_PARAMETERS, parallacticAngle, unrefractedAltitude } from './astrometry'

// Wavelength-dependent atmospheric refraction for planning. The displacement uses the same bounded,
// Newton-corrected ERFA model as the observed-place transforms. Differential refraction and the
// on-sensor dispersion are the difference of that displacement between two wavelengths. Pressure is
// hPa, temperature is Celsius, and relative humidity is a fraction in [0, 1]. A non-positive apparent
// altitude is outside this planning API and returns undefined.

// Ambient conditions for the refraction model. Omitted fields use the standard refraction defaults
// (1013.25 hPa, 15 °C, 50% relative humidity).
export interface RefractionConditions {
	// Ambient pressure in hPa. Zero suppresses refraction.
	readonly pressure?: number
	// Ambient temperature in degrees Celsius.
	readonly temperature?: number
	// Relative humidity as a fraction in [0, 1], not a percent.
	readonly relativeHumidity?: number
}

// Atmospheric dispersion of a spectral window across the line of sight.
export interface AtmosphericDispersion {
	// Angular length of the dispersion, in radians. Always non-negative.
	readonly angle: Angle
	// Angular length in arcseconds.
	readonly arcseconds: number
	// Position angle of the blueward end, from celestial north toward east, in radians. This is the
	// parallactic angle: the shorter wavelength is shifted toward the zenith. Absent when the caller
	// did not supply the hour angle, declination, and latitude needed to orient the zenith.
	readonly positionAngle?: Angle
	// Dispersion length in pixels. Present when an image scale was supplied.
	readonly pixels?: number
}

// Refractive displacement dZ at one wavelength, in radians.
// Parameters: altitude is the apparent altitude in radians, strictly above the horizon and at most
// π/2. wavelengthMicrons is the observing wavelength in micrometers. conditions overrides the standard
// pressure, temperature, and humidity. Returns the amount to add to the apparent zenith distance to
// recover the unrefracted zenith distance, or undefined on the horizon and below it. The bounded model
// remains finite and positive at low apparent altitudes. At the zenith the displacement is zero.
export function refractiveDisplacement(altitude: Angle, wavelengthMicrons: number, conditions?: RefractionConditions): Angle | undefined {
	if (!(altitude > 0) || altitude > PIOVERTWO) return undefined
	if (altitude === PIOVERTWO) return 0
	const trueAltitude = unrefractedAltitude(altitude, {
		pressure: conditions?.pressure ?? DEFAULT_REFRACTION_PARAMETERS.pressure,
		temperature: conditions?.temperature ?? DEFAULT_REFRACTION_PARAMETERS.temperature,
		relativeHumidity: conditions?.relativeHumidity ?? DEFAULT_REFRACTION_PARAMETERS.relativeHumidity,
		wl: wavelengthMicrons,
	})
	return altitude - trueAltitude
}

// Differential atmospheric refraction between two wavelengths.
// Parameters: altitude is the apparent altitude in radians. wavelengthAMicrons and wavelengthBMicrons
// are the two wavelengths in micrometers; the sign of the result follows that order. conditions
// overrides the ambient defaults. Returns the signed refraction difference in radians,
// or undefined when refractiveDisplacement is undefined. The shorter optical wavelength is refracted
// more, so a blue wavelength minus a red one is positive.
export function differentialRefraction(altitude: Angle, wavelengthAMicrons: number, wavelengthBMicrons: number, conditions?: RefractionConditions): Angle | undefined {
	const first = refractiveDisplacement(altitude, wavelengthAMicrons, conditions)
	const second = refractiveDisplacement(altitude, wavelengthBMicrons, conditions)
	if (first === undefined || second === undefined) return undefined
	return first - second
}

// Size and direction of atmospheric dispersion for a spectral window.
// Parameters: altitude is the apparent altitude in radians. blueMicrons and redMicrons are the window
// edges in micrometers; their order does not matter. The remaining fields match RefractionConditions.
// hourAngle, declination, and latitude, when all three are set, orient the dispersion: positionAngle
// is the parallactic angle, and the shorter wavelength lies toward the zenith. arcsecPerPixel, when
// set, adds the length in pixels. Returns undefined at and below the horizon.
export function atmosphericDispersion(altitude: Angle, blueMicrons: number, redMicrons: number, conditions?: RefractionConditions & { readonly hourAngle?: Angle; readonly declination?: Angle; readonly latitude?: Angle; readonly arcsecPerPixel?: number }): AtmosphericDispersion | undefined {
	const shorter = Math.min(blueMicrons, redMicrons)
	const longer = Math.max(blueMicrons, redMicrons)
	const difference = differentialRefraction(altitude, shorter, longer, conditions)
	if (difference === undefined) return undefined
	const dispersion: AtmosphericDispersion = { angle: Math.abs(difference), arcseconds: Math.abs(difference * ARCSEC_PER_RADIAN) }
	const { hourAngle, declination, latitude, arcsecPerPixel } = conditions ?? {}
	const oriented = hourAngle !== undefined && declination !== undefined && latitude !== undefined ? { ...dispersion, positionAngle: parallacticAngle(hourAngle, declination, latitude) } : dispersion
	if (arcsecPerPixel === undefined) return oriented
	return { ...oriented, pixels: oriented.arcseconds / arcsecPerPixel }
}
