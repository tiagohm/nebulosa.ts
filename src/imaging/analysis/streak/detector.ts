import { PI } from '../../../core/constants'
import { medianBySelectionOf } from '../../../math/numerical/statistics'
import type { Image } from '../../model/types'
import { canonicalizeStreakEndpoints, normalizeStreakAngle } from './geometry'
import { DEFAULT_STREAK_DETECTION_OPTIONS, type Streak, type StreakDetectionOptions } from './types'

// Deterministic detector of straight luminous trails (satellites, aircraft, meteors) that needs no tuning.
//
// The image is reduced to one luminance plane (the mean of the channels, a 2x2 superpixel of a CFA mosaic, and a
// coarser bin for very large frames). A background and a noise level are estimated on a grid twice, the second time
// without the sources the first one found, and row and column offsets (readout banding) are removed. Round and thick
// sources, such as stars, the Moon, or a galaxy core, are masked; thin elongated sources, which may be pieces of a
// trail, are kept. The median FWHM of the stars is measured on the way. The remaining significant pixels vote in a
// Hough accumulator, and each peak, from the strongest, is verified along its line:
//
// - the line is refitted through the centroids of median transverse profiles, so it follows the trail exactly;
// - along it, blocks are scored by their ridge contrast, the median core brightness minus the brighter of the two
//   median side levels, so an edge (a limb, a cloud or nebula border) scores nothing;
// - the maximal-scoring runs of blocks become segments, whose ends are refined to a sample;
// - a segment is kept only when its contrast is significant against the noise, its transverse profile is resolved,
//   it is at least 8 times longer than wide (and much longer when far wider than the stars, like an aircraft), its
//   core is uniform along its length (a chain of stars is not), and its contrast also stands out from the same contrast
//   measured on parallel lines around it, which captures the texture of the background (nebulae, clouds, the lunar
//   surface) that pure noise statistics would underestimate;
// - segments lying along a frame edge, or locked to a sensor row or column, are artifacts and dropped.
//
// Medians make every statistic robust to the stars that remain on or beside a trail. A segment lying mostly in the
// corridor of an accepted streak is the same trail found by a neighbouring peak and is not reported again. Every
// threshold is in units of the image's own noise, texture, or stellar width, so no value has to be tuned per image.
//
// Geometry is reported in received-image pixels (origin at the center of the upper-left sample, +X right, +Y down) and
// axial angles in radians in [0, PI). The input image is never mutated; working buffers are allocated per call.

// Largest analysis plane, in pixels; larger frames are binned by an integer factor until they fit.
const MAX_PLANE_PIXELS = 4_194_304

// Side of a background grid cell, in analysis pixels. Structure larger than a few cells is treated as background.
const CELL_SIZE = 64

// Most samples taken from one grid cell for its median and MAD.
const CELL_SAMPLES = 1024

// Smallest valid samples a cell needs; other cells are filled from their neighbours.
const MIN_CELL_SAMPLES = 32

// Smallest noise level, in normalized units: one step of a 16-bit sensor. It keeps a noiseless synthetic frame finite.
const MIN_NOISE = 1 / 65535

// Significance, in sigmas of the smoothed residual, of the sources excluded from the second background estimate.
const SOURCE_SIGMA = 3

// Dilation of those sources, in analysis pixels, so their wings do not bias the background.
const SOURCE_DILATION = 2

// Significance, in sigmas of the smoothed residual, of the pixels grouped into sources that may be masked.
const COMPACT_SIGMA = 5

// Smallest ratio of the major to the minor standard deviation of a thin source that may belong to a trail, at any
// length: a piece of a trail is elongated, a star is round.
const MIN_ELONGATION = 2.5

// Largest mean thickness, in analysis pixels, of a thin source.
const MAX_THIN_THICKNESS = 12

// Smallest length-to-thickness ratio of an elongated source that can be a trail when thicker than MAX_THIN_THICKNESS.
const MIN_THICK_ASPECT = 10

// Significance, in sigmas of the smoothed residual, of the pixels that vote in the Hough accumulator.
const VOTE_SIGMA = 2

// Most voting pixels; a busier frame raises the voting threshold in steps of 0.5 sigma.
const MAX_VOTERS = 200_000

// Hough distance bin, in analysis pixels. The angle step moves a line by at most two bins at the frame corners; the
// refinement of every peak recovers the exact line.
const RHO_BIN = 2

// Fractional bits of the fixed-point Hough voting. Doubled coordinates up to 2^13 times factors up to 2^(bits - 2)
// stay well inside 32-bit integers.
const HOUGH_FRACTION_BITS = 16

// Smallest Hough peak excess over the count expected from the voting density, in Poisson sigmas.
const MIN_HOUGH_SCORE = 5

// Half side, in accumulator cells, of the neighbourhood a Hough peak must dominate.
const HOUGH_PEAK_RADIUS = 3

// Most Hough peaks verified, strongest first.
const MAX_CANDIDATES = 256

// Half width, in analysis pixels, of the trail core sampled across the line.
const CORE_HALF_WIDTH = 1

// Nearest and farthest transverse offsets, in analysis pixels, of the side samples on each side of the line.
const SIDE_INNER = 5
const SIDE_OUTER = 9

// Half width, in analysis pixels, of the median transverse profile used for the width and the centroids.
const PROFILE_HALF_WIDTH = 15

// Half width, in analysis pixels, of the window in which block centroids are measured for the line refit.
const CENTROID_HALF_WIDTH = 4

// Block length bounds, in analysis pixels; a block is half the minimum length within them.
const MIN_BLOCK_LENGTH = 4
const MAX_BLOCK_LENGTH = 32

// Block significance subtracted from every block when searching maximal runs; a run grows only through blocks whose
// mean significance exceeds it, so pure noise (zero or negative mean) never extends a run.
const BLOCK_DRIFT = 1.5

// Smallest block significance of a block counted as covered, and of a block used in a centroid fit.
const BLOCK_SIGMA = 3

// Smallest fraction of covered blocks in a segment.
const MIN_COVERAGE = 0.5

// Smallest length of a streak in units of its FWHM; a shorter dash cannot be told from two blended stars.
const MIN_ASPECT = 8

// FWHM, in stellar FWHMs, beyond which a segment is wide: a satellite or a meteor is as sharp as the stars, while a
// ridge of an edge-on galaxy or a nebula is much broader.
const WIDE_FACTOR = 2.5

// Smallest length of a wide segment in units of its FWHM, the aspect of a defocused aircraft crossing the frame.
const WIDE_ASPECT = 25

// Area bounds, in analysis pixels, of the round masked groups measured as stars: large enough to stand above the noise,
// small enough not to be saturated or blended.
const STAR_AREA = [9, 400] as const

// Most stars measured for the stellar FWHM, and the fewest it needs.
const STELLAR_SAMPLES = 64
const MIN_STELLAR_SAMPLES = 8

// Noise allowance of the longitudinal uniformity test, in noise sigmas of a core sample; pure noise has an interquartile
// range of 1.35 of them.
const UNIFORMITY_NOISE = 2.5

// Smallest detection significance of a segment, in noise sigmas of its median ridge contrast.
const MIN_SNR = 10

// Smallest significance of a segment's ridge contrast against the contrasts of its parallel lines.
const MIN_TEXTURE_SIGMA = 10

// Parallel lines measured on each side of a segment for the texture test, 4 analysis pixels apart.
const PARALLEL_LINES = 10

// Largest angle, in radians, between a segment and a pixel row or column for the sensor-grid test.
const GRID_ANGLE = (3 * PI) / 180

// Fraction of the ridge contrast of a segment that the exact pixel row or column through it must keep for the segment to
// be locked to the sensor grid.
const GRID_CONTRAST = 0.8

// Distance, in analysis pixels, from a parallel frame edge within which a whole segment is an edge artifact.
const EDGE_BAND = 32

// Normalized MAD to standard deviation, and the standard error of a median relative to that of a mean.
const MAD_SCALE = 1.482602218505602
const MEDIAN_ERROR = 1.2533141373155

// Luminance plane analyzed: the image reduced to one channel and possibly binned.
interface AnalysisPlane {
	// Row-major samples, mean of the binned pixels and channels; NaN where the source is not finite.
	readonly data: Float32Array
	// Width in analysis pixels.
	readonly width: number
	// Height in analysis pixels.
	readonly height: number
	// Received-image pixels per analysis pixel along each axis.
	readonly bin: number
}

