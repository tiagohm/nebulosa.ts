import { describe, expect, test } from 'bun:test'
import { type PlateSolution, plateSolutionFrom } from '../../../src/astrometry/solvers/platesolver'
import { tanProject } from '../../../src/astrometry/wcs/fits.wcs'
import { eraC2s } from '../../../src/astronomy/coordinates/erfa/erfa'
import { geodeticLocation } from '../../../src/astronomy/observer/location'
import { timeYMDHMS } from '../../../src/astronomy/time/time'
import type { FitsHeader } from '../../../src/io/formats/fits/fits'
import { vecAngleUnit } from '../../../src/math/linear-algebra/vec3'
import { arcmin, arcsec, deg } from '../../../src/math/units/angle'
import { mountAdjustmentAxes, type ThreePointPolarAlignmentResult } from '../../../src/observation/alignment/polaralignment'
import { clipPolarAlignmentOverlaySegment, computeThreePointPolarAlignmentOverlay, polarAlignmentReferenceFromPixel, projectPolarAlignmentOverlayPoint } from '../../../src/observation/alignment/polaralignment.overlay'
import { applyInverseMountAdjustment, applyMountAdjustment, celestialPoleVector, decomposePolarErrorGeodesic } from '../../../src/observation/alignment/polaralignment.util'

// Base anisotropic and slightly sheared TAN WCS used by most overlay tests.
const BASE_HEADER = {
	NAXIS: 2,
	NAXIS1: 800,
	NAXIS2: 600,
	CTYPE1: 'RA---TAN',
	CTYPE2: 'DEC--TAN',
	CRPIX1: 400,
	CRPIX2: 300,
	CRVAL1: 120,
	CRVAL2: 30,
	CD1_1: -0.001,
	CD1_2: 0.0001,
	CD2_1: 0.00005,
	CD2_2: 0.0011,
} as const

// Creates a valid plate solution from the base WCS plus explicit keyword overrides.
function makeSolution(overrides: Record<string, number | string> = {}): PlateSolution {
	return makeSolutionFromHeader({ ...BASE_HEADER, ...overrides })
}

// Creates a valid plate solution from a complete synthetic FITS WCS header.
function makeSolutionFromHeader(header: FitsHeader): PlateSolution {
	const solution = plateSolutionFrom(header)
	if (!solution) throw new Error('test WCS must produce a plate solution')
	return solution
}

// Creates a known current pole by inversely applying the correction that should recover the target.
function makeAlignment(latitude: number, azimuth: number = arcmin(6), altitude: number = arcmin(-4)) {
	const location = geodeticLocation(deg(-45), latitude)
	const time = timeYMDHMS(2026, 7, 12, 2, 0, 0)
	time.location = location
	const targetPole = celestialPoleVector(time, location, false)
	const axes = mountAdjustmentAxes(time, location)
	const currentPole = applyInverseMountAdjustment(targetPole, axes.upAxis, axes.eastAxis, azimuth, altitude)
	const result: ThreePointPolarAlignmentResult = { azimuth: 0, altitude: 0, azimuthError: 0, altitudeError: 0, pole: currentPole, azimuthAdjustment: 0, altitudeAdjustment: 0 }
	return { location, time, targetPole, axes, currentPole, result, azimuth, altitude }
}

describe('mount adjustment geometry', () => {
	test('direct and inverse transformations recover arbitrary vectors', () => {
		const alignment = makeAlignment(deg(35), deg(12), deg(-8))
		const vectors = [alignment.targetPole, [0.2, -0.7, 0.68] as const, [-0.8, 0.1, 0.55] as const]

		for (const vector of vectors) {
			const moved = applyMountAdjustment(vector, alignment.axes.upAxis, alignment.axes.eastAxis, alignment.azimuth, alignment.altitude)
			const recovered = applyInverseMountAdjustment(moved, alignment.axes.upAxis, alignment.axes.eastAxis, alignment.azimuth, alignment.altitude)
			expect(vecAngleUnit(vector, recovered)).toBeLessThan(1e-14)
		}
	})

	test('uses the altitude axis carried by the azimuth-rotated base', () => {
		const alignment = makeAlignment(deg(-28), deg(30), deg(20))
		const corrected = applyMountAdjustment(alignment.currentPole, alignment.axes.upAxis, alignment.axes.eastAxis, alignment.azimuth, alignment.altitude)
		expect(vecAngleUnit(corrected, alignment.targetPole)).toBeLessThan(1e-14)
	})

	test('geodesic components preserve the exact total error magnitude', () => {
		const alignment = makeAlignment(deg(42), arcmin(24), arcmin(-15))
		const components = decomposePolarErrorGeodesic(alignment.currentPole, alignment.targetPole, alignment.axes.upAxis, alignment.axes.eastAxis)
		expect(components).toBeDefined()
		if (!components) return
		expect(Math.hypot(components.azimuth, components.altitude)).toBeCloseTo(components.total, 12)
		expect(components.total).toBeCloseTo(vecAngleUnit(alignment.currentPole, alignment.targetPole), 12)
	})

	test('rejects degenerate public adjustment axes', () => {
		expect(() => applyMountAdjustment([1, 0, 0], [0, 0, 0], [0, 1, 0], 0, 0)).toThrow()
		expect(() => applyMountAdjustment([1, 0, 0], [0, 1, 0], [0, 2, 0], 0, 0)).toThrow()
	})
})

