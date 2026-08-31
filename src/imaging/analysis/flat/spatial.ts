import { percentileOf, STANDARD_DEVIATION_SCALE } from '../../../core/util'
import type { Point, Rect } from '../../../math/numerical/geometry'
import type { DigitalImage } from '../../model/types'
import { createScalarSurfaceEvaluator, createScalarSurfacePointEvaluator, createSurfaceColumnTable, fitScalarSurface, type ScalarSurfaceModel, type SurfaceSample } from '../../processing/surface'
import { resolveImagePlaneGeometry, resolveOptionalImagePlaneGeometry } from '../plane'
import { detectFlatDustCandidates, measureFlatProfiles } from './artifacts'
import { measureFlatRegion, type FlatRegionMeasurement, type ResolvedFlatClippingLimits } from './statistics'
import type { FlatAnalysisOptions, FlatDiagnostic, FlatPlane, FlatSampleStatistics, FlatSpatialAnalysis, FlatTile } from './types'

// Tiled spatial flat analysis over digital mono, interleaved RGB, and non-debayered CFA planes. Tile
// summaries remain bounded by geometry; a degree-two Chebyshev surface uses symmetric rejection, and
// dense selected-plane maps are allocated only when requested.

// Desired number of default tiles along the longest image axis.
const DEFAULT_FLAT_TILES_PER_LONG_AXIS = 24

// Minimum output-pixel tile edge, preserving at least 4x4 samples for an interior CFA plane.
const MINIMUM_DEFAULT_FLAT_TILE_EDGE = 8

// Preferred finite samples required for one robust tile, reduced for genuinely smaller whole planes.
const MINIMUM_FLAT_TILE_SAMPLES = 16

// Maximum tile objects an explicit configuration may allocate.
const MAXIMUM_FLAT_TILE_COUNT = 65536

// Minimum degree-two curvature relative to the fitted level before a stationary maximum is identifiable.
const MINIMUM_CENTER_CURVATURE_FRACTION = 1e-8

// Maximum absolute eigenvalue ratio accepted for illumination-center Hessians.
const MAXIMUM_CENTER_CONDITION = 1e6

// Tile and weighting data retained only until the surface fit is complete.
interface SpatialTileSample {
	// Public tile summary.
	readonly tile: FlatTile
	// Tile-center x coordinate in image pixels.
	readonly x: number
	// Tile-center y coordinate in image pixels.
	readonly y: number
	// Positive robust tile level on the chosen basis, in digital numbers.
	readonly level: number
	// Positive unnormalized support/noise weight.
	readonly weight: number
}

// Inputs required to build one plane's spatial analysis.
export interface FlatSpatialInput {
	// Observed digital flat image.
	readonly image: DigitalImage
	// Explicit CFA offset applied once to image.metadata.bayer.
	readonly cfaOffset?: readonly [number, number]
	// Compatible bias or dark-flat image for corrected spatial measurements.
	readonly reference?: DigitalImage
	// Explicit CFA offset applied once to reference.metadata.bayer.
	readonly referenceCfaOffset?: readonly [number, number]
	// Optional row-major per-pixel exclusion mask.
	readonly mask?: Readonly<Uint8Array>
	// Inclusive-exclusive image region used for tiles and model fitting.
	readonly area: Readonly<Rect>
	// Physical mono, RGB, or CFA plane.
	readonly plane: FlatPlane
	// Validated single-frame options.
	readonly options: Partial<FlatAnalysisOptions>
	// Effective or storage clipping limits applied to every tile.
	readonly clippingLimits: ResolvedFlatClippingLimits
	// Full-area measurement used to suppress redundant localized diagnostics.
	readonly fullMeasurement: FlatRegionMeasurement
}

// Spatial result plus diagnostics generated while fitting or materializing it.
export interface FlatSpatialResult {
	// Spatial measurements for one plane.
	readonly analysis: FlatSpatialAnalysis
	// Fit, support, center, and localized data-quality diagnostics.
	readonly diagnostics: readonly FlatDiagnostic[]
}

