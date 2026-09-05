import { expect, test } from 'bun:test'
import { PIOVERTWO, TAU } from '../../../../src/core/constants'
import { DEFAULT_WEATHER, DeviceInterfaceType, isWeather } from '../../../../src/devices/indi/device'
import { SafetyMonitorManager } from '../../../../src/devices/indi/manager/safetymonitor'
import { WeatherManager } from '../../../../src/devices/indi/manager/weather'
import type { DefLightVector, DefNumber, DefNumberVector } from '../../../../src/devices/indi/types'
import { createRecordingClient, defNumber, defSwitch, driverInfo } from './util'

const { recordingClient, numberCommands, switchCommands } = createRecordingClient()

function weatherDevice(manager: WeatherManager, name: string = 'Weather', interfaceType: DeviceInterfaceType = DeviceInterfaceType.WEATHER) {
	manager.textVector(recordingClient, driverInfo(name, interfaceType), 'defTextVector')
	return manager.get(recordingClient, name)!
}

function weatherParameters(device: string, elements: Record<string, DefNumber>): DefNumberVector {
	return { device, name: 'WEATHER_PARAMETERS', permission: 'ro', state: 'Ok', elements }
}

test('creates the device from the interface bit alone, before any parameter', () => {
	const manager = new WeatherManager()
	const weather = weatherDevice(manager)

	expect(weather).toBeDefined()
	expect(weather.type).toBe('weather')
	expect(isWeather(weather)).toBeTrue()
	expect(weather.interfaces).toEqual(['weather'])
	expect(manager.properties.get(weather)?.WEATHER_PARAMETERS).toBeUndefined()
	expect(weather).not.toContainKey('cloudCover')
	expect(manager.lastUpdatedAt(weather)).toBeUndefined()
})

test('reports weather alongside the other interfaces of a multi-interface driver', () => {
	const manager = new WeatherManager()
	const weather = weatherDevice(manager, 'Station', DeviceInterfaceType.WEATHER | DeviceInterfaceType.DOME)

	expect(weather.interfaces).toEqual(['dome', 'weather'])
	expect(weather.hardwareId).toBe(Bun.MD5.hash(`${recordingClient.id}:Station`, 'hex'))
})

test('maps every sensor and leaves unreported ones absent', () => {
	const manager = new WeatherManager()
	const weather = weatherDevice(manager)

	manager.numberVector(
		recordingClient,
		weatherParameters(weather.name, {
			WEATHER_CLOUD_COVER: defNumber('WEATHER_CLOUD_COVER', 42, 0, 100),
			WEATHER_DEW_POINT: defNumber('WEATHER_DEW_POINT', 4.5, -60, 60),
			WEATHER_HUMIDITY: defNumber('WEATHER_HUMIDITY', 61, 0, 100),
			WEATHER_PRESSURE: defNumber('WEATHER_PRESSURE', 1008.4, 0, 2000),
			WEATHER_RAIN_HOUR: defNumber('WEATHER_RAIN_HOUR', 1.5, 0, 500),
			WEATHER_SKY_BRIGHTNESS: defNumber('WEATHER_SKY_BRIGHTNESS', 0.01, 0, 1000),
			WEATHER_SKY_QUALITY: defNumber('WEATHER_SKY_QUALITY', 20.8, 0, 25),
			WEATHER_SKY_TEMPERATURE: defNumber('WEATHER_SKY_TEMPERATURE', -18.2, -100, 60),
			WEATHER_STAR_FWHM: defNumber('WEATHER_STAR_FWHM', 3.1, 0, 60),
			WEATHER_TEMPERATURE: defNumber('WEATHER_TEMPERATURE', 12.25, -60, 60),
			WEATHER_WIND_GUST: defNumber('WEATHER_WIND_GUST', 9.4, 0, 100),
			WEATHER_WIND_SPEED: defNumber('WEATHER_WIND_SPEED', 5.2, 0, 100),
		}),
		'defNumberVector',
	)

	expect(weather.cloudCover).toBe(42)
	expect(weather.dewPoint).toBe(4.5)
	expect(weather.humidity).toBe(61)
	expect(weather.pressure).toBe(1008.4)
	expect(weather.rainRate).toBe(1.5)
	expect(weather.skyBrightness).toBe(0.01)
	expect(weather.skyQuality).toBe(20.8)
	expect(weather.skyTemperature).toBe(-18.2)
	expect(weather.starFWHM).toBe(3.1)
	expect(weather.temperature).toBe(12.25)
	expect(weather.hasThermometer).toBeTrue()
	expect(weather.windGust).toBe(9.4)
	expect(weather.windSpeed).toBe(5.2)

	// Not reported by this driver.
	expect(weather).not.toContainKey('windDirection')
})

