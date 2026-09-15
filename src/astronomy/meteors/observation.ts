import { ECLIPTIC_J2000_MATRIX } from '../../core/constants'
import { matTransposeMulVec } from '../../math/linear-algebra/mat3'
import { type Vec3, vecAngle, vecDot } from '../../math/linear-algebra/vec3'
import { type Angle, normalizeAngle } from '../../math/units/angle'
import { equatorialFromJ2000 } from '../coordinates/coordinate'
import { moon } from '../ephemeris/models/analytical/elpmpp02'
import { earth, sun } from '../ephemeris/models/analytical/vsop87e'
import { altitudeOf } from '../events/horizon'
import { localSiderealTime, type GeographicPosition } from '../observer/location'
import { type Time, timeShift, timeSubtract } from '../time/time'
import { meteorActivityZhr } from './activity'
import { meteorRadiantHorizontal } from './radiant'
import { meteorSolarLongitude } from './solar'
import type { MeteorActivityProfile, MeteorComputationContext, MeteorHorizontalRadiant, MeteorObservingConditions, MeteorRadiant, MeteorVisualObservation, MeteorVisualRate } from './types'

// Visual meteor observation equations and local circumstances. Counts use the standard ZHR
// correction with effective exposure in hours; local rates are idealized geometric rates and do not
// contain an implicit lunar or weather penalty. Such time-dependent effects enter only through an
// explicit caller policy.

// Calculates ZHR from one visual observation using the supplied geometric radiant altitude.
export function meteorZhrFromObservation(observation: MeteorVisualObservation): number {
	const sine = Math.sin(observation.radiantAltitude)
	const exponent = observation.altitudeExponent ?? 1
	if (!(observation.effectiveTime > 0) || !(sine > 0)) return 0
	return (observation.count * observation.obstructionCorrection * observation.populationIndex ** (6.5 - observation.limitingMagnitude)) / (observation.effectiveTime * sine ** exponent)
}

// Concise alias for the direct visual ZHR equation.
export const meteorZhrFromVisualObservation = meteorZhrFromObservation

// Converts a ZHR to an idealized local hourly rate. A radiant at or below the geometric horizon
// produces zero; the return unit is expected meteors per local hour, not ZHR.
export function meteorLocalHourlyRate(zhr: number, observation: MeteorVisualObservation): number {
	const sine = Math.sin(observation.radiantAltitude)
	const exponent = observation.altitudeExponent ?? 1
	if (!(sine > 0)) return 0
	return (zhr * sine ** exponent) / (observation.obstructionCorrection * observation.populationIndex ** (6.5 - observation.limitingMagnitude))
}

// Concise alias for the local expected hourly-rate equation.
export const meteorLocalRate = meteorLocalHourlyRate

// Computes both the corrected ZHR and the idealized local hourly rate for an observation.
export function meteorVisualRate(observation: MeteorVisualObservation): MeteorVisualRate {
	const zhr = meteorZhrFromObservation(observation)
	return { zhr, localHourlyRate: meteorLocalHourlyRate(zhr, observation), observation }
}

// Combines visual observations by exposure, not by an arithmetic average of their ZHR values.
export function combineMeteorVisualObservations(observations: readonly MeteorVisualObservation[]): number {
	let numerator = 0
	let denominator = 0
	for (const observation of observations) {
		const sine = Math.sin(observation.radiantAltitude)
		const exponent = observation.altitudeExponent ?? 1
		if (!(observation.effectiveTime > 0) || !(sine > 0)) continue
		const correction = (observation.obstructionCorrection * observation.populationIndex ** (6.5 - observation.limitingMagnitude)) / sine ** exponent
		numerator += observation.count
		denominator += observation.effectiveTime / correction
	}
	return denominator > 0 ? numerator / denominator : 0
}

// Concise alias for exposure-weighted visual-observation combination.
export const meteorCombineVisualObservations = combineMeteorVisualObservations

// Returns N(m + Δm) / N(m) for a population index r. Positive Δm denotes a fainter magnitude class.
export function meteorMagnitudeRatio(populationIndex: number, deltaMagnitude: number): number {
	return populationIndex ** deltaMagnitude
}

// Converts a population index into the meteor mass index used by common meteor literature.
export function meteorMassIndex(populationIndex: number): number {
	return 1 + 2.3 * Math.log10(populationIndex)
}

// Explicit name for the population-to-mass conversion.
export const meteorMassIndexFromPopulationIndex = meteorMassIndex

// Converts a meteor mass index back into the population index.
export function meteorPopulationIndex(massIndex: number): number {
	return 10 ** ((massIndex - 1) / 2.3)
}

// Explicit name for the mass-to-population conversion.
export const meteorPopulationIndexFromMassIndex = meteorPopulationIndex

