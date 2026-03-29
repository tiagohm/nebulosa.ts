import { expect, test } from 'bun:test'
import { type Angle, arcmin, deg, hour, normalizeAngle } from '../src/angle'
import { ASEC2RAD } from '../src/constants'
import { equatorialToHorizontal } from '../src/coordinate'
import { localSiderealTime } from '../src/location'
import { clamp, lerp, type NumberArray } from '../src/math'
import {
	buildEmpiricalPointingFeatureNames,
	computePointingError,
	correctPointingCoordinate,
	extractEmpiricalPointingFeatures,
	extractPointingContext,
	type FittedPointingModel,
	fitPointingModel,
	MountPointing,
	type PointingFeatureConfiguration,
	type PointingModelInput,
	type PointingModelStrategy,
	type PointingOffset,
	type PointingSample,
	pointingTangentBasis,
	predictPointingModelError,
	predictSemiPhysicalOffset,
	projectTangentPlane,
	type ResolvedPointingFeatureConfiguration,
	resolveFeatureConfiguration,
	SEMI_PHYSICAL_PARAMETER_NAMES,
	type SemiPhysicalParameterName,
	unprojectTangentPlane,
} from '../src/mount.pointing'
import { gaussian, mulberry32 } from '../src/random'
import { predictLinearLeastSquares } from '../src/regression'
import { type Time, timeYMDHMS } from '../src/time'
import { medianOf } from '../src/util'
import { vecDot } from '../src/vec3'

interface SyntheticPointingOptions {
	readonly count?: number
	readonly seed?: number
	readonly strategy?: PointingModelStrategy
	readonly latitude?: Angle
	readonly longitude?: Angle
	readonly time?: Time
	readonly hourAngleRange?: readonly [Angle, Angle]
	readonly declinationRange?: readonly [Angle, Angle]
	readonly featureConfiguration?: PointingFeatureConfiguration
	readonly empiricalCoefficientsDx?: Readonly<NumberArray>
	readonly empiricalCoefficientsDy?: Readonly<NumberArray>
	readonly semiPhysicalParameters?: Partial<Record<SemiPhysicalParameterName, number>>
	readonly noiseStd?: Angle
	readonly outlierFraction?: number
	readonly outlierStd?: Angle
	readonly includeBothPierSides?: boolean
}

const TIME = timeYMDHMS(2026, 1, 5, 3, 0, 0)
const LATITUDE = deg(-23)
const LONGITUDE = deg(-46)

const FEATURE_CONFIGURATION = {
	includeBias: true,
	includeHourAngleTerms: true,
	includeDeclinationTerms: true,
	includeAltitudeTerms: false,
	includeCrossTerms: false,
	includePierSideTerms: true,
	includePolynomialTerms: false,
} as const satisfies PointingFeatureConfiguration

test('tangent basis is orthogonal', () => {
	const basis = pointingTangentBasis(hour(5.1), deg(41.3))

	expect(vecDot(basis.origin, basis.east)).toBeCloseTo(0, 12)
	expect(vecDot(basis.origin, basis.north)).toBeCloseTo(0, 12)
	expect(vecDot(basis.east, basis.north)).toBeCloseTo(0, 12)
	expect(vecDot(basis.origin, basis.origin)).toBeCloseTo(1, 12)
})

test('tangent plane remains stable across RA wrap and near the pole', () => {
	const [wrappedRa, wrappedDec] = unprojectTangentPlane(arcmin(8), arcmin(-5), normalizeAngle(deg(359.95)), deg(12))
	const wrappedProjection = projectTangentPlane(wrappedRa, wrappedDec, normalizeAngle(deg(359.95)), deg(12))
	const [poleRa, poleDec] = unprojectTangentPlane(arcmin(4), arcmin(3), hour(2.1), deg(89.2))
	const poleProjection = projectTangentPlane(poleRa, poleDec, hour(2.1), deg(89.2))

	expect(wrappedProjection).not.toBeFalse()
	expect(poleProjection).not.toBeFalse()
	expect(wrappedProjection !== false && wrappedProjection.dx).toBeCloseTo(arcmin(8), 8)
	expect(wrappedProjection !== false && wrappedProjection.dy).toBeCloseTo(arcmin(-5), 8)
	expect(poleProjection !== false && poleProjection.dx).toBeCloseTo(arcmin(4), 8)
	expect(poleProjection !== false && poleProjection.dy).toBeCloseTo(arcmin(3), 8)
})

