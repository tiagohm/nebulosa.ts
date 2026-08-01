import { expect, test } from 'bun:test'
import { equatorialToHorizontal } from '../../../src/astronomy/coordinates/coordinate'
import { eraC2s, eraS2c } from '../../../src/astronomy/coordinates/erfa/erfa'
import { localSiderealTime } from '../../../src/astronomy/observer/location'
import { timeYMDHMS } from '../../../src/astronomy/time/time'
import { ASEC2RAD, PI, TAU } from '../../../src/core/constants'
import { medianOf } from '../../../src/core/util'
import { sphericalUnprojectTangentPlane } from '../../../src/math/numerical/geometry'
import type { NumberArray } from '../../../src/math/numerical/math'
import { type Angle, arcmin, deg, hour, normalizeAngle } from '../../../src/math/units/angle'
import { applyPointingOffset, computePointingError, correctPointingCoordinate, type FittedPointingModel, fitPointingModel, MountPointing, type PointingModelStrategy, type PointingSample, predictPointingModelError, selectPointingStrategy, type SerializedPointingModel } from '../../../src/observation/mount/pointing'
import { buildEmpiricalPointingFeatureNames, extractEmpiricalPointingFeatures, resolveFeatureConfiguration, SEMI_PHYSICAL_TERM_NAMES, type PointingFeatureConfiguration, type PointingModelInput, type SemiPhysicalTermName } from '../../../src/observation/mount/pointing.basis'
import { coefficientsByName, generateMechanicalPointingSamples, generateSyntheticPointingSamples, sampleInput } from '../../pointing.util'

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

