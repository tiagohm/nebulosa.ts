import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { GUIDE_PULSE_STOP_SETTLE_TIMEOUT } from '../../../src/devices/commanders/guideoutput'
import { DEFAULT_GUIDE_OUTPUT, type GuideOutput } from '../../../src/devices/indi/device'
import type { DeviceHandler, DeviceManager } from '../../../src/devices/indi/manager/device'
import { OperationCoordinator, successfulOperationResult } from '../../../src/devices/orchestration/operation'
import { ResourceArbiter } from '../../../src/devices/orchestration/resource'
import { arcsec } from '../../../src/math/units/angle'
import type { DitherPhase, DitherRequest } from '../../../src/observation/guiding/ditherer'
import type { GuidingEvent } from '../../../src/observation/guiding/events'
import { PHD2Client } from '../../../src/observation/guiding/phd2/client'
import type { PHD2Settle } from '../../../src/observation/guiding/phd2/types'
import type { GuidingSettle } from '../../../src/observation/guiding/session'
import { DEFAULT_PHD2_PAUSED_EVENT_ALLOWANCE, PHD2GuidingSession, type PHD2GuidingSessionOptions, phd2ResourceKey } from '../../../src/observation/guiding/session.phd2'
import { waitUntil } from '../../util'
import { createPHD2Rig, PHD2_RIG_PIXEL_SCALE, type PHD2Rig } from '../../util/phd2'
import { ManualClock } from '../../util/rig'

// PHD2GuidingSession against a PHD2Server over a real GuiderClient whose devices are fakes (see tests/util/phd2): the
// commands run on the guider, and the settles its frames would report are injected as SettleDone events of the guider.
// The guider still tracks the settle it started, which only its frames end, so it reports no running settle to
// `get_settling`, as a PHD2 whose settle the injected SettleDone ended would.

const SETTLE: GuidingSettle = { pixels: 1.5, time: 1, timeout: 10 }
const OWNER = { id: 'observation', kind: 'test' }

const coordinator = new OperationCoordinator(new ResourceArbiter())
const cleanups: VoidFunction[] = []

afterEach(() => {
	for (const cleanup of cleanups.splice(0).toReversed()) cleanup()
})

interface Setup {
	readonly rig: PHD2Rig
	readonly client: PHD2Client
	readonly session: PHD2GuidingSession
	readonly clock: ManualClock
}

function setup(options: Partial<PHD2GuidingSessionOptions> = {}): Setup {
	const rig = createPHD2Rig()
	const client = new PHD2Client()
	const clock = new ManualClock()
	const session = new PHD2GuidingSession(client, { host: '127.0.0.1', port: rig.server.port, maxGuidePulse: 2500, delay: clock.delay, ...options })
	const settling = spyOn(rig.guider, 'getSettling').mockReturnValue(false)
	cleanups.push(() => rig[Symbol.dispose]())
	cleanups.push(() => settling.mockRestore())
	cleanups.push(() => client.close())
	return { rig, client, session, clock }
}

// Reserves the session resources and returns the scope that opens roots under the reservation.
function reserve(session: PHD2GuidingSession) {
	const reserved = coordinator.arbiter.reserve(OWNER, session.resources().reserve)
	if (!reserved.ok) throw new Error('the reservation was refused')
	cleanups.push(() => reserved.reservation.release())
	return coordinator.reservedScope(reserved.reservation)
}

// Reports the end of the settle of the guider, as its frames would.
function settleDone(rig: PHD2Rig, status = 0) {
	rig.guider.emitEvent('settleDone', { succeeded: status === 0, totalFrames: 1, droppedFrames: 0 })
}

// Number of executed requests of `method`.
function count(rig: PHD2Rig, method: string) {
	return rig.methods().filter((each) => each === method).length
}

// Parameters of the last executed request of `method`.
function lastParams(rig: PHD2Rig, method: string) {
	return rig.requests.findLast((entry) => entry.request.method === method)?.request.params
}

