import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { DEFAULT_FOCUSER, DEFAULT_WHEEL, type Focuser, type Wheel } from '../../../src/devices/indi/device'
import { failedOperationResult, successfulOperationResult } from '../../../src/devices/orchestration/operation'
import { abortableDelay } from '../../../src/devices/orchestration/operation.wait'
import type { CameraCaptureStart } from '../../../src/devices/runners/camera.capture.types'
import { readFits } from '../../../src/io/formats/fits/fits'
import { bufferSource } from '../../../src/io/io'
import { awaitCameraRecoveryTask, captureFrameStep } from '../../../src/observation/sequencer/capture'
// oxfmt-ignore
import { autofocusTask, bootstrapFocusBaselineTask, preflightSequencerFocus, prepareOpticalPathTask, resolveSequencerFilter, type SequencerFocusServices, sequencerAutofocusOptions, sequencerPhysicalFilter } from '../../../src/observation/sequencer/focus'
import { type SequencerRunner, type SequencerTask, type SequencerTaskResult, startSequencerRunner } from '../../../src/observation/sequencer/runner'
// oxfmt-ignore
import type { SequencerAutofocusConfiguration, SequencerCameraCapture, SequencerCheckpoint, SequencerCheckpointStore, SequencerClock, SequencerConfiguration, SequencerEvent, SequencerFilterFocusOffsets, SequencerFilterReference, SequencerFocusBaseline, SequencerFocusMeasurer, SequencerFrameGroup, SequencerFrameSlot, SequencerResult } from '../../../src/observation/sequencer/sequencer'
import { createSequencerRuntimeState } from '../../../src/observation/sequencer/state'
import { FileSystemSequencerCheckpointStore, FileSystemSequencerStorage, prepareFrameDestinationTask, readSequencerJournal } from '../../../src/observation/sequencer/storage'
// oxfmt-ignore
import { assertJournalInvariants, assertRunnerInvariants, assertSequencerInvariants, connectSequencerRig, createSequencerRig, createTestSequence, type DeviceCommandEntry, type DeviceLogEntry, expectNoSequencerLeaks, recordDevices, recordRunner, resetSequencerRig, type RunnerLogEntry, type TestSequence } from './util'

// Filter, focus offsets and autofocus of the Sequencer on the INDI simulator rig, with the real commanders, the real
// CameraCapturer, the filesystem storage and checkpoint store, and the e2e clock (the simulated UTC of the mount as wall
// time). The optics are modeled by the HFD measurer: it reads the focuser position the camera simulator stamps into each
// auxiliary FITS (FOCUSPOS) and the filter the wheel stands on, and returns a hyperbolic defocus curve whose minimum lies
// at `optics.reference + OFFSETS[filter]`, so a focused filter really is at `referencePosition + offset`.

const LIGHT: SequencerCameraCapture = { exposureTime: 10, exposureTimeUnit: 'millisecond', frameType: 'LIGHT', x: 0, y: 0, width: 64, height: 64, subframe: true, binX: 2, binY: 2, frameFormat: 'MONO', gain: 10, offset: 5, compressed: false }
const DARK: SequencerCameraCapture = { ...LIGHT, frameType: 'DARK' }
// Slots of the simulator wheel: L R G B Ha SII OIII Dark.
const SLOT = { L: 0, R: 1, G: 2, B: 3, Ha: 4, SII: 5, OIII: 6, Dark: 7 } as const
const OFFSETS: SequencerFilterFocusOffsets = { reference: 'L', offsets: { R: 100, G: -50, B: 30 } }
const ALGORITHM = { initialOffsetSteps: 4, stepSize: 50, fittingMode: 'HYPERBOLIC', reversed: false } as const
const NO_TRIGGERS = { onStart: false, afterResume: false, afterFlip: false, onFilterChange: false } as const
const AUTOFOCUS: SequencerAutofocusConfiguration = { algorithm: ALGORITHM, capture: LIGHT, triggers: NO_TRIGGERS, measureTimeout: 30, onFailure: 'fail' }
const OK: SequencerTaskResult = { ok: true }

const rig = await createSequencerRig()
const ROOT = join(rig.capturesDir, 'sessions')
const clock: SequencerClock = { wallNow: () => rig.simulators.mount.utcTime, monotonicNow: () => performance.now(), delay: abortableDelay }
// In-focus position of the reference filter of the modeled optics, in steps.
const optics = { reference: 10010 }

beforeAll(async () => {
	await connectSequencerRig(rig)
})

afterAll(async () => {
	await rig[Symbol.asyncDispose]()
})

beforeEach(async () => {
	await resetSequencerRig(rig, 10000)
	optics.reference = 10010
})

afterEach(async () => {
	await expectNoSequencerLeaks(rig)
})

// Places the wheel on `slot` and the focuser at `position` through the commanders.
async function place(slot: number, position: number) {
	const { wheel, focuser } = rig.devices()
	expect(await rig.commanders.wheel.moveTo(rig.coordinator, wheel, slot)).toMatchObject({ ok: true })
	expect(await rig.commanders.focuser.moveTo(rig.coordinator, focuser, position)).toMatchObject({ ok: true })
}

function scheduledGroup(id: string, filter: keyof typeof SLOT | undefined, count: number, capture: SequencerCameraCapture = LIGHT): SequencerFrameGroup {
	return { kind: 'scheduled', id, enabled: true, capture, count, ...(filter !== undefined && { filter: { kind: 'name', name: filter } }) }
}

function configurationOf(groups: readonly SequencerFrameGroup[], options: { readonly autofocus?: SequencerAutofocusConfiguration; readonly offsets?: SequencerFilterFocusOffsets | null; readonly order?: SequencerConfiguration['capture']['order'] } = {}): SequencerConfiguration {
	const offsets = options.offsets === null ? undefined : (options.offsets ?? OFFSETS)
	return {
		schemaVersion: 1,
		id: 'focus',
		revision: 1,
		name: 'Focus',
		capture: { order: options.order ?? 'sequential', groups, retry: { maxAttempts: 1, delay: 0, backoff: 1, maximumDelay: 0, retryOn: [] }, onFailure: 'fail', cameraRecovery: { onTimeout: 'stop' }, ...(offsets !== undefined && { focusOffsets: offsets }) },
		...(options.autofocus !== undefined && { autofocus: options.autofocus }),
		startup: { onFailure: 'fail' },
		shutdown: { stepTimeout: 30, totalTimeout: 300 },
		execution: { compensation: { timeout: 30 } },
	}
}

