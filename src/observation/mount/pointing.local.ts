import { eraS2c } from '../../astronomy/coordinates/erfa/erfa'
import { medianOf } from '../../core/util'
import { validateNumberArray, validateObject, validateOneOf } from '../../core/validation'
import type { PierSide } from '../../devices/indi/device'
import type { Angle } from '../../math/units/angle'
import { normalizePierSide, type PointingOffset } from './pointing.basis'

// Local residual layer of the mount pointing model: a k-nearest-neighbour, tricube-weighted average of
// the residuals the global model leaves behind, evaluated on the sphere and filtered by pier side.
//
// It exists for what a global basis cannot describe: localized tube flexure, a mirror that shifts over
// part of the sky, an irregularity of one worm sector. Those are smooth in a neighbourhood but not
// expressible as a low-order function of hour angle and declination, so adding more global terms fits
// them badly everywhere instead of well somewhere.
//
// This is interpolation, never extrapolation. The contribution is tapered by the local sampling density
// and decays to zero once the query leaves the sampled region, so a target far from every calibration
// point falls back to the global model alone rather than inheriting the residual of a distant sample.
//
// All angles are radians. Offsets follow the model convention: `dx` east-positive, `dy` north-positive,
// expressed in the tangent plane at the target, and defined as `solved - target`.

// Tuning for the local residual layer.
export interface LocalPointingResidualOptions {
	// Enables the layer. Off by default: with few or unevenly spread samples a local layer memorizes
	// plate-solve noise, and the global model alone is the safer answer.
	readonly enabled?: boolean
	// Number of neighbours averaged at each query (default 6). The bandwidth is the distance to the
	// k-th of them, so the k-th itself receives zero tricube weight and k-1 effectively contribute.
	readonly neighbors?: number
	// Accepted-sample count below which the layer is not built at all (default 30). Under it the
	// neighbourhoods are too sparse for the average to describe anything but noise.
	readonly minimumSamples?: number
}

// Local residual options with every field resolved to a concrete value.
export type ResolvedLocalPointingResidualOptions = Required<LocalPointingResidualOptions>

// Fitted local residual layer: the training directions with the residual the global model left at each.
export interface LocalPointingResidualModel {
	// Unit vectors of the training targets, flattened as `[x0, y0, z0, x1, ...]`.
	readonly directions: readonly number[]
	// Pier side of each training sample, aligned with `directions`.
	readonly pierSides: readonly PierSide[]
	// East component of the global model's residual at each training sample (radians).
	readonly residualsDx: readonly number[]
	// North component of the global model's residual at each training sample (radians).
	readonly residualsDy: readonly number[]
	// Neighbours averaged per query.
	readonly neighbors: number
	// Characteristic sample spacing (radians): the median k-th neighbour distance of the training set.
	// Doubles as the taper length, so the layer fades out about one spacing outside the sampled region.
	readonly scale: Angle
}

// Defaults for the local residual layer: disabled, 6 neighbours, at least 30 accepted samples.
export const DEFAULT_LOCAL_RESIDUAL_OPTIONS: ResolvedLocalPointingResidualOptions = {
	enabled: false,
	neighbors: 6,
	minimumSamples: 30,
}

// Smallest bandwidth (radians) accepted before the tricube weights degenerate. About 0.2 arcsec, far
// below any mount's repeatability, so it is only ever reached by duplicate training directions.
const MINIMUM_BANDWIDTH = 1e-6

// Resolves the local residual options, applying every default.
export function resolveLocalResidualOptions(options: LocalPointingResidualOptions = {}): ResolvedLocalPointingResidualOptions {
	return {
		enabled: options.enabled ?? DEFAULT_LOCAL_RESIDUAL_OPTIONS.enabled,
		// One neighbour would be nearest-neighbour interpolation, which is discontinuous across the sky.
		neighbors: Math.max(2, Math.trunc(options.neighbors ?? DEFAULT_LOCAL_RESIDUAL_OPTIONS.neighbors)),
		minimumSamples: Math.max(1, Math.trunc(options.minimumSamples ?? DEFAULT_LOCAL_RESIDUAL_OPTIONS.minimumSamples)),
	}
}

