import { expect, test } from 'bun:test'
import { dirname, join } from 'path'
import { astapDetectStars } from '../src/astap'

test.skip('detectStars', async () => {
	const stars = await astapDetectStars(join(dirname(__dirname), 'data', 'apod4.jpg'))

	expect(stars).toHaveLength(344)
	expect(stars[0].x).toBe(86.0705)
	expect(stars[0].y).toBe(19.3818)
	expect(stars[0].hfd).toBe(1.9242)
	expect(stars[0].snr).toBe(54)
	expect(stars[0].flux).toBe(110205)
})
