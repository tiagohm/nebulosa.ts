import { afterAll, afterEach, beforeAll, beforeEach, expect, spyOn, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { abortableDelay } from '../../../src/devices/orchestration/operation.wait'
import { isFits } from '../../../src/io/formats/fits/fits'
import { awaitCameraRecoveryTask, captureFrameStep } from '../../../src/observation/sequencer/capture'
import { type SequencerRunner, startSequencerRunner } from '../../../src/observation/sequencer/runner'
import type { SequencerCameraCapture, SequencerClock, SequencerConfiguration, SequencerEvent, SequencerResult } from '../../../src/observation/sequencer/sequencer'
import { FileSystemSequencerCheckpointStore, FileSystemSequencerStorage, prepareFrameDestinationTask, readSequencerJournal } from '../../../src/observation/sequencer/storage'
// oxfmt-ignore
import { assertJournalInvariants, assertRunnerInvariants, assertSequencerInvariants, connectSequencerRig, createSequencerRig, createTestSequence, type DeviceRecorder, expectNoSequencerLeaks, type RunnerRecorder, recordDevices, recordRunner, resetSequencerRig } from './util'
import type { CameraCaptureStart } from '../../../src/observation/capture/types'

// End-to-end scenarios of section 50.3 on the INDI simulator rig, with the real CameraCapturer, the filesystem
// storage and checkpoint store, and the clock of the e2e tests: the simulated UTC of the mount as wall time, the
// process clock as monotonic time and real abortable waits. Every scenario ends with the device, runner and journal
// oracles and the leak check.

const LIGHT: SequencerCameraCapture = { exposureTime: 10, exposureTimeUnit: 'millisecond', frameType: 'LIGHT', x: 0, y: 0, width: 64, height: 64, subframe: true, binX: 2, binY: 2, frameFormat: 'MONO', gain: 10, offset: 5, compressed: false }

const rig = await createSequencerRig()
const ROOT = join(rig.capturesDir, 'sessions')
const clock: SequencerClock = { wallNow: () => rig.simulators.mount.utcTime, monotonicNow: () => performance.now(), delay: abortableDelay }

beforeAll(async () => {
	await connectSequencerRig(rig)
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

function configurationOf(count: number): SequencerConfiguration {
	return {
		schemaVersion: 1,
		id: 'camera-only',
		revision: 1,
		name: 'Camera only',
		capture: { order: 'sequential', groups: [{ kind: 'scheduled', id: 'L', enabled: true, capture: LIGHT, count }], retry: { maxAttempts: 3, delay: 0, backoff: 1, maximumDelay: 0, retryOn: ['timeout'] }, onFailure: 'fail', cameraRecovery: { onTimeout: 'stop' } },
		startup: { onFailure: 'fail' },
		shutdown: { stepTimeout: 30, totalTimeout: 300 },
		execution: { compensation: { timeout: 30 } },
	}
}

// One process of a camera-only session with its recorders.
interface Process {
	readonly runner: SequencerRunner
	readonly events: SequencerEvent[]
	readonly devices: DeviceRecorder
	readonly roots: RunnerRecorder
	readonly requests: CameraCaptureStart[]
	readonly result: Promise<SequencerResult>
}

// Starts the next process of the session `sessionId`: no startup or shutdown task, the pre-capture is the camera
// recovery wait and the frame destination, the capture is the real one.
function startProcess(sessionId: string, configuration: SequencerConfiguration, onEvent?: (event: SequencerEvent, runner: SequencerRunner) => void): Process {
	const sequence = createTestSequence()
	const devices = recordDevices(rig, clock, sequence)
	const roots = recordRunner(rig.coordinator, sequence)
	const requests: CameraCaptureStart[] = []
	const start = rig.capturer.start.bind(rig.capturer)
	const spy = spyOn(rig.capturer, 'start').mockImplementation((scope, camera, request, hooks) => {
		requests.push(structuredClone(request))
		return start(scope, camera, request, hooks)
	})

	const storage = new FileSystemSequencerStorage({ root: ROOT, sessionId, wallNow: clock.wallNow })
	const events: SequencerEvent[] = []
	const phases = {
		startup: [],
		preCapture: [awaitCameraRecoveryTask(rig.arbiter, configuration.capture.cameraRecovery), prepareFrameDestinationTask(storage)],
		capture: captureFrameStep({ cameraCapturer: rig.capturer, storage }),
		shutdown: [],
	}
	const listener = (event: SequencerEvent) => {
		roots.listener(event)
		events.push(event)
		onEvent?.(event, runner)
	}
	const services = { coordinator: rig.coordinator, storage, checkpointStore: new FileSystemSequencerCheckpointStore(ROOT), clock, listener }
	const runner = startSequencerRunner({ configuration, devices: { camera: rig.devices().camera }, services, phases })

	const result = runner.handle.result.finally(() => {
		spy.mockRestore()
		devices[Symbol.dispose]()
		roots[Symbol.dispose]()
	})

	return { runner, events, devices, roots, requests, result }
}

async function journalOf(sessionId: string) {
	return await readSequencerJournal(join(ROOT, sessionId, 'journal.jsonl'))
}

function slotsOf(events: readonly SequencerEvent[], type: 'frameSelected' | 'frameAccepted') {
	return events.flatMap((event) => (event.type === 'frameSelected' && type === 'frameSelected' ? [event.frame.id] : event.type === 'frameAccepted' && type === 'frameAccepted' ? [event.slot] : []))
}

// Index of the first event matching, or -1.
function indexOf(events: readonly SequencerEvent[], predicate: (event: SequencerEvent) => boolean) {
	return events.findIndex(predicate)
}

test('50.3 1: camera-only, three frames: finals, journal, checkpoint, events and release', async () => {
	const sessionId = Bun.randomUUIDv7()
	const process = startProcess(sessionId, configurationOf(3))
	const result = await process.result

	expect(result).toMatchObject({ state: 'completed', capture: { groups: [{ groupId: 'L', requested: 3, accepted: 3, discarded: 0, skipped: 0 }] }, shutdownFailures: [] })

	// Finals: one FITS file per slot, named by the slot, nothing else left.
	for (let ordinal = 1; ordinal <= 3; ordinal++) expect(isFits(readFileSync(join(ROOT, sessionId, 'L', `frame[L][${ordinal}].fit`)))).toBeTrue()

	// Journal: one prepared → promoting → committed transaction per slot, on its first attempt.
	const journal = await journalOf(sessionId)
	expect(journal.map((entry) => entry.kind)).toEqual(['prepared', 'promoting', 'committed', 'prepared', 'promoting', 'committed', 'prepared', 'promoting', 'committed'])
	expect(journal.every((entry) => entry.kind === 'lockReclaimed' || entry.attempt === 1)).toBeTrue()
	assertJournalInvariants(journal, process.events)

	// Checkpoint: the last transaction, nothing in progress.
	const checkpoint = await new FileSystemSequencerCheckpointStore(ROOT).load(sessionId)
	expect(checkpoint).toMatchObject({ capture: { L: { accepted: 3, forced: 0, discarded: 0, skipped: 0 } }, anchors: { lightExposures: 3 }, consecutiveDiscards: 0 })
	expect(checkpoint?.currentSlot).toBeUndefined()
	expect(checkpoint?.sequence).toBe(journal.flatMap((entry) => (entry.kind === 'committed' ? [entry.sequence] : [])).at(-1))

	// Events: selection, dispatch, capture and acceptance of each slot in order, then the completion.
	const { events } = process
	expect(events[0]).toMatchObject({ type: 'sessionStarted', configurationId: 'camera-only' })
	expect(events.at(-1)).toMatchObject({ type: 'sessionCompleted' })
	expect(slotsOf(events, 'frameSelected')).toEqual(['frame[L][1]', 'frame[L][2]', 'frame[L][3]'])
	expect(slotsOf(events, 'frameAccepted')).toEqual(['frame[L][1]', 'frame[L][2]', 'frame[L][3]'])

	for (let ordinal = 1; ordinal <= 3; ordinal++) {
		const slot = `frame[L][${ordinal}]`
		const selected = indexOf(events, (event) => event.type === 'frameSelected' && event.frame.id === slot)
		const started = indexOf(events, (event) => event.type === 'exposureStarted' && event.slot === slot)
		const captured = indexOf(events, (event) => event.type === 'frameCaptured' && event.slot === slot)
		const accepted = indexOf(events, (event) => event.type === 'frameAccepted' && event.slot === slot)
		expect(selected).toBeGreaterThanOrEqual(0)
		expect(selected).toBeLessThan(started)
		expect(started).toBeLessThan(captured)
		expect(captured).toBeLessThan(accepted)
		expect(events[accepted]).toMatchObject({ forced: false, path: join(ROOT, sessionId, 'L', `${slot}.fit`) })
	}

	// Every primary capture is one FITS frame, and the camera exposed exactly three times.
	expect(process.requests).toHaveLength(3)
	expect(process.requests.every((request) => request.transferFormat === 'FITS' && request.exposureMode === 'single' && request.count === 1 && request.autoSave)).toBeTrue()
	expect(process.devices.entries.filter((entry) => entry.kind === 'command' && entry.command === 'startExposure')).toHaveLength(3)

	assertSequencerInvariants(process.devices.entries)
	assertRunnerInvariants(process.roots.entries)
	expect(process.roots.entries.some((entry) => entry.kind === 'release')).toBeTrue()
})

test('50.3 14 (camera-only part): a runner discarded halfway without shutdown is resumed from disk with only the missing slots', async () => {
	const sessionId = Bun.randomUUIDv7()
	const configuration = configurationOf(4)

	// The first process dies right after its second accepted frame: disposed, so nothing more runs.
	const first = startProcess(sessionId, configuration, (event, runner) => {
		if (event.type === 'frameAccepted' && event.slot === 'frame[L][2]') queueMicrotask(() => runner.dispose())
	})

	expect(await first.result).toMatchObject({ state: 'failed', failure: { kind: 'operation', reason: 'aborted', detail: 'disposed' } })
	expect(slotsOf(first.events, 'frameAccepted')).toEqual(['frame[L][1]', 'frame[L][2]'])

	const second = startProcess(sessionId, configuration)
	const result = await second.result

	expect(result).toMatchObject({ state: 'completed', capture: { groups: [{ groupId: 'L', requested: 4, accepted: 4 }] } })
	expect(slotsOf(second.events, 'frameSelected')).toEqual(['frame[L][3]', 'frame[L][4]'])
	expect(slotsOf(second.events, 'frameAccepted')).toEqual(['frame[L][3]', 'frame[L][4]'])

	for (let ordinal = 1; ordinal <= 4; ordinal++) expect(isFits(readFileSync(join(ROOT, sessionId, 'L', `frame[L][${ordinal}].fit`)))).toBeTrue()

	// Budgets are preserved: every slot committed once, on its first attempt, without any capture failure.
	const journal = await journalOf(sessionId)
	expect(journal.flatMap((entry) => (entry.kind === 'committed' ? [`${entry.slot}#${entry.attempt}`] : []))).toEqual(['frame[L][1]#1', 'frame[L][2]#1', 'frame[L][3]#1', 'frame[L][4]#1'])
	expect(journal.some((entry) => entry.kind === 'abandoned')).toBeFalse()
	assertJournalInvariants(journal, [...first.events, ...second.events])

	const checkpoint = await new FileSystemSequencerCheckpointStore(ROOT).load(sessionId)
	expect(checkpoint).toMatchObject({ capture: { L: { accepted: 4 } }, anchors: { lightExposures: 4 }, consecutiveDiscards: 0 })
	expect(checkpoint?.currentSlot).toBeUndefined()

	assertSequencerInvariants(first.devices.entries)
	assertSequencerInvariants(second.devices.entries)
	assertRunnerInvariants(first.roots.entries, { disposed: true })
	assertRunnerInvariants(second.roots.entries)
})