// One measurement as the modeled optics saw it.
interface MeasureCall {
	readonly path: string
	// FOCUSPOS of the frame header.
	readonly position: number
	readonly filter?: string
	readonly sequence: number
}

// Measurer of the modeled optics.
function opticsMeasurer(calls: MeasureCall[], sequence: TestSequence, hfd?: (position: number, filter: string | undefined) => number | undefined): SequencerFocusMeasurer {
	return async (frame) => {
		const { header } = (await readFits(bufferSource(readFileSync(frame.path))))!.hdus[0]
		const position = header.FOCUSPOS as number
		const filter = sequencerPhysicalFilter(rig.devices().wheel)
		calls.push({ path: frame.path, position, filter, sequence: sequence.next() })
		if (hfd !== undefined) return hfd(position, filter)
		const best = optics.reference + (filter === undefined || filter === OFFSETS.reference ? 0 : (OFFSETS.offsets[filter] ?? 0))
		return Math.hypot(1.8, 0.02 * (position - best))
	}
}

// Checkpoint store recording each saved checkpoint in the shared sequence of the recorders.
class RecordingCheckpointStore implements SequencerCheckpointStore {
	readonly saves: { readonly sequence: number; readonly checkpoint: SequencerCheckpoint }[] = []
	readonly #store = new FileSystemSequencerCheckpointStore(ROOT)

	constructor(
		readonly sequence: TestSequence,
		readonly afterSave?: (checkpoint: SequencerCheckpoint) => void,
	) {}

	readonly load = (sessionId: string) => this.#store.load(sessionId)

	readonly save = async (checkpoint: SequencerCheckpoint) => {
		await this.#store.save(checkpoint)
		this.saves.push({ sequence: this.sequence.next(), checkpoint: structuredClone(checkpoint) })
		this.afterSave?.(checkpoint)
	}
}

interface SessionOptions {
	readonly sessionId?: string
	readonly hfd?: (position: number, filter: string | undefined) => number | undefined
	readonly measurer?: (calls: MeasureCall[], sequence: TestSequence) => SequencerFocusMeasurer
	readonly onStart?: (runner: SequencerRunner) => void
	readonly onEvent?: (event: SequencerEvent, runner: SequencerRunner) => void
	readonly afterSave?: (checkpoint: SequencerCheckpoint, runner: SequencerRunner) => void
}

interface Session {
	readonly sessionId: string
	readonly result: SequencerResult
	readonly events: SequencerEvent[]
	readonly devices: DeviceLogEntry[]
	readonly roots: RunnerLogEntry[]
	readonly measures: MeasureCall[]
	readonly saves: RecordingCheckpointStore['saves']
	readonly requests: (CameraCaptureStart & { readonly sequence: number })[]
}

// Runs one process of a session: the baseline bootstrap of the startup, then camera recovery, optical path, autofocus
// (when configured) and frame destination in the pre-capture, the real capture, and no shutdown step.
async function runSession(configuration: SequencerConfiguration, options: SessionOptions = {}): Promise<Session> {
	const sequence = createTestSequence()
	const devices = recordDevices(rig, clock, sequence)
	const roots = recordRunner(rig.coordinator, sequence)
	const sessionId = options.sessionId ?? Bun.randomUUIDv7()
	const storage = new FileSystemSequencerStorage({ root: ROOT, sessionId, wallNow: clock.wallNow })
	const events: SequencerEvent[] = []
	const measures: MeasureCall[] = []
	const requests: Session['requests'][number][] = []
	const holder: { runner?: SequencerRunner } = {}
	const store = new RecordingCheckpointStore(sequence, (checkpoint) => options.afterSave?.(checkpoint, holder.runner!))
	const start = rig.capturer.start.bind(rig.capturer)
	const spy = spyOn(rig.capturer, 'start').mockImplementation((scope, camera, request, hooks) => {
		requests.push({ ...structuredClone(request), sequence: sequence.next() })
		return start(scope, camera, request, hooks)
	})
	const focus: SequencerFocusServices = { wheelCommander: rig.commanders.wheel, focuserCommander: rig.commanders.focuser, cameraCapturer: rig.capturer, focusMeasurer: (options.measurer ?? ((calls, next) => opticsMeasurer(calls, next, options.hfd)))(measures, sequence), storage }
	const phases = {
		startup: [bootstrapFocusBaselineTask()],
		preCapture: [awaitCameraRecoveryTask(rig.arbiter, configuration.capture.cameraRecovery), prepareOpticalPathTask(focus), ...(configuration.autofocus === undefined ? [] : [autofocusTask(focus, configuration.autofocus)]), prepareFrameDestinationTask(storage)],
		capture: captureFrameStep({ cameraCapturer: rig.capturer, storage }),
		shutdown: [],
	}
	const { camera, wheel, focuser } = rig.devices()
	const listener = (event: SequencerEvent) => {
		roots.listener(event)
		events.push(event)
		if (holder.runner !== undefined) options.onEvent?.(event, holder.runner)
	}
	const runner = startSequencerRunner({ configuration, devices: { camera, wheel, focuser }, services: { coordinator: rig.coordinator, storage, checkpointStore: store, clock, listener, focuserCommander: rig.commanders.focuser, wheelCommander: rig.commanders.wheel }, phases })
	holder.runner = runner
	options.onStart?.(runner)

	try {
		const result = await runner.handle.result
		return { sessionId, result, events, devices: devices.entries, roots: roots.entries, measures, saves: store.saves, requests }
	} finally {
		spy.mockRestore()
		devices[Symbol.dispose]()
		roots[Symbol.dispose]()
	}
}

function commandsOf(entries: readonly DeviceLogEntry[], manager?: DeviceCommandEntry['manager'], command?: string) {
	return entries.filter((entry): entry is DeviceCommandEntry => entry.kind === 'command' && (manager === undefined || entry.manager === manager) && (command === undefined || entry.command === command))
}

// Sequences of the events matching, from the shared runner log.
function eventSequences(roots: readonly RunnerLogEntry[], predicate: (event: SequencerEvent) => boolean) {
	return roots.filter((entry) => entry.kind === 'event' && predicate(entry.event)).map((entry) => entry.sequence)
}

// Filter and focuser position stamped into each accepted frame, in acceptance order.
async function acceptedFrames(session: Session) {
	const frames: { readonly slot: string; readonly filter: string; readonly position: number; readonly type: string }[] = []

	for (const event of session.events) {
		if (event.type !== 'frameAccepted') continue
		const { header } = (await readFits(bufferSource(readFileSync(event.path))))!.hdus[0]
		frames.push({ slot: event.slot, filter: header.FILTER as string, position: header.FOCUSPOS as number, type: header.IMAGETYP as string })
	}

	return frames
}

