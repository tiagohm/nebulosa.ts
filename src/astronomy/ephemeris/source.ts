import { J2000 } from '../../core/constants'
import { vecPlus, vecZero } from '../../math/linear-algebra/vec3'
import type { PositionAndVelocity, PositionAndVelocityMut } from '../coordinates/astrometry'
import { type Time, Timescale, tdb, timeShift } from '../time/time'
import type { SpkKernelSet, SpkMissReason } from './kernels/spk.kernelset'
import * as elpmpp02 from './models/analytical/elpmpp02'
import * as gust86 from './models/analytical/gust86'
import * as l12 from './models/analytical/l12'
import * as marssat from './models/analytical/marssat'
import { pluto } from './models/analytical/pluto'
import * as tass17 from './models/analytical/tass17'
import * as vsop87e from './models/analytical/vsop87e'

// Generic synchronous ephemeris sources of solar-system bodies, addressed by NAIF code: one interface
// every computation of the toolkit takes its states from, so no algorithm evaluates a theory or reads a
// kernel by itself. A source answers the barycentric state of a body (position in AU and velocity in
// AU/day, ICRF axes, origin the solar-system barycenter), freshly allocated, or throws EphemerisMiss
// when it cannot, letting the caller abandon and rerun the whole computation on another source so one
// computation never mixes sources (computeOnEphemerisSources). Three sources are provided: the SPK
// kernels of a prepared kernel set, the analytical theories (VSOP87E, ELPMPP02, the Pluto theory, L1.2,
// TASS 1.7, GUST86, and MARSSAT), and an interpolation of either on a fixed TDB grid for dense searches.

// Why a source could not give a state: an SPK resolution failure, or no theory for the body.
export type EphemerisMissReason = SpkMissReason | 'noModel'

// Thrown by a source when the state of a body cannot be given, so the caller can abandon the whole
// computation instead of mixing sources.
export class EphemerisMiss extends Error {
	// NAIF code of the body that was requested.
	readonly target: number
	// NAIF code of the body where resolution stopped: the target itself or one of its centers.
	readonly body: number
	// Why resolution stopped.
	readonly reason: EphemerisMissReason
	// The epoch that could not be resolved.
	readonly time: Time

	// Creates the miss of `target`, stopped at `body` for `reason` at `time`.
	constructor(target: number, body: number, reason: EphemerisMissReason, time: Time) {
		super(`the state of NAIF ${target} is unavailable (${reason} at NAIF ${body})`)
		this.name = 'EphemerisMiss'
		this.target = target
		this.body = body
		this.reason = reason
		this.time = time
	}
}

// What a source's states come from.
export type EphemerisSourceKind = 'spk' | 'analytical'

// A coherent synchronous source of barycentric states of solar-system bodies by NAIF code.
export interface EphemerisSource {
	// What the states come from; an interpolated source keeps the kind of the source it interpolates.
	readonly kind: EphemerisSourceKind
	// Whether the source has the body at all: a kernel segment for it, or a theory. A necessary condition only:
	// state may still throw EphemerisMiss for an epoch or a center it cannot resolve.
	readonly has: (naif: number) => boolean
	// Barycentric state of a body at an epoch of any time scale: position AU, velocity AU/day, ICRF axes,
	// freshly allocated. Throws EphemerisMiss when the source cannot give it.
	readonly state: (naif: number, time: Time) => PositionAndVelocityMut
	// NAIF code of the body a body's theory is natural relative to (the planet of a satellite theory, the
	// Earth for the Moon), when the source computes it as an offset from that body; undefined otherwise.
	readonly centerOf?: (naif: number) => number | undefined
	// State of a body relative to centerOf(naif) (AU, AU/day, ICRF axes), freshly allocated, consistent with
	// state: state(naif) = state(centerOf(naif)) + relativeState(naif) at the same epoch.
	readonly relativeState?: (naif: number, time: Time) => PositionAndVelocityMut
}

// A source backed by a kernel set, which also records the files that supplied each body.
export interface SpkEphemerisSource extends EphemerisSource {
	readonly kind: 'spk'
	// Identifiers of the files of the kernel set in load order, lowest precedence first.
	readonly kernels: readonly string[]
	// Identifiers of the files whose segments formed each body's chain in the states evaluated so far,
	// accumulated as states are requested. A body never evaluated is absent.
	readonly kernelsByBody: ReadonlyMap<number, ReadonlySet<string>>
}

