import { expect, test } from 'bun:test'
import { DEG2RAD } from '../src/constants'
import type { CalibrationMatrix, GuideFrame, GuideStar } from '../src/guider'
import { DEFAULT_GUIDING_CALIBRATOR_CONFIG, type GuidingCalibrationConfig, type GuidingCalibrationPhase, GuidingCalibrator } from '../src/guider.calibrator'

const WIDTH = 800
const HEIGHT = 600

// Builds one deterministic synthetic guide star.
function star(index: number, patch: Partial<GuideStar> = {}) {
	return { x: 140 + index * 95, y: 120 + index * 60, snr: 20 + index, flux: 2000 + index * 200, hfd: 2.8, ellipticity: 0.15, fwhm: 4, ...patch }
}

// Builds a deterministic list of guide stars.
function starList(count: number, patch?: (star: GuideStar, index: number) => GuideStar) {
	const stars = new Array<GuideStar>(count)

	for (let i = 0; i < count; i++) {
		const current = star(i)
		stars[i] = patch ? patch(current, i) : current
	}

	return stars
}

// Wraps a star list into a guide frame fixture.
function guideFrame(stars: readonly GuideStar[], timestamp = 0, frameId?: number): GuideFrame {
	return { stars, width: WIDTH, height: HEIGHT, timestamp, frameId }
}

// Applies a global translation to all stars in one frame.
function shiftStars(stars: readonly GuideStar[], dx: number, dy: number) {
	return stars.map((star) => ({ ...star, x: star.x + dx, y: star.y + dy }))
}

interface CalibrationSimulation {
	readonly raVector: readonly [number, number]
	readonly decVector: readonly [number, number]
	readonly decBacklashSteps?: number
	readonly reverseRaScale?: number
	readonly maxFrames?: number
}

const BASE_STARS = starList(5)

const BASE_CONFIG: Partial<GuidingCalibrationConfig> = {
	raPulse: 100,
	decPulse: 100,
	maxRaSteps: 10,
	maxDecSteps: 10,
	maxRaNoMotionSteps: 3,
	maxDecNoMotionSteps: 4,
	minMovePerStepPx: 0.05,
	minNetRaTravelPx: 2.4,
	minNetDecTravelPx: 2.4,
	maxFrameJumpPx: 4,
	maxBadFrames: 1,
	clearingMoveFraction: 1,
	maxClearingSteps: 10,
	maxClearingOffsetPx: 0.8,
	maxMatchDistancePx: 5,
	edgeMarginPx: 10,
	minRatePxPerMs: 1e-4,
	maxRatePxPerMs: 1,
	filter: {
		...DEFAULT_GUIDING_CALIBRATOR_CONFIG.filter,
		borderMarginPx: 8,
	},
}

// Merges the test defaults into a fully-specified calibrator config.
function calibrationConfig(config: Partial<GuidingCalibrationConfig> = {}) {
	return {
		...BASE_CONFIG,
		...config,
		filter: {
			...DEFAULT_GUIDING_CALIBRATOR_CONFIG.filter,
			...(BASE_CONFIG.filter ?? {}),
			...(config.filter ?? {}),
		},
	}
}

// Runs the calibrator against a deterministic pulse-to-motion simulator.
function runCalibration(config: Partial<GuidingCalibrationConfig>, simulation: CalibrationSimulation) {
	const calibrator = new GuidingCalibrator(calibrationConfig(config))
	let offsetX = 0
	let offsetY = 0
	let timestamp = 0
	let frameId = 0
	let decBacklashRemaining = simulation.decBacklashSteps ?? 0
	let step = calibrator.processFrame(guideFrame(BASE_STARS, timestamp, frameId++))
	const phases: GuidingCalibrationPhase[] = [step.phase]

	while (step.completed === undefined && step.failure === undefined && frameId <= (simulation.maxFrames ?? 40)) {
		const pulse = step.pulse

		if (pulse?.ra.duration !== undefined && pulse.ra.duration > 0) {
			const sign = pulse.ra.direction === calibrator.config.raDirection ? 1 : -1
			const scale = sign < 0 ? (simulation.reverseRaScale ?? 1) : 1
			offsetX += simulation.raVector[0] * sign * scale * (pulse.ra.duration / calibrator.config.raPulse)
			offsetY += simulation.raVector[1] * sign * scale * (pulse.ra.duration / calibrator.config.raPulse)
		}

		if (pulse?.dec.duration !== undefined && pulse.dec.duration > 0) {
			const sign = pulse.dec.direction === calibrator.config.decDirection ? 1 : -1

			if (sign > 0 && decBacklashRemaining > 0) {
				decBacklashRemaining--
			} else {
				offsetX += simulation.decVector[0] * sign * (pulse.dec.duration / calibrator.config.decPulse)
				offsetY += simulation.decVector[1] * sign * (pulse.dec.duration / calibrator.config.decPulse)
			}
		}

		timestamp += 1000
		step = calibrator.processFrame(guideFrame(shiftStars(BASE_STARS, offsetX, offsetY), timestamp, frameId++))
		phases.push(step.phase)
	}

	return { calibrator, step, phases }
}

