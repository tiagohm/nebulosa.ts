import { J2000 } from '../../core/constants'
import { type MutVec3, type Vec3, vecClone } from '../../math/linear-algebra/vec3'
import { type Time, Timescale, tdb, timeShift } from '../time/time'
import type { SpkKernelSet, SpkMissReason } from './kernels/spk.kernelset'

// Planet-agnostic machinery of a coherent satellite-system ephemeris: the barycentric positions of the
// Sun, the Earth, a planet's centre and its major satellites, all from one source so analytical and
// kernel states are never mixed in one computation. A SatelliteSystem describes the bodies, their NAIF
// codes and interpolation node spacing; the SPK source resolves each body through a prepared kernel
// set and throws the system's SatelliteEphemerisMiss when a state is unavailable, letting the caller abandon and
// rerun the whole computation; the interpolated source caches positions on a fixed TDB grid for dense
// searches. Positions are AU in ICRF/J2000 axes with a barycentric origin; every call returns a freshly
// allocated vector. The Jovian and Saturnian ephemerides are instances of this machinery.

// The bodies of a planetary satellite system and how to evaluate and interpolate them.
export interface SatelliteSystem<B extends string, M extends B> {
	// The key of the planet's centre (its body, never its system barycenter).
	readonly planet: B
	// Every body of the system, in a stable order; includes the Sun, the Earth, the planet and the moons.
	readonly bodies: readonly B[]
	// The satellites, in orbital order; a subset of bodies.
	readonly moons: readonly M[]
	// NAIF code of each body.
	readonly naif: Readonly<Record<B, number>>
	// Spacing in days of the interpolation nodes of each body, chosen so the six-point Lagrange error
	// stays below 0.1 km over the body's motion.
	readonly nodeStep: Readonly<Record<B, number>>
	// Builds the error an SPK source throws when a body state cannot be resolved; a subclass of
	// SatelliteEphemerisMiss named after the system, so callers can tell the systems apart.
	readonly miss: (target: B, body: number, reason: SpkMissReason, time: Time) => SatelliteEphemerisMiss<B>
}

// The kernel set behind an SPK source.
export interface SpkSatelliteSource {
	readonly kind: 'spk'
	// Identifiers of the files of the kernel set in load order, lowest precedence first.
	readonly kernels: readonly string[]
}

// A coherent source of the positions of a satellite system.
export interface SatelliteEphemeris<B extends string, M extends B, S> {
	// Where the positions come from.
	readonly source: S
	// Barycentric position of `body` at `time` (any time scale), in AU and ICRF axes, freshly allocated.
	// An SPK source throws a SatelliteEphemerisMiss when the state cannot be resolved.
	readonly position: (body: B, time: Time) => Vec3
	// Position of a moon relative to the planet's centre (AU, ICRF), freshly allocated, for a source whose
	// satellite theory is planetocentric. Consistent with position: position(moon) = position(planet) +
	// planetocentric(moon) at the same epoch. Absent when the source only gives barycentric states.
	readonly planetocentric?: (moon: M, time: Time) => Vec3
}

// A satellite-system ephemeris backed by a kernel set, which also records the files that supplied each body.
export interface SpkSatelliteEphemeris<B extends string, M extends B> extends SatelliteEphemeris<B, M, SpkSatelliteSource> {
	// Identifiers of the files whose segments formed each body's chain in the states evaluated so far,
	// accumulated as positions are requested. A body never evaluated is absent.
	readonly kernelsByBody: ReadonlyMap<B, ReadonlySet<string>>
}

// Thrown by an SPK source when a body state cannot be resolved, so the caller can abandon the whole
// computation instead of mixing sources.
export class SatelliteEphemerisMiss<B extends string = string> extends Error {
	// The body that was requested.
	readonly target: B
	// NAIF code of the body of the chain where resolution stopped: the target itself or one of its centers.
	readonly body: number
	// Why resolution stopped.
	readonly reason: SpkMissReason
	// The epoch that could not be resolved.
	readonly time: Time

	constructor(target: B, body: number, reason: SpkMissReason, time: Time) {
		super(`the state of ${target} is unavailable from the SPK kernels (${reason} at NAIF ${body})`)
		this.name = 'SatelliteEphemerisMiss'
		this.target = target
		this.body = body
		this.reason = reason
		this.time = time
	}
}

