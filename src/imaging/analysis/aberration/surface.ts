import { validatePositiveInteger } from '../../../core/validation'
import { evaluateFocusSurface, type FocusSurfaceCoefficients, type FocusSurfaceFitSuccess } from '../../../math/numerical/surface.fit'

// Samples an existing best-focus surface at normalized sensor cell centers, rightward/downward in -0.5..0.5.
// Allocates a numeric map without mutating or refitting the surface; all focus quantities retain the scan's focuser unit.

// Maximum cells per sampled map, bounding caller-controlled allocation and computation.
export const MAX_FOCUS_SURFACE_MAP_CELLS = 65536

// Resolution of a sampled focus-surface map; the product must not exceed MAX_FOCUS_SURFACE_MAP_CELLS.
export interface FocusSurfaceMapOptions {
	// Positive integer column count, defaulting to 32.
	readonly columns?: number
	// Positive integer row count, defaulting to 32.
	readonly rows?: number
}

// One model evaluation at a regular cell center, with no measured-star count or per-cell support interpretation.
export interface FocusSurfaceMapCell {
	// Zero-based column, increasing to image right.
	readonly column: number
	// Zero-based row, increasing downward.
	readonly row: number
	// Normalized horizontal coordinate: -0.5 + (column + 0.5) / columns.
	readonly u: number
	// Normalized vertical coordinate: -0.5 + (row + 0.5) / rows.
	readonly v: number
	// Absolute predicted best focus in the scan's focuser-position unit.
	readonly focus: number
	// Predicted focus minus exact sensor-center focus, in focuser-position units.
	readonly offsetFromCenter: number
	// Standard uncertainty of the absolute model prediction in focuser-position units, absent without covariance.
	// Excludes measurement noise and is not the uncertainty of offsetFromCenter.
	readonly uncertainty?: number
}

// Dense sampled focus-surface map; extrema describe returned cells, not analytic extrema of the continuous surface.
export interface FocusSurfaceMap {
	// Number of regular columns.
	readonly columns: number
	// Number of regular rows.
	readonly rows: number
	// Fresh row-major cell array, indexed by row * columns + column.
	readonly cells: readonly FocusSurfaceMapCell[]
	// Exact model evaluation at (0, 0), even when the grid has no center cell, in focuser-position units.
	readonly centerFocus: number
	// Minimum returned cell focus in focuser-position units.
	readonly minimumFocus: number
	// Maximum returned cell focus in focuser-position units.
	readonly maximumFocus: number
	// Sampled maximum minus minimum focus in focuser-position units.
	readonly range: number
	// Original surface support/conditioning confidence in 0..1, not a per-cell probability.
	readonly confidence: number
}

// Samples a successful fit over the full normalized sensor using options' cell-center resolution (default 32x32).
// Returns a fresh map without changing surface; invalid dimensions or more than 65,536 cells throw before allocation.
// Covariance uses the fit's model-specific basis, with negative roundoff variance clamped to zero before square root.
export function buildFocusSurfaceMap(surface: FocusSurfaceFitSuccess, options: FocusSurfaceMapOptions = {}): FocusSurfaceMap {
	// Validate allocation dimensions once to prevent invalid array sizes and accidentally huge maps.
	const columns = validatePositiveInteger(options.columns ?? 32)
	const rows = validatePositiveInteger(options.rows ?? 32)
	const count = columns * rows
	if (!(count <= MAX_FOCUS_SURFACE_MAP_CELLS)) throw new RangeError(`focus surface map must contain at most ${MAX_FOCUS_SURFACE_MAP_CELLS} cells`)

	const cells = new Array<FocusSurfaceMapCell>(count)
	const centerFocus = evaluateFocusSurface(surface.coefficients, 0, 0)
	const covariance = surface.covariance
	const parameters = surface.model === 'plane' ? 3 : surface.model === 'radialQuadratic' ? 4 : 6
	// Reuse one design vector for every prediction instead of allocating per cell.
	const basis = covariance === undefined ? undefined : new Float64Array(parameters)
	let minimumFocus = Infinity
	let maximumFocus = -Infinity

	for (let row = 0; row < rows; row++) {
		const v = -0.5 + (row + 0.5) / rows
		for (let column = 0; column < columns; column++) {
			const u = -0.5 + (column + 0.5) / columns
			const focus = evaluateFocusSurface(surface.coefficients, u, v)
			const offsetFromCenter = focusSurfaceOffsetFromCenter(surface.coefficients, u, v)
			let uncertainty: number | undefined
			if (covariance !== undefined && basis !== undefined) {
				basis[0] = 1
				basis[1] = u
				basis[2] = v
				if (surface.model === 'radialQuadratic') basis[3] = u * u + v * v
				else if (surface.model === 'quadratic') {
					basis[3] = u * u
					basis[4] = u * v
					basis[5] = v * v
				}
				let variance = 0
				for (let i = 0; i < parameters; i++) {
					for (let j = 0; j < parameters; j++) variance += basis[i] * covariance[i * parameters + j] * basis[j]
				}
				uncertainty = Math.sqrt(Math.max(0, variance))
			}
			cells[row * columns + column] = { column, row, u, v, focus, offsetFromCenter, uncertainty }
			minimumFocus = Math.min(minimumFocus, focus)
			maximumFocus = Math.max(maximumFocus, focus)
		}
	}

	return { columns, rows, cells, centerFocus, minimumFocus, maximumFocus, range: maximumFocus - minimumFocus, confidence: surface.confidence }
}

// Evaluates spatial focus change directly, avoiding cancellation against the absolute focuser zero point.
function focusSurfaceOffsetFromCenter(surface: FocusSurfaceCoefficients, u: number, v: number): number {
	return surface.ax * u + surface.ay * v + surface.qxx * u * u + surface.qxy * u * v + surface.qyy * v * v
}
