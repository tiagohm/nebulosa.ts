import type { CfaPattern } from '../../../imaging/model/types'
import { type Camera, type CameraTransferFormat, CLIENT, type Client, DEFAULT_CAMERA, DeviceInterfaceType, type Focuser, type FrameType, type Mount, type Rotator, type Wheel } from '../device'
import type { DefBlobVector, DefNumberVector, DefSwitchVector, DefTextVector, DelProperty, SetBlobVector, SetNumberVector, SetSwitchVector, SetTextVector } from '../types'
import { DeviceManager, handleMinMaxValue, handleNumberValue, handleSwitchValue, handleTextValue, resetDeviceValue } from './device'

// https://github.com/indilib/indi/blob/master/libs/indibase/indiccd.cpp

// Manager for cameras. Command methods drive exposure, cooling, frame/subframe, binning, gain/offset and
// frame type; property handling maps the corresponding INDI vectors (including the CCD image BLOB) onto
// the Camera state. Temperatures are degrees Celsius, exposures seconds, pixel sizes micrometres.
export class CameraManager extends DeviceManager<Camera> {
	readonly #gain = new WeakMap<Camera, readonly [string, string]>()
	readonly #offset = new WeakMap<Camera, readonly [string, string]>()

	cooler(camera: Camera, value: boolean, client = camera[CLIENT]!) {
		if (camera.hasCoolerControl) {
			client.sendSwitch({ device: camera.name, name: 'CCD_COOLER', elements: { [value ? 'COOLER_ON' : 'COOLER_OFF']: true } })
		}
	}

	temperature(camera: Camera, value: number, client = camera[CLIENT]!) {
		if (camera.canSetTemperature) {
			client.sendNumber({ device: camera.name, name: 'CCD_TEMPERATURE', elements: { CCD_TEMPERATURE_VALUE: value } })
		}
	}

	frameFormat(camera: Camera, value: string, client = camera[CLIENT]!) {
		if (value) {
			const index = camera.frameFormats.findIndex((e) => e.name === value)
			index >= 0 && client.sendSwitch({ device: camera.name, name: 'CCD_CAPTURE_FORMAT', elements: { [camera.frameFormats[index].name]: true } })
		}
	}

	frameType(camera: Camera, value: FrameType, client = camera[CLIENT]!) {
		client.sendSwitch({ device: camera.name, name: 'CCD_FRAME_TYPE', elements: { [`FRAME_${value}`]: true } })
	}

	frame(camera: Camera, X: number, Y: number, WIDTH: number, HEIGHT: number, client = camera[CLIENT]!) {
		if (camera.canSubFrame) {
			client.sendNumber({ device: camera.name, name: 'CCD_FRAME', elements: { X, Y, WIDTH, HEIGHT } })
		}
	}

	bin(camera: Camera, x: number, y: number, client = camera[CLIENT]!) {
		if (camera.canBin) {
			client.sendNumber({ device: camera.name, name: 'CCD_BINNING', elements: { HOR_BIN: x, VER_BIN: y } })
		}
	}

	gain(camera: Camera, value: number, client = camera[CLIENT]!) {
		const property = this.#gain.get(camera)

		if (property) {
			const [name, element] = property
			client.sendNumber({ device: camera.name, name, elements: { [element]: value } })
		}
	}

	offset(camera: Camera, value: number, client = camera[CLIENT]!) {
		const property = this.#offset.get(camera)

		if (property) {
			const [name, element] = property
			client.sendNumber({ device: camera.name, name, elements: { [element]: value } })
		}
	}

	compression(camera: Camera, enabled: boolean, client = camera[CLIENT]!) {
		client.sendSwitch({ device: camera.name, name: 'CCD_COMPRESSION', elements: { [enabled ? 'INDI_ENABLED' : 'INDI_DISABLED']: true } })
	}

	transferFormat(camera: Camera, format: CameraTransferFormat, client = camera[CLIENT]!) {
		client.sendSwitch({ device: camera.name, name: 'CCD_TRANSFER_FORMAT', elements: { [`FORMAT_${format}`]: true } })
	}

