import { brentMinimize, brentRoot } from '../../math/numerical/optimization'
import { GALILEAN_MOONS, type GalileanMoon, type JovianEphemeris } from '../ephemeris/jovian'
import { type Time, tdb, timeShift, timeSubtract } from '../time/time'
import { type JovianMoonMargins, jovianMoonMargins, jovianShadowPoint, type JovianSystemState, jovianSystemState } from './jupiter.geometry'
import type { TimeSearchOptions } from './search'

// The classical phenomena of the Galilean satellites against Jupiter, seen from the geocentre: a moon
// crossing the disk (transit), its shadow crossing the disk (shadow transit), a moon hidden behind the
// disk (occultation) and a moon inside Jupiter's shadow (eclipse). The finder samples the geometry of
// jupiter.geometry.ts on one shared grid, locates each conjunction as a minimum of the moon's elliptic
// radius in Jupiter's outline, keeps the minima that bring the moon, its shadow or the planet's shadow into
// contact, and refines every contact with Brent's method on the exact signed margins.
//
// Contacts follow one vocabulary, each defined only when it is reached:
// - transit and occultation: external (the disks touch from outside), internal (the moon fully on or
//   behind the disk) and centre (the moon's centre on the limb);
// - shadow transit: external (the moon's penumbra touches the disk as seen from the Sun), internal (the
//   whole penumbra on the disk) and centre (the shadow axis on the limb);
// - eclipse: external (the moon touches Jupiter's penumbra), centre (the moon's centre on the umbra's
//   boundary, the almanac disappearance or reappearance) and internal (the moon fully inside the umbra).
// A phenomenon without an internal contact is partial; nothing is called total unless it is reached.
// A tangency whose deepest margin is within GRAZE_TOLERANCE of zero is a zero-duration grazing event.
// All instants are geocentric observed times in TDB.

// Kind of classical satellite phenomenon.
export type JovianPhenomenonKind = 'satelliteTransit' | 'shadowTransit' | 'satelliteOccultation' | 'satelliteEclipse'

// One classical phenomenon of a Galilean satellite.
export interface JovianPhenomenon {
	readonly kind: JovianPhenomenonKind
	readonly moon: GalileanMoon
	// Instant of the conjunction: the minimum of the elliptic radius of the moon (transit, occultation,
	// eclipse) or of its shadow axis (shadow transit) in Jupiter's outline.
	readonly maximum: Time
	// First external contact, the start of the phenomenon.
	readonly external1?: Time
	// First internal contact, when the phenomenon becomes complete.
	readonly internal1?: Time
	// First centre contact.
	readonly center1?: Time
	// Last centre contact.
	readonly center2?: Time
	// Last internal contact.
	readonly internal2?: Time
	// Last external contact, the end of the phenomenon.
	readonly external2?: Time
	// Deepest external margin in Jupiter equatorial radii (apparent radii for transits and occultations):
	// negative, and the more negative the more central the phenomenon.
	readonly depth: number
	// Whether the phenomenon is a tangency of zero duration.
	readonly grazing: boolean
	// For a shadow transit, the first instant the shadow centre lies on the hemisphere facing the Earth;
	// undefined when it never does or when the shadow axis never meets the disk.
	readonly visibleStart?: Time
	// For a shadow transit, the last instant the shadow centre lies on the hemisphere facing the Earth.
	readonly visibleEnd?: Time
}

// Options of the phenomena search.
export interface JovianPhenomenaOptions extends TimeSearchOptions {
	// Satellites to search, all four by default.
	readonly moons?: readonly GalileanMoon[]
	// Kinds to search, all four by default.
	readonly kinds?: readonly JovianPhenomenonKind[]
}

// Default sampling step in days: 15 minutes. Io, the fastest, moves ~0.2 Jupiter radii across the sky per
// step near conjunction, so every conjunction valley of the elliptic radius, hours wide, spans many samples.
const DEFAULT_STEP = 15 / 1440

// Default contact refinement tolerance in days (~0.09 s).
const DEFAULT_TOLERANCE = 1e-6

// Elliptic radius above which a sampled conjunction minimum cannot hold a phenomenon. The largest margin
// reached is Jupiter's penumbra at Callisto, under 1.02 radii, plus a moon radius and the sampling
// offset of the minimum, well under this bound.
const CANDIDATE_RADIUS = 1.5

// Deepest-margin magnitude, in Jupiter radii, under which a contact is a tangency: ~7 m on the planet.
const GRAZE_TOLERANCE = 1e-7

// Longest walk in days from a conjunction to find each side's first outside sample: 6 hours, longer than
// the half-duration of any phenomenon (a Callisto eclipse lasts at most ~4.7 hours).
const CONTACT_WINDOW = 0.25

// Samples across a shadow transit's centre contacts used to locate the Earth-visible part.
const VISIBILITY_SAMPLES = 16

// The geometry of one moon at one instant: the shared state and the moon's margins.
interface Sample {
	readonly state: JovianSystemState
	readonly margins: JovianMoonMargins
}

