import { CLIENT, type Client, DEFAULT_POWER, DeviceInterfaceType, type Power, type PowerChannel, type PowerChannelType } from '../device'
import type { DefElement, DefNumberVector, DefSwitchVector, DefTextVector, DefVector, DelProperty, SetNumberVector, SetSwitchVector, SetTextVector, SetVector } from '../types'
import { DeviceManager, handleMinMaxValue, handleSwitchValue, resetDeviceValue } from './device'

// https://github.com/indilib/indi/blob/master/libs/indibase/indipowerinterface.cpp

// Manager for power-distribution devices; toggles/sets DC, dew, variable-voltage, USB, and auto-dew
// channels and reflects aggregate voltage/current/power plus per-channel state.
export class PowerManager extends DeviceManager<Power> {
	toggle(power: Power, channel: PowerChannel, value: boolean, client = power[CLIENT]!) {
		const name = channel.type === 'dc' ? 'POWER_CHANNELS' : channel.type === 'dew' ? 'DEW_CHANNELS' : channel.type === 'autoDew' ? 'AUTO_DEW_CONTROL' : channel.type === 'usb' ? 'USB_PORTS' : 'VARIABLE_CHANNELS'
		client.sendSwitch({ device: power.name, name, elements: { [channel.name]: value } })
	}

	voltage(power: Power, channel: PowerChannel, value: number, client = power[CLIENT]!) {
		if (channel.type !== 'variableVoltage') return
		client.sendNumber({ device: power.name, name: 'VARIABLE_VOLTAGES', elements: { [channel.name]: value } })
	}

	dutyCycle(power: Power, channel: PowerChannel, value: number, client = power[CLIENT]!) {
		if (channel.type !== 'dew') return
		client.sendNumber({ device: power.name, name: 'DEW_DUTY_CYCLES', elements: { [channel.name]: value } })
	}

	// Applies power switch vectors: per-channel enabled state for DC/dew/auto-dew/variable/USB channels and
	// the power-cycle capability.
	switchVector(client: Client, message: DefSwitchVector | SetSwitchVector, tag: string) {
		const device = this.get(client, message.device)

		if (device === undefined) return

		super.switchVector(client, message, tag)

		switch (message.name) {
			case 'POWER_CHANNELS':
				handlePowerChannel(this, device, message, tag, 'dc', 'enabled')
				return
			case 'DEW_CHANNELS':
				handlePowerChannel(this, device, message, tag, 'dew', 'enabled')
				return
			case 'AUTO_DEW_CONTROL':
				handlePowerChannel(this, device, message, tag, 'autoDew', 'enabled')
				return
			case 'VARIABLE_CHANNELS':
				handlePowerChannel(this, device, message, tag, 'variableVoltage', 'enabled')
				return
			case 'USB_PORTS':
				handlePowerChannel(this, device, message, tag, 'usb', 'enabled')
				return
			case 'POWER_CYCLE_Toggle':
				if (tag[0] === 'd') {
					if (handleSwitchValue(device, 'hasPowerCycle', true)) {
						this.updated(device, 'hasPowerCycle', message.state)
					}
				}
		}
	}

	// Applies power number vectors: aggregate voltage/current/power sensors and per-channel current/duty
	// values for DC/dew/auto-dew/variable channels.
	numberVector(client: Client, message: DefNumberVector | SetNumberVector, tag: string) {
		const device = this.get(client, message.device)

		if (device === undefined) return

		switch (message.name) {
			case 'POWER_SENSORS':
				if (handleMinMaxValue(device.voltage, message.elements.SENSOR_VOLTAGE, tag)) {
					this.updated(device, 'voltage', message.state)
				}

				if (handleMinMaxValue(device.current, message.elements.SENSOR_CURRENT, tag)) {
					this.updated(device, 'current', message.state)
				}

				if (handleMinMaxValue(device.power, message.elements.SENSOR_POWER, tag)) {
					this.updated(device, 'power', message.state)
				}

				return
			// Power Channel Current (only if per-channel current monitoring is available)
			case 'POWER_CURRENTS':
				handlePowerChannel(this, device, message, tag, 'dc', 'value')
				return
			case 'DEW_DUTY_CYCLES':
				handlePowerChannel(this, device, message, tag, 'dew', 'value')
				return
			case 'DEW_CURRENTS':
				handlePowerChannel(this, device, message, tag, 'autoDew', 'value')
				return
			case 'VARIABLE_VOLTAGES':
				handlePowerChannel(this, device, message, tag, 'variableVoltage', 'value')
		}
	}

