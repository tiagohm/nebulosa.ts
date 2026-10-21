import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { equatorialToJ2000 } from '../../../src/astronomy/coordinates/coordinate'
import { localSiderealTime } from '../../../src/astronomy/observer/location'
import { type Time, timeNow, timeUnix } from '../../../src/astronomy/time/time'
import { SIDEREAL_DRIFT_RATE, TAU } from '../../../src/core/constants'
import { guidePulseReleaseBound } from '../../../src/devices/commanders/guideoutput'
import type { MountCommandOptions } from '../../../src/devices/commanders/mount'
import { DEFAULT_CAMERA, DEFAULT_DOME, DEFAULT_MOUNT, type Camera, type Device, type Dome, type Mount, type MountTargetCoordinate, type PierSide } from '../../../src/devices/indi/device'
import type { CameraManager } from '../../../src/devices/indi/manager/camera'
import { mountTargetEquatorial } from '../../../src/devices/indi/manager/mount'
import { abortableDelay } from '../../../src/devices/orchestration/operation.wait'
import { resourceKey } from '../../../src/devices/orchestration/resource'
import { type Angle, deg, normalizeAngle, normalizePI } from '../../../src/math/units/angle'
import { GuiderClient } from '../../../src/observation/guiding/client'
import { MountDitherer } from '../../../src/observation/guiding/ditherer'
import type { GuidingSession } from '../../../src/observation/guiding/session'
import { LocalGuidingSession } from '../../../src/observation/guiding/session.client'
import { StarTracker } from '../../../src/observation/guiding/tracker.star'
import { createMeridianFlipState, type MeridianFlipStatePhase } from '../../../src/observation/mount/meridian.flip'
import { captureFrameStep } from '../../../src/observation/sequencer/capture'
import { prepareOpticalPathTask } from '../../../src/observation/sequencer/focus'
import { sequencerGuidingStartupTasks, sequencerShutdownTasks } from '../../../src/observation/sequencer/guiding'
import { ensureTrackingTask, type SequencerLifecycleServices, sequencerShutdownLifecycleTasks, sequencerStartupLifecycleTasks } from '../../../src/observation/sequencer/lifecycle'
// oxfmt-ignore
import { meridianHardProtectionLead, meridianProtectionDeadline, mountKeyAliases, mountKeyHolders, mountTrackingProtectionTimings, observeSequencerMeridian, preflightSequencerMeridian, SEQUENCER_SUPERVISION_JITTER, sequencerDecisionHourAngle, sequencerExposureGuard, sequencerExposureRefusal, sequencerMeridianFlipSettings, sequencerMountMotionBounds, sequencerMeridianGuard, sequencerMeridianSupervisor, sequencerPointingTasks } from '../../../src/observation/sequencer/pointing'
import { type SequencerRunner, type SequencerTask, type SequencerTaskView, startSequencerRunner } from '../../../src/observation/sequencer/runner'
// oxfmt-ignore
import { DEFAULT_SEQUENCER_MERIDIAN_FLIP, type SequencerCameraCapture, type SequencerClock, type SequencerConfiguration, type SequencerDevices, type SequencerEvent, type SequencerMeridianFlipConfiguration, type SequencerResult, type SequencerTaskId, type SequencerTarget } from '../../../src/observation/sequencer/sequencer'
import { advanceSequencerMeridianFlip, createSequencerRuntimeState, isWithinSequencerMeridianCycle, SEQUENCER_MERIDIAN_HALF_CYCLE, sequencerCheckpointOf, sequencerMeridianTransitAt, toMeridianFlipPolicy } from '../../../src/observation/sequencer/state'
import { FileSystemSequencerCheckpointStore, FileSystemSequencerStorage, prepareFrameDestinationTask, readSequencerJournal } from '../../../src/observation/sequencer/storage'
import { isTimeConsumingTestSkipped, waitUntil } from '../../util'
import { assertMeridianProtectionInvariants, assertMountKeyClosure, type MeridianMountState, runtimeEntries } from './meridian.util'
// oxfmt-ignore
import { connectSimulatorRig, createSimulatorRig, createTestSequence, type DeviceCommandEntry, type DeviceLogEntry, expectNoRigLeaks, RIG_INITIAL_POINTING, recordDevices, resetSimulatorRig } from '../../util/rig'
import { assertJournalInvariants, assertRunnerInvariants, assertSequencerInvariants, type LeaseEntry, recordLeases, recordRunner, type RunnerLogEntry } from './util'

// Meridian flip of the Sequencer (section 24): the pure helpers (settings, policy, motion table, protection timings and
// lead, deadlines, guard, decision hour angle, cycle, preflight) and sessions on the INDI simulator rig with the e2e
// clock (the simulated UTC of the mount as wall time). Each session places the mount, synced and tracking, a few seconds
// of hour angle east of the meridian on its WEST (pre-flip) side and sets the thresholds relative to that hour angle, so
// the flip, the guard wait and the protections happen within seconds. The simulator flips at its fastest slew rate.

const LIGHT: SequencerCameraCapture = { exposureTime: 500, exposureTimeUnit: 'millisecond', frameType: 'LIGHT', x: 0, y: 0, width: 64, height: 64, subframe: true, binX: 2, binY: 2, frameFormat: 'MONO', gain: 10, offset: 5, compressed: false }
// Hard protection timeouts of the sessions: lead = jitter 1 s + mount motion 0.5 s + tracking 0.5 s = 2 s.
const HARD = { mountStopTimeout: 0.5, guidingStopTimeout: 0.5, trackingTimeout: 0.5 } as const
const LEAD = 2000
// Graceful margin of the sessions, in seconds; at least the lead.
const MARGIN = 3
// One second of time as an hour angle, in radians.
const SECOND = SIDEREAL_DRIFT_RATE

const rig = await createSimulatorRig()
const ROOT = join(rig.capturesDir, 'sessions')
const clock: SequencerClock = { wallNow: () => rig.simulators.mount.utcTime, monotonicNow: () => performance.now(), delay: abortableDelay }
const lifecycle: SequencerLifecycleServices = { mountCommander: rig.commanders.mount, cameraCommander: rig.commanders.camera }

beforeAll(async () => {
	await connectSimulatorRig(rig)
	expect(await rig.commanders.mount.setSlewRate(rig.coordinator, rig.devices().mount, 'SPEED_7')).toMatchObject({ ok: true })
})

afterAll(async () => {
	await rig[Symbol.asyncDispose]()
})

beforeEach(async () => {
	await resetSimulatorRig(rig, rig.devices().focuser.position.value)
	const { mount } = rig.devices()
	if (mount.trackMode !== 'SIDEREAL') expect(await rig.commanders.mount.setTrackMode(rig.coordinator, mount, 'SIDEREAL')).toMatchObject({ ok: true })
})

afterEach(async () => {
	await expectNoRigLeaks(rig)
})

// Apparent local sidereal time of the rig mount at its clock.
function rigLst() {
	return localSiderealTime(timeUnix(clock.wallNow() / 1000), rig.devices().mount.geographicCoordinate.longitude)
}

// Syncs the rig mount at `hourAngle` (radians, negative east of the meridian) and declination −30°, optionally tracking,
// and returns the J2000 target that points there and the hour angle measured right after.
async function placeMount(hourAngle: Angle, tracking: boolean) {
	const { mount } = rig.devices()
	const declination = RIG_INITIAL_POINTING.declination
	const rightAscension = normalizeAngle(rigLst() - hourAngle)
	expect(await rig.commanders.mount.sync(rig.coordinator, mount, { type: 'JNOW', JNOW: { x: rightAscension, y: declination } })).toMatchObject({ ok: true })
	if (tracking) expect(await rig.commanders.mount.setTracking(rig.coordinator, mount, true)).toMatchObject({ ok: true })
	await waitUntil(() => Math.abs(normalizePI(mount.equatorialCoordinate.rightAscension - rightAscension)) < deg(0.01) && mount.pierSide === 'WEST', 5000, 10)

	const [ra, dec] = equatorialToJ2000(rightAscension, declination, timeUnix(clock.wallNow() / 1000))
	const target: SequencerTarget = { frame: 'J2000', rightAscension: normalizeAngle(ra), declination: dec }
	return { target, hourAngle: normalizePI(rigLst() - mount.equatorialCoordinate.rightAscension) }
}

// Meridian flip from WEST to EAST with thresholds after the hour angle `hourAngle`: `flipAt` `toFlip` seconds later,
// `latestAt` `window` seconds after `flipAt` (at least the margin).
function meridianFlipOf(hourAngle: Angle, toFlip: number, window: number, patch: Partial<SequencerMeridianFlipConfiguration> = {}): SequencerMeridianFlipConfiguration {
	const flipAt = hourAngle + toFlip * SECOND
	return { enabled: true, prepareAt: flipAt - 10 * SECOND, flipAt, latestAt: flipAt + window * SECOND, beforeFlipPierSide: 'WEST', afterFlipPierSide: 'EAST', exposureMargin: 5, protectionMargin: MARGIN, supervisionInterval: 0.1, flipTimeout: 30, maxRetries: 1, hardProtection: HARD, onFailure: 'stop', ...patch }
}