// Bilinear grid of a per-cell statistic, with values at cell centers.
interface CellGrid {
	// Columns of cells.
	readonly columns: number
	// Rows of cells.
	readonly rows: number
	// Row-major cell values, all finite.
	readonly values: Float32Array
}

// Prepared image shared by the verification of every candidate line.
interface StreakField {
	// Width in analysis pixels.
	readonly width: number
	// Height in analysis pixels.
	readonly height: number
	// Background-subtracted, banding-free samples, in image units; NaN where invalid.
	readonly residual: Float32Array
	// Noise of the residual, in image units.
	readonly noise: CellGrid
	// Nonzero where a sample may not support a trail: masked compact sources.
	readonly mask: Uint8Array
	// Median FWHM of the stars, in analysis pixels; absent without enough of them.
	readonly stellarFwhm?: number
}

// Normal-form line of the analysis plane, clipped to the region where its whole transverse profile is inside.
interface Line {
	// Angle of the normal from +X toward +Y, in radians.
	readonly theta: number
	// Signed distance of the line from the plane center along the normal, in analysis pixels.
	readonly rho: number
	// Cosine and sine of theta; the tangent is (-sin, cos).
	readonly cos: number
	readonly sin: number
	// Point of the line nearest the plane center, in analysis pixels.
	readonly x0: number
	readonly y0: number
	// Tangent coordinate of the first sample, in analysis pixels.
	readonly t0: number
	// Samples along the clipped line, one analysis pixel apart.
	readonly count: number
}

// Transverse samples along a line, in units of the local noise; NaN where masked or outside.
interface LineSamples {
	// Mean of the core samples.
	readonly core: Float64Array
	// Mean of the side samples on the negative side of the normal.
	readonly left: Float64Array
	// Mean of the side samples on the positive side of the normal.
	readonly right: Float64Array
}

// Hough peak to verify.
interface Candidate {
	// Normal angle, in radians.
	readonly theta: number
	// Signed distance from the plane center, in analysis pixels.
	readonly rho: number
	// Peak excess, in Poisson sigmas.
	readonly score: number
}

// Accepted trail, in analysis pixels, kept to recognize its repetitions.
interface AcceptedSegment {
	// First endpoint.
	readonly xa: number
	readonly ya: number
	// Second endpoint.
	readonly xb: number
	readonly yb: number
	// Half width of its corridor.
	readonly half: number
}

// Median transverse profile of a segment.
interface TransverseProfile {
	// FWHM, in analysis pixels; at least one.
	readonly fwhm: number
	// Centroid offset of the profile along the normal, in analysis pixels.
	readonly offset: number
	// Peak above the side baseline, in image units.
	readonly peak: number
	// Integral above the baseline across the trail, in image units times analysis pixels.
	readonly integral: number
	// Whether the profile has a positive peak falling below half of it on both sides within the profile window.
	readonly resolved: boolean
}

// Detects straight trails in an image of any layout (mono, RGB, or CFA mosaic) in its normalized sample scale.
// `options.minLength` is the shortest reported trail, in received-image pixels; `options.saturationLevel` only fills
// `saturationFraction`. Returns fresh streaks, strongest first; an image without trails returns an empty list. The
// image is not mutated.
export function detectStreaks(image: Image, options: Readonly<StreakDetectionOptions> = {}): Streak[] {
	const plane = analysisPlane(image)
	const { width, height, bin } = plane
	const minLength = Math.max(MIN_BLOCK_LENGTH * 2, (options.minLength ?? DEFAULT_STREAK_DETECTION_OPTIONS.minLength) / bin)
	if (width < 2 * SIDE_OUTER + 4 || height < 2 * SIDE_OUTER + 4) return []

	const { field, significance } = prepareField(plane, minLength)
	const { candidates, thetaStep } = houghCandidates(significance, field.mask, width, height)
	const scratch = new VerificationScratch(Math.ceil(Math.hypot(width, height)) + 2)
	const streaks: Streak[] = []
	const accepted: AcceptedSegment[] = []

	for (const candidate of candidates) {
		const refined = refineCandidate(significance, field.mask, width, height, candidate, thetaStep)
		verifyLine(image, plane, field, refined.theta, refined.rho, minLength, options.saturationLevel, scratch, streaks, accepted)
	}

	return streaks.sort((a, b) => (b.snr ?? 0) - (a.snr ?? 0))
}

// Reduces the image to the luminance plane, binning very large frames and every CFA mosaic by an integer factor (even
// for a mosaic, so each bin holds whole 2x2 superpixels).
function analysisPlane(image: Image): AnalysisPlane {
	const { width, height, channels, stride, bayer } = image.metadata
	const raw = image.raw
	const mosaic = bayer !== undefined && channels === 1
	let bin = Math.max(mosaic ? 2 : 1, Math.ceil(Math.sqrt((width * height) / MAX_PLANE_PIXELS)))
	if (mosaic && bin % 2 !== 0) bin++
	const w = Math.floor(width / bin)
	const h = Math.floor(height / bin)
	const data = new Float32Array(w * h)
	const scale = 1 / (bin * bin * channels)

	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			let sum = 0

			for (let j = 0; j < bin; j++) {
				const row = (y * bin + j) * stride + x * bin * channels
				for (let i = 0; i < bin * channels; i++) sum += raw[row + i]
			}

			data[y * w + x] = Number.isFinite(sum) ? sum * scale : Number.NaN
		}
	}

	return { data, width: w, height: h, bin }
}

// Builds the residual, its noise, and the source mask, and returns the significance map of the smoothed residual the
// Hough transform votes on.
function prepareField(plane: AnalysisPlane, minLength: number) {
	const { data, width, height } = plane
	const n = width * height
	const residual = new Float32Array(n)
	const mask = new Uint8Array(n)

	// First pass: background and noise of every sample, then the sources standing above them.
	let background = cellStatistics(data, width, height)
	subtractGrid(data, background.level, width, height, residual)
	let significance = smooth(residual, width, height)
	let smoothedNoise = cellStatistics(significance, width, height).noise
	for (let i = 0; i < n; i++) if (significance[i] > SOURCE_SIGMA * sampleGrid(smoothedNoise, i % width, Math.floor(i / width))) mask[i] = 1
	dilate(mask, width, height, SOURCE_DILATION)

	// Second pass without the sources, so large bright objects stand above the background instead of shaping it.
	background = cellStatistics(data, width, height, mask)
	subtractGrid(data, background.level, width, height, residual)
	removeBanding(residual, mask, width, height)
	significance = smooth(residual, width, height)
	smoothedNoise = cellStatistics(significance, width, height, mask).noise

	for (let y = 0, i = 0; y < height; y++) {
		for (let x = 0; x < width; x++, i++) significance[i] /= sampleGrid(smoothedNoise, x, y)
	}

	mask.fill(0)
	const stars = maskCompactSources(significance, width, height, minLength, mask)
	const stellarFwhm = medianStellarFwhm(residual, width, height, stars)

	return { field: { width, height, residual, noise: background.noise, mask, ...(stellarFwhm !== undefined && { stellarFwhm }) } satisfies StreakField, significance }
}

// Median level and MAD noise of every grid cell, from at most CELL_SAMPLES finite samples outside `mask`. Cells
// without enough samples take the median of their valid neighbours, or of all valid cells; each grid is then smoothed by
// a 3x3 median so a cell dominated by one bright object does not stand out.
function cellStatistics(data: Float32Array, width: number, height: number, mask?: Uint8Array) {
	const columns = Math.ceil(width / CELL_SIZE)
	const rows = Math.ceil(height / CELL_SIZE)
	const level = new Float32Array(columns * rows).fill(Number.NaN)
	const noise = new Float32Array(columns * rows).fill(Number.NaN)
	const samples = new Float64Array(CELL_SIZE * CELL_SIZE)
	const step = Math.max(1, Math.round(Math.sqrt((CELL_SIZE * CELL_SIZE) / CELL_SAMPLES)))

	for (let row = 0; row < rows; row++) {
		for (let column = 0; column < columns; column++) {
			const x1 = Math.min(width, (column + 1) * CELL_SIZE)
			const y1 = Math.min(height, (row + 1) * CELL_SIZE)
			let count = 0

			for (let y = row * CELL_SIZE; y < y1; y += step) {
				for (let x = column * CELL_SIZE; x < x1; x += step) {
					const i = y * width + x
					const value = data[i]
					if (!Number.isNaN(value) && (mask === undefined || mask[i] === 0)) samples[count++] = value
				}
			}

			if (count < MIN_CELL_SAMPLES) continue
			const median = medianBySelectionOf(samples, count)
			for (let i = 0; i < count; i++) samples[i] = Math.abs(samples[i] - median)
			level[row * columns + column] = median
			noise[row * columns + column] = Math.max(MIN_NOISE, medianBySelectionOf(samples, count) * MAD_SCALE)
		}
	}

	return { level: smoothGrid(level, columns, rows, 0), noise: smoothGrid(noise, columns, rows, MIN_NOISE) }
}

