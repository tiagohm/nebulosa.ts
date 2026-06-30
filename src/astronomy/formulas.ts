import { ARCSEC_PER_RADIAN, DEG2RAD, PIOVERTWO, RAD2DEG, SIDEREAL_RATE } from '../core/constants'
import { validateDeclination, validateFinite, validateInRange, validateNonNegativeFinite, validatePositiveAltitude, validatePositiveFinite } from '../core/validation'
import type { Angle } from '../math/units/angle'
import type { Distance } from '../math/units/distance'

// Observation-planning formulas for telescopes, cameras, and imaging: optics (magnification, focal
// length/ratio, resolving limits, exit pupil, fields of view), sampling and pixel scale, exposure and
// SNR/dynamic-range estimates, star-trail limits, airmass/extinction/refraction, dew point, and target
// magnitudes. These are first-order planning estimates, not high-precision physical models. Inputs are
// validated and units are stated per function (mm, microns, arcseconds, electrons, radians, Celsius).

// Arcseconds per radian divided by 1000: converts (pixel size in microns / focal length in mm) to arcsec/pixel.
const ARCSECONDS_PER_PIXEL_FACTOR = ARCSEC_PER_RADIAN / 1000
// cos(declination) below this is treated as the pole, where the max-exposure denominator becomes unstable.
const MAX_EXPOSURE_COSINE_EPSILON = 1e-12
// Magnus formula coefficients for the dew-point approximation over water (dimensionless a, b in °C).
const MAGNUS_A_WATER = 17.625
const MAGNUS_B_CELSIUS = 243.04

export interface EyepieceView {
	// Visual magnification, dimensionless.
	readonly magnification: number
	// True field of view in degrees, estimated as apparentFieldOfViewDegrees / magnification.
	readonly trueFieldOfViewDegrees: number
	// Exit pupil diameter in millimeters.
	readonly exitPupilMm: number
}

// Magnification. Planning formula M = F_telescope / F_eyepiece.
// Parameters: telescopeFocalLengthMm and eyepieceFocalLengthMm are positive focal lengths in the same length unit, preferably millimeters.
// Returns: dimensionless magnification. This is an estimation formula, not a high-precision optical simulation.
export function magnification(telescopeFocalLengthMm: number, eyepieceFocalLengthMm: number) {
	return validatePositiveFinite(telescopeFocalLengthMm) / validatePositiveFinite(eyepieceFocalLengthMm)
}

// Focal Length. Planning formula focal_length = aperture * focal_ratio.
// Parameters: apertureMm is a positive aperture in millimeters, and focalRatio is a positive f-number.
// Returns: telescope focal length in millimeters.
export function focalLength(apertureMm: number, focalRatio: number) {
	return validatePositiveFinite(apertureMm) * validatePositiveFinite(focalRatio)
}

// Focal Ratio. Planning formula focal_ratio = focal_length / aperture.
// Parameters: focalLengthMm and apertureMm are positive lengths in millimeters.
// Returns: dimensionless focal ratio.
export function focalRatio(focalLengthMm: number, apertureMm: number) {
	return validatePositiveFinite(focalLengthMm) / validatePositiveFinite(apertureMm)
}

// Dawes Limit. Planning formula resolving_power = 116 / aperture.
// Parameters: apertureMm is a positive aperture in millimeters.
// Returns: approximate resolving power in arcseconds.
export function dawesLimit(apertureMm: number) {
	return 116 / validatePositiveFinite(apertureMm)
}

// Rayleigh Limit. Planning formula resolving_power = 138 / aperture.
// Parameters: apertureMm is a positive aperture in millimeters.
// Returns: approximate resolving power in arcseconds.
export function rayleighLimit(apertureMm: number) {
	return 138 / validatePositiveFinite(apertureMm)
}

// Limiting Magnitude. Planning formula m = 2.7 + 5 * log10(aperture).
// Parameters: apertureMm is a positive aperture in millimeters.
// Returns: approximate stellar limiting magnitude.
export function limitingMagnitude(apertureMm: number) {
	return 2.7 + 5 * Math.log10(validatePositiveFinite(apertureMm))
}

