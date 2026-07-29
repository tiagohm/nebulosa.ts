import { expect, test } from 'bun:test'
import { PI, PIOVERTWO } from '../../../../src/core/constants'
import { compareBahtinovChromatic as compareBahtinovChromaticWithWorkspace } from '../../../../src/imaging/analysis/bahtinov/chromatic'
import { createBahtinovWorkspace, resolveBahtinovArea } from '../../../../src/imaging/analysis/bahtinov/preprocess'
import type { BahtinovAnalysisInput, BahtinovChromaticOptions } from '../../../../src/imaging/analysis/bahtinov/types'
import type { Image } from '../../../../src/imaging/model/types'
import { debayer } from '../../../../src/imaging/processing/debayer'
import { plotBahtinovSpikes } from '../../../../src/imaging/stars/bahtinov'

function rgbBahtinov(errors: readonly [number, number, number], omittedChannel?: number, centralNormals?: readonly [number, number, number]): Image {
	const width = 128
	const height = 128
	const raw = new Float64Array(width * height * 3)
	raw.fill(0.01)
	for (let channel = 0; channel < 3; channel++) {
		if (channel === omittedChannel) continue
		const mono = new Float64Array(width * height)
		const centralNormal = centralNormals?.[channel] ?? PIOVERTWO
		plotBahtinovSpikes(mono, width, height, 1, 63.5, 63.5, 180, errors[channel], undefined, {
			normalAngles: [(centralNormal - PI / 12 + PI) % PI, centralNormal, (centralNormal + PI / 12) % PI],
			central: 1,
			fwhm: 2,
			halfLength: 44,
			taperLength: 7,
		})
		for (let i = 0; i < mono.length; i++) raw[i * 3 + channel] += mono[i]
	}
	return {
		raw,
		header: {},
		metadata: {
			width,
			height,
			channels: 3,
			stride: width * 3,
			pixelCount: width * height,
			strideInBytes: width * 3 * 8,
			pixelSizeInBytes: 8,
			bitpix: -64,
			bayer: undefined,
		},
	}
}

function compareBahtinovChromatic(input: BahtinovAnalysisInput, options: BahtinovChromaticOptions = {}) {
	const area = resolveBahtinovArea(input)
	const width = area.right - area.left
	const height = area.bottom - area.top
	const workspace = createBahtinovWorkspace(width, height, {
		precision: input.image.raw.BYTES_PER_ELEMENT === 8 ? 64 : 32,
		maximumRidgePoints: Math.min(options.maximumRidgePoints ?? 4096, width * height),
		angleStep: options.angleStep,
		distanceStep: options.distanceStep,
	})
	return compareBahtinovChromaticWithWorkspace(input, workspace, options)
}

const OPTIONS = {
	transform: 'linear' as const,
	coreRadius: 3,
	ridgeSigma: 2,
	maximumRidgePoints: 2048,
	minimumSignalToNoise: 1,
	minimumCoverage: 0.15,
	minimumBalance: 0.05,
	maximumResidual: 2,
	minimumConfidence: 0.05,
	minimumCandidateSeparation: 0.01,
}

test('compares signed RGB focus errors relative to green', () => {
	const result = compareBahtinovChromatic({ image: rgbBahtinov([-2, 0, 3]), area: { left: 0, top: 0, right: 128, bottom: 128 }, center: { x: 63.5, y: 63.5 } }, OPTIONS)
	expect(result.success).toBeTrue()
	if (!result.success) return
	expect(Math.abs(result.redMinusGreen + 2)).toBeLessThan(0.3)
	expect(Math.abs(result.blueMinusGreen - 3)).toBeLessThan(0.3)
	expect(Math.abs(result.focusSpan - 5)).toBeLessThan(0.4)
	expect(Math.hypot(result.redReferenceOffset.x, result.redReferenceOffset.y)).toBeLessThan(0.1)
	expect(Math.hypot(result.blueReferenceOffset.x, result.blueReferenceOffset.y)).toBeLessThan(0.1)
	expect(result.confidence).toBeGreaterThan(0)
})

