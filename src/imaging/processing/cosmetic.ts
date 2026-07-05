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

// CFA phase index of (x, y): a Bayer 2x2 mosaic has 4 interleaved photosite phases (each a distinct color
// position) that must be treated independently, so this maps to [0, 3] by pixel parity; a non-mosaic
// plane is a single phase (always 0). `phases` is 4 for a Bayer frame, 1 otherwise.
function phaseIndex(x: number, y: number, phases: number) {
	return phases === 1 ? 0 : (y & 1) * 2 + (x & 1)
}

// Robust median and scale of each CFA phase of `plane` (or one global pair when `phases === 1`), written
// into `medians`/`scales` (length `phases`). Same-phase samples are gathered by parity-strided scans into
// `gather`; `scratch` is the robust-computation scratch. Both buffers must hold at least width*height
// elements. A phase with no samples gets median NaN and scale 0 (its detection is effectively disabled).
function computePhaseStats(plane: Float64Array, width: number, height: number, phases: number, gather: Float64Array, scratch: Float64Array, medians: Float64Array, scales: Float64Array) {
	for (let ph = 0; ph < phases; ph++) {
		let count = 0

		if (phases === 1) {
			gather.set(plane.subarray(0, width * height))
			count = width * height
		} else {
			// Visit only the photosites of this phase via a parity-strided scan (px, py in {0, 1}).
			const py = ph >> 1
			const px = ph & 1
			for (let y = py; y < height; y += 2) {
				const row = y * width
				for (let x = px; x < width; x += 2) gather[count++] = plane[row + x]
			}
		}

		if (count === 0) {
			medians[ph] = Number.NaN
			scales[ph] = 0
			continue
		}

		const stats = robustPlaneScale(gather, count, scratch)
		medians[ph] = stats.median
		scales[ph] = stats.scale
	}
}

// Median of the neighborhood of (x, y), read from the deinterleaved `plane`. Samples the (2r+1)^2 lattice
// centered on (x, y) with a spacing of `step` pixels per axis, clamped to the image bounds. `step` is 1
// for a normal plane; for a Bayer CFA mosaic it is 2 so only same-color-phase photosites are gathered
// (adjacent photosites carry different colors and must not be mixed). When `skip` is given, neighbors
// flagged in it (the defect mask) are excluded so a repair interpolates only from good samples —
// essential for bad columns/rows, where the defective neighbors would otherwise bias the median toward
// one side. Falls back to including every sampled neighbor if the whole window is flagged, so the result
// is always finite. `buf` must hold at least (2r+1)^2 elements.
function neighborhoodMedian(plane: Float64Array, x: number, y: number, width: number, height: number, r: number, step: number, buf: Float64Array, skip?: Uint8Array) {
	let count = 0
	for (let ky = -r; ky <= r; ky++) {
		const yy = y + ky * step
		if (yy < 0 || yy >= height) continue
		const row = yy * width
		for (let kx = -r; kx <= r; kx++) {
			const xx = x + kx * step
			if (xx < 0 || xx >= width) continue
			const q = row + xx
			if (skip !== undefined && skip[q] !== 0) continue
			buf[count++] = plane[q]
		}
	}

	// Every sampled neighbor was flagged: re-gather without the skip so the repair stays finite.
	if (count === 0) {
		for (let ky = -r; ky <= r; ky++) {
			const yy = y + ky * step
			if (yy < 0 || yy >= height) continue
			const row = yy * width
			for (let kx = -r; kx <= r; kx++) {
				const xx = x + kx * step
				if (xx >= 0 && xx < width) buf[count++] = plane[row + xx]
			}
		}
	}

	buf.subarray(0, count).sort()
	return medianOf(buf, count)
}

