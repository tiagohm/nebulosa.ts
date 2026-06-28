import { dlopen, type Pointer, ptr } from 'bun:ffi'
import path from '../../../native/libturbojpeg.shared' with { type: 'file' }

// FFI binding to the TurboJPEG (libjpeg-turbo) shared library via bun:ffi. Wraps JPEG header parsing,
// compression, and decompression, translating between the C enum integers and the string unions used
// across the codebase. The native handle is opened lazily once and cached; callers use the Jpeg class.

// Resolved type of the dlopen handle returned by open(); used to type the cached library instance.
export type LibTurboJPEG = ReturnType<typeof open>

// In-memory pixel layout of an uncompressed image, as accepted/produced by TurboJPEG.
export type PixelFormat =
	| 'RGB' // The red, green, and blue components in the image are stored in 3-sample pixels in the order R, G, B from lowest to highest memory address within each pixel.
	| 'BGR' // The red, green, and blue components in the image are stored in 3-sample pixels in the order B, G, R from lowest to highest memory address within each pixel.
	| 'RGBX' // The red, green, and blue components in the image are stored in 4-sample pixels in the order R, G, B from lowest to highest memory address within each pixel. The X component is ignored when compressing/encoding and undefined when decompressing/decoding.
	| 'BGRX' // The red, green, and blue components in the image are stored in 4-sample pixels in the order B, G, R from lowest to highest memory address within each pixel. The X component is ignored when compressing/encoding and undefined when decompressing/decoding.
	| 'XBGR' // The red, green, and blue components in the image are stored in 4-sample pixels in the order B, G, R from highest to lowest memory address within each pixel. The X component is ignored when compressing/encoding and undefined when decompressing/decoding.
	| 'XRGB' // The red, green, and blue components in the image are stored in 4-sample pixels in the order R, G, B from highest to lowest memory address within each pixel. The X component is ignored when compressing/encoding and undefined when decompressing/decoding.
	| 'GRAY' // Each 1-sample pixel represents a luminance (brightness) level from 0 to the maximum sample value (which is, for instance, 255 for 8-bit samples or 4095 for 12-bit samples or 65535 for 16-bit samples.)
	| 'RGBA' // This is the same as @ref RGBX, except that when decompressing/decoding, the X component is guaranteed to be equal to the maximum sample value, which can be interpreted as an opaque alpha channel.
	| 'BGRA' // This is the same as @ref BGRX, except that when decompressing/decoding, the X component is guaranteed to be equal to the maximum sample value, which can be interpreted as an opaque alpha channel.
	| 'ABGR' // This is the same as @ref XBGR, except that when decompressing/decoding, the X component is guaranteed to be equal to the maximum sample value, which can be interpreted as an opaque alpha channel.
	| 'ARGB' // This is the same as @ref XRGB, except that when decompressing/decoding, the X component is guaranteed to be equal to the maximum sample value, which can be interpreted as an opaque alpha channel.
	| 'CMYK' // CMYK pixel format

// Chrominance subsampling ratio used by the JPEG encoder: how many chrominance samples are kept per
// block of luminance samples. Lower ratios reduce file size at the cost of color resolution.
export type ChrominanceSubsampling =
	| '4:4:4' // The JPEG or YUV image will contain one chrominance component for every pixel in the source image.
	| '4:2:2' // The JPEG or YUV image will contain one chrominance component for every 2x1 block of pixels in the source image.
	| '4:2:0' // The JPEG or YUV image will contain one chrominance component for every 2x2 block of pixels in the source image.
	| 'GRAY' // The JPEG or YUV image will contain no chrominance components.
	| '4:4:0' // The JPEG or YUV image will contain one chrominance component for every 1x2 block of pixels in the source image.
	| '4:1:1' // The JPEG or YUV image will contain one chrominance component for every 4x1 block of pixels in the source image.
	| '4:4:1' // The JPEG or YUV image will contain one chrominance component for every 1x4 block of pixels in the source image.

// Internal JPEG colorspace as reported by the decoder header.
export type Colorspace = 'GRAY' | 'YCbCr' | 'RGB' | 'CMYK' | 'YCCK'

// Result of a successful decompression: the raw pixel buffer plus its dimensions and layout.
export interface DecodedJpeg {
	// Tightly packed pixel data, row pitch = width * samples-per-pixel of `format`.
	readonly data: Buffer
	// Image width, pixels.
	readonly width: number
	// Image height, pixels.
	readonly height: number
	// Pixel layout of `data`.
	readonly format: PixelFormat
}

// Metadata parsed from a JPEG stream header without decoding the pixels.
export interface JpegHeader {
	// Image width, pixels.
	readonly width: number
	// Image height, pixels.
	readonly height: number
	// Chrominance subsampling used by the stream.
	readonly subsampling: ChrominanceSubsampling
	// Internal colorspace of the stream.
	readonly colorspace: Colorspace
}

// Maps each pixel format to its [TJPF enum value, samples-per-pixel] pair used by the native calls.
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

// Maps a subsampling label to its TJSAMP enum value (for compression and buffer-size estimation).
const CHROMINANCE_SUBSAMPLING_MAP: Record<ChrominanceSubsampling, number> = {
	'4:4:4': 0,
	'4:2:2': 1,
	'4:2:0': 2,
	GRAY: 3,
	'4:4:0': 4,
	'4:1:1': 5,
	'4:4:1': 6,
}

