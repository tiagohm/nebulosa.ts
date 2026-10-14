import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { writeFileSync } from 'fs'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { type Camera, type Cover, DEFAULT_CAMERA, DEFAULT_COVER, DEFAULT_DOME, type Device, type Dome } from '../../../src/devices/indi/device'
import { failedOperationResult, type OperationContext, OperationCoordinator, type OperationResult, successfulOperationResult } from '../../../src/devices/orchestration/operation'
import { abortableDelay } from '../../../src/devices/orchestration/operation.wait'
import { ResourceArbiter, resourceKey } from '../../../src/devices/orchestration/resource'
import { deg } from '../../../src/math/units/angle'
import { awaitCameraRecoveryTask, captureFrameStep } from '../../../src/observation/sequencer/capture'
import { ensureGuidingTask, sequencerShutdownTasks } from '../../../src/observation/sequencer/guiding'
import { closeOrParkDomeTask, type SequencerLifecycleServices, sequencerShutdownLifecycleTasks, sequencerStartupLifecycleTasks, stopTrackingTask } from '../../../src/observation/sequencer/lifecycle'
import { preflightSequencerMeridian, SequencerMountTrackingProtection } from '../../../src/observation/sequencer/pointing'
// oxfmt-ignore
import { type SequencerCapturedFrame, type SequencerCaptureStep, type SequencerContext, type SequencerProtectionOutcome, type SequencerRunner, type SequencerShutdownTask, type SequencerSupervisor, type SequencerSupervisorHost, type SequencerTask, type SequencerTaskResult, startSequencerRunner } from '../../../src/observation/sequencer/runner'
// oxfmt-ignore
import { isSequencerSafetyGated, preflightSequencerSafety, safetyGateTask, SEQUENCER_SAFETY_GATED_TASKS, sequencerSafetyStartupTasks, sequencerSafetyTasks, waitForSequencerSafety } from '../../../src/observation/sequencer/safety'
// oxfmt-ignore
import type { SequencerCameraCapture, SequencerClock, SequencerConfiguration, SequencerEvent, SequencerGuidingConfiguration, SequencerQualityAnalyzer, SequencerResult, SequencerSafetyConfiguration, SequencerShutdownConfiguration, SequencerStartupConfiguration } from '../../../src/observation/sequencer/sequencer'
import { isSequencerSafetyBlocking } from '../../../src/observation/sequencer/state'
import { FileSystemSequencerStorage, prepareFrameDestinationTask, readSequencerJournal } from '../../../src/observation/sequencer/storage'
import { waitUntil } from '../../util'
// oxfmt-ignore
import { assertRunnerInvariants, assertSequencerInvariants, connectSequencerRig, createSequencerRig, createTestSequence, type DeviceCommandEntry, type DeviceLogEntry, expectNoSequencerLeaks, FakeMount, ManualSequencerClock, type RunnerRecorder, recordDevices, recordRunner, resetSequencerRig, ScriptedGuidingSession, ScriptedSafetySource } from './util'

// Safety of the Sequencer (sections 18, 20.1, 31, 32 and 49.15–49.16): the gates of the startup and of the pre-capture,
// the reaction of the runner to a change while running, and the critical protection of `shutdownImmediately`, over a
// fake observatory whose every command leases its device in the reserved scope (a command refused `busy` is recorded),
// a fake mount with its commander, the scripted guiding session and the scripted safety source, on a manual clock; then
// the scenarios of section 50.3 on the INDI simulator rig.

const LIGHT: SequencerCameraCapture = { exposureTime: 60, exposureTimeUnit: 'second', frameType: 'LIGHT', x: 0, y: 0, width: 0, height: 0, subframe: false, binX: 1, binY: 1, frameFormat: '', gain: 100, offset: 10, compressed: false }
const FRAME = Buffer.from('SIMPLE  =                    T')
const OK: SequencerTaskResult = { ok: true }
const GUIDING: SequencerGuidingConfiguration = { settle: { pixels: 1, time: 0, timeout: 10 }, pauseTimeout: 20, maxRecoveries: 0, recalibrate: false, flipCalibration: false, onFailure: 'fail' }
const SHUTDOWN: SequencerShutdownConfiguration = { stepTimeout: 5, totalTimeout: 60, stopTracking: 'required', closeCover: 'required', parkMount: 'required', closeOrParkDome: 'required', warmCamera: 'required' }

const STORAGE_ROOT = await mkdtemp(join(tmpdir(), 'nebulosa-sequencer-safety-'))
const recorders: RunnerRecorder[] = []

afterEach(() => {
	for (const recorder of recorders.splice(0)) recorder[Symbol.dispose]()
})

afterAll(async () => {
	await rm(STORAGE_ROOT, { recursive: true, force: true })
})

// Connected view of a fake device whose resource key is its name.
function fakeDevice<D extends Device>(base: D, name: string): D {
	return { ...base, id: name, name, hardwareId: name, connected: true }
}

function safetyOf(patch: Partial<SequencerSafetyConfiguration> = {}): SequencerSafetyConfiguration {
	return { unsafeAction: 'pauseAfterFrame', onUnsafeAtStartup: 'stop', unknownIsUnsafe: true, ...patch }
}

function configurationOf(patch: Partial<SequencerConfiguration> = {}, count: number = 1): SequencerConfiguration {
	return {
		schemaVersion: 1,
		id: 'safety',
		revision: 1,
		name: 'Safety',
		capture: { order: 'sequential', groups: [{ kind: 'scheduled', id: 'L', enabled: true, capture: LIGHT, count }], retry: { maxAttempts: 1, delay: 0, backoff: 1, maximumDelay: 0, retryOn: [] }, onFailure: 'fail', cameraRecovery: { onTimeout: 'stop' } },
		startup: { dome: { open: true }, cover: { open: true }, mount: { unpark: true }, onFailure: 'fail' },
		shutdown: SHUTDOWN,
		execution: { compensation: { timeout: 5 } },
		safety: safetyOf(),
		...patch,
	}
}

// Resolves `aborted` once `signal` aborts.
function untilAborted(signal: AbortSignal) {
	return new Promise<OperationResult<void>>((resolve) => {
		if (signal.aborted) resolve(failedOperationResult('aborted'))
		else signal.addEventListener('abort', () => resolve(failedOperationResult('aborted')), { once: true })
	})
}

// Fake observatory: the physical state of its devices, the log of every command when it acts (`{command}`), the commands
// refused `busy`, and the lifecycle tasks over it. Every command leases its device as a child of the root of its task;
// one listed in `holds` waits, cancellably, until the test releases it.
class Observatory {
	readonly log: string[] = []
	readonly busy: string[] = []
	readonly camera = fakeDevice<Camera>({ ...DEFAULT_CAMERA, hasCoolerControl: true }, 'Camera')
	readonly cover = fakeDevice<Cover>(DEFAULT_COVER, 'Cover')
	readonly dome = fakeDevice<Dome>(DEFAULT_DOME, 'Dome')
	readonly fake: FakeMount
	readonly holds = new Map<string, PromiseWithResolvers<void>>()
	// Called synchronously right after a command acted, before its task goes on.
	onApplied?: (name: string) => void
	domeOpen = false
	coverOpen = false
	mountParked = true
	cooler = false

	constructor(readonly clock: ManualSequencerClock) {
		this.fake = new FakeMount(clock, -deg(60))
	}

	get mount() {
		return this.fake.mount
	}

	// Makes the next `name` wait until `release(name)`.
	hold(name: string) {
		this.holds.set(name, Promise.withResolvers())
	}

	release(name: string) {
		this.holds.get(name)?.resolve()
		this.holds.delete(name)
	}

