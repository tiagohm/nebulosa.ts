import { medianAbsoluteDeviationOf, medianBySelectionOf } from '../../../core/util'
import type { Rect } from '../../../math/numerical/geometry'
import { resolveImagePlaneGeometry, resolveLocalCfaPattern } from '../plane'
import { ROBUST_SAMPLE_CAPACITY, RobustReservoir } from '../robust'
import { hasIncompleteFlatHeaderCfaOffset, resolveFlatAcquisitionMetadata, resolveFlatContextCfaOffset, resolveFlatFrameExposure } from './context'
import { analyzeFlat } from './flat'
import type { FlatAnalysis, FlatCheck, FlatDiagnostic, FlatDiagnosticCode, FlatFrame, FlatPlane, FlatSequenceAnalysis, FlatSequenceAssessment, FlatSequenceFrameAnalysis, FlatSequenceInput, FlatSequenceOptions, FlatSequencePlaneAnalysis, FlatSignature, FlatSpatialAnalysis, FlatTile } from './types'

// Temporal analysis for final flat stacks. Every frame is first reduced by the single-frame path with
// maps disabled; only normalized tile and axis signatures survive, so memory grows with frames times
// reduced signature size rather than frames times image size.

// Numerical equality tolerance used when no exposure compatibility tolerance is configured, seconds.
const DEFAULT_SEQUENCE_EXPOSURE_TOLERANCE = 1e-9

// Maximum number of distinct lags used by the bounded robust trend estimator.
const MAXIMUM_TREND_LAGS = 64

// Float32-scale floor used only when a zero-MAD multivariate score needs to distinguish an outlier.
const OUTLIER_SCORE_FLOOR = 1e-7

// One canonical tile coordinate shared across per-frame normalized signatures.
interface CanonicalTile {
	// Stable rectangle key.
	readonly key: string
	// Inclusive-exclusive tile area in image pixels.
	readonly area: Readonly<Rect>
}

// Compatibility evidence that cannot be represented by the image layout alone.
interface SequenceCompatibility {
	// True when at least one required acquisition field was unavailable.
	readonly metadataUnknown: boolean
}

// Robust line used for normalized drift and signal-residual outlier scoring.
interface RobustTrend {
	// Signal change per x unit, in digital numbers.
	readonly slope: number
	// Robust signal at x zero, in digital numbers.
	readonly intercept: number
}

// Public plane metrics plus whether a configured outlier classifier had complete evidence.
interface SequencePlaneResult {
	// Public temporal measurements.
	readonly analysis: FlatSequencePlaneAnalysis
	// True when every frame supplied finite aligned multivariate features.
	readonly outlierEvidenceComplete: boolean
}

// Outlier indices plus completeness of the classifier's evidence.
interface OutlierResult {
	// Zero-based discrepant frame indices.
	readonly frames: readonly number[]
	// True when every required signal and vector coordinate was finite and aligned.
	readonly complete: boolean
}

// Analyzes temporal stability of three or more nominally homogeneous final flat frames.
export function analyzeFlatSequence(input: FlatSequenceInput, options: Partial<FlatSequenceOptions> = {}): FlatSequenceAnalysis {
	validateSequenceOptions(input, options)
	const compatibility = validateSequenceCompatibility(input.frames, options)
	const diagnostics: FlatDiagnostic[] = []
	if (compatibility.metadataUnknown) diagnostics.push({ severity: 'warning', code: 'sequenceMetadataUnknown', message: 'Missing acquisition metadata prevents a complete proof that every flat frame is homogeneous.' })

	const analysisOptions = { ...options.analysis, maps: 'none' } as const
	const analyses = input.frames.map((frame, frameIndex) => {
		const analysis = analyzeFlat({ frame, reference: input.reference, mask: input.mask }, analysisOptions)
		for (const diagnostic of analysis.diagnostics) diagnostics.push({ ...diagnostic, frame: frameIndex })
		return analysis
	})

	const timestamps = resolveSequenceTimes(input.frames)
	if (!timestamps) {
		diagnostics.push({ severity: 'warning', code: 'sequenceMetadataUnknown', message: 'Per-second drift is unavailable because timestamps are missing or not strictly increasing.' })
	}

	const planeAnalyses: FlatSequencePlaneAnalysis[] = []
	const outlierFrames = new Set<number>()
	let outlierEvidenceComplete = true
	for (let planeIndex = 0; planeIndex < analyses[0].planes.length; planeIndex++) {
		const result = analyzeSequencePlane(input, analyses, planeIndex, timestamps, options)
		planeAnalyses.push(result.analysis)
		outlierEvidenceComplete &&= result.outlierEvidenceComplete
		for (const frame of result.analysis.outliers) {
			outlierFrames.add(frame)
			diagnostics.push({ severity: 'warning', code: 'sequenceOutlier', message: 'The frame has a multivariate signal or spatial signature inconsistent with the sequence.', plane: result.analysis.plane, frame })
		}
		if (options.outlierSigma !== undefined && !result.outlierEvidenceComplete) diagnostics.push({ severity: 'warning', code: 'insufficientSamples', message: 'The configured outlier classifier lacks complete finite aligned signatures.', plane: result.analysis.plane })
		appendSequencePlaneDiagnostics(diagnostics, result.analysis, options)
	}

	const assessment = assessSequence(analyses, planeAnalyses, compatibility, timestamps !== undefined, outlierFrames, outlierEvidenceComplete, options, diagnostics)
	const frames = input.frames.map((frame, index) => sequenceFrameResult(frame, index, analyses[index], assessment, compatibility, outlierFrames.has(index), outlierEvidenceComplete, options))
	return { frames, planes: planeAnalyses, assessment, diagnostics }
}

