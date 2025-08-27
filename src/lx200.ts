import type { Socket, TCPSocketListener } from 'bun'
import { type Angle, parseAngle, toDms, toHms } from './angle'
import { type DateTime, dateFrom } from './datetime'

// http://www.company7.com/library/meade/LX200CommandSet.pdf
// https://soundstepper.sourceforge.net/LX200_Compatible_Commands.html
// https://www.cloudynights.com/topic/72166-lx-200-gps-serial-commands/

export type MoveDirection = 'NORTH' | 'SOUTH' | 'EAST' | 'WEST'

export type SlewRate = 'CENTER' | 'GUIDE' | 'FIND' | 'MAX'

export interface Lx200ProtocolHandler {
	connect?: (server: Lx200ProtocolServer) => void
	rightAscension: (server: Lx200ProtocolServer) => Angle // J2000
	declination: (server: Lx200ProtocolServer) => Angle // J2000
	longitude: (server: Lx200ProtocolServer, longitude?: Angle) => Angle
	latitude: (server: Lx200ProtocolServer, latitude?: Angle) => Angle
	dateTime: (server: Lx200ProtocolServer, date?: DateTime) => DateTime
	tracking: (server: Lx200ProtocolServer) => boolean
	parked: (server: Lx200ProtocolServer) => boolean
	slewing: (server: Lx200ProtocolServer) => boolean
	slewRate: (server: Lx200ProtocolServer, rate: SlewRate) => void
	sync?: (server: Lx200ProtocolServer, rightAscension: Angle, declination: Angle) => void
	goto?: (server: Lx200ProtocolServer, rightAscension: Angle, declination: Angle) => void
	move?: (server: Lx200ProtocolServer, direction: MoveDirection, enabled: boolean) => void
	abort?: (server: Lx200ProtocolServer) => void
	disconnect?: (server: Lx200ProtocolServer) => void
}

export interface Lx200ProtocolServerOptions {
	handler: Lx200ProtocolHandler
	name?: string
	version?: string
}

const ACK = Buffer.from([71]) // G
const ONE = Buffer.from([49]) // 1
const ZERO = Buffer.from([48]) // 0

// Meade Telescope Serial Command Protocol Server.
export class Lx200ProtocolServer {
	private readonly sockets: Socket<unknown>[] = []
	private server?: TCPSocketListener

	private readonly coordinates: [Angle, Angle] = [0, 0]
	private readonly utcDate: [number, number, number, number, number, number] = [2025, 1, 1, 0, 0, 0]
	private utcOffset = 0

	constructor(
		readonly host: string,
		readonly port: number,
		readonly options: Readonly<Lx200ProtocolServerOptions>,
	) {}

