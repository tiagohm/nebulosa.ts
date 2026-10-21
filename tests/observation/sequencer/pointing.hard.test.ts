import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { writeFileSync } from 'fs'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { SIDEREAL_DRIFT_RATE } from '../../../src/core/constants'
import { GUIDE_PULSE_ACK_MARGIN, GuideOutputCommander, type GuidePulseQuiescenceWindow, guidePulseReleaseBound } from '../../../src/devices/commanders/guideoutput'
import { IndiClientHandlerSet } from '../../../src/devices/indi/client'
import { type Camera, DEFAULT_CAMERA, type GuideOutput } from '../../../src/devices/indi/device'
import { CameraManager } from '../../../src/devices/indi/manager/camera'
import { GuideOutputManager } from '../../../src/devices/indi/manager/guideoutput'
import { CameraSimulator } from '../../../src/devices/indi/simulator/camera'
import { ClientSimulator } from '../../../src/devices/indi/simulator/client'
import type { PropertyState } from '../../../src/devices/indi/types'
import { DeviceLifecycle } from '../../../src/devices/orchestration/device.lifecycle'
import { failedOperationResult, type OperationExecutor, OperationCoordinator, type OperationHandle, type OperationResult, successfulOperationResult } from '../../../src/devices/orchestration/operation'
import { abortableDelay } from '../../../src/devices/orchestration/operation.wait'
import { ResourceArbiter, type ResourceRequest, resourceKey } from '../../../src/devices/orchestration/resource'
import { deg } from '../../../src/math/units/angle'
import { MountDitherer } from '../../../src/observation/guiding/ditherer'
import { quiesceDitherPulsesTask, sequencerDitherRequest } from '../../../src/observation/sequencer/guiding'
import { stopTrackingTask } from '../../../src/observation/sequencer/lifecycle'
import { meridianHardProtectionLead, mountTrackingProtectionTimings, sequencerMeridianFlipSettings, sequencerMeridianSupervisor } from '../../../src/observation/sequencer/pointing'
// oxfmt-ignore
import { type SequencerCaptureStep, type SequencerMotionOwner, type SequencerProtectionOutcome, type SequencerSupervisorHost, startSequencerRunner } from '../../../src/observation/sequencer/runner'
// oxfmt-ignore
import type { SequencerCameraCapture, SequencerClock, SequencerConfiguration, SequencerEvent, SequencerEventBody, SequencerMeridianFlipConfiguration, SequencerTaskId } from '../../../src/observation/sequencer/sequencer'
import { createSequencerRuntimeState } from '../../../src/observation/sequencer/state'
import { FileSystemSequencerCheckpointStore, FileSystemSequencerStorage, prepareFrameDestinationTask } from '../../../src/observation/sequencer/storage'
import { isTimeConsumingTestSkipped, waitUntil } from '../../util'
import { createTestSequence, recordManagers } from '../../util/rig'
import { assertMeridianProtectionInvariants, guidingEntries, type MeridianRunnerEntry, runtimeEntries } from './meridian.util'
import { FakeMount, recordRunner, ScriptedGuidingSession } from './util'

// Hard path of the meridian protection (section 24.5, steps 2a–2c) and the inherited pulse barrier of the startup over
// the real guide output commander, resource arbiter, operation coordinator and device lifecycle, with the ST4 port of
// the camera simulator as the guide output of a pulse mount ditherer and a fake mount (49.12 45–49, 53, 55, 57, 59,
// 60, 64, 65, 69, 72). Faults are injected at the guide output manager: a driver that ignores the zero pulse, one that
// publishes nothing (the test publishes the late Busy and Idle itself), disconnections and a flag nobody dispatched.
// Time is real; the session wall clock runs at the host rate from 2031, far from the host date.

const START = Date.UTC(2031, 2, 20, 0, 0, 0)
const ORIGIN = performance.now()
const clock: SequencerClock = { wallNow: () => START + (performance.now() - ORIGIN), monotonicNow: () => performance.now(), delay: abortableDelay }
const DARK: SequencerCameraCapture = { exposureTime: 1, exposureTimeUnit: 'second', frameType: 'DARK', x: 0, y: 0, width: 0, height: 0, subframe: false, binX: 1, binY: 1, frameFormat: '', gain: 0, offset: 0, compressed: false }
const FRAME = Buffer.from('SIMPLE  =                    T')
// Longest pulse of the ditherer, ms: its release bound, the worst case of step 2b, is 2·300 + 500 + 15000 ms.
const MAX_PULSE = 300
// latestAt of the sessions, radians.
const LATEST_AT = deg(5)
// Tolerance, ms, of the instants the simulator and the timers report.
const SLACK = 30

const cameraManager = new CameraManager()
const guideOutputManager = new GuideOutputManager({ get: (client, name) => cameraManager.get(client, name) })
const arbiter = new ResourceArbiter()
const coordinator = new OperationCoordinator(arbiter)
const guideOutputCommander = new GuideOutputCommander(guideOutputManager, arbiter)
const lifecycle = new DeviceLifecycle(arbiter, coordinator)
lifecycle.observe(cameraManager)
lifecycle.observe(guideOutputManager)
const client = new ClientSimulator('Client Simulator', new IndiClientHandlerSet([cameraManager, guideOutputManager]))
const simulator = new CameraSimulator('Camera Simulator', client, { guideOutputManager })

// Monotonic instants at which the guide output reported both axes stopped.
const stopped: number[] = []
guideOutputManager.addHandler({
	added: () => {},
	updated: (device, property) => {
		if ((property === 'pulsing' || property === 'pulsingNS' || property === 'pulsingWE') && !device.pulsing) stopped.push(performance.now())
	},
	removed: () => {},
})

