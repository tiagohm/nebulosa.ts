import { describe, expect, test } from 'bun:test'
import { makeFitsFromImageBytes } from '../src/alpaca.client'
import { deg, hour } from '../src/angle'
import type { FitsHeader } from '../src/fits'
import { readImageFromBuffer } from '../src/image'
import { debayer } from '../src/image.transformation'
import { DEFAULT_CAMERA, DEFAULT_MOUNT } from '../src/indi.device'
import { saveImageAndCompareHash } from './image.util'

const camera = structuredClone(DEFAULT_CAMERA)
const mount = structuredClone(DEFAULT_MOUNT)

camera.name = 'Camera'
camera.exposure.value = 5.04
camera.pixelSize.x = 2.5
camera.pixelSize.y = 2.5
camera.bin.x.value = 2
camera.bin.y.value = 2
camera.temperature = 25
camera.gain.value = 8
camera.offset.value = 3
mount.name = 'Mount'
mount.geographicCoordinate.longitude = deg(-45)
mount.geographicCoordinate.latitude = deg(-22)
mount.equatorialCoordinate.rightAscension = hour(22)
mount.equatorialCoordinate.declination = deg(-60)

describe('make fits from image bytes', () => {
	test('unsigned 16-bit mono', async () => {
		const bytes = Bun.file('data/Sky Simulator.8.1.dat')
		const fits = makeFitsFromImageBytes(await bytes.arrayBuffer(), camera, mount)
		const image = await readImageFromBuffer(fits)
		expectNaxis(image!.header, 2, 1280, 1024, undefined)
		expectHeader(image!.header)
		await saveImageAndCompareHash(image!, 'alpaca.8.1', '7a8ffdcd833765af2e783fcce9e5e9af')
		await Bun.write('Sky simulator.fits', fits)
	})

	test('unsigned 16-bit color (bayered)', async () => {
		const bytes = Bun.file('data/Sky Simulator.8.3.dat')
		const fits = makeFitsFromImageBytes(await bytes.arrayBuffer(), camera, mount)
		const image = await readImageFromBuffer(fits)
		expectNaxis(image!.header, 2, 1280, 1024, undefined)
		expectHeader(image!.header)
		await saveImageAndCompareHash(debayer(image!, 'RGGB')!, 'alpaca.8.3', '242f9a2336cb217b83570bb51f8616f2')
	})
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
	expect(header.OBJCTRA).toBe('22 00 00.00')
	expect(header.OBJCTDEC).toBe('-60 00 00.00')
	expect(header.RA).toBe(330)
	expect(header.DEC).toBeCloseTo(-60, 10)
	expect(header.GAIN).toBe(8)
	expect(header.OFFSET).toBe(3)
	expect(header['CCD-TEMP']).toBe(25)
}

test.skip('download from Sky Simulator', async () => {
	const response = await fetch('http://localhost:11111/api/v1/camera/0/imagearray', { headers: { Accept: 'application/imagebytes' } })
	await Bun.write('Sky Simulator.dat', await response.blob())
})
