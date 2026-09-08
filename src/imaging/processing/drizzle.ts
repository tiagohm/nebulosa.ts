import type { AffineTransform } from '../../astrometry/matching/star.matching'
import { cfaChannelAt, DEFAULT_GRAYSCALE, type Image } from '../model/types'
import { broadcastNormalizationPlanes, type GlobalNormalizationMode, NORMALIZATION_SAMPLE_LIMIT, type NormalizationColorMode, type NormalizationParameters, solveGlobalNormalization } from './normalization'

// Forward square-drop reconstruction in zero-based pixel centers, x right/y down. S stores
// fractional sample sums and W their dimensionless denominators. Means preserve intensity; sums
// preserve deposited sample totals before masking/cropping. Scratch is reused, never per pixel.
// Fractional overlaps follow https://arxiv.org/abs/astro-ph/9808087 with intensity-normalized means.

// Prepared affine footprint on the output grid. Allocated once per frame, without retaining its image.
export interface DrizzleFootprint {
	// Input-center to output-center affine map.
	readonly matrix: AffineTransform
	// Four clockwise or counterclockwise corner offsets, interleaved x/y.
	readonly corners: Float64Array
	// Positive drop area in squared output-pixel units.
	readonly area: number
	// Finite reciprocal of area, precomputed per frame.
	readonly inverseArea: number
	// Absolute horizontal extent about the drop center, output pixels.
	readonly halfWidth: number
	// Absolute vertical extent about the drop center, output pixels.
	readonly halfHeight: number
	// True only for exactly diagonal or antidiagonal matrices.
	readonly axisAligned: boolean
}

// Fixed reconstruction storage. All arrays are owned by one batch or live stack.
export interface DrizzleAccumulator {
	// Output grid width, in pixels.
	readonly width: number
	// Output grid height, in pixels.
	readonly height: number
	// Interleaved image channels: one for mono, three for RGB/CFA.
	readonly channels: number
	// One shared denominator for mono/RGB, three color denominators for CFA.
	readonly weightChannels: 1 | 3
	// Effective horizontal output samples per reference pixel.
	readonly scaleX: number
	// Effective vertical output samples per reference pixel.
	readonly scaleY: number
	// Interleaved Float64 fractional sample sums, initially zero.
	readonly sum: Float64Array
	// Row-major Float64 denominators, initially zero.
	readonly weights: Float64Array
	// Optional per-frame coverage counts.
	readonly coverage?: Uint32Array
	// Optional last contributing generation, allocated together with coverage.
	readonly stamp?: Uint32Array
	// Input clipping polygon scratch, at most eight interleaved x/y vertices.
	readonly polygon: Float64Array
	// Alternate clipping polygon scratch with the same capacity.
	readonly clipped: Float64Array
	// At most NORMALIZATION_SAMPLE_LIMIT reference samples for the currently fitted plane.
	readonly referenceSamples: number[]
	// Corresponding target samples; cleared together with referenceSamples after fitting.
	readonly currentSamples: number[]
}

// Conservative bounded scratch including three planes' numeric samples and sorting copies.
const DRIZZLE_SCRATCH_BYTES = 3 * 4 * 8 * NORMALIZATION_SAMPLE_LIMIT + 1024

// Computes the numeric-buffer peak for a state and one uncropped live snapshot, in bytes. Includes
// optional exposed-map copies, output precision (4/8 bytes), and bounded photometric/clipping scratch.
export function drizzleMemoryBytes(pixels: number, channels: number, weightChannels: number, countCoverage: boolean, exposeMaps: boolean, sampleBytes: number) {
	return pixels * (8 * (channels + weightChannels) + (countCoverage ? 8 : 0) + 1 + sampleBytes * channels + (exposeMaps ? 4 + 8 * weightChannels : 0)) + DRIZZLE_SCRATCH_BYTES
}

