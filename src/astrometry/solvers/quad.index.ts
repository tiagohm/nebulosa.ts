import { type MutVec3, type Vec3, vecAngleUnit } from '../../math/linear-algebra/vec3'
import type { Angle } from '../../math/units/angle'
import type { QuadCode } from './quad.code'

// Contract between the native plate solver and its sources of quads. A QuadIndex holds one band of quad sizes:
// quads whose backbone AB spans [scaleLower, scaleUpper] on the sky, their canonical codes (quad.code.ts), and
// the reference stars the quads were built from, which the verification also uses. Implementations may be
// built in memory from a star catalog or read from index files; quad and star ids are opaque and valid only
// within one index. Positions are ICRS unit vectors at the index epoch; angles are radians.

// A spherical cap: a unit-vector center and an angular radius.
export interface SkyCone {
	// ICRS unit vector of the center.
	readonly center: Vec3
	// Angular radius, radians, in [0, PI].
	readonly radius: Angle
}

// One band of quads and its reference stars.
export interface QuadIndex extends Disposable {
	// Identifier used in diagnostics.
	readonly id: string
	// Shortest backbone AB of the quads, radians.
	readonly scaleLower: Angle
	// Longest backbone AB of the quads, radians.
	readonly scaleUpper: Angle
	// Typical positional error of the reference stars, radians.
	readonly jitter: Angle
	// Epoch of the positions, Julian year.
	readonly epoch: number
	// Region with quads and stars; undefined for the whole sky.
	readonly coverage?: SkyCone
	// Side of the uniformization cells, radians: reference stars are spread with a bounded count per cell of this size.
	readonly cellSize: Angle
	// Visits every quad whose code lies within tolerance (code units) of code; region, when given, restricts the
	// search to quads near it. visit may query this or other indexes.
	readonly searchCodes: (code: QuadCode, tolerance: number, visit: (quad: number) => void, region?: SkyCone) => void
	// Writes the star ids of a quad in canonical A, B, C, D order into out and returns it; ids may exceed 32 bits.
	readonly quadStars: (quad: number, out: Float64Array) => Float64Array
	// Writes the unit vector of a star into out and returns it.
	readonly starVector: (star: number, out: MutVec3) => MutVec3
	// Brightness rank of a star within its uniformization cell, 0 for the brightest.
	readonly starSweep: (star: number) => number
	// Visits every reference star within the cone.
	readonly starsInCone: (cone: SkyCone, visit: (star: number) => void) => void
}

// Whether an index can hold quads whose backbone spans [lower, upper] radians.
export function quadIndexOverlapsScale(index: QuadIndex, lower: Angle, upper: Angle) {
	return index.scaleLower <= upper && index.scaleUpper >= lower
}

// Whether an index can hold quads in the cone: always for a whole-sky index.
export function quadIndexOverlapsRegion(index: QuadIndex, region: SkyCone) {
	const coverage = index.coverage
	if (coverage === undefined) return true
	return vecAngleUnit(coverage.center, region.center) <= coverage.radius + region.radius
}
