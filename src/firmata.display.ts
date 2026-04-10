import { type FirmataClient, PinMode } from './firmata'
import { type Display, type IOExpander, PeripheralBase } from './firmata.peripheral'

export type HD44780CharSize = '5x8' | '5x10'

export interface HD44780Options {
	readonly rsPin?: number
	readonly rwPin?: number
	readonly enablePin?: number
	readonly data4Pin?: number
	readonly data5Pin?: number
	readonly data6Pin?: number
	readonly data7Pin?: number
	readonly backlightPin?: number
	readonly backlight?: boolean
	readonly backlightPolarity?: boolean
}

export const DEFAULT_HD44780_OPTIONS: Required<HD44780Options> = {
	rsPin: 0,
	rwPin: 1,
	enablePin: 2,
	backlightPin: 3,
	data4Pin: 4,
	data5Pin: 5,
	data6Pin: 6,
	data7Pin: 7,
	backlight: true,
	backlightPolarity: true,
}

// Converts one normalized expander pin into a byte mask.
function pinMask(pin: number | undefined) {
	return pin === undefined ? 0 : 1 << pin
}

// https://cdn.sparkfun.com/assets/9/5/f/7/b/HD44780.pdf
// https://github.com/arduino-libraries/LiquidCrystal/blob/master/src/LiquidCrystal.cpp

export class HD44780 extends PeripheralBase<HD44780> implements Display {
	static readonly CLEAR_DISPLAY = 0x01
	static readonly RETURN_HOME = 0x02
	static readonly ENTRY_MODE_SET = 0x04
	static readonly DISPLAY_CONTROL = 0x08
	static readonly CURSOR_SHIFT = 0x10
	static readonly FUNCTION_SET = 0x20
	static readonly SET_CGRAM_ADDR = 0x40
	static readonly SET_DDRAM_ADDR = 0x80

	static readonly ENTRY_RIGHT = 0x00
	static readonly ENTRY_LEFT = 0x02
	static readonly ENTRY_SHIFT_INCREMENT = 0x01
	static readonly ENTRY_SHIFT_DECREMENT = 0x00

	static readonly DISPLAY_ON = 0x04
	static readonly DISPLAY_OFF = 0x00
	static readonly CURSOR_ON = 0x02
	static readonly CURSOR_OFF = 0x00
	static readonly BLINK_ON = 0x01
	static readonly BLINK_OFF = 0x00

	static readonly DISPLAY_MOVE = 0x08
	static readonly CURSOR_MOVE = 0x00
	static readonly MOVE_RIGHT = 0x04
	static readonly MOVE_LEFT = 0x00

	static readonly EIGHT_BIT_MODE = 0x10
	static readonly FOUR_BIT_MODE = 0x00
	static readonly TWO_LINE = 0x08
	static readonly ONE_LINE = 0x00
	static readonly FIVE_BY_TEN_DOTS = 0x04
	static readonly FIVE_BY_EIGHT_DOTS = 0x00

	#columns = 0
	#rows = 0
	#rowOffsets = [0x00, 0x40, 0x00, 0x40]
	#displayFunction = HD44780.FOUR_BIT_MODE | HD44780.ONE_LINE | HD44780.FIVE_BY_EIGHT_DOTS
	#displayControl = HD44780.DISPLAY_ON | HD44780.CURSOR_OFF | HD44780.BLINK_OFF
	#displayMode = HD44780.ENTRY_LEFT | HD44780.ENTRY_SHIFT_DECREMENT
	#portState = -1
	#configured = false
	#begun = false
	#backlightEnabled: boolean

	readonly name = 'HD44780'
	readonly #rsMask: number
	readonly #rwMask: number
	readonly #enableMask: number
	readonly #dataMasks: readonly [number, number, number, number]
	readonly #backlightMask: number
	readonly #controlPins: readonly number[]
	readonly #backlightPolarity: boolean

