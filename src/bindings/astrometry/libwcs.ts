import { dlopen, type Pointer, ptr, read } from 'bun:ffi'
import path from '../../../native/libwcs.shared' with { type: 'file' }
import { isWcsFitsKeyword } from '../../astrometry/wcs/fits.wcs'
import { type FitsHeader, FitsKeywordWriter } from '../../io/formats/fits/fits'
import { type Angle, deg, toDeg } from '../../math/units/angle'

// FFI binding to WCSLIB (libwcs) via bun:ffi. Parses the WCS keywords of a FITS header into a native
// two-axis equatorial wcsprm struct and exposes pixel↔sky transforms. Sky angles are radians in the
// header's equatorial frame, converted to/from the degrees WCSLIB uses, always ordered [RA, Dec].
// Native memory is owned by the Wcs class (Disposable).

// Resolved type of the dlopen handle returned by open(); used to type the cached library instance.
export type LibWcs = ReturnType<typeof open>

// Opens the WCSLIB shared library and declares the parse/transform/free symbols used here. Returns a
// fresh dlopen handle each call; prefer load() for the cached one.
export function open() {
	return dlopen(path, {
		wcspih: { args: ['buffer', 'int', 'int', 'int', 'ptr', 'ptr', 'ptr'], returns: 'int' },
		wcsp2s: { args: ['usize', 'int', 'int', 'ptr', 'ptr', 'ptr', 'ptr', 'ptr', 'ptr'], returns: 'int' },
		wcss2p: { args: ['usize', 'int', 'int', 'ptr', 'ptr', 'ptr', 'ptr', 'ptr', 'ptr'], returns: 'int' },
		// int wcsvfree(int *nwcs, struct wcsprm **wcs): frees the wcsprm array allocated by wcspih,
		// including the calloc'd container that plain wcsfree leaves behind.
		wcsvfree: { args: ['ptr', 'ptr'], returns: 'int' },
	})
}

// Process-wide cached library handle, opened on first load() and cleared by unload().
let libwcs: LibWcs | undefined

// Returns the cached native symbol table, opening the library on first use.
export function load() {
	return (libwcs ??= open()).symbols
}

// Closes and clears the cached library handle. Safe to call when nothing is loaded.
export function unload() {
	libwcs?.close()
	libwcs = undefined
}

// Owns a single native wcsprm parsed from a FITS header and provides pixel↔sky conversions. Disposable
// because it holds native memory; reusable via load(), which replaces any previously held solution.
export class Wcs implements Disposable {
	// Native wcsprm pointer; undefined until a header is loaded or after disposal.
	#pointer?: Pointer
	// Zero-based FITS world-axis index of RA; the other axis is Dec. Set only on successful load.
	#raAxis = 0
	readonly #lib = load()

	// Optionally parses a header immediately. Throws if the header has no usable single WCS solution.
	constructor(header?: FitsHeader) {
		if (header && !this.load(header)) {
			throw new Error('failed to initialize WCS from header')
		}
	}

	// Parses the WCS keywords of `header` into a native wcsprm. Returns true and replaces the previous
	// solution only for a single two-axis equatorial WCS, with RA/Dec in either FITS axis order.
	// Unsupported headers return false; any native candidate is freed, preserving the previous solution.
	load(header: FitsHeader) {
		const ctype1 = String(header.CTYPE1 ?? '').trim()
		const ctype2 = String(header.CTYPE2 ?? '').trim()
		const raAxis = ctype1.startsWith('RA---') && ctype2.startsWith('DEC--') ? 0 : ctype1.startsWith('DEC--') && ctype2.startsWith('RA---') ? 1 : -1
		// This API exposes RA/Dec, so other celestial frames or linear axes cannot be relabeled as sky.
		if (raAxis < 0) return false

		const [buffer, n] = bufferFromHeader(header)

		if (n > 0) {
			const mem = Buffer.allocUnsafe(4 + 4 + 8)
			const nreject = ptr(mem, 0)
			const nwcs = ptr(mem, 4)
			const wcsprm = ptr(mem, 8)
			const ret = this.#lib.wcspih(buffer, n, 0x000fffff, 0, nreject, nwcs, wcsprm)

			if (ret === 0) {
				if (read.i32(nwcs) === 1) {
					const pointer = read.ptr(wcsprm) as Pointer
					// WCSLIB wcs.h starts wcsprm with int flag, int naxis (offset 4).
					// For ncoord=1, transforms ignore nelem and access naxis doubles: reject other
					// dimensions before they can overrun or leave uninitialized our two-axis buffers.
					if (read.i32(pointer, 4) === 2) {
						this[Symbol.dispose]()
						this.#pointer = pointer
						this.#raAxis = raAxis
						return true
					}
				}

				// Release every rejected WCS array, including unsupported dimensions.
				this.#lib.wcsvfree(nwcs, wcsprm)
			}
		}

		return false
	}

