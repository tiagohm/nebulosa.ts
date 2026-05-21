import { describe, expect, test } from 'bun:test'
import { DEG2RAD } from '../src/constants'
import { nearestSolarEclipse } from '../src/sun'
import { generateBesselianElements } from '../src/sun.eclipse.besselian'
import { buildEclipseLocalGrid, generateEclipseIsoCurves, generateEclipseIsoCurvesFromGrid, type EclipseGridSample, type EclipseIsoCurveSegment } from '../src/sun.eclipse.isocurves'
import { timeYMD } from '../src/time'

const total2024 = generateBesselianElements({ maximumApprox: nearestSolarEclipse(timeYMD(2024, 3, 1), true).maximalTime })
const partial2025 = generateBesselianElements({ maximumApprox: nearestSolarEclipse(timeYMD(2025, 9, 21), true).maximalTime })

function syntheticGrid(latitudeMinDeg: number, latitudeMaxDeg: number, longitudeMinDeg: number, longitudeMaxDeg: number, gridResolutionDeg: number, value: (latitudeDeg: number, longitudeDeg: number) => Partial<EclipseGridSample>) {
	const samples: EclipseGridSample[] = []

	for (let latitudeDeg = latitudeMinDeg; latitudeDeg <= latitudeMaxDeg + gridResolutionDeg * 1e-12; latitudeDeg += gridResolutionDeg) {
		for (let longitudeDeg = longitudeMinDeg; longitudeDeg <= longitudeMaxDeg + gridResolutionDeg * 1e-12; longitudeDeg += gridResolutionDeg) {
			const fields = value(latitudeDeg, longitudeDeg)
			const eclipseType = fields.eclipseType ?? ((fields.magnitude ?? 0) > 0 ? 'partial' : 'none')

			samples.push({
				latitude: latitudeDeg * DEG2RAD,
				longitude: longitudeDeg * DEG2RAD,
				magnitude: fields.magnitude ?? 0,
				obscuration: fields.obscuration ?? 0,
				partialDurationSeconds: fields.partialDurationSeconds ?? null,
				totalOrAnnularDurationSeconds: fields.totalOrAnnularDurationSeconds ?? null,
				eclipseType,
				maximumTime: fields.maximumTime ?? null,
				solarAltitudeAtMaximum: fields.solarAltitudeAtMaximum ?? 1,
				visible: fields.visible ?? true,
				valid: fields.valid ?? true,
			})
		}
	}

	return samples
}

function syntheticOptions(latitudeMinDeg: number, latitudeMaxDeg: number, longitudeMinDeg: number, longitudeMaxDeg: number, gridResolutionDeg: number) {
	return { latitudeMinDeg, latitudeMaxDeg, longitudeMinDeg, longitudeMaxDeg, gridResolutionDeg }
}

function segmentPointCount(segments: readonly EclipseIsoCurveSegment[]) {
	return segments.reduce((sum, segment) => sum + segment.points.length, 0)
}

function maxLongitudeJump(segments: readonly EclipseIsoCurveSegment[]) {
	let max = 0

	for (const segment of segments) {
		for (let i = 1; i < segment.points.length; i++) {
			max = Math.max(max, Math.abs(segment.points[i].longitude - segment.points[i - 1].longitude))
		}
	}

	return max
}

function expectFiniteSegments(segments: readonly EclipseIsoCurveSegment[]) {
	for (const segment of segments) {
		for (const point of segment.points) {
			expect(point.latitude).toBeFinite()
			expect(Math.abs(point.latitude)).toBeLessThanOrEqual(Math.PI / 2)
			expect(point.longitude).toBeFinite()
			expect(point.longitude).toBeGreaterThanOrEqual(-Math.PI)
			expect(point.longitude).toBeLessThanOrEqual(Math.PI)
		}
	}
}

describe('eclipse local grid', () => {
	test('builds grid samples with normalized coordinates and no-eclipse values', () => {
		const grid = buildEclipseLocalGrid(total2024, { gridResolutionDeg: 30 })

		expect(grid).toHaveLength(84)
		expect(grid.some((sample) => sample.eclipseType === 'none')).toBeTrue()
		expect(grid.some((sample) => sample.magnitude === 0 && sample.obscuration === 0)).toBeTrue()
		expect(grid.every((sample) => sample.latitude >= -Math.PI / 2 && sample.latitude <= Math.PI / 2)).toBeTrue()
		expect(grid.every((sample) => sample.longitude >= -Math.PI && sample.longitude <= Math.PI)).toBeTrue()
		expect(grid.every((sample) => sample.valid)).toBeTrue()
	})

	test('visibleOnly and horizon options mark invisible eclipse samples invalid', () => {
		const geometric = buildEclipseLocalGrid(total2024, { gridResolutionDeg: 30, visibleOnly: false })
		const visible = buildEclipseLocalGrid(total2024, { gridResolutionDeg: 30, visibleOnly: true })
		const ignored = buildEclipseLocalGrid(total2024, { gridResolutionDeg: 30, visibleOnly: true, ignoreSunBelowHorizon: true })

		expect(geometric.some((sample) => sample.eclipseType !== 'none' && !sample.visible)).toBeTrue()
		expect(visible.some((sample) => !sample.valid)).toBeTrue()
		expect(ignored.every((sample) => sample.valid)).toBeTrue()
	})

	test('keeps total or annular duration restricted to central eclipse samples', () => {
		const grid = buildEclipseLocalGrid(total2024, { gridResolutionDeg: 20 })
		const central = grid.filter((sample) => (sample.totalOrAnnularDurationSeconds ?? 0) > 0)

		expect(central.length).toBeGreaterThan(0)
		expect(central.every((sample) => sample.eclipseType === 'total' || sample.eclipseType === 'annular' || sample.eclipseType === 'hybrid')).toBeTrue()
	})
})

