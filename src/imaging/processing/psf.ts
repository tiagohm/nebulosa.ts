import type { Image, ImageRawType } from '../model/types'

// KStars internal-guider point-spread-function (PSF) filter for dense mono or interleaved RGB
// intensity images. The normalized 9x9 response is written in place while the four-pixel border
// remains unchanged. Raw CFA mosaics must be converted to a coherent intensity image first.

// https://github.com/KDE/kstars/blob/master/kstars/ekos/guide/internalguide/guidealgorithms.cpp

// Radius, in pixels, of the KStars PSF stencil.
const PSF_RADIUS = 4
// Width and height, in pixels, of the KStars PSF stencil.
const PSF_SIZE = 2 * PSF_RADIUS + 1
// Sum of all original PSF weights over their stencil multiplicities.
const PSF_WEIGHT_SUM = 0.378
// D3 weight after subtracting the local-mean contribution from every stencil sample.
const PSF_OUTER_WEIGHT = -0.094 - PSF_WEIGHT_SUM / (PSF_SIZE * PSF_SIZE)
// B1 weight relative to the D3 outer-ring weight.
const PSF_B1_DELTA = 0.678
// B2 weight relative to the D3 outer-ring weight.
const PSF_B2_DELTA = 0.459
// C1 weight relative to the D3 outer-ring weight.
const PSF_C1_DELTA = 0.211
// C2 weight relative to the D3 outer-ring weight.
const PSF_C2_DELTA = 0.143
// C3 weight relative to the D3 outer-ring weight.
const PSF_C3_DELTA = 0.044
// D1 weight relative to the D3 outer-ring weight.
const PSF_D1_DELTA = 0.03
// D2 weight relative to the D3 outer-ring weight.
const PSF_D2_DELTA = 0.02

// Verifies the dense intensity-image layout required by the PSF stencil before any mutation.
function validatePsfImage(image: Image) {
	const { width, height, channels, stride, pixelCount, bayer } = image.metadata
	if (!Number.isInteger(width) || width <= 0) throw new Error(`image width must be a positive integer: ${width}`)
	if (!Number.isInteger(height) || height <= 0) throw new Error(`image height must be a positive integer: ${height}`)
	if (channels !== 1 && channels !== 3) throw new Error(`image channels must be 1 or 3: ${channels}`)
	const expectedPixelCount = width * height
	if (pixelCount !== expectedPixelCount) throw new Error(`image pixelCount does not match geometry: ${pixelCount} != ${expectedPixelCount}`)
	const expectedStride = width * channels
	if (stride !== expectedStride) throw new Error(`image stride does not match geometry: ${stride} != ${expectedStride}`)
	const expectedLength = pixelCount * channels
	if (image.raw.length !== expectedLength) throw new Error(`image raw length does not match metadata: ${image.raw.length} != ${expectedLength}`)
	if (channels === 1 && bayer) throw new Error('PSF filtering requires a non-CFA intensity image')
}

// Filters one mono row using eight inner ring sums and a sliding sum for the complete 9x9 support.
function filterMonoRow(raw: ImageRawType, width: number, y: number, rows: readonly ImageRawType[], columns: Float64Array) {
	const b1 = rows[1]
	const b2 = rows[2]
	const b3 = rows[3]
	const b4 = rows[4]
	const b5 = rows[5]
	const b6 = rows[6]
	const b7 = rows[7]
	let total = columns[0] + columns[1] + columns[2] + columns[3] + columns[4] + columns[5] + columns[6] + columns[7] + columns[8]
	const row = y * width

	for (let x = PSF_RADIUS; x < width - PSF_RADIUS; x++) {
		if (x > PSF_RADIUS) total += columns[x + PSF_RADIUS] - columns[x - PSF_RADIUS - 1]
		const A = b4[x]
		const B1 = b3[x] + b5[x] + b4[x + 1] + b4[x - 1]
		const B2 = b3[x - 1] + b3[x + 1] + b5[x - 1] + b5[x + 1]
		const C1 = b2[x] + b4[x - 2] + b4[x + 2] + b6[x]
		const C2 = b2[x - 1] + b2[x + 1] + b3[x - 2] + b3[x + 2] + b5[x - 2] + b5[x + 2] + b6[x - 1] + b6[x + 1]
		const C3 = b2[x - 2] + b2[x + 2] + b6[x - 2] + b6[x + 2]
		const D1 = b1[x] + b4[x - 3] + b4[x + 3] + b7[x]
		const D2 = b1[x - 1] + b1[x + 1] + b3[x - 3] + b3[x + 3] + b5[x - 3] + b5[x + 3] + b7[x - 1] + b7[x + 1]

		raw[row + x] = PSF_OUTER_WEIGHT * total + A + PSF_B1_DELTA * B1 + PSF_B2_DELTA * B2 + PSF_C1_DELTA * C1 + PSF_C2_DELTA * C2 + PSF_C3_DELTA * C3 + PSF_D1_DELTA * D1 + PSF_D2_DELTA * D2
	}
}

