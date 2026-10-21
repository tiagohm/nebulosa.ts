import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import { writeFileSync } from 'fs'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { equatorialToJ2000 } from '../../../src/astronomy/coordinates/coordinate'
import { localSiderealTime } from '../../../src/astronomy/observer/location'
import { type Time, timeUnix } from '../../../src/astronomy/time/time'
import { SIDEREAL_DRIFT_RATE } from '../../../src/core/constants'
import type { MountCommander, MountCommandOptions, MountFlipResult } from '../../../src/devices/commanders/mount'
import { type Camera, DEFAULT_CAMERA, DEFAULT_MOUNT, type Mount, type MountTargetCoordinate, type PierSide, type TrackMode } from '../../../src/devices/indi/device'
import { mountTargetEquatorial } from '../../../src/devices/indi/manager/mount'
import { failedOperationResult, type OperationContext, OperationCoordinator, type OperationResult, type OperationScope, successfulOperationResult } from '../../../src/devices/orchestration/operation'
import { ResourceArbiter } from '../../../src/devices/orchestration/resource'
import { mulberry32 } from '../../../src/math/numerical/random'
import { type Angle, deg, normalizeAngle, normalizePI } from '../../../src/math/units/angle'
import { ensureGuidingTask, sequencerShutdownTasks } from '../../../src/observation/sequencer/guiding'
import { ensureTrackingTask, stopTrackingTask } from '../../../src/observation/sequencer/lifecycle'
import { meridianHardProtectionLead, meridianProtectionDeadline, mountTrackingProtectionTimings, type SequencerMeridianSupervisor, sequencerExposureRefusal, sequencerMeridianFlipSettings, sequencerMeridianGuard, sequencerMeridianSupervisor, sequencerPointingTasks } from '../../../src/observation/sequencer/pointing'
// oxfmt-ignore
import { type SequencerCaptureStep, type SequencerProtectionOutcome, type SequencerRunner, type SequencerSupervisorHost, type SequencerTask, startSequencerRunner } from '../../../src/observation/sequencer/runner'
// oxfmt-ignore
import type { SequencerCameraCapture, SequencerCheckpoint, SequencerCheckpointStore, SequencerConfiguration, SequencerEvent, SequencerEventBody, SequencerFailure, SequencerMeridianFlipConfiguration, SequencerResult, SequencerTarget } from '../../../src/observation/sequencer/sequencer'
import { createSequencerRuntimeState, SEQUENCER_MERIDIAN_HALF_CYCLE, type SequencerRuntimeState, sequencerCheckpointOf } from '../../../src/observation/sequencer/state'
import { FileSystemSequencerCheckpointStore, FileSystemSequencerStorage, parseSequencerCheckpoint, prepareFrameDestinationTask, readSequencerJournal } from '../../../src/observation/sequencer/storage'
import { isTimeConsumingTestSkipped, waitUntil } from '../../util'
import { ManualClock } from '../../util/rig'
import { assertMeridianProtectionInvariants, guidingEntries, type MeridianRunnerEntry, runtimeEntries } from './meridian.util'
import { FakeMount, type FlipBehaviour, nextFakeOrder, recordRunner, ScriptedGuidingSession } from './util'

// Meridian supervision and flip driver of the Sequencer over a fake mount and the manual clock: the deadlines and wakes
// of the supervisor (49.12 33–37, 7c), the hard path and its outcomes (79–85, 112, 116–118), the cycle (113), the
// durable flip budget across processes (49.12 5–12), the pier side (108–111), the flip destination (115), the mount off
// its target (94) and the pause across the meridian (49.5 5). The fake mount reports the hour angle it was placed at
// for the current wall instant, tracking at the sidereal rate, so its hour angle advances with the clock exactly as the
// supervisor computes it; it leases itself for every command like the real commander.

// Sessions start on the 2031 March equinox, far from the host clock.
const START = Date.UTC(2031, 2, 20, 0, 0, 0)
const SECOND = SIDEREAL_DRIFT_RATE
const DARK: SequencerCameraCapture = { exposureTime: 10, exposureTimeUnit: 'second', frameType: 'DARK', x: 0, y: 0, width: 0, height: 0, subframe: false, binX: 1, binY: 1, frameFormat: '', gain: 0, offset: 0, compressed: false }
const LIGHT: SequencerCameraCapture = { ...DARK, frameType: 'LIGHT' }
const CAMERA: Camera = { ...DEFAULT_CAMERA, id: 'Camera', name: 'Camera', hardwareId: 'Camera', connected: true }
const FRAME = Buffer.from('SIMPLE  =                    T')
// Hard protection timeouts: lead = 1 s jitter + 1 s mount motion + 1 s tracking.
const HARD = { mountStopTimeout: 1, guidingStopTimeout: 1, trackingTimeout: 1 } as const
const LEAD = 3000
const LATEST_AT = deg(5)

const ROOT = await mkdtemp(join(tmpdir(), 'nebulosa-sequencer-supervisor-'))

afterAll(async () => {
	await rm(ROOT, { recursive: true, force: true })
})

// Lets every pending continuation run.
async function flush() {
	for (let i = 0; i < 10; i++) {
		await new Promise((resolve) => {
			setImmediate(resolve)
		})
	}
}

// Meridian flip from WEST to EAST: flipAt 0, latestAt 5°, with the given overrides.
function flipOf(patch: Partial<SequencerMeridianFlipConfiguration> = {}): SequencerMeridianFlipConfiguration {
	return { enabled: true, prepareAt: -deg(5), flipAt: 0, latestAt: LATEST_AT, beforeFlipPierSide: 'WEST', afterFlipPierSide: 'EAST', protectionMargin: 120, supervisionInterval: 300, exposureMargin: 30, maxRetries: 1, hardProtection: HARD, onFailure: 'stop', ...patch }
}

function configurationOf(meridianFlip: SequencerMeridianFlipConfiguration, patch: Partial<SequencerConfiguration> = {}, frame: SequencerCameraCapture = DARK, count = 1): SequencerConfiguration {
	return {
		schemaVersion: 1,
		id: 'supervisor',
		revision: 1,
		name: 'Supervisor',
		meridianFlip,
		capture: { order: 'sequential', groups: [{ kind: 'scheduled', id: 'F', enabled: true, capture: frame, count }], retry: { maxAttempts: 1, delay: 0, backoff: 1, maximumDelay: 0, retryOn: [] }, onFailure: 'fail', cameraRecovery: { onTimeout: 'stop' } },
		startup: { onFailure: 'fail' },
		shutdown: { stepTimeout: 5, totalTimeout: 60, stopTracking: 'required' },
		execution: { compensation: { timeout: 5 } },
		...patch,
	}
}

// Hour angle at which the hard deadline (latestAt − lead) is `seconds` away.
function hardIn(seconds: number) {
	return LATEST_AT - (LEAD / 1000 + seconds) * SECOND
}

// Hour angle at which the graceful deadline (latestAt − protectionMargin) is `seconds` away.
function gracefulIn(seconds: number, margin = 120) {
	return LATEST_AT - (margin + seconds) * SECOND
}

// One supervisor under a fake host: the runtime state, the events, the protection requests (by task id), the session
// failures, the critical protections with their outcomes and every delay the supervisor asked the clock for.
interface Supervised {
	readonly fake: FakeMount
	readonly clock: ManualClock
	readonly runtime: SequencerRuntimeState
	readonly supervisor: SequencerMeridianSupervisor
	readonly events: SequencerEventBody[]
	readonly requests: string[]
	readonly failures: SequencerFailure[]
	readonly outcomes: SequencerProtectionOutcome[]
	readonly delays: number[]
	readonly motionOwners: Map<string, { readonly task: 'meridianFlip'; readonly keys: readonly string[] }>
	// Meridian oracle over the log of the fake mount and of the fake host.
	readonly oracle: (endAt?: number) => void
}

interface SuperviseOptions {
	readonly flip?: Partial<SequencerMeridianFlipConfiguration>
	readonly tracking?: boolean
	readonly pierSide?: PierSide
	readonly trackMode?: TrackMode
	readonly target?: (fake: FakeMount) => SequencerTarget
	readonly prepare?: (runtime: SequencerRuntimeState, fake: FakeMount) => void
	// Added to the monotonic instants the supervisor reads.
	readonly skew?: { value: number }
	// Whether the host accepts graceful requests; default true.
	readonly accept?: boolean
}

const supervised: Supervised[] = []