// Allocates one fixed grid after checking all products and the peak budget. Dimensions are reference
// pixels, scale is finite >=1, sampleBytes is 4/8, and maxMemoryBytes is a positive safe integer.
// channels is 1 (mono) or 3 (RGB/CFA); cfa requires 3. countCoverage retains frame counts and stamps;
// exposeMaps budgets snapshot copies and requires countCoverage. The returned state owns fresh buffers.
// Throws before allocation for unsafe lengths or a budget overrun; no partially built state escapes.
export function createDrizzleAccumulator(width: number, height: number, channels: number, cfa: boolean, scale: number, countCoverage: boolean, exposeMaps: boolean, sampleBytes: number, maxMemoryBytes: number): DrizzleAccumulator {
	const outputWidth = Math.round(width * scale)
	const outputHeight = Math.round(height * scale)
	const pixels = outputWidth * outputHeight
	const weightChannels = cfa ? 3 : 1
	const peak = drizzleMemoryBytes(pixels, channels, weightChannels, countCoverage, exposeMaps, sampleBytes)

	if (!Number.isSafeInteger(outputWidth) || !Number.isSafeInteger(outputHeight) || !(outputWidth > 0 && outputHeight > 0) || !Number.isSafeInteger(pixels * channels) || !Number.isSafeInteger(peak) || !(peak <= maxMemoryBytes)) {
		throw new RangeError('Drizzle grid exceeds the numeric buffer memory budget or safe allocation length')
	}

	return {
		width: outputWidth,
		height: outputHeight,
		channels,
		weightChannels,
		scaleX: outputWidth / width,
		scaleY: outputHeight / height,
		sum: new Float64Array(pixels * channels),
		weights: new Float64Array(pixels * weightChannels),
		coverage: countCoverage ? new Uint32Array(pixels) : undefined,
		stamp: countCoverage ? new Uint32Array(pixels) : undefined,
		polygon: new Float64Array(16),
		clipped: new Float64Array(16),
		referenceSamples: [],
		currentSamples: [],
	}
}

// Composes a target-to-reference affine with edge-preserving output scale. pixfrac is in (0,1].
// Returns undefined when the footprint collapses at the largest transformed sensor coordinate;
// rejecting here prevents partial deposition or an implicit point kernel. No absolute determinant cut.
export function prepareDrizzleFootprint(transform: AffineTransform, scaleX: number, scaleY: number, pixfrac: number, width: number, height: number): DrizzleFootprint | undefined {
	const matrix = { m00: scaleX * transform.m00, m01: scaleX * transform.m01, m10: scaleY * transform.m10, m11: scaleY * transform.m11, tx: scaleX * (transform.tx + 0.5) - 0.5, ty: scaleY * (transform.ty + 0.5) - 0.5 }
	const { m00, m01, m10, m11, tx, ty } = matrix
	const h = pixfrac / 2
	const corners = new Float64Array([-h * (m00 + m01), -h * (m10 + m11), h * (m00 - m01), h * (m10 - m11), h * (m00 + m01), h * (m10 + m11), h * (m01 - m00), h * (m11 - m10)])
	const area = pixfrac * pixfrac * Math.abs(m00 * m11 - m01 * m10)
	const inverseArea = 1 / area
	const halfWidth = h * (Math.abs(m00) + Math.abs(m01))
	const halfHeight = h * (Math.abs(m10) + Math.abs(m11))
	const maxX = Math.abs(tx) + Math.abs(m00) * width + Math.abs(m01) * height
	const maxY = Math.abs(ty) + Math.abs(m10) * width + Math.abs(m11) * height

	if (!Number.isFinite(maxX) || !Number.isFinite(maxY) || !Number.isFinite(area) || !Number.isFinite(inverseArea) || !(area > 0 && halfWidth > 0 && halfHeight > 0) || maxX + halfWidth === maxX || maxY + halfHeight === maxY) return undefined

	for (let i = 0; i < 8; i += 2) {
		const next = (i + 2) & 7
		if (!Number.isFinite(corners[i]) || !Number.isFinite(corners[i + 1])) return undefined
		if (maxX + corners[i] === maxX + corners[next] && maxY + corners[i + 1] === maxY + corners[next + 1]) return undefined
	}

	return { matrix, corners, area, inverseArea, halfWidth, halfHeight, axisAligned: (m01 === 0 && m10 === 0) || (m00 === 0 && m11 === 0) }
}