	startExposure(camera: Camera, exposureTimeInSeconds: number, client = camera[CLIENT]!) {
		client.sendNumber({ device: camera.name, name: 'CCD_EXPOSURE', elements: { CCD_EXPOSURE_VALUE: exposureTimeInSeconds } })
	}

	stopExposure(camera: Camera, client = camera[CLIENT]!) {
		client.sendSwitch({ device: camera.name, name: 'CCD_ABORT_EXPOSURE', elements: { ABORT: true } })
	}

	snoop(camera: Camera, mount?: Mount, focuser?: Focuser, wheel?: Wheel, rotator?: Rotator) {
		camera[CLIENT]!.sendText({ device: camera.name, name: 'ACTIVE_DEVICES', elements: { ACTIVE_TELESCOPE: mount?.name ?? '', ACTIVE_ROTATOR: rotator?.name ?? '', ACTIVE_FOCUSER: focuser?.name ?? '', ACTIVE_FILTER: wheel?.name ?? '' } })
	}

	// Applies camera switch vectors: cooler on/off, capture/readout format, abort exposure, and frame type.
	switchVector(client: Client, message: DefSwitchVector | SetSwitchVector, tag: string) {
		const device = this.get(client, message.device)

		if (device === undefined) return

		super.switchVector(client, message, tag)

		switch (message.name) {
			case 'CCD_COOLER':
				if (tag[0] === 'd') {
					if (handleSwitchValue(device, 'hasCoolerControl', true)) {
						this.updated(device, 'hasCoolerControl', message.state)
					}
				}

				if (handleSwitchValue(device, 'cooler', message.elements.COOLER_ON?.value)) {
					this.updated(device, 'cooler', message.state)
				}

				return
			case 'CCD_CAPTURE_FORMAT': {
				const entries = Object.values((message as DefSwitchVector).elements)

				if (tag[0] === 'd') {
					device.frameFormats = entries.map((e) => ({ name: e.name, label: e.label! }))
					this.updated(device, 'frameFormats', message.state)
				}

				for (const { name, value } of entries) {
					if (value) {
						if (handleTextValue(device, 'frameFormat', name, message.state)) {
							this.updated(device, 'frameFormat', message.state)
						}

						break
					}
				}

				return
			}
			case 'CCD_ABORT_EXPOSURE':
				if (tag[0] === 'd') {
					if (handleSwitchValue(device, 'canAbort', (message as DefSwitchVector).permission !== 'ro')) {
						this.updated(device, 'canAbort', message.state)
					}
				}

				return
			case 'CCD_FRAME_TYPE':
				if (handleTextValue(device, 'frameType', message.elements.FRAME_BIAS?.value ? 'BIAS' : message.elements.FRAME_FLAT?.value ? 'FLAT' : message.elements.FRAME_DARK?.value ? 'DARK' : 'LIGHT')) {
					this.updated(device, 'frameType', message.state)
				}
		}
	}