afterEach(() => {
	for (const { supervisor } of supervised.splice(0)) supervisor.disarm()
})

// Arms a supervisor at the hour angle `hourAngle` over a fake host.
function supervise(hourAngle: Angle, options: SuperviseOptions = {}): Supervised {
	const clock = new ManualClock(START)
	const fake = new FakeMount(clock, hourAngle, { tracking: options.tracking ?? true, pierSide: options.pierSide ?? 'WEST', trackMode: options.trackMode ?? 'SIDEREAL' })
	const configuration = configurationOf(flipOf(options.flip), options.target === undefined ? {} : { target: options.target(fake) })
	const runtime = createSequencerRuntimeState(configuration, clock.wallNow())
	options.prepare?.(runtime, fake)

	const delays: number[] = []
	const skew = options.skew
	const sessionClock = { wallNow: clock.wallNow, monotonicNow: () => clock.monotonicNow() + (skew?.value ?? 0), delay: (ms: number, signal: AbortSignal) => (delays.push(ms), clock.delay(ms, signal)) }
	const devices = { camera: CAMERA, mount: fake.mount }
	const coordinator = new OperationCoordinator(new ResourceArbiter())
	const events: SequencerEventBody[] = []
	const requests: string[] = []
	const failures: SequencerFailure[] = []
	const outcomes: SequencerProtectionOutcome[] = []
	const motionOwners = new Map<string, { readonly task: 'meridianFlip'; readonly keys: readonly string[] }>()
	// The host reports like the runner: its events and the roots of its critical protections.
	const log: MeridianRunnerEntry[] = []
	let roots = 0
	const root = (event: 'start' | 'end', id: string, operation: string) => log.push({ kind: 'root', sequence: fake.sequence.next(), runtime: 'session', wallNow: clock.wallNow(), event, id, operation })

	const host: SequencerSupervisorHost = {
		view: () => ({ sessionId: 'session', configuration, devices, clock: sessionClock, state: runtime }),
		emit: (event) => {
			events.push(event)
			log.push({ kind: 'event', sequence: fake.sequence.next(), runtime: 'session', wallNow: clock.wallNow(), event: { ...event, sessionId: 'session', at: clock.wallNow() } })
		},
		requestProtection: (action: SequencerTask) => {
			requests.push(action.id)
			if (options.accept === false) return false
			runtime.meridianProtection = 'requested'
			return true
		},
		protectCritically: async (kind, protect) => {
			const id = `${kind}#${++roots}`
			root('start', id, kind)
			const result = await coordinator.start(kind, [], protect).result
			root('end', id, kind)
			const outcome: SequencerProtectionOutcome = result.ok ? result.value : { ok: false, failure: { kind: 'operation', reason: result.reason }, action: 'fail' }
			outcomes.push(outcome)
			return outcome
		},
		fail: (failure) => failures.push(failure),
		motionOwners,
		coordinator,
	}

	const supervisor = sequencerMeridianSupervisor(configuration, devices, { mountCommander: fake.commander, mountUpdates: fake.updates })!
	const oracle = (endAt?: number) => assertOracle(fake, configuration, [log], endAt === undefined ? {} : { endAt })
	const result: Supervised = { fake, clock, runtime, supervisor, events, requests, failures, outcomes, delays, motionOwners, oracle }
	supervised.push(result)
	supervisor.arm(host)
	return result
}

// Meridian oracle over the device log of `fake` and the runner entries of every process (or fake host) of the session,
// from the state of the fake when it was created; `endAt` defaults to the wall instant of its clock.
function assertOracle(fake: FakeMount, configuration: SequencerConfiguration, runners: readonly (readonly MeridianRunnerEntry[])[], options: { readonly guiding?: ScriptedGuidingSession; readonly endAt?: number } = {}) {
	const log = [...fake.entries, ...runners.flat(), ...guidingEntries(options.guiding?.log ?? [])]
	const lead = meridianHardProtectionLead(mountTrackingProtectionTimings(configuration, { mount: fake.mount }, options.guiding === undefined ? {} : { guiding: options.guiding }))
	const target = configuration.target !== undefined
	assertMeridianProtectionInvariants(log, { mount: fake.mount.name, flip: sequencerMeridianFlipSettings(configuration.meridianFlip!), lead, initial: fake.initial, lightsTracked: target, standsWithoutTracking: false, endAt: options.endAt ?? fake.clock.wallNow() })
}

function typesOf(events: readonly SequencerEventBody[]) {
	return events.map((event) => event.type)
}

describe('supervisor deadlines and wakes', () => {
	test('37: a hard deadline 20 s away with a 300 s interval is one delay of 20 s, and the protection runs at that wake', async () => {
		// Already past the graceful deadline (requested at the arming), the hard one 20 s away.
		const s = supervise(hardIn(20))
		expect(s.supervisor.lead.lead).toBe(LEAD)
		expect(s.requests).toEqual(['protectMeridianDuringStartup'])
		expect(s.delays).toHaveLength(1)
		expect(s.delays[0]).toBeCloseTo(20000, 3)

		await s.clock.advance(s.delays[0] - 1)
		await flush()
		expect(s.outcomes).toHaveLength(0)
		await s.clock.advance(1)
		await flush()

		expect(s.outcomes).toEqual([{ ok: true }])
		expect(s.fake.of('tracking').map((entry) => entry.args[0])).toEqual([false])
		const hard = s.events.find((event) => event.type === 'meridianHardProtection')
		expect(hard).toMatchObject({ late: false, latestAt: LATEST_AT, leadMs: LEAD })
		expect((hard as { hourAngle: Angle }).hourAngle).toBeLessThan(LATEST_AT)
		// The tracking off was commanded with the hard-protection tracking timeout.
		expect(s.fake.of('tracking')[0].args[1]).toEqual({ timeout: 1000 })
		// No risk left: only the cycle wake, capped by the interval.
		expect(s.delays.at(-1)).toBe(300000)
		s.oracle()
	})

	test.skipIf(isTimeConsumingTestSkipped())('37: a wake 1 ms early asks for one more delay of 1 ms, without a loop', async () => {
		const s = supervise(hardIn(20))
		s.clock.jumpWall(-1)
		await s.clock.advance(s.delays[0])
		await flush()

		expect(s.outcomes).toHaveLength(0)
		expect(s.delays.at(-1)).toBeCloseTo(1, 2)
		await s.clock.advance(s.delays.at(-1)!)
		await flush()
		expect(s.outcomes).toEqual([{ ok: true }])
		s.oracle()
	})

	test('37: a wake later than the jitter allowance is reported, and protects at once', async () => {
		const skew = { value: 0 }
		const s = supervise(hardIn(20), { skew })
		skew.value = 2500
		await s.clock.advance(s.delays[0])
		await flush()

		expect(s.events.find((event) => event.type === 'supervisionLate')).toEqual({ type: 'supervisionLate', lateMs: 2500 })
		// The epoch was armed with the whole lead: a lost deadline is not a late start.
		expect(typesOf(s.events)).not.toContain('meridianProtectionLateStart')
		s.oracle()
	})

	test.skipIf(isTimeConsumingTestSkipped())('7c: a wall step forward is caught at the next re-evaluation, a step backward postpones without a negative wait', async () => {
		const forward = supervise(gracefulIn(600), { flip: { supervisionInterval: 60 } })
		expect(forward.delays).toEqual([60000])
		forward.clock.jumpWall(9.5 * 60000)
		await forward.clock.advance(60000)
		await flush()
		expect(forward.requests).toEqual(['protectMeridianDuringStartup'])

		const backward = supervise(gracefulIn(600), { flip: { supervisionInterval: 60 } })
		backward.clock.jumpWall(-30 * 60000)
		await backward.clock.advance(60000)
		await flush()
		expect(backward.requests).toEqual([])
		expect(backward.delays.every((delay) => delay >= 0 && delay <= 60000)).toBeTrue()
		expect(backward.clock.pending).toBe(1)
		forward.oracle()
		backward.oracle()
	})

	test('a graceful deadline asks for the action of the state: the whilePaused one in the hold, the flip while running', () => {
		const paused = supervise(gracefulIn(-1), { prepare: (runtime) => Object.assign(runtime, { state: 'paused', phase: 'preCapture' }) })
		expect(paused.requests).toEqual(['protectMeridianWhilePaused'])

		// whilePaused 'flip' only when the flip is due by the decision hour angle (flipAt 0 < graceful deadline).
		const flipping = supervise(gracefulIn(-1), { flip: { whilePaused: 'flip' }, prepare: (runtime) => Object.assign(runtime, { state: 'paused', phase: 'preCapture' }) })
		expect(flipping.requests).toEqual(['meridianFlip'])

		const notDue = supervise(gracefulIn(-1), { flip: { whilePaused: 'flip', flipAt: gracefulIn(-1) + SECOND, latestAt: LATEST_AT }, prepare: (runtime) => Object.assign(runtime, { state: 'paused', phase: 'preCapture' }) })
		expect(notDue.requests).toEqual(['protectMeridianWhilePaused'])

		const running = supervise(gracefulIn(-1), { prepare: (runtime) => Object.assign(runtime, { state: 'running', phase: 'preCapture' }) })
		expect(running.requests).toEqual(['meridianFlip'])
	})

	test.skipIf(isTimeConsumingTestSkipped())('no deadline without risk: tracking off, post-flip side; a tracking turned on again re-arms', async () => {
		const off = supervise(gracefulIn(-1), { tracking: false })
		const post = supervise(gracefulIn(-1), { pierSide: 'EAST' })
		expect([...off.requests, ...post.requests]).toEqual([])
		expect([...off.outcomes, ...post.outcomes]).toEqual([])

		// Six hours later with tracking still off: nothing; then a third party turns tracking on past latestAt.
		await off.clock.advance(6 * 3600000)
		await flush()
		expect(off.requests).toEqual([])
		expect(off.fake.commands).toEqual([])
		off.fake.set({ tracking: true })
		await flush()
		expect(typesOf(off.events)).toContain('meridianProtectionLateStart')
		expect(off.outcomes).toEqual([expect.objectContaining({ ok: false })])
		expect(off.events.find((event) => event.type === 'meridianProtectionFailed')).toMatchObject({ reason: 'lateStart', lateStart: true })
		// Tracking turned on by a third party is an arming transition: the late start is accepted (I18 a).
		off.oracle()
		post.oracle()
	})
})

