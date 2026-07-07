import { medianOf, STANDARD_DEVIATION_SCALE, standardDeviationOf } from '../../core/util'
import { clamp, type NumberArray } from '../../math/numerical/math'
import type { Image } from '../model/types'

// Cosmetic correction: detects and repairs isolated sensor defects (hot, warm, and dead/cold pixels,
// plus known bad columns/rows) and replaces each with the median of its spatial neighborhood. Defects are
// found by any combination of three detectors, applied per channel:
//   1. auto local-deviation — a pixel that departs from its local (window) median by more than
//      `hotSigma`/`coldSigma` times the channel's robust noise scale (normalized MAD), AND is genuinely
//      isolated: no immediate neighbor is itself elevated above the robust local background. The isolation
//      test protects real point sources — a star's PSF spreads flux into adjacent pixels, so its peak is
//      supported and left untouched, whereas a hot/dead pixel stands alone. A caller `protect` mask (e.g.
//      from star detection) additionally excludes regions from auto repair for the degenerate case of a
//      star confined to a single pixel, which one frame cannot distinguish from a hot pixel;
//   2. master-dark sigma — a pixel whose value in a supplied master dark frame is a high statistical
//      outlier (dark median + `darkHotSigma` * dark MAD), i.e. a fixed hot pixel;
//   3. explicit defect map — caller-provided bad pixels, columns, and rows repaired unconditionally.
// The master-dark and defect-map detectors are corroborated evidence and ignore both the isolation test
// and the `protect` mask. The repair value is the neighborhood median computed from the ORIGINAL
// (pre-correction) plane, so corrections never feed back into later ones. Operates in place on the [0, 1]
// raw buffer.
//
// For a Bayer CFA mosaic (single channel with `metadata.bayer` set), adjacent photosites carry different
// colors, so neighborhoods and robust statistics are computed per color phase (2-pixel stride, 4 phases)
// to avoid flagging a valid uniform-color mosaic as a field of hot pixels. Non-mosaic frames use the full
// contiguous neighborhood (1 phase).

// An explicit list of known-bad geometry to always repair, independent of any statistical detection.
// Coordinates are pixel indices; out-of-range entries are ignored. Shared across channels.
export interface CosmeticDefectMap {
	// Individual bad pixels as [x, y] pairs (0-based, x in [0, width), y in [0, height)).
	readonly pixels?: readonly (readonly [x: number, y: number])[]
	// Fully bad columns (0-based x indices).
	readonly columns?: NumberArray
	// Fully bad rows (0-based y indices).
	readonly rows?: NumberArray
}

// Options controlling cosmetic correction. All fields are optional and fall back to
// `DEFAULT_COSMETIC_CORRECTION_OPTIONS`.
export interface CosmeticCorrectionOptions {
	// Sigma multiple above the local median for auto hot-pixel detection, scaled by the channel noise.
	// 0 disables hot detection.
	readonly hotSigma?: number
	// Sigma multiple below the local median for auto cold/dead-pixel detection, scaled by the channel
	// noise. 0 disables cold detection.
	readonly coldSigma?: number
	// Neighborhood half-size in pixels for the local median (radius 1 => 3x3 window). Clamped to >= 1.
	readonly windowRadius?: number
	// Blend of the repair in [0, 1]: 1 fully replaces the pixel with the local median, 0 leaves it
	// untouched, intermediate values interpolate. Clamped to [0, 1].
	readonly amount?: number
	// Optional master dark frame (same geometry as the image). Pixels that are high outliers in the dark
	// are treated as fixed hot pixels and always repaired. Ignored when its geometry differs.
	readonly masterDark?: Image
	// Sigma multiple above the dark median (scaled by the dark's robust noise) for master-dark detection.
	// Only used when `masterDark` is supplied.
	readonly darkHotSigma?: number
	// Optional explicit defect map (bad pixels/columns/rows) repaired unconditionally.
	readonly defects?: CosmeticDefectMap
	// Optional protection mask, row-major with length width*height. Pixels with a nonzero value are never
	// touched by the auto detector (e.g. a star mask from a detector), guaranteeing real point sources are
	// preserved even when confined to a single pixel. Does not affect the master-dark or defect-map paths.
	readonly protect?: Readonly<NumberArray>
}

// Default cosmetic-correction options: 3-sigma auto detection on both tails over a 3x3 window, full
// replacement, no master dark, no explicit defects.
export const DEFAULT_COSMETIC_CORRECTION_OPTIONS: Readonly<Required<Omit<CosmeticCorrectionOptions, 'masterDark' | 'defects' | 'protect'>>> = {
	hotSigma: 3,
	coldSigma: 3,
	windowRadius: 1,
	amount: 1,
	darkHotSigma: 5,
}

// One normalized 16-bit code value used as a nonzero dark-scale limit for perfectly flat trimmed
// backgrounds, preventing small quantized differences from becoming zero-noise outliers.
const CONSTANT_DARK_SCALE_LIMIT = 1 / 65535

// Relative dark-scale limit for flat trimmed backgrounds; fixed hot pixels should exceed ordinary
// dark-current quantization by more than this fraction of the median background.
const CONSTANT_DARK_SCALE_FRACTION = 0.1

// Largest sample count in the common 3x3 local-median window; insertion sort avoids a TypedArray
// subarray/sort call for the per-pixel radius-1 path.
const SMALL_MEDIAN_SORT_LIMIT = 9

// Maximum candidate density that uses sparse direct-repair paths. Denser maps keep the normal full-frame
// pass, which is better for large bad-row/column or dark-defect sets.
const SPARSE_DEFECT_MAX_FRACTION = 1 / 32

// Outcome of a cosmetic-correction pass: the mutated image plus how many samples each detector repaired.
// The per-detector counts are mutually exclusive (a sample is attributed to the first detector that
// flags it, in the order defect > dark > hot > cold) and sum to `corrected`.
export interface CosmeticCorrectionResult {
	// The same image passed in, corrected in place.
	readonly image: Image
	// Total samples replaced across all channels.
	readonly corrected: number
	// Samples flagged by auto hot detection.
	readonly hot: number
	// Samples flagged by auto cold/dead detection.
	readonly cold: number
	// Samples flagged by the master-dark detector.
	readonly dark: number
	// Samples flagged by the explicit defect map.
	readonly defect: number
}

// Mutable scratch storage for local-neighborhood medians.
interface NeighborhoodScratch {
	// Reusable value buffer; it may grow when skip masks force a wider repair search.
	values: Float64Array
}

// Dense explicit-defect mask plus, when the map stays sparse, the unique row-major indices marked while
// building it. The sparse list is omitted once the map exceeds the caller's direct-repair density limit.
interface BuiltDefectMask {
	// Optional geometry-level defect mask shared by all channels, with 1 for known bad samples.
	readonly mask?: Uint8Array
	// Unique marked pixel indices when the explicit map remains sparse enough for direct repair.
	readonly sparseIndices?: readonly number[]
	// Sparse membership set used by direct repair when no dense mask was allocated.
	readonly sparseSet?: ReadonlySet<number>
}

// Robust center and scale of a sample buffer's first `count` values. Returns the median and the normalized
// MAD (comparable to a standard deviation); falls back to the population standard deviation when the MAD
// collapses to 0 (a near-constant plane), and to 0 only when the plane is genuinely constant. `values` and
// `scratch` are reusable buffers of at least `count` elements, partitioned in place.
function robustPlaneScale(values: Float64Array, count: number, scratch: Float64Array) {
	const median = medianBySelection(values, count)

	for (let i = 0; i < count; i++) scratch[i] = Math.abs(values[i] - median)
	const mad = STANDARD_DEVIATION_SCALE * medianBySelection(scratch, count)

	const scale = mad > 0 ? mad : standardDeviationOf(values, count)
	return { median, scale: Number.isFinite(scale) ? scale : 0 } as const
}

