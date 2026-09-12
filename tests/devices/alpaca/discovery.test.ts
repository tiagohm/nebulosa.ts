import { expect, spyOn, test } from 'bun:test'
import { createSocket, type Socket } from 'node:dgram'
import * as os from 'node:os'
import { ALPACA_DISCOVERY_DATA, type AlpacaDeviceServer, AlpacaDiscoveryClient, AlpacaDiscoveryServer } from '../../../src/devices/alpaca/discovery'

// Injects the remote address at the UDP boundary so scoped IPv6 cases need no physical interface.
async function discoverResponse(address: string, port: number): Promise<AlpacaDeviceServer[]> {
	using client = new AlpacaDiscoveryClient()
	const bunUdp: { udpSocket: (options: Bun.udp.SocketOptions<'buffer'>) => Promise<Bun.udp.Socket<'buffer'>> } = Bun
	const udpSocket = spyOn(bunUdp, 'udpSocket')
	const interfaces = spyOn(os, 'networkInterfaces').mockReturnValue({})
	const discovered: AlpacaDeviceServer[] = []
	const received = Promise.withResolvers<void>()
	const timer = setTimeout(received.resolve, 500)

	try {
		await client.discovery(
			(server) => {
				discovered.push(server)
				received.resolve()
			},
			{ family: address.includes(':') ? 'IPv6' : 'IPv4', timeout: 0 },
		)
		const options = udpSocket.mock.calls[0][0]
		const result = udpSocket.mock.results[0]
		if (result.type !== 'return') throw new Error('UDP socket creation failed')
		const socket = await result.value
		udpSocket.mockRestore()
		await options.socket?.data?.(socket, Buffer.from(JSON.stringify({ AlpacaPort: port })), 32227, address, { truncated: false, ipv6: address.includes(':') })
		await received.promise
		return discovered
	} finally {
		clearTimeout(timer)
		interfaces.mockRestore()
		udpSocket.mockRestore()
	}
}

test.serial.each(['fe80::1%wlp6s0', 'fe80::1%3'])('AlpacaDiscoveryClient reports scoped IPv6 responder %s with the default fetch option', async (address: string) => {
	expect(await discoverResponse(address, 11111)).toEqual([{ address, port: 11111, devices: [] }])
})

test.serial.each([200, 503])('AlpacaDiscoveryClient preserves UDP discovery when management responds with HTTP %i', async (status: number) => {
	const devices = [{ DeviceName: 'Camera', DeviceType: 'Camera', DeviceNumber: 0, UniqueID: 'discovery-test' }]
	const server = Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		fetch: () => Response.json({ ErrorNumber: 0, Value: devices }, { status }),
	})

	try {
		expect(await discoverResponse('127.0.0.1', server.port!)).toEqual([{ address: '127.0.0.1', port: server.port!, devices: status === 200 ? [{ ...devices[0], DeviceType: 'camera' as const }] : [] }])
	} finally {
		await server.stop(true)
	}
})

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
				// oxlint-disable-next-line promise/no-multiple-resolved
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

test('AlpacaDiscoveryServer reports lifecycle state and refuses a second start', async () => {
	const server = new AlpacaDiscoveryServer({ ignoreLocalhost: false })

	try {
		expect(server.running).toBeFalse()
		expect(server.port).toBe(-1)
		expect(await server.start('127.0.0.1', 0, false)).toBe(true)
		expect(await server.start('127.0.0.1', 0, false)).toBe(false)
		expect(server.running).toBeTrue()
		expect(server.port).toBeGreaterThan(0)
		expect(server.host).toBe('127.0.0.1')
		expect(server.ip).toBe('127.0.0.1')
	} finally {
		server.stop()
	}

	expect(server.running).toBeFalse()
	expect(server.port).toBe(-1)
	expect(server.host).toBeUndefined()
	expect(server.ip).toBeUndefined()
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

test('AlpacaDiscoveryServer stops responding for a removed port', async () => {
	const server = new AlpacaDiscoveryServer({ ignoreLocalhost: false })
	const client = await bindUdpClient('127.0.0.1')

	server.addPort(11111)
	server.addPort(22222)
	server.removePort(22222)

	try {
		expect(await server.start('127.0.0.1', 0, false)).toBe(true)

		const messagesPromise = readUdpMessages(client, 2, 250)
		await sendUdpMessage(client, ALPACA_DISCOVERY_DATA, server.port, '127.0.0.1')

		expect(await messagesPromise).toEqual(['{"AlpacaPort":11111}'])
	} finally {
		server.stop()
		client.close()
	}
})

test('AlpacaDiscoveryServer ignores loopback requests when ignoreLocalhost is enabled', async () => {
	const server = new AlpacaDiscoveryServer({ ignoreLocalhost: false })
	const client = await bindUdpClient('127.0.0.1')

	server.addPort(11111)

	try {
		// Start with ignoreLocalhost = true: a request from the loopback address must be dropped.
		expect(await server.start('127.0.0.1', 0, true)).toBe(true)

		const messagesPromise = readUdpMessages(client, 1, 200)
		await sendUdpMessage(client, ALPACA_DISCOVERY_DATA, server.port, '127.0.0.1')

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
