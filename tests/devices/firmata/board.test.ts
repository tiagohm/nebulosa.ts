import { describe, expect, test } from 'bun:test'
import { ESP8266 } from '../../../src/devices/firmata/board'

describe('ESP8266 board', () => {
	const board = new ESP8266()

	test('reports PWM only for usable digital pins', () => {
		for (const pin of [0, 1, 2, 3, 4, 5, 12, 13, 14, 15, 16]) {
			expect(board.isPinPWM(pin)).toBeTrue()
		}

		for (const pin of [-1, 6, 7, 8, 9, 10, 11, 17]) {
			expect(board.isPinPWM(pin)).toBeFalse()
		}
	})

	test('classifies shared bus, UART and analog pins without assigning them to the wrong capability', () => {
		expect(board.isPinTwoWire(ESP8266.SDA)).toBeTrue()
		expect(board.isPinTwoWire(ESP8266.SCL)).toBeTrue()
		expect(board.isPinSPI(ESP8266.SDA)).toBeFalse()
		for (const pin of [ESP8266.SS, ESP8266.MOSI, ESP8266.MISO, ESP8266.SCK]) {
			expect(board.isPinSPI(pin)).toBeTrue()
			expect(board.isPinTwoWire(pin)).toBeFalse()
		}
		expect(board.isPinSerial(ESP8266.RX)).toBeTrue()
		expect(board.isPinSerial(ESP8266.TX)).toBeTrue()
		expect(board.isPinSerial(ESP8266.SDA)).toBeFalse()
		expect(board.isPinAnalog(ESP8266.A0)).toBeTrue()
		expect(board.isPinDigital(ESP8266.A0)).toBeFalse()
		expect(board.pinToAnalog(ESP8266.A0)).toBe(0)
	})

	test('limits servo capability to the first nine GPIOs', () => {
		expect(board.isPinServo(ESP8266.D2)).toBeTrue()
		expect(board.isPinServo(ESP8266.D5)).toBeFalse()
		expect(board.isPinServo(ESP8266.A0)).toBeFalse()
	})
})
