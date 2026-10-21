import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { type PlateSolution, plateSolutionFrom } from '../../../src/astrometry/solvers/platesolver'
import { DEC_TAN, RA_TAN } from '../../../src/astrometry/wcs/fits.wcs'
import { angularDistance, equatorialToJ2000 } from '../../../src/astronomy/coordinates/coordinate'
import { timeUnix } from '../../../src/astronomy/time/time'
import { mountTargetEquatorial } from '../../../src/devices/indi/manager/mount'
import { abortableDelay } from '../../../src/devices/orchestration/operation.wait'
import { type FitsHeader, isFits, readFits } from '../../../src/io/formats/fits/fits'
import { bufferSource } from '../../../src/io/io'
import { type Angle, deg, normalizeAngle, toDeg } from '../../../src/math/units/angle'
import { applyPointingOffset } from '../../../src/observation/mount/pointing'
import { awaitCameraRecoveryTask, captureFrameStep } from '../../../src/observation/sequencer/capture'
import { prepareOpticalPathTask } from '../../../src/observation/sequencer/focus'
import { ensureTrackingTask, type SequencerLifecycleServices, sequencerShutdownLifecycleTasks, sequencerStartupLifecycleTasks } from '../../../src/observation/sequencer/lifecycle'
import { type SequencerPointingServices, sequencerCenteringOptions, sequencerMountCommandOptions, sequencerPointingTasks } from '../../../src/observation/sequencer/pointing'
import { type SequencerRunner, startSequencerRunner } from '../../../src/observation/sequencer/runner'
// oxfmt-ignore
import type { SequencerCameraCapture, SequencerCenteringConfiguration, SequencerClock, SequencerConfiguration, SequencerEvent, SequencerPlateSolver, SequencerPointingConfiguration, SequencerResult, SequencerRotatorConfiguration, SequencerTarget } from '../../../src/observation/sequencer/sequencer'
import { FileSystemSequencerCheckpointStore, FileSystemSequencerStorage, prepareFrameDestinationTask, readSequencerJournal } from '../../../src/observation/sequencer/storage'
import { waitUntil } from '../../util'
// oxfmt-ignore
import { assertJournalInvariants, assertRunnerInvariants, assertSequencerInvariants, connectSequencerRig, createSequencerRig, createTestSequence, type DeviceCommandEntry, type DeviceLogEntry, type DeviceTransitionEntry, expectNoSequencerLeaks, RIG_INITIAL_POINTING, recordDevices, recordRunner, resetSequencerRig, type RunnerLogEntry } from './util'
import type { CameraCaptureStart } from '../../../src/observation/capture/types'

// Pointing tasks of the Sequencer on the INDI simulator rig, with the real commanders, the real CameraCapturer, the
// filesystem storage and the e2e clock (the simulated UTC of the mount as wall time): acquisition and centering
// before the first light, recenter, darks without pointing, field rotation, failures that never expose a light, the
// plate solver as a cooperative collaborator, and the restart that re-acquires. The solver reads the RA/DEC the camera
// simulator stamps into each auxiliary FITS and moves it by a fixed pointing error of the mount, 6′ east.

const LIGHT: SequencerCameraCapture = { exposureTime: 10, exposureTimeUnit: 'millisecond', frameType: 'LIGHT', x: 0, y: 0, width: 64, height: 64, subframe: true, binX: 2, binY: 2, frameFormat: 'MONO', gain: 10, offset: 5, compressed: false }
const DARK: SequencerCameraCapture = { ...LIGHT, frameType: 'DARK' }
const CENTERING: SequencerCenteringConfiguration = { tolerance: deg(1 / 60), maximumAttempts: 3, settle: 0.1, syncMount: false, capture: LIGHT, solveTimeout: 30 }
const POINTING: SequencerPointingConfiguration = { settle: 0.1, centering: CENTERING, onFailure: 'fail' }
// Pointing error of the rig mount: the sky stands 6′ east of what the mount reports.
const POINTING_ERROR = deg(6 / 60)

