import { ESP8266, type FirmataClientHandler, FirmataClientOverTcp, LM35 } from '../src/firmata'

const handler: FirmataClientHandler = {
	ready: (client) => {
		console.info('firmata client is ready:')
		for (const pin of client.pins) console.info('pin %s: mode=%s, value: %s, modes=%s', pin.id, pin.mode, pin.value, [...pin.modes])
	},
	pinChange: (client, pin) => {
		console.info(`pin ${pin.id} changed to ${pin.value}`)
	},
}

const board = new ESP8266()
const client = new FirmataClientOverTcp(board)
await client.connect('nebulosa.local', 27016)
client.addHandler(handler)

console.info('initialized:', await client.ensureInitializationIsDone(5000))

client.samplingInterval(100)
client.requestDigitalReport(false)
client.requestAnalogReport(false)

client.requestAnalogPinReport(ESP8266.A0, true)
client.requestDigitalPinReport(ESP8266.LED_BUILTIN, true)
client.digitalWrite(ESP8266.LED_BUILTIN, true)

await Bun.sleep(5000)

client.digitalWrite(ESP8266.LED_BUILTIN, false)
client.requestDigitalPinReport(ESP8266.LED_BUILTIN, false)
client.requestAnalogPinReport(ESP8266.A0, false)

using lm35 = new LM35(client, ESP8266.A0)
lm35.addListener((device) => console.info('LM35: ', device.temperature))
lm35.start()

await Bun.sleep(5000)
