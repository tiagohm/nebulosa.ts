import { type Angle, normalizeAngle, normalizePI } from './angle'
import { PI, PIOVERTWO } from './constants'

// Maximum sparse-array length accepted by JavaScript engines.
const MAX_ARRAY_LENGTH = 0xffffffff

// Relative tolerance used only to avoid adding panels at floating-point ceil boundaries.
const COUNT_EPSILON_FACTOR = 8

// Relative tolerance used to verify that rounded-up coverage still spans the request.
const COVERAGE_EPSILON_FACTOR = 16

// Describes an angular rectangular field on the shared mosaic tangent plane.
export interface MosaicFieldOfView {
	// Angular width in radians. Interpreted on the shared reference tangent plane.
	readonly width: Angle

	// Angular height in radians. Interpreted on the shared reference tangent plane.
	readonly height: Angle
}

// Describes fractional overlap between adjacent mosaic panels.
export interface MosaicOverlap {
	// Fractional overlap between adjacent columns, in the range [0, 1).
	readonly x: number

	// Fractional overlap between adjacent rows, in the range [0, 1).
	readonly y: number
}

// Describes an equatorial coordinate in one caller-selected celestial frame.
export interface MosaicCoordinate {
	// Right ascension in radians, normalized to [0, 2 * PI).
	readonly ra: Angle

	// Declination in radians, constrained to [-PI / 2, PI / 2].
	readonly dec: Angle
}

// Capture traversal strategies supported by the rectangular mosaic planner.
export type MosaicTraversal = 'ROW_MAJOR' | 'SERPENTINE'

// Input geometry for planning a rectangular mosaic on one shared gnomonic tangent plane.
export interface MosaicPlanInput {
	// Central coordinate of the desired mosaic. Input RA may be any finite angle.
	readonly center: MosaicCoordinate

	// Angular footprint of one panel in the shared reference tangent plane.
	readonly panel: MosaicFieldOfView

	// Requested angular coverage in the shared reference tangent plane.
	readonly region: MosaicFieldOfView

	// Angle of the positive local y axis, measured from celestial north toward celestial east.
	readonly positionAngle?: Angle

	// Fractional overlap between adjacent panels. Missing axes default to zero.
	readonly overlap?: Partial<MosaicOverlap>

	// Capture ordering strategy. Defaults to ROW_MAJOR.
	readonly traversal?: MosaicTraversal
}

// Describes one panel footprint projected from the shared reference tangent plane.
// Corners are named by celestial direction to avoid screen-space ambiguity: the
// local x axis points celestial east and the local y axis points celestial north,
// so positive local x is east and positive local y is north.
export interface MosaicFootprint {
	// Corner at negative local x and positive local y, i.e. celestial north-west.
	readonly northWest: MosaicCoordinate

	// Corner at positive local x and positive local y, i.e. celestial north-east.
	readonly northEast: MosaicCoordinate

	// Corner at positive local x and negative local y, i.e. celestial south-east.
	readonly southEast: MosaicCoordinate

	// Corner at negative local x and negative local y, i.e. celestial south-west.
	readonly southWest: MosaicCoordinate
}

// Describes one planned mosaic panel in both geometric and capture-order terms.
export interface MosaicPanel {
	// Zero-based capture order according to traversal.
	readonly index: number

	// Zero-based geometric row. Row zero is on the positive local y side.
	readonly row: number

	// Zero-based geometric column. Column zero is on the negative local x side.
	readonly column: number

	// Equatorial center coordinate of this panel.
	readonly center: MosaicCoordinate

	// Footprint projected from the shared reference tangent plane, not a per-panel tangent frame.
	readonly footprint: MosaicFootprint
}

// Result of a rectangular mosaic plan built on one shared reference tangent plane.
export interface MosaicPlan {
	// Normalized central coordinate used by the plan.
	readonly center: MosaicCoordinate

	// Position angle in radians, normalized to (-PI, PI].
	readonly positionAngle: Angle

	// Field of view of one panel in radians.
	readonly panel: MosaicFieldOfView

	// Requested coverage in radians.
	readonly region: MosaicFieldOfView

	// Effective overlap used by the plan.
	readonly overlap: MosaicOverlap

	// Number of columns in the mosaic.
	readonly columns: number

	// Number of rows in the mosaic.
	readonly rows: number

	// Effective central angular coverage in radians after panel counts are rounded upward.
	readonly coverage: MosaicFieldOfView

	// Panels in capture order. Each panel index equals its array position.
	readonly panels: readonly MosaicPanel[]
}

// Orthonormal basis for the shared reference tangent plane.
export interface MosaicBasis {
	// Unit vector toward the mosaic center.
	readonly cx: number

	// Unit vector toward the mosaic center.
	readonly cy: number

	// Unit vector toward the mosaic center.
	readonly cz: number

	// Rotated local x axis in the tangent plane.
	readonly ux: number

	// Rotated local x axis in the tangent plane.
	readonly uy: number

	// Rotated local x axis in the tangent plane.
	readonly uz: number

