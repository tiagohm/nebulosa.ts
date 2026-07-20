import { expect, test } from 'bun:test'
import { enuVectorToHorizontal, horizontalToEnuVector } from '../../../src/astronomy/coordinates/frame.local'
import { PI, PIOVERTWO } from '../../../src/core/constants'
import { matMulVec, matRodriguesRotation } from '../../../src/math/linear-algebra/mat3'
import { deg } from '../../../src/math/units/angle'
import { domeAzimuthError, intersectRaySphere, isDomeMoveRequired, mountPoseToOpticalRay, solveDomeSlit, solveDomeSlitFromMount } from '../../../src/observation/dome/slit'
import { applyDirectionAlignment, fitMountAlignment } from '../../../src/observation/mount/alignment'
import { createIdealAltAzGeometry, mountDirectionFromEncoders, mountPoseFromEncoders, solveMountEncoders } from '../../../src/observation/mount/kinematics'

// Tests first-forward sphere intersections, dome conventions, and complete mount/alignment flows.

// Compares one three-component vector at the requested decimal precision.
function expectVectorClose(actual: readonly number[], expected: readonly number[], precision: number = 12): void {
	for (let i = 0; i < 3; i++) expect(actual[i]).toBeCloseTo(expected[i], precision)
}

test('inside rays exit the sphere and retain metric distance after normalization', () => {
	const intersection = intersectRaySphere({ origin: [0, 0, 0], direction: [2, 0, 0] }, [0, 0, 0], 5)!
	expect(intersection.distance).toBeCloseTo(5, 12)
	expectVectorClose(intersection.point, [5, 0, 0])
	const slit = solveDomeSlit({ origin: [0, 0, 0], direction: [2, 0, 0] }, { center: [0, 0, 0], radius: 5 })!
	expect(slit.azimuth).toBeCloseTo(PIOVERTWO, 12)
	expect(slit.altitude).toBeCloseTo(0, 12)
})

test('outside entering rays choose the near root rather than the opposite exit', () => {
	const intersection = intersectRaySphere({ origin: [-10, 0, 0], direction: [1, 0, 0] }, [0, 0, 0], 5)!
	expect(intersection.distance).toBeCloseTo(5, 12)
	expectVectorClose(intersection.point, [-5, 0, 0])
	expect(intersectRaySphere({ origin: [-10, 0, 0], direction: [-1, 0, 0] }, [0, 0, 0], 5)).toBeUndefined()
})

test('near-surface entering rays preserve the nearest strictly positive root', () => {
	const intersection = intersectRaySphere({ origin: [5 + 5e-14, 0, 0], direction: [-1, 0, 0] }, [0, 0, 0], 5)!

	expect(intersection.distance).toBeGreaterThan(0)
	expect(intersection.distance).toBeLessThan(1e-12)
	expectVectorClose(intersection.point, [5, 0, 0])
})

test('tangent, surface, and invalid rays follow strict forward semantics', () => {
	const tangent = intersectRaySphere({ origin: [-10, 5, 0], direction: [1, 0, 0] }, [0, 0, 0], 5)!
	expectVectorClose(tangent.point, [0, 5, 0])
	expect(tangent.distance).toBeCloseTo(10, 12)
	expect(intersectRaySphere({ origin: [5, 0, 0], direction: [1, 0, 0] }, [0, 0, 0], 5)).toBeUndefined()
	expectVectorClose(intersectRaySphere({ origin: [5, 0, 0], direction: [-1, 0, 0] }, [0, 0, 0], 5)!.point, [-5, 0, 0])
	expect(() => intersectRaySphere({ origin: [0, 0, 0], direction: [0, 0, 0] }, [0, 0, 0], 5)).toThrow()
	expect(() => intersectRaySphere({ origin: [0, 0, 0], direction: [1, 0, 0] }, [0, 0, 0], 0)).toThrow()
})