describe('hard path outcomes', () => {
	test.skipIf(isTimeConsumingTestSkipped())('late arming: the event before any command, the hard path in the same tick, late: true when off before latestAt', async () => {
		const s = supervise(hardIn(-1))
		expect(s.events[0]).toMatchObject({ type: 'meridianProtectionLateStart', requiredLeadMs: LEAD })
		expect((s.events[0] as { remainingMs: number }).remainingMs).toBeCloseTo(LEAD - 1000, 3)
		await flush()
		expect(s.outcomes).toEqual([{ ok: true }])
		expect(s.events.find((event) => event.type === 'meridianHardProtection')).toMatchObject({ late: true })
		s.oracle()
	})

	test.skipIf(isTimeConsumingTestSkipped())('83: an epoch born outside SIDEREAL is late; one born in SIDEREAL stays normal when the mode changes', async () => {
		const lunar = supervise(gracefulIn(3600), { trackMode: 'LUNAR' })
		await flush()
		expect(lunar.events[0]).toMatchObject({ type: 'meridianProtectionTrackModeUnsupervisable', trackMode: 'LUNAR' })
		expect(lunar.events.find((event) => event.type === 'meridianHardProtection')).toMatchObject({ late: true })

		const sidereal = supervise(gracefulIn(3600))
		sidereal.fake.set({ trackMode: 'LUNAR' })
		await flush()
		expect(sidereal.events.find((event) => event.type === 'meridianHardProtection')).toMatchObject({ late: false })
		lunar.oracle()
		sidereal.oracle()
	})

	test('85: under CUSTOM, a tracking off at or past latestAt is trackRateUnknown', async () => {
		const s = supervise(LATEST_AT + deg(0.1), { trackMode: 'CUSTOM' })
		await flush()
		expect(s.events.find((event) => event.type === 'meridianProtectionFailed')).toMatchObject({ reason: 'trackRateUnknown' })
		expect(s.outcomes).toEqual([expect.objectContaining({ ok: false, action: 'stop' })])
		// Tracked past latestAt, reported as trackRateUnknown under CUSTOM (I18 b).
		s.oracle()
	})

	test.skipIf(isTimeConsumingTestSkipped())('84: a failed tracking off is reported with the failure action; the supervisor stays armed and never protects twice in the epoch', async () => {
		const s = supervise(hardIn(5))
		s.fake.trackingFailure = failedOperationResult('timeout')
		await s.clock.advance(s.delays[0])
		await flush()

		expect(s.events.find((event) => event.type === 'meridianProtectionFailed')).toMatchObject({ reason: 'trackingNotStopped', lateStart: false })
		expect(s.outcomes).toEqual([{ ok: false, failure: { kind: 'operation', reason: 'unexpectedState', detail: 'meridian protection failed: trackingNotStopped' }, action: 'stop' }])
		await s.clock.advance(60000)
		await flush()
		expect(s.outcomes).toHaveLength(1)
		expect(s.clock.pending).toBe(1)
		// The mount kept tracking past latestAt: a failed protection is never an accepted crossing.
		expect(() => s.oracle()).toThrow(/^I18/)
	})

	test.skipIf(isTimeConsumingTestSkipped())('112: telemetry withdrawn from a tracking pre-flip mount starts the hard path in the same tick', async () => {
		const s = supervise(gracefulIn(3600))
		s.fake.set({ hasEquatorialCoordinate: false })
		await flush()
		expect(s.events[0]).toEqual({ type: 'meridianProtectionTelemetryUnobserved', missing: ['equatorialCoordinate'] })
		expect(s.outcomes).toEqual([{ ok: true }])
		expect(s.fake.mount.tracking).toBeFalse()
		// Without telemetry the outcome reports the last observed hour angle, aged to the tracking off, never latestAt.
		const hard = s.events.find((event) => event.type === 'meridianHardProtection') as { hourAngle: Angle }
		expect(hard.hourAngle).toBeCloseTo(s.fake.hourAngle(), 9)
		s.oracle()
	})

	test('81: motion nobody of the run owns invalidates the target, and at the deadline is stopped at once: externalMotion', async () => {
		const s = supervise(hardIn(10), { prepare: (runtime) => (runtime.targetAcquired = true) })
		s.fake.set({ slewing: true })
		await flush()
		expect(s.runtime.targetAcquired).toBeFalse()

		await s.clock.advance(s.delays.at(-1)!)
		await flush()
		const stop = s.fake.of('stop')
		expect(stop).toHaveLength(1)
		expect(stop[0].args[0]).toEqual({ settleTimeout: 1000 })
		expect(stop[0].order).toBeLessThan(s.fake.of('tracking')[0].order)
		expect(s.events.find((event) => event.type === 'meridianProtectionFailed')).toMatchObject({ reason: 'externalMotion' })
		s.oracle()
	})

	test.skipIf(isTimeConsumingTestSkipped())('93: a slew nobody of the run owns invalidates the acquired target and recomputes the deadlines at its end', async () => {
		const s = supervise(gracefulIn(600), { prepare: (runtime) => (runtime.targetAcquired = true) })
		expect(s.delays.at(-1)).toBe(300000)

		// The slew brings the mount 60 s from its graceful deadline.
		s.fake.set({ slewing: true })
		await flush()
		s.fake.place(gracefulIn(60))
		s.fake.set({ slewing: false })
		await flush()

		expect(s.runtime.targetAcquired).toBeFalse()
		expect(s.delays.at(-1)).toBeCloseTo(60000, 3)
		expect(s.requests).toEqual([])
		s.oracle()
	})

	test.skipIf(isTimeConsumingTestSkipped())('116: within an epoch the reported hour angle crossing ±180° never brings a lost deadline back', async () => {
		const s = supervise(hardIn(5))
		s.fake.trackingFailure = failedOperationResult('timeout')
		await s.clock.advance(s.delays[0])
		await flush()
		expect(s.outcomes).toHaveLength(1)

		s.fake.place(deg(179))
		await flush()
		s.fake.place(-deg(179))
		await flush()
		expect(s.outcomes).toHaveLength(1)
		expect(typesOf(s.events)).not.toContain('meridianProtectionLateStart')
		expect(s.runtime.mountRiskObservation).toMatchObject({ pierSide: 'WEST', tracking: true })
		expect(s.runtime.mountRiskObservation!.hourAngle).toBeCloseTo(-deg(179), 6)
		// The oracle unwraps the hour angle too: the failed protection left the mount tracking past latestAt.
		expect(() => s.oracle()).toThrow(/^I18/)
	})

	test.skipIf(isTimeConsumingTestSkipped())('117: an observation extrapolated past latestAt across a restart is an unsupervised crossing', async () => {
		const hours13 = 13 * 3600 * 1000 * (24 / 23.9344696)
		const gap = (tracking: boolean, pierSide: PierSide, at: number) => (runtime: SequencerRuntimeState) => {
			runtime.mountRiskObservation = { at: START - at, hourAngle: LATEST_AT - deg(10), pierSide, tracking }
		}

		const crossed = supervise(-deg(170), { prepare: gap(true, 'WEST', hours13) })
		await flush()
		expect(crossed.events[0]).toMatchObject({ type: 'meridianProtectionUnsupervisedGap', observedAt: START - hours13, tracking: true })
		expect(crossed.events.find((event) => event.type === 'meridianProtectionFailed')).toMatchObject({ reason: 'unsupervisedCrossing', lateStart: true })

		const off = supervise(-deg(170), { tracking: false, prepare: gap(true, 'WEST', hours13) })
		expect(typesOf(off.events)).toEqual(['meridianProtectionUnsupervisedGap'])
		expect(off.outcomes).toEqual([])

		const flipped = supervise(-deg(170), { prepare: gap(true, 'EAST', hours13) })
		const short = supervise(-deg(170), { prepare: gap(true, 'WEST', 60000) })
		expect([...flipped.events, ...short.events].some((event) => event.type === 'meridianProtectionUnsupervisedGap')).toBeFalse()
		for (const supervised of [crossed, off, flipped, short]) supervised.oracle()
	})

	test.skipIf(isTimeConsumingTestSkipped())('118: a legitimate pose near the antimeridian in a first process supervises normally, far from its deadline', async () => {
		const s = supervise(-deg(170))
		await flush()
		expect(s.events).toEqual([])
		expect(s.outcomes).toEqual([])
		expect(s.delays).toEqual([300000])
		s.oracle()
	})
})