// Clips a convex quadrilateral already in polygon against a centered rectangle of half extents hx/hy.
// Mutates both eight-vertex scratch buffers; returns absolute triangulated area in squared pixel units.
function clippedArea(polygon: Float64Array, clipped: Float64Array, hx: number, hy: number) {
	let input = polygon
	let output = clipped
	let count = 4

	for (let side = 0; side < 4 && count > 0; side++) {
		const axis = side & 1
		const sign = side < 2 ? 1 : -1
		const bound = axis === 0 ? hx : hy
		let used = 0
		let ax = input[(count - 1) * 2]
		let ay = input[(count - 1) * 2 + 1]
		let da = sign * (axis === 0 ? ax : ay) - bound

		for (let i = 0; i < count; i++) {
			const bx = input[i * 2]
			const by = input[i * 2 + 1]
			const db = sign * (axis === 0 ? bx : by) - bound

			if (da <= 0 !== db <= 0) {
				const t = da / (da - db)
				// Preserve an endpoint lying on the plane exactly. Recomputing it with t=1 can
				// create a roundoff duplicate and exceed the eight-vertex convex intersection bound.
				const x = db === 0 ? bx : axis === 0 ? sign * bound : ax + t * (bx - ax)
				const y = db === 0 ? by : axis === 1 ? sign * bound : ay + t * (by - ay)

				if (used === 0 || output[used - 2] !== x || output[used - 1] !== y) {
					output[used++] = x
					output[used++] = y
				}
			}

			if (db <= 0 && (used === 0 || output[used - 2] !== bx || output[used - 1] !== by)) {
				output[used++] = bx
				output[used++] = by
			}

			ax = bx
			ay = by
			da = db
		}

		if (used > 2 && output[0] === output[used - 2] && output[1] === output[used - 1]) used -= 2

		count = used / 2
		const swap = input
		input = output
		output = swap
	}

	let area = 0
	for (let i = 2; i < count; i++) area += (input[(i - 1) * 2] - input[0]) * (input[i * 2 + 1] - input[1]) - (input[(i - 1) * 2 + 1] - input[1]) * (input[i * 2] - input[0])
	return Math.abs(area) / 2
}

// Computes overlap of the full target sensor edges with the reference field, independently of drops.
// Reuses scratch and returns a reference-area fraction in [0,1]; transform maps target to reference.
export function drizzleOverlap(transform: AffineTransform, width: number, height: number, referenceWidth: number, referenceHeight: number, polygon: Float64Array, clipped: Float64Array) {
	const cx = (width - 1) / 2
	const cy = (height - 1) / 2
	const { m00, m01, m10, m11, tx, ty } = transform
	const x = m00 * cx + m01 * cy + tx - (referenceWidth - 1) / 2
	const y = m10 * cx + m11 * cy + ty - (referenceHeight - 1) / 2

	for (let i = 0; i < 4; i++) {
		const dx = ((i === 0 || i === 3 ? -1 : 1) * width) / 2
		const dy = ((i < 2 ? -1 : 1) * height) / 2
		polygon[i * 2] = x + m00 * dx + m01 * dy
		polygon[i * 2 + 1] = y + m10 * dx + m11 * dy
	}

	return Math.min(1, clippedArea(polygon, clipped, referenceWidth / 2, referenceHeight / 2) / (referenceWidth * referenceHeight))
}

// Returns one drop/cell intersection area. dx/dy locate the drop relative to the cell center;
// scratch is mutated. Local coordinates avoid cancellation near large absolute image coordinates.
export function drizzleDropArea(footprint: DrizzleFootprint, dx: number, dy: number, polygon: Float64Array, clipped: Float64Array) {
	let area: number

	if (footprint.axisAligned) {
		const w = Math.max(0, Math.min(0.5, dx + footprint.halfWidth) - Math.max(-0.5, dx - footprint.halfWidth))
		const h = Math.max(0, Math.min(0.5, dy + footprint.halfHeight) - Math.max(-0.5, dy - footprint.halfHeight))
		area = w * h
	} else {
		for (let i = 0; i < 8; i += 2) {
			polygon[i] = dx + footprint.corners[i]
			polygon[i + 1] = dy + footprint.corners[i + 1]
		}

		area = clippedArea(polygon, clipped, 0.5, 0.5)
	}

	return Math.max(0, Math.min(area, footprint.area, 1))
}

