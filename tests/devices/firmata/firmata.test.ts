import { afterEach, describe, expect, test } from 'bun:test'
import { ESP8266 } from '../../../src/devices/firmata/board'
import { FirmataClient } from '../../../src/devices/firmata/client'
import { FirmataClientOverTcp } from '../../../src/devices/firmata/client.tcp'
import { encodePacked7Bit, decodePacked7Bit } from '../../../src/devices/firmata/codecs/numeric'
import { MAX_FIRMATA_BUFFER_SIZE } from '../../../src/devices/firmata/protocol'
import { type FirmataClientHandler, type Transport, PinMode, type AnalogMapping, type Pin } from '../../../src/devices/firmata/types'

describe('command decoding', () => {
	const result: unknown[] = []

	const protocol: FirmataClientHandler = {
		version: (_, major, minor) => result.push(major, minor),
		firmwareMessage: (_, major, minor, name) => result.push(major, minor, name),
		systemReset: () => result.push(true),
		digitalMessage: (_, id, value) => result.push(id, value),
		analogMessage: (_, port, value) => result.push(port, value),
		pinCapability: (_, id, modes) => result.push(id, [...modes]),
		pinCapabilitiesFinished: () => result.push(true),
		analogMapping: (_, mapping) => result.push(mapping),
		pinState: (_, id, mode, value) => result.push(id, mode, value),
		textMessage: (_, message) => result.push(message),
		customMessage: (_, data) => result.push(data),
		twoWireMessage: (_, address, register, data) => result.push(address, register, data),
		oneWireSearchReply: (_, pin, addresses, alarms) => result.push(pin, alarms, addresses),
		oneWireReadReply: (_, pin, correlationId, data) => result.push(pin, correlationId, data),
	}

	const transport: Transport = {
		write: () => {},
		flush: () => {},
		close: () => {},
	}

	const esp8266 = new ESP8266()
	using client = new FirmataClient(transport, esp8266)
	client.addHandler(protocol)

	afterEach(() => {
		result.length = 0
	})

	test('version', () => {
		client.process(Buffer.from([0xf9, 1, 2]))
		expect(result[0]).toBe(1)
		expect(result[1]).toBe(2)
	})

	test('firmware message', () => {
		client.process(Buffer.from([0xf0, 0x79, 2, 3, 65, 0, 66, 0, 67, 0, 0xf7]))
		expect(result[0]).toBe(2)
		expect(result[1]).toBe(3)
		expect(result[2]).toBe('ABC')
	})

	test('system reset', () => {
		client.process(Buffer.from([0xff]))
		expect(result[0]).toBeTrue()
	})

	test('digital message', () => {
		client.process(Buffer.from([0x91, 0x55, 0]))

		for (let i = 0; i < 16; i += 2) {
			expect(result[i]).toBe(8 + i / 2)
			expect(result[i + 1]).toBe(~(i / 2) & 1)
		}
	})

	test('analog message', () => {
		client.process(Buffer.from([0xf0, 0x6f, 1, 4, 4, 0xf7]))
		expect(result[0]).toBe(1)
		expect(result[1]).toBe(516)
	})

	test('pin capability', () => {
		client.process(Buffer.from([0xf0, 0x6c, 1, 0, 2, 0, 11, 0, 0x7f, 3, 0, 4, 0, 0x7f, 0xf7]))
		expect(result[0]).toBe(0)
		expect(result[1]).toEqual([1, 2, 11])
		expect(result[2]).toBe(1)
		expect(result[3]).toEqual([3, 4])
		expect(result[4]).toBeTrue()
	})

	test('pin capability starts at pin zero when it has no modes', () => {
		client.process(Buffer.from([0xf0, 0x79, 2, 3, 0xf7]))
		result.length = 0
		client.process(Buffer.from([0xf0, 0x6c, 0x7f, 1, 0, 0x7f, 0xf7]))
		expect(result[0]).toBe(0)
		expect(result[1]).toEqual([])
		expect(result[2]).toBe(1)
		expect(result[3]).toEqual([PinMode.OUTPUT])
		expect(result[4]).toBeTrue()
	})

	test('analog mapping', () => {
		client.process(Buffer.from([0xf0, 0x6a, 0x7f, 0x7f, 1, 2, 3, 0xf7]))
		const mapping = result[0] as AnalogMapping
		expect(Object.keys(mapping)).toEqual(['1', '2', '3'])
		expect(mapping[1]).toBe(2)
		expect(mapping[2]).toBe(3)
		expect(mapping[3]).toBe(4)
	})

	test('pin state', () => {
		client.process(Buffer.from([0xf0, 0x6e, 5, 1, 3, 0xf7]))
		expect(result[0]).toBe(5)
		expect(result[1]).toBe(PinMode.OUTPUT)
		expect(result[2]).toBe(3)
	})

	test('text message', () => {
		client.process(Buffer.from([0xf0, 0x71, 112, 1, 31, 1, 24, 1, 10, 1, 0xf7]))
		expect(result[0]).toBe('😊')
	})

	test('text message grows beyond the parser scratch buffer', () => {
		const text = 'A'.repeat(200)
		const encoded = Buffer.alloc(text.length * 2)

		for (let i = 0; i < text.length; i++) {
			encoded[i * 2] = text.charCodeAt(i) & 0x7f
			encoded[i * 2 + 1] = (text.charCodeAt(i) >>> 7) & 0x01
		}

		client.process(Buffer.from([0xf0, 0x71, ...encoded, 0xf7]))
		expect(result[0]).toBe(text)
	})

	test('custom message', () => {
		client.process(Buffer.from([0xf0, 1, 65, 0, 66, 0, 67, 0, 0xf7]))
		const buffer = result[0] as Buffer
		expect(buffer[0]).toBe(1)
		expect(buffer.toString('utf-16le', 1, 7)).toBe('ABC')
	})

	test('discards an oversized SysEx frame until its terminator and parses the next message', () => {
		client.processByte(0xf0)
		client.processByte(1)
		client.process(Buffer.alloc(MAX_FIRMATA_BUFFER_SIZE))
		client.process(Buffer.from([0xf9, 1, 2]))
		expect(result).toEqual([])

		client.processByte(0xf7)
		client.process(Buffer.from([0xf9, 3, 4]))
		expect(result).toEqual([3, 4])
	})

	test('two-wire message', () => {
		client.process(Buffer.from([0xf0, 0x77, 0x22, 0x00, 0x44, 0x00, 0x01, 0x00, 0x02, 0x00, 0x03, 0x00, 0xf7]))
		expect(result[0]).toBe(0x22)
		expect(result[1]).toBe(0x44)
		expect(result[2]).toEqual(Buffer.from([1, 2, 3]))
	})

	test('ignores truncated two-wire messages', () => {
		client.process(Buffer.from([0xf0, 0x77, 0xf7, 0xf0, 0x77, 0x22, 0x00, 0xf7]))
		expect(result).toEqual([])
	})

	test('one-wire search reply', () => {
		const addresses = Buffer.from([0x28, 0x1a, 0xbc, 0x4d, 0x2f, 0x00, 0x00, 0xc1, 0x28, 0xff, 0x2a, 0x01, 0x2f, 0x00, 0x00, 0x7e])

		client.process(Buffer.from([0xf0, 0x73, 0x42, 4, ...encodePacked7Bit(addresses), 0xf7]))
		expect(result[0]).toBe(4)
		expect(result[1]).toBeFalse()
		expect(result[2]).toEqual([addresses.subarray(0, 8), addresses.subarray(8, 16)])
	})

	test('one-wire search reply grows beyond the parser scratch buffer', () => {
		const addresses = Buffer.alloc(8 * 30)
		for (let i = 0; i < addresses.length; i++) addresses[i] = (i * 37 + 11) & 0xff

		client.process(Buffer.from([0xf0, 0x73, 0x42, 4, ...encodePacked7Bit(addresses), 0xf7]))
		expect(result[0]).toBe(4)
		expect(result[1]).toBeFalse()
		expect(result[2]).toHaveLength(30)
		expect(result[2]).toEqual(Array.from({ length: 30 }, (_, i) => addresses.subarray(i * 8, i * 8 + 8)))
	})

	test('one-wire read reply', () => {
		client.process(Buffer.from([0xf0, 0x73, 0x43, 2, ...encodePacked7Bit(Buffer.from([0x34, 0x12, 0xaa, 0xbb, 0xcc])), 0xf7]))
		expect(result[0]).toBe(2)
		expect(result[1]).toBe(0x1234)
		expect(result[2]).toEqual(Buffer.from([0xaa, 0xbb, 0xcc]))
	})
})

