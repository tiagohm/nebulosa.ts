import { describe, expect, test } from 'bun:test'
import { medianOf, NumberComparator } from '../../../src/core/util'
import { IndiClientHandlerSet } from '../../../src/devices/indi/client'
import type { Camera, Focuser } from '../../../src/devices/indi/device'
import { CameraManager, FocuserManager } from '../../../src/devices/indi/manager'
import { CameraSimulator } from '../../../src/devices/indi/simulator/camera'
import { ClientSimulator } from '../../../src/devices/indi/simulator/client'
import { FocuserSimulator } from '../../../src/devices/indi/simulator/focuser'
import { readImageFromBuffer } from '../../../src/imaging/model/image'
import { detectStars } from '../../../src/imaging/stars/detector'
import { mulberry32, type Random } from '../../../src/math/numerical/random'
// oxfmt-ignore
import { aggregateBacklashRuns, BacklashCalibration, backlashCompensationFromCalibration, fitBacklashBreakpoint, type BacklashCalibrationCommand, type BacklashCalibrationOptions, type BacklashCalibrationResult, type BacklashFitOptions, type BacklashProbePoint, type BacklashRunResult, type FocusAxisDirection } from '../../../src/observation/focus/backlash.calibration'
import { CameraFrameReceiver, isTimeConsumingTestSkipped, waitUntil } from '../../util'

// Deterministic numerical and state-machine coverage for bidirectional focuser-backlash calibration.

// Standard pure-fit configuration for a 20-step synthetic probe.
const FIT_OPTIONS: BacklashFitOptions = {
	probeStep: 20,
	minimumPlateauPoints: 2,
	minimumPostBreakPoints: 3,
	minimumSlope: 0.001,
	huberTuning: 1.345,
}

// Standard FSM configuration with enough travel for a 140-step breakpoint and stable tail.
const CALIBRATION_OPTIONS: BacklashCalibrationOptions = {
	probeStep: 20,
	preloadDistance: 240,
	maximumProbeDistance: 320,
	minimumSlope: 0.001,
	breakpointTolerance: 10,
	minimumPosition: 0,
	maximumPosition: 20000,
}

// Indicates whether integration tests involving timed simulator exposures are disabled.
const SKIP_TIME_CONSUMING = isTimeConsumingTestSkipped()

// Captures one deterministic frame and returns the median HFD of its detected stars, in pixels.
async function measureMedianHfd(camera: CameraSimulator, receiver: CameraFrameReceiver) {
	const previousFrameCount = receiver.length
	camera.startExposure(0.05)
	await waitUntil(() => receiver.length > previousFrameCount, 10000, 20)
	const image = await readImageFromBuffer(receiver.lastFrame)
	if (!image) throw new Error('camera simulator did not produce a readable image')
	const stars = detectStars(image, { maxStars: 100 })
	if (stars.length < 5) throw new Error(`expected at least five detected stars, received ${stars.length}`)
	return medianOf(stars.map((star) => star.hfd).sort(NumberComparator))
}

// Configures a compact deterministic star field whose HFD responds to the simulated optical position.
function configureBacklashImagingScene(client: ClientSimulator, cameraManager: CameraManager, camera: Camera, bestFocus = 50000, focusRange = 4000) {
	cameraManager.frame(camera, 512, 352, 256, 256)
	client.sendSwitch({ device: camera.name, name: 'SIMULATOR_NOISE_FEATURES', elements: { SKY_ENABLED: false, MOON_ENABLED: false, LIGHT_POLLUTION_ENABLED: false, AMP_GLOW_ENABLED: false } })
	client.sendNumber({ device: camera.name, name: 'SIMULATOR_NOISE_EXPOSURE', elements: { EXPOSURE_TIME: 0.05 } })
	client.sendNumber({ device: camera.name, name: 'SIMULATOR_SCENE', elements: { SCENE_SEED: 0x5eed, STAR_DENSITY: 0.001, SEEING: 0, HFD_MIN: 1.5, HFD_MAX: 1.5, FLUX_MIN: 5, FLUX_MAX: 5 } })
	client.sendNumber({ device: camera.name, name: 'SIMULATOR_NOISE_SENSOR', elements: { READ_NOISE: 0, BIAS_ELECTRONS: 0, BLACK_LEVEL_ELECTRONS: 0, DARK_CURRENT_AT_REFERENCE_TEMP: 0, DARK_SIGNAL_NON_UNIFORMITY: 0 } })
	client.sendNumber({
		device: camera.name,
		name: 'SIMULATOR_NOISE_ARTIFACTS',
		elements: { FIXED_PATTERN_NOISE_STRENGTH: 0, ROW_NOISE_STRENGTH: 0, COLUMN_NOISE_STRENGTH: 0, BANDING_STRENGTH: 0, HOT_PIXEL_RATE: 0, WARM_PIXEL_RATE: 0, DEAD_PIXEL_RATE: 0 },
	})
	client.sendNumber({ device: camera.name, name: 'SIMULATOR_STAR_PLOT_OPTIONS', elements: { BEST_FOCUS: bestFocus } })
	client.sendSwitch({ device: camera.name, name: 'SIMULATOR_ABERRATION_FEATURES', elements: { SENSOR_TILT: true } })
	client.sendNumber({ device: camera.name, name: 'SIMULATOR_ABERRATION_FOCUS', elements: { FOCUS_RANGE: focusRange, TILT: 10, TILT_ANGLE: 0 } })
}