// Deposits an accepted frame into state, applying channel scale/offset at source reads. weight is
// positive (1 for sum/average); generation is acceptedFrames+1. Counts are updated once per frame.
// CFA routes photosites to RGB without interpolation. No allocation per sample or contribution.
export function depositDrizzle(state: DrizzleAccumulator, image: Image, footprint: DrizzleFootprint, scales: readonly number[], offsets: readonly number[], weight: number, generation: number) {
	// Count overflow cannot be repaired by resetting stamps; fail before any accumulator mutation.
	if (!(generation <= 0xffffffff)) throw new RangeError('Drizzle frame coverage exceeds Uint32 capacity')

	const { width, height, channels: inputChannels, bayer } = image.metadata
	const { matrix: m, halfWidth, halfHeight, inverseArea } = footprint
	const cfa = state.weightChannels === 3
	const phases = cfa ? [cfaChannelAt(bayer!, 0, 0), cfaChannelAt(bayer!, 1, 0), cfaChannelAt(bayer!, 0, 1), cfaChannelAt(bayer!, 1, 1)] : undefined
	const { sum, weights, coverage, stamp, channels, polygon, clipped } = state
	const { m00, m01, m10, m11, tx, ty } = m

	for (let y = 0; y < height; y++) {
		let cx = m01 * y + tx
		let cy = m11 * y + ty

		for (let x = 0; x < width; x++, cx += m00, cy += m10) {
			if ((x & 255) === 0) {
				cx = m00 * x + m01 * y + tx
				cy = m10 * x + m11 * y + ty
			}

			const left = Math.max(0, Math.floor(cx - halfWidth + 0.5))
			const right = Math.min(state.width - 1, Math.ceil(cx + halfWidth + 0.5) - 1)
			const top = Math.max(0, Math.floor(cy - halfHeight + 0.5))
			const bottom = Math.min(state.height - 1, Math.ceil(cy + halfHeight + 0.5) - 1)
			const channel = phases === undefined ? 0 : phases[((y & 1) << 1) | (x & 1)]
			const base = (y * width + x) * inputChannels
			const v0 = image.raw[base] * scales[channel] + offsets[channel]
			const v1 = inputChannels === 3 ? image.raw[base + 1] * scales[1] + offsets[1] : 0
			const v2 = inputChannels === 3 ? image.raw[base + 2] * scales[2] + offsets[2] : 0

			for (let oy = top; oy <= bottom; oy++) {
				for (let ox = left; ox <= right; ox++) {
					const area = drizzleDropArea(footprint, cx - ox, cy - oy, polygon, clipped)
					if (!(area > 0)) continue

					const q = weight * (area * inverseArea)
					const pixel = oy * state.width + ox
					const output = pixel * channels
					sum[output + channel] += v0 * q

					if (inputChannels === 3) {
						sum[output + 1] += v1 * q
						sum[output + 2] += v2 * q
					}

					weights[cfa ? output + channel : pixel] += q

					if (coverage !== undefined && stamp !== undefined && stamp[pixel] !== generation) {
						stamp[pixel] = generation
						coverage[pixel]++
					}
				}
			}
		}
	}
}

// Reads the nearest original sample within center-domain support (zero-based x/y pixels). CFA chooses
// one photosite of the requested color, never averaging the two greens; ties prefer the first phase.
// Quantile fitting requires the original noise distribution: interpolating only the target would
// interpret its reduced variance as a photometric gain. Correspondences are approximate within half
// a pixel per axis, or one pixel on a CFA phase grid. Luminance mixes co-located RGB using BT.709.
// Returns NaN outside support; no extrapolation, allocation, or pixel-buffer mutation occurs.
function normalizationSample(image: Image, x: number, y: number, plane: number, luminance: boolean, phases: readonly number[] | undefined) {
	const { width, height, channels } = image.metadata
	if (!(x >= 0 && y >= 0 && x <= width - 1 && y <= height - 1)) return Number.NaN

	if (phases !== undefined) {
		let nearest = Infinity
		let sample = Number.NaN

		for (let phase = 0; phase < 4; phase++) {
			if (phases[phase] !== plane) continue
			const px = phase & 1
			const py = phase >> 1
			const lastX = width - 1 - ((width - 1 - px) & 1)
			const lastY = height - 1 - ((height - 1 - py) & 1)
			if (!(x >= px && y >= py && x <= lastX && y <= lastY)) continue
			const sx = px + 2 * Math.round((x - px) / 2)
			const sy = py + 2 * Math.round((y - py) / 2)
			const distance = (sx - x) ** 2 + (sy - y) ** 2
			if (distance < nearest) {
				nearest = distance
				sample = image.raw[sy * width + sx]
			}
		}

		return sample
	}

	const base = (Math.round(y) * width + Math.round(x)) * channels
	if (!luminance) return image.raw[base + plane]
	return image.raw[base] * DEFAULT_GRAYSCALE.red + image.raw[base + 1] * DEFAULT_GRAYSCALE.green + image.raw[base + 2] * DEFAULT_GRAYSCALE.blue
}

