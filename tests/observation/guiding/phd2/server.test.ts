import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { plotStar } from '../../../../src/imaging/stars/generator'
import { PHD2Client } from '../../../../src/observation/guiding/phd2/client'
import { DEFAULT_PHD2_EXPOSURE_DURATIONS, DEFAULT_PHD2_SERVER_PROFILE } from '../../../../src/observation/guiding/phd2/server'
import { PHD2_VERSION, type PHD2Events } from '../../../../src/observation/guiding/phd2/types'
import { waitUntil } from '../../../util'
import { fixtureGuideBlob, fixtureGuideImage } from '../../../util/guiding'
import { createPHD2Rig, PHD2_RIG_PIXEL_SCALE, type PHD2Rig, type PHD2RigOptions } from '../../../util/phd2'

// PHD2Server against the real PHD2Client and a raw socket, over a real GuiderClient with fake device managers.

const cleanups: VoidFunction[] = []

afterEach(() => {
	for (const cleanup of cleanups.splice(0).toReversed()) cleanup()
})

function rig(options?: PHD2RigOptions) {
	const created = createPHD2Rig(options)
	cleanups.push(() => created[Symbol.dispose]())
	return created
}

// What a PHD2Client received, events and replies in arrival order.
type Received = { readonly kind: 'event'; readonly event: PHD2Events } | { readonly kind: 'reply'; readonly method: string; readonly success: boolean }

async function connect({ server }: PHD2Rig) {
	const client = new PHD2Client()
	const received: Received[] = []
	const closed = Promise.withResolvers<void>()
	client.addHandler({
		event: (_, event) => void received.push({ kind: 'event', event }),
		command: (_, command, success) => void received.push({ kind: 'reply', method: command.method, success }),
		close: () => closed.resolve(),
	})
	cleanups.push(() => client.close())
	await client.connect('127.0.0.1', server.port)
	const events = () => received.flatMap((entry) => (entry.kind === 'event' ? [entry.event] : []))
	await waitUntil(() => events().some((event) => event.Event === 'AppState'), 2000, 1)
	return { client, received, events, closed: closed.promise }
}

// A raw TCP connection to the server that collects the parsed replies it receives (events are dropped).
async function raw({ server }: PHD2Rig) {
	const lines: unknown[] = []
	const closed = Promise.withResolvers<void>()
	let tail = ''
	let events = 0
	const socket = await Bun.connect({
		hostname: '127.0.0.1',
		port: server.port,
		socket: {
			data: (_, data) => {
				const text = tail + data.toString()
				const parts = text.split('\r\n')
				tail = parts.pop()!
				for (const part of parts) {
					const message = JSON.parse(part) as unknown
					if (typeof message === 'object' && message !== null && 'Event' in message) events++
					else lines.push(message)
				}
			},
			close: () => closed.resolve(),
		},
	})
	cleanups.push(() => socket.end())
	// Version and AppState greet every socket.
	await waitUntil(() => events >= 2, 2000, 1)
	return { socket, lines, closed: closed.promise }
}

// A 240 x 240 fixture BLOB with one star at (70, 70) on a flat background; the star is plotted
// because the crop pixels are inspected.
function starFrame() {
	const width = 240
	const height = 240
	const raw = new Float32Array(width * height).fill(0.005)
	plotStar(raw, width, height, 1, 70, 70, 10, 3, 80, 0, undefined, { background: 0.005, saturationLevel: 1 })
	return fixtureGuideBlob(fixtureGuideImage(width, height, [[70, 70]], raw))
}

