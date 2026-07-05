import { test } from 'bun:test'
import { scnr } from '../../../src/imaging/processing/scnr'
import { expectImageValues, makeImage } from './processing.util'

test('scnr reduces the selected chroma channel while preserving the others', () => {
	const image = makeImage(1, 1, 3, [0.2, 0.9, 0.4])
	scnr(image, 'GREEN', 1, 'MAXIMUM_MASK')
	expectImageValues(image, [0.2, 0.36, 0.4], 6)
})

test('scnr neutral protection methods limit the target channel independently of amount', () => {
	const image = makeImage(1, 1, 3, [0.8, 0.2, 0.6])
	scnr(image, 'RED', 0.1, 'AVERAGE_NEUTRAL')
	expectImageValues(image, [0.4, 0.2, 0.6], 6)
})

test('scnr additive-mask attenuates the target channel by the summed neighbor mask', () => {
	// GREEN protected: a=G=0.9, b=R=0.2, c=B=0.4; m=min(1, 0.2+0.4)=0.6 -> 0.6*0.9 = 0.54.
	const image = makeImage(1, 1, 3, [0.2, 0.9, 0.4])
	scnr(image, 'GREEN', 1, 'ADDITIVE_MASK')
	expectImageValues(image, [0.2, 0.54, 0.4], 6)
})

test('scnr maximum-neutral clamps the target channel to the brighter neighbor', () => {
	// m=max(0.2, 0.4)=0.4; min(0.9, 0.4)=0.4, independent of amount.
	const image = makeImage(1, 1, 3, [0.2, 0.9, 0.4])
	scnr(image, 'GREEN', 0.1, 'MAXIMUM_NEUTRAL')
	expectImageValues(image, [0.2, 0.4, 0.4], 6)
})

test('scnr minimum-neutral clamps the target channel to the dimmer neighbor', () => {
	// m=min(0.2, 0.4)=0.2; min(0.9, 0.2)=0.2.
	const image = makeImage(1, 1, 3, [0.2, 0.9, 0.4])
	scnr(image, 'GREEN', 0.1, 'MINIMUM_NEUTRAL')
	expectImageValues(image, [0.2, 0.2, 0.4], 6)
})

test('scnr leaves monochrome images unchanged', () => {
	const image = makeImage(3, 1, 1, [0.2, 0.5, 0.7])
	const before = new Float32Array(image.raw)
	scnr(image)
	expectImageValues(image, before, 8)
})
