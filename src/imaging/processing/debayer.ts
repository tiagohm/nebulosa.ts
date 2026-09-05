import { makeImageRawTypedArray, type CfaPattern, type Image, type ImageRawType } from '../model/types'

// Bayer/debayer conversions between an RGB image and a mono CFA mosaic. `bayer` samples one color per
// pixel from a CFA pattern; `debayer` reconstructs RGB by neighborhood averaging. Both build fresh
// buffers rather than mutating in place.

// A 2x2 CFA layout and its precomputed interior-pixel normalization scales.
interface CfaPatternData {
	// Even and odd rows containing the channel index at even and odd columns.
	readonly rows: readonly [Uint8Array, Uint8Array]
	// Per-row/per-column-parity reciprocal sample counts for red, green, and blue.
	readonly interiorScales: readonly [readonly [Float64Array, Float64Array], readonly [Float64Array, Float64Array]]
}

// Computes the reciprocal channel sample counts for one interior CFA pixel class.
function makeInteriorScales(rows: readonly [Uint8Array, Uint8Array], yParity: number, xParity: number) {
	const row = rows[yParity]
	const nextRow = rows[yParity ^ 1]
	const nextParity = xParity ^ 1
	const counts = new Uint8Array(3)

	counts[row[xParity]]++
	counts[row[nextParity]] += 2
	counts[nextRow[xParity]] += 2
	counts[nextRow[nextParity]] += 4

	return new Float64Array([1 / counts[0], 1 / counts[1], 1 / counts[2]])
}

// Builds lookup data for one repeating 2x2 CFA pattern.
function makeCfaPatternData(evenRow: readonly [number, number], oddRow: readonly [number, number]): CfaPatternData {
	const rows = [new Uint8Array(evenRow), new Uint8Array(oddRow)] as const

	return {
		rows,
		interiorScales: [
			[makeInteriorScales(rows, 0, 0), makeInteriorScales(rows, 0, 1)],
			[makeInteriorScales(rows, 1, 0), makeInteriorScales(rows, 1, 1)],
		],
	}
}

// Per-Bayer-pattern channel routing and normalization data; channel indices are red 0, green 1, blue 2.
const CFA_PATTERNS: Record<CfaPattern, CfaPatternData> = {
	RGGB: makeCfaPatternData([0, 1], [1, 2]),
	BGGR: makeCfaPatternData([2, 1], [1, 0]),
	GBRG: makeCfaPatternData([1, 2], [0, 1]),
	GRBG: makeCfaPatternData([1, 0], [2, 1]),
	GRGB: makeCfaPatternData([1, 0], [1, 2]),
	GBGR: makeCfaPatternData([1, 2], [1, 0]),
	RGBG: makeCfaPatternData([0, 1], [2, 1]),
	BGRG: makeCfaPatternData([2, 1], [0, 1]),
}

// Bayer an RGB image into a mono CFA frame.
export function bayer(image: Image, pattern: CfaPattern): Image | undefined {
	const { metadata, raw } = image

	if (metadata.channels === 3) {
		const header = { ...image.header }
		const cfa = CFA_PATTERNS[pattern].rows
		const output = raw instanceof Float64Array ? new Float64Array(metadata.pixelCount) : new Float32Array(metadata.pixelCount)
		const { width, height, stride } = metadata
		const pairedWidth = width & ~1

		for (let y = 0; y < height; y++) {
			const cfaRow = cfa[y & 1]
			let ii = y * stride
			let oi = y * width
			const pairEnd = oi + pairedWidth

			while (oi < pairEnd) {
				output[oi++] = raw[ii + cfaRow[0]]
				ii += 3
				output[oi++] = raw[ii + cfaRow[1]]
				ii += 3
			}

			if (pairedWidth !== width) output[oi] = raw[ii + cfaRow[0]]
		}

		delete header.NAXIS3
		header.BAYERPAT = pattern
		header.NAXIS = 2

		return {
			header,
			metadata: { ...metadata, bayer: pattern, channels: 1, stride: width, strideInBytes: width * metadata.pixelSizeInBytes },
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
			const { rows: cfa, interiorScales } = CFA_PATTERNS[pattern]
			const { width, height } = metadata

			if (width < 2 || height < 2) return undefined

			const values = makeImageRawTypedArray(raw, 3)
			const counters = new Uint8Array(3)
			const output = makeImageRawTypedArray(raw, raw.length * 3)
			const widthLast = width - 1
			const heightLast = height - 1

			if (width > 2 && height > 2) {
				for (let x = 0; x < width; x++) {
					debayerPixel(raw, output, width, x, x & 1, cfa[0], cfa[1], x !== 0, x !== widthLast, false, true, values, counters)
				}

				for (let y = 1; y < heightLast; y++) {
					const row = y * width
					const yParity = y & 1
					const cfaRow = cfa[yParity]
					const cfaNextRow = cfa[yParity ^ 1]
					const rowScales = interiorScales[yParity]

					debayerPixel(raw, output, width, row, 0, cfaRow, cfaNextRow, false, true, true, true, values, counters)

					let ci = row + 1
					let oi = ci * 3

					for (let x = 1; x < widthLast; x++, ci++, oi += 3) {
						const xParity = x & 1
						const nextParity = xParity ^ 1
						const centerChannel = cfaRow[xParity]
						const horizontalChannel = cfaRow[nextParity]
						const verticalChannel = cfaNextRow[xParity]
						const diagonalChannel = cfaNextRow[nextParity]
						const scales = rowScales[xParity]

						values[0] = 0
						values[1] = 0
						values[2] = 0

						// Interior pixels have a complete 3x3 neighborhood and precomputed channel sample counts.
						values[centerChannel] += raw[ci]
						values[horizontalChannel] += raw[ci - 1]
						values[horizontalChannel] += raw[ci + 1]
						values[verticalChannel] += raw[ci - width]
						values[diagonalChannel] += raw[ci - width - 1]
						values[diagonalChannel] += raw[ci - width + 1]
						values[verticalChannel] += raw[ci + width]
						values[diagonalChannel] += raw[ci + width - 1]
						values[diagonalChannel] += raw[ci + width + 1]

						output[oi] = values[0] * scales[0]
						output[oi + 1] = values[1] * scales[1]
						output[oi + 2] = values[2] * scales[2]
					}

					debayerPixel(raw, output, width, row + widthLast, widthLast & 1, cfaRow, cfaNextRow, true, false, true, true, values, counters)
				}

				const bottomRow = heightLast * width
				const bottomCfaRow = cfa[heightLast & 1]
				const bottomCfaNextRow = cfa[height & 1]

				for (let x = 0; x < width; x++) {
					debayerPixel(raw, output, width, bottomRow + x, x & 1, bottomCfaRow, bottomCfaNextRow, x !== 0, x !== widthLast, true, false, values, counters)
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
				metadata: { ...metadata, channels: 3, stride: width * 3, strideInBytes: width * 3 * metadata.pixelSizeInBytes },
				raw: output,
			}
		}
	}

	return undefined
}
