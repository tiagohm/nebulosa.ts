import { expect, test } from 'bun:test'
import { dirname, join } from 'path'
import { toArcmin, toArcsec, toDeg, toHour } from '../src/angle'
import { astapDetectStars, astapPlateSolve } from '../src/astap'

test.skip('detect stars', async () => {
	const stars = await astapDetectStars(join(dirname(__dirname), 'data', 'apod4.jpg'))

	expect(stars).toHaveLength(344)
	expect(stars[0].x).toBe(86.0705)
	expect(stars[0].y).toBe(19.3818)
	expect(stars[0].hfd).toBe(1.9242)
	expect(stars[0].snr).toBe(54)
	expect(stars[0].flux).toBe(110205)
})

test.skip('plate solve', async () => {
	const solution = await astapPlateSolve('/tmp/NGC3372-LRGB_ASTAP.fit')

	expect(solution).not.toBeUndefined()
	expect(solution!.solved).toBeTrue()
	expect(toDeg(solution!.orientation)).toBeCloseTo(-110.117, 3)
	expect(toArcsec(solution!.scale)).toBeCloseTo(1.369, 3)
	expect(toHour(solution!.rightAscension)).toBeCloseTo(10.7345, 3)
	expect(toDeg(solution!.declination)).toBeCloseTo(-59.6022, 3)
	expect(toArcmin(solution!.width)).toBeCloseTo(47.3005, 3)
	expect(toArcmin(solution!.height)).toBeCloseTo(32.1934, 3)
	expect(toArcmin(solution!.radius)).toBeCloseTo(28.6084, 3)
	expect(solution!.parity).toBe('NORMAL')
	expect(solution!.widthInPixels).toBe(2072)
	expect(solution!.heightInPixels).toBe(1411)

	expect(solution!.CTYPE1).toBe('RA---TAN-SIP')
})