	constructor(
		readonly expander: IOExpander,
		options: HD44780Options = DEFAULT_HD44780_OPTIONS,
		readonly client: FirmataClient = expander.client,
	) {
		super()

		const rsPin = options.rsPin ?? DEFAULT_HD44780_OPTIONS.rsPin
		const enablePin = options.enablePin ?? DEFAULT_HD44780_OPTIONS.enablePin
		const data4Pin = options.data4Pin ?? DEFAULT_HD44780_OPTIONS.data4Pin
		const data5Pin = options.data5Pin ?? DEFAULT_HD44780_OPTIONS.data5Pin
		const data6Pin = options.data6Pin ?? DEFAULT_HD44780_OPTIONS.data6Pin
		const data7Pin = options.data7Pin ?? DEFAULT_HD44780_OPTIONS.data7Pin
		const { rwPin, backlightPin } = options
		const requiredPins = [rsPin, enablePin, data4Pin, data5Pin, data6Pin, data7Pin]

		const pins = [...requiredPins]

		if (rwPin !== undefined) pins.push(rwPin)
		if (backlightPin !== undefined) pins.push(backlightPin)

		this.#rsMask = pinMask(rsPin)
		this.#rwMask = pinMask(rwPin)
		this.#enableMask = pinMask(enablePin)
		this.#dataMasks = [pinMask(data4Pin), pinMask(data5Pin), pinMask(data6Pin), pinMask(data7Pin)] as const
		this.#backlightMask = pinMask(backlightPin)
		this.#controlPins = pins
		this.#backlightEnabled = options.backlight ?? DEFAULT_HD44780_OPTIONS.backlight
		this.#backlightPolarity = options.backlightPolarity ?? DEFAULT_HD44780_OPTIONS.backlightPolarity
	}

	start() {
		this.expander.start()
	}

	stop() {
		this.expander.stop()
	}

	// Initializes the LCD in 4-bit mode using the LiquidCrystal power-on sequence.
	begin(columns: number, rows: number, charsize: HD44780CharSize = '5x8') {
		this.#columns = this.#normalizeDimension(columns, 'columns')
		this.#rows = this.#normalizeRows(rows)
		this.#rowOffsets[0] = 0x00
		this.#rowOffsets[1] = 0x40
		this.#rowOffsets[2] = this.#columns
		this.#rowOffsets[3] = 0x40 + this.#columns
		this.#displayFunction = HD44780.FOUR_BIT_MODE | (this.#rows > 1 ? HD44780.TWO_LINE : HD44780.ONE_LINE) | (this.#rows === 1 && charsize === '5x10' ? HD44780.FIVE_BY_TEN_DOTS : HD44780.FIVE_BY_EIGHT_DOTS)
		this.#displayControl = HD44780.DISPLAY_ON | HD44780.CURSOR_OFF | HD44780.BLINK_OFF
		this.#displayMode = HD44780.ENTRY_LEFT | HD44780.ENTRY_SHIFT_DECREMENT

		this.#configurePins()
		this.#writePort(this.#backlightPortBit())
		this.start()

		Bun.sleepSync(50)
		this.#write4Bits(0x03, false)
		Bun.sleepSync(5)
		this.#write4Bits(0x03, false)
		Bun.sleepSync(5)
		this.#write4Bits(0x03, false)
		Bun.sleepSync(1)
		this.#write4Bits(0x02, false)
		Bun.sleepSync(1)

		this.#command(HD44780.FUNCTION_SET | this.#displayFunction)
		this.#command(HD44780.DISPLAY_CONTROL | this.#displayControl)
		this.#command(HD44780.CLEAR_DISPLAY)
		this.#command(HD44780.ENTRY_MODE_SET | this.#displayMode)

		this.#begun = true
	}

	// Clears the display and returns the cursor to the home position.
	clear() {
		this.#ensureBegun()
		this.#command(HD44780.CLEAR_DISPLAY)
	}

	// Returns the cursor and any display shift to the home position.
	home() {
		this.#ensureBegun()
		this.#command(HD44780.RETURN_HOME)
	}

