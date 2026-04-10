import { type FirmataClient, PinMode } from './firmata'
import { DEFAULT_POLLING_INTERVAL, type IOExpander, PeripheralBase } from './firmata.peripheral'
import { clamp } from './math'

export interface PCF8574Options {
	readonly output?: number
	readonly inputMask?: number
}

export const DEFAULT_PCF8574_OPTIONS: Required<PCF8574Options> = {
	output: 0xff,
	inputMask: 0xff,
}

// https://www.ti.com/lit/ds/symlink/pcf8574.pdf

export class PCF8574 extends PeripheralBase<PCF8574> implements IOExpander {
	static readonly ADDRESS = 0x20
	static readonly MIN_ADDRESS = 0x20
	static readonly MAX_ADDRESS = 0x27
	static readonly ALTERNATIVE_MIN_ADDRESS = 0x38
	static readonly ALTERNATIVE_MAX_ADDRESS = 0x3f
	static readonly PORT_MASK = 0xff
	static readonly PIN_COUNT = 8

	#state: number
	#output: number
	#inputMask: number
	#started = false
	#timer?: NodeJS.Timeout

	readonly name = 'PCF8574'

	constructor(
		readonly client: FirmataClient,
		readonly address: number = PCF8574.ADDRESS,
		readonly pollingInterval: number = DEFAULT_POLLING_INTERVAL,
		options: PCF8574Options = DEFAULT_PCF8574_OPTIONS,
	) {
		super()
		this.#output = this.#normalizeByte(options.output ?? DEFAULT_PCF8574_OPTIONS.output)
		this.#inputMask = this.#normalizeByte(options.inputMask ?? DEFAULT_PCF8574_OPTIONS.inputMask)
		this.#state = this.#effectiveState()
	}

	// Enables I2C, writes the staged port byte, and starts polling the expander.
	start() {
		if (this.#started) return

		this.#started = true
		this.client.addHandler(this)
		this.client.twoWireConfig(0)
		this.flush()

		if (this.pollingInterval > 0) {
			this.#timer = setInterval(this.#requestState.bind(this), Math.max(1, this.pollingInterval))
		}
	}

	// Stops polling and detaches the Firmata handler.
	stop() {
		if (!this.#started) return

		this.#started = false
		this.client.removeHandler(this)
		clearInterval(this.#timer)
		this.#timer = undefined
	}

	// Changes one expander pin between input and output semantics.
	pinMode(pin: number, mode: PinMode) {
		const mask = this.#pinMask(pin)
		const value = mode === PinMode.INPUT ? this.#inputMask | mask : this.#inputMask & ~mask
		const nextInputMask = this.#normalizeByte(value)
		if (nextInputMask === this.#inputMask) return
		this.#inputMask = nextInputMask
		this.flush()
	}

	// Stages one output bit and implicitly switches the selected pin to output mode.
	pinWrite(pin: number, value: boolean | number, flush: boolean = true) {
		const mask = this.#pinMask(pin)
		const nextOutput = value ? this.#output | mask : this.#output & ~mask
		const nextInputMask = this.#inputMask & ~mask

		if (nextOutput === this.#output && nextInputMask === this.#inputMask) return

		this.#output = nextOutput
		this.#inputMask = nextInputMask

		if (flush) {
			this.flush()
		}
	}

	// Returns the cached logic level of one pin from the latest port snapshot.
	pinRead(pin: number) {
		return ((this.#state >>> this.#normalizePin(pin)) & 1) !== 0
	}

	// Writes the current pin state and requests a new one.
	flush() {
		if (this.#started) {
			this.#writeState()
			this.#requestState()
		}
	}

	// Requests one fresh 8-bit port snapshot from the expander.
	refresh() {
		this.#ensureStarted()
		this.#requestState()
	}

	// Decodes one registerless one-byte port reply from the expander.
	twoWireMessage(client: FirmataClient, address: number, _register: number, data: Buffer) {
		if (client !== this.client || address !== this.address || data.byteLength === 0) return

		const nextState = data[0] & PCF8574.PORT_MASK

		if (nextState === this.#state) return

		this.#state = nextState
		this.fire()
	}

	// Requests one raw port byte using the Firmata no-register I2C read mode.
	#requestState() {
		if (!this.#started) return
		this.client.twoWireRead(this.address, -1, 1)
	}

	// Writes the staged port byte while keeping input pins released high.
	#writeState() {
		this.client.twoWireWrite(this.address, [this.#effectiveState()])
	}

	// Merges the staged output bits with the input release mask.
	#effectiveState() {
		return (this.#output & ~this.#inputMask) | this.#inputMask
	}

	// Clamps one numeric port value to the supported 8-bit range.
	#normalizeByte(value: number) {
		return clamp(Math.trunc(value), 0, PCF8574.PORT_MASK)
	}

	// Validates and normalizes one pin index.
	#normalizePin(pin: number) {
		const normalizedPin = Math.trunc(pin)

		if (normalizedPin < 0 || normalizedPin >= PCF8574.PIN_COUNT) {
			throw new RangeError(`PCF8574 pin must be between 0 and ${PCF8574.PIN_COUNT - 1}. Received ${pin}.`)
		}

		return normalizedPin
	}

	// Computes the bit mask for one pin.
	#pinMask(pin: number) {
		return 1 << this.#normalizePin(pin)
	}

	// Throws when an active polling session is required.
	#ensureStarted() {
		if (!this.#started) throw new Error('PCF8574 has not been started.')
	}
}