// Light Grasp Ratio. Planning formula ratio = (larger_aperture / smaller_aperture)^2.
// Parameters: largerApertureMm and smallerApertureMm are positive apertures in millimeters; largerApertureMm must be at least smallerApertureMm.
// Returns: dimensionless light grasp ratio.
export function lightGraspRatio(largerApertureMm: number, smallerApertureMm: number) {
	const larger = validatePositiveFinite(largerApertureMm)
	const smaller = validatePositiveFinite(smallerApertureMm)
	if (larger < smaller) throw new RangeError('larger aperture must be at least smaller aperture')
	const ratio = larger / smaller
	return ratio * ratio
}

export function exitPupil(apertureDiameterMm: number, magnification: number): number
export function exitPupil(eyepieceFocalLengthMm: number, focalRatio: number): number
// Exit Pupil. Planning formula P = D / M or P = F_eyepiece / focal_ratio.
// Parameters: the first value is a positive aperture or eyepiece focal length, and the second is a positive magnification or focal ratio.
// Returns: exit pupil diameter in the same length unit as the first value, preferably millimeters.
export function exitPupil(lengthMm: number, divisor: number) {
	return validatePositiveFinite(lengthMm) / validatePositiveFinite(divisor)
}

// Exit Pupil helper for P = D / M.
// Parameters: apertureDiameterMm is a positive aperture diameter, and magnification is positive and dimensionless.
// Returns: exit pupil diameter in the same length unit as apertureDiameterMm, preferably millimeters.
export function exitPupilFromApertureAndMagnification(apertureDiameterMm: number, magnification: number) {
	return exitPupil(apertureDiameterMm, magnification)
}

// Exit Pupil helper for P = F_eyepiece / focal_ratio.
// Parameters: eyepieceFocalLengthMm is a positive eyepiece focal length, and focalRatio is a positive f-number.
// Returns: exit pupil diameter in the same length unit as eyepieceFocalLengthMm, preferably millimeters.
export function exitPupilFromEyepieceAndFocalRatio(eyepieceFocalLengthMm: number, focalRatio: number) {
	return exitPupil(eyepieceFocalLengthMm, focalRatio)
}

// Eyepiece True FOV via Field Stop. Planning formula TFOV = RAD2DEG * field_stop / F_telescope.
// Parameters: fieldStopDiameterMm and telescopeFocalLengthMm are positive lengths in millimeters.
// Returns: true field of view in degrees, using the small-angle approximation field_stop / F_telescope for the angle in radians.
export function eyepieceTrueFovViaFieldStop(fieldStopDiameterMm: number, telescopeFocalLengthMm: number) {
	return (RAD2DEG * validatePositiveFinite(fieldStopDiameterMm)) / validatePositiveFinite(telescopeFocalLengthMm)
}

// Plate Scale. Planning formula arcsec/mm = 206265 / F_telescope.
// Parameters: telescopeFocalLengthMm is a positive focal length in millimeters.
// Returns: focal-plane scale in arcseconds per millimeter.
export function plateScale(telescopeFocalLengthMm: number) {
	return ARCSEC_PER_RADIAN / validatePositiveFinite(telescopeFocalLengthMm)
}

// Pixel Scale. Planning formula arcsec/pixel = 206.265 * pixel_size_microns / F_telescope_mm.
// Parameters: pixelSizeMicrons is a positive pixel size in microns, and telescopeFocalLengthMm is a positive focal length in millimeters.
// Returns: image scale in arcseconds per pixel.
export function pixelScale(pixelSizeMicrons: number, telescopeFocalLengthMm: number) {
	return (ARCSECONDS_PER_PIXEL_FACTOR * validatePositiveFinite(pixelSizeMicrons)) / validatePositiveFinite(telescopeFocalLengthMm)
}

// Sampling Ratio. Planning formula sampling = seeing_arcsec / arcsec_per_pixel.
// Parameters: seeingArcsec and arcsecPerPixel are positive angular scales in arcseconds.
// Returns: dimensionless sampling ratio.
export function samplingRatio(seeingArcsec: number, arcsecPerPixel: number) {
	return validatePositiveFinite(seeingArcsec) / validatePositiveFinite(arcsecPerPixel)
}

