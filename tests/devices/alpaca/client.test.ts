import { type TestOptions, describe, expect, test } from 'bun:test'
import { timeYMDHMS } from '../../../src/astronomy/time/time'
import { DEG2RAD, PIOVERTWO } from '../../../src/core/constants'
import { AlpacaClient, type AlpacaClientHandler, makeFitsFromImageBytes } from '../../../src/devices/alpaca/client'
import { makeImageBytesFromFits } from '../../../src/devices/alpaca/server'
import { type AlpacaConfiguredDevice, AlpacaException } from '../../../src/devices/alpaca/types'
import { CLIENT, type Client, DEFAULT_CAMERA, DEFAULT_MOUNT, type Device, type DeviceType, type Weather } from '../../../src/devices/indi/device'
import { CameraManager, CoverManager, type DeviceProvider, DomeManager, FlatPanelManager, FocuserManager, GuideOutputManager, MountManager, RotatorManager, ThermometerManager, WheelManager } from '../../../src/devices/indi/manager'
import type { PropertyState } from '../../../src/devices/indi/types'
import { readImageFromBuffer } from '../../../src/imaging/model/image'
import { debayer } from '../../../src/imaging/processing/debayer'
import type { FitsHeader } from '../../../src/io/formats/fits/fits'
import { roundToNthDecimal } from '../../../src/math/numerical/math'
import { deg, hour } from '../../../src/math/units/angle'
import { downloadPerTag } from '../../download'
import { saveImageAndCompareHash } from '../../imaging/util'
import { isNonWindowsSkipped, isTimeConsumingTestSkipped, waitUntil } from '../../util'
import { ALPACA_MOUNT, ALPACA_WEATHER, type AlpacaWeatherClient, startAlpacaClient, startAlpacaProxy, startAlpacaServer, withdrawWeatherSensors } from './util'

await downloadPerTag('alpaca.client')

const NOW = timeYMDHMS(2026, 2, 18, 12, 0, 0)

describe('make fits from image bytes', () => {
	const camera = structuredClone(DEFAULT_CAMERA)
	const mount = structuredClone(DEFAULT_MOUNT)

	camera.name = 'Camera'
	camera.connected = true
	camera.hasCooler = true
	camera.exposure.value = 5.04
	camera.pixelSize.x = 2.5
	camera.pixelSize.y = 2.5
	camera.bin.x.value = 2
	camera.bin.y.value = 2
	camera.temperature = 25
	camera.gain.value = 8
	camera.offset.value = 3
	mount.name = 'Mount'
	mount.connected = true
	mount.geographicCoordinate.longitude = deg(-45)
	mount.geographicCoordinate.latitude = deg(-22)
	mount.equatorialCoordinate.rightAscension = hour(22)
	mount.equatorialCoordinate.declination = deg(-60)

	test('unsigned 16-bit mono', async () => {
		const bytes = Bun.file('data/Sky Simulator.8.1.dat')
		const fits = makeFitsFromImageBytes(await bytes.arrayBuffer(), NOW, camera, mount, undefined, undefined, undefined, 5)
		const image = await readImageFromBuffer(fits)
		expectNaxis(image!.header, 2, 1280, 1024, undefined)
		expectHeader(image!.header)
		await saveImageAndCompareHash(image!, 'alpaca.8.1', '7a8ffdcd833765af2e783fcce9e5e9af')
	})

	test('unsigned 16-bit color (bayered)', async () => {
		const bytes = Bun.file('data/Sky Simulator.8.3.dat')
		const fits = makeFitsFromImageBytes(await bytes.arrayBuffer(), NOW, camera, mount, undefined, undefined, undefined, 5)
		const image = await readImageFromBuffer(fits)
		expectNaxis(image!.header, 2, 1280, 1024, undefined)
		expectHeader(image!.header)
		await saveImageAndCompareHash(debayer(image!, 'RGGB')!, 'alpaca.8.3', '428add70df1895f245a20a5f7f8ca098')
	})

	test('convert to and from', async () => {
		for (const bitpix of [8, 16, 32, -32, -64]) {
			for (const channel of [1, 3]) {
				const buffer = await Bun.file(`data/NGC3372-${bitpix}.${channel}.fit`).arrayBuffer()
				const bytes = makeImageBytesFromFits(Buffer.from(buffer))
				const fits = makeFitsFromImageBytes(bytes.buffer)
				expect(fits.byteLength % 2880).toBe(0)
				const image = await readImageFromBuffer(fits)
				const hash = channel === 1 ? 'c754bf834dc1bb3948ec3cf8b9aca303' : '1ca5a4dd509ee4c67e3a2fbca43f81d4'
				await saveImageAndCompareHash(image!, `fitsfromimagebytes-${bitpix}-${channel}`, hash)
			}
		}
	}, 8000)
})

const cameraManager = new CameraManager()
const mountManager = new MountManager()
const wheelManager = new WheelManager()
const focuserManager = new FocuserManager()
const flatPanelManager = new FlatPanelManager()
const coverManager = new CoverManager()
const rotatorManager = new RotatorManager()
const domeManager = new DomeManager()

const guideOutput = new GuideOutputManager({
	get: (client: Client | string | undefined, name: string) => mountManager.get(client, name) ?? cameraManager.get(client, name),
})

const thermometerManager = new ThermometerManager({
	get: (client: Client | string | undefined, name: string) => focuserManager.get(client, name) ?? cameraManager.get(client, name),
})

