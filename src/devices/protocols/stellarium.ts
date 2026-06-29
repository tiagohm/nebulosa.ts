import type { Socket, TCPSocketListener } from 'bun'
import { eraAnpm } from '../../astronomy/coordinates/erfa/erfa'
import { HealpixIndex, type HealpixIndexOptions } from '../../astronomy/sky/spatial/healpix'
import type { StarCatalogEntry } from '../../catalogs/stars/catalog'
import { PI } from '../../core/constants'
import type { Source } from '../../io/io'
import { type Angle, deg, mas, normalizeAngle } from '../../math/units/angle'
import { type Distance, parsec } from '../../math/units/distance'

// Server for Stellarium's telescope-control TCP protocol (lets Stellarium send goto targets and show the
// current position), plus readers for Stellarium's binary deep-sky catalog (catalog.dat) and name
// (names.dat) files and a HEALPix-indexed catalog built from them. Coordinates are radians.

// Callbacks the Stellarium server uses: connect/disconnect notifications and the goto target (radians).
export interface StellariumProtocolHandler {
	readonly connect?: (server: StellariumProtocolServer) => void
	readonly goto?: (server: StellariumProtocolServer, ra: Angle, dec: Angle) => void
	readonly disconnect?: (server: StellariumProtocolServer) => void
}

// Server options: the handler.
export interface StellariumProtocolServerOptions {
	handler: StellariumProtocolHandler
}

// TCP server speaking the Stellarium telescope protocol. Decodes goto requests and broadcasts the
// current coordinates as the protocol's 24-byte position messages.
// https://free-astro.org/images/b/b7/Stellarium_telescope_protocol.txt
// https://github.com/Stellarium/stellarium/blob/master/plugins/TelescopeControl/src/TelescopeClient.cpp
export class StellariumProtocolServer {
	readonly #sockets: Socket<unknown>[] = []
	#server?: TCPSocketListener

	constructor(readonly options: Readonly<StellariumProtocolServerOptions>) {}

	// Bound hostname/port, or undefined/-1 when stopped.
	get hostname() {
		return this.#server?.hostname
	}

	get port() {
		return this.#server?.port ?? -1
	}

	// Starts the TCP listener. Returns false if already started.
	start(hostname: string, port: number) {
		if (this.#server) return false

		this.#server = Bun.listen({
			hostname,
			port,
			allowHalfOpen: false,
			socket: {
				data: (_, data) => {
					this.#processData(data)
				},
				open: (socket) => {
					console.info('connection open')
					this.#sockets.push(socket)
					this.options.handler.connect?.(this)
				},
				close: (socket) => {
					console.warn('connection closed')
					const index = this.#sockets.indexOf(socket)
					if (index >= 0) this.#sockets.splice(index, 1)
					this.options.handler.disconnect?.(this)
				},
				error: (_, error) => {
					console.error('socket error:', error)
				},
				connectError: (_, error) => {
					console.error('connection failed:', error)
				},
				timeout: () => {
					console.warn('connection timed out')
				},
			},
		})

		return true
	}

	// Stops the listener and drops all clients.
	stop() {
		this.#server?.stop(true)
		this.#server = undefined
		this.#sockets.length = 0
	}

	// Broadcasts the current position to all connected Stellarium clients, encoding RA/Dec (radians) as
	// the protocol's signed fixed-point values in a 24-byte message.
	send(ra: Angle, dec: Angle) {
		if (this.#sockets.length > 0) {
			const buffer = Buffer.allocUnsafe(24)
			buffer.writeInt16LE(24, 0) // length
			buffer.writeInt16LE(0, 2) // type
			// buffer.writeBigInt64LE(BigInt(Date.now() * 1000)) // time
			buffer.writeInt32LE(0, 4) // time (unused)
			buffer.writeInt32LE(0, 8) // time (unused)
			buffer.writeInt32LE(Math.trunc((eraAnpm(ra) / PI) * 0x80000000), 12)
			buffer.writeInt32LE(Math.trunc((dec / PI) * 0x80000000), 16)
			buffer.writeInt32LE(0, 20) // status = OK

			for (const socket of this.#sockets) {
				socket.write(buffer)
				socket.flush()
			}
		}
	}

	// Decodes an inbound goto message, converting the fixed-point RA/Dec back to radians and invoking the
	// handler.
	#processData(buffer: Buffer) {
		if (buffer.byteLength >= 20 && this.options.handler.goto) {
			const ra = normalizeAngle((buffer.readUInt32LE(12) * PI) / 0x80000000)
			const dec = (buffer.readInt32LE(16) * PI) / 0x80000000
			this.options.handler.goto(this, ra, dec)
		}
	}
}

