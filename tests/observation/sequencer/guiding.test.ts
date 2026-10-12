import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { writeFileSync } from 'fs'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { equatorialToJ2000 } from '../../../src/astronomy/coordinates/coordinate'
import { timeUnix } from '../../../src/astronomy/time/time'
import { type Camera, DEFAULT_CAMERA } from '../../../src/devices/indi/device'
import { failedOperationResult, OperationCoordinator, type OperationResult, successfulOperationResult } from '../../../src/devices/orchestration/operation'
import { abortableDelay } from '../../../src/devices/orchestration/operation.wait'
import { ResourceArbiter, resourceKey } from '../../../src/devices/orchestration/resource'
import { arcsec, deg, normalizeAngle } from '../../../src/math/units/angle'
import { MountDitherer } from '../../../src/observation/guiding/ditherer'
import { captureFrameStep } from '../../../src/observation/sequencer/capture'
// oxfmt-ignore
import { pauseSequencerGuiding, preflightSequencerGuiding, sequencerGuidingStartupTasks, sequencerGuidingTasks, sequencerShutdownTasks, type SequencerGuidingServices } from '../../../src/observation/sequencer/guiding'
import { sequencerShutdownLifecycleTasks, sequencerStartupLifecycleTasks, ensureTrackingTask } from '../../../src/observation/sequencer/lifecycle'
import { sequencerPointingTasks } from '../../../src/observation/sequencer/pointing'
// oxfmt-ignore
import { type SequencerCaptureContext, type SequencerCapturedFrame, type SequencerCaptureStep, type SequencerContext, type SequencerRunner, type SequencerRunnerPhases, sequencerAdapterResources, sequencerResourceRequests, type SequencerShutdownTask, type SequencerTask, type SequencerTaskResult, startSequencerRunner } from '../../../src/observation/sequencer/runner'
// oxfmt-ignore
import type { SequencerCameraCapture, SequencerClock, SequencerConfiguration, SequencerDevices, SequencerDitherConfiguration, SequencerEvent, SequencerFrameGroup, SequencerGuidingConfiguration, SequencerResult, SequencerTaskId } from '../../../src/observation/sequencer/sequencer'
import { FileSystemSequencerCheckpointStore, FileSystemSequencerStorage, prepareFrameDestinationTask } from '../../../src/observation/sequencer/storage'
import { holdSequencerDither } from '../../../src/observation/sequencer/trigger'
import { waitUntil } from '../../util'
// oxfmt-ignore
import { assertRunnerInvariants, assertSequencerInvariants, connectSequencerRig, createSequencerRig, createTestSequence, type DeviceCommandEntry, expectNoSequencerLeaks, ManualSequencerClock, recordDevices, recordRunner, resetSequencerRig, RIG_INITIAL_POINTING, type RunnerRecorder, ScriptedGuidingSession, type TestSequence } from './util'

// Guiding and dither of the Sequencer: the tasks of sequencer/guiding.ts driven by the real runner over fake devices,
// a manual clock and a scripted guiding session (startup quiescence, ensureGuiding, ditherAndSettle, the shutdown
// prefix, the run admission and the reservation of the adapters), then sessions on the INDI simulator rig: dither
// without guiding through a pulse mount ditherer, and a guided session whose acquisition pauses guiding before the slew.

const LIGHT: SequencerCameraCapture = { exposureTime: 10, exposureTimeUnit: 'millisecond', frameType: 'LIGHT', x: 0, y: 0, width: 64, height: 64, subframe: true, binX: 2, binY: 2, frameFormat: 'MONO', gain: 10, offset: 5, compressed: false }
const DARK: SequencerCameraCapture = { ...LIGHT, frameType: 'DARK' }
const GUIDING: SequencerGuidingConfiguration = { settle: { pixels: 1.5, time: 1, timeout: 10 }, pauseTimeout: 5, maxRecoveries: 1, recalibrate: true, flipCalibration: false, onFailure: 'fail' }
const DITHER: SequencerDitherConfiguration = { afterFrames: 1, amount: { unit: 'guidePixel', value: 3 }, raOnly: false, settle: { kind: 'guided', pixels: 1.5, time: 1, timeout: 10 }, onFailure: 'fail' }
const CAMERA: Camera = { ...DEFAULT_CAMERA, id: 'Camera', name: 'Camera', hardwareId: 'Camera', connected: true }
const FRAME = Buffer.from('SIMPLE  =                    T')

const STORAGE_ROOT = await mkdtemp(join(tmpdir(), 'nebulosa-sequencer-guiding-'))

afterAll(async () => {
	await rm(STORAGE_ROOT, { recursive: true, force: true })
})

function lights(count: number): SequencerFrameGroup {
	return { kind: 'scheduled', id: 'L', enabled: true, capture: LIGHT, count }
}

