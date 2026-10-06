import { PI } from 'nebulosa/src/core/constants'
import type { ImageAnalysisPlane } from '../../imaging/analysis/plane'
import { DEFAULT_LIMB_TRACKING_OPTIONS, type LimbGeometry, type LimbMeasurement, type LimbTrackingOptions, locateBrightObject, measureLimb } from '../../imaging/analysis/tracking/limb'
// oxfmt-ignore
import { applyRigidTransform, composeRigidTransforms, createSurfaceReference, DEFAULT_SURFACE_TRACKING_OPTIONS, IDENTITY_RIGID_TRANSFORM, invertRigidTransform, reacquireSurface, registerSurface, type RigidTransform2D, type SurfaceReference, type SurfaceRegistration, type SurfaceTrackingOptions, selectSurfacePlane } from '../../imaging/analysis/tracking/surface'
import { SurfaceTrackingWorkspace } from '../../imaging/analysis/tracking/workspace'
import type { Image } from '../../imaging/model/types'
import type { Rect } from '../../math/numerical/geometry'
import type { GuideTargetEnvelope, GuideTracker, GuideTrackerContext, GuideTrackerFrame, GuideTrackerResult } from './tracker'

// Extended-object guide tracker for planetary, Lunar and Solar imaging without a star detector. Surface
// registration (multi-patch ZNCC with a robust rigid fit) measures short-term motion; a limb ellipse
// anchors the absolute object center when the whole disk is visible. Two target semantics exist:
// `surfacePoint` transports a selected image point by the measured anchor-to-current rigid transform, and
// `objectCenter` publishes the limb-anchored object center (or, without a usable limb, the apparent-object
// anchor chosen at acquisition, which is not necessarily the physical center). Capabilities are promotable:
// an apparent-object identity converges onto a later confident limb, and a limb-only identity gains a
// surface anchor once structure appears, both without a target jump.
//
// The immutable anchor bounds keyframe-chain drift through periodic direct checks. Checks that keep failing
// while a keyframe still registers freeze promotions and degrade the state, then withhold measurements;
// in `objectCenter`, a limb-verified frame instead rebuilds the anchor. Maintenance cadences require both a
// committed-frame count and, when configured, an elapsed capture time, so high-rate streams do not churn.
//
// Coordinates are received full-frame image pixels with pixel centers at integers, origin upper left,
// +X right and +Y down; rotations are radians from +X toward +Y. `track()` stages acquisition, transform,
// limb and keyframe updates; only `commit()` promotes them, so rejected frames never advance identity.
// The tracker retains no caller image: references hold bounded preprocessed samples, the keyframe bank is
// bounded, and analysis buffers live in one reusable workspace. It is not adaptive optics: atmospheric
// tip/tilt is measured as image motion and must be filtered by the guider correction cadence.

// Guiding preset family.
export type SolarSystemTrackingMode = 'planetary' | 'lunar' | 'solar'

// Published target semantics.
export type SolarSystemTargetMode = 'objectCenter' | 'surfacePoint'

// Tracker lifecycle state.
export type SolarSystemTrackingState = 'idle' | 'acquiring' | 'tracking' | 'degraded' | 'lost'

// Source of a published measurement.
export type SolarSystemMeasurementMode = 'surface' | 'limb' | 'hybrid' | 'surfaceReacquired' | 'limbReacquired'

// Acquisition, tracking-area and failure policy.
export interface SolarSystemAcquisitionOptions {
	// Side of the square surfacePoint tracking ROI, in image pixels.
	readonly areaSize: number
	// Largest objectCenter tracking ROI side, in image pixels.
	readonly maximumAreaSize: number
	// Margin added around the object radius for the objectCenter ROI, in image pixels.
	readonly objectMargin: number
	// Minimum distance between a commanded target and the detector edge, in image pixels.
	readonly edgeMargin: number
	// Committed frames between limb measurements; objectCenter uses at least 1, 0 disables surfacePoint limbs.
	readonly limbInterval: number
	// Consecutive failed frames before the state changes from degraded to lost.
	readonly lostAfter: number
	// Fraction of the surface-to-limb center difference applied per limb frame in objectCenter mode, in [0, 1].
	readonly limbGain: number
	// Base surface/limb or reference agreement tolerance, in image pixels, added to 3-sigma uncertainties.
	readonly consistencyTolerance: number
}

// Anchor/keyframe bank policy.
export interface SolarSystemReferenceOptions {
	// Maximum keyframes kept in addition to the immutable anchor; 0 disables promotion.
	readonly maximumKeyframes: number
	// Committed frames since the last promotion before a new keyframe may be promoted.
	readonly keyframeInterval: number
	// Capture time since the last promotion that must also elapse before a time-due promotion, in
	// milliseconds; 0 uses the frame count alone. The displacement trigger ignores it.
	readonly keyframeIntervalTime: number
	// Working-reference displacement, relative to the smaller ROI side, that also triggers promotion.
	readonly keyframeShiftFraction: number
	// Minimum surface confidence of a frame whose samples may become a keyframe, in [0, 1].
	readonly minimumPromotionConfidence: number
	// Committed frames between direct anchor consistency checks while a keyframe is in use, and between
	// surface-anchor creation attempts of a limb-only identity.
	readonly anchorCheckInterval: number
	// Capture time that must also elapse between those checks or attempts, in milliseconds; 0 uses the frame
	// count alone. A failed keyframe registration always checks the anchor immediately.
	readonly anchorCheckIntervalTime: number
	// Consecutive failed direct anchor checks tolerated, with promotions frozen and a degraded state, before
	// measurements are withheld until the anchor registers again; 0 withholds on the first failure.
	readonly maximumAnchorCheckFailures: number
}

// User options; omitted groups and fields come from the mode preset.
export interface SolarSystemTrackerOptions {
	// Preset family.
	readonly mode: SolarSystemTrackingMode
	// Target semantics; planetary defaults to objectCenter, Lunar and Solar to surfacePoint.
	readonly targetMode?: SolarSystemTargetMode
	// Preferred tracking/acquisition ROI in image pixels, left/top inclusive and right/bottom exclusive.
	readonly area?: Readonly<Rect>
	// Analysis plane, or 'auto' to choose the best-scoring plane at acquisition.
	readonly plane?: 'auto' | ImageAnalysisPlane
	// Surface-registration overrides.
	readonly surface?: Partial<SurfaceTrackingOptions>
	// Limb-measurement overrides.
	readonly limb?: Partial<LimbTrackingOptions>
	// Reference-bank overrides.
	readonly reference?: Partial<SolarSystemReferenceOptions>
	// Acquisition and failure-policy overrides.
	readonly acquisition?: Partial<SolarSystemAcquisitionOptions>
}

