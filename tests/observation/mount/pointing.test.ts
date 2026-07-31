import { expect, test } from 'bun:test'
import { equatorialToHorizontal } from '../../../src/astronomy/coordinates/coordinate'
import { localSiderealTime } from '../../../src/astronomy/observer/location'
import { ASEC2RAD, PI } from '../../../src/core/constants'
import { type Vec3, vecDot, vecNormalizeMut, vecRotateByRodrigues } from '../../../src/math/linear-algebra/vec3'
import { clamp, lerp, type NumberArray } from '../../../src/math/numerical/math'
import { type Angle, arcmin, deg, hour, normalizeAngle } from '../../../src/math/units/angle'
// oxfmt-ignore
import { buildEmpiricalPointingFeatureNames, computePointingError, correctPointingCoordinate, extractEmpiricalPointingFeatures, extractPointingContext, type FittedPointingModel, fitPointingModel, MountPointing, type PointingFeatureConfiguration, type PointingModelInput, type PointingModelStrategy, type PointingOffset, type PointingSample, predictPointingModelError, predictSemiPhysicalOffset, type ResolvedPointingFeatureConfiguration, resolveFeatureConfiguration, SEMI_PHYSICAL_TERM_NAMES, selectPointingStrategy, type SemiPhysicalTermName, } from '../../../src/observation/mount/pointing'
import { eraC2s, eraS2c } from '../../../src/astronomy/coordinates/erfa/erfa'
import { type Time, timeYMDHMS } from '../../../src/astronomy/time/time'
import { medianOf } from '../../../src/core/util'
import { sphericalUnprojectTangentPlane } from '../../../src/math/numerical/geometry'
import { predictLinearLeastSquares } from '../../../src/math/numerical/least.squares'
import { gaussian, mulberry32 } from '../../../src/math/numerical/random'

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
	readonly semiPhysicalParameters?: Partial<Record<SemiPhysicalTermName, number>>
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

