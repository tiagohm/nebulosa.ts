import { dlopen, type Pointer, ptr } from 'bun:ffi'
import path from '../native/libturbojpeg.shared' with { type: 'file' }

export type LibTurboJPEG = ReturnType<typeof open>

export type PixelFormat =
	| 'RGB' // The red, green, and blue components in the image are stored in 3-sample pixels in the order R, G, B from lowest to highest memory address within each pixel.
	| 'BGR' // The red, green, and blue components in the image are stored in 3-sample pixels in the order B, G, R from lowest to highest memory address within each pixel.
	| 'RGBX' // The red, green, and blue components in the image are stored in 4-sample pixels in the order R, G, B from lowest to highest memory address within each pixel. The X component is ignored when compressing/encoding and undefined when decompressing/decoding.
	| 'BGRX' // The red, green, and blue components in the image are stored in 4-sample pixels in the order B, G, R from lowest to highest memory address within each pixel. The X component is ignored when compressing/encoding and undefined when decompressing/decoding.
	| 'XBGR' // The red, green, and blue components in the image are stored in 4-sample pixels in the order R, G, B from highest to lowest memory address within each pixel. The X component is ignored when compressing/encoding and undefined when decompressing/decoding.
	| 'XRGB' // The red, green, and blue components in the image are stored in 4-sample pixels in the order B, G, R from highest to lowest memory address within each pixel. The X component is ignored when compressing/encoding and undefined when decompressing/decoding.
	| 'GRAY' // Each 1-sample pixel represents a luminance (brightness) level from 0 to the maximum sample value (which is, for instance, 255 for 8-bit samples or 4095 for 12-bit samples or 65535 for 16-bit samples.)
	| 'RGBA' // This is the same as @ref RGBX, except that when decompressing/decoding, the X component is guaranteed to be equal to the maximum sample value, which can be interpreted as an opaque alpha channel.
	| 'BGRA' // This is the same as @ref BGRX, except that when decompressing/decoding, the X component is guaranteed to be equal to the maximum sample value, which can be interpreted as an opaque alpha channel.
	| 'ABGR' // This is the same as @ref XBGR, except that when decompressing/decoding, the X component is guaranteed to be equal to the maximum sample value, which can be interpreted as an opaque alpha channel.
	| 'ARGB' // This is the same as @ref XRGB, except that when decompressing/decoding, the X component is guaranteed to be equal to the maximum sample value, which can be interpreted as an opaque alpha channel.
	| 'CMYK' // CMYK pixel format

export type ChrominanceSubsampling =
	| '4:4:4' // The JPEG or YUV image will contain one chrominance component for every pixel in the source image.
	| '4:2:2' // The JPEG or YUV image will contain one chrominance component for every 2x1 block of pixels in the source image.
	| '4:2:0' // The JPEG or YUV image will contain one chrominance component for every 2x2 block of pixels in the source image.
	| 'GRAY' // The JPEG or YUV image will contain no chrominance components.
	| '4:4:0' // The JPEG or YUV image will contain one chrominance component for every 1x2 block of pixels in the source image.
	| '4:1:1' // The JPEG or YUV image will contain one chrominance component for every 4x1 block of pixels in the source image.
	| '4:4:1' // The JPEG or YUV image will contain one chrominance component for every 1x4 block of pixels in the source image.

export type Colorspace = 'GRAY' | 'YCbCr' | 'RGB' | 'CMYK' | 'YCCK'

export interface DecodedJpeg {
	readonly data: Buffer
	readonly width: number
	readonly height: number
	readonly format: PixelFormat
}

export interface JpegHeader {
	readonly width: number
	readonly height: number
	readonly subsampling: ChrominanceSubsampling
	readonly colorspace: Colorspace
}

