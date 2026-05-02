import fs from 'fs/promises'
import { tmpdir } from 'os'
import { basename, join } from 'path'
import { dlopen, type Pointer, read } from 'bun:ffi'
import path from '../native/libastrometry.shared' with { type: 'file' }
import { type Angle, normalizeAngle, toArcsec, toDeg } from './angle'
import { readFits } from './fits'
import { fileHandleSource } from './io'
import { type Parity, type PlateSolution, plateSolutionFrom } from './platesolver'
import type { DetectStarOptions, DetectedStar } from './star.detector'

export type LibAstrometry = ReturnType<typeof open>

export type AstrometryNetIndexInput = string | readonly string[]

export type AstrometryNetInput = readonly Pick<DetectedStar, 'x' | 'y' | 'flux'>[]

export type AstrometryNetParity = Parity | 'BOTH' | 0 | 1 | 2

export interface AstrometryNetSolveOptions extends Partial<DetectStarOptions> {
	readonly indexes: AstrometryNetIndexInput
	readonly rightAscension?: Angle
	readonly declination?: Angle
	readonly radius?: Angle
	readonly fov?: Angle
	readonly scale?: Angle
	readonly scaleError?: number
	readonly scaleLow?: Angle
	readonly scaleHigh?: Angle
	readonly parity?: AstrometryNetParity
	readonly tweakOrder?: number | false
	readonly crpixCenter?: boolean
	readonly crpix?: readonly [number, number]
	readonly verifyPixelSigma?: number
	readonly codeTolerance?: number
	readonly logOddsToKeep?: number
	readonly maxQuads?: number
	readonly maxMatches?: number
}

const INDEX_FILE = /^index-.*\.fit(?:s|s\.fz)?$/i

const MATCHOBJ_WCSTAN_OFFSET = 432
const MATCHOBJ_SIP_OFFSET = 640

export function open() {
	return dlopen(path, {
		index_load: { args: ['cstring', 'int', 'ptr'], returns: 'ptr' },
		index_free: { args: ['ptr'] },
		solver_new: { returns: 'ptr' },
		solver_free: { args: ['ptr'] },
		solver_clear_indexes: { args: ['ptr'] },
		solver_add_index: { args: ['ptr', 'ptr'] },
		solver_set_field: { args: ['ptr', 'ptr'] },
		solver_set_field_bounds: { args: ['ptr', 'double', 'double', 'double', 'double'] },
		solver_set_radec: { args: ['ptr', 'double', 'double', 'double'] },
		solver_clear_radec: { args: ['ptr'] },
		solver_set_parity: { args: ['ptr', 'int'], returns: 'int' },
		solver_set_scale_range: { args: ['ptr', 'double', 'double'] },
		solver_set_tweak_order: { args: ['ptr', 'int', 'int', 'int'] },
		solver_set_crpix: { args: ['ptr', 'double', 'double'] },
		solver_set_crpix_center: { args: ['ptr', 'int'] },
		solver_set_verify_pix: { args: ['ptr', 'double'] },
		solver_set_codetol: { args: ['ptr', 'double'] },
		solver_set_keep_logodds: { args: ['ptr', 'double'] },
		solver_set_maxquads: { args: ['ptr', 'int'] },
		solver_set_maxmatches: { args: ['ptr', 'int'] },
		solver_run: { args: ['ptr'] },
		solver_did_solve: { args: ['ptr'], returns: 'bool' },
		solver_get_best_match: { args: ['ptr'], returns: 'ptr' },
		starxy_new: { args: ['int', 'bool', 'bool'], returns: 'ptr' },
		starxy_free: { args: ['ptr'] },
		starxy_setx: { args: ['ptr', 'int', 'double'] },
		starxy_sety: { args: ['ptr', 'int', 'double'] },
		starxy_set_flux: { args: ['ptr', 'int', 'double'] },
		tan_write_to_file: { args: ['ptr', 'cstring'], returns: 'int' },
		sip_write_to_file: { args: ['ptr', 'cstring'], returns: 'int' },
	})
}

let libastrometry: LibAstrometry | undefined

export function load() {
	return (libastrometry ??= open()).symbols
}

export function unload() {
	libastrometry?.close()
	libastrometry = undefined
}

