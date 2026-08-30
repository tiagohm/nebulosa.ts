import { CLIENT, type Client, DEFAULT_GUIDE_OUTPUT, type GuideDirection, type GuideOutput, type SubDevice } from '../device'
import type { DefNumberVector, DefVector, DelProperty, SetNumberVector, SetVector } from '../types'
import { DeviceManager, type DeviceProvider, handleNumberValue, handleSwitchValue, makeDeviceId, proxyDevice, resetDeviceValue } from './device'

// Manager for stand-alone or embedded guide outputs. Command methods send pulse-guide (durations in
// milliseconds) and guide-rate commands; property handling reflects pulse-guiding capability/state.
export class GuideOutputManager extends DeviceManager<GuideOutput> {
	constructor(readonly provider: DeviceProvider<GuideOutput>) {
		super()
	}

	// Issues a timed pulse-guide in one direction; duration is milliseconds. No-op without the capability.
	pulseNorth(device: GuideOutput, duration: number, client = device[CLIENT]!) {
		if (device.canPulseGuide) {
			client.sendNumber({ device: device.name, name: 'TELESCOPE_TIMED_GUIDE_NS', elements: { TIMED_GUIDE_N: duration } })
		}
	}

	pulseSouth(device: GuideOutput, duration: number, client = device[CLIENT]!) {
		if (device.canPulseGuide) {
			client.sendNumber({ device: device.name, name: 'TELESCOPE_TIMED_GUIDE_NS', elements: { TIMED_GUIDE_S: duration } })
		}
	}

	pulseWest(device: GuideOutput, duration: number, client = device[CLIENT]!) {
		if (device.canPulseGuide) {
			client.sendNumber({ device: device.name, name: 'TELESCOPE_TIMED_GUIDE_WE', elements: { TIMED_GUIDE_W: duration } })
		}
	}

	pulseEast(device: GuideOutput, duration: number, client = device[CLIENT]!) {
		if (device.canPulseGuide) {
			client.sendNumber({ device: device.name, name: 'TELESCOPE_TIMED_GUIDE_WE', elements: { TIMED_GUIDE_E: duration } })
		}
	}

	pulse(device: GuideOutput, direction: GuideDirection, duration: number, client = device[CLIENT]!) {
		if (direction === 'NORTH') this.pulseNorth(device, duration, client)
		else if (direction === 'SOUTH') this.pulseSouth(device, duration, client)
		else if (direction === 'WEST') this.pulseWest(device, duration, client)
		else if (direction === 'EAST') this.pulseEast(device, duration, client)
	}

	guideRate(device: GuideOutput, rightAscension: number, declination: number, client = device[CLIENT]!) {
		if (device.canSetGuideRate) {
			client.sendNumber({ device: device.name, name: 'GUIDE_RATE', elements: { GUIDE_RATE_WE: rightAscension, GUIDE_RATE_NS: declination } })
		}
	}

	#addProxy(client: Client, parent: GuideOutput) {
		const id = makeDeviceId(client, 'guideOutput', parent.name)
		const device = proxyDevice(parent, id, 'guideOutput')

		if (this.add(device)) {
			this.updated(device, 'canPulseGuide')
			this.updated(parent, 'canPulseGuide')
		}