// Computes robust tiles, low-order illumination metrics, and optional dense selected-plane maps.
export function analyzeFlatSpatial(input: FlatSpatialInput): FlatSpatialResult {
	const basis = input.reference ? 'corrected' : 'observed'
	const diagnostics: FlatDiagnostic[] = []
	const tileSize = resolveTileSize(input.area, input.options)
	const columns = Math.ceil((input.area.right - input.area.left) / tileSize.width)
	const rows = Math.ceil((input.area.bottom - input.area.top) / tileSize.height)
	if (columns * rows > MAXIMUM_FLAT_TILE_COUNT) throw new RangeError(`flat tile configuration exceeds the ${MAXIMUM_FLAT_TILE_COUNT} tile allocation limit`)

	const fullGeometry = resolveImagePlaneGeometry(input.image, input.area, input.plane, input.cfaOffset)
	const minimumSamples = Math.min(MINIMUM_FLAT_TILE_SAMPLES, fullGeometry.width * fullGeometry.height)
	const tiles: FlatTile[] = []
	const samples: SpatialTileSample[] = []
	let nonPositiveLevel = false

	for (let top = input.area.top; top < input.area.bottom; top += tileSize.height) {
		const bottom = Math.min(input.area.bottom, top + tileSize.height)
		for (let left = input.area.left; left < input.area.right; left += tileSize.width) {
			const right = Math.min(input.area.right, left + tileSize.width)
			const area = { left, top, right, bottom }
			const geometry = resolveOptionalImagePlaneGeometry(input.image, area, input.plane, input.cfaOffset)
			if (!geometry) continue
			const measurement = measureFlatRegion({
				image: input.image,
				cfaOffset: input.cfaOffset,
				reference: input.reference,
				referenceCfaOffset: input.referenceCfaOffset,
				mask: input.mask,
				area,
				plane: input.plane,
				clippingLimits: input.clippingLimits,
			})
			if (measurement.observed.count < minimumSamples) continue
			const tile = { area, observed: measurement.observed, corrected: measurement.corrected, clipping: measurement.clipping }
			tiles.push(tile)

			const statistics = basis === 'corrected' ? measurement.corrected : measurement.observed
			if (!statistics || statistics.count < minimumSamples || statistics.median === undefined) continue
			if (statistics.median <= 0) {
				nonPositiveLevel = true
				continue
			}
			const support = statistics.count / (statistics.count + statistics.masked + statistics.nonFinite)
			const dispersion = tileDispersionFloor(input, statistics)
			const weight = support / (dispersion * dispersion)
			if (!Number.isFinite(weight) || weight <= 0) continue
			samples.push({ tile, x: (left + right - 1) * 0.5, y: (top + bottom - 1) * 0.5, level: statistics.median, weight })
		}
	}

	appendLocalizedDiagnostics(diagnostics, input.plane, tiles, input.fullMeasurement)
	if (tiles.length === 0) {
		diagnostics.push({ severity: 'warning', code: 'illuminationFitFailed', message: 'No tile retained enough finite, non-masked samples for spatial flat analysis.', plane: input.plane })
		return { analysis: { basis, tiles }, diagnostics }
	}
	if (nonPositiveLevel) {
		diagnostics.push({ severity: 'warning', code: 'illuminationFitFailed', message: 'At least one supported tile has a non-positive level, so multiplicative illumination metrics are unavailable.', plane: input.plane })
		return { analysis: { basis, tiles }, diagnostics }
	}

	const levels = samples.map((sample) => sample.level)
	const regional = regionalLevels(samples, input.area)
	const scalar = scalarSpatialMetrics(levels, regional)
	if (samples.length < 6) {
		diagnostics.push({ severity: 'warning', code: 'illuminationFitFailed', message: 'Fewer than six positive supported tiles are available for a degree-two illumination fit.', plane: input.plane })
		return { analysis: { basis, tiles, ...scalar }, diagnostics }
	}

	let maximumWeight = 0
	for (const sample of samples) maximumWeight = Math.max(maximumWeight, sample.weight)
	const surfaceSamples: SurfaceSample[] = samples.map((sample) => ({ x: sample.x, y: sample.y, value: sample.level, weight: Math.max(Number.EPSILON, Math.min(1, sample.weight / maximumWeight)) }))
	const fit = fitScalarSurface(surfaceSamples, input.image.metadata.width, input.image.metadata.height, {
		model: 'polynomial',
		degree: 2,
		domain: { x0: input.area.left, y0: input.area.top, x1: input.area.right - 1, y1: input.area.bottom - 1 },
		rejection: { mode: 'symmetric', low: input.options.rejectionSigma ?? 4, high: input.options.rejectionSigma ?? 4, iterations: 3 },
	})
	if (!fit.ok) {
		diagnostics.push({ severity: 'warning', code: 'illuminationFitFailed', message: `The degree-two illumination fit failed because of ${fit.reason}.`, plane: input.plane })
		return { analysis: { basis, tiles, ...scalar }, diagnostics }
	}
	if (!quadraticSurfaceIsPositive(fit.model)) {
		diagnostics.push({ severity: 'warning', code: 'illuminationFitFailed', message: 'The fitted illumination surface is not strictly positive across the analysis area.', plane: input.plane })
		return { analysis: { basis, tiles, ...scalar }, diagnostics }
	}

	const gradient = illuminationGradient(fit.model, input.area)
	const firstStatistics = basis === 'corrected' ? samples[0].tile.corrected! : samples[0].tile.observed
	const center = illuminationCenter(fit.model, input.area, tiles, medianFinite(levels), tileDispersionFloor(input, firstStatistics))
	if (!center) diagnostics.push({ severity: 'info', code: 'illuminationCenterUnknown', message: 'The fitted illumination surface has no well-conditioned concave interior maximum.', plane: input.plane })
	const configuredDust = input.options.artifacts?.dust
	const dustRequested = configuredDust === true || (typeof configuredDust === 'object' && configuredDust !== null)
	const maps = materializeSpatialMaps(input, fit.model, dustRequested)
	if (maps.failed) diagnostics.push({ severity: 'warning', code: 'illuminationFitFailed', message: 'A requested spatial map exceeded finite Float32 output range and was omitted.', plane: input.plane })
	const profiles = input.options.artifacts?.profiles ? measureFlatProfiles(input, fit.model) : undefined
	const dustCandidates = dustRequested && maps.residual && maps.validity ? detectFlatDustCandidates(input, maps.residual, maps.validity, configuredDust === true ? true : configuredDust) : undefined
	const exposeResidual = input.options.maps === 'residual' || input.options.maps === 'all'

	return {
		analysis: {
			basis,
			tiles,
			...scalar,
			gradient,
			illuminationCenter: center?.point,
			illuminationCenterConfidence: center?.confidence,
			model: fit.model,
			illuminationMap: maps.illumination,
			residualMap: exposeResidual ? maps.residual : undefined,
			residualMapValidity: exposeResidual ? maps.validity : undefined,
			profiles,
			dustCandidates,
		},
		diagnostics,
	}
}

