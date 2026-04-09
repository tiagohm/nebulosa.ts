import type { Angle } from './angle'
import { DEG2RAD, G } from './constants'
import { CRC } from './crc'
import { type Distance, fromPressure } from './distance'
import { type FirmataClient, type FirmataClientHandler, type OneWirePowerMode, type Pin, PinMode } from './firmata'
import { clamp, type NumberArray } from './math'
import { type Pressure, pascal } from './pressure'
import type { Temperature } from './temperature'

export type PeripheralListener<D extends Peripheral<D>> = (device: D) => void

export type RadioSeekDirection = 'up' | 'down'

export type BMP280OperatingMode = 'sleep' | 'forced' | 'normal'

export type BMP280Sampling = 'skip' | 'x1' | 'x2' | 'x4' | 'x8' | 'x16'

export type BMP280Filter = 'off' | 'x2' | 'x4' | 'x8' | 'x16'

export type BMP280StandbyDuration = 0.5 | 62.5 | 125 | 250 | 500 | 1000 | 2000 | 4000 // ms

export type HMC5883LSampleAveraging = 1 | 2 | 4 | 8

export type HMC5883LDataRate = 0.75 | 1.5 | 3 | 7.5 | 15 | 30 | 75

export type HMC5883LRange = 0.88 | 1.3 | 1.9 | 2.5 | 4.0 | 4.7 | 5.6 | 8.1 // gauss

export type ACS712Range = 5 | 20 | 30 // A

export type MPU6050AccelerometerRange = 2 | 4 | 8 | 16 // g

export type MPU6050GyroscopeRange = 250 | 500 | 1000 | 2000 // deg/s

export type BH1750Mode = 'continuousHighResolution' | 'continuousHighResolution2' | 'continuousLowResolution' | 'oneTimeHighResolution' | 'oneTimeHighResolution2' | 'oneTimeLowResolution'

export type TSL2561Gain = 1 | 16

export type TSL2561IntegrationTime = 13.7 | 101 | 402 // ms

export type MCP4725PowerDownMode = 'normal' | '1k' | '100k' | '500k'

export type DS18B20Resolution = 9 | 10 | 11 | 12

export type RDA5807Band = 'usEurope' | 'japanWide' | 'world' | 'eastEurope'

export type RDA5807ChannelSpacing = 25 | 50 | 100 | 200 // kHz

export type RDA5807EastEuropeMode = '65_76' | '50_65'

export type TEA5767Band = 'usEurope' | 'japan'

export type TEA5767DeEmphasis = 50 | 75 // us

export type TEA5767ReferenceClock = 32768 | 6500000 | 13000000 // Hz

export type TEA5767SearchStopLevel = 'low' | 'mid' | 'high'

export enum BMP180Mode {
	ULTRA_LOW_POWER, // 5 ms
	STANDARD, // 8 ms
	HIGH_RESOLUTION, // 14 ms
	ULTRA_HIGH_RESOLUTION, // 26 ms
}

export interface Peripheral<D extends Peripheral<D> = never> extends Disposable {
	readonly name: string
	readonly client: FirmataClient
	readonly addListener: (listener: PeripheralListener<D>) => void
	readonly removeListener: (listener: PeripheralListener<D>) => void
	readonly start: () => void
	readonly stop: () => void
}

export interface Thermometer extends Pick<Peripheral, 'name' | 'client'> {
	readonly temperature: Temperature
}

export interface Hygrometer extends Pick<Peripheral, 'name' | 'client'> {
	readonly humidity: number
}

export interface Barometer extends Pick<Peripheral, 'name' | 'client'> {
	readonly pressure: Pressure
}

export interface Altimeter extends Pick<Peripheral, 'name' | 'client'> {
	readonly altitude: Distance
}

export interface Luxmeter extends Pick<Peripheral, 'name' | 'client'> {
	readonly lux: number
}

export interface Ammeter extends Pick<Peripheral, 'name' | 'client'> {
	readonly current: number // A
}

export interface Accelerometer extends Pick<Peripheral, 'name' | 'client'> {
	readonly ax: number // m/s^2
	readonly ay: number // m/s^2
	readonly az: number // m/s^2
}

export interface Gyroscope extends Pick<Peripheral, 'name' | 'client'> {
	readonly gx: Angle // rad/s
	readonly gy: Angle // rad/s
	readonly gz: Angle // rad/s
}

export interface Magnetometer extends Pick<Peripheral, 'name' | 'client'> {
	readonly x: number // gauss
	readonly y: number // gauss
	readonly z: number // gauss
}