const handler: AlpacaClientHandler = {
	textVector: (client, message, tag) => {
		cameraManager.textVector(client, message, tag)
		mountManager.textVector(client, message, tag)
		wheelManager.textVector(client, message, tag)
		focuserManager.textVector(client, message, tag)
		flatPanelManager.textVector(client, message, tag)
		coverManager.textVector(client, message, tag)
		rotatorManager.textVector(client, message, tag)
		domeManager.textVector(client, message, tag)
	},
	numberVector: (client, message, tag) => {
		cameraManager.numberVector(client, message, tag)
		mountManager.numberVector(client, message, tag)
		wheelManager.numberVector(client, message, tag)
		focuserManager.numberVector(client, message, tag)
		flatPanelManager.numberVector(client, message, tag)
		rotatorManager.numberVector(client, message, tag)
		domeManager.numberVector(client, message, tag)
		guideOutput.numberVector(client, message, tag)
		thermometerManager.numberVector(client, message, tag)
	},
	switchVector: (client, message, tag) => {
		cameraManager.switchVector(client, message, tag)
		mountManager.switchVector(client, message, tag)
		wheelManager.switchVector(client, message, tag)
		focuserManager.switchVector(client, message, tag)
		flatPanelManager.switchVector(client, message, tag)
		coverManager.switchVector(client, message, tag)
		rotatorManager.switchVector(client, message, tag)
		domeManager.switchVector(client, message, tag)
		guideOutput.switchVector(client, message, tag)
		thermometerManager.switchVector(client, message, tag)
	},
	blobVector: (client, message, tag) => {
		cameraManager.blobVector(client, message, tag)
	},
}

const deviceProvider: DeviceProvider<Device> = {
	get: (client: Client | string | undefined, name: string, type?: DeviceType) => {
		if (type === 'camera') return cameraManager.get(client, name)
		else if (type === 'mount') return mountManager.get(client, name)
		else if (type === 'focuser') return focuserManager.get(client, name)
		else if (type === 'wheel') return wheelManager.get(client, name)
		else if (type === 'flatPanel') return flatPanelManager.get(client, name)
		else if (type === 'cover') return coverManager.get(client, name)
		else if (type === 'rotator') return rotatorManager.get(client, name)
		else if (type === 'dome') return domeManager.get(client, name)
		return undefined
	},
}

const isEqual = (a: unknown, b: unknown) => a === b
const isNotEqual = (a: unknown, b: unknown) => a !== b
const isCloseTo = (decimalPlaces: number) => (a: number, b: number) => roundToNthDecimal(a, decimalPlaces) === b

test('client derives connection metadata from the configured URL', () => {
	const client = new AlpacaClient('https://example.test/alpaca', { handler }, deviceProvider)
	const sameUrl = new AlpacaClient('https://example.test/alpaca', { handler }, deviceProvider)

	expect(client.remoteHost).toBe('example.test')
	expect(client.remotePort).toBe(443)
	expect(client.description).toBe('Alpaca Client at https://example.test/alpaca')
	expect(client.id).toBe(sameUrl.id)
})

const TEST_OPTIONS: TestOptions = { retry: 5, timeout: 60000 }

const SKIP = isNonWindowsSkipped() || process.env.ALPACA !== 'true'