// Creates a context once per instant, including the local sidereal time when an observer is given.
export function meteorObservationContext(time: Time, observer?: GeographicPosition): MeteorComputationContext {
	return {
		time,
		solarLongitude: meteorSolarLongitude(time),
		localSiderealTime: observer === undefined ? undefined : localSiderealTime(time, observer),
	}
}

// Computes the Sun, Moon and radiant circumstances at one identified instant. All altitudes are
// geometric and no atmospheric refraction is applied.
export function meteorObservingConditions(radiant: MeteorRadiant, observer: GeographicPosition, time: Time, context?: MeteorComputationContext): MeteorObservingConditions {
	const horizontal = meteorRadiantHorizontal(radiant, observer, time, context)
	const sunVector = context?.sun ?? geocentricSunDirection(time)
	const moonVector = context?.moon ?? moon(time)[0]
	const sunAltitude = altitudeOf(sunVector, time, observer)
	const moonAltitude = altitudeOf(moonVector, time, observer)
	const phase = vecAngle([sunVector[0] - moonVector[0], sunVector[1] - moonVector[1], sunVector[2] - moonVector[2]], [-moonVector[0], -moonVector[1], -moonVector[2]])
	const moonIllumination = (1 + Math.cos(phase)) * 0.5
	const radiantVector = radiantVectorOf(radiant)
	const moonRadiantSeparation = vecAngle(moonVector, radiantVector)
	return { time, sunAltitude, moonAltitude, moonIllumination, moonRadiantSeparation, radiant: horizontal }
}

// Concise alias for time-tagged local meteor circumstances.
export const meteorConditionsAt = meteorObservingConditions

// Integrates the local expected count over a time window. The model supplies the non-universal
// population, limiting magnitude and obstruction policy, and may provide a time-dependent correction.
export function integrateMeteorExpectedCount(profile: MeteorActivityProfile, start: Time, end: Time, options: MeteorExpectedCountOptions): number {
	const duration = timeSubtract(end, start)
	if (!(duration > 0)) return 0
	const step = options.step ?? 1 / 24
	if (!(step > 0) || !Number.isFinite(step)) throw new Error('meteor expected-count integration step must be finite and positive')
	const panels = Math.max(1, Math.ceil(duration / step))
	const h = duration / panels
	if (panels % 2 === 0) {
		let total = 0
		for (let i = 0; i <= panels; i++) {
			const current = timeShift(start, i * h)
			const coefficient = i === 0 || i === panels ? 1 : i % 2 === 0 ? 2 : 4
			total += coefficient * expectedRateAt(profile, current, options)
		}
		return ((total * h) / 3) * 24
	}
	let trapezoid = 0
	let previous = expectedRateAt(profile, start, options)
	for (let i = 1; i <= panels; i++) {
		const current = expectedRateAt(profile, timeShift(start, i * h), options)
		trapezoid += previous + current
		previous = current
	}
	return trapezoid * h * 0.5 * 24
}

// Alias used by planners and applications that describe the same integral as an expected count.
export const meteorExpectedMeteorCount = integrateMeteorExpectedCount

// Computes an exact two-sided Garwood confidence interval for a Poisson count. The interval is
// expressed in counts and uses chi-square quantiles rather than the normal approximation.
export function meteorGarwoodInterval(count: number, confidence: number = 0.95): { readonly lower: number; readonly upper: number } {
	const alpha = 1 - confidence
	const lower = count === 0 ? 0 : chiSquareQuantile(alpha * 0.5, 2 * count) * 0.5
	const upper = chiSquareQuantile(1 - alpha * 0.5, 2 * (count + 1)) * 0.5
	return { lower, upper }
}

// Propagates a Garwood count interval through the linear ZHR scale of one visual observation.
export function meteorGarwoodZhr(observation: MeteorVisualObservation, confidence: number = 0.95): { readonly lower: number; readonly upper: number } {
	const sine = Math.sin(observation.radiantAltitude)
	const exponent = observation.altitudeExponent ?? 1
	if (!(observation.effectiveTime > 0) || !(sine > 0)) return { lower: 0, upper: 0 }
	const factor = (observation.obstructionCorrection * observation.populationIndex ** (6.5 - observation.limitingMagnitude)) / (observation.effectiveTime * sine ** exponent)
	const interval = meteorGarwoodInterval(observation.count, confidence)
	return { lower: interval.lower * factor, upper: interval.upper * factor }
}

// CDF of a chi-square random variable, exposed for independently testing the Garwood quantile path.
export function chiSquareCdf(value: number, degreesOfFreedom: number): number {
	return Math.min(1, Math.max(0, regularizedGammaP(degreesOfFreedom * 0.5, value * 0.5)))
}

// Quantile of a chi-square distribution, solved against the tested incomplete-gamma CDF.
export function chiSquareQuantile(probability: number, degreesOfFreedom: number): number {
	if (!(probability > 0)) return 0
	if (probability >= 1) return Number.POSITIVE_INFINITY
	let low = 0
	let high = Math.max(1, degreesOfFreedom)
	while (chiSquareCdf(high, degreesOfFreedom) < probability) high *= 2
	for (let iteration = 0; iteration < 120; iteration++) {
		const middle = (low + high) * 0.5
		if (chiSquareCdf(middle, degreesOfFreedom) < probability) low = middle
		else high = middle
	}
	return (low + high) * 0.5
}

