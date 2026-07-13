import { weightedLinearRegression, weightedLinearRegressionScore, type RegressionScore } from '../../math/numerical/regression'
import type { DigitalImage } from '../model/types'
import { aggregateSensorPairs, measureSensorPair, type SensorPairAggregate, type SensorPairOptions, type SensorPairStatistics } from './sensor.pair'
import { DEFAULT_SENSOR_CHARACTERIZATION_OPTIONS, type SensorFlatFrameSet, type SensorFrameSet, type SensorPointRejectionReason } from './sensor.types'

// Temporal sensor characterization from non-overlapping frame pairs. Flat variance is corrected by an
// exposure-matched dark when supplied, otherwise by the bias pair aggregate. Gain uses a centered
// weighted fit with an unknown intercept; all public numeric results are finite or omitted.

// One dark-corrected photon-transfer measurement level.
export interface PhotonTransferPoint {
	// Zero-based acquisition level index in the caller's flat array.
	readonly level: number
	// Flat exposure duration, seconds.
	readonly exposure: number
	// Calibrated photons/pixel or relative exposure-intensity stimulus used for response slopes.
	readonly stimulus?: number
	// Dark-corrected mean signal, DN.
	readonly signal: number
	// Dark-corrected temporal variance, DN squared.
	readonly variance: number
	// Mean dark reference level, DN.
	readonly darkMean: number
	// Temporal dark-reference variance, DN squared.
	readonly darkVariance: number
	// Fraction of valid samples at the known upper digital clip.
	readonly clippedFraction: number
	// Signal divided by an independently determined saturation signal.
	readonly saturationFraction?: number
	// Number of non-overlapping flat pairs represented.
	readonly pairCount: number
	// Measured signal-to-noise ratio using total flat temporal variance.
	readonly snr?: number
	// True when corrected signal and variance are finite and positive.
	readonly valid: boolean
	// True when this point was included in the gain fit.
	readonly selectedForGainFit: boolean
	// Explicit reasons the point was excluded from the gain fit.
	readonly fitRejectionReasons: readonly SensorPointRejectionReason[]
}

// Fit quality and parameter uncertainty for a sensor regression.
export interface SensorRegressionFit extends RegressionScore {
	// Number of points included in the regression.
	readonly pointCount: number
	// True when positive weights were applied.
	readonly weighted: boolean
	// Standard error of the fitted slope when estimable.
	readonly slopeStandardError?: number
	// Standard error of the fitted intercept when estimable.
	readonly interceptStandardError?: number
}

// Conversion and system gain recovered from the linear photon-transfer region.
export interface SensorGain {
	// System gain, DN per electron.
	readonly system: number
	// Conversion gain, electrons per DN.
	readonly conversion: number
	// Fitted variance-axis intercept, DN squared.
	readonly intercept: number
	// Weighted regression quality and uncertainty.
	readonly fit: SensorRegressionFit
	// Minimum and maximum selected signal, DN.
	readonly range: readonly [number, number]
}

// Temporal read-noise measurement from short dark or bias pairs.
export interface SensorReadNoise {
	// Total RMS noise in the digital domain, DN.
	readonly digital: number
	// Input-referred RMS including quantization, electrons.
	readonly totalElectrons?: number
	// Input-referred RMS after uniform-quantization correction, electrons.
	readonly sensorElectrons?: number
	// Number of non-overlapping dark pairs represented.
	readonly pairCount: number
	// Between-pair standard deviation of digital RMS, DN.
	readonly deviation: number
}

// Bias scalar summary used by temporal and spatial stages.
export interface SensorBias {
	// Mean bias pedestal, DN.
	readonly mean: number
	// Signed first-minus-second frame drift, DN.
	readonly drift: number
	// Total valid pixel samples represented across pairs.
	readonly sampleCount: number
}

// Options for one sensor plane's temporal characterization.
export interface SensorTemporalOptions extends SensorPairOptions {
	// Fractional observed-signal interval used for the gain fit.
	readonly gainRange?: readonly [number, number]
}

// First practical temporal characterization result for one sensor plane.
export interface SensorTemporalCharacterization {
	// Bias pedestal and drift summary.
	readonly bias: SensorBias
	// Dark-corrected PTC points in ascending signal order.
	readonly photonTransfer: readonly PhotonTransferPoint[]
	// Gain result when at least two valid points yield positive slope.
	readonly gain?: SensorGain
	// Read noise from bias pairs, with electron values when gain is valid.
	readonly readNoise: SensorReadNoise
}