// Recommended Focal Length. Planning formula F = 206.265 * pixel_size_microns * sampling / seeing_arcsec.
// Parameters: pixelSizeMicrons is positive, targetSampling is positive and dimensionless, and seeingArcsec is positive.
// Returns: recommended focal length in millimeters.
export function recommendedFocalLength(pixelSizeMicrons: number, targetSampling: number, seeingArcsec: number) {
	return (ARCSECONDS_PER_PIXEL_FACTOR * validatePositiveFinite(pixelSizeMicrons) * validatePositiveFinite(targetSampling)) / validatePositiveFinite(seeingArcsec)
}

// Airy Disk Size. Approximate planning formula diameter = 2.44 * wavelength * focal_ratio.
// Parameters: wavelengthMicrons is a positive wavelength in microns, and focalRatio is a positive f-number.
// Returns: Airy disk diameter in microns.
export function airyDiskSize(wavelengthMicrons: number, focalRatio: number) {
	return 2.44 * validatePositiveFinite(wavelengthMicrons) * validatePositiveFinite(focalRatio)
}

// Airy Disk in Pixels. Planning formula airy_px = airy_diameter_microns / pixel_size_microns.
// Parameters: airyDiameterMicrons and pixelSizeMicrons are positive lengths in microns.
// Returns: Airy disk diameter in pixels.
export function airyDiskInPixels(airyDiameterMicrons: number, pixelSizeMicrons: number) {
	return validatePositiveFinite(airyDiameterMicrons) / validatePositiveFinite(pixelSizeMicrons)
}

// Critical Focus Zone. Approximate planning formula CFZ ~= 4.88 * wavelength * N^2.
// Parameters: wavelengthMicrons is a positive wavelength in microns, and focalRatioN is a positive f-number.
// Returns: critical focus zone in microns.
export function criticalFocusZone(wavelengthMicrons: number, focalRatioN: number) {
	const ratio = validatePositiveFinite(focalRatioN)
	return 4.88 * validatePositiveFinite(wavelengthMicrons) * ratio * ratio
}

// Effective Aperture with Obstruction. Planning formula D_eff = sqrt(D^2 - d_obstruction^2).
// Parameters: apertureDiameter and obstructionDiameter use the same length unit; aperture must be positive and obstruction must be non-negative and smaller than aperture.
// Returns: effective aperture in the same length unit.
export function effectiveApertureWithObstruction(apertureDiameter: number, obstructionDiameter: number) {
	const aperture = validatePositiveFinite(apertureDiameter)
	const obstruction = validateNonNegativeFinite(obstructionDiameter)
	if (obstruction >= aperture) throw new RangeError('obstruction diameter must be smaller than aperture diameter')
	return Math.sqrt(aperture * aperture - obstruction * obstruction)
}

// Obstruction Ratio. Planning formula obstruction_percent = 100 * d_obstruction / D.
// Parameters: apertureDiameter and obstructionDiameter use the same length unit; aperture must be positive and obstruction must be non-negative and no larger than aperture.
// Returns: obstruction ratio in percent.
export function obstructionRatio(apertureDiameter: number, obstructionDiameter: number) {
	const aperture = validatePositiveFinite(apertureDiameter)
	const obstruction = validateNonNegativeFinite(obstructionDiameter)
	if (obstruction > aperture) throw new RangeError('obstruction diameter must be no larger than aperture diameter')
	return (100 * obstruction) / aperture
}

// Sensor Diagonal FOV. Planning formula FOV_diag = 2 * atan(sensor_diag / (2F)).
// Parameters: sensorDiagonal and focalLength are positive lengths in the same unit.
// Returns: diagonal field of view in radians.
export function sensorDiagonalFov(sensorDiagonal: number, focalLength: number) {
	return 2 * Math.atan(validatePositiveFinite(sensorDiagonal) / (2 * validatePositiveFinite(focalLength)))
}

