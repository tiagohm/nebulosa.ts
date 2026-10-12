import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { GUIDE_PULSE_ACK_MARGIN, guidePulseReleaseBound } from '../../../src/devices/commanders/guideoutput'
import { type Camera, DEFAULT_CAMERA } from '../../../src/devices/indi/device'
import type { CameraManager } from '../../../src/devices/indi/manager/camera'
import { type OperationScope, successfulOperationResult } from '../../../src/devices/orchestration/operation'
import { type ResourceReservation, resourceKey } from '../../../src/devices/orchestration/resource'
import { arcsec, deg } from '../../../src/math/units/angle'
import { type GuidePulseAdmission, GuiderClient, type GuiderClientGuiderOptions } from '../../../src/observation/guiding/client'
import type { DitherPhase, DitherRequest } from '../../../src/observation/guiding/ditherer'
import type { GuidingSettle } from '../../../src/observation/guiding/session'
import { guideOutputLifecycleKey, LocalGuidingSession } from '../../../src/observation/guiding/session.client'
import { StarTracker } from '../../../src/observation/guiding/tracker.star'
import { waitUntil } from '../../util'
import { assertSequencerInvariants, connectSequencerRig, createSequencerRig, expectNoSequencerLeaks, ManualSequencerClock, recordDevices, resetSequencerRig } from '../sequencer/util'

// LocalGuidingSession over a real GuiderClient whose guide camera is a fake (its exposures go nowhere) and whose guide
// output is the ST4 port of the mount simulator of the Sequencer rig, with the real GuideOutputCommander, arbiter,
// coordinator and device lifecycle. Settles are reported by injecting the SettleDone event of the client.

const SETTLE: GuidingSettle = { pixels: 1.5, time: 1, timeout: 10 }
const OWNER = { id: 'observation', kind: 'test' }

// Camera manager that records nothing and exposes nothing.
class FakeCameraManager {
	addHandler() {}
	removeHandler() {}
	enableBlob() {}
	disableBlob() {}
	startExposure() {}
	stopExposure() {}
}

const GUIDE_CAMERA: Camera = { ...DEFAULT_CAMERA, id: 'Guide Camera', name: 'Guide Camera', hardwareId: 'guide-camera', connected: true }

const rig = await createSequencerRig()

beforeAll(async () => {
	await connectSequencerRig(rig)
})

afterAll(async () => {
	await rig[Symbol.asyncDispose]()
})

beforeEach(async () => {
	await resetSequencerRig(rig, rig.devices().focuser.position.value)
})

// Every session of a test, disposed after it.
const sessions: { readonly client: GuiderClient; readonly session: LocalGuidingSession; reservation?: ResourceReservation }[] = []

afterEach(async () => {
	for (const { client, session, reservation } of sessions.splice(0)) {
		await session.stop(rig.coordinator)
		session.endRun()
		client.stopCapture()
		client.disconnect()
		reservation?.release()
	}

	expect(rig.arbiter.ownersOf(resourceKey(GUIDE_CAMERA))).toEqual([])
	await waitUntil(() => !rig.devices().guideOutput.pulsing, 3000, 10)
	await expectNoSequencerLeaks(rig)
})

interface Setup {
	readonly client: GuiderClient
	readonly session: LocalGuidingSession
	readonly guider: GuiderClientGuiderOptions
	readonly clock: ManualSequencerClock
}

function setup(options: { readonly pulseCeiling?: number; readonly guider?: GuiderClientGuiderOptions } = {}): Setup {
	const guider = { ...options.guider }
	const client = new GuiderClient(new FakeCameraManager() as unknown as CameraManager, rig.managers.guideOutput, new StarTracker(), { guider })
	const clock = new ManualSequencerClock()
	const session = new LocalGuidingSession(client, GUIDE_CAMERA, rig.devices().guideOutput, rig.commanders.guideOutput, { pulseCeiling: options.pulseCeiling, delay: clock.delay })
	sessions.push({ client, session })
	return { client, session, guider, clock }
}

// Reserves what the session reserves and returns the scope that opens roots under the reservation.
function reserve(session: LocalGuidingSession) {
	const reserved = rig.arbiter.reserve(OWNER, session.resources().reserve)
	if (!reserved.ok) throw new Error('the reservation was refused')
	const entry = sessions.find((each) => each.session === session)!
	entry.reservation = reserved.reservation
	return rig.coordinator.reservedScope(reserved.reservation)
}

