import type { Image } from '../../imaging/model/types'

// Generic synchronous tracking contracts. Frames use image pixels for coordinates, Unix epoch
// milliseconds for timestamps, and optional images so a failed decode can still advance the guide
// pipeline without reusing pixels from an older frame.

// Phase of the surrounding guide-client state machine visible to a tracker.
export type GuideTrackingPhase = 'looping' | 'selected' | 'calibrating' | 'guiding' | 'lostLock' | 'assistant'

// Image and timing data for one logical guide frame. `image` is absent only when decoding failed.
export interface GuideTrackerFrame {
	// Decoded guide image for this frame, or undefined after a decode failure.
	readonly image?: Image
	// Frame width in pixels.
	readonly width: number
	// Frame height in pixels.
	readonly height: number
	// Capture timestamp in milliseconds since the Unix epoch.
	readonly timestamp: number
	// Monotonic logical frame identifier.
	readonly frameId: number
	// Exposure cadence that produced the image, in milliseconds.
	readonly cadence?: number
}

// Context supplied by the guide-client for one tracking operation.
export interface GuideTrackerContext {
	// Current guide-client phase.
	readonly phase: GuideTrackingPhase
	// Maximum per-frame movement that calibration is prepared to classify, in pixels. Stellar
	// trackers may use this as an association radius so a valid calibration pulse is measured before
	// the calibrator applies its jump policy.
	readonly maxMeasurementJumpPx?: number
	// Search-box center in image pixels, when a lock/search target exists.
	readonly searchPosition?: readonly [number, number]
	// Search-box side in pixels.
	readonly searchRegion?: number
	// Preferred acquisition position in image pixels.
	readonly initialPosition?: readonly [number, number]
	// Whether the tracker may acquire or reacquire a target on this frame.
	readonly allowAcquisition: boolean
	// Whether an existing target identity should be preferred over a fresh acquisition.
	readonly preserveIdentity: boolean
}

// Generic measured target position in image pixels.
export interface GuideMeasurement {
	// Measured X coordinate in pixels.
	readonly x: number
	// Measured Y coordinate in pixels.
	readonly y: number
	// Measurement confidence in the inclusive range [0, 1].
	readonly confidence: number
}

// Optional telemetry shared with PHD2-like consumers when a tracker can provide it.
export interface GuideTrackerTelemetry {
	// Signal-to-noise ratio in the tracker's native detector scale.
	readonly signalToNoise?: number
	// Integrated target mass/flux in the tracker's native detector scale.
	readonly mass?: number
	// Half-flux diameter in image pixels.
	readonly hfdPx?: number
}

// Result of tracking one logical frame. Arrays and diagnostics belong only to the current result.
export interface GuideTrackerResult {
	// Valid target measurement, or undefined when this frame cannot produce correction.
	readonly measurement?: GuideMeasurement
	// Number of candidates considered by the tracker.
	readonly candidateCount: number
	// Number of candidates accepted for the current tracking operation.
	readonly acceptedCount: number
	// Quality score in the inclusive range [0, 1] when the tracker can compute one.
	readonly qualityScore: number
	// Counts of rejected candidates grouped by stable diagnostic reason.
	readonly rejectedReasons: Readonly<Record<string, number>>
	// Deterministic notes describing acquisition, loss, fallback, and other frame decisions.
	readonly notes: readonly string[]
	// Target-relative tracker offset in image pixels, excluding dither and lock shift.
	readonly targetOffset?: readonly [number, number]
	// Informational measurement mode; controllers must not depend on a particular value.
	readonly measurementMode?: string
	// Optional tracker-specific telemetry.
	readonly telemetry?: GuideTrackerTelemetry
}

// Stateful synchronous tracker contract. `lastResult` is replaced for every call and contains no
// historical frame arrays.
export interface GuideTracker {
	// Clears identity and measurement state without performing I/O.
	readonly reset: () => void
	// Most recent frame result, if tracking has run.
	readonly lastResult?: GuideTrackerResult
	// Tracks one frame synchronously; it must not return a Promise or perform I/O.
	readonly track: (frame: GuideTrackerFrame, context: GuideTrackerContext) => GuideTrackerResult
	// Commits the latest candidate state after the consuming state machine accepts its frame.
	// Trackers that do not stage state may omit this callback.
	readonly commit?: () => void
}

// DTO consumed by the calibrator, controller, assistant, and overlay pipeline.
export interface GuideFrame {
	// Result produced by the tracker for this frame. Every production frame carries exactly one
	// result; fixture adapters should create it before invoking a state machine.
	readonly tracking: GuideTrackerResult
	// Frame width in pixels.
	readonly width: number
	// Frame height in pixels.
	readonly height: number
	// Capture timestamp in milliseconds since the Unix epoch.
	readonly timestamp?: number
	// Monotonic logical frame identifier.
	readonly frameId?: number
	// Exposure cadence that produced this frame, in milliseconds.
	readonly cadence?: number
}

// Minimal structural star shape accepted by the temporary fixture adapter.
export interface GuideTrackerStarLike {
	// Detection X coordinate in pixels.
	readonly x: number
	// Detection Y coordinate in pixels.
	readonly y: number
	// Detection signal-to-noise ratio.
	readonly snr: number
	// Detection integrated flux/mass.
	readonly flux: number
	// Detection half-flux diameter in pixels.
	readonly hfd: number
	// Optional detector and quality attributes retained by legacy fixtures.
	readonly valid?: boolean
	// Optional saturation flag.
	readonly saturated?: boolean
	// Optional sampled peak value.
	readonly peak?: number
	// Optional shape metrics.
	readonly ellipticity?: number
	readonly eccentricity?: number
	readonly elongation?: number
	// Optional FWHM in pixels.
	readonly fwhm?: number
}

// Builds a generic result from legacy guide-star fixtures during API migration. The adapter is not
// used by the production client and intentionally exposes only generic measurement/telemetry.
export function trackingResultFromStars(stars: readonly GuideTrackerStarLike[] = []): GuideTrackerResult {
	const primary = stars[0]
	const hasFiniteMeasurement = primary !== undefined && Number.isFinite(primary.x) && Number.isFinite(primary.y)
	return {
		measurement: hasFiniteMeasurement ? { x: primary.x, y: primary.y, confidence: 1 } : undefined,
		candidateCount: stars.length,
		acceptedCount: stars.length,
		qualityScore: stars.length > 0 ? 1 : 0,
		rejectedReasons: {},
		notes: [],
		measurementMode: primary === undefined ? undefined : 'singleStar',
		telemetry: primary === undefined ? undefined : { signalToNoise: primary.snr, mass: primary.flux, hfdPx: primary.hfd },
	}
}

// Returns the single generic result attached to a guide frame.
export function trackingOf(frame: GuideFrame): GuideTrackerResult {
	return frame.tracking
}
