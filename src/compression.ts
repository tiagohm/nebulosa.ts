import zlib from 'zlib'
import { signed8, signed16 } from './math'

// The Rice algorithm is simple and very fast. It requires only enough memory to hold a single block of 16 or 32 pixels at a time.
// It codes the pixels in small blocks and so is able to adapt very quickly to changes in the input image statistics.

export type RiceCompressionTypedArray = Int8Array | Uint8Array | Int16Array | Uint16Array | Int32Array | Uint32Array

const NONZERO_COUNT = new Uint8Array(256)

for (let i = 1; i < NONZERO_COUNT.length; i++) {
	NONZERO_COUNT[i] = 32 - Math.clz32(i)
}

const MASKS = new Uint32Array(33)

for (let i = 1; i < MASKS.length; i++) {
	MASKS[i] = i === 32 ? 0xffffffff : (1 << i) - 1
}

const SAMPLE_FORMAT = {
	1: { bytesPerPixel: 1, fsbits: 3, fsmax: 6, bbits: 8, mask: 0xff },
	2: { bytesPerPixel: 2, fsbits: 4, fsmax: 14, bbits: 16, mask: 0xffff },
	4: { bytesPerPixel: 4, fsbits: 5, fsmax: 25, bbits: 32, mask: 0xffffffff },
} as const

class BitWriter {
	private buffer: Uint8Array
	private length = 0
	private bitBuffer = 0
	private bitsToGo = 8

	constructor(initialCapacity: number) {
		this.buffer = new Uint8Array(Math.max(16, initialCapacity))
	}

	private ensure(extra: number) {
		if (this.length + extra <= this.buffer.length) return

		let next = this.buffer.length
		const required = this.length + extra
		while (next < required) next <<= 1

		const grown = new Uint8Array(next)
		grown.set(this.buffer, 0)
		this.buffer = grown
	}

	writeByte(byte: number) {
		this.ensure(1)
		this.buffer[this.length++] = byte & 0xff
	}

	writeBits(bits: number, n: number) {
		let lbitBuffer = this.bitBuffer
		let lbitsToGo = this.bitsToGo
		let remaining = n
		const value = bits >>> 0

		if (lbitsToGo + remaining > 32) {
			lbitBuffer <<= lbitsToGo
			lbitBuffer |= (value >>> (remaining - lbitsToGo)) & MASKS[lbitsToGo]
			this.writeByte(lbitBuffer)
			remaining -= lbitsToGo
			lbitsToGo = 8
		}

		lbitBuffer <<= remaining
		lbitBuffer |= value & MASKS[remaining]
		lbitsToGo -= remaining

		while (lbitsToGo <= 0) {
			this.writeByte((lbitBuffer >>> -lbitsToGo) & 0xff)
			lbitsToGo += 8
		}

		this.bitBuffer = lbitBuffer
		this.bitsToGo = lbitsToGo
	}

	writeRiceBlock(diff: Uint32Array, count: number, fs: number, fsbits: number, fsmax: number, bbits: number) {
		if (fs >= fsmax) {
			this.writeBits(fsmax + 1, fsbits)
			for (let j = 0; j < count; j++) this.writeBits(diff[j], bbits)
			return
		}

		if (fs === 0) {
			this.writeBits(1, fsbits)
			let lbitBuffer = this.bitBuffer
			let lbitsToGo = this.bitsToGo

			for (let j = 0; j < count; j++) {
				const top = diff[j]

				if (lbitsToGo >= top + 1) {
					lbitBuffer <<= top + 1
					lbitBuffer |= 1
					lbitsToGo -= top + 1
				} else {
					lbitBuffer <<= lbitsToGo
					this.writeByte(lbitBuffer)

					let remaining = top - lbitsToGo

					while (remaining >= 8) {
						this.writeByte(0)
						remaining -= 8
					}

					lbitBuffer = 1
					lbitsToGo = 7 - remaining
				}
			}

			this.bitBuffer = lbitBuffer
			this.bitsToGo = lbitsToGo

			return
		}

		this.writeBits(fs + 1, fsbits)

		const fsmask = MASKS[fs]
		let lbitBuffer = this.bitBuffer
		let lbitsToGo = this.bitsToGo

		for (let j = 0; j < count; j++) {
			const value = diff[j]
			let top = value >>> fs

			if (lbitsToGo >= top + 1) {
				lbitBuffer <<= top + 1
				lbitBuffer |= 1
				lbitsToGo -= top + 1
			} else {
				lbitBuffer <<= lbitsToGo
				this.writeByte(lbitBuffer)

				top -= lbitsToGo

				while (top >= 8) {
					this.writeByte(0)
					top -= 8
				}

				lbitBuffer = 1
				lbitsToGo = 7 - top
			}

			lbitBuffer <<= fs
			lbitBuffer |= value & fsmask
			lbitsToGo -= fs

			while (lbitsToGo <= 0) {
				this.writeByte((lbitBuffer >>> -lbitsToGo) & 0xff)
				lbitsToGo += 8
			}
		}

		this.bitBuffer = lbitBuffer
		this.bitsToGo = lbitsToGo
	}

