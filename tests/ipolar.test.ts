import { expect, test } from 'bun:test'
import { deg, toDeg } from '../src/angle'
import { eraC2s } from '../src/erfa'
import type { FitsHeader } from '../src/fits'
import { celestialPoleVector, IPolarPolarAlignment, projectGuidePoint, solveSimilarityFixedPoint } from '../src/ipolar'
import { geodeticLocation } from '../src/location'
import type { PlateSolution } from '../src/platesolver'
import { plateSolutionFrom } from '../src/platesolver'
import { timeYMDHMS } from '../src/time'
import { type Vec3, vecCross, vecDot, vecNormalizeMut, vecRotateByRodrigues } from '../src/vec3'

test('solve similarity fixed point', () => {
	const transform = { a: Math.cos(deg(5)), b: Math.sin(deg(5)), tx: 12, ty: -8, mirrored: false } as const
	const fixed = solveSimilarityFixedPoint(transform)
	expect(fixed).not.toBeFalse()
	if (!fixed) return
	const x = transform.a * fixed.x - transform.b * fixed.y + transform.tx
	const y = transform.b * fixed.x + transform.a * fixed.y + transform.ty
	expect(x).toBeCloseTo(fixed.x, 8)
	expect(y).toBeCloseTo(fixed.y, 8)
})

test('project guide point clamps off-screen points to the border', () => {
	const guide = projectGuidePoint({ x: 1600, y: -200 }, 800, 600, 20)
	expect(guide.onScreen).toBeFalse()
	expect(guide.clamped.x).toBeGreaterThanOrEqual(20)
	expect(guide.clamped.x).toBeLessThanOrEqual(780)
	expect(guide.clamped.y).toBeGreaterThanOrEqual(20)
	expect(guide.clamped.y).toBeLessThanOrEqual(580)
	expect(Math.hypot(guide.arrow.x, guide.arrow.y)).toBeCloseTo(1, 8)
})

test('ipolar engine calibrates and tracks refinement', () => {
	const location = geodeticLocation(deg(-70), deg(35))
	const t1 = timeYMDHMS(2025, 5, 20, 5, 5, 29)
	const t2 = timeYMDHMS(2025, 5, 20, 5, 5, 49)
	const t3 = timeYMDHMS(2025, 5, 20, 5, 6, 9)
	const t4 = timeYMDHMS(2025, 5, 20, 5, 6, 29)
	t1.location = location
	t2.location = location
	t3.location = location
	t4.location = location

	const pole = celestialPoleVector(t1, location, 'north', false)
	const misalignmentAxis = vecNormalizeMut(vecCross([0, 1, 0], pole))
	const axis0 = vecRotateByRodrigues(pole, misalignmentAxis, deg(0.45))
	const axis1 = vecRotateByRodrigues(pole, misalignmentAxis, deg(0.18))
	const axis2 = pole
	const geometry = syntheticGeometry(axis0)

	const frame1 = syntheticFrame(geometry, axis0, misalignmentAxis, 0)
	const frame2 = syntheticFrame(geometry, axis0, misalignmentAxis, deg(24))
	const frame3 = syntheticFrame(geometry, axis1, misalignmentAxis, deg(24))
	const frame4 = syntheticFrame(geometry, axis2, misalignmentAxis, deg(24))

	const engine = new IPolarPolarAlignment({ refraction: false, minimumAcceptedRaRotation: deg(0.1), completionThreshold: deg(0.65) })
	const r1 = engine.start({ time: t1, solution: frame1 })
	expect(r1.stage).toBe('WAITING_FOR_POSITION_2')

	const r2 = engine.confirm({ time: t2, solution: frame2 })
	expect(r2.stage).toBe('INITIAL_AXIS_ESTIMATION')
	expect(r2.totalError).toBeGreaterThan(deg(0.2))
	expect(r2.currentPoint.onScreen).toBeTrue()

	const r3 = engine.update({ time: t3, solution: frame3 })
	expect(r3.stage).toBe('REFINEMENT')
	expect(r3.totalError).toBeLessThan(r2.totalError)
	expect(r3.currentPoint.x).toBeCloseTo(r2.currentPoint.x, 6)
	expect(r3.currentPoint.y).toBeCloseTo(r2.currentPoint.y, 6)

	const r4 = engine.update({ time: t4, solution: frame4 })
	expect(r4.stage).toBe('COMPLETE')
	expect(r4.convergence).toBeTrue()
	expect(r4.totalError).toBeLessThan(deg(0.65))
})

function syntheticGeometry(axis: Vec3) {
	const width = 1024
	const height = 768
	const scale = 19000
	const tangent = stablePerpendicular(axis)
	const forward = vecRotateByRodrigues(axis, tangent, deg(1.3))
	const right = vecNormalizeMut(vecCross(forward, axis))
	const up = vecNormalizeMut(vecCross(right, forward))
	return { width, height, scale, axis, forward, right, up } as const
}

function syntheticFrame(base: ReturnType<typeof syntheticGeometry>, axis: Vec3, correctionAxis: Vec3, raRotation: number): PlateSolution {
	const correction = signedAngleAroundAxis(base.axis, axis, correctionAxis)
	const correctedForward = vecRotateByRodrigues(base.forward, correctionAxis, correction)
	const correctedRight = vecRotateByRodrigues(base.right, correctionAxis, correction)
	const correctedUp = vecRotateByRodrigues(base.up, correctionAxis, correction)
	const rotatedForward = vecRotateByRodrigues(correctedForward, axis, raRotation)
	const rotatedRight = vecRotateByRodrigues(correctedRight, axis, raRotation)
	const rotatedUp = vecRotateByRodrigues(correctedUp, axis, raRotation)
	const [rightAscension, declination] = eraC2s(...rotatedForward)
	const skyBasis = tangentBasis(rotatedForward)
	const invScale = 1 / base.scale

	const header: FitsHeader = {
		NAXIS: 2,
		NAXIS1: base.width,
		NAXIS2: base.height,
		CTYPE1: 'RA---TAN',
		CTYPE2: 'DEC--TAN',
		CUNIT1: 'deg',
		CUNIT2: 'deg',
		CRPIX1: base.width * 0.5,
		CRPIX2: base.height * 0.5,
		CRVAL1: toDeg(rightAscension),
		CRVAL2: toDeg(declination),
		CD1_1: toDeg(invScale * vecDot(rotatedRight, skyBasis.east)),
		CD1_2: toDeg(-invScale * vecDot(rotatedUp, skyBasis.east)),
		CD2_1: toDeg(invScale * vecDot(rotatedRight, skyBasis.north)),
		CD2_2: toDeg(-invScale * vecDot(rotatedUp, skyBasis.north)),
		EQUINOX: 2000,
	}

	const solution = plateSolutionFrom(header)
	if (!solution) throw new Error('failed to build synthetic plate solution')
	return solution
}

function stablePerpendicular(vector: Vec3) {
	const seed = Math.abs(vector[2]) < 0.9 ? ([0, 0, 1] as const) : ([0, 1, 0] as const)
	return vecNormalizeMut(vecCross(seed, vector))
}

function tangentBasis(origin: Vec3) {
	const reference = Math.abs(origin[2]) < 0.9 ? ([0, 0, 1] as const) : ([0, 1, 0] as const)
	const east = vecNormalizeMut(vecCross(reference, origin))
	const north = vecNormalizeMut(vecCross(origin, east))
	return { east, north } as const
}

function signedAngleAroundAxis(from: Vec3, to: Vec3, axis: Vec3) {
	const cross = vecCross(from, to)
	return Math.atan2(vecDot(cross, axis), vecDot(from, to))
}
