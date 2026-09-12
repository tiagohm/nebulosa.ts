import { expect, test } from 'bun:test'
import { AlpacaApi } from '../../../src/devices/alpaca/api'
import type { AlpacaRequestResult } from '../../../src/devices/alpaca/types'

const alpaca = new AlpacaApi('http://localhost:32323')

// Only reach the network when explicitly enabled; otherwise a missing server
// would throw a ConnectionRefused at import and pollute the test run.
const isAlpacaTestEnabled = process.env.ALPACA === 'true'
const configuredDevices = isAlpacaTestEnabled ? await alpaca.management.configuredDevices() : undefined
const devices = configuredDevices?.ok ? configuredDevices.value : []
const filterWheel = devices.find((e) => e.DeviceType === 'filterwheel')
const focuser = devices.find((e) => e.DeviceType === 'focuser')
const coverCalibrator = devices.find((e) => e.DeviceType === 'covercalibrator')

async function valueOf<T>(call: Promise<AlpacaRequestResult<T>>) {
	const result = await call
	return result.ok ? result.value : undefined
}

test('builds device API endpoint roots without contacting a server', () => {
	const api = new AlpacaApi('http://example.test:11111/root')

	expect(api.camera.url.toString()).toBe('http://example.test:11111/api/v1/camera/')
	expect(api.telescope.url.toString()).toBe('http://example.test:11111/api/v1/telescope/')
	expect(api.filterWheel.url.toString()).toBe('http://example.test:11111/api/v1/filterwheel/')
	expect(api.focuser.url.toString()).toBe('http://example.test:11111/api/v1/focuser/')
	expect(api.coverCalibrator.url.toString()).toBe('http://example.test:11111/api/v1/covercalibrator/')
	expect(api.rotator.url.toString()).toBe('http://example.test:11111/api/v1/rotator/')
	expect(api.dome.url.toString()).toBe('http://example.test:11111/api/v1/dome/')
	expect(api.safetyMonitor.url.toString()).toBe('http://example.test:11111/api/v1/safetymonitor/')
})

test('returns gain names as strings in index order', async () => {
	const gains = ['LCG', 'HCG']
	using server = Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		fetch(request: Request) {
			expect(new URL(request.url).pathname).toBe('/api/v1/camera/2/gains')
			expect(request.method).toBe('GET')
			return Response.json({ Value: gains, ErrorNumber: 0, ErrorMessage: '', ClientTransactionID: 0, ServerTransactionID: 1 })
		},
	})
	const result: AlpacaRequestResult<readonly string[]> = await new AlpacaApi(server.url).camera.getGains(2)
	expect(result).toEqual({ ok: true, value: gains })
})

test('returns the last exposure start time as the original FITS UTC string', async () => {
	const startTime = '2024-06-15T01:23:45.000'
	using server = Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		fetch(request: Request) {
			expect(new URL(request.url).pathname).toBe('/api/v1/camera/2/lastexposurestarttime')
			expect(request.method).toBe('GET')
			return Response.json({ Value: startTime, ErrorNumber: 0, ErrorMessage: '', ClientTransactionID: 0, ServerTransactionID: 1 })
		},
	})
	const result: AlpacaRequestResult<string> = await new AlpacaApi(server.url).camera.getLastExposureStartTime(2)
	expect(result).toEqual({ ok: true, value: startTime })
})

// ImageBytes metadata v1: 11 little-endian 32-bit fields, then pixels or a UTF-8 error.
function imageBytes(errorNumber: number = 0, errorMessage: string = '', dataStart: number = 44) {
	const payload = errorNumber ? new TextEncoder().encode(errorMessage) : new Uint8Array([42, 0])
	const bytes = new Uint8Array(dataStart + payload.length)
	const header = new DataView(bytes.buffer)
	const fields = [1, errorNumber, 0, 1, dataStart, 2, 8, 2, 1, 1, 0]
	for (let i = 0; i < fields.length; i++) header.setInt32(i * 4, fields[i], true)
	bytes.set(payload, dataStart)
	return bytes
}

test('downloads successful ImageBytes unchanged', async () => {
	const bytes = imageBytes()
	using server = Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		fetch(request: Request) {
			expect(new URL(request.url).pathname).toBe('/api/v1/camera/2/imagearray')
			expect(request.method).toBe('GET')
			expect(request.headers.get('Accept')).toBe('application/imagebytes')
			return new Response(bytes, { headers: { 'Content-Type': 'application/imagebytes; charset=utf-8' } })
		},
	})
	const result = await new AlpacaApi(server.url).camera.getImageArray(2)
	expect(result.ok).toBeTrue()
	if (result.ok) expect(new Uint8Array(result.value)).toEqual(bytes)
})