	// Runs `name` as a child of `scope` leasing `device`; aborted (nothing applied) when its root aborts while held.
	async command(scope: OperationContext, name: string, device: Device, apply: VoidFunction): Promise<SequencerTaskResult> {
		const result = await scope.start<void>(name, [{ key: resourceKey(device), device }], async (context) => {
			this.log.push(name)
			const hold = this.holds.get(name)

			if (hold !== undefined) {
				const released = await Promise.race([hold.promise.then(() => successfulOperationResult(undefined)), untilAborted(context.signal)])
				if (!released.ok) return released
			}

			apply()
			this.onApplied?.(name)
			return successfulOperationResult(undefined)
		}).result

		if (!result.ok && result.reason === 'busy') this.busy.push(name)
		return result.ok ? OK : { ok: false, failure: { kind: 'operation', reason: result.reason } }
	}

	// Startup tasks: cooling, then the openings, each only while its device is not where it would leave it.
	startup(): SequencerTask[] {
		return [
			{ id: 'coolCamera', shouldRun: () => !this.cooler, run: (context) => this.command(context.scope, 'coolCamera', this.camera, () => (this.cooler = true)) },
			{ id: 'openDome', shouldRun: () => !this.domeOpen, run: (context) => this.command(context.scope, 'openDome', this.dome, () => (this.domeOpen = true)) },
			{ id: 'openCover', shouldRun: () => !this.coverOpen, run: (context) => this.command(context.scope, 'openCover', this.cover, () => (this.coverOpen = true)) },
			{ id: 'unparkMount', shouldRun: () => this.mountParked, run: (context) => this.command(context.scope, 'unparkMount', this.mount, () => (this.mountParked = false)) },
		]
	}

	// Lifecycle steps of the shutdown after the tracking off, each only while its device is not safe yet; with
	// `interlock` the dome closes only over the parked mount.
	shutdown(interlock = false): SequencerShutdownTask[] {
		return [
			{ id: 'closeCover', policy: 'required', device: (devices) => devices.cover, shouldRun: () => this.coverOpen, run: (context) => this.command(context.scope, 'closeCover', this.cover, () => (this.coverOpen = false)) },
			{ id: 'parkMount', policy: 'required', device: (devices) => devices.mount, shouldRun: () => !this.mountParked, run: (context) => this.command(context.scope, 'parkMount', this.mount, () => (this.mountParked = true)) },
			{
				id: 'closeOrParkDome',
				policy: 'required',
				device: (devices) => devices.dome,
				...(interlock && { interlock: ['parkMount'] }),
				shouldRun: () => this.domeOpen,
				run: (context) => (interlock && !this.mountParked ? Promise.resolve({ ok: false, failure: { kind: 'operation', reason: 'unexpectedState' } }) : this.command(context.scope, 'closeOrParkDome', this.dome, () => (this.domeOpen = false))),
			},
			{ id: 'warmCamera', policy: 'required', device: (devices) => devices.camera, shouldRun: () => this.cooler, run: (context) => this.command(context.scope, 'warmCamera', this.camera, () => (this.cooler = false)) },
		]
	}

	// Commands of the fake mount (`tracking(false)`) in the log order of its commands.
	trackingOff() {
		return this.fake.of('tracking').filter((command) => command.args[0] === false)
	}
}

// One exposure in flight: `finish` ends it with a frame, `release` ends a stuck one.
interface Exposure {
	readonly label: string
	readonly finish: VoidFunction
	readonly release: VoidFunction
}

// Capture step whose approved exposures lease the camera, are logged `expose@{slot}#{attempt}` and last until the test
// finishes them; a cooperative one ends `aborted` with its root, a stuck one only on `release`.
class Exposures {
	readonly inFlight: Exposure[] = []
	stuck = false

	constructor(readonly observatory: Observatory) {}

	readonly step: SequencerCaptureStep = async (context) => {
		const refusal = context.beforeExposure()
		if (refusal !== undefined) return refusal
		context.exposureStarted()

		const { clock, frame } = context
		const { camera } = this.observatory
		const dispatched = clock.monotonicNow()
		const label = `expose@${frame!.id}#${frame!.attempt}`
		let current: Exposure | undefined

		const exposed = await context.scope.start<void>('exposure', [{ key: resourceKey(camera), device: camera }], (scope) => {
			this.observatory.log.push(label)

			return new Promise((resolve) => {
				current = { label, finish: () => resolve(successfulOperationResult(undefined)), release: () => resolve(failedOperationResult('aborted')) }
				this.inFlight.push(current)
				if (!this.stuck) scope.signal.addEventListener('abort', current.release, { once: true })
			})
		}).result

		if (current !== undefined) this.inFlight.splice(this.inFlight.indexOf(current), 1)
		if (!exposed.ok) return exposed

		writeFileSync(context.destination.temporary, FRAME)
		const at = clock.wallNow()
		const finished = clock.monotonicNow()
		return successfulOperationResult<SequencerCapturedFrame>({ exposureDispatchedAt: at, exposureDispatchedMonotonic: dispatched, exposureStartedAt: at, exposureStartedMonotonic: dispatched, exposureFinishedAt: at, exposureFinishedMonotonic: finished })
	}

	// Waits until an exposure is in flight and returns it.
	async next() {
		await waitUntil(() => this.inFlight.length > 0, 2000, 1)
		return this.inFlight[0]
	}
}

interface SessionOptions {
	readonly configuration?: SequencerConfiguration
	readonly source?: ScriptedSafetySource
	// Session with the fake mount (tracking prefix with its tracking off and the park step).
	readonly mount?: boolean
	// Guiding session of the session; `ensureGuiding` joins the pre-capture.
	readonly guiding?: ScriptedGuidingSession
	// Pre-capture tasks after the safety gate.
	readonly preCapture?: readonly SequencerTask[]
	// Shutdown with the dome interlocked with the park of the mount.
	readonly interlock?: boolean
	// Startup tasks before the gates; the observatory startup by default.
	readonly startup?: readonly SequencerTask[]
	readonly qualityAnalyzer?: SequencerQualityAnalyzer
	// Meridian supervisor stand-in, armed by the runner.
	readonly supervisor?: SequencerSupervisor
}

// One session under test.
interface Session {
	readonly runner: SequencerRunner
	readonly clock: ManualSequencerClock
	readonly observatory: Observatory
	readonly exposures: Exposures
	readonly source: ScriptedSafetySource
	readonly recorder: RunnerRecorder
	readonly coordinator: OperationCoordinator
	readonly protection: SequencerMountTrackingProtection
	readonly storage: FileSystemSequencerStorage
	readonly guiding?: ScriptedGuidingSession
}

// Starts a session over a fresh observatory: the startup tasks behind their safety gates, the pre-capture gate first,
// the fake exposures, and the shutdown composed like the session does (guiding pause, tracking off, guiding stop, the
// observatory steps), the steps of the prefix wrapped by the tracking protection shared with the runner.
function session(options: SessionOptions = {}): Session {
	const clock = new ManualSequencerClock()
	const coordinator = new OperationCoordinator(new ResourceArbiter())
	const recorder = recordRunner(coordinator)
	recorders.push(recorder)
	const configuration = options.configuration ?? configurationOf()
	const source = options.source ?? new ScriptedSafetySource()
	const observatory = new Observatory(clock)
	const exposures = new Exposures(observatory)
	const { guiding } = options
	const storage = new FileSystemSequencerStorage({ root: STORAGE_ROOT, sessionId: Bun.randomUUIDv7(), wallNow: clock.wallNow })
	const devices = { camera: observatory.camera, cover: observatory.cover, dome: observatory.dome, ...(options.mount !== false && { mount: observatory.mount }) }
	const mountCommander = options.mount !== false ? observatory.fake.commander : undefined
	const protection = new SequencerMountTrackingProtection(configuration, devices, { ...(mountCommander !== undefined && { mountCommander }), ...(guiding !== undefined && { guiding }) })
	const tracking = mountCommander === undefined ? [] : [protection.shutdownStep(stopTrackingTask({ mountCommander }, 'required'))]
	const shutdown = sequencerShutdownTasks(configuration, guiding === undefined ? {} : { guiding }, [...tracking, ...observatory.shutdown(options.interlock)]).map((step) => (step.id === 'pauseGuiding' ? protection.shutdownStep(step) : step))
	const phases = {
		startup: sequencerSafetyStartupTasks(options.startup ?? observatory.startup(), configuration.safety, source),
		preCapture: [...sequencerSafetyTasks(configuration.safety, source), ...(guiding !== undefined && configuration.guiding !== undefined ? [ensureGuidingTask(guiding, configuration.guiding)] : []), ...(options.preCapture ?? []), prepareFrameDestinationTask(storage)],
		capture: exposures.step,
		shutdown,
		trackingProtection: protection,
		...(options.supervisor !== undefined && { supervisor: options.supervisor }),
	}
	const services = { coordinator, storage, clock, listener: recorder.listener, safety: source, ...(guiding !== undefined && { guiding }), ...(options.qualityAnalyzer !== undefined && { qualityAnalyzer: options.qualityAnalyzer }) }
	const runner = startSequencerRunner({ configuration, devices, services, phases })
	return { runner, clock, observatory, exposures, source, recorder, coordinator, protection, storage, ...(guiding !== undefined && { guiding }) }
}

