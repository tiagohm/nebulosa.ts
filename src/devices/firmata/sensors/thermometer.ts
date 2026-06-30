import { CRC } from '../../../io/crc'
import type { NumberArray } from '../../../math/numerical/math'
import type { FirmataClient, OneWirePowerMode } from '../firmata'
import { ADCPeripheral, DEFAULT_POLLING_INTERVAL, PeripheralBase, type Thermometer } from '../peripheral'

// Thermometer drivers: the LM35 analog temperature sensor (read on an ADC pin) and the DS18B20 1-Wire
// digital sensor (addressed/searched on the bus, with selectable resolution and CRC-validated readout).

// DS18B20 conversion resolution in bits; higher resolution means longer conversion time.
export type DS18B20Resolution = 9 | 10 | 11 | 12

// DS18B20 configuration: optional fixed ROM address, skip-ROM flag, resolution, and bus power mode.
export interface DS18B20Options {
	// 8-byte 1-Wire ROM address; when omitted the bus is searched.
	readonly address?: Readonly<NumberArray> | Buffer
	// Use SKIP ROM instead of searching/addressing (only valid with a single device on the bus).
	readonly skip?: boolean
	// Conversion resolution, bits.
	readonly resolution?: DS18B20Resolution
	// Bus power scheme.
	readonly powerMode?: OneWirePowerMode
}

// Default DS18B20 options: 12-bit resolution, externally powered, no skip-ROM.
export const DEFAULT_DS18B20_OPTIONS: Required<Omit<DS18B20Options, 'address'>> = {
	resolution: 12,
	powerMode: 'normal',
	skip: false, // true for skip search ROM address when address is not provided
}

// LM35 analog temperature sensor (10 mV/°C) read on an ADC pin.
export class LM35 extends ADCPeripheral<LM35> implements Thermometer {
	// Latest temperature, degrees Celsius.
	temperature = 0

	readonly name = 'LM35'

	constructor(
		readonly client: FirmataClient,
		readonly pin: number,
		readonly aref: number = 5, // volts
	) {
		super()
	}

	// Converts the ADC sample to degrees Celsius (10 mV/°C against a 10-bit ADC at `aref`).
	calculate(value: number) {
		const temperature = (this.aref * 100 * value) / 1023

		if (temperature !== this.temperature) {
			this.temperature = temperature
			return true
		}

		return false
	}
}

// DS18B20 1-Wire digital thermometer.
// https://www.analog.com/media/en/technical-documentation/data-sheets/ds18b20.pdf
export class DS18B20 extends PeripheralBase<DS18B20> implements Thermometer {
	// Latest temperature, degrees Celsius.
	temperature = 0

	// 1-Wire command bytes and constants (Convert T, Read/Write Scratchpad, family code, alarm defaults,
	// scratchpad length).
	static readonly CONVERT_T_CMD = [0x44] as const
	static readonly READ_SCRATCHPAD_CMD = [0xbe] as const
	static readonly WRITE_SCRATCHPAD_CMD = 0x4e
	static readonly FAMILY_CODE = 0x28
	static readonly DEFAULT_TH = 0x4b
	static readonly DEFAULT_TL = 0x46
	static readonly SCRATCHPAD_SIZE = 9

	#timer?: NodeJS.Timeout
	// Guards a conversion in progress and the id of the outstanding scratchpad read.
	#reading = false
	#pendingReadCorrelationId?: number
	// Resolved ROM address (from options or bus search).
	#address?: Buffer
	readonly #skip: boolean = false
	readonly #powerMode: OneWirePowerMode
	// Conversion wait time for the configured resolution, milliseconds.
	readonly #conversionDelayMs: number
	// Write-scratchpad command that sets a non-default resolution, if any.
	readonly #resolutionCommand?: readonly number[]

	readonly name = 'DS18B20'