// Validates sequence size and finite non-negative policy limits before any image traversal.
function validateSequenceOptions(input: FlatSequenceInput, options: Partial<FlatSequenceOptions>): void {
	if (input.frames.length < 3) throw new RangeError('flat sequence analysis requires at least three frames')
	if (options.analysis && 'maps' in options.analysis) throw new RangeError('flat sequence analysis does not accept full-resolution map options')
	for (const [name, value] of [
		['exposure tolerance', options.exposureTolerance],
		['temperature tolerance', options.temperatureTolerance],
		['maximum signal variation', options.maximumSignalVariation],
		['maximum spatial variation', options.maximumSpatialVariation],
		['maximum profile variation', options.maximumProfileVariation],
		['maximum drift per frame', options.maximumDriftPerFrame],
		['maximum drift per second', options.maximumDriftPerSecond],
	] as const) {
		if (value !== undefined && (!Number.isFinite(value) || value < 0)) throw new RangeError(`flat sequence ${name} must be finite and non-negative`)
	}
	if (options.outlierSigma !== undefined && (!Number.isFinite(options.outlierSigma) || options.outlierSigma <= 0)) throw new RangeError('flat sequence outlier sigma must be finite and positive')
}

// Enforces every known homogeneity field and records unavailable evidence without inventing equality.
function validateSequenceCompatibility(frames: readonly FlatFrame[], options: Partial<FlatSequenceOptions>): SequenceCompatibility {
	const first = frames[0]
	const firstImage = first.image
	const firstCfaOffset = resolveFlatContextCfaOffset(first)
	const firstPattern = resolveLocalCfaPattern(firstImage, firstCfaOffset)
	const exposureTolerance = options.exposureTolerance ?? DEFAULT_SEQUENCE_EXPOSURE_TOLERANCE
	let metadataUnknown = frames.some(hasIncompleteFlatHeaderCfaOffset)

	for (let index = 1; index < frames.length; index++) {
		const frame = frames[index]
		const image = frame.image
		if (image.metadata.width !== firstImage.metadata.width || image.metadata.height !== firstImage.metadata.height || image.metadata.channels !== firstImage.metadata.channels) throw new RangeError(`flat sequence frame ${index} geometry and channels must match the first frame`)
		const pattern = resolveLocalCfaPattern(image, resolveFlatContextCfaOffset(frame))
		if (pattern !== firstPattern) throw new RangeError(`flat sequence frame ${index} local CFA pattern must match the first frame`)
	}

	const metadata = frames.map(resolveFlatAcquisitionMetadata)
	metadataUnknown =
		validateOptionalTupleCompatibility(
			frames.map((frame) => frame.image.digitalRange),
			'flat sequence digital ranges must match when known',
		) || metadataUnknown
	metadataUnknown =
		validateOptionalNumericCompatibility(
			frames.map((frame) => frame.image.quantizationStep),
			0,
			'flat sequence quantization steps must match when known',
		) || metadataUnknown
	metadataUnknown = validateOptionalNumericCompatibility(frames.map(resolveFlatFrameExposure), exposureTolerance, 'flat sequence exposures must match within tolerance when known') || metadataUnknown
	metadataUnknown =
		validateOptionalNumericCompatibility(
			metadata.map((value) => value.gain),
			0,
			'flat sequence gains must match when known',
		) || metadataUnknown
	metadataUnknown =
		validateOptionalNumericCompatibility(
			metadata.map((value) => value.offset),
			0,
			'flat sequence offsets must match when known',
		) || metadataUnknown
	metadataUnknown =
		validateOptionalStringCompatibility(
			metadata.map((value) => value.readoutMode),
			'flat sequence readout modes must match when known',
		) || metadataUnknown
	metadataUnknown =
		validateOptionalTupleCompatibility(
			metadata.map((value) => value.binning),
			'flat sequence binning must match when known',
		) || metadataUnknown
	metadataUnknown =
		validateOptionalTupleCompatibility(
			metadata.map((value) => value.sensorOrigin),
			'flat sequence sensor origins must match when known',
		) || metadataUnknown
	metadataUnknown = validateOptionalStringCompatibility(frames.map(resolveFrameFilter), 'flat sequence filters must match when known') || metadataUnknown
	metadataUnknown =
		validateOptionalStringCompatibility(
			frames.map((frame) => frame.illumination?.source),
			'flat sequence illumination sources must match when known',
		) || metadataUnknown
	metadataUnknown =
		validateOptionalNumericCompatibility(
			frames.map((frame) => frame.illumination?.brightness),
			0,
			'flat sequence illumination brightness settings must match when known',
		) || metadataUnknown
	if (options.temperatureTolerance !== undefined) {
		let minimum = Number.POSITIVE_INFINITY
		let maximum = Number.NEGATIVE_INFINITY
		for (const value of metadata) {
			const temperature = value.temperature
			if (temperature === undefined) {
				metadataUnknown = true
				continue
			}
			minimum = Math.min(minimum, temperature)
			maximum = Math.max(maximum, temperature)
		}
		if (maximum - minimum > options.temperatureTolerance) throw new RangeError('flat sequence temperature spread exceeds the configured tolerance')
	}

	return { metadataUnknown }
}

