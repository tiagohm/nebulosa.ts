import { expect, test } from 'bun:test'
import { DEG2RAD } from '../../../src/core/constants'
import { DEFAULT_GUIDING_CALIBRATOR_CONFIG, flipGuidingCalibration, type GuidingCalibrationConfig, type GuidingCalibrationPhase, GuidingCalibrator } from '../../../src/observation/guiding/calibrator'
import type { CalibrationMatrix, GuideFrame, GuideStar } from '../../../src/observation/guiding/guider'

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
	readonly reverseRaBacklashSteps?: number
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
			...BASE_CONFIG.filter,
			...config.filter,
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
	let reverseRaBacklashRemaining = simulation.reverseRaBacklashSteps ?? 0
	let step = calibrator.processFrame(guideFrame(BASE_STARS, timestamp, frameId++))
	const phases: GuidingCalibrationPhase[] = [step.phase]

	while (step.completed === undefined && step.failure === undefined && frameId <= (simulation.maxFrames ?? 40)) {
		const pulse = step.pulse

		if (pulse?.ra.duration !== undefined && pulse.ra.duration > 0) {
			const sign = pulse.ra.direction === calibrator.config.raDirection ? 1 : -1
			const scale = sign < 0 ? (simulation.reverseRaScale ?? 1) : 1

			if (sign < 0 && reverseRaBacklashRemaining > 0) {
				reverseRaBacklashRemaining--
			} else {
				offsetX += simulation.raVector[0] * sign * scale * (pulse.ra.duration / calibrator.config.raPulse)
				offsetY += simulation.raVector[1] * sign * scale * (pulse.ra.duration / calibrator.config.raPulse)
			}
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
	expect(completed.warnings).toEqual([])

	const product = multiply2x2(completed.imageMotion, completed.imageToAxis)
	expect(product[0]).toBeCloseTo(1, 6)
	expect(product[1]).toBeCloseTo(0, 6)
	expect(product[2]).toBeCloseTo(0, 6)
	expect(product[3]).toBeCloseTo(1, 6)
})

test('flips calibration matrices and reverses DEC output direction', () => {
	const simulation = runCalibration({}, { raVector: [0.8, 0.2], decVector: [-0.15, 0.75], decBacklashSteps: 2 })
	const completed = simulation.step.completed!
	const flipped = flipGuidingCalibration(completed, true)

	expect(flipped.ra.direction).toBe(completed.ra.direction)
	expect(flipped.dec.direction).toBe('SOUTH')
	expect(flipped.ra.unitX).toBeCloseTo(-completed.ra.unitX, 8)
	expect(flipped.ra.unitY).toBeCloseTo(-completed.ra.unitY, 8)
	expect(flipped.dec.unitX).toBeCloseTo(completed.dec.unitX, 8)
	expect(flipped.dec.unitY).toBeCloseTo(completed.dec.unitY, 8)

	const product = multiply2x2(flipped.imageMotion, flipped.imageToAxis)
	expect(product[0]).toBeCloseTo(1, 6)
	expect(product[1]).toBeCloseTo(0, 6)
	expect(product[2]).toBeCloseTo(0, 6)
	expect(product[3]).toBeCloseTo(1, 6)
})

test('reset clears the previous completed result before a new calibration run', () => {
	const first = runCalibration({}, { raVector: [0.8, 0.2], decVector: [-0.15, 0.75], decBacklashSteps: 2 })
	expect(first.step.completed).toBeDefined()

	const calibrator = first.calibrator
	calibrator.reset()

	// The first frame of the new run only acquires the lock and queues the first RA pulse, so it must not
	// surface the previous run's completed result or failure.
	const step = calibrator.processFrame(guideFrame(BASE_STARS, 99999, 500))
	expect(step.phase).toBe('raForwardPulse')
	expect(step.completed).toBeUndefined()
	expect(step.failure).toBeUndefined()
})

test('fails when RA travel never reaches the configured threshold', () => {
	const simulation = runCalibration({ maxRaSteps: 3, maxRaNoMotionSteps: 8, minNetRaTravelPx: 2 }, { raVector: [0.2, 0.02], decVector: [-0.1, 0.6] })
	expect(simulation.step.completed).toBeUndefined()
	expect(simulation.step.failure).toBeDefined()
	expect(simulation.step.failure!.code).toBe('insufficient_ra_movement')
})

