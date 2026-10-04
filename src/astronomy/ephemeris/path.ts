import { vecNegate, vecPlus } from '../../math/linear-algebra/vec3'
import { zeroPositionAndVelocity, type PositionAndVelocityMut, type PositionAndVelocityOverTime } from '../coordinates/astrometry'
import { Naif } from './kernels/naif'

// Synchronous center-to-target ephemeris paths in library-base ICRS/BCRS-oriented axes.
// Positions are AU and velocities AU/day. Each provider may reuse its own borrowed
// storage between calls. Use ephemerisAt() or copy the state to retain an owned snapshot.

// A NAIF body identifier; name is descriptive metadata, not identity.
export interface NaifEphemerisEndpoint {
	readonly kind: 'naif'
	// NAIF integer body code.
	readonly id: number
	// Optional display name.
	readonly name?: string
}

// A caller-defined point or body identifier; name is descriptive metadata.
export interface CustomEphemerisEndpoint {
	readonly kind: 'custom'
	// Stable identifier within the caller's naming scheme.
	readonly id: string
	// Optional display name.
	readonly name?: string
}

// Distinguishes NAIF body codes from caller-defined identifiers.
export type EphemerisEndpoint = NaifEphemerisEndpoint | CustomEphemerisEndpoint

// A prepared synchronous state provider from center to target. The provider's
// vectors are in AU and AU/day and are borrowed/read-only. A later call may overwrite
// them; independent providers must not share mutable output storage.
export interface EphemerisPath {
	// Origin of the returned position and velocity.
	readonly center: EphemerisEndpoint
	// Body or point represented by the returned state.
	readonly target: EphemerisEndpoint
	// Samples a state at the given time in library-base axes.
	readonly stateAt: PositionAndVelocityOverTime
}

// Solar-system barycenter, the required origin for retarded observation paths.
export const SOLAR_SYSTEM_BARYCENTER: NaifEphemerisEndpoint = { kind: 'naif', id: Naif.SSB, name: 'Solar System Barycenter' }

// Creates a NAIF endpoint with optional display metadata.
export function naifEphemerisEndpoint(id: number, name?: string): NaifEphemerisEndpoint {
	return { kind: 'naif', id, name }
}

// Creates a caller-defined endpoint with optional display metadata.
export function customEphemerisEndpoint(id: string, name?: string): CustomEphemerisEndpoint {
	return { kind: 'custom', id, name }
}

// Compares endpoint kind and identifier; display names do not affect identity.
export function sameEphemerisEndpoint(a: EphemerisEndpoint, b: EphemerisEndpoint): boolean {
	return a.kind === b.kind && a.id === b.id
}

// Associates a prepared synchronous provider with its physical endpoints.
// The provider and endpoint objects are retained as supplied.
export function ephemerisPath(center: EphemerisEndpoint, target: EphemerisEndpoint, stateAt: PositionAndVelocityOverTime): EphemerisPath {
	return { center, target, stateAt }
}

// Reverses a center-to-target path without mutating the source provider. The returned
// path reuses scratch (or an allocated workspace), which must not alias source storage.
// A later evaluation may overwrite its state; retain it with ephemerisAt() or a copy.
export function reverseEphemerisPath(path: EphemerisPath, scratch?: PositionAndVelocityMut): EphemerisPath {
	scratch ??= zeroPositionAndVelocity()
	return ephemerisPath(path.target, path.center, (time) => {
		const pv = path.stateAt(time)
		vecNegate(pv[0], scratch[0])
		vecNegate(pv[1], scratch[1])
		return scratch
	})
}

// Adds first center->middle and second middle->target at the same epoch.
// Throws for mismatched endpoints, which would yield plausible but invalid geometry.
// Neither source is mutated. The returned path reuses scratch (or an allocated workspace),
// which must not alias source storage. Retain a state with ephemerisAt() or a copy.
export function composeEphemerisPaths(first: EphemerisPath, second: EphemerisPath, scratch?: PositionAndVelocityMut): EphemerisPath {
	if (!sameEphemerisEndpoint(first.target, second.center)) throw new Error('cannot compose ephemeris paths: first target does not match second center')
	scratch ??= zeroPositionAndVelocity()
	return ephemerisPath(first.center, second.target, (time) => {
		const pva = first.stateAt(time)
		const pvb = second.stateAt(time)
		vecPlus(pva[0], pvb[0], scratch[0])
		vecPlus(pva[1], pvb[1], scratch[1])
		return scratch
	})
}

// Forms origin.target -> target.target from two paths sharing one center.
// Both states are sampled at the same epoch; no light-time correction is applied.
// Source storage is not mutated. The returned path reuses scratch (or an allocated
// workspace), which must not alias either source. Retain it with ephemerisAt() or a copy.
export function relativeEphemerisPath(target: EphemerisPath, origin: EphemerisPath, scratch?: PositionAndVelocityMut): EphemerisPath {
	if (!sameEphemerisEndpoint(target.center, origin.center)) throw new Error('cannot form relative ephemeris path: centers do not match')
	scratch ??= zeroPositionAndVelocity()
	return composeEphemerisPaths(reverseEphemerisPath(origin, scratch), target, scratch)
}
