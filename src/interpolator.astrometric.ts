import { normalizeAngle, type Angle } from './angle'
import { eraS2c } from './erfa'
import { type NumberArray, clamp } from './math'
import { validatePositiveFinite, validatePositiveInteger } from './validation'
import type { MutVec3 } from './vec3'

export type AstrometricInterpolationMethod = 'nearest' | 'bilinear' | 'catmullRom' | 'cubicConvolution' //  | 'naturalCubic' | 'cubicHermite' | 'pchip' | 'akima' | 'chebyshev'

export interface AstrometricInterpolatorOptions {
	interpolation?: AstrometricInterpolationMethod // Local interpolation method used for each Cartesian component.
	cubicTension?: number // Cubic convolution parameter. The default -0.5 is the Catmull-Rom convention.
}

const CUBIC_CONVOLUTION_DEFAULT_TENSION = -0.5

// Returns an integer grid index clamped to [0, max].
function clampIndex(value: number, max: number) {
	if (!(value >= 0)) return 0
	if (value > max) return max
	return value | 0
}

// Clamps small floating-point drift before inverse trigonometry.
function clampUnit(value: number) {
	return clamp(value, -1, 1)
}

function rowMajorIndex(row: number, col: number, width: number) {
	return row * width + col
}

function cubicCatmullRom(p0: number, p1: number, p2: number, p3: number, t: number) {
	const t2 = t * t
	const t3 = t2 * t
	return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
}

function cubicConvolution(p0: number, p1: number, p2: number, p3: number, t: number, a: number) {
	const t2 = t * t
	const t3 = t2 * t
	return p0 * (a * (t3 - 2 * t2 + t)) + p1 * ((a + 2) * t3 - (a + 3) * t2 + 1) + p2 * (-(a + 2) * t3 + (2 * a + 3) * t2 - a * t) + p3 * (a * (t2 - t3))
}

function validateGridValue(name: string, value: number, index: number) {
	if (!Number.isFinite(value)) throw new TypeError(`${name} value at index ${index} must be finite`)
	return value
}

function validateCubicTension(value: number | undefined) {
	if (value === undefined) return CUBIC_CONVOLUTION_DEFAULT_TENSION
	if (!Number.isFinite(value)) throw new TypeError('astrometric cubic tension must be finite')
	return value
}

function interpolateNearest(grid: Float64Array, gx: number, gy: number, width: number, height: number) {
	const col = clampIndex(Math.round(gx), width - 1)
	const row = clampIndex(Math.round(gy), height - 1)
	return grid[rowMajorIndex(row, col, width)]
}

function interpolateBilinear(grid: Float64Array, gx: number, gy: number, width: number, height: number) {
	const maxCol = width - 1
	const maxRow = height - 1
	const ix = Math.floor(gx)
	const iy = Math.floor(gy)
	const tx = gx - ix
	const ty = gy - iy
	const col0 = clampIndex(ix, maxCol)
	const col1 = clampIndex(ix + 1, maxCol)
	const row0 = clampIndex(iy, maxRow)
	const row1 = clampIndex(iy + 1, maxRow)
	const p00 = grid[rowMajorIndex(row0, col0, width)]
	const p10 = grid[rowMajorIndex(row0, col1, width)]
	const p01 = grid[rowMajorIndex(row1, col0, width)]
	const p11 = grid[rowMajorIndex(row1, col1, width)]
	const a = p00 + (p10 - p00) * tx
	const b = p01 + (p11 - p01) * tx
	return a + (b - a) * ty
}

function interpolateBicubicCatmullRom(grid: Float64Array, gx: number, gy: number, width: number, height: number) {
	const maxCol = width - 1
	const maxRow = height - 1
	const ix = Math.floor(gx)
	const iy = Math.floor(gy)
	const tx = gx - ix
	const ty = gy - iy
	const col0 = clampIndex(ix - 1, maxCol)
	const col1 = clampIndex(ix, maxCol)
	const col2 = clampIndex(ix + 1, maxCol)
	const col3 = clampIndex(ix + 2, maxCol)
	const row0 = clampIndex(iy - 1, maxRow)
	const row1 = clampIndex(iy, maxRow)
	const row2 = clampIndex(iy + 1, maxRow)
	const row3 = clampIndex(iy + 2, maxRow)
	const offset0 = row0 * width
	const offset1 = row1 * width
	const offset2 = row2 * width
	const offset3 = row3 * width
	const a = cubicCatmullRom(grid[offset0 + col0], grid[offset0 + col1], grid[offset0 + col2], grid[offset0 + col3], tx)
	const b = cubicCatmullRom(grid[offset1 + col0], grid[offset1 + col1], grid[offset1 + col2], grid[offset1 + col3], tx)
	const c = cubicCatmullRom(grid[offset2 + col0], grid[offset2 + col1], grid[offset2 + col2], grid[offset2 + col3], tx)
	const d = cubicCatmullRom(grid[offset3 + col0], grid[offset3 + col1], grid[offset3 + col2], grid[offset3 + col3], tx)
	return cubicCatmullRom(a, b, c, d, ty)
}

