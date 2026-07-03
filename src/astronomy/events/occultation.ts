import { DAYSEC, ONE_SECOND } from '../../core/constants'
import type { Vec3 } from '../../math/linear-algebra/vec3'
import { clamp } from '../../math/numerical/math'
import { brentMinimize } from '../../math/numerical/optimization'
import type { Angle } from '../../math/units/angle'
import type { Distance } from '../../math/units/distance'
import { lightTime, type PositionAndVelocityOverTime, separationFrom } from '../coordinates/astrometry'
import { type Time, timeShift, timeSubtract } from '../time/time'
import { searchExtrema, type TimeSearchOptions } from './search'

// Stellar and asteroidal occultation prediction for a single observer, without any shadow-path geometry.
//
// A body (an asteroid, or the Moon treated as a sphere) occults a star when, seen from a fixed observer,
// its disk passes in front of the star. Rather than projecting the body's shadow cylinder onto the Earth
// to derive a ground track, this predictor answers the per-site question directly: over the window it
// samples the topocentric angular separation between the body and the (fixed, at-infinity) star, finds the
// appulse (the separation minimum) with the shared time-domain scanner, and flags it as an occultation
// when the minimum separation drops below the body's angular radius. It is the same sieve-and-refine
// screening as satelliteConjunctions, with the second object replaced by a star direction.
//
// The topocentric direction is essential: the body's diurnal parallax (~8" per AU at the limb) is of the
// same order as the whole occultation track width, so it is what decides whether a given site sees the
// event. It is accounted for by supplying the observer's own barycentric state (e.g. from observerState);
// the star, being at infinity, has no parallax. Light time to the body is corrected by iteration (the body
// is seen where it was when its light left). Annual and diurnal aberration are deliberately omitted: they
// shift the star and the nearby body by almost the same amount, so they cancel to well below a
// milliarcsecond in the differential separation that defines the appulse.
//
// Accuracy is dominated by the body's ephemeris and the star's astrometry, not by this geometry: the track
// is only the body's diameter wide, so a milliarcsecond-level error in either position already moves the
// event by a large fraction of the track. Feed an astrometric-grade orbit and a proper-motion-corrected
// star position. Angles are radians, distances AU, durations seconds.

// A predicted appulse of a star and an occulting body as seen from one observer.
export interface OccultationCandidate {
	// Instant of closest topocentric approach (the separation minimum).
	readonly time: Time
	// Minimum angular separation between the star and the body's centre at that instant, radians.
	readonly separation: Angle
	// Angular radius of the body's disk at that instant, radians. The star is treated as a point.
	readonly angularRadius: Angle
	// Whether the disk covers the star (separation <= angularRadius): a true occultation for this site.
	readonly occultation: boolean
	// Topocentric distance to the body at the appulse, AU.
	readonly distance: Distance
	// Apparent angular speed of the body across the sky at the appulse, radians per day; since the star is
	// fixed this is also the star's speed relative to the disk.
	readonly relativeAngularSpeed: number
	// Seconds the star spends behind the disk for this site's chord (impact parameter `separation`), from the
	// disk radius and the relative angular speed. Undefined when the body misses the star (no occultation) or
	// the relative motion is too slow to resolve a crossing.
	readonly duration?: number
}

// Options for the occultation screener.
export interface OccultationOptions extends TimeSearchOptions {
	// Physical radius of the occulting body, AU. Sets the angular radius (asin(radius / distance)) against
	// which the appulse is tested. Defaults to 0, which reports every appulse as a near-miss (never an
	// occultation) — pass the real radius to detect true occultations.
	readonly radius?: Distance
	// Only report appulses whose minimum separation is at or below this angle, radians. Defaults to
	// Number.POSITIVE_INFINITY, which returns every separation minimum in the window.
	readonly maxSeparation?: Angle
	// Fixed-point iterations for the light-time correction to the body. Defaults to 2, enough for
	// interplanetary distances; 0 disables it (geometric, uncorrected position).
	readonly lightTimeIterations?: number
}

