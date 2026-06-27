import { validatePositiveFinite, validatePositiveInteger } from '../../../core/validation'
import type { MutVec3 } from '../../../math/linear-algebra/vec3'
import { type NumberArray, clamp } from '../../../math/numerical/math'
import { normalizeAngle, type Angle } from '../../../math/units/angle'
import { eraS2c } from '../../coordinates/erfa/erfa'

export type AstrometricInterpolationMethod = 'nearest' | 'bilinear' | 'catmullRom' | 'cubicConvolution' //  | 'naturalCubic' | 'cubicHermite' | 'pchip' | 'akima' | 'chebyshev'

export interface AstrometricInterpolatorOptions {
	interpolation?: AstrometricInterpolationMethod // Local interpolation method used for each Cartesian component.
	cubicTension?: number // Cubic convolution parameter. The default -0.5 is the Catmull-Rom convention.
}

const CUBIC_CONVOLUTION_DEFAULT_TENSION = -0.5
const MIN_INTERPOLATED_VECTOR_LENGTH = 1e-12

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

// Blends one grid bilinearly from a precomputed stencil. `o0`/`o1` are the row base offsets
// (row * width) and `c0`/`c1` the column indices; `tx`/`ty` are the fractional cell positions.
function bilinearAt(grid: Float64Array, o0: number, o1: number, c0: number, c1: number, tx: number, ty: number) {
	const p00 = grid[o0 + c0]
	const p10 = grid[o0 + c1]
	const p01 = grid[o1 + c0]
	const p11 = grid[o1 + c1]
	const a = p00 + (p10 - p00) * tx
	const b = p01 + (p11 - p01) * tx
	return a + (b - a) * ty
}

// Blends one grid with a bicubic Catmull-Rom kernel from a precomputed 4x4 stencil. `o0..o3` are the
// row base offsets (row * width) and `c0..c3` the column indices; `tx`/`ty` are the fractional positions.
function bicubicCatmullRomAt(grid: Float64Array, o0: number, o1: number, o2: number, o3: number, c0: number, c1: number, c2: number, c3: number, tx: number, ty: number) {
	const a = cubicCatmullRom(grid[o0 + c0], grid[o0 + c1], grid[o0 + c2], grid[o0 + c3], tx)
	const b = cubicCatmullRom(grid[o1 + c0], grid[o1 + c1], grid[o1 + c2], grid[o1 + c3], tx)
	const c = cubicCatmullRom(grid[o2 + c0], grid[o2 + c1], grid[o2 + c2], grid[o2 + c3], tx)
	const d = cubicCatmullRom(grid[o3 + c0], grid[o3 + c1], grid[o3 + c2], grid[o3 + c3], tx)
	return cubicCatmullRom(a, b, c, d, ty)
}

// Blends one grid with a Keys bicubic convolution kernel from a precomputed 4x4 stencil. `o0..o3` are
// the row base offsets (row * width) and `c0..c3` the column indices; `tension` is the kernel parameter.
function bicubicConvolutionAt(grid: Float64Array, o0: number, o1: number, o2: number, o3: number, c0: number, c1: number, c2: number, c3: number, tx: number, ty: number, tension: number) {
	const a = cubicConvolution(grid[o0 + c0], grid[o0 + c1], grid[o0 + c2], grid[o0 + c3], tx, tension)
	const b = cubicConvolution(grid[o1 + c0], grid[o1 + c1], grid[o1 + c2], grid[o1 + c3], tx, tension)
	const c = cubicConvolution(grid[o2 + c0], grid[o2 + c1], grid[o2 + c2], grid[o2 + c3], tx, tension)
	const d = cubicConvolution(grid[o3 + c0], grid[o3 + c1], grid[o3 + c2], grid[o3 + c3], tx, tension)
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
	// Reusable output buffer for the interpolated Cartesian vector, avoiding per-query allocation.
	private readonly scratch: MutVec3 = [0, 0, 0]

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
		const vector = this.interpolateVector(gx, gy)
		const vx = vector[0]
		const vy = vector[1]
		const vz = vector[2]
		const length = Math.sqrt(vx * vx + vy * vy + vz * vz)

		if (!(length > MIN_INTERPOLATED_VECTOR_LENGTH) || !Number.isFinite(length)) return this.nearestSky(gx, gy, out)

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

	// Interpolates the x/y/z Cartesian grids at grid coordinate (gx, gy) into the reusable scratch buffer.
	// The integer stencil and method dispatch are computed once and shared across all three components.
	private interpolateVector(gx: number, gy: number): MutVec3 {
		const width = this.width
		const out = this.scratch

		switch (this.interpolation) {
			case 'nearest': {
				const index = rowMajorIndex(clampIndex(Math.round(gy), this.height - 1), clampIndex(Math.round(gx), width - 1), width)
				out[0] = this.xGrid[index]
				out[1] = this.yGrid[index]
				out[2] = this.zGrid[index]
				return out
			}
			case 'bilinear': {
				const maxCol = width - 1
				const maxRow = this.height - 1
				const ix = Math.floor(gx)
				const iy = Math.floor(gy)
				const tx = gx - ix
				const ty = gy - iy
				const c0 = clampIndex(ix, maxCol)
				const c1 = clampIndex(ix + 1, maxCol)
				const o0 = clampIndex(iy, maxRow) * width
				const o1 = clampIndex(iy + 1, maxRow) * width
				out[0] = bilinearAt(this.xGrid, o0, o1, c0, c1, tx, ty)
				out[1] = bilinearAt(this.yGrid, o0, o1, c0, c1, tx, ty)
				out[2] = bilinearAt(this.zGrid, o0, o1, c0, c1, tx, ty)
				return out
			}
			case 'catmullRom':
			case 'cubicConvolution': {
				const maxCol = width - 1
				const maxRow = this.height - 1
				const ix = Math.floor(gx)
				const iy = Math.floor(gy)
				const tx = gx - ix
				const ty = gy - iy
				const c0 = clampIndex(ix - 1, maxCol)
				const c1 = clampIndex(ix, maxCol)
				const c2 = clampIndex(ix + 1, maxCol)
				const c3 = clampIndex(ix + 2, maxCol)
				const o0 = clampIndex(iy - 1, maxRow) * width
				const o1 = clampIndex(iy, maxRow) * width
				const o2 = clampIndex(iy + 1, maxRow) * width
				const o3 = clampIndex(iy + 2, maxRow) * width

				if (this.interpolation === 'cubicConvolution') {
					const tension = this.cubicTension
					out[0] = bicubicConvolutionAt(this.xGrid, o0, o1, o2, o3, c0, c1, c2, c3, tx, ty, tension)
					out[1] = bicubicConvolutionAt(this.yGrid, o0, o1, o2, o3, c0, c1, c2, c3, tx, ty, tension)
					out[2] = bicubicConvolutionAt(this.zGrid, o0, o1, o2, o3, c0, c1, c2, c3, tx, ty, tension)
				} else {
					out[0] = bicubicCatmullRomAt(this.xGrid, o0, o1, o2, o3, c0, c1, c2, c3, tx, ty)
					out[1] = bicubicCatmullRomAt(this.yGrid, o0, o1, o2, o3, c0, c1, c2, c3, tx, ty)
					out[2] = bicubicCatmullRomAt(this.zGrid, o0, o1, o2, o3, c0, c1, c2, c3, tx, ty)
				}

				return out
			}
		}
	}
}
