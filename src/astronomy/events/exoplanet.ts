import { SPEED_OF_LIGHT_AU_DAY } from '../../core/constants'
import { type Vec3, vecDot, vecNormalize } from '../../math/linear-algebra/vec3'
import type { PositionOverTime } from '../coordinates/astrometry'
import { barycentricJulianDate, receptionFromBarycentricJulianDate } from '../coordinates/correction'
import { type EphemerisPath, SOLAR_SYSTEM_BARYCENTER, sameEphemerisEndpoint } from '../ephemeris/path'
import type { GeographicPosition } from '../observer/location'
import { type Time, Timescale, tdb, time, timeShift, timeSubtract, utc } from '../time/time'
import { type VisibilityConstraints, type VisibilityInterval, type VisibilitySources, visibilityWindows } from './visibility'

// Observable exoplanet transits from a published linear ephemeris Tn = T0 + n·P. Mid-transit, ingress
// (first contact), and egress (fourth contact) are predicted on BJD_TDB, the barycentric clock of the
// ephemeris, with the 1σ timing uncertainty σ²(Tn) = σ²(T0) + n²σ²(P) + 2n·Cov(T0, P). Each event is
// then mapped to the UTC instant its light reaches the observer by inverting the BJD_TDB correction,
// and the required observing span (transit plus baselines plus a timing margin) is cut by the
// visibilityWindows limits. Times are days unless documented otherwise, angles are radians, and the
// star is a fixed ICRS direction. The model is strictly periodic: transit-timing variations, orbital
// decay, and apsidal precession are not modeled. Results are freshly allocated.

// Origin of the light-time correction applied to the reference epoch: the solar-system barycenter
// (BJD) or the Sun's center (HJD).
export type TransitEpochReference = 'barycentric' | 'heliocentric'

// A published linear transit ephemeris. External catalogs are converted into this shape by their
// adapters; the prediction itself never parses catalog fields.
export interface TransitEphemeris {
	// Reference mid-transit epoch T0. Its scale names the clock: TDB for BJD_TDB, while UTC, TT, and
	// TCB stamps are converted to TDB at T0 before cycles are counted.
	readonly epoch: Time
	// Origin of T0's light-time correction. A heliocentric epoch needs an SSB-to-Sun path.
	readonly reference: TransitEpochReference
	// Orbital period P in days, positive.
	readonly period: number
	// Total transit duration T14 (first to fourth contact) in days, in (0, period).
	readonly duration: number
	// 1σ uncertainty of T0 in days. Omitted means 0 and is flagged.
	readonly epochUncertainty?: number
	// 1σ uncertainty of P in days. Omitted means 0 and is flagged.
	readonly periodUncertainty?: number
	// Covariance Cov(T0, P) in days², with |Cov| ≤ σ(T0)·σ(P). Omitted means 0 and is flagged when
	// the period has an uncertainty.
	readonly covariance?: number
	// 1σ uncertainty of T14 in days, independent of T0 and P. Omitted means 0 and is flagged.
	readonly durationUncertainty?: number
}

// Diagnostic flags of a prediction: which uncertainty inputs were missing and taken as 0.
export type ExoplanetTransitFlag = 'missingEpochUncertainty' | 'missingPeriodUncertainty' | 'missingCovariance' | 'missingDurationUncertainty'

// Why part or all of an event's required span cannot be observed. 'searchWindow' means the span
// extends beyond the search window, 'targetAltitude' the altitude or airmass limit, 'sunAltitude'
// twilight, 'sunSeparation' and 'moonSeparation' the avoidance angles, and 'timingUncertainty' a
// mid-transit uncertainty above options.maximumUncertainty.
export type ExoplanetTransitLimitation = 'searchWindow' | 'targetAltitude' | 'sunAltitude' | 'sunSeparation' | 'moonSeparation' | 'timingUncertainty'