// Validates a temporal frame list and returns its reference image. Every frame must be a single-channel
// digital image with the same dimensions and CFA pattern as `reference`, when provided.
function validateTemporalFrames(frames: SensorFrameSet['frames'], reference?: DigitalImage): DigitalImage {
	if (frames.length < 2) throw new RangeError('temporal frame set requires at least two frames')
	const expected = reference ?? frames[0]
	for (const frame of frames) {
		if (frame.sampleScale !== 'digital') throw new TypeError('temporal analysis requires digital images')
		if (frame.metadata.width !== expected.metadata.width || frame.metadata.height !== expected.metadata.height || frame.metadata.channels !== 1 || frame.metadata.bayer !== expected.metadata.bayer) throw new RangeError('temporal frame sets must share dimensions and CFA pattern')
		const pixelCount = frame.metadata.width * frame.metadata.height
		if (frame.metadata.pixelCount !== pixelCount || frame.raw.length < pixelCount) throw new RangeError('temporal frame pixel geometry or raw-buffer length is inconsistent')
	}
	return expected
}

// Measures all consecutive non-overlapping pairs in a frame list.
function measurePairs(frames: SensorFrameSet['frames'], options: Partial<SensorPairOptions>): readonly [SensorPairAggregate, readonly SensorPairStatistics[]] {
	const pairs: SensorPairStatistics[] = []
	for (let i = 0; i + 1 < frames.length; i += 2) pairs.push(measureSensorPair(frames[i], frames[i + 1], options))
	if (pairs.length === 0) throw new RangeError('sensor frame set requires at least one complete pair')
	return [aggregateSensorPairs(pairs), pairs]
}

// Returns a common integer quantization step, or undefined when frames do not establish one.
function commonQuantizationStep(frames: SensorFrameSet['frames']): number | undefined {
	const step = frames[0].quantizationStep
	if (!(step !== undefined && Number.isFinite(step) && step > 0)) return undefined
	for (let i = 1; i < frames.length; i++) if (frames[i].quantizationStep !== step) return undefined
	return step
}

// Resolves one flat level on the common calibrated or relative stimulus scale selected for the series.
function flatStimulus(level: SensorFlatFrameSet, calibrated: boolean): number | undefined {
	if (calibrated) return level.photons
	const stimulus = level.exposure * (level.intensity ?? 1)
	return Number.isFinite(stimulus) && stimulus >= 0 ? stimulus : undefined
}

// Computes digital and optionally input-referred read noise from independent dark-pair reports.
export function measureSensorReadNoise(pairs: readonly SensorPairStatistics[], conversionGain?: number, quantizationStep?: number): SensorReadNoise {
	if (pairs.length === 0) throw new RangeError('read-noise measurement requires at least one pair')
	let weightedVariance = 0
	let sampleCount = 0
	let rmsMean = 0
	let rmsM2 = 0
	for (let i = 0; i < pairs.length; i++) {
		const pair = pairs[i]
		if (!Number.isFinite(pair.variance) || pair.variance < 0 || pair.sampleCount <= 0) throw new RangeError('read-noise pair variance must be finite and non-negative')
		weightedVariance += pair.variance * pair.sampleCount
		sampleCount += pair.sampleCount
		const rms = Math.sqrt(pair.variance)
		const delta = rms - rmsMean
		rmsMean += delta / (i + 1)
		rmsM2 += delta * (rms - rmsMean)
	}

	const digital = Math.sqrt(weightedVariance / sampleCount)
	const validGain = conversionGain !== undefined && Number.isFinite(conversionGain) && conversionGain > 0
	const totalElectrons = validGain ? digital * conversionGain : undefined
	let sensorElectrons: number | undefined
	if (validGain && quantizationStep !== undefined && Number.isFinite(quantizationStep) && quantizationStep > 0) {
		sensorElectrons = Math.sqrt(Math.max(0, digital * digital - (quantizationStep * quantizationStep) / 12)) * conversionGain
	}

	return { digital, totalElectrons, sensorElectrons, pairCount: pairs.length, deviation: Math.sqrt(rmsM2 / pairs.length) }
}

