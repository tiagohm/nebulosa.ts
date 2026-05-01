import { CRC } from './crc'
import { type FirmataClient, type OneWirePowerMode, PinMode } from './firmata'
import { ADCPeripheral, DEFAULT_POLLING_INTERVAL, PeripheralBase, type Thermometer } from './firmata.peripheral'
import type { NumberArray } from './math'

export type DS18B20Resolution = 9 | 10 | 11 | 12

export interface DS18B20Options {
	readonly address?: Readonly<NumberArray> | Buffer
	readonly skip?: boolean
	readonly resolution?: DS18B20Resolution
	readonly powerMode?: OneWirePowerMode
}

export const DEFAULT_DS18B20_OPTIONS: Required<Omit<DS18B20Options, 'address'>> = {
	resolution: 12,
	powerMode: 'normal',
	skip: false, // true for skip search ROM address when address is not provided
}

export class LM35 extends ADCPeripheral<LM35> implements Thermometer {
	temperature = 0

	readonly name = 'LM35'

	constructor(
		readonly client: FirmataClient,
		readonly pin: number,
		readonly aref: number = 5, // volts
	) {
		super()
	}

	calculate(value: number) {
		const temperature = (this.aref * 100 * value) / 1023

		if (temperature !== this.temperature) {
			this.temperature = temperature
			return true
		}

		return false
	}

	start() {
		this.client.addHandler(this)
		this.client.pinMode(this.pin, PinMode.ANALOG)
		this.client.requestAnalogPinReport(this.pin, true)
	}

	stop() {
		this.client.removeHandler(this)
		this.client.requestAnalogPinReport(this.pin, false)
	}
}

// https://www.analog.com/media/en/technical-documentation/data-sheets/ds18b20.pdf

export class DS18B20 extends PeripheralBase<DS18B20> implements Thermometer {
	temperature = 0

	static readonly CONVERT_T_CMD = [0x44] as const
	static readonly READ_SCRATCHPAD_CMD = [0xbe] as const
	static readonly WRITE_SCRATCHPAD_CMD = 0x4e
	static readonly FAMILY_CODE = 0x28
	static readonly DEFAULT_TH = 0x4b
	static readonly DEFAULT_TL = 0x46
	static readonly SCRATCHPAD_SIZE = 9

	#timer?: NodeJS.Timeout
	#reading = false
	#pendingReadCorrelationId?: number
	#address?: Buffer
	#skip = false
	readonly #powerMode: OneWirePowerMode
	readonly #conversionDelayMs: number
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

	stop() {
		this.client.removeHandler(this)
		clearInterval(this.#timer)
		this.#timer = undefined
		this.#reading = false
		this.#pendingReadCorrelationId = undefined
	}

	oneWireReadReply(client: FirmataClient, pin: number, correlationId: number, data: Buffer) {
		if (client !== this.client || pin !== this.pin || correlationId !== this.#pendingReadCorrelationId) return

		this.#pendingReadCorrelationId = undefined

		if (!DS18B20.isScratchpadValid(data)) return

		const temperature = data.readInt16LE(0) * 0.0625

		if (temperature !== this.temperature) {
			this.temperature = temperature
			this.fire()
		}
	}

	oneWireSearchReply(client: FirmataClient, pin: number, addresses: readonly Buffer[], alarms: boolean) {
		if (client !== this.client || pin !== this.pin || alarms || this.#address !== undefined) return

		const address = addresses.find((value) => value.byteLength === 8 && value[0] === DS18B20.FAMILY_CODE)

		if (address === undefined) return

		this.#address = Buffer.from(address)
		console.info('DS18B20 found:', this.#address.toHex().toUpperCase())

		this.#startMeasurement()
	}

	#startMeasurement() {
		this.#configureResolution()
		void this.#readMeasurement()
		this.#timer ??= setInterval(this.#readMeasurement.bind(this), Math.max(1000, this.pollingInterval))
	}

	#configureResolution() {
		if (this.#resolutionCommand !== undefined) {
			this.client.oneWireWrite(this.pin, this.#resolutionCommand, this.#address)
		}
	}

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

	static isScratchpadValid(data: Buffer) {
		if (data.byteLength < DS18B20.SCRATCHPAD_SIZE) return false
		return CRC.crc8maxim.compute(data, undefined, 0, 8) === data[8]
	}
}