// Builds a source over a prepared kernel set: each state resolves the body's NAIF code through the set with
// its precedence rules, and any failure throws EphemerisMiss with the reason and the failing link. The set
// must stay open while the source is used, so evaluate it synchronously and do not keep it across an
// asynchronous yield that could close the kernel sources.
export function spkEphemerisSource(set: SpkKernelSet): SpkEphemerisSource {
	const kernelsByBody = new Map<number, Set<string>>()

	function state(naif: number, time: Time): PositionAndVelocityMut {
		const result = set.stateAt(naif, time)
		if (!result.ok) throw new EphemerisMiss(naif, result.body, result.reason, time)

		let kernels = kernelsByBody.get(naif)

		if (kernels === undefined) {
			kernels = new Set()
			kernelsByBody.set(naif, kernels)
		}

		for (const kernel of result.kernels) kernels.add(kernel)

		const [p, v] = result.state
		return [
			[p[0], p[1], p[2]],
			[v[0], v[1], v[2]],
		]
	}

	return { kind: 'spk', has: (naif) => set.bodies.has(naif), state, kernels: set.kernels, kernelsByBody }
}

// Ratio of the Earth's mass to the Moon's (DE440 EMRAT), which places the Earth-Moon barycenter on the
// Earth-Moon line.
const EARTH_MOON_MASS_RATIO = 81.3005682214972154

// Half-width in days of the central difference that gives the velocity of the Pluto theory, which has none.
const PLUTO_VELOCITY_HALF_SPAN = 0.5

// VSOP87E theory of each planet by the NAIF codes of the planet and of its system barycenter. VSOP87E
// gives the position of the planet's system, so the two codes answer the same state; the offset of the
// centre from the barycenter (a few hundred km for Jupiter and Saturn) is not modelled.
const VSOP87E_PLANETS: ReadonlyMap<number, (time: Time) => PositionAndVelocityMut> = new Map([
	[1, vsop87e.mercury],
	[199, vsop87e.mercury],
	[2, vsop87e.venus],
	[299, vsop87e.venus],
	[4, vsop87e.mars],
	[499, vsop87e.mars],
	[5, vsop87e.jupiter],
	[599, vsop87e.jupiter],
	[6, vsop87e.saturn],
	[699, vsop87e.saturn],
	[7, vsop87e.uranus],
	[799, vsop87e.uranus],
	[8, vsop87e.neptune],
	[899, vsop87e.neptune],
])

// A planetocentric satellite theory: the NAIF code of its planet's centre and the offset it computes
// (AU, AU/day, J2000 equatorial axes).
interface SatelliteTheory {
	readonly planet: number
	readonly offset: (time: Time) => PositionAndVelocityMut
}

// The satellite theories by NAIF code: MARSSAT, L1.2, TASS 1.7, and GUST86.
const SATELLITE_THEORIES: ReadonlyMap<number, SatelliteTheory> = new Map([
	[401, { planet: 499, offset: marssat.phobos }],
	[402, { planet: 499, offset: marssat.deimos }],
	[501, { planet: 599, offset: l12.io }],
	[502, { planet: 599, offset: l12.europa }],
	[503, { planet: 599, offset: l12.ganymede }],
	[504, { planet: 599, offset: l12.callisto }],
	[601, { planet: 699, offset: tass17.mimas }],
	[602, { planet: 699, offset: tass17.enceladus }],
	[603, { planet: 699, offset: tass17.tethys }],
	[604, { planet: 699, offset: tass17.dione }],
	[605, { planet: 699, offset: tass17.rhea }],
	[606, { planet: 699, offset: tass17.titan }],
	[607, { planet: 699, offset: tass17.hyperion }],
	[608, { planet: 699, offset: tass17.iapetus }],
	[701, { planet: 799, offset: gust86.ariel }],
	[702, { planet: 799, offset: gust86.umbriel }],
	[703, { planet: 799, offset: gust86.titania }],
	[704, { planet: 799, offset: gust86.oberon }],
	[705, { planet: 799, offset: gust86.miranda }],
])

// Adds two states into a fresh one.
function addStates(a: PositionAndVelocity, b: PositionAndVelocity): PositionAndVelocityMut {
	return [vecPlus(a[0], b[0]), vecPlus(a[1], b[1])]
}

// Heliocentric state of the Pluto theory (Meeus 37, valid 1885 to 2099), with its velocity from a central
// difference of PLUTO_VELOCITY_HALF_SPAN days.
function plutoHeliocentric(time: Time): PositionAndVelocityMut {
	const before = pluto(timeShift(time, -PLUTO_VELOCITY_HALF_SPAN))
	const after = pluto(timeShift(time, PLUTO_VELOCITY_HALF_SPAN))
	const scale = 1 / (2 * PLUTO_VELOCITY_HALF_SPAN)
	return [pluto(time), [(after[0] - before[0]) * scale, (after[1] - before[1]) * scale, (after[2] - before[2]) * scale]]
}