function interpolateBicubicConvolution(grid: Float64Array, gx: number, gy: number, width: number, height: number, tension: number) {
	const maxCol = width - 1
	const maxRow = height - 1
	const ix = Math.floor(gx)
	const iy = Math.floor(gy)
	const tx = gx - ix
	const ty = gy - iy
	const col0 = clampIndex(ix - 1, maxCol)
	const col1 = clampIndex(ix, maxCol)
	const col2 = clampIndex(ix + 1, maxCol)
	const col3 = clampIndex(ix + 2, maxCol)
	const row0 = clampIndex(iy - 1, maxRow)
	const row1 = clampIndex(iy, maxRow)
	const row2 = clampIndex(iy + 1, maxRow)
	const row3 = clampIndex(iy + 2, maxRow)
	const offset0 = row0 * width
	const offset1 = row1 * width
	const offset2 = row2 * width
	const offset3 = row3 * width
	const a = cubicConvolution(grid[offset0 + col0], grid[offset0 + col1], grid[offset0 + col2], grid[offset0 + col3], tx, tension)
	const b = cubicConvolution(grid[offset1 + col0], grid[offset1 + col1], grid[offset1 + col2], grid[offset1 + col3], tx, tension)
	const c = cubicConvolution(grid[offset2 + col0], grid[offset2 + col1], grid[offset2 + col2], grid[offset2 + col3], tx, tension)
	const d = cubicConvolution(grid[offset3 + col0], grid[offset3 + col1], grid[offset3 + col2], grid[offset3 + col3], tx, tension)
	return cubicConvolution(a, b, c, d, ty, tension)
}

// Fast pixel-to-sky interpolation over a regular astrometric sample grid.
//
// RA is circular, so interpolating RA values directly can jump through pi when
// the image crosses 0/2pi. The constructor converts every RA/Dec sample into a
// Cartesian unit vector once, then `pixelToSky` interpolates x/y/z components,
// normalizes the interpolated vector, and converts it back to RA/Dec.
//
// `width` and `height` are the grid column and row counts. `stepX` and `stepY`
// are the pixel spacing between adjacent grid samples in the original image.
// Pixel queries are clamped to the sampled grid extent, so this interpolator
// never extrapolates beyond the precomputed astrometric grid.
//
// `nearest`, `bilinear`, `catmullRom`, and `cubicConvolution` are implemented as
// local kernels. Spline-like method names fall back to the local Catmull-Rom
// bicubic kernel because the project spline builders allocate model state and
// are not suitable for per-mousemove interpolation.
export class AstrometricInterpolator {
	readonly xGrid: Float64Array
	readonly yGrid: Float64Array
	readonly zGrid: Float64Array

	private readonly interpolation: AstrometricInterpolationMethod
	private readonly cubicTension: number

	constructor(
		raGrid: NumberArray,
		decGrid: NumberArray,
		readonly width: number,
		readonly height: number,
		readonly stepX: number,
		readonly stepY: number,
		options: AstrometricInterpolatorOptions = {},
	) {
		validatePositiveInteger(width)
		validatePositiveInteger(height)
		validatePositiveFinite(stepX)
		validatePositiveFinite(stepY)

		const length = width * height
		if (raGrid.length !== decGrid.length) throw new Error('astrometric RA and Dec grids must have the same length')
		if (raGrid.length !== length) throw new Error('astrometric grid length must equal width * height')

		this.interpolation = options.interpolation ?? 'catmullRom'
		this.cubicTension = validateCubicTension(options.cubicTension)
		this.xGrid = new Float64Array(length)
		this.yGrid = new Float64Array(length)
		this.zGrid = new Float64Array(length)

		const vector: MutVec3 = [0, 0, 0]

		for (let i = 0; i < length; i++) {
			eraS2c(validateGridValue('astrometric RA grid', raGrid[i], i), validateGridValue('astrometric Dec grid', decGrid[i], i), vector)
			this.xGrid[i] = vector[0]
			this.yGrid[i] = vector[1]
			this.zGrid[i] = vector[2]
		}
	}

	pixelToSky(x: number, y: number, out: [Angle, Angle] = [0, 0]): [Angle, Angle] {
		const gx = clamp(x / this.stepX, 0, this.width - 1)
		const gy = clamp(y / this.stepY, 0, this.height - 1)
		const vx = this.interpolateComponent(this.xGrid, gx, gy)
		const vy = this.interpolateComponent(this.yGrid, gx, gy)
		const vz = this.interpolateComponent(this.zGrid, gx, gy)
		const length = Math.sqrt(vx * vx + vy * vy + vz * vz)

		if (!(length > 0) || !Number.isFinite(length)) return this.nearestSky(gx, gy, out)

		const nx = vx / length
		const ny = vy / length
		const nz = vz / length

		out[0] = normalizeAngle(Math.atan2(ny, nx))
		out[1] = Math.asin(clampUnit(nz))
		return out
	}

	private nearestSky(gx: number, gy: number, out: [Angle, Angle]) {
		const index = rowMajorIndex(clampIndex(Math.round(gy), this.height - 1), clampIndex(Math.round(gx), this.width - 1), this.width)
		out[0] = normalizeAngle(Math.atan2(this.yGrid[index], this.xGrid[index]))
		out[1] = Math.asin(clampUnit(this.zGrid[index]))
		return out
	}

	private interpolateComponent(grid: Float64Array, gx: number, gy: number) {
		switch (this.interpolation) {
			case 'nearest':
				return interpolateNearest(grid, gx, gy, this.width, this.height)
			case 'bilinear':
				return interpolateBilinear(grid, gx, gy, this.width, this.height)
			case 'cubicConvolution':
				return interpolateBicubicConvolution(grid, gx, gy, this.width, this.height, this.cubicTension)
			case 'catmullRom':
				return interpolateBicubicCatmullRom(grid, gx, gy, this.width, this.height)
		}
	}
}
