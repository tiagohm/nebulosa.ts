import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { basename, join, sep } from 'path'
import { resourceKey } from '../../../src/devices/orchestration/resource'
import { isFits } from '../../../src/io/formats/fits/fits'
import { type CameraCaptureHooks, CameraCapturer } from '../../../src/observation/capture/capture'
import { awaitCameraRecoveryTask, captureFrameStep, type SequencerCaptureServices, sequencerCaptureRequest } from '../../../src/observation/sequencer/capture'
import { type SequencerCaptureStep, type SequencerRunner, startSequencerRunner } from '../../../src/observation/sequencer/runner'
import { sequencerFrameSlotId } from '../../../src/observation/sequencer/scheduler'
// oxfmt-ignore
import type { SequencerCameraCapture, SequencerCaptureConfiguration, SequencerCheckpointStore, SequencerClock, SequencerConfiguration, SequencerDevices, SequencerEvent, SequencerFrameSlot, SequencerQualityAnalyzer, SequencerQualityFrame, SequencerResult } from '../../../src/observation/sequencer/sequencer'
import { FileSystemSequencerCheckpointStore, FileSystemSequencerStorage, prepareFrameDestinationTask, readSequencerJournal, sequencerFrameDestination } from '../../../src/observation/sequencer/storage'
import { waitUntil } from '../../util'
// oxfmt-ignore
import { assertJournalInvariants, connectSequencerRig, createSequencerRig, createTestSequence, expectNoSequencerLeaks, injectFileSystemFaults, ManualSequencerClock } from './util'
import { DEFAULT_CAMERA_CAPTURE_START, type CameraCaptureStart } from '../../../src/observation/capture/types'

// The primary capture of the Sequencer over the real CameraCapturer and the INDI simulators: the request it commands,
// the durable writer of the storage passed per capture, the refusal of `beforeExposure`, and the wait for a camera
// quarantined by a late frame payload. Sessions here are camera-only: no startup or shutdown task, the pre-capture is
// the recovery wait and the frame destination. Exposures are short subframes, so a capture takes about one tick of the
// simulator (100 ms).

const LIGHT: SequencerCameraCapture = { exposureTime: 10, exposureTimeUnit: 'millisecond', frameType: 'LIGHT', x: 0, y: 0, width: 64, height: 64, subframe: true, binX: 2, binY: 2, frameFormat: 'MONO', gain: 10, offset: 5, compressed: false }

const rig = await createSequencerRig()
// Session directories live inside the captures directory, so the leak check sees their partial files.
const ROOT = join(rig.capturesDir, 'sessions')

beforeAll(async () => {
	await connectSequencerRig(rig)
})

afterAll(async () => {
	await rig[Symbol.asyncDispose]()
})

afterEach(async () => {
	await expectNoSequencerLeaks(rig)
})

function configurationOf(count: number = 1, capture: Partial<SequencerCaptureConfiguration> = {}): SequencerConfiguration {
	return {
		schemaVersion: 1,
		id: 'capture',
		revision: 1,
		name: 'Capture',
		capture: { order: 'sequential', groups: [{ kind: 'scheduled', id: 'L', enabled: true, capture: LIGHT, count }], retry: { maxAttempts: 3, delay: 0, backoff: 1, maximumDelay: 0, retryOn: ['timeout'] }, onFailure: 'fail', cameraRecovery: { timeout: 300, pollInterval: 1, onTimeout: 'stop' }, ...capture },
		startup: { onFailure: 'fail' },
		shutdown: { stepTimeout: 30, totalTimeout: 300 },
		execution: { compensation: { timeout: 30 } },
	}
}

// One process of a camera-only session.
interface Session {
	readonly runner: SequencerRunner
	readonly storage: FileSystemSequencerStorage
	readonly events: SequencerEvent[]
	readonly result: Promise<SequencerResult>
	done: boolean
}

interface SessionOptions {
	readonly configuration?: SequencerConfiguration
	readonly clock?: SequencerClock
	// Capturer of the primary frames; the one of the rig by default.
	readonly capturer?: CameraCapturer
	// Whether the pre-capture waits for a quarantined camera; true by default.
	readonly recovery?: boolean
	// Replaces the durable writer the capture step is given, around the one of the storage.
	readonly writer?: (storage: FileSystemSequencerStorage) => SequencerCaptureServices['storage']
	// Wraps the capture step.
	readonly capture?: (step: SequencerCaptureStep) => SequencerCaptureStep
	readonly onEvent?: (event: SequencerEvent, session: Session) => void
	// Checkpoint store of the process; one over ROOT by default.
	readonly checkpointStore?: SequencerCheckpointStore
	// Quality analyzer of the primary frames.
	readonly qualityAnalyzer?: SequencerQualityAnalyzer
}

