import { medianOf } from '../../core/util'
import type { Point } from '../../math/numerical/geometry'
import { clamp } from '../../math/numerical/math'
import type { Angle } from '../../math/units/angle'
import type { AberrationFieldCell, AberrationFieldOptions, AberrationMeasuredQuantity, AberrationMetric, AberrationRegionDefinition, AberrationRegionOptions, AberrationRegionResult, AberrationStar, AberrationSummaryOptions } from './aberration.types'

// Region generation and robust scalar/axial aggregation for one-image aberration inspection.

// Default number of generated sensor columns.
const DEFAULT_COLUMNS = 3
// Default number of generated sensor rows.
const DEFAULT_ROWS = 3
// Default minimum scalar samples required for a regional value.
const DEFAULT_MINIMUM_STARS = 3
// Default minimum oriented samples required for an axial direction.
const DEFAULT_MINIMUM_ORIENTATION_STARS = 3
// Default eccentricity at which an orientation is considered meaningful.
const DEFAULT_MINIMUM_ORIENTATION_ECCENTRICITY = 0.05
// Default axial coherence required before publishing an orientation.
const DEFAULT_MINIMUM_ORIENTATION_COHERENCE = 0.4

// Stores a sorted scalar sample set and its robust location and scale.
interface RobustScalarSummary {
	// Sorted finite scalar values.
	readonly values: Float64Array
	// Median scalar value.
	readonly median: number
	// Scaled median absolute deviation.
	readonly deviation: number
}

// Generates validated non-overlapping regions for a requested layout.
export function createAberrationRegions(options: AberrationRegionOptions = {}): readonly AberrationRegionDefinition[] {
	if (options.regions) return validateCustomRegions(options.regions)

	const layout = options.layout ?? 'grid'
	const columns = positiveInteger(options.columns, DEFAULT_COLUMNS)
	const rows = positiveInteger(options.rows, DEFAULT_ROWS)
	const margin = finiteMargin(options.margin)
	const grid = createGridRegions(columns, rows, margin)

	switch (layout) {
		case 'grid':
			return grid
		case 'custom':
			throw new RangeError('custom aberration regions require options.regions')
		case 'centerAndCorners':
			return selectCenterAndCorners(grid, columns, rows)
		case 'centerAndEdges':
			return selectCenterAndEdges(grid, columns, rows)
		case 'octagonal':
			return selectOctagonal(grid, columns, rows)
	}
}

// Assigns a normalized sensor coordinate to the first matching validated region, or -1 outside all regions.
export function assignAberrationRegion(u: number, v: number, regions: readonly AberrationRegionDefinition[]): number {
	if (!Number.isFinite(u) || !Number.isFinite(v)) return -1

	for (let i = 0; i < regions.length; i++) {
		const region = regions[i]
		if (contains(region, u, v)) return i
	}

	return -1
}

// Computes robust scalar and axial summaries for every region in layout order.
export function summarizeAberrationRegions(stars: readonly AberrationStar[], regions: readonly AberrationRegionDefinition[], options: AberrationSummaryOptions = {}): AberrationRegionResult[] {
	const minimumStars = positiveInteger(options.minimumStars, DEFAULT_MINIMUM_STARS)
	const minimumOrientationStars = positiveInteger(options.minimumOrientationStars, DEFAULT_MINIMUM_ORIENTATION_STARS)
	const minimumOrientationEccentricity = clamp(finiteNumber(options.minimumOrientationEccentricity, DEFAULT_MINIMUM_ORIENTATION_ECCENTRICITY), 0, 1)
	const minimumOrientationCoherence = clamp(finiteNumber(options.minimumOrientationCoherence, DEFAULT_MINIMUM_ORIENTATION_COHERENCE), 0, 1)
	const assigned = new Array<AberrationStar[]>(regions.length)

	for (let i = 0; i < assigned.length; i++) assigned[i] = []
	for (let i = 0; i < stars.length; i++) {
		const regionIndex = assignAberrationRegion(stars[i].u, stars[i].v, regions)
		if (regionIndex >= 0) assigned[regionIndex].push(stars[i])
	}

	const results = new Array<AberrationRegionResult>(regions.length)
	for (let i = 0; i < regions.length; i++) {
		results[i] = summarizeRegion(regions[i], assigned[i], minimumStars, minimumOrientationStars, minimumOrientationEccentricity, minimumOrientationCoherence)
	}

	return results
}