function configurationOf(groups: readonly SequencerFrameGroup[], patch: Partial<SequencerConfiguration> = {}): SequencerConfiguration {
	return {
		schemaVersion: 1,
		id: 'guiding',
		revision: 1,
		name: 'Guiding',
		capture: { order: 'sequential', groups, retry: { maxAttempts: 1, delay: 0, backoff: 1, maximumDelay: 0, retryOn: [] }, onFailure: 'fail', cameraRecovery: { onTimeout: 'stop' } },
		startup: { onFailure: 'fail' },
		shutdown: { stepTimeout: 30, totalTimeout: 300, stopTracking: 'required', stopGuiding: 'required' },
		guiding: GUIDING,
		dither: DITHER,
		execution: { compensation: { timeout: 30 } },
		...patch,
	}
}

// Session under test, with every log in one sequence.
interface Harness {
	readonly runner: SequencerRunner
	readonly guiding: ScriptedGuidingSession
	readonly coordinator: OperationCoordinator
	readonly recorder: RunnerRecorder
	readonly clock: ManualSequencerClock
	readonly trace: { readonly sequence: number; readonly label: string }[]
}

interface HarnessOptions {
	readonly guiding?: ScriptedGuidingSession
	// Sequence the scripted guiding session records into; required with `guiding` for a single timeline.
	readonly sequence?: TestSequence
	readonly coordinator?: OperationCoordinator
	// Pre-capture tasks run before the guiding ones.
	readonly before?: readonly SequencerTask[]
	// Pre-capture tasks run after the guiding ones.
	readonly after?: readonly SequencerTask[]
	// Behaviour of each approved exposure.
	readonly capture?: (context: SequencerCaptureContext) => OperationResult<SequencerCapturedFrame> | Promise<OperationResult<SequencerCapturedFrame>>
	// Behaviour of the fake tracking-off step of the shutdown.
	readonly stopTracking?: () => SequencerTaskResult
}

const recorders: RunnerRecorder[] = []

afterEach(() => {
	for (const recorder of recorders.splice(0)) recorder[Symbol.dispose]()
})

function start(configuration: SequencerConfiguration, options: HarnessOptions = {}): Harness {
	const sequence = options.sequence ?? createTestSequence()
	const coordinator = options.coordinator ?? new OperationCoordinator(new ResourceArbiter())
	const clock = new ManualSequencerClock()
	const recorder = recordRunner(coordinator, sequence)
	recorders.push(recorder)
	const guiding = options.guiding ?? new ScriptedGuidingSession({}, sequence)
	const trace: Harness['trace'][number][] = []
	const storage = new FileSystemSequencerStorage({ root: STORAGE_ROOT, sessionId: Bun.randomUUIDv7(), wallNow: clock.wallNow })
	const services: SequencerGuidingServices = { guiding, ditherer: guiding }

	const capture: SequencerCaptureStep = async (context) => {
		const refusal = context.beforeExposure()
		if (refusal !== undefined) return refusal
		context.exposureStarted()
		trace.push({ sequence: sequence.next(), label: `exposure@${context.frame!.id}` })
		if (options.capture !== undefined) return await options.capture(context)
		writeFileSync(context.destination.temporary, FRAME)
		const at = clock.wallNow()
		const monotonic = clock.monotonicNow()
		return successfulOperationResult({ exposureDispatchedAt: at, exposureDispatchedMonotonic: monotonic, exposureStartedAt: at, exposureStartedMonotonic: monotonic, exposureFinishedAt: at, exposureFinishedMonotonic: monotonic })
	}

	const stopTracking: SequencerShutdownTask = {
		id: 'stopTracking',
		shouldRun: () => true,
		run: () => {
			trace.push({ sequence: sequence.next(), label: 'stopTracking' })
			return Promise.resolve(options.stopTracking?.() ?? { ok: true })
		},
		policy: 'required',
	}

	const phases: SequencerRunnerPhases = {
		startup: sequencerGuidingStartupTasks(configuration, services),
		preCapture: [...(options.before ?? []), ...sequencerGuidingTasks(configuration, services), ...(options.after ?? []), prepareFrameDestinationTask(storage)],
		capture,
		shutdown: sequencerShutdownTasks(configuration, services, [stopTracking]),
	}

	const devices: SequencerDevices = { camera: CAMERA }
	const runner = startSequencerRunner({ configuration, devices, services: { coordinator, storage, checkpointStore: new FileSystemSequencerCheckpointStore(STORAGE_ROOT), clock, listener: recorder.listener, guiding, ditherer: guiding }, phases })
	return { runner, guiding, coordinator, recorder, clock, trace }
}

