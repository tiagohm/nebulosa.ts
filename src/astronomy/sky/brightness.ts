import { AU_KM, DEG2RAD, EARTH_RADIUS_AU, RAD2DEG } from '../../core/constants'
import { type Vec3, vecAngle, vecLength, vecMinus, vecNegate } from '../../math/linear-algebra/vec3'
import { type Angle, normalizePI } from '../../math/units/angle'
import type { Distance } from '../../math/units/distance'
import type { PositionOverTime } from '../coordinates/astrometry'
import { altitudeOf } from '../events/horizon'
import type { GeographicPosition } from '../observer/location'
import type { Time } from '../time/time'

// Photometric night-sky surface brightness from the Krisciunas & Schaefer (1991, PASP 103, 1033)
// scattered-moonlight model. The sky is the flux sum of three separate components: the natural dark
// sky (airglow, zodiacal light and unresolved starlight), an artificial light-pollution baseline, and
// moonlight scattered by Rayleigh and aerosol (Mie) processes. Brightness is in mag/arcsec²; component
// fluxes are in nanolamberts, the linear unit of the model. Angles are radians and distances are AU.
//
// The scattering function, lunar illuminance and nL conversion are calibrated in the Johnson V band
// at Mauna Kea, and the authors report 8–23% rms agreement with their observations. The model has no
// solar term, so it does not describe twilight, and its plane-parallel airmass saturates at 5 on the
// horizon. Results are reported together with the warnings that mark these regimes. Every call
// allocates a fresh result; nothing is cached or mutated.

// Krisciunas & Schaefer eq. 1 (after Garstang 1986): B[nL] = 34.08 · exp(20.7233 − 0.92104 · m), where
// 0.92104 = 0.4 · ln 10. The zero point is the V-band calibration; for another band it is a consistent
// relative flux scale, so component sums stay exact in that band's magnitude system.
const NANOLAMBERT_ZERO_POINT = 34.08
const NANOLAMBERT_MAGNITUDE_OFFSET = 20.7233
const NANOLAMBERT_MAGNITUDE_SCALE = 0.92104
// Coefficient of sin²Z in the K&S eq. 3 scattering airmass X = (1 − 0.96 sin²Z)^−1/2.
const SCATTERING_AIRMASS_COEFFICIENT = 0.96
// Rayleigh term 10^5.36 of the K&S eq. 21 scattering function, nL per (foot-candle-equivalent illuminance).
const RAYLEIGH_SCATTERING = 10 ** 5.36
// Separation, in degrees, below which K&S use the eq. 19 aureole term 6.2e7/ρ² instead of the eq. 21 Mie term.
const MIE_MINIMUM_SEPARATION_DEGREES = 10
// Coefficient of the eq. 19 aureole term, nL·deg² per unit illuminance.
const AUREOLE_SCATTERING = 6.2e7
// Smallest separation used by the aureole term, in degrees: the lunar radius. Keeps 1/ρ² finite on the disk.
const MINIMUM_SEPARATION_DEGREES = 0.25
// Phase angle, in degrees, inside which the lunar opposition surge is applied: +35% at full Moon,
// tapering linearly to zero at 7° (mentioned in K&S p. 1035; the taper follows Thorstensen's skycalc).
const OPPOSITION_SURGE_DEGREES = 7
// Mean geocentric lunar distance, in AU (384 400 km), at which the K&S lunar illuminance is calibrated.
const MEAN_MOON_DISTANCE: Distance = 384400 / AU_KM
// Solar altitude above which the sky is in twilight; the model has no solar term (−18°, astronomical twilight).
const TWILIGHT_SUN_ALTITUDE: Angle = -18 * DEG2RAD
// Altitude below which this module flags a target or the Moon as high airmass (20°, Kasten–Young airmass ≈ 2.9).
// This is a Nebulosa reliability bound, not a published K&S limit: below it, horizon glow, refraction
// and the saturation of the plane-parallel airmass dominate the error.
const MINIMUM_RELIABLE_ALTITUDE: Angle = 20 * DEG2RAD

