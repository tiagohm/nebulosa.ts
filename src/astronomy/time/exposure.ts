import { DAYSEC } from '../../core/constants'
import { type Time, Timescale, tai, timeShift, timeSubtract, utc } from './time'

// Exposure timing semantics: converts recorded camera timestamps, either one timestamp labelling the
// commanded shutter open, close, or midpoint plus a duration, or the commanded open and close
// timestamps, into the actual photon-collection interval, correcting for shutter latency. Durations,
// latencies, and uncertainties are SI seconds. All arithmetic is done in SI seconds: UTC offsets are
// applied on TAI and an open/close span is measured on TAI, so a leap second inside the exposure is
// counted. Returned instants keep the scale, providers, and location of the reference timestamp and
// its two-part Julian Date precision. The midpoint is the nominal temporal midpoint of the collection
// interval, the single mid-exposure instant used by barycentric timing (see barycentricJulianDate).
// Every call allocates fresh Times.

// Commanded shutter event that a recorded exposure timestamp labels.
export type ExposureTimestampReference = 'start' | 'midpoint' | 'end'

// Shutter model shared by both exposure inputs.
export interface ExposureShutter {
	// Delay from the open command to the actual start of photon collection, in seconds (default 0).
	// For a shutter whose clear aperture grows linearly while opening, add half the opening time.
	readonly openLatency?: number
	// Delay from the close command to the actual end of photon collection, in seconds (default 0).
	// For a shutter whose clear aperture shrinks linearly while closing, add half the closing time.
	readonly closeLatency?: number
	// 1σ clock uncertainty of the recorded timestamps, including latency calibration, in seconds
	// (default 0). Open and close timestamps are taken as read from one clock, so the error is
	// common to both and carried unchanged to every returned instant.
	readonly uncertainty?: number
}

// A recorded exposure timestamp with its commanded duration.
export interface ExposureTimestamp extends ExposureShutter {
	// Recorded timestamp, in any timescale.
	readonly time: Time
	// Commanded event the timestamp labels: shutter open, the commanded midpoint, or shutter close.
	readonly reference: ExposureTimestampReference
	// Commanded exposure duration from open to close command, in seconds.
	readonly duration: number
	// Excluded: a timestamp with a duration is not a span.
	readonly start?: never
	// Excluded: a timestamp with a duration is not a span.
	readonly end?: never
}

// The recorded open and close command timestamps of one exposure.
export interface ExposureSpan extends ExposureShutter {
	// Open command timestamp, in any timescale; the returned instants use its scale.
	readonly start: Time
	// Close command timestamp, in any timescale, not before `start`.
	readonly end: Time
	// Excluded: the span defines the instant.
	readonly time?: never
	// Excluded: the span defines the reference.
	readonly reference?: never
	// Excluded: the duration is measured from the span, so a second, possibly contradictory,
	// duration (for example EXPTIME next to DATE-BEG/DATE-END) cannot be supplied.
	readonly duration?: never
}

// The actual photon-collection interval of one exposure.
export interface ExposureInterval {
	// Start of photon collection, in the reference timestamp's scale.
	readonly start: Time
	// Nominal temporal midpoint of the collection interval, in the reference timestamp's scale.
	readonly midpoint: Time
	// End of photon collection, in the reference timestamp's scale.
	readonly end: Time
	// Effective collection duration, commanded duration - openLatency + closeLatency, in seconds.
	readonly duration: number
	// 1σ uncertainty of each returned instant, carried from the clock uncertainty, in seconds.
	readonly uncertainty: number
}

// Computes the photon-collection interval of an exposure from its recorded timestamps.
// For a timestamp, the commanded open instant is the timestamp for 'start', timestamp -
// duration / 2 for 'midpoint', and timestamp - duration for 'end'. For a span, the commanded
// open is `start` and the commanded duration is end - start measured on TAI. Collection starts
// openLatency after the commanded open and ends duration + closeLatency after it.
//
// The midpoint is the nominal temporal midpoint (start + end) / 2 of the collection interval, not
// a photon-weighted one: it equals the flux-weighted mean time only for constant flux and a shutter
// whose transit is folded into the latencies. UTC instants are shifted in TAI, so an interval that
// spans an inserted leap second keeps its SI length and may start, end, or center on 23:59:60;
// other scales are shifted directly by SI seconds. Exposures down to microseconds keep their
// offsets, since a day fraction resolves about 1e-11 s.
export function exposureInterval(exposure: ExposureTimestamp | ExposureSpan): ExposureInterval {
	const { openLatency = 0, closeLatency = 0, uncertainty = 0 } = exposure
	let time: Time
	let open: number
	let duration: number

	if (exposure.start !== undefined) {
		time = exposure.start
		open = 0
		duration = timeSubtract(exposure.end, exposure.start, Timescale.TAI) * DAYSEC
	} else {
		time = exposure.time
		duration = exposure.duration
		open = exposure.reference === 'start' ? 0 : exposure.reference === 'end' ? -duration : -0.5 * duration
	}

	const startOffset = open + openLatency
	const endOffset = open + duration + closeLatency

	return {
		start: shiftSeconds(time, startOffset),
		midpoint: shiftSeconds(time, 0.5 * (startOffset + endOffset)),
		end: shiftSeconds(time, endOffset),
		duration: endOffset - startOffset,
		uncertainty,
	}
}

// Shifts a time by SI seconds, going through TAI for UTC so leap seconds are counted.
function shiftSeconds(time: Time, seconds: number) {
	if (time.scale !== Timescale.UTC) return timeShift(time, seconds / DAYSEC)
	return utc(timeShift(tai(time), seconds / DAYSEC))
}