const ROOT = await mkdtemp(join(tmpdir(), 'nebulosa-sequencer-hard-'))
const disarms: VoidFunction[] = []
// Shared order of the log of each test.
let sequence = createTestSequence()
const timers: Timer[] = []
const restores: VoidFunction[] = []

afterAll(async () => {
	lifecycle.dispose()
	simulator.dispose()
	await rm(ROOT, { recursive: true, force: true })
})

beforeEach(() => {
	sequence = createTestSequence()
	stopped.length = 0
	cameraManager.disconnect(camera())
})

afterEach(async () => {
	for (const disarm of disarms.splice(0)) disarm()
	for (const timer of timers.splice(0)) clearTimeout(timer)
	for (const restore of restores.splice(0)) restore()
	await coordinator.cancelAll()
	cameraManager.disconnect(camera())
})

function camera() {
	const device = cameraManager.get(client, simulator.name)
	expect(device).toBeDefined()
	return device!
}

async function connected() {
	const device = camera()
	cameraManager.connect(device)
	// A pulse of an earlier test may still be running in the simulator across the reconnection.
	await waitUntil(() => device.connected && device.canPulseGuide && !device.pulsing)
	await waitUntil(() => guideOutputCommander.dispatchedPulseWindow(device) === undefined && arbiter.availability(resourceKey(device)) === 'available', 20000, 10)
	return device
}

// Feeds one timed-guide vector through the manager, as the driver would publish it.
function guideVector(device: Camera, name: 'TELESCOPE_TIMED_GUIDE_NS' | 'TELESCOPE_TIMED_GUIDE_WE', state: PropertyState) {
	guideOutputManager.numberVector(client, { device: device.name, name, state, elements: {} }, 'setNumberVector')
}

// Runs `action` `ms` after now; cleared after the test.
function later(ms: number, action: VoidFunction) {
	timers.push(setTimeout(action, ms))
}

// Resolves aborted once `signal` aborts, never before.
function untilAborted(signal: AbortSignal) {
	return new Promise<OperationResult<void>>((resolve) => {
		signal.addEventListener('abort', () => resolve(failedOperationResult('aborted')), { once: true })
	})
}

// Driver that ignores the zero pulse: the stop of a pulse is never forwarded, so it runs to its physical end.
function ignoringZeroDriver() {
	const forward = guideOutputManager.pulse.bind(guideOutputManager)
	const spy = spyOn(guideOutputManager, 'pulse').mockImplementation((device, direction, duration) => {
		if (duration > 0) forward(device, direction, duration)
	})
	restores.push(() => spy.mockRestore())
}

// Driver that publishes nothing on its own: pulses are only recorded with their monotonic dispatch, and the test
// publishes the timed-guide states itself.
function silentDriver() {
	const pulses: { readonly duration: number; readonly at: number }[] = []
	const spy = spyOn(guideOutputManager, 'pulse').mockImplementation((_, __, duration) => {
		pulses.push({ duration, at: performance.now() })
	})
	restores.push(() => spy.mockRestore())
	return pulses
}

function flipOf(patch: Partial<SequencerMeridianFlipConfiguration> = {}): SequencerMeridianFlipConfiguration {
	return { enabled: true, prepareAt: -deg(5), flipAt: 0, latestAt: deg(5), beforeFlipPierSide: 'WEST', afterFlipPierSide: 'EAST', protectionMargin: 120, supervisionInterval: 300, maxRetries: 1, hardProtection: { mountStopTimeout: 0.5, guidingStopTimeout: 0.3, trackingTimeout: 1 }, onFailure: 'stop', ...patch }
}

function configurationOf(patch: Partial<SequencerConfiguration> = {}): SequencerConfiguration {
	return {
		schemaVersion: 1,
		id: 'hard',
		revision: 1,
		name: 'Hard',
		meridianFlip: flipOf(),
		capture: { order: 'sequential', groups: [{ kind: 'scheduled', id: 'D', enabled: true, capture: DARK, count: 1 }], retry: { maxAttempts: 1, delay: 0, backoff: 1, maximumDelay: 0, retryOn: [] }, onFailure: 'fail', cameraRecovery: { onTimeout: 'stop' } },
		startup: { onFailure: 'fail' },
		shutdown: { stepTimeout: 5, totalTimeout: 60 },
		execution: { compensation: { timeout: 5 } },
		...patch,
	}
}

const DITHER = { afterFrames: 1, amount: { unit: 'angle', value: deg(1 / 3600) }, raOnly: false, settle: { kind: 'mechanical', time: 0 }, onFailure: 'skip' } as const

function pulseDitherer(mount: FakeMount<SequencerClock>, guideOutput: GuideOutput) {
	return new MountDitherer(mount.mount, guideOutput, { guideOutputCommander, delay: abortableDelay }, { method: 'pulse', pattern: 'random', rightAscensionDirection: 'EAST', declinationDirection: 'NORTH', maxPulseDuration: MAX_PULSE })
}

// Outcome of one tracking protection prefix: its failure, and the monotonic instants it started and turned tracking off.
interface Protection {
	readonly failure?: string
	readonly startedAt: number
	readonly offAt?: number
}

interface ArmedOptions {
	readonly configuration?: SequencerConfiguration
	readonly guideOutput?: GuideOutput
	readonly guiding?: ScriptedGuidingSession
	// Incorrect variant: the supervisor ignores the movement of the ditherer, so 2b waits only for the mount owners.
	readonly mountOnly?: boolean
	// Ditherer of the session over the fake mount and the guide output; a pulse ditherer by default.
	readonly ditherer?: (fake: FakeMount<SequencerClock>, guideOutput: GuideOutput) => MountDitherer
}