function configurationOf(target: SequencerTarget, meridianFlip: SequencerMeridianFlipConfiguration, patch: Partial<SequencerConfiguration> = {}): SequencerConfiguration {
	return {
		schemaVersion: 1,
		id: 'meridian',
		revision: 1,
		name: 'Meridian',
		target,
		meridianFlip,
		capture: { order: 'sequential', groups: [{ kind: 'scheduled', id: 'L', enabled: true, capture: LIGHT, count: 1 }], retry: { maxAttempts: 1, delay: 0, backoff: 1, maximumDelay: 0, retryOn: [] }, onFailure: 'fail', cameraRecovery: { onTimeout: 'stop' } },
		startup: { mount: { unpark: true }, onFailure: 'fail' },
		shutdown: { stepTimeout: 5, totalTimeout: 60, stopTracking: 'required' },
		execution: { compensation: { timeout: 5 } },
		...patch,
	}
}

interface SessionOptions {
	readonly sessionId?: string
	// Pre-capture tasks after `ensureTracking`.
	readonly extra?: readonly SequencerTask[]
	readonly onEvent?: (event: SequencerEvent, runner: SequencerRunner) => void
	readonly onStart?: (runner: SequencerRunner) => void
	// Whether the session runs its meridian supervisor; default true. Without it, only the incorrect variants run.
	readonly supervised?: boolean
	// Guiding session of the run (its admission, the guiding half of the protections and of the shutdown).
	readonly guiding?: GuidingSession
	// Mount ditherer of the dither feature (its movement, its inherited pulse barrier and the startup task waiting it).
	readonly ditherer?: MountDitherer
	// Devices of the session besides the camera and the mount.
	readonly devices?: Omit<SequencerDevices, 'camera' | 'mount'>
}

interface Session {
	readonly sessionId: string
	readonly configuration: SequencerConfiguration
	// Mount state when the session started.
	readonly initial: MeridianMountState
	readonly result: SequencerResult
	readonly events: SequencerEvent[]
	readonly devices: DeviceLogEntry[]
	readonly roots: RunnerLogEntry[]
	// Leases the arbiter granted during the session.
	readonly leases: LeaseEntry[]
}

// Runs one process of a session: the startup lifecycle, the pre-capture `meridianFlip` → `ensureTracking` → extra tasks
// → pointing → frame destination → final guard, the real capture, the shutdown with its tracking prefix, and the
// supervisor of the session. The preflight of the meridian must be clean.
async function runSession(configuration: SequencerConfiguration, options: SessionOptions = {}): Promise<Session> {
	const sequence = createTestSequence()
	const devices = recordDevices(rig, clock, sequence)
	const roots = recordRunner(rig.coordinator, sequence, clock)
	const leases = recordLeases(rig.arbiter)
	const sessionId = options.sessionId ?? Bun.randomUUIDv7()
	const storage = new FileSystemSequencerStorage({ root: ROOT, sessionId, wallNow: clock.wallNow })
	const events: SequencerEvent[] = []
	const { mount, camera } = rig.devices()
	const sessionDevices: SequencerDevices = { camera, mount, ...options.devices }
	const { guiding, ditherer } = options
	const services = { mountCommander: rig.commanders.mount, guideOutputCommander: rig.commanders.guideOutput, ...(guiding !== undefined && { guiding }), ...(ditherer !== undefined && { ditherer }) }
	expect(preflightSequencerMeridian(configuration, sessionDevices, services)).toEqual([])

	const initial: MeridianMountState = { tracking: mount.tracking, pierSide: mount.pierSide, trackMode: mount.trackMode, rightAscension: mount.equatorialCoordinate.rightAscension, longitude: mount.geographicCoordinate.longitude }
	const supervisor = sequencerMeridianSupervisor(configuration, sessionDevices, services)!
	const supervised = options.supervised !== false
	const phases = {
		startup: [...(ditherer === undefined ? [] : sequencerGuidingStartupTasks(configuration, { ditherer })), ...sequencerStartupLifecycleTasks(configuration, lifecycle)],
		preCapture: [supervisor.flipTask, ensureTrackingTask(lifecycle, configuration), ...(options.extra ?? []), ...sequencerPointingTasks(configuration, { mountCommander: rig.commanders.mount }), prepareFrameDestinationTask(storage), supervisor.guardTask],
		capture: captureFrameStep({ cameraCapturer: rig.capturer, storage }),
		shutdown: sequencerShutdownTasks(configuration, guiding === undefined ? {} : { guiding }, sequencerShutdownLifecycleTasks(configuration.shutdown, lifecycle)).map((step) => ((step.id === 'stopTracking' || step.id === 'pauseGuiding') && supervised ? supervisor.shutdownStep(step) : step)),
		...(supervised && { supervisor }),
		exposureRefusal: sequencerExposureRefusal,
	}
	const session: { runner?: SequencerRunner } = {}
	const listener = (event: SequencerEvent) => {
		roots.listener(event)
		events.push(event)
		if (session.runner !== undefined) options.onEvent?.(event, session.runner)
	}
	const runner = startSequencerRunner({ configuration, devices: sessionDevices, services: { coordinator: rig.coordinator, storage, checkpointStore: new FileSystemSequencerCheckpointStore(ROOT), clock, listener, ...(guiding !== undefined && { guiding }), ...(ditherer !== undefined && { ditherer }) }, phases })

	try {
		session.runner = runner
		options.onStart?.(runner)
		const result = await runner.handle.result
		return { sessionId, configuration, initial, result, events, devices: devices.entries, roots: roots.entries, leases: leases.entries }
	} finally {
		devices[Symbol.dispose]()
		roots[Symbol.dispose]()
		leases[Symbol.dispose]()
	}
}

function commandsOf(entries: readonly DeviceLogEntry[], command: string) {
	return entries.filter((entry): entry is DeviceCommandEntry => entry.kind === 'command' && entry.manager === 'mount' && entry.command === command)
}

// Sequence of the first event matching, from the shared runner log, or Infinity.
function eventSequence(roots: readonly RunnerLogEntry[], predicate: (event: SequencerEvent) => boolean) {
	return roots.find((entry) => entry.kind === 'event' && predicate(entry.event))?.sequence ?? Infinity
}

// Sequence of the first tracking transition of the rig mount to `value` after `after`, or Infinity.
function trackingSequence(entries: readonly DeviceLogEntry[], value: boolean, after = 0) {
	return entries.find((entry) => entry.kind === 'transition' && entry.manager === 'mount' && entry.property === 'tracking' && entry.value === value && entry.sequence > after)?.sequence ?? Infinity
}

// Meridian oracle of a session, with its lead and its persisted meridian cycle.
async function assertMeridianOracle(session: Session) {
	const { configuration } = session
	const { mount } = rig.devices()
	const checkpoint = await new FileSystemSequencerCheckpointStore(ROOT).load(session.sessionId)
	const lead = meridianHardProtectionLead(mountTrackingProtectionTimings(configuration, { mount }, {}))
	const log = [...session.devices, ...runtimeEntries(session.roots, session.sessionId)]
	assertMeridianProtectionInvariants(log, { mount: mount.name, flip: sequencerMeridianFlipSettings(configuration.meridianFlip!), lead, initial: session.initial, lightsTracked: true, ...(checkpoint?.meridianTransitAt !== undefined && { transitAt: checkpoint.meridianTransitAt }) })
	// 61: every root that leased the mount has its row in the motion table.
	assertMountKeyClosure(session.leases, sequencerMountMotionBounds(configuration, { mount }, undefined))
}

// Every oracle of a session.
async function assertOracles(session: Session) {
	assertSequencerInvariants(session.devices)
	assertRunnerInvariants(session.roots)
	await assertMeridianOracle(session)
	assertJournalInvariants(await readSequencerJournal(join(ROOT, session.sessionId, 'journal.jsonl')), session.events)
}

// Camera manager of a guide camera that exposes nothing.
class SilentCameraManager {
	addHandler() {}
	removeHandler() {}
	enableBlob() {}
	disableBlob() {}
	startExposure() {}
	stopExposure() {}
}

// Connected fake device whose resource key is its hardware id.
function fakeDevice<D extends Device>(base: D, name: string, hardwareId: string = name): D {
	return { ...base, id: name, name, hardwareId, connected: true }
}

const CAPABLE_MOUNT = fakeDevice<Mount>({ ...DEFAULT_MOUNT, canFlip: true, canTracking: true, hasPierSide: true, canAbort: true, hasGeographicCoordinate: true, hasEquatorialCoordinate: true }, 'Mount')
const FAKE_CAMERA = fakeDevice<Camera>(DEFAULT_CAMERA, 'Camera')
const FLIP: SequencerMeridianFlipConfiguration = { enabled: true, prepareAt: deg(-5), flipAt: 0, latestAt: deg(5), beforeFlipPierSide: 'WEST', afterFlipPierSide: 'EAST' }
const FAKE_TARGET: SequencerTarget = { frame: 'J2000', rightAscension: 1, declination: -0.5 }

