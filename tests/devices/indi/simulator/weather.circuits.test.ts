import { describe, expect, test } from 'bun:test'
import { SafetyMonitorCondition } from '../../../../src/devices/indi/simulator/safetymonitor.condition'
import { WeatherAlarms, weatherThresholdState } from '../../../../src/devices/indi/simulator/weather.alarms'
import { DEFAULT_WEATHER_SIMULATOR_CONFIG, weatherSimulatorConfig } from '../../../../src/devices/indi/simulator/weather.config'
import { WeatherSensors } from '../../../../src/devices/indi/simulator/weather.sensors'
import { TestBus } from '../../../util/bus'

describe('weather thresholds', () => {
	test('warn near a limit and alarm past it', () => {
		const wind = { maximum: 10, margin: 2 }
		expect(weatherThresholdState(5, wind)).toBe('Ok')
		expect(weatherThresholdState(8.5, wind)).toBe('Busy')
		expect(weatherThresholdState(10, wind)).toBe('Busy')
		expect(weatherThresholdState(10.1, wind)).toBe('Alert')
		// A limit without margin, as for rain, alarms only past it.
		expect(weatherThresholdState(0, { maximum: 0, margin: 0 })).toBe('Ok')
		expect(weatherThresholdState(0.1, { maximum: 0, margin: 0 })).toBe('Alert')
		expect(weatherThresholdState(-1, { minimum: 0, margin: 2 })).toBe('Alert')
		expect(weatherThresholdState(1, { minimum: 0, margin: 2 })).toBe('Busy')
	})

	test('light only the critical sensors, the parameters taking the worst', () => {
		const bus = new TestBus()
		const config = weatherSimulatorConfig({ thresholds: { WEATHER_WIND_SPEED: { maximum: 10, margin: 2 } } })
		const alarms = new WeatherAlarms(bus, config)
		const sensors = new WeatherSensors(bus, config, alarms)

		expect(Object.keys(alarms.properties[0].elements)).toEqual(['WEATHER_CLOUD_COVER', 'WEATHER_HUMIDITY', 'WEATHER_RAIN_HOUR', 'WEATHER_WIND_GUST', 'WEATHER_WIND_SPEED'])
		expect(Object.values(alarms.properties[0].elements).every((e) => e.value === 'Ok')).toBeTrue()

		sensors.setParameter('WEATHER_WIND_SPEED', 9)
		expect(alarms.properties[0].elements.WEATHER_WIND_SPEED.value).toBe('Busy')
		expect(sensors.properties[0].state).toBe('Busy')

		sensors.setParameter('WEATHER_RAIN_HOUR', 2)
		expect(alarms.properties[0].state).toBe('Alert')
		expect(sensors.properties[0].state).toBe('Alert')

		sensors.setParameter('WEATHER_RAIN_HOUR', 0)
		sensors.setParameter('WEATHER_WIND_SPEED', 3)
		expect(sensors.properties[0].state).toBe('Ok')
	})

	test('publish the lights only when one changes', () => {
		const bus = new TestBus()
		const alarms = new WeatherAlarms(bus, DEFAULT_WEATHER_SIMULATOR_CONFIG)

		alarms.evaluate(DEFAULT_WEATHER_SIMULATOR_CONFIG.readings)
		expect(bus.take()).toEqual(['WEATHER_STATUS'])
		alarms.evaluate(DEFAULT_WEATHER_SIMULATOR_CONFIG.readings)
		expect(bus.take()).toEqual([])
		alarms.evaluate({ ...DEFAULT_WEATHER_SIMULATOR_CONFIG.readings, WEATHER_CLOUD_COVER: 25 })
		expect(bus.take()).toEqual(['WEATHER_STATUS'])
	})
})

describe('weather sensors', () => {
	test('re-read once every update period from the first tick', () => {
		const bus = new TestBus()
		const alarms = new WeatherAlarms(bus, DEFAULT_WEATHER_SIMULATOR_CONFIG)
		const sensors = new WeatherSensors(bus, DEFAULT_WEATHER_SIMULATOR_CONFIG, alarms)

		sensors.tick(0)
		bus.take()
		sensors.tick(59999)
		expect(bus.take()).toEqual([])
		sensors.tick(60000)
		expect(bus.take()).toContain('WEATHER_PARAMETERS')

		// A refresh is a read too, so the period restarts from it.
		bus.time = 70000
		sensors.refresh()
		bus.take()
		sensors.tick(120000)
		expect(bus.take()).toEqual([])
		sensors.tick(130000)
		expect(bus.take()).toContain('WEATHER_PARAMETERS')
	})
})

describe('safety condition', () => {
	test('maps each condition to its light and starts fail-closed', () => {
		const bus = new TestBus()
		const condition = new SafetyMonitorCondition(bus, { condition: 'UNKNOWN' })
		const status = condition.properties[0]

		expect(status.state).toBe('Idle')
		condition.setCondition('SAFE')
		expect(status.state).toBe('Ok')
		condition.handleSwitch({ device: '', name: 'SIMULATOR_SAFETY', elements: { WARNING: true } })
		expect(status.state).toBe('Busy')
		expect(condition.condition).toBe('WARNING')
		condition.setCondition('UNSAFE')
		expect(status.state).toBe('Alert')
	})

	test('powers up in the configured condition', () => {
		const condition = new SafetyMonitorCondition(new TestBus(), { condition: 'SAFE' })
		expect(condition.properties[0].state).toBe('Ok')
		expect(condition.condition).toBe('SAFE')
	})
})
