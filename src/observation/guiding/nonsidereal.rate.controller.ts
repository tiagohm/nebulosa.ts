import { ASEC2RAD } from '../../core/constants'
import type { Angle } from '../../math/units/angle'
import type { TrackingRateEstimate } from './nonsidereal.rate'

// Bounded residual-rate feedback, independent of mount protocol conventions. Inputs and outputs
// are sky-plane [east, north] radians/second; device axis rates remain the adapter's responsibility.
// The feed-forward rate remains authoritative while this controller adds only bounded residual feedback.

// Safety and smoothing limits for residual non-sidereal rate feedback.
export interface TrackingRateControllerOptions {
	// Minimum estimator confidence accepted for a correction; defaults to 0.5.
	readonly minimumConfidence?: number
	// Residual-rate magnitude below which the controller commands zero, in radians/second; defaults to 0.01 arcsecond/second.
	readonly deadband?: number
	// Maximum correction magnitude, in radians/second; defaults to 30 arcseconds/second.
	readonly maximumCorrection?: number
	// Maximum vector correction change per update, in radians/second; defaults to 1 arcsecond/second.
	readonly maximumRateChangePerUpdate?: number
	// First-order low-pass time constant in seconds; defaults to 2 seconds.
	readonly smoothingTimeConstantSeconds?: number
}

// Absolute sky-plane tracking rate and its bounded image-feedback component.
export interface TrackingRateCommand {
	// Requested total east/north target rate, in radians/second.
	readonly rate: readonly [Angle, Angle]
	// Bounded residual correction added to the feed-forward rate, in radians/second.
	readonly correction: readonly [Angle, Angle]
	// Confidence of the correction source, or zero when feedback was rejected.
	readonly confidence: number
	// Whether clipping, deadband, slew limiting, or feedback rejection changed the request.
	readonly limited: boolean
}

// Applies confidence, deadband, magnitude, slew, and low-pass limits to a residual rate estimate.
export class TrackingRateController {
	readonly #options: Required<TrackingRateControllerOptions>
	#correction: readonly [Angle, Angle] = [0, 0]

	// Creates a stateful feedback controller. `options` controls confidence, deadband, correction, slew,
	// and smoothing limits; the estimator and ephemeris remain caller-owned.
	constructor(options?: TrackingRateControllerOptions) {
		this.#options = {
			minimumConfidence: options?.minimumConfidence ?? 0.5,
			deadband: options?.deadband ?? 0.01 * ASEC2RAD,
			maximumCorrection: options?.maximumCorrection ?? 30 * ASEC2RAD,
			maximumRateChangePerUpdate: options?.maximumRateChangePerUpdate ?? ASEC2RAD,
			smoothingTimeConstantSeconds: options?.smoothingTimeConstantSeconds ?? 2,
		}
	}

	// Adds a fresh residual `estimate` to the `feedForward` east/north rate over `elapsedSeconds`.
	// Rejected estimates slew the stored correction toward zero; `reset()` clears it immediately. A non-finite feed-forward rate returns undefined.
	update(feedForward: readonly [Angle, Angle], estimate: TrackingRateEstimate | undefined, elapsedSeconds: number): TrackingRateCommand | undefined {
		if (!Number.isFinite(feedForward[0]) || !Number.isFinite(feedForward[1])) {
			this.reset()
			return undefined
		}

		const usable = estimate !== undefined && !estimate.stale && estimate.confidence >= this.#options.minimumConfidence && estimate.confidence <= 1 && Number.isFinite(estimate.rate[0]) && Number.isFinite(estimate.rate[1])
		const confidence = usable ? estimate.confidence : 0
		if (!(elapsedSeconds > 0) || !Number.isFinite(elapsedSeconds)) {
			return {
				rate: [feedForward[0] + this.#correction[0], feedForward[1] + this.#correction[1]],
				correction: [this.#correction[0], this.#correction[1]],
				confidence,
				limited: true,
			}
		}

		let limited = !usable
		let target: readonly [number, number] = [0, 0]
		if (usable) {
			const desired = estimate.rate
			const desiredMagnitude = Math.hypot(desired[0], desired[1])
			target = desired

			if (desiredMagnitude <= this.#options.deadband) {
				target = [0, 0]
				limited ||= desiredMagnitude > 0
			} else if (desiredMagnitude > this.#options.maximumCorrection) {
				const ratio = this.#options.maximumCorrection / desiredMagnitude
				target = [desired[0] * ratio, desired[1] * ratio]
				limited = true
			}
		}

		const tau = this.#options.smoothingTimeConstantSeconds
		const smoothing = tau > 0 ? elapsedSeconds / (tau + elapsedSeconds) : 1
		let nextEast = this.#correction[0] + (target[0] - this.#correction[0]) * smoothing
		let nextNorth = this.#correction[1] + (target[1] - this.#correction[1]) * smoothing
		const changeEast = nextEast - this.#correction[0]
		const changeNorth = nextNorth - this.#correction[1]

		const change = Math.hypot(changeEast, changeNorth)
		if (change > this.#options.maximumRateChangePerUpdate) {
			const ratio = this.#options.maximumRateChangePerUpdate / change
			nextEast = this.#correction[0] + changeEast * ratio
			nextNorth = this.#correction[1] + changeNorth * ratio
			limited = true
		}

		this.#correction = [nextEast, nextNorth]

		return {
			rate: [feedForward[0] + nextEast, feedForward[1] + nextNorth],
			correction: [this.#correction[0], this.#correction[1]],
			confidence,
			limited,
		}
	}

	// Clears filtered correction state for a camera transform change, meridian flip, or new target.
	reset() {
		this.#correction = [0, 0]
	}
}
