import { AU_KM } from '../../core/constants'
import { type Vec3, vecClone, vecPlus } from '../../math/linear-algebra/vec3'
import type { Time } from '../time/time'
import { Naif } from './kernels/naif'
import type { SpkKernelSet, SpkMissReason } from './kernels/spk.kernelset'
import { callisto, europa, ganymede, io } from './models/analytical/l12'
import { earth, jupiter, sun } from './models/analytical/vsop87e'

// One coherent source of the barycentric positions needed to predict Jovian phenomena: the Sun, the
// Earth, Jupiter's centre (NAIF 599, never its system barycenter 5) and the four Galilean satellites.
// A computation takes every state from one source, so analytical and kernel positions are never mixed
// in one phenomenon or scan. The analytical source adds the L1.2 jovicentric satellite offsets to the
// VSOP87E planet; the SPK source resolves each body through a prepared kernel set and throws a
// JovianEphemerisMiss when any state is unavailable, letting the caller abandon and rerun the whole
// computation. Positions are AU in ICRF/J2000 axes with a barycentric origin; every call returns a
// freshly allocated vector.

// A Galilean satellite of Jupiter.
export type GalileanMoon = 'io' | 'europa' | 'ganymede' | 'callisto'

// A body of the Jovian prediction system.
export type JovianBody = 'sun' | 'earth' | 'jupiter' | GalileanMoon

// The Galilean satellites in orbital order.
export const GALILEAN_MOONS: readonly GalileanMoon[] = ['io', 'europa', 'ganymede', 'callisto']

// Every body a Jovian computation evaluates, in a stable order.
export const JOVIAN_BODIES: readonly JovianBody[] = ['sun', 'earth', 'jupiter', 'io', 'europa', 'ganymede', 'callisto']

// NAIF code of each Jovian body: the Sun 10, the Earth 399, Jupiter's centre 599, and the satellites 501-504.
export const JOVIAN_NAIF: Readonly<Record<JovianBody, number>> = {
	sun: Naif.SUN,
	earth: Naif.EARTH,
	jupiter: Naif.JUPITER,
	io: Naif.IO,
	europa: Naif.EUROPA,
	ganymede: Naif.GANYMEDE,
	callisto: Naif.CALLISTO,
}

// Mean physical radius of each Galilean satellite in km (IAU WGCCRE 2015 / JPL mean values): Io 1821.6,
// Europa 1560.8, Ganymede 2631.2, Callisto 2410.3. The satellites are modeled as spheres.
export const GALILEAN_RADIUS_KM: Readonly<Record<GalileanMoon, number>> = {
	io: 1821.6,
	europa: 1560.8,
	ganymede: 2631.2,
	callisto: 2410.3,
}

// Mean physical radius of each Galilean satellite in AU (GALILEAN_RADIUS_KM / AU_KM).
export const GALILEAN_RADIUS_AU: Readonly<Record<GalileanMoon, number>> = {
	io: GALILEAN_RADIUS_KM.io / AU_KM,
	europa: GALILEAN_RADIUS_KM.europa / AU_KM,
	ganymede: GALILEAN_RADIUS_KM.ganymede / AU_KM,
	callisto: GALILEAN_RADIUS_KM.callisto / AU_KM,
}

// The analytical theories behind the analytical source.
export interface AnalyticalJovianSource {
	readonly kind: 'analytical'
	// Planetary theory of the Sun, the Earth and Jupiter.
	readonly planetary: 'VSOP87E'
	// Satellite theory of the Galilean moons, relative to Jupiter's centre.
	readonly satellites: 'L1.2'
}

// The kernel set behind the SPK source.
export interface SpkJovianSource {
	readonly kind: 'spk'
	// Identifiers of the files of the kernel set in load order, lowest precedence first.
	readonly kernels: readonly string[]
}

// Provenance of a Jovian ephemeris.
export type JovianSource = AnalyticalJovianSource | SpkJovianSource

