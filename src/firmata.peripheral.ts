import { type Distance, fromPressure } from './distance'
import { type FirmataClient, type FirmataClientHandler, type OneWirePowerMode, type Pin, PinMode } from './firmata'
import type { NumberArray } from './math'
import { type Pressure, pascal } from './pressure'
import type { Temperature } from './temperature'

export const DEFAULT_POLLING_INTERVAL = 5000

export type PeripheralListener<D extends Peripheral<D>> = (device: D) => void

export type BMP280OperatingMode = 'sleep' | 'forced' | 'normal'

export type BMP280Sampling = 'skip' | 'x1' | 'x2' | 'x4' | 'x8' | 'x16'

export type BMP280Filter = 'off' | 'x2' | 'x4' | 'x8' | 'x16'

export type BMP280StandbyDuration = 0.5 | 62.5 | 125 | 250 | 500 | 1000 | 2000 | 4000 // ms

export type HMC5883LSampleAveraging = 1 | 2 | 4 | 8

export type HMC5883LDataRate = 0.75 | 1.5 | 3 | 7.5 | 15 | 30 | 75

export type HMC5883LRange = 0.88 | 1.3 | 1.9 | 2.5 | 4.0 | 4.7 | 5.6 | 8.1 // gauss

export type BH1750Mode = 'continuousHighResolution' | 'continuousHighResolution2' | 'continuousLowResolution' | 'oneTimeHighResolution' | 'oneTimeHighResolution2' | 'oneTimeLowResolution'

export type TSL2561Gain = 1 | 16

export type TSL2561IntegrationTime = 13.7 | 101 | 402 // ms

export type DS18B20Resolution = 9 | 10 | 11 | 12

export enum BMP180Mode {
	ULTRA_LOW_POWER, // 5 ms
	STANDARD, // 8 ms
	HIGH_RESOLUTION, // 14 ms
	ULTRA_HIGH_RESOLUTION, // 26 ms
}

export interface Peripheral<D extends Peripheral<D>> extends Disposable {
	readonly client: FirmataClient
	readonly addListener: (listener: PeripheralListener<D>) => void
	readonly removeListener: (listener: PeripheralListener<D>) => void
	readonly start: () => void
	readonly stop: () => void
}

export interface Thermometer {
	readonly temperature: Temperature
}

export interface Hygrometer {
	readonly humidity: number
}

export interface Barometer {
	readonly pressure: Pressure
}

export interface Altimeter {
	readonly altitude: Distance
}

export interface LuxMeter {
	readonly lux: number
}

export interface Magnetometer {
	readonly x: number // gauss
	readonly y: number // gauss
	readonly z: number // gauss
}

export interface BMP280Options {
	readonly mode?: BMP280OperatingMode
	readonly temperatureSampling?: BMP280Sampling // Reduces noise and increases the output resolution by one bit
	readonly pressureSampling?: BMP280Sampling // Reduces noise and increases the output resolution by one bit
	readonly filter?: BMP280Filter // Supress environment disturbances in the output data
	readonly standbyDuration?: BMP280StandbyDuration // Standby period between two measurement cycles in normal mode
}

export interface HMC5883LOptions {
	readonly sampleAveraging?: HMC5883LSampleAveraging
	readonly dataRate?: HMC5883LDataRate
	readonly range?: HMC5883LRange // gauss
}

export interface TEMT6000Options {
	readonly aref?: number // volts
	readonly loadResistance?: number // ohms
	readonly adcResolution?: number
	readonly microampsPerLux?: number
}

export interface BH1750Options {
	readonly mode?: BH1750Mode
	readonly measurementTime?: number
}

export interface TSL2561Options {
	readonly gain?: TSL2561Gain
	readonly integrationTime?: TSL2561IntegrationTime // ms
}

export interface MAX44009Options {
	readonly continuousMode?: boolean
}

export interface DS18B20Options {
	readonly address?: Readonly<NumberArray> | Buffer
	readonly skip?: boolean
	readonly resolution?: DS18B20Resolution
	readonly powerMode?: OneWirePowerMode
}