// A supervisor armed far from the meridian (no deadline for hours) over a fake host sharing the coordinator of the
// commander, with the roots registered as motion owners and the tracking protection prefix run as the critical root.
// The log of the test (camera and guide output managers, the fake mount, the guiding and the hard root with its
// outcome, as the runner would report it) feeds the meridian oracle.
function armed(options: ArmedOptions = {}) {
	const fake = new FakeMount(clock, -deg(60), { tracking: true }, sequence)
	const initialRightAscension = fake.mount.equatorialCoordinate.rightAscension
	const configuration = options.configuration ?? configurationOf(options.guideOutput === undefined ? {} : { dither: DITHER })
	const ditherer = options.guideOutput === undefined ? undefined : (options.ditherer ?? pulseDitherer)(fake, options.guideOutput)
	const recorder = recordManagers({ camera: cameraManager, guideOutput: guideOutputManager }, clock, sequence)
	disarms.push(() => recorder[Symbol.dispose]())
	const runner: MeridianRunnerEntry[] = []
	const runtime = createSequencerRuntimeState(configuration, clock.wallNow())
	const devices = { camera: { ...DEFAULT_CAMERA, id: 'Primary', name: 'Primary', hardwareId: 'Primary', connected: true }, mount: fake.mount }
	const events: SequencerEventBody[] = []
	const motionOwners = new Map<string, SequencerMotionOwner>()
	const { guiding } = options

	const host: SequencerSupervisorHost = {
		view: () => ({ sessionId: 'session', configuration, devices, clock, state: runtime }),
		emit: (event) => events.push(event),
		requestProtection: () => false,
		protectCritically: () => Promise.resolve<SequencerProtectionOutcome>({ ok: true }),
		fail: () => {},
		motionOwners,
		coordinator,
	}

	const moved = options.mountOnly === true ? undefined : ditherer
	const supervisor = sequencerMeridianSupervisor(configuration, devices, { mountCommander: fake.commander, mountUpdates: fake.updates, guideOutputCommander, ...(moved !== undefined && { ditherer: moved }), ...(guiding !== undefined && { guiding }) })!
	supervisor.arm(host)
	disarms.push(() => supervisor.disarm())

	// Starts a root of `task` holding `requests`, registered as a motion owner of `keys` until it ends.
	const own = <T>(task: SequencerTaskId, requests: readonly ResourceRequest[], keys: readonly string[], executor: OperationExecutor<T>): OperationHandle<T> => {
		const handle = coordinator.start(task, requests, executor)
		motionOwners.set(handle.id, { task, keys })
		void handle.result.then(() => motionOwners.delete(handle.id))
		return handle
	}

	const root = (event: 'start' | 'end') => runner.push({ kind: 'root', sequence: sequence.next(), runtime: 'hard', wallNow: clock.wallNow(), event, id: 'hard', operation: 'sequencer.protect.meridianHard', ...(event === 'end' && { ok: true }) })

	// Runs `protectMountTracking` as the critical root of the hard path, reporting its outcome like `#hardProtection`.
	const protect = async (): Promise<Protection> => {
		const startedAt = performance.now()
		root('start')
		const result = await coordinator.start('sequencer.protect.meridianHard', [], async (context) => successfulOperationResult(await supervisor.protectMountTracking(context))).result
		expect(result.ok).toBeTrue()
		const off = fake.of('tracking').find((command) => command.args[0] === false)
		const failure = result.ok ? result.value.failure : undefined
		const hourAngle = fake.hourAngle()
		const body: SequencerEventBody = failure === undefined ? { type: 'meridianHardProtection', late: false, hourAngle, latestAt: configuration.meridianFlip!.latestAt, leadMs: 0 } : { type: 'meridianProtectionFailed', reason: failure, lateStart: false, hourAngle }
		runner.push({ kind: 'event', sequence: sequence.next(), runtime: 'hard', wallNow: clock.wallNow(), event: { ...body, sessionId: 'session', at: clock.wallNow() } })
		root('end')
		return { ...(failure !== undefined && { failure }), startedAt, ...(off !== undefined && { offAt: off.wallNow - START + ORIGIN }) }
	}

	// Meridian oracle over the log of the test.
	const oracle = () => {
		const { mount } = fake
		const log = [...recorder.entries, ...fake.entries, ...runner, ...guidingEntries(guiding?.log ?? [])]
		const timings = mountTrackingProtectionTimings(configuration, { mount }, { ...(ditherer !== undefined && { ditherer }), ...(guiding !== undefined && { guiding }) })
		assertMeridianProtectionInvariants(log, {
			mount: mount.name,
			flip: sequencerMeridianFlipSettings(configuration.meridianFlip!),
			lead: meridianHardProtectionLead(timings),
			initial: { tracking: true, pierSide: 'WEST', trackMode: 'SIDEREAL', rightAscension: initialRightAscension, longitude: 0 },
			guideOutputs: options.guideOutput === undefined ? [] : [options.guideOutput.name],
		})
	}

	return { fake, runtime, events, motionOwners, supervisor, own, protect, oracle, ditherer }
}