describe.skipIf(SKIP)('client', async () => {
	const client = new AlpacaClient('http://localhost:32323', { handler }, deviceProvider)

	// Avoid the network start() when the suite is skipped; otherwise it logs a
	// ConnectionRefused even though no tests run.
	if (!SKIP || !(await client.start())) return

	test(
		'camera',
		async () => {
			const camera = cameraManager.get(client, 'Alpaca Camera Sim')!

			let image: string | Buffer | undefined
			const state: PropertyState[] = []
			const exposure: number[] = []

			cameraManager.addHandler({
				added: (device) => {},
				removed: (device) => {},
				updated: (device, property, s) => {
					if (property === 'exposure') {
						s && state.push(s)
						s === 'Busy' && exposure.push(device.exposure.value)
					}
				},
				blobReceived: (device, data) => {
					image = data
				},
			})

			expect(camera).toBeDefined()
			expect(camera[CLIENT]).toBe(client)

			cameraManager.connect(camera)
			await expectUntil(camera, 'connected', true)

			await Bun.sleep(3000)

			expect(camera.canAbort).toBeTrue()
			expect(camera.canBin).toBeTrue()
			expect(camera.canPulseGuide).toBeTrue()
			expect(camera.canSetGuideRate).toBeFalse()
			expect(camera.canSetTemperature).toBeTrue()
			expect(camera.canSubFrame).toBeTrue()
			expect(camera.hasCooler).toBeTrue()
			expect(camera.hasCoolerControl).toBeTrue()
			expect(camera.hasGuideRate).toBeFalse()
			expect(camera.hasThermometer).toBeTrue()
			expect(camera.frame.x.max).toBe(799)
			expect(camera.frame.y.max).toBe(599)
			expect(camera.frame.width.max).toBe(800)
			expect(camera.frame.height.max).toBe(600)
			expect(camera.bin.x.max).toBe(4)
			expect(camera.bin.y.max).toBe(4)
			expect(camera.gain.max).toBe(4)
			expect(camera.offset.max).toBe(4)
			expect(camera.exposure.max).toBe(3600)
			expect(camera.exposure.min).toBe(0.001)
			expect(camera.pixelSize.x).toBe(5.6)
			expect(camera.pixelSize.y).toBe(5.6)
			expect(camera.frameFormats.map((e) => e.label)).toEqual(['Default'])

			cameraManager.bin(camera, 2, 2)
			await expectUntil(camera.bin.x, 'value', 2)
			await expectUntil(camera.bin.y, 'value', 2)

			cameraManager.cooler(camera, true)
			await expectUntil(camera, 'cooler', true)

			// const temp = Math.trunc(5 + Math.random() * 5)
			// cameraManager.temperature(camera, temp)
			// await expectUntil(camera, 'temperature', temp, 10000)

			for (const format of camera.frameFormats) {
				cameraManager.frameFormat(camera, format.name)
				await expectUntil(camera, 'frameFormat', format.name)
			}

			for (const type of ['BIAS', 'FLAT', 'DARK', 'LIGHT'] as const) {
				cameraManager.frameType(camera, type)
				await expectUntil(camera, 'frameType', type)
			}

			const gainStep = Math.max(1, Math.trunc((camera.gain.max - camera.gain.min) / 10))
			for (let i = camera.gain.min; i <= camera.gain.max; i += gainStep) {
				cameraManager.gain(camera, i)
				await expectUntil(camera.gain, 'value', i)
			}

			const offsetStep = Math.max(1, Math.trunc((camera.offset.max - camera.offset.min) / 10))
			for (let i = camera.offset.min; i <= camera.offset.max; i += offsetStep) {
				cameraManager.offset(camera, i)
				await expectUntil(camera.offset, 'value', i)
			}

			cameraManager.frame(camera, 50, 50, 100, 100)
			await expectUntil(camera.frame.x, 'value', 50)
			await expectUntil(camera.frame.y, 'value', 50)
			await expectUntil(camera.frame.width, 'value', 100)
			await expectUntil(camera.frame.height, 'value', 100)

			cameraManager.cooler(camera, false)
			await expectUntil(camera, 'cooler', false)

			cameraManager.startExposure(camera, 2)
			await expectUntil(camera, 'exposuring', true)
			await expectUntil(camera, 'exposuring', false)
			expect(image).toBeDefined()

			expect(state[1]).toBe('Busy')
			expect(state.at(-1)).toBe('Ok')
			expect(exposure[0]).toBe(2)
			expect(exposure.at(-1)).toBe(0)

			image = undefined

			cameraManager.startExposure(camera, 60)
			await expectUntil(camera, 'exposuring', true)
			cameraManager.stopExposure(camera)
			await expectUntil(camera, 'exposuring', false)
			await Bun.sleep(5000)
			expect(state.at(-1)).toBe('Idle')

			cameraManager.disconnect(camera)
			await expectUntil(camera, 'connected', false)
		},
		TEST_OPTIONS,
	)

	test(
		'mount',
		async () => {
			const mount = mountManager.get(client, 'Alpaca Telescope Simulator')!

			expect(mount).toBeDefined()
			expect(mount[CLIENT]).toBe(client)

			mountManager.connect(mount)
			await expectUntil(mount, 'connected', true)

			await Bun.sleep(2000)

			expect(mount.canAbort).toBeTrue()
			expect(mount.canFindHome).toBeFalse()
			expect(mount.canGoTo).toBeTrue()
			expect(mount.canHome).toBeFalse()
			expect(mount.canMove).toBeTrue()
			expect(mount.canPark).toBeTrue()
			expect(mount.canPulseGuide).toBeTrue()
			expect(mount.canSetGuideRate).toBeTrue()
			expect(mount.canSetPierSide).toBeTrue()
			expect(mount.canSync).toBeTrue()
			expect(mount.canTracking).toBeTrue()
			expect(mount.hasGuideRate).toBeTrue()
			expect(mount.hasPierSide).toBeTrue()

			mountManager.geographicCoordinate(mount, { latitude: deg(11), longitude: deg(-44), elevation: 0 })
			await expectUntil(mount.geographicCoordinate, 'latitude', 0.19198621771937624)
			await expectUntil(mount.geographicCoordinate, 'longitude', -0.7679448708775052)
			await expectUntil(mount.geographicCoordinate, 'elevation', 0)

			mountManager.unpark(mount)
			await expectUntil(mount, 'parked', false)

			mountManager.tracking(mount, true)
			await expectUntil(mount, 'tracking', true)

			mountManager.syncTo(mount, hour(8), deg(-12))
			await expectUntil(mount.equatorialCoordinate, 'rightAscension', 2.09, undefined, isCloseTo(2))
			await expectUntil(mount.equatorialCoordinate, 'declination', -0.21, undefined, isCloseTo(2))

			mountManager.goTo(mount, hour(5), deg(56))
			await expectUntil(mount, 'slewing', true)
			await expectUntil(mount, 'slewing', false, 15000)
			await expectUntil(mount.equatorialCoordinate, 'rightAscension', 1.31, undefined, isCloseTo(2))
			await expectUntil(mount.equatorialCoordinate, 'declination', 0.98, undefined, isCloseTo(2))

			for (const mode of ['KING', 'SOLAR', 'LUNAR', 'SIDEREAL'] as const) {
				mountManager.trackMode(mount, mode)
				await expectUntil(mount, 'trackMode', mode)
			}

			for (const rate of mount.slewRates) {
				mountManager.slewRate(mount, rate)
				await expectUntil(mount, 'slewRate', rate.name)
			}

			for (const move of ['moveNorth', 'moveSouth', 'moveEast', 'moveWest'] as const) {
				mountManager[move](mount, true)
				await expectUntil(mount, 'slewing', true)
				mountManager[move](mount, false)
				await expectUntil(mount, 'slewing', false)
			}

			mountManager.park(mount)
			await expectUntil(mount, 'slewing', true)
			await expectUntil(mount, 'slewing', false, 15000)
			await expectUntil(mount, 'parked', true)

			const utc = Math.trunc(Date.now() / 1000) * 1000 - 1440000
			mountManager.time(mount, { utc: utc, offset: -180 })
			await expectUntil(mount.time, 'utc', utc)
			await expectUntil(mount.time, 'offset', -180)

			// TODO: moveTo passing fixed time

			mountManager.tracking(mount, false)
			await expectUntil(mount, 'tracking', false)
		},
		TEST_OPTIONS,
	)

	test(
		'dome',
		async () => {
			const dome = domeManager.list(client).values().next().value
			if (!dome) return

			domeManager.connect(dome)
			await expectUntil(dome, 'connected', true)
			await Bun.sleep(2000)

			expect(dome.canAbort).toBeTrue()
			expect(dome.canSetAzimuth).toBeTrue()
			expect(dome.canFindHome).toBeTrue()
			expect(dome.canPark).toBeTrue()
			expect(dome.canSetShutter).toBeTrue()
			expect(dome.canSlave).toBeTrue()

			domeManager.moveTo(dome, deg(90))
			await expectUntil(dome, 'moving', true)
			await expectUntil(dome, 'moving', false, 15000)
			expect(dome.azimuth.value).toBeCloseTo(deg(90), 2)

			domeManager.home(dome)
			await expectUntil(dome, 'atHome', true, 15000)
			domeManager.park(dome)
			await expectUntil(dome, 'parked', true, 15000)

			domeManager.openShutter(dome)
			await expectUntil(dome, 'shutterState', 'OPEN', 10000)
			domeManager.closeShutter(dome)
			await expectUntil(dome, 'shutterState', 'CLOSED', 10000)

			domeManager.slave(dome, true)
			await expectUntil(dome, 'slaved', true, 10000)
			domeManager.stop(dome)
			await expectUntil(dome, 'slaved', false, 10000)
			domeManager.disconnect(dome)
			await expectUntil(dome, 'connected', false)
		},
		TEST_OPTIONS,
	)

	// Rotation Rate = 36 deg/sec
	test(
		'rotator',
		async () => {
			const rotator = rotatorManager.get(client, 'Alpaca Rotator Simulator - 0')!

			expect(rotator).toBeDefined()
			expect(rotator[CLIENT]).toBe(client)

			rotatorManager.connect(rotator)
			await expectUntil(rotator, 'connected', true)

			await Bun.sleep(2000)

			expect(rotator.canAbort).toBeTrue()
			expect(rotator.canHome).toBeFalse()
			expect(rotator.canSync).toBeTrue()
			expect(rotator.canReverse).toBeTrue()

			rotatorManager.reverse(rotator, false)
			await expectUntil(rotator, 'reversed', false)
			rotatorManager.reverse(rotator, true)
			await expectUntil(rotator, 'reversed', true)

			rotatorManager.syncTo(rotator, 0)
			await expectUntil(rotator.angle, 'value', 0)

			rotatorManager.moveTo(rotator, 180)
			await expectUntil(rotator, 'moving', true)
			await expectUntil(rotator, 'moving', false)
			await expectUntil(rotator.angle, 'value', 180)

			rotatorManager.moveTo(rotator, 359)
			await expectUntil(rotator, 'moving', true)
			rotatorManager.stop(rotator)
			await expectUntil(rotator, 'moving', false)
			await expectUntil(rotator.angle, 'value', 180, undefined, isNotEqual)
		},
		TEST_OPTIONS,
	)
})