function settleDone(client: GuiderClient, status = 0) {
	client.emitEvent('SettleDone', { Status: status, TotalFrames: 1, DroppedFrames: 0 })
}

// Starts guiding and reports the settle once the client guides.
async function startGuiding(setup: Setup, reservation: OperationScope, task: OperationScope = rig.coordinator, status = 0) {
	const pending = setup.session.start(task, reservation, { recalibrate: false, settle: SETTLE, clock: setup.clock })
	await waitUntil(() => setup.client.getAppState() !== 'Stopped', 2000, 1)
	settleDone(setup.client, status)
	return await pending
}

describe('49.11 run admission', () => {
	test('71: beginRun is synchronous, commands nothing and its refusal installs nothing', () => {
		const first = setup()
		const pulse = spyOn(rig.managers.guideOutput, 'pulse')

		try {
			const begun = first.session.beginRun()
			expect(begun).toEqual(successfulOperationResult(undefined))
			expect(begun instanceof Promise).toBeFalse()
			expect(pulse).not.toHaveBeenCalled()

			// The same client cannot be admitted twice; the refusal leaves nothing behind.
			const second = new LocalGuidingSession(first.client, GUIDE_CAMERA, rig.devices().guideOutput, rig.commanders.guideOutput)
			expect(second.beginRun()).toMatchObject({ ok: false, reason: 'busy' })
			second.endRun()
			expect(first.session.beginRun()).toMatchObject({ ok: false, reason: 'busy' })

			first.session.endRun()
			first.session.endRun()
			expect(second.beginRun().ok).toBeTrue()
			second.endRun()
		} finally {
			pulse.mockRestore()
		}
	})

	test('39: the ceiling and the bound are frozen at construction; a longer configured pulse refuses the run', () => {
		const { client, session, guider } = setup({ guider: { maxPulseMsRA: 2500, maxPulseMsDEC: 2500 } })
		const ceiling = client.maxPulseDuration()
		expect(session.pulseCeiling).toBe(ceiling)
		expect(session.pulseQuiescenceBound()).toBe(guidePulseReleaseBound(ceiling))

		const admit = spyOn(client, 'admitPulses')
		;(guider as { maxPulseMsRA: number }).maxPulseMsRA = ceiling * 2
		expect(session.pulseQuiescenceBound()).toBe(guidePulseReleaseBound(ceiling))
		expect(session.beginRun()).toMatchObject({ ok: false, reason: 'unexpectedState' })
		expect(admit.mock.calls.map(([maximum]) => maximum)).toEqual([ceiling])
		admit.mockRestore()

		;(guider as { maxPulseMsRA: number }).maxPulseMsRA = 2500
		expect(session.beginRun().ok).toBeTrue()
		expect(session.pulseQuiescenceBound()).toBe(guidePulseReleaseBound(ceiling))
	})

	test('40: the gate stays closed until the first start and after a stop; endRun gives the client back', async () => {
		const context = setup()
		const { client, session } = context
		const reservation = reserve(session)
		client.connect(GUIDE_CAMERA, rig.devices().guideOutput)
		client.loop()
		expect(session.beginRun().ok).toBeTrue()

		expect(client.guidePulse(100, 'North')).toBeFalse()
		expect(client.getAppState()).toBe('Looping')

		expect(await startGuiding(context, reservation)).toEqual(successfulOperationResult(undefined))
		expect(client.guidePulse(100, 'North')).toBeTrue()
		await waitUntil(() => !rig.devices().guideOutput.pulsing, 3000, 10)

		expect(await session.stop(rig.coordinator)).toEqual(successfulOperationResult(undefined))
		expect(client.guidePulse(100, 'North')).toBeFalse()

		session.endRun()
		expect(client.guidePulse(100, 'North')).toBeTrue()
	})

	test('84 and 85: the start handlers already see the gate open; a refused guide closes it in the same tick, with no settle', async () => {
		const context = setup()
		const { client, session } = context
		const reservation = reserve(session)
		expect(session.beginRun().ok).toBeTrue()

		const accepted: boolean[] = []
		client.addHandler({
			event: (_, event) => {
				if (event.Event === 'SettleBegin' || event.Event === 'StartCalibration' || event.Event === 'StartGuiding') accepted.push(client.guidePulse(100, 'North'))
			},
		})

		const pending = session.start(rig.coordinator, reservation, { recalibrate: true, settle: SETTLE, clock: context.clock })
		await waitUntil(() => accepted.length >= 2, 2000, 1)
		settleDone(client)
		expect(await pending).toEqual(successfulOperationResult(undefined))
		expect(accepted.every(Boolean)).toBeTrue()
		await waitUntil(() => !rig.devices().guideOutput.pulsing, 3000, 10)

		// A guider that refuses to guide leaves the gate closed at once.
		const refused = spyOn(client, 'guide').mockReturnValue(false)
		const settleEvents: string[] = []
		client.addHandler({ event: (_, event) => void settleEvents.push(event.Event) })
		expect(await session.start(rig.coordinator, reservation, { recalibrate: false, settle: SETTLE, clock: context.clock })).toMatchObject({ ok: false, reason: 'unexpectedState' })
		expect(client.guidePulse(100, 'North')).toBeFalse()
		expect(settleEvents).toEqual([])
		refused.mockRestore()
	})
})