function events(s: Session): SequencerEvent[] {
	return s.recorder.entries.flatMap((entry) => (entry.kind === 'event' ? [entry.event] : []))
}

// Kinds of the roots the session opened, in order.
function roots(s: Session) {
	return s.recorder.entries.flatMap((entry) => (entry.kind === 'root' && entry.event === 'start' ? [entry.operation] : []))
}

// Sequence of the release of the reservation.
function releaseOf(s: Session) {
	return s.recorder.entries.find((entry) => entry.kind === 'release')?.sequence ?? Infinity
}

// Awaits the result, then checks the runner oracle, the absence of busy commands and that nothing outlived the session.
async function finish(s: Session): Promise<SequencerResult> {
	const result = await s.runner.handle.result
	assertRunnerInvariants(s.recorder.entries)
	expect(s.observatory.busy).toEqual([])
	expect(s.source.subscriptions).toBe(0)

	for (const device of [s.observatory.camera, s.observatory.cover, s.observatory.dome, s.observatory.mount]) {
		expect(s.coordinator.arbiter.ownersOf(resourceKey(device))).toEqual([])
		expect(s.coordinator.arbiter.reservationOwnerOf(resourceKey(device))).toBeUndefined()
	}

	expect(s.clock.pending).toBe(0)
	return result
}

// Advances the manual clock in steps of 250 ms, letting the session run in between, until `predicate` holds.
async function advanceUntil(s: Session, predicate: () => boolean) {
	for (let i = 0; i < 400 && !predicate(); i++) {
		await s.clock.advance(250)
		await Bun.sleep(1)
	}

	expect(predicate()).toBeTrue()
}

// Waits until the observatory logged `command`.
async function logged(s: Session, command: string) {
	await waitUntil(() => s.observatory.log.includes(command), 2000, 1)
}

async function journalOf(s: Session) {
	return await readSequencerJournal(join(STORAGE_ROOT, s.storage.sessionId, 'journal.jsonl'))
}

describe('gates', () => {
	test('blocking: unsafe always, unknown only when it counts as unsafe', () => {
		expect(isSequencerSafetyBlocking('safe', true)).toBeFalse()
		expect(isSequencerSafetyBlocking('unsafe', false)).toBeTrue()
		expect(isSequencerSafetyBlocking('unknown', true)).toBeTrue()
		expect(isSequencerSafetyBlocking('unknown', false)).toBeFalse()
	})

	test('the wait subscribes, then reads current(), resolves once safe and leaves nothing behind', async () => {
		const source = new ScriptedSafetySource('unsafe')
		const controller = new AbortController()
		let result: OperationResult<void> | undefined
		void waitForSequencerSafety(source, true, controller.signal).then((value) => (result = value))

		expect(source.subscriptions).toBe(1)
		expect(source.reads).toBe(1)
		source.publish('unknown')
		await Bun.sleep(0)
		expect(result).toBeUndefined()

		source.publish('safe')
		await Bun.sleep(0)
		expect(result).toEqual({ ok: true, value: undefined })
		expect(source.subscriptions).toBe(0)

		// Unknown does not block without unknownIsUnsafe; a safe source resolves at once from current().
		expect(await waitForSequencerSafety(new ScriptedSafetySource('unknown'), false, controller.signal)).toEqual({ ok: true, value: undefined })
	})

	test('the wait ends with its signal, aborted or already aborted, without a subscription left', async () => {
		const source = new ScriptedSafetySource('unsafe')
		const controller = new AbortController()
		const waiting = waitForSequencerSafety(source, false, controller.signal)
		controller.abort('aborted')
		expect(await waiting).toMatchObject({ ok: false, reason: 'aborted' })
		expect(await waitForSequencerSafety(source, false, controller.signal)).toMatchObject({ ok: false, reason: 'aborted' })
		expect(source.subscriptions).toBe(0)
	})

	test('a gate precedes each opening, only with a safety policy and a source; the pre-capture gate comes first', () => {
		const observatory = new Observatory(new ManualSequencerClock())
		const source = new ScriptedSafetySource()
		const ids = (tasks: readonly SequencerTask[]) => tasks.map((task) => task.id)

		expect([...SEQUENCER_SAFETY_GATED_TASKS]).toEqual(['openDome', 'openCover', 'unparkMount'])
		expect(isSequencerSafetyGated('coolCamera')).toBeFalse()
		expect(isSequencerSafetyGated(undefined)).toBeFalse()
		expect(ids(sequencerSafetyStartupTasks(observatory.startup(), safetyOf(), source))).toEqual(['coolCamera', 'safetyGate', 'openDome', 'safetyGate', 'openCover', 'safetyGate', 'unparkMount'])
		expect(ids(sequencerSafetyStartupTasks(observatory.startup(), undefined, source))).toEqual(['coolCamera', 'openDome', 'openCover', 'unparkMount'])
		expect(ids(sequencerSafetyStartupTasks(observatory.startup(), safetyOf(), undefined))).toEqual(['coolCamera', 'openDome', 'openCover', 'unparkMount'])
		expect(ids(sequencerSafetyTasks(safetyOf(), source))).toEqual(['safetyGate'])
		expect(sequencerSafetyTasks(undefined, source)).toEqual([])
	})

	test('a startup gate runs only when its opening will run', async () => {
		const observatory = new Observatory(new ManualSequencerClock())
		const [, gate, openDome] = sequencerSafetyStartupTasks(observatory.startup(), safetyOf(), new ScriptedSafetySource())
		const view = {} as Parameters<SequencerTask['shouldRun']>[0]
		expect(await gate.shouldRun(view)).toBe(await openDome.shouldRun(view))
		observatory.domeOpen = true
		expect(await gate.shouldRun(view)).toBeFalse()
		expect(await safetyGateTask(new ScriptedSafetySource(), safetyOf()).shouldRun(view)).toBeTrue()
	})

	test('preflight: a safety policy or an unsafeDuringExposure criterion needs a source', () => {
		const configuration = configurationOf()
		const judged: SequencerConfiguration = {
			...configuration,
			safety: undefined,
			capture: { ...configuration.capture, groups: [{ kind: 'scheduled', id: 'L', enabled: true, capture: LIGHT, count: 1, discard: { criteria: { quality: false, guidingInterruption: false, unsafeDuringExposure: true }, maxDiscardsPerSlot: 1, onExhausted: 'skipSlot', artifact: 'delete' } }] },
		}

		expect(preflightSequencerSafety(configuration, { safety: new ScriptedSafetySource() })).toEqual([])
		expect(preflightSequencerSafety(configuration, {})).toEqual([{ path: 'safety', message: 'requires a safety source' }])
		expect(preflightSequencerSafety(judged, {})).toEqual([{ path: 'capture.groups[0].discard.criteria.unsafeDuringExposure', message: 'requires a safety source' }])
		expect(preflightSequencerSafety({ ...configuration, safety: undefined }, {})).toEqual([])
	})

	test('28: a device sharing the mount is refused under shutdownImmediately only', () => {
		const clock = new ManualSequencerClock()
		const fake = new FakeMount(clock, 0)
		const dome = { ...fakeDevice<Dome>(DEFAULT_DOME, 'Dome'), hardwareId: fake.mount.hardwareId }
		const devices = { camera: fakeDevice<Camera>(DEFAULT_CAMERA, 'Camera'), mount: fake.mount, dome }
		const immediate = configurationOf({ safety: safetyOf({ unsafeAction: 'shutdownImmediately' }) })

		expect(preflightSequencerMeridian(immediate, devices, { mountCommander: fake.commander })).toEqual([{ path: 'devices.dome', message: `shares the hardware of the mount ${fake.mount.name}, which the hard protection cannot tell apart` }])
		expect(preflightSequencerMeridian(configurationOf(), devices, { mountCommander: fake.commander })).toEqual([])
	})

	test('49.16 4: without a meridian flip the total timeout still covers the tracking protection bound, inclusive', () => {
		const clock = new ManualSequencerClock()
		const camera = fakeDevice<Camera>(DEFAULT_CAMERA, 'Camera')
		const guiding = new ScriptedGuidingSession()
		const guided = (totalTimeout: number) => configurationOf({ guiding: GUIDING, shutdown: { ...SHUTDOWN, totalTimeout } })
		const paths = (configuration: SequencerConfiguration, devices: Parameters<typeof preflightSequencerMeridian>[1]) => preflightSequencerMeridian(configuration, devices, { guiding }).map((diagnostic) => diagnostic.path)

		// Guided without a mount: pauseTimeout 20 s + guiding stop 5 s (stepTimeout).
		expect(paths(guided(25), { camera })).toEqual([])
		expect(paths(guided(24.999), { camera })).toEqual(['shutdown.totalTimeout'])
		// With a mount: + tracking 5 s, + the settle of an unpark or a park, 5 s (stepTimeout).
		const mount = new FakeMount(clock, 0).mount
		expect(paths(guided(35), { camera, mount })).toEqual([])
		expect(paths(guided(34.999), { camera, mount })).toEqual(['shutdown.totalTimeout'])
		// Neither guiding nor a mount: any finite total.
		expect(preflightSequencerMeridian(configurationOf({ shutdown: { ...SHUTDOWN, totalTimeout: 0.001 } }), { camera }, {})).toEqual([])
	})

	test('the dome interlock commands nothing over an unparked mount', async () => {
		const clock = new ManualSequencerClock()
		const fake = new FakeMount(clock, 0)
		const dome = fakeDevice<Dome>({ ...DEFAULT_DOME, hasShutter: true, shutterState: 'OPEN' }, 'Dome')
		const commands: string[] = []
		const domeCommander = new Proxy({}, { get: (_, name) => () => commands.push(String(name)) })
		const step = closeOrParkDomeTask({ domeCommander } as never, 'required', true)
		const coordinator = new OperationCoordinator(new ResourceArbiter())

		expect(step.interlock).toEqual(['parkMount'])
		expect(step.device?.({ camera: fakeDevice<Camera>(DEFAULT_CAMERA, 'Camera'), dome })).toBe(dome)
		expect(closeOrParkDomeTask({}, 'required').interlock).toBeUndefined()

		const result = await coordinator.start('sequencer.closeOrParkDome', [], async (scope) => successfulOperationResult(await step.run({ devices: { camera: fakeDevice<Camera>(DEFAULT_CAMERA, 'Camera'), dome, mount: { ...fake.mount, parked: false } }, scope } as unknown as SequencerContext))).result
		expect(result).toMatchObject({ ok: true, value: { ok: false, failure: { kind: 'operation', reason: 'unexpectedState' } } })
		expect(commands).toEqual([])
	})
})

