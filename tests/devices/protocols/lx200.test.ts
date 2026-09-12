import { expect, test } from 'bun:test'
import { Socket } from 'node:net'
import { temporalFromDate } from '../../../src/astronomy/time/temporal'
import { Lx200ProtocolServer, type Lx200ProtocolHandler, type MoveDirection, type SlewRate } from '../../../src/devices/protocols/lx200'
import { dms, hms } from '../../../src/math/units/angle'

test('responds to the single-byte LX200 ACK request', async () => {
	await withLx200Server(async (client) => {
		const response = readUntil(client, (value) => value === 'G')

		client.write(Buffer.from([6]))

		expect(await response).toBe('G')
	})
})

test('responds to product and firmware commands', async () => {
	await withLx200Server(
		async (client) => {
			const response = readUntil(client, (value) => value === 'Nebulosa#0.2.0#Jan 01 2025#00:00:00#')

			client.write('#:GVP##:GVN##:GVD##:GVT#', 'ascii')

			expect(await response).toBe('Nebulosa#0.2.0#Jan 01 2025#00:00:00#')
		},
		makeHandler(),
		{ name: 'Nebulosa', version: '0.2.0' },
	)
})

test('responds to coordinate, site, date, time, offset, status, and slewing getters', async () => {
	await withLx200Server(
		async (client) => {
			const response = readUntil(client, (value) => value === '01:02:03#-04*05:06#+070*30#+12*15#04/24/26#02:06:07#+03.0#GTP#|#')

			client.write('#:GR##:GD##:Gg##:Gt##:GC##:GL##:GG##:GW##:D#', 'ascii')

			expect(await response).toBe('01:02:03#-04*05:06#+070*30#+12*15#04/24/26#02:06:07#+03.0#GTP#|#')
		},
		makeHandler({
			rightAscension: () => hms(1, 2, 3),
			declination: () => dms(-4, 5, 6),
			longitude: () => dms(-70, 30),
			latitude: () => dms(12, 15),
			dateTime: () => [temporalFromDate(2026, 4, 24, 5, 6, 7), -180] as const,
			tracking: () => true,
			parked: () => true,
			slewing: () => true,
		}),
	)
})

test('frames split and coalesced LX200 commands', async () => {
	await withLx200Server(async (client) => {
		const response = readUntil(client, (value) => value === '00:00:00#+00*00:00#')

		client.write('#:G', 'ascii')
		await Bun.sleep(1)
		client.write('R##:GD#', 'ascii')

		expect(await response).toBe('00:00:00#+00*00:00#')
	})
})

test('sets target coordinates and uses them for sync and goto', async () => {
	const synced: number[][] = []
	const slewed: number[][] = []

	await withLx200Server(
		async (client) => {
			const response = readUntil(client, (value) => value === '11#0')

			client.write('#:Sr01:02:03##:Sd-04*05:06##:CM##:MS#', 'ascii')

			expect(await response).toBe('11#0')
		},
		makeHandler({
			sync: (server, rightAscension, declination) => {
				synced.push([rightAscension, declination])
			},
			goto: (server, rightAscension, declination) => {
				slewed.push([rightAscension, declination])
			},
		}),
	)

	expect(synced).toHaveLength(1)
	expect(synced[0][0]).toBeCloseTo(hms(1, 2, 3), 12)
	expect(synced[0][1]).toBeCloseTo(dms(-4, 5, 6), 12)
	expect(slewed).toHaveLength(1)
	expect(slewed[0][0]).toBeCloseTo(hms(1, 2, 3), 12)
	expect(slewed[0][1]).toBeCloseTo(dms(-4, 5, 6), 12)
})

test('accepts standard colon-prefixed commands', async () => {
	const slewed: number[][] = []

	await withLx200Server(
		async (client) => {
			const response = readUntil(client, (value) => value === '110')

			client.write(':Sr12:00:00#:Sd+45*00:00#:MS#', 'ascii')

			expect(await response).toBe('110')
		},
		makeHandler({
			goto: (server, rightAscension, declination) => {
				slewed.push([rightAscension, declination])
			},
		}),
	)

	expect(slewed).toHaveLength(1)
	expect(slewed[0][0]).toBeCloseTo(hms(12), 12)
	expect(slewed[0][1]).toBeCloseTo(dms(45), 12)
})

