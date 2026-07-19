import { expect, test } from 'bun:test'
import type { Image } from '../../../src/imaging/model/types'
import { checkDimensions, clone, copyInto, divide, divideScalar, multiply, multiplyScalar, plus, plusScalar, subtract, subtractScalar } from '../../../src/imaging/processing/arithmetic'
import { expectImageValues, makeImage } from './util'

test('clone preserves image properties, precision, and independent storage', () => {
	const source: Image = { ...makeImage(2, 1, 1, [0, 0]), sampleScale: 'normalized', raw: new Float64Array([0.1, 0.2]) }
	const copy = clone(source)

	expect(copy).not.toBe(source)
	expect(copy.sampleScale).toBe('normalized')
	expect(copy.header).not.toBe(source.header)
	expect(copy.metadata).not.toBe(source.metadata)
	expect(copy.raw).toBeInstanceOf(Float64Array)
	expect(copy.raw).not.toBe(source.raw)
	expect(copy.raw).toEqual(source.raw)

	copy.header.OBJECT = 'copy'
	copy.raw[0] = 0.9
	expect(source.header.OBJECT).toBeUndefined()
	expect(source.raw[0]).toBe(0.1)
})

test('copyInto copies between precisions and returns the destination', () => {
	const source = makeImage(2, 1, 1, [0.25, 0.75])
	const destination: Image = { ...makeImage(2, 1, 1, [0, 0]), raw: new Float64Array(2) }

	expect(copyInto(source, destination)).toBe(destination)
	expect(destination.raw).toEqual(new Float64Array([0.25, 0.75]))
})

test('copyInto handles shifted views of the same buffer', () => {
	const storage = new Float32Array([1, 2, 3])
	const source = makeImage(2, 1, 1, storage.subarray(0, 2))
	const destination = makeImage(2, 1, 1, storage.subarray(1, 3))

	copyInto(source, destination)

	expect(storage).toEqual(new Float32Array([1, 1, 2]))
})

test('checkDimensions validates geometry, buffers, and CFA phase', () => {
	const valid = makeImage(2, 1, 1, [0.1, 0.2])
	const badWidth = makeImage(1, 1, 1, [0.1])
	const badHeight = makeImage(2, 2, 1, [0.1, 0.2, 0.3, 0.4])
	const badChannels = makeImage(2, 1, 3, [0, 0, 0, 0, 0, 0])
	const badPixelCount: Image = { ...valid, metadata: { ...valid.metadata, pixelCount: 3 } }
	const badRaw = makeImage(2, 1, 1, [0.1])
	const rggb = makeImage(2, 1, 1, [0.1, 0.2], { BAYERPAT: 'RGGB' })
	const bggr = makeImage(2, 1, 1, [0.1, 0.2], { BAYERPAT: 'BGGR' })

	expect(() => checkDimensions(valid, badWidth)).toThrow('width does not match: 2 != 1')
	expect(() => checkDimensions(valid, badHeight)).toThrow('height does not match: 1 != 2')
	expect(() => checkDimensions(valid, badChannels)).toThrow('channels do not match: 1 != 3')
	expect(() => checkDimensions(badPixelCount, valid)).toThrow('first image pixelCount does not match geometry: 3 != 2')
	expect(() => checkDimensions(valid, badRaw)).toThrow('second image raw length does not match metadata: 1 != 2')
	expect(() => checkDimensions(rggb, bggr)).toThrow('CFA patterns do not match: RGGB != BGGR')
})

test('checkDimensions treats an empty mono CFA keyword as absent', () => {
	const plain = makeImage(1, 1, 1, [0.1])
	const empty = makeImage(1, 1, 1, [0.1], { BAYERPAT: '' })

	expect(() => checkDimensions(plain, empty)).not.toThrow()
})

test('checkDimensions rejects invalid image metadata and CFA channel storage', () => {
	const valid = makeImage(1, 1, 1, [0.1])
	const badWidth: Image = { ...valid, metadata: { ...valid.metadata, width: 0, pixelCount: 0 }, raw: new Float32Array(0) }
	const badHeight: Image = { ...valid, metadata: { ...valid.metadata, height: Number.NaN } }
	const badChannels: Image = { ...valid, metadata: { ...valid.metadata, channels: 0 }, raw: new Float32Array(0) }
	const badCfaChannels = makeImage(1, 1, 3, [0.1, 0.2, 0.3], { BAYERPAT: 'RGGB' })

	expect(() => checkDimensions(badWidth, valid)).toThrow('first image width must be a positive integer: 0')
	expect(() => checkDimensions(badHeight, valid)).toThrow('first image height must be a positive integer: NaN')
	expect(() => checkDimensions(badChannels, valid)).toThrow('first image channels must be a positive integer: 0')
	expect(() => checkDimensions(badCfaChannels, badCfaChannels)).toThrow('first image CFA data must have one channel: 3')
})

