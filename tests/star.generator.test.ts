import { describe, expect, test } from 'bun:test'
import { brightness, gamma } from '../src/image.transformation'
import type { Image, ImageMetadata } from '../src/image.types'
import { colorIndexToRgbWeights, effectiveGaussianSigma, focusDefocusAmount, type PlotStarOptions, plotStar } from '../src/star.generator'
import { saveImageAndCompareHash } from './image.util'

const WIDTH = 48
const HEIGHT = 48

interface PlotStarScenario extends PlotStarOptions {
	readonly name: string
	readonly slug: string
	readonly channels: 1 | 3
	readonly flux: number
	readonly hfd: number
	readonly snr: number
	readonly seeing: number
	readonly x?: number
	readonly y?: number
	readonly hash?: string
}

// Computes the scalar sum of a monochrome buffer.
function monoSum(buffer: Float64Array) {
	let sum = 0
	for (let i = 0; i < buffer.length; i++) sum += buffer[i]
	return sum
}

// Computes per-channel sums for an interleaved RGB buffer.
function rgbSum(buffer: Float64Array) {
	let red = 0
	let green = 0
	let blue = 0

	for (let i = 0; i < buffer.length; i += 3) {
		red += buffer[i]
		green += buffer[i + 1]
		blue += buffer[i + 2]
	}

	return [red, green, blue] as const
}

// Computes an intensity-weighted centroid for a monochrome image.
function monoCentroid(buffer: Float64Array, width: number, height: number): readonly [number, number] {
	let sum = 0
	let cx = 0
	let cy = 0

	for (let y = 0; y < height; y++) {
		const row = y * width

		for (let x = 0; x < width; x++) {
			const value = buffer[row + x]
			sum += value
			cx += value * x
			cy += value * y
		}
	}

	return sum > 0 ? [cx / sum, cy / sum] : [0, 0]
}

// Computes the second moments around a supplied center.
function monoSecondMoments(buffer: Float64Array, width: number, height: number, centerX: number, centerY: number): readonly [number, number] {
	let sum = 0
	let xx = 0
	let yy = 0

	for (let y = 0; y < height; y++) {
		const row = y * width
		const dy = y - centerY

		for (let x = 0; x < width; x++) {
			const dx = x - centerX
			const value = buffer[row + x]
			sum += value
			xx += value * dx * dx
			yy += value * dy * dy
		}
	}

	return sum > 0 ? [xx / sum, yy / sum] : [0, 0]
}

// Measures how much flux lands in the outer halo of a monochrome image.
function ringEnergy(buffer: Float64Array, width: number, height: number, centerX: number, centerY: number, innerRadius: number) {
	let sum = 0
	const threshold = innerRadius * innerRadius

	for (let y = 0; y < height; y++) {
		const row = y * width
		const dy = y - centerY

		for (let x = 0; x < width; x++) {
			const dx = x - centerX
			if (dx * dx + dy * dy >= threshold) sum += buffer[row + x]
		}
	}

	return sum
}

test('plots a centered mono star with stable flux and sigma mapping', () => {
	const buffer = new Float64Array(WIDTH * HEIGHT)
	const flux = 0.3
	const sigma = effectiveGaussianSigma(3.2, 1.1, 20)

	expect(sigma).toBeGreaterThan(0.5)
	expect(plotStar(buffer, WIDTH, HEIGHT, 1, 24, 24, flux, 3.2, 20, 1.1)).toBe(true)
	expect(monoSum(buffer)).toBeCloseTo(flux, 2)
	expect(buffer[24 * WIDTH + 24]).toBeGreaterThan(buffer[24 * WIDTH + 22])
})

test('preserves flux for undersampled gaussian stars', () => {
	const size = 128
	const scenarios = [1, 0.35] as const
	const buffer = new Float64Array(size * size)

	for (const hfd of scenarios) {
		buffer.fill(0)
		expect(plotStar(buffer, size, size, 1, size / 2, size / 2, 1, hfd, 40, 0, { maxPlotRadius: 32 })).toBe(true)
		expect(monoSum(buffer)).toBeCloseTo(1, 6)
	}
})

