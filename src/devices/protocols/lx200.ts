import type { Socket, TCPSocketListener } from 'bun'
import { daysInMonth, formatTemporal, type Temporal, type TemporalDate, temporalAdd, temporalFromDate } from '../../astronomy/time/temporal'
import { type Angle, normalizePI, parseAngle, toDms, toHms } from '../../math/units/angle'
import { type ProtocolClient, type ProtocolClientEntry, ProtocolClients } from './client'

// Server implementing the Meade LX200 serial command protocol over TCP, so LX200-speaking clients (e.g.
// planetarium apps) can drive a mount. Parses the '#'-framed ASCII commands, delegates reads/actions to a
// handler, and writes the protocol's ASCII responses. Coordinates exchanged with the handler are J2000.
// Several clients may connect at once; each has its own staged target and clock, so one client never
// completes a command another one is assembling, and actions are reported with the client that sent them.
// http://www.company7.com/library/meade/LX200CommandSet.pdf
// https://soundstepper.sourceforge.net/LX200_Compatible_Commands.html
// https://www.cloudynights.com/topic/72166-lx-200-gps-serial-commands/

// Manual-slew direction.
export type MoveDirection = 'NORTH' | 'SOUTH' | 'EAST' | 'WEST'

// Slew-rate preset (centering, guiding, finding, max).
export type SlewRate = 'CENTER' | 'GUIDE' | 'FIND' | 'MAX'

// Callbacks the server uses to read mount state and perform actions. Read coordinates are J2000 radians;
// optional action callbacks may be omitted for read-only mounts. Action callbacks receive the client that sent
// the command as their last argument.
export interface Lx200ProtocolHandler {
	// A client connected; runs for every client.
	readonly connect?: (server: Lx200ProtocolServer) => void
	// A client connected, with its identity; runs for every client, after connect.
	readonly clientOpen?: (server: Lx200ProtocolServer, client: ProtocolClient) => void
	readonly rightAscension: (server: Lx200ProtocolServer) => Angle // J2000
	readonly declination: (server: Lx200ProtocolServer) => Angle // J2000
	// Site longitude in radians, east positive; also called with the value of :Sg# when setLongitude is absent.
	readonly longitude: (server: Lx200ProtocolServer, longitude?: Angle) => Angle
	// Site latitude in radians, north positive; also called with the value of :St# when setLatitude is absent.
	readonly latitude: (server: Lx200ProtocolServer, latitude?: Angle) => Angle
	// Applies the site longitude of :Sg#, in radians east positive within (-π, π]; returning false answers 0.
	readonly setLongitude?: (server: Lx200ProtocolServer, longitude: Angle, client: ProtocolClient) => boolean | void
	// Applies the site latitude of :St#, in radians north positive; returning false answers 0.
	readonly setLatitude?: (server: Lx200ProtocolServer, latitude: Angle, client: ProtocolClient) => boolean | void
	readonly dateTime: (server: Lx200ProtocolServer, date?: readonly [Temporal, number]) => readonly [Temporal, number]
	readonly tracking: (server: Lx200ProtocolServer) => boolean
	readonly parked: (server: Lx200ProtocolServer) => boolean
	readonly slewing: (server: Lx200ProtocolServer) => boolean
	readonly slewRate: (server: Lx200ProtocolServer, rate: SlewRate, client: ProtocolClient) => void
	// Syncs on the client's staged J2000 target; returning false reports to the client that the sync failed.
	readonly sync?: (server: Lx200ProtocolServer, rightAscension: Angle, declination: Angle, client: ProtocolClient) => boolean | void
	// Starts a slew to the client's staged J2000 target; returning false reports to the client that the slew is not possible.
	readonly goto?: (server: Lx200ProtocolServer, rightAscension: Angle, declination: Angle, client: ProtocolClient) => boolean | void
	readonly move?: (server: Lx200ProtocolServer, direction: MoveDirection, enabled: boolean, client: ProtocolClient) => void
	readonly abort?: (server: Lx200ProtocolServer, client: ProtocolClient) => void
	// A client disconnected, with its identity; runs exactly once for every client, before disconnect.
	readonly clientClose?: (server: Lx200ProtocolServer, client: ProtocolClient) => void
	// The last connected client disconnected.
	readonly disconnect?: (server: Lx200ProtocolServer) => void
}

// Server options: the handler plus the product name/firmware version reported to clients.
export interface Lx200ProtocolServerOptions {
	handler: Lx200ProtocolHandler
	name?: string
	version?: string
	// Refuses the clock setters (:SG#, :SL#, :SC#) with 0 without calling the handler, for a mount whose time must not
	// be changed by clients; the getters still read the handler.
	readOnlyTime?: boolean
}