export interface Radio extends Pick<Peripheral, 'name' | 'client'> {
	frequency: number // MHz
	volume: number // 0..100
	muted: boolean
	stereo: boolean
	readonly seekFailed?: boolean
	readonly rssi?: number // 0..127 logarithmic RSSI scale
	readonly station?: boolean
	readonly frequencyUp: () => void
	readonly frequencyDown: () => void
	readonly volumeUp: () => void
	readonly volumeDown: () => void
	readonly mute: () => void
	readonly unmute: () => void
	readonly seek: (direction: RadioSeekDirection, wrap: boolean) => void
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

export interface ACS712Options {
	readonly range?: ACS712Range // A
	readonly aref?: number // volts
	readonly zeroCurrentVoltage?: number // volts
	readonly adcResolution?: number
	readonly voltsPerAmp?: number
}

export interface MPU6050Options {
	readonly accelerometerRange?: MPU6050AccelerometerRange // g
	readonly gyroscopeRange?: MPU6050GyroscopeRange // deg/s
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

export interface MCP4725Options {
	readonly value?: number
	readonly powerDownMode?: MCP4725PowerDownMode
}

export interface DS18B20Options {
	readonly address?: Readonly<NumberArray> | Buffer
	readonly skip?: boolean
	readonly resolution?: DS18B20Resolution
	readonly powerMode?: OneWirePowerMode
}

export interface RDA5807Options {
	readonly frequency?: number // MHz
	readonly volume?: number
	readonly muted?: boolean
	readonly band?: RDA5807Band
	readonly stereo?: boolean
	readonly bassBoost?: boolean
	readonly audioOutputHighZ?: boolean
	readonly eastEuropeMode?: RDA5807EastEuropeMode
	readonly spacing?: RDA5807ChannelSpacing // kHz
	readonly seekThreshold?: number
	readonly wrap?: boolean
}

export interface TEA5767Options {
	readonly frequency?: number // MHz
	readonly muted?: boolean
	readonly band?: TEA5767Band
	readonly stereo?: boolean
	readonly softMute?: boolean
	readonly highCutControl?: boolean
	readonly stereoNoiseCancelling?: boolean
	readonly highSideInjection?: boolean
	readonly referenceClock?: TEA5767ReferenceClock // Hz
	readonly deEmphasis?: TEA5767DeEmphasis // us
	readonly searchStopLevel?: TEA5767SearchStopLevel
	readonly wrap?: boolean
}

interface RDA5807Status {
	readonly rdsReady: boolean
	readonly seekTuneComplete: boolean
	readonly seekFailed: boolean
	readonly stereo: boolean
	readonly channel: number
	readonly rssi: number
	readonly station: boolean
	readonly ready: boolean
}

interface TEA5767Status {
	readonly ready: boolean
	readonly bandLimit: boolean
	readonly pll: number
	readonly stereo: boolean
	readonly ifCounter: number
	readonly level: number
}

interface PendingTwoWireRead {
	readonly reject: (error: Error) => void
	readonly resolve: (data: Buffer) => void
	readonly timer: NodeJS.Timeout
}

export const DEFAULT_POLLING_INTERVAL = 5000

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

export const DEFAULT_ACS712_OPTIONS: Required<ACS712Options> = {
	range: 5,
	aref: 5,
	zeroCurrentVoltage: 2.5,
	adcResolution: 1023,
	voltsPerAmp: 0.185,
}

export const DEFAULT_MPU6050_OPTIONS: Required<MPU6050Options> = {
	accelerometerRange: 2,
	gyroscopeRange: 250,
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

export const DEFAULT_MCP4725_OPTIONS: Required<MCP4725Options> = {
	value: 0,
	powerDownMode: 'normal',
}

export const DEFAULT_DS18B20_OPTIONS: Required<Omit<DS18B20Options, 'address'>> = {
	resolution: 12,
	powerMode: 'normal',
	skip: false, // true for skip search ROM address when address is not provided
}

const RDA5807_VOLUME_FACTOR = 100 / 15

export const DEFAULT_RDA5807_OPTIONS: Required<RDA5807Options> = {
	frequency: 87,
	volume: 100,
	muted: false,
	band: 'usEurope',
	stereo: true,
	bassBoost: false,
	audioOutputHighZ: false,
	eastEuropeMode: '65_76',
	spacing: 100,
	seekThreshold: 8,
	wrap: true,
}

export const DEFAULT_TEA5767_OPTIONS: Required<TEA5767Options> = {
	frequency: 87.5,
	muted: false,
	band: 'usEurope',
	stereo: true,
	softMute: true,
	highCutControl: true,
	stereoNoiseCancelling: true,
	highSideInjection: true,
	referenceClock: 32768,
	deEmphasis: 50,
	searchStopLevel: 'mid',
	wrap: true,
}

abstract class PeripheralBase<D extends Peripheral<D> = never> implements FirmataClientHandler {
	readonly #listeners = new Set<PeripheralListener<D>>()
	readonly #pendingTwoWireReads = new Map<string, PendingTwoWireRead[]>()

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

	// Resolves one queued I2C register read for the current device instance.
	protected resolvePendingTwoWireRead(client: FirmataClient, address: number, register: number, data: Buffer) {
		if (client !== this.client) return false

		const requests = this.#pendingTwoWireReads.get(this.#pendingTwoWireReadKey(address, register))
		if (requests === undefined || requests.length === 0) return false

		const request = requests.shift()
		if (requests.length === 0) this.#pendingTwoWireReads.delete(this.#pendingTwoWireReadKey(address, register))
		if (request === undefined) return false

		clearTimeout(request.timer)
		request.resolve(Buffer.from(data))
		return true
	}

	// Queues one I2C register read and resolves when Firmata returns the matching reply.
	protected readTwoWireRegister(address: number, register: number, bytesToRead: number, timeoutMs: number = 1000): Promise<Buffer> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				const requests = this.#pendingTwoWireReads.get(this.#pendingTwoWireReadKey(address, register))

				if (requests !== undefined) {
					const index = requests.findIndex((request) => request.timer === timer)
					if (index >= 0) requests.splice(index, 1)
					if (requests.length === 0) this.#pendingTwoWireReads.delete(this.#pendingTwoWireReadKey(address, register))
				}

				reject(new Error(`${this.constructor.name} register 0x${register.toString(16).padStart(2, '0')} read timed out.`))
			}, timeoutMs)

			const requests = this.#pendingTwoWireReads.get(this.#pendingTwoWireReadKey(address, register))
			const request = { resolve, reject, timer }

			if (requests === undefined) this.#pendingTwoWireReads.set(this.#pendingTwoWireReadKey(address, register), [request])
			else requests.push(request)

			this.client.twoWireRead(address, register, bytesToRead)
		})
	}

	// Rejects any queued I2C register reads when the device shuts down.
	protected clearPendingTwoWireReads(error: Error | string) {
		const reason = typeof error === 'string' ? new Error(error) : error

		for (const [key, requests] of this.#pendingTwoWireReads) {
			for (const request of requests) {
				clearTimeout(request.timer)
				request.reject(new Error(`${reason.message} (${key})`))
			}
		}

		this.#pendingTwoWireReads.clear()
	}

	// Builds a stable map key for one I2C address/register pair.
	#pendingTwoWireReadKey(address: number, register: number) {
		return `ADDR:0x${address.toString(16).padStart(2, '0')}:REG:0x${register.toString(16).padStart(2, '0')}`
	}

	close(client: FirmataClient) {
		if (this.client === client) this.stop()
	}
}

export abstract class ADCPeripheral<D extends Peripheral<D>> extends PeripheralBase<D> {
	abstract readonly pin: number

	abstract calculate(value: number): boolean

	pinChange(client: FirmataClient, pin: Pin) {
		if (this.client === client && pin.id === this.pin) {
			if (this.calculate(pin.value)) this.fire()
		}
	}
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

// https://www.alldatasheet.com/html-pdf/117488/VISHAY/TEMT6000/440/2/TEMT6000.html

export class TEMT6000 extends ADCPeripheral<TEMT6000> implements Luxmeter {
	lux = 0

	readonly #luxPerStep: number

