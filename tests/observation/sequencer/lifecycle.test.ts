import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { join } from 'path'
import { SIDEREAL_DRIFT_RATE } from '../../../src/core/constants'
import type { PierSide } from '../../../src/devices/indi/device'
import { failedOperationResult, type OperationResult } from '../../../src/devices/orchestration/operation'
import { abortableDelay } from '../../../src/devices/orchestration/operation.wait'
import { deg, hour, normalizeAngle, normalizePI } from '../../../src/math/units/angle'
import { awaitCameraRecoveryTask, captureFrameStep } from '../../../src/observation/sequencer/capture'
// oxfmt-ignore
import { ensureTrackingTask, isSequencerMountOffTarget, meridianGracefulDeadline, type SequencerLifecycleServices, sequencerMountHourAngle, sequencerShutdownLifecycleTasks, sequencerStartupLifecycleTasks, sequencerFrameHourAngleSpan, sequencerStartupTrackMode, sequencerTrackingDecision, thermalStableSince, waitForStableTemperature } from '../../../src/observation/sequencer/lifecycle'
import { sequencerMountMotionBounds } from '../../../src/observation/sequencer/pointing'
import { startSequencerRunner } from '../../../src/observation/sequencer/runner'
// oxfmt-ignore
import type { SequencerCameraCapture, SequencerClock, SequencerConfiguration, SequencerCoolingConfiguration, SequencerEvent, SequencerMeridianFlipConfiguration, SequencerResult, SequencerShutdownConfiguration, SequencerStartupConfiguration } from '../../../src/observation/sequencer/sequencer'
import { FileSystemSequencerCheckpointStore, FileSystemSequencerStorage, prepareFrameDestinationTask } from '../../../src/observation/sequencer/storage'
import { waitUntil } from '../../util'
// oxfmt-ignore
import { assertMountKeyClosure } from './meridian.util'
import { assertRunnerInvariants, assertSequencerInvariants, connectSequencerRig, createSequencerRig, createTestSequence, type DeviceCommandEntry, type DeviceLogEntry, expectNoSequencerLeaks, ManualSequencerClock, recordDevices, recordLeases, recordRunner, resetSequencerRig, type RunnerLogEntry } from './util'

// Equipment lifecycle of the Sequencer: the thermal stability wait and the pure meridian rule of `ensureTracking`
// with a manual clock, then startup, pre-capture tracking and shutdown on the INDI simulator rig with the real
// commanders, the real CameraCapturer and the e2e clock (the simulated UTC of the mount as wall time).

const COOLING: SequencerCoolingConfiguration = { setpoint: -10, tolerance: 0.5, stableFor: 60, timeout: 600, waitForTemperature: true }

// Camera reading of the thermal wait tests, mutated by the test and announced through `emit`.
function fakeCamera(temperature: number) {
	const listeners = new Set<VoidFunction>()
	const camera = { name: 'Camera', connected: true, temperature }
	const updates = (listener: VoidFunction) => {
		listeners.add(listener)
		return () => listeners.delete(listener)
	}
	const sample = (value: number) => {
		camera.temperature = value
		for (const listener of listeners) listener()
	}
	return { camera, updates, sample, listeners }
}

// Lets the continuations of the wait run.
async function flush() {
	for (let i = 0; i < 5; i++) await Promise.resolve()
}

