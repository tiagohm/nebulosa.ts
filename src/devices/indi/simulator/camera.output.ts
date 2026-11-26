import { equatorialToJ2000 } from '../../../astronomy/coordinates/coordinate'
import { formatTemporal } from '../../../astronomy/time/temporal'
import { writeImageToFits, writeImageToXisf } from '../../../imaging/model/image'
import type { CfaPattern, Image, ImageRawType } from '../../../imaging/model/types'
import type { FitsHeader } from '../../../io/formats/fits/fits'
import { bufferSink } from '../../../io/io'
import { type Angle, formatDEC, formatRA, normalizeAngle, toDeg } from '../../../math/units/angle'
import type { FrameType } from '../device'
import { type EnableBlob, makeBlobVector } from '../types'
import type { ExposureAccessories, ExposurePointing } from './camera.links'
import type { CameraReadoutState } from './camera.readout'
import { type ComponentBus, SimulatorComponent } from './component'
import { MAIN_CONTROL } from './constants'
import type { TransferFormat } from './types'

// Output circuit of the simulated camera: turns a drawn frame into the FITS or XISF file a client
// receives, and delivers it on the CCD1 BLOB according to the client's BLOB policy. Pixels are written
// as 16-bit unsigned samples.

// Room left in the output buffer for the header and format structures, bytes.
const BLOB_PADDING = 16384

// Bytes per written sample.
const BYTES_PER_SAMPLE = 2

// FITS IMAGETYP of each frame type.
const IMAGE_TYPE: Readonly<Record<FrameType, string>> = { LIGHT: 'Light Frame', DARK: 'Dark Frame', FLAT: 'Flat Frame', BIAS: 'Bias Frame' }

// What the header of a frame is written from.
export interface CameraFrameHeaderInput {
	// Device name of the camera.
	readonly instrument: string
	readonly pointing: ExposurePointing
	// Exposure time, seconds.
	readonly exposureTime: number
	readonly readout: CameraReadoutState
	// Unbinned pixel pitch, micrometres.
	readonly pixelSize: number
	// Sensor temperature, °C.
	readonly temperature: number
	readonly accessories: ExposureAccessories
}

// Builds the FITS header of a frame.
//
// The centre, epoch, start and mount all come from the pointing taken as the shutter opened, so the
// header describes the frame that was drawn: the reported coordinate is taken into J2000 at the epoch
// it belongs to, and the timestamps are on the same clock, the mount's when it is simulated.
export function cameraFrameHeader(input: CameraFrameHeaderInput): FitsHeader {
	const { pointing, exposureTime, readout, accessories } = input
	const { startTime, center, time, mount } = pointing
	const { imageWidth, imageHeight, channels, binX, binY } = readout
	let rightAscension: Angle | undefined
	let declination: Angle | undefined

	if (center !== undefined) [rightAscension, declination] = equatorialToJ2000(center[0], center[1], time)

	return {
		SIMPLE: true,
		BITPIX: 16,
		NAXIS: channels === 1 ? 2 : 3,
		NAXIS1: imageWidth,
		NAXIS2: imageHeight,
		NAXIS3: channels === 3 ? 3 : undefined,
		INSTRUME: input.instrument,
		TELESCOP: mount?.name,
		EXPTIME: exposureTime,
		BZERO: 32768,
		BSCALE: 1,
		XBINNING: binX,
		YBINNING: binY,
		XPIXSZ: input.pixelSize * binX,
		YPIXSZ: input.pixelSize * binY,
		GAIN: readout.gain,
		OFFSET: readout.offset,
		FRAME: readout.frameType,
		IMAGETYP: IMAGE_TYPE[readout.frameType],
		'CCD-TEMP': input.temperature,
		SITELAT: mount ? toDeg(mount.latitude) : undefined,
		SITELONG: mount ? toDeg(mount.longitude) : undefined,
		OBJCTRA: rightAscension !== undefined ? formatRA(rightAscension) : undefined,
		OBJCTDEC: declination !== undefined ? formatDEC(declination) : undefined,
		RA: rightAscension !== undefined ? toDeg(normalizeAngle(rightAscension)) : undefined,
		DEC: declination !== undefined ? toDeg(declination) : undefined,
		EQUINOX: mount ? 2000 : undefined,
		PIERSIDE: mount && mount.pierSide !== 'NEITHER' ? mount.pierSide : undefined,
		'DATE-OBS': formatTemporal(startTime, 'YYYY-MM-DDTHH:mm:ss.SSS'),
		'DATE-END': formatTemporal(startTime + Math.trunc(exposureTime * 1000), 'YYYY-MM-DDTHH:mm:ss.SSS'),
		XORGSUBF: readout.x,
		YORGSUBF: readout.y,
		FOCUSPOS: accessories.focuserPosition,
		FOCUSTEM: accessories.focuserTemperature,
		ROTATANG: accessories.rotatorAngle,
		FILTER: accessories.filter,
	}
}

