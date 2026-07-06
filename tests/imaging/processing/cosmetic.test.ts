import { expect, test } from 'bun:test'
import { cosmeticCorrection } from '../../../src/imaging/processing/cosmetic'
import { generateNoiseImage } from '../../../src/imaging/synthetic/generator'
import { mulberry32 } from '../../../src/math/numerical/random'
import { makeImage, pixelOffset } from './util'

// A horizontal ramp so the 3x3 local median tracks the background exactly (median of a horizontal ramp
// window is the center column value), leaving normal pixels with ~0 residual and no false positives.
function rampImage(width: number, height: number, lo: number, hi: number) {
	const values = new Float32Array(width * height)
	for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) values[y * width + x] = lo + (hi - lo) * (x / (width - 1))
	return { values, at: (x: number) => lo + (hi - lo) * (x / (width - 1)) }
}

test('auto detection repairs an isolated hot and dead pixel, leaving the background untouched', () => {
	const width = 20
	const height = 15
	const { values, at } = rampImage(width, height, 0.3, 0.34)
	values[7 * width + 10] = 0.9 // hot pixel well above the local median
	values[3 * width + 5] = 0 // dead pixel well below the local median
	const image = makeImage(width, height, 1, values)

	const result = cosmeticCorrection(image)

	expect(result.hot).toBe(1)
	expect(result.cold).toBe(1)
	expect(result.corrected).toBe(2)

	// Both defects are replaced by the local ramp value.
	expect(image.raw[pixelOffset(image, 10, 7)]).toBeCloseTo(at(10), 3)
	expect(image.raw[pixelOffset(image, 5, 3)]).toBeCloseTo(at(5), 3)

	// A normal pixel is left exactly as it was.
	expect(image.raw[pixelOffset(image, 15, 10)]).toBeCloseTo(at(15), 6)
})

test('a clean gradient produces no false positives', () => {
	const width = 24
	const height = 18
	const { values } = rampImage(width, height, 0.2, 0.6)
	const image = makeImage(width, height, 1, values)

	const result = cosmeticCorrection(image)

	expect(result.corrected).toBe(0)
})

test('hotSigma 0 disables hot detection while cold detection still runs', () => {
	const width = 20
	const height = 12
	const { values } = rampImage(width, height, 0.3, 0.34)
	values[6 * width + 10] = 0.9
	values[4 * width + 5] = 0
	const image = makeImage(width, height, 1, values)

	const { at } = rampImage(width, height, 0.3, 0.34)
	const result = cosmeticCorrection(image, { hotSigma: 0, coldSigma: 3 })

	expect(result.hot).toBe(0)
	expect(result.cold).toBe(1)
	// The hot pixel survives untouched, the dead one is repaired to the local ramp value.
	expect(image.raw[pixelOffset(image, 10, 6)]).toBeCloseTo(0.9, 6)
	expect(image.raw[pixelOffset(image, 5, 4)]).toBeCloseTo(at(5), 3)
})

test('amount partially blends the repair toward the local median', () => {
	const width = 20
	const height = 10
	const { values, at } = rampImage(width, height, 0.3, 0.34)
	values[5 * width + 10] = 0.9
	const image = makeImage(width, height, 1, values)

	cosmeticCorrection(image, { coldSigma: 0, amount: 0.5 })

	// Halfway between the original hot value and the local median.
	const expected = 0.9 + 0.5 * (at(10) - 0.9)
	expect(image.raw[pixelOffset(image, 10, 5)]).toBeCloseTo(expected, 3)
})

test('a master dark flags fixed hot pixels even with auto detection disabled', () => {
	const width = 20
	const height = 12
	const { values, at } = rampImage(width, height, 0.3, 0.34)
	// A real hot pixel is hot in both the light and the dark; place it at the same location.
	values[6 * width + 8] = 0.85
	const image = makeImage(width, height, 1, values)

	// Faint dark ramp (non-zero robust scale) plus one strong spike at the defect location.
	const dark = new Float32Array(width * height)
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) dark[y * width + x] = 0.01 + 0.002 * (x / (width - 1))
	}
	dark[6 * width + 8] = 0.8
	const masterDark = makeImage(width, height, 1, dark)

	const result = cosmeticCorrection(image, { hotSigma: 0, coldSigma: 0, masterDark })

	expect(result.dark).toBe(1)
	expect(result.corrected).toBe(1)
	expect(image.raw[pixelOffset(image, 8, 6)]).toBeCloseTo(at(8), 3)
})

