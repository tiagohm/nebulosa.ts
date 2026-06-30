import { dlopen, type Pointer, read } from 'bun:ffi'
import fs from 'fs/promises'
import { tmpdir } from 'os'
import { basename, join } from 'path'
import path from '../../../native/libastrometry.shared' with { type: 'file' }
import { type Parity, type PlateSolution, plateSolutionFrom } from '../../astrometry/solvers/platesolver'
import type { DetectStarOptions, DetectedStar } from '../../imaging/stars/detector'
import { readFits } from '../../io/formats/fits/fits'
import { fileHandleSource } from '../../io/io'
import { type Angle, normalizeAngle, toArcsec, toDeg } from '../../math/units/angle'

// FFI binding to the astrometry.net solver (libastrometry) via bun:ffi. Wraps the blind plate-solving
// pipeline: load index files, build a star field from detected sources, configure search hints, run the
// solver, and convert the best TAN/SIP match into a PlateSolution by round-tripping through a temp WCS
// file. Angles are radians on the public API and converted to the degrees/arcsec the C API expects.

// Resolved type of the dlopen handle returned by open(); used to type the cached library instance.
export type LibAstrometry = ReturnType<typeof open>

// One index path or a list of them; each may be a file or a directory scanned recursively.
export type AstrometryNetIndexes = string | readonly string[]

// Detected sources fed to the solver: only pixel position and flux are used.
export type AstrometryNetInput = readonly Pick<DetectedStar, 'x' | 'y' | 'flux'>[]

// Parity hint, as a label or its raw C enum value: NORMAL=0, FLIPPED=1, BOTH=2.
export type AstrometryNetParity = Parity | 'BOTH' | 0 | 1 | 2

// Configuration for a single blind/hinted plate solve. All angles are radians.
export interface AstrometryNetSolveOptions extends Partial<DetectStarOptions> {
	// Index files or directories to search against (required).
	readonly indexes: AstrometryNetIndexes
	// Search-center right ascension hint, radians.
	readonly rightAscension?: Angle
	// Search-center declination hint, radians.
	readonly declination?: Angle
	// Search radius around the center hint, radians (clamped to 0..180°).
	readonly radius?: Angle
	// Field of view used to derive pixel scale when `scale` is absent, radians.
	readonly fov?: Angle
	// Pixel scale (angle per pixel), radians; overrides `fov`-derived scale.
	readonly scale?: Angle
	// Fractional tolerance on the derived scale (default 0.3 = ±30%).
	readonly scaleError?: number
	// Explicit lower bound of the pixel scale, radians; overrides `scale`/`scaleError`.
	readonly scaleLow?: Angle
	// Explicit upper bound of the pixel scale, radians; overrides `scale`/`scaleError`.
	readonly scaleHigh?: Angle
	// Parity hint passed to the solver.
	readonly parity?: AstrometryNetParity
	// SIP polynomial order for WCS tweaking; false disables tweaking (default order 2).
	readonly tweakOrder?: number | false
	// Force the reference pixel (CRPIX) to the image center.
	readonly crpixCenter?: boolean
	// Explicit reference pixel [x, y]; overrides `crpixCenter`.
	readonly crpix?: readonly [number, number]
	// Verification noise floor in pixels.
	readonly verifyPixelSigma?: number
	// Code (quad shape) matching tolerance.
	readonly codeTolerance?: number
	// Minimum log-odds for a match to be kept.
	readonly logOddsToKeep?: number
	// Cap on the number of quads tried.
	readonly maxQuads?: number
	// Cap on the number of matches evaluated.
	readonly maxMatches?: number
}

// Matches astrometry.net index FITS filenames, e.g. index-4203.fits or index-*.fits.fz.
const INDEX_FILE = /^index-.*\.fit(?:s|s\.fz)?$/i

// Byte offset of the embedded `tan_t` WCS struct within the C MatchObj; added to the match pointer.
const MATCHOBJ_WCSTAN_OFFSET = 432
// Byte offset of the `sip_t*` pointer within the C MatchObj; read to get the SIP solution if present.
const MATCHOBJ_SIP_OFFSET = 640

// Opens the astrometry.net shared library and declares the solver/index/starxy/WCS symbols used here.
// Returns a fresh dlopen handle each call; prefer load() for the cached one.
// https://github.com/tiagohm/astrometry.net. Windows is supported!
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

// Process-wide cached library handle, opened on first load() and cleared by unload().
let libastrometry: LibAstrometry | undefined

// Returns the cached native symbol table, opening the library on first use.
export function load() {
	return (libastrometry ??= open()).symbols
}

