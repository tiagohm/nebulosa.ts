import { expect, test } from 'bun:test'
import { PI } from '../../../../src/core/constants'
import { bahtinovAxialAngleDistance } from '../../../../src/imaging/analysis/bahtinov/geometry'
import { detectBahtinovHoughCandidates } from '../../../../src/imaging/analysis/bahtinov/hough'
import { fitBahtinovLines } from '../../../../src/imaging/analysis/bahtinov/line'
import { createBahtinovWorkspace, preprocessBahtinov } from '../../../../src/imaging/analysis/bahtinov/preprocess'
import type { Image } from '../../../../src/imaging/model/types'
import { plotBahtinovSpikes } from '../../../../src/imaging/stars/bahtinov'

function image(raw: Float64Array, width: number, height: number): Image {
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
			bayer: undefined,
		},
	}
}

test('robustly fits global spike lines with finite support metrics', () => {
	const width = 112
	const height = 104
	const left = 13
	const top = 17
	const raw = new Float64Array(width * height)
	raw.fill(0.015)
	const expected = [PI / 12, 0, (PI * 11) / 12] as const
	plotBahtinovSpikes(raw, width, height, 1, 60, 55, 160, -2.5, undefined, { normalAngles: expected, halfLength: 36, taperLength: 6, fwhm: 2 })
	raw[30 * width + 30] += 5
	raw[70 * width + 82] += 4
	const area = { left, top, right: 109, bottom: 101 }
	const workspace = createBahtinovWorkspace(area.right - area.left, area.bottom - area.top, { precision: 64, maximumRidgePoints: 2048 })
	const preprocessed = preprocessBahtinov({ image: image(raw, width, height), area, center: { x: 60, y: 55 } }, workspace, { transform: 'linear', coreRadius: 3, ridgeSigma: 2, maximumRidgePoints: 2048 })
	expect(preprocessed.success).toBeTrue()
	if (!preprocessed.success) return
	const candidates = detectBahtinovHoughCandidates(preprocessed.ridgePoints, area.right - area.left, area.bottom - area.top, preprocessed.workspace, { center: preprocessed.center })
	const fitted = fitBahtinovLines(candidates, preprocessed.ridgePoints, area, preprocessed.responseDeviation, preprocessed.workspace, { supportRadius: 3, maximumResidual: 2, center: preprocessed.center })
	expect(fitted.length).toBeGreaterThanOrEqual(3)
	for (const angle of expected) {
		let best = fitted[0].line
		for (const candidate of fitted) {
			if (bahtinovAxialAngleDistance(candidate.line.normalAngle, angle) < bahtinovAxialAngleDistance(best.normalAngle, angle)) best = candidate.line
		}
		expect(bahtinovAxialAngleDistance(best.normalAngle, angle)).toBeLessThan(PI / 360)
		expect(best.segment[0].x).toBeGreaterThanOrEqual(area.left)
		expect(best.segment[1].x).toBeLessThanOrEqual(area.right - 1)
		expect(best.coverage).toBeGreaterThan(0.3)
		expect(best.balance).toBeGreaterThan(0.2)
		expect(best.residual).toBeLessThan(2)
		expect(best.fwhm).toBeGreaterThan(0)
		expect(best.covariance?.every(Number.isFinite)).toBeTrue()
	}
})

test('reports monotonic transverse FWHM for known synthetic spike widths', () => {
	const width = 128
	const height = 128
	const measured: number[] = []
	for (const fwhm of [1.5, 3, 5]) {
		const raw = new Float64Array(width * height)
		raw.fill(0.015)
		const expected = [PI / 12, 0, (PI * 11) / 12] as const
		plotBahtinovSpikes(raw, width, height, 1, 63.5, 63.5, 160, 0, undefined, { normalAngles: expected, halfLength: 44, taperLength: 7, fwhm })
		const area = { left: 0, top: 0, right: width, bottom: height }
		const workspace = createBahtinovWorkspace(width, height, { precision: 64, maximumRidgePoints: 2048 })
		const preprocessed = preprocessBahtinov({ image: image(raw, width, height), area, center: { x: 63.5, y: 63.5 } }, workspace, { transform: 'linear', coreRadius: 3, ridgeSigma: 2, maximumRidgePoints: 2048 })
		expect(preprocessed.success).toBeTrue()
		if (!preprocessed.success) continue
		const candidates = detectBahtinovHoughCandidates(preprocessed.ridgePoints, width, height, preprocessed.workspace, { center: preprocessed.center })
		const fitted = fitBahtinovLines(candidates, preprocessed.ridgePoints, area, preprocessed.responseDeviation, preprocessed.workspace, { supportRadius: 6, maximumResidual: 2, center: preprocessed.center })
		let central = fitted[0].line
		for (const candidate of fitted) if (bahtinovAxialAngleDistance(candidate.line.normalAngle, 0) < bahtinovAxialAngleDistance(central.normalAngle, 0)) central = candidate.line
		measured.push(central.fwhm)
	}
	expect(measured).toHaveLength(3)
	expect(measured[1]).toBeGreaterThan(measured[0])
	expect(measured[2]).toBeGreaterThan(measured[1])
})
