import fs from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { expect, test } from 'bun:test'
import { deg, toArcsec, toDeg, toHour } from '../src/angle'
import { astrometryNetIndexFiles, libAstrometryNetPlateSolve } from '../src/libastrometry'
import { downloadPerTag } from './download'
import { readImageFromJpeg } from '../src/image'
import { detectStars } from '../src/star.detector'
import { DEC_TAN_SIP, RA_TAN_SIP } from '../src/fits.wcs'

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
		expect(solution).toBeDefined()
		expect(toDeg(solution!.orientation)).toBeCloseTo(58.440371, 3)
		expect(toArcsec(solution!.scale)).toBeCloseTo(170.968998, 3)
		expect(toHour(solution!.rightAscension)).toBeCloseTo(12.474879, 3)
		expect(toDeg(solution!.declination)).toBeCloseTo(56.719269, 3)
		expect(toDeg(solution!.width)).toBeCloseTo(34.086917, 3)
		expect(toDeg(solution!.height)).toBeCloseTo(24.078133, 3)
		expect(toDeg(solution!.radius)).toBeCloseTo(20.866686, 3)
		expect(solution!.parity).toBe('NORMAL')
		expect(solution!.widthInPixels).toBe(719)
		expect(solution!.heightInPixels).toBe(507)
		expect(solution!.CTYPE1).toBe(RA_TAN_SIP)
		expect(solution!.CTYPE2).toBe(DEC_TAN_SIP)
		expect(solution!.A_ORDER).toBeDefined()
	},
	2000,
)
