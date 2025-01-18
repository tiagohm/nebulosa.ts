import type { Socket, TCPSocketListener } from 'bun'
import { deg, mas, normalize, type Angle } from './angle'
import { PI } from './constants'
import { eraAnpm } from './erfa'
import type { Seekable, Source } from './io'

export interface StellariumProtocolHandler {
	connect?: () => void
	goto?: (ra: Angle, dec: Angle) => void
	close?: () => void
}

export interface StellariumProtocolServerOptions {
	protocol?: StellariumProtocolHandler
}

// https://free-astro.org/images/b/b7/Stellarium_telescope_protocol.txt
// https://github.com/Stellarium/stellarium/blob/master/plugins/TelescopeControl/src/TelescopeClient.cpp

export class StellariumProtocolServer {
	private readonly sockets: Socket<unknown>[] = []
	private server?: TCPSocketListener

	constructor(
		private readonly host: string,
		private readonly port: number,
		private readonly options?: StellariumProtocolServerOptions,
	) {}

	start() {
		if (this.server) return

		this.server = Bun.listen({
			hostname: this.host,
			port: this.port,
			allowHalfOpen: false,
			socket: {
				data: (_, data) => {
					this.handleData(data)
				},
				open: (socket) => {
					console.info('connection open')
					this.sockets.push(socket)
					this.options?.protocol?.connect?.()
				},
				close: (socket) => {
					console.warn('connection closed')
					const index = this.sockets.indexOf(socket)
					if (index >= 0) this.sockets.splice(index, 1)
					this.options?.protocol?.close?.()
				},
				error: (_, error) => {
					console.error('connection failed', error)
				},
				timeout: () => {
					console.warn('connection timed out')
				},
			},
		})
	}

	stop() {
		this.server?.stop(true)
		this.server = undefined
		this.sockets.length = 0
	}

	send(ra: Angle, dec: Angle) {
		if (this.sockets.length) {
			const buffer = Buffer.allocUnsafe(24)
			buffer.writeInt16LE(24, 0) // length
			buffer.writeInt16LE(0, 2) // type
			// buffer.writeBigInt64LE(BigInt(Date.now() * 1000)) // time
			buffer.writeInt32LE(0, 4) // time (unused)
			buffer.writeInt32LE(0, 8) // time (unused)
			buffer.writeInt32LE(Math.trunc((eraAnpm(ra) / PI) * 0x80000000), 12)
			buffer.writeInt32LE(Math.trunc((dec / PI) * 0x80000000), 16)
			buffer.writeInt32LE(0, 20) // status = OK

			for (const socket of this.sockets) {
				socket.write(buffer)
				socket.flush()
			}
		}
	}

	private handleData(buffer: Buffer) {
		if (buffer.byteLength >= 20 && this.options?.protocol?.goto) {
			const ra = normalize((buffer.readUInt32LE(12) * PI) / 0x80000000)
			const dec = (buffer.readInt32LE(16) * PI) / 0x80000000
			this.options.protocol.goto(ra, dec)
		}
	}
}

export interface CatalogEntry {
	readonly id: number
	readonly ra: Angle
	readonly dec: Angle
	readonly mB: number
	readonly mV: number
	readonly type: number
	readonly majorAxis: Angle
	readonly minorAxis: Angle
	readonly orientation: Angle
	readonly redshift: number
	readonly parallax: Angle
	readonly ngc: number
	readonly ic: number
	readonly m: number
	readonly c: number
	readonly b: number
	readonly sh2: number
	readonly vdb: number
	readonly rcw: number
	readonly ldn: number
	readonly lbn: number
	readonly cr: number
	readonly mel: number
	readonly pgc: number
	readonly ugc: number
	readonly ced: string
	readonly arp: number
	readonly vv: number
	readonly pk: string
	readonly png: string
	readonly snrg: string
	readonly aco: string
	readonly hcg: string
	readonly eso: string
	readonly vdbh: string
	readonly dwb: number
	readonly tr: number
	readonly st: number
	readonly ru: number
	readonly vdbha: number
}

