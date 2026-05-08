import { describe, expect, test } from 'bun:test'
import { angularDistance } from '../src/coordinate'
import { nearestSolarEclipse } from '../src/sun'
import { generateBesselianElements } from '../src/sun.besselian'
import { type ContourPoint, generateGlobalPartialContactCurves, generatePenumbraContourAt } from '../src/sun.eclipse.curves.partial'
import { timeShift, timeYMD } from '../src/time'

const total2024 = generateBesselianElements({ maximumApprox: nearestSolarEclipse(timeYMD(2024, 3, 1), true).maximalTime })
const annular2024 = generateBesselianElements({ maximumApprox: nearestSolarEclipse(timeYMD(2024, 4, 9), true).maximalTime })
const partial2025 = generateBesselianElements({ maximumApprox: nearestSolarEclipse(timeYMD(2025, 9, 21), true).maximalTime })
const hybrid2023 = generateBesselianElements({ maximumApprox: nearestSolarEclipse(timeYMD(2023, 1, 1), true).maximalTime })

function contactOptions(elements: typeof total2024) {
	return {
		startTime: elements.validFrom,
		endTime: elements.validTo,
		gridResolutionDeg: 30,
		temporalTolerance: 600,
		includeDiagnostics: true,
	}
}

function expectFinitePoint(point: ContourPoint) {
	expect(point.lat).toBeFinite()
	expect(Math.abs(point.lat)).toBeLessThanOrEqual(Math.PI / 2)
	expect(point.lon).toBeFinite()
	expect(point.lon).toBeGreaterThanOrEqual(-Math.PI)
	expect(point.lon).toBeLessThanOrEqual(Math.PI)
	if (point.time) {
		expect(point.time.day).toBeFinite()
		expect(point.time.fraction).toBeFinite()
	}
	if (point.solarAltitude !== undefined) expect(point.solarAltitude).toBeFinite()
}

function maxLongitudeJump(segments?: readonly (readonly ContourPoint[])[]) {
	let max = 0

	for (const segment of segments ?? []) {
		for (let i = 1; i < segment.length; i++) {
			max = Math.max(max, Math.abs(segment[i].lon - segment[i - 1].lon))
		}
	}

	return max
}

function maxAngularGap(segments?: readonly (readonly ContourPoint[])[]) {
	let max = 0

	for (const segment of segments ?? []) {
		for (let i = 1; i < segment.length; i++) {
			max = Math.max(max, angularDistance(segment[i - 1].lon, segment[i - 1].lat, segment[i].lon, segment[i].lat))
		}
	}

	return max
}