describe('thermal stability', () => {
	test('a stable run starts with the first sample within tolerance and restarts out of it', () => {
		expect(thermalStableSince(undefined, -10.4, COOLING, 100)).toBe(100)
		expect(thermalStableSince(100, -9.6, COOLING, 200)).toBe(100)
		expect(thermalStableSince(100, -10.5, COOLING, 300)).toBe(100)
		expect(thermalStableSince(100, -10.51, COOLING, 400)).toBeUndefined()
		expect(thermalStableSince(100, Number.NaN, COOLING, 400)).toBeUndefined()
	})

	test('resolves after stableFor seconds of continuous samples within tolerance, on the monotonic clock', async () => {
		const clock = new ManualSequencerClock()
		const { camera, updates, sample, listeners } = fakeCamera(5)
		let result: OperationResult<void> | undefined
		void waitForStableTemperature(camera, updates, COOLING, clock, new AbortController().signal).then((value) => (result = value))

		await clock.advance(30_000)
		sample(-10.2)
		await flush()
		// The wall clock jumps both ways in the middle of the window; nothing moves.
		clock.jumpWall(-3_600_000)
		await clock.advance(59_999)
		clock.jumpWall(7_200_000)
		expect(result).toBeUndefined()

		await clock.advance(1)
		expect(result).toEqual({ ok: true, value: undefined })
		expect(clock.pending).toBe(0)
		expect(listeners.size).toBe(0)
	})

	test('a sample out of tolerance restarts the window', async () => {
		const clock = new ManualSequencerClock()
		const { camera, updates, sample } = fakeCamera(-10)
		let result: OperationResult<void> | undefined
		void waitForStableTemperature(camera, updates, COOLING, clock, new AbortController().signal).then((value) => (result = value))

		await clock.advance(50_000)
		sample(-9)
		await flush()
		await clock.advance(20_000)
		sample(-10.1)
		await flush()
		await clock.advance(59_000)
		expect(result).toBeUndefined()

		await clock.advance(1_000)
		expect(result?.ok).toBeTrue()
		expect(clock.monotonicNow()).toBe(130_000)
	})

	test('a stability of zero seconds resolves on the first sample within tolerance', async () => {
		const clock = new ManualSequencerClock()
		const { camera, updates } = fakeCamera(-10)
		expect(await waitForStableTemperature(camera, updates, { ...COOLING, stableFor: 0 }, clock, new AbortController().signal)).toEqual({ ok: true, value: undefined })
	})

	test('times out after timeout seconds of the monotonic clock', async () => {
		const clock = new ManualSequencerClock()
		const { camera, updates, sample } = fakeCamera(0)
		let result: OperationResult<void> | undefined
		void waitForStableTemperature(camera, updates, COOLING, clock, new AbortController().signal).then((value) => (result = value))

		await clock.advance(590_000)
		sample(-10)
		await flush()
		await clock.advance(9_999)
		expect(result).toBeUndefined()
		await clock.advance(1)
		expect(result).toMatchObject({ ok: false, reason: 'timeout' })
		expect(clock.pending).toBe(0)
	})

	test('ends with the reason of the signal, or disconnected when the camera disconnects', async () => {
		const clock = new ManualSequencerClock()
		const aborted = fakeCamera(0)
		const controller = new AbortController()
		const waiting = waitForStableTemperature(aborted.camera, aborted.updates, COOLING, clock, controller.signal)
		await flush()
		controller.abort('timeout')
		expect(await waiting).toMatchObject({ ok: false, reason: 'timeout' })

		const disconnected = fakeCamera(0)
		const disconnecting = waitForStableTemperature(disconnected.camera, disconnected.updates, COOLING, clock, new AbortController().signal)
		await flush()
		disconnected.camera.connected = false
		disconnected.sample(-10)
		expect(await disconnecting).toMatchObject({ ok: false, reason: 'disconnected' })
		expect(clock.pending).toBe(0)
		expect(aborted.listeners.size + disconnected.listeners.size).toBe(0)
	})
})

