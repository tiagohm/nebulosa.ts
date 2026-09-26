import { expect, test } from 'bun:test'
import { ESP8266 } from '../../../src/devices/firmata/board'
import { FirmataClient } from '../../../src/devices/firmata/client'
import { LM35 } from '../../../src/devices/firmata/sensors/thermometer'
import { PinMode, type Transport } from '../../../src/devices/firmata/types'
import { MockFirmataClient } from './util'

test('peripheral fires on the first completed read even when the value equals the default', () => {
	const client = new MockFirmataClient()
	const lm35 = new LM35(client as never, 2)
	let updates = 0

	const listener = () => {
		updates++
	}

	lm35.addListener(listener)
	expect(lm35.initialized).toBeFalse()

	// First sample reads 0 -> temperature stays at its default 0, but the first completed read must
	// still notify so a consumer can settle its initial state (e.g. a DS18B20 reading exactly 0 C).
	lm35.pinChange(client as never, { id: 2, modes: new Set([PinMode.ANALOG]), resolutions: new Map(), mode: PinMode.ANALOG, value: 0 })
	expect(lm35.temperature).toBe(0)
	expect(updates).toBe(1)
	expect(lm35.initialized).toBeTrue()

	// A subsequent identical sample does not fire again.
	lm35.pinChange(client as never, { id: 2, modes: new Set([PinMode.ANALOG]), resolutions: new Map(), mode: PinMode.ANALOG, value: 0 })
	expect(updates).toBe(1)

	// Detaching the last listener resets the first-sample signal so a new consumer is notified again.
	lm35.removeListener(listener)
	expect(lm35.initialized).toBeFalse()
	lm35.addListener(listener)
	lm35.pinChange(client as never, { id: 2, modes: new Set([PinMode.ANALOG]), resolutions: new Map(), mode: PinMode.ANALOG, value: 0 })
	expect(updates).toBe(2)
})

test('an ADC peripheral counts stable analog reports on a real FirmataClient', () => {
	const transport: Transport = { write: () => {}, flush: () => {}, close: () => {} }
	using client = new FirmataClient(transport, new ESP8266())

	// Handshake far enough to register pin 0 as analog, map analog channel 0 to it, and have the board
	// report pin state 0, leaving pin 0 cached at value 0.
	client.process(Buffer.from([0xf0, 0x79, 2, 3, 0xf7])) // firmware
	client.process(Buffer.from([0xf0, 0x6c, 0x02, 0x0a, 0x7f, 0xf7])) // pin capability: pin 0 = analog
	client.process(Buffer.from([0xf0, 0x6e, 0x00, 0x02, 0x00, 0xf7])) // pin state: pin 0 analog, value 0
	client.process(Buffer.from([0xf0, 0x6a, 0x00, 0xf7])) // analog channel 0 = pin 0

	const lm35 = new LM35(client, 0)
	let updates = 0
	lm35.addListener(() => updates++)
	lm35.start()

	// start() delivers the cached value as the first reading. The first stable hardware report must still
	// count as a sample, even though it does not change the temperature.
	expect(updates).toBe(1)
	expect(lm35.temperature).toBe(0)
	expect(lm35.samples).toBe(1)

	client.process(Buffer.from([0xe0, 0x00, 0x00]))
	expect(lm35.samples).toBe(2)
	expect(updates).toBe(1)

	// A listener attached after start() must receive the current stable value on the next report.
	let lateUpdates = 0
	lm35.addListener(() => lateUpdates++)
	client.process(Buffer.from([0xe0, 0x00, 0x00]))
	expect(lateUpdates).toBe(1)
	expect(lm35.samples).toBe(3)
})

test('re-adding an already-registered listener does not re-arm its first read', () => {
	const client = new MockFirmataClient()
	const lm35 = new LM35(client as never, 2)
	let updates = 0
	const listener = () => updates++

	lm35.addListener(listener)
	lm35.pinChange(client as never, { id: 2, modes: new Set([PinMode.ANALOG]), resolutions: new Map(), mode: PinMode.ANALOG, value: 0 })
	expect(updates).toBe(1)
	expect(lm35.initialized).toBeTrue()

	// Adding the same listener again must not owe it another first read.
	lm35.addListener(listener)
	expect(lm35.initialized).toBeTrue()
	lm35.pinChange(client as never, { id: 2, modes: new Set([PinMode.ANALOG]), resolutions: new Map(), mode: PinMode.ANALOG, value: 0 })
	expect(updates).toBe(1)
})

test('a listener attached after the peripheral is initialized still receives a first read', () => {
	const client = new MockFirmataClient()
	const lm35 = new LM35(client as never, 2)
	let a = 0
	let b = 0

	const listenerA = () => a++
	const listenerB = () => b++

	lm35.addListener(listenerA)
	lm35.pinChange(client as never, { id: 2, modes: new Set([PinMode.ANALOG]), resolutions: new Map(), mode: PinMode.ANALOG, value: 0 })
	expect(a).toBe(1)
	expect(lm35.initialized).toBeTrue()

	// B is attached after the peripheral already produced a reading. The next sample has the same value
	// (unchanged), but B must still receive its first read; A must not be re-fired.
	lm35.addListener(listenerB)
	expect(lm35.initialized).toBeFalse()
	lm35.pinChange(client as never, { id: 2, modes: new Set([PinMode.ANALOG]), resolutions: new Map(), mode: PinMode.ANALOG, value: 0 })
	expect(b).toBe(1)
	expect(a).toBe(1)
	expect(lm35.initialized).toBeTrue()

	// A real change fires both listeners.
	lm35.pinChange(client as never, { id: 2, modes: new Set([PinMode.ANALOG]), resolutions: new Map(), mode: PinMode.ANALOG, value: 51.15 })
	expect(a).toBe(2)
	expect(b).toBe(2)
})