// Builds a regular non-interpolated scalar field in normalized sensor coordinates.
export function buildAberrationField(stars: readonly AberrationStar[], metric: AberrationMetric, options: AberrationFieldOptions = {}): readonly AberrationFieldCell[] {
	const columns = positiveInteger(options.columns, DEFAULT_COLUMNS)
	const rows = positiveInteger(options.rows, DEFAULT_ROWS)
	const minimumStars = positiveInteger(options.minimumStars, DEFAULT_MINIMUM_STARS)
	const regions = createAberrationRegions({ layout: 'grid', columns, rows })
	const summaries = summarizeAberrationRegions(stars, regions, { minimumStars })
	const cells = new Array<AberrationFieldCell>(summaries.length)

	for (let i = 0; i < summaries.length; i++) {
		const summary = summaries[i]
		const value = regionMetricValue(summary, metric)
		const deviation = regionMetricDeviation(summary, metric)
		const count = summary.usedStarCountByMetric[metric] ?? 0
		cells[i] = {
			column: i % columns,
			row: Math.floor(i / columns),
			center: summary.center,
			value,
			deviation,
			count,
			confidence: value === undefined ? 0 : (summary.confidenceByMetric?.[metric] ?? summary.confidence),
		}
	}

	return cells
}

// Creates a regular rectangular grid bounded by the requested normalized margin.
function createGridRegions(columns: number, rows: number, margin: number): AberrationRegionDefinition[] {
	const minimum = -0.5 + margin
	const maximum = 0.5 - margin
	const width = (maximum - minimum) / columns
	const height = (maximum - minimum) / rows
	const regions = new Array<AberrationRegionDefinition>(columns * rows)

	for (let row = 0; row < rows; row++) {
		for (let column = 0; column < columns; column++) {
			const index = row * columns + column
			regions[index] = {
				id: `r${row}c${column}`,
				left: minimum + column * width,
				top: minimum + row * height,
				right: column === columns - 1 ? maximum : minimum + (column + 1) * width,
				bottom: row === rows - 1 ? maximum : minimum + (row + 1) * height,
			}
		}
	}

	return regions
}

// Selects a center and four corner regions from a grid with an odd number of rows and columns.
function selectCenterAndCorners(grid: readonly AberrationRegionDefinition[], columns: number, rows: number): AberrationRegionDefinition[] {
	if (columns < 3 || rows < 3 || columns % 2 === 0 || rows % 2 === 0) throw new RangeError('centerAndCorners requires odd dimensions of at least 3 by 3')

	const centerColumn = (columns - 1) >>> 1
	const centerRow = (rows - 1) >>> 1
	return [withId(grid[0], 'topLeft'), withId(grid[columns - 1], 'topRight'), withId(grid[centerRow * columns + centerColumn], 'center'), withId(grid[(rows - 1) * columns], 'bottomLeft'), withId(grid[rows * columns - 1], 'bottomRight')]
}

// Selects a center and four edge-middle regions from a grid with an odd number of rows and columns.
function selectCenterAndEdges(grid: readonly AberrationRegionDefinition[], columns: number, rows: number): AberrationRegionDefinition[] {
	if (columns < 3 || rows < 3 || columns % 2 === 0 || rows % 2 === 0) throw new RangeError('centerAndEdges requires odd dimensions of at least 3 by 3')

	const centerColumn = (columns - 1) >>> 1
	const centerRow = (rows - 1) >>> 1
	return [withId(grid[centerColumn], 'top'), withId(grid[centerRow * columns], 'left'), withId(grid[centerRow * columns + centerColumn], 'center'), withId(grid[centerRow * columns + columns - 1], 'right'), withId(grid[(rows - 1) * columns + centerColumn], 'bottom')]
}

// Selects the eight perimeter regions of a 3 by 3 grid-like layout without overlapping cells.
function selectOctagonal(grid: readonly AberrationRegionDefinition[], columns: number, rows: number): AberrationRegionDefinition[] {
	if (columns !== 3 || rows !== 3) throw new RangeError('octagonal requires a 3 by 3 grid')

	return [withId(grid[0], 'topLeft'), withId(grid[1], 'top'), withId(grid[2], 'topRight'), withId(grid[3], 'left'), withId(grid[5], 'right'), withId(grid[6], 'bottomLeft'), withId(grid[7], 'bottom'), withId(grid[8], 'bottomRight')]
}

// Replaces a generated region ID without altering its normalized bounds.
function withId(region: AberrationRegionDefinition, id: string): AberrationRegionDefinition {
	return { ...region, id }
}