test('an explicit defect column is repaired unconditionally', () => {
	const width = 16
	const height = 10
	const { values, at } = rampImage(width, height, 0.25, 0.55)
	// Zero out a whole column to simulate a dead column.
	for (let y = 0; y < height; y++) values[y * width + 8] = 0
	const image = makeImage(width, height, 1, values)

	const result = cosmeticCorrection(image, { hotSigma: 0, coldSigma: 0, defects: { columns: [8] } })

	expect(result.defect).toBe(height)
	expect(result.corrected).toBe(height)
	// Every repaired column pixel sits back on the ramp value at x = 8.
	for (let y = 0; y < height; y++) expect(image.raw[pixelOffset(image, 8, y)]).toBeCloseTo(at(8), 3)
})

test('end-to-end: detects and repairs synthetic hot/dead pixels from the generator', () => {
	const width = 64
	const height = 64
	const raw = new Float32Array(width * height)
	// High defect rates so several hot/dead pixels are injected deterministically.
	const { stats } = generateNoiseImage(raw, width, height, 1, { seed: 12345, artifacts: { hotPixelRate: 0.01, deadPixelRate: 0.006 }, output: { clampMode: 'clamp' } })

	expect(stats.hotPixelCount).toBeGreaterThan(0)

	// The injected hot pixels are the brightest samples in the frame.
	let maxBefore = -Infinity
	for (let i = 0; i < raw.length; i++) if (raw[i] > maxBefore) maxBefore = raw[i]

	const image = makeImage(width, height, 1, raw)
	const result = cosmeticCorrection(image, { hotSigma: 4, coldSigma: 4 })

	// Some defects were repaired, but only a tiny fraction of the frame (no wholesale rejection).
	expect(result.corrected).toBeGreaterThan(0)
	expect(result.hot).toBeGreaterThan(0)
	expect(result.corrected).toBeLessThan(width * height * 0.02)

	// Repairing the hot pixels pulls the global maximum down.
	let maxAfter = -Infinity
	for (let i = 0; i < image.raw.length; i++) if (image.raw[i] > maxAfter) maxAfter = image.raw[i]
	expect(maxAfter).toBeLessThan(maxBefore)
})

test('a resolved compact star is protected from auto repair by the isolation test', () => {
	// A flat sky with one compact but resolved star: a bright core whose PSF spreads flux into the
	// adjacent pixels. The isolation test must recognize the neighbor support and leave the whole star
	// untouched instead of repairing the peak as a hot pixel.
	const width = 20
	const height = 20
	const values = new Float32Array(width * height).fill(0.1)
	const set = (x: number, y: number, v: number) => (values[y * width + x] = v)
	set(10, 10, 0.8) // core
	set(9, 10, 0.4)
	set(11, 10, 0.4)
	set(10, 9, 0.4)
	set(10, 11, 0.4) // first ring
	set(9, 9, 0.2)
	set(11, 9, 0.2)
	set(9, 11, 0.2)
	set(11, 11, 0.2) // diagonals
	const image = makeImage(width, height, 1, values)
	const before = Float32Array.from(image.raw)

	const result = cosmeticCorrection(image)

	expect(result.corrected).toBe(0)
	// The star core and its wings are untouched.
	expect(image.raw[pixelOffset(image, 10, 10)]).toBeCloseTo(0.8, 6)
	for (let i = 0; i < before.length; i++) expect(image.raw[i]).toBe(before[i])
})