describe('49.15 startup', () => {
	test('16: an unsafe source with onUnsafeAtStartup stop cools but opens nothing and shuts down stopped by safety', async () => {
		const s = session({ source: new ScriptedSafetySource('unsafe') })
		const result = await finish(s)

		expect(result).toMatchObject({ state: 'stopped', stopCause: 'safety', failure: { kind: 'safety', detail: 'safety is unsafe' }, shutdownFailures: [] })
		expect(s.observatory.log).toEqual(['coolCamera', 'warmCamera'])
		expect(s.observatory.trackingOff()).toHaveLength(0)
	})

	test('16: with wait it holds before the first opening until safe, then opens in order', async () => {
		const s = session({ configuration: configurationOf({ safety: safetyOf({ onUnsafeAtStartup: 'wait' }) }), source: new ScriptedSafetySource('unsafe') })
		await waitUntil(() => s.runner.snapshot().task === 'safetyGate', 2000, 1)
		expect(s.observatory.log).toEqual(['coolCamera'])
		expect(s.runner.snapshot().state).toBe('starting')

		s.source.publish('safe')
		const exposure = await s.exposures.next()
		expect(s.observatory.log).toEqual(['coolCamera', 'openDome', 'openCover', 'unparkMount', 'expose@frame[L][1]#1'])
		exposure.finish()

		expect(await finish(s)).toMatchObject({ state: 'completed', shutdownFailures: [] })
	})

	test('17: unknown blocks the openings only when it counts as unsafe', async () => {
		const blocked = session({ configuration: configurationOf({ safety: safetyOf({ unknownIsUnsafe: true }) }), source: new ScriptedSafetySource('unknown') })
		expect(await finish(blocked)).toMatchObject({ state: 'stopped', stopCause: 'safety' })
		expect(blocked.observatory.log).toEqual(['coolCamera', 'warmCamera'])

		const open = session({ configuration: configurationOf({ safety: safetyOf({ unknownIsUnsafe: false }) }), source: new ScriptedSafetySource('unknown') })
		;(await open.exposures.next()).finish()
		expect(await finish(open)).toMatchObject({ state: 'completed' })
		expect(open.observatory.log.slice(0, 4)).toEqual(['coolCamera', 'openDome', 'openCover', 'unparkMount'])
	})

	test('18, I15: unsafe after the dome opened and before the cover: the cover never opens and the shutdown closes the dome', async () => {
		const s = session()
		s.observatory.onApplied = (name) => name === 'openDome' && s.source.publish('unsafe')

		const result = await finish(s)
		expect(result).toMatchObject({ state: 'stopped', stopCause: 'safety' })
		expect(s.observatory.log).toEqual(['coolCamera', 'openDome', 'closeOrParkDome', 'warmCamera'])
	})

	test('an opening in progress is cancelled by an unsafe change with wait, and runs again from its gate once safe', async () => {
		const s = session({ configuration: configurationOf({ safety: safetyOf({ onUnsafeAtStartup: 'wait' }) }) })
		s.observatory.hold('openCover')
		await logged(s, 'openCover')
		s.source.publish('unsafe')

		await waitUntil(() => s.runner.snapshot().task === 'safetyGate', 2000, 1)
		expect(s.observatory.coverOpen).toBeFalse()
		s.observatory.release('openCover')
		const startupGates = () => events(s).filter((event) => event.type === 'taskStarted' && event.task === 'safetyGate' && event.phase === 'startup').length
		const gates = startupGates()

		s.source.publish('safe')
		;(await s.exposures.next()).finish()
		expect(await finish(s)).toMatchObject({ state: 'completed' })
		expect(s.observatory.log.slice(0, 5)).toEqual(['coolCamera', 'openDome', 'openCover', 'openCover', 'unparkMount'])
		// The gate of the cover ran again before the cover; the dome was not opened twice.
		expect(startupGates()).toBe(gates + 1)
	})

	test('19: the source is subscribed and read before the first startup command', async () => {
		const source = new ScriptedSafetySource()
		const s = session({ source, startup: [{ id: 'coolCamera', shouldRun: () => true, run: () => (expect([source.subscriptions, source.reads]).toEqual([1, 1]), Promise.resolve(OK)) }] })
		;(await s.exposures.next()).finish()
		expect(await finish(s)).toMatchObject({ state: 'completed' })
	})
})