test('accepts the alias element names used by common drivers', () => {
	const manager = new WeatherManager()
	const weather = weatherDevice(manager)

	const parameters = weatherParameters(weather.name, {
		WEATHER_CLOUD: defNumber('WEATHER_CLOUD', 33, 0, 100),
		WEATHER_DEWPOINT: defNumber('WEATHER_DEWPOINT', 2.5, -60, 60),
		WEATHER_RELATIVE_HUMIDITY: defNumber('WEATHER_RELATIVE_HUMIDITY', 70, 0, 100),
		WEATHER_RAIN_RATE: defNumber('WEATHER_RAIN_RATE', 12, 0, 500),
		WEATHER_SQM: defNumber('WEATHER_SQM', 19.5, 0, 25),
		WEATHER_SEEING: defNumber('WEATHER_SEEING', 4.2, 0, 60),
		WEATHER_UNMAPPED: defNumber('WEATHER_UNMAPPED', 7, 0, 100),
	})

	manager.vector(recordingClient, parameters, 'defNumberVector')
	manager.numberVector(recordingClient, parameters, 'defNumberVector')

	expect(weather.cloudCover).toBe(33)
	expect(weather.dewPoint).toBe(2.5)
	expect(weather.humidity).toBe(70)
	expect(weather.rainRate).toBe(12)
	expect(weather.skyQuality).toBe(19.5)
	expect(weather.starFWHM).toBe(4.2)

	// An unmapped element stays reachable as a raw property but never reaches the typed interface.
	expect(manager.properties.get(weather)!.WEATHER_PARAMETERS.elements.WEATHER_UNMAPPED.value).toBe(7)
})

test('converts wind direction from degrees to normalized radians', () => {
	const manager = new WeatherManager()
	const weather = weatherDevice(manager)

	manager.numberVector(recordingClient, weatherParameters(weather.name, { WEATHER_WIND_DIRECTION: defNumber('WEATHER_WIND_DIRECTION', 90) }), 'defNumberVector')
	expect(weather.windDirection).toBeCloseTo(PIOVERTWO, 12)

	manager.numberVector(recordingClient, weatherParameters(weather.name, { WEATHER_WIND_DIRECTION: defNumber('WEATHER_WIND_DIRECTION', 360) }), 'setNumberVector')
	expect(weather.windDirection).toBe(0)

	manager.numberVector(recordingClient, weatherParameters(weather.name, { WEATHER_WIND_DIRECTION: defNumber('WEATHER_WIND_DIRECTION', -90) }), 'setNumberVector')
	expect(weather.windDirection).toBeCloseTo(TAU - PIOVERTWO, 12)
})

test('never clamps a reading to the alarm thresholds carried by min/max', () => {
	const manager = new WeatherManager()
	const weather = weatherDevice(manager)

	// INDI addParameter(name, label, min, max, percentWarning): min/max are the alarm limits, so a
	// reading outside them is exactly the one that must survive intact.
	manager.numberVector(
		recordingClient,
		weatherParameters(weather.name, {
			WEATHER_WIND_SPEED: defNumber('WEATHER_WIND_SPEED', 34.5, 0, 20),
			WEATHER_TEMPERATURE: defNumber('WEATHER_TEMPERATURE', -12, 0, 40),
		}),
		'defNumberVector',
	)

	expect(weather.windSpeed).toBe(34.5)
	expect(weather.temperature).toBe(-12)
})