// Command assembly state of one client: the partially received command, the staged target, and the date,
// time, and offset assembled across the three-part set-time sequence.
interface Lx200ClientState {
	// Characters of the command received so far, starting with ':' or '#'; empty between commands.
	command: string
	// Staged target right ascension and declination, J2000 radians.
	readonly coordinates: [Angle, Angle]
	// Local date and time staged by :SC# and :SL#.
	readonly utc: TemporalDate
	// Offset of local time from UTC in minutes staged by :SG#.
	utcOffset: number
	// Number of clock setters received since the clock was last committed.
	utcStep: number
}

// Single-byte protocol responses (ACK 'G', success '1', failure '0') and the alignment-query request byte.
const ACK = Buffer.from([71]) // G
const ONE = Buffer.from([49]) // 1
const ZERO = Buffer.from([48]) // 0
const ACK_REQUEST = '\u0006'

// Longest command, in characters, a client may send. The longest valid one (:SC with its date, or a target
// setter) has about a dozen, so a longer one is garbage and its client is closed instead of being buffered.
const LX200_MAX_COMMAND_LENGTH = 64

// Date/time response formats used by the protocol.
const DATE_FORMAT = 'MM/DD/YY'
const TIME_FORMAT = 'HH:mm:ss'

// Meade Telescope Serial Command Protocol Server.
export class Lx200ProtocolServer {
	// Clients of the current run, replaced on every start.
	#clients = new ProtocolClients<Lx200ClientState>()
	#server?: TCPSocketListener

	constructor(readonly options: Readonly<Lx200ProtocolServerOptions>) {}

	// Bound hostname/port, or undefined/-1 when stopped.
	get hostname() {
		return this.#server?.hostname
	}

	get port() {
		return this.#server?.port ?? -1
	}

	// Starts the TCP listener, seeding each client's staged target with the handler's position when it connects.
	// Returns false if already started; throws the bind error (such as EADDRINUSE) when the address cannot be used.
	start(hostname: string, port: number) {
		if (this.#server) return false

		// Callbacks of this run only ever reach this run's clients, so a socket of a stopped run arriving late
		// cannot touch a server started again meanwhile.
		const clients = new ProtocolClients<Lx200ClientState>()

		this.#server = Bun.listen({
			hostname,
			port,
			allowHalfOpen: false,
			socket: {
				data: (socket, data) => {
					const entry = clients.get(socket)
					if (entry) this.#processData(clients, entry, data)
				},
				open: (socket) => {
					console.info('connection open')
					const { handler } = this.options
					const entry = clients.add(socket, { command: '', coordinates: [handler.rightAscension(this), handler.declination(this)], utc: [2025, 1, 1, 0, 0, 0, 0], utcOffset: 0, utcStep: 0 })
					handler.connect?.(this)
					handler.clientOpen?.(this, entry.client)
				},
				close: (socket) => {
					console.warn('connection closed')
					this.#closed(clients, socket)
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

		this.#clients = clients

		return true
	}

	// Stops the listener and closes every client, reporting each one closed and then the last disconnect.
	// Idempotent.
	stop() {
		const clients = this.#clients
		this.#clients = new ProtocolClients()
		this.#server?.stop(true)
		this.#server = undefined
		for (const entry of Array.from(clients.values())) this.#drop(clients, entry)
	}

	// Connected clients of the current run, in connection order.
	clients(): readonly ProtocolClient[] {
		return this.#clients.list()
	}

	// Closes the connection of one client, leaving the listener and the other clients untouched. The client is
	// reported closed before this returns. Returns false when no such client is connected.
	disconnectClient(id: string) {
		const entry = this.#clients.find(id)
		if (!entry) return false
		this.#drop(this.#clients, entry)
		return true
	}

	// Handles a socket closed by its peer or by the network.
	#closed(clients: ProtocolClients<Lx200ClientState>, socket: Socket<unknown>) {
		const entry = clients.delete(socket)
		if (entry) this.#notifyClosed(clients, entry.client)
	}

	// Removes a client, reports it closed, and ends its socket. The close callback that follows finds nothing to
	// remove, so the client is reported once.
	#drop(clients: ProtocolClients<Lx200ClientState>, entry: ProtocolClientEntry<Lx200ClientState>) {
		if (clients.delete(entry.socket) === undefined) return
		this.#notifyClosed(clients, entry.client)
		entry.socket.end()
	}

	// Reports one client closed, and the disconnection of the last one.
	#notifyClosed(clients: ProtocolClients<Lx200ClientState>, client: ProtocolClient) {
		this.options.handler.clientClose?.(this, client)
		if (clients.size === 0) this.options.handler.disconnect?.(this)
	}

