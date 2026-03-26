import { expect, test } from 'bun:test'
import { arcsec, deg } from '../src/angle'
import { eraC2s, eraS2c } from '../src/erfa'
import { celestialPoleVector, IPolarPolarAlignment, type PlateSolutionAdapter, projectGuidePoint, solveSimilarityFixedPoint } from '../src/ipolar'
import { geodeticLocation } from '../src/location'
import { timeYMDHMS } from '../src/time'
import { type Vec3, vecCross, vecDot, vecNormalizeMut, vecRotateByRodrigues } from '../src/vec3'

class SyntheticPlateSolution implements PlateSolutionAdapter {
	readonly frame = 'icrs-j2000'
	readonly centerRightAscension
	readonly centerDeclination

	constructor(
		readonly width: number,
		readonly height: number,
		private readonly scale: number,
		private readonly forward: Vec3,
		private readonly right: Vec3,
		private readonly up: Vec3,
	) {
		;[this.centerRightAscension, this.centerDeclination] = eraC2s(...forward)
	}

	pixelToSky(x: number, y: number) {
		const u = (x - this.width / 2) / this.scale
		const v = (this.height / 2 - y) / this.scale
		return eraC2s(...vecNormalizeMut([this.forward[0] + u * this.right[0] + v * this.up[0], this.forward[1] + u * this.right[1] + v * this.up[1], this.forward[2] + u * this.right[2] + v * this.up[2]]))
	}

	skyToPixel(rightAscension: number, declination: number) {
		const vector = eraS2c(rightAscension, declination)
		const denom = vecDot(vector, this.forward)
		if (denom <= 0) return false
		return [this.width / 2 + this.scale * (vecDot(vector, this.right) / denom), this.height / 2 - this.scale * (vecDot(vector, this.up) / denom)] as const
	}
}

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
	const misalignmentAxis = vecNormalizeMut(vecCross([0, 1, 0], pole, [0, 0, 0]))
	const axis0 = vecRotateByRodrigues(pole, misalignmentAxis, deg(0.45))
	const axis1 = vecRotateByRodrigues(pole, misalignmentAxis, deg(0.18))
	const axis2 = pole

	const frame1 = syntheticFrame(axis0, 0)
	const frame2 = syntheticFrame(axis0, deg(24))
	const frame3 = syntheticFrame(axis1, deg(24))
	const frame4 = syntheticFrame(axis2, deg(24))

	const engine = new IPolarPolarAlignment({ refraction: false, minimumAcceptedRaRotation: deg(0.1), completionThreshold: arcsec(20) })
	const r1 = engine.startPosition1({ time: t1, plateSolution: frame1 })
	expect(r1.stage).toBe('WAITING_FOR_POSITION_2')

	const r2 = engine.confirmPosition2({ time: t2, plateSolution: frame2 })
	expect(r2.stage).toBe('INITIAL_AXIS_ESTIMATION')
	expect(r2.totalError).toBeGreaterThan(deg(0.2))
	expect(Math.hypot(r2.currentPoint.arrow.x, r2.currentPoint.arrow.y)).toBeCloseTo(1, 8)

	const r3 = engine.update({ time: t3, plateSolution: frame3 })
	expect(r3.stage).toBe('REFINEMENT')
	expect(r3.totalError).toBeLessThan(r2.totalError)
	expect(r3.currentPoint.x).toBeCloseTo(r2.currentPoint.x, 6)
	expect(r3.currentPoint.y).toBeCloseTo(r2.currentPoint.y, 6)

	const r4 = engine.update({ time: t4, plateSolution: frame4 })
	expect(r4.stage).toBe('COMPLETE')
	expect(r4.convergence).toBeTrue()
	expect(r4.totalError).toBeLessThan(deg(0.02))
})

function syntheticFrame(axis: Vec3, raRotation: number) {
	const width = 1024
	const height = 768
	const scale = 19000
	const tangent = stablePerpendicular(axis)
	const forward = vecRotateByRodrigues(axis, tangent, deg(1.3))
	const right = vecNormalizeMut(vecCross(forward, axis, [0, 0, 0]))
	const up = vecNormalizeMut(vecCross(right, forward, [0, 0, 0]))
	const rotatedForward = vecRotateByRodrigues(forward, axis, raRotation)
	const rotatedRight = vecRotateByRodrigues(right, axis, raRotation)
	const rotatedUp = vecRotateByRodrigues(up, axis, raRotation)
	return new SyntheticPlateSolution(width, height, scale, rotatedForward, rotatedRight, rotatedUp)
}

function stablePerpendicular(vector: Vec3) {
	const seed = Math.abs(vector[2]) < 0.9 ? ([0, 0, 1] as const) : ([0, 1, 0] as const)
	return vecNormalizeMut(vecCross(seed, vector, [0, 0, 0]))
}