test('a reconnect handshake re-emits ready after the client is closed', () => {
	const transport: Transport = { write: () => {}, flush: () => {}, close: () => {} }
	using client = new FirmataClient(transport, new ESP8266())
	let readyCount = 0
	client.addHandler({ ready: () => readyCount++ })

	const handshake = () => {
		client.process(Buffer.from([0xf0, 0x79, 2, 3, 0xf7])) // firmware
		client.process(Buffer.from([0xf0, 0x6c, 0x7f, 0x7f, 0xf7])) // pin capability (no modes)
		client.process(Buffer.from([0xf0, 0x6a, 0x7f, 0x7f, 1, 0xf7])) // analog mapping -> ready
	}

	handshake()
	expect(readyCount).toBe(1)

	// A transport close must re-arm the one-shot initialization gate so the next handshake re-emits
	// ready; otherwise a reconnect on the same client would stay perpetually un-ready.
	client.close()
	handshake()
	expect(readyCount).toBe(2)
})

test('an untimed initialization wait settles when the client resets before the handshake completes', async () => {
	const transport: Transport = { write: () => {}, flush: () => {}, close: () => {} }
	using client = new FirmataClient(transport, new ESP8266())

	// A zero timeout means there is no rescue timer; the wait must instead be settled by the reset.
	const pending = client.ensureInitializationIsDone(0)
	client.reset()

	expect(await pending).toBeFalse()
})