// Passband and site calibration of the sky model.
export interface SkyBrightnessModel {
	// Extinction coefficient of the passband at the site, in magnitudes per airmass.
	readonly extinction: number
	// Natural dark-sky zenith brightness, without the Moon and light pollution, in mag/arcsec².
	readonly naturalZenith: number
	// Artificial skyglow at the zenith, in mag/arcsec². Omitted means a site without light pollution.
	readonly lightPollutionZenith?: number
	// Scattered-moonlight colour offset, in magnitudes: the passband brightness minus the K&S V-band
	// brightness of the same moonlight. Zero for V; for another band it must be calibrated by the caller.
	readonly moonOffset: number
}

// Original Krisciunas & Schaefer V-band calibration for Mauna Kea: k = 0.172 mag/airmass and a dark
// zenith of 21.587 V mag/arcsec² (79 nL), without light pollution.
export const KRISCIUNAS_SCHAEFER_V: Readonly<SkyBrightnessModel> = { extinction: 0.172, naturalZenith: 21.587, moonOffset: 0 }

// Lunar geometry seen from the observer.
export interface LunarSkyGeometry {
	// Topocentric geometric altitude of the Moon's centre, in radians. On or below the horizon the
	// Moon contributes nothing.
	readonly altitude: Angle
	// Sun–Moon–observer phase angle, in radians: 0 at full Moon and π at new Moon.
	readonly phaseAngle: Angle
	// Angular distance from the Moon to the target, in radians. Values outside (−π, π] are wrapped.
	readonly separation: Angle
	// Observer–Moon distance, in AU. The lunar illuminance scales with its inverse square. Omitted
	// means the mean distance, 384 400 km.
	readonly distance?: Distance
}

// Direction-dependent inputs of one sky-brightness evaluation.
export interface SkyBrightnessGeometry {
	// Geometric altitude of the target, in radians.
	readonly altitude: Angle
	// Geometric altitude of the Sun's centre, in radians. Used only to flag twilight.
	readonly sunAltitude: Angle
	// The Moon. Omitted leaves the Moon out of the sky, as if it were set.
	readonly moon?: LunarSkyGeometry
}

// Regimes in which the model is outside its calibration. 'twilight': the Sun is above −18° and the
// unmodelled solar term may dominate. 'belowHorizon': the target is on or below the horizon.
// 'highAirmass': the target is below 20°. 'moonHighAirmass': the Moon is up but below 20°.
// 'moonClose': the target is within 10° of the Moon, where the aureole term is poorly constrained.
export type SkyBrightnessWarning = 'twilight' | 'belowHorizon' | 'highAirmass' | 'moonHighAirmass' | 'moonClose'

// Linear component fluxes of one evaluation, in nanolamberts. Absent components are 0.
export interface SkyBrightnessFluxes {
	// Natural dark sky along the line of sight.
	readonly natural: number
	// Artificial skyglow along the line of sight.
	readonly lightPollution: number
	// Scattered moonlight along the line of sight.
	readonly moon: number
	// Sum of the three components.
	readonly total: number
}

// Predicted sky surface brightness toward one target.
export interface SkyBrightness {
	// Total sky brightness, in mag/arcsec².
	readonly total: number
	// Natural dark sky alone, in mag/arcsec².
	readonly natural: number
	// Light pollution alone, in mag/arcsec². Undefined when the model has no light-pollution baseline.
	readonly lightPollution?: number
	// Scattered moonlight alone, in mag/arcsec². Undefined when the Moon is omitted or not above the horizon.
	readonly moon?: number
	// Change of the total caused by the Moon, in magnitudes: zero or negative (brighter).
	readonly moonDelta: number
	// Component fluxes, in nanolamberts.
	readonly fluxes: SkyBrightnessFluxes
	// K&S eq. 3 scattering airmass toward the target, between 1 and 5.
	readonly airmass: number
	// K&S eq. 3 scattering airmass toward the Moon. Undefined when the Moon does not contribute.
	readonly moonAirmass?: number
	// Calibration regimes violated by this evaluation, empty when the prediction is within them.
	readonly warnings: readonly SkyBrightnessWarning[]
}