	// Moves the DDRAM cursor to the requested column and row.
	setCursor(column: number, row: number) {
		this.#ensureBegun()

		const normalizedColumn = this.#normalizeCursor(column, 'column')
		const normalizedRow = Math.min(this.#normalizeCursor(row, 'row'), this.#rows - 1)

		this.#command(HD44780.SET_DDRAM_ADDR | (normalizedColumn + this.#rowOffsets[normalizedRow]))
	}

	// Turns off the backpack-controlled backlight output.
	noBacklight() {
		if (!this.#backlightEnabled) return
		this.#backlightEnabled = false
		this.#syncBacklight()
	}

	// Turns on the backpack-controlled backlight output.
	backlight() {
		if (this.#backlightEnabled) return
		this.#backlightEnabled = true
		this.#syncBacklight()
	}

	// Turns off the display without clearing DDRAM contents.
	noDisplay() {
		this.#ensureBegun()
		this.#displayControl &= ~HD44780.DISPLAY_ON
		this.#command(HD44780.DISPLAY_CONTROL | this.#displayControl)
	}

	// Turns on the display using the current cursor and blink flags.
	display() {
		this.#ensureBegun()
		this.#displayControl |= HD44780.DISPLAY_ON
		this.#command(HD44780.DISPLAY_CONTROL | this.#displayControl)
	}

	// Disables the blinking block cursor.
	noBlink() {
		this.#ensureBegun()
		this.#displayControl &= ~HD44780.BLINK_ON
		this.#command(HD44780.DISPLAY_CONTROL | this.#displayControl)
	}

	// Enables the blinking block cursor.
	blink() {
		this.#ensureBegun()
		this.#displayControl |= HD44780.BLINK_ON
		this.#command(HD44780.DISPLAY_CONTROL | this.#displayControl)
	}

	// Hides the underline cursor.
	noCursor() {
		this.#ensureBegun()
		this.#displayControl &= ~HD44780.CURSOR_ON
		this.#command(HD44780.DISPLAY_CONTROL | this.#displayControl)
	}

	// Shows the underline cursor.
	cursor() {
		this.#ensureBegun()
		this.#displayControl |= HD44780.CURSOR_ON
		this.#command(HD44780.DISPLAY_CONTROL | this.#displayControl)
	}

	// Shifts the visible display window one column to the left.
	scrollDisplayLeft() {
		this.#ensureBegun()
		this.#command(HD44780.CURSOR_SHIFT | HD44780.DISPLAY_MOVE | HD44780.MOVE_LEFT)
	}

	// Shifts the visible display window one column to the right.
	scrollDisplayRight() {
		this.#ensureBegun()
		this.#command(HD44780.CURSOR_SHIFT | HD44780.DISPLAY_MOVE | HD44780.MOVE_RIGHT)
	}

	// Sets text flow from left to right after each printed character.
	leftToRight() {
		this.#ensureBegun()
		this.#displayMode |= HD44780.ENTRY_LEFT
		this.#command(HD44780.ENTRY_MODE_SET | this.#displayMode)
	}

	// Sets text flow from right to left after each printed character.
	rightToLeft() {
		this.#ensureBegun()
		this.#displayMode &= ~HD44780.ENTRY_LEFT
		this.#command(HD44780.ENTRY_MODE_SET | this.#displayMode)
	}

	// Enables automatic display shifts after each printed character.
	autoscroll() {
		this.#ensureBegun()
		this.#displayMode |= HD44780.ENTRY_SHIFT_INCREMENT
		this.#command(HD44780.ENTRY_MODE_SET | this.#displayMode)
	}

	// Disables automatic display shifts after each printed character.
	noAutoscroll() {
		this.#ensureBegun()
		this.#displayMode &= ~HD44780.ENTRY_SHIFT_INCREMENT
		this.#command(HD44780.ENTRY_MODE_SET | this.#displayMode)
	}

	// Create a custom character (glyph) for use on the LCD.
	// Up to eight characters of 5x8 pixels are supported (numbered 0 to 7).
	// The appearance of each custom character is specified by an array of eight bytes, one for each row.
	// The five least significant bits of each byte determine the pixels in that row.
	// To display a custom character on the screen, call "write" with its number.
	createChar(location: number, charmap: ArrayLike<number>) {
		this.#ensureBegun()

		const normalizedLocation = Math.trunc(location) & 0x07
		this.#command(HD44780.SET_CGRAM_ADDR | (normalizedLocation << 3))

		for (let i = 0; i < 8; i++) {
			this.#send((charmap[i] ?? 0) & 0x1f, true)
		}
	}

	// Writes raw character data.
	write(value: number) {
		this.#ensureBegun()
		this.#send(Math.trunc(value) & 0xff, true)
		return 1
	}

	// Writes one printable value using the controller character generator.
	print(value: string | number | boolean | bigint) {
		this.#ensureBegun()

		const text = typeof value === 'string' ? value : String(value)

		for (let i = 0; i < text.length; i++) {
			// Masks to 8 bits because the HD44780 consumes one byte per character cell.
			this.#send(text.charCodeAt(i) & 0xff, true)
		}

		return text.length
	}

	// Configures every used backpack pin as an output once.
	#configurePins() {
		if (this.#configured) return
		for (const pin of this.#controlPins) this.expander.pinMode(pin, PinMode.OUTPUT)
		this.#configured = true
	}

	// Sends one controller command and honors the slow clear/home execution time.
	#command(value: number) {
		this.#send(value, false)
		if (value === HD44780.CLEAR_DISPLAY || value === HD44780.RETURN_HOME) Bun.sleepSync(2)
	}

	// Sends one data or command byte in two 4-bit transfers.
	#send(value: number, registerSelect: boolean) {
		this.#write4Bits(value >>> 4, registerSelect)
		this.#write4Bits(value, registerSelect)
	}

	// Places one nibble on the bus and toggles the enable line.
	#write4Bits(value: number, registerSelect: boolean) {
		let port = this.#backlightPortBit()

		if (registerSelect) port |= this.#rsMask
		if ((value & 0x01) !== 0) port |= this.#dataMasks[0]
		if ((value & 0x02) !== 0) port |= this.#dataMasks[1]
		if ((value & 0x04) !== 0) port |= this.#dataMasks[2]
		if ((value & 0x08) !== 0) port |= this.#dataMasks[3]

		this.#pulseEnable(port)
	}

	// Generates the falling-edge enable pulse required to latch one nibble.
	#pulseEnable(port: number) {
		const value = port & ~this.#enableMask & ~this.#rwMask

		this.#writePort(value)
		this.#writePort(value | this.#enableMask)
		this.#writePort(value)
	}

