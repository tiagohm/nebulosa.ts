import { CLIENT, type Client, DEFAULT_ROTATOR, DeviceInterfaceType, type Rotator } from '../device'
import type { DefNumberVector, DefSwitchVector, DefTextVector, DelProperty, SetNumberVector, SetSwitchVector, SetTextVector } from '../types'
import { DeviceManager, handleMinMaxValue, handleSwitchValue, resetDeviceValue } from './device'

// https://github.com/indilib/indi/blob/master/libs/indibase/indirotatorinterface.cpp

// Manager for field rotators; goto/sync angle (degrees), reverse, home, and abort, reflecting angle/motion.
export class RotatorManager extends DeviceManager<Rotator> {
	moveTo(rotator: Rotator, angle: number, client = rotator[CLIENT]!) {
		client.sendNumber({ device: rotator.name, name: 'ABS_ROTATOR_ANGLE', elements: { ANGLE: angle } })
	}

	syncTo(rotator: Rotator, angle: number, client = rotator[CLIENT]!) {
		if (rotator.canSync) {
			client.sendNumber({ device: rotator.name, name: 'SYNC_ROTATOR_ANGLE', elements: { ANGLE: angle } })
		}
	}

	home(rotator: Rotator, client = rotator[CLIENT]!) {
		if (rotator.canHome) {
			client.sendSwitch({ device: rotator.name, name: 'ROTATOR_HOME', elements: { HOME: true } })
		}
	}

	reverse(rotator: Rotator, enabled: boolean, client = rotator[CLIENT]!) {
		if (rotator.canReverse) {
			client.sendSwitch({ device: rotator.name, name: 'ROTATOR_REVERSE', elements: { [enabled ? 'INDI_ENABLED' : 'INDI_DISABLED']: true } })
		}
	}

	stop(rotator: Rotator, client = rotator[CLIENT]!) {
		if (rotator.canAbort) {
			client.sendSwitch({ device: rotator.name, name: 'ROTATOR_ABORT_MOTION', elements: { ABORT: true } })
		}
	}

	// Applies rotator switch vectors: abort, home, and reverse capabilities/state, and backlash compensation.
	switchVector(client: Client, message: DefSwitchVector | SetSwitchVector, tag: string) {
		const device = this.get(client, message.device)

		if (device === undefined) return

		super.switchVector(client, message, tag)

		switch (message.name) {
			case 'ROTATOR_ABORT_MOTION':
				if (tag[0] === 'd') {
					if (handleSwitchValue(device, 'canAbort', true)) {
						this.updated(device, 'canAbort', message.state)
					}
				}

				return
			case 'ROTATOR_HOME':
				if (tag[0] === 'd') {
					if (handleSwitchValue(device, 'canHome', true)) {
						this.updated(device, 'canHome', message.state)
					}
				}

				return
			case 'ROTATOR_REVERSE':
				if (tag[0] === 'd') {
					if (handleSwitchValue(device, 'canReverse', true)) {
						this.updated(device, 'canReverse', message.state)
					}
				}

				if (handleSwitchValue(device, 'reversed', message.elements.INDI_ENABLED?.value)) {
					this.updated(device, 'reversed', message.state)
				}

				return
			case 'ROTATOR_BACKLASH_TOGGLE':
				if (handleSwitchValue(device, 'hasBacklashCompensation', message.elements.INDI_ENABLED?.value)) {
					this.updated(device, 'hasBacklashCompensation', message.state)
				}
		}
	}

	// Applies rotator number vectors: the absolute angle (degrees)/moving state and sync capability.
	numberVector(client: Client, message: DefNumberVector | SetNumberVector, tag: string) {
		const device = this.get(client, message.device)

		if (device === undefined) return

		switch (message.name) {
			case 'ABS_ROTATOR_ANGLE':
				if (handleMinMaxValue(device.angle, message.elements.ANGLE, tag)) {
					this.updated(device, 'angle', message.state)
				}

				if (handleSwitchValue(device, 'moving', message.state === 'Busy')) {
					this.updated(device, 'moving', message.state)
				}

				return
			case 'SYNC_ROTATOR_ANGLE':
				if (tag[0] === 'd') {
					if (handleSwitchValue(device, 'canSync', true)) {
						this.updated(device, 'canSync', message.state)
					}
				}
		}
	}

	// Creates/updates the rotator from DRIVER_INFO.
	textVector(client: Client, message: DefTextVector | SetTextVector, tag: string) {
		if (message.name === 'DRIVER_INFO') {
			return this.handleDriverInfo(client, message, DeviceInterfaceType.ROTATOR)
		}
	}

	delProperty(client: Client, message: DelProperty) {
		const device = this.get(client, message.device)

		if (device === undefined) return

		const name = message.name
		const full = !name

		if (full || name === 'ROTATOR_ABORT_MOTION') {
			resetDeviceValue(this, device, 'canAbort', DEFAULT_ROTATOR.canAbort)
		}
		if (full || name === 'ROTATOR_HOME') {
			resetDeviceValue(this, device, 'canHome', DEFAULT_ROTATOR.canHome)
		}
		if (full || name === 'ROTATOR_REVERSE') {
			resetDeviceValue(this, device, 'canReverse', DEFAULT_ROTATOR.canReverse)
			resetDeviceValue(this, device, 'reversed', DEFAULT_ROTATOR.reversed)
		}
		if (full || name === 'ROTATOR_BACKLASH_TOGGLE') {
			resetDeviceValue(this, device, 'hasBacklashCompensation', DEFAULT_ROTATOR.hasBacklashCompensation)
		}
		if (full || name === 'ABS_ROTATOR_ANGLE') {
			resetDeviceValue(this, device, 'angle', DEFAULT_ROTATOR.angle)
			resetDeviceValue(this, device, 'moving', DEFAULT_ROTATOR.moving)
		}
		if (full || name === 'SYNC_ROTATOR_ANGLE') {
			resetDeviceValue(this, device, 'canSync', DEFAULT_ROTATOR.canSync)
		}

		super.delProperty(client, message)
	}
}
