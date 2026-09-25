import { PI } from '../../core/constants'
import type { DitherOffset } from './dither'

// Golden-angle disk dither generation. The strategy tracks successive absolute sample coordinates and
// returns their relative increment in the requested amount unit without sharing state between sequences.

// Golden angle in radians, 2π / φ², used to distribute successive samples around the disk.
const GOLDEN_ANGLE = PI * (3 - Math.sqrt(5))

// Generates an expanding golden-angle disk whose first sample has index one and radius `amount`.
export class GoldenDitherGenerator {
	// Index of the previous sample; zero means the next call emits sample one.
	#sample = 0
	// Previous absolute right ascension coordinate in the requested amount unit.
	#x = 0
	// Previous absolute declination coordinate in the requested amount unit.
	#y = 0
	// Axis mode used by the preceding step; changing it restarts the sequence.
	#prevRaOnly = false

	// Restarts the disk at the origin with sample one pending.
	reset() {
		this.#sample = 0
		this.#x = 0
		this.#y = 0
		this.#prevRaOnly = false
	}

	// Advances one sample and returns the increment from the preceding absolute coordinate in the
	// amount unit. `amount` is expected to be positive and finite but is not validated; changing
	// `raOnly` restarts at the origin and holds declination at zero.
	next(amount: number, raOnly: boolean = false): DitherOffset {
		if (raOnly !== this.#prevRaOnly) {
			this.reset()
			this.#prevRaOnly = raOnly
		}

		this.#sample++
		const theta = this.#sample * GOLDEN_ANGLE
		const radius = amount * Math.sqrt(this.#sample)
		const x = radius * Math.cos(theta)
		const y = raOnly ? 0 : radius * Math.sin(theta)
		const offset = { rightAscension: x - this.#x, declination: y - this.#y }
		this.#x = x
		this.#y = y
		return offset
	}
}