// Robust scale from the lower side of a sample distribution, measured around `median`. Master-dark hot
// pixels are an upper-tail defect population, so using only values at or below the median keeps the dark
// scale tied to the clean background even when the hot tail is wider than a fixed trim percentage. Returns
// undefined when fewer than two lower-tail samples exist, leaving the caller's original scale intact.
function lowerTailScale(values: Float64Array, count: number, median: number, scratch: Float64Array) {
	let lowerCount = 0

	for (let i = 0; i < count; i++) {
		const value = values[i]
		if (value <= median) scratch[lowerCount++] = median - value
	}

	if (lowerCount < 2) return undefined
	const scale = STANDARD_DEVIATION_SCALE * medianBySelection(scratch, lowerCount)
	return Number.isFinite(scale) ? scale : 0
}

// Robust scale of each CFA phase of `plane` (or one global scale when `phases === 1`), written into
// `scales` (length `phases`). Same-phase samples are gathered by parity-strided scans into `gather`;
// `scratch` is the robust-computation scratch. Both buffers must hold at least the largest phase sample
// count. Pixels flagged in `skip` (the defect mask) are excluded so known defects do not inflate the scale.
// A phase with no samples gets scale 0 (its detection is effectively disabled).
function computePhaseStats(plane: Float64Array, width: number, height: number, phases: number, gather: Float64Array, scratch: Float64Array, scales: Float64Array, skip?: Uint8Array) {
	for (let ph = 0; ph < phases; ph++) {
		let count = 0

		if (phases === 1) {
			const n = width * height

			if (skip === undefined) {
				for (let p = 0; p < n; p++) {
					gather[count++] = plane[p]
				}
			} else {
				for (let p = 0; p < n; p++) {
					if (skip[p] !== 0) continue
					gather[count++] = plane[p]
				}
			}
		} else {
			// Visit only the photosites of this phase via a parity-strided scan (px, py in {0, 1}).
			const py = ph >> 1
			const px = ph & 1

			if (skip === undefined) {
				for (let y = py; y < height; y += 2) {
					const row = y * width

					for (let x = px; x < width; x += 2) {
						gather[count++] = plane[row + x]
					}
				}
			} else {
				for (let y = py; y < height; y += 2) {
					const row = y * width

					for (let x = px; x < width; x += 2) {
						const p = row + x
						if (skip[p] !== 0) continue
						gather[count++] = plane[p]
					}
				}
			}
		}

		if (count === 0) {
			scales[ph] = 0
			continue
		}

		const stats = robustPlaneScale(gather, count, scratch)
		scales[ph] = stats.scale
	}
}

// Master-dark thresholds for each CFA phase, read directly from the interleaved dark buffer. Each phase
// is gathered once, then used for both the robust MAD and the lower-tail scale clamp.
function computeInterleavedDarkThresholds(dark: Readonly<NumberArray>, channel: number, channels: number, width: number, height: number, phases: number, darkHotSigma: number, gather: Float64Array, scratch: Float64Array, thresholds: Float64Array, skip?: Uint8Array, sparseSkip?: ReadonlySet<number>) {
	let enabled = false
	thresholds.fill(Number.POSITIVE_INFINITY)

	for (let ph = 0; ph < phases; ph++) {
		let count = 0

		if (phases === 1) {
			const n = width * height

			if (skip === undefined && sparseSkip === undefined) {
				for (let p = 0, i = channel; p < n; p++, i += channels) {
					gather[count++] = dark[i]
				}
			} else {
				for (let p = 0, i = channel; p < n; p++, i += channels) {
					if (skip !== undefined && skip[p] !== 0) continue
					if (sparseSkip !== undefined && sparseSkip.has(p)) continue
					gather[count++] = dark[i]
				}
			}
		} else {
			const py = ph >> 1
			const px = ph & 1
			const channelStep = channels * 2

			if (skip === undefined && sparseSkip === undefined) {
				for (let y = py; y < height; y += 2) {
					const row = y * width
					let i = (row + px) * channels + channel

					for (let x = px; x < width; x += 2, i += channelStep) {
						gather[count++] = dark[i]
					}
				}
			} else {
				for (let y = py; y < height; y += 2) {
					const row = y * width
					let i = (row + px) * channels + channel

					for (let x = px; x < width; x += 2, i += channelStep) {
						const p = row + x
						if (skip !== undefined && skip[p] !== 0) continue
						if (sparseSkip !== undefined && sparseSkip.has(p)) continue
						gather[count++] = dark[i]
					}
				}
			}
		}

		if (count === 0) {
			continue
		}

		const stats = robustPlaneScale(gather, count, scratch)
		let scale = stats.scale

		if (count > 1) {
			const tailScale = lowerTailScale(gather, count, stats.median, scratch)

			if (tailScale !== undefined) {
				if (tailScale > 0 && tailScale < scale) {
					scale = tailScale
				} else if (tailScale === 0) {
					scale = Math.max(CONSTANT_DARK_SCALE_LIMIT, Math.abs(stats.median) * CONSTANT_DARK_SCALE_FRACTION)
				}
			}
		}

		thresholds[ph] = stats.median + darkHotSigma * scale
		enabled = true
	}

	return enabled
}

// Allocates a larger neighborhood scratch buffer when skip-mask expansion finds more samples than the
// current in-bounds window could hold. Existing samples are copied and the caller's scratch is updated.
function growNeighborhoodBuffer(scratch: NeighborhoodScratch, minLength: number) {
	const values = scratch.values
	const next = new Float64Array(Math.max(minLength, values.length * 2, 1))
	next.set(values)
	scratch.values = next
	return next
}

// Sorts a tiny prefix of `values` in ascending numeric order, matching TypedArray sort's practical NaN
// placement by pushing NaNs to the high end. Used for 3x3 neighborhoods and very small robust samples.
function sortSmallPrefix(values: Float64Array, count: number) {
	for (let i = 1; i < count; i++) {
		const value = values[i]
		const valueIsNaN = Number.isNaN(value)
		let j = i - 1

		while (j >= 0) {
			const previous = values[j]
			if (!Number.isNaN(previous) ? valueIsNaN || previous <= value : valueIsNaN) break
			values[j + 1] = previous
			j--
		}

		values[j + 1] = value
	}
}

// Selects the kth value in ascending numeric order, mutating only the first `count` entries. A three-way
// partition avoids quadratic behavior on flat frames where many samples equal the pivot.
function quickSelect(values: Float64Array, count: number, k: number) {
	let left = 0
	let right = count - 1

	while (left < right) {
		const pivot = values[(left + right) >>> 1]
		let lt = left
		let i = left
		let gt = right

		while (i <= gt) {
			const cmp = values[i] - pivot

			if (cmp < 0) {
				const value = values[lt]
				values[lt] = values[i]
				values[i] = value
				lt++
				i++
			} else if (cmp > 0) {
				const value = values[i]
				values[i] = values[gt]
				values[gt] = value
				gt--
			} else {
				i++
			}
		}

		if (k < lt) right = lt - 1
		else if (k > gt) left = gt + 1
		else return values[k]
	}

	return values[left]
}

