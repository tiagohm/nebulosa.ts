import { SIDEREAL_DRIFT_RATE } from '../../../core/constants'
import { clamp } from '../../../math/numerical/math'
import { mulberry32 } from '../../../math/numerical/random'
import type { Angle } from '../../../math/units/angle'
import type { GuideDirection } from '../device'
import { makeNumberVector, type NewNumberVector, type PropertyState } from '../types'
import { type ComponentBus, makeBoundNumberVector, type NumberBinding, readBoundNumberVector, SimulatorComponent } from './component'
import { MAIN_CONTROL, MAX_GUIDE_RATE, MAX_QUEUED_GUIDE_PULSES, SIMULATION } from './constants'
import type { MountDriveConfig, MountGuidingConfig } from './mount.config'
import { applyNumberVectorValues, timedGuidePulse } from './util'

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

// Moves every queued pulse by `delta` milliseconds, in place.
//
// The queue is timed on absolute instants of the simulated clock, so replacing that clock has to carry
// the pulses with it: a pulse was commanded to run for its own duration, not until a particular
// reading of a clock somebody is free to change. Left on the old timeline, a forward jump retires a
// pulse without ever delivering the rest of its motion, and a backward one leaves the guide vectors
// busy until the clock catches up, which can be hours.
export function shiftGuidePulses(pulses: GuidePulse[], delta: number) {
	if (delta === 0) return

	for (let i = 0; i < pulses.length; i++) {
		pulses[i].start += delta
		pulses[i].end += delta
	}
}

// Terms of MOUNT_GUIDING: latency, jitter, minimum pulse and quantization in milliseconds, and the
// per-direction gains relative to the guide rate.
const GUIDING: readonly NumberBinding<keyof MountGuidingConfig>[] = [
	['LATENCY', 'Latency (ms)', 'latency', 0, 5000, 1, '%.0f'],
	['LATENCY_JITTER', 'Latency Jitter (ms)', 'latencyJitter', 0, 1000, 1, '%.0f'],
	['MINIMUM_PULSE', 'Minimum Pulse (ms)', 'minimumPulse', 0, 1000, 1, '%.0f'],
	['QUANTIZATION', 'Duration Quantization (ms)', 'quantization', 0, 1000, 1, '%.0f'],
	['GAIN_NORTH', 'North Gain', 'gainNorth', 0, 2, 0.01, '%.3f'],
	['GAIN_SOUTH', 'South Gain', 'gainSouth', 0, 2, 0.01, '%.3f'],
	['GAIN_EAST', 'East Gain', 'gainEast', 0, 2, 0.01, '%.3f'],
	['GAIN_WEST', 'West Gain', 'gainWest', 0, 2, 0.01, '%.3f'],
]

// What the guide port is wired to on its mount.
export interface MountGuidePortWiring {
	// Whether pulses are accepted now: the mount is connected, unparked and not slewing.
	readonly accepts: () => boolean
	// Exact simulated time, milliseconds, the remainder of a partial step included.
	readonly now: () => number
	// Runs when a pulse ended, before its axis is published Idle, so the position it left is out first.
	readonly ended: () => void
}

// The ST-4 port of the mount: the guide rates, the queue of timed pulses on each axis and the fidelity
// of the path between the command and the motor. Pulses are timed on the simulated clock, so stepping
// the simulation directly behaves exactly as the timer does.
export class MountGuidePort extends SimulatorComponent {
	readonly #rate = makeNumberVector('', 'GUIDE_RATE', 'Guiding Rate', MAIN_CONTROL, 'rw', ['GUIDE_RATE_WE', 'W/E Rate', 0.5, 0, MAX_GUIDE_RATE, 0.1, '%.8f'], ['GUIDE_RATE_NS', 'N/S Rate', 0.5, 0, MAX_GUIDE_RATE, 0.1, '%.8f'])
	readonly #northSouth = makeNumberVector('', 'TELESCOPE_TIMED_GUIDE_NS', 'Guide N/S', MAIN_CONTROL, 'rw', ['TIMED_GUIDE_N', 'North (ms)', 0, 0, 60000, 1, '%.0f'], ['TIMED_GUIDE_S', 'South (ms)', 0, 0, 60000, 1, '%.0f'])
	readonly #westEast = makeNumberVector('', 'TELESCOPE_TIMED_GUIDE_WE', 'Guide W/E', MAIN_CONTROL, 'rw', ['TIMED_GUIDE_W', 'West (ms)', 0, 0, 60000, 1, '%.0f'], ['TIMED_GUIDE_E', 'East (ms)', 0, 0, 60000, 1, '%.0f'])
	readonly #fidelity: ReturnType<typeof makeBoundNumberVector>

