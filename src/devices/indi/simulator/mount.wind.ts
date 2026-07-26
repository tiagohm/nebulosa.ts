import type { Random } from '../../../math/numerical/random'
import type { Angle } from '../../../math/units/angle'

// Buffeting of the telescope by wind, as a bounded disturbance of where the optical axis points.
//
// Modelled as an Ornstein-Uhlenbeck process: random like a walk over short intervals, but pulled back
// towards zero, so it wanders within a bounded envelope instead of running away. That is what
// separates it from every other error already modelled. The geometric terms are static, the periodic
// error repeats with the worm, and the tracking-rate error is a walk with no bound at all; none of
// them can produce a disturbance that is random over a few seconds and yet goes nowhere over an hour.
//
// The distinction matters for anything that has to decide whether an excursion is worth correcting. A
// guiding algorithm chasing correlated noise as if it were drift over-corrects and makes the tracking
// worse, and a mount whose only noise source is uncorrelated cannot expose that.
//
// The same process stands in for the wander of a star's centroid under seeing, which shares the
// character even though the cause is different.
//
// Deflections are radians of on-sky angle, times are seconds.

// Wind conditions at the site.
export interface WindConfig {
	// Standard deviation of the deflection once the process has settled, radians of on-sky angle. Zero
	// makes the site perfectly still.
	readonly amplitude: Angle
	// Time over which a gust loses its memory, seconds. The deflection decays towards zero by a factor
	// of e over this interval. Short values approach white noise, long ones a slow wander.
	readonly correlationTime: number
}

// A perfectly still site, where nothing pushes the telescope.
export const IDENTITY_WIND_CONFIG: WindConfig = {
	amplitude: 0,
	correlationTime: 1,
}

// Current deflection of the optical axis, radians of on-sky angle. The two axes are driven
// independently, which understates the coherence of a real gust arriving from one direction but is
// the usual model and keeps the parameters down to two.
export interface WindState {
	// East-west deflection, on-sky. Callers pointing near a pole must divide by the cosine of the
	// declination to turn it into a right-ascension offset.
	rightAscension: Angle
	// North-south deflection, which needs no such conversion.
	declination: Angle
}

// Creates the state of an undisturbed telescope.
export function windState(): WindState {
	return { rightAscension: 0, declination: 0 }
}

// Whether the telescope is currently deflected at all.
export function isWindy(state: WindState) {
	return state.rightAscension !== 0 || state.declination !== 0
}

// Draws a deflection from the settled distribution of `config`, so the process starts as if the wind
// had already been blowing rather than spending several correlation times warming up from zero.
//
// `normal` must be a standard normal source. A zero amplitude leaves the telescope undisturbed.
export function resetWind(state: WindState, config: WindConfig, normal: Random) {
	if (config.amplitude > 0) {
		state.rightAscension = normal() * config.amplitude
		state.declination = normal() * config.amplitude
	} else {
		state.rightAscension = 0
		state.declination = 0
	}
}

// Advances the deflection by `dtSeconds`, with `normal` a standard normal source.
//
// Uses the exact update of the process rather than stepping its differential equation, so both the
// settled spread and the rate at which a gust decays are independent of the interval. Stepping it
// naively would tie the amount of noise injected to the tick rate, and a simulation run at a
// different step would see a different amount of wind.
export function advanceWind(state: WindState, dtSeconds: number, config: WindConfig, normal: Random) {
	if (dtSeconds <= 0 || config.amplitude <= 0 || config.correlationTime <= 0) return

	// Memory retained over the interval, and the spread of the fresh disturbance that replaces what was
	// forgotten. The two are tied so that the settled standard deviation stays exactly the amplitude.
	const decay = Math.exp(-dtSeconds / config.correlationTime)
	const innovation = config.amplitude * Math.sqrt(1 - decay * decay)

	state.rightAscension = state.rightAscension * decay + normal() * innovation
	state.declination = state.declination * decay + normal() * innovation
}