// Compares every known numeric value and returns true when at least one frame lacks the field.
function validateOptionalNumericCompatibility(values: readonly (number | undefined)[], tolerance: number, mismatchMessage: string): boolean {
	const known = values.find((value) => value !== undefined)
	if (known !== undefined) for (const value of values) if (value !== undefined && Math.abs(value - known) > tolerance) throw new RangeError(mismatchMessage)
	return values.some((value) => value === undefined)
}

// Compares every known string value and returns true when at least one frame lacks the field.
function validateOptionalStringCompatibility(values: readonly (string | undefined)[], mismatchMessage: string): boolean {
	const known = values.find((value) => value !== undefined)
	if (known !== undefined) for (const value of values) if (value !== undefined && value !== known) throw new RangeError(mismatchMessage)
	return values.some((value) => value === undefined)
}

// Compares every known two-number tuple and returns true when at least one frame lacks the field.
function validateOptionalTupleCompatibility(values: readonly (readonly [number, number] | undefined)[], mismatchMessage: string): boolean {
	const known = values.find((value) => value !== undefined)
	if (known !== undefined) for (const value of values) if (value !== undefined && (value[0] !== known[0] || value[1] !== known[1])) throw new RangeError(mismatchMessage)
	return values.some((value) => value === undefined)
}

// Resolves an explicit filter first and then a non-empty FITS FILTER value.
function resolveFrameFilter(frame: FlatFrame): string | undefined {
	if (frame.filter !== undefined) return frame.filter
	const filter = frame.image.header.FILTER
	return typeof filter === 'string' && filter.length > 0 ? filter : undefined
}

// Returns elapsed seconds from the first frame only when every timestamp is finite and increasing.
function resolveSequenceTimes(frames: readonly FlatFrame[]): Float64Array | undefined {
	const first = frames[0].timestamp
	if (first === undefined || !Number.isFinite(first)) return undefined
	const times = new Float64Array(frames.length)
	for (let index = 1; index < frames.length; index++) {
		const timestamp = frames[index].timestamp
		if (timestamp === undefined || !Number.isFinite(timestamp) || timestamp <= frames[index - 1].timestamp!) return undefined
		const elapsed = (timestamp - first) / 1000
		if (!Number.isFinite(elapsed)) return undefined
		times[index] = elapsed
	}
	return times
}

