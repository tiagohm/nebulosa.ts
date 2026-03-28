import { expect, test } from 'bun:test'
import { type Angle, arcmin, arcsec, deg, toDeg } from '../src/angle'
import { cirsToObserved, observedToCirs, refractedAltitude } from '../src/astrometry'
import { eraC2s, eraS2c } from '../src/erfa'
import type { FitsHeader } from '../src/fits'
import { celestialPoleVector, decomposePolarError, IPolarPolarAlignment, projectGuidePoint, solveSimilarityFixedPoint } from '../src/ipolar'
import { type GeographicPosition, geodeticLocation } from '../src/location'
import { matMulVec, matTransposeMulVec } from '../src/mat3'
import { type PlateSolution, plateSolutionFrom } from '../src/platesolver'
import { mountAdjustmentAxes } from '../src/polaralignment'
import { precessionNutationMatrix, type Time, timeYMDHMS } from '../src/time'
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

test('decomposePolarError keeps azimuth and altitude offsets on their correct axes', () => {
	const location = geodeticLocation(deg(-70), deg(35))
	const time = timeYMDHMS(2026, 1, 7, 3, 15, 0)
	time.location = location

	const target = inertialVectorFromObserved(deg(40), deg(55), time, location)
	const azimuthOffset = inertialVectorFromObserved(deg(40) + arcmin(12), deg(55), time, location)
	const altitudeOffset = inertialVectorFromObserved(deg(40), deg(55) + arcmin(12), time, location)

	const azimuthMetrics = decomposePolarError(azimuthOffset, target, time, false, location)
	expect(Math.abs(azimuthMetrics.azimuthError)).toBeGreaterThan(20 * Math.abs(azimuthMetrics.altitudeError))

	const altitudeMetrics = decomposePolarError(altitudeOffset, target, time, false, location)
	expect(Math.abs(altitudeMetrics.altitudeError)).toBeGreaterThan(20 * Math.abs(altitudeMetrics.azimuthError))
})

test('celestialPoleVector uses refracted pole altitude when refraction is enabled', () => {
	const location = geodeticLocation(deg(-105), deg(42))
	const time = timeYMDHMS(2026, 2, 3, 5, 20, 0)
	time.location = location

	const pole = celestialPoleVector(time, location)
	const observedPole = cirsToObserved(matMulVec(precessionNutationMatrix(time), pole), time, undefined, location)
	const expectedAltitude = refractedAltitude(Math.abs(location.latitude), { pressure: 1013.25, temperature: 15, relativeHumidity: 0.5, wl: 0.55 })
	expect(observedPole.altitude).toBeCloseTo(expectedAltitude, 9)

	const geometricPole = cirsToObserved(matMulVec(precessionNutationMatrix(time), pole), time, false, location)
	expect(Math.abs(geometricPole.altitude - Math.abs(location.latitude))).toBeLessThan(arcsec(1))
})