test('preserves staged target and connection state across clients', async () => {
	const slewed: number[][] = []
	let disconnects = 0
	const server = new Lx200ProtocolServer({
		handler: makeHandler({
			goto: (server, rightAscension, declination) => {
				slewed.push([rightAscension, declination])
			},
			disconnect: () => {
				disconnects++
			},
		}),
	})
	server.start('127.0.0.1', 0)

	const first = await connectClient(server.port)
	let second: Socket | undefined

	try {
		const targetResponse = readUntil(first, (value) => value === '11')

		first.write('#:Sr12:00:00##:Sd+45*00:00#', 'ascii')

		expect(await targetResponse).toBe('11')

		const secondSocket = await connectClient(server.port)
		second = secondSocket
		const secondResponse = readUntil(secondSocket, (value) => value === '00:00:00#')

		secondSocket.write('#:GR#', 'ascii')

		expect(await secondResponse).toBe('00:00:00#')

		const slewResponse = readUntil(first, (value) => value === '0')

		first.write('#:MS#', 'ascii')

		expect(await slewResponse).toBe('0')

		const secondClosed = new Promise<void>((resolve) => {
			secondSocket.once('close', () => resolve())
		})
		secondSocket.destroy()
		await secondClosed
		await Bun.sleep(1)

		expect(disconnects).toBe(0)
	} finally {
		first.destroy()
		second?.destroy()
		server.stop()
	}

	expect(slewed).toHaveLength(1)
	expect(slewed[0][0]).toBeCloseTo(hms(12), 12)
	expect(slewed[0][1]).toBeCloseTo(dms(45), 12)
})

test('keeps the previous target coordinates after invalid coordinate writes', async () => {
	const synced: number[][] = []
	const slewed: number[][] = []

	await withLx200Server(
		async (client) => {
			const response = readUntil(client, (value) => value === '1111#0')

			client.write('#:Sr01:02:03##:Sd-04*05:06##:Srxx##:Sdxx##:CM##:MS#', 'ascii')

			expect(await response).toBe('1111#0')
		},
		makeHandler({
			sync: (server, rightAscension, declination) => {
				synced.push([rightAscension, declination])
			},
			goto: (server, rightAscension, declination) => {
				slewed.push([rightAscension, declination])
			},
		}),
	)

	expect(synced[0][0]).toBeCloseTo(hms(1, 2, 3), 12)
	expect(synced[0][1]).toBeCloseTo(dms(-4, 5, 6), 12)
	expect(slewed[0][0]).toBeCloseTo(hms(1, 2, 3), 12)
	expect(slewed[0][1]).toBeCloseTo(dms(-4, 5, 6), 12)
})

test('sets site longitude and latitude', async () => {
	const longitudes: number[] = []
	const latitudes: number[] = []

	await withLx200Server(
		async (client) => {
			const response = readUntil(client, (value) => value === '11')

			client.write('#:Sg+070*30##:St-12*15#', 'ascii')

			expect(await response).toBe('11')
		},
		makeHandler({
			longitude: (server, longitude) => {
				if (longitude !== undefined) longitudes.push(longitude)
				return longitudes.at(-1) ?? 0
			},
			latitude: (server, latitude) => {
				if (latitude !== undefined) latitudes.push(latitude)
				return latitudes.at(-1) ?? 0
			},
		}),
	)

	expect(longitudes).toHaveLength(1)
	expect(longitudes[0]).toBeCloseTo(dms(-70, 30), 12)
	expect(latitudes).toHaveLength(1)
	expect(latitudes[0]).toBeCloseTo(dms(-12, 15), 12)
})

test('applies UTC offset, local time, and calendar date together', async () => {
	const updates: Array<readonly [number, number]> = []

	await withLx200Server(
		async (client) => {
			const updateResponse = readUntil(client, (value) => value === '111Updating planetary data       #                              #')

			client.write('#:SG+03##:SL12:34:56##:SC04/24/26#', 'ascii')

			expect(await updateResponse).toBe('111Updating planetary data       #                              #')

			const getResponse = readUntil(client, (value) => value === '04/24/26#12:34:56#+03.0#')

			client.write('#:GC##:GL##:GG#', 'ascii')

			expect(await getResponse).toBe('04/24/26#12:34:56#+03.0#')
		},
		makeHandler({
			dateTime: (server, date) => {
				if (date !== undefined) updates.push(date)
				return updates.at(-1) ?? [temporalFromDate(2026, 1, 1), 0]
			},
		}),
	)

	expect(updates).toHaveLength(1)
	expect(updates[0][0]).toBe(temporalFromDate(2026, 4, 24, 15, 34, 56))
	expect(updates[0][1]).toBe(-180)
})

