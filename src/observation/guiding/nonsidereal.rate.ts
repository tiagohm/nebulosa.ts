import type { EquatorialCoordinate } from '../../astronomy/coordinates/coordinate'
import { type Time, timeSubtract, Timescale, tt, toJulianDay } from '../../astronomy/time/time'
import { ASEC2RAD, DAYSEC } from '../../core/constants'
import { medianBySelectionOf } from '../../math/numerical/statistics'
import type { Angle } from '../../math/units/angle'
import { nonSiderealAngularOffset } from './tracker.nonsidereal'

// Image-assisted non-sidereal motion estimation. Sky offsets use the anchor's local east/north
// tangent plane in radians; rates use radians/second and accelerations use radians/second².

// A position observation in the estimator anchor's local tangent plane. Supply `ephemerisOffset`
// with absolute observations to fit only their residual relative to the feed-forward trajectory.
export interface TrackingMotionSample {
	// Astronomical observation time, preferably the exposure midpoint.
	readonly time: Time
	// Absolute east/north offset from the fixed tangent-plane anchor, in radians.
	readonly offset: readonly [Angle, Angle]
	// Optional one-sigma east/north measurement uncertainty, in radians.
	readonly uncertainty?: readonly [Angle, Angle]
	// Measurement origin for caller-side diagnostics; ephemeris mode is selected by `ephemerisOffset`.
	readonly source: 'targetAstrometry' | 'targetImage' | 'backgroundStars' | 'streak' | 'ephemeris'
	// Optional relative confidence in [0, 1]; omitted confidence is treated as 1.
	readonly confidence?: number
	// Predicted ephemeris offset in the same tangent plane and at the same time, in radians.
	readonly ephemerisOffset?: readonly [Angle, Angle]
}

// Limits for retained image-motion observations and short-horizon prediction.
export interface TrackingRateEstimatorOptions {
	// Required accepted observations before a rate is published; defaults to 5 to give the robust fit redundancy.
	readonly minimumSampleCount?: number
	// Maximum retained observations; defaults to 32 and is capped at 256 to keep storage and robust fitting bounded.
	readonly maximumSampleCount?: number
	// Sliding observation window in seconds; defaults to 600.
	readonly windowSeconds?: number
	// Maximum prediction beyond the newest observation in seconds; defaults to 120.
	readonly maximumPredictionSeconds?: number
	// Maximum age of the newest observation in seconds; defaults to 120.
	readonly staleTimeoutSeconds?: number
	// Minimum separation between accepted observations in seconds; defaults to 0.1.
	readonly minimumTimeSeparationSeconds?: number
	// Maximum accepted step between consecutive observed offsets, in radians.
	readonly maximumSampleJump?: Angle
	// Positive robust-fit outlier threshold, in radians; defaults to 3 arcseconds.
	readonly robustOutlierThreshold?: Angle
	// Whether to try a quadratic fit when enough time span and observations are available.
	readonly fitAcceleration?: boolean
	// Minimum time span required before acceleration may be fitted, in seconds; defaults to 120.
	readonly minimumAccelerationSpanSeconds?: number
	// Required fractional RMS reduction for accepting a quadratic fit; defaults to 0.2.
	readonly minimumAccelerationImprovement?: number
}

// One current tangent-plane estimate; rates are radians/second and RMS values are radians.
export interface TrackingRateEstimate {
	// Time at which the fitted position and derivative are evaluated.
	readonly time: Time
	// Fitted east/north angular velocity, in radians per second.
	readonly rate: readonly [number, number]
	// Fitted east/north angular acceleration, in radians per second squared, when resolved.
	readonly acceleration?: readonly [number, number]
	// Fitted east/north position relative to the sample anchor, or fitted ephemeris residual, in radians.
	readonly position?: readonly [Angle, Angle]
	// Number of accepted position observations in the fit.
	readonly sampleCount: number
	// Time span represented by retained observations, in seconds.
	readonly span: number
	// East/north root-mean-square residual, in radians.
	readonly rmsResidual: readonly [Angle, Angle]
	// Relative fit quality in [0, 1], including temporal coverage and residual size.
	readonly confidence: number
	// Whether the rate is image-measured or a residual around a supplied ephemeris.
	readonly source: 'measured' | 'ephemerisAssisted'
	// True after the stale timeout while still inside the prediction horizon; consumers must not apply stale feedback.
	readonly stale: boolean
}