// Derives a square-ish default tile size or returns the caller's validated output-pixel dimensions.
function resolveTileSize(area: Readonly<Rect>, options: Partial<FlatAnalysisOptions>): { readonly width: number; readonly height: number } {
	if (options.tile) return options.tile
	const width = area.right - area.left
	const height = area.bottom - area.top
	const edge = Math.max(MINIMUM_DEFAULT_FLAT_TILE_EDGE, Math.ceil(Math.max(width, height) / DEFAULT_FLAT_TILES_PER_LONG_AXIS))
	return { width: Math.min(width, edge), height: Math.min(height, edge) }
}

// Returns a robust dispersion floor combining tile MAD, quantization, and floating-point scale.
function tileDispersionFloor(input: FlatSpatialInput, statistics: FlatSampleStatistics): number {
	const observedStep = input.image.quantizationStep ?? 0
	const referenceStep = input.reference?.quantizationStep ?? 0
	const quantization = input.reference ? Math.hypot(observedStep, referenceStep) : observedStep
	const robust = (statistics.mad ?? 0) * STANDARD_DEVIATION_SCALE
	return Math.max(robust, quantization, Math.abs(statistics.median ?? statistics.mean ?? 0) * Number.EPSILON, 1e-12)
}

// Computes uniformity and disjoint center, edge, and corner summaries from positive supported tiles.
function scalarSpatialMetrics(levels: readonly number[], regional: { readonly center?: number; readonly edge?: number; readonly corner?: number }): Pick<FlatSpatialAnalysis, 'uniformity' | 'centerLevel' | 'edgeLevel' | 'cornerLevel' | 'edgeFalloff' | 'cornerFalloff'> {
	const sorted = Float64Array.from(levels).sort()
	const low = percentileOf(sorted, 0.05)
	const high = percentileOf(sorted, 0.95)
	const uniformity = Number.isFinite(low) && Number.isFinite(high) && high > 0 ? low / high : undefined
	const center = regional.center
	const edgeFalloff = center !== undefined && center > 0 && regional.edge !== undefined ? 1 - regional.edge / center : undefined
	const cornerFalloff = center !== undefined && center > 0 && regional.corner !== undefined ? 1 - regional.corner / center : undefined
	return {
		uniformity: Number.isFinite(uniformity) ? uniformity : undefined,
		centerLevel: center,
		edgeLevel: regional.edge,
		cornerLevel: regional.corner,
		edgeFalloff: Number.isFinite(edgeFalloff) ? edgeFalloff : undefined,
		cornerFalloff: Number.isFinite(cornerFalloff) ? cornerFalloff : undefined,
	}
}