test('counts only consecutive RA steps without motion', () => {
	const calibrator = new GuidingCalibrator(calibrationConfig({ maxRaNoMotionSteps: 2, minMovePerStepPx: 0.3, minNetRaTravelPx: 12, clearingMoveEnabled: false }))
	let x = 140
	let y = 120
	let frameId = 0
	let step = calibrator.processFrame(guideFrame(BASE_STARS, 0, frameId++))

	for (const delta of [1, 0, 1, 0, 1]) {
		x += delta
		y += delta * 0.1
		step = calibrator.processFrame(guideFrame(shiftStars(BASE_STARS, x - 140, y - 120), frameId * 1000, frameId++))
		expect(step.failure).toBeUndefined()
	}

	expect(calibrator.currentState.raNoMotionSteps).toBe(0)
	expect(calibrator.currentState.raSteps).toBe(5)
	expect(step.diagnostics.raSamples).toHaveLength(3)
})

test('fails after too many consecutive RA steps without motion', () => {
	const calibrator = new GuidingCalibrator(calibrationConfig({ maxRaNoMotionSteps: 2, minMovePerStepPx: 0.3, clearingMoveEnabled: false }))
	expect(calibrator.processFrame(guideFrame(BASE_STARS, 0, 0)).pulse?.ra.duration).toBe(100)

	let step = calibrator.processFrame(guideFrame(BASE_STARS, 1000, 1))
	expect(step.failure).toBeUndefined()
	step = calibrator.processFrame(guideFrame(BASE_STARS, 2000, 2))
	expect(step.failure).toBeUndefined()
	step = calibrator.processFrame(guideFrame(BASE_STARS, 3000, 3))
	expect(step.failure).toBeDefined()
	expect(step.failure!.code).toBe('too_many_ra_no_motion_steps')
})

test('excludes RA no-motion pulses from the solved axis rate', () => {
	const calibrator = new GuidingCalibrator(calibrationConfig({ minNetRaTravelPx: 4, minMovePerStepPx: 0.15, clearingMoveEnabled: false }))
	let x = 140
	let frameId = 0
	let step = calibrator.processFrame(guideFrame(BASE_STARS, 0, frameId++))

	for (const delta of [0, 0, 0, 1.2, 1.2, 1.2, 1.2]) {
		x += delta
		step = calibrator.processFrame(guideFrame(shiftStars(BASE_STARS, x - 140, 0), frameId * 1000, frameId++))
		expect(step.failure).toBeUndefined()
		if (calibrator.state.raSolution !== undefined) break
	}

	expect(calibrator.state.raSolution).toBeDefined()
	expect(calibrator.state.raSolution!.totalPulse).toBe(400)
	expect(calibrator.state.raSolution!.ratePxPerMs).toBeCloseTo(4.8 / 400, 8)
	expect(step.diagnostics.raSamples).toHaveLength(4)
})

test('fails when the RA clearing move cannot return close enough to the origin', () => {
	const simulation = runCalibration({ maxClearingOffsetPx: 0.5, maxClearingSteps: 4 }, { raVector: [0.9, 0.25], decVector: [-0.2, 0.8], reverseRaScale: 0.2 })
	expect(simulation.step.completed).toBeUndefined()
	expect(simulation.step.failure).toBeDefined()
	expect(simulation.step.failure!.code).toBe('ra_clearing_failed')
})

test('continues RA clearing through reverse backlash until the origin is recovered', () => {
	const simulation = runCalibration({ maxClearingOffsetPx: 0.8, maxClearingSteps: 10 }, { raVector: [0.8, 0.2], decVector: [-0.15, 0.75], reverseRaBacklashSteps: 2 })
	expect(simulation.step.failure).toBeUndefined()
	expect(simulation.step.completed).toBeDefined()
	expect(simulation.step.diagnostics.clearingSteps).toBeGreaterThan(2)
	expect(Math.hypot(simulation.step.completed!.decStartX - simulation.step.completed!.startX, simulation.step.completed!.decStartY - simulation.step.completed!.startY)).toBeLessThanOrEqual(0.8)
})

