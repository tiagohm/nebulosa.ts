import { describe, expect, test } from 'bun:test'
import { colorIndexToRgbWeights, plotStar } from '../../../src/imaging/stars/generator'
import { applySyntheticCollimationBlur, generateSyntheticCollimationImage, renderSyntheticCollimationPattern, type SyntheticCollimationPattern } from '../../../src/imaging/synthetic/collimation'

// Verifies deterministic annular fixtures independently from the INDI camera integration.

// Builds a centered high-SNR fixture with selected top-level overrides.
function fixture(overrides: Partial<SyntheticCollimationPattern> = {}): SyntheticCollimationPattern {
	return {
		width: 64,
		height: 64,
		outer: { center: { x: 32, y: 32 }, semiMajor: 20, semiMinor: 20, theta: 0, softness: 0.5 },
		obstruction: { center: { x: 32, y: 32 }, semiMajor: 8, semiMinor: 8, theta: 0, softness: 0.5 },
		signal: 100,
		background: 0,
		noise: 0,
		seed: 42,
		...overrides,
	}
}

// Sums a numeric image buffer without allocating an intermediate array.
function sum(raw: ArrayLike<number>): number {
	let value = 0
	for (let i = 0; i < raw.length; i++) value += raw[i]
	return value
}

// Sums a half-plane relative to a vertical split in image coordinates.
function halfPlaneSum(raw: ArrayLike<number>, width: number, height: number, right: boolean): number {
	let value = 0
	for (let y = 0; y < height; y++) {
		for (let x = right ? width / 2 : 0; x < (right ? width : width / 2); x++) value += raw[y * width + x]
	}
	return value
}

