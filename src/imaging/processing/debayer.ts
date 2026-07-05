import type { CfaPattern, Image, ImageRawType } from '../model/types'

// Per-Bayer-pattern 2x2 channel-index maps: two rows of [evenCol, oddCol] color indices
// (0 red, 1 green, 2 blue) used to route each mosaic pixel to its color channel during debayering.
const CFA_PATTERNS: Record<CfaPattern, Uint8Array[]> = {
	RGGB: [new Uint8Array([0, 1]), new Uint8Array([1, 2])],
	BGGR: [new Uint8Array([2, 1]), new Uint8Array([1, 0])],
	GBRG: [new Uint8Array([1, 2]), new Uint8Array([0, 1])],
	GRBG: [new Uint8Array([1, 0]), new Uint8Array([2, 1])],
	GRGB: [new Uint8Array([1, 0]), new Uint8Array([1, 2])],
	GBGR: [new Uint8Array([1, 2]), new Uint8Array([1, 0])],
	RGBG: [new Uint8Array([0, 1]), new Uint8Array([2, 1])],
	BGRG: [new Uint8Array([2, 1]), new Uint8Array([0, 1])],
}

// Bayer an RGB image into a mono CFA frame.
export function bayer(image: Image, pattern: CfaPattern): Image | undefined {
	const { metadata, raw } = image

	if (metadata.channels === 3) {
		const header = structuredClone(image.header)
		const cfa = CFA_PATTERNS[pattern]
		const output = raw instanceof Float64Array ? new Float64Array(metadata.pixelCount) : new Float32Array(metadata.pixelCount)
		const { width, height, stride } = metadata

		for (let y = 0; y < height; y++) {
			const cfaRow = cfa[y & 1]
			let ii = y * stride
			let oi = y * width

			for (let x = 0; x < width; x++, oi++) {
				output[oi] = raw[ii + cfaRow[x & 1]]
				ii += 3
			}
		}

		delete header.NAXIS3
		header.BAYERPAT = pattern
		header.NAXIS = 2

		return {
			header,
			metadata: { ...metadata, bayer: pattern, channels: 1, stride: width },
			raw: output,
		}
	}

	return undefined
}

// Debayer a single CFA pixel while preserving the original accumulation order.
function debayerPixel(raw: ImageRawType, output: ImageRawType, width: number, ci: number, xParity: number, cfaRow: Uint8Array, cfaNextRow: Uint8Array, hasLeft: boolean, hasRight: boolean, hasTop: boolean, hasBottom: boolean, values: ImageRawType, counters: Uint8Array) {
	const nextParity = xParity ^ 1
	const centerChannel = cfaRow[xParity]
	const horizontalChannel = cfaRow[nextParity]
	const verticalChannel = cfaNextRow[xParity]
	const diagonalChannel = cfaNextRow[nextParity]

	values[0] = 0
	values[1] = 0
	values[2] = 0
	counters[0] = 0
	counters[1] = 0
	counters[2] = 0

	values[centerChannel] += raw[ci]
	counters[centerChannel]++

	if (hasLeft) {
		values[horizontalChannel] += raw[ci - 1]
		counters[horizontalChannel]++
	}

	if (hasRight) {
		values[horizontalChannel] += raw[ci + 1]
		counters[horizontalChannel]++
	}

	if (hasTop) {
		values[verticalChannel] += raw[ci - width]
		counters[verticalChannel]++

		if (hasLeft) {
			values[diagonalChannel] += raw[ci - width - 1]
			counters[diagonalChannel]++
		}

		if (hasRight) {
			values[diagonalChannel] += raw[ci - width + 1]
			counters[diagonalChannel]++
		}
	}

	if (hasBottom) {
		values[verticalChannel] += raw[ci + width]
		counters[verticalChannel]++

		if (hasLeft) {
			values[diagonalChannel] += raw[ci + width - 1]
			counters[diagonalChannel]++
		}

		if (hasRight) {
			values[diagonalChannel] += raw[ci + width + 1]
			counters[diagonalChannel]++
		}
	}

	let oi = ci * 3
	output[oi++] = values[0] / counters[0]
	output[oi++] = values[1] / counters[1]
	output[oi] = values[2] / counters[2]
}

