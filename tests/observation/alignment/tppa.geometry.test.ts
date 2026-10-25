import { describe, expect, test } from 'bun:test'
import { eraC2s } from '../../../src/astronomy/coordinates/erfa/erfa'
import { geodeticLocation } from '../../../src/astronomy/observer/location'
import { gcrsToItrsRotationMatrix, type Time, timeShift, timeYMDHMS } from '../../../src/astronomy/time/time'
import { DAYSEC, PI } from '../../../src/core/constants'
import { matMulVec, matTransposeMulVec } from '../../../src/math/linear-algebra/mat3'
import { type Vec3, vecAngle, vecCross, vecNormalize, vecRotateByRodrigues } from '../../../src/math/linear-algebra/vec3'
import { arcsec, deg, toArcsec } from '../../../src/math/units/angle'
import { type ThreePointPolarAlignmentInput, threePointPolarAlignmentError } from '../../../src/observation/alignment/tppa'
import { classifyPolarAlignmentCandidate, polarAlignmentDisplacement, polarAlignmentGeometryQuality } from '../../../src/observation/alignment/tppa.geometry'

// Exact rigid-mount geometry (see tppa.tracking.test.ts): a terrestrial mechanical axis
// with the given polar error and boresights at `declination` about it.
function rigidMount(latitude: number, declination: number, azimuthError: number = arcsec(300), altitudeError: number = arcsec(300)) {
	const location = geodeticLocation(deg(-45), latitude)
	const time = timeYMDHMS(2026, 9, 9, 0, 30, 0)
	time.location = location
	const sinLat = Math.sin(latitude)
	const cosLat = Math.cos(latitude)
	const sinLon = Math.sin(location.longitude)
	const cosLon = Math.cos(location.longitude)
	const north: Vec3 = [-sinLat * cosLon, -sinLat * sinLon, cosLat]
	const east: Vec3 = [-sinLon, cosLon, 0]
	const up: Vec3 = [cosLat * cosLon, cosLat * sinLon, sinLat]
	const azimuth = (latitude > 0 ? 0 : PI) + azimuthError
	const altitude = Math.abs(latitude) + (latitude > 0 ? 1 : -1) * altitudeError
	const n = Math.cos(altitude) * Math.cos(azimuth)
	const e = Math.cos(altitude) * Math.sin(azimuth)
	const u = Math.sin(altitude)
	const pole: Vec3 = vecNormalize([north[0] * n + east[0] * e + up[0] * u, north[1] * n + east[1] * e + up[1] * u, north[2] * n + up[2] * u])
	const meridian = vecNormalize(vecCross(pole, up))
	const start = vecRotateByRodrigues(pole, vecNormalize(vecCross(pole, meridian)), PI / 2 - Math.abs(declination))
	// Positive rotations move the boresight westward in either hemisphere.
	const west = latitude > 0 ? -1 : 1
	const at = (rotation: number, seconds: number = 0) => {
		const sampleTime = seconds === 0 ? time : timeShift(time, seconds / DAYSEC)
		return plateSolve(vecRotateByRodrigues(start, pole, west * rotation), sampleTime)
	}
	return { time, pole, at, location }
}

function plateSolve(vector: Vec3, time: Time): ThreePointPolarAlignmentInput {
	const [rightAscension, declination] = eraC2s(...matTransposeMulVec(gcrsToItrsRotationMatrix(time), vector))
	return [rightAscension, declination, time]
}