// Builds reduced signatures and derives robust temporal metrics for one plane index.
function analyzeSequencePlane(input: FlatSequenceInput, analyses: readonly FlatAnalysis[], planeIndex: number, timestamps: Float64Array | undefined, options: Partial<FlatSequenceOptions>): SequencePlaneResult {
	const plane = analyses[0].planes[planeIndex].plane
	const basis = input.reference ? 'corrected' : 'observed'
	const canonicalTiles = collectCanonicalTiles(analyses, planeIndex)
	const tileIndices = new Map(canonicalTiles.map((tile, index) => [tile.key, index]))
	const signatures: Array<FlatSignature | undefined> = new Array(analyses.length)
	const availableSignals: number[] = []
	let completeSignals = true

	for (let frameIndex = 0; frameIndex < analyses.length; frameIndex++) {
		const framePlane = analyses[frameIndex].planes[planeIndex]
		const statistics = basis === 'corrected' ? framePlane.corrected : framePlane.observed
		const signal = statistics?.median
		if (signal === undefined || !Number.isFinite(signal) || signal <= 0) {
			completeSignals = false
			continue
		}
		availableSignals.push(signal)
		const tiles = normalizedTileSignature(framePlane.spatial, signal, tileIndices, canonicalTiles.length)
		const profiles = measureNormalizedProfiles(input.frames[frameIndex], input.reference, input.mask, analyses[frameIndex].area, plane, signal)
		signatures[frameIndex] = { signal, tiles, rowProfile: profiles.row, columnProfile: profiles.column }
	}

	const medianSignal = availableSignals.length > 0 ? medianBySelectionOf(availableSignals) : undefined
	const signalVariation = finiteMetric(completeSignals && medianSignal !== undefined && medianSignal !== 0 ? medianAbsoluteDeviationOf(availableSignals, medianSignal, true) / Math.abs(medianSignal) : undefined)
	const indexCoordinates = Float64Array.from({ length: analyses.length }, (_, index) => index)
	const signalValues = completeSignals ? Float64Array.from(signatures.map((signature) => signature!.signal)) : undefined
	const indexTrend = signalValues ? robustTrend(indexCoordinates, signalValues) : undefined
	const timeTrend = signalValues && timestamps ? robustTrend(timestamps, signalValues) : undefined
	const driftPerFrame = finiteMetric(indexTrend && medianSignal !== undefined && medianSignal !== 0 ? indexTrend.slope / medianSignal : undefined)
	const driftPerSecond = finiteMetric(timeTrend && medianSignal !== undefined && medianSignal !== 0 ? timeTrend.slope / medianSignal : undefined)
	const spatialVariation = temporalVectorVariation(signatures, (signature) => signature.tiles)
	const rowVariation = temporalVectorVariation(signatures, (signature) => signature.rowProfile)
	const columnVariation = temporalVectorVariation(signatures, (signature) => signature.columnProfile)
	const outlierResult = options.outlierSigma === undefined ? { frames: [], complete: true } : multivariateOutliers(signatures, options.outlierSigma)

	return {
		analysis: { plane, basis, medianSignal, signalVariation, spatialVariation, rowVariation, columnVariation, driftPerFrame, driftPerSecond, outliers: outlierResult.frames },
		outlierEvidenceComplete: outlierResult.complete,
	}
}

// Collects the union of supported tile rectangles and sorts it in stable row-major order.
function collectCanonicalTiles(analyses: readonly FlatAnalysis[], planeIndex: number): CanonicalTile[] {
	const unique = new Map<string, Readonly<Rect>>()
	for (const analysis of analyses) {
		for (const tile of analysis.planes[planeIndex].spatial.tiles) unique.set(tileKey(tile), tile.area)
	}
	return Array.from(unique, ([key, area]) => ({ key, area })).sort((first, second) => first.area.top - second.area.top || first.area.left - second.area.left || first.area.bottom - second.area.bottom || first.area.right - second.area.right)
}

// Encodes one inclusive-exclusive tile rectangle without depending on object identity.
function tileKey(tile: Pick<FlatTile, 'area'>): string {
	return `${tile.area.left},${tile.area.top},${tile.area.right},${tile.area.bottom}`
}

// Returns normalized tile levels in canonical order, using NaN for unavailable frame support.
function normalizedTileSignature(spatial: FlatSpatialAnalysis, signal: number, tileIndices: ReadonlyMap<string, number>, length: number): Float32Array {
	const values = new Float32Array(length)
	values.fill(Number.NaN)
	for (const tile of spatial.tiles) {
		const statistics = spatial.basis === 'corrected' ? tile.corrected : tile.observed
		const level = statistics?.median
		const index = tileIndices.get(tileKey(tile))
		if (index === undefined || level === undefined) continue
		const normalized = Math.fround(level / signal)
		if (Number.isFinite(normalized)) values[index] = normalized
	}
	return values
}

// Measures normalized row and column means directly from one selected plane without an image buffer.
function measureNormalizedProfiles(frame: FlatFrame, reference: FlatSequenceInput['reference'], mask: Readonly<Uint8Array> | undefined, area: Readonly<Rect>, plane: FlatPlane, signal: number): { readonly row: Float32Array; readonly column: Float32Array } {
	const cfaOffset = resolveFlatContextCfaOffset(frame)
	const geometry = resolveImagePlaneGeometry(frame.image, area, plane, cfaOffset)
	const referenceGeometry = reference ? resolveImagePlaneGeometry(reference.image, area, plane, resolveFlatContextCfaOffset(reference)) : undefined
	const rowSums = new Float64Array(geometry.height)
	const columnSums = new Float64Array(geometry.width)
	const rowCounts = new Uint32Array(geometry.height)
	const columnCounts = new Uint32Array(geometry.width)

	for (let planeY = 0; planeY < geometry.height; planeY++) {
		const sourceY = geometry.sourceTop + planeY * geometry.step
		let rawIndex = geometry.rawStart + planeY * geometry.rawRowStep
		let referenceIndex = referenceGeometry ? referenceGeometry.rawStart + planeY * referenceGeometry.rawRowStep : 0
		let maskIndex = sourceY * frame.image.metadata.width + geometry.sourceLeft
		for (let planeX = 0; planeX < geometry.width; planeX++, rawIndex += geometry.rawColumnStep, maskIndex += geometry.step) {
			if (!mask?.[maskIndex]) {
				const observed = frame.image.raw[rawIndex]
				const sample = referenceGeometry ? observed - reference!.image.raw[referenceIndex] : observed
				const normalized = sample / signal - 1
				if (Number.isFinite(normalized)) {
					rowSums[planeY] += normalized
					columnSums[planeX] += normalized
					rowCounts[planeY]++
					columnCounts[planeX]++
				}
			}
			if (referenceGeometry) referenceIndex += referenceGeometry.rawColumnStep
		}
	}

	const row = new Float32Array(geometry.height)
	const column = new Float32Array(geometry.width)
	for (let index = 0; index < row.length; index++) row[index] = rowCounts[index] > 0 ? Math.fround(rowSums[index] / rowCounts[index]) : Number.NaN
	for (let index = 0; index < column.length; index++) column[index] = columnCounts[index] > 0 ? Math.fround(columnSums[index] / columnCounts[index]) : Number.NaN
	return { row, column }
}

