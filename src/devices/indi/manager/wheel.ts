import { CLIENT, type Client, DEFAULT_WHEEL, DeviceInterfaceType, type Wheel } from '../device'
import type { DefNumberVector, DefTextVector, DelProperty, SetNumberVector, SetTextVector } from '../types'
import { DeviceManager, handleNumberValue, handleSwitchValue, resetDeviceValue } from './device'

// https://github.com/indilib/indi/blob/master/libs/indibase/indifilterwheel.cpp

// Manager for filter wheels; moves to a slot and edits filter names, reflecting slot count/position.
export class WheelManager extends DeviceManager<Wheel> {
	moveTo(wheel: Wheel, slot: number, client = wheel[CLIENT]!) {
		client.sendNumber({ device: wheel.name, name: 'FILTER_SLOT', elements: { FILTER_SLOT_VALUE: slot + 1 } })
	}

	slots(wheel: Wheel, names: readonly string[], client = wheel[CLIENT]!) {
		const elements: Record<string, string> = {}
		for (let i = 0; i < names.length; i++) elements[`FILTER_SLOT_NAME_${i + 1}`] = names[i]
		client.sendText({ device: wheel.name, name: 'FILTER_NAME', elements })
	}

	// Applies the filter-slot number vector: slot count, current position (converted to 0-based), and
	// moving state.
	numberVector(client: Client, message: DefNumberVector | SetNumberVector, tag: string) {
		const device = this.get(client, message.device)

		if (device === undefined) return

		switch (message.name) {
			case 'FILTER_SLOT':
				if (tag[0] === 'd') {
					if (handleNumberValue(device, 'count', (message as DefNumberVector).elements.FILTER_SLOT_VALUE.max)) {
						this.updated(device, 'count', message.state)
					}
				}

				if (handleNumberValue(device, 'position', message.elements.FILTER_SLOT_VALUE.value - 1)) {
					this.updated(device, 'position', message.state)
				}

				if (handleSwitchValue(device, 'moving', message.state === 'Busy')) {
					this.updated(device, 'moving', message.state)
				}
		}
	}

	// Creates/updates the wheel from DRIVER_INFO and applies its filter-name list text vector.
	textVector(client: Client, message: DefTextVector | SetTextVector, tag: string) {
		if (message.name === 'DRIVER_INFO') {
			return this.handleDriverInfo(client, message, DeviceInterfaceType.FILTER)
		}

		const device = this.get(client, message.device)

		if (device === undefined) return

		switch (message.name) {
			case 'FILTER_NAME': {
				if (tag[0] === 'd') {
					if (handleSwitchValue(device, 'canSetNames', (message as DefTextVector).permission !== 'ro')) {
						this.updated(device, 'canSetNames', message.state)
					}
				}

				const names = Object.values(message.elements)

				if (names.length !== device.names.length || names.some((e, index) => e.value !== device.names[index])) {
					device.names = names.map((e) => e.value)
					this.updated(device, 'names', message.state)
				}
			}
		}
	}

	delProperty(client: Client, message: DelProperty) {
		const device = this.get(client, message.device)

		if (device === undefined) return

		const name = message.name
		const full = !name

		if (full || name === 'FILTER_SLOT') {
			resetDeviceValue(this, device, 'count', DEFAULT_WHEEL.count)
			resetDeviceValue(this, device, 'position', DEFAULT_WHEEL.position)
			resetDeviceValue(this, device, 'moving', DEFAULT_WHEEL.moving)
		}
		if (full || name === 'FILTER_NAME') {
			resetDeviceValue(this, device, 'canSetNames', DEFAULT_WHEEL.canSetNames)
			resetDeviceValue(this, device, 'names', DEFAULT_WHEEL.names)
		}

		super.delProperty(client, message)
	}
}
