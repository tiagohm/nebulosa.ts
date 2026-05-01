import { type FirmataClient, PinMode } from './firmata'
import { ADCPeripheral, type Ammeter } from './firmata.peripheral'

export type ACS712Range = 5 | 20 | 30 // A

export interface ACS712Options {
	readonly range?: ACS712Range // A
	readonly aref?: number // volts
	readonly zeroCurrentVoltage?: number // volts
	readonly adcResolution?: number
	readonly voltsPerAmp?: number
}

export const DEFAULT_ACS712_OPTIONS: Required<ACS712Options> = {
	range: 5,
	aref: 5,
	zeroCurrentVoltage: 2.5,
	adcResolution: 1023,
	voltsPerAmp: 0.185,
}

// https://www.allegromicro.com/en/products/sense/current-sensor-ics/integrated-current-sensors/acs712

export class ACS712 extends ADCPeripheral<ACS712> implements Ammeter {
	current = 0

	readonly #ampsPerStep: number
	readonly #zeroCurrentSteps: number

	readonly name = 'ACS712'

	constructor(
		readonly client: FirmataClient,
		readonly pin: number,
		options: ACS712Options = DEFAULT_ACS712_OPTIONS,
	) {
		super()

		const range = options.range ?? DEFAULT_ACS712_OPTIONS.range
		const aref = options.aref ?? DEFAULT_ACS712_OPTIONS.aref
		const zeroCurrentVoltage = options.zeroCurrentVoltage ?? DEFAULT_ACS712_OPTIONS.zeroCurrentVoltage
		const adcResolution = options.adcResolution ?? DEFAULT_ACS712_OPTIONS.adcResolution
		const voltsPerAmp = options.voltsPerAmp ?? (range === 5 ? 0.185 : range === 20 ? 0.1 : 0.066)

		this.#ampsPerStep = aref / (adcResolution * voltsPerAmp)
		this.#zeroCurrentSteps = (zeroCurrentVoltage * adcResolution) / aref
	}

	// Converts one ADC sample into current using the configured sensitivity and zero-current offset.
	calculate(value: number) {
		const current = (value - this.#zeroCurrentSteps) * this.#ampsPerStep

		if (current !== this.current) {
			this.current = current
			return true
		}

		return false
	}

	// Enables analog reporting for the configured pin.
	start() {
		this.client.addHandler(this)
		this.client.pinMode(this.pin, PinMode.ANALOG)
		this.client.requestAnalogPinReport(this.pin, true)
	}

	// Disables analog reporting and detaches the Firmata handler.
	stop() {
		this.client.removeHandler(this)
		this.client.requestAnalogPinReport(this.pin, false)
	}
}
