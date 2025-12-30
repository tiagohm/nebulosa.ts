import { AlpacaDiscoveryServer, AlpacaServer } from '../src/alpaca.server'
import { IndiClient } from '../src/indi'
import { CameraManager, WheelManager } from '../src/indi.manager'

const camera = new CameraManager()
const wheel = new WheelManager()

const client = new IndiClient({
	handler: {
		switchVector: (client, message, tag) => {
			camera.switchVector(client, message, tag)
			wheel.switchVector(client, message, tag)
		},
		numberVector: (client, message, tag) => {
			camera.numberVector(client, message, tag)
			wheel.numberVector(client, message, tag)
		},
		textVector: (client, message, tag) => {
			camera.textVector(client, message, tag)
			wheel.textVector(client, message, tag)
		},
		blobVector: (client, message, tag) => {
			camera.blobVector(client, message, tag)
		},
		delProperty: (client, message) => {
			camera.delProperty(client, message)
			wheel.delProperty(client, message)
		},
		close: (client, server) => {
			camera.close(client, server)
			wheel.close(client, server)
		},
	},
})

await client.connect('pi.local')

const alpacaServer = new AlpacaServer({ camera, wheel })

alpacaServer.start(undefined, 60364)
console.info('alpaca server was started at port', alpacaServer.port)

const alpacaDiscoveryServer = new AlpacaDiscoveryServer()
alpacaDiscoveryServer.addPort(alpacaServer.port)
await alpacaDiscoveryServer.start('0.0.0.0')
