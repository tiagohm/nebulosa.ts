import { AlpacaClient, type AlpacaClientHandler } from '../src/alpaca.client'
import { AlpacaDiscoveryClient } from '../src/alpaca.discovery'
import type { Client, Device, DeviceType } from '../src/indi.device'
import { CameraManager, CoverManager, type DeviceProvider, FlatPanelManager, FocuserManager, GuideOutputManager, MountManager, ThermometerManager, WheelManager } from '../src/indi.manager'
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

const cameraManager = new CameraManager()
const mountManager = new MountManager()
const wheelManager = new WheelManager()
const focuserManager = new FocuserManager()
const flatPanelManager = new FlatPanelManager()
const coverManager = new CoverManager()

const guideOutput = new GuideOutputManager({
	get: (client: Client, name: string) => {
		return mountManager.get(client, name) ?? cameraManager.get(client, name)
	},
})

const thermometerManager = new ThermometerManager({
	get: (client: Client, name: string) => {
		return focuserManager.get(client, name) ?? cameraManager.get(client, name)
	},
})

cameraManager.addHandler(deviceHandler)
mountManager.addHandler(deviceHandler)
wheelManager.addHandler(deviceHandler)
focuserManager.addHandler(deviceHandler)
flatPanelManager.addHandler(deviceHandler)
coverManager.addHandler(deviceHandler)
guideOutput.addHandler(deviceHandler)
thermometerManager.addHandler(deviceHandler)

const handler: AlpacaClientHandler = {
	textVector: (client, message, tag) => {
		cameraManager.textVector(client, message, tag)
		mountManager.textVector(client, message, tag)
		wheelManager.textVector(client, message, tag)
		focuserManager.textVector(client, message, tag)
		flatPanelManager.textVector(client, message, tag)
		coverManager.textVector(client, message, tag)
	},
	numberVector: (client, message, tag) => {
		cameraManager.numberVector(client, message, tag)
		mountManager.numberVector(client, message, tag)
		wheelManager.numberVector(client, message, tag)
		focuserManager.numberVector(client, message, tag)
		flatPanelManager.numberVector(client, message, tag)
		guideOutput.numberVector(client, message, tag)
		thermometerManager.numberVector(client, message, tag)
	},
	switchVector: (client, message, tag) => {
		cameraManager.switchVector(client, message, tag)
		mountManager.switchVector(client, message, tag)
		wheelManager.switchVector(client, message, tag)
		focuserManager.switchVector(client, message, tag)
		flatPanelManager.switchVector(client, message, tag)
		coverManager.switchVector(client, message, tag)
		guideOutput.switchVector(client, message, tag)
		thermometerManager.switchVector(client, message, tag)
	},
}

const deviceProvider: DeviceProvider<Device> = {
	get: (client: Client, name: string, type?: DeviceType) => {
		if (type === 'CAMERA') return cameraManager.get(client, name)
		else if (type === 'MOUNT') return mountManager.get(client, name)
		else if (type === 'FOCUSER') return focuserManager.get(client, name)
		else if (type === 'WHEEL') return wheelManager.get(client, name)
		return undefined
	},
}

const alpacaClient = new AlpacaClient('http://localhost:32323', { handler }, deviceProvider)
await alpacaClient.start()
