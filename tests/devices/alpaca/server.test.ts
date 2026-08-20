import { describe, expect, test } from 'bun:test'
import { Jpeg } from '../../../src/bindings/imaging/libturbojpeg'
import { makeImageBytesFromFits } from '../../../src/devices/alpaca/server'
import { type AlpacaConfiguredDevice, AlpacaException, AlpacaImageElementType, type AlpacaStateItem } from '../../../src/devices/alpaca/types'
import type { Device } from '../../../src/devices/indi/device'
import type { DeviceManager } from '../../../src/devices/indi/manager'
import type { DeviceSimulator } from '../../../src/devices/indi/simulator/device'
import { bitpixInBytes } from '../../../src/io/formats/fits/util'
import { downloadPerTag } from '../../download'
import { saveAndCompareHash } from '../../imaging/util'
import { waitUntil } from '../../util'
import { ALPACA_CAMERA, ALPACA_COVER, ALPACA_DOME, ALPACA_FLAT_PANEL, ALPACA_FOCUSER, ALPACA_MOUNT, ALPACA_ROTATOR, ALPACA_SAFETY_MONITOR, ALPACA_WEATHER, ALPACA_WHEEL, type AlpacaTestDevice, type AlpacaWeatherServer, startAlpacaServer, withdrawWeatherSensors } from './util'

await downloadPerTag('alpaca.server')

test('image bytes metadata header encodes version, rank, and dimensions', async () => {
	// Mono (NAXIS3 absent) -> rank 2, third dimension 0; color -> rank 3, third dimension 3.
	for (const channel of [1, 3]) {
		const buffer = await Bun.file(`data/NGC3372-16.${channel}.fit`).arrayBuffer()
		const bytes = makeImageBytesFromFits(Buffer.from(buffer))

		expect(bytes.readInt32LE(0)).toBe(1) // metadata version
		expect(bytes.readInt32LE(4)).toBe(0) // error number
		expect(bytes.readInt32LE(16)).toBe(44) // data start offset (44 for 16-bit)
		expect(bytes.readInt32LE(28)).toBe(channel === 1 ? 2 : 3) // rank
		expect(bytes.readInt32LE(32)).toBe(1037) // first dimension
		expect(bytes.readInt32LE(36)).toBe(706) // second dimension
		expect(bytes.readInt32LE(40)).toBe(channel === 1 ? 0 : 3) // third dimension
	}
})

test('image bytes metadata aligns 64-bit payloads', async () => {
	const buffer = await Bun.file('data/NGC3372--64.1.fit').arrayBuffer()
	const bytes = makeImageBytesFromFits(Buffer.from(buffer))

	expect(bytes.readInt32LE(16)).toBe(48) // 64-bit payloads start on an 8-byte boundary.
	expect(bytes.readInt32LE(24)).toBe(AlpacaImageElementType.Double)
	expect(bytes.byteLength - 48).toBe(1037 * 706 * bitpixInBytes(-64))
})

test('make image bytes from fits', async () => {
	const jpeg = new Jpeg()
	const output = Buffer.allocUnsafe(jpeg.estimateBufferSize(706, 1037, '4:4:4'))

	for (const bitpix of [8, 16]) {
		for (const channel of [1, 3]) {
			const buffer = await Bun.file(`data/NGC3372-${bitpix}.${channel}.fit`).arrayBuffer()
			const bytes = makeImageBytesFromFits(Buffer.from(buffer)).subarray(44)
			expect(bytes.byteLength).toBe(channel * 1037 * 706 * bitpixInBytes(bitpix))

			if (bitpix === 16) for (let i = 1, k = 0; i < bytes.byteLength; i += 2, k++) bytes[k] = bytes[i] + (bytes[i - 1] >>> 8)

			if (channel === 1) {
				const hash = bitpix === 8 ? 'a893bd416ad767923730a05aff9717b0' : 'afe683cfb71daa3df1de985c4d5f2090'
				await saveAndCompareHash(jpeg.compress(bytes, 706, 1037, 'GRAY', 100, 'GRAY', output)!, `imagebytesfromfits-${bitpix}-1.jpg`, hash)
			} else {
				const hash = bitpix === 8 ? 'b35a4a24e3f51a725288ea8edf6e215f' : '643a16c1c94fabb47b0823f88a3abdfd'
				await saveAndCompareHash(jpeg.compress(bytes, 706, 1037, 'RGB', 100, '4:4:4', output)!, `imagebytesfromfits-${bitpix}-3.jpg`, hash)
			}
		}
	}
}, 5000)

