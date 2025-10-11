import { expect, test } from 'bun:test'
import { dirname, join } from 'path'
import { deg, hour, toArcmin, toArcsec, toDeg, toHour } from '../src/angle'
import { astapDetectStars, astapPlateSolve } from '../src/astap'

test.skip('detect stars', async () => {
	const stars = await astapDetectStars(join(dirname(__dirname), 'data', 'apod4.jpg'), { executable: 'astap_cli' })

	expect(stars.length).toBeGreaterThanOrEqual(300)
	expect(stars[0].x).toBeGreaterThan(0)
	expect(stars[0].y).toBeGreaterThan(0)
	expect(stars[0].hfd).toBeGreaterThan(0)
	expect(stars[0].snr).toBeGreaterThan(0)
	expect(stars[0].flux).toBeGreaterThan(0)
})

test.skip('plate solve', async () => {
	const rightAscension = hour(10.7345)
	const declination = deg(-59.6022)
	const solution = await astapPlateSolve(join(dirname(__dirname), 'data', 'NGC3372--32.1.fit'), { executable: 'astap_cli', rightAscension, declination, radius: deg(4), fov: deg(0.54) })

	expect(solution).not.toBeUndefined()
	expect(toDeg(solution!.orientation)).toBeCloseTo(-110.13, 2)
	expect(toArcsec(solution!.scale)).toBeCloseTo(2.735, 3)
	expect(toHour(solution!.rightAscension)).toBeCloseTo(10.7345, 3)
	expect(toDeg(solution!.declination)).toBeCloseTo(-59.6022, 3)
	expect(toArcmin(solution!.width)).toBeCloseTo(47.307, 2)
	expect(toArcmin(solution!.height)).toBeCloseTo(32.1869, 4)
	expect(toArcmin(solution!.radius)).toBeCloseTo(28.6102, 4)
	expect(solution!.parity).toBe('NORMAL')
	expect(solution!.widthInPixels).toBe(1037)
	expect(solution!.heightInPixels).toBe(706)

	// Don't test SIP for now, since the latest ASTAP version doesn't returning it
	// expect(solution!.CTYPE1).toBe('RA---TAN-SIP')
})
