import { AlpacaClient, type AlpacaClientHandler } from '../src/alpaca.client'
import { AlpacaDiscoveryClient } from '../src/alpaca.discovery'
import type { Device } from '../src/indi.device'
import { WheelManager } from '../src/indi.manager'
import type { PropertyState } from '../src/indi.types'

const alpacaDiscoveryClient = new AlpacaDiscoveryClient()
await alpacaDiscoveryClient.discovery(console.info, { timeout: 1000, wait: true })

const deviceHandler = {
	added: (device: Device) => {
		console.info('device added', device.type, device.name)
	},
	updated: (device: Device, property: string, state?: PropertyState) => {
		console.info('device updated', device.type, device.name, property, device[property as never])
	},
	removed: (device: Device) => {
		console.info('device removed', device.type, device.name)
	},
}

const wheelManager = new WheelManager()
wheelManager.addHandler(deviceHandler)

const handler: AlpacaClientHandler = {
	textVector: (client, message, tag) => {
		wheelManager.textVector(client, message, tag)
	},
	numberVector: (client, message, tag) => {
		wheelManager.numberVector(client, message, tag)
	},
	switchVector: (client, message, tag) => {
		wheelManager.switchVector(client, message, tag)
	},
}

// ASCOM OmniSim
const alpacaClient = new AlpacaClient('http://localhost:32323', { handler })
await alpacaClient.start()
