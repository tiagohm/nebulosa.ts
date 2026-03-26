import { type Angle, arcsec } from './angle'
import { cirsToObserved, DEFAULT_REFRACTION_PARAMETERS, observedToCirs, type RefractionParameters } from './astrometry'
import { PI } from './constants'
import { eraC2s, eraS2c } from './erfa'
import { euclideanDistance, type Point } from './geometry'
import type { GeographicPosition } from './location'
import { matMulVec, matTransposeMulVec } from './mat3'
import type { PlateSolution } from './platesolver'
import type { DetectedStar } from './star.detector'
import { matchStars, type SimilarityTransform, type StarMatchingConfig, type StarMatchingResult } from './star.matching'
import { precessionNutationMatrix, type Time } from './time'
import { type MutVec3, type Vec3, vecAngle, vecCross, vecDot, vecMinus, vecMulScalar, vecNormalizeMut } from './vec3'
import { Wcs } from './wcs'

export type PolarAlignmentStage = 'WAITING_FOR_POSITION_1' | 'WAITING_FOR_POSITION_2' | 'INITIAL_AXIS_ESTIMATION' | 'REFINEMENT' | 'COMPLETE' | 'FAILED'

export type PolarAlignmentHemisphereMode = 'auto' | 'north' | 'south'

export type PolarAlignmentReferenceSpace = 'image-plane'

export type PolarAlignmentAction = 'WAIT_FOR_POSITION_1' | 'ROTATE_RA_TO_POSITION_2' | 'ADJUST_ALTITUDE_POSITIVE' | 'ADJUST_ALTITUDE_NEGATIVE' | 'ADJUST_AZIMUTH_POSITIVE' | 'ADJUST_AZIMUTH_NEGATIVE' | 'ALIGNMENT_COMPLETE' | 'INVALID_FRAME'

export type PolarAlignmentSolver = 'gauss-newton' | 'coordinate-search' | 'similarity-only'

export interface ObserverContext {
	readonly time: Time
	readonly location: GeographicPosition
	readonly hemisphereMode?: PolarAlignmentHemisphereMode
	readonly refraction?: RefractionParameters | false
}

export interface PolarAlignmentConfig {
	readonly hemisphereMode?: PolarAlignmentHemisphereMode
	readonly minimumAcceptedRaRotation?: Angle
	readonly preferredRaRotationRange?: readonly [Angle, Angle]
	readonly minimumStars?: number
	readonly completionThreshold?: Angle
	readonly offScreenArrowMargin?: number
	readonly fixedPointTolerance?: number
	readonly maxStarMatchResidual?: number
	readonly refraction?: RefractionParameters | false
	readonly compensateEarthRotation?: boolean
	readonly useStarMatchingValidation?: boolean
	readonly starMatchingConfig?: StarMatchingConfig
}

export interface PlateSolutionAdapter {
	readonly width: number
	readonly height: number
	readonly centerRightAscension: Angle
	readonly centerDeclination: Angle
	readonly frame: 'icrs-j2000'
	pixelToSky(x: number, y: number): readonly [Angle, Angle] | false
	skyToPixel(rightAscension: Angle, declination: Angle): readonly [number, number] | false
}

export interface PolarAlignmentFrameInput {
	readonly time: Time
	readonly plateSolution: PlateSolution | PlateSolutionAdapter
	readonly stars?: readonly DetectedStar[]
}

export interface PolarAlignmentGuidePoint extends Readonly<Point> {
	readonly onScreen: boolean
	readonly clamped: Readonly<Point>
	readonly arrow: Readonly<Point>
	readonly unclamped: Readonly<Point>
}

export interface PolarAlignmentResidualStatistics {
	readonly rms: number
	readonly median: number
	readonly maximum: number
}

export interface PolarAlignmentErrorMetrics {
	readonly totalError: Angle
	readonly altitudeError: Angle
	readonly azimuthError: Angle
}

export interface PolarAlignmentDiagnostics {
	readonly referenceSpace: PolarAlignmentReferenceSpace
	readonly solver?: PolarAlignmentSolver
	readonly solverIterations?: number
	readonly residual?: number
	readonly residualStatistics?: PolarAlignmentResidualStatistics
	readonly acceptedRaRotation?: Angle
	readonly preferredRaRotationRange: readonly [Angle, Angle]
	readonly starMatch?: StarMatchingResult
	readonly refractionEnabled: boolean
	readonly earthRotationCompensated: boolean
	readonly warnings: readonly string[]
}