function events(harness: Harness): SequencerEvent[] {
	return harness.recorder.entries.flatMap((entry) => (entry.kind === 'event' ? [entry.event] : []))
}

// Every sequenced entry of the session as a label: guiding commands, roots, drains, the release, exposures and events.
function timeline(harness: Harness) {
	const entries: { readonly sequence: number; readonly label: string }[] = [...harness.trace, ...harness.guiding.log.map((entry) => ({ sequence: entry.sequence, label: entry.recalibrate === undefined ? entry.command : `${entry.command}(${entry.recalibrate})` }))]

	for (const entry of harness.recorder.entries) {
		if (entry.kind === 'release') entries.push({ sequence: entry.sequence, label: 'release' })
		else if (entry.kind === 'root' && entry.operation === 'guiding') entries.push({ sequence: entry.sequence, label: `guiding:${entry.event}` })
		else if (entry.kind === 'drain' && entry.event === 'begin') entries.push({ sequence: entry.sequence, label: entry.terminal ? 'terminalDrain' : 'drain' })
		else if (entry.kind === 'event' && entry.event.type === 'ditherPhase') entries.push({ sequence: entry.sequence, label: `ditherPhase:${entry.event.phase}` })
	}

	return entries.sort((a, b) => a.sequence - b.sequence).map((entry) => entry.label)
}

async function finish(harness: Harness): Promise<SequencerResult> {
	const result = await harness.runner.handle.result
	assertRunnerInvariants(harness.recorder.entries)
	expect(harness.coordinator.arbiter.reservationOwnerOf(resourceKey(CAMERA))).toBeUndefined()
	expect(harness.coordinator.arbiter.ownersOf('logical:scripted-guider')).toEqual([])
	expect(harness.guiding.commands().filter((command) => command === 'endRun').length).toBeLessThanOrEqual(1)
	expect(harness.clock.pending).toBe(0)
	return result
}

// Fake pre-capture task.
function task(id: SequencerTaskId, run: (context: SequencerContext) => SequencerTaskResult | Promise<SequencerTaskResult>, shouldRun: (context: SequencerContext) => boolean = () => true): SequencerTask {
	return { id, shouldRun: (view) => shouldRun(view as SequencerContext), run: async (context) => await run(context) }
}