describe('synthetic collimation image', () => {
	test('renders two soft edges while preserving integrated signal', () => {
		const image = generateSyntheticCollimationImage(fixture())
		const center = image.raw[32 * 64 + 32]
		const ring = image.raw[32 * 64 + 46]

		expect(sum(image.raw)).toBeCloseTo(100, 4)
		expect(center).toBeLessThan(ring * 0.001)
		expect(ring).toBeGreaterThan(0)
		expect(image.raw.every(Number.isFinite)).toBeTrue()
	})

	test('moves the obstruction independently in all eight directions', () => {
		for (let i = 0; i < 8; i++) {
			const angle = (i * Math.PI) / 4
			const dx = Math.cos(angle) * 4
			const dy = Math.sin(angle) * 4
			const pattern = fixture({
				obstruction: { center: { x: 32 + dx, y: 32 + dy }, semiMajor: 8, semiMinor: 8, theta: 0, softness: 0.5 },
			})
			const image = generateSyntheticCollimationImage(pattern)
			let positive = 0
			let negative = 0
			for (let y = 0; y < 64; y++) {
				for (let x = 0; x < 64; x++) {
					const projection = (x - 32) * dx + (y - 32) * dy
					if (projection >= 0) positive += image.raw[y * 64 + x]
					else negative += image.raw[y * 64 + x]
				}
			}
			expect(positive).toBeLessThan(negative)
		}
	})

	test('supports rotated ellipses, RGB, and CFA metadata', () => {
		const ellipse = fixture({
			channels: 3,
			outer: { center: { x: 32, y: 32 }, semiMajor: 22, semiMinor: 16, theta: 0.4, softness: 0.7 },
			obstruction: { center: { x: 32, y: 32 }, semiMajor: 8, semiMinor: 6, theta: 0.4, softness: 0.7 },
		})
		const rgb = generateSyntheticCollimationImage(ellipse)
		expect(rgb.metadata.channels).toBe(3)
		expect(sum(rgb.raw)).toBeCloseTo(100, 3)

		const cfa = generateSyntheticCollimationImage(fixture({ bayer: 'RGGB', crop: { left: 1, top: 0, right: 63, bottom: 64 } }))
		expect(cfa.metadata.channels).toBe(1)
		expect(cfa.metadata.bayer).toBe('GRBG')
	})

	test('matches Gaussian RGB flux scaling and color weights', () => {
		const colorIndex = 1.2
		const channelWeights = colorIndexToRgbWeights(colorIndex)
		const annular = generateSyntheticCollimationImage(fixture({ channels: 3, signal: 200, channelWeights }))
		const gaussian = new Float64Array(64 * 64 * 3)
		plotStar(gaussian, 64, 64, 3, 32, 32, 100, 4, 100, 0, colorIndex, { gain: 2 })

		expect(sum(annular.raw)).toBeCloseTo(sum(gaussian), 3)
		for (let channel = 0; channel < 3; channel++) {
			let channelFlux = 0
			for (let pixel = channel; pixel < annular.raw.length; pixel += 3) channelFlux += annular.raw[pixel]
			expect(channelFlux / sum(annular.raw)).toBeCloseTo(channelWeights[channel], 4)
		}
	})

	test('applies deterministic optical and sensor effects in the documented order', () => {
		const pattern = fixture({
			noise: 0.01,
			seeing: 1.2,
			tracking: { length: 4, angle: 0.3 },
			harmonics: [{ order: 1, amplitude: 0.25, phase: -0.2 }],
			spider: { vanes: 4, angle: 0, width: 2, attenuation: 0.8 },
			thermalPlume: { angle: 1, width: 0.25, strength: 0.5 },
			saturation: 0.2,
			hotPixels: [{ x: 1, y: 2 }],
			crop: { left: 8, top: 10, right: 56, bottom: 58 },
		})
		const first = generateSyntheticCollimationImage(pattern)
		const second = generateSyntheticCollimationImage(pattern)
		expect(first.raw).toEqual(second.raw)
		expect(first.metadata.width).toBe(48)
		expect(first.metadata.height).toBe(48)
		expect(first.header.XORGSUBF).toBe(8)
		expect(first.header.YORGSUBF).toBe(10)
		expect(Math.max(...first.raw)).toBeLessThanOrEqual(0.2)
	})

	test('keeps a constant background flat across zero-padded optical blur', () => {
		const image = generateSyntheticCollimationImage(fixture({ signal: 0, background: 1, seeing: 2, tracking: { length: 4, angle: 0.4 } }))
		expect(image.raw.every((value) => value === 1)).toBeTrue()
	})

	test('does not replicate edge pixels during optical blur', () => {
		const raw = new Float64Array(9 * 9)
		raw[4 * 9] = 1
		applySyntheticCollimationBlur(raw, 9, 9, 1, 1.2, { length: 4, angle: 0 })
		expect(sum(raw)).toBeLessThanOrEqual(1)
		expect(sum(raw)).toBeGreaterThan(0)
	})

	test('applies anisotropic seeing in output-pixel sigma units', () => {
		const raw = new Float64Array(17 * 17)
		raw[8 * 17 + 8] = 1
		applySyntheticCollimationBlur(raw, 17, 17, 1, { sigmaX: 0.6, sigmaY: 1.2 })

		let varianceX = 0
		let varianceY = 0
		for (let y = 0; y < 17; y++) {
			for (let x = 0; x < 17; x++) {
				const value = raw[y * 17 + x]
				varianceX += (x - 8) * (x - 8) * value
				varianceY += (y - 8) * (y - 8) * value
			}
		}
		expect(varianceX).toBeCloseTo(0.6 * 0.6, 1)
		expect(varianceY).toBeCloseTo(1.2 * 1.2, 1)
	})

	test('treats an underflowing Gaussian sigma as a no-op', () => {
		const raw = new Float64Array([1])
		applySyntheticCollimationBlur(raw, 1, 1, 1, Number.MIN_VALUE)
		expect(raw[0]).toBe(1)
	})

	test('keeps a vertical-only blur symmetric without reusing output rows', () => {
		const raw = new Float64Array(9 * 9)
		raw[4 * 9 + 4] = 1
		applySyntheticCollimationBlur(raw, 9, 9, 1, { sigmaX: 0, sigmaY: 1 })

		for (let offset = 1; offset <= 4; offset++) expect(raw[(4 - offset) * 9 + 4]).toBeCloseTo(raw[(4 + offset) * 9 + 4], 7)
		expect(sum(raw)).toBeCloseTo(1, 6)
	})

	test('preserves Float64 precision in Gaussian and directional scratch buffers', () => {
		const delta = 2 ** -30
		for (const tracking of [undefined, { length: 2, angle: 0 }]) {
			const unit = new Float64Array(9 * 9)
			const precise = new Float64Array(9 * 9)
			unit[4 * 9 + 4] = 1
			precise[4 * 9 + 4] = 1 + delta
			applySyntheticCollimationBlur(unit, 9, 9, 1, tracking === undefined ? { sigmaX: 0, sigmaY: 1 } : 0, tracking)
			applySyntheticCollimationBlur(precise, 9, 9, 1, tracking === undefined ? { sigmaX: 0, sigmaY: 1 } : 0, tracking)
			expect(precise[4 * 9 + 4]).toBeGreaterThan(unit[4 * 9 + 4])
		}
	})

	test('adds normalized flux to a caller-owned buffer', () => {
		const pattern = fixture({ background: 0.3 })
		const raw = new Float64Array(64 * 64)
		raw.fill(pattern.background)
		expect(renderSyntheticCollimationPattern(raw, pattern)).toBeTrue()
		expect(sum(raw)).toBeCloseTo(64 * 64 * 0.3 + 100, 6)
	})

	test('clamps accumulated annular samples at the star saturation level', () => {
		const pattern = fixture({ signal: 1000 })
		const raw = new Float64Array(64 * 64)
		expect(renderSyntheticCollimationPattern(raw, pattern, 0.1)).toBeTrue()
		expect(Math.max(...raw)).toBe(0.1)
	})

	test('normalizes against complete support before clipping an edge pattern', () => {
		const image = generateSyntheticCollimationImage(
			fixture({
				outer: { center: { x: -15, y: 32 }, semiMajor: 20, semiMinor: 20, theta: 0, softness: 0.5 },
				obstruction: { center: { x: -15, y: 32 }, semiMajor: 8, semiMinor: 8, theta: 0, softness: 0.5 },
			}),
		)
		expect(sum(image.raw)).toBeGreaterThan(0)
		expect(sum(image.raw)).toBeLessThan(30)
	})

	test('rejects an obstruction that escapes the outer ellipse', () => {
		const pattern = fixture({ obstruction: { center: { x: 48, y: 32 }, semiMajor: 8, semiMinor: 8, theta: 0, softness: 0.5 } })
		expect(() => generateSyntheticCollimationImage(pattern)).toThrow('obstruction must be contained')
	})

	test('rejects a slender near-tangent obstruction escaping between sparse angles', () => {
		const pattern = fixture({
			outer: { center: { x: 32, y: 32 }, semiMajor: 20, semiMinor: 6, theta: -0.6075485148800015, softness: 0.5 },
			obstruction: { center: { x: 33.69883232191205, y: 31.802297553047538 }, semiMajor: 6.124932156410068, semiMinor: 0.454666255787015, theta: 0.3466286439143537, softness: 0.5 },
		})
		expect(() => generateSyntheticCollimationImage(pattern)).toThrow('obstruction must be contained')
	})

	test('makes the annulus thicker opposite the obstruction offset', () => {
		const image = generateSyntheticCollimationImage(fixture({ obstruction: { center: { x: 36, y: 32 }, semiMajor: 8, semiMinor: 8, theta: 0, softness: 0.5 } }))
		expect(halfPlaneSum(image.raw, 64, 64, true)).toBeLessThan(halfPlaneSum(image.raw, 64, 64, false))
	})
})
