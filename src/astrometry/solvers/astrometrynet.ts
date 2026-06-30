import fs from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import type { RequiredOnly } from '../../core/types'
import { readFits } from '../../io/formats/fits/fits'
import { bufferSource, fileHandleSource } from '../../io/io'
import { type Angle, normalizeAngle, toDeg } from '../../math/units/angle'
import { type PlateSolution, type PlateSolveOptions, plateSolutionFrom } from './platesolver'

// astrometry.net plate-solving integration, both the nova.astrometry.net web API (login → upload →
// poll submission/job → download WCS) and the local `solve-field` command-line tool. Both paths end by
// distilling the resulting WCS FITS header into a PlateSolution. Angles in options are radians and
// converted to the degrees the API/CLI expect.
// https://astrometry.net/doc/net/api.html

// How the scale bounds are interpreted by the nova API.
export type ScaleUnit = 'degwidth' | 'arcminwidth' | 'arcsecperpix'

// Scale-hint style: 'ul' = upper/lower bounds, 'ev' = estimate with error.
export type ScaleType = 'ul' | 'ev' // UPPER_LOWER | ESTIMATIVE_ERROR

// Connection/auth parameters shared by every nova API call.
export interface RequestOptions {
	// Base API URL; defaults to the public nova endpoint.
	apiUrl?: string
	// API key used for login; defaults to the anonymous key.
	apiKey?: string
	// An existing session token or session object to reuse.
	session?: string | Session
	// Abort signal for the request.
	signal?: AbortSignal
}

// Login response carrying the session token used for subsequent calls.
export interface Session {
	// API status string ('success' on success).
	readonly status: string
	// Session token, when login succeeded.
	readonly session?: string
	// Error description, when login failed.
	readonly errormessage?: string
}

// Upload request: the image plus scale/parity hints and sharing flags for the nova API.
export interface Upload<T> extends NovaAstrometryNetPlateSolveOptions {
	// Image to solve: a URL string (url_upload) or a Blob (multipart upload).
	input: T
	// Whether the submission permits commercial use.
	allowCommercialUse?: boolean
	// Whether the submission permits modifications.
	allowModifications?: boolean
	// Whether the submission is publicly visible.
	publiclyVisible?: boolean
	// Unit for the scale bounds (default 'degwidth').
	scaleUnits?: ScaleUnit
	// Lower scale bound (radians, converted to degrees).
	scaleLower?: Angle
	// Upper scale bound (radians, converted to degrees).
	scaleUpper?: Angle
	// Scale-hint style (default 'ul').
	scaleType?: ScaleType
	// Estimated scale for 'ev' hints (radians).
	scaleEstimated?: Angle
	// Fractional scale error for 'ev' hints.
	scaleError?: number
	// SIP polynomial order for distortion fitting.
	tweakOrder?: number
	// Whether the reference pixel is the image center.
	crpixCenter?: boolean
	// Parity hint: 0 normal, 1 flipped, 2 try both.
	parity?: 0 | 1 | 2
}

// Submission response returned after an upload.
export interface Submission {
	// API status string.
	readonly status: string
	// Submission id used to poll status.
	readonly subid?: number
	// Error description, when the upload failed.
	readonly errormessage?: string
}

// Status of a submission while its jobs are created and solved.
export interface SubmissionStatus {
	readonly processing_started: string
	readonly processing_finished: string
	readonly job_calibrations: number[][]
	// Job slots for the submission. An entry is null until its job has been created, and a created
	// job stays 'solving' until it resolves, so a non-null id alone does not mean a result is ready.
	readonly jobs: (number | null)[]
	readonly user: number
	readonly user_images: number[]
}

// Status of a single solve job.
export interface Job {
	// 'solving' while in progress, then 'success' or 'failure'.
	readonly status: string
}

// Options for the nova (web API) solver: solve hints plus connection/auth parameters.
export interface NovaAstrometryNetPlateSolveOptions extends PlateSolveOptions, RequestOptions {}

// Options for the local `solve-field` solver.
export interface LocalAstrometryNetPlateSolveOptions extends PlateSolveOptions {
	// Path to the solve-field executable.
	executable?: string
	// Field-of-view hint (radians); 0 lets the solver guess the scale.
	fov?: Angle
}

// Public nova.astrometry.net API base URL.
export const NOVA_ASTROMETRY_NET_URL = 'https://nova.astrometry.net'
// Placeholder anonymous API key used when no key is provided.
export const NOVA_ASTROMETRY_NET_ANONYMOUS_API_KEY = 'XXXXXXXX'

// Logs in to the nova API and returns a session, using the anonymous key when none is configured.
export function login(options?: Omit<RequestOptions, 'session'>, signal?: AbortSignal) {
	const data = { apikey: options?.apiKey || NOVA_ASTROMETRY_NET_ANONYMOUS_API_KEY }
	return requestForm<Session>(`${options?.apiUrl || NOVA_ASTROMETRY_NET_URL}/api/login`, data, signal ?? options?.signal)
}

