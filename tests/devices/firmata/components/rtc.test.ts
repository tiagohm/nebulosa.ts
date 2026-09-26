import { expect, test } from 'bun:test'
import { DS1307, DS3231 } from '../../../../src/devices/firmata/components/rtc'
import { MockFirmataClient } from '../util'

test('DS3231 configures i2c reads and decodes RTC updates', () => {
	const client = new MockFirmataClient()
	const rtc = new DS3231(client as never, DS3231.ADDRESS, 1000)
	let updates = 0

	rtc.addListener(() => {
		updates++
	})

	rtc.start()

	expect(client.messages).toEqual([
		['config', 0],
		['read', DS3231.ADDRESS, DS3231.TIME_REG, DS3231.TIME_BYTES, false, 7, 'stop'],
	])

	rtc.twoWireMessage(client as never, DS3231.ADDRESS, DS3231.TIME_REG, Buffer.from([0x45, 0x58, 0x23, 0x05, 0x09, 0x04, 0x26]))
	expect(rtc.year).toBe(2026)
	expect(rtc.month).toBe(4)
	expect(rtc.day).toBe(9)
	expect(rtc.hour).toBe(23)
	expect(rtc.minute).toBe(58)
	expect(rtc.second).toBe(45)
	expect(rtc.millisecond).toBe(0)
	expect(updates).toBe(1)

	rtc.twoWireMessage(client as never, DS3231.ADDRESS, DS3231.TIME_REG, Buffer.from([0x45, 0x58, 0x23, 0x05, 0x09, 0x04, 0x26]))
	expect(updates).toBe(1)

	rtc.stop()
	expect(client.handlers.size).toBe(0)
})

test('DS3231 decodes 12-hour frames', () => {
	const client = new MockFirmataClient()
	const rtc = new DS3231(client as never)

	rtc.twoWireMessage(client as never, DS3231.ADDRESS, DS3231.TIME_REG, Buffer.from([0x07, 0x05, 0x69, 0x03, 0x31, 0x12, 0x24]))
	expect(rtc.year).toBe(2024)
	expect(rtc.month).toBe(12)
	expect(rtc.day).toBe(31)
	expect(rtc.dayOfWeek).toBe(2)
	expect(rtc.hour).toBe(21)
	expect(rtc.minute).toBe(5)
	expect(rtc.second).toBe(7)
})

test('DS3231 sync writes staged fields in 24-hour mode', () => {
	const client = new MockFirmataClient()
	const rtc = new DS3231(client as never)
	const date = new Date(2026, 3, 9, 23, 58, 45, 123)

	rtc.sync(date)

	expect(client.messages.slice(0, 2)).toEqual([
		['config', 0],
		['write', DS3231.ADDRESS, Buffer.from([DS3231.TIME_REG, 0x45, 0x58, 0x23, 0x05, 0x09, 0x04, 0x26])],
	])
	expect(rtc.millisecond).toBe(0)
})

test('DS1307 configures i2c reads and decodes RTC updates', () => {
	const client = new MockFirmataClient()
	const rtc = new DS1307(client as never, DS1307.ADDRESS, 1000)
	let updates = 0

	rtc.addListener(() => {
		updates++
	})

	rtc.start()

	expect(client.messages).toEqual([
		['config', 0],
		['read', DS1307.ADDRESS, DS1307.TIME_REG, DS1307.TIME_BYTES, false, 7, 'stop'],
	])

	rtc.twoWireMessage(client as never, DS1307.ADDRESS, DS1307.TIME_REG, Buffer.from([0x45, 0x58, 0x23, 0x05, 0x09, 0x04, 0x26]))
	expect(rtc.year).toBe(2026)
	expect(rtc.month).toBe(4)
	expect(rtc.day).toBe(9)
	expect(rtc.hour).toBe(23)
	expect(rtc.minute).toBe(58)
	expect(rtc.second).toBe(45)
	expect(rtc.millisecond).toBe(0)
	expect(updates).toBe(1)

	rtc.twoWireMessage(client as never, DS1307.ADDRESS, DS1307.TIME_REG, Buffer.from([0x45, 0x58, 0x23, 0x05, 0x09, 0x04, 0x26]))
	expect(updates).toBe(1)

	rtc.stop()
	expect(client.handlers.size).toBe(0)
})

test('DS1307 decodes 12-hour frames', () => {
	const client = new MockFirmataClient()
	const rtc = new DS1307(client as never)

	rtc.twoWireMessage(client as never, DS1307.ADDRESS, DS1307.TIME_REG, Buffer.from([0x07, 0x05, 0x69, 0x03, 0x31, 0x12, 0x24]))
	expect(rtc.year).toBe(2024)
	expect(rtc.month).toBe(12)
	expect(rtc.day).toBe(31)
	expect(rtc.dayOfWeek).toBe(2)
	expect(rtc.hour).toBe(21)
	expect(rtc.minute).toBe(5)
	expect(rtc.second).toBe(7)
})

test('DS1307 sync writes staged fields in 24-hour mode', () => {
	const client = new MockFirmataClient()
	const rtc = new DS1307(client as never)
	const date = new Date(2026, 3, 9, 23, 58, 45, 123)

	rtc.sync(date)

	expect(client.messages.slice(0, 2)).toEqual([
		['config', 0],
		['write', DS1307.ADDRESS, Buffer.from([DS1307.TIME_REG, 0x45, 0x58, 0x23, 0x05, 0x09, 0x04, 0x26])],
	])
	expect(rtc.millisecond).toBe(0)
})
