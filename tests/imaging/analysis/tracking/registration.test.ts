import { describe, expect, test } from 'bun:test'
// oxfmt-ignore
import { type PhaseCorrelationOptions, PhaseCorrelationWorkspace, type RegistrationPlane, hannWindow, matchPatchZNCC, normalizeRegistrationSamples, phaseCorrelate, phaseCorrelationSpectrum, refineTranslationECC, removeLinearTrend } from '../../../../src/imaging/analysis/tracking/registration'
import { TAU } from '../../../../src/core/constants'
import { mulberry32 } from '../../../../src/math/numerical/random'
import { type Scene, textureScene } from '../../../util/scene'

const SIZE = 96

// Samples a scene shifted by [dx, dy] with optional gain, offset, gradient and Gaussian noise.
function plane(scene: Scene, dx: number, dy: number, options: { gain?: number; offset?: number; noise?: number; seed?: number; gradient?: number; size?: number; precision?: 32 | 64; mask?: (x: number, y: number) => boolean } = {}): RegistrationPlane {
	const size = options.size ?? SIZE
	const data = options.precision === 32 ? new Float32Array(size * size) : new Float64Array(size * size)
	const mask = options.mask === undefined ? undefined : new Uint8Array(size * size)
	const random = mulberry32(options.seed ?? 3)

	for (let y = 0, i = 0; y < size; y++) {
		for (let x = 0; x < size; x++, i++) {
			let value = scene(x - dx, y - dy) * (options.gain ?? 1) + (options.offset ?? 0) + (options.gradient ?? 0) * (x + 0.5 * y)
			if (options.noise !== undefined) value += options.noise * Math.sqrt(-2 * Math.log(Math.max(1e-12, random()))) * Math.cos(TAU * random())
			data[i] = value
			if (mask !== undefined && options.mask?.(x, y)) mask[i] = 1
		}
	}

	return { width: size, height: size, data, mask }
}

function correlate(reference: RegistrationPlane, current: RegistrationPlane, maximumShift = 24, options: PhaseCorrelationOptions = {}) {
	const workspace = new PhaseCorrelationWorkspace(reference.width, reference.height, maximumShift)
	const a = phaseCorrelationSpectrum(reference, workspace)
	const b = phaseCorrelationSpectrum(current, workspace)
	return phaseCorrelate(a, b, workspace, options)
}

const scene = textureScene(11, SIZE, SIZE)