// Encodes a drawn frame of `readout`'s size as `format`. A monochrome frame carries `cfa` as its
// Bayer pattern. Returns a view of the encoded bytes.
export async function encodeCameraFrame(raw: ImageRawType, header: FitsHeader, readout: CameraReadoutState, cfa: CfaPattern, format: TransferFormat) {
	const { imageWidth: width, imageHeight: height, channels } = readout
	const image: Image = {
		raw,
		header,
		metadata: { width, height, channels, stride: width * channels, pixelCount: width * height, strideInBytes: width * BYTES_PER_SAMPLE, pixelSizeInBytes: BYTES_PER_SAMPLE, bitpix: 16, bayer: channels === 1 ? cfa : undefined },
	}
	const output = Buffer.allocUnsafe(raw.length * BYTES_PER_SAMPLE + BLOB_PADDING)
	const sink = bufferSink(output)

	if (format === 'XISF') await writeImageToXisf(image, sink)
	else await writeImageToFits(image, sink)

	return output.subarray(0, sink.position)
}

// The CCD1 BLOB property.
type ImageProperty = ReturnType<typeof makeBlobVector>

// CCD1 BLOB output and the client's BLOB policy.
export class CameraOutput extends SimulatorComponent {
	readonly #image = makeBlobVector('', 'CCD1', 'CCD Image', MAIN_CONTROL, 'ro', ['CCD1', 'Image'])

	readonly properties = [this.#image]
	readonly transient = this.properties

	// Whether the client asked for BLOBs only, or for none.
	#onlyBlob = false
	#ignoreBlob = false

	// `publish` delivers the BLOB property to the client.
	constructor(
		bus: ComponentBus,
		readonly publish: (property: ImageProperty) => void,
	) {
		super(bus)
	}

	// Whether the client wants only BLOBs, so other properties are not published to it.
	get onlyBlob() {
		return this.#onlyBlob
	}

	// Whether the client wants no BLOBs, so frames need not be drawn at all.
	get ignoresBlob() {
		return this.#ignoreBlob
	}

	// Applies the client's BLOB policy.
	enableBlob(command: EnableBlob) {
		this.#onlyBlob = command.value === 'Only'
		this.#ignoreBlob = command.value === 'Never'
	}

	// Clears the previous frame as an exposure opens.
	begin() {
		this.#image.state = 'Busy'
		this.#image.elements.CCD1.value = undefined
		this.#image.elements.CCD1.size = '0'
	}

	// Marks the frame finished without delivering one, as the shutter closes.
	close() {
		this.#image.state = 'Ok'
	}

	// Delivers an encoded frame of `format`.
	deliver(blob: Buffer<ArrayBuffer>, format: TransferFormat) {
		const element = this.#image.elements.CCD1
		element.size = blob.byteLength.toFixed(0)
		element.format = format === 'XISF' ? '.xisf' : '.fits'
		element.value = blob
		element.encoding = 'raw'
		this.#image.state = 'Ok'
		this.publish(this.#image)
	}

	// Marks the frame failed.
	fail() {
		this.#image.state = 'Alert'
		this.#image.elements.CCD1.size = '0'
		this.#image.elements.CCD1.value = undefined
	}
}