describe('113 meridian cycle', () => {
	test.skipIf(isTimeConsumingTestSkipped())('the first process anchors the transit of the decision hour angle; the end of the cycle fails the session', async () => {
		for (const hourAngle of [-deg(179), -deg(90), 0, deg(90)]) {
			const s = supervise(hourAngle, { tracking: false })
			expect(s.runtime.meridianTransitAt).toBeCloseTo(START - (hourAngle / SIDEREAL_DRIFT_RATE) * 1000, 0)
		}

		// At +179° the cycle ends about four minutes later, while nothing else happens.
		const s = supervise(deg(179), { tracking: false })
		await s.clock.advance(s.delays[0])
		await flush()
		expect(s.events).toEqual([{ type: 'meridianCycleExceeded', meridianTransitAt: s.runtime.meridianTransitAt!, wallNow: expect.any(Number) }])
		expect(s.failures).toEqual([{ kind: 'configuration', detail: 'meridianCycleExceeded: the session left its single meridian cycle' }])
	})

	test('a restart a sidereal day later is out of its cycle before any wait', () => {
		const s = supervise(0, { tracking: false, prepare: (runtime) => (runtime.meridianTransitAt = START - 2 * SEQUENCER_MERIDIAN_HALF_CYCLE) })
		expect(typesOf(s.events)).toEqual(['meridianCycleExceeded'])
		expect(s.failures).toHaveLength(1)
	})
})

describe('49.7 the right ascension of date', () => {
	test('6: the end hour angle of the guard matches LST(t_end) − RA_JNOW(t_end) within 0.1 s of time per hour', () => {
		let largest = 0

		for (const declination of [0, 60, 89, 89.5]) {
			for (const exposure of [300, 4 * 3600]) {
				const time = timeUnix(START / 1000)
				const end = timeUnix((START + exposure * 1000) / 1000)
				const [ra] = equatorialToJ2000(deg(30), deg(declination), time)
				const target = { type: 'J2000' as const, J2000: { x: normalizeAngle(ra), y: deg(declination) } }
				const at = (t: Time) => normalizePI(localSiderealTime(t, 0) - mountTargetEquatorial(DEFAULT_MOUNT, target, t)[0])
				const predicted = at(time) + exposure * SIDEREAL_DRIFT_RATE
				const deviation = Math.abs(normalizePI(predicted - at(end))) / SIDEREAL_DRIFT_RATE / (exposure / 3600)
				largest = Math.max(largest, deviation)
			}
		}

		// Largest deviation, in seconds of time per hour.
		expect(largest).toBeLessThan(0.1)
	})

	test('7: the protection deadline matches the hour angle recalculated with RA_JNOW(t) within 1 s up to 6 h', () => {
		const settings = sequencerMeridianFlipSettings(flipOf())
		for (const hours of [0.5, 1, 3, 6]) {
			const hourAngle = settings.latestAt - hours * 3600 * SECOND
			const deadline = meridianProtectionDeadline(settings, { at: START, hourAngle, pierSide: 'WEST', tracking: true }, 0)!
			const lst = localSiderealTime(timeUnix(deadline / 1000), 0) - (localSiderealTime(timeUnix(START / 1000), 0) - hourAngle)
			expect(Math.abs(normalizePI(lst - settings.latestAt)) / SIDEREAL_DRIFT_RATE).toBeLessThan(1)
		}
	})

	test('9: changing only the host clock changes no decision', () => {
		const settings = sequencerMeridianFlipSettings(flipOf())
		const decide = () => sequencerMeridianGuard(settings, { pierSide: 'WEST', decisionHourAngle: -deg(2), offTarget: false, exposure: 600 })
		const before = decide()
		const now = Date.now
		Date.now = () => START + 10 * 365 * 86400000

		try {
			expect(decide()).toEqual(before)
		} finally {
			Date.now = now
		}
	})
})

// One process of a session on the fake mount, with the real runner: the flip task, ensureTracking, the frame
// destination and the guard, a fake capture, and the supervised tracking off of the shutdown.
interface Process {
	readonly runner: SequencerRunner
	readonly configuration: SequencerConfiguration
	// Runner log of the process, in the sequence of the fake mount.
	readonly log: MeridianRunnerEntry[]
	readonly events: SequencerEvent[]
	readonly exposures: string[]
	readonly result: Promise<SequencerResult>
}

interface ProcessOptions {
	readonly sessionId: string
	readonly store?: SequencerCheckpointStore
	readonly guiding?: ScriptedGuidingSession
	readonly onEvent?: (event: SequencerEvent, runner: SequencerRunner) => void
	// Runs in the capture step, after the guard approved the frame and before `beforeExposure`.
	readonly beforeCapture?: () => void
	// Order of the pre-capture before the frame destination and the guard; by default the flip, ensureTracking, then the
	// pointing tasks of the configuration (none without `pointing`) and the guiding.
	readonly preCapture?: (tasks: PreCaptureTasks) => readonly SequencerTask[]
}

// Pre-capture tasks a process may order.
interface PreCaptureTasks {
	readonly flip: SequencerTask
	readonly ensureTracking: SequencerTask
	readonly pointing: readonly SequencerTask[]
	readonly guiding: readonly SequencerTask[]
}

// Processes started by the test file, naming their runtimes.
let processes = 0

