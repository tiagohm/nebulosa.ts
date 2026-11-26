import { ASEC2RAD } from '../../../core/constants'
import { mulberry32, normal, type Random } from '../../../math/numerical/random'
import type { Angle } from '../../../math/units/angle'
import type { NewNumberVector } from '../types'
import { type ComponentBus, makeBoundNumberVector, type NumberBinding, readBoundNumberVector, SimulatorComponent } from './component'
import { SIMULATION } from './constants'
import type { MountWindConfig } from './mount.config'
import { applyNumberVectorValues } from './util'

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

// Terms of MOUNT_WIND: amplitude in arcseconds and correlation time in seconds.
const WIND: readonly NumberBinding<keyof MountWindConfig>[] = [
	['AMPLITUDE', 'Amplitude (arcsec)', 'amplitude', 0, 600, 0.1, '%.3f'],
	['CORRELATION_TIME', 'Correlation Time (s)', 'correlationTime', 0.1, 300, 0.1, '%.2f'],
]

// Buffeting of the telescope by wind: a bounded random deflection of the optical axis with a memory of
// its own, which also stands for the centroid wander of seeing. Draws from its own generator.
export class MountWind extends SimulatorComponent {
	readonly #wind: ReturnType<typeof makeBoundNumberVector>

	readonly properties: readonly ReturnType<typeof makeBoundNumberVector>[]

	// Current deflection, east and north on the sky, radians.
	readonly state = windState()
	// Conditions in effect, the identity while the family is off or the air is still.
	#config: WindConfig = IDENTITY_WIND_CONFIG
	// Whether the wind family is simulated; set through `refresh`.
	#enabled = false
	// Standard normal source of the gusts.
	readonly #normal: Random

	// `config` gives the initial conditions, `seed` the generator; `changed` runs after a command
	// changed them.
	constructor(
		bus: ComponentBus,
		config: MountWindConfig,
		seed: number,
		readonly changed: () => void,
	) {
		super(bus)
		this.#wind = makeBoundNumberVector('MOUNT_WIND', 'Wind', SIMULATION, WIND, config)
		this.properties = [this.#wind]
		this.#normal = normal(mulberry32(seed))
	}

	// Conditions in effect.
	get config() {
		return this.#config
	}

	// Rebuilds the conditions for the family being `enabled` or not, reseeding the deflection from the
	// settled distribution only when they really changed: reseeding on an unrelated feature switch would
	// teleport the optical axis by about an arcsecond.
	refresh(enabled: boolean) {
		this.#enabled = enabled
		const { amplitude, correlationTime } = readBoundNumberVector(this.#wind, WIND)
		const previous = this.#config
		this.#config = enabled && amplitude > 0 ? { amplitude: amplitude * ASEC2RAD, correlationTime } : IDENTITY_WIND_CONFIG
		if (this.#config.amplitude !== previous.amplitude || this.#config.correlationTime !== previous.correlationTime) resetWind(this.state, this.#config, this.#normal)
	}

	// Advances the deflection over `dtSeconds`. Exact over any interval, so splitting one costs nothing.
	advance(dtSeconds: number) {
		advanceWind(this.state, dtSeconds, this.#config, this.#normal)
	}

	// Handles MOUNT_WIND.
	handleNumber(vector: NewNumberVector) {
		if (vector.name !== this.#wind.name) return false

		if (applyNumberVectorValues(this.#wind, vector.elements)) {
			this.refresh(this.#enabled)
			this.changed()
			this.bus.notify(this.#wind)
		}

		return true
	}
}
