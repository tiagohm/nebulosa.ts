import { AlpacaClient } from '../src/alpaca.client'
import { AlpacaDiscoveryClient } from '../src/alpaca.discovery'
import type { Wheel } from '../src/indi.device'
import type { DeviceHandler } from '../src/indi.manager'

const alpacaDiscoveryClient = new AlpacaDiscoveryClient()
await alpacaDiscoveryClient.discovery(console.info, { timeout: 5000, fetch: false })

const wheelHandler: DeviceHandler<Wheel> = {
	added: (device: Wheel) => {
		console.info('wheel added:', device.name)
	},
	updated: (device, property) => {
		console.info('wheel updated:', property, device[property])
	},
	removed: (device: Wheel) => {
		console.info('wheel removed:', device.name)
	},
}

const alpacaClient = new AlpacaClient('http://127.0.0.1:32323', { handler: { wheel: wheelHandler } })
await alpacaClient.start()

const device = alpacaClient.get('FilterWheel', 0)
await device?.connect()