describe('tracking rule', () => {
	const FLIP: SequencerMeridianFlipConfiguration = { enabled: true, prepareAt: deg(-5), flipAt: 0, latestAt: deg(5), beforeFlipPierSide: 'EAST', afterFlipPierSide: 'WEST', protectionMargin: 120 }
	const deadline = deg(5) - 120 * SIDEREAL_DRIFT_RATE

	test('graceful deadline is latestAt minus the protection margin at the sidereal rate', () => {
		expect(meridianGracefulDeadline(FLIP)).toBeCloseTo(deadline, 15)
		expect(meridianGracefulDeadline({ latestAt: deg(5) })).toBeCloseTo(deadline, 15)
	})

	test('tracking goes on without meridian flip, on the post-flip side, or before the deadline', () => {
		const cases: readonly [SequencerMeridianFlipConfiguration | undefined, PierSide, number | undefined, boolean, ReturnType<typeof sequencerTrackingDecision>][] = [
			[undefined, 'EAST', deg(90), false, 'enable'],
			[{ ...FLIP, enabled: false }, 'EAST', undefined, false, 'enable'],
			[FLIP, 'WEST', undefined, false, 'enable'],
			[FLIP, 'WEST', deg(30), false, 'enable'],
			[FLIP, 'EAST', deadline - 1e-9, false, 'enable'],
			[FLIP, 'NEITHER', deg(-30), true, 'enable'],
			[FLIP, 'EAST', deadline, true, 'defer'],
			[FLIP, 'NEITHER', deg(20), true, 'defer'],
			[FLIP, 'EAST', deadline, false, 'blocked'],
			[FLIP, 'NEITHER', deg(170), false, 'blocked'],
			[FLIP, 'EAST', undefined, true, 'unobserved'],
		]

		for (const [flip, pierSide, hourAngle, awaiting, expected] of cases) expect(sequencerTrackingDecision(flip, pierSide, hourAngle, awaiting)).toBe(expected)
	})

	test('a mount off its target still to be acquired keeps tracking off before the graceful deadline', () => {
		expect(sequencerTrackingDecision(FLIP, 'EAST', deadline - 1e-3, true, true)).toBe('defer')
		// Without a pending acquisition, or on the post-flip side, being off target does not matter.
		expect(sequencerTrackingDecision(FLIP, 'EAST', deadline - 1e-3, false, true)).toBe('enable')
		expect(sequencerTrackingDecision(FLIP, 'WEST', deadline, true, true)).toBe('enable')
	})

	test('off target: the frame reaches the graceful deadline before the flip of the target comes due', () => {
		const span = 40 * SIDEREAL_DRIFT_RATE
		const s = SIDEREAL_DRIFT_RATE
		// The frame fits before the deadline.
		expect(isSequencerMountOffTarget(FLIP, deadline - 41 * s, deg(-30), span)).toBeFalse()
		// It does not, and the target flips hours later.
		expect(isSequencerMountOffTarget(FLIP, deadline - 39 * s, deg(-30), span)).toBeTrue()
		// It does not, but the target reaches flipAt before the mount reaches the deadline: the guard flips it.
		expect(isSequencerMountOffTarget(FLIP, deadline - 39 * s, FLIP.flipAt - 38 * s, span)).toBeFalse()
		expect(isSequencerMountOffTarget(FLIP, deadline - 39 * s, FLIP.flipAt - 40 * s, span)).toBeTrue()
		// A target past flipAt is flipped, never treated as off target.
		expect(isSequencerMountOffTarget(FLIP, deadline + s, FLIP.flipAt, span)).toBeFalse()
	})

	test('frame hour angle span is the exposure plus the guard margin at the sidereal rate', () => {
		const frame = { capture: { exposureTime: 10, exposureTimeUnit: 'second' } } as const
		expect(sequencerFrameHourAngleSpan({ meridianFlip: { ...FLIP, exposureMargin: 30 } }, frame)).toBeCloseTo(40 * SIDEREAL_DRIFT_RATE, 15)
		expect(sequencerFrameHourAngleSpan({ meridianFlip: { ...FLIP, enabled: false } }, frame)).toBe(0)
		expect(sequencerFrameHourAngleSpan({ meridianFlip: FLIP }, undefined)).toBe(0)
	})

	test('startup track mode: the configured one, SIDEREAL with a target or meridian flip, none otherwise', () => {
		const startup: SequencerStartupConfiguration = { onFailure: 'fail' }
		const target = { frame: 'J2000', rightAscension: 1, declination: 0.5 } as const
		expect(sequencerStartupTrackMode({ startup })).toBeUndefined()
		expect(sequencerStartupTrackMode({ startup: { ...startup, mount: { unpark: true } } })).toBeUndefined()
		expect(sequencerStartupTrackMode({ startup: { ...startup, mount: { unpark: false, trackMode: 'LUNAR' } } })).toBe('LUNAR')
		expect(sequencerStartupTrackMode({ startup, target })).toBe('SIDEREAL')
		expect(sequencerStartupTrackMode({ startup, meridianFlip: FLIP })).toBe('SIDEREAL')
		expect(sequencerStartupTrackMode({ startup, meridianFlip: { ...FLIP, enabled: false } })).toBeUndefined()
	})

	test('physical hour angle is the apparent sidereal time minus the published right ascension', () => {
		// 2026-01-01T00:00Z is 9496.5 days after J2000.0; GMST = 18.697374558 h + 24.06570982441908 h/day (IAU 1982,
		// within 0.1 s here). Apparent and UT1 corrections stay below 2 s of time (1.5e-4 rad).
		const wallNow = Date.UTC(2026, 0, 1)
		const gmst = ((18.697374558 + 24.06570982441908 * 9496.5) % 24) * (Math.PI / 12)
		const longitude = deg(-45)
		const rightAscension = hour(3)
		const mount = { hasGeographicCoordinate: true, hasEquatorialCoordinate: true, geographicCoordinate: { latitude: deg(-23), longitude, elevation: 0 }, equatorialCoordinate: { rightAscension, declination: 0 } }

		expect(sequencerMountHourAngle(mount, wallNow)).toBeCloseTo(normalizePI(gmst + longitude - rightAscension), 3)
		expect(sequencerMountHourAngle({ ...mount, hasGeographicCoordinate: false }, wallNow)).toBeUndefined()
		expect(sequencerMountHourAngle({ ...mount, hasEquatorialCoordinate: false }, wallNow)).toBeUndefined()
	})
})