test('binary arithmetic preserves signed and out-of-range results', () => {
	const a = makeImage(3, 1, 1, [0.8, -0.5, 0.25])
	const b = makeImage(3, 1, 1, [0.5, 0.25, -0.5])

	expectImageValues(plus(a, b, makeImage(3, 1, 1, [0, 0, 0])), [1.3, -0.25, -0.25], 7)
	expectImageValues(subtract(a, b, makeImage(3, 1, 1, [0, 0, 0])), [0.3, -0.75, 0.75], 7)
	expectImageValues(multiply(a, b, makeImage(3, 1, 1, [0, 0, 0])), [0.4, -0.125, -0.125], 7)
})

test('binary arithmetic supports exact aliasing with either operand', () => {
	const a = makeImage(2, 1, 1, [0.2, 0.4])
	const b = makeImage(2, 1, 1, [0.1, 0.3])

	expect(plus(a, b, a)).toBe(a)
	expectImageValues(a, [0.3, 0.7], 7)

	const c = makeImage(2, 1, 1, [0.2, 0.4])
	const d = makeImage(2, 1, 1, [0.1, 0.3])
	expect(subtract(c, d, d)).toBe(d)
	expectImageValues(d, [0.1, 0.1], 7)
})

test('scalar arithmetic preserves signed and out-of-range results', () => {
	const image = makeImage(3, 1, 1, [0.8, -0.5, 0.25])

	expectImageValues(plusScalar(image, 0.5, makeImage(3, 1, 1, [0, 0, 0])), [1.3, 0, 0.75], 7)
	expectImageValues(subtractScalar(image, 0.5, makeImage(3, 1, 1, [0, 0, 0])), [0.3, -1, -0.25], 7)
	expectImageValues(multiplyScalar(image, -2, makeImage(3, 1, 1, [0, 0, 0])), [-1.6, 1, -0.5], 7)
	expectImageValues(divideScalar(image, 2, makeImage(3, 1, 1, [0, 0, 0])), [0.4, -0.25, 0.125], 7)
})

test('scalar arithmetic rejects non-finite scalars before mutation', () => {
	const operations = [plusScalar, subtractScalar, multiplyScalar, divideScalar]
	for (const operation of operations) {
		for (const scalar of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
			const image = makeImage(1, 1, 1, [0.5])
			expect(() => operation(image, scalar)).toThrow('scalar must be finite')
			expectImageValues(image, [0.5], 8)
		}
	}
})

test('divide and divideScalar produce finite direct quotients', () => {
	const numerator = makeImage(2, 1, 1, [0.6, -0.9])
	const divisor = makeImage(2, 1, 1, [0.2, -0.3])

	expectImageValues(divide(numerator, divisor, makeImage(2, 1, 1, [0, 0])), [3, 3], 6)
	expectImageValues(divideScalar(numerator, -0.3, makeImage(2, 1, 1, [0, 0])), [-2, 3], 6)
})

test('divideScalar rejects zero before mutation', () => {
	const image = makeImage(1, 1, 1, [0.5])

	expect(() => divideScalar(image, 0)).toThrow('scalar must be non-zero: 0')
	expectImageValues(image, [0.5], 8)
})

test('arithmetic rejects partially overlapping output views', () => {
	const storage = new Float32Array([1, 2, 3])
	const source = makeImage(2, 1, 1, storage.subarray(0, 2))
	const shiftedOutput = makeImage(2, 1, 1, storage.subarray(1, 3))
	const other = makeImage(2, 1, 1, [1, 1])

	expect(() => plus(source, other, shiftedOutput)).toThrow('first image and output raw buffers partially overlap')
	expect(() => plusScalar(source, 1, shiftedOutput)).toThrow('image and output raw buffers partially overlap')
	expect(storage).toEqual(new Float32Array([1, 2, 3]))
})