test('a reconnect handshake does not inherit pins from the previous one', () => {
	const transport: Transport = { write: () => {}, flush: () => {}, close: () => {} }
	using client = new FirmataClient(transport, new ESP8266())

	const firmware = () => client.process(Buffer.from([0xf0, 0x79, 2, 3, 0xf7]))

	// First handshake exposes two analog pins (0 and 1).
	firmware()
	client.process(Buffer.from([0xf0, 0x6c, 0x02, 0x0a, 0x7f, 0x02, 0x0a, 0x7f, 0xf7]))
	expect(client.pinCount).toBe(2)
	expect(client.pinAt(1)).toBeDefined()

	// The transport closes (clearing cached board metadata) and reconnects exposing only pin 0.
	client.close()
	firmware()
	client.process(Buffer.from([0xf0, 0x6c, 0x02, 0x0a, 0x7f, 0xf7]))

	expect(client.pinCount).toBe(1)
	expect(client.pinAt(1)).toBeUndefined()
})

test('a TCP client can reconnect after a remote socket close', async () => {
	let connections = 0
	const clientClosed = Promise.withResolvers<void>()
	const server = Bun.listen({
		hostname: '127.0.0.1',
		port: 0,
		socket: {
			open: (socket) => {
				connections++
				if (connections === 1) socket.close()
			},
			data: () => {},
		},
	})
	const client = new FirmataClientOverTcp(new ESP8266())
	client.addHandler({ close: () => clientClosed.resolve() })

	try {
		expect(await client.connect('127.0.0.1', server.port)).toBeTrue()
		await clientClosed.promise
		expect(await client.connect('127.0.0.1', server.port)).toBeTrue()
		expect(connections).toBe(2)
	} finally {
		client.disconnect()
		server.stop()
	}
})