describe('eclipse iso-curves from Besselian elements', () => {
	test('generates multiple levels from one sampled grid', () => {
		const curves = generateEclipseIsoCurves(
			total2024,
			[
				{ type: 'magnitude', value: 0.5 },
				{ type: 'obscuration', value: 0.5 },
				{ type: 'partialDuration', value: 3600, unit: 'seconds' },
			],
			{ gridResolutionDeg: 30 },
		)

		expect(curves).toHaveLength(3)
		expect(curves.every((curve) => curve.metadata?.sampleCount === 84)).toBeTrue()
		expect(curves.every((curve) => curve.metadata?.gridResolutionDegrees === 30)).toBeTrue()
		expect(curves[0].segments.length).toBeGreaterThan(0)
		expect(curves[1].segments.length).toBeGreaterThan(0)
		expect(curves[2].segments.length).toBeGreaterThan(0)
		for (const curve of curves) expectFiniteSegments(curve.segments)
	})

	test('supports partial-only eclipse magnitude and partial-duration curves', () => {
		const curves = generateEclipseIsoCurves(
			partial2025,
			[
				{ type: 'magnitude', value: 0.5 },
				{ type: 'partialDuration', value: 3600, unit: 'seconds' },
				{ type: 'totalOrAnnularDuration', value: 60, unit: 'seconds' },
			],
			{ gridResolutionDeg: 30 },
		)

		expect(nearestSolarEclipse(timeYMD(2025, 9, 21), true).type).toBe('partial')
		expect(curves[0].segments.length).toBeGreaterThan(0)
		expect(curves[1].segments.length).toBeGreaterThan(0)
		expect(curves[2].segments).toHaveLength(0)
	})

	test('visible-only contours remove below-horizon geometric regions', () => {
		const geometric = generateEclipseIsoCurves(total2024, [{ type: 'magnitude', value: 0.2 }], { gridResolutionDeg: 30, visibleOnly: false })
		const visible = generateEclipseIsoCurves(total2024, [{ type: 'magnitude', value: 0.2 }], { gridResolutionDeg: 30, visibleOnly: true })
		const ignored = generateEclipseIsoCurves(total2024, [{ type: 'magnitude', value: 0.2 }], { gridResolutionDeg: 30, visibleOnly: true, ignoreSunBelowHorizon: true })

		expect(segmentPointCount(visible[0].segments)).toBeLessThan(segmentPointCount(geometric[0].segments))
		expect(segmentPointCount(ignored[0].segments)).toBe(segmentPointCount(geometric[0].segments))
		expect(visible[0].visibilityMode).toBe('visibleOnly')
	})

	test('validates levels and grid options', () => {
		expect(() => generateEclipseIsoCurves(total2024, [{ type: 'obscuration', value: 2 }], { gridResolutionDeg: 30 })).toThrow('obscuration')
		expect(() => generateEclipseIsoCurves(total2024, [{ type: 'magnitude', value: 0.5 }], { gridResolutionDeg: 0 })).toThrow('value must be positive')
		expect(() => generateEclipseIsoCurves(total2024, [{ type: 'partialDuration', value: 60, unit: 'fraction' }], { gridResolutionDeg: 30 })).toThrow('partialDuration')
	})
})

