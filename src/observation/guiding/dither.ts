import type { Random } from '../../math/numerical/random'
import { GoldenDitherGenerator } from './dither.golden'
import { GridDitherGenerator } from './dither.grid'
import { RandomDitherGenerator } from './dither.random'
import { SpiralDitherGenerator } from './dither.spiral'

// Public facade and shared contracts for unit-agnostic dither pattern generation. Each active
// strategy owns one mutable sequence and returns relative increments along the mount RA/DEC axes.

// Dither pattern: PHD2's uniform draws or lattice spiral, a golden-angle disk, or an axis-aligned grid.
export type DitherMode = 'random' | 'spiral' | 'golden' | 'grid'

// One dither increment along the mount axes, in the same unit as the requested amount.
export interface DitherOffset {
	// Increment along the right ascension axis. Positive follows the consumer's positive RA convention.
	readonly rightAscension: number
	// Increment along the declination axis. Always zero for RA-only dithers.
	readonly declination: number
}

// Construction options for a dither generator.
export interface DitherGeneratorOptions {
	// Initial pattern. Defaults to `random`.
	readonly mode?: DitherMode
	// Uniform source in [0, 1) used by the random pattern. Defaults to `Math.random`; the same source
	// survives resets and mode changes so an injected reproducible stream is never rewound.
	readonly random?: Random
}

// Internal strategy contract. One instance owns one sequence and produces offsets in the amount unit.
interface DitherPatternGenerator {
	// Restarts the owned sequence without changing external resources such as an injected random source.
	readonly reset: () => void
	// Advances one step; `raOnly` holds declination at zero and may restart axis-sensitive patterns.
	readonly next: (amount: number, raOnly?: boolean) => DitherOffset
}

// Creates a fresh strategy for the selected mode while retaining the facade-owned random source.
function createDitherPatternGenerator(mode: DitherMode, random: Random): DitherPatternGenerator {
	switch (mode) {
		case 'random':
			return new RandomDitherGenerator(random)
		case 'spiral':
			return new SpiralDitherGenerator()
		case 'golden':
			return new GoldenDitherGenerator()
		case 'grid':
			return new GridDitherGenerator()
	}
}

// Selects a dither strategy while preserving the public generator lifecycle used by GuiderClient.
export class DitherGenerator {
	// Configured pattern name returned by `mode` and used when replacing the active strategy.
	#mode: DitherMode
	// Caller-owned uniform source retained across every strategy replacement.
	readonly #random: Random
	// Active strategy; no inactive sequence state is retained by the facade.
	#generator: DitherPatternGenerator

	// Creates the selected strategy, defaulting to the random pattern and `Math.random`.
	constructor(options?: DitherGeneratorOptions) {
		this.#mode = options?.mode ?? 'random'
		this.#random = options?.random ?? Math.random
		this.#generator = createDitherPatternGenerator(this.#mode, this.#random)
	}

	// Returns the pattern currently used by `next`.
	get mode() {
		return this.#mode
	}

	// Replaces the strategy with a fresh sequence, including when `mode` is already selected.
	setMode(mode: DitherMode) {
		this.#mode = mode
		this.#generator = createDitherPatternGenerator(mode, this.#random)
	}

	// Restarts only the active strategy without rewinding the injected random source.
	reset() {
		this.#generator.reset()
	}

	// Advances the active pattern by one relative RA/DEC increment. `amount` supplies the unit and is
	// expected to be positive and finite but is not validated; `raOnly` holds declination at zero.
	next(amount: number, raOnly: boolean = false): DitherOffset {
		return this.#generator.next(amount, raOnly)
	}
}
