import { expect, test } from 'bun:test'
import { PI } from '../../../../src/core/constants'
import { createBahtinovWorkspace, preprocessBahtinov as preprocessBahtinovWithWorkspace, resolveBahtinovArea } from '../../../../src/imaging/analysis/bahtinov/preprocess'
import type { BahtinovAnalysisInput, BahtinovAnalysisOptions, BahtinovWorkspace } from '../../../../src/imaging/analysis/bahtinov/types'
import type { Image } from '../../../../src/imaging/model/types'
import { plotBahtinovSpikes } from '../../../../src/imaging/stars/bahtinov'

function image(raw: Float32Array | Float64Array, width: number, height: number, channels: 1 | 3 = 1, bayer?: Image['metadata']['bayer']): Image {
	const bytes = raw.BYTES_PER_ELEMENT
	return {
		raw,
		header: {},
		metadata: {
			width,
			height,
			channels,
			stride: width * channels,
			pixelCount: width * height,
			strideInBytes: width * channels * bytes,
			pixelSizeInBytes: bytes,
			bitpix: bytes === 8 ? -64 : -32,
			bayer,
		},
	}
}

function preprocessBahtinov(input: BahtinovAnalysisInput, options: BahtinovAnalysisOptions = {}, suppliedWorkspace?: BahtinovWorkspace) {
	const area = resolveBahtinovArea(input)
	const width = area.right - area.left
	const height = area.bottom - area.top
	const workspace =
		suppliedWorkspace ??
		createBahtinovWorkspace(width, height, {
			precision: input.image.raw.BYTES_PER_ELEMENT === 8 ? 64 : 32,
			maximumRidgePoints: Math.min(options.maximumRidgePoints ?? 4096, width * height),
			angleStep: options.angleStep,
			distanceStep: options.distanceStep,
		})
	return preprocessBahtinovWithWorkspace(input, workspace, options)
}

test('creates a capacity-described reusable workspace', () => {
	const workspace = createBahtinovWorkspace(64, 48, { precision: 64, maximumRidgePoints: 512, angleStep: PI / 90, distanceStep: 1 })
	expect(workspace.source).toBeInstanceOf(Float64Array)
	expect(workspace.source.length).toBe(64 * 48)
	expect(workspace.response).toBe(workspace.source)
	expect(workspace.cfaX.length).toBe(64 * 4)
	expect(workspace.cfaY.length).toBe(48 * 4)
	expect(workspace.maximumRidgePoints).toBe(512)
	expect(workspace.angleCount).toBe(90)
	expect(workspace.distanceBinCount).toBe(Math.ceil(2 * Math.hypot(63, 47)) + 1)
	expect(workspace.accumulator.length).toBe(workspace.distanceBinCount)
})

test('resolves a shifted square ROI without losing the requested size', () => {
	const source = image(new Float32Array(100 * 80), 100, 80)
	expect(resolveBahtinovArea({ image: source, center: { x: 2, y: 77 }, size: 32 })).toEqual({ left: 0, top: 48, right: 32, bottom: 80 })
	expect(resolveBahtinovArea({ image: source, area: { left: 10, top: 12, right: 50, bottom: 52 }, center: { x: 20, y: 30 } })).toEqual({ left: 10, top: 12, right: 50, bottom: 52 })
	expect(() => resolveBahtinovArea({ image: source, area: { left: 10, top: 12, right: 50, bottom: 52 } } as BahtinovAnalysisInput)).toThrow(RangeError)
})

test('preprocesses deterministic mono spikes with a signed DoG response', () => {
	const width = 96
	const height = 96
	const raw = new Float64Array(width * height)
	raw.fill(0.02)
	plotBahtinovSpikes(raw, width, height, 1, 48, 48, 80, 2, undefined, { halfLength: 32, taperLength: 5, fwhm: 2 })
	const result = preprocessBahtinov({ image: image(raw, width, height), area: { left: 0, top: 0, right: width, bottom: height }, center: { x: 48, y: 48 } }, { transform: 'linear', coreRadius: 3, ridgeSigma: 2, smallBlurSigma: 1, largeBlurSigma: 3, maximumRidgePoints: 1024 })
	expect(result.success).toBeTrue()
	if (!result.success) return
	expect(result.background.level).toBeCloseTo(0.02, 12)
	expect(result.ridgePoints.count).toBeGreaterThan(30)
	expect(result.responseDeviation).toBeGreaterThanOrEqual(0)
	const response = result.workspace.response.subarray(0, width * height)
	expect(response.some((sample) => sample > 0)).toBeTrue()
	expect(response.some((sample) => sample < 0)).toBeTrue()
	expect(response.every(Number.isFinite)).toBeTrue()
})