// Internal bounded snapshot; no frame image or caller-owned tuple is retained.
interface StoredSample {
	// Original astronomical time, retained for precision-safe differences.
	readonly time: Time
	// Offset relative to any supplied ephemeris prediction, in radians.
	readonly offset: readonly [number, number]
	// Optional one-sigma uncertainty in radians.
	readonly uncertainty?: readonly [number, number]
	// Relative sample weight.
	readonly confidence: number
	// Whether the sample was residualized against an absolute ephemeris.
	readonly ephemerisOffset?: readonly [number, number]
}

interface AxisFit {
	// Fitted intercept, scaled-time slope, and optional scaled-time quadratic coefficient.
	readonly coefficients: readonly [number, number, number]
	// Robust confidence- and uncertainty-weighted residual RMS in radians.
	readonly rms: number
	// Threshold-clipped residual RMS used to compare linear and quadratic models.
	readonly modelRms: number
	// Fraction of robust weighted support retained by the fit.
	readonly confidence: number
}

// Maintains a bounded robust fit of image-derived tangent-plane motion.
export class TrackingRateEstimator {
	readonly #options: Required<TrackingRateEstimatorOptions>
	readonly #samples: StoredSample[] = []
	#ephemerisAssisted?: boolean
	#lastTime?: Time