// I23: every light starts at `referencePosition + offset[filter]` of the known baseline.
async function expectLightsInFocus(session: Session, referencePosition: number) {
	const lights = (await acceptedFrames(session)).filter((frame) => frame.type === 'Light Frame')
	expect(lights.length).toBeGreaterThan(0)
	for (const light of lights) expect(light).toMatchObject({ position: referencePosition + (light.filter === OFFSETS.reference ? 0 : OFFSETS.offsets[light.filter]) })
	return lights
}

// The wheel and the focuser are never commanded while the other one moves.
function expectNoParallelMotion(entries: readonly DeviceLogEntry[]) {
	const moving = { wheel: false, focuser: false }

	for (const entry of [...entries].sort((a, b) => a.sequence - b.sequence)) {
		if (entry.kind === 'transition' && entry.property === 'moving' && (entry.manager === 'wheel' || entry.manager === 'focuser')) moving[entry.manager] = entry.value === true
		else if (entry.kind === 'command' && entry.command === 'moveTo') {
			if (entry.manager === 'wheel') expect(moving.focuser).toBeFalse()
			if (entry.manager === 'focuser') expect(moving.wheel).toBeFalse()
		}
	}
}

// Every oracle of the session.
async function assertOracles(session: Session) {
	assertSequencerInvariants(session.devices)
	assertRunnerInvariants(session.roots)
	assertJournalInvariants(await readSequencerJournal(join(ROOT, session.sessionId, 'journal.jsonl')), session.events)
	expectNoParallelMotion(session.devices)
}

// The baseline of each save, in order.
function baselines(session: Session) {
	return session.saves.map((save) => save.checkpoint.focus)
}

describe('filter resolution and preflight', () => {
	const wheel: Wheel = { ...DEFAULT_WHEEL, name: 'Wheel', connected: true, count: 4, names: ['L', 'R', 'G', 'Dark'], position: 0 }
	const focuser: Focuser = { ...DEFAULT_FOCUSER, name: 'Focuser', connected: true, canAbsoluteMove: true }

	test('a slot inside the carousel or the first exact name resolves; anything else does not', () => {
		expect(resolveSequencerFilter(wheel, { kind: 'slot', slot: 3 })).toBe(3)
		expect(resolveSequencerFilter(wheel, { kind: 'slot', slot: 4 })).toBeUndefined()
		expect(resolveSequencerFilter(wheel, { kind: 'name', name: 'G' })).toBe(2)
		expect(resolveSequencerFilter(wheel, { kind: 'name', name: 'g' })).toBeUndefined()
		expect(resolveSequencerFilter({ ...wheel, names: ['L', 'R', 'G', 'Dark', 'Ha'] }, { kind: 'name', name: 'Ha' })).toBeUndefined()
	})

	test('a consistent configuration has no diagnostic', () => {
		const configuration = configurationOf([scheduledGroup('L', 'L', 1), scheduledGroup('R', 'R', 1)], { autofocus: { ...AUTOFOCUS, filter: { kind: 'name', name: 'G' } } })
		expect(preflightSequencerFocus(configuration, { wheel, focuser })).toEqual([])
	})

	test('49.8 11: light filter and autofocus filter without offset, a focuser without absolute moves, an opaque autofocus filter, unresolvable filters', () => {
		const dark = { kind: 'triggered', id: 'D', enabled: true, capture: DARK, trigger: { kind: 'sessionStart' }, batchSize: 1, maxFrames: 1, inherit: 'none', opticalPath: { kind: 'filter', filter: { kind: 'slot', slot: 3 } } } as const
		const unknown: SequencerFilterReference = { kind: 'name', name: 'Ha' }
		const configuration = configurationOf([{ ...scheduledGroup('L', undefined, 1), filter: { kind: 'slot', slot: 3 } }, { ...scheduledGroup('X', undefined, 1), filter: unknown }, dark], { autofocus: { ...AUTOFOCUS, filter: { kind: 'slot', slot: 3 } } })
		const diagnostics = preflightSequencerFocus(configuration, { wheel, focuser: { ...focuser, canAbsoluteMove: false } })

		expect(diagnostics).toEqual([
			{ path: 'capture.groups[0].filter', message: 'filter Dark has no known focus offset' },
			{ path: 'capture.groups[1].filter', message: 'filter Ha is not a filter of Wheel' },
			{ path: 'autofocus.filter', message: 'is the opaque filter of a calibration optical path' },
			{ path: 'autofocus.filter', message: 'filter Dark has no known focus offset' },
			{ path: 'capture.focusOffsets', message: 'requires a focuser that moves to absolute positions' },
		])
	})

	test('missing devices and an unknown reference filter', () => {
		const configuration = configurationOf([scheduledGroup('R', 'R', 1)], { autofocus: AUTOFOCUS, offsets: { reference: 'Lum', offsets: { R: 100 } } })
		expect(preflightSequencerFocus(configuration, { wheel })).toEqual([
			{ path: 'autofocus', message: 'requires a focuser' },
			{ path: 'capture.focusOffsets', message: 'requires a focuser that moves to absolute positions' },
			{ path: 'capture.focusOffsets.reference', message: 'is not a filter of Wheel' },
		])
		expect(preflightSequencerFocus(configurationOf([scheduledGroup('L', 'L', 1)]), {})).toEqual([
			{ path: 'capture.groups[0].filter', message: 'requires a filter wheel' },
			{ path: 'capture.focusOffsets', message: 'requires a focuser that moves to absolute positions' },
			{ path: 'capture.focusOffsets', message: 'requires a filter wheel' },
			// Without a wheel the bootstrap would find no calibrated filter either.
			{ path: 'capture.focusOffsets', message: expect.stringContaining('focus baseline unknown: the wheel stands on a filter without') },
		])
	})

	test('49.8 9: an unset baseline on an uncalibrated filter without autofocus is refused early, never once a baseline exists', () => {
		const configuration = configurationOf([scheduledGroup('L', 'L', 1)])
		const onDark = { ...wheel, position: 3 }
		expect(preflightSequencerFocus(configuration, { wheel: onDark, focuser })).toEqual([{ path: 'capture.focusOffsets', message: expect.stringContaining('focus baseline unknown: the wheel stands on filter Dark') }])
		expect(preflightSequencerFocus(configuration, { wheel: onDark, focuser }, { kind: 'known', referencePosition: 10000 })).toEqual([])
		expect(preflightSequencerFocus({ ...configuration, autofocus: AUTOFOCUS }, { wheel: onDark, focuser })).toEqual([])
		expect(preflightSequencerFocus(configurationOf([scheduledGroup('D', 'L', 1, DARK)]), { wheel: onDark, focuser })).toEqual([])
	})

	test('autofocus options take the configured bounds with the default grace and disposition', () => {
		expect(sequencerAutofocusOptions(AUTOFOCUS)).toEqual({ algorithm: ALGORITHM, capture: LIGHT, measureTimeout: 30, abortGrace: 5, auxiliary: 'delete' })
		expect(sequencerAutofocusOptions({ ...AUTOFOCUS, abortGrace: 1, auxiliary: 'keep' })).toMatchObject({ abortGrace: 1, auxiliary: 'keep' })
	})
})

