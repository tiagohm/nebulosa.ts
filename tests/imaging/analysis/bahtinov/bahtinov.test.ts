import { expect, test } from 'bun:test'
import { PI, PIOVERTWO } from '../../../../src/core/constants'
import { analyzeBahtinov as analyzeBahtinovWithWorkspace } from '../../../../src/imaging/analysis/bahtinov/bahtinov'
import { bahtinovAxialAngleDistance } from '../../../../src/imaging/analysis/bahtinov/geometry'
import { createBahtinovOverlayGeometry } from '../../../../src/imaging/analysis/bahtinov/overlay'
import { createBahtinovWorkspace, resolveBahtinovArea } from '../../../../src/imaging/analysis/bahtinov/preprocess'
import type { BahtinovAnalysisInput, BahtinovAnalysisOptions } from '../../../../src/imaging/analysis/bahtinov/types'
import type { CfaPattern, Image, ImageRawType } from '../../../../src/imaging/model/types'
import { plotBahtinovSpikes } from '../../../../src/imaging/stars/bahtinov'

function image(raw: ImageRawType, width: number, height: number, bayer?: CfaPattern): Image {
	return {
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
			bayer,
		},
	}
}

function analyzeBahtinov(input: BahtinovAnalysisInput, options: BahtinovAnalysisOptions = {}) {
	const area = resolveBahtinovArea(input)
	const width = area.right - area.left
	const height = area.bottom - area.top
	const workspace = createBahtinovWorkspace(width, height, {
		precision: input.image.raw.BYTES_PER_ELEMENT === 8 ? 64 : 32,
		maximumRidgePoints: Math.min(options.maximumRidgePoints ?? 4096, width * height),
		angleStep: options.angleStep,
		distanceStep: options.distanceStep,
	})
	return analyzeBahtinovWithWorkspace(input, workspace, options)
}

function synthetic(error: number, width: number = 128, height: number = 128): Image {
	const raw = new Float64Array(width * height)
	raw.fill(0.01)
	plotBahtinovSpikes(raw, width, height, 1, (width - 1) * 0.5, (height - 1) * 0.5, 180, error, undefined, {
		normalAngles: [(PI * 5) / 12, PIOVERTWO, (PI * 7) / 12],
		central: 1,
		fwhm: 2,
		halfLength: 44,
		taperLength: 7,
	})
	return image(raw, width, height)
}

function translatedSynthetic(error: number, left: number, top: number): Image {
	const width = 512
	const height = 512
	const raw = new Float64Array(width * height)
	raw.fill(0.01)
	plotBahtinovSpikes(raw, width, height, 1, left + 63.5, top + 63.5, 180, error, undefined, {
		normalAngles: [(PI * 5) / 12, PIOVERTWO, (PI * 7) / 12],
		central: 1,
		fwhm: 2,
		halfLength: 44,
		taperLength: 7,
	})
	return image(raw, width, height)
}

function offCenterSynthetic(error: number, centerX: number, centerY: number): Image {
	const width = 128
	const height = 128
	const raw = new Float64Array(width * height)
	raw.fill(0.01)
	plotBahtinovSpikes(raw, width, height, 1, centerX, centerY, 180, error, undefined, {
		normalAngles: [(PI * 5) / 12, PIOVERTWO, (PI * 7) / 12],
		central: 1,
		fwhm: 2,
		halfLength: 44,
		taperLength: 7,
	})
	return image(raw, width, height)
}

function scaledSynthetic(error: number, gain: number): Image {
	const source = synthetic(error)
	for (let index = 0; index < source.raw.length; index++) source.raw[index] = (source.raw[index] + (((index * 37) % 101) - 50) * 1e-5) * gain
	return source
}

const ANALYSIS_OPTIONS = {
	transform: 'linear' as const,
	coreRadius: 3,
	ridgeSigma: 2,
	maximumRidgePoints: 2048,
	minimumSignalToNoise: 1,
	minimumCoverage: 0.15,
	minimumBalance: 0.05,
	maximumResidual: 2,
	focusTolerance: 1,
	maximumUncertainty: 1,
	minimumConfidence: 0.05,
	minimumCandidateSeparation: 0.01,
}

