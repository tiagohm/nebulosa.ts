import type { Board } from './firmata'

// https://github.com/firmata/arduino/blob/main/Boards.h#L998

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

	isPinLED(pin: number) {
		return pin === ESP8266.LED_BUILTIN || pin === ESP8266.LED_BUILTIN_AUX
	}

	isPinDigital(pin: number) {
		return (pin >= ESP8266.D3 && pin <= ESP8266.D1) || (pin >= ESP8266.D6 && pin < ESP8266.A0)
	}

	isPinAnalog(pin: number) {
		return pin === ESP8266.A0
	}

	isPinPWM(pin: number) {
		return pin < ESP8266.A0
	}

	isPinServo(pin: number) {
		return this.isPinDigital(pin) && pin < ESP8266.MAX_SERVOS
	}

	isPinTwoWire(pin: number) {
		return pin === ESP8266.SDA || pin === ESP8266.SCL
	}

	isPinSPI(pin: number) {
		return pin === ESP8266.SS || pin === ESP8266.MOSI || pin === ESP8266.MISO || pin === ESP8266.SCK
	}

	isPinSerial(pin: number) {
		return pin === ESP8266.RX || pin === ESP8266.TX
	}

	pinToDigital(pin: number) {
		return pin
	}

	pinToAnalog(pin: number) {
		return pin - ESP8266.A0
	}

	pinToPWM(pin: number) {
		return pin
	}

	pinToServo(pin: number) {
		return pin
	}
}