describe('49.15 run', () => {
	test('1: safe exposes; unsafe before the frame blocks it under pauseAfterFrame until safe, then the same attempt exposes', async () => {
		const s = session({ startup: [] })
		const s2 = session({ startup: [], source: new ScriptedSafetySource('unsafe') })

		;(await s.exposures.next()).finish()
		expect(await finish(s)).toMatchObject({ state: 'completed' })

		await waitUntil(() => s2.runner.snapshot().task === 'safetyGate' && s2.runner.snapshot().phase === 'preCapture', 2000, 1)
		await Bun.sleep(5)
		expect(s2.observatory.log).toEqual([])

		s2.source.publish('safe')
		;(await s2.exposures.next()).finish()
		expect(await finish(s2)).toMatchObject({ state: 'completed' })
		expect(s2.observatory.log[0]).toBe('expose@frame[L][1]#1')
	})

	test('1: unsafe during the exposure with pauseAfterFrame lets it finish and be accepted; the next frame waits for safe', async () => {
		const s = session({ startup: [], configuration: configurationOf({}, 2) })
		const first = await s.exposures.next()
		s.source.publish('unsafe')
		first.finish()

		await waitUntil(() => events(s).some((event) => event.type === 'frameAccepted') && s.runner.snapshot().task === 'safetyGate', 2000, 1)
		await Bun.sleep(5)
		expect(s.observatory.log).toEqual(['expose@frame[L][1]#1'])

		s.source.publish('safe')
		;(await s.exposures.next()).finish()
		const result = await finish(s)
		expect(result).toMatchObject({ state: 'completed', capture: { groups: [{ accepted: 2 }] } })
		expect(roots(s).some((root) => root.startsWith('sequencer.protect.'))).toBeFalse()
	})

	test('1: an unsafe change right before the dispatch refuses it: the attempt is deferred for safety and exposed once safe', async () => {
		const source = new ScriptedSafetySource()
		let published = false
		// After the gate passed and before the dispatch, once.
		const late: SequencerTask = {
			id: 'finalExposureGuard',
			shouldRun: () => !published,
			run: () => {
				published = true
				source.publish('unsafe')
				return Promise.resolve(OK)
			},
		}
		const s = session({ startup: [], source, preCapture: [late] })

		await waitUntil(() => published && s.runner.snapshot().task === 'safetyGate', 2000, 1)
		expect(s.observatory.log).toEqual([])

		s.source.publish('safe')
		;(await s.exposures.next()).finish()
		expect(await finish(s)).toMatchObject({ state: 'completed' })

		const journal = await journalOf(s)
		expect(journal.map((entry) => entry.kind)).toEqual(['prepared', 'deferred', 'prepared', 'promoting', 'committed'])
		expect(journal[1]).toMatchObject({ kind: 'deferred', attempt: 1, reason: 'safety' })
		expect(journal[2]).toMatchObject({ kind: 'prepared', attempt: 1 })
	})

	test('a pause requested while the gate waits holds at once; resumed, the gate waits again until safe', async () => {
		const s = session({ startup: [], source: new ScriptedSafetySource('unsafe') })
		await waitUntil(() => s.runner.snapshot().task === 'safetyGate', 2000, 1)

		expect(await s.runner.handle.pause()).toBe('paused')
		expect(s.runner.handle.resume()).toBeTrue()
		await waitUntil(() => s.runner.snapshot().state === 'running' && s.runner.snapshot().task === 'safetyGate', 2000, 1)
		expect(s.observatory.log).toEqual([])

		s.source.publish('safe')
		;(await s.exposures.next()).finish()
		expect(await finish(s)).toMatchObject({ state: 'completed' })
	})

	test('1: unsafe during the exposure with stopAfterFrame lets it finish, selects nothing more, and stops by safety', async () => {
		const s = session({ startup: [], configuration: configurationOf({ safety: safetyOf({ unsafeAction: 'stopAfterFrame' }) }, 3) })
		const first = await s.exposures.next()
		s.source.publish('unsafe', 'rain')
		first.finish()

		const result = await finish(s)
		expect(result).toMatchObject({ state: 'stopped', stopCause: 'safety', failure: { kind: 'safety', detail: 'rain' }, capture: { groups: [{ accepted: 1 }] } })
		expect(s.observatory.log.filter((command) => command.startsWith('expose'))).toEqual(['expose@frame[L][1]#1'])
	})

	test('unsafe at a safe point without a change under stopAfterFrame stops at its gate', async () => {
		const s = session({ startup: [], configuration: configurationOf({ safety: safetyOf({ unsafeAction: 'stopAfterFrame' }) }), source: new ScriptedSafetySource('unsafe') })
		expect(await finish(s)).toMatchObject({ state: 'stopped', stopCause: 'safety' })
		expect(s.observatory.log.filter((command) => command.startsWith('expose'))).toEqual([])
	})

	test('1, 2: unsafe during the exposure with shutdownImmediately cancels it; the shutdown runs with its own signal and ignores later changes', async () => {
		const s = session({ startup: [], configuration: configurationOf({ safety: safetyOf({ unsafeAction: 'shutdownImmediately' }) }) })
		s.observatory.coverOpen = true
		s.observatory.domeOpen = true
		s.observatory.mountParked = false
		await s.exposures.next()
		s.source.publish('unsafe')

		const result = await finish(s)
		expect(result).toMatchObject({ state: 'stopped', stopCause: 'safety', capture: { groups: [{ accepted: 0 }] }, shutdownFailures: [] })
		const journal = await journalOf(s)
		expect(journal.at(-1)).toMatchObject({ kind: 'abandoned', reason: 'interrupted' })
		// One of each closing: the protection did it, the full shutdown found everything safe.
		expect(s.observatory.log).toEqual(['expose@frame[L][1]#1', 'closeCover', 'parkMount', 'closeOrParkDome'])
		expect(s.observatory.trackingOff()).toHaveLength(1)
	})

	test('2: changes during the shutdown are only recorded: nothing restarts, nothing is duplicated', async () => {
		const s = session({ startup: [], configuration: configurationOf({ safety: safetyOf({ unsafeAction: 'shutdownImmediately' }) }) })
		s.observatory.coverOpen = true
		s.observatory.hold('closeCover')
		;(await s.exposures.next()).finish()
		await logged(s, 'closeCover')
		expect(s.runner.snapshot().phase).toBe('shutdown')

		for (const state of ['unsafe', 'safe', 'unsafe'] as const) s.source.publish(state)
		s.observatory.release('closeCover')

		expect(await finish(s)).toMatchObject({ state: 'completed' })
		expect(s.observatory.log).toEqual(['expose@frame[L][1]#1', 'closeCover'])
		expect(events(s).filter((event) => event.type === 'safetyChanged')).toHaveLength(3)
		expect(roots(s).some((root) => root.startsWith('sequencer.protect.'))).toBeFalse()
	})
})