test('recovers zero and signed synthetic focus errors end to end', () => {
	for (const error of [-4, 0, 3]) {
		const source = synthetic(error)
		const result = analyzeBahtinov({ image: source, area: { left: 0, top: 0, right: 128, bottom: 128 }, center: { x: 63.5, y: 63.5 } }, ANALYSIS_OPTIONS)
		expect(result.success).toBeTrue()
		if (!result.success) continue
		expect(Math.abs(result.error - error)).toBeLessThan(0.2)
		expect(Math.abs(result.absoluteError - Math.abs(error))).toBeLessThan(0.2)
		expect(result.focusProximity).toBeCloseTo(1 / (1 + result.absoluteError), 12)
		expect(result.confidence).toBeGreaterThan(0)
		expect(result.uncertainty).toBeFinite()
		expect(result.focusState).toBe(error === 0 ? 'focused' : 'defocused')
		const overlay = createBahtinovOverlayGeometry(result)
		expect(Math.hypot(overlay.reference.x - overlay.centralProjection.x, overlay.reference.y - overlay.centralProjection.y)).toBeCloseTo(result.absoluteError, 10)
	}
})

test('preserves uncertainty and classification when the ROI is translated', () => {
	const first = analyzeBahtinov({ image: translatedSynthetic(3, 0, 0), area: { left: 0, top: 0, right: 128, bottom: 128 }, center: { x: 63.5, y: 63.5 } }, ANALYSIS_OPTIONS)
	const second = analyzeBahtinov({ image: translatedSynthetic(3, 300, 250), area: { left: 300, top: 250, right: 428, bottom: 378 }, center: { x: 363.5, y: 313.5 } }, ANALYSIS_OPTIONS)
	expect(first.success).toBeTrue()
	expect(second.success).toBeTrue()
	if (!first.success || !second.success) return
	expect(second.error).toBeCloseTo(first.error, 10)
	expect(second.uncertainty).toBeCloseTo(first.uncertainty!, 6)
	expect(second.focusState).toBe(first.focusState)
})

test('preserves uncertainty when a contained pattern moves within one ROI', () => {
	const first = analyzeBahtinov({ image: offCenterSynthetic(3, 50, 55), area: { left: 0, top: 0, right: 128, bottom: 128 }, center: { x: 50, y: 55 } }, ANALYSIS_OPTIONS)
	const second = analyzeBahtinov({ image: offCenterSynthetic(3, 70, 73), area: { left: 0, top: 0, right: 128, bottom: 128 }, center: { x: 70, y: 73 } }, ANALYSIS_OPTIONS)
	expect(first.success).toBeTrue()
	expect(second.success).toBeTrue()
	if (!first.success || !second.success) return
	expect(Math.abs(second.error - first.error)).toBeLessThan(0.03)
	expect(Math.abs(second.uncertainty! - first.uncertainty!) / first.uncertainty!).toBeLessThan(5e-4)
	expect(second.focusState).toBe(first.focusState)
})

test('recovers a cropped pattern away from the ROI midpoint', () => {
	const result = analyzeBahtinov({ image: offCenterSynthetic(2, 20, 63.5), area: { left: 0, top: 0, right: 128, bottom: 128 }, center: { x: 20, y: 63.5 } }, ANALYSIS_OPTIONS)
	expect(result.success).toBeTrue()
	if (!result.success) return
	expect(Math.abs(result.error - 2)).toBeLessThan(0.3)
	expect(Math.hypot(result.reference.x - 20, result.reference.y - 63.5)).toBeLessThan(0.5)
})

test('reports crop coverage independently when long spikes reach the ROI boundary', () => {
	const width = 64
	const height = 64
	const raw = new Float64Array(width * height)
	raw.fill(0.01)
	plotBahtinovSpikes(raw, width, height, 1, 31.5, 31.5, 180, 2, undefined, {
		normalAngles: [(PI * 5) / 12, PIOVERTWO, (PI * 7) / 12],
		central: 1,
		fwhm: 2,
		halfLength: 100,
		taperLength: 7,
	})
	const result = analyzeBahtinov({ image: image(raw, width, height), area: { left: 0, top: 0, right: width, bottom: height }, center: { x: 31.5, y: 31.5 } }, { ...ANALYSIS_OPTIONS, maximumRidgePoints: 2048 })
	expect(result.success).toBeTrue()
	if (!result.success) return
	expect(result.quality.lineCoverage).toBeGreaterThan(0.8)
	expect(result.quality.cropCoverage).toBeLessThanOrEqual(0.5)
	expect(result.warnings.some((warning) => warning.code === 'patternCropped')).toBeTrue()
})