// Runs the optical path of one frame directly in a root of the coordinator, with the given baseline, recording the
// commands; `due` is false when the task does not need to run.
async function runOpticalPath(configuration: SequencerConfiguration, capture: SequencerCameraCapture, filter: SequencerFilterReference | undefined, focus: SequencerFocusBaseline) {
	const recorder = recordDevices(rig, clock)
	const task = prepareOpticalPathTask({ wheelCommander: rig.commanders.wheel, focuserCommander: rig.commanders.focuser })
	const state = createSequencerRuntimeState(configuration, clock.wallNow())
	state.focus = focus
	const frame: SequencerFrameSlot = { id: 'frame[G][1]', groupId: 'G', kind: 'scheduled', ordinal: 1, attempt: 1, discardedTotal: 0, discardBudgetUsed: 0, captureFailures: 0, capture, ...(filter !== undefined && { filter }) }
	const { camera, wheel, focuser } = rig.devices()
	const view = { sessionId: 'optical path', configuration, devices: { camera, wheel, focuser }, clock, state, frame }

	try {
		const due = await task.shouldRun(view)
		if (!due) return { due, result: OK, commands: commandsOf(recorder.entries) }
		const handle = rig.coordinator.start('test.prepareOpticalPath', [], async (scope) => successfulOperationResult(await task.run({ ...view, scope, signal: scope.signal, emit: () => {}, saveCheckpoint: () => Promise.resolve(OK) })))
		const result = await handle.result
		return { due, result: result.ok ? result.value : result, commands: commandsOf(recorder.entries) }
	} finally {
		recorder[Symbol.dispose]()
	}
}

describe('49.8 optical path', () => {
	const configuration = configurationOf([scheduledGroup('L', 'L', 1)])
	const known = (referencePosition: number): SequencerFocusBaseline => ({ kind: 'known', referencePosition })
	const name = (name: string): SequencerFilterReference => ({ kind: 'name', name })

	test('1: the installed filter is a no-op; a name resolves its slot; an unknown filter or slot fails before moving', async () => {
		expect(await runOpticalPath(configuration, LIGHT, name('L'), known(10000))).toEqual({ due: false, result: OK, commands: [] })

		for (const filter of [name('Lum'), { kind: 'slot', slot: 8 } as const]) {
			const { result, commands } = await runOpticalPath(configuration, LIGHT, filter, known(10000))
			expect(result).toMatchObject({ ok: false, failure: { kind: 'configuration', detail: expect.stringContaining('is not a filter of') } })
			expect(commands).toEqual([])
		}

		const { result, commands } = await runOpticalPath(configuration, LIGHT, name('B'), known(10000))
		expect(result).toEqual(OK)
		expect(commands.map((command) => [command.manager, command.args[0]])).toEqual([
			['wheel', SLOT.B],
			['focuser', 10030],
		])
	})

	test('2: A→B goes to reference + offset[B]; B→A comes back exactly; L/R/G/B/L ends where it started', async () => {
		const positions: number[] = []

		for (const filter of ['R', 'L', 'R', 'G', 'B', 'L']) {
			const { result } = await runOpticalPath(configuration, LIGHT, name(filter), known(10000))
			expect(result).toEqual(OK)
			const { wheel, focuser } = rig.devices()
			expect(wheel.position).toBe(SLOT[filter as keyof typeof SLOT])
			positions.push(focuser.position.value)
		}

		expect(positions).toEqual([10100, 10000, 10100, 9950, 10030, 10000])
	})

	test('3: darks never apply an offset; a light on a filter without offset fails before moving; back to a filter with offset goes to reference + offset', async () => {
		await place(SLOT.R, 10100)
		const dark = await runOpticalPath(configuration, DARK, name('Dark'), known(10000))
		expect(dark.commands.map((command) => command.manager)).toEqual(['wheel'])
		expect(rig.devices().focuser.position.value).toBe(10100)

		const uncalibrated = await runOpticalPath(configuration, LIGHT, name('SII'), known(10000))
		expect(uncalibrated.result).toMatchObject({ ok: false, failure: { kind: 'configuration', detail: 'the light filter SII has no known focus offset' } })
		expect(uncalibrated.commands).toEqual([])

		const back = await runOpticalPath(configuration, LIGHT, name('G'), known(10000))
		expect(back.commands.map((command) => [command.manager, command.args[0]])).toEqual([
			['wheel', SLOT.G],
			['focuser', 9950],
		])
	})

	test('4: a focuser already at the target is not commanded; a target outside the range fails with zero commands', async () => {
		await place(SLOT.L, 10100)
		const wheelOnly = await runOpticalPath(configuration, LIGHT, name('R'), known(10000))
		expect(wheelOnly.commands.map((command) => command.manager)).toEqual(['wheel'])

		const outside = await runOpticalPath(configuration, LIGHT, name('L'), known(100500))
		expect(outside.result).toMatchObject({ ok: false, failure: { kind: 'operation', reason: 'unexpectedState', detail: 'focus position 100500 is outside the range [0, 100000] of Focuser Simulator' } })
		expect(outside.commands).toEqual([])
	})

	test('an unknown baseline moves only the wheel; an unset one is refused', async () => {
		const unknown = await runOpticalPath(configuration, LIGHT, name('R'), { kind: 'unknown' })
		expect(unknown.commands.map((command) => command.manager)).toEqual(['wheel'])

		const unset = await runOpticalPath(configuration, LIGHT, name('L'), { kind: 'unset' })
		expect(unset.result).toMatchObject({ ok: false, failure: { kind: 'operation', reason: 'unexpectedState', detail: 'the focus baseline was never bootstrapped' } })
		expect(unset.commands).toEqual([])
	})
})

