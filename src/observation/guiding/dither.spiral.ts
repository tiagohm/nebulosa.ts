import type { DitherOffset } from './dither'

// PHD2-compatible expanding lattice dither generation. The strategy mutates its own lattice position
// and direction and returns increments, rather than absolute coordinates, in the requested amount unit.

// Mutable PHD2 lattice coordinates and direction; `prevRaOnly` detects axis-mode transitions.
interface SpiralDitherState {
	// Current right ascension lattice coordinate, in multiples of the requested amount.
	x: number
	// Current declination lattice coordinate, in multiples of the requested amount.
	y: number
	// Right ascension component of the next lattice step.
	dx: number
	// Declination component of the next lattice step.
	dy: number
	// Axis mode used by the preceding step; changing it restarts the sequence.
	prevRaOnly: boolean
}

// Generates the PHD2 DitherSpiral sequence for either two axes or right ascension only.
export class SpiralDitherGenerator {
	// Mutated in place to avoid allocating sequence state on every step.
	readonly #state: SpiralDitherState = { x: 0, y: 0, dx: -1, dy: 0, prevRaOnly: false }

	// Restarts at the lattice origin and initial westward direction.
	reset() {
		this.#state.x = 0
		this.#state.y = 0
		this.#state.dx = -1
		this.#state.dy = 0
		this.#state.prevRaOnly = false
	}

	// Advances one PHD2 lattice step and returns the relative axes in the amount unit. `amount` is
	// expected to be positive and finite but is not validated; switching `raOnly` restarts first.
	next(amount: number, raOnly: boolean = false): DitherOffset {
		const state = this.#state

		if (raOnly !== state.prevRaOnly) {
			this.reset()
			state.prevRaOnly = raOnly
		}

		if (raOnly) {
			const t = -state.dx
			state.dx = state.dy
			state.dy = t

			const x0 = state.x
			if (state.dy === 0) state.x = -state.x
			else state.x += state.dy

			return { rightAscension: (state.x - x0) * amount, declination: 0 }
		}

		if (state.x === state.y || (state.x > 0 && state.x === -state.y) || (state.x <= 0 && state.y === 1 - state.x)) {
			const t = -state.dx
			state.dx = state.dy
			state.dy = t
		}

		state.x += state.dx
		state.y += state.dy

		return { rightAscension: state.dx * amount, declination: state.dy * amount }
	}
}
