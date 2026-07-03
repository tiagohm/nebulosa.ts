import { DAYSEC, ONE_SECOND } from '../../core/constants'
import type { Vec3 } from '../../math/linear-algebra/vec3'
import { clamp } from '../../math/numerical/math'
import { type Angle, normalizeAngle, normalizePI } from '../../math/units/angle'
import type { Distance } from '../../math/units/distance'
import { equatorial, type PositionAndVelocityOverTime, separationFrom, topocentricDirection } from '../coordinates/astrometry'
import { type Time, timeSubtract } from '../time/time'
import { searchExtrema, searchRoots, type TimeSearchOptions } from './search'

// Planetary transit prediction for a single observer, without any Besselian shadow-path engine.
//
// Mercury or Venus transits the Sun when, seen from a fixed observer, its disk crosses the solar disk. The
// full ground-track problem (central line, path limits, visibility curves) needs Besselian elements; this
// predictor answers the per-site question directly, as the topocentric mirror of occultationCandidates. It
// samples the topocentric angular separation between the planet's centre and the Sun's centre, finds the
// appulse (mid-transit) with the shared time-domain scanner, and root-finds the four contact instants where
// that separation crosses the sum (exterior contacts I/IV) and the difference (interior contacts II/III) of
// the two angular radii.
//
// The topocentric direction is essential: the planet's diurnal parallax (Venus reaches ~30", the historic
// basis for measuring the astronomical unit) shifts the contact times by minutes between sites, so both the
// planet and the Sun are seen from the observer's own barycentric state (e.g. from observerState). Light time
// to each body is corrected by iteration; annual and diurnal aberration are omitted because they shift the
// planet and the Sun almost identically and cancel in the differential separation. Gravitational light
// bending near the solar limb (up to ~1.75") is not modelled, so contacts are accurate to about that limb
// deflection plus the ephemeris error, i.e. a second or two of time — adequate without a photospheric limb or
// black-drop model. Angles are radians, distances AU, durations seconds.

// A predicted transit of a planet across the Sun's disk as seen from one observer. Contact instants are TT
// and may be undefined when they fall outside the search window (the transit was already in progress at the
// window's edge) or, for the interior contacts, when the transit is only grazing.
export interface PlanetaryTransit {
	// Instant of least topocentric separation between the planet's centre and the Sun's centre (mid-transit).
	readonly time: Time
	// Least separation between the two centres, radians: the impact parameter of the chord across the disk.
	readonly minSeparation: Angle
	// Sun's angular radius at mid-transit, radians.
	readonly sunAngularRadius: Angle
	// Planet's angular radius at mid-transit, radians.
	readonly planetAngularRadius: Angle
	// Whether the planet is ever wholly inside the disk (a full transit). False for a grazing transit whose
	// disk only overlaps the limb, which has no interior contacts.
	readonly full: boolean
	// Exterior ingress (contact I): the disk first touches the limb from outside (separation = sum of radii).
	readonly exteriorIngress?: Time
	// Interior ingress (contact II): the disk becomes wholly inside (separation = difference of radii).
	readonly interiorIngress?: Time
	// Interior egress (contact III): the leading edge reaches the far limb (separation = difference of radii).
	readonly interiorEgress?: Time
	// Exterior egress (contact IV): the disk leaves the limb (separation = sum of radii).
	readonly exteriorEgress?: Time
	// Position angle of the exterior-ingress point on the Sun's limb, radians, measured from celestial north
	// through east (the planet's direction relative to the Sun's centre). Undefined when contact I is missing.
	readonly ingressPositionAngle?: Angle
	// Position angle of the exterior-egress point, radians, north through east. Undefined when contact IV is
	// missing.
	readonly egressPositionAngle?: Angle
	// Seconds from exterior ingress (I) to exterior egress (IV); undefined unless both contacts are in-window.
	readonly duration?: number
}

