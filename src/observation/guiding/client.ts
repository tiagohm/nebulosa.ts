import { pixelScale } from '../../astronomy/formulas'
import type { PartialOnly, Writable } from '../../core/types'
import { errorMessage } from '../../core/util'
import { DEFAULT_PHD2_SETTLE, type PHD2AppState, type PHD2CalibrationData, type PHD2DeclinationGuideMode, type PHD2EventMap, type PHD2Events, type PHD2GuideDirection, type PHD2GuideStepEvent, type PHD2LockShiftParams, type PHD2Settle, type PHD2StarImage } from '../../devices/guiding/phd2'
import type { Camera, GuideDirection, GuideOutput } from '../../devices/indi/device'
import type { CameraManager, DeviceHandler, GuideOutputManager } from '../../devices/indi/manager'
import type { BlobEncoding } from '../../devices/indi/types'
import { readImageFromBuffer, readImageFromSource } from '../../imaging/model/image'
import { type Image, type ImageRawType, makeImageRawTypedArray } from '../../imaging/model/types'
import { detectStars } from '../../imaging/stars/detector'
import { base64Source, bufferSource } from '../../io/io'
import { clamp } from '../../math/numerical/math'
import { GuidingAssistant, type GuidingAssistantConfig, type GuidingAssistantResult } from './assistant'
import { type CalibrationPulseCommand, flipGuidingCalibration, type GuidingCalibrationConfig, type GuidingCalibrationDiagnostics, type GuidingCalibrationResult, GuidingCalibrator } from './calibrator'
import { DitherGenerator, type DitherMode } from './dither'
import { type AxisPulse, type DeclinationGuideMode, DEFAULT_GUIDER_CONFIG, type GuideCommand, type GuideFrame, Guider, type GuideStar, starInsideSearchRegion } from './guider'

// Local autoguiding orchestrator exposing a PHD2-compatible API over INDI camera and guide-output
// devices. It decodes each camera BLOB, detects stars, drives the GuidingCalibrator and Guider state
// machines, and reproduces PHD2 behaviors — app-state lifecycle, lock position, dithering (random and
// spiral), lock-shift drift compensation, settle tracking, meridian-flip calibration flip, and the
// guiding assistant — while emitting PHD2-shaped events. Distances are pixels; pulse durations and
// timing are milliseconds; pixel scale is arcsec/pixel.

// Default guide exposure when none has been set, in milliseconds.
const DEFAULT_GUIDER_EXPOSURE = 1000
// Default star-image search-region side, in pixels.
const DEFAULT_SEARCH_REGION = 64

// PHD2 application version announced in the Version event on connect. The local guider is not PHD2,
// so this reports the PHD2 release whose event protocol it reproduces.
const PHD2_VERSION = '2.6.13'
// PHD2 sub-version component of the Version event; empty for a non-PHD2 implementation.
const PHD2_SUBVER = ''
// Event protocol message version implemented by this client, matching PHD2's MsgVersion.
const PHD2_MSG_VERSION = 1
// Overlapping exposures are not implemented by the local guider.
const PHD2_OVERLAP_SUPPORT = false
// Extra time, in milliseconds, to wait for TELESCOPE_TIMED_GUIDE_* Busy acknowledgement and the
// later Idle after the nominal pulse duration. Covers INDI network/driver latency so a delayed
// Busy cannot start the mount after the next exposure has already begun.
const PULSE_IDLE_MARGIN_MS = 250
// Floor for the missing-BLOB watchdog, in milliseconds. The timeout is max(3 × exposure, this) so a
// short cadence still waits long enough for a slow INDI round-trip before retrying.
const EXPOSURE_WATCHDOG_MIN_MS = 5000

// Exponential smoothing factor PHD2 applies to the guide distance reported as GuideStep.AvgDist.
// Matches PHD2's Guider::UpdateCurrentDistance, which low-pass filters the per-frame distance so
// clients see a stability indicator instead of raw frame-to-frame noise.
const AVG_DISTANCE_SMOOTHING_ALPHA = 0.3

// Placeholder calibration data returned before any calibration is solved.
const EMPTY_CALIBRATION_DATA: Readonly<PHD2CalibrationData> = {
	calibrated: false,
	xAngle: 0,
	xRate: 0,
	xParity: '+',
	yAngle: 0,
	yRate: 0,
	yParity: '+',
}

// Default lock-shift parameters: drift compensation disabled, zero rate, image X/Y axes.
const DEFAULT_LOCK_SHIFT_PARAMS: Readonly<PHD2LockShiftParams> = {
	enabled: false,
	rate: [0, 0],
	units: 'pixels/hr',
	axes: 'X/Y',
}

// Snapshot of one processed guide exposure, published for UI rendering. It carries the decoded
// image plus everything needed to draw the usual guiding overlay: detected stars, the star being
// tracked, the guide target, and the search window. Distances and positions are image pixels with
// the origin at the top-left corner of the full frame, matching the detector and PHD2 conventions.
// The image and star array are the live instances used by the guider for this frame; treat them as
// read-only and do not retain them across frames.
export interface GuideFrameImage {
	// Monotonic frame counter, identical to the Frame field of the GuideStep, StarLost, and
	// LoopingExposures events emitted for the same exposure, so the UI can correlate both streams.
	readonly frameId: number
	// Frame timestamp in milliseconds since the Unix epoch, shared with the GuideFrame given to the
	// calibrator/guider.
	readonly timestamp: number
	// PHD2 application state after this frame was processed, useful to color or label the view.
	readonly state: PHD2AppState
	// Decoded guide image. Pixel data lives in `image.raw`; dimensions and channel layout are in
	// `image.metadata`.
	readonly image: Image
	// Every star detected in the frame, before the guider quality thresholds. The star nearest to the
	// current search position, when there is one inside the search region, is moved to index 0.
	readonly stars: readonly GuideStar[]
	// Subset of `stars` accepted by the quality filter of whichever state machine consumed this frame,
	// the guider while guiding or the calibrator while calibrating, so the UI can dim the detections
	// that were ignored. Undefined when the frame reached neither, that is while merely looping.
	readonly acceptedStars?: readonly GuideStar[]
	// Star this frame reported as the guide star, that is `stars[0]`, the same source of the StarMass,
	// SNR, and HFD fields of the emitted event. Undefined when no star was detected or the nearest
	// star to the search position lies outside the search region. It is not necessarily present in
	// `acceptedStars`: a rejected star still drives the reported photometry.
	readonly star?: GuideStar
	// Current guide target in pixels, that is where the guide star is being held. This is the lock
	// position including the accumulated dither and lock-shift offsets. Undefined before a lock exists.
	readonly lockPosition?: readonly [number, number]
	// Center of the star-search window in pixels. Equal to `lockPosition` in the usual case, but it
	// follows the measured centroid instead of the target when Sticky Lock Position or an exact lock
	// position is active.
	readonly searchPosition?: readonly [number, number]
	// Side of the square star-search window in pixels, for drawing the selection box.
	readonly searchRegion: number
}

// Construction options for a GuiderClient.
export interface GuiderClientOptions {
	// Optional event handler receiving PHD2-shaped notifications.
	readonly handler?: GuiderClientHandler
	// Whether to reverse DEC output after flipping the calibration on a meridian flip.
	readonly reverseDecOutputAfterMeridianFlip?: boolean
	// Star-image search-region side, in pixels (clamped to [16, 128]).
	readonly searchRegion?: number
	// Whether to preserve the exact lock position across guider re-initialization.
	readonly stickyLockPosition?: boolean
	// Dither pattern used by dither().
	readonly ditherMode?: DitherMode
	// Overrides for the calibration state machine, merged over DEFAULT_GUIDING_CALIBRATOR_CONFIG. Pulse
	// durations are milliseconds and distances are pixels; an invalid combination throws at
	// construction. Mounts with a fast guide rate usually only need shorter raPulse/decPulse.
	readonly calibrator?: Partial<GuidingCalibrationConfig>
}

// Optics parameters supplied at connect time to derive the guider pixel scale.
export interface GuiderClientConnectOptions {
	readonly focalLength?: number // Optical focal length in mm; takes precedence over aperture-derived focal length.
	readonly aperture?: number // Optical aperture in mm, used together with focalRatio when focalLength is unavailable.
	readonly focalRatio?: number // Dimensionless focal ratio, used together with aperture when focalLength is unavailable.
	readonly pixelSize?: number // Unbinned guider pixel size in um; camera metadata is used when omitted.
}

// Callbacks for observing client activity.
export interface GuiderClientHandler {
	// Invoked for every emitted PHD2-shaped event.
	readonly event?: (client: GuiderClient, event: PHD2Events) => void
	// Invoked once per successfully decoded exposure, after the frame has been processed and after the
	// PHD2 events for that frame were emitted. Not called when the BLOB fails to decode. Exceptions
	// thrown here are caught and logged so a failing UI cannot break the exposure loop.
	readonly frame?: (client: GuiderClient, frame: GuideFrameImage) => void
}