// One predicted transit and its local observability.
export interface ExoplanetTransitEvent {
	// Cycle number n relative to T0; negative before T0.
	readonly cycle: number
	// Mid-transit Tn on BJD_TDB.
	readonly center: Time
	// First contact Tn − T14/2 on BJD_TDB.
	readonly ingress: Time
	// Fourth contact Tn + T14/2 on BJD_TDB.
	readonly egress: Time
	// 1σ uncertainty of center, in days.
	readonly centerUncertainty: number
	// 1σ uncertainty of ingress and of egress, √(σ²(Tn) + σ²(T14)/4), in days.
	readonly contactUncertainty: number
	// UTC reception instant of ingress at the observer.
	readonly observedIngress: Time
	// UTC reception instant of mid-transit at the observer.
	readonly observedCenter: Time
	// UTC reception instant of egress at the observer.
	readonly observedEgress: Time
	// UTC start of the required span: ingress − baselineBefore − timingSigma·contactUncertainty.
	readonly start: Time
	// UTC end of the required span: egress + baselineAfter + timingSigma·contactUncertainty.
	readonly end: Time
	// Chronological UTC stretches of the required span, inside the search window, that satisfy every constraint.
	readonly visible: readonly VisibilityInterval[]
	// Visible fraction of the whole required span, on [0, 1].
	readonly coverage: number
	// Visible fraction of observed ingress to observed egress, on [0, 1].
	readonly transitCoverage: number
	// Coverage reaches options.minimumCoverage and the timing uncertainty is acceptable.
	readonly feasible: boolean
	// Every reason that removed part of the required span or disqualified the event, in the
	// ExoplanetTransitLimitation declaration order. Possibly non-empty for a feasible event when
	// minimumCoverage is below 1.
	readonly limitations: readonly ExoplanetTransitLimitation[]
}

// Transit predictions over a search window.
export interface ExoplanetTransitPrediction {
	// T0 converted to BJD_TDB, the origin of every cycle.
	readonly epoch: Time
	// Chronological events whose required span overlaps the search window, feasible or not.
	readonly events: readonly ExoplanetTransitEvent[]
	// Missing-uncertainty diagnostics of the ephemeris.
	readonly flags: readonly ExoplanetTransitFlag[]
}

// Light-time, visibility, and planning options of exoplanetTransits.
export interface ExoplanetTransitOptions extends VisibilitySources {
	// Observing limits applied over each required span; see visibilityWindows. sunAt and moonAt are
	// the geocentric (or topocentric) direction callbacks of the inherited sources.
	readonly constraints?: VisibilityConstraints
	// ICRS-oriented direction of the star for the visibility limits. Defaults to the fixed `direction`.
	readonly targetAt?: PositionOverTime
	// SSB-to-Sun path (AU). Applies the solar Shapiro term to the light-time inversion and converts a
	// heliocentric T0; required for a heliocentric epoch.
	readonly sun?: EphemerisPath
	// Non-negative out-of-transit baseline before ingress, in days. Defaults to 0.
	readonly baselineBefore?: number
	// Non-negative out-of-transit baseline after egress, in days. Defaults to 0.
	readonly baselineAfter?: number
	// Non-negative multiple k of the 1σ contact uncertainty that widens the required span on each side. Defaults to 1.
	readonly timingSigma?: number
	// Fraction of the required span, on [0, 1], that must be visible for a feasible event. Defaults to 1.
	readonly minimumCoverage?: number
	// Largest acceptable 1σ mid-transit uncertainty, in days. Omitted means unlimited.
	readonly maximumUncertainty?: number
	// Most events a search may return. Defaults to 10000.
	readonly maximumEvents?: number
}

// Default cap on the events of one search, which bounds allocation and visibility work.
const DEFAULT_MAXIMUM_EVENTS = 10000

// Shortest constrained loss, in days (≈ 86 µs), that counts as removing time from a span. Rounding
// of an unconstrained window is far below it, and any real constraint crossing is far above it.
const LOSS_TOLERANCE = 1e-9