describe('settings and policy', () => {
	test('optional fields resolve from the single default constant', () => {
		const settings = sequencerMeridianFlipSettings(FLIP)
		const { hardProtection, ...defaults } = DEFAULT_SEQUENCER_MERIDIAN_FLIP
		expect(settings).toEqual({ ...defaults, ...hardProtection, prepareAt: FLIP.prepareAt, flipAt: 0, latestAt: FLIP.latestAt, beforeFlipPierSide: 'WEST', afterFlipPierSide: 'EAST' })
		expect(sequencerMeridianFlipSettings({ ...FLIP, hardProtection: { trackingTimeout: 3 }, whilePaused: 'flip' })).toMatchObject({ trackingTimeout: 3, mountStopTimeout: 10, whilePaused: 'flip' })
	})

	test('the policy never allows an unknown pier side and recenters or settles only when the session can', () => {
		const configuration = configurationOf(FAKE_TARGET, FLIP)
		expect(toMeridianFlipPolicy(FLIP, configuration)).toEqual({ enabled: true, prepareAt: FLIP.prepareAt, flipAt: 0, latestAt: FLIP.latestAt, beforeFlipPierSide: 'WEST', afterFlipPierSide: 'EAST', allowUnknownPierSide: false, maxRetries: 1, requireRecentering: false, requireGuidingSettle: false })
		expect(toMeridianFlipPolicy(FLIP, { ...configuration, pointing: { settle: 0, onFailure: 'fail' } })).toMatchObject({ requireRecentering: true })
		expect(toMeridianFlipPolicy({ ...FLIP, requireRecentering: false, maxRetries: 3 }, { ...configuration, pointing: { settle: 0, onFailure: 'fail' } })).toMatchObject({ requireRecentering: false, maxRetries: 3 })
	})

	test('the post-flip effects apply once, only to a flip the session started', () => {
		const runtime = createSequencerRuntimeState(configurationOf(FAKE_TARGET, FLIP), 0)
		const policy = toMeridianFlipPolicy(FLIP, configurationOf(FAKE_TARGET, FLIP))
		runtime.anchors.lightExposures = 4
		runtime.meridianFlip = { phase: 'VERIFYING_PIER_SIDE', attempts: 1, preparationCompleted: true }
		runtime.meridianFlipVerification = { hourAngle: 0.01, pierSide: 'EAST', pierSideVerified: true }

		expect(advanceSequencerMeridianFlip(runtime, policy, { type: 'PIER_SIDE_CONFIRMED' })).toEqual({ type: 'meridianFlipCompleted', attempts: 1, hourAngle: 0.01, pierSide: 'EAST', pierSideVerified: true })
		expect(runtime).toMatchObject({ flippedSinceAutofocus: true, targetAcquired: true, ditherHeldAt: 4, meridianFlip: { phase: 'COMPLETED' } })
		expect(runtime.meridianFlipVerification).toBeUndefined()

		// Without a started flip, COMPLETED has no effect.
		const fresh = createSequencerRuntimeState(configurationOf(FAKE_TARGET, FLIP), 0)
		fresh.meridianFlip = { ...createMeridianFlipState(0), phase: 'VERIFYING_PIER_SIDE' }
		expect(advanceSequencerMeridianFlip(fresh, policy, { type: 'PIER_SIDE_CONFIRMED' })).toBeUndefined()
		expect(fresh.flippedSinceAutofocus).toBeFalse()
		expect(() => advanceSequencerMeridianFlip(fresh, policy, { type: 'FLIP_COMPLETED' })).toThrow('invalid Meridian Flip transition')
	})
})

describe('motion table, timings and lead', () => {
	const bounds = { mount: 'Mount', mountSettle: 500, ditherMovement: [] }

	test('mountKeyHolders: the mount movers, the tracking switches and nothing else', () => {
		const movers: SequencerTaskId[] = ['unparkMount', 'parkMount', 'meridianFlip', 'acquireOrRecenterTarget']
		const switches: SequencerTaskId[] = ['configureTracking', 'ensureTracking', 'stopTracking', 'protectMeridianWhilePaused', 'protectMeridianDuringStartup']
		const others: SequencerTaskId[] = [
			'bootstrapFocusBaseline',
			'quiesceGuiding',
			'quiesceDitherPulses',
			'coolCamera',
			'safetyGate',
			'openDome',
			'openCover',
			'awaitCameraRecovery',
			'prepareOpticalPath',
			'rotateField',
			'autofocus',
			'ensureGuiding',
			'ditherAndSettle',
			'awaitDarkTemperature',
			'prepareFrameDestination',
			'finalExposureGuard',
			'captureFrame',
			'pauseGuiding',
			'stopGuiding',
			'closeCover',
			'closeOrParkDome',
			'turnOffFlatPanel',
			'warmCamera',
		]

		for (const task of movers) expect(mountKeyHolders(task, bounds)).toEqual({ keys: ['Mount'], releaseBound: 500 })
		for (const task of switches) expect(mountKeyHolders(task, bounds)).toEqual({ keys: [], releaseBound: 0 })
		for (const task of others) expect(mountKeyHolders(task, bounds)).toBeUndefined()
		for (const task of [...movers, ...switches]) expect(mountKeyHolders(task, { mountSettle: 500, ditherMovement: [] })).toBeUndefined()

		const guideOutput = { key: 'ST4', device: fakeDevice<Camera>(DEFAULT_CAMERA, 'ST4') }
		expect(mountKeyHolders('ditherAndSettle', { ...bounds, ditherMovement: [{ request: guideOutput, releaseBound: 4000 }] })).toEqual({ keys: ['ST4'], releaseBound: 4000 })
	})

	test('timings and lead: each part is the bound the protection waits, the mount settle present with a meridian flip', () => {
		const configuration = configurationOf(FAKE_TARGET, { ...FLIP, hardProtection: { mountStopTimeout: 7, guidingStopTimeout: 3, trackingTimeout: 4 } })
		const devices = { camera: FAKE_CAMERA, mount: CAPABLE_MOUNT }
		const timings = mountTrackingProtectionTimings(configuration, devices, {})
		expect(timings).toEqual({ pause: 0, guidingStop: 0, mountSettle: 7000, tracking: 4000, guidingBound: 0, mountMotionReleaseBound: 7000, trackingBound: 4000, dominantTask: 'unparkMount', bound: 11000 })
		expect(meridianHardProtectionLead(timings)).toEqual({ supervisionJitter: SEQUENCER_SUPERVISION_JITTER, guidingBound: 0, mountMotionReleaseBound: 7000, trackingTimeout: 4000, dominantTask: 'unparkMount', lead: 12000 })

		// Without a meridian flip the step timeout bounds the mount and the tracking; with no mount only guiding counts.
		const plain = { ...configuration, target: undefined, meridianFlip: undefined, shutdown: { stepTimeout: 2, totalTimeout: 60, stopTracking: 'required' as const } }
		expect(mountTrackingProtectionTimings(plain, devices, {})).toMatchObject({ mountSettle: 2000, tracking: 2000, mountMotionReleaseBound: 2000, bound: 4000 })
		expect(mountTrackingProtectionTimings(plain, {}, {})).toMatchObject({ mountMotionReleaseBound: 0, trackingBound: 0, bound: 0 })
	})

	test('62: without a meridian flip each row of the motion table takes the step timeout; a pulse dither its own release bound', () => {
		const devices = { camera: FAKE_CAMERA, mount: CAPABLE_MOUNT }
		const base = configurationOf(FAKE_TARGET, FLIP)
		const plain: SequencerConfiguration = { ...base, target: undefined, meridianFlip: undefined, startup: { onFailure: 'fail' }, shutdown: { stepTimeout: 2, totalTimeout: 60 } }
		const dither = { afterFrames: 1, amount: { unit: 'angle' as const, value: deg(1 / 3600) }, raOnly: false, settle: { kind: 'mechanical' as const, time: 0 }, onFailure: 'skip' as const }
		const pulser = new MountDitherer(CAPABLE_MOUNT, FAKE_CAMERA, {}, { method: 'pulse', pattern: 'random', rightAscensionDirection: 'EAST', declinationDirection: 'NORTH', maxPulseDuration: 1000 })
		const slewer = new MountDitherer(CAPABLE_MOUNT, undefined, {}, { method: 'slew', pattern: 'random', maxPulseDuration: 1000 })
		const bound = (configuration: SequencerConfiguration, ditherer?: MountDitherer) => mountTrackingProtectionTimings(configuration, devices, ditherer === undefined ? {} : { ditherer })

		// Only the track mode: it leases the mount without moving it.
		expect(bound({ ...plain, startup: { mount: { unpark: false, trackMode: 'SIDEREAL' }, onFailure: 'fail' } })).toMatchObject({ mountMotionReleaseBound: 0, dominantTask: 'configureTracking' })
		// Unpark, park, pointing and a dither slew: the step timeout.
		expect(bound({ ...plain, startup: { mount: { unpark: true }, onFailure: 'fail' } })).toMatchObject({ mountMotionReleaseBound: 2000, dominantTask: 'unparkMount' })
		expect(bound({ ...plain, shutdown: { ...plain.shutdown, parkMount: 'required' } })).toMatchObject({ mountMotionReleaseBound: 2000, dominantTask: 'parkMount' })
		expect(bound({ ...plain, target: FAKE_TARGET, pointing: { settle: 0.1, onFailure: 'fail' } })).toMatchObject({ mountMotionReleaseBound: 2000, dominantTask: 'acquireOrRecenterTarget' })
		expect(bound({ ...plain, dither }, slewer)).toMatchObject({ mountMotionReleaseBound: 2000, dominantTask: 'ditherAndSettle' })
		// A pulse dither: the release bound of its guide output, the largest row.
		expect(bound({ ...plain, dither, startup: { mount: { unpark: true }, onFailure: 'fail' } }, pulser)).toMatchObject({ mountMotionReleaseBound: guidePulseReleaseBound(1000), dominantTask: 'ditherAndSettle' })
	})

	test('aliases of the mount: every device role sharing its hardware, and a guide camera held by the guiding', () => {
		const dome = fakeDevice<Dome>(DEFAULT_DOME, 'Dome', 'Mount')
		expect(mountKeyAliases({ camera: FAKE_CAMERA, mount: CAPABLE_MOUNT })).toEqual([])
		expect(mountKeyAliases({ camera: FAKE_CAMERA, mount: CAPABLE_MOUNT, dome })).toEqual(['dome'])
		expect(mountKeyAliases({ camera: FAKE_CAMERA, mount: CAPABLE_MOUNT }, [{ key: 'Mount', device: fakeDevice<Camera>(DEFAULT_CAMERA, 'Guide', 'Mount') }])).toEqual(['guideCamera'])
		expect(mountKeyAliases({ camera: FAKE_CAMERA, dome })).toEqual([])
	})
})