// Sensor Field Of View. Planning formula FOV = sensor_size / focal_length * RAD2DEG.
// Parameters: sensorSizeMm and focalLengthMm are positive lengths in millimeters.
// Returns: angular field of view in degrees along one sensor axis, using the small-angle approximation for the angle in radians.
export function sensorFieldOfView(sensorSizeMm: number, focalLengthMm: number) {
	return (validatePositiveFinite(sensorSizeMm) / validatePositiveFinite(focalLengthMm)) * RAD2DEG
}

// Eyepiece View. Planning formula magnification = telescope_focal_length / eyepiece_focal_length.
// Parameters: telescopeFocalLengthMm, apertureMm, eyepieceFocalLengthMm, and apparentFieldOfViewDegrees are positive visual telescope and eyepiece values.
// Returns: visual magnification, true field in degrees, and exit pupil in millimeters.
export function eyepieceView(telescopeFocalLengthMm: number, apertureMm: number, eyepieceFocalLengthMm: number, apparentFieldOfViewDegrees: number): EyepieceView {
	const power = magnification(telescopeFocalLengthMm, eyepieceFocalLengthMm)
	return { magnification: power, trueFieldOfViewDegrees: validatePositiveFinite(apparentFieldOfViewDegrees) / power, exitPupilMm: validatePositiveFinite(apertureMm) / power }
}

// Mosaic Panel Count. One-dimensional planning formula panels = ceil(target_fov / (camera_fov * (1 - overlap))).
// Parameters: targetFov and cameraFov are positive angular widths in the same unit, and overlap is a finite fraction in [0, 1).
// Returns: integer panel count for one axis.
export function mosaicPanelCount(targetFov: number, cameraFov: number, overlap: number) {
	const overlapFraction = validateInRange(overlap, 0, 1 - Number.EPSILON)
	return Math.ceil(validatePositiveFinite(targetFov) / (validatePositiveFinite(cameraFov) * (1 - overlapFraction)))
}

// Guiding Error in Pixels. Planning formula error_px = RMS_arcsec / image_scale.
// Parameters: rmsArcsec is a non-negative RMS guiding error in arcseconds, and imageScaleArcsecPerPixel is a positive image scale.
// Returns: guiding error in pixels.
export function guidingErrorInPixels(rmsArcsec: number, imageScaleArcsecPerPixel: number) {
	return validateNonNegativeFinite(rmsArcsec) / validatePositiveFinite(imageScaleArcsecPerPixel)
}

// Periodic Error in Pixels. Planning formula PE_px = PE_arcsec / image_scale.
// Parameters: periodicErrorArcsec is a non-negative mount periodic error in arcseconds, and imageScaleArcsecPerPixel is a positive image scale.
// Returns: periodic error in pixels.
export function periodicErrorInPixels(periodicErrorArcsec: number, imageScaleArcsecPerPixel: number) {
	return validateNonNegativeFinite(periodicErrorArcsec) / validatePositiveFinite(imageScaleArcsecPerPixel)
}

// Star Trail Length. Planning formula trail_px = 15.041 * cos(dec) * t / image_scale.
// Parameters: declination is within [-pi/2, pi/2], exposureSeconds is non-negative, and imageScaleArcsecPerPixel is positive.
// Returns: star trail length in pixels.
export function starTrailLength(declination: Angle, exposureSeconds: number, imageScaleArcsecPerPixel: number) {
	declination = validateDeclination(declination)
	return (SIDEREAL_RATE * Math.cos(declination) * validateNonNegativeFinite(exposureSeconds)) / validatePositiveFinite(imageScaleArcsecPerPixel)
}