test('extracts RGB with explicit and BT.709 planes', () => {
	const width = 64
	const height = 64
	const raw = new Float32Array(width * height * 3)
	for (let index = 0; index < raw.length; index += 3) {
		raw[index] = 0.01
		raw[index + 1] = 0.02
		raw[index + 2] = 0.03
	}
	plotBahtinovSpikes(raw, width, height, 3, 32, 32, 60, 0, undefined, { halfLength: 22, taperLength: 4 })
	const source = image(raw, width, height, 3)
	const red = preprocessBahtinov({ image: source, area: { left: 0, top: 0, right: width, bottom: height }, center: { x: 32, y: 32 } }, { plane: 'RED', coreRadius: 2, ridgeSigma: 2 })
	const luminance = preprocessBahtinov({ image: source, area: { left: 0, top: 0, right: width, bottom: height }, center: { x: 32, y: 32 } }, { plane: 'auto', coreRadius: 2, ridgeSigma: 2 })
	const gray = preprocessBahtinov({ image: source, area: { left: 0, top: 0, right: width, bottom: height }, center: { x: 32, y: 32 } }, { plane: 'GRAY', coreRadius: 2, ridgeSigma: 2 })
	expect(red.success).toBeTrue()
	expect(luminance.success).toBeTrue()
	expect(gray.success).toBeTrue()
	if (red.success && luminance.success) expect(red.background.level).not.toBe(luminance.background.level)
	if (gray.success && luminance.success) {
		expect(gray.background).toEqual(luminance.background)
		expect(gray.responseCenter).toBe(luminance.responseCenter)
		expect(gray.responseDeviation).toBe(luminance.responseDeviation)
		expect(gray.threshold).toBe(luminance.threshold)
		expect(gray.ridgePoints.count).toBe(luminance.ridgePoints.count)
	}
})

test('ignores non-finite RGB channels outside the selected plane', () => {
	const width = 64
	const height = 64
	const raw = new Float32Array(width * height * 3)
	for (let index = 0; index < raw.length; index += 3) {
		raw[index] = 0.01
		raw[index + 1] = Number.NaN
		raw[index + 2] = Number.NaN
	}
	plotBahtinovSpikes(raw, width, height, 3, 32, 32, 60, 0, undefined, { halfLength: 22, taperLength: 4 })
	const result = preprocessBahtinov({ image: image(raw, width, height, 3), area: { left: 0, top: 0, right: width, bottom: height }, center: { x: 32, y: 32 } }, { plane: 'RED', coreRadius: 2, ridgeSigma: 2 })
	expect(result.success).toBeTrue()
	if (result.success) expect(result.ridgePoints.count).toBeGreaterThan(3)
})

test('reconstructs all eight CFA patterns from both physical green lattices', () => {
	const patterns: readonly NonNullable<Image['metadata']['bayer']>[] = ['RGGB', 'BGGR', 'GBRG', 'GRBG', 'GRGB', 'GBGR', 'RGBG', 'BGRG']
	const width = 32
	const height = 32
	for (const pattern of patterns) {
		const raw = new Float32Array(width * height)
		const greenOffsets =
			pattern === 'RGGB' || pattern === 'BGGR'
				? ([
						[1, 0],
						[0, 1],
					] as const)
				: pattern === 'GBRG' || pattern === 'GRBG'
					? ([
							[0, 0],
							[1, 1],
						] as const)
					: pattern === 'GRGB' || pattern === 'GBGR'
						? ([
								[0, 0],
								[0, 1],
							] as const)
						: ([
								[1, 0],
								[1, 1],
							] as const)
		for (let y = 0; y < height; y++) {
			for (let x = 0; x < width; x++) {
				if (x % 2 === greenOffsets[0][0] && y % 2 === greenOffsets[0][1]) raw[y * width + x] = 0.04
				else if (x % 2 === greenOffsets[1][0] && y % 2 === greenOffsets[1][1]) raw[y * width + x] = 0.09
				else raw[y * width + x] = 0.8
			}
		}
		const source = image(raw, width, height, 1, pattern)
		const first = preprocessBahtinov({ image: source, area: { left: 0, top: 0, right: width, bottom: height }, center: { x: 15.5, y: 15.5 } }, { plane: 'green1', coreRadius: 0, ridgeSigma: 2 })
		const second = preprocessBahtinov({ image: source, area: { left: 0, top: 0, right: width, bottom: height }, center: { x: 15.5, y: 15.5 } }, { plane: 'green2', coreRadius: 0, ridgeSigma: 2 })
		const combined = preprocessBahtinov({ image: source, area: { left: 0, top: 0, right: width, bottom: height }, center: { x: 15.5, y: 15.5 } }, { plane: 'auto', coreRadius: 0, ridgeSigma: 2 })
		expect(first.success).toBeFalse()
		expect(second.success).toBeFalse()
		expect(combined.success).toBeFalse()
		if (!first.success && !second.success && !combined.success) {
			expect(first.reason).toBe('insufficientSupport')
			expect(second.reason).toBe('insufficientSupport')
			expect(combined.reason).toBe('insufficientSupport')
		}
	}
})

