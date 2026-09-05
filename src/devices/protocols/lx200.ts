import type { Socket, TCPSocketListener } from 'bun'
import { formatTemporal, type Temporal, type TemporalDate, temporalAdd, temporalFromDate } from '../../astronomy/time/temporal'
import { type Angle, parseAngle, toDms, toHms } from '../../math/units/angle'

// Server implementing the Meade LX200 serial command protocol over TCP, so LX200-speaking clients (e.g.
// planetarium apps) can drive a mount. Parses the '#'-framed ASCII commands, delegates reads/actions to a
// handler, and writes the protocol's ASCII responses. Coordinates exchanged with the handler are J2000.
// http://www.company7.com/library/meade/LX200CommandSet.pdf
// https://soundstepper.sourceforge.net/LX200_Compatible_Commands.html
// https://www.cloudynights.com/topic/72166-lx-200-gps-serial-commands/

// Manual-slew direction.
export type MoveDirection = 'NORTH' | 'SOUTH' | 'EAST' | 'WEST'

// Slew-rate preset (centering, guiding, finding, max).
export type SlewRate = 'CENTER' | 'GUIDE' | 'FIND' | 'MAX'

// Callbacks the server uses to read mount state and perform actions. Read coordinates are J2000 radians;
// optional action callbacks may be omitted for read-only mounts.
export interface Lx200ProtocolHandler {
	readonly connect?: (server: Lx200ProtocolServer) => void
	readonly rightAscension: (server: Lx200ProtocolServer) => Angle // J2000
	readonly declination: (server: Lx200ProtocolServer) => Angle // J2000
	readonly longitude: (server: Lx200ProtocolServer, longitude?: Angle) => Angle
	readonly latitude: (server: Lx200ProtocolServer, latitude?: Angle) => Angle
	readonly dateTime: (server: Lx200ProtocolServer, date?: readonly [Temporal, number]) => readonly [Temporal, number]
	readonly tracking: (server: Lx200ProtocolServer) => boolean
	readonly parked: (server: Lx200ProtocolServer) => boolean
	readonly slewing: (server: Lx200ProtocolServer) => boolean
	readonly slewRate: (server: Lx200ProtocolServer, rate: SlewRate) => void
	readonly sync?: (server: Lx200ProtocolServer, rightAscension: Angle, declination: Angle) => void
	readonly goto?: (server: Lx200ProtocolServer, rightAscension: Angle, declination: Angle) => void
	readonly move?: (server: Lx200ProtocolServer, direction: MoveDirection, enabled: boolean) => void
	readonly abort?: (server: Lx200ProtocolServer) => void
	readonly disconnect?: (server: Lx200ProtocolServer) => void
}

// Server options: the handler plus the product name/firmware version reported to clients.
export interface Lx200ProtocolServerOptions {
	handler: Lx200ProtocolHandler
	name?: string
	version?: string
}

// Single-byte protocol responses (ACK 'G', success '1', failure '0') and the alignment-query request byte.
const ACK = Buffer.from([71]) // G
const ONE = Buffer.from([49]) // 1
const ZERO = Buffer.from([48]) // 0
const ACK_REQUEST = '\u0006'

// Date/time response formats used by the protocol.
const DATE_FORMAT = 'MM/DD/YY'
const TIME_FORMAT = 'HH:mm:ss'

// Meade Telescope Serial Command Protocol Server.
export class Lx200ProtocolServer {
	readonly #sockets: Socket<unknown>[] = []
	// Per-socket accumulation of the partially-received command string.
	readonly #commands = new Map<Socket<unknown>, string>()
	#server?: TCPSocketListener

	// Staged target coordinates (radians) and the date/time/offset assembled across the set-time sequence.
	readonly #coordinates: [Angle, Angle] = [0, 0]
	readonly #utc: TemporalDate = [2025, 1, 1, 0, 0, 0, 0]
	#utcOffset = 0
	#utcStep = 0

	constructor(readonly options: Readonly<Lx200ProtocolServerOptions>) {}

	// Bound hostname/port, or undefined/-1 when stopped.
	get hostname() {
		return this.#server?.hostname
	}

