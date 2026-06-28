import { clamp } from '../../../math/numerical/math'
import type { FirmataClient } from '../firmata'
import { PeripheralBase } from '../peripheral'

// Driver for the MCP4725 12-bit I2C DAC over Firmata. Writes the analog output code with the fast-mode
// command, supports power-down modes, and can persist the current code/mode to the chip's EEPROM.

// Output power-down mode: active ('normal') or high-impedance through a pull-down resistor (1k/100k/500k).
export type MCP4725PowerDownMode = 'normal' | '1k' | '100k' | '500k'

// Initial DAC state.
export interface MCP4725Options {
	// Initial 12-bit DAC code (0..4095).
	readonly value?: number
	readonly powerDownMode?: MCP4725PowerDownMode
}

// Default MCP4725 state: zero output, normal (active) mode.
export const DEFAULT_MCP4725_OPTIONS: Required<MCP4725Options> = {
	value: 0,
	powerDownMode: 'normal',
}

// MCP4725 12-bit I2C digital-to-analog converter.
export class MCP4725 extends PeripheralBase<MCP4725> {
	// I2C addresses, the 12-bit full-scale code, the EEPROM write command, and power-down bit shifts.
	static readonly ADDRESS = 0x62
	static readonly ALTERNATIVE_ADDRESS = 0x63
	static readonly MAX_VALUE = 0x0fff
	static readonly FAST_MODE_POWER_DOWN_SHIFT = 4
	static readonly WRITE_DAC_EEPROM_CMD = 0x60
	static readonly EEPROM_POWER_DOWN_SHIFT = 1

	// Current 12-bit code, power-down mode, and started flag.
	#value: number
	#powerDownMode: MCP4725PowerDownMode
	#started = false

	readonly name = 'MCP4725'

	constructor(
		readonly client: FirmataClient,
		readonly address: number = MCP4725.ADDRESS,
		options: MCP4725Options = DEFAULT_MCP4725_OPTIONS,
	) {
		super()
		this.#value = this.#normalizeValue(options.value ?? DEFAULT_MCP4725_OPTIONS.value)
		this.#powerDownMode = options.powerDownMode ?? DEFAULT_MCP4725_OPTIONS.powerDownMode
	}

	// Enables I2C and applies the current DAC state.
	start() {
		if (this.#started) return

		this.#started = true
		this.client.addHandler(this)
		this.client.twoWireConfig(0)
		this.#writeFastMode()
	}

	// Detaches the handler without changing the current analog output state.
	stop() {
		if (!this.#started) return

		this.#started = false
		this.client.removeHandler(this)
	}

	// Gets the current 12-bit DAC code.
	get value() {
		return this.#value
	}

	// Sets the current 12-bit DAC code and writes it when started.
	set value(value: number) {
		const nextValue = this.#normalizeValue(value)

		if (nextValue === this.#value) return

		this.#value = nextValue
		if (this.#started) this.#writeFastMode()
		this.fire()
	}

	// Returns the configured output power-down mode.
	get powerDownMode() {
		return this.#powerDownMode
	}

	// Sets the output power-down mode and applies it immediately when started.
	set powerDownMode(value: MCP4725PowerDownMode) {
		if (value === this.#powerDownMode) return

		this.#powerDownMode = value
		if (this.#started) this.#writeFastMode()
		this.fire()
	}

	// Persists the current DAC code and power-down mode into EEPROM.
	persist() {
		this.client.twoWireWrite(this.address, [MCP4725.WRITE_DAC_EEPROM_CMD | (this.#powerDownBits() << MCP4725.EEPROM_POWER_DOWN_SHIFT), this.#value >>> 4, (this.#value & 0x0f) << 4])
	}

	// Writes the current DAC code with the fast two-byte command.
	#writeFastMode() {
		this.client.twoWireWrite(this.address, [(this.#powerDownBits() << MCP4725.FAST_MODE_POWER_DOWN_SHIFT) | (this.#value >>> 8), this.#value & 0xff])
	}

	// Clamps and rounds one DAC code to the device 12-bit range.
	#normalizeValue(value: number) {
		return clamp(Math.round(value), 0, MCP4725.MAX_VALUE)
	}

	// Converts the public power-down mode into the device command bits.
	#powerDownBits() {
		return this.#powerDownMode === '1k' ? 1 : this.#powerDownMode === '100k' ? 2 : this.#powerDownMode === '500k' ? 3 : 0
	}
}
