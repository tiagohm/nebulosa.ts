import type { PlateSolution } from '../../astrometry/solvers/platesolver'
import { tanProject, tanUnproject } from '../../astrometry/wcs/fits.wcs'
import { DEFAULT_REFRACTION_PARAMETERS, type RefractionParameters } from '../../astronomy/coordinates/astrometry'
import type { EquatorialCoordinate } from '../../astronomy/coordinates/coordinate'
import { eraC2s, eraS2c } from '../../astronomy/coordinates/erfa/erfa'
import type { GeographicPosition } from '../../astronomy/observer/location'
import type { Time } from '../../astronomy/time/time'
import { ASEC2RAD, PI, PIOVERTWO, TAU } from '../../core/constants'
import { type MutVec3, type Vec3, vecAngleUnit, vecDot, vecLength, vecNormalize, vecRotateByRodrigues } from '../../math/linear-algebra/vec3'
import { type Point, sphericalTangentBasis } from '../../math/numerical/geometry'
import { type Angle, normalizeAngle } from '../../math/units/angle'
import { mountAdjustmentAxes, solveAzAltAdjustment, type ThreePointPolarAlignmentResult } from './polaralignment'
import { applyInverseMountAdjustment, celestialPoleVector, decomposePolarErrorGeodesic } from './polaralignment.util'

// Geometry-only visual guidance for three-point polar alignment. The module solves the remaining
// two-axis mount correction in inertial 3D, maps a persistent celestial reference through the full
// TAN/TAN-SIP WCS, and returns finite pixel geometry ready for an SVG viewBox. It never mutates input
// objects and contains no rendering or DOM dependencies.

// Default polar-error tolerance contours: 30 arcseconds, 1 arcminute, and 5 arcminutes.
export const DEFAULT_POLAR_ALIGNMENT_OVERLAY_TOLERANCES = [30 * ASEC2RAD, 60 * ASEC2RAD, 300 * ASEC2RAD] as const

// Default number of unique samples around each closed tolerance contour.
const DEFAULT_CONTOUR_SAMPLES = 48

// Default maximum number of accepted Levenberg-Marquardt iterations.
const DEFAULT_MAXIMUM_ITERATIONS = 20

// Default central-difference step for mount-angle derivatives, in radians.
const DEFAULT_DERIVATIVE_STEP = 0.25 * ASEC2RAD

// Default angular residual required for correction convergence, in radians.
const DEFAULT_CORRECTION_TOLERANCE = 0.05 * ASEC2RAD

// Default maximum accepted condition number of the solver normal matrix.
const DEFAULT_MAXIMUM_CONDITION = 1e12

// Maximum absolute mount correction solved on either axis, in radians.
const MAXIMUM_CORRECTION = PIOVERTWO

// Angular distance from the spherical antipode treated as an undefined logarithm.
const ANTIPODAL_EPSILON = 1e-10

// Relative pixel tolerance used for zero-length and clipping comparisons.
const PIXEL_EPSILON_FACTOR = 1e-12

// Reference used to initialize or persist a visual guide star across solved exposures.
export type PolarAlignmentOverlayReference =
	| {
			readonly type: 'pixel'
			// Position in the pixel convention consumed by `tanUnproject`.
			readonly point: Readonly<Point>
	  }
	| {
			readonly type: 'equatorial'
			// Inertial right ascension, in radians.
			readonly rightAscension: Angle
			// Inertial declination, in radians.
			readonly declination: Angle
	  }

// Rectangular image-space area in the continuous WCS/SVG pixel convention.
export interface PolarAlignmentOverlayFrame {
	// Horizontal origin, in pixels.
	readonly x: number
	// Vertical origin, in pixels.
	readonly y: number
	// Positive width, in pixels.
	readonly width: number
	// Positive height, in pixels.
	readonly height: number
}

// A real WCS point plus a finite marker position suitable for on-screen display.
export interface PolarAlignmentOverlayPoint {
	// Geometric WCS position, in pixels; it may lie outside the frame.
	readonly position: Readonly<Point>
	// Position on or inside the margin-inset frame used to draw a marker.
	readonly display: Readonly<Point>
	// Whether `position` lies in the margin-inset frame.
	readonly onScreen: boolean
	// Unit pixel direction from the selected anchor to `position`, or zero on-screen.
	readonly direction: Readonly<Point>
}

// A finite original line segment and its intersection with the margin-inset frame.
export interface PolarAlignmentOverlaySegment {
	// Original start point, in pixels.
	readonly originalFrom: Readonly<Point>
	// Original end point, in pixels.
	readonly originalTo: Readonly<Point>
	// Clipped start point; draw only when `visible` is true.
	readonly from: Readonly<Point>
	// Clipped end point; draw only when `visible` is true.
	readonly to: Readonly<Point>
	// Whether any part of the segment intersects the margin-inset frame.
	readonly visible: boolean
	// Whether a visible endpoint differs from its original endpoint.
	readonly clipped: boolean
	// Original segment length, in pixels; numerically degenerate segments report zero.
	readonly length: number
	// Unit direction from original start to end, or zero for a degenerate segment.
	readonly direction: Readonly<Point>
}

// Reason the nonlinear correction solver stopped.
export type PolarAlignmentCorrectionTermination = 'convergedResidual' | 'convergedStep' | 'maximumIterations' | 'singular' | 'illConditioned' | 'nonFinite' | 'noImprovement'