// Max Exposure Before Trail. Planning formula t_max = trail_limit_px * image_scale / (15.041 * cos(dec)).
// Parameters: trailLimitPixels is non-negative, imageScaleArcsecPerPixel is positive, and declination is within [-pi/2, pi/2].
// Returns: maximum exposure time in seconds; near-pole declinations are rejected because cos(dec) makes the denominator unstable.
export function maxExposureBeforeTrail(trailLimitPixels: number, imageScaleArcsecPerPixel: number, declination: Angle) {
	const cosine = Math.cos(validateDeclination(declination))
	if (cosine <= MAX_EXPOSURE_COSINE_EPSILON) throw new RangeError('declination is too close to the celestial pole')
	return (validateNonNegativeFinite(trailLimitPixels) * validatePositiveFinite(imageScaleArcsecPerPixel)) / (SIDEREAL_RATE * cosine)
}

// Signal-to-Noise Ratio. Planning formula SNR = S / sqrt(S + n_pix * (B + D + RN^2)).
// Parameters: signalElectrons, backgroundElectronsPerPixel, darkCurrentElectronsPerPixel, and readNoiseElectrons are non-negative accumulated electrons; pixelCount is positive.
// Returns: dimensionless signal-to-noise ratio.
export function signalToNoiseRatio(signalElectrons: number, pixelCount: number, backgroundElectronsPerPixel: number, darkCurrentElectronsPerPixel: number, readNoiseElectrons: number) {
	const signal = validateNonNegativeFinite(signalElectrons)
	const readNoise = validateNonNegativeFinite(readNoiseElectrons)
	const noiseVariance = signal + validatePositiveFinite(pixelCount) * (validateNonNegativeFinite(backgroundElectronsPerPixel) + validateNonNegativeFinite(darkCurrentElectronsPerPixel) + readNoise * readNoise)
	if (noiseVariance <= 0) throw new RangeError('noise variance must be positive')
	return signal / Math.sqrt(noiseVariance)
}

// Stacking SNR Gain. Planning formula SNR_gain = sqrt(N).
// Parameters: frameCount is a positive finite frame count.
// Returns: dimensionless signal-to-noise gain.
export function stackingSnrGain(frameCount: number) {
	return Math.sqrt(validatePositiveFinite(frameCount))
}

// Stacking Magnitude Gain. Planning formula delta_mag = 1.25 * log10(N).
// Parameters: frameCount is a positive finite frame count.
// Returns: limiting magnitude gain in magnitudes.
export function stackingMagnitudeGain(frameCount: number) {
	return 1.25 * Math.log10(validatePositiveFinite(frameCount))
}

// Dynamic Range. Planning formula DR = full_well / read_noise.
// Parameters: fullWellElectrons and readNoiseElectrons are positive electron counts.
// Returns: dimensionless dynamic range ratio.
export function dynamicRange(fullWellElectrons: number, readNoiseElectrons: number) {
	return validatePositiveFinite(fullWellElectrons) / validatePositiveFinite(readNoiseElectrons)
}

// Dynamic Range in Stops. Planning formula DR_stops = log2(full_well / read_noise).
// Parameters: fullWellElectrons and readNoiseElectrons are positive electron counts.
// Returns: dynamic range in photographic stops.
export function dynamicRangeInStops(fullWellElectrons: number, readNoiseElectrons: number) {
	return Math.log2(dynamicRange(fullWellElectrons, readNoiseElectrons))
}

// Saturation Time. Planning formula t_sat = full_well / signal_rate.
// Parameters: fullWellElectrons is a positive electron capacity, and signalRateElectronsPerSecond is a positive rate.
// Returns: saturation time in seconds.
export function saturationTime(fullWellElectrons: number, signalRateElectronsPerSecond: number) {
	return validatePositiveFinite(fullWellElectrons) / validatePositiveFinite(signalRateElectronsPerSecond)
}

// Sky-Limited Exposure. Approximate planning formula t ~= 10 * RN^2 / sky_rate.
// Parameters: readNoiseElectrons is non-negative, and skyRateElectronsPerSecond is positive.
// Returns: exposure time in seconds.
export function skyLimitedExposure(readNoiseElectrons: number, skyRateElectronsPerSecond: number) {
	const readNoise = validateNonNegativeFinite(readNoiseElectrons)
	return (10 * readNoise * readNoise) / validatePositiveFinite(skyRateElectronsPerSecond)
}