test('pointing error uses east-positive and north-positive signs', () => {
	const targetRightAscension = hour(4.2)
	const targetDeclination = deg(27)
	const [eastRA, eastDEC] = unprojectTangentPlane(arcmin(6), 0, targetRightAscension, targetDeclination)
	const [northRA, northDEC] = unprojectTangentPlane(0, arcmin(7), targetRightAscension, targetDeclination)
	const eastError = computePointingError(targetRightAscension, targetDeclination, eastRA, eastDEC)
	const northError = computePointingError(targetRightAscension, targetDeclination, northRA, northDEC)

	expect(eastError.dx).toBeCloseTo(arcmin(6), 8)
	expect(eastError.dy).toBeCloseTo(0, 8)
	expect(northError.dx).toBeCloseTo(0, 8)
	expect(northError.dy).toBeCloseTo(arcmin(7), 8)
})

test('feature extraction computes HA altitude and pier side', () => {
	const lst = localSiderealTime(TIME, LONGITUDE, true)
	const ra = normalizeAngle(lst - hour(2))
	const dec = deg(18)
	const features = extractEmpiricalPointingFeatures({ rightAscension: ra, declination: dec, time: TIME, latitude: LATITUDE, longitude: LONGITUDE, pierSide: 'WEST' }, FEATURE_CONFIGURATION)
	const pierSideIndex = features.names.indexOf('pierSide')
	const [_, altitude] = equatorialToHorizontal(ra, dec, LATITUDE, lst)

	expect(features.context.hourAngle).toBeCloseTo(hour(2), 12)
	expect(features.context.altitude).toBeCloseTo(altitude, 12)
	expect(features.values[pierSideIndex]).toBe(-1)
})

test('feature extraction degrades gracefully without observing context', () => {
	const features = extractEmpiricalPointingFeatures({ rightAscension: hour(1), declination: deg(20) }, FEATURE_CONFIGURATION)

	expect(features.context.hourAngle).toBeUndefined()
	expect(features.context.altitude).toBeUndefined()
	expect(Array.from(features.values).every(Number.isFinite)).toBeTrue()
})

test('empirical fit recovers synthetic coefficients and serialization preserves predictions', () => {
	const featureNames = buildEmpiricalPointingFeatureNames(FEATURE_CONFIGURATION)
	const dx = coefficientsByName(featureNames, { bias: arcmin(2.5), sinHA: arcmin(-1.4), cosHA: arcmin(0.8), sinDec: arcmin(0.6), pierSide: arcmin(1.2) })
	const dy = coefficientsByName(featureNames, { bias: arcmin(-1.1), sinHA: arcmin(0.5), cosHA: arcmin(1.7), cosDec: arcmin(-0.4), pierSide: arcmin(-0.9) })
	const samples = generateSyntheticPointingSamples({ count: 128, seed: 11, strategy: 'empirical', time: TIME, latitude: LATITUDE, longitude: LONGITUDE, featureConfiguration: FEATURE_CONFIGURATION, empiricalCoefficientsDx: dx, empiricalCoefficientsDy: dy, noiseStd: 0, includeBothPierSides: true })
	const model = fitPointingModel(samples, { strategy: 'empirical', featureConfiguration: FEATURE_CONFIGURATION, robust: { method: 'none' } })
	const pointing = new MountPointing()

	for (let i = 0; i < samples.length; i++) {
		pointing.add(samples[i])
	}

	const imported = pointing.import(model)
	const prediction = predictPointingModelError(imported, sampleInput(samples[5]))
	const roundtripPrediction = pointing.predictError(sampleInput(samples[5]))

	expect(model.empirical?.coefficientsDx[0]).toBeCloseTo(dx[0], 6)
	expect(model.empirical?.coefficientsDx[1]).toBeCloseTo(dx[1], 6)
	expect(model.empirical?.coefficientsDy[2]).toBeCloseTo(dy[2], 6)
	expect(prediction.dx).toBeCloseTo(roundtripPrediction.dx, 12)
	expect(prediction.dy).toBeCloseTo(roundtripPrediction.dy, 12)
})

test('robust empirical fit outperforms plain least squares on outlier-contaminated data', () => {
	const featureNames = buildEmpiricalPointingFeatureNames(FEATURE_CONFIGURATION)
	const dx = coefficientsByName(featureNames, { bias: arcmin(2), sinHA: arcmin(-1.2), cosHA: arcmin(0.7), pierSide: arcmin(0.9) })
	const dy = coefficientsByName(featureNames, { bias: arcmin(-0.8), cosHA: arcmin(1.4), sinDec: arcmin(0.6) })
	const training = generateSyntheticPointingSamples({
		count: 96,
		seed: 23,
		strategy: 'empirical',
		time: TIME,
		latitude: LATITUDE,
		longitude: LONGITUDE,
		featureConfiguration: FEATURE_CONFIGURATION,
		empiricalCoefficientsDx: dx,
		empiricalCoefficientsDy: dy,
		outlierFraction: 0.18,
		outlierStd: deg(0.25),
		includeBothPierSides: true,
	})
	const validation = generateSyntheticPointingSamples({ count: 64, seed: 24, strategy: 'empirical', time: TIME, latitude: LATITUDE, longitude: LONGITUDE, featureConfiguration: FEATURE_CONFIGURATION, empiricalCoefficientsDx: dx, empiricalCoefficientsDy: dy, noiseStd: 0, includeBothPierSides: true })
	const plain = fitPointingModel(training, { strategy: 'empirical', featureConfiguration: FEATURE_CONFIGURATION, robust: { method: 'none' } })
	const robust = fitPointingModel(training, { strategy: 'empirical', featureConfiguration: FEATURE_CONFIGURATION, robust: { method: 'huber' } })

	expect(medianPredictionResidual(robust, validation)).toBeLessThan(medianPredictionResidual(plain, validation))
})