	// Writes one full 8-bit expander state using the fastest supported path.
	#writePort(value: number) {
		const nextPortState = value & 0xff

		if (nextPortState === this.#portState) return

		this.#portState = nextPortState

		this.expander.pinWrite(0, (nextPortState & 0x01) !== 0, false)
		this.expander.pinWrite(1, (nextPortState & 0x02) !== 0, false)
		this.expander.pinWrite(2, (nextPortState & 0x04) !== 0, false)
		this.expander.pinWrite(3, (nextPortState & 0x08) !== 0, false)
		this.expander.pinWrite(4, (nextPortState & 0x10) !== 0, false)
		this.expander.pinWrite(5, (nextPortState & 0x20) !== 0, false)
		this.expander.pinWrite(6, (nextPortState & 0x40) !== 0, false)
		this.expander.pinWrite(7, (nextPortState & 0x80) !== 0, false)
		this.expander.flush()
	}

	// Computes the port bit that keeps the backlight in the requested state.
	#backlightPortBit() {
		if (this.#backlightMask === 0) return 0
		return this.#backlightEnabled === this.#backlightPolarity ? this.#backlightMask : 0
	}

	// Applies the current backlight state to the last staged expander byte.
	#syncBacklight() {
		if (this.#backlightMask === 0 || this.#portState < 0) return
		this.#writePort((this.#portState & ~this.#backlightMask) | this.#backlightPortBit())
	}

	// Validates a positive LCD dimension.
	#normalizeDimension(value: number, name: string) {
		const normalizedValue = Math.trunc(value)
		if (normalizedValue <= 0) throw new RangeError(`HD44780 ${name} must be greater than zero. Received ${value}.`)
		return normalizedValue
	}

	// Validates the supported line count for standard HD44780 DDRAM layouts.
	#normalizeRows(value: number) {
		const normalizedValue = this.#normalizeDimension(value, 'rows')
		if (normalizedValue > 4) throw new RangeError(`HD44780 rows must be between 1 and 4. Received ${value}.`)
		return normalizedValue
	}

	// Validates one non-negative cursor coordinate.
	#normalizeCursor(value: number, name: string) {
		const normalizedValue = Math.trunc(value)
		if (normalizedValue < 0) throw new RangeError(`HD44780 ${name} must be zero or greater. Received ${value}.`)
		return normalizedValue
	}

	// Throws when the display has not been initialized yet.
	#ensureBegun() {
		if (!this.#begun) throw new Error('HD44780 has not been initialized. Call begin() first.')
	}
}