describe('2b and the dither pulses', () => {
	test('46, 48: a dither pulse its driver keeps running after the cancellation holds 2b: tracking goes off only after its physical end', async () => {
		const guideOutput = await connected()
		ignoringZeroDriver()
		const s = armed({ guideOutput })
		const key = resourceKey(guideOutput)

		const dither = s.own('ditherAndSettle', [], [key], (context) => guideOutputCommander.pulse(context, guideOutput, 'NORTH', 1200))
		await waitUntil(() => guideOutput.pulsing, 2000, 5)
		const dispatchedAt = performance.now()

		// The runner cancels the task root, then starts the hard path at once.
		void dither.cancel()
		const protection = await s.protect()
		s.oracle()

		expect(protection.failure).toBeUndefined()
		expect(stopped.length).toBeGreaterThan(0)
		const physicalEnd = stopped.at(-1)!
		expect(physicalEnd - dispatchedAt).toBeGreaterThan(1200 - 100)
		expect(protection.offAt!).toBeGreaterThanOrEqual(physicalEnd - SLACK)
		expect(s.motionOwners.size).toBe(0)
	})

	test('a driver that honours the zero pulse stops at the cancellation: tracking goes off well before the nominal end', async () => {
		const guideOutput = await connected()
		const s = armed({ guideOutput })

		const dither = s.own('ditherAndSettle', [], [resourceKey(guideOutput)], (context) => guideOutputCommander.pulse(context, guideOutput, 'NORTH', 3000))
		await waitUntil(() => guideOutput.pulsing, 2000, 5)
		const dispatchedAt = performance.now()

		void dither.cancel()
		const protection = await s.protect()
		s.oracle()

		expect(protection.failure).toBeUndefined()
		expect(protection.offAt! - dispatchedAt).toBeLessThan(1500)
		expect(guideOutput.pulsing).toBeFalse()
	})

	test('53: a Busy published after the nominal end of the pulse holds 2b until its Idle, never between the end and the Busy', async () => {
		const guideOutput = await connected()
		const pulses = silentDriver()
		const s = armed({ guideOutput })

		const dither = s.own('ditherAndSettle', [], [resourceKey(guideOutput)], (context) => guideOutputCommander.pulse(context, guideOutput, 'NORTH', 400))
		await waitUntil(() => pulses.some((pulse) => pulse.duration > 0), 2000, 5)
		const dispatchedAt = pulses.find((pulse) => pulse.duration > 0)!.at

		// Nominal end at 400 ms; the Busy arrives at 500 ms, before the acknowledgement deadline, and the Idle at 900 ms.
		let idleAt = Number.NaN
		later(500 - (performance.now() - dispatchedAt), () => guideVector(guideOutput, 'TELESCOPE_TIMED_GUIDE_NS', 'Busy'))
		later(900 - (performance.now() - dispatchedAt), () => {
			idleAt = performance.now()
			guideVector(guideOutput, 'TELESCOPE_TIMED_GUIDE_NS', 'Ok')
		})

		void dither.cancel()
		const protection = await s.protect()
		s.oracle()

		expect(protection.failure).toBeUndefined()
		expect(protection.offAt!).toBeGreaterThanOrEqual(idleAt)
		expect(protection.offAt! - dispatchedAt).toBeGreaterThanOrEqual(900 - SLACK)
	})

	test('64, 65: a disconnect hides the end of a dispatched pulse: 2b waits for its evidence, which a reconnection past the Busy deadline ends', async () => {
		const guideOutput = await connected()
		const pulses = silentDriver()
		const s = armed({ guideOutput })

		const dither = s.own('ditherAndSettle', [], [resourceKey(guideOutput)], (context) => guideOutputCommander.pulse(context, guideOutput, 'WEST', 300))
		await waitUntil(() => pulses.some((pulse) => pulse.duration > 0), 2000, 5)
		const dispatchedAt = pulses.find((pulse) => pulse.duration > 0)!.at
		cameraManager.disconnect(guideOutput)

		// The root ended disconnected and left no motion owner, nor a pulse flag, but the dispatch is still evidence.
		expect(await dither.result).toMatchObject(failedOperationResult('disconnected'))
		expect(s.motionOwners.size).toBe(0)
		expect(guideOutput.pulsing).toBeFalse()
		const window = guideOutputCommander.dispatchedPulseWindow(guideOutput)
		expect(window).toBeDefined()

		let reconnectedAt = Number.NaN
		later(window!.busyAckDeadline - performance.now() + 200, () => {
			reconnectedAt = performance.now()
			cameraManager.connect(guideOutput)
		})

		const protection = await s.protect()
		s.oracle()

		expect(protection.failure).toBeUndefined()
		expect(protection.offAt!).toBeGreaterThanOrEqual(reconnectedAt)
		expect(protection.offAt! - dispatchedAt).toBeGreaterThanOrEqual(300 + GUIDE_PULSE_ACK_MARGIN)
		expect(guideOutputCommander.dispatchedPulseWindow(guideOutput)).toBeUndefined()
	})

	test.skipIf(isTimeConsumingTestSkipped())('64: without the reconnection the evidence outlives the release bound: mountNotQuiescent, tracking still turned off', async () => {
		const guideOutput = await connected()
		const pulses = silentDriver()
		const s = armed({ guideOutput })

		const dither = s.own('ditherAndSettle', [], [resourceKey(guideOutput)], (context) => guideOutputCommander.pulse(context, guideOutput, 'WEST', 200))
		await waitUntil(() => pulses.some((pulse) => pulse.duration > 0), 2000, 5)
		cameraManager.disconnect(guideOutput)
		await dither.result

		const protection = await s.protect()
		s.oracle()

		expect(protection.failure).toBe('mountNotQuiescent')
		expect(protection.offAt! - protection.startedAt).toBeGreaterThanOrEqual(guidePulseReleaseBound(MAX_PULSE) - SLACK)
		expect(s.fake.mount.tracking).toBeFalse()
		expect(s.runtime.trackingStoppedForMeridianProtection).toBeTrue()
	})

	test('49, 57: a pulse flag nobody of the run dispatched holds 2b until the guide output reports the axis stopped', async () => {
		const guideOutput = await connected()
		const s = armed({ guideOutput })

		// No dispatch and no owner: only the published flag of a connected view.
		guideVector(guideOutput, 'TELESCOPE_TIMED_GUIDE_NS', 'Busy')
		expect(guideOutput.pulsing).toBeTrue()
		let idleAt = Number.NaN
		later(400, () => {
			idleAt = performance.now()
			guideVector(guideOutput, 'TELESCOPE_TIMED_GUIDE_NS', 'Ok')
		})

		const protection = await s.protect()
		s.oracle()

		expect(protection.failure).toBeUndefined()
		expect(protection.offAt!).toBeGreaterThanOrEqual(idleAt)
	})

	test('55: a capture holding the camera with its ST4 port is not a motion owner: 2b never waits for it', async () => {
		const guideOutput = await connected()
		const s = armed({ guideOutput })

		const capture = coordinator.start('captureFrame', [{ key: resourceKey(guideOutput), device: guideOutput }], (context) => untilAborted(context.signal))
		expect(arbiter.ownersOf(resourceKey(guideOutput))).toHaveLength(1)

		const protection = await s.protect()
		s.oracle()

		expect(protection.failure).toBeUndefined()
		expect(protection.offAt! - protection.startedAt).toBeLessThan(300)
		await capture.cancel()
	})
})