export interface PolarAlignmentResult {
	readonly stage: PolarAlignmentStage
	readonly currentPoint: PolarAlignmentGuidePoint
	readonly targetPoint: PolarAlignmentGuidePoint
	readonly onScreenCurrent: boolean
	readonly onScreenTarget: boolean
	readonly totalError: Angle
	readonly altitudeError: Angle
	readonly azimuthError: Angle
	readonly action: PolarAlignmentAction
	readonly convergence: boolean
	readonly guidanceText: string
	readonly diagnostics: PolarAlignmentDiagnostics
}

export interface PolarAlignmentHistoryEntry {
	readonly stage: PolarAlignmentStage
	readonly time: Time
	readonly totalError?: Angle
	readonly altitudeError?: Angle
	readonly azimuthError?: Angle
}

export interface PolarAlignmentState {
	readonly stage: PolarAlignmentStage
	readonly hemisphere: 'north' | 'south'
	readonly config: Readonly<Required<PolarAlignmentConfig>>
	readonly observer: ObserverContext
	readonly referenceFrame?: PolarAlignmentResolvedFrame
	readonly secondFrame?: PolarAlignmentResolvedFrame
	readonly axisPixel?: Readonly<Point>
	readonly axisVector?: Vec3
	readonly targetVector?: Vec3
	readonly latestResult?: PolarAlignmentResult
	readonly latestDiagnostics?: PolarAlignmentDiagnostics
	readonly history: readonly PolarAlignmentHistoryEntry[]
}

interface PolarAlignmentResolvedFrame {
	readonly time: Time
	readonly adapter: PlateSolutionAdapter
	readonly stars?: readonly DetectedStar[]
}

interface FixedPointCandidate extends Readonly<Point> {
	readonly residual: number
	readonly mapped: Readonly<Point>
}

interface FixedPointSolution {
	readonly x: number
	readonly y: number
	readonly residual: number
	readonly iterations: number
	readonly solver: PolarAlignmentSolver
}

interface SimilarityFixedPoint extends Readonly<Point> {
	readonly determinant: number
}

interface PolarAlignmentMutableState {
	stage: PolarAlignmentStage
	hemisphere: 'north' | 'south'
	config: Required<PolarAlignmentConfig>
	observer?: ObserverContext
	referenceFrame?: PolarAlignmentResolvedFrame
	secondFrame?: PolarAlignmentResolvedFrame
	axisPixel?: Readonly<Point>
	axisVector?: Vec3
	targetVector?: Vec3
	latestResult?: PolarAlignmentResult
	latestDiagnostics?: PolarAlignmentDiagnostics
	history: PolarAlignmentHistoryEntry[]
}

const DEFAULT_POLAR_ALIGNMENT_CONFIG: Readonly<Required<PolarAlignmentConfig>> = {
	hemisphereMode: 'auto',
	minimumAcceptedRaRotation: arcsec(600),
	preferredRaRotationRange: [arcsec(1800), arcsec(7200)],
	minimumStars: 6,
	completionThreshold: arcsec(30),
	offScreenArrowMargin: 16,
	fixedPointTolerance: 1.5,
	maxStarMatchResidual: 2,
	refraction: DEFAULT_REFRACTION_PARAMETERS,
	compensateEarthRotation: true,
	useStarMatchingValidation: true,
	starMatchingConfig: {},
}

// Adapts the host plate solution to the minimal bidirectional mapping API required by the engine.
export function plateSolutionAdapterFrom(plateSolution: PlateSolution): PlateSolutionAdapter {
	const wcs = new Wcs(plateSolution)
	return {
		width: plateSolution.widthInPixels,
		height: plateSolution.heightInPixels,
		centerRightAscension: plateSolution.rightAscension,
		centerDeclination: plateSolution.declination,
		frame: 'icrs-j2000',
		pixelToSky: (x, y) => wcs.pixToSky(x, y) ?? false,
		skyToPixel: (rightAscension, declination) => wcs.skyToPix(rightAscension, declination) ?? false,
	}
}

// Detects whether the input already exposes a full adapter contract.
export function isPlateSolutionAdapter(input: PlateSolution | PlateSolutionAdapter): input is PlateSolutionAdapter {
	return 'pixelToSky' in input && 'skyToPixel' in input
}

