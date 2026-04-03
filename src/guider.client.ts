import { TAU } from './constants'
import { type AxisPulse, type DeclinationGuideMode, type GuideCommand, type GuideFrame, Guider, type GuideStar } from './guider'
import { flipGuidingCalibration, type GuidingCalibrationDiagnostics, type GuidingCalibrationResult, GuidingCalibrator } from './guider.calibrator'
import { readImageFromBuffer, readImageFromSource } from './image'
import { type Image, type ImageRawType, makeImageRawTypedArray } from './image.types'
import type { Camera, GuideDirection, GuideOutput } from './indi.device'
import type { CameraManager, DeviceHandler, GuideOutputManager } from './indi.manager'
import { base64Source } from './io'
import { clamp } from './math'
import { DEFAULT_PHD2_SETTLE, type PHD2AppState, type PHD2CalibrationData, type PHD2DeclinationGuideMode, type PHD2EventMap, type PHD2Events, type PHD2GuideDirection, type PHD2LockShiftParams, type PHD2Settle, type PHD2StarImage } from './phd2'
import { detectStars } from './star.detector'
import type { PartialOnly, Writable } from './types'
import { angularSizeOfPixel } from './util'

const DEFAULT_GUIDER_EXPOSURE = 1
const DEFAULT_SEARCH_REGION = 64

const EMPTY_CALIBRATION_DATA: Readonly<PHD2CalibrationData> = {
	calibrated: false,
	xAngle: 0,
	xRate: 0,
	xParity: '+',
	yAngle: 0,
	yRate: 0,
	yParity: '+',
}

const DEFAULT_LOCK_SHIFT_PARAMS: Readonly<PHD2LockShiftParams> = {
	enabled: false,
	rate: [0, 0],
	units: 'pixels/hr',
	axes: 'X/Y',
}

export interface GuiderClientOptions {
	readonly handler?: GuiderClientHandler
	readonly reverseDecOutputAfterMeridianFlip?: boolean
	readonly searchRegion?: number // pixels
	readonly stickyLockPosition?: boolean
}

export interface GuiderClientConnectOptions {
	readonly focalLength?: number // Optical focal length in mm; takes precedence over aperture-derived focal length.
	readonly aperture?: number // Optical aperture in mm, used together with focalRatio when focalLength is unavailable.
	readonly focalRatio?: number // Dimensionless focal ratio, used together with aperture when focalLength is unavailable.
	readonly pixelSize?: number // Unbinned guider pixel size in um; camera metadata is used when omitted.
}

export interface GuiderClientHandler {
	readonly event?: (client: GuiderClient, event: PHD2Events) => void
}

// GuiderClient adapts local INDI camera/guide-output devices to a PHD2-like API.
export class GuiderClient {
	#connected = false
	#camera?: Camera
	#guideOutput?: GuideOutput
	#calibrator = new GuidingCalibrator()
	#calibration?: GuidingCalibrationResult
	#frame?: GuideFrame
	#image?: Image
	#frameId = 0
	#lockPosition?: readonly [number, number]
	#lockSearchPosition?: readonly [number, number]
	#stickyLockPosition = false
	#appState: PHD2AppState = 'Stopped'
	#resumeState: PHD2AppState = 'Stopped'
	#declinationGuideMode: PHD2DeclinationGuideMode = 'Auto'
	#guider = this.#makeGuider(undefined)
	#exposure = DEFAULT_GUIDER_EXPOSURE
	#guideOutputEnabled = true
	#paused = false
	#fullPause = true
	#settling = false
	#settle: PHD2Settle = { ...DEFAULT_PHD2_SETTLE }
	#settleStartTime = 0
	#settleStableSince = 0
	#settleFrameCount = 0
	#settleDroppedFrameCount = 0
	#ditherOffsetX = 0
	#ditherOffsetY = 0
	#lockShiftOffsetX = 0
	#lockShiftOffsetY = 0
	#lockShiftTimestamp = 0
	#lockShiftLimitReached = false
	#focalLength = 0
	#pixelSize = 0
	#searchRegion = DEFAULT_SEARCH_REGION
	readonly #lockShiftParams = { ...DEFAULT_LOCK_SHIFT_PARAMS }
	readonly #eventHandler?: GuiderClientHandler['event']