// Central-difference half-step for the apparent angular speed: 1 s. Small enough that the body's sky
// motion is locally linear, large enough to stay well above the angle noise of the separation.
const DERIVATIVE_STEP = ONE_SECOND
// Default coarse sampling step: 1 min. Fine enough to bracket the appulse of a fast near-Earth asteroid,
// whose approach inside a degree can last only a few minutes; widen it for slow, distant bodies.
const DEFAULT_STEP = 60 * ONE_SECOND
// Minimum number of coarse intervals across the window. searchExtrema needs a sample on each side of a
// minimum to bracket it, so a window shorter than a few steps would otherwise return nothing; the effective
// step is capped at span / this so even a sub-step window is sampled densely enough to catch its appulse.
const MIN_INTERVALS = 4

// Topocentric direction from the observer to the body at reception time `time`, light-time corrected.
//
// The observer is sampled at `time` (reception); the body is sampled at the retarded emission time
// `time - tau`, where tau is the light travel time over the current observer-body distance, refined by
// fixed-point iteration. `target` and `observer` must share one origin (typically barycentric ICRS); the
// common origin cancels in the difference. Returns a freshly allocated non-unit vector (its length is the
// topocentric distance in AU).
function topocentricDirection(target: PositionAndVelocityOverTime, observer: PositionAndVelocityOverTime, time: Time, iterations: number): Vec3 {
	const [ox, oy, oz] = observer(time)[0]

	let emission = time
	let direction: Vec3 = [0, 0, 0]
	for (let k = 0; k <= iterations; k++) {
		const tp = target(emission)[0]
		direction = [tp[0] - ox, tp[1] - oy, tp[2] - oz]
		emission = timeShift(time, -lightTime(direction))
	}

	return direction
}

// A separation minimum located in the window: the refined appulse instant and the separation there.
interface SeparationMinimum {
	readonly time: Time
	readonly value: number
}

// Refines a separation minimum in a boundary interval [from, to] that searchExtrema cannot bracket from its
// endpoint sample. `outerValue` is the separation at the interval's outer window endpoint, which the caller
// has already found to be the lower of the two ends; probing only in that case also guarantees searchExtrema
// does not fire on the inner sample, so no duplicate is produced. Returns the interior minimum only when the
// interval genuinely dips below the outer endpoint — a monotonic slope toward the endpoint is the appulse
// peak sitting at or beyond the boundary, not an in-window event. Evaluates the separation only within
// [from, to], so a bounded/interpolated sampler is never queried outside the requested window.
function boundaryMinimum(separationAt: (time: Time) => number, from: Time, to: Time, outerValue: number, tolerance: number | undefined): SeparationMinimum | undefined {
	const width = timeSubtract(to, from)
	const result = brentMinimize((x) => separationAt(timeShift(from, x)), 0, width, { tolerance })
	if (!(result.value < outerValue)) return undefined
	return { time: timeShift(from, result.minimum), value: result.value }
}