	// Accumulates received bytes into '#'-framed commands per client, accepting both ':CMD#' and
	// '#:CMD#' forms, answering bare ACK requests immediately, and dispatching each complete command in the
	// order received. A command longer than LX200_MAX_COMMAND_LENGTH closes its client.
	#processData(clients: ProtocolClients<Lx200ClientState>, entry: ProtocolClientEntry<Lx200ClientState>, data: Buffer) {
		const { socket, state } = entry

		for (const char of data.toString('ascii')) {
			// A command may have closed the client, such as one whose handler disconnected it.
			if (clients.get(socket) !== entry) return

			if (char === ACK_REQUEST) {
				if (state.command === '#') state.command = ''
				this.#ack(socket)
				continue
			}

			if (state.command.length === 0) {
				if (char === ':' || char === '#') state.command = char
				continue
			}

			if (char === '#') {
				const command = state.command
				state.command = ''
				if (command !== '#') this.#processCommand(entry, `${command}#`)
				continue
			}

			if (state.command.length >= LX200_MAX_COMMAND_LENGTH) {
				console.warn('command too long, closing connection')
				this.#drop(clients, entry)
				return
			}

			state.command += char
		}
	}

	// Decodes one complete LX200 command and writes its response. Get* commands read via the handler;
	// Set* commands stage target/site/time values of the client; motion/slew commands invoke the handler
	// actions. The per-case comments name each command.
	#processCommand(entry: ProtocolClientEntry<Lx200ClientState>, rawCommand: string) {
		const { socket, state, client } = entry
		const command = rawCommand.startsWith('#') ? rawCommand.slice(1) : rawCommand
		const { handler, readOnlyTime } = this.options

		switch (command) {
			// Get Telescope Product Name
			case ':GVP#':
				return this.#text(socket, `${this.options.name || 'LX200'}#`)
			// Get Telescope Firmware Number
			case ':GVN#':
				return this.#text(socket, `${this.options.version || 'v1.0'}#`)
			// Get Telescope Firmware Date
			case ':GVD#':
				return this.#text(socket, 'Jan 01 2025#')
			// Get Telescope Firmware Time
			case ':GVT#':
				return this.#text(socket, '00:00:00#')
			// Get Telescope RA
			case ':GR#':
				return this.#rightAscension(socket)
			// Get Telescope DEC
			case ':GD#':
				return this.#declination(socket)
			// Get Current Site Longitude
			case ':Gg#':
				return this.#longitude(socket)
			// Get Current Site Latitude
			case ':Gt#':
				return this.#latitude(socket)
			// Get current date
			case ':GC#':
				return this.#date(socket)
			// Get Local Time in 24 hour format
			case ':GL#':
				return this.#time(socket)
			// Get UTC offset time
			case ':GG#':
				return this.#zoneOffset(socket)
			// Returns status of the Scope
			case ':GW#':
				return this.#status(socket)
			// Requests a string of bars indicating the distance to the current library object
			case ':D#':
				return this.#slewing(socket)
			// Synchronizes the telescope's position with the currently selected database object's coordinates
			// Replies '#' when synced, or a failure message when there is no sync handler or it refuses.
			case ':CM#': {
				const [rightAscension, declination] = state.coordinates
				if (handler.sync !== undefined && handler.sync(this, rightAscension, declination, client) !== false) return this.#text(socket, '#')
				return this.#text(socket, 'Sync failed#')
			}
			// Slew to Target Object
			// Replies 0 when the slew starts, or 1 plus a message when there is no goto handler or it refuses.
			case ':MS#': {
				const [rightAscension, declination] = state.coordinates
				if (handler.goto !== undefined && handler.goto(this, rightAscension, declination, client) !== false) return this.#zero(socket)
				return this.#text(socket, '1Slew not possible#')
			}
			// Move/Halt Telescope
			case ':Me#':
			case ':Mn#':
			case ':Ms#':
			case ':Mw#':
			case ':Qe#':
			case ':Qn#':
			case ':Qs#':
			case ':Qw#':
				handler.move?.(this, command[2] === 'n' ? 'NORTH' : command[2] === 's' ? 'SOUTH' : command[2] === 'e' ? 'EAST' : 'WEST', command[1] === 'M', client)
				return
			// Halt all current slewing
			case ':Q#':
				handler.abort?.(this, client)
				return
			// Slew Rate Commands (Centering, Guiding, Finding, Max)
			case ':RC#':
			case ':RG#':
			case ':RM#':
			case ':RS#':
				handler.slewRate(this, command[2] === 'C' ? 'CENTER' : command[2] === 'G' ? 'GUIDE' : command[2] === 'M' ? 'FIND' : 'MAX', client)
				return
			default:
				// Set target object RA
				if (command.startsWith(':Sr')) {
					const ra = parseAngle(command.slice(3, command.length - 1), true)
					if (ra === undefined) return this.#zero(socket)
					state.coordinates[0] = ra
					return this.#one(socket)
				}
				// Set target object declination
				else if (command.startsWith(':Sd')) {
					const dec = parseAngle(command.slice(3, command.length - 1))
					if (dec === undefined) return this.#zero(socket)
					state.coordinates[1] = dec
					return this.#one(socket)
				}
				// Clock setters, refused as a whole when the time is read-only
				else if (readOnlyTime && (command.startsWith(':SG') || command.startsWith(':SL') || command.startsWith(':SC'))) {
					return this.#zero(socket)
				}
				// Set current site’s longitude, west positive on the wire and east positive within (-π, π] for the handler
				else if (command.startsWith(':Sg')) {
					const value = parseAngle(command.slice(3, command.length - 1))
					if (value === undefined) return this.#zero(socket)
					const longitude = normalizePI(-value)
					if (handler.setLongitude !== undefined) return handler.setLongitude(this, longitude, client) === false ? this.#zero(socket) : this.#one(socket)
					handler.longitude(this, longitude)
					return this.#one(socket)
				}
				// Sets the current site latitude
				else if (command.startsWith(':St')) {
					const latitude = parseAngle(command.slice(3, command.length - 1))
					if (latitude === undefined) return this.#zero(socket)
					if (handler.setLatitude !== undefined) return handler.setLatitude(this, latitude, client) === false ? this.#zero(socket) : this.#one(socket)
					handler.latitude(this, latitude)
					return this.#one(socket)
				}
				// Set the number of hours added to local time to yield UTC
				else if (command.startsWith(':SG')) {
					const value = command.slice(3, command.length - 1)
					const hours = Number(value)
					if (value.length === 0 || !Number.isFinite(hours)) return this.#zero(socket)
					state.utcOffset = Math.trunc(-hours * 60)
					this.#handleDateTimeAndOffset(state)
					return this.#one(socket)
				}
				// Set the local Time
				else if (command.startsWith(':SL')) {
					const values = command.slice(3, command.length - 1).split(':')
					if (values.length !== 3 || values.some((value) => value.length === 0)) return this.#zero(socket)
					const [h, m, s] = values.map(Number)
					if (!Number.isInteger(h) || !Number.isInteger(m) || !Number.isInteger(s) || !(h >= 0 && h <= 23) || !(m >= 0 && m <= 59) || !(s >= 0 && s <= 59)) return this.#zero(socket)
					state.utc[3] = h
					state.utc[4] = m
					state.utc[5] = s
					this.#handleDateTimeAndOffset(state)
					return this.#one(socket)
				}
				// Change Handbox Date to MM/DD/YY
				else if (command.startsWith(':SC')) {
					const values = command.slice(3, command.length - 1).split('/')
					if (values.length !== 3 || values.some((value) => value.length === 0)) return this.#zero(socket)
					const [m, d, y] = values.map(Number)
					if (!Number.isInteger(m) || !Number.isInteger(d) || !Number.isInteger(y) || !(m >= 1 && m <= 12) || !(y >= 0 && y <= 99) || !(d >= 1 && d <= daysInMonth(2000 + y, m))) return this.#zero(socket)
					state.utc[0] = 2000 + y
					state.utc[1] = m
					state.utc[2] = d
					this.#handleDateTimeAndOffset(state)
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
	// arrived from the same client (LX200 sends them separately), converting local time + offset to UTC.
	#handleDateTimeAndOffset(state: Lx200ClientState) {
		state.utcStep++

		if (state.utcStep >= 3) {
			state.utcStep = 0
			this.options.handler.dateTime(this, [temporalAdd(temporalFromDate(...state.utc), -state.utcOffset, 'm'), state.utcOffset])
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
		const [temporal, offset] = this.options.handler.dateTime(this)
		const command = `${formatTemporal(temporal, DATE_FORMAT, offset)}#`
		this.#text(socket, command)
	}

	// Writes the local time as HH:MM:SS#.
	#time(socket: Socket<unknown>) {
		const [temporal, offset] = this.options.handler.dateTime(this)
		const command = `${formatTemporal(temporal, TIME_FORMAT, offset)}#`
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