describe('phase correlation', () => {
	test.each([
		[5, 0],
		[-7, 0],
		[0, 6],
		[0, -4],
		[9, -11],
	])('recovers integer shift %d, %d with the documented sign', (dx, dy) => {
		const result = correlate(plane(scene, 0, 0), plane(scene, dx, dy))
		expect(result.success).toBeTrue()
		if (!result.success) return
		// Window/content edge effects bias coarse phase correlation by at most about 0.1 pixel.
		expect(Math.abs(result.translation[0] - dx)).toBeLessThan(0.2)
		expect(Math.abs(result.translation[1] - dy)).toBeLessThan(0.2)
		expect(result.peakToSidelobeRatio).toBeGreaterThan(10)
	})

	test('recovers fractional shifts with localized-DFT refinement', () => {
		for (const [dx, dy] of [
			[0.25, 0],
			[2.35, -1.65],
			[-3.7, 4.15],
		]) {
			const result = correlate(plane(scene, 0, 0), plane(scene, dx, dy), 24, { normalization: 'none' })
			expect(result.success).toBeTrue()
			if (!result.success) continue
			expect(result.refined).toBeTrue()
			expect(Math.abs(result.translation[0] - dx)).toBeLessThan(0.2)
			expect(Math.abs(result.translation[1] - dy)).toBeLessThan(0.2)
			expect(result.peak).toBeGreaterThan(0.8)
			expect(result.error).toBeCloseTo(Math.sqrt(1 - result.peak ** 2), 12)
		}
	})

	test('is invariant to gain, offset and mild gradients after normalization', () => {
		const reference = plane(scene, 0, 0)

		for (const options of [{ gain: 3 }, { offset: 5 }, { gain: 0.4, offset: -2 }, { gradient: 0.01 }]) {
			const current = plane(scene, 3, -2, options)
			removeLinearTrend(current)
			const result = correlate(reference, current)
			expect(result.success).toBeTrue()
			if (!result.success) continue
			expect(result.translation[0]).toBeCloseTo(3, 0)
			expect(result.translation[1]).toBeCloseTo(-2, 0)
		}
	})

	test('bounded error under Gaussian noise and blur-like texture change', () => {
		const blurred = textureScene(11, SIZE, SIZE, 220, 2.2, 8)
		const result = correlate(plane(scene, 0, 0), plane(blurred, 4.4, 1.2, { noise: 0.15, seed: 9 }), 24, { normalization: 'none' })
		expect(result.success).toBeTrue()
		if (!result.success) return
		expect(Math.abs(result.translation[0] - 4.4)).toBeLessThan(0.35)
		expect(Math.abs(result.translation[1] - 1.2)).toBeLessThan(0.35)
	})

	test('accepts shift at the limit and rejects shifts beyond it without wrap sign errors', () => {
		const atLimit = correlate(plane(scene, 0, 0), plane(scene, -12, 12), 12)
		expect(atLimit.success).toBeTrue()
		if (atLimit.success) expect(Math.abs(atLimit.translation[0] + 12)).toBeLessThan(0.3)

		const over = correlate(plane(scene, 0, 0), plane(scene, 20, 0), 12)
		expect(over).toEqual({ success: false, reason: 'shiftOutOfRange' })
	})

	test('rejects a flat image and detects repeated texture ambiguity', () => {
		const flat = plane(() => 1, 0, 0)
		expect(correlate(flat, flat)).toEqual({ success: false, reason: 'lowContrast' })

		const stripes: Scene = (x, y) => Math.cos((TAU * x) / 8) + Math.cos((TAU * y) / 8)
		const result = correlate(plane(stripes, 0, 0), plane(stripes, 3, 1))
		expect(result.success).toBeFalse()
		if (!result.success) expect(['correlationAmbiguous', 'correlationLow']).toContain(result.reason)
	})

	test('Float32 and Float64 planes agree', () => {
		const a = correlate(plane(scene, 0, 0, { precision: 32 }), plane(scene, 1.5, -2.25, { precision: 32 }))
		const b = correlate(plane(scene, 0, 0), plane(scene, 1.5, -2.25))
		expect(a.success && b.success).toBeTrue()
		if (a.success && b.success) {
			expect(a.translation[0]).toBeCloseTo(b.translation[0], 6)
			expect(a.translation[1]).toBeCloseTo(b.translation[1], 6)
		}
	})

	test('masked invalid samples do not create a false measurement', () => {
		const current = plane(scene, 2, 3, { mask: (x, y) => x > 60 && y > 60 })
		const result = correlate(plane(scene, 0, 0), current)
		expect(result.success).toBeTrue()
		if (result.success) {
			expect(result.translation[0]).toBeCloseTo(2, 0)
			expect(result.translation[1]).toBeCloseTo(3, 0)
		}
	})
})