// Computes the worst scaled-MAD temporal dispersion among every complete vector coordinate.
function temporalVectorVariation(signatures: readonly (FlatSignature | undefined)[], select: (signature: FlatSignature) => Float32Array): number | undefined {
	for (let index = 0; index < signatures.length; index++) if (signatures[index] === undefined) return undefined

	const first = select(signatures[0]!)
	if (first.length === 0) return undefined

	const values = new Array<number>(signatures.length)

	let worst = 0
	for (let coordinate = 0; coordinate < first.length; coordinate++) {
		for (let frame = 0; frame < signatures.length; frame++) {
			const vector = select(signatures[frame]!)
			if (vector.length !== first.length || !Number.isFinite(vector[coordinate])) return undefined
			values[frame] = vector[coordinate]
		}

		worst = Math.max(worst, medianAbsoluteDeviationOf(values, medianBySelectionOf(values), true))
	}

	return worst
}

// Finds frames whose combined detrended signal, tile, row, and column distance is a robust outlier.
function multivariateOutliers(signatures: readonly (FlatSignature | undefined)[], sigma: number): OutlierResult {
	for (let index = 0; index < signatures.length; index++) if (signatures[index] === undefined) return { frames: [], complete: false }
	const resolved = signatures as readonly FlatSignature[]
	const signals = Float64Array.from(resolved, (signature) => signature.signal)
	const coordinates = Float64Array.from({ length: resolved.length }, (_, index) => index)
	const trend = robustTrend(coordinates, signals)
	const signalCenter = medianBySelectionOf(signals)
	const tileCenter = temporalVectorCenter(resolved, (signature) => signature.tiles)
	const rowCenter = temporalVectorCenter(resolved, (signature) => signature.rowProfile)
	const columnCenter = temporalVectorCenter(resolved, (signature) => signature.columnProfile)
	if (!trend || signalCenter === undefined || signalCenter === 0 || !tileCenter || !rowCenter || !columnCenter) return { frames: [], complete: false }

	const scores = new Array<number>(resolved.length)
	for (let frame = 0; frame < resolved.length; frame++) {
		let squared = ((resolved[frame].signal - (trend.intercept + trend.slope * frame)) / signalCenter) ** 2
		let count = 1

		for (const [vector, center] of [
			[resolved[frame].tiles, tileCenter],
			[resolved[frame].rowProfile, rowCenter],
			[resolved[frame].columnProfile, columnCenter],
		] as const) {
			const distance = center ? vectorRmsDistance(vector, center) : undefined
			if (distance === undefined) continue
			squared += distance * distance
			count++
		}

		scores[frame] = Math.sqrt(squared / count)
	}

	const center = medianBySelectionOf(Float64Array.from(scores))
	if (center === undefined) return { frames: [], complete: false }
	const scale = medianAbsoluteDeviationOf(scores, center, true)
	const threshold = center + sigma * Math.max(scale, OUTLIER_SCORE_FLOOR)
	const outliers: number[] = []
	for (let frame = 0; frame < scores.length; frame++) if (scores[frame] > threshold) outliers.push(frame)
	return { frames: outliers, complete: true }
}

// Computes a coordinate-wise robust center only for complete equal-length finite vectors.
function temporalVectorCenter(signatures: readonly FlatSignature[], select: (signature: FlatSignature) => Float32Array): Float64Array | undefined {
	const first = select(signatures[0])

	if (first.length === 0) return undefined

	const center = new Float64Array(first.length)
	const values = new Array<number>(signatures.length)

	for (let coordinate = 0; coordinate < first.length; coordinate++) {
		for (let frame = 0; frame < signatures.length; frame++) {
			const vector = select(signatures[frame])
			if (vector.length !== first.length || !Number.isFinite(vector[coordinate])) return undefined
			values[frame] = vector[coordinate]
		}

		center[coordinate] = medianBySelectionOf(values)
	}

	return center
}

