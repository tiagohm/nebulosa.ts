import { Bitpix, type Fits, type FitsData, type FitsHdu, type FitsHeader, bitpixInBytes, computeRemainingBytes } from '../src/fits'

const PIXELS = [
	[1, 0, 0],
	[0, 1, 0],
	[0, 0, 1],
] as const

export const BITPIXES: readonly Bitpix[] = [8, 16, 32, -32, -64]
export const CHANNELS = [1, 3] as const

export function generateFits(width: number, height: number, bitpix: Bitpix, channels: 1 | 3): Fits {
	const header: FitsHeader = {
		SIMPLE: true,
		BITPIX: bitpix,
		NAXIS: 3,
		NAXIS1: width,
		NAXIS2: height,
		NAXIS3: channels,
		IMAGETYP: 'Light Frame',
		RA: '161.0177548315',
		DEC: '-59.6022705034',
		EXPOSURE: 30,
	}

	const pixelSizeInBytes = bitpixInBytes(bitpix)
	const size = width * height * channels * pixelSizeInBytes
	const source = Buffer.allocUnsafe(size + computeRemainingBytes(size))
	const data: FitsData = { source, size }
	const hdu: FitsHdu = { header, data }

	let offset = 0
	const m = channels === 3 ? 3 : 2

	for (let c = 0; c < channels; c++) {
		let p = 0

		for (let y = 0; y < height; y++) {
			for (let x = 0; x < height; x++, offset += pixelSizeInBytes) {
				const pixel = PIXELS[p++ % m][c]

				if (bitpix === Bitpix.BYTE) source.writeUInt8(pixel * 255, offset)
				else if (bitpix === Bitpix.SHORT) source.writeInt16BE(Math.trunc(pixel * 65535) - 32768, offset)
				else if (bitpix === Bitpix.INTEGER) source.writeInt32BE(Math.trunc(pixel * 4294967295) - 2147483648, offset)
				else if (bitpix === Bitpix.FLOAT) source.writeFloatBE(pixel, offset)
				else if (bitpix === Bitpix.DOUBLE) source.writeDoubleBE(pixel, offset)
			}
		}
	}

	return { hdus: [hdu] }
}
