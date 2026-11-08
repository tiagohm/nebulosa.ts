import type { Rect } from '../../math/numerical/geometry'
import type { NumberArray } from '../../math/numerical/math'
import { medianAbsoluteDeviationOf, medianBySelectionOf, percentileBySelectionOf, STANDARD_DEVIATION_SCALE } from '../../math/numerical/statistics'
import type { CfaPattern, Image } from '../model/types'
import { type ImageAnalysisPlane, imagePlaneGeometry, resolveAnalysisArea } from './plane'

// Robust local background level and spatial noise of one image plane (mono, one RGB channel, or one
// non-debayered CFA phase). The plane grid is split into at most 256 tiles; each tile keeps a bounded,
// regularly strided sample, rejects positive contamination with an asymmetric iterative clip, removes a
// first-order local surface, and measures the residual MAD scaled to a Gaussian sigma. Accepted tiles
// are combined by medians, so smooth gradients and isolated sources do not inflate the noise. Levels
// and sigmas are in the sample units of the image (normalized for an Image). The estimate is spatial:
// it is not a read-noise, gain, or temporal noise measurement, and correlated pixels (debayered,
// resampled, or denoised data) bias it low. Memory is bounded by the sample buffers, independent of
// the image size; nothing in the image is modified.

// Version of the estimator rules, bumped whenever thresholds or steps change a result.
export const BACKGROUND_NOISE_VERSION = 1

// Maximum number of tiles a plane grid is split into.
const MAX_BACKGROUND_TILES = 256

// Smallest tile side, in plane samples, so that each tile holds enough samples to be measured.
const MIN_TILE_SIZE = 32

// Target number of retained samples per tile; the stride is chosen so that a tile keeps at most about this
// many, rounded to an odd stride so that sampling cannot alias onto one CFA phase.
const TILE_SAMPLES = 512

// Minimum finite samples a tile needs before it is measured at all.
const MIN_TILE_SAMPLES = 32

// Lower rejection limit of the clip, in sigmas below the tile baseline; generous because sky has no
// negative sources, only noise and the occasional cold pixel.
const LOW_REJECTION_SIGMA = 5

// Upper rejection limit of the clip, in sigmas above the tile baseline, rejecting stars, hot pixels and
// bright structure.
const HIGH_REJECTION_SIGMA = 3

// Iterations of the median clip before the surface fit.
const CLIP_ITERATIONS = 5

// Iterations of surface fit plus residual clip.
const FIT_ITERATIONS = 2

// Minimum accepted samples for a first-order surface fit; fewer keep a constant baseline.
const MIN_FIT_SAMPLES = 16

// Minimum fraction of a tile's finite samples that must survive the clip for the tile to be sky.
const MIN_ACCEPTED_FRACTION = 0.5

// Largest (mean - median) / sigma of accepted residuals before a tile counts as structured; a clean
// Gaussian clipped at -5/+3 sigma gives about -0.004.
const MAX_RESIDUAL_SKEW = 0.2

// Minimum usable tiles for any estimate.
const MIN_USABLE_TILES = 3

// Fraction of usable tiles below which the estimate is uncertain.
const MIN_COVERAGE = 0.25

// Fraction of usable tiles below which the frame is flagged as dominated by structure.
const STRUCTURE_COVERAGE = 0.5

// Largest robust relative spread of tile sigmas before the frame is flagged as structured.
const TILE_SIGMA_SPREAD_LIMIT = 0.3

// Spread of tile baselines (P90 - P10), in noise sigmas, above which a strong gradient is flagged.
const GRADIENT_WARNING = 5

// Fraction of samples at a known numeric limit above which heavy clipping is flagged.
const HEAVY_CLIPPING_FRACTION = 0.05

// Correlation of horizontally adjacent residuals above which correlated noise is flagged; white noise
// gives zero within about 1/sqrt(samples).
const CORRELATION_WARNING = 0.2

// Whether the estimate could be made, is qualified by warnings, or is missing.
export type BackgroundNoiseStatus = 'measured' | 'uncertain' | 'unavailable'

