import { deg, hour, parseAngle } from '../src/angle'
import { now } from '../src/datetime'
import { Lx200ProtocolServer } from '../src/lx200'

let longitude = parseAngle('-45d 00 00')!
let latitude = parseAngle('-22d 00 00')!
let rightAscension = hour(12)
let declination = deg(-80)
let slewing = false
let tracking = false

const server = new Lx200ProtocolServer('0.0.0.0', 10001, {
    name: 'Nebulosa',
	protocol: {
		rightAscension: () => {
			return rightAscension
		},
		declination: () => {
			return declination
		},
		longitude: (value) => {
			if (value !== undefined) longitude = value
			return longitude
		},
		latitude: (value) => {
			if (value !== undefined) latitude = value
			return latitude
		},
		dateTime: () => {
			return now()
		},
		goto: (ra, dec) => {
			rightAscension = ra
			declination = dec
			tracking = true
		},
		sync: (ra, dec) => {
			rightAscension = ra
			declination = dec
			slewing = false
		},
		slewing: () => {
			return slewing
		},
		tracking: () => {
			return tracking
		},
	},
})

server.start()
