import { clamp } from '../../../math/numerical/math'
import type { FrameType } from '../device'
import { findOnSwitch, makeNumberVector, makeSwitchVector, type NewNumberVector, type NewSwitchVector } from '../types'
import type { CameraReadoutConfig } from './camera.config'
import type { CameraSensor } from './camera.sensor'
import { type ComponentBus, SimulatorComponent } from './component'
import { MAIN_CONTROL } from './constants'
import type { ReadoutMode, TransferFormat } from './types'
import { applyExclusiveSwitchValues, applyNumberVectorValues } from './util'

// Readout circuit of the simulated camera: which part of the sensor is read, how it is binned and
// amplified, what kind of frame it is, and how the frame is delivered. Frame coordinates are unbinned
// sensor pixels with the origin at the first pixel read; the delivered image is binned.

// Readout settings of one frame, taken when the shutter closes.
export interface CameraReadoutState {
	// Subframe origin and extent, unbinned pixels.
	readonly x: number
	readonly y: number
	readonly width: number
	readonly height: number
	// Binning factors.
	readonly binX: number
	readonly binY: number
	// Gain and offset, in the camera's own units.
	readonly gain: number
	readonly offset: number
	readonly frameType: FrameType
	readonly readoutMode: ReadoutMode
	// Colour channels of the delivered image: 1 for a monochrome readout, 3 for RGB.
	readonly channels: 1 | 3
	readonly transferFormat: TransferFormat
	// Size of the delivered image, binned pixels, at least 1.
	readonly imageWidth: number
	readonly imageHeight: number
}

// Readout controller: subframe, binning, gain, offset, frame type, readout mode and transfer format.
export class CameraReadout extends SimulatorComponent {
	readonly #frameType = makeSwitchVector('', 'CCD_FRAME_TYPE', 'Frame Type', MAIN_CONTROL, 'OneOfMany', 'rw', ['FRAME_LIGHT', 'Light', true], ['FRAME_DARK', 'Dark', false], ['FRAME_FLAT', 'Flat', false], ['FRAME_BIAS', 'Bias', false])
	readonly #readoutMode = makeSwitchVector('', 'CCD_CAPTURE_FORMAT', 'Readout Mode', MAIN_CONTROL, 'OneOfMany', 'rw', ['MONO', 'Mono', true], ['RGB', 'RGB', false])
	readonly #transferFormat = makeSwitchVector('', 'CCD_TRANSFER_FORMAT', 'Transfer Format', MAIN_CONTROL, 'OneOfMany', 'rw', ['FORMAT_FITS', 'FITS', true], ['FORMAT_XISF', 'XISF', false])
	readonly #frame = makeNumberVector('', 'CCD_FRAME', 'Frame', MAIN_CONTROL, 'rw', ['X', 'X', 0, 0, 0, 1, '%.0f'], ['Y', 'Y', 0, 0, 0, 1, '%.0f'], ['WIDTH', 'Width', 1, 1, 1, 1, '%.0f'], ['HEIGHT', 'Height', 1, 1, 1, 1, '%.0f'])
	readonly #bin = makeNumberVector('', 'CCD_BINNING', 'Bin', MAIN_CONTROL, 'rw', ['HOR_BIN', 'X', 1, 1, 1, 1, '%.0f'], ['VER_BIN', 'Y', 1, 1, 1, 1, '%.0f'])
	readonly #gain = makeNumberVector('', 'CCD_GAIN', 'Gain', MAIN_CONTROL, 'rw', ['GAIN', 'Gain', 0, 0, 400, 1, '%.0f'])
	readonly #offset = makeNumberVector('', 'CCD_OFFSET', 'Offset', MAIN_CONTROL, 'rw', ['OFFSET', 'Offset', 0, 0, 1000, 1, '%.0f'])

