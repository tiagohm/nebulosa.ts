import { dlopen, ptr } from 'bun:ffi'
import path from '../native/libturbojpeg.shared' with { type: 'file' }

export type LibJPEG = ReturnType<typeof open>

export enum PixelFormat {
	RGB, // The red, green, and blue components in the image are stored in 3-sample pixels in the order R, G, B from lowest to highest memory address within each pixel.
	BGR, // The red, green, and blue components in the image are stored in 3-sample pixels in the order B, G, R from lowest to highest memory address within each pixel.
	RGBX, // The red, green, and blue components in the image are stored in 4-sample pixels in the order R, G, B from lowest to highest memory address within each pixel. The X component is ignored when compressing/encoding and undefined when decompressing/decoding.
	BGRX, // The red, green, and blue components in the image are stored in 4-sample pixels in the order B, G, R from lowest to highest memory address within each pixel. The X component is ignored when compressing/encoding and undefined when decompressing/decoding.
	XBGR, // The red, green, and blue components in the image are stored in 4-sample pixels in the order R, G, B from highest to lowest memory address within each pixel. The X component is ignored when compressing/encoding and undefined when decompressing/decoding.
	XRGB, // The red, green, and blue components in the image are stored in 4-sample pixels in the order B, G, R from highest to lowest memory address within each pixel. The X component is ignored when compressing/encoding and undefined when decompressing/decoding.
	GRAY, // Each 1-sample pixel represents a luminance (brightness) level from 0 to the maximum sample value (which is, for instance, 255 for 8-bit samples or 4095 for 12-bit samples or 65535 for 16-bit samples.)
	RGBA, // This is the same as @ref RGBX, except that when decompressing/decoding, the X component is guaranteed to be equal to the maximum sample value, which can be interpreted as an opaque alpha channel.
	BGRA, // This is the same as @ref BGRX, except that when decompressing/decoding, the X component is guaranteed to be equal to the maximum sample value, which can be interpreted as an opaque alpha channel.
	ABGR, // This is the same as @ref XBGR, except that when decompressing/decoding, the X component is guaranteed to be equal to the maximum sample value, which can be interpreted as an opaque alpha channel.
	ARGB, // This is the same as @ref XRGB, except that when decompressing/decoding, the X component is guaranteed to be equal to the maximum sample value, which can be interpreted as an opaque alpha channel.
	CMYK, // CMYK pixel format
}

export enum ChrominanceSubsampling {
	C444, // The JPEG or YUV image will contain one chrominance component for every pixel in the source image.
	C422, // The JPEG or YUV image will contain one chrominance component for every 2x1 block of pixels in the source image.
	C420, // The JPEG or YUV image will contain one chrominance component for every 2x2 block of pixels in the source image.
	GRAY, // The JPEG or YUV image will contain no chrominance components.
	C440, // The JPEG or YUV image will contain one chrominance component for every 1x2 block of pixels in the source image.
	C411, // The JPEG or YUV image will contain one chrominance component for every 4x1 block of pixels in the source image.
	C441, // The JPEG or YUV image will contain one chrominance component for every 1x4 block of pixels in the source image.
}

export function open() {
	return dlopen(path, {
		tjInitCompress: { returns: 'ptr' },
		// void* handle, ubyte* srcBuf, int width, int pitch, int height, int pixelFormat, ubyte** jpegBuf, ulong* jpegSize, int jpegSubsamp, int jpegQual, int flags
		tjCompress2: { args: ['usize', 'buffer', 'int', 'int', 'int', 'int', 'ptr', 'ptr', 'int', 'int', 'int'], returns: 'int' },
		tjBufSize: { args: ['int', 'int', 'int'], returns: 'int' },
		tjGetErrorStr: { returns: 'cstring' },
		tjDestroy: { args: ['usize'], returns: 'int' },
	})
}

let libjpeg: LibJPEG | undefined

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

export class Jpeg {
	private readonly lib = load()

	estimateBufferSize(width: number, height: number, chrominanceSubsampling: ChrominanceSubsampling) {
		return this.lib.tjBufSize(width, height, chrominanceSubsampling)
	}

	compress(data: Buffer, width: number, height: number, format: PixelFormat, quality: number, chrominanceSubsampling: ChrominanceSubsampling = ChrominanceSubsampling.C420, jpeg?: Buffer) {
		const pointer = this.lib.tjInitCompress()

		if (!pointer) {
			throw new Error('failed to initialize JPEG compressor')
		}

		const pitch = format === PixelFormat.GRAY ? width : width * (format === PixelFormat.RGB || format === PixelFormat.BGR ? 3 : 4)
		let flag = FASTDCT

		if (jpeg === undefined) {
			jpeg = Buffer.allocUnsafe(this.estimateBufferSize(width, height, chrominanceSubsampling))
			flag |= NOREALLOC
		}

		const p = new BigInt64Array(2)
		p[0] = BigInt(ptr(jpeg)) // ubyte** jpegBuf
		p[1] = BigInt(jpeg.byteLength) // ulong* jpegSize

		try {
			const result = this.lib.tjCompress2(pointer, data, width, pitch, height, format, ptr(p, 0), ptr(p, 8), format === PixelFormat.GRAY ? ChrominanceSubsampling.GRAY : chrominanceSubsampling, quality, flag)

			if (result === 0) {
				// without NOREALLOC flag
				// const p = Number(output.readBigUInt64LE(0))
				// const size = output.readUInt32LE(8) // 32-bit should be enough for JPEG size
				// return new Uint8Array(toArrayBuffer(p as never, 0, size), 0, size)
				return jpeg.subarray(0, Number(p[1]))
			} else {
				console.error('JPEG compression failed:', this.lib.tjGetErrorStr().toString())
			}
		} finally {
			this.lib.tjDestroy(pointer)
		}

		return undefined
	}
}
