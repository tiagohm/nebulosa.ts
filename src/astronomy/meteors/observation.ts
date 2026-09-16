import { ECLIPTIC_J2000_MATRIX } from '../../core/constants'
import { matTransposeMulVec } from '../../math/linear-algebra/mat3'
import { type Vec3, vecAngle } from '../../math/linear-algebra/vec3'
import { chiSquareQuantile } from '../../math/numerical/statistics'
import { type Angle, normalizeAngle } from '../../math/units/angle'
import { moon } from '../ephemeris/models/analytical/elpmpp02'
import { earth, sun } from '../ephemeris/models/analytical/vsop87e'
import { altitudeOf } from '../events/horizon'
import { localSiderealTime, type GeographicPosition } from '../observer/location'
import { type Time, timeShift, timeSubtract } from '../time/time'
import { meteorActivityZhr } from './activity'
import { meteorRadiantHorizontal } from './radiant'
import { meteorSolarLongitude } from './solar'
import type { MeteorActivityProfile, MeteorComputationContext, MeteorHorizontalRadiant, MeteorMagnitudeBin, MeteorObservingConditions, MeteorPopulationIndexOptions, MeteorRadiant, MeteorVisualObservation, MeteorVisualRate } from './types'

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

// Converts a ZHR to an idealized local hourly rate. A radiant at or below the geometric horizon
// produces zero; the return unit is expected meteors per local hour, not ZHR.
export function meteorLocalHourlyRate(zhr: number, observation: MeteorVisualObservation): number {
	const sine = Math.sin(observation.radiantAltitude)
	const exponent = observation.altitudeExponent ?? 1
	if (!(sine > 0)) return 0
	return (zhr * sine ** exponent) / (observation.obstructionCorrection * observation.populationIndex ** (6.5 - observation.limitingMagnitude))
}

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

// Returns N(m + Δm) / N(m) for a population index r. Positive Δm denotes a fainter magnitude class.
export function meteorMagnitudeRatio(populationIndex: number, deltaMagnitude: number): number {
	return populationIndex ** deltaMagnitude
}

// Converts a population index into the meteor mass index used by common meteor literature.
export function meteorMassIndex(populationIndex: number): number {
	return 1 + 2.3 * Math.log10(populationIndex)
}

// Converts a meteor mass index back into the population index.
export function meteorPopulationIndex(massIndex: number): number {
	return 10 ** ((massIndex - 1) / 2.3)
}

// Estimates the population index r from N(m) = C r^m by linear regression of ln N against
// magnitude. The default Poisson weighting gives populous bins proportionally more influence;
// zero-count bins carry no logarithmic information and are omitted.
export function meteorPopulationIndexFromMagnitudeBins(bins: readonly MeteorMagnitudeBin[], options: MeteorPopulationIndexOptions = {}): number | undefined {
	let weightSum = 0
	let weightedMagnitude = 0
	let weightedLogCount = 0
	let useful = 0

	for (const bin of bins) {
		if (!Number.isFinite(bin.magnitude)) throw new Error('meteor magnitude-bin magnitudes must be finite')
		if (!(bin.count >= 0) || !Number.isFinite(bin.count)) throw new Error('meteor magnitude-bin counts must be finite and non-negative')
		if (bin.count === 0) continue
		const weight = options.weighted === false ? 1 : bin.count
		weightSum += weight
		weightedMagnitude += weight * bin.magnitude
		weightedLogCount += weight * Math.log(bin.count)
		useful++
	}

	if (useful < 2 || !(weightSum > 0)) return undefined
	const meanMagnitude = weightedMagnitude / weightSum
	const meanLogCount = weightedLogCount / weightSum
	let covariance = 0
	let variance = 0

	for (const bin of bins) {
		if (bin.count === 0) continue
		const weight = options.weighted === false ? 1 : bin.count
		const delta = bin.magnitude - meanMagnitude
		covariance += weight * delta * (Math.log(bin.count) - meanLogCount)
		variance += weight * delta * delta
	}

	if (!(variance > 0)) return undefined
	const result = Math.exp(covariance / variance)
	return result > 0 && Number.isFinite(result) ? result : undefined
}