test('reconstructs CFA parity midpoints at sensor edges and odd ROI origins', () => {
	const width = 20
	const height = 20
	const raw = new Float32Array(width * height)
	raw.fill(Number.NaN)
	raw[1] = 1
	raw[3] = 3
	raw[2 * width + 1] = 5
	const source = image(raw, width, height, 1, 'RGGB')
	const workspace = createBahtinovWorkspace(width, height)
	const full = preprocessBahtinov({ image: source, area: { left: 0, top: 0, right: width, bottom: height }, center: { x: 8, y: 8 } }, { plane: 'green1', coreRadius: 0 }, workspace)
	expect(full.success).toBeFalse()
	expect(workspace.source[0]).toBe(1)
	expect(workspace.source[2]).toBe(2)
	expect(workspace.source[width + 1]).toBe(3)
	expect(workspace.source[width + 2]).toBe(3)

	const area = { left: 1, top: 1, right: 17, bottom: 17 }
	const shifted = preprocessBahtinov({ image: source, area, center: { x: 8, y: 8 } }, { plane: 'green1', coreRadius: 0 }, workspace)
	expect(shifted.success).toBeFalse()
	expect(workspace.source[0]).toBe(3)
	expect(workspace.source[1]).toBe(3)
})

test('analyzes spikes through CFA green reconstruction and masks saturated support', () => {
	const width = 64
	const height = 64
	const raw = new Float32Array(width * height)
	raw.fill(0.01)
	plotBahtinovSpikes(raw, width, height, 1, 32, 32, 100, 0, undefined, { halfLength: 20, taperLength: 4 })
	raw[32 * width + 32] = 1
	const saturated = preprocessBahtinov({ image: image(raw, width, height, 1, 'RGGB'), area: { left: 0, top: 0, right: width, bottom: height }, center: { x: 32, y: 32 } }, { saturationLevel: 0.9, saturationDilation: 2, coreRadius: 2, ridgeSigma: 2 })
	expect(saturated.success).toBeTrue()
	if (saturated.success) {
		expect(saturated.saturationFraction).toBeGreaterThan(0)
		expect(saturated.coreSaturated).toBeTrue()
		expect(saturated.spikeSaturationFraction).toBe(0)
		expect(saturated.workspace.mask[32 * width + 32]).not.toBe(0)
	}
})

test('reports saturated samples connected across the initial core boundary', () => {
	const width = 64
	const height = 64
	const raw = new Float32Array(width * height)
	raw.fill(0.01)
	plotBahtinovSpikes(raw, width, height, 1, 32, 32, 100, 0, undefined, { halfLength: 20, taperLength: 4 })
	for (let index = 0; index < raw.length; index++) raw[index] = Math.min(0.5, raw[index])
	raw[32 * width + 34] = 1
	const result = preprocessBahtinov({ image: image(raw, width, height), area: { left: 0, top: 0, right: width, bottom: height }, center: { x: 32, y: 32 } }, { saturationLevel: 0.9, saturationDilation: 1, coreRadius: 2, ridgeSigma: 2 })
	expect(result.success).toBeTrue()
	if (result.success) {
		expect(result.coreSaturated).toBeTrue()
		expect(result.spikeSaturationFraction).toBe(0)
	}
})