// Conventional aliases for statistical callers.
export const garwoodInterval = meteorGarwoodInterval
export const garwoodZhr = meteorGarwoodZhr

// Options for expected-count integration. At least the four observation-model parameters are
// explicit so a caller cannot accidentally receive a universal lunar/weather correction.
export interface MeteorExpectedCountOptions {
	// Limiting stellar magnitude.
	readonly limitingMagnitude: number
	// Population index r.
	readonly populationIndex: number
	// Obstruction correction F.
	readonly obstructionCorrection: number
	// Altitude exponent γ.
	readonly altitudeExponent?: number
	// Time-varying radiant altitude in radians.
	readonly radiantAltitude?: (time: Time) => Angle
	// Alternative full horizontal radiant provider.
	readonly radiant?: (time: Time) => MeteorHorizontalRadiant
	// Explicit multiplicative policy for weather/coverage/lunar losses.
	readonly rateCorrection?: (time: Time) => number
	// Integration panel width in days.
	readonly step?: number
	// Shared solar-longitude provider.
	readonly solarLongitude?: (time: Time) => Angle
}

function expectedRateAt(profile: MeteorActivityProfile, time: Time, options: MeteorExpectedCountOptions): number {
	const longitude = options.solarLongitude?.(time) ?? meteorSolarLongitude(time)
	const altitude = options.radiantAltitude?.(time) ?? options.radiant?.(time)?.altitude ?? 0
	const observation: MeteorVisualObservation = { count: 1, effectiveTime: 1, limitingMagnitude: options.limitingMagnitude, populationIndex: options.populationIndex, obstructionCorrection: options.obstructionCorrection, radiantAltitude: altitude, altitudeExponent: options.altitudeExponent }
	return meteorLocalHourlyRate(meteorActivityZhr(profile, longitude), observation) * (options.rateCorrection?.(time) ?? 1)
}

function geocentricSunDirection(time: Time): Vec3 {
	const sunState = sun(time, 'eclipticJ2000')
	const earthState = earth(time, 'eclipticJ2000')
	return matTransposeMulVec(ECLIPTIC_J2000_MATRIX, [sunState[0][0] - earthState[0][0], sunState[0][1] - earthState[0][1], sunState[0][2] - earthState[0][2]])
}

function radiantVectorOf(radiant: MeteorRadiant): Vec3 {
	const cosDeclination = Math.cos(radiant.declination)
	return [cosDeclination * Math.cos(normalizeAngle(radiant.rightAscension)), cosDeclination * Math.sin(normalizeAngle(radiant.rightAscension)), Math.sin(radiant.declination)]
}

// Lanczos approximation used by the regularized gamma CDF; the fixed coefficients are sufficient for
// the small integer shape parameters used by Poisson confidence intervals.
function logGamma(value: number): number {
	const coefficients = [0.9999999999998099, 676.5203681218851, -1259.1392167224028, 771.3234287776531, -176.6150291621406, 12.507343278686905, -0.13857109526572012, 9.984369578019572e-6, 1.5056327351493116e-7]
	if (value < 0.5) return Math.log(Math.PI) - Math.log(Math.sin(Math.PI * value)) - logGamma(1 - value)
	let sum = coefficients[0]
	const shifted = value - 1
	for (let i = 1; i < coefficients.length; i++) sum += coefficients[i] / (shifted + i)
	const t = shifted + coefficients.length - 1.5
	return 0.5 * Math.log(2 * Math.PI) + (shifted + 0.5) * Math.log(t) - t + Math.log(sum)
}

function regularizedGammaP(shape: number, value: number): number {
	if (!(value > 0)) return 0
	if (value < shape + 1) {
		let term = 1 / shape
		let sum = term
		for (let i = 1; i < 1000; i++) {
			term *= value / (shape + i)
			sum += term
			if (Math.abs(term) <= Math.abs(sum) * 3e-15) break
		}
		return sum * Math.exp(-value + shape * Math.log(value) - logGamma(shape))
	}
	let b = value + 1 - shape
	let c = 1 / 1e-300
	let d = 1 / b
	let fraction = d
	for (let i = 1; i < 1000; i++) {
		const an = -i * (i - shape)
		b += 2
		d = an * d + b
		if (Math.abs(d) < 1e-300) d = 1e-300
		c = b + an / c
		if (Math.abs(c) < 1e-300) c = 1e-300
		d = 1 / d
		const delta = d * c
		fraction *= delta
		if (Math.abs(delta - 1) <= 3e-15) break
	}
	return 1 - Math.exp(-value + shape * Math.log(value) - logGamma(shape)) * fraction
}
