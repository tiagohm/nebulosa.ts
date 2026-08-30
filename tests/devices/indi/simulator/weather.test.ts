import { describe, expect, test } from 'bun:test'
import { DEG2RAD } from '../../../../src/core/constants'
import { IndiClientHandlerSet } from '../../../../src/devices/indi/client'
import type { DeviceProperty } from '../../../../src/devices/indi/device'
import { WeatherManager } from '../../../../src/devices/indi/manager/weather'
import { ClientSimulator } from '../../../../src/devices/indi/simulator/client'
import type { SimulatorProperty } from '../../../../src/devices/indi/simulator/types'
import { WeatherSimulator } from '../../../../src/devices/indi/simulator/weather'
import { waitUntil } from '../../../util'

function permissionOf(property: DeviceProperty) {
	return property.type === 'LIGHT' ? undefined : property.permission
}

function setup(name: string = 'Weather Simulator') {
	const handler = new IndiClientHandlerSet()
	const manager = new WeatherManager()
	handler.add(manager)
	const client = new ClientSimulator('weather', handler)
	const simulator = new WeatherSimulator(name, client)
	return { handler, manager, client, simulator }
}

describe('weather simulator', () => {
	test('advertises the weather interface before publishing any parameter', async () => {
		const { manager, client, simulator } = setup()

		await waitUntil(() => manager.has(client, simulator.name))

		const weather = manager.get(client, simulator.name)!
		expect(weather.type).toBe('weather')
		expect(weather.interfaces).toEqual(['weather'])
		expect(weather.connected).toBeFalse()

		// Sensors only exist once WEATHER_PARAMETERS arrives, which needs a connection.
		expect(manager.properties.get(weather)?.WEATHER_PARAMETERS).toBeUndefined()
		expect(weather.temperature).toBe(0)
		expect(weather.hasThermometer).toBeFalse()

		simulator.dispose()
		client[Symbol.dispose]()
	})

	test('publishes every sensor on connect and never defines SAFETY_STATUS', async () => {
		const { manager, client, simulator } = setup()

		simulator.connect()
		await waitUntil(() => manager.get(client, simulator.name)?.connected === true)

		const weather = manager.get(client, simulator.name)!
		expect(weather.cloudCover).toBe(15)
		expect(weather.dewPoint).toBe(6.9)
		expect(weather.humidity).toBe(52)
		expect(weather.pressure).toBe(1013.2)
		expect(weather.rainRate).toBe(0)
		expect(weather.skyBrightness).toBe(0.002)
		expect(weather.skyQuality).toBe(21.3)
		expect(weather.skyTemperature).toBe(-22.4)
		expect(weather.starFWHM).toBe(2.4)
		expect(weather.temperature).toBe(16.8)
		expect(weather.hasThermometer).toBeTrue()
		expect(weather.windDirection).toBeCloseTo(135 * DEG2RAD, 12)
		expect(weather.windGust).toBe(4.2)
		expect(weather.windSpeed).toBe(2.6)
		expect(weather.updatePeriod?.value).toBe(60)

		const properties = manager.properties.get(weather)!
		expect(properties.SAFETY_STATUS).toBeUndefined()
		expect(properties.WEATHER_STATUS.type).toBe('LIGHT')
		expect(permissionOf(properties.WEATHER_PARAMETERS)).toBe('ro')
		expect(permissionOf(properties.SIMULATOR_WEATHER)).toBe('rw')

		simulator.dispose()
		client[Symbol.dispose]()
	})

	test('propagates each simulator control to the public parameters', async () => {
		const { manager, client, simulator } = setup()

		simulator.connect()
		await waitUntil(() => manager.get(client, simulator.name)?.connected === true)

		const weather = manager.get(client, simulator.name)!

		expect(simulator.setParameter('WEATHER_CLOUD_COVER', 87.5)).toBeTrue()
		expect(simulator.setParameter('WEATHER_WIND_DIRECTION', 270)).toBeTrue()
		expect(simulator.setParameter('WEATHER_TEMPERATURE', -3.5)).toBeTrue()
		expect(simulator.setParameter('WEATHER_UNKNOWN', 1)).toBeFalse()

		await waitUntil(() => weather.cloudCover === 87.5)
		expect(weather.windDirection).toBeCloseTo(270 * DEG2RAD, 12)
		expect(weather.temperature).toBe(-3.5)

		// A control write must reach WEATHER_PARAMETERS without a refresh.
		expect(manager.properties.get(weather)!.WEATHER_PARAMETERS.elements.WEATHER_CLOUD_COVER.value).toBe(87.5)

		// Out-of-range writes are clamped to the advertised range.
		client.sendNumber({ device: simulator.name, name: 'SIMULATOR_WEATHER', elements: { WEATHER_HUMIDITY: 250 } })
		await waitUntil(() => weather.humidity === 100)

		simulator.dispose()
		client[Symbol.dispose]()
	})

	test('refresh re-emits the parameters and returns the switch to off', async () => {
		const { manager, client, simulator } = setup()

		simulator.connect()
		await waitUntil(() => manager.get(client, simulator.name)?.connected === true)

		const weather = manager.get(client, simulator.name)!
		const before = manager.lastUpdatedAt(weather)!
		expect(before).toBeGreaterThan(0)

		await Bun.sleep(5)
		client.sendSwitch({ device: simulator.name, name: 'WEATHER_REFRESH', elements: { REFRESH: true } })

		// No value moved, yet freshness advanced.
		expect(weather.cloudCover).toBe(15)
		expect(manager.lastUpdatedAt(weather)!).toBeGreaterThan(before)
		expect(manager.properties.get(weather)!.WEATHER_REFRESH.elements.REFRESH.value).toBeFalse()

		simulator.dispose()
		client[Symbol.dispose]()
	})

	test('emits no reading while the device is disconnected', async () => {
		const { handler, manager, client, simulator } = setup()

		simulator.connect()
		await waitUntil(() => manager.get(client, simulator.name)?.connected === true)

		const weather = manager.get(client, simulator.name)!
		expect(weather.temperature).toBe(16.8)

		simulator.disconnect()
		await waitUntil(() => manager.get(client, simulator.name)?.connected === false)

		expect(manager.properties.get(weather)?.WEATHER_PARAMETERS).toBeUndefined()
		expect(manager.lastUpdatedAt(weather)).toBeUndefined()

		// The properties went away with the connection. A forced refresh or a control write must not
		// repopulate the sensors and their freshness for a station reporting itself disconnected.
		simulator.setParameter('WEATHER_TEMPERATURE', 21.5)
		simulator.refresh()
		client.sendNumber({ device: simulator.name, name: 'SIMULATOR_WEATHER', elements: { WEATHER_HUMIDITY: 61 } })

		expect(manager.properties.get(weather)?.WEATHER_PARAMETERS).toBeUndefined()
		expect(manager.lastUpdatedAt(weather)).toBeUndefined()
		expect(weather.hasThermometer).toBeFalse()
		expect(weather.humidity).toBeUndefined()

		// The common controls are not deleted with the connection, so they must keep acknowledging their
		// writes: a client that mutates one and never sees the resulting state has no way to read it back.
		const emitted: string[] = []
		handler.add({ setTextVector: (_, message) => void emitted.push(message.name) })
		client.sendText({ device: simulator.name, name: 'ACTIVE_DEVICES', elements: { ACTIVE_TELESCOPE: 'Mount Simulator' } })

		expect(emitted).toContain('ACTIVE_DEVICES')

		// The controls kept the values, which is what the next connection publishes.
		simulator.connect()
		await waitUntil(() => manager.get(client, simulator.name)?.connected === true)

		expect(weather.temperature).toBe(21.5)
		expect(weather.humidity).toBe(61)
		expect(manager.lastUpdatedAt(weather)!).toBeGreaterThan(0)

		simulator.dispose()
		client[Symbol.dispose]()
	})

	test('stores the update period without scheduling a timer', async () => {
		const { manager, client, simulator } = setup()

		simulator.connect()
		await waitUntil(() => manager.get(client, simulator.name)?.connected === true)

		const weather = manager.get(client, simulator.name)!
		expect(manager.setUpdatePeriod(weather, 15)).toBeTrue()
		await waitUntil(() => weather.updatePeriod?.value === 15)
		expect(weather.updatePeriod!.min).toBe(1)
		expect(weather.updatePeriod!.max).toBe(3600)

		// Nothing must move on its own: a timer would repopulate the readings.
		const readings = manager.lastUpdatedAt(weather)!
		await Bun.sleep(150)
		expect(manager.lastUpdatedAt(weather)).toBe(readings)

		simulator.dispose()
		client[Symbol.dispose]()
	})

	test('rebuilds the public parameters from the persisted controls', async () => {
		const saved: SimulatorProperty[] = []
		const handler = new IndiClientHandlerSet()
		const manager = new WeatherManager()
		handler.add(manager)

		using client = new ClientSimulator('weather-persistence', handler)
		using simulator = new WeatherSimulator('Weather Simulator', client, {
			save: (_, properties) => {
				saved.length = 0
				for (const property of properties) saved.push(structuredClone(property))
			},
			load: () => saved,
		})

		simulator.connect()
		await waitUntil(() => manager.get(client, simulator.name)?.connected === true)

		const weather = manager.get(client, simulator.name)!
		simulator.setParameter('WEATHER_PRESSURE', 990.5)
		client.sendSwitch({ device: simulator.name, name: 'CONFIG', elements: { SAVE: true } })

		expect(saved.some((e) => e.name === 'SIMULATOR_WEATHER')).toBeTrue()
		expect(saved.some((e) => e.name === 'WEATHER_UPDATE')).toBeTrue()
		// Derived properties are excluded from persistence.
		expect(saved.some((e) => e.name === 'WEATHER_PARAMETERS')).toBeFalse()
		expect(saved.some((e) => e.name === 'WEATHER_STATUS')).toBeFalse()

		simulator.setParameter('WEATHER_PRESSURE', 1030)
		await waitUntil(() => weather.pressure === 1030)

		client.sendSwitch({ device: simulator.name, name: 'CONFIG', elements: { LOAD: true } })
		await waitUntil(() => weather.pressure === 990.5)
		expect(manager.properties.get(weather)!.WEATHER_PARAMETERS.elements.WEATHER_PRESSURE.value).toBe(990.5)
	})

	test('removes every property on disconnect and the device on dispose', async () => {
		const { manager, client, simulator } = setup()

		simulator.connect()
		await waitUntil(() => manager.get(client, simulator.name)?.connected === true)

		const weather = manager.get(client, simulator.name)!
		simulator.disconnect()
		await waitUntil(() => !weather.connected)

		const properties = manager.properties.get(weather)
		expect(properties?.WEATHER_PARAMETERS).toBeUndefined()
		expect(weather.cloudCover).toBeUndefined()
		expect(weather.hasThermometer).toBeFalse()
		expect(weather.updatePeriod).toBeUndefined()

		simulator.dispose()
		expect(manager.has(client, weather.name)).toBeFalse()
		client[Symbol.dispose]()
	})
})