describe('guided session', () => {
	test('the run is admitted after the reservation, guiding is quiesced, started with a settle before the first light, dithered before the second, paused before tracking stops and stopped after it', async () => {
		const harness = start(configurationOf([lights(2)]))
		const result = await finish(harness)
		expect(result.state).toBe('completed')

		expect(timeline(harness)).toEqual([
			'beginRun',
			// 0c: the first physical command of the run.
			'pause',
			'start(true)',
			'guiding:start',
			'exposure@frame[L][1]',
			'dither',
			'ditherPhase:dithering',
			'ditherPhase:dithered',
			'ditherPhase:settling',
			'ditherPhase:settled',
			'exposure@frame[L][2]',
			'pause',
			'stopTracking',
			'stop',
			'guiding:end',
			'terminalDrain',
			'endRun',
			'release',
		])

		// I5: the dither anchor advanced after its settle and was persisted.
		const checkpoint = await new FileSystemSequencerCheckpointStore(STORAGE_ROOT).load(harness.runner.id)
		expect(checkpoint!.anchors.dither).toMatchObject({ lightExposures: 1 })
		expect(checkpoint!.anchors.dither.lastSuccessfulAt).toBeGreaterThan(0)
	})

	test('the guiding of the session joins the reservation; what it holds is never a device the session commands', async () => {
		const sequence = createTestSequence()
		const guiding = new ScriptedGuidingSession({ reserve: [{ key: 'logical:scripted-guider' }, { key: 'guide-camera' }], hold: [{ key: 'guide-camera' }] }, sequence)
		const configuration = configurationOf([lights(1)])
		expect(sequencerAdapterResources(configuration, { guiding, ditherer: guiding }).reserve.map((request) => request.key)).toEqual(['logical:scripted-guider', 'guide-camera'])
		expect(sequencerAdapterResources({ ...configuration, guiding: undefined, dither: undefined }, { guiding, ditherer: guiding }).reserve).toEqual([])

		let owner: string | undefined
		const harness = start(configuration, { guiding, sequence, before: [task('awaitCameraRecovery', (context) => ((owner = harness.coordinator.arbiter.reservationOwnerOf('guide-camera')?.id), { ok: true }))] })
		expect((await finish(harness)).state).toBe('completed')
		expect(owner).toBe(harness.runner.id)

		// 49.4 6, 49.11 7: a hold on the primary camera refuses the session before anything is reserved or begun.
		const refusal = createTestSequence()
		const camera = new ScriptedGuidingSession({ reserve: [{ key: resourceKey(CAMERA), device: CAMERA }], hold: [{ key: resourceKey(CAMERA), device: CAMERA }] }, refusal)
		const refused = start(configuration, { guiding: camera, sequence: refusal })
		expect(await finish(refused)).toMatchObject({ state: 'failed', failure: { kind: 'configuration' } })
		expect(camera.commands()).toEqual([])
		expect(refused.recorder.entries.some((entry) => entry.kind === 'release')).toBeFalse()
	})

	test('a paused guiding resumes; a lost one starts again without recalibrating and reports the interruption', async () => {
		let frames = 0
		const harness = start(configurationOf([lights(3)], { dither: undefined }), {
			capture: (context) => {
				frames++
				// After the first light someone pauses the guider; after the second the star is lost.
				if (frames === 1) harness.guiding.current = 'paused'
				if (frames === 2) harness.guiding.current = 'lost'
				writeFileSync(context.destination.temporary, FRAME)
				const at = context.clock.wallNow()
				return successfulOperationResult({ exposureStartedAt: at, exposureStartedMonotonic: 0, exposureFinishedAt: at, exposureFinishedMonotonic: 0, exposureDispatchedMonotonic: 0 })
			},
		})

		expect((await finish(harness)).state).toBe('completed')
		expect(harness.guiding.log.filter((entry) => entry.command === 'start' || entry.command === 'resume').map((entry) => (entry.command === 'start' ? `start(${entry.recalibrate})` : 'resume'))).toEqual(['start(true)', 'resume', 'start(false)'])
		expect(events(harness).filter((event) => event.type === 'guidingInterrupted')).toHaveLength(1)
	})

	test('a guiding lost again after its recoveries applies guiding.onFailure', async () => {
		const sequence = createTestSequence()
		const guiding = new ScriptedGuidingSession({}, sequence)
		guiding.loseAfterStart = 5
		const harness = start(configurationOf([lights(1)]), { guiding, sequence })
		const result = await finish(harness)

		expect(result).toMatchObject({ state: 'failed', failure: { kind: 'operation', task: 'ensureGuiding' } })
		// The initial start and maxRecoveries = 1 recovery, then the shutdown and exactly one endRun.
		expect(guiding.commands().filter((command) => command === 'start')).toHaveLength(2)
		expect(guiding.commands().filter((command) => command === 'endRun')).toHaveLength(1)
		expect(harness.trace.some((entry) => entry.label.startsWith('exposure'))).toBeFalse()
	})

	test('a recovery requested by the quality restarts a guiding session and clears the intent durably', async () => {
		let requested = false
		const request = task('awaitCameraRecovery', (context) => {
			if (!requested && context.state.anchors.lightExposures === 1) {
				requested = true
				context.state.intents.recoverGuiding = true
			}

			return { ok: true }
		})

		const harness = start(configurationOf([lights(2)], { dither: undefined }), { before: [request] })
		expect((await finish(harness)).state).toBe('completed')
		expect(harness.guiding.commands().filter((command) => command === 'start')).toHaveLength(2)

		const checkpoint = await new FileSystemSequencerCheckpointStore(STORAGE_ROOT).load(harness.runner.id)
		expect(checkpoint!.intents.recoverGuiding).toBeFalse()
	})

	test('a calibration frame with a closed optical path only keeps guiding paused; with an open one guiding is left alone', async () => {
		const closed = start(configurationOf([lights(1), { kind: 'triggered', id: 'D', enabled: true, capture: DARK, trigger: { kind: 'sessionEnd', onStop: false }, batchSize: 1, maxFrames: 1, inherit: 'none', opticalPath: { kind: 'cover' } }]))
		expect((await finish(closed)).state).toBe('completed')
		expect(timeline(closed).filter((label) => label !== 'guiding:start' && !label.startsWith('ditherPhase'))).toEqual(['beginRun', 'pause', 'start(true)', 'exposure@frame[L][1]', 'pause', 'exposure@frame[D][1]', 'pause', 'stopTracking', 'stop', 'guiding:end', 'terminalDrain', 'endRun', 'release'])

		const open = start(configurationOf([lights(1), { kind: 'triggered', id: 'D', enabled: true, capture: DARK, trigger: { kind: 'sessionEnd', onStop: false }, batchSize: 1, maxFrames: 1, inherit: 'none', opticalPath: { kind: 'none' } }]))
		expect((await finish(open)).state).toBe('completed')
		expect(open.guiding.commands()).toEqual(['beginRun', 'pause', 'start', 'pause', 'stop', 'endRun'])
	})
})