// Converts a sky vector into tangent-plane coordinates around the chosen origin.
export function projectUnitVectorToTangentPlane(direction: Vec3, origin: Vec3): readonly [number, number] | false {
	const basis = tangentBasis(origin)
	const denom = vecDot(direction, origin)
	if (denom <= 0) return false
	return [vecDot(direction, basis.east) / denom, vecDot(direction, basis.north) / denom] as const
}

// Unprojects tangent-plane coordinates back into a unit direction.
export function unprojectTangentPlaneToUnitVector(x: number, y: number, origin: Vec3) {
	const basis = tangentBasis(origin)
	return vecNormalizeMut([origin[0] + x * basis.east[0] + y * basis.north[0], origin[1] + x * basis.east[1] + y * basis.north[1], origin[2] + x * basis.east[2] + y * basis.north[2]])
}

// Computes robust residual statistics for diagnostics and tests.
export function residualStatistics(values: readonly number[]): PolarAlignmentResidualStatistics {
	if (values.length === 0) return { rms: 0, median: 0, maximum: 0 }
	const sorted = [...values].sort((a, b) => a - b)
	let sumSq = 0
	for (let i = 0; i < values.length; i++) sumSq += values[i] * values[i]
	return {
		rms: Math.sqrt(sumSq / values.length),
		median: sorted[(sorted.length - 1) >> 1],
		maximum: sorted[sorted.length - 1],
	}
}

// Solves the fixed point of a similarity transform when the geometry is non-singular.
export function solveSimilarityFixedPoint(transform: SimilarityTransform): SimilarityFixedPoint | false {
	if (transform.mirrored) {
		const m00 = 1 - transform.a
		const m01 = -transform.b
		const m10 = -transform.b
		const m11 = 1 + transform.a
		const det = m00 * m11 - m01 * m10
		if (Math.abs(det) <= 1e-12) return false
		return { x: (m11 * transform.tx - m01 * transform.ty) / det, y: (-m10 * transform.tx + m00 * transform.ty) / det, determinant: det }
	}

	const m00 = 1 - transform.a
	const m01 = transform.b
	const m10 = -transform.b
	const m11 = 1 - transform.a
	const det = m00 * m11 - m01 * m10
	if (Math.abs(det) <= 1e-12) return false
	return { x: (m11 * transform.tx - m01 * transform.ty) / det, y: (-m10 * transform.tx + m00 * transform.ty) / det, determinant: det }
}

// Projects a drawing point to the image border when the physical point is off-screen.
export function projectGuidePoint(point: Point, width: number, height: number, margin: number = 0): PolarAlignmentGuidePoint {
	const left = margin
	const top = margin
	const right = width - margin
	const bottom = height - margin
	const onScreen = point.x >= left && point.x <= right && point.y >= top && point.y <= bottom
	if (onScreen) return { x: point.x, y: point.y, onScreen: true, clamped: { x: point.x, y: point.y }, arrow: { x: 0, y: 0 }, unclamped: { x: point.x, y: point.y } }

	const cx = width / 2
	const cy = height / 2
	const dx = point.x - cx
	const dy = point.y - cy
	let scale = Number.POSITIVE_INFINITY

	if (dx > 0) scale = Math.min(scale, (right - cx) / dx)
	else if (dx < 0) scale = Math.min(scale, (left - cx) / dx)

	if (dy > 0) scale = Math.min(scale, (bottom - cy) / dy)
	else if (dy < 0) scale = Math.min(scale, (top - cy) / dy)

	const clampedX = cx + dx * scale
	const clampedY = cy + dy * scale
	const length = Math.hypot(dx, dy)
	const invLength = length > 0 ? 1 / length : 0
	return {
		x: clampedX,
		y: clampedY,
		onScreen: false,
		clamped: { x: clampedX, y: clampedY },
		arrow: { x: dx * invLength, y: dy * invLength },
		unclamped: { x: point.x, y: point.y },
	}
}

// Computes the celestial pole direction in the same inertial J2000/ICRS frame used by the plate solver.
export function celestialPoleVector(time: Time, location: GeographicPosition = time.location!, hemisphere: 'north' | 'south' = location.latitude >= 0 ? 'north' : 'south', refraction: RefractionParameters | false = DEFAULT_REFRACTION_PARAMETERS): Vec3 {
	const azimuth = hemisphere === 'north' ? 0 : PI
	const altitude = Math.abs(location.latitude)
	const [rightAscension, declination] = observedToCirs(azimuth, altitude, time, refraction, location)
	return vecNormalizeMut(matTransposeMulVec(precessionNutationMatrix(time), eraS2c(rightAscension, declination)))
}