// Builds the local residual layer from the training directions and the residuals of the global fit.
//
// `directions` is flattened as `[x0, y0, z0, ...]` and must hold one unit vector per entry of
// `pierSides`, `residualsDx` and `residualsDy`, which are the global model's residuals in radians.
// Returns `undefined` when the layer is disabled, when fewer than `minimumSamples` samples were
// accepted, or when the set is too degenerate to measure its own spacing, so the caller simply keeps
// the global model. The arrays are copied, so later mutation of the inputs cannot corrupt the model.
export function buildLocalPointingResidual(directions: readonly number[], pierSides: readonly PierSide[], residualsDx: Readonly<ArrayLike<number>>, residualsDy: Readonly<ArrayLike<number>>, options: ResolvedLocalPointingResidualOptions): LocalPointingResidualModel | undefined {
	const count = pierSides.length

	if (!options.enabled || count < options.minimumSamples) return undefined

	// The taper length is the training set's own median k-th neighbour distance, measured per pier side
	// exactly as a query will be, so a dense run and a sparse one taper in units of their own spacing.
	const spacings = new Float64Array(count)

	for (let i = 0; i < count; i++) {
		spacings[i] = nearestNeighbors(directions, pierSides, directions[i * 3], directions[i * 3 + 1], directions[i * 3 + 2], pierSides[i], i, options.neighbors).bandwidth
	}

	const scale = medianOf(spacings.sort())

	if (!Number.isFinite(scale) || scale <= 0) return undefined

	const storedDx = new Array<number>(count)
	const storedDy = new Array<number>(count)

	for (let i = 0; i < count; i++) {
		storedDx[i] = residualsDx[i]
		storedDy[i] = residualsDy[i]
	}

	return { directions: directions.slice(), pierSides: pierSides.slice(), residualsDx: storedDx, residualsDy: storedDy, neighbors: options.neighbors, scale }
}

// Predicts the local residual offset at a sky position, in radians.
//
// Neighbours are taken only from the same pier side when the query declares one, since flexure differs
// between sides and averaging across them would smear a genuine discontinuity. `NEITHER` queries and
// sides that were never sampled fall back to the whole set.
//
// Returns a zero offset when nothing is near enough to interpolate from.
export function predictLocalPointingResidual(model: Readonly<LocalPointingResidualModel>, rightAscension: Angle, declination: Angle, pierSide?: PierSide): PointingOffset {
	const [x, y, z] = eraS2c(rightAscension, declination)
	const side = normalizePierSide(pierSide)
	const requested = side === 'NEITHER' ? undefined : side
	const neighbors = nearestNeighbors(model.directions, model.pierSides, x, y, z, requested !== undefined && model.pierSides.includes(requested) ? requested : undefined, -1, model.neighbors)

	if (neighbors.found === 0) return { dx: 0, dy: 0 }

	// Tricube over the distance normalized by the k-th neighbour distance: smooth, compactly supported,
	// and adaptive, since the bandwidth follows the local sampling density instead of a fixed radius.
	const bandwidth = Math.max(neighbors.bandwidth, MINIMUM_BANDWIDTH)
	let weightSum = 0
	let dx = 0
	let dy = 0

	for (let i = 0; i < neighbors.found; i++) {
		const u = neighbors.distances[i] / bandwidth

		if (u >= 1) continue

		const t = 1 - u * u * u
		const weight = t * t * t
		const index = neighbors.indices[i]

		weightSum += weight
		dx += weight * model.residualsDx[index]
		dy += weight * model.residualsDy[index]
	}

	// Every neighbour sat at the bandwidth, which happens when they are all equidistant. The nearest one
	// is still the best available estimate, so use it alone rather than returning nothing.
	if (weightSum <= 0) {
		const index = neighbors.indices[0]
		dx = model.residualsDx[index]
		dy = model.residualsDy[index]
		weightSum = 1
	} else {
		dx /= weightSum
		dy /= weightSum
	}

	// Outside the sampled region the average is an extrapolation dressed as an interpolation: the same
	// few samples keep contributing however far away the query drifts. Taper by how much the local
	// neighbourhood has stretched relative to the training spacing, so the layer vanishes smoothly and
	// the global model is left alone.
	const taper = Math.exp(-Math.max(0, neighbors.bandwidth - model.scale) / model.scale)
	return { dx: dx * taper, dy: dy * taper }
}