function startProcess(configuration: SequencerConfiguration, fake: FakeMount, options: ProcessOptions): Process {
	const { clock } = fake
	const coordinator = new OperationCoordinator(new ResourceArbiter())
	const storage = new FileSystemSequencerStorage({ root: ROOT, sessionId: options.sessionId, wallNow: clock.wallNow })
	const devices = { camera: CAMERA, mount: fake.mount }
	const lifecycle = { mountCommander: fake.commander }
	const guiding = configuration.guiding === undefined ? undefined : options.guiding
	const supervisor = sequencerMeridianSupervisor(configuration, devices, { mountCommander: fake.commander, mountUpdates: fake.updates, ...(guiding !== undefined && { guiding }) })!
	const events: SequencerEvent[] = []
	const exposures: string[] = []

	const capture: SequencerCaptureStep = (context) => {
		options.beforeCapture?.()
		const refusal = context.beforeExposure()
		if (refusal !== undefined) return Promise.resolve(refusal)
		context.exposureStarted()
		exposures.push(`${context.frame!.id}#${context.frame!.attempt}`)
		writeFileSync(context.destination.temporary, FRAME)
		const at = clock.wallNow()
		const monotonic = clock.monotonicNow()
		return Promise.resolve(successfulOperationResult({ exposureDispatchedAt: at, exposureDispatchedMonotonic: monotonic, exposureStartedAt: at, exposureStartedMonotonic: monotonic, exposureFinishedAt: at, exposureFinishedMonotonic: monotonic }))
	}

	const tasks: PreCaptureTasks = {
		flip: supervisor.flipTask,
		ensureTracking: ensureTrackingTask(lifecycle, configuration),
		pointing: sequencerPointingTasks(configuration, { mountCommander: fake.commander }),
		guiding: guiding === undefined ? [] : [ensureGuidingTask(guiding, configuration.guiding!)],
	}
	const defaultPreCapture = ({ flip, ensureTracking, pointing, guiding }: PreCaptureTasks) => [flip, ensureTracking, ...pointing, ...guiding]

	const phases = {
		startup: [],
		preCapture: [...(options.preCapture ?? defaultPreCapture)(tasks), prepareFrameDestinationTask(storage), supervisor.guardTask],
		capture,
		shutdown: sequencerShutdownTasks(configuration, guiding === undefined ? {} : { guiding }, [stopTrackingTask(lifecycle, 'required')]).map((step) => (step.id === 'pauseGuiding' || step.id === 'stopTracking' ? supervisor.shutdownStep(step) : step)),
		supervisor,
		exposureRefusal: sequencerExposureRefusal,
	}

	const session: { runner?: SequencerRunner } = {}
	const roots = recordRunner(coordinator, fake.sequence, clock)
	const listener = (event: SequencerEvent) => {
		roots.listener(event)
		events.push(event)
		if (session.runner !== undefined) options.onEvent?.(event, session.runner)
	}

	const runner = startSequencerRunner({ configuration, devices, services: { coordinator, storage, checkpointStore: options.store ?? new FileSystemSequencerCheckpointStore(ROOT), clock, listener, ...(guiding !== undefined && { guiding }) }, phases })
	session.runner = runner
	const runtime = `process#${++processes}`
	const log: MeridianRunnerEntry[] = []
	const result = runner.handle.result.then((outcome) => {
		roots[Symbol.dispose]()
		log.push(...runtimeEntries(roots.entries, runtime))
		return outcome
	})
	return { runner, configuration, log, events, exposures, result }
}

// Checkpoint store over the files of this test, recording each save in the shared order and failing or reacting on
// demand.
class RecordingStore implements SequencerCheckpointStore {
	readonly saves: { readonly attempts: number; readonly order: number }[] = []
	readonly #inner = new FileSystemSequencerCheckpointStore(ROOT)
	failWhen?: (checkpoint: SequencerCheckpoint) => boolean
	afterSave?: (checkpoint: SequencerCheckpoint) => void

	load(sessionId: string) {
		return this.#inner.load(sessionId)
	}

	async save(checkpoint: SequencerCheckpoint) {
		if (this.failWhen?.(checkpoint) === true) throw new Error('disk full')
		await this.#inner.save(checkpoint)
		this.saves.push({ attempts: checkpoint.meridianFlipAttempts, order: nextFakeOrder() })
		this.afterSave?.(checkpoint)
	}
}

// Saves the checkpoint of a previous process of `sessionId`.
async function previousProcess(configuration: SequencerConfiguration, sessionId: string, clock: ManualClock, patch: Partial<SequencerRuntimeState>) {
	const runtime = createSequencerRuntimeState(configuration, clock.wallNow())
	Object.assign(runtime, patch)
	await new FileSystemSequencerCheckpointStore(ROOT).save(sequencerCheckpointOf(sessionId, configuration, runtime, undefined, 1, clock.wallNow()))
}

describe('49.12 durable flip budget', () => {
	test('5, 9: a flip that always fails is commanded maxRetries + 1 times, each after its incremented budget was saved', async () => {
		const clock = new ManualClock(START)
		const fake = new FakeMount(clock, deg(1))
		fake.flipBehaviour = () => failedOperationResult('commandFailed', 'slew refused')
		const store = new RecordingStore()
		const configuration = configurationOf(flipOf())
		const process = startProcess(configuration, fake, { sessionId: Bun.randomUUIDv7(), store })
		const result = await process.result

		expect(result).toMatchObject({ state: 'stopped', failure: { kind: 'operation', reason: 'unexpectedState', detail: expect.stringContaining('RETRY_LIMIT_REACHED') } })
		const flips = fake.of('flipTo')
		expect(flips).toHaveLength(2)
		for (const [i, flip] of flips.entries()) expect(store.saves.findLast((save) => save.order < flip.order)!.attempts).toBe(i + 1)
		assertOracle(fake, configuration, [process.log])
	})

	test('6, 7: crashes after the dispatch or right after the saved budget never exceed maxRetries + 1 flips', async () => {
		const clock = new ManualClock(START)
		const fake = new FakeMount(clock, deg(1))
		const configuration = configurationOf(flipOf())
		const sessionId = Bun.randomUUIDv7()

		// First process: crash while the flip slews.
		fake.flipBehaviour = (context) => fake.hang(context)
		const first = startProcess(configuration, fake, { sessionId, onEvent: () => {} })
		await waitUntil(() => fake.of('flipTo').length === 1, 2000, 1)
		first.runner.dispose()
		expect((await first.result).state).toBe('failed')

		// Second process: the budget is restored; crash right after the second increment is saved, before the command.
		const store = new RecordingStore()
		const holder: { runner?: SequencerRunner } = {}
		store.afterSave = (checkpoint) => {
			if (checkpoint.meridianFlipAttempts === 2) holder.runner?.dispose()
		}
		const second = startProcess(configuration, fake, { sessionId, store })
		holder.runner = second.runner
		expect((await second.result).state).toBe('failed')
		expect(fake.of('flipTo')).toHaveLength(1)

		// Third process: the budget is spent; the flip fails without any command.
		fake.flipBehaviour = () => fake.succeed()
		const third = startProcess(configuration, fake, { sessionId })
		expect(await third.result).toMatchObject({ state: 'stopped', failure: { detail: expect.stringContaining('RETRY_LIMIT_REACHED') } })
		expect(fake.of('flipTo')).toHaveLength(1)
		expect(await new FileSystemSequencerCheckpointStore(ROOT).load(sessionId)).toMatchObject({ meridianFlipAttempts: 2 })
		// I31 across the three runtimes of the session.
		assertOracle(fake, configuration, [first.log, second.log, third.log])
	})

	test('8: a failed save of the budget commands no flip and fails with storage', async () => {
		const clock = new ManualClock(START)
		const fake = new FakeMount(clock, deg(1))
		const store = new RecordingStore()
		store.failWhen = (checkpoint) => checkpoint.meridianFlipAttempts > 0
		const result = await startProcess(configurationOf(flipOf()), fake, { sessionId: Bun.randomUUIDv7(), store }).result

		expect(result).toMatchObject({ state: 'failed', failure: { kind: 'storage' } })
		expect(fake.of('flipTo')).toEqual([])
	})

	test('10: a restart already on the post-flip side with the budget spent commands nothing and fails nothing', async () => {
		const clock = new ManualClock(START)
		const fake = new FakeMount(clock, deg(1), { pierSide: 'EAST' })
		const configuration = configurationOf(flipOf())
		const sessionId = Bun.randomUUIDv7()
		await previousProcess(configuration, sessionId, clock, { meridianFlipAttempts: 2, meridianTransitAt: START })
		const process = startProcess(configuration, fake, { sessionId })

		expect(await process.result).toMatchObject({ state: 'completed' })
		expect(fake.of('flipTo')).toEqual([])
		expect(process.exposures).toEqual(['frame[F][1]#1'])
		expect(process.events.some((event) => event.type === 'meridianFlipCompleted')).toBeFalse()
	})

	test('11: property over random crashes, failures and budgets: Σ flips ≤ maxRetries + 1, each after its saved budget', async () => {
		const random = mulberry32(20311020)

		for (let run = 0; run < 25; run++) {
			const clock = new ManualClock(START)
			const fake = new FakeMount(clock, deg(1))
			const maxRetries = Math.floor(random() * 3)
			const configuration = configurationOf(flipOf({ maxRetries }))
			const sessionId = Bun.randomUUIDv7()
			const saves: { attempts: number; order: number }[] = []
			const logs: MeridianRunnerEntry[][] = []

			for (let process = 0; process < 5; process++) {
				const store = new RecordingStore()
				const holder: { runner?: SequencerRunner } = {}
				const behaviour = random()
				const crash = random()
				fake.flipBehaviour = (context) => (behaviour < 0.4 ? failedOperationResult('commandFailed') : behaviour < 0.7 ? fake.hang(context) : fake.succeed())
				if (crash < 0.3) store.afterSave = (checkpoint) => checkpoint.meridianFlipAttempts > 0 && holder.runner?.dispose()

				const flipsBefore = fake.of('flipTo').length
				const started = startProcess(configuration, fake, { sessionId, store })
				logs.push(started.log)
				holder.runner = started.runner
				// A hanging flip is ended by a crash.
				const watch = setInterval(() => {
					if (fake.of('flipTo').length > flipsBefore && behaviour >= 0.4 && behaviour < 0.7) started.runner.dispose()
				}, 1)
				const result = await started.result
				clearInterval(watch)
				saves.push(...store.saves)

				const flips = fake.of('flipTo')
				expect(flips.length).toBeLessThanOrEqual(maxRetries + 1)
				for (const [i, flip] of flips.entries()) expect(saves.findLast((save) => save.order < flip.order)!.attempts).toBeGreaterThanOrEqual(i + 1)
				if (result.state !== 'failed' || fake.mount.pierSide === 'EAST') break
			}

			assertOracle(fake, configuration, logs)
		}
	}, 60000)

	test('12: a checkpoint without a well-formed flip budget is malformed, never read as 0', () => {
		const configuration = configurationOf(flipOf())
		const valid = sequencerCheckpointOf('s', configuration, createSequencerRuntimeState(configuration, START), undefined, 1, START)
		expect(parseSequencerCheckpoint(JSON.parse(JSON.stringify(valid)))).toBeDefined()

		for (const meridianFlipAttempts of [undefined, -1, 1.5, '1', Number.MAX_SAFE_INTEGER + 1]) {
			expect(parseSequencerCheckpoint({ ...valid, meridianFlipAttempts })).toBeUndefined()
		}
	})
})