// Fully resolved tracker configuration.
export interface SolarSystemTrackerConfig {
	// Preset family.
	readonly mode: SolarSystemTrackingMode
	// Target semantics.
	readonly targetMode: SolarSystemTargetMode
	// Preferred ROI in image pixels.
	readonly area?: Readonly<Rect>
	// Analysis plane or automatic choice.
	readonly plane: 'auto' | ImageAnalysisPlane
	// Surface registration options.
	readonly surface: SurfaceTrackingOptions
	// Limb measurement options.
	readonly limb: LimbTrackingOptions
	// Reference-bank options.
	readonly reference: SolarSystemReferenceOptions
	// Acquisition and failure-policy options.
	readonly acquisition: SolarSystemAcquisitionOptions
}

// Mode preset; partial surface and limb groups are merged over the module defaults.
export interface SolarSystemTrackingPreset {
	// Default target semantics.
	readonly targetMode: SolarSystemTargetMode
	// Surface overrides relative to DEFAULT_SURFACE_TRACKING_OPTIONS.
	readonly surface: Partial<SurfaceTrackingOptions>
	// Limb overrides relative to DEFAULT_LIMB_TRACKING_OPTIONS.
	readonly limb: Partial<LimbTrackingOptions>
	// Reference-bank policy.
	readonly reference: SolarSystemReferenceOptions
	// Acquisition and failure policy.
	readonly acquisition: SolarSystemAcquisitionOptions
}

// Mode presets. Planets use a compact object ROI and a limb every frame; Lunar and Solar surfaces use larger
// texture ROIs, more patches and no routine limb, with slower Lunar keyframe aging than Solar. Time intervals
// match the frame intervals at 2 frames/s, so faster streams are throttled to the same maintenance rate.
export const SOLAR_SYSTEM_TRACKING_PRESETS: Readonly<Record<SolarSystemTrackingMode, SolarSystemTrackingPreset>> = {
	planetary: {
		targetMode: 'objectCenter',
		surface: { patchSize: 24, maximumPatches: 24 },
		limb: {},
		reference: { maximumKeyframes: 3, keyframeInterval: 15, keyframeIntervalTime: 7500, keyframeShiftFraction: 0.15, minimumPromotionConfidence: 0.6, anchorCheckInterval: 10, anchorCheckIntervalTime: 5000, maximumAnchorCheckFailures: 3 },
		acquisition: { areaSize: 192, maximumAreaSize: 384, objectMargin: 12, edgeMargin: 8, limbInterval: 1, lostAfter: 5, limbGain: 0.1, consistencyTolerance: 1.5 },
	},
	lunar: {
		targetMode: 'surfacePoint',
		surface: { patchSize: 32, maximumPatches: 32 },
		limb: {},
		reference: { maximumKeyframes: 3, keyframeInterval: 60, keyframeIntervalTime: 30000, keyframeShiftFraction: 0.2, minimumPromotionConfidence: 0.6, anchorCheckInterval: 15, anchorCheckIntervalTime: 7500, maximumAnchorCheckFailures: 3 },
		acquisition: { areaSize: 256, maximumAreaSize: 512, objectMargin: 16, edgeMargin: 8, limbInterval: 0, lostAfter: 5, limbGain: 0.1, consistencyTolerance: 1.5 },
	},
	solar: {
		targetMode: 'surfacePoint',
		surface: { patchSize: 32, maximumPatches: 32, minimumRelativeStructure: 0.01 },
		limb: {},
		reference: { maximumKeyframes: 3, keyframeInterval: 30, keyframeIntervalTime: 15000, keyframeShiftFraction: 0.15, minimumPromotionConfidence: 0.6, anchorCheckInterval: 10, anchorCheckIntervalTime: 5000, maximumAnchorCheckFailures: 3 },
		acquisition: { areaSize: 256, maximumAreaSize: 512, objectMargin: 16, edgeMargin: 8, limbInterval: 0, lostAfter: 5, limbGain: 0.1, consistencyTolerance: 1.5 },
	},
}

// Surface-registration diagnostic of the frame.
export interface SolarSystemSurfaceDiagnostic {
	// Reference patches evaluated.
	readonly candidatePatches: number
	// Robust inlier patches.
	readonly acceptedPatches: number
	// Fraction of reference coverage cells with inliers, in [0, 1].
	readonly spatialCoverage: number
	// RMS inlier residual, in image pixels.
	readonly rmsResidual: number
	// Median inlier ZNCC peak.
	readonly medianCorrelation: number
	// Median inlier peak-to-sidelobe ratio.
	readonly medianPSR: number
	// Robust residual sigma of all matched patches (differential seeing), in image pixels.
	readonly deformationRms: number
	// 1-sigma transform uncertainty at the patch centroid, in image pixels.
	readonly uncertaintyPx: number
	// Fitted motion model.
	readonly model: 'rigid' | 'translation'
}

// Limb diagnostic of the frame in image pixels.
export interface SolarSystemLimbDiagnostic {
	// Ellipse center [x, y], in image pixels.
	readonly center: readonly [number, number]
	// Semi-major axis, in image pixels.
	readonly semiMajor: number
	// Semi-minor axis, in image pixels.
	readonly semiMinor: number
	// Major-axis angle in [0, PI), radians from +X toward +Y.
	readonly theta: number
	// Ellipse RMS residual, in image pixels.
	readonly rms: number
	// Fraction of rays with accepted edges, in [0, 1].
	readonly coverage: number
	// Largest angular gap without accepted edges, in radians.
	readonly maximumGap: number
	// Limb confidence in [0, 1].
	readonly confidence: number
}

// Reference-bank diagnostic.
export interface SolarSystemReferenceDiagnostic {
	// Generation of the reference used for this frame; the anchor of an identity has the lowest generation.
	readonly generation: number
	// Committed frames since the last keyframe promotion.
	readonly ageFrames: number
	// Number of retained references including the anchor.
	readonly bankSize: number
	// Whether the anchor was registered directly on this frame.
	readonly directAnchorCheck: boolean
	// Consecutive failed direct anchor checks while a keyframe still registers.
	readonly anchorCheckFailures: number
	// Whether this frame built a new anchor (limb reacquisition, limb verification or first surface anchor)
	// or discarded inconsistent keyframes.
	readonly reanchored: boolean
}

