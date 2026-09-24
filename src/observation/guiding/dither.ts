import { PI } from '../../core/constants'
import type { Random } from '../../math/numerical/random'

// Reusable dither pattern generators. Produces a relative increment along the mount RA/DEC axes and
// nothing else: it knows neither the camera, the calibration nor the hardware, so it is unit-agnostic —
// an `amount` in pixels yields an offset in pixels, an `amount` in radians yields an offset in radians.
// Consumers decide how to apply the increment (`GuiderClient` shifts the lock target, the direct dither
// converts it into pulse durations). Spiral, golden-angle, and grid patterns are stateful and mutate
// their own sequence in place across successive calls. Random and spiral match PHD2; golden-angle and
// grid are local patterns.

// Golden angle in radians, 2π / φ², the smaller angle that spaces successive samples evenly on a disk.
const GOLDEN_ANGLE = PI * (3 - Math.sqrt(5))

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
	// Uniform source in [0, 1) used by the random pattern. Defaults to `Math.random`.
	// Injecting a seeded generator makes the random pattern reproducible in tests.
	readonly random?: Random
}

// PHD2 DitherSpiral generator state, advanced across successive dithers to walk an expanding lattice
// spiral. `x`/`y` are lattice coordinates in units of the dither amount and `dx`/`dy` the current step
// direction; `prevRaOnly` detects a change of dither axis mode, which restarts the spiral.
interface SpiralDitherState {
	x: number
	y: number
	dx: number
	dy: number
	prevRaOnly: boolean
}

// Generates successive dither offsets along the mount RA/DEC axes, reproducing PHD2's DITHER_RANDOM
// and DitherSpiral patterns. The instance owns the spiral state, so a single generator must back a
// single dither sequence.
export class DitherGenerator {
	#mode: DitherMode
	// Mutated in place; `reset` reassigns the fields instead of allocating a new state object.
	readonly #spiral: SpiralDitherState = { x: 0, y: 0, dx: -1, dy: 0, prevRaOnly: false }
	readonly #random: Random
	// Index of the next golden-angle sample. Zero means the next call emits sample 1.
	#golden = 0
	// Chebyshev ring currently being walked by the grid. Ring 1 is the eight cells around the origin.
	#gridRing = 1
	// Position within the current grid ring.
	#gridIndex = 0
	// Border cells of the current grid ring, in row-major order. Rebuilt when a ring is exhausted.
	#gridPoints: readonly (readonly [number, number])[] | undefined = undefined
	// Previous absolute golden or grid coordinate, in the caller's amount unit, so the next call can
	// return an increment.
	#patternX = 0
	#patternY = 0
	// RA-only flag of the previous golden or grid step. Changing it restarts that pattern.
	#patternRaOnly = false

	constructor(options?: DitherGeneratorOptions) {
		this.#mode = options?.mode ?? 'random'
		this.#random = options?.random ?? Math.random
	}

	// The pattern currently used by `next`.
	get mode() {
		return this.#mode
	}

	// Selects the dither pattern and restarts the spiral, unconditionally and even when the requested
	// mode equals the current one. PHD2 restarts the sequence on every mode command, and GuiderClient
	// exposes that behavior, so skipping the reset for an unchanged mode would be observable.
	setMode(mode: DitherMode) {
		this.#mode = mode
		this.reset()
	}

	// Restarts the spiral at the lattice origin. The random pattern is stateless and unaffected.
	reset() {
		const spiral = this.#spiral
		spiral.x = 0
		spiral.y = 0
		spiral.dx = -1
		spiral.dy = 0
		spiral.prevRaOnly = false
		this.#golden = 0
		this.#gridRing = 1
		this.#gridIndex = 0
		this.#gridPoints = undefined
		this.#patternX = 0
		this.#patternY = 0
		this.#patternRaOnly = false
	}

