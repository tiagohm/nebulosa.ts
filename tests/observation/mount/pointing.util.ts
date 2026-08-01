import { eraC2s, eraS2c } from '../../../src/astronomy/coordinates/erfa/erfa'
import { localSiderealTime } from '../../../src/astronomy/observer/location'
import type { Time } from '../../../src/astronomy/time/time'
import { ASEC2RAD, PI } from '../../../src/core/constants'
import { type Vec3, vecDot, vecNormalizeMut, vecRotateByRodrigues } from '../../../src/math/linear-algebra/vec3'
import { sphericalUnprojectTangentPlane } from '../../../src/math/numerical/geometry'
import { predictLinearLeastSquares } from '../../../src/math/numerical/least.squares'
import { clamp, lerp, type NumberArray } from '../../../src/math/numerical/math'
import { gaussian, mulberry32 } from '../../../src/math/numerical/random'
import { type Angle, arcmin, deg, normalizeAngle } from '../../../src/math/units/angle'
import type { PointingSample } from '../../../src/observation/mount/pointing'
// oxfmt-ignore
import { type PointingFeatureConfiguration, type SemiPhysicalTermName, resolveFeatureConfiguration, buildEmpiricalPointingFeatureNames, type PointingModelInput, extractPointingContext, predictSemiPhysicalOffset, SEMI_PHYSICAL_TERM_NAMES, type ResolvedPointingFeatureConfiguration, type PointingOffset, extractEmpiricalPointingFeatures } from '../../../src/observation/mount/pointing.basis'

// Deterministic pointing-sample generators shared by the pointing model and pipeline suites.
//
// Two independent sources are provided on purpose. `generateSyntheticPointingSamples` evaluates the
// model's own basis, which is the right tool for checking that a fit recovers the coefficients it was
// given. `generateMechanicalPointingSamples` composes exact finite rotations instead, so a fit measured
// against it cannot pass by merely being self-consistent. Angles are radians throughout.

// Configuration of a synthetic run built from the model basis itself.
export interface SyntheticPointingOptions {
	readonly count?: number
	readonly seed?: number
	readonly strategy?: 'semiPhysical' | 'empirical' | 'hybrid'
	readonly latitude?: Angle
	readonly longitude?: Angle
	readonly time?: Time
	readonly hourAngleRange?: readonly [Angle, Angle]
	readonly declinationRange?: readonly [Angle, Angle]
	readonly featureConfiguration?: PointingFeatureConfiguration
	readonly empiricalCoefficientsDx?: Readonly<NumberArray>
	readonly empiricalCoefficientsDy?: Readonly<NumberArray>
	readonly semiPhysicalParameters?: Partial<Record<SemiPhysicalTermName, number>>
	readonly noiseStd?: Angle
	readonly outlierFraction?: number
	readonly outlierStd?: Angle
	readonly includeBothPierSides?: boolean
}

// Site and sampling configuration for the independent mechanical simulator.
export interface MechanicalPointingOptions {
	readonly count: number
	readonly seed: number
	readonly time: Time
	readonly latitude: Angle
	readonly longitude: Angle
}

// Default synthetic value of each TPOINT term (radians), used when the caller omits it.
const DEFAULT_SYNTHETIC_TERMS: Readonly<Record<SemiPhysicalTermName, number>> = {
	CH: 1.4 * ASEC2RAD,
	IH: 1.8 * ASEC2RAD,
	ID: -1.1 * ASEC2RAD,
	NP: 0.9 * ASEC2RAD,
	MA: 1.6 * ASEC2RAD,
	ME: -1.2 * ASEC2RAD,
	TF: 1.2 * ASEC2RAD,
}

