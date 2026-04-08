export type CRCArrayType = Buffer | Uint8Array | Uint8ClampedArray | DataView

// biome-ignore format: too long!
export const CRC_ALGORITHMS = [
	'crc3gsm', 'crc4itu', 'crc4interlaken', 'crc5epc', 'crc5itu', 'crc5usb', 'crc6cdma2000a', 'crc6cdma2000b',
	'crc6darc', 'crc6gsm', 'crc6itu', 'crc7', 'crc7umts', 'crc8', 'crc8cdma2000', 'crc8darc',
	'crc8dvbs2', 'crc8ebu', 'crc8icode', 'crc8itu', 'crc8maxim', 'crc8rohc', 'crc8wcdma', 'crc10',
	'crc10cdma2000', 'crc10gsm', 'crc11', 'crc12', 'crc12cdma2000', 'crc12gsm', 'crc13bbc', 'crc14darc',
	'crc14gsm', 'crc15can', 'crc15mpt1327', 'crc16', 'crc16ccittfalse', 'crc16augccitt', 'crc16buypass', 'crc16cdma2000',
	'crc16dds110', 'crc16dectr', 'crc16dectx', 'crc16dnp', 'crc16en13757', 'crc16genibus', 'crc16maxim', 'crc16mcrf4cc',
	'crc16riello', 'crc16t10dif', 'crc16teledisk', 'crc16tms13157', 'crc16usb', 'crca', 'crc16kermit', 'crc16modbus',
	'crc16x25', 'crc16xmodem', 'crc17can', 'crc21can', 'crc24', 'crc24ble', 'crc24flexraya', 'crc24flexrayb',
	'crc24ltea', 'crc24lteb', 'crc24os9', 'crc30cdma', 'crc32', 'crc32mhash', 'crc32bzip2', 'crc32c',
	'crc32d', 'crc32mpeg2', 'crc32posix', 'crc32q', 'crc32jamcrc', 'crc32xfer',
] as const

export type CRCAlgorithm = (typeof CRC_ALGORITHMS)[number]

export class CRC {
	readonly #table: Uint32Array
	readonly #bit: number
	readonly #polynomial: number
	readonly #initial: number
	readonly #finalXor: number
	readonly #reflect: boolean
	readonly #reorder: boolean

	static #crc3gsm?: CRC
	static #crc4itu?: CRC
	static #crc4interlaken?: CRC
	static #crc5epc?: CRC
	static #crc5itu?: CRC
	static #crc5usb?: CRC
	static #crc6cdma2000a?: CRC
	static #crc6cdma2000b?: CRC
	static #crc6darc?: CRC
	static #crc6gsm?: CRC
	static #crc6itu?: CRC
	static #crc7?: CRC
	static #crc7umts?: CRC
	static #crc8?: CRC
	static #crc8cdma2000?: CRC
	static #crc8darc?: CRC
	static #crc8dvbs2?: CRC
	static #crc8ebu?: CRC
	static #crc8icode?: CRC
	static #crc8itu?: CRC
	static #crc8maxim?: CRC
	static #crc8rohc?: CRC
	static #crc8wcdma?: CRC
	static #crc10?: CRC
	static #crc10cdma2000?: CRC
	static #crc10gsm?: CRC
	static #crc11?: CRC
	static #crc12?: CRC
	static #crc12cdma2000?: CRC
	static #crc12gsm?: CRC
	static #crc13bbc?: CRC
	static #crc14darc?: CRC
	static #crc14gsm?: CRC
	static #crc15can?: CRC
	static #crc15mpt1327?: CRC
	static #crc16?: CRC
	static #crc16ccittfalse?: CRC
	static #crc16augccitt?: CRC
	static #crc16buypass?: CRC
	static #crc16cdma2000?: CRC
	static #crc16dds110?: CRC
	static #crc16dectr?: CRC
	static #crc16dectx?: CRC
	static #crc16dnp?: CRC
	static #crc16en13757?: CRC
	static #crc16genibus?: CRC
	static #crc16maxim?: CRC
	static #crc16mcrf4cc?: CRC
	static #crc16riello?: CRC
	static #crc16t10dif?: CRC
	static #crc16teledisk?: CRC
	static #crc16tms13157?: CRC
	static #crc16usb?: CRC
	static #crca?: CRC
	static #crc16kermit?: CRC
	static #crc16modbus?: CRC
	static #crc16x25?: CRC
	static #crc16xmodem?: CRC
	static #crc17can?: CRC
	static #crc21can?: CRC
	static #crc24?: CRC
	static #crc24ble?: CRC
	static #crc24flexraya?: CRC
	static #crc24flexrayb?: CRC
	static #crc24ltea?: CRC
	static #crc24lteb?: CRC
	static #crc24os9?: CRC
	static #crc30cdma?: CRC
	static #crc32?: CRC
	static #crc32mhash?: CRC
	static #crc32bzip2?: CRC
	static #crc32c?: CRC
	static #crc32d?: CRC
	static #crc32mpeg2?: CRC
	static #crc32posix?: CRC
	static #crc32q?: CRC
	static #crc32jamcrc?: CRC
	static #crc32xfer?: CRC

