import { medianOf, STANDARD_DEVIATION_SCALE, standardDeviationOf } from '../../core/util'
import { clamp, type NumberArray } from '../../math/numerical/math'
import type { Image } from '../model/types'

// Cosmetic correction: detects and repairs isolated sensor defects (hot, warm, and dead/cold pixels,
// plus known bad columns/rows) and replaces each with the median of its spatial neighborhood. Defects are
// found by any combination of three detectors, applied per channel:
//   1. auto local-deviation — a pixel that departs from its local (window) median by more than
//      `hotSigma`/`coldSigma` times the channel's robust noise scale (normalized MAD);
//   2. master-dark sigma — a pixel whose value in a supplied master dark frame is a high statistical
//      outlier (dark median + `darkHotSigma` * dark MAD), i.e. a fixed hot pixel;
//   3. explicit defect map — caller-provided bad pixels, columns, and rows repaired unconditionally.
// The repair value is the neighborhood median computed from the ORIGINAL (pre-correction) plane, so
// corrections never feed back into later ones. Operates in place on the [0, 1] raw buffer.

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
}

// Default cosmetic-correction options: 3-sigma auto detection on both tails over a 3x3 window, full
// replacement, no master dark, no explicit defects.
export const DEFAULT_COSMETIC_CORRECTION_OPTIONS: Readonly<Required<Omit<CosmeticCorrectionOptions, 'masterDark' | 'defects'>>> = {
	hotSigma: 3,
	coldSigma: 3,
	windowRadius: 1,
	amount: 1,
	darkHotSigma: 5,
}

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

// Robust center and scale of a plane's first `count` values. Returns the median and the normalized MAD
// (comparable to a standard deviation); falls back to the population standard deviation when the MAD
// collapses to 0 (a near-constant plane), and to 0 only when the plane is genuinely constant. `buf` is a
// reusable scratch array of at least `count` elements, sorted in place.
function robustPlaneScale(plane: Float64Array, count: number, buf: Float64Array) {
	buf.set(plane.subarray(0, count))
	buf.subarray(0, count).sort()
	const median = medianOf(buf, count)

	for (let i = 0; i < count; i++) buf[i] = Math.abs(plane[i] - median)
	buf.subarray(0, count).sort()
	const mad = STANDARD_DEVIATION_SCALE * medianOf(buf, count)

	const scale = mad > 0 ? mad : standardDeviationOf(plane, count)
	return { median, scale: Number.isFinite(scale) ? scale : 0 } as const
}

// Median of the neighborhood of (x, y) within radius `r`, clamped to the image bounds, read from the
// deinterleaved `plane`. Gathers up to (2r+1)^2 values into `buf` (reused across pixels) and returns
// their median. When `skip` is given, neighbors flagged in it (the defect mask) are excluded so a repair
// interpolates only from good samples — essential for bad columns/rows, where the defective neighbors
// would otherwise bias the median toward one side. Falls back to including every neighbor if the whole
// window is flagged, so the result is always finite. `buf` must hold at least (2r+1)^2 elements.
function neighborhoodMedian(plane: Float64Array, x: number, y: number, width: number, height: number, r: number, buf: Float64Array, skip?: Uint8Array) {
	const y0 = Math.max(0, y - r)
	const y1 = Math.min(height - 1, y + r)
	const x0 = Math.max(0, x - r)
	const x1 = Math.min(width - 1, x + r)

	let count = 0
	for (let yy = y0; yy <= y1; yy++) {
		const row = yy * width
		for (let xx = x0; xx <= x1; xx++) {
			const q = row + xx
			if (skip !== undefined && skip[q] !== 0) continue
			buf[count++] = plane[q]
		}
	}

	// Every neighbor was flagged: re-gather without the skip so the repair stays finite.
	if (count === 0) {
		for (let yy = y0; yy <= y1; yy++) {
			const row = yy * width
			for (let xx = x0; xx <= x1; xx++) buf[count++] = plane[row + xx]
		}
	}

	buf.subarray(0, count).sort()
	return medianOf(buf, count)
}