// One deep-sky object from Stellarium's catalog: position/magnitude, morphology (axes, orientation,
// redshift, parallax, distance), and cross-catalog identifiers (NGC/IC/Messier and many others).
export interface StellariumCatalogEntry extends StarCatalogEntry {
	readonly id: number
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

// Deep-sky object classification used by Stellarium's catalog.
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

// Parser buffer size and the offset at which it is refilled (leaving room for the largest record).
// https://github.com/Stellarium/stellarium/blob/master/nebulae/default/catalog.dat
const STELLARIUM_CATALOG_BUFFER_SIZE = 64 * 1024
const STELLARIUM_CATALOG_REFILL_THRESHOLD = STELLARIUM_CATALOG_BUFFER_SIZE - 1024

// Streams deep-sky objects from a Stellarium binary catalog.dat source. Big-endian records carry
// position (radians), photometry, morphology, and many cross-catalog ids; values are converted to the
// library's units (degrees→radians, mas, parsec→AU). Magnitude falls back from V to B when V is absent.
export async function* readCatalogDat(source: Source): AsyncIterable<StellariumCatalogEntry> {
	const buffer = Buffer.allocUnsafe(STELLARIUM_CATALOG_BUFFER_SIZE)
	let position = 0
	let size = 0

	// Refill the parser buffer while preserving unread bytes to avoid overlapping source reads.
	async function read() {
		const remaining = size - position

		if (remaining > 0) buffer.copy(buffer, 0, position, size)

		position = 0
		size = remaining + (await source.read(buffer, remaining, buffer.byteLength - remaining))
		return size > 0
	}

	// Reads a big-endian uint32 and advances the cursor.
	function readInt() {
		const value = buffer.readUint32BE(position)
		position += 4
		return value
	}

	// Reads a big-endian double and advances the cursor.
	function readDouble() {
		const value = buffer.readDoubleBE(position)
		position += 8
		return value
	}

	const decoder = new TextDecoder('utf-16be', { ignoreBOM: true })

	// Reads a length-prefixed UTF-16BE string and advances the cursor.
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
		if (position > STELLARIUM_CATALOG_REFILL_THRESHOLD) {
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
		const magnitude = mV === 99 ? (mB === 99 ? undefined : mB) : mV

		yield { id, epoch: 2000, rightAscension, declination, magnitude, type, majorAxis, minorAxis, orientation, redshift, px, distance, mType, ngc, ic, m, c, b, sh2, vdb, rcw, ldn, lbn, cr, mel, pgc, ugc, ced, arp, vv, pk, png, snrg, aco, hcg, eso, vdbh, dwb, tr, st, ru, vdbha }
	}
}

// One common-name record from names.dat: catalog prefix, object id, and the human-readable name.
export interface StellariumNameEntry {
	readonly prefix: string
	readonly id: string
	readonly name: string
}

// Extracts the translatable name from a `_("...")` line, plus the names-parser buffer size and refill
// threshold.
const NAME_FORMAT_REGEX = /^_\("([^"]+)"\).*$/
const STELLARIUM_NAMES_BUFFER_SIZE = 1024
const STELLARIUM_NAMES_REFILL_THRESHOLD = 300

// Streams common-name entries from a Stellarium names.dat text source, skipping comments and lines
// without a parseable name. Each line packs a fixed-width prefix/id followed by the `_("name")` form.
export async function* readNamesDat(source: Source) {
	const buffer = Buffer.allocUnsafe(STELLARIUM_NAMES_BUFFER_SIZE)
	let position = 0
	let size = 0

	// Compacts unconsumed bytes to the front of the buffer and refills the tail from the source.
	// Returns false once the source is exhausted and nothing remains buffered.
	async function read() {
		const remaining = size - position

		if (remaining > 0) buffer.copy(buffer, 0, position, size)

		position = 0
		size = remaining + (await source.read(buffer, remaining, buffer.byteLength - remaining))
		return size > 0
	}

	// Ensures at least `n` bytes remain buffered ahead of the cursor, refilling if needed.
	async function checkAvailableSpaceToRead(n: number) {
		if (position > size - n) {
			if (!(await read())) return false
		}

		return true
	}

	// Returns the next newline-terminated line, or false at end of input.
	async function readLine() {
		if (!(await checkAvailableSpaceToRead(STELLARIUM_NAMES_REFILL_THRESHOLD))) return false

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

		const prefix = line.slice(0, 5).trim()
		const id = line.slice(5, 20).trim()
		const name = NAME_FORMAT_REGEX.exec(line.slice(20).trim())?.[1] ?? ''

		if (!name) continue

		yield { prefix, id, name } as StellariumNameEntry
	}
}

// HEALPix-indexed deep-sky catalog built from a Stellarium catalog.dat source, enabling spatial
// cone/neighbour queries over the loaded entries. Default nside=8 trades resolution for memory.
export class StellariumCatalog extends HealpixIndex<StellariumCatalogEntry> {
	constructor({ nside = 8, ordering }: Partial<HealpixIndexOptions> = {}) {
		super({ nside, ordering })
	}

	// Streams every entry from `source` and indexes it by HEALPix cell using its RA/dec (radians).
	async load(source: Source) {
		for await (const entry of readCatalogDat(source)) {
			this.add(entry.id, entry.rightAscension, entry.declination, entry)
		}
	}
}
