import { expect, test } from 'bun:test'
import { PI } from '../../../../src/core/constants'
import { STANDARD_DEVIATION_SCALE } from '../../../../src/core/util'
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

test('recomputes the robust scale for the final one-iteration fit', () => {
	const width = 128
	const height = 128
	const raw = new Float64Array(width * height)
	raw.fill(0.015)
	plotBahtinovSpikes(raw, width, height, 1, 63.5, 63.5, 160, 0, undefined, {
		normalAngles: [PI / 12, 0, (PI * 11) / 12],
		central: 1,
		halfLength: 44,
		taperLength: 7,
		fwhm: 2,
		strengths: [0, 1, 0],
	})
	const area = { left: 0, top: 0, right: width, bottom: height }
	const workspace = createBahtinovWorkspace(width, height, { precision: 64, maximumRidgePoints: 2048 })
	const preprocessed = preprocessBahtinov({ image: image(raw, width, height), area, center: { x: 63.5, y: 63.5 } }, workspace, { transform: 'linear', coreRadius: 3, ridgeSigma: 2, maximumRidgePoints: 2048 })
	expect(preprocessed.success).toBeTrue()
	if (!preprocessed.success) return
	const candidates = detectBahtinovHoughCandidates(preprocessed.ridgePoints, width, height, preprocessed.workspace, { center: preprocessed.center })
	let seed = candidates[0]
	for (const candidate of candidates) if (bahtinovAxialAngleDistance(candidate.normalAngle, 0) < bahtinovAxialAngleDistance(seed.normalAngle, 0)) seed = candidate
	const offsetSeed = { ...seed, distance: seed.distance + 4 }
	const baseCount = preprocessed.ridgePoints.count
	for (let index = 0; index < 8; index++) {
		preprocessed.ridgePoints.x[baseCount + index] = seed.distance + 6
		preprocessed.ridgePoints.y[baseCount + index] = 16 + index * 12
		preprocessed.ridgePoints.weight[baseCount + index] = 10
	}
	const ridgePoints = { ...preprocessed.ridgePoints, count: baseCount + 8 }
	const fitted = fitBahtinovLines([{ ...offsetSeed }], ridgePoints, area, preprocessed.responseDeviation, preprocessed.workspace, {
		supportRadius: 6,
		robustIterations: 1,
		maximumResidual: 10,
		profileBlurSigma: preprocessed.profileBlurSigma,
		center: preprocessed.center,
	})
	expect(fitted).toHaveLength(1)
	const line = fitted[0].line
	const candidateCos = Math.cos(offsetSeed.normalAngle)
	const candidateSin = Math.sin(offsetSeed.normalAngle)
	const normalCos = Math.cos(line.normalAngle)
	const normalSin = Math.sin(line.normalAngle)
	const residuals: number[] = []
	for (let index = 0; index < ridgePoints.count; index++) {
		if (Math.abs(ridgePoints.x[index] * candidateCos + ridgePoints.y[index] * candidateSin - offsetSeed.distance) <= 6) residuals.push(Math.abs(ridgePoints.x[index] * normalCos + ridgePoints.y[index] * normalSin - line.distance))
	}
	residuals.sort((first, second) => first - second)
	const middle = residuals.length >> 1
	const median = residuals.length % 2 === 0 ? (residuals[middle - 1] + residuals[middle]) * 0.5 : residuals[middle]
	const huberLimit = 1.345 * Math.max(1e-12, median * STANDARD_DEVIATION_SCALE)
	let weightedSquaredResidual = 0
	let effectiveWeight = 0
	for (let index = 0; index < ridgePoints.count; index++) {
		if (Math.abs(ridgePoints.x[index] * candidateCos + ridgePoints.y[index] * candidateSin - offsetSeed.distance) > 6) continue
		const residual = ridgePoints.x[index] * normalCos + ridgePoints.y[index] * normalSin - line.distance
		const absoluteResidual = Math.abs(residual)
		const weight = ridgePoints.weight[index] * (absoluteResidual <= huberLimit ? 1 : huberLimit / absoluteResidual)
		weightedSquaredResidual += weight * residual * residual
		effectiveWeight += weight
	}
	expect(line.residual).toBeCloseTo(Math.sqrt(weightedSquaredResidual / effectiveWeight), 12)
})