describe('49.8 focus baseline', () => {
	test('5 (I29): a calibrated filter derives known before the first wheel move; the first L is at the reference', async () => {
		await place(SLOT.R, 10100)
		const session = await runSession(configurationOf([scheduledGroup('L', 'L', 1)]))

		expect(session.result).toMatchObject({ state: 'completed' })
		expect(session.saves[0]).toMatchObject({ checkpoint: { focus: { kind: 'known', referencePosition: 10000 } } })
		const [move] = commandsOf(session.devices, 'wheel', 'moveTo')
		expect(session.saves[0].sequence).toBeLessThan(move.sequence)
		expect(baselines(session).every((focus) => focus.kind === 'known' && focus.referencePosition === 10000)).toBeTrue()
		await expectLightsInFocus(session, 10000)
		await assertOracles(session)
	}, 60000)

	test('6, 32 (I23, I29): an uncalibrated filter derives unknown, saved before moving; the wheel goes to L without the focuser; an autofocus establishes the baseline before the first light', async () => {
		await place(SLOT.Dark, 10100)
		const session = await runSession(configurationOf([scheduledGroup('L', 'L', 2)], { autofocus: AUTOFOCUS }))
		const { result, devices, roots, saves, measures } = session

		expect(result).toMatchObject({ state: 'completed' })
		expect(saves[0]).toMatchObject({ checkpoint: { focus: { kind: 'unknown' } } })
		expect(saves[0].sequence).toBeLessThan(commandsOf(devices, 'wheel', 'moveTo')[0].sequence)

		// Nothing commands the focuser before the autofocus, which never starts from the 0 an unknown offset would be.
		const [autofocus] = eventSequences(roots, (event) => event.type === 'taskStarted' && event.task === 'autofocus')
		expect(commandsOf(devices, 'focuser').every((command) => command.sequence > autofocus)).toBeTrue()
		expect(measures.every((measure) => measure.filter === 'L')).toBeTrue()

		const known = saves.find((save) => save.checkpoint.focus.kind === 'known')!
		const { referencePosition } = known.checkpoint.focus as { readonly referencePosition: number }
		expect(Math.abs(referencePosition - 10010)).toBeLessThan(ALGORITHM.stepSize)
		// The baseline and the autofocus anchors are one save, before the first light.
		expect(known.checkpoint.anchors.autofocus.lastSuccessfulAt).toBeGreaterThan(0)
		expect(saves.find((save) => save.checkpoint.anchors.autofocus.lastSuccessfulAt !== undefined)).toBe(known)
		expect(known.sequence).toBeLessThan(eventSequences(roots, (event) => event.type === 'exposureStarted')[0])
		expect(eventSequences(roots, (event) => event.type === 'taskStarted' && event.task === 'autofocus')).toHaveLength(1)

		await expectLightsInFocus(session, referencePosition)
		await assertOracles(session)
	}, 90000)

	test('9: with an unknown baseline darks run without autofocus; the autofocus runs before the first light only', async () => {
		await place(SLOT.Dark, 10100)
		const session = await runSession(configurationOf([scheduledGroup('D', 'Dark', 2, DARK), scheduledGroup('L', 'L', 1)], { autofocus: AUTOFOCUS }))
		const { result, roots, requests } = session

		expect(result).toMatchObject({ state: 'completed' })
		const [autofocus] = eventSequences(roots, (event) => event.type === 'taskStarted' && event.task === 'autofocus')
		const darks = requests.filter((request) => request.frameType === 'DARK' && request.publishPath !== undefined)
		expect(darks).toHaveLength(2)
		expect(darks.every((request) => request.sequence < autofocus)).toBeTrue()
		expect(eventSequences(roots, (event) => event.type === 'taskStarted' && event.task === 'autofocus')).toHaveLength(1)
		await assertOracles(session)
	}, 90000)

	test('9: a failed autofocus keeps the baseline unknown and never exposes a light, even with skip', async () => {
		await place(SLOT.Dark, 10100)
		const session = await runSession(configurationOf([scheduledGroup('L', 'L', 1)], { autofocus: { ...AUTOFOCUS, onFailure: 'skip' } }), { hfd: () => undefined })

		expect(session.result).toMatchObject({ state: 'failed', failure: { kind: 'operation', reason: 'commandFailed', task: 'autofocus' } })
		expect(session.events.some((event) => event.type === 'exposureStarted')).toBeFalse()
		expect(baselines(session).every((focus) => focus.kind === 'unknown')).toBeTrue()
		// The run restored the focuser where it started.
		expect(rig.devices().focuser.position.value).toBe(10100)
		await assertOracles(session)
	}, 90000)

	test('9: an unknown baseline without autofocus and with lights fails as configuration at the bootstrap, with zero movements and nothing saved', async () => {
		await place(SLOT.Dark, 10100)
		const session = await runSession(configurationOf([scheduledGroup('L', 'L', 1)]))

		expect(session.result).toMatchObject({ state: 'failed', failure: { kind: 'configuration', detail: expect.stringContaining('focus baseline unknown: the wheel stands on filter Dark') } })
		expect(commandsOf(session.devices, 'wheel')).toEqual([])
		expect(commandsOf(session.devices, 'focuser')).toEqual([])
		expect(session.saves).toEqual([])
		await assertOracles(session)
	}, 60000)

	test('7: the persisted baseline is authoritative: a resumed session never derives it again from a moved wheel', async () => {
		await place(SLOT.R, 10100)
		const configuration = configurationOf([scheduledGroup('L', 'L', 2)])
		const first = await runSession(configuration, {
			onEvent: (event, runner) => {
				if (event.type === 'frameAccepted') void runner.handle.stop('graceful')
			},
		})
		expect(first.result).toMatchObject({ state: 'stopped' })

		await place(SLOT.Dark, 12345)
		const second = await runSession(configuration, { sessionId: first.sessionId })

		expect(second.result).toMatchObject({ state: 'completed', capture: { groups: [{ accepted: 2 }] } })
		expect(baselines(second).every((focus) => focus.kind === 'known' && focus.referencePosition === 10000)).toBeTrue()
		expect(commandsOf(second.devices, 'focuser', 'moveTo').map((command) => command.args[0])).toEqual([10000])
		await expectLightsInFocus(second, 10000)
		await assertOracles(second)
	}, 90000)

	test('8, 13, 29: a crash between the wheel and the focuser is reconciled once by the absolute target; a crash after the focuser commands nothing', async () => {
		const configuration = configurationOf([scheduledGroup('R', 'R', 1)])
		const original = rig.commanders.focuser.moveTo.bind(rig.commanders.focuser)
		let crash: VoidFunction | undefined
		const spy = spyOn(rig.commanders.focuser, 'moveTo').mockImplementation((...args) => {
			if (crash === undefined) return original(...args)
			crash()
			crash = undefined
			return Promise.resolve(failedOperationResult('aborted'))
		})

		try {
			// Crash after the wheel reached R, before the focuser was commanded.
			const first = await runSession(configuration, { onStart: (runner) => (crash = () => runner.dispose()) })
			expect(first.result).toMatchObject({ state: 'failed' })
			expect(rig.devices()).toMatchObject({ wheel: { position: SLOT.R }, focuser: { position: { value: 10000 } } })

			const second = await runSession(configuration, { sessionId: first.sessionId })
			expect(second.result).toMatchObject({ state: 'completed' })
			expect(commandsOf(second.devices, 'focuser', 'moveTo').map((command) => command.args[0])).toEqual([10100])
			expect(commandsOf(second.devices, 'wheel')).toEqual([])
			await expectLightsInFocus(second, 10000)
			await assertOracles(second)

			// Crash after the focuser reached R, before anything was saved: the resume commands nothing.
			await place(SLOT.L, 10000)
			const third = await runSession(configuration, {
				onEvent: (event, runner) => {
					if (event.type === 'taskCompleted' && event.task === 'prepareOpticalPath') runner.dispose()
				},
			})
			expect(third.result).toMatchObject({ state: 'failed' })
			const fourth = await runSession(configuration, { sessionId: third.sessionId })
			expect(fourth.result).toMatchObject({ state: 'completed' })
			expect(commandsOf(fourth.devices, 'focuser')).toEqual([])
			expect(commandsOf(fourth.devices, 'wheel')).toEqual([])
			await expectLightsInFocus(fourth, 10000)
		} finally {
			spy.mockRestore()
		}
	}, 120000)
})