test('aligns channel error signs across the axial normal wrap', () => {
	const result = compareBahtinovChromatic(
		{
			image: rgbBahtinov([-2, 2, -2], undefined, [PI - 0.01, 0.01, PI - 0.015]),
			area: { left: 0, top: 0, right: 128, bottom: 128 },
			center: { x: 63.5, y: 63.5 },
		},
		OPTIONS,
	)
	expect(result.success).toBeTrue()
	if (!result.success) return
	expect(Math.abs(result.redMinusGreen)).toBeLessThan(0.3)
	expect(Math.abs(result.blueMinusGreen)).toBeLessThan(0.3)
	expect(result.focusSpan).toBeLessThan(0.3)
})

test('retains per-channel failures without fabricating chromatic offsets', () => {
	const result = compareBahtinovChromatic({ image: rgbBahtinov([0, 0, 0], 2), area: { left: 0, top: 0, right: 128, bottom: 128 }, center: { x: 63.5, y: 63.5 } }, OPTIONS)
	expect(result.success).toBeFalse()
	if (!result.success) {
		expect(result.failedChannels).toEqual(['blue'])
		expect(result.channels.red.success).toBeTrue()
		expect(result.channels.green.success).toBeTrue()
		expect(result.channels.blue.success).toBeFalse()
		expect('blueMinusGreen' in result).toBeFalse()
	}
})

test('rejects independently detected channel patterns with different rotations', () => {
	const result = compareBahtinovChromatic(
		{
			image: rgbBahtinov([0, 0, 0], undefined, [PIOVERTWO, PIOVERTWO, PIOVERTWO + PI / 6]),
			area: { left: 0, top: 0, right: 128, bottom: 128 },
			center: { x: 63.5, y: 63.5 },
		},
		OPTIONS,
	)
	expect(result.success).toBeFalse()
	if (!result.success) {
		expect(result.failedChannels).toEqual(['blue'])
		expect(result.channels.red.success).toBeTrue()
		expect(result.channels.green.success).toBeTrue()
		expect(result.channels.blue.success).toBeTrue()
		expect('blueMinusGreen' in result).toBeFalse()
	}
})

test('compares an RGB image produced by debayer', () => {
	const width = 128
	const height = 128
	const raw = new Float64Array(width * height)
	raw.fill(0.01)
	plotBahtinovSpikes(raw, width, height, 1, 63.5, 63.5, 180, 0, undefined, {
		normalAngles: [(PI * 5) / 12, PIOVERTWO, (PI * 7) / 12],
		central: 1,
		fwhm: 2,
		halfLength: 44,
		taperLength: 7,
	})
	const source = debayer({
		raw,
		header: {},
		metadata: {
			width,
			height,
			channels: 1,
			stride: width,
			pixelCount: width * height,
			strideInBytes: width * 8,
			pixelSizeInBytes: 8,
			bitpix: -64,
			bayer: 'RGGB',
		},
	})
	expect(source).toBeDefined()
	if (!source) return
	expect(source.metadata.bayer).toBe('RGGB')
	const result = compareBahtinovChromatic({ image: source, area: { left: 0, top: 0, right: width, bottom: height }, center: { x: 63.5, y: 63.5 } }, OPTIONS)
	expect(result.success).toBeTrue()
})

test('rejects mono input for chromatic comparison', () => {
	const rgb = rgbBahtinov([0, 0, 0])
	const mono: Image = { ...rgb, raw: new Float64Array(128 * 128), metadata: { ...rgb.metadata, channels: 1, stride: 128, pixelCount: 128 * 128 } }
	expect(() => compareBahtinovChromatic({ image: mono, area: { left: 0, top: 0, right: 128, bottom: 128 }, center: { x: 63.5, y: 63.5 } }, OPTIONS)).toThrow(RangeError)
})
