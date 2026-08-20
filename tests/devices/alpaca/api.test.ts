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
