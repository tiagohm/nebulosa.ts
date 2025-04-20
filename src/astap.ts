import fs from 'fs/promises'
import { tmpdir } from 'os'
import { basename, dirname, join } from 'path'
import { type Angle, normalizeAngle, toDeg, toHour } from './angle'
import { readCsv } from './csv'
import { readFits } from './fits'
import { fileHandleSource } from './io'
import { type PlateSolveOptions, plateSolutionFrom } from './platesolver'
import type { DetectedStar } from './stardetector'

export interface AstapStarDetectOptions {
	executable?: string
	minSNR?: number
	outputDirectory?: string
}

export interface AstapPlateSolveOptions extends PlateSolveOptions {
	executable?: string
	fov?: Angle
	sip?: boolean
}

export async function astapDetectStars(input: string, options?: AstapStarDetectOptions, signal?: AbortSignal): Promise<DetectedStar[]> {
	const cwd = options?.outputDirectory || dirname(input)
	const minSNR = options?.minSNR ?? 0
	const executable = options?.executable || executableForCurrentPlatform()

	const process = Bun.spawn([executable, '-f', input, '-z', '0', '-extract', minSNR.toFixed(0)], { cwd, signal })

	const exitCode = await process.exited

	if (exitCode === 0) {
		const file = Bun.file(`${join(cwd, basename(input, '.jpg'))}.csv`)

		if (await file.exists()) {
			const csv = readCsv(await file.text())

			if (csv.length > 1) {
				const stars = new Array<DetectedStar>(csv.length - 1)

				for (let i = 1; i < csv.length; i++) {
					const row = csv[i]
					const x = +row[0]
					const y = +row[1]
					const hfd = +row[2]
					const snr = +row[3]
					const flux = +row[4]

					stars[i - 1] = { x, y, hfd, snr, flux }
				}

				return stars
			}
		}
	}

	return []
}

const DIMENSIONS_REGEX = /DIMENSIONS=(\d+)\s*x\s*(\d+)/

export async function astapPlateSolve(input: string, options?: AstapPlateSolveOptions, signal?: AbortSignal) {
	const fov = Math.max(0, Math.min(toDeg(options?.fov ?? 0), 360))
	const z = Math.max(0, options?.downsample ?? 0)
	const wcs = join(tmpdir(), `${Bun.randomUUIDv7()}.wcs`)
	const ini = wcs.replace('.wcs', '.ini')
	const r = options?.radius ? Math.max(0, Math.min(Math.ceil(toDeg(options.radius)), 180)) : 0
	const ra = options?.ra ? toHour(normalizeAngle(options.ra)) : 0
	const spd = options?.dec ? toDeg(options.dec) + 90 : 90
	const executable = options?.executable || executableForCurrentPlatform()
	const sip = options?.sip === undefined || options?.sip

	const commands = [executable, '-o', wcs, '-z', z.toFixed(0), '-wcs', '-f', input]

	if (fov) commands.push('-fov', `${fov}`)
	if (sip) commands.push('-sip')

	if (r) commands.push('-ra', `${ra}`, '-spd', `${spd}`, '-r', `${r}`)
	else commands.push('-r', '180')

	const process = Bun.spawn(commands, { signal, timeout: options?.timeout || 300000 })
	const exitCode = await process.exited

	if (exitCode === 0 && (await fs.exists(wcs))) {
		try {
			const handle = await fs.open(wcs)
			await using source = fileHandleSource(handle)
			const fits = await readFits(source)

			if (fits?.hdus.length) {
				const header = fits.hdus[0].header

				if (!header.NAXIS1 || !header.NAXIS2) {
					const text = (await fs.readFile(ini)).toString('utf-8')
					const dimensions = DIMENSIONS_REGEX.exec(text)

					if (dimensions) {
						header.NAXIS1 = +dimensions[1]
						header.NAXIS2 = +dimensions[2]
					}
				}

				return plateSolutionFrom(header)
			}
		} finally {
			fs.unlink(wcs)
			fs.unlink(ini)
		}
	}

	return undefined
}

function executableForCurrentPlatform() {
	switch (process.platform) {
		case 'win32':
			return 'C:\\Program Files\\astap\\astap.exe'
		default:
			return 'astap'
	}
}