// Validates a serialized local residual layer, throwing a TypeError naming the first offending field.
// Returns `value` narrowed, without cloning it.
export function validateLocalPointingResidual(value: unknown): LocalPointingResidualModel {
	const model = validateObject(value, 'model.local')
	const directions = validateNumberArray(model.directions, undefined, 'model.local.directions')

	if (directions.length % 3 !== 0) throw new TypeError('model.local.directions must hold 3 components per sample')

	const count = directions.length / 3
	const pierSides = model.pierSides

	if (!Array.isArray(pierSides) || pierSides.length !== count) throw new TypeError('model.local.pierSides must have one entry per direction')

	for (let i = 0; i < pierSides.length; i++) {
		validateOneOf(pierSides[i], LOCAL_PIER_SIDES, `model.local.pierSides[${i}]`)
	}

	// One residual per axis per sample: prediction indexes both by the neighbour's direction index.
	validateNumberArray(model.residualsDx, count, 'model.local.residualsDx')
	validateNumberArray(model.residualsDy, count, 'model.local.residualsDy')

	if (!Number.isInteger(model.neighbors) || (model.neighbors as number) < 1) throw new TypeError('model.local.neighbors must be a positive integer')
	// The scale divides the taper exponent, so a zero would make every local offset `NaN`.
	if (!Number.isFinite(model.scale) || (model.scale as number) <= 0) throw new TypeError('model.local.scale must be a positive finite angle')

	return value as LocalPointingResidualModel
}

// Every pier-side state, used to validate deserialized layers.
const LOCAL_PIER_SIDES = ['EAST', 'WEST', 'NEITHER'] as const satisfies readonly PierSide[]

// The `k` nearest training samples to a direction, optionally limited to one pier side and optionally
// skipping one index (used when measuring the training set against itself).
//
// Distances come from the chord length through `2*asin(chord/2)`, which keeps its precision for the
// small separations that dominate here, unlike `acos(dot)`. Brute force beats any spatial index at the
// few hundred samples a pointing run collects.
//
// Returns the sorted distances and their indices in the shared scratch buffers, how many were found,
// and the bandwidth: the distance to the k-th neighbour, or to the farthest one found when there are
// fewer than `k`. The buffers are reused between calls, so read them before calling again.
function nearestNeighbors(directions: readonly number[], pierSides: readonly PierSide[], x: number, y: number, z: number, pierSide: PierSide | undefined, skipIndex: number, k: number) {
	const distances = scratchDistances(k)
	const indices = scratchIndices(k)
	const count = pierSides.length
	let found = 0

	for (let i = 0; i < count; i++) {
		if (i === skipIndex) continue
		if (pierSide !== undefined && pierSides[i] !== pierSide) continue

		const dx = directions[i * 3] - x
		const dy = directions[i * 3 + 1] - y
		const dz = directions[i * 3 + 2] - z
		const distance = 2 * Math.asin(Math.min(1, Math.sqrt(dx * dx + dy * dy + dz * dz) / 2))

		if (found === k && distance >= distances[k - 1]) continue

		// Insertion sort into a list of at most k entries: cheaper than sorting the whole set, and the
		// list is already ordered, which the tricube weighting and the bandwidth both rely on.
		let slot = found < k ? found : k - 1

		while (slot > 0 && distances[slot - 1] > distance) {
			distances[slot] = distances[slot - 1]
			indices[slot] = indices[slot - 1]
			slot--
		}

		distances[slot] = distance
		indices[slot] = i

		if (found < k) found++
	}

	return { distances, indices, found, bandwidth: found === 0 ? Number.POSITIVE_INFINITY : distances[found - 1] } as const
}

// Scratch buffers for the neighbour search, grown on demand and reused across queries so a per-sample
// prediction loop allocates nothing.
let distanceBuffer = new Float64Array(0)
let indexBuffer = new Int32Array(0)

// Returns the distance scratch buffer, at least `k` long.
function scratchDistances(k: number) {
	if (distanceBuffer.length < k) distanceBuffer = new Float64Array(k)
	return distanceBuffer
}

// Returns the index scratch buffer, at least `k` long.
function scratchIndices(k: number) {
	if (indexBuffer.length < k) indexBuffer = new Int32Array(k)
	return indexBuffer
}