// Remaining signed mount-base rotations and nonlinear solver diagnostics.
export interface ThreePointPolarAlignmentCorrection {
	// Positive rotation around local up, in radians.
	readonly azimuth: Angle
	// Positive rotation around the east axis carried by the base, in radians.
	readonly altitude: Angle
	// Final great-circle separation from the requested pole, in radians.
	readonly residual: Angle
	// Number of accepted nonlinear iterations.
	readonly iterations: number
	// Condition number of JᵀJ, absent before a Jacobian was needed or available.
	readonly condition?: number
	// Whether an angular or step convergence criterion was met.
	readonly converged: boolean
	// Whether the finite solution is sufficiently conditioned for visual guidance.
	readonly stable: boolean
	// Deterministic solver termination reason.
	readonly termination: PolarAlignmentCorrectionTermination
}

// Closed image-space locus for a constant residual polar error.
export interface PolarAlignmentOverlayContour {
	// Spherical residual pole separation, in radians.
	readonly tolerance: Angle
	// Ordered contour points; the final point is a copy of the first.
	readonly points: readonly Readonly<Point>[]
	// Always true because the point sequence is explicitly closed.
	readonly closed: true
	// Whether a contour segment intersects the margin-inset frame.
	readonly visible: boolean
	// Axis-aligned bounds of the unique contour points, in pixels.
	readonly bounds: Readonly<PolarAlignmentOverlayFrame>
}

// Non-fatal, machine-friendly overlay diagnostic.
export type PolarAlignmentOverlayWarning = 'correctionNotConverged' | 'correctionIllConditioned' | 'referenceOutsideFrame' | 'contourOmitted' | 'contourIllConditioned'

// Complete immutable geometry and diagnostics for one solved exposure.
export interface ThreePointPolarAlignmentOverlay {
	// Image-space clipping frame.
	readonly frame: Readonly<PolarAlignmentOverlayFrame>
	// Persistent inertial reference coordinate.
	readonly reference: Readonly<EquatorialCoordinate>
	// Reference star at the current mount pose.
	readonly currentPoint: Readonly<PolarAlignmentOverlayPoint>
	// Reference star after only the azimuth correction.
	readonly azimuthTargetPoint: Readonly<PolarAlignmentOverlayPoint>
	// Reference star after the complete correction.
	readonly targetPoint: Readonly<PolarAlignmentOverlayPoint>
	// Original current, intermediate, and final positions for a polyline.
	readonly path: readonly [Readonly<Point>, Readonly<Point>, Readonly<Point>]
	// Visible azimuth component segment.
	readonly azimuthSegment: Readonly<PolarAlignmentOverlaySegment>
	// Visible altitude component segment.
	readonly altitudeSegment: Readonly<PolarAlignmentOverlaySegment>
	// Visible direct total-correction segment.
	readonly totalSegment: Readonly<PolarAlignmentOverlaySegment>
	// Successfully projected constant-error contours.
	readonly contours: readonly Readonly<PolarAlignmentOverlayContour>[]
	// Nonlinear mechanical correction.
	readonly correction: Readonly<ThreePointPolarAlignmentCorrection>
	// Normalized current mount pole in the inertial frame.
	readonly currentPole: Vec3
	// Normalized target celestial pole in the inertial frame.
	readonly targetPole: Vec3
	// Exact geodesic polar-error metrics, in radians.
	readonly error: {
		readonly total: Angle
		readonly azimuth: Angle
		readonly altitude: Angle
	}
	// Deterministic non-fatal diagnostics.
	readonly diagnostics: {
		readonly warnings: readonly PolarAlignmentOverlayWarning[]
		readonly referenceOnScreen: boolean
		readonly targetOnScreen: boolean
		readonly omittedTolerances: readonly Angle[]
	}
}

// Fatal reason why finite base overlay geometry could not be produced.
export type ThreePointPolarAlignmentOverlayFailureReason = 'invalidOptions' | 'invalidFrame' | 'invalidWcs' | 'missingLocation' | 'invalidPole' | 'invalidReference' | 'unprojectableReference' | 'unprojectableTarget' | 'degenerateCorrection'

// Discriminated success or failure returned by the overlay entry point.
export type ThreePointPolarAlignmentOverlayResult = { readonly success: true; readonly overlay: Readonly<ThreePointPolarAlignmentOverlay> } | { readonly success: false; readonly reason: ThreePointPolarAlignmentOverlayFailureReason; readonly warnings: readonly PolarAlignmentOverlayWarning[] }

// Optional frame, reference, tolerance, and nonlinear solver controls.
export interface ThreePointPolarAlignmentOverlayOptions {
	// Explicit observing location; `time.location` is used when omitted.
	readonly location?: GeographicPosition
	// Atmospheric refraction model, or false to disable refraction.
	readonly refraction?: RefractionParameters | false
	// Visual reference; the geometric image center is used when omitted.
	readonly reference?: PolarAlignmentOverlayReference
	// Image-space frame; solution dimensions are used when omitted.
	readonly frame?: Readonly<PolarAlignmentOverlayFrame>
	// Inset from each frame edge for clipping and markers, in pixels.
	readonly margin?: number
	// Constant residual polar-error contour radii, in radians.
	readonly tolerances?: readonly Angle[]
	// Unique samples per tolerance contour, in the inclusive range 12..256.
	readonly samples?: number
	// Angular correction residual required for convergence, in radians.
	readonly correctionTolerance?: Angle
	// Positive nonlinear iteration limit.
	readonly maximumIterations?: number
	// Positive central-difference step, in radians.
	readonly derivativeStep?: Angle
	// Largest accepted condition number of JᵀJ.
	readonly maximumCondition?: number
}