const PRACTICAL_SCENARIOS = [
	buildPracticalScenario({
		name: 'south-combined-good',
		location: geodeticLocation(deg(-45.5), deg(-22.5)),
		start: [2026, 3, 27, 12, 0, 29],
		calibrationExpectation: 'accept',
		steps: [
			{ secondsOffset: 0, azimuthError: arcmin(30), altitudeError: arcmin(-18), raRotation: 0 },
			{ secondsOffset: 20, azimuthError: arcmin(30), altitudeError: arcmin(-18), raRotation: deg(25) },
			{ secondsOffset: 40, azimuthError: arcmin(10), altitudeError: arcmin(-6), raRotation: deg(25) },
			{ secondsOffset: 60, azimuthError: 0, altitudeError: 0, raRotation: deg(25) },
		],
	}),
	buildPracticalScenario({
		name: 'north-combined-good',
		location: geodeticLocation(deg(-105), deg(39.5)),
		start: [2026, 9, 18, 4, 15, 10],
		calibrationExpectation: 'skip',
		steps: [
			{ secondsOffset: 0, azimuthError: arcmin(-24), altitudeError: arcmin(15), raRotation: 0 },
			{ secondsOffset: 25, azimuthError: arcmin(-24), altitudeError: arcmin(15), raRotation: deg(30) },
			{ secondsOffset: 50, azimuthError: arcmin(-8), altitudeError: arcmin(5), raRotation: deg(30) },
			{ secondsOffset: 75, azimuthError: 0, altitudeError: 0, raRotation: deg(30) },
		],
	}),
	buildPracticalScenario({
		name: 'south-azimuth-only',
		location: geodeticLocation(deg(149), deg(-35)),
		start: [2026, 4, 3, 11, 22, 0],
		calibrationExpectation: 'skip',
		steps: [
			{ secondsOffset: 0, azimuthError: arcmin(40), altitudeError: 0, raRotation: 0 },
			{ secondsOffset: 18, azimuthError: arcmin(40), altitudeError: 0, raRotation: deg(24) },
			{ secondsOffset: 36, azimuthError: arcmin(12), altitudeError: 0, raRotation: deg(24) },
			{ secondsOffset: 54, azimuthError: 0, altitudeError: 0, raRotation: deg(24) },
		],
	}),
	buildPracticalScenario({
		name: 'north-altitude-only',
		location: geodeticLocation(deg(18), deg(52)),
		start: [2026, 10, 12, 1, 40, 5],
		calibrationExpectation: 'skip',
		steps: [
			{ secondsOffset: 0, azimuthError: 0, altitudeError: arcmin(-32), raRotation: 0 },
			{ secondsOffset: 22, azimuthError: 0, altitudeError: arcmin(-32), raRotation: deg(26) },
			{ secondsOffset: 44, azimuthError: 0, altitudeError: arcmin(-10), raRotation: deg(26) },
			{ secondsOffset: 66, azimuthError: 0, altitudeError: 0, raRotation: deg(26) },
		],
	}),
	buildPracticalScenario({
		name: 'south-large-ra-rotation',
		location: geodeticLocation(deg(-67), deg(-24)),
		start: [2026, 5, 9, 9, 12, 41],
		calibrationExpectation: 'accept',
		steps: [
			{ secondsOffset: 0, azimuthError: arcmin(22), altitudeError: arcmin(-14), raRotation: 0 },
			{ secondsOffset: 35, azimuthError: arcmin(22), altitudeError: arcmin(-14), raRotation: deg(55) },
			{ secondsOffset: 70, azimuthError: arcmin(8), altitudeError: arcmin(-5), raRotation: deg(55) },
			{ secondsOffset: 105, azimuthError: 0, altitudeError: 0, raRotation: deg(55) },
		],
	}),
	buildPracticalScenario({
		name: 'north-large-ra-rotation',
		location: geodeticLocation(deg(-122), deg(47)),
		start: [2026, 11, 21, 3, 5, 15],
		calibrationExpectation: 'skip',
		steps: [
			{ secondsOffset: 0, azimuthError: arcmin(-20), altitudeError: arcmin(18), raRotation: 0 },
			{ secondsOffset: 30, azimuthError: arcmin(-20), altitudeError: arcmin(18), raRotation: deg(48) },
			{ secondsOffset: 60, azimuthError: arcmin(-6), altitudeError: arcmin(6), raRotation: deg(48) },
			{ secondsOffset: 90, azimuthError: 0, altitudeError: 0, raRotation: deg(48) },
		],
	}),
	buildPracticalScenario({
		name: 'south-aligned-reference',
		location: geodeticLocation(deg(-58), deg(-34)),
		start: [2026, 6, 2, 8, 10, 0],
		calibrationExpectation: 'accept',
		steps: [
			{ secondsOffset: 0, azimuthError: 0, altitudeError: 0, raRotation: 0 },
			{ secondsOffset: 20, azimuthError: 0, altitudeError: 0, raRotation: deg(28) },
			{ secondsOffset: 40, azimuthError: 0, altitudeError: 0, raRotation: deg(28) },
			{ secondsOffset: 60, azimuthError: 0, altitudeError: 0, raRotation: deg(28) },
		],
	}),
	buildPracticalScenario({
		name: 'north-aligned-reference',
		location: geodeticLocation(deg(12), deg(64)),
		start: [2026, 12, 15, 22, 30, 0],
		calibrationExpectation: 'skip',
		steps: [
			{ secondsOffset: 0, azimuthError: 0, altitudeError: 0, raRotation: 0 },
			{ secondsOffset: 24, azimuthError: 0, altitudeError: 0, raRotation: deg(24) },
			{ secondsOffset: 48, azimuthError: 0, altitudeError: 0, raRotation: deg(24) },
			{ secondsOffset: 72, azimuthError: 0, altitudeError: 0, raRotation: deg(24) },
		],
	}),
	buildPracticalScenario({
		name: 'south-narrow-field-offscreen-stress',
		location: geodeticLocation(deg(-70), deg(-30)),
		start: [2026, 7, 8, 7, 55, 30],
		calibrationExpectation: 'accept',
		cameraOffset: deg(3.4),
		pixelScale: arcsec(12),
		steps: [
			{ secondsOffset: 0, azimuthError: arcmin(45), altitudeError: arcmin(-28), raRotation: 0 },
			{ secondsOffset: 20, azimuthError: arcmin(45), altitudeError: arcmin(-28), raRotation: deg(27) },
			{ secondsOffset: 40, azimuthError: arcmin(18), altitudeError: arcmin(-10), raRotation: deg(27) },
			{ secondsOffset: 60, azimuthError: arcmin(6), altitudeError: arcmin(-2), raRotation: deg(27) },
		],
	}),
	buildPracticalScenario({
		name: 'north-narrow-field-offscreen-stress',
		location: geodeticLocation(deg(-3), deg(57)),
		start: [2026, 1, 19, 20, 44, 10],
		calibrationExpectation: 'skip',
		cameraOffset: deg(3.2),
		pixelScale: arcsec(12),
		steps: [
			{ secondsOffset: 0, azimuthError: arcmin(-38), altitudeError: arcmin(24), raRotation: 0 },
			{ secondsOffset: 20, azimuthError: arcmin(-38), altitudeError: arcmin(24), raRotation: deg(27) },
			{ secondsOffset: 40, azimuthError: arcmin(-14), altitudeError: arcmin(8), raRotation: deg(27) },
			{ secondsOffset: 60, azimuthError: arcmin(-5), altitudeError: arcmin(2), raRotation: deg(27) },
		],
	}),
	buildPracticalScenario({
		name: 'south-wide-field',
		location: geodeticLocation(deg(-72), deg(-16)),
		start: [2026, 8, 4, 10, 5, 10],
		calibrationExpectation: 'skip',
		pixelScale: arcsec(60),
		cameraOffset: deg(1.2),
		steps: [
			{ secondsOffset: 0, azimuthError: arcmin(26), altitudeError: arcmin(-12), raRotation: 0 },
			{ secondsOffset: 20, azimuthError: arcmin(26), altitudeError: arcmin(-12), raRotation: deg(22) },
			{ secondsOffset: 40, azimuthError: arcmin(9), altitudeError: arcmin(-4), raRotation: deg(22) },
			{ secondsOffset: 60, azimuthError: arcmin(3), altitudeError: arcmin(-1), raRotation: deg(22) },
		],
	}),
	buildPracticalScenario({
		name: 'north-wide-field',
		location: geodeticLocation(deg(-96), deg(31)),
		start: [2026, 2, 14, 6, 0, 0],
		calibrationExpectation: 'skip',
		pixelScale: arcsec(60),
		cameraOffset: deg(1.1),
		steps: [
			{ secondsOffset: 0, azimuthError: arcmin(-28), altitudeError: arcmin(11), raRotation: 0 },
			{ secondsOffset: 20, azimuthError: arcmin(-28), altitudeError: arcmin(11), raRotation: deg(22) },
			{ secondsOffset: 40, azimuthError: arcmin(-10), altitudeError: arcmin(4), raRotation: deg(22) },
			{ secondsOffset: 60, azimuthError: arcmin(-3), altitudeError: arcmin(1), raRotation: deg(22) },
		],
	}),
	buildPracticalScenario({
		name: 'south-small-ra-rotation-rejected',
		location: geodeticLocation(deg(-45.5), deg(-22.5)),
		start: [2026, 3, 27, 12, 0, 29],
		minimumAcceptedRaRotation: deg(8),
		calibrationExpectation: 'reject',
		steps: [
			{ secondsOffset: 0, azimuthError: arcmin(30), altitudeError: arcmin(-18), raRotation: 0 },
			{ secondsOffset: 20, azimuthError: arcmin(30), altitudeError: arcmin(-18), raRotation: deg(5) },
			{ secondsOffset: 40, azimuthError: arcmin(12), altitudeError: arcmin(-6), raRotation: deg(5) },
			{ secondsOffset: 60, azimuthError: 0, altitudeError: 0, raRotation: deg(5) },
		],
	}),
	buildPracticalScenario({
		name: 'north-small-ra-rotation-rejected',
		location: geodeticLocation(deg(-105), deg(39.5)),
		start: [2026, 9, 18, 4, 15, 10],
		minimumAcceptedRaRotation: deg(8),
		calibrationExpectation: 'reject',
		steps: [
			{ secondsOffset: 0, azimuthError: arcmin(-24), altitudeError: arcmin(15), raRotation: 0 },
			{ secondsOffset: 25, azimuthError: arcmin(-24), altitudeError: arcmin(15), raRotation: deg(5) },
			{ secondsOffset: 50, azimuthError: arcmin(-8), altitudeError: arcmin(5), raRotation: deg(5) },
			{ secondsOffset: 75, azimuthError: 0, altitudeError: 0, raRotation: deg(5) },
		],
	}),
	buildPracticalScenario({
		name: 'south-strict-gate-rejected',
		location: geodeticLocation(deg(-58), deg(-20)),
		start: [2026, 5, 14, 9, 0, 0],
		minimumAcceptedRaRotation: deg(40),
		calibrationExpectation: 'reject',
		steps: [
			{ secondsOffset: 0, azimuthError: arcmin(20), altitudeError: arcmin(-10), raRotation: 0 },
			{ secondsOffset: 20, azimuthError: arcmin(20), altitudeError: arcmin(-10), raRotation: deg(25) },
			{ secondsOffset: 40, azimuthError: arcmin(6), altitudeError: arcmin(-3), raRotation: deg(25) },
			{ secondsOffset: 60, azimuthError: 0, altitudeError: 0, raRotation: deg(25) },
		],
	}),
	buildPracticalScenario({
		name: 'north-strict-gate-rejected',
		location: geodeticLocation(deg(14), deg(48)),
		start: [2026, 10, 5, 23, 20, 0],
		minimumAcceptedRaRotation: deg(40),
		calibrationExpectation: 'reject',
		steps: [
			{ secondsOffset: 0, azimuthError: arcmin(-22), altitudeError: arcmin(14), raRotation: 0 },
			{ secondsOffset: 20, azimuthError: arcmin(-22), altitudeError: arcmin(14), raRotation: deg(25) },
			{ secondsOffset: 40, azimuthError: arcmin(-6), altitudeError: arcmin(4), raRotation: deg(25) },
			{ secondsOffset: 60, azimuthError: 0, altitudeError: 0, raRotation: deg(25) },
		],
	}),
] as const

