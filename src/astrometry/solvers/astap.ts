import { tmpdir } from 'os'
import { basename, dirname, extname, join, resolve } from 'path'
import { errorMessage } from '../../core/util'
import type { DetectedStar } from '../../imaging/stars/detector'
import { type CsvRow, readCsv } from '../../io/csv'
import { type FitsHeader, readFits } from '../../io/formats/fits/fits'
import { bufferSource } from '../../io/io'
import { type Angle, normalizeAngle, toDeg, toHour } from '../../math/units/angle'
import { type PlateSolveErrorCode, PlateSolveError, type PlateSolveOptions, plateSolutionFrom } from './platesolver'

// ASTAP command-line solver integration: spawns the local `astap` binary to detect stars (via its
// CSV output) and to plate-solve images (a WCS file parsed into a PlateSolution, with the outcome read
// from its .ini), both failing with a typed AstapError. All process I/O uses Bun; angles in options are
// radians and converted to ASTAP's degree/hour conventions.

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

// Why an ASTAP run produced no result:
// - unavailable: the executable could not be started, such as a missing file.
// - timeout: the process ran longer than the timeout and was killed.
// - aborted: the signal aborted the run and the process was killed.
// - failed: the input file is missing, ASTAP reported an error (a star detection without a readable CSV, a
//   solve with an unreadable image or star database), or it wrote an invalid WCS.
export type AstapErrorCode = PlateSolveErrorCode

// Failure of an ASTAP run, with the reason a caller can act on. A PlateSolveError, so a caller handling every
// solver catches it the same way.
export class AstapError extends PlateSolveError {
	// Creates an error of the given reason; cause is the underlying failure, when there is one.
	constructor(code: AstapErrorCode, message: string, options?: ErrorOptions) {
		super(code, message, options)
		this.name = 'AstapError'
	}
}

// ASTAP exit codes of a search that ended without a solution: 1 no solution, 2 not enough stars detected. Every other
// non-zero code is an error (16 unreadable image, 32 no star database, 33 unreadable star database, ...), as listed
// by the command-line help of ASTAP.
const ASTAP_NO_SOLUTION_EXIT_CODES = new Set([1, 2])

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

// Plate-solves a file with the local ASTAP executable, then parses the emitted WCS into a PlateSolution. Async.
// Star detection is astapDetectStars, not part of this call. Resolves undefined only when ASTAP searched and
// found no solution (exit code 1 or 2, or its .ini reports PLTSOLVD=F without an error). Rejects with AstapError:
// `unavailable` when the executable cannot be started, `timeout` and `aborted` when the process was killed for
// either reason, and `failed` for any other exit code (the message carries it and ASTAP's ERROR line) or a WCS
// that plateSolutionFrom refuses. RA/Dec are sent only when both are provided (hours and south-polar-distance). A
// radius without a center is `-r` only, so ASTAP can use the FITS header instead of RA=0h, Dec=0°. The .ini and
// .wcs are written to the temporary directory and always deleted. Requires the ASTAP binary.
export async function astapPlateSolve(input: string, { fov = 0, downsample = 0, timeout = DEFAULT_TIMEOUT, rightAscension, declination, radius, executable, sip = true }: AstapPlateSolveOptions = {}, signal?: AbortSignal) {
	if (signal?.aborted) throw new AstapError('aborted', 'the plate solve was aborted')

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

	let process: Bun.Subprocess

	try {
		process = Bun.spawn(commands, { signal, stdout: 'ignore', stderr: 'ignore' })
	} catch (error) {
		throw new AstapError('unavailable', `unable to start ASTAP: ${errorMessage(error)}`, { cause: error })
	}

	let timedOut = false

	const timer = setTimeout(() => {
		timedOut = true
		process.kill()
	}, timeout)

	try {
		const exitCode = await process.exited

		if (timedOut) throw new AstapError('timeout', `ASTAP did not finish within ${timeout} ms`)
		if (signal?.aborted) throw new AstapError('aborted', 'the plate solve was aborted')

		const report = (await ini.exists()) ? astapReport(await ini.text()) : undefined

		if (exitCode === 0 && (await wcs.exists())) {
			let header: FitsHeader | undefined

			try {
				header = (await readFits(bufferSource(Buffer.from(await wcs.arrayBuffer()))))?.hdus[0]?.header
			} catch (error) {
				throw new AstapError('failed', `unable to read the WCS of ASTAP: ${errorMessage(error)}`, { cause: error })
			}

			if (!header) throw new AstapError('failed', 'ASTAP wrote an empty WCS')

			if (!header.NAXIS) header.NAXIS = 2
			if (!header.NAXIS1 && header.CRPIX1) header.NAXIS1 = Math.trunc(((header.CRPIX1 as number) - 0.5) * 2)
			if (!header.NAXIS2 && header.CRPIX2) header.NAXIS2 = Math.trunc(((header.CRPIX2 as number) - 0.5) * 2)

			const solution = plateSolutionFrom(header)
			if (!solution) throw new AstapError('failed', 'ASTAP wrote a WCS that is not an equatorial TAN solution')
			return solution
		}

		if (report?.error) throw new AstapError('failed', `ASTAP failed with exit code ${exitCode}: ${report.error}`)
		if (ASTAP_NO_SOLUTION_EXIT_CODES.has(exitCode) || (exitCode === 0 && report?.solved === false)) return undefined

		throw new AstapError('failed', `ASTAP failed with exit code ${exitCode}`)
	} finally {
		clearTimeout(timer)
		if (await ini.exists()) await ini.delete()
		if (await wcs.exists()) await wcs.delete()
	}
}

// Outcome reported by the .ini of an ASTAP solve: whether it solved (PLTSOLVD) and its ERROR line, if any.
interface AstapReport {
	// PLTSOLVD as a boolean; undefined when the keyword is absent.
	readonly solved?: boolean
	// Trimmed ERROR value; undefined when absent or empty.
	readonly error?: string
}

// Parses the KEY=VALUE lines of an ASTAP .ini into its solve outcome. Unknown lines are ignored.
function astapReport(text: string): AstapReport {
	let solved: boolean | undefined
	let error: string | undefined

	for (const line of text.split(/\r?\n/)) {
		const separator = line.indexOf('=')
		if (separator <= 0) continue

		const key = line.slice(0, separator).trim().toUpperCase()
		const value = line.slice(separator + 1).trim()

		if (key === 'PLTSOLVD') solved = value.toUpperCase() === 'T'
		else if (key === 'ERROR' && value) error = value
	}

	return { solved, error }
}