test('a single-pixel source is repaired unless an explicit protect mask covers it', () => {
	const width = 20
	const height = 20
	const values = new Float32Array(width * height).fill(0.1)
	values[10 * width + 10] = 0.8 // an unresolved point confined to one pixel
	const image = makeImage(width, height, 1, values)

	// Without protection a lone bright pixel is indistinguishable from a hot pixel and is repaired.
	const unprotected = cosmeticCorrection(makeImage(width, height, 1, Float32Array.from(values)))
	expect(unprotected.hot).toBe(1)

	// A protect mask over that pixel keeps the auto detector away from it.
	const protect = new Uint8Array(width * height)
	protect[10 * width + 10] = 1
	const result = cosmeticCorrection(image, { protect })

	expect(result.corrected).toBe(0)
	expect(image.raw[pixelOffset(image, 10, 10)]).toBeCloseTo(0.8, 6)
})

test('a wrongly sized protect mask throws', () => {
	const width = 8
	const height = 8
	const { values } = rampImage(width, height, 0.3, 0.34)
	const image = makeImage(width, height, 1, values)
	expect(() => cosmeticCorrection(image, { protect: new Uint8Array(10) })).toThrow('protect mask length')
})

// Builds a single-channel RGGB Bayer mosaic with uniform per-color levels: R at (even, even),
// G at (odd, even) and (even, odd), B at (odd, odd).
function rggbMosaic(width: number, height: number, r: number, g: number, b: number) {
	const values = new Float32Array(width * height)
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const even = (x & 1) === 0
			values[y * width + x] = (y & 1) === 0 ? (even ? r : g) : even ? g : b
		}
	}
	return values
}

test('a uniform-color RGGB mosaic yields zero corrections', () => {
	// Adjacent photosites carry different colors (R=0.8, G=0.2, B=0.1). A naive full-neighborhood detector
	// would flag every red photosite as a hot pixel; the per-CFA-phase statistics must leave the raw
	// mosaic completely untouched.
	const width = 24
	const height = 24
	const values = rggbMosaic(width, height, 0.8, 0.2, 0.1)
	const image = makeImage(width, height, 1, values, { BAYERPAT: 'RGGB' })
	expect(image.metadata.bayer).toBe('RGGB')
	const before = Float32Array.from(image.raw)

	const result = cosmeticCorrection(image)

	expect(result.corrected).toBe(0)
	for (let i = 0; i < before.length; i++) expect(image.raw[i]).toBe(before[i])
})

test('a hot photosite in an RGGB mosaic is still repaired from its own color phase', () => {
	const width = 24
	const height = 24
	const values = rggbMosaic(width, height, 0.8, 0.2, 0.1)
	// A hot red photosite (red phase is (even, even)); its same-color neighbors sit at the 0.8 red level.
	values[10 * width + 12] = 0.98
	const image = makeImage(width, height, 1, values, { BAYERPAT: 'RGGB' })

	const result = cosmeticCorrection(image)

	expect(result.hot).toBe(1)
	expect(result.corrected).toBe(1)
	// Repaired to the red level from same-phase neighbors, not to the green/blue neighborhood.
	expect(image.raw[pixelOffset(image, 12, 10)]).toBeCloseTo(0.8, 5)
})

test('a resolved star on an RGGB mosaic is protected by cross-phase PSF support', () => {
	// A resolved star centered on a red photosite has a bright core in the red phase but its PSF spills
	// into the adjacent green/blue CFA pixels. The same-phase isolation loop (step=2) alone sees only
	// distant red neighbors at background level and would flag the core as hot; the cross-phase 8-neighbor
	// check (step=1) must recognize the elevated adjacent CFA pixels as support.
	const width = 24
	const height = 24
	const values = rggbMosaic(width, height, 0.8, 0.2, 0.1)
	// Star core at an even-even (red) photosite.
	const cx = 12
	const cy = 10
	values[cy * width + cx] = 0.96
	// PSF wings in adjacent CFA pixels — same raw 8-neighborhood.
	values[cy * width + cx - 1] = 0.55 // green to the left
	values[cy * width + cx + 1] = 0.55 // green to the right
	values[(cy - 1) * width + cx] = 0.55 // green above
	values[(cy + 1) * width + cx] = 0.55 // green below
	const image = makeImage(width, height, 1, values, { BAYERPAT: 'RGGB' })

	const result = cosmeticCorrection(image)

	// The star core must not be flagged as hot — its cross-phase neighbors are elevated.
	expect(result.corrected).toBe(0)
	expect(image.raw[pixelOffset(image, cx, cy)]).toBeCloseTo(0.96, 6)
})

