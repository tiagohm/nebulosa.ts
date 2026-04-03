import { dlopen, type Pointer, ptr, read } from 'bun:ffi'
import path from '../native/libwcs.shared' with { type: 'file' }
import { type Angle, deg, toDeg } from './angle'
import { type FitsHeader, FitsKeywordWriter } from './fits'
import { isWcsFitsKeyword } from './fits.wcs'

export type LibWcs = ReturnType<typeof open>

export function open() {
	return dlopen(path, {
		wcspih: { args: ['buffer', 'int', 'int', 'int', 'ptr', 'ptr', 'ptr'], returns: 'int' },
		wcsp2s: { args: ['usize', 'int', 'int', 'ptr', 'ptr', 'ptr', 'ptr', 'ptr', 'ptr'], returns: 'int' },
		wcss2p: { args: ['usize', 'int', 'int', 'ptr', 'ptr', 'ptr', 'ptr', 'ptr', 'ptr'], returns: 'int' },
		wcsfree: { args: ['usize'], returns: 'int' },
	})
}

let libwcs: LibWcs | undefined

export function load() {
	return (libwcs ??= open()).symbols
}

export function unload() {
	libwcs?.close()
	libwcs = undefined
}

export class Wcs implements Disposable {
	#pointer?: Pointer
	readonly #lib = load()

	constructor(header?: FitsHeader) {
		if (header && !this.load(header)) {
			throw new Error('failed to initialize WCS from header')
		}
	}

	load(header: FitsHeader) {
		const [buffer, n] = bufferFromHeader(header)

		if (n > 0) {
			const mem = Buffer.allocUnsafe(4 + 4 + 8)
			const nreject = ptr(mem, 0)
			const nwcs = ptr(mem, 4)
			const wcsprm = ptr(mem, 8)
			const ret = this.#lib.wcspih(buffer, n, 0x000fffff, 0, nreject, nwcs, wcsprm)

			if (ret === 0 && read.i32(nwcs) === 1) {
				this[Symbol.dispose]()
				this.#pointer = read.ptr(wcsprm) as Pointer
				return true
			}
		}

		return false
	}

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
				return [deg(read.f64(world)), deg(read.f64(world, 8))]
			} else {
				console.error('failed to transform pixel coordinates to sky coordinates:', ret)
			}
		}

		return undefined
	}

	skyToPix(ra: Angle, dec: Angle): [number, number] | undefined {
		if (this.#pointer) {
			const mem = Buffer.allocUnsafe(8 * 8 + 4)
			mem.writeDoubleLE(toDeg(ra), 48)
			mem.writeDoubleLE(toDeg(dec), 56)

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

	[Symbol.dispose]() {
		if (this.#pointer) {
			this.#lib.wcsfree(this.#pointer)
			this.#pointer = undefined
		}
	}
}

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