// Quality flags explaining why an estimate is uncertain or how it may be biased.
export type BackgroundNoiseWarning =
	// Too few clean tiles to measure the sky.
	| 'insufficientBackground'
	// Many tiles are rejected or tile sigmas disagree: extended objects or dense fields dominate.
	| 'strongStructure'
	// Tile baselines vary by many sigmas across the area.
	| 'strongGradient'
	// Many samples sit at a known numeric limit and were excluded.
	| 'heavyClipping'
	// The plane contains NaN or infinite samples, which were skipped.
	| 'nonFinite'
	// Every accepted sample has the same value: zero dispersion is real.
	| 'constant'
	// The MAD collapsed to zero on quantized, non-constant data: the sigma is a lower bound.
	| 'quantized'
	// Adjacent residuals are correlated, so the sigma underestimates per-pixel noise.
	| 'correlatedNoisePossible'

// Local background level and spatial noise of one image plane.
export interface ImageBackgroundNoise {
	// Measurement state; level and noiseSigma are undefined when unavailable.
	readonly status: BackgroundNoiseStatus
	// Median of the accepted tile baselines, in sample units.
	readonly level?: number
	// Median of the accepted tile residual sigmas (1.4826 * MAD), in sample units.
	readonly noiseSigma?: number
	// Number of tiles accepted as background.
	readonly usedTiles: number
	// Number of tiles the plane grid was split into.
	readonly totalTiles: number
	// Number of samples contributing to the accepted tiles.
	readonly sampleCount: number
	// Fraction of the considered finite samples that did not contribute, undefined when none was considered.
	readonly rejectedFraction?: number
	// Spread (P90 - P10) of tile baselines in noise sigmas, undefined when it cannot be computed.
	readonly gradientIndicator?: number
	// Quality flags, in a stable order.
	readonly warnings: readonly BackgroundNoiseWarning[]
	// Estimator identifier.
	readonly method: 'localRobustResidualMad'
	// Estimator rules version.
	readonly version: number
}

// Options of the standalone estimator.
export interface BackgroundNoiseOptions {
	// Left/top inclusive, right/bottom exclusive integer area in image pixels; the whole image when omitted.
	readonly area?: Readonly<Rect>
	// Plane to measure: mono for a monochrome image, red/green/blue for RGB, red/green1/green2/blue for CFA.
	readonly plane?: ImageAnalysisPlane
	// Trusted image-local CFA pattern; omitted measures the mosaic as one mono plane.
	readonly cfa?: CfaPattern
	// Whether normalized 0 and 1 are the representable limits of the source, so samples there are excluded.
	readonly numericLimits?: boolean
}

// Collects bounded tile samples from the rows of one plane grid and estimates its background noise.
// Rows are given in plane-grid coordinates (0..height-1) in any chunking, each at most once.
export class BackgroundNoiseCollector {
	// Plane-grid width, in samples.
	readonly #width: number
	// Whether samples at normalized 0 or 1 are known numeric limits and must be excluded.
	readonly #numericLimits: boolean
	// Number of tile columns.
	readonly #tilesX: number
	// Number of tile rows.
	readonly #tilesY: number
	// Left edge of each tile column, in plane samples, with one extra entry for the right edge.
	readonly #lefts: Int32Array
	// Top edge of each tile row, in plane samples, with one extra entry for the bottom edge.
	readonly #tops: Int32Array
	// Sampling stride of each tile, in plane samples along both axes.
	readonly #steps: Int32Array
	// Sampled columns of each tile.
	readonly #columns: Int32Array
	// First buffer index of each tile.
	readonly #offsets: Int32Array
	// Sampled values, row-major per tile; NaN until a row is collected.
	readonly #values: Float64Array
	// Value of the plane sample right of each sampled one, NaN at the right edge.
	readonly #neighbors: Float64Array
	// Largest number of samples of one tile, sizing the scratch buffers.
	readonly #capacity: number