// The family of phenomena sharing one conjunction series: the moon against the disk, its shadow against
// the disk, or the moon against Jupiter's shadow.
interface Family {
	// Elliptic radius whose minima mark the conjunctions.
	readonly radius: (m: JovianMoonMargins) => number
	// Whether the geometry at a conjunction admits a phenomenon of the family.
	readonly valid: (m: JovianMoonMargins) => boolean
	// External margin, negative past the external contact; never above the centre margin.
	readonly external: (m: JovianMoonMargins) => number
	// Centre margin, negative past the centre contact; never above the internal margin.
	readonly center: (m: JovianMoonMargins) => number
	// Internal margin, negative past the internal contact.
	readonly internal: (m: JovianMoonMargins) => number
	// Kind of the phenomenon at a conjunction.
	readonly kind: (m: JovianMoonMargins) => JovianPhenomenonKind
	// Kinds this family can produce.
	readonly kinds: readonly JovianPhenomenonKind[]
}

// The moon against Jupiter's disk: a transit in front, an occultation behind.
const DISK: Family = {
	radius: (m) => m.disk.ellipticRadius,
	valid: () => true,
	external: (m) => m.disk.distance - m.disk.radius,
	center: (m) => m.disk.distance,
	internal: (m) => m.disk.distance + m.disk.radius,
	kind: (m) => (m.disk.front ? 'satelliteTransit' : 'satelliteOccultation'),
	kinds: ['satelliteTransit', 'satelliteOccultation'],
}

// The moon's shadow against Jupiter's disk, with the penumbra's edge as the contact boundary.
const SHADOW: Family = {
	radius: (m) => m.shadow.ellipticRadius,
	valid: (m) => m.shadow.valid,
	external: (m) => m.shadow.distance - m.shadow.penumbra,
	center: (m) => m.shadow.distance,
	internal: (m) => m.shadow.distance + m.shadow.penumbra,
	kind: () => 'shadowTransit',
	kinds: ['shadowTransit'],
}

// The moon against Jupiter's shadow: penumbra for the external contacts, umbra for the others.
const ECLIPSE: Family = {
	radius: (m) => m.eclipse.ellipticRadius,
	valid: (m) => m.eclipse.valid,
	external: (m) => m.eclipse.penumbraDistance - m.eclipse.radius,
	center: (m) => m.eclipse.umbraDistance,
	internal: (m) => m.eclipse.umbraDistance + m.eclipse.radius,
	kind: () => 'satelliteEclipse',
	kinds: ['satelliteEclipse'],
}

// The families in search order.
const FAMILIES: readonly Family[] = [DISK, SHADOW, ECLIPSE]

// Finds the classical phenomena of the Galilean satellites whose conjunction (`maximum`) lies in
// [start, stop), chronologically by maximum.
//
// Every position comes from `ephemeris`; wrap a source in interpolatedJovianEphemeris for speed. A
// kernel-backed ephemeris propagates its JovianEphemerisMiss and the search is abandoned. The grid
// extends two steps beyond each end so a conjunction on the boundary is bracketed, and the contacts are
// computed in full even when they fall outside the window, so consecutive half-open windows concatenate
// without duplicates. `step` (days, default 15 minutes) must stay well under the shortest conjunction
// valley (hours for Io); `tolerance` (days, default ~0.09 s) bounds the contact refinement.
export function jovianPhenomena(ephemeris: JovianEphemeris, start: Time, stop: Time, options: JovianPhenomenaOptions = {}): JovianPhenomenon[] {
	const step = options.step ?? DEFAULT_STEP
	const tolerance = options.tolerance ?? DEFAULT_TOLERANCE
	const moons = options.moons ?? GALILEAN_MOONS
	const kinds = new Set<JovianPhenomenonKind>(options.kinds ?? ['satelliteTransit', 'shadowTransit', 'satelliteOccultation', 'satelliteEclipse'])
	const families = FAMILIES.filter((family) => family.kinds.some((kind) => kinds.has(kind)))

	const origin = timeShift(tdb(start), -2 * step)
	const span = timeSubtract(stop, start) + 4 * step
	if (!(span > 4 * step) || moons.length === 0 || families.length === 0) return []

	const count = Math.ceil(span / step) + 1
	const samples: JovianMoonMargins[][] = []

	for (let k = 0; k < count; k++) {
		const state = jovianSystemState(ephemeris, timeShift(origin, k * step))
		samples.push(moons.map((moon) => jovianMoonMargins(ephemeris, state, moon)))
	}

	const phenomena: JovianPhenomenon[] = []
	const windowStart = timeSubtract(start, origin)
	const windowStop = timeSubtract(stop, origin)

	for (let i = 0; i < moons.length; i++) {
		const moon = moons[i]
		// Geometry of this moon at an offset (days) from the grid origin.
		const at = (x: number): Sample => {
			const state = jovianSystemState(ephemeris, timeShift(origin, x))
			return { state, margins: jovianMoonMargins(ephemeris, state, moon) }
		}

		for (const family of families) {
			for (let k = 1; k < count - 1; k++) {
				const value = family.radius(samples[k][i])
				if (!(value < CANDIDATE_RADIUS && value < family.radius(samples[k - 1][i]) && value <= family.radius(samples[k + 1][i]))) continue

				const conjunction = brentMinimize((x) => family.radius(at(x).margins), (k - 1) * step, (k + 1) * step, { tolerance })
				const x = conjunction.minimum
				if (x < windowStart || x >= windowStop) continue

				const phenomenon = refine(family, moon, at, origin, x, step, tolerance, kinds)
				if (phenomenon !== undefined) phenomena.push(phenomenon)
			}
		}
	}

	phenomena.sort((a, b) => timeSubtract(a.maximum, b.maximum))
	return phenomena
}