describe('pixel geometry', () => {
	const frame = { x: 10, y: 20, width: 100, height: 80 } as const

	test('clips segments with both endpoints outside when they cross the frame', () => {
		const segment = clipPolarAlignmentOverlaySegment({ x: -20, y: 60 }, { x: 140, y: 60 }, frame, 5)
		expect(segment).toBeDefined()
		if (!segment) return
		expect(segment.visible).toBeTrue()
		expect(segment.clipped).toBeTrue()
		expect(segment.from).toEqual({ x: 15, y: 60 })
		expect(segment.to).toEqual({ x: 105, y: 60 })
	})

	test('keeps fully external and zero-length segments finite', () => {
		const outside = clipPolarAlignmentOverlaySegment({ x: -20, y: -20 }, { x: -10, y: -10 }, frame)
		expect(outside?.visible).toBeFalse()
		expect(outside?.direction.x).toBeCloseTo(Math.SQRT1_2, 12)

		const zero = clipPolarAlignmentOverlaySegment({ x: 30, y: 40 }, { x: 30, y: 40 }, frame)
		expect(zero).toMatchObject({ visible: true, clipped: false, length: 0, direction: { x: 0, y: 0 } })
	})

	test('projects off-screen points from an explicit in-frame origin', () => {
		const point = projectPolarAlignmentOverlayPoint({ x: 200, y: 40 }, frame, 5, { x: 25, y: 40 })
		expect(point).toBeDefined()
		if (!point) return
		expect(point.onScreen).toBeFalse()
		expect(point.display).toEqual({ x: 105, y: 40 })
		expect(point.direction).toEqual({ x: 1, y: 0 })
	})

	test('falls back to frame center for an off-screen origin', () => {
		const point = projectPolarAlignmentOverlayPoint({ x: 210, y: 30 }, frame, 5, { x: -100, y: -100 })
		expect(point?.display.x).toBe(105)
		expect(point && Number.isFinite(point.display.y)).toBeTrue()
	})

	test('rejects margins that collapse the drawable frame', () => {
		expect(projectPolarAlignmentOverlayPoint({ x: 20, y: 30 }, frame, 40)).toBeUndefined()
		expect(clipPolarAlignmentOverlaySegment({ x: 20, y: 30 }, { x: 40, y: 50 }, frame, 50)).toBeUndefined()
	})
})

describe('WCS reference', () => {
	test('round-trips a selected pixel through the persistent coordinate', () => {
		const solution = makeSolution()
		const pixel = { x: 517.25, y: 214.75 }
		const reference = polarAlignmentReferenceFromPixel(solution, pixel)
		expect(reference).toBeDefined()
		if (!reference) return
		const projected = tanProject(solution, reference.rightAscension, reference.declination)
		expect(projected?.[0]).toBeCloseTo(pixel.x, 8)
		expect(projected?.[1]).toBeCloseTo(pixel.y, 8)
	})

	test('accepts a projectable pixel outside the image rectangle', () => {
		const reference = polarAlignmentReferenceFromPixel(makeSolution(), { x: 900, y: 300 })
		expect(reference).toBeDefined()
	})
})