	// Creates/updates the power device from DRIVER_INFO and applies the per-channel label text vectors.
	textVector(client: Client, message: DefTextVector | SetTextVector, tag: string) {
		if (message.name === 'DRIVER_INFO') {
			return this.handleDriverInfo(client, message, DeviceInterfaceType.POWER)
		}

		const device = this.get(client, message.device)

		if (device === undefined) return

		switch (message.name) {
			case 'POWER_LABELS':
				handlePowerChannel(this, device, message, tag, 'dc', 'label')
				return
			case 'DEW_LABELS':
				handlePowerChannel(this, device, message, tag, 'dew', 'label')
				return
			case 'USB_LABELS':
				handlePowerChannel(this, device, message, tag, 'usb', 'label')
				return
			case 'VARIABLE_LABELS':
				handlePowerChannel(this, device, message, tag, 'variableVoltage', 'label')
		}
	}

	delProperty(client: Client, message: DelProperty) {
		const device = this.get(client, message.device)

		if (device === undefined) return

		const name = message.name
		const full = !name

		if (full || name === 'POWER_CHANNELS' || name === 'POWER_CURRENTS' || name === 'POWER_LABELS') {
			resetDeviceValue(this, device, 'dc', DEFAULT_POWER.dc)
		}
		if (full || name === 'DEW_CHANNELS' || name === 'DEW_DUTY_CYCLES' || name === 'DEW_LABELS') {
			resetDeviceValue(this, device, 'dew', DEFAULT_POWER.dew)
		}
		if (full || name === 'AUTO_DEW_CONTROL' || name === 'DEW_CURRENTS') {
			resetDeviceValue(this, device, 'autoDew', DEFAULT_POWER.autoDew)
		}
		if (full || name === 'VARIABLE_CHANNELS' || name === 'VARIABLE_VOLTAGES' || name === 'VARIABLE_LABELS') {
			resetDeviceValue(this, device, 'variableVoltage', DEFAULT_POWER.variableVoltage)
		}
		if (full || name === 'USB_PORTS' || name === 'USB_LABELS') {
			resetDeviceValue(this, device, 'usb', DEFAULT_POWER.usb)
		}
		if (full || name === 'POWER_CYCLE_Toggle') {
			resetDeviceValue(this, device, 'hasPowerCycle', DEFAULT_POWER.hasPowerCycle)
		}
		if (full || name === 'POWER_SENSORS') {
			resetDeviceValue(this, device, 'voltage', DEFAULT_POWER.voltage)
			resetDeviceValue(this, device, 'current', DEFAULT_POWER.current)
			resetDeviceValue(this, device, 'power', DEFAULT_POWER.power)
		}

		super.delProperty(client, message)
	}
}

// Reconciles one power-channel list (dc/dew/usb/variable) against an incoming vector: updates each
// channel's label/value/enabled or min/max range, appends new channels, trims removed ones, and notifies
// on any change. Returns whether anything changed.
function handlePowerChannel(manager: DeviceManager<Power>, device: Power, message: DefVector | SetVector, tag: string, type: PowerChannelType, property: keyof Omit<PowerChannel, 'type'>, client = device[CLIENT]!) {
	const entries = Object.entries(message.elements) as readonly [string, DefElement][]
	const channels = device[type]
	let updated = false

	for (let i = 0; i < entries.length; i++) {
		const [name, entry] = entries[i]
		const p = channels[i] ?? ({ type, name, label: entry.label ?? '', enabled: false, value: 0, min: 0, max: 0, step: 0 } satisfies PowerChannel)

		if (tag[0] === 'd' && 'max' in entry) {
			updated ||= handleMinMaxValue(p, entry, tag)
		} else {
			const value = entry.value as never

			if (p[property] !== value) {
				p[property] = value
				updated = true
			}
		}

		if (channels[i] === undefined) {
			channels[i] = p
			updated = true
		}
	}

	if (entries.length < channels.length) {
		channels.splice(entries.length, channels.length - entries.length)
		updated = true
	}

	if (updated) {
		manager.updated(device, type, message.state)
	}

	return updated
}