for (const scenario of PRACTICAL_SCENARIOS) {
	test(`scenario ${scenario.name} generates valid plate solutions`, () => {
		expect(scenario.frames).toHaveLength(4)
		expect(scenario.frames[0].widthInPixels).toBe(scenario.width)
		expect(scenario.frames[0].heightInPixels).toBe(scenario.height)
		expect(Math.abs(scenario.frames[0].orientation - scenario.frames[1].orientation)).toBeGreaterThan(deg(0.05))
		expect(Math.abs(scenario.frames[1].orientation - scenario.frames[2].orientation)).toBeLessThan(deg(0.5))
		expect(Math.abs(scenario.frames[2].orientation - scenario.frames[3].orientation)).toBeLessThan(deg(0.5))
		expect(Math.abs(scenario.frames[1].declination)).toBeGreaterThan(deg(80))
		expect(Math.abs(scenario.frames[2].declination)).toBeGreaterThan(deg(80))
	})

	test(`scenario ${scenario.name} calibration expectation is ${scenario.calibrationExpectation}`, () => {
		if (scenario.calibrationExpectation === 'skip') return

		const engine = new IPolarPolarAlignment({
			refraction: false,
			minimumAcceptedRaRotation: scenario.minimumAcceptedRaRotation,
			completionThreshold: scenario.completionThreshold,
		})

		const start = engine.start({ time: scenario.times[0], solution: scenario.frames[0] })
		expect(start.stage).toBe('WAITING_FOR_POSITION_2')

		const confirm = engine.confirm({ time: scenario.times[1], solution: scenario.frames[1] })

		if (scenario.calibrationExpectation === 'accept') {
			expect(confirm.stage).toBe('INITIAL_AXIS_ESTIMATION')
			expect(confirm.totalError).toBeGreaterThanOrEqual(0)
			expect(Number.isFinite(confirm.totalError)).toBeTrue()
		} else {
			expect(confirm.stage).toBe('WAITING_FOR_POSITION_2')
			expect(confirm.action).toBe('INVALID_FRAME')
		}
	})
}