describe('49.8 autofocus with focus offsets', () => {
	test('10, 15: a dedicated filter from an unknown baseline: no move before the run, the baseline from G, the frame filter and focus restored absolutely', async () => {
		await place(SLOT.Dark, 10100)
		const session = await runSession(configurationOf([scheduledGroup('R', 'R', 1)], { autofocus: { ...AUTOFOCUS, filter: { kind: 'name', name: 'G' } } }))
		const { result, devices, roots, measures, saves } = session

		expect(result).toMatchObject({ state: 'completed' })
		const [autofocus] = eventSequences(roots, (event) => event.type === 'taskStarted' && event.task === 'autofocus')
		expect(commandsOf(devices, 'focuser').every((command) => command.sequence > autofocus)).toBeTrue()
		expect(measures.every((measure) => measure.filter === 'G')).toBeTrue()
		// The run started where the focuser stood, the baseline is best − offset[G].
		expect(measures[0].position).toBe(10100 + ALGORITHM.initialOffsetSteps * ALGORITHM.stepSize)
		const known = saves.find((save) => save.checkpoint.focus.kind === 'known')!.checkpoint.focus as { readonly referencePosition: number }
		expect(Math.abs(known.referencePosition - 10010)).toBeLessThan(ALGORITHM.stepSize)

		// Wheel: to R by the optical path, to G for the autofocus, back to R.
		expect(commandsOf(devices, 'wheel', 'moveTo').map((command) => command.args[0])).toEqual([SLOT.R, SLOT.G, SLOT.R])
		expect(session.roots.some((entry) => entry.kind === 'root' && entry.operation.startsWith('sequencer.compensate.'))).toBeFalse()
		await expectLightsInFocus(session, known.referencePosition)
		await assertOracles(session)
	}, 90000)

	test('15: once the new baseline is saved, a stop during the filter restore compensates only the wheel', async () => {
		await place(SLOT.L, 10010)
		const original = rig.commanders.wheel.moveTo.bind(rig.commanders.wheel)
		let stop: VoidFunction | undefined
		let moves = 0
		const spy = spyOn(rig.commanders.wheel, 'moveTo').mockImplementation((...args) => {
			// The third move is the restore of the frame filter after the dedicated autofocus filter.
			if (++moves === 3) stop?.()
			return original(...args)
		})

		try {
			const session = await runSession(configurationOf([scheduledGroup('R', 'R', 1)], { autofocus: { ...AUTOFOCUS, filter: { kind: 'name', name: 'G' }, triggers: { ...NO_TRIGGERS, onStart: true } } }), { onStart: (runner) => (stop = () => void runner.handle.stop('immediate')) })

			expect(session.result).toMatchObject({ state: 'stopped' })
			const compensations = session.roots.filter((entry) => entry.kind === 'root' && entry.event === 'start' && entry.operation.startsWith('sequencer.compensate.'))
			expect(compensations.map((entry) => (entry as { readonly operation: string }).operation)).toEqual(['sequencer.compensate.wheelSlot'])
			expect(rig.devices().wheel.position).toBe(SLOT.R)
			expect(session.saves.at(-1)!.checkpoint.anchors.autofocus.lastSuccessfulAt).toBeGreaterThan(0)
			await assertOracles(session)
		} finally {
			spy.mockRestore()
		}
	}, 90000)

	test('14: a crash between the saved baseline and the restore of the dedicated filter resumes with the new baseline, without another autofocus', async () => {
		await place(SLOT.L, 10100)
		const configuration = configurationOf([scheduledGroup('L', 'L', 1)], { autofocus: { ...AUTOFOCUS, filter: { kind: 'name', name: 'G' }, triggers: { ...NO_TRIGGERS, onStart: true } } })
		const first = await runSession(configuration, {
			afterSave: (checkpoint, runner) => {
				if (checkpoint.anchors.autofocus.lastSuccessfulAt !== undefined) runner.dispose()
			},
		})
		expect(first.result).toMatchObject({ state: 'failed' })
		const known = first.saves.at(-1)!.checkpoint.focus as { readonly kind: string; readonly referencePosition: number }
		expect(known.kind).toBe('known')
		expect(rig.devices().wheel.position).toBe(SLOT.G)

		const second = await runSession(configuration, { sessionId: first.sessionId })
		expect(second.result).toMatchObject({ state: 'completed' })
		expect(second.events.some((event) => event.type === 'taskStarted' && event.task === 'autofocus')).toBeFalse()
		expect(commandsOf(second.devices, 'wheel', 'moveTo').map((command) => command.args[0])).toEqual([SLOT.L])
		await expectLightsInFocus(second, known.referencePosition)
		await assertOracles(second)
	}, 90000)

	test('14: a crash in the middle of the autofocus resumes at the previous absolute focus and runs it again', async () => {
		await place(SLOT.R, 10100)
		const configuration = configurationOf([scheduledGroup('L', 'L', 1)], { autofocus: { ...AUTOFOCUS, triggers: { ...NO_TRIGGERS, onStart: true } } })
		const first = await runSession(configuration, {
			measurer: (calls, sequence) => {
				const measure = opticsMeasurer(calls, sequence)
				return async (frame, signal) => {
					const hfd = await measure(frame, signal)
					if (calls.length === 3) holder.runner?.dispose()
					return hfd
				}
			},
			onStart: (runner) => (holder.runner = runner),
		})
		expect(first.result).toMatchObject({ state: 'failed' })
		expect(rig.devices().focuser.position.value).not.toBe(10000)

		const second = await runSession(configuration, { sessionId: first.sessionId })
		expect(second.result).toMatchObject({ state: 'completed' })
		const [autofocus] = eventSequences(second.roots, (event) => event.type === 'taskStarted' && event.task === 'autofocus')
		const [restore] = commandsOf(second.devices, 'focuser', 'moveTo')
		expect(restore.args[0]).toBe(10000)
		expect(restore.sequence).toBeLessThan(autofocus)
		expect(second.measures[0].position).toBe(10000 + ALGORITHM.initialOffsetSteps * ALGORITHM.stepSize)
		await assertOracles(second)
	}, 120000)

	test('16: a failed restore of the frame filter is fatal: the light is never exposed, even with skip', async () => {
		await place(SLOT.L, 10010)
		const original = rig.commanders.wheel.moveTo.bind(rig.commanders.wheel)
		let moves = 0
		const spy = spyOn(rig.commanders.wheel, 'moveTo').mockImplementation((...args) => (++moves >= 2 && args[2] === SLOT.L ? Promise.resolve(failedOperationResult('timeout', 'wheel stuck')) : original(...args)))

		try {
			const session = await runSession(configurationOf([scheduledGroup('L', 'L', 1)], { autofocus: { ...AUTOFOCUS, filter: { kind: 'name', name: 'G' }, triggers: { ...NO_TRIGGERS, onStart: true }, onFailure: 'skip' } }))

			expect(session.result).toMatchObject({ state: 'failed', failure: { kind: 'operation', reason: 'timeout', task: 'autofocus', detail: 'restore of the optical train: wheel stuck' } })
			expect(session.result.compensationFailures).toEqual([expect.objectContaining({ task: 'autofocus', reason: 'timeout' })])
			expect(session.events.some((event) => event.type === 'exposureStarted')).toBeFalse()
			await assertOracles(session)
		} finally {
			spy.mockRestore()
		}
	}, 90000)
})