// Total Integration Time. Planning formula T = N * exposure_time.
// Parameters: frameCount and exposureTimeSeconds are non-negative finite values.
// Returns: total integration time in seconds.
export function totalIntegrationTime(frameCount: number, exposureTimeSeconds: number) {
	return validateNonNegativeFinite(frameCount) * validateNonNegativeFinite(exposureTimeSeconds)
}

// Subframe Count. Planning formula N = total_time / sub_exposure.
// Parameters: totalTimeSeconds is non-negative, and subExposureSeconds is positive.
// Returns: subframe count as a floating-point value without rounding.
export function subframeCount(totalTimeSeconds: number, subExposureSeconds: number) {
	return validateNonNegativeFinite(totalTimeSeconds) / validatePositiveFinite(subExposureSeconds)
}

// Required Subframe Count. Whole-frame helper using ceil(subframeCount(...)).
// Parameters: totalTimeSeconds is non-negative, and subExposureSeconds is positive.
// Returns: integer frame count rounded up to cover the requested total time.
export function requiredSubframeCount(totalTimeSeconds: number, subExposureSeconds: number) {
	return Math.ceil(subframeCount(totalTimeSeconds, subExposureSeconds))
}

// Airmass. Basic planning approximation X ~= sec(z).
// Parameters: zenithDistance is within [0, pi/2) radians.
// Returns: dimensionless airmass; use airmassKastenYoung for low-altitude objects.
export function airmass(zenithDistance: Angle) {
	zenithDistance = validateInRange(zenithDistance, 0, PIOVERTWO - Number.EPSILON)
	return 1 / Math.cos(zenithDistance)
}

// Airmass Kasten-Young. Improved planning approximation near the horizon.
// Parameters: altitude is finite and above the horizon in (0, pi/2]; constants 6.07995 and -1.6364 use altitude in degrees.
// Returns: dimensionless airmass.
export function airmassKastenYoung(altitude: Angle) {
	altitude = validatePositiveAltitude(altitude)
	return 1 / (Math.sin(altitude) + 0.50572 * (altitude * RAD2DEG + 6.07995) ** -1.6364)
}

// Atmospheric Extinction. Planning formula delta_m = k * X.
// Parameters: extinctionCoefficientMagPerAirmass is non-negative, and airmass is at least 1 for normal above-horizon observations.
// Returns: magnitude loss.
export function atmosphericExtinction(extinctionCoefficientMagPerAirmass: number, airmass: number) {
	const value = validateFinite(airmass)
	if (value < 1) throw new RangeError('airmass must be at least 1')
	return validateNonNegativeFinite(extinctionCoefficientMagPerAirmass) * value
}

// Atmospheric Refraction. Approximate planning formula R = 1.02 / tan(h + 10.3 / (h + 5.11)) arcmin.
// Parameters: altitude is an apparent altitude in (0, pi/2] radians; h and the tangent argument are converted through degrees.
// Returns: refraction correction in arcminutes.
export function atmosphericRefraction(altitude: Angle) {
	const altitudeDeg = validatePositiveAltitude(altitude) * RAD2DEG
	return 1.02 / Math.tan((altitudeDeg + 10.3 / (altitudeDeg + 5.11)) * DEG2RAD)
}

// Dew Point. Magnus approximation dew_point = b * alpha / (a - alpha).
// Parameters: temperatureCelsius is finite ambient temperature in degrees Celsius, and relativeHumidityPercent is within (0, 100].
// Returns: estimated dew point in degrees Celsius.
export function dewPoint(temperatureCelsius: number, relativeHumidityPercent: number) {
	const temperature = validateFinite(temperatureCelsius)
	const humidity = validateFinite(relativeHumidityPercent)
	if (humidity <= 0 || humidity > 100) throw new RangeError('relative humidity must be within (0, 100]')
	const alpha = (MAGNUS_A_WATER * temperature) / (MAGNUS_B_CELSIUS + temperature) + Math.log(humidity / 100)
	return (MAGNUS_B_CELSIUS * alpha) / (MAGNUS_A_WATER - alpha)
}