// Fully resolved and validated internal overlay options.
interface ResolvedOverlayOptions {
	// Validated observing location.
	readonly location: GeographicPosition
	// Resolved refraction model.
	readonly refraction: RefractionParameters | false
	// Caller-provided visual reference, when present.
	readonly reference?: PolarAlignmentOverlayReference
	// Validated image-space frame.
	readonly frame: PolarAlignmentOverlayFrame
	// Validated frame inset, in pixels.
	readonly margin: number
	// Copied contour radii, in radians.
	readonly tolerances: readonly Angle[]
	// Unique samples generated per contour.
	readonly samples: number
	// Angular nonlinear convergence threshold, in radians.
	readonly correctionTolerance: Angle
	// Positive nonlinear iteration limit.
	readonly maximumIterations: number
	// Central-difference step, in radians.
	readonly derivativeStep: Angle
	// Largest accepted JᵀJ condition number.
	readonly maximumCondition: number
}

// Mutable scalar residual reused by the nonlinear solver.
interface CorrectionResidual {
	// First target-tangent residual component, in radians.
	r0: number
	// Second target-tangent residual component, in radians.
	r1: number
	// Great-circle residual magnitude, in radians.
	angle: number
	// Half squared residual norm.
	cost: number
}

// Fixed vector buffers reused across nonlinear residual evaluations.
interface CorrectionWorkspace {
	// Pole after the trial azimuth rotation.
	readonly afterAzimuth: MutVec3
	// East axis carried by the trial azimuth rotation.
	readonly altitudeAxis: MutVec3
	// Pole after both trial rotations.
	readonly predicted: MutVec3
}

// Optional correction seed used for contour continuation.
interface CorrectionSeed {
	// Seed azimuth rotation, in radians.
	readonly azimuth: Angle
	// Seed altitude rotation, in radians.
	readonly altitude: Angle
}

// Converts a WCS pixel into a persistent inertial equatorial coordinate. Inputs use the exact pixel
// convention of `tanUnproject`; points outside the image rectangle remain valid when WCS-projectable.
export function polarAlignmentReferenceFromPixel(solution: Readonly<PlateSolution>, point: Readonly<Point>): EquatorialCoordinate | undefined {
	if (!isFinitePoint(point)) return undefined
	const coordinate = tanUnproject(solution, point.x, point.y)
	return coordinate === undefined || !Number.isFinite(coordinate[0]) || !Number.isFinite(coordinate[1]) ? undefined : { rightAscension: coordinate[0], declination: coordinate[1] }
}

// Projects a finite point to the margin-inset border along an explicit in-frame origin, falling back
// to the inset-frame center when the origin is absent or off-screen. Returns undefined for invalid
// frame, margin, or coordinates.
export function projectPolarAlignmentOverlayPoint(point: Readonly<Point>, frame: Readonly<PolarAlignmentOverlayFrame>, margin: number = 0, origin?: Readonly<Point>): PolarAlignmentOverlayPoint | undefined {
	const bounds = insetFrameBounds(frame, margin)
	if (!bounds || !isFinitePoint(point)) return undefined

	const position = { x: point.x, y: point.y }
	if (pointInBounds(position, bounds)) return { position, display: { ...position }, onScreen: true, direction: { x: 0, y: 0 } }

	const anchor = origin && isFinitePoint(origin) && pointInBounds(origin, bounds) ? { x: origin.x, y: origin.y } : { x: (bounds.left + bounds.right) * 0.5, y: (bounds.top + bounds.bottom) * 0.5 }
	const clipped = clipLineToBounds(anchor, position, bounds)
	if (!clipped) return undefined
	const dx = position.x - anchor.x
	const dy = position.y - anchor.y
	const length = Math.hypot(dx, dy)
	if (!Number.isFinite(length) || length === 0) return undefined

	return { position, display: clipped[1], onScreen: false, direction: { x: dx / length, y: dy / length } }
}

// Clips a finite segment to a margin-inset rectangular frame with Cohen-Sutherland. Both original
// endpoints are retained, including when the segment is invisible. Returns undefined for invalid
// input geometry.
export function clipPolarAlignmentOverlaySegment(from: Readonly<Point>, to: Readonly<Point>, frame: Readonly<PolarAlignmentOverlayFrame>, margin: number = 0): PolarAlignmentOverlaySegment | undefined {
	const bounds = insetFrameBounds(frame, margin)
	if (!bounds || !isFinitePoint(from) || !isFinitePoint(to)) return undefined

	const originalFrom = { x: from.x, y: from.y }
	const originalTo = { x: to.x, y: to.y }
	const dx = to.x - from.x
	const dy = to.y - from.y
	const rawLength = Math.hypot(dx, dy)
	if (!Number.isFinite(rawLength)) return undefined
	const epsilon = pixelEpsilon(frame)

	if (rawLength <= epsilon) {
		const visible = pointInBounds(originalFrom, bounds)
		return { originalFrom, originalTo, from: { ...originalFrom }, to: { ...originalTo }, visible, clipped: false, length: 0, direction: { x: 0, y: 0 } }
	}

	const clipped = clipLineToBounds(originalFrom, originalTo, bounds)
	if (!clipped) return { originalFrom, originalTo, from: { ...originalFrom }, to: { ...originalTo }, visible: false, clipped: false, length: rawLength, direction: { x: dx / rawLength, y: dy / rawLength } }

	const clippedFrom = clipped[0]
	const clippedTo = clipped[1]
	const wasClipped = Math.abs(clippedFrom.x - from.x) > epsilon || Math.abs(clippedFrom.y - from.y) > epsilon || Math.abs(clippedTo.x - to.x) > epsilon || Math.abs(clippedTo.y - to.y) > epsilon
	return { originalFrom, originalTo, from: clippedFrom, to: clippedTo, visible: true, clipped: wasClipped, length: rawLength, direction: { x: dx / rawLength, y: dy / rawLength } }
}