describe('49.11 start, settle and stop', () => {
	test('1 and 49.10 5: start resolves only after a later SettleDone; its status decides; a lost settle times out', async () => {
		const context = setup()
		const { client, session, clock } = context
		const reservation = reserve(session)
		expect(session.beginRun().ok).toBeTrue()

		// A SettleDone before the start is not correlated.
		client.addHandler({ event: () => {} })
		settleDone(client)
		expect(await startGuiding(context, reservation, rig.coordinator, 1)).toMatchObject({ ok: false, reason: 'commandFailed' })
		expect(await startGuiding(context, reservation)).toEqual(successfulOperationResult(undefined))

		const pending = session.start(rig.coordinator, reservation, { recalibrate: false, settle: SETTLE, clock })
		await waitUntil(() => clock.pending > 0, 2000, 1)
		await clock.advance(SETTLE.timeout * 1000 + 5000)
		expect(await pending).toMatchObject({ ok: false, reason: 'timeout' })
	})

	test('17 and 18: the root guiding holds the guide camera and the lifecycle resource of the guide output, never the mount', async () => {
		const context = setup()
		const { session } = context
		const { mount, guideOutput } = rig.devices()
		const lifecycle = guideOutputLifecycleKey(guideOutput)
		const { reserve: reserved, hold } = session.resources()

		expect(hold).toEqual([
			{ key: resourceKey(GUIDE_CAMERA), device: GUIDE_CAMERA },
			{ key: lifecycle, device: guideOutput },
		])
		expect(reserved.map((request) => request.key)).toEqual([resourceKey(GUIDE_CAMERA), resourceKey(guideOutput), lifecycle])

		const reservation = reserve(session)
		expect(session.beginRun().ok).toBeTrue()
		expect(await startGuiding(context, reservation)).toEqual(successfulOperationResult(undefined))

		const root = session.operationId()!
		expect(rig.arbiter.ownersOfDevice(resourceKey(guideOutput)).map((owner) => owner.id)).toContain(root)
		expect(rig.arbiter.ownersOf(resourceKey(mount))).toEqual([])
		expect(rig.arbiter.ownersOf(resourceKey(GUIDE_CAMERA)).map((owner) => owner.id)).toEqual([root])

		// After a pause, a slew of the session acquires the mount without conflict.
		expect((await session.pause(reservation)).ok).toBeTrue()
		const slewed = await rig.commanders.mount.goTo(reservation, mount, { type: 'JNOW', JNOW: { x: mount.equatorialCoordinate.rightAscension, y: mount.equatorialCoordinate.declination + deg(0.2) } })
		expect(slewed.ok).toBeTrue()

		// 12: stop ends the root and stops observing the client.
		const removed = spyOn(context.client, 'removeHandler')
		expect(await session.stop(rig.coordinator)).toEqual(successfulOperationResult(undefined))
		expect(session.operationId()).toBeUndefined()
		expect(removed).toHaveBeenCalledTimes(1)
		removed.mockRestore()
	}, 20000)

	test('19, 20 and 24: losing the guide output cancels the root guiding; a new start waits for the device; a cancelled start keeps the root', async () => {
		const context = setup()
		const { client, session, clock } = context
		const { mount } = rig.devices()
		const reservation = reserve(session)
		expect(session.beginRun().ok).toBeTrue()

		// 24: cancelling the task that started guiding cancels only the wait of the settle.
		const task = rig.coordinator.start('task', [], (scope) => session.start(scope, reservation, { recalibrate: false, settle: SETTLE, clock }))
		await waitUntil(() => client.getAppState() !== 'Stopped', 2000, 1)
		await task.cancel('aborted')
		expect(await task.result).toMatchObject({ ok: false, reason: 'aborted' })
		const root = session.operationId()!
		expect(root).toBeDefined()
		expect(rig.coordinator.get(root)).toBeDefined()

		// 19: the mount publishing the guide output disconnects.
		rig.managers.mount.disconnect(mount)
		await waitUntil(() => session.operationId() === undefined, 5000, 10)
		expect(session.state()).toBe('lost')
		expect(session.interruptions(0, Number.MAX_SAFE_INTEGER).interruptions.map((each) => each.kind)).toEqual(['disconnected'])
		expect(client.guidePulse(100, 'North')).toBeFalse()

		// 20: while the device is unavailable a new start is refused.
		expect(await session.start(rig.coordinator, reservation, { recalibrate: false, settle: SETTLE, clock })).toMatchObject({ ok: false, reason: 'busy' })

		rig.managers.mount.connect(mount)
		await waitUntil(() => mount.connected && rig.arbiter.availability(resourceKey(mount)) !== 'unavailable', 5000, 10)
		await waitUntil(() => mount.canPulseGuide && mount.hasEquatorialCoordinate, 5000, 10)
		expect(await startGuiding(context, reservation)).toEqual(successfulOperationResult(undefined))
		expect(session.operationId()).not.toBe(root)
		expect(session.state()).not.toBe('lost')
	}, 30000)

	test('86 to 88: interruptions are stamped at their reception with the clock of the start', async () => {
		const context = setup()
		const { client, session, clock } = context
		const reservation = reserve(session)
		expect(session.beginRun().ok).toBeTrue()
		expect(await startGuiding(context, reservation)).toEqual(successfulOperationResult(undefined))

		await clock.advance(1000)
		const dispatched = clock.monotonicNow()
		clock.jumpWall(-10_000)
		await clock.advance(500)
		client.emitEvent('StarLost', { Frame: 1, Time: 1, StarMass: 0, SNR: 0, AvgDist: 0, ErrorCode: 1, Status: 'star lost' })
		await clock.advance(500)
		const finished = clock.monotonicNow()

		const { interruptions, truncated } = session.interruptions(dispatched, finished)
		expect(truncated).toBeFalse()
		expect(interruptions).toEqual([{ kind: 'starLost', receivedMonotonic: dispatched + 500, receivedAt: clock.wallNow() - 500, detail: 'star lost' }])
		expect(session.interruptions(finished + 1, finished + 1000).interruptions).toEqual([])

		// An own pause is not an interruption; a pause from someone else is.
		expect((await session.pause(rig.coordinator)).ok).toBeTrue()
		client.setPaused(false)
		client.setPaused(true)
		expect(session.interruptions(finished, Number.MAX_SAFE_INTEGER).interruptions.map((each) => each.kind)).toEqual(['paused'])
	})
})

