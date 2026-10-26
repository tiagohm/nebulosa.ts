import { pixelScale } from '../../astronomy/formulas'
import { timeUnix, type Time } from '../../astronomy/time/time'
import type { PartialOnly, Writable } from '../../core/types'
import { errorMessage } from '../../core/util'
import { guidePulseWindow, type GuidePulseQuiescenceWindow } from '../../devices/commanders/guideoutput'
import type { Camera, GuideDirection, GuideOutput } from '../../devices/indi/device'
import type { CameraManager } from '../../devices/indi/manager/camera'
import type { DeviceHandler } from '../../devices/indi/manager/device'
import type { GuideOutputManager } from '../../devices/indi/manager/guideoutput'
import type { BlobEncoding } from '../../devices/indi/types'
import { type Image, type ImageRawType, makeImageRawTypedArray } from '../../imaging/model/types'
import { clamp } from '../../math/numerical/math'
import { DEFAULT_GUIDING_ASSISTANT_CONFIG, GuidingAssistant, type GuidingAssistantConfig, type GuidingAssistantResult } from './assistant'
import { type CalibrationPulseCommand, flipGuidingCalibration, type GuidingCalibrationConfig, type GuidingCalibrationDiagnostics, type GuidingCalibrationResult, GuidingCalibrator } from './calibrator'
import { DitherGenerator, type DitherMode } from './dither'
import type { GuiderState, GuidingEvent, GuidingEventData, GuidingEventType } from './events'
import { type AxisPulse, type DeclinationGuideMode, DEFAULT_GUIDER_CONFIG, type GuideCommand, Guider, type GuiderConfig } from './guider'
import { declinationGuideModeOf, lockShiftOf } from './phd2/events'
import { DEFAULT_PHD2_SETTLE, type PHD2AppState, type PHD2CalibrationData, type PHD2DeclinationGuideMode, type PHD2GuideDirection, type PHD2LockShiftParams, type PHD2Settle, type PHD2StarImage } from './phd2/types'
import type { GuideFrame, GuideTracker, GuideTrackerFrame, GuideTrackerResult } from './tracker'

// Local autoguiding orchestrator exposing a PHD2-compatible API over INDI camera and guide-output
// devices. Each camera BLOB is decoded by the caller-supplied decoder, prepared asynchronously by the
// tracker when it has a preparation stage, and then tracked synchronously against the guide state
// read after those awaits. Decoder and tracker construction and configuration belong to the caller.
// It drives the GuidingCalibrator and Guider state machines and reproduces PHD2 behaviors — app-state
// lifecycle, lock position, dithering (random and spiral), lock-shift drift compensation, settle tracking, meridian-flip calibration flip, and the
// guiding assistant — while emitting the native `GuidingEvent`s of `events.ts` to every registered handler; the PHD2
// protocol shape of those events belongs to `phd2/events.ts`. Every guide pulse,
// whatever path issued it, goes through one dispatcher that refuses it while paused and, under an active pulse
// admission, while the admission is closed or when the pulse exceeds its ceiling. Distances are pixels; pulse
// durations and timing are milliseconds of `performance.now()`; pixel scale is arcsec/pixel.

// Default guide exposure when none has been set, in milliseconds.
const DEFAULT_GUIDER_EXPOSURE = 1000
// Default star-image search-region side, in pixels.
const DEFAULT_SEARCH_REGION = 64
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

// Guider state of each internal application state.
const GUIDER_STATE: Readonly<Record<PHD2AppState, GuiderState>> = {
	Stopped: 'stopped',
	Looping: 'looping',
	Selected: 'selected',
	Calibrating: 'calibrating',
	Guiding: 'guiding',
	LostLock: 'lostLock',
	Paused: 'paused',
}

// Snapshot of one processed guide exposure, published for UI rendering. It carries the decoded
// image plus the generic tracking result, the guide target, and the search window.
// Distances and positions are image pixels with the origin at the top-left corner of
// the full frame, matching detector and PHD2 conventions. The image and arrays are live instances
// owned by the current frame; treat them as read-only and do not retain them across frames.
export interface GuideFrameImage {
	// Monotonic frame counter, identical to the `frameId` of the guideStep, starLost, and loopingFrame
	// events emitted for the same exposure, so the UI can correlate both streams.
	readonly frameId: number
	// Frame timestamp in milliseconds since the Unix epoch, shared with the GuideFrame given to the
	// calibrator/guider.
	readonly timestamp: number
	// Astronomical capture instant used by local ephemeris consumers.
	readonly captureTime?: Time
	// Monotonic capture instant used for ordering and elapsed-time decisions.
	readonly captureMonotonic?: number
	// Guider state after this frame was processed, useful to color or label the view.
	readonly state: GuiderState
	// Decoded guide image. Pixel data lives in `image.raw`; dimensions and channel layout are in
	// `image.metadata`.
	readonly image: Image
	// Exact result produced by the injected tracker for this frame. Consumers interpret any
	// implementation-specific overlay data through the tracker's own result helpers.
	readonly tracking: GuideTrackerResult
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

// Decodes one camera BLOB into an image. `encoding` is the INDI transfer encoding of `data`
// ('base64' text or raw bytes). The caller owns the image format support and where the work runs
// (e.g. a worker). Resolving undefined (unsupported payload) or rejecting is a decode failure for
// that frame, which still advances the guide pipeline without an image.
export type GuideImageDecoder = (data: Buffer, encoding: BlobEncoding) => Promise<Image | undefined>

// Construction options for a GuiderClient. Observers are registered with `addHandler`.
export interface GuiderClientOptions {
	// Decodes every received camera BLOB into the guide image.
	readonly decodeImage: GuideImageDecoder
	// Whether to reverse DEC output after flipping the calibration on a meridian flip.
	readonly reverseDecOutputAfterMeridianFlip?: boolean
	// Star-image search-region side, in pixels (clamped to [16, 128]).
	readonly searchRegion?: number
	// Whether to preserve the exact lock position across guider re-initialization.
	readonly stickyLockPosition?: boolean
	// Dither pattern used by dither().
	readonly ditherMode?: DitherMode
	// PHD2's "Fast recenter after calibration or dither": a dither is followed by direct moves toward the new lock that
	// bypass the guide controller, and the RA clearing move of the calibration starts with longer pulses (the calibrator's
	// fastClearing, which follows this option). Defaults to true, as in PHD2.
	readonly fastRecenter?: boolean
	// Converts a Unix capture timestamp in milliseconds into the caller's astronomical Time model.
	// The returned value is used for ephemeris evaluation and may carry custom providers/location.
	readonly timeFactory?: (timestampMillis: number) => Time
	// Overrides for the calibration state machine, merged over DEFAULT_GUIDING_CALIBRATOR_CONFIG. Pulse
	// durations are milliseconds and distances are pixels; an invalid combination throws at
	// construction. Mounts with a fast guide rate usually only need shorter raPulse/decPulse.
	// The client sets fastClearing from fastRecenter, and by default sizes the fast clearing pulses with the search
	// half-side (maxClearingMovePx) and the guider's RA maximum pulse (maxClearingPulse), and the DEC return pulses with
	// the guider's DEC maximum pulse (maxDecReturnPulse).
	readonly calibrator?: Partial<GuidingCalibrationConfig>
	// Controller tuning merged over DEFAULT_GUIDER_CONFIG for every guider the client builds; an invalid
	// combination throws at construction. Thresholds (deadbands, DEC reversal and backlash) are pixels and
	// are converted with the solved axis rates after calibration. Client-owned values (calibration, lock and
	// initial position, DEC mode, cadence) cannot be overridden.
	readonly guider?: GuiderClientGuiderOptions
}

// Guider settings a client caller may tune; calibration-, lock- and cadence-derived fields stay client-owned.
export type GuiderClientGuiderOptions = Partial<Omit<GuiderConfig, 'calibration' | 'referencePosition' | 'initialPosition' | 'decMode' | 'nominalCadence' | 'msPerRAUnit' | 'msPerDECUnit' | 'raPositiveDirection' | 'decPositiveDirection'>>

// Optics parameters supplied at connect time to derive the guider pixel scale.
export interface GuiderClientConnectOptions {
	readonly focalLength?: number // Optical focal length in mm; takes precedence over aperture-derived focal length.
	readonly aperture?: number // Optical aperture in mm, used together with focalRatio when focalLength is unavailable.
	readonly focalRatio?: number // Dimensionless focal ratio, used together with aperture when focalLength is unavailable.
	readonly pixelSize?: number // Unbinned guider pixel size in um; camera metadata is used when omitted.
}

// Callbacks for observing client activity, registered with `GuiderClient.addHandler`. Every handler receives
// every notification in registration order; an exception thrown by one is caught and logged, so a failing UI
// can neither break the exposure loop nor keep the other handlers from being called.
export interface GuiderClientHandler {
	// Invoked for every emitted native guider event.
	readonly event?: (client: GuiderClient, event: GuidingEvent) => void
	// Invoked once per successfully decoded exposure, after the frame has been processed and after the
	// events for that frame were emitted. Not called when the BLOB fails to decode. The frame image is
	// only assembled while at least one handler has this callback.
	readonly frame?: (client: GuiderClient, frame: GuideFrameImage) => void
}

// Ceiling imposed on every pulse the client dispatches while the admission is active, and the emission gate
// only its owner controls. One admission at a time per client; the ceiling never changes during its life. It
// is created closed.
export interface GuidePulseAdmission extends Disposable {
	// Longest pulse admitted, in milliseconds: an integer ≥ 1, already rounded like a dispatched pulse.
	readonly maximumDuration: number
	// Whether the gate lets pulses up to the ceiling through; a paused client refuses them all the same.
	readonly isOpen: boolean
	// Lets pulses up to the ceiling through.
	readonly open: () => void
	// Refuses every pulse, from any path, until the next `open()`.
	readonly close: () => void
}

// Sends one admitted guide pulse of `duration` whole milliseconds (≥ 1) on `guideOutput` and returns whether it
// was sent. A refused pulse is lost like one the admission refused: it records no window and delays nothing.
export type GuidePulseDispatcher = (guideOutput: GuideOutput, direction: GuideDirection, duration: number) => boolean

// Options of `GuiderClient.admitPulses`.
export interface GuidePulseAdmissionOptions {
	// Sends every pulse the admission lets through instead of the guide output manager, so the owner of the
	// admission dispatches them where it arbitrates the guide output and records their physical evidence, such
	// as `GuideOutputCommander.dispatch` under the operation holding it. Defaults to the guide output manager.
	readonly dispatch?: GuidePulseDispatcher
}

// Admission handed out by `GuiderClient.admitPulses`. Disposing it closes the gate for good and lets the
// client admit another one.
class PulseAdmission implements GuidePulseAdmission {
	// Whether the owner opened the gate and has not closed or disposed it since.
	#open = false
	// Whether the admission was disposed, after which it can never be opened again.
	#disposed = false
	// Detaches the admission from its client; called once on disposal.
	readonly #release: (admission: PulseAdmission) => void

