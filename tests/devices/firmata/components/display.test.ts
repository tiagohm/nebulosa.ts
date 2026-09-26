import { expect, test } from 'bun:test'
import { HD44780 } from '../../../../src/devices/firmata/components/display'
import { PCF8574 } from '../../../../src/devices/firmata/components/io'
import { MockFirmataClient, type MockFirmataMessage } from '../util'

test('HD44780 initializes a 16x2 display through the PCF8574 backpack mapping', () => {
	const client = new MockFirmataClient()
	using expander = new PCF8574(client as never, PCF8574.ADDRESS, 0)
	const lcd = new HD44780(expander)
	const writes: number[] = []

	lcd.begin(16, 2)

	for (const message of client.messages) {
		if (message[0] === 'write') writes.push(message[2][0])
	}

	expect(client.messages[0]).toEqual(['config', 0])
	expect(writes).toEqual([0x08, 0x38, 0x3c, 0x38, 0x3c, 0x38, 0x3c, 0x38, 0x28, 0x2c, 0x28, 0x2c, 0x28, 0x88, 0x8c, 0x88, 0x08, 0x0c, 0x08, 0xc8, 0xcc, 0xc8, 0x08, 0x0c, 0x08, 0x18, 0x1c, 0x18, 0x08, 0x0c, 0x08, 0x68, 0x6c, 0x68])
	expect(client.messages.filter((message) => message[0] === 'read')).toHaveLength(writes.length)
})

test('HD44780 inherits the default backlight pin for partial options', () => {
	const client = new MockFirmataClient()
	using expander = new PCF8574(client as never, PCF8574.ADDRESS, 0)
	const lcd = new HD44780(expander, { backlight: true })
	const writes: number[] = []

	lcd.begin(16, 2)

	for (const message of client.messages) {
		if (message[0] === 'write') writes.push(message[2][0])
	}

	expect(writes[0]).toBe(0x08)

	client.messages.length = 0
	lcd.noBacklight()
	lcd.backlight()

	writes.length = 0
	for (const message of client.messages) {
		if (message[0] === 'write') writes.push(message[2][0])
	}

	expect(writes).toEqual([0x60, 0x68])
})

test('HD44780 sets the cursor and prints text through the expander', () => {
	const client = new MockFirmataClient()
	using expander = new PCF8574(client as never, PCF8574.ADDRESS, 1000)
	const lcd = new HD44780(expander)
	const writes: Buffer[] = []

	lcd.begin(16, 2)
	client.messages.length = 0

	lcd.setCursor(3, 1)
	expect(lcd.print('Hi')).toBe(2)

	for (const message of client.messages) {
		if (message[0] === 'write') writes.push(message[2])
	}

	expect(writes).toEqual([
		Buffer.from([0xc8]),
		Buffer.from([0xcc]),
		Buffer.from([0xc8]),
		Buffer.from([0x38]),
		Buffer.from([0x3c]),
		Buffer.from([0x38]),
		Buffer.from([0x49]),
		Buffer.from([0x4d]),
		Buffer.from([0x49]),
		Buffer.from([0x89]),
		Buffer.from([0x8d]),
		Buffer.from([0x89]),
		Buffer.from([0x69]),
		Buffer.from([0x6d]),
		Buffer.from([0x69]),
		Buffer.from([0x99]),
		Buffer.from([0x9d]),
		Buffer.from([0x99]),
	])
	expect(client.messages.filter((message) => message[0] === 'read')).toHaveLength(writes.length)
})

test('HD44780 toggles the backpack backlight without sending LCD commands', () => {
	const client = new MockFirmataClient()
	using expander = new PCF8574(client as never, PCF8574.ADDRESS, 0)
	const lcd = new HD44780(expander)
	const writes: number[] = []

	lcd.begin(16, 2)
	client.messages.length = 0

	lcd.noBacklight()
	lcd.noBacklight()
	lcd.backlight()
	lcd.backlight()

	for (const message of client.messages) {
		if (message[0] === 'write') writes.push(message[2][0])
	}

	expect(writes).toEqual([0x60, 0x68])
	expect(decodeHD44780Transfers(client.messages)).toEqual([])
})