describe('2b and the movement of the ditherer', () => {
	test('54: a movement key the ditherer adds is waited by 2b and grows the lead, with no change in the Sequencer', async () => {
		const guideOutput = await connected()
		const EXTRA = 'logical:dither-mount-port'

		// A pulse ditherer that may also move the mount through a second port.
		class WideDitherer extends MountDitherer {
			override movement(settleTimeout: number) {
				return [...super.movement(settleTimeout), { request: { key: EXTRA }, releaseBound: 30000 }]
			}
		}

		const wide = (fake: FakeMount<SequencerClock>, output: GuideOutput) => new WideDitherer(fake.mount, output, { guideOutputCommander, delay: abortableDelay }, pulseDitherer(fake, output).options)
		const s = armed({ guideOutput, ditherer: wide })
		const configuration = configurationOf({ dither: DITHER })
		const narrow = meridianHardProtectionLead(mountTrackingProtectionTimings(configuration, { mount: s.fake.mount }, { ditherer: pulseDitherer(s.fake, guideOutput) }))
		const grown = meridianHardProtectionLead(mountTrackingProtectionTimings(configuration, { mount: s.fake.mount }, { ditherer: s.ditherer }))
		expect(grown.mountMotionReleaseBound).toBe(30000)
		expect(grown.lead - narrow.lead).toBe(30000 - guidePulseReleaseBound(MAX_PULSE))

		// A dither root holding that key, which releases it 400 ms after the cancellation.
		const dither = s.own('ditherAndSettle', [{ key: EXTRA }], [EXTRA], (context) => {
			const { promise, resolve } = Promise.withResolvers<OperationResult<void>>()
			context.signal.addEventListener('abort', () => void Bun.sleep(400).then(() => resolve(successfulOperationResult(undefined))), { once: true })
			return promise
		})
		const released = dither.result.then(() => performance.now())
		void dither.cancel()
		const protection = await s.protect()
		s.oracle()

		expect(protection.failure).toBeUndefined()
		expect(protection.offAt!).toBeGreaterThanOrEqual(await released)
	})

	test('56: a dither of the real ditherer whose Busy comes 1 ms before its deadline holds 2b until its physical Idle', async () => {
		const guideOutput = await connected()
		let idleAt = 0
		let dispatched = 0
		// A driver that acknowledges every leg at the last moment its window allows, then stops it 100 ms later.
		const spy = spyOn(guideOutputManager, 'pulse').mockImplementation((device, direction, duration) => {
			if (!(duration > 0)) return
			dispatched++
			const vector = direction === 'NORTH' || direction === 'SOUTH' ? 'TELESCOPE_TIMED_GUIDE_NS' : 'TELESCOPE_TIMED_GUIDE_WE'
			later(duration + GUIDE_PULSE_ACK_MARGIN - 1, () => guideVector(guideOutput, vector, 'Busy'))
			later(duration + GUIDE_PULSE_ACK_MARGIN + 99, () => {
				idleAt = Math.max(idleAt, performance.now())
				guideVector(guideOutput, vector, 'Ok')
			})
		})
		restores.push(() => spy.mockRestore())
		// The simulator publishes no guide rate: half the sidereal rate on both axes, so a 1″ dither is a pulse of ~133 ms.
		const { guideRate } = guideOutput
		Object.assign(guideOutput, { guideRate: { rightAscension: 0.5, declination: 0.5 } })
		restores.push(() => Object.assign(guideOutput, { guideRate }))
		const s = armed({ guideOutput })

		const dither = s.own('ditherAndSettle', [], [resourceKey(guideOutput)], (context) => s.ditherer!.dither(context, sequencerDitherRequest(DITHER)))
		await waitUntil(() => dispatched > 0, 2000, 1)
		void dither.cancel()
		const protection = await s.protect()
		s.oracle()

		expect(protection.failure).toBeUndefined()
		expect(idleAt).toBeGreaterThan(0)
		expect(protection.offAt!).toBeGreaterThanOrEqual(idleAt)
	})

	test('66: a view removed under a dispatched pulse keeps its evidence; the view added again ends it past the deadline', async () => {
		const guideOutput = await connected()
		const pulses = silentDriver()
		const s = armed({ guideOutput })
		const view = guideOutputManager.get(client, simulator.name)!

		const dither = s.own('ditherAndSettle', [], [resourceKey(guideOutput)], (context) => guideOutputCommander.pulse(context, guideOutput, 'NORTH', 300))
		await waitUntil(() => pulses.some((pulse) => pulse.duration > 0), 2000, 1)
		guideOutputManager.remove(view)
		const window = guideOutputCommander.dispatchedPulseWindow(guideOutput)!
		void dither.cancel()

		let addedAt = Number.NaN
		later(window.busyAckDeadline - performance.now() + 200, () => {
			addedAt = performance.now()
			guideOutputManager.add(view)
			guideVector(guideOutput, 'TELESCOPE_TIMED_GUIDE_NS', 'Ok')
		})

		const protection = await s.protect()
		s.oracle()

		expect(protection.failure).toBeUndefined()
		expect(protection.offAt!).toBeGreaterThanOrEqual(addedAt)
		expect(guideOutputCommander.dispatchedPulseWindow(guideOutput)).toBeUndefined()
	})

	test('68: each axis of the evidence ends by itself: the stop of the other axis never ends a pulse', async () => {
		const guideOutput = await connected()
		const pulses = silentDriver()
		const s = armed({ guideOutput })

		const dither = s.own('ditherAndSettle', [], [resourceKey(guideOutput)], (context) => guideOutputCommander.pulse(context, guideOutput, 'WEST', 300))
		await waitUntil(() => pulses.some((pulse) => pulse.duration > 0), 2000, 1)
		guideVector(guideOutput, 'TELESCOPE_TIMED_GUIDE_WE', 'Busy')
		void dither.cancel()

		// Only the other axis stops first; the pulsed one 600 ms later.
		later(200, () => guideVector(guideOutput, 'TELESCOPE_TIMED_GUIDE_NS', 'Ok'))
		let stoppedAt = Number.NaN
		later(800, () => {
			stoppedAt = performance.now()
			guideVector(guideOutput, 'TELESCOPE_TIMED_GUIDE_WE', 'Ok')
		})

		const protection = await s.protect()
		s.oracle()

		expect(protection.failure).toBeUndefined()
		expect(protection.offAt!).toBeGreaterThanOrEqual(stoppedAt)
	})
})

