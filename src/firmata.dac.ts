import type { FirmataClient } from './firmata'
import { PeripheralBase } from './firmata.peripheral'
import { clamp } from './math'

export type MCP4725PowerDownMode = 'normal' | '1k' | '100k' | '500k'

export interface MCP4725Options {
	readonly value?: number
	readonly powerDownMode?: MCP4725PowerDownMode
}

export const DEFAULT_MCP4725_OPTIONS: Required<MCP4725Options> = {
	value: 0,
	powerDownMode: 'normal',
}

export class MCP4725 extends PeripheralBase<MCP4725> {
	static readonly ADDRESS = 0x62
	static readonly ALTERNATIVE_ADDRESS = 0x63
	static readonly MAX_VALUE = 0x0fff
	static readonly FAST_MODE_POWER_DOWN_SHIFT = 4
	static readonly WRITE_DAC_EEPROM_CMD = 0x60
	static readonly EEPROM_POWER_DOWN_SHIFT = 1

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
