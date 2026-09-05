import { CLIENT, type Client, type Device, DeviceInterfaceType } from '../../../../src/devices/indi/device'
import type { DefNumber, DefSwitch, DefTextVector } from '../../../../src/devices/indi/types'

export const client: Client = {
	type: 'INDI',
	id: 'client',
	description: '',
	getProperties() {},
	enableBlob() {},
	sendText() {},
	sendNumber() {},
	sendSwitch() {},
	[Symbol.dispose]() {},
}

export function createRecordingClient(id = 'recording') {
	const numberCommands: Parameters<Client['sendNumber']>[0][] = []
	const switchCommands: Parameters<Client['sendSwitch']>[0][] = []
	const commands: [type: 'number' | 'switch', name: string, elements: Record<string, number | boolean>][] = []
	const recordingClient: Client = {
		...client,
		id,
		sendNumber(vector) {
			numberCommands.push(vector)
			commands.push(['number', vector.name, vector.elements])
		},
		sendSwitch(vector) {
			switchCommands.push(vector)
			commands.push(['switch', vector.name, vector.elements])
		},
	}

	return { recordingClient, numberCommands, switchCommands, commands }
}

export function defSwitch(name: string, value: boolean, label?: string): DefSwitch {
	return label === undefined ? { name, value } : { name, value, label }
}

export function defNumber(name: string, value: number, min = 0, max = 360, step = 1): DefNumber {
	return { name, format: '%g', min, max, step, value }
}

export function driverInfo(device: string, interfaceType: DeviceInterfaceType): DefTextVector {
	return {
		device,
		name: 'DRIVER_INFO',
		permission: 'ro',
		state: 'Ok',
		elements: {
			DRIVER_INTERFACE: { name: 'DRIVER_INTERFACE', value: interfaceType.toFixed(0) },
			DRIVER_EXEC: { name: 'DRIVER_EXEC', value: 'driver' },
			DRIVER_VERSION: { name: 'DRIVER_VERSION', value: '1.0' },
		},
	}
}

export function setupDevice<D extends Device>(device: D, owner: Client = client) {
	device.id = Bun.randomUUIDv7()
	device.name = device.type
	Object.defineProperty(device, CLIENT, { value: owner })
	return device
}