test('a hot pixel on a strong gradient is detected when the scale comes from local residuals', () => {
	// A steep 0..1 horizontal ramp: the raw plane's global spread is huge, so a global-MAD threshold would
	// swamp a real defect. The spike sits near the bright end where its excess over the local level is only
	// ~0.2, far below 3 * global-MAD but far above the local-residual noise. Estimating the scale from
	// local-median residuals removes the gradient and exposes the spike.
	const width = 100
	const height = 10
	const values = new Float32Array(width * height)
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) values[y * width + x] = x / (width - 1)
	}
	const spikeX = 80
	const spikeY = 5
	const localLevel = spikeX / (width - 1)
	values[spikeY * width + spikeX] = 1 // saturated single-pixel spike above the local ramp level

	const image = makeImage(width, height, 1, values)
	const result = cosmeticCorrection(image)

	expect(result.hot).toBe(1)
	expect(result.corrected).toBe(1)
	// Repaired back onto the ramp, not left saturated.
	expect(image.raw[pixelOffset(image, spikeX, spikeY)]).toBeCloseTo(localLevel, 2)
})

test('a huge window radius on a small image is clamped without exhausting memory', () => {
	// windowRadius is user-provided and only floored at 1; a naive (2r+1)^2 scratch buffer would try to
	// allocate tens of billions of samples here. The radius must be clamped to the image extent so the call
	// completes and still repairs the defect using the whole (clamped) neighborhood.
	const width = 12
	const height = 8
	const { values, at } = rampImage(width, height, 0.3, 0.34)
	values[4 * width + 6] = 0.95 // a hot pixel
	const image = makeImage(width, height, 1, values)

	const result = cosmeticCorrection(image, { windowRadius: 100000 })

	expect(result.hot).toBe(1)
	expect(result.corrected).toBe(1)
	// Repaired onto the ramp (the clamped whole-image median), not left saturated.
	const repaired = image.raw[pixelOffset(image, 6, 4)]
	expect(repaired).toBeGreaterThan(at(0))
	expect(repaired).toBeLessThan(at(width - 1))
})

test('a debayered RGB image with bayer metadata is treated as a non-mosaic frame', () => {
	// debayer() preserves `metadata.bayer` on the output RGB image (src/imaging/processing/debayer.ts:209),
	// so cosmeticCorrection must gate CFA-phase handling on channels===1 to avoid parity-striding inside
	// each contiguous RGB channel.
	const width = 20
	const height = 20
	const values = new Float32Array(width * height * 3)
	// Fill each channel with a ramp so there is structured content to process.
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const p = y * width + x
			values[p * 3 + 0] = 0.3 + 0.1 * (x / (width - 1))
			values[p * 3 + 1] = 0.4 + 0.05 * (x / (width - 1))
			values[p * 3 + 2] = 0.2 + 0.08 * (x / (width - 1))
		}
	}
	// Inject a hot pixel in the red channel.
	values[(10 * width + 12) * 3 + 0] = 0.95
	const image = makeImage(width, height, 3, values, { BAYERPAT: 'RGGB' })
	expect(image.metadata.bayer).toBe('RGGB')
	expect(image.metadata.channels).toBe(3)

	const result = cosmeticCorrection(image)

	// The hot pixel must be detected and repaired (3-channel image, so step=1 contiguous neighborhood).
	expect(result.hot).toBe(1)
	// Only that one pixel is touched — no CFA-phase confusion across channels.
	expect(result.corrected).toBe(1)
})

