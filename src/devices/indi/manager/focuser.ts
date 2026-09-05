import { CLIENT, type Client, DEFAULT_FOCUSER, DeviceInterfaceType, type Focuser } from '../device'
import type { DefNumberVector, DefSwitchVector, DefTextVector, DelProperty, SetNumberVector, SetSwitchVector, SetTextVector } from '../types'
import { DeviceManager, handleMinMaxValue, handleSwitchValue, resetDeviceValue } from './device'

// https://github.com/indilib/indi/blob/master/libs/indibase/indifocuserinterface.cpp

// Manager for focusers; absolute/relative move, sync, reverse, and abort, reflecting position (steps),
// motion, and temperature.
export class FocuserManager extends DeviceManager<Focuser> {
	stop(focuser: Focuser, client = focuser[CLIENT]!) {
		if (focuser.canAbort) {
			client.sendSwitch({ device: focuser.name, name: 'FOCUS_ABORT_MOTION', elements: { ABORT: true } })
		}
	}

	moveIn(focuser: Focuser, steps: number, client = focuser[CLIENT]!) {
		if (focuser.canRelativeMove) {
			client.sendSwitch({ device: focuser.name, name: 'FOCUS_MOTION', elements: { FOCUS_INWARD: true } })
			client.sendNumber({ device: focuser.name, name: 'REL_FOCUS_POSITION', elements: { FOCUS_RELATIVE_POSITION: steps } })
		}
	}

	moveOut(focuser: Focuser, steps: number, client = focuser[CLIENT]!) {
		if (focuser.canRelativeMove) {
			client.sendSwitch({ device: focuser.name, name: 'FOCUS_MOTION', elements: { FOCUS_OUTWARD: true } })
			client.sendNumber({ device: focuser.name, name: 'REL_FOCUS_POSITION', elements: { FOCUS_RELATIVE_POSITION: steps } })
		}
	}

	moveTo(focuser: Focuser, position: number, client = focuser[CLIENT]!) {
		if (focuser.canAbsoluteMove) {
			client.sendNumber({ device: focuser.name, name: 'ABS_FOCUS_POSITION', elements: { FOCUS_ABSOLUTE_POSITION: position } })
		}
	}

	syncTo(focuser: Focuser, position: number, client = focuser[CLIENT]!) {
		if (focuser.canSync) {
			client.sendNumber({ device: focuser.name, name: 'FOCUS_SYNC', elements: { FOCUS_SYNC_VALUE: position } })
		}
	}

	reverse(focuser: Focuser, enabled: boolean, client = focuser[CLIENT]!) {
		if (focuser.canReverse) {
			client.sendSwitch({ device: focuser.name, name: 'FOCUS_REVERSE_MOTION', elements: { [enabled ? 'INDI_ENABLED' : 'INDI_DISABLED']: true } })
		}
	}

	// Applies focuser switch vectors: abort capability and reverse capability/state.
	switchVector(client: Client, message: DefSwitchVector | SetSwitchVector, tag: string) {
		const device = this.get(client, message.device)

		if (device === undefined) return

		super.switchVector(client, message, tag)

		switch (message.name) {
			case 'FOCUS_ABORT_MOTION':
				if (tag[0] === 'd') {
					if (handleSwitchValue(device, 'canAbort', true)) {
						this.updated(device, 'canAbort', message.state)
					}
				}

				return
			case 'FOCUS_REVERSE_MOTION':
				if (tag[0] === 'd') {
					if (handleSwitchValue(device, 'canReverse', true)) {
						this.updated(device, 'canReverse', message.state)
					}
				}

				if (handleSwitchValue(device, 'reversed', message.elements.INDI_ENABLED?.value)) {
					this.updated(device, 'reversed', message.state)
				}
		}
	}

	// Applies focuser number vectors: sync/relative/absolute capabilities, the absolute position (steps),
	// and moving state.
	numberVector(client: Client, message: DefNumberVector | SetNumberVector, tag: string) {
		const device = this.get(client, message.device)

		if (device === undefined) return

		switch (message.name) {
			case 'FOCUS_SYNC':
				if (tag[0] === 'd') {
					if (handleSwitchValue(device, 'canSync', true)) {
						this.updated(device, 'canSync', message.state)
					}
				}

				return
			case 'REL_FOCUS_POSITION':
				if (tag[0] === 'd') {
					if (handleSwitchValue(device, 'canRelativeMove', true)) {
						this.updated(device, 'canRelativeMove', message.state)
					}
				}

				if (handleSwitchValue(device, 'moving', message.state === 'Busy')) {
					this.updated(device, 'moving', message.state)
				}

				return
			case 'ABS_FOCUS_POSITION':
				if (tag[0] === 'd') {
					if (handleSwitchValue(device, 'canAbsoluteMove', true)) {
						this.updated(device, 'canAbsoluteMove', message.state)
					}
				}

				if (handleMinMaxValue(device.position, message.elements.FOCUS_ABSOLUTE_POSITION, tag)) {
					this.updated(device, 'position', message.state)
				}

				if (handleSwitchValue(device, 'moving', message.state === 'Busy')) {
					this.updated(device, 'moving', message.state)
				}
		}
	}

	// Creates/updates the focuser from DRIVER_INFO.
	textVector(client: Client, message: DefTextVector | SetTextVector, tag: string) {
		if (message.name === 'DRIVER_INFO') {
			return this.handleDriverInfo(client, message, DeviceInterfaceType.FOCUSER)
		}
	}

	delProperty(client: Client, message: DelProperty) {
		const device = this.get(client, message.device)

		if (device === undefined) return

		const name = message.name
		const full = !name

		if (full || name === 'FOCUS_ABORT_MOTION') {
			resetDeviceValue(this, device, 'canAbort', DEFAULT_FOCUSER.canAbort)
		}
		if (full || name === 'FOCUS_REVERSE_MOTION') {
			resetDeviceValue(this, device, 'canReverse', DEFAULT_FOCUSER.canReverse)
			resetDeviceValue(this, device, 'reversed', DEFAULT_FOCUSER.reversed)
		}
		if (full || name === 'FOCUS_SYNC') {
			resetDeviceValue(this, device, 'canSync', DEFAULT_FOCUSER.canSync)
		}
		if (full || name === 'REL_FOCUS_POSITION') {
			resetDeviceValue(this, device, 'canRelativeMove', DEFAULT_FOCUSER.canRelativeMove)
			resetDeviceValue(this, device, 'moving', DEFAULT_FOCUSER.moving)
		}
		if (full || name === 'ABS_FOCUS_POSITION') {
			resetDeviceValue(this, device, 'canAbsoluteMove', DEFAULT_FOCUSER.canAbsoluteMove)
			resetDeviceValue(this, device, 'position', DEFAULT_FOCUSER.position)
			resetDeviceValue(this, device, 'moving', DEFAULT_FOCUSER.moving)
		}

		super.delProperty(client, message)
	}
}
