import { type Client, DEFAULT_THERMOMETER, type SubDevice, type Thermometer } from '../device'
import type { DefNumberVector, DefVector, DelProperty, SetNumberVector, SetVector } from '../types'
import { DeviceManager, type DeviceProvider, handleNumberValue, handleSwitchValue, makeDeviceId, proxyDevice, resetDeviceValue } from './device'

// Manager for temperature sensors; reflects the device temperature (degrees Celsius) from its properties.
export class ThermometerManager extends DeviceManager<Thermometer> {
	constructor(readonly provider: DeviceProvider<Thermometer>) {
		super()
	}

	#addProxy(client: Client, parent: Thermometer) {
		const id = makeDeviceId(client, 'thermometer', parent.name)

		const device = proxyDevice(parent, id, 'thermometer')

		if (this.add(device)) {
			this.updated(device, 'hasThermometer')
			this.updated(parent, 'hasThermometer')
		}

		return device
	}

	// Forwards only the driver/connection and temperature vectors to the base property tracking.
	vector(client: Client, message: DefVector | SetVector, tag: string) {
		switch (message.name) {
			case 'DRIVER_INFO':
			case 'CONNECTION':
			case 'CCD_TEMPERATURE':
			case 'FOCUS_TEMPERATURE':
				return super.vector(client, message, tag)
		}
	}

	// Applies the camera/focuser temperature vectors (degrees Celsius), lazily creating a thermometer proxy
	// over a parent camera/focuser that reports a temperature.
	numberVector(client: Client, message: DefNumberVector | SetNumberVector, tag: string) {
		switch (message.name) {
			case 'CCD_TEMPERATURE':
			case 'FOCUS_TEMPERATURE': {
				let device = this.get(client, message.device)

				if (device === undefined && tag[0] === 'd') {
					const parent = this.provider.get(client, message.device, message.name[0] === 'C' ? 'camera' : 'focuser')

					if (parent !== undefined && handleSwitchValue(parent, 'hasThermometer', true)) {
						device = this.#addProxy(client, parent)
					}
				}

				if (device !== undefined) {
					const { elements } = message

					if (handleNumberValue(device, 'temperature', elements.TEMPERATURE?.value ?? elements.CCD_TEMPERATURE_VALUE?.value, undefined, Math.round)) {
						this.updated(device, 'temperature', message.state)

						const parent = (device as SubDevice<Thermometer, Thermometer>).parent
						this.updated(parent, 'temperature', message.state)
					}
				}
			}
		}
	}

	delProperty(client: Client, message: DelProperty) {
		const device = this.get(client, message.device)

		if (device === undefined) return

		const name = message.name
		const full = !name

		if (full || name === 'CCD_TEMPERATURE' || name === 'FOCUS_TEMPERATURE') {
			resetDeviceValue(this, device, 'hasThermometer', DEFAULT_THERMOMETER.hasThermometer)
			resetDeviceValue(this, device, 'temperature', DEFAULT_THERMOMETER.temperature)

			const parent = (device as SubDevice<Thermometer, Thermometer>).parent
			this.updated(parent, 'hasThermometer')
			this.updated(parent, 'temperature')

			// Force remove the device passing name as undefined.
			super.delProperty(client, full ? message : { ...message, name: undefined })
			return
		}

		super.delProperty(client, message)
	}
}