describe('connection', () => {
	test('greets every socket with Version, the known lock and calibration, then AppState; broadcasts the guider events', async () => {
		const context = rig()
		const first = await connect(context)
		expect(first.events().map((event) => event.Event)).toEqual(['Version', 'AppState'])
		expect(first.events()[0]).toMatchObject({ Event: 'Version', PHDVersion: PHD2_VERSION, MsgVersion: 1 })
		expect(first.events()[1]).toMatchObject({ Event: 'AppState', State: 'Stopped' })

		context.guider.setLockPosition(10, 20, true)
		const second = await connect(context)
		expect(second.events().map((event) => event.Event)).toEqual(['Version', 'LockPositionSet', 'AppState'])
		expect(second.events()[1]).toMatchObject({ X: 10, Y: 20 })
		expect(context.server.connections).toBe(2)

		// Every PHD2 event reaches every socket; the Guiding Assistant events of the local guider do not.
		context.guider.emitEvent('assistantStarted', { result: {} as never })
		context.guider.emitEvent('settleDone', { succeeded: true, totalFrames: 1, droppedFrames: 0 })
		for (const each of [first, second]) await waitUntil(() => each.events().some((event) => event.Event === 'SettleDone'), 2000, 1)
		expect(first.events().map((event) => event.Event)).toEqual(['Version', 'AppState', 'LockPositionSet', 'SettleDone'])
		expect(second.events().map((event) => event.Event)).toEqual(['Version', 'LockPositionSet', 'AppState', 'SettleDone'])
	})

	test('stop closes every socket, fails what is pending and stops forwarding', async () => {
		const context = rig()
		const disconnected: number[] = []
		context.server.addHandler({ disconnect: (_, connection) => void disconnected.push(connection) })
		const { client, closed } = await connect(context)

		context.server.stop()
		context.server.stop()
		await closed
		expect(disconnected).toEqual([1])
		expect(context.server.connections).toBe(0)
		expect(context.server.port).toBe(-1)
		expect(await client.getAppState()).toEqual({ success: false, error: 'socketUnavailable' })
		context.guider.emitEvent('settleDone', { succeeded: true, totalFrames: 1, droppedFrames: 0 })

		// It can listen again.
		expect(context.server.start('127.0.0.1', 0)).toBeTrue()
		expect(context.server.start('127.0.0.1', 0)).toBeFalse()
		const again = await connect(context)
		expect((await again.client.getAppState()).success).toBeTrue()
	})
})

