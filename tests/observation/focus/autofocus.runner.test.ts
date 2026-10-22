import { describe, expect, spyOn, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import type { FocuserMover } from '../../../src/devices/commanders/focuser'
import type { Camera, Focuser } from '../../../src/devices/indi/device'
import { failedOperationResult, type OperationContext, OperationCoordinator, type OperationResult, type OperationScope, successfulOperationResult } from '../../../src/devices/orchestration/operation'
import type { CooperativeJobHealth } from '../../../src/devices/orchestration/operation.wait'
import { ResourceArbiter, resourceKey } from '../../../src/devices/orchestration/resource'
import { isFits } from '../../../src/io/formats/fits/fits'
import type { CameraCaptureHooks, CameraCapturer, CameraCaptureResult } from '../../../src/observation/capture/capture'
import type { CameraCaptureStart } from '../../../src/observation/capture/types'
import { AutoFocus, type AutoFocusStep } from '../../../src/observation/focus/autofocus'
import { type AutoFocusCaptureOptions, type AutoFocusFrame, type AutoFocusMeasurer, type AutoFocusRunEvent, type AutoFocusRunListener, type AutoFocusRunOptions, type AutoFocusRunResult, autoFocusCaptureRequest, runAutoFocus } from '../../../src/observation/focus/autofocus.runner'
import { waitUntil } from '../../util'
import { ManualClock } from '../../util/rig'

// The physical autofocus loop over fakes and a manual clock: the moves of the state machine reproduced on the focuser,
// invalid measurements, the restore of a failed run, the cancellation, the range check, and the auxiliary FITS handed
// to a cooperative measurer only after the capture result.

const CAPTURE: AutoFocusCaptureOptions = { exposureTime: 2, exposureTimeUnit: 'second', frameType: 'LIGHT', x: 0, y: 0, width: 64, height: 64, subframe: true, binX: 2, binY: 2, frameFormat: 'MONO', gain: 10, offset: 5, compressed: false }
const ALGORITHM = { initialOffsetSteps: 5, stepSize: 100, fittingMode: 'HYPERBOLIC', reversed: false } as const
const OPTIONS: AutoFocusRunOptions = { algorithm: ALGORITHM, capture: CAPTURE, measureTimeout: 10, abortGrace: 5 }
// Best focus of the fake optics, in steps.
const BEST = 25030
// Smallest valid FITS: one header block.
const FITS_BLOCK = Buffer.from(`${'SIMPLE  =                    T'.padEnd(80)}${'BITPIX  =                    8'.padEnd(80)}${'NAXIS   =                    0'.padEnd(80)}${'END'.padEnd(80)}`.padEnd(2880))
const CAMERA = { name: 'Fake Camera' } as Camera

// Hyperbolic defocus curve of the fake optics: 1.8 px at the best focus, 0.02 px per step far from it.
function hfdAt(position: number) {
	return Math.hypot(1.8, 0.02 * (position - BEST))
}

// Focuser of the fakes with its commander: moves are recorded and applied at once, or fail, or hang until cancelled.
class FakeFocuser {
	readonly focuser: Focuser
	readonly moves: number[] = []
	// Failure of the move to this position, once.
	failAt?: { readonly position: number; readonly result: OperationResult<void> }
	// 1-based ordinal of the move that waits for the cancellation of its scope instead of completing.
	hangAt?: number

	constructor(position: number, min = 0, max = 100000) {
		this.focuser = { name: 'Fake Focuser', hardwareId: 'fake-focuser', client: { id: 'fake' }, type: 'focuser', connected: true, moving: false, position: { value: position, min, max } } as Focuser
	}

	get position() {
		return this.focuser.position.value
	}

	readonly commander = {
		moveTo: async (scope: OperationScope, _focuser: Focuser, position: number) => {
			this.moves.push(position)

			if (this.failAt?.position === position) {
				const { result } = this.failAt
				this.failAt = undefined
				return result
			}

			if (this.moves.length === this.hangAt) {
				const { signal } = scope as OperationContext
				await new Promise((resolve) => {
					signal.addEventListener('abort', resolve, { once: true })
				})
				return failedOperationResult('aborted')
			}

			Object.assign(this.focuser.position, { value: position })
			return successfulOperationResult(undefined)
		},
		position: () => this.focuser.position.value,
	} as unknown as FocuserMover
}

// Behavior of the fake capturer for one capture.
interface FakeCaptureBehavior {
	readonly fail?: boolean
}

// One capture as the fake capturer saw it.
interface CaptureCall {
	readonly request: CameraCaptureStart
	readonly hooks?: CameraCaptureHooks
	// Focuser position when the capture was requested.
	readonly position: number
	readonly order: number
}

// Capturer writing the minimal FITS at the requested path and recording each request.
function fakeCapturer(focuser: FakeFocuser, order: () => number, behaviors: FakeCaptureBehavior[] = []) {
	const calls: CaptureCall[] = []

	const capturer = {
		start: (_scope: OperationScope, _camera: Camera, request: CameraCaptureStart, hooks?: CameraCaptureHooks) => {
			calls.push({ request, hooks, position: focuser.position, order: order() })
			const behavior = behaviors.shift() ?? {}

			const result = (async (): Promise<OperationResult<CameraCaptureResult>> => {
				if (behavior.fail) return failedOperationResult('commandFailed', 'camera failed')
				const path = join(request.outputPath!, request.outputName!)
				await Bun.write(path, FITS_BLOCK)
				return successfulOperationResult({ frames: [{ operation: 'op', session: 's', generation: 1, camera: 'cam', path, exposureStartedAt: 0, exposureStartedMonotonic: 0, exposureFinishedAt: 0, exposureFinishedMonotonic: 0 }], frameCount: 1 })
			})()

			return { id: 'capture', started: Promise.resolve(successfulOperationResult(undefined)), result, cancel: () => Promise.resolve() }
		},
	} as unknown as CameraCapturer

	return { capturer, calls }
}

// One measurement as the measurer saw it.
interface MeasureCall {
	readonly path: string
	readonly fits: boolean
	readonly position: number
	readonly order: number
}

// Measurer of the fake optics at the focuser position, recording that it received a complete FITS.
function curveMeasurer(focuser: FakeFocuser, calls: MeasureCall[], order: () => number, hfd: (position: number) => number | undefined = hfdAt): AutoFocusMeasurer {
	return (frame: AutoFocusFrame) => {
		calls.push({ path: frame.path, fits: isFits(readFileSync(frame.path)), position: focuser.position, order: order() })
		return Promise.resolve(hfd(focuser.position))
	}
}

interface Harness {
	readonly clock: ManualClock
	readonly directory: string
	readonly focuser: FakeFocuser
	readonly captures: CaptureCall[]
	readonly measures: MeasureCall[]
	readonly coordinator: OperationCoordinator
	readonly run: (options?: Partial<AutoFocusRunOptions>, scope?: OperationScope) => Promise<OperationResult<AutoFocusRunResult>>
}

interface HarnessOptions {
	readonly position?: number
	readonly max?: number
	readonly measurer?: (focuser: FakeFocuser, calls: MeasureCall[], order: () => number) => AutoFocusMeasurer
	readonly behaviors?: FakeCaptureBehavior[]
	readonly health?: CooperativeJobHealth
	readonly listener?: AutoFocusRunListener
}

// Autofocus over the fake optics, focuser and capturer with a manual clock; auxiliary frames in a fresh directory.
function harness(options: HarnessOptions = {}): Harness {
	const clock = new ManualClock()
	const directory = mkdtempSync(join(tmpdir(), 'nebulosa-autofocus-'))
	const focuser = new FakeFocuser(options.position ?? 25100, 0, options.max ?? 100000)
	let sequence = 0
	const order = () => ++sequence
	const { capturer, calls } = fakeCapturer(focuser, order, options.behaviors)
	const measures: MeasureCall[] = []
	const measurer = (options.measurer ?? curveMeasurer)(focuser, measures, order)
	const coordinator = new OperationCoordinator(new ResourceArbiter())
	const run = (overrides: Partial<AutoFocusRunOptions> = {}, scope: OperationScope = coordinator) =>
		runAutoFocus(
			scope,
			focuser.focuser,
			CAMERA,
			{ ...OPTIONS, ...overrides },
			{ focuserMover: focuser.commander, cameraCapturer: capturer, measurer, auxiliaryPath: (capture) => join(directory, `af.${capture}.fit`), clock, ...(options.health !== undefined && { measurerHealth: options.health }), ...(options.listener !== undefined && { listener: options.listener }) },
		)
	return { clock, directory, focuser, captures: calls, measures, coordinator, run }
}

// Positions the pure state machine visits from `start` over the fake optics, and its terminal step.
function referenceRun(start: number, hfd: (position: number) => number = hfdAt) {
	const autoFocus = new AutoFocus({ ...ALGORITHM, maxPosition: 100000 })
	let position = start
	let step: AutoFocusStep = autoFocus.add(position, 0)
	const positions: number[] = []

	while (step.type === 'MOVE') {
		position = step.absolute ?? position + step.relative!
		positions.push(position)
		step = autoFocus.add(position, hfd(position))
	}

	return { positions, step }
}

describe('autofocus run', () => {
	test('the focuser follows exactly the moves of the state machine and ends at the rounded best focus', async () => {
		const { run, focuser, captures, measures } = harness()
		const reference = referenceRun(25100)
		const result = await run()

		expect(reference.step.type).toBe('COMPLETED')
		const best = Math.round(reference.step.absolute!)
		expect(result).toMatchObject({ ok: true, value: { position: best, initialPosition: 25100, captures: reference.positions.length } })
		expect(Math.abs(best - BEST)).toBeLessThan(ALGORITHM.stepSize)
		expect((result as { value: AutoFocusRunResult }).value.hfd).toBeCloseTo(1.8, 1)

		// Every visited position was commanded (a repeated position is not moved again), then the best focus.
		expect(focuser.moves).toEqual([...reference.positions.filter((position, i) => position !== (i === 0 ? 25100 : reference.positions[i - 1])), best])
		expect(captures.map((capture) => capture.position)).toEqual(reference.positions)
		expect(measures.map((measure) => measure.position)).toEqual(reference.positions)
		expect(focuser.position).toBe(best)
	})

	test('the listener sees each move, exposure, measurement and sample in order, with the position and HFD of every frame', async () => {
		const events: AutoFocusRunEvent[] = []
		const fits: (string | undefined)[] = []
		const { run, measures } = harness({
			listener: (event) => {
				events.push(event)
				if (event.type === 'sample') fits.push(event.autoFocus.hyperbolic === undefined ? undefined : 'hyperbolic')
			},
		})
		const reference = referenceRun(25100)
		const result = await run()

		expect(result).toMatchObject({ ok: true })
		const samples = events.filter((event) => event.type === 'sample')
		expect(samples.map((sample) => sample.position)).toEqual(reference.positions)
		expect(samples.map((sample) => sample.capture)).toEqual(reference.positions.map((_, i) => i + 1))
		expect(samples.map((sample) => sample.hfd)).toEqual(reference.positions.map(hfdAt))
		expect(samples.at(-1)!.step).toEqual(reference.step)
		expect(fits.at(-1)).toBe('hyperbolic')

		// Per frame: the sample move, the exposure, the measurement, then the sample; the run ends moving to the best focus.
		for (const [i, position] of reference.positions.entries()) {
			const capture = i + 1
			const expose = events.findIndex((event) => event.type === 'expose' && event.capture === capture)
			const measure = events.findIndex((event) => event.type === 'measure' && event.capture === capture)
			const sample = events.findIndex((event) => event.type === 'sample' && event.capture === capture)
			expect(events[expose - 1]).toEqual({ type: 'move', purpose: 'sample', target: position })
			expect(events[expose]).toMatchObject({ position, path: measures[i].path })
			expect(measure).toBe(expose + 1)
			expect(sample).toBe(measure + 1)
		}

		expect(events.at(-1)).toEqual({ type: 'move', purpose: 'best', target: (result as { value: AutoFocusRunResult }).value.position })
	})

	test('a failure reports the restore move', async () => {
		const events: AutoFocusRunEvent[] = []
		const { run } = harness({ behaviors: [{ fail: true }], listener: (event) => events.push(event) })

		expect(await run()).toMatchObject({ ok: false })
		expect(events.filter((event) => event.type === 'sample')).toEqual([])
		expect(events.at(-1)).toEqual({ type: 'move', purpose: 'restore', target: 25100 })
	})

	test('a measurement of NaN, 0, a negative value, undefined or a rejection is an invalid point, never an exception', async () => {
		const invalid = new Map<number, number | undefined>([
			[25600, Number.NaN],
			[25500, 0],
			[24600, -1],
			[24500, undefined],
		])
		const measurer = (focuser: FakeFocuser, calls: MeasureCall[], order: () => number): AutoFocusMeasurer => {
			const curve = curveMeasurer(focuser, calls, order, (position) => (invalid.has(position) ? invalid.get(position) : hfdAt(position)))
			return (frame, signal) => (focuser.position === 25400 ? Promise.reject(new Error('no stars')) : curve(frame, signal))
		}
		const { run, focuser } = harness({ measurer })
		const result = await run()

		expect(result).toMatchObject({ ok: true })
		expect(Math.abs((result as { value: AutoFocusRunResult }).value.position - BEST)).toBeLessThan(ALGORITHM.stepSize)
		expect(focuser.moves).toContain(25400)
	})

	test('a rejected curve restores the position the machine names, its start, inside the operation', async () => {
		const { run, focuser, measures } = harness({ measurer: (focuser, calls, order) => curveMeasurer(focuser, calls, order, () => undefined) })
		const result = await run()

		expect(result).toMatchObject({ ok: false, reason: 'commandFailed' })
		expect(measures.length).toBeGreaterThan(0)
		expect(focuser.moves.at(-1)).toBe(25100)
		expect(focuser.position).toBe(25100)
	})

	test('a failed capture never calls the measurer and restores the start', async () => {
		const { run, focuser, measures, captures, directory } = harness({ behaviors: [{}, { fail: true }] })
		const result = await run()

		expect(result).toMatchObject({ ok: false, reason: 'commandFailed', error: 'camera failed' })
		expect(captures).toHaveLength(2)
		expect(measures).toHaveLength(1)
		expect(focuser.position).toBe(25100)
		expect(existsSync(join(directory, 'af.2.fit'))).toBeFalse()
	})

	test('a failed restore is reported in the detail, with the reason of the original failure', async () => {
		const { run, focuser } = harness({ behaviors: [{ fail: true }] })
		focuser.failAt = { position: 25100, result: failedOperationResult('timeout', 'stuck') }
		const result = await run()

		expect(result).toMatchObject({ ok: false, reason: 'commandFailed', error: expect.stringContaining('the focuser was not restored to 25100: stuck') })
	})

	test('a position outside the focuser range fails before anything moves', async () => {
		const { run, focuser, captures } = harness({ position: 99800, max: 100000 })
		const result = await run()

		// The first move of the scan is +500 steps, to 100300.
		expect(result).toMatchObject({ ok: false, reason: 'unexpectedState', error: expect.stringContaining('100300 is outside the range [0, 100000]') })
		expect(focuser.moves).toEqual([])
		expect(captures).toEqual([])
	})

	test('the focuser is held for the whole run, so nothing outside it can move the focuser between the frames', async () => {
		const { focuser, coordinator, run } = harness()
		focuser.hangAt = 4
		const handle = coordinator.start('parent', [], (context) => run({}, context))

		await waitUntil(() => focuser.moves.length === 4, 5000, 1)
		let moved = false
		const outside = await coordinator.start<void>('outside', [{ key: resourceKey(focuser.focuser), device: focuser.focuser }], () => {
			moved = true
			return successfulOperationResult(undefined)
		}).result

		expect(outside.ok).toBeFalse()
		expect(moved).toBeFalse()

		await handle.cancel('aborted')
		expect(await handle.result).toMatchObject({ ok: false, reason: 'aborted' })
	})

	test('a cancellation resolves aborted, opens nothing more and leaves the focuser where the cancellation found it', async () => {
		const { focuser, captures, coordinator, run } = harness()
		// The fourth move (after three captures) never completes by itself, so the cancellation always finds it in flight.
		focuser.hangAt = 4
		let cancelled = false
		const handle = coordinator.start('parent', [], (context) => run({}, context))

		await waitUntil(() => focuser.moves.length === 4, 5000, 1)
		expect(captures).toHaveLength(3)
		const moves = focuser.moves.length
		const capturesBefore = captures.length
		void handle.cancel('aborted').then(() => {
			cancelled = true
		})
		const result = await handle.result

		expect(result).toMatchObject({ ok: false, reason: 'aborted' })
		await waitUntil(() => cancelled, 5000, 1)
		expect(focuser.moves).toHaveLength(moves)
		expect(captures).toHaveLength(capturesBefore)
	})
})

test('I46: the autofocus runner imports no star detector, solver or binding and creates no Worker', async () => {
	const source = readFileSync(join(dirname(dirname(dirname(__dirname))), 'src', 'observation', 'focus', 'autofocus.runner.ts'), 'utf8')
	const imports = [...source.matchAll(/from '([^']+)'/g)].map((match) => match[1])
	expect(imports.filter((path) => /solvers\/|bindings\/|imaging\/stars\//.test(path))).toEqual([])
	expect(source).not.toMatch(/new Worker\b/)

	const worker = spyOn(globalThis, 'Worker')
	expect(await harness().run()).toMatchObject({ ok: true })
	expect(worker).not.toHaveBeenCalled()
	worker.mockRestore()
})

describe('auxiliary frames', () => {
	test('each capture is one FITS auto-saved at the caller path with the focuser snooped, measured only after its result, and removed after the measurement', async () => {
		const { run, captures, measures, directory, clock } = harness()
		await run()

		for (const [i, capture] of captures.entries()) {
			expect(capture.request).toEqual(autoFocusCaptureRequest(CAPTURE, join(directory, `af.${i + 1}.fit`), { name: 'Fake Focuser' }))
			expect(capture.request).toMatchObject({ transferFormat: 'FITS', autoSave: true, exposureMode: 'single', count: 1, delay: 0, autoSubFolderMode: 'off', outputPath: directory, outputName: `af.${i + 1}.fit`, focuser: 'Fake Focuser' })
			expect(capture.hooks).toEqual({ clock })
		}

		expect(measures.every((measure) => measure.fits)).toBeTrue()
		expect(measures.map((measure) => measure.path)).toEqual(captures.map((_, i) => join(directory, `af.${i + 1}.fit`)))
		expect(measures.every((measure, i) => measure.order > captures[i].order)).toBeTrue()
		expect(captures.some((_, i) => existsSync(join(directory, `af.${i + 1}.fit`)))).toBeFalse()
	})

	test('the mount, filter wheel and rotator of the capture settings are snooped with the focuser of the run', async () => {
		const { run, captures } = harness()
		await run({ capture: { ...CAPTURE, mount: 'Fake Mount', wheel: 'Fake Wheel', rotator: 'Fake Rotator' } })

		expect(captures.length).toBeGreaterThan(0)
		for (const capture of captures) expect(capture.request).toMatchObject({ mount: 'Fake Mount', focuser: 'Fake Focuser', wheel: 'Fake Wheel', rotator: 'Fake Rotator' })
	})

	test("'keep' preserves every auxiliary frame", async () => {
		const { run, captures, directory } = harness()
		await run({ auxiliary: 'keep' })

		expect(captures.length).toBeGreaterThan(0)
		expect(captures.every((_, i) => existsSync(join(directory, `af.${i + 1}.fit`)))).toBeTrue()
	})

	test('a measurement that ignores its signal times out cooperatively: the file stays until it ends, the measurer is reported unresponsive and faulted, the focuser restored', async () => {
		let release: ((hfd: number) => void) | undefined
		const unresponsive: number[] = []
		const health: CooperativeJobHealth = { faulted: false, onUnresponsive: () => unresponsive.push(1) }
		const measurer = (focuser: FakeFocuser, calls: MeasureCall[], order: () => number): AutoFocusMeasurer => {
			const curve = curveMeasurer(focuser, calls, order)
			return (frame, signal) => {
				if (calls.length < 2) return curve(frame, signal)
				calls.push({ path: frame.path, fits: true, position: focuser.position, order: order() })
				return new Promise((resolve) => {
					release = resolve
				})
			}
		}
		const { run, clock, focuser, directory } = harness({ measurer, health })
		const result = run({ measureTimeout: 1, abortGrace: 2 })

		await waitUntil(() => release !== undefined && clock.pending > 0, 5000, 1)
		await clock.advance(1000)
		await clock.advance(2000)
		expect(unresponsive).toEqual([1])
		expect(existsSync(join(directory, 'af.3.fit'))).toBeTrue()

		release!(1.9)
		expect(await result).toMatchObject({ ok: false, reason: 'timeout' })
		expect(existsSync(join(directory, 'af.3.fit'))).toBeFalse()
		expect(health.faulted).toBeTrue()
		expect(focuser.position).toBe(25100)

		// A faulted measurer is never called again.
		const again = harness({ health })
		expect(await again.run()).toMatchObject({ ok: false, reason: 'unexpectedState', error: 'the HFD measurer is faulted' })
		expect(again.measures).toEqual([])
		expect(again.focuser.position).toBe(25100)
	})
})