		return device
	}

	// Forwards only the vectors relevant to a guide output (driver/connection and the timed-guide/guide-
	// rate properties) to the base property tracking.
	vector(client: Client, message: DefVector | SetVector, tag: string) {
		switch (message.name) {
			case 'DRIVER_INFO':
			case 'CONNECTION':
			case 'TELESCOPE_TIMED_GUIDE_NS':
			case 'TELESCOPE_TIMED_GUIDE_WE':
			case 'GUIDE_RATE':
				return super.vector(client, message, tag)
		}
	}

	// Applies the timed-guide (pulsing state) and guide-rate number vectors, lazily creating a guide-output
	// proxy over a parent mount/camera that advertises pulse-guiding.
	numberVector(client: Client, message: DefNumberVector | SetNumberVector, tag: string) {
		switch (message.name) {
			case 'TELESCOPE_TIMED_GUIDE_NS':
			case 'TELESCOPE_TIMED_GUIDE_WE': {
				let device = this.get(client, message.device)

				if (device === undefined && tag[0] === 'd') {
					const parent = this.provider.get(client, message.device, 'mount') ?? this.provider.get(client, message.device, 'camera')

					if (parent !== undefined && handleSwitchValue(parent, 'canPulseGuide', true)) {
						device = this.#addProxy(client, parent)
					}
				}

				if (device !== undefined) {
					const property = message.name === 'TELESCOPE_TIMED_GUIDE_NS' ? 'pulsingNS' : 'pulsingWE'
					const parent = (device as SubDevice<GuideOutput, GuideOutput>).parent

					if (handleSwitchValue(device, property, message.state === 'Busy')) {
						this.updated(device, property, message.state)
						this.updated(parent, property, message.state)
					}

					if (handleSwitchValue(device, 'pulsing', device.pulsingNS || device.pulsingWE)) {
						this.updated(device, 'pulsing', message.state)
						this.updated(parent, 'pulsing', message.state)
					}
				}

				return
			}
			case 'GUIDE_RATE': {
				const device = this.get(client, message.device)

				if (device !== undefined) {
					if (tag[0] === 'd') {
						if (handleSwitchValue(device, 'hasGuideRate', true)) {
							this.updated(device, 'hasGuideRate', message.state)

							const parent = (device as SubDevice<GuideOutput, GuideOutput>).parent
							this.updated(parent, 'hasGuideRate', message.state)

							if (handleSwitchValue(device, 'canSetGuideRate', (message as DefNumberVector).permission !== 'ro')) {
								this.updated(device, 'canSetGuideRate', message.state)
								this.updated(parent, 'canSetGuideRate', message.state)
							}
						}
					}

					let updated = handleNumberValue(device.guideRate, 'rightAscension', message.elements.GUIDE_RATE_WE?.value)
					updated = handleNumberValue(device.guideRate, 'declination', message.elements.GUIDE_RATE_NS?.value) || updated

					if (updated) {
						this.updated(device, 'guideRate', message.state)

						const parent = (device as SubDevice<GuideOutput, GuideOutput>).parent
						this.updated(parent, 'guideRate', message.state)
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

		if (full || name === 'TELESCOPE_TIMED_GUIDE_NS' || name === 'TELESCOPE_TIMED_GUIDE_WE') {
			resetDeviceValue(this, device, 'canPulseGuide', DEFAULT_GUIDE_OUTPUT.canPulseGuide)
			resetDeviceValue(this, device, 'pulsing', DEFAULT_GUIDE_OUTPUT.pulsing)
			resetDeviceValue(this, device, 'pulsingNS', DEFAULT_GUIDE_OUTPUT.pulsingNS)
			resetDeviceValue(this, device, 'pulsingWE', DEFAULT_GUIDE_OUTPUT.pulsingWE)

			const parent = (device as SubDevice<GuideOutput, GuideOutput>).parent
			this.updated(parent, 'canPulseGuide')
			this.updated(parent, 'pulsing')
			this.updated(parent, 'pulsingNS')
			this.updated(parent, 'pulsingWE')
		}
		if (full || name === 'GUIDE_RATE') {
			resetDeviceValue(this, device, 'hasGuideRate', DEFAULT_GUIDE_OUTPUT.hasGuideRate)
			resetDeviceValue(this, device, 'canSetGuideRate', DEFAULT_GUIDE_OUTPUT.canSetGuideRate)
			resetDeviceValue(this, device, 'guideRate', DEFAULT_GUIDE_OUTPUT.guideRate)

			const parent = (device as SubDevice<GuideOutput, GuideOutput>).parent
			this.updated(parent, 'hasGuideRate')
			this.updated(parent, 'canSetGuideRate')
			this.updated(parent, 'guideRate')
		}

		// When both properties are removed, remove the device too passing name as undefined.
		if (!device.canPulseGuide && !device.hasGuideRate) {
			super.delProperty(client, full ? message : { ...message, name: undefined })
		} else {
			super.delProperty(client, message)
		}
	}
}