describe('dither', () => {
	test('never on the first light, after every N lights, postponed after a mount motion, and a failure never advances the anchor', async () => {
		let lightsSeen = 0
		// The mount moves for the target before the third light; the dither due then waits for the fourth.
		const motion = task(
			'acquireOrRecenterTarget',
			(context) => {
				holdSequencerDither(context.state)
				return { ok: true }
			},
			(context) => context.state.anchors.lightExposures === 2 && lightsSeen++ === 0,
		)

		const sequence = createTestSequence()
		const guiding = new ScriptedGuidingSession({}, sequence)
		let dithers = 0
		// The second dither fails; 'skip' exposes the light anyway.
		guiding.onDither = () => (++dithers === 2 ? failedOperationResult('timeout') : successfulOperationResult(undefined))

		const harness = start(configurationOf([lights(6)], { dither: { ...DITHER, afterFrames: 1, onFailure: 'skip' } }), { guiding, sequence, before: [motion] })
		expect((await finish(harness)).state).toBe('completed')

		// Lights 1..6: none before 1; before 2 ok; before 3 held by the motion; before 4 fails; before 5 ok (anchor at 3);
		// before 6 ok.
		const labels = timeline(harness).filter((label) => label === 'dither' || label.startsWith('exposure'))
		expect(labels).toEqual(['exposure@frame[L][1]', 'dither', 'exposure@frame[L][2]', 'exposure@frame[L][3]', 'dither', 'exposure@frame[L][4]', 'dither', 'exposure@frame[L][5]', 'dither', 'exposure@frame[L][6]'])

		const checkpoint = await new FileSystemSequencerCheckpointStore(STORAGE_ROOT).load(harness.runner.id)
		expect(checkpoint!.anchors.dither.lightExposures).toBe(5)
	})

	test('a dither due every two lights never runs for a dark', async () => {
		const harness = start(configurationOf([lights(4), { kind: 'scheduled', id: 'D', enabled: true, capture: DARK, count: 2 }], { dither: { ...DITHER, afterFrames: 2 } }))
		expect((await finish(harness)).state).toBe('completed')
		expect(timeline(harness).filter((label) => label === 'dither' || label.startsWith('exposure'))).toEqual(['exposure@frame[L][1]', 'exposure@frame[L][2]', 'dither', 'exposure@frame[L][3]', 'exposure@frame[L][4]', 'exposure@frame[D][1]', 'exposure@frame[D][2]'])
	})

	test('20: an immediate stop during the dither cancels it and keeps the root guiding until the shutdown stops it', async () => {
		const sequence = createTestSequence()
		const guiding = new ScriptedGuidingSession({}, sequence)
		guiding.onDither = (scope) =>
			new Promise((resolve) => {
				scope.signal.addEventListener('abort', () => resolve(failedOperationResult('aborted')), { once: true })
			})
		const harness = start(configurationOf([lights(2)]), { guiding, sequence })
		await waitUntil(() => guiding.commands().includes('dither'), 2000, 1)
		void harness.runner.handle.stop('immediate')

		const result = await finish(harness)
		expect(result.state).toBe('stopped')
		const labels = timeline(harness)
		// The drain of the stop preserves the root guiding; the shutdown stops it.
		expect(labels.indexOf('drain')).toBeGreaterThan(labels.indexOf('dither'))
		expect(labels.indexOf('guiding:end')).toBeGreaterThan(labels.indexOf('stop'))
		expect(labels.indexOf('guiding:end')).toBeGreaterThan(labels.indexOf('drain'))
	})
})