test('notifies only the field that changed', () => {
	const manager = new WeatherManager()
	const weather = weatherDevice(manager)
	const updates: string[] = []

	manager.addHandler({ added: () => {}, removed: () => {}, updated: (_, property) => updates.push(property) })

	manager.numberVector(recordingClient, weatherParameters(weather.name, { WEATHER_HUMIDITY: defNumber('WEATHER_HUMIDITY', 50, 0, 100), WEATHER_PRESSURE: defNumber('WEATHER_PRESSURE', 1000, 0, 2000) }), 'defNumberVector')
	expect(updates).toEqual(['humidity', 'pressure'])

	updates.length = 0
	manager.numberVector(recordingClient, weatherParameters(weather.name, { WEATHER_HUMIDITY: defNumber('WEATHER_HUMIDITY', 50, 0, 100), WEATHER_PRESSURE: defNumber('WEATHER_PRESSURE', 1001, 0, 2000) }), 'setNumberVector')
	expect(updates).toEqual(['pressure'])
})

test('clears the sensors a replacement definition no longer declares', () => {
	const manager = new WeatherManager()
	const weather = weatherDevice(manager)
	const updates: string[] = []

	manager.numberVector(
		recordingClient,
		weatherParameters(weather.name, {
			WEATHER_TEMPERATURE: defNumber('WEATHER_TEMPERATURE', 12.25, -60, 60),
			WEATHER_HUMIDITY: defNumber('WEATHER_HUMIDITY', 61, 0, 100),
			WEATHER_PRESSURE: defNumber('WEATHER_PRESSURE', 1008.4, 0, 2000),
		}),
		'defNumberVector',
	)

	expect(weather.humidity).toBe(61)
	expect(manager.updatedAt(weather, 'humidity')).toBeGreaterThan(0)

	manager.addHandler({ added: () => {}, removed: () => {}, updated: (_, property) => updates.push(property) })

	// The driver redefines the vector without its hygrometer, so the reading and its freshness must go
	// with it instead of outliving the definition that produced them.
	manager.numberVector(
		recordingClient,
		weatherParameters(weather.name, {
			WEATHER_TEMPERATURE: defNumber('WEATHER_TEMPERATURE', 12.25, -60, 60),
			WEATHER_PRESSURE: defNumber('WEATHER_PRESSURE', 1009.1, 0, 2000),
		}),
		'defNumberVector',
	)

	expect(weather.humidity).toBeUndefined()
	expect(manager.updatedAt(weather, 'humidity')).toBeUndefined()
	expect(updates).toEqual(['humidity', 'pressure'])

	// The surviving sensors keep their readings and freshness.
	expect(weather.temperature).toBe(12.25)
	expect(weather.hasThermometer).toBeTrue()
	expect(weather.pressure).toBe(1009.1)
	expect(manager.updatedAt(weather, 'temperature')).toBeGreaterThan(0)

	// A set vector is a partial update: reporting one parameter must not withdraw the others.
	updates.length = 0
	manager.numberVector(recordingClient, weatherParameters(weather.name, { WEATHER_PRESSURE: defNumber('WEATHER_PRESSURE', 1010, 0, 2000) }), 'setNumberVector')

	expect(weather.temperature).toBe(12.25)
	expect(weather.pressure).toBe(1010)
	expect(updates).toEqual(['pressure'])

	// Dropping the thermometer restores the capability default rather than leaving a stale reading.
	manager.numberVector(recordingClient, weatherParameters(weather.name, { WEATHER_PRESSURE: defNumber('WEATHER_PRESSURE', 1010, 0, 2000) }), 'defNumberVector')

	expect(weather.hasThermometer).toBeFalse()
	expect(weather.temperature).toBe(0)
	expect(manager.updatedAt(weather, 'temperature')).toBeUndefined()
})