// Computes all finite overlay geometry for a current three-point result and plate solution. The
// supplied time, WCS, and inertial pole must describe the same practical exposure epoch.
export function computeThreePointPolarAlignmentOverlay(result: Readonly<ThreePointPolarAlignmentResult>, solution: Readonly<PlateSolution>, time: Time, options?: Readonly<ThreePointPolarAlignmentOverlayOptions>): ThreePointPolarAlignmentOverlayResult {
	const warnings: PolarAlignmentOverlayWarning[] = []
	const resolved = resolveOptions(solution, time, options)
	if ('reason' in resolved) return failure(resolved.reason, warnings)

	const centerCoordinate = tanUnproject(solution, solution.widthInPixels * 0.5, solution.heightInPixels * 0.5)
	if (centerCoordinate === undefined || !Number.isFinite(centerCoordinate[0]) || !Number.isFinite(centerCoordinate[1])) return failure('invalidWcs', warnings)

	const currentPole = normalizeFiniteVector(result.pole)
	if (!currentPole) return failure('invalidPole', warnings)
	let targetPole: Vec3 | undefined
	let axes: ReturnType<typeof mountAdjustmentAxes>
	try {
		targetPole = normalizeFiniteVector(celestialPoleVector(time, resolved.location, resolved.refraction))
		axes = mountAdjustmentAxes(time, resolved.location)
	} catch {
		return failure('invalidOptions', warnings)
	}
	if (!targetPole) return failure('invalidPole', warnings)

	const error = decomposePolarErrorGeodesic(currentPole, targetPole, axes.upAxis, axes.eastAxis)
	if (!error) return failure('degenerateCorrection', warnings)

	const correction = solveCorrection(currentPole, targetPole, axes.upAxis, axes.eastAxis, resolved)
	if (!correction.stable) {
		if (correction.termination === 'illConditioned') pushWarning(warnings, 'correctionIllConditioned')
		return failure('degenerateCorrection', warnings)
	}
	if (!correction.converged) pushWarning(warnings, 'correctionNotConverged')

	const reference = resolveReference(solution, resolved.reference)
	if ('reason' in reference) return failure(reference.reason, warnings)
	const referenceVector = eraS2c(reference.rightAscension, reference.declination)
	const currentPosition = projectCoordinate(solution, reference.rightAscension, reference.declination)
	if (!currentPosition) return failure('unprojectableReference', warnings)

	const azimuthVector = vecRotateByRodrigues(referenceVector, axes.upAxis, -correction.azimuth)
	const azimuthPosition = projectVector(solution, azimuthVector)
	if (!azimuthPosition) return failure('unprojectableTarget', warnings)
	const targetReferenceVector = applyInverseMountAdjustment(referenceVector, axes.upAxis, axes.eastAxis, correction.azimuth, correction.altitude)
	const targetPosition = projectVector(solution, targetReferenceVector)
	if (!targetPosition) return failure('unprojectableTarget', warnings)

	const currentPoint = projectPolarAlignmentOverlayPoint(currentPosition, resolved.frame, resolved.margin)
	const azimuthTargetPoint = projectPolarAlignmentOverlayPoint(azimuthPosition, resolved.frame, resolved.margin, currentPoint?.onScreen ? currentPosition : undefined)
	const targetPoint = projectPolarAlignmentOverlayPoint(targetPosition, resolved.frame, resolved.margin, currentPoint?.onScreen ? currentPosition : undefined)
	if (!currentPoint || !azimuthTargetPoint || !targetPoint) return failure('invalidFrame', warnings)
	if (!currentPoint.onScreen) pushWarning(warnings, 'referenceOutsideFrame')

	const azimuthSegment = clipPolarAlignmentOverlaySegment(currentPosition, azimuthPosition, resolved.frame, resolved.margin)
	const altitudeSegment = clipPolarAlignmentOverlaySegment(azimuthPosition, targetPosition, resolved.frame, resolved.margin)
	const totalSegment = clipPolarAlignmentOverlaySegment(currentPosition, targetPosition, resolved.frame, resolved.margin)
	if (!azimuthSegment || !altitudeSegment || !totalSegment) return failure('invalidFrame', warnings)

	const contours: PolarAlignmentOverlayContour[] = []
	const omittedTolerances: Angle[] = []
	buildContours(contours, omittedTolerances, warnings, solution, referenceVector, currentPole, targetPole, axes.upAxis, axes.eastAxis, correction, resolved)

	const path = [{ ...currentPosition }, { ...azimuthPosition }, { ...targetPosition }] as const
	return {
		success: true,
		overlay: {
			frame: { ...resolved.frame },
			reference: { ...reference },
			currentPoint,
			azimuthTargetPoint,
			targetPoint,
			path,
			azimuthSegment,
			altitudeSegment,
			totalSegment,
			contours,
			correction,
			currentPole,
			targetPole,
			error,
			diagnostics: { warnings, referenceOnScreen: currentPoint.onScreen, targetOnScreen: targetPoint.onScreen, omittedTolerances },
		},
	}
}

