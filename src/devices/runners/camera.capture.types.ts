import type { CameraTransferFormat, FrameType } from '../indi/device'

// Request, progress, and frame shapes of a camera capture, with the exposure-time unit conversions they rely
// on. Exposure times travel in the unit the caller chose, the inter-frame delay is in seconds, and every
// progress time in a capture event is in microseconds. Nothing here allocates beyond the values it returns.

// Unit of a requested exposure time.
export type CameraExposureTimeUnit = 'minute' | 'second' | 'millisecond' | 'microsecond'

// How many frames a capture takes: one, a fixed `count`, or frames until it is stopped.
export type CameraExposureMode = 'single' | 'fixed' | 'loop'

// Automatic dated subfolder of an auto-saved frame. `midnight` rolls over at local midnight, `noon` at local
// noon so a whole night lands in the folder of the evening it began, and `off` writes into the directory.
export type CameraAutoSubFolderMode = 'off' | 'noon' | 'midnight'

// Presentation state of a camera being driven by a feature.
// - idle: nothing is running; the terminal snapshot of a capture.
// - exposureStarted: a frame generation opened and its exposure was dispatched.
// - exposing: the driver reports the exposure Busy.
// - waiting: the inter-frame delay is running.
// - dithering, settling: the guider is dithering before the next frame.
// - pausing, paused: reserved for features that pause a capture.
// - exposureFinished: the driver reported the exposure Ok.
// - error: the capture did not run to its end; always followed by idle.
export type CameraCaptureState = 'idle' | 'exposureStarted' | 'exposing' | 'waiting' | 'settling' | 'dithering' | 'pausing' | 'paused' | 'exposureFinished' | 'error'

// Progress of one guider dither, reported back to the capture that asked for it.
export type CameraDitherPhase = 'dithering' | 'dithered' | 'settling' | 'settled'

// Dither a capture asks for before each frame.
export interface CameraDither {
	// Whether the capture dithers at all.
	enabled: boolean
	// Dither amplitude in guide-camera pixels.
	amount: number
	// Whether the dither moves only in right ascension.
	raOnly: boolean
	// Id of the guider session that must dither. Empty means no guider was chosen, and the capture then
	// exposes without dithering: with several sessions open, picking one would be a guess.
	guider?: string
}

// Capture request. It is copied when a capture starts, so mutating it afterwards never alters a running capture.
export interface CameraCaptureStart {
	// Exposure time of one frame, in `exposureTimeUnit`; must be positive and finite.
	exposureTime: number
	// Unit of `exposureTime`.
	exposureTimeUnit: CameraExposureTimeUnit
	// Kind of frame the driver is told it is taking.
	frameType: FrameType
	// How many frames are taken.
	exposureMode: CameraExposureMode
	// Delay between two frames, in seconds; must be finite and non-negative.
	delay: number
	// Frames taken in `fixed` mode; must be a positive integer there and is ignored otherwise.
	count: number
	// Left edge of the subframe, in unbinned sensor pixels from the sensor origin.
	x: number
	// Top edge of the subframe, in unbinned sensor pixels from the sensor origin.
	y: number
	// Subframe width in unbinned sensor pixels; the full frame is used when not positive.
	width: number
	// Subframe height in unbinned sensor pixels; the full frame is used when not positive.
	height: number
	// Whether `x`, `y`, `width` and `height` select a subframe instead of the full sensor.
	subframe: boolean
	// Horizontal binning factor.
	binX: number
	// Vertical binning factor.
	binY: number
	// Driver capture format, such as `MONO` or `RGB`; empty leaves the driver setting unchanged.
	frameFormat: string
	// Driver gain, in driver units.
	gain: number
	// Driver offset, in driver units.
	offset: number
	// Whether each frame is written to disk.
	autoSave: boolean
	// Directory auto-saved frames go into; the captures directory is used when absent or not a directory.
	savePath?: string
	// Dated subfolder created under `savePath` for auto-saved frames.
	autoSubFolderMode: CameraAutoSubFolderMode
	// Absolute directory the frame is written into, replacing `savePath` and the automatic subfolder. A caller
	// that already decided the destination passes it so the path exists before the exposure does, which is
	// what lets an interrupted frame be recognized later.
	outputPath?: string
	// File name of the frame, including its extension, replacing the timestamp name. It names one frame, so a
	// capture asking for several frames under one name is refused instead of rewriting the same file, and a
	// name that already exists is refused instead of overwritten.
	outputName?: string
	// Path the processed frame is published under when it is not the file that was written, such as the final
	// name of a frame written into a temporary that is renamed afterwards.
	publishPath?: string
	// Name of the mount whose state the driver stamps into the frame headers.
	mount?: string
	// Name of the filter wheel whose state the driver stamps into the frame headers.
	wheel?: string
	// Name of the focuser whose state the driver stamps into the frame headers.
	focuser?: string
	// Name of the rotator whose state the driver stamps into the frame headers.
	rotator?: string
	// Dither performed before each frame.
	dither: CameraDither
	// Payload format the driver transfers.
	transferFormat: CameraTransferFormat
	// Whether the driver compresses the payload.
	compressed: boolean
}