// Fills missing cells and applies a 3x3 median to a cell grid. `fallback` is used when no cell is valid.
function smoothGrid(values: Float32Array, columns: number, rows: number, fallback: number): CellGrid {
	const valid = new Float64Array(values.length)
	let count = 0
	for (let i = 0; i < values.length; i++) if (!Number.isNaN(values[i])) valid[count++] = values[i]
	const global = count > 0 ? medianBySelectionOf(valid, count) : fallback
	const out = new Float32Array(values.length)
	const neighbours = new Float64Array(9)

	for (let row = 0; row < rows; row++) {
		for (let column = 0; column < columns; column++) {
			let m = 0

			for (let j = Math.max(0, row - 1); j <= Math.min(rows - 1, row + 1); j++) {
				for (let i = Math.max(0, column - 1); i <= Math.min(columns - 1, column + 1); i++) {
					const value = values[j * columns + i]
					if (!Number.isNaN(value)) neighbours[m++] = value
				}
			}

			out[row * columns + column] = m > 0 ? medianBySelectionOf(neighbours, m) : global
		}
	}

	return { columns, rows, values: out }
}

// Bilinear value of a cell grid at an analysis-plane position, constant beyond the outer cell centers.
function sampleGrid(grid: CellGrid, x: number, y: number) {
	const { columns, rows, values } = grid
	const gx = Math.min(Math.max((x + 0.5) / CELL_SIZE - 0.5, 0), columns - 1)
	const gy = Math.min(Math.max((y + 0.5) / CELL_SIZE - 0.5, 0), rows - 1)
	const x0 = Math.floor(gx)
	const y0 = Math.floor(gy)
	const x1 = Math.min(x0 + 1, columns - 1)
	const y1 = Math.min(y0 + 1, rows - 1)
	const fx = gx - x0
	const fy = gy - y0
	const top = values[y0 * columns + x0] * (1 - fx) + values[y0 * columns + x1] * fx
	const bottom = values[y1 * columns + x0] * (1 - fx) + values[y1 * columns + x1] * fx
	return top * (1 - fy) + bottom * fy
}

// Writes `data` minus the interpolated grid into `out`.
function subtractGrid(data: Float32Array, grid: CellGrid, width: number, height: number, out: Float32Array) {
	for (let y = 0, i = 0; y < height; y++) {
		for (let x = 0; x < width; x++, i++) out[i] = data[i] - sampleGrid(grid, x, y)
	}
}

// Subtracts from each row, then each column, the median of its samples outside `mask`, removing readout banding. A
// line with too few such samples is left unchanged. A trail removed this way would have to fill half a row or column.
function removeBanding(residual: Float32Array, mask: Uint8Array, width: number, height: number) {
	const samples = new Float64Array(Math.max(width, height))

	for (let y = 0; y < height; y++) {
		let count = 0

		for (let x = 0, i = y * width; x < width; x++, i++) {
			if (mask[i] === 0 && !Number.isNaN(residual[i])) samples[count++] = residual[i]
		}

		if (count < width / 4) continue
		const median = medianBySelectionOf(samples, count)
		for (let x = 0, i = y * width; x < width; x++, i++) residual[i] -= median
	}

	for (let x = 0; x < width; x++) {
		let count = 0

		for (let y = 0, i = x; y < height; y++, i += width) {
			if (mask[i] === 0 && !Number.isNaN(residual[i])) samples[count++] = residual[i]
		}

		if (count < height / 4) continue
		const median = medianBySelectionOf(samples, count)
		for (let y = 0, i = x; y < height; y++, i += width) residual[i] -= median
	}
}

// Separable [1 2 1]/4 smoothing, a matched filter for trails a few pixels wide; borders repeat the edge sample.
function smooth(data: Float32Array, width: number, height: number) {
	const horizontal = new Float32Array(width * height)
	const out = new Float32Array(width * height)

	for (let y = 0; y < height; y++) {
		const row = y * width

		for (let x = 0; x < width; x++) {
			horizontal[row + x] = (data[row + Math.max(0, x - 1)] + 2 * data[row + x] + data[row + Math.min(width - 1, x + 1)]) * 0.25
		}
	}

	for (let y = 0; y < height; y++) {
		const up = Math.max(0, y - 1) * width
		const row = y * width
		const down = Math.min(height - 1, y + 1) * width
		for (let x = 0; x < width; x++) out[row + x] = (horizontal[up + x] + 2 * horizontal[row + x] + horizontal[down + x]) * 0.25
	}

	return out
}

// Binary dilation of a mask by a square of the given radius, in place.
function dilate(mask: Uint8Array, width: number, height: number, radius: number) {
	const horizontal = new Uint8Array(width * height)

	for (let y = 0; y < height; y++) {
		let last = -Infinity

		for (let x = 0; x < width + radius; x++) {
			if (x < width && mask[y * width + x] !== 0) last = x
			if (x >= radius && x - last <= 2 * radius) horizontal[y * width + x - radius] = 1
		}
	}

	for (let x = 0; x < width; x++) {
		let last = -Infinity

		for (let y = 0; y < height + radius; y++) {
			if (y < height && horizontal[y * width + x] !== 0) last = y
			if (y >= radius) mask[(y - radius) * width + x] = y - last <= 2 * radius ? 1 : 0
		}
	}
}