	finalize() {
		if (this.bitsToGo < 8) {
			this.writeByte(this.bitBuffer << this.bitsToGo)
		}

		return this.buffer.slice(0, this.length)
	}
}

function mapDiff(delta: number) {
	return (delta < 0 ? ~(delta << 1) : delta << 1) >>> 0
}

function estimateCapacity(inputLengthBytes: number, bytesPerPixel: number, blockSize: number) {
	const blocks = Math.ceil(inputLengthBytes / bytesPerPixel / blockSize)
	return inputLengthBytes + bytesPerPixel + Math.ceil(inputLengthBytes / 100) + blocks * 2 + 16
}

export function compressRice(input: Readonly<RiceCompressionTypedArray>, blockSize: number = 32, initialCapacity?: number | BitWriter) {
	if (blockSize < 1) throw new Error('block size must be a positive integer')

	const nx = input.length

	if (nx === 0) return new Uint8Array(0)

	const format = SAMPLE_FORMAT[input.BYTES_PER_ELEMENT as keyof typeof SAMPLE_FORMAT]

	if (format === undefined) throw new Error('only 8-bit, 16-bit and 32-bit integer arrays are supported')

	const { bytesPerPixel, fsbits, fsmax, bbits } = format
	const writer = initialCapacity instanceof BitWriter ? initialCapacity : initialCapacity === undefined || initialCapacity <= 0 ? new BitWriter(estimateCapacity(input.byteLength, bytesPerPixel, blockSize)) : new BitWriter(initialCapacity)
	const diff = new Uint32Array(blockSize)

	let firstRaw = 0
	let lastpix = 0

	if (bytesPerPixel === 1) {
		firstRaw = input[0] & 0xff
		lastpix = signed8(input[0])
	} else if (bytesPerPixel === 2) {
		firstRaw = input[0] & 0xffff
		lastpix = signed16(input[0])
	} else {
		firstRaw = input[0] >>> 0
		lastpix = input[0] | 0
	}

	writer.writeBits(firstRaw, bbits)

	for (let i = 0; i < nx; i += blockSize) {
		const thisBlock = Math.min(blockSize, nx - i)
		let pixelSum = 0

		if (bytesPerPixel === 1) {
			for (let j = 0; j < thisBlock; j++) {
				const nextpix = signed8(input[i + j])
				const pdiff = signed8(nextpix - lastpix)
				const mapped = mapDiff(pdiff)
				diff[j] = mapped
				pixelSum += mapped
				lastpix = nextpix
			}
		} else if (bytesPerPixel === 2) {
			for (let j = 0; j < thisBlock; j++) {
				const nextpix = signed16(input[i + j])
				const pdiff = signed16(nextpix - lastpix)
				const mapped = mapDiff(pdiff)
				diff[j] = mapped
				pixelSum += mapped
				lastpix = nextpix
			}
		} else {
			for (let j = 0; j < thisBlock; j++) {
				const nextpix = input[i + j] | 0
				const pdiff = (nextpix - lastpix) | 0
				const mapped = mapDiff(pdiff)
				diff[j] = mapped
				pixelSum += mapped
				lastpix = nextpix
			}
		}

		let dpsum = (pixelSum - thisBlock / 2 - 1) / thisBlock
		if (dpsum < 0) dpsum = 0

		let psum = (dpsum >>> 0) >>> 1
		if (bytesPerPixel === 1) psum &= 0xff
		else if (bytesPerPixel === 2) psum &= 0xffff

		let fs = 0
		for (; psum > 0; fs++) psum >>>= 1

		if (fs === 0 && pixelSum === 0) {
			writer.writeBits(0, fsbits)
			continue
		}

		writer.writeRiceBlock(diff, thisBlock, fs, fsbits, fsmax, bbits)
	}

	return writer.finalize()
}