// Splits the small polar error into altitude and azimuth tangent components in the current topocentric frame.
export function decomposePolarError(axisVector: Vec3, targetVector: Vec3, time: Time, refraction: RefractionParameters | false = DEFAULT_REFRACTION_PARAMETERS, location: GeographicPosition = time.location!): PolarAlignmentErrorMetrics {
	const axisObserved = cirsToObserved(matMulVec(precessionNutationMatrix(time), axisVector), time, refraction, location)
	const targetObserved = cirsToObserved(matMulVec(precessionNutationMatrix(time), targetVector), time, refraction, location)
	const axisHorizontal = horizontalUnitVector(axisObserved.azimuth, axisObserved.altitude)
	const targetHorizontal = horizontalUnitVector(targetObserved.azimuth, targetObserved.altitude)
	const basis = horizontalBasis(targetObserved.azimuth, targetObserved.altitude)
	const dot = vecDot(axisHorizontal, targetHorizontal)
	const delta = vecMinus(axisHorizontal, vecMulScalar(targetHorizontal, dot), [0, 0, 0])
	return {
		totalError: vecAngle(axisVector, targetVector),
		altitudeError: vecDot(delta, basis.altitude),
		azimuthError: vecDot(delta, basis.azimuth),
	}
}

// Estimates the RA-axis pixel fixed point from two RA-only frames using a nonlinear root solve with a derivative-free fallback.
export function solveImageFixedPoint(reference: PlateSolutionAdapter, current: PlateSolutionAdapter, initialGuess?: Readonly<Point>, tolerance: number = 1.5): FixedPointSolution | false {
	const seed = initialGuess ?? { x: reference.width / 2, y: reference.height / 2 }
	const gaussNewton = solveByGaussNewton(reference, current, seed, tolerance)
	if (gaussNewton !== false) return gaussNewton
	const fallback = solveByCoordinateSearch(reference, current, seed, tolerance)
	if (fallback !== false) return fallback
	return false
}

// Provides a reusable iPolar-like engine with an explicit finite-state machine and time-aware per-frame updates.
export class IPolarPolarAlignment {
	private readonly state: PolarAlignmentMutableState

	constructor(config: PolarAlignmentConfig = {}) {
		this.state = {
			stage: 'WAITING_FOR_POSITION_1',
			hemisphere: 'north',
			config: { ...DEFAULT_POLAR_ALIGNMENT_CONFIG, ...config, preferredRaRotationRange: config.preferredRaRotationRange ?? DEFAULT_POLAR_ALIGNMENT_CONFIG.preferredRaRotationRange, starMatchingConfig: { ...DEFAULT_POLAR_ALIGNMENT_CONFIG.starMatchingConfig, ...config.starMatchingConfig } },
			history: [],
		}
	}

	// Resets the engine to its initial waiting stage.
	reset() {
		this.state.stage = 'WAITING_FOR_POSITION_1'
		this.state.observer = undefined
		this.state.referenceFrame = undefined
		this.state.secondFrame = undefined
		this.state.axisPixel = undefined
		this.state.axisVector = undefined
		this.state.targetVector = undefined
		this.state.latestResult = undefined
		this.state.latestDiagnostics = undefined
		this.state.history = []
	}

	// Returns an immutable snapshot of the current engine state.
	getState(): PolarAlignmentState {
		if (!this.state.observer) throw new Error('polar-alignment session has not started')
		return {
			stage: this.state.stage,
			hemisphere: this.state.hemisphere,
			config: this.state.config,
			observer: this.state.observer,
			referenceFrame: this.state.referenceFrame,
			secondFrame: this.state.secondFrame,
			axisPixel: this.state.axisPixel,
			axisVector: this.state.axisVector,
			targetVector: this.state.targetVector,
			latestResult: this.state.latestResult,
			latestDiagnostics: this.state.latestDiagnostics,
			history: [...this.state.history],
		}
	}