test('explicit defects are excluded from master-dark statistics', () => {
	// A mapped bad column in the defect map produces saturated values in the master dark. Without the fix
	// those saturated values inflate the dark's robust scale, raising the detection threshold so other
	// fixed hot pixels in the same dark fall below it and are missed. Passing defectMask to
	// computePhaseStats keeps the bad column out of the dark statistics.
	const width = 20
	const height = 12
	const { values, at } = rampImage(width, height, 0.3, 0.34)
	// A real hot pixel in the light frame.
	values[6 * width + 15] = 0.85
	const image = makeImage(width, height, 1, values)

	// Master dark: a faint ramp plus one saturated bad column (x=10) and one separate hot pixel (x=5).
	const dark = new Float32Array(width * height)
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) dark[y * width + x] = 0.01 + 0.002 * (x / (width - 1))
	}
	// Saturated bad column in the dark — would dominate the MAD if included.
	for (let y = 0; y < height; y++) dark[y * width + 10] = 1
	// Separate fixed hot pixel at a different column.
	dark[6 * width + 5] = 0.7
	const masterDark = makeImage(width, height, 1, dark)

	const result = cosmeticCorrection(image, {
		hotSigma: 0,
		coldSigma: 0,
		masterDark,
		defects: { columns: [10] },
	})

	// The defect-map column (height pixels) + the dark-flagged pixel at (5, 6) whose dark value is 0.7.
	expect(result.defect).toBe(height)
	expect(result.dark).toBe(1)
	expect(result.corrected).toBe(height + 1)
	// The light-frame pixel at (15, 6) was a hot pixel but the dark at that position is normal — only the
	// dark-flagged pixel at (5, 6) is repaired by the dark path.
	expect(image.raw[pixelOffset(image, 15, 6)]).toBeCloseTo(0.85, 3) // untouched by dark detection
	expect(image.raw[pixelOffset(image, 5, 6)]).toBeCloseTo(at(5), 3) // repaired from dark flag
})

test('a dark-hot cluster with auto detection enabled is fully repaired', () => {
	// When auto detection and master dark are both active, the medianField was computed without
	// darkSkip, so reusing it for dark-path repairs would include neighboring hot pixels in the
	// repair median. The fix always recomputes with darkSkip for cause===2.
	const width = 20
	const height = 20
	const values = new Float32Array(width * height).fill(0.1)
	// A 5-pixel cross-shaped hot cluster in the light frame.
	const cx = 10
	const cy = 10
	values[cy * width + cx] = 0.9 // center
	values[cy * width + cx - 1] = 0.9
	values[cy * width + cx + 1] = 0.9
	values[(cy - 1) * width + cx] = 0.9
	values[(cy + 1) * width + cx] = 0.9
	const image = makeImage(width, height, 1, values)

	// Master dark: same cluster is hot.
	const dark = new Float32Array(width * height).fill(0.01)
	dark[cy * width + cx] = 0.8
	dark[cy * width + cx - 1] = 0.8
	dark[cy * width + cx + 1] = 0.8
	dark[(cy - 1) * width + cx] = 0.8
	dark[(cy + 1) * width + cx] = 0.8
	const masterDark = makeImage(width, height, 1, dark)

	const result = cosmeticCorrection(image, { masterDark })
	// With the fix all 5 cluster pixels are dark-repaired, not left hot.
	expect(result.dark).toBe(5)
	expect(result.corrected).toBe(5)
	// The cluster center is repaired back to the background.
	expect(image.raw[pixelOffset(image, cx, cy)]).toBeCloseTo(0.1, 3)
})