// The NAIF code the analytical source computes a body relative to: the planet of a satellite, the Earth for
// the Moon, the Sun for Pluto; undefined for a body it computes barycentrically.
function analyticalCenterOf(naif: number): number | undefined {
	if (naif === 301) return 399
	if (naif === 999 || naif === 9) return 10
	return SATELLITE_THEORIES.get(naif)?.planet
}

// State of a body relative to analyticalCenterOf(naif), freshly allocated; throws EphemerisMiss without one.
function analyticalRelativeState(naif: number, time: Time): PositionAndVelocityMut {
	if (naif === 301) return elpmpp02.moon(time)
	if (naif === 999 || naif === 9) return plutoHeliocentric(time)
	const theory = SATELLITE_THEORIES.get(naif)
	if (theory === undefined) throw new EphemerisMiss(naif, naif, 'noModel', time)
	return theory.offset(time)
}

// Barycentric state of a body from the analytical theories, freshly allocated; throws EphemerisMiss for a body
// without a theory.
function analyticalState(naif: number, time: Time): PositionAndVelocityMut {
	if (naif === 0) return [vecZero(), vecZero()]
	if (naif === 10) return vsop87e.sun(time)
	if (naif === 399) return vsop87e.earth(time)

	if (naif === 3) {
		const earth = vsop87e.earth(time)
		const moon = elpmpp02.moon(time)
		const k = 1 / (1 + EARTH_MOON_MASS_RATIO)
		return addStates(earth, [
			[moon[0][0] * k, moon[0][1] * k, moon[0][2] * k],
			[moon[1][0] * k, moon[1][1] * k, moon[1][2] * k],
		])
	}

	const planet = VSOP87E_PLANETS.get(naif)
	if (planet !== undefined) return planet(time)
	const center = analyticalCenterOf(naif)
	if (center === undefined) throw new EphemerisMiss(naif, naif, 'noModel', time)
	return addStates(analyticalState(center, time), analyticalRelativeState(naif, time))
}

// Whether the analytical source has a theory for a body.
function analyticalHas(naif: number) {
	return naif === 0 || naif === 3 || naif === 10 || naif === 399 || VSOP87E_PLANETS.has(naif) || analyticalCenterOf(naif) !== undefined
}

// The analytical theories as a source: VSOP87E for the Sun, the planets (their systems), the Earth, and the
// Earth-Moon barycenter with the ELPMPP02 Moon and the DE440 mass ratio; ELPMPP02 for the Moon (relative to
// the Earth); the Meeus Pluto theory (relative to the Sun, 1885 to 2099); and the satellite theories relative
// to their planet's VSOP87E state: MARSSAT (401, 402), L1.2 (501 to 504), TASS 1.7 (601 to 608), GUST86 (701 to
// 705). Any other body throws EphemerisMiss with reason noModel. Every state is evaluated in full: an
// ELPMPP02 evaluation costs about 10 ms, so a computation sampling many epochs should interpolate it.
export const analyticalEphemerisSource: EphemerisSource = {
	kind: 'analytical',
	has: analyticalHas,
	state: analyticalState,
	centerOf: analyticalCenterOf,
	relativeState: analyticalRelativeState,
}

// J2000.0 in TDB, the origin of the interpolation nodes.
const J2000_TDB: Time = { day: J2000, fraction: 0, scale: Timescale.TDB }

// Number of nodes of the Lagrange interpolation, centred on the interval holding the epoch.
const INTERPOLATION_NODES = 6

// Default spacing in days of the interpolation nodes of a body, chosen so the six-point Lagrange error stays
// below about 0.1 km over its motion: one day for the Sun, the planets, their barycenters, the Earth (whose
// lunar wobble dominates) and any other body; six hours for the Moon; an hour for the satellites, half an
// hour for Mimas and Enceladus, and fifteen minutes for Phobos (7.7 h orbit).
export function defaultEphemerisNodeStep(naif: number): number {
	if (naif === 301) return 0.25
	if (naif === 401) return 1 / 96
	if (naif === 601 || naif === 602) return 1 / 48
	if (naif > 400 && naif < 900 && naif % 100 !== 99) return 1 / 24
	return 1
}

