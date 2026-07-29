import { expect, test } from 'bun:test'
import { analyzeBahtinov } from '../../../../src/imaging/analysis/bahtinov/bahtinov'
import { createBahtinovOverlayGeometry } from '../../../../src/imaging/analysis/bahtinov/overlay'
import { createBahtinovWorkspace } from '../../../../src/imaging/analysis/bahtinov/preprocess'
import type { CfaPattern, Image, ImageRawType } from '../../../../src/imaging/model/types'
import { plotBahtinovSpikes } from '../../../../src/imaging/stars/generator'

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

function synthetic(error: number, width: number = 128, height: number = 128): Image {
	const raw = new Float64Array(width * height)
	raw.fill(0.01)
	plotBahtinovSpikes(raw, width, height, 1, (width - 1) * 0.5, (height - 1) * 0.5, 180, error, undefined, {
		normalAngles: [(Math.PI * 5) / 12, Math.PI / 2, (Math.PI * 7) / 12],
		central: 1,
		fwhm: 2,
		halfLength: 44,
		taperLength: 7,
	})
	return image(raw, width, height)
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
	const result = analyzeBahtinov({ image: image(new Float64Array(width * height), width, height), area: { left: 0, top: 0, right: width, bottom: height } })
	expect(result.success).toBeFalse()
	if (!result.success) {
		expect(['lowSignal', 'insufficientSupport', 'patternNotFound']).toContain(result.reason)
		expect('reference' in result).toBeFalse()
		expect('error' in result).toBeFalse()
	}
})

test('keeps debug snapshots detached across workspace reuse', () => {
	const width = 128
	const height = 128
	const workspace = createBahtinovWorkspace(width, height, { precision: 64, maximumRidgePoints: 2048 })
	const first = analyzeBahtinov({ image: synthetic(2), area: { left: 0, top: 0, right: width, bottom: height } }, { ...ANALYSIS_OPTIONS, workspace, includeDebug: true })
	expect(first.success).toBeTrue()
	if (!first.success || !first.debug?.response || !first.debug.mask || !first.debug.source) return
	const response = first.debug.response.slice()
	const mask = first.debug.mask.slice()
	const source = first.debug.source.slice()
	analyzeBahtinov({ image: synthetic(-3), area: { left: 0, top: 0, right: width, bottom: height } }, { ...ANALYSIS_OPTIONS, workspace })
	expect(first.debug.response).toEqual(response)
	expect(first.debug.mask).toEqual(mask)
	expect(first.debug.source).toEqual(source)
})

test('uses uncertainty rather than raw error alone for focus classification', () => {
	const result = analyzeBahtinov({ image: synthetic(0.4), area: { left: 0, top: 0, right: 128, bottom: 128 } }, { ...ANALYSIS_OPTIONS, focusTolerance: 0.5, focusSigma: 10, maximumUncertainty: 10 })
	expect(result.success).toBeTrue()
	if (result.success) expect(['focused', 'indeterminate']).toContain(result.focusState)
})

test('validates triplet decision options before preprocessing', () => {
	const source = synthetic(0)
	expect(() => analyzeBahtinov({ image: source, area: { left: 0, top: 0, right: 128, bottom: 128 } }, { intersectionMargin: -1 })).toThrow(RangeError)
	expect(() => analyzeBahtinov({ image: source, area: { left: 0, top: 0, right: 128, bottom: 128 } }, { minimumCandidateSeparation: 2 })).toThrow(RangeError)
})