test('accepts an RA clearing step that overshoots the origin', () => {
	const simulation = runCalibration({ maxClearingOffsetPx: 0.3, maxClearingSteps: 10 }, { raVector: [0.8, 0.2], decVector: [-0.15, 0.75], reverseRaScale: 4 })
	expect(simulation.step.failure).toBeUndefined()
	expect(simulation.step.completed).toBeDefined()
	expect(simulation.phases).toContain('decForwardPulse')
})

test('warns when RA clearing stops near the residual offset', () => {
	const simulation = runCalibration({ maxClearingOffsetPx: 0.8 }, { raVector: [0.8, 0.2], decVector: [-0.15, 0.75], reverseRaScale: 2.2 })
	expect(simulation.step.completed).toBeDefined()
	expect(simulation.step.completed!.warnings).toContain('ra_clearing_finished_near_threshold')
})

test('fails when DEC backlash consumes too many no-motion steps', () => {
	const simulation = runCalibration({ maxDecNoMotionSteps: 2, maxDecSteps: 6 }, { raVector: [0.8, 0.15], decVector: [-0.2, 0.8], decBacklashSteps: 3 })
	expect(simulation.step.completed).toBeUndefined()
	expect(simulation.step.failure).toBeDefined()
	expect(simulation.step.failure!.code).toBe('too_many_dec_no_motion_steps')
})

test('does not treat accumulated DEC creep as backlash clearance', () => {
	const simulation = runCalibration({ clearingMoveEnabled: false, maxDecNoMotionSteps: 4, maxDecSteps: 10, minMovePerStepPx: 0.05 }, { raVector: [0.8, 0.2], decVector: [0, 0.02] })
	expect(simulation.step.completed).toBeUndefined()
	expect(simulation.step.failure).toBeDefined()
	expect(simulation.step.failure!.code).toBe('too_many_dec_no_motion_steps')
})

test('excludes post-backlash DEC stalls from the solved axis rate', () => {
	const calibrator = new GuidingCalibrator(calibrationConfig({ clearingMoveEnabled: false, minMovePerStepPx: 0.05, maxDecNoMotionSteps: 4 }))
	let offsetX = 0
	let offsetY = 0
	let frameId = 0
	let step = calibrator.processFrame(guideFrame(BASE_STARS, 0, frameId++))
	const ra = [0.8, 0.2] as const
	const dec = [0, 0.9] as const

	while (step.pulse?.ra.duration !== undefined && step.pulse.ra.duration > 0 && step.failure === undefined && step.completed === undefined) {
		offsetX += ra[0]
		offsetY += ra[1]
		step = calibrator.processFrame(guideFrame(shiftStars(BASE_STARS, offsetX, offsetY), frameId * 1000, frameId++))
	}

	expect(step.pulse?.dec.duration).toBe(100)

	for (const scale of [0, 0, 1, 0, 0, 1, 1]) {
		offsetX += dec[0] * scale
		offsetY += dec[1] * scale
		step = calibrator.processFrame(guideFrame(shiftStars(BASE_STARS, offsetX, offsetY), frameId * 1000, frameId++))
		if (step.completed !== undefined || step.failure !== undefined) break
	}

	expect(step.failure).toBeUndefined()
	expect(step.completed).toBeDefined()
	expect(step.completed!.backlash).toBe(200)
	expect(step.completed!.dec.totalPulse).toBe(300)
	expect(step.completed!.dec.ratePxPerMs).toBeCloseTo(2.7 / 300, 8)
	expect(step.diagnostics.decSamples).toHaveLength(3)
})

