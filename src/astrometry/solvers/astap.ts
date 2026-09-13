import { tmpdir } from 'os'
import { basename, dirname, extname, join, resolve } from 'path'
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
// ASTAP writes FITS 1-based pixel coordinates (`xc+1`, `yc+1`); results use DetectedStar's 0-based
// array indices, matching detectStars.
export async function astapDetectStars(input: string, { minSNR = 0, maxStars = 0, executable, timeout }: Readonly<AstapStarDetectionOptions> = {}, signal?: AbortSignal): Promise<DetectedStar[]> {
	if (!input || !(await Bun.file(input).exists())) {
		console.error('invalid input or input file does not exists')
		return []
	}

	const inputPath = resolve(input)
	executable ||= executableForCurrentPlatform()
	timeout ||= DEFAULT_TIMEOUT

	const process = Bun.spawn([executable, '-f', inputPath, '-z', '0', '-extract', minSNR.toFixed(0)], { signal, timeout })
	const exitCode = await process.exited

	const file = Bun.file(`${join(dirname(inputPath), basename(inputPath, extname(inputPath)))}.csv`)

	if (await file.exists()) {
		try {
			const csv = readCsv(await file.text())

			if (csv.length > 0) {
				const stars = new Array<DetectedStar>(csv.length)

				for (let i = 0; i < csv.length; i++) {
					const row = csv[i]
					const x = +row[0] - 1
					const y = +row[1] - 1
					const hfd = +row[2]
					const snr = +row[3]
					const flux = +row[4]

					stars[i] = { x, y, hfd, snr, flux }
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
// RA/Dec are sent only when both are provided (hours and south-polar-distance). A radius without a
// center is `-r` only, so ASTAP can use the FITS header instead of RA=0h, Dec=0°.
export async function astapPlateSolve(input: string, { fov = 0, downsample = 0, timeout = 300000, rightAscension, declination, radius, executable, sip = true }: AstapPlateSolveOptions = {}, signal?: AbortSignal) {
	fov = Math.max(0, Math.min(toDeg(fov), 360)) // Specify 0 for auto
	const name = Bun.randomUUIDv7()
	const ini = Bun.file(join(tmpdir(), `${name}.ini`))
	const wcs = Bun.file(join(tmpdir(), `${name}.wcs`))
	const r = radius ? Math.max(0, Math.min(Math.ceil(toDeg(radius)), 180)) : 180

	executable ||= executableForCurrentPlatform()
	timeout ||= DEFAULT_TIMEOUT

	const commands = [executable, '-o', ini.name!, '-z', downsample.toFixed(0), '-f', input, '-wcs']

	if (fov) commands.push('-fov', `${fov}`)
	if (sip) commands.push('-sip')
	// CLI RA/Dec override the FITS header; send them only when the caller supplied a center.
	if (rightAscension !== undefined && declination !== undefined) commands.push('-ra', `${toHour(normalizeAngle(rightAscension))}`, '-spd', `${toDeg(declination) + 90}`)
	commands.push('-r', `${r}`)

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