// Screens a star for occultations by a moving body over a time window, from one observer.
//
// `target` and `observer` are position/velocity samplers in a shared origin and frame (barycentric ICRS):
// `target` is the occulting body, `observer` the topocentric observer (pass observerState so the diurnal
// parallax is included). `star` is the ICRS direction toward the star (need not be a unit vector); its
// proper motion and parallax should already be folded in by the caller if sub-arcsecond accuracy matters.
//
// The topocentric star-body separation is sampled at the coarse `step`, each local minimum is refined, and
// every minimum at or below `maxSeparation` is returned as a candidate carrying the appulse geometry. A
// candidate is an occultation when its separation is within the body's angular radius (from `radius`); the
// chord duration then follows from the radius and the apparent angular speed. Candidates are chronological.
// The coarse `step` must be finer than the approach it should catch.
//
// The separation, and therefore `target`/`observer`, is only ever evaluated within [start, stop]: the shared
// scanner covers the interior intervals, while the first and last intervals — whose minimum would sit next
// to a window endpoint the scanner cannot bracket — are refined by an in-window bounded minimization. This
// keeps callers backed by bounded or interpolated states valid over exactly the requested window.
export function occultationCandidates(target: PositionAndVelocityOverTime, star: Vec3, observer: PositionAndVelocityOverTime, start: Time, stop: Time, { radius = 0, maxSeparation = Number.POSITIVE_INFINITY, lightTimeIterations = 2, step = DEFAULT_STEP, tolerance }: OccultationOptions = {}): OccultationCandidate[] {
	const separationAt = (time: Time) => separationFrom(topocentricDirection(target, observer, time, lightTimeIterations), star)
	const span = timeSubtract(stop, start)
	if (span <= 0) return []

	// Cap the step so a short window still gets MIN_INTERVALS samples.
	const effectiveStep = Math.min(step, span / MIN_INTERVALS)

	// Collect separation minima in chronological order. The first interval is probed when its outer endpoint
	// (start) is the lower coarse sample, then the scanner covers the interior, then the last interval is
	// probed when its outer endpoint (stop) is the lower sample.
	const minima: SeparationMinimum[] = []

	const startValue = separationAt(start)
	const firstInner = timeShift(start, effectiveStep)
	if (startValue < separationAt(firstInner)) {
		const first = boundaryMinimum(separationAt, start, firstInner, startValue, tolerance)
		if (first) minima.push(first)
	}

	for (const extremum of searchExtrema(separationAt, start, stop, { step: effectiveStep, tolerance })) {
		if (extremum.kind === 'minimum') minima.push({ time: extremum.time, value: extremum.value })
	}

	const stopValue = separationAt(stop)
	const lastInner = timeShift(stop, -effectiveStep)
	if (stopValue < separationAt(lastInner)) {
		const last = boundaryMinimum(separationAt, lastInner, stop, stopValue, tolerance)
		if (last) minima.push(last)
	}

	const candidates: OccultationCandidate[] = []

	for (const minimum of minima) {
		const separation = minimum.value
		if (separation > maxSeparation) continue

		// Topocentric distance and angular radius of the disk at the refined appulse instant.
		const direction = topocentricDirection(target, observer, minimum.time, lightTimeIterations)
		const distance = Math.hypot(direction[0], direction[1], direction[2])
		const angularRadius = Math.asin(clamp(radius / distance, 0, 1))

		// Apparent angular speed by finite difference of the topocentric direction (star fixed), rad/day. The
		// stencil is clamped into [start, stop] so a near-boundary appulse is not evaluated outside the window;
		// it stays centred when the appulse is at least DERIVATIVE_STEP from both ends.
		const beforeTime = timeSubtract(minimum.time, start) >= DERIVATIVE_STEP ? timeShift(minimum.time, -DERIVATIVE_STEP) : start
		const afterTime = timeSubtract(stop, minimum.time) >= DERIVATIVE_STEP ? timeShift(minimum.time, DERIVATIVE_STEP) : stop
		const stencil = timeSubtract(afterTime, beforeTime)
		const beforeDir = topocentricDirection(target, observer, beforeTime, lightTimeIterations)
		const afterDir = topocentricDirection(target, observer, afterTime, lightTimeIterations)
		const relativeAngularSpeed = stencil > 0 ? separationFrom(beforeDir, afterDir) / stencil : 0

		const occultation = separation <= angularRadius
		// Chord across the disk at impact parameter `separation`, divided by the relative angular speed.
		let duration: number | undefined
		if (occultation && relativeAngularSpeed > 0) {
			const halfChord = Math.sqrt(angularRadius * angularRadius - separation * separation)
			duration = ((2 * halfChord) / relativeAngularSpeed) * DAYSEC
		}

		candidates.push({ time: minimum.time, separation, angularRadius, occultation, distance, relativeAngularSpeed, duration })
	}

	return candidates
}
