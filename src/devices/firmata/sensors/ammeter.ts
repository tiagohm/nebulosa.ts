import type { FirmataClient } from '../firmata'
import { ADCPeripheral, type Ammeter } from '../peripheral'

// Driver for the ACS712 Hall-effect current sensor read on an analog pin. Converts the ADC sample to
// amperes using the sensor's sensitivity (volts per amp) and zero-current bias derived from the options.

// Sensor variant by full-scale current range, in amperes.
export type ACS712Range = 5 | 20 | 30 // A

// Calibration parameters for an ACS712.
export interface ACS712Options {
	// Sensor variant (sets the default sensitivity), amperes.
	readonly range?: ACS712Range // A
	// ADC reference voltage, volts.
	readonly aref?: number // volts
	// Output voltage at zero current, volts.
	readonly zeroCurrentVoltage?: number // volts
	// Maximum ADC count (e.g. 1023 for 10-bit).
	readonly adcResolution?: number
	// Sensor sensitivity, volts per amp; overrides the range-derived default.
	readonly voltsPerAmp?: number
}

// Default ACS712 calibration: 5 A variant, 5 V reference, 2.5 V zero offset, 10-bit ADC, 0.185 V/A.
export const DEFAULT_ACS712_OPTIONS: Required<ACS712Options> = {
	range: 5,
	aref: 5,
	zeroCurrentVoltage: 2.5,
	adcResolution: 1023,
	voltsPerAmp: 0.185,
}

// ACS712 Hall-effect current sensor.
// https://www.allegromicro.com/en/products/sense/current-sensor-ics/integrated-current-sensors/acs712
export class ACS712 extends ADCPeripheral<ACS712> implements Ammeter {
	// Latest current reading, amperes.
	current = 0

	// Precomputed amperes-per-ADC-step and the ADC count corresponding to zero current.
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
}
