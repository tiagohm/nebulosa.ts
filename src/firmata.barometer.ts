import { fromPressure } from './distance'
import type { FirmataClient } from './firmata'
import { type Altimeter, type Barometer, DEFAULT_POLLING_INTERVAL, PeripheralBase, type Thermometer } from './firmata.peripheral'
import { pascal } from './pressure'

export type BMP280OperatingMode = 'sleep' | 'forced' | 'normal'

export type BMP280Sampling = 'skip' | 'x1' | 'x2' | 'x4' | 'x8' | 'x16'

export type BMP280Filter = 'off' | 'x2' | 'x4' | 'x8' | 'x16'

export type BMP280StandbyDuration = 0.5 | 62.5 | 125 | 250 | 500 | 1000 | 2000 | 4000 // ms

export interface BMP280Options {
	readonly mode?: BMP280OperatingMode
	readonly temperatureSampling?: BMP280Sampling // Reduces noise and increases the output resolution by one bit
	readonly pressureSampling?: BMP280Sampling // Reduces noise and increases the output resolution by one bit
	readonly filter?: BMP280Filter // Supress environment disturbances in the output data
	readonly standbyDuration?: BMP280StandbyDuration // Standby period between two measurement cycles in normal mode
}

export enum BMP180Mode {
	ULTRA_LOW_POWER, // 5 ms
	STANDARD, // 8 ms
	HIGH_RESOLUTION, // 14 ms
	ULTRA_HIGH_RESOLUTION, // 26 ms
}

export const DEFAULT_BMP280_OPTIONS: Required<BMP280Options> = {
	mode: 'normal',
	temperatureSampling: 'x1',
	pressureSampling: 'x1',
	filter: 'off',
	standbyDuration: 1000,
}

// https://cdn-shop.adafruit.com/datasheets/BST-BMP180-DS000-09.pdf

export class BMP180 extends PeripheralBase<BMP180> implements Barometer, Altimeter, Thermometer {
	pressure = 0
	altitude = 0
	temperature = 0

	// Initial values from datasheet (for test only)
	#AC1 = 408
	#AC2 = -72
	#AC3 = -14383
	#AC4 = 32741
	#AC5 = 32757
	#AC6 = 23153

	#B1 = 6190
	#B2 = 4

	// #MB = -32768
	#MC = -8711
	#MD = 2868

	#B5 = 0

	static readonly ADDRESS = 0x77

	static readonly COEFFICIENTS_REG = 0xaa
	static readonly CONTROL_REG = 0xf4
	static readonly TEMP_DATA_REG = 0xf6
	static readonly PRES_DATA_REG = 0xf6

	static readonly READ_TEMP_CMD = 0x2e
	static readonly READ_PRES_CMD = 0x34

	#timer?: NodeJS.Timeout
	#initialized = false
	#command = BMP180.READ_TEMP_CMD

	readonly name = 'BMP180'

	constructor(
		readonly client: FirmataClient,
		readonly mode: BMP180Mode = 0,
		readonly pollingInterval: number = DEFAULT_POLLING_INTERVAL,
	) {
		super()
	}

	twoWireMessage(client: FirmataClient, address: number, register: number, data: Buffer) {
		if (address !== BMP180.ADDRESS) return

		if (!this.#initialized) {
			if (register !== BMP180.COEFFICIENTS_REG || data.byteLength !== 22) return

			this.#AC1 = data.readInt16BE(0)
			this.#AC2 = data.readInt16BE(2)
			this.#AC3 = data.readInt16BE(4)
			this.#AC4 = data.readUInt16BE(6)
			this.#AC5 = data.readUInt16BE(8)
			this.#AC6 = data.readUInt16BE(10)
			this.#B1 = data.readInt16BE(12)
			this.#B2 = data.readInt16BE(14)
			// this.MB = data.readInt16BE(16)
			this.#MC = data.readInt16BE(18)
			this.#MD = data.readInt16BE(20)

			void this.#readUncompensatedTemperature()
			this.#timer = setInterval(this.#readUncompensatedTemperature.bind(this), Math.max(1000, this.pollingInterval))

			this.#initialized = true

			return
		}

		if (this.#command === BMP180.READ_TEMP_CMD) {
			if (register !== BMP180.TEMP_DATA_REG || data.byteLength !== 2) return

			const UT = data.readInt16BE(0)
			this.temperature = this.calculateTrueTemperature(UT)
			this.#command = BMP180.READ_PRES_CMD
			void this.#readUncompensatedPressure()
		} else if (this.#command === BMP180.READ_PRES_CMD) {
			if (register !== BMP180.PRES_DATA_REG || data.byteLength !== 3) return

			const UP = ((data.readUint8(0) << 16) | data.readUint16BE(1)) >> (8 - this.mode)
			this.pressure = pascal(this.calculateTruePressure(UP))
			this.altitude = fromPressure(this.pressure, this.temperature)
			this.#command = BMP180.READ_TEMP_CMD
			this.fire()
		}
	}

