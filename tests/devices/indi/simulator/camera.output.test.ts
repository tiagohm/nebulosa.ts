import { describe, expect, test } from 'bun:test'
import { equatorialToJ2000 } from '../../../../src/astronomy/coordinates/coordinate'
import { timeUnix } from '../../../../src/astronomy/time/time'
import type { ExposurePointing } from '../../../../src/devices/indi/simulator/camera.links'
import { cameraFrameHeader, CameraOutput, encodeCameraFrame } from '../../../../src/devices/indi/simulator/camera.output'
import type { CameraReadoutState } from '../../../../src/devices/indi/simulator/camera.readout'
import { readImageFromBuffer } from '../../../../src/imaging/model/image'
import { deg, hour, toDeg } from '../../../../src/math/units/angle'
import { TestBus } from '../../../util/bus'

// Unit coverage of the camera's output: the header written from the exposure and the BLOB delivery.

const READOUT: CameraReadoutState = { x: 8, y: 4, width: 40, height: 20, binX: 2, binY: 1, gain: 50, offset: 7, frameType: 'DARK', readoutMode: 'MONO', channels: 1, transferFormat: 'FITS', imageWidth: 20, imageHeight: 20 }
// 2000-01-01T00:00:00Z on the mount's clock, which need not be the wall clock.
const START = 946684800000
const POINTING: ExposurePointing = { startTime: START, center: [hour(5), deg(20)], time: timeUnix(START / 1000, true), orientation: 0, mount: { name: 'Mount', latitude: deg(-23), longitude: deg(-46), pierSide: 'NEITHER' } }

describe('camera output', () => {
	test('describes the exposure that was taken', () => {
		const header = cameraFrameHeader({ instrument: 'Camera', pointing: POINTING, exposureTime: 2.5, readout: READOUT, pixelSize: 3.76, temperature: -10, accessories: { focuserPosition: 1234, focuserTemperature: 12, rotatorAngle: 45, filter: 'Ha' } })
		const [ra, dec] = equatorialToJ2000(hour(5), deg(20), POINTING.time)

		expect(header).toMatchObject({
			NAXIS: 2,
			NAXIS1: 20,
			NAXIS2: 20,
			INSTRUME: 'Camera',
			TELESCOP: 'Mount',
			EXPTIME: 2.5,
			XBINNING: 2,
			YBINNING: 1,
			GAIN: 50,
			OFFSET: 7,
			FRAME: 'DARK',
			IMAGETYP: 'Dark Frame',
			'CCD-TEMP': -10,
			XORGSUBF: 8,
			YORGSUBF: 4,
			FOCUSPOS: 1234,
			FOCUSTEM: 12,
			ROTATANG: 45,
			FILTER: 'Ha',
			EQUINOX: 2000,
		})
		expect(header.XPIXSZ).toBeCloseTo(7.52, 12)
		expect(header.RA).toBeCloseTo(toDeg(ra), 9)
		expect(header.DEC).toBeCloseTo(toDeg(dec), 9)
		expect(header.SITELAT).toBeCloseTo(-23, 12)
		expect(header['DATE-OBS']).toBe('2000-01-01T00:00:00.000')
		expect(header['DATE-END']).toBe('2000-01-01T00:00:02.500')
		expect(header.PIERSIDE).toBeUndefined()

		const unmounted = cameraFrameHeader({ instrument: 'Camera', pointing: { startTime: START, time: POINTING.time, orientation: 0 }, exposureTime: 1, readout: READOUT, pixelSize: 3.76, temperature: 0, accessories: {} })
		expect(unmounted.TELESCOP).toBeUndefined()
		expect(unmounted.RA).toBeUndefined()
		expect(unmounted.EQUINOX).toBeUndefined()
	})

	test('encodes a frame the image reader reads back', async () => {
		const raw = new Float32Array(400).map((_, i) => i / 400)
		const header = cameraFrameHeader({ instrument: 'Camera', pointing: POINTING, exposureTime: 1, readout: READOUT, pixelSize: 3.76, temperature: 0, accessories: {} })

		for (const format of ['FITS', 'XISF'] as const) {
			const image = await readImageFromBuffer(await encodeCameraFrame(raw, header, READOUT, 'RGGB', format))
			expect(image!.metadata.width).toBe(20)
			expect(image!.metadata.height).toBe(20)
			expect(image!.raw[399]).toBeCloseTo(399 / 400, 4)
		}
	})

	test('delivers a frame and follows the BLOB policy', () => {
		const delivered: string[] = []
		const output = new CameraOutput(new TestBus(), (property) => delivered.push(`${property.state} ${property.elements.CCD1.format} ${property.elements.CCD1.size}`))
		output.begin()
		expect(output.properties[0].state).toBe('Busy')
		output.deliver(Buffer.alloc(10), 'XISF')
		expect(delivered).toEqual(['Ok .xisf 10'])
		output.fail()
		expect(output.properties[0].state).toBe('Alert')
		expect(output.properties[0].elements.CCD1.value).toBeUndefined()

		output.enableBlob({ device: '', value: 'Only' })
		expect(output.onlyBlob).toBeTrue()
		output.enableBlob({ device: '', value: 'Never' })
		expect(output.ignoresBlob).toBeTrue()
		expect(output.onlyBlob).toBeFalse()
	})
})