// Starts guiding: the uncalibrated guider starts calibrating and settles once asked.
async function startGuiding({ rig, session, clock }: Setup) {
	const reservation = reserve(session)
	const pending = session.start(coordinator, reservation, { recalibrate: false, settle: SETTLE, clock })
	await waitUntil(() => rig.methods().includes('guide'), 2000, 1)
	settleDone(rig)
	return { reservation, started: await pending }
}

describe('49.11 PHD2 guiding session', () => {
	test('25 and 47: one logical resource, reserved and held, and the pulse premise as bound', () => {
		const { session, rig } = setup()
		const key = phd2ResourceKey('127.0.0.1', rig.server.port)
		expect(session.resources()).toEqual({ reserve: [{ key }], hold: [{ key }] })
		expect(session.pulseQuiescenceBound()).toBe(2500 + DEFAULT_PHD2_PAUSED_EVENT_ALLOWANCE)

		const observed = new PHD2GuidingSession(new PHD2Client(), { host: '127.0.0.1', maxGuidePulse: 1000, pausedEventAllowance: 500, guideOutput: { device: { ...DEFAULT_GUIDE_OUTPUT }, manager: fakeManager().manager } })
		expect(observed.pulseQuiescenceBound()).toBe(1000 + 500 + GUIDE_PULSE_STOP_SETTLE_TIMEOUT)
	})

	test('1: start connects, reconciles the state, guides and resolves on the SettleDone even before the RPC reply', async () => {
		const context = setup()
		const { rig, session, clock } = context
		const reservation = reserve(session)

		// The guider reports the settle while it executes the command, before the server replies.
		const settleOnStart = {
			event: (_: unknown, event: GuidingEvent) => {
				if (event.type === 'calibrationStarted') settleDone(rig)
			},
		}
		rig.guider.addHandler(settleOnStart)

		expect(await session.start(coordinator, reservation, { recalibrate: true, settle: SETTLE, clock })).toEqual(successfulOperationResult(undefined))
		rig.guider.removeHandler(settleOnStart)
		expect(rig.methods().slice(0, 3)).toEqual(['get_app_state', 'get_pixel_scale', 'guide'])
		expect(lastParams(rig, 'guide')).toMatchObject({ recalibrate: true, settle: SETTLE })
		expect(rig.guider.getAppState()).toBe('Calibrating')
		expect(session.state()).toBe('calibrating')
		expect(session.operationId()).toBeDefined()

		// A guider that refuses to guide fails the start.
		const refused = spyOn(rig.guider, 'guide').mockReturnValue(false)
		expect(await session.start(coordinator, reservation, { recalibrate: false, settle: SETTLE, clock })).toMatchObject({ ok: false, reason: 'commandFailed' })
		refused.mockRestore()

		expect(await session.stop(coordinator)).toEqual(successfulOperationResult(undefined))
		expect(rig.guider.getAppState()).toBe('Stopped')
		expect(session.operationId()).toBeUndefined()
	})

	test('30: pause waits for the Paused event, then for the pulse premise since it', async () => {
		const context = setup()
		const { rig, session, clock } = context
		expect((await startGuiding(context)).started.ok).toBeTrue()

		let resolved = false
		const pending = session.pause(coordinator).then((result) => ((resolved = true), result))
		await waitUntil(() => session.state() === 'paused' && clock.pending > 0, 2000, 1)
		expect(lastParams(rig, 'set_paused')).toEqual([true, 'full'])
		expect(rig.guider.getPaused()).toBeTrue()
		expect(resolved).toBeFalse()

		// The premise is counted on the real clock from the Paused event; the manual delay holds the rest of it.
		await clock.advance(2500)
		expect(await pending).toEqual(successfulOperationResult(undefined))

		// A paused session is not paused again, only waited for; resume asks the guider to settle again.
		const again = session.pause(coordinator)
		await waitUntil(() => clock.pending > 0, 2000, 1)
		await clock.advance(2500)
		expect((await again).ok).toBeTrue()
		expect(count(rig, 'set_paused')).toBe(1)

		const resumed = session.resume(coordinator, SETTLE)
		await waitUntil(() => count(rig, 'guide') === 2, 2000, 1)
		settleDone(rig)
		expect(await resumed).toEqual(successfulOperationResult(undefined))
		expect(lastParams(rig, 'set_paused')).toEqual([false])
		expect(rig.guider.getPaused()).toBeFalse()
	})

	test('a pause whose Paused event never comes times out at the allowance', async () => {
		const context = setup({ pausedEventAllowance: 300 })
		const { rig, session, clock } = context
		expect((await startGuiding(context)).started.ok).toBeTrue()

		// The guider accepts the pause but never reports it.
		const silent = spyOn(rig.guider, 'setPaused').mockReturnValue(true)
		cleanups.push(() => silent.mockRestore())

		const pending = session.pause(coordinator)
		await waitUntil(() => rig.methods().includes('set_paused') && clock.pending > 0, 2000, 1)
		await clock.advance(300)
		expect(await pending).toMatchObject({ ok: false, reason: 'timeout' })
	})

	test('83: with an observed guide output the pause waits for it to stop pulsing', async () => {
		const { manager, device, notify } = fakeManager()
		const context = setup({ guideOutput: { device, manager } })
		const { session } = context
		expect((await startGuiding(context)).started.ok).toBeTrue()

		device.pulsing = true
		let resolved = false
		const pending = session.pause(coordinator).then((result) => ((resolved = true), result))
		await waitUntil(() => session.state() === 'paused', 2000, 1)
		await Bun.sleep(30)
		expect(resolved).toBeFalse()

		device.pulsing = false
		notify('pulsing')
		expect(await pending).toEqual(successfulOperationResult(undefined))
	})

	test('25: a closed socket loses the guiding, records the interruption and ends the root', async () => {
		const context = setup()
		const { rig, session, clock } = context
		expect((await startGuiding(context)).started.ok).toBeTrue()

		await clock.advance(1000)
		rig.server.stop()
		await waitUntil(() => session.operationId() === undefined, 3000, 5)

		expect(session.state()).toBe('lost')
		expect(session.interruptions(0, 2000)).toEqual({ interruptions: [{ kind: 'disconnected', receivedMonotonic: 1000, receivedAt: clock.wallNow(), detail: 'the PHD2 connection closed' }], truncated: false })
	})
})