// Runner of the test that needs it before its first event.
const holder: { runner?: SequencerRunner } = {}

describe('49.9 autofocus of the session', () => {
	test('1, 4, 50.3 6: first frame and every N lights; darks never trigger nor count; the focus lands within a step of the ideal', async () => {
		await place(SLOT.L, 10200)
		const autofocus = { ...AUTOFOCUS, triggers: { ...NO_TRIGGERS, onStart: true, afterFrames: 2 } }
		const session = await runSession(configurationOf([scheduledGroup('L', 'L', 4), scheduledGroup('D', 'Dark', 2, DARK)], { autofocus, order: 'roundRobin' }))
		const { result, events, saves } = session

		expect(result).toMatchObject({ state: 'completed' })
		// L D L D L L: autofocus before the first light and before the third one (two lights since the first).
		const order = events.filter((event) => (event.type === 'taskStarted' && event.task === 'autofocus') || event.type === 'exposureStarted').map((event) => (event.type === 'exposureStarted' ? event.slot : 'AF'))
		expect(order).toEqual(['AF', 'frame[L][1]', 'frame[D][1]', 'frame[L][2]', 'frame[D][2]', 'AF', 'frame[L][3]', 'frame[L][4]'])

		const anchors = saves.filter((save) => save.checkpoint.anchors.autofocus.lastSuccessfulAt !== undefined).map((save) => save.checkpoint.anchors.autofocus.lightExposures)
		expect(anchors[0]).toBe(0)
		expect(anchors.at(-1)).toBe(2)

		// Each light at the reference its own autofocus found, within a step of the ideal.
		const lights = (await acceptedFrames(session)).filter((frame) => frame.type === 'Light Frame')
		expect(lights).toHaveLength(4)
		for (const light of lights) expect(Math.abs(light.position - 10010)).toBeLessThan(ALGORITHM.stepSize)
		expect(lights.at(-1)!.position).toBe((saves.at(-1)!.checkpoint.focus as { readonly referencePosition: number }).referencePosition)
		await assertOracles(session)
	}, 120000)

	test('2: a failed autofocus restores the focuser and advances nothing; the next success advances the anchor and the intent stays clear', async () => {
		await place(SLOT.L, 10000)
		let runs = 0
		const autofocus = { ...AUTOFOCUS, triggers: { ...NO_TRIGGERS, onStart: true, afterFrames: 1 }, onFailure: 'skip' as const }
		const session = await runSession(configurationOf([scheduledGroup('L', 'L', 2)], { autofocus }), {
			hfd: (position) => (runs === 0 ? undefined : Math.hypot(1.8, 0.02 * (position - 10010))),
			onEvent: (event) => {
				if (event.type === 'taskFailed' && event.task === 'autofocus') runs++
			},
		})
		const { result, events, saves } = session

		expect(result).toMatchObject({ state: 'completed' })
		expect(events.filter((event) => event.type === 'taskFailed' && event.task === 'autofocus')).toHaveLength(1)
		expect(events.filter((event) => event.type === 'taskCompleted' && event.task === 'autofocus')).toHaveLength(1)
		// The first light was exposed at the restored baseline focus with nothing advanced.
		const lights = await acceptedFrames(session)
		expect(lights[0].position).toBe(10000)
		const beforeSuccess = saves.filter((save) => save.checkpoint.anchors.autofocus.lastSuccessfulAt === undefined)
		expect(beforeSuccess.every((save) => save.checkpoint.focus.kind === 'known' && save.checkpoint.focus.referencePosition === 10000)).toBeTrue()
		expect(saves.at(-1)!.checkpoint).toMatchObject({ anchors: { autofocus: { lightExposures: 1, filter: 'L' } }, intents: { autofocus: false } })
		await assertOracles(session)
	}, 120000)

	test('3 (49.8 15, 50.3 21): a stop during the autofocus cancels it, waits for quiescence and moves the focuser back by compensation before the release', async () => {
		await place(SLOT.L, 10000)
		const autofocus = { ...AUTOFOCUS, triggers: { ...NO_TRIGGERS, onStart: true } }
		const session = await runSession(configurationOf([scheduledGroup('L', 'L', 1)], { autofocus }), {
			measurer: (calls, sequence) => {
				const measure = opticsMeasurer(calls, sequence)
				return async (frame, signal) => {
					const hfd = await measure(frame, signal)
					if (calls.length === 3) void holder.runner?.handle.stop('immediate')
					return hfd
				}
			},
			onStart: (runner) => (holder.runner = runner),
		})
		const { result, roots, events } = session

		expect(result).toMatchObject({ state: 'stopped', compensationFailures: [] })
		const compensation = roots.findIndex((entry) => entry.kind === 'root' && entry.event === 'start' && entry.operation === 'sequencer.compensate.focuserPosition')
		const autofocusEnd = roots.findIndex((entry) => entry.kind === 'root' && entry.event === 'end' && entry.operation === 'sequencer.autofocus')
		const release = roots.findIndex((entry) => entry.kind === 'release')
		expect(autofocusEnd).toBeGreaterThan(-1)
		expect(compensation).toBeGreaterThan(autofocusEnd)
		expect(release).toBeGreaterThan(compensation)
		expect(rig.devices().focuser.position.value).toBe(10000)
		expect(events.some((event) => event.type === 'exposureStarted')).toBeFalse()
		await assertOracles(session)
	}, 90000)

	test('5: a protection in the middle of the autofocus cancels it, restores the focuser, runs, and the still-due autofocus runs afterwards', async () => {
		await place(SLOT.L, 10000)
		const protection: SequencerTask = { id: 'meridianFlip', shouldRun: () => true, run: () => Promise.resolve(OK) }
		const autofocus = { ...AUTOFOCUS, triggers: { ...NO_TRIGGERS, onStart: true } }
		let requested = false
		const session = await runSession(configurationOf([scheduledGroup('L', 'L', 1)], { autofocus }), {
			measurer: (calls, sequence) => {
				const measure = opticsMeasurer(calls, sequence)
				return async (frame, signal) => {
					const hfd = await measure(frame, signal)
					if (calls.length === 2 && !requested) requested = holder.runner!.requestProtection(protection)
					return hfd
				}
			},
			onStart: (runner) => (holder.runner = runner),
		})
		const { result, roots, events } = session

		expect(requested).toBeTrue()
		expect(result).toMatchObject({ state: 'completed', compensationFailures: [] })
		const tasks = events.filter((event) => event.type === 'taskStarted' || event.type === 'exposureStarted').map((event) => (event.type === 'taskStarted' ? event.task : 'exposure'))
		expect(tasks.filter((task) => task === 'autofocus' || task === 'meridianFlip' || task === 'exposure')).toEqual(['autofocus', 'meridianFlip', 'autofocus', 'exposure'])
		const compensations = roots.filter((entry) => entry.kind === 'root' && entry.event === 'start' && entry.operation === 'sequencer.compensate.focuserPosition')
		expect(compensations).toHaveLength(1)
		await expectLightsInFocus(session, (session.saves.at(-1)!.checkpoint.focus as { readonly referencePosition: number }).referencePosition)
		await assertOracles(session)
	}, 120000)

	test('auxiliary frames are FITS in auxiliary/autofocus, measured after their result and removed; the light keeps its own destination', async () => {
		await place(SLOT.L, 10000)
		const session = await runSession(configurationOf([scheduledGroup('L', 'L', 1)], { autofocus: { ...AUTOFOCUS, triggers: { ...NO_TRIGGERS, onStart: true } } }))
		const { result, requests, measures } = session
		const directory = join(ROOT, session.sessionId, 'auxiliary', 'autofocus')

		expect(result).toMatchObject({ state: 'completed' })
		const auxiliary = requests.filter((request) => request.outputPath === directory)
		expect(auxiliary.length).toBeGreaterThan(5)
		expect(requests.every((request) => request.transferFormat === 'FITS')).toBeTrue()
		expect(auxiliary.every((request) => request.publishPath === undefined && request.autoSave && request.focuser === 'Focuser Simulator')).toBeTrue()
		expect(measures.map((measure) => measure.path)).toEqual(auxiliary.map((request) => join(directory, request.outputName!)))
		expect(measures.every((measure, i) => measure.sequence > auxiliary[i].sequence)).toBeTrue()
		expect(await Array.fromAsync(new Bun.Glob('*').scan(directory))).toEqual([])
		await assertOracles(session)
	}, 90000)

	test('a restart resumes and triggers afterResume before the next light', async () => {
		await place(SLOT.L, 10000)
		const configuration = configurationOf([scheduledGroup('L', 'L', 2)], { autofocus: { ...AUTOFOCUS, triggers: { ...NO_TRIGGERS, afterResume: true } } })
		const first = await runSession(configuration, {
			onEvent: (event, runner) => {
				if (event.type === 'frameAccepted') void runner.handle.stop('graceful')
			},
		})
		expect(first.events.some((event) => event.type === 'taskStarted' && event.task === 'autofocus')).toBeFalse()

		const second = await runSession(configuration, { sessionId: first.sessionId })
		expect(second.result).toMatchObject({ state: 'completed' })
		expect(second.events.filter((event) => event.type === 'taskCompleted' && event.task === 'autofocus')).toHaveLength(1)
		await assertOracles(second)
	}, 90000)
})

describe('50.3 3', () => {
	test('roundRobin L/R/G/B ×2: every light starts at reference + offset[filter], in the same order on every run', async () => {
		const configuration = configurationOf([scheduledGroup('L', 'L', 2), scheduledGroup('R', 'R', 2), scheduledGroup('G', 'G', 2), scheduledGroup('B', 'B', 2)], { order: 'roundRobin' })
		const orders: string[][] = []

		for (let run = 0; run < 2; run++) {
			await place(SLOT.L, 10000)
			const session = await runSession(configuration)
			expect(session.result).toMatchObject({ state: 'completed' })
			const lights = await expectLightsInFocus(session, 10000)
			orders.push(lights.map((light) => light.filter))
			await assertOracles(session)
		}

		expect(orders[0]).toEqual(['L', 'R', 'G', 'B', 'L', 'R', 'G', 'B'])
		expect(orders[1]).toEqual(orders[0])
	}, 120000)
})