// Median of the first `count` scratch values without a full sort. Even counts select both middle order
// statistics to preserve the existing average-of-two contract.
function medianBySelection(values: Float64Array, count: number) {
	if (count <= SMALL_MEDIAN_SORT_LIMIT) {
		sortSmallPrefix(values, count)
		return medianOf(values, count)
	}

	const mid = count >>> 1
	if ((count & 1) === 1) return quickSelect(values, count, mid)

	const upper = quickSelect(values, count, mid)
	// Selecting the upper median partitions the lower half into the prefix, so a linear max replaces
	// a second full quickselect pass for even-sized buffers.
	let lower = values[0]
	for (let i = 1; i < mid; i++) {
		const value = values[i]
		if (value > lower) lower = value
	}
	return (lower + upper) * 0.5
}

// Fast median for the common radius-1, unmasked local window. It avoids dynamic lattice-bound
// calculations on every auto-residual pixel, while still honoring the optional skipped center sample.
function neighborhoodMedianRadius1(plane: Float64Array, x: number, y: number, width: number, height: number, step: number, scratch: NeighborhoodScratch, skipIndex?: number, emptyValue?: number) {
	const values = scratch.values
	let count = 0
	const center = y * width + x

	if (x >= step && x + step < width && y >= step && y + step < height) {
		const prevCenter = center - step * width
		const nextCenter = center + step * width

		const q00 = prevCenter - step
		if (q00 !== skipIndex) values[count++] = plane[q00]
		const q01 = prevCenter
		if (q01 !== skipIndex) values[count++] = plane[q01]
		const q02 = prevCenter + step
		if (q02 !== skipIndex) values[count++] = plane[q02]
		const q10 = center - step
		if (q10 !== skipIndex) values[count++] = plane[q10]
		if (center !== skipIndex) values[count++] = plane[center]
		const q12 = center + step
		if (q12 !== skipIndex) values[count++] = plane[q12]
		const q20 = nextCenter - step
		if (q20 !== skipIndex) values[count++] = plane[q20]
		const q21 = nextCenter
		if (q21 !== skipIndex) values[count++] = plane[q21]
		const q22 = nextCenter + step
		if (q22 !== skipIndex) values[count++] = plane[q22]
	} else {
		for (let dy = -1; dy <= 1; dy++) {
			const yy = y + dy * step

			if (yy < 0 || yy >= height) continue

			const row = yy * width

			for (let dx = -1; dx <= 1; dx++) {
				const xx = x + dx * step
				if (xx < 0 || xx >= width) continue
				const q = row + xx
				if (q === skipIndex) continue
				values[count++] = plane[q]
			}
		}
	}

	if (count === 0) return emptyValue ?? plane[center]
	return medianBySelection(values, count)
}

// Fast radius-1 median for the common residual-field path where the center is always excluded and no mask
// is active. Interior pixels avoid the per-sample `skipIndex` comparisons used by the generic helper.
function neighborhoodMedianRadius1SkipCenter(plane: Float64Array, x: number, y: number, width: number, height: number, step: number, scratch: NeighborhoodScratch) {
	const values = scratch.values
	let count = 0
	const center = y * width + x

	if (x >= step && x + step < width && y >= step && y + step < height) {
		const prevCenter = center - step * width
		const nextCenter = center + step * width

		values[count++] = plane[prevCenter - step]
		values[count++] = plane[prevCenter]
		values[count++] = plane[prevCenter + step]
		values[count++] = plane[center - step]
		values[count++] = plane[center + step]
		values[count++] = plane[nextCenter - step]
		values[count++] = plane[nextCenter]
		values[count++] = plane[nextCenter + step]
	} else {
		for (let dy = -1; dy <= 1; dy++) {
			const yy = y + dy * step

			if (yy < 0 || yy >= height) continue

			const row = yy * width

			for (let dx = -1; dx <= 1; dx++) {
				const xx = x + dx * step
				if (xx < 0 || xx >= width) continue
				const q = row + xx
				if (q === center) continue
				values[count++] = plane[q]
			}
		}
	}

	return count === 0 ? plane[center] : medianBySelection(values, count)
}

// Fast masked radius-1 median. Returns undefined when every 3x3 sample is masked, letting the generic
// path handle outward expansion.
function neighborhoodMedianRadius1Masked(plane: Float64Array, x: number, y: number, width: number, height: number, step: number, scratch: NeighborhoodScratch, skip: Uint8Array, skipIndex?: number) {
	const values = scratch.values
	let count = 0
	const center = y * width + x

	if (x >= step && x + step < width && y >= step && y + step < height) {
		const prevCenter = center - step * width
		const nextCenter = center + step * width

		const q00 = prevCenter - step
		if (q00 !== skipIndex && skip[q00] === 0) values[count++] = plane[q00]
		const q01 = prevCenter
		if (q01 !== skipIndex && skip[q01] === 0) values[count++] = plane[q01]
		const q02 = prevCenter + step
		if (q02 !== skipIndex && skip[q02] === 0) values[count++] = plane[q02]
		const q10 = center - step
		if (q10 !== skipIndex && skip[q10] === 0) values[count++] = plane[q10]
		if (center !== skipIndex && skip[center] === 0) values[count++] = plane[center]
		const q12 = center + step
		if (q12 !== skipIndex && skip[q12] === 0) values[count++] = plane[q12]
		const q20 = nextCenter - step
		if (q20 !== skipIndex && skip[q20] === 0) values[count++] = plane[q20]
		const q21 = nextCenter
		if (q21 !== skipIndex && skip[q21] === 0) values[count++] = plane[q21]
		const q22 = nextCenter + step
		if (q22 !== skipIndex && skip[q22] === 0) values[count++] = plane[q22]
	} else {
		for (let dy = -1; dy <= 1; dy++) {
			const yy = y + dy * step

			if (yy < 0 || yy >= height) continue

			const row = yy * width

			for (let dx = -1; dx <= 1; dx++) {
				const xx = x + dx * step
				if (xx < 0 || xx >= width) continue
				const q = row + xx
				if (q !== skipIndex && skip[q] === 0) values[count++] = plane[q]
			}
		}
	}

	return count === 0 ? undefined : medianBySelection(values, count)
}