// Closes and clears the cached library handle. Safe to call when nothing is loaded.
export function unload() {
	libastrometry?.close()
	libastrometry = undefined
}

// Stateful wrapper around a single native solver instance plus its loaded indexes. Owns native memory,
// so it implements Disposable; reuse across solves is supported (each solve resets and reloads state).
export class AstrometryNet implements Disposable {
	// Native solver_t pointer; undefined once disposed.
	#pointer?: Pointer
	// Native index_t pointers loaded for the current solve, freed on dispose.
	readonly #indexes: Pointer[] = []
	// Guards against use after dispose; cleared when a fresh solver is loaded.
	#disposed = false
	readonly #lib = load()

	constructor() {
		this.#load()
	}

	// Runs a plate solve. `width`/`height` are the image dimensions in pixels; pixel coordinates in
	// `input` are 0-based and shifted to the solver's 1-based field on load. Returns undefined when there
	// are no usable indexes, fewer than 3 stars, or the solver fails. Honors `signal` cancellation.
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

	// Allocates a fresh native solver and clears the disposed flag. Throws if allocation fails.
	#load() {
		this.#pointer = this.#lib.solver_new()!

		if (this.#pointer) {
			// #reset() disposes then reloads, so clear the disposed flag or a reused instance would
			// fail #assertOpen on the next solve.
			this.#disposed = false
			return
		}

		throw new Error('failed to create astrometry.net solver')
	}

	// Throws if the instance has already been disposed.
	#assertOpen() {
		if (this.#disposed) {
			throw new Error('astrometry.net solver is disposed')
		}
	}

	// Frees the current solver/indexes and allocates a fresh solver so the instance can be reused.
	#reset() {
		this.dispose()
		this.#load()
	}

	// Frees the native solver and every loaded index, marking the instance disposed. Idempotent.
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

	// Loads each index file into native memory and registers it with the solver. Throws on a bad index.
	#loadIndexes(indexes: readonly string[]) {
		for (const index of indexes) {
			const pointer = this.#lib.index_load(cstring(index), 0, null)

			if (!pointer) throw new Error(`failed to load astrometry.net index: ${index}`)

			this.#indexes.push(pointer)
			this.#lib.solver_add_index(this.#pointer!, pointer)
		}
	}

	// Builds the star field and pushes all search hints (bounds, scale, center, parity, tweak order,
	// CRPIX, tolerances, caps) into the native solver before it runs. Throws if the field cannot be
	// created or an invalid parity is supplied.
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

	// Extracts the best match, writes its SIP (or fallback TAN) WCS to a temp FITS-style .wcs file, reads
	// it back, stamps the true image dimensions into the header, and converts it to a PlateSolution. The
	// temp file is always removed. Returns undefined if there is no match or the WCS cannot be parsed.
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

// Convenience one-shot solve: creates a disposable solver, runs it, and frees it automatically.
export async function libAstrometryNetPlateSolve(input: AstrometryNetInput, width: number, height: number, options: AstrometryNetSolveOptions, signal?: AbortSignal): Promise<PlateSolution | undefined> {
	using solver = new AstrometryNet()
	return await solver.solve(input, width, height, options, signal)
}

// Resolves index inputs to a deduplicated, sorted list of index FITS file paths. Directories are
// scanned recursively for files matching INDEX_FILE; unreadable entries are skipped.
export async function astrometryNetIndexFiles(indexes: AstrometryNetIndexes): Promise<string[]> {
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

// Recursively collects index FITS files under a directory.
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

// Encodes a string as a NUL-terminated buffer for passing to the C API as a cstring.
function cstring(value: string) {
	return Buffer.from(`${value}\0`)
}

// Sorts detected stars by descending flux so the brightest are presented first.
function FluxComparator(a: Pick<DetectedStar, 'flux'>, b: Pick<DetectedStar, 'flux'>) {
	return b.flux - a.flux
}

// Allocates a native starxy field and fills it with the stars sorted brightest-first. Pixel positions
// are shifted from 0-based to the solver's 1-based convention. Returns undefined on allocation failure.
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

// Computes the [low, high] pixel-scale bounds in arcsec/pixel. Explicit scaleLow/scaleHigh win;
// otherwise a center scale (from `scale` or `fov`/width) is widened by `scaleError`. Returns [0, 0]
// (meaning "unconstrained") when no usable scale is available.
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

// Maps a parity label to its C enum value (NORMAL=0, FLIPPED=1, BOTH=2); numeric values pass through.
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
