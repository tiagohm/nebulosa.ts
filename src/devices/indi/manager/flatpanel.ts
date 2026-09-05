import { CLIENT, type Client, DEFAULT_FLAT_PANEL, DeviceInterfaceType, type FlatPanel } from '../device'
import type { DefNumberVector, DefSwitchVector, DefTextVector, DelProperty, SetNumberVector, SetSwitchVector, SetTextVector } from '../types'
import { DeviceManager, handleMinMaxValue, handleSwitchValue, resetDeviceValue } from './device'

// https://github.com/indilib/indi/blob/master/libs/indibase/indilightboxinterface.cpp

// Manager for flat-field light panels; enable/disable and set intensity, reflecting panel state.
export class FlatPanelManager extends DeviceManager<FlatPanel> {
	intensity(panel: FlatPanel, value: number, client = panel[CLIENT]!) {
		client.sendNumber({ device: panel.name, name: 'FLAT_LIGHT_INTENSITY', elements: { FLAT_LIGHT_INTENSITY_VALUE: value } })
	}

	enable(panel: FlatPanel, client = panel[CLIENT]!) {
		client.sendSwitch({ device: panel.name, name: 'FLAT_LIGHT_CONTROL', elements: { FLAT_LIGHT_ON: true } })
	}

	disable(panel: FlatPanel, client = panel[CLIENT]!) {
		client.sendSwitch({ device: panel.name, name: 'FLAT_LIGHT_CONTROL', elements: { FLAT_LIGHT_OFF: true } })
	}

	toggle(panel: FlatPanel, client = panel[CLIENT]!) {
		panel.enabled ? this.disable(panel, client) : this.enable(panel, client)
	}

	// Applies the flat-panel light on/off switch vector (enabled state).
	switchVector(client: Client, message: DefSwitchVector | SetSwitchVector, tag: string) {
		const device = this.get(client, message.device)

		if (device === undefined) return

		super.switchVector(client, message, tag)

		switch (message.name) {
			case 'FLAT_LIGHT_CONTROL':
				if (handleSwitchValue(device, 'enabled', message.elements.FLAT_LIGHT_ON?.value)) {
					this.updated(device, 'enabled', message.state)
				}
		}
	}

	// Applies the flat-panel brightness/intensity number vector.
	numberVector(client: Client, message: DefNumberVector | SetNumberVector, tag: string) {
		const device = this.get(client, message.device)

		if (device === undefined) return

		switch (message.name) {
			case 'FLAT_LIGHT_INTENSITY':
				if (handleMinMaxValue(device.intensity, message.elements.FLAT_LIGHT_INTENSITY_VALUE, tag)) {
					this.updated(device, 'intensity', message.state)
				}
		}
	}

	// Creates/updates the flat panel from DRIVER_INFO.
	textVector(client: Client, message: DefTextVector | SetTextVector, tag: string) {
		if (message.name === 'DRIVER_INFO') {
			return this.handleDriverInfo(client, message, DeviceInterfaceType.LIGHTBOX)
		}
	}

	delProperty(client: Client, message: DelProperty) {
		const device = this.get(client, message.device)

		if (device === undefined) return

		const name = message.name
		const full = !name

		if (full || name === 'FLAT_LIGHT_CONTROL') {
			resetDeviceValue(this, device, 'enabled', DEFAULT_FLAT_PANEL.enabled)
		}
		if (full || name === 'FLAT_LIGHT_INTENSITY') {
			resetDeviceValue(this, device, 'intensity', DEFAULT_FLAT_PANEL.intensity)
		}

		super.delProperty(client, message)
	}
}
