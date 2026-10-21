import { afterAll, afterEach, beforeAll, beforeEach, expect, spyOn, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { abortableDelay } from '../../../src/devices/orchestration/operation.wait'
import { readFits } from '../../../src/io/formats/fits/fits'
import { bufferSource } from '../../../src/io/io'
import { awaitCameraRecoveryTask, captureFrameStep } from '../../../src/observation/sequencer/capture'
import { bootstrapFocusBaselineTask, prepareOpticalPathTask, type SequencerFocusServices } from '../../../src/observation/sequencer/focus'
import { sequencerGuidingStartupTasks, sequencerGuidingTasks, sequencerShutdownTasks } from '../../../src/observation/sequencer/guiding'
import { awaitDarkTemperatureTask, type SequencerLifecycleServices, sequencerShutdownLifecycleTasks, sequencerStartupLifecycleTasks } from '../../../src/observation/sequencer/lifecycle'
import { type SequencerRunner, startSequencerRunner } from '../../../src/observation/sequencer/runner'
// oxfmt-ignore
import type { SequencerCameraCapture, SequencerClock, SequencerConfiguration, SequencerEvent, SequencerFrameGroup, SequencerGuidingConfiguration, SequencerResult, SequencerStartupConfiguration, SequencerTriggeredFrameGroup } from '../../../src/observation/sequencer/sequencer'
import { FileSystemSequencerCheckpointStore, FileSystemSequencerStorage, prepareFrameDestinationTask, readSequencerJournal } from '../../../src/observation/sequencer/storage'
// oxfmt-ignore
import { assertJournalInvariants, assertRunnerInvariants, assertSequencerInvariants, connectSequencerRig, createSequencerRig, createTestSequence, type DeviceCommandEntry, type DeviceLogEntry, expectNoSequencerLeaks, type RunnerLogEntry, recordDevices, recordRunner, resetSequencerRig, ScriptedGuidingSession, type SequencerOracleOptions } from './util'
import type { CameraCaptureStart } from '../../../src/observation/capture/types'
import { isTimeConsumingTestSkipped } from '../../util'

// End-to-end scenarios of the interleaved calibration frames (section 8A, 50.3 7–9 and the pending batch of 50.3 14) on
// the INDI simulator rig, with the real CameraCapturer, cover, wheel, focuser and camera cooling, the filesystem storage
// and checkpoint store, a scripted guiding session, and the e2e clock (the simulated UTC of the mount as wall time).
// Every scenario ends with the device, runner and journal oracles (I8, I16 and I20 included) and the leak check.

const LIGHT: SequencerCameraCapture = { exposureTime: 10, exposureTimeUnit: 'millisecond', frameType: 'LIGHT', x: 0, y: 0, width: 64, height: 64, subframe: true, binX: 2, binY: 2, frameFormat: 'MONO', gain: 10, offset: 5, compressed: false }
const DARK: SequencerCameraCapture = { ...LIGHT, exposureTime: 5, gain: 0, frameType: 'DARK' }
// Slots of the simulator wheel: L R G B Ha SII OIII Dark.
const SLOT = { L: 0, R: 1, Dark: 7 } as const
const GUIDING: SequencerGuidingConfiguration = { settle: { pixels: 1.5, time: 1, timeout: 10 }, pauseTimeout: 5, maxRecoveries: 0, recalibrate: false, flipCalibration: false, onFailure: 'fail' }
// Focus position of the reference filter L the rig reset leaves, in steps.
const REFERENCE = 10000

const rig = await createSequencerRig()
const ROOT = join(rig.capturesDir, 'sessions')
const clock: SequencerClock = { wallNow: () => rig.simulators.mount.utcTime, monotonicNow: () => performance.now(), delay: abortableDelay }
const lifecycle: SequencerLifecycleServices = { cameraCommander: rig.commanders.camera, thermometerManager: rig.managers.thermometer, coverCommander: rig.commanders.cover, flatPanelCommander: rig.commanders.flatPanel }

beforeAll(async () => {
	await connectSequencerRig(rig)
})

afterAll(async () => {
	await rig[Symbol.asyncDispose]()
})

beforeEach(async () => {
	await resetSequencerRig(rig, REFERENCE)
})

afterEach(async () => {
	await expectNoSequencerLeaks(rig)
})

function light(id: string, count: number, filter: keyof typeof SLOT, capture: SequencerCameraCapture = LIGHT): SequencerFrameGroup {
	return { kind: 'scheduled', id, enabled: true, filter: { kind: 'name', name: filter }, capture, count }
}

function dark(trigger: SequencerTriggeredFrameGroup['trigger'], opticalPath: SequencerTriggeredFrameGroup['opticalPath'], options: Partial<SequencerTriggeredFrameGroup> = {}): SequencerTriggeredFrameGroup {
	return { kind: 'triggered', id: 'D', enabled: true, capture: DARK, trigger, batchSize: 1, maxFrames: 4, inherit: 'triggeringFrame', opticalPath, ...options }
}

function configurationOf(groups: readonly SequencerFrameGroup[], patch: Partial<SequencerConfiguration> = {}): SequencerConfiguration {
	return {
		schemaVersion: 1,
		id: 'calibration',
		revision: 1,
		name: 'Calibration',
		capture: { order: 'roundRobin', groups, retry: { maxAttempts: 1, delay: 0, backoff: 1, maximumDelay: 0, retryOn: [] }, onFailure: 'fail', cameraRecovery: { onTimeout: 'stop' } },
		startup: { onFailure: 'fail' },
		shutdown: { stepTimeout: 30, totalTimeout: 300 },
		execution: { compensation: { timeout: 30 } },
		...patch,
	}
}

// One process of a session with its recorders.
interface Process {
	readonly sessionId: string
	readonly runner: SequencerRunner
	readonly events: SequencerEvent[]
	readonly devices: DeviceLogEntry[]
	readonly roots: RunnerLogEntry[]
	readonly requests: CameraCaptureStart[]
	// Sensor temperature when each primary exposure started, in °C, by slot.
	readonly temperatures: Map<string, number>
	readonly guiding?: ScriptedGuidingSession
	readonly result: Promise<SequencerResult>
}

interface ProcessOptions {
	readonly sessionId?: string
	readonly guiding?: boolean
	readonly onEvent?: (event: SequencerEvent, runner: SequencerRunner) => void
}

// Starts a process: the startup lifecycle (and the focus baseline with focus offsets), the pre-capture camera recovery →
// optical path (cover, filter, focus offset) → guiding → dark thermal guard → frame destination, the real capture and the
// shutdown lifecycle with the guiding stop.
function startProcess(configuration: SequencerConfiguration, options: ProcessOptions = {}): Process {
	const sessionId = options.sessionId ?? Bun.randomUUIDv7()
	const sequence = createTestSequence()
	const devices = recordDevices(rig, clock, sequence)
	const roots = recordRunner(rig.coordinator, sequence)
	const guiding = options.guiding === true ? new ScriptedGuidingSession({}, sequence) : undefined
	const guidingServices = guiding === undefined ? {} : { guiding, ditherer: guiding }
	const requests: CameraCaptureStart[] = []
	const start = rig.capturer.start.bind(rig.capturer)
	const spy = spyOn(rig.capturer, 'start').mockImplementation((scope, camera, request, hooks) => {
		requests.push(structuredClone(request))
		return start(scope, camera, request, hooks)
	})

	const storage = new FileSystemSequencerStorage({ root: ROOT, sessionId, wallNow: clock.wallNow })
	const focus: SequencerFocusServices = { wheelCommander: rig.commanders.wheel, focuserCommander: rig.commanders.focuser, coverCommander: rig.commanders.cover, flatPanelCommander: rig.commanders.flatPanel, ...(guiding !== undefined && { guiding }) }
	const thermal = awaitDarkTemperatureTask(lifecycle, configuration.startup)
	const phases = {
		startup: [...(configuration.capture.focusOffsets === undefined ? [] : [bootstrapFocusBaselineTask()]), ...sequencerGuidingStartupTasks(configuration, guidingServices), ...sequencerStartupLifecycleTasks(configuration, lifecycle)],
		preCapture: [awaitCameraRecoveryTask(rig.arbiter, configuration.capture.cameraRecovery), prepareOpticalPathTask(focus), ...sequencerGuidingTasks(configuration, guidingServices), ...(thermal === undefined ? [] : [thermal]), prepareFrameDestinationTask(storage)],
		capture: captureFrameStep({ cameraCapturer: rig.capturer, storage }),
		shutdown: sequencerShutdownTasks(configuration, guidingServices, sequencerShutdownLifecycleTasks(configuration.shutdown, lifecycle)),
	}

	const events: SequencerEvent[] = []
	const temperatures = new Map<string, number>()
	const { camera, wheel, focuser, cover, flatPanel } = rig.devices()
	const holder: { runner?: SequencerRunner } = {}
	const listener = (event: SequencerEvent) => {
		roots.listener(event)
		events.push(event)
		if (event.type === 'exposureStarted') temperatures.set(event.slot, camera.temperature)
		if (holder.runner !== undefined) options.onEvent?.(event, holder.runner)
	}
	const services = { coordinator: rig.coordinator, storage, checkpointStore: new FileSystemSequencerCheckpointStore(ROOT), clock, listener, ...guidingServices }
	const runner = startSequencerRunner({ configuration, devices: { camera, wheel, focuser, cover, flatPanel }, services, phases })
	holder.runner = runner

	const result = runner.handle.result.finally(() => {
		spy.mockRestore()
		devices[Symbol.dispose]()
		roots[Symbol.dispose]()
	})

	return { sessionId, runner, events, devices: devices.entries, roots: roots.entries, requests, temperatures, ...(guiding !== undefined && { guiding }), result }
}

function selected(events: readonly SequencerEvent[]) {
	return events.flatMap((event) => (event.type === 'frameSelected' ? [event.frame.id] : []))
}

function commandsOf(entries: readonly DeviceLogEntry[], manager: DeviceCommandEntry['manager'], command: string) {
	return entries.filter((entry): entry is DeviceCommandEntry => entry.kind === 'command' && entry.manager === manager && entry.command === command)
}

// Header of the final of each accepted frame, in acceptance order.
async function acceptedHeaders(events: readonly SequencerEvent[]) {
	const headers: { readonly slot: string; readonly type: string; readonly filter: string; readonly position: number; readonly exposure: number }[] = []

	for (const event of events) {
		if (event.type !== 'frameAccepted') continue
		const { header } = (await readFits(bufferSource(readFileSync(event.path))))!.hdus[0]
		headers.push({ slot: event.slot, type: header.IMAGETYP as string, filter: header.FILTER as string, position: header.FOCUSPOS as number, exposure: header.EXPTIME as number })
	}

	return headers
}

// Every oracle of a process.
async function assertOracles(process: Process, configuration: SequencerConfiguration, options: SequencerOracleOptions = {}, events: readonly SequencerEvent[] = process.events) {
	assertSequencerInvariants(process.devices, options)
	assertRunnerInvariants(process.roots)
	assertJournalInvariants(await readSequencerJournal(join(ROOT, process.sessionId, 'journal.jsonl')), events, configuration)
}

test('50.3 7: a cover dark after each light inherits its exposure; the cover closes only for the darks and guiding pauses for them', async () => {
	const configuration = configurationOf([light('L', 1, 'L'), light('R', 1, 'R', { ...LIGHT, exposureTime: 20 }), dark({ kind: 'afterFrames', frames: 1 }, { kind: 'cover' })], { guiding: GUIDING })
	const process = startProcess(configuration, { guiding: true })
	const result = await process.result

	expect(result).toMatchObject({
		state: 'completed',
		capture: {
			groups: [
				{ groupId: 'L', accepted: 1 },
				{ groupId: 'R', accepted: 1 },
				{ groupId: 'D', requested: 4, accepted: 2 },
			],
		},
	})
	expect(selected(process.events)).toEqual(['frame[L][1]', 'frame[D][1]', 'frame[R][1]', 'frame[D][2]'])
	expect(process.events.filter((event) => event.type === 'triggerFired')).toEqual(['frame[L][1]', 'frame[R][1]'].map((triggeredBy) => expect.objectContaining({ groupId: 'D', slots: 1, triggeredBy })))

	// Each dark inherits the exposure, binning, gain and offset of the light that fired it, with its own frame type.
	const darks = process.requests.filter((request) => request.frameType === 'DARK')
	expect(darks.map((request) => request.exposureTime)).toEqual([10, 20])
	expect(darks.every((request) => request.gain === LIGHT.gain && request.binX === LIGHT.binX && request.offset === LIGHT.offset)).toBeTrue()
	const headers = await acceptedHeaders(process.events)
	expect(headers.map((header) => header.type)).toEqual(['Light Frame', 'Dark Frame', 'Light Frame', 'Dark Frame'])
	expect(headers.map((header) => header.exposure)).toEqual([0.01, 0.01, 0.02, 0.02])

	// The cover closes before each dark and opens before each following light; the last dark leaves it closed.
	expect(commandsOf(process.devices, 'cover', 'park')).toHaveLength(2)
	expect(commandsOf(process.devices, 'cover', 'unpark')).toHaveLength(1)

	// Guiding pauses before every closing and resumes, with its settle, before every light after a dark.
	const guiding = process.guiding!
	const covers = commandsOf(process.devices, 'cover', 'park').map((entry) => entry.sequence)
	const exposures = commandsOf(process.devices, 'camera', 'startExposure').map((entry) => entry.sequence)
	const last = (before: number) => guiding.log.findLast((entry) => entry.sequence < before)?.command
	expect(covers.map(last)).toEqual(['pause', 'pause'])
	expect(exposures.map(last)).toEqual(['start', 'pause', 'resume', 'pause'])

	await assertOracles(process, configuration, { coverDarks: true })
	await rig.commanders.cover.unpark(rig.coordinator, rig.devices().cover)
})

test('50.3 8: a dark of an opaque filter after every two lights goes to Dark without offset and back to reference + offset', async () => {
	const base = configurationOf([light('L', 2, 'L'), light('R', 1, 'R'), dark({ kind: 'afterFrames', frames: 2 }, { kind: 'filter', filter: { kind: 'name', name: 'Dark' } }, { inherit: 'none' })])
	const configuration: SequencerConfiguration = { ...base, capture: { ...base.capture, order: 'sequential', focusOffsets: { reference: 'L', offsets: { R: 100 } } } }
	const process = startProcess(configuration)
	const result = await process.result

	expect(result).toMatchObject({ state: 'completed' })
	expect(selected(process.events)).toEqual(['frame[L][1]', 'frame[L][2]', 'frame[D][1]', 'frame[R][1]'])

	const headers = await acceptedHeaders(process.events)
	expect(headers).toEqual([
		{ slot: 'frame[L][1]', type: 'Light Frame', filter: 'L', position: REFERENCE, exposure: 0.01 },
		{ slot: 'frame[L][2]', type: 'Light Frame', filter: 'L', position: REFERENCE, exposure: 0.01 },
		{ slot: 'frame[D][1]', type: 'Dark Frame', filter: 'Dark', position: REFERENCE, exposure: 0.005 },
		{ slot: 'frame[R][1]', type: 'Light Frame', filter: 'R', position: REFERENCE + 100, exposure: 0.01 },
	])
	// The last light only counted one: no dark after it.
	expect(process.events.filter((event) => event.type === 'triggerFired')).toEqual([expect.objectContaining({ triggeredBy: 'frame[L][2]' })])
	expect(commandsOf(process.devices, 'cover', 'park')).toEqual([])

	await assertOracles(process, configuration, { opaqueSlots: [SLOT.Dark] })
})

test.skipIf(isTimeConsumingTestSkipped())('50.3 9: a temperature dark fires once per change of delta and never exposes before the sensor is stable again', async () => {
	const { camera } = rig.devices()
	const setpoint = Math.round(camera.temperature) - 1
	const startup: SequencerStartupConfiguration = { cooling: { setpoint, tolerance: 0.3, stableFor: 0.3, timeout: 20, waitForTemperature: true }, onFailure: 'fail' }
	const groups = [light('L', 4, 'L', { ...LIGHT, exposureTime: 250 }), dark({ kind: 'temperatureChange', delta: 1 }, { kind: 'none' }, { maxFrames: 3 })]
	const configuration = configurationOf(groups, { startup, shutdown: { stepTimeout: 30, totalTimeout: 300, warmCamera: 'required' } })

	// After the first light the sensor is driven 2 °C away; once a batch fired it is driven back to the setpoint.
	const process = startProcess(configuration, {
		onEvent: (event) => {
			if (event.type === 'frameAccepted' && event.slot === 'frame[L][1]') rig.simulators.camera.setTargetTemperature(setpoint - 2)
			else if (event.type === 'triggerFired') rig.simulators.camera.setTargetTemperature(setpoint)
		},
	})
	const result = await process.result
	expect(result).toMatchObject({ state: 'completed' })

	const fired = process.events.filter((event) => event.type === 'triggerFired' || event.type === 'triggerSuppressed')
	expect(fired.length).toBeGreaterThan(0)

	// Replaying the rule over the sensor temperatures journaled with the lights gives exactly the fired batches.
	const journal = await readSequencerJournal(join(ROOT, process.sessionId, 'journal.jsonl'))
	const lights = journal.flatMap((entry) => (entry.kind === 'promoting' && entry.slot.startsWith('frame[L]') ? [{ slot: entry.slot, temperature: entry.sensorTemperature! }] : []))
	expect(lights).toHaveLength(4)
	const expected: string[] = []
	let anchor: number | undefined
	let free = 3

	for (const { slot, temperature } of lights) {
		expect(Number.isFinite(temperature)).toBeTrue()
		if (anchor === undefined) anchor = temperature
		else if (Math.abs(temperature - anchor) >= 1) {
			expected.push(`${free > 0 ? 'triggerFired' : 'triggerSuppressed'}@${slot}`)
			if (free-- > 0) anchor = temperature
		}
	}

	expect(fired.map((event) => `${event.type}@${event.type === 'triggerFired' || event.type === 'triggerSuppressed' ? event.triggeredBy : ''}`)).toEqual(expected)

	// Every dark waited for the thermal stability and was exposed within tolerance of the setpoint.
	const darks = selected(process.events).filter((slot) => slot.startsWith('frame[D]'))
	expect(darks.length).toBeGreaterThan(0)
	expect(process.events.filter((event) => event.type === 'taskCompleted' && event.task === 'awaitDarkTemperature')).toHaveLength(darks.length)
	for (const slot of darks) expect(Math.abs(process.temperatures.get(slot)! - setpoint)).toBeLessThanOrEqual(0.3)

	await assertOracles(process, configuration)
	await rig.commanders.camera.cooler(rig.coordinator, camera, false)
})

test('50.3 14 (calibration part): a dark batch pending at a crash is resumed with the exposure inherited from its light', async () => {
	const sessionId = Bun.randomUUIDv7()
	const configuration = configurationOf([light('L', 2, 'L', { ...LIGHT, exposureTime: 25 }), dark({ kind: 'afterFrames', frames: 1 }, { kind: 'none' }, { batchSize: 2 })])

	// The first process dies right after the first light: its batch of two darks is journaled, none exposed.
	const first = startProcess(configuration, {
		sessionId,
		onEvent: (event, runner) => {
			if (event.type === 'frameAccepted' && event.slot === 'frame[L][1]') queueMicrotask(() => runner.dispose())
		},
	})
	expect(await first.result).toMatchObject({ state: 'failed', failure: { reason: 'aborted', detail: 'disposed' } })
	expect(first.events.filter((event) => event.type === 'triggerFired')).toEqual([expect.objectContaining({ groupId: 'D', slots: 2, triggeredBy: 'frame[L][1]' })])

	const checkpoint = await new FileSystemSequencerCheckpointStore(ROOT).load(sessionId)
	expect(checkpoint?.scheduler.batches).toEqual([{ groupId: 'D', firstOrdinal: 1, size: 2, capture: { ...LIGHT, exposureTime: 25, frameType: 'DARK' }, triggeredBy: 'frame[L][1]' }])
	expect(checkpoint?.anchors.calibration.D).toEqual({ lightExposures: 0, batches: 1 })

	const second = startProcess(configuration, { sessionId })
	expect(await second.result).toMatchObject({
		state: 'completed',
		capture: {
			groups: [
				{ groupId: 'L', accepted: 2 },
				{ groupId: 'D', requested: 4, accepted: 4 },
			],
		},
	})
	expect(selected(second.events)).toEqual(['frame[D][1]', 'frame[D][2]', 'frame[L][2]', 'frame[D][3]', 'frame[D][4]'])
	expect(second.requests.slice(0, 2).map((request) => [request.frameType, request.exposureTime])).toEqual([
		['DARK', 25],
		['DARK', 25],
	])

	assertSequencerInvariants(first.devices)
	assertRunnerInvariants(first.roots, { disposed: true })
	await assertOracles(second, configuration, {}, [...first.events, ...second.events])
})