// Specialized per-frame diagnostic; every coordinate is a full-frame image pixel.
export interface SolarSystemTrackingDiagnostic {
	// Preset family.
	readonly mode: SolarSystemTrackingMode
	// Target semantics.
	readonly targetMode: SolarSystemTargetMode
	// Lifecycle state after this frame.
	readonly state: SolarSystemTrackingState
	// Measurement source when a measurement was published.
	readonly measurementMode?: SolarSystemMeasurementMode
	// Analysis plane of the identity.
	readonly plane?: ImageAnalysisPlane
	// Current tracking ROI, left/top inclusive and right/bottom exclusive.
	readonly area?: Readonly<Rect>
	// Target before limb fusion (surface-transported point or limb center).
	readonly rawTarget?: readonly [number, number]
	// Target predicted from the last committed transform.
	readonly predictedTarget?: readonly [number, number]
	// Anchor-to-current rigid transform.
	readonly transform?: RigidTransform2D
	// Image rotation since the anchor, in radians.
	readonly rotation?: number
	// Surface registration evidence.
	readonly surface?: SolarSystemSurfaceDiagnostic
	// Limb geometry evidence.
	readonly limb?: SolarSystemLimbDiagnostic
	// Reference-bank state.
	readonly reference?: SolarSystemReferenceDiagnostic
}

// Generic result extended with the specialized diagnostic.
export interface SolarSystemTrackerResult extends GuideTrackerResult {
	// Solar-System tracking diagnostic.
	readonly solarSystem: SolarSystemTrackingDiagnostic
}

// Returns the Solar-System diagnostic carried by a generic tracker result, if any.
export function solarSystemTrackingOf(result: GuideTrackerResult | undefined): SolarSystemTrackingDiagnostic | undefined {
	if (result === undefined || !('solarSystem' in result)) return undefined
	return (result as SolarSystemTrackerResult).solarSystem
}

// Minimum limb confidence, in [0, 1], for an apparent-object objectCenter identity to adopt the limb as its
// center authority; stricter than the 0.5 tracking threshold because the promotion is permanent.
const LIMB_ANCHOR_CONFIDENCE = 0.8

// Surface reference placed in the identity's anchor coordinates.
interface BankReference {
	// Preprocessed reference samples and patches.
	readonly surface: SurfaceReference
	// Anchor-image to reference-image transform at capture.
	readonly fromAnchor: RigidTransform2D
	// Monotonic generation number.
	readonly generation: number
}

// Identity state; the committed copy changes only through commit().
interface SolarSystemIdentity {
	// Analysis plane fixed until reset or reacquisition.
	readonly plane: ImageAnalysisPlane
	// Target in anchor-image pixels.
	readonly target: readonly [number, number]
	// Whether the target derives from a fitted limb (objectCenter fusion is enabled).
	readonly limbAnchored: boolean
	// Surface-to-limb offset still being converged after a limb promotion, in image pixels; widens the
	// fusion tolerance and shrinks by the limb gain on every fused frame.
	readonly limbConvergence: number
	// Immutable surface anchor, absent for a limb-only identity.
	readonly anchor?: BankReference
	// Bounded keyframes, oldest first.
	readonly keyframes: readonly BankReference[]
	// Anchor-to-frame transform of the frame this identity was staged from.
	readonly transform: RigidTransform2D
	// Latest limb in that frame's coordinates.
	readonly limb?: LimbGeometry
	// Object radius in image pixels when known.
	readonly objectRadius?: number
	// Last issued generation.
	readonly generation: number
	// Committed frames since keyframe promotion.
	readonly framesSincePromotion: number
	// Capture clock of the last promotion or anchor creation, in milliseconds, when known.
	readonly promotionTime?: number
	// Committed frames since the last limb measurement.
	readonly framesSinceLimb: number
	// Committed frames since the last direct anchor check or surface-anchor creation attempt.
	readonly framesSinceAnchorCheck: number
	// Capture clock of that check or attempt, in milliseconds, when known.
	readonly anchorCheckTime?: number
	// Consecutive failed direct anchor checks while a keyframe still registers.
	readonly anchorCheckFailures: number
}

// Frame-local outcome assembled before publishing.
interface FrameOutcome {
	readonly point?: readonly [number, number]
	readonly confidence: number
	// Forces the degraded state for a measurement that is published but not fully verified.
	readonly degraded?: boolean
	readonly measurementMode?: SolarSystemMeasurementMode
	readonly candidateCount: number
	readonly acceptedCount: number
	readonly reasons: Record<string, number>
	readonly notes: string[]
	readonly diagnostic: Omit<SolarSystemTrackingDiagnostic, 'mode' | 'targetMode' | 'state'>
	readonly objectRadius?: number
}

// Synchronous extended-object tracker implementing the generic guide-tracker contract.
export class SolarSystemTracker implements GuideTracker {
	readonly config: SolarSystemTrackerConfig
	readonly #workspace = new SurfaceTrackingWorkspace()
	#identity?: SolarSystemIdentity
	#pending?: SolarSystemIdentity
	#lastResult?: SolarSystemTrackerResult
	#failures = 0
	#width = 0
	#height = 0

	constructor(options: SolarSystemTrackerOptions) {
		const preset = SOLAR_SYSTEM_TRACKING_PRESETS[options.mode]

		this.config = {
			mode: options.mode,
			targetMode: options.targetMode ?? preset.targetMode,
			area: options.area,
			plane: options.plane ?? 'auto',
			surface: { ...DEFAULT_SURFACE_TRACKING_OPTIONS, ...preset.surface, ...options.surface },
			limb: { ...DEFAULT_LIMB_TRACKING_OPTIONS, ...preset.limb, ...options.limb },
			reference: { ...preset.reference, ...options.reference },
			acquisition: { ...preset.acquisition, ...options.acquisition },
		}
	}

	// Most recent frame result.
	get lastResult() {
		return this.#lastResult
	}

	// Clears plane choice, anchor, keyframes, predictor, limb model, staged state and the last result.
	reset() {
		this.#identity = undefined
		this.#pending = undefined
		this.#lastResult = undefined
		this.#failures = 0
		this.#width = 0
		this.#height = 0
	}