// Rig of the simulator scenarios, created once for the file.
const rig = await createSequencerRig()
const ROOT = join(rig.capturesDir, 'sessions')
const clock: SequencerClock = { wallNow: () => rig.simulators.mount.utcTime, monotonicNow: () => performance.now(), delay: abortableDelay }
const services: SequencerLifecycleServices = { cameraCommander: rig.commanders.camera, thermometerManager: rig.managers.thermometer, mountCommander: rig.commanders.mount, coverCommander: rig.commanders.cover, domeCommander: rig.commanders.dome, flatPanelCommander: rig.commanders.flatPanel }

describe('on the simulator rig', () => {
	const LIGHT: SequencerCameraCapture = { exposureTime: 10, exposureTimeUnit: 'millisecond', frameType: 'LIGHT', x: 0, y: 0, width: 64, height: 64, subframe: true, binX: 2, binY: 2, frameFormat: 'MONO', gain: 10, offset: 5, compressed: false }
	const DARK: SequencerCameraCapture = { ...LIGHT, frameType: 'DARK' }
	const ALL_SHUTDOWN: SequencerShutdownConfiguration = { stepTimeout: 30, totalTimeout: 300, stopTracking: 'required', closeCover: 'required', parkMount: 'required', closeOrParkDome: 'required', turnOffFlatPanel: 'required', warmCamera: 'required' }
	const OPEN_STARTUP: SequencerStartupConfiguration = { cooling: { setpoint: 10, tolerance: 1, stableFor: 0, timeout: 60, waitForTemperature: false }, dome: { open: true }, cover: { open: true }, mount: { unpark: true, trackMode: 'SIDEREAL' }, onFailure: 'fail' }

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

	function configurationOf(options: Partial<Pick<SequencerConfiguration, 'startup' | 'shutdown' | 'target' | 'meridianFlip'>> & { readonly frames?: readonly SequencerCameraCapture[] } = {}): SequencerConfiguration {
		const frames = options.frames ?? [LIGHT]
		return {
			schemaVersion: 1,
			id: 'lifecycle',
			revision: 1,
			name: 'Lifecycle',
			...(options.target !== undefined && { target: options.target }),
			...(options.meridianFlip !== undefined && { meridianFlip: options.meridianFlip }),
			capture: { order: 'sequential', groups: frames.map((capture, i) => ({ kind: 'scheduled', id: `G${i}`, enabled: true, capture, count: 1 })), retry: { maxAttempts: 1, delay: 0, backoff: 1, maximumDelay: 0, retryOn: [] }, onFailure: 'fail', cameraRecovery: { onTimeout: 'stop' } },
			startup: options.startup ?? { onFailure: 'fail' },
			shutdown: options.shutdown ?? { stepTimeout: 30, totalTimeout: 300 },
			execution: { compensation: { timeout: 30 } },
		}
	}

	interface Session {
		readonly result: SequencerResult
		readonly events: SequencerEvent[]
		readonly devices: DeviceLogEntry[]
		readonly roots: RunnerLogEntry[]
	}

	// Runs a session with the lifecycle startup and shutdown of its configuration, `ensureTracking`, the camera
	// recovery wait and the frame destination in the pre-capture, and the real capture.
	async function runSession(configuration: SequencerConfiguration, onEvent?: (event: SequencerEvent) => void): Promise<Session> {
		const sequence = createTestSequence()
		const devices = recordDevices(rig, clock, sequence)
		const roots = recordRunner(rig.coordinator, sequence)
		const leases = recordLeases(rig.arbiter)
		const storage = new FileSystemSequencerStorage({ root: ROOT, sessionId: Bun.randomUUIDv7(), wallNow: clock.wallNow })
		const events: SequencerEvent[] = []
		const phases = {
			startup: sequencerStartupLifecycleTasks(configuration, services),
			preCapture: [ensureTrackingTask(services, configuration), awaitCameraRecoveryTask(rig.arbiter, configuration.capture.cameraRecovery), prepareFrameDestinationTask(storage)],
			capture: captureFrameStep({ cameraCapturer: rig.capturer, storage }),
			shutdown: sequencerShutdownLifecycleTasks(configuration.shutdown, services),
		}
		const listener = (event: SequencerEvent) => {
			roots.listener(event)
			events.push(event)
			onEvent?.(event)
		}
		const { mount, wheel, focuser, rotator, cover, dome, flatPanel, camera } = rig.devices()
		const runner = startSequencerRunner({ configuration, devices: { camera, mount, wheel, focuser, rotator, cover, dome, flatPanel }, services: { coordinator: rig.coordinator, storage, checkpointStore: new FileSystemSequencerCheckpointStore(ROOT), clock, listener }, phases })

		try {
			const result = await runner.handle.result
			// 61: every lifecycle root that leased the mount has its row in the motion table.
			assertMountKeyClosure(leases.entries, sequencerMountMotionBounds(configuration, { mount }, undefined))
			return { result, events, devices: devices.entries, roots: roots.entries }
		} finally {
			devices[Symbol.dispose]()
			roots[Symbol.dispose]()
			leases[Symbol.dispose]()
		}
	}

	// Closes the observatory through the commanders: park positions set where the mount and the dome stand (so parking
	// is quick), mount parked with tracking off at LUNAR, dome shutter closed and dome parked, cover closed, flat panel
	// on, cooler off.
	async function closeObservatory() {
		const { commanders, coordinator, managers } = rig
		const { mount, dome, cover, flatPanel } = rig.devices()
		const expectOk = (result: OperationResult<unknown>) => expect(result).toMatchObject({ ok: true })

		expectOk(await commanders.mount.setTrackMode(coordinator, mount, 'LUNAR'))
		expectOk(await commanders.mount.setPark(coordinator, mount))
		expectOk(await commanders.mount.park(coordinator, mount))
		expectOk(await commanders.dome.setPark(coordinator, dome))
		expectOk(await commanders.dome.closeShutter(coordinator, dome))
		expectOk(await commanders.dome.park(coordinator, dome))
		expectOk(await commanders.cover.park(coordinator, cover))
		expectOk(await commanders.flatPanel.enable(coordinator, flatPanel))
		await waitUntil(() => flatPanel.enabled && mount.parked && dome.parked && dome.shutterState === 'CLOSED' && cover.parked, 5000, 10)
		managers.camera.cooler(rig.devices().camera, false)
	}

	function commandsOf(entries: readonly DeviceLogEntry[]) {
		return entries.filter((entry): entry is DeviceCommandEntry => entry.kind === 'command')
	}

	function sequenceOf(entries: readonly DeviceLogEntry[], predicate: (entry: DeviceCommandEntry) => boolean) {
		return commandsOf(entries).find(predicate)?.sequence ?? -1
	}

	const is =
		(manager: DeviceCommandEntry['manager'], command: string, ...args: unknown[]) =>
		(entry: DeviceCommandEntry) =>
			entry.manager === manager && entry.command === command && args.every((arg, i) => entry.args[i] === arg)

	// Sequence of the first event matching, from the shared runner log.
	function eventSequence(roots: readonly RunnerLogEntry[], predicate: (event: SequencerEvent) => boolean) {
		return roots.find((entry) => entry.kind === 'event' && predicate(entry.event))?.sequence ?? -1
	}

	test('startup opens the observatory and selects SIDEREAL without turning tracking on; ensureTracking does it once; the shutdown closes everything', async () => {
		await closeObservatory()
		const configuration = configurationOf({ target: { frame: 'J2000', rightAscension: hour(5), declination: deg(-30) }, startup: OPEN_STARTUP, shutdown: ALL_SHUTDOWN, frames: [LIGHT, LIGHT] })
		const { result, devices, roots } = await runSession(configuration)

		expect(result).toMatchObject({ state: 'completed', shutdownFailures: [], compensationFailures: [] })
		expect(result.failure).toBeUndefined()

		// Startup order, every opening once; tracking is never commanded on before the pre-capture.
		const preCapture = eventSequence(roots, (event) => event.type === 'phaseChanged' && event.phase === 'preCapture')
		const startupOrder = [is('camera', 'cooler', true), is('camera', 'temperature', 10), is('dome', 'unpark'), is('dome', 'openShutter'), is('cover', 'unpark'), is('mount', 'unpark'), is('mount', 'trackMode', 'SIDEREAL')].map((predicate) => sequenceOf(devices, predicate))
		expect(startupOrder.every((sequence) => sequence > 0)).toBeTrue()
		expect(startupOrder).toEqual(startupOrder.toSorted((a, b) => a - b))
		expect(startupOrder.at(-1)!).toBeLessThan(preCapture)

		const commands = commandsOf(devices)
		const trackingOn = commands.filter(is('mount', 'tracking', true))
		expect(trackingOn).toHaveLength(1)
		expect(trackingOn[0].sequence).toBeGreaterThan(preCapture)
		expect(commands.filter(is('mount', 'trackMode'))).toHaveLength(1)

		// I38: SIDEREAL is observed before tracking goes on, and tracking is observed before the first exposure.
		const sidereal = devices.find((entry) => entry.kind === 'transition' && entry.property === 'trackMode' && entry.value === 'SIDEREAL')
		expect(sidereal!.sequence).toBeLessThan(trackingOn[0].sequence)
		const tracking = devices.find((entry) => entry.kind === 'transition' && entry.property === 'tracking' && entry.value === true)
		expect(tracking!.sequence).toBeLessThan(sequenceOf(devices, is('camera', 'startExposure')))
		expect(commands.filter(is('camera', 'startExposure'))).toHaveLength(2)

		// Shutdown in its physical order, after the frames.
		const shutdownOrder = [is('mount', 'tracking', false), is('cover', 'park'), is('mount', 'park'), is('dome', 'closeShutter'), is('dome', 'park'), is('flatPanel', 'disable'), is('camera', 'cooler', false)].map((predicate) => sequenceOf(devices, predicate))
		expect(shutdownOrder[0]).toBeGreaterThan(commands.findLast(is('camera', 'startExposure'))!.sequence)
		expect(shutdownOrder.every((sequence) => sequence > 0)).toBeTrue()
		expect(shutdownOrder).toEqual(shutdownOrder.toSorted((a, b) => a - b))

		const { mount, dome, cover, flatPanel, camera } = rig.devices()
		await waitUntil(() => mount.parked && !mount.tracking && cover.parked && dome.parked && dome.shutterState === 'CLOSED' && !flatPanel.enabled && !camera.cooler, 5000, 10)

		assertSequencerInvariants(devices)
		assertRunnerInvariants(roots)
	}, 60000)

	test('a partial startup failure still runs a coherent shutdown that closes only what was opened', async () => {
		await closeObservatory()
		const unpark = spyOn(rig.commanders.cover, 'unpark').mockResolvedValue(failedOperationResult('commandFailed', 'cover jammed'))

		const configuration = configurationOf({ target: { frame: 'J2000', rightAscension: hour(5), declination: deg(-30) }, startup: OPEN_STARTUP, shutdown: ALL_SHUTDOWN })
		const { result, devices, roots, events } = await runSession(configuration)
		unpark.mockRestore()

		expect(result).toMatchObject({ state: 'failed', failure: { kind: 'operation', reason: 'commandFailed', task: 'openCover' }, shutdownFailures: [] })
		expect(result.capture.groups[0].accepted).toBe(0)

		const commands = commandsOf(devices)
		// Nothing after the failed opening ran: the mount was never unparked nor tracked, and nothing was exposed.
		expect(commands.some(is('mount', 'unpark'))).toBeFalse()
		expect(commands.some(is('mount', 'trackMode'))).toBeFalse()
		expect(commands.some(is('mount', 'tracking'))).toBeFalse()
		expect(commands.some(is('camera', 'startExposure'))).toBeFalse()
		expect(events.some((event) => event.type === 'phaseChanged' && event.phase === 'preCapture')).toBeFalse()

		// The shutdown closed the dome and warmed the camera it had opened and cooled, turned the panel off, and sent nothing
		// to the devices already safe (mount parked without tracking, cover closed).
		const shutdown = eventSequence(roots, (event) => event.type === 'shutdownStarted')
		expect(sequenceOf(devices, is('dome', 'closeShutter'))).toBeGreaterThan(shutdown)
		expect(sequenceOf(devices, is('dome', 'park'))).toBeGreaterThan(shutdown)
		expect(sequenceOf(devices, is('flatPanel', 'disable'))).toBeGreaterThan(shutdown)
		expect(sequenceOf(devices, is('camera', 'cooler', false))).toBeGreaterThan(shutdown)
		expect(commands.some(is('mount', 'park'))).toBeFalse()
		expect(commands.some(is('cover', 'park'))).toBeFalse()
		expect(events.some((event) => event.type === 'taskStarted' && (event.task === 'stopTracking' || event.task === 'parkMount' || event.task === 'closeCover'))).toBeFalse()

		const { dome, camera } = rig.devices()
		await waitUntil(() => dome.parked && dome.shutterState === 'CLOSED' && !camera.cooler, 5000, 10)

		assertSequencerInvariants(devices)
		assertRunnerInvariants(roots)
	}, 60000)

	test('startup and shutdown on an observatory already in place command nothing', async () => {
		// The rig starts unparked with the cover open; the dome is opened here and the panel and cooler are off.
		const { commanders, coordinator } = rig
		const { dome, mount } = rig.devices()
		expect(await commanders.dome.unpark(coordinator, dome)).toMatchObject({ ok: true })
		expect(await commanders.dome.openShutter(coordinator, dome)).toMatchObject({ ok: true })
		expect(await commanders.mount.setTrackMode(coordinator, mount, 'SIDEREAL')).toMatchObject({ ok: true })

		const startup: SequencerStartupConfiguration = { dome: { open: true }, cover: { open: true }, mount: { unpark: true, trackMode: 'SIDEREAL' }, onFailure: 'fail' }
		const shutdown: SequencerShutdownConfiguration = { stepTimeout: 30, totalTimeout: 300, stopTracking: 'required', turnOffFlatPanel: 'required', warmCamera: 'required' }
		const { result, devices, events } = await runSession(configurationOf({ startup, shutdown }))

		expect(result).toMatchObject({ state: 'completed', shutdownFailures: [] })
		expect(commandsOf(devices).filter((entry) => entry.manager !== 'camera' || (entry.command !== 'startExposure' && entry.command !== 'frameType'))).toEqual([])
		expect(events.filter((event) => event.type === 'taskStarted' && (event.phase === 'startup' || event.phase === 'shutdown'))).toEqual([])

		expect(await commanders.dome.closeShutter(coordinator, dome)).toMatchObject({ ok: true })
	}, 60000)

	test('a failing shutdown step is reported and the following steps still run; bestEffort keeps the session completed', async () => {
		const { commanders, coordinator } = rig
		const { flatPanel, camera, cover } = rig.devices()
		expect(await commanders.flatPanel.enable(coordinator, flatPanel)).toMatchObject({ ok: true })
		rig.managers.camera.cooler(camera, true)
		await waitUntil(() => flatPanel.enabled && camera.cooler, 5000, 10)
		const park = spyOn(rig.commanders.cover, 'park').mockResolvedValue(failedOperationResult('commandFailed', 'cover jammed'))

		for (const policy of ['bestEffort', 'required'] as const) {
			const shutdown: SequencerShutdownConfiguration = { stepTimeout: 30, totalTimeout: 300, closeCover: policy, turnOffFlatPanel: 'required', warmCamera: 'required' }
			const { result, events } = await runSession(configurationOf({ shutdown }))

			expect(result).toMatchObject({ state: policy === 'required' ? 'failed' : 'completed', shutdownFailures: [{ kind: 'operation', reason: 'commandFailed', task: 'closeCover' }] })
			expect(result.failure).toBeUndefined()
			if (policy === 'bestEffort') {
				const order = [(event: SequencerEvent) => event.type === 'taskFailed' && event.task === 'closeCover', (event: SequencerEvent) => event.type === 'taskCompleted' && event.task === 'turnOffFlatPanel', (event: SequencerEvent) => event.type === 'taskCompleted' && event.task === 'warmCamera'].map(
					(predicate) => events.findIndex(predicate),
				)
				expect(order[0]).toBeGreaterThanOrEqual(0)
				expect(order).toEqual(order.toSorted((a, b) => a - b))
			}
		}

		park.mockRestore()
		expect(cover.parked).toBeFalse()
		await waitUntil(() => !flatPanel.enabled && !camera.cooler, 5000, 10)
	}, 60000)

	test('cooling waits for the thermal stability before the first frame', async () => {
		const startup: SequencerStartupConfiguration = { cooling: { setpoint: 15, tolerance: 1, stableFor: 0.5, timeout: 30, waitForTemperature: true }, onFailure: 'fail' }
		const { camera } = rig.devices()
		const temperatures: number[] = []
		const { result, events } = await runSession(configurationOf({ startup, shutdown: { stepTimeout: 30, totalTimeout: 300, warmCamera: 'required' } }), (event) => {
			if (event.type === 'exposureStarted') temperatures.push(camera.temperature)
		})

		expect(result).toMatchObject({ state: 'completed' })
		expect(events.some((event) => event.type === 'taskCompleted' && event.task === 'coolCamera')).toBeTrue()
		expect(temperatures).toHaveLength(1)
		expect(Math.abs(temperatures[0] - 15)).toBeLessThanOrEqual(1)
		await waitUntil(() => !camera.cooler, 5000, 10)
	}, 60000)

	test('ensureTracking defers tracking in the meridian zone before the acquisition, and turns it on before the deadline', async () => {
		const { commanders, coordinator } = rig
		const { mount } = rig.devices()
		const flip = (pierSide: PierSide): SequencerMeridianFlipConfiguration => ({ enabled: true, prepareAt: deg(-10), flipAt: deg(-5), latestAt: deg(5), beforeFlipPierSide: pierSide === 'WEST' ? 'WEST' : 'EAST', afterFlipPierSide: pierSide === 'WEST' ? 'EAST' : 'WEST', protectionMargin: 120 })
		const target = { frame: 'J2000', rightAscension: hour(5), declination: deg(-30) } as const
		const shutdown: SequencerShutdownConfiguration = { stepTimeout: 30, totalTimeout: 300, stopTracking: 'required' }

		// Points the mount (tracking off, so its hour angle stays put) at the physical hour angle `ha`.
		const pointAt = async (ha: number) => {
			const lst = sequencerMountHourAngle({ ...mount, equatorialCoordinate: { rightAscension: 0, declination: 0 } }, clock.wallNow())!
			expect(await commanders.mount.sync(coordinator, mount, { type: 'JNOW', JNOW: { x: normalizeAngle(lst - ha), y: deg(-30) } })).toMatchObject({ ok: true })
			await waitUntil(() => Math.abs(normalizePI(sequencerMountHourAngle(mount, clock.wallNow())! - ha)) < deg(0.05), 5000, 10)
		}

		// Past the graceful deadline on the pre-flip side, target not acquired: only the track mode, tracking stays off.
		await pointAt(deg(4.9))
		const deferred = await runSession(configurationOf({ target, meridianFlip: flip(mount.pierSide), startup: { mount: { unpark: false, trackMode: 'SIDEREAL' }, onFailure: 'fail' }, shutdown, frames: [DARK] }))
		expect(deferred.result).toMatchObject({ state: 'completed' })
		expect(commandsOf(deferred.devices).some(is('mount', 'tracking', true))).toBeFalse()
		expect(deferred.events.find((event) => event.type === 'trackingDeferred')).toMatchObject({ reason: 'meridianZone' })
		expect((deferred.events.find((event) => event.type === 'trackingDeferred') as { mountHourAngle: number }).mountHourAngle).toBeCloseTo(deg(4.9), 2)

		// Without a target the zone blocks tracking: the meridian policy stops the session before any exposure.
		const blocked = await runSession(configurationOf({ meridianFlip: flip(mount.pierSide), shutdown, frames: [DARK] }))
		expect(blocked.result).toMatchObject({ state: 'stopped', stopCause: 'policy', failure: { kind: 'operation', reason: 'unexpectedState', task: 'ensureTracking' } })
		expect(commandsOf(blocked.devices).some(is('mount', 'tracking', true))).toBeFalse()
		expect(commandsOf(blocked.devices).some(is('camera', 'startExposure'))).toBeFalse()

		// Before the deadline tracking goes on, once.
		await pointAt(deg(-20))
		const enabled = await runSession(configurationOf({ target, meridianFlip: flip(mount.pierSide), shutdown, frames: [LIGHT] }))
		expect(enabled.result).toMatchObject({ state: 'completed' })
		expect(commandsOf(enabled.devices).filter(is('mount', 'tracking', true))).toHaveLength(1)
		expect(commandsOf(enabled.devices).filter(is('mount', 'tracking', false))).toHaveLength(1)
		expect(enabled.events.some((event) => event.type === 'trackingDeferred')).toBeFalse()
	}, 60000)
})