describe('observing conditions server', () => {
	test('lists the station in the management API with interface version 2', async () => {
		await using fixture = await startAlpacaServer(ALPACA_WEATHER)

		const configured = (await fixture.get('/management/v1/configureddevices')).Value as AlpacaConfiguredDevice[]
		const station = configured.find((e) => e.DeviceType === 'observingconditions')!

		expect(station).toBeDefined()
		expect(station.DeviceName).toBe('Weather Simulator')
		expect(station.UniqueID).toBe(fixture.device.id)

		const version = await fixture.get(`/api/v1/observingconditions/${fixture.deviceNumber}/interfaceversion`)
		expect(version.ErrorNumber).toBe(0)
		expect(version.Value).toBe(2)
	})

	test('serves every sensor in ASCOM units', async () => {
		await using fixture = await startAlpacaServer(ALPACA_WEATHER)
		const base = fixture.path

		expect((await fixture.get(`${base}/cloudcover`)).Value).toBe(15)
		expect((await fixture.get(`${base}/dewpoint`)).Value).toBe(6.9)
		expect((await fixture.get(`${base}/humidity`)).Value).toBe(52)
		expect((await fixture.get(`${base}/pressure`)).Value).toBe(1013.2)
		expect((await fixture.get(`${base}/rainrate`)).Value).toBe(0)
		expect((await fixture.get(`${base}/skybrightness`)).Value).toBe(0.002)
		expect((await fixture.get(`${base}/skyquality`)).Value).toBe(21.3)
		expect((await fixture.get(`${base}/skytemperature`)).Value).toBe(-22.4)
		expect((await fixture.get(`${base}/starfwhm`)).Value).toBe(2.4)
		expect((await fixture.get(`${base}/temperature`)).Value).toBe(16.8)
		expect((await fixture.get(`${base}/windgust`)).Value).toBe(4.2)
		expect((await fixture.get(`${base}/windspeed`)).Value).toBe(2.6)

		// Radians in, degrees out.
		expect((await fixture.get(`${base}/winddirection`)).Value as number).toBeCloseTo(135, 9)
	})

	test('follows the ASCOM wind direction convention for north and calm', async () => {
		await using fixture = await startAlpacaServer(ALPACA_WEATHER)
		const base = fixture.path

		// North is reported as 360, because 0 is reserved for calm air.
		fixture.simulator.setParameter('WEATHER_WIND_DIRECTION', 0)
		await waitUntil(() => fixture.device.windDirection === 0)
		expect((await fixture.get(`${base}/winddirection`)).Value).toBe(360)

		// With no wind there is no direction, and 0 is the ASCOM way of saying so.
		fixture.simulator.setParameter('WEATHER_WIND_SPEED', 0)
		await waitUntil(() => fixture.device.windSpeed === 0)
		expect((await fixture.get(`${base}/winddirection`)).Value).toBe(0)

		fixture.simulator.setParameter('WEATHER_WIND_DIRECTION', 270)
		fixture.simulator.setParameter('WEATHER_WIND_SPEED', 3)
		await waitUntil(() => fixture.device.windSpeed === 3)
		expect((await fixture.get(`${base}/winddirection`)).Value as number).toBeCloseTo(270, 9)
	})

	test('reports an unreported sensor as not implemented', async () => {
		await using fixture = await startAlpacaServer(ALPACA_WEATHER)
		const base = fixture.path

		fixture.manager.delProperty(fixture.indiClient, { device: fixture.simulator.name, name: 'WEATHER_PARAMETERS' })

		const response = await fixture.get(`${base}/cloudcover`)
		expect(response.ErrorNumber).toBe(AlpacaException.MethodOrPropertyNotImplemented)

		const temperature = await fixture.get(`${base}/temperature`)
		expect(temperature.ErrorNumber).toBe(AlpacaException.MethodOrPropertyNotImplemented)
	})

	test('keeps humidity and dew point implemented as a pair', async () => {
		await using fixture = await startAlpacaServer(ALPACA_WEATHER)
		const base = fixture.path

		// Drop the dew point: it must be derived from humidity and the ambient temperature.
		fixture.device.dewPoint = undefined
		const derivedDewPoint = (await fixture.get(`${base}/dewpoint`)).Value as number
		expect(derivedDewPoint).toBeCloseTo(6.9, 1)

		// Drop humidity instead: the inverse derivation must round-trip.
		fixture.device.dewPoint = 6.9
		fixture.device.humidity = undefined
		const derivedHumidity = (await fixture.get(`${base}/humidity`)).Value as number
		expect(derivedHumidity).toBeCloseTo(52, 0)

		// A driver declaring neither member, and no ambient temperature to derive one from, has no pair at
		// all: both must report not implemented.
		withdrawWeatherSensors(fixture, 'WEATHER_HUMIDITY', 'WEATHER_DEW_POINT', 'WEATHER_TEMPERATURE')
		expect((await fixture.get(`${base}/humidity`)).ErrorNumber).toBe(AlpacaException.MethodOrPropertyNotImplemented)
		expect((await fixture.get(`${base}/dewpoint`)).ErrorNumber).toBe(AlpacaException.MethodOrPropertyNotImplemented)
	})

	test('accepts an instantaneous average period and rejects a window it cannot configure', async () => {
		await using fixture = await startAlpacaServer(ALPACA_WEATHER)
		const base = fixture.path

		// The driver has no WEATHER_AVERAGE_PERIOD, so it reads as instantaneous and only 0 is a no-op.
		expect((await fixture.get(`${base}/averageperiod`)).Value).toBe(0)
		expect((await fixture.put(`${base}/averageperiod`, { AveragePeriod: '0' })).ErrorNumber).toBe(0)
		expect((await fixture.put(`${base}/averageperiod`, { AveragePeriod: '1.5' })).ErrorNumber).toBe(AlpacaException.InvalidValue)
		expect((await fixture.put(`${base}/averageperiod`, { AveragePeriod: 'abc' })).ErrorNumber).toBe(AlpacaException.InvalidValue)
	})

	test('rejects zero averaging against a read-only non-zero window', async () => {
		await using fixture = await startAlpacaServer(ALPACA_WEATHER)
		const base = fixture.path

		// A driver that reports a fixed two-hour window and does not let it be written.
		fixture.manager.numberVector(fixture.indiClient, { device: fixture.simulator.name, name: 'WEATHER_AVERAGE_PERIOD', permission: 'ro', state: 'Ok', elements: { AVERAGE_PERIOD: { name: 'AVERAGE_PERIOD', value: 2, min: 0, max: 24, step: 0.1, format: '%.2f' } } }, 'defNumberVector')

		expect((await fixture.get(`${base}/averageperiod`)).Value).toBe(2)

		// Nothing would change on the INDI side, so answering success would be a lie: the next GET still
		// returns two hours.
		expect((await fixture.put(`${base}/averageperiod`, { AveragePeriod: '0' })).ErrorNumber).toBe(AlpacaException.InvalidValue)
		expect((await fixture.get(`${base}/averageperiod`)).Value).toBe(2)

		// Asking for the window it already reports is a genuine no-op.
		expect((await fixture.put(`${base}/averageperiod`, { AveragePeriod: '2' })).ErrorNumber).toBe(0)
	})

	test('forwards refresh to the INDI switch', async () => {
		await using fixture = await startAlpacaServer(ALPACA_WEATHER)
		const base = fixture.path

		const before = fixture.manager.lastUpdatedAt(fixture.device)!
		await Bun.sleep(5)

		expect((await fixture.put(`${base}/refresh`)).ErrorNumber).toBe(0)
		expect(fixture.manager.lastUpdatedAt(fixture.device)!).toBeGreaterThan(before)

		// Without a writable WEATHER_REFRESH the member is not implemented.
		fixture.manager.delProperty(fixture.indiClient, { device: fixture.simulator.name, name: 'WEATHER_REFRESH' })
		expect((await fixture.put(`${base}/refresh`)).ErrorNumber).toBe(AlpacaException.MethodOrPropertyNotImplemented)
	})

	test('describes sensors by their driver label and validates the sensor name', async () => {
		await using fixture = await startAlpacaServer(ALPACA_WEATHER)
		const base = fixture.path

		const described = await fixture.get(`${base}/sensordescription?SensorName=temperature`)
		expect(described.ErrorNumber).toBe(0)
		expect(described.Value).toBe('Temperature (C)')

		withdrawWeatherSensors(fixture, 'WEATHER_STAR_FWHM')
		expect((await fixture.get(`${base}/sensordescription?SensorName=StarFWHM`)).ErrorNumber).toBe(AlpacaException.MethodOrPropertyNotImplemented)

		expect((await fixture.get(`${base}/sensordescription?SensorName=Wobble`)).ErrorNumber).toBe(AlpacaException.InvalidValue)
		expect((await fixture.get(`${base}/sensordescription`)).ErrorNumber).toBe(AlpacaException.InvalidValue)

		// A driver naming its parameter WEATHER_DEWPOINT is detected through the alias, so its label has to
		// be read through the alias as well instead of falling back to the generic ASCOM name.
		const aliased = { device: fixture.simulator.name, name: 'WEATHER_PARAMETERS', permission: 'ro', state: 'Ok', elements: { WEATHER_DEWPOINT: { name: 'WEATHER_DEWPOINT', label: 'Dew point (C)', value: 6.9, min: -60, max: 60, step: 0.1, format: '%.1f' } } } as const
		fixture.manager.numberVector(fixture.indiClient, aliased, 'defNumberVector')
		fixture.manager.vector(fixture.indiClient, aliased, 'defNumberVector')

		expect((await fixture.get(`${base}/sensordescription?SensorName=DewPoint`)).Value).toBe('Dew point (C)')
	})

	test('reports the time since each sensor was last updated', async () => {
		await using fixture = await startAlpacaServer(ALPACA_WEATHER)
		const base = fixture.path

		await Bun.sleep(20)

		const one = (await fixture.get(`${base}/timesincelastupdate?SensorName=Temperature`)).Value as number
		expect(one).toBeGreaterThan(0)
		expect(one).toBeLessThan(5)

		const any = (await fixture.get(`${base}/timesincelastupdate?SensorName=`)).Value as number
		expect(any).toBeGreaterThan(0)

		expect((await fixture.get(`${base}/timesincelastupdate?SensorName=Wobble`)).ErrorNumber).toBe(AlpacaException.InvalidValue)

		// Implemented but never reported: a negative value, not an error.
		fixture.manager.delProperty(fixture.indiClient, { device: fixture.simulator.name, name: 'WEATHER_PARAMETERS' })
		fixture.device.cloudCover = 10
		expect((await fixture.get(`${base}/timesincelastupdate?SensorName=CloudCover`)).Value).toBe(-1)
	})

	test('keeps the sensor age immune to a system clock correction', async () => {
		await using fixture = await startAlpacaServer(ALPACA_WEATHER)
		const base = fixture.path

		await Bun.sleep(5)

		// The readings were stamped before the correction, so a wall-clock subtraction would answer an age
		// an hour in the future for a sensor that was just reported.
		const now = Date.now
		Date.now = () => now() - 3_600_000

		try {
			const one = (await fixture.get(`${base}/timesincelastupdate?SensorName=Temperature`)).Value as number
			expect(one).toBeGreaterThan(0)
			expect(one).toBeLessThan(5)

			const any = (await fixture.get(`${base}/timesincelastupdate?SensorName=`)).Value as number
			expect(any).toBeGreaterThan(0)
			expect(any).toBeLessThan(5)
		} finally {
			Date.now = now
		}
	})

	test('serves the bulk device state with only the known sensors', async () => {
		await using fixture = await startAlpacaServer(ALPACA_WEATHER)
		const base = fixture.path

		const state = (await fixture.get(`${base}/devicestate`)).Value as AlpacaStateItem[]
		const names = state.map((e) => e.Name)

		expect(names).toEqual(['CloudCover', 'DewPoint', 'Humidity', 'Pressure', 'RainRate', 'SkyBrightness', 'SkyQuality', 'SkyTemperature', 'StarFWHM', 'Temperature', 'WindDirection', 'WindGust', 'WindSpeed', 'TimeStamp'])
		expect(state.find((e) => e.Name === 'Temperature')!.Value).toBe(16.8)
		expect(Number.isNaN(Date.parse(state.at(-1)!.Value as string))).toBeFalse()

		// AveragePeriod configures the device rather than describing the weather.
		expect(names).not.toContain('AveragePeriod')

		fixture.device.skyQuality = undefined
		const reduced = (await fixture.get(`${base}/devicestate`)).Value as AlpacaStateItem[]
		expect(reduced.map((e) => e.Name)).not.toContain('SkyQuality')
	})

	test('fails every member with NotConnected while disconnected', async () => {
		await using fixture = await startAlpacaServer(ALPACA_WEATHER, { connect: false })
		const base = fixture.path

		for (const path of ['temperature', 'averageperiod', 'devicestate', 'sensordescription?SensorName=Temperature', 'timesincelastupdate?SensorName=']) {
			expect((await fixture.get(`${base}/${path}`)).ErrorNumber).toBe(AlpacaException.NotConnected)
		}

		expect((await fixture.put(`${base}/refresh`)).ErrorNumber).toBe(AlpacaException.NotConnected)
		expect((await fixture.get(`/api/v1/observingconditions/9999/temperature`)).ErrorNumber).toBe(AlpacaException.InvalidValue)
	})

	test('derives a saturated dew point instead of dropping the member', async () => {
		await using fixture = await startAlpacaServer(ALPACA_WEATHER)
		const base = fixture.path

		// A fogged-in station can read a hair above 100%. The pair must stay implemented: this repo's own
		// client latches MethodOrPropertyNotImplemented as a permanent capability.
		fixture.device.dewPoint = undefined
		fixture.device.humidity = 100.4

		const response = await fixture.get(`${base}/dewpoint`)
		expect(response.ErrorNumber).toBe(0)
		expect(response.Value as number).toBeCloseTo(fixture.device.temperature, 6)

		// The mirrored direction was already clamped; assert both halves behave the same way.
		fixture.device.humidity = undefined
		fixture.device.dewPoint = fixture.device.temperature + 0.4
		const humidity = await fixture.get(`${base}/humidity`)
		expect(humidity.ErrorNumber).toBe(0)
		expect(humidity.Value).toBe(100)
	})

	test('drops the derived member for a reading outside the Magnus domain', async () => {
		await using fixture = await startAlpacaServer(ALPACA_WEATHER)
		const base = fixture.path

		// The Magnus terms are unbounded near their -243.04 C singularity, so the relation is only defined
		// within +-100 C. A driver reporting outside it must leave the derived member without a value
		// instead of serializing Infinity or NaN as a successful reading, but the sensor stays implemented.
		fixture.device.dewPoint = undefined
		fixture.device.temperature = -150
		expect((await fixture.get(`${base}/dewpoint`)).ErrorNumber).toBe(AlpacaException.ValueNotSet)

		fixture.device.dewPoint = 6.9
		fixture.device.humidity = undefined
		expect((await fixture.get(`${base}/humidity`)).ErrorNumber).toBe(AlpacaException.ValueNotSet)

		fixture.device.temperature = -242.94
		expect((await fixture.get(`${base}/humidity`)).ErrorNumber).toBe(AlpacaException.ValueNotSet)

		fixture.device.temperature = 16.8
		fixture.device.dewPoint = -300
		expect((await fixture.get(`${base}/humidity`)).ErrorNumber).toBe(AlpacaException.ValueNotSet)
	})

	test('keeps a derived dew point implemented at zero humidity', async () => {
		await using fixture = await startAlpacaServer(ALPACA_WEATHER)
		const base = fixture.path

		// The Magnus relation is undefined at 0 % RH, but that is a reading, not a capability: this repo's
		// own client latches MethodOrPropertyNotImplemented and would never ask for DewPoint again.
		fixture.device.dewPoint = undefined
		fixture.device.humidity = 0

		expect((await fixture.get(`${base}/dewpoint`)).ErrorNumber).toBe(AlpacaException.ValueNotSet)
		expect((await fixture.get(`${base}/sensordescription?SensorName=DewPoint`)).ErrorNumber).toBe(0)
		expect((await fixture.get(`${base}/timesincelastupdate?SensorName=DewPoint`)).ErrorNumber).toBe(0)

		// The sensor recovers by itself as soon as the humidity rises again.
		fixture.device.humidity = 52
		const recovered = await fixture.get(`${base}/dewpoint`)
		expect(recovered.ErrorNumber).toBe(0)
		expect(recovered.Value as number).toBeCloseTo(6.9, 1)

		// A driver that declares neither member really has no dew point to report.
		withdrawWeatherSensors(fixture, 'WEATHER_HUMIDITY', 'WEATHER_DEW_POINT', 'WEATHER_TEMPERATURE')
		expect((await fixture.get(`${base}/dewpoint`)).ErrorNumber).toBe(AlpacaException.MethodOrPropertyNotImplemented)
	})

	test('keeps a sensor declared by a Busy definition implemented until its first reading', async () => {
		await using fixture = await startAlpacaServer(ALPACA_WEATHER)
		const base = fixture.path

		// A Firmata weather peripheral defines WEATHER_PARAMETERS Busy with placeholder zeros and settles
		// it on its first hardware reply. WeatherManager stores no value meanwhile, but the element set is
		// the driver stating that the sensor exists, so the capability must survive that gap: 1024 is what
		// a capability-caching client latches for the rest of the connection.
		fixture.manager.delProperty(fixture.indiClient, { device: fixture.simulator.name, name: 'WEATHER_PARAMETERS' })

		const placeholders = { device: fixture.simulator.name, name: 'WEATHER_PARAMETERS', permission: 'ro', state: 'Busy', elements: { WEATHER_TEMPERATURE: { name: 'WEATHER_TEMPERATURE', label: 'Temperature (C)', value: 0, min: -55, max: 125, step: 0.01, format: '%.2f' } } } as const
		fixture.manager.numberVector(fixture.indiClient, placeholders, 'defNumberVector')
		fixture.manager.vector(fixture.indiClient, placeholders, 'defNumberVector')

		expect(fixture.device.hasThermometer).toBeFalse()

		expect((await fixture.get(`${base}/temperature`)).ErrorNumber).toBe(AlpacaException.ValueNotSet)
		expect((await fixture.get(`${base}/sensordescription?SensorName=Temperature`)).Value).toBe('Temperature (C)')
		expect((await fixture.get(`${base}/timesincelastupdate?SensorName=Temperature`)).Value).toBe(-1)

		// A sensor the definition does not declare stays genuinely unimplemented.
		expect((await fixture.get(`${base}/cloudcover`)).ErrorNumber).toBe(AlpacaException.MethodOrPropertyNotImplemented)

		// The first hardware sample settles it.
		fixture.manager.numberVector(fixture.indiClient, { device: fixture.simulator.name, name: 'WEATHER_PARAMETERS', state: 'Ok', elements: { WEATHER_TEMPERATURE: { name: 'WEATHER_TEMPERATURE', value: 21.5 } } }, 'setNumberVector')

		const temperature = await fixture.get(`${base}/temperature`)
		expect(temperature.ErrorNumber).toBe(0)
		expect(temperature.Value).toBe(21.5)
	})

	test('reports the freshness of a derived sensor from the one it is derived from', async () => {
		await using fixture = await startAlpacaServer(ALPACA_WEATHER)
		const base = fixture.path

		// Humidity is derived from the dew point, so it is refreshed exactly when the dew point is.
		fixture.device.humidity = undefined
		await Bun.sleep(20)

		const derived = (await fixture.get(`${base}/timesincelastupdate?SensorName=Humidity`)).Value as number
		expect(derived).toBeGreaterThan(0)
		expect(derived).toBeLessThan(5)

		const source = (await fixture.get(`${base}/timesincelastupdate?SensorName=DewPoint`)).Value as number
		expect(derived).toBeCloseTo(source, 1)
	})

	test('refreshes a derived sensor when only the ambient temperature is reported', async () => {
		await using fixture = await startAlpacaServer(ALPACA_WEATHER)
		const base = fixture.path

		// Humidity derived from the dew point is also a function of the ambient temperature, so a lone
		// temperature report moves it even though the dew point did not change.
		fixture.device.humidity = undefined
		await Bun.sleep(20)

		const stale = (await fixture.get(`${base}/timesincelastupdate?SensorName=Humidity`)).Value as number
		expect(stale).toBeGreaterThan(0.01)

		fixture.manager.numberVector(fixture.indiClient, { device: fixture.simulator.name, name: 'WEATHER_PARAMETERS', elements: { WEATHER_TEMPERATURE: { name: 'WEATHER_TEMPERATURE', value: 17.4 } } }, 'setNumberVector')

		const fresh = (await fixture.get(`${base}/timesincelastupdate?SensorName=Humidity`)).Value as number
		expect(fresh).toBeLessThan(stale)

		// The dew point itself is still the older reading, which is what the derived member used to report.
		const dewPointAge = (await fixture.get(`${base}/timesincelastupdate?SensorName=DewPoint`)).Value as number
		expect(dewPointAge).toBeGreaterThan(fresh)
	})

	test('refreshes the wind direction when the wind speed alone reports calm', async () => {
		await using fixture = await startAlpacaServer(ALPACA_WEATHER)
		const base = fixture.path

		await Bun.sleep(20)

		const stale = (await fixture.get(`${base}/timesincelastupdate?SensorName=WindDirection`)).Value as number
		expect(stale).toBeGreaterThan(0.01)

		// ASCOM reserves 0 for calm air, so a lone wind-speed report of zero swaps the published direction
		// from the measured bearing to that sentinel: the endpoint moved even though the direction element
		// was not reported.
		fixture.manager.numberVector(fixture.indiClient, { device: fixture.simulator.name, name: 'WEATHER_PARAMETERS', elements: { WEATHER_WIND_SPEED: { name: 'WEATHER_WIND_SPEED', value: 0 } } }, 'setNumberVector')

		expect((await fixture.get(`${base}/winddirection`)).Value).toBe(0)

		const fresh = (await fixture.get(`${base}/timesincelastupdate?SensorName=WindDirection`)).Value as number
		expect(fresh).toBeLessThan(stale)
	})

	test('reports no age for a derived sensor whose source never reported', async () => {
		await using fixture = await startAlpacaServer(ALPACA_WEATHER)
		const base = fixture.path

		fixture.manager.delProperty(fixture.indiClient, { device: fixture.simulator.name, name: 'WEATHER_PARAMETERS' })

		// The driver declares a hygrometer and a thermometer, then settles only the temperature on its
		// first hardware reply. Humidity has neither a reading of its own nor a dew point to be derived
		// from, so it is implemented but has never produced a value.
		const placeholders = {
			device: fixture.simulator.name,
			name: 'WEATHER_PARAMETERS',
			permission: 'ro',
			state: 'Busy',
			elements: { WEATHER_TEMPERATURE: { name: 'WEATHER_TEMPERATURE', label: 'Temperature (C)', value: 0, min: -55, max: 125, step: 0.01, format: '%.2f' }, WEATHER_HUMIDITY: { name: 'WEATHER_HUMIDITY', label: 'Humidity (%)', value: 0, min: 0, max: 100, step: 0.1, format: '%.1f' } },
		} as const
		fixture.manager.numberVector(fixture.indiClient, placeholders, 'defNumberVector')
		fixture.manager.vector(fixture.indiClient, placeholders, 'defNumberVector')

		fixture.manager.numberVector(fixture.indiClient, { device: fixture.simulator.name, name: 'WEATHER_PARAMETERS', state: 'Ok', elements: { WEATHER_TEMPERATURE: { name: 'WEATHER_TEMPERATURE', value: 21.5 } } }, 'setNumberVector')

		expect((await fixture.get(`${base}/humidity`)).ErrorNumber).toBe(AlpacaException.ValueNotSet)
		expect((await fixture.get(`${base}/timesincelastupdate?SensorName=Humidity`)).Value).toBe(-1)

		// The temperature did report, so its own age is a real one.
		expect((await fixture.get(`${base}/timesincelastupdate?SensorName=Temperature`)).Value as number).toBeGreaterThanOrEqual(0)
	})

	test('drops its registrations when the server stops listening', async () => {
		await using fixture = await startAlpacaServer(ALPACA_WEATHER)
		const base = fixture.path

		expect((await fixture.get(`${base}/temperature`)).ErrorNumber).toBe(0)

		fixture.server.unlisten()
		expect((await fixture.get(`${base}/temperature`)).ErrorNumber).toBe(AlpacaException.InvalidValue)
	})
})