describe('deadlines, guard and decision', () => {
	const settings = sequencerMeridianFlipSettings({ ...FLIP, flipAt: 0, latestAt: deg(5), protectionMargin: 120, exposureMargin: 30 })
	const B = settings.latestAt - 120 * SECOND

	test('49.7 1: HA_end advances by (T + exposureMargin) at the sidereal rate: one hour of exposure is 0.2625 rad', () => {
		// Independent reference: one sidereal day (86164.0905 s of SI time) is a full turn of hour angle.
		const reference = (TAU / 86164.0905) * 3600
		expect(reference).toBeCloseTo(0.2625, 4)
		expect(3600 * SIDEREAL_DRIFT_RATE).toBeCloseTo(reference, 12)

		// The guard boundary of a one-hour exposure sits exactly that span, plus the margin, before the graceful deadline.
		const input = { pierSide: 'WEST' as const, offTarget: false, exposure: 3600 }
		const boundary = B - (3600 + 30) * SIDEREAL_DRIFT_RATE
		expect(B - boundary).toBeCloseTo(reference + 30 * SIDEREAL_DRIFT_RATE, 12)
		expect(sequencerMeridianGuard(settings, { ...input, decisionHourAngle: boundary - 1e-9 })).toEqual({ kind: 'expose' })
		expect(sequencerMeridianGuard(settings, { ...input, decisionHourAngle: boundary })).not.toEqual({ kind: 'expose' })
	})

	test('49.7 3: the wait until flipAt is finite and positive for every refused hour angle before it; none past it', () => {
		const input = { pierSide: 'WEST' as const, offTarget: false, exposure: 3600 }

		for (const decisionHourAngle of [-deg(179.9), -deg(90), -deg(10), settings.flipAt - 1e-6]) {
			const decision = sequencerMeridianGuard(settings, { ...input, exposure: 20 * 3600, decisionHourAngle })
			if (decision.kind !== 'wait') continue
			expect(decision.ms).toBeGreaterThan(0)
			expect(decision.ms).toBeLessThanOrEqual(((settings.flipAt - decisionHourAngle) / SIDEREAL_DRIFT_RATE) * 1000)
		}

		// Near +π a pre-flip mount is long past the limit: the flip is due, never a wait (negative or wrapped).
		expect(sequencerMeridianGuard(settings, { ...input, decisionHourAngle: deg(179.9) })).toMatchObject({ kind: 'reenter', reason: 'the meridian flip is due' })
	})

	test('49.7 4: a long exposure passes the preflight; refused near the meridian with a finite wait, exposed after the flip', () => {
		const long = sequencerMeridianFlipSettings({ ...FLIP, flipAt: 0, latestAt: deg(5), protectionMargin: 120, exposureMargin: 30 })
		const exposure = 4 * 3600
		// Longer than the whole window between flipAt and latestAt.
		expect(exposure * SIDEREAL_DRIFT_RATE).toBeGreaterThan(long.latestAt - long.flipAt)
		const configuration = configurationOf(FAKE_TARGET, { ...FLIP, protectionMargin: 120 })
		const lights = { ...configuration, capture: { ...configuration.capture, groups: [{ kind: 'scheduled' as const, id: 'L', enabled: true, capture: { ...LIGHT, exposureTime: exposure, exposureTimeUnit: 'second' as const }, count: 1 }] } }
		expect(preflightSequencerMeridian(lights, { camera: FAKE_CAMERA, mount: CAPABLE_MOUNT }, { mountCommander: rig.commanders.mount })).toEqual([])

		const input = { pierSide: 'WEST' as const, offTarget: false, exposure }
		// Far from the meridian it fits.
		expect(sequencerMeridianGuard(long, { ...input, decisionHourAngle: -deg(90) })).toEqual({ kind: 'expose' })
		// Near it: a finite wait until flipAt, then the flip is due, and on the post-flip side it is exposed.
		const near = sequencerMeridianGuard(long, { ...input, decisionHourAngle: -deg(30) })
		expect(near).toMatchObject({ kind: 'wait' })
		expect((near as { ms: number }).ms).toBeCloseTo((deg(30) / SIDEREAL_DRIFT_RATE) * 1000, 6)
		expect(sequencerMeridianGuard(long, { ...input, decisionHourAngle: long.flipAt })).toMatchObject({ kind: 'reenter', reason: 'the meridian flip is due' })
		expect(sequencerMeridianGuard(long, { ...input, pierSide: 'EAST', decisionHourAngle: long.flipAt })).toEqual({ kind: 'expose' })
	})

	test('49.7 5: the post-flip side comes only from the telemetry; a pre-flip side read in COMPLETED applies the thresholds', () => {
		const configuration = configurationOf(FAKE_TARGET, { ...FLIP, protectionMargin: 120, exposureMargin: 30 })
		const wallNow = Date.UTC(2031, 2, 20)
		const lst = localSiderealTime(timeUnix(wallNow / 1000), 0)
		// A guard over a mount tracking at the physical hour angle `hourAngle` (also the decision one: the target is acquired
		// there) with `pierSide` read, in the flip phase `phase`, for a frame of `frameType`.
		const guard = (pierSide: PierSide, phase: MeridianFlipStatePhase, frameType: 'LIGHT' | 'DARK', hourAngle: Angle) => {
			const mount = { ...CAPABLE_MOUNT, tracking: true, trackMode: 'SIDEREAL' as const, pierSide, geographicCoordinate: { latitude: 0, longitude: 0, elevation: 0 }, equatorialCoordinate: { rightAscension: normalizeAngle(lst - hourAngle), declination: 0 } }
			const state = createSequencerRuntimeState(configuration, wallNow)
			state.meridianFlip = { ...createMeridianFlipState(1), phase }
			state.targetAcquired = true
			state.meridianTransitAt = wallNow
			const frame = { id: 'frame[L][1]', groupId: 'L', kind: 'scheduled', ordinal: 1, attempt: 1, discardedTotal: 0, discardBudgetUsed: 0, captureFailures: 0, capture: { ...LIGHT, frameType } } as const
			const view = { sessionId: 'session', configuration: { ...configuration, target: undefined }, devices: { camera: FAKE_CAMERA, mount }, clock: { ...clock, wallNow: () => wallNow }, state, frame } as unknown as SequencerTaskView
			return sequencerExposureGuard(view)
		}

		// FLIP goes from WEST to EAST. A flip recovery deferred to the next light (darks between) exposes a dark on the
		// post-flip side read, never a light.
		expect(guard('EAST', 'RECENTERING', 'DARK', deg(3))).toEqual({ kind: 'expose' })
		expect(guard('EAST', 'RECENTERING', 'LIGHT', deg(3))).toMatchObject({ kind: 'reenter' })
		// NEITHER never exposes.
		expect(guard('NEITHER', 'COMPLETED', 'DARK', deg(3))).toMatchObject({ kind: 'reenter' })
		// COMPLETED with the pre-flip side read: the thresholds apply again (I65); with the post-flip one they do not.
		expect(guard('WEST', 'COMPLETED', 'DARK', deg(4.5))).toMatchObject({ kind: 'reenter', reason: 'the meridian flip is due' })
		expect(guard('EAST', 'COMPLETED', 'DARK', deg(4.5))).toEqual({ kind: 'expose' })
	})

	test('95: near the pole the decision hour angle of an acquired target is the larger of the mount and the target', () => {
		const wallNow = Date.UTC(2031, 2, 20)
		const lst = localSiderealTime(timeUnix(wallNow / 1000), 0)
		const mountAt = (hourAngle: Angle) => ({ ...CAPABLE_MOUNT, tracking: true, geographicCoordinate: { latitude: deg(40), longitude: 0, elevation: 0 }, equatorialCoordinate: { rightAscension: normalizeAngle(lst - hourAngle), declination: deg(89.5) } })
		// J2000 target at the hour angle −10° of date, δ = 89.5°.
		const [ra, dec] = equatorialToJ2000(normalizeAngle(lst + deg(10)), deg(89.5), timeUnix(wallNow / 1000))
		const target: SequencerTarget = { frame: 'J2000', rightAscension: normalizeAngle(ra), declination: dec }

		for (const lag of [-deg(2), deg(2)]) {
			const observation = observeSequencerMeridian(mountAt(-deg(10) + lag), target, wallNow)
			expect(observation.targetHourAngle!).toBeCloseTo(-deg(10), 3)
			expect(observation.mountHourAngle!).toBeCloseTo(-deg(10) + lag, 9)
			// Acquired: the larger; not acquired: the target; without a target: the mount.
			expect(sequencerDecisionHourAngle(observation, true, true)).toBe(Math.max(observation.targetHourAngle!, observation.mountHourAngle!))
			expect(sequencerDecisionHourAngle(observation, true, false)).toBe(observation.targetHourAngle)
			expect(sequencerDecisionHourAngle(observation, false, false)).toBe(observation.mountHourAngle)
		}
	})

	test('one hour of hour angle is 3590.17 s of SI time, from the single sidereal rate', () => {
		expect(TAU / 24 / SIDEREAL_DRIFT_RATE).toBeCloseTo(3590.17, 2)
	})

	test('the protection deadline is the wall instant the physical hour angle reaches latestAt minus the lead', () => {
		const observation = { at: 1_000_000, hourAngle: -deg(1), pierSide: 'WEST' as const, tracking: true }
		expect(meridianProtectionDeadline(settings, observation, 0)).toBeCloseTo(1_000_000 + ((deg(5) + deg(1)) / SIDEREAL_DRIFT_RATE) * 1000, 3)
		expect(meridianProtectionDeadline(settings, observation, 120_000)).toBeCloseTo(1_000_000 + ((deg(6) - 120 * SECOND) / SIDEREAL_DRIFT_RATE) * 1000, 3)
		// NEITHER is pre-flip; post-flip and tracking off have no deadline.
		expect(meridianProtectionDeadline(settings, { ...observation, pierSide: 'NEITHER' }, 0)).toBeDefined()
		expect(meridianProtectionDeadline(settings, { ...observation, pierSide: 'EAST' }, 0)).toBeUndefined()
		expect(meridianProtectionDeadline(settings, { ...observation, tracking: false }, 0)).toBeUndefined()
	})

	test('guard: post-flip exposes, NEITHER re-enters, HA_end must stay strictly before the graceful deadline', () => {
		const exposure = 60
		const span = (exposure + 30) * SECOND
		const input = { pierSide: 'WEST' as const, offTarget: false, exposure }

		expect(sequencerMeridianGuard(settings, { ...input, pierSide: 'EAST', decisionHourAngle: deg(10) })).toEqual({ kind: 'expose' })
		expect(sequencerMeridianGuard(settings, { ...input, pierSide: 'NEITHER', decisionHourAngle: -deg(30) })).toMatchObject({ kind: 'reenter' })
		expect(sequencerMeridianGuard(settings, { ...input, decisionHourAngle: B - span - 1e-9 })).toEqual({ kind: 'expose' })
		// HA_end exactly at B, and between B and latestAt, refuse: past flipAt the flip is due at once.
		expect(sequencerMeridianGuard(settings, { ...input, decisionHourAngle: B - span })).toMatchObject({ kind: 'reenter', reason: 'the meridian flip is due' })
		expect(sequencerMeridianGuard(settings, { ...input, decisionHourAngle: B - span + 60 * SECOND })).toMatchObject({ kind: 'reenter' })
		// A long exposure refused before flipAt waits exactly until flipAt.
		const long = { ...input, exposure: 3600 }
		const longSpan = (3600 + 30) * SECOND
		expect(B - longSpan).toBeLessThan(settings.flipAt)
		const atB = sequencerMeridianGuard(settings, { ...long, decisionHourAngle: B - longSpan })
		expect(atB).toMatchObject({ kind: 'wait' })
		expect((atB as { ms: number }).ms).toBeCloseTo(((settings.flipAt - (B - longSpan)) / SIDEREAL_DRIFT_RATE) * 1000, 6)
		expect(sequencerMeridianGuard(settings, { ...long, decisionHourAngle: B - longSpan - 1e-9 })).toEqual({ kind: 'expose' })
		// A due flip still lets a frame that ends before the deadline go; the flip runs at the next safe point.
		expect(sequencerMeridianGuard(settings, { ...input, decisionHourAngle: settings.flipAt })).toEqual({ kind: 'expose' })
		// Far from the meridian, even a long exposure fits; HA near −π gives no negative or huge wait.
		expect(sequencerMeridianGuard(settings, { ...input, exposure: 4 * 3600, decisionHourAngle: -deg(179) })).toEqual({ kind: 'expose' })
		// Off target, the physical hour angle must fit as well.
		expect(sequencerMeridianGuard(settings, { ...input, offTarget: true, decisionHourAngle: -deg(30), mountHourAngle: B })).toMatchObject({ kind: 'reenter', reason: 'the mount is off its target in the meridian zone' })
	})

	test('decision hour angle: physical without a target, the target until acquired, then the larger', () => {
		const observation = { mountHourAngle: 0.2, targetHourAngle: 0.1 }
		expect(sequencerDecisionHourAngle(observation, false, false)).toBe(0.2)
		expect(sequencerDecisionHourAngle(observation, true, false)).toBe(0.1)
		expect(sequencerDecisionHourAngle(observation, true, true)).toBe(0.2)
		expect(sequencerDecisionHourAngle({ mountHourAngle: 0.1, targetHourAngle: 0.2 }, true, true)).toBe(0.2)
		expect(sequencerDecisionHourAngle({ targetHourAngle: 0.2 }, true, true)).toBe(0.2)
	})

	test('the single cycle is anchored at the nearest upper transit, half a sidereal day each way, end excluded', () => {
		const now = Date.UTC(2031, 2, 20)
		const transit = sequencerMeridianTransitAt(now, deg(15))
		expect(now - transit).toBeCloseTo((deg(15) / SIDEREAL_DRIFT_RATE) * 1000, 6)
		expect(isWithinSequencerMeridianCycle(transit, transit - SEQUENCER_MERIDIAN_HALF_CYCLE)).toBeTrue()
		expect(isWithinSequencerMeridianCycle(transit, transit + SEQUENCER_MERIDIAN_HALF_CYCLE - 1)).toBeTrue()
		expect(isWithinSequencerMeridianCycle(transit, transit + SEQUENCER_MERIDIAN_HALF_CYCLE)).toBeFalse()
	})

	test('no sidereal-day literal in the hour-angle code of the Sequencer', () => {
		const directory = join(import.meta.dir, '../../../src/observation/sequencer')
		for (const file of readdirSync(directory)) expect(readFileSync(join(directory, file), 'utf8')).not.toMatch(/86164|86400|15 \/ 3600/)
	})
})