describe('49.11 75: ownership of the run', () => {
	test('(a) a failed startup quiescence still shuts down and ends the run once, after the shutdown and before the release', async () => {
		const sequence = createTestSequence()
		const guiding = new ScriptedGuidingSession({}, sequence)
		guiding.onPause = () => failedOperationResult('timeout', 'pulses never ended')
		const harness = start(configurationOf([lights(1)]), { guiding, sequence })
		const result = await finish(harness)

		expect(result).toMatchObject({ state: 'failed', failure: { kind: 'operation', reason: 'timeout', task: 'quiesceGuiding' } })
		expect((result.failure as { detail?: string }).detail).toStartWith('guidingNotQuiescent')
		const labels = timeline(harness)
		expect(labels.filter((label) => label === 'endRun')).toHaveLength(1)
		expect(labels.indexOf('endRun')).toBeGreaterThan(labels.indexOf('stopTracking'))
		expect(labels.indexOf('endRun')).toBeLessThan(labels.indexOf('release'))
	})

	test('(b) and (c) an immediate stop before the first start, and concurrent failure and stops, end the run once', async () => {
		const sequence = createTestSequence()
		const guiding = new ScriptedGuidingSession({}, sequence)
		let release!: VoidFunction
		guiding.onPause = () =>
			new Promise((resolve) => {
				release = () => resolve(successfulOperationResult(undefined))
			})
		const harness = start(configurationOf([lights(1)]), { guiding, sequence })
		await waitUntil(() => release !== undefined, 2000, 1)

		void harness.runner.handle.stop('immediate')
		void harness.runner.handle.stop('graceful')
		harness.runner.dispose()
		release()

		const result = await finish(harness)
		expect(result.state).toBe('failed')
		expect(guiding.commands().filter((command) => command === 'endRun')).toHaveLength(1)
		expect(guiding.commands()).not.toContain('start')
	})

	test('(d) a failed shutdown step still ends the run', async () => {
		const harness = start(configurationOf([lights(1)]), { stopTracking: () => ({ ok: false, failure: { kind: 'operation', reason: 'timeout' } }) })
		const result = await finish(harness)
		expect(result.state).toBe('failed')
		expect(result.shutdownFailures).toHaveLength(1)
		expect(timeline(harness).slice(-3)).toEqual(['terminalDrain', 'endRun', 'release'])
	})

	test('(e) a refused run admission commands nothing and never ends a run', async () => {
		for (const [refusal, failure] of [
			[failedOperationResult('busy', 'another owner'), { kind: 'operation', reason: 'busy' }],
			[failedOperationResult('unexpectedState', 'ceiling below the configuration'), { kind: 'configuration' }],
		] as const) {
			const sequence = createTestSequence()
			const guiding = new ScriptedGuidingSession({}, sequence)
			guiding.beginRunResult = refusal
			const harness = start(configurationOf([lights(1)]), { guiding, sequence })
			const result = await finish(harness)

			expect(result).toMatchObject({ state: 'failed', failure })
			expect(guiding.commands()).toEqual(['beginRun'])
			expect(harness.trace).toEqual([])
			expect(timeline(harness).slice(-2)).toEqual(['terminalDrain', 'release'])
		}
	})

	test('a pause that never quiesces is cut at guiding.pauseTimeout', async () => {
		const coordinator = new OperationCoordinator(new ResourceArbiter())
		const clock = new ManualSequencerClock()
		const guiding = new ScriptedGuidingSession()
		guiding.onPause = (scope) =>
			new Promise((resolve) => {
				scope.signal.addEventListener('abort', () => resolve(failedOperationResult('aborted')), { once: true })
			})

		const pending = pauseSequencerGuiding(coordinator, guiding, 5, clock)
		await clock.advance(4999)
		expect(clock.pending).toBe(1)
		await clock.advance(1)
		expect(await pending).toMatchObject({ ok: false, reason: 'timeout' })
		expect(clock.pending).toBe(0)
	})

	test('a failed shutdown pause stops guiding and fails as guidingNotQuiescent; tracking still stops in between', async () => {
		const sequence = createTestSequence()
		const guiding = new ScriptedGuidingSession({}, sequence)
		let pauses = 0
		// The startup quiescence succeeds; the pause of the shutdown fails.
		guiding.onPause = () => (++pauses === 1 ? successfulOperationResult(undefined) : failedOperationResult('timeout'))
		const harness = start(configurationOf([lights(1)], { dither: undefined }), { guiding, sequence })
		const result = await finish(harness)

		expect(result.state).toBe('failed')
		expect(result.shutdownFailures).toEqual([{ kind: 'operation', reason: 'timeout', task: 'pauseGuiding', detail: 'guidingNotQuiescent' }])
		const labels = timeline(harness)
		expect(labels.slice(labels.lastIndexOf('pause'))).toEqual(['pause', 'stop', 'guiding:end', 'stopTracking', 'terminalDrain', 'endRun', 'release'])
	})
})