describe('incorrect variants of 2b', () => {
	test('48: a 2b that waits only for the mount owners turns tracking off under the running pulse, and the oracle rejects it', async () => {
		const guideOutput = await connected()
		ignoringZeroDriver()
		const s = armed({ guideOutput, mountOnly: true })

		const dither = s.own('ditherAndSettle', [], [resourceKey(guideOutput)], (context) => guideOutputCommander.pulse(context, guideOutput, 'NORTH', 1200))
		await waitUntil(() => guideOutput.pulsing, 2000, 5)
		void dither.cancel()
		const protection = await s.protect()

		expect(protection.failure).toBeUndefined()
		expect(guideOutput.pulsing).toBeTrue()
		expect(() => s.oracle()).toThrow(/^I58/)
		await dither.result
	})

	test('53, 60: the same 2b reports success before an unobserved pulse could end, and the oracle rejects it', async () => {
		const guideOutput = await connected()
		const pulses = silentDriver()
		const s = armed({ guideOutput, mountOnly: true })

		const dither = s.own('ditherAndSettle', [], [resourceKey(guideOutput)], (context) => guideOutputCommander.pulse(context, guideOutput, 'NORTH', 400))
		await waitUntil(() => pulses.some((pulse) => pulse.duration > 0), 2000, 5)
		void dither.cancel()
		const protection = await s.protect()

		expect(protection.failure).toBeUndefined()
		expect(() => s.oracle()).toThrow(/^I60/)
		await dither.result
	})
})

describe('2b and the mount roots', () => {
	// An unpark root holding the mount that ignores its cancellation and releases it `ms` after now.
	function unparking(s: ReturnType<typeof armed>, ms: number) {
		const handle = s.own('unparkMount', [{ key: resourceKey(s.fake.mount), device: s.fake.mount }], [resourceKey(s.fake.mount)], () => Bun.sleep(ms).then(() => successfulOperationResult(undefined)))
		return { handle, releasedAt: handle.result.then(() => performance.now()) }
	}

	const configuration = () => configurationOf({ startup: { mount: { unpark: true }, onFailure: 'fail' } })

	test('59: an unpark released within mountStopTimeout is waited for; tracking goes off right after its release', async () => {
		const s = armed({ configuration: configuration() })
		const unpark = unparking(s, 300)

		const protection = await s.protect()
		s.oracle()

		expect(protection.failure).toBeUndefined()
		expect(protection.offAt!).toBeGreaterThanOrEqual(await unpark.releasedAt)
		expect(protection.offAt! - protection.startedAt).toBeLessThan(500)
	})

	test('60: an unpark released past the bound is mountNotQuiescent, never a success', async () => {
		const s = armed({ configuration: configuration() })
		const unpark = unparking(s, 800)

		const protection = await s.protect()
		s.oracle()

		expect(protection.failure).toBe('mountNotQuiescent')
		expect(performance.now() - protection.startedAt).toBeGreaterThanOrEqual(500 - SLACK)
		await unpark.handle.result
	})
})

