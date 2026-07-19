import { expect, test } from 'bun:test'
import { calibrate, type CalibrationOptions } from '../../../src/imaging/processing/calibration'
import { expectImageValues, makeImage } from './util'

test('calibrate subtracts an exposure-matched raw dark and normalizes by a bias-corrected flat', () => {
	const light = makeImage(2, 1, 1, [0.6, 0.4], { EXPTIME: 30 })
	const dark = makeImage(2, 1, 1, [0.1, 0.1], { EXPTIME: 30 })
	const flat = makeImage(2, 1, 1, [0.4, 0.8])
	const bias = makeImage(2, 1, 1, [0.05, 0.05])

	expect(calibrate(light, { dark, flat, bias })).toBe(light)
	expectImageValues(light, [0.7857142857142858, 0.22], 6)
})

test('calibrate subtracts only bias when it is the sole calibration frame', () => {
	const light = makeImage(2, 1, 1, [0.6, 0.4])
	const bias = makeImage(2, 1, 1, [0.1, 0.05])

	calibrate(light, { bias })

	expectImageValues(light, [0.5, 0.35], 6)
})

test('calibrate subtracts a raw dark directly when exposure times match', () => {
	const light = makeImage(2, 1, 1, [0.6, 0.4], { EXPTIME: 30 })
	const dark = makeImage(2, 1, 1, [0.1, 0.2], { EXPTIME: 30 })

	calibrate(light, { dark })

	expectImageValues(light, [0.5, 0.2], 8)
})

test('calibrate scales only bias-corrected dark current when exposure times differ', () => {
	const light = makeImage(2, 1, 1, [0.41, 0.7], { EXPTIME: 30 })
	const dark = makeImage(2, 1, 1, [0.07, 0.1], { EXPTIME: 10 })
	const bias = makeImage(2, 1, 1, [0.05, 0.04])

	calibrate(light, { dark, bias })

	// (L - B) - (D - B) * (TL / TD)
	expectImageValues(light, [0.3, 0.48], 7)
})

test('calibrate honors EXPOSURE as the exposure-time fallback', () => {
	const light = makeImage(1, 1, 1, [0.41], { EXPOSURE: 30 })
	const dark = makeImage(1, 1, 1, [0.07], { EXPOSURE: 10 })
	const bias = makeImage(1, 1, 1, [0.05])

	calibrate(light, { dark, bias })

	expectImageValues(light, [0.3], 7)
})

test('calibrate preserves negative residuals instead of clipping noise at zero', () => {
	const light = makeImage(2, 1, 1, [0.04, 0.06], { EXPTIME: 10 })
	const dark = makeImage(2, 1, 1, [0.05, 0.05], { EXPTIME: 10 })

	calibrate(light, { dark })

	expectImageValues(light, [-0.01, 0.01], 7)
})

test('calibrate permits results above one without clipping', () => {
	const light = makeImage(2, 1, 1, [0.8, 0.4])
	const flat = makeImage(2, 1, 1, [0.4, 1.2])

	calibrate(light, { flat })

	expectImageValues(light, [1.6, 0.26666666666666666], 7)
})

test('calibrate can disable exposure scaling for known exposure-matched or non-linear darks', () => {
	const light = makeImage(2, 1, 1, [0.6, 0.4])
	const dark = makeImage(2, 1, 1, [0.1, 0.2])

	calibrate(light, { dark, darkScaling: 'none' })

	expectImageValues(light, [0.5, 0.2], 8)
})

test('calibrate rejects missing exposure metadata when exposure scaling is enabled', () => {
	const light = makeImage(1, 1, 1, [0.6])
	const dark = makeImage(1, 1, 1, [0.1])
	const before = new Float32Array(light.raw)

	expect(() => calibrate(light, { dark })).toThrow('light requires a finite positive EXPTIME or EXPOSURE')
	expect(light.raw).toEqual(before)
})

test('calibrate rejects non-positive exposure metadata', () => {
	const light = makeImage(1, 1, 1, [0.6], { EXPTIME: 0 })
	const dark = makeImage(1, 1, 1, [0.1], { EXPTIME: 10 })

	expect(() => calibrate(light, { dark })).toThrow('light requires a finite positive EXPTIME or EXPOSURE')
})

test('calibrate requires bias to scale a raw dark to another exposure', () => {
	const light = makeImage(1, 1, 1, [0.6], { EXPTIME: 30 })
	const dark = makeImage(1, 1, 1, [0.1], { EXPTIME: 10 })

	expect(() => calibrate(light, { dark })).toThrow('dark exposure differs from light; a bias master is required for exposure scaling')
})

test('calibrate applies flat normalization without dark or bias frames', () => {
	const light = makeImage(2, 1, 1, [0.6, 0.4])
	const flat = makeImage(2, 1, 1, [0.4, 0.8])

	calibrate(light, { flat })

	expectImageValues(light, [0.9, 0.3], 6)
})

