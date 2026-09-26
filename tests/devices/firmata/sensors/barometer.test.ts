import { expect, test } from 'bun:test'
import { BMP180, BMP280 } from '../../../../src/devices/firmata/sensors/barometer'
import { fromPressure } from '../../../../src/math/units/distance'
import { MockFirmataClient } from '../util'

test('BMP180 calculate true temperature & pressure', () => {
	const bmp180 = new BMP180(undefined as never, 0)
	expect(bmp180.calculateTrueTemperature(27898)).toBe(15)
	expect(bmp180.calculateTruePressure(23843)).toBe(69964)
})

test('BMP180 reads high unsigned raw temperatures', () => {
	const client = new MockFirmataClient()
	const bmp180 = new BMP180(client as never, 0)
	const calibration = Buffer.alloc(22)
	calibration.writeInt16BE(408, 0)
	calibration.writeInt16BE(-72, 2)
	calibration.writeInt16BE(-14383, 4)
	calibration.writeUInt16BE(32741, 6)
	calibration.writeUInt16BE(32757, 8)
	calibration.writeUInt16BE(23153, 10)
	calibration.writeInt16BE(6190, 12)
	calibration.writeInt16BE(4, 14)
	calibration.writeInt16BE(-32768, 16)
	calibration.writeInt16BE(-8711, 18)
	calibration.writeInt16BE(2868, 20)

	bmp180.start()
	bmp180.twoWireMessage(client as never, BMP180.ADDRESS, 0xaa, calibration)
	bmp180.twoWireMessage(client as never, BMP180.ADDRESS, 0xf6, Buffer.from([0x93, 0x99]))

	expect(bmp180.temperature).toBe(85)
	bmp180.stop()
})

test('BMP180 reinitializes after stopping', () => {
	const client = new MockFirmataClient()
	const bmp180 = new BMP180(client as never, 0)
	const calibration = Buffer.alloc(22)

	bmp180.start()
	bmp180.twoWireMessage(client as never, BMP180.ADDRESS, 0xaa, calibration)
	bmp180.stop()
	bmp180.start()
	bmp180.twoWireMessage(client as never, BMP180.ADDRESS, 0xaa, calibration)

	expect(client.messages.filter((message) => message[0] === 'read' && message[2] === 0xaa)).toHaveLength(2)
	expect(client.messages.filter((message) => message[0] === 'write')).toHaveLength(2)
	bmp180.stop()
})

test('BMP280 reinitializes after stopping', () => {
	const client = new MockFirmataClient()
	const bmp280 = new BMP280(client as never, BMP280.ADDRESS, 100)
	const calibration = Buffer.alloc(24)
	calibration.writeUInt16LE(36477, 6)

	bmp280.start()
	bmp280.twoWireMessage(client as never, BMP280.ADDRESS, 0x88, calibration)
	bmp280.stop()
	bmp280.start()
	bmp280.twoWireMessage(client as never, BMP280.ADDRESS, 0x88, calibration)

	expect(client.messages.filter((message) => message[0] === 'read' && message[2] === 0x88)).toHaveLength(2)
	expect(client.messages.filter((message) => message[0] === 'read' && message[2] === 0xf7)).toHaveLength(2)
	bmp280.stop()
})

test('BMP280 retriggers forced measurements before polling', async () => {
	const client = new MockFirmataClient()
	const bmp280 = new BMP280(client as never, BMP280.ADDRESS, 100, { mode: 'forced' })
	const calibration = Buffer.alloc(24)
	calibration.writeUInt16LE(36477, 6)

	bmp280.start()
	bmp280.twoWireMessage(client as never, BMP280.ADDRESS, 0x88, calibration)

	const controlWrites = () => client.messages.filter((message) => message[0] === 'write' && message[2][0] === BMP280.CTRL_MEAS_REG)
	const dataReads = () => client.messages.filter((message) => message[0] === 'read' && message[2] === BMP280.DATA_REG)

	expect(controlWrites()).toHaveLength(2)
	expect(dataReads()).toHaveLength(0)
	await Bun.sleep(20)
	expect(dataReads()).toHaveLength(1)

	await Bun.sleep(110)
	expect(controlWrites()).toHaveLength(3)
	expect(dataReads()).toHaveLength(2)
	bmp280.stop()
})

test('BMP180 derives altitude from the standard sea-level temperature', () => {
	const client = new MockFirmataClient()
	const bmp180 = new BMP180(client as never, 0)
	const calibration = Buffer.from([0x01, 0x98, 0xff, 0xb8, 0xc7, 0xd1, 0x7f, 0xe5, 0x7f, 0xf5, 0x5a, 0x71, 0x18, 0x2e, 0x00, 0x04, 0x80, 0x00, 0xdd, 0xf9, 0x0b, 0x34])

	bmp180.start()
	bmp180.twoWireMessage(client as never, BMP180.ADDRESS, 0xaa, calibration)
	bmp180.twoWireMessage(client as never, BMP180.ADDRESS, 0xf6, Buffer.from([0x75, 0x30]))
	bmp180.twoWireMessage(client as never, BMP180.ADDRESS, 0xf6, Buffer.from([0x00, 0x5d, 0x23]))

	expect(bmp180.temperature).toBe(31.3)
	expect(bmp180.altitude).toBe(fromPressure(bmp180.pressure))
	bmp180.stop()
})

test('BMP280 derives altitude from the standard sea-level temperature', () => {
	const client = new MockFirmataClient()
	const bmp280 = new BMP280(client as never, BMP280.ADDRESS, 100)
	const calibration = Buffer.from([0x70, 0x6b, 0x43, 0x67, 0x18, 0xfc, 0x7d, 0x8e, 0x43, 0xd6, 0xd0, 0x0b, 0x27, 0x0b, 0x8c, 0x00, 0xf9, 0xff, 0x8c, 0x3c, 0xf8, 0xc6, 0x70, 0x17])

	bmp280.start()
	bmp280.twoWireMessage(client as never, BMP280.ADDRESS, 0x88, calibration)
	bmp280.twoWireMessage(client as never, BMP280.ADDRESS, 0xf7, Buffer.from([101, 90, 192, 126, 237, 0]))

	expect(bmp280.temperature).toBeCloseTo(25.08, 2)
	expect(bmp280.altitude).toBe(fromPressure(bmp280.pressure))
	bmp280.stop()
})

test('BMP180 recovers when a pressure reply is lost', () => {
	const client = new MockFirmataClient()
	const bmp180 = new BMP180(client as never, 0)
	const calibration = Buffer.alloc(22)

	bmp180.start()
	bmp180.twoWireMessage(client as never, BMP180.ADDRESS, 0xaa, calibration)
	bmp180.twoWireMessage(client as never, BMP180.ADDRESS, 0xf6, Buffer.from([0x6d, 0x60]))
	bmp180.twoWireMessage(client as never, BMP180.ADDRESS, 0xf6, Buffer.from([0x6d, 0x61]))

	const pressureWrites = client.messages.filter((message) => message[0] === 'write' && message[2][1] === BMP180.READ_PRES_CMD)
	expect(pressureWrites).toHaveLength(2)
	bmp180.stop()
})

test('BMP280 compensate temperature & pressure', () => {
	const bmp280 = new BMP280(undefined as never, 0)
	expect(bmp280.compensateTemperature(519888)).toBeCloseTo(25.08, 2)
	expect(bmp280.compensatePressure(415148)).toBeCloseTo(100653.27, 2)
})