	readonly properties = [this.#frameType, this.#readoutMode, this.#transferFormat, this.#frame, this.#bin, this.#gain, this.#offset]

	// `sensor` bounds the subframe and the binning; `config` gives the initial gain, offset and formats.
	constructor(
		bus: ComponentBus,
		readonly sensor: CameraSensor,
		config: CameraReadoutConfig,
	) {
		super(bus)

		const { X, Y, WIDTH, HEIGHT } = this.#frame.elements
		X.max = sensor.width - 1
		Y.max = sensor.height - 1
		WIDTH.max = WIDTH.value = sensor.width
		HEIGHT.max = HEIGHT.value = sensor.height
		this.#bin.elements.HOR_BIN.max = sensor.config.maxBin
		this.#bin.elements.VER_BIN.max = sensor.config.maxBin
		this.#gain.elements.GAIN.value = config.gain
		this.#offset.elements.OFFSET.value = config.offset
		applyExclusiveSwitchValues(this.#readoutMode, { [config.readoutMode]: true })
		applyExclusiveSwitchValues(this.#transferFormat, { [config.transferFormat === 'XISF' ? 'FORMAT_XISF' : 'FORMAT_FITS']: true })
	}

	// Kind of frame the next exposure produces.
	get frameType(): FrameType {
		const { FRAME_DARK, FRAME_FLAT, FRAME_BIAS } = this.#frameType.elements
		return FRAME_DARK.value ? 'DARK' : FRAME_FLAT.value ? 'FLAT' : FRAME_BIAS.value ? 'BIAS' : 'LIGHT'
	}

	// Selected readout mode.
	get readoutMode() {
		return findOnSwitch(this.#readoutMode)[0] as ReadoutMode
	}

	// Colour channels of the delivered image.
	get channels() {
		return this.readoutMode === 'MONO' ? 1 : 3
	}

	// Selected transfer format.
	get transferFormat(): TransferFormat {
		return this.#transferFormat.elements.FORMAT_XISF.value ? 'XISF' : 'FITS'
	}

	// Gain, in the camera's own units.
	get gain() {
		return this.#gain.elements.GAIN.value
	}

	// Offset, in the camera's own units.
	get offset() {
		return this.#offset.elements.OFFSET.value
	}

	// Width of the delivered image, binned pixels.
	get imageWidth() {
		return Math.max(1, Math.ceil(this.#frame.elements.WIDTH.value / this.#bin.elements.HOR_BIN.value))
	}

	// Height of the delivered image, binned pixels.
	get imageHeight() {
		return Math.max(1, Math.ceil(this.#frame.elements.HEIGHT.value / this.#bin.elements.VER_BIN.value))
	}

	// Current readout settings, copied out of the properties.
	snapshot(): CameraReadoutState {
		const { X, Y, WIDTH, HEIGHT } = this.#frame.elements
		return {
			x: X.value,
			y: Y.value,
			width: WIDTH.value,
			height: HEIGHT.value,
			binX: this.#bin.elements.HOR_BIN.value,
			binY: this.#bin.elements.VER_BIN.value,
			gain: this.gain,
			offset: this.offset,
			frameType: this.frameType,
			readoutMode: this.readoutMode,
			channels: this.channels,
			transferFormat: this.transferFormat,
			imageWidth: this.imageWidth,
			imageHeight: this.imageHeight,
		}
	}

	// Moves the subframe, keeping it inside the sensor. Omitted values keep their current setting; all
	// are unbinned pixels and truncated to integers. Publishes the frame only when it changed.
	setFrame(x?: number, y?: number, width?: number, height?: number) {
		const { X, Y, WIDTH, HEIGHT } = this.#frame.elements
		const nextX = clamp(Math.trunc(x ?? X.value), 0, this.sensor.width - 1)
		const nextY = clamp(Math.trunc(y ?? Y.value), 0, this.sensor.height - 1)
		const nextWidth = clamp(Math.trunc(width ?? WIDTH.value), 1, this.sensor.width - nextX)
		const nextHeight = clamp(Math.trunc(height ?? HEIGHT.value), 1, this.sensor.height - nextY)
		if (X.value === nextX && Y.value === nextY && WIDTH.value === nextWidth && HEIGHT.value === nextHeight) return
		X.value = nextX
		Y.value = nextY
		WIDTH.value = nextWidth
		HEIGHT.value = nextHeight
		this.bus.notify(this.#frame)
	}

	// Sets the binning within [1, maxBin]. Omitted values keep their current setting. Publishes the
	// binning only when it changed.
	setBin(horizontal?: number, vertical?: number) {
		const { HOR_BIN, VER_BIN } = this.#bin.elements
		const nextHorizontal = clamp(Math.trunc(horizontal ?? HOR_BIN.value), 1, HOR_BIN.max)
		const nextVertical = clamp(Math.trunc(vertical ?? VER_BIN.value), 1, VER_BIN.max)
		if (HOR_BIN.value === nextHorizontal && VER_BIN.value === nextVertical) return
		HOR_BIN.value = nextHorizontal
		VER_BIN.value = nextVertical
		this.bus.notify(this.#bin)
	}

	// Handles CCD_FRAME, CCD_BINNING, CCD_GAIN and CCD_OFFSET.
	handleNumber(vector: NewNumberVector) {
		switch (vector.name) {
			case 'CCD_FRAME':
				this.setFrame(vector.elements.X, vector.elements.Y, vector.elements.WIDTH, vector.elements.HEIGHT)
				return true
			case 'CCD_BINNING':
				this.setBin(vector.elements.HOR_BIN, vector.elements.VER_BIN)
				return true
			case 'CCD_GAIN':
				if (applyNumberVectorValues(this.#gain, vector.elements)) this.bus.notify(this.#gain)
				return true
			case 'CCD_OFFSET':
				if (applyNumberVectorValues(this.#offset, vector.elements)) this.bus.notify(this.#offset)
				return true
		}

		return false
	}

	// Handles CCD_FRAME_TYPE, CCD_CAPTURE_FORMAT and CCD_TRANSFER_FORMAT.
	handleSwitch(vector: NewSwitchVector) {
		const property = vector.name === 'CCD_FRAME_TYPE' ? this.#frameType : vector.name === 'CCD_CAPTURE_FORMAT' ? this.#readoutMode : vector.name === 'CCD_TRANSFER_FORMAT' ? this.#transferFormat : undefined
		if (property === undefined) return false
		if (applyExclusiveSwitchValues(property, vector.elements)) this.bus.notify(property)
		return true
	}
}