// Progress of one exposure, one delay, or a whole capture. Times are in microseconds.
export interface CameraCaptureTime {
	// Time left, in microseconds.
	remainingTime: number
	// Time elapsed, in microseconds.
	elapsedTime: number
	// Completion, in percent from 0 to 100.
	progress: number
}

// Presentation snapshot of a camera capture. Each emission is a fresh copy.
export interface CameraCaptureEvent {
	// Top-level operation that owns the camera lease.
	operation: string
	// Immutable capture-session identifier.
	session: string
	// Monotonic frame attempt within the session; zero means no exposure was dispatched.
	generation: number
	// Id of the camera.
	camera: string
	// Frames the capture intends to take; `Number.MAX_SAFE_INTEGER` for a loop.
	count: number
	// Whether the capture runs until stopped.
	loop: boolean
	// Frames not yet opened.
	remainingCount: number
	// Frames opened so far.
	elapsedCount: number
	// Current presentation state.
	state: CameraCaptureState
	// Exposure plus inter-frame delay of the whole capture, in microseconds; zero for a loop.
	totalExposureTime: number
	// Exposure of the current frame, in microseconds.
	frameExposureTime: number
	// Progress of the whole capture; only elapsed time is meaningful for a loop.
	totalProgress: CameraCaptureTime
	// Progress of the current exposure or delay.
	frameProgress: CameraCaptureTime
	// Whether the capture ended without running to its end; set on the terminal idle snapshot.
	stopped: boolean
}

// One frame that finished processing.
export interface CameraFrameEvent {
	// Top-level operation that produced the frame.
	readonly operation: string
	// Immutable capture session that accepted the BLOB.
	readonly session: string
	// Frame generation that completed exposure and BLOB processing.
	readonly generation: number
	// Id of the camera.
	readonly camera: string
	// Path the frame is published under.
	readonly path: string
}

// Request defaults; callers clone it before changing fields. The zero exposure time must be replaced.
export const DEFAULT_CAMERA_CAPTURE_START: CameraCaptureStart = {
	exposureTime: 0,
	exposureTimeUnit: 'microsecond',
	frameType: 'LIGHT',
	exposureMode: 'single',
	delay: 0,
	count: 1,
	x: 0,
	y: 0,
	width: 0,
	height: 0,
	subframe: false,
	binX: 1,
	binY: 1,
	frameFormat: '',
	gain: 0,
	offset: 0,
	autoSave: false,
	autoSubFolderMode: 'off',
	dither: {
		enabled: false,
		amount: 5,
		raOnly: false,
	},
	transferFormat: 'FITS',
	compressed: false,
}

// Snapshot of a camera nobody is capturing with; callers clone it before changing fields.
export const DEFAULT_CAMERA_CAPTURE_EVENT: CameraCaptureEvent = {
	operation: '',
	session: '',
	generation: 0,
	camera: '',
	state: 'idle',
	count: 0,
	remainingCount: 0,
	elapsedCount: 0,
	loop: false,
	totalExposureTime: 0,
	frameExposureTime: 0,
	totalProgress: {
		remainingTime: 0,
		elapsedTime: 0,
		progress: 0,
	},
	frameProgress: {
		remainingTime: 0,
		elapsedTime: 0,
		progress: 0,
	},
	stopped: false,
}

// Number of `unit` in one minute.
export function exposureTimeUnitFactor(unit: CameraExposureTimeUnit) {
	switch (unit) {
		case 'minute':
			return 1
		case 'second':
			return 60
		case 'millisecond':
			return 60000
		case 'microsecond':
			return 60000000
	}
}

// Converts an exposure time in `unit` to minutes.
export function exposureTimeInMinutes(time: number, unit: CameraExposureTimeUnit) {
	return unit === 'minute' ? time : time / exposureTimeUnitFactor(unit)
}

// Converts an exposure time in `unit` to seconds.
export function exposureTimeInSeconds(time: number, unit: CameraExposureTimeUnit) {
	return unit === 'second' ? time : time * (60 / exposureTimeUnitFactor(unit))
}

// Converts an exposure time in `unit` to milliseconds.
export function exposureTimeInMilliseconds(time: number, unit: CameraExposureTimeUnit) {
	return unit === 'millisecond' ? time : time * (60000 / exposureTimeUnitFactor(unit))
}

// Converts an exposure time in `unit` to microseconds.
export function exposureTimeInMicroseconds(time: number, unit: CameraExposureTimeUnit) {
	return unit === 'microsecond' ? time : time * (60000000 / exposureTimeUnitFactor(unit))
}

// Converts an exposure time from unit `from` to unit `to`.
export function exposureTimeIn(time: number, from: CameraExposureTimeUnit, to: CameraExposureTimeUnit) {
	return from === to ? time : time * (exposureTimeUnitFactor(to) / exposureTimeUnitFactor(from))
}