describe('commands', () => {
	test('getters reply what the guider reports', async () => {
		const context = rig()
		const { client } = await connect(context)

		expect(await client.getAppState()).toEqual({ success: true, result: 'Stopped' })
		expect(await client.getConnected()).toEqual({ success: true, result: true })
		expect(await client.getCalibrated()).toEqual({ success: true, result: false })
		expect(await client.getCalibrationData('MOUNT')).toMatchObject({ success: true, result: { calibrated: false } })
		expect(await client.getCalibrationData('AO')).toMatchObject({ success: false, error: { code: 1 } })
		expect(await client.getCameraBinning()).toEqual({ success: true, result: 1 })
		expect(await client.getCameraFrameSize()).toEqual({ success: true, result: [240, 240] })
		expect(await client.getExposure()).toEqual({ success: true, result: 1000 })
		expect(await client.getExposureDurations()).toEqual({ success: true, result: DEFAULT_PHD2_EXPOSURE_DURATIONS })
		expect((await client.getPixelScale()).result).toBeCloseTo(PHD2_RIG_PIXEL_SCALE, 12)
		expect(await client.getSearchRegion()).toEqual({ success: true, result: 64 })
		expect(await client.getSettling()).toEqual({ success: true, result: false })
		expect(await client.getPaused()).toEqual({ success: true, result: false })
		expect(await client.getUseSubframes()).toEqual({ success: true, result: false })
		expect(await client.getLockPosition()).toEqual({ success: true, result: null })
		expect(await client.getLockShiftEnabled()).toEqual({ success: true, result: false })
		expect(await client.getLockShiftParams()).toEqual({ success: true, result: { enabled: false, rate: [0, 0], units: 'pixels/hr', axes: 'X/Y' } })
		expect(await client.getDeclinationGuideMode()).toEqual({ success: true, result: 'Auto' })
		expect(await client.getGuideOutputEnabled()).toEqual({ success: true, result: true })
		expect(await client.getCurrentEquipment()).toEqual({ success: true, result: { camera: { name: 'Guide Camera', connected: true }, mount: { name: 'Mount', connected: true } } })
		expect(await client.getProfile()).toEqual({ success: true, result: { ...DEFAULT_PHD2_SERVER_PROFILE } })
		expect(await client.getProfiles()).toEqual({ success: true, result: [{ ...DEFAULT_PHD2_SERVER_PROFILE, selected: true }] })
		expect(await client.setProfile(1)).toEqual({ success: true, result: 0 })
		expect(await client.setProfile(2)).toMatchObject({ success: false, error: { code: 1 } })
	})

	test('setters reach the guider and refusals are command errors', async () => {
		const context = rig()
		const { guider } = context
		const { client, events } = await connect(context)

		expect(await client.setExposure(2000)).toEqual({ success: true, result: 0 })
		expect(guider.getExposure()).toBe(2000)
		expect(await client.setExposure(-1)).toMatchObject({ success: false, error: { code: -32602 } })
		expect(await client.setDeclinationGuideMode('North')).toEqual({ success: true, result: 0 })
		expect(guider.getDeclinationGuideMode()).toBe('North')
		expect(await client.setGuideOutputEnabled(false)).toEqual({ success: true, result: 0 })
		expect(guider.getGuideOutputEnabled()).toBeFalse()
		expect(await client.setGuideOutputEnabled(true)).toEqual({ success: true, result: 0 })
		expect(await client.setLockShiftParams({ rate: [1, 2], axes: 'X/Y' })).toEqual({ success: true, result: 0 })
		expect(guider.getLockShiftParams()).toMatchObject({ rate: [1, 2], axes: 'X/Y', units: 'pixels/hr' })
		expect(await client.setLockShiftEnabled(true)).toEqual({ success: true, result: 0 })
		expect(guider.getLockShiftEnabled()).toBeTrue()

		// PHD2 sets the exact lock position unless told otherwise.
		expect(await client.send('set_lock_position', [12.5, 30])).toEqual({ success: true, result: 0 })
		expect(guider.getLockPosition()).toEqual([12.5, 30])
		expect(await client.send('set_lock_position', { x: 'a', y: 1 })).toMatchObject({ success: false, error: { code: -32602 } })
		expect(await client.deselectStar()).toEqual({ success: true, result: 0 })
		expect(guider.getLockPosition()).toBeUndefined()

		// Nothing is calibrated nor framed yet.
		expect(await client.flipCalibration()).toMatchObject({ success: false, error: { code: 1 } })
		expect(await client.dither(2)).toMatchObject({ success: false, error: { code: 1 } })
		expect(await client.findStar()).toMatchObject({ success: false, error: { code: 1 } })
		expect(await client.getStarImage()).toMatchObject({ success: false, error: { code: 2 } })
		expect(await client.clearCalibration()).toEqual({ success: true, result: 0 })

		// Looping, single frames, pauses and the capture stop.
		expect(await client.startCapture(500)).toEqual({ success: true, result: 0 })
		expect(context.cameraManager.exposures).toEqual([0.5])
		guider.stopCapture()
		expect(await client.loop()).toEqual({ success: true, result: 0 })
		expect(guider.getAppState()).toBe('Looping')
		expect(await client.startCapture(500)).toMatchObject({ success: false, error: { code: 1 } })
		expect(await client.setPaused(true, true)).toEqual({ success: true, result: 0 })
		expect(guider.getPaused()).toBeTrue()
		expect(await client.setPaused(false, false)).toEqual({ success: true, result: 0 })
		expect(guider.getPaused()).toBeFalse()
		expect(await client.stopCapture()).toEqual({ success: true, result: 0 })
		expect(guider.getAppState()).toBe('Stopped')
		expect(events().map((event) => event.Event)).toContain('Paused')
		expect(events().map((event) => event.Event)).toContain('Resumed')
		expect(events().map((event) => event.Event)).toContain('LoopingExposuresStopped')
	})

	test('guide replies after the events it caused; pulses reach the guide output', async () => {
		const context = rig()
		const { guider } = context
		const { client, received } = await connect(context)

		expect(await client.guide(true, { pixels: 1, time: 2, timeout: 20 })).toEqual({ success: true, result: 0 })
		expect(guider.getAppState()).toBe('Calibrating')
		expect(guider.getSettling()).toBeTrue()
		const order = received.map((entry) => (entry.kind === 'event' ? entry.event.Event : `reply:${entry.method}`))
		expect(order.slice(2)).toEqual(['SettleBegin', 'StartCalibration', 'reply:guide'])
		expect(await client.send('guide', { settle: { pixels: -1 } })).toMatchObject({ success: false, error: { code: -32602 } })

		guider.stopCapture()
		expect(await client.guidePulse(120, 'West')).toEqual({ success: true, result: 0 })
		expect(await client.send('guide_pulse', [80, 'n'])).toEqual({ success: true, result: 0 })
		expect(context.guideOutputManager.pulses).toEqual([
			{ direction: 'WEST', duration: 120 },
			{ direction: 'NORTH', duration: 80 },
		])
		expect(await client.guidePulse(100, 'North', 'AO')).toMatchObject({ success: false, error: { code: 1 } })
		expect(await client.send('guide_pulse', [100, 'up'])).toMatchObject({ success: false, error: { code: -32602 } })
	})

	test('set_connected binds and releases the configured devices', async () => {
		const context = rig({ connected: false })
		const { guider } = context
		const { client } = await connect(context)

		expect(await client.getConnected()).toEqual({ success: true, result: false })
		expect(await client.getCurrentEquipment()).toEqual({ success: true, result: { camera: { name: 'Guide Camera', connected: false }, mount: { name: 'Mount', connected: false } } })
		expect(await client.guide()).toMatchObject({ success: false, error: { code: 1 } })
		expect(await client.setConnected(true)).toEqual({ success: true, result: 0 })
		expect(await client.setConnected(true)).toEqual({ success: true, result: 0 })
		expect(await client.getConnected()).toEqual({ success: true, result: true })
		expect((await client.getPixelScale()).result).toBeCloseTo(PHD2_RIG_PIXEL_SCALE, 12)

		expect(await client.loop()).toEqual({ success: true, result: 0 })
		expect(await client.setConnected(false)).toEqual({ success: true, result: 0 })
		expect(guider.getAppState()).toBe('Stopped')
		expect(guider.camera).toBeUndefined()

		// Without configured devices only a guider already connected can be connected.
		const bare = rig({ connected: false, server: { devices: undefined } })
		const other = await connect(bare)
		expect(await other.client.setConnected(true)).toMatchObject({ success: false, error: { code: 1 } })
	})

	test('get_star_image encodes the crop around the selected star as PHD2 does', async () => {
		const context = rig()
		const { guider, cameraManager, camera } = context
		const { client, events } = await connect(context)

		expect(await client.loop()).toEqual({ success: true, result: 0 })
		cameraManager.handler!.blobReceived!(camera, starFrame(), 'raw')
		await waitUntil(() => events().some((event) => event.Event === 'LoopingExposures'), 5000, 5)

		const star = await client.findStar()
		expect(star.success).toBeTrue()
		expect(star.result![0]).toBeCloseTo(70, 0)
		expect(star.result![1]).toBeCloseTo(70, 0)

		const image = await client.getStarImage()
		expect(image.success).toBeTrue()
		const { width, height, frame, star_pos, pixels } = image.result!
		expect([width, height, frame]).toEqual([64, 64, 1])
		expect(star_pos[0]).toBeCloseTo(32, 0)
		expect(star_pos[1]).toBeCloseTo(32, 0)

		// Mono unsigned 16-bit little-endian samples, the brightest at the star.
		const samples = Buffer.from(pixels, 'base64')
		expect(samples.byteLength).toBe(64 * 64 * 2)
		let peak = 0
		for (let i = 0; i < 64 * 64; i++) if (samples.readUInt16LE(i * 2) > samples.readUInt16LE(peak * 2)) peak = i
		expect(Math.abs((peak % 64) - star_pos[0])).toBeLessThanOrEqual(1)
		expect(Math.abs(Math.trunc(peak / 64) - star_pos[1])).toBeLessThanOrEqual(1)
		expect(samples.readUInt16LE(0)).toBe(Math.round(0.005 * 65535))
		expect(guider.getStarImage()!.star_pos).toEqual({ x: star_pos[0], y: star_pos[1] })
	})

	test('unknown, unsupported, failing and shutdown methods', async () => {
		const context = rig()
		const { client } = await connect(context)

		expect(await client.send('nope')).toMatchObject({ success: false, error: { code: -32601 } })
		expect(await client.getAlgorithmParamNames('RA')).toMatchObject({ success: false, error: { code: 1 } })
		expect(await client.saveImage()).toMatchObject({ success: false, error: { code: 1 } })

		const failing = spyOn(context.guider, 'getExposure').mockImplementation(() => {
			throw new Error('boom')
		})
		expect(await client.getExposure()).toEqual({ success: false, error: { code: -32603, message: 'boom' } })
		failing.mockRestore()

		expect(await client.shutdown()).toMatchObject({ success: false, error: { code: 1 } })
		const shutdown = Promise.withResolvers<void>()
		context.server.addHandler({ shutdown: () => shutdown.resolve() })
		expect(await client.shutdown()).toEqual({ success: true, result: 0 })
		await shutdown.promise
	})
})