test('preserves saturation from either native CFA green lattice', () => {
	const width = 64
	const height = 64
	const raw = new Float32Array(width * height)
	raw.fill(0.01)
	plotBahtinovSpikes(raw, width, height, 1, 32, 32, 100, 0, undefined, { halfLength: 20, taperLength: 4 })
	const saturatedX = 9
	const saturatedY = 8
	raw[saturatedY * width + saturatedX] = 1
	const workspace = createBahtinovWorkspace(width, height)
	const result = preprocessBahtinov({ image: image(raw, width, height, 1, 'RGGB'), area: { left: 0, top: 0, right: width, bottom: height }, center: { x: 32, y: 32 } }, { plane: 'auto', saturationLevel: 0.9, saturationDilation: 0, coreRadius: 0, ridgeSigma: 2 }, workspace)
	expect(result.success).toBeTrue()
	expect(workspace.source[saturatedY * width + saturatedX]).toBeLessThan(0.9)
	expect(workspace.mask[saturatedY * width + saturatedX]).not.toBe(0)
	if (result.success) expect(result.spikeSaturationFraction).toBeGreaterThan(0)
})

test('dilates saturated samples with bounded square support', () => {
	const width = 64
	const height = 64
	const raw = new Float32Array(width * height)
	raw.fill(0.01)
	plotBahtinovSpikes(raw, width, height, 1, 32, 32, 100, 0, undefined, { halfLength: 20, taperLength: 4 })
	raw[9 * width + 8] = 1
	const workspace = createBahtinovWorkspace(width, height)
	preprocessBahtinov({ image: image(raw, width, height), area: { left: 0, top: 0, right: width, bottom: height }, center: { x: 32, y: 32 } }, { saturationLevel: 0.9, saturationDilation: 2, coreRadius: 2, ridgeSigma: 2 }, workspace)
	expect(workspace.mask[7 * width + 6]).not.toBe(0)
	expect(workspace.mask[11 * width + 10]).not.toBe(0)
	expect(workspace.mask[6 * width + 8]).toBe(0)
	expect(workspace.mask[9 * width + 11]).toBe(0)

	raw.fill(0.01)
	raw[0] = 1
	preprocessBahtinov({ image: image(raw, width, height), area: { left: 0, top: 0, right: width, bottom: height }, center: { x: 32, y: 32 } }, { saturationLevel: 0.9, saturationDilation: 100, coreRadius: 0 }, workspace)
	expect(workspace.mask.every((value) => value !== 0)).toBeTrue()
})

test('rejects a workspace whose recorded capacity is insufficient', () => {
	const width = 64
	const height = 64
	const source = image(new Float32Array(width * height), width, height)
	const workspace = createBahtinovWorkspace(width, height, { maximumRidgePoints: 128, angleStep: PI / 90, distanceStep: 1 })
	expect(() => preprocessBahtinov({ image: source, area: { left: 0, top: 0, right: width, bottom: height }, center: { x: 32, y: 32 } }, { maximumRidgePoints: 256 }, workspace)).toThrow(RangeError)
	expect(() => preprocessBahtinov({ image: source, area: { left: 0, top: 0, right: width, bottom: height }, center: { x: 32, y: 32 } }, { angleStep: PI / 180 }, workspace)).toThrow(RangeError)
	expect(() => preprocessBahtinov({ image: source, area: { left: 0, top: 0, right: width, bottom: height }, center: { x: 32, y: 32 } }, { angleStep: PI / 45 }, workspace)).toThrow(RangeError)
	expect(() => preprocessBahtinov({ image: source, area: { left: 0, top: 0, right: width, bottom: height }, center: { x: 32, y: 32 } }, { distanceStep: 2 }, workspace)).toThrow(RangeError)
	expect(() => preprocessBahtinov({ image: source, area: { left: 0, top: 0, right: width, bottom: height }, center: { x: 32, y: 32 } }, { angleStep: PI / 90, distanceStep: 1 }, workspace)).not.toThrow()
})

test('rejects Gaussian kernels whose support exceeds the active ROI', () => {
	const width = 64
	const height = 64
	const raw = new Float32Array(width * height)
	raw.fill(0.01)
	plotBahtinovSpikes(raw, width, height, 1, 32, 32, 100, 0, undefined, { halfLength: 20, taperLength: 4 })
	const source = image(raw, width, height)
	const workspace = createBahtinovWorkspace(width, height)
	const input = { image: source, area: { left: 0, top: 0, right: width, bottom: height }, center: { x: 32, y: 32 } } as const
	expect(() => preprocessBahtinov(input, { smallBlurSigma: 1e100, largeBlurSigma: 2e100 }, workspace)).toThrow(RangeError)
	expect(() => preprocessBahtinov(input, { smallBlurSigma: 1, largeBlurSigma: 1e100 }, workspace)).toThrow(RangeError)
})
