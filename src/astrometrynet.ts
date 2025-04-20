// https://astrometry.net/doc/net/api.html

import fs from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import type { Required } from 'utility-types'
import { type Angle, normalizeAngle, toDeg } from './angle'
import { readFits } from './fits'
import { bufferSource, fileHandleSource } from './io'
import { type PlateSolution, type PlateSolveOptions, plateSolutionFrom } from './platesolver'

export type ScaleUnit = 'degwidth' | 'arcminwidth' | 'arcsecperpix'

export type ScaleType = 'ul' | 'ev' // UPPER_LOWER | ESTIMATIVE_ERROR

export interface RequestOptions {
	apiUrl?: string
	apiKey?: string
	session?: string | Session
	signal?: AbortSignal
}

export interface Session {
	readonly status: string
	readonly session?: string
	readonly errormessage?: string
}

export interface Upload<T> extends NovaAstrometryNetPlateSolveOptions {
	input: T
	allowCommercialUse?: boolean
	allowModifications?: boolean
	publiclyVisible?: boolean
	scaleUnits?: ScaleUnit
	scaleLower?: Angle
	scaleUpper?: Angle
	scaleType?: ScaleType
	scaleEstimated?: Angle
	scaleError?: number
	tweakOrder?: number
	crpixCenter?: boolean
	parity?: 0 | 1 | 2
}

export interface Submission {
	readonly status: string
	readonly subid?: number
	readonly errormessage?: string
}

export interface SubmissionStatus {
	readonly processing_started: string
	readonly processing_finished: string
	readonly job_calibrations: number[][]
	readonly jobs: number[]
	readonly user: number
	readonly user_images: number[]
}

export interface NovaAstrometryNetPlateSolveOptions extends PlateSolveOptions, RequestOptions {}

export interface LocalAstrometryNetPlateSolveOptions extends PlateSolveOptions {
	executable?: string
	fov?: Angle
}

export const NOVA_ASTROMETRY_NET_URL = 'https://nova.astrometry.net'
export const NOVA_ASTROMETRY_NET_ANONYMOUS_API_KEY = 'XXXXXXXX'

export function login(options?: Omit<RequestOptions, 'session'>, signal?: AbortSignal) {
	const data = { apikey: options?.apiKey || NOVA_ASTROMETRY_NET_ANONYMOUS_API_KEY }
	return requestForm<Session>(`${options?.apiUrl || NOVA_ASTROMETRY_NET_URL}/api/login`, data, signal ?? options?.signal)
}

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
		center_ra: upload.ra !== undefined ? toDeg(normalizeAngle(upload.ra)) : undefined,
		center_dec: upload.dec !== undefined ? toDeg(upload.dec) : undefined,
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

export function submissionStatus(submission: number | Submission, options: Required<Omit<RequestOptions, 'apiKey'>, 'session'>, signal?: AbortSignal) {
	const subId = typeof submission === 'number' ? submission : submission.subid
	return request<SubmissionStatus>(`${options.apiUrl || NOVA_ASTROMETRY_NET_URL}/api/submissions/${subId}`, 'GET', undefined, signal ?? options.signal)
}

export function wcsFile(jobId: number, options: Required<Omit<RequestOptions, 'apiKey'>, 'session'>, signal?: AbortSignal) {
	return requestBlob(`${options.apiUrl || NOVA_ASTROMETRY_NET_URL}/wcs_file/${jobId}`, 'GET', undefined, signal ?? options.signal)
}

export async function novaAstrometryNetPlateSolve(input: string | Blob, options?: Omit<Upload<never>, 'input'>, signal?: AbortSignal): Promise<PlateSolution | undefined> {
	const session = options?.session || (await login(options, signal))

	if (session) {
		const submission = await upload({ ...options, input, session }, signal)

		if (submission?.status === 'success') {
			const timeout = AbortSignal.timeout(options?.timeout || 300000)

			while (!timeout.aborted) {
				const status = await submissionStatus(submission, { session }, signal)

				if (status?.jobs.length) {
					const blob = await wcsFile(status.jobs[0], { session }, signal)

					if (blob) {
						const buffer = Buffer.from(await blob.arrayBuffer())
						const fits = await readFits(bufferSource(buffer))

						if (fits?.hdus.length) {
							return plateSolutionFrom(fits.hdus[0].header)
						}
					}

					break
				}

				await Bun.sleep(15000)
			}
		}
	}

	return undefined
}

// https://astrometry.net/doc/readme.html

export async function localAstrometryNetPlateSolve(input: string, options: Required<LocalAstrometryNetPlateSolveOptions, 'executable'>, signal?: AbortSignal) {
	const timeout = options.timeout ?? 0
	const downsample = options.downsample ?? 2
	const r = options?.radius ? Math.max(0, Math.min(Math.ceil(toDeg(options.radius)), 180)) : 0
	const ra = options?.ra ? toDeg(normalizeAngle(options.ra)) : 0
	const dec = options?.dec ? toDeg(options.dec) : 90
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
		if (exitCode === 0 && (await fs.exists(wcs))) {
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

async function request<T>(url: string | URL, method: string, body?: BodyInit, signal?: AbortSignal): Promise<T | undefined> {
	const response = await fetch(url, { method, body, signal })
	if (response.ok) return await response.json()
	else return undefined
}

function requestForm<T>(url: string | URL, data: unknown, signal?: AbortSignal) {
	const body = new URLSearchParams()
	body.append('request-json', JSON.stringify(data))
	return request<T>(url, 'POST', body, signal)
}

function requestMultipart<T>(url: string | URL, data: unknown, file: Blob, signal?: AbortSignal) {
	const body = new FormData()
	body.append('request-json', JSON.stringify(data))
	body.append('file', file, `${Bun.randomUUIDv7()}.fits`)
	return request<T>(url, 'POST', body, signal)
}

async function requestBlob(url: string | URL, method: string, body?: BodyInit, signal?: AbortSignal): Promise<Blob | undefined> {
	const response = await fetch(url, { method, body, signal })
	if (response.ok) return response.blob()
	else return undefined
}