// A coherent source of Jovian positions.
export interface JovianEphemeris {
	// Where the positions come from.
	readonly source: JovianSource
	// Barycentric position of `body` at `time` (any time scale), in AU and ICRF axes, freshly allocated.
	// An SPK source throws a JovianEphemerisMiss when the state cannot be resolved.
	readonly position: (body: JovianBody, time: Time) => Vec3
}

// A Jovian ephemeris backed by a kernel set, which also records the files that supplied each body.
export interface SpkJovianEphemeris extends JovianEphemeris {
	readonly source: SpkJovianSource
	// Identifiers of the files whose segments formed each body's chain in the states evaluated so far,
	// accumulated as positions are requested. A body never evaluated is absent.
	readonly kernelsByBody: ReadonlyMap<JovianBody, ReadonlySet<string>>
}

// Thrown by an SPK source when a body state cannot be resolved, so the caller can abandon the whole
// computation instead of mixing sources.
export class JovianEphemerisMiss extends Error {
	// The Jovian body that was requested.
	readonly target: JovianBody
	// NAIF code of the body of the chain where resolution stopped: the target itself or one of its centers.
	readonly body: number
	// Why resolution stopped.
	readonly reason: SpkMissReason
	// The epoch that could not be resolved.
	readonly time: Time

	constructor(target: JovianBody, body: number, reason: SpkMissReason, time: Time) {
		super(`the state of ${target} is unavailable from the SPK kernels (${reason} at NAIF ${body})`)
		this.name = 'JovianEphemerisMiss'
		this.target = target
		this.body = body
		this.reason = reason
		this.time = time
	}
}

// Provenance of the analytical source.
const ANALYTICAL_SOURCE: AnalyticalJovianSource = { kind: 'analytical', planetary: 'VSOP87E', satellites: 'L1.2' }

// The analytical Jovian ephemeris: VSOP87E for the Sun, the Earth and Jupiter's centre, and the L1.2
// jovicentric offsets added to the VSOP87E Jupiter for the satellites. Never throws.
export const analyticalJovianEphemeris: JovianEphemeris = {
	source: ANALYTICAL_SOURCE,
	position: analyticalPosition,
}

// Barycentric position of a Jovian body from VSOP87E and L1.2 (AU, ICRF), freshly allocated.
function analyticalPosition(body: JovianBody, time: Time): Vec3 {
	switch (body) {
		case 'sun':
			return vecClone(sun(time)[0])
		case 'earth':
			return vecClone(earth(time)[0])
		case 'jupiter':
			return vecClone(jupiter(time)[0])
		case 'io':
			return vecPlus(jupiter(time)[0], io(time)[0])
		case 'europa':
			return vecPlus(jupiter(time)[0], europa(time)[0])
		case 'ganymede':
			return vecPlus(jupiter(time)[0], ganymede(time)[0])
		case 'callisto':
			return vecPlus(jupiter(time)[0], callisto(time)[0])
	}
}

// Builds a Jovian ephemeris over a prepared kernel set. Each position resolves the body's NAIF code
// (599 for Jupiter, never the barycenter) through the set with its precedence rules; any miss throws a
// JovianEphemerisMiss. The set must stay open while the ephemeris is used, so evaluate it synchronously
// and do not keep it across an asynchronous yield that could close the kernel sources.
export function spkJovianEphemeris(set: SpkKernelSet): SpkJovianEphemeris {
	const kernelsByBody = new Map<JovianBody, Set<string>>()

	function position(body: JovianBody, time: Time): Vec3 {
		const result = set.stateAt(JOVIAN_NAIF[body], time)
		if (!result.ok) throw new JovianEphemerisMiss(body, result.body, result.reason, time)

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

// Whether a kernel set has a segment for every Jovian body. This is a necessary condition only: the
// centers, coverage and segment support are resolved per epoch by stateAt.
export function hasJovianTargets(set: SpkKernelSet): boolean {
	for (const body of JOVIAN_BODIES) if (!set.bodies.has(JOVIAN_NAIF[body])) return false
	return true
}
