import fs from 'fs/promises'
import { tmpdir } from 'os'
import { basename, dirname, extname, join } from 'path'
import { type Angle, normalizeAngle, toDeg, toHour } from './angle'
import { readCsv } from './csv'
import { readFits } from './fits'
import { fileHandleSource } from './io'
import { type PlateSolveOptions, plateSolutionFrom } from './platesolver'
import type { DetectedStar } from './stardetector'

export interface AstapStarDetectionOptions {
	executable?: string
	minSNR?: number
	maxStars?: number
	outputDirectory?: string
	timeout?: number
}

export interface AstapPlateSolveOptions extends PlateSolveOptions {
	executable?: string
	fov?: Angle
	sip?: boolean
}

const DEFAULT_TIMEOUT = 300000 // 5 minutes

export async function astapDetectStars(input: string, { minSNR = 0, maxStars = 0, outputDirectory, executable, timeout }: AstapStarDetectionOptions = {}, signal?: AbortSignal): Promise<DetectedStar[]> {
	if (!input || !(await fs.exists(input))) return []

	const cwd = outputDirectory || dirname(input)
	executable ||= executableForCurrentPlatform()
	timeout ||= DEFAULT_TIMEOUT

	const process = Bun.spawn([executable, '-f', input, '-z', '0', '-extract', minSNR.toFixed(0)], { cwd, signal, timeout })
	const exitCode = await process.exited

	const file = `${join(cwd, basename(input, extname(input)))}.csv`

	if (await fs.exists(file)) {
		try {
			const csv = readCsv(await fs.readFile(file, 'utf-8'))

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

				if (maxStars > 0 && stars.length > maxStars) {
					stars.sort((a, b) => b.snr - a.snr)
					stars.splice(maxStars)
				}

				return stars
			}
		} catch (e) {
			console.error('error reading CSV', e)
		} finally {
			await fs.unlink(file)
		}
	} else {
		console.error('astap star detection failed with exit code', exitCode)
	}

	return []
}

const DIMENSIONS_REGEX = /DIMENSIONS=(\d+)\s*x\s*(\d+)/

export async function astapPlateSolve(input: string, { fov = 0, downsample = 0, timeout = 300000, ra = 0, dec = 0, radius = 0, executable, sip = true }: AstapPlateSolveOptions = {}, signal?: AbortSignal) {
	fov = Math.max(0, Math.min(toDeg(fov), 360)) // Specify 0 for auto
	const wcs = join(tmpdir(), `${Bun.randomUUIDv7()}.wcs`)
	const ini = wcs.replace('.wcs', '.ini')
	radius = Math.max(0, Math.min(Math.ceil(toDeg(radius)), 180))
	ra = toHour(normalizeAngle(ra))
	const spd = dec ? toDeg(dec) + 90 : 90
	executable ||= executableForCurrentPlatform()
	timeout ||= DEFAULT_TIMEOUT

	const commands = [executable, '-o', wcs, '-z', downsample.toFixed(0), '-wcs', '-f', input]

	commands.push('-fov', `${fov}`)
	if (sip) commands.push('-sip')
	if (radius) commands.push('-ra', `${ra}`, '-spd', `${spd}`, '-r', `${radius}`)
	else commands.push('-r', '180')

	const process = Bun.spawn(commands, { signal, timeout })
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
			await fs.unlink(wcs)
			await fs.unlink(ini)
		}
	} else {
		console.error('astap plate solve failed with exit code', exitCode)
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