// Median of the neighborhood of (x, y), read from the deinterleaved `plane`. Samples the (2r+1)^2 lattice
// centered on (x, y) with a spacing of `step` pixels per axis, clamped to the image bounds. `step` is 1
// for a normal plane; for a Bayer CFA mosaic it is 2 so only same-color-phase photosites are gathered
// (adjacent photosites carry different colors and must not be mixed). The in-bounds lattice range is
// computed up front, so the scan cost is the number of samples actually gathered rather than (2r+1)^2 —
// a radius far larger than the frame does not blow the loop up. When `skip` is given, neighbors flagged in
// it (the defect mask) are excluded; `skipIndex` additionally skips a single pixel index without
// requiring a full-frame mask. If no unflagged neighbor exists anywhere in the sampled lattice, returns
// `emptyValue` when supplied, otherwise the original center value so the caller leaves the sample effectively
// unchanged. `scratch` must hold the initial in-bounds window; it grows only when a skipped window has to
// expand beyond that initial size, and the growth is kept for later calls.
function neighborhoodMedian(plane: Float64Array, x: number, y: number, width: number, height: number, r: number, step: number, scratch: NeighborhoodScratch, skip?: Uint8Array, skipIndex?: number, emptyValue?: number) {
	if (r === 1) {
		if (skip === undefined) return neighborhoodMedianRadius1(plane, x, y, width, height, step, scratch, skipIndex, emptyValue)
		const maskedMedian = neighborhoodMedianRadius1Masked(plane, x, y, width, height, step, scratch, skip, skipIndex)
		if (maskedMedian !== undefined) return maskedMedian
	}

	// Restrict the lattice offsets to those that land inside the frame, so an oversized radius neither
	// scans nor requires buffer space for samples that would only be clamped away.
	const kyMin = Math.max(-r, -Math.floor(y / step))
	const kyMax = Math.min(r, Math.floor((height - 1 - y) / step))
	const kxMin = Math.max(-r, -Math.floor(x / step))
	const kxMax = Math.min(r, Math.floor((width - 1 - x) / step))

	let values = scratch.values
	let count = 0
	for (let ky = kyMin; ky <= kyMax; ky++) {
		const row = (y + ky * step) * width

		for (let kx = kxMin; kx <= kxMax; kx++) {
			const q = row + x + kx * step
			if (q === skipIndex) continue
			if (skip !== undefined && skip[q] !== 0) continue
			if (count === values.length) values = growNeighborhoodBuffer(scratch, count + 1)
			values[count++] = plane[q]
		}
	}

	// Every sampled neighbor was flagged: expand the window radius until at least one
	// unflagged neighbor is found or the image bounds are exhausted. This avoids falling
	// back to the hot cluster's own values when a skip mask covers the entire window.
	if (count === 0) {
		let er = r + 1
		let prevKyMin = kyMin
		let prevKyMax = kyMax
		let prevKxMin = kxMin
		let prevKxMax = kxMax

		while (true) {
			const ekyMin = Math.max(-er, -Math.floor(y / step))
			const ekyMax = Math.min(er, Math.floor((height - 1 - y) / step))
			const ekxMin = Math.max(-er, -Math.floor(x / step))
			const ekxMax = Math.min(er, Math.floor((width - 1 - x) / step))

			if (ekyMin === prevKyMin && ekyMax === prevKyMax && ekxMin === prevKxMin && ekxMax === prevKxMax) return emptyValue ?? plane[y * width + x]

			const oldKyMin = prevKyMin
			const oldKyMax = prevKyMax
			const oldKxMin = prevKxMin
			const oldKxMax = prevKxMax
			prevKyMin = ekyMin
			prevKyMax = ekyMax
			prevKxMin = ekxMin
			prevKxMax = ekxMax

			for (let ky = ekyMin; ky <= ekyMax; ky++) {
				const row = (y + ky * step) * width

				for (let kx = ekxMin; kx <= ekxMax; kx++) {
					if (ky >= oldKyMin && ky <= oldKyMax && kx >= oldKxMin && kx <= oldKxMax) continue
					const q = row + x + kx * step
					if (q === skipIndex) continue
					if (skip !== undefined && skip[q] !== 0) continue
					if (count === values.length) values = growNeighborhoodBuffer(scratch, count + 1)
					values[count++] = plane[q]
				}
			}

			if (count > 0) break

			er++
		}
	}

	return medianBySelection(values, count)
}

// Median of the neighborhood of (x, y), read directly from an interleaved raw buffer for sparse
// explicit-defect repair. It mirrors `neighborhoodMedian` but avoids materializing a full plane when no
// statistical detector is active.
function interleavedNeighborhoodMedian(
	raw: Readonly<NumberArray>,
	channel: number,
	channels: number,
	x: number,
	y: number,
	width: number,
	height: number,
	r: number,
	step: number,
	scratch: NeighborhoodScratch,
	skip?: Uint8Array,
	skipIndex?: number,
	emptyValue?: number,
	sparseSkip?: ReadonlySet<number>,
	sparseSkip2?: ReadonlySet<number>,
) {
	const kyMin = Math.max(-r, -Math.floor(y / step))
	const kyMax = Math.min(r, Math.floor((height - 1 - y) / step))
	const kxMin = Math.max(-r, -Math.floor(x / step))
	const kxMax = Math.min(r, Math.floor((width - 1 - x) / step))

	let values = scratch.values
	let count = 0

	for (let ky = kyMin; ky <= kyMax; ky++) {
		const row = (y + ky * step) * width

		for (let kx = kxMin; kx <= kxMax; kx++) {
			const q = row + x + kx * step
			if (q === skipIndex) continue
			if (skip !== undefined && skip[q] !== 0) continue
			if (sparseSkip !== undefined && sparseSkip.has(q)) continue
			if (sparseSkip2 !== undefined && sparseSkip2.has(q)) continue
			if (count === values.length) values = growNeighborhoodBuffer(scratch, count + 1)
			values[count++] = raw[q * channels + channel]
		}
	}

	if (count === 0) {
		let er = r + 1
		let prevKyMin = kyMin
		let prevKyMax = kyMax
		let prevKxMin = kxMin
		let prevKxMax = kxMax

		while (true) {
			const ekyMin = Math.max(-er, -Math.floor(y / step))
			const ekyMax = Math.min(er, Math.floor((height - 1 - y) / step))
			const ekxMin = Math.max(-er, -Math.floor(x / step))
			const ekxMax = Math.min(er, Math.floor((width - 1 - x) / step))

			if (ekyMin === prevKyMin && ekyMax === prevKyMax && ekxMin === prevKxMin && ekxMax === prevKxMax) return emptyValue ?? raw[(y * width + x) * channels + channel]

			const oldKyMin = prevKyMin
			const oldKyMax = prevKyMax
			const oldKxMin = prevKxMin
			const oldKxMax = prevKxMax
			prevKyMin = ekyMin
			prevKyMax = ekyMax
			prevKxMin = ekxMin
			prevKxMax = ekxMax

			for (let ky = ekyMin; ky <= ekyMax; ky++) {
				const row = (y + ky * step) * width

				for (let kx = ekxMin; kx <= ekxMax; kx++) {
					if (ky >= oldKyMin && ky <= oldKyMax && kx >= oldKxMin && kx <= oldKxMax) continue
					const q = row + x + kx * step
					if (q === skipIndex) continue
					if (skip !== undefined && skip[q] !== 0) continue
					if (sparseSkip !== undefined && sparseSkip.has(q)) continue
					if (sparseSkip2 !== undefined && sparseSkip2.has(q)) continue
					if (count === values.length) values = growNeighborhoodBuffer(scratch, count + 1)
					values[count++] = raw[q * channels + channel]
				}
			}

			if (count > 0) break

			er++
		}
	}

	return medianBySelection(values, count)
}

// Repairs one interleaved sample by index from the current raw buffer, excluding every sample marked in
// `repairSkip` or sparse skip sets from the neighborhood median. Returns true only when a finite repair
// value is written.
function repairInterleavedIndex(
	raw: NumberArray,
	width: number,
	height: number,
	channels: number,
	channel: number,
	p: number,
	radius: number,
	step: number,
	amount: number,
	repairSkip: Uint8Array | undefined,
	sparseRepairSkip: ReadonlySet<number> | undefined,
	sparseRepairSkip2: ReadonlySet<number> | undefined,
	window: NeighborhoodScratch,
) {
	const y = Math.trunc(p / width)
	const x = p - y * width
	const rawIndex = p * channels + channel
	const center = raw[rawIndex]
	const m = interleavedNeighborhoodMedian(raw, channel, channels, x, y, width, height, radius, step, window, repairSkip, undefined, Number.NaN, sparseRepairSkip, sparseRepairSkip2)
	const repaired = amount >= 1 ? m : center + amount * (m - center)
	if (!Number.isFinite(repaired)) return false
	raw[rawIndex] = repaired
	return true
}

// Repairs only explicitly mapped defects from the interleaved raw buffer. All mapped defects stay in the
// skip mask, so direct reads do not reuse values already corrected earlier in the sparse pass.
function repairSparseDefects(raw: NumberArray, width: number, height: number, channels: number, radius: number, step: number, amount: number, defectMask: Uint8Array | undefined, defectSet: ReadonlySet<number> | undefined, defectIndices: readonly number[], window: NeighborhoodScratch) {
	let repairedCount = 0

	for (let channel = 0; channel < channels; channel++) {
		for (const p of defectIndices) {
			if (repairInterleavedIndex(raw, width, height, channels, channel, p, radius, step, amount, defectMask, defectSet, undefined, window)) repairedCount++
		}
	}

	return repairedCount
}