// Resolves and validates options without mutating caller-owned arrays or objects.
function resolveOptions(solution: Readonly<PlateSolution>, time: Time, options?: Readonly<ThreePointPolarAlignmentOverlayOptions>): ResolvedOverlayOptions | { readonly reason: ThreePointPolarAlignmentOverlayFailureReason } {
	const location = options?.location ?? time.location
	if (!location) return { reason: 'missingLocation' }
	if (!isFiniteLocation(location) || !Number.isFinite(time.day) || !Number.isFinite(time.fraction)) return { reason: 'invalidOptions' }
	if (!Number.isFinite(solution.widthInPixels) || !Number.isFinite(solution.heightInPixels) || solution.widthInPixels <= 0 || solution.heightInPixels <= 0) return { reason: 'invalidFrame' }

	const sourceFrame = options?.frame ?? { x: 0, y: 0, width: solution.widthInPixels, height: solution.heightInPixels }
	const frame = { x: sourceFrame.x, y: sourceFrame.y, width: sourceFrame.width, height: sourceFrame.height }
	const margin = options?.margin ?? 0
	if (!insetFrameBounds(frame, margin)) return { reason: 'invalidFrame' }

	const samples = options?.samples ?? DEFAULT_CONTOUR_SAMPLES
	const maximumIterations = options?.maximumIterations ?? DEFAULT_MAXIMUM_ITERATIONS
	const derivativeStep = options?.derivativeStep ?? DEFAULT_DERIVATIVE_STEP
	const correctionTolerance = options?.correctionTolerance ?? DEFAULT_CORRECTION_TOLERANCE
	const maximumCondition = options?.maximumCondition ?? DEFAULT_MAXIMUM_CONDITION
	if (!Number.isInteger(samples) || samples < 12 || samples > 256 || !Number.isInteger(maximumIterations) || maximumIterations <= 0) return { reason: 'invalidOptions' }
	if (!Number.isFinite(derivativeStep) || derivativeStep <= 0 || !Number.isFinite(correctionTolerance) || correctionTolerance <= 0 || !Number.isFinite(maximumCondition) || maximumCondition <= 1) return { reason: 'invalidOptions' }

	const sourceTolerances = options?.tolerances ?? DEFAULT_POLAR_ALIGNMENT_OVERLAY_TOLERANCES
	const tolerances: Angle[] = []
	for (let i = 0; i < sourceTolerances.length; i++) {
		const tolerance = sourceTolerances[i]
		if (!Number.isFinite(tolerance) || tolerance <= 0 || tolerance >= PI) return { reason: 'invalidOptions' }
		tolerances.push(tolerance)
	}

	return { location, refraction: options?.refraction ?? DEFAULT_REFRACTION_PARAMETERS, reference: options?.reference, frame, margin, tolerances, samples, correctionTolerance, maximumIterations, derivativeStep, maximumCondition }
}

// Resolves a pixel/equatorial/default reference and normalizes its right ascension.
function resolveReference(solution: Readonly<PlateSolution>, reference?: PolarAlignmentOverlayReference): EquatorialCoordinate | { readonly reason: ThreePointPolarAlignmentOverlayFailureReason } {
	if (!reference) {
		const coordinate = polarAlignmentReferenceFromPixel(solution, { x: solution.widthInPixels * 0.5, y: solution.heightInPixels * 0.5 })
		return coordinate ?? { reason: 'invalidWcs' }
	}

	if (reference.type === 'pixel') {
		if (!isFinitePoint(reference.point)) return { reason: 'invalidReference' }
		return polarAlignmentReferenceFromPixel(solution, reference.point) ?? { reason: 'invalidWcs' }
	}

	if (reference.type !== 'equatorial' || !Number.isFinite(reference.rightAscension) || !Number.isFinite(reference.declination) || reference.declination < -PIOVERTWO || reference.declination > PIOVERTWO) return { reason: 'invalidReference' }
	return { rightAscension: normalizeAngle(reference.rightAscension), declination: reference.declination }
}

