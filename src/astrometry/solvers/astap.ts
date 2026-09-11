import { tmpdir } from 'os'
import { basename, dirname, extname, join } from 'path'
import type { DetectedStar } from '../../imaging/stars/detector'
import { readCsv } from '../../io/csv'
import { readFits } from '../../io/formats/fits/fits'
import { bufferSource } from '../../io/io'
import { type Angle, normalizeAngle, toDeg, toHour } from '../../math/units/angle'
import { type PlateSolveOptions, plateSolutionFrom } from './platesolver'

// ASTAP command-line solver integration: spawns the local `astap` binary to detect stars (via its
// CSV output) and to plate-solve images (writing a WCS .ini that is parsed into a PlateSolution). All
// process I/O uses Bun; angles in options are radians and converted to ASTAP's degree/hour conventions.

// Options for ASTAP-based star detection.
export interface AstapStarDetectionOptions {
	// Path to the ASTAP executable; resolved per-platform when omitted.
	executable?: string
	// Minimum star SNR passed to ASTAP's `-extract`.
	minSNR?: number
	// Keep only the brightest `maxStars` detections (0 = unlimited).
	maxStars?: number
	// Directory for ASTAP's CSV output; defaults to the input file's directory.
	outputDirectory?: string
	// Process timeout, in milliseconds.
	timeout?: number
}

// Options for ASTAP-based plate solving.
export interface AstapPlateSolveOptions extends PlateSolveOptions {
	// Path to the ASTAP executable; resolved per-platform when omitted.
	executable?: string
	// Field-of-view hint (radians); 0 lets ASTAP auto-detect. Omit to use FITS's FOV.
	fov?: Angle
	// Whether to enable SIP distortion terms (`-sip`).
	sip?: boolean
}

// Default process timeout: 5 minutes, in milliseconds.
const DEFAULT_TIMEOUT = 300000

// Detects stars by running ASTAP's `-extract` and parsing its CSV (x, y, hfd, snr, flux). Returns the
// detections sorted/truncated to `maxStars` by SNR, or an empty array on failure or missing input.
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

// Plate-solves an image with ASTAP, optionally constrained by an RA/Dec/radius hint and FOV, then
// parses the emitted WCS .ini into a PlateSolution. Returns undefined when ASTAP fails to solve.
// RA hint is converted to hours and declination to south-polar-distance per ASTAP's CLI.
export async function astapPlateSolve(input: string, { fov = 0, downsample = 0, timeout = 300000, rightAscension = 0, declination = 0, radius = 0, executable, sip = true }: AstapPlateSolveOptions = {}, signal?: AbortSignal) {
	fov = Math.max(0, Math.min(toDeg(fov), 360)) // Specify 0 for auto
	const name = Bun.randomUUIDv7()
	const ini = Bun.file(join(tmpdir(), `${name}.ini`))
	const wcs = Bun.file(join(tmpdir(), `${name}.wcs`))
	radius = Math.max(0, Math.min(Math.ceil(toDeg(radius)), 180))
	rightAscension = toHour(normalizeAngle(rightAscension))
	const spd = toDeg(declination) + 90
	executable ||= executableForCurrentPlatform()
	timeout ||= DEFAULT_TIMEOUT

	const commands = [executable, '-o', ini.name!, '-z', downsample.toFixed(0), '-f', input, '-wcs']

	if (fov) commands.push('-fov', `${fov}`)
	if (sip) commands.push('-sip')
	if (radius) commands.push('-ra', `${rightAscension}`, '-spd', `${spd}`, '-r', `${radius}`)
	else commands.push('-r', '180')

	const process = Bun.spawn(commands, { signal, timeout })
	const exitCode = await process.exited

	try {
		if (exitCode === 0 && (await wcs.exists())) {
			const buffer = Buffer.from(await wcs.arrayBuffer())
			const fits = await readFits(bufferSource(buffer))

			if (fits?.hdus.length) {
				const { header } = fits.hdus[0]

				if (!header.NAXIS) header.NAXIS = 2
				if (!header.NAXIS1 && header.CRPIX1) header.NAXIS1 = Math.trunc(((header.CRPIX1 as number) - 0.5) * 2)
				if (!header.NAXIS2 && header.CRPIX2) header.NAXIS2 = Math.trunc(((header.CRPIX2 as number) - 0.5) * 2)

				return plateSolutionFrom(header)
			}
		} else {
			console.error('astap plate solve failed with exit code', exitCode)
		}
	} finally {
		if (await ini.exists()) await ini.delete()
		if (await wcs.exists()) await wcs.delete()
	}

	return undefined
}

// Returns the default ASTAP executable path/name for the current platform.
function executableForCurrentPlatform() {
	switch (process.platform) {
		case 'win32':
			return 'C:\\Program Files\\astap\\astap.exe'
		default:
			return 'astap'
	}
}
