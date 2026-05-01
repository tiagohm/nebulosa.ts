import { tmpdir } from 'os'
import { basename, dirname, extname, join } from 'path'
import { type Angle, normalizeAngle, toDeg, toHour } from './angle'
import { readCsv } from './csv'
import type { FitsHeader } from './fits'
import { type PlateSolveOptions, plateSolutionFrom } from './platesolver'
import type { DetectedStar } from './star.detector'
import { isWcsFitsKeyword } from './fits.wcs'

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

export async function astapDetectStars(input: string, { minSNR = 0, maxStars = 0, outputDirectory, executable, timeout }: Readonly<AstapStarDetectionOptions> = {}, signal?: AbortSignal): Promise<DetectedStar[]> {
	if (!input || !(await Bun.file(input).exists())) {
		console.error('invalid input or input file does not exists')
		return []
	}

	const cwd = outputDirectory || dirname(input)
	executable ||= executableForCurrentPlatform()
	timeout ||= DEFAULT_TIMEOUT

	const process = Bun.spawn([executable, '-f', input, '-z', '0', '-extract', minSNR.toFixed(0)], { cwd, signal, timeout })
	const exitCode = await process.exited

	const file = Bun.file(`${join(cwd, basename(input, extname(input)))}.csv`)

	if (await file.exists()) {
		try {
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

				if (maxStars > 0 && stars.length > maxStars) {
					stars.sort((a, b) => b.snr - a.snr)
					stars.splice(maxStars)
				}

				return stars
			} else {
				console.warn('no stars')
			}
		} catch (e) {
			console.error('error reading CSV', e)
		} finally {
			await file.delete()
		}
	} else {
		console.error('astap star detection failed with exit code', exitCode)
	}

	return []
}

export async function astapPlateSolve(input: string, { fov = 0, downsample = 0, timeout = 300000, rightAscension = 0, declination = 0, radius = 0, executable, sip = true }: AstapPlateSolveOptions = {}, signal?: AbortSignal) {
	fov = Math.max(0, Math.min(toDeg(fov), 360)) // Specify 0 for auto
	const ini = Bun.file(join(tmpdir(), `${Bun.randomUUIDv7()}.ini`))
	radius = Math.max(0, Math.min(Math.ceil(toDeg(radius)), 180))
	rightAscension = toHour(normalizeAngle(rightAscension))
	const spd = declination ? toDeg(declination) + 90 : 90
	executable ||= executableForCurrentPlatform()
	timeout ||= DEFAULT_TIMEOUT

	const commands = [executable, '-o', ini.name!, '-z', downsample.toFixed(0), '-f', input, '-fov', `${fov}`]

	if (sip) commands.push('-sip')
	if (radius) commands.push('-ra', `${rightAscension}`, '-spd', `${spd}`, '-r', `${radius}`)
	else commands.push('-r', '180')

	const process = Bun.spawn(commands, { signal, timeout })
	const exitCode = await process.exited

	if (exitCode === 0 && (await ini.exists())) {
		try {
			const text = await ini.text()

			if (text) {
				const lines = text.split('\n')
				const header: FitsHeader = { CRPIX1: 0, CRPIX2: 0, CRVAL1: 0, CRVAL2: 0, CDELT1: 0, CDELT2: 0, CROTA1: 0, CROTA2: 0, CD1_1: 0, CD1_2: 0, CD2_1: 0, CD2_2: 0 }

				for (const line of lines) {
					const [key, value] = line.trim().split('=')

					if (key in header || isWcsFitsKeyword(key)) {
						const numericValue = Number.parseFloat(value)
						header[key] = Number.isFinite(numericValue) ? numericValue : value
					} else if (key === 'DIMENSIONS') {
						const [width, height] = value.split('x')
						header.NAXIS1 = +width
						header.NAXIS2 = +height
					}
				}

				return plateSolutionFrom(header)
			}
		} finally {
			await ini.delete()
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