describe('49.12 pier side and destination', () => {
	test('108: a flip ending on NEITHER waits for the post-flip side and reports it unverified', async () => {
		const clock = new ManualClock(START)
		const fake = new FakeMount(clock, deg(1))
		fake.flipBehaviour = () => {
			fake.set({ pierSide: 'NEITHER' })
			const { rightAscension, declination } = fake.mount.equatorialCoordinate
			return successfulOperationResult({ rightAscension, declination, pierSide: 'NEITHER', initialPierSide: 'WEST', pierSideVerified: false })
		}
		const process = startProcess(configurationOf(flipOf({ pierSideTimeout: 10 })), fake, { sessionId: Bun.randomUUIDv7() })
		await waitUntil(() => fake.of('flipTo').length === 1, 2000, 1)
		await flush()
		await clock.advance(2000)
		fake.set({ pierSide: 'EAST' })

		expect(await process.result).toMatchObject({ state: 'completed' })
		const completed = process.events.filter((event) => event.type === 'meridianFlipCompleted')
		expect(completed).toEqual([expect.objectContaining({ type: 'meridianFlipCompleted', attempts: 1, pierSide: 'EAST', pierSideVerified: false })])
		const { sessionId: _, at: __, ...body } = completed[0]
		expect(Object.keys(body).sort()).toEqual(['attempts', 'hourAngle', 'pierSide', 'pierSideVerified', 'type'])
		expect(JSON.parse(JSON.stringify(body))).toEqual(body)
		assertOracle(fake, configurationOf(flipOf({ pierSideTimeout: 10 })), [process.log])
	})

	test('109: a pier side that stays NEITHER fails the flip after pierSideTimeout, exposing nothing', async () => {
		const clock = new ManualClock(START)
		const fake = new FakeMount(clock, deg(1), { pierSide: 'NEITHER' })
		const process = startProcess(configurationOf(flipOf({ pierSideTimeout: 10 })), fake, { sessionId: Bun.randomUUIDv7() })
		await waitUntil(() => clock.pending >= 2, 2000, 1)
		await clock.advance(10000)

		expect(await process.result).toMatchObject({ state: 'stopped', failure: { detail: expect.stringContaining('PIER_SIDE_NEITHER') } })
		expect(fake.of('flipTo')).toEqual([])
		expect(process.exposures).toEqual([])
		assertOracle(fake, configurationOf(flipOf({ pierSideTimeout: 10 })), [process.log])
	})

	test('110: a restart with a transient NEITHER commands no flip and completes once the post-flip side is read', async () => {
		const clock = new ManualClock(START)
		const fake = new FakeMount(clock, deg(1), { pierSide: 'NEITHER' })
		const configuration = configurationOf(flipOf({ pierSideTimeout: 10 }))
		const sessionId = Bun.randomUUIDv7()
		await previousProcess(configuration, sessionId, clock, { meridianFlipAttempts: 1, meridianTransitAt: START })
		const process = startProcess(configuration, fake, { sessionId })
		await waitUntil(() => clock.pending >= 2, 2000, 1)
		fake.set({ pierSide: 'EAST' })

		expect(await process.result).toMatchObject({ state: 'completed' })
		expect(fake.of('flipTo')).toEqual([])
		expect(process.exposures).toEqual(['frame[F][1]#1'])
		assertOracle(fake, configuration, [process.log])
	})

	test('111: the pre-flip side read in COMPLETED recreates the state from the budget: a new flip with budget, a failure without', async () => {
		for (const maxRetries of [1, 0]) {
			const clock = new ManualClock(START)
			const fake = new FakeMount(clock, deg(1))
			const configuration = configurationOf(flipOf({ maxRetries }), {}, DARK, 2)
			const process = startProcess(configuration, fake, {
				sessionId: Bun.randomUUIDv7(),
				onEvent: (event) => {
					if (event.type === 'frameAccepted' && event.slot === 'frame[F][1]') fake.set({ pierSide: 'WEST' })
				},
			})
			const result = await process.result

			expect(process.events.filter((event) => event.type === 'meridianFlipSideReverted')).toHaveLength(1)
			if (maxRetries === 1) {
				expect(result.state).toBe('completed')
				expect(fake.of('flipTo')).toHaveLength(2)
			} else {
				expect(result).toMatchObject({ state: 'stopped', failure: { detail: expect.stringContaining('RETRY_LIMIT_REACHED') } })
				expect(fake.of('flipTo')).toHaveLength(1)
			}

			assertOracle(fake, configuration, [process.log])
		}
	})

	test('115: without a target the flip goes to the published position of date; with one, to the J2000 target at the session instant', async () => {
		const clock = new ManualClock(Date.UTC(2040, 0, 1))
		const fake = new FakeMount(clock, deg(1))
		const { rightAscension, declination } = fake.mount.equatorialCoordinate
		expect(await startProcess(configurationOf(flipOf()), fake, { sessionId: Bun.randomUUIDv7() }).result).toMatchObject({ state: 'completed' })
		const [untargeted] = fake.of('flipTo')
		expect(untargeted.args[0]).toEqual({ type: 'JNOW', JNOW: { x: rightAscension, y: declination } })

		const other = new FakeMount(clock, deg(1))
		const target = other.target()
		expect(await startProcess(configurationOf(flipOf(), { target }), other, { sessionId: Bun.randomUUIDv7() }).result).toMatchObject({ state: 'completed' })
		const [targeted] = other.of('flipTo')
		expect(targeted.args[0]).toEqual({ type: 'J2000', J2000: { x: target.rightAscension, y: target.declination } })
		const { time, timeout, settleTimeout } = targeted.args[1] as MountCommandOptions
		const expected = timeUnix(targeted.wallNow / 1000)
		expect([time!.day, time!.fraction]).toEqual([expected.day, expected.fraction])
		expect([timeout, settleTimeout]).toEqual([300000, 1000])
	})
})