test('pointing error uses east-positive and north-positive signs', () => {
	const targetRightAscension = hour(4.2)
	const targetDeclination = deg(27)
	const target = eraS2c(targetRightAscension, targetDeclination)
	const [eastRA, eastDEC] = eraC2s(...sphericalUnprojectTangentPlane(arcmin(6), 0, target))
	const [northRA, northDEC] = eraC2s(...sphericalUnprojectTangentPlane(0, arcmin(7), target))
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

test('feature configuration preserves explicitly disabled defaults', () => {
	const configuration = resolveFeatureConfiguration({ includeBias: false, includeAltitudeTerms: false, includeCrossTerms: false, includePierSideTerms: false })
	const names = buildEmpiricalPointingFeatureNames(configuration)

	expect(configuration.includeBias).toBeFalse()
	expect(configuration.includeAltitudeTerms).toBeFalse()
	expect(configuration.includeCrossTerms).toBeFalse()
	expect(configuration.includePierSideTerms).toBeFalse()
	expect(names).not.toContain('bias')
	expect(names).not.toContain('sinAlt')
	expect(names).not.toContain('pierSide')
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

test('an unfitted MountPointing predicts zero error and leaves coordinates unchanged', () => {
	const pointing = new MountPointing()
	const input = { rightAscension: hour(3), declination: deg(15), time: TIME, latitude: LATITUDE, longitude: LONGITUDE, pierSide: 'NEITHER' } as const

	expect(pointing.export()).toBeUndefined()

	const prediction = pointing.predictError(input)
	expect(prediction.dx).toBe(0)
	expect(prediction.dy).toBe(0)

	const corrected = pointing.correctCoordinate(input)
	expect(corrected.rightAscension).toBe(input.rightAscension)
	expect(corrected.declination).toBe(input.declination)
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
	const parameters = { CH: arcmin(0.9), IH: arcmin(1.5), ID: arcmin(-1.2), NP: arcmin(0.7), MA: arcmin(1.1), ME: arcmin(-0.9), TF: arcmin(1.3) } as const
	const samples = generateSyntheticPointingSamples({ count: 160, seed: 41, strategy: 'semiPhysical', time: TIME, latitude: LATITUDE, longitude: LONGITUDE, semiPhysicalParameters: parameters, noiseStd: 0, includeBothPierSides: true })
	const model = fitPointingModel(samples, { strategy: 'semiPhysical', robust: { method: 'none' } })

	for (let i = 0; i < SEMI_PHYSICAL_TERM_NAMES.length; i++) {
		expect(model.physical?.parameters[i]).toBeCloseTo(parameters[SEMI_PHYSICAL_TERM_NAMES[i]], 5)
	}
})

// The semi-physical basis must reproduce a mount whose errors were built by composing real finite
// rotations, not by evaluating the basis itself. Amplitudes stay near 30″ so the first-order basis
// is expected to match the exact geometry to well under 0.1″.
test('semi-physical fit recovers mechanical misalignments from an independent geometric simulator', () => {
	const terms: Readonly<Record<SemiPhysicalTermName, Angle>> = {
		CH: 34 * ASEC2RAD,
		IH: -47 * ASEC2RAD,
		ID: 29 * ASEC2RAD,
		NP: -18 * ASEC2RAD,
		MA: 41 * ASEC2RAD,
		ME: -25 * ASEC2RAD,
		TF: 33 * ASEC2RAD,
	}
	const samples = generateMechanicalPointingSamples(terms, { count: 240, seed: 77, time: TIME, latitude: LATITUDE, longitude: LONGITUDE })
	const model = fitPointingModel(samples, { strategy: 'semiPhysical', robust: { method: 'none' }, ridge: 1e-12, validation: { minimumAltitude: -PI / 2 } })

	for (let i = 0; i < SEMI_PHYSICAL_TERM_NAMES.length; i++) {
		const term = SEMI_PHYSICAL_TERM_NAMES[i]
		expect((model.physical!.parameters[i] - terms[term]) / ASEC2RAD).toBeCloseTo(0, 1)
	}

	expect(model.diagnostics.angularRms / ASEC2RAD).toBeLessThan(0.1)
})

test('hybrid fit improves on physical-only and works across both pier sides', () => {
	const featureNames = buildEmpiricalPointingFeatureNames(FEATURE_CONFIGURATION)
	const dx = coefficientsByName(featureNames, { bias: arcmin(0.8), sinHA: arcmin(-0.9), pierSide: arcmin(1.1) })
	const dy = coefficientsByName(featureNames, { bias: arcmin(-0.6), cosHA: arcmin(1.2), sinDec: arcmin(0.5), pierSide: arcmin(-0.7) })
	const parameters = { IH: arcmin(1.2), ID: arcmin(-1.1), MA: arcmin(0.9), ME: arcmin(-0.8), TF: arcmin(1.4) } as const
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

test('hybrid orthogonalization keeps the fitted physical parameters meaningful', () => {
	const terms: Readonly<Record<SemiPhysicalTermName, Angle>> = {
		CH: 22 * ASEC2RAD,
		IH: -63 * ASEC2RAD,
		ID: 45 * ASEC2RAD,
		NP: -12 * ASEC2RAD,
		MA: 58 * ASEC2RAD,
		ME: -31 * ASEC2RAD,
		TF: 27 * ASEC2RAD,
	}
	const samples = generateMechanicalPointingSamples(terms, { count: 240, seed: 91, time: TIME, latitude: LATITUDE, longitude: LONGITUDE })
	const model = fitPointingModel(samples, { strategy: 'hybrid', featureConfiguration: FEATURE_CONFIGURATION, robust: { method: 'none' }, ridge: 1e-12, validation: { minimumAltitude: -PI / 2 } })

	// Without orthogonalization the empirical block would soak up `bias` against `CH` and `sinHA`
	// against `MA`, leaving good predictions on top of physically meaningless parameters.
	for (let i = 0; i < SEMI_PHYSICAL_TERM_NAMES.length; i++) {
		expect((model.physical!.parameters[i] - terms[SEMI_PHYSICAL_TERM_NAMES[i]]) / ASEC2RAD).toBeCloseTo(0, 0)
	}

	expect(model.usable).toBeTrue()
	expect(model.residual?.orthogonalizationDx).toBeDefined()
	expect(model.diagnostics.angularRms / ASEC2RAD).toBeLessThan(1)

	// The stored projection must reproduce the fitted design exactly through serialization.
	const pointing = new MountPointing()
	pointing.import(model)
	const direct = predictPointingModelError(model, sampleInput(samples[3]))
	const roundtrip = pointing.predictError(sampleInput(samples[3]))

	expect(roundtrip.dx).toBeCloseTo(direct.dx, 12)
	expect(roundtrip.dy).toBeCloseTo(direct.dy, 12)
})

test('missing observing context drops the terms that need it instead of zeroing them', () => {
	const terms: Readonly<Record<SemiPhysicalTermName, Angle>> = { CH: 30 * ASEC2RAD, IH: -40 * ASEC2RAD, ID: 20 * ASEC2RAD, NP: -15 * ASEC2RAD, MA: 0, ME: 0, TF: 0 }
	const full = generateMechanicalPointingSamples(terms, { count: 120, seed: 13, time: TIME, latitude: LATITUDE, longitude: LONGITUDE })
	const contextless = full.map((sample) => ({ targetRightAscension: sample.targetRightAscension, targetDeclination: sample.targetDeclination, solvedRightAscension: sample.solvedRightAscension, solvedDeclination: sample.solvedDeclination }))
	const model = fitPointingModel(contextless, { strategy: 'semiPhysical', robust: { method: 'none' }, ridge: 1e-12, validation: { minimumAltitude: -PI / 2 } })

	expect(model.diagnostics.supportedContext).toBe('none')
	expect(model.physical!.terms).toEqual(['CH', 'IH', 'ID', 'NP'])
	expect(model.diagnostics.droppedTerms).toContain('MA: requires hourAngle context')
	expect(model.diagnostics.droppedTerms).toContain('TF: requires horizon context')
	expect(model.usable).toBeTrue()

	// The surviving terms only depend on declination, so they are still recovered exactly.
	for (let i = 0; i < model.physical!.terms.length; i++) {
		expect((model.physical!.parameters[i] - terms[model.physical!.terms[i]]) / ASEC2RAD).toBeCloseTo(0, 1)
	}
})

test('ridge shrinkage is invariant to the number of samples', () => {
	const featureNames = buildEmpiricalPointingFeatureNames(FEATURE_CONFIGURATION)
	const dx = coefficientsByName(featureNames, { bias: arcmin(2.5), sinHA: arcmin(-1.4), pierSide: arcmin(1.2) })
	const dy = coefficientsByName(featureNames, { bias: arcmin(-1.1), cosHA: arcmin(1.7), pierSide: arcmin(-0.9) })
	const options = { strategy: 'empirical', seed: 23, time: TIME, latitude: LATITUDE, longitude: LONGITUDE, featureConfiguration: FEATURE_CONFIGURATION, empiricalCoefficientsDx: dx, empiricalCoefficientsDy: dy, noiseStd: 0, includeBothPierSides: true } as const
	const small = generateSyntheticPointingSamples({ ...options, count: 40 })
	// Repeating the very same samples multiplies both the normal matrix and the right-hand side by the
	// repetition count, so a scale-invariant ridge must return the identical fit. A negative duplicate
	// tolerance keeps the validator from rejecting the repeats.
	const large = [...small, ...small, ...small, ...small, ...small]
	const fitOptions = { strategy: 'empirical', featureConfiguration: FEATURE_CONFIGURATION, robust: { method: 'none' }, ridge: 0.05, validation: { duplicateTolerance: -1, minimumAltitude: -PI / 2 } } as const
	const smallFit = fitPointingModel(small, fitOptions)
	const largeFit = fitPointingModel(large, fitOptions)

	expect(largeFit.trainingSampleCount).toBe(smallFit.trainingSampleCount * 5)

	// An absolute ridge would shrink the 40-sample fit five times harder than the 200-sample one.
	for (let i = 0; i < featureNames.length; i++) {
		expect(smallFit.empirical!.coefficientsDx[i] / arcmin(1)).toBeCloseTo(largeFit.empirical!.coefficientsDx[i] / arcmin(1), 8)
		expect(smallFit.empirical!.coefficientsDy[i] / arcmin(1)).toBeCloseTo(largeFit.empirical!.coefficientsDy[i] / arcmin(1), 8)
	}
})

test('underdetermined fits drop terms, are flagged unusable and predict nothing', () => {
	const featureNames = buildEmpiricalPointingFeatureNames(FEATURE_CONFIGURATION)
	const dx = coefficientsByName(featureNames, { bias: arcmin(2), sinHA: arcmin(-1) })
	const dy = coefficientsByName(featureNames, { bias: arcmin(-1), cosHA: arcmin(0.8) })
	const samples = generateSyntheticPointingSamples({ count: 4, seed: 61, strategy: 'empirical', time: TIME, latitude: LATITUDE, longitude: LONGITUDE, featureConfiguration: FEATURE_CONFIGURATION, empiricalCoefficientsDx: dx, empiricalCoefficientsDy: dy, includeBothPierSides: false })
	const model = fitPointingModel(samples, { strategy: 'empirical', featureConfiguration: FEATURE_CONFIGURATION, validation: { minimumSamples: 12 } })

	expect(model.diagnostics.warnings.some((warning) => warning.includes('too few samples'))).toBeTrue()
	expect(model.diagnostics.droppedTerms.length).toBeGreaterThan(0)
	expect(model.diagnostics.droppedTerms.some((term) => term.includes('too few samples'))).toBeTrue()
	expect(model.usable).toBeFalse()

	// An unusable model must not move the mount: the prediction is exactly zero and says why.
	const prediction = predictPointingModelError(model, sampleInput(samples[0]))
	expect(prediction.dx).toBe(0)
	expect(prediction.dy).toBe(0)
	expect(prediction.quality.warnings).toContain('the fitted model is not usable for prediction')
})

test('a declared uncertainty downweights a corrupted sample', () => {
	const featureNames = buildEmpiricalPointingFeatureNames(FEATURE_CONFIGURATION)
	const dx = coefficientsByName(featureNames, { bias: arcmin(2.5), sinHA: arcmin(-1.4), cosHA: arcmin(0.8), pierSide: arcmin(1.2) })
	const dy = coefficientsByName(featureNames, { bias: arcmin(-1.1), cosHA: arcmin(1.7), sinDec: arcmin(0.6), pierSide: arcmin(-0.9) })
	const clean = generateSyntheticPointingSamples({ count: 80, seed: 71, strategy: 'empirical', time: TIME, latitude: LATITUDE, longitude: LONGITUDE, featureConfiguration: FEATURE_CONFIGURATION, empiricalCoefficientsDx: dx, empiricalCoefficientsDy: dy, noiseStd: 0, includeBothPierSides: true })
	// One sample is off by a quarter of a degree, far beyond the plate-solve accuracy of the others.
	const corrupted = clean.map((sample, index) => (index === 7 ? displacePointingSample(sample, deg(0.25), deg(-0.2)) : sample))
	const annotated = corrupted.map((sample, index) => ({ ...sample, uncertainty: index === 7 ? deg(0.3) : arcsecUncertainty }))
	const fitOptions = { strategy: 'empirical', featureConfiguration: FEATURE_CONFIGURATION, robust: { method: 'none' }, validation: { minimumAltitude: -PI / 2 } } as const
	const blind = fitPointingModel(corrupted, fitOptions)
	const weighted = fitPointingModel(annotated, fitOptions)

	// Inverse-variance weighting must pull the coefficients back toward the noiseless truth.
	expect(coefficientError(weighted, dx, dy)).toBeLessThan(coefficientError(blind, dx, dy) / 10)
})

test('prediction support decays away from the training set and follows the sphere across the RA wrap', () => {
	// A compact cap of samples: everything more than a few degrees away is an extrapolation.
	const samples = generateSyntheticPointingSamples({ count: 60, seed: 73, strategy: 'empirical', time: TIME, latitude: LATITUDE, longitude: LONGITUDE, featureConfiguration: FEATURE_CONFIGURATION, hourAngleRange: [deg(-4), deg(4)], declinationRange: [deg(16), deg(24)], noiseStd: 0 })
	const model = fitPointingModel(samples, { strategy: 'empirical', featureConfiguration: FEATURE_CONFIGURATION, validation: { minimumSamples: 12 } })
	const inside = predictPointingModelError(model, sampleInput(samples[9])).quality
	const outside = predictPointingModelError(model, { ...sampleInput(samples[9]), declination: deg(-60) }).quality

	expect(inside.support).toBeGreaterThan(0.9)
	expect(inside.extrapolating).toBeFalse()
	expect(outside.support).toBeLessThan(0.01)
	expect(outside.extrapolating).toBeTrue()
	expect(outside.warnings).toContain('prediction is far from the sampled sky region')

	// Support is measured between unit vectors, so a right ascension expressed one turn away describes
	// the same direction. A distance taken on the raw angles would instead report a full circle.
	const wrapped = predictPointingModelError(model, { ...sampleInput(samples[9]), rightAscension: samples[9].targetRightAscension + 2 * PI }).quality
	expect(wrapped.kthNeighborDistance).toBeCloseTo(inside.kthNeighborDistance, 12)
	expect(wrapped.support).toBeCloseTo(inside.support, 12)
})

test('leave-one-out residuals expose the overfitting that the in-sample rms hides', () => {
	const featureNames = buildEmpiricalPointingFeatureNames(FEATURE_CONFIGURATION)
	const dx = coefficientsByName(featureNames, { bias: arcmin(1.6), sinHA: arcmin(-0.9) })
	const dy = coefficientsByName(featureNames, { bias: arcmin(-0.7), cosHA: arcmin(1.1) })
	const options = { count: 44, seed: 79, strategy: 'empirical', time: TIME, latitude: LATITUDE, longitude: LONGITUDE, featureConfiguration: FEATURE_CONFIGURATION, empiricalCoefficientsDx: dx, empiricalCoefficientsDy: dy, noiseStd: arcmin(0.5), includeBothPierSides: true } as const
	const samples = generateSyntheticPointingSamples(options)
	const fitOptions = { strategy: 'empirical', robust: { method: 'none' }, validation: { minimumAltitude: -PI / 2 } } as const
	const modest = fitPointingModel(samples, { ...fitOptions, featureConfiguration: FEATURE_CONFIGURATION })
	const rich = fitPointingModel(samples, { ...fitOptions, featureConfiguration: { ...FEATURE_CONFIGURATION, includeAltitudeTerms: true, includeCrossTerms: true, includePolynomialTerms: true } })

	expect(modest.diagnostics.looRms).toBeDefined()
	// Holding a sample out can only make its residual worse, never better.
	expect(modest.diagnostics.looRms!).toBeGreaterThan(modest.diagnostics.angularRms)
	expect(modest.diagnostics.looResidualPercentiles!.p50).toBeLessThan(modest.diagnostics.looResidualPercentiles!.p95)

	// The richer basis fits the noise better in sample and generalizes worse out of sample.
	expect(rich.diagnostics.angularRms).toBeLessThan(modest.diagnostics.angularRms)
	expect(rich.diagnostics.looRms!).toBeGreaterThan(modest.diagnostics.looRms!)
})

test('strategy selection returns the candidate with the best leave-one-out error', () => {
	const terms: Readonly<Record<SemiPhysicalTermName, Angle>> = { CH: 25 * ASEC2RAD, IH: -40 * ASEC2RAD, ID: 33 * ASEC2RAD, NP: -14 * ASEC2RAD, MA: 47 * ASEC2RAD, ME: -22 * ASEC2RAD, TF: 30 * ASEC2RAD }
	const samples = generateMechanicalPointingSamples(terms, { count: 90, seed: 83, time: TIME, latitude: LATITUDE, longitude: LONGITUDE })
	const options = { featureConfiguration: FEATURE_CONFIGURATION, robust: { method: 'none' }, validation: { minimumAltitude: -PI / 2 } } as const
	const selected = selectPointingStrategy(samples, options)
	const candidates: readonly PointingModelStrategy[] = ['semiPhysical', 'hybrid', 'empirical']

	expect(selected.usable).toBeTrue()

	for (const strategy of candidates) {
		const candidate = fitPointingModel(samples, { ...options, strategy })
		expect(selected.diagnostics.looRms!).toBeLessThanOrEqual(candidate.diagnostics.looRms!)
	}

	// A purely empirical mount has nothing for the mechanical basis to explain, so the physical-only
	// model must lose to the one that can actually describe the data.
	const featureNames = buildEmpiricalPointingFeatureNames(FEATURE_CONFIGURATION)
	const dx = coefficientsByName(featureNames, { bias: arcmin(1.9), cosDec: arcmin(-1.3) })
	const dy = coefficientsByName(featureNames, { bias: arcmin(-1.4), sinDec: arcmin(1.1) })
	const empiricalSamples = generateSyntheticPointingSamples({ count: 90, seed: 87, strategy: 'empirical', time: TIME, latitude: LATITUDE, longitude: LONGITUDE, featureConfiguration: FEATURE_CONFIGURATION, empiricalCoefficientsDx: dx, empiricalCoefficientsDy: dy, noiseStd: 0 })
	const empiricalChoice = selectPointingStrategy(empiricalSamples, options)

	expect(empiricalChoice.strategy).not.toBe('semiPhysical')
	expect(empiricalChoice.diagnostics.looRms!).toBeLessThan(fitPointingModel(empiricalSamples, { ...options, strategy: 'semiPhysical' }).diagnostics.looRms!)
})

// Plate-solve grade uncertainty (radians) attached to the trustworthy samples.
const arcsecUncertainty = 2 * ASEC2RAD

// Moves the solved position of `sample` by a tangent-plane offset, keeping everything else intact.
function displacePointingSample(sample: PointingSample, dx: Angle, dy: Angle): PointingSample {
	const [solvedRightAscension, solvedDeclination] = eraC2s(...sphericalUnprojectTangentPlane(dx, dy, eraS2c(sample.solvedRightAscension, sample.solvedDeclination)))
	return { ...sample, solvedRightAscension, solvedDeclination }
}

// Root-mean-square distance between the fitted empirical coefficients and the synthetic truth.
function coefficientError(model: FittedPointingModel, dx: Readonly<NumberArray>, dy: Readonly<NumberArray>) {
	const fitted = model.empirical!
	let sum = 0

	for (let i = 0; i < dx.length; i++) {
		sum += (fitted.coefficientsDx[i] - dx[i]) ** 2 + (fitted.coefficientsDy[i] - dy[i]) ** 2
	}

	return Math.sqrt(sum / (2 * dx.length))
}

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

// Site and sampling configuration for the independent mechanical simulator.
interface MechanicalPointingOptions {
	readonly count: number
	readonly seed: number
	readonly time: Time
	readonly latitude: Angle
	readonly longitude: Angle
}

// Simulates the sky direction actually reached by a misaligned equatorial mount commanded to
// `(hourAngle, declination)`, by composing exact finite rotations rather than evaluating the fitted
// basis. `terms` are the TPOINT-convention amplitudes in radians and `latitude` is the site geodetic
// latitude in radians. Works in the mount frame with `x` at the meridian on the equator, `y` at the
// east point on the equator, and `z` along the ideal polar axis. Returns a unit vector in that frame.
function simulateMechanicalDirection(hourAngle: Angle, declination: Angle, latitude: Angle, terms: Readonly<Record<SemiPhysicalTermName, Angle>>) {
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

// Generates pointing samples whose errors come from `simulateMechanicalDirection`, so the fit is
// validated against real composed geometry instead of against the model's own basis.
function generateMechanicalPointingSamples(terms: Readonly<Record<SemiPhysicalTermName, Angle>>, options: MechanicalPointingOptions): readonly PointingSample[] {
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
