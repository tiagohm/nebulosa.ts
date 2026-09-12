import { expect, test } from 'bun:test'
import type { Socket } from 'bun'
import { PHD2Client, type PHD2ClientOptions } from '../../../src/devices/guiding/phd2'

async function withPHD2Server(onCommand: (socket: Socket<unknown>, command: Record<string, unknown>) => void, action: (client: PHD2Client) => Promise<void>, options?: PHD2ClientOptions) {
	let input = ''
	const server = Bun.listen({
		hostname: '127.0.0.1',
		port: 0,
		socket: {
			data: (socket, data) => {
				input += data.toString()
				let end = input.indexOf('\n')

				while (end >= 0) {
					const line = input.slice(0, end).trim()
					input = input.slice(end + 1)
					if (line) onCommand(socket, JSON.parse(line) as Record<string, unknown>)
					end = input.indexOf('\n')
				}
			},
		},
	})

	using client = new PHD2Client(options)

	try {
		expect(await client.connect('127.0.0.1', server.port)).toBeTrue()
		await action(client)
	} finally {
		client.close()
		server.stop(true)
	}
}

test.skip('client', async () => {
	const client = new PHD2Client({
		handler: {
			event: (_, event) => {
				console.info('EVENT:', event)
			},
		},
	})

	await client.connect('0.0.0.0')

	await Bun.sleep(1000)

	console.info('FIND_STAR:', await client.findStar())
	console.info('GET_ALGORITHM_PARAM_NAMES(RA):', await client.getAlgorithmParamNames('RA'))
	console.info('GET_ALGORITHM_PARAM_NAMES(DEC):', await client.getAlgorithmParamNames('DEC'))
	console.info('GET_ALGORITHM_PARAM(RA, NAME):', await client.getAlgorithmParam('RA', 'algorithmName'))
	console.info('GET_ALGORITHM_PARAM(DEC, NAME):', await client.getAlgorithmParam('DEC', 'algorithmName'))
	console.info('GET_APP_STATE:', await client.getAppState())
	console.info('GET_CALIBRATED:', await client.getCalibrated())
	console.info('GET_CALIBRATION_DATA(MOUNT):', await client.getCalibrationData('MOUNT'))
	console.info('GET_CAMERA_BINNING:', await client.getCameraBinning())
	console.info('GET_CAMERA_FRAME_SIZE:', await client.getCameraFrameSize())
	console.info('GET_CONNECTED:', await client.getConnected())
	console.info('GET_CURRENT_EQUIPMENT:', await client.getCurrentEquipment())
	console.info('GET_DECLINATION_GUIDE_MODE:', await client.getDeclinationGuideMode())
	console.info('GET_EXPOSURE:', await client.getExposure())
	console.info('GET_EXPOSURE_DURATIONS:', await client.getExposureDurations())
	console.info('GET_GUIDE_OUTPUT_ENABLED:', await client.getGuideOutputEnabled())
	console.info('GET_LOCK_POSITION:', await client.getLockPosition())
	console.info('GET_LOCK_SHIFT_ENABLED:', await client.getLockShiftEnabled())
	console.info('GET_LOCK_SHIFT_PARAMS:', await client.getLockShiftParams())
	console.info('GET_PAUSED:', await client.getPaused())
	console.info('GET_PIXEL_SCALE:', await client.getPixelScale())
	console.info('GET_PROFILE:', await client.getProfile())
	console.info('GET_PROFILES:', await client.getProfiles())
	console.info('GET_SEARCH_REGION:', await client.getSearchRegion())
	console.info('GET_SETTLING:', await client.getSettling())
	console.info('GET_STAR_IMAGE:', await client.getStarImage())
	console.info('GET_USE_SUBFRAMES:', await client.getUseSubframes())
}, 5000)

test('findStar sends a named ROI parameter', async () => {
	let command: Record<string, unknown> | undefined

	await withPHD2Server(
		(socket, received) => {
			command = received
			socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: received.id, result: [150, 180] })}\r\n`)
		},
		async (client) => {
			expect(await client.findStar({ x: 100, y: 80, width: 200, height: 200 })).toEqual({ success: true, result: [150, 180] })
		},
	)

	expect(command).toEqual({ method: 'find_star', params: { roi: [100, 80, 200, 200] }, id: expect.any(String) })
})

test('setPaused omits the type for a partial pause', async () => {
	const params: unknown[] = []

	await withPHD2Server(
		(socket, command) => {
			params.push(command.params)
			socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: command.id, result: 0 })}\r\n`)
		},
		async (client) => {
			expect(await client.setPaused(true, false)).toEqual({ success: true, result: 0 })
			expect(await client.setPaused(true)).toEqual({ success: true, result: 0 })
		},
	)

	expect(params).toEqual([[true], [true, 'full']])
})

test('setConnected sends a boolean parameter', async () => {
	const params: unknown[] = []

	await withPHD2Server(
		(socket, command) => {
			params.push(command.params)
			socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: command.id, result: 0 })}\r\n`)
		},
		async (client) => {
			expect(await client.setConnected(true)).toEqual({ success: true, result: 0 })
			expect(await client.setConnected(false)).toEqual({ success: true, result: 0 })
		},
	)

	expect(params).toEqual([[true], [false]])
})

test('timeout ignores late replies', async () => {
	const requestReceived = Promise.withResolvers<{ socket: Socket<unknown>; command: Record<string, unknown> }>()
	let commandCallbacks = 0

	await withPHD2Server(
		(socket, command) => {
			requestReceived.resolve({ socket, command })
		},
		async (client) => {
			const pending = client.send('get_app_state', undefined, 1)
			const request = await requestReceived.promise

			expect(await pending).toEqual({ success: false, error: 'timeout' })
			request.socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.command.id, result: 'Guiding' })}\r\n`)
			await Bun.sleep(10)
			expect(commandCallbacks).toBe(0)
		},
		{ handler: { command: () => commandCallbacks++ } },
	)
})

test('close resolves pending commands', async () => {
	const requestReceived = Promise.withResolvers<void>()

	await withPHD2Server(
		() => {
			requestReceived.resolve()
		},
		async (client) => {
			const pending = client.send('get_app_state', undefined, 1000)
			await requestReceived.promise
			client.close()

			expect(await pending).toEqual({ success: false, error: 'socketUnavailable' })
		},
	)
})
