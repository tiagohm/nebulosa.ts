import type { DitherOffset } from './dither'

// Axis-aligned grid dither generation. The strategy walks successive Chebyshev ring borders in
// row-major order and returns relative increments in the requested amount unit; the origin is omitted.

// Produces the border cells of a positive Chebyshev ring in row-major order; ring zero is unsupported
// because the grid sequence deliberately omits the origin.
function gridRing(ring: number) {
	const points: (readonly [number, number])[] = []
	for (let y = -ring; y <= ring; y++) {
		for (let x = -ring; x <= ring; x++) {
			if (Math.max(Math.abs(x), Math.abs(y)) === ring) points.push([x, y])
		}
	}
	return points
}

// Generates an expanding grid walk beginning at the south-west corner of Chebyshev ring one.
export class GridDitherGenerator {
	// Next Chebyshev ring to build when the current border is exhausted.
	#ring = 1
	// Position of the next cell within the current ring border.
	#index = 0
	// Current ring border, allocated once per ring and walked in row-major order.
	#points: readonly (readonly [number, number])[] | undefined = undefined
	// Previous absolute right ascension coordinate in the requested amount unit.
	#x = 0
	// Previous absolute declination coordinate in the requested amount unit.
	#y = 0
	// Axis mode used by the preceding step; changing it restarts the sequence.
	#prevRaOnly = false

	// Restarts with ring one pending and the previous absolute coordinate at the origin.
	reset() {
		this.#ring = 1
		this.#index = 0
		this.#points = undefined
		this.#x = 0
		this.#y = 0
		this.#prevRaOnly = false
	}

	// Advances one border cell and returns the increment from the preceding absolute coordinate in the
	// amount unit. `amount` is expected to be positive and finite but is not validated; changing
	// `raOnly` restarts at ring one and holds declination at zero.
	next(amount: number, raOnly: boolean = false): DitherOffset {
		if (raOnly !== this.#prevRaOnly) {
			this.reset()
			this.#prevRaOnly = raOnly
		}

		if (this.#points === undefined || this.#index >= this.#points.length) {
			this.#points = gridRing(this.#ring)
			this.#ring++
			this.#index = 0
		}

		const point = this.#points[this.#index]
		this.#index++
		const x = (point?.[0] ?? 0) * amount
		const y = raOnly ? 0 : (point?.[1] ?? 0) * amount
		const offset = { rightAscension: x - this.#x, declination: y - this.#y }
		this.#x = x
		this.#y = y
		return offset
	}
}