describe('synthetic iso-curve contouring', () => {
	test('extracts a closed magnitude loop from a synthetic scalar field', () => {
		const options = syntheticOptions(-2, 2, -2, 2, 1)
		const samples = syntheticGrid(-2, 2, -2, 2, 1, (latitude, longitude) => ({ magnitude: 4 - latitude * latitude - longitude * longitude }))
		const [curve] = generateEclipseIsoCurvesFromGrid(samples, [{ type: 'magnitude', value: 2 }], options)

		expect(curve.segments.length).toBeGreaterThan(0)
		expect(curve.segments.some((segment) => segment.closed)).toBeTrue()
		expectFiniteSegments(curve.segments)
	})

	test('keeps magnitude and obscuration as distinct fields', () => {
		const options = syntheticOptions(0, 2, 0, 2, 1)
		const samples = syntheticGrid(0, 2, 0, 2, 1, (latitude, longitude) => ({ magnitude: longitude, obscuration: latitude / 2 }))
		const curves = generateEclipseIsoCurvesFromGrid(
			samples,
			[
				{ type: 'magnitude', value: 1 },
				{ type: 'obscuration', value: 0.5 },
			],
			options,
		)

		const magnitudePoints = curves[0].segments.flatMap((segment) => segment.points)
		const obscurationPoints = curves[1].segments.flatMap((segment) => segment.points)
		const magnitudeLongitudeSpread = Math.max(...magnitudePoints.map((point) => point.longitude)) - Math.min(...magnitudePoints.map((point) => point.longitude))
		const magnitudeLatitudeSpread = Math.max(...magnitudePoints.map((point) => point.latitude)) - Math.min(...magnitudePoints.map((point) => point.latitude))
		const obscurationLongitudeSpread = Math.max(...obscurationPoints.map((point) => point.longitude)) - Math.min(...obscurationPoints.map((point) => point.longitude))
		const obscurationLatitudeSpread = Math.max(...obscurationPoints.map((point) => point.latitude)) - Math.min(...obscurationPoints.map((point) => point.latitude))

		expect(magnitudeLongitudeSpread).toBeLessThan(magnitudeLatitudeSpread)
		expect(obscurationLatitudeSpread).toBeLessThan(obscurationLongitudeSpread)
	})

	test('extracts duration curves only through finite duration samples', () => {
		const options = syntheticOptions(0, 3, 0, 3, 1)
		const samples = syntheticGrid(0, 3, 0, 3, 1, (latitude, longitude) => ({
			partialDurationSeconds: latitude >= 1 && longitude >= 1 ? latitude * longitude * 1000 : null,
		}))
		const [curve] = generateEclipseIsoCurvesFromGrid(samples, [{ type: 'partialDuration', value: 2500, unit: 'seconds' }], options)

		expect(curve.segments.length).toBeGreaterThan(0)
		expectFiniteSegments(curve.segments)
	})

	test('handles ambiguous marching-squares cells deterministically', () => {
		const options = syntheticOptions(0, 1, 0, 1, 1)
		const samples = syntheticGrid(0, 1, 0, 1, 1, (latitude, longitude) => ({ magnitude: latitude === longitude ? 1 : 0 }))
		const [curve] = generateEclipseIsoCurvesFromGrid(samples, [{ type: 'magnitude', value: 0.5 }], { ...options, minSegmentPoints: 2 })

		expect(curve.segments).toHaveLength(2)
		expect(curve.segments.every((segment) => segment.points.length === 2)).toBeTrue()
	})

	test('supports multiple disconnected contour segments', () => {
		const options = syntheticOptions(-3, 3, -3, 3, 1)
		const samples = syntheticGrid(-3, 3, -3, 3, 1, (_latitude, longitude) => ({
			magnitude: Math.max(0, 2 - Math.abs(longitude - 2), 2 - Math.abs(longitude + 2)),
		}))
		const [curve] = generateEclipseIsoCurvesFromGrid(samples, [{ type: 'magnitude', value: 1.5 }], options)

		expect(curve.segments.length).toBeGreaterThanOrEqual(2)
	})

	test('splits antimeridian jumps and can preserve unsplit wrapped topology', () => {
		const split = generateEclipseIsoCurves(total2024, [{ type: 'magnitude', value: 0.2 }], { gridResolutionDeg: 30, splitAntimeridian: true })
		const unsplit = generateEclipseIsoCurves(total2024, [{ type: 'magnitude', value: 0.2 }], { gridResolutionDeg: 30, splitAntimeridian: false })

		expect(maxLongitudeJump(split[0].segments)).toBeLessThan(Math.PI)
		expect(maxLongitudeJump(unsplit[0].segments)).toBeGreaterThan(Math.PI)
	})

	test('removes tiny or underpopulated segments when requested', () => {
		const options = syntheticOptions(0, 1, 0, 1, 1)
		const samples = syntheticGrid(0, 1, 0, 1, 1, (latitude, longitude) => ({ magnitude: latitude === longitude ? 1 : 0 }))
		const [curve] = generateEclipseIsoCurvesFromGrid(samples, [{ type: 'magnitude', value: 0.5 }], { ...options, minSegmentPoints: 3, removeTinySegments: true })

		expect(curve.segments).toHaveLength(0)
	})

	test('resamples segment geometry without changing the level metadata', () => {
		const options = syntheticOptions(-2, 2, -2, 2, 1)
		const samples = syntheticGrid(-2, 2, -2, 2, 1, (latitude, longitude) => ({ magnitude: 4 - latitude * latitude - longitude * longitude }))
		const [raw] = generateEclipseIsoCurvesFromGrid(samples, [{ type: 'magnitude', value: 2 }], options)
		const [resampled] = generateEclipseIsoCurvesFromGrid(samples, [{ type: 'magnitude', value: 2 }], { ...options, smoothing: 'resample', resampleMaxStepDegrees: 0.25 })

		expect(segmentPointCount(resampled.segments)).toBeGreaterThan(segmentPointCount(raw.segments))
		expect(resampled.level.value).toBe(raw.level.value)
	})
})