// Builds a satellite-system ephemeris over a prepared kernel set. Each position resolves the body's NAIF
// code through the set with its precedence rules; any miss throws the system's SatelliteEphemerisMiss. The set must
// stay open while the ephemeris is used, so evaluate it synchronously and do not keep it across an
// asynchronous yield that could close the kernel sources.
export function spkSatelliteEphemeris<B extends string, M extends B>(system: SatelliteSystem<B, M>, set: SpkKernelSet): SpkSatelliteEphemeris<B, M> {
	const kernelsByBody = new Map<B, Set<string>>()

	function position(body: B, time: Time): Vec3 {
		const result = set.stateAt(system.naif[body], time)
		if (!result.ok) throw system.miss(body, result.body, result.reason, time)

		let kernels = kernelsByBody.get(body)

		if (kernels === undefined) {
			kernels = new Set()
			kernelsByBody.set(body, kernels)
		}

		for (const kernel of result.kernels) kernels.add(kernel)

		return vecClone(result.state[0])
	}

	return { source: { kind: 'spk', kernels: set.kernels }, position, kernelsByBody }
}

// J2000.0 in TDB, the origin of the interpolation nodes.
const J2000_TDB: Time = { day: J2000, fraction: 0, scale: Timescale.TDB }

// Number of nodes of the Lagrange interpolation, centred on the interval holding the epoch.
const INTERPOLATION_NODES = 6

// Builds an ephemeris that interpolates `source` instead of evaluating it at every epoch, for searches
// that sample thousands of nearby epochs. Positions are evaluated at nodes on a fixed TDB grid anchored
// at J2000 with the system's per-body spacing, and interpolated with a six-point Lagrange polynomial
// centred on the epoch's interval. When the source is planetocentric for the satellites, the
// planetocentric offsets are interpolated and added to the interpolated planet, so a node costs one
// satellite-theory evaluation instead of a planetary one. The source provenance is kept, and a node the
// source cannot evaluate propagates its error, so a kernel-backed source still throws a
// SatelliteEphemerisMiss, possibly for a node up to three node steps beyond the epoch. Evaluated nodes are
// cached for the lifetime of the returned ephemeris, so create one per computation; the cache grows with
// the span evaluated (one node per body per node step).
export function interpolatedSatelliteEphemeris<B extends string, M extends B, S>(system: SatelliteSystem<B, M>, source: SatelliteEphemeris<B, M, S>): SatelliteEphemeris<B, M, S> {
	const nodes = new Map<B, Map<number, Vec3>>()
	for (const body of system.bodies) nodes.set(body, new Map())

	const moons = new Set<B>(system.moons)
	const planetocentric = source.planetocentric

	// Whether a body is interpolated relative to the planet: a satellite of a planetocentric source.
	function relative(body: B): body is M {
		return planetocentric !== undefined && moons.has(body)
	}

	// Node position of a body: barycentric, or planetocentric for a satellite of a planetocentric source.
	function node(body: B, index: number): Vec3 {
		const cache = nodes.get(body)!
		let position = cache.get(index)

		if (position === undefined) {
			const time = timeShift(J2000_TDB, index * system.nodeStep[body])
			position = relative(body) ? planetocentric!(body, time) : source.position(body, time)
			cache.set(index, position)
		}

		return position
	}

	// Interpolated node position of a body at a time, in the frame of its nodes.
	function interpolate(body: B, time: Time): MutVec3 {
		const t = tdb(time)
		const step = system.nodeStep[body]
		const x = (t.day - J2000 + t.fraction) / step
		const base = Math.floor(x)
		const u = x - base
		const first = base - INTERPOLATION_NODES / 2 + 1
		const out: MutVec3 = [0, 0, 0]

		for (let j = 0; j < INTERPOLATION_NODES; j++) {
			// Lagrange weight of node j over the nodes first..first+5, at the offset u of the epoch from node base.
			const nj = j - INTERPOLATION_NODES / 2 + 1
			let weight = 1

			for (let k = 0; k < INTERPOLATION_NODES; k++) {
				if (k === j) continue
				const nk = k - INTERPOLATION_NODES / 2 + 1
				weight *= (u - nk) / (nj - nk)
			}

			const p = node(body, first + j)
			out[0] += weight * p[0]
			out[1] += weight * p[1]
			out[2] += weight * p[2]
		}

		return out
	}

	function position(body: B, time: Time): Vec3 {
		const out = interpolate(body, time)
		if (!relative(body)) return out
		const planet = interpolate(system.planet, time)
		out[0] += planet[0]
		out[1] += planet[1]
		out[2] += planet[2]
		return out
	}

	return { source: source.source, position }
}

// Whether a kernel set has a segment for every body of `bodies` (by default every body of the system).
// This is a necessary condition only: the centers, coverage and segment support are resolved per epoch
// by stateAt.
export function hasSatelliteTargets<B extends string, M extends B>(system: SatelliteSystem<B, M>, set: SpkKernelSet, bodies: readonly B[] = system.bodies): boolean {
	for (const body of bodies) if (!set.bodies.has(system.naif[body])) return false
	return true
}