	// Creates a bounded estimator. `options` sets sample, time-window, robustness, and acceleration limits; no image data or external services are retained.
	constructor(options?: TrackingRateEstimatorOptions) {
		const maximumSampleCount = options?.maximumSampleCount ?? 32
		// Prevent accidental unbounded retained samples and quadratic robust-slope work per estimate.
		if (!(maximumSampleCount >= 1 && maximumSampleCount <= 256)) throw new RangeError('maximumSampleCount must be between 1 and 256')

		this.#options = {
			minimumSampleCount: options?.minimumSampleCount ?? 5,
			maximumSampleCount,
			windowSeconds: options?.windowSeconds ?? 600,
			maximumPredictionSeconds: options?.maximumPredictionSeconds ?? 120,
			staleTimeoutSeconds: options?.staleTimeoutSeconds ?? 120,
			minimumTimeSeparationSeconds: options?.minimumTimeSeparationSeconds ?? 0.1,
			maximumSampleJump: options?.maximumSampleJump ?? Infinity,
			robustOutlierThreshold: options?.robustOutlierThreshold ?? 3 * ASEC2RAD,
			fitAcceleration: options?.fitAcceleration ?? false,
			minimumAccelerationSpanSeconds: options?.minimumAccelerationSpanSeconds ?? 120,
			minimumAccelerationImprovement: options?.minimumAccelerationImprovement ?? 0.2,
		}
	}

	// Adds `sample` at its astronomical time and east/north offset. Returns false for non-finite data,
	// mixed ephemeris modes, non-monotonic or too-close times, or a jump beyond the configured limit.
	add(sample: Readonly<TrackingMotionSample>): boolean {
		const julianDay = toJulianDay(tt(sample.time))
		const confidence = sample.confidence ?? 1
		if (!Number.isFinite(julianDay) || !Number.isFinite(sample.offset[0]) || !Number.isFinite(sample.offset[1])) return false
		if (!(confidence > 0 && confidence <= 1)) return false
		if (sample.uncertainty !== undefined && (!(sample.uncertainty[0] > 0) || !(sample.uncertainty[1] > 0) || !Number.isFinite(sample.uncertainty[0]) || !Number.isFinite(sample.uncertainty[1]))) return false
		if (sample.ephemerisOffset !== undefined && (!Number.isFinite(sample.ephemerisOffset[0]) || !Number.isFinite(sample.ephemerisOffset[1]))) return false
		if (this.#ephemerisAssisted !== undefined && this.#ephemerisAssisted !== (sample.ephemerisOffset !== undefined)) return false

		const observedOffset = sample.ephemerisOffset === undefined ? sample.offset : ([sample.offset[0] - sample.ephemerisOffset[0], sample.offset[1] - sample.ephemerisOffset[1]] as const)
		if (this.#lastTime !== undefined) {
			const separation = timeSubtract(sample.time, this.#lastTime, Timescale.TT) * DAYSEC
			if (!(separation >= this.#options.minimumTimeSeparationSeconds)) return false
			const previous = this.#samples.at(-1)
			if (previous !== undefined && this.#options.maximumSampleJump < Infinity) {
				const dx = observedOffset[0] - previous.offset[0]
				const dy = observedOffset[1] - previous.offset[1]
				if (Math.hypot(dx, dy) > this.#options.maximumSampleJump) return false
			}
		}

		const stored: StoredSample = {
			time: sample.time,
			offset: [observedOffset[0], observedOffset[1]],
			uncertainty: sample.uncertainty === undefined ? undefined : [sample.uncertainty[0], sample.uncertainty[1]],
			confidence,
			ephemerisOffset: sample.ephemerisOffset === undefined ? undefined : [sample.ephemerisOffset[0], sample.ephemerisOffset[1]],
		}

		this.#samples.push(stored)
		this.#ephemerisAssisted = sample.ephemerisOffset !== undefined
		this.#lastTime = sample.time

		while (true) {
			const oldest = this.#samples.at(0)
			if (oldest === undefined) break
			if (timeSubtract(sample.time, oldest.time, Timescale.TT) * DAYSEC > this.#options.windowSeconds || this.#samples.length > this.#options.maximumSampleCount) this.#samples.shift()
			else break
		}

		return true
	}

	// Evaluates the robust fit at `time` using TT time differences. Returns undefined before the minimum
	// sample count, outside either prediction horizon, or when the local fit is singular.
	estimate(time: Time): TrackingRateEstimate | undefined {
		if (this.#samples.length < this.#options.minimumSampleCount) return undefined
		if (!Number.isFinite(toJulianDay(tt(time)))) return undefined
		const first = this.#samples[0]
		const last = this.#samples.at(-1)
		if (first === undefined || last === undefined) return undefined
		const ahead = timeSubtract(time, last.time, Timescale.TT) * DAYSEC
		const behind = timeSubtract(first.time, time, Timescale.TT) * DAYSEC
		if (ahead > this.#options.maximumPredictionSeconds || behind > this.#options.maximumPredictionSeconds) return undefined
		const stale = ahead > this.#options.staleTimeoutSeconds

		const span = timeSubtract(last.time, first.time, Timescale.TT) * DAYSEC
		let scale = 1
		for (const sample of this.#samples) scale = Math.max(scale, Math.abs(timeSubtract(sample.time, time, Timescale.TT) * DAYSEC))
		const allowQuadratic = this.#options.fitAcceleration && this.#samples.length >= Math.max(5, this.#options.minimumSampleCount) && span >= this.#options.minimumAccelerationSpanSeconds
		const eastLinear = fitAxis(this.#samples, 0, time, scale, false, this.#options.robustOutlierThreshold)
		const northLinear = fitAxis(this.#samples, 1, time, scale, false, this.#options.robustOutlierThreshold)
		if (eastLinear === undefined || northLinear === undefined) return undefined
		let east = eastLinear
		let north = northLinear
		let quadratic = false

		if (allowQuadratic) {
			const eastCandidate = fitAxis(this.#samples, 0, time, scale, true, this.#options.robustOutlierThreshold)
			const northCandidate = fitAxis(this.#samples, 1, time, scale, true, this.#options.robustOutlierThreshold)
			const linearRms = Math.hypot(eastLinear.modelRms, northLinear.modelRms)
			const quadraticRms = Math.hypot(eastCandidate?.modelRms ?? Infinity, northCandidate?.modelRms ?? Infinity)
			if (eastCandidate !== undefined && northCandidate !== undefined && linearRms > 0 && quadraticRms <= linearRms * (1 - this.#options.minimumAccelerationImprovement)) {
				east = eastCandidate
				north = northCandidate
				quadratic = true
			}
		}

		const eastRate = east.coefficients[1] / scale
		const northRate = north.coefficients[1] / scale
		const acceleration = quadratic ? ([(2 * east.coefficients[2]) / (scale * scale), (2 * north.coefficients[2]) / (scale * scale)] as const) : undefined
		if (!Number.isFinite(eastRate) || !Number.isFinite(northRate) || (acceleration !== undefined && (!Number.isFinite(acceleration[0]) || !Number.isFinite(acceleration[1])))) return undefined

		const coverage = Math.min(1, span / 10)
		const residual = Math.hypot(east.rms, north.rms)
		const quality = Math.max(0, 1 - residual / Math.max(this.#options.robustOutlierThreshold, Number.EPSILON))
		let meanSampleConfidence = 0
		for (const sample of this.#samples) meanSampleConfidence += sample.confidence
		meanSampleConfidence /= this.#samples.length
		const confidence = Math.max(0, Math.min(1, quality * coverage * meanSampleConfidence * Math.min(east.confidence, north.confidence) * Math.min(1, this.#samples.length / (this.#options.minimumSampleCount + 2))))

		return {
			time,
			rate: [eastRate, northRate],
			acceleration,
			position: [east.coefficients[0], north.coefficients[0]],
			sampleCount: this.#samples.length,
			span,
			rmsResidual: [east.rms, north.rms],
			confidence,
			source: this.#ephemerisAssisted ? 'ephemerisAssisted' : 'measured',
			stale,
		}
	}

	// Drops all observations and mode state so the next frame establishes a fresh fit.
	reset() {
		this.#samples.length = 0
		this.#ephemerisAssisted = undefined
		this.#lastTime = undefined
	}
}

// Converts `position` relative to fixed `anchor` into east/north radians at exposure midpoint `time`.
// `confidence` and `uncertainty` describe this observation; the result uses spherical log-map geometry.
export function trackingMotionSampleFromAstrometry(time: Time, anchor: EquatorialCoordinate, position: EquatorialCoordinate, confidence = 1, uncertainty?: readonly [Angle, Angle]): TrackingMotionSample {
	const offset = nonSiderealAngularOffset(anchor, position)
	return { time, offset: [offset.east, offset.north], uncertainty, confidence, source: 'targetAstrometry' }
}

// Pixel-to-sky transform supplied by WCS or current guider calibration, including rotation and parity.
export interface TrackingImageTransform {
	// Converts `delta` pixels (X right, Y down) at astronomical `time` to apparent tangent east/north radians.
	// The transform accounts for WCS/calibration, rotation, parity, sidereal frame convention, and flips.
	readonly pixelDeltaToSky: (delta: readonly [number, number], time: Time) => readonly [Angle, Angle] | undefined
}

// Converts `deltaPixels` from a fixed reference pixel position at `time` using `transform`.
// Confidence and optional one-sigma angular uncertainty are copied to the sample; invalid transforms return undefined.
export function trackingMotionSampleFromImage(time: Time, deltaPixels: readonly [number, number], transform: TrackingImageTransform, confidence = 1, uncertainty?: readonly [Angle, Angle]): TrackingMotionSample | undefined {
	const offset = transform.pixelDeltaToSky(deltaPixels, time)
	if (offset === undefined || !Number.isFinite(offset[0]) || !Number.isFinite(offset[1])) return undefined
	return { time, offset: [offset[0], offset[1]], uncertainty, confidence, source: 'targetImage' }
}

// A matched background star centroid in full-frame pixels.
export interface TrackingBackgroundStar {
	// Stable match identifier shared with the reference frame.
	readonly id: string
	// Full-frame X centroid in pixels, increasing right from the top-left image origin.
	readonly x: number
	// Full-frame Y centroid in pixels, increasing down from the top-left image origin.
	readonly y: number
}

// Estimates target motion opposite the median matched-star drift from fixed `reference` to `current`.
// `time` is the current frame's exposure midpoint and `transform` maps its pixels into apparent sky motion.
// At least three finite matched stars are required; missing matches or transform output returns undefined.
export function trackingMotionSampleFromBackgroundStars(time: Time, reference: readonly TrackingBackgroundStar[], current: readonly TrackingBackgroundStar[], transform: TrackingImageTransform): TrackingMotionSample | undefined {
	const minimumStars = 3
	if (reference.length < minimumStars || current.length < minimumStars) return undefined

	const referenceById = new Map<string, TrackingBackgroundStar>()
	for (const star of reference) referenceById.set(star.id, star)

	const dx: number[] = []
	const dy: number[] = []

	for (const star of current) {
		const previous = referenceById.get(star.id)

		if (previous !== undefined && Number.isFinite(star.x) && Number.isFinite(star.y) && Number.isFinite(previous.x) && Number.isFinite(previous.y)) {
			dx.push(star.x - previous.x)
			dy.push(star.y - previous.y)
		}
	}

	if (dx.length < minimumStars) return undefined

	const pixelDrift: readonly [number, number] = [medianBySelectionOf(dx), medianBySelectionOf(dy)]
	const skyDrift = transform.pixelDeltaToSky(pixelDrift, time)
	if (skyDrift === undefined || !Number.isFinite(skyDrift[0]) || !Number.isFinite(skyDrift[1])) return undefined
	return { time, offset: [-skyDrift[0], -skyDrift[1]], confidence: Math.min(1, dx.length / (minimumStars * 2)), source: 'backgroundStars' }
}

// Signed long-exposure streak evidence; direction remains undefined until temporal context resolves its axis.
export interface TrackingStreakMeasurement {
	// Signed or unsigned trail displacement vector in full-frame pixels; length carries angular travel magnitude.
	readonly axisPixels: readonly [number, number]
	// Exposure duration in seconds.
	readonly exposureSeconds: number
	// Whether the measured trail belongs to the moving target or to a background star.
	readonly role: 'target' | 'backgroundStar'
	// Direction along the measured axis; omitted for the inherently ambiguous single-image case.
	readonly direction?: -1 | 1
	// Relative confidence in [0, 1].
	readonly confidence?: number
}

// Converts the observed streak displacement into target east/north radians/second.
// Background-star drift is negated after the image transform; unsigned or invalid evidence returns undefined.
export function trackingRateFromStreak(time: Time, streak: TrackingStreakMeasurement, transform: TrackingImageTransform): TrackingRateEstimate | undefined {
	if (streak.direction === undefined || !(streak.exposureSeconds > 0) || !Number.isFinite(streak.exposureSeconds) || !Number.isFinite(streak.axisPixels[0]) || !Number.isFinite(streak.axisPixels[1])) return undefined
	if (streak.confidence !== undefined && !(streak.confidence >= 0 && streak.confidence <= 1)) return undefined

	const signed = [streak.axisPixels[0] * streak.direction, streak.axisPixels[1] * streak.direction] as const
	const sky = transform.pixelDeltaToSky(signed, time)
	if (sky === undefined || !Number.isFinite(sky[0]) || !Number.isFinite(sky[1])) return undefined

	const targetDirection = streak.role === 'target' ? 1 : -1
	const rate = [(targetDirection * sky[0]) / streak.exposureSeconds, (targetDirection * sky[1]) / streak.exposureSeconds] as const
	if (!Number.isFinite(rate[0]) || !Number.isFinite(rate[1])) return undefined

	return {
		time,
		rate,
		position: undefined,
		sampleCount: 1,
		span: streak.exposureSeconds,
		rmsResidual: [0, 0],
		confidence: streak.confidence ?? 0.25,
		source: 'measured',
		stale: false,
	}
}

interface FitSample {
	// Centered, normalized time in the least-squares system.
	readonly x: number
	// Tangent coordinate observation in radians.
	readonly value: number
	// Confidence and optional inverse-variance weight.
	readonly weight: number
}

// Fits `axis` around `center` in scaled TT seconds. Optional `quadratic` adds acceleration; `threshold` is radians.
function fitAxis(samples: readonly StoredSample[], axis: 0 | 1, center: Time, scale: number, quadratic: boolean, threshold: number): AxisFit | undefined {
	const count = quadratic ? 3 : 2
	let uncertaintyScale = Infinity

	for (const sample of samples) {
		const uncertainty = sample.uncertainty?.[axis]
		if (uncertainty !== undefined) uncertaintyScale = Math.min(uncertaintyScale, uncertainty)
	}

	const points: FitSample[] = samples.map((sample) => {
		const sigma = sample.uncertainty?.[axis]
		const relativeUncertainty = sigma === undefined ? 1 : uncertaintyScale / sigma
		return { x: (timeSubtract(sample.time, center, Timescale.TT) * DAYSEC) / scale, value: sample.offset[axis], weight: sample.confidence * relativeUncertainty * relativeUncertainty }
	})

	const robust = new Float64Array(points.length).fill(1)
	let coefficients = [0, 0, 0] as [number, number, number]
	let hasFit = false

	if (!quadratic) {
		const slopes: number[] = []

		for (let i = 0; i < points.length; i++) {
			const a = points[i]

			if (a === undefined) continue

			for (let j = i + 1; j < points.length; j++) {
				const b = points[j]
				if (b !== undefined && b.x !== a.x) slopes.push((b.value - a.value) / (b.x - a.x))
			}
		}

		coefficients[1] = medianBySelectionOf(slopes)
		coefficients[0] = medianBySelectionOf(points.map((point) => point.value - coefficients[1] * point.x))
		hasFit = slopes.length > 0

		for (let i = 0; i < points.length; i++) {
			const point = points[i]
			if (point === undefined) continue
			const residual = Math.abs(point.value - coefficients[0] - coefficients[1] * point.x)
			robust[i] = robustWeight(residual, threshold)
		}
	} else {
		const seed = robustQuadraticSeed(points, threshold)

		if (seed !== undefined) {
			coefficients = seed
			hasFit = true

			for (let i = 0; i < points.length; i++) {
				const point = points[i]
				if (point === undefined) continue
				const residual = Math.abs(point.value - coefficients[0] - coefficients[1] * point.x - coefficients[2] * point.x * point.x)
				robust[i] = robustWeight(residual, threshold)
			}
		}
	}
	for (let iteration = 0; iteration < 5; iteration++) {
		const normal = Array.from({ length: count }, () => new Float64Array(count + 1))

		for (let i = 0; i < points.length; i++) {
			const point = points[i]
			if (point === undefined) continue
			const weight = point.weight * (robust[i] ?? 1)
			const row = quadratic ? [1, point.x, point.x * point.x] : [1, point.x]

			for (let r = 0; r < count; r++) {
				const basisR = row[r] ?? 0
				for (let c = 0; c < count; c++) normal[r][c] += weight * basisR * (row[c] ?? 0)
				normal[r][count] += weight * basisR * point.value
			}
		}

		const solved = solveSmallSystem(normal, count)
		if (solved === undefined) {
			if (!hasFit) return undefined
			break
		}

		hasFit = true
		coefficients = [solved[0] ?? 0, solved[1] ?? 0, solved[2] ?? 0]

		for (let i = 0; i < points.length; i++) {
			const point = points[i]
			if (point === undefined) continue
			const predicted = coefficients[0] + coefficients[1] * point.x + (quadratic ? coefficients[2] * point.x * point.x : 0)
			const residual = Math.abs(point.value - predicted)
			robust[i] = robustWeight(residual, threshold)
		}
	}

	let squareError = 0
	let clippedSquareError = 0
	let totalWeight = 0
	let modelWeight = 0
	let inlierWeight = 0

	for (let i = 0; i < points.length; i++) {
		const point = points[i]
		if (point === undefined) continue
		const predicted = coefficients[0] + coefficients[1] * point.x + (quadratic ? coefficients[2] * point.x * point.x : 0)
		const residual = point.value - predicted
		const robustWeight = point.weight * (robust[i] ?? 1)
		squareError += residual * residual * robustWeight
		clippedSquareError += Math.min(residual * residual, threshold * threshold) * point.weight
		totalWeight += point.weight
		modelWeight += point.weight
		inlierWeight += robustWeight
	}

	const rms = Math.sqrt(squareError / Math.max(Number.EPSILON, inlierWeight))
	const modelRms = Math.sqrt(clippedSquareError / Math.max(Number.EPSILON, modelWeight))
	return { coefficients, rms, modelRms, confidence: totalWeight === 0 ? 0 : inlierWeight / totalWeight }
}

// Gives no support to residuals outside the configured outlier threshold and smoothly tapers inliers.
function robustWeight(residual: number, threshold: number): number {
	if (residual === 0) return 1
	if (!(threshold > 0)) return 0
	const ratio = residual / threshold
	if (ratio >= 1) return 0
	const remaining = 1 - ratio * ratio
	return remaining * remaining
}

// Seeds quadratic IRLS with the three-point polynomial having the most inlier support.
function robustQuadraticSeed(points: readonly FitSample[], threshold: number): [number, number, number] | undefined {
	let best: [number, number, number] | undefined
	let bestInliers = 0
	let bestError = Infinity
	const representatives = Math.min(points.length, 12)

	for (let i = 0; i < representatives - 2; i++) {
		const a = points[Math.round((i * (points.length - 1)) / (representatives - 1))]
		if (a === undefined) continue

		for (let j = i + 1; j < representatives - 1; j++) {
			const b = points[Math.round((j * (points.length - 1)) / (representatives - 1))]
			if (b === undefined) continue

			for (let k = j + 1; k < representatives; k++) {
				const c = points[Math.round((k * (points.length - 1)) / (representatives - 1))]
				if (c === undefined) continue
				const ab = (b.value - a.value) / (b.x - a.x)
				const ac = (c.value - a.value) / (c.x - a.x)
				const quadratic = (ac - ab) / (c.x - b.x)
				const linear = ab - quadratic * (a.x + b.x)
				const intercept = a.value - linear * a.x - quadratic * a.x * a.x
				let inliers = 0
				let clippedError = 0
				for (const point of points) {
					const residual = Math.abs(point.value - intercept - linear * point.x - quadratic * point.x * point.x)
					if (residual <= threshold) inliers++
					clippedError += Math.min(residual * residual, threshold * threshold)
				}
				if (inliers > bestInliers || (inliers === bestInliers && clippedError < bestError)) {
					best = [intercept, linear, quadratic]
					bestInliers = inliers
					bestError = clippedError
				}
			}
		}
	}

	return best
}

// Solves a fixed two- or three-variable linear system with pivoting.
function solveSmallSystem(matrix: Float64Array[], size: number): number[] | undefined {
	for (let column = 0; column < size; column++) {
		let pivot = column
		for (let row = column + 1; row < size; row++) if (Math.abs(matrix[row][column]) > Math.abs(matrix[pivot][column])) pivot = row
		if (Math.abs(matrix[pivot][column]) <= Number.EPSILON) return undefined
		if (pivot !== column) [matrix[pivot], matrix[column]] = [matrix[column], matrix[pivot]]
		const divisor = matrix[column][column]
		for (let j = column; j <= size; j++) matrix[column][j] /= divisor
		for (let row = 0; row < size; row++) {
			if (row === column) continue
			const factor = matrix[row][column]
			for (let j = column; j <= size; j++) matrix[row][j] -= factor * matrix[column][j]
		}
	}

	return Array.from({ length: size }, (_, i) => matrix[i][size])
}