describe('wire', () => {
	test('JSON-RPC framing: parse errors, split and bare-LF lines, notifications, batches and invalid requests', async () => {
		const context = rig()
		const { socket, lines } = await raw(context)

		socket.write('{"method": nope\r\n{"method":"get_exposure","id":1}\r\n')
		await waitUntil(() => lines.length >= 2, 2000, 1)
		expect(lines.splice(0)).toEqual([
			{ jsonrpc: '2.0', error: { code: -32700, message: 'parse error' }, id: null },
			{ jsonrpc: '2.0', result: 1000, id: 1 },
		])

		// A request split across chunks, a bare LF, and a malformed line split before its line feed.
		socket.write('{"method":"get_pa')
		await Bun.sleep(20)
		socket.write('used","id":"a"}\n{"x": ')
		await Bun.sleep(20)
		socket.write('nope, "method": "get_paused", "id": 9}\n{"method":"get_settling","id":2}\n')
		await waitUntil(() => lines.length >= 3, 2000, 1)
		expect(lines.splice(0)).toEqual([
			{ jsonrpc: '2.0', result: false, id: 'a' },
			{ jsonrpc: '2.0', error: { code: -32700, message: 'parse error' }, id: null },
			{ jsonrpc: '2.0', result: false, id: 2 },
		])

		// A notification runs without reply; a batch replies the requests with an id, in order.
		socket.write('{"method":"set_exposure","params":[3000]}\r\n[{"method":"get_exposure","id":3},{"method":"loop"},{"method":"get_app_state","id":4}]\r\n')
		await waitUntil(() => lines.length > 0, 2000, 1)
		await Bun.sleep(20)
		expect(lines.splice(0)).toEqual([
			[
				{ jsonrpc: '2.0', result: 3000, id: 3 },
				{ jsonrpc: '2.0', result: 'Looping', id: 4 },
			],
		])
		expect(context.methods()).toEqual(['get_exposure', 'get_paused', 'get_settling', 'set_exposure', 'get_exposure', 'loop', 'get_app_state'])

		socket.write('{"id":5}\r\n[]\r\n{"method":"set_exposure","params":"x","id":6}\r\n42\r\n')
		await waitUntil(() => lines.length >= 4, 2000, 1)
		expect(lines.splice(0)).toMatchObject([
			{ error: { code: -32600 }, id: 5 },
			{ error: { code: -32600 }, id: null },
			{ error: { code: -32602 }, id: 6 },
			{ error: { code: -32600 }, id: null },
		])
	})

	test('an unterminated line beyond the bound closes the socket', async () => {
		const context = rig({ server: { maxLineLength: 64 } })
		const disconnected: number[] = []
		context.server.addHandler({ disconnect: (_, connection) => void disconnected.push(connection) })
		const { socket, closed } = await raw(context)

		socket.write(`{"method":"get_exposure","params":["${'x'.repeat(100)}`)
		await closed
		expect(disconnected).toEqual([1])
		expect(context.server.connections).toBe(0)
	})
})