	readonly #cameraHandler: DeviceHandler<Camera> = {
		// Ignores manager-level add callbacks because connect binds one camera explicitly.
		added: () => {},
		// Ignores manager-level removal callbacks because disconnect owns active-session teardown.
		removed: () => {},
		// Decodes each camera frame asynchronously and feeds the guider state machine.
		blobReceived: (device, data) => {
			void this.#processBlob(device, data)
		},
	}

	// Creates a guider client bound to camera and guide-output managers.
	constructor(
		readonly cameraManager: CameraManager,
		readonly guideOutputManager: GuideOutputManager,
		readonly options?: GuiderClientOptions,
	) {
		this.#searchRegion = clamp(options?.searchRegion || DEFAULT_SEARCH_REGION, 16, 128)
		this.#stickyLockPosition = options?.stickyLockPosition === true
		this.#eventHandler = options?.handler?.event
	}

	// Binds the active camera and guide output, enables image BLOBs, and starts listening.
	connect(camera: Camera, guideOutput: GuideOutput, options?: GuiderClientConnectOptions) {
		if (this.#connected) return false

		this.#camera = camera
		this.#guideOutput = guideOutput
		this.#focalLength = resolveFocalLength(options)
		this.#pixelSize = resolveConfiguredPixelSize(options)
		this.#connected = true
		this.cameraManager.addHandler(this.#cameraHandler)
		this.cameraManager.enableBlob(camera)
		this.#resetRuntimeState(true)
		this.emitEvent('ConfigurationChange')

		return true
	}

	// Stops capture, detaches device handlers, and clears the active session.
	disconnect() {
		if (!this.#connected) return false

		const camera = this.#camera

		this.#connected = false
		this.cameraManager.removeHandler(this.#cameraHandler)

		if (camera !== undefined) {
			this.cameraManager.stopExposure(camera)
			this.cameraManager.disableBlob(camera)
		}

		this.#camera = undefined
		this.#guideOutput = undefined
		this.#focalLength = 0
		this.#pixelSize = 0
		this.#resetRuntimeState(true)
		this.emitEvent('ConfigurationChange')

		return true
	}

	// Finds the best star in the most recent frame and stores it as the preferred lock position.
	findStar() {
		if (this.#frame === undefined) return undefined

		const selected = this.#guider.selectGuideStar(this.#frame).primary
		if (selected === undefined) return undefined

		this.#lockPosition = [selected.x, selected.y] as const
		this.#lockSearchPosition = this.#lockPosition
		this.emitEvent('StarSelected', { X: selected.x, Y: selected.y })
		this.emitEvent('LockPositionSet', { X: selected.x, Y: selected.y })

		if (this.#appState === 'Stopped' || this.#appState === 'Looping') {
			this.setAppState('Selected')
		}

		return this.#lockPosition
	}

	// Starts one exposure and stores it as the default cadence for looping/guiding.
	startCapture(exposure: number) {
		if (exposure > 0 && Number.isFinite(exposure)) {
			this.#exposure = exposure
		}

		if (this.#camera !== undefined) {
			this.cameraManager.startExposure(this.#camera, this.#exposure)
			return true
		}

		return false
	}

	// Stops camera exposure and clears active guiding/looping state.
	stopCapture() {
		this.emitCaptureStoppedEvent()

		if (this.#camera !== undefined) {
			this.cameraManager.stopExposure(this.#camera)
		}

		this.#paused = false
		this.#fullPause = true
		this.#settling = false
		this.#settleStartTime = 0
		this.#settleStableSince = 0
		this.#settleFrameCount = 0
		this.#settleDroppedFrameCount = 0
		this.#lockShiftTimestamp = 0
		this.#lockShiftLimitReached = false
		this.#resumeState = 'Stopped'
		this.setAppState('Stopped')

		if (this.#guider.currentState.ditherActive) {
			this.#guider.stopDither()
		}
	}

	// Clears the solved calibration and resets the guider/calibrator state machines.
	clearCalibration() {
		this.#calibration = undefined
		this.#calibrator.reset()
		this.#guider = this.#makeGuider(undefined)
		this.#ditherOffsetX = 0
		this.#ditherOffsetY = 0
		this.#lockShiftOffsetX = 0
		this.#lockShiftOffsetY = 0
		this.#lockShiftTimestamp = 0
		this.#lockShiftLimitReached = false
		this.#settling = false
		this.#settleStartTime = 0
		this.#settleStableSince = 0
		this.emitEvent('ConfigurationChange')

		if (this.#appState === 'Calibrating' || this.#appState === 'Guiding' || this.#appState === 'LostLock' || this.#appState === 'Paused') {
			this.#resumeState = this.#lockPosition === undefined ? 'Looping' : 'Selected'
			if (!this.#paused) this.setAppState(this.#resumeState)
		}
	}

	// Drops the preferred lock position and returns to plain looping if capture is still active.
	deselectStar() {
		this.#lockPosition = undefined
		this.#lockSearchPosition = undefined
		this.#ditherOffsetX = 0
		this.#ditherOffsetY = 0
		this.#lockShiftOffsetX = 0
		this.#lockShiftOffsetY = 0
		this.#lockShiftTimestamp = 0
		this.#lockShiftLimitReached = false
		this.#settling = false
		this.#settleStartTime = 0
		this.#settleStableSince = 0
		this.#guider.reset()

		if (this.#guider.currentState.ditherActive) {
			this.#guider.stopDither()
		}

		if (this.#appState !== 'Stopped') {
			this.#resumeState = 'Looping'
			if (!this.#paused) this.setAppState('Looping')
		}
	}

	// Applies a random image-space dither and tracks local settle status.
	dither(amount: number, raOnly: boolean = false, settle?: Partial<PHD2Settle>) {
		if (this.#calibration === undefined || this.#guider.currentState.state !== 'guiding' || amount <= 0 || !Number.isFinite(amount)) return false

		const { referenceX, referenceY } = this.#guider.currentState
		const [dx, dy] = raOnly ? makeRaOnlyDither(this.#calibration, amount) : makeRandomDither(amount)

		this.#ditherOffsetX += dx
		this.#ditherOffsetY += dy
		this.#syncGuideTargetOffset()
		this.#lockPosition = [referenceX + this.#ditherOffsetX + this.#lockShiftOffsetX, referenceY + this.#ditherOffsetY + this.#lockShiftOffsetY] as const
		this.#settle = { ...DEFAULT_PHD2_SETTLE, ...settle }
		this.#settling = true
		this.#settleStartTime = 0
		this.#settleStableSince = 0
		this.#settleFrameCount = 0
		this.#settleDroppedFrameCount = 0

		this.emitEvent('GuidingDithered', { dx, dy })
		this.emitEvent('SettleBegin')

		return true
	}

	// Flips the solved calibration for a meridian flip and rebuilds the guider with the transformed axis parity.
	flipCalibration() {
		if (this.#calibration === undefined || this.#appState === 'Calibrating') return false

		this.#calibration = flipGuidingCalibration(this.#calibration, this.options?.reverseDecOutputAfterMeridianFlip === true)
		this.#guider = this.#makeGuider(this.#calibration)
		this.emitEvent('CalibrationDataFlipped', { Mount: this.#guideOutput?.name ?? '' })
		this.emitEvent('ConfigurationChange')

		return true
	}

	// Returns the current PHD2-style state mapped from the local session state machine.
	getAppState() {
		return this.#appState
	}

	// Returns whether a valid calibration has been solved.
	getCalibrated() {
		return this.#calibration !== undefined
	}

	// Returns a PHD2-shaped snapshot of the current calibration solution.
	getCalibrationData() {
		if (this.#calibration === undefined) return EMPTY_CALIBRATION_DATA
		return calibrationResultToPHD2Data(this.#calibration)
	}

	// Returns the horizontal binning factor reported by the active camera.
	getCameraBinning() {
		return this.#camera?.bin.x.value ?? 0
	}

	// Returns the current frame width/height reported by the active camera.
	getCameraFrameSize() {
		const { frame } = this.#camera ?? {}
		return [frame?.width.value ?? 0, frame?.height.value ?? 0] as const
	}

	// Returns true only when the client is attached and both devices report a live connection.
	getConnected() {
		return this.#connected && this.#camera?.connected === true && this.#guideOutput?.connected === true
	}

	// Returns the requested DEC guide mode used for new guider instances.
	getDeclinationGuideMode() {
		return this.#declinationGuideMode
	}

	// Returns the current exposure cadence in seconds.
	getExposure() {
		const exposure = this.#camera?.exposure.value ?? 0
		return exposure > 0 ? exposure : this.#exposure
	}

	// Returns whether pulse output is enabled.
	getGuideOutputEnabled() {
		return this.#guideOutputEnabled
	}

	// Returns the current lock target if one has been selected or acquired.
	getLockPosition() {
		return this.#lockPosition ?? null
	}

	// Returns whether lock-shift drift compensation is enabled.
	getLockShiftEnabled() {
		return this.#lockShiftParams.enabled
	}

	// Returns the current lock-shift rate and axis configuration.
	getLockShiftParams(): PHD2LockShiftParams {
		return this.#lockShiftParams
	}

	// Returns whether guiding output is paused.
	getPaused() {
		return this.#paused
	}

	// Returns the effective guider pixel scale in arcsec/pixel from focal length and binned pixel size.
	getPixelScale() {
		if (this.#camera === undefined || this.#focalLength <= 0) return 0

		const pixelSize = resolveEffectivePixelSize(this.#camera, this.#pixelSize)
		return pixelSize <= 0 ? 0 : angularSizeOfPixel(this.#focalLength, pixelSize)
	}

	getSearchRegion() {
		return this.#searchRegion
	}

	// Returns whether Sticky Lock Position is enabled for future guider initialization.
	getStickyLockPositionEnabled() {
		return this.#stickyLockPosition
	}

	// Returns true while an active dither waits for the settle criteria.
	getSettling() {
		return this.#settling
	}

	// Returns the most recent decoded guide frame and star position using the raw in-memory pixel buffer.
	getStarImage(): PHD2StarImage<ImageRawType> | undefined {
		if (this.#image === undefined) return undefined

		const star = this.#frame?.stars[0]
		// Uses the current lock target when available, otherwise the latest measured star centroid or [0, 0].
		const [x, y] = this.#lockPosition ?? [star?.x ?? 0, star?.y ?? 0]
		return cropStarImage(this.#image, this.#frame?.frameId ?? 0, x, y, this.#searchRegion)
	}

	// Starts guiding and triggers calibration first when requested or when no solution exists yet.
	guide(recalibrate: boolean = false, settle?: Partial<PHD2Settle>) {
		if (!this.#connected || this.#camera === undefined || this.#guideOutput === undefined) return false

		this.#paused = false
		this.#fullPause = true
		this.#resumeState = 'Guiding'
		this.#settling = false
		this.#settle = { ...DEFAULT_PHD2_SETTLE, ...settle }
		this.#settleStartTime = 0
		this.#settleStableSince = 0
		this.#lockShiftTimestamp = 0
		this.#lockShiftLimitReached = false

		if (recalibrate || this.#calibration === undefined) {
			if (recalibrate) this.#calibration = undefined
			this.#calibrator.reset()
			this.emitEvent('StartCalibration', { Mount: this.#guideOutput.name })
			this.setAppState('Calibrating')
		} else {
			this.#guider = this.#makeGuider(this.#calibration)
			this.emitEvent('StartGuiding')
			this.setAppState('Guiding')
		}

		this.startCapture(this.#exposure)

		return true
	}

	// Sends a direct single-axis pulse through the active guide output.
	guidePulse(amount: number, direction: PHD2GuideDirection) {
		if (this.#guideOutput === undefined || !this.#guideOutputEnabled || amount <= 0 || !Number.isFinite(amount)) return false

		this.guideOutputManager.pulse(this.#guideOutput, direction.toUpperCase() as GuideDirection, Math.max(1, Math.round(amount)))

		return true
	}

	// Starts continuous exposure looping without issuing guide pulses.
	loop() {
		if (!this.#connected || this.#camera === undefined) return false

		this.#paused = false
		this.#fullPause = true
		this.#resumeState = 'Looping'
		this.#settling = false
		this.#settleStartTime = 0
		this.#settleStableSince = 0
		this.#settleFrameCount = 0
		this.#settleDroppedFrameCount = 0
		this.#lockShiftTimestamp = 0
		this.#lockShiftLimitReached = false
		this.setAppState(this.#lockPosition === undefined ? 'Looping' : 'Selected')
		this.startCapture(this.#exposure)

		return true
	}

	// Updates the DEC guide mode and rebuilds the guider with the current calibration matrix.
	setDeclinationGuideMode(mode: PHD2DeclinationGuideMode) {
		this.#declinationGuideMode = mode
		if (this.#appState !== 'Calibrating') this.#guider = this.#makeGuider(this.#calibration)
		this.emitEvent('GuideParamChange', { Name: 'DecGuideMode', Value: mode })
		this.emitEvent('ConfigurationChange')
	}

	// Stores the default exposure cadence for subsequent captures.
	setExposure(exposure: number) {
		if (exposure <= 0 || !Number.isFinite(exposure)) return false
		this.#exposure = exposure
		this.emitEvent('GuideParamChange', { Name: 'Exposure', Value: exposure })
		this.emitEvent('ConfigurationChange')
		return true
	}

	// Enables or disables guide pulses while keeping frame processing active.
	setGuideOutputEnabled(enabled: boolean) {
		this.#guideOutputEnabled = enabled
		this.emitEvent('GuideParamChange', { Name: 'GuideOutputEnabled', Value: enabled })
		this.emitEvent('ConfigurationChange')
	}

	// Stores the requested lock target and relocks to the nearest detected star unless exact matching is requested.
	setLockPosition(x: number, y: number, exact: boolean = false) {
		if (!Number.isFinite(x) || !Number.isFinite(y)) return false

		if (this.#frame !== undefined && this.#frame.stars.length > 0) {
			const nearest = nearestGuideStar(this.#frame.stars, x, y)
			this.#lockSearchPosition = nearest === undefined ? ([x, y] as const) : ([nearest.x, nearest.y] as const)
		} else {
			this.#lockSearchPosition = [x, y] as const
		}

		this.#lockPosition = exact ? ([x, y] as const) : this.#lockSearchPosition

		const [lockX, lockY] = this.#lockPosition
		this.#ditherOffsetX = 0
		this.#ditherOffsetY = 0
		this.#lockShiftOffsetX = 0
		this.#lockShiftOffsetY = 0
		this.#lockShiftTimestamp = 0
		this.#lockShiftLimitReached = false
		this.emitEvent('LockPositionSet', { X: lockX, Y: lockY })

		if (this.#appState === 'Guiding' || this.#appState === 'LostLock' || this.#appState === 'Paused') {
			this.#guider = this.#makeGuider(this.#calibration)
			this.#resumeState = 'Guiding'
			if (!this.#paused) this.setAppState('Guiding')
		} else if (this.#appState !== 'Stopped') {
			this.#resumeState = 'Selected'
			if (!this.#paused) this.setAppState('Selected')
		}

		return true
	}

	// Enables or disables preserving the current lock target across guider initialization.
	setStickyLockPositionEnabled(enabled: boolean) {
		this.#stickyLockPosition = enabled

		if (!enabled && this.#lockSearchPosition !== undefined) {
			this.#lockPosition = this.#lockSearchPosition
		}

		this.emitEvent('GuideParamChange', { Name: 'StickyLockPosition', Value: enabled })
		this.emitEvent('ConfigurationChange')

		return true
	}

	// Enables or disables drift compensation by moving the guide target at the configured lock-shift rate.
	setLockShiftEnabled(enabled: boolean) {
		if (enabled && this.#lockShiftParams.units === 'arcsec/hr' && this.getPixelScale() <= 0) {
			return false
		}

		this.#lockShiftParams.enabled = enabled
		this.#lockShiftTimestamp = enabled ? (this.#frame?.timestamp ?? 0) : 0
		this.#lockShiftLimitReached = false
		this.emitEvent('GuideParamChange', { Name: 'LockShiftEnabled', Value: enabled })
		this.emitEvent('ConfigurationChange')

		return true
	}

	// Stores the lock-shift drift rate used to incrementally move the guider target between frames.
	setLockShiftParams(params: PartialOnly<Omit<Writable<PHD2LockShiftParams>, 'enabled'>, 'units'>) {
		const { rate, axes } = params
		const units = params.units ?? (axes === undefined ? this.#lockShiftParams.units : axes === 'RA/Dec' ? 'arcsec/hr' : 'pixels/hr')

		if (units === 'arcsec/hr' && this.#lockShiftParams.enabled && this.getPixelScale() <= 0) {
			return false
		}

		if (rate !== undefined) this.#lockShiftParams.rate = rate
		if (axes !== undefined) this.#lockShiftParams.axes = axes
		this.#lockShiftParams.units = units
		this.#lockShiftTimestamp = this.#frame?.timestamp ?? 0
		this.#lockShiftLimitReached = false
		this.emitEvent('GuideParamChange', { Name: 'LockShiftParams', Value: this.getLockShiftParams() })
		this.emitEvent('ConfigurationChange')

		return true
	}

	// Pauses or resumes guide pulses, optionally stopping exposures during full pause.
	setPaused(paused: boolean, full: boolean = true) {
		if (paused) {
			if (!this.#paused) this.#resumeState = this.#appState === 'Paused' ? this.#resumeState : this.#appState
			this.#paused = true
			this.#fullPause = full || this.#resumeState === 'Calibrating'
			this.#lockShiftTimestamp = 0
			this.emitEvent('Paused')
			this.setAppState('Paused')
			if (this.#fullPause && this.#camera !== undefined) this.cameraManager.stopExposure(this.#camera)
			return true
		}

		this.#paused = false
		this.#fullPause = true
		this.#lockShiftTimestamp = 0
		this.emitEvent('Resumed')
		this.setAppState(this.#resumeState === 'Paused' ? 'Looping' : this.#resumeState)

		if (this.#appState !== 'Stopped' && this.#camera !== undefined) {
			this.startCapture(this.#exposure)
		}

		return true
	}

	// Parses a received camera BLOB, runs guider state updates, and schedules the next exposure.
	async #processBlob(device: Camera, data: string | Buffer<ArrayBuffer>): Promise<void> {
		if (!this.#connected || device !== this.#camera) return

		let image: Image | undefined

		try {
			if (typeof data === 'string') {
				const source = base64Source(data)
				image = await readImageFromSource(source)
			} else {
				image = await readImageFromBuffer(data)
			}
		} catch (e) {
			console.error('guide image decode failed:', e)
		}

		if (image !== undefined) this.#image = image

		const frame = this.#makeGuideFrame(image)
		this.#frame = frame

		const pulseDelay = this.#processFrame(frame)
		await this.#queueNextExposure(pulseDelay)
	}

	// Converts a decoded image into a guide frame and prioritizes the selected lock star.
	#makeGuideFrame(image?: Image): GuideFrame {
		const stars = image === undefined ? [] : detectStars(image)
		const lockSearchPosition = this.#lockSearchPosition ?? this.#lockPosition

		if (lockSearchPosition !== undefined && stars.length > 1) {
			moveNearestGuideStarToFront(stars, lockSearchPosition)
		}

		return {
			stars,
			width: image?.metadata.width ?? this.#camera?.frame.width.value ?? 0,
			height: image?.metadata.height ?? this.#camera?.frame.height.value ?? 0,
			timestamp: Date.now(),
			frameId: ++this.#frameId,
		}
	}

	// Routes the current frame to calibration, guiding, or passive looping.
	#processFrame(frame: GuideFrame) {
		const appState = this.#appState === 'Paused' && !this.#fullPause ? this.#resumeState : this.#appState

		if (appState === 'Calibrating') return this.#processCalibrationFrame(frame)
		if (appState === 'Guiding' || appState === 'LostLock') return this.#processGuidingFrame(frame)
		if (appState === 'Looping' || appState === 'Selected') this.emitLoopingExposuresEvent(frame)

		return 0
	}

	// Advances the calibration state machine and stores the solved matrix when complete.
	#processCalibrationFrame(frame: GuideFrame) {
		const step = this.#calibrator.processFrame(frame)

		this.#updateLockPositionFromCalibration(step.diagnostics)
		this.emitCalibratingEvent(step.diagnostics)

		if (step.failure !== undefined) {
			this.emitEvent('CalibrationFailed', { Reason: step.failure.message })
			this.#resumeState = this.#lockPosition === undefined ? 'Looping' : 'Selected'
			if (!this.#paused) this.setAppState(this.#resumeState)
			return 0
		}

		if (step.completed !== undefined) {
			this.#calibration = step.completed
			this.#guider = this.#makeGuider(this.#calibration)
			this.emitEvent('CalibrationComplete', { Mount: this.#guideOutput?.name ?? '' })
			this.emitEvent('StartGuiding')
			this.#resumeState = 'Guiding'
			if (!this.#paused) this.setAppState('Guiding')
			return 0
		}

		return this.#pulseCalibration(step.pulse?.ra.direction, step.pulse?.ra.duration, step.pulse?.dec.direction, step.pulse?.dec.duration)
	}

	// Runs the guide controller, applies settle tracking, and returns the max pulse delay.
	#processGuidingFrame(frame: GuideFrame) {
		const command = this.#guider.processFrame(frame)

		this.#updateLockPositionFromGuider(command.diagnostics.targetX, command.diagnostics.targetY)
		this.#updateLockSearchPositionFromGuider(command.diagnostics.measurementX, command.diagnostics.measurementY)

		if (command.state === 'lost') {
			this.emitStarLostEvent(frame, command)
			this.emitEvent('LockPositionLost')
			this.#resumeState = 'LostLock'
			if (!this.#paused) this.setAppState('LostLock')
			this.#settling = false
			this.#settleStartTime = 0
			this.#settleStableSince = 0
			this.#settleFrameCount = 0
			this.#settleDroppedFrameCount = 0
			return 0
		}

		this.emitGuideStepEvent(frame, command)

		this.#resumeState = 'Guiding'
		if (!this.#paused) this.setAppState('Guiding')

		this.#updateSettling(command.diagnostics.dx, command.diagnostics.dy, command.diagnostics.badFrame, command.diagnostics.lost, frame.timestamp ?? Date.now())
		this.#updateLockShift(frame)

		return Math.max(this.#pulseAxis(command.ra.direction, command.ra.duration), this.#pulseAxis(command.dec.direction, command.dec.duration))
	}

	// Sends one calibration pulse pair and returns the largest applied delay.
	#pulseCalibration(raDirection?: AxisPulse['direction'], raDuration?: number, decDirection?: AxisPulse['direction'], decDuration?: number) {
		return Math.max(this.#pulseAxis(raDirection, raDuration), this.#pulseAxis(decDirection, decDuration))
	}

	// Sends one axis pulse if guide output is enabled and returns the applied delay.
	#pulseAxis(direction?: AxisPulse['direction'], duration?: number) {
		if (this.#guideOutput === undefined || this.#paused || !this.#guideOutputEnabled || direction === undefined || direction === null || duration === undefined || duration <= 0 || !Number.isFinite(duration)) return 0

		const pulseDuration = Math.max(1, Math.round(duration))
		this.guideOutputManager.pulse(this.#guideOutput, direction.toUpperCase() as GuideDirection, pulseDuration)

		return pulseDuration
	}

	// Updates settle state from current guide error and elapsed settle timing.
	#updateSettling(dx: number | undefined, dy: number | undefined, badFrame: boolean, lost: boolean, timestamp: number) {
		if (!this.#settling || this.#paused) return

		if (this.#settleStartTime === 0) {
			this.#settleStartTime = timestamp
			this.#settleStableSince = 0
			this.#settleFrameCount = 0
			this.#settleDroppedFrameCount = 0
		}

		this.#settleFrameCount++

		if (this.#settle.timeout > 0 && timestamp - this.#settleStartTime >= this.#settle.timeout * 1000) {
			this.#settling = false
			this.emitSettleDoneEvent(1, 'settle timeout')
			return
		}

		if (badFrame || lost || dx === undefined || dy === undefined) {
			this.#settleStableSince = 0
			this.#settleDroppedFrameCount++
			this.emitSettlingEvent(0, timestamp, false)
			return
		}

		const distance = Math.hypot(dx, dy)

		if (distance > this.#settle.pixels) {
			this.#settleStableSince = 0
			this.emitSettlingEvent(distance, timestamp, true)
			return
		}

		if (this.#settleStableSince === 0) {
			this.#settleStableSince = timestamp
			this.emitSettlingEvent(distance, timestamp, true)
			return
		}

		if (timestamp - this.#settleStableSince >= this.#settle.time * 1000) {
			this.#settling = false
			this.emitSettleDoneEvent(0)
			return
		}

		this.emitSettlingEvent(distance, timestamp, true)
	}

	// Refreshes the public lock target from guider diagnostics when available.
	#updateLockPositionFromGuider(targetX: number | undefined, targetY: number | undefined) {
		if (targetX !== undefined && targetY !== undefined) {
			this.#lockPosition = [targetX, targetY] as const
			if (!this.#stickyLockPosition) this.#lockSearchPosition = this.#lockPosition
		}
	}

	// Refreshes the star-search center from the latest measured centroid while Sticky Lock Position is active.
	#updateLockSearchPositionFromGuider(measurementX: number | undefined, measurementY: number | undefined) {
		if (this.#stickyLockPosition && measurementX !== undefined && measurementY !== undefined) {
			this.#lockSearchPosition = [measurementX, measurementY] as const
		}
	}

	// Advances the lock-shift offset using elapsed time and the configured X/Y or RA/DEC drift rates.
	#updateLockShift(frame: GuideFrame) {
		const timestamp = frame.timestamp ?? Date.now()

		if (!this.#lockShiftParams.enabled || this.#paused || this.#guider.currentState.state !== 'guiding') {
			this.#lockShiftTimestamp = timestamp
			return
		}

		if (this.#lockShiftTimestamp === 0) {
			this.#lockShiftTimestamp = timestamp
			return
		}

		const elapsed = timestamp - this.#lockShiftTimestamp
		this.#lockShiftTimestamp = timestamp

		if (elapsed <= 0) return

		const rate = this.#lockShiftRateInImagePixelsPerHour()
		if (rate === undefined) return

		const shiftScale = elapsed / 3600000
		this.#lockShiftOffsetX += rate[0] * shiftScale
		this.#lockShiftOffsetY += rate[1] * shiftScale

		const { referenceX, referenceY } = this.#guider.currentState
		let lockX = referenceX + this.#ditherOffsetX + this.#lockShiftOffsetX
		let lockY = referenceY + this.#ditherOffsetY + this.#lockShiftOffsetY
		let limitReached = false

		if (frame.width > 0 && frame.height > 0) {
			const clampedLockX = clamp(lockX, 0, frame.width - 1)
			const clampedLockY = clamp(lockY, 0, frame.height - 1)
			limitReached = clampedLockX !== lockX || clampedLockY !== lockY

			if (limitReached) {
				lockX = clampedLockX
				lockY = clampedLockY
				this.#lockShiftOffsetX = clampedLockX - referenceX - this.#ditherOffsetX
				this.#lockShiftOffsetY = clampedLockY - referenceY - this.#ditherOffsetY
			}
		}

		this.#syncGuideTargetOffset()
		this.#lockPosition = [lockX, lockY] as const
		if (!this.#stickyLockPosition) this.#lockSearchPosition = this.#lockPosition

		if (limitReached) {
			if (!this.#lockShiftLimitReached) this.emitEvent('LockPositionShiftLimitReached')
			this.#lockShiftLimitReached = true
		} else {
			this.#lockShiftLimitReached = false
		}
	}

	// Converts the configured lock-shift rate into image-space pixels/hour when the current data model can support it.
	#lockShiftRateInImagePixelsPerHour() {
		let [rate0, rate1] = this.#lockShiftParams.rate

		if (rate0 === 0 && rate1 === 0) return [0, 0] as const

		if (this.#lockShiftParams.units === 'arcsec/hr') {
			const pixelScale = this.getPixelScale()
			if (pixelScale <= 0) return undefined
			rate0 /= pixelScale
			rate1 /= pixelScale
		}

		if (this.#lockShiftParams.axes === 'X/Y') return [rate0, rate1] as const

		if (this.#calibration === undefined) return undefined

		return [this.#calibration.ra.unitX * rate0 + this.#calibration.dec.unitX * rate1, this.#calibration.ra.unitY * rate0 + this.#calibration.dec.unitY * rate1] as const
	}

	// Reapplies the combined manual dither and lock-shift target offset to the guider state.
	#syncGuideTargetOffset() {
		const offsetX = this.#ditherOffsetX + this.#lockShiftOffsetX
		const offsetY = this.#ditherOffsetY + this.#lockShiftOffsetY

		if (offsetX === 0 && offsetY === 0) {
			this.#guider.stopDither()
		} else {
			this.#guider.startDither(offsetX, offsetY)
		}
	}

	// Refreshes the public lock target from calibration diagnostics when available.
	#updateLockPositionFromCalibration(diagnostics: GuidingCalibrationDiagnostics) {
		const x = diagnostics.currentX ?? diagnostics.startX
		const y = diagnostics.currentY ?? diagnostics.startY

		if (x !== undefined && y !== undefined) {
			this.#lockSearchPosition = [x, y] as const
			if (!this.#stickyLockPosition) this.#lockPosition = this.#lockSearchPosition
		}
	}

	// Returns the sticky lock reference seed used for the next guider initialization.
	get #guiderReferencePosition() {
		return this.#stickyLockPosition ? this.#lockPosition : undefined
	}

	// Returns the current star-acquisition seed used for the next guider initialization.
	get #guiderInitialPosition() {
		return this.#lockSearchPosition
	}

	// Starts another exposure after pulse delay if the current session is still active.
	async #queueNextExposure(delay: number): Promise<void> {
		if (delay > 0) await Bun.sleep(delay)
		if (!this.#connected || this.#camera === undefined || this.#appState === 'Stopped' || (this.#appState === 'Paused' && this.#fullPause)) return
		this.cameraManager.startExposure(this.#camera, this.#exposure)
	}

	// Resets transient guider state while optionally dropping calibration.
	#resetRuntimeState(clearCalibration: boolean) {
		this.#frame = undefined
		this.#image = undefined
		this.#frameId = 0
		this.#lockPosition = undefined
		this.#lockSearchPosition = undefined
		this.#appState = 'Stopped'
		this.#resumeState = 'Stopped'
		this.#paused = false
		this.#fullPause = true
		this.#guideOutputEnabled = true
		this.#declinationGuideMode = 'Auto'
		this.#exposure = DEFAULT_GUIDER_EXPOSURE
		this.#settling = false
		this.#settle = { ...DEFAULT_PHD2_SETTLE }
		this.#settleStartTime = 0
		this.#settleStableSince = 0
		this.#settleFrameCount = 0
		this.#settleDroppedFrameCount = 0
		this.#ditherOffsetX = 0
		this.#ditherOffsetY = 0
		this.#lockShiftOffsetX = 0
		this.#lockShiftOffsetY = 0
		this.#lockShiftTimestamp = 0
		this.#lockShiftLimitReached = false
		this.#lockShiftParams.enabled = false
		this.#lockShiftParams.rate = [0, 0]
		this.#lockShiftParams.units = 'pixels/hr'
		this.#lockShiftParams.axes = 'X/Y'
		this.#calibrator.reset()
		if (clearCalibration) this.#calibration = undefined
		this.#guider = this.#makeGuider(this.#calibration)
	}

	// Builds a guider instance from the current calibration, axis parity, and DEC mode.
	#makeGuider(calibration: GuidingCalibrationResult | undefined) {
		if (calibration === undefined) return new Guider({ decMode: toDeclinationGuideMode(this.#declinationGuideMode), referencePosition: this.#guiderReferencePosition, initialPosition: this.#guiderInitialPosition })

		return new Guider({
			calibration: calibration.imageToAxis,
			raPositiveDirection: calibration.ra.direction,
			decPositiveDirection: calibration.dec.direction,
			decMode: toDeclinationGuideMode(this.#declinationGuideMode),
			referencePosition: this.#guiderReferencePosition,
			initialPosition: this.#guiderInitialPosition,
		})
	}

	// Emits one callback event if the caller provided an event handler.
	emitEvent<T extends keyof PHD2EventMap>(Event: T, data?: Omit<PHD2EventMap[T], 'Event' | 'Timestamp' | 'Host' | 'Inst'>) {
		const event = {
			...data,
			Event,
			Timestamp: Date.now(),
			Host: '', // The local guider is not a network PHD2 server, so Host defaults to an empty string.
			Inst: 0, // There is no PHD2 instance index in this local client, so Inst defaults to zero.
		} as PHD2Events

		this.#eventHandler?.(this, event)
	}

	// Updates the app state and emits the paired PHD2 AppState event once.
	private setAppState(appState: PHD2AppState) {
		// if (this.#appState === appState) return
		this.#appState = appState
		// The AppState notification is only sent when the client first connects to PHD2.
		// You will need to update its notion of AppState by handling individual notification events.
		// https://github.com/OpenPHDGuiding/phd2/wiki/EventMonitoring#appstate
		// this.emitEvent('AppState', { State: appState })
	}

	// Emits the capture-stop event that matches the current or paused-resume session mode.
	private emitCaptureStoppedEvent() {
		const appState = this.#appState === 'Paused' ? this.#resumeState : this.#appState

		if (appState === 'Looping' || appState === 'Selected') {
			this.emitEvent('LoopingExposuresStopped')
		} else if (appState === 'Calibrating' || appState === 'Guiding' || appState === 'LostLock') {
			this.emitEvent('GuidingStopped')
		}
	}

	// Emits one passive frame event while exposures are looping.
	private emitLoopingExposuresEvent(frame: GuideFrame) {
		const star = frame.stars[0]

		this.emitEvent('LoopingExposures', {
			Frame: frame.frameId ?? 0,
			// Uses zero defaults when no star survives filtering in the current frame.
			StarMass: star?.flux ?? 0,
			SNR: star?.snr ?? 0,
			HFD: star?.hfd ?? 0,
		})
	}

	// Emits a calibration progress event from the latest calibrator diagnostics.
	private emitCalibratingEvent(diagnostics: GuidingCalibrationDiagnostics) {
		const x = diagnostics.currentX ?? diagnostics.startX ?? 0
		const y = diagnostics.currentY ?? diagnostics.startY ?? 0
		const pendingPulse = diagnostics.pendingPulse?.ra.direction ?? diagnostics.pendingPulse?.dec.direction

		this.emitEvent('Calibrating', {
			// Uses an empty mount name if the guide-output device is not available.
			Mount: this.#guideOutput?.name ?? '',
			// Uses an empty direction when the current calibration frame is only a measurement frame.
			dir: pendingPulse?.toLowerCase() ?? '',
			dist: calibrationDistanceOf(diagnostics),
			dx: x - (diagnostics.startX ?? x),
			dy: y - (diagnostics.startY ?? y),
			// PHD2's `pos` shape is not modeled locally, so emit the measured image coordinates.
			pos: [x, y] as const,
			step: diagnostics.raSteps + diagnostics.decSteps + diagnostics.clearingSteps,
			State: diagnostics.phase,
		})
	}

	// Emits one guide-step event using the latest guider command and diagnostics.
	private emitGuideStepEvent(frame: GuideFrame, command: GuideCommand) {
		const { diagnostics, ra, dec } = command
		const star = frame.stars[0]
		const dx = diagnostics.dx ?? 0
		const dy = diagnostics.dy ?? 0
		const raDuration = this.#paused || !this.#guideOutputEnabled ? 0 : Math.round(ra.duration)
		const decDuration = this.#paused || !this.#guideOutputEnabled ? 0 : Math.round(dec.duration)

		this.emitEvent('GuideStep', {
			Frame: frame.frameId ?? 0,
			Time: frame.timestamp ?? 0,
			// Uses an empty mount name if the guide-output device is unavailable.
			Mount: this.#guideOutput?.name ?? '',
			dx,
			dy,
			RADistanceRaw: diagnostics.axisErrorRA ?? 0,
			DECDistanceRaw: diagnostics.axisErrorDEC ?? 0,
			RADistanceGuide: this.#paused || !this.#guideOutputEnabled ? 0 : (diagnostics.filteredRA ?? 0),
			DECDistanceGuide: this.#paused || !this.#guideOutputEnabled ? 0 : (diagnostics.filteredDEC ?? 0),
			RADuration: raDuration,
			// PHD2 directions are mandatory, so no-pulse frames fall back to west/north defaults.
			RADirection: toPHD2GuideDirection(ra.direction, 'West'),
			DECDuration: decDuration,
			DECDirection: toPHD2GuideDirection(dec.direction, 'North'),
			// Uses zero defaults when the guide frame has no measurable star metadata.
			StarMass: star?.flux ?? 0,
			SNR: star?.snr ?? 0,
			HFD: star?.hfd ?? 0,
			AvgDist: Math.hypot(dx, dy),
			RALimited: ra.duration >= this.#guider.config.maxPulseMsRA,
			DecLimited: dec.duration >= this.#guider.config.maxPulseMsDEC,
			ErrorCode: 0,
		})
	}

	// Emits a star-lost event for the current frame.
	private emitStarLostEvent(frame: GuideFrame, command: GuideCommand) {
		const star = frame.stars[0]
		const dx = command.diagnostics.dx ?? 0
		const dy = command.diagnostics.dy ?? 0

		this.emitEvent('StarLost', {
			Frame: frame.frameId ?? 0,
			Time: frame.timestamp ?? 0,
			// Uses zero defaults when the lost-lock frame has no guide star measurement.
			StarMass: star?.flux ?? 0,
			SNR: star?.snr ?? 0,
			AvgDist: Math.hypot(dx, dy),
			ErrorCode: 1,
			Status: command.diagnostics.notes.join(','),
		})
	}

	// Emits one in-progress settle event using elapsed and stable-settle timers in seconds.
	private emitSettlingEvent(distance: number, timestamp: number, starLocked: boolean) {
		this.emitEvent('Settling', {
			Distance: distance,
			Time: (timestamp - this.#settleStartTime) * 0.001,
			SettleTime: this.#settleStableSince === 0 ? 0 : (timestamp - this.#settleStableSince) * 0.001,
			StarLocked: starLocked,
		})
	}

	// Emits the final settle status and clears the local settle counters.
	private emitSettleDoneEvent(status: number, error?: string) {
		this.emitEvent('SettleDone', { Status: status, TotalFrames: this.#settleFrameCount, DroppedFrames: this.#settleDroppedFrameCount, Error: error })
		this.#settleFrameCount = 0
		this.#settleDroppedFrameCount = 0
	}
}

// Maps PHD2 DEC guide mode values to the local guider model.
function toDeclinationGuideMode(mode: PHD2DeclinationGuideMode) {
	return (mode === 'Off' ? 'off' : mode === 'North' ? 'north-only' : mode === 'South' ? 'south-only' : 'auto') satisfies DeclinationGuideMode
}

// Converts the local calibration result into PHD2-compatible calibration data.
function calibrationResultToPHD2Data(calibration: GuidingCalibrationResult): PHD2CalibrationData {
	return {
		calibrated: true,
		xAngle: calibration.ra.angle,
		xRate: calibration.ra.ratePxPerMs,
		xParity: calibration.ra.direction === 'west' ? '+' : '-',
		yAngle: calibration.dec.angle,
		yRate: calibration.dec.ratePxPerMs,
		yParity: calibration.dec.direction === 'north' ? '+' : '-',
	}
}

// Generates a random image-space dither offset with the requested amplitude in pixels.
function makeRandomDither(amount: number) {
	const angle = Math.random() * TAU
	return [Math.cos(angle) * amount, Math.sin(angle) * amount] as const
}

// Generates a random RA-only dither offset along the calibrated RA image vector.
function makeRaOnlyDither(calibration: GuidingCalibrationResult, amount: number) {
	const sign = Math.random() < 0.5 ? -1 : 1
	return [calibration.ra.unitX * amount * sign, calibration.ra.unitY * amount * sign] as const
}

// Moves the nearest star to the first slot so Guider/GuidingCalibrator lock onto the requested target.
function moveNearestGuideStarToFront(stars: GuideStar[], position: readonly [number, number]) {
	const [x, y] = position
	let index = 0
	let distanceSq = Number.POSITIVE_INFINITY

	for (let i = 0; i < stars.length; i++) {
		const star = stars[i]
		const dx = star.x - x
		const dy = star.y - y
		const candidateDistanceSq = dx * dx + dy * dy

		if (candidateDistanceSq < distanceSq) {
			distanceSq = candidateDistanceSq
			index = i
		}
	}

	if (index > 0) {
		const star = stars[0]
		stars[0] = stars[index]
		stars[index] = star
	}
}

// Finds the nearest detected guide star to a requested image coordinate.
function nearestGuideStar(stars: readonly GuideStar[], x: number, y: number): GuideStar | undefined {
	let selected: GuideStar | undefined
	let distanceSq = Number.POSITIVE_INFINITY

	for (const star of stars) {
		const dx = star.x - x
		const dy = star.y - y
		const candidateDistanceSq = dx * dx + dy * dy

		if (candidateDistanceSq < distanceSq) {
			distanceSq = candidateDistanceSq
			selected = star
		}
	}

	return selected
}

// Selects the most relevant scalar progress distance for the current calibration phase.
function calibrationDistanceOf(diagnostics: GuidingCalibrationDiagnostics) {
	if (diagnostics.phase === 'raClearPulse' || diagnostics.phase === 'raClearMeasure') return diagnostics.clearingDistancePx
	if (diagnostics.phase === 'decForwardPulse' || diagnostics.phase === 'decBacklashClearing' || diagnostics.phase === 'decForwardMeasure' || diagnostics.phase === 'decForwardComplete') return diagnostics.decNetDistancePx
	return diagnostics.raNetDistancePx
}

// Converts local pulse directions to PHD2 casing and falls back to a mandatory default direction on no-pulse frames.
function toPHD2GuideDirection(direction: AxisPulse['direction'], fallback: PHD2GuideDirection) {
	return direction === null ? fallback : ((direction[0].toUpperCase() + direction.slice(1).toLowerCase()) as PHD2GuideDirection)
}

// Resolves the focal length in mm from explicit focal length or aperture/focal-ratio geometry.
function resolveFocalLength(options?: GuiderClientConnectOptions) {
	const focalLength = options?.focalLength ?? 0
	if (focalLength > 0 && Number.isFinite(focalLength)) return focalLength

	const aperture = options?.aperture ?? 0
	const focalRatio = options?.focalRatio ?? 0
	return aperture > 0 && focalRatio > 0 && Number.isFinite(aperture) && Number.isFinite(focalRatio) ? aperture * focalRatio : 0
}

// Resolves the fallback unbinned pixel size in um from explicit connection options.
function resolveConfiguredPixelSize(options?: GuiderClientConnectOptions) {
	const pixelSize = options?.pixelSize ?? 0
	return pixelSize > 0 && Number.isFinite(pixelSize) ? pixelSize : 0
}

// Computes one scalar effective binned pixel size in um from camera metadata and optional fallback size.
function resolveEffectivePixelSize(camera: Camera, pixelSize: number) {
	const binX = camera.bin.x.value > 0 && Number.isFinite(camera.bin.x.value) ? camera.bin.x.value : 1
	const binY = camera.bin.y.value > 0 && Number.isFinite(camera.bin.y.value) ? camera.bin.y.value : 1
	const pixelSizeX = camera.pixelSize.x > 0 && Number.isFinite(camera.pixelSize.x) ? camera.pixelSize.x : pixelSize
	const pixelSizeY = camera.pixelSize.y > 0 && Number.isFinite(camera.pixelSize.y) ? camera.pixelSize.y : pixelSize

	if (pixelSizeX <= 0) return pixelSizeY <= 0 ? 0 : pixelSizeY * binY
	if (pixelSizeY <= 0) return pixelSizeX * binX

	// PHD2 exposes one scalar pixel scale, so asymmetric binned pixel sizes are averaged.
	return 0.5 * (pixelSizeX * binX + pixelSizeY * binY)
}

// Crops a square ROI around the guide star and preserves interleaved channel ordering.
function cropStarImage(image: Image, frame: number, x: number, y: number, searchRegion: number): PHD2StarImage<ImageRawType> {
	const { metadata, raw } = image
	const { width, height, channels, stride } = metadata
	const cropWidth = resolveCropSize(searchRegion, width)
	const cropHeight = resolveCropSize(searchRegion, height)
	const starX = clampStarCoordinate(x, width)
	const starY = clampStarCoordinate(y, height)
	const cropX = Math.max(0, Math.min(width - cropWidth, Math.round(starX) - (cropWidth >> 1)))
	const cropY = Math.max(0, Math.min(height - cropHeight, Math.round(starY) - (cropHeight >> 1)))
	const pixels = makeImageRawTypedArray(raw, cropWidth * cropHeight * channels)
	const rowLength = cropWidth * channels
	let sourceOffset = cropY * stride + cropX * channels
	let targetOffset = 0

	for (let row = 0; row < cropHeight; row++) {
		const targetRowEnd = targetOffset + rowLength
		while (targetOffset < targetRowEnd) pixels[targetOffset++] = raw[sourceOffset++]
		sourceOffset += stride - rowLength
	}

	return {
		width: cropWidth,
		height: cropHeight,
		frame,
		// Star coordinates are relative to the returned ROI origin.
		star_pos: { x: starX - cropX, y: starY - cropY },
		pixels,
	}
}

// Resolves the clamped crop side for one image axis.
function resolveCropSize(searchRegion: number, imageSize: number) {
	if (!Number.isFinite(searchRegion) || searchRegion <= 0) return imageSize
	return Math.max(1, Math.min(imageSize, Math.trunc(searchRegion)))
}

// Clamps the requested star coordinate to the valid image domain.
function clampStarCoordinate(value: number, imageSize: number) {
	if (!Number.isFinite(value) || imageSize <= 1) return 0
	return Math.max(0, Math.min(imageSize - 1, value))
}