	// Stores the first solved frame and moves the engine into the RA-rotation acquisition stage.
	startPosition1(frameInput: PolarAlignmentFrameInput, observerContext?: ObserverContext): PolarAlignmentResult {
		const observer = observerContext ?? resolveObserverContext(frameInput, this.state.config)
		const resolved = resolveFrame(frameInput)
		const warnings = validateFrame(resolved, this.state.config)
		this.state.observer = observer
		this.state.hemisphere = resolveHemisphere(observer.location, observer.hemisphereMode ?? this.state.config.hemisphereMode)
		this.state.referenceFrame = resolved
		this.state.secondFrame = undefined
		this.state.axisPixel = undefined
		this.state.axisVector = undefined
		this.state.targetVector = undefined
		this.state.stage = 'WAITING_FOR_POSITION_2'
		const diagnostics = buildDiagnostics(this.state.config, warnings, undefined, undefined, undefined)
		const result = emptyResult('WAITING_FOR_POSITION_2', resolved.adapter, 'ROTATE_RA_TO_POSITION_2', 'Rotate the RA axis to the second calibration position.', diagnostics)
		return this.commit(result, resolved.time)
	}

	// Confirms the second RA-only frame, estimates the mount axis, and initializes the iterative alignment phase.
	confirmPosition2(frameInput: PolarAlignmentFrameInput): PolarAlignmentResult {
		if (!this.state.referenceFrame || !this.state.observer) throw new Error('position 1 must be stored before confirming position 2')
		const resolved = resolveFrame(frameInput)
		const warnings = validateFrame(resolved, this.state.config)
		const timingWarning = resolved.time.day < this.state.referenceFrame.time.day || (resolved.time.day === this.state.referenceFrame.time.day && resolved.time.fraction < this.state.referenceFrame.time.fraction) ? 'timestamps out of order' : undefined
		if (timingWarning) warnings.push(timingWarning)

		const starMatch = maybeMatchStars(this.state.referenceFrame.stars, resolved.stars, this.state.config)
		const similaritySeed = starMatch?.success && starMatch.similarity ? solveSimilarityFixedPoint(starMatch.similarity) : false
		const axis = solveImageFixedPoint(this.state.referenceFrame.adapter, resolved.adapter, similaritySeed === false ? undefined : similaritySeed, this.state.config.fixedPointTolerance)
		const acceptedRaRotation = separationBetweenCenters(this.state.referenceFrame.adapter, resolved.adapter)

		if (acceptedRaRotation < this.state.config.minimumAcceptedRaRotation || axis === false) {
			const failureWarnings = [...warnings]
			if (acceptedRaRotation < this.state.config.minimumAcceptedRaRotation) failureWarnings.push('too little RA rotation between calibration positions')
			if (axis === false) failureWarnings.push('failed to estimate a stable RA-axis fixed point')
			const diagnostics = buildDiagnostics(this.state.config, failureWarnings, starMatch, acceptedRaRotation, axis === false ? undefined : axis)
			const result = emptyResult('WAITING_FOR_POSITION_2', resolved.adapter, 'INVALID_FRAME', 'Acquire another second-position frame with more RA rotation.', diagnostics)
			return this.commit(result, resolved.time)
		}

		this.state.secondFrame = resolved
		this.state.axisPixel = { x: axis.x, y: axis.y }
		this.state.axisVector = skyVectorFromPixel(resolved.adapter, this.state.axisPixel)
		this.state.targetVector = celestialPoleVector(resolved.time, this.state.observer.location, this.state.hemisphere, this.state.config.refraction)
		this.state.stage = 'INITIAL_AXIS_ESTIMATION'
		const diagnostics = buildDiagnostics(this.state.config, warnings, starMatch, acceptedRaRotation, axis)
		const result = this.measureFrame(resolved, 'INITIAL_AXIS_ESTIMATION', diagnostics)
		const committed = this.commit(result, resolved.time)
		this.state.stage = committed.convergence ? 'COMPLETE' : 'REFINEMENT'
		return committed
	}

	// Advances the state machine using the next solved frame.
	update(frameInput: PolarAlignmentFrameInput): PolarAlignmentResult {
		if (!this.state.referenceFrame || !this.state.observer) return this.startPosition1(frameInput)
		if (this.state.stage === 'WAITING_FOR_POSITION_2') return this.confirmPosition2(frameInput)
		if (!this.state.axisPixel || !this.state.targetVector) throw new Error('axis calibration is missing')
		const resolved = resolveFrame(frameInput)
		const warnings = validateFrame(resolved, this.state.config)
		const diagnostics = buildDiagnostics(this.state.config, warnings, undefined, undefined, undefined)
		this.state.stage = this.state.stage === 'COMPLETE' ? 'COMPLETE' : 'REFINEMENT'
		const result = this.measureFrame(resolved, this.state.stage, diagnostics)
		return this.commit(result, resolved.time)
	}