// Fits global photometry from bounded, spatially distributed reference/target sky pairs. inverse maps
// original reference centers to target centers; mode none bypasses collection. CFA always fits RGB.
// Reuses state sample containers; sparse overlap falls back to two deterministic full-reference scans.
export function drizzleNormalization(state: DrizzleAccumulator, reference: Image, target: Image, inverse: AffineTransform, mode: 'none' | GlobalNormalizationMode, colorMode: NormalizationColorMode): ReturnType<typeof broadcastNormalizationPlanes> {
	const channels = state.channels
	if (mode === 'none') return { scales: new Array<number>(channels).fill(1), offsets: new Array<number>(channels).fill(0) }
	const cfa = state.weightChannels === 3
	const luminance = !cfa && channels === 3 && colorMode === 'luminance'
	const planes = luminance ? 1 : channels
	const { width, height } = reference.metadata
	const limit = NORMALIZATION_SAMPLE_LIMIT
	const nx = Math.min(width, limit, Math.max(1, Math.floor(Math.sqrt((limit * width) / height))))
	const ny = Math.min(height, Math.max(1, Math.floor(limit / nx)))
	const refPhases = cfa ? [0, 1, 2, 3].map((p) => cfaChannelAt(reference.metadata.bayer!, p & 1, p >> 1)) : undefined
	const curPhases = cfa ? [0, 1, 2, 3].map((p) => cfaChannelAt(target.metadata.bayer!, p & 1, p >> 1)) : undefined
	const parameters: NormalizationParameters[] = []
	const ref = state.referenceSamples
	const cur = state.currentSamples
	const { m00, m01, m10, m11, tx, ty } = inverse

	for (let plane = 0; plane < planes; plane++) {
		ref.length = cur.length = 0

		for (let j = 0; j < ny; j++) {
			const y = Math.floor(((j + 0.5) * height) / ny)

			for (let i = 0; i < nx; i++) {
				const x = Math.floor(((i + 0.5) * width) / nx)
				const a = normalizationSample(reference, x, y, plane, luminance, refPhases)
				const b = normalizationSample(target, m00 * x + m01 * y + tx, m10 * x + m11 * y + ty, plane, luminance, curPhases)

				if (Number.isFinite(a) && Number.isFinite(b)) {
					ref.push(a)
					cur.push(b)
				}
			}
		}

		if (ref.length < 32) {
			ref.length = cur.length = 0
			let total = 0

			for (let pass = 0; pass < 2; pass++) {
				const count = Math.min(total, limit)
				let next = count === 0 ? Infinity : Math.floor((0.5 * total) / count)
				let rank = 0

				for (let y = 0; y < height; y++) {
					for (let x = 0; x < width; x++) {
						const a = normalizationSample(reference, x, y, plane, luminance, refPhases)
						const b = normalizationSample(target, m00 * x + m01 * y + tx, m10 * x + m11 * y + ty, plane, luminance, curPhases)

						if (!Number.isFinite(a) || !Number.isFinite(b)) continue

						if (pass === 1 && rank === next) {
							ref.push(a)
							cur.push(b)
							next = ref.length < count ? Math.floor(((ref.length + 0.5) * total) / count) : Infinity
						}

						rank++
					}
				}

				if (pass === 0) total = rank
			}
		}

		parameters.push(solveGlobalNormalization(ref, cur, mode))
	}

	ref.length = cur.length = 0

	return broadcastNormalizationPlanes(parameters, channels)
}
