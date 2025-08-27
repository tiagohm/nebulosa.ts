import { dateNow } from '../src/datetime'
import { Lx200ProtocolServer } from '../src/lx200'

const state = {
	rightAscension: 0,
	declination: 0,
	latitude: 0,
	longitude: 0,
}

const server = new Lx200ProtocolServer('0.0.0.0', 10001, {
	name: 'Nebulosa',
	version: '0.2.0',
	handler: {
		connect: (server) => {
			console.info('connected')
		},
		disconnect: (server) => {
			console.info('disconnected')
		},
		rightAscension: (server) => {
			return state.rightAscension
		},
		declination: (server) => {
			return state.declination
		},
		longitude: (server, longitude) => {
			console.info('longitude', longitude)
			if (longitude !== undefined) state.longitude = longitude
			return state.longitude
		},
		latitude: (server, latitude) => {
			console.info('latitude', latitude)
			if (latitude !== undefined) state.latitude = latitude
			return state.latitude
		},
		dateTime: (server, date) => {
			console.info('date time', date)
			return date ?? dateNow()
		},
		tracking: (server) => {
			console.info('tracking')
			return false
		},
		parked: (server) => {
			console.info('parked')
			return false
		},
		slewing: (server) => {
			return false
		},
		slewRate: (server, rate) => {
			console.info('slew rate', rate)
		},
		goto: (server, rightAscension, declination) => {
			state.rightAscension = rightAscension
			state.declination = declination
			console.info('go', rightAscension, declination)
		},
		move: (server, direction, enabled) => {
			console.info('move', direction, enabled)
		},
		sync: (server, rightAscension, declination) => {
			state.rightAscension = rightAscension
			state.declination = declination
			console.info('sync', rightAscension, declination)
		},
		abort: (server) => {
			console.info('abort')
		},
	},
})

server.start()