	readonly properties: readonly ReturnType<typeof makeNumberVector>[]
	readonly transient: readonly ReturnType<typeof makeNumberVector>[]

	// Whether the guiding family is simulated; off means a perfect controller rather than an absent one.
	enabled = false
	// Accepted pulses per axis, in acceptance order, retired once the clock has passed them. A queue
	// rather than a deadline, so a pulse arriving before the previous one finishes adds to it.
	readonly northSouthPulses: GuidePulse[] = []
	readonly westEastPulses: GuidePulse[] = []
	// Guide contribution of the piece of a step being integrated, radians per second per axis, so the
	// motor rate, the worm and the transmission all see the same value within it.
	rateNorthSouth = 0
	rateWestEast = 0
	// Uniform source of the latency jitter.
	readonly #random: () => number

	// `drive` gives the initial guide rates, `config` the fidelity and `seed` the jitter generator.
	constructor(
		bus: ComponentBus,
		drive: MountDriveConfig,
		config: MountGuidingConfig,
		seed: number,
		readonly wiring: MountGuidePortWiring,
	) {
		super(bus)
		this.#rate.elements.GUIDE_RATE_WE.value = drive.guideRateRightAscension
		this.#rate.elements.GUIDE_RATE_NS.value = drive.guideRateDeclination
		this.#fidelity = makeBoundNumberVector('MOUNT_GUIDING', 'Guiding', SIMULATION, GUIDING, config)
		this.properties = [this.#northSouth, this.#westEast, this.#rate, this.#fidelity]
		this.transient = [this.#northSouth, this.#westEast]
		this.#random = mulberry32(seed)
	}

	// Guide rate of right ascension, fraction of the sidereal rate.
	get rateRightAscension() {
		return this.#rate.elements.GUIDE_RATE_WE.value
	}

	// Guide rate of declination, fraction of the sidereal rate.
	get rateDeclination() {
		return this.#rate.elements.GUIDE_RATE_NS.value
	}

	// Whether either axis is pulsing.
	get isPulsing() {
		return this.#northSouth.state === 'Busy' || this.#westEast.state === 'Busy'
	}

	// Response of the path between the command and the motor, the identity while the family is off or
	// every term is ideal.
	get response(): GuideResponseConfig {
		if (!this.enabled) return IDENTITY_GUIDE_RESPONSE_CONFIG
		const terms = readBoundNumberVector(this.#fidelity, GUIDING)
		if (terms.latency === 0 && terms.latencyJitter === 0 && terms.minimumPulse === 0 && terms.quantization === 0 && terms.gainNorth === 1 && terms.gainSouth === 1 && terms.gainEast === 1 && terms.gainWest === 1) return IDENTITY_GUIDE_RESPONSE_CONFIG
		return { latency: terms.latency, latencyJitter: terms.latencyJitter, minimumPulse: terms.minimumPulse, durationQuantization: terms.quantization, northGain: terms.gainNorth, southGain: terms.gainSouth, eastGain: terms.gainEast, westGain: terms.gainWest }
	}

	// Sets the guide rates, fractions of the sidereal rate clamped to [0, MAX_GUIDE_RATE].
	setRate(rightAscension: number, declination: number) {
		rightAscension = clamp(rightAscension, 0, MAX_GUIDE_RATE)
		declination = clamp(declination, 0, MAX_GUIDE_RATE)
		if (this.rateRightAscension === rightAscension && this.rateDeclination === declination) return
		this.#rate.elements.GUIDE_RATE_WE.value = rightAscension
		this.#rate.elements.GUIDE_RATE_NS.value = declination
		this.bus.notify(this.#rate)
	}

	// Queues a pulse of `duration` milliseconds towards `direction`; zero or less clears that axis.
	//
	// The command goes through the configured response: a pulse below the minimum is discarded, the
	// rest is rounded to the controller's step and starts after the latency and its jitter. A full
	// queue drops the new pulse, as a controller commanded faster than it executes does. Refused while
	// the mount does not accept pulses, during a slew among others, as a real controller ignores ST-4
	// input while it slews.
	pulse(direction: GuideDirection, duration: number) {
		if (!this.wiring.accepts()) return

		const northSouth = direction === 'NORTH' || direction === 'SOUTH'
		const pulses = northSouth ? this.northSouthPulses : this.westEastPulses

		if (duration <= 0) {
			pulses.length = 0
			this.#publish(this.northSouthPulses.length > 0, this.westEastPulses.length > 0)
			return
		}

		const config = this.response
		const executed = quantizeGuideDuration(duration, config)
		if (executed <= 0 || pulses.length >= MAX_QUEUED_GUIDE_PULSES) return

		const sign = direction === 'NORTH' || direction === 'EAST' ? 1 : -1
		const gain = direction === 'NORTH' ? config.northGain : direction === 'SOUTH' ? config.southGain : direction === 'EAST' ? config.eastGain : config.westGain
		const guideRate = northSouth ? this.rateDeclination : this.rateRightAscension
		// Uniform over the full jitter width, centred on the configured latency and never negative.
		const jitter = config.latencyJitter > 0 ? (this.#random() * 2 - 1) * config.latencyJitter : 0
		const start = this.wiring.now() + Math.max(0, config.latency + jitter)
		pulses.push({ start, end: start + executed, rate: sign * gain * guideRate * SIDEREAL_DRIFT_RATE })
		this.#publish(this.northSouthPulses.length > 0, this.westEastPulses.length > 0)
	}

	// Next instant in (`from`, `limit`] at which a pulse of either axis starts or ends, milliseconds.
	boundary(from: number, limit: number) {
		return nextGuidePulseBoundary(this.northSouthPulses, from, nextGuidePulseBoundary(this.westEastPulses, from, limit))
	}

	// Sets the guide contribution of the piece [`from`, `to`], milliseconds, from the pulses integrated
	// over it, so a pulse shorter than the piece delivers exactly its own share of motion.
	integrate(from: number, to: number) {
		const dtSeconds = (to - from) / 1000
		this.rateWestEast = integrateGuidePulses(this.westEastPulses, from, to) / dtSeconds
		this.rateNorthSouth = integrateGuidePulses(this.northSouthPulses, from, to) / dtSeconds
	}

	// Retires the pulses over by `time`, milliseconds, and publishes each axis' state. Both axes are
	// always visited, so neither queue grows.
	retire(time: number) {
		const westEast = retireGuidePulses(this.westEastPulses, time)
		const northSouth = retireGuidePulses(this.northSouthPulses, time)
		this.#publish(northSouth, westEast)
	}

	// Moves every queued pulse by `delta` milliseconds when the clock is set: a pulse is a command to run
	// for its own duration, not until a reading of a clock a client is free to change.
	shift(delta: number) {
		shiftGuidePulses(this.westEastPulses, delta)
		shiftGuidePulses(this.northSouthPulses, delta)
	}

	// Cancels every pulse.
	clear() {
		this.northSouthPulses.length = 0
		this.westEastPulses.length = 0
		this.rateNorthSouth = 0
		this.rateWestEast = 0
		this.#publish(false, false)
	}

	// Cancels every pulse when the device disconnects.
	reset() {
		this.clear()
	}

	// Handles GUIDE_RATE, TELESCOPE_TIMED_GUIDE_NS/WE and MOUNT_GUIDING.
	handleNumber(vector: NewNumberVector) {
		const { elements } = vector

		switch (vector.name) {
			case this.#rate.name:
				this.setRate(elements.GUIDE_RATE_WE ?? this.rateRightAscension, elements.GUIDE_RATE_NS ?? this.rateDeclination)
				return true
			case this.#northSouth.name: {
				const pulse = timedGuidePulse('NORTH', elements.TIMED_GUIDE_N, 'SOUTH', elements.TIMED_GUIDE_S)
				if (pulse !== undefined) this.pulse(pulse[0], pulse[1])
				return true
			}
			case this.#westEast.name: {
				const pulse = timedGuidePulse('WEST', elements.TIMED_GUIDE_W, 'EAST', elements.TIMED_GUIDE_E)
				if (pulse !== undefined) this.pulse(pulse[0], pulse[1])
				return true
			}
			case this.#fidelity.name:
				if (applyNumberVectorValues(this.#fidelity, elements)) this.bus.notify(this.#fidelity)
				return true
		}

		return false
	}

	// Publishes each axis Busy while it has pulses and Idle otherwise, running `ended` first when one
	// stops pulsing.
	#publish(northSouth: boolean, westEast: boolean) {
		if ((this.#northSouth.state === 'Busy' && !northSouth) || (this.#westEast.state === 'Busy' && !westEast)) this.wiring.ended()
		this.#publishAxis(this.#northSouth, northSouth ? 'Busy' : 'Idle')
		this.#publishAxis(this.#westEast, westEast ? 'Busy' : 'Idle')
	}

	// Sets the state of one axis' property, publishing it when it changed.
	#publishAxis(property: ReturnType<typeof makeNumberVector>, state: PropertyState) {
		if (property.state === state) return
		property.state = state
		this.bus.notify(property)
	}
}