// Creates a context once per instant, including the local sidereal time when an observer is given.
export function meteorObservationContext(time: Time, observer?: GeographicPosition): MeteorComputationContext {
	return { time, solarLongitude: meteorSolarLongitude(time), localSiderealTime: observer === undefined ? undefined : localSiderealTime(time, observer) }
}

// Computes the Sun, Moon and radiant circumstances at one identified instant. All altitudes are
// geometric and no atmospheric refraction is applied.
export function meteorObservingConditionsAt(radiant: MeteorRadiant, observer: GeographicPosition, time: Time, context?: MeteorComputationContext): MeteorObservingConditions {
	const horizontal = meteorRadiantHorizontal(radiant, observer, time, context)
	const sunVector = context?.sun ?? meteorSunDirection(time)
	const moonVector = context?.moon ?? meteorMoonDirection(time)
	const sunAltitude = altitudeOf(sunVector, time, observer)
	const moonAltitude = altitudeOf(moonVector, time, observer)
	const moonIllumination = meteorMoonIllumination(sunVector, moonVector)
	const radiantVector = radiantVectorOf(radiant)
	const moonRadiantSeparation = vecAngle(moonVector, radiantVector)
	return { time, sunAltitude, moonAltitude, moonIllumination, moonRadiantSeparation, radiant: horizontal }
}

// Returns the geocentric J2000 equatorial Sun direction vector in AU.
export function meteorSunDirection(time: Time): Vec3 {
	const sunState = sun(time, 'eclipticJ2000')
	const earthState = earth(time, 'eclipticJ2000')
	return matTransposeMulVec(ECLIPTIC_J2000_MATRIX, [sunState[0][0] - earthState[0][0], sunState[0][1] - earthState[0][1], sunState[0][2] - earthState[0][2]])
}

// Returns the geocentric J2000 equatorial Moon direction vector in AU.
export function meteorMoonDirection(time: Time): Vec3 {
	return moon(time)[0]
}

// Computes the illuminated lunar fraction from geocentric J2000 Sun and Moon vectors.
export function meteorMoonIllumination(sunVector: Vec3, moonVector: Vec3): number {
	const phase = vecAngle([sunVector[0] - moonVector[0], sunVector[1] - moonVector[1], sunVector[2] - moonVector[2]], [-moonVector[0], -moonVector[1], -moonVector[2]])
	return (1 + Math.cos(phase)) * 0.5
}

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

// Computes an exact two-sided Garwood confidence interval for a Poisson count. The interval is
// expressed in counts and uses chi-square quantiles rather than the normal approximation.
export function meteorGarwoodInterval(count: number, confidence: number = 0.95) {
	const alpha = 1 - confidence
	const lower = count === 0 ? 0 : chiSquareQuantile(alpha * 0.5, 2 * count) * 0.5
	const upper = chiSquareQuantile(1 - alpha * 0.5, 2 * (count + 1)) * 0.5
	return { lower, upper } as const
}

// Propagates a Garwood count interval through the linear ZHR scale of one visual observation.
export function meteorGarwoodZhr(observation: MeteorVisualObservation, confidence: number = 0.95) {
	const sine = Math.sin(observation.radiantAltitude)
	const exponent = observation.altitudeExponent ?? 1
	if (!(observation.effectiveTime > 0) || !(sine > 0)) return { lower: 0, upper: 0 }
	const factor = (observation.obstructionCorrection * observation.populationIndex ** (6.5 - observation.limitingMagnitude)) / (observation.effectiveTime * sine ** exponent)
	const interval = meteorGarwoodInterval(observation.count, confidence)
	return { lower: interval.lower * factor, upper: interval.upper * factor } as const
}

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

function radiantVectorOf(radiant: MeteorRadiant): Vec3 {
	const cosDeclination = Math.cos(radiant.declination)
	return [cosDeclination * Math.cos(normalizeAngle(radiant.rightAscension)), cosDeclination * Math.sin(normalizeAngle(radiant.rightAscension)), Math.sin(radiant.declination)]
}