for (const latitude of [deg(-22), deg(40)]) {
	describe(`geometry at latitude ${latitude}`, () => {
		test('measures westward and eastward rotation as the change of hour angle', () => {
			const mount = rigidMount(latitude, deg(10))
			expect(polarAlignmentDisplacement(mount.at(0), mount.at(deg(8))).rotation).toBeCloseTo(deg(8), 3)
			expect(polarAlignmentDisplacement(mount.at(0), mount.at(deg(-8))).rotation).toBeCloseTo(deg(-8), 3)
		})

		test('ignores sidereal drift between exposures taken minutes apart', () => {
			const mount = rigidMount(latitude, deg(10))
			const simultaneous = polarAlignmentDisplacement(mount.at(0), mount.at(deg(8)))
			const later = polarAlignmentDisplacement(mount.at(0), mount.at(deg(8), 600))
			expect(later.rotation).toBeCloseTo(simultaneous.rotation, 12)
			expect(later.separation).toBeCloseTo(simultaneous.separation, 12)
			expect(later.declinationChange).toBeCloseTo(simultaneous.declinationChange, 12)
		})

		test('accepts a well conditioned westward triple and rejects an eastward claim', () => {
			const mount = rigidMount(latitude, deg(20))
			const quality = polarAlignmentGeometryQuality(mount.at(0), mount.at(deg(8), 60), mount.at(deg(16), 120), 'WEST')
			expect(quality.acceptable).toBeTrue()
			expect(quality.rotation13).toBeCloseTo(deg(16), 3)
			// The inscribed angle at the first sample is half the arc between the others.
			expect(quality.quality).toBeCloseTo(Math.sin(deg(4)), 3)
			expect(polarAlignmentGeometryQuality(mount.at(0), mount.at(deg(8)), mount.at(deg(16)), 'EAST').reason).toBe('reversedRotation')
		})

		test('rejects short rotation, excessive rotation, and fields near the pole', () => {
			const mount = rigidMount(latitude, deg(20))
			expect(polarAlignmentGeometryQuality(mount.at(0), mount.at(deg(3)), mount.at(deg(6)), 'WEST').reason).toBe('insufficientRotation')
			expect(polarAlignmentGeometryQuality(mount.at(0), mount.at(deg(16)), mount.at(deg(32)), 'WEST').reason).toBe('excessiveRotation')
			const polar = rigidMount(latitude, deg(85))
			expect(polarAlignmentGeometryQuality(polar.at(0), polar.at(deg(8)), polar.at(deg(16)), 'WEST').reason).toBe('nearPole')
		})

		test('accepts a high declination field whose sky separation is small', () => {
			const mount = rigidMount(latitude, deg(75))
			const quality = polarAlignmentGeometryQuality(mount.at(0), mount.at(deg(8)), mount.at(deg(16)), 'WEST')
			expect(quality.acceptable).toBeTrue()
			expect(quality.separation12).toBeLessThan(deg(2.1))
		})

		test('crosses 0h of right ascension without a wrap', () => {
			const mount = rigidMount(latitude, deg(0))
			const samples = [0, 1, 2, 3, 4].map((i) => mount.at(deg(8 * i)))
			const crossing = samples.findIndex((s, i) => i > 0 && Math.abs(s[0] - samples[i - 1][0]) > PI)
			const first = crossing > 0 ? samples[crossing - 1] : samples[0]
			const second = crossing > 0 ? samples[crossing] : samples[1]
			expect(polarAlignmentDisplacement(first, second).rotation).toBeCloseTo(deg(8), 3)
		})

		test('rejects a declination change', () => {
			const mount = rigidMount(latitude, deg(20))
			const [ra, dec, time] = mount.at(deg(8))
			const moved: ThreePointPolarAlignmentInput = [ra, dec + deg(3), time]
			expect(polarAlignmentGeometryQuality(mount.at(0), moved, mount.at(deg(16)), 'WEST').reason).toBe('declinationChanged')
		})
	})
}

describe('candidate classification', () => {
	const mount = rigidMount(deg(40), deg(20))
	const first = mount.at(0)

	test('asks for more motion until the rotation reaches the minimum', () => {
		const short = classifyPolarAlignmentCandidate(first, first, mount.at(deg(3)), 'WEST')
		expect(short).toMatchObject({ accepted: false, reason: 'insufficientRotation', retry: true })
		expect(classifyPolarAlignmentCandidate(first, first, mount.at(deg(7)), 'WEST').accepted).toBeTrue()
	})

	test('measures the third candidate from the second and the total from the first', () => {
		const second = mount.at(deg(8))
		const third = classifyPolarAlignmentCandidate(first, second, mount.at(deg(15)), 'WEST')
		expect(third.accepted).toBeTrue()
		expect(third.displacement.rotation).toBeCloseTo(deg(7), 3)
		expect(third.totalRotation).toBeCloseTo(deg(15), 3)
		expect(classifyPolarAlignmentCandidate(first, second, mount.at(deg(31)), 'WEST')).toMatchObject({ reason: 'excessiveRotation', retry: false })
	})

	test('stops on reversed or absent motion only when it is reversed', () => {
		expect(classifyPolarAlignmentCandidate(first, first, mount.at(deg(-2)), 'WEST')).toMatchObject({ reason: 'reversedRotation', retry: false })
		expect(classifyPolarAlignmentCandidate(first, first, mount.at(0), 'WEST')).toMatchObject({ reason: 'insufficientRotation', retry: true })
		expect(classifyPolarAlignmentCandidate(first, first, mount.at(deg(-8)), 'EAST').accepted).toBeTrue()
	})
})

// Repeated noisy solves of the default geometry bound the seed pole error, which scales with the
// inverse square of the rotation and does not depend on declination (the reason the limits are
// expressed as rotation). σ = 0.5″ per axis, fixed seed; the bound is about three times the RMS.
test.each([0, 45, 75])('default rotation recovers the pole within the expected noise at declination %i°', (declination) => {
	const mount = rigidMount(deg(40), deg(declination))
	const sigma = arcsec(0.5)
	let seed = 7
	const random = () => {
		seed = (seed * 16807) % 2147483647
		return seed / 2147483647
	}
	const gauss = () => Math.sqrt(-2 * Math.log(random())) * Math.cos(2 * PI * random())
	const noisy = ([ra, dec, time]: ThreePointPolarAlignmentInput): ThreePointPolarAlignmentInput => [ra + (sigma * gauss()) / Math.cos(dec), dec + sigma * gauss(), time]
	let sum = 0
	const runs = 100
	for (let i = 0; i < runs; i++) {
		const p1 = noisy(mount.at(0))
		const p2 = noisy(mount.at(deg(8)))
		const p3 = noisy(mount.at(deg(16)))
		expect(polarAlignmentGeometryQuality(p1, p2, p3, 'WEST').acceptable).toBeTrue()
		const result = threePointPolarAlignmentError(p1, p2, p3, false, mount.location)
		if (!result) throw new Error('acceptable geometry must produce a pole')
		const error = vecAngle(matMulVec(gcrsToItrsRotationMatrix(mount.time), result.pole), mount.pole)
		sum += error * error
	}

	expect(toArcsec(Math.sqrt(sum / runs))).toBeLessThan(90)
})
