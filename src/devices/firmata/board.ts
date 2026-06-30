import type { Board } from './firmata'

// Board pin map and capability predicates for the ESP8266, implementing the Firmata Board interface.
// Static constants map silkscreen labels (D0..D10, A0, bus pins) to the firmware's GPIO numbers; the
// instance methods classify a GPIO number by capability and convert it to a per-mode channel index.
// https://github.com/firmata/arduino/blob/main/Boards.h#L998

// ESP8266 board definition: GPIO numbering and pin-capability predicates used by the Firmata client.
export class ESP8266 implements Board {
	static readonly D0 = 16
	static readonly D1 = 5
	static readonly D2 = 4
	static readonly D3 = 0
	static readonly D4 = 2
	static readonly D5 = 14
	static readonly D6 = 12
	static readonly D7 = 13
	static readonly D8 = 15
	static readonly D9 = 3
	static readonly D10 = 1

	static readonly A0 = 17

	static readonly SDA = this.D2
	static readonly SCL = this.D1

	static readonly RX = this.D9
	static readonly TX = this.D10

	static readonly SS = this.D8
	static readonly MOSI = this.D7
	static readonly MISO = this.D6
	static readonly SCK = this.D5

	static readonly MAX_SERVOS = 9

	static readonly LED_BUILTIN = this.D4
	static readonly LED_BUILTIN_AUX = this.D0

	static readonly NUMBER_OF_DIGITAL_PINS = 17
	static readonly NUMBER_OF_ANALOG_PINS = 1

	static readonly TOTAL_PINS = 18
	static readonly DEFAULT_PWM_RESOLUTION = 10

	readonly name = 'ESP8266'

	// Whether the GPIO drives one of the two built-in LEDs.
	isPinLED(pin: number) {
		return pin === ESP8266.LED_BUILTIN || pin === ESP8266.LED_BUILTIN_AUX
	}

	// Whether the GPIO can be used as a general digital I/O pin.
	isPinDigital(pin: number) {
		return (pin >= ESP8266.D3 && pin <= ESP8266.D1) || (pin >= ESP8266.D6 && pin < ESP8266.A0)
	}

	// Whether the GPIO is the analog input.
	isPinAnalog(pin: number) {
		return pin === ESP8266.A0
	}

	// Whether the GPIO supports PWM output.
	isPinPWM(pin: number) {
		return pin < ESP8266.A0
	}

	// Whether the GPIO can drive a servo (digital and within the servo count).
	isPinServo(pin: number) {
		return this.isPinDigital(pin) && pin < ESP8266.MAX_SERVOS
	}

	// Whether the GPIO is an I2C (two-wire) bus pin.
	isPinTwoWire(pin: number) {
		return pin === ESP8266.SDA || pin === ESP8266.SCL
	}

	// Whether the GPIO is an SPI bus pin.
	isPinSPI(pin: number) {
		return pin === ESP8266.SS || pin === ESP8266.MOSI || pin === ESP8266.MISO || pin === ESP8266.SCK
	}

	// Whether the GPIO is a hardware serial (UART) pin.
	isPinSerial(pin: number) {
		return pin === ESP8266.RX || pin === ESP8266.TX
	}

	// GPIO number → digital channel index (identity on this board).
	pinToDigital(pin: number) {
		return pin
	}

	// GPIO number → analog channel index (offset from A0).
	pinToAnalog(pin: number) {
		return pin - ESP8266.A0
	}

	// GPIO number → PWM channel index (identity on this board).
	pinToPWM(pin: number) {
		return pin
	}

	// GPIO number → servo channel index (identity on this board).
	pinToServo(pin: number) {
		return pin
	}
}
