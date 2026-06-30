import type { FirmataClient } from '../firmata'
import { DEFAULT_POLLING_INTERVAL, type Magnetometer, PeripheralBase } from '../peripheral'

// Driver for the HMC5883L 3-axis magnetometer over I2C: sets sample averaging, output rate, and gain,
// then continuously reads the X/Z/Y registers and reports the field in gauss. Overflow samples are
// dropped.

// Number of samples averaged per measurement.
export type HMC5883LSampleAveraging = 1 | 2 | 4 | 8

// Output data rate, in Hz.
export type HMC5883LDataRate = 0.75 | 1.5 | 3 | 7.5 | 15 | 30 | 75

// Full-scale field range / gain, in gauss.
export type HMC5883LRange = 0.88 | 1.3 | 1.9 | 2.5 | 4 | 4.7 | 5.6 | 8.1 // gauss

// HMC5883L measurement configuration.
export interface HMC5883LOptions {
	readonly sampleAveraging?: HMC5883LSampleAveraging
	readonly dataRate?: HMC5883LDataRate
	readonly range?: HMC5883LRange // gauss
}

// Default HMC5883L config: no averaging, 15 Hz, ±1.3 gauss.
export const DEFAULT_HMC5883L_OPTIONS: Required<HMC5883LOptions> = {
	sampleAveraging: 1,
	dataRate: 15,
	range: 1.3,
}

// HMC5883L 3-axis magnetometer.
// https://www.digikey.com/htmldatasheets/production/1640724/0/0/1/hmc5883l-datasheet.html
export class HMC5883L extends PeripheralBase<HMC5883L> implements Magnetometer {
	// Latest field components, gauss.
	x = 0
	y = 0
	z = 0

	static readonly ADDRESS = 0x1e

	// Register addresses, continuous-mode value, and the overflow sentinel returned by the chip.
	static readonly CONFIG_A_REG = 0x00
	static readonly CONFIG_B_REG = 0x01
	static readonly MODE_REG = 0x02
	static readonly DATA_X_MSB_REG = 0x03
	static readonly CONTINUOUS_MEASUREMENT_MODE = 0x00
	static readonly OVERFLOW = -4096

	#timer?: NodeJS.Timeout
	// Config-register bytes, gauss-per-count gain, and the data-rate-derived minimum poll period (ms).
	readonly #configA: number
	readonly #configB: number
	readonly #gaussPerCount: number
	readonly #minimumPollingInterval: number

	readonly name = 'HMC5883L'

	constructor(
		readonly client: FirmataClient,
		readonly address: number = HMC5883L.ADDRESS,
		readonly pollingInterval: number = DEFAULT_POLLING_INTERVAL,
		options: HMC5883LOptions = DEFAULT_HMC5883L_OPTIONS,
	) {
		super()

		const sampleAveraging = options.sampleAveraging ?? DEFAULT_HMC5883L_OPTIONS.sampleAveraging
		const dataRate = options.dataRate ?? DEFAULT_HMC5883L_OPTIONS.dataRate
		const range = options.range ?? DEFAULT_HMC5883L_OPTIONS.range

		const averagingBits = sampleAveraging === 1 ? 0 : sampleAveraging === 2 ? 1 : sampleAveraging === 4 ? 2 : 3
		const dataRateBits = dataRate === 0.75 ? 0 : dataRate === 1.5 ? 1 : dataRate === 3 ? 2 : dataRate === 7.5 ? 3 : dataRate === 15 ? 4 : dataRate === 30 ? 5 : 6
		const rangeBits = range === 0.88 ? 0 : range === 1.3 ? 1 : range === 1.9 ? 2 : range === 2.5 ? 3 : range === 4 ? 4 : range === 4.7 ? 5 : range === 5.6 ? 6 : 7
		const countsPerGauss = rangeBits === 0 ? 1370 : rangeBits === 1 ? 1090 : rangeBits === 2 ? 820 : rangeBits === 3 ? 660 : rangeBits === 4 ? 440 : rangeBits === 5 ? 390 : rangeBits === 6 ? 330 : 230

		this.#configA = (averagingBits << 5) | (dataRateBits << 2)
		this.#configB = rangeBits << 5
		this.#gaussPerCount = 1 / countsPerGauss
		this.#minimumPollingInterval = Math.ceil(1000 / dataRate)
	}

	// Configures the magnetometer and starts polling the X/Z/Y output registers.
	start() {
		if (this.#timer === undefined) {
			this.client.addHandler(this)
			this.client.twoWireConfig(0)
			this.client.twoWireWrite(this.address, [HMC5883L.CONFIG_A_REG, this.#configA])
			this.client.twoWireWrite(this.address, [HMC5883L.CONFIG_B_REG, this.#configB])
			this.client.twoWireWrite(this.address, [HMC5883L.MODE_REG, HMC5883L.CONTINUOUS_MEASUREMENT_MODE])
			this.#readMeasurement()
			this.#timer = setInterval(this.#readMeasurement.bind(this), Math.max(this.#minimumPollingInterval, this.pollingInterval))
		}
	}

	// Stops polling and detaches the Firmata handler.
	stop() {
		this.client.removeHandler(this)
		clearInterval(this.#timer)
		this.#timer = undefined
	}

	// Decodes one X/Z/Y sample frame into gauss values.
	twoWireMessage(client: FirmataClient, address: number, register: number, data: Buffer) {
		if (client !== this.client || address !== this.address || register !== HMC5883L.DATA_X_MSB_REG || data.byteLength !== 6) return

		const rawX = data.readInt16BE(0)
		const rawZ = data.readInt16BE(2)
		const rawY = data.readInt16BE(4)

		if (rawX === HMC5883L.OVERFLOW || rawY === HMC5883L.OVERFLOW || rawZ === HMC5883L.OVERFLOW) return

		const x = this.rawToGauss(rawX)
		const y = this.rawToGauss(rawY)
		const z = this.rawToGauss(rawZ)

		const changed = x !== this.x || y !== this.y || z !== this.z

		if (changed) {
			this.x = x
			this.y = y
			this.z = z
		}

		this.commit(changed)
	}

	// Converts a raw signed register value into gauss using the configured gain.
	rawToGauss(raw: number) {
		return raw * this.#gaussPerCount
	}

	// Requests the full X/Z/Y output frame starting at register 0x03.
	#readMeasurement() {
		this.client.twoWireRead(this.address, HMC5883L.DATA_X_MSB_REG, 6)
	}
}