describe('command encoding', () => {
	const transport: Transport = {
		write: () => {},
		flush: () => {},
		close: () => {},
	}

	const esp8266 = new ESP8266()
	using client = new FirmataClient(transport, esp8266)
	const messages: Buffer[] = []

	client.send = (message) => {
		if (typeof message === 'string') {
			messages.push(Buffer.from(message))
		} else if (ArrayBuffer.isView(message)) {
			messages.push(Buffer.from(message.buffer, message.byteOffset, message.byteLength))
		} else {
			messages.push(Buffer.from(message))
		}
	}

	afterEach(() => {
		messages.length = 0
	})

	test('request command messages', () => {
		client.requestFirmware()
		client.requestPinCapability()
		client.requestPinState(12)
		client.requestAnalogMapping()

		expect(messages[0]).toEqual(Buffer.from([0xf0, 0x79, 0xf7]))
		expect(messages[1]).toEqual(Buffer.from([0xf0, 0x6b, 0xf7]))
		expect(messages[2]).toEqual(Buffer.from([0xf0, 0x6d, 12, 0xf7]))
		expect(messages[3]).toEqual(Buffer.from([0xf0, 0x69, 0xf7]))
	})

	test('digital and analog report commands', () => {
		client.requestDigitalReport(true)
		client.requestDigitalPinReport(6, false)
		client.requestDigitalPinReport(16, true)
		client.requestAnalogReport(false)
		client.requestAnalogPinReport(ESP8266.A0, true)

		const digitalReport = Buffer.alloc(32)
		for (let i = 0, p = 0; i < 16; i++) {
			digitalReport[p++] = 0xd0 | i
			digitalReport[p++] = 1
		}

		const analogReport = Buffer.alloc(32)
		for (let i = 0, p = 0; i < 16; i++) {
			analogReport[p++] = 0xc0 | i
			analogReport[p++] = 0
		}

		expect(messages[0]).toEqual(digitalReport)
		expect(messages[1]).toEqual(Buffer.from([0xd0, 0]))
		expect(messages[2]).toEqual(Buffer.from([0xd2, 1]))
		expect(messages[3]).toEqual(analogReport)
		expect(messages[4]).toEqual(Buffer.from([0xc0, 1]))
	})

	test('pin mode and digital write', () => {
		client.pinMode(2, PinMode.PULL_UP)
		client.digitalWrite(2, false)
		client.digitalWrite(2, 123)

		expect(messages[0]).toEqual(Buffer.from([0xf4, 2, PinMode.PULL_UP]))
		expect(messages[1]).toEqual(Buffer.from([0xf5, 2, 0]))
		expect(messages[2]).toEqual(Buffer.from([0xf5, 2, 1]))
	})

	test('analog write uses extended analog encoding', () => {
		client.analogWrite(2, 127)
		client.analogWrite(2, 128)
		client.analogWrite(17, 0x12345)

		expect(messages[0]).toEqual(Buffer.from([0xf0, 0x6f, 2, 0x7f, 0xf7]))
		expect(messages[1]).toEqual(Buffer.from([0xf0, 0x6f, 2, 0x00, 0x01, 0xf7]))
		expect(messages[2]).toEqual(Buffer.from([0xf0, 0x6f, 17, 0x45, 0x46, 0x04, 0xf7]))
	})

	test('sampling interval is clamped to minimum', () => {
		client.samplingInterval(0)
		expect(messages[0]).toEqual(Buffer.from([0xf0, 0x7a, 1, 0, 0xf7]))
	})

	test('sampling interval is clamped to maximum', () => {
		client.samplingInterval(20000)
		expect(messages[0]).toEqual(Buffer.from([0xf0, 0x7a, 0x7f, 0x7f, 0xf7]))
	})

	test('sampling interval encodes the full 14-bit value', () => {
		// 1000 ms needs both 7-bit bytes (LSB 0x68, MSB 0x07); an 8-bit encoder would drop bits 8-9.
		client.samplingInterval(1000)
		expect(messages[0]).toEqual(Buffer.from([0xf0, 0x7a, 1000 & 0x7f, (1000 >> 7) & 0x7f, 0xf7]))
	})

	test('two-wire config keeps max delay', () => {
		client.twoWireConfig(10)
		client.twoWireConfig(4)
		client.twoWireConfig(130)

		expect(messages[0]).toEqual(Buffer.from([0xf0, 0x78, 10, 0, 0xf7]))
		expect(messages[1]).toEqual(Buffer.from([0xf0, 0x78, 10, 0, 0xf7]))
		expect(messages[2]).toEqual(Buffer.from([0xf0, 0x78, 2, 1, 0xf7]))
	})

	test('two-wire write/read/stop command encodings', () => {
		client.twoWireWrite(0x123, Buffer.from([0xaa, 0xbb]))
		client.twoWireRead(0x1aa, 0x10, 3, false, 10, 'restart')
		client.twoWireStop(0x55)

		expect(messages[0]).toEqual(Buffer.from([0xf0, 0x76, 0x23, 0x02, 0x2a, 0x01, 0x3b, 0x01, 0xf7]))
		expect(messages[1]).toEqual(Buffer.from([0xf0, 0x76, 0x2a, 0x6b, 0x10, 0, 0x03, 0, 0xf7]))
		expect(messages[2]).toEqual(Buffer.from([0xf0, 0x76, 0x55, 0x18, 0xf7]))
	})

	test('one-wire config', () => {
		client.oneWireConfig(5)
		expect(messages[0]).toEqual(Buffer.from([0xf0, 0x73, 0x41, 5, 1, 0xf7]))
	})

	test('one-wire search alarms', () => {
		client.oneWireSearch(6, 'alarms')
		expect(messages[0]).toEqual(Buffer.from([0xf0, 0x73, 0x44, 6, 0xf7]))
	})

	test('one-wire command with select, read, delay and write', () => {
		const correlationId = client.oneWireCommand(7, {
			reset: true,
			address: Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]),
			bytesToRead: 3,
			correlationId: 0x2211,
			delay: 5,
			data: Buffer.from([0xaa, 0xbb]),
		})

		expect(correlationId).toBe(0x2211)

		const payload = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 3, 0, 0x11, 0x22, 5, 0, 0, 0, 0xaa, 0xbb])
		expect(messages[0]).toEqual(Buffer.from([0xf0, 0x73, 0x3d, 7, ...encodePacked7Bit(payload), 0xf7]))
	})

	test('one-wire write wrapper uses skip when address is omitted', () => {
		client.oneWireWrite(9, Buffer.from([0x44, 0xbe]))
		expect(messages[0]).toEqual(Buffer.from([0xf0, 0x73, 0x23, 9, ...encodePacked7Bit(Buffer.from([0x44, 0xbe])), 0xf7]))
	})

	test('one-wire write wrapper uses select when address is provided', () => {
		const address = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8])
		const payload = Buffer.concat([address, Buffer.from([0x44])])
		client.oneWireWrite(9, Buffer.from([0x44]), address)
		expect(messages[0]).toEqual(Buffer.from([0xf0, 0x73, 0x25, 9, ...encodePacked7Bit(payload), 0xf7]))
	})

	test('one-wire reset and write-then-read wrappers encode their bus operations', () => {
		const address = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8])
		client.oneWireReset(3)
		const correlationId = client.oneWireWriteAndRead(3, Buffer.from([0xbe]), 9, address, 0x1234)

		expect(correlationId).toBe(0x1234)
		expect(messages[0]).toEqual(Buffer.from([0xf0, 0x73, 0x01, 3, 0xf7]))
		expect(messages[1]).toEqual(Buffer.from([0xf0, 0x73, 0x2d, 3, ...encodePacked7Bit(Buffer.from([...address, 9, 0, 0x34, 0x12, 0xbe])), 0xf7]))
	})

	test('one-wire command validates skip/address combination and address length', () => {
		expect(() => client.oneWireCommand(1, { skip: true, address: Buffer.alloc(8) })).toThrow(RangeError)
		expect(() => client.oneWireCommand(1, { address: Buffer.alloc(7) })).toThrow(RangeError)
		expect(messages.length).toBe(0)
	})

	test('one-wire command clamps read length, correlation id and delay', () => {
		const correlationId = client.oneWireCommand(2, { bytesToRead: 0x10000, correlationId: 0x1ffff, delay: 0x1_0000_0000 })

		expect(correlationId).toBe(0xffff)
		expect(messages[0].subarray(0, 4)).toEqual(Buffer.from([0xf0, 0x73, 0x18, 2]))
		expect(decodePacked7Bit(messages[0], 4, messages[0].length - 5)).toEqual(Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]))
	})

	test('one-wire read generates auto correlation id', () => {
		const first = client.oneWireRead(4, 2)
		const second = client.oneWireRead(4, 2)

		expect(messages[0].subarray(0, 4)).toEqual(Buffer.from([0xf0, 0x73, 0x0b, 4]))
		expect(messages[1].subarray(0, 4)).toEqual(Buffer.from([0xf0, 0x73, 0x0b, 4]))
		const payload0 = decodePacked7Bit(messages[0], 4, messages[0].length - 5)
		const payload1 = decodePacked7Bit(messages[1], 4, messages[1].length - 5)
		const firstCorrelationId = payload0[2] | (payload0[3] << 8)
		const secondCorrelationId = payload1[2] | (payload1[3] << 8)

		expect(payload0.subarray(0, 2)).toEqual(Buffer.from([2, 0]))
		expect(payload1.subarray(0, 2)).toEqual(Buffer.from([2, 0]))
		expect(first).toBe(firstCorrelationId)
		expect(second).toBe(secondCorrelationId)
		expect(secondCorrelationId).toBe((firstCorrelationId + 1) & 0xffff)
	})

	test('explicit and invalid one-wire reads do not consume the automatic correlation id', () => {
		const first = client.oneWireRead(4, 1)
		expect(client.oneWireRead(4, 1, undefined, 0x1234)).toBe(0x1234)
		expect(() => client.oneWireCommand(4, { skip: true, address: Buffer.alloc(8), bytesToRead: 1 })).toThrow(RangeError)
		const second = client.oneWireRead(4, 1)

		if (first === undefined) throw new Error('Expected a correlation ID for the first read')
		expect(second).toBe((first + 1) & 0xffff)
		expect(messages).toHaveLength(3)
	})
})