const rig = await createSequencerRig()
const ROOT = join(rig.capturesDir, 'sessions')
const clock: SequencerClock = { wallNow: () => rig.simulators.mount.utcTime, monotonicNow: () => performance.now(), delay: abortableDelay }
const lifecycle: SequencerLifecycleServices = { mountCommander: rig.commanders.mount, cameraCommander: rig.commanders.camera }

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

// J2000 target 1° north of where the rig points, at the mount clock.
function rigTarget(): SequencerTarget {
	const [rightAscension, declination] = equatorialToJ2000(RIG_INITIAL_POINTING.rightAscension, RIG_INITIAL_POINTING.declination + deg(1), timeUnix(clock.wallNow() / 1000))
	return { frame: 'J2000', rightAscension: normalizeAngle(rightAscension), declination }
}

// Equatorial TAN solution centered on (rightAscension, declination), radians.
function tanSolution(rightAscension: Angle, declination: Angle): PlateSolution {
	const header: FitsHeader = { CTYPE1: RA_TAN, CTYPE2: DEC_TAN, RADESYS: 'ICRS', CRVAL1: toDeg(normalizeAngle(rightAscension)), CRVAL2: toDeg(declination), CRPIX1: 50.5, CRPIX2: 50.5, CD1_1: -1e-3, CD1_2: 0, CD2_1: 0, CD2_2: 1e-3, NAXIS1: 100, NAXIS2: 100 }
	return plateSolutionFrom(header)!
}

// Call of the solver as it saw its frame.
interface SolveCall {
	readonly path: string
	readonly observedAt: number
	readonly fits: boolean
	readonly sequence: number
}

// Solver over the files of the camera simulator, recording each call in the shared sequence of the recorders.
function rigSolver(calls: SolveCall[], next: () => number): SequencerPlateSolver {
	return async (frame) => {
		const bytes = readFileSync(frame.path)
		calls.push({ path: frame.path, observedAt: frame.observedAt, fits: isFits(bytes), sequence: next() })
		const { header } = (await readFits(bufferSource(bytes)))!.hdus[0]
		const sky = applyPointingOffset(deg(header.RA as number), deg(header.DEC as number), POINTING_ERROR, 0)
		return tanSolution(sky.rightAscension, sky.declination)
	}
}

interface SessionOptions {
	readonly sessionId?: string
	readonly solver?: (calls: SolveCall[], next: () => number) => SequencerPlateSolver
	readonly pointing?: Partial<SequencerPointingServices>
	readonly onEvent?: (event: SequencerEvent, runner: SequencerRunner) => void
	// Whether the pre-capture prepares the optical path (wheel) before the pointing.
	readonly opticalPath?: boolean
}

interface Session {
	readonly sessionId: string
	readonly result: SequencerResult
	readonly events: SequencerEvent[]
	readonly devices: DeviceLogEntry[]
	readonly roots: RunnerLogEntry[]
	readonly solves: SolveCall[]
	readonly requests: (CameraCaptureStart & { readonly sequence: number })[]
}

function configurationOf(options: { readonly frames?: readonly SequencerCameraCapture[]; readonly pointing?: SequencerPointingConfiguration; readonly rotator?: SequencerRotatorConfiguration; readonly target?: SequencerTarget; readonly count?: number } = {}): SequencerConfiguration {
	const frames = options.frames ?? [LIGHT]
	return {
		schemaVersion: 1,
		id: 'pointing',
		revision: 1,
		name: 'Pointing',
		target: options.target ?? rigTarget(),
		pointing: options.pointing ?? POINTING,
		...(options.rotator !== undefined && { rotator: options.rotator }),
		capture: { order: 'sequential', groups: frames.map((capture, i) => ({ kind: 'scheduled', id: `G${i}`, enabled: true, capture, count: options.count ?? 1 })), retry: { maxAttempts: 1, delay: 0, backoff: 1, maximumDelay: 0, retryOn: [] }, onFailure: 'fail', cameraRecovery: { onTimeout: 'stop' } },
		startup: { onFailure: 'fail' },
		shutdown: { stepTimeout: 30, totalTimeout: 300, stopTracking: 'required' },
		execution: { compensation: { timeout: 30 } },
	}
}