test('plots centered RGB stars with normalized color energy', () => {
	const redBuffer = new Float64Array(WIDTH * HEIGHT * 3)
	const blueBuffer = new Float64Array(WIDTH * HEIGHT * 3)

	expect(plotStar(redBuffer, WIDTH, HEIGHT, 3, 24, 24, 0.42, 3.6, 30, 0.8, { colorIndex: 1.7 })).toBe(true)
	expect(plotStar(blueBuffer, WIDTH, HEIGHT, 3, 24, 24, 0.42, 3.6, 30, 0.8, { colorIndex: -0.25 })).toBe(true)

	const [redR, redG, redB] = rgbSum(redBuffer)
	const [blueR, blueG, blueB] = rgbSum(blueBuffer)
	expect(redR + redG + redB).toBeCloseTo(0.42, 2)
	expect(blueR + blueG + blueB).toBeCloseTo(0.42, 2)
	expect(redR).toBeGreaterThan(redB)
	expect(blueB).toBeGreaterThan(blueR)

	const warmWeights = colorIndexToRgbWeights(1.7)
	const coolWeights = colorIndexToRgbWeights(-0.25)
	expect(warmWeights[0]).toBeGreaterThan(warmWeights[2])
	expect(coolWeights[2]).toBeGreaterThan(coolWeights[0])
})

test('responds smoothly to subpixel shifts', () => {
	const a = new Float64Array(WIDTH * HEIGHT)
	const b = new Float64Array(WIDTH * HEIGHT)

	expect(plotStar(a, WIDTH, HEIGHT, 1, 20, 20, 0.24, 2.9, 24, 0.4)).toBe(true)
	expect(plotStar(b, WIDTH, HEIGHT, 1, 20.35, 20.2, 0.24, 2.9, 24, 0.4)).toBe(true)

	const [ax, ay] = monoCentroid(a, WIDTH, HEIGHT)
	const [bx, by] = monoCentroid(b, WIDTH, HEIGHT)
	expect(bx).toBeGreaterThan(ax + 0.15)
	expect(by).toBeGreaterThan(ay + 0.05)
	expect(Math.abs(monoSum(a) - monoSum(b))).toBeLessThan(0.01)
})

test('clips safely near each border and preserves sentinel values', () => {
	const guard = new Float64Array(WIDTH * HEIGHT + 4)

	const layouts = [
		{ x: -1.2, y: 24 },
		{ x: WIDTH - 0.2, y: 24 },
		{ x: 24, y: -0.8 },
		{ x: 24, y: HEIGHT - 0.15 },
		{ x: -0.5, y: -0.5 },
	] as const

	for (const layout of layouts) {
		guard.fill(0)
		guard[0] = 123
		guard[1] = 456
		guard[guard.length - 2] = 789
		guard[guard.length - 1] = 101112
		const buffer = guard.subarray(2, guard.length - 2)

		expect(plotStar(buffer, WIDTH, HEIGHT, 1, layout.x, layout.y, 0.35, 3.5, 18, 1.4)).toBe(true)
		expect(guard[0]).toBe(123)
		expect(guard[1]).toBe(456)
		expect(guard[guard.length - 2]).toBe(789)
		expect(guard[guard.length - 1]).toBe(101112)
		expect(monoSum(buffer)).toBeGreaterThan(0)
	}
})

test('handles faint, saturated, and diffuse stars plausibly', () => {
	const faint = new Float64Array(WIDTH * HEIGHT)
	const saturated = new Float64Array(WIDTH * HEIGHT)
	const diffuse = new Float64Array(WIDTH * HEIGHT)

	expect(plotStar(faint, WIDTH, HEIGHT, 1, 24, 24, 1e-5, 2.4, 5, 0)).toBe(true)
	expect(monoSum(faint)).toBeGreaterThan(0)

	expect(plotStar(saturated, WIDTH, HEIGHT, 1, 24, 24, 8, 1.2, 60, 0, { saturationLevel: 1 })).toBe(true)
	expect(Math.max(...saturated)).toBe(1)

	expect(plotStar(diffuse, WIDTH, HEIGHT, 1, 24, 24, 0.5, 10, 12, 5, { maxPlotRadius: 24 })).toBe(true)
	expect(monoSum(diffuse)).toBeGreaterThan(0.4)
	expect(diffuse[24 * WIDTH + 24]).toBeLessThan(saturated[24 * WIDTH + 24])
})

