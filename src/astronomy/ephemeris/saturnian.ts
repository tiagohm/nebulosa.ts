import { AU_KM } from '../../core/constants'
import { Naif } from './kernels/naif'
import { hasSatelliteTargets, interpolatedSatelliteEphemeris, type SatelliteEphemeris, satelliteEphemeris, type SatelliteSystem, type SpkSatelliteSource } from './satellites'
import type { EphemerisSource } from './source'

// One coherent source of the barycentric positions needed to predict Saturnian geometry and phenomena:
// the Sun, the Earth, Saturn's centre (NAIF 699, never its system barycenter 6) and its seven major
// satellites Mimas to Iapetus (Hyperion is omitted), all from one EphemerisSource, so analytical and kernel
// positions are never mixed. With the analytical source the satellites are the TASS 1.7 Saturnicentric offsets
// (J2000 equatorial axes, the same axes as VSOP87E's ICRF output, so they are not rotated again) added to the
// VSOP87E Saturn at the same instant; with SPK kernels each body resolves through the prepared kernel set,
// chaining through barycenter 6 when the kernels do, and a state the source cannot give throws EphemerisMiss. A
// ring-only computation evaluates SATURNIAN_RING_BODIES alone, so it needs neither a satellite kernel nor the
// satellite theory. Positions are AU in ICRF/J2000 axes with a barycentric origin; every call returns a freshly
// allocated vector. Dense searches use interpolatedSaturnianEphemeris.

// A major Saturnian satellite (Hyperion is omitted: its chaotic rotation and tiny disk make it a poor
// planning target).
export type SaturnianMoon = 'mimas' | 'enceladus' | 'tethys' | 'dione' | 'rhea' | 'titan' | 'iapetus'

// A body of the Saturnian prediction system.
export type SaturnianBody = 'sun' | 'earth' | 'saturn' | SaturnianMoon

// The major Saturnian satellites in orbital order.
export const SATURNIAN_MOONS: readonly SaturnianMoon[] = ['mimas', 'enceladus', 'tethys', 'dione', 'rhea', 'titan', 'iapetus']

// Every body a Saturnian computation may evaluate, in a stable order.
export const SATURNIAN_BODIES: readonly SaturnianBody[] = ['sun', 'earth', 'saturn', ...SATURNIAN_MOONS]

// The bodies a ring-only computation evaluates: the Sun, the Earth and Saturn's centre.
export const SATURNIAN_RING_BODIES: readonly SaturnianBody[] = ['sun', 'earth', 'saturn']

// NAIF code of each Saturnian body: the Sun 10, the Earth 399, Saturn's centre 699, and the satellites
// 601-606 and 608.
export const SATURNIAN_NAIF: Readonly<Record<SaturnianBody, number>> = {
	sun: Naif.SUN,
	earth: Naif.EARTH,
	saturn: Naif.SATURN,
	mimas: Naif.MIMAS,
	enceladus: Naif.ENCELADUS,
	tethys: Naif.TETHYS,
	dione: Naif.DIONE,
	rhea: Naif.RHEA,
	titan: Naif.TITAN,
	iapetus: Naif.IAPETUS,
}

// Mean physical radius of each major Saturnian satellite in km (IAU/JPL mean values): Mimas 198.2,
// Enceladus 252.1, Tethys 531.1, Dione 561.4, Rhea 763.8, Titan 2575 (solid surface), Iapetus 734.5.
// The satellites are modeled as spheres.
export const SATURNIAN_RADIUS_KM: Readonly<Record<SaturnianMoon, number>> = {
	mimas: 198.2,
	enceladus: 252.1,
	tethys: 531.1,
	dione: 561.4,
	rhea: 763.8,
	titan: 2575,
	iapetus: 734.5,
}

// Mean physical radius of each major Saturnian satellite in AU (SATURNIAN_RADIUS_KM / AU_KM).
export const SATURNIAN_RADIUS_AU: Readonly<Record<SaturnianMoon, number>> = {
	mimas: SATURNIAN_RADIUS_KM.mimas / AU_KM,
	enceladus: SATURNIAN_RADIUS_KM.enceladus / AU_KM,
	tethys: SATURNIAN_RADIUS_KM.tethys / AU_KM,
	dione: SATURNIAN_RADIUS_KM.dione / AU_KM,
	rhea: SATURNIAN_RADIUS_KM.rhea / AU_KM,
	titan: SATURNIAN_RADIUS_KM.titan / AU_KM,
	iapetus: SATURNIAN_RADIUS_KM.iapetus / AU_KM,
}

// Node spacing in days of the interpolated Sun, Earth and Saturn, as for the Jovian system: the Earth's
// lunar wobble dominates and keeps the six-point error at a few tens of metres.
const PLANETARY_NODE_STEP = 1

// Node spacing in days of the interpolated Mimas and Enceladus: 30 minutes. Mimas's sixth position
// derivative (a·n⁶ ≈ 185,520 km × (6.67 rad/day)⁶ ≈ 1.6e10 km/day⁶) would give about 0.4 km at one hour;
// at 30 minutes the six-point error is below 0.01 km.
const INNER_SATELLITE_NODE_STEP = 1 / 48