// Runs one process of a session: startup track mode, the pre-capture `ensureTracking`, camera recovery, pointing
// tasks and frame destination, the real capture, and the tracking off of the shutdown.
async function runSession(configuration: SequencerConfiguration, options: SessionOptions = {}): Promise<Session> {
	const sequence = createTestSequence()
	const devices = recordDevices(rig, clock, sequence)
	const roots = recordRunner(rig.coordinator, sequence)
	const sessionId = options.sessionId ?? Bun.randomUUIDv7()
	const storage = new FileSystemSequencerStorage({ root: ROOT, sessionId, wallNow: clock.wallNow })
	const events: SequencerEvent[] = []
	const solves: SolveCall[] = []
	const requests: Session['requests'][number][] = []
	const start = rig.capturer.start.bind(rig.capturer)
	const spy = spyOn(rig.capturer, 'start').mockImplementation((scope, camera, request, hooks) => {
		requests.push({ ...structuredClone(request), sequence: sequence.next() })
		return start(scope, camera, request, hooks)
	})
	const pointing: SequencerPointingServices = { mountCommander: rig.commanders.mount, cameraCapturer: rig.capturer, plateSolver: (options.solver ?? rigSolver)(solves, sequence.next), storage, rotatorCommander: rig.commanders.rotator, ...options.pointing }
	const phases = {
		startup: sequencerStartupLifecycleTasks(configuration, lifecycle),
		preCapture: [
			ensureTrackingTask(lifecycle, configuration),
			awaitCameraRecoveryTask(rig.arbiter, configuration.capture.cameraRecovery),
			...(options.opticalPath === true ? [prepareOpticalPathTask({ wheelCommander: rig.commanders.wheel })] : []),
			...sequencerPointingTasks(configuration, pointing),
			prepareFrameDestinationTask(storage),
		],
		capture: captureFrameStep({ cameraCapturer: rig.capturer, storage }),
		shutdown: sequencerShutdownLifecycleTasks(configuration.shutdown, lifecycle),
	}
	const { mount, camera, rotator, wheel } = rig.devices()
	const session: { runner?: SequencerRunner } = {}
	const listener = (event: SequencerEvent) => {
		roots.listener(event)
		events.push(event)
		if (session.runner !== undefined) options.onEvent?.(event, session.runner)
	}
	const runner = startSequencerRunner({ configuration, devices: { camera, mount, rotator, wheel }, services: { coordinator: rig.coordinator, storage, checkpointStore: new FileSystemSequencerCheckpointStore(ROOT), clock, listener }, phases })

	try {
		session.runner = runner
		const result = await runner.handle.result
		return { sessionId, result, events, devices: devices.entries, roots: roots.entries, solves, requests }
	} finally {
		spy.mockRestore()
		devices[Symbol.dispose]()
		roots[Symbol.dispose]()
	}
}

function commandsOf(entries: readonly DeviceLogEntry[]) {
	return entries.filter((entry): entry is DeviceCommandEntry => entry.kind === 'command')
}

const is =
	(manager: DeviceCommandEntry['manager'], command: string, ...args: unknown[]) =>
	(entry: DeviceCommandEntry) =>
		entry.manager === manager && entry.command === command && args.every((arg, i) => entry.args[i] === arg)

// Sequence of the events matching, from the shared runner log.
function eventSequences(roots: readonly RunnerLogEntry[], predicate: (event: SequencerEvent) => boolean) {
	return roots.filter((entry) => entry.kind === 'event' && predicate(entry.event)).map((entry) => entry.sequence)
}

// Every oracle of the session.
async function assertOracles(session: Session) {
	assertSequencerInvariants(session.devices)
	assertRunnerInvariants(session.roots)
	assertJournalInvariants(await readSequencerJournal(join(ROOT, session.sessionId, 'journal.jsonl')), session.events)
}

function auxiliaryFiles(sessionId: string) {
	const directory = join(ROOT, sessionId, 'auxiliary', 'centering')
	return existsSync(directory) ? readdirSync(directory) : []
}