	// Applies camera number vectors: sensor/pixel info, exposure progress, cooler power and temperature,
	// subframe, binning, controls, and gain/offset.
	numberVector(client: Client, message: DefNumberVector | SetNumberVector, tag: string) {
		const device = this.get(client, message.device)

		if (device === undefined) return

		switch (message.name) {
			case 'CCD_INFO': {
				const { elements } = message

				let changed = handleNumberValue(device.pixelSize, 'x', elements.CCD_PIXEL_SIZE_X?.value)
				changed = handleNumberValue(device.pixelSize, 'y', elements.CCD_PIXEL_SIZE_Y?.value) || changed

				if (changed) {
					this.updated(device, 'pixelSize', message.state)
				}

				return
			}
			case 'CCD_EXPOSURE': {
				let exposuringHasChanged = false

				if (handleSwitchValue(device, 'exposuring', message.state === 'Busy')) {
					this.updated(device, 'exposuring', message.state)
					exposuringHasChanged = true
				}

				if (tag[0] === 'd') {
					if (handleMinMaxValue(device.exposure, message.elements.CCD_EXPOSURE_VALUE, tag)) {
						this.updated(device, 'exposure', message.state)
					}
				} else if (handleNumberValue(device.exposure, 'value', message.elements.CCD_EXPOSURE_VALUE?.value, message.state) || exposuringHasChanged || (message.state !== undefined && device.exposure.state !== message.state)) {
					device.exposure.state = message.state ?? device.exposure.state
					this.updated(device, 'exposure', message.state)
				}

				return
			}
			case 'CCD_COOLER_POWER':
				if (handleNumberValue(device, 'coolerPower', message.elements.CCD_COOLER_POWER?.value)) {
					this.updated(device, 'coolerPower', message.state)
				}

				return
			case 'CCD_TEMPERATURE':
				if (tag[0] === 'd') {
					if (handleSwitchValue(device, 'hasCooler', true)) {
						this.updated(device, 'hasCooler', message.state)
					}

					if (handleSwitchValue(device, 'canSetTemperature', (message as DefNumberVector).permission !== 'ro')) {
						this.updated(device, 'canSetTemperature', message.state)
					}
				}

				return
			case 'CCD_FRAME': {
				if (tag[0] === 'd') {
					if (handleSwitchValue(device, 'canSubFrame', (message as DefNumberVector).permission !== 'ro')) {
						this.updated(device, 'canSubFrame', message.state)
					}
				}

				const { elements } = message

				let updated = handleMinMaxValue(device.frame.x, elements.X, tag)
				updated = handleMinMaxValue(device.frame.y, elements.Y, tag) || updated
				updated = handleMinMaxValue(device.frame.width, elements.WIDTH, tag) || updated
				updated = handleMinMaxValue(device.frame.height, elements.HEIGHT, tag) || updated

				if (updated) {
					this.updated(device, 'frame', message.state)
				}

				return
			}
			case 'CCD_BINNING': {
				if (tag[0] === 'd') {
					if (handleSwitchValue(device, 'canBin', (message as DefNumberVector).permission !== 'ro')) {
						this.updated(device, 'canBin', message.state)
					}
				}

				const { elements } = message

				let updated = handleMinMaxValue(device.bin.x, elements.HOR_BIN, tag)
				updated = handleMinMaxValue(device.bin.y, elements.VER_BIN, tag) || updated

				if (updated) {
					this.updated(device, 'bin', message.state)
				}

				return
			}
			// ZWO ASI, SVBony, etc
			case 'CCD_CONTROLS':
				if (handleMinMaxValue(device.gain, message.elements.Gain, tag)) {
					this.updated(device, 'gain', message.state)
					this.#gain.set(device, [message.name, 'Gain'])
				}

				if (handleMinMaxValue(device.offset, message.elements.Offset, tag)) {
					this.updated(device, 'offset', message.state)
					this.#offset.set(device, [message.name, 'Offset'])
				}

				return
			// CCD Simulator & Alpaca
			case 'CCD_GAIN':
				if (handleMinMaxValue(device.gain, message.elements.GAIN, tag)) {
					this.updated(device, 'gain', message.state)
					this.#gain.set(device, [message.name, 'GAIN'])
				}

				return
			case 'CCD_OFFSET':
				if (handleMinMaxValue(device.offset, message.elements.OFFSET, tag)) {
					this.updated(device, 'offset', message.state)
					this.#offset.set(device, [message.name, 'OFFSET'])
				}
		}
	}

	// Creates/updates the camera from DRIVER_INFO and applies the color-filter-array (Bayer) text vector.
	textVector(client: Client, message: DefTextVector | SetTextVector, tag: string) {
		if (message.name === 'DRIVER_INFO') {
			return this.handleDriverInfo(client, message, DeviceInterfaceType.CCD)
		}

		const device = this.get(client, message.device)

		if (device === undefined) return

		switch (message.name) {
			case 'CCD_CFA':
				device.cfa.offsetX = +message.elements.CFA_OFFSET_X.value
				device.cfa.offsetY = +message.elements.CFA_OFFSET_Y.value
				device.cfa.type = message.elements.CFA_TYPE.value as CfaPattern
				this.updated(device, 'cfa', message.state)
		}
	}

