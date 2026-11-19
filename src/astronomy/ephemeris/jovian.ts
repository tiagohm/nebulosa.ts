import { AU_KM } from '../../core/constants'
import { Naif } from './kernels/naif'
import { hasSatelliteTargets, interpolatedSatelliteEphemeris, type SatelliteEphemeris, satelliteEphemeris, type SatelliteSystem, type SpkSatelliteSource } from './satellites'
import type { EphemerisSource } from './source'

// One coherent source of the barycentric positions needed to predict Jovian phenomena: the Sun, the
// Earth, Jupiter's centre (NAIF 599, never its system barycenter 5) and the four Galilean satellites, all
// from one EphemerisSource, so analytical and kernel positions are never mixed in one phenomenon or scan.
// With the analytical source the satellites are the L1.2 jovicentric offsets added to the VSOP87E planet;
// with SPK kernels each body resolves through the prepared kernel set, and a state the source cannot give
// throws EphemerisMiss, letting the caller abandon and rerun the whole computation. Positions are AU in
// ICRF/J2000 axes with a barycentric origin; every call returns a freshly allocated vector. Dense searches
// use interpolatedJovianEphemeris, which caches positions on a fixed grid and interpolates between them. The
// machinery is the generic satellite-system ephemeris of satellites.ts instantiated with JOVIAN_SYSTEM.

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

// Node spacing in days of the interpolated Sun, Earth and Jupiter. Their sixth position derivatives
// (the Earth's lunar wobble dominates) keep the six-point interpolation error at a few tens of metres.
const PLANETARY_NODE_STEP = 1

// Node spacing in days of the interpolated Galilean satellites: one hour. Io's sixth position derivative
// (~8e8 km/day⁶) bounds the six-point interpolation error at a few tens of metres.
const SATELLITE_NODE_STEP = 1 / 24

// The Jovian satellite system: bodies, NAIF codes and interpolation node spacing.
export const JOVIAN_SYSTEM: SatelliteSystem<JovianBody, GalileanMoon> = {
	planet: 'jupiter',
	bodies: JOVIAN_BODIES,
	moons: GALILEAN_MOONS,
	naif: JOVIAN_NAIF,
	nodeStep: {
		sun: PLANETARY_NODE_STEP,
		earth: PLANETARY_NODE_STEP,
		jupiter: PLANETARY_NODE_STEP,
		io: SATELLITE_NODE_STEP,
		europa: SATELLITE_NODE_STEP,
		ganymede: SATELLITE_NODE_STEP,
		callisto: SATELLITE_NODE_STEP,
	},
}

// The analytical theories the analytical source uses for the Jovian system.
export interface AnalyticalJovianSource {
	readonly kind: 'analytical'
	// Planetary theory of the Sun, the Earth and Jupiter.
	readonly planetary: 'VSOP87E'
	// Satellite theory of the Galilean moons, relative to Jupiter's centre.
	readonly satellites: 'L1.2'
}

// The kernel set behind the SPK source.
export type SpkJovianSource = SpkSatelliteSource

// Provenance of a Jovian ephemeris.
export type JovianSource = AnalyticalJovianSource | SpkJovianSource

// A coherent source of Jovian positions. The optional planetocentric offsets are jovicentric.
export type JovianEphemeris = SatelliteEphemeris<JovianBody, GalileanMoon, JovianSource>

// Provenance of the analytical source.
const ANALYTICAL_SOURCE: AnalyticalJovianSource = { kind: 'analytical', planetary: 'VSOP87E', satellites: 'L1.2' }

// Builds a Jovian ephemeris over a source: each position is the source's state of the body's NAIF code (599 for
// Jupiter, never the barycenter), and a state the source cannot give throws EphemerisMiss. The provenance is the
// kernel set of an SPK source, else the VSOP87E and L1.2 theories. A kernel-backed source must stay open while
// the ephemeris is used, so evaluate it synchronously and do not keep it across an asynchronous yield that could
// close the kernel sources.
export function jovianEphemeris(source: EphemerisSource): JovianEphemeris {
	return satelliteEphemeris(JOVIAN_SYSTEM, source, ANALYTICAL_SOURCE)
}

// Builds a Jovian ephemeris that interpolates `source` instead of evaluating it at every epoch, for searches that
// sample thousands of nearby epochs. Nodes are one day apart for the Sun, the Earth and Jupiter and one hour apart
// for the satellites; the error stays below 0.1 km (Io and the Earth's lunar wobble dominate), far below the
// precision of the theories and a fraction of a second of contact time. See interpolatedEphemerisSource for the
// caching and miss behavior.
export function interpolatedJovianEphemeris(source: EphemerisSource): JovianEphemeris {
	return interpolatedSatelliteEphemeris(JOVIAN_SYSTEM, source, ANALYTICAL_SOURCE)
}

// Whether a source has every Jovian body. This is a necessary condition only: the centers, coverage and segment
// support are resolved per epoch.
export function hasJovianTargets(source: EphemerisSource): boolean {
	return hasSatelliteTargets(JOVIAN_SYSTEM, source)
}