test('update() preserves the calibrated fixed point across refinement frames', () => {
	const scenario = scenarioNamed('south-combined-good')
	const engine = new IPolarPolarAlignment({
		refraction: false,
		minimumAcceptedRaRotation: scenario.minimumAcceptedRaRotation,
		completionThreshold: scenario.completionThreshold,
	})

	const first = engine.update({ time: scenario.times[0], solution: scenario.frames[0] })
	expect(first.stage).toBe('WAITING_FOR_POSITION_2')

	const calibrated = engine.update({ time: scenario.times[1], solution: scenario.frames[1] })
	expect(calibrated.stage).toBe('INITIAL_AXIS_ESTIMATION')

	const refined = engine.update({ time: scenario.times[2], solution: scenario.frames[2] })
	expect(refined.stage).toBe('REFINEMENT')

	const later = engine.update({ time: scenario.times[3], solution: scenario.frames[3] })
	expect(later.stage).toBe('REFINEMENT')
	expect(refined.currentPoint.x).toBeCloseTo(calibrated.currentPoint.x, 8)
	expect(refined.currentPoint.y).toBeCloseTo(calibrated.currentPoint.y, 8)
	expect(later.currentPoint.x).toBeCloseTo(calibrated.currentPoint.x, 8)
	expect(later.currentPoint.y).toBeCloseTo(calibrated.currentPoint.y, 8)
	expect(Number.isFinite(refined.totalError)).toBeTrue()
	expect(Number.isFinite(later.totalError)).toBeTrue()
})