export enum ObjectType {
	UNKNOWN,
	GALAXY,
	ACTIVE_GALAXY,
	RADIO_GALAXY,
	INTERACTING_GALAXY,
	QUASAR,
	STAR_CLUSTER,
	OPEN_STAR_CLUSTER,
	GLOBULAR_STAR_CLUSTER,
	STELLAR_ASSOCIATION,
	STAR_CLOUD,
	NEBULA,
	PLANETARY_NEBULA,
	DARK_NEBULA,
	REFLECTION_NEBULA,
	BIPOLAR_NEBULA,
	EMISSION_NEBULA,
	CLUSTER_ASSOCIATED_WITH_NEBULOSITY,
	HII_REGION,
	SUPERNOVA_REMNANT,
	INTERSTELLAR_MATTER,
	EMISSION_OBJECT,
	BL_LACERTAE_OBJECT,
	BLAZAR,
	MOLECULAR_CLOUD,
	YOUNG_STELLAR_OBJECT,
	POSSIBLE_QUASAR,
	POSSIBLE_PLANETARY_NEBULA,
	PROTOPLANETARY_NEBULA,
	STAR,
	SYMBIOTIC_STAR,
	EMISSION_LINE_STAR,
	SUPERNOVA_CANDIDATE,
	SUPER_NOVA_REMNANT_CANDIDATE,
	CLUSTER_OF_GALAXIES,
	PART_OF_GALAXY,
	REGION_OF_THE_SKY,
}

export async function* catalog(source: Source & Seekable) {
	const buffer = Buffer.allocUnsafe(1024)
	let position = 0
	let size = 0

	async function read() {
		position = 0
		size = await source.read(buffer)
	}

	async function checkAvailableSpaceToRead(n: number) {
		if (position > size - n) {
			source.seek(source.position - size + position)
			await read()

			if (size === 0) return false
			if (position > size - n) throw new Error('unexpected end of file')
		}

		return true
	}

	async function readInt() {
		await checkAvailableSpaceToRead(4)
		const value = buffer.readUint32BE(position)
		position += 4
		return value
	}

	async function readDouble() {
		await checkAvailableSpaceToRead(8)
		const value = buffer.readDoubleBE(position)
		position += 8
		return value
	}

	const decoder = new TextDecoder('utf-16be', { ignoreBOM: true })

	async function readText() {
		const n = await readInt()
		await checkAvailableSpaceToRead(n)

		if (n > 0) {
			const value = decoder.decode(buffer.subarray(position, position + n))
			position += n
			return value
		} else {
			return ''
		}
	}

	await read()

	await readText() // version
	await readText() // edition

	while (true) {
		if (!(await checkAvailableSpaceToRead(4))) break

		const id = await readInt()
		const ra = await readDouble()
		const dec = await readDouble()
		const mB = await readDouble()
		const mV = await readDouble()
		const type = ((await readInt()) + 1) % 37
		await readText() // Morphological type
		const majorAxis = deg(await readDouble())
		const minorAxis = deg(await readDouble())
		const orientation = deg(await readInt())
		const redshift = await readDouble()
		await readDouble() // Redshift error
		const parallax = mas(await readDouble())
		await readDouble() // Parallax error
		await readDouble() // Distance
		await readDouble() // Distance error
		const ngc = await readInt()
		const ic = await readInt()
		const m = await readInt()
		const c = await readInt()
		const b = await readInt()
		const sh2 = await readInt()
		const vdb = await readInt()
		const rcw = await readInt()
		const ldn = await readInt()
		const lbn = await readInt()
		const cr = await readInt()
		const mel = await readInt()
		const pgc = await readInt()
		const ugc = await readInt()
		const ced = await readText()
		const arp = await readInt()
		const vv = await readInt()
		const pk = await readText()
		const png = await readText()
		const snrg = await readText()
		const aco = await readText()
		const hcg = await readText()
		const eso = await readText()
		const vdbh = await readText()
		const dwb = await readInt()
		const tr = await readInt()
		const st = await readInt()
		const ru = await readInt()
		const vdbha = await readInt()

		yield { id, ra, dec, mB, mV, type, majorAxis, minorAxis, orientation, redshift, parallax, ngc, ic, m, c, b, sh2, vdb, rcw, ldn, lbn, cr, mel, pgc, ugc, ced, arp, vv, pk, png, snrg, aco, hcg, eso, vdbh, dwb, tr, st, ru, vdbha } as CatalogEntry
	}
}

export function searchAround(entries: CatalogEntry[], ra: Angle, dec: Angle, fov: Angle) {
	const cdec = Math.cos(dec)
	const sdec = Math.sin(dec)

	function distance(ra0: Angle, dec0: Angle) {
		return Math.acos(sdec * Math.sin(dec0) + cdec * Math.cos(dec0) * Math.cos(ra - ra0))
	}

	return entries.filter((e) => distance(e.ra, e.dec) <= fov)
}
