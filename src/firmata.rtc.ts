import type { FirmataClient } from './firmata'
import { PeripheralBase, type RealTimeClock } from './firmata.peripheral'

// https://www.analog.com/media/en/technical-documentation/data-sheets/ds3231.pdf

export class DS3231 extends PeripheralBase<DS3231> implements RealTimeClock {
	year = 0
	month = 0
	day = 0
	dayOfWeek = 0
	hour = 0
	minute = 0
	second = 0
	millisecond = 0

	static readonly ADDRESS = 0x68
	static readonly TIME_REG = 0x00
	static readonly TIME_BYTES = 7
	static readonly HOUR_12_MODE_MASK = 0x40
	static readonly HOUR_PM_MASK = 0x20
	static readonly CENTURY_MASK = 0x80

	#timer?: NodeJS.Timeout

	readonly name = 'DS3231'

	constructor(
		readonly client: FirmataClient,
		readonly address: number = DS3231.ADDRESS,
		readonly pollingInterval: number = 1000,
	) {
		super()
	}

	// Starts periodic reads of the RTC calendar registers.
	start() {
		if (this.#timer !== undefined) return
		this.client.addHandler(this)
		this.client.twoWireConfig(0)
		this.#readTime()
		this.#timer = setInterval(this.#readTime.bind(this), Math.max(1, this.pollingInterval))
	}

	// Stops polling and detaches the Firmata handler.
	stop() {
		this.client.removeHandler(this)
		clearInterval(this.#timer)
		this.#timer = undefined
	}

	// Decodes one RTC register frame into the public calendar fields.
	twoWireMessage(client: FirmataClient, address: number, register: number, data: Buffer) {
		if (client !== this.client || address !== this.address || register !== DS3231.TIME_REG || data.byteLength < DS3231.TIME_BYTES) return

		const second = decodeBCD(data[0] & 0x7f)
		const minute = decodeBCD(data[1] & 0x7f)
		const hour = this.#decodeHour(data[2])
		const dayOfWeek = (data[3] & 0x07) - 1
		const day = decodeBCD(data[4] & 0x3f)
		const month = decodeBCD(data[5] & 0x1f)
		const year = 2000 + ((data[5] & DS3231.CENTURY_MASK) !== 0 ? 100 : 0) + decodeBCD(data[6])

		if (this.year !== year || this.month !== month || this.day !== day || this.dayOfWeek !== dayOfWeek || this.hour !== hour || this.minute !== minute || this.second !== second) {
			this.year = year
			this.month = month
			this.day = day
			this.dayOfWeek = dayOfWeek
			this.hour = hour
			this.minute = minute
			this.second = second

			this.fire()
		}
	}

	// Writes the date and time.
	update(year: number = this.year, month: number = this.month, day: number = this.day, dayOfWeek: number = this.dayOfWeek, hour: number = this.hour, minute: number = this.minute, second: number = this.second, millisecond: number = this.millisecond) {
		this.client.twoWireConfig(0)
		this.client.twoWireWrite(this.address, [DS3231.TIME_REG, encodeBCD(second), encodeBCD(minute), encodeBCD(hour), dayOfWeek + 1, encodeBCD(day), encodeBCD(month) | (year >= 2100 ? DS3231.CENTURY_MASK : 0), encodeBCD(year % 100)])
		this.#readTime()
	}

	// Writes the date and time, or the host clock if unset, in 24-hour format.
	sync(date: Date = new Date()) {
		this.update(date.getFullYear(), date.getMonth() + 1, date.getDate(), date.getDay(), date.getHours(), date.getMinutes(), date.getSeconds(), date.getMilliseconds())
	}

	// Requests one clock-register frame from the RTC.
	#readTime() {
		this.client.twoWireRead(this.address, DS3231.TIME_REG, DS3231.TIME_BYTES)
	}

	// Decodes the hour register in either 12-hour or 24-hour mode.
	#decodeHour(value: number) {
		if ((value & DS3231.HOUR_12_MODE_MASK) === 0) return decodeBCD(value & 0x3f)
		const hour = decodeBCD(value & 0x1f) % 12
		return hour + ((value & DS3231.HOUR_PM_MASK) !== 0 ? 12 : 0)
	}
}

