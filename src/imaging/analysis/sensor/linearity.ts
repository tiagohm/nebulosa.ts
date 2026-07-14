import { weightedLinearRegression, weightedLinearRegressionScore } from '../../../math/numerical/regression'
import type { PhotonTransferPoint, SensorGain, SensorRegressionFit } from './ptc'
import type { SensorSaturation } from './saturation'
import { DEFAULT_SENSOR_CHARACTERIZATION_OPTIONS, type SensorFlatFrameSet } from './types'

// Relative or photon-calibrated response linearity for one sensor plane. Fits use inverse-square signal
// weights so residuals are minimized relatively across the selected saturation interval. Results are
// fresh scalar/point arrays and inputs are not modified.

// Measured and predicted response at one selected stimulus level.
export interface SensorLinearityPoint {
	// Exposure-intensity product or calibrated incident photons per pixel.
	readonly input: number
	// Dark-corrected measured signal, DN.
	readonly measured: number
	// Fitted response at the same input, DN.
	readonly predicted: number
	// Relative residual (measured-predicted)/predicted as a fraction.
	readonly error: number
}

// Weighted linear response fit and relative residual summary.
export interface SensorLinearity {
	// Response slope, DN per input unit.
	readonly slope: number
	// Response-axis intercept, DN.
	readonly intercept: number
	// Minimum relative residual over selected points.
	readonly minimum: number
	// Maximum relative residual over selected points.
	readonly maximum: number
	// Root-mean-square relative residual.
	readonly rms: number
	// Mean absolute relative residual.
	readonly error: number
	// Selected response points in ascending input order.
	readonly points: readonly SensorLinearityPoint[]
	// Weighted regression quality and coefficient uncertainty.
	readonly fit: SensorRegressionFit
}

// Linearity plus absolute photon-response quantities when calibration is complete.
export interface SensorLinearityAnalysis {
	// Relative or photon-calibrated response fit.
	readonly linearity?: SensorLinearity
	// DN per incident photon when every selected level is photon calibrated.
	readonly responsivity?: number
	// Converted electrons per incident photon when physically within 0..1.
	readonly quantumEfficiency?: number
	// Reason calibrated photon responsivity could not produce quantum efficiency.
	readonly quantumEfficiencyUnavailable?: 'missingSpectralCalibration' | 'outOfRange'
}

// Measures response linearity over a fractional saturation interval.
export function measureSensorLinearity(points: readonly PhotonTransferPoint[], flats: readonly SensorFlatFrameSet[], saturation: SensorSaturation | undefined, gain: SensorGain | undefined, range: readonly [number, number] = DEFAULT_SENSOR_CHARACTERIZATION_OPTIONS.linearityRange): SensorLinearityAnalysis {
	if (range.length !== 2 || !Number.isFinite(range[0]) || !Number.isFinite(range[1]) || range[0] < 0 || range[0] >= range[1] || range[1] > 1) throw new RangeError('linearity range must be an increasing fraction within 0..1')
	let observedMaximum = 0
	for (const point of points) if (point.valid && point.clippedFraction <= 0 && (point.darkClippedFraction ?? 0) <= 0 && point.signal > observedMaximum) observedMaximum = point.signal
	const saturationSignal = saturation?.signal ?? observedMaximum
	if (!(saturationSignal > 0)) return {}
	const minimumSignal = saturationSignal * range[0]
	const maximumSignal = saturationSignal * range[1]
	const eligible: { point: PhotonTransferPoint; flat: SensorFlatFrameSet }[] = []
	let allPhotonCalibrated = true
	let allSpectrallyCalibrated = true
	let wavelength: number | undefined
	for (const point of points) {
		if (!point.valid || point.clippedFraction > 0 || (point.darkClippedFraction ?? 0) > 0 || point.signal < minimumSignal || point.signal > maximumSignal) continue
		const flat = flats[point.level]
		if (!flat) continue
		const photons = flat.photons
		allPhotonCalibrated &&= photons !== undefined && Number.isFinite(photons) && photons > 0
		const candidateWavelength = flat.wavelength
		allSpectrallyCalibrated &&= candidateWavelength !== undefined && Number.isFinite(candidateWavelength) && candidateWavelength > 0 && (wavelength === undefined || candidateWavelength === wavelength)
		if (candidateWavelength !== undefined && Number.isFinite(candidateWavelength) && candidateWavelength > 0 && wavelength === undefined) wavelength = candidateWavelength
		eligible.push({ point, flat })
	}

	const candidates: { input: number; measured: number }[] = []
	for (const { point, flat } of eligible) {
		const input = allPhotonCalibrated ? flat.photons! : flat.exposure * (flat.intensity ?? 1)
		if (!Number.isFinite(input) || input <= 0) continue
		candidates.push({ input, measured: point.signal })
	}

	if (candidates.length < 2) return {}
	candidates.sort((a, b) => a.input - b.input)
	const x = new Float64Array(candidates.length)
	const y = new Float64Array(candidates.length)
	const weights = new Float64Array(candidates.length)
	for (let i = 0; i < candidates.length; i++) {
		x[i] = candidates[i].input
		y[i] = candidates[i].measured
		weights[i] = 1 / (candidates[i].measured * candidates[i].measured)
	}

	let regression
	try {
		regression = weightedLinearRegression(x, y, weights)
	} catch {
		return {}
	}

	if (!(regression.slope > 0) || !Number.isFinite(regression.intercept)) return {}
	const score = weightedLinearRegressionScore(regression, x, y, weights)
	const linearityPoints: SensorLinearityPoint[] = []
	let minimum = Number.POSITIVE_INFINITY
	let maximum = Number.NEGATIVE_INFINITY
	let absoluteError = 0
	let squaredError = 0
	for (let i = 0; i < x.length; i++) {
		const predicted = regression.predict(x[i])
		if (!Number.isFinite(predicted) || predicted === 0) return {}
		const error = (y[i] - predicted) / predicted
		minimum = Math.min(minimum, error)
		maximum = Math.max(maximum, error)
		absoluteError += Math.abs(error)
		squaredError += error * error
		linearityPoints.push({ input: x[i], measured: y[i], predicted, error })
	}

	const fit: SensorRegressionFit = { r: score.r, r2: score.r2, rss: score.rss, rmsd: score.rmsd, pointCount: score.pointCount, weighted: true, slopeStandardError: score.slopeStandardError, interceptStandardError: score.interceptStandardError }
	const linearity: SensorLinearity = { slope: regression.slope, intercept: regression.intercept, minimum, maximum, rms: Math.sqrt(squaredError / x.length), error: absoluteError / x.length, points: linearityPoints, fit }
	const responsivity = allPhotonCalibrated ? regression.slope : undefined
	const efficiency = responsivity !== undefined && allSpectrallyCalibrated && gain ? responsivity / gain.system : undefined
	const quantumEfficiency = efficiency !== undefined && Number.isFinite(efficiency) && efficiency >= 0 && efficiency <= 1 ? efficiency : undefined
	const quantumEfficiencyUnavailable = responsivity !== undefined && gain && quantumEfficiency === undefined ? (allSpectrallyCalibrated ? 'outOfRange' : 'missingSpectralCalibration') : undefined
	return { linearity, responsivity, quantumEfficiency, quantumEfficiencyUnavailable }
}