function expectNaxis(header: FitsHeader, naxis: number, naxis1: number, naxis2: number, naxis3: number | undefined) {
	expect(header.NAXIS).toBe(naxis)
	expect(header.NAXIS1).toBe(naxis1)
	expect(header.NAXIS2).toBe(naxis2)
	expect(header.NAXIS3).toBe(naxis3)
}

function expectHeader(header: FitsHeader) {
	expect(header.INSTRUME).toBe('Camera')
	expect(header.TELESCOP).toBe('Mount')
	expect(header.PIXSIZE1).toBe(2.5)
	expect(header.PIXSIZE2).toBe(2.5)
	expect(header.XBINNING).toBe(2)
	expect(header.YBINNING).toBe(2)
	expect(header.XPIXSZ).toBe(5)
	expect(header.YPIXSZ).toBe(5)
	expect(header.SITELAT).toBe(-22)
	expect(header.SITELONG).toBe(-45)
	expect(header.OBJCTRA).toBe('21 58 07.61')
	expect(header.OBJCTDEC).toBe('-60 07 30.47')
	expect(header.RA).toBeCloseTo(329.53, 2)
	expect(header.DEC).toBeCloseTo(-60.125, 2)
	expect(header.GAIN).toBe(8)
	expect(header.OFFSET).toBe(3)
	expect(header['CCD-TEMP']).toBe(25)
}