describe('2a and the guiding pause', () => {
	const guided = () => configurationOf({ guiding: { settle: { pixels: 1, time: 1, timeout: 10 }, pauseTimeout: 0.6, maxRecoveries: 0, recalibrate: false, flipCalibration: false, onFailure: 'fail' } })

	test('45: a pause that ends within pauseTimeout precedes the tracking off', async () => {
		const guiding = new ScriptedGuidingSession({}, sequence)
		guiding.current = 'guiding'
		let pausedAt = Number.NaN
		guiding.onPause = () =>
			Bun.sleep(400).then(() => {
				pausedAt = performance.now()
				return successfulOperationResult(undefined)
			})
		const s = armed({ configuration: guided(), guiding })

		const protection = await s.protect()
		s.oracle()

		expect(protection.failure).toBeUndefined()
		expect(guiding.commands()).toEqual(['pause'])
		expect(protection.offAt!).toBeGreaterThanOrEqual(pausedAt)
		expect(s.runtime.intents.recoverGuiding).toBeTrue()
	})

	test('47: a pause that never ends is cut at pauseTimeout, guiding is stopped, tracking still goes off: guidingNotQuiescent', async () => {
		const guiding = new ScriptedGuidingSession({}, sequence)
		guiding.current = 'guiding'
		guiding.onPause = (context) => untilAborted(context.signal)
		const s = armed({ configuration: guided(), guiding })

		const protection = await s.protect()
		s.oracle()

		expect(protection.failure).toBe('guidingNotQuiescent')
		expect(guiding.commands()).toEqual(['pause', 'stop'])
		expect(protection.offAt! - protection.startedAt).toBeGreaterThanOrEqual(600 - SLACK)
		expect(protection.offAt! - protection.startedAt).toBeLessThan(600 + 300 + 500)
		expect(s.fake.mount.tracking).toBeFalse()
	})
})