describe('acquisition', () => {
	test('the first light is exposed only after the target was slewed to, tracked and verified by a solve; the second does not point again', async () => {
		const target = rigTarget()
		const session = await runSession(configurationOf({ target, count: 2 }))
		const { result, devices, roots, solves, requests, events } = session
		expect(result).toMatchObject({ state: 'completed' })

		const commands = commandsOf(devices)
		const goTos = commands.filter(is('mount', 'goTo'))
		// The acquisition slew and one correction of the 6′ error.
		expect(goTos).toHaveLength(2)

		// I32: the acquisition converts the J2000 target at the wall instant of the session clock.
		const [ra, dec] = goTos[0].args as [Angle, Angle]
		const expected = mountTargetEquatorial(rig.devices().mount, { type: 'J2000', J2000: { x: target.rightAscension, y: target.declination } }, timeUnix(goTos[0].wallNow / 1000))
		expect(angularDistance(ra, dec, expected[0], expected[1])).toBeLessThan(deg(0.1 / 3600))

		// I45: every capture of the session is one FITS frame; the auxiliary ones go to auxiliary/centering.
		expect(requests.every((request) => request.transferFormat === 'FITS' && request.exposureMode === 'single' && request.count === 1)).toBeTrue()
		const auxiliary = requests.filter((request) => request.outputPath?.endsWith(join('auxiliary', 'centering')))
		expect(auxiliary).toHaveLength(2)
		expect(solves).toHaveLength(2)
		expect(solves.every((solve) => solve.fits)).toBeTrue()

		// I67: the last tracking state observed before each centering capture is on.
		for (const request of auxiliary) {
			const tracking = devices.findLast((entry) => entry.kind === 'transition' && entry.property === 'tracking' && entry.sequence < request.sequence)
			expect(tracking).toMatchObject({ value: true })
		}

		// The first primary exposure comes after the solve that verified the target; the second light never points.
		const [exposure] = eventSequences(roots, (event) => event.type === 'exposureStarted')
		expect(solves[1].sequence).toBeLessThan(exposure)
		expect(events.filter((event) => event.type === 'taskStarted' && event.task === 'acquireOrRecenterTarget')).toHaveLength(1)
		expect(events.filter((event) => event.type === 'exposureStarted')).toHaveLength(2)

		// The recenter anchor and the cleared intent are persisted.
		const checkpoint = await new FileSystemSequencerCheckpointStore(ROOT).load(session.sessionId)
		expect(checkpoint!.anchors.recenter.lastSuccessfulAt).toBeGreaterThan(0)
		expect(checkpoint!.intents.recenter).toBeFalse()
		expect(auxiliaryFiles(session.sessionId)).toEqual([])
		await assertOracles(session)
	}, 60000)

	test('darks never point; a target that cannot be verified never exposes a light', async () => {
		const unsolved = () => () => Promise.resolve(undefined)
		const session = await runSession(configurationOf({ frames: [DARK, LIGHT], pointing: { ...POINTING, centering: { ...CENTERING, maximumAttempts: 2 } } }), { solver: unsolved })
		const { result, devices, events, requests } = session

		expect(result).toMatchObject({ state: 'failed', failure: { kind: 'operation', reason: 'commandFailed', task: 'acquireOrRecenterTarget' } })
		// The dark was exposed without any pointing before it; the light never.
		const exposures = events.filter((event) => event.type === 'exposureStarted')
		expect(exposures).toHaveLength(1)
		expect(exposures[0]).toMatchObject({ slot: 'frame[G0][1]' })
		const firstGoTo = commandsOf(devices).find(is('mount', 'goTo'))!
		const darkRequest = requests.find((request) => request.frameType === 'DARK')!
		expect(firstGoTo.sequence).toBeGreaterThan(darkRequest.sequence)
		// Two auxiliary frames without solution, no corrective slew, nothing left behind.
		expect(requests.filter((request) => request.outputPath?.endsWith(join('auxiliary', 'centering')))).toHaveLength(2)
		expect(commandsOf(devices).filter(is('mount', 'goTo'))).toHaveLength(1)
		expect(auxiliaryFiles(session.sessionId)).toEqual([])
		await assertOracles(session)
	}, 60000)

	test('without an auxiliary namespace the centering fails as configuration before the mount moves', async () => {
		const session = await runSession(configurationOf(), { pointing: { storage: {} } })

		expect(session.result).toMatchObject({ state: 'failed', failure: { kind: 'configuration', detail: expect.stringContaining('auxiliary namespace') } })
		expect(commandsOf(session.devices).some(is('mount', 'goTo'))).toBeFalse()
		expect(session.events.some((event) => event.type === 'exposureStarted')).toBeFalse()
		await assertOracles(session)
	}, 60000)

	test('a restart never trusts the acquired target: the next process acquires again', async () => {
		const configuration = configurationOf({ count: 2 })
		const first = await runSession(configuration, {
			onEvent: (event, runner) => {
				if (event.type === 'frameAccepted') void runner.handle.stop('graceful')
			},
		})
		expect(first.result).toMatchObject({ state: 'stopped' })
		expect(first.events.filter((event) => event.type === 'frameAccepted')).toHaveLength(1)

		const second = await runSession(configuration, { sessionId: first.sessionId })
		expect(second.result).toMatchObject({ state: 'completed' })
		expect(second.events.filter((event) => event.type === 'taskCompleted' && event.task === 'acquireOrRecenterTarget')).toHaveLength(1)
		// The slew and the solves run again although the mount still points where the first process left it.
		expect(commandsOf(second.devices).some(is('mount', 'goTo'))).toBeTrue()
		expect(second.solves.length).toBeGreaterThanOrEqual(1)
		expect(second.solves[0].sequence).toBeLessThan(eventSequences(second.roots, (event) => event.type === 'exposureStarted')[0])
		expect(second.result.capture.groups[0]).toMatchObject({ accepted: 2 })
		await assertOracles(second)
	}, 90000)
})