test('semi-physical fit recovers shared parameters', () => {
	const parameters = { IH: arcmin(1.5), ID: arcmin(-1.2), MA: arcmin(1.1), ME: arcmin(-0.9), NPAE: arcmin(0.7), CONE: arcmin(0.4), FLEXURE: arcmin(1.3) } as const
	const samples = generateSyntheticPointingSamples({ count: 160, seed: 41, strategy: 'semiPhysical', time: TIME, latitude: LATITUDE, longitude: LONGITUDE, semiPhysicalParameters: parameters, noiseStd: 0, includeBothPierSides: true })
	const model = fitPointingModel(samples, { strategy: 'semiPhysical', robust: { method: 'none' } })

	expect(model.physical?.parameters[0]).toBeCloseTo(parameters.IH, 5)
	expect(model.physical?.parameters[1]).toBeCloseTo(parameters.ID, 5)
	expect(model.physical?.parameters[2]).toBeCloseTo(parameters.MA, 5)
	expect(model.physical?.parameters[3]).toBeCloseTo(parameters.ME, 5)
	expect(model.physical?.parameters[6]).toBeCloseTo(parameters.FLEXURE, 5)
})

test('hybrid fit improves on physical-only and works across both pier sides', () => {
	const featureNames = buildEmpiricalPointingFeatureNames(FEATURE_CONFIGURATION)
	const dx = coefficientsByName(featureNames, { bias: arcmin(0.8), sinHA: arcmin(-0.9), pierSide: arcmin(1.1) })
	const dy = coefficientsByName(featureNames, { bias: arcmin(-0.6), cosHA: arcmin(1.2), sinDec: arcmin(0.5), pierSide: arcmin(-0.7) })
	const parameters = { IH: arcmin(1.2), ID: arcmin(-1.1), MA: arcmin(0.9), ME: arcmin(-0.8), FLEXURE: arcmin(1.4) } as const
	const training = generateSyntheticPointingSamples({
		count: 144,
		seed: 51,
		strategy: 'hybrid',
		time: TIME,
		latitude: LATITUDE,
		longitude: LONGITUDE,
		featureConfiguration: FEATURE_CONFIGURATION,
		empiricalCoefficientsDx: dx,
		empiricalCoefficientsDy: dy,
		semiPhysicalParameters: parameters,
		includeBothPierSides: true,
	})
	const validation = generateSyntheticPointingSamples({
		count: 80,
		seed: 52,
		strategy: 'hybrid',
		time: TIME,
		latitude: LATITUDE,
		longitude: LONGITUDE,
		featureConfiguration: FEATURE_CONFIGURATION,
		empiricalCoefficientsDx: dx,
		empiricalCoefficientsDy: dy,
		semiPhysicalParameters: parameters,
		includeBothPierSides: true,
		noiseStd: 0,
	})
	const physical = fitPointingModel(training, { strategy: 'semiPhysical', featureConfiguration: FEATURE_CONFIGURATION })
	const hybrid = fitPointingModel(training, { strategy: 'hybrid', featureConfiguration: FEATURE_CONFIGURATION })
	const prediction = predictPointingModelError(hybrid, sampleInput(validation[0]))
	const corrected = correctPointingCoordinate(hybrid, sampleInput(validation[0]))
	const correction = computePointingError(sampleInput(validation[0]).rightAscension, sampleInput(validation[0]).declination, corrected.rightAscension, corrected.declination)
	const targetError = computePointingError(validation[0].targetRightAscension, validation[0].targetDeclination, validation[0].solvedRightAscension, validation[0].solvedDeclination)

	expect(medianPredictionResidual(hybrid, validation)).toBeLessThan(medianPredictionResidual(physical, validation))
	expect(hybrid.diagnostics.perPierSideSampleCounts.EAST).toBeGreaterThan(0)
	expect(hybrid.diagnostics.perPierSideSampleCounts.WEST).toBeGreaterThan(0)
	expect(prediction.dx).toBeCloseTo((prediction.components.physical?.dx ?? 0) + (prediction.components.residual?.dx ?? 0), 10)
	expect(prediction.dy).toBeCloseTo((prediction.components.physical?.dy ?? 0) + (prediction.components.residual?.dy ?? 0), 10)
	expect(correction.dx).toBeCloseTo(-prediction.dx, 8)
	expect(correction.dy).toBeCloseTo(-prediction.dy, 8)
	expect(Math.hypot(targetError.dx - prediction.dx, targetError.dy - prediction.dy)).toBeLessThan(targetError.angularSeparation)
})