test('a mapped defect surrounded by dark-flagged pixels uses darkSkip for repair', () => {
	// When a pixel is in both the explicit defect map and surrounded by master-dark hot pixels,
	// the defect repair must exclude co-flagged dark neighbors so the repair doesn't interpolate
	// from hot neighbors.
	const width = 20
	const height = 12
	const { values, at } = rampImage(width, height, 0.3, 0.34)
	const image = makeImage(width, height, 1, values)

	// Master dark: faint ramp plus a 3x3 hot cluster at (10, 6).
	const dark = new Float32Array(width * height)
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) dark[y * width + x] = 0.01 + 0.002 * (x / (width - 1))
	}
	for (let dy = -1; dy <= 1; dy++) {
		for (let dx = -1; dx <= 1; dx++) dark[(6 + dy) * width + (10 + dx)] = 0.8
	}
	const masterDark = makeImage(width, height, 1, dark)

	// Mark the center of the dark-hot cluster as an explicit defect pixel.
	const result = cosmeticCorrection(image, {
		hotSigma: 0,
		coldSigma: 0,
		masterDark,
		defects: { pixels: [[10, 6]] },
	})

	// The mapped pixel at (10, 6) is counted as defect; the 8 surrounding dark-hot pixels are
	// also repaired (counted as dark). Without the fix, the mapped pixel would interpolate from
	// its hot dark neighbors and stay elevated.
	expect(result.defect).toBe(1)
	expect(result.dark).toBe(8)
	expect(result.corrected).toBe(9)
	// The mapped pixel is repaired back to the ramp level by expanding past the hot cluster.
	expect(image.raw[pixelOffset(image, 10, 6)]).toBeCloseTo(at(10), 2)
})

test('an RGGB star with noisier red phase and modest green wings is preserved', () => {
	// When the red (candidate) phase has more noise than the green (neighbor) phase, the cross-phase
	// threshold must use the green phase's own scale. Using the red phase's larger scale would make
	// the raw threshold too wide and miss the green support or make the residual threshold too tight
	// and incorrectly reject PSF wings.
	const width = 24
	const height = 24
	const values = rggbMosaic(width, height, 0.8, 0.2, 0.1)
	const random = mulberry32(0)
	// Inject noise into the red phase to inflate its scale (random offsets at red positions).
	for (let y = 0; y < height; y += 2) {
		for (let x = 0; x < width; x += 2) {
			values[y * width + x] += (random() - 0.5) * 0.06
		}
	}
	// Star core at a red photosite with modest green wings.
	const cx = 12
	const cy = 10
	values[cy * width + cx] = 0.96
	// Modest green wings (only 0.35, not the 0.55 from earlier tests).
	values[cy * width + cx - 1] = 0.35
	values[cy * width + cx + 1] = 0.35
	values[(cy - 1) * width + cx] = 0.35
	values[(cy + 1) * width + cx] = 0.35
	const image = makeImage(width, height, 1, values, { BAYERPAT: 'RGGB' })

	const result = cosmeticCorrection(image)

	// The star core must survive — green wings are anomalous in their own phase.
	expect(result.corrected).toBe(0)
	expect(image.raw[pixelOffset(image, cx, cy)]).toBeCloseTo(0.96, 4)
})

test('a flat master dark with a hot column still detects the defects', () => {
	// A flat (constant) dark background has MAD=0, so the stddev fallback includes the hot column
	// itself and inflates the threshold past the defects. The trimmed-scale clamp must recognize
	// the dark background is constant and use a lower threshold.
	const width = 20
	const height = 12
	const { values, at } = rampImage(width, height, 0.3, 0.34)
	values[6 * width + 15] = 0.85 // light-frame hot pixel
	const image = makeImage(width, height, 1, values)

	// Flat dark at 0.01 everywhere except one hot column at x=10.
	const dark = new Float32Array(width * height)
	dark.fill(0.01)
	for (let y = 0; y < height; y++) dark[y * width + 10] = 0.8
	// A separate hot pixel away from the column.
	dark[6 * width + 5] = 0.7
	const masterDark = makeImage(width, height, 1, dark)

	const result = cosmeticCorrection(image, {
		hotSigma: 0,
		coldSigma: 0,
		masterDark,
	})

	// The hot column in the dark produces 12 dark-flagged repairs; the separate hot pixel at
	// (5, 6) adds 1 more. Without the trimmed-scale clamp, the column-inflated threshold would
	// miss both.
	expect(result.dark).toBe(height + 1)
	expect(result.corrected).toBe(height + 1)
	expect(image.raw[pixelOffset(image, 15, 6)]).toBeCloseTo(0.85, 3) // light hot pixel untouched
	expect(image.raw[pixelOffset(image, 5, 6)]).toBeCloseTo(at(5), 3)
})