// Decides whether a candidate pixel is a genuine isolated defect rather than the peak of a resolved
// source (a star). `sign` is +1 for a hot candidate, -1 for a cold one. Uses a robust local background
// `bg` (median over the slightly larger radius `bgRadius` window, where a compact source is a minority so
// the median is not pulled toward it) and requires both that the center exceeds the background by
// `sigma * scale` in the candidate direction AND that NO immediate 8-neighbor is itself that far from the
// background — a defect stands alone, a star's PSF elevates its neighbors. `skip` (the defect mask) is
// excluded from the background and neighbor tests. Returns true only for a confirmed isolated defect.
function isIsolatedDefect(plane: Float64Array, x: number, y: number, width: number, height: number, bgRadius: number, step: number, buf: Float64Array, skip: Uint8Array | undefined, scale: number, sigma: number, sign: number) {
	const bg = neighborhoodMedian(plane, x, y, width, height, bgRadius, step, buf, skip)
	const center = plane[y * width + x]
	const threshold = sigma * scale

	// The center must stand out from the robust background in the candidate direction.
	if (sign > 0 ? !(center - bg > threshold) : !(bg - center > threshold)) return false

	// Isolation: any immediate same-phase neighbor (one lattice step away) that is itself beyond the
	// background threshold in the same direction is support (a real source), so this is not a lone defect.
	const centerIndex = y * width + x
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

	return true
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

	// Optional protection mask for the auto detector; must match the frame so it aligns pixel-for-pixel.
	const protectMask = options.protect
	if (protectMask !== undefined && protectMask.length !== n) {
		throw new Error(`protect mask length must be ${n} (width*height), got ${protectMask.length}`)
	}

	// Background window for the isolation test spans one pixel more than the repair window so a compact
	// source stays a minority of the window and its median tracks the true background.
	const bgRadius = radius + 1

	// A Bayer CFA mosaic interleaves 4 color-phase photosites; neighborhoods and robust statistics must be
	// computed per phase so a valid uniform-color mosaic is not mistaken for a field of hot pixels.
	// `step` samples only same-phase photosites; `phases` splits the robust statistics accordingly.
	const bayer = metadata.bayer !== undefined
	const step = bayer ? 2 : 1
	const phases = bayer ? 4 : 1

	// Reusable scratch buffers, allocated once and shared across channels.
	const plane = new Float64Array(n)
	const scaleScratch = new Float64Array(n)
	const gatherBuf = new Float64Array(n)
	const window = new Float64Array((2 * radius + 1) * (2 * radius + 1))
	const bgWindow = new Float64Array((2 * bgRadius + 1) * (2 * bgRadius + 1))
	const darkPlane = dark0 !== undefined ? new Float64Array(n) : undefined

	// Per-phase robust statistics (one entry when not a mosaic).
	const phaseMedian = new Float64Array(phases)
	const phaseScale = new Float64Array(phases)
	const darkPhaseMedian = new Float64Array(phases)
	const darkPhaseScale = new Float64Array(phases)
	const darkThreshold = new Float64Array(phases)

	for (let channel = 0; channel < channels; channel++) {
		// Deinterleave the channel into a contiguous plane so neighbor reads are cache-friendly and repairs
		// (written back to the interleaved raw buffer) never feed into later neighborhood medians.
		for (let p = 0, i = channel; p < n; p++, i += channels) plane[p] = raw[i]

		computePhaseStats(plane, width, height, phases, gatherBuf, scaleScratch, phaseMedian, phaseScale)
		let autoEnabled = false
		for (let ph = 0; ph < phases; ph++) autoEnabled ||= phaseScale[ph] > 0
		autoEnabled &&= hotSigma > 0 || coldSigma > 0

		// Per-phase master-dark thresholds for this channel; a phase is disabled when its dark scale is 0.
		darkThreshold.fill(Number.POSITIVE_INFINITY)
		let darkEnabled = false
		if (darkPlane !== undefined) {
			for (let p = 0, i = channel; p < n; p++, i += channels) darkPlane[p] = dark0![i]
			computePhaseStats(darkPlane, width, height, phases, gatherBuf, scaleScratch, darkPhaseMedian, darkPhaseScale)
			for (let ph = 0; ph < phases; ph++) {
				if (darkPhaseScale[ph] > 0) {
					darkThreshold[ph] = darkPhaseMedian[ph] + darkHotSigma * darkPhaseScale[ph]
					darkEnabled = true
				}
			}
		}

		// Nothing to detect for this channel: skip the per-pixel scan entirely.
		if (defectMask === undefined && !darkEnabled && !autoEnabled) continue

		for (let y = 0; y < height; y++) {
			const rowBase = y * width
			for (let x = 0; x < width; x++) {
				const p = rowBase + x
				const center = plane[p]
				const ph = phaseIndex(x, y, phases)
				const gScale = phaseScale[ph]

				let m = 0
				let haveM = false
				let cause = 0

				if (defectMask !== undefined && defectMask[p] !== 0) {
					cause = 1
				} else if (darkEnabled && darkPlane![p] > darkThreshold[ph]) {
					cause = 2
				} else if (autoEnabled && gScale > 0 && (protectMask === undefined || protectMask[p] === 0)) {
					m = neighborhoodMedian(plane, x, y, width, height, radius, step, window, defectMask)
					haveM = true
					// The window-median deviation is a cheap gate; a candidate is confirmed only when the
					// isolation test (against the robust background) rules out a resolved source such as a star.
					if (hotSigma > 0 && center > m + hotSigma * gScale && isIsolatedDefect(plane, x, y, width, height, bgRadius, step, bgWindow, defectMask, gScale, hotSigma, 1)) cause = 3
					else if (coldSigma > 0 && center < m - coldSigma * gScale && isIsolatedDefect(plane, x, y, width, height, bgRadius, step, bgWindow, defectMask, gScale, coldSigma, -1)) cause = 4
				}

				if (cause === 0) continue

				if (!haveM) m = neighborhoodMedian(plane, x, y, width, height, radius, step, window, defectMask)
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