// Generates deterministic synthetic samples for testing and validation.
export function generateSyntheticPointingSamples(options: SyntheticPointingOptions = {}): readonly PointingSample[] {
	const count = Math.max(0, options.count ?? 64)
	const seed = options.seed ?? 1
	const random = mulberry32(seed >>> 0)
	const featureConfiguration = resolveFeatureConfiguration(options.featureConfiguration)
	const featureNames = buildEmpiricalPointingFeatureNames(featureConfiguration)
	const time = options.time
	const latitude = options.latitude ?? deg(-23)
	const longitude = options.longitude ?? deg(-46)
	const lst = time ? localSiderealTime(time, longitude, true) : 0
	const hourAngleRange = options.hourAngleRange ?? ([-PI * 0.75, PI * 0.75] as const)
	const declinationRange = options.declinationRange ?? ([deg(-25), deg(70)] as const)
	const coefficientsDx = normalizeSyntheticCoefficients(featureNames.length, options.empiricalCoefficientsDx)
	const coefficientsDy = normalizeSyntheticCoefficients(featureNames.length, options.empiricalCoefficientsDy, 0.5)
	const physicalParameters = synthesizePhysicalParameters(options.semiPhysicalParameters)
	const noiseStd = gaussian(random, options.noiseStd ?? arcmin(0.4))
	const outlierFraction = clamp(options.outlierFraction ?? 0, 0, 1)
	const outlierStd = gaussian(random, options.outlierStd ?? deg(0.2))
	const samples = new Array<PointingSample>(count)

	for (let i = 0; i < count; i++) {
		const hourAngle = lerp(hourAngleRange[0], hourAngleRange[1], random())
		const declination = lerp(declinationRange[0], declinationRange[1], random())
		const targetRightAscension = normalizeAngle(lst - hourAngle)
		const targetDeclination = declination
		const pierSide = options.includeBothPierSides ? (i % 2 === 0 ? 'EAST' : 'WEST') : 'NEITHER'
		const input: PointingModelInput = { rightAscension: targetRightAscension, declination: targetDeclination, time, latitude, longitude, pierSide }
		const context = extractPointingContext(input)
		const physical = options.strategy === 'empirical' ? { dx: 0, dy: 0 } : predictSemiPhysicalOffset(physicalParameters, SEMI_PHYSICAL_TERM_NAMES, context)
		const empirical = options.strategy === 'semiPhysical' ? { dx: 0, dy: 0 } : predictSyntheticEmpiricalOffset(coefficientsDx, coefficientsDy, featureConfiguration, input)
		let dx = physical.dx + empirical.dx
		let dy = physical.dy + empirical.dy

		dx += noiseStd()
		dy += noiseStd()

		if (random() < outlierFraction) {
			dx += outlierStd()
			dy += outlierStd()
		}

		const [solvedRightAscension, solvedDeclination] = eraC2s(...sphericalUnprojectTangentPlane(dx, dy, eraS2c(targetRightAscension, targetDeclination)))
		samples[i] = { targetRightAscension, targetDeclination, solvedRightAscension, solvedDeclination, time, latitude, longitude, pierSide }
	}

	return samples
}

// Generates pointing samples whose errors come from `simulateMechanicalDirection`, so the fit is
// validated against real composed geometry instead of against the model's own basis.
export function generateMechanicalPointingSamples(terms: Readonly<Record<SemiPhysicalTermName, Angle>>, options: MechanicalPointingOptions): readonly PointingSample[] {
	const random = mulberry32(options.seed >>> 0)
	const lst = localSiderealTime(options.time, options.longitude, true)
	const samples = new Array<PointingSample>(options.count)

	for (let i = 0; i < options.count; i++) {
		const hourAngle = lerp(-PI * 0.7, PI * 0.7, random())
		const targetDeclination = lerp(deg(-70), deg(70), random())
		const targetRightAscension = normalizeAngle(lst - hourAngle)
		const v = simulateMechanicalDirection(hourAngle, targetDeclination, options.latitude, terms)
		const solvedDeclination = Math.asin(clamp(v[2], -1, 1))
		const solvedRightAscension = normalizeAngle(lst - Math.atan2(-v[1], v[0]))

		samples[i] = { targetRightAscension, targetDeclination, solvedRightAscension, solvedDeclination, time: options.time, latitude: options.latitude, longitude: options.longitude, pierSide: 'NEITHER' }
	}

	return samples
}

