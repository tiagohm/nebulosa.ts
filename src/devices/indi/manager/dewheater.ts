import { CLIENT, type Client, DEFAULT_DEW_HEATER, type DewHeater, type SubDevice } from '../device'
import type { DefNumberVector, DefSwitchVector, DefVector, DelProperty, SetNumberVector, SetVector } from '../types'
import { DeviceManager, type DeviceProvider, handleMinMaxValue, handleSwitchValue, makeDeviceId, proxyDevice, resetDeviceValue } from './device'

// Manager for dew heaters; sets and reflects the heater duty cycle (percent).
export class DewHeaterManager extends DeviceManager<DewHeater> {
	readonly #pwm = new WeakMap<DewHeater, readonly [string, string]>()

	constructor(readonly provider: DeviceProvider<DewHeater>) {
		super()
	}

	dutyCycle(heater: DewHeater, value: number, client = heater[CLIENT]!) {
		const property = this.#pwm.get(heater)

		if (property) {
			const [name, element] = property
			client.sendNumber({ device: heater.name, name, elements: { [element]: value } })
		}
	}

	#addProxy(client: Client, parent: DewHeater, message: DefSwitchVector | SetNumberVector) {
		const id = makeDeviceId(client, 'dewHeater', parent.name)
		const device = proxyDevice(parent, id, 'dewHeater')

		if (this.add(device)) {
			this.updated(device, 'hasDewHeater', message.state)
			this.updated(parent, 'hasDewHeater', message.state)
			this.#pwm.set(device, [message.name, 'Heater'])
		}

		return device
	}

	// Forwards only the driver/connection and heater vectors to the base property tracking.
	vector(client: Client, message: DefVector | SetVector, tag: string) {
		switch (message.name) {
			case 'DRIVER_INFO':
			case 'CONNECTION':
			case 'Heater':
				return super.vector(client, message, tag)
		}
	}

	// Applies the heater duty-cycle number vector, lazily creating a dew-heater proxy over a parent device
	// that exposes a heater channel.
	numberVector(client: Client, message: DefNumberVector | SetNumberVector, tag: string) {
		switch (message.name) {
			// WandererCover V4 EC
			case 'Heater': {
				let device = this.get(client, message.device)

				if (device === undefined && tag[0] === 'd') {
					const parent = this.provider.get(client, message.device)

					if (parent !== undefined && handleSwitchValue(parent, 'hasDewHeater', true)) {
						device = this.#addProxy(client, parent, message)
					}
				}

				if (device !== undefined) {
					if (handleMinMaxValue(device.dutyCycle, message.elements.Heater, tag)) {
						this.updated(device, 'dutyCycle', message.state)

						const parent = (device as SubDevice<DewHeater, DewHeater>).parent
						this.updated(parent, 'dutyCycle', message.state)
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

		if (full || name === 'Heater') {
			resetDeviceValue(this, device, 'hasDewHeater', DEFAULT_DEW_HEATER.hasDewHeater)
			resetDeviceValue(this, device, 'dutyCycle', DEFAULT_DEW_HEATER.dutyCycle)

			const parent = (device as SubDevice<DewHeater, DewHeater>).parent
			this.updated(parent, 'hasDewHeater')
			this.updated(parent, 'dutyCycle')

			this.#pwm.delete(device)

			// Force remove the device passing name as undefined.
			super.delProperty(client, full ? message : { ...message, name: undefined })
			return
		}

		super.delProperty(client, message)
	}
}
