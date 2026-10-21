import { afterEach, describe, expect, test } from 'bun:test'
import type { Socket, TCPSocketListener } from 'bun'
import { GUIDE_PULSE_STOP_SETTLE_TIMEOUT } from '../../../src/devices/commanders/guideoutput'
import { PHD2Client } from '../../../src/devices/guiding/phd2'
import { DEFAULT_GUIDE_OUTPUT, type GuideOutput } from '../../../src/devices/indi/device'
import type { DeviceHandler, DeviceManager } from '../../../src/devices/indi/manager/device'
import { OperationCoordinator, successfulOperationResult } from '../../../src/devices/orchestration/operation'
import { ResourceArbiter } from '../../../src/devices/orchestration/resource'
import { arcsec } from '../../../src/math/units/angle'
import type { DitherPhase, DitherRequest } from '../../../src/observation/guiding/ditherer'
import type { GuidingSettle } from '../../../src/observation/guiding/session'
import { DEFAULT_PHD2_PAUSED_EVENT_ALLOWANCE, PHD2GuidingSession, type PHD2GuidingSessionOptions, phd2ResourceKey } from '../../../src/observation/guiding/session.phd2'
import { waitUntil } from '../../util'
import { ManualClock } from '../../util/rig'

// PHD2GuidingSession against a scripted JSON-RPC server on a free local port: each request is answered by the script
// of its method (or left unanswered), and the test pushes PHD2 events whenever it wants.

const SETTLE: GuidingSettle = { pixels: 1.5, time: 1, timeout: 10 }
const OWNER = { id: 'observation', kind: 'test' }

// One JSON-RPC request the server received.
interface Request {
	readonly id: string
	readonly method: string
	readonly params?: unknown
}

// Answer of a scripted method: a result, an RPC error, or nothing (the test answers later or never).
type Answer = { readonly result: unknown } | { readonly error: { readonly code: number; readonly message: string } } | undefined

class FakePHD2 implements Disposable {
	readonly requests: Request[] = []
	readonly script = new Map<string, (request: Request) => Answer>([
		['get_app_state', () => ({ result: 'Looping' })],
		['get_pixel_scale', () => ({ result: 1.5 })],
		['get_settling', () => ({ result: false })],
		['guide', () => ({ result: 0 })],
		['set_paused', () => ({ result: 0 })],
		['stop_capture', () => ({ result: 0 })],
		['dither', () => ({ result: 0 })],
		['flip_calibration', () => ({ result: 0 })],
	])
	socket?: Socket<unknown>
	readonly #server: TCPSocketListener

	constructor() {
		this.#server = Bun.listen({
			hostname: '127.0.0.1',
			port: 0,
			socket: {
				open: (socket) => {
					this.socket = socket
				},
				data: (socket, data) => {
					for (const line of data.toString().split('\r\n')) {
						if (line.trim() === '') continue
						const request = JSON.parse(line) as Request
						this.requests.push(request)
						const answer = this.script.get(request.method)?.(request)
						if (answer !== undefined) this.reply(request.id, answer)
					}
				},
				close: () => {
					this.socket = undefined
				},
			},
		})
	}

	get port() {
		return this.#server.port
	}

	reply(id: string, answer: NonNullable<Answer>) {
		this.socket?.write(`${JSON.stringify({ jsonrpc: '2.0', id, ...answer })}\r\n`)
	}

	event(event: Record<string, unknown>) {
		this.socket?.write(`${JSON.stringify({ Timestamp: 0, Host: 'fake', Inst: 1, ...event })}\r\n`)
	}

	methods() {
		return this.requests.map((request) => request.method)
	}

	[Symbol.dispose]() {
		this.socket?.end()
		this.#server.stop(true)
	}
}

const coordinator = new OperationCoordinator(new ResourceArbiter())
const cleanups: VoidFunction[] = []

afterEach(() => {
	for (const cleanup of cleanups.splice(0).toReversed()) cleanup()
})

interface Setup {
	readonly server: FakePHD2
	readonly client: PHD2Client
	readonly session: PHD2GuidingSession
	readonly clock: ManualClock
}

function setup(options: Partial<PHD2GuidingSessionOptions> = {}): Setup {
	const server = new FakePHD2()
	const client = new PHD2Client()
	const clock = new ManualClock()
	const session = new PHD2GuidingSession(client, { host: '127.0.0.1', port: server.port, maxGuidePulse: 2500, delay: clock.delay, ...options })
	cleanups.push(() => server[Symbol.dispose]())
	cleanups.push(() => client.close())
	return { server, client, session, clock }
}

