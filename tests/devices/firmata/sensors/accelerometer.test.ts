import { expect, test } from 'bun:test'
import { G } from '../../../../src/core/constants'
import { MPU6050 } from '../../../../src/devices/firmata/sensors/accelerometer'
import { deg } from '../../../../src/math/units/angle'
import { MockFirmataClient } from '../util'

test('MPU6050 converts raw acceleration and angular velocity', () => {
	const mpu6050 = new MPU6050(undefined as never)
	expect(mpu6050.calculateAcceleration(16384)).toBeCloseTo(G, 6)
	expect(mpu6050.calculateAngularVelocity(131)).toBeCloseTo(deg(1), 6)
})

test('MPU6050 configures i2c reads and decodes motion updates', () => {
	const client = new MockFirmataClient()
	const mpu6050 = new MPU6050(client as never, MPU6050.ADDRESS, 1000)
	let updates = 0

	mpu6050.addListener(() => {
		updates++
	})

	mpu6050.start()

	expect(client.messages).toEqual([
		['config', 0],
		['write', MPU6050.ADDRESS, Buffer.from([MPU6050.PWR_MGMT_1_REG, MPU6050.WAKE_UP])],
		['write', MPU6050.ADDRESS, Buffer.from([MPU6050.ACCEL_CONFIG_REG, 0x00])],
		['write', MPU6050.ADDRESS, Buffer.from([MPU6050.GYRO_CONFIG_REG, 0x00])],
		['read', MPU6050.ADDRESS, MPU6050.ACCEL_XOUT_H_REG, 14, false, 7, 'stop'],
	])

	mpu6050.twoWireMessage(client as never, MPU6050.ADDRESS, MPU6050.ACCEL_XOUT_H_REG, Buffer.from([0x40, 0x00, 0xc0, 0x00, 0x20, 0x00, 0x00, 0x00, 0x00, 0x83, 0xfe, 0xfa, 0x02, 0x8f]))
	expect(mpu6050.ax).toBeCloseTo(G, 6)
	expect(mpu6050.ay).toBeCloseTo(-G, 6)
	expect(mpu6050.az).toBeCloseTo(G / 2, 6)
	expect(mpu6050.gx).toBeCloseTo(deg(1), 6)
	expect(mpu6050.gy).toBeCloseTo(deg(-2), 6)
	expect(mpu6050.gz).toBeCloseTo(deg(5), 6)
	expect(updates).toBe(1)

	mpu6050.twoWireMessage(client as never, MPU6050.ADDRESS, MPU6050.ACCEL_XOUT_H_REG, Buffer.from([0x40, 0x00, 0xc0, 0x00, 0x20, 0x00, 0x00, 0x00, 0x00, 0x83, 0xfe, 0xfa, 0x02, 0x8f]))
	expect(updates).toBe(1)

	mpu6050.stop()
	expect(client.handlers.size).toBe(0)
})