// Starts the next process of the session `sessionId`, camera-only, with the real capturer.
function startSession(sessionId: string, options: SessionOptions = {}): Session {
	const configuration = options.configuration ?? configurationOf()
	const clock = options.clock ?? new ManualSequencerClock()
	const storage = new FileSystemSequencerStorage({ root: ROOT, sessionId, wallNow: clock.wallNow })
	const events: SequencerEvent[] = []
	const capturer = options.capturer ?? rig.capturer
	const step = captureFrameStep({ cameraCapturer: capturer, storage: options.writer?.(storage) ?? storage })
	const recovery = options.recovery === false ? [] : [awaitCameraRecoveryTask(rig.arbiter, configuration.capture.cameraRecovery)]
	const phases = { startup: [], preCapture: [...recovery, prepareFrameDestinationTask(storage)], capture: options.capture?.(step) ?? step, shutdown: [] }
	const listener = (event: SequencerEvent) => {
		events.push(event)
		options.onEvent?.(event, session)
	}
	const services = { coordinator: rig.coordinator, storage, checkpointStore: options.checkpointStore ?? new FileSystemSequencerCheckpointStore(ROOT), clock, listener, ...(options.qualityAnalyzer !== undefined && { qualityAnalyzer: options.qualityAnalyzer }) }
	const runner = startSequencerRunner({ configuration, devices: { camera: camera() }, services, phases })
	const session: Session = { runner, storage, events, result: runner.handle.result, done: false }
	void session.result.then(() => (session.done = true))
	return session
}

function camera() {
	return rig.devices().camera
}

function cameraKey() {
	return resourceKey(camera())
}

async function journalOf(sessionId: string) {
	return await readSequencerJournal(join(ROOT, sessionId, 'journal.jsonl'))
}

async function checkpointOf(sessionId: string) {
	return await new FileSystemSequencerCheckpointStore(ROOT).load(sessionId)
}

function kindsOf(journal: readonly { readonly kind: string }[]) {
	return journal.map((entry) => entry.kind)
}

// Every file under a session directory, relative with `/` separators, sorted.
function filesOf(sessionId: string) {
	const directory = join(ROOT, sessionId)
	return (readdirSync(directory, { recursive: true }) as string[])
		.filter((path) => statSync(join(directory, path)).isFile())
		.map((path) => path.split(sep).join('/'))
		.sort()
}

// Whether a path is the lock of a session, which a simulated crash still releases.
function isLockPath(path: string) {
	return /(?:^|[\\/])(?:session\.lock|session\.lock\.reclaim|\.session\.lock\..+\.tmp)$/.test(path)
}

// Plays the death of a process: every durable operation but the lock fails from now on, the runner is disposed and
// its end awaited.
async function crash(session: Session) {
	using _ = injectFileSystemFaults({ failAt: 1, mode: 'crash', spare: isLockPath })
	const { warn } = console
	console.warn = () => {}

	try {
		session.runner.dispose()
		await session.result
	} finally {
		console.warn = warn
	}
}

// Records the requests and hooks every capture of `capturer` is started with.
function spyCaptureStarts(capturer: CameraCapturer) {
	const starts: { readonly request: CameraCaptureStart; readonly hooks?: CameraCaptureHooks }[] = []
	const start = capturer.start.bind(capturer)
	const spy = spyOn(capturer, 'start').mockImplementation((scope, device, request, hooks) => {
		starts.push({ request: structuredClone(request), hooks })
		return start(scope, device, request, hooks)
	})
	return { starts, spy } as const
}

// Records every exposure command of the camera manager with the unavailability causes of the camera at that moment.
function spyStartExposure() {
	const calls: (readonly string[])[] = []
	const manager = rig.managers.camera
	const original = manager.startExposure.bind(manager)
	const spy = spyOn(manager, 'startExposure').mockImplementation((...args: Parameters<typeof original>) => {
		calls.push(rig.arbiter.snapshot(cameraKey()).causes)
		original(...args)
	})
	return { calls, spy } as const
}