test('supports ellipticity and halo shaping', () => {
	const circular = new Float64Array(WIDTH * HEIGHT)
	const elliptical = new Float64Array(WIDTH * HEIGHT)
	const noHalo = new Float64Array(WIDTH * HEIGHT)
	const withHalo = new Float64Array(WIDTH * HEIGHT)

	expect(plotStar(circular, WIDTH, HEIGHT, 1, 24, 24, 0.3, 3.2, 22, 0.6)).toBe(true)
	expect(plotStar(elliptical, WIDTH, HEIGHT, 1, 24, 24, 0.3, 3.2, 22, 0.6, { ellipticity: 0.45, theta: 0 })).toBe(true)
	expect(plotStar(noHalo, WIDTH, HEIGHT, 1, 24, 24, 0.3, 3.2, 22, 0.6)).toBe(true)
	expect(plotStar(withHalo, WIDTH, HEIGHT, 1, 24, 24, 0.3, 3.2, 22, 0.6, { haloStrength: 0.22, haloScale: 3.4 })).toBe(true)

	const [circularX, circularY] = monoSecondMoments(circular, WIDTH, HEIGHT, 24, 24)
	const [ellipticalX, ellipticalY] = monoSecondMoments(elliptical, WIDTH, HEIGHT, 24, 24)
	expect(Math.abs(circularX - circularY)).toBeLessThan(0.15)
	expect(ellipticalX).toBeGreaterThan(ellipticalY * 1.2)
	expect(ringEnergy(withHalo, WIDTH, HEIGHT, 24, 24, 5)).toBeGreaterThan(ringEnergy(noHalo, WIDTH, HEIGHT, 24, 24, 5))
})

test('supports the optional moffat profile with broader wings', () => {
	const gaussian = new Float64Array(WIDTH * HEIGHT)
	const moffat = new Float64Array(WIDTH * HEIGHT)

	expect(plotStar(gaussian, WIDTH, HEIGHT, 1, 24, 24, 0.28, 3.4, 25, 0.5)).toBe(true)
	expect(plotStar(moffat, WIDTH, HEIGHT, 1, 24, 24, 0.28, 3.4, 25, 0.5, { psfModel: 'moffat', beta: 2.2 })).toBe(true)
	expect(ringEnergy(moffat, WIDTH, HEIGHT, 24, 24, 5)).toBeGreaterThan(ringEnergy(gaussian, WIDTH, HEIGHT, 24, 24, 5))
	expect(monoSum(moffat)).toBeCloseTo(0.28, 1)
})

test('broadens stars away from best focus', () => {
	const size = 96
	const focused = new Float64Array(size * size)
	const defocused = new Float64Array(size * size)
	const center = 48 * size + 48

	expect(focusDefocusAmount(50000, 50000)).toBe(0)
	expect(focusDefocusAmount(100000, 50000)).toBe(1)
	expect(plotStar(focused, size, size, 1, 48, 48, 0.3, 2.8, 24, 0.4, { focusStep: 50000, bestFocus: 50000, maxPlotRadius: 40 })).toBe(true)
	expect(plotStar(defocused, size, size, 1, 48, 48, 0.3, 2.8, 24, 0.4, { focusStep: 100000, bestFocus: 50000, maxPlotRadius: 40 })).toBe(true)

	const [focusedX, focusedY] = monoSecondMoments(focused, size, size, 48, 48)
	const [defocusedX, defocusedY] = monoSecondMoments(defocused, size, size, 48, 48)
	expect(defocused[center]).toBeLessThan(focused[center] * 0.3)
	expect(defocusedX + defocusedY).toBeGreaterThan((focusedX + focusedY) * 4)
	expect(ringEnergy(defocused, size, size, 48, 48, 6)).toBeGreaterThan(ringEnergy(focused, size, size, 48, 48, 6))
	expect(monoSum(defocused)).toBeCloseTo(monoSum(focused), 1)
})

test('plots many stars without producing NaN or Infinity', () => {
	const buffer = new Float64Array(256 * 256)

	for (let i = 0; i < 600; i++) {
		const x = 8 + ((i * 37.17) % 240)
		const y = 8 + ((i * 19.31) % 240)
		const flux = 0.002 + (i % 7) * 0.0008
		const hfd = 1.8 + (i % 5) * 0.35
		const snr = 6 + (i % 25)
		const seeing = (i % 4) * 0.25
		plotStar(buffer, 256, 256, 1, x, y, flux, hfd, snr, seeing, { haloStrength: i % 9 === 0 ? 0.18 : 0, ellipticity: i % 11 === 0 ? 0.2 : 0, theta: i * 0.1 })
	}

	for (let i = 0; i < buffer.length; i++) expect(Number.isFinite(buffer[i])).toBe(true)
	expect(monoSum(buffer)).toBeGreaterThan(1)
})

