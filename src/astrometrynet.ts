// https://astrometry.net/doc/net/api.html

import type { Required } from 'utility-types'
import { type Angle, toDeg } from './angle'
import { readFits } from './fits'
import { bufferSource } from './io'
import { EMPTY_PLATE_SOLUTION, type PlateSolution, type PlateSolveOptions, plateSolutionFrom } from './platesolver'

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
	scaleEstimated?: number
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
		scale_lower: upload.scaleLower ?? 0.1,
		scale_upper: upload.scaleUpper ?? 180,
		scale_type: upload.scaleType ?? 'ul',
		scale_est: upload.scaleEstimated,
		scale_err: upload.scaleError,
		center_ra: upload.ra !== undefined ? toDeg(upload.ra) : undefined,
		center_dec: upload.dec !== undefined ? toDeg(upload.dec) : undefined,
		radius: upload.radius !== undefined ? toDeg(upload.radius) : undefined,
		downsample_factor: Math.max(2, upload.downsampleFactor ?? 2),
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

export async function novaAstrometryNetPlateSolve(input: string | Blob, options?: Omit<Upload<never>, 'input'>, signal?: AbortSignal): Promise<PlateSolution> {
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

	return structuredClone(EMPTY_PLATE_SOLUTION)
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