// Groups the 8-connected samples above COMPACT_SIGMA and masks every group that cannot be a trail or a piece of one:
// round or thick groups (stars, galaxy cores, the Moon and its limb), unless long and much longer than thick. A masked
// group is dilated by half its equivalent radius plus two pixels, covering the halo below the threshold, so a star
// masks about 1.5 times its radius and the bright rim of a large object masks the glow beside it. Thin groups, such as
// a piece of a faint trail, a bright trail with the stars it crosses, or the legs of a drifting star, are kept. Returns
// the centroid and area of the round masked groups of a star's size, interleaved, in analysis pixels.
function maskCompactSources(significance: Float32Array, width: number, height: number, minLength: number, mask: Uint8Array) {
	const stars: number[] = []
	const visited = new Uint8Array(width * height)
	const queue = new Int32Array(width * height)
	// Remaining dilation of every sample, in analysis pixels; negative where no masked group reaches.
	const reach = new Float32Array(width * height).fill(-1)

	for (let seed = 0; seed < significance.length; seed++) {
		if (visited[seed] !== 0 || !(significance[seed] > COMPACT_SIGMA)) continue
		let tail = 0
		let head = 0
		let sx = 0
		let sy = 0
		let sxx = 0
		let syy = 0
		let sxy = 0
		let boundary = 0
		queue[tail++] = seed
		visited[seed] = 1

		while (head < tail) {
			const i = queue[head++]
			const x = i % width
			const y = (i - x) / width
			sx += x
			sy += y
			sxx += x * x
			syy += y * y
			sxy += x * y
			if (x === 0 || y === 0 || x === width - 1 || y === height - 1 || !(significance[i - 1] > COMPACT_SIGMA) || !(significance[i + 1] > COMPACT_SIGMA) || !(significance[i - width] > COMPACT_SIGMA) || !(significance[i + width] > COMPACT_SIGMA)) boundary++

			for (let j = Math.max(0, y - 1); j <= Math.min(height - 1, y + 1); j++) {
				for (let k = Math.max(0, x - 1); k <= Math.min(width - 1, x + 1); k++) {
					const neighbour = j * width + k
					if (visited[neighbour] !== 0 || !(significance[neighbour] > COMPACT_SIGMA)) continue
					visited[neighbour] = 1
					queue[tail++] = neighbour
				}
			}
		}

		const count = tail
		const mx = sx / count
		const my = sy / count
		const cxx = sxx / count - mx * mx
		const cyy = syy / count - my * my
		const cxy = sxy / count - mx * my
		// Length of a uniform segment with the major variance, and elongation. The mean thickness, twice the area over the
		// boundary, is the width of a line, a V, or a cross alike, and the radius of a disk.
		const discriminant = Math.sqrt(((cxx - cyy) / 2) ** 2 + cxy * cxy)
		const major = Math.max(0, (cxx + cyy) / 2 + discriminant)
		const minor = Math.max(0, (cxx + cyy) / 2 - discriminant) + 1 / 12
		const length = Math.sqrt(12 * major)
		const thickness = (2 * count) / Math.max(boundary, 1)
		// A thin elongated group may be a piece of a trail; a long group much longer than thick is a trail, or several
		// crossing ones, whose combined envelope can look round.
		const elongated = major >= MIN_ELONGATION * MIN_ELONGATION * minor
		const thin = thickness <= MAX_THIN_THICKNESS
		const long = length >= minLength && length >= MIN_THICK_ASPECT * thickness
		if ((elongated && (thin || long)) || (thin && long)) continue
		const radius = 0.5 * Math.sqrt(count / PI) + 2
		for (let k = 0; k < count; k++) reach[queue[k]] = radius
		if (count >= STAR_AREA[0] && count <= STAR_AREA[1] && major <= 2 * minor) stars.push(mx, my, count)
	}

	// Two-pass chamfer propagation: every sample keeps the largest dilation left by any masked group, less its distance.
	for (let y = 0, i = 0; y < height; y++) {
		for (let x = 0; x < width; x++, i++) {
			let value = reach[i]
			if (x > 0) value = Math.max(value, reach[i - 1] - 1)
			if (y > 0) {
				value = Math.max(value, reach[i - width] - 1)
				if (x > 0) value = Math.max(value, reach[i - width - 1] - Math.SQRT2)
				if (x < width - 1) value = Math.max(value, reach[i - width + 1] - Math.SQRT2)
			}
			reach[i] = value
		}
	}

	for (let y = height - 1, i = width * height - 1; y >= 0; y--) {
		for (let x = width - 1; x >= 0; x--, i--) {
			let value = reach[i]
			if (x < width - 1) value = Math.max(value, reach[i + 1] - 1)
			if (y < height - 1) {
				value = Math.max(value, reach[i + width] - 1)
				if (x < width - 1) value = Math.max(value, reach[i + width + 1] - Math.SQRT2)
				if (x > 0) value = Math.max(value, reach[i + width - 1] - Math.SQRT2)
			}
			reach[i] = value
			if (value >= 0) mask[i] = 1
		}
	}

	return stars
}

// Median FWHM, in analysis pixels, of at most STELLAR_SAMPLES stars spread over the list (centroid x, y, and area,
// interleaved): the diameter of the disk whose area is the number of samples above half the peak of a star over the
// median of its box border; undefined with fewer than MIN_STELLAR_SAMPLES.
function medianStellarFwhm(residual: Float32Array, width: number, height: number, stars: readonly number[]) {
	const total = stars.length / 3
	if (total < MIN_STELLAR_SAMPLES) return undefined
	const step = Math.max(1, total / STELLAR_SAMPLES)
	const fwhms: number[] = []
	const border: number[] = []

	for (let n = 0; n < total; n += step) {
		const index = 3 * Math.floor(n)
		const cx = Math.round(stars[index])
		const cy = Math.round(stars[index + 1])
		const radius = Math.ceil(Math.sqrt(stars[index + 2] / PI)) + 3
		if (cx < radius || cy < radius || cx >= width - radius || cy >= height - radius) continue
		border.length = 0

		for (let d = -radius; d <= radius; d++) {
			border.push(residual[(cy - radius) * width + cx + d], residual[(cy + radius) * width + cx + d], residual[(cy + d) * width + cx - radius], residual[(cy + d) * width + cx + radius])
		}

		border.sort((p, q) => p - q)
		const base = border[border.length >> 1]
		let peak = -Infinity
		for (let y = cy - 1; y <= cy + 1; y++) for (let x = cx - 1; x <= cx + 1; x++) peak = Math.max(peak, residual[y * width + x] - base)
		if (!(peak > 0)) continue
		let area = 0

		for (let y = cy - radius; y <= cy + radius; y++) {
			for (let x = cx - radius; x <= cx + radius; x++) if (residual[y * width + x] - base >= peak / 2) area++
		}

		fwhms.push(2 * Math.sqrt(area / PI))
	}

	if (fwhms.length < MIN_STELLAR_SAMPLES) return undefined
	fwhms.sort((p, q) => p - q)
	return fwhms[fwhms.length >> 1]
}

// Votes the unmasked samples above VOTE_SIGMA (two pixels away from the border) into a normal-form Hough accumulator
// and returns its peaks, strongest first. A peak is scored by its count above the count expected from the voting
// density along the chord of its line, in Poisson sigmas, so long and short chords compare fairly.
function houghCandidates(significance: Float32Array, mask: Uint8Array, width: number, height: number) {
	const margin = 2
	let threshold = VOTE_SIGMA
	let voters = 0
	let usable = 0

	for (let y = margin; y < height - margin; y++) {
		for (let x = margin, i = y * width + margin; x < width - margin; x++, i++) if (mask[i] === 0) usable++
	}

	for (;;) {
		voters = 0

		for (let y = margin; y < height - margin; y++) {
			for (let x = margin, i = y * width + margin; x < width - margin; x++, i++) if (mask[i] === 0 && significance[i] > threshold) voters++
		}

		if (voters <= MAX_VOTERS) break
		threshold += 0.5
	}

	// Voter coordinates are doubled and taken from the plane center, so they are exact integers for any plane size.
	const vx = new Int32Array(voters)
	const vy = new Int32Array(voters)

	for (let y = margin, k = 0; y < height - margin; y++) {
		for (let x = margin, i = y * width + margin; x < width - margin; x++, i++) {
			if (mask[i] === 0 && significance[i] > threshold) {
				vx[k] = 2 * x - (width - 1)
				vy[k++] = 2 * y - (height - 1)
			}
		}
	}

	const halfDiagonal = Math.hypot(width, height) / 2
	const rhoBins = Math.ceil((2 * halfDiagonal) / RHO_BIN) + 1
	const thetaBins = Math.ceil((PI * halfDiagonal) / (2 * RHO_BIN))
	const thetaStep = PI / thetaBins
	const offset = halfDiagonal / RHO_BIN + 0.5
	const accumulator = new Int32Array(thetaBins * rhoBins)
	// Fixed point with HOUGH_FRACTION_BITS fractional bits keeps the voting loop in integer arithmetic; the rounding of
	// the trigonometric factors moves a vote by far less than a bin over the largest plane.
	const unit = 2 ** HOUGH_FRACTION_BITS
	const fixedOffset = Math.round(offset * unit)

	for (let t = 0; t < thetaBins; t++) {
		const c = Math.round((Math.cos(t * thetaStep) / (2 * RHO_BIN)) * unit)
		const s = Math.round((Math.sin(t * thetaStep) / (2 * RHO_BIN)) * unit)
		const row = t * rhoBins
		for (let k = 0; k < voters; k++) accumulator[row + ((vx[k] * c + vy[k] * s + fixedOffset) >> HOUGH_FRACTION_BITS)]++
	}

	const density = voters / Math.max(1, usable)
	const score = new Float32Array(thetaBins * rhoBins)

	for (let t = 0; t < thetaBins; t++) {
		const c = Math.cos(t * thetaStep)
		const s = Math.sin(t * thetaStep)

		for (let r = 0; r < rhoBins; r++) {
			const count = accumulator[t * rhoBins + r]
			if (count === 0) continue
			const chord = clipLine(c, s, (r + 0.5 - offset) * RHO_BIN, width, height, 0)
			const expected = density * (chord === undefined ? 0 : chord[1] - chord[0]) * RHO_BIN
			score[t * rhoBins + r] = (count - expected) / Math.sqrt(expected + 1)
		}
	}

	const candidates: Candidate[] = []

	for (let t = 0; t < thetaBins; t++) {
		for (let r = 0; r < rhoBins; r++) {
			const value = score[t * rhoBins + r]
			if (value >= MIN_HOUGH_SCORE && isHoughPeak(score, thetaBins, rhoBins, t, r, value)) candidates.push({ theta: t * thetaStep, rho: (r + 0.5 - offset) * RHO_BIN, score: value })
		}
	}

	candidates.sort((a, b) => b.score - a.score)
	if (candidates.length > MAX_CANDIDATES) candidates.length = MAX_CANDIDATES
	return { candidates, thetaStep }
}

