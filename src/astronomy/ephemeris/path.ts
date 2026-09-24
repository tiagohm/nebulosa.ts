import { vecNegateMut, vecPlus } from '../../math/linear-algebra/vec3'
import type { PositionAndVelocityOverTime } from '../coordinates/astrometry'
import { Naif } from './kernels/naif'

// Synchronous center-to-target ephemeris paths in library-base ICRS/BCRS-oriented axes.
// Positions are AU and velocities AU/day. Providers may reuse storage; composed paths
// snapshot each input before sampling another provider and return owned vectors.

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
// vectors are in AU and AU/day; callers must not assume it returns owned storage.
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

// Reverses a center-to-target path. Each evaluation returns fresh position and
// velocity vectors, even when the underlying provider reuses its storage.
export function reverseEphemerisPath(path: EphemerisPath): EphemerisPath {
	return ephemerisPath(path.target, path.center, (time) => {
		const pv = path.stateAt(time)
		vecNegateMut(pv[0])
		vecNegateMut(pv[1])
		return pv
	})
}

// Adds first center->middle and second middle->target at the same epoch.
// Throws for mismatched endpoints, which would yield plausible but invalid geometry.
// Snapshots the first state before calling the second provider, then returns owned vectors.
export function composeEphemerisPaths(first: EphemerisPath, second: EphemerisPath): EphemerisPath {
	if (!sameEphemerisEndpoint(first.target, second.center)) throw new Error('cannot compose ephemeris paths: first target does not match second center')
	return ephemerisPath(first.center, second.target, (time) => {
		const pva = first.stateAt(time)
		const pvb = second.stateAt(time)
		vecPlus(pva[0], pvb[0], pva[0])
		vecPlus(pva[1], pvb[1], pva[1])
		return pva
	})
}

// Forms origin.target -> target.target from two paths sharing one center.
// Both states are sampled at the same epoch; no light-time correction is applied.
export function relativeEphemerisPath(target: EphemerisPath, origin: EphemerisPath): EphemerisPath {
	if (!sameEphemerisEndpoint(target.center, origin.center)) throw new Error('cannot form relative ephemeris path: centers do not match')
	return composeEphemerisPaths(reverseEphemerisPath(origin), target)
}