	// Measures the current frame using the calibrated fixed sensor point and the true celestial pole.
	private measureFrame(frame: PolarAlignmentResolvedFrame, stage: PolarAlignmentStage, diagnostics: PolarAlignmentDiagnostics): PolarAlignmentResult {
		if (!this.state.axisPixel || !this.state.targetVector || !this.state.observer) throw new Error('alignment state is incomplete')
		const axisVector = skyVectorFromPixel(frame.adapter, this.state.axisPixel)
		const targetVector = celestialPoleVector(frame.time, this.state.observer.location, this.state.hemisphere, this.state.config.refraction)
		const metrics = decomposePolarError(axisVector, targetVector, frame.time, this.state.config.refraction, this.state.observer.location)
		const currentPoint = projectGuidePoint(this.state.axisPixel, frame.adapter.width, frame.adapter.height, this.state.config.offScreenArrowMargin)
		const targetPixel = pixelFromSkyVector(frame.adapter, targetVector)
		const targetPoint = projectGuidePoint(targetPixel, frame.adapter.width, frame.adapter.height, this.state.config.offScreenArrowMargin)
		this.state.axisVector = axisVector
		this.state.targetVector = targetVector
		const convergence = metrics.totalError <= this.state.config.completionThreshold
		const nextStage = convergence ? 'COMPLETE' : stage
		this.state.stage = nextStage
		return {
			stage: nextStage,
			currentPoint,
			targetPoint,
			onScreenCurrent: currentPoint.onScreen,
			onScreenTarget: targetPoint.onScreen,
			totalError: metrics.totalError,
			altitudeError: metrics.altitudeError,
			azimuthError: metrics.azimuthError,
			action: convergence ? 'ALIGNMENT_COMPLETE' : guidanceAction(metrics),
			convergence,
			guidanceText: convergence ? 'Alignment complete.' : guidanceText(metrics),
			diagnostics,
		}
	}

	// Persists the latest result and appends it to the debug history.
	private commit(result: PolarAlignmentResult, time: Time): PolarAlignmentResult {
		this.state.latestResult = result
		this.state.latestDiagnostics = result.diagnostics
		this.state.history.push({ stage: result.stage, time, totalError: result.totalError, altitudeError: result.altitudeError, azimuthError: result.azimuthError })
		return result
	}
}

// Resolves the frame input into a normalized adapter/stars/time triple.
function resolveFrame(frameInput: PolarAlignmentFrameInput): PolarAlignmentResolvedFrame {
	const adapter = isPlateSolutionAdapter(frameInput.plateSolution) ? frameInput.plateSolution : plateSolutionAdapterFrom(frameInput.plateSolution)
	return { time: frameInput.time, adapter, stars: frameInput.stars }
}

// Resolves the observer context from the explicit argument or from the embedded time/location object.
function resolveObserverContext(frameInput: PolarAlignmentFrameInput, config: Required<PolarAlignmentConfig>): ObserverContext {
	if (!frameInput.time.location) throw new Error('time.location is required when observerContext is omitted')
	return { time: frameInput.time, location: frameInput.time.location, hemisphereMode: config.hemisphereMode, refraction: config.refraction }
}

// Validates the minimal solve quality gates that can be checked without host-specific metadata.
function validateFrame(frame: PolarAlignmentResolvedFrame, config: Required<PolarAlignmentConfig>) {
	const warnings: string[] = []
	if (frame.adapter.width <= 0 || frame.adapter.height <= 0) warnings.push('invalid plate solution dimensions')
	if (frame.stars && frame.stars.length < config.minimumStars) warnings.push('insufficient stars')
	return warnings
}

// Builds a serializable diagnostics object.
function buildDiagnostics(config: Required<PolarAlignmentConfig>, warnings: readonly string[], starMatch?: StarMatchingResult, acceptedRaRotation?: Angle, axis?: FixedPointSolution): PolarAlignmentDiagnostics {
	return {
		referenceSpace: 'image-plane',
		solver: axis?.solver,
		solverIterations: axis?.iterations,
		residual: axis?.residual,
		residualStatistics: starMatch?.matches.length ? residualStatistics(starMatch.matches.map((entry) => entry.residual)) : undefined,
		acceptedRaRotation,
		preferredRaRotationRange: config.preferredRaRotationRange,
		starMatch,
		refractionEnabled: config.refraction !== false,
		earthRotationCompensated: config.compensateEarthRotation,
		warnings,
	}
}