test('HD44780 exposes the remaining LiquidCrystal control commands', () => {
	const client = new MockFirmataClient()
	using expander = new PCF8574(client as never, PCF8574.ADDRESS, 0)
	const lcd = new HD44780(expander)

	lcd.begin(16, 2)
	client.messages.length = 0

	lcd.clear()
	lcd.home()
	lcd.noDisplay()
	lcd.display()
	lcd.blink()
	lcd.noBlink()
	lcd.cursor()
	lcd.noCursor()
	lcd.rightToLeft()
	lcd.leftToRight()
	lcd.autoscroll()
	lcd.noAutoscroll()
	lcd.scrollDisplayLeft()
	lcd.scrollDisplayRight()

	expect(decodeHD44780Transfers(client.messages)).toEqual([
		{ registerSelect: false, value: HD44780.CLEAR_DISPLAY },
		{ registerSelect: false, value: HD44780.RETURN_HOME },
		{ registerSelect: false, value: HD44780.DISPLAY_CONTROL | HD44780.DISPLAY_OFF | HD44780.CURSOR_OFF | HD44780.BLINK_OFF },
		{ registerSelect: false, value: HD44780.DISPLAY_CONTROL | HD44780.DISPLAY_ON | HD44780.CURSOR_OFF | HD44780.BLINK_OFF },
		{ registerSelect: false, value: HD44780.DISPLAY_CONTROL | HD44780.DISPLAY_ON | HD44780.CURSOR_OFF | HD44780.BLINK_ON },
		{ registerSelect: false, value: HD44780.DISPLAY_CONTROL | HD44780.DISPLAY_ON | HD44780.CURSOR_OFF | HD44780.BLINK_OFF },
		{ registerSelect: false, value: HD44780.DISPLAY_CONTROL | HD44780.DISPLAY_ON | HD44780.CURSOR_ON | HD44780.BLINK_OFF },
		{ registerSelect: false, value: HD44780.DISPLAY_CONTROL | HD44780.DISPLAY_ON | HD44780.CURSOR_OFF | HD44780.BLINK_OFF },
		{ registerSelect: false, value: HD44780.ENTRY_MODE_SET | HD44780.ENTRY_RIGHT | HD44780.ENTRY_SHIFT_DECREMENT },
		{ registerSelect: false, value: HD44780.ENTRY_MODE_SET | HD44780.ENTRY_LEFT | HD44780.ENTRY_SHIFT_DECREMENT },
		{ registerSelect: false, value: HD44780.ENTRY_MODE_SET | HD44780.ENTRY_LEFT | HD44780.ENTRY_SHIFT_INCREMENT },
		{ registerSelect: false, value: HD44780.ENTRY_MODE_SET | HD44780.ENTRY_LEFT | HD44780.ENTRY_SHIFT_DECREMENT },
		{ registerSelect: false, value: HD44780.CURSOR_SHIFT | HD44780.DISPLAY_MOVE | HD44780.MOVE_LEFT },
		{ registerSelect: false, value: HD44780.CURSOR_SHIFT | HD44780.DISPLAY_MOVE | HD44780.MOVE_RIGHT },
	])
})

test('HD44780 creates custom glyphs and supports raw writes', () => {
	const client = new MockFirmataClient()
	using expander = new PCF8574(client as never, PCF8574.ADDRESS, 0)
	const lcd = new HD44780(expander)

	lcd.begin(16, 2)
	client.messages.length = 0

	lcd.createChar(1, Uint8Array.from([0, 1, 2, 3, 4, 5, 6, 7]))
	expect(lcd.write(0)).toBe(1)
	expect(lcd.print('A')).toBe(1)
	expect(lcd.print(12)).toBe(2)

	expect(decodeHD44780Transfers(client.messages)).toEqual([
		{ registerSelect: false, value: HD44780.SET_CGRAM_ADDR | 0x08 },
		{ registerSelect: true, value: 0x00 },
		{ registerSelect: true, value: 0x01 },
		{ registerSelect: true, value: 0x02 },
		{ registerSelect: true, value: 0x03 },
		{ registerSelect: true, value: 0x04 },
		{ registerSelect: true, value: 0x05 },
		{ registerSelect: true, value: 0x06 },
		{ registerSelect: true, value: 0x07 },
		{ registerSelect: true, value: 0x00 },
		{ registerSelect: true, value: 0x41 },
		{ registerSelect: true, value: 0x31 },
		{ registerSelect: true, value: 0x32 },
	])
})

interface DecodedHD44780Transfer {
	readonly registerSelect: boolean
	readonly value: number
}

// Rebuilds HD44780 bytes from the expander writes by observing enable-high pulses.
function decodeHD44780Transfers(messages: readonly MockFirmataMessage[]) {
	const nibbles: DecodedHD44780Transfer[] = []

	for (const message of messages) {
		if (message[0] !== 'write') continue

		const port = message[2][0]
		if ((port & 0x04) === 0) continue

		nibbles.push({
			registerSelect: (port & 0x01) !== 0,
			value: ((port & 0x10) !== 0 ? 1 : 0) | ((port & 0x20) !== 0 ? 2 : 0) | ((port & 0x40) !== 0 ? 4 : 0) | ((port & 0x80) !== 0 ? 8 : 0),
		})
	}

	const transfers: DecodedHD44780Transfer[] = []

	for (let i = 0; i < nibbles.length; i += 2) {
		const high = nibbles[i]
		const low = nibbles[i + 1]

		if (high === undefined || low === undefined || high.registerSelect !== low.registerSelect) {
			throw new Error('Invalid HD44780 nibble sequence.')
		}

		transfers.push({
			registerSelect: high.registerSelect,
			value: (high.value << 4) | low.value,
		})
	}

	return transfers
}
