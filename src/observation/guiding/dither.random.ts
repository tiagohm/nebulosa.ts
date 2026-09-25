import type { Random } from '../../math/numerical/random'
import type { DitherOffset } from './dither'

// PHD2-compatible uniform random dither generation. The injected source is caller-owned and is never
// reset or replaced; RA-only steps deliberately consume one draw instead of two.

// Generates independent uniform RA/DEC offsets without mutable sequence state.
export class RandomDitherGenerator {
	// Uniform source in [0, 1), retained unchanged for the lifetime of this strategy.
	readonly #random: Random

	// Uses the supplied random stream without taking ownership of its state or seed.
	constructor(random: Random) {
		this.#random = random
	}

	// Leaves the external random stream at its current position.
	reset() {}

	// Maps draws to [-amount, +amount] in the amount unit and returns the relative axes. `amount` is
	// expected to be positive and finite but is not validated; RA-only skips the declination draw.
	next(amount: number, raOnly: boolean = false): DitherOffset {
		const rightAscension = amount * (this.#random() * 2 - 1)
		const declination = raOnly ? 0 : amount * (this.#random() * 2 - 1)
		return { rightAscension, declination }
	}
}