test('underdetermined fits produce diagnostics warnings', () => {
	const featureNames = buildEmpiricalPointingFeatureNames(FEATURE_CONFIGURATION)
	const dx = coefficientsByName(featureNames, { bias: arcmin(2), sinHA: arcmin(-1) })
	const dy = coefficientsByName(featureNames, { bias: arcmin(-1), cosHA: arcmin(0.8) })
	const samples = generateSyntheticPointingSamples({ count: 4, seed: 61, strategy: 'empirical', time: TIME, latitude: LATITUDE, longitude: LONGITUDE, featureConfiguration: FEATURE_CONFIGURATION, empiricalCoefficientsDx: dx, empiricalCoefficientsDy: dy, includeBothPierSides: false })
	const model = fitPointingModel(samples, { strategy: 'empirical', featureConfiguration: FEATURE_CONFIGURATION, validation: { minimumSamples: 12 } })

	expect(model.diagnostics.warnings.some((warning) => warning.includes('too few samples'))).toBeTrue()
	expect(model.diagnostics.warnings.some((warning) => warning.includes('underdetermined'))).toBeTrue()
})

function coefficientsByName(names: readonly string[], values: Record<string, number>) {
	const coefficients = new Float64Array(names.length)

	for (let i = 0; i < names.length; i++) {
		coefficients[i] = values[names[i]] ?? 0
	}

	return coefficients
}

function sampleInput(sample: PointingSample) {
	return { rightAscension: sample.targetRightAscension, declination: sample.targetDeclination, time: sample.time, latitude: sample.latitude, longitude: sample.longitude, pierSide: sample.pierSide } as const
}

function medianPredictionResidual(model: FittedPointingModel, samples: readonly PointingSample[]) {
	const residuals = new Float64Array(samples.length)

	for (let i = 0; i < samples.length; i++) {
		const actual = computePointingError(samples[i].targetRightAscension, samples[i].targetDeclination, samples[i].solvedRightAscension, samples[i].solvedDeclination)
		const predicted = predictPointingModelError(model, sampleInput(samples[i]))
		residuals[i] = Math.hypot(actual.dx - predicted.dx, actual.dy - predicted.dy)
	}

	return medianOf(residuals.sort())
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
	const hourAngleRange = options.hourAngleRange ?? ([-Math.PI * 0.75, Math.PI * 0.75] as const)
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
		const physical = options.strategy === 'empirical' ? { dx: 0, dy: 0 } : predictSemiPhysicalOffset(physicalParameters, context)
		const empirical = options.strategy === 'semiPhysical' ? { dx: 0, dy: 0 } : predictSyntheticEmpiricalOffset(coefficientsDx, coefficientsDy, featureConfiguration, input)
		let dx = physical.dx + empirical.dx
		let dy = physical.dy + empirical.dy

		dx += noiseStd()
		dy += noiseStd()

		if (random() < outlierFraction) {
			dx += outlierStd()
			dy += outlierStd()
		}

		const [solvedRightAscension, solvedDeclination] = unprojectTangentPlane(dx, dy, targetRightAscension, targetDeclination)
		samples[i] = { targetRightAscension, targetDeclination, solvedRightAscension, solvedDeclination, time, latitude, longitude, pierSide }
	}

	return samples
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

// Normalizes the configured physical-parameter dictionary.
function synthesizePhysicalParameters(parameters?: Partial<Record<SemiPhysicalParameterName, number>>) {
	const values = new Float64Array(SEMI_PHYSICAL_PARAMETER_NAMES.length)

	values[0] = parameters?.IH ?? 1.8 * ASEC2RAD
	values[1] = parameters?.ID ?? -1.1 * ASEC2RAD
	values[2] = parameters?.MA ?? 1.6 * ASEC2RAD
	values[3] = parameters?.ME ?? -1.2 * ASEC2RAD
	values[4] = parameters?.NPAE ?? 0.9 * ASEC2RAD
	values[5] = parameters?.CONE ?? 0.7 * ASEC2RAD
	values[6] = parameters?.FLEXURE ?? 1.2 * ASEC2RAD

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