	// Receives the CCD image BLOB and forwards its data to handlers.
	blobVector(client: Client, message: DefBlobVector | SetBlobVector, tag: string) {
		const device = this.get(client, message.device)

		if (device === undefined) return

		switch (message.name) {
			case 'CCD1':
				if (tag[0] === 's') {
					const data = message.elements.CCD1?.value

					if (data) {
						this.blobReceived(device, data, message.elements.CCD1.encoding ?? 'base64')
					} else {
						console.warn(`received empty BLOB for device ${device.name}`)
					}
				}
		}
	}

	delProperty(client: Client, message: DelProperty) {
		const device = this.get(client, message.device)

		if (device === undefined) return

		const name = message.name
		const full = !name

		if (full || name === 'CCD_COOLER') {
			resetDeviceValue(this, device, 'hasCoolerControl', DEFAULT_CAMERA.hasCoolerControl)
			resetDeviceValue(this, device, 'cooler', DEFAULT_CAMERA.cooler)
		}
		if (full || name === 'CCD_CAPTURE_FORMAT') {
			resetDeviceValue(this, device, 'frameFormats', DEFAULT_CAMERA.frameFormats)
			resetDeviceValue(this, device, 'frameFormat', DEFAULT_CAMERA.frameFormat)
		}
		if (full || name === 'CCD_ABORT_EXPOSURE') {
			resetDeviceValue(this, device, 'canAbort', DEFAULT_CAMERA.canAbort)
		}
		if (full || name === 'CCD_FRAME_TYPE') {
			resetDeviceValue(this, device, 'frameType', DEFAULT_CAMERA.frameType)
		}
		if (full || name === 'CCD_INFO') {
			resetDeviceValue(this, device, 'pixelSize', DEFAULT_CAMERA.pixelSize)
		}
		if (full || name === 'CCD_EXPOSURE') {
			resetDeviceValue(this, device, 'exposure', DEFAULT_CAMERA.exposure)
			resetDeviceValue(this, device, 'exposuring', DEFAULT_CAMERA.exposuring)
		}
		if (full || name === 'CCD_COOLER_POWER') {
			resetDeviceValue(this, device, 'coolerPower', DEFAULT_CAMERA.coolerPower)
		}
		if (full || name === 'CCD_TEMPERATURE') {
			resetDeviceValue(this, device, 'hasCooler', DEFAULT_CAMERA.hasCooler)
			resetDeviceValue(this, device, 'canSetTemperature', DEFAULT_CAMERA.canSetTemperature)
		}
		if (full || name === 'CCD_FRAME') {
			resetDeviceValue(this, device, 'canSubFrame', DEFAULT_CAMERA.canSubFrame)
			resetDeviceValue(this, device, 'frame', DEFAULT_CAMERA.frame)
		}
		if (full || name === 'CCD_BINNING') {
			resetDeviceValue(this, device, 'canBin', DEFAULT_CAMERA.canBin)
			resetDeviceValue(this, device, 'bin', DEFAULT_CAMERA.bin)
		}
		// ZWO ASI, SVBony, etc
		if (full || name === 'CCD_CONTROLS') {
			resetDeviceValue(this, device, 'gain', DEFAULT_CAMERA.gain)
			resetDeviceValue(this, device, 'offset', DEFAULT_CAMERA.offset)
			this.#gain.delete(device)
			this.#offset.delete(device)
		}
		// CCD Simulator & Alpaca
		if (full || name === 'CCD_GAIN') {
			resetDeviceValue(this, device, 'gain', DEFAULT_CAMERA.gain)
			this.#gain.delete(device)
		}
		if (full || name === 'CCD_OFFSET') {
			resetDeviceValue(this, device, 'offset', DEFAULT_CAMERA.offset)
			this.#offset.delete(device)
		}
		if (full || name === 'CCD_CFA') {
			resetDeviceValue(this, device, 'cfa', DEFAULT_CAMERA.cfa)
		}

		super.delProperty(client, message)
	}
}