// Whether a cell dominates its neighbourhood; ties go to the lower index. Theta wraps with the sign of rho flipped.
function isHoughPeak(score: Float32Array, thetaBins: number, rhoBins: number, t: number, r: number, value: number) {
	const index = t * rhoBins + r

	for (let dt = -HOUGH_PEAK_RADIUS; dt <= HOUGH_PEAK_RADIUS; dt++) {
		let tt = t + dt
		let rr = r
		if (tt < 0 || tt >= thetaBins) {
			tt = (tt + thetaBins) % thetaBins
			rr = rhoBins - 1 - r
		}

		for (let dr = -HOUGH_PEAK_RADIUS; dr <= HOUGH_PEAK_RADIUS; dr++) {
			const rrr = rr + dr
			if (rrr < 0 || rrr >= rhoBins) continue
			const neighbour = tt * rhoBins + rrr
			if (neighbour === index) continue
			const other = score[neighbour]
			if (other > value || (other === value && neighbour < index)) return false
		}
	}

	return true
}

// Tangent interval of the line (normal angle with cosine `c` and sine `s`, signed distance `rho` from the plane
// center) inside the plane shrunk by `margin` analysis pixels, or undefined when it misses it.
function clipLine(c: number, s: number, rho: number, width: number, height: number, margin: number): readonly [number, number] | undefined {
	const px = (width - 1) / 2 + rho * c
	const py = (height - 1) / 2 + rho * s
	const xRange = slabInterval(px, -s, margin, width - 1 - margin)
	const yRange = slabInterval(py, c, margin, height - 1 - margin)
	if (xRange === undefined || yRange === undefined) return undefined
	const t0 = Math.max(xRange[0], yRange[0])
	const t1 = Math.min(xRange[1], yRange[1])
	return t1 > t0 ? [t0, t1] : undefined
}

// Interval of t where p + u t lies in [low, high]; unbounded when u is zero and p is inside, undefined when outside.
function slabInterval(p: number, u: number, low: number, high: number): readonly [number, number] | undefined {
	if (Math.abs(u) < 1e-12) return p < low || p > high ? undefined : [-Infinity, Infinity]
	const a = (low - p) / u
	const b = (high - p) / u
	return a < b ? [a, b] : [b, a]
}

// Builds the line clipped so its whole transverse side profile lies inside the plane.
function makeLine(theta: number, rho: number, width: number, height: number): Line | undefined {
	const c = Math.cos(theta)
	const s = Math.sin(theta)
	const chord = clipLine(c, s, rho, width, height, SIDE_OUTER + 1)
	if (chord === undefined) return undefined
	const t0 = Math.ceil(chord[0])
	return { theta, rho, cos: c, sin: s, x0: (width - 1) / 2 + rho * c, y0: (height - 1) / 2 + rho * s, t0, count: Math.floor(chord[1]) - t0 + 1 }
}

// Bilinear sample, or NaN outside the plane or next to an invalid sample.
function bilinear(data: Float32Array, width: number, height: number, x: number, y: number) {
	const x0 = Math.floor(x)
	const y0 = Math.floor(y)
	if (x0 < 0 || y0 < 0 || x0 >= width - 1 || y0 >= height - 1) return Number.NaN
	const fx = x - x0
	const fy = y - y0
	const i = y0 * width + x0
	return (data[i] * (1 - fx) + data[i + 1] * fx) * (1 - fy) + (data[i + width] * (1 - fx) + data[i + width + 1] * fx) * fy
}

// Whether the nearest sample is masked or outside the plane.
function isMasked(mask: Uint8Array, width: number, height: number, x: number, y: number) {
	const xi = Math.round(x)
	const yi = Math.round(y)
	return xi < 0 || yi < 0 || xi >= width || yi >= height || mask[yi * width + xi] !== 0
}

// Sum of the clipped significance along a line, ignoring masked samples; the objective of the coarse refinement.
function lineSupport(significance: Float32Array, mask: Uint8Array, width: number, height: number, theta: number, rho: number) {
	const c = Math.cos(theta)
	const s = Math.sin(theta)
	const chord = clipLine(c, s, rho, width, height, 1)
	if (chord === undefined) return -Infinity
	const x0 = (width - 1) / 2 + rho * c
	const y0 = (height - 1) / 2 + rho * s
	let sum = 0

	// Every other sample: the objective only has to rank nearby lines.
	for (let t = Math.ceil(chord[0]); t <= chord[1]; t += 2) {
		const x = x0 - t * s
		const y = y0 + t * c
		if (isMasked(mask, width, height, x, y)) continue
		const value = bilinear(significance, width, height, x, y)
		if (!Number.isNaN(value)) sum += Math.max(-2, Math.min(3, value))
	}

	return sum
}

// Hill-climbs a Hough peak over angle and distance, halving the steps, so its line runs within a pixel of the trail.
function refineCandidate(significance: Float32Array, mask: Uint8Array, width: number, height: number, candidate: Candidate, thetaStep: number) {
	let { theta, rho } = candidate
	let best = lineSupport(significance, mask, width, height, theta, rho)
	let dt = thetaStep
	let dr = RHO_BIN / 2

	for (let round = 0; round < 3; round++, dt /= 2, dr /= 2) {
		for (let improved = true; improved;) {
			improved = false

			for (let a = -1; a <= 1; a++) {
				for (let b = -1; b <= 1; b++) {
					if (a === 0 && b === 0) continue
					const value = lineSupport(significance, mask, width, height, theta + a * dt, rho + b * dr)

					if (value > best) {
						best = value
						theta += a * dt
						rho += b * dr
						improved = true
					}
				}
			}
		}
	}

	return { theta, rho }
}

// Reusable buffers of the line verification, sized for the longest chord of the plane.
class VerificationScratch {
	// Samples of the verified line.
	readonly line: LineSamples
	// Samples of a parallel line of the texture test.
	readonly parallel: LineSamples
	// Selection buffer of the medians.
	readonly values: Float64Array

	constructor(readonly capacity: number) {
		this.line = { core: new Float64Array(capacity), left: new Float64Array(capacity), right: new Float64Array(capacity) }
		this.parallel = { core: new Float64Array(capacity), left: new Float64Array(capacity), right: new Float64Array(capacity) }
		this.values = new Float64Array(capacity)
	}
}

// Fills `out` with the core and side means, in units of the local noise, of the samples [from, to) of the line moved
// by `offset` analysis pixels along its normal; masked or outside samples are NaN.
function sampleLine(field: StreakField, line: Line, offset: number, from: number, to: number, out: LineSamples) {
	const { residual, mask, width, height, noise } = field
	const { cos: c, sin: s, t0 } = line
	const x0 = line.x0 + offset * c
	const y0 = line.y0 + offset * s
	out.core.fill(Number.NaN, from, to)
	out.left.fill(Number.NaN, from, to)
	out.right.fill(Number.NaN, from, to)

	for (let k = from; k < to; k++) {
		const x = x0 - (t0 + k) * s
		const y = y0 + (t0 + k) * c
		if (isMasked(mask, width, height, x, y)) continue
		let sum = 0
		let count = 0

		for (let d = -CORE_HALF_WIDTH; d <= CORE_HALF_WIDTH; d++) {
			const value = bilinear(residual, width, height, x + d * c, y + d * s)

			if (!Number.isNaN(value)) {
				sum += value
				count++
			}
		}

		if (count === 0) continue
		const sigma = sampleGrid(noise, x, y)
		out.core[k] = sum / count / sigma

		for (let side = -1; side <= 1; side += 2) {
			sum = 0
			count = 0

			for (let d = SIDE_INNER; d <= SIDE_OUTER; d++) {
				const xx = x + side * d * c
				const yy = y + side * d * s
				if (isMasked(mask, width, height, xx, yy)) continue
				const value = bilinear(residual, width, height, xx, yy)

				if (!Number.isNaN(value)) {
					sum += value
					count++
				}
			}

			if (count > 0) (side < 0 ? out.left : out.right)[k] = sum / count / sigma
		}
	}
}