// Submits an image to the nova API for solving, choosing URL upload for a string input or multipart
// upload for a Blob, and applying scale/parity/center hints (angles converted to degrees).
export function upload(upload: Upload<string | Blob>, signal?: AbortSignal) {
	const data = {
		session: typeof upload.session === 'string' ? upload.session : upload.session?.session,
		url: typeof upload.input === 'string' ? upload.input : '',
		allow_commercial_use: upload.allowCommercialUse ? 'y' : 'n',
		allow_modifications: upload.allowModifications ? 'y' : 'n',
		publicly_visible: upload.publiclyVisible ? 'y' : 'n',
		scale_units: upload.scaleUnits || 'degwidth',
		scale_lower: upload.scaleLower === undefined ? 0.1 : toDeg(upload.scaleLower),
		scale_upper: upload.scaleUpper === undefined ? 180 : toDeg(upload.scaleUpper),
		scale_type: upload.scaleType ?? 'ul',
		scale_est: upload.scaleEstimated === undefined ? undefined : toDeg(upload.scaleEstimated),
		scale_err: upload.scaleError,
		center_ra: upload.rightAscension !== undefined ? toDeg(normalizeAngle(upload.rightAscension)) : undefined,
		center_dec: upload.declination !== undefined ? toDeg(upload.declination) : undefined,
		radius: upload.radius !== undefined ? toDeg(upload.radius) : undefined,
		downsample_factor: Math.max(2, upload.downsample ?? 2),
		tweak_order: upload.tweakOrder ?? 2,
		crpix_center: upload.crpixCenter ?? true,
		parity: upload.parity ?? 2,
	}

	if (typeof upload.input === 'string') {
		return requestForm<Submission>(`${upload.apiUrl || NOVA_ASTROMETRY_NET_URL}/api/url_upload`, data, signal ?? upload.signal)
	} else {
		return requestMultipart<Submission>(`${upload.apiUrl || NOVA_ASTROMETRY_NET_URL}/api/upload`, data, upload.input, signal ?? upload.signal)
	}
}

// Fetches the current status of a submission by id or object.
export function submissionStatus(submission: number | Submission, options: RequiredOnly<Omit<RequestOptions, 'apiKey'>, 'session'>, signal?: AbortSignal) {
	const subId = typeof submission === 'number' ? submission : submission.subid
	return request<SubmissionStatus>(`${options.apiUrl || NOVA_ASTROMETRY_NET_URL}/api/submissions/${subId}`, 'GET', undefined, signal ?? options.signal)
}

// Fetches the current status of a solve job by id.
export function jobStatus(jobId: number, options: RequiredOnly<Omit<RequestOptions, 'apiKey'>, 'session'>, signal?: AbortSignal) {
	return request<Job>(`${options.apiUrl || NOVA_ASTROMETRY_NET_URL}/api/jobs/${jobId}`, 'GET', undefined, signal ?? options.signal)
}

// Downloads the solved WCS FITS file for a job as a Blob.
export function wcsFile(jobId: number, options: RequiredOnly<Omit<RequestOptions, 'apiKey'>, 'session'>, signal?: AbortSignal) {
	return requestBlob(`${options.apiUrl || NOVA_ASTROMETRY_NET_URL}/wcs_file/${jobId}`, 'GET', undefined, signal ?? options.signal)
}

// End-to-end nova solve: logs in (unless a session is supplied), uploads the image, polls the
// submission/job until a job succeeds or the timeout aborts, then parses the downloaded WCS into a
// PlateSolution. Returns undefined on failure, timeout, or job failure.
export async function novaAstrometryNetPlateSolve(input: string | Blob, options?: Omit<Upload<never>, 'input'>, signal?: AbortSignal): Promise<PlateSolution | undefined> {
	const session = options?.session || (await login(options, signal))

	if (session) {
		const submission = await upload({ ...options, input, session }, signal)

		if (submission?.status === 'success') {
			const timeout = AbortSignal.timeout(options?.timeout || 300000)
			// Wake the inter-poll wait as soon as the overall timeout or the caller's signal aborts.
			const wait = signal ? AbortSignal.any([timeout, signal]) : timeout

			while (!timeout.aborted) {
				const status = await submissionStatus(submission, { session }, signal)

				// A job slot is null until created and a created job stays 'solving' until it finishes,
				// so wait for a real job id and poll its status instead of grabbing the WCS too early.
				const jobId = status?.jobs.find((id): id is number => typeof id === 'number')

				if (jobId !== undefined) {
					const job = await jobStatus(jobId, { session }, signal)

					if (job?.status === 'success') {
						const blob = await wcsFile(jobId, { session }, signal)

						if (blob) {
							const buffer = Buffer.from(await blob.arrayBuffer())
							const fits = await readFits(bufferSource(buffer))

							if (fits?.hdus.length) {
								return plateSolutionFrom(fits.hdus[0].header)
							}
						}

						break
					} else if (job?.status === 'failure') {
						break
					}
					// Otherwise the job is still solving; keep polling until it resolves or times out.
				}

				await abortableSleep(15000, wait)
			}
		}
	}

	return undefined
}

