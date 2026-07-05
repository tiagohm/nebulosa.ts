import { expect, test } from 'bun:test'
import { calibrate } from '../../../src/imaging/processing/calibration'
import { expectImageValues, makeImage } from './util'

test('calibrate subtracts dark current and normalizes by a bias-corrected flat', () => {
	const light = makeImage(2, 1, 1, [0.6, 0.4])
	const dark = makeImage(2, 1, 1, [0.1, 0.1])
	const flat = makeImage(2, 1, 1, [0.4, 0.8])
	const bias = makeImage(2, 1, 1, [0.05, 0.05])

	calibrate(light, dark, flat, bias)

	expectImageValues(light, [0.7857142857142858, 0.22], 6)
})

test('calibrate subtracts only bias when it is the sole calibration frame', () => {
	const light = makeImage(2, 1, 1, [0.6, 0.4])
	const bias = makeImage(2, 1, 1, [0.1, 0.05])

	calibrate(light, undefined, undefined, bias)

	expectImageValues(light, [0.5, 0.35], 6)
})

test('calibrate subtracts dark frames directly when exposure times match', () => {
	const light = makeImage(2, 1, 1, [0.6, 0.4])
	const dark = makeImage(2, 1, 1, [0.1, 0.2])

	calibrate(light, dark)

	expectImageValues(light, [0.5, 0.2], 8)
})

test('calibrate applies flat normalization even without dark or bias frames', () => {
	const light = makeImage(2, 1, 1, [0.6, 0.4])
	const flat = makeImage(2, 1, 1, [0.4, 0.8])

	calibrate(light, undefined, flat)

	expectImageValues(light, [0.9, 0.3], 6)
})

test('calibrate subtracts dark-flat from flat normalization without bias', () => {
	const light = makeImage(2, 1, 1, [0.8, 0.4])
	const flat = makeImage(2, 1, 1, [0.5, 1])
	const darkFlat = makeImage(2, 1, 1, [0.1, 0.2])

	calibrate(light, undefined, flat, undefined, darkFlat)

	expectImageValues(light, [1.2, 0.3], 6)
})

test('calibrate rescales the dark background when exposure times differ', () => {
	const light = makeImage(1, 1, 1, [0.8])
	const dark = makeImage(1, 1, 1, [0.3])
	const bias = makeImage(1, 1, 1, [0.1])

	light.header.EXPTIME = 30
	dark.header.EXPTIME = 15

	calibrate(light, dark, undefined, bias)

	expect(light.raw[0]).toBeCloseTo(0.100008, 6)
})

test('calibrate leaves the image unchanged when no calibration frames are provided', () => {
	const light = makeImage(2, 1, 1, [0.2, 0.8])
	const before = new Float32Array(light.raw)

	expect(calibrate(light)).toBe(light)
	expectImageValues(light, before, 8)
})

test('calibrate propagates dimension mismatches from arithmetic steps', () => {
	const light = makeImage(2, 1, 1, [0.1, 0.2])
	const dark = makeImage(1, 1, 1, [0.1])

	expect(() => calibrate(light, dark)).toThrow('width does not match: 2 != 1')
})