// Fits positive PTC points over a fractional observed-signal range and annotates every rejection.
export function fitPhotonTransferGain(points: readonly PhotonTransferPoint[], range: readonly [number, number] = DEFAULT_SENSOR_CHARACTERIZATION_OPTIONS.gainRange): readonly [readonly PhotonTransferPoint[], SensorGain | undefined] {
	if (range.length !== 2 || !Number.isFinite(range[0]) || !Number.isFinite(range[1]) || range[0] < 0 || range[0] >= range[1] || range[1] > 1) throw new RangeError('gain range must be an increasing fraction within 0..1')
	let maximumSignal = 0
	for (const point of points) if (point.valid && point.clippedFraction === 0 && point.signal > maximumSignal) maximumSignal = point.signal
	const minimum = maximumSignal * range[0]
	const maximum = maximumSignal * range[1]
	const annotated: PhotonTransferPoint[] = []
	let selectedCount = 0
	for (const point of points) {
		const reasons: SensorPointRejectionReason[] = []
		if (!(point.signal > 0)) reasons.push('nonPositiveSignal')
		if (!(point.variance > 0)) reasons.push('nonPositiveVariance')
		if (point.clippedFraction > 0) reasons.push('clipped')
		if (point.signal < minimum || point.signal > maximum) reasons.push('outsideFitRange')
		if (point.pairCount < 1) reasons.push('insufficientSamples')
		const selectedForGainFit = reasons.length === 0
		if (selectedForGainFit) selectedCount++
		annotated.push({ ...point, selectedForGainFit, fitRejectionReasons: reasons })
	}

	if (selectedCount < 2) return [annotated, undefined]
	const x = new Float64Array(selectedCount)
	const y = new Float64Array(selectedCount)
	const weights = new Float64Array(selectedCount)
	let at = 0
	let selectedMinimum = Number.POSITIVE_INFINITY
	let selectedMaximum = Number.NEGATIVE_INFINITY
	for (const point of annotated) {
		if (!point.selectedForGainFit) continue
		x[at] = point.signal
		y[at] = point.variance
		weights[at] = point.pairCount
		selectedMinimum = Math.min(selectedMinimum, point.signal)
		selectedMaximum = Math.max(selectedMaximum, point.signal)
		at++
	}

	if (selectedMinimum === selectedMaximum) return [annotated, undefined]
	const regression = weightedLinearRegression(x, y, weights)
	if (!(regression.slope > 0) || !Number.isFinite(regression.slope) || !Number.isFinite(regression.intercept)) return [annotated, undefined]
	const score = weightedLinearRegressionScore(regression, x, y, weights)
	const fit: SensorRegressionFit = {
		r: score.r,
		r2: score.r2,
		rss: score.rss,
		rmsd: score.rmsd,
		pointCount: score.pointCount,
		weighted: true,
		slopeStandardError: score.slopeStandardError,
		interceptStandardError: score.interceptStandardError,
	}
	return [annotated, { system: regression.slope, conversion: 1 / regression.slope, intercept: regression.intercept, fit, range: [selectedMinimum, selectedMaximum] }]
}

// Characterizes one plane's PTC, gain, bias, and read noise from paired bias and flat datasets.
export function characterizeSensorTemporal(bias: SensorFrameSet, flats: readonly SensorFlatFrameSet[], options: Partial<SensorTemporalOptions> = {}): SensorTemporalCharacterization {
	const pairOptions: Partial<SensorPairOptions> = { area: options.area, plane: options.plane, cfaOffset: options.cfaOffset, digitalClip: options.digitalClip, mask: options.mask }
	const reference = validateTemporalFrames(bias.frames)
	for (const level of flats) {
		validateTemporalFrames(level.frames, reference)
		if (level.darkFrames) validateTemporalFrames(level.darkFrames, reference)
	}
	const [biasAggregate, biasPairs] = measurePairs(bias.frames, pairOptions)
	const rawPoints: PhotonTransferPoint[] = []
	let calibratedStimulus = flats.length > 0
	for (const level of flats) {
		if (!(level.photons !== undefined && Number.isFinite(level.photons) && level.photons > 0)) {
			calibratedStimulus = false
			break
		}
	}
	for (let levelIndex = 0; levelIndex < flats.length; levelIndex++) {
		const level = flats[levelIndex]
		const [flat] = measurePairs(level.frames, pairOptions)
		const dark = level.darkFrames ? measurePairs(level.darkFrames, pairOptions)[0] : biasAggregate
		const signal = flat.mean - dark.mean
		const variance = flat.variance - dark.variance
		const totalVariance = variance + dark.variance
		const valid = Number.isFinite(signal) && Number.isFinite(variance) && signal > 0 && variance > 0
		rawPoints.push({
			level: levelIndex,
			exposure: level.exposure,
			stimulus: flatStimulus(level, calibratedStimulus),
			signal,
			variance,
			darkMean: dark.mean,
			darkVariance: dark.variance,
			clippedFraction: flat.clippedFraction,
			pairCount: flat.pairCount,
			snr: signal > 0 && totalVariance > 0 ? signal / Math.sqrt(totalVariance) : undefined,
			valid,
			selectedForGainFit: false,
			fitRejectionReasons: [],
		})
	}

	rawPoints.sort((a, b) => a.signal - b.signal)
	const [photonTransfer, gain] = fitPhotonTransferGain(rawPoints, options.gainRange)
	const readNoise = measureSensorReadNoise(biasPairs, gain?.conversion, commonQuantizationStep(bias.frames))
	return { bias: { mean: biasAggregate.mean, drift: biasAggregate.drift, sampleCount: biasAggregate.sampleCount }, photonTransfer, gain, readNoise }
}