// Node spacing in days of the interpolated Tethys to Iapetus: one hour. Tethys's sixth derivative
// (~4e9 km/day⁶) keeps the six-point error below 0.03 km.
const SATELLITE_NODE_STEP = 1 / 24

// The Saturnian satellite system: bodies, NAIF codes and interpolation node spacing.
export const SATURNIAN_SYSTEM: SatelliteSystem<SaturnianBody, SaturnianMoon> = {
	planet: 'saturn',
	bodies: SATURNIAN_BODIES,
	moons: SATURNIAN_MOONS,
	naif: SATURNIAN_NAIF,
	nodeStep: {
		sun: PLANETARY_NODE_STEP,
		earth: PLANETARY_NODE_STEP,
		saturn: PLANETARY_NODE_STEP,
		mimas: INNER_SATELLITE_NODE_STEP,
		enceladus: INNER_SATELLITE_NODE_STEP,
		tethys: SATELLITE_NODE_STEP,
		dione: SATELLITE_NODE_STEP,
		rhea: SATELLITE_NODE_STEP,
		titan: SATELLITE_NODE_STEP,
		iapetus: SATELLITE_NODE_STEP,
	},
}

// The analytical theories the analytical source uses for the Saturnian system.
export interface AnalyticalSaturnianSource {
	readonly kind: 'analytical'
	// Planetary theory of the Sun, the Earth and Saturn.
	readonly planetary: 'VSOP87E'
	// Satellite theory of the major moons, relative to Saturn's centre.
	readonly satellites: 'TASS1.7'
}

// The kernel set behind the SPK source.
export type SpkSaturnianSource = SpkSatelliteSource

// Provenance of a Saturnian ephemeris.
export type SaturnianSource = AnalyticalSaturnianSource | SpkSaturnianSource

// A coherent source of Saturnian positions. The optional planetocentric offsets are Saturnicentric.
export type SaturnianEphemeris = SatelliteEphemeris<SaturnianBody, SaturnianMoon, SaturnianSource>

// Provenance of the analytical source.
const ANALYTICAL_SOURCE: AnalyticalSaturnianSource = { kind: 'analytical', planetary: 'VSOP87E', satellites: 'TASS1.7' }

// Builds a Saturnian ephemeris over a source: each position is the source's state of the body's NAIF code (699
// for Saturn, never the barycenter), and a state the source cannot give throws EphemerisMiss. The provenance is
// the kernel set of an SPK source, else the VSOP87E and TASS 1.7 theories. A kernel-backed source must stay open
// while the ephemeris is used, so evaluate it synchronously and do not keep it across an asynchronous yield that
// could close the kernel sources.
export function saturnianEphemeris(source: EphemerisSource): SaturnianEphemeris {
	return satelliteEphemeris(SATURNIAN_SYSTEM, source, ANALYTICAL_SOURCE)
}

// Builds a Saturnian ephemeris that interpolates `source` instead of evaluating it at every epoch, for searches
// that sample thousands of nearby epochs. Nodes are one day apart for the Sun, the Earth and Saturn, 30 minutes
// apart for Mimas and Enceladus and one hour apart for the other satellites; the error stays below 0.1 km. See
// interpolatedEphemerisSource for the caching and miss behavior.
export function interpolatedSaturnianEphemeris(source: EphemerisSource): SaturnianEphemeris {
	return interpolatedSatelliteEphemeris(SATURNIAN_SYSTEM, source, ANALYTICAL_SOURCE)
}

// The Saturnian system with coarse interpolation nodes for ring-only computations, which evaluate only the
// Sun, the Earth and Saturn. Ring angles need no kilometre-level positions: 3-day Earth nodes (the lunar
// wobble gives under 10 km), 4-day Saturn nodes (Titan's 16-day reflex wobble of an SPK 699, ~1 km/day⁶,
// gives ~20 km) and 8-day Sun nodes keep the error below 25 km, about 2e-8 rad at Saturn's distance,
// while sampling the theories about four times less often than the moon nodes.
const SATURNIAN_RING_SYSTEM: SatelliteSystem<SaturnianBody, SaturnianMoon> = {
	...SATURNIAN_SYSTEM,
	nodeStep: { ...SATURNIAN_SYSTEM.nodeStep, sun: 8, earth: 3, saturn: 4 },
}

// Builds an interpolating ephemeris for ring-only computations (multi-year ring histories and ring-plane
// event searches) over `source`, with SATURNIAN_RING_SYSTEM's coarse nodes for the Sun, the Earth and
// Saturn; positions stay within 25 km of the source. Do not use it for the satellites. See
// interpolatedEphemerisSource for the caching and miss behavior.
export function interpolatedSaturnianRingEphemeris(source: EphemerisSource): SaturnianEphemeris {
	return interpolatedSatelliteEphemeris(SATURNIAN_RING_SYSTEM, source, ANALYTICAL_SOURCE)
}

// Whether a source has every body of `bodies` (by default every Saturnian body; pass
// SATURNIAN_RING_BODIES for a ring-only computation). This is a necessary condition only: the centers,
// coverage and segment support are resolved per epoch by stateAt.
export function hasSaturnianTargets(source: EphemerisSource, bodies: readonly SaturnianBody[] = SATURNIAN_BODIES): boolean {
	return hasSatelliteTargets(SATURNIAN_SYSTEM, source, bodies)
}