async function expectFixtureServesDevice<D extends Device, M extends DeviceManager<D>, S extends DeviceSimulator>(kind: AlpacaTestDevice<D, M, S>) {
	await using fixture = await startAlpacaServer(kind)

	expect(fixture.device.connected).toBeTrue()
	expect(fixture.path).toBe(`/api/v1/${kind.type}/${fixture.deviceNumber}`)
	expect(fixture.properties()).toBeDefined()

	expect((await fixture.get(`${fixture.path}/connected`)).Value).toBeTrue()
	expect((await fixture.get(`${fixture.path}/name`)).Value).toBe(kind.name)

	const configured = Array.from(fixture.server.configuredDevices())
	expect(configured.some((e) => e.DeviceType === kind.type && e.DeviceNumber === fixture.deviceNumber)).toBeTrue()
}

test('the alpaca fixtures stand up every simulated device type', async () => {
	await expectFixtureServesDevice(ALPACA_CAMERA)
	await expectFixtureServesDevice(ALPACA_MOUNT)
	await expectFixtureServesDevice(ALPACA_FOCUSER)
	await expectFixtureServesDevice(ALPACA_WHEEL)
	await expectFixtureServesDevice(ALPACA_ROTATOR)
	await expectFixtureServesDevice(ALPACA_DOME)
	await expectFixtureServesDevice(ALPACA_COVER)
	await expectFixtureServesDevice(ALPACA_FLAT_PANEL)
	await expectFixtureServesDevice(ALPACA_SAFETY_MONITOR)
	await expectFixtureServesDevice(ALPACA_WEATHER)
}, 30000)
