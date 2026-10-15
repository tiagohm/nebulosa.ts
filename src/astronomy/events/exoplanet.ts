import { DAYSEC, ELB, ELG, SPEED_OF_LIGHT_AU_DAY } from '../../core/constants'
import { type Vec3, vecDot, vecNormalize } from '../../math/linear-algebra/vec3'
import { twoProduct } from '../../math/numerical/math'
import type { PositionOverTime } from '../coordinates/astrometry'
import { barycentricJulianDate, receptionFromBarycentricJulianDate } from '../coordinates/correction'
import { type EphemerisPath, SOLAR_SYSTEM_BARYCENTER, sameEphemerisEndpoint } from '../ephemeris/path'
import type { GeographicPosition } from '../observer/location'
import { type Time, Timescale, tdb, time, timeShift, timeSubtract, utc } from '../time/time'
import { type VisibilityConstraints, type VisibilityInterval, type VisibilitySources, visibilityWindows } from './visibility'

// Observable exoplanet transits from a published linear ephemeris Tn = T0 + n·P. The cycles advance on
// the ephemeris' own clock and origin, and each mid-transit, ingress (first contact), and egress (fourth
// contact) is then converted to BJD_TDB at its own instant, with the 1σ timing uncertainty
// σ²(Tn) = σ²(T0) + n²σ²(P) + 2n·Cov(T0, P). Each event is
// then mapped to the UTC instant its light reaches the observer by inverting the BJD_TDB correction,
// and the required observing span (transit plus baselines plus a timing margin) is cut by the
// visibilityWindows limits. Times are days unless documented otherwise, angles are radians, and the
// star is a fixed ICRS direction. The model is strictly periodic: transit-timing variations, orbital
// decay, and apsidal precession are not modeled. transitEphemerisUncertainty predicts a single cycle
// on the ephemeris' own clock, without conversion. Results are freshly allocated.

// Origin of the light-time correction applied to the reference epoch: the solar-system barycenter
// (BJD) or the Sun's center (HJD).
export type TransitEpochReference = 'barycentric' | 'heliocentric'

// A published linear transit ephemeris. External catalogs are converted into this shape by their
// adapters; the prediction itself never parses catalog fields.
export interface TransitEphemeris {
	// Reference mid-transit epoch T0. Its scale names the clock of the ephemeris: TDB for BJD_TDB.
	// UTC, TAI, TT, and UT1 epochs are moved to TDB at T0 and their days are taken as TDB days (leap
	// seconds are clock labels, not elapsed time); TCB and TCG days are rescaled to TDB by 1 − L_B or
	// 1 − L_G, together with the duration, uncertainties, and covariance.
	readonly epoch: Time
	// Origin of the light-time correction of every predicted instant. A heliocentric (HJD) ephemeris
	// is propagated on the Sun's clock and each instant is moved to BJD with the Sun's position at that
	// instant, so it needs an SSB-to-Sun path.
	readonly reference: TransitEpochReference
	// Orbital period P in days of the epoch's scale, positive.
	readonly period: number
	// Total transit duration T14 (first to fourth contact) in days of the epoch's scale, in (0, period).
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
	// Part of the transit itself is visible, transitCoverage reaches options.minimumTransitCoverage,
	// coverage reaches options.minimumCoverage, and the timing uncertainty is acceptable.
	readonly feasible: boolean
	// Every reason that removed part of the required span or disqualified the event, in the
	// ExoplanetTransitLimitation declaration order. Possibly non-empty for a feasible event when a
	// minimum coverage is below 1.
	readonly limitations: readonly ExoplanetTransitLimitation[]
}

