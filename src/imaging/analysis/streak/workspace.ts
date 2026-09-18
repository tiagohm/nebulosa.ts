import { PI } from '../../../core/constants'
import { validateInRange, validatePositiveInteger } from '../../../core/validation'
import type { Angle } from '../../../math/units/angle'
import { makeImageRawTypedArray, type ImageRawType } from '../../model/types'
import { ROBUST_SAMPLE_CAPACITY, RobustReservoir } from '../robust'

// Reusable bounded storage for streak preprocessing, sparse edge collection, Hough voting, and line
// refinement. Width and height are capacities in received-image pixels; buffers never grow in use.

// Smallest supported background cell, used to bound coarse-grid workspace capacity.
export const MINIMUM_STREAK_BACKGROUND_CELL_SIZE = 8

// Default retained oriented-edge capacity under candidate pressure.
export const DEFAULT_MAXIMUM_STREAK_EDGE_POINTS = 131_072

// Construction settings that determine fixed workspace capacities.
export interface StreakDetectionWorkspaceOptions {
	// Floating-point precision of the full-plane residual buffer.
	readonly precision?: 32 | 64
	// Maximum Hough hypotheses retained for refinement.
	readonly maximumCandidates?: number
	// Maximum sparse edge points retained before deterministic stratification.
	readonly maximumEdgePoints?: number
	// Smallest coarse angular step the workspace must support, in radians.
	readonly angleStep?: Angle
	// Smallest rho step the workspace must support, in received-image pixels.
	readonly distanceStep?: number
}

// Mutable per-call counters exposed for benchmarks without reallocating diagnostic objects.
export interface StreakDetectionWorkspaceState {
	// Number of retained edge points in the latest call.
	edgeCount: number
	// Number of Hough candidates retained in the latest call.
	candidateCount: number
	// Whether eligible edge points exceeded fixed storage in the latest call.
	edgesTruncated: boolean
}

// Caller-reusable fixed-capacity storage for the complete detector pipeline.
export interface StreakDetectionWorkspace {
	// Maximum received-image width accepted by this workspace, in pixels.
	readonly width: number
	// Maximum received-image height accepted by this workspace, in pixels.
	readonly height: number
	// Precision of the principal residual buffer.
	readonly precision: 32 | 64
	// Maximum Hough hypotheses supported without allocation.
	readonly maximumCandidates: number
	// Maximum retained sparse edge points.
	readonly maximumEdgePoints: number
	// Maximum angular-bin count supported by the counting arrays.
	readonly angleCapacity: number
	// Maximum reusable rho-bin count.
	readonly rhoCapacity: number
	// Selected native plane, reused in place for background-subtracted residual signal.
	readonly signal: ImageRawType
	// Per-plane-sample bit mask; bit 0 is invalid and bit 1 is saturated.
	readonly mask: Uint8Array
	// Coarse local background medians in row-major cell order.
	readonly background: Float64Array
	// Coarse local normalized-MAD noise in row-major cell order; zero means unresolved.
	readonly noise: Float64Array
	// Sparse oriented-edge X coordinates in native-plane pixels.
	readonly edgeX: Float32Array
	// Sparse oriented-edge Y coordinates in native-plane pixels.
	readonly edgeY: Float32Array
	// Bounded edge vote weights.
	readonly edgeWeight: Float32Array
	// Quantized local tangent bin for each retained edge.
	readonly edgeAngleBin: Uint16Array | Uint32Array
	// Edge indices sorted by angular bin without moving coordinate arrays.
	readonly edgeOrder: Uint32Array
	// Edge counts per angular bin.
	readonly angleCounts: Uint32Array
	// Prefix offsets per angular bin, including one terminal offset.
	readonly angleOffsets: Uint32Array
	// Reusable one-angle rho accumulator.
	readonly rhoAccumulator: Float64Array
	// Reusable nearest-bin rho accumulator for phase-robust scoring.
	readonly rhoNearest: Float64Array
	// Deterministic robust sample reservoir shared by sequential reductions.
	readonly statistics: RobustReservoir
	// Robust-statistics and refinement scratch storage.
	readonly scratch: Float64Array
	// Integrated signal at each sampled longitudinal position.
	readonly longitudinalSignal: Float64Array
	// Flux centroid offset normal to the seed line at each longitudinal position, in plane pixels.
	readonly longitudinalOffset: Float64Array
	// Bounded fit weight at each longitudinal position.
	readonly longitudinalWeight: Float64Array
	// Boolean support classification at each longitudinal position.
	readonly longitudinalSupported: Uint8Array
	// Reused counters and truncation state from the latest call.
	readonly state: StreakDetectionWorkspaceState
}