test('packed 7-bit encoding round-trips arbitrary byte payloads', () => {
	for (const data of [Buffer.from([]), Buffer.from([0x00]), Buffer.from([0xff]), Buffer.from([0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde, 0xf0]), Buffer.from(Array.from({ length: 33 }, (_, i) => (i * 37 + 11) & 0xff))]) {
		const encoded = encodePacked7Bit(data)
		// Each encoded byte must fit in 7 bits (MSB clear) to be MIDI/Firmata-safe.
		for (const byte of encoded) expect(byte & 0x80).toBe(0)
		expect(decodePacked7Bit(Buffer.from(encoded), 0, encoded.length)).toEqual(data)
	}
})

test('pin mode updates the cached mode before analog reports', () => {
	const transport: Transport = { write: () => {}, flush: () => {}, close: () => {} }
	using client = new FirmataClient(transport, new ESP8266())
	const changes: Pin[] = []
	client.addHandler({ pinChange: (_, pin) => changes.push(pin) })

	client.process(Buffer.from([0xf0, 0x79, 2, 3, 0xf7])) // firmware
	client.process(Buffer.from([0xf0, 0x6c, 0x00, 0x00, 0x7f, 0xf7])) // pin 0 = input
	client.process(Buffer.from([0xf0, 0x6e, 0x00, 0x00, 0x00, 0xf7])) // pin 0 input, value 0
	client.process(Buffer.from([0xf0, 0x6a, 0x00, 0xf7])) // analog channel 0 = pin 0

	client.pinMode(0, PinMode.ANALOG)
	client.process(Buffer.from([0xe0, 0x10, 0x02]))

	expect(client.pinAt(0)?.mode).toBe(PinMode.ANALOG)
	expect(client.pinAt(0)?.value).toBe(0x10 | (0x02 << 7))
	expect(changes).toHaveLength(1)
})