	start() {
		if (this.server) return false

		this.server = Bun.listen({
			hostname: this.host,
			port: this.port,
			allowHalfOpen: false,
			socket: {
				data: (socket, data) => {
					this.processData(socket, data)
				},
				open: (socket) => {
					console.info('connection open')
					this.sockets.push(socket)
					this.options.handler.connect?.(this)

					this.coordinates[0] = this.options.handler.rightAscension(this)
					this.coordinates[1] = this.options.handler.declination(this)
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

	private processData(socket: Socket<unknown>, data: Buffer) {
		if (data.byteLength >= 2) {
			const command = data.toString('ascii')

			// console.debug('command received', command)

			switch (command) {
				// LX200 protocol detection.
				case '#\x06':
					return this.ack(socket)
				// Get Telescope Product Name
				case '#:GVP#':
					return this.text(socket, `${this.options.name || 'LX200'}#`)
				// Get Telescope Firmware Number
				case '#:GVN#':
					return this.text(socket, `${this.options.version || 'v1.0'}#`)
				// Get Telescope Firmware Date
				case '#:GVD#':
					return this.text(socket, 'Jan 01 2025#')
				// Get Telescope Firmware Time
				case '#:GVT#':
					return this.text(socket, '00:00:00#')
				// Get Telescope RA
				case '#:GR#':
					return this.rightAscension(socket)
				// Get Telescope DEC
				case '#:GD#':
					return this.declination(socket)
				// Get Current Site Longitude
				case '#:Gg#':
					return this.longitude(socket)
				// Get Current Site Latitude
				case '#:Gt#':
					return this.latitude(socket)
				// Get current date
				case '#:GC#':
					return this.date(socket)
				// Get Local Time in 24 hour format
				case '#:GL#':
					return this.time(socket)
				// Get UTC offset time
				case '#:GG#':
					return this.zoneOffset(socket)
				// Returns status of the Scope
				case '#:GW#':
					return this.status(socket)
				// Requests a string of bars indicating the distance to the current library object
				case '#:D#':
					return this.slewing(socket)
				// Synchronizes the telescope's position with the currently selected database object's coordinates
				case '#:CM#':
					this.options.handler.sync?.(this, ...this.coordinates)
					return this.zero(socket)
				// Slew to Target Object
				case '#:MS#':
					this.options.handler.goto?.(this, ...this.coordinates)
					return this.zero(socket)
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
						const ra = parseAngle(command.substring(4), { isHour: true })
						if (ra !== undefined) this.coordinates[0] = ra
						return this.one(socket)
					}
					// Set target object declination
					else if (command.startsWith('#:Sd')) {
						const dec = parseAngle(command.substring(4))
						if (dec !== undefined) this.coordinates[1] = dec
						return this.one(socket)
					}
					// Set current site’s longitude
					else if (command.startsWith('#:Sg')) {
						const longitude = parseAngle(command.substring(4))
						if (longitude !== undefined) this.options.handler.longitude(this, -longitude)
						return this.one(socket)
					}
					// Sets the current site latitude
					else if (command.startsWith('#:St')) {
						const latitude = parseAngle(command.substring(4))
						if (latitude !== undefined) this.options.handler.latitude(this, latitude)
						return this.one(socket)
					}
					// Set the number of hours added to local time to yield UTC
					else if (command.startsWith('#:SG')) {
						const hours = -command.substring(4, command.length - 1)
						this.utcOffset = Math.trunc(hours * 60)
						const date = dateFrom(this.utcDate, true).utcOffset(this.utcOffset)
						this.options.handler.dateTime(this, date)
						return this.one(socket)
					}
					// Set the local Time
					else if (command.startsWith('#:SL')) {
						const [h, m, s] = command.substring(4, command.length - 1).split(':')
						this.utcDate[3] = +h
						this.utcDate[4] = +m
						this.utcDate[5] = +s
						return this.one(socket)
					}
					// Change Handbox Date to MM/DD/YY
					else if (command.startsWith('#:SC')) {
						const [m, d, y] = command.substring(4, command.length - 1).split('/')
						this.utcDate[0] = 2000 + +y
						this.utcDate[1] = +m
						this.utcDate[2] = +d
						return this.text(socket, '1Updating planetary data       #                              #')
					}

					console.warn('unknown command', command)

					break
			}
		}
	}

	private ack(socket: Socket<unknown>) {
		socket.write(ACK)
	}

	private one(socket: Socket<unknown>) {
		socket.write(ONE)
	}

	private zero(socket: Socket<unknown>) {
		socket.write(ZERO)
	}

	private text(socket: Socket<unknown>, value: string) {
		socket.write(Buffer.from(value, 'ascii'))
	}

	private rightAscension(socket: Socket<unknown>) {
		const [h, m, s] = toHms(this.options.handler.rightAscension(this))
		const command = `+${formatNumber(h)}:${formatNumber(m)}:${formatNumber(s)}#`
		this.text(socket, command)
	}

	private declination(socket: Socket<unknown>) {
		const [d, m, s, neg] = toDms(this.options.handler.declination(this))
		const command = `${neg < 0 ? '-' : '+'}${formatNumber(d)}*${formatNumber(m)}:${formatNumber(s)}#`
		this.text(socket, command)
	}

	private longitude(socket: Socket<unknown>) {
		const [d, m, , neg] = toDms(this.options.handler.longitude(this))
		const command = `${neg < 0 ? '+' : '-'}${formatNumber(d, 3)}*${formatNumber(m)}#`
		this.text(socket, command)
	}

	private latitude(socket: Socket<unknown>) {
		const [d, m, , neg] = toDms(this.options.handler.latitude(this))
		const command = `${neg < 0 ? '-' : '+'}${formatNumber(d)}*${formatNumber(m)}#`
		this.text(socket, command)
	}

	private date(socket: Socket<unknown>) {
		const command = `${this.options.handler.dateTime(this).format('MM/DD/YY')}#`
		this.text(socket, command)
	}

	private time(socket: Socket<unknown>) {
		const command = `${this.options.handler.dateTime(this).format('HH:mm:ss')}#`
		this.text(socket, command)
	}

	private zoneOffset(socket: Socket<unknown>) {
		const m = this.options.handler.dateTime(this).utcOffset()
		const command = `${m < 0 ? '+' : '-'}${formatNumber(Math.abs(m) / 60, 4, 1)}#`
		this.text(socket, command)
	}

	private status(socket: Socket<unknown>, type: string = 'G') {
		const a = this.options.handler.tracking(this)
		const b = this.options.handler.parked(this)
		const command = `${type}${a ? 'T' : 'N'}${b ? 'P' : 'H'}#`
		this.text(socket, command)
	}

	private slewing(socket: Socket<unknown>) {
		const s = this.options.handler.slewing(this)
		const command = `${s ? '|' : ''}#`
		this.text(socket, command)
	}
}

function formatNumber(value: number, maxLength: number = 2, fractionDigits: number = 0) {
	return value.toFixed(fractionDigits).padStart(maxLength, '0')
}