// Repairs a dense explicit-defect mask directly from the interleaved raw buffer when no statistical
// detector is active. The dense mask is used as the repair skip mask, so mapped defects never feed later
// repairs even though writes happen in place.
function repairDenseDefectsDirect(raw: NumberArray, width: number, height: number, channels: number, radius: number, step: number, amount: number, defectMask: Uint8Array, window: NeighborhoodScratch) {
	let repairedCount = 0

	for (let y = 0; y < height; y++) {
		const rowBase = y * width

		for (let x = 0; x < width; x++) {
			const p = rowBase + x
			if (defectMask[p] === 0) continue

			for (let channel = 0; channel < channels; channel++) {
				if (repairInterleavedIndex(raw, width, height, channels, channel, p, radius, step, amount, defectMask, undefined, undefined, window)) repairedCount++
			}
		}
	}

	return repairedCount
}

// Computes master-dark repairs directly from interleaved buffers when no auto detector is active. The
// repair skip mask still covers both explicit defects and dark-flagged pixels, preserving cluster repair
// behavior without materializing a deinterleaved light plane. Sparse candidate sets repair by index;
// dense sets fall back to the full-frame pass.
function repairMasterDarkDirect(
	raw: NumberArray,
	dark: Readonly<NumberArray>,
	width: number,
	height: number,
	channels: number,
	phases: number,
	radius: number,
	step: number,
	amount: number,
	darkHotSigma: number,
	defectMask: Uint8Array | undefined,
	defectIndices: readonly number[] | undefined,
	defectSet: ReadonlySet<number> | undefined,
	maxSparseCount: number,
	gather: Float64Array,
	scratch: Float64Array,
	thresholds: Float64Array,
	window: NeighborhoodScratch,
) {
	const n = width * height
	const singlePhase = phases === 1
	let defect = 0
	let darkCount = 0

	for (let channel = 0; channel < channels; channel++) {
		const darkEnabled = computeInterleavedDarkThresholds(dark, channel, channels, width, height, phases, darkHotSigma, gather, scratch, thresholds, defectMask, defectSet)

		if (!darkEnabled && defectMask === undefined && defectSet === undefined) continue

		let darkIndices: number[] | undefined = darkEnabled ? [] : undefined
		let darkSet: Set<number> | undefined = darkEnabled ? new Set<number>() : undefined
		let denseRepairSkip: Uint8Array | undefined

		if (darkEnabled) {
			if (singlePhase) {
				const threshold = thresholds[0]

				for (let p = 0, i = channel; p < n; p++, i += channels) {
					if (dark[i] > threshold) {
						if (darkIndices !== undefined) {
							if (darkIndices.length < maxSparseCount) {
								darkIndices.push(p)
								darkSet!.add(p)
							} else {
								denseRepairSkip = defectMask !== undefined ? new Uint8Array(defectMask) : new Uint8Array(n)
								if (defectMask === undefined && defectIndices !== undefined) {
									for (const q of defectIndices) denseRepairSkip[q] = 1
								}
								for (const q of darkIndices) denseRepairSkip[q] = 1
								denseRepairSkip[p] = 1
								darkIndices = undefined
								darkSet = undefined
							}
						} else {
							denseRepairSkip![p] = 1
						}
					}
				}
			} else {
				for (let y = 0; y < height; y++) {
					const rowBase = y * width
					let i = rowBase * channels + channel
					for (let x = 0; x < width; x++, i += channels) {
						const p = rowBase + x
						if (dark[i] > thresholds[(y & 1) * 2 + (x & 1)]) {
							if (darkIndices !== undefined) {
								if (darkIndices.length < maxSparseCount) {
									darkIndices.push(p)
									darkSet!.add(p)
								} else {
									denseRepairSkip = defectMask !== undefined ? new Uint8Array(defectMask) : new Uint8Array(n)
									if (defectMask === undefined && defectIndices !== undefined) {
										for (const q of defectIndices) denseRepairSkip[q] = 1
									}
									for (const q of darkIndices) denseRepairSkip[q] = 1
									denseRepairSkip[p] = 1
									darkIndices = undefined
									darkSet = undefined
								}
							} else {
								denseRepairSkip![p] = 1
							}
						}
					}
				}
			}
		}

		const sparseDefectCount = defectIndices !== undefined ? defectIndices.length : defectMask === undefined && defectSet === undefined ? 0 : Number.POSITIVE_INFINITY
		const sparseDarkCount = darkEnabled ? (darkIndices?.length ?? Number.POSITIVE_INFINITY) : 0

		if (sparseDefectCount + sparseDarkCount <= maxSparseCount) {
			if (defectIndices !== undefined) {
				for (const p of defectIndices) {
					if (repairInterleavedIndex(raw, width, height, channels, channel, p, radius, step, amount, defectMask, defectSet, darkSet, window)) defect++
				}
			}

			if (darkIndices !== undefined) {
				for (const p of darkIndices) {
					if (defectMask !== undefined && defectMask[p] !== 0) continue
					if (defectSet !== undefined && defectSet.has(p)) continue
					if (repairInterleavedIndex(raw, width, height, channels, channel, p, radius, step, amount, defectMask, defectSet, darkSet, window)) darkCount++
				}
			}

			continue
		}

		const repairSkip = denseRepairSkip ?? (defectMask !== undefined ? new Uint8Array(defectMask) : new Uint8Array(n))
		if (defectMask === undefined && defectIndices !== undefined) {
			for (const p of defectIndices) repairSkip[p] = 1
		}
		if (darkIndices !== undefined) {
			for (const p of darkIndices) repairSkip[p] = 1
		}

		for (let y = 0; y < height; y++) {
			const rowBase = y * width
			let rawIndex = rowBase * channels + channel

			for (let x = 0; x < width; x++, rawIndex += channels) {
				const p = rowBase + x
				const isDefect = (defectMask !== undefined && defectMask[p] !== 0) || (defectSet !== undefined && defectSet.has(p))
				const isDark = !isDefect && darkEnabled && repairSkip[p] !== 0
				if (!isDefect && !isDark) continue

				const center = raw[rawIndex]
				const m = interleavedNeighborhoodMedian(raw, channel, channels, x, y, width, height, radius, step, window, repairSkip, undefined, Number.NaN)
				const repaired = amount >= 1 ? m : center + amount * (m - center)
				if (!Number.isFinite(repaired)) continue
				raw[rawIndex] = repaired
				if (isDefect) defect++
				else darkCount++
			}
		}
	}

	return { defect, dark: darkCount } as const
}