test('update() refreshes the target point on later solved frames', () => {
	const scenario = scenarioNamed('south-aligned-reference')
	const engine = new IPolarPolarAlignment({
		refraction: false,
		minimumAcceptedRaRotation: scenario.minimumAcceptedRaRotation,
		completionThreshold: scenario.completionThreshold,
	})

	engine.update({ time: scenario.times[0], solution: scenario.frames[0] })
	const calibrated = engine.update({ time: scenario.times[1], solution: scenario.frames[1] })
	expect(calibrated.stage).toBe('INITIAL_AXIS_ESTIMATION')

	const stable1 = engine.update({ time: scenario.times[2], solution: scenario.frames[2] })
	expect(stable1.stage).toBe('REFINEMENT')
	expect(stable1.currentPoint.x).toBeCloseTo(calibrated.currentPoint.x, 8)
	expect(stable1.currentPoint.y).toBeCloseTo(calibrated.currentPoint.y, 8)

	const stable2 = engine.update({ time: scenario.times[3], solution: scenario.frames[3] })
	expect(stable2.stage).toBe('REFINEMENT')
	expect(stable2.currentPoint.x).toBeCloseTo(calibrated.currentPoint.x, 8)
	expect(stable2.currentPoint.y).toBeCloseTo(calibrated.currentPoint.y, 8)
	expect(Math.abs(stable2.targetPoint.x - calibrated.targetPoint.x) + Math.abs(stable2.targetPoint.y - calibrated.targetPoint.y)).toBeGreaterThan(0)
})

