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