// Returns the root-mean-square distance between one finite vector and its coordinate-wise center.
function vectorRmsDistance(vector: Float32Array, center: Float64Array): number | undefined {
	if (vector.length !== center.length || vector.length === 0) return undefined

	let sum = 0

	for (let index = 0; index < vector.length; index++) {
		if (!Number.isFinite(vector[index]) || !Number.isFinite(center[index])) return undefined
		const difference = vector[index] - center[index]
		sum += difference * difference
	}

	return Math.sqrt(sum / vector.length)
}

// Fits a bounded approximate Theil-Sen line using all lags for small stacks and sampled lags for large ones.
function robustTrend(x: Float64Array, y: Float64Array): RobustTrend | undefined {
	if (x.length !== y.length || x.length < 2) return undefined
	const lagCount = Math.min(x.length - 1, MAXIMUM_TREND_LAGS)
	const maximumPairs = Math.min(ROBUST_SAMPLE_CAPACITY, lagCount * x.length)
	const slopes = new RobustReservoir(maximumPairs)
	let previousLag = 0

	for (let lagIndex = 0; lagIndex < lagCount; lagIndex++) {
		const lag = lagCount === x.length - 1 ? lagIndex + 1 : 1 + Math.floor((lagIndex * (x.length - 2)) / Math.max(1, lagCount - 1))
		if (lag === previousLag) continue
		previousLag = lag

		for (let first = 0; first + lag < x.length; first++) {
			const second = first + lag
			const span = x[second] - x[first]
			if (span !== 0 && Number.isFinite(span)) slopes.push((y[second] - y[first]) / span)
		}
	}

	const slope = slopes.median()
	if (!Number.isFinite(slope)) return undefined
	const intercepts = new RobustReservoir(x.length)
	for (let index = 0; index < x.length; index++) intercepts.push(y[index] - slope * x[index])
	const intercept = intercepts.median()
	return Number.isFinite(intercept) ? { slope, intercept } : undefined
}

// Adds threshold exceedance and missing-evidence diagnostics for one sequence plane.
function appendSequencePlaneDiagnostics(diagnostics: FlatDiagnostic[], plane: FlatSequencePlaneAnalysis, options: Partial<FlatSequenceOptions>): void {
	appendMetricDiagnostic(diagnostics, plane.plane, plane.signalVariation, options.maximumSignalVariation, 'sequenceVariation', 'Robust signal variation exceeds its configured limit.')
	appendMetricDiagnostic(diagnostics, plane.plane, plane.spatialVariation, options.maximumSpatialVariation, 'sequenceVariation', 'Normalized tile variation exceeds its configured limit.')
	appendMetricDiagnostic(diagnostics, plane.plane, plane.rowVariation, options.maximumProfileVariation, 'sequenceVariation', 'Normalized row-profile variation exceeds its configured limit.')
	appendMetricDiagnostic(diagnostics, plane.plane, plane.columnVariation, options.maximumProfileVariation, 'sequenceVariation', 'Normalized column-profile variation exceeds its configured limit.')
	appendMetricDiagnostic(diagnostics, plane.plane, absolute(plane.driftPerFrame), options.maximumDriftPerFrame, 'sequenceDrift', 'Absolute signal drift per frame exceeds its configured limit.')
	appendMetricDiagnostic(diagnostics, plane.plane, absolute(plane.driftPerSecond), options.maximumDriftPerSecond, 'sequenceDrift', 'Absolute signal drift per second exceeds its configured limit.')
}

// Emits one failure or unavailable-evidence diagnostic for an explicitly configured metric.
function appendMetricDiagnostic(diagnostics: FlatDiagnostic[], plane: FlatPlane, value: number | undefined, limit: number | undefined, code: 'sequenceVariation' | 'sequenceDrift', message: string): void {
	if (limit === undefined) return
	if (value === undefined || !Number.isFinite(value)) diagnostics.push({ severity: 'warning', code: 'insufficientSamples', message: 'The configured sequence metric lacks complete finite signature support.', plane, limit })
	else if (value > limit) diagnostics.push({ severity: 'warning', code, message, plane, value, limit })
}

// Returns an absolute finite metric while preserving unavailable evidence.
function absolute(value: number | undefined): number | undefined {
	return value === undefined ? undefined : Math.abs(value)
}

// Preserves only finite public metrics, converting arithmetic overflow into unavailable evidence.
function finiteMetric(value: number | undefined): number | undefined {
	return value !== undefined && Number.isFinite(value) ? value : undefined
}