describe('complete overlay', () => {
	for (const [name, latitude] of [
		['north', deg(35)],
		['south', deg(-35)],
	] as const) {
		test(`recovers a known combined correction in the ${name}`, () => {
			const alignment = makeAlignment(latitude)
			const solution = makeSolution()
			const computed = computeThreePointPolarAlignmentOverlay(alignment.result, solution, alignment.time, {
				refraction: false,
				reference: { type: 'equatorial', rightAscension: deg(120), declination: deg(30) },
				tolerances: [],
			})
			expect(computed.success).toBeTrue()
			if (!computed.success) return
			expect(computed.overlay.correction.converged).toBeTrue()
			expect(computed.overlay.correction.stable).toBeTrue()
			expect(computed.overlay.correction.azimuth).toBeCloseTo(alignment.azimuth, 10)
			expect(computed.overlay.correction.altitude).toBeCloseTo(alignment.altitude, 10)
			const correctedPole = applyMountAdjustment(alignment.currentPole, alignment.axes.upAxis, alignment.axes.eastAxis, computed.overlay.correction.azimuth, computed.overlay.correction.altitude)
			expect(vecAngleUnit(correctedPole, alignment.targetPole)).toBeLessThan(arcsec(0.05))
		})
	}

	for (const [name, azimuth, altitude] of [
		['azimuth-only', arcmin(12), 0],
		['altitude-only', 0, arcmin(-9)],
		['large-combined', deg(20), deg(-15)],
	] as const) {
		test(`solves ${name} mechanical error`, () => {
			const alignment = makeAlignment(deg(35), azimuth, altitude)
			const computed = computeThreePointPolarAlignmentOverlay(alignment.result, makeSolution(), alignment.time, {
				refraction: false,
				reference: { type: 'equatorial', rightAscension: deg(120), declination: deg(30) },
				tolerances: [],
			})
			expect(computed.success).toBeTrue()
			if (!computed.success) return
			expect(computed.overlay.correction.azimuth).toBeCloseTo(azimuth, 8)
			expect(computed.overlay.correction.altitude).toBeCloseTo(altitude, 8)
			expect(computed.overlay.correction.residual).toBeLessThan(arcsec(0.05))
		})
	}

	test('projects current, azimuth-only, and final positions through the supplied WCS', () => {
		const alignment = makeAlignment(deg(35))
		const solution = makeSolution()
		const computed = computeThreePointPolarAlignmentOverlay(alignment.result, solution, alignment.time, {
			refraction: false,
			reference: { type: 'equatorial', rightAscension: deg(120), declination: deg(30) },
			tolerances: [],
		})
		expect(computed.success).toBeTrue()
		if (!computed.success) return

		const current = tanProject(solution, deg(120), deg(30))
		const targetVector = applyInverseMountAdjustment([Math.cos(deg(30)) * Math.cos(deg(120)), Math.cos(deg(30)) * Math.sin(deg(120)), Math.sin(deg(30))], alignment.axes.upAxis, alignment.axes.eastAxis, computed.overlay.correction.azimuth, computed.overlay.correction.altitude)
		const [targetRa, targetDec] = eraC2s(...targetVector)
		const target = tanProject(solution, targetRa, targetDec)
		expect(computed.overlay.currentPoint.position.x).toBeCloseTo(current![0], 10)
		expect(computed.overlay.currentPoint.position.y).toBeCloseTo(current![1], 10)
		expect(computed.overlay.targetPoint.position.x).toBeCloseTo(target![0], 8)
		expect(computed.overlay.targetPoint.position.y).toBeCloseTo(target![1], 8)
		expect(computed.overlay.path).toHaveLength(3)
	})

	test('uses the geometric image center when the reference is omitted', () => {
		const alignment = makeAlignment(deg(35))
		const solution = makeSolution({ CRPIX1: 360, CRPIX2: 260 })
		const expectedReference = polarAlignmentReferenceFromPixel(solution, { x: solution.widthInPixels * 0.5, y: solution.heightInPixels * 0.5 })
		const computed = computeThreePointPolarAlignmentOverlay(alignment.result, solution, alignment.time, { refraction: false, tolerances: [] })
		expect(computed.success).toBeTrue()
		if (!computed.success) return
		expect(computed.overlay.reference.rightAscension).toBeCloseTo(expectedReference!.rightAscension, 12)
		expect(computed.overlay.reference.declination).toBeCloseTo(expectedReference!.declination, 12)
		expect(computed.overlay.currentPoint.position.x).toBeCloseTo(solution.widthInPixels * 0.5, 8)
		expect(computed.overlay.currentPoint.position.y).toBeCloseTo(solution.heightInPixels * 0.5, 8)
	})

	test('generates finite explicitly closed spherical tolerance contours', () => {
		const alignment = makeAlignment(deg(35))
		const computed = computeThreePointPolarAlignmentOverlay(alignment.result, makeSolution(), alignment.time, {
			refraction: false,
			reference: { type: 'equatorial', rightAscension: deg(120), declination: deg(30) },
			tolerances: [arcmin(1), arcmin(3)],
			samples: 16,
		})
		expect(computed.success).toBeTrue()
		if (!computed.success) return
		expect(computed.overlay.contours).toHaveLength(2)
		for (const contour of computed.overlay.contours) {
			expect(contour.points).toHaveLength(17)
			expect(contour.points.at(-1)).toEqual(contour.points[0])
			expect(contour.closed).toBeTrue()
			expect(contour.bounds.width).toBeGreaterThan(0)
			expect(contour.bounds.height).toBeGreaterThan(0)
			for (const point of contour.points) expect(Number.isFinite(point.x) && Number.isFinite(point.y)).toBeTrue()
		}
	})

	test('omits a whole non-projectable contour with deterministic diagnostics', () => {
		const alignment = makeAlignment(deg(35))
		const tolerance = deg(100)
		const computed = computeThreePointPolarAlignmentOverlay(alignment.result, makeSolution(), alignment.time, {
			refraction: false,
			reference: { type: 'equatorial', rightAscension: deg(120), declination: deg(30) },
			tolerances: [tolerance],
			samples: 12,
		})
		expect(computed.success).toBeTrue()
		if (!computed.success) return
		expect(computed.overlay.contours).toHaveLength(0)
		expect(computed.overlay.diagnostics.omittedTolerances).toEqual([tolerance])
		expect(computed.overlay.diagnostics.warnings).toContain('contourOmitted')
	})

	test('supports mirrored sheared TAN-SIP WCS without scale shortcuts', () => {
		const alignment = makeAlignment(deg(-30), arcmin(3), arcmin(2))
		const solution = makeSolution({
			CTYPE1: 'RA---TAN-SIP',
			CTYPE2: 'DEC--TAN-SIP',
			CD1_1: 0.001,
			CD1_2: 0.0002,
			CD2_1: 0.0001,
			CD2_2: 0.0012,
			A_ORDER: 2,
			B_ORDER: 2,
			A_2_0: 1e-6,
			A_1_1: -2e-6,
			B_0_2: -1e-6,
			B_1_1: 1e-6,
		})
		const computed = computeThreePointPolarAlignmentOverlay(alignment.result, solution, alignment.time, {
			refraction: false,
			reference: { type: 'pixel', point: { x: 350, y: 280 } },
			tolerances: [arcmin(1)],
			samples: 16,
		})
		expect(computed.success).toBeTrue()
		if (!computed.success) return
		expect(computed.overlay.reference).toEqual(polarAlignmentReferenceFromPixel(solution, { x: 350, y: 280 })!)
		expect(computed.overlay.contours).toHaveLength(1)
	})

	test('uses complete PC, CROTA, and LONPOLE WCS encodings', () => {
		const alignment = makeAlignment(deg(25), arcmin(2), arcmin(-1))
		const common = { NAXIS: 2, NAXIS1: 800, NAXIS2: 600, CTYPE1: 'RA---TAN', CTYPE2: 'DEC--TAN', CRPIX1: 400, CRPIX2: 300, CRVAL1: 120, CRVAL2: 30 } as const
		const rotation = deg(23)
		const solutions = [
			makeSolutionFromHeader({ ...common, CDELT1: -0.001, CDELT2: 0.0012, PC1_1: Math.cos(rotation), PC1_2: -Math.sin(rotation), PC2_1: Math.sin(rotation), PC2_2: Math.cos(rotation) }),
			makeSolutionFromHeader({ ...common, CDELT1: -0.001, CDELT2: 0.0012, CROTA2: 17 }),
			makeSolutionFromHeader({ ...common, CD1_1: -0.001, CD1_2: 0.0001, CD2_1: 0.00005, CD2_2: 0.0011, LONPOLE: 90 }),
		]

		for (const solution of solutions) {
			const computed = computeThreePointPolarAlignmentOverlay(alignment.result, solution, alignment.time, {
				refraction: false,
				reference: { type: 'equatorial', rightAscension: deg(120), declination: deg(30) },
				tolerances: [],
			})
			expect(computed.success).toBeTrue()
			if (!computed.success) continue
			const direct = tanProject(solution, computed.overlay.reference.rightAscension, computed.overlay.reference.declination)
			expect(computed.overlay.currentPoint.position.x).toBeCloseTo(direct![0], 10)
			expect(computed.overlay.currentPoint.position.y).toBeCloseTo(direct![1], 10)
		}
	})

	test('keeps an off-screen target on the border and clips the total segment to it', () => {
		const alignment = makeAlignment(deg(35), arcmin(30), arcmin(-20))
		const solution = makeSolution({ NAXIS1: 120, NAXIS2: 80, CRPIX1: 60, CRPIX2: 40 })
		const computed = computeThreePointPolarAlignmentOverlay(alignment.result, solution, alignment.time, {
			refraction: false,
			reference: { type: 'equatorial', rightAscension: deg(120), declination: deg(30) },
			tolerances: [],
			margin: 4,
		})
		expect(computed.success).toBeTrue()
		if (!computed.success) return
		expect(computed.overlay.currentPoint.onScreen).toBeTrue()
		expect(computed.overlay.targetPoint.onScreen).toBeFalse()
		expect(computed.overlay.totalSegment.visible).toBeTrue()
		expect(computed.overlay.totalSegment.clipped).toBeTrue()
		expect(computed.overlay.totalSegment.to.x).toBeCloseTo(computed.overlay.targetPoint.display.x, 10)
		expect(computed.overlay.totalSegment.to.y).toBeCloseTo(computed.overlay.targetPoint.display.y, 10)
		expect(Math.hypot(computed.overlay.targetPoint.direction.x, computed.overlay.targetPoint.direction.y)).toBeCloseTo(1, 12)
	})

	test('returns the best stable correction with a deterministic non-convergence warning', () => {
		const alignment = makeAlignment(deg(35))
		const computed = computeThreePointPolarAlignmentOverlay(alignment.result, makeSolution(), alignment.time, {
			refraction: false,
			reference: { type: 'equatorial', rightAscension: deg(120), declination: deg(30) },
			tolerances: [],
			maximumIterations: 1,
			correctionTolerance: 1e-20,
		})
		expect(computed.success).toBeTrue()
		if (!computed.success) return
		expect(computed.overlay.correction.stable).toBeTrue()
		expect(computed.overlay.correction.converged).toBeFalse()
		expect(computed.overlay.diagnostics.warnings).toContain('correctionNotConverged')
	})

	test('returns discriminated failures for missing context and invalid geometry', () => {
		const alignment = makeAlignment(deg(35))
		const timeWithoutLocation = timeYMDHMS(2026, 7, 12, 2, 0, 0)
		expect(computeThreePointPolarAlignmentOverlay(alignment.result, makeSolution(), timeWithoutLocation, { tolerances: [] })).toMatchObject({ success: false, reason: 'missingLocation' })
		expect(computeThreePointPolarAlignmentOverlay(alignment.result, makeSolution(), alignment.time, { margin: 300, tolerances: [] })).toMatchObject({ success: false, reason: 'invalidFrame' })
		expect(computeThreePointPolarAlignmentOverlay({ ...alignment.result, pole: [0, 0, 0] }, makeSolution(), alignment.time, { tolerances: [] })).toMatchObject({ success: false, reason: 'invalidPole' })
		expect(computeThreePointPolarAlignmentOverlay(alignment.result, makeSolution(), alignment.time, { reference: { type: 'equatorial', rightAscension: 0, declination: Math.PI }, tolerances: [] })).toMatchObject({ success: false, reason: 'invalidReference' })

		const antipodalPole = [-alignment.targetPole[0], -alignment.targetPole[1], -alignment.targetPole[2]] as const
		expect(computeThreePointPolarAlignmentOverlay({ ...alignment.result, pole: antipodalPole }, makeSolution(), alignment.time, { refraction: false, tolerances: [] })).toMatchObject({ success: false, reason: 'degenerateCorrection' })

		const invalidWcs = { ...makeSolution(), CD1_1: 1, CD1_2: 2, CD2_1: 1, CD2_2: 2 }
		expect(computeThreePointPolarAlignmentOverlay(alignment.result, invalidWcs, alignment.time, { tolerances: [] })).toMatchObject({ success: false, reason: 'invalidWcs' })
	})

	test('does not mutate result, WCS, reference, options, or tolerance arrays', () => {
		const alignment = makeAlignment(deg(35))
		const solution = Object.freeze(makeSolution())
		const reference = Object.freeze({ type: 'equatorial' as const, rightAscension: deg(120), declination: deg(30) })
		const tolerances = Object.freeze([arcmin(1)])
		const options = Object.freeze({ refraction: false as const, reference, tolerances, samples: 16 })
		const result = Object.freeze({ ...alignment.result, pole: Object.freeze([...alignment.result.pole] as [number, number, number]) })
		const before = JSON.stringify({ result, solution, reference, options })
		const computed = computeThreePointPolarAlignmentOverlay(result, solution, alignment.time, options)
		expect(computed.success).toBeTrue()
		expect(JSON.stringify({ result, solution, reference, options })).toBe(before)
	})
})
