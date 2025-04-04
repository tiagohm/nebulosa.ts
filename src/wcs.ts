import { type Pointer, dlopen, ptr, read } from 'bun:ffi'
import wcsPath from '../native/libwcs.shared' with { type: 'file' }
import { type Angle, deg, toDeg } from './angle'
import type { FitsHeader } from './fits'

type LibWcs = ReturnType<typeof open>

function open() {
	return dlopen(wcsPath, {
		wcspih: { args: ['buffer', 'int', 'int', 'int', 'ptr', 'ptr', 'ptr'], returns: 'int' },
		wcsp2s: { args: ['ptr', 'int', 'int', 'ptr', 'ptr', 'ptr', 'ptr', 'ptr', 'ptr'], returns: 'int' },
		wcss2p: { args: ['ptr', 'int', 'int', 'ptr', 'ptr', 'ptr', 'ptr', 'ptr', 'ptr'], returns: 'int' },
		wcsfree: { args: ['ptr'], returns: 'int' },
	})
}

let libwcs: LibWcs | undefined

function load() {
	return (libwcs ??= open())
}

export class Wcs implements Disposable {
	private pointer?: Pointer
	private readonly lib = load()

	constructor(header?: FitsHeader) {
		if (header && !this.load(header)) {
			throw new Error('failed to initialize WCS from header')
		}
	}

	load(header: FitsHeader) {
		const [buffer, n] = makeBufferFromHeader(header)
		const mem = Buffer.allocUnsafe(4 + 4 + 8)
		const nreject = ptr(mem, 0)
		const nwcs = ptr(mem, 4)
		const wcsprm = ptr(mem, 8)
		const ret = this.lib.symbols.wcspih(buffer, n, 0x000fffff, 0, nreject, nwcs, wcsprm)

		if (ret === 0 && read.i32(nwcs) === 1) {
			this[Symbol.dispose]()
			this.pointer = read.ptr(wcsprm) as Pointer
			return true
		}

		return false
	}

	pixToSky(x: number, y: number): [Angle, Angle] | undefined {
		if (this.pointer) {
			const mem = Buffer.allocUnsafe(8 * 8 + 4)
			mem.writeDoubleLE(x, 0)
			mem.writeDoubleLE(y, 8)

			const pixcrd = ptr(mem, 0)
			const imgcrd = ptr(mem, 16)
			const phi = ptr(mem, 32)
			const theta = ptr(mem, 40)
			const world = ptr(mem, 48)
			const stat = ptr(mem, 64)

			const ret = this.lib.symbols.wcsp2s(this.pointer, 1, 2, pixcrd, imgcrd, phi, theta, world, stat)

			if (ret === 0) {
				return [deg(read.f64(world)), deg(read.f64(world, 8))]
			} else {
				console.error('failed to transform pixel coordinates to sky coordinates:', ret)
			}
		}

		return undefined
	}

	skyToPix(ra: Angle, dec: Angle): [number, number] | undefined {
		if (this.pointer) {
			const mem = Buffer.allocUnsafe(8 * 8 + 4)
			mem.writeDoubleLE(toDeg(ra), 48)
			mem.writeDoubleLE(toDeg(dec), 56)

			const pixcrd = ptr(mem, 0)
			const imgcrd = ptr(mem, 16)
			const phi = ptr(mem, 32)
			const theta = ptr(mem, 40)
			const world = ptr(mem, 48)
			const stat = ptr(mem, 64)

			const ret = this.lib.symbols.wcss2p(this.pointer, 1, 2, world, phi, theta, imgcrd, pixcrd, stat)

			if (ret === 0) {
				return [read.f64(pixcrd), read.f64(pixcrd, 8)]
			} else {
				console.error('failed to transform sky coordinates to pixel coordinates:', ret)
			}
		}

		return undefined
	}

	[Symbol.dispose]() {
		if (this.pointer) {
			this.lib.symbols.wcsfree(this.pointer)
			this.pointer = undefined
		}
	}
}

function isValidHeaderKey(key: string) {
	return (
		key.startsWith('NAXIS') ||
		key.startsWith('CUNIT') ||
		key.startsWith('CTYPE') ||
		key.startsWith('CRPIX') ||
		key.startsWith('CRVAL') ||
		key.startsWith('PS') ||
		key.startsWith('PV') ||
		key.startsWith('CD') ||
		key.startsWith('PC') ||
		key.startsWith('CDELT') ||
		key.startsWith('CROTA') ||
		key.startsWith('RADESYS') ||
		key.startsWith('LONPOLE') ||
		key.startsWith('LATPOLE') ||
		key.startsWith('EQUINOX') ||
		key.startsWith('A_') ||
		key.startsWith('AP_') ||
		key.startsWith('B_') ||
		key.startsWith('BP_')
	)
}

function makeBufferFromHeader(header: FitsHeader) {
	let text = ''
	let n = 0

	for (const key in header) {
		if (isValidHeaderKey(key)) {
			const value = header[key]

			text += key.padEnd(8, ' ')
			text += '= '
			if (typeof value === 'string') text += `'${value}'`.padEnd(70, ' ')
			else text += `${value}`.padEnd(70, ' ')

			n++
		}
	}

	return [Buffer.from(text, 'ascii'), n] as const
}