test('command offset, reversed direction, and north-wrap errors are explicit', () => {
	const slit = solveDomeSlit({ origin: [0, 0, 0], direction: [1, 0, 0] }, { center: [0, 0, 0], radius: 5, azimuthOffset: deg(10), azimuthDirection: -1 })!
	expect(slit.commandAzimuth).toBeCloseTo(deg(280), 12)
	expect(domeAzimuthError(deg(359), deg(1))).toBeCloseTo(deg(2), 12)
	expect(domeAzimuthError(deg(1), deg(359))).toBeCloseTo(deg(-2), 12)
	expect(isDomeMoveRequired(deg(359), deg(1), deg(1))).toBeTrue()
	expect(isDomeMoveRequired(deg(359), deg(1), deg(2))).toBeFalse()
})

test('inverse to forward to physical ray preserves offsets and hits the dome sphere', () => {
	const geometry = createIdealAltAzGeometry({ opticalOrigin: [0.8, -0.3, 0.4] })
	const expectedEncoders = { primary: deg(65), secondary: deg(32) }
	const target = mountDirectionFromEncoders(geometry, expectedEncoders)
	const encoders = solveMountEncoders(geometry, target, {
		initial: { primary: deg(60), secondary: deg(30) },
		primaryRange: [0, PI],
		secondaryRange: [0, PIOVERTWO],
		tolerance: 1e-12,
	})
	expect(encoders.converged).toBeTrue()
	const pose = mountPoseFromEncoders(geometry, encoders)
	const ray = mountPoseToOpticalRay(pose)
	const dome = { center: [0, 0, 0] as const, radius: 5 }
	const slit = solveDomeSlit(ray, dome)!
	const direct = solveDomeSlitFromMount(geometry, encoders, dome)!

	expectVectorClose(pose.direction, target)
	expectVectorClose(ray.origin, pose.origin)
	expectVectorClose(direct.point, slit.point)
	expect(Math.hypot(slit.point[0], slit.point[1], slit.point[2])).toBeCloseTo(5, 12)
	const targetAzimuth = enuVectorToHorizontal(target).azimuth
	expect(Math.abs(domeAzimuthError(targetAzimuth, slit.azimuth))).toBeGreaterThan(1e-3)
})

test('recovered alignment is materialized once in the end-to-end dome solution', () => {
	const trueRotation = matRodriguesRotation([0.3, -0.1, 0.7], deg(9))
	const nominal = createIdealAltAzGeometry({ opticalOrigin: [0.5, 0.2, -0.1] })
	const calibrationPositions = [
		{ primary: deg(15), secondary: deg(20) },
		{ primary: deg(110), secondary: deg(40) },
		{ primary: deg(230), secondary: deg(55) },
		{ primary: deg(320), secondary: deg(25) },
	]
	const observations = calibrationPositions.map((encoders) => {
		const world = matMulVec(trueRotation, mountDirectionFromEncoders(nominal, encoders))
		const horizontal = enuVectorToHorizontal(world)
		return { encoders, azimuth: horizontal.azimuth, altitude: horizontal.altitude }
	})
	const alignment = fitMountAlignment(nominal, observations)
	const aligned = applyDirectionAlignment(nominal, alignment)
	const requestedHorizontal = { azimuth: deg(140), altitude: deg(38) }
	const target = horizontalToEnuVector(requestedHorizontal.azimuth, requestedHorizontal.altitude)
	const encoders = solveMountEncoders(aligned, target, { initial: { primary: deg(130), secondary: deg(35) }, tolerance: 1e-11 })
	const slit = solveDomeSlitFromMount(aligned, encoders, { center: [0, 0, 0], radius: 4 })!

	expect(encoders.converged).toBeTrue()
	expectVectorClose(mountDirectionFromEncoders(aligned, encoders), target, 10)
	expect(Math.hypot(slit.point[0], slit.point[1], slit.point[2])).toBeCloseTo(4, 11)
	for (let i = 0; i < 9; i++) expect(aligned.baseToWorld.rotation[i]).toBeCloseTo(trueRotation[i], 10)
})