	get port() {
		return this.#server?.port ?? -1
	}

	// Starts the TCP listener, seeding the staged coordinates from the handler on connect. Returns false if
	// already started.
	start(hostname: string, port: number) {
		if (this.#server) return false

		this.#server = Bun.listen({
			hostname,
			port,
			allowHalfOpen: false,
			socket: {
				data: (socket, data) => {
					this.#processData(socket, data)
				},
				open: (socket) => {
					console.info('connection open')
					this.#sockets.push(socket)
					this.options.handler.connect?.(this)

					this.#coordinates[0] = this.options.handler.rightAscension(this)
					this.#coordinates[1] = this.options.handler.declination(this)
				},
				close: (socket) => {
					console.warn('connection closed')
					const index = this.#sockets.indexOf(socket)
					if (index >= 0) this.#sockets.splice(index, 1)
					this.#commands.delete(socket)
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

	// Stops the listener and drops all client/command state.
	stop() {
		this.#server?.stop(true)
		this.#server = undefined
		this.#sockets.length = 0
		this.#commands.clear()
	}

	// Accumulates received bytes into '#'-framed commands per socket, answering bare ACK requests
	// immediately and dispatching each complete command.
	#processData(socket: Socket<unknown>, data: Buffer) {
		let command = this.#commands.get(socket) ?? ''

		for (const char of data.toString('ascii')) {
			if (char === ACK_REQUEST) {
				if (command === '#') command = ''
				this.#ack(socket)
				continue
			}

			if (command.length === 0 && char !== '#') continue

			command += char

			if (char === '#' && command.length > 1) {
				this.#processCommand(socket, command)
				command = ''
			}
		}

		if (command.length === 0) this.#commands.delete(socket)
		else this.#commands.set(socket, command)
	}

	// Decodes one complete LX200 command and writes its response. Get* commands read via the handler;
	// Set* commands stage target/site/time values; motion/slew commands invoke the handler actions. The
	// per-case comments name each command.
	#processCommand(socket: Socket<unknown>, command: string) {
		// console.debug('command received', command)

		switch (command) {
			// Get Telescope Product Name
			case '#:GVP#':
				return this.#text(socket, `${this.options.name || 'LX200'}#`)
			// Get Telescope Firmware Number
			case '#:GVN#':
				return this.#text(socket, `${this.options.version || 'v1.0'}#`)
			// Get Telescope Firmware Date
			case '#:GVD#':
				return this.#text(socket, 'Jan 01 2025#')
			// Get Telescope Firmware Time
			case '#:GVT#':
				return this.#text(socket, '00:00:00#')
			// Get Telescope RA
			case '#:GR#':
				return this.#rightAscension(socket)
			// Get Telescope DEC
			case '#:GD#':
				return this.#declination(socket)
			// Get Current Site Longitude
			case '#:Gg#':
				return this.#longitude(socket)
			// Get Current Site Latitude
			case '#:Gt#':
				return this.#latitude(socket)
			// Get current date
			case '#:GC#':
				return this.#date(socket)
			// Get Local Time in 24 hour format
			case '#:GL#':
				return this.#time(socket)
			// Get UTC offset time
			case '#:GG#':
				return this.#zoneOffset(socket)
			// Returns status of the Scope
			case '#:GW#':
				return this.#status(socket)
			// Requests a string of bars indicating the distance to the current library object
			case '#:D#':
				return this.#slewing(socket)
			// Synchronizes the telescope's position with the currently selected database object's coordinates
			case '#:CM#':
				this.options.handler.sync?.(this, ...this.#coordinates)
				return this.#zero(socket)
			// Slew to Target Object
			case '#:MS#':
				this.options.handler.goto?.(this, ...this.#coordinates)
				return this.#zero(socket)
			// Move/Halt Telescope
			case '#:Me#':
			case '#:Mn#':
			case '#:Ms#':
			case '#:Mw#':
			case '#:Qe#':
			case '#:Qn#':
			case '#:Qs#':
			case '#:Qw#':
				this.options.handler.move?.(this, command[3] === 'n' ? 'NORTH' : command[3] === 's' ? 'SOUTH' : command[3] === 'e' ? 'EAST' : 'WEST', command[2] === 'M')
				return
			// Halt all current slewing
			case '#:Q#':
				this.options.handler.abort?.(this)
				return
			// Slew Rate Commands (Centering, Guiding, Finding, Max)
			case '#:RC#':
			case '#:RG#':
			case '#:RM#':
			case '#:RS#':
				this.options.handler.slewRate(this, command[3] === 'C' ? 'CENTER' : command[3] === 'G' ? 'GUIDE' : command[3] === 'M' ? 'FIND' : 'MAX')
				return
			default:
				// Set target object RA
				if (command.startsWith('#:Sr')) {
					const ra = parseAngle(command.slice(4), true)
					if (ra !== undefined) this.#coordinates[0] = ra
					return this.#one(socket)
				}
				// Set target object declination
				else if (command.startsWith('#:Sd')) {
					const dec = parseAngle(command.slice(4))
					if (dec !== undefined) this.#coordinates[1] = dec
					return this.#one(socket)
				}
				// Set current site’s longitude
				else if (command.startsWith('#:Sg')) {
					const longitude = parseAngle(command.slice(4))
					if (longitude !== undefined) this.options.handler.longitude(this, -longitude)
					return this.#one(socket)
				}
				// Sets the current site latitude
				else if (command.startsWith('#:St')) {
					const latitude = parseAngle(command.slice(4))
					if (latitude !== undefined) this.options.handler.latitude(this, latitude)
					return this.#one(socket)
				}
				// Set the number of hours added to local time to yield UTC
				else if (command.startsWith('#:SG')) {
					const hours = -Number(command.slice(4, command.length - 1))
					this.#utcOffset = Math.trunc(hours * 60)
					this.#handleDateTimeAndOffset()
					return this.#one(socket)
				}
				// Set the local Time
				else if (command.startsWith('#:SL')) {
					const [h, m, s] = command.slice(4, command.length - 1).split(':')
					this.#utc[3] = +h
					this.#utc[4] = +m
					this.#utc[5] = +s
					this.#handleDateTimeAndOffset()
					return this.#one(socket)
				}
				// Change Handbox Date to MM/DD/YY
				else if (command.startsWith('#:SC')) {
					const [m, d, y] = command.slice(4, command.length - 1).split('/')
					this.#utc[0] = 2000 + +y
					this.#utc[1] = +m
					this.#utc[2] = +d
					this.#handleDateTimeAndOffset()
					return this.#text(socket, '1Updating planetary data       #                              #')
				}

				console.warn('unknown command', command)

				break
		}
	}

	// Writes the alignment-query ACK byte ('G' = German equatorial).
	#ack(socket: Socket<unknown>) {
		socket.write(ACK)
	}

	// Writes the success ('1') / failure ('0') status byte.
	#one(socket: Socket<unknown>) {
		socket.write(ONE)
	}

	#zero(socket: Socket<unknown>) {
		socket.write(ZERO)
	}

	// Writes an ASCII text response.
	#text(socket: Socket<unknown>, value: string) {
		socket.write(Buffer.from(value, 'ascii'))
	}