// Creates all fixed detector buffers for a maximum received-image extent.
export function createStreakDetectionWorkspace(width: number, height: number, options: Readonly<StreakDetectionWorkspaceOptions> = {}): StreakDetectionWorkspace {
	validatePositiveInteger(width)
	validatePositiveInteger(height)
	validateInRange(width, 1, 32_768)
	validateInRange(height, 1, 32_768)

	const length = width * height
	if (!Number.isSafeInteger(length) || length > 67_108_864) throw new RangeError('streak workspace is limited to 67108864 received-image pixels')

	const precision = options.precision ?? 32
	const maximumCandidates = options.maximumCandidates ?? 128
	const maximumEdgePoints = options.maximumEdgePoints ?? DEFAULT_MAXIMUM_STREAK_EDGE_POINTS
	const angleStep = options.angleStep ?? PI / 90
	const distanceStep = options.distanceStep ?? 1

	validatePositiveInteger(maximumCandidates)
	validatePositiveInteger(maximumEdgePoints)
	validateInRange(maximumCandidates, 1, 4096)
	validateInRange(maximumEdgePoints, 1, 4_194_304)
	validateInRange(angleStep, PI / 4096, PI)
	validateInRange(distanceStep, 1 / 16, Math.hypot(width, height))

	const angleCapacity = Math.ceil(PI / angleStep)
	const rhoCapacity = Math.ceil((2 * Math.hypot(width, height)) / distanceStep) + 4
	const backgroundCapacity = Math.ceil(width / MINIMUM_STREAK_BACKGROUND_CELL_SIZE) * Math.ceil(height / MINIMUM_STREAK_BACKGROUND_CELL_SIZE)
	const longitudinalCapacity = Math.ceil(Math.hypot(width, height)) + 4
	const angleArray = angleCapacity <= 65_536 ? new Uint16Array(maximumEdgePoints) : new Uint32Array(maximumEdgePoints)

	return {
		width,
		height,
		precision,
		maximumCandidates,
		maximumEdgePoints,
		angleCapacity,
		rhoCapacity,
		signal: makeImageRawTypedArray(precision, length),
		mask: new Uint8Array(length),
		background: new Float64Array(backgroundCapacity),
		noise: new Float64Array(backgroundCapacity),
		edgeX: new Float32Array(maximumEdgePoints),
		edgeY: new Float32Array(maximumEdgePoints),
		edgeWeight: new Float32Array(maximumEdgePoints),
		edgeAngleBin: angleArray,
		edgeOrder: new Uint32Array(maximumEdgePoints),
		angleCounts: new Uint32Array(angleCapacity),
		angleOffsets: new Uint32Array(angleCapacity + 1),
		rhoAccumulator: new Float64Array(rhoCapacity),
		rhoNearest: new Float64Array(Math.max(rhoCapacity, angleCapacity)),
		statistics: new RobustReservoir(length),
		scratch: new Float64Array(Math.min(length, ROBUST_SAMPLE_CAPACITY)),
		longitudinalSignal: new Float64Array(longitudinalCapacity),
		longitudinalOffset: new Float64Array(longitudinalCapacity),
		longitudinalWeight: new Float64Array(longitudinalCapacity),
		longitudinalSupported: new Uint8Array(longitudinalCapacity),
		state: { edgeCount: 0, candidateCount: 0, edgesTruncated: false },
	}
}