const PIXEL_FORMAT_MAP: Record<PixelFormat, readonly [number, number]> = {
	RGB: [0, 3],
	BGR: [1, 3],
	RGBX: [2, 4],
	BGRX: [3, 4],
	XBGR: [4, 4],
	XRGB: [5, 4],
	GRAY: [6, 1],
	RGBA: [7, 4],
	BGRA: [8, 4],
	ABGR: [9, 4],
	ARGB: [10, 4],
	CMYK: [11, 4],
}

const CHROMINANCE_SUBSAMPLING_MAP: Record<ChrominanceSubsampling, number> = {
	'4:4:4': 0,
	'4:2:2': 1,
	'4:2:0': 2,
	GRAY: 3,
	'4:4:0': 4,
	'4:1:1': 5,
	'4:4:1': 6,
}

const CHROMINANCE_SUBSAMPLING_ID_MAP: Record<number, ChrominanceSubsampling> = {
	0: '4:4:4',
	1: '4:2:2',
	2: '4:2:0',
	3: 'GRAY',
	4: '4:4:0',
	5: '4:1:1',
	6: '4:4:1',
}

const COLOR_SPACE_MAP: Record<number, Colorspace> = {
	0: 'RGB',
	1: 'YCbCr',
	2: 'GRAY',
	3: 'CMYK',
	4: 'YCCK',
}

export function open() {
	return dlopen(path, {
		tjInitCompress: { returns: 'ptr' },
		tjInitDecompress: { returns: 'ptr' },
		// void* handle, ubyte* srcBuf, int width, int pitch, int height, int pixelFormat, ubyte** jpegBuf, ulong* jpegSize, int jpegSubsamp, int jpegQual, int flags
		tjCompress2: { args: ['usize', 'buffer', 'int', 'int', 'int', 'int', 'ptr', 'ptr', 'int', 'int', 'int'], returns: 'int' },
		// void* handle, ubyte* jpegBuf, ulong jpegSize, int* width, int* height, int* jpegSubsamp, int* jpegColorspace
		tjDecompressHeader3: { args: ['usize', 'buffer', 'usize', 'ptr', 'ptr', 'ptr', 'ptr'], returns: 'int' },
		// void* handle, ubyte* jpegBuf, ulong jpegSize, ubyte* dstBuf, int width, int pitch, int height, int pixelFormat, int flags
		tjDecompress2: { args: ['usize', 'buffer', 'usize', 'buffer', 'int', 'int', 'int', 'int', 'int'], returns: 'int' },
		tjBufSize: { args: ['int', 'int', 'int'], returns: 'int' },
		tjGetErrorStr: { returns: 'cstring' },
		tjDestroy: { args: ['usize'], returns: 'int' },
	})
}

let libjpeg: LibTurboJPEG | undefined

export function load() {
	return (libjpeg ??= open()).symbols
}

export function unload() {
	libjpeg?.close()
	libjpeg = undefined
}

// Flags
// const BOTTOMUP = 2
// const FORCEMMX = 8
// const FORCESSE = 16
// const FORCESSE2 = 32
// const FORCESSE3 = 128
// const FASTUPSAMPLE = 256
const NOREALLOC = 1024
const FASTDCT = 2048
// const ACCURATEDCT = 4096
// const STOPONWARNING = 8192
// const PROGRESSIVE = 16384
// const LIMITSCANS = 32768

export function isJpeg(input: ArrayBufferLike | Buffer) {
	if (input.byteLength < 2) return false
	const bytes = Buffer.isBuffer(input) ? input : new Uint8Array(input, 0, 2)
	return bytes[0] === 0xff && bytes[1] === 0xd8
}

export class Jpeg {
	readonly #lib = load()

	estimateBufferSize(width: number, height: number, chrominanceSubsampling: ChrominanceSubsampling) {
		return this.#lib.tjBufSize(width, height, CHROMINANCE_SUBSAMPLING_MAP[chrominanceSubsampling])
	}

	readHeader(jpeg: NodeJS.TypedArray | DataView): JpegHeader | undefined {
		const pointer = this.#lib.tjInitDecompress()

		if (!pointer) throw new Error('failed to initialize JPEG decompressor')

		try {
			return this.#readHeader(pointer, jpeg)
		} finally {
			this.#lib.tjDestroy(pointer)
		}
	}