describe('32.4 critical protection', () => {
	// An open observatory with a guided light whose exposure leases the camera and never quiesces before `release()`.
	async function stuck(options: SessionOptions = {}) {
		const guiding = options.guiding ?? new ScriptedGuidingSession()
		const s = session({ startup: [], guiding, configuration: configurationOf({ guiding: GUIDING, safety: safetyOf({ unsafeAction: 'shutdownImmediately' }) }), ...options })
		Object.assign(s.observatory, { coverOpen: true, domeOpen: true, mountParked: false, cooler: true })
		s.observatory.fake.set({ tracking: true })
		s.exposures.stuck = true
		const exposure = await s.exposures.next()
		return { s, exposure, guiding }
	}

	test('20, 30, 31, I42: the free steps run while the capture is stuck; the camera, the drain and the release wait for it', async () => {
		const { s, exposure, guiding } = await stuck()
		const unsafeAt = s.clock.monotonicNow()
		s.source.publish('unsafe')

		await logged(s, 'closeOrParkDome')
		await Bun.sleep(5)
		// The first protection effect and the whole prefix happened at the instant of the change (no time went by).
		expect(s.clock.monotonicNow()).toBe(unsafeAt)
		expect(guiding.commands().slice(-2)).toEqual(['pause', 'stop'])
		expect(s.observatory.trackingOff()).toHaveLength(1)
		expect(s.observatory.log).toEqual(['expose@frame[L][1]#1', 'closeCover', 'parkMount', 'closeOrParkDome'])
		expect(s.observatory.cooler).toBeTrue()
		expect(releaseOf(s)).toBe(Infinity)
		expect(s.recorder.entries.some((entry) => entry.kind === 'drain')).toBeFalse()

		exposure.release()
		const result = await finish(s)
		expect(result).toMatchObject({ state: 'stopped', stopCause: 'safety', shutdownFailures: [] })
		// The full shutdown found every protected step done and only warmed the camera, once.
		expect(s.observatory.log).toEqual(['expose@frame[L][1]#1', 'closeCover', 'parkMount', 'closeOrParkDome', 'warmCamera'])
		expect(s.observatory.trackingOff()).toHaveLength(1)
		expect(guiding.commands().filter((command) => command === 'pause')).toHaveLength(1)
		expect(roots(s).filter((root) => root.startsWith('sequencer.protect.'))).toEqual(['sequencer.protect.mountTracking', 'sequencer.protect.stopGuiding', 'sequencer.protect.closeCover', 'sequencer.protect.parkMount', 'sequencer.protect.closeOrParkDome'])

		// Order: the protection < the end of the stuck capture < the drain < the warming < the release.
		const sequence = (predicate: (entry: (typeof s.recorder.entries)[number]) => boolean) => s.recorder.entries.find(predicate)?.sequence ?? Infinity
		const capture = sequence((entry) => entry.kind === 'root' && entry.event === 'end' && entry.operation === 'sequencer.captureFrame')
		const protectedAt = sequence((entry) => entry.kind === 'root' && entry.event === 'end' && entry.operation === 'sequencer.protect.closeOrParkDome')
		const drain = sequence((entry) => entry.kind === 'drain')
		const warm = sequence((entry) => entry.kind === 'root' && entry.event === 'start' && entry.operation === 'sequencer.warmCamera')
		expect(protectedAt).toBeLessThan(capture)
		expect(capture).toBeLessThan(drain)
		expect(drain).toBeLessThan(warm)
		expect(warm).toBeLessThan(releaseOf(s))
	})

	test('22, I57: a guiding pause that never quiesces is bounded by pauseTimeout, never by stepTimeout; then stop, tracking off and the failure', async () => {
		const guiding = new ScriptedGuidingSession()
		const { s, exposure } = await stuck({ guiding })
		guiding.onPause = (scope) => untilAborted(scope.signal)
		s.source.publish('unsafe')

		await waitUntil(() => guiding.commands().at(-1) === 'pause', 2000, 1)
		// stepTimeout (5 s) passes: the pause is not cut and nothing else moved.
		await s.clock.advance(5000)
		expect(s.observatory.trackingOff()).toHaveLength(0)
		expect(s.observatory.log).toEqual(['expose@frame[L][1]#1'])

		await s.clock.advance(GUIDING.pauseTimeout * 1000 - 5000)
		await logged(s, 'closeOrParkDome')
		// The guiding stop of the failed pause; the stop step then finds it stopped.
		expect(guiding.commands().slice(-2)).toEqual(['pause', 'stop'])
		expect(s.observatory.trackingOff()).toHaveLength(1)

		// The driver never clears: the guiding pause of the full shutdown runs its own pauseTimeout and fails again.
		exposure.release()
		let settled = false
		void s.runner.handle.result.then(() => (settled = true))
		await advanceUntil(s, () => settled)
		const result = await finish(s)
		expect(result).toMatchObject({ state: 'failed', failure: { kind: 'safety' }, shutdownFailures: [{ kind: 'operation', reason: 'unexpectedState', detail: 'tracking protection failed: guidingNotQuiescent' }, { task: 'pauseGuiding' }] })
		expect(s.observatory.trackingOff()).toHaveLength(1)
	})

	test('23: safety and the hard meridian path in the same tick, both orders: one prefix root, one pause, one tracking off', async () => {
		for (const hardFirst of [true, false]) {
			const armed: { host?: SequencerSupervisorHost } = {}
			const supervisor: SequencerSupervisor = { arm: (host) => (armed.host = host), motionKeys: () => [], safePoint: () => {}, disarm: () => {} }
			const { s, exposure, guiding } = await stuck({ supervisor })
			const host = armed.host!
			let hard: Promise<SequencerProtectionOutcome> | undefined
			const runHard = () => {
				hard = host.protectCritically('sequencer.protect.meridianHard', async (context) => successfulOperationResult<SequencerProtectionOutcome>((await s.protection.protect(context, host)).failure === undefined ? { ok: true } : { ok: false, failure: { kind: 'configuration' }, action: 'stop' }))
			}

			if (hardFirst) runHard()
			s.source.publish('unsafe')
			if (!hardFirst) runHard()

			expect(await hard).toEqual({ ok: true })
			await logged(s, 'closeOrParkDome')
			exposure.release()
			expect(await finish(s)).toMatchObject({ state: 'stopped', stopCause: 'safety', shutdownFailures: [] })

			const prefixes = roots(s).filter((root) => root === 'sequencer.protect.mountTracking' || root === 'sequencer.protect.meridianHard')
			expect(prefixes).toEqual([hardFirst ? 'sequencer.protect.meridianHard' : 'sequencer.protect.mountTracking'])
			expect(guiding.commands().filter((command) => command === 'pause')).toHaveLength(1)
			expect(s.observatory.trackingOff()).toHaveLength(1)
			// The shutdown steps of the prefix were no-ops.
			expect(roots(s).filter((root) => root === 'sequencer.pauseGuiding' || root === 'sequencer.stopTracking')).toEqual([])
		}
	})

	test('26: without a mount the prefix is the guiding pause only; the tail follows it', async () => {
		const { s, exposure, guiding } = await stuck({ mount: false })
		s.source.publish('unsafe')
		await logged(s, 'closeOrParkDome')
		expect(guiding.commands().slice(-2)).toEqual(['pause', 'stop'])
		expect(s.observatory.fake.of('tracking')).toHaveLength(0)

		exposure.release()
		expect(await finish(s)).toMatchObject({ state: 'stopped', stopCause: 'safety' })
	})

	test('32: a mount leased by a stuck root defers the park and the interlocked dome; the cover still closes; both run after the drain', async () => {
		for (const interlock of [true, false]) {
			const { s, exposure } = await stuck({ interlock })
			// A root of the run holds the mount past the release bound of the prefix (2b fails, the tracking off is busy).
			s.observatory.hold('mountMotion')
			void s.runner.startTask('sequencer.acquireOrRecenterTarget', async (scope) => successfulOperationResult(await s.observatory.command(scope, 'mountMotion', s.observatory.mount, () => {})))
			await logged(s, 'mountMotion')

			s.source.publish('unsafe')
			// 2b waits for the holder up to its release bound (the settle of an unpark or a park, stepTimeout).
			await advanceUntil(s, () => s.observatory.log.includes('closeCover'))
			await Bun.sleep(5)
			expect(s.observatory.log.includes('parkMount')).toBeFalse()
			expect(s.observatory.log.includes('closeOrParkDome')).toBe(!interlock)

			s.observatory.release('mountMotion')
			exposure.release()
			const result = await finish(s)
			// A failed prefix fails the shutdown: the session ends failed, its primary failure the safety one.
			expect(result).toMatchObject({ state: 'failed', failure: { kind: 'safety' }, shutdownFailures: [{ detail: 'tracking protection failed: mountNotQuiescent' }] })
			const closing = s.observatory.log.filter((command) => command === 'parkMount' || command === 'closeOrParkDome')
			expect(closing).toEqual(interlock ? ['parkMount', 'closeOrParkDome'] : ['closeOrParkDome', 'parkMount'])
		}
	})

	test('33: pauseAfterFrame, stopAfterFrame and an immediate stop without safety only wait for a stuck job', async () => {
		for (const action of ['pauseAfterFrame', 'stopAfterFrame', 'stop'] as const) {
			const s = session({ startup: [], configuration: configurationOf({ safety: safetyOf({ unsafeAction: action === 'stop' ? 'pauseAfterFrame' : action }) }) })
			Object.assign(s.observatory, { coverOpen: true, domeOpen: true, mountParked: false, cooler: true })
			s.exposures.stuck = true
			const exposure = await s.exposures.next()

			if (action === 'stop') void s.runner.handle.stop('immediate')
			else s.source.publish('unsafe')

			await Bun.sleep(10)
			expect(s.observatory.log).toEqual(['expose@frame[L][1]#1'])
			expect(roots(s).some((root) => root.startsWith('sequencer.protect.'))).toBeFalse()

			if (action === 'pauseAfterFrame') s.source.publish('safe')
			exposure.release()
			if (action === 'pauseAfterFrame') void s.runner.handle.stop()
			await finish(s)
			expect(s.observatory.log.slice(1)).toEqual(['closeCover', 'parkMount', 'closeOrParkDome', 'warmCamera'])
		}
	})

	test('34: unsafe → safe → unsafe during the protection neither restarts nor duplicates it', async () => {
		const { s, exposure, guiding } = await stuck()
		s.observatory.hold('closeCover')
		s.source.publish('unsafe')
		await logged(s, 'closeCover')
		s.source.publish('safe')
		s.source.publish('unsafe')
		s.observatory.release('closeCover')
		await logged(s, 'closeOrParkDome')
		exposure.release()

		expect(await finish(s)).toMatchObject({ state: 'stopped', stopCause: 'safety' })
		expect(roots(s).filter((root) => root === 'sequencer.protect.mountTracking')).toHaveLength(1)
		expect(guiding.commands().filter((command) => command === 'pause')).toHaveLength(1)
		expect(s.observatory.log).toEqual(['expose@frame[L][1]#1', 'closeCover', 'parkMount', 'closeOrParkDome', 'warmCamera'])
	})

	test('35: an analyzer that ignores the signal never delays the protection, the camera warming included; the result waits for it', async () => {
		const analysis = Promise.withResolvers<{ readonly classification: 'accepted' }>()
		let analyzing = false
		const qualityAnalyzer: SequencerQualityAnalyzer = () => {
			analyzing = true
			return analysis.promise
		}
		const s = session({ startup: [], qualityAnalyzer, configuration: configurationOf({ capture: { ...configurationOf().capture, quality: { timeout: 3600, abortGrace: 3600 } }, safety: safetyOf({ unsafeAction: 'shutdownImmediately' }) }) })
		Object.assign(s.observatory, { coverOpen: true, domeOpen: true, mountParked: false, cooler: true })
		;(await s.exposures.next()).finish()
		await waitUntil(() => analyzing, 2000, 1)

		s.source.publish('unsafe')
		await logged(s, 'warmCamera')
		expect(s.observatory.log).toEqual(['expose@frame[L][1]#1', 'closeCover', 'parkMount', 'closeOrParkDome', 'warmCamera'])
		expect(releaseOf(s)).toBe(Infinity)

		analysis.resolve({ classification: 'accepted' })
		expect(await finish(s)).toMatchObject({ state: 'stopped', stopCause: 'safety', capture: { groups: [{ accepted: 1 }] } })
		expect(s.observatory.log.filter((command) => command === 'warmCamera')).toHaveLength(1)
	})
})