// Median of the finite values in [from, to), with their count; NaN when none.
function medianOfRange(values: Float64Array, from: number, to: number, buffer: Float64Array) {
	let count = 0
	for (let k = from; k < to; k++) if (!Number.isNaN(values[k])) buffer[count++] = values[k]
	return { median: count > 0 ? medianBySelectionOf(buffer, count) : Number.NaN, count }
}

// Ridge contrast of the samples [from, to): median core minus the brighter of the two side medians, and the count of
// valid core samples. An edge, bright on one side, gives zero or less.
function ridgeContrast(samples: LineSamples, from: number, to: number, buffer: Float64Array) {
	const core = medianOfRange(samples.core, from, to, buffer)
	const left = medianOfRange(samples.left, from, to, buffer).median
	const right = medianOfRange(samples.right, from, to, buffer).median
	const side = !Number.isNaN(left) ? (!Number.isNaN(right) ? Math.max(left, right) : left) : right
	return { contrast: core.median - side, side, count: core.count }
}

// Normalized MAD of the finite core samples: the noise of one core sample, in units of the local noise.
function coreScale(samples: LineSamples, count: number, buffer: Float64Array) {
	const { median, count: valid } = medianOfRange(samples.core, 0, count, buffer)
	if (valid === 0) return { scale: Number.NaN, valid }
	let m = 0
	for (let k = 0; k < count; k++) if (!Number.isNaN(samples.core[k])) buffer[m++] = Math.abs(samples.core[k] - median)
	// A noiseless frame would give zero; a quarter of the ideal scale of a three-sample core keeps it finite.
	return { scale: Math.max(0.15, medianBySelectionOf(buffer, m) * MAD_SCALE), valid }
}

// Significance of the ridge contrast of every block, or NaN for a block with less than half its samples valid.
function blockSignificances(samples: LineSamples, count: number, blockLength: number, scale: number, buffer: Float64Array) {
	const blocks = Math.floor(count / blockLength)
	const out = new Float64Array(blocks)

	for (let b = 0; b < blocks; b++) {
		const { contrast, count: valid } = ridgeContrast(samples, b * blockLength, (b + 1) * blockLength, buffer)
		out[b] = valid < blockLength / 2 || Number.isNaN(contrast) ? Number.NaN : (contrast * Math.sqrt(valid)) / (MEDIAN_ERROR * scale)
	}

	return out
}

// Centroid offset along the normal of the median transverse profile of the samples [from, to), in analysis pixels, or
// NaN when the profile has no positive part.
function blockCentroid(field: StreakField, line: Line, from: number, to: number, buffer: Float64Array) {
	const { residual, mask, width, height } = field
	const { cos: c, sin: s, x0, y0, t0 } = line
	const profile = new Float64Array(2 * CENTROID_HALF_WIDTH + 1)

	for (let d = -CENTROID_HALF_WIDTH; d <= CENTROID_HALF_WIDTH; d++) {
		let count = 0

		for (let k = from; k < to; k++) {
			const x = x0 - (t0 + k) * s
			const y = y0 + (t0 + k) * c
			if (isMasked(mask, width, height, x, y)) continue
			const value = bilinear(residual, width, height, x + d * c, y + d * s)
			if (!Number.isNaN(value)) buffer[count++] = value
		}

		profile[d + CENTROID_HALF_WIDTH] = count > 0 ? medianBySelectionOf(buffer, count) : Number.NaN
	}

	const last = 2 * CENTROID_HALF_WIDTH
	const base = Math.min(profile[0], profile[1], profile[last - 1], profile[last])
	let weight = 0
	let moment = 0

	for (let d = 1 - CENTROID_HALF_WIDTH; d < CENTROID_HALF_WIDTH; d++) {
		const value = profile[d + CENTROID_HALF_WIDTH] - base
		if (!(value > 0)) continue
		weight += value
		moment += value * d
	}

	return weight > 0 ? moment / weight : Number.NaN
}

// Weighted least-squares fit of the block centroids (blocks of [first, last] with significance at least BLOCK_SIGMA,
// weighted by it) relative to `line`: the refitted line and the RMS of the centroids about it, in analysis pixels.
function fitCentroids(field: StreakField, line: Line, significance: Float64Array, blockLength: number, first: number, last: number, buffer: Float64Array) {
	const positions: number[] = []
	const offsets: number[] = []
	const weights: number[] = []

	for (let b = first; b <= last; b++) {
		if (!(significance[b] >= BLOCK_SIGMA)) continue
		const offset = blockCentroid(field, line, b * blockLength, (b + 1) * blockLength, buffer)
		if (Number.isNaN(offset)) continue
		positions.push(line.t0 + (b + 0.5) * blockLength)
		offsets.push(offset)
		weights.push(significance[b])
	}

	if (positions.length < 2) return undefined
	let sw = 0
	let st = 0
	let sd = 0
	for (let i = 0; i < positions.length; i++) {
		sw += weights[i]
		st += weights[i] * positions[i]
		sd += weights[i] * offsets[i]
	}
	const mt = st / sw
	const md = sd / sw
	let stt = 0
	let std = 0
	for (let i = 0; i < positions.length; i++) {
		stt += weights[i] * (positions[i] - mt) ** 2
		std += weights[i] * (positions[i] - mt) * (offsets[i] - md)
	}
	if (!(stt > 0)) return undefined
	const slope = std / stt
	const intercept = md - slope * mt
	let squared = 0
	for (let i = 0; i < positions.length; i++) squared += weights[i] * (offsets[i] - intercept - slope * positions[i]) ** 2

	// The fitted offset d(t) = intercept + slope t turns the tangent by -atan(slope) and moves the line's point at t = 0.
	const theta = line.theta - Math.atan(slope)
	const c = Math.cos(theta)
	const s = Math.sin(theta)
	const rho = (line.x0 + intercept * line.cos - (field.width - 1) / 2) * c + (line.y0 + intercept * line.sin - (field.height - 1) / 2) * s
	return { theta, rho, rms: Math.sqrt(squared / sw) }
}

// All maximal-scoring runs of blocks, scoring each block by its significance minus BLOCK_DRIFT (NaN blocks score 0
// and never start a run), as inclusive block intervals.
function maximalRuns(significance: Float64Array) {
	const runs: [number, number][] = []
	const pending: [number, number][] = [[0, significance.length]]

	while (pending.length > 0) {
		const [low, high] = pending.pop()!
		let best = 0
		let bestStart = -1
		let bestEnd = -1
		let sum = 0
		let start = low

		for (let b = low; b < high; b++) {
			const value = significance[b]
			sum += !Number.isNaN(value) ? value - BLOCK_DRIFT : 0

			if (sum <= 0) {
				sum = 0
				start = b + 1
			} else if (sum > best) {
				best = sum
				bestStart = start
				bestEnd = b
			}
		}

		if (bestStart < 0) continue
		while (Number.isNaN(significance[bestStart])) bestStart++
		runs.push([bestStart, bestEnd])
		if (bestStart > low) pending.push([low, bestStart])
		if (bestEnd + 1 < high) pending.push([bestEnd + 1, high])
	}

	return runs.sort((a, b) => a[0] - b[0])
}

// Sample in [low, anchor] (start) or [anchor, high] (end) where the trail begins or ends: the one maximizing the summed
// excess of the core over `level` from it to the anchor.
function trailEnd(core: Float64Array, level: number, low: number, high: number, anchor: number, isStart: boolean) {
	low = Math.max(0, low)
	high = Math.min(core.length - 1, high)
	anchor = Math.min(Math.max(anchor, low), high)
	let best = anchor
	let bestSum = -Infinity
	let sum = 0
	const step = isStart ? -1 : 1

	for (let k = anchor; isStart ? k >= low : k <= high; k += step) {
		const value = core[k]
		if (Number.isNaN(value)) continue
		sum += value - level

		if (sum > bestSum) {
			bestSum = sum
			best = k
		}
	}

	return best
}

