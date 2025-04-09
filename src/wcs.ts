import { type Pointer, dlopen, ptr, read } from 'bun:ffi'
import wcsPath from '../native/libwcs.shared' with { type: 'file' }
import { type Angle, deg, toDeg } from './angle'
import { type FitsHeader, FitsKeywordWriter, numeric } from './fits'

type LibWcs = ReturnType<typeof open>

function open() {
	return dlopen(wcsPath, {
		wcspih: { args: ['buffer', 'int', 'int', 'int', 'ptr', 'ptr', 'ptr'], returns: 'int' },
		wcsp2s: { args: ['usize', 'int', 'int', 'ptr', 'ptr', 'ptr', 'ptr', 'ptr', 'ptr'], returns: 'int' },
		wcss2p: { args: ['usize', 'int', 'int', 'ptr', 'ptr', 'ptr', 'ptr', 'ptr', 'ptr'], returns: 'int' },
		wcsfree: { args: ['usize'], returns: 'int' },
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
		const [buffer, n] = bufferFromHeader(header)
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

export function hasCd(header: FitsHeader) {
	return 'CD1_1' in header || ('CDELT1' in header && 'CROTA2' in header) || ('CDELT1' in header && 'PC1_1' in header)
}

export function cdMatrix(header: FitsHeader) {
	if (hasCd(header)) {
		return [cd(header, 1, 1), cd(header, 1, 2), cd(header, 2, 1), cd(header, 2, 2)] as const
	} else {
		const a = numeric(header, 'CDELT1')
		const b = numeric(header, 'CDELT2')
		const c = deg(numeric(header, 'CROTA2'))
		return cdFromCdelt(a, b, c)
	}
}

export function cd(header: FitsHeader, i: number, j: number): number {
	if ('CD1_1' in header) {
		return numeric(header, `CD${i}_${j}`)
	} else if ('CROTA2' in header) {
		const a = numeric(header, 'CDELT1')
		const b = numeric(header, 'CDELT2')
		const c = deg(numeric(header, 'CROTA2'))
		const cd = cdFromCdelt(a, b, c)
		return cd[2 * i + j - 3]
	} else if ('PC1_1' in header) {
		const pc11 = numeric(header, 'PC1_1')
		const pc12 = numeric(header, 'PC1_2')
		const pc21 = numeric(header, 'PC2_1')
		const pc22 = numeric(header, 'PC2_2')
		const a = numeric(header, 'CDELT1')
		const b = numeric(header, 'CDELT2')
		const cd = pc2cd(pc11, pc12, pc21, pc22, a, b)
		return cd[2 * i + j - 3]
	} else {
		return 0
	}
}

export function cdFromCdelt(cdelt1: number, cdelt2: number, crota: Angle) {
	const cos0 = Math.cos(crota)
	const sin0 = Math.sin(crota)
	const cd11 = cdelt1 * cos0
	const cd12 = Math.abs(cdelt2) * Math.sign(cdelt1) * sin0
	const cd21 = -Math.abs(cdelt1) * Math.sign(cdelt2) * sin0
	const cd22 = cdelt2 * cos0
	return [cd11, cd12, cd21, cd22] as const
}

export function pc2cd(pc11: number, pc10: number, pc21: number, pc22: number, cdelt1: number, cdelt2: number) {
	return [cdelt1 * pc11, cdelt2 * pc21, cdelt1 * pc10, cdelt2 * pc22] as const
}

function isValidFitsHeaderKey(key: keyof FitsHeader) {
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

function bufferFromHeader(header: FitsHeader) {
	const writer = new FitsKeywordWriter()
	const keys = Object.keys(header).filter(isValidFitsHeaderKey)
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