describe('capture request', () => {
	const slot: SequencerFrameSlot = { id: sequencerFrameSlotId('L', 1), groupId: 'L', kind: 'scheduled', ordinal: 1, attempt: 2, discardedTotal: 0, discardBudgetUsed: 0, captureFailures: 1, capture: LIGHT }
	const destination = sequencerFrameDestination(join(ROOT, 'request'), 'L', slot.id, slot.attempt)

	test('34, 35: one FITS frame auto-saved as the hidden temporary of the final, published under the final, snooping the session devices', () => {
		const devices = rig.devices()
		const request = sequencerCaptureRequest(slot, destination, devices)

		expect(request).toEqual({
			...DEFAULT_CAMERA_CAPTURE_START,
			...LIGHT,
			exposureMode: 'single',
			count: 1,
			delay: 0,
			transferFormat: 'FITS',
			autoSave: true,
			autoSubFolderMode: 'off',
			outputPath: join(ROOT, 'request', 'L'),
			outputName: '.frame[L][1].2.partial.fit',
			publishPath: join(ROOT, 'request', 'L', 'frame[L][1].fit'),
			mount: devices.mount.name,
			wheel: devices.wheel.name,
			focuser: devices.focuser.name,
			rotator: devices.rotator.name,
		})
	})

	test('a camera-only session snoops nothing, and fields outside the camera settings of the slot never leak in', () => {
		const devices: SequencerDevices = { camera: camera() }
		const request = sequencerCaptureRequest({ ...slot, capture: { ...LIGHT, exposureMode: 'loop', transferFormat: 'XISF' } as SequencerCameraCapture }, destination, devices)

		expect(request).toMatchObject({ exposureMode: 'single', transferFormat: 'FITS' })
		for (const name of ['mount', 'wheel', 'focuser', 'rotator', 'savePath']) expect(request).not.toHaveProperty(name)
	})
})

describe('durable writer', () => {
	test('30, 34: one capturer serves a manual capture with its default writer (no fsync) and the session with the durable writer', async () => {
		using faults = injectFileSystemFaults()
		const manual = join(rig.capturesDir, 'manual')
		const { starts, spy } = spyCaptureStarts(rig.capturer)

		try {
			const request = { ...structuredClone(DEFAULT_CAMERA_CAPTURE_START), ...LIGHT, autoSave: true, outputPath: manual, outputName: 'manual.fit' }
			expect((await rig.capturer.start(rig.coordinator, camera(), request).result).ok).toBeTrue()
			expect(isFits(readFileSync(join(manual, 'manual.fit')))).toBeTrue()

			const sessionId = Bun.randomUUIDv7()
			const session = startSession(sessionId)
			expect((await session.result).state).toBe('completed')

			// The manual capture was written by the exclusive default writer (temporary + link), never through a
			// durable open + fsync.
			const manualOperations = faults.entries.filter((entry) => entry.paths.some((path) => path.includes('manual.fit'))).map((entry) => entry.operation)
			expect(manualOperations).not.toContain('open')
			expect(manualOperations).not.toContain('sync')

			const durable = faults.entries.filter((entry) => entry.paths.some((path) => path.endsWith('.frame[L][1].1.partial.fit')))
			expect(durable.map((entry) => entry.operation)).toContain('sync')

			// Only the session capture got the durable writer and the session clock; every capture is FITS.
			expect(starts).toHaveLength(2)
			expect(starts[0].hooks?.write).toBeUndefined()
			expect(starts[1].hooks?.write).toBe(session.storage.writeDurably)
			expect(starts[1].hooks?.clock).toBeDefined()
			expect(starts.every((start) => start.request.transferFormat === 'FITS')).toBeTrue()
			expect(isFits(readFileSync(join(ROOT, sessionId, 'L', 'frame[L][1].fit')))).toBeTrue()
		} finally {
			spy.mockRestore()
		}
	})

	test('31 (I44): write(temp) < fsync(temp) < writer resolves < result < promoting', async () => {
		const sequence = createTestSequence()
		const marks = new Map<string, number>()
		const mark = (name: string) => marks.set(name, sequence.next())
		using faults = injectFileSystemFaults({ sequence })
		const sessionId = Bun.randomUUIDv7()

		const session = startSession(sessionId, {
			writer: (storage) => ({
				writeDurably: async (path, data) => {
					await storage.writeDurably(path, data)
					mark('writer')
				},
			}),
			capture: (step) => async (context) => {
				const result = await step(context)
				mark('result')
				return result
			},
			onEvent: (event, current) => {
				if (event.type === 'taskCompleted' && event.task === 'captureFrame') {
					const promote = current.storage.promote.bind(current.storage)
					spyOn(current.storage, 'promote').mockImplementation((...args) => {
						mark('promote')
						return promote(...args)
					})
				}
			},
		})

		expect((await session.result).state).toBe('completed')
		const temporary = (entry: { readonly paths: readonly string[] }) => entry.paths.some((path) => path.endsWith('.frame[L][1].1.partial.fit'))
		const write = faults.entries.find((entry) => entry.operation === 'write' && temporary(entry))!.sequence
		const sync = faults.entries.find((entry) => entry.operation === 'sync' && temporary(entry))!.sequence

		expect(write).toBeLessThan(sync)
		expect(sync).toBeLessThan(marks.get('writer')!)
		expect(marks.get('writer')!).toBeLessThan(marks.get('result')!)
		expect(marks.get('result')!).toBeLessThan(marks.get('promote')!)
		expect(kindsOf(await journalOf(sessionId))).toEqual(['prepared', 'promoting', 'committed'])
	})

	test('31: a writer rejecting at the fsync fails the capture as commandFailed: no promoting, the attempt abandoned and retried', async () => {
		const sessionId = Bun.randomUUIDv7()
		const configuration = configurationOf(1, { retry: { maxAttempts: 2, delay: 0, backoff: 1, maximumDelay: 0, retryOn: ['commandFailed'] } })

		let session: Session

		{
			// Only the fsync of a temporary is counted, and the first one fails.
			using _ = injectFileSystemFaults({ failAt: 1, operations: ['sync'], spare: (path) => !path.endsWith('.partial.fit') })
			session = startSession(sessionId, { configuration })
			expect((await session.result).state).toBe('completed')
		}

		expect(session.events.find((event) => event.type === 'taskFailed' && event.task === 'captureFrame')).toMatchObject({ failure: { kind: 'operation', reason: 'commandFailed' } })
		const journal = await journalOf(sessionId)
		expect(journal).toMatchObject([
			{ kind: 'prepared', attempt: 1 },
			{ kind: 'abandoned', attempt: 1, reason: 'failed' },
			{ kind: 'prepared', attempt: 2 },
			{ kind: 'promoting', attempt: 2 },
			{ kind: 'committed', attempt: 2 },
		])
		assertJournalInvariants(journal, session.events)
		expect(filesOf(sessionId).filter((path) => path.endsWith('.fit'))).toEqual(['L/frame[L][1].fit'])
	})

	test('32: a crash between the write and the fsync of the temporary never promotes it; its open prepared counts as an exposure in flight', async () => {
		const sessionId = Bun.randomUUIDv7()
		let faults: ReturnType<typeof injectFileSystemFaults> | undefined
		const { warn } = console
		console.warn = () => {}

		try {
			const first = startSession(sessionId, {
				writer: (storage) => ({
					writeDurably: async (path, data) => {
						// From the write of the temporary on, the process is dead: its write lands, its fsync and everything
						// durable after it fail (but the lock, so this process can play the next one).
						faults = injectFileSystemFaults({ failAt: 2, mode: 'crash', spare: isLockPath })
						await storage.writeDurably(path, data)
					},
				}),
			})

			expect(await first.result).toMatchObject({ state: 'failed', failure: { kind: 'storage' } })
		} finally {
			faults?.[Symbol.dispose]()
			console.warn = warn
		}

		expect(kindsOf(await journalOf(sessionId))).toEqual(['prepared'])

		const second = startSession(sessionId)
		expect((await second.result).state).toBe('completed')
		const journal = await journalOf(sessionId)
		expect(journal).toMatchObject([
			{ kind: 'prepared', attempt: 1 },
			{ kind: 'abandoned', attempt: 1, reason: 'crash' },
			{ kind: 'prepared', attempt: 2 },
			{ kind: 'promoting', attempt: 2 },
			{ kind: 'committed', attempt: 2 },
		])
		expect(journal.some((entry) => entry.kind === 'promoting' && entry.attempt === 1)).toBeFalse()
		expect(filesOf(sessionId).filter((path) => path.endsWith('.fit'))).toEqual(['L/frame[L][1].fit', 'rejected/incomplete/L/.frame[L][1].1.partial.fit'])
	})
})

