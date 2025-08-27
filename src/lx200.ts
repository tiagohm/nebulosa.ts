import type { Socket, TCPSocketListener } from 'bun'
import { type Angle, parseAngle, toDms, toHms } from './angle'
import { type DateTime, dateNow } from './datetime'

// http://www.company7.com/library/meade/LX200CommandSet.pdf
// https://soundstepper.sourceforge.net/LX200_Compatible_Commands.html
// https://www.cloudynights.com/topic/72166-lx-200-gps-serial-commands/

export type MoveDirection = 'n' | 's' | 'e' | 'w'

export interface Lx200ProtocolHandler {
	connect?: (server: Lx200ProtocolServer) => void
	rightAscension: (server: Lx200ProtocolServer) => Angle // J2000
	declination: (server: Lx200ProtocolServer) => Angle // J2000
	longitude: (server: Lx200ProtocolServer, longitude?: Angle) => Angle
	latitude: (server: Lx200ProtocolServer, latitude?: Angle) => Angle
	dateTime: (server: Lx200ProtocolServer, date?: DateTime) => DateTime
	tracking?: (server: Lx200ProtocolServer) => boolean
	parked?: (server: Lx200ProtocolServer) => boolean
	slewing?: (server: Lx200ProtocolServer) => boolean
	sync?: (server: Lx200ProtocolServer, ra: Angle, dec: Angle) => void
	goto?: (server: Lx200ProtocolServer, ra: Angle, dec: Angle) => void
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
	private dateTime = dateNow()

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
					this.handleData(socket, data)
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

	private handleData(socket: Socket<unknown>, data: Buffer) {
		if (data.byteLength >= 2) {
			const command = data.toString('ascii')

			// console.debug('command received', command)

			switch (command) {
				// LX200 protocol detection.
				case '#\x06':
					return this.ack(socket)
				// Get Telescope Product Name.
				case '#:GVP#':
					return this.text(socket, `${this.options.name || 'LX200'}#`)
				// Get Telescope Firmware Number.
				case '#:GVN#':
					return this.text(socket, `${this.options.version || 'v1.0'}#`)
				// Get Telescope Firmware Date.
				case '#:GVD#':
					return this.text(socket, `${this.dateTime.format('MMM MM YYYY')}#`)
				// Get Telescope Firmware Time.
				case '#:GVT#':
					return this.text(socket, `${this.dateTime.format('HH:mm:ss')}#`)
				case '#:GR#':
					return this.rightAscension(socket)
				case '#:GD#':
					return this.declination(socket)
				case '#:Gg#':
					return this.longitude(socket)
				case '#:Gt#':
					return this.latitude(socket)
				case '#:GC#':
					return this.date(socket)
				case '#:GL#':
					return this.time(socket)
				case '#:GG#':
					return this.zoneOffset(socket)
				case '#:GW#':
					return this.status(socket)
				case '#:D#':
					return this.slewing(socket)
				case '#:CM#':
					this.options.handler.sync?.(this, ...this.coordinates)
					return this.zero(socket)
				case '#:MS#':
					this.options.handler.goto?.(this, ...this.coordinates)
					return this.zero(socket)
				case '#:Me#':
				case '#:Mn#':
				case '#:Ms#':
				case '#:Mw#':
				case '#:Qe#':
				case '#:Qn#':
				case '#:Qs#':
				case '#:Qw#':
					this.options.handler.move?.(this, command[3] as never, command[2] === 'M')
					return
				case '#:Q#':
					this.options.handler.abort?.(this)
					return
				default:
					if (command.startsWith('#:Sr')) {
						const ra = parseAngle(command.substring(4), { isHour: true })
						if (ra !== undefined) this.coordinates[0] = ra
						return this.one(socket)
					} else if (command.startsWith('#:Sd')) {
						const dec = parseAngle(command.substring(4))
						if (dec !== undefined) this.coordinates[1] = dec
						return this.one(socket)
					} else if (command.startsWith('#:Sg')) {
						const lng = parseAngle(command.substring(4))
						if (lng !== undefined) this.options.handler.longitude(this, lng)
						return this.one(socket)
					} else if (command.startsWith('#:St')) {
						const lat = parseAngle(command.substring(4))
						if (lat !== undefined) this.options.handler.latitude(this, lat)
						return this.one(socket)
					} else if (command.startsWith('#:SG')) {
						const hours = -command.substring(4, command.length - 1)
						this.dateTime = this.dateTime.utcOffset(Math.trunc(hours * 60), true)
						return this.one(socket)
					} else if (command.startsWith('#:SL')) {
						const [h, m, s] = command.substring(4, command.length - 1).split(':')
						this.dateTime = this.dateTime.set('h', +h).set('m', +m).set('s', +s)
						return this.one(socket)
					} else if (command.startsWith('#:SC')) {
						const [m, d, y] = command.substring(4, command.length - 1).split('/')
						this.dateTime = this.dateTime.set('d', +d).set('y', 2000 + +y)
						this.dateTime = this.dateTime.set('m', +m - 1)
						return this.text(socket, '1Updating planetary data       #                              #')
					}

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
		const ra = this.options.handler.rightAscension(this)
		const [h, m, s] = toHms(ra)
		const command = `+${formatNumber(h)}:${formatNumber(m)}:${formatNumber(s)}#`
		this.text(socket, command)
	}

	private declination(socket: Socket<unknown>) {
		const dec = this.options.handler.declination(this)
		const [d, m, s, neg] = toDms(dec)
		const command = `${neg < 0 ? '-' : '+'}${formatNumber(d)}*${formatNumber(m)}:${formatNumber(s)}#`
		this.text(socket, command)
	}

	private longitude(socket: Socket<unknown>) {
		const lng = this.options.handler.longitude(this)
		const [d, m, , neg] = toDms(lng)
		const command = `${neg < 0 ? '+' : '-'}${formatNumber(d, 3)}*${formatNumber(m)}#`
		this.text(socket, command)
	}

	private latitude(socket: Socket<unknown>) {
		const lat = this.options.handler.latitude(this)
		const [d, m, , neg] = toDms(lat)
		const command = `${neg < 0 ? '-' : '+'}${formatNumber(d)}*${formatNumber(m)}#`
		this.text(socket, command)
	}

	private date(socket: Socket<unknown>) {
		const a = this.options.handler.dateTime(this)
		const command = `${a.format('MM/DD/YY')}#`
		this.text(socket, command)
	}

	private time(socket: Socket<unknown>) {
		const a = this.options.handler.dateTime(this)
		const command = `${a.format('HH:mm:ss')}#`
		this.text(socket, command)
	}

	private zoneOffset(socket: Socket<unknown>) {
		const m = this.dateTime.utcOffset()
		const command = `${m < 0 ? '+' : '-'}${formatNumber(Math.abs(m) / 60, 4, 1)}#`
		this.text(socket, command)
	}

	private status(socket: Socket<unknown>, type: string = 'G') {
		const a = this.options.handler.tracking?.(this) ?? false
		const b = this.options.handler.parked?.(this) ?? false
		const command = `${type}${a ? 'T' : 'N'}${b ? 'P' : 'H'}#`
		this.text(socket, command)
	}

	private slewing(socket: Socket<unknown>) {
		const s = this.options.handler.slewing?.(this) ?? false
		const command = `${s ? '|' : ''}#`
		this.text(socket, command)
	}
}

function formatNumber(value: number, maxLength: number = 2, fractionDigits: number = 0) {
	return value.toFixed(fractionDigits).padStart(maxLength, '0')
}
