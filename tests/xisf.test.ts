import { expect, test } from 'bun:test'
import { byteShuffle, byteUnshuffle } from '../src/xisf'

test('byte shuffle & unshuffle', () => {
	const original = new Uint8Array(512)
	for (let i = 0; i < 256; i += 2) original[i] = i
	const shuffled = new Uint8Array(512)
	const unshuffled = new Uint8Array(512)

	byteShuffle(original, shuffled, 2)
	expect(original).not.toEqual(shuffled)

	byteUnshuffle(shuffled, unshuffled, 2)
	expect(unshuffled).toEqual(original)

	expect(Bun.gzipSync(shuffled).byteLength).toBeLessThan(Bun.gzipSync(original).byteLength)
})
