import { expect, test } from 'bun:test'
import { createSocket, type Socket } from 'node:dgram'
import { ALPACA_DISCOVERY_DATA, AlpacaDiscoveryServer } from '../src/alpaca.discovery'

// Binds a localhost UDP client socket for deterministic unicast tests.
function bindUdpClient(hostname: string): Promise<Socket> {
	const socket = createSocket('udp4')

	return new Promise((resolve, reject) => {
		const onError = (error: Error) => {
			socket.off('error', onError)
			socket.close()
			reject(error)
		}

		socket.once('error', onError)
		socket.bind(0, hostname, () => {
			socket.off('error', onError)
			resolve(socket)
		})
	})
}

// Sends one UDP datagram and waits for the send callback to complete.
function sendUdpMessage(socket: Socket, data: string, port: number, address: string): Promise<void> {
	return new Promise((resolve, reject) => {
		socket.send(data, port, address, (error) => {
			if (error) reject(error)
			else resolve()
		})
	})
}

// Collects up to expectedCount UDP payloads or resolves after the timeout expires.
function readUdpMessages(socket: Socket, expectedCount: number, timeout: number): Promise<string[]> {
	return new Promise((resolve) => {
		const messages: string[] = []

		const onMessage = (data: Buffer) => {
			messages.push(data.toString('utf-8'))

			if (messages.length === expectedCount) {
				socket.off('message', onMessage)
				clearTimeout(timer)
				resolve(messages)
			}
		}

		const timer = setTimeout(() => {
			socket.off('message', onMessage)
			resolve(messages)
		}, timeout)

		socket.on('message', onMessage)
	})
}

test('AlpacaDiscoveryServer responds with one message per registered valid Alpaca port', async () => {
	const server = new AlpacaDiscoveryServer({ ignoreLocalhost: false })
	const client = await bindUdpClient('127.0.0.1')

	server.addPort(11111)
	server.addPort(22222)
	server.addPort(0)
	server.addPort(65536)
	server.addPort(1.5)

	try {
		expect(await server.start('127.0.0.1', 0, false)).toBe(true)

		const messagesPromise = readUdpMessages(client, 2, 500)
		await sendUdpMessage(client, ALPACA_DISCOVERY_DATA, server.port, '127.0.0.1')

		expect((await messagesPromise).sort()).toEqual(['{"AlpacaPort":11111}', '{"AlpacaPort":22222}'])
	} finally {
		server.stop()
		client.close()
	}
})

test('AlpacaDiscoveryServer ignores invalid discovery request payloads', async () => {
	const server = new AlpacaDiscoveryServer({ ignoreLocalhost: false })
	const client = await bindUdpClient('127.0.0.1')

	server.addPort(12345)

	try {
		expect(await server.start('127.0.0.1', 0, false)).toBe(true)

		const messagesPromise = readUdpMessages(client, 1, 150)
		await sendUdpMessage(client, 'alpacadiscovery0', server.port, '127.0.0.1')

		expect(await messagesPromise).toEqual([])
	} finally {
		server.stop()
		client.close()
	}
})

test('AlpacaDiscoveryServer allows multiple instances to share the same discovery port', async () => {
	const first = new AlpacaDiscoveryServer({ ignoreLocalhost: false })
	const second = new AlpacaDiscoveryServer({ ignoreLocalhost: false })

	try {
		expect(await first.start('127.0.0.1', 0, false)).toBe(true)
		expect(await second.start('127.0.0.1', first.port, false)).toBe(true)
		expect(second.port).toBe(first.port)
	} finally {
		first.stop()
		second.stop()
	}
})

// test('BunSocketAlpacaDiscoveryServer reproduces EADDRINUSE when two instances share the same discovery port', async () => {
// 	const first = new BunSocketAlpacaDiscoveryServer({ ignoreLocalhost: false })
// 	const second = new BunSocketAlpacaDiscoveryServer({ ignoreLocalhost: false })

// 	try {
// 		expect(await first.start('127.0.0.1', 0, false)).toBe(true)

// 		// This assertion is expected to fail today because Bun.udpSocket throws EADDRINUSE on the second bind.
// 		expect(await second.start('127.0.0.1', first.port, false)).toBe(true)
// 	} finally {
// 		first.stop()
// 		second.stop()
// 	}
// })