describe('49.3 quality analyzer over the real capture', () => {
	// Format an analyzer picks by the extension of the path, as a caller's parser dispatch does.
	function formatOf(path: string) {
		return path.endsWith('.fit') || path.endsWith('.fits') ? 'fits' : path.endsWith('.xisf') ? 'xisf' : undefined
	}

	test('16, 17, I45: the analyzer reads the complete temporary FITS by path, after the durable writer and the result, with the camera free', async () => {
		const sequence = createTestSequence()
		const marks: [string, number][] = []
		const mark = (name: string) => marks.push([name, sequence.next()])
		using faults = injectFileSystemFaults({ sequence })
		const sessionId = Bun.randomUUIDv7()
		const frames: SequencerQualityFrame[] = []
		const owners: (readonly unknown[])[] = []

		const session = startSession(sessionId, {
			configuration: configurationOf(2, { quality: { timeout: 30 } }),
			writer: (storage) => ({
				writeDurably: async (path, data) => {
					await storage.writeDurably(path, data)
					mark('writer')
				},
			}),
			capture: (step) => async (context) => {
				const result = await step(context)
				mark('result')
				return result
			},
			qualityAnalyzer: async (frame) => {
				mark('analyze')
				frames.push(frame)
				owners.push(rig.arbiter.ownersOf(cameraKey()))
				// Only the path reaches the analyzer, never the bytes of the frame.
				if (Object.values(frame).some((value) => Buffer.isBuffer(value) || ArrayBuffer.isView(value))) throw new Error('bytes handed to the analyzer')
				const data = Buffer.from(await Bun.file(frame.path).arrayBuffer())
				return { classification: formatOf(frame.path) === 'fits' && isFits(data) ? 'accepted' : 'rejected', metrics: { size: data.byteLength } }
			},
		})

		expect((await session.result).state).toBe('completed')
		expect(marks.map(([name]) => name)).toEqual(['writer', 'result', 'analyze', 'writer', 'result', 'analyze'])
		expect(frames.map((frame) => [basename(frame.path), frame.slot.id, frame.slot.attempt, frame.slot.capture.frameType])).toEqual([
			['.frame[L][1].1.partial.fit', 'frame[L][1]', 1, 'LIGHT'],
			['.frame[L][2].1.partial.fit', 'frame[L][2]', 1, 'LIGHT'],
		])
		for (const frame of frames) expect(frame.exposureStartedAt).toBeLessThanOrEqual(frame.exposureFinishedAt)
		expect(owners).toEqual([[], []])

		const sync = faults.entries.find((entry) => entry.operation === 'sync' && entry.paths.some((path) => path.endsWith('.frame[L][1].1.partial.fit')))!.sequence
		expect(sync).toBeLessThan(marks[2][1])

		const outcomes = session.events.flatMap((event) => (event.type === 'frameCaptured' ? [event.quality] : []))
		expect(outcomes).toMatchObject([
			{ kind: 'analyzed', result: { classification: 'accepted' } },
			{ kind: 'analyzed', result: { classification: 'accepted' } },
		])
		expect(kindsOf(await journalOf(sessionId))).toEqual(['prepared', 'promoting', 'committed', 'prepared', 'promoting', 'committed'])
	})

	test('18i: an analyzer that picks its parser by the extension classifies every temporary (2 variants)', async () => {
		const sessionId = Bun.randomUUIDv7()
		const formats: (string | undefined)[] = []
		const session = startSession(sessionId, {
			configuration: configurationOf(2, { quality: { timeout: 30 } }),
			qualityAnalyzer: (frame) => {
				const format = formatOf(frame.path)
				formats.push(format)
				if (format === undefined) return Promise.reject(new Error(`unknown format of ${frame.path}`))
				return Promise.resolve({ classification: 'accepted' })
			},
		})

		expect((await session.result).state).toBe('completed')
		expect(formats).toEqual(['fits', 'fits'])
		expect(session.events.flatMap((event) => (event.type === 'frameCaptured' ? [event.quality.kind] : []))).toEqual(['analyzed', 'analyzed'])
		// Incorrect variant: a temporary named after the old `.{name}.fit.{attempt}.partial` scheme defeats the dispatch.
		expect(formatOf('.frame[L][1].fit.1.partial')).toBeUndefined()
	})
})

