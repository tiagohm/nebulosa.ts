import { clamp } from '../../../math/numerical/math'
import { makeNumberVector, makeSwitchVector, type NewNumberVector, type NewSwitchVector, type PropertyState } from '../types'
import type { CameraCoolerConfig } from './camera.config'
import { type ComponentBus, SimulatorComponent } from './component'
import { MAIN_CONTROL } from './constants'
import { applyExclusiveSwitchValues } from './util'

// Cooling circuit of the simulated camera: a thermoelectric cooler, the thermistor that reads the
// sensor and a first-order thermal model between them. Temperatures are °C, times milliseconds on the
// bus clock and time constants seconds.

// Temperature difference from the target below which the reading snaps onto it, °C. Keeps the
// exponential approach from publishing ever smaller steps forever.
const TEMPERATURE_SNAP = 0.02

// Smallest change of the reading worth publishing, °C.
const TEMPERATURE_NOTIFY_STEP = 0.1

// Smallest change of the cooler power worth publishing, percent.
const POWER_NOTIFY_STEP = 0.5

// Temperature the sensor reaches after `elapsed` seconds of first-order approach from `current`
// towards `target` with time constant `timeConstant` seconds, snapping onto the target once within
// TEMPERATURE_SNAP of it. Independent of how the interval is split: two steps of t equal one of 2t.
export function approachTemperature(current: number, target: number, elapsed: number, timeConstant: number) {
	const next = current + (target - current) * (1 - Math.exp(-Math.max(0, elapsed) / timeConstant))
	return Math.abs(target - next) < TEMPERATURE_SNAP ? target : next
}

// Cooler power needed to hold `temperature` against `ambient`, percent within [0, 100].
export function coolerPower(temperature: number, ambient: number, powerPerDegree: number) {
	return clamp(Math.max(0, ambient - temperature) * powerPerDegree, 0, 100)
}

// Thermoelectric cooler and sensor thermistor.
//
// CCD_TEMPERATURE is Busy while the reading ramps towards a target, Ok once it stands within the
// threshold of it and Idle while the cooler is off, the way INDI CCD drivers report it.
export class CameraCooler extends SimulatorComponent {
	readonly #cooler = makeSwitchVector('', 'CCD_COOLER', 'Cooler', MAIN_CONTROL, 'OneOfMany', 'rw', ['COOLER_ON', 'On', false], ['COOLER_OFF', 'Off', true])
	readonly #temperature = makeNumberVector('', 'CCD_TEMPERATURE', 'Temperature', MAIN_CONTROL, 'rw', ['CCD_TEMPERATURE_VALUE', 'Temperature', 0, -50, 70, 0.1, '%6.2f'])
	readonly #power = makeNumberVector('', 'CCD_COOLER_POWER', 'Cooler Power', MAIN_CONTROL, 'ro', ['CCD_COOLER_POWER', 'Power (%)', 0, 0, 100, 1, '%.0f'])

	readonly properties = [this.#cooler, this.#temperature, this.#power]
	readonly transient = this.properties

	#target: number
	#lastTime: number

	// `config` sets the ambient temperature, the initial target and the thermal model. The sensor
	// starts at ambient with the cooler off.
	constructor(
		bus: ComponentBus,
		readonly config: CameraCoolerConfig,
	) {
		super(bus)
		this.#target = config.targetTemperature
		this.#temperature.elements.CCD_TEMPERATURE_VALUE.value = config.ambientTemperature
		this.#lastTime = bus.now()
	}

	// Sensor temperature the thermistor reads, °C.
	get temperature() {
		return this.#temperature.elements.CCD_TEMPERATURE_VALUE.value
	}

	// Cooling target, °C.
	get targetTemperature() {
		return this.#target
	}

	// Whether the cooler is on.
	get enabled() {
		return this.#cooler.elements.COOLER_ON.value
	}

	// Cooler power, percent.
	get power() {
		return this.#power.elements.CCD_COOLER_POWER.value
	}

	// Sets the cooling target, clamped to the range of CCD_TEMPERATURE, and answers it: Ok when the
	// reading already stands within the threshold, Busy while it has to ramp.
	setTargetTemperature(value: number) {
		const { min, max } = this.#temperature.elements.CCD_TEMPERATURE_VALUE
		this.#target = clamp(value, min, max)
		this.#temperature.state = Math.abs(this.temperature - this.#target) <= this.config.threshold ? 'Ok' : 'Busy'
		this.bus.notify(this.#temperature)
	}

	// Handles CCD_TEMPERATURE.
	handleNumber(vector: NewNumberVector) {
		if (vector.name !== 'CCD_TEMPERATURE') return false
		const value = vector.elements.CCD_TEMPERATURE_VALUE
		if (value !== undefined) this.setTargetTemperature(value)
		return true
	}

	// Handles CCD_COOLER.
	handleSwitch(vector: NewSwitchVector) {
		if (vector.name !== 'CCD_COOLER') return false
		if (applyExclusiveSwitchValues(this.#cooler, vector.elements)) this.bus.notify(this.#cooler)
		return true
	}

	// Advances the thermal model to `now`, milliseconds, and publishes the reading and the power when
	// they changed by a visible amount or the state changed.
	tick(now: number) {
		const elapsed = (now - this.#lastTime) / 1000
		this.#lastTime = now
		const { ambientTemperature, coolingTimeConstant, warmingTimeConstant, powerPerDegree, threshold } = this.config
		const enabled = this.enabled
		const current = this.temperature
		const target = enabled ? this.#target : ambientTemperature
		const next = approachTemperature(current, target, elapsed, enabled ? coolingTimeConstant : warmingTimeConstant)
		const power = enabled ? coolerPower(next, ambientTemperature, powerPerDegree) : 0
		const state: PropertyState = !enabled ? 'Idle' : Math.abs(target - next) <= threshold ? 'Ok' : 'Busy'
		const changed = Math.abs(next - current) >= TEMPERATURE_NOTIFY_STEP || (next === target && next !== current) || state !== this.#temperature.state

		this.#temperature.elements.CCD_TEMPERATURE_VALUE.value = next
		this.#temperature.state = state

		if (Math.abs(this.power - power) >= POWER_NOTIFY_STEP || (power === 0 && this.power !== 0)) {
			this.#power.elements.CCD_COOLER_POWER.value = power
			this.bus.notify(this.#power)
		}

		if (changed) this.bus.notify(this.#temperature)
	}
}