describe('ZNCC patch matching', () => {
	const scratch = new Float64Array(1024)

	test('recovers integer and fractional displacement with sign convention', () => {
		const reference = plane(scene, 0, 0)

		for (const [dx, dy] of [
			[2, -1],
			[0.3, 0.6],
			[-1.45, 2.2],
		]) {
			const result = matchPatchZNCC(reference, 32, 32, 32, 32, plane(scene, dx, dy), 0, 0, { searchRadius: 4 }, scratch)
			expect(result.success).toBeTrue()
			if (!result.success) continue
			expect(Math.abs(result.translation[0] - dx)).toBeLessThan(0.15)
			expect(Math.abs(result.translation[1] - dy)).toBeLessThan(0.15)
			expect(result.correlation).toBeGreaterThan(0.9)
			expect(result.overlapFraction).toBe(1)
			expect(result.uncertainty).toBeGreaterThan(0)
		}
	})

	test('uses the predicted displacement as search center', () => {
		const result = matchPatchZNCC(plane(scene, 0, 0), 32, 32, 24, 24, plane(scene, 15.4, -9.2), 15, -9, { searchRadius: 3 }, scratch)
		expect(result.success).toBeTrue()
		if (result.success) {
			expect(result.translation[0]).toBeCloseTo(15.4, 0)
			expect(result.translation[1]).toBeCloseTo(-9.2, 0)
		}
	})

	test('is gain/offset invariant and rejects flat, masked, out-of-range and ambiguous patches', () => {
		const reference = plane(scene, 0, 0)
		const scaled = matchPatchZNCC(reference, 30, 30, 32, 32, plane(scene, 1, 1, { gain: 4, offset: 7 }), 0, 0, { searchRadius: 3 }, scratch)
		expect(scaled.success).toBeTrue()

		const flat = plane(() => 2, 0, 0)
		expect(matchPatchZNCC(flat, 30, 30, 32, 32, flat, 0, 0, { searchRadius: 3 }, scratch)).toEqual({ success: false, reason: 'lowContrast' })

		const masked = plane(scene, 0, 0, { mask: () => true })
		expect(matchPatchZNCC(masked, 30, 30, 32, 32, reference, 0, 0, { searchRadius: 3 }, scratch)).toEqual({ success: false, reason: 'masked' })

		expect(matchPatchZNCC(reference, 30, 30, 32, 32, plane(scene, 9, 0), 0, 0, { searchRadius: 3 }, scratch)).toEqual({ success: false, reason: 'shiftOutOfRange' })

		const stripes: Scene = (x) => Math.cos((TAU * x) / 5)
		const periodic = matchPatchZNCC(plane(stripes, 0, 0), 30, 30, 32, 32, plane(stripes, 1, 0), 0, 0, { searchRadius: 6 }, scratch)
		expect(periodic.success).toBeFalse()
	})

	test('partial overlap near the current border is still measured or explicitly rejected', () => {
		const result = matchPatchZNCC(plane(scene, 0, 0), 1, 1, 32, 32, plane(scene, -2.4, -2.2), -2, -2, { searchRadius: 3, minimumOverlap: 0.8 }, scratch)
		expect(result.success).toBeTrue()
		if (result.success) expect(result.overlapFraction).toBeLessThan(1)

		const rejected = matchPatchZNCC(plane(scene, 0, 0), 0, 0, 32, 32, plane(scene, -3, -3), -3, -3, { searchRadius: 2, minimumOverlap: 0.95 }, scratch)
		expect(rejected).toEqual({ success: false, reason: 'insufficientOverlap' })
	})

	test('ignores masked current samples', () => {
		const current = plane(scene, 1.5, 0.5, { mask: (x, y) => x >= 40 && x < 48 && y >= 40 && y < 48 })
		const result = matchPatchZNCC(plane(scene, 0, 0), 32, 32, 32, 32, current, 0, 0, { searchRadius: 3 }, scratch)
		expect(result.success).toBeTrue()
		if (result.success) expect(Math.abs(result.translation[0] - 1.5)).toBeLessThan(0.2)
	})
})

describe('ECC refinement', () => {
	test('improves a ZNCC initialization toward the true translation', () => {
		const scratch = new Float64Array(4 * 32 * 32)
		const result = refineTranslationECC(plane(scene, 0, 0), 32, 32, 32, 32, plane(scene, 1.37, -0.62), 1, -1, {}, scratch)
		expect(result.success).toBeTrue()
		if (!result.success) return
		expect(result.translation[0]).toBeCloseTo(1.37, 1)
		expect(result.translation[1]).toBeCloseTo(-0.62, 1)
		expect(result.correlation).toBeGreaterThan(0.98)
	})

	test('fails on uncorrelated data so callers keep ZNCC', () => {
		const scratch = new Float64Array(4 * 32 * 32)
		const other = textureScene(99, SIZE, SIZE)
		const result = refineTranslationECC(plane(scene, 0, 0), 32, 32, 32, 32, plane(other, 0, 0), 0, 0, { maximumCorrection: 0.5 }, scratch)
		expect(result.success).toBeFalse()
	})
})

test('normalization uses median and MAD and zeroes masked samples', () => {
	const data = new Float64Array([1, 2, 3, 4, 100, Number.NaN])
	const mask = new Uint8Array([0, 0, 0, 0, 0, 0])
	const out = new Float64Array(6)
	const result = normalizeRegistrationSamples(data, mask, 6, out, new Float64Array(8))
	expect(result.location).toBe(3)
	expect(result.validCount).toBe(5)
	expect(result.scale).toBeCloseTo(1.482602218505602, 12)
	expect(out[2]).toBe(0)
	expect(out[5]).toBe(0)
})

test('hann window is symmetric and positive', () => {
	const window = hannWindow(8)
	expect(window[0]).toBeGreaterThan(0)
	for (let i = 0; i < 8; i++) expect(window[i]).toBeCloseTo(window[7 - i], 14)
})
