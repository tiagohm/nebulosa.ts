import { DEG2RAD, G } from './constants'
import type { FirmataClient } from './firmata'
import { type Accelerometer, DEFAULT_POLLING_INTERVAL, type Gyroscope, PeripheralBase } from './firmata.peripheral'

export type MPU6050AccelerometerRange = 2 | 4 | 8 | 16 // g

export type MPU6050GyroscopeRange = 250 | 500 | 1000 | 2000 // deg/s

export interface MPU6050Options {
	readonly accelerometerRange?: MPU6050AccelerometerRange // g
	readonly gyroscopeRange?: MPU6050GyroscopeRange // deg/s
}

export const DEFAULT_MPU6050_OPTIONS: Required<MPU6050Options> = {
	accelerometerRange: 2,
	gyroscopeRange: 250,
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