	// Rotated local y axis in the tangent plane.
	readonly vx: number

	// Rotated local y axis in the tangent plane.
	readonly vy: number

	// Rotated local y axis in the tangent plane.
	readonly vz: number
}

// Validates that a value is finite and returns it unchanged.
function validateFiniteField(value: number, field: string) {
	if (!Number.isFinite(value)) throw new RangeError(`${field} must be finite`)
	return value
}

// Validates an angular dimension accepted by the shared tangent-plane model.
function validateDimension(value: Angle, field: string) {
	validateFiniteField(value, field)
	if (value <= 0 || value >= PI) throw new RangeError(`${field} must be within (0, ${PI})`)
	return value
}

// Validates a fractional overlap axis.
function validateOverlap(value: number, field: string) {
	validateFiniteField(value, field)
	if (value < 0 || value >= 1) throw new RangeError(`${field} must be within [0, 1)`)
	return value
}

// Validates a declination in radians.
function validateDeclination(value: Angle, field: string) {
	validateFiniteField(value, field)
	if (value < -PIOVERTWO || value > PIOVERTWO) throw new RangeError(`${field} must be within [-${PIOVERTWO}, ${PIOVERTWO}]`)
	return value
}

// Validates and normalizes a traversal strategy.
function validateTraversal(value: MosaicTraversal) {
	if (value !== 'ROW_MAJOR' && value !== 'SERPENTINE') throw new RangeError('traversal must be ROW_MAJOR or SERPENTINE')
	return value
}

// Converts an angular field size in radians to its shared tangent-plane size.
function planeSize(angle: Angle) {
	return 2 * Math.tan(angle / 2)
}

// Converts a shared tangent-plane size to its central angular extent in radians.
function angularSize(size: number): Angle {
	return 2 * Math.atan(size / 2)
}

// Returns a tolerance scaled to the magnitude of a panel-count division.
function countBoundaryTolerance(value: number) {
	return Number.EPSILON * Math.max(1, Math.abs(value)) * COUNT_EPSILON_FACTOR
}

// Returns a tolerance scaled to the largest reference-plane extent in the count check.
function coverageTolerance(panelPlaneSize: number, regionPlaneSize: number, coveragePlaneSize: number, step: number, count: number) {
	return Number.EPSILON * Math.max(1, panelPlaneSize, regionPlaneSize, coveragePlaneSize, step * count) * COVERAGE_EPSILON_FACTOR
}

// Checks that a panel count can be represented safely and later used as an array length.
function validatePanelCount(count: number, field: string) {
	if (!Number.isSafeInteger(count) || count < 1 || count > MAX_ARRAY_LENGTH) throw new RangeError(`${field} must be a safe positive array length`)
	return count
}

// Computes the number of panels required along one reference-plane axis.
function panelCount(panelPlaneSize: number, regionPlaneSize: number, step: number, field: string) {
	if (!Number.isFinite(step) || step <= 0) throw new RangeError(`${field} step must be finite and positive`)

	let count = 1
	if (regionPlaneSize > panelPlaneSize) {
		const requiredSteps = (regionPlaneSize - panelPlaneSize) / step
		const nearestInteger = Math.round(requiredSteps)
		const adjustedSteps = Math.abs(requiredSteps - nearestInteger) <= countBoundaryTolerance(requiredSteps) ? nearestInteger : requiredSteps
		count = Math.ceil(adjustedSteps) + 1
	}

	count = validatePanelCount(count, field)

	let coveragePlaneSize = panelPlaneSize + (count - 1) * step
	if (coveragePlaneSize + coverageTolerance(panelPlaneSize, regionPlaneSize, coveragePlaneSize, step, count) < regionPlaneSize) {
		count = validatePanelCount(count + 1, field)
		coveragePlaneSize = panelPlaneSize + (count - 1) * step
	}

	return count
}

// Ensures a total panel count is valid for preallocating the result array.
function validateTotalPanelCount(rows: number, columns: number) {
	const total = rows * columns
	if (!Number.isSafeInteger(total) || total < 1 || total > MAX_ARRAY_LENGTH) throw new RangeError('total panel count must be a safe positive array length')
	return total
}

// Builds the rotated tangent-plane basis from the normalized center and position angle.
export function mosaicBasis(center: MosaicCoordinate, positionAngle: Angle): MosaicBasis {
	const sinRa = Math.sin(center.ra)
	const cosRa = Math.cos(center.ra)
	const sinDec = Math.sin(center.dec)
	const cosDec = Math.cos(center.dec)
	const sinPositionAngle = Math.sin(positionAngle)
	const cosPositionAngle = Math.cos(positionAngle)
	const cx = cosDec * cosRa
	const cy = cosDec * sinRa
	const cz = sinDec
	const ex = -sinRa
	const ey = cosRa
	const nx = -cosRa * sinDec
	const ny = -sinRa * sinDec
	const nz = cosDec

	return {
		cx,
		cy,
		cz,
		ux: ex * cosPositionAngle - nx * sinPositionAngle,
		uy: ey * cosPositionAngle - ny * sinPositionAngle,
		uz: -nz * sinPositionAngle,
		vx: ex * sinPositionAngle + nx * cosPositionAngle,
		vy: ey * sinPositionAngle + ny * cosPositionAngle,
		vz: nz * cosPositionAngle,
	}
}

