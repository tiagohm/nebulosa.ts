import { describe, expect, test } from 'bun:test'
import { arcmin, arcsec, deg, parseAngle } from './angle'
import { type AstapPlateSolveOptions, astapSolve } from './astap'

describe.skip('solve', () => {
	test('blind', async () => {
		const ra = parseAngle('17h45m47.4s')!
		const dec = parseAngle('-29d07m26.1s')!
		const options: AstapPlateSolveOptions = { fov: deg(0.5) }
		const solution = await astapSolve('astap', '/home/tiagohm/Imagens/astrometry.png', options)

		expect(solution.solved).toBeTrue()
		expect(solution.rightAscension).toBeCloseTo(ra, 4)
		expect(solution.declination).toBeCloseTo(dec, 4)
		expect(solution.orientation).toBeCloseTo(deg(180 - 179.84), 4)
		expect(solution.scale).toBeCloseTo(arcsec(2.3207), 8)
		expect(solution.width).toBeCloseTo(arcmin(49.5), 4)
		expect(solution.height).toBeCloseTo(arcmin(39.6), 4)
		expect(solution.parity).toBe('FLIPPED')
		expect(solution.widthInPixels).toBe(1279)
		expect(solution.heightInPixels).toBe(1023)
	}, 300000)

	test('nearest', async () => {
		const ra = parseAngle('17h45m47.4s')!
		const dec = parseAngle('-29d07m26.1s')!
		const options: AstapPlateSolveOptions = { fov: deg(0.5), ra, dec, radius: deg(4) }
		const solution = await astapSolve('astap', '/home/tiagohm/Imagens/astrometry.png', options)

		expect(solution.solved).toBeTrue()
		expect(solution.rightAscension).toBeCloseTo(ra, 4)
		expect(solution.declination).toBeCloseTo(dec, 4)
		expect(solution.orientation).toBeCloseTo(deg(180 - 179.84), 4)
		expect(solution.scale).toBeCloseTo(arcsec(2.3207), 8)
		expect(solution.width).toBeCloseTo(arcmin(49.5), 4)
		expect(solution.height).toBeCloseTo(arcmin(39.6), 4)
		expect(solution.parity).toBe('FLIPPED')
		expect(solution.widthInPixels).toBe(1279)
		expect(solution.heightInPixels).toBe(1023)
	})
})
