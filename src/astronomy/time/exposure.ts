import { DAYSEC } from '../../core/constants'
import { type Time, Timescale, tai, timeShift, utc } from './time'

// Exposure timing semantics: converts a recorded camera timestamp that labels the commanded shutter
// open, close, or midpoint into the actual photon-collection interval, correcting for shutter
// latency. Durations, latencies, and uncertainties are SI seconds. Returned instants keep the scale,
// providers, and location of the recorded timestamp; UTC offsets are applied on TAI so a leap second
// inside the exposure is counted. The midpoint is the center of the collection interval, the instant
// to feed into barycentric timing (see barycentricJulianDate). Every call allocates fresh Times.

// Commanded shutter event that a recorded exposure timestamp labels.
export type ExposureTimestampReference = 'start' | 'midpoint' | 'end'

// A recorded exposure timestamp and the shutter model needed to recover the collection interval.
export interface ExposureTimestamp {
	// Recorded timestamp, in any timescale.
	readonly time: Time
	// Commanded event the timestamp labels: shutter open, the commanded midpoint, or shutter close.
	readonly reference: ExposureTimestampReference
	// Commanded exposure duration from open to close command, in seconds.
	readonly duration: number
	// Delay from the open command to the actual start of photon collection, in seconds (default 0).
	readonly openLatency?: number
	// Delay from the close command to the actual end of photon collection, in seconds (default 0).
	readonly closeLatency?: number
	// 1σ uncertainty of the recorded timestamp, including latency calibration, in seconds (default 0).
	readonly uncertainty?: number
}

// The actual photon-collection interval of one exposure.
export interface ExposureInterval {
	// Start of photon collection, in the timestamp's scale.
	readonly start: Time
	// Center of the collection interval, in the timestamp's scale.
	readonly midpoint: Time
	// End of photon collection, in the timestamp's scale.
	readonly end: Time
	// Effective collection duration, duration - openLatency + closeLatency, in seconds.
	readonly duration: number
	// 1σ uncertainty of each returned instant, carried from the timestamp, in seconds.
	readonly uncertainty: number
}

// Computes the photon-collection interval of an exposure from its recorded timestamp.
// The commanded open instant is the timestamp for 'start', timestamp - duration / 2 for
// 'midpoint', and timestamp - duration for 'end'; collection starts openLatency later and
// ends duration + closeLatency after the commanded open. The midpoint assumes uniform
// illumination over the interval. UTC timestamps are shifted in TAI, so an interval that
// spans an inserted leap second keeps its SI length and may end at 23:59:60; other scales
// are shifted directly by SI seconds.
export function exposureInterval(exposure: ExposureTimestamp): ExposureInterval {
	const { time, reference, duration, openLatency = 0, closeLatency = 0, uncertainty = 0 } = exposure
	const open = reference === 'start' ? 0 : reference === 'end' ? -duration : -0.5 * duration
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