// Decides whether a candidate pixel is a genuine isolated defect rather than the peak of a resolved
// source (a star). `sign` is +1 for a hot candidate, -1 for a cold one. Uses a robust local background
// `bg` (median over the slightly larger radius `bgRadius` window, where a compact source is a minority so
// the median is not pulled toward it) and requires both that the center exceeds the background by
// `sigma * scale` in the candidate direction AND that NO immediate neighbor is itself that far from the
// background — a defect stands alone, a star's PSF elevates its neighbors. The first neighbor loop checks
// same-phase neighbors (spacing `step`); for Bayer CFA frames (`step > 1`), a second loop checks the raw
// 8-neighbors (step=1) against a contiguous background because a resolved star's PSF spreads across ALL
// adjacent CFA photosites, not just those of the same color phase. The contiguous background excludes the
// center pixel so the star core does not bias its median. `buf` is sized for the step-spaced background
// window; `rawBuf` is sized for the contiguous (step=1) background window and is only used when
// `step > 1`. `residual` and `phaseScale` provide per-pixel same-phase residuals and per-phase
// robust scales for the cross-phase normalization. Returns true only
// for a confirmed isolated defect.
function isIsolatedDefect(plane: Float64Array, x: number, y: number, width: number, height: number, bgRadius: number, step: number, buf: NeighborhoodScratch, skip: Uint8Array | undefined, scale: number, sigma: number, sign: number, rawBuf?: NeighborhoodScratch, residual?: Float64Array, phaseScale?: Float64Array) {
	const centerIndex = y * width + x
	const bg = neighborhoodMedian(plane, x, y, width, height, bgRadius, step, buf, skip, centerIndex)
	const center = plane[centerIndex]
	const threshold = sigma * scale

	// The center must stand out from the robust background in the candidate direction.
	if (sign > 0 ? !(center - bg > threshold) : !(bg - center > threshold)) return false

	// Isolation: any immediate same-phase neighbor (one lattice step away) that is itself beyond the
	// background threshold in the same direction is support (a real source), so this is not a lone defect.
	for (let ky = -1; ky <= 1; ky++) {
		const yy = y + ky * step
		if (yy < 0 || yy >= height) continue
		const row = yy * width

		for (let kx = -1; kx <= 1; kx++) {
			const xx = x + kx * step
			if (xx < 0 || xx >= width) continue
			const q = row + xx
			if (q === centerIndex) continue
			if (skip !== undefined && skip[q] !== 0) continue
			const nb = plane[q]
			if (sign > 0 ? nb - bg > threshold : bg - nb > threshold) return false
		}
	}

	// For Bayer CFA frames the same-phase neighbors are two pixels apart; a resolved star's PSF spills
	// into the adjacent CFA photosites as well. Check the raw 8-neighbors (step=1) against a contiguous
	// background so cross-phase PSF support is not missed.
	if (step > 1 && rawBuf !== undefined && residual !== undefined && phaseScale !== undefined) {
		// Exclude the center pixel from the raw background via skipIndex so no full-frame mask is allocated.
		const rawBg = neighborhoodMedian(plane, x, y, width, height, bgRadius, 1, rawBuf, skip, centerIndex)

		for (let dy = -1; dy <= 1; dy++) {
			const yy = y + dy
			if (yy < 0 || yy >= height) continue
			const row = yy * width

			for (let dx = -1; dx <= 1; dx++) {
				const xx = x + dx
				if (xx < 0 || xx >= width) continue
				const q = row + xx
				if (q === centerIndex) continue
				if (skip !== undefined && skip[q] !== 0) continue

				// Each neighbor is evaluated against its own CFA phase scale so a
				// noisier/quieter candidate phase does not bias the support test.
				const nbPhase = (yy & 1) * 2 + (xx & 1)
				const nbScale = phaseScale[nbPhase]
				const nbThreshold = sigma * nbScale

				// First gate: raw deviation from the contiguous background.
				const nb = plane[q]

				if (sign > 0 ? nb - rawBg > nbThreshold : rawBg - nb > nbThreshold) {
					// Second gate: the neighbor must be anomalous in its own CFA phase — its
					// same-phase residual must exceed its own phase's sigma*scale.
					const nbResidual = residual[q]
					if (sign > 0 ? nbResidual > nbThreshold : -nbResidual > nbThreshold) return false
				}
			}
		}
	}

	return true
}

// Builds the high-pass residual field `value - local-median` for a plane. Subtracting the local median
// removes smooth structure (sky gradients, vignetting), so the robust scale of `residual` reflects sensor
// noise instead of the background slope — using the raw plane's global spread would otherwise inflate the
// threshold and hide obvious local defects. The median can be recovered as `plane[p] - residual[p]` when
// the auto detector needs the repair value. `skip` (the defect mask) is passed to the median so known
// defects do not bias it. The center sample is skipped too so a candidate surrounded by masked neighbors
// cannot become its own local background.
function buildResidualField(plane: Float64Array, width: number, height: number, radius: number, step: number, window: NeighborhoodScratch, skip: Uint8Array | undefined, residual: Float64Array) {
	if (radius === 1 && skip === undefined) {
		for (let y = 0; y < height; y++) {
			const rowBase = y * width

			for (let x = 0; x < width; x++) {
				const p = rowBase + x
				const m = neighborhoodMedianRadius1SkipCenter(plane, x, y, width, height, step, window)
				residual[p] = plane[p] - m
			}
		}

		return
	}

	for (let y = 0; y < height; y++) {
		const rowBase = y * width

		for (let x = 0; x < width; x++) {
			const p = rowBase + x
			const m = neighborhoodMedian(plane, x, y, width, height, radius, step, window, skip, p)
			residual[p] = plane[p] - m
		}
	}
}

// Builds the geometry-level defect map from explicit bad pixels/rows/columns, or returns undefined when
// there is nothing valid to mark. Out-of-range entries are ignored so callers can pass loose lists without
// pre-filtering. When `maxSparseCount` is positive, also collects unique marked indices until the map
// exceeds that count, allowing sparse direct repair without a second full-frame scan. Pixel-only maps can
// stay sparse-only when `allowSparseOnly` is true, avoiding a dense frame-sized mask.
function buildDefectMask(defects: CosmeticDefectMap | undefined, width: number, height: number, maxSparseCount = 0, allowSparseOnly = false): BuiltDefectMask | undefined {
	if (defects === undefined) return undefined
	const { pixels, columns, rows } = defects
	if ((!pixels || pixels.length === 0) && (!columns || columns.length === 0) && (!rows || rows.length === 0)) return undefined

	if (allowSparseOnly && maxSparseCount > 0 && pixels !== undefined && (!columns || columns.length === 0) && (!rows || rows.length === 0)) {
		const sparseSet = new Set<number>()
		const sparseIndices: number[] = []

		for (let i = 0; i < pixels.length; i++) {
			const pixel = pixels[i]
			const x = pixel[0]
			const y = pixel[1]
			if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || x >= width || y < 0 || y >= height) continue
			const p = y * width + x
			if (sparseSet.has(p)) continue

			if (sparseIndices.length >= maxSparseCount) {
				const mask = new Uint8Array(width * height)
				for (const q of sparseIndices) mask[q] = 1
				mask[p] = 1

				for (let j = i + 1; j < pixels.length; j++) {
					const nextPixel = pixels[j]
					const xx = nextPixel[0]
					const yy = nextPixel[1]
					if (!Number.isInteger(xx) || !Number.isInteger(yy) || xx < 0 || xx >= width || yy < 0 || yy >= height) continue
					mask[yy * width + xx] = 1
				}

				return { mask }
			}

			sparseSet.add(p)
			sparseIndices.push(p)
		}

		return sparseIndices.length === 0 ? undefined : { sparseIndices, sparseSet }
	}

	const mask = new Uint8Array(width * height)
	let sparseIndices: number[] | undefined = maxSparseCount > 0 ? [] : undefined
	let count = 0

	if (columns) {
		for (const col of columns) {
			if (!Number.isInteger(col) || col < 0 || col >= width) continue
			for (let y = 0; y < height; y++) {
				const p = y * width + col
				if (mask[p] !== 0) continue
				mask[p] = 1
				count++

				if (sparseIndices !== undefined) {
					if (sparseIndices.length < maxSparseCount) sparseIndices.push(p)
					else sparseIndices = undefined
				}
			}
		}
	}

	if (rows) {
		for (const row of rows) {
			if (!Number.isInteger(row) || row < 0 || row >= height) continue
			const base = row * width
			for (let x = 0; x < width; x++) {
				const p = base + x
				if (mask[p] !== 0) continue
				mask[p] = 1
				count++

				if (sparseIndices !== undefined) {
					if (sparseIndices.length < maxSparseCount) sparseIndices.push(p)
					else sparseIndices = undefined
				}
			}
		}
	}

	if (pixels) {
		for (const [x, y] of pixels) {
			if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || x >= width || y < 0 || y >= height) continue
			const p = y * width + x
			if (mask[p] !== 0) continue
			mask[p] = 1
			count++

			if (sparseIndices !== undefined) {
				if (sparseIndices.length < maxSparseCount) sparseIndices.push(p)
				else sparseIndices = undefined
			}
		}
	}

	return count === 0 ? undefined : { mask, sparseIndices }
}