	// Partitions a plane grid of width x height samples (both positive) into tiles and allocates the
	// sample buffers; numericLimits excludes samples at normalized 0 and 1.
	constructor(width: number, height: number, numericLimits: boolean = false) {
		this.#width = width
		this.#numericLimits = numericLimits

		let size = Math.max(MIN_TILE_SIZE, Math.ceil(Math.sqrt((width * height) / MAX_BACKGROUND_TILES)))
		while (Math.ceil(width / size) * Math.ceil(height / size) > MAX_BACKGROUND_TILES) size++
		const tilesX = Math.ceil(width / size)
		const tilesY = Math.ceil(height / size)
		this.#tilesX = tilesX
		this.#tilesY = tilesY

		this.#lefts = new Int32Array(tilesX + 1)
		this.#tops = new Int32Array(tilesY + 1)
		for (let i = 0; i <= tilesX; i++) this.#lefts[i] = Math.floor((i * width) / tilesX)
		for (let i = 0; i <= tilesY; i++) this.#tops[i] = Math.floor((i * height) / tilesY)

		const count = tilesX * tilesY
		this.#steps = new Int32Array(count)
		this.#columns = new Int32Array(count)
		this.#offsets = new Int32Array(count)
		let total = 0
		let capacity = 0

		for (let ty = 0; ty < tilesY; ty++) {
			const tileHeight = this.#tops[ty + 1] - this.#tops[ty]

			for (let tx = 0; tx < tilesX; tx++) {
				const tile = ty * tilesX + tx
				const tileWidth = this.#lefts[tx + 1] - this.#lefts[tx]
				const stride = Math.max(1, Math.ceil(Math.sqrt((tileWidth * tileHeight) / TILE_SAMPLES)))
				// An odd stride never locks onto one phase of a 2x2 mosaic or another even-period pattern.
				const step = stride % 2 === 0 ? stride + 1 : stride
				const columns = Math.ceil(tileWidth / step)
				const samples = columns * Math.ceil(tileHeight / step)
				this.#steps[tile] = step
				this.#columns[tile] = columns
				this.#offsets[tile] = total
				total += samples
				if (samples > capacity) capacity = samples
			}
		}

		this.#values = new Float64Array(total).fill(Number.NaN)
		this.#neighbors = new Float64Array(total).fill(Number.NaN)
		this.#capacity = capacity
	}

	// Number of tiles of the plane grid.
	get totalTiles(): number {
		return this.#tilesX * this.#tilesY
	}