// https://astrometry.net/doc/readme.html

// Plate-solves an image with the local `solve-field` CLI into a temporary directory, optionally
// constrained by an RA/Dec/radius and FOV hint, then parses the produced .wcs into a PlateSolution.
// Cleans up the temp directory afterward; returns undefined when solving fails. Declination defaults to
// the pole only when no hint is given (0 is a valid equator hint).
export async function localAstrometryNetPlateSolve(input: string, options: RequiredOnly<LocalAstrometryNetPlateSolveOptions, 'executable'>, signal?: AbortSignal) {
	const timeout = options.timeout ?? 0
	const downsample = options.downsample ?? 2
	const r = options?.radius ? Math.max(0, Math.min(Math.ceil(toDeg(options.radius)), 180)) : 0
	const ra = options?.rightAscension !== undefined ? toDeg(normalizeAngle(options.rightAscension)) : 0
	// declination 0 is the celestial equator, a valid hint; only fall back to the pole when it is absent.
	const dec = options?.declination !== undefined ? toDeg(options.declination) : 90
	const fov = Math.max(0, Math.min(toDeg(options?.fov ?? 0), 360))
	const outDir = join(tmpdir(), Bun.randomUUIDv7())
	const wcs = join(outDir, 'nebulosa.wcs')

	const commands = [
		options.executable,
		'--out',
		'nebulosa',
		'--overwrite',
		'--dir',
		outDir,
		'--cpulimit',
		timeout >= 1000 ? Math.trunc(timeout / 1000).toFixed(0) : '300',
		'--crpix-center',
		'--downsample',
		Math.max(downsample, 2).toFixed(0),
		'--no-verify',
		'--no-plots',
		'--skip-solved',
		'--no-remove-lines',
		'--uniformize',
		'0',
	]

	if (fov > 0) {
		commands.push('--scale-units', 'degwidth')
		commands.push('--scale-low', `${fov * 0.7}`)
		commands.push('--scale-high', `${fov * 1.3}`)
	} else {
		commands.push('--guess-scale')
	}

	if (r) {
		commands.push('--ra', `${ra}`)
		commands.push('--dec', `${dec}`)
		commands.push('--radius', `${r}`)
	}

	commands.push(input)

	const process = Bun.spawn(commands, { signal, timeout: options?.timeout || 300000 })
	const exitCode = await process.exited

	try {
		if (exitCode === 0 && (await Bun.file(wcs).exists())) {
			const handle = await fs.open(wcs)
			await using source = fileHandleSource(handle)
			const fits = await readFits(source)

			if (fits?.hdus.length) {
				const header = fits.hdus[0].header
				return plateSolutionFrom(header)
			}
		}
	} finally {
		await fs.rm(outDir, { recursive: true, force: true })
	}

	return undefined
}

// Resolves after the given delay, or earlier if the signal aborts. Never rejects.
function abortableSleep(ms: number, signal?: AbortSignal) {
	return new Promise<void>((resolve) => {
		let settled = false

		// Whichever of the timer or the abort fires first resolves the promise exactly once;
		// the `settled` guard makes the second caller a no-op (false positive for the lint rule).
		const finish = () => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			signal?.removeEventListener('abort', finish)
			// oxlint-disable-next-line promise/no-multiple-resolved
			resolve()
		}

		const timer = setTimeout(finish, ms)

		if (signal?.aborted) finish()
		else signal?.addEventListener('abort', finish, { once: true })
	})
}

// Performs a fetch and returns the parsed JSON body, or undefined on a non-OK response.
async function request<T>(url: string | URL, method: string, body?: BodyInit, signal?: AbortSignal): Promise<T | undefined> {
	const response = await fetch(url, { method, body, signal })
	if (response.ok) return await response.json()
	else return undefined
}

// POSTs a `request-json` form field, the URL-encoded body shape the nova API expects.
function requestForm<T>(url: string | URL, data: unknown, signal?: AbortSignal) {
	const body = new URLSearchParams()
	body.append('request-json', JSON.stringify(data))
	return request<T>(url, 'POST', body, signal)
}

// POSTs a multipart body with the `request-json` field plus the image file, for direct uploads.
function requestMultipart<T>(url: string | URL, data: unknown, file: Blob, signal?: AbortSignal) {
	const body = new FormData()
	body.append('request-json', JSON.stringify(data))
	body.append('file', file, `${Bun.randomUUIDv7()}.fits`)
	return request<T>(url, 'POST', body, signal)
}

// Performs a fetch and returns the response Blob, or undefined on a non-OK response.
async function requestBlob(url: string | URL, method: string, body?: BodyInit, signal?: AbortSignal): Promise<Blob | undefined> {
	const response = await fetch(url, { method, body, signal })
	if (response.ok) return response.blob()
	else return undefined
}