// Validates caller-provided rectangles and returns defensive region objects in input order.
function validateCustomRegions(regions: readonly AberrationRegionDefinition[]): AberrationRegionDefinition[] {
	if (regions.length === 0) throw new RangeError('custom aberration regions must not be empty')

	const ids = new Set<string>()
	const validated = new Array<AberrationRegionDefinition>(regions.length)

	for (let i = 0; i < regions.length; i++) {
		const region = regions[i]
		if (!region.id || ids.has(region.id)) throw new RangeError('custom aberration region IDs must be unique and non-empty')
		if (!Number.isFinite(region.left) || !Number.isFinite(region.top) || !Number.isFinite(region.right) || !Number.isFinite(region.bottom)) throw new RangeError('custom aberration bounds must be finite')
		if (region.left < -0.5 || region.top < -0.5 || region.right > 0.5 || region.bottom > 0.5 || region.left >= region.right || region.top >= region.bottom) throw new RangeError('custom aberration bounds must form positive rectangles within the sensor')

		ids.add(region.id)
		validated[i] = { ...region }
	}

	for (let i = 0; i < validated.length; i++) {
		for (let j = i + 1; j < validated.length; j++) {
			if (overlaps(validated[i], validated[j])) throw new RangeError('custom aberration regions must not overlap')
		}
	}

	return validated
}

// Tests a normalized coordinate against a region using half-open internal edges and closed outer sensor edges.
function contains(region: AberrationRegionDefinition, u: number, v: number): boolean {
	const right = u < region.right || (region.right === 0.5 && u === 0.5)
	const bottom = v < region.bottom || (region.bottom === 0.5 && v === 0.5)
	return u >= region.left && right && v >= region.top && bottom
}

// Tests two rectangles for positive-area overlap while allowing shared boundaries.
function overlaps(a: AberrationRegionDefinition, b: AberrationRegionDefinition): boolean {
	return Math.max(a.left, b.left) < Math.min(a.right, b.right) && Math.max(a.top, b.top) < Math.min(a.bottom, b.bottom)
}

// Computes one region's scalar and axial output from all profiles assigned to it.
function summarizeRegion(region: AberrationRegionDefinition, stars: readonly AberrationStar[], minimumStars: number, minimumOrientationStars: number, minimumOrientationEccentricity: number, minimumOrientationCoherence: number): AberrationRegionResult {
	const hfd = summarizeMetric(stars, 'hfd')
	const fwhm = summarizeMetric(stars, 'fwhm')
	const eccentricity = summarizeMetric(stars, 'eccentricity')
	const elongation = summarizeMetric(stars, 'elongation')
	const orientation = summarizeOrientation(stars, minimumOrientationEccentricity)
	const usedStarCountByMetric: Partial<Record<AberrationMeasuredQuantity, number>> = {
		hfd: hfd?.values.length ?? 0,
		fwhm: fwhm?.values.length ?? 0,
		eccentricity: eccentricity?.values.length ?? 0,
		elongation: elongation?.values.length ?? 0,
		orientation: orientation.count,
	}
	const confidenceByMetric: Partial<Record<AberrationMetric, number>> = {
		hfd: metricConfidence(stars, 'hfd', usedStarCountByMetric.hfd ?? 0, minimumStars),
		fwhm: metricConfidence(stars, 'fwhm', usedStarCountByMetric.fwhm ?? 0, minimumStars),
		eccentricity: metricConfidence(stars, 'eccentricity', usedStarCountByMetric.eccentricity ?? 0, minimumStars),
		elongation: metricConfidence(stars, 'elongation', usedStarCountByMetric.elongation ?? 0, minimumStars),
	}
	const publishOrientation = orientation.count >= minimumOrientationStars && orientation.coherence >= minimumOrientationCoherence

	return {
		id: region.id,
		bounds: region,
		center: regionCenter(region),
		inputStarCount: stars.length,
		usedStarCountByMetric,
		confidenceByMetric,
		medianHFD: hfd && hfd.values.length >= minimumStars ? hfd.median : undefined,
		medianFWHM: fwhm && fwhm.values.length >= minimumStars ? fwhm.median : undefined,
		medianEccentricity: eccentricity && eccentricity.values.length >= minimumStars ? eccentricity.median : undefined,
		medianElongation: elongation && elongation.values.length >= minimumStars ? elongation.median : undefined,
		deviationHFD: hfd && hfd.values.length >= minimumStars ? hfd.deviation : undefined,
		deviationFWHM: fwhm && fwhm.values.length >= minimumStars ? fwhm.deviation : undefined,
		deviationEccentricity: eccentricity && eccentricity.values.length >= minimumStars ? eccentricity.deviation : undefined,
		orientation: publishOrientation ? orientation.theta : undefined,
		orientationCoherence: orientation.count >= minimumOrientationStars ? orientation.coherence : undefined,
		confidence: confidenceByMetric.hfd ?? 0,
	}
}

// Combines usable sample support and average selected profile weight for one scalar metric.
function metricConfidence(stars: readonly AberrationStar[], metric: AberrationMetric, count: number, minimumStars: number): number {
	return clamp(count / minimumStars, 0, 1) * averageMetricWeight(stars, metric)
}