export const DEFAULT_BMP280_OPTIONS: Required<BMP280Options> = {
	mode: 'normal',
	temperatureSampling: 'x1',
	pressureSampling: 'x1',
	filter: 'off',
	standbyDuration: 1000,
}

export const DEFAULT_HMC5883L_OPTIONS: Required<HMC5883LOptions> = {
	sampleAveraging: 1,
	dataRate: 15,
	range: 1.3,
}

export const DEFAULT_TEMT6000_OPTIONS: Required<TEMT6000Options> = {
	aref: 5,
	loadResistance: 10000,
	adcResolution: 1023,
	microampsPerLux: 0.5,
}

export const DEFAULT_BH1750_OPTIONS: Required<BH1750Options> = {
	mode: 'continuousHighResolution',
	measurementTime: 69,
}

export const DEFAULT_TSL2561_OPTIONS: Required<TSL2561Options> = {
	gain: 1,
	integrationTime: 402,
}

export const DEFAULT_MAX44009_OPTIONS: Required<MAX44009Options> = {
	continuousMode: false,
}

export const DEFAULT_DS18B20_OPTIONS: Required<Omit<DS18B20Options, 'address'>> = {
	resolution: 12,
	powerMode: 'normal',
	skip: false, // true for skip search ROM address when address is not provided
}

abstract class PeripheralBase<D extends Peripheral<D>> {
	readonly #listeners = new Set<PeripheralListener<D>>()

	abstract readonly client: FirmataClient

	abstract start(): void
	abstract stop(): void

	[Symbol.dispose]() {
		this.stop()
	}

	addListener(listener: PeripheralListener<D>) {
		this.#listeners.add(listener)
	}

	removeListener(listener: PeripheralListener<D>) {
		this.#listeners.delete(listener)
	}

	protected fire() {
		for (const listener of this.#listeners) listener(this as never)
	}
}

export class LM35 extends PeripheralBase<LM35> implements Thermometer, FirmataClientHandler {
	temperature = 0

	constructor(
		readonly client: FirmataClient,
		readonly pin: number,
		readonly aref: number = 5, // volts
	) {
		super()
	}