test('keeps line signal-to-noise invariant under uniform gain', () => {
	const low = analyzeBahtinov({ image: scaledSynthetic(2, 0.25), area: { left: 0, top: 0, right: 128, bottom: 128 }, center: { x: 63.5, y: 63.5 } }, ANALYSIS_OPTIONS)
	const high = analyzeBahtinov({ image: scaledSynthetic(2, 0.5), area: { left: 0, top: 0, right: 128, bottom: 128 }, center: { x: 63.5, y: 63.5 } }, ANALYSIS_OPTIONS)
	expect(low.success).toBeTrue()
	expect(high.success).toBeTrue()
	if (!low.success || !high.success) return
	const lowLines = [low.centralLine, low.externalLines[0], low.externalLines[1]]
	const highLines = [high.centralLine, high.externalLines[0], high.externalLines[1]]
	for (let index = 0; index < lowLines.length; index++) {
		expect(highLines[index].strength / lowLines[index].strength).toBeCloseTo(2, 6)
		expect(Math.abs(highLines[index].signalToNoise - lowLines[index].signalToNoise) / lowLines[index].signalToNoise).toBeLessThan(1e-6)
	}
})

test('recovers focus error from a raw CFA green mosaic', () => {
	const source = synthetic(-3)
	for (let y = 0; y < source.metadata.height; y++) {
		for (let x = 0; x < source.metadata.width; x++) {
			if ((x & 1) === (y & 1)) source.raw[y * source.metadata.stride + x] = 0.7
		}
	}
	const cfa = image(source.raw, source.metadata.width, source.metadata.height, 'RGGB')
	const result = analyzeBahtinov({ image: cfa, area: { left: 0, top: 0, right: 128, bottom: 128 }, center: { x: 63.5, y: 63.5 } }, ANALYSIS_OPTIONS)
	expect(result.success).toBeTrue()
	if (result.success) expect(Math.abs(result.error + 3)).toBeLessThan(0.5)
})

test('returns explicit content failures without fabricated geometry', () => {
	const width = 64
	const height = 64
	const result = analyzeBahtinov({ image: image(new Float64Array(width * height), width, height), area: { left: 0, top: 0, right: width, bottom: height }, center: { x: 31.5, y: 31.5 } })
	expect(result.success).toBeFalse()
	if (!result.success) {
		expect(['lowSignal', 'insufficientSupport', 'patternNotFound']).toContain(result.reason)
		expect('reference' in result).toBeFalse()
		expect('error' in result).toBeFalse()
	}
})

test('does not fit saturation-mask boundaries as a defocused pattern', () => {
	const result = analyzeBahtinov({ image: synthetic(0), area: { left: 0, top: 0, right: 128, bottom: 128 }, center: { x: 63.5, y: 63.5 } }, { ...ANALYSIS_OPTIONS, saturationLevel: 0.2 })
	if (result.success) expect(Math.abs(result.error)).toBeLessThan(1)
	else expect(['saturated', 'insufficientSupport', 'patternNotFound']).toContain(result.reason)
})

test('measures saturation retention on the selected spike bands', () => {
	const source = synthetic(0)
	for (let y = 63; y <= 64; y++) {
		for (let x = 20; x <= 40; x++) source.raw[y * 128 + x] = 1
	}
	const result = analyzeBahtinov({ image: source, area: { left: 0, top: 0, right: 128, bottom: 128 }, center: { x: 63.5, y: 63.5 } }, ANALYSIS_OPTIONS)
	expect(result.success).toBeTrue()
	if (result.success) expect(result.quality.saturationRetention).toBeLessThan(0.9)
})

test('uses uncertainty rather than raw error alone for focus classification', () => {
	const result = analyzeBahtinov({ image: synthetic(0.4), area: { left: 0, top: 0, right: 128, bottom: 128 }, center: { x: 63.5, y: 63.5 } }, { ...ANALYSIS_OPTIONS, focusTolerance: 0.5, focusSigma: 10, maximumUncertainty: 10 })
	expect(result.success).toBeTrue()
	if (result.success) expect(['focused', 'indeterminate']).toContain(result.focusState)
})

test('validates triplet decision options before preprocessing', () => {
	const source = synthetic(0)
	expect(() => analyzeBahtinov({ image: source, area: { left: 0, top: 0, right: 128, bottom: 128 }, center: { x: 63.5, y: 63.5 } }, { intersectionMargin: -1 })).toThrow(RangeError)
	expect(() => analyzeBahtinov({ image: source, area: { left: 0, top: 0, right: 128, bottom: 128 }, center: { x: 63.5, y: 63.5 } }, { minimumCandidateSeparation: 2 })).toThrow(RangeError)
})