// One measured sky brightness, from a sky-quality meter or a calibrated image background.
export interface SkyBrightnessMeasurement extends SkyBrightnessGeometry {
	// Measured sky surface brightness in the model passband, in mag/arcsec².
	readonly measured: number
}

// Light-pollution baseline fitted to sky measurements.
export interface SkyBaselineFit {
	// The input model with the fitted lightPollutionZenith. Undefined there when the measurements are
	// not brighter than the natural sky plus moonlight.
	readonly model: SkyBrightnessModel
	// Root-mean-square of measured minus predicted brightness over the used measurements, in magnitudes.
	readonly residualRms: number
	// Number of measurements used by the fit.
	readonly used: number
	// Number of measurements skipped because they carried a warning or a non-finite value.
	readonly rejected: number
}

// Sources of the epoch-dependent geometry.
export interface SkyBrightnessSources {
	// Geocentric J2000/ICRS position of the Sun at a time, in AU.
	readonly sunAt: PositionOverTime
	// Geocentric J2000/ICRS position of the Moon at a time, in AU. Omitted leaves the Moon out.
	readonly moonAt?: PositionOverTime
}

// Converts a surface brightness to the linear K&S flux unit.
// Parameters: magnitude is a surface brightness in mag/arcsec². Returns nanolamberts (K&S eq. 1).
export function skyMagnitudeToNanolamberts(magnitude: number) {
	return NANOLAMBERT_ZERO_POINT * Math.exp(NANOLAMBERT_MAGNITUDE_OFFSET - NANOLAMBERT_MAGNITUDE_SCALE * magnitude)
}

// Converts a linear K&S flux to a surface brightness.
// Parameters: nanolamberts is a positive flux. Returns mag/arcsec²; zero flux returns +Infinity.
export function nanolambertsToSkyMagnitude(nanolamberts: number) {
	return (NANOLAMBERT_MAGNITUDE_OFFSET - Math.log(nanolamberts / NANOLAMBERT_ZERO_POINT)) / NANOLAMBERT_MAGNITUDE_SCALE
}

// K&S eq. 3 scattering airmass of a line of sight at the given geometric altitude, in radians.
// Returns 1 at the zenith and 5 on the horizon; below the horizon it falls back symmetrically.
function scatteringAirmass(altitude: Angle) {
	const cosAltitude = Math.cos(altitude)
	return 1 / Math.sqrt(1 - SCATTERING_AIRMASS_COEFFICIENT * cosAltitude * cosAltitude)
}

// K&S eq. 2 gradient of a zenith brightness along a line of sight of scattering airmass X: the column
// grows as X while the light emitted above the extinction layer is dimmed by 10^(−0.4·k·(X − 1)).
function zenithGradient(airmass: number, extinction: number) {
	return airmass * 10 ** (-0.4 * extinction * (airmass - 1))
}