// Creates the stage result used before the axis calibration is available.
function emptyResult(stage: PolarAlignmentStage, adapter: PlateSolutionAdapter, action: PolarAlignmentAction, guidanceText: string, diagnostics: PolarAlignmentDiagnostics): PolarAlignmentResult {
	const center = { x: adapter.width / 2, y: adapter.height / 2 }
	const guide = projectGuidePoint(center, adapter.width, adapter.height)
	return {
		stage,
		currentPoint: guide,
		targetPoint: guide,
		onScreenCurrent: guide.onScreen,
		onScreenTarget: guide.onScreen,
		totalError: 0,
		altitudeError: 0,
		azimuthError: 0,
		action,
		convergence: false,
		guidanceText,
		diagnostics,
	}
}

// Runs star matching when both frames provide detected stars and the feature is enabled.
function maybeMatchStars(referenceStars: readonly DetectedStar[] | undefined, currentStars: readonly DetectedStar[] | undefined, config: Required<PolarAlignmentConfig>) {
	if (!config.useStarMatchingValidation || !referenceStars || !currentStars) return undefined
	if (referenceStars.length < config.minimumStars || currentStars.length < config.minimumStars) return undefined
	return matchStars(referenceStars, currentStars, { maxResidual: config.maxStarMatchResidual, ...config.starMatchingConfig })
}

// Computes a practical RA-rotation proxy from the separation of the two solved frame centers.
function separationBetweenCenters(a: PlateSolutionAdapter, b: PlateSolutionAdapter) {
	return vecAngle(eraS2c(a.centerRightAscension, a.centerDeclination), eraS2c(b.centerRightAscension, b.centerDeclination))
}

// Computes the nonlinear image-space residual p - T(p) for the fixed-point solver.
function fixedPointResidual(reference: PlateSolutionAdapter, current: PlateSolutionAdapter, point: Readonly<Point>): FixedPointCandidate | false {
	const sky = reference.pixelToSky(point.x, point.y)
	if (sky === false) return false
	const mapped = current.skyToPixel(sky[0], sky[1])
	if (mapped === false) return false
	const mappedPoint = { x: mapped[0], y: mapped[1] }
	return { x: point.x, y: point.y, mapped: mappedPoint, residual: euclideanDistance(point, mappedPoint) }
}

// Solves the fixed point with a finite-difference Gauss-Newton iteration.
function solveByGaussNewton(reference: PlateSolutionAdapter, current: PlateSolutionAdapter, seed: Readonly<Point>, tolerance: number) {
	let x = seed.x
	let y = seed.y
	const step = 0.5

	for (let iteration = 0; iteration < 24; iteration++) {
		const center = fixedPointResidual(reference, current, { x, y })
		if (center === false) return false
		if (center.residual <= tolerance) return { x, y, residual: center.residual, iterations: iteration + 1, solver: 'gauss-newton' } as const

		const dxCandidate = fixedPointResidual(reference, current, { x: x + step, y })
		const dyCandidate = fixedPointResidual(reference, current, { x, y: y + step })
		if (dxCandidate === false || dyCandidate === false) return false

		const r0x = x - center.mapped.x
		const r0y = y - center.mapped.y
		const j00 = (x + step - dxCandidate.mapped.x - r0x) / step
		const j10 = (y - dxCandidate.mapped.y - r0y) / step
		const j01 = (x - dyCandidate.mapped.x - r0x) / step
		const j11 = (y + step - dyCandidate.mapped.y - r0y) / step
		const det = j00 * j11 - j01 * j10
		if (Math.abs(det) <= 1e-12) return false

		const deltaX = (j11 * r0x - j01 * r0y) / det
		const deltaY = (-j10 * r0x + j00 * r0y) / det
		x -= deltaX
		y -= deltaY

		if (!Number.isFinite(x) || !Number.isFinite(y)) return false
	}

	const final = fixedPointResidual(reference, current, { x, y })
	if (final === false || final.residual > tolerance) return false
	return { x, y, residual: final.residual, iterations: 24, solver: 'gauss-newton' } as const
}