// Solves the nonlinear two-angle mechanical correction with damped scalar Levenberg-Marquardt.
function solveCorrection(currentPole: Vec3, targetPole: Vec3, upAxis: Vec3, eastAxis: Vec3, options: ResolvedOverlayOptions, explicitSeed?: CorrectionSeed): ThreePointPolarAlignmentCorrection {
	const basis = sphericalTangentBasis(targetPole)
	const linearSeed = explicitSeed ?? solveAzAltAdjustment(currentPole, targetPole, upAxis, eastAxis)
	let azimuth = clampCorrection('azimuthAdjustment' in linearSeed ? linearSeed.azimuthAdjustment : linearSeed.azimuth)
	let altitude = clampCorrection('altitudeAdjustment' in linearSeed ? linearSeed.altitudeAdjustment : linearSeed.altitude)
	const workspace: CorrectionWorkspace = { afterAzimuth: [0, 0, 0], altitudeAxis: [0, 0, 0], predicted: [0, 0, 0] }
	const current: CorrectionResidual = { r0: 0, r1: 0, angle: 0, cost: 0 }
	const plusAzimuth: CorrectionResidual = { r0: 0, r1: 0, angle: 0, cost: 0 }
	const minusAzimuth: CorrectionResidual = { r0: 0, r1: 0, angle: 0, cost: 0 }
	const plusAltitude: CorrectionResidual = { r0: 0, r1: 0, angle: 0, cost: 0 }
	const minusAltitude: CorrectionResidual = { r0: 0, r1: 0, angle: 0, cost: 0 }
	const candidate: CorrectionResidual = { r0: 0, r1: 0, angle: 0, cost: 0 }
	if (!evaluateCorrectionResidual(currentPole, targetPole, upAxis, eastAxis, basis.east, basis.north, azimuth, altitude, current, workspace)) return correctionResult(azimuth, altitude, Number.MAX_VALUE, 0, undefined, false, false, 'nonFinite')
	if (current.angle <= options.correctionTolerance) return correctionResult(azimuth, altitude, current.angle, 0, undefined, true, true, 'convergedResidual')

	let damping = 1e-6
	let condition: number | undefined
	let acceptedIterations = 0

	for (let iteration = 0; iteration < options.maximumIterations; iteration++) {
		const step = options.derivativeStep
		if (
			!evaluateCorrectionResidual(currentPole, targetPole, upAxis, eastAxis, basis.east, basis.north, azimuth + step, altitude, plusAzimuth, workspace) ||
			!evaluateCorrectionResidual(currentPole, targetPole, upAxis, eastAxis, basis.east, basis.north, azimuth - step, altitude, minusAzimuth, workspace) ||
			!evaluateCorrectionResidual(currentPole, targetPole, upAxis, eastAxis, basis.east, basis.north, azimuth, altitude + step, plusAltitude, workspace) ||
			!evaluateCorrectionResidual(currentPole, targetPole, upAxis, eastAxis, basis.east, basis.north, azimuth, altitude - step, minusAltitude, workspace)
		)
			return correctionResult(azimuth, altitude, current.angle, acceptedIterations, condition, false, false, 'nonFinite')

		const inverseSpan = 0.5 / step
		const j00 = (plusAzimuth.r0 - minusAzimuth.r0) * inverseSpan
		const j10 = (plusAzimuth.r1 - minusAzimuth.r1) * inverseSpan
		const j01 = (plusAltitude.r0 - minusAltitude.r0) * inverseSpan
		const j11 = (plusAltitude.r1 - minusAltitude.r1) * inverseSpan
		const a11 = j00 * j00 + j10 * j10
		const a12 = j00 * j01 + j10 * j11
		const a22 = j01 * j01 + j11 * j11
		condition = normalMatrixCondition(a11, a12, a22)
		if (condition === undefined) return correctionResult(azimuth, altitude, current.angle, acceptedIterations, undefined, false, false, 'singular')
		if (condition > options.maximumCondition) return correctionResult(azimuth, altitude, current.angle, acceptedIterations, condition, false, false, 'illConditioned')

		const g0 = j00 * current.r0 + j10 * current.r1
		const g1 = j01 * current.r0 + j11 * current.r1
		let accepted = false
		let acceptedStep = 0

		for (let attempt = 0; attempt < 8; attempt++) {
			const m11 = a11 + damping
			const m22 = a22 + damping
			const determinant = m11 * m22 - a12 * a12
			const determinantScale = Math.max(1, Math.abs(m11 * m22), a12 * a12)
			if (!Number.isFinite(determinant) || Math.abs(determinant) <= Number.EPSILON * determinantScale) {
				damping *= 10
				continue
			}

			const deltaAzimuth = (-g0 * m22 + g1 * a12) / determinant
			const deltaAltitude = (-g1 * m11 + g0 * a12) / determinant
			if (!Number.isFinite(deltaAzimuth) || !Number.isFinite(deltaAltitude)) return correctionResult(azimuth, altitude, current.angle, acceptedIterations, condition, false, false, 'nonFinite')
			const nextAzimuth = clampCorrection(azimuth + deltaAzimuth)
			const nextAltitude = clampCorrection(altitude + deltaAltitude)
			if (!evaluateCorrectionResidual(currentPole, targetPole, upAxis, eastAxis, basis.east, basis.north, nextAzimuth, nextAltitude, candidate, workspace)) return correctionResult(azimuth, altitude, current.angle, acceptedIterations, condition, false, false, 'nonFinite')

			if (candidate.cost < current.cost) {
				azimuth = nextAzimuth
				altitude = nextAltitude
				acceptedStep = Math.hypot(deltaAzimuth, deltaAltitude)
				copyResidual(candidate, current)
				damping = Math.max(1e-15, damping * 0.3)
				accepted = true
				acceptedIterations++
				break
			}
			damping *= 10
		}

		if (!accepted) return correctionResult(azimuth, altitude, current.angle, acceptedIterations, condition, false, true, 'noImprovement')
		if (current.angle <= options.correctionTolerance) return correctionResult(azimuth, altitude, current.angle, acceptedIterations, condition, true, true, 'convergedResidual')
		if (acceptedStep <= options.correctionTolerance) return correctionResult(azimuth, altitude, current.angle, acceptedIterations, condition, true, true, 'convergedStep')
	}

	return correctionResult(azimuth, altitude, current.angle, acceptedIterations, condition, false, true, 'maximumIterations')
}

// Evaluates the spherical-log residual into a caller-owned scalar result and vector workspace.
function evaluateCorrectionResidual(currentPole: Vec3, targetPole: Vec3, upAxis: Vec3, eastAxis: Vec3, tangent0: Vec3, tangent1: Vec3, azimuth: Angle, altitude: Angle, out: CorrectionResidual, workspace: CorrectionWorkspace): boolean {
	vecRotateByRodrigues(currentPole, upAxis, azimuth, workspace.afterAzimuth)
	vecRotateByRodrigues(eastAxis, upAxis, azimuth, workspace.altitudeAxis)
	vecRotateByRodrigues(workspace.afterAzimuth, workspace.altitudeAxis, altitude, workspace.predicted)

	const angle = vecAngleUnit(targetPole, workspace.predicted)
	if (!Number.isFinite(angle) || PI - angle <= ANTIPODAL_EPSILON) return false
	const scale = angle < 1e-6 ? 1 + (angle * angle) / 6 : angle / Math.sin(angle)
	const r0 = scale * vecDot(workspace.predicted, tangent0)
	const r1 = scale * vecDot(workspace.predicted, tangent1)
	const cost = 0.5 * (r0 * r0 + r1 * r1)
	if (!Number.isFinite(r0) || !Number.isFinite(r1) || !Number.isFinite(cost)) return false
	out.r0 = r0
	out.r1 = r1
	out.angle = angle
	out.cost = cost
	return true
}