describe('preflight', () => {
	const devices = { camera: FAKE_CAMERA, mount: CAPABLE_MOUNT }
	const services = { mountCommander: rig.commanders.mount }
	const configuration = configurationOf(FAKE_TARGET, { ...FLIP, protectionMargin: 120 })

	test('a capable mount and a consistent configuration pass', () => {
		expect(preflightSequencerMeridian(configuration, devices, services)).toEqual([])
	})

	test('every missing capability of the mount is named, with no command', () => {
		const mount = fakeDevice<Mount>({ ...DEFAULT_MOUNT, trackModes: ['LUNAR'], trackMode: 'LUNAR' }, 'Mount')
		const paths = preflightSequencerMeridian(configuration, { camera: FAKE_CAMERA, mount }, services).map((diagnostic) => diagnostic.message)
		for (const flag of ['canFlip', 'canTracking', 'hasPierSide', 'canAbort', 'hasGeographicCoordinate', 'hasEquatorialCoordinate']) expect(paths.some((message) => message.endsWith(`must publish ${flag} for a meridian flip`))).toBeTrue()
		expect(paths).toContain('Mount offers no SIDEREAL track mode')
		expect(preflightSequencerMeridian(configuration, devices, {})).toContainEqual({ path: 'meridianFlip', message: 'requires a mount commander' })
	})

	test('the protection margin covers the hard lead exactly; the flip window is continuous to the second of arc', () => {
		// Lead with the defaults: 1 + 10 + 10 s.
		expect(preflightSequencerMeridian(configurationOf(FAKE_TARGET, { ...FLIP, protectionMargin: 21 }), devices, services)).toEqual([])
		expect(preflightSequencerMeridian(configurationOf(FAKE_TARGET, { ...FLIP, protectionMargin: 20.999 }), devices, services)).toEqual([
			expect.objectContaining({ path: 'meridianFlip.protectionMargin', message: expect.stringContaining('21 s, the hard protection lead (supervision jitter 1 s, guiding 0 s, mount motion 10 s by unparkMount, tracking 10 s)') }),
		])

		const latestAt = FLIP.flipAt + 120 * SIDEREAL_DRIFT_RATE
		expect(preflightSequencerMeridian(configurationOf(FAKE_TARGET, { ...FLIP, protectionMargin: 120, latestAt }), devices, services)).toEqual([])
		expect(preflightSequencerMeridian(configurationOf(FAKE_TARGET, { ...FLIP, protectionMargin: 120, latestAt: latestAt - deg(1 / 3600) }), devices, services)).toEqual([expect.objectContaining({ path: 'meridianFlip.latestAt' })])
	})

	test('the shutdown total covers the tracking protection; no device shares the mount under hard protection', () => {
		expect(preflightSequencerMeridian({ ...configuration, shutdown: { ...configuration.shutdown, totalTimeout: 19.999 } }, devices, services)).toContainEqual(expect.objectContaining({ path: 'shutdown.totalTimeout' }))
		const dome = fakeDevice<Dome>(DEFAULT_DOME, 'Dome', 'Mount')
		expect(preflightSequencerMeridian(configuration, { ...devices, dome }, services)).toContainEqual(expect.objectContaining({ path: 'devices.dome' }))
		// Without hard protection the topology is accepted.
		expect(preflightSequencerMeridian({ ...configuration, meridianFlip: undefined }, { ...devices, dome }, services)).toEqual([])
		// A recentering needs pointing.
		expect(preflightSequencerMeridian(configurationOf(FAKE_TARGET, { ...FLIP, protectionMargin: 120, requireRecentering: true }), devices, services)).toContainEqual(expect.objectContaining({ path: 'meridianFlip.requireRecentering' }))
	})
})