// Classifies tile centers into disjoint normalized center, non-corner edge, and corner regions.
function regionalLevels(samples: readonly SpatialTileSample[], area: Readonly<Rect>): { readonly center?: number; readonly edge?: number; readonly corner?: number } {
	const center: number[] = []
	const edge: number[] = []
	const corner: number[] = []
	const spanX = Math.max(1, area.right - area.left - 1)
	const spanY = Math.max(1, area.bottom - area.top - 1)
	for (const sample of samples) {
		const x = (sample.x - area.left) / spanX
		const y = (sample.y - area.top) / spanY
		const horizontalEdge = x <= 0.2 || x >= 0.8
		const verticalEdge = y <= 0.2 || y >= 0.8
		if (horizontalEdge && verticalEdge) corner.push(sample.level)
		else if (horizontalEdge || verticalEdge) edge.push(sample.level)
		else if (x >= 0.35 && x <= 0.65 && y >= 0.35 && y <= 0.65) center.push(sample.level)
	}
	return { center: medianFinite(center), edge: medianFinite(edge), corner: medianFinite(corner) }
}

// Returns an exact finite median with an overflow-safe midpoint, or undefined for an empty list.
function medianFinite(values: readonly number[]): number | undefined {
	if (values.length === 0) return undefined
	const sorted = Float64Array.from(values).sort()
	const middle = sorted.length >>> 1
	if ((sorted.length & 1) !== 0) return sorted[middle]
	const lower = sorted[middle - 1]
	const upper = sorted[middle]
	return Math.sign(lower) === Math.sign(upper) ? lower + (upper - lower) * 0.5 : lower * 0.5 + upper * 0.5
}