// Multiplies two 2x2 matrices stored in row-major order.
function multiply2x2(a: CalibrationMatrix, b: CalibrationMatrix): CalibrationMatrix {
	return [a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3], a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3]]
}

test('completes RA clear and DEC backlash calibration with invertible matrix', () => {
	const simulation = runCalibration({}, { raVector: [0.8, 0.2], decVector: [-0.15, 0.75], decBacklashSteps: 2 })
	expect(simulation.step.failure).toBeUndefined()
	expect(simulation.step.completed).toBeDefined()
	expect(simulation.phases).toContain('raClearPulse')
	expect(simulation.phases).toContain('decBacklashClearing')
	expect(simulation.step.diagnostics.phaseHistory).toContain('precheck')
	expect(simulation.step.diagnostics.phaseHistory).toContain('acquireLock')
	expect(simulation.step.diagnostics.phaseHistory).toContain('completed')

	const completed = simulation.step.completed!
	const raLength = Math.hypot(0.8, 0.2)
	const decLength = Math.hypot(-0.15, 0.75)
	expect(completed.ra.unitX).toBeCloseTo(0.8 / raLength, 6)
	expect(completed.ra.unitY).toBeCloseTo(0.2 / raLength, 6)
	expect(completed.dec.unitX).toBeCloseTo(-0.15 / decLength, 6)
	expect(completed.dec.unitY).toBeCloseTo(0.75 / decLength, 6)
	expect(completed.ra.ratePxPerMs).toBeCloseTo(raLength / 100, 6)
	expect(completed.dec.ratePxPerMs).toBeCloseTo(decLength / 100, 6)
	expect(completed.backlash).toBe(200)

	const product = multiply2x2(completed.imageMotion, completed.imageToAxis)
	expect(product[0]).toBeCloseTo(1, 6)
	expect(product[1]).toBeCloseTo(0, 6)
	expect(product[2]).toBeCloseTo(0, 6)
	expect(product[3]).toBeCloseTo(1, 6)
})

test('fails when RA travel never reaches the configured threshold', () => {
	const simulation = runCalibration({ maxRaSteps: 3, maxRaNoMotionSteps: 8, minNetRaTravelPx: 2 }, { raVector: [0.2, 0.02], decVector: [-0.1, 0.6] })
	expect(simulation.step.completed).toBeUndefined()
	expect(simulation.step.failure).toBeDefined()
	expect(simulation.step.failure!.code).toBe('insufficient_ra_movement')
})

test('fails when the RA clearing move cannot return close enough to the origin', () => {
	const simulation = runCalibration({ maxClearingOffsetPx: 0.5, maxClearingSteps: 4 }, { raVector: [0.9, 0.25], decVector: [-0.2, 0.8], reverseRaScale: 0.2 })
	expect(simulation.step.completed).toBeUndefined()
	expect(simulation.step.failure).toBeDefined()
	expect(simulation.step.failure!.code).toBe('ra_clearing_failed')
})

test('fails when DEC backlash consumes too many no-motion steps', () => {
	const simulation = runCalibration({ maxDecNoMotionSteps: 2, maxDecSteps: 6 }, { raVector: [0.8, 0.15], decVector: [-0.2, 0.8], decBacklashSteps: 3 })
	expect(simulation.step.completed).toBeUndefined()
	expect(simulation.step.failure).toBeDefined()
	expect(simulation.step.failure!.code).toBe('too_many_dec_no_motion_steps')
})

test('fails validation when RA and DEC are nearly parallel', () => {
	const simulation = runCalibration({ minAxisSeparation: 20 * DEG2RAD }, { raVector: [0.8, 0.2], decVector: [0.75, 0.22] })
	expect(simulation.step.completed).toBeUndefined()
	expect(simulation.step.failure).toBeDefined()
	expect(simulation.step.failure!.code).toBe('axes_too_parallel')
})

test('tolerates one bad frame and resumes with the same pending pulse', () => {
	const calibrator = new GuidingCalibrator(calibrationConfig())
	let step = calibrator.processFrame(guideFrame(BASE_STARS, 0, 0))
	expect(step.pulse?.ra.duration).toBe(100)

	step = calibrator.processFrame(guideFrame([], 1000, 1))
	expect(step.failure).toBeUndefined()
	expect(step.pulse).toBeUndefined()
	expect(step.diagnostics.badFrames).toBe(1)
	expect(step.phase).toBe('raForwardPulse')

	step = calibrator.processFrame(guideFrame(shiftStars(BASE_STARS, 0.8, 0.2), 2000, 2))
	expect(step.failure).toBeUndefined()
	expect(step.phase).toBe('raForwardPulse')
	expect(step.diagnostics.raSteps).toBe(1)
})

test('fails at startup when the selected guide star is too close to the edge', () => {
	const calibrator = new GuidingCalibrator(calibrationConfig())
	const edgeStars = starList(5, (value, index) => (index === 0 ? { ...value, x: 9, y: 9 } : value))
	const step = calibrator.processFrame(guideFrame(edgeStars, 0, 0))
	expect(step.completed).toBeUndefined()
	expect(step.failure).toBeDefined()
	expect(step.failure!.code).toBe('star_near_edge')
})
