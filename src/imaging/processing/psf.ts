import type { Image, ImageRawType } from '../model/types'
import { shift } from './convolution'

// https://github.com/KDE/kstars/blob/master/kstars/ekos/guide/internalguide/guidealgorithms.cpp

// KStars guider point-spread-function weights, one per concentric ring (A center .. D3 outermost),
// applied over the 9x9 grid shown below.
//                              A      B1     B2     C1    C2      C3     D1       D2     D3
const PSF = new Float32Array([0.906, 0.584, 0.365, 0.117, 0.049, -0.05, -0.064, -0.074, -0.094])

// PSF Grid
// D3 D3 D3 D3 D3 D3 D3 D3 D3
// D3 D3 D3 D2 D1 D2 D3 D3 D3
// D3 D3 C3 C2 C1 C2 C3 D3 D3
// D3 D2 C2 B2 B1 B2 C2 D2 D3
// D3 D1 C1 B1 A  B1 C1 D1 D3
// D3 D2 C2 B2 B1 B2 C2 D2 D3
// D3 D3 C3 C2 C1 C2 C3 D3 D3
// D3 D3 D3 D2 D1 D2 D3 D3 D3
// D3 D3 D3 D3 D3 D3 D3 D3 D3

// 1@A
// 4@B1, B2, C1, C3, D1
// 8@C2, D2
// 44 * D3

// Applies the KStars internal guider PSF filter in place.
export function psf(image: Image) {
	const { raw, metadata } = image
	const { width: iw, height: ih, channels, stride } = metadata
	const buffer = new Array<ImageRawType>(9)

	// Copies one source row into the rolling PSF buffer when it is in bounds.
	function read(y: number, output: ImageRawType) {
		if (y < 0 || y >= ih) {
			// output.fill(0)
		} else {
			const start = y * stride
			output.set(raw.subarray(start, start + stride))
		}
	}

	for (let i = 0; i < buffer.length; i++) {
		buffer[i] = raw instanceof Float64Array ? new Float64Array(stride) : new Float32Array(stride)
		read(i, buffer[i])
	}

	const c0 = 0
	const c1 = channels
	const c2 = 2 * channels
	const c3 = 3 * channels
	const c4 = 4 * channels

	for (let y = 4; y < ih - 4; y++) {
		const py = y * stride

		const b0 = buffer[0]
		const b1 = buffer[1]
		const b2 = buffer[2]
		const b3 = buffer[3]
		const b4 = buffer[4]
		const b5 = buffer[5]
		const b6 = buffer[6]
		const b7 = buffer[7]
		const b8 = buffer[8]

		for (let x = 4; x < iw - 4; x++) {
			for (let c = 0, xi = x * channels; c < channels; c++, xi++) {
				const A = b4[xi + c0]
				const B1 = b3[xi + c0] + b5[xi + c0] + b4[xi + c1] + b4[xi - c1]
				const B2 = b3[xi - c1] + b3[xi + c1] + b5[xi - c1] + b5[xi + c1]
				const C1 = b2[xi + c0] + b4[xi - c2] + b4[xi + c2] + b6[xi + c0]
				const C2 = b2[xi - c1] + b2[xi + c1] + b3[xi - c2] + b3[xi + c2] + b5[xi - c2] + b5[xi + c2] + b6[xi - c1] + b6[xi + c1]
				const C3 = b2[xi - c2] + b2[xi + c2] + b6[xi - c2] + b6[xi + c2]
				const D1 = b1[xi + c0] + b4[xi - c3] + b4[xi + c3] + b7[xi + c0]
				const D2 = b1[xi - c1] + b1[xi + c1] + b3[xi - c3] + b3[xi + c3] + b5[xi - c3] + b5[xi + c3] + b7[xi - c1] + b7[xi + c1]
				let D3 = b2[xi - c4] + b2[xi - c3] + b2[xi + c3] + b2[xi + c4] + b3[xi - c4] + b3[xi + c4] + b4[xi - c4] + b4[xi + c4] + b5[xi - c4] + b5[xi + c4] + b6[xi - c4] + b6[xi - c3] + b6[xi + c3] + b6[xi + c4]

				D3 += b0[xi - c4] + b0[xi - c3] + b0[xi - c2] + b0[xi - c1] + b0[xi - c0]
				D3 += b0[xi + c4] + b0[xi + c3] + b0[xi + c2] + b0[xi + c1]

				D3 += b1[xi - c4] + b1[xi - c3] + b1[xi - c2]
				D3 += b1[xi + c4] + b1[xi + c3] + b1[xi + c2]

				D3 += b7[xi - c4] + b7[xi - c3] + b7[xi - c2]
				D3 += b7[xi + c4] + b7[xi + c3] + b7[xi + c2]

				D3 += b8[xi - c4] + b8[xi - c3] + b8[xi - c2] + b8[xi - c1] + b8[xi - c0]
				D3 += b8[xi + c4] + b8[xi + c3] + b8[xi + c2] + b8[xi + c1]

				const mean = (A + B1 + B2 + C1 + C2 + C3 + D1 + D2 + D3) / 81
				const mean4 = mean * 4
				const mean8 = mean * 8

				raw[py + xi] = PSF[0] * (A - mean) + PSF[1] * (B1 - mean4) + PSF[2] * (B2 - mean4) + PSF[3] * (C1 - mean4) + PSF[4] * (C2 - mean8) + PSF[5] * (C3 - mean4) + PSF[6] * (D1 - mean4) + PSF[7] * (D2 - mean8) + PSF[8] * (D3 - 44 * mean)
			}
		}

		shift(buffer)
		read(y + 5, buffer.at(-1)!)
	}

	return image
}