	// Transforms a pixel coordinate (x, y), 1-based FITS convention, to sky [RA, Dec] in radians. Returns
	// undefined if no WCS is loaded or the native transform fails.
	pixToSky(x: number, y: number): [Angle, Angle] | undefined {
		if (this.#pointer) {
			const mem = Buffer.allocUnsafe(8 * 8 + 4)
			mem.writeDoubleLE(x, 0)
			mem.writeDoubleLE(y, 8)

			const pixcrd = ptr(mem, 0)
			const imgcrd = ptr(mem, 16)
			const phi = ptr(mem, 32)
			const theta = ptr(mem, 40)
			const world = ptr(mem, 48)
			const stat = ptr(mem, 64)

			const ret = this.#lib.wcsp2s(this.#pointer, 1, 2, pixcrd, imgcrd, phi, theta, world, stat)

			if (ret === 0) {
				return [deg(read.f64(world, this.#raAxis * 8)), deg(read.f64(world, (1 - this.#raAxis) * 8))]
			} else {
				console.error('failed to transform pixel coordinates to sky coordinates:', ret)
			}
		}

		return undefined
	}

	// Transforms sky coordinates (RA, Dec in radians) to a pixel coordinate [x, y], 1-based FITS
	// convention. Returns undefined if no WCS is loaded or the native transform fails.
	skyToPix(ra: Angle, dec: Angle): [number, number] | undefined {
		if (this.#pointer) {
			const mem = Buffer.allocUnsafe(8 * 8 + 4)
			mem.writeDoubleLE(toDeg(ra), 48 + this.#raAxis * 8)
			mem.writeDoubleLE(toDeg(dec), 48 + (1 - this.#raAxis) * 8)

			const pixcrd = ptr(mem, 0)
			const imgcrd = ptr(mem, 16)
			const phi = ptr(mem, 32)
			const theta = ptr(mem, 40)
			const world = ptr(mem, 48)
			const stat = ptr(mem, 64)

			const ret = this.#lib.wcss2p(this.#pointer, 1, 2, world, phi, theta, imgcrd, pixcrd, stat)

			if (ret === 0) {
				return [read.f64(pixcrd), read.f64(pixcrd, 8)]
			} else {
				console.error('failed to transform sky coordinates to pixel coordinates:', ret)
			}
		}

		return undefined
	}

	// Releases the native wcsprm (internals plus the calloc'd array container) and clears the pointer.
	[Symbol.dispose]() {
		if (this.#pointer) {
			// Free both the wcsprm internals and the calloc'd array container from wcspih. nwcs is 1
			// (load only keeps the single-WCS case) and the wcsprm pointer is written into the slot
			// that wcsvfree dereferences and then clears.
			const mem = Buffer.allocUnsafe(16)
			mem.writeInt32LE(1, 0)
			mem.writeBigUInt64LE(BigInt(this.#pointer), 8)
			this.#lib.wcsvfree(ptr(mem, 0), ptr(mem, 8))
			this.#pointer = undefined
		}
	}
}

// Serializes the WCS-relevant keywords of a header into a packed buffer of 80-byte FITS card images,
// the format wcspih expects. Returns the buffer and the number of cards written.
function bufferFromHeader(header: FitsHeader) {
	const writer = new FitsKeywordWriter()
	const keys = Object.keys(header).filter(isWcsFitsKeyword)
	const output = Buffer.allocUnsafe(keys.length * 80)

	if (keys.length > 0) {
		let n = 0

		for (const key of keys) {
			const value = header[key]
			n += writer.write([key, value], output, n)
		}
	}

	return [output, keys.length] as const
}