// https://www.analog.com/media/en/technical-documentation/data-sheets/ds1307.pdf

export class DS1307 extends PeripheralBase<DS1307> implements RealTimeClock {
	year = 0
	month = 0
	day = 0
	dayOfWeek = 0
	hour = 0
	minute = 0
	second = 0
	millisecond = 0

	static readonly ADDRESS = 0x68
	static readonly TIME_REG = 0x00
	static readonly TIME_BYTES = 7
	static readonly HOUR_12_MODE_MASK = 0x40
	static readonly HOUR_PM_MASK = 0x20

	#timer?: NodeJS.Timeout

	readonly name = 'DS1307'

	constructor(
		readonly client: FirmataClient,
		readonly address: number = DS1307.ADDRESS,
		readonly pollingInterval: number = 1000,
	) {
		super()
	}

	// Starts periodic reads of the RTC calendar registers.
	start() {
		if (this.#timer !== undefined) return
		this.client.addHandler(this)
		this.client.twoWireConfig(0)
		this.#readTime()
		this.#timer = setInterval(this.#readTime.bind(this), Math.max(1, this.pollingInterval))
	}

	// Stops polling and detaches the Firmata handler.
	stop() {
		this.client.removeHandler(this)
		clearInterval(this.#timer)
		this.#timer = undefined
	}

	// Decodes one RTC register frame into the public calendar fields.
	twoWireMessage(client: FirmataClient, address: number, register: number, data: Buffer) {
		if (client !== this.client || address !== this.address || register !== DS1307.TIME_REG || data.byteLength < DS1307.TIME_BYTES) return

		const second = decodeBCD(data[0] & 0x7f)
		const minute = decodeBCD(data[1] & 0x7f)
		const hour = this.#decodeHour(data[2])
		const dayOfWeek = (data[3] & 0x07) - 1
		const day = decodeBCD(data[4] & 0x3f)
		const month = decodeBCD(data[5] & 0x1f)
		const year = 2000 + decodeBCD(data[6])

		if (this.year !== year || this.month !== month || this.day !== day || this.dayOfWeek !== dayOfWeek || this.hour !== hour || this.minute !== minute || this.second !== second) {
			this.year = year
			this.month = month
			this.day = day
			this.dayOfWeek = dayOfWeek
			this.hour = hour
			this.minute = minute
			this.second = second

			this.fire()
		}
	}

	// Writes the date and time.
	update(year: number = this.year, month: number = this.month, day: number = this.day, dayOfWeek: number = this.dayOfWeek, hour: number = this.hour, minute: number = this.minute, second: number = this.second, millisecond: number = this.millisecond) {
		this.client.twoWireConfig(0)
		this.client.twoWireWrite(this.address, [DS1307.TIME_REG, encodeBCD(second), encodeBCD(minute), encodeBCD(hour), dayOfWeek + 1, encodeBCD(day), encodeBCD(month), encodeBCD(year % 100)])
		this.#readTime()
	}

	// Writes the date and time, or the host clock if unset, in 24-hour format.
	sync(date: Date = new Date()) {
		this.update(date.getFullYear(), date.getMonth() + 1, date.getDate(), date.getDay(), date.getHours(), date.getMinutes(), date.getSeconds(), date.getMilliseconds())
	}

	// Requests one clock-register frame from the RTC.
	#readTime() {
		this.client.twoWireRead(this.address, DS1307.TIME_REG, DS1307.TIME_BYTES)
	}

	// Decodes the hour register in either 12-hour or 24-hour mode.
	#decodeHour(value: number) {
		if ((value & DS1307.HOUR_12_MODE_MASK) === 0) return decodeBCD(value & 0x3f)
		const hour = decodeBCD(value & 0x1f) % 12
		return hour + ((value & DS1307.HOUR_PM_MASK) !== 0 ? 12 : 0)
	}
}

// Decodes one packed BCD byte into an integer.
function decodeBCD(value: number) {
	return (value >>> 4) * 10 + (value & 0x0f)
}

// Encodes one integer into packed BCD.
function encodeBCD(value: number) {
	const tens = Math.trunc(value / 10)
	return (tens << 4) | (value % 10)
}