describe('49.11 pause and resume', () => {
	test('73: a stopped session only closes the gate and waits; a guiding one pauses fully', async () => {
		const context = setup()
		const { client, session } = context
		const reservation = reserve(session)
		client.connect(GUIDE_CAMERA, rig.devices().guideOutput)
		client.loop()
		expect(session.beginRun().ok).toBeTrue()

		const paused = spyOn(client, 'setPaused')
		expect((await session.pause(rig.coordinator)).ok).toBeTrue()
		expect(paused).not.toHaveBeenCalled()
		expect(client.getAppState()).toBe('Looping')

		expect(await startGuiding(context, reservation)).toEqual(successfulOperationResult(undefined))
		expect((await session.pause(rig.coordinator)).ok).toBeTrue()
		expect(paused.mock.calls).toEqual([[true, true]])
		expect(session.state()).toBe('paused')
		paused.mockRestore()
	})

	test('74: concurrent pauses resolve each by itself; a cancelled one ends at once with the gate closed', async () => {
		const context = setup()
		const { client, session } = context
		const reservation = reserve(session)
		expect(session.beginRun().ok).toBeTrue()
		expect(await startGuiding(context, reservation)).toEqual(successfulOperationResult(undefined))

		expect(client.guidePulse(600, 'North')).toBeTrue()
		const first = rig.coordinator.start('first', [], (scope) => session.pause(scope))
		const second = session.pause(rig.coordinator)
		await first.cancel('aborted')

		expect(await first.result).toMatchObject({ ok: false, reason: 'aborted' })
		expect(client.guidePulse(100, 'North')).toBeFalse()
		expect((await second).ok).toBeTrue()
		expect(rig.devices().guideOutput.pulsing).toBeFalse()
	})

	test('26 to 29: a pause during an active pulse resolves only after its observed end, and no pulse follows', async () => {
		const context = setup()
		const { client, session } = context
		const { mount, guideOutput } = rig.devices()
		const reservation = reserve(session)
		expect(session.beginRun().ok).toBeTrue()
		expect(await startGuiding(context, reservation)).toEqual(successfulOperationResult(undefined))

		using recorder = recordDevices(rig)
		expect(client.pulseQuiescenceWindow()).toBeUndefined()
		const dispatched = performance.now()
		expect(client.guidePulse(800, 'North')).toBeTrue()

		// 29: the window of the pulse is the one of the commander model.
		const window = client.pulseQuiescenceWindow()!
		expect(window.busyAckDeadline - dispatched).toBeGreaterThanOrEqual(800 + GUIDE_PULSE_ACK_MARGIN - 1)
		expect(window.busyAckDeadline - dispatched).toBeLessThan(800 + GUIDE_PULSE_ACK_MARGIN + 50)

		expect((await session.pause(reservation)).ok).toBeTrue()
		const resolved = performance.now()
		expect(resolved).toBeGreaterThanOrEqual(window.busyAckDeadline)
		expect(guideOutput.pulsing).toBeFalse()

		// 28: nothing pulses once paused.
		expect(client.guidePulse(100, 'North')).toBeFalse()

		const slewed = await rig.commanders.mount.goTo(reservation, mount, { type: 'JNOW', JNOW: { x: mount.equatorialCoordinate.rightAscension, y: mount.equatorialCoordinate.declination + deg(0.2) } })
		expect(slewed.ok).toBeTrue()

		// I14: the slew never overlapped the pulse.
		assertSequencerInvariants(recorder.entries)
	}, 20000)

	test('79 to 81: resume reopens the gate before guiding again; a refusal closes it and pauses; a failed settle keeps it open', async () => {
		const context = setup()
		const { client, session } = context
		const reservation = reserve(session)
		let admission: GuidePulseAdmission | undefined
		const admit = spyOn(client, 'admitPulses').mockImplementation((maximum) => (admission = GuiderClient.prototype.admitPulses.call(client, maximum)))
		expect(session.beginRun().ok).toBeTrue()
		admit.mockRestore()
		expect(await startGuiding(context, reservation)).toEqual(successfulOperationResult(undefined))
		expect((await session.pause(rig.coordinator)).ok).toBeTrue()

		const order: string[] = []
		const paused = spyOn(client, 'setPaused')
		const guide = spyOn(client, 'guide')
		paused.mockImplementation((value: boolean, full?: boolean) => {
			order.push(`setPaused(${value}) open=${admission?.isOpen}`)
			return GuiderClient.prototype.setPaused.call(client, value, full)
		})
		guide.mockImplementation((recalibrate, settle) => {
			order.push('guide')
			return GuiderClient.prototype.guide.call(client, recalibrate, settle)
		})

		const resumed = session.resume(rig.coordinator, SETTLE)
		await waitUntil(() => order.includes('guide'), 2000, 1)
		settleDone(client)
		expect(await resumed).toEqual(successfulOperationResult(undefined))
		expect(order).toEqual(['setPaused(false) open=true', 'guide'])
		expect(client.guidePulse(100, 'North')).toBeTrue()
		await waitUntil(() => !rig.devices().guideOutput.pulsing, 3000, 10)

		// A settle that failed leaves the gate open: the client guides.
		expect((await session.pause(rig.coordinator)).ok).toBeTrue()
		const failed = session.resume(rig.coordinator, SETTLE)
		await waitUntil(() => order.filter((each) => each === 'guide').length === 2, 2000, 1)
		settleDone(client, 1)
		expect(await failed).toMatchObject({ ok: false, reason: 'commandFailed' })
		expect(client.guidePulse(100, 'North')).toBeTrue()
		await waitUntil(() => !rig.devices().guideOutput.pulsing, 3000, 10)

		// A refused guide closes the gate and leaves the client paused, in the same tick.
		expect((await session.pause(rig.coordinator)).ok).toBeTrue()
		guide.mockReturnValue(false)
		expect(await session.resume(rig.coordinator, SETTLE)).toMatchObject({ ok: false, reason: 'unexpectedState' })
		expect(client.getPaused()).toBeTrue()
		paused.mockRestore()
		guide.mockRestore()
		expect(client.guidePulse(100, 'North')).toBeFalse()
	}, 20000)
})