// Extracts finite usable values for one scalar metric and computes median plus scaled MAD.
function summarizeMetric(stars: readonly AberrationStar[], metric: AberrationMetric): RobustScalarSummary | undefined {
	const values = new Float64Array(stars.length)
	let count = 0

	for (let i = 0; i < stars.length; i++) {
		const value = metricValue(stars[i], metric)
		if (value !== undefined) values[count++] = value
	}

	if (count === 0) return undefined

	const sorted = values.subarray(0, count)
	const median = medianOf(sorted.sort(), count)
	const deviations = new Float64Array(count)
	for (let i = 0; i < count; i++) deviations[i] = Math.abs(sorted[i] - median)

	return { values: sorted, median, deviation: 1.4826 * medianOf(deviations.sort(), count) }
}

// Computes an axial weighted mean and coherence from selected oriented profiles.
function summarizeOrientation(stars: readonly AberrationStar[], minimumEccentricity: number): { readonly theta?: Angle; readonly coherence: number; readonly count: number } {
	let cosine = 0
	let sine = 0
	let weightSum = 0
	let count = 0

	for (let i = 0; i < stars.length; i++) {
		const star = stars[i]
		const theta = orientationValue(star, minimumEccentricity)
		if (theta === undefined) continue

		const weight = star.weight
		cosine += weight * Math.cos(2 * theta)
		sine += weight * Math.sin(2 * theta)
		weightSum += weight
		count++
	}

	if (count === 0 || !(weightSum > 0)) return { coherence: 0, count }

	let theta = 0.5 * Math.atan2(sine, cosine)
	if (theta < 0) theta += Math.PI
	return { theta, coherence: Math.hypot(cosine, sine) / weightSum, count }
}

// Returns a selected finite scalar metric unless it has a metric-specific rejection.
function metricValue(star: AberrationStar, metric: AberrationMetric): number | undefined {
	if (!star.selected || hasRejection(star, metric)) return undefined

	const value = metric === 'hfd' ? star.profile.hfd : metric === 'fwhm' ? star.profile.fwhm : metric === 'eccentricity' ? star.profile.eccentricity : star.profile.elongation
	return value !== undefined && Number.isFinite(value) ? value : undefined
}

// Returns a selected axial angle only when shape and rejection checks permit its use.
function orientationValue(star: AberrationStar, minimumEccentricity: number): Angle | undefined {
	if (!star.selected || hasRejection(star, 'orientation')) return undefined
	const { theta, eccentricity } = star.profile
	return theta !== undefined && eccentricity !== undefined && eccentricity >= minimumEccentricity && Number.isFinite(theta) ? theta : undefined
}

// Tests whether a metric has any previously recorded rejection.
function hasRejection(star: AberrationStar, metric: AberrationMeasuredQuantity): boolean {
	for (let i = 0; i < star.rejections.length; i++) {
		if (star.rejections[i].metric === metric) return true
	}

	return false
}

// Computes the average selected profile weight usable for a scalar metric.
function averageMetricWeight(stars: readonly AberrationStar[], metric: AberrationMetric): number {
	let sum = 0
	let count = 0

	for (let i = 0; i < stars.length; i++) {
		if (metricValue(stars[i], metric) === undefined) continue
		sum += stars[i].weight
		count++
	}

	return count > 0 ? clamp(sum / count, 0, 1) : 0
}

// Computes the normalized center of a region rectangle.
function regionCenter(region: AberrationRegionDefinition): Point {
	return { x: 0.5 * (region.left + region.right), y: 0.5 * (region.top + region.bottom) }
}

// Returns a finite scalar option or its fallback.
function finiteNumber(value: number | undefined, fallback: number): number {
	return value !== undefined && Number.isFinite(value) ? value : fallback
}

// Returns a positive integer option or its fallback.
function positiveInteger(value: number | undefined, fallback: number): number {
	return value !== undefined && Number.isFinite(value) && Number.isInteger(value) && value > 0 ? value : fallback
}

// Validates a normalized generated-layout margin.
function finiteMargin(value: number | undefined): number {
	const margin = finiteNumber(value, 0)
	if (margin < 0 || margin >= 0.5) throw new RangeError('aberration region margin must be in [0, 0.5)')
	return margin
}

// Extracts a published metric value from a regional summary.
function regionMetricValue(region: AberrationRegionResult, metric: AberrationMetric): number | undefined {
	return metric === 'hfd' ? region.medianHFD : metric === 'fwhm' ? region.medianFWHM : metric === 'eccentricity' ? region.medianEccentricity : region.medianElongation
}

// Extracts a published robust deviation from a regional summary when the metric has one.
function regionMetricDeviation(region: AberrationRegionResult, metric: AberrationMetric): number | undefined {
	return metric === 'hfd' ? region.deviationHFD : metric === 'fwhm' ? region.deviationFWHM : metric === 'eccentricity' ? region.deviationEccentricity : undefined
}