describe('beforeExposure', () => {
	// Runs `action` from the first configuration command the capturer sends for the exposure of the session, which is
	// after the destination was prepared and before the veto.
	function onConfigure(action: VoidFunction) {
		const manager = rig.managers.camera
		const original = manager.frameType.bind(manager)
		let fired = false
		return spyOn(manager, 'frameType').mockImplementation((...args: Parameters<typeof original>) => {
			if (!fired) {
				fired = true
				action()
			}
			original(...args)
		})
	}

	test('25: a refusal for a pause writes deferred after the result and before the hold; a crash then counts nothing', async () => {
		const sessionId = Bun.randomUUIDv7()
		const exposures = spyStartExposure()
		let session: Session | undefined
		const configure = onConfigure(() => void session!.runner.handle.pause())

		try {
			session = startSession(sessionId)
			await waitUntil(() => session!.runner.snapshot().state === 'paused', 5000, 5)
		} finally {
			configure.mockRestore()
			exposures.spy.mockRestore()
		}

		expect(exposures.calls).toEqual([])
		expect(session.events.some((event) => event.type === 'exposureStarted')).toBeFalse()
		expect((await journalOf(sessionId)).at(-1)).toMatchObject({ kind: 'deferred', slot: 'frame[L][1]', attempt: 1, reason: 'beforeExposure' })
		expect(await checkpointOf(sessionId)).toMatchObject({ currentSlot: { id: 'frame[L][1]', attempt: 1, captureFailures: 0 } })
		// Nothing was dispatched, so no payload is owed and the camera is free.
		expect(rig.arbiter.snapshot(cameraKey()).causes).toEqual([])
		expect(existsSync(sequencerFrameDestination(join(ROOT, sessionId), 'L', 'frame[L][1]', 1).temporary)).toBeFalse()

		await crash(session)

		const second = startSession(sessionId)
		expect((await second.result).state).toBe('completed')
		const journal = await journalOf(sessionId)
		expect(kindsOf(journal)).toEqual(['prepared', 'deferred', 'prepared', 'promoting', 'committed'])
		expect(journal.every((entry) => entry.kind === 'lockReclaimed' || entry.attempt === 1)).toBeTrue()
	})

	test('a refusal for a stop writes deferred and stops with zero exposures; a later process prepares the same attempt', async () => {
		const sessionId = Bun.randomUUIDv7()
		const exposures = spyStartExposure()
		let session: Session | undefined
		const configure = onConfigure(() => void session!.runner.handle.stop())

		try {
			session = startSession(sessionId)
			expect(await session.result).toMatchObject({ state: 'stopped', stopCause: 'user' })
		} finally {
			configure.mockRestore()
			exposures.spy.mockRestore()
		}

		expect(exposures.calls).toEqual([])
		expect(session.events.some((event) => event.type === 'exposureStarted')).toBeFalse()
		expect((await journalOf(sessionId)).at(-1)).toMatchObject({ kind: 'deferred', attempt: 1, reason: 'beforeExposure' })
		expect(rig.arbiter.snapshot(cameraKey()).causes).toEqual([])

		const second = startSession(sessionId)
		expect((await second.result).state).toBe('completed')
		expect((await journalOf(sessionId)).filter((entry) => entry.kind === 'committed')).toMatchObject([{ attempt: 1 }])
	})

	test('49.7 15: a dispatch that throws counts one capture failure, saved before the retry, which exposes exactly once (I26)', async () => {
		const sessionId = Bun.randomUUIDv7()
		const order: string[] = []
		const manager = rig.managers.camera
		const startExposure = manager.startExposure.bind(manager)
		const dispatch = spyOn(manager, 'startExposure').mockImplementation((...args: Parameters<typeof startExposure>) => {
			order.push('startExposure')
			if (order.filter((entry) => entry === 'startExposure').length === 1) throw new Error('driver exploded')
			startExposure(...args)
		})

		// Checkpoint store recording the current slot of every save in the same order.
		const inner = new FileSystemSequencerCheckpointStore(ROOT)
		const checkpointStore: SequencerCheckpointStore = {
			load: (id) => inner.load(id),
			save: async (checkpoint) => {
				await inner.save(checkpoint)
				if (checkpoint.currentSlot !== undefined) order.push(`save ${checkpoint.currentSlot.attempt}/${checkpoint.currentSlot.captureFailures}`)
			},
		}

		try {
			const retry = { maxAttempts: 3, delay: 0, backoff: 1, maximumDelay: 0, retryOn: ['commandFailed' as const] }
			const session = startSession(sessionId, { configuration: configurationOf(1, { retry }), checkpointStore })
			expect((await session.result).state).toBe('completed')

			// The failure was saved before the second dispatch; the retry exposed once, the thrown dispatch never.
			const dispatches = order.flatMap((entry, i) => (entry === 'startExposure' ? [i] : []))
			expect(dispatches).toHaveLength(2)
			expect(order.slice(dispatches[0], dispatches[1]).some((entry) => entry === 'save 2/1')).toBeTrue()
			expect(session.events.filter((event) => event.type === 'exposureStarted')).toEqual([expect.objectContaining({ slot: 'frame[L][1]', attempt: 2 })])
			// Nothing was owed for the thrown dispatch: no temporary left, no quarantine, no payload.
			expect(rig.arbiter.snapshot(cameraKey()).causes).toEqual([])
			expect(filesOf(sessionId).filter((path) => path.endsWith('.fit'))).toEqual(['L/frame[L][1].fit'])
			assertJournalInvariants(await journalOf(sessionId), session.events)
		} finally {
			dispatch.mockRestore()
		}
	})

	test('an approved exposure emits exposureStarted once, after the dispatch', async () => {
		const sessionId = Bun.randomUUIDv7()
		const session = startSession(sessionId, { configuration: configurationOf(2) })
		expect((await session.result).state).toBe('completed')

		const started = session.events.filter((event) => event.type === 'exposureStarted')
		expect(started).toMatchObject([
			{ slot: 'frame[L][1]', attempt: 1 },
			{ slot: 'frame[L][2]', attempt: 1 },
		])

		for (const event of started) {
			if (event.type !== 'exposureStarted') continue
			const selected = session.events.findIndex((other) => other.type === 'frameSelected' && other.frame.id === event.slot)
			const captured = session.events.findIndex((other) => other.type === 'frameCaptured' && other.slot === event.slot)
			expect(selected).toBeLessThan(session.events.indexOf(event))
			expect(session.events.indexOf(event)).toBeLessThan(captured)
		}
	})
})