describe('49.12 flip slews and the hard deadline', () => {
	// Flip due, tracking, graceful and hard deadlines together 10 s ahead (protectionMargin = lead), flipTimeout 30 s.
	const slewing = (behaviour: (fake: FakeMount) => FlipBehaviour) => {
		const clock = new ManualClock(START)
		const fake = new FakeMount(clock, hardIn(10), { tracking: true })
		fake.flipBehaviour = behaviour(fake)
		const flip = flipOf({ protectionMargin: LEAD / 1000, flipAt: hardIn(20), prepareAt: hardIn(30), flipTimeout: 30 })
		const process = startProcess(configurationOf(flip), fake, { sessionId: Bun.randomUUIDv7() })
		return { clock, fake, process }
	}

	test('77: a flip dispatched but never observed slewing does not suspend the deadline: cancelled, then tracking off', async () => {
		const { clock, fake, process } = slewing((fake) => (context) => fake.hang(context))
		await waitUntil(() => fake.of('flipTo').length === 1, 2000, 1)
		await clock.advance(10000)
		await waitUntil(() => process.events.some((event) => event.type === 'meridianHardProtection'), 2000, 1)

		expect(process.events.find((event) => event.type === 'meridianHardProtection')).toMatchObject({ late: false })
		expect(fake.of('tracking')[0].args[0]).toBeFalse()
		expect(fake.of('tracking')[0].order).toBeGreaterThan(fake.of('flipTo')[0].order)
		// The cancelled flip is FAILED, so the budget decides the retry: the second flip runs with tracking off.
		fake.flipBehaviour = () => fake.succeed()
		expect(await process.result).toMatchObject({ state: 'completed' })
		expect(fake.of('flipTo')).toHaveLength(2)
		assertOracle(fake, process.configuration, [process.log])
	})

	test('80: a flip still slewing at its watchdog is protected as flipSlewTimeout', async () => {
		const { clock, fake, process } = slewing((fake) => (context) => {
			fake.set({ slewing: true })
			return fake.hang(context, () => fake.set({ slewing: false }))
		})
		await waitUntil(() => fake.of('flipTo').length === 1, 2000, 1)
		await flush()
		// Past the hard deadline the slew is still supervised.
		await clock.advance(20000)
		await flush()
		expect(fake.of('tracking')).toEqual([])
		await clock.advance(10000)

		expect(await process.result).toMatchObject({ state: 'stopped' })
		expect(process.events.find((event) => event.type === 'meridianProtectionFailed')).toMatchObject({ reason: 'flipSlewTimeout' })
		// Tracked past latestAt during the supervised slew, reported as flipSlewTimeout (I18 c).
		assertOracle(fake, process.configuration, [process.log])
	})

	test('79: a flip slew that stops on the pre-flip side after the deadline is protected as flipSideUnchanged', async () => {
		const { clock, fake, process } = slewing((fake) => async () => {
			fake.set({ slewing: true })
			await clock.delay(20000, new AbortController().signal)
			fake.set({ slewing: false })
			return failedOperationResult('unexpectedState', 'the mount did not change sides')
		})
		await waitUntil(() => fake.of('flipTo').length === 1, 2000, 1)
		await flush()
		await clock.advance(20000)

		expect(await process.result).toMatchObject({ state: 'stopped' })
		expect(process.events.find((event) => event.type === 'meridianProtectionFailed')).toMatchObject({ reason: 'flipSideUnchanged' })
		expect(fake.of('tracking').map((entry) => entry.args[0])).toEqual([false])
		assertOracle(fake, process.configuration, [process.log])
	})
})

describe('49.7 12 beforeExposure and the meridian', () => {
	test('a deadline elapsed between the guard and the dispatch exposes nothing; the pre-capture re-enters, flips, then exposes', async () => {
		const clock = new ManualClock(START)
		const fake = new FakeMount(clock, -deg(30))
		const configuration = configurationOf(flipOf())
		const flipsAtExposure: number[] = []
		let moved = false
		const sessionId = Bun.randomUUIDv7()

		const process = startProcess(configuration, fake, {
			sessionId,
			beforeCapture: () => {
				// Once, after the guard approved the dark at −30°: the mount is now past the graceful deadline.
				if (moved) return
				moved = true
				fake.place(gracefulIn(-1))
			},
			onEvent: (event) => {
				if (event.type === 'exposureStarted') flipsAtExposure.push(fake.of('flipTo').length)
			},
		})

		expect(await process.result).toMatchObject({ state: 'completed' })
		expect(fake.of('flipTo')).toHaveLength(1)
		// The refusal consumed no attempt: the only exposure is the first attempt, after the flip.
		expect(process.exposures).toEqual(['frame[F][1]#1'])
		expect(flipsAtExposure).toEqual([1])
		const journal = await readSequencerJournal(join(ROOT, sessionId, 'journal.jsonl'))
		expect(journal.filter((entry) => entry.kind === 'deferred')).toEqual([expect.objectContaining({ attempt: 1 })])
		assertOracle(fake, configuration, [process.log])
	})
})

describe('49.12 96, 97 tracking reconciled after the acquisition', () => {
	const POINTING = { settle: 0, onFailure: 'fail' as const }

	// A mount tracking off its target in the meridian zone (ensureTracking defers) and the J2000 target at −30°.
	const offTarget = (state: Partial<Pick<Mount, 'trackMode' | 'tracking'>> = {}) => {
		const clock = new ManualClock(START)
		const fake = new FakeMount(clock, -deg(30), { trackMode: state.trackMode ?? 'SIDEREAL' })
		const target = fake.target()
		fake.set({ tracking: state.tracking ?? false })
		fake.place(gracefulIn(20))
		return { clock, fake, target }
	}

	test('96: goTo < SIDEREAL observed < tracking on observed < light, after an ensureTracking that deferred', async () => {
		const { fake, target } = offTarget({ trackMode: 'LUNAR' })
		const configuration = configurationOf(flipOf(), { target, pointing: POINTING }, LIGHT)
		const process = startProcess(configuration, fake, { sessionId: Bun.randomUUIDv7() })

		expect(await process.result).toMatchObject({ state: 'completed' })
		expect(process.events.find((event) => event.type === 'trackingDeferred')).toMatchObject({ reason: 'meridianZone' })
		const [goTo] = fake.of('goTo')
		const [mode] = fake.of('trackMode')
		const [on] = fake.of('tracking')
		expect(mode.args[0]).toBe('SIDEREAL')
		expect(on.args[0]).toBeTrue()
		expect(goTo.order).toBeLessThan(on.order)
		expect(mode.order).toBeLessThan(on.order)
		expect(process.exposures).toEqual(['frame[F][1]#1'])
		assertOracle(fake, configuration, [process.log])
	})

	test('96: a driver that turns tracking on with the slew gets no extra tracking command', async () => {
		const { fake, target } = offTarget()
		fake.trackOnSlew = true
		const configuration = configurationOf(flipOf(), { target, pointing: POINTING }, LIGHT)
		const process = startProcess(configuration, fake, { sessionId: Bun.randomUUIDv7() })

		expect(await process.result).toMatchObject({ state: 'completed' })
		expect(fake.of('goTo')).toHaveLength(1)
		// Only the tracking off of the shutdown.
		expect(fake.of('tracking').map((entry) => entry.args[0])).toEqual([false])
		expect(process.exposures).toEqual(['frame[F][1]#1'])
		assertOracle(fake, configuration, [process.log])
	})

	test('96: the fast path of the commander, already on the target, reconciles tracking all the same', async () => {
		const clock = new ManualClock(START)
		const fake = new FakeMount(clock, -deg(30), { trackMode: 'LUNAR' })
		const configuration = configurationOf(flipOf(), { target: fake.target(), pointing: POINTING }, LIGHT)
		// No ensureTracking before the acquisition: only its reconciliation turns tracking on.
		const process = startProcess(configuration, fake, { sessionId: Bun.randomUUIDv7(), preCapture: ({ flip, pointing }) => [flip, ...pointing] })

		expect(await process.result).toMatchObject({ state: 'completed' })
		expect(fake.of('goTo')).toEqual([])
		expect(fake.of('trackMode').map((entry) => entry.args[0])).toEqual(['SIDEREAL'])
		// Tracking on by the reconciliation, off by the shutdown.
		expect(fake.of('tracking').map((entry) => entry.args[0])).toEqual([true, false])
		expect(process.exposures).toEqual(['frame[F][1]#1'])
		assertOracle(fake, configuration, [process.log])
	})

	test('97: a destination the slew brought into the meridian zone gets no tracking on; acquired, the flip is decided before any light', async () => {
		const clock = new ManualClock(START)
		// The target is 3 s before the graceful deadline when the goTo is commanded; the slew takes 10 s.
		const fake = new FakeMount(clock, gracefulIn(3))
		const target = fake.target()
		fake.place(-deg(30))
		fake.slewTime = 10000
		const configuration = configurationOf(flipOf(), { target, pointing: POINTING }, LIGHT)
		// The acquisition before the flip evaluation, so the zone is reached during its slew.
		const process = startProcess(configuration, fake, { sessionId: Bun.randomUUIDv7(), preCapture: ({ flip, ensureTracking, pointing }) => [...pointing, flip, ensureTracking] })
		await waitUntil(() => fake.mount.slewing, 2000, 1)
		await clock.advance(10000)

		expect(await process.result).toMatchObject({ state: 'completed' })
		expect(process.events.find((event) => event.type === 'trackingDeferred')).toMatchObject({ reason: 'meridianZone' })
		const [goTo] = fake.of('goTo')
		const [flipTo] = fake.of('flipTo')
		expect(goTo.order).toBeLessThan(flipTo.order)
		// No tracking on the pre-flip side in the zone: the only tracking on follows the flip.
		expect(
			fake
				.of('tracking')
				.filter((entry) => entry.args[0] === true)
				.map((entry) => entry.order > flipTo.order),
		).toEqual([true])
		expect(process.exposures).toEqual(['frame[F][1]#1'])
		assertOracle(fake, configuration, [process.log])
	})
})

