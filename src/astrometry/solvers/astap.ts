import { tmpdir } from 'os'
import { basename, dirname, extname, join, resolve } from 'path'
import { errorMessage } from '../../core/util'
import type { DetectedStar } from '../../imaging/stars/detector'
import { type CsvRow, readCsv } from '../../io/csv'
import { readFits } from '../../io/formats/fits/fits'
import { bufferSource } from '../../io/io'
import { type Angle, normalizeAngle, toDeg, toHour } from '../../math/units/angle'
import { type PlateSolveOptions, plateSolutionFrom } from './platesolver'

// ASTAP command-line solver integration: spawns the local `astap` binary to detect stars (via its
// CSV output, failing with a typed AstapError) and to plate-solve images (writing a WCS .ini that is
// parsed into a PlateSolution). All process I/O uses Bun; angles in options are radians and converted to
// ASTAP's degree/hour conventions.

// Options for ASTAP-based star detection.
export interface AstapStarDetectionOptions {
	// Path to the ASTAP executable; `astap` looked up on the PATH when omitted.
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
	// Path to the ASTAP executable; `astap` looked up on the PATH when omitted.
	executable?: string
	// Field-of-view hint (radians); 0 lets ASTAP auto-detect. Omit to use FITS's FOV.
	fov?: Angle
	// Whether to enable SIP distortion terms (`-sip`).
	sip?: boolean
}

// Executable used when the options name none, resolved through the PATH.
const DEFAULT_EXECUTABLE = 'astap'

// Default process timeout: 5 minutes, in milliseconds.
const DEFAULT_TIMEOUT = 300000

// Why an ASTAP star detection produced no result:
// - unavailable: the executable could not be started, such as a missing file.
// - timeout: the process ran longer than the timeout and was killed.
// - aborted: the signal aborted the run and the process was killed.
// - failed: the input file is missing, or ASTAP ended without writing a readable CSV.
export type AstapErrorCode = 'unavailable' | 'timeout' | 'aborted' | 'failed'

// Failure of an ASTAP run, with the reason a caller can act on.
export class AstapError extends Error {
	// Creates an error of the given reason; cause is the underlying failure, when there is one.
	constructor(
		readonly code: AstapErrorCode,
		message: string,
		options?: ErrorOptions,
	) {
		super(message, options)
		this.name = 'AstapError'
	}
}

// Detects stars by running ASTAP's `-extract` and parsing the CSV (x, y, hfd, snr, flux) it writes next to
// the input file, which is deleted afterwards, so the input's directory must be writable. Returns the
// detections sorted/truncated to `maxStars` by SNR, and an empty array only when ASTAP wrote a CSV without
// stars. Throws AstapError: `unavailable` when the executable cannot be started, `timeout` and `aborted`
// when the process was killed for either reason, and `failed` for a missing input or when no readable CSV
// was written (its exit code is in the message). ASTAP writes FITS 1-based pixel coordinates (`xc+1`,
// `yc+1`); results use DetectedStar's 0-based array indices, matching detectStars.
export async function astapDetectStars(input: string, { minSNR = 0, maxStars = 0, executable, timeout }: Readonly<AstapStarDetectionOptions> = {}, signal?: AbortSignal): Promise<DetectedStar[]> {
	if (!input || !(await Bun.file(input).exists())) throw new AstapError('failed', `the input file "${input}" does not exist`)
	if (signal?.aborted) throw new AstapError('aborted', 'the star detection was aborted')

	const inputPath = resolve(input)
	executable ||= DEFAULT_EXECUTABLE
	timeout ||= DEFAULT_TIMEOUT

	let process: Bun.Subprocess

	try {
		process = Bun.spawn([executable, '-f', inputPath, '-z', '0', '-extract', minSNR.toFixed(0)], { signal, stdout: 'ignore', stderr: 'ignore' })
	} catch (error) {
		throw new AstapError('unavailable', `unable to start ASTAP: ${errorMessage(error)}`, { cause: error })
	}

	let timedOut = false

	const timer = setTimeout(() => {
		timedOut = true
		process.kill()
	}, timeout)

	const file = Bun.file(`${join(dirname(inputPath), basename(inputPath, extname(inputPath)))}.csv`)

	try {
		const exitCode = await process.exited

		if (timedOut) throw new AstapError('timeout', `ASTAP did not finish within ${timeout} ms`)
		if (signal?.aborted) throw new AstapError('aborted', 'the star detection was aborted')
		if (!(await file.exists())) throw new AstapError('failed', `ASTAP wrote no star list (exit code ${exitCode})`)

		let csv: CsvRow[]

		try {
			csv = readCsv(await file.text())
		} catch (error) {
			throw new AstapError('failed', `unable to read the star list of ASTAP: ${errorMessage(error)}`, { cause: error })
		}

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
	} finally {
		clearTimeout(timer)
		// A killed run may still have written a partial list.
		if (await file.exists()) await file.delete()
	}
}

// Plate-solves a file with the local ASTAP executable, then parses the emitted WCS .ini into a
// PlateSolution. Async. Star detection is astapDetectStars, not part of this call. Returns undefined
// when ASTAP exits non-zero or writes no WCS. An aborted signal rejects from the spawned process.
// RA/Dec are sent only when both are provided (hours and south-polar-distance). A radius without a
// center is `-r` only, so ASTAP can use the FITS header instead of RA=0h, Dec=0°. Requires the ASTAP binary.
export async function astapPlateSolve(input: string, { fov = 0, downsample = 0, timeout = 300000, rightAscension, declination, radius, executable, sip = true }: AstapPlateSolveOptions = {}, signal?: AbortSignal) {
	fov = Math.max(0, Math.min(toDeg(fov), 360)) // Specify 0 for auto
	const name = Bun.randomUUIDv7()
	const ini = Bun.file(join(tmpdir(), `${name}.ini`))
	const wcs = Bun.file(join(tmpdir(), `${name}.wcs`))
	const r = radius ? Math.max(0, Math.min(Math.ceil(toDeg(radius)), 180)) : 180

	executable ||= DEFAULT_EXECUTABLE
	timeout ||= DEFAULT_TIMEOUT

	const commands = [executable, '-o', ini.name!, '-z', downsample.toFixed(0), '-f', input, '-wcs', '-fov', `${fov}`]

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