// Classifies the conjunction at offset `x` (days from `origin`) and refines its contacts, or returns
// undefined when the conjunction holds no phenomenon of a requested kind.
function refine(family: Family, moon: GalileanMoon, at: (x: number) => Sample, origin: Time, x: number, step: number, tolerance: number, kinds: ReadonlySet<JovianPhenomenonKind>): JovianPhenomenon | undefined {
	const { margins } = at(x)
	if (!family.valid(margins)) return undefined

	const kind = family.kind(margins)
	if (!kinds.has(kind)) return undefined

	// The deepest external margin may sit slightly off the conjunction for a high, grazing path.
	const deepest = brentMinimize((y) => family.external(at(y).margins), x - step, x + step, { tolerance })
	if (!(deepest.value < GRAZE_TOLERANCE)) return undefined

	const time = (y: number) => timeShift(origin, y)
	const maximum = time(x)

	if (deepest.value > -GRAZE_TOLERANCE) {
		const tangency = time(deepest.minimum)
		return { kind, moon, maximum, external1: tangency, external2: tangency, depth: deepest.value, grazing: true }
	}

	// Walk outward from the conjunction until the external margin is positive on each side.
	const left = outside(family, at, x, -step)
	const right = outside(family, at, x, step)

	// Root of a margin between an outside bracket end and the conjunction, when the margin is negative there.
	const contact = (margin: (m: JovianMoonMargins) => number, inside: number, outsideAt: number | undefined) => {
		if (outsideAt === undefined || !(margin(margins) < 0)) return undefined
		const f = (y: number) => margin(at(y).margins)
		const root = outsideAt < inside ? brentRoot(f, outsideAt, inside, { tolerance }) : brentRoot(f, inside, outsideAt, { tolerance })
		return time(root.root)
	}

	const phenomenon = {
		kind,
		moon,
		maximum,
		external1: contact(family.external, x, left),
		internal1: contact(family.internal, x, left),
		center1: contact(family.center, x, left),
		center2: contact(family.center, x, right),
		internal2: contact(family.internal, x, right),
		external2: contact(family.external, x, right),
		depth: deepest.value,
		grazing: false,
	}

	if (kind !== 'shadowTransit' || phenomenon.center1 === undefined || phenomenon.center2 === undefined) return phenomenon

	return { ...phenomenon, ...shadowVisibility(at, origin, timeSubtract(phenomenon.center1, origin), timeSubtract(phenomenon.center2, origin), tolerance) }
}

// Offset (days from the grid origin) of the first sample, walking from `x` in increments of `delta`, at
// which the external margin is positive, or undefined beyond CONTACT_WINDOW.
function outside(family: Family, at: (x: number) => Sample, x: number, delta: number): number | undefined {
	for (let y = x + delta; Math.abs(y - x) <= CONTACT_WINDOW + Math.abs(delta); y += delta) {
		if (family.external(at(y).margins) > 0) return y
	}

	return undefined
}

// First and last instants between the shadow transit's centre contacts (offsets c1 < c2 in days from the
// grid origin) at which the shadow centre lies on the hemisphere facing the Earth, refined at the sign
// changes of the cosine of its emission angle. Near quadrature the centre can enter or leave the disk on
// the side hidden from the Earth; elsewhere the whole crossing is visible.
function shadowVisibility(at: (x: number) => Sample, origin: Time, c1: number, c2: number, tolerance: number): Pick<JovianPhenomenon, 'visibleStart' | 'visibleEnd'> {
	// Cosine of the shadow centre's emission angle toward the Earth, −1 where the axis misses the disk.
	const cosine = (y: number) => {
		const { state, margins } = at(y)
		return jovianShadowPoint(state, margins.shadow)?.earthCosine ?? -1
	}

	const span = c2 - c1
	const xs: number[] = []
	const values: number[] = []

	for (let j = 0; j <= VISIBILITY_SAMPLES; j++) {
		// Stay a hair inside the centre contacts, where the axis meets the disk.
		const y = c1 + span * (1e-6 + ((1 - 2e-6) * j) / VISIBILITY_SAMPLES)
		xs.push(y)
		values.push(cosine(y))
	}

	const first = values.findIndex((value) => value > 0)
	if (first < 0) return {}
	const last = values.findLastIndex((value) => value > 0)

	const start = first === 0 ? c1 : brentRoot(cosine, xs[first - 1], xs[first], { tolerance }).root
	const end = last === values.length - 1 ? c2 : brentRoot(cosine, xs[last], xs[last + 1], { tolerance }).root
	return { visibleStart: timeShift(origin, start), visibleEnd: timeShift(origin, end) }
}
