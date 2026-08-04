import { TAU } from '../../../core/constants'
import { clamp } from '../../../math/numerical/math'
import type { Angle } from '../../../math/units/angle'

// Elastic settling of a mount axis: the overshoot and ring-down that follow an abrupt stop, because a
// telescope on a tripod is a spring rather than a rigid body. Modelled as a free damped harmonic
// oscillator in the residual offset from the commanded position, so the axis converges back onto that
// position and the whole episode contributes no net displacement.
//
// Angles are radians, rates radians per second and times seconds.

// Largest damping ratio accepted. Kept just below one so a single underdamped solution covers the
// whole range; at this value the ring-down is indistinguishable from critical damping, which is what
// asking for a stiff mount means in practice.
const MAX_DAMPING_RATIO = 0.999

// Elastic response of one axis.
export interface SettlingConfig {
	// Natural frequency of the structure, hertz. Typical amateur mounts ring at a few hertz.
	readonly frequency: number
	// Damping ratio, dimensionless. Below one the axis oscillates before converging; values are clamped
	// to just under one, above which there is no oscillation to model.
	readonly dampingRatio: number
	// Peak excursion following a stop at full slew speed, radians. Scaled down for slower stops.
	readonly overshoot: Angle
}

// A perfectly stiff axis, which stops dead and never rings.
export const IDENTITY_SETTLING_CONFIG: SettlingConfig = {
	frequency: 0,
	dampingRatio: 1,
	overshoot: 0,
}

// Live state of the oscillator: how far the axis currently sits from where it was commanded, and how
// fast that offset is changing.
export interface SettlingState {
	offset: Angle
	velocity: number
}

// Creates the state of an axis at rest and on target.
export function settlingState(): SettlingState {
	return { offset: 0, velocity: 0 }
}

// Whether the axis is still measurably away from its commanded position.
export function isSettling(state: SettlingState) {
	return state.offset !== 0 || state.velocity !== 0
}

// Puts the axis back on target immediately, discarding any ring-down in progress.
export function resetSettling(state: SettlingState) {
	state.offset = 0
	state.velocity = 0
}

// Kicks the axis so that it overshoots by `severity` of the configured peak, with `severity` in
// [-1, 1]: its magnitude scales with how fast the axis was moving when it stopped and its sign is the
// direction it was moving in, since momentum carries the tube on past the target rather than back the
// way it came.
//
// The kick is delivered as velocity rather than displacement, which is what an abrupt stop does: the
// axis is on target at that instant and its momentum carries it past.
//
// A release from zero offset follows (v₀/ω_d)·e^(−ζω_n t)·sin(ω_d t), whose first maximum is not
// v₀/ω_d: the envelope has already decayed by the time the sinusoid gets there. Peaking at
// tan(ω_d t) = ω_d/ζω_n gives an excursion of (v₀/ω_n)·e^(−ζθ/√(1−ζ²)) with θ = atan(√(1−ζ²)/ζ), so
// that attenuation is divided out here and the axis reaches the configured overshoot for any damping.
// Ignoring it made a mount configured for three arcseconds overshoot 2.2 at a damping ratio of 0.2 and
// 0.8 at 0.8, and the shortfall grew precisely with the stiffness somebody had asked for.
export function exciteSettling(state: SettlingState, severity: number, config: SettlingConfig) {
	if (config.frequency <= 0 || config.overshoot <= 0 || severity === 0) return

	const naturalFrequency = TAU * config.frequency
	const dampingRatio = clamp(config.dampingRatio, 0, MAX_DAMPING_RATIO)
	const damped = Math.sqrt(1 - dampingRatio * dampingRatio)
	// Peak of the free response as a fraction of v₀/ω_n. One without damping, and 1/e as the ratio
	// approaches the critical value, which is the closed-form limit of the same expression.
	const attenuation = Math.exp((-dampingRatio * Math.atan2(damped, dampingRatio)) / damped)
	state.velocity += (config.overshoot * clamp(severity, -1, 1) * naturalFrequency) / attenuation
}

// Advances the ring-down by `dtSeconds` and returns how far the axis moved during it, radians.
//
// Uses the closed-form solution of the free damped oscillator rather than stepping the differential
// equation, so the result is exact for any interval. That matters here: the simulation tick is coarse
// compared to a structural resonance of a few hertz, and an explicit integrator would either blow up
// or damp artificially at that step size.
export function advanceSettling(state: SettlingState, dtSeconds: number, config: SettlingConfig) {
	if (dtSeconds <= 0 || config.frequency <= 0 || (state.offset === 0 && state.velocity === 0)) return 0

	const naturalFrequency = TAU * config.frequency
	const dampingRatio = clamp(config.dampingRatio, 0, MAX_DAMPING_RATIO)
	const dampedFrequency = naturalFrequency * Math.sqrt(1 - dampingRatio * dampingRatio)

	const previous = state.offset
	const decay = Math.exp(-dampingRatio * naturalFrequency * dtSeconds)
	const cos = Math.cos(dampedFrequency * dtSeconds)
	const sin = Math.sin(dampedFrequency * dtSeconds)
	const sinCoefficient = (state.velocity + dampingRatio * naturalFrequency * state.offset) / dampedFrequency

	state.offset = decay * (previous * cos + sinCoefficient * sin)
	state.velocity = decay * (state.velocity * cos - (naturalFrequency * naturalFrequency * previous + dampingRatio * naturalFrequency * state.velocity) * (sin / dampedFrequency))

	return state.offset - previous
}