// Debayers a mono CFA frame back into RGB using neighborhood averaging.
export function debayer(image: Image, pattern?: CfaPattern): Image | undefined {
	const { metadata, raw } = image

	if (metadata.channels === 1) {
		pattern ??= metadata.bayer

		if (pattern) {
			const cfa = CFA_PATTERNS[pattern]
			const values = raw instanceof Float64Array ? new Float64Array(3) : new Float32Array(3)
			const counters = new Uint8Array(3)
			const output = raw instanceof Float64Array ? new Float64Array(raw.length * 3) : new Float32Array(raw.length * 3)
			const { width, height } = metadata
			const widthLast = width - 1
			const heightLast = height - 1

			if (width > 2 && height > 2) {
				for (let x = 0; x < width; x++) {
					debayerPixel(raw, output, width, x, x & 1, cfa[0], cfa[1], x !== 0, x !== widthLast, false, true, values, counters)
				}

				for (let y = 1; y < heightLast; y++) {
					const row = y * width
					const cfaRow = cfa[y & 1]
					const cfaNextRow = cfa[(y + 1) & 1]

					debayerPixel(raw, output, width, row, 0, cfaRow, cfaNextRow, false, true, true, true, values, counters)

					for (let x = 1; x < widthLast; x++) {
						const ci = row + x
						const xParity = x & 1
						const nextParity = xParity ^ 1
						const centerChannel = cfaRow[xParity]
						const horizontalChannel = cfaRow[nextParity]
						const verticalChannel = cfaNextRow[xParity]
						const diagonalChannel = cfaNextRow[nextParity]

						values[0] = 0
						values[1] = 0
						values[2] = 0
						counters[0] = 0
						counters[1] = 0
						counters[2] = 0

						// Interior pixels have a complete 3x3 neighborhood, so the hot path can stay branch-light.
						values[centerChannel] += raw[ci]
						counters[centerChannel]++
						values[horizontalChannel] += raw[ci - 1]
						counters[horizontalChannel]++
						values[horizontalChannel] += raw[ci + 1]
						counters[horizontalChannel]++
						values[verticalChannel] += raw[ci - width]
						counters[verticalChannel]++
						values[diagonalChannel] += raw[ci - width - 1]
						counters[diagonalChannel]++
						values[diagonalChannel] += raw[ci - width + 1]
						counters[diagonalChannel]++
						values[verticalChannel] += raw[ci + width]
						counters[verticalChannel]++
						values[diagonalChannel] += raw[ci + width - 1]
						counters[diagonalChannel]++
						values[diagonalChannel] += raw[ci + width + 1]
						counters[diagonalChannel]++

						let oi = ci * 3
						output[oi++] = values[0] / counters[0]
						output[oi++] = values[1] / counters[1]
						output[oi] = values[2] / counters[2]
					}

					debayerPixel(raw, output, width, row + widthLast, widthLast & 1, cfaRow, cfaNextRow, true, false, true, true, values, counters)
				}

				const bottomRow = heightLast * width

				for (let x = 0; x < width; x++) {
					debayerPixel(raw, output, width, bottomRow + x, x & 1, cfa[heightLast & 1], cfa[height & 1], x !== 0, x !== widthLast, true, false, values, counters)
				}
			} else {
				for (let y = 0; y < height; y++) {
					const row = y * width
					const cfaRow = cfa[y & 1]
					const cfaNextRow = cfa[(y + 1) & 1]
					const hasTop = y !== 0
					const hasBottom = y !== heightLast

					for (let x = 0; x < width; x++) {
						debayerPixel(raw, output, width, row + x, x & 1, cfaRow, cfaNextRow, x !== 0, x !== widthLast, hasTop, hasBottom, values, counters)
					}
				}
			}

			return {
				header: { ...image.header, NAXIS: 3, NAXIS3: 3 },
				metadata: { ...metadata, channels: 3, stride: width * 3 },
				raw: output,
			}
		}
	}

	return undefined
}