// Inverse of CHROMINANCE_SUBSAMPLING_MAP: maps a TJSAMP enum value back to its label (header parsing).
const CHROMINANCE_SUBSAMPLING_ID_MAP: Record<number, ChrominanceSubsampling> = {
	0: '4:4:4',
	1: '4:2:2',
	2: '4:2:0',
	3: 'GRAY',
	4: '4:4:0',
	5: '4:1:1',
	6: '4:4:1',
}

// Maps a TJCS enum value from the decoder header back to its colorspace label.
const COLOR_SPACE_MAP: Record<number, Colorspace> = {
	0: 'RGB',
	1: 'YCbCr',
	2: 'GRAY',
	3: 'CMYK',
	4: 'YCCK',
}

// Opens the TurboJPEG shared library and declares the subset of the C API used here. The arg comments
// mirror the native signatures. Returns a fresh dlopen handle each call; prefer load() for the cached one.
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

// Process-wide cached library handle, opened on first load() and cleared by unload().
let libjpeg: LibTurboJPEG | undefined

// Returns the cached native symbol table, opening the library on first use.
export function load() {
	return (libjpeg ??= open()).symbols
}

// Closes and clears the cached library handle. Safe to call when nothing is loaded.
export function unload() {
	libjpeg?.close()
	libjpeg = undefined
}

// TurboJPEG flag bits (TJFLAG_*). Only the two used below are active; the rest are kept for reference.
// NOREALLOC: forbid the library from reallocating the destination JPEG buffer.
// FASTDCT: use the faster, slightly less accurate DCT/IDCT algorithm.
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

// Returns true if the buffer starts with the JPEG SOI marker (0xFFD8). Reads at most the first 2 bytes.
export function isJpeg(input: ArrayBufferLike | Buffer) {
	if (input.byteLength < 2) return false
	const bytes = Buffer.isBuffer(input) ? input : new Uint8Array(input, 0, 2)
	return bytes[0] === 0xff && bytes[1] === 0xd8
}

// Stateless wrapper over the TurboJPEG API. Each method allocates and destroys its own native
// compressor/decompressor handle, so instances are cheap and safe to reuse or discard.
export class Jpeg {
	readonly #lib = load()

	// Worst-case JPEG size, bytes, for an image of the given dimensions and subsampling. Used to
	// preallocate the destination buffer for compress().
	estimateBufferSize(width: number, height: number, chrominanceSubsampling: ChrominanceSubsampling) {
		return this.#lib.tjBufSize(width, height, CHROMINANCE_SUBSAMPLING_MAP[chrominanceSubsampling])
	}

	// Parses the header of a JPEG stream without decoding pixels. Returns undefined if the header is
	// invalid or its enums are unrecognized. Throws if the decompressor cannot be initialized.
	readHeader(jpeg: NodeJS.TypedArray | DataView): JpegHeader | undefined {
		const pointer = this.#lib.tjInitDecompress()

		if (!pointer) throw new Error('failed to initialize JPEG decompressor')

		try {
			return this.#readHeader(pointer, jpeg)
		} finally {
			this.#lib.tjDestroy(pointer)
		}
	}

	// Compresses raw pixels to JPEG. `quality` is 1..100. When `jpeg` is omitted a worst-case buffer is
	// allocated; if supplied it must be large enough (NOREALLOC is forced). GRAY input is encoded with
	// grayscale subsampling regardless of `chrominanceSubsampling`. Returns a subarray view of the
	// destination buffer trimmed to the encoded size, or undefined on failure. Throws if init fails.
	compress(data: NodeJS.TypedArray | DataView, width: number, height: number, format: PixelFormat, quality: number, chrominanceSubsampling: ChrominanceSubsampling = '4:4:4', jpeg?: Buffer) {
		const pointer = this.#lib.tjInitCompress()

		if (!pointer) {
			throw new Error('failed to initialize JPEG compressor')
		}

		const isGray = format === 'GRAY'
		const pitch = width * PIXEL_FORMAT_MAP[format][1]
		// Always disable TurboJPEG (re)allocation: the destination is a JS-owned Buffer (whether
		// caller-supplied or allocated here) that TurboJPEG must never realloc or free. A too-small
		// buffer then fails gracefully (tjCompress2 returns an error) instead of corrupting the heap.
		const flag = FASTDCT | NOREALLOC

		jpeg ??= Buffer.allocUnsafe(this.estimateBufferSize(width, height, chrominanceSubsampling))

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

	// Decodes a JPEG stream to raw pixels. When `format` is omitted it is chosen from the stream
	// colorspace (GRAY/CMYK preserved, everything else to RGB). Returns the decoded pixels and geometry,
	// or undefined if the header or decode fails. Throws if the decompressor cannot be initialized.
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

	// Shared header-parsing core reusing an already-initialized decompressor handle. Packs the four
	// int32 outputs (width, height, subsampling, colorspace) into a 16-byte scratch buffer. The caller
	// owns the handle's lifecycle. Returns undefined on native error or unrecognized enums.
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