	pinChange(client: FirmataClient, pin: Pin) {
		if (this.client === client && pin.id === this.pin) {
			const temperature = (this.aref * 100 * pin.value) / 1023

			if (temperature !== this.temperature) {
				this.temperature = temperature
				this.fire()
			}
		}
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

// https://www.alldatasheet.com/html-pdf/117488/VISHAY/TEMT6000/440/2/TEMT6000.html

export class TEMT6000 extends PeripheralBase<TEMT6000> implements LuxMeter, FirmataClientHandler {
	lux = 0

	readonly #luxPerStep: number

	constructor(
		readonly client: FirmataClient,
		readonly pin: number,
		options: TEMT6000Options = DEFAULT_TEMT6000_OPTIONS,
	) {
		super()

		const aref = options.aref ?? DEFAULT_TEMT6000_OPTIONS.aref
		const loadResistance = options.loadResistance ?? DEFAULT_TEMT6000_OPTIONS.loadResistance
		const adcResolution = options.adcResolution ?? DEFAULT_TEMT6000_OPTIONS.adcResolution
		const microampsPerLux = options.microampsPerLux ?? DEFAULT_TEMT6000_OPTIONS.microampsPerLux

		this.#luxPerStep = (aref * 1e6) / (loadResistance * adcResolution * microampsPerLux)
	}

	// Converts one ADC sample into lux for the configured analog front-end.
	pinChange(client: FirmataClient, pin: Pin) {
		if (this.client !== client || pin.id !== this.pin) return

		const lux = this.calculateLux(pin.value)

		if (lux !== this.lux) {
			this.lux = lux
			this.fire()
		}
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

	// Converts the raw ADC step count into lux.
	calculateLux(steps: number) {
		return steps * this.#luxPerStep
	}
}

// https://cdn-shop.adafruit.com/datasheets/BST-BMP180-DS000-09.pdf

export class BMP180 extends PeripheralBase<BMP180> implements Barometer, Altimeter, Thermometer, FirmataClientHandler {
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

// https://sensirion.com/media/documents/120BBE4C/63500094/Sensirion_Datasheet_Humidity_Sensor_SHT21.pdf

export class SHT21 extends PeripheralBase<SHT21> implements Hygrometer, Thermometer, FirmataClientHandler {
	humidity = 0
	temperature = 0

	static readonly ADDRESS = 0x40

	static readonly #READ_TEMP_HOLD_CMD = 0xe3
	static readonly #READ_HUM_HOLD_CMD = 0xe5
	static readonly #SOFT_RESET_CMD = 0xfe

	#timer?: NodeJS.Timeout
	#temperatureChanged = false

	constructor(
		readonly client: FirmataClient,
		readonly poolingInterval: number = DEFAULT_POLLING_INTERVAL,
	) {
		super()
	}

	#readMeasurement() {
		this.client.twoWireRead(SHT21.ADDRESS, SHT21.#READ_TEMP_HOLD_CMD, 2)
		this.client.twoWireRead(SHT21.ADDRESS, SHT21.#READ_HUM_HOLD_CMD, 2)
	}

	start() {
		if (this.#timer === undefined) {
			this.client.addHandler(this)
			this.client.twoWireConfig(0)
			this.#readMeasurement()
			this.#timer = setInterval(this.#readMeasurement.bind(this), Math.max(1000, this.poolingInterval))
		}
	}

	stop() {
		this.client.removeHandler(this)
		clearInterval(this.#timer)
		this.#timer = undefined
	}

	reset() {
		this.client.twoWireWrite(SHT21.ADDRESS, [SHT21.#SOFT_RESET_CMD])
	}

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

			if (humidity !== this.humidity || this.#temperatureChanged) {
				this.humidity = humidity
				this.#temperatureChanged = false
				this.fire()
			}
		}
	}
}

// https://www.bosch-sensortec.com/media/boschsensortec/downloads/datasheets/bst-bmp280-ds001.pdf

export class BMP280 extends PeripheralBase<BMP280> implements Barometer, Altimeter, Thermometer, FirmataClientHandler {
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

// https://cdn-shop.adafruit.com/product-files/3721/AM2320.pdf

export class AM2320 extends PeripheralBase<AM2320> implements Hygrometer, Thermometer, FirmataClientHandler {
	humidity = 0
	temperature = 0

	static readonly ADDRESS = 0x5c

	static readonly WAKE_UP_DELAY_MS = 2
	static readonly MEASUREMENT_DELAY_MS = 2
	static readonly READ_HOLDING_REGISTERS_CMD = 0x03
	static readonly START_REGISTER = 0x00
	static readonly REGISTER_COUNT = 4
	static readonly FRAME_SIZE = 8

	#timer?: NodeJS.Timeout
	#reading = false

	constructor(
		readonly client: FirmataClient,
		readonly pollingInterval: number = DEFAULT_POLLING_INTERVAL,
	) {
		super()
	}

	start() {
		if (this.#timer === undefined) {
			this.client.addHandler(this)
			this.client.twoWireConfig(0)
			void this.#readMeasurement()
			this.#timer = setInterval(this.#readMeasurement.bind(this), Math.max(1000, this.pollingInterval))
		}
	}

	stop() {
		this.client.removeHandler(this)
		clearInterval(this.#timer)
		this.#timer = undefined
		this.#reading = false
	}

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

	twoWireMessage(client: FirmataClient, address: number, register: number, data: Buffer) {
		if (client !== this.client || address !== AM2320.ADDRESS || data.byteLength !== AM2320.FRAME_SIZE) return
		if (data[0] !== AM2320.READ_HOLDING_REGISTERS_CMD || data[1] !== AM2320.REGISTER_COUNT) return

		const humidity = data.readUint16BE(2) / 10
		const rawTemperature = data.readUint16BE(4) & 0x7fff
		const temperature = (data[4] & 0x80 ? -rawTemperature : rawTemperature) / 10

		if (humidity !== this.humidity || temperature !== this.temperature) {
			this.humidity = humidity
			this.temperature = temperature
			this.fire()
		}
	}
}

// https://www.digikey.com/htmldatasheets/production/1640724/0/0/1/hmc5883l-datasheet.html

export class HMC5883L extends PeripheralBase<HMC5883L> implements Magnetometer, FirmataClientHandler {
	x = 0
	y = 0
	z = 0

	static readonly ADDRESS = 0x1e

	static readonly CONFIG_A_REG = 0x00
	static readonly CONFIG_B_REG = 0x01
	static readonly MODE_REG = 0x02
	static readonly DATA_X_MSB_REG = 0x03
	static readonly CONTINUOUS_MEASUREMENT_MODE = 0x00
	static readonly OVERFLOW = -4096

	#timer?: NodeJS.Timeout
	readonly #configA: number
	readonly #configB: number
	readonly #gaussPerCount: number
	readonly #minimumPollingInterval: number

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
		const rangeBits = range === 0.88 ? 0 : range === 1.3 ? 1 : range === 1.9 ? 2 : range === 2.5 ? 3 : range === 4.0 ? 4 : range === 4.7 ? 5 : range === 5.6 ? 6 : 7
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

		if (x !== this.x || y !== this.y || z !== this.z) {
			this.x = x
			this.y = y
			this.z = z
			this.fire()
		}
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

// https://www.rohm.com/products/sensor/ambient-light-sensor-ics/bh1750fvi-product

export class BH1750 extends PeripheralBase<BH1750> implements LuxMeter, FirmataClientHandler {
	lux = 0
	raw = 0

	static readonly ADDRESS = 0x23
	static readonly ALTERNATIVE_ADDRESS = 0x5c

	static readonly POWER_DOWN_CMD = 0x00
	static readonly POWER_ON_CMD = 0x01
	static readonly RESET_CMD = 0x07
	static readonly CONTINUOUS_HIGH_RESOLUTION_CMD = 0x10
	static readonly CONTINUOUS_HIGH_RESOLUTION2_CMD = 0x11
	static readonly CONTINUOUS_LOW_RESOLUTION_CMD = 0x13
	static readonly ONE_TIME_HIGH_RESOLUTION_CMD = 0x20
	static readonly ONE_TIME_HIGH_RESOLUTION2_CMD = 0x21
	static readonly ONE_TIME_LOW_RESOLUTION_CMD = 0x23
	static readonly CHANGE_MEASUREMENT_TIME_HIGH_BIT_CMD = 0x40
	static readonly CHANGE_MEASUREMENT_TIME_LOW_BIT_CMD = 0x60
	static readonly DEFAULT_MEASUREMENT_TIME = 69
	static readonly MIN_MEASUREMENT_TIME = 31
	static readonly MAX_MEASUREMENT_TIME = 254

	#timer?: NodeJS.Timeout
	#reading = false
	readonly #modeCommand: number
	readonly #measurementTime: number
	readonly #measurementDelayMs: number
	readonly #oneTimeMode: boolean
	readonly #halfLuxResolution: boolean

	constructor(
		readonly client: FirmataClient,
		readonly address: number = BH1750.ADDRESS,
		readonly pollingInterval: number = DEFAULT_POLLING_INTERVAL,
		options: BH1750Options = DEFAULT_BH1750_OPTIONS,
	) {
		super()

		const mode = options.mode ?? DEFAULT_BH1750_OPTIONS.mode
		const measurementTime = Math.max(BH1750.MIN_MEASUREMENT_TIME, Math.min(BH1750.MAX_MEASUREMENT_TIME, Math.trunc(options.measurementTime ?? DEFAULT_BH1750_OPTIONS.measurementTime)))
		const lowResolutionMode = mode === 'continuousLowResolution' || mode === 'oneTimeLowResolution'

		this.#modeCommand =
			mode === 'continuousHighResolution'
				? BH1750.CONTINUOUS_HIGH_RESOLUTION_CMD
				: mode === 'continuousHighResolution2'
					? BH1750.CONTINUOUS_HIGH_RESOLUTION2_CMD
					: mode === 'continuousLowResolution'
						? BH1750.CONTINUOUS_LOW_RESOLUTION_CMD
						: mode === 'oneTimeHighResolution'
							? BH1750.ONE_TIME_HIGH_RESOLUTION_CMD
							: mode === 'oneTimeHighResolution2'
								? BH1750.ONE_TIME_HIGH_RESOLUTION2_CMD
								: BH1750.ONE_TIME_LOW_RESOLUTION_CMD
		this.#measurementTime = measurementTime
		this.#measurementDelayMs = Math.ceil((lowResolutionMode ? 24 : 180) * (measurementTime / BH1750.DEFAULT_MEASUREMENT_TIME))
		this.#oneTimeMode = mode === 'oneTimeHighResolution' || mode === 'oneTimeHighResolution2' || mode === 'oneTimeLowResolution'
		this.#halfLuxResolution = mode === 'continuousHighResolution2' || mode === 'oneTimeHighResolution2'
	}

	// Powers on the device, configures MTreg, and starts periodic measurements.
	start() {
		if (this.#timer === undefined) {
			this.client.addHandler(this)
			this.client.twoWireConfig(0)
			this.client.twoWireWrite(this.address, [BH1750.POWER_ON_CMD])
			this.#configureMeasurementTime()
			void this.#readMeasurement()
			this.#timer = setInterval(this.#readMeasurement.bind(this), Math.max(this.#measurementDelayMs, this.pollingInterval))
		}
	}

	// Stops polling and powers the device down.
	stop() {
		this.client.removeHandler(this)
		clearInterval(this.#timer)
		this.#timer = undefined
		this.#reading = false
		this.client.twoWireWrite(this.address, [BH1750.POWER_DOWN_CMD])
	}

	// Resets the data register while the device is powered on.
	reset() {
		this.client.twoWireWrite(this.address, [BH1750.POWER_ON_CMD])
		this.client.twoWireWrite(this.address, [BH1750.RESET_CMD])
	}

	// Decodes the 16-bit sensor output into lux.
	twoWireMessage(client: FirmataClient, address: number, register: number, data: Buffer) {
		if (client !== this.client || address !== this.address || register !== -1 || data.byteLength !== 2) return

		const raw = data.readUInt16BE(0)
		const lux = this.calculateLux(raw)

		if (raw !== this.raw || lux !== this.lux) {
			this.raw = raw
			this.lux = lux
			this.fire()
		}
	}

	// Converts the raw measurement value into lux, compensating for MTreg and mode.
	calculateLux(raw: number) {
		if (raw <= 0) return 0
		const modeScale = this.#halfLuxResolution ? 2.4 : 1.2
		return (raw * (BH1750.DEFAULT_MEASUREMENT_TIME / this.#measurementTime)) / modeScale
	}

	// Writes the two MTreg adjustment commands.
	#configureMeasurementTime() {
		this.client.twoWireWrite(this.address, [BH1750.CHANGE_MEASUREMENT_TIME_HIGH_BIT_CMD | (this.#measurementTime >>> 5)])
		this.client.twoWireWrite(this.address, [BH1750.CHANGE_MEASUREMENT_TIME_LOW_BIT_CMD | (this.#measurementTime & 0x1f)])
	}

	// Starts one measurement cycle and reads back the 16-bit result after conversion.
	async #readMeasurement() {
		if (this.#reading) return

		try {
			this.#reading = true

			if (this.#oneTimeMode) {
				this.client.twoWireWrite(this.address, [BH1750.POWER_ON_CMD])
				this.#configureMeasurementTime()
			}

			this.client.twoWireWrite(this.address, [this.#modeCommand])
			await Bun.sleep(this.#measurementDelayMs)
			this.client.twoWireRead(this.address, -1, 2)
		} finally {
			this.#reading = false
		}
	}
}

// https://www.mouser.com/datasheet/2/588/TSL2561_DS000110_3_00-2066792.pdf

export class TSL2561 extends PeripheralBase<TSL2561> implements LuxMeter, FirmataClientHandler {
	lux = 0
	broadband = 0
	infrared = 0

	static readonly ADDRESS = 0x39
	static readonly LOW_ADDRESS = 0x29
	static readonly HIGH_ADDRESS = 0x49

	static readonly COMMAND_BIT = 0x80
	static readonly BLOCK_BIT = 0x10

	static readonly CONTROL_REG = 0x00
	static readonly TIMING_REG = 0x01
	static readonly DATA0LOW_REG = 0x0c

	static readonly POWER_UP = 0x03
	static readonly SCALE_13_7_MS = 322 / 11
	static readonly SCALE_101_MS = 322 / 81
	static readonly CLIP_13_7_MS = 5047
	static readonly CLIP_101_MS = 37177
	static readonly CLIP_402_MS = 65535

	#timer?: NodeJS.Timeout
	readonly #timing: number
	readonly #gainScale: number
	readonly #integrationScale: number
	readonly #clipThreshold: number
	readonly #minimumPollingInterval: number

	constructor(
		readonly client: FirmataClient,
		readonly address: number = TSL2561.ADDRESS,
		readonly pollingInterval: number = DEFAULT_POLLING_INTERVAL,
		options: TSL2561Options = DEFAULT_TSL2561_OPTIONS,
	) {
		super()

		const gain = options.gain ?? DEFAULT_TSL2561_OPTIONS.gain
		const integrationTime = options.integrationTime ?? DEFAULT_TSL2561_OPTIONS.integrationTime
		const integrationBits = integrationTime === 13.7 ? 0 : integrationTime === 101 ? 1 : 2

		this.#timing = (gain === 16 ? 0x10 : 0) | integrationBits
		this.#gainScale = gain === 1 ? 16 : 1
		this.#integrationScale = integrationTime === 13.7 ? TSL2561.SCALE_13_7_MS : integrationTime === 101 ? TSL2561.SCALE_101_MS : 1
		this.#clipThreshold = integrationTime === 13.7 ? TSL2561.CLIP_13_7_MS : integrationTime === 101 ? TSL2561.CLIP_101_MS : TSL2561.CLIP_402_MS
		this.#minimumPollingInterval = Math.ceil(integrationTime)
	}

	// Powers up the device, configures timing, and starts reading both ADC channels.
	start() {
		if (this.#timer === undefined) {
			this.client.addHandler(this)
			this.client.twoWireConfig(0)
			this.client.twoWireWrite(this.address, [TSL2561.COMMAND_BIT | TSL2561.CONTROL_REG, TSL2561.POWER_UP])
			this.client.twoWireWrite(this.address, [TSL2561.COMMAND_BIT | TSL2561.TIMING_REG, this.#timing])
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

	// Decodes both ADC channels and updates the computed lux value.
	twoWireMessage(client: FirmataClient, address: number, register: number, data: Buffer) {
		if (client !== this.client || address !== this.address || register !== (TSL2561.COMMAND_BIT | TSL2561.BLOCK_BIT | TSL2561.DATA0LOW_REG) || data.byteLength !== 4) return

		const broadband = data.readUInt16LE(0)
		const infrared = data.readUInt16LE(2)
		const lux = this.calculateLux(broadband, infrared)

		if (broadband !== this.broadband || infrared !== this.infrared || lux !== this.lux) {
			this.broadband = broadband
			this.infrared = infrared
			this.lux = lux
			this.fire()
		}
	}

	// Converts raw channel counts into lux using the T package coefficients from the datasheet.
	calculateLux(broadband: number, infrared: number) {
		if (broadband <= 0 || infrared < 0) return 0
		if (broadband >= this.#clipThreshold || infrared >= this.#clipThreshold) return this.lux

		const scaledBroadband = broadband * this.#gainScale * this.#integrationScale
		const scaledInfrared = infrared * this.#gainScale * this.#integrationScale
		const ratio = scaledInfrared / scaledBroadband

		let lux = 0

		if (ratio <= 0.5) lux = 0.0304 * scaledBroadband - 0.062 * scaledBroadband * ratio ** 1.4
		else if (ratio <= 0.61) lux = 0.0224 * scaledBroadband - 0.031 * scaledInfrared
		else if (ratio <= 0.8) lux = 0.0128 * scaledBroadband - 0.0153 * scaledInfrared
		else if (ratio <= 1.3) lux = 0.00146 * scaledBroadband - 0.00112 * scaledInfrared

		return Math.max(0, lux)
	}

	// Reads both ADC channels in a single block transaction.
	#readMeasurement() {
		this.client.twoWireRead(this.address, TSL2561.COMMAND_BIT | TSL2561.BLOCK_BIT | TSL2561.DATA0LOW_REG, 4)
	}
}

// https://www.analog.com/media/en/technical-documentation/data-sheets/max44009.pdf

export class MAX44009 extends PeripheralBase<MAX44009> implements LuxMeter, FirmataClientHandler {
	lux = 0

	static readonly ADDRESS = 0x4a
	static readonly ALTERNATIVE_ADDRESS = 0x4b

	static readonly CONFIGURATION_REG = 0x02
	static readonly LUX_HIGH_REG = 0x03
	static readonly LUX_LOW_REG = 0x04
	static readonly DEFAULT_CONFIGURATION = 0x03
	static readonly CONTINUOUS_MODE_BIT = 0x80
	static readonly MAX_LUX = 188006.4

	#timer?: NodeJS.Timeout
	readonly #configuration: number

	constructor(
		readonly client: FirmataClient,
		readonly address: number = MAX44009.ADDRESS,
		readonly pollingInterval: number = DEFAULT_POLLING_INTERVAL,
		options: MAX44009Options = DEFAULT_MAX44009_OPTIONS,
	) {
		super()

		const continuousMode = options.continuousMode ?? DEFAULT_MAX44009_OPTIONS.continuousMode
		this.#configuration = (continuousMode ? MAX44009.CONTINUOUS_MODE_BIT : 0) | MAX44009.DEFAULT_CONFIGURATION
	}

	start() {
		if (this.#timer === undefined) {
			this.client.addHandler(this)
			this.client.twoWireConfig(0)
			this.client.twoWireWrite(this.address, [MAX44009.CONFIGURATION_REG, this.#configuration])
			this.#readMeasurement()
			this.#timer = setInterval(this.#readMeasurement.bind(this), Math.max(100, this.pollingInterval))
		}
	}

	stop() {
		this.client.removeHandler(this)
		clearInterval(this.#timer)
		this.#timer = undefined
	}

	twoWireMessage(client: FirmataClient, address: number, register: number, data: Buffer) {
		if (client !== this.client || address !== this.address || register !== MAX44009.LUX_HIGH_REG || data.byteLength !== 2) return

		const lux = this.calculateLux(data[0], data[1])

		if (lux !== this.lux) {
			this.lux = lux
			this.fire()
		}
	}

	// Decodes the exponent and mantissa registers into the ambient light level in lux.
	calculateLux(highByte: number, lowByte: number) {
		const exponent = (highByte >>> 4) & 0x0f

		if (exponent === 0x0f) return MAX44009.MAX_LUX

		const mantissa = ((highByte & 0x0f) << 4) | (lowByte & 0x0f)
		return 2 ** exponent * mantissa * 0.045
	}

	#readMeasurement() {
		this.client.twoWireRead(this.address, MAX44009.LUX_HIGH_REG, 2, false, 7, 'restart')
	}
}

// https://www.analog.com/media/en/technical-documentation/data-sheets/ds18b20.pdf

export class DS18B20 extends PeripheralBase<DS18B20> implements Thermometer, FirmataClientHandler {
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
		return DS18B20.crc8(data, 8) === data[8]
	}

	static crc8(data: Readonly<NumberArray> | Buffer, length: number) {
		let crc = 0

		for (let i = 0; i < length; i++) {
			let value = data[i]

			for (let j = 0; j < 8; j++) {
				const mix = (crc ^ value) & 0x01
				crc >>= 1
				if (mix !== 0) crc ^= 0x8c
				value >>= 1
			}
		}

		return crc & 0xff
	}
}