// Median transverse profile of the samples [from, to): FWHM by linear interpolation of the half-maximum crossings
// (the second moment when they are not found), centroid offset, peak, and integral above the median of the outer
// samples.
function transverseProfile(field: StreakField, line: Line, from: number, to: number, buffer: Float64Array): TransverseProfile {
	const { residual, mask, width, height } = field
	const { cos: c, sin: s, x0, y0, t0 } = line
	const half = PROFILE_HALF_WIDTH
	const profile = new Float64Array(2 * half + 1)

	for (let d = -half; d <= half; d++) {
		let count = 0

		for (let k = from; k < to; k++) {
			const x = x0 - (t0 + k) * s
			const y = y0 + (t0 + k) * c
			if (isMasked(mask, width, height, x, y)) continue
			const value = bilinear(residual, width, height, x + d * c, y + d * s)
			if (!Number.isNaN(value)) buffer[count++] = value
		}

		profile[d + half] = count > 0 ? medianBySelectionOf(buffer, count) : 0
	}

	const outer = new Float64Array(12)
	for (let i = 0; i < 6; i++) {
		outer[2 * i] = profile[i]
		outer[2 * i + 1] = profile[2 * half - i]
	}
	const base = medianBySelectionOf(outer, outer.length)
	let center = half
	for (let i = half - 3; i <= half + 3; i++) if (profile[i] > profile[center]) center = i
	const peak = profile[center] - base
	const level = peak / 2
	let left = center
	while (left > 0 && profile[left - 1] - base > level) left--
	let right = center
	while (right < 2 * half && profile[right + 1] - base > level) right++
	let weight = 0
	let moment = 0
	let second = 0
	let integral = 0

	for (let i = left; i <= right; i++) {
		const value = profile[i] - base
		weight += value
		moment += value * (i - half)
		second += value * (i - half) ** 2
	}

	for (let i = Math.max(0, left - (right - left + 1)); i <= Math.min(2 * half, right + (right - left + 1)); i++) integral += profile[i] - base

	let fwhm = Number.NaN
	const resolved = peak > 0 && left > 0 && right < 2 * half

	if (resolved) {
		const a = profile[left] - profile[left - 1]
		const b = profile[right] - profile[right + 1]
		const lx = left - (a > 0 ? (profile[left] - base - level) / a : 0)
		const rx = right + (b > 0 ? (profile[right] - base - level) / b : 0)
		fwhm = rx - lx
	}

	const offset = weight > 0 ? moment / weight : 0
	if (!(fwhm > 0) && weight > 0) fwhm = 2.354820045 * Math.sqrt(Math.max(0, second / weight - offset * offset))
	return { fwhm: Math.max(1, !Number.isNaN(fwhm) ? fwhm : 1), offset, peak: Math.max(0, peak), integral: Math.max(0, integral), resolved }
}

// Whether the core of the samples [from, to) is longitudinally uniform: the interquartile range of the core stays within
// its median excess over the side level plus UNIFORMITY_NOISE noise sigmas of a core sample. A chain of stars alternates
// bright peaks and dark gaps and fails it; a trail passes, even a faint one, a fading one, or one flaring over less than
// a quarter of its length.
function isUniform(samples: LineSamples, from: number, to: number, contrast: number, scale: number, buffer: Float64Array) {
	let count = 0
	for (let k = from; k < to; k++) if (!Number.isNaN(samples.core[k])) buffer[count++] = samples.core[k]
	if (count < 4) return false
	const sorted = buffer.subarray(0, count).sort()
	const range = sorted[Math.floor(0.75 * count)] - sorted[Math.floor(0.25 * count)]
	return range <= Math.max(0, contrast) + UNIFORMITY_NOISE * scale
}

// Ridge contrast significance of the samples [from, to) against the contrasts of PARALLEL_LINES lines on each side,
// starting `gap` analysis pixels away: the spread of those contrasts measures the texture of the background, never
// less than the noise of the contrast itself.
function textureSignificance(field: StreakField, line: Line, from: number, to: number, contrast: number, count: number, gap: number, scale: number, scratch: VerificationScratch) {
	const contrasts = new Float64Array(2 * PARALLEL_LINES)
	let n = 0

	for (let i = 0; i < PARALLEL_LINES; i++) {
		for (let side = -1; side <= 1; side += 2) {
			sampleLine(field, line, side * (gap + 4 * i), from, to, scratch.parallel)
			const parallel = ridgeContrast(scratch.parallel, from, to, scratch.values)
			if (parallel.count >= count / 2 && !Number.isNaN(parallel.contrast)) contrasts[n++] = parallel.contrast
		}
	}

	if (n < PARALLEL_LINES) return 0
	const median = medianBySelectionOf(contrasts, n)
	for (let i = 0; i < n; i++) contrasts[i] = Math.abs(contrasts[i] - median)
	const spread = medianBySelectionOf(contrasts, n) * MAD_SCALE
	return (contrast - median) / Math.max(spread, (MEDIAN_ERROR * scale) / Math.sqrt(count))
}

// Whether a segment from (xa, ya) to (xb, yb), in analysis pixels, lies along a frame edge, within EDGE_BAND of it and
// nearly parallel: readout rows or columns, or the border of a stacked or cropped frame.
function isEdgeArtifact(xa: number, ya: number, xb: number, yb: number, width: number, height: number) {
	const dx = Math.abs(xb - xa)
	const dy = Math.abs(yb - ya)
	const nearVertical = Math.max(xa, xb) <= EDGE_BAND || Math.min(xa, xb) >= width - 1 - EDGE_BAND
	const nearHorizontal = Math.max(ya, yb) <= EDGE_BAND || Math.min(ya, yb) >= height - 1 - EDGE_BAND
	return (nearHorizontal && dy * 8 < dx) || (nearVertical && dx * 8 < dy)
}

// Whether the samples [from, to) of a line within GRID_ANGLE of a pixel row or column are explained as well by that
// exact row or column through their middle, with at least GRID_CONTRAST of their ridge contrast: a structure locked to
// the sensor grid, such as a defective row or column segment, which no fit of a short faint segment could tell apart
// from a trail at a slightly different angle.
function isGridLocked(field: StreakField, line: Line, from: number, to: number, contrast: number, scratch: VerificationScratch) {
	const { cos: c, sin: s, x0, y0, t0 } = line
	// The tangent (-sin, cos) is horizontal when |sin| is near one, vertical when |cos| is.
	const horizontal = Math.abs(s) >= Math.cos(GRID_ANGLE)
	if (!horizontal && Math.abs(c) < Math.cos(GRID_ANGLE)) return false
	const tm = t0 + (from + to - 1) / 2
	const xm = x0 - tm * s
	const ym = y0 + tm * c
	const theta = horizontal ? PI / 2 : 0
	const rho = horizontal ? ym - (field.height - 1) / 2 : xm - (field.width - 1) / 2
	const axis = makeLine(theta, rho, field.width, field.height)
	if (axis === undefined) return false
	// Tangent coordinates of the segment ends on the axis line, whose tangent is (-1, 0) or (0, 1).
	const project = (t: number) => (horizontal ? -(x0 - t * s - axis.x0) : y0 + t * c - axis.y0) - axis.t0
	const a = Math.max(0, Math.min(axis.count, Math.round(Math.min(project(t0 + from), project(t0 + to - 1)))))
	const b = Math.max(0, Math.min(axis.count, Math.round(Math.max(project(t0 + from), project(t0 + to - 1))) + 1))
	if (b - a < (to - from) / 2) return false
	sampleLine(field, axis, 0, a, b, scratch.parallel)
	return ridgeContrast(scratch.parallel, a, b, scratch.values).contrast >= GRID_CONTRAST * contrast
}

// Half width, in analysis pixels, of the corridor of an accepted trail of the given FWHM: it holds the wings of the
// trail, where a line crossing it at a small angle would find the same trail again.
function corridorHalfWidth(fwhm: number) {
	return Math.max(4, 1.5 * fwhm + 3)
}