// GuiderClient adapts local INDI camera/guide-output devices to a PHD2-like API.
export class GuiderClient {
	#connected = false
	#camera?: Camera
	#guideOutput?: GuideOutput
	readonly #calibrator: GuidingCalibrator
	#calibration?: GuidingCalibrationResult
	#frame?: GuideFrame
	#image?: Image
	#frameId = 0
	#processingBlob = false
	// True after `#beginExposure` until the matching BLOB is accepted or capture stops. The missing-
	// BLOB watchdog is not armed from Stopped, so this is what prevents a second CCD_EXPOSURE while
	// that one-shot start is still outstanding.
	#awaitingBlob = false
	// Monotonic ownership token for camera starts. A watchdog may replace only the attempt that armed
	// it, because synchronous Alert handlers can stop and restart capture before the callback resumes.
	#exposureAttempt = 0
	// Retriggers a dropped INDI exposure so a missing BLOB cannot stall the loop until the user
	// notices. Armed when an exposure is started; cleared when that BLOB is accepted or capture stops.
	#exposureWatchdog?: ReturnType<typeof setTimeout>
	// After a missing-BLOB retry, the next BLOB may be the timed-out original rather than the
	// replacement. `drop-next` discards that BLOB without queueing so it cannot start a second
	// capture chain, regardless of how late the original transfer is. `already-dropped` means the
	// stale original was consumed: later retries in the same miss cluster must accept their BLOB or
	// a true miss can never recover. `accept` is the idle state.
	#blobAdmission: 'accept' | 'drop-next' | 'already-dropped' = 'accept'
	// Longest pulse successfully sent while processing the current BLOB, in milliseconds. `#processFrame`
	// returns the max of both axes only after the second `pulse()` returns, so a throw on DEC would
	// otherwise leave `pulseDelay` at 0 and start the next exposure while RA is still moving.
	#pulseMsIssued = 0
	#lockPosition?: readonly [number, number]
	#lockSearchPosition?: readonly [number, number]
	#exactLockPosition = false
	#stickyLockPosition = false
	#appState: PHD2AppState = 'Stopped'
	#resumeState: PHD2AppState = 'Stopped'
	#guidingStartTime = 0
	#avgDistance = 0
	#avgDistanceNeedReset = true
	#declinationGuideMode: PHD2DeclinationGuideMode = 'Auto'
	#exposure = DEFAULT_GUIDER_EXPOSURE
	// Duration of the currently outstanding camera capture, in milliseconds. `setExposure` may
	// change `#exposure` while a BLOB is still in flight; the arriving frame must keep the cadence
	// that actually produced its pixels so gain scaling and dropped-frame checks stay consistent.
	#inFlightExposureMs = DEFAULT_GUIDER_EXPOSURE
	// Constructed after #exposure: #makeGuider reads the cadence so the uncalibrated guider matches
	// the default loop instead of Guider's own 1000 ms default (which happens to be the same today).
	#guider = this.#makeGuider(undefined)
	#guideOutputEnabled = true
	#guidingAssistant?: GuidingAssistant
	#guidingAssistantPendingPulse?: CalibrationPulseCommand
	#guidingAssistantResult?: GuidingAssistantResult
	#guidingAssistantSuppressingGuideOutput = false
	#paused = false
	#fullPause = true
	#settling = false
	#settle: PHD2Settle = { ...DEFAULT_PHD2_SETTLE }
	#settleStartTime = 0
	#settleStableSince = 0
	#settleFrameCount = 0
	#settleDroppedFrameCount = 0
	// Constructed in the constructor body, not as a field initializer: field initializers run before the
	// constructor body, so the initial mode from options would be lost.
	readonly #dither: DitherGenerator
	#ditherOffsetX = 0
	#ditherOffsetY = 0
	#lockShiftOffsetX = 0
	#lockShiftOffsetY = 0
	#lockShiftTimestamp = 0
	#lockShiftLimitReached = false
	#focalLength = 0
	#pixelSize = 0
	// Stars accepted by the guider or calibrator quality filter on the frame currently being
	// processed. Cleared at the start of every BLOB so a frame that never reaches either state
	// machine — plain looping, decode failure — cannot publish the star list of an older frame.
	#acceptedStars?: readonly GuideStar[]
	// True when a lock/search position exists and no detection falls inside the PHD2 search box.
	// The published frame still carries every detection so multi-star and the overlay can use
	// them; the calibrator/guider receive an empty star list so they report the primary lost.
	#primaryOutsideSearchRegion = false
	readonly #searchRegion: number
	readonly #lockShiftParams = { ...DEFAULT_LOCK_SHIFT_PARAMS }
	readonly #eventHandler?: GuiderClientHandler['event']
	readonly #frameHandler?: GuiderClientHandler['frame']