	constructor(bit: number, polynomial: number, initial: number, reflect: boolean, finalXor: number, reorder: boolean = false) {
		if (bit < 1 || bit > 32) {
			throw new RangeError('crc bit width must be in range [1..32]')
		}

		// Reflected algorithms consume the catalogue init/xor values in reversed register order.
		this.#polynomial = polynomial = reflect ? reflectBits(polynomial, bit) : normalizeCrcValue(polynomial, bit)
		this.#initial = normalizeCrcValue(reflect ? reflectBits(initial, bit) : initial, bit)
		this.#finalXor = normalizeCrcValue(reflect ? reflectBits(finalXor, bit) : finalXor, bit)
		this.#bit = bit
		this.#reflect = reflect
		this.#reorder = reorder

		// Widths below one byte need the bitwise path because the byte table alignment becomes undefined.
		if (bit < 8) {
			this.#table = new Uint32Array(0)
			return
		}

		// Build the lookup table for a CRC configuration.
		const table = new Uint32Array(256)
		const topBit = bit === 32 ? 0x8000_0000 : 1 << (bit - 1)
		const shift = bit - 8

		for (let i = 0; i < 256; i++) {
			let entry = reflect ? i : normalizeCrcValue(i << shift, bit)

			for (let j = 0; j < 8; j++) {
				if (reflect) {
					entry = (entry & 0x01) !== 0 ? (entry >>> 1) ^ polynomial : entry >>> 1
				} else {
					entry = (entry & topBit) !== 0 ? (entry << 1) ^ polynomial : entry << 1
				}

				entry = normalizeCrcValue(entry, bit)
			}

			table[i] = entry
		}

		this.#table = table
	}