// Simulates the sky direction actually reached by a misaligned equatorial mount commanded to
// `(hourAngle, declination)`, by composing exact finite rotations rather than evaluating the fitted
// basis. `terms` are the TPOINT-convention amplitudes in radians and `latitude` is the site geodetic
// latitude in radians. Works in the mount frame with `x` at the meridian on the equator, `y` at the
// east point on the equator, and `z` along the ideal polar axis. Returns a unit vector in that frame.
export function simulateMechanicalDirection(hourAngle: Angle, declination: Angle, latitude: Angle, terms: Readonly<Record<SemiPhysicalTermName, Angle>>) {
	// Collimation tilts the optical axis off the declination axis by a constant cross-axis angle.
	let v = vecRotateByRodrigues([1, 0, 0], [0, 0, 1], -terms.CH)
	// Declination axis rotation, offset by the declination index error.
	v = vecRotateByRodrigues(v, [0, 1, 0], -(declination + terms.ID))
	// Declination axis not perpendicular to the polar axis.
	v = vecRotateByRodrigues(v, [1, 0, 0], terms.NP)
	// Hour angle axis rotation, offset by the hour-angle index error.
	v = vecRotateByRodrigues(v, [0, 0, 1], -(hourAngle + terms.IH))

	// Polar axis misalignment as a single small rotation about `-(MA x + ME y)`.
	const misalignment = Math.hypot(terms.MA, terms.ME)

	if (misalignment > 0) {
		v = vecRotateByRodrigues(v, [-terms.MA, -terms.ME, 0], misalignment)
	}

	// Tube flexure droops the optical axis away from the zenith by `TF * cos(altitude)`.
	const zenith: Vec3 = [Math.cos(latitude), 0, Math.sin(latitude)]
	const sinAltitude = vecDot(zenith, v)

	return vecNormalizeMut([v[0] - terms.TF * (zenith[0] - sinAltitude * v[0]), v[1] - terms.TF * (zenith[1] - sinAltitude * v[1]), v[2] - terms.TF * (zenith[2] - sinAltitude * v[2])])
}

// Builds a coefficient vector positionally aligned with `names` from a sparse name/value dictionary.
export function coefficientsByName(names: readonly string[], values: Record<string, number>) {
	const coefficients = new Float64Array(names.length)

	for (let i = 0; i < names.length; i++) {
		coefficients[i] = values[names[i]] ?? 0
	}

	return coefficients
}

// Extracts the prediction input corresponding to a sample's commanded target.
export function sampleInput(sample: PointingSample) {
	return { rightAscension: sample.targetRightAscension, declination: sample.targetDeclination, time: sample.time, latitude: sample.latitude, longitude: sample.longitude, pierSide: sample.pierSide } as const
}

// Normalizes the synthetic coefficient vector length.
function normalizeSyntheticCoefficients(length: number, coefficients?: Readonly<NumberArray>, scale: number = 1) {
	const output = new Float64Array(length)

	if (coefficients) {
		for (let i = 0; i < Math.min(length, coefficients.length); i++) {
			output[i] = coefficients[i]
		}

		return output
	}

	for (let i = 0; i < length; i++) {
		output[i] = ((i % 3) - 1) * arcmin((0.8 * scale) / Math.max(1, i + 1))
	}

	return output
}

// Normalizes the configured physical-parameter dictionary into `SEMI_PHYSICAL_TERM_NAMES` order.
function synthesizePhysicalParameters(parameters?: Partial<Record<SemiPhysicalTermName, number>>) {
	const values = new Float64Array(SEMI_PHYSICAL_TERM_NAMES.length)

	for (let i = 0; i < SEMI_PHYSICAL_TERM_NAMES.length; i++) {
		const term = SEMI_PHYSICAL_TERM_NAMES[i]
		values[i] = parameters?.[term] ?? DEFAULT_SYNTHETIC_TERMS[term]
	}

	return values
}

// Predicts the synthetic empirical component using raw coefficient vectors.
function predictSyntheticEmpiricalOffset(coefficientsDx: Readonly<NumberArray>, coefficientsDy: Readonly<NumberArray>, configuration: ResolvedPointingFeatureConfiguration, input: PointingModelInput): PointingOffset {
	const features = extractEmpiricalPointingFeatures(input, configuration)

	return {
		dx: predictLinearLeastSquares(coefficientsDx, features.values),
		dy: predictLinearLeastSquares(coefficientsDy, features.values),
	}
}