	// Promotes the state staged by the latest track() call; a no-op after a rejected frame.
	commit() {
		if (this.#pending === undefined) return
		this.#identity = this.#pending
		this.#pending = undefined
	}

	// Selects a target from a result of this tracker without mutating state. Without position, objectCenter
	// prefers a confident limb center and otherwise the measurement. A requested position (image pixels)
	// selects the limb center when it falls on the measured disk in objectCenter mode, is returned as-is when
	// it lies inside the result's target envelope, and is declined otherwise.
	select(result: GuideTrackerResult, position?: readonly [number, number]): readonly [number, number] | undefined {
		const diagnostic = solarSystemTrackingOf(result)
		if (diagnostic === undefined) return undefined
		const limb = diagnostic.limb

		if (position !== undefined) {
			if (diagnostic.targetMode === 'objectCenter' && limb !== undefined && Math.hypot(position[0] - limb.center[0], position[1] - limb.center[1]) <= limb.semiMajor) return [limb.center[0], limb.center[1]]
			const envelope = result.targetEnvelope
			if (envelope === undefined || !(position[0] >= envelope.minX && position[0] <= envelope.maxX && position[1] >= envelope.minY && position[1] <= envelope.maxY)) return undefined
			return [position[0], position[1]]
		}

		if (diagnostic.targetMode === 'objectCenter' && limb !== undefined && limb.confidence >= 0.5) return [limb.center[0], limb.center[1]]
		return result.measurement === undefined ? undefined : [result.measurement.x, result.measurement.y]
	}

	// Tracks one frame synchronously. Acquires when no committed identity exists or identity need not be
	// preserved; otherwise registers against the committed references, fuses the limb and stages updates.
	track(frame: GuideTrackerFrame, context: GuideTrackerContext): SolarSystemTrackerResult {
		this.#pending = undefined

		// A different detector geometry invalidates every image-space reference.
		if (frame.width !== this.#width || frame.height !== this.#height) {
			this.#identity = undefined
			this.#failures = 0
			this.#width = frame.width
			this.#height = frame.height
		}

		const image = frame.image
		if (image === undefined) return this.#publish(frame, failed({ image_unavailable: 1 }, ['image_unavailable']))

		const identity = this.#identity

		if (identity === undefined || !context.preserveIdentity) {
			if (!context.allowAcquisition) return this.#publish(frame, failed({}, ['acquisition_disabled']))
			return this.#publish(frame, this.#acquire(frame, image, context))
		}

		return this.#publish(frame, this.#follow(frame, image, context, identity))
	}

	// Builds a new identity around the seed (search position, initial position, configured area center,
	// object center or frame center) and stages it.
	#acquire(frame: GuideTrackerFrame, image: Image, context: GuideTrackerContext): FrameOutcome {
		const { acquisition, targetMode, surface, limb: limbOptions } = this.config
		const { width, height } = frame
		const reasons: Record<string, number> = {}
		const full: Rect = { left: 0, top: 0, right: width, bottom: height }
		const configured = this.config.area === undefined ? undefined : intersectArea(this.config.area, width, height)
		const seed = context.searchPosition ?? context.initialPosition ?? (configured === undefined ? undefined : areaCenter(configured))
		const searchArea = configured ?? (seed === undefined ? full : squareArea(seed, acquisition.maximumAreaSize, width, height))
		const plane = this.config.plane === 'auto' ? selectSurfacePlane(image, searchArea, this.#workspace, surface.saturationLevel) : this.config.plane
		if (plane === undefined) return failed({ lowContrast: 1 }, ['acquisition_failed'])

		let target: readonly [number, number]
		let area: Rect
		let limb: LimbMeasurement | undefined
		let objectRadius: number | undefined
		const notes: string[] = []

		if (targetMode === 'objectCenter' || acquisition.limbInterval > 0) {
			const outcome = measureLimb(image, plane, configured ?? full, this.#workspace, limbOptions, seed === undefined ? {} : { seed })
			if (outcome.success) limb = outcome.limb
			else increment(reasons, outcome.reason)
		}

		if (targetMode === 'objectCenter') {
			if (limb !== undefined) {
				target = limb.center
				objectRadius = limb.semiMajor
			} else {
				// Rings, crescents and unresolved disks fall back to a stable apparent-object anchor.
				const object = locateBrightObject(image, plane, configured ?? full, this.#workspace, limbOptions, seed)
				if (object === undefined) return failed(reasons, ['acquisition_failed'])
				target = object.center
				objectRadius = object.radius
				notes.push('apparent_object_anchor')
			}

			area = this.#objectArea(target, objectRadius, width, height)
		} else {
			target = seed ?? (limb === undefined ? [(width - 1) * 0.5, (height - 1) * 0.5] : limb.center)
			objectRadius = limb?.semiMajor
			area = configured !== undefined && insideArea(configured, target) ? configured : squareArea(target, acquisition.areaSize, width, height)
		}

		const created = createSurfaceReference(image, area, plane, this.#workspace, surface)
		mergeReasons(reasons, created.rejectedReasons)
		const anchor: BankReference | undefined = created.success ? { surface: created.reference, fromAnchor: IDENTITY_RIGID_TRANSFORM, generation: 0 } : undefined
		// A surfacePoint has no identity without surface structure; objectCenter may continue on its limb alone.
		if (anchor === undefined && (targetMode === 'surfacePoint' || limb === undefined)) return failed(reasons, ['acquisition_failed'], { plane, area })

		const surfaceConfidence = anchor === undefined ? 0 : referenceConfidence(anchor.surface)
		const confidence = limb === undefined ? surfaceConfidence : limb.confidence
		const measurementMode: SolarSystemMeasurementMode = targetMode === 'surfacePoint' || limb === undefined ? 'surface' : anchor === undefined ? 'limb' : 'hybrid'
		const limbGeometry = limb === undefined ? undefined : limbGeometryOf(limb)

		const now = frameClock(frame)
		this.#pending = {
			plane,
			target,
			limbAnchored: targetMode === 'objectCenter' && limb !== undefined,
			limbConvergence: 0,
			anchor,
			keyframes: [],
			transform: IDENTITY_RIGID_TRANSFORM,
			limb: limbGeometry,
			objectRadius,
			generation: 0,
			framesSincePromotion: 0,
			promotionTime: now,
			framesSinceLimb: 0,
			framesSinceAnchorCheck: 0,
			anchorCheckTime: now,
			anchorCheckFailures: 0,
		}
		notes.unshift('acquired')

		return {
			point: target,
			confidence,
			measurementMode,
			candidateCount: anchor?.surface.patches.length ?? 0,
			acceptedCount: anchor?.surface.patches.length ?? limb?.rays.accepted ?? 0,
			reasons,
			notes,
			objectRadius,
			diagnostic: {
				measurementMode,
				plane,
				area,
				rawTarget: target,
				transform: IDENTITY_RIGID_TRANSFORM,
				rotation: 0,
				limb: limb === undefined ? undefined : limbDiagnosticOf(limb),
				reference: { generation: 0, ageFrames: 0, bankSize: anchor === undefined ? 0 : 1, directAnchorCheck: false, anchorCheckFailures: 0, reanchored: false },
			},
		}
	}

	// Registers the frame to the committed references, measures the limb when due, fuses both according to
	// the target semantics, applies the capability-promotion and anchor-validation policies and stages the
	// next identity when a measurement is published.
	#follow(frame: GuideTrackerFrame, image: Image, context: GuideTrackerContext, identity: SolarSystemIdentity): FrameOutcome {
		const { acquisition, reference: bankOptions, targetMode, limb: limbOptions } = this.config
		const { width, height } = frame
		const reasons: Record<string, number> = {}
		const notes: string[] = []
		const surface = this.#surfaceOptionsFor(context)
		const now = frameClock(frame)
		// Calibration measures pulse response; identity capabilities and anchors change only outside it.
		const maintaining = context.phase !== 'calibrating'
		const anchorCheckDue = maintenanceDue(identity.framesSinceAnchorCheck + 1, bankOptions.anchorCheckInterval, now, identity.anchorCheckTime, bankOptions.anchorCheckIntervalTime)
		const predicted = applyRigidTransform(identity.transform, identity.target[0], identity.target[1])
		let registration: SurfaceRegistration | undefined
		let transform: RigidTransform2D | undefined
		let used: BankReference | undefined
		let directAnchorCheck = false
		let anchorChecked = false
		let anchorCheckFailed = false
		let reacquired = false
		let keyframes = identity.keyframes

		if (identity.anchor !== undefined) {
			const anchor = identity.anchor
			const working = keyframes.at(-1) ?? anchor
			registration = this.#register(working, image, identity.transform, surface, reasons)
			if (registration !== undefined) used = working

			// A failed keyframe falls back to the anchor; a periodic direct check bounds keyframe drift.
			if (working !== anchor && (registration === undefined || anchorCheckDue)) {
				anchorChecked = true
				const direct = this.#register(anchor, image, identity.transform, surface, reasons)

				if (direct !== undefined) {
					directAnchorCheck = true

					if (registration === undefined) {
						registration = direct
						used = anchor
					} else {
						const viaKeyframe = applyRigidTransform(composeRigidTransforms(registration.transform, working.fromAnchor), identity.target[0], identity.target[1])
						const viaAnchor = applyRigidTransform(direct.transform, identity.target[0], identity.target[1])
						const tolerance = acquisition.consistencyTolerance + 3 * (registration.uncertainty + direct.uncertainty)

						if (!(Math.hypot(viaKeyframe[0] - viaAnchor[0], viaKeyframe[1] - viaAnchor[1]) <= tolerance)) {
							// The anchor is the identity authority; drifted keyframes are discarded.
							increment(reasons, 'reference_inconsistent')
							notes.push('keyframes_discarded')
							registration = direct
							used = anchor
							keyframes = []
						}
					}
				} else if (registration !== undefined) {
					// The keyframe chain still registers but can no longer be verified against the anchor.
					anchorCheckFailed = true
				}
			}

			// Large displacements (calibration pulses, bumps, lost lock) use verified coarse reacquisition.
			if (registration === undefined && context.allowAcquisition) {
				const outcome = reacquireSurface(anchor.surface, image, identity.transform, this.#workspace, surface)

				if (outcome.success) {
					registration = outcome
					used = anchor
					reacquired = true
					notes.push('reacquired')
				} else {
					mergeReasons(reasons, outcome.rejectedReasons)
				}
			}

			if (registration !== undefined && used !== undefined) transform = composeRigidTransforms(registration.transform, used.fromAnchor)
		}

		// The committed limb is carried into this frame by the measured surface motion.
		let prior = identity.limb

		if (prior !== undefined && transform !== undefined) {
			const delta = composeRigidTransforms(transform, invertRigidTransform(identity.transform))
			prior = { center: applyRigidTransform(delta, prior.center[0], prior.center[1]), semiMajor: prior.semiMajor, semiMinor: prior.semiMinor, theta: wrapHalfTurn(prior.theta + delta.rotation) }
		}

		const limbEvery = targetMode === 'objectCenter' ? Math.max(1, acquisition.limbInterval) : acquisition.limbInterval
		let limb: LimbMeasurement | undefined
		let limbMeasured = false

		if (limbEvery > 0 && (identity.framesSinceLimb + 1 >= limbEvery || registration === undefined)) {
			limbMeasured = true
			const full: Rect = { left: 0, top: 0, right: width, bottom: height }
			const configured = this.config.area === undefined ? undefined : intersectArea(this.config.area, width, height)
			const area = prior === undefined ? (configured ?? full) : limbArea(prior, limbOptions.searchFraction, width, height)
			const outcome = measureLimb(image, identity.plane, area, this.#workspace, limbOptions, prior === undefined ? { seed: predicted } : { prior, continuity: true })
			if (outcome.success) limb = outcome.limb
			else increment(reasons, outcome.reason)
		}

		let target = identity.target
		let point: readonly [number, number] | undefined
		let rawTarget: readonly [number, number] | undefined
		let confidence = 0
		let measurementMode: SolarSystemMeasurementMode | undefined
		let anchor = identity.anchor
		let generation = identity.generation
		let limbAnchored = identity.limbAnchored
		let limbConvergence = identity.limbConvergence
		let anchorCreated = false
		let reanchored = keyframes !== identity.keyframes
		const surfacePoint = transform === undefined ? undefined : applyRigidTransform(transform, target[0], target[1])

		// An apparent-object identity adopts a confident limb whose center lies on the tracked object. The
		// surface-to-limb offset widens the fusion gate and is removed by the limb gain, so the target converges
		// onto the limb center without a jump while the surface anchor is kept.
		if (targetMode === 'objectCenter' && !limbAnchored && maintaining && limb !== undefined && limb.confidence >= LIMB_ANCHOR_CONFIDENCE && surfacePoint !== undefined && registration !== undefined) {
			const offset = Math.hypot(limb.center[0] - surfacePoint[0], limb.center[1] - surfacePoint[1])

			if (offset <= limb.semiMinor) {
				limbAnchored = true
				limbConvergence = offset
				notes.push('limb_anchored')
			}
		}

		// Only a limb-anchored objectCenter identity may be moved by limb geometry.
		const fuseLimb = targetMode === 'objectCenter' && limbAnchored ? limb : undefined

		if (surfacePoint !== undefined && registration !== undefined && transform !== undefined) {
			rawTarget = surfacePoint

			if (fuseLimb !== undefined) {
				const dx = fuseLimb.center[0] - surfacePoint[0]
				const dy = fuseLimb.center[1] - surfacePoint[1]
				const tolerance = acquisition.consistencyTolerance + 3 * (registration.uncertainty + fuseLimb.rms) + limbConvergence

				if (Math.hypot(dx, dy) <= tolerance) {
					// The anchor-frame target follows the fused point, so limb anchoring never jumps the output.
					point = [surfacePoint[0] + acquisition.limbGain * dx, surfacePoint[1] + acquisition.limbGain * dy]
					target = applyRigidTransform(invertRigidTransform(transform), point[0], point[1])
					confidence = Math.sqrt(registration.confidence * fuseLimb.confidence)
					measurementMode = 'hybrid'
					limbConvergence *= 1 - acquisition.limbGain
				} else {
					// Strong but conflicting evidence: missing a correction is safer than issuing a wrong one.
					increment(reasons, 'reference_inconsistent')
					notes.push('surface_limb_conflict')
				}
			} else {
				point = surfacePoint
				confidence = registration.confidence
				measurementMode = reacquired ? 'surfaceReacquired' : 'surface'
			}
		} else if (fuseLimb !== undefined) {
			rawTarget = fuseLimb.center
			point = fuseLimb.center
			confidence = fuseLimb.confidence
			measurementMode = 'limb'
			limbConvergence = 0
			// Hold the last rotation and move the anchor transform so it maps the target onto the limb center.
			const rotated = applyRigidTransform({ rotation: identity.transform.rotation, translation: [0, 0] }, target[0], target[1])
			transform = { rotation: identity.transform.rotation, translation: [point[0] - rotated[0], point[1] - rotated[1]] }

			// A lost surface anchor is rebuilt around the absolute limb center on every frame; a limb-only
			// identity tries to create its first anchor on the anchor-check cadence. Either keeps the target.
			const lostAnchor = identity.anchor !== undefined

			if (maintaining && (lostAnchor || anchorCheckDue)) {
				anchorChecked = true
				const created = this.#objectAnchor(image, point, fuseLimb.semiMajor, identity.plane, generation + 1, width, height)

				if (created !== undefined) {
					generation++
					anchor = created
					keyframes = []
					target = point
					transform = IDENTITY_RIGID_TRANSFORM
					anchorCreated = true
					reanchored = true

					if (lostAnchor) {
						measurementMode = 'limbReacquired'
						notes.push('reanchored')
					} else {
						notes.push('surface_anchored')
					}
				}
			}
		}

		// Failed direct checks accumulate while an unverified keyframe chain is the working reference.
		let anchorCheckFailures = anchorCreated || directAnchorCheck || (used !== undefined && used === identity.anchor) ? 0 : identity.anchorCheckFailures + (anchorCheckFailed ? 1 : 0)
		let degraded = false

		if (point !== undefined && anchorCheckFailures > 0) {
			// The limb is the absolute authority: a limb-verified frame becomes the new anchor at the published point.
			if (measurementMode === 'hybrid' && fuseLimb !== undefined && maintaining) {
				const created = this.#objectAnchor(image, point, fuseLimb.semiMajor, identity.plane, generation + 1, width, height)

				if (created !== undefined) {
					generation++
					anchor = created
					keyframes = []
					target = point
					transform = IDENTITY_RIGID_TRANSFORM
					anchorCreated = true
					reanchored = true
					anchorCheckFailures = 0
					notes.push('reanchored')
				}
			}

			if (anchorCheckFailures > 0) {
				notes.push('anchor_unverified')

				if (anchorCheckFailures >= bankOptions.maximumAnchorCheckFailures) {
					// Unbounded chain drift is never published; the unstaged frame keeps the check due every frame.
					increment(reasons, 'anchor_unverified')
					point = undefined
				} else {
					degraded = true
				}
			}
		}

		const limbDiagnostic = limb === undefined ? undefined : limbDiagnosticOf(limb)
		const objectRadius = limb?.semiMajor ?? identity.objectRadius
		const currentArea = used === undefined || registration === undefined ? undefined : trackedArea(used.surface, registration.transform)
		const surfaceDiagnostic = registration === undefined ? undefined : surfaceDiagnosticOf(registration)
		const base = { plane: identity.plane, predictedTarget: predicted, rawTarget, surface: surfaceDiagnostic, limb: limbDiagnostic }

		if (point === undefined || transform === undefined) {
			notes.push('measurement_lost')
			return { ...failed(reasons, notes, { ...base, area: currentArea, transform, rotation: transform?.rotation }), candidateCount: registration?.candidatePatches ?? identity.anchor?.surface.patches.length ?? 0, objectRadius }
		}

		let framesSincePromotion = anchorCreated ? 0 : identity.framesSincePromotion + 1
		let promotionTime = anchorCreated ? now : identity.promotionTime

		// Promotion is staged here and applied only by commit(); poor or unverified frames never become keyframes.
		if (!reanchored && anchorCheckFailures === 0 && registration !== undefined && used !== undefined && anchor !== undefined && bankOptions.maximumKeyframes > 0 && registration.confidence >= bankOptions.minimumPromotionConfidence) {
			const reference = used.surface
			const cx = reference.originX + (reference.width - 1) * 0.5 * reference.step
			const cy = reference.originY + (reference.height - 1) * 0.5 * reference.step
			const moved = applyRigidTransform(registration.transform, cx, cy)
			const side = Math.min(anchor.surface.area.right - anchor.surface.area.left, anchor.surface.area.bottom - anchor.surface.area.top)

			if (maintenanceDue(framesSincePromotion, bankOptions.keyframeInterval, now, promotionTime, bankOptions.keyframeIntervalTime) || Math.hypot(moved[0] - cx, moved[1] - cy) >= bankOptions.keyframeShiftFraction * side) {
				const area = centeredArea(point, anchor.surface.area, width, height)
				const created = createSurfaceReference(image, area, identity.plane, this.#workspace, this.config.surface)

				if (created.success) {
					generation++
					keyframes = [...keyframes, { surface: created.reference, fromAnchor: transform, generation }].slice(-bankOptions.maximumKeyframes)
					framesSincePromotion = 0
					promotionTime = now
					notes.push('keyframe_staged')
				}
			}
		}

		const committedLimb = limb === undefined ? prior : limbGeometryOf(limb)
		const checkReset = anchorChecked || anchorCreated

		this.#pending = {
			plane: identity.plane,
			target,
			limbAnchored,
			limbConvergence,
			anchor,
			keyframes,
			transform,
			limb: committedLimb,
			objectRadius,
			generation,
			framesSincePromotion,
			promotionTime,
			framesSinceLimb: limbMeasured ? 0 : identity.framesSinceLimb + 1,
			framesSinceAnchorCheck: checkReset ? 0 : identity.framesSinceAnchorCheck + 1,
			anchorCheckTime: checkReset ? now : identity.anchorCheckTime,
			anchorCheckFailures,
		}

		const bankSize = (anchor === undefined ? 0 : 1) + keyframes.length
		const referenceDiagnostic: SolarSystemReferenceDiagnostic = { generation: anchorCreated ? generation : (used?.generation ?? anchor?.generation ?? 0), ageFrames: framesSincePromotion, bankSize, directAnchorCheck, anchorCheckFailures, reanchored }

		return {
			point,
			confidence,
			degraded,
			measurementMode,
			candidateCount: registration?.candidatePatches ?? 0,
			acceptedCount: registration?.acceptedPatches ?? limb?.rays.accepted ?? 0,
			reasons: registration === undefined ? reasons : mergeReasons(reasons, registration.rejectedReasons),
			notes,
			objectRadius,
			diagnostic: { ...base, measurementMode, area: currentArea, transform, rotation: transform.rotation, reference: referenceDiagnostic },
		}
	}

	// Registers a bank reference with the prediction carried from the last committed frame.
	#register(reference: BankReference, image: Image, anchorToPrevious: RigidTransform2D, options: SurfaceTrackingOptions, reasons: Record<string, number>) {
		const prediction = composeRigidTransforms(anchorToPrevious, invertRigidTransform(reference.fromAnchor))
		const outcome = registerSurface(reference.surface, image, prediction, this.#workspace, options)
		if (outcome.success) return outcome
		mergeReasons(reasons, outcome.rejectedReasons)
		return undefined
	}

	// objectCenter tracking ROI: the object radius plus margin on each side, bounded by the configured sizes.
	#objectArea(center: readonly [number, number], radius: number, width: number, height: number) {
		const { areaSize, maximumAreaSize, objectMargin } = this.config.acquisition
		return squareArea(center, Math.min(maximumAreaSize, Math.max(areaSize, 2 * (radius + objectMargin))), width, height)
	}

	// Builds a new anchor around an object center (image pixels) with the given radius, or returns undefined
	// when the area lacks usable surface structure.
	#objectAnchor(image: Image, center: readonly [number, number], radius: number, plane: ImageAnalysisPlane, generation: number, width: number, height: number): BankReference | undefined {
		const created = createSurfaceReference(image, this.#objectArea(center, radius, width, height), plane, this.#workspace, this.config.surface)
		return created.success ? { surface: created.reference, fromAnchor: IDENTITY_RIGID_TRANSFORM, generation } : undefined
	}

	// Calibration pulses can exceed the normal patch search; widen it to the calibrator's jump budget.
	#surfaceOptionsFor(context: GuideTrackerContext): SurfaceTrackingOptions {
		const surface = this.config.surface
		const jump = context.phase === 'calibrating' ? context.maxMeasurementJumpPx : undefined
		return jump !== undefined && jump > surface.searchRadius ? { ...surface, searchRadius: Math.ceil(jump) } : surface
	}

	// Builds, stores and returns the generic result for one frame.
	#publish(frame: GuideTrackerFrame, outcome: FrameOutcome): SolarSystemTrackerResult {
		const { acquisition, mode, targetMode } = this.config
		let state: SolarSystemTrackingState

		if (outcome.point === undefined) {
			this.#failures++
			state = this.#identity === undefined ? (this.#failures >= acquisition.lostAfter ? 'lost' : 'acquiring') : this.#failures >= acquisition.lostAfter ? 'lost' : 'degraded'
		} else {
			this.#failures = 0
			state = this.#pending !== undefined && this.#identity === undefined ? 'acquiring' : outcome.confidence >= 0.5 && outcome.degraded !== true ? 'tracking' : 'degraded'
		}

		const radius = outcome.objectRadius ?? this.#pending?.objectRadius ?? this.#identity?.objectRadius
		const targetEnvelope = this.#envelope(frame.width, frame.height, radius)
		const notes = outcome.notes

		if (outcome.point !== undefined && !(outcome.point[0] >= targetEnvelope.minX && outcome.point[0] <= targetEnvelope.maxX && outcome.point[1] >= targetEnvelope.minY && outcome.point[1] <= targetEnvelope.maxY)) {
			increment(outcome.reasons, 'target_near_edge')
			notes.push('target_near_edge')
		}

		const confidence = Number.isFinite(outcome.confidence) ? Math.min(1, Math.max(0, outcome.confidence)) : 0

		const result: SolarSystemTrackerResult = {
			measurement: outcome.point === undefined ? undefined : { x: outcome.point[0], y: outcome.point[1], confidence },
			candidateCount: outcome.candidateCount,
			acceptedCount: outcome.point === undefined ? 0 : outcome.acceptedCount,
			qualityScore: outcome.point === undefined ? 0 : confidence,
			rejectedReasons: outcome.reasons,
			notes,
			measurementMode: outcome.measurementMode,
			targetEnvelope,
			solarSystem: { mode, targetMode, state, ...outcome.diagnostic },
		}

		this.#lastResult = result
		return result
	}

	// Commanded-target envelope: the detector shrunk by the edge margin, the object radius plus margin
	// (objectCenter) or half the tracking ROI half-side (surfacePoint), so patches and limb stay measurable.
	#envelope(width: number, height: number, radius: number | undefined): GuideTargetEnvelope {
		const { edgeMargin, areaSize } = this.config.acquisition
		const support = this.config.targetMode === 'objectCenter' ? (radius ?? 0) + edgeMargin : areaSize * 0.25
		const marginPx = Math.max(edgeMargin, support)
		const marginX = Math.min(marginPx, (width - 1) * 0.5)
		const marginY = Math.min(marginPx, (height - 1) * 0.5)
		return { minX: marginX, maxX: width - 1 - marginX, minY: marginY, maxY: height - 1 - marginY, marginPx }
	}
}

