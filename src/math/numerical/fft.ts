import { TAU } from '../../core/constants'

// In-place radix-2 complex fast Fourier transforms over split real/imaginary Float64Array buffers.
// The forward transform uses exp(-i·2π·k·n/N) without scaling; the inverse uses exp(+i·2π·k·n/N)
// and scales by 1/N so a forward/inverse round trip restores the input. 2D transforms are row-major
// and separable (rows first, then columns through caller-owned column scratch). Plans and workspaces
// are allocated once and reused; transforms allocate nothing.

// Precomputed radix-2 FFT plan for one power-of-two transform length.
export interface FFTPlan {
	// Transform length; must be a power of two (one is allowed and is the identity transform).
	readonly size: number
	// Bit-reversal permutation table of length size.
	readonly bitReversed: Uint32Array
	// Real parts of exp(-i·2π·k/size) for k in [0, size/2).
	readonly twiddleReal: Float64Array
	// Imaginary parts of exp(-i·2π·k/size) for k in [0, size/2).
	readonly twiddleImaginary: Float64Array
}

// Reusable row-major complex buffers and plans for a separable 2D transform.
export interface FFT2DWorkspace {
	// Row length in samples; a power of two equal to rowPlan.size.
	readonly width: number
	// Number of rows; a power of two equal to columnPlan.size.
	readonly height: number
	// Real parts, row-major with length width·height; transformed in place.
	readonly real: Float64Array
	// Imaginary parts, row-major with length width·height; transformed in place.
	readonly imaginary: Float64Array
	// Column scratch real parts with length of at least height.
	readonly columnReal: Float64Array
	// Column scratch imaginary parts with length of at least height.
	readonly columnImaginary: Float64Array
	// Plan used for each row transform.
	readonly rowPlan: FFTPlan
	// Plan used for each column transform.
	readonly columnPlan: FFTPlan
}

// Returns the smallest power of two greater than or equal to size, or one when size is at most one.
export function fftPaddedSize(size: number) {
	let padded = 1
	while (padded < size) padded *= 2
	return padded
}

// Builds bit-reversal and twiddle tables for a power-of-two transform length.
export function fftPlan(size: number): FFTPlan {
	let bits = 0

	for (let n = size; n > 1; n *= 0.5) {
		bits++
	}

	const bitReversed = new Uint32Array(size)
	const twiddleReal = new Float64Array(size > 1 ? size >>> 1 : 0)
	const twiddleImaginary = new Float64Array(twiddleReal.length)

	for (let i = 0; i < size; i++) {
		let source = i
		let reversed = 0

		for (let bit = 0; bit < bits; bit++) {
			reversed = (reversed << 1) | (source & 1)
			source >>>= 1
		}

		bitReversed[i] = reversed
	}

	const scale = -TAU / size

	for (let i = 0; i < twiddleReal.length; i++) {
		const angle = scale * i
		twiddleReal[i] = Math.cos(angle)
		twiddleImaginary[i] = Math.sin(angle)
	}

	return { size, bitReversed, twiddleReal, twiddleImaginary }
}

// Allocates a zero-filled 2D workspace padded to power-of-two dimensions, sharing one plan when square.
export function fft2DWorkspace(width: number, height: number): FFT2DWorkspace {
	width = fftPaddedSize(width)
	height = fftPaddedSize(height)
	const rowPlan = fftPlan(width)
	const columnPlan = width === height ? rowPlan : fftPlan(height)
	const size = width * height

	return { width, height, real: new Float64Array(size), imaginary: new Float64Array(size), columnReal: new Float64Array(height), columnImaginary: new Float64Array(height), rowPlan, columnPlan }
}

// Transforms plan.size contiguous complex samples starting at offset, in place.
// The inverse transform is scaled by 1/size.
export function fftComplex1D(real: Float64Array, imaginary: Float64Array, offset: number, plan: FFTPlan, inverse: boolean) {
	const { size, bitReversed, twiddleReal, twiddleImaginary } = plan

	for (let i = 0; i < size; i++) {
		const j = bitReversed[i]

		if (j > i) {
			const a = offset + i
			const b = offset + j
			const realValue = real[a]
			const imaginaryValue = imaginary[a]

			real[a] = real[b]
			imaginary[a] = imaginary[b]
			real[b] = realValue
			imaginary[b] = imaginaryValue
		}
	}

	const twiddleSign = inverse ? -1 : 1

	for (let blockSize = 2; blockSize <= size; blockSize <<= 1) {
		const halfSize = blockSize >>> 1
		const twiddleStep = size / blockSize

		for (let blockOffset = 0; blockOffset < size; blockOffset += blockSize) {
			for (let i = 0, twiddleIndex = 0; i < halfSize; i++, twiddleIndex += twiddleStep) {
				const a = offset + blockOffset + i
				const b = a + halfSize
				const wr = twiddleReal[twiddleIndex]
				const wi = twiddleImaginary[twiddleIndex] * twiddleSign
				const br = real[b]
				const bi = imaginary[b]
				const tr = wr * br - wi * bi
				const ti = wr * bi + wi * br
				const ar = real[a]
				const ai = imaginary[a]

				real[a] = ar + tr
				imaginary[a] = ai + ti
				real[b] = ar - tr
				imaginary[b] = ai - ti
			}
		}
	}

	if (inverse) {
		const scale = 1 / size

		for (let i = 0, j = offset; i < size; i++, j++) {
			real[j] *= scale
			imaginary[j] *= scale
		}
	}
}

// Runs a separable in-place 2D transform over the workspace buffers: every row, then every column.
// The inverse is scaled by 1/(width·height). Column scratch buffers are overwritten.
export function fftComplex2D(workspace: FFT2DWorkspace, inverse: boolean) {
	const { width, height, real, imaginary, columnReal, columnImaginary, rowPlan, columnPlan } = workspace

	for (let y = 0, offset = 0; y < height; y++, offset += width) {
		fftComplex1D(real, imaginary, offset, rowPlan, inverse)
	}

	for (let x = 0; x < width; x++) {
		for (let y = 0, i = x; y < height; y++, i += width) {
			columnReal[y] = real[i]
			columnImaginary[y] = imaginary[i]
		}

		fftComplex1D(columnReal, columnImaginary, 0, columnPlan, inverse)

		for (let y = 0, i = x; y < height; y++, i += width) {
			real[i] = columnReal[y]
			imaginary[i] = columnImaginary[y]
		}
	}
}