interface PracticalFrameOptions {
	readonly secondsOffset: number
	readonly azimuthError: Angle
	readonly altitudeError: Angle
	readonly raRotation: Angle
}

interface PracticalScenarioDefinition {
	readonly name: string
	readonly location: GeographicPosition
	readonly start: readonly [number, number, number, number, number, number]
	readonly steps: readonly [PracticalFrameOptions, PracticalFrameOptions, PracticalFrameOptions, PracticalFrameOptions]
	readonly cameraOffset?: Angle
	readonly pixelScale?: Angle
	readonly baseRoll?: Angle
	readonly width?: number
	readonly height?: number
	readonly minimumAcceptedRaRotation?: Angle
	readonly completionThreshold?: Angle
	readonly calibrationExpectation?: 'accept' | 'reject' | 'skip'
}

interface PracticalScenario {
	readonly name: string
	readonly location: GeographicPosition
	readonly times: readonly [Time, Time, Time, Time]
	readonly frames: readonly [PlateSolution, PlateSolution, PlateSolution, PlateSolution]
	readonly width: number
	readonly height: number
	readonly minimumAcceptedRaRotation: Angle
	readonly completionThreshold: Angle
	readonly calibrationExpectation: 'accept' | 'reject' | 'skip'
}

function scenarioNamed(name: string): PracticalScenario {
	const scenario = PRACTICAL_SCENARIOS.find((scenario) => scenario.name === name)
	if (!scenario) throw new Error(`unknown practical scenario: ${name}`)
	return scenario
}

function inertialVectorFromObserved(azimuth: Angle, altitude: Angle, time: Time, location: GeographicPosition): Vec3 {
	const [rightAscension, declination] = observedToCirs(azimuth, altitude, time, false, location)
	return vecNormalizeMut(matTransposeMulVec(precessionNutationMatrix(time), eraS2c(rightAscension, declination)))
}

function buildPracticalScenario({ name, location, start, steps, cameraOffset = deg(1.6), pixelScale = arcsec(30), baseRoll = deg(33), width = 1280, height = 1024, minimumAcceptedRaRotation = deg(0.5), completionThreshold = arcmin(4), calibrationExpectation = 'accept' }: PracticalScenarioDefinition): PracticalScenario {
	const times = [timeWithOffset(start, steps[0].secondsOffset, location), timeWithOffset(start, steps[1].secondsOffset, location), timeWithOffset(start, steps[2].secondsOffset, location), timeWithOffset(start, steps[3].secondsOffset, location)] as const

	const frames = [
		practicalFrame({ time: times[0], azimuthError: steps[0].azimuthError, altitudeError: steps[0].altitudeError, raRotation: steps[0].raRotation, cameraOffset, pixelScale, baseRoll, width, height }),
		practicalFrame({ time: times[1], azimuthError: steps[1].azimuthError, altitudeError: steps[1].altitudeError, raRotation: steps[1].raRotation, cameraOffset, pixelScale, baseRoll, width, height }),
		practicalFrame({ time: times[2], azimuthError: steps[2].azimuthError, altitudeError: steps[2].altitudeError, raRotation: steps[2].raRotation, cameraOffset, pixelScale, baseRoll, width, height }),
		practicalFrame({ time: times[3], azimuthError: steps[3].azimuthError, altitudeError: steps[3].altitudeError, raRotation: steps[3].raRotation, cameraOffset, pixelScale, baseRoll, width, height }),
	] as const

	return { name, location, times, frames, width, height, minimumAcceptedRaRotation, completionThreshold, calibrationExpectation }
}