// Failure outcome with optional partial diagnostic.
function failed(reasons: Record<string, number>, notes: string[], diagnostic: FrameOutcome['diagnostic'] = {}): FrameOutcome {
	return { confidence: 0, candidateCount: 0, acceptedCount: 0, reasons, notes, diagnostic }
}

// Maintenance clock of a frame in milliseconds: the monotonic capture instant, else the wall-clock
// timestamp. Only differences between frames of one stream are meaningful.
function frameClock(frame: GuideTrackerFrame) {
	return frame.captureMonotonic ?? frame.timestamp
}

// Whether a periodic maintenance action is due: at least `interval` committed frames have elapsed and, when
// `intervalMs` is positive and the last instant is known, at least `intervalMs` milliseconds of capture time.
// A backward or non-finite clock difference counts as elapsed so a clock reset never stalls maintenance.
function maintenanceDue(frames: number, interval: number, now: number, last: number | undefined, intervalMs: number) {
	if (frames < interval) return false
	if (!(intervalMs > 0) || last === undefined) return true
	const elapsed = now - last
	return !(elapsed >= 0 && elapsed < intervalMs)
}

// Adds one occurrence of a rejection reason.
function increment(reasons: Record<string, number>, reason: string) {
	reasons[reason] = (reasons[reason] ?? 0) + 1
}

