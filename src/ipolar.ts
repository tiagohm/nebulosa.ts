import type { Angle } from './angle'
import { cirsToObserved, DEFAULT_REFRACTION_PARAMETERS, observedToCirs, type RefractionParameters } from './astrometry'
import { ASEC2RAD, PI } from './constants'
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

export type IPolarPolarAlignmentStage = 'WAITING_FOR_POSITION_1' | 'WAITING_FOR_POSITION_2' | 'INITIAL_AXIS_ESTIMATION' | 'REFINEMENT' | 'COMPLETE' | 'FAILED'

export type IPolarPolarAlignmentHemisphereMode = 'auto' | 'north' | 'south'

export type IPolarPolarAlignmentAction = 'WAIT_FOR_POSITION_1' | 'ROTATE_RA_TO_POSITION_2' | 'ADJUST_ALTITUDE_POSITIVE' | 'ADJUST_ALTITUDE_NEGATIVE' | 'ADJUST_AZIMUTH_POSITIVE' | 'ADJUST_AZIMUTH_NEGATIVE' | 'ALIGNMENT_COMPLETE' | 'INVALID_FRAME'

export type IPolarPolarAlignmentSolverMethod = 'gauss-newton' | 'coordinate-search' | 'similarity-only'

export interface IPolarPolarAlignmentObserverContext {
	readonly location: GeographicPosition
	readonly hemisphereMode?: IPolarPolarAlignmentHemisphereMode
	readonly refraction?: RefractionParameters | false
}

export interface IPolarPolarAlignmentConfig {
	readonly hemisphereMode?: IPolarPolarAlignmentHemisphereMode
	readonly minimumAcceptedRaRotation?: Angle
	readonly preferredRaRotationRange?: readonly [Angle, Angle]
	readonly minimumStars?: number
	readonly completionThreshold?: Angle
	readonly fixedPointTolerance?: number
	readonly maxStarMatchResidual?: number
	readonly refraction?: RefractionParameters | false
	readonly compensateEarthRotation?: boolean
	readonly useStarMatchingValidation?: boolean
	readonly starMatchingConfig?: StarMatchingConfig
}

export interface IPolarPolarAlignmentFrameInput {
	readonly time: Time
	readonly solution: PlateSolution
	readonly stars?: readonly DetectedStar[]
}

export interface IPolarPolarAlignmentGuidePoint extends Readonly<Point> {
	readonly onScreen: boolean
	readonly clamped: Readonly<Point>
	readonly arrow: Readonly<Point>
	readonly unclamped: Readonly<Point>
}

export interface IPolarPolarAlignmentErrorMetrics {
	readonly totalError: Angle
	readonly altitudeError: Angle
	readonly azimuthError: Angle
}

export interface IPolarPolarAlignmentDiagnostics {
	readonly solver?: IPolarPolarAlignmentSolverMethod
	readonly solverIterations?: number
	readonly residual?: number
	readonly acceptedRaRotation?: Angle
	readonly preferredRaRotationRange: readonly [Angle, Angle]
	readonly starMatch?: StarMatchingResult
	readonly refractionEnabled: boolean
	readonly earthRotationCompensated: boolean
	readonly warnings: readonly string[]
}

export interface IPolarPolarAlignmentResult extends IPolarPolarAlignmentErrorMetrics {
	readonly stage: IPolarPolarAlignmentStage
	readonly currentPoint: IPolarPolarAlignmentGuidePoint
	readonly targetPoint: IPolarPolarAlignmentGuidePoint
	readonly onScreenCurrent: boolean
	readonly onScreenTarget: boolean
	readonly action: IPolarPolarAlignmentAction
	readonly convergence: boolean
	readonly diagnostics: IPolarPolarAlignmentDiagnostics
}

export interface IPolarPolarAlignmentState {
	readonly stage: IPolarPolarAlignmentStage
	readonly hemisphere: 'north' | 'south'
	readonly config: Readonly<Required<IPolarPolarAlignmentConfig>>
	readonly observer: IPolarPolarAlignmentObserverContext
	readonly referenceFrame?: IPolarPolarAlignmentFrameInput
	readonly secondFrame?: IPolarPolarAlignmentFrameInput
	readonly axisPixel?: Readonly<Point>
	readonly axisVector?: Vec3
	readonly targetVector?: Vec3
	readonly latestResult?: IPolarPolarAlignmentResult
	readonly latestDiagnostics?: IPolarPolarAlignmentDiagnostics
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
	readonly solver: IPolarPolarAlignmentSolverMethod
}

