import { AlpacaDiscoveryServer } from '../src/alpaca.discovery'
import { AlpacaServer } from '../src/alpaca.server'
import { IndiClient } from '../src/indi.client'
import { CameraManager, CoverManager, FlatPanelManager, FocuserManager, MountManager, WheelManager } from '../src/indi.manager'

const camera = new CameraManager()
const wheel = new WheelManager()
const mount = new MountManager()
const focuser = new FocuserManager()
const cover = new CoverManager()
const flatPanel = new FlatPanelManager()

const client = new IndiClient({
	handler: {
		switchVector: (client, message, tag) => {
			camera.switchVector(client, message, tag)
			wheel.switchVector(client, message, tag)
			mount.switchVector(client, message, tag)
			focuser.switchVector(client, message, tag)
			cover.switchVector(client, message, tag)
			flatPanel.switchVector(client, message, tag)
		},
		numberVector: (client, message, tag) => {
			camera.numberVector(client, message, tag)
			wheel.numberVector(client, message, tag)
			mount.numberVector(client, message, tag)
			focuser.numberVector(client, message, tag)
			// cover.numberVector(client, message, tag)
			flatPanel.numberVector(client, message, tag)
		},
		textVector: (client, message, tag) => {
			camera.textVector(client, message, tag)
			wheel.textVector(client, message, tag)
			mount.textVector(client, message, tag)
			focuser.textVector(client, message, tag)
			cover.textVector(client, message, tag)
			flatPanel.textVector(client, message, tag)
		},
		blobVector: (client, message, tag) => {
			camera.blobVector(client, message, tag)
		},
		delProperty: (client, message) => {
			camera.delProperty(client, message)
			wheel.delProperty(client, message)
			mount.delProperty(client, message)
			focuser.delProperty(client, message)
			cover.delProperty(client, message)
			flatPanel.delProperty(client, message)
		},
		close: (client, server) => {
			camera.close(client, server)
			wheel.close(client, server)
			mount.close(client, server)
			focuser.close(client, server)
			cover.close(client, server)
			flatPanel.close(client, server)
		},
	},
})

await client.connect('localhost')

const alpacaServer = new AlpacaServer({ camera, wheel, mount, focuser, cover, flatPanel })

alpacaServer.start(undefined, 60364)
console.info('alpaca server was started at port', alpacaServer.port)

const alpacaDiscoveryServer = new AlpacaDiscoveryServer()
alpacaDiscoveryServer.addPort(alpacaServer.port)
await alpacaDiscoveryServer.start('0.0.0.0')