	// Commits the staged date/time to the handler once all three of the date/time/offset set-commands have
	// arrived (LX200 sends them separately), converting local time + offset to UTC.
	#handleDateTimeAndOffset() {
		this.#utcStep++

		if (this.#utcStep >= 3) {
			this.#utcStep = 0
			this.options.handler.dateTime(this, [temporalAdd(temporalFromDate(...this.#utc), -this.#utcOffset, 'm'), this.#utcOffset])
		}
	}

	// Writes the RA as HH:MM:SS#.
	#rightAscension(socket: Socket<unknown>) {
		const [h, m, s] = roundSexagesimal(...toHms(this.options.handler.rightAscension(this)), 24)
		const command = `${formatNumber(h)}:${formatNumber(m)}:${formatNumber(s)}#`
		this.#text(socket, command)
	}

	// Writes the declination as sDD*MM:SS#.
	#declination(socket: Socket<unknown>) {
		const [d, m, s, neg] = toDms(this.options.handler.declination(this))
		const [dd, mm, ss] = roundSexagesimal(d, m, s)
		const command = `${neg < 0 ? '-' : '+'}${formatNumber(dd)}*${formatNumber(mm)}:${formatNumber(ss)}#`
		this.#text(socket, command)
	}

	// Writes the site longitude as sDDD*MM# (sign inverted to LX200's west-positive convention).
	#longitude(socket: Socket<unknown>) {
		const [d, m, s, neg] = toDms(this.options.handler.longitude(this))
		const [dd, mm] = roundDegreeMinute(d, m, s, 360)
		const command = `${neg < 0 ? '+' : '-'}${formatNumber(dd, 3)}*${formatNumber(mm)}#`
		this.#text(socket, command)
	}