// Command counts and terminal output produced by an asynchronous simulator-backed calibration.
interface SimulatorCalibrationExecution {
	// Terminal calibration command.
	readonly command: BacklashCalibrationCommand
	// Number of move commands applied through the focuser manager.
	readonly moveCommandCount: number
	// Number of measure commands fulfilled from camera HFD measurements.
	readonly measureCommandCount: number
}

// Executes calibration commands through the real simulator managers until a terminal command is emitted.
async function runCalibrationWithSimulators(calibration: BacklashCalibration, focuserManager: FocuserManager, focuser: Focuser, camera: CameraSimulator, receiver: CameraFrameReceiver): Promise<SimulatorCalibrationExecution> {
	let command = calibration.start(focuser.position.value)
	let moveCommandCount = 0
	let measureCommandCount = 0

	for (let commandCount = 0; commandCount < 500; commandCount++) {
		if (command.type === 'move') {
			moveCommandCount++
			focuserManager.moveTo(focuser, focuser.position.value + command.relative)
			await waitUntil(() => focuser.moving)
			await waitUntil(() => !focuser.moving, 3000, 20)
			command = calibration.next({ type: 'moved', position: focuser.position.value })
		} else if (command.type === 'measure') {
			measureCommandCount++
			command = calibration.next({ type: 'measured', position: focuser.position.value, value: await measureMedianHfd(camera, receiver) })
		} else {
			return { command, moveCommandCount, measureCommandCount }
		}
	}

	throw new Error('simulator-backed calibration did not reach a terminal command')
}

// Builds exact samples from the continuous plateau-plus-line model.
function makeProbePoints(backlash: number, slope = 0.02, intercept = 10, maximum = 280): BacklashProbePoint[] {
	const points: BacklashProbePoint[] = []
	for (let traveled = 0; traveled <= maximum; traveled += FIT_OPTIONS.probeStep) {
		points.push({ position: 10000 + traveled, traveled, value: intercept + slope * Math.max(0, traveled - backlash), dispersion: 0, sampleCount: 3 })
	}
	return points
}

// Returns a valid run with configurable breakpoint diagnostics.
function makeRun(direction: FocusAxisDirection, steps: number, valid = true): BacklashRunResult {
	return valid ? { direction, valid: true, steps, uncertainty: 10, slope: direction === 'increasing' ? 0.02 : -0.02, preloadSlope: direction === 'increasing' ? -0.02 : 0.02, nrmse: 0.01, points: [] } : { direction, valid: false, failureReason: 'breakpointNotFound', points: [] }
}

// Mechanical axis whose counter moves through slack while the optical position remains fixed.
class SyntheticFocusAxis {
	position: number
	opticalPosition: number
	readonly #random: Random
	#lastDirection?: FocusAxisDirection
	#remainingSlack = 0
	#measurementCount = 0

	// Configures independent directional backlash and deterministic metric noise.
	constructor(
		position: number,
		readonly increasingBacklash: number,
		readonly decreasingBacklash: number,
		readonly metricSlope = 0.01,
		readonly noiseAmplitude = 0,
		readonly outlierEvery = 0,
		seed = 0x5eed,
	) {
		this.position = position
		this.opticalPosition = position
		this.#random = mulberry32(seed)
	}