	// Creates a closed admission with a ceiling in milliseconds, the dispatcher of the pulses it lets through
	// (the guide output manager when absent), and the callback detaching it from its client.
	constructor(
		readonly maximumDuration: number,
		readonly dispatch: GuidePulseDispatcher | undefined,
		release: (admission: PulseAdmission) => void,
	) {
		this.#release = release
	}

	get isOpen() {
		return this.#open
	}

	open() {
		if (!this.#disposed) this.#open = true
	}

	close() {
		this.#open = false
	}

	// Closes the gate and detaches the admission from its client. Idempotent.
	[Symbol.dispose]() {
		if (this.#disposed) return
		this.#disposed = true
		this.#open = false
		this.#release(this)
	}
}

// GuiderClient adapts local INDI camera/guide-output devices to a PHD2-like API.
export class GuiderClient {
	#connected = false
	#camera?: Camera
	#guideOutput?: GuideOutput
	#id?: string
	readonly #calibrator: GuidingCalibrator
	readonly #tracker: GuideTracker
	#calibration?: GuidingCalibrationResult
	#frame?: GuideFrame
	#image?: Image
	#frameId = 0
	#processingBlob = false
	// Current capture run, incremented by a stop or a full pause. A frame admitted in an earlier run is
	// dropped instead of being tracked against the guide state of the next one.
	#captureEpoch = 0
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
	// Whether a calibration or a dither is followed by a fast recenter, and the dither recenter in progress.
	#fastRecenter = true
	#recenter?: DitherRecenter
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
	#inFlightExposure = DEFAULT_GUIDER_EXPOSURE
	#exposureStartedAt = 0
	#exposureStartedMonotonic = 0
	#hasExposureStart = false
	#lastAcceptedCaptureMonotonic?: number
	// Constructed after #exposure: #makeGuider reads the cadence so the uncalibrated guider matches
	// the default loop instead of Guider's own 1000 ms default (which happens to be the same today).
	#guider: Guider
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
	readonly #searchRegion: number
	readonly #lockShiftParams = { ...DEFAULT_LOCK_SHIFT_PARAMS }
	// Observers of events and frames, notified in registration order.
	readonly #handlers = new Set<GuiderClientHandler>()
	// Active pulse admission, absent outside an admitted run.
	#admission?: PulseAdmission
	// Quiescence window of every pulse delivered so far: the latest busyAckDeadline and endsBy, in
	// `performance.now()` milliseconds. Absent before the first delivered pulse.
	#pulseWindow?: GuidePulseQuiescenceWindow

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
		// Decodes and prepares each camera frame asynchronously and feeds the guider state machine.
		blobReceived: (device, data, encoding) => {
			void this.#processBlob(device, data, encoding)
		},
	}

	// Creates a client bound to camera and guide-output managers, one caller-owned tracker, and the
	// options carrying the BLOB decoder. The client resets and commits that tracker for session/frame
	// lifecycle changes; callers own its construction, configuration, and implementation-specific coordination.
	constructor(
		readonly cameraManager: CameraManager,
		readonly guideOutputManager: GuideOutputManager,
		tracker: GuideTracker,
		readonly options: GuiderClientOptions,
	) {
		this.#searchRegion = clamp(options.searchRegion || DEFAULT_SEARCH_REGION, 16, 128)
		this.#stickyLockPosition = options.stickyLockPosition === true
		this.#fastRecenter = options.fastRecenter !== false
		// PHD2 sizes the fast recenter of its east and south legs with the search half-side and the axis maximum pulse.
		const maxClearingPulse = options.guider?.maxPulseMsRA ?? DEFAULT_GUIDER_CONFIG.maxPulseMsRA
		const maxDecReturnPulse = options.guider?.maxPulseMsDEC ?? DEFAULT_GUIDER_CONFIG.maxPulseMsDEC
		this.#calibrator = new GuidingCalibrator({ maxClearingMovePx: this.#searchRegion / 2, maxClearingPulse, maxDecReturnPulse, ...options.calibrator, fastClearing: this.#fastRecenter })
		this.#tracker = tracker
		this.#guider = this.#makeGuider(undefined)
		this.#dither = new DitherGenerator({ mode: options.ditherMode })
	}

	get camera() {
		return this.#camera
	}

	get guideOutput() {
		return this.#guideOutput
	}

	get id() {
		return this.#id
	}

	// Registers the client itself as a handler of the camera manager, so it receives the camera BLOBs and
	// updates. Unrelated to `addHandler`, which registers an observer of this client.
	attachHandler() {
		this.cameraManager.addHandler(this.#cameraHandler)
	}

	// Unregisters the client from the camera manager.
	detachHandler() {
		this.cameraManager.removeHandler(this.#cameraHandler)
	}

	// Registers an observer of the events and frames of this client. Registering the same handler twice
	// changes nothing; a handler added while a notification is being delivered may receive it.
	addHandler(handler: GuiderClientHandler) {
		this.#handlers.add(handler)
	}

	// Unregisters an observer; idempotent, and safe while a notification is being delivered.
	removeHandler(handler: GuiderClientHandler) {
		this.#handlers.delete(handler)
	}

	// Activates the exclusive pulse admission with a ceiling of `maximumDuration` milliseconds, rounded like a
	// dispatched pulse. While it is active every pulse, from guiding, calibration, the guiding assistant or
	// `guidePulse`, is refused unless the admission is open and the pulse fits the ceiling. Returns undefined
	// when another admission is active or when the current configuration already allows a longer pulse
	// (`maxPulseDuration() > ceiling`). The admission starts closed, and `options.dispatch` sends the pulses it
	// lets through. Throws for a ceiling that is not a finite number ≥ 1, since no pulse could ever fit it.
	admitPulses(maximumDuration: number, options: GuidePulseAdmissionOptions = {}): GuidePulseAdmission | undefined {
		if (!(maximumDuration >= 1 && Number.isFinite(maximumDuration))) throw new Error(`invalid pulse ceiling: ${maximumDuration}`)
		if (this.#admission !== undefined) return undefined

		const ceiling = Math.max(1, Math.round(maximumDuration))
		if (this.maxPulseDuration() > ceiling) return undefined

		const admission = new PulseAdmission(ceiling, options.dispatch, (released) => {
			if (this.#admission === released) this.#admission = undefined
		})

		this.#admission = admission
		return admission
	}

	// Returns the quiescence window of the pulses delivered so far, in `performance.now()` milliseconds: the
	// latest busyAckDeadline and endsBy over every delivered pulse, each from `guidePulseWindow`. Undefined
	// before the first delivered pulse; refused pulses never change it.
	pulseQuiescenceWindow(): GuidePulseQuiescenceWindow | undefined {
		return this.#pulseWindow
	}

	// Longest pulse, in milliseconds, the current configuration can emit: the guider limits of both axes, the
	// calibration pulses of both axes, the fast clearing and DEC return pulses while fast recenter is on and the guiding
	// assistant backlash pulse, rounded like a dispatched pulse.
	// Only the default of an admission ceiling and the refusal of an admission rely on it.
	maxPulseDuration() {
		const guider = { ...DEFAULT_GUIDER_CONFIG, ...this.options.guider }
		const calibrator = this.#calibrator.config
		const backlashPulse = this.#guidingAssistant?.config.backlashPulse ?? DEFAULT_GUIDING_ASSISTANT_CONFIG.backlashPulse
		const clearingPulse = calibrator.fastClearing ? calibrator.maxClearingPulse : 0
		const decReturnPulse = calibrator.fastClearing && calibrator.decReturnEnabled ? calibrator.maxDecReturnPulse : 0
		return Math.max(1, Math.round(Math.max(guider.maxPulseMsRA, guider.maxPulseMsDEC, calibrator.raPulse, calibrator.decPulse, clearingPulse, decReturnPulse, backlashPulse)))
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
		this.#id = Bun.MD5.hash(`GUIDER_CLIENT:${camera.id}:${guideOutput.id}`, 'hex')
		// PHD2 greets a newly connected client with Version followed by the current AppState. AppState
		// is only sent here: afterwards clients track state through the individual lifecycle events.
		this.emitEvent('connected', { state: GUIDER_STATE[this.#appState] })

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
		this.emitEvent('disconnected')

		return true
	}

	// PHD2-compatible alias of findTarget().
	findStar() {
		return this.findTarget()
	}

	// Selects a target from the latest result through the tracker, or its measurement when selection
	// is unsupported. Stores the image-pixel position as the lock without tracking another frame.
	findTarget() {
		const tracking = this.#frame?.tracking ?? this.#tracker.lastResult
		const selected = tracking === undefined ? undefined : this.#tracker.select === undefined ? measurementPositionOf(tracking) : this.#tracker.select(tracking)
		if (selected === undefined) return undefined

		this.#abortGuidingAssistantForTransition('guide star changed')
		this.#lockPosition = selected
		this.#lockSearchPosition = this.#lockPosition
		this.#exactLockPosition = false
		this.#ditherOffsetX = 0
		this.#ditherOffsetY = 0
		this.#dither.reset()
		this.#recenter = undefined
		this.#lockShiftOffsetX = 0
		this.#lockShiftOffsetY = 0
		this.#lockShiftTimestamp = 0
		this.#lockShiftLimitReached = false
		this.#avgDistanceNeedReset = true
		this.emitEvent('targetSelected', { x: selected[0], y: selected[1] })
		// The explicit selection becomes the identity seed for the next frame. The current tracker
		// result was already consumed above, so resetting here cannot cause a second detection.
		this.#tracker.reset()

		if (this.#appState === 'Guiding' || this.#appState === 'LostLock' || this.#appState === 'Paused') {
			this.#guider = this.#makeGuider(this.#calibration)
			this.#resumeState = 'Guiding'
			if (!this.#paused) this.#setAppState('Guiding')
		} else if (this.#appState === 'Stopped' || this.#appState === 'Looping') {
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

	// Stops camera exposure and clears active guiding/looping state. A pending one-shot exposure
	// started while already Stopped is still aborted and released, without emitting stop events.
	stopCapture() {
		if (this.#appState === 'Stopped' && !this.#awaitingBlob) return true

		if (this.#guidingAssistant !== undefined) {
			this.#finishGuidingAssistant(false, 'capture stopped', this.#guidingAssistant.measuringBacklash)
		}

		this.#abortSettling('capture stopped')
		this.#emitCaptureStoppedEvent()
		this.#captureEpoch++
		this.#blobAdmission = 'accept'
		this.#awaitingBlob = false
		this.#hasExposureStart = false
		this.#exposureStartedAt = 0
		this.#exposureStartedMonotonic = 0
		this.#lastAcceptedCaptureMonotonic = undefined
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
		this.#tracker.reset()
		this.#guider = this.#makeGuider(undefined)
		this.#ditherOffsetX = 0
		this.#ditherOffsetY = 0
		this.#dither.reset()
		this.#recenter = undefined
		this.#lockShiftOffsetX = 0
		this.#lockShiftOffsetY = 0
		this.#lockShiftTimestamp = 0
		this.#lockShiftLimitReached = false
		this.#abortSettling('calibration cleared')
		this.emitEvent('calibrationCleared')

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
		this.#recenter = undefined
		this.#lockShiftOffsetX = 0
		this.#lockShiftOffsetY = 0
		this.#lockShiftTimestamp = 0
		this.#lockShiftLimitReached = false
		this.#abortSettling('guide star deselected')
		this.#guider.reset()
		this.#guider.stopDither()
		this.#tracker.reset()

		if (this.#appState !== 'Stopped') {
			this.#resumeState = 'Looping'
			if (!this.#paused) this.#setAppState('Looping')
		}
	}

	// Moves the lock by the next offset of the dither pattern, along the mount axes in pixels, relative to the current
	// lock as PHD2 does, and starts a settle. An offset whose lock would leave the frame is reflected on the axes first
	// (ditherWithinFrame). The controllers forget their history, as PHD2's guide algorithms do when the lock moves, and
	// with fast recenter enabled the next frames move the star to the new lock directly (recenterStep).
	dither(amount: number, raOnly: boolean = false, settle?: Partial<PHD2Settle>) {
		if (this.#guidingAssistant !== undefined || this.#calibration === undefined || this.#guider.currentState.state !== 'guiding' || amount <= 0 || !Number.isFinite(amount)) return false

		const { referenceX, referenceY } = this.#guider.currentState
		const offset = this.#dither.next(amount, raOnly)
		const lockX = referenceX + this.#ditherOffsetX + this.#lockShiftOffsetX
		const lockY = referenceY + this.#ditherOffsetY + this.#lockShiftOffsetY
		const [dRa, dDec, dx, dy] = this.#ditherWithinFrame(this.#calibration, lockX, lockY, offset.rightAscension, offset.declination)

		this.#ditherOffsetX += dx
		this.#ditherOffsetY += dy
		this.#syncGuideTargetOffset()
		this.#guider.setDithering(true)
		this.#guider.resetControllers()
		this.#recenter = this.#fastRecenter ? ditherRecenterOf(dRa, dDec, this.#searchRegion) : undefined
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

		this.emitEvent('dithered', { dx, dy })
		this.emitEvent('settleStarted')

		return true
	}

	// Returns the dither (dRa, dDec) along the mount axes, in pixels, and its image offset (dx, dy) that keep the lock
	// moved from (lockX, lockY) inside the frame: the requested one, else its reflection on the RA axis, on the DEC axis,
	// or on both, in PHD2's order, else the one whose lock lies farthest from the frame edges. A lock is valid one search
	// half-side plus a pixel inside every edge, as in PHD2; without a decoded frame the requested dither is kept.
	#ditherWithinFrame(calibration: GuidingCalibrationResult, lockX: number, lockY: number, dRa: number, dDec: number): readonly [number, number, number, number] {
		const metadata = this.#image?.metadata
		const margin = 1 + this.#searchRegion / 2
		let best: readonly [number, number, number, number] = [dRa, dDec, ...ditherImageOffset(calibration, dRa, dDec)]
		let bestDistance = Number.NEGATIVE_INFINITY

		for (let q = 0; q < 4; q++) {
			const ra = q & 1 ? -dRa : dRa
			const dec = q & 2 ? -dDec : dDec
			const [dx, dy] = ditherImageOffset(calibration, ra, dec)
			if (metadata === undefined) return [ra, dec, dx, dy]

			const x = lockX + dx
			const y = lockY + dy
			if (x >= margin && x + margin < metadata.width && y >= margin && y + margin < metadata.height) return [ra, dec, dx, dy]

			const distance = Math.min(x, metadata.width - x, y, metadata.height - y)
			if (distance > bestDistance) {
				best = [ra, dec, dx, dy]
				bestDistance = distance
			}
		}

		return best
	}

	// Returns whether a calibration or a dither is followed by a fast recenter.
	getFastRecenterEnabled() {
		return this.#fastRecenter
	}

	// Enables or disables the fast recenter after a dither and the fast clearing pulses of the next calibration clearing
	// move; disabling it leaves a dither recenter in progress to the controller.
	setFastRecenterEnabled(enabled: boolean) {
		this.#fastRecenter = enabled
		this.#calibrator.setFastClearing(enabled)
		if (!enabled) this.#recenter = undefined
		this.emitEvent('settingChanged', { setting: 'fastRecenter', value: enabled })
		return true
	}

	// Flips the solved calibration for a meridian flip and applies the transformed axis parity to the
	// running guider so lock, hysteresis, and dither survive the flip.
	flipCalibration() {
		if (this.#calibration === undefined || this.#appState === 'Calibrating') return false

		this.#calibration = flipGuidingCalibration(this.#calibration, this.options.reverseDecOutputAfterMeridianFlip === true)
		this.#applyCalibrationToGuider(this.#calibration)
		this.#syncGuideTargetOffset()
		this.emitEvent('calibrationFlipped', { guideOutput: this.#guideOutput?.name ?? '' })

		return true
	}

	// Returns the current PHD2-style state mapped from the local session state machine.
	getAppState() {
		return this.#appState
	}

	// Current guider state, the one the stateChanged events report.
	get state(): GuiderState {
		return GUIDER_STATE[this.#appState]
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

	// Starts a PHD2-style guiding assistant run while ordinary guide output is disabled. Under an active pulse
	// admission, a backlash pulse longer than its ceiling refuses the run before anything starts.
	startGuidingAssistant(config: Partial<GuidingAssistantConfig> = {}) {
		const appState = this.#appState === 'Paused' && !this.#fullPause ? this.#resumeState : this.#appState
		const guiderState = this.#guider.currentState

		if (this.#guidingAssistant !== undefined || this.#settling || guiderState.state !== 'guiding' || (appState !== 'Guiding' && appState !== 'LostLock')) return false

		const backlashPulse = Math.max(1, Math.round(config.backlashPulse ?? DEFAULT_GUIDING_ASSISTANT_CONFIG.backlashPulse))
		if (this.#admission !== undefined && backlashPulse > this.#admission.maximumDuration) return false

		const imageScale = this.getPixelScale()
		const exposure = this.getExposure()
		const assistant = new GuidingAssistant({
			imageScale: imageScale > 0 ? imageScale : undefined,
			exposure: exposure > 0 && Number.isFinite(exposure) ? exposure / 1000 : undefined,
			suspectCalibration: this.#calibration === undefined,
			decPositiveDirection: this.#calibration?.dec.direction ?? 'NORTH',
			raRatePxPerMs: this.#calibration?.ra.ratePxPerMs,
			decRatePxPerMs: this.#calibration?.dec.ratePxPerMs,
			...config,
		})

		this.#guidingAssistant = assistant
		this.#guidingAssistantSuppressingGuideOutput = true
		this.#guidingAssistantResult = assistant.start()
		this.emitEvent('assistantStarted', { result: this.#guidingAssistantResult })

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
			this.emitEvent('assistantUpdated', { result: step.result })
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

	// PHD2-compatible alias of getTargetImage().
	getStarImage(): PHD2StarImage<ImageRawType> | undefined {
		return this.getTargetImage()
	}

	// Returns the most recent decoded guide frame cropped around the lock target (or latest measurement)
	// using the raw in-memory pixel buffer, in the PHD2 star-image shape.
	getTargetImage(): PHD2StarImage<ImageRawType> | undefined {
		if (this.#image === undefined) return undefined

		const star = this.#frame?.tracking.measurement
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
			this.emitEvent('settleStarted')
			if (this.#paused) this.setPaused(false)

			return true
		}

		this.#abortGuidingAssistantForTransition('guiding restarted')

		// PHD2 auto-selects a guide star when a guide request arrives with nothing selected. This is a
		// no-op until a frame has been decoded, matching PHD2's behavior of guiding on the star found
		// in the frames that follow.
		if (this.#lockPosition === undefined) this.findTarget()

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
		this.#recenter = undefined
		this.#lockShiftOffsetX = 0
		this.#lockShiftOffsetY = 0
		this.#tracker.reset()
		this.emitEvent('settleStarted')

		if (recalibrate || this.#calibration === undefined) {
			if (recalibrate) this.#calibration = undefined
			this.#calibrator.reset()
			this.emitEvent('calibrationStarted', { guideOutput: this.#guideOutput.name })
			this.#setAppState('Calibrating')
		} else {
			this.#guider = this.#makeGuider(this.#calibration)
			this.#guidingStartTime = Date.now()
			this.#avgDistanceNeedReset = true
			this.emitEvent('guidingStarted')
			this.#setAppState('Guiding')
		}

		this.startExposureLoop(this.#exposure)

		return true
	}

	// Sends a direct single-axis pulse of `amount` milliseconds through the active guide output. Returns false,
	// sending nothing, while paused, while an active admission is closed, or above its ceiling.
	guidePulse(amount: number, direction: PHD2GuideDirection) {
		if (this.#guideOutput === undefined || !this.#guideOutputActive || amount <= 0 || !Number.isFinite(amount)) return false
		return this.#dispatchPulse(direction.toUpperCase() as GuideDirection, amount) > 0
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
		this.#recenter = undefined
		this.#lockShiftOffsetX = 0
		this.#lockShiftOffsetY = 0
		this.#tracker.reset()
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
		if (this.#appState !== 'Calibrating') this.#guider.setDecMode(declinationGuideModeOf(mode))
		this.emitEvent('settingChanged', { setting: 'decGuideMode', value: declinationGuideModeOf(mode) })
	}

	// Stores the default exposure cadence for subsequent captures.
	setExposure(exposure: number) {
		if (exposure <= 0 || !Number.isFinite(exposure)) return false
		this.#exposure = exposure
		this.#guider.setNominalCadence(exposure)
		this.emitEvent('settingChanged', { setting: 'exposure', value: exposure })
		return true
	}

	// Enables or disables guide pulses while keeping frame processing active.
	setGuideOutputEnabled(enabled: boolean) {
		this.#guideOutputEnabled = enabled
		if (!enabled && this.#guidingAssistant?.measuringBacklash === true) this.#finishGuidingAssistant(false, 'guide output disabled', true)
		this.emitEvent('settingChanged', { setting: 'guideOutputEnabled', value: enabled })
	}

	// Stores a lock target in image pixels, delegating nearby target selection to the tracker when
	// supported. Exact requests retain [x, y] as the lock while selection sets the search position.
	setLockPosition(x: number, y: number, exact: boolean = false) {
		if (!Number.isFinite(x) || !Number.isFinite(y)) return false

		this.#abortGuidingAssistantForTransition('lock position changed')

		const requested = [x, y] as const
		const tracking = this.#frame?.tracking
		this.#lockSearchPosition = (tracking === undefined ? undefined : this.#tracker.select?.(tracking, requested)) ?? requested

		this.#lockPosition = exact ? ([x, y] as const) : this.#lockSearchPosition
		this.#exactLockPosition = exact

		const [lockX, lockY] = this.#lockPosition
		this.#ditherOffsetX = 0
		this.#ditherOffsetY = 0
		this.#dither.reset()
		this.#recenter = undefined
		this.#lockShiftOffsetX = 0
		this.#lockShiftOffsetY = 0
		this.#lockShiftTimestamp = 0
		this.#lockShiftLimitReached = false
		this.#avgDistanceNeedReset = true
		this.#tracker.reset()
		this.emitEvent('lockPositionSet', { x: lockX, y: lockY })

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

	// Selects the dither pattern and restarts its sequence. Random and spiral match PHD2; golden and grid are local patterns.
	setDitherMode(mode: DitherMode) {
		this.#dither.setMode(mode)
		this.emitEvent('settingChanged', { setting: 'ditherMode', value: mode })
	}

	// Enables or disables preserving the current lock target across guider initialization.
	setStickyLockPositionEnabled(enabled: boolean) {
		this.#stickyLockPosition = enabled

		if (!enabled && !this.#exactLockPosition && this.#lockSearchPosition !== undefined) {
			this.#lockPosition = this.#lockSearchPosition
		}

		this.emitEvent('settingChanged', { setting: 'stickyLockPosition', value: enabled })

		return true
	}

	// Enables or disables drift compensation by moving the guide target at the configured lock-shift rate.
	setLockShiftEnabled(enabled: boolean) {
		if (enabled && this.#lockShiftParams.units === 'arcsec/hr' && this.getPixelScale() <= 0) {
			return false
		}

		this.#lockShiftParams.enabled = enabled
		this.#lockShiftTimestamp = enabled ? (this.#frame?.captureMonotonic ?? this.#frame?.timestamp ?? 0) : 0
		this.#lockShiftLimitReached = false
		this.emitEvent('settingChanged', { setting: 'lockShiftEnabled', value: enabled })

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
		this.#lockShiftTimestamp = this.#frame?.captureMonotonic ?? this.#frame?.timestamp ?? 0
		this.#lockShiftLimitReached = false
		this.emitEvent('settingChanged', { setting: 'lockShift', value: lockShiftOf(this.getLockShiftParams()) })

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
			if (!wasPaused) this.emitEvent('paused', { full: this.#fullPause })
			if (this.#guidingAssistant?.measuringBacklash === true) this.#finishGuidingAssistant(false, 'backlash test paused', true)
			this.#setAppState('Paused')
			if (this.#fullPause) {
				this.#captureEpoch++
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
		if (wasPaused) this.emitEvent('resumed')
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

		// The calibrator and guider are stateful and not reentrant, so a BLOB that arrives while a
		// previous frame is still being decoded, prepared or processed is dropped to avoid interleaved
		// mutation. No exposure of this client is outstanding then (the next one starts only when that
		// processing ends), so the BLOB may only consume a pending stale-BLOB drop: accepting it as the
		// admission below does would abort nothing and arm a drop that discards the next exposure's BLOB.
		if (this.#processingBlob) {
			if (this.#blobAdmission === 'drop-next') this.#blobAdmission = 'already-dropped'
			return
		}

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

		this.#processingBlob = true
		const epoch = this.#captureEpoch
		this.#awaitingBlob = false
		// Drop the missing-BLOB timer as soon as this exposure is in hand. Leaving it armed until
		// the next startExposure lets a slow decode or pulse wait trip a false timeout and start an
		// overlapping exposure.
		this.#clearExposureWatchdog()

		let pulseDelay = 0
		this.#pulseMsIssued = 0

		try {
			let image: Image | undefined

			try {
				image = await this.options.decodeImage(data, encoding)
			} catch (e) {
				console.error('guide image decode failed:', e)
			}

			// Clear the cached image on a failed decode so getStarImage cannot return stale pixels
			// tagged with the new (empty) frame id instead of the last successfully decoded frame.
			this.#image = image

			const frame = await this.#makeGuideFrame(device, epoch, image)
			if (frame === undefined) return
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
				this.emitEvent('alert', { message: `guide frame processing failed: ${errorMessage(e)}`, severity: 'error' })
			}
		} catch (e) {
			console.error('guide frame processing failed:', e)
			this.emitEvent('alert', { message: `guide frame processing failed: ${errorMessage(e)}`, severity: 'error' })
		} finally {
			try {
				await this.#queueNextExposure(Math.max(pulseDelay, this.#pulseMsIssued))
			} catch (e) {
				console.error('guide exposure queue failed:', e)
			}

			this.#processingBlob = false
		}
	}

	// Converts a decoded image into a guide frame: awaits the tracker's context-free preparation, when it
	// has one, and then executes exactly one synchronous tracker pass with the guide state read after
	// that await. `epoch` is the capture run the BLOB was admitted in. Returns undefined for an
	// out-of-order capture, when a stop or a full pause ended that run while the frame was being decoded
	// or prepared, or when `device` stopped being the connected camera meanwhile.
	async #makeGuideFrame(device: Camera, epoch: number, image?: Image): Promise<GuideFrame | undefined> {
		if (epoch !== this.#captureEpoch) return undefined
		const width = image?.metadata.width ?? this.#camera?.frame.width.value ?? 0
		const height = image?.metadata.height ?? this.#camera?.frame.height.value ?? 0
		const timestamp = this.#hasExposureStart ? this.#exposureStartedAt + this.#inFlightExposure / 2 : Date.now()
		// The monotonic clock is sampled when the BLOB is admitted. It is the operational fallback when
		// the camera does not provide a capture clock; the astronomical `captureTime` above still uses
		// the exposure midpoint.
		const captureMonotonic = performance.now()
		if (this.#lastAcceptedCaptureMonotonic !== undefined && captureMonotonic <= this.#lastAcceptedCaptureMonotonic) return undefined
		this.#lastAcceptedCaptureMonotonic = captureMonotonic
		const captureTime = this.options.timeFactory?.(timestamp) ?? timeUnix(timestamp / 1000)
		const cadence = this.#inFlightExposure
		const frame: GuideTrackerFrame = { image, width, height, timestamp, captureTime, captureMonotonic, frameId: ++this.#frameId, cadence }
		// No await without a preparation stage, so the tracker sees the guide state of the turn that built the frame.
		const trackerFrame = this.#tracker.prepare === undefined ? frame : await this.#tracker.prepare(frame)
		if (!this.#connected || device !== this.#camera || epoch !== this.#captureEpoch) return undefined

		const lockSearchPosition = this.#lockSearchPosition ?? this.#lockPosition
		const appState = this.#appState === 'Paused' && !this.#fullPause ? this.#resumeState : this.#appState
		const phase = this.#guidingAssistant !== undefined ? 'assistant' : appState === 'Calibrating' ? 'calibrating' : appState === 'Guiding' ? 'guiding' : appState === 'LostLock' ? 'lostLock' : appState === 'Selected' ? 'selected' : 'looping'
		const tracking = this.#tracker.track(trackerFrame, {
			phase,
			maxMeasurementJumpPx: this.#calibrator.config.maxFrameJumpPx,
			searchPosition: lockSearchPosition,
			searchRegion: lockSearchPosition === undefined ? undefined : this.#searchRegion,
			initialPosition: this.#lockSearchPosition,
			allowAcquisition: appState !== 'Stopped' && !(appState === 'Paused' && this.#fullPause),
			preserveIdentity: lockSearchPosition !== undefined || appState === 'Guiding' || appState === 'LostLock' || this.#guidingAssistant !== undefined,
			lockEstablished: this.#guider.currentState.state === 'guiding',
		})

		return {
			tracking,
			width,
			height,
			timestamp,
			frameId: frame.frameId,
			cadence,
			captureTime,
			captureMonotonic,
			targetEnvelope: tracking.targetEnvelope,
		}
	}

	// Publishes the decoded frame and its overlay geometry to every frame handler. Called after the
	// frame has been processed so the lock target, the tracked star, and the app state already
	// reflect this exposure instead of the previous one. The snapshot is only assembled when a handler wants
	// it, and handler failures are contained here because this runs inside the exposure loop.
	#emitFrameImage(frame: GuideFrame, image: Image) {
		let frameImage: GuideFrameImage | undefined

		for (const handler of this.#handlers) {
			if (handler.frame === undefined) continue

			frameImage ??= {
				frameId: frame.frameId ?? 0,
				timestamp: frame.timestamp ?? Date.now(),
				captureTime: frame.captureTime,
				captureMonotonic: frame.captureMonotonic,
				state: GUIDER_STATE[this.#appState],
				image,
				tracking: frame.tracking,
				lockPosition: this.#lockPosition,
				searchPosition: this.#lockSearchPosition ?? this.#lockPosition,
				searchRegion: this.#searchRegion,
			}

			try {
				handler.frame(this, frameImage)
			} catch (e) {
				console.error('guide frame handler failed:', e)
			}
		}
	}

	// Routes the current frame to calibration, guiding, or passive looping.
	#processFrame(frame: GuideFrame) {
		const appState = this.#appState === 'Paused' && !this.#fullPause ? this.#resumeState : this.#appState

		if (appState === 'Calibrating') return this.#processCalibrationFrame(frame)
		if (appState === 'Guiding' || appState === 'LostLock') return this.#processGuidingFrame(frame)
		if (appState === 'Looping' || appState === 'Selected') this.#emitLoopingExposuresEvent(frame)

		return 0
	}

	// Advances the calibration state machine and stores the solved matrix when complete.
	#processCalibrationFrame(frame: GuideFrame) {
		const step = this.#calibrator.processFrame(frame)
		if (step.failure === undefined && !step.diagnostics.notes.includes('bad_frame') && !step.diagnostics.notes.includes('jump_rejected') && !step.diagnostics.notes.includes('settling')) this.#tracker.commit?.()

		this.#updateLockPositionFromCalibration(step.diagnostics)
		this.#emitCalibratingEvent(step.diagnostics)

		if (step.failure !== undefined) {
			this.emitEvent('calibrationFailed', { guideOutput: this.#guideOutput?.name ?? '', failure: step.failure })

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
			this.emitEvent('calibrationCompleted', { guideOutput: this.#guideOutput?.name ?? '', calibration: step.completed })
			this.emitEvent('guidingStarted')
			this.#resumeState = 'Guiding'
			if (!this.#paused) this.#setAppState('Guiding')
			return 0
		}

		return this.#pulseCalibration(step.pulse?.ra.direction, step.pulse?.ra.duration, step.pulse?.dec.direction, step.pulse?.dec.duration)
	}

	// Runs the guide controller, applies settle tracking, and returns the max pulse delay.
	#processGuidingFrame(frame: GuideFrame) {
		this.#updateLockShift(frame)
		const command = this.#guider.processFrame(frame)
		const acceptedMeasurement =
			command.tracking.measurement !== undefined && command.tracking.qualityScore >= this.#guider.config.minFrameQuality && !command.diagnostics.badFrame && command.diagnostics.targetLimit === undefined && !command.diagnostics.notes.includes('init_waiting') && !command.diagnostics.notes.includes('jump_rejected')
		if (acceptedMeasurement) this.#tracker.commit?.()
		const timestamp = frame.timestamp ?? Date.now()
		const captureMonotonic = frame.captureMonotonic

		this.#updateLockPositionFromGuider(command.diagnostics.targetX, command.diagnostics.targetY)
		this.#updateLockSearchPositionFromGuider(command.diagnostics.measurementX, command.diagnostics.measurementY)

		if (command.state === 'lost') {
			this.#emitStarLostEvent(frame, command)
			// PHD2 reports StarLost for every dropped frame but LockPositionLost only once, when the
			// lock is actually given up. #resumeState tracks the session state even while paused, so
			// it is the reliable edge test here.
			if (this.#resumeState !== 'LostLock') this.emitEvent('lockLost')
			this.#resumeState = 'LostLock'
			if (!this.#paused) this.#setAppState('LostLock')
			this.#updateSettling(undefined, undefined, true, true, timestamp, captureMonotonic)
			if (this.#guidingAssistant !== undefined) this.#finishGuidingAssistant(false, 'guide star lost')
			return 0
		}

		// During a fast recenter the frame still measures and settles, but its pulses are the recenter's.
		const recenter = this.#recenterStep(command)
		const issued = recenter ?? command
		this.#emitGuideStepEvent(frame, issued, this.#updateAvgDistance(command.diagnostics.dx ?? 0, command.diagnostics.dy ?? 0), recenter !== undefined)
		const assistantDelay = this.#processGuidingAssistantFrame(frame, command)

		this.#resumeState = 'Guiding'
		if (!this.#paused) this.#setAppState('Guiding')

		this.#updateSettling(command.diagnostics.dx, command.diagnostics.dy, command.diagnostics.badFrame, command.diagnostics.lost, timestamp, captureMonotonic)

		if (assistantDelay !== undefined) return assistantDelay

		return Math.max(this.#pulseAxis(issued.ra.direction, issued.ra.duration), this.#pulseAxis(issued.dec.direction, issued.dec.duration))
	}

	// Returns the command of the next step of a fast recenter for a measured guiding frame, or undefined without one in
	// progress, while the pulses would not be sent, or for a bad frame. As PHD2's recovery moves, a step moves the star
	// along the mount axes toward the new lock by at most 0.7 of the search half-side (ditherRecenterOf), bypassing the
	// controller; unlike PHD2 it is also shortened to the pulse admission ceiling, since a longer pulse would be refused
	// whole. The last step ends the recenter and clears the controllers, so guiding resumes without the history of the
	// recenter frames.
	#recenterStep(command: GuideCommand): GuideCommand | undefined {
		const recenter = this.#recenter
		const calibration = this.#calibration
		if (recenter === undefined || calibration === undefined || this.#paused || !this.#guideOutputActive || command.diagnostics.badFrame) return undefined

		let ra = Math.min(recenter.remainingRA, recenter.stepRA)
		let dec = Math.min(recenter.remainingDEC, recenter.stepDEC)
		const ceiling = this.#admission?.maximumDuration ?? this.maxPulseDuration()
		const longest = Math.max(calibration.ra.ratePxPerMs > 0 ? ra / calibration.ra.ratePxPerMs : 0, calibration.dec.ratePxPerMs > 0 ? dec / calibration.dec.ratePxPerMs : 0)

		if (longest > ceiling) {
			ra *= ceiling / longest
			dec *= ceiling / longest
		}

		recenter.remainingRA -= ra
		recenter.remainingDEC -= dec
		const [vx, vy] = ditherImageOffset(calibration, ra * recenter.signRA, dec * recenter.signDEC)
		// The controller cancels an error of measurement minus target, so moving the star by v cancels an error of -v.
		const pulse = this.#guider.directPulse(-vx, -vy)

		if (recenter.remainingRA < RECENTER_DONE_PX && recenter.remainingDEC < RECENTER_DONE_PX) {
			this.#recenter = undefined
			this.#guider.resetControllers()
			this.#avgDistanceNeedReset = true
		}

		return { ...command, ra: pulse.ra, dec: pulse.dec }
	}

	// Sends one calibration pulse pair and returns the largest applied delay.
	#pulseCalibration(raDirection?: AxisPulse['direction'], raDuration?: number, decDirection?: AxisPulse['direction'], decDuration?: number, force: boolean = false) {
		return Math.max(this.#pulseAxis(raDirection, raDuration, force), this.#pulseAxis(decDirection, decDuration, force))
	}

	// Sends one axis pulse if guide output is enabled and returns the applied delay.
	#pulseAxis(direction?: AxisPulse['direction'], duration?: number, force: boolean = false) {
		if (this.#guideOutput === undefined || this.#paused || (!force && !this.#guideOutputActive) || direction === undefined || duration === undefined || duration <= 0 || !Number.isFinite(duration)) return 0

		const pulseDuration = this.#dispatchPulse(direction.toUpperCase() as GuideDirection, duration)
		this.#pulseMsIssued = Math.max(this.#pulseMsIssued, pulseDuration)

		return pulseDuration
	}

	// The only sender of guide pulses: rounds the duration, in milliseconds, to a whole millisecond of at least
	// one, refuses it while paused, while an active admission is closed, or above its ceiling, sends it through
	// the dispatcher of the active admission (the guide output manager otherwise), and records the window of a
	// delivered pulse. Returns the delivered duration, or 0 when nothing was sent. A correction refused for its
	// length is lost, never shortened.
	#dispatchPulse(direction: GuideDirection, duration: number) {
		const guideOutput = this.#guideOutput
		if (guideOutput === undefined || this.#paused) return 0

		const pulseDuration = Math.max(1, Math.round(duration))
		const admission = this.#admission
		if (admission !== undefined && (!admission.isOpen || pulseDuration > admission.maximumDuration)) return 0

		const window = guidePulseWindow(performance.now(), pulseDuration)

		if (admission?.dispatch === undefined) this.guideOutputManager.pulse(guideOutput, direction, pulseDuration)
		else if (!admission.dispatch(guideOutput, direction, pulseDuration)) return 0

		const previous = this.#pulseWindow
		this.#pulseWindow = previous === undefined ? window : { busyAckDeadline: Math.max(previous.busyAckDeadline, window.busyAckDeadline), endsBy: Math.max(previous.endsBy, window.endsBy) }

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
			this.emitEvent('assistantUpdated', { result: this.#guidingAssistantResult })
			if (!alignment.aligned) return 0
			this.#guidingAssistantPendingPulse = undefined
			return this.#pulseCalibration(pulse.ra.direction, pulse.ra.duration, pulse.dec.direction, pulse.dec.duration, this.#guideOutputEnabled)
		}

		const step = assistant.addSample(frame, command)
		this.#guidingAssistantResult = step.result
		this.emitEvent('assistantUpdated', { result: step.result })

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
		this.emitEvent(completed ? 'assistantCompleted' : 'assistantFailed', { result })

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
	#updateSettling(dx: number | undefined, dy: number | undefined, badFrame: boolean, lost: boolean, timestamp: number, captureMonotonic?: number) {
		if (!this.#settling || this.#paused) return

		const clock = captureMonotonic ?? timestamp

		if (this.#settleStartTime === 0) {
			this.#settleStartTime = clock
			this.#settleStableSince = 0
			this.#settleFrameCount = 0
			this.#settleDroppedFrameCount = 0
		}

		this.#settleFrameCount++

		if (this.#settle.timeout > 0 && clock - this.#settleStartTime >= this.#settle.timeout * 1000) {
			this.#settling = false
			this.#emitSettleDoneEvent(1, 'settle timeout')
			return
		}

		if (badFrame || lost || dx === undefined || dy === undefined) {
			this.#settleStableSince = 0
			this.#settleDroppedFrameCount++
			this.#emitSettlingEvent(0, timestamp, false, clock)
			return
		}

		const distance = Math.hypot(dx, dy)

		if (distance > this.#settle.pixels) {
			this.#settleStableSince = 0
			this.#emitSettlingEvent(distance, timestamp, true, clock)
			return
		}

		if (this.#settleStableSince === 0) {
			this.#settleStableSince = clock
			this.#emitSettlingEvent(distance, timestamp, true, clock)

			if (this.#settle.time <= 0) {
				this.#settling = false
				this.#emitSettleDoneEvent(0)
			}

			return
		}

		if (clock - this.#settleStableSince >= this.#settle.time * 1000) {
			this.#settling = false
			this.#emitSettleDoneEvent(0)
			return
		}

		this.#emitSettlingEvent(distance, timestamp, true, clock)
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
		const timestamp = frame.captureMonotonic ?? frame.timestamp ?? performance.now()

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
		const lockX = referenceX + this.#ditherOffsetX + this.#lockShiftOffsetX
		const lockY = referenceY + this.#ditherOffsetY + this.#lockShiftOffsetY
		let limitReached = false

		if (frame.width > 0 && frame.height > 0) {
			limitReached = lockX < 0 || lockX > frame.width - 1 || lockY < 0 || lockY > frame.height - 1
		}

		this.#syncGuideTargetOffset()

		if (!limitReached) {
			this.#lockPosition = [lockX, lockY] as const
			if (!this.#searchFollowsMeasurement) this.#lockSearchPosition = this.#lockPosition
		}

		if (limitReached) {
			if (!this.#lockShiftLimitReached) this.emitEvent('lockShiftLimitReached')
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
			this.#lockSearchPosition = [x, y]
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
		this.#exposureWatchdog = setTimeout(() => this.#onExposureWatchdog(attempt), timeout)
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

		this.emitEvent('alert', { message: 'guide exposure timed out; retrying', severity: 'warning' })
		if (!this.#captureActive || !this.#awaitingBlob || attempt !== this.#exposureAttempt) return

		if (this.#blobAdmission !== 'already-dropped') this.#blobAdmission = 'drop-next'
		const camera = this.#camera
		if (camera === undefined) return
		this.cameraManager.stopExposure(camera)
		this.#awaitingBlob = false
		this.#beginExposure()
	}

	// Records the cadence of this capture, starts it, and arms the missing-BLOB watchdog. A synchronous
	// camera-manager failure restores the prior cadence and releases BLOB ownership before rethrowing.
	// Public `startExposureLoop` from Stopped is allowed, so this checks the live camera
	// connection rather than `#captureActive` (false while Stopped). The watchdog still
	// arms only while capture is active.
	#beginExposure() {
		if (!this.#connected || this.#camera === undefined || this.#camera.connected !== true) return
		const previousExposureMs = this.#inFlightExposure
		const previousExposureStartedAt = this.#exposureStartedAt
		const previousExposureStartedMonotonic = this.#exposureStartedMonotonic
		const previousHasExposureStart = this.#hasExposureStart
		this.#exposureAttempt++
		this.#inFlightExposure = this.#exposure
		this.#exposureStartedAt = Date.now()
		this.#exposureStartedMonotonic = performance.now()
		this.#hasExposureStart = true
		this.#awaitingBlob = true

		try {
			this.cameraManager.startExposure(this.#camera, this.#exposure / 1000)
		} catch (error) {
			this.#inFlightExposure = previousExposureMs
			this.#exposureStartedAt = previousExposureStartedAt
			this.#exposureStartedMonotonic = previousExposureStartedMonotonic
			this.#hasExposureStart = previousHasExposureStart
			this.#awaitingBlob = false
			this.#clearExposureWatchdog()
			throw error
		}

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

	// Waits out a pulse of `duration` milliseconds dispatched now, on the window `guidePulseWindow` gives it:
	// GuideOutput pulse() only sends the timed-guide vector, and `device.pulsing` is updated later by
	// numberVector. A Busy is waited for until the window's busyAckDeadline, and once Busy the Idle until its
	// endsBy, so a Busy that arrives at the end of the acknowledgement margin still blocks capture until the mount
	// stops, without ever waiting past the window.
	async #waitForPulseToComplete(duration: number): Promise<void> {
		if (duration <= 0) return

		const { busyAckDeadline, endsBy } = guidePulseWindow(performance.now(), duration)
		const isBusy = () => this.#guideOutput?.pulsing === true

		while (!isBusy()) {
			const remaining = busyAckDeadline - performance.now()
			if (remaining <= 0) return
			await Bun.sleep(Math.min(10, remaining))
		}

		while (isBusy()) {
			const remaining = endsBy - performance.now()
			if (remaining <= 0) return
			await Bun.sleep(Math.min(10, remaining))
		}
	}

	// Resets transient guider state while optionally dropping calibration.
	#resetRuntimeState(clearCalibration: boolean, preserveGuidingAssistantResult: boolean = false) {
		this.#blobAdmission = 'accept'
		this.#awaitingBlob = false
		this.#hasExposureStart = false
		this.#exposureStartedAt = 0
		this.#exposureStartedMonotonic = 0
		this.#lastAcceptedCaptureMonotonic = undefined
		this.#clearExposureWatchdog()
		const guidingAssistantResult = preserveGuidingAssistantResult ? this.#guidingAssistantResult : undefined
		this.#frame = undefined
		this.#image = undefined
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
		this.#recenter = undefined
		this.#lockShiftOffsetX = 0
		this.#lockShiftOffsetY = 0
		this.#lockShiftTimestamp = 0
		this.#lockShiftLimitReached = false
		this.#lockShiftParams.enabled = false
		this.#lockShiftParams.rate = [0, 0]
		this.#lockShiftParams.units = 'pixels/hr'
		this.#lockShiftParams.axes = 'X/Y'
		this.#calibrator.reset()
		this.#tracker.reset()
		if (clearCalibration) this.#calibration = undefined
		this.#guider = this.#makeGuider(this.#calibration)
	}

	// Builds a guider instance from the caller tuning, current calibration, axis parity, and DEC mode.
	#makeGuider(calibration: GuidingCalibrationResult | undefined) {
		const tuning = this.options.guider

		if (calibration === undefined) {
			return new Guider({
				...tuning,
				decMode: declinationGuideModeOf(this.#declinationGuideMode),
				referencePosition: this.#guiderReferencePosition,
				initialPosition: this.#guiderInitialPosition,
				nominalCadence: this.#exposure,
			})
		}

		return new Guider({
			...tuning,
			...calibratedGuiderOptions(calibration, tuning),
			decMode: declinationGuideModeOf(this.#declinationGuideMode),
			referencePosition: this.#guiderReferencePosition,
			initialPosition: this.#guiderInitialPosition,
			nominalCadence: this.#exposure,
		})
	}

	// Pushes a solved calibration onto the running guider without reconstructing it, so lock,
	// hysteresis, and dither stay intact.
	#applyCalibrationToGuider(calibration: GuidingCalibrationResult) {
		const options = calibratedGuiderOptions(calibration, this.options.guider)
		this.#guider.setCalibration(options.calibration, options)
	}

	// Emits one native event of `type` with its `data`, stamped with the current Unix time in milliseconds, to
	// every registered event handler in registration order.
	emitEvent<T extends GuidingEventType>(type: T, ...[data]: GuidingEventData<T> extends Record<string, never> ? [] : [GuidingEventData<T>]) {
		if (this.#handlers.size === 0) return

		const event = { ...data, type, timestamp: Date.now() } as GuidingEvent

		for (const handler of this.#handlers) {
			try {
				handler.event?.(this, event)
			} catch (e) {
				// Event callbacks are user code; a throw must not unwind the exposure loop or skip the
				// remaining notifications for this frame.
				console.error('guide event handler failed:', e)
			}
		}
	}

	// Updates the current app state and emits stateChanged when it changed.
	#setAppState(appState: PHD2AppState) {
		const previous = this.#appState
		this.#appState = appState
		if (previous !== appState) this.emitEvent('stateChanged', { state: GUIDER_STATE[appState], previous: GUIDER_STATE[previous] })
	}

	// Emits the capture-stop events that match the current or paused-resume session mode.
	// Guiding implies looping in PHD2, so stopping an active guiding session reports both that
	// guiding ceased and that the exposure loop ceased, in that order.
	#emitCaptureStoppedEvent() {
		const appState = this.#appState === 'Paused' ? this.#resumeState : this.#appState

		if (appState === 'Stopped') return

		if (appState === 'Calibrating' || appState === 'Guiding' || appState === 'LostLock') {
			this.emitEvent('guidingStopped')
		}

		this.emitEvent('loopingStopped')
	}

	// Emits one passive frame event while exposures are looping.
	#emitLoopingExposuresEvent(frame: GuideFrame) {
		const telemetry = frame.tracking?.telemetry

		this.emitEvent('loopingFrame', {
			frameId: frame.frameId ?? 0,
			// Uses zero defaults when no star survives filtering in the current frame.
			mass: telemetry?.mass ?? 0,
			snr: telemetry?.signalToNoise ?? 0,
			hfd: telemetry?.hfdPx ?? 0,
		})
	}

	// Emits a calibration progress event from the latest calibrator diagnostics.
	#emitCalibratingEvent(diagnostics: GuidingCalibrationDiagnostics) {
		// Uses an empty name if the guide-output device is not available.
		this.emitEvent('calibrationStep', { guideOutput: this.#guideOutput?.name ?? '', diagnostics })
	}

	// Emits one guide-step event using the issued command and the guider diagnostics; recentering marks the pulses of a
	// fast recenter step, which are neither the controller's correction nor clipped by its per-axis maximum.
	#emitGuideStepEvent(frame: GuideFrame, command: GuideCommand, avgDistance: number, recentering: boolean = false) {
		const { diagnostics, ra, dec } = command
		const telemetry = command.tracking?.telemetry ?? frame.tracking?.telemetry
		const dx = diagnostics.dx ?? 0
		const dy = diagnostics.dy ?? 0
		const outputActive = !this.#paused && this.#guideOutputActive
		const raDuration = outputActive ? Math.round(ra.duration) : 0
		const decDuration = outputActive ? Math.round(dec.duration) : 0
		// An axis is only reported as limited when a pulse was actually issued and clipped by the
		// per-axis maximum duration, so a suppressed or zero-length pulse never claims a limit.
		const raLimited = !recentering && raDuration > 0 && ra.duration >= this.#guider.config.maxPulseMsRA
		const decLimited = !recentering && decDuration > 0 && dec.duration >= this.#guider.config.maxPulseMsDEC

		const raRate = this.#calibration?.ra.ratePxPerMs ?? 0
		const decRate = this.#calibration?.dec.ratePxPerMs ?? 0

		this.emitEvent('guideStep', {
			frameId: frame.frameId ?? 0,
			guidingTime: this.#guidingElapsedTime(frame.timestamp ?? 0),
			// Uses an empty name if the guide-output device is unavailable.
			guideOutput: this.#guideOutput?.name ?? '',
			dx,
			dy,
			// After calibration the controller's axis error is in milliseconds of pulse, so it is converted
			// back to pixels along the mount axes with the solved rate.
			raDistance: axisErrorToPixels(diagnostics.axisErrorRA, raRate),
			decDistance: axisErrorToPixels(diagnostics.axisErrorDEC, decRate),
			// A recenter step reports the move it issues, signed as a controller correction along the axis.
			raGuideDistance: !outputActive ? 0 : recentering ? axisErrorToPixels(ra.direction === this.#guider.config.raPositiveDirection ? ra.duration : -ra.duration, raRate) : axisErrorToPixels(diagnostics.filteredRA, raRate),
			decGuideDistance: !outputActive ? 0 : recentering ? axisErrorToPixels(dec.direction === this.#guider.config.decPositiveDirection ? dec.duration : -dec.duration, decRate) : axisErrorToPixels(diagnostics.filteredDEC, decRate),
			ra: { direction: ra.direction, requested: ra.duration, duration: raDuration, limited: raLimited },
			dec: { direction: dec.direction, requested: dec.duration, duration: decDuration, limited: decLimited },
			// Uses zero defaults when the guide frame has no measurable star metadata.
			mass: telemetry?.mass ?? 0,
			snr: telemetry?.signalToNoise ?? 0,
			hfd: telemetry?.hfdPx ?? 0,
			// The smoothed guide distance, not the raw current-frame distance.
			averageDistance: avgDistance,
			...(recentering && { recentering }),
			diagnostics,
		})
	}

	// Emits a star-lost event for the current frame.
	#emitStarLostEvent(frame: GuideFrame, command: GuideCommand) {
		const telemetry = command.tracking?.telemetry ?? frame.tracking?.telemetry

		this.emitEvent('starLost', {
			frameId: frame.frameId ?? 0,
			guidingTime: this.#guidingElapsedTime(frame.timestamp ?? 0),
			// Uses zero defaults when the lost-lock frame has no guide star measurement.
			mass: telemetry?.mass ?? 0,
			snr: telemetry?.signalToNoise ?? 0,
			hfd: telemetry?.hfdPx ?? 0,
			// The smoothed distance of the last successfully measured frames; a lost frame has no usable error
			// of its own, so the running average is left untouched.
			averageDistance: this.#avgDistance,
			notes: command.diagnostics.notes,
		})
	}

	// Updates and returns the smoothed guide distance in pixels from the current frame error, as PHD2 does.
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

	// Emits one in-progress settle event with the time in range and the requested settle duration.
	#emitSettlingEvent(distance: number, timestamp: number, starLocked: boolean, clock: number = timestamp) {
		this.emitEvent('settling', {
			distance,
			timeInRange: this.#settleStableSince === 0 ? 0 : (clock - this.#settleStableSince) * 0.001,
			settleTime: this.#settle.time,
			starLocked,
		})
	}

	// Emits the final settle status (0 on success, as PHD2 numbers it) and clears the local settle counters.
	#emitSettleDoneEvent(status: number, error?: string) {
		this.#guider.setDithering(false)
		this.emitEvent('settleDone', { succeeded: status === 0, totalFrames: this.#settleFrameCount, droppedFrames: this.#settleDroppedFrameCount, error })
		this.#settleFrameCount = 0
		this.#settleDroppedFrameCount = 0
	}
}

// Converts a pixel-unit guider threshold into calibrated axis units. After calibration the controller
// emits millisecond axis errors (the pulse that would cancel the pixel error), so pixel defaults are
// divided by the solved rate. When the rate is unknown the original threshold is kept so the
// uncalibrated identity controller is unchanged.
function calibratedGuiderOptions(calibration: GuidingCalibrationResult, tuning: GuiderClientGuiderOptions = {}) {
	// The solved image-to-axis matrix converts a pixel error into the milliseconds of pulse that
	// would reproduce it, while the guider expects a matrix that yields the pulse cancelling it,
	// so the matrix is negated here; feeding it unchanged closes the loop with positive feedback.
	// Its output is already in milliseconds, so the per-unit scaling must be neutral: keeping the
	// uncalibrated default would apply the mount rate twice and saturate every correction. Every
	// pixel-unit controller threshold (dead bands, DEC reversal, DEC backlash accumulation) is
	// converted with the solved rates so seeing-sized reversals still hold the DEC axis. Caller tuning
	// supplies those pixel thresholds when present.
	const [m00, m01, m10, m11] = calibration.imageToAxis
	const raRate = calibration.ra.ratePxPerMs
	const decRate = calibration.dec.ratePxPerMs

	return {
		calibration: [-m00, -m01, -m10, -m11] as const,
		msPerRAUnit: 1,
		msPerDECUnit: 1,
		minMoveRA: axisUnitThreshold(tuning.minMoveRA ?? DEFAULT_GUIDER_CONFIG.minMoveRA, raRate),
		minMoveDEC: axisUnitThreshold(tuning.minMoveDEC ?? DEFAULT_GUIDER_CONFIG.minMoveDEC, decRate),
		decReversalThreshold: axisUnitThreshold(tuning.decReversalThreshold ?? DEFAULT_GUIDER_CONFIG.decReversalThreshold, decRate),
		decBacklashAccumThreshold: axisUnitThreshold(tuning.decBacklashAccumThreshold ?? DEFAULT_GUIDER_CONFIG.decBacklashAccumThreshold, decRate),
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

// Remaining distance below which a fast recenter is done on both axes, in pixels, as PHD2's.
const RECENTER_DONE_PX = 0.5

// Fraction of the search half-side a fast recenter step covers, as PHD2's, so the star stays inside the search box.
const RECENTER_STEP_FRACTION = 0.7

// Fast recenter after a dither, along the mount axes, in pixels.
interface DitherRecenter {
	// Distance still to move along RA, non-negative.
	remainingRA: number
	// Distance still to move along DEC, non-negative.
	remainingDEC: number
	// Sign of the star's motion toward the new lock along RA, -1, 0 or 1.
	readonly signRA: number
	// Sign of the star's motion toward the new lock along DEC, -1, 0 or 1.
	readonly signDEC: number
	// Largest RA move of one step, non-negative.
	readonly stepRA: number
	// Largest DEC move of one step, non-negative.
	readonly stepDEC: number
}

// Returns the fast recenter of a dither of (dRa, dDec) pixels along the mount axes for a search square of searchRegion
// pixels per side, or undefined for a dither of zero length: each step covers RECENTER_STEP_FRACTION of the search
// half-side along the dither direction, split between the axes in proportion, as PHD2 computes it.
function ditherRecenterOf(dRa: number, dDec: number, searchRegion: number): DitherRecenter | undefined {
	const distance = Math.hypot(dRa, dDec)
	if (!(distance > 0)) return undefined
	const f = (RECENTER_STEP_FRACTION * searchRegion) / 2 / distance
	return { remainingRA: Math.abs(dRa), remainingDEC: Math.abs(dDec), signRA: Math.sign(dRa), signDEC: Math.sign(dDec), stepRA: f * Math.abs(dRa), stepDEC: f * Math.abs(dDec) }
}

// Rotates a mount-axis RA/DEC dither offset (pixels) into image X/Y with the calibrated axis unit vectors.
function ditherImageOffset(calibration: GuidingCalibrationResult, dRa: number, dDec: number) {
	return [calibration.ra.unitX * dRa + calibration.dec.unitX * dDec, calibration.ra.unitY * dRa + calibration.dec.unitY * dDec] as const
}

// Returns the latest generic measurement as an image-pixel position, allocating only when present.
function measurementPositionOf(result: GuideTrackerResult): readonly [number, number] | undefined {
	const measurement = result.measurement
	return measurement === undefined ? undefined : [measurement.x, measurement.y]
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