describe('49.12 97 incorrect variant', () => {
	test('a goTo commanded with the target already past the graceful deadline on the pre-flip side is rejected by the oracle', async () => {
		const clock = new ManualClock(START)
		const fake = new FakeMount(clock, gracefulIn(-5))
		const target = fake.target()
		fake.place(-deg(30))
		const configuration = configurationOf(flipOf(), { target, pointing: { settle: 0, onFailure: 'fail' } }, LIGHT)
		// Acquiring before evaluating the flip slews straight into the zone (I63).
		const process = startProcess(configuration, fake, { sessionId: Bun.randomUUIDv7(), preCapture: ({ flip, ensureTracking, pointing }) => [...pointing, flip, ensureTracking] })
		await process.result

		expect(() => assertOracle(fake, configuration, [process.log])).toThrow(/^I63: a goTo/)
	})
})

describe('49.12 94 mount off its target', () => {
	test('a tracking mount in the meridian zone whose target flip is not due stops tracking, flips nothing, and the dark is exposed', async () => {
		const clock = new ManualClock(START)
		const fake = new FakeMount(clock, -deg(30))
		const target = fake.target()
		// The mount tracks elsewhere, 20 s before the graceful deadline of its own hour angle: the 10 s dark and the 30 s
		// guard margin would cross it.
		fake.set({ tracking: true })
		fake.place(gracefulIn(20))
		const configuration = configurationOf(flipOf(), { target })
		const process = startProcess(configuration, fake, { sessionId: Bun.randomUUIDv7() })
		const result = await process.result

		expect(result).toMatchObject({ state: 'completed' })
		const offTarget = process.events.find((event) => event.type === 'meridianProtectionMountOffTarget')
		expect(offTarget).toBeDefined()
		expect((offTarget as { targetHourAngle: Angle }).targetHourAngle).toBeLessThan(0)
		expect(fake.of('flipTo')).toEqual([])
		expect(fake.of('tracking').map((entry) => entry.args[0])).toEqual([false])
		expect(process.events.find((event) => event.type === 'trackingDeferred')).toMatchObject({ reason: 'meridianZone' })
		expect(process.exposures).toEqual(['frame[F][1]#1'])
		assertOracle(fake, configuration, [process.log])
	})
})

describe('49.5 5 pause across the meridian', () => {
	const pausedSession = (options: { readonly flip?: Partial<SequencerMeridianFlipConfiguration> } = {}) => {
		const clock = new ManualClock(START)
		const fake = new FakeMount(clock, gracefulIn(30), { tracking: true })
		const guiding = new ScriptedGuidingSession({}, fake.sequence)
		guiding.current = 'guiding'
		const configuration = configurationOf(flipOf(options.flip), { guiding: { settle: { pixels: 1, time: 1, timeout: 10 }, pauseTimeout: 2, maxRecoveries: 0, recalibrate: false, flipCalibration: false, onFailure: 'fail' } }, LIGHT)
		const process = startProcess(configuration, fake, { sessionId: Bun.randomUUIDv7(), guiding })
		return { clock, fake, guiding, process, configuration }
	}

	test('5a, 5c: stopTracking pauses guiding before tracking off, before latestAt, and stays paused; nothing happens while tracking is off', async () => {
		const { clock, fake, guiding, process, configuration } = pausedSession()
		expect(await process.runner.handle.pause()).toBe('paused')
		await clock.advance(30000)
		await waitUntil(() => process.events.some((event) => event.type === 'taskCompleted' && event.task === 'protectMeridianWhilePaused'), 2000, 1)

		expect(process.runner.snapshot().state).toBe('paused')
		expect(guiding.commands()).toEqual(['beginRun', 'pause'])
		expect(fake.of('tracking').map((entry) => entry.args[0])).toEqual([false])
		expect(fake.hourAngle()).toBeLessThan(LATEST_AT)

		// Six hours later, tracking off: no request and no command.
		const commands = fake.commands.length
		await clock.advance(6 * 3600000)
		await flush()
		expect(fake.commands).toHaveLength(commands)
		expect(process.runner.snapshot().state).toBe('paused')
		await process.runner.handle.stop()
		await process.result
		assertOracle(fake, configuration, [process.log], { guiding })
	})

	test('5b: a guiding pause that fails stops guiding and still turns tracking off before latestAt', async () => {
		const { clock, fake, guiding, process, configuration } = pausedSession()
		// The pause of a guiding session fails while it guides; a stopped one only closes its gate.
		guiding.onPause = () => (guiding.current === 'stopped' ? successfulOperationResult(undefined) : failedOperationResult('timeout'))
		expect(await process.runner.handle.pause()).toBe('paused')
		await clock.advance(30000)

		expect(await process.result).toMatchObject({ state: 'stopped' })
		expect(guiding.commands().slice(0, 3)).toEqual(['beginRun', 'pause', 'stop'])
		expect(fake.of('tracking')[0].args[0]).toBeFalse()
		expect(process.events.find((event) => event.type === 'meridianProtectionFailed')).toMatchObject({ reason: 'guidingNotQuiescent', lateStart: false })
		assertOracle(fake, configuration, [process.log], { guiding })
	})

	test('5d: resume() never turns tracking on: the flip is decided with tracking off, then ensureTracking turns it on', async () => {
		const { clock, fake, guiding, process, configuration } = pausedSession()
		expect(await process.runner.handle.pause()).toBe('paused')
		await clock.advance(30000)
		await waitUntil(() => process.events.some((event) => event.type === 'taskCompleted' && event.task === 'protectMeridianWhilePaused'), 2000, 1)
		expect(process.runner.handle.resume()).toBeTrue()

		expect(await process.result).toMatchObject({ state: 'completed' })
		const [off, on] = fake.of('tracking')
		expect([off.args[0], on.args[0]]).toEqual([false, true])
		expect(fake.of('flipTo')[0].order).toBeGreaterThan(off.order)
		expect(on.order).toBeGreaterThan(fake.of('flipTo')[0].order)
		expect(process.exposures).toEqual(['frame[F][1]#1'])
		// Guiding was paused by the protection, paused again right before the flip moved the mount, and recovered by a new
		// start (never a resume of the old lock position); the shutdown pauses it before the tracking off and stops it.
		expect(guiding.commands()).toEqual(['beginRun', 'pause', 'pause', 'start', 'pause', 'stop', 'endRun'])
		expect(process.events.filter((event) => event.type === 'meridianFlipCompleted')).toHaveLength(1)
		assertOracle(fake, configuration, [process.log], { guiding })
	})

	test('5f: resumed past the graceful deadline with a failing flip, tracking never goes on and nothing is exposed', async () => {
		const { clock, fake, guiding, process, configuration } = pausedSession()
		fake.flipBehaviour = () => failedOperationResult('commandFailed')
		expect(await process.runner.handle.pause()).toBe('paused')
		await clock.advance(30000)
		await waitUntil(() => process.events.some((event) => event.type === 'taskCompleted' && event.task === 'protectMeridianWhilePaused'), 2000, 1)
		process.runner.handle.resume()

		expect(await process.result).toMatchObject({ state: 'stopped' })
		expect(fake.of('tracking').map((entry) => entry.args[0])).toEqual([false])
		expect(process.exposures).toEqual([])
		assertOracle(fake, configuration, [process.log], { guiding })
	})
})
