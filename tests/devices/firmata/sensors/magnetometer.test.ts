import { expect, test } from 'bun:test'
import { HMC5883L } from '../../../../src/devices/firmata/sensors/magnetometer'
import { MockFirmataClient } from '../util'

test('HMC5883L converts raw values to gauss', () => {
	const hmc5883l = new HMC5883L(undefined as never)
	expect(hmc5883l.rawToGauss(1090)).toBeCloseTo(1, 6)
	expect(hmc5883l.rawToGauss(-1090)).toBeCloseTo(-1, 6)
})

test('HMC5883L configures i2c reads and decodes xyz updates', () => {
	const client = new MockFirmataClient()
	const hmc5883l = new HMC5883L(client as never, HMC5883L.ADDRESS, 1000)
	let updates = 0

	hmc5883l.addListener(() => {
		updates++
	})

	hmc5883l.start()

	expect(client.messages).toEqual([
		['config', 0],
		['write', HMC5883L.ADDRESS, Buffer.from([HMC5883L.CONFIG_A_REG, 0x10])],
		['write', HMC5883L.ADDRESS, Buffer.from([HMC5883L.CONFIG_B_REG, 0x20])],
		['write', HMC5883L.ADDRESS, Buffer.from([HMC5883L.MODE_REG, HMC5883L.CONTINUOUS_MEASUREMENT_MODE])],
		['read', HMC5883L.ADDRESS, HMC5883L.DATA_X_MSB_REG, 6, false, 7, 'stop'],
	])

	hmc5883l.twoWireMessage(client as never, HMC5883L.ADDRESS, HMC5883L.DATA_X_MSB_REG, Buffer.from([0x04, 0x42, 0xfb, 0xbe, 0x02, 0x21]))
	expect(hmc5883l.x).toBeCloseTo(1, 6)
	expect(hmc5883l.y).toBeCloseTo(0.5, 6)
	expect(hmc5883l.z).toBeCloseTo(-1, 6)
	expect(updates).toBe(1)

	hmc5883l.twoWireMessage(client as never, HMC5883L.ADDRESS, HMC5883L.DATA_X_MSB_REG, Buffer.from([0xf0, 0x00, 0x00, 0x00, 0x00, 0x00]))
	expect(hmc5883l.x).toBeCloseTo(1, 6)
	expect(hmc5883l.y).toBeCloseTo(0.5, 6)
	expect(hmc5883l.z).toBeCloseTo(-1, 6)
	expect(updates).toBe(1)

	hmc5883l.stop()
	expect(client.handlers.size).toBe(0)
})
