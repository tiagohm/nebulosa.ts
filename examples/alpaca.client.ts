import { AlpacaClient, type AlpacaClientHandler } from '../src/alpaca.client'
import { AlpacaDiscoveryClient } from '../src/alpaca.discovery'
import type { Client, Device } from '../src/indi.device'
import { CoverManager, FlatPanelManager, FocuserManager, MountManager, ThermometerManager, WheelManager } from '../src/indi.manager'
import type { PropertyState } from '../src/indi.types'

const alpacaDiscoveryClient = new AlpacaDiscoveryClient()
// await alpacaDiscoveryClient.discovery(console.info, { timeout: 1000, wait: true })

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

const mountManager = new MountManager()
const wheelManager = new WheelManager()
const focuserManager = new FocuserManager()
const flatPanelManager = new FlatPanelManager()
const coverManager = new CoverManager()

const thermometerManager = new ThermometerManager({
	get: (client: Client, name: string) => {
		return focuserManager.get(client, name)
	},
})

mountManager.addHandler(deviceHandler)
wheelManager.addHandler(deviceHandler)
focuserManager.addHandler(deviceHandler)
flatPanelManager.addHandler(deviceHandler)
coverManager.addHandler(deviceHandler)
thermometerManager.addHandler(deviceHandler)

const handler: AlpacaClientHandler = {
	textVector: (client, message, tag) => {
		mountManager.textVector(client, message, tag)
		wheelManager.textVector(client, message, tag)
		focuserManager.textVector(client, message, tag)
		flatPanelManager.textVector(client, message, tag)
		coverManager.textVector(client, message, tag)
	},
	numberVector: (client, message, tag) => {
		mountManager.numberVector(client, message, tag)
		wheelManager.numberVector(client, message, tag)
		focuserManager.numberVector(client, message, tag)
		flatPanelManager.numberVector(client, message, tag)
		thermometerManager.numberVector(client, message, tag)
	},
	switchVector: (client, message, tag) => {
		mountManager.switchVector(client, message, tag)
		wheelManager.switchVector(client, message, tag)
		focuserManager.switchVector(client, message, tag)
		flatPanelManager.switchVector(client, message, tag)
		coverManager.switchVector(client, message, tag)
		thermometerManager.switchVector(client, message, tag)
	},
}

const alpacaClient = new AlpacaClient('http://localhost:32323', { handler })
await alpacaClient.start()
