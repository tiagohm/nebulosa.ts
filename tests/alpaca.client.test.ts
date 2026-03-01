import type { TestOptions } from 'bun:test'
import { describe, expect, test } from 'bun:test'
import { AlpacaClient, type AlpacaClientHandler, makeFitsFromImageBytes } from '../src/alpaca.client'
import { makeImageBytesFromFits } from '../src/alpaca.server'
import { deg, hour } from '../src/angle'
import type { FitsHeader } from '../src/fits'
import { readImageFromBuffer } from '../src/image'
import { debayer } from '../src/image.transformation'
import { CLIENT, type Client, DEFAULT_CAMERA, DEFAULT_MOUNT, type Device, type DeviceType } from '../src/indi.device'
import { CameraManager, CoverManager, type DeviceProvider, FlatPanelManager, FocuserManager, GuideOutputManager, MountManager, RotatorManager, ThermometerManager, WheelManager } from '../src/indi.manager'
import type { PropertyState } from '../src/indi.types'
import { roundToNthDecimal } from '../src/math'
import { timeYMDHMS } from '../src/time'
import { saveImageAndCompareHash } from './image.util'

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
		await saveImageAndCompareHash(debayer(image!, 'RGGB')!, 'alpaca.8.3', '242f9a2336cb217b83570bb51f8616f2')
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

const guideOutput = new GuideOutputManager({
	get: (client: Client, name: string) => {
		return mountManager.get(client, name) ?? cameraManager.get(client, name)
	},
})

const thermometerManager = new ThermometerManager({
	get: (client: Client, name: string) => {
		return focuserManager.get(client, name) ?? cameraManager.get(client, name)
	},
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
	},
	numberVector: (client, message, tag) => {
		cameraManager.numberVector(client, message, tag)
		mountManager.numberVector(client, message, tag)
		wheelManager.numberVector(client, message, tag)
		focuserManager.numberVector(client, message, tag)
		flatPanelManager.numberVector(client, message, tag)
		rotatorManager.numberVector(client, message, tag)
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
		guideOutput.switchVector(client, message, tag)
		thermometerManager.switchVector(client, message, tag)
	},
	blobVector: (client, message, tag) => {
		cameraManager.blobVector(client, message, tag)
	},
}

const deviceProvider: DeviceProvider<Device> = {
	get: (client: Client, name: string, type?: DeviceType) => {
		if (type === 'CAMERA') return cameraManager.get(client, name)
		else if (type === 'MOUNT') return mountManager.get(client, name)
		else if (type === 'FOCUSER') return focuserManager.get(client, name)
		else if (type === 'WHEEL') return wheelManager.get(client, name)
		else if (type === 'FLAT_PANEL') return flatPanelManager.get(client, name)
		else if (type === 'COVER') return coverManager.get(client, name)
		else if (type === 'ROTATOR') return rotatorManager.get(client, name)
		return undefined
	},
}

const isEqual = (a: unknown, b: unknown) => a === b
const isNotEqual = (a: unknown, b: unknown) => a !== b
const isCloseTo = (decimalPlaces: number) => (a: number, b: number) => roundToNthDecimal(a, decimalPlaces) === b

const TEST_OPTIONS: TestOptions = { retry: 5, timeout: 60000 }

// ASCOM Omni-Simulators
describe.skipIf(process.platform !== 'win32' || process.env.ALPACA !== 'true')('client', async () => {
	const client = new AlpacaClient('http://localhost:32323', { handler }, deviceProvider)

	if (!(await client.start())) return

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
			expect(state[state.length - 1]).toBe('Ok')
			expect(exposure[0]).toBe(2)
			expect(exposure[exposure.length - 1]).toBe(0)

			image = undefined

			cameraManager.startExposure(camera, 60)
			await expectUntil(camera, 'exposuring', true)
			cameraManager.stopExposure(camera)
			await expectUntil(camera, 'exposuring', false)
			await Bun.sleep(5000)
			expect(state[state.length - 1]).toBe('Idle')

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

test.skip('download from Sky Simulator', async () => {
	const response = await fetch('http://localhost:11111/api/v1/camera/0/imagearray', { headers: { Accept: 'application/imagebytes' } })
	await Bun.write('Sky Simulator.dat', await response.blob())
})