describe('inherited pulse barrier', () => {
	// A session restarted with a pulse ditherer whose previous process may have left a pulse in flight: the runner
	// installs the barrier right after the reservation, and the startup task `quiesceDitherPulses` waits it out. With
	// `remaining` (seconds), the restart finds the mount tracking on its pre-flip side that close to latestAt, under a
	// supervised meridian flip whose lead it cannot cover: the epoch is armed late at 0b.
	function restart(guideOutput: Camera, remaining?: number) {
		const meridian = remaining !== undefined
		const fake = new FakeMount(clock, meridian ? LATEST_AT - remaining * SIDEREAL_DRIFT_RATE : -deg(60), { tracking: meridian }, sequence)
		const configuration = configurationOf({ ...(!meridian && { meridianFlip: undefined }), dither: DITHER, shutdown: { stepTimeout: 5, totalTimeout: 60 } })
		const ditherer = pulseDitherer(fake, guideOutput)
		const lifecycle = { mountCommander: fake.commander }
		const supervisor = meridian ? sequencerMeridianSupervisor(configuration, { camera: guideOutput, mount: fake.mount }, { mountCommander: fake.commander, mountUpdates: fake.updates, guideOutputCommander, ditherer }) : undefined
		if (supervisor !== undefined) disarms.push(() => supervisor.disarm())
		const sessionId = Bun.randomUUIDv7()
		const storage = new FileSystemSequencerStorage({ root: ROOT, sessionId, wallNow: clock.wallNow })
		// Each event with its monotonic instant and the barrier window of the guide output at that moment.
		const events: { readonly event: SequencerEvent; readonly at: number; readonly barrier?: GuidePulseQuiescenceWindow }[] = []

		const capture: SequencerCaptureStep = (context) => {
			context.exposureStarted()
			writeFileSync(context.destination.temporary, FRAME)
			const at = clock.wallNow()
			const monotonic = clock.monotonicNow()
			return Promise.resolve(successfulOperationResult({ exposureDispatchedAt: at, exposureDispatchedMonotonic: monotonic, exposureStartedAt: at, exposureStartedMonotonic: monotonic, exposureFinishedAt: at, exposureFinishedMonotonic: monotonic }))
		}

		const devices = recordManagers({ camera: cameraManager, guideOutput: guideOutputManager }, clock, sequence)
		const roots = recordRunner(coordinator, sequence, clock)
		disarms.push(
			() => devices[Symbol.dispose](),
			() => roots[Symbol.dispose](),
		)

		const listener = (event: SequencerEvent) => {
			roots.listener(event)
			events.push({ event, at: performance.now(), barrier: guideOutputCommander.dispatchedPulseWindow(guideOutput) })
		}

		const runner = startSequencerRunner({
			configuration,
			devices: { camera: guideOutput, mount: fake.mount },
			services: { coordinator, storage, checkpointStore: new FileSystemSequencerCheckpointStore(ROOT), clock, ditherer, listener },
			phases: {
				startup: [quiesceDitherPulsesTask(ditherer)],
				preCapture: [prepareFrameDestinationTask(storage)],
				capture,
				shutdown: supervisor === undefined ? [] : [supervisor.shutdownStep(stopTrackingTask(lifecycle, 'required'))],
				...(supervisor !== undefined && { supervisor }),
			},
		})

		const completedAt = () => events.find((entry) => entry.event.type === 'taskCompleted' && entry.event.task === 'quiesceDitherPulses')?.at

		// Meridian oracle of the barrier (I60): no end of quiesceDitherPulses before the end of the inherited pulse.
		const oracle = () => {
			const log = [...devices.entries, ...fake.entries, ...runtimeEntries(roots.entries, sessionId)]
			const lead = meridianHardProtectionLead(mountTrackingProtectionTimings(configuration, { mount: fake.mount }, { ditherer }))
			assertMeridianProtectionInvariants(log, { mount: fake.mount.name, flip: sequencerMeridianFlipSettings(flipOf()), lead, initial: fake.initial, guideOutputs: [guideOutput.name], barrier: { guideOutput: guideOutput.name, maxPulseDuration: MAX_PULSE } })
		}

		return { runner, events, completedAt, oracle, fake }
	}

	test('69: the barrier is installed before any command; a Busy after it holds quiesceDitherPulses until its Idle', async () => {
		const guideOutput = await connected()
		const pulses = silentDriver()
		const { runner, events, completedAt, oracle } = restart(guideOutput)
		await waitUntil(() => guideOutputCommander.dispatchedPulseWindow(guideOutput) !== undefined, 2000, 1)
		expect(arbiter.snapshot(resourceKey(guideOutput)).causes).toContain('guidePulse')

		// The pulse of the previous process is acknowledged late and ends well after its nominal window.
		let idleAt = Number.NaN
		later(150, () => guideVector(guideOutput, 'TELESCOPE_TIMED_GUIDE_NS', 'Busy'))
		later(1200, () => {
			idleAt = performance.now()
			guideVector(guideOutput, 'TELESCOPE_TIMED_GUIDE_NS', 'Ok')
		})

		const result = await runner.handle.result

		expect(result).toMatchObject({ state: 'completed' })
		// Synchronously after the reservation, before the first task: the barrier of a pulse dispatched right then.
		const first = events.find((entry) => entry.event.type === 'taskStarted')!
		expect(first.barrier).toBeDefined()
		expect(first.barrier!.busyAckDeadline).toBeLessThanOrEqual(first.at + MAX_PULSE + GUIDE_PULSE_ACK_MARGIN)
		expect(completedAt()!).toBeGreaterThanOrEqual(idleAt)
		expect(pulses).toEqual([])
		expect(arbiter.snapshot(resourceKey(guideOutput)).causes).not.toContain('guidePulse')
		oracle()
	})

	test('69: without any Busy the barrier ends at its acknowledgement deadline, once the stopped axes are observed', async () => {
		const guideOutput = await connected()
		silentDriver()
		const admittedAt = performance.now()
		const { runner, completedAt, oracle } = restart(guideOutput)

		const result = await runner.handle.result

		expect(result).toMatchObject({ state: 'completed' })
		expect(completedAt()! - admittedAt).toBeGreaterThanOrEqual(MAX_PULSE + GUIDE_PULSE_ACK_MARGIN - SLACK)
		oracle()
	})

	test('71: armed late at 0b, the hard path waits for the barrier to its deadline, then turns tracking off before latestAt as late', async () => {
		const guideOutput = await connected()
		silentDriver()
		const { runner, events, fake, oracle } = restart(guideOutput, 5)

		const result = await runner.handle.result

		expect(result).toMatchObject({ state: 'completed' })
		const lateStart = events.find((entry) => entry.event.type === 'meridianProtectionLateStart')!
		expect(lateStart.event).toMatchObject({ type: 'meridianProtectionLateStart' })
		// Never quiescent before the deadline of the barrier, which the first event already saw.
		const barrier = events[0].barrier!
		const [off] = fake.of('tracking')
		expect(off.args[0]).toBeFalse()
		expect(off.wallNow - START + ORIGIN).toBeGreaterThanOrEqual(barrier.busyAckDeadline - SLACK)
		expect(events.find((entry) => entry.event.type === 'meridianHardProtection')?.event).toMatchObject({ late: true })
		expect(fake.hourAngle()).toBeLessThan(LATEST_AT + 60 * SIDEREAL_DRIFT_RATE)
		oracle()
	})

	test.skipIf(isTimeConsumingTestSkipped())('70: armed late with a Busy of the barrier that never ends, 2c turns tracking off but 2b fails the late protection', async () => {
		const guideOutput = await connected()
		silentDriver()
		const { runner, events, fake, oracle } = restart(guideOutput, 5)
		later(100, () => guideVector(guideOutput, 'TELESCOPE_TIMED_GUIDE_NS', 'Busy'))
		const result = await runner.handle.result

		expect(result.state).not.toBe('completed')
		expect(events.find((entry) => entry.event.type === 'meridianProtectionFailed')?.event).toMatchObject({ reason: 'mountNotQuiescent', lateStart: true })
		expect(fake.of('tracking').map((command) => command.args[0])).toEqual([false])
		expect(fake.mount.tracking).toBeFalse()
		// The startup task waiting for the protection never started once it stopped the session.
		expect(events.some((entry) => entry.event.type === 'taskStarted' && entry.event.task === 'quiesceDitherPulses')).toBeFalse()
		oracle()
		guideVector(guideOutput, 'TELESCOPE_TIMED_GUIDE_NS', 'Ok')
	})

	test.skipIf(isTimeConsumingTestSkipped())('72: a Busy that never returns to Idle fails the startup as mountNotQuiescent: dispatchedPulseUnobserved', async () => {
		const guideOutput = await connected()
		silentDriver()
		const { runner, completedAt, oracle } = restart(guideOutput)
		later(100, () => guideVector(guideOutput, 'TELESCOPE_TIMED_GUIDE_WE', 'Busy'))

		const result = await runner.handle.result

		expect(result).toMatchObject({ state: 'failed' })
		expect(JSON.stringify(result)).toContain('dispatchedPulseUnobserved')
		expect(completedAt()).toBeUndefined()
		oracle()
		guideVector(guideOutput, 'TELESCOPE_TIMED_GUIDE_WE', 'Ok')
	})
})