	readonly name = 'TEMPT6000'

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
	calculate(value: number) {
		const lux = value * this.#luxPerStep

		if (lux !== this.lux) {
			this.lux = lux
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

// https://invensense.tdk.com/products/motion-tracking/6-axis/mpu-6050/

export class MPU6050 extends PeripheralBase<MPU6050> implements Accelerometer, Gyroscope {
	ax = 0
	ay = 0
	az = 0
	gx = 0
	gy = 0
	gz = 0

	static readonly ADDRESS = 0x68
	static readonly ALTERNATIVE_ADDRESS = 0x69
	static readonly PWR_MGMT_1_REG = 0x6b
	static readonly GYRO_CONFIG_REG = 0x1b
	static readonly ACCEL_CONFIG_REG = 0x1c
	static readonly ACCEL_XOUT_H_REG = 0x3b
	static readonly WAKE_UP = 0x00

	#timer?: NodeJS.Timeout
	readonly #accelerometerScale: number
	readonly #gyroscopeScale: number
	readonly #accelerometerConfig: number
	readonly #gyroscopeConfig: number

	readonly name = 'MPU6050'

	constructor(
		readonly client: FirmataClient,
		readonly address: number = MPU6050.ADDRESS,
		readonly pollingInterval: number = DEFAULT_POLLING_INTERVAL,
		options: MPU6050Options = DEFAULT_MPU6050_OPTIONS,
	) {
		super()

		const accelerometerRange = options.accelerometerRange ?? DEFAULT_MPU6050_OPTIONS.accelerometerRange
		const gyroscopeRange = options.gyroscopeRange ?? DEFAULT_MPU6050_OPTIONS.gyroscopeRange
		const accelerometerBits = accelerometerRange === 2 ? 0 : accelerometerRange === 4 ? 1 : accelerometerRange === 8 ? 2 : 3
		const gyroscopeBits = gyroscopeRange === 250 ? 0 : gyroscopeRange === 500 ? 1 : gyroscopeRange === 1000 ? 2 : 3
		const accelerometerCountsPerG = accelerometerRange === 2 ? 16384 : accelerometerRange === 4 ? 8192 : accelerometerRange === 8 ? 4096 : 2048
		const gyroscopeCountsPerDegPerSecond = gyroscopeRange === 250 ? 131 : gyroscopeRange === 500 ? 65.5 : gyroscopeRange === 1000 ? 32.8 : 16.4

		this.#accelerometerConfig = accelerometerBits << 3
		this.#gyroscopeConfig = gyroscopeBits << 3
		this.#accelerometerScale = G / accelerometerCountsPerG
		this.#gyroscopeScale = DEG2RAD / gyroscopeCountsPerDegPerSecond
	}

	// Wakes the device, configures full-scale ranges, and starts burst reads of accel/temp/gyro data.
	start() {
		if (this.#timer === undefined) {
			this.client.addHandler(this)
			this.client.twoWireConfig(0)
			this.client.twoWireWrite(this.address, [MPU6050.PWR_MGMT_1_REG, MPU6050.WAKE_UP])
			this.client.twoWireWrite(this.address, [MPU6050.ACCEL_CONFIG_REG, this.#accelerometerConfig])
			this.client.twoWireWrite(this.address, [MPU6050.GYRO_CONFIG_REG, this.#gyroscopeConfig])
			this.#readMeasurement()
			this.#timer = setInterval(this.#readMeasurement.bind(this), Math.max(10, this.pollingInterval))
		}
	}

	// Stops polling and detaches the Firmata handler.
	stop() {
		this.client.removeHandler(this)
		clearInterval(this.#timer)
		this.#timer = undefined
	}

	// Decodes one burst-read frame into acceleration and angular velocity in SI units.
	twoWireMessage(client: FirmataClient, address: number, register: number, data: Buffer) {
		if (client !== this.client || address !== this.address || register !== MPU6050.ACCEL_XOUT_H_REG || data.byteLength !== 14) return

		const ax = this.calculateAcceleration(data.readInt16BE(0))
		const ay = this.calculateAcceleration(data.readInt16BE(2))
		const az = this.calculateAcceleration(data.readInt16BE(4))
		const gx = this.calculateAngularVelocity(data.readInt16BE(8))
		const gy = this.calculateAngularVelocity(data.readInt16BE(10))
		const gz = this.calculateAngularVelocity(data.readInt16BE(12))

		if (ax !== this.ax || ay !== this.ay || az !== this.az || gx !== this.gx || gy !== this.gy || gz !== this.gz) {
			this.ax = ax
			this.ay = ay
			this.az = az
			this.gx = gx
			this.gy = gy
			this.gz = gz
			this.fire()
		}
	}

	// Converts one raw accelerometer axis sample into m/s^2.
	calculateAcceleration(raw: number) {
		return raw * this.#accelerometerScale
	}

	// Converts one raw gyroscope axis sample into rad/s.
	calculateAngularVelocity(raw: number) {
		return raw * this.#gyroscopeScale
	}

	// Requests one full accel/temp/gyro burst frame.
	#readMeasurement() {
		this.client.twoWireRead(this.address, MPU6050.ACCEL_XOUT_H_REG, 14)
	}
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

// https://sensirion.com/media/documents/120BBE4C/63500094/Sensirion_Datasheet_Humidity_Sensor_SHT21.pdf

export class SHT21 extends PeripheralBase<SHT21> implements Hygrometer, Thermometer {
	humidity = 0
	temperature = 0

	static readonly ADDRESS = 0x40

	static readonly #READ_TEMP_HOLD_CMD = 0xe3
	static readonly #READ_HUM_HOLD_CMD = 0xe5
	static readonly #SOFT_RESET_CMD = 0xfe

	#timer?: NodeJS.Timeout
	#temperatureChanged = false

	readonly name = 'SHT21'

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

// https://cdn-shop.adafruit.com/product-files/3721/AM2320.pdf

export class AM2320 extends PeripheralBase<AM2320> implements Hygrometer, Thermometer {
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

	readonly name = 'AM2320'

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

export class HMC5883L extends PeripheralBase<HMC5883L> implements Magnetometer {
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

export class BH1750 extends PeripheralBase<BH1750> implements Luxmeter {
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

	readonly name = 'BH1750'

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

export class TSL2561 extends PeripheralBase<TSL2561> implements Luxmeter {
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

	readonly name = 'TSL2561'

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

export class MAX44009 extends PeripheralBase<MAX44009> implements Luxmeter {
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

	readonly name = 'MAX44009'

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

// https://ww1.microchip.com/downloads/aemDocuments/documents/MSLD/ProductDocuments/DataSheets/MCP4725-Data-Sheet-20002039E.pdf

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

// https://cdn.sparkfun.com/assets/4/5/f/a/d/TEA5767.pdf

export class TEA5767 extends PeripheralBase<TEA5767> implements Radio {
	#frequency: number
	#muted: boolean
	#stereo: boolean
	#softMute: boolean
	#highCutControl: boolean
	#stereoNoiseCancelling: boolean
	#highSideInjection: boolean
	#seekFailed = false
	#station = false
	#rssi = 0

	static readonly ADDRESS = 0x60
	static readonly STATUS_BYTES = 5
	static readonly FREQUENCY_STEP_KHZ = 100
	static readonly IF_KHZ = 225
	static readonly MAX_LEVEL = 15
	static readonly MAX_RSSI = 127
	static readonly IF_VALID_MIN = 0x29
	static readonly IF_VALID_MAX = 0x7f

	static readonly BYTE1_MUTE = 1 << 7
	static readonly BYTE1_SEARCH = 1 << 6
	static readonly BYTE3_SEARCH_UP = 1 << 7
	static readonly BYTE3_SEARCH_STOP_LEVEL_SHIFT = 5
	static readonly BYTE3_HIGH_SIDE_INJECTION = 1 << 4
	static readonly BYTE3_FORCE_MONO = 1 << 3
	static readonly BYTE4_STANDBY = 1 << 6
	static readonly BYTE4_BAND_LIMIT_JAPAN = 1 << 5
	static readonly BYTE4_XTAL_32768HZ = 1 << 4
	static readonly BYTE4_SOFT_MUTE = 1 << 3
	static readonly BYTE4_HIGH_CUT_CONTROL = 1 << 2
	static readonly BYTE4_STEREO_NOISE_CANCELLING = 1 << 1
	static readonly BYTE5_PLLREF_6500KHZ = 1 << 7
	static readonly BYTE5_DEEMPHASIS_75US = 1 << 6

	static readonly STATUS_READY = 1 << 7
	static readonly STATUS_BAND_LIMIT = 1 << 6
	static readonly STATUS_PLL_HIGH_MASK = 0x3f
	static readonly STATUS_STEREO = 1 << 7
	static readonly STATUS_LEVEL_SHIFT = 4

	readonly #bandStartKHz: number
	readonly #bandEndKHz: number
	readonly #bandBits: number
	readonly #xtalBit: number
	readonly #pllRefBit: number
	readonly #deEmphasisBit: number
	readonly #referenceDividerHz: number
	readonly #searchStopBits: number
	readonly #wrapAround: boolean

	#frequencyKHz: number
	#started = false
	#seeking = false
	#stereoAllowed: boolean
	#seekDirection: RadioSeekDirection = 'up'
	#seekWrapRemaining = 0
	#timer?: NodeJS.Timeout

	readonly name = 'TEA5767'

	constructor(
		readonly client: FirmataClient,
		readonly address: number = TEA5767.ADDRESS,
		readonly pollingInterval: number = DEFAULT_POLLING_INTERVAL,
		options: TEA5767Options = DEFAULT_TEA5767_OPTIONS,
	) {
		super()

		const band = options.band ?? DEFAULT_TEA5767_OPTIONS.band
		const referenceClock = options.referenceClock ?? DEFAULT_TEA5767_OPTIONS.referenceClock
		const searchStopLevel = options.searchStopLevel ?? DEFAULT_TEA5767_OPTIONS.searchStopLevel
		const stereo = options.stereo ?? DEFAULT_TEA5767_OPTIONS.stereo

		this.#bandStartKHz = band === 'japan' ? 76000 : 87500
		this.#bandEndKHz = band === 'japan' ? 91000 : 108000
		this.#bandBits = band === 'japan' ? TEA5767.BYTE4_BAND_LIMIT_JAPAN : 0
		this.#xtalBit = referenceClock === 32768 ? TEA5767.BYTE4_XTAL_32768HZ : 0
		this.#pllRefBit = referenceClock === 6500000 ? TEA5767.BYTE5_PLLREF_6500KHZ : 0
		this.#deEmphasisBit = (options.deEmphasis ?? DEFAULT_TEA5767_OPTIONS.deEmphasis) === 75 ? TEA5767.BYTE5_DEEMPHASIS_75US : 0
		this.#referenceDividerHz = referenceClock === 32768 ? 32768 : 50000
		this.#searchStopBits = this.#searchStopLevelBits(searchStopLevel)
		this.#wrapAround = options.wrap ?? DEFAULT_TEA5767_OPTIONS.wrap
		this.#frequencyKHz = this.#normalizeFrequencyKHz(options.frequency ?? DEFAULT_TEA5767_OPTIONS.frequency)
		this.#frequency = this.#frequencyKHz / 1000
		this.#muted = options.muted ?? DEFAULT_TEA5767_OPTIONS.muted
		this.#stereoAllowed = stereo
		this.#stereo = stereo
		this.#softMute = options.softMute ?? DEFAULT_TEA5767_OPTIONS.softMute
		this.#highCutControl = options.highCutControl ?? DEFAULT_TEA5767_OPTIONS.highCutControl
		this.#stereoNoiseCancelling = options.stereoNoiseCancelling ?? DEFAULT_TEA5767_OPTIONS.stereoNoiseCancelling
		this.#highSideInjection = options.highSideInjection ?? DEFAULT_TEA5767_OPTIONS.highSideInjection
	}

	// Powers the tuner on and schedules periodic raw status polling.
	start() {
		if (this.#started) return

		this.#started = true
		this.client.addHandler(this)
		this.client.twoWireConfig(0)
		this.#writeState()
		this.#requestStatus()
		this.#timer = setInterval(this.#requestStatus.bind(this), Math.max(100, this.pollingInterval))
	}

	// Puts the tuner into standby mode and stops status polling.
	stop() {
		if (!this.#started) return

		this.#started = false
		this.#seeking = false
		this.client.removeHandler(this)
		clearInterval(this.#timer)
		this.#timer = undefined
		this.#writeState(false, true)
	}

	// Gets the current tuned frequency in MHz.
	get frequency() {
		return this.#frequency
	}

	// Sets the current tuned frequency in MHz and requests a fresh status frame.
	set frequency(value: number) {
		this.#frequencyKHz = this.#normalizeFrequencyKHz(value)
		this.#frequency = this.#frequencyKHz / 1000
		this.#seekFailed = false
		this.#seeking = false

		if (this.#started) {
			this.#writeState()
			this.#requestStatus()
		}
	}

	// Steps the frequency up by 100 kHz and wraps at band end.
	frequencyUp() {
		const nextFrequencyKHz = this.#frequencyKHz < this.#bandEndKHz ? this.#frequencyKHz + TEA5767.FREQUENCY_STEP_KHZ : this.#bandStartKHz
		this.frequency = nextFrequencyKHz / 1000
	}

	// Steps the frequency down by 100 kHz and wraps at band start.
	frequencyDown() {
		const nextFrequencyKHz = this.#frequencyKHz > this.#bandStartKHz ? this.#frequencyKHz - TEA5767.FREQUENCY_STEP_KHZ : this.#bandEndKHz
		this.frequency = nextFrequencyKHz / 1000
	}

	// Returns whether the current reception is stereo.
	get stereo() {
		return this.#stereo
	}

	// Forces mono reception when false and allows stereo decoding when true.
	set stereo(value: boolean) {
		this.#stereoAllowed = value
		if (!value) this.#stereo = false
		if (this.#started) {
			this.#writeState(this.#seeking)
			this.#requestStatus()
		}
	}

	// Returns whether the tuner audio path is muted.
	get muted() {
		return this.#muted
	}

	// Enables or disables the tuner mute bit.
	set muted(value: boolean) {
		this.#muted = value
		if (this.#started) this.#writeState(this.#seeking)
	}

	// Mutes the tuner audio output.
	mute() {
		this.muted = true
	}

	// Unmutes the tuner audio output.
	unmute() {
		this.muted = false
	}

	// Returns the derived signal level mapped to the shared 0..127 radio RSSI scale.
	get rssi() {
		return this.#rssi
	}

	// Returns whether the current tuned channel passed the IF counter and level checks.
	get station() {
		return this.#station
	}

	// Returns whether the latest seek hit a band limit without finding a valid station.
	get seekFailed() {
		return this.#seekFailed
	}

	// Returns 100 because TEA5767 has no on-chip hardware volume control.
	get volume() {
		return 100
	}

	// TEA5767 leaves volume control to the downstream analog amplifier.
	volumeUp() {}

	// TEA5767 leaves volume control to the downstream analog amplifier.
	volumeDown() {}

	// Enables or disables the chip soft mute function.
	set softMute(value: boolean) {
		this.#softMute = value
		if (this.#started) this.#writeState(this.#seeking)
	}

	// Enables or disables the chip high-cut control.
	set highCutControl(value: boolean) {
		this.#highCutControl = value
		if (this.#started) this.#writeState(this.#seeking)
	}

	// Enables or disables stereo noise cancelling.
	set stereoNoiseCancelling(value: boolean) {
		this.#stereoNoiseCancelling = value
		if (this.#started) this.#writeState(this.#seeking)
	}

	// Selects high-side or low-side local oscillator injection.
	set highSideInjection(value: boolean) {
		this.#highSideInjection = value
		if (this.#started) {
			this.#writeState(this.#seeking)
			this.#requestStatus()
		}
	}

	// Starts an autonomous seek and optionally wraps once at the band limit.
	seek(direction: RadioSeekDirection = 'up', wrap: boolean = this.#wrapAround) {
		this.#ensureStarted()
		this.#seekDirection = direction
		this.#seekFailed = false
		this.#seeking = true
		this.#seekWrapRemaining = wrap ? 1 : 0
		this.#beginSeekCycle()
	}

	// Decodes 5-byte raw status frames returned by the chip read mode.
	twoWireMessage(client: FirmataClient, address: number, _register: number, data: Buffer) {
		if (client !== this.client || address !== this.address || data.byteLength !== TEA5767.STATUS_BYTES) return

		const previousFrequency = this.#frequency
		const status = this.#decodeStatus(data)
		const nextFrequencyKHz = this.#frequencyFromPll(status.pll)

		this.#frequencyKHz = nextFrequencyKHz
		this.#frequency = nextFrequencyKHz / 1000

		if (this.#seeking) {
			this.#handleSeekStatus(status, previousFrequency)
			return
		}

		console.info('%j', status)

		if (!status.ready) return

		const nextStereo = this.#stereoAllowed && status.stereo
		const nextRssi = this.#rssiFromLevel(status.level)
		const nextStation = this.#isStation(status)
		const changed = this.#frequency !== previousFrequency || nextStereo !== this.#stereo || nextRssi !== this.#rssi || nextStation !== this.#station

		this.#stereo = nextStereo
		this.#rssi = nextRssi
		this.#station = nextStation

		if (changed) this.fire()
	}

	// Handles seek completion, false stops, and optional one-pass wraparound.
	#handleSeekStatus(status: TEA5767Status, previousFrequency: number) {
		if (!status.ready) return

		const nextStation = !status.bandLimit && this.#isStation(status)

		if (!nextStation) {
			this.#beginSeekCycle()
			return
		}

		const nextStereo = this.#stereoAllowed && status.stereo
		const nextRssi = this.#rssiFromLevel(status.level)
		const changed = this.#frequency !== previousFrequency || nextStereo !== this.#stereo || nextRssi !== this.#rssi || nextStation !== this.#station

		this.#seeking = false
		this.#stereo = nextStereo
		this.#rssi = nextRssi
		this.#station = nextStation
		this.#seekFailed = false
		this.#writeState()

		if (changed) this.fire()
	}

	// Advances to the next search start frequency or marks the seek as failed.
	#beginSeekCycle() {
		const nextFrequencyKHz = this.#nextSeekFrequencyKHz()

		if (nextFrequencyKHz === undefined) {
			const changed = this.#seekFailed === false || this.#station !== false

			this.#seeking = false
			this.#seekFailed = true
			this.#station = false
			this.#stereo = false
			this.#rssi = 0
			this.#writeState()
			if (changed) this.fire()
			return
		}

		this.#frequencyKHz = nextFrequencyKHz
		this.#frequency = nextFrequencyKHz / 1000
		this.#writeState(true)
		this.#requestStatus()
	}

	// Computes the next search entry point while honoring the optional wraparound.
	#nextSeekFrequencyKHz() {
		if (this.#seekDirection === 'up') {
			if (this.#frequencyKHz < this.#bandEndKHz) return Math.min(this.#bandEndKHz, this.#frequencyKHz + TEA5767.FREQUENCY_STEP_KHZ)
			if (this.#seekWrapRemaining > 0) {
				this.#seekWrapRemaining--
				return this.#bandStartKHz
			}
		} else {
			if (this.#frequencyKHz > this.#bandStartKHz) return Math.max(this.#bandStartKHz, this.#frequencyKHz - TEA5767.FREQUENCY_STEP_KHZ)
			if (this.#seekWrapRemaining > 0) {
				this.#seekWrapRemaining--
				return this.#bandEndKHz
			}
		}
	}

	// Packs the current state into the chip 5-byte write frame.
	#writeState(search: boolean = false, standby: boolean = false) {
		const pll = this.#frequencyToPll(this.#frequencyKHz)
		const data = Buffer.allocUnsafe(TEA5767.STATUS_BYTES)

		data[0] = (this.#muted || search ? TEA5767.BYTE1_MUTE : 0) | (search ? TEA5767.BYTE1_SEARCH : 0) | ((pll >>> 8) & TEA5767.STATUS_PLL_HIGH_MASK)
		data[1] = pll & 0xff
		data[2] = (this.#seekDirection === 'up' ? TEA5767.BYTE3_SEARCH_UP : 0) | this.#searchStopBits | (this.#highSideInjection ? TEA5767.BYTE3_HIGH_SIDE_INJECTION : 0) | (this.#stereoAllowed ? 0 : TEA5767.BYTE3_FORCE_MONO)
		data[3] = (standby ? TEA5767.BYTE4_STANDBY : 0) | this.#bandBits | this.#xtalBit | (this.#softMute ? TEA5767.BYTE4_SOFT_MUTE : 0) | (this.#highCutControl ? TEA5767.BYTE4_HIGH_CUT_CONTROL : 0) | (this.#stereoNoiseCancelling ? TEA5767.BYTE4_STEREO_NOISE_CANCELLING : 0)
		data[4] = this.#pllRefBit | this.#deEmphasisBit

		this.client.twoWireWrite(this.address, data)
	}

	// Requests the next 5-byte read-mode status frame.
	#requestStatus() {
		if (!this.#started) return
		this.client.twoWireRead(this.address, -1, TEA5767.STATUS_BYTES)
	}

	// Throws when an active I2C session is required for the operation.
	#ensureStarted() {
		if (!this.#started) throw new Error('TEA5767 has not been started.')
	}

	// Decodes the read-mode status bytes into a convenient internal structure.
	#decodeStatus(data: Buffer): TEA5767Status {
		return {
			ready: (data[0] & TEA5767.STATUS_READY) !== 0,
			bandLimit: (data[0] & TEA5767.STATUS_BAND_LIMIT) !== 0,
			pll: ((data[0] & TEA5767.STATUS_PLL_HIGH_MASK) << 8) | data[1],
			stereo: (data[2] & TEA5767.STATUS_STEREO) !== 0,
			ifCounter: data[2] & 0x7f,
			level: (data[3] >>> TEA5767.STATUS_LEVEL_SHIFT) & 0x0f,
		}
	}

	// Converts the 4-bit level ADC reading into the shared radio RSSI scale.
	#rssiFromLevel(level: number) {
		return Math.round(level * (TEA5767.MAX_RSSI / TEA5767.MAX_LEVEL))
	}

	// Checks whether the current tuned channel satisfies the IF and level validity rules.
	#isStation(status: TEA5767Status) {
		return status.ifCounter >= TEA5767.IF_VALID_MIN && status.ifCounter <= TEA5767.IF_VALID_MAX
	}

	// Maps the selected stop level to the write-mode search threshold bits.
	#searchStopLevelBits(searchStopLevel: TEA5767SearchStopLevel) {
		const value = searchStopLevel === 'low' ? 0b01 : searchStopLevel === 'mid' ? 0b10 : 0b11
		return value << TEA5767.BYTE3_SEARCH_STOP_LEVEL_SHIFT
	}

	// Converts a tuned frequency to the PLL word using the configured reference clock.
	#frequencyToPll(frequencyKHz: number) {
		const oscillatorFrequencyHz = frequencyKHz * 1000 + (this.#highSideInjection ? TEA5767.IF_KHZ * 1000 : -TEA5767.IF_KHZ * 1000)
		return Math.max(0, Math.min(0x3fff, Math.round((4 * oscillatorFrequencyHz) / this.#referenceDividerHz)))
	}

	// Converts the PLL word back to the nearest public FM frequency.
	#frequencyFromPll(pll: number) {
		const frequencyKHz = Math.round(((pll * this.#referenceDividerHz) / 4 + (this.#highSideInjection ? -TEA5767.IF_KHZ * 1000 : TEA5767.IF_KHZ * 1000)) / 1000)
		return this.#normalizeFrequencyKHzValue(frequencyKHz)
	}

	// Clamps a requested frequency to the current band and public 100 kHz tuning grid.
	#normalizeFrequencyKHz(frequency: number) {
		return this.#normalizeFrequencyKHzValue(Math.round(frequency * 1000))
	}

	// Clamps a kHz value to the band and rounds it to the nearest 100 kHz step.
	#normalizeFrequencyKHzValue(frequencyKHz: number) {
		const clampedFrequencyKHz = Math.max(this.#bandStartKHz, Math.min(this.#bandEndKHz, frequencyKHz))
		const channel = Math.round((clampedFrequencyKHz - this.#bandStartKHz) / TEA5767.FREQUENCY_STEP_KHZ)
		return this.#bandStartKHz + channel * TEA5767.FREQUENCY_STEP_KHZ
	}
}

// https://cdn-shop.adafruit.com/product-files/5651/5651_tuner84_RDA5807M_datasheet_v1.pdf

export class RDA5807 extends PeripheralBase<RDA5807> implements Radio {
	#frequency: number
	#volume: number
	#muted: boolean
	#bassBoost: boolean
	#audioOutputHighZ: boolean
	#eastEuropeMode: RDA5807EastEuropeMode
	#seekFailed = false
	#stereo = false
	#rssi = 0
	#station = false

	static readonly ADDRESS = 0x11

	static readonly DEVICE_ID_REG = 0x00
	static readonly CONTROL_REG = 0x02
	static readonly TUNING_REG = 0x03
	static readonly AUDIO_REG = 0x05
	static readonly SYSTEM_REG = 0x06
	static readonly BAND_REG = 0x07
	static readonly STATUS_REG = 0x0a

	static readonly REG02_DHIZ = 1 << 15
	static readonly REG02_DMUTE = 1 << 14
	static readonly REG02_MONO = 1 << 13
	static readonly REG02_BASS = 1 << 12
	static readonly REG02_SEEKUP = 1 << 9
	static readonly REG02_SEEK = 1 << 8
	static readonly REG02_SKMODE = 1 << 7
	static readonly REG02_ENABLE = 1 << 0

	static readonly REG03_CHAN_SHIFT = 6
	static readonly REG03_TUNE = 1 << 4

	static readonly REG06_OPEN_MODE_SHIFT = 13
	static readonly REG06_OPEN_WRITE = 0b11 << RDA5807.REG06_OPEN_MODE_SHIFT

	static readonly REG05_SEEKTH_SHIFT = 8
	static readonly REG05_SEEKTH_MASK = 0x0f << RDA5807.REG05_SEEKTH_SHIFT
	static readonly REG05_LNA_PORT_SEL_SHIFT = 6
	static readonly REG05_VOLUME_MASK = 0x0f

	static readonly REG07_SOFTBLEND_THRESHOLD_SHIFT = 10
	static readonly REG07_SOFTBLEND_THRESHOLD_DEFAULT = 0x10 << RDA5807.REG07_SOFTBLEND_THRESHOLD_SHIFT
	static readonly REG07_EAST_EUROPE_65_76 = 1 << 9
	static readonly REG07_SOFTBLEND_ENABLE = 1 << 1

	static readonly STATUS_RDS_READY = 1 << 15
	static readonly STATUS_SEEK_TUNE_COMPLETE = 1 << 14
	static readonly STATUS_SEEK_FAILED = 1 << 13
	static readonly STATUS_STEREO = 1 << 10
	static readonly STATUS_CHANNEL_MASK = 0x03ff
	static readonly SIGNAL_RSSI_SHIFT = 9
	static readonly SIGNAL_RSSI_MASK = 0x7f << RDA5807.SIGNAL_RSSI_SHIFT
	static readonly SIGNAL_STATION = 1 << 8
	static readonly SIGNAL_READY = 1 << 7

	readonly #bandStartKHz: number
	readonly #bandEndKHz: number
	readonly #bandBits: number
	readonly #spacingKHz: number
	readonly #spacingBits: number
	readonly #wrapAround: boolean

	#frequencyKHz: number
	#started = false
	#seeking = false
	#reg02: number
	#reg05: number
	#reg06: number
	#reg07: number
	#timer?: NodeJS.Timeout

	readonly name = 'RDA5807'

	constructor(
		readonly client: FirmataClient,
		readonly address: number = RDA5807.ADDRESS,
		readonly pollingInterval: number = DEFAULT_POLLING_INTERVAL,
		options: RDA5807Options = DEFAULT_RDA5807_OPTIONS,
	) {
		super()

		const band = options.band ?? DEFAULT_RDA5807_OPTIONS.band
		const spacing = options.spacing ?? DEFAULT_RDA5807_OPTIONS.spacing
		const seekThreshold = clamp(Math.trunc(options.seekThreshold ?? DEFAULT_RDA5807_OPTIONS.seekThreshold), 0, 15)
		const volume = clamp(Math.round((options.volume ?? DEFAULT_RDA5807_OPTIONS.volume) / RDA5807_VOLUME_FACTOR), 0, 15)
		const muted = options.muted ?? DEFAULT_RDA5807_OPTIONS.muted
		const stereo = options.stereo ?? DEFAULT_RDA5807_OPTIONS.stereo
		const bassBoost = options.bassBoost ?? DEFAULT_RDA5807_OPTIONS.bassBoost
		const audioOutputHighZ = options.audioOutputHighZ ?? DEFAULT_RDA5807_OPTIONS.audioOutputHighZ
		const eastEuropeMode = options.eastEuropeMode ?? DEFAULT_RDA5807_OPTIONS.eastEuropeMode

		this.#bandStartKHz = band === 'usEurope' ? 87000 : band === 'japanWide' || band === 'world' ? 76000 : eastEuropeMode === '50_65' ? 50000 : 65000
		this.#bandEndKHz = band === 'usEurope' ? 108000 : band === 'japanWide' ? 91000 : band === 'world' ? 108000 : eastEuropeMode === '50_65' ? 65000 : 76000
		this.#bandBits = band === 'usEurope' ? 0 : band === 'japanWide' ? 1 : band === 'world' ? 2 : 3
		this.#spacingKHz = spacing
		this.#spacingBits = spacing === 100 ? 0 : spacing === 200 ? 1 : spacing === 50 ? 2 : 3
		this.#wrapAround = options.wrap ?? DEFAULT_RDA5807_OPTIONS.wrap
		this.#frequencyKHz = this.#normalizeFrequencyKHz(options.frequency ?? DEFAULT_RDA5807_OPTIONS.frequency)
		this.#frequency = this.#frequencyKHz / 1000
		this.#volume = volume
		this.#muted = muted
		this.#stereo = stereo
		this.#bassBoost = bassBoost
		this.#audioOutputHighZ = audioOutputHighZ
		this.#eastEuropeMode = eastEuropeMode
		this.#reg02 = (audioOutputHighZ ? 0 : RDA5807.REG02_DHIZ) | (muted ? 0 : RDA5807.REG02_DMUTE) | (stereo === false ? RDA5807.REG02_MONO : 0) | (bassBoost ? RDA5807.REG02_BASS : 0) | RDA5807.REG02_ENABLE
		this.#reg05 = (seekThreshold << RDA5807.REG05_SEEKTH_SHIFT) | (2 << RDA5807.REG05_LNA_PORT_SEL_SHIFT) | volume
		this.#reg06 = RDA5807.REG06_OPEN_WRITE
		this.#reg07 = RDA5807.REG07_SOFTBLEND_THRESHOLD_DEFAULT | (eastEuropeMode === '65_76' ? RDA5807.REG07_EAST_EUROPE_65_76 : 0) | RDA5807.REG07_SOFTBLEND_ENABLE
	}

	// Powers the tuner on, configures the audio path, and tunes the initial frequency.
	start() {
		if (this.#started) return

		this.#started = true
		this.client.addHandler(this)
		this.client.twoWireConfig(0)
		this.#writeRegister(RDA5807.CONTROL_REG, this.#reg02)
		this.#writeRegister(RDA5807.AUDIO_REG, this.#reg05)
		if (this.#bandBits === 3) {
			this.#writeRegister(RDA5807.SYSTEM_REG, this.#reg06)
			this.#writeRegister(RDA5807.BAND_REG, this.#reg07)
		}
		this.#writeRegister(RDA5807.TUNING_REG, this.#tuningValue(true))
		this.#requestStatus()
		this.#timer = setInterval(this.#requestStatus.bind(this), Math.max(100, this.pollingInterval))
	}

	// Powers the tuner down and clears any pending register reads.
	stop() {
		if (!this.#started) return

		this.#started = false
		this.#seeking = false
		this.client.removeHandler(this)
		clearInterval(this.#timer)
		this.#timer = undefined
		this.#writeRegister(RDA5807.CONTROL_REG, this.#reg02 & ~RDA5807.REG02_ENABLE & ~RDA5807.REG02_SEEK)
		this.clearPendingTwoWireReads(new Error('RDA5807 stopped before the I2C read completed.'))
	}

	// Gets the current tuned frequency in MHz.
	get frequency() {
		return this.#frequency
	}

	// Sets the current tuned frequency in MHz.
	set frequency(value: number) {
		const nextFrequencyKHz = this.#normalizeFrequencyKHz(value)
		this.#seeking = false
		this.#frequencyKHz = nextFrequencyKHz
		this.#frequency = nextFrequencyKHz / 1000
		this.#seekFailed = false

		if (this.#started) {
			this.#clearSeekTuneState()
			this.#writeRegister(RDA5807.TUNING_REG, this.#tuningValue(true))
		}
	}

	// Steps the frequency up by the configured channel spacing and wraps at band end.
	frequencyUp() {
		const nextFrequencyKHz = this.#frequencyKHz < this.#bandEndKHz ? this.#frequencyKHz + this.#spacingKHz : this.#bandStartKHz
		this.frequency = nextFrequencyKHz / 1000
	}

	// Steps the frequency down by the configured channel spacing and wraps at band start.
	frequencyDown() {
		const nextFrequencyKHz = this.#frequencyKHz > this.#bandStartKHz ? this.#frequencyKHz - this.#spacingKHz : this.#bandEndKHz
		this.frequency = nextFrequencyKHz / 1000
	}

	// Returns whether the configured output audio mode is stereo.
	get stereo() {
		return this.#stereo
	}

	// Gets the current RSSI level from the chip status register.
	get rssi() {
		return this.#rssi
	}

	// Returns whether the current channel is considered a valid station.
	get station() {
		return this.#station
	}

	// Gets the output volume level between 0 and 100.
	get volume() {
		return Math.round(this.#volume * RDA5807_VOLUME_FACTOR)
	}

	// Sets the output volume level between 0 and 100.
	set volume(volume: number) {
		const nextVolume = clamp(Math.round(volume / RDA5807_VOLUME_FACTOR), 0, 15)
		this.#volume = nextVolume
		this.#reg05 = (this.#reg05 & ~RDA5807.REG05_VOLUME_MASK) | nextVolume
		if (this.#started) this.#writeRegister(RDA5807.AUDIO_REG, this.#reg05)
	}

	// Increments the output volume by one step.
	volumeUp() {
		this.volume += RDA5807_VOLUME_FACTOR
	}

	// Decrements the output volume by one step.
	volumeDown() {
		this.volume -= RDA5807_VOLUME_FACTOR
	}

	// Returns whether the audio is muted.
	get muted() {
		return this.#muted
	}

	// Sets whether the tuner should force mono or allow stereo decoding.
	set stereo(value: boolean) {
		this.#stereo = value
		this.#reg02 = value === false ? this.#reg02 | RDA5807.REG02_MONO : this.#reg02 & ~RDA5807.REG02_MONO
		if (this.#started) this.#writeRegister(RDA5807.CONTROL_REG, this.#reg02 & ~RDA5807.REG02_SEEK)
		this.#requestStatus()
	}

	// Returns whether bass boost is enabled.
	get bassBoost() {
		return this.#bassBoost
	}

	// Enables or disables bass boost.
	set bassBoost(value: boolean) {
		this.#bassBoost = value
		this.#reg02 = value ? this.#reg02 | RDA5807.REG02_BASS : this.#reg02 & ~RDA5807.REG02_BASS
		if (this.#started) this.#writeRegister(RDA5807.CONTROL_REG, this.#reg02 & ~RDA5807.REG02_SEEK)
	}

	// Enables or disables high-impedance analog audio output.
	set audioOutputHighZ(value: boolean) {
		this.#audioOutputHighZ = value
		this.#reg02 = value ? this.#reg02 & ~RDA5807.REG02_DHIZ : this.#reg02 | RDA5807.REG02_DHIZ
		if (this.#started) this.#writeRegister(RDA5807.CONTROL_REG, this.#reg02 & ~RDA5807.REG02_SEEK)
	}

	// Enables or disables the audio mute bit.
	set muted(value: boolean) {
		this.#muted = value
		this.#reg02 = value ? this.#reg02 & ~RDA5807.REG02_DMUTE : this.#reg02 | RDA5807.REG02_DMUTE
		if (this.#started) this.#writeRegister(RDA5807.CONTROL_REG, this.#reg02 & ~RDA5807.REG02_SEEK)
	}

	// Mutes the tuner audio output.
	mute() {
		this.muted = true
	}

	// Unmutes the tuner audio output.
	unmute() {
		this.muted = false
	}

	get seekFailed() {
		return this.#seekFailed
	}

	// Starts seeking in the requested direction and completes when the next status frame reports STC.
	seek(direction: RadioSeekDirection = 'up', wrap: boolean = this.#wrapAround) {
		this.#ensureStarted()
		this.#clearSeekTuneState()

		const seekDirection = direction === 'up' ? RDA5807.REG02_SEEKUP : 0
		const seekMode = wrap ? 0 : RDA5807.REG02_SKMODE
		this.#seeking = true
		this.#seekFailed = false
		this.#writeRegister(RDA5807.CONTROL_REG, (this.#reg02 & ~(RDA5807.REG02_SEEKUP | RDA5807.REG02_SKMODE)) | seekDirection | seekMode | RDA5807.REG02_SEEK)
		this.#requestStatus()
	}

	// Decodes polled status frames and finalizes seek completion when STC is asserted.
	twoWireMessage(client: FirmataClient, address: number, register: number, data: Buffer) {
		if (client !== this.client || address !== this.address || register !== RDA5807.STATUS_REG || data.byteLength !== 4) return

		const status = this.#decodeStatus(data)
		const applyStatus = !this.#seeking || status.seekTuneComplete
		const nextFrequency = applyStatus ? this.#frequencyFromChannel(status.channel) : this.#frequency
		const nextSeekFailed = applyStatus ? status.seekFailed : this.#seekFailed
		const nextStereo = applyStatus ? status.stereo : this.#stereo
		const nextRssi = applyStatus ? status.rssi : this.#rssi
		const nextStation = applyStatus ? status.station : this.#station
		const changed = nextFrequency !== this.#frequency || nextSeekFailed !== this.#seekFailed || nextStereo !== this.#stereo || nextRssi !== this.#rssi || nextStation !== this.#station

		this.#frequencyKHz = Math.round(nextFrequency * 1000)
		this.#frequency = nextFrequency
		this.#seekFailed = nextSeekFailed
		this.#stereo = nextStereo
		this.#rssi = nextRssi
		this.#station = nextStation

		if (this.#seeking && status.seekTuneComplete) {
			this.#seeking = false
			this.#writeRegister(RDA5807.CONTROL_REG, this.#reg02 & ~(RDA5807.REG02_SEEKUP | RDA5807.REG02_SKMODE | RDA5807.REG02_SEEK))
		}

		if (changed) this.fire()
	}

	// Converts the polled 0x0A/0x0B status frame into decoded tuner state.
	#decodeStatus(data: Buffer): RDA5807Status {
		const status = data.readUInt16BE(0)
		const signal = data.readUInt16BE(2)

		return {
			rdsReady: (status & RDA5807.STATUS_RDS_READY) !== 0,
			seekTuneComplete: (status & RDA5807.STATUS_SEEK_TUNE_COMPLETE) !== 0,
			seekFailed: (status & RDA5807.STATUS_SEEK_FAILED) !== 0,
			stereo: (status & RDA5807.STATUS_STEREO) !== 0,
			channel: status & RDA5807.STATUS_CHANNEL_MASK,
			rssi: (signal & RDA5807.SIGNAL_RSSI_MASK) >>> RDA5807.SIGNAL_RSSI_SHIFT,
			station: (signal & RDA5807.SIGNAL_STATION) !== 0,
			ready: (signal & RDA5807.SIGNAL_READY) !== 0,
		}
	}

	// Writes a 16-bit register through the direct-access I2C address.
	#writeRegister(register: number, value: number) {
		this.client.twoWireWrite(this.address, [register, value >>> 8, value & 0xff])
	}

	// Builds the tuning register value for the current band, spacing, and frequency.
	#tuningValue(tune: boolean) {
		return (this.#frequencyToChannel(this.#frequencyKHz) << RDA5807.REG03_CHAN_SHIFT) | (tune ? RDA5807.REG03_TUNE : 0) | (this.#bandBits << 2) | this.#spacingBits
	}

	// Clears any stale seek/tune bits before starting a new operation.
	#clearSeekTuneState() {
		this.#seeking = false
		this.#writeRegister(RDA5807.CONTROL_REG, this.#reg02 & ~RDA5807.REG02_SEEK)
		this.#writeRegister(RDA5807.TUNING_REG, this.#tuningValue(false))
	}

	// Requests a combined 0x0A/0x0B status frame.
	#requestStatus() {
		if (!this.#started) return
		this.client.twoWireRead(this.address, RDA5807.STATUS_REG, 4)
	}

	// Throws when an active I2C session is required for the operation.
	#ensureStarted() {
		if (!this.#started) throw new Error('RDA5807 has not been started.')
	}

	// Converts a channel index into the corresponding FM frequency in MHz.
	#frequencyFromChannel(channel: number) {
		return (this.#bandStartKHz + channel * this.#spacingKHz) / 1000
	}

	// Converts a normalized frequency into the chip channel index.
	#frequencyToChannel(frequencyKHz: number) {
		return Math.max(0, Math.min(0x03ff, Math.round((frequencyKHz - this.#bandStartKHz) / this.#spacingKHz)))
	}

	// Clamps a requested frequency to the current band and channel spacing.
	#normalizeFrequencyKHz(frequency: number) {
		const requestedFrequencyKHz = Math.round(frequency * 1000)
		const clampedFrequencyKHz = Math.max(this.#bandStartKHz, Math.min(this.#bandEndKHz, requestedFrequencyKHz))
		const channel = Math.round((clampedFrequencyKHz - this.#bandStartKHz) / this.#spacingKHz)
		return this.#bandStartKHz + channel * this.#spacingKHz
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