function timeWithOffset(start: readonly [number, number, number, number, number, number], secondsOffset: number, location: GeographicPosition) {
	const date = new Date(Date.UTC(start[0], start[1] - 1, start[2], start[3], start[4], start[5] + secondsOffset))
	const time = timeYMDHMS(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds())
	time.location = location
	return time
}

interface PracticalFrameDefinition {
	readonly time: Time
	readonly azimuthError: Angle
	readonly altitudeError: Angle
	readonly raRotation: Angle
	readonly cameraOffset: Angle
	readonly pixelScale: Angle
	readonly baseRoll: Angle
	readonly width: number
	readonly height: number
}

// Compute the true pole from celestialPoleVector(...) at the frame timestamp.
// Build the local mount adjustment axes from mountAdjustmentAxes(...).
// Apply synthetic azimuth and altitude misalignment to the RA axis in 3D.
// Offset the camera from the RA axis by a fixed amount to simulate a real polar camera not centered exactly on the pole.
// Apply RA-only rotation around the current axis for the second calibration frame.
// Convert that camera pose into a real TAN WCS header and then into a PlateSolution
function practicalFrame({ time, azimuthError, altitudeError, raRotation, cameraOffset, pixelScale, baseRoll, width, height }: PracticalFrameDefinition): PlateSolution {
	const location = time.location!
	const pole = celestialPoleVector(time, location, false)
	const { upAxis, eastAxis } = mountAdjustmentAxes(time, location)
	const alignedForward = vecRotateByRodrigues(pole, eastAxis, cameraOffset)
	const axis = vecRotateByRodrigues(vecRotateByRodrigues(pole, upAxis, azimuthError), eastAxis, altitudeError)
	const forward = vecRotateByRodrigues(vecRotateByRodrigues(alignedForward, upAxis, azimuthError), eastAxis, altitudeError)
	const right = vecNormalizeMut(vecCross(forward, axis, [0, 0, 0]))
	const up = vecNormalizeMut(vecCross(right, forward, [0, 0, 0]))
	const rolledRight = vecRotateByRodrigues(right, forward, baseRoll)
	const rolledUp = vecRotateByRodrigues(up, forward, baseRoll)
	const rotatedForward = vecRotateByRodrigues(forward, axis, raRotation)
	const rotatedRight = vecRotateByRodrigues(rolledRight, axis, raRotation)
	const rotatedUp = vecRotateByRodrigues(rolledUp, axis, raRotation)
	const [rightAscension, declination] = eraC2s(...rotatedForward)
	const skyBasis = tangentBasis(rotatedForward)
	const invScale = 1 / pixelScale
	const header: FitsHeader = {
		NAXIS: 2,
		NAXIS1: width,
		NAXIS2: height,
		CTYPE1: 'RA---TAN',
		CTYPE2: 'DEC--TAN',
		CUNIT1: 'deg',
		CUNIT2: 'deg',
		CRPIX1: width * 0.5 + 0.5,
		CRPIX2: height * 0.5 + 0.5,
		CRVAL1: toDeg(rightAscension),
		CRVAL2: toDeg(declination),
		CD1_1: toDeg(invScale * vecDot(rotatedRight, skyBasis.east)),
		CD1_2: toDeg(-invScale * vecDot(rotatedUp, skyBasis.east)),
		CD2_1: toDeg(invScale * vecDot(rotatedRight, skyBasis.north)),
		CD2_2: toDeg(-invScale * vecDot(rotatedUp, skyBasis.north)),
		EQUINOX: 2000,
	}
	const solution = plateSolutionFrom(header)
	if (!solution) throw new Error(`failed to build synthetic plate solution for ${toDeg(rightAscension)} ${toDeg(declination)}`)
	return solution
}

function tangentBasis(origin: Vec3) {
	const reference = Math.abs(origin[2]) < 0.9 ? ([0, 0, 1] as const) : ([0, 1, 0] as const)
	const east = vecNormalizeMut(vecCross(reference, origin, [0, 0, 0]))
	const north = vecNormalizeMut(vecCross(origin, east, [0, 0, 0]))
	return { east, north } as const
}