// Rig of the simulator scenarios of section 50.3, created once for the file: the real commanders, CameraCapturer,
// storage and the e2e clock (the simulated UTC of the mount as wall time, the process clock as monotonic time).
const rig = await createSequencerRig()
const RIG_ROOT = join(rig.capturesDir, 'sessions')
const rigClock: SequencerClock = { wallNow: () => rig.simulators.mount.utcTime, monotonicNow: () => performance.now(), delay: abortableDelay }
const lifecycle: SequencerLifecycleServices = { cameraCommander: rig.commanders.camera, thermometerManager: rig.managers.thermometer, mountCommander: rig.commanders.mount, coverCommander: rig.commanders.cover, domeCommander: rig.commanders.dome }

describe('50.3 on the simulator rig', () => {
	const RIG_LIGHT: SequencerCameraCapture = { ...LIGHT, exposureTime: 1, width: 64, height: 64, subframe: true, binX: 2, binY: 2, frameFormat: 'MONO' }
	const RIG_SHUTDOWN: SequencerShutdownConfiguration = { stepTimeout: 30, totalTimeout: 300, stopTracking: 'required', closeCover: 'required', parkMount: 'required', closeOrParkDome: 'required', warmCamera: 'required' }
	const OPEN_STARTUP: SequencerStartupConfiguration = { cooling: { setpoint: 10, tolerance: 1, stableFor: 0, timeout: 60, waitForTemperature: false }, dome: { open: true }, cover: { open: true }, mount: { unpark: true }, onFailure: 'fail' }

	beforeAll(async () => {
		await connectSequencerRig(rig)
		const { dome } = rig.devices()
		rig.managers.dome.speed(dome, 12)
		await waitUntil(() => dome.speed.value === 12, 5000, 10)
	})

	afterAll(async () => {
		await rig[Symbol.asyncDispose]()
	})

	beforeEach(async () => {
		await resetSequencerRig(rig, rig.devices().focuser.position.value)
	})

	afterEach(async () => {
		await expectNoSequencerLeaks(rig)
	})

	function rigConfiguration(patch: Partial<SequencerConfiguration> = {}): SequencerConfiguration {
		return { ...configurationOf({ capture: { ...configurationOf().capture, groups: [{ kind: 'scheduled', id: 'L', enabled: true, capture: RIG_LIGHT, count: 1 }] }, startup: OPEN_STARTUP, shutdown: RIG_SHUTDOWN }), ...patch }
	}

	// Closes the observatory through the commanders, with the park positions where the mount and the dome stand.
	async function closeObservatory() {
		const { commanders, coordinator, managers } = rig
		const { mount, dome, cover, camera } = rig.devices()
		const expectOk = (result: OperationResult<unknown>) => expect(result).toMatchObject({ ok: true })

		expectOk(await commanders.mount.setPark(coordinator, mount))
		expectOk(await commanders.mount.park(coordinator, mount))
		expectOk(await commanders.dome.setPark(coordinator, dome))
		expectOk(await commanders.dome.closeShutter(coordinator, dome))
		expectOk(await commanders.dome.park(coordinator, dome))
		expectOk(await commanders.cover.park(coordinator, cover))
		await waitUntil(() => mount.parked && dome.parked && dome.shutterState === 'CLOSED' && cover.parked, 5000, 10)
		managers.camera.cooler(camera, false)
	}

	// Runs a session over the rig: the lifecycle startup behind its safety gates, the pre-capture gate, the camera recovery
	// wait and the frame destination, `capture` (the real one by default), and the lifecycle shutdown whose tracking off is
	// wrapped by the tracking protection the runner shares.
	function runRig(configuration: SequencerConfiguration, source: ScriptedSafetySource, capture?: (storage: FileSystemSequencerStorage) => SequencerCaptureStep, onEvent?: (event: SequencerEvent) => void) {
		const sequence = createTestSequence()
		const devices = recordDevices(rig, rigClock, sequence)
		const recorder = recordRunner(rig.coordinator, sequence)
		const storage = new FileSystemSequencerStorage({ root: RIG_ROOT, sessionId: Bun.randomUUIDv7(), wallNow: rigClock.wallNow })
		const { camera, mount, cover, dome } = rig.devices()
		const sessionDevices = { camera, mount, cover, dome }
		const protection = new SequencerMountTrackingProtection(configuration, sessionDevices, { mountCommander: rig.commanders.mount })
		const phases = {
			startup: sequencerSafetyStartupTasks(sequencerStartupLifecycleTasks(configuration, lifecycle), configuration.safety, source),
			preCapture: [...sequencerSafetyTasks(configuration.safety, source), awaitCameraRecoveryTask(rig.arbiter, configuration.capture.cameraRecovery), prepareFrameDestinationTask(storage)],
			capture: capture?.(storage) ?? captureFrameStep({ cameraCapturer: rig.capturer, storage }),
			shutdown: sequencerShutdownLifecycleTasks(configuration.shutdown, lifecycle).map((step) => (step.id === 'stopTracking' ? protection.shutdownStep(step) : step)),
			trackingProtection: protection,
		}
		const events: SequencerEvent[] = []
		const listener = (event: SequencerEvent) => {
			recorder.listener(event)
			events.push(event)
			onEvent?.(event)
		}
		const runner = startSequencerRunner({ configuration, devices: sessionDevices, services: { coordinator: rig.coordinator, storage, clock: rigClock, listener, safety: source }, phases })
		const result = runner.handle.result.finally(() => {
			devices[Symbol.dispose]()
			recorder[Symbol.dispose]()
		})
		return { runner, result, events, devices, recorder }
	}

	// Commands of a device log matching `manager`, `command` and the leading `args`.
	function commandsOf(entries: readonly DeviceLogEntry[], manager: DeviceCommandEntry['manager'], command: string, ...args: unknown[]) {
		return entries.filter((entry): entry is DeviceCommandEntry => entry.kind === 'command' && entry.manager === manager && entry.command === command && args.every((arg, i) => entry.args[i] === arg))
	}

	test('23: an unsafe startup opens nothing: no dome, cover or mount unpark, the cooling allowed, stopped by safety', async () => {
		await closeObservatory()
		const run = runRig(rigConfiguration(), new ScriptedSafetySource('unsafe'))
		const result = await run.result

		expect(result).toMatchObject({ state: 'stopped', stopCause: 'safety', failure: { kind: 'safety' }, shutdownFailures: [] })
		const log = run.devices.entries
		expect(commandsOf(log, 'camera', 'cooler', true)).toHaveLength(1)
		for (const [manager, command] of [
			['dome', 'unpark'],
			['dome', 'openShutter'],
			['cover', 'unpark'],
			['mount', 'unpark'],
		] as const)
			expect(commandsOf(log, manager, command)).toEqual([])
		expect(commandsOf(log, 'camera', 'startExposure')).toEqual([])

		const { mount, dome, cover } = rig.devices()
		expect(mount.parked && dome.parked && dome.shutterState === 'CLOSED' && cover.parked).toBeTrue()
		assertSequencerInvariants(log)
		assertRunnerInvariants(run.recorder.entries)
	}, 60000)

	test('34: a transient unsafe of 200 ms inside a 1 s exposure discards it, the retake is accepted, and the pause action never holds', async () => {
		const source = new ScriptedSafetySource()
		const timers: Timer[] = []
		const discard = { criteria: { quality: false, guidingInterruption: false, unsafeDuringExposure: true }, maxDiscardsPerSlot: 1, onExhausted: 'fail', artifact: 'delete' } as const
		const configuration = rigConfiguration({ startup: { onFailure: 'fail' }, shutdown: { stepTimeout: 30, totalTimeout: 300 }, capture: { ...rigConfiguration().capture, groups: [{ kind: 'scheduled', id: 'L', enabled: true, capture: RIG_LIGHT, count: 1, discard }] } })

		const run = runRig(configuration, source, undefined, (event) => {
			if (event.type !== 'exposureStarted' || event.attempt !== 1) return
			timers.push(setTimeout(() => source.publish('unsafe'), 300))
			timers.push(setTimeout(() => source.publish('safe'), 500))
		})

		try {
			const result = await run.result
			expect(result).toMatchObject({ state: 'completed', capture: { groups: [{ accepted: 1, discarded: 1 }] } })
		} finally {
			for (const timer of timers) clearTimeout(timer)
		}

		expect(run.events.filter((event) => event.type === 'frameDiscarded')).toMatchObject([{ attempt: 1, reasons: ['unsafeDuringExposure'], truncated: false, decision: 'retake' }])
		expect(run.events.filter((event) => event.type === 'frameAccepted')).toMatchObject([{ attempt: 2 }])
		expect(run.events.some((event) => event.type === 'stateChanged' && event.state === 'paused')).toBeFalse()
		expect(commandsOf(run.devices.entries, 'camera', 'startExposure')).toHaveLength(2)
		assertSequencerInvariants(run.devices.entries)
		assertRunnerInvariants(run.recorder.entries)
	}, 60000)

	test('50: unsafe with a stuck capture parks the mount and closes the cover and the dome before the release; then the camera warms, stopped by safety, without duplicates', async () => {
		await closeObservatory()
		const source = new ScriptedSafetySource()
		const started = Promise.withResolvers<void>()
		const exposure = Promise.withResolvers<void>()
		const { camera, mount, dome, cover } = rig.devices()

		// The exposure leases the camera and never quiesces before the test releases it, whatever its root does.
		const stuck = (): SequencerCaptureStep => async (context) => {
			const refusal = context.beforeExposure()
			if (refusal !== undefined) return refusal
			context.exposureStarted()

			return await context.scope.start<SequencerCapturedFrame>('exposure', [{ key: resourceKey(camera), device: camera }], async () => {
				started.resolve()
				await exposure.promise
				return failedOperationResult('aborted')
			}).result
		}

		const run = runRig(rigConfiguration({ safety: safetyOf({ unsafeAction: 'shutdownImmediately' }) }), source, stuck)
		await started.promise
		expect(mount.parked || dome.parked || cover.parked).toBeFalse()
		source.publish('unsafe')

		await waitUntil(() => mount.parked && !mount.parking && cover.parked && dome.parked && dome.shutterState === 'CLOSED', 30000, 10)
		await Bun.sleep(50)
		expect(run.recorder.entries.some((entry) => entry.kind === 'release')).toBeFalse()
		expect(camera.cooler).toBeTrue()

		exposure.resolve()
		const result = await run.result
		expect(result).toMatchObject({ state: 'stopped', stopCause: 'safety', shutdownFailures: [] })
		await waitUntil(() => !camera.cooler, 5000, 10)

		const log = run.devices.entries
		const once = (manager: DeviceCommandEntry['manager'], command: string, ...args: unknown[]) => expect(commandsOf(log, manager, command, ...args)).toHaveLength(1)
		once('mount', 'tracking', false)
		once('mount', 'park')
		once('cover', 'park')
		once('dome', 'closeShutter')
		once('dome', 'park')
		once('camera', 'cooler', false)

		// The closings come before the warming, which comes after the end of the stuck exposure; the release comes last.
		const release = run.recorder.entries.find((entry) => entry.kind === 'release')!.sequence
		const warmed = commandsOf(log, 'camera', 'cooler', false)[0].sequence
		for (const [manager, command] of [
			['mount', 'park'],
			['cover', 'park'],
			['dome', 'park'],
		] as const)
			expect(commandsOf(log, manager, command)[0].sequence).toBeLessThan(warmed)
		expect(warmed).toBeLessThan(release)
		assertSequencerInvariants(log)
		assertRunnerInvariants(run.recorder.entries)
	}, 60000)
})