test('fails validation when RA and DEC are nearly parallel', () => {
	// 15° apart is enough per-step DEC projection to leave backlash, but still under the 20° floor.
	const simulation = runCalibration({ minAxisSeparation: 20 * DEG2RAD }, { raVector: [0.8, 0.2], decVector: [0.717, 0.398] })
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

test('classifies a jump beyond maxFrameJumpPx as impossible_jump rather than star_lost', () => {
	const calibrator = new GuidingCalibrator(calibrationConfig({ maxFrameJumpPx: 4, maxMatchDistancePx: 5, maxBadFrames: 0 }))
	expect(calibrator.processFrame(guideFrame(BASE_STARS, 0, 0)).pulse?.ra.duration).toBe(100)

	// 6 px is beyond both the jump (4) and match (5) radii; the star is still in the frame, so this
	// is an impossible jump, not a lost lock.
	const step = calibrator.processFrame(guideFrame(shiftStars(BASE_STARS, 6, 0), 1000, 1))
	expect(step.failure).toBeDefined()
	expect(step.failure!.code).toBe('impossible_jump')
})

test('tolerates a transient jump within the bad-frame budget', () => {
	const calibrator = new GuidingCalibrator(calibrationConfig({ maxFrameJumpPx: 4, maxMatchDistancePx: 5, maxBadFrames: 1 }))
	expect(calibrator.processFrame(guideFrame(BASE_STARS, 0, 0)).pulse?.ra.duration).toBe(100)

	const jumped = calibrator.processFrame(guideFrame(shiftStars(BASE_STARS, 6, 0), 1000, 1))
	expect(jumped.failure).toBeUndefined()
	expect(jumped.diagnostics.badFrames).toBe(1)
	expect(jumped.diagnostics.raSteps).toBe(0)

	const recovered = calibrator.processFrame(guideFrame(shiftStars(BASE_STARS, 0.8, 0.2), 2000, 2))
	expect(recovered.failure).toBeUndefined()
	expect(recovered.diagnostics.raSteps).toBe(1)
})

test('accepts a sidereal-scale RA step under the default jump limit', () => {
	const calibrator = new GuidingCalibrator()
	const stars = [{ x: 200, y: 200, snr: 20, flux: 2000, hfd: 2.8, ellipticity: 0.15, fwhm: 4 }]
	expect(calibrator.processFrame(guideFrame(stars, 0, 0)).failure).toBeUndefined()

	const step = calibrator.processFrame(guideFrame(shiftStars(stars, 9.75, 0), 1000, 1))
	expect(step.failure).toBeUndefined()
	expect(step.diagnostics.raSteps).toBe(1)
})

test('fails after exceeding the bad-frame limit', () => {
	const calibrator = new GuidingCalibrator(calibrationConfig({ maxBadFrames: 1 }))
	expect(calibrator.processFrame(guideFrame(BASE_STARS, 0, 0)).pulse?.ra.duration).toBe(100)

	// First unusable frame is tolerated; the second exceeds maxBadFrames and fails.
	expect(calibrator.processFrame(guideFrame([], 1000, 1)).failure).toBeUndefined()
	const step = calibrator.processFrame(guideFrame([], 2000, 2))

	expect(step.failure).toBeDefined()
	expect(step.failure!.code).toBe('bad_frame')
})

test('search-box quality acquires the in-box star among field noise', () => {
	const calibrator = new GuidingCalibrator(calibrationConfig())
	const lock = star(0, { x: 140, y: 120, snr: 20, flux: 2000 })
	const noise: GuideStar[] = []
	for (let i = 0; i < 20; i++) {
		noise.push(star(i + 1, { x: 500 + (i % 5) * 20, y: 400 + Math.floor(i / 5) * 20, snr: 0.5, flux: 0.1 }))
	}

	const frame: GuideFrame = {
		stars: [lock, ...noise],
		width: WIDTH,
		height: HEIGHT,
		timestamp: 0,
		frameId: 0,
		searchPosition: [140, 120],
		searchRegion: 64,
	}

	const step = calibrator.processFrame(frame)
	expect(step.failure).toBeUndefined()
	expect(step.diagnostics.startX).toBeCloseTo(140, 8)
	expect(step.diagnostics.startY).toBeCloseTo(120, 8)
	expect(step.pulse?.ra.duration).toBe(100)
})

test('fails at startup when the selected guide star is too close to the edge', () => {
	const calibrator = new GuidingCalibrator(calibrationConfig())
	const edgeStars = starList(5, (value, index) => (index === 0 ? { ...value, x: 9, y: 9 } : value))
	const step = calibrator.processFrame(guideFrame(edgeStars, 0, 0))
	expect(step.completed).toBeUndefined()
	expect(step.failure).toBeDefined()
	expect(step.failure!.code).toBe('star_near_edge')
})
