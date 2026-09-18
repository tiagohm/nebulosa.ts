import { expect, test } from 'bun:test'
import { preprocessStreakImage } from '../../../../src/imaging/analysis/streak/preprocess'
import type { Image } from '../../../../src/imaging/model/types'

function image(raw: Float32Array | Float64Array, width: number, height: number, channels: 1 | 3 = 1, bayer?: Image['metadata']['bayer']): Image {
	const bytes = raw.BYTES_PER_ELEMENT
	return { raw, header: {}, metadata: { width, height, channels, stride: width * channels, pixelCount: width * height, strideInBytes: width * channels * bytes, pixelSizeInBytes: bytes, bitpix: bytes === 8 ? -64 : -32, bayer } }
}

test('auto-selects green from interleaved RGB', () => {
	const raw = new Float32Array(16 * 16 * 3)
	for (let i = 0; i < 16 * 16; i++) {
		raw[i * 3] = 1
		raw[i * 3 + 1] = 4
		raw[i * 3 + 2] = 9
	}
	raw[(8 * 16 + 8) * 3 + 1] = 10
	const prepared = preprocessStreakImage(image(raw, 16, 16, 3), { backgroundCellSize: 8 })
	expect(prepared.plane).toBe('green')
	expect(prepared.workspace.signal[8 * 16 + 8]).toBeCloseTo(6, 6)
})

test('maps native CFA green1 grid with step two and ROI parity', () => {
	const raw = new Float64Array(18 * 18).fill(0.2)
	const prepared = preprocessStreakImage(image(raw, 18, 18, 1, 'RGGB'), { area: { left: 1, top: 1, right: 18, bottom: 18 }, backgroundCellSize: 8 })
	expect(prepared.plane).toBe('green1')
	expect(prepared.grid.sourceLeft).toBe(1)
	expect(prepared.grid.sourceTop).toBe(2)
	expect(prepared.grid.step).toBe(2)
	expect(prepared.grid.width).toBe(9)
	expect(prepared.grid.height).toBe(8)
})

test('supports explicit RGB and CFA planes and both precisions', () => {
	const rgb = new Float64Array(16 * 16 * 3).fill(0.5)
	expect(preprocessStreakImage(image(rgb, 16, 16, 3), { plane: 'red', backgroundCellSize: 8 }).plane).toBe('red')
	const cfa = new Float32Array(16 * 16).fill(0.5)
	expect(preprocessStreakImage(image(cfa, 16, 16, 1, 'BGGR'), { plane: 'green2', backgroundCellSize: 8 }).plane).toBe('green2')
})