test('applying an offset across the right ascension wrap stays in 0..TAU and inverts the error', () => {
	const declination = deg(12)

	for (const representation of ['vectorTangent', 'smallAngle'] as const) {
		const west = applyPointingOffset(0.001, declination, arcmin(-40), arcmin(3), representation)
		const east = applyPointingOffset(TAU - 0.001, declination, arcmin(40), arcmin(-3), representation)

		expect(west.rightAscension).toBeGreaterThan(TAU - 0.02)
		expect(west.rightAscension).toBeLessThan(TAU)
		expect(east.rightAscension).toBeGreaterThan(0)
		expect(east.rightAscension).toBeLessThan(0.02)

		const error = computePointingError(0.001, declination, west.rightAscension, west.declination, representation)

		expect(error.dx).toBeCloseTo(arcmin(-40), 10)
		expect(error.dy).toBeCloseTo(arcmin(3), 10)
	}
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

test('robust leave-one-out error matches explicit refits on outlier-contaminated data', () => {
	const parameters = { CH: arcmin(1.1), IH: arcmin(1.6), ID: arcmin(-1.3), NP: arcmin(0.8), MA: arcmin(1.2), ME: arcmin(-1), TF: arcmin(0.9) } as const
	// A small, heavily contaminated set: removing one sample there really does move the robust weights of
	// the ones that remain, which is exactly what the leverage identity cannot represent.
	const samples = generateSyntheticPointingSamples({ count: 16, seed: 31, strategy: 'semiPhysical', time: TIME, latitude: LATITUDE, longitude: LONGITUDE, semiPhysicalParameters: parameters, noiseStd: arcmin(0.1), outlierFraction: 0.4, outlierStd: deg(0.4), includeBothPierSides: true })
	const options = { strategy: 'semiPhysical', robust: { method: 'huber' }, validation: { minimumAltitude: -PI / 2, maximumSeparation: deg(5) } } as const
	const model = fitPointingModel(samples, options)

	expect(model.diagnostics.validSamples).toBe(samples.length)
	expect(model.diagnostics.looRms).toBeDefined()

	// The reference: refit the whole model without each sample and measure what it predicts there.
	let total = 0

	for (let i = 0; i < samples.length; i++) {
		const fold = fitPointingModel(
			samples.filter((_, index) => index !== i),
			options,
		)
		const prediction = predictPointingModelError(fold, sampleInput(samples[i]))
		const error = computePointingError(samples[i].targetRightAscension, samples[i].targetDeclination, samples[i].solvedRightAscension, samples[i].solvedDeclination)
		total += (error.dx - prediction.dx) ** 2 + (error.dy - prediction.dy) ** 2
	}

	const explicitLooRms = Math.sqrt(total / samples.length)
	expect(Math.abs(model.diagnostics.looRms! / explicitLooRms - 1)).toBeLessThan(0.02)
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
	// The correction is the solution of `command + error(command) = target`, so it only matches the
	// negated first-order error to the extent that the error field is locally constant.
	expect(corrected.converged).toBeTrue()
	expect(correction.dx).toBeCloseTo(-prediction.dx, 5)
	expect(correction.dy).toBeCloseTo(-prediction.dy, 5)
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

test('a semi-physical fit at a single declination is rejected as degenerate', () => {
	const declination = deg(20)
	const samples = generateSyntheticPointingSamples({ count: 96, seed: 83, strategy: 'semiPhysical', time: TIME, latitude: LATITUDE, longitude: LONGITUDE, declinationRange: [declination, declination], noiseStd: 0, includeBothPierSides: false })
	const model = fitPointingModel(samples, { strategy: 'semiPhysical', robust: { method: 'none' } })

	expect(model.physical!.rankDeficient).toBeTrue()
	expect(model.physical!.conditionNumber).toBeGreaterThan(1e12)
	expect(model.usable).toBeFalse()
	expect(model.diagnostics.warnings).toContain('the fitted model is poorly constrained or ill-conditioned')

	const prediction = predictPointingModelError(model, sampleInput(samples[0]))
	expect(prediction.dx).toBe(0)
	expect(prediction.dy).toBe(0)
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

test('support is measured against the same pier side the query is filtered to', () => {
	// Two pier sides halve the density of every neighbourhood a prediction is actually compared against.
	// Measuring the training spacing over the whole set would leave the reference roughly a factor of two
	// tighter than any query can achieve, so even a target sitting exactly on a training sample would score
	// as having drifted out of the sampled region.
	const samples = generateSyntheticPointingSamples({ count: 120, seed: 41, strategy: 'empirical', time: TIME, latitude: LATITUDE, longitude: LONGITUDE, featureConfiguration: FEATURE_CONFIGURATION, noiseStd: 0, includeBothPierSides: true })
	const model = fitPointingModel(samples, { strategy: 'empirical', featureConfiguration: FEATURE_CONFIGURATION, validation: { minimumSamples: 12 } })
	const supportSet = model.supportSet!
	const count = supportSet.pierSides.length
	const supports = new Float64Array(count)
	let extrapolating = 0

	// Query the accepted training directions themselves, read back from the support set: a target that is
	// a training sample is the best-supported target that can exist for this model.
	for (let i = 0; i < count; i++) {
		const [rightAscension, declination] = eraC2s(supportSet.directions[i * 3], supportSet.directions[i * 3 + 1], supportSet.directions[i * 3 + 2])
		const quality = predictPointingModelError(model, { rightAscension, declination, time: TIME, latitude: LATITUDE, longitude: LONGITUDE, pierSide: supportSet.pierSides[i] }).quality

		supports[i] = quality.support
		if (quality.extrapolating) extrapolating++
	}

	expect(model.diagnostics.perPierSideSampleCounts.EAST).toBeGreaterThan(0)
	expect(model.diagnostics.perPierSideSampleCounts.WEST).toBeGreaterThan(0)
	// Each query counts itself as its own nearest neighbour, so its k-th neighbour is never farther than
	// the value that entered the median. At least half the training set must therefore score a full 1.
	expect(medianOf(supports.sort())).toBe(1)
	expect(supports[0]).toBeGreaterThan(0.5)
	expect(extrapolating).toBe(0)
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

test('command inversion lands on the target instead of only cancelling the error at it', () => {
	const terms: Readonly<Record<SemiPhysicalTermName, Angle>> = { CH: 120 * ASEC2RAD, IH: -200 * ASEC2RAD, ID: 150 * ASEC2RAD, NP: -90 * ASEC2RAD, MA: 240 * ASEC2RAD, ME: -180 * ASEC2RAD, TF: 160 * ASEC2RAD }
	const samples = generateMechanicalPointingSamples(terms, { count: 120, seed: 97, time: TIME, latitude: LATITUDE, longitude: LONGITUDE })
	const model = fitPointingModel(samples, { strategy: 'semiPhysical', robust: { method: 'none' }, ridge: 1e-12, validation: { minimumAltitude: -PI / 2 } })
	const input = sampleInput(samples[11])
	const corrected = correctPointingCoordinate(model, input)

	expect(corrected.converged).toBeTrue()
	expect(corrected.clamped).toBeFalse()
	expect(corrected.iterations).toBeGreaterThan(0)
	expect(corrected.residual).toBeLessThan(1e-9)

	// Commanding the corrected coordinate must actually reach the target, which is the property the
	// first-order inversion does not have when the error varies across the correction.
	expect(landingError(model, corrected, input)).toBeLessThan(1e-9)

	// The first-order command misses by an amount that grows with the gradient of the error field.
	const firstOrder = predictPointingModelError(model, input)
	const naive = eraC2s(...sphericalUnprojectTangentPlane(-firstOrder.dx, -firstOrder.dy, eraS2c(input.rightAscension, input.declination)))
	expect(landingError(model, { rightAscension: naive[0], declination: naive[1] }, input)).toBeGreaterThan(corrected.residual * 100)
})

test('an extrapolating correction is truncated instead of sent to the mount', () => {
	const terms: Readonly<Record<SemiPhysicalTermName, Angle>> = { CH: 120 * ASEC2RAD, IH: -200 * ASEC2RAD, ID: 150 * ASEC2RAD, NP: -90 * ASEC2RAD, MA: 240 * ASEC2RAD, ME: -180 * ASEC2RAD, TF: 160 * ASEC2RAD }
	const samples = generateMechanicalPointingSamples(terms, { count: 60, seed: 101, time: TIME, latitude: LATITUDE, longitude: LONGITUDE })
	const model = fitPointingModel(samples, { strategy: 'semiPhysical', robust: { method: 'none' }, validation: { minimumAltitude: -PI / 2 } })
	const input = sampleInput(samples[5])
	const limit = 10 * ASEC2RAD
	const clamped = correctPointingCoordinate(model, input, { maximumCorrection: limit })
	const free = correctPointingCoordinate(model, input, { maximumCorrection: Number.POSITIVE_INFINITY })
	const separation = computePointingError(input.rightAscension, input.declination, clamped.rightAscension, clamped.declination).angularSeparation

	expect(free.clamped).toBeFalse()
	expect(computePointingError(input.rightAscension, input.declination, free.rightAscension, free.declination).angularSeparation).toBeGreaterThan(limit)
	expect(clamped.clamped).toBeTrue()
	expect(clamped.converged).toBeFalse()
	expect(separation).toBeCloseTo(limit, 12)

	// The reported residual belongs to the command actually returned, not to the pre-clamp candidate the
	// loop settled on: the truncated command is the one the caller will send, and it misses by much more.
	// `residual` is the gnomonic `tan(separation)`, hence the `atan` before comparing against an angle.
	expect(Math.atan(clamped.residual)).toBeCloseTo(landingError(model, clamped, input), 12)
	expect(clamped.residual).toBeGreaterThan(free.residual * 10)

	// A zero iteration budget still returns a usable command, just an unconverged one.
	const truncated = correctPointingCoordinate(model, input, { maxIterations: 1 })
	expect(truncated.iterations).toBe(1)
	expect(Number.isFinite(truncated.rightAscension)).toBeTrue()
})

test('a correction that cannot be measured is refused instead of reported as unclamped', () => {
	const featureConfiguration = { includeBias: true, includeHourAngleTerms: false, includeDeclinationTerms: false, includeAltitudeTerms: false, includeCrossTerms: false, includePierSideTerms: false, includePolynomialTerms: false } as const satisfies PointingFeatureConfiguration
	const displacement = deg(100)
	const samples: PointingSample[] = []

	for (let i = 0; i < 16; i++) {
		const targetRightAscension = hour(i)
		const targetDeclination = deg(2)
		samples.push({ targetRightAscension, targetDeclination, solvedRightAscension: normalizeAngle(targetRightAscension + displacement), solvedDeclination: targetDeclination, time: TIME, latitude: LATITUDE, longitude: LONGITUDE, pierSide: 'NEITHER' })
	}

	const model = fitPointingModel(samples, { strategy: 'empirical', featureConfiguration, errorRepresentation: 'smallAngle', robust: { method: 'none' }, validation: { minimumAltitude: -PI / 2, maximumSampleSeparation: PI } })
	const input = sampleInput(samples[3])
	const correction = correctPointingCoordinate(model, input)

	expect(model.usable).toBeTrue()
	expect(predictPointingModelError(model, input).offsetMagnitude).toBeGreaterThan(PI / 2)

	expect(correction.clamped).toBeTrue()
	expect(correction.converged).toBeFalse()
	expect(Number.isFinite(correction.residual)).toBeTrue()
	expect(correction.rightAscension).toBe(input.rightAscension)
	expect(correction.declination).toBe(input.declination)
})

test('samples reduced in another frame are rejected instead of mixed into the fit', () => {
	const terms: Readonly<Record<SemiPhysicalTermName, Angle>> = { CH: 40 * ASEC2RAD, IH: -60 * ASEC2RAD, ID: 30 * ASEC2RAD, NP: -20 * ASEC2RAD, MA: 50 * ASEC2RAD, ME: -35 * ASEC2RAD, TF: 25 * ASEC2RAD }
	const samples = generateMechanicalPointingSamples(terms, { count: 60, seed: 71, time: TIME, latitude: LATITUDE, longitude: LONGITUDE })
	const mixed = samples.map((sample, i) => (i % 3 === 0 ? { ...sample, frame: 'icrs' as const } : sample))
	const model = fitPointingModel(mixed, { strategy: 'semiPhysical', robust: { method: 'none' }, validation: { minimumAltitude: -PI / 2 } })

	// The declared-frame samples differ by the whole apparent-place reduction, which is not mechanical.
	expect(model.frame).toBe('apparentTopocentric')
	expect(model.diagnostics.rejectedReasonCounts['frame differs from the model frame']).toBe(20)
	expect(model.trainingSampleCount).toBe(40)

	// Declaring the same frame the fit uses changes nothing.
	const declared = fitPointingModel(
		samples.map((sample) => ({ ...sample, frame: 'icrs' as const })),
		{ strategy: 'semiPhysical', frame: 'icrs', robust: { method: 'none' }, validation: { minimumAltitude: -PI / 2 } },
	)
	expect(declared.frame).toBe('icrs')
	expect(declared.trainingSampleCount).toBe(60)

	// A prediction requested in the wrong frame is answered, but flagged.
	const wrong = predictPointingModelError(declared, { ...sampleInput(samples[2]), frame: 'apparentTopocentric' })
	expect(wrong.quality.warnings).toContain('prediction is in the apparentTopocentric frame but the model was fitted in icrs')
	expect(predictPointingModelError(declared, { ...sampleInput(samples[2]), frame: 'icrs' }).quality.warnings).not.toContain('prediction is in the icrs frame but the model was fitted in icrs')
})

test('a fit with nothing left to summarize reports zeros instead of NaN', () => {
	// Every residual reducer returns NaN for an empty input, so a fit whose samples were all rejected used
	// to publish NaN in fields a caller reads to decide whether to trust the model at all.
	const terms: Readonly<Record<SemiPhysicalTermName, Angle>> = { CH: 40 * ASEC2RAD, IH: -60 * ASEC2RAD, ID: 30 * ASEC2RAD, NP: -20 * ASEC2RAD, MA: 50 * ASEC2RAD, ME: -35 * ASEC2RAD, TF: 25 * ASEC2RAD }
	const samples = generateMechanicalPointingSamples(terms, { count: 30, seed: 91, time: TIME, latitude: LATITUDE, longitude: LONGITUDE })
	const rejected: PointingSample[] = []

	for (const sample of samples) rejected.push({ ...sample, frame: 'icrs' })

	for (const model of [fitPointingModel([]), fitPointingModel(rejected)]) {
		expect(model.usable).toBeFalse()
		expect(model.diagnostics.validSamples).toBe(0)
		expect(model.diagnostics.angularRms).toBe(0)
		expect(model.diagnostics.rmsDx).toBe(0)
		expect(model.diagnostics.rmsDy).toBe(0)
		expect(model.diagnostics.medianResidual).toBe(0)
		expect(model.diagnostics.residualPercentiles).toEqual({ p50: 0, p90: 0, p95: 0 })
		expect(model.diagnostics.looRms).toBeUndefined()
		expect(model.diagnostics.looResidualPercentiles).toBeUndefined()
	}

	expect(fitPointingModel(rejected).diagnostics.rejectedSamples).toBe(30)
	// The strategy comparison must survive the degenerate set too, rather than returning nothing.
	expect(selectPointingStrategy([]).diagnostics.angularRms).toBe(0)
})

test('importing a model can restore the training samples', () => {
	const terms: Readonly<Record<SemiPhysicalTermName, Angle>> = { CH: 40 * ASEC2RAD, IH: -60 * ASEC2RAD, ID: 30 * ASEC2RAD, NP: -20 * ASEC2RAD, MA: 50 * ASEC2RAD, ME: -35 * ASEC2RAD, TF: 25 * ASEC2RAD }
	const samples = generateMechanicalPointingSamples(terms, { count: 60, seed: 73, time: TIME, latitude: LATITUDE, longitude: LONGITUDE })
	const source = new MountPointing({ strategy: 'hybrid', robust: { method: 'none' }, validation: { minimumAltitude: -PI / 2 } })

	for (const sample of samples) source.add(sample)

	const fitted = source.fit()
	const bare = source.export()!
	const withSamples = source.export({ includeSamples: true })!

	expect(bare.samples).toBeUndefined()
	expect(withSamples.samples).toHaveLength(60)

	// A model imported with its dataset can be refitted without recollecting, and the model itself is
	// restored without the dataset hanging off it.
	const target = new MountPointing({ strategy: 'hybrid', robust: { method: 'none' }, validation: { minimumAltitude: -PI / 2 } })
	const imported = target.import(withSamples)

	expect((imported as SerializedPointingModel).samples).toBeUndefined()
	expect(target.state.sampleCount).toBe(60)
	expect(target.fit().physical!.parameters[0]).toBeCloseTo(fitted.physical!.parameters[0], 12)

	// A rejected import leaves the previously loaded model untouched.
	expect(target.state.fittedModel?.version).toBe(1)
})

// Angular distance (radians) between the requested target and where `command` would actually land.
function landingError(model: FittedPointingModel, command: { rightAscension: Angle; declination: Angle }, target: PointingModelInput) {
	const error = predictPointingModelError(model, { ...target, rightAscension: command.rightAscension, declination: command.declination })
	const reached = eraC2s(...sphericalUnprojectTangentPlane(error.dx, error.dy, eraS2c(command.rightAscension, command.declination)))
	return computePointingError(target.rightAscension, target.declination, reached[0], reached[1]).angularSeparation
}

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

function medianPredictionResidual(model: FittedPointingModel, samples: readonly PointingSample[]) {
	const residuals = new Float64Array(samples.length)

	for (let i = 0; i < samples.length; i++) {
		const actual = computePointingError(samples[i].targetRightAscension, samples[i].targetDeclination, samples[i].solvedRightAscension, samples[i].solvedDeclination)
		const predicted = predictPointingModelError(model, sampleInput(samples[i]))
		residuals[i] = Math.hypot(actual.dx - predicted.dx, actual.dy - predicted.dy)
	}

	return medianOf(residuals.sort())
}