describe('49.10 dither through PHD2', () => {
	function request(amount: DitherRequest['amount']): DitherRequest {
		return { amount, raOnly: true, settle: { kind: 'guided', pixels: 1, time: 1, timeout: 10 } }
	}

	test('5 to 7: RPC errors, statuses, early events, concurrency, cancellation, lost events, closed socket and units', async () => {
		const context = setup()
		const { rig, session, clock } = context
		expect((await startGuiding(context)).started.ok).toBeTrue()

		// The guider has no calibration to dither with, so a guiding one is stood in for: it accepts the dither, reports
		// the offset and begins the settle, as GuiderClient.dither does.
		const dither = spyOn(rig.guider, 'dither').mockImplementation((_amount: number, _raOnly?: boolean, _settle?: Partial<PHD2Settle>) => {
			rig.guider.emitEvent('dithered', { dx: 1, dy: 2 })
			rig.guider.emitEvent('settleStarted')
			return true
		})
		cleanups.push(() => dither.mockRestore())

		// 7: an angle is converted with the pixel scale the guider reported; the phases come in order.
		const phases: DitherPhase[] = []
		const pending = session.dither(coordinator, request({ unit: 'angle', value: arcsec(3) }), (phase) => phases.push(phase))
		await waitUntil(() => count(rig, 'dither') === 1, 2000, 1)

		// 6: a concurrent dither is refused.
		expect(await session.dither(coordinator, request({ unit: 'guidePixel', value: 1 }))).toMatchObject({ ok: false, reason: 'busy' })
		settleDone(rig)

		expect(await pending).toEqual(successfulOperationResult({ kind: 'guider', lockShift: [1, 2] }))
		const [amount, raOnly, settle] = dither.mock.calls[0]
		expect(amount).toBeCloseTo(3 / PHD2_RIG_PIXEL_SCALE, 12)
		expect(raOnly).toBeTrue()
		expect(settle).toEqual({ pixels: 1, time: 1, timeout: 10 })
		expect(phases).toEqual(['dithering', 'dithered', 'settling', 'settled'])

		// 5: a SettleDone before the dispatch does not count; a failed status and a refused dither fail.
		settleDone(rig)
		const failed = session.dither(coordinator, request({ unit: 'guidePixel', value: 1 }))
		await waitUntil(() => count(rig, 'dither') === 2, 2000, 1)
		settleDone(rig, 1)
		expect(await failed).toMatchObject({ ok: false, reason: 'commandFailed' })

		dither.mockReturnValue(false)
		expect(await session.dither(coordinator, request({ unit: 'guidePixel', value: 1 }))).toMatchObject({ ok: false, reason: 'commandFailed' })
		dither.mockReturnValue(true)

		// 6: a cancelled dither leaves its settle pending, which the next dither waits for before dispatching.
		const handle = coordinator.start('task', [], (scope) => session.dither(scope, request({ unit: 'guidePixel', value: 1 })))
		await waitUntil(() => count(rig, 'dither') === 4, 2000, 1)
		await handle.cancel('aborted')
		expect(await handle.result).toMatchObject({ ok: false, reason: 'aborted' })

		const next = session.dither(coordinator, request({ unit: 'guidePixel', value: 1 }))
		await Bun.sleep(30)
		expect(count(rig, 'dither')).toBe(4)
		settleDone(rig)
		await waitUntil(() => count(rig, 'dither') === 5, 2000, 1)

		// 6: a lost SettleDone times out locally.
		await waitUntil(() => clock.pending > 0, 2000, 1)
		await clock.advance(10_000 + 5000)
		expect(await next).toMatchObject({ ok: false, reason: 'timeout' })

		// 6: a closed socket fails the wait as disconnected.
		const closing = session.dither(coordinator, request({ unit: 'guidePixel', value: 1 }))
		await waitUntil(() => count(rig, 'dither') === 6, 2000, 1)
		rig.server.stop()
		expect(await closing).toMatchObject({ ok: false, reason: 'disconnected' })
	})

	test('7: an unknown pixel scale refuses angles', () => {
		const known = new PHD2GuidingSession(new PHD2Client(), { host: '127.0.0.1', maxGuidePulse: 1000, pixelScale: 1.2 })
		const unknown = new PHD2GuidingSession(new PHD2Client(), { host: '127.0.0.1', maxGuidePulse: 1000 })
		expect(known.accepts(request({ unit: 'angle', value: arcsec(1) }))).toBeTrue()
		expect(unknown.accepts(request({ unit: 'angle', value: arcsec(1) }))).toBeFalse()
		expect(unknown.accepts(request({ unit: 'guidePixel', value: 1 }))).toBeTrue()
		expect(unknown.accepts({ ...request({ unit: 'guidePixel', value: 1 }), settle: { kind: 'mechanical', time: 0 } })).toBeFalse()
	})
})

// Guide output observed through a minimal manager.
function fakeManager() {
	const handlers = new Set<DeviceHandler<GuideOutput>>()
	const device: GuideOutput = { ...DEFAULT_GUIDE_OUTPUT, connected: true, canPulseGuide: true }
	const manager = {
		addHandler: (handler: DeviceHandler<GuideOutput>) => void handlers.add(handler),
		removeHandler: (handler: DeviceHandler<GuideOutput>) => void handlers.delete(handler),
	} as unknown as DeviceManager<GuideOutput>
	const notify = (property: keyof GuideOutput & string) => {
		for (const handler of handlers) handler.updated?.(device, property)
	}
	return { manager, device, notify }
}
