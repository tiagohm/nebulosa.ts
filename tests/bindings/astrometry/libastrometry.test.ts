import { expect, spyOn, test } from 'bun:test'
import fs from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { DEC_TAN_SIP, RA_TAN_SIP } from '../../../src/astrometry/wcs/fits.wcs'
import { AstrometryNet, astrometryNetIndexFiles, libAstrometryNetPlateSolve, load } from '../../../src/bindings/astrometry/libastrometry'
import { readImageFromJpeg } from '../../../src/imaging/model/image'
import { detectStars } from '../../../src/imaging/stars/detector'
import { deg, toArcsec, toDeg, toHour } from '../../../src/math/units/angle'
import { downloadPerTag } from '../../download'

await downloadPerTag('libastrometry')

const libastrometryFile = Bun.file('native/libastrometry.shared')
const SKIP = !(await libastrometryFile.exists()) || libastrometryFile.size <= 0

test('expand index directory and files', async () => {
	const root = await fs.mkdtemp(join(tmpdir(), 'libastrometry-'))
	const subdir = join(root, 'sub')
	const index0 = join(root, 'index-4200.fits')
	const index1 = join(subdir, 'index-4201-00.fit')
	const explicit = join(root, 'custom-index.dat')

	try {
		await fs.mkdir(subdir)
		await Promise.all([fs.writeFile(index0, ''), fs.writeFile(index1, ''), fs.writeFile(explicit, ''), fs.writeFile(join(root, 'notes.txt'), '')])
		const indexes = await astrometryNetIndexFiles([root, explicit, join(root, 'missing.fits')])

		expect(indexes).toEqual([explicit, index0, index1].sort())
	} finally {
		await fs.rm(root, { recursive: true, force: true })
	}
})

test.skipIf(SKIP)('configure default and explicit acceptance log-odds on each solve', async () => {
	const lib = load()
	const keepLogOdds = spyOn(lib, 'solver_set_keep_logodds')
	const run = spyOn(lib, 'solver_run').mockReturnValue(undefined)

	try {
		using solver = new AstrometryNet()
		const stars = [
			{ x: 10, y: 10, flux: 3 },
			{ x: 20, y: 10, flux: 2 },
			{ x: 10, y: 20, flux: 1 },
		]

		for (const logOddsToKeep of [undefined, 0, Math.log(1e12), undefined]) {
			keepLogOdds.mockClear()
			await solver.solve(stars, 100, 100, { indexes: 'data/index-4116.fits', logOddsToKeep })
			expect(keepLogOdds).toHaveBeenCalledTimes(1)
			expect(keepLogOdds.mock.calls[0][1]).toBeCloseTo(logOddsToKeep ?? 20.72326583694641, 12)
		}
	} finally {
		run.mockRestore()
		keepLogOdds.mockRestore()
	}
})

test.skipIf(SKIP)(
	'solve apod4.jpg',
	async () => {
		const image = readImageFromJpeg(Buffer.from(await Bun.file('data/apod4.jpg').arrayBuffer()), undefined, 'GRAY')!
		const stars = detectStars(image, { maxStars: 500 })

		const solution = await libAstrometryNetPlateSolve(stars, image.metadata.width, image.metadata.height, {
			indexes: 'data/index-4116.fits',
			fov: deg(34),
			scaleError: 0.2,
			tweakOrder: 2,
			maxStars: 500,
		})

		// https://nova.astrometry.net/status/14909666
		// Orientation/FOV compare to 0.005 deg: flux-weighted centroids move stars by a fraction
		// of a pixel, about 9 arcsec at this plate scale, versus integer-peak positions.
		expect(solution).toBeDefined()
		expect(toDeg(solution!.orientation)).toBeCloseTo(58.4507, 2)
		expect(toArcsec(solution!.scale)).toBeCloseTo(170.85, 1)
		expect(toHour(solution!.rightAscension)).toBeCloseTo(12.474879, 3)
		expect(toDeg(solution!.declination)).toBeCloseTo(56.7205, 3)
		expect(toDeg(solution!.width)).toBeCloseTo(34.092, 2)
		expect(toDeg(solution!.height)).toBeCloseTo(24.0842, 3)
		expect(toDeg(solution!.radius)).toBeCloseTo(20.8705, 2)
		expect(solution!.parity).toBe('NORMAL')
		expect(solution!.widthInPixels).toBe(719)
		expect(solution!.heightInPixels).toBe(507)
		expect(solution!.CTYPE1).toBe(RA_TAN_SIP)
		expect(solution!.CTYPE2).toBe(DEC_TAN_SIP)
		expect(solution!.A_ORDER).toBeDefined()
	},
	2000,
)
