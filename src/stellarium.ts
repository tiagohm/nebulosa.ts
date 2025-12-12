import type { Socket, TCPSocketListener } from 'bun'
import { type Angle, deg, mas, normalizeAngle } from './angle'
import { PI } from './constants'
import type { EquatorialCoordinate } from './coordinate'
import { type Distance, parsec } from './distance'
import { eraAnpm } from './erfa'
import type { Seekable, Source } from './io'

export interface StellariumProtocolHandler {
	connect?: (server: StellariumProtocolServer) => void
	goto?: (server: StellariumProtocolServer, ra: Angle, dec: Angle) => void
	disconnect?: (server: StellariumProtocolServer) => void
}

export interface StellariumProtocolServerOptions {
	handler: StellariumProtocolHandler
}

// https://free-astro.org/images/b/b7/Stellarium_telescope_protocol.txt
// https://github.com/Stellarium/stellarium/blob/master/plugins/TelescopeControl/src/TelescopeClient.cpp

export class StellariumProtocolServer {
	private readonly sockets: Socket<unknown>[] = []
	private server?: TCPSocketListener

	constructor(
		readonly host: string,
		readonly port: number,
		readonly options: Readonly<StellariumProtocolServerOptions>,
	) {}

	start() {
		if (this.server) return false

		this.server = Bun.listen({
			hostname: this.host,
			port: this.port,
			allowHalfOpen: false,
			socket: {
				data: (_, data) => {
					this.processData(data)
				},
				open: (socket) => {
					console.info('connection open')
					this.sockets.push(socket)
					this.options.handler.connect?.(this)
				},
				close: (socket) => {
					console.warn('connection closed')
					const index = this.sockets.indexOf(socket)
					if (index >= 0) this.sockets.splice(index, 1)
					this.options.handler.disconnect?.(this)
				},
				error: (_, error) => {
					console.error('connection failed', error)
				},
				timeout: () => {
					console.warn('connection timed out')
				},
			},
		})

		return true
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

	private processData(buffer: Buffer) {
		if (buffer.byteLength >= 20 && this.options.handler.goto) {
			const ra = normalizeAngle((buffer.readUInt32LE(12) * PI) / 0x80000000)
			const dec = (buffer.readInt32LE(16) * PI) / 0x80000000
			this.options.handler.goto(this, ra, dec)
		}
	}
}

export interface StellariumCatalogEntry extends Readonly<EquatorialCoordinate> {
	readonly id: number
	readonly mB: number
	readonly mV: number
	readonly type: StellariumObjectType
	readonly majorAxis: Angle
	readonly minorAxis: Angle
	readonly orientation: Angle
	readonly redshift: number
	readonly px: Angle
	readonly distance: Distance
	readonly mType?: string
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
	readonly ced?: string
	readonly arp: number
	readonly vv: number
	readonly pk?: string
	readonly png?: string
	readonly snrg?: string
	readonly aco?: string
	readonly hcg?: string
	readonly eso?: string
	readonly vdbh?: string
	readonly dwb: number
	readonly tr: number
	readonly st: number
	readonly ru: number
	readonly vdbha: number
}

export enum StellariumObjectType {
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

// https://github.com/Stellarium/stellarium/blob/master/nebulae/default/catalog.dat

export async function* readCatalogDat(source: Source & Seekable) {
	const buffer = Buffer.allocUnsafe(1024 * 32)
	let position = 0
	let size = 0

	async function read() {
		position = 0
		size = await source.read(buffer)
		return size > 0
	}

	function readInt() {
		const value = buffer.readUint32BE(position)
		position += 4
		return value
	}

	function readDouble() {
		const value = buffer.readDoubleBE(position)
		position += 8
		return value
	}

	const decoder = new TextDecoder('utf-16be', { ignoreBOM: true })

	function readText() {
		const n = readInt()

		if (n > 0) {
			const value = decoder.decode(buffer.subarray(position, position + n))
			position += n
			return value
		} else {
			return ''
		}
	}

	await read()

	readText() // version
	readText() // edition

	while (true) {
		if (position > 1024 * 31) {
			source.seek(source.position - size + position)
			if (!(await read())) break
		} else if (position >= size) {
			break
		}

		const id = readInt()
		const rightAscension = readDouble()
		const declination = readDouble()
		const mB = readDouble()
		const mV = readDouble()
		const type = (readInt() + 1) % 37
		const mType = readText() || undefined // Morphological type
		const majorAxis = deg(readDouble())
		const minorAxis = deg(readDouble())
		const orientation = deg(readInt())
		const redshift = readDouble()
		readDouble() // Redshift error
		const px = mas(readDouble())
		readDouble() // Parallax error
		const distance = parsec(readDouble() * 1000) // Distance
		readDouble() // Distance error
		const ngc = readInt()
		const ic = readInt()
		const m = readInt()
		const c = readInt()
		const b = readInt()
		const sh2 = readInt()
		const vdb = readInt()
		const rcw = readInt()
		const ldn = readInt()
		const lbn = readInt()
		const cr = readInt()
		const mel = readInt()
		const pgc = readInt()
		const ugc = readInt()
		const ced = readText() || undefined
		const arp = readInt()
		const vv = readInt()
		const pk = readText() || undefined
		const png = readText() || undefined
		const snrg = readText() || undefined
		const aco = readText() || undefined
		const hcg = readText() || undefined
		const eso = readText() || undefined
		const vdbh = readText() || undefined
		const dwb = readInt()
		const tr = readInt()
		const st = readInt()
		const ru = readInt()
		const vdbha = readInt()

		yield { id, rightAscension, declination, mB, mV, type, majorAxis, minorAxis, orientation, redshift, px, distance, mType, ngc, ic, m, c, b, sh2, vdb, rcw, ldn, lbn, cr, mel, pgc, ugc, ced, arp, vv, pk, png, snrg, aco, hcg, eso, vdbh, dwb, tr, st, ru, vdbha } as StellariumCatalogEntry
	}
}

export interface StellariumNameEntry {
	readonly prefix: string
	readonly id: string
	readonly name: string
}

const NAME_FORMAT_REGEX = /^_\("([^"]+)"\).*$/

export async function* readNamesDat(source: Source & Seekable) {
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
		}

		return true
	}

	async function readLine() {
		if (!(await checkAvailableSpaceToRead(300))) return false

		const index = buffer.indexOf(0x0a, position)

		if (index >= 0) {
			const line = buffer.subarray(position, index).toString('utf-8')
			position = index + 1
			return line
		}

		return false
	}

	await read()

	while (true) {
		const line = await readLine()

		if (!line) break
		if (line.startsWith('#')) continue

		const prefix = line.substring(0, 5).trim()
		const id = line.substring(5, 20).trim()
		const name = NAME_FORMAT_REGEX.exec(line.substring(20).trim())?.[1] ?? ''

		if (!name) continue

		yield { prefix, id, name } as StellariumNameEntry
	}
}

export function searchAround(entries: Pick<StellariumCatalogEntry, 'rightAscension' | 'declination'>[], rightAscension: Angle, declination: Angle, fov: Angle) {
	const cdec = Math.cos(declination)
	const sdec = Math.sin(declination)

	function distance(ra0: Angle, dec0: Angle) {
		return Math.acos(sdec * Math.sin(dec0) + cdec * Math.cos(dec0) * Math.cos(rightAscension - ra0))
	}

	return entries.filter((e) => distance(e.rightAscension, e.declination) <= fov)
}