	// Advances the pattern one step and returns the offset along the mount axes.
	// `amount` is the dither scale in the caller's unit and is expected to be positive and finite;
	// it is not validated here, and out-of-domain values simply propagate into the returned offset.
	// `raOnly` holds declination at zero and switches the spiral, golden-angle, and grid walks.
	next(amount: number, raOnly: boolean = false): DitherOffset {
		if (this.#mode === 'spiral') return this.#nextSpiral(amount, raOnly)
		if (this.#mode === 'golden') return this.#nextGolden(amount, raOnly)
		if (this.#mode === 'grid') return this.#nextGrid(amount, raOnly)
		return this.#nextRandom(amount, raOnly)
	}

	// Draws a per-axis uniform offset in [-amount, +amount], following PHD2's DITHER_RANDOM.
	// The declination draw is skipped entirely for RA-only dithers, so the injected source is consumed
	// once instead of twice; that consumption order is part of the reproducible sequence.
	#nextRandom(amount: number, raOnly: boolean): DitherOffset {
		const rightAscension = amount * (this.#random() * 2 - 1)
		const declination = raOnly ? 0 : amount * (this.#random() * 2 - 1)
		return { rightAscension, declination }
	}

	// Advances PHD2's DitherSpiral one step, mirroring DitherSpiral::GetDither. The generator restarts
	// when toggling between RA-only and RA/DEC. The RA-only walk visits x = 0, 1, -1, -2, 2, 3, ... so
	// a single step can exceed `amount` in magnitude; the returned value is always the increment
	// relative to the previous position, never the absolute lattice coordinate.
	#nextSpiral(amount: number, raOnly: boolean): DitherOffset {
		const spiral = this.#spiral

		if (raOnly !== spiral.prevRaOnly) {
			spiral.x = 0
			spiral.y = 0
			spiral.dx = -1
			spiral.dy = 0
			spiral.prevRaOnly = raOnly
		}

		if (raOnly) {
			// ROT(dx, dy): rotate the step direction 90 degrees.
			const t = -spiral.dx
			spiral.dx = spiral.dy
			spiral.dy = t

			// x = 0, 1, -1, -2, 2, 3, -3, -4, 4, 5, ...
			const x0 = spiral.x
			if (spiral.dy === 0) spiral.x = -spiral.x
			else spiral.x += spiral.dy

			return { rightAscension: (spiral.x - x0) * amount, declination: 0 }
		}

		if (spiral.x === spiral.y || (spiral.x > 0 && spiral.x === -spiral.y) || (spiral.x <= 0 && spiral.y === 1 - spiral.x)) {
			// ROT(dx, dy): turn at the spiral arm boundary.
			const t = -spiral.dx
			spiral.dx = spiral.dy
			spiral.dy = t
		}

		spiral.x += spiral.dx
		spiral.y += spiral.dy

		return { rightAscension: spiral.dx * amount, declination: spiral.dy * amount }
	}

	// Restarts the golden-angle and grid sequences when the caller toggles RA-only, matching the spiral.
	#restartPatternForAxis(raOnly: boolean) {
		if (raOnly === this.#patternRaOnly) return
		this.#patternRaOnly = raOnly
		this.#golden = 0
		this.#gridRing = 1
		this.#gridIndex = 0
		this.#gridPoints = undefined
		this.#patternX = 0
		this.#patternY = 0
	}

	// Returns the increment from the previous absolute pattern coordinate to the next one.
	#patternIncrement(x: number, y: number): DitherOffset {
		const offset = { rightAscension: x - this.#patternX, declination: y - this.#patternY }
		this.#patternX = x
		this.#patternY = y
		return offset
	}

	// Advances a golden-angle disk. Sample n sits at radius amount·√n and angle n times the golden angle.
	// The first call uses n = 1, so it leaves the origin. RA-only keeps the same angle but drops the
	// declination coordinate.
	#nextGolden(amount: number, raOnly: boolean): DitherOffset {
		this.#restartPatternForAxis(raOnly)
		this.#golden++
		const theta = this.#golden * GOLDEN_ANGLE
		const radius = amount * Math.sqrt(this.#golden)
		return this.#patternIncrement(radius * Math.cos(theta), raOnly ? 0 : radius * Math.sin(theta))
	}

	// Advances an axis-aligned grid. Ring r contains the cells whose Chebyshev radius is r, walked
	// row-major from the southern row eastward. The origin is not emitted; the first cell is the
	// south-west corner of ring 1. RA-only follows the same columns and holds declination at zero.
	#nextGrid(amount: number, raOnly: boolean): DitherOffset {
		this.#restartPatternForAxis(raOnly)
		if (this.#gridPoints === undefined || this.#gridIndex >= this.#gridPoints.length) {
			this.#gridPoints = gridRing(this.#gridRing)
			this.#gridRing++
			this.#gridIndex = 0
		}
		const point = this.#gridPoints[this.#gridIndex]
		this.#gridIndex++
		const x = point === undefined ? 0 : point[0]
		const y = point === undefined ? 0 : point[1]
		return this.#patternIncrement(x * amount, raOnly ? 0 : y * amount)
	}
}

// Cells of one Chebyshev ring, row-major. Ring 0 is the origin and is not requested.
function gridRing(ring: number) {
	const points: (readonly [number, number])[] = []
	for (let y = -ring; y <= ring; y++) {
		for (let x = -ring; x <= ring; x++) {
			if (Math.max(Math.abs(x), Math.abs(y)) === ring) points.push([x, y])
		}
	}
	return points
}
