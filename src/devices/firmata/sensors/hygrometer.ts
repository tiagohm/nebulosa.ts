import type { FirmataClient } from '../firmata'
import { DEFAULT_POLLING_INTERVAL, type Hygrometer, PeripheralBase, type Thermometer } from '../peripheral'

// I2C humidity+temperature sensor drivers over Firmata: AM2320 (Modbus-style holding registers with a
// wake-up sequence) and SHT21 (hold-master register reads). Both poll on a timer and report humidity in
// percent and temperature in degrees Celsius.

// AM2320 combined humidity/temperature sensor.
// https://cdn-shop.adafruit.com/product-files/3721/AM2320.pdf
export class AM2320 extends PeripheralBase<AM2320> implements Hygrometer, Thermometer {
	// Latest humidity (percent) and temperature (degrees Celsius).
	humidity = 0
	temperature = 0

	static readonly ADDRESS = 0x5c

	// Protocol constants: wake/measurement delays (ms), read-registers command, register range, and the
	// expected reply frame length.
	static readonly WAKE_UP_DELAY_MS = 2
	static readonly MEASUREMENT_DELAY_MS = 2
	static readonly READ_HOLDING_REGISTERS_CMD = 0x03
	static readonly START_REGISTER = 0x00
	static readonly REGISTER_COUNT = 4
	static readonly FRAME_SIZE = 8

	#timer?: NodeJS.Timeout
	#reading = false

	readonly name = 'AM2320'

	constructor(
		readonly client: FirmataClient,
		readonly pollingInterval: number = DEFAULT_POLLING_INTERVAL,
	) {
		super()
	}

	// Enables I2C and starts periodic measurement.
	start() {
		if (this.#timer === undefined) {
			this.client.addHandler(this)
			this.client.twoWireConfig(0)
			void this.#readMeasurement()
			this.#timer = setInterval(this.#readMeasurement.bind(this), Math.max(1000, this.pollingInterval))
		}
	}

	// Stops polling and detaches the handler.
	stop() {
		this.client.removeHandler(this)
		clearInterval(this.#timer)
		this.#timer = undefined
		this.#reading = false
	}

	// Wakes the sensor, requests the humidity/temperature holding registers, and triggers the frame read.
	// Guards against overlapping reads.
	async #readMeasurement() {
		if (this.#reading) return

		try {
			this.#reading = true
			this.client.twoWireWrite(AM2320.ADDRESS)
			await Bun.sleep(AM2320.WAKE_UP_DELAY_MS)
			this.client.twoWireWrite(AM2320.ADDRESS, [AM2320.READ_HOLDING_REGISTERS_CMD, AM2320.START_REGISTER, AM2320.REGISTER_COUNT])
			await Bun.sleep(AM2320.MEASUREMENT_DELAY_MS)
			this.client.twoWireRead(AM2320.ADDRESS, -1, AM2320.FRAME_SIZE)
		} finally {
			this.#reading = false
		}
	}

	// Decodes the AM2320 reply frame: humidity (0.1%/LSB) and signed temperature (0.1 °C/LSB), then commits.
	twoWireMessage(client: FirmataClient, address: number, register: number, data: Buffer) {
		if (client !== this.client || address !== AM2320.ADDRESS || data.byteLength !== AM2320.FRAME_SIZE) return
		if (data[0] !== AM2320.READ_HOLDING_REGISTERS_CMD || data[1] !== AM2320.REGISTER_COUNT) return

		const humidity = data.readUint16BE(2) / 10
		const rawTemperature = data.readUint16BE(4) & 0x7fff
		const temperature = (data[4] & 0x80 ? -rawTemperature : rawTemperature) / 10

		const changed = humidity !== this.humidity || temperature !== this.temperature

		if (changed) {
			this.humidity = humidity
			this.temperature = temperature
		}

		this.commit(changed)
	}
}

// SHT21 combined humidity/temperature sensor.
// https://sensirion.com/media/documents/120BBE4C/63500094/Sensirion_Datasheet_Humidity_Sensor_SHT21.pdf
export class SHT21 extends PeripheralBase<SHT21> implements Hygrometer, Thermometer {
	// Latest humidity (percent) and temperature (degrees Celsius).
	humidity = 0
	temperature = 0

	static readonly ADDRESS = 0x40

	// Hold-master read commands for temperature/humidity and the soft-reset command.
	static readonly #READ_TEMP_HOLD_CMD = 0xe3
	static readonly #READ_HUM_HOLD_CMD = 0xe5
	static readonly #SOFT_RESET_CMD = 0xfe

	#timer?: NodeJS.Timeout
	// Tracks a temperature change so a paired humidity reading also fires when only temperature moved.
	#temperatureChanged = false

	readonly name = 'SHT21'

	constructor(
		readonly client: FirmataClient,
		readonly poolingInterval: number = DEFAULT_POLLING_INTERVAL,
	) {
		super()
	}

	// Requests the temperature and humidity registers.
	#readMeasurement() {
		this.client.twoWireRead(SHT21.ADDRESS, SHT21.#READ_TEMP_HOLD_CMD, 2)
		this.client.twoWireRead(SHT21.ADDRESS, SHT21.#READ_HUM_HOLD_CMD, 2)
	}

	// Enables I2C and starts periodic measurement.
	start() {
		if (this.#timer === undefined) {
			this.client.addHandler(this)
			this.client.twoWireConfig(0)
			this.#readMeasurement()
			this.#timer = setInterval(this.#readMeasurement.bind(this), Math.max(1000, this.poolingInterval))
		}
	}

	// Stops polling and detaches the handler.
	stop() {
		this.client.removeHandler(this)
		clearInterval(this.#timer)
		this.#timer = undefined
	}

	// Issues a soft reset to the sensor.
	reset() {
		this.client.twoWireWrite(SHT21.ADDRESS, [SHT21.#SOFT_RESET_CMD])
	}

	// Decodes temperature (-46.85 + 175.72·S/2^16 °C) and humidity (-6 + 125·S/2^16 %) register replies,
	// masking the status bits, and commits once both have been applied.
	twoWireMessage(client: FirmataClient, address: number, register: number, data: Buffer) {
		if (address !== SHT21.ADDRESS || data.byteLength < 1) return

		if (register === SHT21.#READ_TEMP_HOLD_CMD) {
			const raw = data.readUInt16BE(0) & 0xfffc
			const temperature = -46.85 + (175.72 * raw) / 65536

			if (temperature !== this.temperature) {
				this.temperature = temperature
				this.#temperatureChanged = true
			}
		} else if (register === SHT21.#READ_HUM_HOLD_CMD) {
			const raw = data.readUInt16BE(0) & 0xfffc
			const humidity = -6 + (125 * raw) / 65536
			const changed = humidity !== this.humidity || this.#temperatureChanged

			if (changed) {
				this.humidity = humidity
				this.#temperatureChanged = false
			}

			this.commit(changed)
		}
	}
}