// Projects a point from the shared reference tangent plane onto the celestial sphere.
function projectPlanePoint(basis: MosaicBasis, x: number, y: number): MosaicCoordinate {
	const qx = basis.cx + basis.ux * x + basis.vx * y
	const qy = basis.cy + basis.uy * x + basis.vy * y
	const qz = basis.cz + basis.uz * x + basis.vz * y
	const length = Math.hypot(qx, qy, qz)
	const px = qx / length
	const py = qy / length
	const pz = qz / length

	return {
		ra: normalizeAngle(Math.atan2(py, px)),
		dec: Math.atan2(pz, Math.hypot(px, py)),
	}
}

// Projects all four panel corners from the shared reference tangent plane.
function projectFootprint(basis: MosaicBasis, x: number, y: number, halfWidth: number, halfHeight: number): MosaicFootprint {
	return {
		northWest: projectPlanePoint(basis, x - halfWidth, y + halfHeight),
		northEast: projectPlanePoint(basis, x + halfWidth, y + halfHeight),
		southEast: projectPlanePoint(basis, x + halfWidth, y - halfHeight),
		southWest: projectPlanePoint(basis, x - halfWidth, y - halfHeight),
	}
}

// Plans a rectangular astronomical mosaic in equatorial coordinates.
//
// All angular inputs are radians. Panel dimensions, requested region dimensions,
// spacing, coverage, and footprints are defined on one shared gnomonic tangent
// plane centered on `input.center`; remote footprints are therefore inverse
// projections of shared-plane rectangles, not independent per-panel tangent FOVs.
export function planMosaic(input: MosaicPlanInput): MosaicPlan {
	const center: MosaicCoordinate = {
		ra: normalizeAngle(validateFiniteField(input.center.ra, 'center.ra')),
		dec: validateDeclination(input.center.dec, 'center.dec'),
	}
	const panel: MosaicFieldOfView = {
		width: validateDimension(input.panel.width, 'panel.width'),
		height: validateDimension(input.panel.height, 'panel.height'),
	}
	const region: MosaicFieldOfView = {
		width: validateDimension(input.region.width, 'region.width'),
		height: validateDimension(input.region.height, 'region.height'),
	}
	const overlap: MosaicOverlap = {
		x: validateOverlap(input.overlap?.x ?? 0, 'overlap.x'),
		y: validateOverlap(input.overlap?.y ?? 0, 'overlap.y'),
	}
	const positionAngle = normalizePI(validateFiniteField(input.positionAngle ?? 0, 'positionAngle'))
	const traversal = validateTraversal(input.traversal ?? 'ROW_MAJOR')
	const panelPlaneWidth = planeSize(panel.width)
	const panelPlaneHeight = planeSize(panel.height)
	const regionPlaneWidth = planeSize(region.width)
	const regionPlaneHeight = planeSize(region.height)
	const stepX = panelPlaneWidth * (1 - overlap.x)
	const stepY = panelPlaneHeight * (1 - overlap.y)
	const columns = panelCount(panelPlaneWidth, regionPlaneWidth, stepX, 'columns')
	const rows = panelCount(panelPlaneHeight, regionPlaneHeight, stepY, 'rows')
	const panelTotal = validateTotalPanelCount(rows, columns)
	const coveragePlaneWidth = panelPlaneWidth + (columns - 1) * stepX
	const coveragePlaneHeight = panelPlaneHeight + (rows - 1) * stepY
	const coverage: MosaicFieldOfView = {
		width: angularSize(coveragePlaneWidth),
		height: angularSize(coveragePlaneHeight),
	}
	const basis = mosaicBasis(center, positionAngle)
	const halfWidth = panelPlaneWidth / 2
	const halfHeight = panelPlaneHeight / 2
	const halfColumnSpan = (columns - 1) / 2
	const halfRowSpan = (rows - 1) / 2
	const panels = new Array<MosaicPanel>(panelTotal)
	let index = 0

	for (let row = 0; row < rows; row++) {
		const y = (halfRowSpan - row) * stepY
		const startColumn = traversal === 'SERPENTINE' && row % 2 === 1 ? columns - 1 : 0
		const endColumn = traversal === 'SERPENTINE' && row % 2 === 1 ? -1 : columns
		const columnStep = traversal === 'SERPENTINE' && row % 2 === 1 ? -1 : 1

		for (let column = startColumn; column !== endColumn; column += columnStep) {
			const x = (column - halfColumnSpan) * stepX
			panels[index] = {
				index,
				row,
				column,
				center: projectPlanePoint(basis, x, y),
				footprint: projectFootprint(basis, x, y, halfWidth, halfHeight),
			}
			index++
		}
	}

	return {
		center,
		positionAngle,
		panel,
		region,
		overlap,
		columns,
		rows,
		coverage,
		panels,
	}
}