// Reserves the session resources and returns the scope that opens roots under the reservation.
function reserve(session: PHD2GuidingSession) {
	const reserved = coordinator.arbiter.reserve(OWNER, session.resources().reserve)
	if (!reserved.ok) throw new Error('the reservation was refused')
	cleanups.push(() => reserved.reservation.release())
	return coordinator.reservedScope(reserved.reservation)
}

function settleDone(server: FakePHD2, status = 0) {
	server.event({ Event: 'SettleDone', Status: status, TotalFrames: 1, DroppedFrames: 0 })
}

// Starts guiding: PHD2 begins guiding and settles once asked.
async function startGuiding({ server, session, clock }: Setup) {
	const reservation = reserve(session)
	server.script.set('guide', () => {
		server.event({ Event: 'StartGuiding' })
		server.event({ Event: 'SettleBegin' })
		return { result: 0 }
	})
	const pending = session.start(coordinator, reservation, { recalibrate: false, settle: SETTLE, clock })
	await waitUntil(() => server.methods().includes('guide'), 2000, 1)
	settleDone(server)
	return { reservation, started: await pending }
}

describe('49.11 PHD2 guiding session', () => {
	test('25 and 47: one logical resource, reserved and held, and the pulse premise as bound', () => {
		const { session, server } = setup()
		const key = phd2ResourceKey('127.0.0.1', server.port)
		expect(session.resources()).toEqual({ reserve: [{ key }], hold: [{ key }] })
		expect(session.pulseQuiescenceBound()).toBe(2500 + DEFAULT_PHD2_PAUSED_EVENT_ALLOWANCE)

		const observed = new PHD2GuidingSession(new PHD2Client(), { host: '127.0.0.1', maxGuidePulse: 1000, pausedEventAllowance: 500, guideOutput: { device: { ...DEFAULT_GUIDE_OUTPUT }, manager: fakeManager().manager } })
		expect(observed.pulseQuiescenceBound()).toBe(1000 + 500 + GUIDE_PULSE_STOP_SETTLE_TIMEOUT)
	})

	test('1: start connects, reconciles the state, guides and resolves on the SettleDone even before the RPC reply', async () => {
		const context = setup()
		const { server, session, clock } = context
		const reservation = reserve(session)

		// PHD2 reports the settle before it acknowledges the command.
		server.script.set('guide', (request) => {
			server.event({ Event: 'StartGuiding' })
			settleDone(server)
			setTimeout(() => server.reply(request.id, { result: 0 }), 20)
			return undefined
		})

		expect(await session.start(coordinator, reservation, { recalibrate: true, settle: SETTLE, clock })).toEqual(successfulOperationResult(undefined))
		expect(server.methods().slice(0, 3)).toEqual(['get_app_state', 'get_pixel_scale', 'guide'])
		expect(server.requests.find((request) => request.method === 'guide')!.params).toMatchObject({ recalibrate: true, settle: SETTLE })
		expect(session.state()).toBe('guiding')
		expect(session.operationId()).toBeDefined()

		server.script.set('guide', () => ({ error: { code: 1, message: 'no star' } }))
		expect(await session.start(coordinator, reservation, { recalibrate: false, settle: SETTLE, clock })).toMatchObject({ ok: false, reason: 'commandFailed' })

		expect(await session.stop(coordinator)).toEqual(successfulOperationResult(undefined))
		expect(session.operationId()).toBeUndefined()
	})

	test('30: pause waits for the Paused event, then for the pulse premise since it', async () => {
		const context = setup()
		const { server, session, clock } = context
		expect((await startGuiding(context)).started.ok).toBeTrue()

		server.script.set('set_paused', () => {
			setTimeout(() => server.event({ Event: 'Paused' }), 20)
			return { result: 0 }
		})

		let resolved = false
		const pending = session.pause(coordinator).then((result) => ((resolved = true), result))
		await waitUntil(() => session.state() === 'paused' && clock.pending > 0, 2000, 1)
		expect(server.requests.find((request) => request.method === 'set_paused')!.params).toEqual([true, 'full'])
		expect(resolved).toBeFalse()

		// The premise is counted on the real clock from the Paused event; the manual delay holds the rest of it.
		await clock.advance(2500)
		expect(await pending).toEqual(successfulOperationResult(undefined))

		// A paused session is not paused again, only waited for; resume asks PHD2 to settle again.
		const again = session.pause(coordinator)
		await waitUntil(() => clock.pending > 0, 2000, 1)
		await clock.advance(2500)
		expect((await again).ok).toBeTrue()
		expect(server.methods().filter((method) => method === 'set_paused')).toHaveLength(1)

		const resumed = session.resume(coordinator, SETTLE)
		await waitUntil(() => server.methods().filter((method) => method === 'guide').length === 2, 2000, 1)
		settleDone(server)
		expect(await resumed).toEqual(successfulOperationResult(undefined))
		expect(server.requests.findLast((request) => request.method === 'set_paused')!.params).toEqual([false])
	})

	test('a pause whose Paused event never comes times out at the allowance', async () => {
		const context = setup({ pausedEventAllowance: 300 })
		const { server, session, clock } = context
		expect((await startGuiding(context)).started.ok).toBeTrue()

		const pending = session.pause(coordinator)
		await waitUntil(() => server.methods().includes('set_paused') && clock.pending > 0, 2000, 1)
		await clock.advance(300)
		expect(await pending).toMatchObject({ ok: false, reason: 'timeout' })
	})

	test('83: with an observed guide output the pause waits for it to stop pulsing', async () => {
		const { manager, device, notify } = fakeManager()
		const context = setup({ guideOutput: { device, manager } })
		const { server, session } = context
		expect((await startGuiding(context)).started.ok).toBeTrue()

		server.script.set('set_paused', () => {
			setTimeout(() => server.event({ Event: 'Paused' }), 5)
			return { result: 0 }
		})

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
		const { server, session, clock } = context
		expect((await startGuiding(context)).started.ok).toBeTrue()

		await clock.advance(1000)
		server.socket!.end()
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
		const { server, session, clock } = context
		expect((await startGuiding(context)).started.ok).toBeTrue()

		let dithered: Request | undefined
		server.script.set('dither', (request) => {
			dithered = request
			server.event({ Event: 'GuidingDithered', dx: 1, dy: 2 })
			server.event({ Event: 'SettleBegin' })
			return { result: 0 }
		})

		// 7: an angle is converted with the pixel scale PHD2 reported; the phases come in order.
		const phases: DitherPhase[] = []
		const pending = session.dither(coordinator, request({ unit: 'angle', value: arcsec(3) }), (phase) => phases.push(phase))
		await waitUntil(() => dithered !== undefined, 2000, 1)

		// 6: a concurrent dither is refused, and JSON that is not JSON is ignored.
		expect(await session.dither(coordinator, request({ unit: 'guidePixel', value: 1 }))).toMatchObject({ ok: false, reason: 'busy' })
		server.socket!.write('{"Event": nope\r\n')
		settleDone(server)

		expect(await pending).toEqual(successfulOperationResult({ kind: 'guider', lockShift: [1, 2] }))
		expect(dithered!.params).toMatchObject({ amount: 2, raOnly: true, settle: { pixels: 1, time: 1, timeout: 10 } })
		expect(phases).toEqual(['dithering', 'dithered', 'settling', 'settled'])

		// 5: a SettleDone before the dispatch does not count; a failed status and an RPC error fail.
		settleDone(server)
		const failed = session.dither(coordinator, request({ unit: 'guidePixel', value: 1 }))
		await waitUntil(() => server.methods().filter((method) => method === 'dither').length === 2, 2000, 1)
		settleDone(server, 1)
		expect(await failed).toMatchObject({ ok: false, reason: 'commandFailed' })

		server.script.set('dither', () => ({ error: { code: 2, message: 'not guiding' } }))
		expect(await session.dither(coordinator, request({ unit: 'guidePixel', value: 1 }))).toMatchObject({ ok: false, reason: 'commandFailed' })
		server.script.set('dither', () => ({ result: 0 }))

		// 6: a cancelled dither leaves its settle pending, which the next dither waits for before dispatching.
		const handle = coordinator.start('task', [], (scope) => session.dither(scope, request({ unit: 'guidePixel', value: 1 })))
		await waitUntil(() => server.methods().filter((method) => method === 'dither').length === 4, 2000, 1)
		await handle.cancel('aborted')
		expect(await handle.result).toMatchObject({ ok: false, reason: 'aborted' })

		const next = session.dither(coordinator, request({ unit: 'guidePixel', value: 1 }))
		await Bun.sleep(30)
		expect(server.methods().filter((method) => method === 'dither')).toHaveLength(4)
		settleDone(server)
		await waitUntil(() => server.methods().filter((method) => method === 'dither').length === 5, 2000, 1)

		// 6: a lost SettleDone times out locally.
		await waitUntil(() => clock.pending > 0, 2000, 1)
		await clock.advance(10_000 + 5000)
		expect(await next).toMatchObject({ ok: false, reason: 'timeout' })

		// 6: a closed socket fails the wait as disconnected.
		const closing = session.dither(coordinator, request({ unit: 'guidePixel', value: 1 }))
		await waitUntil(() => server.methods().filter((method) => method === 'dither').length === 6, 2000, 1)
		server.socket!.end()
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
