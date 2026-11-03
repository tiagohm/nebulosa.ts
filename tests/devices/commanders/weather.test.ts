import { afterAll, afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { WeatherCommander } from '../../../src/devices/commanders/weather'
import { IndiClientHandlerSet } from '../../../src/devices/indi/client'
import type { Weather } from '../../../src/devices/indi/device'
import { WeatherManager } from '../../../src/devices/indi/manager/weather'
import { ClientSimulator } from '../../../src/devices/indi/simulator/client'
import { WEATHER_DEFAULT_UPDATE_PERIOD, WEATHER_MAX_UPDATE_PERIOD, WEATHER_MIN_UPDATE_PERIOD } from '../../../src/devices/indi/simulator/constants'
import { WeatherSimulator } from '../../../src/devices/indi/simulator/weather'
import { DeviceLifecycle } from '../../../src/devices/orchestration/device.lifecycle'
import { OperationCoordinator, failedOperationResult } from '../../../src/devices/orchestration/operation'
import { ResourceArbiter, resourceKey } from '../../../src/devices/orchestration/resource'
import { waitUntil } from '../../util'

const weatherManager = new WeatherManager()
const resourceArbiter = new ResourceArbiter()
const operationCoordinator = new OperationCoordinator(resourceArbiter)
const weatherCommander = new WeatherCommander(weatherManager)
const deviceLifecycle = new DeviceLifecycle(resourceArbiter, operationCoordinator)
deviceLifecycle.observe(weatherManager)
const handler = new IndiClientHandlerSet([weatherManager])
const client = new ClientSimulator('Client Simulator', handler)
const simulator = new WeatherSimulator('Weather Simulator', client)

afterAll(() => {
	deviceLifecycle.dispose()
	simulator.dispose()
})

beforeEach(() => {
	weatherManager.disconnect(getWeather())
})

afterEach(async () => {
	await operationCoordinator.cancelAll()
	const weather = getWeather()
	if (weather.connected) weatherManager.setUpdatePeriod(weather, WEATHER_DEFAULT_UPDATE_PERIOD)
	weatherManager.disconnect(weather)
})

function getWeather() {
	const device = weatherManager.get(client, simulator.name)
	expect(device).toBeDefined()
	return device!
}

function isFree(weather: Weather) {
	return resourceArbiter.availability(resourceKey(weather)) === 'available'
}

async function connected() {
	const weather = getWeather()
	weatherManager.connect(weather)
	await waitUntil(() => weather.connected && weather.updatePeriod !== undefined && isFree(weather))
	return weather
}

// Defines the averaging window the INDI simulator lacks, as the Alpaca bridge publishes it, and returns the
// function that withdraws it again.
function defineAveragePeriod(weather: Weather, hours: number) {
	weatherManager.numberVector(client, { device: weather.name, name: 'WEATHER_AVERAGE_PERIOD', permission: 'rw', state: 'Ok', elements: { AVERAGE_PERIOD: { name: 'AVERAGE_PERIOD', format: '%.2f', min: 0, max: 24, step: 0.1, value: hours } } }, 'defNumberVector')
	return () => weatherManager.delProperty(client, { device: weather.name, name: 'WEATHER_AVERAGE_PERIOD' })
}

test('sets the update period clamped to the published range and resolves once it is reported', async () => {
	const weather = await connected()
	const setUpdatePeriod = spyOn(weatherManager, 'setUpdatePeriod')

	try {
		expect(await weatherCommander.setUpdatePeriod(operationCoordinator, weather, 30)).toMatchObject({ ok: true })
		expect(weather.updatePeriod!.value).toBe(30)

		expect(await weatherCommander.setUpdatePeriod(operationCoordinator, weather, 0)).toMatchObject({ ok: true })
		expect(weather.updatePeriod!.value).toBe(WEATHER_MIN_UPDATE_PERIOD)

		expect(await weatherCommander.setUpdatePeriod(operationCoordinator, weather, 1e6)).toMatchObject({ ok: true })
		expect(weather.updatePeriod!.value).toBe(WEATHER_MAX_UPDATE_PERIOD)

		expect(setUpdatePeriod).toHaveBeenNthCalledWith(1, weather, 30)
		expect(setUpdatePeriod).toHaveBeenNthCalledWith(2, weather, WEATHER_MIN_UPDATE_PERIOD)
		expect(setUpdatePeriod).toHaveBeenNthCalledWith(3, weather, WEATHER_MAX_UPDATE_PERIOD)
		expect(isFree(weather)).toBeTrue()
	} finally {
		setUpdatePeriod.mockRestore()
	}
})

test('resolves an update period only after the driver reports it', async () => {
	const weather = await connected()
	const setUpdatePeriod = spyOn(weatherManager, 'setUpdatePeriod').mockImplementation(() => true)

	try {
		let settled = false
		const command = weatherCommander.setUpdatePeriod(operationCoordinator, weather, 45).then((result) => {
			settled = true
			return result
		})

		await Bun.sleep(30)
		expect(settled).toBeFalse()
		setUpdatePeriod.mockRestore()
		weatherManager.setUpdatePeriod(weather, 45)
		expect(await command).toMatchObject({ ok: true })
		expect(weather.updatePeriod!.value).toBe(45)
	} finally {
		setUpdatePeriod.mockRestore()
	}
})

test('times out when the driver never reports the update period', async () => {
	const weather = await connected()
	const setUpdatePeriod = spyOn(weatherManager, 'setUpdatePeriod').mockImplementation(() => true)

	try {
		expect(await weatherCommander.setUpdatePeriod(operationCoordinator, weather, 45, { timeout: 30 })).toMatchObject(failedOperationResult('timeout'))
		expect(isFree(weather)).toBeTrue()
	} finally {
		setUpdatePeriod.mockRestore()
	}
})

test('fails an update period the driver answers with an Alert', async () => {
	const weather = await connected()
	const setUpdatePeriod = spyOn(weatherManager, 'setUpdatePeriod').mockImplementation((device) => {
		weatherManager.numberVector(client, { device: device.name, name: 'WEATHER_UPDATE', state: 'Alert', elements: { PERIOD: { name: 'PERIOD', value: device.updatePeriod!.value } } }, 'setNumberVector')
		return true
	})

	try {
		expect(await weatherCommander.setUpdatePeriod(operationCoordinator, weather, 45, { timeout: 1000 })).toMatchObject(failedOperationResult('alert'))
	} finally {
		setUpdatePeriod.mockRestore()
	}
})

test('dispatches a refresh to a station with a refresh switch', async () => {
	const weather = await connected()
	const refresh = spyOn(weatherManager, 'refresh')

	try {
		expect(await weatherCommander.refresh(operationCoordinator, weather)).toMatchObject({ ok: true })
		expect(refresh).toHaveBeenCalledTimes(1)
		expect(isFree(weather)).toBeTrue()
	} finally {
		refresh.mockRestore()
	}
})

test('refuses an average period on a station that does not offer one', async () => {
	const weather = await connected()
	const setAveragePeriod = spyOn(weatherManager, 'setAveragePeriod')

	try {
		expect(weatherManager.canSetAveragePeriod(weather)).toBeFalse()
		expect(await weatherCommander.setAveragePeriod(operationCoordinator, weather, 1)).toMatchObject(failedOperationResult('unexpectedState'))
		expect(setAveragePeriod).not.toHaveBeenCalled()
	} finally {
		setAveragePeriod.mockRestore()
	}
})

test('accepts an average period reported with the two decimals drivers print', async () => {
	const weather = await connected()
	const withdraw = defineAveragePeriod(weather, 0)
	const setAveragePeriod = spyOn(weatherManager, 'setAveragePeriod').mockImplementation((device, hours) => {
		weatherManager.numberVector(client, { device: device.name, name: 'WEATHER_AVERAGE_PERIOD', state: 'Ok', elements: { AVERAGE_PERIOD: { name: 'AVERAGE_PERIOD', value: Math.round(hours * 100) / 100 } } }, 'setNumberVector')
		return true
	})

	try {
		expect(await weatherCommander.setAveragePeriod(operationCoordinator, weather, 1.234, { timeout: 50 })).toMatchObject({ ok: true })
		expect(weather.averagePeriod).toBe(1.23)
		expect(setAveragePeriod).toHaveBeenCalledWith(weather, 1.234)
	} finally {
		setAveragePeriod.mockRestore()
		withdraw()
	}
})

test('fails an average period the driver answers with an Alert', async () => {
	const weather = await connected()
	const withdraw = defineAveragePeriod(weather, 0)
	const setAveragePeriod = spyOn(weatherManager, 'setAveragePeriod').mockImplementation((device) => {
		weatherManager.numberVector(client, { device: device.name, name: 'WEATHER_AVERAGE_PERIOD', state: 'Alert', elements: { AVERAGE_PERIOD: { name: 'AVERAGE_PERIOD', value: 0 } } }, 'setNumberVector')
		return true
	})

	try {
		expect(await weatherCommander.setAveragePeriod(operationCoordinator, weather, 2, { timeout: 1000 })).toMatchObject(failedOperationResult('alert'))
	} finally {
		setAveragePeriod.mockRestore()
		withdraw()
	}
})

test('fails a pending command when the station disconnects', async () => {
	const weather = await connected()
	const setUpdatePeriod = spyOn(weatherManager, 'setUpdatePeriod').mockImplementation(() => true)

	try {
		const command = weatherCommander.setUpdatePeriod(operationCoordinator, weather, 45, { timeout: 1000 })
		await Bun.sleep(10)
		weatherManager.disconnect(weather)
		expect((await command).ok).toBeFalse()
	} finally {
		setUpdatePeriod.mockRestore()
	}
})

test('reports a disconnected station before dispatching a command', async () => {
	const weather = getWeather()
	const refresh = spyOn(weatherManager, 'refresh')
	const setUpdatePeriod = spyOn(weatherManager, 'setUpdatePeriod')

	try {
		const isolatedArbiter = new ResourceArbiter()
		isolatedArbiter.markAvailable({ key: resourceKey(weather), device: weather })
		const isolatedCoordinator = new OperationCoordinator(isolatedArbiter)
		expect(weather.connected).toBeFalse()
		expect(await weatherCommander.refresh(isolatedCoordinator, weather)).toMatchObject(failedOperationResult('disconnected'))
		expect(await weatherCommander.setUpdatePeriod(isolatedCoordinator, weather, 30)).toMatchObject(failedOperationResult('disconnected'))
		expect(refresh).not.toHaveBeenCalled()
		expect(setUpdatePeriod).not.toHaveBeenCalled()
	} finally {
		refresh.mockRestore()
		setUpdatePeriod.mockRestore()
	}
})

test('refuses a command while another operation owns the station', async () => {
	const weather = await connected()
	const held = operationCoordinator.start<void>(
		'hold',
		[{ key: resourceKey(weather), device: weather }],
		(context) =>
			new Promise((resolve) => {
				context.signal.addEventListener('abort', () => resolve(failedOperationResult('aborted')), { once: true })
			}),
	)

	expect(await weatherCommander.refresh(operationCoordinator, weather)).toMatchObject(failedOperationResult('busy'))
	await held.cancel()
	expect(isFree(weather)).toBeTrue()
})

test('stops observing the manager once disposed', () => {
	const commander = new WeatherCommander(weatherManager)
	const removeHandler = spyOn(weatherManager, 'removeHandler')

	try {
		commander.dispose()
		commander[Symbol.dispose]()
		expect(removeHandler).toHaveBeenCalledTimes(2)
		expect(removeHandler).toHaveBeenCalledWith(commander)
	} finally {
		removeHandler.mockRestore()
	}
})