test('calibrate normalizes each interleaved color channel independently', () => {
	const light = makeImage(2, 1, 3, [0.4, 0.4, 0.4, 0.4, 0.4, 0.4])
	const flat = makeImage(2, 1, 3, [0.5, 1, 1, 2, 0.25, 0.5])

	calibrate(light, { flat })

	expectImageValues(light, [1, 0.25, 0.3, 0.25, 1, 0.6], 7)
})

test('calibrate applies bias-corrected flat means to interleaved RGB channels', () => {
	const light = makeImage(2, 1, 3, [0.45, 0.65, 0.85, 0.85, 0.45, 0.25])
	const flat = makeImage(2, 1, 3, [0.55, 1.05, 0.3, 1.05, 0.55, 0.55])
	const bias = makeImage(2, 1, 3, [0.05, 0.05, 0.05, 0.05, 0.05, 0.05])

	calibrate(light, { flat, bias })

	expectImageValues(light, [0.6, 0.45, 1.2, 0.6, 0.6, 0.15], 7)
})

test('calibrate normalizes each CFA phase independently', () => {
	const light = makeImage(4, 2, 1, [0.4, 0.4, 0.4, 0.4, 0.4, 0.4, 0.4, 0.4], { BAYERPAT: 'RGGB' })
	const flat = makeImage(4, 2, 1, [0.5, 1, 1, 2, 1.5, 0.25, 3, 0.5], { BAYERPAT: 'RGGB' })

	calibrate(light, { flat })

	expectImageValues(light, [0.6, 0.6, 0.3, 0.3, 0.6, 0.6, 0.3, 0.3], 7)
})

test('calibrate handles CFA phases absent from a small image', () => {
	const light = makeImage(1, 1, 1, [0.4], { BAYERPAT: 'RGGB' })
	const flat = makeImage(1, 1, 1, [0.5], { BAYERPAT: 'RGGB' })

	calibrate(light, { flat })

	expectImageValues(light, [0.4], 7)
})

test('calibrate subtracts an exposure-matched dark-flat without separately subtracting bias', () => {
	const light = makeImage(2, 1, 1, [0.8, 0.4])
	const flat = makeImage(2, 1, 1, [0.5, 1], { EXPTIME: 2 })
	const darkFlat = makeImage(2, 1, 1, [0.1, 0.2], { EXPTIME: 2 })

	calibrate(light, { flat, darkFlat })

	expectImageValues(light, [1.2, 0.3], 6)
})

test('calibrate scales bias-corrected dark-flat current to the flat exposure', () => {
	const light = makeImage(2, 1, 1, [0.49, 0.83])
	const flat = makeImage(2, 1, 1, [0.55, 0.95], { EXPTIME: 30 })
	const bias = makeImage(2, 1, 1, [0.05, 0.05])
	const darkFlat = makeImage(2, 1, 1, [0.07, 0.09], { EXPTIME: 10 })

	calibrate(light, { flat, bias, darkFlat })

	// Corrected flat is [0.44, 0.78], whose mean is 0.61.
	expectImageValues(light, [0.61, 0.61], 7)
})

test('calibrate requires bias to scale a dark-flat to another exposure', () => {
	const light = makeImage(1, 1, 1, [0.4])
	const flat = makeImage(1, 1, 1, [0.8], { EXPTIME: 2 })
	const darkFlat = makeImage(1, 1, 1, [0.1], { EXPTIME: 1 })

	expect(() => calibrate(light, { flat, darkFlat })).toThrow('darkFlat exposure differs from flat; a bias master is required for exposure scaling')
})

test('calibrate rejects a dark-flat without a flat master', () => {
	const light = makeImage(1, 1, 1, [0.4])
	const darkFlat = makeImage(1, 1, 1, [0.1])

	expect(() => calibrate(light, { darkFlat })).toThrow('darkFlat requires a flat master')
})

test('calibrate rejects zero corrected-flat samples before mutating the light', () => {
	const light = makeImage(2, 1, 1, [0.2, 0.4])
	const flat = makeImage(2, 1, 1, [0, 1])
	const before = new Float32Array(light.raw)

	expect(() => calibrate(light, { flat })).toThrow('corrected flat sample 0 must be finite and greater than 0: 0')
	expect(light.raw).toEqual(before)
})

test('calibrate rejects corrected-flat samples at the configured floor', () => {
	const light = makeImage(2, 1, 1, [0.2, 0.4])
	const flat = makeImage(2, 1, 1, [0.01, 1])

	expect(() => calibrate(light, { flat, minimumFlat: 0.01 })).toThrow('corrected flat sample 0 must be finite and greater than 0.01')
})

test('calibrate rejects non-finite corrected-flat samples', () => {
	const light = makeImage(2, 1, 1, [0.2, 0.4])
	const flat = makeImage(2, 1, 1, [Number.NaN, 1])

	expect(() => calibrate(light, { flat })).toThrow('corrected flat sample 0 must be finite')
})

test('calibrate validates every master before mutating the light', () => {
	const light = makeImage(2, 1, 1, [0.6, 0.4], { EXPTIME: 10 })
	const dark = makeImage(2, 1, 1, [0.1, 0.1], { EXPTIME: 10 })
	const flat = makeImage(1, 1, 1, [0.5])
	const before = new Float32Array(light.raw)

	expect(() => calibrate(light, { dark, flat })).toThrow('flat width does not match light: 1 != 2')
	expect(light.raw).toEqual(before)
})

