import { describe, expect, test } from 'bun:test'
import { timeYMDHMS } from '../../../src/astronomy/time/time'
import { makeFitsFromImageBytes } from '../../../src/devices/alpaca/client'
import { makeImageBytesFromFits } from '../../../src/devices/alpaca/server'
import { DEFAULT_CAMERA, DEFAULT_FOCUSER, DEFAULT_MOUNT, DEFAULT_ROTATOR, DEFAULT_WHEEL } from '../../../src/devices/indi/device'
import { readImageFromBuffer } from '../../../src/imaging/model/image'
import { debayer } from '../../../src/imaging/processing/debayer'
import type { FitsHeader } from '../../../src/io/formats/fits/fits'
import { deg, hour } from '../../../src/math/units/angle'
import { download } from '../../download'
import { saveImageAndCompareHash } from '../../imaging/util'

const NOW = timeYMDHMS(2026, 2, 18, 12, 0, 0)

describe('make fits from image bytes', () => {
	// Small non-square images expose transposition, channel interleaving and endian mistakes without
	// image codecs or downloaded fixtures. Values below are the physical pixel values in FITS order.
	for (const channels of [1, 3]) {
		test.each([
			[6, 8, 1],
			[8, 16, 2],
			[9, 32, 4],
			[1, 16, 2],
			[2, 32, 4],
			[4, -32, 4],
			[3, -64, 8],
		] as const)(`pixel layout and signedness, ${channels} channels, transmission=%i`, (transmission, bitpix, bytes) => {
			const data = new ArrayBuffer(44 + 6 * channels * bytes)
			new Int32Array(data, 0, 11).set([1, 0, 1, 2, 44, transmission, transmission, channels === 1 ? 2 : 3, 2, 3, channels === 1 ? 0 : 3])
			const view = new DataView(data, 44)
			const signed = transmission === 1 || transmission === 2 || bitpix < 0
			for (let i = 0; i < 6 * channels; i++) {
				const value = (i === 0 && signed ? -1 : i + 1) * 7
				if (transmission === 6) view.setUint8(i, value)
				else if (transmission === 8) view.setUint16(i * bytes, value, true)
				else if (transmission === 9) view.setUint32(i * bytes, value, true)
				else if (transmission === 1) view.setInt16(i * bytes, value, true)
				else if (transmission === 2) view.setInt32(i * bytes, value, true)
				else if (transmission === 4) view.setFloat32(i * bytes, value, true)
				else view.setFloat64(i * bytes, value, true)
			}
			const fits = makeFitsFromImageBytes(data)
			expect(fits.length % 2880).toBe(0)
			const payload = new DataView(fits.buffer, fits.byteOffset + fits.length - 2880, 6 * channels * bytes)
			const actual: number[] = []
			const zero = transmission === 8 ? 32768 : transmission === 9 ? 2147483648 : 0
			for (let i = 0; i < 6 * channels; i++) actual.push(bitpix === 8 ? payload.getUint8(i) : bitpix === 16 ? payload.getInt16(i * bytes) + zero : bitpix === 32 ? payload.getInt32(i * bytes) + zero : bitpix === -32 ? payload.getFloat32(i * bytes) : payload.getFloat64(i * bytes))
			const first = signed ? -7 : 7
			expect(actual).toEqual(channels === 1 ? [first, 28, 14, 35, 21, 42] : [first, 70, 28, 91, 49, 112, 14, 77, 35, 98, 56, 119, 21, 84, 42, 105, 63, 126])
			expect(Array.from(fits.subarray(fits.length - 2880 + 6 * channels * bytes)).every((value) => value === 0)).toBeTrue()
		})
	}

	test.each([
		[2, 100000, 100000, 0],
		[3, 2, 2, 2],
		[1, 2, 2, 0],
		[2, -1, 2, 0],
	] as const)('rejects malformed dimensions before allocating pixels (%i %i %i %i)', (rank, width, height, depth) => {
		const data = new ArrayBuffer(48)
		new Int32Array(data, 0, 11).set([1, 0, 0, 0, 44, 6, 6, rank, width, height, depth])
		expect(() => makeFitsFromImageBytes(data)).toThrow()
	})

	test.each([0, 5, 7])('rejects unsupported transmission type %i', (transmission) => {
		const data = new ArrayBuffer(64)
		new Int32Array(data, 0, 11).set([1, 0, 0, 0, 48, transmission, transmission, 2, 1, 1, 0])
		expect(() => makeFitsFromImageBytes(data)).toThrow('unsupported ImageBytes transmission type')
	})

	test('converts a 10 by 10 byte ROI smaller than 176 bytes', async () => {
		const data = new ArrayBuffer(144)
		new Int32Array(data, 0, 11).set([1, 0, 1, 2, 44, 1, 6, 2, 10, 10, 0])
		new Uint8Array(data, 44).fill(255)
		const image = await readImageFromBuffer(makeFitsFromImageBytes(data))
		expectNaxis(image!.header, 2, 10, 10, undefined)
		expect(image!.header.BITPIX).toBe(8)
		expect(image!.raw.length).toBe(100)
		expect(image!.raw.every((pixel) => pixel === 1)).toBeTrue()
	})

	test('rejects incomplete headers, error responses and out-of-buffer offsets', () => {
		expect(() => makeFitsFromImageBytes(new ArrayBuffer(43))).toThrow('incomplete ImageBytes header')
		const data = new ArrayBuffer(44)
		const header = new Int32Array(data)
		header.set([1, 1025, 0, 0, 44, 1, 6, 2, 1, 1, 0])
		expect(() => makeFitsFromImageBytes(data)).toThrow('ImageBytes error 1025')
		header[1] = 0
		header[4] = 45
		expect(() => makeFitsFromImageBytes(data)).toThrow('invalid ImageBytes data offset')
	})

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

	test('stamps observation and auxiliary-device metadata without large fixtures', async () => {
		const data = new ArrayBuffer(48)
		new Int32Array(data, 0, 11).set([1, 0, 1, 2, 44, 6, 6, 2, 2, 2, 0])
		const wheel = { ...structuredClone(DEFAULT_WHEEL), names: ['Red', 'Green'], position: 1 }
		const focuser = structuredClone(DEFAULT_FOCUSER)
		focuser.position.value = 12345
		focuser.hasThermometer = true
		focuser.temperature = 12.5
		const rotator = structuredClone(DEFAULT_ROTATOR)
		rotator.angle.value = 42
		const fits = makeFitsFromImageBytes(data, NOW, camera, mount, wheel, focuser, rotator, 5)
		const image = await readImageFromBuffer(fits)
		expectHeader(image!.header)
		expect(image!.header).toMatchObject({ FILTER: 'Green', FOCUSPOS: 12345, FOCUSTEM: 12.5, ROTATANG: 42, EXPTIME: 5, EQUINOX: 2000 })
		expect(new Uint8Array(data, 44)).toEqual(new Uint8Array(4))
		const disconnected = await readImageFromBuffer(makeFitsFromImageBytes(data, NOW, { ...camera, connected: false }, { ...mount, connected: false }))
		expect(disconnected!.header.INSTRUME).toBeUndefined()
		expect(disconnected!.header.TELESCOP).toBeUndefined()
	})

	// Real megapixel fixtures and native image encoding are intentionally outside the fast suite.
	test('unsigned 16-bit mono', async () => {
		const bytes = await download('Sky Simulator.8.1.dat')
		const fits = makeFitsFromImageBytes(await bytes.arrayBuffer(), NOW, camera, mount, undefined, undefined, undefined, 5)
		const image = await readImageFromBuffer(fits)
		expectNaxis(image!.header, 2, 1280, 1024, undefined)
		expectHeader(image!.header)
		await saveImageAndCompareHash(image!, 'alpaca.8.1', '7a8ffdcd833765af2e783fcce9e5e9af')
	}, 3000)

	test('unsigned 16-bit color (bayered)', async () => {
		const bytes = await download('Sky Simulator.8.3.dat')
		const fits = makeFitsFromImageBytes(await bytes.arrayBuffer(), NOW, camera, mount, undefined, undefined, undefined, 5)
		const image = await readImageFromBuffer(fits)
		expectNaxis(image!.header, 2, 1280, 1024, undefined)
		expectHeader(image!.header)
		await saveImageAndCompareHash(debayer(image!, 'RGGB')!, 'alpaca.8.3', '428add70df1895f245a20a5f7f8ca098')
	}, 3000)

	for (const bitpix of [8, 16, 32, -32, -64] as const) {
		for (const channel of [1, 3] as const) {
			test(`write and read, bitpix = ${bitpix}, channel = ${channel}`, async () => {
				const buffer = await (await download(`NGC3372-${bitpix}.${channel}.fit`)).arrayBuffer()
				const bytes = makeImageBytesFromFits(Buffer.from(buffer))
				const fits = makeFitsFromImageBytes(bytes.buffer)
				expect(fits.byteLength % 2880).toBe(0)
				const image = await readImageFromBuffer(fits)
				const hash = channel === 1 ? 'c754bf834dc1bb3948ec3cf8b9aca303' : '1ca5a4dd509ee4c67e3a2fbca43f81d4'
				await saveImageAndCompareHash(image!, `fitsfromimagebytes-${bitpix}-${channel}`, hash)
			})
		}
	}
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