	readonly #cameraHandler: DeviceHandler<Camera> = {
		// Ignores manager-level add callbacks because connect binds one camera explicitly.
		added: () => {},
		// Stops an in-flight capture when the bound camera drops its live connected flag without
		// going through GuiderClient.disconnect(), so a leftover watchdog cannot retry against it.
		updated: (device, property) => {
			if (device !== this.#camera || property !== 'connected' || device.connected === true) return
			this.stopCapture()
		},
		// The bound camera was removed from the manager; terminate capture the same way.
		removed: (device) => {
			if (device !== this.#camera) return
			this.stopCapture()
		},
		// Decodes each camera frame asynchronously and feeds the guider state machine.
		blobReceived: (device, data, encoding) => {
			void this.#processBlob(device, data, encoding)
		},
	}

	// Creates a guider client bound to camera and guide-output managers.
	constructor(
		readonly cameraManager: CameraManager,
		readonly guideOutputManager: GuideOutputManager,
		readonly options?: GuiderClientOptions,
	) {
		this.#calibrator = new GuidingCalibrator(options?.calibrator)
		this.#searchRegion = clamp(options?.searchRegion || DEFAULT_SEARCH_REGION, 16, 128)
		this.#stickyLockPosition = options?.stickyLockPosition === true
		this.#dither = new DitherGenerator({ mode: options?.ditherMode })
		this.#eventHandler = options?.handler?.event
		this.#frameHandler = options?.handler?.frame
	}

	get camera() {
		return this.#camera
	}

	get guideOutput() {
		return this.#guideOutput
	}

	attachHandler() {
		this.cameraManager.addHandler(this.#cameraHandler)
	}

	detachHandler() {
		this.cameraManager.removeHandler(this.#cameraHandler)
	}

	// Binds the active camera and guide output, enables image BLOBs, and starts listening.
	connect(camera: Camera, guideOutput: GuideOutput, options?: GuiderClientConnectOptions) {
		if (this.#connected) return false

		this.#camera = camera
		this.#guideOutput = guideOutput
		this.#focalLength = resolveFocalLength(options)
		this.#pixelSize = resolveConfiguredPixelSize(options)
		this.#connected = true
		this.attachHandler()
		this.cameraManager.enableBlob(camera)
		this.#resetRuntimeState(true)
		// PHD2 greets a newly connected client with Version followed by the current AppState. AppState
		// is only sent here: afterwards clients track state through the individual lifecycle events.
		this.emitEvent('Version', { PHDVersion: PHD2_VERSION, PHDSubver: PHD2_SUBVER, MsgVersion: PHD2_MSG_VERSION, OverlapSupport: PHD2_OVERLAP_SUPPORT })
		this.emitEvent('AppState', { State: this.#appState })
		this.emitEvent('ConfigurationChange')

		return true
	}

	// Stops capture, detaches device handlers, and clears the active session.
	disconnect() {
		if (!this.#connected) return false

		const camera = this.#camera
		const hadGuidingAssistant = this.#guidingAssistant !== undefined

		if (hadGuidingAssistant) {
			this.#finishGuidingAssistant(false, 'device disconnected', this.#guidingAssistant?.measuringBacklash === true)
		}

		this.#connected = false
		this.#clearExposureWatchdog()
		this.detachHandler()

		if (camera !== undefined) {
			this.cameraManager.stopExposure(camera)
			this.cameraManager.disableBlob(camera)
		}

		this.#camera = undefined
		this.#guideOutput = undefined
		this.#focalLength = 0
		this.#pixelSize = 0
		this.#abortSettling('device disconnected')
		this.#resetRuntimeState(true, hadGuidingAssistant)
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
		this.#exactLockPosition = false
		this.emitEvent('StarSelected', { X: selected.x, Y: selected.y })
		this.emitEvent('LockPositionSet', { X: selected.x, Y: selected.y })

		if (this.#appState === 'Stopped' || this.#appState === 'Looping') {
			this.#setAppState('Selected')
		}

		return this.#lockPosition
	}

	// Starts one exposure (in milliseconds) and stores it as the default cadence for looping/guiding.
	// A second start while an exposure is already outstanding is a no-op: overlapping CCD_EXPOSURE
	// commands race the camera and reset BLOB admission, so loop() then guide() would fork the
	// capture chain. The missing-BLOB watchdog is the only path allowed to start a replacement,
	// and it calls `#beginExposure` directly.
	startExposureLoop(exposure: number) {
		if (exposure > 0 && Number.isFinite(exposure)) {
			this.#exposure = exposure
			this.#guider.setNominalCadence(exposure)
		}

		if (this.#camera === undefined || this.#camera.connected !== true) return false
		if (this.#exposureInFlight) return true

		this.#blobAdmission = 'accept'
		this.#beginExposure()
		return true
	}

	// Stops camera exposure and clears active guiding/looping state.
	stopCapture() {
		if (this.#appState === 'Stopped') return true

		if (this.#guidingAssistant !== undefined) {
			this.#finishGuidingAssistant(false, 'capture stopped', this.#guidingAssistant.measuringBacklash)
		}

		this.#abortSettling('capture stopped')
		this.#emitCaptureStoppedEvent()
		this.#blobAdmission = 'accept'
		this.#awaitingBlob = false
		this.#clearExposureWatchdog()

		if (this.#camera !== undefined) {
			this.cameraManager.stopExposure(this.#camera)
		}

		this.#paused = false
		this.#fullPause = true
		this.#lockShiftTimestamp = 0
		this.#lockShiftLimitReached = false
		this.#guidingStartTime = 0
		this.#avgDistance = 0
		this.#avgDistanceNeedReset = true
		this.#resumeState = 'Stopped'
		this.#setAppState('Stopped')

		this.#guider.stopDither()

		return true
	}

	// Clears the solved calibration and resets the guider/calibrator state machines.
	clearCalibration() {
		this.#abortGuidingAssistantForTransition('calibration cleared')

		this.#calibration = undefined
		this.#calibrator.reset()
		this.#guider = this.#makeGuider(undefined)
		this.#ditherOffsetX = 0
		this.#ditherOffsetY = 0
		this.#dither.reset()
		this.#lockShiftOffsetX = 0
		this.#lockShiftOffsetY = 0
		this.#lockShiftTimestamp = 0
		this.#lockShiftLimitReached = false
		this.#abortSettling('calibration cleared')
		this.emitEvent('ConfigurationChange')

		if (this.#appState === 'Calibrating' || this.#appState === 'Guiding' || this.#appState === 'LostLock' || this.#appState === 'Paused') {
			this.#resumeState = this.#lockPosition === undefined ? 'Looping' : 'Selected'
			if (!this.#paused) this.#setAppState(this.#resumeState)
		}
	}

	// Drops the preferred lock position and returns to plain looping if capture is still active.
	deselectStar() {
		this.#abortGuidingAssistantForTransition('guide star deselected')

		this.#lockPosition = undefined
		this.#lockSearchPosition = undefined
		this.#exactLockPosition = false
		this.#ditherOffsetX = 0
		this.#ditherOffsetY = 0
		this.#dither.reset()
		this.#lockShiftOffsetX = 0
		this.#lockShiftOffsetY = 0
		this.#lockShiftTimestamp = 0
		this.#lockShiftLimitReached = false
		this.#abortSettling('guide star deselected')
		this.#guider.reset()
		this.#guider.stopDither()

		if (this.#appState !== 'Stopped') {
			this.#resumeState = 'Looping'
			if (!this.#paused) this.#setAppState('Looping')
		}
	}

	// Applies a random image-space dither and tracks local settle status.
	dither(amount: number, raOnly: boolean = false, settle?: Partial<PHD2Settle>) {
		if (this.#guidingAssistant !== undefined || this.#calibration === undefined || this.#guider.currentState.state !== 'guiding' || amount <= 0 || !Number.isFinite(amount)) return false

		const { referenceX, referenceY } = this.#guider.currentState
		const offset = this.#dither.next(amount, raOnly)
		const [dx, dy] = ditherImageOffset(this.#calibration, offset.rightAscension, offset.declination)

		this.#ditherOffsetX += dx
		this.#ditherOffsetY += dy
		this.#syncGuideTargetOffset()
		this.#guider.setDithering(true)
		this.#lockPosition = [referenceX + this.#ditherOffsetX + this.#lockShiftOffsetX, referenceY + this.#ditherOffsetY + this.#lockShiftOffsetY] as const
		this.#settle = { ...DEFAULT_PHD2_SETTLE, ...settle }
		this.#settling = true
		this.#settleStartTime = 0
		this.#settleStableSince = 0
		this.#settleFrameCount = 0
		this.#settleDroppedFrameCount = 0

		// The lock target jumped, so the smoothed distance is reseeded from the next measured frame
		// instead of decaying from the pre-dither error.
		this.#avgDistanceNeedReset = true

		this.emitEvent('GuidingDithered', { dx, dy })
		this.emitEvent('SettleBegin')

		return true
	}

	// Flips the solved calibration for a meridian flip and applies the transformed axis parity to the
	// running guider so lock, hysteresis, and dither survive the flip.
	flipCalibration() {
		if (this.#calibration === undefined || this.#appState === 'Calibrating') return false

		this.#calibration = flipGuidingCalibration(this.#calibration, this.options?.reverseDecOutputAfterMeridianFlip === true)
		this.#applyCalibrationToGuider(this.#calibration)
		this.#syncGuideTargetOffset()
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

	// Returns the requested exposure cadence in milliseconds. INDI CCD_EXPOSURE counts down remaining
	// time, so the live camera value is not the commanded loop period.
	getExposure() {
		return this.#exposure
	}

	// Returns whether pulse output is enabled.
	getGuideOutputEnabled() {
		return this.#guideOutputEnabled
	}

	// Starts a PHD2-style guiding assistant run while ordinary guide output is disabled.
	startGuidingAssistant(config: Partial<GuidingAssistantConfig> = {}) {
		const appState = this.#appState === 'Paused' && !this.#fullPause ? this.#resumeState : this.#appState
		const guiderState = this.#guider.currentState

		if (this.#guidingAssistant !== undefined || this.#settling || guiderState.state !== 'guiding' || (appState !== 'Guiding' && appState !== 'LostLock')) return false

		const imageScale = this.getPixelScale()
		const assistant = new GuidingAssistant({
			imageScale: imageScale > 0 ? imageScale : undefined,
			exposure: this.getExposure(),
			multiStar: this.#guider.config.mode === 'multi-star',
			suspectCalibration: this.#calibration === undefined,
			decPositiveDirection: this.#calibration?.dec.direction ?? 'NORTH',
			...config,
		})

		this.#guidingAssistant = assistant
		this.#guidingAssistantSuppressingGuideOutput = true
		this.#guidingAssistantResult = assistant.start()
		this.emitEvent('GuidingAssistantStarted', { Result: this.#guidingAssistantResult })

		return true
	}

	// Stops the guiding assistant or starts the optional DEC backlash phase before completing.
	stopGuidingAssistant() {
		const assistant = this.#guidingAssistant
		if (assistant === undefined) return undefined

		if (assistant.measuringBacklash) return this.#finishGuidingAssistant(false, 'backlash test aborted', true)

		if (assistant.canMeasureBacklash && this.#guideOutputEnabled && !this.#paused) {
			const step = assistant.startBacklashTest()
			this.#guidingAssistantResult = step.result
			this.#guidingAssistantPendingPulse = step.pulse
			this.emitEvent('GuidingAssistantUpdated', { Result: step.result })
			return step.result
		}

		return this.#finishGuidingAssistant(true)
	}

	// Returns the latest guiding assistant result snapshot, if a run has produced one.
	guidingAssistantResult() {
		return this.#guidingAssistantResult
	}

	// Returns the current lock target if one has been selected or acquired.
	getLockPosition() {
		return this.#lockPosition
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
		return pixelSize <= 0 ? 0 : pixelScale(pixelSize, this.#focalLength)
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
	// A guide request issued while already guiding, including while paused in Guiding or LostLock,
	// does not restart the session: like PHD2, it only begins a new settle cycle, so the accumulated
	// dither and lock-shift target offsets survive.
	guide(recalibrate: boolean = false, settle?: Partial<PHD2Settle>) {
		if (!this.getConnected() || this.#camera === undefined || this.#guideOutput === undefined || !this.#guideOutput.canPulseGuide) return false

		const sessionState = this.#paused ? this.#resumeState : this.#appState

		if (!recalibrate && this.#calibration !== undefined && (sessionState === 'Guiding' || sessionState === 'LostLock')) {
			this.#settle = { ...DEFAULT_PHD2_SETTLE, ...settle }
			this.#settling = true
			this.#settleStartTime = 0
			this.#settleStableSince = 0
			this.#settleFrameCount = 0
			this.#settleDroppedFrameCount = 0
			this.emitEvent('SettleBegin')
			if (this.#paused) this.setPaused(false)

			return true
		}

		this.#abortGuidingAssistantForTransition('guiding restarted')

		// PHD2 auto-selects a guide star when a guide request arrives with nothing selected. This is a
		// no-op until a frame has been decoded, matching PHD2's behavior of guiding on the star found
		// in the frames that follow.
		if (this.#lockPosition === undefined) this.findStar()

		this.#paused = false
		this.#fullPause = true
		this.#resumeState = 'Guiding'
		this.#settle = { ...DEFAULT_PHD2_SETTLE, ...settle }
		this.#settling = true
		this.#settleStartTime = 0
		this.#settleStableSince = 0
		this.#settleFrameCount = 0
		this.#settleDroppedFrameCount = 0
		this.#lockShiftTimestamp = 0
		this.#lockShiftLimitReached = false
		// Drop any dither/lock-shift target offset from a prior session so a fresh guiding run does
		// not inherit a stale constant offset once lock-shift is later applied.
		this.#ditherOffsetX = 0
		this.#ditherOffsetY = 0
		this.#dither.reset()
		this.#lockShiftOffsetX = 0
		this.#lockShiftOffsetY = 0
		this.emitEvent('SettleBegin')

		if (recalibrate || this.#calibration === undefined) {
			if (recalibrate) this.#calibration = undefined
			this.#calibrator.reset()
			this.emitEvent('StartCalibration', { Mount: this.#guideOutput.name })
			this.#setAppState('Calibrating')
		} else {
			this.#guider = this.#makeGuider(this.#calibration)
			this.#guidingStartTime = Date.now()
			this.#avgDistanceNeedReset = true
			this.emitEvent('StartGuiding')
			this.#setAppState('Guiding')
		}

		this.startExposureLoop(this.#exposure)

		return true
	}

	// Sends a direct single-axis pulse through the active guide output.
	guidePulse(amount: number, direction: PHD2GuideDirection) {
		if (this.#guideOutput === undefined || !this.#guideOutputActive || amount <= 0 || !Number.isFinite(amount)) return false

		this.guideOutputManager.pulse(this.#guideOutput, direction.toUpperCase() as GuideDirection, Math.max(1, Math.round(amount)))

		return true
	}

	// Starts continuous exposure looping without issuing guide pulses.
	loop() {
		if (!this.#connected || this.#camera === undefined || this.#camera.connected !== true) return false

		this.#abortGuidingAssistantForTransition('looping started')
		this.#paused = false
		this.#fullPause = true
		this.#resumeState = 'Looping'
		this.#abortSettling('looping started')
		this.#lockShiftTimestamp = 0
		this.#lockShiftLimitReached = false
		// Drop any dither/lock-shift target offset from a prior session so it cannot carry over into
		// a subsequent guiding run. Restore the public lock to the guider reference; otherwise
		// getLockPosition would keep advertising the dithered target after the offset is gone.
		const hadTargetOffset = this.#ditherOffsetX !== 0 || this.#ditherOffsetY !== 0 || this.#lockShiftOffsetX !== 0 || this.#lockShiftOffsetY !== 0
		this.#ditherOffsetX = 0
		this.#ditherOffsetY = 0
		this.#dither.reset()
		this.#lockShiftOffsetX = 0
		this.#lockShiftOffsetY = 0
		this.#guider.stopDither()
		if (hadTargetOffset && (this.#appState === 'Guiding' || this.#appState === 'LostLock' || this.#appState === 'Paused')) {
			const { referenceX, referenceY } = this.#guider.currentState
			if (Number.isFinite(referenceX) && Number.isFinite(referenceY)) {
				this.#lockPosition = [referenceX, referenceY] as const
				if (!this.#fixedLockReferenceEnabled) this.#lockSearchPosition = this.#lockPosition
			}
		}
		this.#setAppState(this.#lockPosition === undefined ? 'Looping' : 'Selected')
		this.startExposureLoop(this.#exposure)

		return true
	}

	// Updates the DEC guide mode on the running guider without dropping lock or hysteresis.
	setDeclinationGuideMode(mode: PHD2DeclinationGuideMode) {
		this.#declinationGuideMode = mode
		if (this.#appState !== 'Calibrating') this.#guider.setDecMode(toDeclinationGuideMode(mode))
		this.emitEvent('GuideParamChange', { Name: 'DecGuideMode', Value: mode })
		this.emitEvent('ConfigurationChange')
	}

	// Stores the default exposure cadence for subsequent captures.
	setExposure(exposure: number) {
		if (exposure <= 0 || !Number.isFinite(exposure)) return false
		this.#exposure = exposure
		this.#guider.setNominalCadence(exposure)
		this.emitEvent('GuideParamChange', { Name: 'Exposure', Value: exposure })
		this.emitEvent('ConfigurationChange')
		return true
	}

	// Enables or disables guide pulses while keeping frame processing active.
	setGuideOutputEnabled(enabled: boolean) {
		this.#guideOutputEnabled = enabled
		if (!enabled && this.#guidingAssistant?.measuringBacklash === true) this.#finishGuidingAssistant(false, 'guide output disabled', true)
		this.emitEvent('GuideParamChange', { Name: 'GuideOutputEnabled', Value: enabled })
		this.emitEvent('ConfigurationChange')
	}

	// Stores the requested lock target and relocks to the nearest detected star unless exact matching is requested.
	setLockPosition(x: number, y: number, exact: boolean = false) {
		if (!Number.isFinite(x) || !Number.isFinite(y)) return false

		this.#abortGuidingAssistantForTransition('lock position changed')

		if (this.#frame !== undefined && this.#frame.stars.length > 0) {
			const nearest = nearestGuideStar(this.#frame.stars, x, y)
			this.#lockSearchPosition = nearest === undefined ? ([x, y] as const) : ([nearest.x, nearest.y] as const)
		} else {
			this.#lockSearchPosition = [x, y] as const
		}

		this.#lockPosition = exact ? ([x, y] as const) : this.#lockSearchPosition
		this.#exactLockPosition = exact

		const [lockX, lockY] = this.#lockPosition
		this.#ditherOffsetX = 0
		this.#ditherOffsetY = 0
		this.#dither.reset()
		this.#lockShiftOffsetX = 0
		this.#lockShiftOffsetY = 0
		this.#lockShiftTimestamp = 0
		this.#lockShiftLimitReached = false
		this.#avgDistanceNeedReset = true
		this.emitEvent('LockPositionSet', { X: lockX, Y: lockY })

		if (this.#appState === 'Guiding' || this.#appState === 'LostLock' || this.#appState === 'Paused') {
			this.#guider = this.#makeGuider(this.#calibration)
			this.#resumeState = 'Guiding'
			if (!this.#paused) this.#setAppState('Guiding')
		} else if (this.#appState !== 'Stopped') {
			this.#resumeState = 'Selected'
			if (!this.#paused) this.#setAppState('Selected')
		}

		return true
	}

	// Returns the configured dither pattern used by dither().
	getDitherMode() {
		return this.#dither.mode
	}

	// Selects the dither pattern (PHD2 random or spiral) and restarts the spiral generator.
	setDitherMode(mode: DitherMode) {
		this.#dither.setMode(mode)
		this.emitEvent('GuideParamChange', { Name: 'DitherMode', Value: mode })
		this.emitEvent('ConfigurationChange')
	}

	// Enables or disables preserving the current lock target across guider initialization.
	setStickyLockPositionEnabled(enabled: boolean) {
		this.#stickyLockPosition = enabled

		if (!enabled && !this.#exactLockPosition && this.#lockSearchPosition !== undefined) {
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

		// Reject non-finite drift rates so they cannot accumulate NaN into the lock position and
		// leak into getLockPosition or the emitted lock-shift events.
		if (rate !== undefined && (!Number.isFinite(rate[0]) || !Number.isFinite(rate[1]))) {
			return false
		}

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
	// PHD2 reports Paused and Resumed on the pause transition only, so a redundant call is silent.
	setPaused(paused: boolean, full: boolean = true) {
		const wasPaused = this.#paused

		if (paused) {
			if (!wasPaused) this.#resumeState = this.#appState === 'Paused' ? this.#resumeState : this.#appState
			this.#paused = true
			this.#fullPause = full || this.#resumeState === 'Calibrating'
			this.#lockShiftTimestamp = 0
			if (!wasPaused) this.emitEvent('Paused')
			if (this.#guidingAssistant?.measuringBacklash === true) this.#finishGuidingAssistant(false, 'backlash test paused', true)
			this.#setAppState('Paused')
			if (this.#fullPause) {
				this.#blobAdmission = 'accept'
				this.#awaitingBlob = false
				this.#clearExposureWatchdog()
				if (this.#camera !== undefined) this.cameraManager.stopExposure(this.#camera)
			}
			return true
		}

		const resumeCapture = wasPaused && this.#fullPause
		this.#paused = false
		this.#fullPause = true
		this.#lockShiftTimestamp = 0
		if (wasPaused) this.emitEvent('Resumed')
		this.#setAppState(this.#resumeState === 'Paused' ? 'Looping' : this.#resumeState)

		// A partial pause left the current exposure running. Restarting capture here, including from
		// guide() resuming a paused Guiding session, would send a second start before that BLOB
		// arrives and can restart a busy camera or fork the loop.
		if (resumeCapture && this.#appState !== 'Stopped' && this.#camera !== undefined) {
			this.startExposureLoop(this.#exposure)
		}

		return true
	}

	// Parses a received camera BLOB, runs guider state updates, and schedules the next exposure.
	async #processBlob(device: Camera, data: Buffer, encoding: BlobEncoding): Promise<void> {
		if (!this.#connected || device !== this.#camera) return

		// A BLOB that arrives after a missing-BLOB retry may be the timed-out original. The
		// replacement is already outstanding, so accepting it would process a stale frame and
		// `finally` would start a second capture chain beside the retry. INDI BLOBs have no
		// generation id; drop the next BLOB once, then accept later retries in this miss cluster. A
		// later accepted BLOB is still ambiguous, so abort the outstanding replacement before it can
		// be joined by the next exposure and quarantine any BLOB that the abort may deliver late.
		if (this.#blobAdmission === 'drop-next') {
			this.#blobAdmission = 'already-dropped'
			return
		}

		if (this.#blobAdmission === 'already-dropped') {
			this.#blobAdmission = 'drop-next'
			this.cameraManager.stopExposure(device)
		} else {
			this.#blobAdmission = 'accept'
		}

		// The calibrator and guider are stateful and not reentrant, so a BLOB that arrives while a
		// previous frame is still being decoded/processed is dropped to avoid interleaved mutation.
		if (this.#processingBlob) return
		this.#processingBlob = true
		this.#awaitingBlob = false
		this.#acceptedStars = undefined
		this.#primaryOutsideSearchRegion = false
		// Drop the missing-BLOB timer as soon as this exposure is in hand. Leaving it armed until
		// the next startExposure lets a slow decode or pulse wait trip a false timeout and start an
		// overlapping exposure.
		this.#clearExposureWatchdog()

		let pulseDelay = 0
		this.#pulseMsIssued = 0

		try {
			let image: Image | undefined

			try {
				if (encoding === 'base64') {
					image = await readImageFromSource(base64Source(bufferSource(data)))
				} else {
					image = await readImageFromBuffer(data)
				}
			} catch (e) {
				console.error('guide image decode failed:', e)
			}

			// Clear the cached image on a failed decode so getStarImage cannot return stale pixels
			// tagged with the new (empty) frame id instead of the last successfully decoded frame.
			this.#image = image

			const frame = this.#makeGuideFrame(image)
			this.#frame = frame

			try {
				pulseDelay = this.#processFrame(frame)

				// Published only for a decoded frame, and only after processing, so the UI sees the same
				// state the events for this frame already reported. It runs before the pulse delay so the
				// view is not held back by the settle wait.
				if (image !== undefined) this.#emitFrameImage(frame, image)
			} catch (e) {
				// A pulse or controller throw must not kill the exposure loop: the next frame is still
				// queued below so guiding recovers instead of hanging until the user restarts.
				console.error('guide frame processing failed:', e)
				this.emitEvent('Alert', { Msg: `guide frame processing failed: ${errorMessage(e)}`, Type: 'error' })
			}
		} catch (e) {
			console.error('guide frame processing failed:', e)
			this.emitEvent('Alert', { Msg: `guide frame processing failed: ${errorMessage(e)}`, Type: 'error' })
		} finally {
			try {
				await this.#queueNextExposure(Math.max(pulseDelay, this.#pulseMsIssued))
			} catch (e) {
				console.error('guide exposure queue failed:', e)
			}

			this.#processingBlob = false
		}
	}

	// Converts a decoded image into a guide frame and prioritizes the selected lock star.
	#makeGuideFrame(image?: Image): GuideFrame {
		const detections = image === undefined ? [] : detectStars(image)
		const lockSearchPosition = this.#lockSearchPosition ?? this.#lockPosition
		let stars = detections

		if (lockSearchPosition !== undefined && detections.length > 0) {
			const primary = nearestGuideStarInSearchRegion(detections, lockSearchPosition, this.#searchRegion)
			if (primary !== undefined) {
				// PHD2 only acquires the primary inside the search box. Neighbors elsewhere must stay
				// in the list: the default multi-star estimator matches them against the full-frame
				// reference, and GuideFrameImage.stars is every detection. The globally nearest star
				// can sit just outside an edge while a farther detection is still inside a corner.
				stars = detections.slice()
				moveGuideStarToFront(stars, primary)
			} else {
				this.#primaryOutsideSearchRegion = true
			}
		}

		return {
			stars,
			width: image?.metadata.width ?? this.#camera?.frame.width.value ?? 0,
			height: image?.metadata.height ?? this.#camera?.frame.height.value ?? 0,
			timestamp: Date.now(),
			frameId: ++this.#frameId,
			cadenceMs: this.#inFlightExposureMs,
			searchPosition: lockSearchPosition,
			searchRegion: lockSearchPosition === undefined ? undefined : this.#searchRegion,
		}
	}

	// Publishes the decoded frame and its overlay geometry to the frame handler. Called after the
	// frame has been processed so the lock target, the tracked star, and the app state already
	// reflect this exposure instead of the previous one. Handler failures are contained here because
	// this runs inside the exposure loop.
	#emitFrameImage(frame: GuideFrame, image: Image) {
		if (this.#frameHandler === undefined) return

		try {
			this.#frameHandler(this, {
				frameId: frame.frameId ?? 0,
				timestamp: frame.timestamp ?? Date.now(),
				state: this.#appState,
				image,
				stars: frame.stars,
				acceptedStars: this.#acceptedStars,
				star: this.#primaryOutsideSearchRegion ? undefined : frame.stars[0],
				lockPosition: this.#lockPosition,
				searchPosition: this.#lockSearchPosition ?? this.#lockPosition,
				searchRegion: this.#searchRegion,
			})
		} catch (e) {
			console.error('guide frame handler failed:', e)
		}
	}

	// Routes the current frame to calibration, guiding, or passive looping.
	#processFrame(frame: GuideFrame) {
		const appState = this.#appState === 'Paused' && !this.#fullPause ? this.#resumeState : this.#appState
		const input = this.#primaryOutsideSearchRegion ? { ...frame, stars: [] } : frame

		if (appState === 'Calibrating') return this.#processCalibrationFrame(input)
		if (appState === 'Guiding' || appState === 'LostLock') return this.#processGuidingFrame(input)
		if (appState === 'Looping' || appState === 'Selected') this.#emitLoopingExposuresEvent(input)

		return 0
	}

	// Advances the calibration state machine and stores the solved matrix when complete.
	#processCalibrationFrame(frame: GuideFrame) {
		const step = this.#calibrator.processFrame(frame)
		// Retained for #emitFrameImage, which runs after this frame has been fully processed.
		this.#acceptedStars = step.stars

		this.#updateLockPositionFromCalibration(step.diagnostics)
		this.#emitCalibratingEvent(step.diagnostics)

		if (step.failure !== undefined) {
			this.emitEvent('CalibrationFailed', { Reason: step.failure.message })
			// PHD2 raises a user-facing alert alongside the failure so clients without a calibration
			// UI still surface the reason.
			this.emitEvent('Alert', { Msg: `Calibration failed: ${step.failure.message}`, Type: 'error' })

			if (this.#settling) {
				this.#settling = false
				this.#emitSettleDoneEvent(1, step.failure.message)
			}

			this.#resumeState = this.#lockPosition === undefined ? 'Looping' : 'Selected'
			if (!this.#paused) this.#setAppState(this.#resumeState)
			return 0
		}

		if (step.completed !== undefined) {
			this.#calibration = step.completed
			this.#guider = this.#makeGuider(this.#calibration)
			this.#guidingStartTime = Date.now()
			this.#avgDistanceNeedReset = true
			this.emitEvent('CalibrationComplete', { Mount: this.#guideOutput?.name ?? '' })
			this.emitEvent('StartGuiding')
			this.#resumeState = 'Guiding'
			if (!this.#paused) this.#setAppState('Guiding')
			return 0
		}

		return this.#pulseCalibration(step.pulse?.ra.direction, step.pulse?.ra.duration, step.pulse?.dec.direction, step.pulse?.dec.duration)
	}

	// Runs the guide controller, applies settle tracking, and returns the max pulse delay.
	#processGuidingFrame(frame: GuideFrame) {
		const command = this.#guider.processFrame(frame)
		// Retained for #emitFrameImage, which runs after this frame has been fully processed.
		this.#acceptedStars = command.stars
		const timestamp = frame.timestamp ?? Date.now()

		this.#updateLockPositionFromGuider(command.diagnostics.targetX, command.diagnostics.targetY)
		this.#updateLockSearchPositionFromGuider(command.diagnostics.measurementX, command.diagnostics.measurementY)

		if (command.state === 'lost') {
			this.#emitStarLostEvent(frame, command)
			// PHD2 reports StarLost for every dropped frame but LockPositionLost only once, when the
			// lock is actually given up. #resumeState tracks the session state even while paused, so
			// it is the reliable edge test here.
			if (this.#resumeState !== 'LostLock') this.emitEvent('LockPositionLost')
			this.#resumeState = 'LostLock'
			if (!this.#paused) this.#setAppState('LostLock')
			this.#updateSettling(undefined, undefined, true, true, timestamp)
			if (this.#guidingAssistant !== undefined) this.#finishGuidingAssistant(false, 'guide star lost')
			return 0
		}

		this.#emitGuideStepEvent(frame, command, this.#updateAvgDistance(command.diagnostics.dx ?? 0, command.diagnostics.dy ?? 0))
		const assistantDelay = this.#processGuidingAssistantFrame(frame, command)

		this.#resumeState = 'Guiding'
		if (!this.#paused) this.#setAppState('Guiding')

		this.#updateSettling(command.diagnostics.dx, command.diagnostics.dy, command.diagnostics.badFrame, command.diagnostics.lost, timestamp)
		this.#updateLockShift(frame)

		if (assistantDelay !== undefined) return assistantDelay

		return Math.max(this.#pulseAxis(command.ra.direction, command.ra.duration), this.#pulseAxis(command.dec.direction, command.dec.duration))
	}

	// Sends one calibration pulse pair and returns the largest applied delay.
	#pulseCalibration(raDirection?: AxisPulse['direction'], raDuration?: number, decDirection?: AxisPulse['direction'], decDuration?: number, force: boolean = false) {
		return Math.max(this.#pulseAxis(raDirection, raDuration, force), this.#pulseAxis(decDirection, decDuration, force))
	}

	// Sends one axis pulse if guide output is enabled and returns the applied delay.
	#pulseAxis(direction?: AxisPulse['direction'], duration?: number, force: boolean = false) {
		if (this.#guideOutput === undefined || this.#paused || (!force && !this.#guideOutputActive) || direction === undefined || duration === undefined || duration <= 0 || !Number.isFinite(duration)) return 0

		const pulseDuration = Math.max(1, Math.round(duration))
		this.guideOutputManager.pulse(this.#guideOutput, direction.toUpperCase() as GuideDirection, pulseDuration)
		this.#pulseMsIssued = Math.max(this.#pulseMsIssued, pulseDuration)

		return pulseDuration
	}

	// Feeds one guiding frame into the active assistant and applies assistant-owned backlash pulses.
	#processGuidingAssistantFrame(frame: GuideFrame, command: GuideCommand) {
		const assistant = this.#guidingAssistant
		if (assistant === undefined) return undefined

		if (this.#paused && assistant.measuringBacklash) {
			this.#finishGuidingAssistant(false, 'backlash test paused', true)
			return 0
		}

		if (this.#guidingAssistantPendingPulse !== undefined) {
			const pulse = this.#guidingAssistantPendingPulse
			const alignment = assistant.alignBacklashOrigin(frame, command)
			this.#guidingAssistantResult = alignment.result
			this.emitEvent('GuidingAssistantUpdated', { Result: this.#guidingAssistantResult })
			if (!alignment.aligned) return 0
			this.#guidingAssistantPendingPulse = undefined
			return this.#pulseCalibration(pulse.ra.direction, pulse.ra.duration, pulse.dec.direction, pulse.dec.duration, this.#guideOutputEnabled)
		}

		const step = assistant.addSample(frame, command)
		this.#guidingAssistantResult = step.result
		this.emitEvent('GuidingAssistantUpdated', { Result: step.result })

		if (step.pulse !== undefined) {
			return this.#pulseCalibration(step.pulse.ra.direction, step.pulse.ra.duration, step.pulse.dec.direction, step.pulse.dec.duration, this.#guideOutputEnabled)
		}

		if (step.result.status === 'completed') {
			this.#finishGuidingAssistant(true)
		} else if (step.result.status === 'failed') {
			this.#finishGuidingAssistant(false, 'guiding assistant failed')
		}

		return 0
	}

	// Restores guide output and emits the final guiding assistant event.
	#finishGuidingAssistant(completed: boolean, message?: string, abortBacklash: boolean = false) {
		const assistant = this.#guidingAssistant
		if (assistant === undefined) return this.#guidingAssistantResult

		const result = completed ? assistant.complete() : abortBacklash ? assistant.abortBacklash(message) : assistant.fail(message ?? 'guiding assistant failed')
		this.#guidingAssistant = undefined
		this.#guidingAssistantPendingPulse = undefined
		this.#guidingAssistantResult = result
		this.#guidingAssistantSuppressingGuideOutput = false
		this.emitEvent(completed ? 'GuidingAssistantCompleted' : 'GuidingAssistantFailed', { Result: result })

		return result
	}

	// Fails any active guiding assistant before public mode switches that own guide-output state.
	#abortGuidingAssistantForTransition(message: string) {
		if (this.#guidingAssistant !== undefined) this.#finishGuidingAssistant(false, message, this.#guidingAssistant.measuringBacklash)
	}

	// Returns true when ordinary guide pulses are currently allowed to reach the mount.
	get #guideOutputActive() {
		return this.#guideOutputEnabled && !this.#guidingAssistantSuppressingGuideOutput
	}

	// Completes an in-flight settle with an error so PHD2-style waiters are not left hanging when the
	// session leaves the settling path without a natural SettleDone (timeout or in-tolerance).
	#abortSettling(reason: string) {
		if (!this.#settling) return

		this.#settling = false
		this.#settleStartTime = 0
		this.#settleStableSince = 0
		this.#emitSettleDoneEvent(1, reason)
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
			this.#emitSettleDoneEvent(1, 'settle timeout')
			return
		}

		if (badFrame || lost || dx === undefined || dy === undefined) {
			this.#settleStableSince = 0
			this.#settleDroppedFrameCount++
			this.#emitSettlingEvent(0, timestamp, false)
			return
		}

		const distance = Math.hypot(dx, dy)

		if (distance > this.#settle.pixels) {
			this.#settleStableSince = 0
			this.#emitSettlingEvent(distance, timestamp, true)
			return
		}

		if (this.#settleStableSince === 0) {
			this.#settleStableSince = timestamp
			this.#emitSettlingEvent(distance, timestamp, true)
			return
		}

		if (timestamp - this.#settleStableSince >= this.#settle.time * 1000) {
			this.#settling = false
			this.#emitSettleDoneEvent(0)
			return
		}

		this.#emitSettlingEvent(distance, timestamp, true)
	}

	// Refreshes the public lock target from guider diagnostics when available.
	#updateLockPositionFromGuider(targetX: number | undefined, targetY: number | undefined) {
		if (targetX !== undefined && targetY !== undefined) {
			this.#lockPosition = [targetX, targetY] as const
			if (!this.#searchFollowsMeasurement) this.#lockSearchPosition = this.#lockPosition
		}
	}

	// Refreshes the star-search center from the latest measured centroid while the box should stay on
	// the star (sticky/exact lock, or an in-progress dither walking toward a new lock).
	#updateLockSearchPositionFromGuider(measurementX: number | undefined, measurementY: number | undefined) {
		if (this.#searchFollowsMeasurement && measurementX !== undefined && measurementY !== undefined) {
			this.#lockSearchPosition = [measurementX, measurementY] as const
		}
	}

	// Advances the lock-shift offset using elapsed time and the configured X/Y or RA/DEC drift rates.
	#updateLockShift(frame: GuideFrame) {
		const timestamp = frame.timestamp ?? Date.now()

		if (this.#guidingAssistant !== undefined) {
			this.#lockShiftTimestamp = timestamp
			return
		}

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
		if (!this.#searchFollowsMeasurement) this.#lockSearchPosition = this.#lockPosition

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

	// Reapplies the combined manual dither and lock-shift target offset to the guider state without
	// touching the in-progress dither flag. A settled dither and lock-shift both keep a non-zero
	// offset; only `dither()` and settle completion change `ditherActive`.
	#syncGuideTargetOffset() {
		this.#guider.setTargetOffset(this.#ditherOffsetX + this.#lockShiftOffsetX, this.#ditherOffsetY + this.#lockShiftOffsetY)
	}

	// Refreshes the public lock target from calibration diagnostics when available.
	#updateLockPositionFromCalibration(diagnostics: GuidingCalibrationDiagnostics) {
		const x = diagnostics.currentX ?? diagnostics.startX
		const y = diagnostics.currentY ?? diagnostics.startY

		if (x !== undefined && y !== undefined) {
			this.#lockSearchPosition = [x, y] as const
			if (!this.#fixedLockReferenceEnabled) this.#lockPosition = this.#lockSearchPosition
		}
	}

	// Returns true when either Sticky Lock Position or an exact lock request should preserve the reference point.
	get #fixedLockReferenceEnabled() {
		return this.#stickyLockPosition || this.#exactLockPosition
	}

	// Returns true when the search box should stay on the measured star rather than snapping to the
	// lock target. Sticky/exact lock keep the reference fixed; an in-progress dither keeps the box
	// on the star so a jump larger than half the search region can still be walked in with pulses.
	get #searchFollowsMeasurement() {
		return this.#fixedLockReferenceEnabled || this.#guider.currentState.ditherActive
	}

	// Returns the fixed lock reference seed used for the next guider initialization.
	get #guiderReferencePosition() {
		return this.#fixedLockReferenceEnabled ? this.#lockPosition : undefined
	}

	// Returns the current star-acquisition seed used for the next guider initialization.
	get #guiderInitialPosition() {
		return this.#lockSearchPosition
	}

	// Starts another exposure after pulse delay if the current session is still active.
	async #queueNextExposure(delay: number): Promise<void> {
		await this.#waitForPulseToComplete(delay)
		if (!this.#captureActive) return
		this.#beginExposure()
	}

	// Arms a timer that retries the exposure if no BLOB arrives. The timeout is three cadences, with
	// a floor so a sub-second loop still outlasts a slow INDI round-trip.
	#armExposureWatchdog() {
		this.#clearExposureWatchdog()
		if (!this.#captureActive) return

		const timeout = Math.max(3 * this.#exposure, EXPOSURE_WATCHDOG_MIN_MS)
		const attempt = this.#exposureAttempt
		this.#exposureWatchdog = setTimeout(() => {
			this.#onExposureWatchdog(attempt)
		}, timeout)
		this.#exposureWatchdog.unref()
	}

	// Cancels a pending missing-BLOB retry. Accepting the matching BLOB, capture stop, disconnect,
	// and a full pause all call this so a leftover timer cannot start an overlapping exposure.
	#clearExposureWatchdog() {
		if (this.#exposureWatchdog === undefined) return
		clearTimeout(this.#exposureWatchdog)
		this.#exposureWatchdog = undefined
	}

	// Warns, aborts the timed-out camera command, and starts another exposure when no BLOB arrived. The
	// next BLOB is treated as the timed-out original unless this miss cluster already consumed that
	// slot, so a delayed original cannot queue a second capture chain beside the retry. The Alert
	// handler may stop or disconnect synchronously, so the capture state and attempt ownership are
	// rechecked before retrying. `attempt` is the camera start that armed this callback.
	#onExposureWatchdog(attempt: number) {
		this.#exposureWatchdog = undefined
		if (!this.#captureActive || !this.#awaitingBlob || attempt !== this.#exposureAttempt) return

		this.emitEvent('Alert', { Msg: 'guide exposure timed out; retrying', Type: 'warning' })
		if (!this.#captureActive || !this.#awaitingBlob || attempt !== this.#exposureAttempt) return

		if (this.#blobAdmission !== 'already-dropped') this.#blobAdmission = 'drop-next'
		const camera = this.#camera
		if (camera === undefined) return
		this.cameraManager.stopExposure(camera)
		this.#awaitingBlob = false
		this.#beginExposure()
	}

	// Records the cadence of this capture, starts it, and arms the missing-BLOB watchdog.
	// Public `startExposureLoop` from Stopped is allowed, so this checks the live camera
	// connection rather than `#captureActive` (false while Stopped). The watchdog still
	// arms only while capture is active.
	#beginExposure() {
		if (!this.#connected || this.#camera === undefined || this.#camera.connected !== true) return
		this.#exposureAttempt++
		this.#inFlightExposureMs = this.#exposure
		this.#awaitingBlob = true
		this.cameraManager.startExposure(this.#camera, this.#exposure / 1000)
		this.#armExposureWatchdog()
	}

	// True while a guide exposure is outstanding: the matching BLOB is still being processed, or
	// `#beginExposure` has started a capture that has not yet arrived. Public start/loop/guide use
	// this to refuse a second CCD_EXPOSURE; the missing-BLOB watchdog still calls `#beginExposure`
	// directly.
	get #exposureInFlight() {
		return this.#processingBlob || this.#awaitingBlob
	}

	// True when the exposure loop is allowed to start or retry a capture. Full pause, stop, client
	// disconnect, and a live camera that dropped its connected flag all make this false so a leftover
	// timer cannot keep exposing a device that is no longer there.
	get #captureActive() {
		return this.#connected && this.#camera !== undefined && this.#camera.connected === true && this.#appState !== 'Stopped' && !(this.#appState === 'Paused' && this.#fullPause)
	}

	// Waits out the commanded pulse, the INDI Busy acknowledgement, and the later Idle. GuideOutput
	// pulse() only sends the timed-guide vector; `device.pulsing` is updated later by numberVector.
	// The Idle wait is measured from when Busy is observed, not from a single absolute deadline, so a
	// Busy that arrives near the acknowledgement margin still blocks capture until the mount stops.
	async #waitForPulseToComplete(duration: number): Promise<void> {
		if (duration <= 0) return

		const started = performance.now()
		const ackDeadline = started + duration + PULSE_IDLE_MARGIN_MS
		const isBusy = () => this.#guideOutput?.pulsing === true

		while (performance.now() < started + duration) {
			if (isBusy()) break
			const remaining = started + duration - performance.now()
			if (remaining <= 0) break
			await Bun.sleep(Math.min(10, remaining))
		}

		if (!isBusy()) {
			while (!isBusy() && performance.now() < ackDeadline) {
				await Bun.sleep(10)
			}
		}

		if (!isBusy()) return

		const idleDeadline = performance.now() + duration + PULSE_IDLE_MARGIN_MS
		while (isBusy() && performance.now() < idleDeadline) {
			await Bun.sleep(10)
		}
	}

	// Resets transient guider state while optionally dropping calibration.
	#resetRuntimeState(clearCalibration: boolean, preserveGuidingAssistantResult: boolean = false) {
		this.#blobAdmission = 'accept'
		this.#awaitingBlob = false
		this.#clearExposureWatchdog()
		const guidingAssistantResult = preserveGuidingAssistantResult ? this.#guidingAssistantResult : undefined
		this.#frame = undefined
		this.#image = undefined
		this.#acceptedStars = undefined
		this.#primaryOutsideSearchRegion = false
		this.#frameId = 0
		this.#lockPosition = undefined
		this.#lockSearchPosition = undefined
		this.#exactLockPosition = false
		this.#appState = 'Stopped'
		this.#resumeState = 'Stopped'
		this.#guidingStartTime = 0
		this.#avgDistance = 0
		this.#avgDistanceNeedReset = true
		this.#paused = false
		this.#fullPause = true
		this.#guideOutputEnabled = true
		this.#guidingAssistant = undefined
		this.#guidingAssistantPendingPulse = undefined
		this.#guidingAssistantResult = guidingAssistantResult
		this.#guidingAssistantSuppressingGuideOutput = false
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
		this.#dither.reset()
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
		if (calibration === undefined) {
			return new Guider({
				decMode: toDeclinationGuideMode(this.#declinationGuideMode),
				referencePosition: this.#guiderReferencePosition,
				initialPosition: this.#guiderInitialPosition,
				nominalCadence: this.#exposure,
			})
		}

		return new Guider({
			...calibratedGuiderOptions(calibration),
			decMode: toDeclinationGuideMode(this.#declinationGuideMode),
			referencePosition: this.#guiderReferencePosition,
			initialPosition: this.#guiderInitialPosition,
			nominalCadence: this.#exposure,
		})
	}

	// Pushes a solved calibration onto the running guider without reconstructing it, so lock,
	// hysteresis, and dither stay intact.
	#applyCalibrationToGuider(calibration: GuidingCalibrationResult) {
		const options = calibratedGuiderOptions(calibration)
		this.#guider.setCalibration(options.calibration, options)
	}

	// Emits one callback event if the caller provided an event handler.
	emitEvent<T extends keyof PHD2EventMap>(Event: T, data?: Omit<PHD2EventMap[T], 'Event' | 'Timestamp' | 'Host' | 'Inst'>) {
		const event = {
			...data,
			Event,
			Timestamp: Date.now() / 1000,
			Host: '', // The local guider is not a network PHD2 server, so Host defaults to an empty string.
			Inst: 1, // There is no PHD2 instance index in this local client, so Inst defaults to 1-based instance number.
		} as PHD2Events

		try {
			this.#eventHandler?.(this, event)
		} catch (e) {
			// Event callbacks are user code; a throw must not unwind the exposure loop or skip the
			// remaining notifications for this frame.
			console.error('guide event handler failed:', e)
		}
	}

	// Updates the current app state. No event is emitted here on purpose: PHD2 sends AppState only
	// when a client first connects, and clients are expected to track later transitions through the
	// individual lifecycle events. See https://github.com/OpenPHDGuiding/phd2/wiki/EventMonitoring#appstate
	#setAppState(appState: PHD2AppState) {
		this.#appState = appState
	}

	// Emits the capture-stop events that match the current or paused-resume session mode.
	// Guiding implies looping in PHD2, so stopping an active guiding session reports both that
	// guiding ceased and that the exposure loop ceased, in that order.
	#emitCaptureStoppedEvent() {
		const appState = this.#appState === 'Paused' ? this.#resumeState : this.#appState

		if (appState === 'Stopped') return

		if (appState === 'Calibrating' || appState === 'Guiding' || appState === 'LostLock') {
			this.emitEvent('GuidingStopped')
		}

		this.emitEvent('LoopingExposuresStopped')
	}

	// Emits one passive frame event while exposures are looping.
	#emitLoopingExposuresEvent(frame: GuideFrame) {
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
	#emitCalibratingEvent(diagnostics: GuidingCalibrationDiagnostics) {
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
	#emitGuideStepEvent(frame: GuideFrame, command: GuideCommand, avgDistance: number) {
		const { diagnostics, ra, dec } = command
		const star = frame.stars[0]
		const dx = diagnostics.dx ?? 0
		const dy = diagnostics.dy ?? 0
		const outputActive = !this.#paused && this.#guideOutputActive
		const raDuration = outputActive ? Math.round(ra.duration) : 0
		const decDuration = outputActive ? Math.round(dec.duration) : 0
		// An axis is only reported as limited when a pulse was actually issued and clipped by the
		// per-axis maximum duration, so a suppressed or zero-length pulse never claims a limit.
		const raLimited = raDuration > 0 && ra.duration >= this.#guider.config.maxPulseMsRA
		const decLimited = decDuration > 0 && dec.duration >= this.#guider.config.maxPulseMsDEC

		const raRate = this.#calibration?.ra.ratePxPerMs ?? 0
		const decRate = this.#calibration?.dec.ratePxPerMs ?? 0
		const event: Omit<Writable<PHD2GuideStepEvent>, 'Event' | 'Timestamp' | 'Host' | 'Inst'> = {
			Frame: frame.frameId ?? 0,
			// Seconds since guiding started, matching PHD2's GuideStep.Time.
			Time: this.#guidingElapsedTime(frame.timestamp ?? 0),
			// Uses an empty mount name if the guide-output device is unavailable.
			Mount: this.#guideOutput?.name ?? '',
			dx,
			dy,
			// PHD2 reports these as pixel distances along the mount axes. After calibration the
			// controller's axis error is in milliseconds of pulse, so convert back with the solved rate.
			RADistanceRaw: axisErrorToPixels(diagnostics.axisErrorRA, raRate),
			DECDistanceRaw: axisErrorToPixels(diagnostics.axisErrorDEC, decRate),
			RADistanceGuide: outputActive ? axisErrorToPixels(diagnostics.filteredRA, raRate) : 0,
			DECDistanceGuide: outputActive ? axisErrorToPixels(diagnostics.filteredDEC, decRate) : 0,
			RADuration: raDuration,
			// PHD2 directions are mandatory, so no-pulse frames fall back to west/north defaults.
			RADirection: toPHD2GuideDirection(ra.direction, 'West'),
			DECDuration: decDuration,
			DECDirection: toPHD2GuideDirection(dec.direction, 'North'),
			// Uses zero defaults when the guide frame has no measurable star metadata.
			StarMass: star?.flux ?? 0,
			SNR: star?.snr ?? 0,
			HFD: star?.hfd ?? 0,
			// PHD2 reports the smoothed guide distance here, not the raw current-frame distance.
			AvgDist: avgDistance,
			ErrorCode: 0,
		}

		// PHD2 includes the limit flags only when the pulse was clipped, so they stay absent
		// otherwise instead of being reported as false.
		if (raLimited) event.RALimited = true
		if (decLimited) event.DecLimited = true

		this.emitEvent('GuideStep', event)
	}

	// Emits a star-lost event for the current frame.
	#emitStarLostEvent(frame: GuideFrame, command: GuideCommand) {
		const star = frame.stars[0]

		this.emitEvent('StarLost', {
			Frame: frame.frameId ?? 0,
			// Seconds since guiding started, matching GuideStep.Time and PHD2's convention.
			Time: this.#guidingElapsedTime(frame.timestamp ?? 0),
			// Uses zero defaults when the lost-lock frame has no guide star measurement.
			StarMass: star?.flux ?? 0,
			SNR: star?.snr ?? 0,
			// PHD2 reports the smoothed distance from the last successfully measured frames; a lost
			// frame has no usable error of its own, so the running average is left untouched.
			AvgDist: this.#avgDistance,
			ErrorCode: 1,
			Status: command.diagnostics.notes.join(','),
		})
	}

	// Updates and returns PHD2's smoothed guide distance in pixels from the current frame error.
	// The average is seeded with the first distance measured after guiding starts or after the lock
	// target moves, then low-pass filtered so it tracks sustained error instead of single-frame noise.
	#updateAvgDistance(dx: number, dy: number) {
		const distance = Math.hypot(dx, dy)

		if (this.#avgDistanceNeedReset) {
			this.#avgDistanceNeedReset = false
			this.#avgDistance = distance
		} else {
			this.#avgDistance += AVG_DISTANCE_SMOOTHING_ALPHA * (distance - this.#avgDistance)
		}

		return this.#avgDistance
	}

	// Converts a frame timestamp (ms since the Unix epoch) into PHD2's guide-relative time in seconds,
	// measured from the moment guiding started. Returns 0 while no guiding session is running.
	#guidingElapsedTime(timestamp: number) {
		if (this.#guidingStartTime === 0 || timestamp <= 0) return 0
		return (timestamp - this.#guidingStartTime) / 1000
	}

	// Emits one in-progress settle event using PHD2's time-in-range and requested settle duration fields.
	#emitSettlingEvent(distance: number, timestamp: number, starLocked: boolean) {
		this.emitEvent('Settling', {
			Distance: distance,
			Time: this.#settleStableSince === 0 ? 0 : (timestamp - this.#settleStableSince) * 0.001,
			SettleTime: this.#settle.time,
			StarLocked: starLocked,
		})
	}

	// Emits the final settle status and clears the local settle counters.
	#emitSettleDoneEvent(status: number, error?: string) {
		this.#guider.setDithering(false)
		this.emitEvent('SettleDone', { Status: status, TotalFrames: this.#settleFrameCount, DroppedFrames: this.#settleDroppedFrameCount, Error: error })
		this.#settleFrameCount = 0
		this.#settleDroppedFrameCount = 0
	}
}

// Maps PHD2 DEC guide mode values to the local guider model.
function toDeclinationGuideMode(mode: PHD2DeclinationGuideMode) {
	return (mode === 'Off' ? 'off' : mode === 'North' ? 'north-only' : mode === 'South' ? 'south-only' : 'auto') satisfies DeclinationGuideMode
}

// Converts a pixel-unit guider threshold into calibrated axis units. After calibration the controller
// emits millisecond axis errors (the pulse that would cancel the pixel error), so pixel defaults are
// divided by the solved rate. When the rate is unknown the original threshold is kept so the
// uncalibrated identity controller is unchanged.
function calibratedGuiderOptions(calibration: GuidingCalibrationResult) {
	// The solved image-to-axis matrix converts a pixel error into the milliseconds of pulse that
	// would reproduce it, while the guider expects a matrix that yields the pulse cancelling it,
	// so the matrix is negated here; feeding it unchanged closes the loop with positive feedback.
	// Its output is already in milliseconds, so the per-unit scaling must be neutral: keeping the
	// uncalibrated default would apply the mount rate twice and saturate every correction. Every
	// pixel-unit controller threshold (dead bands, DEC reversal, DEC backlash accumulation) is
	// converted with the solved rates so seeing-sized reversals still hold the DEC axis.
	const [m00, m01, m10, m11] = calibration.imageToAxis
	const raRate = calibration.ra.ratePxPerMs
	const decRate = calibration.dec.ratePxPerMs

	return {
		calibration: [-m00, -m01, -m10, -m11] as const,
		msPerRAUnit: 1,
		msPerDECUnit: 1,
		minMoveRA: axisUnitThreshold(DEFAULT_GUIDER_CONFIG.minMoveRA, raRate),
		minMoveDEC: axisUnitThreshold(DEFAULT_GUIDER_CONFIG.minMoveDEC, decRate),
		decReversalThreshold: axisUnitThreshold(DEFAULT_GUIDER_CONFIG.decReversalThreshold, decRate),
		decBacklashAccumThreshold: axisUnitThreshold(DEFAULT_GUIDER_CONFIG.decBacklashAccumThreshold, decRate),
		raPositiveDirection: calibration.ra.direction,
		decPositiveDirection: calibration.dec.direction,
	}
}

function axisUnitThreshold(pixelThreshold: number, ratePxPerMs: number) {
	return ratePxPerMs > 0 ? pixelThreshold / ratePxPerMs : pixelThreshold
}

// Converts a calibrated axis error back into pixels for PHD2 GuideStep fields. When the rate is
// unknown the controller is using identity units and the value is already in pixels.
function axisErrorToPixels(axisError: number | undefined, ratePxPerMs: number) {
	const error = axisError ?? 0
	return ratePxPerMs > 0 ? error * ratePxPerMs : error
}

// Converts the local calibration result into PHD2-compatible calibration data.
function calibrationResultToPHD2Data(calibration: GuidingCalibrationResult): PHD2CalibrationData {
	return {
		calibrated: true,
		xAngle: calibration.ra.angle,
		xRate: calibration.ra.ratePxPerMs,
		xParity: calibration.ra.direction === 'WEST' ? '+' : '-',
		yAngle: calibration.dec.angle,
		yRate: calibration.dec.ratePxPerMs,
		yParity: calibration.dec.direction === 'NORTH' ? '+' : '-',
	}
}

// Rotates a mount-axis RA/DEC dither offset (pixels) into image X/Y with the calibrated axis unit vectors.
function ditherImageOffset(calibration: GuidingCalibrationResult, dRa: number, dDec: number) {
	return [calibration.ra.unitX * dRa + calibration.dec.unitX * dDec, calibration.ra.unitY * dRa + calibration.dec.unitY * dDec] as const
}

// Moves `star` to the first slot so Guider/GuidingCalibrator lock onto the requested target.
function moveGuideStarToFront(stars: GuideStar[], star: GuideStar) {
	const index = stars.indexOf(star)
	if (index > 0) {
		stars[index] = stars[0]
		stars[0] = star
	}
}

// Finds the nearest detection inside the square search box centered on `position`. Stars outside
// the box are ignored even if they are radially closer than an inside-corner candidate.
function nearestGuideStarInSearchRegion(stars: readonly GuideStar[], position: readonly [number, number], searchRegion: number): GuideStar | undefined {
	let selected: GuideStar | undefined
	let distanceSq = Number.POSITIVE_INFINITY

	for (const star of stars) {
		if (!starInsideSearchRegion(star, position, searchRegion)) continue

		const dx = star.x - position[0]
		const dy = star.y - position[1]
		const candidateDistanceSq = dx * dx + dy * dy

		if (candidateDistanceSq < distanceSq) {
			distanceSq = candidateDistanceSq
			selected = star
		}
	}

	return selected
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
function toPHD2GuideDirection(direction: AxisPulse['direction'], fallback: PHD2GuideDirection): PHD2GuideDirection {
	return direction === 'EAST' ? 'East' : direction === 'NORTH' ? 'North' : direction === 'SOUTH' ? 'South' : direction === 'WEST' ? 'West' : fallback
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