// Derives fitted edge-to-edge fractional gradients at the geometric image center.
function illuminationGradient(model: ScalarSurfaceModel, area: Readonly<Rect>): Readonly<Point> | undefined {
	const evaluator = createScalarSurfacePointEvaluator(model)
	const centerX = (area.left + area.right - 1) * 0.5
	const centerY = (area.top + area.bottom - 1) * 0.5
	const center = evaluator.at(centerX, centerY)
	if (!Number.isFinite(center) || center <= 0) return undefined
	const x = (evaluator.at(area.right - 1, centerY) - evaluator.at(area.left, centerY)) / center
	const y = (evaluator.at(centerX, area.bottom - 1) - evaluator.at(centerX, area.top)) / center
	return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : undefined
}

// Returns true when a degree-two Chebyshev polynomial is positive at every possible rectangle minimum.
function quadraticSurfaceIsPositive(model: ScalarSurfaceModel): boolean {
	const coefficients = model.coefficients
	if (model.type !== 'polynomial' || model.degree !== 2 || coefficients.length < 6) return false
	const candidates: Array<readonly [number, number]> = [
		[-1, -1],
		[-1, 1],
		[1, -1],
		[1, 1],
	]
	const c1 = coefficients[1]
	const c2 = coefficients[2]
	const c3 = coefficients[3]
	const c4 = coefficients[4]
	const c5 = coefficients[5]
	const determinant = 16 * c3 * c5 - c4 * c4
	if (determinant !== 0 && Number.isFinite(determinant)) {
		const u = (-4 * c5 * c1 + c4 * c2) / determinant
		const v = (-4 * c3 * c2 + c4 * c1) / determinant
		if (u >= -1 && u <= 1 && v >= -1 && v <= 1) candidates.push([u, v])
	}
	for (const u of [-1, 1]) {
		if (c5 !== 0) {
			const v = -(c2 + c4 * u) / (4 * c5)
			if (v >= -1 && v <= 1) candidates.push([u, v])
		}
	}
	for (const v of [-1, 1]) {
		if (c3 !== 0) {
			const u = -(c1 + c4 * v) / (4 * c3)
			if (u >= -1 && u <= 1) candidates.push([u, v])
		}
	}
	for (const [u, v] of candidates) {
		const value = quadraticValue(coefficients, u, v)
		if (!Number.isFinite(value) || value <= 0) return false
	}
	return true
}

// Evaluates a degree-two tensor Chebyshev polynomial in normalized surface coordinates.
function quadraticValue(coefficients: Float64Array, u: number, v: number): number {
	return coefficients[0] + coefficients[1] * u + coefficients[2] * v + coefficients[3] * (2 * u * u - 1) + coefficients[4] * u * v + coefficients[5] * (2 * v * v - 1)
}

