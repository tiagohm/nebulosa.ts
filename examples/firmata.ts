import { ESP8266, type FirmataClientHandler, FirmataClientOverTcp } from '../src/firmata'

const handler: FirmataClientHandler = {
	ready: (client) => {
		console.info('firmata client is ready')
	},
	pinChange: (client, pin) => {
		console.info(`pin ${pin.id} changed to ${pin.value}`)
	},
}

const client = new FirmataClientOverTcp()
await client.connect('192.168.0.178', 27016)
client.addHandler(handler)
client.requestDigitalReport(false)
client.requestAnalogPinReport(ESP8266.A0, true, ESP8266.pinToAnalog)