test('dispatches move and halt direction commands', async () => {
	const moves: Array<readonly [MoveDirection, boolean]> = []

	await withLx200Server(
		async (client) => {
			client.write('#:Me##:Mn##:Ms##:Mw##:Qe##:Qn##:Qs##:Qw#', 'ascii')
			await waitFor(() => moves.length === 8)
		},
		makeHandler({
			move: (server, direction, enabled) => {
				moves.push([direction, enabled])
			},
		}),
	)

	expect(moves).toEqual([
		['EAST', true],
		['NORTH', true],
		['SOUTH', true],
		['WEST', true],
		['EAST', false],
		['NORTH', false],
		['SOUTH', false],
		['WEST', false],
	])
})

test('dispatches slew rates and abort', async () => {
	const rates: SlewRate[] = []
	let aborts = 0

	await withLx200Server(
		async (client) => {
			client.write('#:RC##:RG##:RM##:RS##:Q#', 'ascii')
			await waitFor(() => rates.length === 4 && aborts === 1)
		},
		makeHandler({
			slewRate: (server, rate) => {
				rates.push(rate)
			},
			abort: () => {
				aborts++
			},
		}),
	)

	expect(rates).toEqual(['CENTER', 'GUIDE', 'FIND', 'MAX'])
	expect(aborts).toBe(1)
})

test('carries rounded sexagesimal fields in coordinate responses', async () => {
	await withLx200Server(
		async (client) => {
			const response = readUntil(client, (value) => value === '00:00:00#+13*00:00#')

			client.write('#:GR##:GD#', 'ascii')

			expect(await response).toBe('00:00:00#+13*00:00#')
		},
		makeHandler({
			rightAscension: () => hms(23, 59, 59.6),
			declination: () => dms(12, 59, 59.6),
		}),
	)
})

test('ignores an unknown command without breaking the following valid command', async () => {
	await withLx200Server(
		async (client) => {
			const response = readUntil(client, (value) => value === '01:02:03#')

			// An unsupported command must not desync the parser; the next valid getter still answers.
			client.write('#:ZZZ##:GR#', 'ascii')

			expect(await response).toBe('01:02:03#')
		},
		makeHandler({ rightAscension: () => hms(1, 2, 3) }),
	)
})

async function withLx200Server(run: (client: Socket) => Promise<void>, handler = makeHandler(), options: Omit<ConstructorParameters<typeof Lx200ProtocolServer>[0], 'handler'> = {}) {
	const server = new Lx200ProtocolServer({ handler, ...options })
	server.start('127.0.0.1', 0)

	const client = await connectClient(server.port)

	try {
		await run(client)
	} finally {
		client.destroy()
		server.stop()
	}
}

function makeHandler(overrides: Partial<Lx200ProtocolHandler> = {}): Lx200ProtocolHandler {
	const dateTime = [temporalFromDate(2026, 1, 1), 0] as const

	return {
		rightAscension: () => 0,
		declination: () => 0,
		longitude: () => 0,
		latitude: () => 0,
		dateTime: () => dateTime,
		tracking: () => false,
		parked: () => false,
		slewing: () => false,
		slewRate: () => {},
		...overrides,
	}
}

function connectClient(port: number) {
	return new Promise<Socket>((resolve, reject) => {
		const client = new Socket()

		client.once('error', reject)
		client.connect(port, '127.0.0.1', () => {
			client.off('error', reject)
			resolve(client)
		})
	})
}

async function waitFor(predicate: () => boolean) {
	const timeoutAt = Date.now() + 2000

	while (!predicate()) {
		if (Date.now() >= timeoutAt) {
			throw new Error('timed out waiting for LX200 callback')
		}

		await Bun.sleep(1)
	}
}

function readUntil(client: Socket, predicate: (value: string) => boolean) {
	return new Promise<string>((resolve, reject) => {
		let output = ''

		const timeout = setTimeout(() => {
			cleanup()
			reject(new Error(`timed out waiting for LX200 response, received ${JSON.stringify(output)}`))
		}, 2000)

		const cleanup = () => {
			clearTimeout(timeout)
			client.off('data', onData)
			client.off('error', onError)
		}

		const onData = (data: Buffer) => {
			output += data.toString('ascii')

			if (predicate(output)) {
				cleanup()
				resolve(output)
			}
		}

		const onError = (cause: Error) => {
			cleanup()
			reject(cause)
		}

		client.on('data', onData)
		client.once('error', onError)
	})
}