	constructor(
		readonly client: FirmataClient,
		readonly pin: number,
		readonly pollingInterval: number = DEFAULT_POLLING_INTERVAL,
		options: DS18B20Options = DEFAULT_DS18B20_OPTIONS,
	) {
		super()

		const resolution = options.resolution ?? DEFAULT_DS18B20_OPTIONS.resolution
		const powerMode = options.powerMode ?? DEFAULT_DS18B20_OPTIONS.powerMode
		const skip = options.skip ?? DEFAULT_DS18B20_OPTIONS.skip
		const address = options.address

		if (address !== undefined) {
			if (address.length !== 8) throw new RangeError(`One-Wire address must contain 8 bytes. Received ${address.length}`)
			this.#address = Buffer.from(address)
		} else {
			this.#skip = skip
		}

		this.#powerMode = powerMode
		this.#conversionDelayMs = resolution === 9 ? 94 : resolution === 10 ? 188 : resolution === 11 ? 375 : 750

		if (resolution !== 12) {
			const resolutionBits = resolution === 9 ? 0x1f : resolution === 10 ? 0x3f : resolution === 11 ? 0x5f : 0x7f
			this.#resolutionCommand = [DS18B20.WRITE_SCRATCHPAD_CMD, DS18B20.DEFAULT_TH, DS18B20.DEFAULT_TL, resolutionBits]
		}
	}

	// Configures the 1-Wire bus and either searches for the sensor (when no address is set and not
	// skipping) or starts periodic measurement immediately.
	start() {
		if (this.#timer === undefined) {
			this.client.addHandler(this)
			this.client.oneWireConfig(this.pin, this.#powerMode)

			if (this.#address === undefined) {
				// Search ROM address
				if (this.#skip === false) {
					this.client.oneWireSearch(this.pin)
					return
				}
			}

			this.#startMeasurement()
		}
	}

	// Detaches the handler and clears the timer and pending-read state.
	stop() {
		this.client.removeHandler(this)
		clearInterval(this.#timer)
		this.#timer = undefined
		this.#reading = false
		this.#pendingReadCorrelationId = undefined
	}

	// Handles a scratchpad read reply for our pending request: validates the CRC, decodes the 16-bit
	// temperature (0.0625 °C/LSB), and commits the reading.
	oneWireReadReply(client: FirmataClient, pin: number, correlationId: number, data: Buffer) {
		if (client !== this.client || pin !== this.pin || correlationId !== this.#pendingReadCorrelationId) return

		this.#pendingReadCorrelationId = undefined

		if (!DS18B20.isScratchpadValid(data)) return

		const temperature = data.readInt16LE(0) * 0.0625
		const changed = temperature !== this.temperature
		if (changed) this.temperature = temperature
		this.commit(changed)
	}

	// Handles a bus-search reply: adopts the first DS18B20-family address found and begins measuring.
	oneWireSearchReply(client: FirmataClient, pin: number, addresses: readonly Buffer[], alarms: boolean) {
		if (client !== this.client || pin !== this.pin || alarms || this.#address !== undefined) return

		const address = addresses.find((value) => value.byteLength === 8 && value[0] === DS18B20.FAMILY_CODE)

		if (address === undefined) return

		this.#address = Buffer.from(address)
		console.info('DS18B20 found:', this.#address.toHex().toUpperCase())

		this.#startMeasurement()
	}

	// Applies the resolution setting, takes a first reading, and starts the polling timer.
	#startMeasurement() {
		this.#configureResolution()
		void this.#readMeasurement()
		this.#timer ??= setInterval(this.#readMeasurement.bind(this), Math.max(1000, this.pollingInterval))
	}

	// Writes the scratchpad to set a non-default resolution, if one was configured.
	#configureResolution() {
		if (this.#resolutionCommand !== undefined) {
			this.client.oneWireWrite(this.pin, this.#resolutionCommand, this.#address)
		}
	}

	// Triggers a temperature conversion, waits the conversion delay, then requests the scratchpad. Guards
	// against overlapping reads and missing addressing.
	async #readMeasurement() {
		if (this.#reading || this.#pendingReadCorrelationId !== undefined) return
		if (this.#address === undefined && !this.#skip) return

		try {
			this.#reading = true
			this.client.oneWireWrite(this.pin, DS18B20.CONVERT_T_CMD, this.#address)
			await Bun.sleep(this.#conversionDelayMs)
			this.#pendingReadCorrelationId = this.client.oneWireWriteAndRead(this.pin, DS18B20.READ_SCRATCHPAD_CMD, DS18B20.SCRATCHPAD_SIZE, this.#address)
		} finally {
			this.#reading = false
		}
	}

	// Validates a 9-byte scratchpad by checking its Maxim/Dallas CRC-8 over the first 8 bytes.
	static isScratchpadValid(data: Buffer) {
		if (data.byteLength < DS18B20.SCRATCHPAD_SIZE) return false
		return CRC.crc8maxim.compute(data, undefined, 0, 8) === data[8]
	}
}