	start() {
		if (this.#timer === undefined) {
			this.#command = BMP180.READ_TEMP_CMD
			this.client.addHandler(this)
			this.client.twoWireConfig(0)
			this.#readCalibrationData()
		}
	}

	stop() {
		this.client.removeHandler(this)
		clearInterval(this.#timer)
		this.#timer = undefined
	}

	#readCalibrationData() {
		this.client.twoWireRead(BMP180.ADDRESS, BMP180.COEFFICIENTS_REG, 22)
	}

	async #readUncompensatedTemperature() {
		this.client.twoWireWrite(BMP180.ADDRESS, [BMP180.CONTROL_REG, BMP180.READ_TEMP_CMD])
		await Bun.sleep(5)
		this.client.twoWireRead(BMP180.ADDRESS, BMP180.TEMP_DATA_REG, 2)
	}

	async #readUncompensatedPressure() {
		this.client.twoWireWrite(BMP180.ADDRESS, [BMP180.CONTROL_REG, BMP180.READ_PRES_CMD | (this.mode << 6)])
		await Bun.sleep(30)
		this.client.twoWireRead(BMP180.ADDRESS, BMP180.PRES_DATA_REG, 3)
	}

	calculateTrueTemperature(UT: number) {
		const X1 = ((UT - this.#AC6) * this.#AC5) >> 15
		const X2 = Math.round((this.#MC << 11) / (X1 + this.#MD))
		this.#B5 = X1 + X2
		return ((this.#B5 + 8) >> 4) / 10
	}

	calculateTruePressure(UP: number) {
		const B6 = this.#B5 - 4000
		const K = (B6 * B6) >> 12
		let X3 = (this.#B2 * K + this.#AC2 * B6) >> 11
		const B3 = (((this.#AC1 * 4 + X3) << this.mode) + 2) >> 2
		let X1 = (this.#AC3 * B6) >> 13
		let X2 = (this.#B1 * K) >> 16
		X3 = (X1 + X2 + 2) >> 2
		const B4 = (this.#AC4 * (X3 + 32768)) >>> 15
		const B7 = (UP - B3) * (50000 >> this.mode)
		const P = Math.round(B7 < 0x80000000 ? (B7 * 2) / B4 : (B7 / B4) * 2)
		X1 = (P >> 8) * (P >> 8)
		X1 = (X1 * 3038) >> 16
		X2 = (-7357 * P) >> 16
		return P + ((X1 + X2 + 3791) >> 4)
	}
}

// https://www.bosch-sensortec.com/media/boschsensortec/downloads/datasheets/bst-bmp280-ds001.pdf

export class BMP280 extends PeripheralBase<BMP280> implements Barometer, Altimeter, Thermometer {
	pressure = 0
	altitude = 0
	temperature = 0

	static readonly ADDRESS = 0x76
	static readonly ALTERNATIVE_ADDRESS = 0x77

	static readonly CALIBRATION_REG = 0x88
	static readonly DATA_REG = 0xf7
	static readonly CTRL_MEAS_REG = 0xf4
	static readonly CONFIG_REG = 0xf5

	// Initial values from datasheet (for test only)
	#T1 = 27504
	#T2 = 26435
	#T3 = -1000
	#P1 = 36477
	#P2 = -10685
	#P3 = 3024
	#P4 = 2855
	#P5 = 140
	#P6 = -7
	#P7 = 15500
	#P8 = -14600
	#P9 = 6000
	#tFine = 0

	#initialized = false
	#timer?: NodeJS.Timeout
	readonly #ctrlMeasValue: number
	readonly #configValue: number

	readonly name = 'BMP280'

	constructor(
		readonly client: FirmataClient,
		readonly address: number = BMP280.ADDRESS,
		readonly pollingInterval: number = DEFAULT_POLLING_INTERVAL,
		options: BMP280Options = DEFAULT_BMP280_OPTIONS,
	) {
		super()

		const mode = options.mode ?? DEFAULT_BMP280_OPTIONS.mode
		const temperatureSampling = options.temperatureSampling ?? DEFAULT_BMP280_OPTIONS.temperatureSampling
		const pressureSampling = options.pressureSampling ?? DEFAULT_BMP280_OPTIONS.pressureSampling
		const filter = options.filter ?? DEFAULT_BMP280_OPTIONS.filter
		const standbyDuration = options.standbyDuration ?? DEFAULT_BMP280_OPTIONS.standbyDuration

		const modeBits = mode === 'sleep' ? 0 : mode === 'forced' ? 1 : 3
		const temperatureSamplingBits = temperatureSampling === 'skip' ? 0 : temperatureSampling === 'x1' ? 1 : temperatureSampling === 'x2' ? 2 : temperatureSampling === 'x4' ? 3 : temperatureSampling === 'x8' ? 4 : 5
		const pressureSamplingBits = pressureSampling === 'skip' ? 0 : pressureSampling === 'x1' ? 1 : pressureSampling === 'x2' ? 2 : pressureSampling === 'x4' ? 3 : pressureSampling === 'x8' ? 4 : 5
		const filterBits = filter === 'off' ? 0 : filter === 'x2' ? 1 : filter === 'x4' ? 2 : filter === 'x8' ? 3 : 4
		const standbyBits = standbyDuration === 0.5 ? 0 : standbyDuration === 62.5 ? 1 : standbyDuration === 125 ? 2 : standbyDuration === 250 ? 3 : standbyDuration === 500 ? 4 : standbyDuration === 1000 ? 5 : standbyDuration === 2000 ? 6 : 7

		this.#ctrlMeasValue = (temperatureSamplingBits << 5) | (pressureSamplingBits << 2) | modeBits
		this.#configValue = (standbyBits << 5) | (filterBits << 2)
	}

	start() {
		if (this.#timer === undefined) {
			this.client.addHandler(this)
			this.client.twoWireConfig(0)
			this.client.twoWireWrite(this.address, [BMP280.CONFIG_REG, this.#configValue])
			this.client.twoWireWrite(this.address, [BMP280.CTRL_MEAS_REG, this.#ctrlMeasValue])
			this.#readCalibrationData()
		}
	}

	stop() {
		this.client.removeHandler(this)
		clearInterval(this.#timer)
		this.#timer = undefined
	}

	twoWireMessage(client: FirmataClient, address: number, register: number, data: Buffer) {
		if (address !== this.address) return

		if (!this.#initialized) {
			if (register !== BMP280.CALIBRATION_REG || data.byteLength !== 24) return

			this.#T1 = data.readUInt16LE(0)
			this.#T2 = data.readInt16LE(2)
			this.#T3 = data.readInt16LE(4)
			this.#P1 = data.readUInt16LE(6)
			this.#P2 = data.readInt16LE(8)
			this.#P3 = data.readInt16LE(10)
			this.#P4 = data.readInt16LE(12)
			this.#P5 = data.readInt16LE(14)
			this.#P6 = data.readInt16LE(16)
			this.#P7 = data.readInt16LE(18)
			this.#P8 = data.readInt16LE(20)
			this.#P9 = data.readInt16LE(22)
			this.#initialized = this.#P1 !== 0

			if (!this.#initialized) return

			this.#readMeasurement()
			this.#timer = setInterval(this.#readMeasurement.bind(this), Math.max(100, this.pollingInterval))

			return
		}

		if (register !== BMP280.DATA_REG || data.byteLength !== 6) return

		const adcP = ((data[0] << 12) | (data[1] << 4) | (data[2] >> 4)) >>> 0
		const adcT = ((data[3] << 12) | (data[4] << 4) | (data[5] >> 4)) >>> 0

		const temperature = this.compensateTemperature(adcT)
		const pressure = pascal(this.compensatePressure(adcP))
		const altitude = fromPressure(pressure, temperature)

		if (temperature !== this.temperature || pressure !== this.pressure || altitude !== this.altitude) {
			this.temperature = temperature
			this.pressure = pressure
			this.altitude = altitude
			this.fire()
		}
	}

	#readCalibrationData() {
		this.client.twoWireRead(this.address, BMP280.CALIBRATION_REG, 24)
	}

	#readMeasurement() {
		this.client.twoWireRead(this.address, BMP280.DATA_REG, 6)
	}

	compensateTemperature(adcT: number) {
		const var1 = (adcT / 16384 - this.#T1 / 1024) * this.#T2
		const var2 = (adcT / 131072 - this.#T1 / 8192) * (adcT / 131072 - this.#T1 / 8192) * this.#T3
		this.#tFine = var1 + var2
		return this.#tFine / 5120
	}

	compensatePressure(adcP: number) {
		let var1 = this.#tFine / 2 - 64000
		let var2 = (var1 * var1 * this.#P6) / 32768
		var2 += var1 * this.#P5 * 2
		var2 = var2 / 4 + this.#P4 * 65536
		var1 = ((this.#P3 * var1 * var1) / 524288 + this.#P2 * var1) / 524288
		var1 = (1 + var1 / 32768) * this.#P1
		if (var1 === 0) return this.pressure
		let p = 1048576 - adcP
		p = ((p - var2 / 4096) * 6250) / var1
		var1 = (this.#P9 * p * p) / 2147483648
		var2 = (p * this.#P8) / 32768
		return p + (var1 + var2 + this.#P7) / 16
	}
}