describe('preflight', () => {
	const guided = configurationOf([lights(1)])

	test('guiding needs a session whose quiescence bound fits the pause timeout, holding no commanded device', () => {
		const commanded = sequencerResourceRequests(guided, { camera: CAMERA }).map((request) => request.key)
		expect(preflightSequencerGuiding(guided, { camera: CAMERA }, {}, commanded).map((diagnostic) => diagnostic.path)).toEqual(['guiding', 'dither'])

		const fits = new ScriptedGuidingSession({ bound: 5000 })
		expect(preflightSequencerGuiding(guided, { camera: CAMERA }, { guiding: fits, ditherer: fits }, commanded)).toEqual([])

		// 69: one millisecond above the pause timeout is refused.
		const above = new ScriptedGuidingSession({ bound: 5001 })
		expect(preflightSequencerGuiding(guided, { camera: CAMERA }, { guiding: above, ditherer: above }, commanded).map((diagnostic) => diagnostic.path)).toEqual(['guiding.pauseTimeout'])

		const holding = new ScriptedGuidingSession({ hold: [{ key: resourceKey(CAMERA), device: CAMERA }] })
		expect(preflightSequencerGuiding(guided, { camera: CAMERA }, { guiding: holding, ditherer: holding }, commanded)).toEqual([{ path: 'guiding', message: `holds ${CAMERA.name}, a device the session commands` }])
	})

	test('15: a mount ditherer never dithers a guided session, and by pulse needs its directions and a pulsing guide output', async () => {
		const rig = await createRig()
		const { mount, guideOutput } = rig.devices()
		const angular: SequencerDitherConfiguration = { ...DITHER, amount: { unit: 'angle', value: arcsec(3) }, settle: { kind: 'mechanical', time: 0 } }
		const pulser = (options: Partial<MountDitherer['options']> = {}) => new MountDitherer(mount, guideOutput, { guideOutputCommander: rig.commanders.guideOutput }, { method: 'pulse', pattern: 'random', rightAscensionDirection: 'EAST', declinationDirection: 'NORTH', maxPulseDuration: 2000, ...options })
		const paths = (configuration: SequencerConfiguration, ditherer: MountDitherer) => preflightSequencerGuiding(configuration, { camera: CAMERA, mount }, { guiding: new ScriptedGuidingSession(), ditherer }, []).map((diagnostic) => diagnostic.message)

		expect(paths({ ...guided, guiding: undefined, dither: angular }, pulser())).toEqual([])
		expect(paths({ ...guided, dither: angular }, pulser())).toEqual(['a mount ditherer cannot dither a guided session'])
		expect(paths({ ...guided, guiding: undefined, dither: angular }, pulser({ rightAscensionDirection: undefined }))).toEqual(['a pulse mount ditherer needs both positive pulse directions'])
		expect(paths({ ...guided, guiding: undefined, dither: angular }, pulser({ maxPulseDuration: Number.NaN }))).toEqual(['a pulse mount ditherer needs a finite positive maxPulseDuration'])
		expect(paths({ ...guided, guiding: undefined, dither: angular }, new MountDitherer(mount, { ...guideOutput, canPulseGuide: false }, {}, pulser().options))).toEqual(['a pulse mount ditherer needs a guide output that can pulse'])
		expect(paths({ ...guided, guiding: undefined, dither: DITHER }, pulser())).toEqual(['the ditherer does not accept its amount or settle'])
	})
})

// The INDI simulator rig, created once for the sessions below and the preflight that needs real devices.
let rigInstance: Awaited<ReturnType<typeof createSequencerRig>> | undefined

async function createRig() {
	if (rigInstance === undefined) {
		rigInstance = await createSequencerRig()
		await connectSequencerRig(rigInstance)
	}

	return rigInstance
}

afterAll(async () => {
	await rigInstance?.[Symbol.asyncDispose]()
})