// Detects and repairs sensor defects in `image`, in place, returning the mutated image and per-detector
// repair counts. See the module comment for the detection strategy; the repair value is always the local
// neighborhood median of the original plane, blended by `amount`.
export function cosmeticCorrection(image: Image, options: CosmeticCorrectionOptions = DEFAULT_COSMETIC_CORRECTION_OPTIONS): CosmeticCorrectionResult {
	const { raw, metadata } = image
	const { width, height, channels } = metadata
	const n = width * height

	const hotSigma = Number.isFinite(options.hotSigma) ? Math.max(0, options.hotSigma!) : DEFAULT_COSMETIC_CORRECTION_OPTIONS.hotSigma
	const coldSigma = Number.isFinite(options.coldSigma) ? Math.max(0, options.coldSigma!) : DEFAULT_COSMETIC_CORRECTION_OPTIONS.coldSigma
	const requestedRadius = Number.isFinite(options.windowRadius) ? Math.max(1, Math.trunc(options.windowRadius!)) : DEFAULT_COSMETIC_CORRECTION_OPTIONS.windowRadius
	const amount = Number.isFinite(options.amount) ? clamp(options.amount!, 0, 1) : DEFAULT_COSMETIC_CORRECTION_OPTIONS.amount
	const darkHotSigma = Number.isFinite(options.darkHotSigma) ? Math.max(0, options.darkHotSigma!) : DEFAULT_COSMETIC_CORRECTION_OPTIONS.darkHotSigma

	let hot = 0
	let cold = 0
	let dark = 0
	let defect = 0

	if (n === 0 || amount === 0) return { image, corrected: 0, hot, cold, dark, defect }

	// A supplied master dark must match the image geometry to align pixel-for-pixel; otherwise ignore it.
	const md = options.masterDark
	const darkUsable = md !== undefined && md.metadata.width === width && md.metadata.height === height && md.metadata.channels === channels
	const dark0 = darkUsable ? md.raw : undefined
	const darkPossible = dark0 !== undefined && darkHotSigma > 0

	// Whether the auto detector could run at all; when off, the per-pixel median field is not built.
	const autoPossible = hotSigma > 0 || coldSigma > 0
	const sparseRepairMaxCount = !autoPossible ? Math.max(1, Math.floor(n * SPARSE_DEFECT_MAX_FRACTION)) : 0
	const builtDefects = buildDefectMask(options.defects, width, height, sparseRepairMaxCount, !autoPossible)
	const defectMask = builtDefects?.mask

	// Optional protection mask for the auto detector; must match the frame so it aligns pixel-for-pixel.
	const protectMask = options.protect
	if (protectMask !== undefined && protectMask.length !== n) {
		throw new Error(`protect mask length must be ${n} (width*height), got ${protectMask.length}`)
	}

	if (!autoPossible && !darkPossible && builtDefects === undefined) return { image, corrected: 0, hot, cold, dark, defect }

	let protectSkip: Uint8Array | undefined
	if (autoPossible && protectMask !== undefined) {
		protectSkip = new Uint8Array(n)
		for (let p = 0; p < n; p++) if (protectMask[p] !== 0) protectSkip[p] = 1
	}

	let defectProtectSkip: Uint8Array | undefined
	if (defectMask !== undefined && protectSkip !== undefined) {
		defectProtectSkip = new Uint8Array(defectMask)
		for (let p = 0; p < n; p++) if (protectSkip[p] !== 0) defectProtectSkip[p] = 1
	}

	// A Bayer CFA mosaic interleaves 4 color-phase photosites; neighborhoods and robust statistics must be
	// computed per phase so a valid uniform-color mosaic is not mistaken for a field of hot pixels.
	// Only single-channel raw frames are treated as mosaics — debayer() returns an RGB image that still
	// carries `metadata.bayer`, and its per-channel neighborhoods must be contiguous (step=1), not
	// parity-strided.
	// `step` samples only same-phase photosites; `phases` splits the robust statistics accordingly.
	const bayer = metadata.bayer !== undefined && channels === 1
	const step = bayer ? 2 : 1
	const phases = bayer ? 4 : 1
	const singlePhase = phases === 1

	// Clamp the requested window radius to the largest same-phase extent the frame can actually supply:
	// beyond this every further lattice ring falls outside the image and contributes nothing, so an
	// unbounded radius (e.g. 100000 on a tiny frame) must not drive the scratch-buffer size or the scan.
	const maxRadius = Math.max(1, Math.ceil((Math.max(width, height) - 1) / step))
	const radius = Math.min(requestedRadius, maxRadius)

	// Background window for the isolation test spans one pixel more than the repair window so a compact
	// source stays a minority of the window and its median tracks the true background.
	const bgRadius = radius + 1

	// Scratch window sizes are bounded by the per-axis in-bounds sample count, not the raw (2r+1)^2, so a
	// large radius on a small (or high-aspect) frame allocates only what a neighborhood can actually hold.
	const sameAxisColumns = Math.ceil(width / step)
	const sameAxisRows = Math.ceil(height / step)
	const maxPhaseSamples = sameAxisColumns * sameAxisRows
	const windowSize = Math.min(2 * radius + 1, sameAxisColumns) * Math.min(2 * radius + 1, sameAxisRows)
	const bgWindowSize = Math.min(2 * bgRadius + 1, sameAxisColumns) * Math.min(2 * bgRadius + 1, sameAxisRows)

	const window: NeighborhoodScratch = { values: new Float64Array(windowSize) }

	// Pure explicit-defect maps can be repaired directly from the interleaved raw buffer when the map is
	// sparse, avoiding a full deinterleaved Float64 plane and the full-frame detection scan.
	const sparseDefectIndices = !autoPossible && !darkPossible ? builtDefects?.sparseIndices : undefined
	if (builtDefects !== undefined && sparseDefectIndices !== undefined) {
		defect = repairSparseDefects(raw, width, height, channels, radius, step, amount, builtDefects.mask, builtDefects.sparseSet, sparseDefectIndices, window)
		return { image, corrected: defect, hot, cold, dark, defect }
	}

	if (!autoPossible && !darkPossible && defectMask !== undefined) {
		defect = repairDenseDefectsDirect(raw, width, height, channels, radius, step, amount, defectMask, window)
		return { image, corrected: defect, hot, cold, dark, defect }
	}

	if (!autoPossible && darkPossible) {
		const directGather = new Float64Array(maxPhaseSamples)
		const directScratch = new Float64Array(maxPhaseSamples)
		const directThreshold = new Float64Array(phases)
		const direct = repairMasterDarkDirect(raw, dark0, width, height, channels, phases, radius, step, amount, darkHotSigma, defectMask, builtDefects?.sparseIndices, builtDefects?.sparseSet, sparseRepairMaxCount, directGather, directScratch, directThreshold, window)
		defect = direct.defect
		dark = direct.dark
		return { image, corrected: dark + defect, hot, cold, dark, defect }
	}

	// Reusable scratch buffers, allocated once and shared across channels.
	// plane is needed for deinterleaving whenever statistical detection or dense defect repair runs;
	// scale/gather are only allocated when the auto or master-dark detector could run.
	const plane = new Float64Array(n)
	const scratchNeeded = autoPossible || darkPossible
	const scaleScratch = scratchNeeded ? new Float64Array(maxPhaseSamples) : new Float64Array(0)
	const gatherBuf = scratchNeeded ? new Float64Array(maxPhaseSamples) : new Float64Array(0)
	const bgWindow: NeighborhoodScratch = { values: new Float64Array(bgWindowSize) }
	// For Bayer CFA frames the isolation test must also check raw 8-neighbors against a contiguous
	// (step=1) background — a star's PSF crosses all CFA phases, not just same-color ones.
	const rawBgWindow: NeighborhoodScratch | undefined = step > 1 ? { values: new Float64Array(Math.min(2 * bgRadius + 1, width) * Math.min(2 * bgRadius + 1, height)) } : undefined
	// Per-pixel high-pass residual, built once per channel for the noise-scale estimate. The local median
	// is recovered as `plane[p] - residual[p]` when the auto path needs the repair value.
	const residual = autoPossible ? new Float64Array(n) : undefined

	// Per-phase robust statistics (one entry when not a mosaic).
	const phaseScale = new Float64Array(phases)
	const darkThreshold = new Float64Array(phases)

	for (let channel = 0; channel < channels; channel++) {
		// Deinterleave the channel into a contiguous plane so neighbor reads are cache-friendly and repairs
		// (written back to the interleaved raw buffer) never feed into later neighborhood medians.
		for (let p = 0, i = channel; p < n; p++, i += channels) plane[p] = raw[i]

		// Per-phase master-dark thresholds for this channel; a phase is disabled when its dark scale is 0.
		// Known defects are excluded from the dark statistics so a mapped bad column does not inflate the
		// scale and mask other fixed hot pixels in the same master dark.
		let darkEnabled = false
		if (darkPossible) {
			// When the master dark has a flat background with hot pixels, the MAD collapses to zero and
			// the stddev fallback includes the hot tail, so the threshold helper clamps to a lower-tail scale.
			darkEnabled = computeInterleavedDarkThresholds(dark0, channel, channels, width, height, phases, darkHotSigma, gatherBuf, scaleScratch, darkThreshold, defectMask)
		} else {
			darkThreshold.fill(Number.POSITIVE_INFINITY)
		}

		// Combined skip mask for dark-path repairs and auto noise estimation: neighbors that are themselves
		// flagged by the dark detector (above threshold) are excluded so fixed hot pixels do not bias repair
		// medians or inflate the auto residual scale.
		let darkSkip: Uint8Array | undefined
		if (darkEnabled) {
			if (defectMask !== undefined) {
				darkSkip = new Uint8Array(defectMask)
			} else {
				darkSkip = new Uint8Array(n)
			}

			if (singlePhase) {
				const threshold = darkThreshold[0]
				for (let p = 0, i = channel; p < n; p++, i += channels) {
					if (dark0![i] > threshold) darkSkip[p] = 1
				}
			} else {
				for (let y = 0; y < height; y++) {
					const rowBase = y * width
					let i = rowBase * channels + channel
					for (let x = 0; x < width; x++, i += channels) {
						const p = rowBase + x
						if (dark0![i] > darkThreshold[(y & 1) * 2 + (x & 1)]) darkSkip[p] = 1
					}
				}
			}
		}

		// Estimate the noise scale from local-median residuals (not the raw plane), so smooth gradients and
		// vignetting do not inflate it and hide obvious local defects. Known defects, protected sources,
		// and master-dark fixed defects are skipped because they are not sensor noise for the auto detector.
		let autoEnabled = false
		if (autoPossible) {
			let autoSkip = darkSkip ?? defectMask

			if (protectSkip !== undefined) {
				if (autoSkip === undefined) {
					autoSkip = protectSkip
				} else if (darkSkip === undefined && defectProtectSkip !== undefined) {
					autoSkip = defectProtectSkip
				} else {
					const combinedSkip = new Uint8Array(autoSkip)
					for (let p = 0; p < n; p++) if (protectSkip[p] !== 0) combinedSkip[p] = 1
					autoSkip = combinedSkip
				}
			}

			buildResidualField(plane, width, height, radius, step, window, autoSkip, residual!)
			computePhaseStats(residual!, width, height, phases, gatherBuf, scaleScratch, phaseScale, autoSkip)

			for (let ph = 0; ph < phases; ph++) autoEnabled ||= phaseScale[ph] > 0
		}

		// Nothing to detect for this channel: skip the per-pixel scan entirely.
		if (defectMask === undefined && !darkEnabled && !autoEnabled) continue

		for (let y = 0; y < height; y++) {
			const rowBase = y * width
			let rawIndex = rowBase * channels + channel

			for (let x = 0; x < width; x++, rawIndex += channels) {
				const p = rowBase + x
				const center = plane[p]
				const ph = singlePhase ? 0 : (y & 1) * 2 + (x & 1)
				const gScale = phaseScale[ph]

				let m = 0
				let haveM = false
				let cause = 0

				if (defectMask !== undefined && defectMask[p] !== 0) {
					cause = 1
				} else if (darkEnabled && dark0![rawIndex] > darkThreshold[ph]) {
					cause = 2
				} else if (autoEnabled && gScale > 0 && (protectSkip === undefined || protectSkip[p] === 0)) {
					m = center - residual![p]
					haveM = true
					// The window-median deviation is a cheap gate; a candidate is confirmed only when the
					// isolation test (against the robust background) rules out a resolved source such as a star.
					const autoSkip = darkSkip ?? defectMask
					if (darkSkip !== undefined && protectSkip !== undefined) m = neighborhoodMedian(plane, x, y, width, height, radius, step, window, darkSkip, p)
					if (hotSigma > 0 && center > m + hotSigma * gScale && isIsolatedDefect(plane, x, y, width, height, bgRadius, step, bgWindow, autoSkip, gScale, hotSigma, 1, rawBgWindow, residual, phaseScale)) cause = 3
					else if (coldSigma > 0 && center < m - coldSigma * gScale && isIsolatedDefect(plane, x, y, width, height, bgRadius, step, bgWindow, autoSkip, gScale, coldSigma, -1, rawBgWindow, residual, phaseScale)) cause = 4
				}

				if (cause === 0) continue

				// Dark-path and explicit-defect repairs recompute from the defect/dark skip masks so the
				// auto detector's protect mask does not change corroborated repairs. Hot/cold (auto) repairs
				// reuse their gate median, which was already recomputed with darkSkip when a master dark is present.
				if (!haveM) {
					const repairSkip = cause === 1 || cause === 2 ? (darkSkip ?? defectMask) : darkSkip
					if (repairSkip !== undefined) {
						m = neighborhoodMedian(plane, x, y, width, height, radius, step, window, repairSkip, undefined, Number.NaN)
					} else {
						m = residual !== undefined ? center - residual[p] : neighborhoodMedian(plane, x, y, width, height, radius, step, window, defectMask)
					}
				}

				const repaired = amount >= 1 ? m : center + amount * (m - center)
				if (!Number.isFinite(repaired)) continue
				raw[rawIndex] = repaired

				if (cause === 1) defect++
				else if (cause === 2) dark++
				else if (cause === 3) hot++
				else cold++
			}
		}
	}

	return { image, corrected: hot + cold + dark + defect, hot, cold, dark, defect }
}
