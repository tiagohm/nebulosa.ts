import type { Angle } from '../../../math/units/angle'

// Response of a mount to timed guide-pulse commands: how faithfully a requested duration reaches the
// motor, and how overlapping pulses combine. Durations are milliseconds on the simulated clock and
// rates are radians per second. The integration is analytic over the requested interval rather than
// sampled at the simulation tick, so a pulse shorter than the tick still produces exactly its share
// of motion.

// Imperfections of the guide-pulse path between the command and the motor. Every field defaults to a
// value meaning "ideal", in which case a pulse takes effect immediately and for exactly its duration.
export interface GuideResponseConfig {
	// Delay between accepting the command and the motor responding, milliseconds.
	readonly latency: number
	// Half-width of the uniform jitter added to the latency, milliseconds. Models a controller whose
	// response time is not repeatable.
	readonly latencyJitter: number
	// Duration below which a pulse is discarded entirely, milliseconds. Real controllers ignore
	// commands too short to be worth issuing.
	readonly minimumPulse: number
	// Step the duration is rounded to, milliseconds. Zero disables rounding.
	readonly durationQuantization: number
	// Per-direction rate multipliers relative to the configured guide rate. Asymmetry between north and
	// south is common on a declination axis fighting gravity in one direction only.
	readonly northGain: number
	readonly southGain: number
	readonly eastGain: number
	readonly westGain: number
}

// A guide response with no imperfections: no latency, no rounding, no rejection, unit gains.
export const IDENTITY_GUIDE_RESPONSE_CONFIG: GuideResponseConfig = {
	latency: 0,
	latencyJitter: 0,
	minimumPulse: 0,
	durationQuantization: 0,
	northGain: 1,
	southGain: 1,
	eastGain: 1,
	westGain: 1,
}

// One accepted pulse, held until the simulated clock has passed it entirely.
export interface GuidePulse {
	// Instant the motor starts and stops responding, milliseconds on the simulated clock. `start`
	// already includes the latency and its jitter.
	start: number
	end: number
	// Signed rate of the axis while the pulse is active, radians per second. Already scaled by the
	// guide rate and the per-direction gain.
	rate: number
}

// Rounds a requested duration to what the controller would actually execute, in milliseconds, or
// returns 0 when the pulse is rejected.
//
// Rejection happens before rounding, so a command below the minimum is discarded rather than being
// rounded up into acceptance. Rounding to the nearest step can still take a pulse to zero, which is
// also a rejection.
export function quantizeGuideDuration(duration: number, config: GuideResponseConfig) {
	if (!(duration > 0) || duration < config.minimumPulse) return 0
	if (config.durationQuantization <= 0) return duration
	return Math.round(duration / config.durationQuantization) * config.durationQuantization
}

// Total angle the axis is driven over `[startTime, endTime]` by the queued pulses, radians.
//
// Each pulse contributes only the part of itself that falls inside the interval, which is what makes
// the result independent of the simulation step: a 30 ms pulse crossed by a 100 ms tick delivers
// exactly 30 ms of motion instead of a whole tick or nothing at all. Pulses that have not started yet
// or are already over contribute nothing. Times are milliseconds on the simulated clock.
export function integrateGuidePulses(pulses: readonly GuidePulse[], startTime: number, endTime: number) {
	let travel: Angle = 0

	for (let i = 0; i < pulses.length; i++) {
		const pulse = pulses[i]
		const overlap = Math.min(endTime, pulse.end) - Math.max(startTime, pulse.start)
		if (overlap > 0) travel += (pulse.rate * overlap) / 1000
	}

	return travel
}

// Drops the pulses that ended at or before `time`, in place and preserving order, and returns whether
// any remain. Called once per step so the queue cannot grow without bound.
export function retireGuidePulses(pulses: GuidePulse[], time: number) {
	let kept = 0

	for (let i = 0; i < pulses.length; i++) {
		if (pulses[i].end > time) pulses[kept++] = pulses[i]
	}

	pulses.length = kept
	return kept > 0
}

// Earliest instant strictly after `from` and before `limit` at which a queued pulse starts or ends, or
// `limit` when none does. Times are milliseconds on the simulated clock.
//
// Used to cut a simulation step at the moments its guiding changes, so the transmission is driven in
// the order the commands actually arrived rather than by their sum over the whole step.
export function nextGuidePulseBoundary(pulses: readonly GuidePulse[], from: number, limit: number) {
	let boundary = limit

	for (let i = 0; i < pulses.length; i++) {
		const { start, end } = pulses[i]
		if (start > from && start < boundary) boundary = start
		if (end > from && end < boundary) boundary = end
	}

	return boundary
}