	// Applies one relative counter move and consumes directional slack before optical motion resumes.
	move(relative: number) {
		const direction: FocusAxisDirection = relative > 0 ? 'increasing' : 'decreasing'
		if (this.#lastDirection !== undefined && direction !== this.#lastDirection) {
			this.#remainingSlack = direction === 'increasing' ? this.increasingBacklash : this.decreasingBacklash
		}

		const distance = Math.abs(relative)
		const consumed = Math.min(distance, this.#remainingSlack)
		this.#remainingSlack -= consumed
		this.position += relative
		this.opticalPosition += Math.sign(relative) * (distance - consumed)
		this.#lastDirection = direction
		return this.position
	}

	// Returns a scalar metric linear in optical position with optional seeded noise and outliers.
	measure() {
		this.#measurementCount++
		const noise = (this.#random() * 2 - 1) * this.noiseAmplitude
		const outlier = this.outlierEvery > 0 && this.#measurementCount % this.outlierEvery === 0 ? this.metricSlope * 100 : 0
		return 10 + this.metricSlope * this.opticalPosition + noise + outlier
	}
}

// Drives the synchronous machine until it emits a terminal command.
function runCalibration(calibration: BacklashCalibration, axis: SyntheticFocusAxis, valueOf: () => number = () => axis.measure(), firstMoveScale = 1) {
	let command = calibration.start(axis.position)
	let previousState = 'idle'
	const directions: FocusAxisDirection[] = []

	for (let steps = 0; steps < 20000; steps++) {
		if (calibration.state === 'preloading' && previousState !== 'preloading') directions.push(calibration.currentDirection!)
		previousState = calibration.state

		if (command.type === 'move') {
			command = calibration.next({ type: 'moved', position: axis.move(command.relative * (steps === 0 ? firstMoveScale : 1)) })
		} else if (command.type === 'measure') {
			command = calibration.next({ type: 'measured', position: axis.position, value: valueOf() })
		} else {
			return { command, directions }
		}
	}

	throw new Error('calibration did not reach a terminal command')
}

describe('backlash breakpoint fitting', () => {
	test('fits an exact positive breakpoint without mutating points', () => {
		const points = makeProbePoints(120)
		const snapshot = structuredClone(points)
		const fit = fitBacklashBreakpoint(points, FIT_OPTIONS)

		expect(fit.valid).toBeTrue()
		expect(fit.breakpoint).toBeCloseTo(120, 4)
		expect(fit.slope).toBeCloseTo(0.02, 8)
		expect(fit.nrmse).toBeCloseTo(0, 8)
		expect(fit.uncertainty).toBeGreaterThanOrEqual(10)
		expect(points).toEqual(snapshot)
	})

	test('supports zero backlash and a negative slope', () => {
		const zero = fitBacklashBreakpoint(makeProbePoints(0), FIT_OPTIONS)
		const negative = fitBacklashBreakpoint(makeProbePoints(80, -0.03), FIT_OPTIONS)

		expect(zero.valid).toBeTrue()
		expect(zero.breakpoint).toBeCloseTo(0, 8)
		expect(negative.valid).toBeTrue()
		expect(negative.breakpoint).toBeCloseTo(80, 4)
		expect(negative.slope).toBeCloseTo(-0.03, 8)
	})

	test('refines a breakpoint between adjacent probe positions', () => {
		const fit = fitBacklashBreakpoint(makeProbePoints(90), FIT_OPTIONS)

		expect(fit.valid).toBeTrue()
		expect(fit.breakpoint).toBeCloseTo(90, 3)
		expect(fit.breakpoint).toBeGreaterThanOrEqual(80)
		expect(fit.breakpoint).toBeLessThanOrEqual(100)
	})

	test('consolidates duplicates and tolerates isolated outliers', () => {
		const points = makeProbePoints(100)
		points.reverse()
		points.push({ ...points[0], value: points[0].value + 5 })
		points.push({ ...points[0], value: points[0].value })
		points.push({ position: Number.NaN, traveled: 40, value: 10, dispersion: 0, sampleCount: 1 })
		const outlierIndex = points.findIndex((point) => point.traveled === 200)
		points[outlierIndex] = { ...points[outlierIndex], value: points[outlierIndex].value + 2 }

		const fit = fitBacklashBreakpoint(points, FIT_OPTIONS)
		expect(fit.valid).toBeTrue()
		expect(Math.abs(fit.breakpoint! - 100)).toBeLessThanOrEqual(FIT_OPTIONS.probeStep)
		expect(Number.isFinite(fit.loss)).toBeTrue()
		expect(Number.isFinite(fit.nrmse)).toBeTrue()
	})

	test('returns typed invalid fits without non-finite sentinels', () => {
		const insufficient = fitBacklashBreakpoint(makeProbePoints(120).slice(0, 3), FIT_OPTIONS)
		const flat = fitBacklashBreakpoint(makeProbePoints(120, 0), FIT_OPTIONS)

		expect(insufficient).toEqual({ valid: false, reason: 'insufficientData', plateauPointCount: 0, postBreakpointPointCount: 0 })
		expect(flat.valid).toBeFalse()
		expect(flat.reason).toBe('insufficientSlope')
		expect(flat.breakpoint).toBeUndefined()
	})

	test('validates fitting options', () => {
		expect(() => fitBacklashBreakpoint([], { ...FIT_OPTIONS, probeStep: 0 })).toThrow(RangeError)
		expect(() => fitBacklashBreakpoint([], { ...FIT_OPTIONS, minimumPostBreakPoints: 1.5 })).toThrow(TypeError)
	})
})

describe.skipIf(SKIP_TIME_CONSUMING)('backlash calibration simulator integration', () => {
	test('recovers focuser backlash from detected star HFD', async () => {
		const handler = new IndiClientHandlerSet()
		const cameraManager = new CameraManager()
		const focuserManager = new FocuserManager()
		const frameReceiver = new CameraFrameReceiver()
		handler.add(cameraManager)
		handler.add(focuserManager)
		cameraManager.addHandler(frameReceiver)

		using client = new ClientSimulator('backlash.calibration', handler)
		using cameraSimulator = new CameraSimulator('Camera Simulator', client, { focuserManager })
		using focuserSimulator = new FocuserSimulator('Focuser Simulator', client, { backlashOut: 300 })
		const camera = cameraManager.get(client, cameraSimulator.name)!
		const focuser = focuserManager.get(client, focuserSimulator.name)!
		cameraManager.connect(camera)
		focuserManager.connect(focuser)
		await waitUntil(() => camera.connected && focuser.connected)
		cameraManager.snoop(camera, undefined, focuser)
		configureBacklashImagingScene(client, cameraManager, camera)

		await waitUntil(() => camera.frame.width.value === 256 && camera.frame.height.value === 256 && cameraSimulator.activeFocuser?.name === focuser.name)
		focuserManager.syncTo(focuser, 50000)
		await waitUntil(() => focuser.position.value === 50000)
		focuserManager.moveTo(focuser, 49000)
		await waitUntil(() => focuser.moving)
		await waitUntil(() => !focuser.moving, 3000, 20)
		expect(focuserSimulator.effectivePosition).toBe(49000)

		const points: BacklashProbePoint[] = []
		for (let traveled = 0; traveled <= 900; traveled += 100) {
			if (traveled > 0) {
				focuserManager.moveTo(focuser, 49000 + traveled)
				await waitUntil(() => focuser.moving)
				await waitUntil(() => !focuser.moving, 3000, 20)
			}

			points.push({ position: focuser.position.value, traveled, value: await measureMedianHfd(cameraSimulator, frameReceiver), dispersion: 0, sampleCount: 1 })
		}

		const fit = fitBacklashBreakpoint(points, { probeStep: 100, minimumPlateauPoints: 2, minimumPostBreakPoints: 3, minimumSlope: 1e-5, huberTuning: 1.345 })
		expect(fit.valid).toBeTrue()
		expect(Math.abs(fit.breakpoint! - focuserSimulator.backlashOut)).toBeLessThanOrEqual(100)
		expect(points[0].value).toBeCloseTo(points[3].value, 6)
		expect(points.at(-1)!.value).toBeLessThan(points[3].value)
	}, 5000)

	test('executes calibration move and measure commands through camera and focuser simulators', async () => {
		const handler = new IndiClientHandlerSet()
		const cameraManager = new CameraManager()
		const focuserManager = new FocuserManager()
		const frameReceiver = new CameraFrameReceiver()
		handler.add(cameraManager)
		handler.add(focuserManager)
		cameraManager.addHandler(frameReceiver)

		using client = new ClientSimulator('backlash.calibration.commands', handler)
		using cameraSimulator = new CameraSimulator('Camera Simulator', client, { focuserManager })
		using focuserSimulator = new FocuserSimulator('Focuser Simulator', client, { backlashIn: 300, backlashOut: 300 })
		const camera = cameraManager.get(client, cameraSimulator.name)!
		const focuser = focuserManager.get(client, focuserSimulator.name)!
		cameraManager.connect(camera)
		focuserManager.connect(focuser)
		await waitUntil(() => camera.connected && focuser.connected)
		cameraManager.snoop(camera, undefined, focuser)
		configureBacklashImagingScene(client, cameraManager, camera, 52000, 8000)
		await waitUntil(() => camera.frame.width.value === 256 && camera.frame.height.value === 256 && cameraSimulator.activeFocuser?.name === focuser.name)

		focuserManager.syncTo(focuser, 50000)
		await waitUntil(() => focuser.position.value === 50000)
		const calibration = new BacklashCalibration({
			probeStep: 150,
			preloadDistance: 300,
			maximumProbeDistance: 750,
			minimumSlope: 1e-5,
			repeats: 3,
			samplesPerPosition: 1,
			minimumPreloadPoints: 2,
			minimumPlateauPoints: 2,
			minimumPostBreakPoints: 2,
			breakpointTolerance: 150,
			stabilityCount: 1,
			minimumPosition: 0,
			maximumPosition: 100000,
		})
		const execution = await runCalibrationWithSimulators(calibration, focuserManager, focuser, cameraSimulator, frameReceiver)

		expect(execution.command.type).toBe('completed')
		if (execution.command.type !== 'completed') throw new Error(`expected completed calibration, received ${execution.command.type}`)
		expect(execution.moveCommandCount).toBe(execution.measureCommandCount)
		expect(execution.moveCommandCount).toBeGreaterThan(20)
		expect(Math.abs(execution.command.result.increasing.steps - focuserSimulator.backlashOut)).toBeLessThanOrEqual(150)
		expect(Math.abs(execution.command.result.decreasing.steps - focuserSimulator.backlashIn)).toBeLessThanOrEqual(150)
		expect(execution.command.result.increasing.totalRunCount).toBe(3)
		expect(execution.command.result.decreasing.totalRunCount).toBe(3)
		expect(execution.command.result.increasing.validRunCount).toBeGreaterThanOrEqual(2)
		expect(execution.command.result.decreasing.validRunCount).toBeGreaterThanOrEqual(2)
		expect(calibration.result).toBe(execution.command.result)
	}, 30000)
})

describe('backlash run aggregation', () => {
	test('aggregates a strict valid majority by median and MAD', () => {
		const runs = [makeRun('increasing', 100), makeRun('increasing', 120), makeRun('increasing', 100), makeRun('increasing', 100, false)]
		const result = aggregateBacklashRuns(runs)!

		expect(result.steps).toBe(100)
		expect(result.dispersion).toBe(0)
		expect(result.uncertainty).toBe(10)
		expect(result.validRunCount).toBe(3)
		expect(result.totalRunCount).toBe(4)
	})

	test('rejects mixed directions and lists without a majority', () => {
		expect(aggregateBacklashRuns([makeRun('increasing', 100), makeRun('decreasing', 100)])).toBeUndefined()
		expect(aggregateBacklashRuns([makeRun('increasing', 100), makeRun('increasing', 100, false), makeRun('increasing', 100, false)])).toBeUndefined()
	})

	test('maps calibration directions to the existing compensator contract', () => {
		const increasing = aggregateBacklashRuns([makeRun('increasing', 80), makeRun('increasing', 80), makeRun('increasing', 80)])!
		const decreasing = aggregateBacklashRuns([makeRun('decreasing', 140), makeRun('decreasing', 140), makeRun('decreasing', 140)])!
		const result: BacklashCalibrationResult = { increasing, decreasing, recommendedOvershoot: 210, confidence: 1, quality: 'good' }

		expect(backlashCompensationFromCalibration(result)).toEqual({ mode: 'OVERSHOOT', backlashIn: 140, backlashOut: 80 })
		expect(backlashCompensationFromCalibration(result, 'ABSOLUTE')).toEqual({ mode: 'ABSOLUTE', backlashIn: 140, backlashOut: 80 })
	})
})

describe('backlash calibration state machine', () => {
	test('measures symmetric backlash and alternates the first direction', () => {
		const calibration = new BacklashCalibration(CALIBRATION_OPTIONS)
		const axis = new SyntheticFocusAxis(10000, 120, 120)
		const { command, directions } = runCalibration(calibration, axis)

		expect(command).toMatchObject({ type: 'completed' })
		if (command.type !== 'completed') throw new Error('expected completed calibration')
		expect(command.result.increasing.steps).toBeCloseTo(120, -1)
		expect(command.result.decreasing.steps).toBeCloseTo(120, -1)
		expect(command.result.recommendedOvershoot).toBe(180)
		expect(directions).toEqual(['increasing', 'decreasing', 'decreasing', 'increasing', 'increasing', 'decreasing'])
		expect(calibration.result).toBe(command.result)
	})

	test('measures asymmetric backlash with seeded noise and outliers', () => {
		const calibration = new BacklashCalibration({ ...CALIBRATION_OPTIONS, samplesPerPosition: 5, breakpointTolerance: 20 })
		const axis = new SyntheticFocusAxis(10000, 80, 140, 0.01, 0.01, 19)
		const { command } = runCalibration(calibration, axis)

		expect(command.type).toBe('completed')
		if (command.type !== 'completed') throw new Error('expected completed calibration')
		expect(Math.abs(command.result.increasing.steps - 80)).toBeLessThanOrEqual(20)
		expect(Math.abs(command.result.decreasing.steps - 140)).toBeLessThanOrEqual(20)
		expect(command.result.increasing.uncertainty).toBeGreaterThanOrEqual(10)
		expect(command.result.decreasing.uncertainty).toBeGreaterThanOrEqual(10)
		expect(Number.isFinite(command.result.confidence)).toBeTrue()
	})

	test('supports zero backlash without negative output', () => {
		const calibration = new BacklashCalibration(CALIBRATION_OPTIONS)
		const axis = new SyntheticFocusAxis(10000, 0, 0)
		const { command } = runCalibration(calibration, axis)

		expect(command.type).toBe('completed')
		if (command.type !== 'completed') throw new Error('expected completed calibration')
		expect(command.result.increasing.steps).toBe(0)
		expect(command.result.decreasing.steps).toBe(0)
		expect(command.result.recommendedOvershoot).toBe(0)
	})

	test('uses partial reported movement instead of the requested position', () => {
		const calibration = new BacklashCalibration(CALIBRATION_OPTIONS)
		const axis = new SyntheticFocusAxis(10000, 80, 140)
		const { command } = runCalibration(calibration, axis, () => axis.measure(), 0.5)

		expect(command).toMatchObject({ type: 'completed' })
		if (command.type !== 'completed') throw new Error('expected completed calibration')
		expect(Math.abs(command.result.increasing.steps - 80)).toBeLessThanOrEqual(20)
		expect(Math.abs(command.result.decreasing.steps - 140)).toBeLessThanOrEqual(20)
	})

	test('rejects an in-range probe move beyond the commanded maximum', () => {
		const calibration = new BacklashCalibration({ ...CALIBRATION_OPTIONS, stabilityCount: 13 })
		const axis = new SyntheticFocusAxis(10000, 120, 120)
		let command: BacklashCalibrationCommand = calibration.start(axis.position)
		let reversalPosition: number | undefined

		for (let i = 0; i < 200; i++) {
			if (command.type === 'move') {
				if (calibration.state === 'probing') {
					reversalPosition ??= axis.position
					const traveled = Math.abs(axis.position - reversalPosition)

					if (traveled + Math.abs(command.relative) >= CALIBRATION_OPTIONS.maximumProbeDistance) {
						const overtravelRelative = command.relative + Math.sign(command.relative) * CALIBRATION_OPTIONS.probeStep
						const overtravelPosition = axis.move(overtravelRelative)
						expect(Math.abs(overtravelPosition - reversalPosition)).toBeGreaterThan(CALIBRATION_OPTIONS.maximumProbeDistance)
						expect(overtravelPosition).toBeLessThanOrEqual(CALIBRATION_OPTIONS.maximumPosition!)
						expect(calibration.next({ type: 'moved', position: overtravelPosition })).toMatchObject({ type: 'failed', reason: 'invalidPosition' })
						return
					}
				}

				command = calibration.next({ type: 'moved', position: axis.move(command.relative) })
			} else if (command.type === 'measure') {
				command = calibration.next({ type: 'measured', position: axis.position, value: axis.measure() })
			} else {
				throw new Error(`unexpected terminal command: ${command.type}`)
			}
		}

		throw new Error('calibration did not issue the expected late probe move')
	})

	test('fails after constant metrics make a valid majority impossible', () => {
		const calibration = new BacklashCalibration(CALIBRATION_OPTIONS)
		const axis = new SyntheticFocusAxis(10000, 100, 100)
		const { command } = runCalibration(calibration, axis, () => 42)

		expect(command).toMatchObject({ type: 'failed', reason: 'insufficientValidRuns' })
		expect(calibration.result).toBeUndefined()
	})

	test('rejects out-of-order events and remains terminal', () => {
		const calibration = new BacklashCalibration(CALIBRATION_OPTIONS)
		const first = calibration.start(10000)
		expect(first.type).toBe('move')

		const failed = calibration.next({ type: 'measured', position: 10000, value: 1 })
		expect(failed).toMatchObject({ type: 'failed', reason: 'invalidEvent' })
		expect(calibration.next({ type: 'cancel' })).toBe(failed)
	})

	test('detects stalled and out-of-range movement', () => {
		const stalled = new BacklashCalibration(CALIBRATION_OPTIONS)
		stalled.start(10000)
		expect(stalled.next({ type: 'moved', position: 10000 })).toMatchObject({ type: 'failed', reason: 'axisStalled' })

		const limited = new BacklashCalibration({ ...CALIBRATION_OPTIONS, minimumPosition: 9990 })
		expect(limited.start(10000)).toMatchObject({ type: 'failed', reason: 'positionLimit' })
	})

	test('rejects non-finite samples and cancels from active preload', () => {
		const invalid = new BacklashCalibration(CALIBRATION_OPTIONS)
		const move = invalid.start(10000)
		if (move.type !== 'move') throw new Error('expected move command')
		const measure = invalid.next({ type: 'moved', position: 10000 + move.relative })
		expect(measure.type).toBe('measure')
		expect(invalid.next({ type: 'measured', position: 10000 + move.relative, value: Number.NaN })).toMatchObject({ type: 'failed', reason: 'invalidSample' })

		const cancelled = new BacklashCalibration(CALIBRATION_OPTIONS)
		cancelled.start(10000)
		const terminal = cancelled.next({ type: 'cancel' })
		expect(terminal).toEqual({ type: 'cancelled' })
		expect(cancelled.next({ type: 'moved', position: 9980 })).toBe(terminal)
	})

	test('rejects invalid positions and cancels during probing', () => {
		const invalidStart = new BacklashCalibration(CALIBRATION_OPTIONS)
		expect(invalidStart.start(Number.NaN)).toMatchObject({ type: 'failed', reason: 'invalidPosition' })

		const mismatched = new BacklashCalibration(CALIBRATION_OPTIONS)
		const first = mismatched.start(10000)
		if (first.type !== 'move') throw new Error('expected move command')
		const actual = 10000 + first.relative
		mismatched.next({ type: 'moved', position: actual })
		expect(mismatched.next({ type: 'measured', position: actual + 1, value: 1 })).toMatchObject({ type: 'failed', reason: 'invalidPosition' })

		const probing = new BacklashCalibration(CALIBRATION_OPTIONS)
		const axis = new SyntheticFocusAxis(10000, 120, 120)
		let command: BacklashCalibrationCommand = probing.start(axis.position)
		for (let i = 0; i < 100 && probing.state !== 'probing'; i++) {
			if (command.type === 'move') command = probing.next({ type: 'moved', position: axis.move(command.relative) })
			else if (command.type === 'measure') command = probing.next({ type: 'measured', position: axis.position, value: axis.measure() })
		}
		expect(probing.state).toBe('probing')
		expect(probing.next({ type: 'cancel' })).toEqual({ type: 'cancelled' })
	})

	test('validates option types, ranges, and stable-fit capacity', () => {
		expect(() => new BacklashCalibration({ ...CALIBRATION_OPTIONS, repeats: 2 })).toThrow(RangeError)
		expect(() => new BacklashCalibration({ ...CALIBRATION_OPTIONS, samplesPerPosition: 1.5 })).toThrow(TypeError)
		expect(() => new BacklashCalibration({ ...CALIBRATION_OPTIONS, preloadDistance: 40 })).toThrow(RangeError)
		expect(() => new BacklashCalibration({ ...CALIBRATION_OPTIONS, maximumProbeDistance: 100 })).toThrow(RangeError)
		expect(() => new BacklashCalibration({ ...CALIBRATION_OPTIONS, minimumPosition: 10, maximumPosition: 10 })).toThrow(RangeError)
	})
})