// Builds exact spherical tolerance contours, omitting a whole contour on any unstable sample.
function buildContours(
	contours: PolarAlignmentOverlayContour[],
	omittedTolerances: Angle[],
	warnings: PolarAlignmentOverlayWarning[],
	solution: Readonly<PlateSolution>,
	referenceVector: Vec3,
	currentPole: Vec3,
	targetPole: Vec3,
	upAxis: Vec3,
	eastAxis: Vec3,
	centralCorrection: ThreePointPolarAlignmentCorrection,
	options: ResolvedOverlayOptions,
): void {
	const basis = sphericalTangentBasis(targetPole)

	for (let toleranceIndex = 0; toleranceIndex < options.tolerances.length; toleranceIndex++) {
		const tolerance = options.tolerances[toleranceIndex]
		const cosTolerance = Math.cos(tolerance)
		const sinTolerance = Math.sin(tolerance)
		const points: Point[] = []
		let seed: CorrectionSeed = { azimuth: centralCorrection.azimuth, altitude: centralCorrection.altitude }
		let illConditioned = false
		let omitted = false

		for (let sample = 0; sample < options.samples; sample++) {
			const theta = (sample * TAU) / options.samples
			const cosTheta = Math.cos(theta)
			const sinTheta = Math.sin(theta)
			const residualPole: MutVec3 = [
				targetPole[0] * cosTolerance + (basis.east[0] * cosTheta + basis.north[0] * sinTheta) * sinTolerance,
				targetPole[1] * cosTolerance + (basis.east[1] * cosTheta + basis.north[1] * sinTheta) * sinTolerance,
				targetPole[2] * cosTolerance + (basis.east[2] * cosTheta + basis.north[2] * sinTheta) * sinTolerance,
			]
			const normalizedResidualPole = vecNormalize(residualPole, residualPole)
			const correction = solveCorrection(currentPole, normalizedResidualPole, upAxis, eastAxis, options, seed)
			if (!correction.stable || !correction.converged) {
				illConditioned = !correction.stable
				omitted = true
				break
			}

			seed = correction
			const vector = applyInverseMountAdjustment(referenceVector, upAxis, eastAxis, correction.azimuth, correction.altitude)
			const point = projectVector(solution, vector)
			if (!point) {
				omitted = true
				break
			}
			points.push(point)
		}

		if (omitted || points.length !== options.samples) {
			omittedTolerances.push(tolerance)
			pushWarning(warnings, illConditioned ? 'contourIllConditioned' : 'contourOmitted')
			continue
		}

		points.push({ ...points[0] })
		const bounds = contourBounds(points)
		if (!bounds) {
			omittedTolerances.push(tolerance)
			pushWarning(warnings, 'contourOmitted')
			continue
		}
		contours.push({ tolerance, points, closed: true, visible: contourIntersectsFrame(points, options.frame, options.margin), bounds })
	}
}

// Computes the condition number of a symmetric positive-semidefinite 2×2 normal matrix.
function normalMatrixCondition(a11: number, a12: number, a22: number): number | undefined {
	const trace = a11 + a22
	const discriminant = Math.hypot(a11 - a22, 2 * a12)
	const maximum = 0.5 * (trace + discriminant)
	const minimum = 0.5 * (trace - discriminant)
	if (!Number.isFinite(maximum) || !Number.isFinite(minimum) || maximum <= 0 || minimum <= Number.EPSILON * maximum) return undefined
	const condition = maximum / minimum
	return Number.isFinite(condition) ? condition : undefined
}

// Creates a correction result while ensuring its public numeric fields remain finite.
function correctionResult(azimuth: Angle, altitude: Angle, residual: Angle, iterations: number, condition: number | undefined, converged: boolean, stable: boolean, termination: PolarAlignmentCorrectionTermination): ThreePointPolarAlignmentCorrection {
	return { azimuth, altitude, residual: Number.isFinite(residual) ? residual : Number.MAX_VALUE, iterations, condition: Number.isFinite(condition) ? condition : undefined, converged, stable, termination }
}

// Copies a residual into a preallocated destination.
function copyResidual(from: CorrectionResidual, to: CorrectionResidual): void {
	to.r0 = from.r0
	to.r1 = from.r1
	to.angle = from.angle
	to.cost = from.cost
}

// Limits a periodic solver state to the documented operational correction domain.
function clampCorrection(value: Angle): Angle {
	return Math.max(-MAXIMUM_CORRECTION, Math.min(MAXIMUM_CORRECTION, value))
}

// Projects a finite equatorial coordinate through the complete supplied WCS.
function projectCoordinate(solution: Readonly<PlateSolution>, rightAscension: Angle, declination: Angle): Point | undefined {
	const projected = tanProject(solution, rightAscension, declination)
	if (projected === undefined || !Number.isFinite(projected[0]) || !Number.isFinite(projected[1])) return undefined
	return { x: projected[0], y: projected[1] }
}

// Converts an inertial unit vector to spherical coordinates and projects it through the supplied WCS.
function projectVector(solution: Readonly<PlateSolution>, vector: Vec3): Point | undefined {
	const [rightAscension, declination] = eraC2s(vector[0], vector[1], vector[2])
	return projectCoordinate(solution, rightAscension, declination)
}

// Returns finite bounds for a closed contour, ignoring its duplicated final point.
function contourBounds(points: readonly Readonly<Point>[]): PolarAlignmentOverlayFrame | undefined {
	let minX = points[0].x
	let maxX = points[0].x
	let minY = points[0].y
	let maxY = points[0].y
	for (let i = 1; i < points.length - 1; i++) {
		const point = points[i]
		if (point.x < minX) minX = point.x
		if (point.x > maxX) maxX = point.x
		if (point.y < minY) minY = point.y
		if (point.y > maxY) maxY = point.y
	}
	const width = maxX - minX
	const height = maxY - minY
	return Number.isFinite(width) && Number.isFinite(height) ? { x: minX, y: minY, width, height } : undefined
}

