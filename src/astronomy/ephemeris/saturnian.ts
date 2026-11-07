import { AU_KM } from '../../core/constants'
import { type Vec3, vecClone, vecPlus } from '../../math/linear-algebra/vec3'
import type { PositionAndVelocityOverTime } from '../coordinates/astrometry'
import type { Time } from '../time/time'
import { Naif } from './kernels/naif'
import type { SpkKernelSet, SpkMissReason } from './kernels/spk.kernelset'
import { dione, enceladus, iapetus, mimas, rhea, tethys, titan } from './models/analytical/tass17'
import { earth, saturn, sun } from './models/analytical/vsop87e'
import { hasSatelliteTargets, interpolatedSatelliteEphemeris, type SatelliteEphemeris, SatelliteEphemerisMiss, type SatelliteSystem, type SpkSatelliteEphemeris, type SpkSatelliteSource, spkSatelliteEphemeris } from './satellites'

// One coherent source of the barycentric positions needed to predict Saturnian geometry and phenomena:
// the Sun, the Earth, Saturn's centre (NAIF 699, never its system barycenter 6) and its seven major
// satellites Mimas to Iapetus (Hyperion is omitted). A computation takes every state from one source, so
// analytical and kernel positions are never mixed. The analytical source adds the TASS 1.7 Saturnicentric
// offsets (J2000 equatorial axes, the same axes as VSOP87E's ICRF output, so they are not rotated again)
// to the VSOP87E Saturn at the same instant; the SPK source resolves each body through a prepared kernel
// set, chaining through barycenter 6 when the kernels do, and throws a SaturnianEphemerisMiss when any
// state is unavailable. A ring-only computation evaluates SATURNIAN_RING_BODIES alone, so it needs
// neither a satellite kernel nor the satellite theory. Positions are AU in ICRF/J2000 axes with a
// barycentric origin; every call returns a freshly allocated vector. Dense searches wrap a source in
// interpolatedSaturnianEphemeris.

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

// Thrown by an SPK source when a Saturnian body state cannot be resolved, so the caller can abandon the
// whole computation instead of mixing sources.
export class SaturnianEphemerisMiss extends SatelliteEphemerisMiss<SaturnianBody> {
	constructor(target: SaturnianBody, body: number, reason: SpkMissReason, time: Time) {
		super(target, body, reason, time)
		this.name = 'SaturnianEphemerisMiss'
	}
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
	miss: (target, body, reason, time) => new SaturnianEphemerisMiss(target, body, reason, time),
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

// The analytical theories behind the analytical source.
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

// A Saturnian ephemeris backed by a kernel set, which also records the files that supplied each body.
export type SpkSaturnianEphemeris = SpkSatelliteEphemeris<SaturnianBody, SaturnianMoon>

// TASS 1.7 Saturnicentric theory of each major satellite (AU, J2000 equatorial).
const ANALYTICAL_SATELLITES: Readonly<Record<SaturnianMoon, PositionAndVelocityOverTime>> = { mimas, enceladus, tethys, dione, rhea, titan, iapetus }

// Provenance of the analytical source.
const ANALYTICAL_SOURCE: AnalyticalSaturnianSource = { kind: 'analytical', planetary: 'VSOP87E', satellites: 'TASS1.7' }

// The analytical Saturnian ephemeris: VSOP87E for the Sun, the Earth and Saturn's centre, and the TASS 1.7
// Saturnicentric offsets added to the VSOP87E Saturn at the same instant for the satellites. Never throws.
export const analyticalSaturnianEphemeris: SaturnianEphemeris = {
	source: ANALYTICAL_SOURCE,
	position: analyticalPosition,
	planetocentric: (moon, time) => vecClone(ANALYTICAL_SATELLITES[moon](time)[0]),
}

// Barycentric position of a Saturnian body from VSOP87E and TASS 1.7 (AU, ICRF), freshly allocated.
function analyticalPosition(body: SaturnianBody, time: Time): Vec3 {
	switch (body) {
		case 'sun':
			return vecClone(sun(time)[0])
		case 'earth':
			return vecClone(earth(time)[0])
		case 'saturn':
			return vecClone(saturn(time)[0])
		default:
			return vecPlus(saturn(time)[0], ANALYTICAL_SATELLITES[body](time)[0])
	}
}

// Builds a Saturnian ephemeris over a prepared kernel set. Each position resolves the body's NAIF code
// (699 for Saturn, never the barycenter) through the set with its precedence rules; any miss throws a
// SaturnianEphemerisMiss. The set must stay open while the ephemeris is used, so evaluate it
// synchronously and do not keep it across an asynchronous yield that could close the kernel sources.
export function spkSaturnianEphemeris(set: SpkKernelSet): SpkSaturnianEphemeris {
	return spkSatelliteEphemeris(SATURNIAN_SYSTEM, set)
}

// Builds a Saturnian ephemeris that interpolates `source` instead of evaluating it at every epoch, for
// searches that sample thousands of nearby epochs. Nodes are one day apart for the Sun, the Earth and
// Saturn, 30 minutes apart for Mimas and Enceladus and one hour apart for the other satellites; the error
// stays below 0.1 km. See interpolatedSatelliteEphemeris for the caching, provenance and miss behavior.
export function interpolatedSaturnianEphemeris<E extends SaturnianEphemeris>(source: E): SaturnianEphemeris & Pick<E, 'source'> {
	return interpolatedSatelliteEphemeris(SATURNIAN_SYSTEM, source)
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
// interpolatedSatelliteEphemeris for the caching, provenance and miss behavior.
export function interpolatedSaturnianRingEphemeris<E extends SaturnianEphemeris>(source: E): SaturnianEphemeris & Pick<E, 'source'> {
	return interpolatedSatelliteEphemeris(SATURNIAN_RING_SYSTEM, source)
}

// Whether a kernel set has a segment for every body of `bodies` (by default every Saturnian body; pass
// SATURNIAN_RING_BODIES for a ring-only computation). This is a necessary condition only: the centers,
// coverage and segment support are resolved per epoch by stateAt.
export function hasSaturnianTargets(set: SpkKernelSet, bodies: readonly SaturnianBody[] = SATURNIAN_BODIES): boolean {
	return hasSatelliteTargets(SATURNIAN_SYSTEM, set, bodies)
}