test('calibrate rejects channel-layout mismatches', () => {
	const light = makeImage(1, 1, 3, [0.1, 0.2, 0.3])
	const flat = makeImage(1, 1, 1, [0.5])

	expect(() => calibrate(light, { flat })).toThrow('flat channels do not match light: 1 != 3')
})

test('calibrate rejects a flat with another CFA phase layout', () => {
	const light = makeImage(2, 2, 1, [0.4, 0.4, 0.4, 0.4], { BAYERPAT: 'RGGB' })
	const flat = makeImage(2, 2, 1, [0.5, 0.5, 0.5, 0.5], { BAYERPAT: 'BGGR' })
	const before = new Float32Array(light.raw)

	expect(() => calibrate(light, { flat })).toThrow('flat CFA pattern does not match light: BGGR != RGGB')
	expect(light.raw).toEqual(before)
})

test('calibrate requires CFA metadata on a flat for a CFA light', () => {
	const light = makeImage(2, 2, 1, [0.4, 0.4, 0.4, 0.4], { BAYERPAT: 'RGGB' })
	const flat = makeImage(2, 2, 1, [0.5, 0.5, 0.5, 0.5])

	expect(() => calibrate(light, { flat })).toThrow('flat CFA pattern does not match light: none != RGGB')
})

test('calibrate permits CFA-neutral masters without Bayer metadata', () => {
	const light = makeImage(2, 2, 1, [0.4, 0.4, 0.4, 0.4], { BAYERPAT: 'RGGB', EXPTIME: 10 })
	const dark = makeImage(2, 2, 1, [0.1, 0.1, 0.1, 0.1], { EXPTIME: 10 })

	calibrate(light, { dark })

	expectImageValues(light, [0.3, 0.3, 0.3, 0.3], 7)
})

test('calibrate rejects conflicting CFA metadata on a dark master', () => {
	const light = makeImage(2, 2, 1, [0.4, 0.4, 0.4, 0.4], { BAYERPAT: 'RGGB', EXPTIME: 10 })
	const dark = makeImage(2, 2, 1, [0.1, 0.1, 0.1, 0.1], { BAYERPAT: 'BGGR', EXPTIME: 10 })

	expect(() => calibrate(light, { dark })).toThrow('dark CFA pattern does not match light: BGGR != RGGB')
})

test('calibrate rejects unsupported CFA metadata', () => {
	const light = makeImage(2, 2, 1, [0.4, 0.4, 0.4, 0.4], { BAYERPAT: 'XXXX' })
	const flat = makeImage(2, 2, 1, [0.5, 0.5, 0.5, 0.5], { BAYERPAT: 'XXXX' })

	expect(() => calibrate(light, { flat })).toThrow('light has unsupported CFA pattern: XXXX')
})

test('calibrate rejects known subframe-origin mismatches', () => {
	const light = makeImage(2, 1, 1, [0.4, 0.4], { XORGSUBF: 10 })
	const flat = makeImage(2, 1, 1, [0.5, 0.5], { XORGSUBF: 11 })

	expect(() => calibrate(light, { flat })).toThrow('flat XORGSUBF does not match light: 11 != 10')
})

test('calibrate rejects known binning and readout mismatches', () => {
	const light = makeImage(2, 1, 1, [0.4, 0.4], { XBINNING: 1, GAIN: 100 })
	const flatBinning = makeImage(2, 1, 1, [0.5, 0.5], { XBINNING: 2, GAIN: 100 })
	const flatGain = makeImage(2, 1, 1, [0.5, 0.5], { XBINNING: 1, GAIN: 200 })

	expect(() => calibrate(light, { flat: flatBinning })).toThrow('flat XBINNING does not match light: 2 != 1')
	expect(() => calibrate(light, { flat: flatGain })).toThrow('flat GAIN does not match light: 200 != 100')
})

test('calibrate rejects raw buffers inconsistent with metadata', () => {
	const light = makeImage(2, 1, 1, [0.1])
	const bias = makeImage(2, 1, 1, [0.05, 0.05])

	expect(() => calibrate(light, { bias })).toThrow('light raw length does not match metadata: 1 != 2')
})

test('calibrate rejects invalid numerical policies', () => {
	const light = makeImage(1, 1, 1, [0.2])

	expect(() => calibrate(light, { minimumFlat: -1 })).toThrow('minimumFlat must be finite and non-negative')
	expect(() => calibrate(light, { darkScaling: 'invalid' } as unknown as CalibrationOptions)).toThrow('unsupported dark scaling: invalid')
})

test('calibrate leaves the image unchanged when no calibration frames are provided', () => {
	const light = makeImage(2, 1, 1, [0.2, 0.8])
	const before = new Float32Array(light.raw)

	expect(calibrate(light)).toBe(light)
	expectImageValues(light, before, 8)
})