// Tests actual contour segments against the margin-inset frame rather than relying on bounds alone.
function contourIntersectsFrame(points: readonly Readonly<Point>[], frame: Readonly<PolarAlignmentOverlayFrame>, margin: number): boolean {
	const bounds = insetFrameBounds(frame, margin)
	if (!bounds) return false
	for (let i = 0; i < points.length - 1; i++) {
		if (pointInBounds(points[i], bounds) || clipLineToBounds(points[i], points[i + 1], bounds)) return true
	}
	return false
}

// Rectangular bounds after applying a non-negative margin, or undefined for a collapsed/invalid area.
function insetFrameBounds(frame: Readonly<PolarAlignmentOverlayFrame>, margin: number): { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number } | undefined {
	if (!Number.isFinite(frame.x) || !Number.isFinite(frame.y) || !Number.isFinite(frame.width) || !Number.isFinite(frame.height) || !Number.isFinite(margin)) return undefined
	if (frame.width <= 0 || frame.height <= 0 || margin < 0 || 2 * margin >= frame.width || 2 * margin >= frame.height) return undefined
	return { left: frame.x + margin, top: frame.y + margin, right: frame.x + frame.width - margin, bottom: frame.y + frame.height - margin }
}

// Clips a segment to inclusive bounds using Cohen-Sutherland and returns fresh endpoints.
function clipLineToBounds(from: Readonly<Point>, to: Readonly<Point>, bounds: { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number }): readonly [Point, Point] | undefined {
	let x0 = from.x
	let y0 = from.y
	let x1 = to.x
	let y1 = to.y
	let code0 = outCode(x0, y0, bounds)
	let code1 = outCode(x1, y1, bounds)

	for (let iteration = 0; iteration < 8; iteration++) {
		if ((code0 | code1) === 0)
			return [
				{ x: x0, y: y0 },
				{ x: x1, y: y1 },
			]
		if ((code0 & code1) !== 0) return undefined

		const code = code0 !== 0 ? code0 : code1
		let x: number
		let y: number
		if ((code & 8) !== 0) {
			if (y1 === y0) return undefined
			x = x0 + ((x1 - x0) * (bounds.bottom - y0)) / (y1 - y0)
			y = bounds.bottom
		} else if ((code & 4) !== 0) {
			if (y1 === y0) return undefined
			x = x0 + ((x1 - x0) * (bounds.top - y0)) / (y1 - y0)
			y = bounds.top
		} else if ((code & 2) !== 0) {
			if (x1 === x0) return undefined
			y = y0 + ((y1 - y0) * (bounds.right - x0)) / (x1 - x0)
			x = bounds.right
		} else {
			if (x1 === x0) return undefined
			y = y0 + ((y1 - y0) * (bounds.left - x0)) / (x1 - x0)
			x = bounds.left
		}

		if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined
		if (code === code0) {
			x0 = x
			y0 = y
			code0 = outCode(x0, y0, bounds)
		} else {
			x1 = x
			y1 = y
			code1 = outCode(x1, y1, bounds)
		}
	}
	return undefined
}

// Encodes a point's position relative to inclusive rectangular bounds.
function outCode(x: number, y: number, bounds: { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number }): number {
	let code = 0
	if (x < bounds.left) code |= 1
	else if (x > bounds.right) code |= 2
	if (y < bounds.top) code |= 4
	else if (y > bounds.bottom) code |= 8
	return code
}

// Tests inclusion in an inclusive rectangular frame.
function pointInBounds(point: Readonly<Point>, bounds: { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number }): boolean {
	return point.x >= bounds.left && point.x <= bounds.right && point.y >= bounds.top && point.y <= bounds.bottom
}

// Computes a scale-aware finite pixel epsilon for a frame.
function pixelEpsilon(frame: Readonly<PolarAlignmentOverlayFrame>): number {
	return PIXEL_EPSILON_FACTOR * Math.max(1, Math.abs(frame.x), Math.abs(frame.y), frame.width, frame.height)
}

// Tests whether both pixel coordinates are finite.
function isFinitePoint(point: Readonly<Point>): boolean {
	return Number.isFinite(point.x) && Number.isFinite(point.y)
}

// Tests the finite geodetic fields required by the current coordinate transformations.
function isFiniteLocation(location: GeographicPosition): boolean {
	return Number.isFinite(location.longitude) && Number.isFinite(location.latitude) && Number.isFinite(location.elevation) && location.longitude >= -PI && location.longitude <= PI && location.latitude >= -PIOVERTWO && location.latitude <= PIOVERTWO
}

// Returns a fresh normalized vector, or undefined for a non-finite/zero direction.
function normalizeFiniteVector(vector: Vec3): Vec3 | undefined {
	if (!Number.isFinite(vector[0]) || !Number.isFinite(vector[1]) || !Number.isFinite(vector[2])) return undefined
	const length = vecLength(vector)
	return Number.isFinite(length) && length > 0 ? vecNormalize(vector) : undefined
}

// Adds a warning once while preserving deterministic first-occurrence order.
function pushWarning(warnings: PolarAlignmentOverlayWarning[], warning: PolarAlignmentOverlayWarning): void {
	if (!warnings.includes(warning)) warnings.push(warning)
}

// Creates a discriminated failure with a fresh warnings array.
function failure(reason: ThreePointPolarAlignmentOverlayFailureReason, warnings: readonly PolarAlignmentOverlayWarning[]): ThreePointPolarAlignmentOverlayResult {
	return { success: false, reason, warnings: [...warnings] }
}