describe('sessions', () => {
	test('the guard waits for flipAt, the flip runs after its durable budget, the pier side is verified, the target recentered, then the light is exposed', async () => {
		const placed = await placeMount(-1 * SECOND, false)
		const flip = meridianFlipOf(placed.hourAngle, 1.5, MARGIN + 1.5)
		const configuration = configurationOf(placed.target, flip, { pointing: { settle: 0.1, onFailure: 'fail' } })
		const session = await runSession(configuration)
		const { result, events, devices, roots } = session

		expect(result).toMatchObject({ state: 'completed' })
		expect(rig.devices().mount.pierSide).toBe('EAST')

		// The guard refused the light before the flip and waited for flipAt, then the flip ran once.
		const flips = commandsOf(devices, 'flipTo')
		expect(flips).toHaveLength(1)
		// The wall clock is the simulated UTC of the mount, published on its own tick: a wake landing before the tick that
		// reaches flipAt is refused once more, with a short wait, and never consumes the attempt.
		const guardDeferred = (await readSequencerJournal(join(ROOT, session.sessionId, 'journal.jsonl'))).filter((entry) => entry.kind === 'deferred')
		expect(guardDeferred.length).toBeGreaterThanOrEqual(1)
		for (const deferred of guardDeferred) expect(deferred).toMatchObject({ reason: 'guard', attempt: 1 })
		expect(events.filter((event) => event.type === 'exposureStarted')).toEqual([expect.objectContaining({ slot: 'frame[L][1]', attempt: 1 })])
		expect(eventSequence(roots, (event) => event.type === 'exposureStarted')).toBeGreaterThan(flips[0].sequence)

		// The flip converted the J2000 target at the wall instant of the command, with the budget saved before it.
		const flipTask = roots.findLast((entry) => entry.kind === 'event' && entry.event.type === 'taskStarted' && entry.event.task === 'meridianFlip' && entry.sequence < flips[0].sequence)!
		expect(roots.some((entry) => entry.kind === 'event' && entry.event.type === 'checkpointSaved' && entry.sequence > flipTask.sequence && entry.sequence < flips[0].sequence)).toBeTrue()
		const checkpoint = await new FileSystemSequencerCheckpointStore(ROOT).load(session.sessionId)
		expect(checkpoint).toMatchObject({ meridianFlipAttempts: 1 })
		expect(checkpoint!.meridianTransitAt).toBeGreaterThan(0)
		expect(checkpoint!.mountRiskObservation).toBeDefined()

		// One completion, verified by the commander, by the recenter after the flip (the flip left the mount on the target,
		// so the recenter slew had nothing to command).
		expect(events.filter((event) => event.type === 'meridianFlipCompleted')).toEqual([expect.objectContaining({ attempts: 1, pierSide: 'EAST', pierSideVerified: true })])
		const recenter = roots.find((entry) => entry.kind === 'event' && entry.event.type === 'taskStarted' && entry.event.task === 'acquireOrRecenterTarget' && entry.sequence > flips[0].sequence)!
		const completed = eventSequence(roots, (event) => event.type === 'meridianFlipCompleted')
		expect(completed).toBeGreaterThan(recenter.sequence)
		expect(completed).toBeLessThan(eventSequence(roots, (event) => event.type === 'exposureStarted'))
		// The light was exposed with tracking on (I67); no protection was needed.
		const exposureSequence = eventSequence(roots, (event) => event.type === 'exposureStarted')
		expect(devices.findLast((entry) => entry.kind === 'transition' && entry.manager === 'mount' && entry.property === 'tracking' && entry.sequence < exposureSequence)).toMatchObject({ value: true })
		expect(events.some((event) => event.type === 'meridianHardProtection' || event.type === 'meridianProtectionFailed' || event.type === 'meridianProtectionLateStart')).toBeFalse()
		// The closure of the motion table is judged over real leases of the mount: flip, acquisition and tracking.
		const leasing = new Set(session.leases.filter((lease) => lease.keys.includes(resourceKey(rig.devices().mount))).map((lease) => lease.root))
		for (const root of ['sequencer.meridianFlip', 'sequencer.acquireOrRecenterTarget', 'sequencer.ensureTracking']) expect(leasing).toContain(root)
		await assertOracles(session)
	})

	test('50.3 18: a flip during a cover dark verifies the side without centering; the next light opens the cover, then recenters', async () => {
		const placed = await placeMount(-1 * SECOND, true)
		const flip = meridianFlipOf(placed.hourAngle, 0.5, MARGIN + 5)
		const DARK: SequencerCameraCapture = { ...LIGHT, exposureTime: 10, frameType: 'DARK' }
		const base = configurationOf(placed.target, flip, { pointing: { settle: 0.1, onFailure: 'fail' } })
		const groups: SequencerConfiguration['capture']['groups'] = [{ kind: 'triggered', id: 'D', enabled: true, capture: DARK, trigger: { kind: 'sessionStart' }, batchSize: 1, maxFrames: 1, inherit: 'none', opticalPath: { kind: 'cover' } }, ...base.capture.groups]
		const configuration: SequencerConfiguration = { ...base, capture: { ...base.capture, groups } }
		const { cover } = rig.devices()
		const opticalPath = prepareOpticalPathTask({ coverCommander: rig.commanders.cover })
		const session = await runSession(configuration, { extra: [opticalPath], devices: { cover } })
		const { result, events, devices, roots } = session

		expect(result).toMatchObject({ state: 'completed' })
		expect(rig.devices().mount.pierSide).toBe('EAST')
		const selected = (slot: string) => eventSequence(roots, (event) => event.type === 'frameSelected' && event.frame.id === slot)
		const exposure = (frameType: string) => devices.find((entry) => entry.kind === 'command' && entry.manager === 'camera' && entry.command === 'frameType' && entry.args[0] === frameType)!.sequence
		const [darkSelected, lightSelected] = [selected('frame[D][1]'), selected('frame[L][1]')]

		// The flip and its side verification ran in the pre-capture of the dark (re-entered by the guard until the flip was
		// due), which closed the cover and never centered.
		const flips = commandsOf(devices, 'flipTo')
		expect(flips).toHaveLength(1)
		expect(flips[0].sequence).toBeGreaterThan(darkSelected)
		expect(flips[0].sequence).toBeLessThan(exposure('DARK'))
		const park = devices.find((entry) => entry.kind === 'command' && entry.manager === 'cover' && entry.command === 'park')!
		expect(park.sequence).toBeGreaterThan(darkSelected)
		expect(park.sequence).toBeLessThan(exposure('DARK'))
		const pointed = roots.filter((entry) => entry.kind === 'event' && entry.event.type === 'taskStarted' && entry.event.task === 'acquireOrRecenterTarget').map((entry) => entry.sequence)
		expect(pointed.filter((sequence) => sequence > darkSelected && sequence < lightSelected)).toEqual([])

		// The light opened the cover before its recenter, and the flip completed only then, before the light was exposed.
		const unpark = devices.find((entry) => entry.kind === 'command' && entry.manager === 'cover' && entry.command === 'unpark')!
		const recenter = pointed.find((sequence) => sequence > lightSelected)!
		expect(unpark.sequence).toBeGreaterThan(lightSelected)
		expect(unpark.sequence).toBeLessThan(recenter)
		const completed = eventSequence(roots, (event) => event.type === 'meridianFlipCompleted')
		expect(completed).toBeGreaterThan(recenter)
		expect(completed).toBeLessThan(exposure('LIGHT'))
		expect(events.filter((event) => event.type === 'meridianFlipCompleted')).toEqual([expect.objectContaining({ pierSide: 'EAST', pierSideVerified: true })])

		assertSequencerInvariants(devices, { coverDarks: true })
		await assertOracles(session)
	})

	test('49.7 8: a session in 2031 on a 2026 host converts every target at the wall instant of its command, as the guard does', async () => {
		const { mount } = rig.devices()
		rig.managers.mount.time(mount, { utc: Date.UTC(2031, 2, 20, 0, 0, 0), offset: 0 })
		await waitUntil(() => new Date(clock.wallNow()).getUTCFullYear() === 2031, 5000, 10)

		try {
			const placed = await placeMount(-1 * SECOND, false)
			const flip = meridianFlipOf(placed.hourAngle, 1.5, MARGIN + 1.5)
			const configuration = configurationOf(placed.target, flip, { pointing: { settle: 0.1, onFailure: 'fail' } })

			// Commander calls with their time option and the wall instant of the call; manager commands with the JNOW sent.
			type Call = { readonly kind: 'commander'; readonly target: MountTargetCoordinate<string | Angle>; readonly time?: Time; readonly wallNow: number } | { readonly kind: 'manager'; readonly coordinate: readonly [Angle, Angle] }
			const calls: Call[] = []
			const commander = rig.commanders.mount
			const spies = (['goTo', 'flip', 'sync'] as const).map((name) => {
				const original = commander[name].bind(commander) as (...args: unknown[]) => unknown
				const record = (...args: unknown[]) => {
					const [, , target, options] = args as [unknown, unknown, MountTargetCoordinate<string | Angle>, MountCommandOptions | undefined]
					calls.push({ kind: 'commander', target, ...(options?.time !== undefined && { time: options.time }), wallNow: clock.wallNow() })
					return original(...args)
				}
				return spyOn(commander, name).mockImplementation(record as never)
			})
			const managers = (['goTo', 'flipTo', 'syncTo'] as const).map((name) => {
				const original = rig.managers.mount[name].bind(rig.managers.mount)
				return spyOn(rig.managers.mount, name).mockImplementation((device, rightAscension, declination, client) => {
					calls.push({ kind: 'manager', coordinate: [rightAscension, declination] })
					original(device, rightAscension, declination, client)
				})
			})

			let session: Session

			try {
				session = await runSession(configuration)
			} finally {
				for (const spy of [...spies, ...managers]) spy.mockRestore()
			}

			expect(session.result).toMatchObject({ state: 'completed' })
			const commands = calls.filter((call) => call.kind === 'commander')
			expect(commands.length).toBeGreaterThanOrEqual(2)
			expect(commands.some((call) => call.target.type === 'J2000')).toBeTrue()
			let last: Extract<Call, { kind: 'commander' }> | undefined

			for (const call of calls) {
				if (call.kind === 'commander') {
					// The time of every command is the wall instant of the session clock at the call, never the host clock.
					const expected = timeUnix(call.wallNow / 1000)
					expect([call.time!.day, call.time!.fraction]).toEqual([expected.day, expected.fraction])
					last = call
					continue
				}

				// Bit for bit the conversion of the command instant; with the host instant it would differ by minutes of arc.
				const converted = mountTargetEquatorial(mount, last!.target, last!.time)
				expect(call.coordinate).toEqual(converted)
				const host = mountTargetEquatorial(mount, last!.target, timeNow(true))
				if (last!.target.type === 'J2000') expect(Math.abs(normalizePI(host[0] - converted[0]))).toBeGreaterThan(deg(200 / 3600))
			}

			// The guard reads the target with the same conversion at its instant (I32).
			const at = clock.wallNow()
			const observation = observeSequencerMeridian(mount, placed.target, at)
			const [rightAscension] = mountTargetEquatorial(mount, { type: 'J2000', J2000: { x: placed.target.rightAscension, y: placed.target.declination } }, timeUnix(at / 1000))
			expect(observation.targetHourAngle).toBe(normalizePI(localSiderealTime(timeUnix(at / 1000), mount.geographicCoordinate.longitude) - rightAscension))
			await assertOracles(session)
		} finally {
			rig.managers.mount.time(mount, { utc: Date.now(), offset: 0 })
			await waitUntil(() => Math.abs(clock.wallNow() - Date.now()) < 60000, 5000, 10)
		}
	})

	test('a task that ignores its cancellation never delays the hard path: tracking goes off before latestAt, then the flip runs with tracking off', async () => {
		const placed = await placeMount(-1 * SECOND, false)
		const flip = meridianFlipOf(placed.hourAngle, 2, MARGIN + 0.3)
		let release: VoidFunction | undefined
		let runs = 0
		const stuck: SequencerTask = {
			id: 'autofocus',
			shouldRun: () => true,
			run: () => {
				// The first execution only ends when the test releases it, whatever its root says.
				if (runs++ > 0) return Promise.resolve({ ok: true })
				return new Promise((resolve) => {
					release = () => resolve({ ok: false, failure: { kind: 'operation', reason: 'aborted' } })
				})
			},
		}

		const session = await runSession(configurationOf(placed.target, flip), {
			extra: [stuck],
			onEvent: (event) => {
				if (event.type === 'meridianHardProtection') release?.()
			},
		})
		const { result, events, devices, roots } = session

		expect(result).toMatchObject({ state: 'completed' })
		// The graceful request could not preempt the stuck task; the hard path turned tracking off before latestAt.
		const hard = events.find((event) => event.type === 'meridianHardProtection')
		expect(hard).toMatchObject({ late: false, latestAt: flip.latestAt, leadMs: LEAD })
		expect((hard as { hourAngle: Angle }).hourAngle).toBeLessThan(flip.latestAt)
		const off = trackingSequence(devices, false)
		expect(off).toBeLessThan(eventSequence(roots, (event) => event.type === 'meridianHardProtection'))
		// The root of the protection opened while the stuck task was still alive.
		const protect = roots.find((entry) => entry.kind === 'root' && entry.event === 'start' && entry.operation === 'sequencer.protect.meridianHard')!
		const stuckEnd = roots.find((entry) => entry.kind === 'root' && entry.event === 'end' && entry.operation === 'sequencer.autofocus')!
		expect(protect.sequence).toBeLessThan(stuckEnd.sequence)
		// The flip ran afterwards, with tracking off, and the light was exposed on the post-flip side.
		const flips = commandsOf(devices, 'flipTo')
		expect(flips).toHaveLength(1)
		expect(flips[0].sequence).toBeGreaterThan(off)
		expect(events.filter((event) => event.type === 'meridianFlipCompleted')).toHaveLength(1)
		expect(events.filter((event) => event.type === 'exposureStarted')).toHaveLength(1)
		await assertOracles(session)
	})

	test('arming with less than the lead left starts the hard path before any command and reports a late start', async () => {
		const placed = await placeMount(-1 * SECOND, true)
		// latestAt 1.2 s ahead: less than the 2 s lead.
		const flip = meridianFlipOf(placed.hourAngle, 1.2 - MARGIN - 0.2, MARGIN + 0.2)
		const session = await runSession(configurationOf(placed.target, flip))
		const { result, events, devices, roots } = session

		expect(result).toMatchObject({ state: 'completed' })
		const lateStart = events.find((event) => event.type === 'meridianProtectionLateStart')
		expect(lateStart).toMatchObject({ requiredLeadMs: LEAD })
		expect((lateStart as { remainingMs: number }).remainingMs).toBeLessThan(LEAD)
		// Nothing of the run commanded before the tracking off; the late outcome is reported as such.
		const off = trackingSequence(devices, false)
		expect(eventSequence(roots, (event) => event.type === 'meridianProtectionLateStart')).toBeLessThan(eventSequence(roots, (event) => event.type === 'taskStarted'))
		expect(devices.find((entry) => entry.kind === 'command' && entry.sequence < off && !(entry.manager === 'mount' && entry.command === 'tracking'))).toBeUndefined()
		expect(events.find((event) => event.type === 'meridianHardProtection')).toMatchObject({ late: true })
		// The flip ran with tracking off; the light came after it.
		expect(commandsOf(devices, 'flipTo')).toHaveLength(1)
		expect(events.filter((event) => event.type === 'exposureStarted')).toHaveLength(1)
		await assertOracles(session)
	})

	test('paused across the graceful deadline, whilePaused stopTracking turns tracking off and the session stays paused', async () => {
		const placed = await placeMount(-1 * SECOND, true)
		const flip = meridianFlipOf(placed.hourAngle, 1, MARGIN + 0.2)
		let paused: string | undefined
		const states: string[] = []

		const session = await runSession(configurationOf(placed.target, flip), {
			onStart: (runner) => {
				void runner.handle.pause().then((state) => (paused = state))
			},
			onEvent: (event, runner) => {
				if (event.type === 'taskCompleted' && event.task === 'protectMeridianWhilePaused') {
					states.push(runner.handle.snapshot().state)
					void runner.handle.stop('graceful')
				}
			},
		})
		const { result, events, devices } = session

		expect(paused).toBe('paused')
		expect(states).toEqual(['paused'])
		expect(result).toMatchObject({ state: 'stopped' })
		expect(trackingSequence(devices, false)).toBeLessThan(Infinity)
		expect(rig.devices().mount.tracking).toBeFalse()
		expect(events.some((event) => event.type === 'meridianHardProtection' || event.type === 'meridianProtectionFailed')).toBeFalse()
		expect(commandsOf(devices, 'flipTo')).toHaveLength(0)
		expect(events.some((event) => event.type === 'exposureStarted')).toBeFalse()
		await assertOracles(session)
	})

	test('a non-sidereal track mode on a tracking pre-flip mount starts the hard path in the same tick', async () => {
		const placed = await placeMount(-1 * SECOND, true)
		const flip = meridianFlipOf(placed.hourAngle, 600, 1200)
		const { mount } = rig.devices()

		const session = await runSession(configurationOf(placed.target, flip), {
			onStart: (runner) => {
				void runner.handle.pause().then(() => rig.managers.mount.trackMode(mount, 'LUNAR'))
			},
			onEvent: (event, runner) => {
				if (event.type === 'meridianHardProtection' || event.type === 'meridianProtectionFailed') void runner.handle.stop('immediate')
			},
		})
		const { result, events, roots } = session

		expect(result).toMatchObject({ state: 'stopped' })
		expect(events.find((event) => event.type === 'meridianProtectionTrackModeUnsupervisable')).toMatchObject({ trackMode: 'LUNAR' })
		expect(eventSequence(roots, (event) => event.type === 'meridianProtectionTrackModeUnsupervisable')).toBeLessThan(eventSequence(roots, (event) => event.type === 'meridianHardProtection'))
		expect(events.find((event) => event.type === 'meridianHardProtection')).toMatchObject({ late: false })
		expect(mount.tracking).toBeFalse()
		await assertOracles(session)
		expect(await rig.commanders.mount.setTrackMode(rig.coordinator, mount, 'SIDEREAL')).toMatchObject({ ok: true })
	})

	test('a restart out of its meridian cycle fails as configuration before any tracking on or flip', async () => {
		const placed = await placeMount(-1 * SECOND, false)
		const flip = meridianFlipOf(placed.hourAngle, 1.5, MARGIN + 1.5)
		const configuration = configurationOf(placed.target, flip)
		const sessionId = Bun.randomUUIDv7()
		const runtime = createSequencerRuntimeState(configuration, clock.wallNow())
		// Anchored one sidereal day earlier.
		runtime.meridianTransitAt = clock.wallNow() - SEQUENCER_MERIDIAN_HALF_CYCLE * 2
		await new FileSystemSequencerCheckpointStore(ROOT).save(sequencerCheckpointOf(sessionId, configuration, runtime, undefined, 1, clock.wallNow()))

		const session = await runSession(configuration, { sessionId })
		const { result, events, devices } = session

		expect(result).toMatchObject({ state: 'failed', failure: { kind: 'configuration', detail: expect.stringContaining('meridianCycleExceeded') } })
		expect(events.filter((event) => event.type === 'meridianCycleExceeded')).toHaveLength(1)
		expect(commandsOf(devices, 'flipTo')).toHaveLength(0)
		expect(commandsOf(devices, 'tracking').filter((entry) => entry.args[0] === true)).toHaveLength(0)
		expect(events.some((event) => event.type === 'exposureStarted')).toBeFalse()
		await assertOracles(session)
	})

	test('51, 52: armed late before any guiding start, the gate of the run refuses every pulse of the client; 2a pauses it outside guiding', async () => {
		const { guideOutput } = rig.devices()
		const camera: Camera = { ...DEFAULT_CAMERA, id: 'Guide Camera', name: 'Guide Camera', hardwareId: 'guide-camera', connected: true }
		const client = new GuiderClient(new SilentCameraManager() as unknown as CameraManager, rig.managers.guideOutput, new StarTracker(), {})
		const guiding = new LocalGuidingSession(client, camera, guideOutput, rig.commanders.guideOutput, { pulseCeiling: client.maxPulseDuration() })
		// A user left the client connected and looping; without a run admission its pulses reach the mount.
		expect(client.connect(camera, guideOutput)).toBeTrue()
		expect(client.loop()).toBeTrue()
		expect(client.guidePulse(10, 'North')).toBeTrue()
		await waitUntil(() => !guideOutput.pulsing, 3000, 10)

		try {
			const placed = await placeMount(-1 * SECOND, true)
			// latestAt 10 s ahead, less than the lead of the guided protection: the epoch is armed late at 0b.
			const pauseTimeout = Math.ceil(guiding.pulseQuiescenceBound() / 1000)
			// Margin and window cover the lead: jitter 1 s, pause, guiding stop, mount motion and tracking 0.5 s each.
			const margin = pauseTimeout + 4
			const flip = meridianFlipOf(placed.hourAngle, 10 - margin, margin, { protectionMargin: margin })
			const configuration = configurationOf(placed.target, flip, { guiding: { settle: { pixels: 1, time: 1, timeout: 10 }, pauseTimeout, maxRecoveries: 0, recalibrate: false, flipCalibration: false, onFailure: 'fail' } })
			const refused: boolean[] = []

			const session = await runSession(configuration, {
				guiding,
				onEvent: (event, runner) => {
					// Right after the run admission, and once more after the tracking off: a pulse far above the ceiling.
					if (event.type === 'meridianProtectionLateStart') refused.push(client.guidePulse(60000, 'North'))
					if (event.type === 'meridianHardProtection' || event.type === 'meridianProtectionFailed') {
						refused.push(client.guidePulse(60000, 'East'), client.guidePulse(50, 'West'))
						void runner.handle.stop('immediate')
					}
				},
			})

			expect(session.result).toMatchObject({ state: 'stopped' })
			expect(refused).toEqual([false, false, false])
			expect(session.events.find((event) => event.type === 'meridianHardProtection')).toMatchObject({ late: true })
			// No pulse reached the guide output during the run, and tracking went off.
			const pulses = session.devices.filter((entry) => entry.kind === 'command' && entry.manager === 'guideOutput' && entry.command.startsWith('pulse'))
			expect(pulses.length).toBeGreaterThan(0)
			expect(pulses.filter((entry) => ((entry.kind === 'command' && entry.command === 'pulse' ? entry.args[1] : (entry as DeviceCommandEntry).args[0]) as number) > 0)).toEqual([])
			expect(rig.devices().mount.tracking).toBeFalse()
			await assertOracles(session)
		} finally {
			client.stopCapture()
			client.disconnect()
		}
	})

	test.skipIf(isTimeConsumingTestSkipped())('67: with the GuideOutput view of the mount ST4 removed, the barrier keeps the mount unavailable: 2b fails, 2c is refused', async () => {
		const { mount, guideOutput } = rig.devices()
		const key = resourceKey(mount)
		// The ST4 port of the mount simulator: the guide output and the mount are one hardware.
		expect(resourceKey(guideOutput)).toBe(key)
		const ditherer = new MountDitherer(mount, guideOutput, { guideOutputCommander: rig.commanders.guideOutput, delay: clock.delay }, { method: 'pulse', pattern: 'random', rightAscensionDirection: 'EAST', declinationDirection: 'NORTH', maxPulseDuration: 100 })
		const placed = await placeMount(-1 * SECOND, true)
		// latestAt 10 s ahead, less than the lead of the pulse ditherer: armed late at 0b.
		const margin = Math.ceil((SEQUENCER_SUPERVISION_JITTER + guidePulseReleaseBound(100) + 1000) / 1000) + 1
		const flip = meridianFlipOf(placed.hourAngle, 10 - margin, margin, { protectionMargin: margin })
		const dither = { afterFrames: 1, amount: { unit: 'angle' as const, value: deg(1 / 3600) }, raOnly: false, settle: { kind: 'mechanical' as const, time: 0 }, onFailure: 'skip' as const }
		const configuration = configurationOf(placed.target, flip, { dither })
		const causes: (readonly string[])[] = []

		let session: Session | undefined

		try {
			session = await runSession(configuration, {
				ditherer,
				// The view of the guide output goes away once the session holds its devices, before the barrier; the mount
				// view stays.
				onStart: () => rig.managers.guideOutput.remove(guideOutput),
				onEvent: (event, runner) => {
					if (event.type === 'meridianProtectionLateStart') causes.push(rig.arbiter.snapshot(key).causes)
					if (event.type === 'meridianHardProtection' || event.type === 'meridianProtectionFailed') {
						causes.push(rig.arbiter.snapshot(key).causes)
						void runner.handle.stop('immediate')
					}
				},
			})

			// The inherited barrier blocks the mount key with its own cause, the lifecycle one cleared by the mount view.
			expect(causes[0]).toContain('guidePulse')
			expect(causes.at(-1)).toContain('guidePulse')
			expect(causes.at(-1)).not.toContain('lifecycle')
			expect(session.events.find((event) => event.type === 'meridianProtectionFailed')).toMatchObject({ reason: 'mountNotQuiescent', lateStart: true })
			expect(session.events.some((event) => event.type === 'meridianHardProtection')).toBeFalse()
			// Nothing could turn tracking off while the end of the inherited pulse was unobserved.
			expect(mount.tracking).toBeTrue()
		} finally {
			// The view added again publishes both axes stopped after the deadline: only the guidePulse cause leaves.
			rig.managers.guideOutput.add(guideOutput)
			for (const name of ['TELESCOPE_TIMED_GUIDE_NS', 'TELESCOPE_TIMED_GUIDE_WE']) rig.managers.guideOutput.numberVector(rig.client, { device: guideOutput.name, name, state: 'Idle', elements: {} }, 'setNumberVector')
			await waitUntil(() => !rig.arbiter.snapshot(key).causes.includes('guidePulse'), 10000, 20)
			expect(await rig.commanders.mount.setTracking(rig.coordinator, mount, false)).toMatchObject({ ok: true })
		}

		// The epoch was armed late: its crossing of latestAt is reported as meridianProtectionFailed { lateStart } (I18 a).
		await assertMeridianOracle(session)
	})

	test('incorrect variant: without the supervisor a paused session tracks past latestAt, and the oracle rejects it', async () => {
		const placed = await placeMount(-1 * SECOND, true)
		const flip = meridianFlipOf(placed.hourAngle, 1, MARGIN + 0.2)
		const { mount } = rig.devices()
		const hourAngle = () => normalizePI(rigLst() - mount.equatorialCoordinate.rightAscension)

		const session = await runSession(configurationOf(placed.target, flip), {
			supervised: false,
			onStart: (runner) => {
				void runner.handle.pause().then(async () => {
					await waitUntil(() => hourAngle() > flip.latestAt + 0.3 * SECOND, 20000, 20)
					await runner.handle.stop('graceful')
				})
			},
		})

		expect(session.result).toMatchObject({ state: 'stopped' })
		// The hard deadline passed unprotected (I41), and tracking went off only past latestAt (I18).
		const rejected = await assertMeridianOracle(session).then(
			() => undefined,
			(error: unknown) => error,
		)
		expect(rejected).toBeInstanceOf(Error)
		expect((rejected as Error).message).toMatch(/^I41/)
		const log = [...session.devices, ...runtimeEntries(session.roots, session.sessionId)]
		expect(() => assertMeridianProtectionInvariants(log, { mount: mount.name, flip: sequencerMeridianFlipSettings(flip), initial: session.initial })).toThrow(/^I18/)
	})
})
