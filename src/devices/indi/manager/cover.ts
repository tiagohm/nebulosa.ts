import { CLIENT, type Client, DEFAULT_COVER, DeviceInterfaceType, type Cover } from '../device'
import type { DefSwitchVector, DefTextVector, DelProperty, SetSwitchVector, SetTextVector } from '../types'
import { DeviceManager, handleParkable, handleSwitchValue, resetDeviceValue } from './device'

// https://github.com/indilib/indi/blob/master/libs/indibase/indidustcapinterface.cpp

// Manager for telescope covers/dust caps; park (close)/unpark (open) and abort, reflecting cover state.
export class CoverManager extends DeviceManager<Cover> {
	unpark(cover: Cover, client = cover[CLIENT]!) {
		if (cover.canPark) {
			client.sendSwitch({ device: cover.name, name: 'CAP_PARK', elements: { UNPARK: true } })
		}
	}

	park(cover: Cover, client = cover[CLIENT]!) {
		if (cover.canPark) {
			client.sendSwitch({ device: cover.name, name: 'CAP_PARK', elements: { PARK: true } })
		}
	}

	stop(cover: Cover, client = cover[CLIENT]!) {
		if (cover.canAbort) {
			client.sendSwitch({ device: cover.name, name: 'CAP_ABORT', elements: { ABORT: true } })
		}
	}

	// Applies cover switch vectors: park (open/close) state and abort capability.
	switchVector(client: Client, message: DefSwitchVector | SetSwitchVector, tag: string) {
		const device = this.get(client, message.device)

		if (device === undefined) return

		super.switchVector(client, message, tag)

		switch (message.name) {
			case 'CAP_PARK':
				handleParkable(this, device, message, tag)
				return
			case 'CAP_ABORT':
				if (handleSwitchValue(device, 'canAbort', true)) {
					this.updated(device, 'canAbort', message.state)
				}
		}
	}

	// Creates/updates the cover from DRIVER_INFO.
	textVector(client: Client, message: DefTextVector | SetTextVector, tag: string) {
		if (message.name === 'DRIVER_INFO') {
			return this.handleDriverInfo(client, message, DeviceInterfaceType.DUSTCAP)
		}
	}

	delProperty(client: Client, message: DelProperty) {
		const device = this.get(client, message.device)

		if (device === undefined) return

		const name = message.name
		const full = !name

		if (full || name === 'CAP_PARK') {
			resetDeviceValue(this, device, 'canPark', DEFAULT_COVER.canPark)
			resetDeviceValue(this, device, 'parking', DEFAULT_COVER.parking)
			resetDeviceValue(this, device, 'parked', DEFAULT_COVER.parked)
		}
		if (full || name === 'CAP_ABORT') {
			resetDeviceValue(this, device, 'canAbort', DEFAULT_COVER.canAbort)
		}

		super.delProperty(client, message)
	}
}
