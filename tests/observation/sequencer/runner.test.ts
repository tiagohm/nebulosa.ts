import { afterAll, afterEach, describe, expect, spyOn, test } from 'bun:test'
import { readdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { basename, join, sep } from 'path'
import type { FocuserCommander } from '../../../src/devices/commanders/focuser'
import type { WheelCommander } from '../../../src/devices/commanders/wheel'
import { type Camera, type Cover, DEFAULT_CAMERA, DEFAULT_COVER, DEFAULT_DOME, DEFAULT_FLAT_PANEL, DEFAULT_FOCUSER, DEFAULT_MOUNT, DEFAULT_ROTATOR, DEFAULT_WHEEL, type Device, type Dome, type FlatPanel, type Focuser, type Mount, type Rotator, type Wheel } from '../../../src/devices/indi/device'
import { failedOperationResult, OperationCoordinator, type OperationContext, type OperationResult, successfulOperationResult } from '../../../src/devices/orchestration/operation'
import { ResourceArbiter, resourceKey } from '../../../src/devices/orchestration/resource'
import { mulberry32, type Random } from '../../../src/math/numerical/random'
// oxfmt-ignore
import { SEQUENCER_REENTRY_LIMIT, type SequencerCaptureContext, type SequencerCapturedFrame, type SequencerCaptureStep, type SequencerContext, type SequencerProtectionOutcome, type SequencerRunner, type SequencerRunnerPhases, sequencerResourceRequests, sequencerRetryDelay, type SequencerShutdownTask, type SequencerSupervisor, type SequencerSupervisorHost, type SequencerTask, type SequencerTaskPolicy, type SequencerTaskResult, startSequencerRunner } from '../../../src/observation/sequencer/runner'
// oxfmt-ignore
import type { SequencerCameraCapture, SequencerCaptureConfiguration, SequencerCheckpointStore, SequencerConfiguration, SequencerDevices, SequencerEvent, SequencerFailure, SequencerFrameDiscardPolicy, SequencerFrameGroup, SequencerFrameSlotSnapshot, SequencerQualityAnalyzer, SequencerQualityFrame, SequencerQualityResult, SequencerResult, SequencerSafetySnapshot, SequencerSafetySource, SequencerSessionState, SequencerShutdownStepPolicy, SequencerTaskId, SequencerTriggeredFrameGroup } from '../../../src/observation/sequencer/sequencer'
import { mountKeyHolders } from '../../../src/observation/sequencer/pointing'
import { pushSequencerCompensation } from '../../../src/observation/sequencer/state'
import { FileSystemSequencerCheckpointStore, FileSystemSequencerStorage, prepareFrameDestinationTask, readSequencerJournal } from '../../../src/observation/sequencer/storage'
import { isTimeConsumingTestSkipped, waitUntil } from '../../util'
// oxfmt-ignore
import { assertJournalInvariants, assertRunnerInvariants, connectSequencerRig, createSequencerRig, injectFileSystemFaults, ManualSequencerClock, type RunnerLogEntry, type RunnerOracleOptions, type RunnerRecorder, recordRunner, resetSequencerRig, ScriptedGuidingSession } from './util'

const LIGHT: SequencerCameraCapture = { exposureTime: 60, exposureTimeUnit: 'second', frameType: 'LIGHT', x: 0, y: 0, width: 0, height: 0, subframe: false, binX: 1, binY: 1, frameFormat: '', gain: 100, offset: 10, compressed: false }
const DARK: SequencerCameraCapture = { ...LIGHT, frameType: 'DARK' }

const CAMERA = fakeDevice<Camera>(DEFAULT_CAMERA, 'Camera')
const DEVICES: SequencerDevices = { camera: CAMERA }

const OK: SequencerTaskResult = { ok: true }
const ABORTED: SequencerTaskResult = { ok: false, failure: { kind: 'operation', reason: 'aborted' } }

// Connected view of a fake device whose resource key is its name.
function fakeDevice<D extends Device>(base: D, name: string): D {
	return { ...base, id: name, name, hardwareId: name, connected: true }
}

// Fake commander move that never finishes on its own and ends `aborted` with its root.
function untilAborted(scope: OperationContext) {
	return new Promise<OperationResult<void>>((resolve) => {
		scope.signal.addEventListener('abort', () => resolve(failedOperationResult('aborted')), { once: true })
	})
}

function failure(reason: Extract<SequencerFailure, { readonly kind: 'operation' }>['reason']): SequencerTaskResult {
	return { ok: false, failure: { kind: 'operation', reason } }
}

function scheduled(id: string, count: number): SequencerFrameGroup {
	return { kind: 'scheduled', id, enabled: true, capture: LIGHT, count, weight: 1 }
}

function sessionEnd(id: string, batchSize: number, onStop: boolean): SequencerTriggeredFrameGroup {
	return { kind: 'triggered', id, enabled: true, capture: DARK, trigger: { kind: 'sessionEnd', onStop }, batchSize, maxFrames: batchSize, inherit: 'none', opticalPath: { kind: 'none' } }
}

function configurationOf(groups: readonly SequencerFrameGroup[] = [scheduled('L', 1)], capture: Partial<SequencerCaptureConfiguration> = {}, patch: Partial<SequencerConfiguration> = {}): SequencerConfiguration {
	return {
		schemaVersion: 1,
		id: 'session',
		revision: 1,
		name: 'Session',
		capture: { order: 'sequential', groups, retry: { maxAttempts: 2, delay: 1, backoff: 2, maximumDelay: 10, retryOn: ['timeout'] }, onFailure: 'fail', cameraRecovery: { onTimeout: 'stop' }, ...capture },
		startup: { onFailure: 'fail' },
		shutdown: { stepTimeout: 30, totalTimeout: 300 },
		execution: { compensation: { timeout: 30 } },
		...patch,
	}
}

// Behaviour of a fake task or capture.
type Behaviour<T> = (context: SequencerContext) => T | Promise<T>

// Execution of a fake that waits for the test.
interface Blocked {
	// Trace label of the execution.
	readonly label: string
	readonly context: SequencerContext
	readonly capture: boolean
	readonly settle: (value: SequencerTaskResult | OperationResult<SequencerCapturedFrame>) => void
}

// Bytes of a fake frame.
const FRAME = Buffer.from('SIMPLE  =                    T')

// Successful capture of the frame of the context, written to the temporary of its destination.
function captured(context: SequencerContext): OperationResult<SequencerCapturedFrame> {
	writeFileSync((context as SequencerCaptureContext).destination.temporary, FRAME)
	const at = context.clock.wallNow()
	const monotonic = context.clock.monotonicNow()
	return successfulOperationResult({ exposureDispatchedAt: at, exposureDispatchedMonotonic: monotonic, exposureStartedAt: at, exposureStartedMonotonic: monotonic, exposureFinishedAt: at, exposureFinishedMonotonic: monotonic })
}

// Fake task lists, given to the runner as its phases (read when each phase runs): every execution is traced as
// `{task}` or `{task}@{slot}`, and `capture@{slot}#{attempt}`.
class Script implements SequencerRunnerPhases {
	readonly trace: string[] = []
	readonly blocked: Blocked[] = []
	startup: SequencerTask[] = []
	preCapture: SequencerTask[] = []
	shutdown: SequencerShutdownTask[] = []
	capture: SequencerCaptureStep = this.captureStep()

	task(id: SequencerTaskId, behaviour: Behaviour<SequencerTaskResult> = () => OK, policy?: SequencerTaskPolicy): SequencerTask {
		return {
			id,
			shouldRun: () => true,
			run: async (context) => {
				this.trace.push(context.frame === undefined ? id : `${id}@${context.frame.id}`)
				return await behaviour(context)
			},
			...(policy !== undefined && { policy }),
		}
	}

	shutdownTask(id: SequencerTaskId, policy: SequencerShutdownStepPolicy = 'required', behaviour: Behaviour<SequencerTaskResult> = () => OK): SequencerShutdownTask {
		const { shouldRun, run } = this.task(id, behaviour)
		return { id, shouldRun, run, policy }
	}

	// Capture step that asks `beforeExposure` first, as the capturer does right before dispatching: a refusal ends it
	// with that failure, otherwise the exposure counts as commanded and the behaviour plays it.
	captureStep(behaviour: Behaviour<OperationResult<SequencerCapturedFrame>> = captured): SequencerCaptureStep {
		return async (context) => {
			this.trace.push(`capture@${context.frame!.id}#${context.frame!.attempt}`)
			const refusal = context.beforeExposure()
			if (refusal !== undefined) return refusal
			context.exposureStarted()
			return await behaviour(context)
		}
	}

	// Waits for the test to settle it; a cooperative block settles `aborted` when its root aborts, a stuck one never.
	block<T extends SequencerTaskResult | OperationResult<SequencerCapturedFrame>>(capture: boolean, stuck = false): Behaviour<T> {
		return (context) =>
			new Promise<T>((resolve) => {
				const label = this.trace.at(-1)!
				const blocked: Blocked = {
					label,
					context,
					capture,
					settle: (value) => {
						const index = this.blocked.indexOf(blocked)
						if (index < 0) return
						this.blocked.splice(index, 1)
						resolve(value as T)
					},
				}

				this.blocked.push(blocked)
				if (!stuck) context.signal.addEventListener('abort', () => blocked.settle(capture ? failedOperationResult('aborted') : ABORTED), { once: true })
			})
	}

	blockTask(stuck = false) {
		return this.block<SequencerTaskResult>(false, stuck)
	}

	blockCapture() {
		return this.block<OperationResult<SequencerCapturedFrame>>(true)
	}

	// Waits until an execution whose label starts with `prefix` is blocked.
	async waitBlocked(prefix: string) {
		await waitUntil(() => this.blocked.some((blocked) => blocked.label.startsWith(prefix)), 2000, 1)
		return this.blocked.find((blocked) => blocked.label.startsWith(prefix))!
	}
}

// One session under test with its recorder and clock.
interface Harness {
	readonly runner: SequencerRunner
	readonly script: Script
	readonly coordinator: OperationCoordinator
	readonly recorder: RunnerRecorder
	readonly clock: ManualSequencerClock
	readonly devices: SequencerDevices
	readonly storage: FileSystemSequencerStorage
}

const recorders: RunnerRecorder[] = []

// Root of the session directories of this file.
const STORAGE_ROOT = await mkdtemp(join(tmpdir(), 'nebulosa-sequencer-runner-'))

afterEach(() => {
	for (const recorder of recorders.splice(0)) recorder[Symbol.dispose]()
})

afterAll(async () => {
	await rm(STORAGE_ROOT, { recursive: true, force: true })
})

interface HarnessOptions {
	readonly devices?: SequencerDevices
	readonly coordinator?: OperationCoordinator
	readonly clock?: ManualSequencerClock
	readonly focuserCommander?: FocuserCommander
	readonly wheelCommander?: WheelCommander
	readonly disposeSignal?: AbortSignal
	// Pre-capture tasks after the frame destination (the final guard).
	readonly afterPrepare?: readonly SequencerTask[]
	// Synchronous check right before the dispatch.
	readonly exposureRefusal?: SequencerRunnerPhases['exposureRefusal']
	// Called synchronously with each event, after the recorder.
	readonly onEvent?: (event: SequencerEvent, runner: SequencerRunner) => void
	// Meridian supervisor of the session.
	readonly supervisor?: SequencerSupervisor
	// Quality analyzer of the primary frames.
	readonly qualityAnalyzer?: SequencerQualityAnalyzer
	// Safety source of the session.
	readonly safety?: SequencerSafetySource
	// Guiding session of the guiding feature.
	readonly guiding?: ScriptedGuidingSession
	// Checkpoint store; none by default.
	readonly checkpointStore?: SequencerCheckpointStore
	// Session to run (a restart of an earlier one); a new one by default.
	readonly sessionId?: string
}

function start(configuration: SequencerConfiguration, script: Script, options: HarnessOptions = {}): Harness {
	const coordinator = options.coordinator ?? new OperationCoordinator(new ResourceArbiter())
	const clock = options.clock ?? new ManualSequencerClock()
	const devices = options.devices ?? DEVICES
	const recorder = recordRunner(coordinator)
	recorders.push(recorder)
	const { focuserCommander, wheelCommander, disposeSignal, qualityAnalyzer, safety, guiding, checkpointStore } = options
	const storage = new FileSystemSequencerStorage({ root: STORAGE_ROOT, sessionId: options.sessionId ?? Bun.randomUUIDv7(), wallNow: clock.wallNow })
	const session: { runner?: SequencerRunner } = {}
	const listener = (event: SequencerEvent) => {
		recorder.listener(event)
		if (session.runner !== undefined) options.onEvent?.(event, session.runner)
	}
	// oxfmt-ignore
	const services = { coordinator, storage, clock, listener, ...(focuserCommander !== undefined && { focuserCommander }), ...(wheelCommander !== undefined && { wheelCommander }), ...(qualityAnalyzer !== undefined && { qualityAnalyzer }), ...(safety !== undefined && { safety }), ...(guiding !== undefined && { guiding }), ...(checkpointStore !== undefined && { checkpointStore }) }
	// The script is read when each phase runs; the frame destination is always prepared last.
	const prepare = prepareFrameDestinationTask(storage)
	const phases: SequencerRunnerPhases = {
		get startup() {
			return script.startup
		},
		get preCapture() {
			return [...script.preCapture, prepare, ...(options.afterPrepare ?? [])]
		},
		get capture() {
			return script.capture
		},
		get shutdown() {
			return script.shutdown
		},
		...(options.exposureRefusal !== undefined && { exposureRefusal: options.exposureRefusal }),
		...(options.supervisor !== undefined && { supervisor: options.supervisor }),
	}
	const runner = startSequencerRunner({ configuration, devices, services, phases, ...(disposeSignal !== undefined && { disposeSignal }) })
	session.runner = runner
	return { runner, script, coordinator, recorder, clock, devices, storage }
}

function events(harness: Harness): SequencerEvent[] {
	return harness.recorder.entries.flatMap((entry) => (entry.kind === 'event' ? [entry.event] : []))
}

function states(harness: Harness) {
	return events(harness).flatMap((event) => (event.type === 'stateChanged' ? [event.state] : []))
}

// Sequence of the first event of `type` (optionally matching), or Infinity.
function sequenceOf(harness: Harness, predicate: (entry: RunnerLogEntry) => boolean) {
	return harness.recorder.entries.find(predicate)?.sequence ?? Infinity
}

function isEvent(type: SequencerEvent['type']) {
	return (entry: RunnerLogEntry) => entry.kind === 'event' && entry.event.type === type
}

async function waitState(harness: Harness, state: SequencerSessionState) {
	await waitUntil(() => harness.runner.snapshot().state === state, 2000, 1)
}

// Awaits the result, then checks the runner oracle and that nothing outlived the session.
async function finish(harness: Harness, options?: RunnerOracleOptions): Promise<SequencerResult> {
	const result = await harness.runner.handle.result
	assertRunnerInvariants(harness.recorder.entries, options)
	const { arbiter } = harness.coordinator

	for (const device of Object.values(harness.devices) as Device[]) {
		expect(arbiter.reservationOwnerOf(resourceKey(device))).toBeUndefined()
		expect(arbiter.ownersOf(resourceKey(device))).toEqual([])
	}

	expect(harness.clock.pending).toBe(0)
	return result
}

function progressOf(result: SequencerResult, groupId: string) {
	return result.capture.groups.find((group) => group.groupId === groupId)!
}

describe('resource requests', () => {
	const mount = fakeDevice<Mount>(DEFAULT_MOUNT, 'Mount')
	const wheel = fakeDevice<Wheel>(DEFAULT_WHEEL, 'Wheel')
	const focuser = fakeDevice<Focuser>(DEFAULT_FOCUSER, 'Focuser')
	const rotator = fakeDevice<Rotator>(DEFAULT_ROTATOR, 'Rotator')
	const cover = fakeDevice<Cover>(DEFAULT_COVER, 'Cover')
	const dome = fakeDevice<Dome>(DEFAULT_DOME, 'Dome')
	const flatPanel = fakeDevice<FlatPanel>(DEFAULT_FLAT_PANEL, 'Flat Panel')
	const all: SequencerDevices = { camera: CAMERA, mount, wheel, focuser, rotator, cover, dome, flatPanel }
	const keys = (configuration: SequencerConfiguration, devices: SequencerDevices = all) => sequencerResourceRequests(configuration, devices).map((request) => request.key)

	test('the camera always, every other device only for an enabled feature that commands it', () => {
		expect(keys(configurationOf())).toEqual(['Camera'])
		expect(keys(configurationOf([{ ...scheduled('L', 1), filter: { kind: 'slot', slot: 0 } }]))).toEqual(['Camera', 'Wheel'])
		expect(keys(configurationOf([{ ...scheduled('L', 1), enabled: false, filter: { kind: 'slot', slot: 0 } }]))).toEqual(['Camera'])
		expect(keys(configurationOf([{ ...sessionEnd('D', 1, false), opticalPath: { kind: 'cover' } }]))).toEqual(['Camera', 'Cover'])
		expect(keys(configurationOf(undefined, { focusOffsets: { reference: 'L', offsets: {} } }))).toEqual(['Camera', 'Focuser'])
		expect(keys(configurationOf(undefined, undefined, { target: { frame: 'J2000', rightAscension: 1, declination: 0.5 } }))).toEqual(['Camera', 'Mount'])
		expect(keys(configurationOf(undefined, undefined, { rotator: { angle: 0, tolerance: 0.01, settle: 0, onFailure: 'fail' } }))).toEqual(['Camera', 'Rotator'])
		expect(keys(configurationOf(undefined, undefined, { startup: { dome: { open: true }, cover: { open: true }, mount: { unpark: true }, onFailure: 'fail' } }))).toEqual(['Camera', 'Mount', 'Cover', 'Dome'])
		expect(keys(configurationOf(undefined, undefined, { shutdown: { stepTimeout: 1, totalTimeout: 10, parkMount: 'required', closeCover: 'required', closeOrParkDome: 'required', turnOffFlatPanel: 'bestEffort' } }))).toEqual(['Camera', 'Mount', 'Cover', 'Dome', 'Flat Panel'])
	})

	test('a feature whose device is absent reserves nothing for it', () => {
		expect(keys(configurationOf(undefined, undefined, { shutdown: { stepTimeout: 1, totalTimeout: 10, parkMount: 'required' } }), DEVICES)).toEqual(['Camera'])
	})

	test('retry delay grows by the backoff up to its ceiling, in ms', () => {
		const retry = { maxAttempts: 5, delay: 1, backoff: 2, maximumDelay: 5, retryOn: [] }
		expect([1, 2, 3, 4].map((n) => sequencerRetryDelay(retry, n))).toEqual([1000, 2000, 4000, 5000])
	})
})

describe('49.4 lifecycle', () => {
	test('1: a refused reservation fails busy with no task, no shutdown and the other reservation intact', async () => {
		const coordinator = new OperationCoordinator(new ResourceArbiter())
		const other = { id: 'other', kind: 'test' }
		expect(coordinator.arbiter.reserve(other, [{ key: resourceKey(CAMERA), device: CAMERA }]).ok).toBeTrue()

		const script = new Script()
		script.startup = [script.task('coolCamera')]
		script.shutdown = [script.shutdownTask('warmCamera')]
		const harness = start(configurationOf(), script, { coordinator })
		const result = await harness.runner.handle.result

		expect(result).toMatchObject({ state: 'failed', failure: { kind: 'operation', reason: 'busy' }, shutdownFailures: [] })
		expect(script.trace).toEqual([])
		expect(states(harness)).toEqual(['failed'])
		expect(events(harness).some((event) => event.type === 'sessionStarted' || event.type === 'shutdownStarted')).toBeFalse()
		expect(coordinator.arbiter.reservationOwnerOf(resourceKey(CAMERA))).toBe(other)
		assertRunnerInvariants(harness.recorder.entries)
	})

	test('1: the reservation exists before the first task', async () => {
		const script = new Script()
		let owner: string | undefined
		const harness = start(configurationOf([]), script)
		script.startup = [script.task('coolCamera', () => ((owner = harness.coordinator.arbiter.reservationOwnerOf(resourceKey(CAMERA))?.id), OK))]

		expect((await finish(harness)).state).toBe('completed')
		expect(owner).toBe(harness.runner.id)
	})

	test('2: startup, then select → pre-capture → capture → post-capture per frame, then the shutdown', async () => {
		const script = new Script()
		script.startup = [script.task('coolCamera'), script.task('openCover')]
		script.preCapture = [script.task('prepareOpticalPath'), script.task('autofocus')]
		script.shutdown = [script.shutdownTask('closeCover'), script.shutdownTask('warmCamera', 'bestEffort')]
		const harness = start(configurationOf([scheduled('L', 2), scheduled('R', 1)]), script)
		const result = await finish(harness)

		expect(result).toMatchObject({ state: 'completed', shutdownFailures: [], compensationFailures: [] })
		expect(result.failure).toBeUndefined()
		expect(progressOf(result, 'L')).toMatchObject({ requested: 2, accepted: 2 })
		expect(progressOf(result, 'R')).toMatchObject({ requested: 1, accepted: 1 })

		const frame = (slot: string) => [`prepareOpticalPath@${slot}`, `autofocus@${slot}`, `capture@${slot}#1`]
		expect(script.trace).toEqual(['coolCamera', 'openCover', ...frame('frame[L][1]'), ...frame('frame[L][2]'), ...frame('frame[R][1]'), 'closeCover', 'warmCamera'])
		expect(states(harness)).toEqual(['running', 'shuttingDown', 'completed'])

		const phases = events(harness).flatMap((event) => (event.type === 'phaseChanged' ? [event.phase] : []))
		expect(phases).toEqual(['startup', 'preCapture', 'capture', 'postCapture', 'preCapture', 'capture', 'postCapture', 'preCapture', 'capture', 'postCapture', 'shutdown'])
		expect(events(harness).flatMap((event) => (event.type === 'frameAccepted' ? [basename(event.path)] : []))).toEqual(['frame[L][1].fit', 'frame[L][2].fit', 'frame[R][1].fit'])
		expect(events(harness).at(-1)).toMatchObject({ type: 'sessionCompleted', sessionId: harness.runner.id, result })
	})

	test('2: an empty capture runs only the startup and the shutdown', async () => {
		const script = new Script()
		script.startup = [script.task('coolCamera')]
		script.preCapture = [script.task('autofocus')]
		script.shutdown = [script.shutdownTask('warmCamera')]
		const result = await finish(start(configurationOf([]), script))

		expect(result.state).toBe('completed')
		expect(script.trace).toEqual(['coolCamera', 'warmCamera'])
	})

	test('3: a failed startup still shuts down, and the primary failure stays apart from the shutdown', async () => {
		const script = new Script()
		script.startup = [script.task('coolCamera', () => failure('timeout')), script.task('openCover')]
		script.shutdown = [script.shutdownTask('closeCover'), script.shutdownTask('warmCamera')]
		const harness = start(configurationOf(), script)
		const result = await finish(harness)

		expect(result).toMatchObject({ state: 'failed', failure: { kind: 'operation', reason: 'timeout', task: 'coolCamera' }, shutdownFailures: [] })
		expect(script.trace).toEqual(['coolCamera', 'closeCover', 'warmCamera'])
		expect(states(harness)).toEqual(['stopping', 'shuttingDown', 'failed'])
	})

	test('3: a startup retry policy retries on the monotonic clock before applying its action', async () => {
		const script = new Script()
		let attempts = 0
		script.startup = [script.task('coolCamera', () => (++attempts < 3 ? failure('timeout') : OK))]
		const harness = start(configurationOf([], undefined, { startup: { onFailure: 'stop', retry: { maxAttempts: 3, delay: 2, backoff: 1, maximumDelay: 2, retryOn: ['timeout'] } } }), script)

		await waitUntil(() => harness.clock.pending === 1, 2000, 1)
		await harness.clock.advance(1999)
		expect(attempts).toBe(1)
		await harness.clock.advance(1)
		await waitUntil(() => attempts === 2 && harness.clock.pending === 1, 2000, 1)
		await harness.clock.advance(2000)

		expect((await finish(harness)).state).toBe('completed')
		expect(attempts).toBe(3)
	})

	test('4: the reservation stays while paused, release follows the terminal drain, stop is idempotent', async () => {
		const script = new Script()
		script.capture = script.captureStep(script.blockCapture())
		script.shutdown = [script.shutdownTask('warmCamera')]
		const harness = start(configurationOf([scheduled('L', 2)]), script)
		const { handle } = harness.runner

		const blocked = await script.waitBlocked('capture@frame[L][1]')
		const paused = handle.pause()
		blocked.settle(captured(blocked.context))
		expect(await paused).toBe('paused')
		expect(harness.coordinator.arbiter.reservationOwnerOf(resourceKey(CAMERA))?.id).toBe(handle.id)

		let resolutions = 0
		void handle.result.then(() => resolutions++)
		const first = handle.stop()
		const second = handle.stop()
		const [a, b] = await Promise.all([first, second])

		expect(a).toBe(b)
		expect(await handle.stop('immediate')).toBe(a)
		expect(a).toMatchObject({ state: 'stopped', stopCause: 'user' })
		expect(progressOf(a, 'L').accepted).toBe(1)
		await finish(harness)
		expect(resolutions).toBe(1)
		expect(events(harness).filter((event) => event.type === 'sessionStopped')).toHaveLength(1)
	})

	test('5: an unexpected exception in a task or its predicate fails with operation/commandFailed and still shuts down', async () => {
		const error = spyOn(console, 'error').mockImplementation(() => {})

		try {
			const script = new Script()
			script.preCapture = [
				script.task('autofocus', () => {
					throw new Error('boom')
				}),
			]
			script.shutdown = [script.shutdownTask('warmCamera')]
			const result = await finish(start(configurationOf(), script))
			expect(result).toMatchObject({ state: 'failed', failure: { kind: 'operation', reason: 'commandFailed', task: 'autofocus', detail: 'boom' } })
			expect(script.trace).toEqual(['autofocus@frame[L][1]', 'warmCamera'])

			const predicate = new Script()
			predicate.startup = [
				{
					...predicate.task('coolCamera'),
					shouldRun: () => {
						throw new Error('no camera')
					},
				},
			]
			predicate.shutdown = [predicate.shutdownTask('warmCamera')]
			const failed = await finish(start(configurationOf(), predicate))
			expect(failed).toMatchObject({ state: 'failed', failure: { kind: 'operation', reason: 'commandFailed', task: 'coolCamera', detail: 'no camera' } })
			expect(predicate.trace).toEqual(['warmCamera'])
		} finally {
			error.mockRestore()
		}
	})

	test('7: a capture retry waits on the monotonic clock: a wall jump never releases it', async () => {
		const script = new Script()
		let attempts = 0
		script.capture = script.captureStep((context) => (++attempts === 1 ? failedOperationResult('timeout') : captured(context)))
		const harness = start(configurationOf(), script)

		await waitUntil(() => harness.clock.pending === 1, 2000, 1)
		harness.clock.jumpWall(3600000)
		harness.clock.jumpWall(-7200000)
		await Bun.sleep(0)
		await harness.clock.advance(999)
		expect(attempts).toBe(1)
		await harness.clock.advance(1)

		const result = await finish(harness)
		expect(result.state).toBe('completed')
		expect(script.trace).toEqual(['capture@frame[L][1]#1', 'capture@frame[L][1]#2'])
		expect(events(harness).find((event) => event.type === 'frameAccepted')).toMatchObject({ slot: 'frame[L][1]', attempt: 2 })
	})
})

describe('failure policies', () => {
	const retry = { maxAttempts: 3, delay: 1, backoff: 2, maximumDelay: 10, retryOn: ['timeout' as const] }

	test('a pre-capture task retries its retryable reasons with backoff, then succeeds', async () => {
		const script = new Script()
		let attempts = 0
		script.preCapture = [script.task('autofocus', () => (++attempts < 3 ? failure('timeout') : OK), { retry, onFailure: 'fail' })]
		const harness = start(configurationOf(), script)

		await waitUntil(() => harness.clock.pending === 1, 2000, 1)
		await harness.clock.advance(1000)
		await waitUntil(() => attempts === 2 && harness.clock.pending === 1, 2000, 1)
		await harness.clock.advance(1999)
		expect(attempts).toBe(2)
		await harness.clock.advance(1)

		expect((await finish(harness)).state).toBe('completed')
		expect(attempts).toBe(3)
	})

	test('a reason outside retryOn applies the action at once; skip continues with the next task', async () => {
		const script = new Script()
		script.preCapture = [script.task('autofocus', () => failure('commandFailed'), { retry, onFailure: 'skip' }), script.task('ensureGuiding')]
		const harness = start(configurationOf(), script)
		const result = await finish(harness)

		expect(result.state).toBe('completed')
		expect(script.trace).toEqual(['autofocus@frame[L][1]', 'ensureGuiding@frame[L][1]', 'capture@frame[L][1]#1'])
		expect(events(harness).find((event) => event.type === 'taskFailed')).toMatchObject({ task: 'autofocus', phase: 'preCapture', failure: { reason: 'commandFailed', task: 'autofocus' } })
	})

	test('stop ends gracefully with the policy cause and keeps the failure', async () => {
		const script = new Script()
		script.preCapture = [script.task('autofocus', () => failure('alert'), { onFailure: 'stop' })]
		const result = await finish(start(configurationOf([scheduled('L', 2)]), script))

		expect(result).toMatchObject({ state: 'stopped', stopCause: 'policy', failure: { kind: 'operation', reason: 'alert', task: 'autofocus' } })
		expect(script.trace).toEqual(['autofocus@frame[L][1]'])
	})

	test('a fatal failure is never skipped: its skip action fails the session instead of exposing', async () => {
		const script = new Script()
		let attempts = 0
		const fatal: SequencerTaskResult = { ok: false, failure: { kind: 'operation', reason: 'commandFailed' }, fatal: true }
		script.preCapture = [script.task('autofocus', () => (++attempts, fatal), { retry, onFailure: 'skip' }), script.task('ensureGuiding')]
		const result = await finish(start(configurationOf(), script))

		expect(result).toMatchObject({ state: 'failed', failure: { kind: 'operation', reason: 'commandFailed', task: 'autofocus' } })
		expect(attempts).toBe(1)
		expect(script.trace).toEqual(['autofocus@frame[L][1]'])
	})

	test('a retry first runs the compensations the failed execution left pending', async () => {
		const script = new Script()
		const pending: number[] = []
		let attempts = 0
		script.preCapture = [
			script.task(
				'autofocus',
				(context) => {
					pending.push(context.state.compensations.length)
					if (++attempts > 1) return OK
					pushSequencerCompensation(context.state, { kind: 'focuserPosition', task: 'autofocus', position: 1234 })
					return { ok: false, failure: { kind: 'operation', reason: 'timeout' }, fatal: true }
				},
				{ retry, onFailure: 'skip' },
			),
		]
		const moves: number[] = []
		const focuser = fakeDevice<Focuser>(DEFAULT_FOCUSER, 'Focuser')
		const focuserCommander = { moveTo: (_scope: OperationContext, _focuser: Focuser, position: number) => (moves.push(position), Promise.resolve(successfulOperationResult(undefined))) } as unknown as FocuserCommander
		const harness = start(configurationOf(undefined, { focusOffsets: { reference: 'L', offsets: {} } }), script, { devices: { camera: CAMERA, focuser }, focuserCommander })

		await waitUntil(() => harness.clock.pending === 1, 2000, 1)
		expect(moves).toEqual([1234])
		await harness.clock.advance(1000)

		expect((await finish(harness)).state).toBe('completed')
		expect(pending).toEqual([0, 0])
	})

	test('a fatal failure with a pause action holds as configured', async () => {
		const script = new Script()
		let attempts = 0
		script.preCapture = [script.task('autofocus', () => (++attempts === 1 ? { ok: false, failure: { kind: 'operation', reason: 'commandFailed' }, fatal: true } : OK), { retry, onFailure: 'pause' })]
		const harness = start(configurationOf(), script)

		await waitState(harness, 'paused')
		expect(attempts).toBe(1)
		expect(harness.runner.handle.resume()).toBeTrue()
		expect((await finish(harness)).state).toBe('completed')
	})

	test('resume() marks the session resumed since its last autofocus', async () => {
		const script = new Script()
		const seen: boolean[] = []
		script.preCapture = [script.task('autofocus', (context) => (seen.push(context.state.resumedSinceAutofocus), seen.length === 1 ? failure('alert') : OK), { onFailure: 'pause' })]
		const harness = start(configurationOf(), script)

		await waitState(harness, 'paused')
		expect(harness.runner.handle.resume()).toBeTrue()
		expect((await finish(harness)).state).toBe('completed')
		expect(seen).toEqual([false, true])
	})

	test('pause holds; resume re-enters the pre-capture from its first task without a new attempt', async () => {
		const script = new Script()
		let attempts = 0
		script.preCapture = [script.task('prepareOpticalPath'), script.task('autofocus', () => (++attempts === 1 ? failure('alert') : OK), { onFailure: 'pause' })]
		const harness = start(configurationOf(), script)

		await waitState(harness, 'paused')
		expect(script.trace).toEqual(['prepareOpticalPath@frame[L][1]', 'autofocus@frame[L][1]'])
		expect(harness.runner.handle.resume()).toBeTrue()

		expect((await finish(harness)).state).toBe('completed')
		expect(script.trace).toEqual(['prepareOpticalPath@frame[L][1]', 'autofocus@frame[L][1]', 'prepareOpticalPath@frame[L][1]', 'autofocus@frame[L][1]', 'capture@frame[L][1]#1'])
	})

	test('capture: the slot is retried with a new attempt, then skipped once the budget is exhausted', async () => {
		const script = new Script()
		script.capture = script.captureStep((context) => (context.frame!.ordinal === 1 ? failedOperationResult('timeout') : captured(context)))
		const harness = start(configurationOf([scheduled('L', 2)], { onFailure: 'skipFrame' }), script)

		await waitUntil(() => harness.clock.pending === 1, 2000, 1)
		await harness.clock.advance(1000)
		const result = await finish(harness)

		expect(script.trace).toEqual(['capture@frame[L][1]#1', 'capture@frame[L][1]#2', 'capture@frame[L][2]#1'])
		expect(progressOf(result, 'L')).toMatchObject({ accepted: 1, skipped: 1 })
		expect(events(harness).find((event) => event.type === 'slotSkipped')).toMatchObject({ slot: 'frame[L][1]', reason: 'captureFailures' })
		expect(result.state).toBe('completed')
	})

	test('capture: pause applies at once to a reason outside retryOn; resume renews the budget of the slot', async () => {
		const script = new Script()
		let attempts = 0
		script.capture = script.captureStep((context) => (++attempts === 1 ? failedOperationResult('commandFailed') : captured(context)))
		const harness = start(configurationOf(undefined, { onFailure: 'pause' }), script)

		await waitState(harness, 'paused')
		expect(harness.runner.snapshot().currentFrame).toMatchObject({ id: 'frame[L][1]', attempt: 1, captureFailures: 1 })
		harness.runner.handle.resume()

		const result = await finish(harness)
		expect(result.state).toBe('completed')
		expect(events(harness).find((event) => event.type === 'frameSelected' && event.frame.attempt === 2)).toMatchObject({ frame: { captureFailures: 0 } })
	})

	test('capture: fail ends the session with the capture failure', async () => {
		const script = new Script()
		script.capture = script.captureStep(() => failedOperationResult('disconnected', 'camera lost'))
		const result = await finish(start(configurationOf([scheduled('L', 3)], { retry: { ...retry, maxAttempts: 1 } }), script))

		expect(result).toMatchObject({ state: 'failed', failure: { kind: 'operation', reason: 'disconnected', task: 'captureFrame', detail: 'camera lost' } })
		expect(script.trace).toEqual(['capture@frame[L][1]#1'])
	})

	test('shutdown: a failed required step fails the session, a bestEffort one is only reported, and both let the next steps run', async () => {
		const required = new Script()
		required.shutdown = [required.shutdownTask('closeCover', 'required', () => failure('alert')), required.shutdownTask('warmCamera')]
		const failed = await finish(start(configurationOf([]), required))
		expect(failed).toMatchObject({ state: 'failed', shutdownFailures: [{ kind: 'operation', reason: 'alert', task: 'closeCover' }] })
		expect(failed.failure).toBeUndefined()
		expect(required.trace).toEqual(['closeCover', 'warmCamera'])

		const bestEffort = new Script()
		bestEffort.shutdown = [bestEffort.shutdownTask('closeCover', 'bestEffort', () => failure('alert')), bestEffort.shutdownTask('warmCamera')]
		const completed = await finish(start(configurationOf([]), bestEffort))
		expect(completed).toMatchObject({ state: 'completed', shutdownFailures: [{ reason: 'alert', task: 'closeCover' }] })
	})

	test('shutdown: a step is cut by stepTimeout on the monotonic clock and the next step still runs', async () => {
		const script = new Script()
		script.shutdown = [script.shutdownTask('closeCover', 'required', script.blockTask()), script.shutdownTask('warmCamera')]
		const harness = start(configurationOf([]), script)

		await script.waitBlocked('closeCover')
		await harness.clock.advance(29999)
		expect(script.blocked).toHaveLength(1)
		await harness.clock.advance(1)

		const result = await finish(harness)
		expect(result).toMatchObject({ state: 'failed', shutdownFailures: [{ reason: 'timeout', task: 'closeCover' }] })
		expect(script.trace).toEqual(['closeCover', 'warmCamera'])
	})

	test('shutdown: totalTimeout never cuts the pause-guiding → stop-tracking prefix and stops the tail after it', async () => {
		const script = new Script()
		script.shutdown = [script.shutdownTask('stopTracking', 'required', script.blockTask()), script.shutdownTask('closeCover')]
		const harness = start(configurationOf([], undefined, { shutdown: { stepTimeout: 30, totalTimeout: 40 } }), script)

		const blocked = await script.waitBlocked('stopTracking')
		expect(harness.clock.pending).toBe(0)
		await harness.clock.advance(60000)
		blocked.settle(OK)

		const result = await finish(harness)
		expect(result).toMatchObject({ state: 'failed', shutdownFailures: [{ kind: 'operation', reason: 'timeout', detail: 'shutdown total timeout' }] })
		expect(script.trace).toEqual(['stopTracking'])
	})
})

describe('49.5 pause and resume', () => {
	test('1: a pause during the exposure lets it finish and be accepted before holding; resume continues with the next slot', async () => {
		const script = new Script()
		script.capture = script.captureStep(script.blockCapture())
		const harness = start(configurationOf([scheduled('L', 2)]), script)
		const { handle } = harness.runner

		const first = await script.waitBlocked('capture@frame[L][1]')
		const paused = handle.pause()
		first.settle(captured(first.context))
		expect(await paused).toBe('paused')

		const accepted = sequenceOf(harness, isEvent('frameAccepted'))
		const held = sequenceOf(harness, (entry) => entry.kind === 'event' && entry.event.type === 'stateChanged' && entry.event.state === 'paused')
		expect(accepted).toBeLessThan(held)
		expect(script.trace).toEqual(['capture@frame[L][1]#1'])
		expect(harness.recorder.entries.some((entry) => entry.sequence > held && entry.kind === 'event' && entry.event.type === 'frameSelected')).toBeFalse()

		expect(handle.resume()).toBeTrue()
		const second = await script.waitBlocked('capture@frame[L][2]')
		second.settle(captured(second.context))

		const result = await finish(harness)
		expect(result.state).toBe('completed')
		expect(states(harness)).toEqual(['running', 'paused', 'running', 'shuttingDown', 'completed'])
	})

	test('2: a pause during the pre-capture completes the task and holds before the exposure; stop while paused shuts down', async () => {
		const script = new Script()
		script.preCapture = [script.task('autofocus', script.blockTask()), script.task('ensureGuiding')]
		script.shutdown = [script.shutdownTask('warmCamera')]
		const harness = start(configurationOf(), script)
		const { handle } = harness.runner

		const blocked = await script.waitBlocked('autofocus')
		const paused = handle.pause()
		blocked.settle(OK)
		expect(await paused).toBe('paused')
		expect(script.trace).toEqual(['autofocus@frame[L][1]'])

		const result = await handle.stop()
		expect(result).toMatchObject({ state: 'stopped', stopCause: 'user' })
		expect(script.trace).toEqual(['autofocus@frame[L][1]', 'warmCamera'])
		expect(handle.resume()).toBeFalse()
		await finish(harness)
	})

	test('3: the pause promise resolves paused, running when resumed first, or the terminal state, and is shared', async () => {
		const script = new Script()
		script.capture = script.captureStep(script.blockCapture())
		const harness = start(configurationOf([scheduled('L', 2)]), script)
		const { handle } = harness.runner

		const first = await script.waitBlocked('capture@frame[L][1]')
		const pause = handle.pause()
		expect(handle.pause()).toBe(pause)
		expect(handle.resume()).toBeTrue()
		expect(await pause).toBe('running')
		expect(handle.resume()).toBeFalse()
		first.settle(captured(first.context))

		await script.waitBlocked('capture@frame[L][2]')
		const pending = handle.pause()
		await handle.stop('immediate')
		expect(await pending).toBe('stopped')
		expect(await handle.pause()).toBe('stopped')
		expect(states(harness)).not.toContain('paused')
		await finish(harness)
	})

	test('3: a pause requested during the startup holds at the first safe point', async () => {
		const script = new Script()
		script.startup = [script.task('coolCamera', script.blockTask())]
		const harness = start(configurationOf(), script)

		const blocked = await script.waitBlocked('coolCamera')
		const paused = harness.runner.handle.pause()
		blocked.settle(OK)
		expect(await paused).toBe('paused')
		expect(script.trace).toEqual(['coolCamera'])
		harness.runner.handle.resume()
		expect((await finish(harness)).state).toBe('completed')
	})
})

describe('49.6 stop and cancellation', () => {
	test('1: graceful finishes the current frame and selects no new one', async () => {
		const script = new Script()
		script.capture = script.captureStep(script.blockCapture())
		const harness = start(configurationOf([scheduled('L', 3)]), script)

		const blocked = await script.waitBlocked('capture@frame[L][1]')
		const stopped = harness.runner.handle.stop()
		blocked.settle(captured(blocked.context))
		const result = await stopped

		expect(result).toMatchObject({ state: 'stopped', stopCause: 'user' })
		expect(progressOf(result, 'L').accepted).toBe(1)
		expect(script.trace).toEqual(['capture@frame[L][1]#1'])
		await finish(harness)
	})

	test('2: graceful during the pre-capture cancels the task, then compensates in a new root before the shutdown', async () => {
		const script = new Script()
		const focuser = fakeDevice<Focuser>(DEFAULT_FOCUSER, 'Focuser')
		const wheel = fakeDevice<Wheel>(DEFAULT_WHEEL, 'Wheel')
		const moves: string[] = []
		const focuserCommander = { moveTo: (scope: OperationContext, _: Focuser, position: number) => (moves.push(`focuser ${position} ${scope.kind}`), Promise.resolve(successfulOperationResult(undefined))) } as unknown as FocuserCommander
		const wheelCommander = { moveTo: (scope: OperationContext, _: Wheel, slot: number) => (moves.push(`wheel ${slot} ${scope.kind}`), Promise.resolve(successfulOperationResult(undefined))) } as unknown as WheelCommander
		const block = script.blockTask()

		script.preCapture = [
			script.task('autofocus', (context) => {
				pushSequencerCompensation(context.state, { kind: 'focuserPosition', task: 'autofocus', position: 1000 })
				pushSequencerCompensation(context.state, { kind: 'wheelSlot', task: 'autofocus', slot: 2 })
				return block(context)
			}),
		]
		script.shutdown = [script.shutdownTask('warmCamera', 'required', () => (moves.push('shutdown'), OK))]
		const harness = start(configurationOf([{ ...scheduled('L', 1), filter: { kind: 'slot', slot: 2 } }], { focusOffsets: { reference: 'L', offsets: {} } }), script, { devices: { camera: CAMERA, focuser, wheel }, focuserCommander, wheelCommander })

		await script.waitBlocked('autofocus')
		const result = await harness.runner.handle.stop()

		expect(result).toMatchObject({ state: 'stopped', compensationFailures: [] })
		expect(moves).toEqual(['wheel 2 sequencer.compensate.wheelSlot', 'focuser 1000 sequencer.compensate.focuserPosition', 'shutdown'])
		expect(script.trace).toEqual(['autofocus@frame[L][1]', 'warmCamera'])
		await finish(harness)
	})

	test('2c: a compensation that times out is reported, requests an autofocus, and the shutdown and release follow', async () => {
		const script = new Script()
		const focuser = fakeDevice<Focuser>(DEFAULT_FOCUSER, 'Focuser')
		const focuserCommander = { moveTo: untilAborted } as unknown as FocuserCommander
		const block = script.blockTask()
		script.preCapture = [script.task('autofocus', (context) => (pushSequencerCompensation(context.state, { kind: 'focuserPosition', task: 'autofocus', position: 1000 }), block(context)))]
		script.shutdown = [script.shutdownTask('warmCamera')]
		const harness = start(configurationOf(undefined, { focusOffsets: { reference: 'L', offsets: {} } }), script, { devices: { camera: CAMERA, focuser }, focuserCommander })

		await script.waitBlocked('autofocus')
		const stopped = harness.runner.handle.stop()
		await waitUntil(() => harness.clock.pending === 1, 2000, 1)
		await harness.clock.advance(30000)
		const result = await stopped

		expect(result).toMatchObject({ state: 'stopped', compensationFailures: [{ kind: 'operation', reason: 'timeout', task: 'autofocus' }] })
		expect(harness.runner.snapshot().intents.autofocus).toBeTrue()
		expect(script.trace).toEqual(['autofocus@frame[L][1]', 'warmCamera'])
		await finish(harness)
	})

	test('2e: a task that succeeds removes its compensation and nothing is moved back', async () => {
		const script = new Script()
		const focuser = fakeDevice<Focuser>(DEFAULT_FOCUSER, 'Focuser')
		const focuserCommander = { moveTo: () => Promise.reject(new Error('no compensation expected')) } as unknown as FocuserCommander
		script.preCapture = [
			script.task('autofocus', (context) => {
				const remove = pushSequencerCompensation(context.state, { kind: 'focuserPosition', task: 'autofocus', position: 1000 })
				remove()
				remove()
				return OK
			}),
		]
		const result = await finish(start(configurationOf(undefined, { focusOffsets: { reference: 'L', offsets: {} } }), script, { devices: { camera: CAMERA, focuser }, focuserCommander }))
		expect(result).toMatchObject({ state: 'completed', compensationFailures: [] })
	})

	test('3: graceful runs the session-end batches with onStop, never the others nor a new scheduled frame', async () => {
		const script = new Script()
		script.capture = script.captureStep((context) => (context.frame!.groupId === 'L' ? script.blockCapture()(context) : captured(context)))
		const harness = start(configurationOf([scheduled('L', 3), sessionEnd('darks', 2, true), sessionEnd('biases', 1, false)]), script)

		const blocked = await script.waitBlocked('capture@frame[L][1]')
		const stopped = harness.runner.handle.stop()
		blocked.settle(captured(blocked.context))
		const result = await stopped

		expect(script.trace).toEqual(['capture@frame[L][1]#1', 'capture@frame[darks][1]#1', 'capture@frame[darks][2]#1'])
		expect(progressOf(result, 'darks').accepted).toBe(2)
		expect(progressOf(result, 'biases').accepted).toBe(0)
		expect(result.state).toBe('stopped')
		await finish(harness)
	})

	test('4: immediate cancels the exposure and awaits its quiescence; the camera is free only after the release', async () => {
		const script = new Script()
		let quiesced = false
		script.capture = script.captureStep(
			(context) =>
				new Promise((resolve) => {
					context.signal.addEventListener('abort', () => setTimeout(() => ((quiesced = true), resolve(failedOperationResult('aborted'))), 20), { once: true })
				}),
		)
		script.shutdown = [script.shutdownTask('warmCamera', 'required', () => (expect(quiesced).toBeTrue(), OK))]
		const harness = start(configurationOf([scheduled('L', 2)]), script)

		await waitUntil(() => script.trace.length === 1, 2000, 1)
		const other = harness.coordinator.start('other', [{ key: resourceKey(CAMERA), device: CAMERA }], () => successfulOperationResult(undefined))
		expect(await other.result).toMatchObject({ ok: false, reason: 'busy' })

		const result = await harness.runner.handle.stop('immediate')
		expect(result).toMatchObject({ state: 'stopped', stopCause: 'user' })
		expect(progressOf(result, 'L').accepted).toBe(0)
		expect(script.trace).toEqual(['capture@frame[L][1]#1', 'warmCamera'])
		expect(await harness.coordinator.start('other', [{ key: resourceKey(CAMERA), device: CAMERA }], () => successfulOperationResult(undefined)).result).toEqual(successfulOperationResult(undefined))
		await finish(harness)
	})

	test('5, 9: startTask refuses after the run abort, even once the drain reopened the tokens; startCriticalTask refuses only after dispose', async () => {
		const script = new Script()
		const outcomes: OperationResult<void>[] = []
		const harness = start(configurationOf(), script)
		const { runner } = harness
		script.preCapture = [script.task('autofocus', script.blockTask())]
		script.shutdown = [
			script.shutdownTask('warmCamera', 'required', async () => {
				outcomes.push(await runner.startTask('sequencer.late', () => successfulOperationResult(undefined)).result)
				outcomes.push(await runner.startCriticalTask('sequencer.protect.late', () => successfulOperationResult(undefined)).result)
				return OK
			}),
		]

		await script.waitBlocked('autofocus')
		await runner.handle.stop('immediate')
		expect(outcomes).toEqual([failedOperationResult('aborted', 'the sequencer run has been aborted'), successfulOperationResult(undefined)])

		runner.dispose()
		expect(await runner.startCriticalTask('sequencer.protect.late', () => successfulOperationResult(undefined)).result).toMatchObject({ ok: false, reason: 'aborted' })
		await finish(harness)
	})

	test('6: graceful escalates to immediate, the reverse is a no-op', async () => {
		const script = new Script()
		script.capture = script.captureStep(script.blockCapture())
		const harness = start(configurationOf([scheduled('L', 2)]), script)
		const { handle } = harness.runner

		await script.waitBlocked('capture@frame[L][1]')
		const graceful = handle.stop()
		expect(script.blocked).toHaveLength(1)
		const immediate = handle.stop('immediate')
		expect(immediate).toBe(graceful)
		expect(handle.stop('graceful')).toBe(graceful)

		const result = await graceful
		expect(progressOf(result, 'L').accepted).toBe(0)
		expect(script.trace).toEqual(['capture@frame[L][1]#1'])
		await finish(harness)
	})

	test('6: stop during the admission ends stopped with no reservation and no task', async () => {
		const script = new Script()
		script.startup = [script.task('coolCamera')]
		script.shutdown = [script.shutdownTask('warmCamera')]
		const harness = start(configurationOf(), script)
		const result = await harness.runner.handle.stop('immediate')

		expect(result).toMatchObject({ state: 'stopped', stopCause: 'user', shutdownFailures: [] })
		expect(script.trace).toEqual([])
		expect(harness.recorder.reservationOwner).toBeUndefined()
		expect(states(harness)).toEqual(['stopped'])
		await finish(harness)
	})

	test('6: stop during the shutdown returns the same result and never cancels or repeats a step', async () => {
		const script = new Script()
		script.shutdown = [script.shutdownTask('closeCover', 'required', script.blockTask()), script.shutdownTask('warmCamera')]
		const harness = start(configurationOf([]), script)

		const blocked = await script.waitBlocked('closeCover')
		const stopped = harness.runner.handle.stop('immediate')
		expect(harness.runner.handle.stop()).toBe(stopped)
		await Bun.sleep(0)
		expect(script.blocked).toHaveLength(1)
		blocked.settle(OK)

		expect(await stopped).toMatchObject({ state: 'completed', shutdownFailures: [] })
		expect(script.trace).toEqual(['closeCover', 'warmCamera'])
		await finish(harness)
	})

	test('6, 2d: dispose aborts the shutdown and a compensation, fails the session and releases', async () => {
		const script = new Script()
		script.shutdown = [script.shutdownTask('closeCover', 'required', script.blockTask()), script.shutdownTask('warmCamera')]
		const harness = start(configurationOf([]), script)

		await script.waitBlocked('closeCover')
		harness.runner.dispose()
		const result = await finish(harness, { disposed: true })
		expect(result).toMatchObject({ state: 'failed', failure: { kind: 'operation', reason: 'aborted', detail: 'disposed' } })
		expect(script.trace).toEqual(['closeCover'])

		const compensating = new Script()
		const focuser = fakeDevice<Focuser>(DEFAULT_FOCUSER, 'Focuser')
		const focuserCommander = { moveTo: untilAborted } as unknown as FocuserCommander
		const block = compensating.blockTask()
		compensating.preCapture = [compensating.task('autofocus', (context) => (pushSequencerCompensation(context.state, { kind: 'focuserPosition', task: 'autofocus', position: 1 }), block(context)))]
		compensating.shutdown = [compensating.shutdownTask('warmCamera')]
		const controller = new AbortController()
		const disposed = start(configurationOf(undefined, { focusOffsets: { reference: 'L', offsets: {} } }), compensating, { devices: { camera: CAMERA, focuser }, focuserCommander, disposeSignal: controller.signal })

		await compensating.waitBlocked('autofocus')
		void disposed.runner.handle.stop()
		await waitUntil(() => disposed.recorder.entries.some((entry) => entry.kind === 'root' && entry.event === 'start' && entry.operation === 'sequencer.compensate.focuserPosition'), 2000, 1)
		controller.abort()

		const aborted = await finish(disposed, { disposed: true })
		expect(aborted).toMatchObject({ state: 'failed', compensationFailures: [{ reason: 'aborted', task: 'autofocus' }] })
		expect(compensating.trace).toEqual(['autofocus@frame[L][1]'])
	})

	test('7: the drain has two stages: cancel of the task root < its result < drainByReservationOwner', async () => {
		const script = new Script()
		script.preCapture = [script.task('autofocus', script.blockTask())]
		const harness = start(configurationOf(), script)

		await script.waitBlocked('autofocus')
		await harness.runner.handle.stop('immediate')

		const root = (event: 'cancel' | 'end') => sequenceOf(harness, (entry) => entry.kind === 'root' && entry.operation === 'sequencer.autofocus' && entry.event === event)
		const drain = sequenceOf(harness, (entry) => entry.kind === 'drain' && !entry.terminal && entry.event === 'begin')
		expect(root('cancel')).toBeLessThan(root('end'))
		expect(root('end')).toBeLessThan(drain)
		expect(drain).toBeLessThan(sequenceOf(harness, (entry) => entry.kind === 'drain' && entry.terminal))
		await finish(harness)
	})

	test('8: a critical root opens while a stuck task still quiesces (stage 1)', async () => {
		const script = new Script()
		script.preCapture = [script.task('autofocus', script.blockTask(true))]
		const harness = start(configurationOf(), script)

		const stuck = await script.waitBlocked('autofocus')
		const stopped = harness.runner.handle.stop('immediate')
		await waitUntil(() => harness.recorder.entries.some((entry) => entry.kind === 'root' && entry.event === 'cancel'), 2000, 1)

		expect(await harness.runner.startCriticalTask('sequencer.protect.mountTracking', () => successfulOperationResult(undefined)).result).toEqual(successfulOperationResult(undefined))
		stuck.settle(ABORTED)
		expect((await stopped).state).toBe('stopped')
		await finish(harness)
	})

	test('8 (incorrect variant): a core drain before stage 1 ends refuses the critical root and breaks I42', async () => {
		const script = new Script()
		script.preCapture = [script.task('autofocus', script.blockTask(true))]
		const harness = start(configurationOf(), script)

		const stuck = await script.waitBlocked('autofocus')
		const stopped = harness.runner.handle.stop('immediate')
		await waitUntil(() => harness.recorder.entries.some((entry) => entry.kind === 'root' && entry.event === 'cancel'), 2000, 1)
		const drained = harness.coordinator.drainByReservationOwner(harness.recorder.reservationOwner!, 'aborted')

		expect(await harness.runner.startCriticalTask('sequencer.protect.mountTracking', () => successfulOperationResult(undefined)).result).toEqual(failedOperationResult('aborted', 'reservation has been cancelled'))
		stuck.settle(ABORTED)
		await drained
		await stopped
		expect(() => assertRunnerInvariants(harness.recorder.entries)).toThrow(/^I42:/)
	})
})

describe('protection requests', () => {
	const action = (script: Script, id: SequencerTaskId = 'meridianFlip') => script.task(id)

	test('during the pre-capture: cancel, drain, compensate, run the action, then re-enter from the first task with the same attempt', async () => {
		const script = new Script()
		const wheel = fakeDevice<Wheel>(DEFAULT_WHEEL, 'Wheel')
		const moves: string[] = []
		const wheelCommander = { moveTo: (_: OperationContext, __: Wheel, slot: number) => (moves.push(`wheel ${slot}`), Promise.resolve(successfulOperationResult(undefined))) } as unknown as WheelCommander
		const block = script.blockTask()
		let runs = 0
		script.preCapture = [script.task('prepareOpticalPath'), script.task('autofocus', (context) => (++runs === 1 ? (pushSequencerCompensation(context.state, { kind: 'wheelSlot', task: 'autofocus', slot: 3 }), block(context)) : OK))]
		const harness = start(configurationOf([{ ...scheduled('L', 1), filter: { kind: 'slot', slot: 3 } }]), script, { devices: { camera: CAMERA, wheel }, wheelCommander })

		await script.waitBlocked('autofocus')
		const protection = action(script)
		expect(harness.runner.requestProtection(protection)).toBeTrue()
		expect(harness.runner.requestProtection(action(script))).toBeFalse()

		const result = await finish(harness)
		expect(result.state).toBe('completed')
		expect(moves).toEqual(['wheel 3'])
		expect(script.trace).toEqual(['prepareOpticalPath@frame[L][1]', 'autofocus@frame[L][1]', 'meridianFlip@frame[L][1]', 'prepareOpticalPath@frame[L][1]', 'autofocus@frame[L][1]', 'capture@frame[L][1]#1'])
		const compensation = sequenceOf(harness, (entry) => entry.kind === 'root' && entry.operation === 'sequencer.compensate.wheelSlot' && entry.event === 'start')
		expect(compensation).toBeLessThan(sequenceOf(harness, (entry) => entry.kind === 'root' && entry.operation === 'sequencer.meridianFlip'))
	})

	test('in the hold: the action runs and the session stays paused until resumed', async () => {
		const script = new Script()
		const harness = start(configurationOf(), script)
		const paused = harness.runner.handle.pause()
		expect(await paused).toBe('paused')

		expect(harness.runner.requestProtection(action(script, 'protectMeridianWhilePaused'))).toBeTrue()
		await waitUntil(() => script.trace.length === 1 && harness.runner.snapshot().task === undefined, 2000, 1)
		expect(harness.runner.snapshot().state).toBe('paused')
		expect(script.trace).toEqual(['protectMeridianWhilePaused'])

		harness.runner.handle.resume()
		expect((await finish(harness)).state).toBe('completed')
		expect(states(harness)).toEqual(['running', 'paused', 'running', 'shuttingDown', 'completed'])
	})

	test('during the startup: the interrupted step runs again from its beginning', async () => {
		const script = new Script()
		const block = script.blockTask()
		let runs = 0
		script.startup = [script.task('coolCamera'), script.task('openCover', (context) => (++runs === 1 ? block(context) : OK))]
		const harness = start(configurationOf(), script)

		await script.waitBlocked('openCover')
		expect(harness.runner.requestProtection(action(script, 'protectMeridianDuringStartup'))).toBeTrue()
		expect((await finish(harness)).state).toBe('completed')
		expect(script.trace).toEqual(['coolCamera', 'openCover', 'protectMeridianDuringStartup', 'openCover', 'capture@frame[L][1]#1'])
	})

	test('during the exposure: the capture counts as a failed attempt retried through the pre-capture after the action', async () => {
		const script = new Script()
		const block = script.blockCapture()
		script.preCapture = [script.task('prepareOpticalPath')]
		script.capture = script.captureStep((context) => (context.frame!.attempt === 1 ? block(context) : captured(context)))
		const harness = start(configurationOf(undefined, { retry: { maxAttempts: 2, delay: 5, backoff: 1, maximumDelay: 5, retryOn: [] } }), script)

		await script.waitBlocked('capture@frame[L][1]#1')
		expect(harness.runner.requestProtection(action(script))).toBeTrue()

		const result = await finish(harness)
		expect(result.state).toBe('completed')
		expect(script.trace).toEqual(['prepareOpticalPath@frame[L][1]', 'capture@frame[L][1]#1', 'meridianFlip@frame[L][1]', 'prepareOpticalPath@frame[L][1]', 'capture@frame[L][1]#2'])
		expect(events(harness).find((event) => event.type === 'frameSelected' && event.frame.attempt === 2)).toMatchObject({ frame: { captureFailures: 1 } })
	})

	test('refused once a stop was requested and after the session ended', async () => {
		const script = new Script()
		script.capture = script.captureStep(script.blockCapture())
		const harness = start(configurationOf(), script)

		const blocked = await script.waitBlocked('capture')
		void harness.runner.handle.stop()
		expect(harness.runner.requestProtection(action(script))).toBeFalse()
		blocked.settle(captured(blocked.context))
		await finish(harness)
		expect(harness.runner.requestProtection(action(script))).toBeFalse()
	})
})

describe('43 re-entries of the guard', () => {
	const refuse = (wait?: number): SequencerTaskResult => ({ ok: true, reenter: { reason: 'the meridian flip is due', ...(wait !== undefined && { wait }) } })

	test('a guard that keeps refusing fails the session after the limit, with every attempt deferred and nothing exposed', async () => {
		const script = new Script()
		const harness = start(configurationOf(), script, { afterPrepare: [script.task('finalExposureGuard', () => refuse())] })
		const result = await finish(harness)

		expect(result).toMatchObject({ state: 'failed', failure: { kind: 'operation', reason: 'unexpectedState', task: 'finalExposureGuard', detail: expect.stringContaining('re-entered 4 times') } })
		expect(script.trace).toEqual(new Array(SEQUENCER_REENTRY_LIMIT + 1).fill('finalExposureGuard@frame[L][1]'))
		const journal = await readSequencerJournal(join(STORAGE_ROOT, harness.runner.id, 'journal.jsonl'))
		expect(journal.filter((entry) => entry.kind === 'deferred').map((entry) => entry.reason)).toEqual(new Array(SEQUENCER_REENTRY_LIMIT + 1).fill('guard'))
		// The attempt was never consumed.
		expect(journal.filter((entry) => entry.kind === 'prepared').every((entry) => entry.attempt === 1)).toBeTrue()
	})

	test('the wait of a refusal is monotonic, a safe point for a pause, and the pre-capture re-enters after it', async () => {
		const script = new Script()
		let refusals = 2
		const harness = start(configurationOf(), script, { afterPrepare: [script.task('finalExposureGuard', () => (refusals-- > 0 ? refuse(5000) : OK))] })

		await waitUntil(() => harness.clock.pending === 1, 2000, 1)
		harness.clock.jumpWall(-60000)
		await harness.clock.advance(4999)
		expect(script.trace).toHaveLength(1)
		await harness.clock.advance(1)
		await waitUntil(() => script.trace.length === 2 && harness.clock.pending === 1, 2000, 1)

		// The second wait is cut by a pause; the resumed pre-capture runs the guard again at once.
		expect(await harness.runner.handle.pause()).toBe('paused')
		expect(harness.runner.handle.resume()).toBeTrue()
		expect((await finish(harness)).state).toBe('completed')
		expect(script.trace).toEqual(['finalExposureGuard@frame[L][1]', 'finalExposureGuard@frame[L][1]', 'finalExposureGuard@frame[L][1]', 'capture@frame[L][1]#1'])
	})

	test('a refusal of the guard right before the dispatch counts too; an exposure resets the count', async () => {
		const script = new Script()
		let refusals = SEQUENCER_REENTRY_LIMIT
		const harness = start(configurationOf([scheduled('L', 2)]), script, { exposureRefusal: () => (refusals-- > 0 ? 'the meridian flip is due' : undefined) })
		const result = await finish(harness)

		expect(result.state).toBe('completed')
		expect(script.trace.filter((entry) => entry.startsWith('capture'))).toEqual(['capture@frame[L][1]#1', 'capture@frame[L][1]#1', 'capture@frame[L][1]#1', 'capture@frame[L][1]#1', 'capture@frame[L][2]#1'])
		expect(events(harness).filter((event) => event.type === 'exposureStarted')).toHaveLength(2)

		// One more refusal than the limit fails the session.
		const failing = new Script()
		const failed = await finish(start(configurationOf(), failing, { exposureRefusal: () => 'the meridian flip is due' }))
		expect(failed).toMatchObject({ state: 'failed', failure: { kind: 'operation', reason: 'unexpectedState', task: 'finalExposureGuard' } })
		expect(failing.trace).toEqual(new Array(SEQUENCER_REENTRY_LIMIT + 1).fill('capture@frame[L][1]#1'))
	})
})

describe('24.5 critical protection', () => {
	const outcome = (value: SequencerProtectionOutcome) => successfulOperationResult(value)

	test('cancels the current task at once, runs while it still quiesces, single-flight, and no task starts before its outcome', async () => {
		const script = new Script()
		const stuck = script.blockTask(true)
		let runs = 0
		script.preCapture = [script.task('autofocus', (context) => (++runs === 1 ? stuck(context) : OK))]
		const harness = start(configurationOf(), script)
		const blocked = await script.waitBlocked('autofocus')

		let release!: VoidFunction
		const order: string[] = []
		const protection = harness.runner.protectCritically('sequencer.protect.meridianHard', async (context) => {
			order.push(`protect ${blocked.context.signal.aborted}`)
			await new Promise<void>((resolve) => {
				release = resolve
			})
			order.push(`off ${context.kind}`)
			return outcome({ ok: true })
		})

		// Stage 1 happened synchronously; a second call shares the protection in flight.
		expect(blocked.context.signal.aborted).toBeTrue()
		expect(harness.runner.protectCritically('sequencer.protect.other', () => outcome({ ok: true }))).toBe(protection)
		await waitUntil(() => order.length === 1, 2000, 1)
		expect(harness.runner.snapshot().task).toBe('autofocus')

		// The stuck task ends; nothing starts, no drain begins, until the outcome.
		blocked.settle(ABORTED)
		for (let i = 0; i < 20; i++) {
			await new Promise((resolve) => {
				setImmediate(resolve)
			})
		}
		expect(script.trace).toEqual(['autofocus@frame[L][1]'])
		const drains = () => harness.recorder.entries.filter((entry) => entry.kind === 'drain' && !entry.terminal).length
		expect(drains()).toBe(0)

		release()
		expect(await protection).toEqual({ ok: true })
		expect((await finish(harness)).state).toBe('completed')
		expect(order).toEqual(['protect true', 'off sequencer.protect.meridianHard'])
		expect(script.trace).toEqual(['autofocus@frame[L][1]', 'autofocus@frame[L][1]', 'capture@frame[L][1]#1'])
		const root = sequenceOf(harness, (entry) => entry.kind === 'root' && entry.operation === 'sequencer.protect.meridianHard' && entry.event === 'start')
		const stuckEnd = sequenceOf(harness, (entry) => entry.kind === 'root' && entry.operation === 'sequencer.autofocus' && entry.event === 'end')
		expect(root).toBeLessThan(stuckEnd)
	})

	test('a failed outcome applies its action: pause holds at the next safe point, the startup included', async () => {
		const script = new Script()
		const block = script.blockTask()
		let runs = 0
		script.startup = [script.task('coolCamera', (context) => (++runs === 1 ? block(context) : OK))]
		const harness = start(configurationOf(), script)
		await script.waitBlocked('coolCamera')

		const failure: SequencerFailure = { kind: 'operation', reason: 'unexpectedState', detail: 'meridian protection failed: trackingNotStopped' }
		expect(await harness.runner.protectCritically('sequencer.protect.meridianHard', () => outcome({ ok: false, failure, action: 'pause' }))).toEqual({ ok: false, failure, action: 'pause' })
		await waitState(harness, 'paused')
		expect(script.trace).toEqual(['coolCamera'])

		expect(harness.runner.handle.resume()).toBeTrue()
		expect((await finish(harness)).state).toBe('completed')
		expect(script.trace).toEqual(['coolCamera', 'coolCamera', 'capture@frame[L][1]#1'])
	})

	test('58: the motion owners are the roots of the mount movers and of the dither movement while they live, nothing else', async () => {
		const bounds = { mount: 'Mount', mountSettle: 500, ditherMovement: [{ request: { key: 'GuideOutput' }, releaseBound: 1000 }] }
		let host: SequencerSupervisorHost | undefined
		const supervisor: SequencerSupervisor = { arm: (armed) => (host = armed), motionKeys: (task) => mountKeyHolders(task, bounds)?.keys ?? [], safePoint: () => {}, disarm: () => {} }
		const seen: string[] = []
		const owners = (id: SequencerTaskId) => {
			seen.push(`${id}: ${[...host!.motionOwners.values()].map((owner) => `${owner.task}[${owner.keys.join(',')}]`).join(' ')}`)
			return OK
		}

		const script = new Script()
		script.startup = [script.task('unparkMount', () => owners('unparkMount')), script.task('configureTracking', () => owners('configureTracking'))]
		script.preCapture = [script.task('acquireOrRecenterTarget', () => owners('acquireOrRecenterTarget')), script.task('ensureTracking', () => owners('ensureTracking')), script.task('ditherAndSettle', () => owners('ditherAndSettle')), script.task('autofocus', () => owners('autofocus'))]
		script.shutdown = [script.shutdownTask('stopTracking', 'required', () => owners('stopTracking')), script.shutdownTask('parkMount', 'required', () => owners('parkMount'))]
		const harness = start(configurationOf(), script, { supervisor })

		expect((await finish(harness)).state).toBe('completed')
		expect(seen).toEqual(['unparkMount: unparkMount[Mount]', 'configureTracking: ', 'acquireOrRecenterTarget: acquireOrRecenterTarget[Mount]', 'ensureTracking: ', 'ditherAndSettle: ditherAndSettle[GuideOutput]', 'autofocus: ', 'stopTracking: ', 'parkMount: parkMount[Mount]'])
		// Every entry left with its root.
		expect(host!.motionOwners.size).toBe(0)
	})

	test('a task waiting for a critical protection never starts once its failure stopped, failed or held the session', async () => {
		for (const action of ['stop', 'fail', 'pause'] as const) {
			const script = new Script()
			script.startup = [script.task('coolCamera', () => OK), script.task('openDome', () => OK)]
			const failure: SequencerFailure = { kind: 'operation', reason: 'unexpectedState', detail: 'meridian protection failed: mountNotQuiescent' }
			let release: VoidFunction | undefined
			let protection: Promise<SequencerProtectionOutcome> | undefined

			// The protection begins between the two startup tasks: the second one enters and waits for its outcome.
			const harness = start(configurationOf(), script, {
				onEvent: (event, runner) => {
					if (event.type !== 'taskCompleted' || event.task !== 'coolCamera' || protection !== undefined) return
					protection = runner.protectCritically('sequencer.protect.meridianHard', async () => {
						await new Promise<void>((resolve) => {
							release = resolve
						})
						return outcome({ ok: false, failure, action })
					})
				},
			})

			await waitUntil(() => release !== undefined, 2000, 1)
			for (let i = 0; i < 20; i++) {
				await new Promise((resolve) => {
					setImmediate(resolve)
				})
			}

			release!()
			await protection
			if (action === 'pause') {
				await waitState(harness, 'paused')
				void harness.runner.handle.stop()
			}

			const result = await finish(harness)
			expect(result.state).toBe(action === 'fail' ? 'failed' : 'stopped')
			// openDome waited for the protection and never started a root.
			expect(script.trace).toEqual(['coolCamera'])
		}
	})

	test('a failed outcome with stop or fail ends the session through the shutdown', async () => {
		for (const action of ['stop', 'fail'] as const) {
			const script = new Script()
			script.preCapture = [script.task('autofocus', script.blockTask())]
			script.shutdown = [script.shutdownTask('stopTracking')]
			const harness = start(configurationOf(), script)
			await script.waitBlocked('autofocus')

			const failure: SequencerFailure = { kind: 'operation', reason: 'unexpectedState', detail: 'meridian protection failed: guidingNotQuiescent' }
			await harness.runner.protectCritically('sequencer.protect.meridianHard', () => outcome({ ok: false, failure, action }))
			const result = await finish(harness)

			expect(result).toMatchObject({ state: action === 'stop' ? 'stopped' : 'failed', failure })
			if (action === 'stop') expect(result.stopCause).toBe('policy')
			expect(script.trace).toEqual(['autofocus@frame[L][1]', 'stopTracking'])
		}
	})
})

describe('commanded exposures (I37)', () => {
	async function journalOf(harness: Harness) {
		return await readSequencerJournal(join(STORAGE_ROOT, harness.runner.id, 'journal.jsonl'))
	}

	test('a refusal of beforeExposure closes the attempt with deferred and holds; the resumed pre-capture prepares the same attempt', async () => {
		const script = new Script()
		script.preCapture = [script.task('prepareOpticalPath')]
		let calls = 0
		script.capture = (context) => {
			script.trace.push(`capture@${context.frame!.id}#${context.frame!.attempt}`)
			// The pause arrives after the pre-capture, while the capturer configures the camera.
			if (++calls === 1) void harness.runner.handle.pause()
			const refusal = context.beforeExposure()
			if (refusal !== undefined) return Promise.resolve(refusal)
			context.exposureStarted()
			return Promise.resolve(captured(context))
		}
		const harness = start(configurationOf(), script)

		await waitState(harness, 'paused')
		expect(harness.runner.snapshot().currentFrame).toMatchObject({ id: 'frame[L][1]', attempt: 1, captureFailures: 0 })
		expect((await journalOf(harness)).map((entry) => entry.kind)).toEqual(['prepared', 'deferred'])
		expect((await journalOf(harness)).at(-1)).toMatchObject({ attempt: 1, reason: 'beforeExposure' })
		expect(events(harness).some((event) => event.type === 'exposureStarted')).toBeFalse()

		expect(harness.runner.handle.resume()).toBeTrue()
		expect((await finish(harness)).state).toBe('completed')
		expect(script.trace).toEqual(['prepareOpticalPath@frame[L][1]', 'capture@frame[L][1]#1', 'prepareOpticalPath@frame[L][1]', 'capture@frame[L][1]#1'])
		expect(events(harness).filter((event) => event.type === 'exposureStarted')).toMatchObject([{ slot: 'frame[L][1]', attempt: 1 }])
		expect((await journalOf(harness)).map((entry) => entry.kind)).toEqual(['prepared', 'deferred', 'prepared', 'promoting', 'committed'])
	})

	test('a capture failing before anything was commanded consumes no attempt: its capture policy applies at once, without retry', async () => {
		for (const onFailure of ['fail', 'skipFrame', 'pause'] as const) {
			const script = new Script()
			let calls = 0
			// The capturer refuses before the veto, as for an unavailable camera.
			script.capture = (context) => {
				script.trace.push(`capture@${context.frame!.id}#${context.frame!.attempt}`)
				if (++calls === 1) return Promise.resolve(failedOperationResult('busy', 'camera unavailable'))
				context.beforeExposure()
				return Promise.resolve(captured(context))
			}
			const harness = start(configurationOf([scheduled('L', 2)], { onFailure, retry: { maxAttempts: 3, delay: 0, backoff: 1, maximumDelay: 0, retryOn: ['busy'] } }), script)

			if (onFailure === 'pause') {
				await waitState(harness, 'paused')
				expect(harness.runner.snapshot().currentFrame).toMatchObject({ id: 'frame[L][1]', attempt: 1, captureFailures: 0 })
				expect((await journalOf(harness)).at(-1)).toMatchObject({ kind: 'deferred', attempt: 1, reason: 'pause' })
				harness.runner.handle.resume()
			}

			const result = await finish(harness)
			const journal = await journalOf(harness)
			expect(journal.some((entry) => entry.kind === 'abandoned')).toBeFalse()
			expect(journal[1]).toMatchObject({ kind: 'deferred', slot: 'frame[L][1]', attempt: 1 })

			switch (onFailure) {
				case 'fail':
					expect(result).toMatchObject({ state: 'failed', failure: { kind: 'operation', reason: 'busy', task: 'captureFrame' } })
					expect(script.trace).toEqual(['capture@frame[L][1]#1'])
					break
				case 'skipFrame':
					expect(result.state).toBe('completed')
					expect(progressOf(result, 'L')).toMatchObject({ accepted: 1, skipped: 1 })
					expect(script.trace).toEqual(['capture@frame[L][1]#1', 'capture@frame[L][2]#1'])
					break
				case 'pause':
					expect(result.state).toBe('completed')
					expect(script.trace).toEqual(['capture@frame[L][1]#1', 'capture@frame[L][1]#1', 'capture@frame[L][2]#1'])
					expect(
						events(harness)
							.filter((event) => event.type === 'frameSelected')
							.map((event) => (event.type === 'frameSelected' ? event.frame.captureFailures : -1)),
					).toEqual([0, 0, 0])
			}
		}
	})

	test('a protection before the approval defers the attempt and re-enters it without counting a failure', async () => {
		const script = new Script()
		script.preCapture = [script.task('prepareOpticalPath')]
		let calls = 0
		// The first capture is still configuring the camera (nothing approved yet) when the protection comes.
		script.capture = (context) => {
			script.trace.push(`capture@${context.frame!.id}#${context.frame!.attempt}`)
			if (++calls > 1) return Promise.resolve(context.beforeExposure() ?? captured(context))
			return new Promise((resolve) => {
				context.signal.addEventListener('abort', () => resolve(failedOperationResult('aborted')), { once: true })
			})
		}
		const harness = start(configurationOf(), script)

		await waitUntil(() => script.trace.length === 2, 2000, 1)
		expect(harness.runner.requestProtection(script.task('meridianFlip'))).toBeTrue()

		expect((await finish(harness)).state).toBe('completed')
		expect(script.trace).toEqual(['prepareOpticalPath@frame[L][1]', 'capture@frame[L][1]#1', 'meridianFlip@frame[L][1]', 'prepareOpticalPath@frame[L][1]', 'capture@frame[L][1]#1'])
		expect((await journalOf(harness)).map((entry) => (entry.kind === 'deferred' ? `deferred ${entry.reason}` : entry.kind))).toEqual(['prepared', 'deferred meridian', 'prepared', 'promoting', 'committed'])
	})
})

describe('runner oracle', () => {
	const root = (sequence: number, event: 'start' | 'cancel' | 'end', id: string, operation: string, reason?: 'aborted' | 'timeout'): RunnerLogEntry => ({ kind: 'root', sequence, event, id, operation, ...(reason !== undefined && { reason }) })
	const drain = (sequence: number, event: 'begin' | 'end', terminal: boolean): RunnerLogEntry => ({ kind: 'drain', sequence, event, terminal })
	const terminal = (sequence: number): RunnerLogEntry => ({ kind: 'event', sequence, event: { type: 'sessionStopped', sessionId: 's', at: 0, result: {} as SequencerResult } })
	const started: RunnerLogEntry = { kind: 'event', sequence: 0, event: { type: 'sessionStarted', configurationId: 'c', configurationRevision: 1, sessionId: 's', at: 0 } }

	test('accepts a coherent log', () => {
		expect(() =>
			assertRunnerInvariants([
				started,
				root(1, 'start', 'a', 'sequencer.autofocus'),
				root(2, 'cancel', 'a', 'sequencer.autofocus'),
				root(3, 'end', 'a', 'sequencer.autofocus'),
				drain(4, 'begin', false),
				drain(5, 'end', false),
				root(6, 'start', 'c', 'sequencer.compensate.focuserPosition'),
				root(7, 'end', 'c', 'sequencer.compensate.focuserPosition'),
				drain(8, 'begin', true),
				drain(9, 'end', true),
				{ kind: 'release', sequence: 10 },
				terminal(11),
			]),
		).not.toThrow()
	})

	test('I12: release before the terminal drain, root after the release, two terminal events', () => {
		expect(() => assertRunnerInvariants([started, { kind: 'release', sequence: 1 }])).toThrow(/^I12: reservation released \(#1\) before the terminal drain/)
		expect(() => assertRunnerInvariants([started, drain(1, 'begin', true), drain(2, 'end', true), { kind: 'release', sequence: 3 }, root(4, 'start', 'a', 'sequencer.autofocus')])).toThrow(/^I12: root sequencer.autofocus \(#4\) started after the release/)
		expect(() => assertRunnerInvariants([started, drain(1, 'begin', true), drain(2, 'end', true), { kind: 'release', sequence: 3 }, terminal(4), terminal(5)])).toThrow(/^I12: second terminal event/)
		expect(() => assertRunnerInvariants([started, terminal(1)])).toThrow(/^I12: terminal event sessionStopped \(#1\) before the release/)
	})

	test('I13: a shutdown root cancelled by a stop', () => {
		expect(() => assertRunnerInvariants([root(1, 'start', 'w', 'sequencer.warmCamera'), root(2, 'cancel', 'w', 'sequencer.warmCamera', 'aborted')])).toThrow(/^I13:/)
		expect(() => assertRunnerInvariants([root(1, 'start', 'w', 'sequencer.warmCamera'), root(2, 'cancel', 'w', 'sequencer.warmCamera', 'timeout')])).not.toThrow()
	})

	test('I17: a compensation while the task root is alive or after the shutdown began', () => {
		expect(() => assertRunnerInvariants([root(1, 'start', 'a', 'sequencer.autofocus'), root(2, 'start', 'c', 'sequencer.compensate.wheelSlot')])).toThrow(/^I17: .* while sequencer.autofocus is alive/)
		expect(() => assertRunnerInvariants([root(1, 'start', 'w', 'sequencer.warmCamera'), root(2, 'end', 'w', 'sequencer.warmCamera'), root(3, 'start', 'c', 'sequencer.compensate.wheelSlot')])).toThrow(/^I17: .* after the shutdown/)
	})

	test('I42: a drain before the cancelled root ended', () => {
		expect(() => assertRunnerInvariants([root(1, 'start', 'a', 'sequencer.autofocus'), root(2, 'cancel', 'a', 'sequencer.autofocus'), drain(3, 'begin', false)])).toThrow(/^I42:/)
	})
})

describe('model-based', () => {
	const SEEDS = 200

	// Random choice of `values`.
	function pick<T>(random: Random, values: readonly T[]) {
		return values[Math.floor(random() * values.length)]
	}

	function randomConfiguration(random: Random): SequencerConfiguration {
		const groups: SequencerFrameGroup[] = []
		const scheduledGroups = 1 + Math.floor(random() * 3)
		for (let i = 0; i < scheduledGroups; i++) groups.push(scheduled(`S${i}`, Math.floor(random() * 4)))
		if (random() < 0.5) groups.push(sessionEnd('end', 1 + Math.floor(random() * 2), random() < 0.5))
		const onFailure = pick(random, ['fail', 'pause', 'stop', 'skipFrame'] as const)
		return configurationOf(groups, { order: pick(random, ['sequential', 'roundRobin'] as const), onFailure })
	}

	function randomScript(random: Random) {
		const script = new Script()
		const policy = (): SequencerTaskPolicy => ({ onFailure: pick(random, ['fail', 'pause', 'stop', 'skip'] as const), ...(random() < 0.5 && { retry: { maxAttempts: 2, delay: 1, backoff: 1, maximumDelay: 1, retryOn: ['timeout'] } }) })
		const startup = ['coolCamera', 'openCover'] as const
		const preCapture = ['prepareOpticalPath', 'autofocus', 'ensureGuiding'] as const
		const shutdown = ['closeCover', 'warmCamera'] as const
		script.startup = startup.slice(0, Math.floor(random() * 3)).map((id) => script.task(id, script.blockTask()))
		script.preCapture = preCapture.slice(0, Math.floor(random() * 4)).map((id) => script.task(id, script.blockTask(), policy()))
		script.shutdown = shutdown.slice(0, 1 + Math.floor(random() * 2)).map((id) => script.shutdownTask(id, pick(random, ['required', 'bestEffort'] as const), script.blockTask()))
		script.capture = script.captureStep(script.blockCapture())
		return script
	}

	// Settles one blocked execution with a random outcome.
	function settleRandomly(random: Random, blocked: Blocked) {
		const roll = random()

		if (blocked.capture) {
			blocked.settle(roll < 0.7 ? captured(blocked.context) : failedOperationResult(roll < 0.85 ? 'timeout' : 'commandFailed'))
		} else {
			blocked.settle(roll < 0.7 ? OK : failure(roll < 0.85 ? 'timeout' : 'commandFailed'))
		}
	}

	// Lets the continuations run, then waits until the session waits on something the test controls (a blocked fake, a
	// manual delay, the hold) or ended, so its storage I/O never races the step budget.
	const flush = async (harness: Harness, session: { readonly done: boolean }) => {
		await new Promise<void>((resolve) => {
			setImmediate(resolve)
		})

		await waitUntil(() => session.done || harness.script.blocked.length > 0 || harness.clock.pending > 0 || harness.runner.snapshot().state === 'paused', 5000, 1)
	}

	test.skipIf(isTimeConsumingTestSkipped())(
		'random controls at random points always terminate coherently and leak nothing',
		async () => {
			for (let seed = 1; seed <= SEEDS; seed++) {
				const random = mulberry32(seed)
				const configuration = randomConfiguration(random)
				const script = randomScript(random)
				const harness = start(configuration, script)
				const { runner } = harness
				const pauses: Promise<SequencerSessionState>[] = []
				const session = { done: false }
				void runner.handle.result.then(() => (session.done = true))

				for (let step = 0; step < 400 && !session.done; step++) {
					const roll = random()

					if (step >= 300 || roll < 0.03) void runner.handle.stop('immediate')
					else if (roll < 0.08) void runner.handle.stop('graceful')
					else if (roll < 0.14) pauses.push(runner.handle.pause())
					else if (roll < 0.22) runner.handle.resume()
					else if (roll < 0.25) runner.requestProtection(script.task('meridianFlip', script.blockTask(), { onFailure: pick(random, ['fail', 'pause', 'stop'] as const) }))
					else if (roll < 0.35 && harness.clock.pending > 0) await harness.clock.advance(1000)
					else if (script.blocked.length > 0) settleRandomly(random, pick(random, script.blocked))

					await flush(harness, session)
				}

				for (let step = 0; !session.done; step++) {
					if (step > 200) throw new Error(`seed ${seed}: the session did not terminate in state ${runner.snapshot().state}`)
					void runner.handle.stop('immediate')
					while (script.blocked.length > 0) script.blocked[0].settle(script.blocked[0].capture ? captured(script.blocked[0].context) : OK)
					if (harness.clock.pending > 0) await harness.clock.advance(60000)
					await flush(harness, session)
				}

				try {
					const result = await finish(harness)
					const settled = await Promise.all(pauses)
					for (const state of settled) expect(['paused', 'running', 'completed', 'stopped', 'failed']).toContain(state)

					if (result.state === 'completed') {
						expect(result.failure).toBeUndefined()
						for (const group of result.capture.groups) if (group.kind === 'scheduled') expect(group.accepted + group.skipped).toBe(group.requested)
					}

					if (result.state === 'stopped') expect(result.stopCause).toBeDefined()
					expect(events(harness).filter((event) => event.type === 'sessionCompleted' || event.type === 'sessionStopped' || event.type === 'sessionFailed')).toHaveLength(1)
				} catch (error) {
					throw new Error(`seed ${seed}: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
				}

				for (const recorder of recorders.splice(0)) recorder[Symbol.dispose]()
			}
		},
		60000,
	)
})

describe('rig compensation', () => {
	test('2, 2a, 2b: graceful during autofocus moves the wheel then the focuser back in new roots, a busy focuser fails its compensation', async () => {
		await using rig = await createSequencerRig()
		await connectSequencerRig(rig)
		await resetSequencerRig(rig, 40000)
		const { focuser, wheel, camera } = rig.devices()
		const devices: SequencerDevices = { camera, focuser, wheel }

		// Autofocus through a dedicated filter: registers the focuser position, moves it, registers the frame slot,
		// moves to the autofocus filter, then hangs until cancelled.
		const autofocus = (script: Script) => {
			const block = script.blockTask()
			return script.task('autofocus', async (context) => {
				pushSequencerCompensation(context.state, { kind: 'focuserPosition', task: 'autofocus', position: focuser.position.value })
				const moved = await rig.commanders.focuser.moveTo(context.scope, focuser, focuser.position.value + 2000)
				if (!moved.ok) return { ok: false, failure: { kind: 'operation', reason: moved.reason } }
				pushSequencerCompensation(context.state, { kind: 'wheelSlot', task: 'autofocus', slot: wheel.position })
				const filtered = await rig.commanders.wheel.moveTo(context.scope, wheel, 4)
				if (!filtered.ok) return { ok: false, failure: { kind: 'operation', reason: filtered.reason } }
				return await block(context)
			})
		}

		const configuration = configurationOf([{ ...scheduled('L', 1), filter: { kind: 'slot', slot: 0 } }], { focusOffsets: { reference: 'L', offsets: {} } })
		const options: HarnessOptions = { devices, coordinator: rig.coordinator, focuserCommander: rig.commanders.focuser, wheelCommander: rig.commanders.wheel }

		const script = new Script()
		script.preCapture = [autofocus(script)]
		script.shutdown = [script.shutdownTask('warmCamera', 'required', () => (expect([focuser.position.value, wheel.position]).toEqual([40000, 0]), OK))]
		const harness = start(configuration, script, options)

		await script.waitBlocked('autofocus')
		expect([focuser.position.value, wheel.position]).toEqual([42000, 4])
		const result = await harness.runner.handle.stop()

		expect(result).toMatchObject({ state: 'stopped', compensationFailures: [] })
		expect([focuser.position.value, wheel.position]).toEqual([40000, 0])
		const starts = harness.recorder.entries.flatMap((entry) => (entry.kind === 'root' && entry.event === 'start' ? [entry.operation] : []))
		expect(starts).toEqual(['sequencer.autofocus', 'sequencer.compensate.wheelSlot', 'sequencer.compensate.focuserPosition', 'sequencer.warmCamera'])
		await finish(harness)
		for (const recorder of recorders.splice(0)) recorder[Symbol.dispose]()

		// 2b: a focuser blocked by an outstanding payload makes its compensation busy; the wheel still goes back, the
		// session shuts down and releases.
		const busy = new Script()
		busy.preCapture = [autofocus(busy)]
		busy.shutdown = [busy.shutdownTask('warmCamera')]
		const holding = start(configuration, busy, options)

		await busy.waitBlocked('autofocus')
		rig.arbiter.markUnavailable(resourceKey(focuser), 'quarantine')
		const stopped = await holding.runner.handle.stop()
		rig.arbiter.markAvailable(resourceKey(focuser), 'quarantine')

		expect(stopped).toMatchObject({ state: 'stopped', compensationFailures: [{ reason: 'busy', task: 'autofocus' }] })
		expect(holding.runner.snapshot().intents.autofocus).toBeTrue()
		expect([focuser.position.value, wheel.position]).toEqual([42000, 0])
		await finish(holding)
		await resetSequencerRig(rig, 40000)
	})
})

// Safety source of the runner tests: `publish` notifies the subscribers synchronously; reads and live subscriptions are
// counted.
class ScriptedSafetySource implements SequencerSafetySource {
	#snapshot: SequencerSafetySnapshot
	readonly #listeners = new Set<(snapshot: SequencerSafetySnapshot) => void>()
	reads = 0

	constructor(state: SequencerSafetySnapshot['state'] = 'safe') {
		this.#snapshot = { state }
	}

	get subscriptions() {
		return this.#listeners.size
	}

	readonly current = () => {
		this.reads++
		return this.#snapshot
	}

	readonly subscribe = (listener: (snapshot: SequencerSafetySnapshot) => void) => {
		this.#listeners.add(listener)
		return () => {
			this.#listeners.delete(listener)
		}
	}

	publish(state: SequencerSafetySnapshot['state']) {
		this.#snapshot = { state }
		for (const listener of this.#listeners) listener(this.#snapshot)
	}
}

describe('49.3 discard', () => {
	const QUALITY_LIMITS = { timeout: 10, abortGrace: 5 } as const
	const QUALITY_ONLY = { quality: true, guidingInterruption: false, unsafeDuringExposure: false } as const
	const GUIDING = { settle: { pixels: 1.5, time: 1, timeout: 10 }, pauseTimeout: 5, maxRecoveries: 1, recalibrate: false, flipCalibration: false, onFailure: 'fail' } as const

	function discardPolicy(patch: Partial<SequencerFrameDiscardPolicy> = {}): SequencerFrameDiscardPolicy {
		return { criteria: QUALITY_ONLY, maxDiscardsPerSlot: 1, onExhausted: 'skipSlot', artifact: 'moveToRejected', ...patch }
	}

	// One scheduled light group `L` judged by `policy`, with the quality limits.
	function judged(count: number, policy: SequencerFrameDiscardPolicy | undefined = discardPolicy(), patch: Partial<SequencerConfiguration> = {}) {
		return configurationOf([{ ...scheduled('L', count), ...(policy !== undefined && { discard: policy }) }], { quality: QUALITY_LIMITS }, patch)
	}

	// Analyzer resolving the scripted results in call order ('accepted' once they run out), recording every frame and
	// the analyses in flight.
	function analyzerOf(...results: readonly (SequencerQualityResult['classification'] | SequencerQualityResult)[]) {
		const calls: SequencerQualityFrame[] = []
		const analyzer: SequencerQualityAnalyzer = (frame) => {
			calls.push(frame)
			const result = results[calls.length - 1] ?? 'accepted'
			return Promise.resolve(typeof result === 'string' ? { classification: result } : result)
		}
		return { analyzer, calls }
	}

	function discardedEvents(harness: Harness) {
		return events(harness).filter((event) => event.type === 'frameDiscarded')
	}

	function qualityOutcomes(harness: Harness) {
		return events(harness).flatMap((event) => (event.type === 'frameCaptured' ? [event.quality] : []))
	}

	async function journalKinds(harness: Harness) {
		const journal = await readSequencerJournal(join(STORAGE_ROOT, harness.runner.id, 'journal.jsonl'))
		assertJournalInvariants(journal, events(harness))
		return journal.map((entry): string => entry.kind)
	}

	// Every file of the session directory, relative with `/` separators, sorted; the lock and the journal excluded.
	function framesOf(harness: Harness) {
		const directory = join(STORAGE_ROOT, harness.runner.id)
		return (readdirSync(directory, { recursive: true }) as string[])
			.map((path) => path.split(sep).join('/'))
			.filter((path) => path.endsWith('.fit') && statSync(join(directory, path)).isFile())
			.sort()
	}

	// Capture of the frame of the context whose exposure window is [dispatch, dispatch + length] of the monotonic clock,
	// each window well after the previous one although the manual clock stands still; `during` runs before the result.
	function windowCapture(length: number, during?: (dispatch: number) => void) {
		let shift = 0

		return (context: SequencerContext): OperationResult<SequencerCapturedFrame> => {
			writeFileSync((context as SequencerCaptureContext).destination.temporary, FRAME)
			const dispatch = context.clock.monotonicNow() + shift
			shift += 10 * length
			during?.(dispatch)
			const at = context.clock.wallNow()
			return successfulOperationResult({ exposureDispatchedAt: at, exposureDispatchedMonotonic: dispatch, exposureStartedAt: at, exposureStartedMonotonic: dispatch, exposureFinishedAt: at + length, exposureFinishedMonotonic: dispatch + length })
		}
	}

	test('an analyzer without quality limits is a configuration refusal before anything runs', async () => {
		const script = new Script()
		script.startup = [script.task('coolCamera')]
		const harness = start(configurationOf(), script, { qualityAnalyzer: analyzerOf().analyzer })
		const result = await harness.runner.handle.result
		expect(result).toMatchObject({ state: 'failed', failure: { kind: 'configuration' } })
		expect(script.trace).toEqual([])
	})

	test('9: a retake keeps the slot id, consumes the attempt and runs the pre-capture again from its first task', async () => {
		const script = new Script()
		script.preCapture = [script.task('safetyGate')]
		const { analyzer, calls } = analyzerOf('rejected')
		const harness = start(judged(1, discardPolicy({ maxDiscardsPerSlot: 2 })), script, { qualityAnalyzer: analyzer })
		const result = await finish(harness)

		expect(result.state).toBe('completed')
		expect(progressOf(result, 'L')).toMatchObject({ accepted: 1, forced: 0, discarded: 1, skipped: 0 })
		expect(script.trace).toEqual(['safetyGate@frame[L][1]', 'capture@frame[L][1]#1', 'safetyGate@frame[L][1]', 'capture@frame[L][1]#2'])
		expect(calls.map((call) => [call.slot.id, call.slot.attempt, basename(call.path)])).toEqual([
			['frame[L][1]', 1, '.frame[L][1].1.partial.fit'],
			['frame[L][1]', 2, '.frame[L][1].2.partial.fit'],
		])
		expect(discardedEvents(harness)).toMatchObject([{ slot: 'frame[L][1]', attempt: 1, reasons: ['quality'], truncated: false, decision: 'retake', remainingDiscards: 1 }])
		expect(events(harness).flatMap((event) => (event.type === 'frameSelected' ? [[event.frame.attempt, event.frame.discardedTotal, event.frame.discardBudgetUsed, event.frame.captureFailures]] : []))).toEqual([
			[1, 0, 0, 0],
			[2, 1, 1, 0],
		])
		expect(await journalKinds(harness)).toEqual(['prepared', 'disposing', 'disposed', 'prepared', 'promoting', 'committed'])
	})

	test('10: a discarded frame never reaches the final: rejected/, kept beside it under another name, or deleted', async () => {
		const expected = { moveToRejected: ['L/frame[L][1].fit', 'rejected/L/frame[L][1].1.fit'], keepInPlace: ['L/frame[L][1].1.discarded.fit', 'L/frame[L][1].fit'], delete: ['L/frame[L][1].fit'] } as const

		for (const artifact of ['moveToRejected', 'keepInPlace', 'delete'] as const) {
			const script = new Script()
			const harness = start(judged(1, discardPolicy({ artifact })), script, { qualityAnalyzer: analyzerOf('rejected').analyzer })
			expect((await finish(harness)).state).toBe('completed')
			expect(framesOf(harness)).toEqual([...expected[artifact]])
		}
	})

	test('11: the decision comes before the disposition: a forced frame is promoted intact and never goes through rejected/', async () => {
		for (const artifact of ['delete', 'moveToRejected', 'keepInPlace'] as const) {
			for (const maxDiscardsPerSlot of [0, 2]) {
				const script = new Script()
				const harness = start(judged(1, discardPolicy({ maxDiscardsPerSlot, onExhausted: 'keepLast', artifact })), script, { qualityAnalyzer: analyzerOf('rejected', 'rejected', 'rejected').analyzer })
				const result = await finish(harness)

				expect(result.state).toBe('completed')
				expect(progressOf(result, 'L')).toMatchObject({ accepted: 0, forced: 1, discarded: maxDiscardsPerSlot, skipped: 0 })
				expect(events(harness).filter((event) => event.type === 'frameAccepted')).toMatchObject([{ slot: 'frame[L][1]', attempt: maxDiscardsPerSlot + 1, forced: true }])
				expect(readFileSync(join(STORAGE_ROOT, harness.runner.id, 'L', 'frame[L][1].fit'))).toEqual(FRAME)

				const discarded = framesOf(harness).filter((path) => path !== 'L/frame[L][1].fit')
				expect(discarded).toHaveLength(artifact === 'delete' ? 0 : maxDiscardsPerSlot)
				expect(discarded.some((path) => path.includes(`.${maxDiscardsPerSlot + 1}.`))).toBeFalse()

				const kinds = await journalKinds(harness)
				expect(kinds).toEqual([...Array.from({ length: maxDiscardsPerSlot }, () => ['prepared', 'disposing', 'disposed']).flat(), 'prepared', 'promoting', 'committed'])
				const journal = await readSequencerJournal(join(STORAGE_ROOT, harness.runner.id, 'journal.jsonl'))
				expect(journal.find((entry) => entry.kind === 'promoting')).toMatchObject({ forced: true, size: FRAME.byteLength })
			}
		}
	})

	test('3: skipSlot ends the slot without an accepted frame and the group finishes with fewer frames', async () => {
		const script = new Script()
		const harness = start(judged(2, discardPolicy({ maxDiscardsPerSlot: 0 })), script, { qualityAnalyzer: analyzerOf('rejected').analyzer })
		const result = await finish(harness)

		expect(result.state).toBe('completed')
		expect(progressOf(result, 'L')).toMatchObject({ accepted: 1, discarded: 1, skipped: 1 })
		expect(script.trace).toEqual(['capture@frame[L][1]#1', 'capture@frame[L][2]#1'])
		expect(discardedEvents(harness)).toMatchObject([{ decision: 'skipSlot', remainingDiscards: 0 }])
		expect(events(harness).filter((event) => event.type === 'slotSkipped')).toMatchObject([{ slot: 'frame[L][1]', reason: 'discardBudget' }])
	})

	test('3: fail ends the session with a quality failure; a circuit breaker stop ends it stopped by policy', async () => {
		const failed = await finish(start(judged(2, discardPolicy({ maxDiscardsPerSlot: 0, onExhausted: 'fail' })), new Script(), { qualityAnalyzer: analyzerOf('rejected').analyzer }))
		expect(failed).toMatchObject({ state: 'failed', failure: { kind: 'quality' } })
		expect(progressOf(failed, 'L')).toMatchObject({ accepted: 0, discarded: 1 })

		const stopped = await finish(start(judged(2, discardPolicy({ maxDiscardsPerSlot: 5, maxConsecutiveDiscards: 0, onConsecutiveExhausted: 'stop' })), new Script(), { qualityAnalyzer: analyzerOf('rejected').analyzer }))
		expect(stopped).toMatchObject({ state: 'stopped', stopCause: 'policy', failure: { kind: 'quality' } })
		expect(progressOf(stopped, 'L')).toMatchObject({ accepted: 0, discarded: 1 })
	})

	test('4: pause holds before the next exposure; resume() renews only the slot budget, durably, and the slot needs maxDiscardsPerSlot + 1 discards again', async () => {
		const store = new FileSystemSequencerCheckpointStore(STORAGE_ROOT)
		const script = new Script()
		const harness = start(judged(1, discardPolicy({ maxDiscardsPerSlot: 1, onExhausted: 'pause' })), script, { qualityAnalyzer: analyzerOf('rejected', 'rejected', 'rejected', 'rejected').analyzer, checkpointStore: store })

		await waitState(harness, 'paused')
		expect(script.trace).toEqual(['capture@frame[L][1]#1', 'capture@frame[L][1]#2'])
		expect(harness.runner.snapshot().currentFrame).toMatchObject({ attempt: 2, discardedTotal: 2, discardBudgetUsed: 2 })
		expect((await store.load(harness.runner.id))?.currentSlot).toEqual({ id: 'frame[L][1]', attempt: 3, discardedTotal: 2, discardBudgetUsed: 2, captureFailures: 0 })

		expect(harness.runner.handle.resume()).toBeTrue()
		await waitUntil(() => script.trace.length === 4 && harness.runner.snapshot().state === 'paused', 2000, 1)
		expect(script.trace).toEqual(['capture@frame[L][1]#1', 'capture@frame[L][1]#2', 'capture@frame[L][1]#3', 'capture@frame[L][1]#4'])
		expect(harness.runner.snapshot().currentFrame).toMatchObject({ attempt: 4, discardedTotal: 4, discardBudgetUsed: 2 })
		expect(discardedEvents(harness).map((event) => event.decision)).toEqual(['retake', 'pause', 'retake', 'pause'])

		expect(harness.runner.handle.resume()).toBeTrue()
		expect((await finish(harness)).state).toBe('completed')
		expect(script.trace).toHaveLength(5)
	})

	test('5, 6: the circuit breaker comes before the slot budget, an acceptance resets it, and resume() renews it alone', async () => {
		const policy = discardPolicy({ maxDiscardsPerSlot: 5, maxConsecutiveDiscards: 1, onConsecutiveExhausted: 'pause' })
		const store = new FileSystemSequencerCheckpointStore(STORAGE_ROOT)
		// L1: rejected (retake), accepted; L2: rejected (retake), rejected (2 consecutive > 1: pause), accepted.
		const script = new Script()
		const harness = start(judged(2, policy), script, { qualityAnalyzer: analyzerOf('rejected', 'accepted', 'rejected', 'rejected').analyzer, checkpointStore: store })

		await waitState(harness, 'paused')
		expect(discardedEvents(harness).map((event) => event.decision)).toEqual(['retake', 'retake', 'pause'])
		expect((await store.load(harness.runner.id))?.consecutiveDiscards).toBe(2)

		expect(harness.runner.handle.resume()).toBeTrue()
		const result = await finish(harness)
		expect(result.state).toBe('completed')
		const checkpoint = await store.load(harness.runner.id)
		expect(checkpoint?.consecutiveDiscards).toBe(0)
		expect(progressOf(result, 'L')).toMatchObject({ accepted: 2, discarded: 3 })
		expect(script.trace).toEqual(['capture@frame[L][1]#1', 'capture@frame[L][1]#2', 'capture@frame[L][2]#1', 'capture@frame[L][2]#2', 'capture@frame[L][2]#3'])
	})

	test('12: the budget survives a restart and a restart never renews a pause: the new process holds before exposing', async () => {
		const store = new FileSystemSequencerCheckpointStore(STORAGE_ROOT)
		const configuration = judged(1, discardPolicy({ maxDiscardsPerSlot: 1, onExhausted: 'pause' }))
		const first = start(configuration, new Script(), { qualityAnalyzer: analyzerOf('rejected', 'rejected').analyzer, checkpointStore: store })
		await waitState(first, 'paused')
		first.runner.dispose()
		await finish(first)

		const script = new Script()
		script.capture = script.captureStep(async (context) => {
			// resume() saved the renewed budget before this exposure.
			expect((await store.load(context.sessionId))?.currentSlot).toMatchObject({ attempt: 3, discardedTotal: 2, discardBudgetUsed: 0 })
			return captured(context)
		})
		const second = start(configuration, script, { qualityAnalyzer: analyzerOf().analyzer, checkpointStore: store, sessionId: first.runner.id })
		await waitState(second, 'paused')
		expect(script.trace).toEqual([])
		expect(second.runner.snapshot().currentFrame).toMatchObject({ id: 'frame[L][1]', attempt: 3, discardedTotal: 2, discardBudgetUsed: 2 })

		expect(second.runner.handle.resume()).toBeTrue()
		const result = await finish(second)
		expect(result.state).toBe('completed')
		expect(progressOf(result, 'L')).toMatchObject({ accepted: 1, discarded: 2 })
		expect(script.trace).toEqual(['capture@frame[L][1]#3'])
	})

	test('12: a restored slot that exhausted its budget with fail fails again before exposing', async () => {
		const store = new FileSystemSequencerCheckpointStore(STORAGE_ROOT)
		// The first process fails on the discard of the third slot attempt, the second must not expose it again.
		const configuration = judged(1, discardPolicy({ maxDiscardsPerSlot: 1, onExhausted: 'fail' }))
		const first = start(configuration, new Script(), { qualityAnalyzer: analyzerOf('rejected', 'rejected').analyzer, checkpointStore: store })
		expect(await finish(first)).toMatchObject({ state: 'failed', failure: { kind: 'quality' } })
		expect((await store.load(first.runner.id))?.currentSlot).toEqual({ id: 'frame[L][1]', attempt: 3, discardedTotal: 2, discardBudgetUsed: 2, captureFailures: 0 })

		const script = new Script()
		const second = start(configuration, script, { qualityAnalyzer: analyzerOf().analyzer, checkpointStore: store, sessionId: first.runner.id })
		expect(await finish(second)).toMatchObject({ state: 'failed', failure: { kind: 'quality' } })
		expect(script.trace).toEqual([])
	})

	test('13: a graceful stop during the analysis keeps the frame durable and retakes nothing', async () => {
		const script = new Script()
		let release: ((result: SequencerQualityResult) => void) | undefined
		const analyzer: SequencerQualityAnalyzer = () =>
			new Promise((resolve) => {
				release = resolve
			})
		const harness = start(judged(2, discardPolicy({ maxDiscardsPerSlot: 3 })), script, { qualityAnalyzer: analyzer })

		await waitUntil(() => release !== undefined, 2000, 1)
		void harness.runner.handle.stop('graceful')
		release!({ classification: 'rejected' })

		const result = await finish(harness)
		expect(result).toMatchObject({ state: 'stopped', stopCause: 'user' })
		expect(progressOf(result, 'L')).toMatchObject({ accepted: 0, discarded: 1 })
		expect(discardedEvents(harness)).toMatchObject([{ decision: 'discardFinal' }])
		expect(script.trace).toEqual(['capture@frame[L][1]#1'])
		expect(framesOf(harness)).toEqual(['rejected/L/frame[L][1].1.fit'])
	})

	test('14, I33: a guiding interruption inside [dispatch, end] discards a light; one outside does not', async () => {
		const policy = discardPolicy({ criteria: { quality: false, guidingInterruption: true, unsafeDuringExposure: false }, maxDiscardsPerSlot: 2 })

		for (const [offset, discarded] of [
			[-1, false],
			[0, true],
			[500, true],
			[1000, true],
			[1001, false],
		] as const) {
			const guiding = new ScriptedGuidingSession()
			const script = new Script()
			let calls = 0
			script.capture = script.captureStep(windowCapture(1000, (dispatch) => calls++ === 0 && guiding.interrupt({ kind: 'starLost', receivedMonotonic: dispatch + offset, receivedAt: 0 })))
			const harness = start(judged(1, policy, { guiding: GUIDING }), script, { guiding })
			const result = await finish(harness)

			expect(result.state).toBe('completed')
			expect(progressOf(result, 'L')).toMatchObject({ accepted: 1, discarded: discarded ? 1 : 0 })
			if (discarded) expect(discardedEvents(harness)).toMatchObject([{ reasons: ['guidingInterruption'], truncated: false }])
		}
	})

	test('14: a guided light whose window the interruption history no longer covers is discarded (fail-closed)', async () => {
		const guiding = new ScriptedGuidingSession({ capacity: 1 })
		const script = new Script()
		let calls = 0
		// Two interruptions inside the first window overflow a history of one.
		script.capture = script.captureStep(
			windowCapture(1000, (dispatch) => {
				if (calls++ > 0) return
				guiding.interrupt({ kind: 'starLost', receivedMonotonic: dispatch + 100, receivedAt: 0 })
				guiding.interrupt({ kind: 'lockPositionLost', receivedMonotonic: dispatch + 200, receivedAt: 0 })
			}),
		)
		const harness = start(judged(1, discardPolicy({ criteria: { quality: false, guidingInterruption: true, unsafeDuringExposure: false } }), { guiding: GUIDING }), script, { guiding })
		expect((await finish(harness)).state).toBe('completed')
		expect(discardedEvents(harness)).toMatchObject([{ reasons: ['guidingInterruption'] }])
	})

	test('I27, I40: safety unsafe at any instant of [dispatch, end] discards a light, a wall jump changes nothing, and darks are never judged by it', async () => {
		const policy = discardPolicy({ criteria: { quality: false, guidingInterruption: false, unsafeDuringExposure: true }, maxDiscardsPerSlot: 2 })

		for (const [unsafeAt, safeAt, discarded] of [
			// Unsafe from 1 ms before the dispatch to the dispatch itself: in force at the dispatch.
			[-1, 0, false],
			[-1, 1, true],
			[500, 600, true],
			[1000, 1001, true],
			[1001, 1002, false],
		] as const) {
			const safety = new ScriptedSafetySource()
			const script = new Script()
			let calls = 0
			const harness: Harness = start(judged(1, policy), script, { safety })
			script.capture = script.captureStep(async (context) => {
				const first = calls++ === 0
				const dispatch = context.clock.monotonicNow() + 1
				if (first) {
					await harness.clock.advance(1 + unsafeAt)
					safety.publish('unsafe')
					harness.clock.jumpWall(-3_600_000)
					await harness.clock.advance(safeAt - unsafeAt)
					safety.publish('safe')
					harness.clock.jumpWall(7_200_000)
				}
				writeFileSync((context as SequencerCaptureContext).destination.temporary, FRAME)
				const at = context.clock.wallNow()
				return successfulOperationResult({ exposureDispatchedAt: at, exposureDispatchedMonotonic: dispatch, exposureStartedAt: at, exposureStartedMonotonic: dispatch, exposureFinishedAt: at, exposureFinishedMonotonic: dispatch + 1000 })
			})
			const result = await finish(harness)

			expect(result.state).toBe('completed')
			expect(progressOf(result, 'L')).toMatchObject({ accepted: 1, discarded: discarded ? 1 : 0 })
			if (discarded) expect(discardedEvents(harness)).toMatchObject([{ reasons: ['unsafeDuringExposure'], truncated: false }])
			expect(events(harness).filter((event) => event.type === 'safetyChanged')).toHaveLength(2)
			expect(safety.subscriptions).toBe(0)
		}
	})

	test('I27: without a safety source no window is covered and the criterion fails the light closed', async () => {
		const harness = start(judged(1, discardPolicy({ criteria: { quality: false, guidingInterruption: false, unsafeDuringExposure: true }, maxDiscardsPerSlot: 0 })), new Script())
		const result = await finish(harness)
		expect(progressOf(result, 'L')).toMatchObject({ accepted: 0, skipped: 1 })
		expect(discardedEvents(harness)).toMatchObject([{ reasons: ['unsafeDuringExposure'], truncated: true }])
	})

	test('the safety source is subscribed and read before the first startup task and released by the terminalization', async () => {
		const safety = new ScriptedSafetySource('unknown')
		const script = new Script()
		script.startup = [
			script.task('coolCamera', () => {
				expect(safety.subscriptions).toBe(1)
				expect(safety.reads).toBe(1)
				return OK
			}),
		]
		const harness = start(configurationOf(), script, { safety })
		expect((await finish(harness)).state).toBe('completed')
		expect(script.trace).toEqual(['coolCamera', 'capture@frame[L][1]#1'])
		expect(safety.subscriptions).toBe(0)
	})

	test('missingDispatch: a frame without its dispatch instant fails the window criteria closed', async () => {
		const script = new Script()
		let calls = 0
		script.capture = script.captureStep((context) => {
			const result = captured(context)
			if (calls++ > 0 || !result.ok) return result
			const { exposureStartedAt, exposureStartedMonotonic, exposureFinishedAt, exposureFinishedMonotonic } = result.value
			return successfulOperationResult({ exposureStartedAt, exposureStartedMonotonic, exposureFinishedAt, exposureFinishedMonotonic })
		})
		const harness = start(judged(1, discardPolicy({ criteria: { quality: false, guidingInterruption: false, unsafeDuringExposure: true } })), script, { safety: new ScriptedSafetySource() })
		expect((await finish(harness)).state).toBe('completed')
		expect(discardedEvents(harness)).toMatchObject([{ reasons: ['unsafeDuringExposure'], detail: 'missingDispatch' }])
	})

	test('15: corrective intents of a discarded frame are persisted and seen by the retake', async () => {
		const script = new Script()
		const seen: boolean[] = []
		script.preCapture = [
			script.task('autofocus', (context) => {
				seen.push(context.state.intents.autofocus)
				return OK
			}),
		]
		const harness = start(judged(1, discardPolicy({ maxDiscardsPerSlot: 2 })), script, { qualityAnalyzer: analyzerOf({ classification: 'rejected', intents: { autofocus: true } }).analyzer })
		expect((await finish(harness)).state).toBe('completed')
		expect(seen).toEqual([false, true])
		expect(harness.runner.snapshot().intents).toMatchObject({ autofocus: true })
	})

	test('16: the analyzer reads only the path of the durable temporary, after the capture result, once per attempt', async () => {
		const script = new Script()
		const order: string[] = []
		script.capture = script.captureStep((context) => {
			const result = captured(context)
			order.push('result')
			return result
		})
		const analyzer: SequencerQualityAnalyzer = (frame) => {
			order.push('analyze')
			expect(Object.keys(frame).sort()).toEqual(['exposureFinishedAt', 'exposureStartedAt', 'path', 'slot'])
			expect(readFileSync(frame.path)).toEqual(FRAME)
			expect(frame.path.endsWith('.partial.fit')).toBeTrue()
			return Promise.resolve({ classification: 'accepted', metrics: { hfd: 2.5, stars: 120 } })
		}
		const harness = start(judged(2), script, { qualityAnalyzer: analyzer })
		expect((await finish(harness)).state).toBe('completed')
		expect(order).toEqual(['result', 'analyze', 'result', 'analyze'])
		expect(qualityOutcomes(harness)).toEqual([
			{ kind: 'analyzed', result: { classification: 'accepted', metrics: { hfd: 2.5, stars: 120 } } },
			{ kind: 'analyzed', result: { classification: 'accepted', metrics: { hfd: 2.5, stars: 120 } } },
		])
	})

	test('17: the camera is not leased by the session while the analyzer runs', async () => {
		let leased: readonly unknown[] | undefined
		const harness: Harness = start(judged(1), new Script(), {
			qualityAnalyzer: () => {
				leased = harness.coordinator.arbiter.ownersOf(resourceKey(CAMERA))
				return Promise.resolve({ classification: 'accepted' })
			},
		})
		expect((await finish(harness)).state).toBe('completed')
		expect(leased).toEqual([])
	})

	// Cooperative analyzer that settles with `result` only when its signal aborts or `release` is called, counting the
	// analyses in flight.
	class SlowAnalyzer {
		readonly frames: SequencerQualityFrame[] = []
		inFlight = 0
		maxInFlight = 0
		release?: (result: SequencerQualityResult) => void

		constructor(
			readonly cooperative: boolean,
			readonly result: SequencerQualityResult,
		) {}

		readonly analyze: SequencerQualityAnalyzer = (frame, signal) => {
			this.frames.push(frame)
			this.maxInFlight = Math.max(this.maxInFlight, ++this.inFlight)

			return new Promise<SequencerQualityResult>((resolve) => {
				const settle = (result: SequencerQualityResult) => {
					this.release = undefined
					this.inFlight--
					resolve(result)
				}

				this.release = settle
				if (this.cooperative) signal.addEventListener('abort', () => settle(this.result), { once: true })
			})
		}
	}

	// Asserts that no analysis is in flight whenever the storage touches the temporary.
	function guardStorage(harness: Harness, analyzer: SlowAnalyzer) {
		const touched: string[] = []
		const { storage } = harness
		const promote = storage.promote.bind(storage)
		const dispose = storage.dispose.bind(storage)
		spyOn(storage, 'promote').mockImplementation((...args) => {
			touched.push(`promote ${analyzer.inFlight}`)
			return promote(...args)
		})
		spyOn(storage, 'dispose').mockImplementation((...args) => {
			touched.push(`dispose ${analyzer.inFlight}`)
			return dispose(...args)
		})
		return touched
	}

	test('18, 18a: a cooperative timeout aborts the analysis; the file moves only after it ended, the frame is accepted as unknown', async () => {
		const analyzer = new SlowAnalyzer(true, { classification: 'rejected' })
		const harness = start(judged(3, discardPolicy({ maxDiscardsPerSlot: 3 })), new Script(), { qualityAnalyzer: analyzer.analyze })
		const touched = guardStorage(harness, analyzer)

		for (let frame = 1; frame <= 3; frame++) {
			await waitUntil(() => analyzer.frames.length === frame, 2000, 1)
			await harness.clock.advance(QUALITY_LIMITS.timeout * 1000 - 1)
			expect(touched).toHaveLength(frame - 1)
			await harness.clock.advance(1)
		}

		const result = await finish(harness)
		expect(result.state).toBe('completed')
		expect(progressOf(result, 'L')).toMatchObject({ accepted: 3, discarded: 0 })
		expect(touched).toEqual(['promote 0', 'promote 0', 'promote 0'])
		expect(analyzer.maxInFlight).toBe(1)
		expect(qualityOutcomes(harness)).toEqual([{ kind: 'timeout' }, { kind: 'timeout' }, { kind: 'timeout' }])
		expect(events(harness).filter((event) => event.type === 'qualityTimeout')).toMatchObject([{ attempt: 1 }, { attempt: 1 }, { attempt: 1 }])
	})

	test('18b: an analyzer ignoring the signal that ends 2 s after the abort is awaited, never faulted, and called again', async () => {
		const harness = start(judged(2), new Script(), {
			qualityAnalyzer: () => harness.clock.delay(12000, new AbortController().signal).then(() => ({ classification: 'rejected' })),
		})
		await waitUntil(() => harness.clock.pending === 2, 2000, 1)
		await harness.clock.advance(10000)
		expect(await journalKinds(harness)).toEqual(['prepared'])
		await harness.clock.advance(2000)
		await waitUntil(() => harness.clock.pending === 2, 2000, 1)
		await harness.clock.advance(12000)

		expect((await finish(harness)).state).toBe('completed')
		expect(qualityOutcomes(harness)).toEqual([{ kind: 'timeout' }, { kind: 'timeout' }])
		expect(events(harness).some((event) => event.type === 'collaboratorUnresponsive' || event.type === 'qualityAnalyzerFaulted')).toBeFalse()
	})

	test('18c: an analyzer that never yields is awaited without limit, reported once at abortGrace, then faulted and never called again', async () => {
		const analyzer = new SlowAnalyzer(false, { classification: 'rejected' })
		const harness = start(judged(2), new Script(), { qualityAnalyzer: analyzer.analyze })
		const touched = guardStorage(harness, analyzer)
		const unresponsive = () => events(harness).filter((event) => event.type === 'collaboratorUnresponsive')

		await waitUntil(() => analyzer.frames.length === 1, 2000, 1)
		await harness.clock.advance(QUALITY_LIMITS.timeout * 1000)
		await harness.clock.advance(QUALITY_LIMITS.abortGrace * 1000 - 1)
		expect(unresponsive()).toHaveLength(0)
		await harness.clock.advance(1)
		expect(unresponsive()).toMatchObject([{ service: 'quality', slot: 'frame[L][1]', attempt: 1 }])
		expect(harness.runner.snapshot().waitingFor).toBe('qualityAnalyzer')

		await harness.clock.advance(3_600_000)
		expect(unresponsive()).toHaveLength(1)
		expect(touched).toEqual([])
		expect(analyzer.inFlight).toBe(1)
		expect(await journalKinds(harness)).toEqual(['prepared'])

		analyzer.release!({ classification: 'rejected' })
		const result = await finish(harness)
		expect(result.state).toBe('completed')
		expect(analyzer.frames).toHaveLength(1)
		expect(touched).toEqual(['promote 0', 'promote 0'])
		expect(qualityOutcomes(harness)).toEqual([{ kind: 'timeout' }, { kind: 'error', detail: 'the quality analyzer is faulted' }])
		expect(events(harness).filter((event) => event.type === 'qualityAnalyzerFaulted')).toHaveLength(1)
		expect(harness.runner.snapshot().waitingFor).toBeUndefined()
	})

	test('18d: an immediate stop during a cooperative analysis promotes the frame as unknown without retake, then shuts down', async () => {
		const analyzer = new SlowAnalyzer(true, { classification: 'rejected' })
		const script = new Script()
		script.shutdown = [script.shutdownTask('warmCamera')]
		const harness = start(judged(2, discardPolicy({ maxDiscardsPerSlot: 3 })), script, { qualityAnalyzer: analyzer.analyze })

		await waitUntil(() => analyzer.frames.length === 1, 2000, 1)
		const result = await harness.runner.handle.stop('immediate')
		await finish(harness)

		expect(result).toMatchObject({ state: 'stopped', stopCause: 'user' })
		expect(progressOf(result, 'L')).toMatchObject({ accepted: 1, discarded: 0 })
		expect(qualityOutcomes(harness)).toEqual([{ kind: 'aborted' }])
		expect(script.trace).toEqual(['capture@frame[L][1]#1', 'warmCamera'])
	})

	test('18d: with an analyzer ignoring the signal, the immediate stop waits for it before disposing of the file', async () => {
		const analyzer = new SlowAnalyzer(false, { classification: 'rejected' })
		const harness = start(judged(2), new Script(), { qualityAnalyzer: analyzer.analyze })
		const session = { done: false }
		void harness.runner.handle.result.then(() => (session.done = true))

		await waitUntil(() => analyzer.frames.length === 1, 2000, 1)
		void harness.runner.handle.stop('immediate')
		await harness.clock.advance(3_600_000)
		expect(session.done).toBeFalse()
		expect(await journalKinds(harness)).toEqual(['prepared'])

		analyzer.release!({ classification: 'accepted' })
		const result = await finish(harness)
		expect(result.state).toBe('stopped')
		expect(qualityOutcomes(harness)).toEqual([{ kind: 'aborted' }])
	})

	test('18e: an analysis settling in the same tick as its timeout has exactly one outcome', async () => {
		for (let run = 0; run < 3; run++) {
			const harness = start(judged(1, discardPolicy({ maxDiscardsPerSlot: 3 })), new Script(), {
				qualityAnalyzer: () => harness.clock.delay(QUALITY_LIMITS.timeout * 1000, new AbortController().signal).then(() => ({ classification: 'rejected' })),
			})
			await waitUntil(() => harness.clock.pending === 2, 2000, 1)
			await harness.clock.advance(QUALITY_LIMITS.timeout * 1000)

			expect((await finish(harness)).state).toBe('completed')
			expect(qualityOutcomes(harness)).toEqual([{ kind: 'timeout' }])
			expect(events(harness).filter((event) => event.type === 'frameAccepted' || event.type === 'frameDiscarded')).toHaveLength(1)
		}
	})

	test('19: an analyzer that throws, rejects or resolves a malformed result never fails the capture: error, accepted', async () => {
		const analyzers: readonly [SequencerQualityAnalyzer, string][] = [
			[
				() => {
					throw new Error('sync')
				},
				'sync',
			],
			[() => Promise.reject(new Error('async')), 'async'],
			[() => Promise.resolve({ classification: 'great' } as never), 'unknown quality classification great'],
			[() => Promise.resolve({ classification: 'rejected', metrics: { hfd: Number.NaN } }), 'malformed quality metric hfd'],
			[() => Promise.resolve({ classification: 'rejected', intents: { autofocus: 'yes' } } as never), 'malformed corrective intents'],
			[() => Promise.resolve(undefined as never), 'the quality analyzer resolved no result'],
		]

		for (const [analyzer, detail] of analyzers) {
			const harness = start(judged(1), new Script(), { qualityAnalyzer: analyzer })
			const result = await finish(harness)
			expect(result.state).toBe('completed')
			expect(progressOf(result, 'L')).toMatchObject({ accepted: 1, discarded: 0 })
			expect(qualityOutcomes(harness)).toEqual([{ kind: 'error', detail }])
		}
	})

	test('20: without analyzer the outcome is skipped, without any wait or quality event', async () => {
		const harness = start(judged(2), new Script())
		expect((await finish(harness)).state).toBe('completed')
		expect(qualityOutcomes(harness)).toEqual([{ kind: 'skipped' }, { kind: 'skipped' }])
		expect(events(harness).some((event) => event.type === 'qualityTimeout' || event.type === 'collaboratorUnresponsive')).toBeFalse()
	})

	test('21: with criteria.quality false the analyzer still runs and its intents apply, but it never discards', async () => {
		const { analyzer, calls } = analyzerOf({ classification: 'rejected', intents: { recenter: true, recoverGuiding: true } }, 'rejected')
		const harness = start(judged(2, discardPolicy({ criteria: { ...QUALITY_ONLY, quality: false } })), new Script(), { qualityAnalyzer: analyzer })
		const result = await finish(harness)
		expect(progressOf(result, 'L')).toMatchObject({ accepted: 2, discarded: 0 })
		expect(calls).toHaveLength(2)
		expect(harness.runner.snapshot().intents).toEqual({ autofocus: false, recenter: true, recoverGuiding: true })
	})

	test('light exposures count discarded lights and never darks', async () => {
		const store = new FileSystemSequencerCheckpointStore(STORAGE_ROOT)
		const groups: SequencerFrameGroup[] = [
			{ ...scheduled('L', 1), discard: discardPolicy({ maxDiscardsPerSlot: 2 }) },
			{ ...scheduled('D', 1), capture: DARK },
		]
		const harness = start(configurationOf(groups, { quality: QUALITY_LIMITS }), new Script(), { qualityAnalyzer: analyzerOf('rejected', 'rejected').analyzer, checkpointStore: store })
		expect((await finish(harness)).state).toBe('completed')
		expect((await store.load(harness.runner.id))?.anchors.lightExposures).toBe(3)
	})
})

describe('P7 discard budgets across restarts', () => {
	// Whether a path is the lock of a session, which a simulated crash still releases.
	function isLockPath(path: string) {
		return /(?:^|[\\/])(?:session\.lock|session\.lock\.reclaim|\.session\.lock\..+\.tmp)$/.test(path)
	}

	// Plays the death of the process: every durable operation but the lock fails from now on, the runner is disposed
	// and its end awaited.
	async function crash(harness: Harness) {
		using _ = injectFileSystemFaults({ failAt: 1, mode: 'crash', spare: isLockPath })
		const { warn } = console
		console.warn = () => {}

		try {
			harness.runner.dispose()
			await harness.runner.handle.result
		} finally {
			console.warn = warn
		}
	}

	test.skipIf(isTimeConsumingTestSkipped())(
		'between two resume() calls, across crashes with or without an exposure in flight, no slot exceeds (1 + maxDiscardsPerSlot) × retry.maxAttempts attempts and no counter goes back',
		async () => {
			const store = new FileSystemSequencerCheckpointStore(STORAGE_ROOT)
			// What the seeds exercised, so a change of the driver cannot silently stop covering it.
			const covered = { crashes: 0, restores: 0, discards: 0, resumes: 0 }

			for (let seed = 1; seed <= 150; seed++) {
				const random = mulberry32(seed)
				const maxDiscardsPerSlot = Math.floor(random() * 3)
				const maxAttempts = 1 + Math.floor(random() * 3)
				const onExhausted = (['pause', 'skipSlot', 'keepLast', 'pause'] as const)[Math.floor(random() * 4)]
				const consecutive = random() < 0.4 ? { maxConsecutiveDiscards: Math.floor(random() * 3), onConsecutiveExhausted: 'pause' as const } : {}
				const policy: SequencerFrameDiscardPolicy = { criteria: { quality: true, guidingInterruption: false, unsafeDuringExposure: false }, maxDiscardsPerSlot, onExhausted, artifact: 'moveToRejected', ...consecutive }
				const configuration = configurationOf([{ ...scheduled('L', 1 + Math.floor(random() * 3)), discard: policy }], { quality: { timeout: 10 }, retry: { maxAttempts, delay: 0, backoff: 1, maximumDelay: 0, retryOn: ['timeout'] }, onFailure: random() < 0.5 ? 'pause' : 'skipFrame' })
				const bound = (1 + maxDiscardsPerSlot) * maxAttempts
				// Distinct attempts exposed per slot since the last resume(), and the last attempt and total exposed per slot.
				const attempts = new Map<string, Set<number>>()
				const last = new Map<string, { attempt: number; discardedTotal: number }>()
				let sessionId: string | undefined
				let ended = false

				try {
					for (let process = 0; process < 12 && !ended; process++) {
						const persisted = sessionId === undefined ? undefined : (await store.load(sessionId))?.currentSlot
						const script = new Script()
						const pending: { readonly settle: (result: SequencerQualityResult) => void }[] = []
						// Slot the process restored, read when it started.
						let restored: SequencerFrameSlotSnapshot | undefined

						script.capture = script.captureStep(async (context) => {
							const { id, attempt, discardedTotal } = context.frame!
							const seen = attempts.get(id) ?? new Set<number>()
							seen.add(attempt)
							attempts.set(id, seen)
							if (seen.size > bound) throw new Error(`${id}: ${seen.size} attempts since the last resume, above ${bound}`)

							const previous = last.get(id)
							if (previous !== undefined && (attempt < previous.attempt || discardedTotal < previous.discardedTotal)) throw new Error(`${id}: attempt or total went back`)
							last.set(id, { attempt, discardedTotal })
							return await script.blockCapture()(context)
						})

						const analyzer: SequencerQualityAnalyzer = (_, signal) =>
							new Promise((resolve) => {
								const entry = { settle: (result: SequencerQualityResult) => resolve(result) }
								pending.push(entry)
								signal.addEventListener('abort', () => resolve({ classification: 'accepted' }), { once: true })
							})

						const harness = start(configuration, script, {
							qualityAnalyzer: analyzer,
							checkpointStore: store,
							...(sessionId !== undefined && { sessionId }),
							onEvent: (event, runner) => {
								if (event.type === 'sessionStarted') restored = runner.snapshot().currentFrame
							},
						})
						sessionId = harness.runner.id
						const session = { done: false }
						void harness.runner.handle.result.then(() => (session.done = true))

						// A restart never renews a counter: the restored slot holds at least what was persisted.
						await waitUntil(() => session.done || events(harness).some((event) => event.type === 'sessionStarted'), 5000, 1)
						const current = restored

						if (persisted !== undefined && current !== undefined && current.id === persisted.id) {
							covered.restores++
							expect(current.attempt).toBeGreaterThanOrEqual(persisted.attempt)
							expect(current.discardedTotal).toBeGreaterThanOrEqual(persisted.discardedTotal)
							expect(current.discardBudgetUsed).toBeGreaterThanOrEqual(persisted.discardBudgetUsed)
							expect(current.captureFailures).toBeGreaterThanOrEqual(persisted.captureFailures)
						}

						let crashed = false

						for (let step = 0; step < 60 && !session.done && !crashed; step++) {
							await new Promise<void>((resolve) => {
								setImmediate(resolve)
							})
							await waitUntil(() => session.done || script.blocked.length > 0 || pending.length > 0 || harness.clock.pending > 0 || harness.runner.snapshot().state === 'paused', 5000, 1)
							if (session.done) break
							const roll = random()

							if (roll < 0.06) {
								await crash(harness)
								covered.crashes++
								crashed = true
							} else if (harness.runner.snapshot().state === 'paused') {
								// resume() renews the counter that paused: a new window of the bound starts.
								covered.resumes++
								attempts.clear()
								harness.runner.handle.resume()
							} else if (script.blocked.length > 0) {
								const blocked = script.blocked[0]
								blocked.settle(random() < 0.75 ? captured(blocked.context) : failedOperationResult('timeout'))
							} else if (pending.length > 0) {
								pending.shift()!.settle({ classification: random() < 0.6 ? 'rejected' : 'accepted' })
							} else if (harness.clock.pending > 0) {
								await harness.clock.advance(1000)
							}
						}

						if (!crashed && !session.done) await crash(harness)
						const result = await harness.runner.handle.result
						assertRunnerInvariants(harness.recorder.entries)
						covered.discards += events(harness).filter((event) => event.type === 'frameDiscarded').length
						if (!crashed && session.done && result.state !== 'failed') ended = true
						for (const recorder of recorders.splice(0)) recorder[Symbol.dispose]()
					}

					assertJournalInvariants(await readSequencerJournal(join(STORAGE_ROOT, sessionId!, 'journal.jsonl')))
				} catch (error) {
					throw new Error(`seed ${seed}: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
				}
			}

			expect(covered.crashes).toBeGreaterThan(50)
			expect(covered.restores).toBeGreaterThan(50)
			expect(covered.discards).toBeGreaterThan(200)
			expect(covered.resumes).toBeGreaterThan(150)
		},
		120000,
	)
})