// Options for the transit predictor. The two physical radii are required: without them the angular disks,
// and therefore the contacts, are undefined.
export interface PlanetaryTransitOptions extends TimeSearchOptions {
	// Physical radius of the Sun, AU. Sets the Sun's angular radius (asin(radius / topocentric distance)).
	readonly sunRadius: Distance
	// Physical radius of the transiting planet, AU. Sets the planet's angular radius likewise.
	readonly planetRadius: Distance
	// Fixed-point iterations for the light-time correction to each body. Defaults to 2, enough for the inner
	// planets; a positive value samples the ephemerides at the retarded emission time, up to one light-time
	// before `start`.
	readonly lightTimeIterations?: number
}

// Default coarse sampling step: 2 min. Fine enough to isolate each contact crossing in its own interval for
// Brent to refine to sub-second precision; widen or narrow it via options for shorter or longer windows.
const DEFAULT_STEP = 120 * ONE_SECOND
// Minimum number of coarse intervals across the window, mirroring the occultation screener: the effective
// step is capped at span / this so even a short window is bracketed densely enough to catch its appulse.
const MIN_INTERVALS = 4

// Topocentric geometry of a transit at one instant: the light-time-corrected directions to the planet and to
// the Sun's centre, their angular separation, and the two angular radii.
interface TransitGeometry {
	readonly planetDirection: Vec3
	readonly sunDirection: Vec3
	readonly separation: number
	readonly sunAngularRadius: number
	readonly planetAngularRadius: number
}

// Samples the transit geometry at `time`: both topocentric directions, their separation, and the disks'
// angular radii from their topocentric distances.
function transitGeometry(planet: PositionAndVelocityOverTime, sun: PositionAndVelocityOverTime, observer: PositionAndVelocityOverTime, time: Time, iterations: number, sunRadius: Distance, planetRadius: Distance): TransitGeometry {
	const planetDirection = topocentricDirection(planet, observer, time, iterations)
	const sunDirection = topocentricDirection(sun, observer, time, iterations)
	const separation = separationFrom(planetDirection, sunDirection)
	const sunDistance = Math.hypot(sunDirection[0], sunDirection[1], sunDirection[2])
	const planetDistance = Math.hypot(planetDirection[0], planetDirection[1], planetDirection[2])
	const sunAngularRadius = Math.asin(clamp(sunRadius / sunDistance, 0, 1))
	const planetAngularRadius = Math.asin(clamp(planetRadius / planetDistance, 0, 1))
	return { planetDirection, sunDirection, separation, sunAngularRadius, planetAngularRadius }
}

// Position angle of `planetDirection` relative to `sunDirection` on the sky, radians in [0, TAU), measured
// from celestial north through east. Both are topocentric direction vectors in ICRS equatorial axes; the tiny
// rotation between ICRS north and true-of-date north is negligible over the disk-sized separation involved.
function contactPositionAngle(sunDirection: Vec3, planetDirection: Vec3): Angle {
	const [sunRa, sunDec] = equatorial(sunDirection)
	const [planetRa, planetDec] = equatorial(planetDirection)
	const deltaRa = normalizePI(planetRa - sunRa)
	return normalizeAngle(Math.atan2(Math.sin(deltaRa), Math.cos(sunDec) * Math.tan(planetDec) - Math.sin(sunDec) * Math.cos(deltaRa)))
}

// First root of `f` in (from, to], or undefined when the interval has none. Used for the egress contacts,
// which are the earliest threshold crossing after mid-transit.
function firstRootAfter(f: (time: Time) => number, from: Time, to: Time, step: number, tolerance: number | undefined): Time | undefined {
	return searchRoots(f, from, to, { step, tolerance }).at(0)
}

// Last root of `f` in [from, to), or undefined when the interval has none. Used for the ingress contacts,
// which are the latest threshold crossing before mid-transit.
function lastRootBefore(f: (time: Time) => number, from: Time, to: Time, step: number, tolerance: number | undefined): Time | undefined {
	return searchRoots(f, from, to, { step, tolerance }).at(-1)
}

