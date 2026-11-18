import { J2000 } from '../../core/constants'
import type { MutMat3 } from '../../math/linear-algebra/mat3'
import type { Angle } from '../../math/units/angle'
import { eraFw2m, eraNut06a, eraPfw06 } from '../coordinates/erfa/erfa'
import type { Time, TimeProviders } from './time'

// Interpolated IAU 2006/2000A nutation providers for Time. The full nutation series (about 1400 terms) dominates the
// cost of the precession-nutation matrix, the apparent sidereal time, and the GCRS->CIRS/ITRS rotations, while the
// angles themselves vary smoothly: the shortest terms of significant amplitude have periods of days. These providers
// evaluate the series only on a fixed TT grid anchored at J2000 and interpolate between nodes with a Catmull-Rom
// cubic; the IAU 2006 precession (Fukushima-Williams angles) is still evaluated exactly per instant. Results depend
// only on the instant, never on the order of the calls or on what the node cache holds. The node cache is bounded
// and evicts its oldest node first. Angles in radians, times in TT days.

// Default spacing of the nutation nodes, in days. A power of two keeps every node instant exact in binary; at a
// quarter day the interpolated angles stay within about 0.01 mas of the full series.
export const DEFAULT_INTERPOLATED_NUTATION_STEP = 0.25

// Default maximum number of cached nodes: 16384 nodes cover about 11 years of contiguous instants at the default
// step, in roughly 1 MiB.
export const DEFAULT_INTERPOLATED_NUTATION_CAPACITY = 16384

// Options of interpolatedNutationProviders.
export interface InterpolatedNutationOptions {
	// Spacing of the nutation nodes, in days; positive. Larger is cheaper for sparse instants and less accurate.
	readonly step?: number
	// Maximum number of cached nodes; at least 4, the nodes a single instant needs.
	readonly capacity?: number
}

// Nutation and precession-nutation providers backed by a node cache, assignable to TIME_PROVIDERS or a Time's providers.
export interface InterpolatedNutationProviders extends Required<Pick<TimeProviders, 'nut' | 'pnm'>> {
	// Drops every cached node; later calls evaluate them again and return the same values.
	readonly clear: () => void
}

// Creates nutation (Δψ, Δε) and precession-nutation matrix providers that interpolate the IAU 2006/2000A nutation
// sampled every step TT days, keeping at most capacity nodes. Every instant reads four nodes, so the first instant of
// a region costs about four full series evaluations and the following ones in the same region almost nothing; for
// isolated instants spread over years, the exact default providers are cheaper. The returned matrices are fresh.
export function interpolatedNutationProviders({ step = DEFAULT_INTERPOLATED_NUTATION_STEP, capacity = DEFAULT_INTERPOLATED_NUTATION_CAPACITY }: InterpolatedNutationOptions = {}): InterpolatedNutationProviders {
	const nodes = new Map<number, readonly [Angle, Angle]>()

	// Nutation angles at the TT instant J2000 + index * step, cached.
	function node(index: number) {
		let value = nodes.get(index)

		if (value === undefined) {
			value = eraNut06a(J2000, index * step)

			if (nodes.size >= capacity) {
				const oldest = nodes.keys().next()
				if (!oldest.done) nodes.delete(oldest.value)
			}

			nodes.set(index, value)
		}

		return value
	}

	// Nutation in longitude and obliquity, in radians, at a TT instant.
	function nut(time: Time): [Angle, Angle] {
		const x = (time.day - J2000 + time.fraction) / step
		const index = Math.floor(x)
		const u = x - index
		const a = node(index - 1)
		const b = node(index)
		const c = node(index + 1)
		const d = node(index + 2)
		return [catmullRom(a[0], b[0], c[0], d[0], u), catmullRom(a[1], b[1], c[1], d[1], u)]
	}

	// Bias-precession-nutation matrix at a TT instant, as eraPnm06a with the interpolated nutation.
	function pnm(time: Time): MutMat3 {
		const [gamb, phib, psib, epsa] = eraPfw06(time.day, time.fraction)
		const [dpsi, deps] = nut(time)
		return eraFw2m(gamb, phib, psib + dpsi, epsa + deps)
	}

	return { nut, pnm, clear: () => nodes.clear() }
}

// Catmull-Rom cubic through four equally spaced samples a, b, c, d at the fraction u in [0, 1) between b and c.
function catmullRom(a: number, b: number, c: number, d: number, u: number) {
	return b + 0.5 * u * (c - a + u * (2 * a - 5 * b + 4 * c - d + u * (3 * (b - c) + d - a)))
}