export class AstrometryNet implements Disposable {
	#pointer?: Pointer
	readonly #indexes: Pointer[] = []
	#disposed = false
	readonly #lib = load()

	constructor() {
		this.#load()
	}

	async solve(input: AstrometryNetInput, width: number, height: number, options: AstrometryNetSolveOptions, signal?: AbortSignal): Promise<PlateSolution | undefined> {
		this.#assertOpen()
		this.#reset()
		signal?.throwIfAborted()

		const indexes = await astrometryNetIndexFiles(options.indexes)
		if (indexes.length === 0) return undefined

		if (input.length < 3) return undefined

		signal?.throwIfAborted()
		this.#loadIndexes(indexes)
		this.#configure(input, width, height, options)
		this.#lib.solver_run(this.#pointer!)
		signal?.throwIfAborted()

		if (!this.#lib.solver_did_solve(this.#pointer!)) return undefined

		return await this.#readSolution(width, height)
	}

	[Symbol.dispose]() {
		this.dispose()
	}

	#load() {
		this.#pointer = this.#lib.solver_new()!
		if (this.#pointer) return
		throw new Error('failed to create astrometry.net solver')
	}

	#assertOpen() {
		if (this.#disposed) {
			throw new Error('astrometry.net solver is disposed')
		}
	}

	#reset() {
		this.dispose()
		this.#load()
	}

	dispose() {
		this.#disposed = true

		if (this.#pointer) {
			this.#lib.solver_clear_indexes(this.#pointer)
			this.#lib.solver_free(this.#pointer)
			this.#pointer = undefined
		}

		for (const index of this.#indexes) {
			this.#lib.index_free(index)
		}

		this.#indexes.length = 0
	}

	#loadIndexes(indexes: readonly string[]) {
		for (const index of indexes) {
			const pointer = this.#lib.index_load(cstring(index), 0, null)

			if (!pointer) throw new Error(`failed to load astrometry.net index: ${index}`)

			this.#indexes.push(pointer)
			this.#lib.solver_add_index(this.#pointer!, pointer)
		}
	}

	#configure(stars: AstrometryNetInput, width: number, height: number, options: AstrometryNetSolveOptions) {
		const field = starField(this.#lib, stars)

		if (!field) throw new Error('failed to create astrometry.net star field')

		this.#lib.solver_set_field(this.#pointer!, field)
		this.#lib.solver_set_field_bounds(this.#pointer!, 1, width, 1, height)

		const [scaleLow, scaleHigh] = scaleRange(width, options)

		if (scaleHigh > scaleLow) {
			this.#lib.solver_set_scale_range(this.#pointer!, scaleLow, scaleHigh)
		}

		if (options.radius && options.rightAscension !== undefined && options.declination !== undefined) {
			this.#lib.solver_set_radec(this.#pointer!, toDeg(normalizeAngle(options.rightAscension)), toDeg(options.declination), Math.max(0, Math.min(toDeg(options.radius), 180)))
		} else {
			this.#lib.solver_clear_radec(this.#pointer!)
		}

		if (options.parity !== undefined && this.#lib.solver_set_parity(this.#pointer!, parity(options.parity)) !== 0) {
			throw new Error(`invalid astrometry.net parity: ${options.parity}`)
		}

		if (options.tweakOrder !== false) {
			const order = Math.max(0, Math.trunc(options.tweakOrder ?? 2))
			this.#lib.solver_set_tweak_order(this.#pointer!, 1, order, order)
		} else {
			this.#lib.solver_set_tweak_order(this.#pointer!, 0, 0, 0)
		}

		if (options.crpix) {
			this.#lib.solver_set_crpix(this.#pointer!, options.crpix[0], options.crpix[1])
		} else if (options.crpixCenter ?? true) {
			this.#lib.solver_set_crpix_center(this.#pointer!, 1)
		} else {
			this.#lib.solver_set_crpix_center(this.#pointer!, 0)
		}

		if (options.verifyPixelSigma !== undefined) this.#lib.solver_set_verify_pix(this.#pointer!, Math.max(options.verifyPixelSigma, Number.EPSILON))
		if (options.codeTolerance !== undefined) this.#lib.solver_set_codetol(this.#pointer!, Math.max(options.codeTolerance, Number.EPSILON))
		if (options.logOddsToKeep !== undefined) this.#lib.solver_set_keep_logodds(this.#pointer!, options.logOddsToKeep)
		if (options.maxQuads !== undefined) this.#lib.solver_set_maxquads(this.#pointer!, Math.max(0, Math.trunc(options.maxQuads)))
		if (options.maxMatches !== undefined) this.#lib.solver_set_maxmatches(this.#pointer!, Math.max(0, Math.trunc(options.maxMatches)))
	}

	async #readSolution(width: number, height: number) {
		const match = this.#lib.solver_get_best_match(this.#pointer!)
		if (!match) return undefined

		const output = join(tmpdir(), `${Bun.randomUUIDv7()}.wcs`)
		const sip = read.ptr(match, MATCHOBJ_SIP_OFFSET) as Pointer
		let result = sip ? this.#lib.sip_write_to_file(sip, cstring(output)) : -1
		if (result !== 0) result = this.#lib.tan_write_to_file((match + MATCHOBJ_WCSTAN_OFFSET) as Pointer, cstring(output))

		try {
			if (result !== 0) return undefined

			const handle = await fs.open(output)
			await using source = fileHandleSource(handle)
			const fits = await readFits(source)

			if (fits?.hdus.length) {
				const { header } = fits.hdus[0]
				header.IMAGEW = width
				header.IMAGEH = height

				return plateSolutionFrom(header)
			}
		} finally {
			await fs.rm(output, { force: true })
		}

		return undefined
	}
}