test('a two-sample master dark phase keeps its measured scale', () => {
	// With only two clean samples, trimming one value would collapse the dark scale to zero and make the
	// brighter normal sample look like a fixed hot pixel. The trimmed clamp only applies when at least two
	// samples remain after trimming.
	const width = 2
	const height = 1
	const values = new Float32Array([0.1, 0.11])
	const image = makeImage(width, height, 1, values)
	const before = Float32Array.from(image.raw)
	const masterDark = makeImage(width, height, 1, new Float32Array([0.01, 0.02]))

	const result = cosmeticCorrection(image, { hotSigma: 0, coldSigma: 0, masterDark })

	expect(result.corrected).toBe(0)
	for (let i = 0; i < before.length; i++) expect(image.raw[i]).toBe(before[i])
})

test('a quantized clean master dark high tail is not treated as zero-noise defects', () => {
	// A small quantized high tail above a flat dark background is ordinary fixed-pattern variation, not a
	// saturated fixed-hot column. The zero-MAD trimmed fallback must keep a nonzero scale.
	const width = 20
	const height = 5
	const values = new Float32Array(width * height).fill(0.1)
	const image = makeImage(width, height, 1, values)
	const before = Float32Array.from(image.raw)

	const dark = new Float32Array(width * height).fill(0.01)
	for (let i = 0; i < 5; i++) dark[i] = 0.011
	const masterDark = makeImage(width, height, 1, dark)

	const result = cosmeticCorrection(image, { hotSigma: 0, coldSigma: 0, masterDark })

	expect(result.corrected).toBe(0)
	for (let i = 0; i < before.length; i++) expect(image.raw[i]).toBe(before[i])
})

test('a 3x3 dark-hot block is repaired from exterior neighbors not the cluster', () => {
	// A 3x3 block of fixed-hot pixels in both light and master dark covers the entire default 3x3
	// repair window (radius=1). Without window expansion, the fallback would use the hot cluster's
	// own median and leave the center unrepaired while reporting it corrected.
	const width = 20
	const height = 20
	const values = new Float32Array(width * height).fill(0.1)
	// 3x3 hot block at (8..10, 8..10).
	for (let dy = -1; dy <= 1; dy++) {
		for (let dx = -1; dx <= 1; dx++) values[(10 + dy) * width + (10 + dx)] = 0.9
	}
	const image = makeImage(width, height, 1, values)

	// Master dark: same 3x3 block is hot.
	const dark = new Float32Array(width * height).fill(0.01)
	for (let dy = -1; dy <= 1; dy++) {
		for (let dx = -1; dx <= 1; dx++) dark[(10 + dy) * width + (10 + dx)] = 0.8
	}
	const masterDark = makeImage(width, height, 1, dark)

	const result = cosmeticCorrection(image, { hotSigma: 0, coldSigma: 0, masterDark })

	// All 9 cluster pixels are dark-flagged and repaired from exterior good neighbors.
	expect(result.dark).toBe(9)
	expect(result.corrected).toBe(9)
	// The cluster center is repaired to the background level.
	expect(image.raw[pixelOffset(image, 10, 10)]).toBeCloseTo(0.1, 2)
})

test('a 5x5 dark-hot block grows repair scratch for expanded neighbors', () => {
	// The default repair scratch holds a 3x3 window. A 5x5 flagged block forces expansion to a 7x7
	// neighborhood, where the exterior good samples must all be retained for a finite median.
	const width = 20
	const height = 20
	const values = new Float32Array(width * height).fill(0.1)
	for (let y = 8; y <= 12; y++) {
		for (let x = 8; x <= 12; x++) values[y * width + x] = 0.9
	}
	const image = makeImage(width, height, 1, values)

	const dark = new Float32Array(width * height).fill(0.01)
	for (let y = 8; y <= 12; y++) {
		for (let x = 8; x <= 12; x++) dark[y * width + x] = 0.8
	}
	const masterDark = makeImage(width, height, 1, dark)

	const result = cosmeticCorrection(image, { hotSigma: 0, coldSigma: 0, masterDark })

	expect(result.dark).toBe(25)
	expect(result.corrected).toBe(25)
	expect(image.raw[pixelOffset(image, 10, 10)]).toBeCloseTo(0.1, 2)
	expect(Number.isFinite(image.raw[pixelOffset(image, 10, 10)])).toBe(true)
})