test('recovers broad synthetic FWHM outside the fixed fit-support band', () => {
	const width = 128
	const height = 128
	const measured: number[] = []
	for (const fwhm of [2, 4, 8]) {
		const raw = new Float64Array(width * height)
		raw.fill(0.015)
		const expected = [PI / 12, 0, (PI * 11) / 12] as const
		plotBahtinovSpikes(raw, width, height, 1, 63.5, 63.5, 160, 0, undefined, { normalAngles: expected, halfLength: 44, taperLength: 7, fwhm, strengths: [0, 1, 0] })
		const area = { left: 0, top: 0, right: width, bottom: height }
		const workspace = createBahtinovWorkspace(width, height, { precision: 64, maximumRidgePoints: 2048 })
		const preprocessed = preprocessBahtinov({ image: image(raw, width, height), area, center: { x: 63.5, y: 63.5 } }, workspace, { coreRadius: 3, ridgeSigma: 2, maximumRidgePoints: 2048 })
		expect(preprocessed.success).toBeTrue()
		if (!preprocessed.success) continue
		const candidates = detectBahtinovHoughCandidates(preprocessed.ridgePoints, width, height, preprocessed.workspace, { center: preprocessed.center })
		const fitted = fitBahtinovLines(candidates, preprocessed.ridgePoints, area, preprocessed.responseDeviation, preprocessed.workspace, {
			supportRadius: 3,
			maximumResidual: 2,
			profileBlurSigma: preprocessed.profileBlurSigma,
			center: preprocessed.center,
		})
		let central = fitted[0].line
		for (const candidate of fitted) if (bahtinovAxialAngleDistance(candidate.line.normalAngle, 0) < bahtinovAxialAngleDistance(central.normalAngle, 0)) central = candidate.line
		measured.push(central.fwhm)
	}
	expect(measured).toHaveLength(3)
	expect(Math.abs(measured[0] - 2)).toBeLessThan(1)
	expect(Math.abs(measured[1] - 4)).toBeLessThan(1)
	expect(Math.abs(measured[2] - 8)).toBeLessThan(1)
})

test('rejects a source width unresolved beneath the profile blur', () => {
	const width = 128
	const height = 128
	const raw = new Float64Array(width * height)
	raw.fill(0.015)
	plotBahtinovSpikes(raw, width, height, 1, 63, 63.5, 1, 0, undefined, {
		normalAngles: [PI / 12, 0, (PI * 11) / 12],
		central: 1,
		fwhm: 0.1,
		halfLength: 44,
		taperLength: 7,
		strengths: [0, 1, 0],
	})
	const area = { left: 0, top: 0, right: width, bottom: height }
	const workspace = createBahtinovWorkspace(width, height, { precision: 64, maximumRidgePoints: 2048 })
	const preprocessed = preprocessBahtinov({ image: image(raw, width, height), area, center: { x: 63, y: 63.5 } }, workspace, { coreRadius: 3, ridgeSigma: 2, maximumRidgePoints: 2048 })
	expect(preprocessed.success).toBeTrue()
	if (!preprocessed.success) return
	const candidates = detectBahtinovHoughCandidates(preprocessed.ridgePoints, width, height, preprocessed.workspace, { center: preprocessed.center })
	expect(candidates.some((candidate) => bahtinovAxialAngleDistance(candidate.normalAngle, 0) < PI / 360)).toBeTrue()
	const fitted = fitBahtinovLines(candidates, preprocessed.ridgePoints, area, preprocessed.responseDeviation, preprocessed.workspace, {
		supportRadius: 3,
		maximumResidual: 2,
		profileBlurSigma: preprocessed.profileBlurSigma * 2,
		center: preprocessed.center,
	})
	expect(fitted.some((candidate) => bahtinovAxialAngleDistance(candidate.line.normalAngle, 0) < PI / 360)).toBeFalse()
})
