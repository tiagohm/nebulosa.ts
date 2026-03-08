// biome-ignore-all lint/correctness/noConstantCondition: example!

import { toMeter } from '../src/distance'
import { BMP180, BMP180Mode, BMP280, ESP8266, type FirmataClientHandler, FirmataClientOverTcp, LM35, SHT21 } from '../src/firmata'

const handler: FirmataClientHandler = {
	ready: (client) => {
		console.info('firmata client is ready:')
		for (const pin of client.pins) console.info('pin %s: mode=%s, value: %s, modes=%s', pin.id, pin.mode, pin.value, [...pin.modes])
	},
	pinChange: (client, pin) => {
		console.info(`pin ${pin.id} changed to ${pin.value}`)
	},
	textMessage: (client, message) => {
		console.info(message)
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

if (false) {
	const lm35 = new LM35(client, ESP8266.A0, 3.3)
	lm35.addListener((device) => console.info('LM35: %s°C', device.temperature.toFixed(1)))
	lm35.start()
}

if (false) {
	const bmp180 = new BMP180(client, BMP180Mode.ULTRA_LOW_POWER, 5000)
	bmp180.addListener((device) => console.info('BMP180: %s°C | %s hPa | %s m', device.temperature.toFixed(1), device.pressure.toFixed(2), toMeter(device.altitude).toFixed(0)))
	bmp180.start()
}

if (false) {
	const sht21 = new SHT21(client, 5000)
	sht21.addListener((device) => console.info('SHT21: %s°C | %s %', device.temperature.toFixed(1), device.humidity.toFixed(0)))
	sht21.start()
}

if (true) {
	const bmp280 = new BMP280(client, BMP280.ADDRESS, 5000, { standbyDuration: 4000 })
	bmp280.addListener((device) => console.info('BMP280: %s°C | %s hPa | %s m', device.temperature.toFixed(1), device.pressure.toFixed(2), toMeter(device.altitude).toFixed(0)))
	bmp280.start()
}
