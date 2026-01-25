import { AlpacaClient, type AlpacaClientHandler } from '../src/alpaca.client'
import { AlpacaDiscoveryClient } from '../src/alpaca.discovery'
import type { Client, Device, Thermometer } from '../src/indi.device'
import { type DeviceProvider, FocuserManager, ThermometerManager, WheelManager } from '../src/indi.manager'
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

const wheelManager = new WheelManager()
const focuserManager = new FocuserManager()

const thermometerProvider: DeviceProvider<Thermometer> = {
	get: (client: Client, name: string) => {
		return focuserManager.get(client, name)
	},
}

const thermometerManager = new ThermometerManager(thermometerProvider)

wheelManager.addHandler(deviceHandler)
focuserManager.addHandler(deviceHandler)
thermometerManager.addHandler(deviceHandler)

const handler: AlpacaClientHandler = {
	textVector: (client, message, tag) => {
		wheelManager.textVector(client, message, tag)
		focuserManager.textVector(client, message, tag)
	},
	numberVector: (client, message, tag) => {
		wheelManager.numberVector(client, message, tag)
		focuserManager.numberVector(client, message, tag)
		thermometerManager.numberVector(client, message, tag)
	},
	switchVector: (client, message, tag) => {
		wheelManager.switchVector(client, message, tag)
		focuserManager.switchVector(client, message, tag)
		thermometerManager.switchVector(client, message, tag)
	},
}

const alpacaClient = new AlpacaClient('http://localhost:32323', { handler })
await alpacaClient.start()
