import type { Vec3 } from '../../math/linear-algebra/vec3'
import type { Time } from '../time/time'
import { defaultEphemerisNodeStep, type EphemerisSource, interpolatedEphemerisSource, type SpkEphemerisSource } from './source'

// Planet-agnostic machinery of a coherent satellite-system ephemeris: the barycentric positions of the
// Sun, the Earth, a planet's centre and its major satellites, all from one EphemerisSource so analytical
// and kernel states are never mixed in one computation. A SatelliteSystem describes the bodies, their NAIF
// codes and interpolation node spacing; a source that cannot give a state throws EphemerisMiss, letting the
// caller abandon and rerun the whole computation, and an interpolated system caches positions on a fixed
// TDB grid for dense searches. Positions are AU in ICRF/J2000 axes with a barycentric origin; every call
// returns a freshly allocated vector. The Jovian and Saturnian ephemerides are instances of this machinery.

// The bodies of a planetary satellite system and how to interpolate them.
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
	// Throws EphemerisMiss when the source cannot give the state.
	readonly position: (body: B, time: Time) => Vec3
	// Position of a moon relative to the planet's centre (AU, ICRF), freshly allocated, for a source whose
	// satellite theory is planetocentric. Consistent with position: position(moon) = position(planet) +
	// planetocentric(moon) at the same epoch. Absent when the source only gives barycentric states.
	readonly planetocentric?: (moon: M, time: Time) => Vec3
	// For an SPK source, the identifiers of the files whose segments formed each body's chain in the states
	// evaluated so far, accumulated as positions are requested; a body never evaluated is absent.
	readonly kernelsByBody?: ReadonlyMap<B, ReadonlySet<string>>
}

// Whether a source reads a kernel set.
function isSpkSource(source: EphemerisSource): source is SpkEphemerisSource {
	return source.kind === 'spk' && 'kernelsByBody' in source
}

// Builds a satellite-system ephemeris over a source: each position is the source's barycentric state of the
// body's NAIF code, and the planetocentric offsets are given when the source computes the moons relative to
// the planet's centre. The provenance is the kernel set for an SPK source, else `analytical`, the theories the
// analytical source uses for the system. A kernel-backed source must stay open while the ephemeris is used.
export function satelliteEphemeris<B extends string, M extends B, A>(system: SatelliteSystem<B, M>, source: EphemerisSource, analytical: A): SatelliteEphemeris<B, M, A | SpkSatelliteSource> {
	const { naif } = system
	const planet = naif[system.planet]
	const position = (body: B, time: Time) => source.state(naif[body], time)[0]
	const relative = source.relativeState
	const planetocentric = relative !== undefined && system.moons.every((moon) => source.centerOf?.(naif[moon]) === planet) ? (moon: M, time: Time) => relative(naif[moon], time)[0] : undefined

	if (!isSpkSource(source)) return { source: analytical, position, ...(planetocentric && { planetocentric }) }

	const byNaif = source.kernelsByBody
	const kernelsByBody = new Map<B, ReadonlySet<string>>()

	// The position of a body, recording the source's live set of the files it used for the body's NAIF code.
	const recorded = (body: B, time: Time) => {
		const p = position(body, time)

		if (!kernelsByBody.has(body)) {
			const kernels = byNaif.get(naif[body])
			if (kernels !== undefined) kernelsByBody.set(body, kernels)
		}

		return p
	}

	return { source: { kind: 'spk', kernels: source.kernels }, position: recorded, ...(planetocentric && { planetocentric }), kernelsByBody }
}

// Builds a satellite-system ephemeris that interpolates `source` instead of evaluating it at every epoch, for
// searches that sample thousands of nearby epochs: the source interpolated with interpolatedEphemerisSource
// at the system's node spacing (other bodies at defaultEphemerisNodeStep), then satelliteEphemeris. Create one
// per computation: its nodes are cached for its lifetime.
export function interpolatedSatelliteEphemeris<B extends string, M extends B, A>(system: SatelliteSystem<B, M>, source: EphemerisSource, analytical: A): SatelliteEphemeris<B, M, A | SpkSatelliteSource> {
	const steps = new Map<number, number>()
	for (const body of system.bodies) steps.set(system.naif[body], system.nodeStep[body])
	return satelliteEphemeris(
		system,
		interpolatedEphemerisSource(source, (naif) => steps.get(naif) ?? defaultEphemerisNodeStep(naif)),
		analytical,
	)
}

// Whether a source has every body of `bodies` (by default every body of the system). This is a necessary
// condition only: the centers, coverage and segment support are resolved per epoch.
export function hasSatelliteTargets<B extends string, M extends B>(system: SatelliteSystem<B, M>, source: EphemerisSource, bodies: readonly B[] = system.bodies): boolean {
	for (const body of bodies) if (!source.has(system.naif[body])) return false
	return true
}