// Derives aggregate checks and a transparent verdict from only configured temporal policies.
function assessSequence(
	analyses: readonly FlatAnalysis[],
	planes: readonly FlatSequencePlaneAnalysis[],
	compatibility: SequenceCompatibility,
	timestampsAvailable: boolean,
	outliers: ReadonlySet<number>,
	outlierEvidenceComplete: boolean,
	options: Partial<FlatSequenceOptions>,
	diagnostics: readonly FlatDiagnostic[],
): FlatSequenceAssessment {
	const frameCriteria = hasFrameCriteria(options)
	const frameQuality = assessFrameQuality(analyses, compatibility.metadataUnknown, outliers, outlierEvidenceComplete, frameCriteria, options.outlierSigma !== undefined)
	const signalStability = assessSignalStability(planes, timestampsAvailable, options)
	const spatialStability = assessMetric(
		planes.map((plane) => plane.spatialVariation),
		options.maximumSpatialVariation,
	)
	const profileStability = assessMetric(
		planes.flatMap((plane) => [plane.rowVariation, plane.columnVariation]),
		options.maximumProfileVariation,
	)
	const required: FlatCheck[] = []
	if (frameCriteria || options.outlierSigma !== undefined || compatibility.metadataUnknown) required.push(frameQuality)
	if (signalCriteriaConfigured(options)) required.push(signalStability)
	if (options.maximumSpatialVariation !== undefined) required.push(spatialStability)
	if (options.maximumProfileVariation !== undefined) required.push(profileStability)
	const verdict = required.some((check) => check.status === 'fail') ? 'rejected' : required.length === 0 || required.some((check) => check.status === 'unknown') ? 'inconclusive' : 'accepted'
	const reasons = sequenceAssessmentReasons(frameQuality, signalStability, spatialStability, profileStability, diagnostics, compatibility, timestampsAvailable, options)
	return { verdict, frameQuality, signalStability, spatialStability, profileStability, reasons }
}

// Reports whether single-frame target, clipping, or finitude policy was explicitly configured.
function hasFrameCriteria(options: Partial<FlatSequenceOptions>): boolean {
	const criteria = options.analysis?.criteria
	return criteria !== undefined && ((criteria.targets !== undefined && Object.keys(criteria.targets).length > 0) || criteria.maximumClippedFraction !== undefined || criteria.maximumNonFiniteFraction !== undefined)
}

// Reports whether any signal variation or drift criterion participates in the verdict.
function signalCriteriaConfigured(options: Partial<FlatSequenceOptions>): boolean {
	return options.maximumSignalVariation !== undefined || options.maximumDriftPerFrame !== undefined || options.maximumDriftPerSecond !== undefined
}

// Aggregates configured single-frame checks and explicit outlier classification.
function assessFrameQuality(analyses: readonly FlatAnalysis[], metadataUnknown: boolean, outliers: ReadonlySet<number>, outlierEvidenceComplete: boolean, frameCriteria: boolean, outlierConfigured: boolean): FlatCheck {
	if ((frameCriteria && analyses.some((analysis) => analysis.assessment.verdict === 'rejected')) || (outlierConfigured && outliers.size > 0)) return { status: 'fail' }
	if (metadataUnknown || (outlierConfigured && !outlierEvidenceComplete) || (frameCriteria && analyses.some((analysis) => analysis.assessment.verdict !== 'accepted'))) return { status: 'unknown' }
	return frameCriteria || outlierConfigured ? { status: 'pass' } : { status: 'unknown' }
}

// Aggregates signal variation and signed drift criteria across every plane.
function assessSignalStability(planes: readonly FlatSequencePlaneAnalysis[], timestampsAvailable: boolean, options: Partial<FlatSequenceOptions>): FlatCheck {
	const checks: FlatCheck[] = []
	if (options.maximumSignalVariation !== undefined)
		checks.push(
			assessMetric(
				planes.map((plane) => plane.signalVariation),
				options.maximumSignalVariation,
			),
		)
	if (options.maximumDriftPerFrame !== undefined)
		checks.push(
			assessMetric(
				planes.map((plane) => absolute(plane.driftPerFrame)),
				options.maximumDriftPerFrame,
			),
		)
	if (options.maximumDriftPerSecond !== undefined)
		checks.push(
			timestampsAvailable
				? assessMetric(
						planes.map((plane) => absolute(plane.driftPerSecond)),
						options.maximumDriftPerSecond,
					)
				: { status: 'unknown' },
		)
	return aggregateSequenceChecks(checks)
}

// Evaluates the worst finite metric against one configured non-negative limit.
function assessMetric(values: readonly (number | undefined)[], limit: number | undefined): FlatCheck {
	if (limit === undefined) return { status: 'unknown' }
	let worst = 0
	for (const value of values) {
		if (value === undefined || !Number.isFinite(value)) return { status: 'unknown', value: worst, limits: [0, limit] }
		worst = Math.max(worst, value)
	}
	return { status: worst > limit ? 'fail' : 'pass', value: worst, limits: [0, limit] }
}