test('ignores the placeholder values of a Busy definition', () => {
	const manager = new WeatherManager()
	const weather = weatherDevice(manager)

	// The Firmata adapter defines its weather vector Busy with zero placeholders before the first
	// hardware reply, then settles it to Idle on the first real sample.
	const placeholders = weatherParameters(weather.name, {
		WEATHER_TEMPERATURE: defNumber('WEATHER_TEMPERATURE', 0, -55, 125),
		WEATHER_HUMIDITY: defNumber('WEATHER_HUMIDITY', 0, 0, 100),
		WEATHER_PRESSURE: defNumber('WEATHER_PRESSURE', 0, 0, 2000),
	})

	placeholders.state = 'Busy'
	manager.numberVector(recordingClient, placeholders, 'defNumberVector')

	expect(weather).not.toContainKey('humidity')
	expect(weather).not.toContainKey('pressure')
	expect(weather.hasThermometer).toBeFalse()
	expect(manager.updatedAt(weather, 'temperature')).toBeUndefined()
	expect(manager.lastUpdatedAt(weather)).toBeUndefined()

	const readings = weatherParameters(weather.name, {
		WEATHER_TEMPERATURE: defNumber('WEATHER_TEMPERATURE', 21.5, -55, 125),
		WEATHER_HUMIDITY: defNumber('WEATHER_HUMIDITY', 47, 0, 100),
		WEATHER_PRESSURE: defNumber('WEATHER_PRESSURE', 1011.8, 0, 2000),
	})

	readings.state = 'Idle'
	manager.numberVector(recordingClient, readings, 'setNumberVector')

	expect(weather.temperature).toBe(21.5)
	expect(weather.humidity).toBe(47)
	expect(weather.pressure).toBe(1011.8)
	expect(weather.hasThermometer).toBeTrue()
	expect(manager.updatedAt(weather, 'temperature')).toBeGreaterThan(0)
})

test('advances freshness even when the driver repeats a value', async () => {
	const manager = new WeatherManager()
	const weather = weatherDevice(manager)
	const parameters = weatherParameters(weather.name, { WEATHER_TEMPERATURE: defNumber('WEATHER_TEMPERATURE', 10, -60, 60) })

	manager.numberVector(recordingClient, parameters, 'defNumberVector')
	const first = manager.updatedAt(weather, 'temperature')!
	expect(first).toBeGreaterThan(0)
	expect(manager.updatedAt(weather, 'humidity')).toBeUndefined()
	expect(manager.lastUpdatedAt(weather)).toBe(first)

	await Bun.sleep(5)
	manager.numberVector(recordingClient, parameters, 'setNumberVector')

	expect(weather.temperature).toBe(10)
	expect(manager.updatedAt(weather, 'temperature')!).toBeGreaterThan(first)
})

test('does not date a failed report as an observation', async () => {
	const manager = new WeatherManager()
	const weather = weatherDevice(manager)

	// The driver's very first hardware read fails, so it applies the vector in Alert with the declared
	// defaults. The declaration counts, the placeholder reading does not.
	const failed = weatherParameters(weather.name, { WEATHER_TEMPERATURE: defNumber('WEATHER_TEMPERATURE', 0, -60, 60) })
	failed.state = 'Alert'
	manager.numberVector(recordingClient, failed, 'defNumberVector')

	expect(weather.hasThermometer).toBeTrue()
	expect(manager.updatedAt(weather, 'temperature')).toBeUndefined()
	expect(manager.lastUpdatedAt(weather)).toBeUndefined()
	expect(manager.elapsedSince(weather, 'temperature')).toBeUndefined()

	const parameters = weatherParameters(weather.name, { WEATHER_TEMPERATURE: defNumber('WEATHER_TEMPERATURE', 10, -60, 60) })
	manager.numberVector(recordingClient, parameters, 'setNumberVector')

	const first = manager.updatedAt(weather, 'temperature')!
	expect(weather.temperature).toBe(10)
	expect(first).toBeGreaterThan(0)

	await Bun.sleep(5)

	// A later failure restates the previous readings, and the driver retries every five seconds: the
	// value survives, but the sensor did not report and its age has to keep growing.
	failed.elements.WEATHER_TEMPERATURE.value = 11
	manager.numberVector(recordingClient, failed, 'setNumberVector')

	expect(weather.temperature).toBe(11)
	expect(manager.updatedAt(weather, 'temperature')).toBe(first)
	expect(manager.lastUpdatedAt(weather)).toBe(first)
	expect(manager.elapsedSince(weather, 'temperature')!).toBeGreaterThanOrEqual(5)

	// The next successful read dates it again.
	manager.numberVector(recordingClient, parameters, 'setNumberVector')

	expect(manager.updatedAt(weather, 'temperature')!).toBeGreaterThan(first)
})