describe('49.17 2: camera quarantine', () => {
	// Capturer whose rendezvous gives up 300 ms after the exposure, so a withheld payload times out quickly.
	function quickCapturer() {
		return new CameraCapturer(rig.managers.camera, rig.arbiter, { capturesDir: rig.capturesDir, frameGraceTime: 300, quiesceTimeout: 2000, lateBlobDrainTime: 0 })
	}

	// Withholds every frame payload of `capturer` until released, which then delivers the first one.
	function withholdPayloads(capturer: CameraCapturer) {
		const held: Parameters<CameraCapturer['blobReceived']>[] = []
		const spy = spyOn(capturer, 'blobReceived').mockImplementation((...args) => {
			held.push(args)
		})

		return {
			held,
			release: () => {
				spy.mockRestore()
				if (held.length > 0) capturer.blobReceived(...held[0])
			},
		} as const
	}

	// Runs `body` with a quick capturer whose payloads are withheld; quarantine and capturer are always cleaned up.
	async function withQuarantine(body: (capturer: CameraCapturer, payloads: ReturnType<typeof withholdPayloads>) => Promise<void>) {
		using capturer = quickCapturer()
		const payloads = withholdPayloads(capturer)

		try {
			await body(capturer, payloads)
		} finally {
			payloads.release()
			await waitUntil(() => rig.arbiter.snapshot(cameraKey()).causes.length === 0, 5000, 5)
		}
	}

	const RECOVERY = configurationOf(1, { cameraRecovery: { timeout: 300, pollInterval: 1, onTimeout: 'stop' } })

	test('a timed-out exposure counts one failure; the retry waits for the stale payload without counting or commanding anything (I37)', async () => {
		await withQuarantine(async (capturer, payloads) => {
			const clock = new ManualSequencerClock()
			const sessionId = Bun.randomUUIDv7()
			const exposures = spyStartExposure()

			try {
				const session = startSession(sessionId, { configuration: RECOVERY, clock, capturer })
				await waitUntil(() => clock.pending > 0, 5000, 5)

				expect(rig.arbiter.snapshot(cameraKey()).causes).toContain('quarantine')
				expect(session.runner.snapshot()).toMatchObject({ phase: 'preCapture', task: 'awaitCameraRecovery' })
				const checkpoint = await checkpointOf(sessionId)
				const journal = await journalOf(sessionId)
				expect(checkpoint).toMatchObject({ currentSlot: { id: 'frame[L][1]', attempt: 2, captureFailures: 1 } })
				expect(kindsOf(journal)).toEqual(['prepared', 'abandoned'])

				// Dozens of polls change nothing: no exposure, no journal line, no checkpoint.
				for (let poll = 0; poll < 40; poll++) {
					await clock.advance(1000)
					expect(clock.pending).toBe(1)
				}

				expect(exposures.calls).toHaveLength(1)
				expect(await checkpointOf(sessionId)).toEqual(checkpoint)
				expect(await journalOf(sessionId)).toEqual(journal)

				// The stale payload ends the quarantine; the next poll lets the retry expose.
				payloads.release()
				expect(rig.arbiter.snapshot(cameraKey()).causes).toEqual([])
				await clock.advance(1000)

				expect((await session.result).state).toBe('completed')
				expect(exposures.calls).toHaveLength(2)
				expect(exposures.calls.every((causes) => !causes.includes('quarantine'))).toBeTrue()
				expect(session.events.filter((event) => event.type === 'taskStarted' && event.task === 'awaitCameraRecovery')).toHaveLength(1)
				expect(kindsOf(await journalOf(sessionId))).toEqual(['prepared', 'abandoned', 'prepared', 'promoting', 'committed'])
				const completed = await checkpointOf(sessionId)
				expect(completed).toMatchObject({ capture: { L: { accepted: 1 } } })
				expect(completed?.currentSlot).toBeUndefined()
				expect(clock.pending).toBe(0)
			} finally {
				exposures.spy.mockRestore()
			}
		})
	})

	test('(incorrect variant) without the wait the retry meets the quarantined camera and the slot never completes', async () => {
		await withQuarantine(async (capturer) => {
			const sessionId = Bun.randomUUIDv7()
			const exposures = spyStartExposure()

			try {
				const session = startSession(sessionId, { configuration: RECOVERY, capturer, recovery: false })
				const result = await session.result

				// The retry is refused busy before anything is commanded: the slot is lost, though never counted twice.
				expect(result).toMatchObject({ state: 'failed', failure: { kind: 'operation', reason: 'busy', task: 'captureFrame' }, capture: { groups: [{ accepted: 0 }] } })
				expect(exposures.calls).toHaveLength(1)
				expect(await checkpointOf(sessionId)).toMatchObject({ currentSlot: { attempt: 2, captureFailures: 1 } })
			} finally {
				exposures.spy.mockRestore()
			}
		})
	})

	test('a quarantine that never ends applies cameraRecovery.onTimeout once', async () => {
		for (const onTimeout of ['stop', 'fail'] as const) {
			await withQuarantine(async (capturer) => {
				const clock = new ManualSequencerClock()
				const sessionId = Bun.randomUUIDv7()
				const session = startSession(sessionId, { configuration: configurationOf(1, { cameraRecovery: { timeout: 5, pollInterval: 1, onTimeout } }), clock, capturer })
				await waitUntil(() => clock.pending > 0, 5000, 5)

				await clock.advance(4999)
				expect(session.done).toBeFalse()
				await clock.advance(1)

				const result = await session.result
				const failure = { kind: 'operation', reason: 'timeout', task: 'awaitCameraRecovery' }
				expect(result).toMatchObject(onTimeout === 'stop' ? { state: 'stopped', stopCause: 'policy', failure } : { state: 'failed', failure })
				expect(session.events.filter((event) => event.type === 'taskFailed' && event.task === 'awaitCameraRecovery')).toHaveLength(1)
				expect(await checkpointOf(sessionId)).toMatchObject({ currentSlot: { attempt: 2, captureFailures: 1 } })
			})
		}
	})

	test('onTimeout pause: the resumed pre-capture waits again with a new deadline', async () => {
		await withQuarantine(async (capturer, payloads) => {
			const clock = new ManualSequencerClock()
			const sessionId = Bun.randomUUIDv7()
			const session = startSession(sessionId, { configuration: configurationOf(1, { cameraRecovery: { timeout: 5, pollInterval: 1, onTimeout: 'pause' } }), clock, capturer })
			await waitUntil(() => clock.pending > 0, 5000, 5)

			await clock.advance(5000)
			await waitUntil(() => session.runner.snapshot().state === 'paused', 5000, 5)
			expect(clock.pending).toBe(0)

			expect(session.runner.handle.resume()).toBeTrue()
			await waitUntil(() => clock.pending > 0, 5000, 5)
			await clock.advance(4000)
			expect(session.runner.snapshot().state).toBe('running')

			payloads.release()
			await clock.advance(1000)
			expect((await session.result).state).toBe('completed')
			expect(session.events.filter((event) => event.type === 'taskFailed' && event.task === 'awaitCameraRecovery')).toHaveLength(1)
			expect(await checkpointOf(sessionId)).toMatchObject({ capture: { L: { accepted: 1 } } })
		})
	})

	test('a disconnection during the wait ends it without another failure; the capture policy takes over', async () => {
		await withQuarantine(async (capturer, payloads) => {
			const clock = new ManualSequencerClock()
			const sessionId = Bun.randomUUIDv7()
			const exposures = spyStartExposure()
			const device = camera()

			try {
				const session = startSession(sessionId, { configuration: configurationOf(1, { onFailure: 'pause' }), clock, capturer })
				await waitUntil(() => clock.pending > 0, 5000, 5)

				// The disconnection ends the quarantine (the owed payload can no longer arrive) and the lifecycle owns the
				// camera; the withheld payload is then delivered to nobody.
				rig.managers.camera.disconnect(device)
				await waitUntil(() => !device.connected && !rig.arbiter.snapshot(cameraKey()).causes.includes('quarantine'), 5000, 5)
				payloads.release()
				await clock.advance(1000)

				await waitUntil(() => session.runner.snapshot().state === 'paused', 5000, 5)
				expect(exposures.calls).toHaveLength(1)
				expect(await checkpointOf(sessionId)).toMatchObject({ currentSlot: { attempt: 2, captureFailures: 1 } })
				expect((await journalOf(sessionId)).at(-1)).toMatchObject({ kind: 'deferred', attempt: 2, reason: 'pause' })

				rig.managers.camera.connect(device)
				await waitUntil(() => device.connected && rig.arbiter.availability(cameraKey()) === 'reserved', 5000, 5)
				expect(session.runner.handle.resume()).toBeTrue()

				expect((await session.result).state).toBe('completed')
				expect(exposures.calls).toHaveLength(2)
				expect((await journalOf(sessionId)).filter((entry) => entry.kind === 'committed')).toMatchObject([{ attempt: 2 }])
			} finally {
				exposures.spy.mockRestore()
				if (!device.connected) rig.managers.camera.connect(device)
				await waitUntil(() => device.connected && device.frame.width.max > 0, 5000, 5)
			}
		})
	})

	test('pause and stop during the wait are honored', async () => {
		await withQuarantine(async (capturer) => {
			const clock = new ManualSequencerClock()
			const sessionId = Bun.randomUUIDv7()
			const session = startSession(sessionId, { configuration: RECOVERY, clock, capturer })
			await waitUntil(() => clock.pending > 0, 5000, 5)

			const paused = session.runner.handle.pause()
			await clock.advance(1000)
			expect(await paused).toBe('paused')
			expect(clock.pending).toBe(0)

			expect(session.runner.handle.resume()).toBeTrue()
			await waitUntil(() => clock.pending > 0, 5000, 5)
			expect(await session.runner.handle.stop()).toMatchObject({ state: 'stopped', stopCause: 'user' })
			expect(clock.pending).toBe(0)
			expect(await checkpointOf(sessionId)).toMatchObject({ currentSlot: { attempt: 2, captureFailures: 1 } })
		})
	})
})
