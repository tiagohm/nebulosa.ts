import { expect, test } from 'bun:test'
import { AlpacaApi } from '../src/alpaca.api'

const alpaca = new AlpacaApi('http://localhost:32323')

const configuredDevices = await alpaca.management.configuredDevices()
const filterWheel = configuredDevices?.filter((e) => e.DeviceType === 'filterwheel')?.[0]
const focuser = configuredDevices?.filter((e) => e.DeviceType === 'focuser')?.[0]
const coverCalibrator = configuredDevices?.filter((e) => e.DeviceType === 'covercalibrator')?.[0]

if (filterWheel) {
	test('filter wheel', async () => {
		await alpaca.filterWheel.connect(filterWheel.DeviceNumber)

		const names = await alpaca.filterWheel.getNames(filterWheel.DeviceNumber)
		const position = await alpaca.filterWheel.getPosition(filterWheel.DeviceNumber)

		expect(names).not.toBeEmpty()
		expect(position).toBeDefined()

		const newPosition = (position! + 1) % names!.length
		await alpaca.filterWheel.setPosition(filterWheel.DeviceNumber, newPosition)
		while ((await alpaca.filterWheel.getPosition(filterWheel.DeviceNumber)) === -1) await Bun.sleep(250)
		expect(await alpaca.filterWheel.getPosition(filterWheel.DeviceNumber)).toBe(newPosition)
	})
}

if (focuser) {
	test('focuser', async () => {
		await alpaca.focuser.connect(focuser.DeviceNumber)

		const absolute = await alpaca.focuser.isAbsolute(focuser.DeviceNumber)
		const maxStep = await alpaca.focuser.getMaxStep(focuser.DeviceNumber)
		const position = await alpaca.focuser.getPosition(focuser.DeviceNumber)
		const temperature = await alpaca.focuser.getTemperature(focuser.DeviceNumber)
		const temperatureCompensationAvailable = await alpaca.focuser.isTemperatureCompensationAvailable(focuser.DeviceNumber)

		expect(absolute).toBeTrue()
		expect(maxStep).toBe(50000)
		expect(position).toBeDefined()
		expect(temperature).toBeDefined()
		expect(temperatureCompensationAvailable).toBeTrue()

		await alpaca.focuser.setTemperatureCompensation(focuser.DeviceNumber, false)
		const newPosition = (position! + 100) % 50000
		await alpaca.focuser.move(focuser.DeviceNumber, newPosition)
		while (await alpaca.focuser.isMoving(focuser.DeviceNumber)) await Bun.sleep(250)
		expect(await alpaca.focuser.getPosition(focuser.DeviceNumber)).toBe(newPosition)
		expect(await alpaca.focuser.isTemperatureCompensation(focuser.DeviceNumber)).toBeFalse()
	})
}

if (coverCalibrator) {
	test('cover calibrator', async () => {
		await alpaca.coverCalibrator.connect(coverCalibrator.DeviceNumber)

		const maxBrightness = await alpaca.coverCalibrator.getMaxBrightness(coverCalibrator.DeviceNumber)
		const brightness = await alpaca.coverCalibrator.getBrightness(coverCalibrator.DeviceNumber)
		const coverState = await alpaca.coverCalibrator.getCoverState(coverCalibrator.DeviceNumber)
		const calibratorState = await alpaca.coverCalibrator.getCalibratorState(coverCalibrator.DeviceNumber)

		expect(maxBrightness).toBe(100)
		expect(brightness).toBeDefined()
		expect(coverState === 1 || coverState === 3 || coverState === 4).toBeTrue()
		expect(calibratorState === 1 || calibratorState === 3).toBeTrue()

		const shouldBeOpen = coverState === 4 && Math.random() <= 0.5

		if (coverState === 1 || shouldBeOpen) {
			await alpaca.coverCalibrator.open(coverCalibrator.DeviceNumber)
			while (await alpaca.coverCalibrator.isMoving(coverCalibrator.DeviceNumber)) await Bun.sleep(250)
			expect(await alpaca.coverCalibrator.getCoverState(coverCalibrator.DeviceNumber)).toBe(3)
		} else {
			await alpaca.coverCalibrator.close(coverCalibrator.DeviceNumber)
			while (await alpaca.coverCalibrator.isMoving(coverCalibrator.DeviceNumber)) await Bun.sleep(250)
			expect(await alpaca.coverCalibrator.getCoverState(coverCalibrator.DeviceNumber)).toBe(1)
		}

		const newBrightness = (brightness! + 20) % maxBrightness!
		await alpaca.coverCalibrator.on(coverCalibrator.DeviceNumber, newBrightness)
		while (await alpaca.coverCalibrator.isChanging(coverCalibrator.DeviceNumber)) await Bun.sleep(250)
		expect(await alpaca.coverCalibrator.getBrightness(coverCalibrator.DeviceNumber)).toBe(newBrightness)

		if (coverState === 1) await alpaca.coverCalibrator.open(coverCalibrator.DeviceNumber)
		else await alpaca.coverCalibrator.close(coverCalibrator.DeviceNumber)
		await alpaca.coverCalibrator.halt(coverCalibrator.DeviceNumber)
		expect(await alpaca.coverCalibrator.getCoverState(coverCalibrator.DeviceNumber)).toBe(4)
	}, 10000)
}
