import { expect, test } from 'bun:test'
import { createBahtinovWorkspace, preprocessBahtinov, resolveBahtinovArea } from '../../../../src/imaging/analysis/bahtinov/preprocess'
import type { Image } from '../../../../src/imaging/model/types'
import { plotBahtinovSpikes } from '../../../../src/imaging/stars/generator'

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

test('creates a capacity-described reusable workspace', () => {
	const workspace = createBahtinovWorkspace(64, 48, { precision: 64, maximumRidgePoints: 512, angleStep: Math.PI / 90, distanceStep: 1 })
	expect(workspace.source).toBeInstanceOf(Float64Array)
	expect(workspace.source.length).toBe(64 * 48)
	expect(workspace.maximumRidgePoints).toBe(512)
	expect(workspace.angleCount).toBe(90)
	expect(workspace.distanceBinCount).toBe(Math.ceil(2 * Math.hypot(63, 47)) + 1)
	expect(workspace.accumulator.length).toBe(workspace.angleCount * workspace.distanceBinCount)
})

test('resolves a shifted square ROI without losing the requested size', () => {
	const source = image(new Float32Array(100 * 80), 100, 80)
	expect(resolveBahtinovArea({ image: source, center: { x: 2, y: 77 }, size: 32 })).toEqual({ left: 0, top: 48, right: 32, bottom: 80 })
	expect(resolveBahtinovArea({ image: source, area: { left: 10, top: 12, right: 50, bottom: 52 } })).toEqual({ left: 10, top: 12, right: 50, bottom: 52 })
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
	const red = preprocessBahtinov({ image: source, area: { left: 0, top: 0, right: width, bottom: height } }, { plane: 'RED', coreRadius: 2, ridgeSigma: 2 })
	const luminance = preprocessBahtinov({ image: source, area: { left: 0, top: 0, right: width, bottom: height } }, { plane: 'auto', coreRadius: 2, ridgeSigma: 2 })
	expect(red.success).toBeTrue()
	expect(luminance.success).toBeTrue()
	if (red.success && luminance.success) expect(red.background.level).not.toBe(luminance.background.level)
})

test('rejects CFA until its dedicated phase and masks saturated support', () => {
	const width = 64
	const height = 64
	const cfa = preprocessBahtinov({ image: image(new Float32Array(width * height), width, height, 1, 'RGGB'), area: { left: 0, top: 0, right: width, bottom: height } })
	expect(cfa).toEqual({ success: false, reason: 'unsupportedPlane', area: { left: 0, top: 0, right: width, bottom: height } })

	const raw = new Float32Array(width * height)
	raw.fill(0.01)
	plotBahtinovSpikes(raw, width, height, 1, 32, 32, 100, 0, undefined, { halfLength: 20, taperLength: 4 })
	raw[32 * width + 32] = 1
	const saturated = preprocessBahtinov({ image: image(raw, width, height), area: { left: 0, top: 0, right: width, bottom: height }, center: { x: 32, y: 32 } }, { saturationLevel: 0.9, saturationDilation: 2, coreRadius: 2, ridgeSigma: 2 })
	expect(saturated.success).toBeTrue()
	if (saturated.success) {
		expect(saturated.saturationFraction).toBeGreaterThan(0)
		expect(saturated.workspace.mask[32 * width + 32]).not.toBe(0)
	}
})

test('rejects a workspace whose recorded capacity is insufficient', () => {
	const width = 64
	const height = 64
	const source = image(new Float32Array(width * height), width, height)
	const workspace = createBahtinovWorkspace(width, height, { maximumRidgePoints: 128, angleStep: Math.PI / 90, distanceStep: 1 })
	expect(() => preprocessBahtinov({ image: source, area: { left: 0, top: 0, right: width, bottom: height } }, { workspace, maximumRidgePoints: 256 })).toThrow(RangeError)
	expect(() => preprocessBahtinov({ image: source, area: { left: 0, top: 0, right: width, bottom: height } }, { workspace, angleStep: Math.PI / 180 })).toThrow(RangeError)
})
