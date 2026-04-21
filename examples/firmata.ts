// oxlint-disable no-constant-condition

import { toMeter } from '../src/distance'
import { type FirmataClientHandler, FirmataClientOverTcp } from '../src/firmata'
import { BMP180, BMP180Mode, BMP280 } from '../src/firmata.barometer'
import { ESP8266 } from '../src/firmata.board'
import { HD44780 } from '../src/firmata.display'
import { AM2320, SHT21 } from '../src/firmata.hygrometer'
import { PCF8574 } from '../src/firmata.io'
import type { Accelerometer, Altimeter, Ammeter, Barometer, Gyroscope, Hygrometer, Luxmeter, Magnetometer, RadioTransmitter, RadioTuner, Thermometer } from '../src/firmata.peripheral'
import { KT0803L, RDA5807, TEA5767 } from '../src/firmata.radio'
import { DS18B20, LM35 } from '../src/firmata.thermometer'

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

function print(device: Thermometer | Hygrometer | Barometer | Altimeter | Luxmeter | Ammeter | Accelerometer | Gyroscope | Magnetometer | RadioTuner | RadioTransmitter) {
	const output: string[] = []
	if ('temperature' in device) output.push(`temperature: ${device.temperature} °C`)
	if ('humidity' in device) output.push(`humidity: ${device.humidity} %`)
	if ('pressure' in device) output.push(`pressure: ${device.pressure} hPa`)
	if ('altitude' in device) output.push(`altitude: ${toMeter(device.altitude)} m`)
	if ('frequency' in device) output.push(`frequency: ${device.frequency} MHz`)
	if ('volume' in device) output.push(`volume: ${device.volume}`)
	if ('muted' in device) output.push(`muted: ${device.muted}`)
	if ('stereo' in device) output.push(`stereo: ${device.stereo}`)
	if ('rssi' in device) output.push(`rssi: ${device.rssi}`)
	if ('station' in device) output.push(`station: ${device.station}`)
	if ('lux' in device) output.push(`lux: ${device.lux}`)
	if ('current' in device) output.push(`current: ${device.current}`)
	if ('x' in device) output.push(`x: ${device.x}`)
	if ('y' in device) output.push(`y: ${device.y}`)
	if ('z' in device) output.push(`z: ${device.z}`)
	if ('ax' in device) output.push(`ax: ${device.ax}`)
	if ('ay' in device) output.push(`ay: ${device.ay}`)
	if ('az' in device) output.push(`az: ${device.az}`)
	if ('gx' in device) output.push(`gx: ${device.gx}`)
	if ('gy' in device) output.push(`gy: ${device.gy}`)
	if ('gz' in device) output.push(`gz: ${device.gz}`)

	if (output.length) console.info(device.name, output.join(' | '))
}

if (false) {
	const lm35 = new LM35(client, ESP8266.A0, 3.3)
	lm35.addListener(print)
	lm35.start()
}

if (false) {
	const bmp180 = new BMP180(client, BMP180Mode.ULTRA_LOW_POWER, 5000)
	bmp180.addListener(print)
	bmp180.start()
}

if (false) {
	const sht21 = new SHT21(client, 5000)
	sht21.addListener(print)
	sht21.start()
}

if (false) {
	const bmp280 = new BMP280(client, BMP280.ADDRESS, 5000, { standbyDuration: 4000 })
	bmp280.addListener(print)
	bmp280.start()
}

if (false) {
	const am2320 = new AM2320(client, 5000)
	am2320.addListener(print)
	am2320.start()
}

if (false) {
	const address = undefined // Buffer.from([0x28, 0xff, 0xce, 0x82, 0xc4, 0x16, 0x04, 0xfc])
	const ds18b20 = new DS18B20(client, ESP8266.D5, 5000, { address })
	ds18b20.addListener(print)
	ds18b20.start()
}

if (false) {
	const radio = new RDA5807(client, RDA5807.ADDRESS)
	radio.addListener(print)
	radio.start()
	radio.frequency = 100.1
}

if (false) {
	const radio = new TEA5767(client, TEA5767.ADDRESS)
	radio.addListener(print)
	radio.start()
	radio.frequency = 100.1
}

if (false) {
	const transmitter = new KT0803L(client, KT0803L.ADDRESS, { audioEnhancement: false, gain: 8, stereo: false })
	transmitter.addListener(print)
	transmitter.start()
	transmitter.frequency = 90
}

if (true) {
	const expander = new PCF8574(client, 0x27)
	const lcd = new HD44780(expander)
	lcd.begin(16, 2)
	const heart = [0b00000, 0b00000, 0b01010, 0b11111, 0b11111, 0b01110, 0b00100, 0b00000]
	lcd.createChar(0, heart)
	lcd.setCursor(1, 1)
	lcd.print('Tiago')
	lcd.write(0)
	lcd.print('Giovanna')
	lcd.backlight()
}