describe('49.10 dither through the local guider', () => {
	function request(amount: DitherRequest['amount']): DitherRequest {
		return { amount, raOnly: false, settle: { kind: 'guided', pixels: 1, time: 1, timeout: 10 } }
	}

	test('5 to 7: the first SettleDone after the dispatch decides; refusals, concurrency, cancellation and units', async () => {
		const context = setup()
		const { client, session, clock } = context
		const reservation = reserve(session)
		expect(session.beginRun().ok).toBeTrue()
		expect(await startGuiding(context, reservation)).toEqual(successfulOperationResult(undefined))

		const scale = spyOn(client, 'getPixelScale').mockReturnValue(2)
		const settling = spyOn(client, 'getSettling').mockReturnValue(false)
		const amounts: number[] = []
		const dither = spyOn(client, 'dither').mockImplementation((amount) => {
			amounts.push(amount)
			client.emitEvent('GuidingDithered', { dx: amount, dy: -amount })
			client.emitEvent('SettleBegin')
			return true
		})

		try {
			// 7: angles are converted with the guide pixel scale; the phases come in order.
			const phases: DitherPhase[] = []
			const pending = session.dither(rig.coordinator, request({ unit: 'angle', value: arcsec(4) }), (phase) => phases.push(phase))
			await waitUntil(() => amounts.length === 1, 2000, 1)

			// 6: a concurrent dither is refused.
			expect(await session.dither(rig.coordinator, request({ unit: 'guidePixel', value: 1 }))).toMatchObject({ ok: false, reason: 'busy' })

			settleDone(client)
			expect(await pending).toEqual(successfulOperationResult({ kind: 'guider', lockShift: [2, -2] }))
			expect(amounts[0]).toBeCloseTo(2, 12)
			expect(phases).toEqual(['dithering', 'dithered', 'settling', 'settled'])

			// 5: a failed settle and a refused dither.
			const failed = session.dither(rig.coordinator, request({ unit: 'guidePixel', value: 1 }))
			await waitUntil(() => amounts.length === 2, 2000, 1)
			settleDone(client, 1)
			expect(await failed).toMatchObject({ ok: false, reason: 'commandFailed' })

			dither.mockReturnValueOnce(false)
			expect(await session.dither(rig.coordinator, request({ unit: 'guidePixel', value: 1 }))).toMatchObject({ ok: false, reason: 'unexpectedState' })

			// 6: a settle already running is waited for before the next dither; a lost event times out.
			settling.mockReturnValue(true)
			const waiting = session.dither(rig.coordinator, request({ unit: 'guidePixel', value: 1 }))
			await Bun.sleep(10)
			expect(amounts).toHaveLength(2)
			settling.mockReturnValue(false)
			settleDone(client)
			await waitUntil(() => amounts.length === 3, 2000, 1)
			await waitUntil(() => clock.pending > 0, 2000, 1)
			await clock.advance(10_000 + 5000)
			expect(await waiting).toMatchObject({ ok: false, reason: 'timeout' })

			// 6: a cancelled dither ends 'aborted'.
			const handle = rig.coordinator.start('task', [], (scope) => session.dither(scope, request({ unit: 'guidePixel', value: 1 })))
			await waitUntil(() => amounts.length === 4, 2000, 1)
			await handle.cancel('aborted')
			expect(await handle.result).toMatchObject({ ok: false, reason: 'aborted' })

			// 7: an unknown scale refuses angles.
			scale.mockReturnValue(0)
			expect(session.accepts(request({ unit: 'angle', value: arcsec(4) }))).toBeFalse()
			expect(session.accepts(request({ unit: 'guidePixel', value: 1 }))).toBeTrue()
			expect(session.accepts({ ...request({ unit: 'guidePixel', value: 1 }), settle: { kind: 'mechanical', time: 0 } })).toBeFalse()
		} finally {
			scale.mockRestore()
			settling.mockRestore()
			dither.mockRestore()
		}
	})
})