test('measures sensor age on the monotonic clock', async () => {
	const manager = new WeatherManager()
	const weather = weatherDevice(manager)
	const parameters = weatherParameters(weather.name, { WEATHER_TEMPERATURE: defNumber('WEATHER_TEMPERATURE', 10, -60, 60) })

	expect(manager.elapsedSince(weather, 'temperature')).toBeUndefined()
	expect(manager.lastElapsedSince(weather)).toBeUndefined()

	const now = Date.now

	try {
		Date.now = () => now() - 3_600_000
		manager.numberVector(recordingClient, parameters, 'defNumberVector')
	} finally {
		Date.now = now
	}

	expect(manager.updatedAt(weather, 'humidity')).toBeUndefined()
	expect(manager.elapsedSince(weather, 'humidity')).toBeUndefined()

	expect(manager.updatedAt(weather, 'temperature')!).toBeLessThan(Date.now() - 3_000_000)
	expect(manager.elapsedSince(weather, 'temperature')!).toBeLessThan(1000)
	expect(manager.lastElapsedSince(weather)!).toBeLessThan(1000)

	await Bun.sleep(5)

	expect(manager.elapsedSince(weather, 'temperature')!).toBeGreaterThanOrEqual(5)
	expect(manager.lastElapsedSince(weather)!).toBeGreaterThanOrEqual(5)
})

test('dates the newest report by the monotonic clock', async () => {
	const manager = new WeatherManager()
	const weather = weatherDevice(manager)

	manager.numberVector(recordingClient, weatherParameters(weather.name, { WEATHER_TEMPERATURE: defNumber('WEATHER_TEMPERATURE', 10, -60, 60), WEATHER_HUMIDITY: defNumber('WEATHER_HUMIDITY', 50, 0, 100) }), 'defNumberVector')

	const first = manager.updatedAt(weather, 'temperature')!
	expect(manager.lastUpdatedAt(weather)).toBe(first)

	await Bun.sleep(5)

	// The system clock is corrected an hour backward and only the hygrometer reports afterwards: the
	// temperature keeps the numerically larger pre-correction epoch even though it is the older
	// reading.
	const now = Date.now

	try {
		Date.now = () => now() - 3_600_000
		manager.numberVector(recordingClient, weatherParameters(weather.name, { WEATHER_HUMIDITY: defNumber('WEATHER_HUMIDITY', 51, 0, 100) }), 'setNumberVector')
	} finally {
		Date.now = now
	}

	const humidity = manager.updatedAt(weather, 'humidity')!
	expect(humidity).toBeLessThan(first)
	expect(manager.lastUpdatedAt(weather)).toBe(humidity)
})

test('accepts a partial parameter vector from an auxiliary sensor board', () => {
	const manager = new WeatherManager()
	const weather = weatherDevice(manager, 'Sensor', DeviceInterfaceType.WEATHER | DeviceInterfaceType.AUXILIARY)

	manager.numberVector(
		recordingClient,
		weatherParameters(weather.name, {
			WEATHER_TEMPERATURE: defNumber('WEATHER_TEMPERATURE', 21.5, -55, 125),
			WEATHER_HUMIDITY: defNumber('WEATHER_HUMIDITY', 44.5, 0, 100),
			WEATHER_PRESSURE: defNumber('WEATHER_PRESSURE', 1002.25, 0, 2000),
		}),
		'defNumberVector',
	)

	expect(weather.interfaces).toEqual(['weather'])
	expect(weather.temperature).toBe(21.5)
	expect(weather.hasThermometer).toBeTrue()
	expect(weather.humidity).toBe(44.5)
	expect(weather.pressure).toBe(1002.25)
	expect(weather).not.toContainKey('windSpeed')
})