// Predicts transits of a planet across the Sun over a time window, from one observer.
//
// `planet`, `sun` and `observer` are position/velocity samplers in a shared origin and frame (barycentric
// ICRS): `planet` is the transiting body, `sun` the Sun's centre, `observer` the topocentric observer (pass
// observerState so the diurnal parallax is included). `sunRadius` and `planetRadius` are the bodies' physical
// radii in AU.
//
// Each separation minimum below the sum of the angular radii is a transit: its appulse is the mid-transit and
// impact parameter, its exterior contacts (I, IV) are the crossings of the radius sum on either side, and its
// interior contacts (II, III) — present only for a full, non-grazing transit — are the crossings of the
// radius difference. Contacts carry their limb position angle (north through east) and the total I->IV
// duration. Give a window that fully brackets the transit; a contact left outside the window is reported as
// undefined (the transit was already underway at the boundary). Results are chronological.
export function planetaryTransits(planet: PositionAndVelocityOverTime, sun: PositionAndVelocityOverTime, observer: PositionAndVelocityOverTime, start: Time, stop: Time, { sunRadius, planetRadius, lightTimeIterations = 2, step = DEFAULT_STEP, tolerance }: PlanetaryTransitOptions): PlanetaryTransit[] {
	const span = timeSubtract(stop, start)
	if (span <= 0) return []

	// Cap the step so a short window still gets MIN_INTERVALS samples for the appulse bracket.
	const effectiveStep = Math.min(step, span / MIN_INTERVALS)

	const geometryAt = (time: Time) => transitGeometry(planet, sun, observer, time, lightTimeIterations, sunRadius, planetRadius)
	const separationAt = (time: Time) => geometryAt(time).separation
	// Signed distance of the disks' edges: negative while they overlap. The exterior threshold is the sum of
	// the radii (external tangency), the interior threshold their difference (internal tangency).
	const exteriorGap = (time: Time) => {
		const g = geometryAt(time)
		return g.separation - (g.sunAngularRadius + g.planetAngularRadius)
	}
	const interiorGap = (time: Time) => {
		const g = geometryAt(time)
		return g.separation - (g.sunAngularRadius - g.planetAngularRadius)
	}

	const transits: PlanetaryTransit[] = []

	for (const extremum of searchExtrema(separationAt, start, stop, { step: effectiveStep, tolerance })) {
		if (extremum.kind !== 'minimum') continue

		const mid = geometryAt(extremum.time)
		// A separation minimum that never reaches the radius sum is only an appulse near the Sun, not a transit.
		if (extremum.value >= mid.sunAngularRadius + mid.planetAngularRadius) continue
		// A full transit dips below the radius difference (planet wholly inside); otherwise it merely grazes.
		const full = extremum.value < mid.sunAngularRadius - mid.planetAngularRadius

		// Exterior contacts bracket the appulse; interior contacts exist only for a full transit.
		const exteriorIngress = lastRootBefore(exteriorGap, start, extremum.time, effectiveStep, tolerance)
		const exteriorEgress = firstRootAfter(exteriorGap, extremum.time, stop, effectiveStep, tolerance)
		const interiorIngress = full ? lastRootBefore(interiorGap, start, extremum.time, effectiveStep, tolerance) : undefined
		const interiorEgress = full ? firstRootAfter(interiorGap, extremum.time, stop, effectiveStep, tolerance) : undefined

		// Limb position angles at the exterior contacts, and the total I->IV duration.
		let ingressPositionAngle: Angle | undefined
		let egressPositionAngle: Angle | undefined
		if (exteriorIngress !== undefined) {
			const g = geometryAt(exteriorIngress)
			ingressPositionAngle = contactPositionAngle(g.sunDirection, g.planetDirection)
		}
		if (exteriorEgress !== undefined) {
			const g = geometryAt(exteriorEgress)
			egressPositionAngle = contactPositionAngle(g.sunDirection, g.planetDirection)
		}
		const duration = exteriorIngress !== undefined && exteriorEgress !== undefined ? timeSubtract(exteriorEgress, exteriorIngress) * DAYSEC : undefined

		transits.push({
			time: extremum.time,
			minSeparation: extremum.value,
			sunAngularRadius: mid.sunAngularRadius,
			planetAngularRadius: mid.planetAngularRadius,
			full,
			exteriorIngress,
			interiorIngress,
			interiorEgress,
			exteriorEgress,
			ingressPositionAngle,
			egressPositionAngle,
			duration,
		})
	}

	return transits
}