	compress(data: NodeJS.TypedArray | DataView, width: number, height: number, format: PixelFormat, quality: number, chrominanceSubsampling: ChrominanceSubsampling = '4:4:4', jpeg?: Buffer) {
		const pointer = this.#lib.tjInitCompress()

		if (!pointer) {
			throw new Error('failed to initialize JPEG compressor')
		}

		const isGray = format === 'GRAY'
		const pitch = width * PIXEL_FORMAT_MAP[format][1]
		let flag = FASTDCT

		if (jpeg === undefined) {
			jpeg = Buffer.allocUnsafe(this.estimateBufferSize(width, height, chrominanceSubsampling))
			flag |= NOREALLOC
		}

		const p = new BigInt64Array(2)
		p[0] = BigInt(ptr(jpeg)) // ubyte** jpegBuf
		p[1] = BigInt(jpeg.byteLength) // ulong* jpegSize

		try {
			const result = this.#lib.tjCompress2(pointer, data, width, pitch, height, PIXEL_FORMAT_MAP[format][0], ptr(p, 0), ptr(p, 8), isGray ? 3 : CHROMINANCE_SUBSAMPLING_MAP[chrominanceSubsampling], quality, flag)

			if (result === 0) {
				// without NOREALLOC flag
				// const p = Number(output.readBigUInt64LE(0))
				// const size = output.readUInt32LE(8) // 32-bit should be enough for JPEG size
				// return new Uint8Array(toArrayBuffer(p as never, 0, size), 0, size)
				return jpeg.subarray(0, Number(p[1]))
			} else {
				console.error('JPEG compression failed:', this.#lib.tjGetErrorStr().toString())
			}
		} finally {
			this.#lib.tjDestroy(pointer)
		}

		return undefined
	}

	decompress(jpeg: NodeJS.TypedArray | DataView, format?: PixelFormat): DecodedJpeg | undefined {
		const pointer = this.#lib.tjInitDecompress()

		if (!pointer) throw new Error('failed to initialize JPEG decompressor')

		try {
			const header = this.#readHeader(pointer, jpeg)

			if (!header) return undefined

			const { width, height, colorspace } = header
			format ??= colorspace === 'GRAY' ? 'GRAY' : colorspace === 'CMYK' ? 'CMYK' : 'RGB'
			const pitch = width * PIXEL_FORMAT_MAP[format][1]
			const data = Buffer.allocUnsafe(pitch * height)
			const decompressed = this.#lib.tjDecompress2(pointer, jpeg, jpeg.byteLength, data, width, pitch, height, PIXEL_FORMAT_MAP[format][0], FASTDCT)

			if (decompressed === 0) {
				return { data, width, height, format }
			} else {
				console.error('JPEG decompression failed:', this.#lib.tjGetErrorStr().toString())
			}
		} finally {
			this.#lib.tjDestroy(pointer)
		}

		return undefined
	}

	#readHeader(pointer: Pointer, jpeg: NodeJS.TypedArray | DataView): JpegHeader | undefined {
		const header = Buffer.allocUnsafe(16)
		const result = this.#lib.tjDecompressHeader3(pointer, jpeg, jpeg.byteLength, ptr(header, 0), ptr(header, 4), ptr(header, 8), ptr(header, 12))

		if (result !== 0) {
			console.error('JPEG header decompression failed:', this.#lib.tjGetErrorStr().toString())
			return undefined
		}

		const subsampling = CHROMINANCE_SUBSAMPLING_ID_MAP[header.readInt32LE(8)]
		const colorspace = COLOR_SPACE_MAP[header.readInt32LE(12)]

		if (!subsampling || !colorspace) return undefined

		return { width: header.readInt32LE(0), height: header.readInt32LE(4), subsampling, colorspace }
	}
}