test('reflects and commands the update and average periods', () => {
	const manager = new WeatherManager()
	const weather = weatherDevice(manager)

	expect(weather.updatePeriod).toBeUndefined()
	expect(manager.setUpdatePeriod(weather, 30)).toBeFalse()
	expect(manager.setAveragePeriod(weather, 1)).toBeFalse()

	manager.numberVector(recordingClient, { device: weather.name, name: 'WEATHER_UPDATE', permission: 'rw', state: 'Ok', elements: { PERIOD: defNumber('PERIOD', 60, 1, 3600) } }, 'defNumberVector')
	expect(weather.updatePeriod).toEqual({ value: 60, min: 1, max: 3600, step: 1 })

	manager.numberVector(recordingClient, { device: weather.name, name: 'WEATHER_AVERAGE_PERIOD', permission: 'rw', state: 'Ok', elements: { AVERAGE_PERIOD: defNumber('AVERAGE_PERIOD', 0.5, 0, 24) } }, 'defNumberVector')
	expect(weather.averagePeriod).toBe(0.5)

	numberCommands.length = 0
	expect(manager.setUpdatePeriod(weather, 30)).toBeTrue()
	expect(manager.setAveragePeriod(weather, 2)).toBeTrue()
	expect(numberCommands).toEqual([
		{ device: weather.name, name: 'WEATHER_UPDATE', elements: { PERIOD: 30 } },
		{ device: weather.name, name: 'WEATHER_AVERAGE_PERIOD', elements: { AVERAGE_PERIOD: 2 } },
	])

	// A read-only redefinition withdraws the command.
	manager.numberVector(recordingClient, { device: weather.name, name: 'WEATHER_UPDATE', permission: 'ro', state: 'Ok', elements: { PERIOD: defNumber('PERIOD', 60, 1, 3600) } }, 'defNumberVector')
	expect(manager.setUpdatePeriod(weather, 30)).toBeFalse()
})

test('commands refresh only when the driver offers a writable switch', () => {
	const manager = new WeatherManager()
	const weather = weatherDevice(manager)

	expect(manager.refresh(weather)).toBeFalse()

	manager.switchVector(recordingClient, { device: weather.name, name: 'WEATHER_REFRESH', permission: 'rw', rule: 'AtMostOne', state: 'Idle', elements: { REFRESH: defSwitch('REFRESH', false) } }, 'defSwitchVector')

	switchCommands.length = 0
	expect(manager.refresh(weather)).toBeTrue()
	expect(switchCommands).toEqual([{ device: weather.name, name: 'WEATHER_REFRESH', elements: { REFRESH: true } }])
})

test('clears the sensors on a named deletion but keeps the device', () => {
	const manager = new WeatherManager()
	const weather = weatherDevice(manager)

	manager.numberVector(recordingClient, weatherParameters(weather.name, { WEATHER_TEMPERATURE: defNumber('WEATHER_TEMPERATURE', 9, -60, 60), WEATHER_HUMIDITY: defNumber('WEATHER_HUMIDITY', 80, 0, 100) }), 'defNumberVector')
	manager.numberVector(recordingClient, { device: weather.name, name: 'WEATHER_UPDATE', permission: 'rw', state: 'Ok', elements: { PERIOD: defNumber('PERIOD', 60, 1, 3600) } }, 'defNumberVector')

	manager.delProperty(recordingClient, { device: weather.name, name: 'WEATHER_PARAMETERS' })

	expect(manager.has(recordingClient, weather.name)).toBeTrue()
	expect(weather.humidity).toBeUndefined()
	expect(weather.temperature).toBe(DEFAULT_WEATHER.temperature)
	expect(weather.hasThermometer).toBeFalse()
	expect(manager.lastUpdatedAt(weather)).toBeUndefined()
	expect(weather.updatePeriod).toBeDefined()

	manager.delProperty(recordingClient, { device: weather.name, name: 'WEATHER_UPDATE' })
	expect(weather.updatePeriod).toBeUndefined()
	expect(manager.setUpdatePeriod(weather, 30)).toBeFalse()

	manager.delProperty(recordingClient, { device: weather.name })
	expect(manager.has(recordingClient, weather.name)).toBeFalse()
})

test('does not turn a weather status light into a safety monitor', () => {
	const manager = new WeatherManager()
	const safetyManager = new SafetyMonitorManager(manager)
	const weather = weatherDevice(manager)

	const status: DefLightVector = { device: weather.name, name: 'WEATHER_STATUS', state: 'Alert', elements: { WEATHER_TEMPERATURE: { name: 'WEATHER_TEMPERATURE', value: 'Alert' } } }
	safetyManager.lightVector(recordingClient, status, 'defLightVector')

	expect(safetyManager.get(recordingClient, weather.name)).toBeUndefined()
	expect(weather).not.toContainKey('safe')
})
