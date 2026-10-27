import { expect, test } from 'bun:test'
import { PI } from '../../../src/core/constants'
import { StellariumProtocolServer } from '../../../src/devices/protocols/stellarium'

function gotoMessage(ra: number, dec: number) {
	const message = Buffer.alloc(20)
	message.writeUInt16LE(20, 0)
	message.writeUInt16LE(0, 2)
	message.writeUInt32LE(ra, 12)
	message.writeInt32LE(dec, 16)
	return message
}

test('decodes a fragmented goto message', async () => {
	const gotos: [number, number][] = []
	const server = new StellariumProtocolServer({ handler: { goto: (_, ra, dec) => gotos.push([ra, dec]) } })
	server.start('127.0.0.1', 0)
	const client = await Bun.connect({ hostname: '127.0.0.1', port: server.port, socket: { data: () => {} } })

	try {
		const message = gotoMessage(0x40000000, 0x20000000)
		client.write(message, 0, 10)
		await Bun.sleep(10)
		expect(gotos).toHaveLength(0)
		client.write(message, 10, 10)
		await Bun.sleep(10)

		expect(gotos).toEqual([[PI / 2, PI / 4]])
	} finally {
		client.close()
		server.stop()
	}
})

test('decodes concatenated goto messages in order', async () => {
	const gotos: [number, number][] = []
	const server = new StellariumProtocolServer({ handler: { goto: (_, ra, dec) => gotos.push([ra, dec]) } })
	server.start('127.0.0.1', 0)
	const client = await Bun.connect({ hostname: '127.0.0.1', port: server.port, socket: { data: () => {} } })

	try {
		client.write(Buffer.concat([gotoMessage(0x40000000, 0x20000000), gotoMessage(0x60000000, -0x10000000)]))
		await Bun.sleep(10)

		expect(gotos).toEqual([
			[PI / 2, PI / 4],
			[(3 * PI) / 4, -PI / 8],
		])
	} finally {
		client.close()
		server.stop()
	}
})

test('identifies clients, reports their gotos, and broadcasts positions to each one', async () => {
	const gotos: string[] = []
	const closed: string[] = []
	const server = new StellariumProtocolServer({
		handler: {
			goto: (_, ra, dec, client) => gotos.push(client.id),
			clientClose: (_, client) => closed.push(client.id),
		},
	})
	server.start('127.0.0.1', 0)

	const received = [0, 0]
	const first = await Bun.connect({ hostname: '127.0.0.1', port: server.port, socket: { data: (_, data) => void (received[0] += data.byteLength) } })
	const second = await Bun.connect({ hostname: '127.0.0.1', port: server.port, socket: { data: (_, data) => void (received[1] += data.byteLength) } })

	try {
		while (server.clients().length < 2) await Bun.sleep(1)

		const [firstClient, secondClient] = server.clients()
		expect(firstClient.id).not.toBe(secondClient.id)
		expect(server.clients().map((client) => [client.ip, client.port])).toEqual([
			['127.0.0.1', first.localPort],
			['127.0.0.1', second.localPort],
		])

		second.write(gotoMessage(0x40000000, 0x20000000))
		await Bun.sleep(10)
		expect(gotos).toEqual([secondClient.id])

		server.send(PI / 2, PI / 4)
		await Bun.sleep(10)
		expect(received).toEqual([24, 24])

		expect(server.disconnectClient(firstClient.id)).toBe(true)
		expect(server.disconnectClient(firstClient.id)).toBe(false)
		expect(closed).toEqual([firstClient.id])

		server.send(PI / 2, PI / 4)
		await Bun.sleep(10)
		expect(received).toEqual([24, 48])
		expect(server.clients()).toEqual([secondClient])
	} finally {
		first.end()
		second.end()
		server.stop()
	}

	await Bun.sleep(10)
	expect(closed).toHaveLength(2)
})

test('closes only the client that sends an invalid message length', async () => {
	const server = new StellariumProtocolServer({ handler: {} })
	server.start('127.0.0.1', 0)

	const abuser = await Bun.connect({ hostname: '127.0.0.1', port: server.port, socket: { data: () => {} } })
	const other = await Bun.connect({ hostname: '127.0.0.1', port: server.port, socket: { data: () => {} } })

	try {
		while (server.clients().length < 2) await Bun.sleep(1)

		abuser.write(Buffer.from([2, 0, 0, 0]))
		await Bun.sleep(10)

		expect(server.clients().map((client) => client.port)).toEqual([other.localPort])
	} finally {
		abuser.end()
		other.end()
		server.stop()
	}
})