	// Writes the site latitude as sDD*MM#.
	#latitude(socket: Socket<unknown>) {
		const [d, m, s, neg] = toDms(this.options.handler.latitude(this))
		const [dd, mm] = roundDegreeMinute(d, m, s)
		const command = `${neg < 0 ? '-' : '+'}${formatNumber(dd)}*${formatNumber(mm)}#`
		this.#text(socket, command)
	}

	// Writes the local date as MM/DD/YY#.
	#date(socket: Socket<unknown>) {
		const command = `${formatTemporal(this.options.handler.dateTime(this)[0], DATE_FORMAT)}#`
		this.#text(socket, command)
	}

	// Writes the local time as HH:MM:SS#.
	#time(socket: Socket<unknown>) {
		const command = `${formatTemporal(this.options.handler.dateTime(this)[0], TIME_FORMAT)}#`
		this.#text(socket, command)
	}

	// Writes the UTC offset in hours as sHH.H# (sign inverted to LX200's hours-to-add convention).
	#zoneOffset(socket: Socket<unknown>) {
		const [, offset] = this.options.handler.dateTime(this)
		const command = `${offset < 0 ? '+' : '-'}${formatNumber(Math.abs(offset) / 60, 4, 1)}#`
		this.#text(socket, command)
	}

	// Writes the scope status string: alignment type, tracking (T/N), and parked/home (P/H).
	#status(socket: Socket<unknown>, type: string = 'G') {
		const a = this.options.handler.tracking(this)
		const b = this.options.handler.parked(this)
		const command = `${type}${a ? 'T' : 'N'}${b ? 'P' : 'H'}#`
		this.#text(socket, command)
	}

	// Writes a slewing indicator: a bar while slewing, empty when settled.
	#slewing(socket: Socket<unknown>) {
		const s = this.options.handler.slewing(this)
		const command = `${s ? '|' : ''}#`
		this.#text(socket, command)
	}
}

// Zero-pads a number to a minimum width with optional fractional digits.
function formatNumber(value: number, maxLength: number = 2, fractionDigits: number = 0) {
	return value.toFixed(fractionDigits).padStart(maxLength, '0')
}

// Rounds an HMS/DMS triple to integer seconds, carrying into minutes/primary and optionally wrapping the
// primary field (e.g. 24 h or 360°).
function roundSexagesimal(primary: number, minutes: number, seconds: number, wrapPrimary?: number): readonly [number, number, number] {
	let p = primary
	let m = minutes
	let s = Math.round(seconds)

	if (s >= 60) {
		s = 0
		m++
	}

	if (m >= 60) {
		m = 0
		p++
	}

	if (wrapPrimary !== undefined && p >= wrapPrimary) {
		p = 0
	}

	return [p, m, s] as const
}

// Rounds a DMS triple to degrees and integer minutes, carrying and optionally wrapping the degree field.
function roundDegreeMinute(degrees: number, minutes: number, seconds: number, wrapDegrees?: number): readonly [number, number] {
	let d = degrees
	let m = Math.round(minutes + seconds / 60)

	if (m >= 60) {
		m = 0
		d++
	}

	if (wrapDegrees !== undefined && d >= wrapDegrees) {
		d = 0
	}

	return [d, m] as const
}
