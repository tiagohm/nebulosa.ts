import { expect, test } from 'bun:test'
import { cosmeticCorrection } from '../../../src/imaging/processing/cosmetic'
import { generateNoiseImage } from '../../../src/imaging/synthetic/generator'
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
