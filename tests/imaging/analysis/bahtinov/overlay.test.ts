import { expect, test } from 'bun:test'
import { PI, PIOVERFOUR } from '../../../../src/core/constants'
import { createBahtinovOverlayGeometry } from '../../../../src/imaging/analysis/bahtinov/overlay'
import type { BahtinovAnalysisSuccess, BahtinovLine, BahtinovQuality } from '../../../../src/imaging/analysis/bahtinov/types'

const QUALITY: BahtinovQuality = {
	signal: 1,
	lineStrength: 1,
	lineCoverage: 1,
	lineBalance: 1,
	lineFit: 1,
	angularSymmetry: 1,
	intersectionCondition: 1,
	saturationRetention: 1,
	cropCoverage: 1,
	candidateSeparation: 1,
}

function line(normalAngle: number, distance: number, fwhm: number, fromX: number, fromY: number, toX: number, toY: number): BahtinovLine {
	return {
		normalAngle,
		distance,
		strength: 1,
		signalToNoise: 20,
		fwhm,
		coverage: 1,
		cropCoverage: 1,
		balance: 1,
		residual: 0,
		segment: [
			{ x: fromX, y: fromY },
			{ x: toX, y: toY },
		],
	}
}

function analysis(error: number = 3): BahtinovAnalysisSuccess {
	return {
		success: true,
		area: { left: 0, top: 0, right: 21, bottom: 21 },
		reference: { x: 10, y: 10 },
		centralLine: line(0, 10 - error, 4, 10 - error, 0, 10 - error, 20),
		externalLines: [line(PIOVERFOUR, 10 * Math.SQRT2, 6, 0, 20, 20, 0), line((PI * 3) / 4, 0, 8, 0, 0, 20, 20)],
		error,
		absoluteError: Math.abs(error),
		focusProximity: 1 / (1 + Math.abs(error)),
		uncertainty: 0.1,
		focusState: 'defocused',
		confidence: 1,
		quality: QUALITY,
		warnings: [],
	}
}

test('derives focus circles and error segment from measured geometry', () => {
	const source = analysis()
	const overlay = createBahtinovOverlayGeometry(source)
	expect(overlay.reference).toEqual({ x: 10, y: 10 })
	expect(overlay.centralProjection).toEqual({ x: 7, y: 10 })
	expect(overlay.errorSegment).toEqual([
		{ x: 7, y: 10 },
		{ x: 10, y: 10 },
	])
	expect(overlay.errorCircles.map((circle) => circle.role)).toEqual(['reference', 'centralProjection'])
	expect(overlay.errorCircles[0].radius).toBe(6)
	expect(overlay.errorCircles[1].radius).toBe(6)
	expect(Math.hypot(overlay.reference.x - overlay.centralProjection.x, overlay.reference.y - overlay.centralProjection.y)).toBe(source.absoluteError)
})

test('preserves stable spike roles and copies input geometry', () => {
	const source = analysis(-2)
	const overlay = createBahtinovOverlayGeometry(source, { errorCircleRadius: 3, focusRegionRadius: 8 })
	expect(overlay.spikes.map((spike) => spike.role)).toEqual(['central', 'external0', 'external1'])
	expect(overlay.spikes[0].segment).toEqual(source.centralLine.segment)
	expect(overlay.spikes[0].segment).not.toBe(source.centralLine.segment)
	expect(overlay.spikes[0].segment[0]).not.toBe(source.centralLine.segment[0])
	expect(overlay.area).not.toBe(source.area)
	expect(overlay.reference).not.toBe(source.reference)
	expect(overlay.focusRegionCircle).toEqual({ role: 'focusRegion', center: { x: 10, y: 10 }, radius: 8 })
	expect(overlay.centralProjection).toEqual({ x: 12, y: 10 })
})

test('coincides error circles at perfect focus', () => {
	const overlay = createBahtinovOverlayGeometry(analysis(0))
	expect(overlay.centralProjection).toEqual(overlay.reference)
	expect(overlay.errorCircles[0].center).toEqual(overlay.errorCircles[1].center)
})

test('rejects inconsistent analysis and invalid visual radii', () => {
	const source = analysis()
	expect(() => createBahtinovOverlayGeometry({ ...source, absoluteError: 4 })).toThrow(RangeError)
	expect(() => createBahtinovOverlayGeometry({ ...source, centralLine: { ...source.centralLine, distance: source.centralLine.distance + 1 } })).toThrow(RangeError)
	expect(() => createBahtinovOverlayGeometry({ ...source, externalLines: [{ ...source.externalLines[0], distance: source.externalLines[0].distance + 1 }, source.externalLines[1]] })).toThrow(RangeError)
	expect(() => createBahtinovOverlayGeometry(source, { errorCircleRadius: 0 })).toThrow(RangeError)
	expect(() => createBahtinovOverlayGeometry(source, { focusRegionRadius: 100 })).toThrow(RangeError)
})