test('rejects a detected pattern beyond the expected angular limit', () => {
	const result = analyzeBahtinov(
		{
			image: synthetic(2),
			area: { left: 0, top: 0, right: 128, bottom: 128 },
			center: { x: 63.5, y: 63.5 },
			expected: {
				centralNormalAngle: (PIOVERTWO * 3) / 2,
				externalNormalAngles: [(PI * 2) / 3, (PI * 5) / 6],
				maximumAngleDelta: PI / 180,
			},
		},
		ANALYSIS_OPTIONS,
	)
	expect(result.success).toBeFalse()
	if (!result.success) expect(result.reason).toBe('patternNotFound')
})

test('uses expected angles as a prior without a hard mismatch limit', () => {
	const width = 192
	const height = 192
	const raw = new Float64Array(width * height)
	raw.fill(0.01)
	const expected = [(PI * 5) / 12, PIOVERTWO, (PI * 7) / 12] as const
	plotBahtinovSpikes(raw, width, height, 1, 95.5, 95.5, 110, 2, undefined, { normalAngles: expected, central: 1, fwhm: 2, halfLength: 56, taperLength: 8 })
	plotBahtinovSpikes(raw, width, height, 1, 95.5, 95.5, 150, -4, undefined, { normalAngles: [PI / 12, PI / 6, PI / 4], central: 1, fwhm: 2, halfLength: 56, taperLength: 8 })
	const result = analyzeBahtinov(
		{
			image: image(raw, width, height),
			area: { left: 0, top: 0, right: width, bottom: height },
			center: { x: 95.5, y: 95.5 },
			expected: { centralNormalAngle: expected[1], externalNormalAngles: [expected[0], expected[2]] },
		},
		{ ...ANALYSIS_OPTIONS, maximumRidgePoints: 4096 },
	)
	expect(result.success).toBeTrue()
	if (result.success) {
		expect(bahtinovAxialAngleDistance(result.centralLine.normalAngle, expected[1])).toBeLessThan(PI / 180)
		expect(result.error).toBeCloseTo(2, 0)
	}
})

test('validates preprocessing and Hough options before content failures', () => {
	const width = 64
	const height = 64
	const raw = new Float64Array(width * height)
	raw.fill(Number.NaN)
	const source = image(raw, width, height)
	const input = { image: source, area: { left: 0, top: 0, right: width, bottom: height }, center: { x: 31.5, y: 31.5 } } as const
	const workspace = createBahtinovWorkspace(width, height)
	expect(() => analyzeBahtinovWithWorkspace(input, workspace, { saturationLevel: -1 })).toThrow(RangeError)
	expect(() => analyzeBahtinovWithWorkspace(input, workspace, { ridgeSigma: 0 })).toThrow(RangeError)
	expect(() => analyzeBahtinovWithWorkspace(input, workspace, { maximumRidgePoints: -1 })).toThrow(RangeError)
	expect(() => analyzeBahtinovWithWorkspace(input, workspace, { maximumAngleCandidates: 2 })).toThrow(RangeError)
})

test('validates the expected pattern before content failures', () => {
	const width = 64
	const height = 64
	const raw = new Float64Array(width * height)
	raw.fill(Number.NaN)
	const source = image(raw, width, height)
	const workspace = createBahtinovWorkspace(width, height)
	const base = { image: source, area: { left: 0, top: 0, right: width, bottom: height }, center: { x: 31.5, y: 31.5 } } as const
	expect(() => analyzeBahtinovWithWorkspace({ ...base, expected: { centralNormalAngle: Number.NaN, externalNormalAngles: [PI / 3, (PI * 2) / 3] } }, workspace)).toThrow(RangeError)
	expect(() => analyzeBahtinovWithWorkspace({ ...base, expected: { centralNormalAngle: PIOVERTWO, externalNormalAngles: [PI / 3, (PI * 2) / 3], maximumAngleDelta: PI } }, workspace)).toThrow(RangeError)
})

test('uses an approximate center only to anchor the analysis region', () => {
	for (const offset of [0, 12, 24]) {
		const result = analyzeBahtinov({ image: synthetic(3, 256, 256), center: { x: 127.5 + offset, y: 127.5 - offset }, size: 128 }, ANALYSIS_OPTIONS)
		expect(result.success).toBeTrue()
		if (!result.success) continue
		expect(Math.hypot(result.reference.x - 127.5, result.reference.y - 127.5)).toBeLessThan(0.2)
		expect(Math.abs(result.error - 3)).toBeLessThan(0.25)
	}
})