// Adds counters from source into target and returns target.
function mergeReasons(target: Record<string, number>, source: Readonly<Record<string, number>>) {
	for (const key in source) target[key] = (target[key] ?? 0) + source[key]
	return target
}

// Wraps an axis angle to [0, PI).
function wrapHalfTurn(angle: number) {
	const wrapped = angle % PI
	return wrapped < 0 ? wrapped + PI : wrapped
}

// Acquisition confidence of a fresh reference from 3×3 patch coverage and patch count.
function referenceConfidence(reference: SurfaceReference) {
	let cells = 0
	for (let bits = reference.coverageCells; bits !== 0; bits &= bits - 1) cells++
	return Math.sqrt((cells / 9) * Math.min(1, reference.patches.length / 6))
}

// Copies limb geometry without measurement diagnostics.
function limbGeometryOf(limb: LimbMeasurement): LimbGeometry {
	return { center: limb.center, semiMajor: limb.semiMajor, semiMinor: limb.semiMinor, theta: limb.theta }
}

// Limb diagnostic projection.
function limbDiagnosticOf(limb: LimbMeasurement): SolarSystemLimbDiagnostic {
	return { center: limb.center, semiMajor: limb.semiMajor, semiMinor: limb.semiMinor, theta: limb.theta, rms: limb.rms, coverage: limb.coverage, maximumGap: limb.maximumGap, confidence: limb.confidence }
}

