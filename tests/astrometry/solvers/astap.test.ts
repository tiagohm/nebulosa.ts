import { expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { astapDetectStars, astapPlateSolve } from '../../../src/astrometry/solvers/astap'
import { deg, hour, toArcmin, toArcsec, toDeg, toHour } from '../../../src/math/units/angle'
import { downloadPerTag } from '../../download'
import { isBinaryTestSkipped } from '../../util'

// Writes a dummy image and a fake `astap` that emits the given `-extract` CSV next to `-f`.
async function withFakeAstapExtract(csv: string, run: (input: string, executable: string) => Promise<void>) {
	const dir = await mkdtemp(join(tmpdir(), 'astap-'))
	try {
		const input = join(dir, 'img.fit')
		await writeFile(input, 'not-a-fits')
		const executable = join(dir, 'astap')
		await writeFile(executable, `#!/usr/bin/env bun\nconst args = process.argv.slice(2)\nconst input = args[args.indexOf('-f') + 1]\nconst csvPath = input.replace(/\\.[^.]+$/, '') + '.csv'\nawait Bun.write(csvPath, ${JSON.stringify(csv)})\n`, { mode: 0o755 })
		await run(input, executable)
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
}

await downloadPerTag('astap')

const SKIP = isBinaryTestSkipped()

test.skipIf(SKIP)('detect stars', async () => {
	const stars = await astapDetectStars(join(dirname(__dirname), '..', '..', 'data', 'apod4.jpg'))

	expect(stars.length).toBeGreaterThanOrEqual(200)
	expect(stars[0].x).toBeGreaterThan(0)
	expect(stars[0].y).toBeGreaterThan(0)
	expect(stars[0].hfd).toBeGreaterThan(0)
	expect(stars[0].snr).toBeGreaterThan(0)
	expect(stars[0].flux).toBeGreaterThan(0)
})

test.skipIf(SKIP)('plate solve', async () => {
	const rightAscension = hour(10.7345)
	const declination = deg(-59.6022)
	const solution = await astapPlateSolve(join(dirname(__dirname), '..', '..', 'data', 'NGC3372--32.1.fit'), { rightAscension, declination, radius: deg(4), fov: deg(0.54) })

	expect(solution).toBeDefined()
	expect(toDeg(solution!.orientation)).toBeCloseTo(110.1, 1)
	expect(toArcsec(solution!.scale)).toBeCloseTo(2.7, 1)
	expect(toHour(solution!.rightAscension)).toBeCloseTo(10.7, 1)
	expect(toDeg(solution!.declination)).toBeCloseTo(-59.6, 1)
	expect(toArcmin(solution!.width)).toBeCloseTo(47.3, 1)
	expect(toArcmin(solution!.height)).toBeCloseTo(32.2, 1)
	expect(toArcmin(solution!.radius)).toBeCloseTo(28.6, 1)
	expect(solution!.parity).toBe('NORMAL')
	expect(solution!.widthInPixels).toBe(1037)
	expect(solution!.heightInPixels).toBe(706)

	// Don't test SIP for now, since the latest ASTAP version doesn't returning it
	// expect(solution!.CTYPE1).toBe('RA---TAN-SIP')
})

test('radius-only plate-solve hint does not force RA 0h Dec 0', async () => {
	const calls: string[][] = []
	const original = Bun.spawn
	Bun.spawn = ((cmd: string[]) => {
		calls.push([...cmd])
		return { exited: Promise.resolve(1) }
	}) as typeof Bun.spawn

	try {
		await astapPlateSolve('img.fit', { radius: deg(4), executable: 'astap' })
		expect(calls).toHaveLength(1)
		expect(calls[0]).not.toContain('-ra')
		expect(calls[0]).not.toContain('-spd')
		expect(calls[0][calls[0].indexOf('-r') + 1]).toBe('4')

		await astapPlateSolve('img.fit', { rightAscension: hour(10.7345), declination: deg(-59.6022), radius: deg(4), executable: 'astap' })
		expect(calls).toHaveLength(2)
		const args = calls[1]
		expect(+args[args.indexOf('-ra') + 1]).toBeCloseTo(10.7345, 4)
		expect(+args[args.indexOf('-spd') + 1]).toBeCloseTo(30.3978, 4)
		expect(args[args.indexOf('-r') + 1]).toBe('4')
	} finally {
		Bun.spawn = original
	}
})

test('keeps every ASTAP extract star after the CSV header is skipped', async () => {
	const oneStar = 'x,y,hfd,snr,flux\n100.0,200.0,2.5,50,8000\n'
	await withFakeAstapExtract(oneStar, async (input, executable) => {
		const stars = await astapDetectStars(input, { executable })
		expect(stars).toHaveLength(1)
		expect(stars[0].snr).toBe(50)
		expect(stars[0].flux).toBe(8000)
	})

	const twoStars = 'x,y,hfd,snr,flux\n100.0,200.0,2.5,50,8000\n150.0,250.0,3.0,40,6000\n'
	await withFakeAstapExtract(twoStars, async (input, executable) => {
		const stars = await astapDetectStars(input, { executable })
		expect(stars).toHaveLength(2)
		expect(stars[0].snr).toBe(50)
		expect(stars[1].snr).toBe(40)
	})
})