// Altitude at Transit. Planning formula alt = 90deg - abs(latitude - declination).
// Parameters: latitude and declination are within [-pi/2, pi/2] radians.
// Returns: altitude at meridian transit in radians.
export function altitudeAtTransit(latitude: Angle, declination: Angle) {
	return PIOVERTWO - Math.abs(validateInRange(latitude, -PIOVERTWO, PIOVERTWO) - validateDeclination(declination))
}

// Hour Angle at Altitude. Geometric formula cos(H) = (sin(h0) - sin(lat) * sin(dec)) / (cos(lat) * cos(dec)).
// Parameters: declination and latitude are within [-pi/2, pi/2] radians; targetAltitude is the altitude
// h0 (radians) the body should reach. For rise/set use a small negative h0 that folds in refraction and
// semidiameter, e.g. about -0.5667 deg for the solar/lunar upper limb or -0.8333 deg for the Sun's center.
// Returns: the non-negative hour angle in radians at which the body crosses h0; the body is at that
// altitude at hour angle -H (rising, east of the meridian) and +H (setting, west). Returns null when the
// body never reaches h0 (it stays above it, i.e. circumpolar, or stays below it), and at the geographic
// poles, where the diurnal circle is a parallel of altitude and the formula is degenerate.
export function hourAngleAtAltitude(declination: Angle, latitude: Angle, targetAltitude: Angle): Angle | null {
	declination = validateDeclination(declination)
	latitude = validateInRange(latitude, -PIOVERTWO, PIOVERTWO)
	const denominator = Math.cos(latitude) * Math.cos(declination)
	if (denominator === 0) return null
	const cosHourAngle = (Math.sin(validateFinite(targetAltitude)) - Math.sin(latitude) * Math.sin(declination)) / denominator
	if (cosHourAngle < -1 || cosHourAngle > 1) return null
	return Math.acos(cosHourAngle)
}

// Object Angular Diameter. Planning formula theta = 2 * atan(diameter / (2 * distance)).
// Parameters: objectDiameter and distance are positive lengths in the same unit.
// Returns: angular diameter in radians.
export function objectAngularDiameter(objectDiameter: number, distance: number) {
	return 2 * Math.atan(validatePositiveFinite(objectDiameter) / (2 * validatePositiveFinite(distance)))
}

// Surface Brightness. Planning formula SB = mag + 2.5 * log10(area_arcsec_squared).
// Parameters: magnitude is finite, and areaArcsecSquared is a positive area in square arcseconds.
// Returns: surface brightness in magnitudes per square arcsecond.
export function surfaceBrightness(magnitude: number, areaArcsecSquared: number) {
	return validateFinite(magnitude) + 2.5 * Math.log10(validatePositiveFinite(areaArcsecSquared))
}

// Comet Magnitude Estimate. Planning formula m = H + 5 * log10(delta) + k * log10(r).
// Parameters: absoluteMagnitudeH and activityCoefficientK are finite, delta and heliocentricDistance are positive distances in AU.
// Returns: estimated apparent magnitude.
export function cometMagnitudeEstimate(absoluteMagnitudeH: number, delta: Distance, heliocentricDistance: Distance, activityCoefficientK: number) {
	return validateFinite(absoluteMagnitudeH) + 5 * Math.log10(validatePositiveFinite(delta)) + validateFinite(activityCoefficientK) * Math.log10(validatePositiveFinite(heliocentricDistance))
}

// Asteroid Magnitude Estimate. Planning formula m = H + 5 * log10(r * delta) + phase_correction.
// Parameters: absoluteMagnitudeH and phaseCorrectionMagnitude are finite, heliocentricDistance and delta are positive distances in AU.
// Returns: estimated apparent magnitude.
export function asteroidMagnitudeEstimate(absoluteMagnitudeH: number, heliocentricDistance: Distance, delta: Distance, phaseCorrectionMagnitude: number) {
	return validateFinite(absoluteMagnitudeH) + 5 * Math.log10(validatePositiveFinite(heliocentricDistance) * validatePositiveFinite(delta)) + validateFinite(phaseCorrectionMagnitude)
}