function checkBufferBounds(offset: number, limit: number) {
	if (offset >= limit) throw new Error('hit end of compressed byte stream')
}

export function decompressRice<T extends RiceCompressionTypedArray>(compressed: Uint8Array, output: T, blockSize: number = 32) {
	if (blockSize < 1) throw new Error('block size must be a positive integer')

	const nx = output.length

	if (nx === 0) return output

	const format = SAMPLE_FORMAT[output.BYTES_PER_ELEMENT as keyof typeof SAMPLE_FORMAT]

	if (format === undefined) throw new Error('only 8-bit, 16-bit and 32-bit integer arrays are supported')

	const { bytesPerPixel, fsbits, fsmax, bbits, mask } = format

	if (compressed.length < bytesPerPixel + 1) throw new Error('input buffer not properly allocated')

	let offset = 0
	let lastpix = 0

	for (let i = 0; i < bytesPerPixel; i++) {
		lastpix = (lastpix << 8) | compressed[offset++]
	}

	lastpix >>>= 0

	const clen = compressed.length
	let b = compressed[offset++]
	let nbits = 8

	for (let i = 0; i < nx; ) {
		nbits -= fsbits

		while (nbits < 0) {
			checkBufferBounds(offset, clen)
			b = ((b << 8) | compressed[offset++]) >>> 0
			nbits += 8
		}

		const fs = (b >>> nbits) - 1
		b &= MASKS[nbits]

		const imax = Math.min(i + blockSize, nx)

		if (fs < 0) {
			for (; i < imax; i++) {
				output[i] = lastpix
			}

			continue
		}

		if (fs === fsmax) {
			for (; i < imax; i++) {
				let k = bbits - nbits
				let diff = (b << k) >>> 0

				for (k -= 8; k >= 0; k -= 8) {
					checkBufferBounds(offset, clen)
					b = compressed[offset++]
					diff |= (b << k) >>> 0
				}

				if (nbits > 0) {
					checkBufferBounds(offset, clen)
					b = compressed[offset++]
					diff |= b >>> -k
					b &= MASKS[nbits]
				} else {
					b = 0
				}

				const delta = (diff & 1) === 0 ? diff >>> 1 : ~(diff >>> 1)
				lastpix = bytesPerPixel === 4 ? (lastpix + delta) >>> 0 : (lastpix + delta) & mask
				output[i] = lastpix
			}

			continue
		}

		for (; i < imax; i++) {
			while (b === 0) {
				nbits += 8
				checkBufferBounds(offset, clen)
				b = compressed[offset++]
			}

			const nzero = nbits - NONZERO_COUNT[b]
			nbits -= nzero + 1
			b ^= 1 << nbits

			nbits -= fs

			while (nbits < 0) {
				checkBufferBounds(offset, clen)
				b = ((b << 8) | compressed[offset++]) >>> 0
				nbits += 8
			}

			const diff = ((nzero << fs) | (b >>> nbits)) >>> 0
			b &= MASKS[nbits]

			const delta = (diff & 1) === 0 ? diff >>> 1 : ~(diff >>> 1)
			lastpix = bytesPerPixel === 4 ? (lastpix + delta) >>> 0 : (lastpix + delta) & mask
			output[i] = lastpix
		}
	}

	return output
}

export function inflate(input: zlib.InputType) {
	const { promise, resolve, reject } = Promise.withResolvers<Buffer>()

	zlib.inflate(input, (error, buffer) => {
		if (error) reject(error)
		else resolve(buffer)
	})

	return promise
}

export function deflate(input: zlib.InputType, options: Pick<zlib.ZlibOptions, 'level'>) {
	const { promise, resolve, reject } = Promise.withResolvers<Buffer>()

	zlib.deflate(input, options, (error, buffer) => {
		if (error) reject(error)
		else resolve(buffer)
	})

	return promise
}