// Surface diagnostic projection.
function surfaceDiagnosticOf(registration: SurfaceRegistration): SolarSystemSurfaceDiagnostic {
	return {
		candidatePatches: registration.candidatePatches,
		acceptedPatches: registration.acceptedPatches,
		spatialCoverage: registration.spatialCoverage,
		rmsResidual: registration.rmsResidual,
		medianCorrelation: registration.medianCorrelation,
		medianPSR: registration.medianPSR,
		deformationRms: registration.deformationRms,
		uncertaintyPx: registration.uncertainty,
		model: registration.model,
	}
}

// Center of an image area in pixel-center coordinates.
function areaCenter(area: Readonly<Rect>): [number, number] {
	return [(area.left + area.right - 1) * 0.5, (area.top + area.bottom - 1) * 0.5]
}

// Whether a pixel coordinate lies inside an area.
function insideArea(area: Readonly<Rect>, point: readonly [number, number]) {
	return point[0] >= area.left && point[0] < area.right && point[1] >= area.top && point[1] < area.bottom
}

// Intersection of an area with the detector, or undefined when empty.
function intersectArea(area: Readonly<Rect>, width: number, height: number): Rect | undefined {
	const left = Math.max(0, Math.floor(area.left))
	const top = Math.max(0, Math.floor(area.top))
	const right = Math.min(width, Math.ceil(area.right))
	const bottom = Math.min(height, Math.ceil(area.bottom))
	return right > left && bottom > top ? { left, top, right, bottom } : undefined
}

