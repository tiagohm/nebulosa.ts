import { expect, test } from 'bun:test'
import { backgroundNeutralization } from '../../../src/imaging/processing/neutralization'
import { expectImageValues, makeImage } from './util'

test('backgroundNeutralization uses a lower-exclusive and upper-inclusive significance interval', () => {
	const image = makeImage(2, 1, 3, [0.1, 0.2, 0.3, 0.5, 0.6, 0.7])
	backgroundNeutralization(image, { lowerLimit: 0.1, upperLimit: 0.7, mode: 'targetBackground', targetBackground: 0.4 })
	expectImageValues(image, [0, 0.2, 0.2, 0.4, 0.6, 0.6], 6)
})

test('backgroundNeutralization rescale mode remaps the full image range to [0,1]', () => {
	const image = makeImage(2, 1, 3, [0.2, 0.4, 0.6, 0.3, 0.5, 0.7])
	backgroundNeutralization(image, { mode: 'rescale' })
	expectImageValues(image, [0, 0, 0, 1, 1, 1], 6)
})

test('backgroundNeutralization rescaleAsNeeded rescales when whole-image neutralization produces negatives', () => {
	const image = makeImage(2, 1, 3, [0.1, 0.2, 0.3, 0.5, 0.6, 0.7])
	backgroundNeutralization(image, { mode: 'rescaleAsNeeded' })
	expectImageValues(image, [0, 0, 0, 1, 1, 1], 6)
})

test('backgroundNeutralization defaults should not include negative calibrated backgrounds in the reference set', () => {
	const image = makeImage(2, 1, 3, [-0.3, -0.2, -0.1, -0.2, -0.1, 0])
	expect(() => backgroundNeutralization(image)).toThrow('background neutralization requires at least one significant RED sample in the reference area')
})

test('backgroundNeutralization rescaleAsNeeded rescales when neutralization only overflows above one', () => {
	const image = makeImage(3, 1, 3, [-0.2, -0.2, -0.2, -0.2, -0.2, -0.2, 1.1, 1.1, 1.1])
	backgroundNeutralization(image, { lowerLimit: -1, upperLimit: 2, mode: 'rescaleAsNeeded' })
	expectImageValues(image, [0, 0, 0, 0, 0, 0, 1, 1, 1], 6)
})

test('backgroundNeutralization truncate mode clamps without rescaling', () => {
	const image = makeImage(2, 1, 3, [0.2, 0.4, 0.6, 0.3, 0.5, 0.7])
	backgroundNeutralization(image, { mode: 'truncate' })
	expectImageValues(image, [0, 0, 0, 0.05, 0.05, 0.05], 6)
})

test('backgroundNeutralization is a no-op on monochrome images', () => {
	const image = makeImage(2, 2, 1, [0.1, 0.2, 0.3, 0.4])
	const before = new Float32Array(image.raw)

	expect(backgroundNeutralization(image)).toBe(image)
	expectImageValues(image, before, 8)
})

test('backgroundNeutralization rejects reference regions without significant samples', () => {
	const image = makeImage(2, 1, 3, [0.9, 0.8, 0.7, 0.95, 0.85, 0.75])
	expect(() => backgroundNeutralization(image, { upperLimit: 0.5 })).toThrow('background neutralization requires at least one significant RED sample in the reference area')
})