// Filters one interleaved RGB row independently per channel using the same sliding 9x9 support.
function filterRgbRow(raw: ImageRawType, width: number, stride: number, y: number, rows: readonly ImageRawType[], columns: Float64Array) {
	const b1 = rows[1]
	const b2 = rows[2]
	const b3 = rows[3]
	const b4 = rows[4]
	const b5 = rows[5]
	const b6 = rows[6]
	const b7 = rows[7]
	let totalRed = 0
	let totalGreen = 0
	let totalBlue = 0

	for (let x = 0, i = 0; x < PSF_SIZE; x++, i += 3) {
		totalRed += columns[i]
		totalGreen += columns[i + 1]
		totalBlue += columns[i + 2]
	}

	const row = y * stride
	for (let x = PSF_RADIUS, xi = PSF_RADIUS * 3; x < width - PSF_RADIUS; x++, xi += 3) {
		if (x > PSF_RADIUS) {
			const entering = (x + PSF_RADIUS) * 3
			const leaving = (x - PSF_RADIUS - 1) * 3
			totalRed += columns[entering] - columns[leaving]
			totalGreen += columns[entering + 1] - columns[leaving + 1]
			totalBlue += columns[entering + 2] - columns[leaving + 2]
		}

		for (let channel = 0; channel < 3; channel++) {
			const i = xi + channel
			const A = b4[i]
			const B1 = b3[i] + b5[i] + b4[i + 3] + b4[i - 3]
			const B2 = b3[i - 3] + b3[i + 3] + b5[i - 3] + b5[i + 3]
			const C1 = b2[i] + b4[i - 6] + b4[i + 6] + b6[i]
			const C2 = b2[i - 3] + b2[i + 3] + b3[i - 6] + b3[i + 6] + b5[i - 6] + b5[i + 6] + b6[i - 3] + b6[i + 3]
			const C3 = b2[i - 6] + b2[i + 6] + b6[i - 6] + b6[i + 6]
			const D1 = b1[i] + b4[i - 9] + b4[i + 9] + b7[i]
			const D2 = b1[i - 3] + b1[i + 3] + b3[i - 9] + b3[i + 9] + b5[i - 9] + b5[i + 9] + b7[i - 3] + b7[i + 3]
			const total = channel === 0 ? totalRed : channel === 1 ? totalGreen : totalBlue

			raw[row + i] = PSF_OUTER_WEIGHT * total + A + PSF_B1_DELTA * B1 + PSF_B2_DELTA * B2 + PSF_C1_DELTA * C1 + PSF_C2_DELTA * C2 + PSF_C3_DELTA * C3 + PSF_D1_DELTA * D1 + PSF_D2_DELTA * D2
		}
	}
}

// Applies the KStars internal-guider PSF filter in place and returns the same image object.
export function psf(image: Image) {
	validatePsfImage(image)
	const { raw, metadata } = image
	const { width, height, channels, stride } = metadata
	if (width < PSF_SIZE || height < PSF_SIZE) return image

	const rows = new Array<ImageRawType>(PSF_SIZE)
	const RawArray = raw instanceof Float64Array ? Float64Array : Float32Array
	for (let y = 0; y < PSF_SIZE; y++) {
		const row = new RawArray(stride)
		row.set(raw.subarray(y * stride, (y + 1) * stride))
		rows[y] = row
	}

	// Vertical column sums make the complete 9x9 sum available with two updates per output pixel.
	const columns = new Float64Array(stride)
	for (let i = 0; i < stride; i++) columns[i] = rows[0][i] + rows[1][i] + rows[2][i] + rows[3][i] + rows[4][i] + rows[5][i] + rows[6][i] + rows[7][i] + rows[8][i]

	for (let y = PSF_RADIUS; y < height - PSF_RADIUS; y++) {
		if (channels === 1) filterMonoRow(raw, width, y, rows, columns)
		else filterRgbRow(raw, width, stride, y, rows, columns)

		const nextY = y + PSF_RADIUS + 1
		if (nextY >= height) continue
		const recycled = rows[0]
		const nextRow = nextY * stride
		for (let i = 0; i < stride; i++) {
			const value = raw[nextRow + i]
			columns[i] += value - recycled[i]
			recycled[i] = value
		}
		for (let i = 0; i < PSF_SIZE - 1; i++) rows[i] = rows[i + 1]
		rows[PSF_SIZE - 1] = recycled
	}

	return image
}