// Aggregates multiple configured checks without comparing values that use different rates.
function aggregateSequenceChecks(checks: readonly FlatCheck[]): FlatCheck {
	if (checks.length === 0) return { status: 'unknown' }
	const status = checks.some((check) => check.status === 'fail') ? 'fail' : checks.every((check) => check.status === 'pass') ? 'pass' : 'unknown'
	return checks.length === 1 ? { ...checks[0], status } : { status }
}

// Selects stable codes that explain failed or unknown required sequence checks.
function sequenceAssessmentReasons(frameQuality: FlatCheck, signal: FlatCheck, spatial: FlatCheck, profile: FlatCheck, diagnostics: readonly FlatDiagnostic[], compatibility: SequenceCompatibility, timestampsAvailable: boolean, options: Partial<FlatSequenceOptions>): FlatDiagnosticCode[] {
	const reasons = new Set<FlatDiagnosticCode>()
	if (compatibility.metadataUnknown && frameQuality.status !== 'pass') reasons.add('sequenceMetadataUnknown')
	if (options.maximumDriftPerSecond !== undefined && !timestampsAvailable && signal.status !== 'pass') reasons.add('sequenceMetadataUnknown')
	for (const diagnostic of diagnostics) {
		if (
			frameQuality.status !== 'pass' &&
			(diagnostic.code === 'sequenceOutlier' ||
				diagnostic.code === 'targetUnavailable' ||
				diagnostic.code === 'targetBelowRange' ||
				diagnostic.code === 'targetAboveRange' ||
				diagnostic.code === 'effectiveClipUnknown' ||
				diagnostic.code === 'effectiveClipping' ||
				diagnostic.code === 'storageClipping' ||
				diagnostic.code === 'nonFiniteSamples' ||
				diagnostic.code === 'insufficientSamples')
		)
			reasons.add(diagnostic.code)
		if (signal.status !== 'pass' && (diagnostic.code === 'sequenceVariation' || diagnostic.code === 'sequenceDrift' || diagnostic.code === 'insufficientSamples')) reasons.add(diagnostic.code)
		if ((spatial.status !== 'pass' || profile.status !== 'pass') && (diagnostic.code === 'sequenceVariation' || diagnostic.code === 'insufficientSamples')) reasons.add(diagnostic.code)
	}
	return Array.from(reasons)
}

// Produces one frame status from its own checks plus configured sequence-wide stability evidence.
function sequenceFrameResult(frame: FlatFrame, index: number, analysis: FlatAnalysis, assessment: FlatSequenceAssessment, compatibility: SequenceCompatibility, outlier: boolean, outlierEvidenceComplete: boolean, options: Partial<FlatSequenceOptions>): FlatSequenceFrameAnalysis {
	const required: FlatCheck[] = []
	const reasons = new Set<FlatDiagnosticCode>()
	if (hasFrameCriteria(options)) {
		required.push({ status: analysis.assessment.verdict === 'accepted' ? 'pass' : analysis.assessment.verdict === 'rejected' ? 'fail' : 'unknown' })
		for (const reason of analysis.assessment.reasons) reasons.add(reason)
	}
	if (options.outlierSigma !== undefined) {
		required.push({ status: outlier ? 'fail' : outlierEvidenceComplete ? 'pass' : 'unknown' })
		if (outlier) reasons.add('sequenceOutlier')
		else if (!outlierEvidenceComplete) reasons.add('insufficientSamples')
	}
	if (compatibility.metadataUnknown) {
		required.push({ status: 'unknown' })
		reasons.add('sequenceMetadataUnknown')
	}
	if (signalCriteriaConfigured(options)) {
		required.push(assessment.signalStability)
		if (assessment.signalStability.status !== 'pass') for (const reason of assessment.reasons) if (reason === 'sequenceVariation' || reason === 'sequenceDrift' || reason === 'insufficientSamples' || reason === 'sequenceMetadataUnknown') reasons.add(reason)
	}
	if (options.maximumSpatialVariation !== undefined) {
		required.push(assessment.spatialStability)
		if (assessment.spatialStability.status !== 'pass') for (const reason of assessment.reasons) if (reason === 'sequenceVariation' || reason === 'insufficientSamples') reasons.add(reason)
	}
	if (options.maximumProfileVariation !== undefined) {
		required.push(assessment.profileStability)
		if (assessment.profileStability.status !== 'pass') for (const reason of assessment.reasons) if (reason === 'sequenceVariation' || reason === 'insufficientSamples') reasons.add(reason)
	}
	const status = required.some((check) => check.status === 'fail') ? 'rejected' : required.length === 0 || required.some((check) => check.status === 'unknown') ? 'inconclusive' : 'accepted'
	return { index, id: frame.id, status, reasons: Array.from(reasons) }
}