describe('global partial solar eclipse contact curves', () => {
	test('generates P1 and P4 curves for a known total eclipse', () => {
		const curves = generateGlobalPartialContactCurves(total2024, contactOptions(total2024))

		expect(curves.map((curve) => curve.type)).toEqual(['P1', 'P4'])
		expect(curves.every((curve) => curve.points.length > 0)).toBeTrue()
		expect(curves.every((curve) => curve.segments!.length > 0)).toBeTrue()
		expect(curves.every((curve) => curve.diagnostics!.gridRows === 7 && curve.diagnostics!.gridColumns === 12)).toBeTrue()
		expect(curves.every((curve) => curve.diagnostics!.evaluatedNodes === 84)).toBeTrue()

		for (const curve of curves) for (const point of curve.points) expectFinitePoint(point)
	})

	test('supports partial-only eclipses without requiring a central line', () => {
		const curves = generateGlobalPartialContactCurves(partial2025, contactOptions(partial2025))

		expect(nearestSolarEclipse(timeYMD(2025, 9, 21), true).type).toBe('PARTIAL')
		expect(curves).toHaveLength(2)
		expect(curves.every((curve) => curve.points.length > 0)).toBeTrue()
		expect(curves.every((curve) => curve.points.every((point) => point.time))).toBeTrue()
	})

	test('handles high-latitude contact curves', () => {
		const curves = generateGlobalPartialContactCurves(annular2024, contactOptions(annular2024))
		const points = curves.flatMap((curve) => curve.points)

		expect(points.some((point) => Math.abs(point.lat) > 1.4)).toBeTrue()
		for (const point of points) expectFinitePoint(point)
	})

	test('visibleOnly false preserves below-horizon geometry and visibleOnly true filters it', () => {
		const geometric = generateGlobalPartialContactCurves(total2024, {
			...contactOptions(total2024),
			considerSolarHorizon: true,
			visibleOnly: false,
		})
		const visible = generateGlobalPartialContactCurves(total2024, {
			...contactOptions(total2024),
			considerSolarHorizon: true,
			visibleOnly: true,
		})

		expect(geometric.some((curve) => curve.points.some((point) => point.belowHorizon))).toBeTrue()
		expect(visible[0].points.length).toBeLessThan(geometric[0].points.length)
		expect(visible[1].points.length).toBeLessThan(geometric[1].points.length)
		expect(visible.every((curve) => curve.points.every((point) => point.visible && !point.belowHorizon))).toBeTrue()
	})

	test('splits antimeridian jumps when requested', () => {
		const split = generateGlobalPartialContactCurves(hybrid2023, { ...contactOptions(hybrid2023), splitAtAntimeridian: true })
		const unsplit = generateGlobalPartialContactCurves(hybrid2023, { ...contactOptions(hybrid2023), splitAtAntimeridian: false })

		expect(split.every((curve) => maxLongitudeJump(curve.segments) < Math.PI)).toBeTrue()
		expect(unsplit.some((curve) => maxLongitudeJump(curve.segments) > Math.PI)).toBeTrue()
	})

	test('coarse grid output remains stable and finite', () => {
		const curves = generateGlobalPartialContactCurves(total2024, {
			startTime: total2024.validFrom,
			endTime: total2024.validTo,
			gridResolutionDeg: 45,
			temporalTolerance: 900,
		})

		expect(curves).toHaveLength(2)
		expect(curves.every((curve) => curve.points.length > 0)).toBeTrue()
		expect(curves.every((curve) => maxAngularGap(curve.segments) <= Math.PI)).toBeTrue()
		for (const curve of curves) for (const point of curve.points) expectFinitePoint(point)
	})

	test('validates invalid intervals and grid sizes', () => {
		expect(() => generateGlobalPartialContactCurves(total2024, { startTime: total2024.validTo, endTime: total2024.validFrom })).toThrow('endTime must be after startTime')
		expect(() => generateGlobalPartialContactCurves(total2024, { ...contactOptions(total2024), gridResolutionDeg: 0 })).toThrow('grid resolution')
	})
})

describe('instantaneous penumbra contours', () => {
	test('returns closed contours at a valid eclipse time', () => {
		const contours = generatePenumbraContourAt(total2024, total2024.geocentricMaximum, { angularSamplingDeg: 30, includeDiagnostics: true })

		expect(contours.length).toBeGreaterThan(0)
		expect(contours.some((contour) => contour.closed)).toBeTrue()
		expect(contours.every((contour) => contour.diagnostics!.evaluatedNodes === 84)).toBeTrue()
		for (const contour of contours) for (const point of contour.points) expectFinitePoint(point)
	})

	test('returns no contour outside the eclipse interval', () => {
		const contours = generatePenumbraContourAt(total2024, timeShift(total2024.validFrom, -1), { angularSamplingDeg: 30 })

		expect(contours).toHaveLength(0)
	})

	test('splits instantaneous contours at the antimeridian', () => {
		const time = timeShift(hybrid2023.geocentricMaximum, -1 / 24)
		const split = generatePenumbraContourAt(hybrid2023, time, { angularSamplingDeg: 30, splitAtAntimeridian: true })
		const unsplit = generatePenumbraContourAt(hybrid2023, time, { angularSamplingDeg: 30, splitAtAntimeridian: false })

		expect(split.every((contour) => maxLongitudeJump(contour.segments) < Math.PI)).toBeTrue()
		expect(unsplit.some((contour) => maxLongitudeJump(contour.segments) > Math.PI)).toBeTrue()
	})

	test('visibleOnly filters below-horizon instantaneous contour points', () => {
		const geometric = generatePenumbraContourAt(total2024, total2024.geocentricMaximum, {
			angularSamplingDeg: 30,
			considerSolarHorizon: true,
			visibleOnly: false,
		})
		const visible = generatePenumbraContourAt(total2024, total2024.geocentricMaximum, {
			angularSamplingDeg: 30,
			considerSolarHorizon: true,
			visibleOnly: true,
		})

		expect(geometric.some((contour) => contour.points.some((point) => point.belowHorizon))).toBeTrue()
		expect(visible.every((contour) => contour.points.every((point) => point.visible && !point.belowHorizon))).toBeTrue()
	})

	test('discards degenerate contours below the configured segment length', () => {
		const contours = generatePenumbraContourAt(total2024, total2024.geocentricMaximum, { angularSamplingDeg: 30, minSegmentPoints: 100 })

		expect(contours).toHaveLength(0)
	})
})