// 1σ uncertainty in days of the mid-transit time of cycle `cycle` of a linear ephemeris:
// σ²(Tn) = σ²(T0) + n²σ²(P) + 2n·Cov(T0, P). epochUncertainty and periodUncertainty are 1σ in days and
// covariance is Cov(T0, P) in days². The variance is quadratic in n with its minimum at
// n = −Cov/σ²(P): a positive covariance raises later cycles and lowers earlier ones. Rounding of a
// fully correlated pair (|Cov| = σ(T0)σ(P)) is clamped at 0 instead of yielding NaN.
export function transitTimingUncertainty(cycle: number, epochUncertainty: number = 0, periodUncertainty: number = 0, covariance: number = 0): number {
	const variance = epochUncertainty * epochUncertainty + cycle * (cycle * periodUncertainty * periodUncertainty + 2 * covariance)
	return Math.sqrt(Math.max(0, variance))
}

// Constraint groups attributed separately, in the ExoplanetTransitLimitation order.
type ConstraintGroup = readonly [ExoplanetTransitLimitation, VisibilityConstraints]

// Splits the constraints into the groups that can be blamed for a loss of visible time.
function constraintGroups(constraints: VisibilityConstraints) {
	const groups: ConstraintGroup[] = []
	const { minimumAltitude, maximumAirmass, maximumSunAltitude, minimumSunSeparation, minimumMoonSeparation } = constraints
	if (minimumAltitude !== undefined || maximumAirmass !== undefined) groups.push(['targetAltitude', { minimumAltitude, maximumAirmass }])
	if (maximumSunAltitude !== undefined) groups.push(['sunAltitude', { maximumSunAltitude }])
	if (minimumSunSeparation !== undefined) groups.push(['sunSeparation', { minimumSunSeparation }])
	if (minimumMoonSeparation !== undefined) groups.push(['moonSeparation', { minimumMoonSeparation }])
	return groups
}

// Total length in days of the intervals, optionally clipped to [from, to].
function coveredDays(intervals: readonly VisibilityInterval[], from?: Time, to?: Time) {
	let total = 0

	for (const interval of intervals) {
		const start = from !== undefined && timeSubtract(from, interval.start) > 0 ? from : interval.start
		const end = to !== undefined && timeSubtract(to, interval.end) < 0 ? to : interval.end
		const length = timeSubtract(end, start)
		if (length > 0) total += length
	}

	return total
}