describe('recenter', () => {
	test('afterFrames recenters by centering only, without an initial slew', async () => {
		const session = await runSession(configurationOf({ count: 2, pointing: { ...POINTING, recenter: { afterFrames: 1 } } }))
		const { result, events, devices, solves } = session

		expect(result).toMatchObject({ state: 'completed' })
		expect(events.filter((event) => event.type === 'taskCompleted' && event.task === 'acquireOrRecenterTarget')).toHaveLength(2)
		// Acquisition slew and its correction; the recenter found the target within tolerance on its first solve.
		expect(commandsOf(devices).filter(is('mount', 'goTo'))).toHaveLength(2)
		expect(solves).toHaveLength(3)

		const checkpoint = await new FileSystemSequencerCheckpointStore(ROOT).load(session.sessionId)
		expect(checkpoint!.anchors.recenter.lightExposures).toBe(1)
		await assertOracles(session)
	}, 60000)
})

describe('calibration', () => {
	test('50.3 19: after a dark of an opaque filter the recenter of the next light captures through the filter of the light', async () => {
		const base = configurationOf({ count: 2, pointing: { ...POINTING, recenter: { afterFrames: 1 } } })
		const groups: SequencerConfiguration['capture']['groups'] = [
			{ ...base.capture.groups[0], filter: { kind: 'name', name: 'R' } },
			{ kind: 'triggered', id: 'D', enabled: true, capture: DARK, trigger: { kind: 'afterFrames', frames: 1 }, batchSize: 1, maxFrames: 1, inherit: 'none', opticalPath: { kind: 'filter', filter: { kind: 'name', name: 'Dark' } } },
		]
		const configuration: SequencerConfiguration = { ...base, capture: { ...base.capture, groups } }
		const session = await runSession(configuration, { opticalPath: true })
		const { result, events, devices, requests } = session

		expect(result).toMatchObject({ state: 'completed' })
		expect(events.flatMap((event) => (event.type === 'frameSelected' ? [event.frame.id] : []))).toEqual(['frame[G0][1]', 'frame[D][1]', 'frame[G0][2]'])
		expect(events.filter((event) => event.type === 'taskCompleted' && event.task === 'acquireOrRecenterTarget')).toHaveLength(2)

		// The dark went through the Dark slot; every centering capture, the recenter after it included, through R.
		const wheelAt = (sequence: number) => devices.findLast((entry): entry is DeviceTransitionEntry => entry.kind === 'transition' && entry.manager === 'wheel' && entry.property === 'position' && entry.sequence < sequence)?.value
		const auxiliary = requests.filter((request) => request.outputPath?.endsWith(join('auxiliary', 'centering')))
		const dark = requests.find((request) => request.frameType === 'DARK')!
		expect(wheelAt(dark.sequence)).toBe(7)
		expect(auxiliary.filter((request) => request.sequence > dark.sequence).length).toBeGreaterThan(0)
		for (const request of auxiliary) expect(wheelAt(request.sequence)).toBe(1)

		assertSequencerInvariants(devices, { opaqueSlots: [7] })
		await assertOracles(session)
	}, 60000)
})