export async function libAstrometryNetPlateSolve(input: AstrometryNetInput, width: number, height: number, options: AstrometryNetSolveOptions, signal?: AbortSignal): Promise<PlateSolution | undefined> {
	using solver = new AstrometryNet()
	return await solver.solve(input, width, height, options, signal)
}

export async function astrometryNetIndexFiles(indexes: AstrometryNetIndexInput): Promise<string[]> {
	const input = typeof indexes === 'string' ? [indexes] : indexes
	const output: string[] = []

	for (const index of input) {
		try {
			const stat = await fs.stat(index)

			if (stat.isDirectory()) {
				output.push(...(await indexFilesInDirectory(index)))
			} else if (stat.isFile()) {
				output.push(index)
			}
		} catch {
			continue
		}
	}

	return [...new Set(output)].sort()
}

async function indexFilesInDirectory(directory: string) {
	const output: string[] = []
	const entries = await fs.readdir(directory, { withFileTypes: true })

	for (const entry of entries) {
		const path = join(directory, entry.name)

		if (entry.isDirectory()) {
			output.push(...(await indexFilesInDirectory(path)))
		} else if (entry.isFile() && INDEX_FILE.test(basename(path))) {
			output.push(path)
		}
	}

	return output
}

function cstring(value: string) {
	return Buffer.from(`${value}\0`)
}

function FluxComparator(a: Pick<DetectedStar, 'flux'>, b: Pick<DetectedStar, 'flux'>) {
	return b.flux - a.flux
}

function starField(lib: ReturnType<typeof load>, stars: AstrometryNetInput) {
	const field = lib.starxy_new(stars.length, true, false)
	if (!field) return undefined

	const sorted = [...stars].sort(FluxComparator)

	for (let i = 0; i < sorted.length; i++) {
		const star = sorted[i]
		lib.starxy_setx(field, i, star.x + 1)
		lib.starxy_sety(field, i, star.y + 1)
		lib.starxy_set_flux(field, i, star.flux)
	}

	return field
}

function scaleRange(width: number, options: AstrometryNetSolveOptions) {
	if (options.scaleLow !== undefined && options.scaleHigh !== undefined) {
		return [Math.max(0, toArcsec(options.scaleLow)), Math.max(0, toArcsec(options.scaleHigh))] as const
	}

	const scale = options.scale ?? (options.fov === undefined ? 0 : options.fov / width)
	if (!(scale > 0)) return [0, 0] as const

	const error = Math.max(0, options.scaleError ?? 0.3)
	const arcsecPerPixel = toArcsec(scale)
	return [Math.max(0, arcsecPerPixel * (1 - error)), arcsecPerPixel * (1 + error)] as const
}

function parity(value: AstrometryNetParity) {
	switch (value) {
		case 'NORMAL':
			return 0
		case 'FLIPPED':
			return 1
		case 'BOTH':
			return 2
		default:
			return value
	}
}