	// Computes the checksum, optionally continuing from the previous CRC checksum.
	compute(data: CRCArrayType, previous?: number, offset: number = data.byteOffset, length: number = data.byteLength - offset) {
		const bit = this.#bit
		const bytes = new Uint8Array(data.buffer, offset, length)
		let value = previous === undefined ? this.#initial : definalizeCrc(previous, bit, this.#finalXor, this.#reorder)

		if (bit < 8) {
			value = updateSmallCrc(this.#polynomial, bit, value, this.#reflect, bytes)
			return finalizeCrc(value, bit, this.#finalXor, this.#reorder)
		}

		const shift = bit - 8
		const table = this.#table
		const n = bytes.byteLength

		if (this.#reflect) {
			for (let i = 0; i < n; i++) {
				value = normalizeCrcValue((value >>> 8) ^ table[(value ^ bytes[i]) & 0xff], bit)
			}
		} else {
			for (let i = 0; i < n; i++) {
				value = normalizeCrcValue((value << 8) ^ table[((value >>> shift) ^ bytes[i]) & 0xff], bit)
			}
		}

		return finalizeCrc(value, bit, this.#finalXor, this.#reorder)
	}

	static get crc3gsm() {
		return (CRC.#crc3gsm ??= new CRC(3, 0x3, 0x0, false, 0x7))
	}
	static get crc4itu() {
		return (CRC.#crc4itu ??= new CRC(4, 0x3, 0x0, true, 0x0))
	}
	static get crc4interlaken() {
		return (CRC.#crc4interlaken ??= new CRC(4, 0x3, 0xf, false, 0xf))
	}
	static get crc5epc() {
		return (CRC.#crc5epc ??= new CRC(5, 0x09, 0x09, false, 0x00))
	}
	static get crc5itu() {
		return (CRC.#crc5itu ??= new CRC(5, 0x15, 0x00, true, 0x00))
	}
	static get crc5usb() {
		return (CRC.#crc5usb ??= new CRC(5, 0x05, 0x1f, true, 0x1f))
	}
	static get crc6cdma2000a() {
		return (CRC.#crc6cdma2000a ??= new CRC(6, 0x27, 0x3f, false, 0x00))
	}
	static get crc6cdma2000b() {
		return (CRC.#crc6cdma2000b ??= new CRC(6, 0x07, 0x3f, false, 0x00))
	}
	static get crc6darc() {
		return (CRC.#crc6darc ??= new CRC(6, 0x19, 0x00, true, 0x00))
	}
	static get crc6gsm() {
		return (CRC.#crc6gsm ??= new CRC(6, 0x2f, 0x00, false, 0x3f))
	}
	static get crc6itu() {
		return (CRC.#crc6itu ??= new CRC(6, 0x03, 0x00, true, 0x00))
	}
	static get crc7() {
		return (CRC.#crc7 ??= new CRC(7, 0x09, 0x00, false, 0x00))
	}
	static get crc7umts() {
		return (CRC.#crc7umts ??= new CRC(7, 0x45, 0x00, false, 0x00))
	}
	static get crc8() {
		return (CRC.#crc8 ??= new CRC(8, 0x07, 0x00, false, 0x00))
	}
	static get crc8cdma2000() {
		return (CRC.#crc8cdma2000 ??= new CRC(8, 0x9b, 0xff, false, 0x00))
	}
	static get crc8darc() {
		return (CRC.#crc8darc ??= new CRC(8, 0x39, 0x00, true, 0x00))
	}
	static get crc8dvbs2() {
		return (CRC.#crc8dvbs2 ??= new CRC(8, 0xd5, 0x00, false, 0x00))
	}
	static get crc8ebu() {
		return (CRC.#crc8ebu ??= new CRC(8, 0x1d, 0xff, true, 0x00))
	}
	static get crc8icode() {
		return (CRC.#crc8icode ??= new CRC(8, 0x1d, 0xfd, false, 0x00))
	}
	static get crc8itu() {
		return (CRC.#crc8itu ??= new CRC(8, 0x07, 0x00, false, 0x55))
	}
	static get crc8maxim() {
		return (CRC.#crc8maxim ??= new CRC(8, 0x31, 0x00, true, 0x00))
	}
	static get crc8rohc() {
		return (CRC.#crc8rohc ??= new CRC(8, 0x07, 0xff, true, 0x00))
	}
	static get crc8wcdma() {
		return (CRC.#crc8wcdma ??= new CRC(8, 0x9b, 0x00, true, 0x00))
	}
	static get crc10() {
		return (CRC.#crc10 ??= new CRC(10, 0x233, 0x000, false, 0x000))
	}
	static get crc10cdma2000() {
		return (CRC.#crc10cdma2000 ??= new CRC(10, 0x3d9, 0x3ff, false, 0x000))
	}
	static get crc10gsm() {
		return (CRC.#crc10gsm ??= new CRC(10, 0x175, 0x000, false, 0x3ff))
	}
	static get crc11() {
		return (CRC.#crc11 ??= new CRC(11, 0x385, 0x01a, false, 0x000))
	}
	static get crc12() {
		return (CRC.#crc12 ??= new CRC(12, 0x80f, 0x000, false, 0x000))
	}
	static get crc12cdma2000() {
		return (CRC.#crc12cdma2000 ??= new CRC(12, 0xf13, 0xfff, false, 0x000))
	}
	static get crc12gsm() {
		return (CRC.#crc12gsm ??= new CRC(12, 0xd31, 0x000, false, 0xfff))
	}
	static get crc13bbc() {
		return (CRC.#crc13bbc ??= new CRC(13, 0x1cf5, 0x0000, false, 0x0000))
	}
	static get crc14darc() {
		return (CRC.#crc14darc ??= new CRC(14, 0x0805, 0x0000, true, 0x0000))
	}
	static get crc14gsm() {
		return (CRC.#crc14gsm ??= new CRC(14, 0x202d, 0x0000, false, 0x3fff))
	}
	static get crc15can() {
		return (CRC.#crc15can ??= new CRC(15, 0x4599, 0x0000, false, 0x0000))
	}
	static get crc15mpt1327() {
		return (CRC.#crc15mpt1327 ??= new CRC(15, 0x6815, 0x0000, false, 0x0001))
	}
	static get crc16() {
		return (CRC.#crc16 ??= new CRC(16, 0x8005, 0x0000, true, 0x0000))
	}
	static get crc16ccittfalse() {
		return (CRC.#crc16ccittfalse ??= new CRC(16, 0x1021, 0xffff, false, 0x0000))
	}
	static get crc16augccitt() {
		return (CRC.#crc16augccitt ??= new CRC(16, 0x1021, 0x1d0f, false, 0x0000))
	}
	static get crc16buypass() {
		return (CRC.#crc16buypass ??= new CRC(16, 0x8005, 0x0000, false, 0x0000))
	}
	static get crc16cdma2000() {
		return (CRC.#crc16cdma2000 ??= new CRC(16, 0xc867, 0xffff, false, 0x0000))
	}
	static get crc16dds110() {
		return (CRC.#crc16dds110 ??= new CRC(16, 0x8005, 0x800d, false, 0x0000))
	}
	static get crc16dectr() {
		return (CRC.#crc16dectr ??= new CRC(16, 0x0589, 0x0000, false, 0x0001))
	}
	static get crc16dectx() {
		return (CRC.#crc16dectx ??= new CRC(16, 0x0589, 0x0000, false, 0x0000))
	}
	static get crc16dnp() {
		return (CRC.#crc16dnp ??= new CRC(16, 0x3d65, 0x0000, true, 0xffff))
	}
	static get crc16en13757() {
		return (CRC.#crc16en13757 ??= new CRC(16, 0x3d65, 0x0000, false, 0xffff))
	}
	static get crc16genibus() {
		return (CRC.#crc16genibus ??= new CRC(16, 0x1021, 0xffff, false, 0xffff))
	}
	static get crc16maxim() {
		return (CRC.#crc16maxim ??= new CRC(16, 0x8005, 0x0000, true, 0xffff))
	}
	static get crc16mcrf4cc() {
		return (CRC.#crc16mcrf4cc ??= new CRC(16, 0x1021, 0xffff, true, 0x0000))
	}
	static get crc16riello() {
		return (CRC.#crc16riello ??= new CRC(16, 0x1021, 0xb2aa, true, 0x0000))
	}
	static get crc16t10dif() {
		return (CRC.#crc16t10dif ??= new CRC(16, 0x8bb7, 0x0000, false, 0x0000))
	}
	static get crc16teledisk() {
		return (CRC.#crc16teledisk ??= new CRC(16, 0xa097, 0x0000, false, 0x0000))
	}
	static get crc16tms13157() {
		return (CRC.#crc16tms13157 ??= new CRC(16, 0x1021, 0x89ec, true, 0x0000))
	}
	static get crc16usb() {
		return (CRC.#crc16usb ??= new CRC(16, 0x8005, 0xffff, true, 0xffff))
	}
	static get crca() {
		return (CRC.#crca ??= new CRC(16, 0x1021, 0xc6c6, true, 0x0000))
	}
	static get crc16kermit() {
		return (CRC.#crc16kermit ??= new CRC(16, 0x1021, 0x0000, true, 0x0000))
	}
	static get crc16modbus() {
		return (CRC.#crc16modbus ??= new CRC(16, 0x8005, 0xffff, true, 0x0000))
	}
	static get crc16x25() {
		return (CRC.#crc16x25 ??= new CRC(16, 0x1021, 0xffff, true, 0xffff))
	}
	static get crc16xmodem() {
		return (CRC.#crc16xmodem ??= new CRC(16, 0x1021, 0x0000, false, 0x0000))
	}
	static get crc17can() {
		return (CRC.#crc17can ??= new CRC(17, 0x1685b, 0x00000, false, 0x00000))
	}
	static get crc21can() {
		return (CRC.#crc21can ??= new CRC(21, 0x102899, 0x000000, false, 0x000000))
	}
	static get crc24() {
		return (CRC.#crc24 ??= new CRC(24, 0x864cfb, 0xb704ce, false, 0x000000))
	}
	static get crc24ble() {
		return (CRC.#crc24ble ??= new CRC(24, 0x00065b, 0x555555, true, 0x000000))
	}
	static get crc24flexraya() {
		return (CRC.#crc24flexraya ??= new CRC(24, 0x5d6dcb, 0xfedcba, false, 0x000000))
	}
	static get crc24flexrayb() {
		return (CRC.#crc24flexrayb ??= new CRC(24, 0x5d6dcb, 0xabcdef, false, 0x000000))
	}
	static get crc24ltea() {
		return (CRC.#crc24ltea ??= new CRC(24, 0x864cfb, 0x000000, false, 0x000000))
	}
	static get crc24lteb() {
		return (CRC.#crc24lteb ??= new CRC(24, 0x800063, 0x000000, false, 0x000000))
	}
	static get crc24os9() {
		return (CRC.#crc24os9 ??= new CRC(24, 0x800063, 0xffffff, false, 0xffffff))
	}
	static get crc30cdma() {
		return (CRC.#crc30cdma ??= new CRC(30, 0x2030b9c7, 0x3fffffff, false, 0x3fffffff))
	}
	static get crc32() {
		return (CRC.#crc32 ??= new CRC(32, 0x04c11db7, 0xffffffff, true, 0xffffffff))
	}
	static get crc32mhash() {
		return (CRC.#crc32mhash ??= new CRC(32, 0x04c11db7, 0xffffffff, false, 0xffffffff, true))
	}
	static get crc32bzip2() {
		return (CRC.#crc32bzip2 ??= new CRC(32, 0x04c11db7, 0xffffffff, false, 0xffffffff))
	}
	static get crc32c() {
		return (CRC.#crc32c ??= new CRC(32, 0x1edc6f41, 0xffffffff, true, 0xffffffff))
	}
	static get crc32d() {
		return (CRC.#crc32d ??= new CRC(32, 0xa833982b, 0xffffffff, true, 0xffffffff))
	}
	static get crc32mpeg2() {
		return (CRC.#crc32mpeg2 ??= new CRC(32, 0x04c11db7, 0xffffffff, false, 0x00000000))
	}
	static get crc32posix() {
		return (CRC.#crc32posix ??= new CRC(32, 0x04c11db7, 0x00000000, false, 0xffffffff))
	}
	static get crc32q() {
		return (CRC.#crc32q ??= new CRC(32, 0x814141ab, 0x00000000, false, 0x00000000))
	}
	static get crc32jamcrc() {
		return (CRC.#crc32jamcrc ??= new CRC(32, 0x04c11db7, 0xffffffff, true, 0x00000000))
	}
	static get crc32xfer() {
		return (CRC.#crc32xfer ??= new CRC(32, 0x000000af, 0x00000000, false, 0x00000000))
	}
}

// Builds a stable cache key for a CRC table configuration.
function crcTableKey(poly: number, bit: number, reflect: boolean) {
	return normalizeCrcValue(poly, bit) + (reflect ? 0x1_0000_0000 : 0) + bit * 0x2_0000_0000
}

// Masks a CRC value down to the configured width.
function normalizeCrcValue(value: number, bit: number) {
	return bit === 32 ? value >>> 0 : value & ((1 << bit) - 1)
}

// Reverses the byte order of a CRC value for big-endian numeric consumers.
function reverseCrcBytes(value: number, bit: number) {
	let reversed = 0
	const bytes = Math.ceil(bit / 8)

	for (let i = 0; i < bytes; i++) {
		reversed = ((reversed << 8) | ((value >>> (i * 8)) & 0xff)) >>> 0
	}

	return normalizeCrcValue(reversed, bit)
}

// Applies the final xor and optional output byte reordering.
function finalizeCrc(value: number, bit: number, finalXor: number, reorder: boolean) {
	const checksum = normalizeCrcValue(value ^ finalXor, bit)
	return reorder ? reverseCrcBytes(checksum, bit) : checksum
}

// Applies the final xor and optional output byte reordering.
function definalizeCrc(value: number, bit: number, finalXor: number, reorder: boolean) {
	const checksum = reorder ? reverseCrcBytes(value, bit) : value
	return normalizeCrcValue(checksum ^ finalXor, bit)
}

// Reverses the lowest `bit` bits of a polynomial for reflected CRCs.
function reflectBits(value: number, bit: number) {
	let reflected = 0
	let current = normalizeCrcValue(value, bit)

	for (let i = 0; i < bit; i++) {
		reflected = ((reflected << 1) | (current & 0x01)) >>> 0
		current >>>= 1
	}

	return normalizeCrcValue(reflected, bit)
}

// Updates sub-byte CRCs bit-by-bit because byte lookup tables cannot align widths smaller than 8.
function updateSmallCrc(polynomial: number, bit: number, initial: number, reflect: boolean, data: Uint8Array) {
	const topBit = 1 << (bit - 1)
	let value = initial

	if (reflect) {
		for (let i = 0; i < data.byteLength; i++) {
			let current = data[i]

			for (let j = 0; j < 8; j++) {
				const mix = (value ^ current) & 0x01
				value >>>= 1
				if (mix !== 0) value ^= polynomial
				value = normalizeCrcValue(value, bit)
				current >>>= 1
			}
		}
	} else {
		for (let i = 0; i < data.byteLength; i++) {
			let current = data[i]

			for (let j = 0; j < 8; j++) {
				const mix = (Number((value & topBit) !== 0) ^ Number((current & 0x80) !== 0)) !== 0
				value = normalizeCrcValue(value << 1, bit)
				if (mix) value ^= polynomial
				value = normalizeCrcValue(value, bit)
				current = (current << 1) & 0xff
			}
		}
	}

	return value
}