// Builds a source that interpolates `source` instead of evaluating it at every epoch, for searches that
// sample thousands of nearby epochs. States are evaluated at nodes on a fixed TDB grid anchored at J2000 with
// the spacing `nodeStep(naif)` days, and interpolated with a six-point Lagrange polynomial centred on the
// epoch's interval, position and velocity alike. A body the source computes relative to a center (centerOf)
// is interpolated as that offset and added to the interpolated center, so a satellite or Moon node costs one
// satellite-theory evaluation instead of a planetary one. The kind is kept, and a node the source cannot
// evaluate propagates its error, so a kernel-backed source still throws EphemerisMiss, possibly for a node up
// to three node steps beyond the epoch. Evaluated nodes are cached for the lifetime of the returned source,
// so create one per computation; the cache grows with the span evaluated (one node per body per node step).
export function interpolatedEphemerisSource(source: EphemerisSource, nodeStep: (naif: number) => number = defaultEphemerisNodeStep): EphemerisSource {
	const nodes = new Map<number, Map<number, PositionAndVelocityMut>>()
	const relative = source.relativeState
	const centerOf = source.centerOf

	// Node state of a body: its offset from its center when the source is relative for it, else barycentric.
	function node(naif: number, index: number, center: number | undefined): PositionAndVelocityMut {
		let cache = nodes.get(naif)

		if (cache === undefined) {
			cache = new Map()
			nodes.set(naif, cache)
		}

		let state = cache.get(index)

		if (state === undefined) {
			const time = timeShift(J2000_TDB, index * nodeStep(naif))
			state = center === undefined ? source.state(naif, time) : relative!(naif, time)
			cache.set(index, state)
		}

		return state
	}

	// Interpolated node state of a body at a time, in the origin of its nodes, freshly allocated.
	function interpolate(naif: number, time: Time, center: number | undefined): PositionAndVelocityMut {
		const t = tdb(time)
		const step = nodeStep(naif)
		const x = (t.day - J2000 + t.fraction) / step
		const base = Math.floor(x)
		const u = x - base
		const first = base - INTERPOLATION_NODES / 2 + 1
		const position = vecZero()
		const velocity = vecZero()

		for (let j = 0; j < INTERPOLATION_NODES; j++) {
			// Lagrange weight of node j over the nodes first..first+5, at the offset u of the epoch from node base.
			const nj = j - INTERPOLATION_NODES / 2 + 1
			let weight = 1

			for (let k = 0; k < INTERPOLATION_NODES; k++) {
				if (k === j) continue
				const nk = k - INTERPOLATION_NODES / 2 + 1
				weight *= (u - nk) / (nj - nk)
			}

			const [p, v] = node(naif, first + j, center)
			position[0] += weight * p[0]
			position[1] += weight * p[1]
			position[2] += weight * p[2]
			velocity[0] += weight * v[0]
			velocity[1] += weight * v[1]
			velocity[2] += weight * v[2]
		}

		return [position, velocity]
	}

	// The center a body is interpolated relative to, when the source is relative for it.
	function relativeCenter(naif: number) {
		return relative === undefined ? undefined : centerOf?.(naif)
	}

	function state(naif: number, time: Time): PositionAndVelocityMut {
		const center = relativeCenter(naif)
		const out = interpolate(naif, time, center)
		return center === undefined ? out : addStates(state(center, time), out)
	}

	return {
		kind: source.kind,
		has: source.has,
		state,
		...(centerOf && relative && { centerOf, relativeState: (naif: number, time: Time) => (relativeCenter(naif) === undefined ? relative(naif, time) : interpolate(naif, time, relativeCenter(naif))) }),
	}
}

// The outcome of a computation run on the first source that could give every state it needed.
export interface EphemerisComputation<T> {
	// What the computation returned.
	readonly result: T
	// The source it ran on.
	readonly source: EphemerisSource
	// The misses of the sources tried before, in order, one per source.
	readonly misses: readonly EphemerisMiss[]
}

// Runs a whole computation on each source in order until one gives every state it needs: an EphemerisMiss
// abandons the computation on that source and runs it again on the next, so one result never mixes
// sources. Any other error propagates. Throws the last miss when no source could; `sources` is non-empty.
export function computeOnEphemerisSources<T>(sources: readonly EphemerisSource[], compute: (source: EphemerisSource) => T): EphemerisComputation<T> {
	const misses: EphemerisMiss[] = []

	for (const source of sources) {
		try {
			return { result: compute(source), source, misses }
		} catch (error) {
			if (!(error instanceof EphemerisMiss)) throw error
			misses.push(error)
		}
	}

	throw misses.at(-1)!
}

// Geometric state of a body relative to another (target minus center) at the same epoch, from one source,
// freshly allocated: no light time, aberration, or deflection.
export function relativeEphemerisState(source: EphemerisSource, target: number, center: number, time: Time): PositionAndVelocityMut {
	const a = source.state(target, time)
	const b = source.state(center, time)
	return [
		[a[0][0] - b[0][0], a[0][1] - b[0][1], a[0][2] - b[0][2]],
		[a[1][0] - b[1][0], a[1][1] - b[1][1], a[1][2] - b[1][2]],
	]
}