	// Copies the sampled values of plane row `row` from `raw`, whose plane sample k of that row is at
	// rowStart + k * columnStep. Rows that fall between sampled rows are ignored.
	collectRow(raw: Readonly<NumberArray>, rowStart: number, columnStep: number, row: number): void {
		const tops = this.#tops
		let ty = Math.min(this.#tilesY - 1, Math.floor((row * this.#tilesY) / tops[this.#tilesY]))
		while (ty > 0 && tops[ty] > row) ty--
		while (ty + 1 < this.#tilesY && tops[ty + 1] <= row) ty++
		const localY = row - tops[ty]
		const width = this.#width

		for (let tx = 0; tx < this.#tilesX; tx++) {
			const tile = ty * this.#tilesX + tx
			const step = this.#steps[tile]
			if (localY % step !== 0) continue
			const columns = this.#columns[tile]
			const base = this.#offsets[tile] + (localY / step) * columns
			const left = this.#lefts[tx]

			for (let c = 0; c < columns; c++) {
				const x = left + c * step
				const index = rowStart + x * columnStep
				this.#values[base + c] = raw[index]
				this.#neighbors[base + c] = x + 1 < width ? raw[index + columnStep] : Number.NaN
			}
		}
	}

	// Estimates the background level and noise from the collected samples. Allocates only scratch
	// buffers sized to one tile; can be called more than once.
	finish(): ImageBackgroundNoise {
		const capacity = this.#capacity
		const values = new Float64Array(capacity)
		const xs = new Float64Array(capacity)
		const ys = new Float64Array(capacity)
		const neighbors = new Float64Array(capacity)
		const residuals = new Float64Array(capacity)
		const work = new Float64Array(capacity)
		const accepted = new Uint8Array(capacity)
		const totalTiles = this.totalTiles
		const baselines = new Float64Array(totalTiles)
		const sigmas = new Float64Array(totalTiles)

		let usable = 0
		let considered = 0
		let contributing = 0
		let clipped = 0
		let collected = 0
		let nonFinite = false
		let constant = true
		let pairs = 0
		let sumProduct = 0
		let sumFirst = 0
		let sumSecond = 0

		for (let ty = 0; ty < this.#tilesY; ty++) {
			const tileHeight = this.#tops[ty + 1] - this.#tops[ty]

			for (let tx = 0; tx < this.#tilesX; tx++) {
				const tile = ty * this.#tilesX + tx
				const step = this.#steps[tile]
				const columns = this.#columns[tile]
				const offset = this.#offsets[tile]
				const samples = columns * Math.ceil(tileHeight / step)
				let n = 0

				for (let i = 0; i < samples; i++) {
					const value = this.#values[offset + i]
					collected++
					if (!(value - value === 0)) {
						nonFinite = true
						continue
					}
					if (this.#numericLimits && (value <= 0 || value >= 1)) {
						clipped++
						continue
					}
					values[n] = value
					xs[n] = (i % columns) * step
					ys[n] = Math.floor(i / columns) * step
					neighbors[n] = this.#neighbors[offset + i]
					n++
				}

				considered += n
				if (n < MIN_TILE_SAMPLES) continue

				const measured = measureTile(n, values, xs, ys, neighbors, residuals, work, accepted)
				if (measured === undefined) continue

				baselines[usable] = measured.baseline
				sigmas[usable] = measured.sigma
				usable++
				contributing += measured.accepted
				if (!measured.constant) constant = false
				pairs += measured.pairs
				sumProduct += measured.sumProduct
				sumFirst += measured.sumFirst
				sumSecond += measured.sumSecond
			}
		}

		const warnings: BackgroundNoiseWarning[] = []
		const rejectedFraction = considered > 0 ? 1 - contributing / considered : undefined

		if (usable < MIN_USABLE_TILES) {
			warnings.push('insufficientBackground')
			if (clipped > HEAVY_CLIPPING_FRACTION * collected) warnings.push('heavyClipping')
			if (nonFinite) warnings.push('nonFinite')
			return { status: 'unavailable', usedTiles: usable, totalTiles, sampleCount: contributing, rejectedFraction, warnings, method: 'localRobustResidualMad', version: BACKGROUND_NOISE_VERSION }
		}

		const level = medianBySelectionOf(baselines.subarray(0, usable), usable)
		const noiseSigma = medianBySelectionOf(sigmas.subarray(0, usable), usable)
		const sigmaSpread = noiseSigma > 0 ? medianAbsoluteDeviationOf(sigmas, noiseSigma, true, usable) / noiseSigma : 0
		const gradientIndicator = noiseSigma > 0 ? (percentileBySelectionOf(baselines, 0.9, usable) - percentileBySelectionOf(baselines, 0.1, usable)) / noiseSigma : undefined
		const correlation = pairs > 0 && sumFirst > 0 && sumSecond > 0 ? sumProduct / Math.sqrt(sumFirst * sumSecond) : 0
		const structured = usable < STRUCTURE_COVERAGE * totalTiles || sigmaSpread > TILE_SIGMA_SPREAD_LIMIT
		const isConstant = constant && noiseSigma === 0
		const quantized = noiseSigma === 0 && !isConstant

		if (usable < STRUCTURE_COVERAGE * totalTiles) warnings.push('insufficientBackground')
		if (structured) warnings.push('strongStructure')
		if (gradientIndicator !== undefined && gradientIndicator > GRADIENT_WARNING) warnings.push('strongGradient')
		if (clipped > HEAVY_CLIPPING_FRACTION * collected) warnings.push('heavyClipping')
		if (nonFinite) warnings.push('nonFinite')
		if (isConstant) warnings.push('constant')
		if (quantized) warnings.push('quantized')
		if (correlation > CORRELATION_WARNING) warnings.push('correlatedNoisePossible')

		const status: BackgroundNoiseStatus = usable < MIN_COVERAGE * totalTiles || structured || quantized ? 'uncertain' : 'measured'
		return { status, level, noiseSigma, usedTiles: usable, totalTiles, sampleCount: contributing, rejectedFraction, gradientIndicator, warnings, method: 'localRobustResidualMad', version: BACKGROUND_NOISE_VERSION }
	}
}

// Measurement of one accepted background tile.
interface TileMeasurement {
	// Baseline at the tile origin plus the residual median, in sample units.
	readonly baseline: number
	// Gaussian-scaled residual MAD, in sample units.
	readonly sigma: number
	// Number of accepted samples.
	readonly accepted: number
	// Whether every accepted sample had the same value.
	readonly constant: boolean
	// Number of accepted residual pairs with their right neighbor.
	readonly pairs: number
	// Sum of products of paired centered residuals.
	readonly sumProduct: number
	// Sum of squared centered residuals of the first members.
	readonly sumFirst: number
	// Sum of squared centered residuals of the neighbors.
	readonly sumSecond: number
}

// Clips, detrends, and measures one tile of n finite samples at local coordinates (xs, ys), returning
// undefined when the tile is dominated by contamination. All buffers are caller scratch of at least n
// entries; values is preserved, the others are overwritten.
function measureTile(n: number, values: Float64Array, xs: Float64Array, ys: Float64Array, neighbors: Float64Array, residuals: Float64Array, work: Float64Array, accepted: Uint8Array): TileMeasurement | undefined {
	work.set(values.subarray(0, n))
	let center = medianBySelectionOf(work, n)
	let sigma = medianAbsoluteDeviationOf(values, center, true, n, work)
	let count = n

	for (let iteration = 0; iteration < CLIP_ITERATIONS; iteration++) {
		const low = center - LOW_REJECTION_SIGMA * sigma
		const high = center + HIGH_REJECTION_SIGMA * sigma
		let m = 0

		for (let i = 0; i < n; i++) {
			const keep = values[i] >= low && values[i] <= high
			accepted[i] = keep ? 1 : 0
			if (keep) work[m++] = values[i]
		}

		const changed = m !== count
		count = m
		if (count < MIN_TILE_SAMPLES) return undefined
		center = medianBySelectionOf(work, count)
		for (let i = 0, k = 0; i < n; i++) if (accepted[i] === 1) work[k++] = Math.abs(values[i] - center)
		sigma = STANDARD_DEVIATION_SCALE * medianBySelectionOf(work, count)
		if (!changed && iteration > 0) break
	}

	if (count < MIN_ACCEPTED_FRACTION * n) return undefined

	let a = center
	let b = 0
	let c = 0

	for (let iteration = 0; iteration < FIT_ITERATIONS; iteration++) {
		if (count >= MIN_FIT_SAMPLES) {
			const fit = fitPlane(n, values, xs, ys, accepted)
			if (fit !== undefined) {
				a = fit[0]
				b = fit[1]
				c = fit[2]
			}
		}

		let k = 0
		for (let i = 0; i < n; i++) {
			residuals[i] = values[i] - (a + b * xs[i] + c * ys[i])
			if (accepted[i] === 1) work[k++] = residuals[i]
		}

		const median = medianBySelectionOf(work, k)
		for (let i = 0, j = 0; i < n; i++) if (accepted[i] === 1) work[j++] = Math.abs(residuals[i] - median)
		const spread = STANDARD_DEVIATION_SCALE * medianBySelectionOf(work, k)
		const low = median - LOW_REJECTION_SIGMA * spread
		const high = median + HIGH_REJECTION_SIGMA * spread
		count = 0

		for (let i = 0; i < n; i++) {
			const keep = residuals[i] >= low && residuals[i] <= high
			accepted[i] = keep ? 1 : 0
			if (keep) count++
		}

		if (count < MIN_ACCEPTED_FRACTION * n || count < MIN_TILE_SAMPLES) return undefined
	}

	let k = 0
	let mean = 0
	let first = 0
	let seen = false
	let constant = true

	for (let i = 0; i < n; i++) {
		if (accepted[i] !== 1) continue
		work[k++] = residuals[i]
		mean += residuals[i]
		if (!seen) {
			first = values[i]
			seen = true
		} else if (values[i] !== first) constant = false
	}

	mean /= k
	const median = medianBySelectionOf(work, k)
	for (let i = 0, j = 0; i < n; i++) if (accepted[i] === 1) work[j++] = Math.abs(residuals[i] - median)
	const residualSigma = STANDARD_DEVIATION_SCALE * medianBySelectionOf(work, k)
	if (residualSigma > 0 && (mean - median) / residualSigma > MAX_RESIDUAL_SKEW) return undefined

	const low = median - LOW_REJECTION_SIGMA * residualSigma
	const high = median + HIGH_REJECTION_SIGMA * residualSigma
	let pairs = 0
	let sumProduct = 0
	let sumFirst = 0
	let sumSecond = 0

	for (let i = 0; i < n; i++) {
		const neighbor = neighbors[i]
		if (accepted[i] !== 1 || !(neighbor - neighbor === 0)) continue
		const second = neighbor - (a + b * (xs[i] + 1) + c * ys[i]) - median
		if (!(second >= low - median && second <= high - median)) continue
		const firstResidual = residuals[i] - median
		pairs++
		sumProduct += firstResidual * second
		sumFirst += firstResidual * firstResidual
		sumSecond += second * second
	}

	return { baseline: a + median, sigma: residualSigma, accepted: k, constant, pairs, sumProduct, sumFirst, sumSecond }
}

// Least-squares fit of value = a + b x + c y over the accepted samples, returning [a, b, c] with a at the
// local origin, or undefined when the sample positions do not span two dimensions.
function fitPlane(n: number, values: Float64Array, xs: Float64Array, ys: Float64Array, accepted: Uint8Array): readonly [number, number, number] | undefined {
	let count = 0
	let meanX = 0
	let meanY = 0
	let meanZ = 0

	for (let i = 0; i < n; i++) {
		if (accepted[i] !== 1) continue
		count++
		meanX += xs[i]
		meanY += ys[i]
		meanZ += values[i]
	}

	meanX /= count
	meanY /= count
	meanZ /= count
	let sxx = 0
	let syy = 0
	let sxy = 0
	let sxz = 0
	let syz = 0

	for (let i = 0; i < n; i++) {
		if (accepted[i] !== 1) continue
		const x = xs[i] - meanX
		const y = ys[i] - meanY
		const z = values[i] - meanZ
		sxx += x * x
		syy += y * y
		sxy += x * y
		sxz += x * z
		syz += y * z
	}

	const determinant = sxx * syy - sxy * sxy
	// A row or column of samples leaves the normal equations singular; the caller keeps a constant baseline.
	if (!(determinant > 1e-12 * sxx * syy)) return undefined
	const b = (sxz * syy - syz * sxy) / determinant
	const c = (syz * sxx - sxz * sxy) / determinant
	return [meanZ - b * meanX - c * meanY, b, c]
}

// Estimates the background level and spatial noise of one plane of a normalized image inside an
// optional area. The plane defaults to mono for one channel without CFA, red otherwise. A CFA plane is
// selected by absolute image coordinates, so an odd area offset does not swap phases. Throws a
// RangeError for an invalid area or a plane the layout does not have.
export function estimateBackgroundNoise(image: Image, options: BackgroundNoiseOptions = {}): ImageBackgroundNoise {
	const { metadata, raw } = image
	const area = resolveAnalysisArea(options.area, metadata.width, metadata.height)
	const plane = options.plane ?? (metadata.channels === 1 && options.cfa === undefined ? 'mono' : 'red')
	const geometry = imagePlaneGeometry({ ...metadata, bayer: options.cfa }, area, plane, options.cfa)
	const collector = new BackgroundNoiseCollector(geometry?.width ?? 1, geometry?.height ?? 1, options.numericLimits)
	if (geometry !== undefined) for (let row = 0; row < geometry.height; row++) collector.collectRow(raw, geometry.rawStart + row * geometry.rawRowStep, geometry.rawColumnStep, row)
	return collector.finish()
}
