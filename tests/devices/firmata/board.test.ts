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
})