// Whether at least half of the samples [from, to) of the line lie in the corridor of an accepted trail: the segment is
// that trail again, found by a neighbouring Hough peak. Trails that only cross or touch an accepted one are kept whole.
function isDuplicate(line: Line, from: number, to: number, accepted: readonly AcceptedSegment[]) {
	if (accepted.length === 0) return false
	const { cos: c, sin: s, x0, y0, t0 } = line
	let inside = 0
	let total = 0

	for (let k = from; k < to; k += 2, total++) {
		const x = x0 - (t0 + k) * s
		const y = y0 + (t0 + k) * c

		for (const segment of accepted) {
			const dx = segment.xb - segment.xa
			const dy = segment.yb - segment.ya
			const t = Math.max(0, Math.min(1, ((x - segment.xa) * dx + (y - segment.ya) * dy) / Math.max(dx * dx + dy * dy, 1e-12)))

			if (Math.hypot(x - segment.xa - t * dx, y - segment.ya - t * dy) <= segment.half) {
				inside++
				break
			}
		}
	}

	return inside * 2 >= total
}

// Verifies the line (normal angle `theta`, distance `rho` from the plane center) and appends every accepted segment of
// it to `streaks` and to `accepted`, skipping segments that repeat an accepted trail.
function verifyLine(image: Image, plane: AnalysisPlane, field: StreakField, theta: number, rho: number, minLength: number, saturationLevel: number | undefined, scratch: VerificationScratch, streaks: Streak[], accepted: AcceptedSegment[]) {
	const { width, height } = field
	const blockLength = Math.max(MIN_BLOCK_LENGTH, Math.min(MAX_BLOCK_LENGTH, Math.floor(minLength / 2)))
	let line = makeLine(theta, rho, width, height)
	if (line === undefined || line.count < minLength) return
	const samples = scratch.line
	const buffer = scratch.values
	sampleLine(field, line, 0, 0, line.count, samples)
	let { scale, valid } = coreScale(samples, line.count, buffer)
	if (valid < minLength) return
	let significance = blockSignificances(samples, line.count, blockLength, scale, buffer)

	// Follow the trail: refit the line through the centroids of its significant blocks and sample it again.
	for (let iteration = 0; iteration < 2; iteration++) {
		const fit = fitCentroids(field, line, significance, blockLength, 0, significance.length - 1, buffer)
		if (fit === undefined) break
		const refitted = makeLine(fit.theta, fit.rho, width, height)
		if (refitted === undefined || refitted.count < minLength) break
		line = refitted
		sampleLine(field, line, 0, 0, line.count, samples)
		;({ scale, valid } = coreScale(samples, line.count, buffer))
		if (valid < minLength) return
		significance = blockSignificances(samples, line.count, blockLength, scale, buffer)
	}

	const { cos: c, sin: s, x0, y0, t0, count } = line

	for (const [first, last] of maximalRuns(significance)) {
		let covered = 0
		let measured = 0

		for (let b = first; b <= last; b++) {
			if (Number.isNaN(significance[b])) continue
			measured++
			if (significance[b] >= BLOCK_SIGMA) covered++
		}

		let from = first * blockLength
		let to = (last + 1) * blockLength
		const coverage = covered / Math.max(1, measured)
		if (to - from < minLength || covered < 2 || coverage < MIN_COVERAGE) continue

		// Refine both ends to a sample, where the core falls to half its contrast over the side level.
		const run = ridgeContrast(samples, from, to, buffer)
		const level = run.side + run.contrast / 2
		from = trailEnd(samples.core, level, from - blockLength, from + blockLength, from + blockLength - 1, true)
		to = trailEnd(samples.core, level, to - blockLength, to + blockLength - 1, to - blockLength, false) + 1
		if (to - from < minLength || isDuplicate(line, from, to, accepted)) continue

		const { contrast, count: supported } = ridgeContrast(samples, from, to, buffer)
		const snr = (contrast * Math.sqrt(supported)) / (MEDIAN_ERROR * scale)
		if (!(snr >= MIN_SNR)) continue
		const profile = transverseProfile(field, line, from, to, buffer)
		if (!profile.resolved || to - from < MIN_ASPECT * profile.fwhm) continue
		if (field.stellarFwhm !== undefined && profile.fwhm > WIDE_FACTOR * field.stellarFwhm && to - from < WIDE_ASPECT * profile.fwhm) continue
		if (!isUniform(samples, from, to, contrast, scale, buffer)) continue
		const texture = textureSignificance(field, line, from, to, contrast, supported, Math.max(SIDE_OUTER + 2, Math.ceil(2 * profile.fwhm) + 4), scale, scratch)
		if (!(texture >= MIN_TEXTURE_SIGMA)) continue

		// A segment reaching the clipped chord ends at the image border.
		const chord = clipLine(c, s, line.rho, width, height, 0)
		const startsAtBorder = from <= 1 && chord !== undefined
		const endsAtBorder = to >= count - 1 && chord !== undefined
		const ta = startsAtBorder ? Math.ceil(chord[0]) : t0 + from
		const tb = endsAtBorder ? Math.floor(chord[1]) : t0 + to - 1
		const xa = x0 - ta * s + profile.offset * c
		const ya = y0 + ta * c + profile.offset * s
		const xb = x0 - tb * s + profile.offset * c
		const yb = y0 + tb * c + profile.offset * s
		if (isEdgeArtifact(xa, ya, xb, yb, width, height) || isGridLocked(field, line, from, to, contrast, scratch)) continue

		const fit = fitCentroids(field, line, significance, blockLength, first, last, buffer)
		streaks.push(measureStreak(image, plane, field, line, from, to, xa, ya, xb, yb, profile, snr, Math.min(snr, texture), coverage, fit?.rms ?? 0, startsAtBorder || endsAtBorder, saturationLevel))
		accepted.push({ xa, ya, xb, yb, half: corridorHalfWidth(profile.fwhm) })
	}
}

// Builds the public streak of an accepted segment, converting analysis pixels to received-image pixels.
function measureStreak(
	image: Image,
	plane: AnalysisPlane,
	field: StreakField,
	line: Line,
	from: number,
	to: number,
	xa: number,
	ya: number,
	xb: number,
	yb: number,
	profile: TransverseProfile,
	snr: number,
	strength: number,
	coverage: number,
	rms: number,
	clippedAtBorder: boolean,
	saturationLevel: number | undefined,
): Streak {
	const { bin } = plane
	const shift = (bin - 1) / 2
	const [start, end] = canonicalizeStreakEndpoints({ x: xa * bin + shift, y: ya * bin + shift }, { x: xb * bin + shift, y: yb * bin + shift })
	const length = Math.hypot(end.x - start.x, end.y - start.y)
	const width = profile.fwhm * bin
	const sigma = width / 2.354820045
	const { residual, width: w, height: h } = field
	const { cos: c, sin: s, x0, y0, t0 } = line
	const { metadata, raw } = image
	let peakSignal = 0
	let saturated = 0
	let sampled = 0

	for (let k = from; k < to; k++) {
		const x = x0 - (t0 + k) * s + profile.offset * c
		const y = y0 + (t0 + k) * c + profile.offset * s
		if (isMasked(field.mask, w, h, x, y)) continue
		const value = bilinear(residual, w, h, x, y)
		if (!Number.isNaN(value) && value > peakSignal) peakSignal = value
		if (saturationLevel === undefined) continue
		const xi = Math.min(metadata.width - 1, Math.max(0, Math.round(x * bin + shift)))
		const yi = Math.min(metadata.height - 1, Math.max(0, Math.round(y * bin + shift)))
		const index = yi * metadata.stride + xi * metadata.channels
		let isSaturated = false
		for (let channel = 0; channel < metadata.channels; channel++) if (raw[index + channel] >= saturationLevel) isSaturated = true
		if (isSaturated) saturated++
		sampled++
	}

	// Quality: the coverage, scaled from one half at the acceptance threshold toward one for a strong detection.
	const threshold = Math.min(MIN_SNR, MIN_TEXTURE_SIGMA)
	const confidence = Math.min(1, Math.max(0, coverage * (1 - 0.5 * Math.exp(-(strength - threshold) / threshold))))

	return {
		start,
		end,
		center: { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 },
		length,
		width,
		angle: normalizeStreakAngle(Math.atan2(end.y - start.y, end.x - start.x)),
		linearity: length > 0 ? Math.max(0, 1 - (12 * sigma * sigma) / (length * length)) : 0,
		rmsResidual: rms * bin,
		coverage,
		clippedAtBorder,
		flux: profile.integral * (to - from) * bin * bin,
		meanSignal: profile.peak,
		peakSignal,
		snr,
		...(saturationLevel !== undefined && { saturationFraction: sampled > 0 ? saturated / sampled : 0 }),
		confidence,
	}
}