// Resolves a well-conditioned concave stationary point and a dimensionless confidence estimate.
function illuminationCenter(model: ScalarSurfaceModel, area: Readonly<Rect>, tiles: readonly FlatTile[], level: number | undefined, noiseFloor: number): { readonly point: Readonly<Point>; readonly confidence: number } | undefined {
	const coefficients = model.coefficients
	if (model.type !== 'polynomial' || model.degree !== 2 || coefficients.length < 6 || level === undefined || level <= 0) return undefined
	const a = 4 * coefficients[3]
	const b = coefficients[4]
	const d = 4 * coefficients[5]
	const determinant = a * d - b * b
	if (!(a < 0) || !(determinant > 0) || !Number.isFinite(determinant)) return undefined
	const trace = a + d
	const discriminant = Math.hypot(a - d, 2 * b)
	const firstEigenvalue = (trace - discriminant) * 0.5
	const secondEigenvalue = (trace + discriminant) * 0.5
	if (!(firstEigenvalue < 0) || !(secondEigenvalue < 0)) return undefined
	const minimumCurvature = Math.min(Math.abs(firstEigenvalue), Math.abs(secondEigenvalue))
	const maximumCurvature = Math.max(Math.abs(firstEigenvalue), Math.abs(secondEigenvalue))
	const condition = maximumCurvature / minimumCurvature
	if (!Number.isFinite(condition) || condition > MAXIMUM_CENTER_CONDITION || minimumCurvature <= Math.max(level, noiseFloor) * MINIMUM_CENTER_CURVATURE_FRACTION) return undefined

	const u = (-d * coefficients[1] + b * coefficients[2]) / determinant
	const v = (-a * coefficients[2] + b * coefficients[1]) / determinant
	if (!Number.isFinite(u) || !Number.isFinite(v)) return undefined
	const spanX = model.domain.x1 - model.domain.x0
	const spanY = model.domain.y1 - model.domain.y0
	const x = model.domain.x0 + ((u + 1) * spanX) / 2
	const y = model.domain.y0 + ((v + 1) * spanY) / 2
	const tileWidths = tiles.map((tile) => tile.area.right - tile.area.left)
	const tileHeights = tiles.map((tile) => tile.area.bottom - tile.area.top)
	const marginX = Math.max(0.5, ((medianFinite(tileWidths) ?? 1) - 1) * 0.5)
	const marginY = Math.max(0.5, ((medianFinite(tileHeights) ?? 1) - 1) * 0.5)
	if (x < model.domain.x0 + marginX || x > model.domain.x1 - marginX || y < model.domain.y0 + marginY || y > model.domain.y1 - marginY) return undefined

	const coverage = model.samples.length > 0 ? model.acceptedSamples / model.samples.length : 0
	const residualScore = 1 / (1 + model.residual / Math.max(level, noiseFloor))
	const conditionScore = 1 / Math.sqrt(condition)
	const curvatureFraction = minimumCurvature / Math.max(level, noiseFloor)
	const curvatureScore = curvatureFraction / (curvatureFraction + 0.01)
	const confidence = Math.max(0, Math.min(1, coverage * residualScore * conditionScore * curvatureScore))
	return Number.isFinite(confidence) ? { point: { x, y }, confidence } : undefined
}

// Materializes requested maps on the full image-pixel grid over area, carrying validity for residual
// gaps such as masks, non-finite values, and pixels belonging to other CFA planes.
function materializeSpatialMaps(input: FlatSpatialInput, model: ScalarSurfaceModel, retainArtifactResidual: boolean): { readonly illumination?: Float32Array; readonly residual?: Float32Array; readonly validity?: Uint8Array; readonly failed: boolean } {
	const selection = input.options.maps ?? 'none'
	const retainIllumination = selection === 'illumination' || selection === 'all'
	const retainResidual = selection === 'residual' || selection === 'all' || retainArtifactResidual
	if (!retainIllumination && !retainResidual) return { failed: false }

	const geometry = resolveImagePlaneGeometry(input.image, input.area, input.plane, input.cfaOffset)
	const referenceGeometry = input.reference ? resolveImagePlaneGeometry(input.reference, input.area, input.plane, input.referenceCfaOffset) : undefined
	const width = input.area.right - input.area.left
	const height = input.area.bottom - input.area.top
	const capacity = width * height
	const illumination = retainIllumination ? new Float32Array(capacity) : undefined
	const residual = retainResidual ? new Float32Array(capacity) : undefined
	const validity = retainResidual ? new Uint8Array(capacity) : undefined
	const row = new Float64Array(width)
	const columns = createSurfaceColumnTable(model.degree, model.domain, width, input.area.left, 1)
	const evaluator = createScalarSurfaceEvaluator(model, columns)
	let failed = false

	for (let mapY = 0; mapY < height; mapY++) {
		const sourceY = input.area.top + mapY
		evaluator.fillRow(sourceY, row, 0, 1)
		const mapRow = mapY * width
		for (let mapX = 0; mapX < width; mapX++) {
			const illuminationValue = row[mapX]
			if (!Number.isFinite(illuminationValue) || illuminationValue <= 0) {
				failed = true
				continue
			}
			if (illumination) {
				const illumination32 = Math.fround(illuminationValue)
				if (!Number.isFinite(illumination32) || illumination32 <= 0) failed = true
				else illumination[mapRow + mapX] = illumination32
			}
		}

		if (!residual || sourceY < geometry.sourceTop || (sourceY - geometry.sourceTop) % geometry.step !== 0) continue
		const planeY = (sourceY - geometry.sourceTop) / geometry.step
		let rawIndex = geometry.rawStart + planeY * geometry.rawRowStep
		let referenceIndex = referenceGeometry ? referenceGeometry.rawStart + planeY * referenceGeometry.rawRowStep : 0
		let maskIndex = sourceY * input.image.metadata.width + geometry.sourceLeft
		for (let planeX = 0; planeX < geometry.width; planeX++, rawIndex += geometry.rawColumnStep, maskIndex += geometry.step) {
			const mapX = geometry.sourceLeft - input.area.left + planeX * geometry.step
			const mapIndex = mapRow + mapX
			if (!input.mask?.[maskIndex] && Number.isFinite(row[mapX]) && row[mapX] > 0) {
				const observed = input.image.raw[rawIndex]
				const sample = referenceGeometry ? observed - input.reference!.raw[referenceIndex] : observed
				const value = Math.fround(sample / row[mapX] - 1)
				if (Number.isFinite(value)) {
					residual[mapIndex] = value
					validity![mapIndex] = 1
				}
			}
			if (referenceGeometry) referenceIndex += referenceGeometry.rawColumnStep
		}
	}

	return { illumination: failed ? undefined : illumination, residual, validity, failed }
}