// Transit predictions over a search window.
export interface ExoplanetTransitPrediction {
	// T0 converted to BJD_TDB.
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
	// SSB-to-Sun path (AU). Applies the solar Shapiro term to the light-time inversion and moves the
	// instants of a heliocentric ephemeris to BJD; required for a heliocentric ephemeris.
	readonly sun?: EphemerisPath
	// Non-negative out-of-transit baseline before ingress, in days. Defaults to 0.
	readonly baselineBefore?: number
	// Non-negative out-of-transit baseline after egress, in days. Defaults to 0.
	readonly baselineAfter?: number
	// Non-negative multiple k of the 1σ contact uncertainty that widens the required span on each side. Defaults to 1.
	readonly timingSigma?: number
	// Fraction of the required span, on [0, 1], that must be visible for a feasible event. Defaults to 1.
	readonly minimumCoverage?: number
	// Fraction of ingress to egress, on (0, 1], that must be visible for a feasible event. Defaults to 1.
	// Some of the transit must be visible even when this is 0, so baselines alone never qualify.
	readonly minimumTransitCoverage?: number
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

// Rate d(TDB)/d(scale) that turns days of an ephemeris clock into TDB days. TCB and TCG run faster by
// the IAU 2006 B3 and 2000 B1.9 defining constants L_B and L_G; the other scales tick SI seconds at
// the TT rate, which TDB matches on average up to its ±1.7 ms periodic terms.
function tdbRate(scale: Timescale) {
	return scale === Timescale.TCB ? 1 - ELB : scale === Timescale.TCG ? 1 - ELG : 1
}

// Visible fraction of a span, snapped to 1 when the loss is below LOSS_TOLERANCE so rounding cannot
// fail a full-coverage requirement.
function coverageFraction(covered: number, total: number) {
	return total - covered < LOSS_TOLERANCE ? 1 : covered / total
}

// 1σ uncertainty in days of the mid-transit time of cycle `cycle` of a linear ephemeris:
// σ²(Tn) = σ²(T0) + n²σ²(P) + 2n·Cov(T0, P). epochUncertainty and periodUncertainty are 1σ in days and
// covariance is Cov(T0, P) in days². The variance is quadratic in n with its minimum at
// n = −Cov/σ²(P): a positive covariance raises later cycles and lowers earlier ones. Rounding of a
// fully correlated pair (|Cov| = σ(T0)σ(P)) is clamped at 0 instead of yielding NaN.
export function transitTimingUncertainty(cycle: number, epochUncertainty: number = 0, periodUncertainty: number = 0, covariance: number = 0): number {
	const variance = epochUncertainty * epochUncertainty + cycle * (cycle * periodUncertainty * periodUncertainty + 2 * covariance)
	return Math.sqrt(Math.max(0, variance))
}

// Whether |Cov(T0, P)| ≤ σ(T0)·σ(P), with a relative slack of 1e-12 on the squares for the rounding
// of a fully correlated pair. A larger covariance makes the variance negative for some cycles.
function covarianceWithinBounds(epochUncertainty: number, periodUncertainty: number, covariance: number) {
	return covariance * covariance <= epochUncertainty * epochUncertainty * periodUncertainty * periodUncertainty * (1 + 1e-12)
}

// Missing-uncertainty diagnostics of an ephemeris, in the ExoplanetTransitFlag declaration order.
function missingUncertaintyFlags(ephemeris: TransitEphemeris) {
	const flags: ExoplanetTransitFlag[] = []
	if (ephemeris.epochUncertainty === undefined) flags.push('missingEpochUncertainty')
	if (ephemeris.periodUncertainty === undefined) flags.push('missingPeriodUncertainty')
	if (ephemeris.covariance === undefined && ephemeris.periodUncertainty !== undefined) flags.push('missingCovariance')
	if (ephemeris.durationUncertainty === undefined) flags.push('missingDurationUncertainty')
	return flags
}

// Diagnostic flags of a single-cycle ephemeris prediction: the missing-uncertainty flags, and
// 'covarianceOutOfBounds' when |Cov(T0, P)| exceeds σ(T0)·σ(P) beyond rounding.
export type TransitEphemerisFlag = ExoplanetTransitFlag | 'covarianceOutOfBounds'

// Mid-transit and contacts of one cycle of a linear ephemeris, on the ephemeris' own clock.
export interface TransitEphemerisPrediction {
	// Integer cycle number n relative to T0; negative before T0.
	readonly cycle: number
	// Mid-transit Tn = T0 + n·P, in the scale and light-time reference of the epoch (BJD_TDB for a
	// BJD_TDB ephemeris), with the epoch's providers and location.
	readonly center: Time
	// First contact Tn − T14/2, on the same clock as center.
	readonly ingress: Time
	// Fourth contact Tn + T14/2, on the same clock as center.
	readonly egress: Time
	// 1σ uncertainty of center, √(σ²(T0) + n²σ²(P) + 2n·Cov(T0, P)), in seconds of the epoch's scale.
	// NaN when the covariance is out of bounds.
	readonly centerUncertainty: number
	// 1σ uncertainty of ingress and of egress, √(σ²(Tn) + σ²(T14)/4), in seconds of the epoch's scale.
	// Undefined when the duration uncertainty is not given, since T14 is then not known to be
	// independent of T0 and P; NaN when the covariance is out of bounds.
	readonly contactUncertainty?: number
	// False when the covariance is out of bounds and the uncertainties are NaN.
	readonly valid: boolean
	// Missing-input and validity diagnostics, in the TransitEphemerisFlag declaration order.
	readonly flags: readonly TransitEphemerisFlag[]
}

// Predicts mid-transit and contacts of cycle n of a linear ephemeris with the 1σ timing uncertainty
// σ²(Tn) = σ²(T0) + n²σ²(P) + 2n·Cov(T0, P), keeping the epoch's own clock: no scale conversion, TCB
// or TCG rescaling, or light-time reference change is applied (see exoplanetTransits for BJD_TDB
// output and local reception). ephemeris.period, duration, and uncertainties are days of the epoch's
// scale and covariance days². cycle must be a safe integer.
//
// n·P is formed exactly with twoProduct and split into whole days, added to the epoch's day part,
// and a remainder added to its fraction, so a far-future cycle keeps the two-part precision of T0 (a
// rounding of about 1e-16 day instead of the ulp of n·P). Uncertainties are returned in seconds; a
// variance below zero only through rounding is clamped to 0, while a covariance beyond σ(T0)·σ(P)
// gives NaN uncertainties, valid false, and the 'covarianceOutOfBounds' flag. Missing uncertainties
// count as 0 and are flagged. Results are freshly allocated.
//
// Throws RangeError for a non-integer cycle, which would silently name an instant that is not a transit.
export function transitEphemerisUncertainty(ephemeris: TransitEphemeris, cycle: number): TransitEphemerisPrediction {
	if (!Number.isSafeInteger(cycle)) throw new RangeError('transit cycle must be a safe integer')

	const { epoch, period, duration, epochUncertainty = 0, periodUncertainty = 0, covariance = 0, durationUncertainty } = ephemeris

	const [product, error] = twoProduct(cycle, period)
	const days = Math.round(product)
	const offset = product - days + error
	const halfDuration = duration / 2

	const flags: TransitEphemerisFlag[] = missingUncertaintyFlags(ephemeris)
	const valid = covarianceWithinBounds(epochUncertainty, periodUncertainty, covariance)
	if (!valid) flags.push('covarianceOutOfBounds')

	const centerSigma = valid ? transitTimingUncertainty(cycle, epochUncertainty, periodUncertainty, covariance) : Number.NaN
	const contactSigma = durationUncertainty === undefined ? undefined : Math.hypot(centerSigma, durationUncertainty / 2)

	return {
		cycle,
		center: timeShift(epoch, offset, days),
		ingress: timeShift(epoch, offset - halfDuration, days),
		egress: timeShift(epoch, offset + halfDuration, days),
		centerUncertainty: centerSigma * DAYSEC,
		contactUncertainty: contactSigma === undefined ? undefined : contactSigma * DAYSEC,
		valid,
		flags,
	}
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
// ephemeris is the linear ephemeris. Its T0 is moved to TDB and its days to TDB days (see
// TransitEphemeris.epoch); cycle offsets then advance on that clock at the ephemeris' origin. A
// barycentric instant is already BJD_TDB; a heliocentric instant h becomes h + (r☉(h) · n) / c with
// r☉ the SSB-to-Sun position at h, so the Sun's reflex motion is applied cycle by cycle. direction is
// the ICRS direction of the star, normalized here, used for the light time and, unless
// options.targetAt is given, for the visibility limits. observer is the SSB-centered path of the site
// (as for barycentricJulianDate) and location the same site for the topocentric TDB-TT term and the
// horizon. start and end bound the search in any scale; they are converted to UTC at the site.
//
// Each cycle's contacts are offset by T14/2 from the center, and the required span adds the
// baselines and timingSigma·contactUncertainty outside them. Contacts and span edges are converted to
// BJD_TDB at their own instants and mapped to UTC reception instants with
// receptionFromBarycentricJulianDate. Span edges grow monotonically with the cycle on BJD_TDB, and
// BJD_TDB grows monotonically with reception time, so the overlap with the search window is decided
// exactly on BJD_TDB by stepping the cycle bounds. The visible part of each span is visibilityWindows
// over the span clipped to the window; when a constraint removes time, each constraint group is
// searched alone to name the limitation. The coarse step must resolve every constraint crossing inside
// a span. An event is feasible only when some of the transit itself is visible, so baselines alone
// never qualify.
//
// Throws RangeError for a non-positive or non-finite period, a duration outside (0, period), a
// covariance larger than σ(T0)·σ(P), a timing margin k·σ(P) not below P (event spans would no longer
// be ordered), a heliocentric ephemeris without options.sun, a solar or lunar limit without its
// direction callback, or more than options.maximumEvents events; a non-SSB-centered path throws Error.
// An empty or reversed search window returns no events.
export function exoplanetTransits(ephemeris: TransitEphemeris, direction: Vec3, observer: EphemerisPath, location: GeographicPosition, start: Time, end: Time, options: ExoplanetTransitOptions = {}): ExoplanetTransitPrediction {
	const { reference } = ephemeris
	const { constraints = {}, sun, baselineBefore = 0, baselineAfter = 0, timingSigma = 1, minimumCoverage = 1, minimumTransitCoverage = 1, maximumUncertainty, maximumEvents = DEFAULT_MAXIMUM_EVENTS } = options

	// A non-positive period never advances the cycle scan, and a contact pair wider than the period
	// would let neighbouring events swap order.
	if (!(ephemeris.period > 0 && Number.isFinite(ephemeris.period))) throw new RangeError('transit period must be positive and finite')
	if (!(ephemeris.duration > 0 && ephemeris.duration < ephemeris.period)) throw new RangeError('transit duration must be within (0, period)')

	// Every interval of the ephemeris in TDB days.
	const rate = tdbRate(ephemeris.epoch.scale)
	const period = ephemeris.period * rate
	const duration = ephemeris.duration * rate
	const epochUncertainty = (ephemeris.epochUncertainty ?? 0) * rate
	const periodUncertainty = (ephemeris.periodUncertainty ?? 0) * rate
	const covariance = (ephemeris.covariance ?? 0) * rate * rate
	const durationUncertainty = (ephemeris.durationUncertainty ?? 0) * rate

	// An over-unity correlation makes the variance negative for some cycles: a silent 0 or NaN uncertainty.
	if (!covarianceWithinBounds(epochUncertainty, periodUncertainty, covariance)) throw new RangeError('transit epoch-period covariance exceeds the product of the uncertainties')
	// Span edges must grow with the cycle for the bounded cycle scan to terminate on the right cycles.
	if (!(timingSigma * periodUncertainty < period)) throw new RangeError('timing margin per cycle must be smaller than the period')
	if (reference === 'heliocentric' && sun === undefined) throw new RangeError('sun path is required for a heliocentric transit epoch')
	if (sun !== undefined && !sameEphemerisEndpoint(sun.center, SOLAR_SYSTEM_BARYCENTER)) throw new Error('sun ephemeris path must be SSB-centered')
	if ((constraints.maximumSunAltitude !== undefined || constraints.minimumSunSeparation !== undefined) && options.sunAt === undefined) throw new RangeError('sun direction is required when a solar limit is set')
	if (constraints.minimumMoonSeparation !== undefined && options.moonAt === undefined) throw new RangeError('moon direction is required when a lunar separation limit is set')

	const flags = missingUncertaintyFlags(ephemeris)

	const n = vecNormalize(direction)
	const lightTime = sun === undefined ? undefined : { sun }
	// T0 on TDB at the ephemeris' origin. A barycentric instant has no site: drop any location so no
	// topocentric TDB term leaks in.
	const t0 = tdb(ephemeris.epoch)
	const origin = time(t0.day, t0.fraction, Timescale.TDB)

	// BJD_TDB of the ephemeris instant `offset` TDB days after T0, as days after T0. The Sun moves by
	// about 13 m/s around the SSB, so the heliocentric shift is evaluated at each instant.
	const barycentric = reference === 'heliocentric' ? (offset: number) => offset + vecDot(sun!.stateAt(timeShift(origin, offset))[0], n) / SPEED_OF_LIGHT_AU_DAY : (offset: number) => offset
	const bjd = (offset: number) => timeShift(origin, barycentric(offset))
	const epoch = bjd(0)

	const from = timeShift(utc(start), 0)
	from.location = location
	const to = timeShift(utc(end), 0)
	to.location = location
	if (!(timeSubtract(to, from) > 0)) return { epoch, events: [], flags }

	// Search window on BJD_TDB, as day offsets from the TDB origin.
	const lower = timeSubtract(barycentricJulianDate(from, n, observer, lightTime).time, origin)
	const upper = timeSubtract(barycentricJulianDate(to, n, observer, lightTime).time, origin)

	const halfDuration = duration / 2
	const contactSigma = (cycle: number) => Math.hypot(transitTimingUncertainty(cycle, epochUncertainty, periodUncertainty, covariance), durationUncertainty / 2)
	// Span edges on the ephemeris clock; both grow with the cycle because timingSigma·σ(P) < P.
	const spanEnd = (cycle: number) => cycle * period + halfDuration + baselineAfter + timingSigma * contactSigma(cycle)
	const spanStart = (cycle: number) => cycle * period - halfDuration - baselineBefore - timingSigma * contactSigma(cycle)

	// The margin-free guesses land within a few cycles of the bounds; stepping on the BJD_TDB edges
	// makes them exact and is counted against the event cap.
	let first = Math.ceil((lower - halfDuration - baselineAfter) / period)
	let last = Math.floor((upper + halfDuration + baselineBefore) / period)
	let steps = 0
	while (barycentric(spanEnd(first)) < lower && ++steps <= maximumEvents) first++
	while (barycentric(spanEnd(first - 1)) >= lower && ++steps <= maximumEvents) first--
	while (barycentric(spanStart(last)) > upper && ++steps <= maximumEvents) last--
	while (barycentric(spanStart(last + 1)) <= upper && ++steps <= maximumEvents) last++
	if (steps > maximumEvents || last - first + 1 > maximumEvents) throw new RangeError('too many transit events in the search window')

	const targetAt = options.targetAt ?? (() => n)
	const groups = constraintGroups(constraints)
	const events: ExoplanetTransitEvent[] = []

	const reception = (instant: Time) => receptionFromBarycentricJulianDate(instant, n, observer, location, lightTime)

	for (let cycle = first; cycle <= last; cycle++) {
		const centerOffset = cycle * period
		const centerUncertainty = transitTimingUncertainty(cycle, epochUncertainty, periodUncertainty, covariance)
		const contactUncertainty = contactSigma(cycle)
		const startOffset = barycentric(spanStart(cycle))
		const endOffset = barycentric(spanEnd(cycle))

		const center = bjd(centerOffset)
		const ingress = bjd(centerOffset - halfDuration)
		const egress = bjd(centerOffset + halfDuration)
		const observedIngress = reception(ingress)
		const observedCenter = reception(center)
		const observedEgress = reception(egress)
		const spanStartTime = reception(timeShift(origin, startOffset))
		const spanEndTime = reception(timeShift(origin, endOffset))

		const limitations: ExoplanetTransitLimitation[] = []
		const clipped = startOffset < lower || endOffset > upper
		const clippedStart = startOffset < lower ? from : spanStartTime
		const clippedEnd = endOffset > upper ? to : spanEndTime
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

		const coverage = coverageFraction(coveredDays(visible), timeSubtract(spanEndTime, spanStartTime))
		const transitCoverage = coverageFraction(coveredDays(visible, observedIngress, observedEgress), timeSubtract(observedEgress, observedIngress))

		events.push({
			cycle,
			center,
			ingress,
			egress,
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
			feasible: !uncertain && transitCoverage > 0 && transitCoverage >= minimumTransitCoverage && coverage >= minimumCoverage,
			limitations,
		})
	}

	return { epoch, events, flags }
}