test.each([
	{
		name: 'JSON Alpaca error',
		body: JSON.stringify({ Value: null, ErrorNumber: 1035, ErrorMessage: 'Image not ready', ClientTransactionID: 0, ServerTransactionID: 1 }),
		contentType: 'application/json; charset=utf-8',
		errorNumber: 1035,
		errorMessage: 'Image not ready',
	},
	{
		name: 'JSON error without a JSON content type',
		body: '  {"ErrorNumber":1035,"ErrorMessage":"Image not ready"}',
		contentType: 'text/plain',
		errorNumber: 1035,
		errorMessage: 'Image not ready',
	},
	{
		name: 'binary Alpaca error with an extended header and UTF-8 text',
		body: imageBytes(1035, 'Imagem não disponível', 48),
		contentType: 'application/imagebytes',
		errorNumber: 1035,
		errorMessage: 'Imagem não disponível',
	},
	{
		name: 'binary Alpaca error without a message',
		body: imageBytes(1035),
		contentType: 'application/imagebytes',
		errorNumber: 1035,
		errorMessage: '',
	},
	{
		name: 'successful JSON image cannot be returned as ImageBytes',
		body: JSON.stringify({ Value: [[42]], ErrorNumber: 0, ErrorMessage: '', Type: 2, Rank: 2 }),
		contentType: 'application/json',
		errorNumber: undefined,
		errorMessage: 'JSON image arrays are not supported; ImageBytes is required',
	},
	{
		name: 'unsupported content type',
		body: 'not an image',
		contentType: 'image/jpeg',
		errorNumber: undefined,
		errorMessage: 'unsupported image response content type: image/jpeg',
	},
	{
		name: 'truncated binary header',
		body: new Uint8Array(8),
		contentType: 'application/imagebytes',
		errorNumber: undefined,
		errorMessage: 'truncated ImageBytes header',
	},
])('image download rejects $name', async ({ body, contentType, errorNumber, errorMessage }) => {
	using server = Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		fetch() {
			return new Response(body, { headers: { 'Content-Type': contentType } })
		},
	})
	const result = await new AlpacaApi(server.url).camera.getImageArray(0)
	expect(result).toEqual({ ok: false, errorNumber, errorMessage })
})

if (filterWheel) {
	const id = filterWheel.DeviceNumber

	test('filter wheel', async () => {
		await alpaca.filterWheel.connect(id)

		const names = await valueOf(alpaca.filterWheel.getNames(id))
		const position = await valueOf(alpaca.filterWheel.getPosition(id))

		expect(names).not.toBeEmpty()
		expect(position).toBeDefined()

		const newPosition = (position! + 1) % names!.length
		await alpaca.filterWheel.setPosition(id, newPosition)
		while ((await valueOf(alpaca.filterWheel.getPosition(id))) === -1) await Bun.sleep(250)
		expect(await valueOf(alpaca.filterWheel.getPosition(id))).toBe(newPosition)
	})
}

if (focuser) {
	const id = focuser.DeviceNumber

	test('focuser', async () => {
		await alpaca.focuser.connect(id)

		const absolute = await valueOf(alpaca.focuser.isAbsolute(id))
		const maxStep = await valueOf(alpaca.focuser.getMaxStep(id))
		const position = await valueOf(alpaca.focuser.getPosition(id))
		const temperature = await valueOf(alpaca.focuser.getTemperature(id))
		const temperatureCompensationAvailable = await valueOf(alpaca.focuser.isTemperatureCompensationAvailable(id))

		expect(absolute).toBeTrue()
		expect(maxStep).toBe(50000)
		expect(position).toBeDefined()
		expect(temperature).toBeDefined()
		expect(temperatureCompensationAvailable).toBeTrue()

		await alpaca.focuser.setTemperatureCompensation(id, false)
		const newPosition = (position! + 100) % 50000
		await alpaca.focuser.move(id, newPosition)
		while (await valueOf(alpaca.focuser.isMoving(id))) await Bun.sleep(250)
		expect(await valueOf(alpaca.focuser.getPosition(id))).toBe(newPosition)
		expect(await valueOf(alpaca.focuser.isTemperatureCompensation(id))).toBeFalse()
	})
}

if (coverCalibrator) {
	const id = coverCalibrator.DeviceNumber

	test('cover calibrator', async () => {
		await alpaca.coverCalibrator.connect(id)

		const maxBrightness = await valueOf(alpaca.coverCalibrator.getMaxBrightness(id))
		const brightness = await valueOf(alpaca.coverCalibrator.getBrightness(id))
		const coverState = await valueOf(alpaca.coverCalibrator.getCoverState(id))
		const calibratorState = await valueOf(alpaca.coverCalibrator.getCalibratorState(id))

		expect(maxBrightness).toBe(100)
		expect(brightness).toBeDefined()
		expect(coverState === 1 || coverState === 3 || coverState === 4).toBeTrue()
		expect(calibratorState === 1 || calibratorState === 3).toBeTrue()

		const shouldBeOpen = coverState === 4 && Math.random() <= 0.5

		if (coverState === 1 || shouldBeOpen) {
			await alpaca.coverCalibrator.open(id)
			while (await valueOf(alpaca.coverCalibrator.isMoving(id))) await Bun.sleep(250)
			expect(await valueOf(alpaca.coverCalibrator.getCoverState(id))).toBe(3)
		} else {
			await alpaca.coverCalibrator.close(id)
			while (await valueOf(alpaca.coverCalibrator.isMoving(id))) await Bun.sleep(250)
			expect(await valueOf(alpaca.coverCalibrator.getCoverState(id))).toBe(1)
		}

		const newBrightness = (brightness! + 20) % maxBrightness!
		await alpaca.coverCalibrator.on(id, newBrightness)
		while (await valueOf(alpaca.coverCalibrator.isChanging(id))) await Bun.sleep(250)
		expect(await valueOf(alpaca.coverCalibrator.getBrightness(id))).toBe(newBrightness)

		if (coverState === 1) await alpaca.coverCalibrator.open(id)
		else await alpaca.coverCalibrator.close(id)
		await alpaca.coverCalibrator.halt(id)
		expect(await valueOf(alpaca.coverCalibrator.getCoverState(id))).toBe(4)
	}, 10000)
}