// Falls back to a derivative-free coordinate search when the Jacobian-based solve is poorly conditioned.
function solveByCoordinateSearch(reference: PlateSolutionAdapter, current: PlateSolutionAdapter, seed: Readonly<Point>, tolerance: number) {
	let x = seed.x
	let y = seed.y
	let stride = Math.max(reference.width, reference.height) / 8
	let best = fixedPointResidual(reference, current, { x, y })
	if (best === false) return false

	for (let iteration = 0; iteration < 60; iteration++) {
		let improved = false
		for (let i = 0; i < 4; i++) {
			const candidate = i === 0 ? { x: x + stride, y } : i === 1 ? { x: x - stride, y } : i === 2 ? { x, y: y + stride } : { x, y: y - stride }
			const residual = fixedPointResidual(reference, current, candidate)
			if (residual !== false && residual.residual < best.residual) {
				x = candidate.x
				y = candidate.y
				best = residual
				improved = true
			}
		}

		if (best.residual <= tolerance) return { x, y, residual: best.residual, iterations: iteration + 1, solver: 'coordinate-search' } as const
		if (!improved) stride *= 0.5
		if (stride <= 0.125) break
	}

	if (best.residual > tolerance) return false
	return { x, y, residual: best.residual, iterations: 60, solver: 'coordinate-search' } as const
}

// Converts an image pixel into a normalized J2000/ICRS direction vector.
function skyVectorFromPixel(adapter: PlateSolutionAdapter, point: Readonly<Point>) {
	const sky = adapter.pixelToSky(point.x, point.y)
	if (sky === false) throw new Error('pixel does not map to a valid sky position')
	return eraS2c(sky[0], sky[1])
}

// Projects an inertial direction into the current frame and returns a best-effort pixel location.
function pixelFromSkyVector(adapter: PlateSolutionAdapter, vector: Vec3) {
	const [rightAscension, declination] = eraC2s(...vector)
	const pixel = adapter.skyToPixel(rightAscension, declination)
	if (pixel !== false) return { x: pixel[0], y: pixel[1] }

	const center = adapter.skyToPixel(adapter.centerRightAscension, adapter.centerDeclination)
	if (center !== false) return { x: center[0], y: center[1] }

	return { x: adapter.width / 2, y: adapter.height / 2 }
}

// Resolves the operating hemisphere.
function resolveHemisphere(location: GeographicPosition, mode: PolarAlignmentHemisphereMode = 'auto') {
	if (mode === 'north') return 'north'
	if (mode === 'south') return 'south'
	return location.latitude >= 0 ? 'north' : 'south'
}

// Builds an orthonormal tangent basis around the given sky direction.
function tangentBasis(origin: Vec3) {
	const reference = Math.abs(origin[2]) < 0.9 ? ([0, 0, 1] as const) : ([0, 1, 0] as const)
	const east = vecNormalizeMut(vecCross(reference, origin, [0, 0, 0]))
	const north = vecNormalizeMut(vecCross(origin, east, [0, 0, 0]))
	return { east, north } as const
}

// Converts topocentric azimuth/altitude to a unit vector in the local east-north-up basis.
function horizontalUnitVector(azimuth: Angle, altitude: Angle): MutVec3 {
	const cosAltitude = Math.cos(altitude)
	return [cosAltitude * Math.sin(azimuth), cosAltitude * Math.cos(azimuth), Math.sin(altitude)]
}

// Builds the local tangent basis aligned with azimuth and altitude directions.
function horizontalBasis(azimuth: Angle, altitude: Angle) {
	return {
		azimuth: [Math.cos(azimuth), -Math.sin(azimuth), 0] as Vec3,
		altitude: [-Math.sin(altitude) * Math.sin(azimuth), -Math.sin(altitude) * Math.cos(azimuth), Math.cos(altitude)] as Vec3,
	} as const
}

// Chooses the next machine-friendly action from the signed split error components.
function guidanceAction(metrics: PolarAlignmentErrorMetrics): PolarAlignmentAction {
	if (Math.abs(metrics.altitudeError) >= Math.abs(metrics.azimuthError)) return metrics.altitudeError <= 0 ? 'ADJUST_ALTITUDE_POSITIVE' : 'ADJUST_ALTITUDE_NEGATIVE'
	return metrics.azimuthError <= 0 ? 'ADJUST_AZIMUTH_POSITIVE' : 'ADJUST_AZIMUTH_NEGATIVE'
}

// Generates concise operator guidance text from the signed error components.
function guidanceText(metrics: PolarAlignmentErrorMetrics) {
	const dominant = Math.abs(metrics.altitudeError) >= Math.abs(metrics.azimuthError)
	if (dominant) return metrics.altitudeError <= 0 ? 'Increase altitude adjustment.' : 'Decrease altitude adjustment.'
	return metrics.azimuthError <= 0 ? 'Increase azimuth adjustment.' : 'Decrease azimuth adjustment.'
}