test('a fully mapped bad frame does not hang when no repair neighbor exists', () => {
	// Every sample is explicitly skipped, so no unflagged repair neighbor exists anywhere in the frame.
	// The median helper must stop expanding and leave samples unchanged instead of looping forever.
	const width = 4
	const height = 4
	const values = new Float32Array(width * height)
	for (let i = 0; i < values.length; i++) values[i] = 0.1 + i * 0.01
	const image = makeImage(width, height, 1, values)
	const before = Float32Array.from(image.raw)

	const result = cosmeticCorrection(image, { hotSigma: 0, coldSigma: 0, defects: { columns: [0, 1, 2, 3] } })

	expect(result.defect).toBe(width * height)
	expect(result.corrected).toBe(width * height)
	for (let i = 0; i < before.length; i++) expect(image.raw[i]).toBe(before[i])
})

test('auto isolation ignores neighbors already flagged by the master dark', () => {
	// The transient hot pixel at (10, 10) is adjacent to a fixed hot pixel identified by the master dark.
	// That dark-flagged neighbor is not PSF support, so the transient remains isolated and is repaired too.
	const width = 20
	const height = 20
	const values = new Float32Array(width * height).fill(0.1)
	values[10 * width + 10] = 0.9
	values[10 * width + 11] = 0.9
	const image = makeImage(width, height, 1, values)

	const dark = new Float32Array(width * height).fill(0.01)
	dark[10 * width + 11] = 0.8
	const masterDark = makeImage(width, height, 1, dark)

	const result = cosmeticCorrection(image, { masterDark })

	expect(result.dark).toBe(1)
	expect(result.hot).toBe(1)
	expect(result.corrected).toBe(2)
	expect(image.raw[pixelOffset(image, 10, 10)]).toBeCloseTo(0.1, 3)
	expect(image.raw[pixelOffset(image, 11, 10)]).toBeCloseTo(0.1, 3)
})

test('auto gate uses darkSkip when multiple dark neighbors bias the local median', () => {
	// Four fixed hot neighbors make the unmasked 3x3 median hot enough to hide the transient center.
	// The auto gate must use the darkSkip median before deciding whether the center is a candidate.
	const width = 20
	const height = 20
	const values = new Float32Array(width * height).fill(0.1)
	const cx = 10
	const cy = 10
	values[cy * width + cx] = 0.9
	values[cy * width + cx - 1] = 0.9
	values[cy * width + cx + 1] = 0.9
	values[(cy - 1) * width + cx] = 0.9
	values[(cy + 1) * width + cx] = 0.9
	const image = makeImage(width, height, 1, values)

	const dark = new Float32Array(width * height).fill(0.01)
	dark[cy * width + cx - 1] = 0.8
	dark[cy * width + cx + 1] = 0.8
	dark[(cy - 1) * width + cx] = 0.8
	dark[(cy + 1) * width + cx] = 0.8
	const masterDark = makeImage(width, height, 1, dark)

	const result = cosmeticCorrection(image, { masterDark })

	expect(result.dark).toBe(4)
	expect(result.hot).toBe(1)
	expect(result.corrected).toBe(5)
	expect(image.raw[pixelOffset(image, cx, cy)]).toBeCloseTo(0.1, 3)
})

test('an empty image and amount 0 are no-ops', () => {
	const empty = makeImage(0, 0, 1, new Float32Array(0))
	expect(cosmeticCorrection(empty).corrected).toBe(0)

	const width = 8
	const height = 8
	const { values } = rampImage(width, height, 0.3, 0.34)
	values[4 * width + 4] = 0.9
	const image = makeImage(width, height, 1, values)
	const result = cosmeticCorrection(image, { amount: 0 })
	expect(result.corrected).toBe(0)
	expect(image.raw[pixelOffset(image, 4, 4)]).toBeCloseTo(0.9, 6)
})