interface SimilarityFixedPoint extends Readonly<Point> {
	readonly determinant: number
}

interface PolarAlignmentMutableState {
	stage: IPolarPolarAlignmentStage
	hemisphere: 'north' | 'south'
	config: Required<IPolarPolarAlignmentConfig>
	observer?: IPolarPolarAlignmentObserverContext
	referenceFrame?: IPolarPolarAlignmentFrameInput
	secondFrame?: IPolarPolarAlignmentFrameInput
	axisPixel?: Readonly<Point>
	axisVector?: Vec3
	targetVector?: Vec3
	latestResult?: IPolarPolarAlignmentResult
	latestDiagnostics?: IPolarPolarAlignmentDiagnostics
}

const DEFAULT_POLAR_ALIGNMENT_CONFIG: Readonly<Required<IPolarPolarAlignmentConfig>> = {
	hemisphereMode: 'auto',
	minimumAcceptedRaRotation: 600 * ASEC2RAD,
	preferredRaRotationRange: [1800 * ASEC2RAD, 7200 * 7200],
	minimumStars: 6,
	completionThreshold: 30 * ASEC2RAD,
	fixedPointTolerance: 1.5,
	maxStarMatchResidual: 2,
	refraction: DEFAULT_REFRACTION_PARAMETERS,
	compensateEarthRotation: true,
	useStarMatchingValidation: true,
	starMatchingConfig: {},
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

// Solves the fixed point of a similarity transform when the geometry is non-singular.
export function solveSimilarityFixedPoint(transform: SimilarityTransform): SimilarityFixedPoint | false {
	if (transform.mirrored) {
		const m00 = 1 - transform.a
		const m01 = -transform.b
		const m10 = -transform.b
		const m11 = 1 + transform.a
		const det = m00 * m11 - m01 * m10

		if (Math.abs(det) <= 1e-12) return false
		else return { x: (m11 * transform.tx - m01 * transform.ty) / det, y: (-m10 * transform.tx + m00 * transform.ty) / det, determinant: det }
	}

	const m00 = 1 - transform.a
	const m01 = transform.b
	const m10 = -transform.b
	const m11 = 1 - transform.a
	const det = m00 * m11 - m01 * m10

	if (Math.abs(det) <= 1e-12) return false
	else return { x: (m11 * transform.tx - m01 * transform.ty) / det, y: (-m10 * transform.tx + m00 * transform.ty) / det, determinant: det }
}

// Projects a drawing point to the image border when the physical point is off-screen.
export function projectGuidePoint(point: Point, width: number, height: number, margin: number = 0): IPolarPolarAlignmentGuidePoint {
	const left = margin
	const top = margin
	const right = width - margin
	const bottom = height - margin
	const onScreen = point.x >= left && point.x <= right && point.y >= top && point.y <= bottom

	if (onScreen) return { ...point, onScreen: true, clamped: { ...point }, arrow: { x: 0, y: 0 }, unclamped: { ...point } }

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
export function decomposePolarError(axisVector: Vec3, targetVector: Vec3, time: Time, refraction: RefractionParameters | false = DEFAULT_REFRACTION_PARAMETERS, location: GeographicPosition = time.location!): IPolarPolarAlignmentErrorMetrics {
	const axisObserved = cirsToObserved(matMulVec(precessionNutationMatrix(time), axisVector), time, refraction, location)
	const targetObserved = cirsToObserved(matMulVec(precessionNutationMatrix(time), targetVector), time, refraction, location)
	const axisHorizontal = eraS2c(axisObserved.azimuth, axisObserved.altitude)
	const targetHorizontal = eraS2c(targetObserved.azimuth, targetObserved.altitude)
	const basis = horizontalBasis(targetObserved.azimuth, targetObserved.altitude)
	const dot = vecDot(axisHorizontal, targetHorizontal)
	const delta = vecMinus(axisHorizontal, vecMulScalar(targetHorizontal, dot))
	return { totalError: vecAngle(axisVector, targetVector), altitudeError: vecDot(delta, basis.altitude), azimuthError: vecDot(delta, basis.azimuth) }
}

// Estimates the RA-axis pixel fixed point from two RA-only frames using a nonlinear root solve with a derivative-free fallback.
export function solveImageFixedPoint(reference: PlateSolution, current: PlateSolution, initialGuess?: Readonly<Point>, tolerance: number = 1.5): FixedPointSolution | false {
	const seed = initialGuess ?? { x: reference.widthInPixels * 0.5, y: reference.heightInPixels * 0.5 }
	const gaussNewton = solveByGaussNewton(reference, current, seed, tolerance)
	if (gaussNewton !== false) return gaussNewton
	const fallback = solveByCoordinateSearch(reference, current, seed, tolerance)
	if (fallback !== false) return fallback
	return false
}

// Provides a reusable iPolar-like engine with an explicit finite-state machine and time-aware per-frame updates.
export class IPolarPolarAlignment {
	readonly #state: PolarAlignmentMutableState

	constructor(config: IPolarPolarAlignmentConfig = {}) {
		this.#state = {
			stage: 'WAITING_FOR_POSITION_1',
			hemisphere: 'north',
			config: { ...DEFAULT_POLAR_ALIGNMENT_CONFIG, ...config, preferredRaRotationRange: config.preferredRaRotationRange ?? DEFAULT_POLAR_ALIGNMENT_CONFIG.preferredRaRotationRange, starMatchingConfig: { ...DEFAULT_POLAR_ALIGNMENT_CONFIG.starMatchingConfig, ...config.starMatchingConfig } },
		}
	}

	// Resets the engine to its initial waiting stage.
	reset() {
		this.#state.stage = 'WAITING_FOR_POSITION_1'
		this.#state.observer = undefined
		this.#state.referenceFrame = undefined
		this.#state.secondFrame = undefined
		this.#state.axisPixel = undefined
		this.#state.axisVector = undefined
		this.#state.targetVector = undefined
		this.#state.latestResult = undefined
		this.#state.latestDiagnostics = undefined
	}

	// Returns an immutable snapshot of the current engine state.
	getState(): IPolarPolarAlignmentState {
		if (!this.#state.observer) throw new Error('polar-alignment session has not started')

		return {
			stage: this.#state.stage,
			hemisphere: this.#state.hemisphere,
			config: this.#state.config,
			observer: this.#state.observer,
			referenceFrame: this.#state.referenceFrame,
			secondFrame: this.#state.secondFrame,
			axisPixel: this.#state.axisPixel,
			axisVector: this.#state.axisVector,
			targetVector: this.#state.targetVector,
			latestResult: this.#state.latestResult,
			latestDiagnostics: this.#state.latestDiagnostics,
		}
	}

	// Stores the first solved frame and moves the engine into the RA-rotation acquisition stage.
	start(frameInput: IPolarPolarAlignmentFrameInput, observerContext?: IPolarPolarAlignmentObserverContext): IPolarPolarAlignmentResult {
		const observer = observerContext ?? resolveObserverContext(frameInput, this.#state.config)
		const warnings = validateFrame(frameInput, this.#state.config)
		this.#state.observer = observer
		this.#state.hemisphere = resolveHemisphere(observer.location, observer.hemisphereMode ?? this.#state.config.hemisphereMode)
		this.#state.referenceFrame = frameInput
		this.#state.secondFrame = undefined
		this.#state.axisPixel = undefined
		this.#state.axisVector = undefined
		this.#state.targetVector = undefined
		this.#state.stage = 'WAITING_FOR_POSITION_2'
		const diagnostics = buildDiagnostics(this.#state.config, warnings, undefined, undefined, undefined)
		const result = emptyResult('WAITING_FOR_POSITION_2', frameInput.solution, 'ROTATE_RA_TO_POSITION_2', diagnostics) // Should rotate the RA axis to the second calibration position
		return this.commit(result)
	}

	// Confirms the second RA-only frame, estimates the mount axis, and initializes the iterative alignment phase.
	confirm(frameInput: IPolarPolarAlignmentFrameInput): IPolarPolarAlignmentResult {
		if (!this.#state.referenceFrame || !this.#state.observer) throw new Error('position 1 must be stored before confirming position 2')

		const warnings = validateFrame(frameInput, this.#state.config)
		const timingWarning = frameInput.time.day < this.#state.referenceFrame.time.day || (frameInput.time.day === this.#state.referenceFrame.time.day && frameInput.time.fraction < this.#state.referenceFrame.time.fraction) ? 'timestamps out of order' : undefined
		if (timingWarning) warnings.push(timingWarning)

		const starMatch = maybeMatchStars(this.#state.referenceFrame.stars, frameInput.stars, this.#state.config)
		const similaritySeed = starMatch?.success && starMatch.similarity ? solveSimilarityFixedPoint(starMatch.similarity) : false
		const axis = solveImageFixedPoint(this.#state.referenceFrame.solution, frameInput.solution, similaritySeed === false ? undefined : similaritySeed, this.#state.config.fixedPointTolerance)
		const acceptedRaRotation = separationBetweenCenters(this.#state.referenceFrame.solution, frameInput.solution)

		if (acceptedRaRotation < this.#state.config.minimumAcceptedRaRotation || axis === false) {
			const failureWarnings = [...warnings]
			if (acceptedRaRotation < this.#state.config.minimumAcceptedRaRotation) failureWarnings.push('too little RA rotation between calibration positions')
			if (axis === false) failureWarnings.push('failed to estimate a stable RA-axis fixed point')
			const diagnostics = buildDiagnostics(this.#state.config, failureWarnings, starMatch, acceptedRaRotation, axis === false ? undefined : axis)
			const result = emptyResult('WAITING_FOR_POSITION_2', frameInput.solution, 'INVALID_FRAME', diagnostics) // Should acquire another second-position frame with more RA rotation
			return this.commit(result)
		}

		this.#state.secondFrame = frameInput
		this.#state.axisPixel = { x: axis.x, y: axis.y }
		this.#state.axisVector = skyVectorFromPixel(frameInput.solution, this.#state.axisPixel)
		this.#state.targetVector = celestialPoleVector(frameInput.time, this.#state.observer.location, this.#state.hemisphere, this.#state.config.refraction)
		this.#state.stage = 'INITIAL_AXIS_ESTIMATION'
		const diagnostics = buildDiagnostics(this.#state.config, warnings, starMatch, acceptedRaRotation, axis)
		const result = this.measureFrame(frameInput, 'INITIAL_AXIS_ESTIMATION', diagnostics)
		const committed = this.commit(result)
		this.#state.stage = committed.convergence ? 'COMPLETE' : 'REFINEMENT'
		return committed
	}

	// Advances the state machine using the next solved frame.
	update(frameInput: IPolarPolarAlignmentFrameInput): IPolarPolarAlignmentResult {
		if (!this.#state.referenceFrame || !this.#state.observer) return this.start(frameInput)
		if (this.#state.stage === 'WAITING_FOR_POSITION_2') return this.confirm(frameInput)
		if (!this.#state.axisPixel || !this.#state.targetVector) throw new Error('axis calibration is missing')
		const warnings = validateFrame(frameInput, this.#state.config)
		const diagnostics = buildDiagnostics(this.#state.config, warnings, undefined, undefined, undefined)
		this.#state.stage = this.#state.stage === 'COMPLETE' ? 'COMPLETE' : 'REFINEMENT'
		const result = this.measureFrame(frameInput, this.#state.stage, diagnostics)
		return this.commit(result)
	}

	// Measures the current frame using the calibrated fixed sensor point and the true celestial pole.
	private measureFrame(frame: IPolarPolarAlignmentFrameInput, stage: IPolarPolarAlignmentStage, diagnostics: IPolarPolarAlignmentDiagnostics): IPolarPolarAlignmentResult {
		if (!this.#state.axisPixel || !this.#state.targetVector || !this.#state.observer) throw new Error('alignment state is incomplete')
		const axisVector = skyVectorFromPixel(frame.solution, this.#state.axisPixel)
		const targetVector = celestialPoleVector(frame.time, this.#state.observer.location, this.#state.hemisphere, this.#state.config.refraction)
		const metrics = decomposePolarError(axisVector, targetVector, frame.time, this.#state.config.refraction, this.#state.observer.location)
		const currentPoint = projectGuidePoint(this.#state.axisPixel, frame.solution.widthInPixels, frame.solution.heightInPixels)
		const targetPixel = pixelFromSkyVector(frame.solution, targetVector)
		const targetPoint = projectGuidePoint(targetPixel, frame.solution.widthInPixels, frame.solution.heightInPixels)
		this.#state.axisVector = axisVector
		this.#state.targetVector = targetVector
		const convergence = metrics.totalError <= this.#state.config.completionThreshold
		const nextStage = convergence ? 'COMPLETE' : stage
		this.#state.stage = nextStage

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
			diagnostics,
		}
	}

	// Persists the latest result and appends it to the debug history.
	private commit(result: IPolarPolarAlignmentResult): IPolarPolarAlignmentResult {
		this.#state.latestResult = result
		this.#state.latestDiagnostics = result.diagnostics
		return result
	}
}

// Resolves the observer context from the explicit argument or from the embedded time/location object.
function resolveObserverContext(frameInput: IPolarPolarAlignmentFrameInput, config: Required<IPolarPolarAlignmentConfig>): IPolarPolarAlignmentObserverContext {
	if (!frameInput.time.location) throw new Error('location is required when observerContext is omitted')
	return { location: frameInput.time.location, hemisphereMode: config.hemisphereMode, refraction: config.refraction }
}

// Validates the minimal solve quality gates that can be checked without host-specific metadata.
function validateFrame(frame: IPolarPolarAlignmentFrameInput, config: Required<IPolarPolarAlignmentConfig>) {
	const warnings: string[] = []
	if (frame.solution.widthInPixels <= 0 || frame.solution.heightInPixels <= 0) warnings.push('invalid plate solution dimensions')
	if (frame.stars && frame.stars.length < config.minimumStars) warnings.push('insufficient stars')
	return warnings
}

// Builds a serializable diagnostics object.
function buildDiagnostics(config: Required<IPolarPolarAlignmentConfig>, warnings: readonly string[], starMatch?: StarMatchingResult, acceptedRaRotation?: Angle, axis?: FixedPointSolution): IPolarPolarAlignmentDiagnostics {
	return {
		solver: axis?.solver,
		solverIterations: axis?.iterations,
		residual: axis?.residual,
		acceptedRaRotation,
		preferredRaRotationRange: config.preferredRaRotationRange,
		starMatch,
		refractionEnabled: config.refraction !== false,
		earthRotationCompensated: config.compensateEarthRotation,
		warnings,
	}
}

// Creates the stage result used before the axis calibration is available.
function emptyResult(stage: IPolarPolarAlignmentStage, adapter: PlateSolution, action: IPolarPolarAlignmentAction, diagnostics: IPolarPolarAlignmentDiagnostics): IPolarPolarAlignmentResult {
	const center = { x: adapter.widthInPixels * 0.5, y: adapter.heightInPixels * 0.5 }
	const guide = projectGuidePoint(center, adapter.widthInPixels, adapter.heightInPixels)
	return { stage, currentPoint: guide, targetPoint: guide, onScreenCurrent: guide.onScreen, onScreenTarget: guide.onScreen, totalError: 0, altitudeError: 0, azimuthError: 0, action, convergence: false, diagnostics }
}

// Runs star matching when both frames provide detected stars and the feature is enabled.
function maybeMatchStars(referenceStars: readonly DetectedStar[] | undefined, currentStars: readonly DetectedStar[] | undefined, config: Required<IPolarPolarAlignmentConfig>) {
	if (!config.useStarMatchingValidation || !referenceStars || !currentStars) return undefined
	if (referenceStars.length < config.minimumStars || currentStars.length < config.minimumStars) return undefined
	return matchStars(referenceStars, currentStars, { maxResidual: config.maxStarMatchResidual, ...config.starMatchingConfig })
}

// Computes a practical RA-rotation proxy from the separation of the two solved frame centers.
function separationBetweenCenters(a: PlateSolution, b: PlateSolution) {
	return vecAngle(eraS2c(a.rightAscension, a.declination), eraS2c(b.rightAscension, b.declination))
}

// Computes the nonlinear image-space residual p - T(p) for the fixed-point solver.
function fixedPointResidual(reference: PlateSolution, current: PlateSolution, point: Readonly<Point>): FixedPointCandidate | false {
	const sky = pixelToSky(reference, point.x, point.y)
	if (sky === false) return false
	const mapped = skyToPixel(current, sky[0], sky[1])
	if (mapped === false) return false
	const mappedPoint = { x: mapped[0], y: mapped[1] }
	return { x: point.x, y: point.y, mapped: mappedPoint, residual: euclideanDistance(point, mappedPoint) }
}

// Solves the fixed point with a finite-difference Gauss-Newton iteration.
function solveByGaussNewton(reference: PlateSolution, current: PlateSolution, seed: Readonly<Point>, tolerance: number) {
	let { x, y } = seed
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

		x -= (j11 * r0x - j01 * r0y) / det
		y -= (-j10 * r0x + j00 * r0y) / det

		if (!Number.isFinite(x) || !Number.isFinite(y)) return false
	}

	const final = fixedPointResidual(reference, current, { x, y })
	if (final === false || final.residual > tolerance) return false
	return { x, y, residual: final.residual, iterations: 24, solver: 'gauss-newton' } as const
}

// Falls back to a derivative-free coordinate search when the Jacobian-based solve is poorly conditioned.
function solveByCoordinateSearch(reference: PlateSolution, current: PlateSolution, seed: Readonly<Point>, tolerance: number) {
	let { x, y } = seed
	let stride = Math.max(reference.widthInPixels, reference.heightInPixels) / 8
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
	else return { x, y, residual: best.residual, iterations: 60, solver: 'coordinate-search' } as const
}

// Converts an image pixel into a normalized J2000/ICRS direction vector.
function skyVectorFromPixel(solution: PlateSolution, point: Readonly<Point>) {
	const sky = pixelToSky(solution, point.x, point.y)
	if (sky === false) throw new Error('pixel does not map to a valid sky position')
	return eraS2c(sky[0], sky[1])
}

// Projects an inertial direction into the current frame and returns a best-effort pixel location.
function pixelFromSkyVector(solution: PlateSolution, vector: Vec3) {
	const [rightAscension, declination] = eraC2s(...vector)
	const pixel = skyToPixel(solution, rightAscension, declination)
	if (pixel !== false) return { x: pixel[0], y: pixel[1] }

	const center = skyToPixel(solution, solution.rightAscension, solution.declination)
	if (center !== false) return { x: center[0], y: center[1] }

	return { x: solution.widthInPixels * 0.5, y: solution.heightInPixels * 0.5 }
}

function skyToPixel(solution: PlateSolution, rightAscension: Angle, declination: Angle) {
	using wcs = new Wcs(solution)
	return wcs.skyToPix(rightAscension, declination) ?? false
}

function pixelToSky(solution: PlateSolution, x: number, y: number) {
	using wcs = new Wcs(solution)
	return wcs.pixToSky(x, y) ?? false
}

// Resolves the operating hemisphere.
function resolveHemisphere(location: GeographicPosition, mode: IPolarPolarAlignmentHemisphereMode = 'auto') {
	if (mode === 'north') return 'north'
	if (mode === 'south') return 'south'
	return location.latitude >= 0 ? 'north' : 'south'
}

// Builds an orthonormal tangent basis around the given sky direction.
function tangentBasis(origin: Vec3) {
	const reference: MutVec3 = Math.abs(origin[2]) < 0.9 ? [0, 0, 1] : [0, 1, 0]
	const east = vecNormalizeMut(vecCross(reference, origin, reference))
	const north = vecNormalizeMut(vecCross(origin, east))
	return { east, north } as const
}

// Builds the local tangent basis aligned with azimuth and altitude directions.
function horizontalBasis(azimuth: Angle, altitude: Angle) {
	return {
		azimuth: [Math.cos(azimuth), -Math.sin(azimuth), 0] as Vec3,
		altitude: [-Math.sin(altitude) * Math.sin(azimuth), -Math.sin(altitude) * Math.cos(azimuth), Math.cos(altitude)] as Vec3,
	} as const
}

// Chooses the next machine-friendly action from the signed split error components.
function guidanceAction(metrics: IPolarPolarAlignmentErrorMetrics): IPolarPolarAlignmentAction {
	if (Math.abs(metrics.altitudeError) >= Math.abs(metrics.azimuthError)) return metrics.altitudeError <= 0 ? 'ADJUST_ALTITUDE_POSITIVE' : 'ADJUST_ALTITUDE_NEGATIVE'
	return metrics.azimuthError <= 0 ? 'ADJUST_AZIMUTH_POSITIVE' : 'ADJUST_AZIMUTH_NEGATIVE'
}