async function expectUntil<D, K extends keyof D>(device: D, key: K, value: D[K], timeout: number = 5000, comparator: (a: D[K], b: D[K]) => boolean = isEqual) {
	while (timeout > 0 && !comparator(device[key], value)) {
		await Bun.sleep(100)
		timeout -= 100
	}

	if (timeout <= 0) {
		console.error('%s is expected %s but got %s after timed out', key, value, device[key])
		expect(timeout).toBeGreaterThan(0)
	}
}

const WEATHER_TIMEOUT = 30000

function weatherParametersOf(fixture: AlpacaWeatherClient, device: Weather) {
	const property = fixture.manager.properties.get(device)?.WEATHER_PARAMETERS
	return property?.type === 'NUMBER' ? property : undefined
}

describe.skipIf(isTimeConsumingTestSkipped())('observing conditions client', () => {
	test('consumes an ObservingConditions device and normalizes every sensor', async () => {
		await using server = await startAlpacaServer(ALPACA_WEATHER)
		await using remote = await startAlpacaClient(server.url, ALPACA_WEATHER)

		await waitUntil(() => remote.device()?.cloudCover === 15, WEATHER_TIMEOUT)

		const near = server.device
		const far = remote.device()!

		expect(far.type).toBe('weather')
		expect(far.interfaces).toEqual(['weather'])
		expect(far.connected).toBeTrue()
		expect(far.driver.executable).toBe(near.id)

		expect(far.cloudCover).toBe(near.cloudCover)
		expect(far.dewPoint).toBe(near.dewPoint)
		expect(far.humidity).toBe(near.humidity)
		expect(far.pressure).toBe(near.pressure)
		expect(far.rainRate).toBe(near.rainRate)
		expect(far.skyBrightness).toBe(near.skyBrightness)
		expect(far.skyQuality).toBe(near.skyQuality)
		expect(far.skyTemperature).toBe(near.skyTemperature)
		expect(far.starFWHM).toBe(near.starFWHM)
		expect(far.temperature).toBe(near.temperature)
		expect(far.hasThermometer).toBeTrue()
		expect(far.windGust).toBe(near.windGust)
		expect(far.windSpeed).toBe(near.windSpeed)

		// Radians at both ends, degrees only on the wire.
		expect(far.windDirection).toBeCloseTo(near.windDirection!, 9)
		expect(weatherParametersOf(remote, far)!.elements.WEATHER_WIND_DIRECTION.value).toBeCloseTo(135, 9)

		expect(far.averagePeriod).toBe(0)
	}, 10000)

	test('round-trips a northerly wind without turning it into calm', async () => {
		await using server = await startAlpacaServer(ALPACA_WEATHER)
		await using remote = await startAlpacaClient(server.url, ALPACA_WEATHER)

		await waitUntil(() => remote.device()?.windSpeed === 2.6, WEATHER_TIMEOUT)

		// 0 rad leaves as 360 deg (north) and must come back as 0 rad, not as the calm sentinel.
		server.simulator.setParameter('WEATHER_WIND_DIRECTION', 0)
		await waitUntil(() => server.device.windDirection === 0, WEATHER_TIMEOUT)
		await waitUntil(() => remote.device()!.windDirection === 0, WEATHER_TIMEOUT)

		expect(remote.device()!.windSpeed).toBe(2.6)

		// A calm reading carries no direction, so the last known one must survive untouched.
		server.simulator.setParameter('WEATHER_WIND_DIRECTION', 90)
		await waitUntil(() => remote.device()!.windDirection !== 0, WEATHER_TIMEOUT)
		server.simulator.setParameter('WEATHER_WIND_SPEED', 0)
		await waitUntil(() => remote.device()!.windSpeed === 0, WEATHER_TIMEOUT)

		expect(remote.device()!.windDirection).toBeCloseTo(PIOVERTWO, 9)
	}, 10000)

	test('withholds an initially calm wind direction instead of publishing north', async () => {
		await using server = await startAlpacaServer(ALPACA_WEATHER)

		// ASCOM reserves 0 for calm air, and the server reports it whenever the wind speed is 0. Until a
		// real direction arrives the element must stay out of the vector: the placeholder 0 it would be
		// defined with is exactly what WeatherManager reads as due north.
		server.simulator.setParameter('WEATHER_WIND_SPEED', 0)

		await using remote = await startAlpacaClient(server.url, ALPACA_WEATHER)
		await waitUntil(() => remote.device()?.cloudCover === 15, WEATHER_TIMEOUT)

		expect(weatherParametersOf(remote, remote.device()!)!.elements).not.toContainKey('WEATHER_WIND_DIRECTION')
		expect(remote.device()!.windDirection).toBeUndefined()
		expect(remote.device()!.windSpeed).toBe(0)

		// The wind picks up and the real direction joins the vector.
		server.simulator.setParameter('WEATHER_WIND_SPEED', 2.6)
		await waitUntil(() => remote.device()!.windDirection !== undefined, WEATHER_TIMEOUT)

		expect(remote.device()!.windDirection).toBeCloseTo(135 * DEG2RAD, 9)
	}, 15000)

	test('keeps an unimplemented sensor out of the synthesized vector', async () => {
		await using server = await startAlpacaServer(ALPACA_WEATHER)

		// The driver withdraws seeing from its definition before the client ever connects.
		withdrawWeatherSensors(server, 'WEATHER_STAR_FWHM')

		await using remote = await startAlpacaClient(server.url, ALPACA_WEATHER)
		await waitUntil(() => remote.device()?.cloudCover === 15, WEATHER_TIMEOUT)

		const parameters = weatherParametersOf(remote, remote.device()!)!
		expect(parameters.elements).not.toContainKey('WEATHER_STAR_FWHM')
		expect(parameters.elements).toContainKey('WEATHER_TEMPERATURE')
		expect(remote.device()!.starFWHM).toBeUndefined()

		// The label comes from the driver, through SensorDescription.
		expect(parameters.elements.WEATHER_TEMPERATURE.label).toBe('Temperature (C)')
	}, 10000)

	test('probes an unimplemented sensor once when the server has no DeviceState', async () => {
		await using server = await startAlpacaServer(ALPACA_WEATHER)
		withdrawWeatherSensors(server, 'WEATHER_STAR_FWHM')

		await using proxy = startAlpacaProxy(server.url, { notImplemented: ['/devicestate'] })
		await using remote = await startAlpacaClient(proxy.url, ALPACA_WEATHER)

		await waitUntil(() => remote.device()?.cloudCover === 15, WEATHER_TIMEOUT)
		await waitUntil(() => proxy.countOf('/temperature') >= 3, WEATHER_TIMEOUT)

		// Probed once, answered MethodOrPropertyNotImplemented, never polled again.
		expect(proxy.countOf('/starfwhm')).toBe(1)
		expect(weatherParametersOf(remote, remote.device()!)!.elements).not.toContainKey('WEATHER_STAR_FWHM')

		// The supported sensors keep flowing through the per-endpoint fallback.
		expect(remote.device()!.temperature).toBe(16.8)
		expect(remote.device()!.hasThermometer).toBeTrue()
	}, 10000)

	test('recovers a sensor the first bulk state could not report', async () => {
		await using server = await startAlpacaServer(ALPACA_WEATHER)

		// The station derives its dew point from humidity, and the Magnus relation is undefined at 0 % RH,
		// so DeviceState cannot carry DewPoint while the client is discovering capabilities. An omission is
		// not MethodOrPropertyNotImplemented and must not disable the sensor for the connection.
		server.device.dewPoint = undefined
		server.device.humidity = 0

		await using remote = await startAlpacaClient(server.url, ALPACA_WEATHER)
		await waitUntil(() => remote.device()?.cloudCover === 15, WEATHER_TIMEOUT)

		expect(weatherParametersOf(remote, remote.device()!)!.elements).not.toContainKey('WEATHER_DEW_POINT')
		expect(remote.device()!.dewPoint).toBeUndefined()
		expect(remote.device()!.humidity).toBe(0)

		// The humidity rises, the server can derive again, and the sensor must join the vector.
		server.device.humidity = 52
		await waitUntil(() => remote.device()!.dewPoint !== undefined, WEATHER_TIMEOUT)

		expect(remote.device()!.dewPoint).toBeCloseTo(6.9, 1)
		expect(weatherParametersOf(remote, remote.device()!)!.elements.WEATHER_DEW_POINT.label).toBe('Dew point (C)')
	}, 15000)

	test('withholds a transiently unread sensor instead of publishing a zero', async () => {
		await using server = await startAlpacaServer(ALPACA_WEATHER)

		// Without DeviceState the capabilities come from the per-sensor fallback. A transport failure is
		// not MethodOrPropertyNotImplemented, so seeing stays supported and keeps being polled, but it has
		// no reading yet and must not reach the vector as a fresh 0.
		let failures = 3

		await using proxy = startAlpacaProxy(server.url, {
			notImplemented: ['/devicestate'],
			respond: (path) => {
				if (!path.endsWith('/starfwhm') || failures <= 0) return undefined
				failures--
				return { status: 500 }
			},
		})

		await using remote = await startAlpacaClient(proxy.url, ALPACA_WEATHER)
		await waitUntil(() => remote.device()?.cloudCover === 15, WEATHER_TIMEOUT)

		expect(weatherParametersOf(remote, remote.device()!)!.elements).not.toContainKey('WEATHER_STAR_FWHM')
		expect(remote.device()!.starFWHM).toBeUndefined()
		expect(weatherParametersOf(remote, remote.device()!)!.elements).toContainKey('WEATHER_TEMPERATURE')

		// The endpoint recovers on its own and the sensor joins the vector with its real reading.
		await waitUntil(() => remote.device()!.starFWHM !== undefined, WEATHER_TIMEOUT)
		expect(remote.device()!.starFWHM).toBe(2.4)
		expect(weatherParametersOf(remote, remote.device()!)!.elements.WEATHER_STAR_FWHM.label).toBe('Star FWHM (arcsec)')
	}, 15000)

	test('stops refreshing a sensor a later bulk snapshot omits', async () => {
		await using server = await startAlpacaServer(ALPACA_WEATHER)

		// Derive the dew point from humidity, so it leaves DeviceState the moment the Magnus relation
		// cannot produce it. A bulk snapshot only carries the names it can report, and the base merge
		// writes only those, so an omission must not leave the previous reading in place.
		server.device.dewPoint = undefined

		await using remote = await startAlpacaClient(server.url, ALPACA_WEATHER)
		await waitUntil(() => remote.device()?.dewPoint !== undefined, WEATHER_TIMEOUT)

		const far = remote.device()!
		const changed = Date.now()
		server.device.humidity = 0
		await waitUntil(() => remote.manager.updatedAt(far, 'temperature')! > changed, WEATHER_TIMEOUT)

		const stale = remote.manager.updatedAt(far, 'dewPoint')!
		const mark = Date.now()
		await waitUntil(() => remote.manager.updatedAt(far, 'temperature')! > mark, WEATHER_TIMEOUT)

		expect(remote.manager.updatedAt(far, 'dewPoint')).toBe(stale)
		expect(far.dewPoint).toBeCloseTo(6.9, 1)

		// It recovers on its own once the snapshot carries it again.
		server.device.humidity = 52
		await waitUntil(() => remote.manager.updatedAt(far, 'dewPoint')! > stale, WEATHER_TIMEOUT)
	}, 15000)

	test('stops refreshing a sensor whose endpoint starts failing', async () => {
		await using server = await startAlpacaServer(ALPACA_WEATHER)

		let failing = false

		await using proxy = startAlpacaProxy(server.url, {
			notImplemented: ['/devicestate'],
			respond: (path) => (failing && path.endsWith('/starfwhm') ? { status: 500 } : undefined),
		})

		await using remote = await startAlpacaClient(proxy.url, ALPACA_WEATHER)
		await waitUntil(() => remote.device()?.starFWHM === 2.4, WEATHER_TIMEOUT)

		const far = remote.device()!
		const attempts = proxy.countOf('/starfwhm')

		// Seeing stops answering. It is not unimplemented, so it keeps being polled, but its last value
		// must not ride along on the reports the other sensors keep producing.
		failing = true
		await waitUntil(() => proxy.countOf('/starfwhm') >= attempts + 2, WEATHER_TIMEOUT)

		const stale = remote.manager.updatedAt(far, 'starFWHM')!
		expect(stale).toBeGreaterThan(0)

		await waitUntil(() => remote.manager.updatedAt(far, 'temperature')! > stale, WEATHER_TIMEOUT)

		expect(remote.manager.updatedAt(far, 'starFWHM')).toBe(stale)
		expect(far.starFWHM).toBe(2.4)

		// It recovers by itself, without a redefinition, once the endpoint answers again.
		failing = false
		await waitUntil(() => remote.manager.updatedAt(far, 'starFWHM')! > stale, WEATHER_TIMEOUT)
	}, 15000)

	test('forwards the average period and the refresh command back to the server', async () => {
		await using server = await startAlpacaServer(ALPACA_WEATHER)
		await using remote = await startAlpacaClient(server.url, ALPACA_WEATHER)

		await waitUntil(() => remote.device()?.cloudCover === 15, WEATHER_TIMEOUT)

		const far = remote.device()!
		expect(far.averagePeriod).toBe(0)

		// The INDI station cannot average, so the server refuses a non-zero window and the mirrored
		// value stays at the instantaneous 0.
		remote.manager.setAveragePeriod(far, 2)
		await Bun.sleep(1500)
		expect(far.averagePeriod).toBe(0)

		// Refresh must reach the simulator and advance its freshness without moving any value.
		const before = server.manager.lastUpdatedAt(server.device)!
		expect(remote.manager.refresh(far)).toBeTrue()
		await waitUntil(() => server.manager.lastUpdatedAt(server.device)! > before, WEATHER_TIMEOUT)
		expect(server.device.cloudCover).toBe(15)
	}, 10000)

	test('keeps the far end fresh while the weather holds still', async () => {
		await using server = await startAlpacaServer(ALPACA_WEATHER)
		await using remote = await startAlpacaClient(server.url, ALPACA_WEATHER)

		await waitUntil(() => remote.device()?.cloudCover === 15, WEATHER_TIMEOUT)

		const far = remote.device()!
		const first = remote.manager.lastUpdatedAt(far)!
		expect(first).toBeGreaterThan(0)

		// Nothing changes, yet a downstream TimeSinceLastUpdate must keep advancing.
		await waitUntil(() => remote.manager.lastUpdatedAt(far)! > first, WEATHER_TIMEOUT)
		expect(far.cloudCover).toBe(15)
	}, 10000)

	test('a stopped client discards a weather definition still in flight', async () => {
		await using server = await startAlpacaServer(ALPACA_WEATHER)

		// Hold the sensor descriptions so the definition is unmistakably in flight when the client stops.
		await using proxy = startAlpacaProxy(server.url, { delay: (path) => (path.endsWith('/sensordescription') ? 500 : undefined) })

		const emitted: string[] = []
		await using remote = await startAlpacaClient(proxy.url, ALPACA_WEATHER, { numberVector: (_, message, tag) => emitted.push(`${tag}:${message.name}`) })

		await waitUntil(() => remote.device() !== undefined, WEATHER_TIMEOUT)
		await waitUntil(() => proxy.countOf('/sensordescription') > 0, WEATHER_TIMEOUT)
		expect(emitted).not.toContain('defNumberVector:WEATHER_PARAMETERS')

		// stop() closes its wrappers rather than disconnecting them, so close() is the only hook that can
		// end the session. A run that resolves afterwards must publish nothing: a restart on the same URL
		// reuses the client id, so a stale definition, set, or deletion would land in the new session.
		remote.client.stop()
		await Bun.sleep(900)

		expect(emitted).not.toContain('defNumberVector:WEATHER_PARAMETERS')
	}, 15000)

	test('wraps a station listed under two device types with the same name', async () => {
		await using server = await startAlpacaServer(ALPACA_WEATHER)

		const configured = ((await (await fetch(`${server.url}/management/v1/configureddevices`)).json()) as { Value: AlpacaConfiguredDevice[] }).Value
		const station = configured.find((e) => e.DeviceType === 'observingconditions')!

		// One INDI driver implementing Weather and Dome is listed once per Alpaca type under the same
		// display name, which is exactly what this repository's own server does for a multi-interface
		// device. The dome is listed first, so before this the weather half claimed no wrapper at all.
		await using proxy = startAlpacaProxy(server.url, {
			respond: (path) => {
				if (path.endsWith('/configureddevices')) return { value: [{ ...station, DeviceType: 'dome' }, station] }
				if (!path.includes('/dome/')) return undefined
				return path.endsWith('/connected') ? { value: true } : { errorNumber: AlpacaException.MethodOrPropertyNotImplemented }
			},
		})

		await using remote = await startAlpacaClient(proxy.url, ALPACA_WEATHER)
		await waitUntil(() => remote.device()?.cloudCover === 15, WEATHER_TIMEOUT)

		const far = remote.device()!
		expect(far.temperature).toBe(16.8)
		expect(weatherParametersOf(remote, far)!.elements).toContainKey('WEATHER_TEMPERATURE')

		// Both halves are advertised together: a wrapper publishing only its own bit would make the
		// WeatherManager drop the device the moment it saw the dome's definition.
		expect(far.interfaces).toEqual(['dome', 'weather'])
	}, 15000)

	test('never turns a weather station into a safety monitor', async () => {
		await using server = await startAlpacaServer(ALPACA_WEATHER)
		await using remote = await startAlpacaClient(server.url, ALPACA_WEATHER)

		await waitUntil(() => remote.device()?.cloudCover === 15, WEATHER_TIMEOUT)

		expect(remote.device()).not.toContainKey('safe')
		expect(remote.manager.properties.get(remote.device()!)).not.toContainKey('SAFETY_STATUS')
	}, 10000)
})

