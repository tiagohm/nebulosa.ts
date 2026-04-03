import { TAU } from './constants'
import { type AxisPulse, type DeclinationGuideMode, type GuideFrame, Guider, type GuideStar } from './guider'
import { type GuidingCalibrationDiagnostics, type GuidingCalibrationResult, GuidingCalibrator } from './guider.calibrator'
import { readImageFromBuffer, readImageFromSource } from './image'
import type { Image } from './image.types'
import type { Camera, GuideDirection, GuideOutput } from './indi.device'
import type { CameraManager, DeviceHandler, GuideOutputManager } from './indi.manager'
import { base64Source } from './io'
import { DEFAULT_PHD2_SETTLE, type PHD2AppState, type PHD2CalibrationData, type PHD2DeclinationGuideMode, type PHD2GuideDirection, type PHD2LockShiftParams, type PHD2Settle } from './phd2'
import { detectStars } from './star.detector'
import type { PartialOnly, Writable } from './types'

const DEFAULT_GUIDER_EXPOSURE = 1

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

// GuiderClient adapts local INDI camera/guide-output devices to a PHD2-like API.
export class GuiderClient {
	#connected = false
	#camera?: Camera
	#guideOutput?: GuideOutput
	#guider = makeGuider(undefined, 'Auto')
	#calibrator = new GuidingCalibrator()
	#calibration?: GuidingCalibrationResult
	#frame?: GuideFrame
	#image?: Image
	#frameId = 0
	#lockPosition?: readonly [number, number]
	#appState: PHD2AppState = 'Stopped'
	#resumeState: PHD2AppState = 'Stopped'
	#declinationGuideMode: PHD2DeclinationGuideMode = 'Auto'
	#exposure = DEFAULT_GUIDER_EXPOSURE
	#guideOutputEnabled = true
	#paused = false
	#fullPause = true
	#settling = false
	#settle: PHD2Settle = { ...DEFAULT_PHD2_SETTLE }
	#settleStartTime = 0
	#settleStableSince = 0
	#lockShiftEnabled = false
	readonly #lockShiftParams = { ...DEFAULT_LOCK_SHIFT_PARAMS }

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
	) {}

	// Binds the active camera and guide output, enables image BLOBs, and starts listening.
	connect(camera: Camera, guideOutput: GuideOutput) {
		if (this.#connected) return false

		this.#camera = camera
		this.#guideOutput = guideOutput
		this.#connected = true
		this.cameraManager.addHandler(this.#cameraHandler)
		this.cameraManager.enableBlob(camera)
		this.#resetRuntimeState(true)

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
		this.#resetRuntimeState(true)

		return true
	}

	// Finds the best star in the most recent frame and stores it as the preferred lock position.
	findStar() {
		if (this.#frame === undefined) return undefined

		const selected = this.#guider.selectGuideStar(this.#frame).primary
		if (selected === undefined) return undefined

		this.#lockPosition = [selected.x, selected.y] as const

		if (this.#appState === 'Stopped' || this.#appState === 'Looping') {
			this.#appState = 'Selected'
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
		if (this.#camera !== undefined) {
			this.cameraManager.stopExposure(this.#camera)
		}

		this.#paused = false
		this.#fullPause = true
		this.#settling = false
		this.#settleStartTime = 0
		this.#settleStableSince = 0
		this.#resumeState = 'Stopped'
		this.#appState = 'Stopped'

		if (this.#guider.currentState.ditherActive) {
			this.#guider.stopDither()
		}
	}

	// Clears the solved calibration and resets the guider/calibrator state machines.
	clearCalibration() {
		this.#calibration = undefined
		this.#calibrator.reset()
		this.#guider = makeGuider(undefined, this.#declinationGuideMode)
		this.#settling = false
		this.#settleStartTime = 0
		this.#settleStableSince = 0

		if (this.#appState === 'Calibrating' || this.#appState === 'Guiding' || this.#appState === 'LostLock' || this.#appState === 'Paused') {
			this.#resumeState = this.#lockPosition === undefined ? 'Looping' : 'Selected'
			if (!this.#paused) this.#appState = this.#resumeState
		}
	}

	// Drops the preferred lock position and returns to plain looping if capture is still active.
	deselectStar() {
		this.#lockPosition = undefined
		this.#settling = false
		this.#settleStartTime = 0
		this.#settleStableSince = 0
		this.#guider.reset()

		if (this.#guider.currentState.ditherActive) {
			this.#guider.stopDither()
		}

		if (this.#appState !== 'Stopped') {
			this.#resumeState = 'Looping'
			if (!this.#paused) this.#appState = 'Looping'
		}
	}

	// Applies a random image-space dither and tracks local settle status.
	dither(amount: number, raOnly: boolean = false, settle: Partial<PHD2Settle> = DEFAULT_PHD2_SETTLE) {
		if (this.#calibration === undefined || this.#guider.currentState.state !== 'guiding' || amount <= 0 || !Number.isFinite(amount)) return false

		const { ditherOffsetX, ditherOffsetY, referenceX, referenceY } = this.#guider.currentState
		const [dx, dy] = raOnly ? makeRaOnlyDither(this.#calibration, amount) : makeRandomDither(amount)

		this.#guider.startDither(ditherOffsetX + dx, ditherOffsetY + dy)
		this.#lockPosition = [referenceX + ditherOffsetX + dx, referenceY + ditherOffsetY + dy] as const
		this.#settle = { ...DEFAULT_PHD2_SETTLE, ...settle }
		this.#settling = true
		this.#settleStartTime = 0
		this.#settleStableSince = 0

		return true
	}

	// TODO: implement calibration parity flipping once the local guider exposes a safe pier-flip transform.
	flipCalibration() {}

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

	// TODO: implement lock-shift drift compensation once the guider state model supports it.
	getLockShiftEnabled() {
		return this.#lockShiftEnabled
	}

	// TODO: implement lock-shift drift compensation once the guider state model supports it.
	getLockShiftParams(): PHD2LockShiftParams {
		return this.#lockShiftParams
	}

	// Returns whether guiding output is paused.
	getPaused() {
		return this.#paused
	}

	// TODO: compute arcsec/pixel only when the camera and telescope focal geometry are available.
	getPixelScale() {
		return 0
	}

	// TODO: expose a dedicated search-region parameter if the guider gains one.
	getSearchRegion() {
		return 0
	}

	// Returns true while an active dither waits for the settle criteria.
	getSettling() {
		return this.#settling
	}

	// TODO: expose a PHD2-compatible star-image payload once the expected pixel encoding is defined.
	getStarImage() {
		return undefined
	}

	// Starts guiding and triggers calibration first when requested or when no solution exists yet.
	guide(recalibrate: boolean = false, settle: PHD2Settle = DEFAULT_PHD2_SETTLE) {
		if (!this.#connected || this.#camera === undefined || this.#guideOutput === undefined) return false

		this.#paused = false
		this.#fullPause = true
		this.#resumeState = 'Guiding'
		this.#settling = false
		this.#settle = { ...DEFAULT_PHD2_SETTLE, ...settle }
		this.#settleStartTime = 0
		this.#settleStableSince = 0

		if (recalibrate || this.#calibration === undefined) {
			if (recalibrate) this.#calibration = undefined
			this.#calibrator.reset()
			this.#appState = 'Calibrating'
		} else {
			this.#guider = makeGuider(this.#calibration, this.#declinationGuideMode)
			this.#appState = 'Guiding'
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
		this.#appState = this.#lockPosition === undefined ? 'Looping' : 'Selected'
		this.startCapture(this.#exposure)

		return true
	}

	// Updates the DEC guide mode and rebuilds the guider with the current calibration matrix.
	setDeclinationGuideMode(mode: PHD2DeclinationGuideMode) {
		this.#declinationGuideMode = mode
		if (this.#appState !== 'Calibrating') this.#guider = makeGuider(this.#calibration, mode)
	}

	// Stores the default exposure cadence for subsequent captures.
	setExposure(exposure: number) {
		if (exposure <= 0 || !Number.isFinite(exposure)) return false
		this.#exposure = exposure
		return true
	}

	// Enables or disables guide pulses while keeping frame processing active.
	setGuideOutputEnabled(enabled: boolean) {
		this.#guideOutputEnabled = enabled
	}

	// Stores the requested lock target and relocks to the nearest detected star unless exact matching is requested.
	setLockPosition(x: number, y: number, exact: boolean = false) {
		if (!Number.isFinite(x) || !Number.isFinite(y)) return false

		if (!exact && this.#frame !== undefined && this.#frame.stars.length > 0) {
			const nearest = nearestGuideStar(this.#frame.stars, x, y)
			this.#lockPosition = nearest === undefined ? ([x, y] as const) : ([nearest.x, nearest.y] as const)
		} else {
			// TODO: exact lock coordinates are stored, but Guider still relocks using nearest-star acquisition on the next frame.
			this.#lockPosition = [x, y] as const
		}

		if (this.#appState === 'Guiding' || this.#appState === 'LostLock' || this.#appState === 'Paused') {
			this.#guider = makeGuider(this.#calibration, this.#declinationGuideMode)
			this.#resumeState = 'Guiding'
			if (!this.#paused) this.#appState = 'Guiding'
		} else if (this.#appState !== 'Stopped') {
			this.#resumeState = 'Selected'
			if (!this.#paused) this.#appState = 'Selected'
		}

		return true
	}

	// TODO: implement lock-shift drift compensation once the guider state model supports it.
	setLockShiftEnabled(enabled: boolean) {
		this.#lockShiftEnabled = enabled
	}

	// TODO: implement lock-shift drift compensation once the guider state model supports it.
	setLockShiftParams(params: PartialOnly<Omit<Writable<PHD2LockShiftParams>, 'enabled'>, 'units'>) {
		const { rate, axes, units } = params
		if (rate !== undefined) this.#lockShiftParams.rate = rate
		if (axes !== undefined) this.#lockShiftParams.axes = axes
		this.#lockShiftParams.units = units ?? (this.#lockShiftParams.axes === 'RA/Dec' ? 'arcsec/hr' : 'pixels/hr')
	}

	// Pauses or resumes guide pulses, optionally stopping exposures during full pause.
	setPaused(paused: boolean, full: boolean = true) {
		if (paused) {
			if (!this.#paused) this.#resumeState = this.#appState === 'Paused' ? this.#resumeState : this.#appState
			this.#paused = true
			this.#fullPause = full || this.#resumeState === 'Calibrating'
			this.#appState = 'Paused'
			if (this.#fullPause && this.#camera !== undefined) this.cameraManager.stopExposure(this.#camera)
			return true
		}

		this.#paused = false
		this.#fullPause = true
		this.#appState = this.#resumeState === 'Paused' ? 'Looping' : this.#resumeState

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

		if (this.#lockPosition !== undefined && stars.length > 1) {
			moveNearestGuideStarToFront(stars, this.#lockPosition)
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

		return 0
	}

	// Advances the calibration state machine and stores the solved matrix when complete.
	#processCalibrationFrame(frame: GuideFrame) {
		const step = this.#calibrator.processFrame(frame)

		this.#updateLockPositionFromCalibration(step.diagnostics)

		if (step.failure !== undefined) {
			this.#resumeState = this.#lockPosition === undefined ? 'Looping' : 'Selected'
			if (!this.#paused) this.#appState = this.#resumeState
			return 0
		}

		if (step.completed !== undefined) {
			this.#calibration = step.completed
			this.#guider = makeGuider(this.#calibration, this.#declinationGuideMode)
			this.#resumeState = 'Guiding'
			if (!this.#paused) this.#appState = 'Guiding'
			return 0
		}

		return this.#pulseCalibration(step.pulse?.ra.direction, step.pulse?.ra.duration, step.pulse?.dec.direction, step.pulse?.dec.duration)
	}

	// Runs the guide controller, applies settle tracking, and returns the max pulse delay.
	#processGuidingFrame(frame: GuideFrame) {
		const command = this.#guider.processFrame(frame)

		this.#updateLockPositionFromGuider(command.diagnostics.targetX, command.diagnostics.targetY)

		if (command.state === 'lost') {
			this.#resumeState = 'LostLock'
			if (!this.#paused) this.#appState = 'LostLock'
			this.#settling = false
			this.#settleStartTime = 0
			this.#settleStableSince = 0
			return 0
		}

		this.#resumeState = 'Guiding'
		if (!this.#paused) this.#appState = 'Guiding'

		this.#updateSettling(command.diagnostics.dx, command.diagnostics.dy, command.diagnostics.badFrame, command.diagnostics.lost, frame.timestamp ?? Date.now())

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
		}

		if (this.#settle.timeout > 0 && timestamp - this.#settleStartTime >= this.#settle.timeout * 1000) {
			this.#settling = false
			return
		}

		if (badFrame || lost || dx === undefined || dy === undefined) {
			this.#settleStableSince = 0
			return
		}

		if (Math.hypot(dx, dy) > this.#settle.pixels) {
			this.#settleStableSince = 0
			return
		}

		if (this.#settleStableSince === 0) {
			this.#settleStableSince = timestamp
			return
		}

		if (timestamp - this.#settleStableSince >= this.#settle.time * 1000) {
			this.#settling = false
		}
	}

	// Refreshes the public lock target from guider diagnostics when available.
	#updateLockPositionFromGuider(targetX: number | undefined, targetY: number | undefined) {
		if (targetX !== undefined && targetY !== undefined) {
			this.#lockPosition = [targetX, targetY] as const
		}
	}

	// Refreshes the public lock target from calibration diagnostics when available.
	#updateLockPositionFromCalibration(diagnostics: GuidingCalibrationDiagnostics) {
		const x = diagnostics.currentX ?? diagnostics.startX
		const y = diagnostics.currentY ?? diagnostics.startY

		if (x !== undefined && y !== undefined) {
			this.#lockPosition = [x, y] as const
		}
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
		this.#lockShiftEnabled = false
		this.#lockShiftParams.rate = [0, 0]
		this.#lockShiftParams.units = 'pixels/hr'
		this.#lockShiftParams.axes = 'X/Y'
		this.#calibrator.reset()
		if (clearCalibration) this.#calibration = undefined
		this.#guider = makeGuider(this.#calibration, this.#declinationGuideMode)
	}
}

// Builds a guider instance from the current calibration and DEC mode.
function makeGuider(calibration: GuidingCalibrationResult | undefined, mode: PHD2DeclinationGuideMode): Guider {
	return new Guider({ calibration: calibration?.imageToAxis, decMode: toDeclinationGuideMode(mode) })
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
