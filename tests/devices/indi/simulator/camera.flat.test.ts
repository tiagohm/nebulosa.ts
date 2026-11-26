import { describe, expect, test } from 'bun:test'
import { DEFAULT_CAMERA_SIMULATOR_CONFIG } from '../../../../src/devices/indi/simulator/camera.config'
import { CameraFlatField, renderCameraFlat } from '../../../../src/devices/indi/simulator/camera.flat'
import type { CameraReadoutState } from '../../../../src/devices/indi/simulator/camera.readout'
import { TestBus } from '../../../util/bus'

// Unit coverage of the flat-field illumination: fixed to the sensor across frames, subframes and binning.

const FLAT = { ...DEFAULT_CAMERA_SIMULATOR_CONFIG.flat, dustCount: 3, dustContrast: 0.3, dustSigmaX: 6, dustSigmaY: 6, rowAmplitude: 0.05, rowPeriod: 9 }

// Readout of a subframe of a 64 × 48 sensor.
function readout(x: number, y: number, width: number, height: number, binX: number = 1, binY: number = 1): CameraReadoutState {
	return { x, y, width, height, binX, binY, gain: 0, offset: 0, frameType: 'FLAT', readoutMode: 'MONO', channels: 1, transferFormat: 'FITS', imageWidth: Math.ceil(width / binX), imageHeight: Math.ceil(height / binY) }
}

// Renders the flat of `state` into a fresh buffer.
function render(state: CameraReadoutState, seed: number = 7) {
	const raw = new Float32Array(state.imageWidth * state.imageHeight)
	renderCameraFlat(raw, FLAT, state, 64, 48, seed, 1)
	return raw
}

describe('camera flat field', () => {
	test('puts the dust in the same place on every frame of a seed', () => {
		const full = readout(0, 0, 64, 48)
		expect(render(full)).toEqual(render(full))
		expect(render(full, 8)).not.toEqual(render(full))
	})

	test('keeps the illumination of a sensor pixel through a subframe', () => {
		const full = render(readout(0, 0, 64, 48))
		const sub = render(readout(10, 5, 20, 30))
		for (let y = 0; y < 30; y++) for (let x = 0; x < 20; x++) expect(sub[y * 20 + x]).toBeCloseTo(full[(y + 5) * 64 + x + 10], 5)
	})

	test('averages the illumination of the binned pixels', () => {
		const full = render(readout(0, 0, 64, 48))
		const binned = render(readout(0, 0, 64, 48, 2, 2))
		const average = (full[0] + full[1] + full[64] + full[65]) / 4
		expect(binned[0]).toBeCloseTo(average, 2)
	})

	test('publishes its settings and reads them back', () => {
		const bus = new TestBus()
		const flat = new CameraFlatField(bus, DEFAULT_CAMERA_SIMULATOR_CONFIG.flat)
		flat.handleNumber({ device: '', name: 'SIMULATOR_FLAT_DUST', elements: { COUNT: 5, CONTRAST: 0.5 } })
		expect(bus.take()).toEqual(['SIMULATOR_FLAT_DUST'])
		expect(flat.snapshot()).toMatchObject({ dustCount: 5, dustContrast: 0.5, referenceSignal: DEFAULT_CAMERA_SIMULATOR_CONFIG.flat.referenceSignal })
	})
})