test('rejects invalid buffer layouts and ignores non-finite stars', () => {
	const buffer = new Float64Array(WIDTH * HEIGHT)

	expect(() => plotStar(new Float64Array(WIDTH * HEIGHT - 1), WIDTH, HEIGHT, 1, 24, 24, 0.1, 2, 10, 0)).toThrow(RangeError)
	expect(() => plotStar(new Float64Array(WIDTH * HEIGHT), WIDTH, HEIGHT, 3, 24, 24, 0.1, 2, 10, 0)).toThrow(RangeError)
	expect(plotStar(buffer, WIDTH, HEIGHT, 1, Number.NaN, 24, 0.2, 3, 10, 0)).toBe(false)
	expect(plotStar(buffer, WIDTH, HEIGHT, 1, 24, 24, -1, 3, 10, 0)).toBe(false)
	expect(monoSum(buffer)).toBe(0)
})

describe('plot star', () => {
	const raw = new Float64Array(WIDTH * HEIGHT * 3) // For both mono and RGB

	// Builds image metadata that matches each scenario layout.
	function metadata(channels: 1 | 3): ImageMetadata {
		return { width: WIDTH, height: HEIGHT, channels, pixelCount: WIDTH * HEIGHT, pixelSizeInBytes: 8, bitpix: -64, stride: WIDTH * channels, strideInBytes: WIDTH * channels * 8, bayer: undefined }
	}

	// NOTE: use hash = undefined for new scenarios
	const scenarios: readonly PlotStarScenario[] = [
		{ name: 'mono nominal gaussian', slug: 'mono-nominal-gaussian', channels: 1, flux: 0.34, hfd: 3.2, snr: 24, seeing: 0.6, hash: '93b863745447162d4dd3848e05c078d8' },
		{ name: 'mono subpixel gaussian', slug: 'mono-subpixel-gaussian', channels: 1, x: WIDTH / 2 + 0.33, y: HEIGHT / 2 - 0.27, flux: 0.28, hfd: 2.7, snr: 22, seeing: 0.4, hash: '6e651ee6a7ee6726297b52223d0cda35' },
		{ name: 'mono faint low snr', slug: 'mono-faint-low-snr', channels: 1, flux: 0.015, hfd: 2.8, snr: 4, seeing: 0.3, hash: '61faa0f25bd5dff6e4903582a97a6044' },
		{ name: 'mono bright saturated core', slug: 'mono-bright-saturated-core', channels: 1, flux: 5.5, hfd: 1.15, snr: 64, seeing: 0, saturationLevel: 1, peakScale: 1.5, hash: '4ff8371f564b9ab6a25184fd17b86f8d' },
		{ name: 'mono diffuse seeing dominated', slug: 'mono-diffuse-seeing-dominated', channels: 1, flux: 0.42, hfd: 8.4, snr: 10, seeing: 4.8, softCore: 1.4, maxPlotRadius: 24, hash: '5f9c4bb225b6b94383efff2fae977bcb' },
		{ name: 'mono elliptical horizontal', slug: 'mono-elliptical-horizontal', channels: 1, flux: 0.3, hfd: 3.1, snr: 20, seeing: 0.5, ellipticity: 0.45, theta: 0, hash: 'e84227d2250195e4099623356c50d1bc' },
		{ name: 'mono elliptical rotated halo', slug: 'mono-elliptical-rotated-halo', channels: 1, flux: 0.32, hfd: 3.4, snr: 18, seeing: 0.8, ellipticity: 0.38, theta: Math.PI / 4, haloStrength: 0.22, haloScale: 3.5, hash: '02f7f008dbb74c5baf1484843a186215' },
		{ name: 'mono left edge clip', slug: 'mono-left-edge-clip', channels: 1, x: 1.35, y: HEIGHT / 2, flux: 0.3, hfd: 3.2, snr: 16, seeing: 0.9, hash: 'd3fefbf67943e75e3f5c54b70573c24e' },
		{ name: 'mono corner clip', slug: 'mono-corner-clip', channels: 1, x: 1.25, y: 1.75, flux: 0.26, hfd: 2.7, snr: 14, seeing: 0.7, hash: 'fb024542be6bc7b31f3569fd106a615a' },
		{ name: 'mono moffat compact', slug: 'mono-moffat-compact', channels: 1, flux: 0.29, hfd: 3.0, snr: 30, seeing: 0.4, psfModel: 'moffat', beta: 2.2, hash: '83b5f299f3ae240e78279efb713bfaa3' },
		{ name: 'mono moffat with halo', slug: 'mono-moffat-with-halo', channels: 1, flux: 0.33, hfd: 3.4, snr: 24, seeing: 0.5, psfModel: 'moffat', beta: 2.8, haloStrength: 0.16, haloScale: 3.2, hash: '73f46bee2e212e1592c3166e9ab1dca3' },
		{ name: 'mono jittered soft core', slug: 'mono-jittered-soft-core', channels: 1, flux: 0.31, hfd: 2.4, snr: 12, seeing: 0.2, jitterX: 0.18, jitterY: -0.22, softCore: 1.8, additiveNoiseHint: 1.5, hash: '0a6af80bdc872a86ca81ead515e38092' },
		{ name: 'mono defocused', slug: 'mono-defocused', channels: 1, flux: 0.34, hfd: 2.8, snr: 22, seeing: 0.5, focusStep: 90000, bestFocus: 48000, hash: '91a71a55376e971b01ecf267df8e12e9' },
		{ name: 'rgb neutral gaussian', slug: 'rgb-neutral-gaussian', channels: 3, flux: 0.36, hfd: 3.3, snr: 26, seeing: 0.6, colorIndex: 0.45, hash: 'ecd5a1d1c1289eb334f93e2aac8eeac9' },
		{ name: 'rgb blue hot star', slug: 'rgb-blue-hot-star', channels: 3, flux: 0.36, hfd: 2.7, snr: 30, seeing: 0.4, colorIndex: -0.3, peakScale: 1.2, hash: '84fe142d37e945145f667b5b1113c8e3' },
		{ name: 'rgb red cool star', slug: 'rgb-red-cool-star', channels: 3, flux: 0.36, hfd: 3.7, snr: 28, seeing: 0.7, colorIndex: 1.85, hash: 'ac3936cbcd6c4633cdff17bc7a97b3a5' },
		{ name: 'rgb diffuse low snr', slug: 'rgb-diffuse-low-snr', channels: 3, flux: 0.24, hfd: 6.8, snr: 4, seeing: 3.4, colorIndex: 0.9, softCore: 1.2, maxPlotRadius: 24, hash: '60ffbb2121035a2399663b6bfeb220fc' },
		{ name: 'rgb elliptical rotated', slug: 'rgb-elliptical-rotated', channels: 3, flux: 0.32, hfd: 3.0, snr: 18, seeing: 0.6, colorIndex: 0.05, ellipticity: 0.34, theta: Math.PI / 6, hash: '0de84b935c5c8b25b6afdbf9ebd5ec54' },
		{ name: 'rgb halo and gamma', slug: 'rgb-halo-and-gamma', channels: 3, flux: 0.34, hfd: 3.5, snr: 20, seeing: 0.7, colorIndex: 1.15, haloStrength: 0.24, haloScale: 3.6, gammaCompensation: 2.2, hash: '8195341783cf3e9597c17ed33949d4cc' },
		{ name: 'rgb moffat halo', slug: 'rgb-moffat-halo', channels: 3, flux: 0.31, hfd: 2.9, snr: 32, seeing: 0.4, colorIndex: -0.15, psfModel: 'moffat', beta: 2.5, haloStrength: 0.12, haloScale: 3.1, hash: '69bd723fd403c7861913b29a9fc3d920' },
		{ name: 'rgb defocused', slug: 'rgb-defocused', channels: 3, flux: 0.34, hfd: 2.8, snr: 22, seeing: 0.5, colorIndex: 0.8, focusStep: 12000, bestFocus: 64000, hash: '933cc32600298b1d103b97d667c8cb2c' },
		{ name: 'rgb corner clip', slug: 'rgb-corner-clip', channels: 3, x: 1.4, y: 2.1, flux: 0.28, hfd: 3.0, snr: 15, seeing: 0.8, colorIndex: 0.7, hash: '4609762a435f795f4f4130929f303f50' },
	]

	for (const scenario of scenarios) {
		const { name, slug, channels, flux, hfd, snr, seeing, x = WIDTH / 2, y = HEIGHT / 2, hash, ...options } = scenario

		test(name, async () => {
			raw.fill(0)
			expect(plotStar(raw, WIDTH, HEIGHT, channels, x, y, flux, hfd, snr, seeing, options)).toBeTrue()
			const image: Image = { raw, header: {}, metadata: metadata(channels) }
			await saveImageAndCompareHash(brightness(gamma(image, 3), 4), `plot-star-${slug}`, hash)
		})
	}
})