// Builds the geometry-level defect mask (shared across channels) from an explicit defect map, or returns
// undefined when there is nothing to mark. Out-of-range entries are ignored so callers can pass loose
// lists without pre-filtering.
function buildDefectMask(defects: CosmeticDefectMap | undefined, width: number, height: number) {
	if (defects === undefined) return undefined
	const { pixels, columns, rows } = defects
	if ((!pixels || pixels.length === 0) && (!columns || columns.length === 0) && (!rows || rows.length === 0)) return undefined

	const mask = new Uint8Array(width * height)

	if (columns) {
		for (const col of columns) {
			if (!Number.isInteger(col) || col < 0 || col >= width) continue
			for (let y = 0; y < height; y++) mask[y * width + col] = 1
		}
	}

	if (rows) {
		for (const row of rows) {
			if (!Number.isInteger(row) || row < 0 || row >= height) continue
			const base = row * width
			for (let x = 0; x < width; x++) mask[base + x] = 1
		}
	}

	if (pixels) {
		for (const [x, y] of pixels) {
			if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || x >= width || y < 0 || y >= height) continue
			mask[y * width + x] = 1
		}
	}

	return mask
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
	const radius = Number.isFinite(options.windowRadius) ? Math.max(1, Math.trunc(options.windowRadius!)) : DEFAULT_COSMETIC_CORRECTION_OPTIONS.windowRadius
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

	const defectMask = buildDefectMask(options.defects, width, height)

	// Reusable scratch buffers, allocated once and shared across channels.
	const plane = new Float64Array(n)
	const scaleScratch = new Float64Array(n)
	const window = new Float64Array((2 * radius + 1) * (2 * radius + 1))
	const darkPlane = dark0 !== undefined ? new Float64Array(n) : undefined

	for (let channel = 0; channel < channels; channel++) {
		// Deinterleave the channel into a contiguous plane so neighbor reads are cache-friendly and repairs
		// (written back to the interleaved raw buffer) never feed into later neighborhood medians.
		for (let p = 0, i = channel; p < n; p++, i += channels) plane[p] = raw[i]

		const { scale: gScale } = robustPlaneScale(plane, n, scaleScratch)
		const autoEnabled = gScale > 0 && (hotSigma > 0 || coldSigma > 0)

		// Master-dark threshold for this channel; disabled when the dark plane is constant (scale 0).
		let darkThreshold = Number.POSITIVE_INFINITY
		if (darkPlane !== undefined) {
			for (let p = 0, i = channel; p < n; p++, i += channels) darkPlane[p] = dark0![i]
			const darkStats = robustPlaneScale(darkPlane, n, scaleScratch)
			if (darkStats.scale > 0) darkThreshold = darkStats.median + darkHotSigma * darkStats.scale
		}
		const darkEnabled = darkPlane !== undefined && Number.isFinite(darkThreshold)

		// Nothing to detect for this channel: skip the per-pixel scan entirely.
		if (defectMask === undefined && !darkEnabled && !autoEnabled) continue

		for (let y = 0; y < height; y++) {
			const rowBase = y * width
			for (let x = 0; x < width; x++) {
				const p = rowBase + x
				const center = plane[p]

				let m = 0
				let haveM = false
				let cause = 0

				if (defectMask !== undefined && defectMask[p] !== 0) {
					cause = 1
				} else if (darkEnabled && darkPlane[p] > darkThreshold) {
					cause = 2
				} else if (autoEnabled) {
					m = neighborhoodMedian(plane, x, y, width, height, radius, window, defectMask)
					haveM = true
					if (hotSigma > 0 && center > m + hotSigma * gScale) cause = 3
					else if (coldSigma > 0 && center < m - coldSigma * gScale) cause = 4
				}

				if (cause === 0) continue

				if (!haveM) m = neighborhoodMedian(plane, x, y, width, height, radius, window, defectMask)
				raw[p * channels + channel] = amount >= 1 ? m : center + amount * (m - center)

				if (cause === 1) defect++
				else if (cause === 2) dark++
				else if (cause === 3) hot++
				else cold++
			}
		}
	}

	return { image, corrected: hot + cold + dark + defect, hot, cold, dark, defect }
}