describe.skipIf(isTimeConsumingTestSkipped())('alpaca client capability and polling regressions', () => {
	test('a mount that only moves its secondary axis still gets the motion controls', async () => {
		await using server = await startAlpacaServer(ALPACA_MOUNT)

		// The simulator answers the same value for both axes, so the asymmetric driver is scripted.
		await using proxy = startAlpacaProxy(server.url, {
			respond: (path, url) => (path.endsWith('/canmoveaxis') ? { value: url.searchParams.get('Axis') === '1' } : undefined),
		})

		await using remote = await startAlpacaClient(proxy.url, ALPACA_MOUNT)

		await waitUntil(() => remote.device()?.connected === true, WEATHER_TIMEOUT)

		// canMove is set from TELESCOPE_MOTION_NS/WE, which the wrapper only defines when the mount
		// reports at least one movable axis.
		await waitUntil(() => remote.device()!.canMove, WEATHER_TIMEOUT)
		expect(proxy.countOf('/canmoveaxis')).toBeGreaterThanOrEqual(2)
	}, 10000)

	test('a transient DeviceState failure is skipped instead of crashing the poll', async () => {
		await using server = await startAlpacaServer(ALPACA_WEATHER)

		let deviceStateCalls = 0

		// Fail the third bulk read only: the handshake needs the first ones to settle the capability.
		await using proxy = startAlpacaProxy(server.url, {
			respond: (path) => {
				if (!path.endsWith('/devicestate')) return undefined
				deviceStateCalls++
				return deviceStateCalls === 3 ? { status: 503 } : undefined
			},
		})

		await using remote = await startAlpacaClient(proxy.url, ALPACA_WEATHER)

		await waitUntil(() => remote.device()?.cloudCover === 15, WEATHER_TIMEOUT)
		await waitUntil(() => deviceStateCalls > 3, WEATHER_TIMEOUT)

		// The gap must not stop the poll: a later reading still reaches the far end.
		server.simulator.setParameter('WEATHER_CLOUD_COVER', 62)
		await waitUntil(() => remote.device()!.cloudCover === 62, WEATHER_TIMEOUT)
	}, 10000)

	test('the calm wind sentinel is never republished as a northerly wind', async () => {
		await using server = await startAlpacaServer(ALPACA_WEATHER)

		let directionCalls = 0

		// A driver that reports a real direction and then the ASCOM calm sentinel, while leaving
		// WindSpeed unimplemented. Nothing about a zero direction says north, so the last real
		// direction must survive.
		await using proxy = startAlpacaProxy(server.url, {
			notImplemented: ['/devicestate', '/windspeed'],
			respond: (path) => {
				if (!path.endsWith('/winddirection')) return undefined
				directionCalls++
				return { value: directionCalls <= 2 ? 135 : 0 }
			},
		})

		await using remote = await startAlpacaClient(proxy.url, ALPACA_WEATHER)

		await waitUntil(() => remote.device()?.windDirection !== undefined, WEATHER_TIMEOUT)
		expect(remote.device()!.windDirection).toBeCloseTo(135 * DEG2RAD, 9)

		// Let several calm sentinels arrive.
		await waitUntil(() => directionCalls >= 5, WEATHER_TIMEOUT)

		expect(remote.device()!.windDirection).toBeCloseTo(135 * DEG2RAD, 9)
		expect(remote.device()!.windSpeed).toBeUndefined()
		// An unimplemented sensor is probed once and dropped from the vector.
		expect(proxy.countOf('/windspeed')).toBe(1)
	}, 10000)
})