describe('rotation', () => {
	test('lights rotate the field once to the configured angle; darks never do', async () => {
		const rotator: SequencerRotatorConfiguration = { angle: deg(30), tolerance: deg(0.5), settle: 0.1, onFailure: 'fail' }
		const { rotator: device } = rig.devices()
		expect(await rig.commanders.rotator.moveTo(rig.coordinator, device, 0)).toMatchObject({ ok: true })

		const session = await runSession(configurationOf({ frames: [DARK, LIGHT], count: 2, rotator, pointing: { settle: 0.1, onFailure: 'fail' } }))
		const { result, devices, events, requests } = session

		expect(result).toMatchObject({ state: 'completed' })
		const rotations = commandsOf(devices).filter(is('rotator', 'moveTo'))
		expect(rotations).toHaveLength(1)
		expect(rotations[0].args[0]).toBeCloseTo(30, 9)
		// Both darks were exposed before the rotation, the lights after it.
		const darks = requests.filter((request) => request.frameType === 'DARK')
		expect(darks.every((request) => request.sequence < rotations[0].sequence)).toBeTrue()
		expect(events.filter((event) => event.type === 'taskCompleted' && event.task === 'rotateField')).toHaveLength(1)
		expect(device.angle.value).toBeCloseTo(30, 1)
		await assertOracles(session)
	}, 60000)
})

describe('plate solver', () => {
	test('a solve that ignores its signal is reported unresponsive once, ends the centering by timeout and faults the solver', async () => {
		const snapshots: (string | undefined)[] = []
		let release: VoidFunction | undefined
		const stubborn = () => () =>
			new Promise<PlateSolution | undefined>((resolve) => {
				release = () => resolve(undefined)
			})
		const pointing: SequencerPointingConfiguration = { ...POINTING, centering: { ...CENTERING, solveTimeout: 0.2, abortGrace: 0.3 } }
		const session = await runSession(configurationOf({ pointing }), {
			solver: stubborn,
			onEvent: (event, runner) => {
				if (event.type !== 'collaboratorUnresponsive') return
				snapshots.push(runner.handle.snapshot().waitingFor)
				void waitUntil(() => release !== undefined, 5000, 10).then(() => release!())
			},
		})

		expect(session.result).toMatchObject({ state: 'failed', failure: { kind: 'operation', reason: 'timeout', task: 'acquireOrRecenterTarget' } })
		expect(session.events.filter((event) => event.type === 'collaboratorUnresponsive')).toEqual([expect.objectContaining({ service: 'solve', slot: 'frame[G0][1]', attempt: 1 })])
		expect(snapshots).toEqual(['plateSolver'])
		expect(auxiliaryFiles(session.sessionId)).toEqual([])
		await assertOracles(session)
	}, 60000)
})

describe('options', () => {
	test('centering options take the configured bounds, the default grace and disposition, and the supervised settle', () => {
		const flip = { enabled: true, prepareAt: deg(-5), flipAt: 0, latestAt: deg(5), beforeFlipPierSide: 'EAST', afterFlipPierSide: 'WEST', hardProtection: { mountStopTimeout: 7 } } as const
		expect(sequencerMountCommandOptions({})).toEqual({})
		expect(sequencerMountCommandOptions({ meridianFlip: { ...flip, enabled: false } })).toEqual({})
		expect(sequencerMountCommandOptions({ meridianFlip: flip })).toEqual({ settleTimeout: 7000 })
		expect(sequencerMountCommandOptions({ meridianFlip: { ...flip, hardProtection: {} } })).toEqual({ settleTimeout: 10000 })
		expect(sequencerCenteringOptions(CENTERING, { meridianFlip: flip })).toEqual({ ...CENTERING, abortGrace: 5, auxiliary: 'delete', slew: { settleTimeout: 7000 } })
	})
})