// Predicts the transits of an exoplanet whose required observing span overlaps [start, end] and
// classifies their local observability.
//
// ephemeris is the linear ephemeris; T0 is converted to TDB and, for a heliocentric epoch, shifted to
// BJD by (r☉ · n) / c with r☉ the SSB-to-Sun position at T0. direction is the ICRS direction of the
// star, normalized here, used for the light time and, unless options.targetAt is given, for the
// visibility limits. observer is the SSB-centered path of the site (as for barycentricJulianDate) and
// location the same site for the topocentric TDB-TT term and the horizon. start and end bound the
// search in any scale; they are converted to UTC at the site.
//
// Each cycle's contacts are offset on BJD_TDB by T14/2 from the center, and the required span adds
// the baselines and timingSigma·contactUncertainty outside them. Span endpoints and contacts are mapped
// to UTC reception instants with receptionFromBarycentricJulianDate; since BJD_TDB grows monotonically
// with reception time, the overlap with the search window is decided on BJD_TDB without margins. The
// visible part of each span is visibilityWindows over the span clipped to the window; when a
// constraint removes time, each constraint group is searched alone to name the limitation. The coarse
// step must resolve every constraint crossing inside a span.
//
// Throws RangeError for a non-positive or non-finite period, a duration outside (0, period), a
// covariance larger than σ(T0)·σ(P), a timing margin k·σ(P) not below P (event spans would no longer
// be ordered), a heliocentric epoch without options.sun, a solar or lunar limit without its direction
// callback, or more than options.maximumEvents events; a non-SSB-centered path throws Error. An empty
// or reversed search window returns no events.
export function exoplanetTransits(ephemeris: TransitEphemeris, direction: Vec3, observer: EphemerisPath, location: GeographicPosition, start: Time, end: Time, options: ExoplanetTransitOptions = {}): ExoplanetTransitPrediction {
	const { period, duration, reference } = ephemeris
	const epochUncertainty = ephemeris.epochUncertainty ?? 0
	const periodUncertainty = ephemeris.periodUncertainty ?? 0
	const covariance = ephemeris.covariance ?? 0
	const durationUncertainty = ephemeris.durationUncertainty ?? 0
	const { constraints = {}, sun, baselineBefore = 0, baselineAfter = 0, timingSigma = 1, minimumCoverage = 1, maximumUncertainty, maximumEvents = DEFAULT_MAXIMUM_EVENTS } = options

	// A non-positive period never advances the cycle scan, and a contact pair wider than the period
	// would let neighbouring events swap order.
	if (!(period > 0 && Number.isFinite(period))) throw new RangeError('transit period must be positive and finite')
	if (!(duration > 0 && duration < period)) throw new RangeError('transit duration must be within (0, period)')
	// An over-unity correlation makes the variance negative for some cycles: a silent 0 or NaN uncertainty.
	if (!(covariance * covariance <= epochUncertainty * epochUncertainty * periodUncertainty * periodUncertainty * (1 + 1e-12))) throw new RangeError('transit epoch-period covariance exceeds the product of the uncertainties')
	// Span edges must grow with the cycle for the bounded cycle scan to terminate on the right cycles.
	if (!(timingSigma * periodUncertainty < period)) throw new RangeError('timing margin per cycle must be smaller than the period')
	if (reference === 'heliocentric' && sun === undefined) throw new RangeError('sun path is required for a heliocentric transit epoch')
	if (sun !== undefined && !sameEphemerisEndpoint(sun.center, SOLAR_SYSTEM_BARYCENTER)) throw new Error('sun ephemeris path must be SSB-centered')
	if ((constraints.maximumSunAltitude !== undefined || constraints.minimumSunSeparation !== undefined) && options.sunAt === undefined) throw new RangeError('sun direction is required when a solar limit is set')
	if (constraints.minimumMoonSeparation !== undefined && options.moonAt === undefined) throw new RangeError('moon direction is required when a lunar separation limit is set')

	const flags: ExoplanetTransitFlag[] = []
	if (ephemeris.epochUncertainty === undefined) flags.push('missingEpochUncertainty')
	if (ephemeris.periodUncertainty === undefined) flags.push('missingPeriodUncertainty')
	if (ephemeris.covariance === undefined && ephemeris.periodUncertainty !== undefined) flags.push('missingCovariance')
	if (ephemeris.durationUncertainty === undefined) flags.push('missingDurationUncertainty')

	const n = vecNormalize(direction)
	const lightTime = sun === undefined ? undefined : { sun }
	// A barycentric instant has no site: drop any location so no topocentric TDB term leaks in.
	const t0 = tdb(ephemeris.epoch)
	let epoch = time(t0.day, t0.fraction, Timescale.TDB)
	if (reference === 'heliocentric') epoch = timeShift(epoch, vecDot(sun!.stateAt(epoch)[0], n) / SPEED_OF_LIGHT_AU_DAY)

	const from = timeShift(utc(start), 0)
	from.location = location
	const to = timeShift(utc(end), 0)
	to.location = location
	if (!(timeSubtract(to, from) > 0)) return { epoch, events: [], flags }

	// Search window on BJD_TDB, as day offsets from T0.
	const lower = timeSubtract(barycentricJulianDate(from, n, observer, lightTime).time, epoch)
	const upper = timeSubtract(barycentricJulianDate(to, n, observer, lightTime).time, epoch)

	const halfDuration = duration / 2
	const contactSigma = (cycle: number) => Math.hypot(transitTimingUncertainty(cycle, epochUncertainty, periodUncertainty, covariance), durationUncertainty / 2)
	// Span edges relative to T0; both grow with the cycle because timingSigma·σ(P) < P.
	const spanEnd = (cycle: number) => cycle * period + halfDuration + baselineAfter + timingSigma * contactSigma(cycle)
	const spanStart = (cycle: number) => cycle * period - halfDuration - baselineBefore - timingSigma * contactSigma(cycle)

	// The margin-free guesses bound the first cycle from above and the last from below; widening steps
	// add the timing margin and are counted against the event cap.
	let first = Math.ceil((lower - halfDuration - baselineAfter) / period)
	let last = Math.floor((upper + halfDuration + baselineBefore) / period)
	let steps = 0
	while (spanEnd(first - 1) >= lower && ++steps <= maximumEvents) first--
	while (spanStart(last + 1) <= upper && ++steps <= maximumEvents) last++
	if (steps > maximumEvents || last - first + 1 > maximumEvents) throw new RangeError('too many transit events in the search window')

	const targetAt = options.targetAt ?? (() => n)
	const groups = constraintGroups(constraints)
	const events: ExoplanetTransitEvent[] = []

	const reception = (offset: number) => receptionFromBarycentricJulianDate(timeShift(epoch, offset), n, observer, location, lightTime)

	for (let cycle = first; cycle <= last; cycle++) {
		const centerOffset = cycle * period
		const centerUncertainty = transitTimingUncertainty(cycle, epochUncertainty, periodUncertainty, covariance)
		const contactUncertainty = contactSigma(cycle)
		const startOffset = spanStart(cycle)
		const endOffset = spanEnd(cycle)

		const observedIngress = reception(centerOffset - halfDuration)
		const observedCenter = reception(centerOffset)
		const observedEgress = reception(centerOffset + halfDuration)
		const spanStartTime = reception(startOffset)
		const spanEndTime = reception(endOffset)

		const limitations: ExoplanetTransitLimitation[] = []
		const clippedStart = startOffset < lower ? from : spanStartTime
		const clippedEnd = endOffset > upper ? to : spanEndTime
		const clipped = startOffset < lower || endOffset > upper
		const clippedLength = timeSubtract(clippedEnd, clippedStart)
		const visible = clippedLength > 0 ? visibilityWindows(targetAt, location, clippedStart, clippedEnd, constraints, options) : []
		const removed = clippedLength > 0 && coveredDays(visible) < clippedLength - LOSS_TOLERANCE

		if (clipped) limitations.push('searchWindow')

		if (removed) {
			for (const [limitation, group] of groups) {
				const alone = visibilityWindows(targetAt, location, clippedStart, clippedEnd, group, options)
				if (coveredDays(alone) < clippedLength - LOSS_TOLERANCE) limitations.push(limitation)
			}
		}

		const uncertain = maximumUncertainty !== undefined && !(centerUncertainty <= maximumUncertainty)
		if (uncertain) limitations.push('timingUncertainty')

		// An unclipped span without losses is exactly covered; rounding must not fail a full-coverage requirement.
		const coverage = !clipped && !removed ? 1 : Math.min(1, coveredDays(visible) / timeSubtract(spanEndTime, spanStartTime))
		const transitCoverage = !clipped && !removed ? 1 : Math.min(1, coveredDays(visible, observedIngress, observedEgress) / timeSubtract(observedEgress, observedIngress))

		events.push({
			cycle,
			center: timeShift(epoch, centerOffset),
			ingress: timeShift(epoch, centerOffset - halfDuration),
			egress: timeShift(epoch, centerOffset + halfDuration),
			centerUncertainty,
			contactUncertainty,
			observedIngress,
			observedCenter,
			observedEgress,
			start: spanStartTime,
			end: spanEndTime,
			visible,
			coverage,
			transitCoverage,
			feasible: !uncertain && coverage >= minimumCoverage,
			limitations,
		})
	}

	return { epoch, events, flags }
}