describe('sessions on the simulators', () => {
	let rig: Awaited<ReturnType<typeof createSequencerRig>>
	let clock: SequencerClock
	const ROOT = join(STORAGE_ROOT, 'rig')

	beforeAll(async () => {
		rig = await createRig()
		clock = { wallNow: () => rig.simulators.mount.utcTime, monotonicNow: () => performance.now(), delay: abortableDelay }
	})

	beforeEach(async () => {
		await resetSequencerRig(rig, rig.devices().focuser.position.value)
	})

	afterEach(async () => {
		await expectNoSequencerLeaks(rig)
	})

	// Runs one session on the rig with the given guiding services, startup and pre-capture tasks.
	async function run(configuration: SequencerConfiguration, services: SequencerGuidingServices, sequence: TestSequence, extra: { readonly startup?: readonly SequencerTask[]; readonly pointing?: boolean } = {}) {
		const devices = recordDevices(rig, clock, sequence)
		const roots = recordRunner(rig.coordinator, sequence)
		const storage = new FileSystemSequencerStorage({ root: ROOT, sessionId: Bun.randomUUIDv7(), wallNow: clock.wallNow })
		const lifecycle = { mountCommander: rig.commanders.mount }
		const { camera, mount } = rig.devices()
		const phases: SequencerRunnerPhases = {
			startup: [...sequencerGuidingStartupTasks(configuration, services), ...(extra.startup ?? []), ...sequencerStartupLifecycleTasks(configuration, lifecycle)],
			preCapture: [ensureTrackingTask(lifecycle, configuration), ...(extra.pointing === true ? sequencerPointingTasks(configuration, { mountCommander: rig.commanders.mount, guiding: services.guiding }) : []), ...sequencerGuidingTasks(configuration, services), prepareFrameDestinationTask(storage)],
			capture: captureFrameStep({ cameraCapturer: rig.capturer, storage }),
			shutdown: sequencerShutdownTasks(configuration, services, sequencerShutdownLifecycleTasks(configuration.shutdown, lifecycle)),
		}

		const runner = startSequencerRunner({ configuration, devices: { camera, mount }, services: { coordinator: rig.coordinator, storage, clock, listener: roots.listener, guiding: services.guiding, ditherer: services.ditherer }, phases })

		try {
			const result = await runner.handle.result
			return { result, devices: devices.entries, roots: roots.entries }
		} finally {
			devices[Symbol.dispose]()
			roots[Symbol.dispose]()
		}
	}

	test('4: dither without guiding by pulses: none before the first light, one before each later one, never during an exposure', async () => {
		const sequence = createTestSequence()
		const { mount, guideOutput } = rig.devices()
		const ditherer = new MountDitherer(mount, guideOutput, { guideOutputCommander: rig.commanders.guideOutput, delay: clock.delay }, { method: 'pulse', pattern: 'spiral', rightAscensionDirection: 'EAST', declinationDirection: 'NORTH', maxPulseDuration: 3000 })
		const configuration = configurationOf([lights(3)], { guiding: undefined, dither: { ...DITHER, amount: { unit: 'angle', value: arcsec(2) }, settle: { kind: 'mechanical', time: 0.05 } }, shutdown: { stepTimeout: 30, totalTimeout: 300 } })

		const { result, devices, roots } = await run(configuration, { ditherer }, sequence)
		expect(result.state).toBe('completed')

		const commands = devices.filter((entry): entry is DeviceCommandEntry => entry.kind === 'command')
		const pulses = commands.filter((entry) => entry.manager === 'guideOutput' && entry.command === 'pulse' && (entry.args[1] as number) > 0)
		const exposures = commands.filter((entry) => entry.manager === 'camera' && entry.command === 'startExposure')
		expect(exposures).toHaveLength(3)
		expect(pulses).toHaveLength(2)
		expect(pulses[0].sequence).toBeGreaterThan(exposures[0].sequence)
		expect(pulses[0].sequence).toBeLessThan(exposures[1].sequence)
		expect(pulses[1].sequence).toBeGreaterThan(exposures[1].sequence)
		expect(pulses[1].sequence).toBeLessThan(exposures[2].sequence)

		// The barrier of inherited pulses was proved by observation before the run went on.
		const tasks = roots.flatMap((entry) => (entry.kind === 'event' && entry.event.type === 'taskCompleted' ? [entry.event.task] : []))
		expect(tasks).toContain('quiesceDitherPulses')
		expect(rig.commanders.guideOutput.dispatchedPulseWindow(guideOutput)).toBeUndefined()

		// I2: no pulse overlaps an exposure.
		assertSequencerInvariants(devices)
		assertRunnerInvariants(roots)
	}, 30000)

	test('5: a guided session pauses guiding before the acquisition slew and starts it after, then dithers before the second light', async () => {
		const sequence = createTestSequence()
		const guiding = new ScriptedGuidingSession({}, sequence)
		const [rightAscension, declination] = equatorialToJ2000(RIG_INITIAL_POINTING.rightAscension, RIG_INITIAL_POINTING.declination + deg(1), timeUnix(clock.wallNow() / 1000))
		const configuration = configurationOf([lights(2)], { target: { frame: 'J2000', rightAscension: normalizeAngle(rightAscension), declination }, pointing: { settle: 0.1, onFailure: 'fail' }, startup: { mount: { unpark: true }, onFailure: 'fail' } })

		const { result, devices, roots } = await run(configuration, { guiding, ditherer: guiding }, sequence, { pointing: true })
		expect(result.state).toBe('completed')

		const commands = devices.filter((entry): entry is DeviceCommandEntry => entry.kind === 'command')
		const goTo = commands.find((entry) => entry.manager === 'mount' && entry.command === 'goTo')!
		const exposures = commands.filter((entry) => entry.manager === 'camera' && entry.command === 'startExposure')
		const at = (command: string, nth = 0) => {
			const matching = guiding.log.filter((entry) => entry.command === command)
			return matching[nth].sequence
		}

		// I7: guiding is paused before the slew and started only after it; the dither comes after the first light.
		expect(at('pause', 1)).toBeLessThan(goTo.sequence)
		expect(at('start')).toBeGreaterThan(goTo.sequence)
		expect(at('start')).toBeLessThan(exposures[0].sequence)
		expect(at('dither')).toBeGreaterThan(exposures[0].sequence)
		expect(at('dither')).toBeLessThan(exposures[1].sequence)

		// No mount motion while guiding was active (between a start and the next pause).
		for (const motion of commands.filter((entry) => entry.manager === 'mount' && (entry.command === 'goTo' || entry.command === 'syncTo'))) {
			const last = guiding.log.findLast((entry) => entry.sequence < motion.sequence && (entry.command === 'start' || entry.command === 'resume' || entry.command === 'pause'))
			expect(last?.command).toBe('pause')
		}

		assertSequencerInvariants(devices)
		assertRunnerInvariants(roots)
	}, 30000)
})
