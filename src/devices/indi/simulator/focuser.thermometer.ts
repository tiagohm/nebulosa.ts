import { TAU } from '../../../core/constants'
import { normalizeAngle } from '../../../math/units/angle'
import { makeNumberVector } from '../types'
import { type ComponentBus, SimulatorComponent } from './component'
import { MAIN_CONTROL } from './constants'
import type { FocuserThermometerConfig } from './focuser.config'

// Thermometer circuit of the simulated focuser: the probe reading an ambient temperature that swings
// sinusoidally about its mean, in °C. Published when it moved by a tenth of a degree, the resolution of
// a typical probe.

// Smallest change of the reading that is published, °C.
const RESOLUTION = 0.1

// The temperature probe.
export class FocuserThermometer extends SimulatorComponent {
	readonly #temperature: ReturnType<typeof makeNumberVector>

	readonly properties: readonly ReturnType<typeof makeNumberVector>[]
	readonly transient: readonly ReturnType<typeof makeNumberVector>[]

	// Phase of the swing, radians in [0, TAU).
	#phase = 0
	// Instant the swing was last advanced to, milliseconds, or undefined before the first tick.
	#lastTime?: number

	// `config` gives the mean, the amplitude and the period of the swing.
	constructor(
		bus: ComponentBus,
		readonly config: FocuserThermometerConfig,
	) {
		super(bus)
		this.#temperature = makeNumberVector('', 'FOCUS_TEMPERATURE', 'Temperature', MAIN_CONTROL, 'ro', ['TEMPERATURE', 'Temperature', config.ambient, -50, 70, 0.1, '%6.2f'])
		this.properties = [this.#temperature]
		this.transient = this.properties
	}

	// Temperature last published, °C.
	get temperature() {
		return this.#temperature.elements.TEMPERATURE.value
	}

	// Advances the swing up to `now`, milliseconds, publishing a reading that moved by the resolution.
	tick(now: number) {
		const dtSeconds = this.#lastTime === undefined ? 0 : Math.max(0, (now - this.#lastTime) / 1000)
		this.#lastTime = now
		if (dtSeconds <= 0) return

		this.#phase = normalizeAngle(this.#phase + (dtSeconds * TAU) / this.config.period)
		const temperature = this.config.ambient + Math.sin(this.#phase) * this.config.amplitude

		if (Math.abs(temperature - this.temperature) >= RESOLUTION) {
			this.#temperature.elements.TEMPERATURE.value = temperature
			this.bus.notify(this.#temperature)
		}
	}

	// Restarts the clock of the swing when the device disconnects, so the time spent off is not a jump.
	reset() {
		this.#lastTime = undefined
	}
}