// Scattered moonlight from K&S eqs. 15, 19, 20 and 21, in V-band nanolamberts before the colour offset.
// Parameters: moon is the lunar geometry with altitude above the horizon; airmass and moonAirmass are
// the K&S scattering airmasses toward the target and the Moon; extinction is in mag/airmass.
function scatteredMoonlight(moon: LunarSkyGeometry, airmass: number, moonAirmass: number, extinction: number) {
	const alpha = Math.abs(normalizePI(moon.phaseAngle)) * RAD2DEG
	const rho = Math.abs(normalizePI(moon.separation)) * RAD2DEG
	const distance = moon.distance ?? MEAN_MOON_DISTANCE
	const distanceRatio = MEAN_MOON_DISTANCE / distance

	// Eq. 20: lunar illuminance outside the atmosphere from the Allen phase law, then the inverse-square
	// distance scaling and the opposition surge near full Moon.
	let illuminance = 10 ** (-0.4 * (3.84 + 0.026 * alpha + 4e-9 * alpha ** 4)) * distanceRatio * distanceRatio
	if (alpha < OPPOSITION_SURGE_DEGREES) illuminance *= 1.35 - 0.05 * alpha

	// Eq. 21 (Rayleigh plus Mie) beyond 10°, eq. 19 aureole inside it, with the disk radius as floor.
	const cosRho = Math.cos(moon.separation)
	const rayleigh = RAYLEIGH_SCATTERING * (1.06 + cosRho * cosRho)
	const aerosol = rho > MIE_MINIMUM_SEPARATION_DEGREES ? 10 ** (6.15 - rho / 40) : AUREOLE_SCATTERING / Math.max(rho, MINIMUM_SEPARATION_DEGREES) ** 2

	// Eq. 15: moonlight dimmed on its way down, times the fraction scattered along the target column.
	return (rayleigh + aerosol) * illuminance * 10 ** (-0.4 * extinction * moonAirmass) * (1 - 10 ** (-0.4 * extinction * airmass))
}

// Predicts the sky surface brightness toward one target.
// Parameters: geometry holds the target, solar and optional lunar altitudes and the lunar phase and
// separation; model holds the passband extinction, natural and light-pollution zenith baselines and the
// moonlight colour offset (Krisciunas & Schaefer V at Mauna Kea by default). The natural sky and the
// light pollution follow the same K&S eq. 2 airmass gradient, so the artificial glow is modelled as
// isotropic; a real light dome is brighter toward its source. Returns the total and per-component
// brightness, the fluxes in nanolamberts and the calibration warnings. The result stays finite for any
// finite geometry, including targets below the horizon and a target on the lunar disk.
export function skyBrightness(geometry: SkyBrightnessGeometry, model: SkyBrightnessModel = KRISCIUNAS_SCHAEFER_V): SkyBrightness {
	const { extinction } = model
	const warnings: SkyBrightnessWarning[] = []

	if (!(geometry.sunAltitude <= TWILIGHT_SUN_ALTITUDE)) warnings.push('twilight')
	if (!(geometry.altitude > 0)) warnings.push('belowHorizon')
	else if (geometry.altitude < MINIMUM_RELIABLE_ALTITUDE) warnings.push('highAirmass')

	const airmass = scatteringAirmass(geometry.altitude)
	const gradient = zenithGradient(airmass, extinction)
	const natural = skyMagnitudeToNanolamberts(model.naturalZenith) * gradient
	const lightPollution = model.lightPollutionZenith === undefined ? 0 : skyMagnitudeToNanolamberts(model.lightPollutionZenith) * gradient

	let moon = 0
	let moonAirmass: number | undefined

	if (geometry.moon !== undefined && geometry.moon.altitude > 0) {
		moonAirmass = scatteringAirmass(geometry.moon.altitude)
		moon = scatteredMoonlight(geometry.moon, airmass, moonAirmass, extinction) * 10 ** (-0.4 * model.moonOffset)
		if (geometry.moon.altitude < MINIMUM_RELIABLE_ALTITUDE) warnings.push('moonHighAirmass')
		if (Math.abs(normalizePI(geometry.moon.separation)) < MIE_MINIMUM_SEPARATION_DEGREES * DEG2RAD) warnings.push('moonClose')
	}

	const total = natural + lightPollution + moon
	const magnitude = nanolambertsToSkyMagnitude(total)

	return {
		total: magnitude,
		natural: nanolambertsToSkyMagnitude(natural),
		lightPollution: lightPollution > 0 ? nanolambertsToSkyMagnitude(lightPollution) : undefined,
		moon: moon > 0 ? nanolambertsToSkyMagnitude(moon) : undefined,
		moonDelta: moon > 0 ? magnitude - nanolambertsToSkyMagnitude(natural + lightPollution) : 0,
		fluxes: { natural, lightPollution, moon, total },
		airmass,
		moonAirmass,
		warnings,
	}
}