// Integer area of the given side centered on a point and clipped to the detector.
function squareArea(center: readonly [number, number], side: number, width: number, height: number): Rect {
	const half = Math.max(1, Math.round(side)) * 0.5
	return clippedArea(center, half, half, width, height)
}

// Area with the size of template centered on a point and clipped to the detector.
function centeredArea(center: readonly [number, number], template: Readonly<Rect>, width: number, height: number): Rect {
	return clippedArea(center, (template.right - template.left) * 0.5, (template.bottom - template.top) * 0.5, width, height)
}

// Integer area spanning ±halfWidth/±halfHeight pixels around a point, clipped to the detector.
function clippedArea(center: readonly [number, number], halfWidth: number, halfHeight: number, width: number, height: number): Rect {
	const left = Math.max(0, Math.round(center[0] - halfWidth + 0.5))
	const top = Math.max(0, Math.round(center[1] - halfHeight + 0.5))
	const right = Math.min(width, Math.max(left + 1, Math.round(center[0] + halfWidth + 0.5)))
	const bottom = Math.min(height, Math.max(top + 1, Math.round(center[1] + halfHeight + 0.5)))
	return { left, top, right, bottom }
}

// Limb search area: the prior ellipse bounding circle with the radial window and a background band.
function limbArea(prior: LimbGeometry, searchFraction: number, width: number, height: number): Rect {
	const half = prior.semiMajor * (1 + searchFraction + 0.2) + 4
	return clippedArea(prior.center, half, half, width, height)
}

// Reference ROI translated by the registered motion of its center, clipped to integer pixels.
function trackedArea(reference: SurfaceReference, transform: RigidTransform2D): Rect {
	const { area } = reference
	const center = areaCenter(area)
	const moved = applyRigidTransform(transform, center[0], center[1])
	const dx = Math.round(moved[0] - center[0])
	const dy = Math.round(moved[1] - center[1])
	return { left: area.left + dx, top: area.top + dy, right: area.right + dx, bottom: area.bottom + dy }
}