// Reports only localized clipping or non-finite fractions that exceed their full-area counterparts.
function appendLocalizedDiagnostics(diagnostics: FlatDiagnostic[], plane: FlatPlane, tiles: readonly FlatTile[], full: FlatRegionMeasurement): void {
	let nonFinite = 0
	let effectiveClipping = 0
	let storageClipping = 0
	const fullDenominator = full.observed.count + full.observed.nonFinite
	const fullNonFinite = fullDenominator > 0 ? full.observed.nonFinite / fullDenominator : 0
	for (const tile of tiles) {
		const denominator = tile.observed.count + tile.observed.nonFinite
		if (denominator > 0) nonFinite = Math.max(nonFinite, tile.observed.nonFinite / denominator)
		for (const side of [tile.clipping.lower, tile.clipping.upper]) {
			if (side?.status !== 'present') continue
			if (side.source === 'effective') effectiveClipping = Math.max(effectiveClipping, side.fraction)
			else storageClipping = Math.max(storageClipping, side.fraction)
		}
	}
	const fullEffective = Math.max(full.clipping.lower?.source === 'effective' ? full.clipping.lower.fraction : 0, full.clipping.upper?.source === 'effective' ? full.clipping.upper.fraction : 0)
	const fullStorage = Math.max(full.clipping.lower?.source === 'storage' ? full.clipping.lower.fraction : 0, full.clipping.upper?.source === 'storage' ? full.clipping.upper.fraction : 0)
	if (nonFinite > fullNonFinite) diagnostics.push({ severity: 'warning', code: 'nonFiniteSamples', message: 'A supported tile has a higher non-finite fraction than the full analysis area.', plane, value: nonFinite })
	if (effectiveClipping > fullEffective) diagnostics.push({ severity: 'warning', code: 'effectiveClipping', message: 'Effective clipping is concentrated in a supported spatial tile.', plane, value: effectiveClipping })
	if (storageClipping > fullStorage) diagnostics.push({ severity: 'warning', code: 'storageClipping', message: 'Storage-endpoint clipping is concentrated in a supported spatial tile.', plane, value: storageClipping })
}