// Fits the light-pollution zenith baseline of a site to measured sky brightness.
// Parameters: measurements are sky-quality-meter readings or calibrated image backgrounds in the model
// passband, each with its geometry; model supplies the extinction, the natural zenith and the moonlight
// colour offset, and its own lightPollutionZenith is ignored. The natural sky and the artificial glow
// share the same airmass gradient, so measurements constrain only their sum: the fit holds the natural
// zenith fixed and attributes the excess flux to light pollution. The zenith glow L minimizes the
// relative flux residuals Σ ((B_measured − B_natural − B_moon − L·g) / B_measured)², g being the eq. 2
// gradient, which is a magnitude-like weighting. Measurements carrying any warning (twilight, low
// altitude, close Moon) or a non-finite value are rejected. Returns undefined when no measurement is usable.
export function fitSkyBaseline(measurements: readonly SkyBrightnessMeasurement[], model: SkyBrightnessModel = KRISCIUNAS_SCHAEFER_V): SkyBaselineFit | undefined {
	const base: SkyBrightnessModel = { extinction: model.extinction, naturalZenith: model.naturalZenith, moonOffset: model.moonOffset }
	const usable: SkyBrightnessMeasurement[] = []
	let numerator = 0
	let denominator = 0

	for (const measurement of measurements) {
		if (!Number.isFinite(measurement.measured)) continue
		const prediction = skyBrightness(measurement, base)
		if (prediction.warnings.length > 0) continue

		const measured = skyMagnitudeToNanolamberts(measurement.measured)
		const residual = measured - prediction.fluxes.total
		const gradient = zenithGradient(prediction.airmass, base.extinction)
		const weight = 1 / (measured * measured)
		numerator += weight * gradient * residual
		denominator += weight * gradient * gradient
		usable.push(measurement)
	}

	if (usable.length === 0) return undefined

	const zenith = numerator / denominator
	const fitted: SkyBrightnessModel = zenith > 0 ? { ...base, lightPollutionZenith: nanolambertsToSkyMagnitude(zenith) } : base
	let sum = 0

	for (const measurement of usable) {
		const difference = measurement.measured - skyBrightness(measurement, fitted).total
		sum += difference * difference
	}

	return { model: fitted, residualRms: Math.sqrt(sum / usable.length), used: usable.length, rejected: measurements.length - usable.length }
}

// Reduces an observer, an epoch and a target to the geometry of skyBrightness.
// Parameters: target is the J2000/ICRS direction of the target (its length is irrelevant); time is the
// epoch; location is the observer; sources returns the geocentric J2000 Sun and optional Moon positions
// in AU at that time. Altitudes are geometric (no refraction) from altitudeOf. The lunar altitude gets
// the topocentric parallax of a spherical Earth, tan h' = (sin h − R⊕/d) / cos h; the separation, the
// phase angle and the distance stay geocentric, which errs by up to the ~1° lunar parallax and ~1.7%
// in distance. Returns a fresh geometry.
export function skyBrightnessGeometryAt(target: Vec3, time: Time, location: GeographicPosition, sources: SkyBrightnessSources): SkyBrightnessGeometry {
	const altitude = altitudeOf(target, time, location)
	const sun = sources.sunAt(time)
	const sunAltitude = altitudeOf(sun, time, location)
	if (sources.moonAt === undefined) return { altitude, sunAltitude }

	const moon = sources.moonAt(time)
	const distance = vecLength(moon)
	const geocentricAltitude = altitudeOf(moon, time, location)
	const moonAltitude = Math.atan2(Math.sin(geocentricAltitude) - EARTH_RADIUS_AU / distance, Math.cos(geocentricAltitude))
	const phaseAngle = vecAngle(vecMinus(sun, moon), vecNegate(moon))
	const separation = vecAngle(moon, target)

	return { altitude, sunAltitude, moon: { altitude: moonAltitude, phaseAngle, separation, distance } }
}
