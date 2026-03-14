import type { Angle } from './angle'
import type { Point } from './geometry'
import { type AxisPulse, type CalibrationMatrix, DEFAULT_GUIDER_CONFIG, filterGuideStars, type GuideDirectionDEC, type GuideDirectionRA, type GuideFrame, type GuideStar, oppositeRA, type StarFilterConfig } from './guider'
import { clamp } from './math'

export type GuidingCalibrationPhase = 'idle' | 'precheck' | 'acquireLock' | 'raForwardPulse' | 'raForwardMeasure' | 'raForwardComplete' | 'raClearPulse' | 'raClearMeasure' | 'decForwardPulse' | 'decForwardMeasure' | 'decBacklashClearing' | 'decForwardComplete' | 'solving' | 'validating' | 'completed' | 'failed'

export type GuidingCalibrationFailureCode =
	| 'invalid_config'
	| 'no_usable_star'
	| 'bad_frame'
	| 'star_lost'
	| 'star_near_edge'
	| 'impossible_jump'
	| 'insufficient_ra_movement'
	| 'insufficient_dec_movement'
	| 'too_many_ra_no_motion_steps'
	| 'too_many_dec_no_motion_steps'
	| 'ra_clearing_failed'
	| 'axis_rate_invalid'
	| 'axis_direction_inconsistent'
	| 'axes_too_parallel'
	| 'matrix_singular'

export interface CalibrationPulseCommand {
	readonly ra: AxisPulse
	readonly dec: AxisPulse
}

export interface GuidingCalibrationConfig {
	readonly raPulse: number // ms
	readonly decPulse: number // ms
	readonly raDirection: GuideDirectionRA
	readonly decDirection: GuideDirectionDEC
	readonly maxRaSteps: number
	readonly maxDecSteps: number
	readonly maxRaNoMotionSteps: number
	readonly maxDecNoMotionSteps: number
	readonly minMovePerStepPx: number
	readonly minNetRaTravelPx: number
	readonly minNetDecTravelPx: number
	readonly maxFrameJumpPx: number
	readonly maxBadFrames: number
	readonly settleFramesAfterMove: number
	readonly clearingMoveEnabled: boolean
	readonly clearingMoveFraction: number
	readonly maxClearingSteps: number
	readonly maxClearingOffsetPx: number
	readonly minAxisSeparation: Angle
	readonly minDeterminant: number
	readonly maxMatchDistancePx: number
	readonly edgeMarginPx: number
	readonly minFrameQuality: number
	readonly minRatePxPerMs: number
	readonly maxRatePxPerMs: number
	readonly filter: StarFilterConfig
}

export interface GuidingCalibrationSample {
	readonly step: number
	readonly pulse: number // ms
	readonly pulseDirection: GuideDirectionRA | GuideDirectionDEC
	readonly x: number
	readonly y: number
	readonly deltaX: number
	readonly deltaY: number
	readonly netX: number
	readonly netY: number
	readonly stepDistance: number
	readonly netDistance: number
	readonly projectedDistance: number
	readonly orthogonalDistance: number
	readonly frameId?: number
	readonly timestamp?: number
}

export interface GuidingCalibrationAxisSolution {
	readonly unitX: number
	readonly unitY: number
	readonly ratePxPerMs: number
	readonly totalTravelPx: number
	readonly totalPulse: number
	readonly angle: Angle
	readonly rmsOrthogonalResidualPx: number
	readonly negativeProjectionCount: number
}

export interface GuidingCalibrationAxisSolutionForDirection<D> extends GuidingCalibrationAxisSolution {
	readonly direction: D
}

export interface GuidingCalibrationFailure {
	readonly code: GuidingCalibrationFailureCode
	readonly phase: GuidingCalibrationPhase
	readonly message: string
	readonly frameId?: number
}

export interface GuidingCalibrationResult {
	readonly ra: GuidingCalibrationAxisSolutionForDirection<GuideDirectionRA>
	readonly dec: GuidingCalibrationAxisSolutionForDirection<GuideDirectionDEC>
	readonly imageMotion: CalibrationMatrix
	readonly imageToAxis: CalibrationMatrix
	readonly determinant: number
	readonly backlash: number // ms
	readonly startX: number
	readonly startY: number
	readonly decStartX: number
	readonly decStartY: number
	readonly clearingSteps: number
	readonly warnings: readonly string[]
}

export interface GuidingCalibrationDiagnostics {
	readonly phase: GuidingCalibrationPhase
	readonly frameId?: number
	readonly totalStars: number
	readonly acceptedStars: number
	readonly qualityScore: number
	readonly rejectedReasons: Readonly<Record<string, number>>
	readonly startX?: number
	readonly startY?: number
	readonly currentX?: number
	readonly currentY?: number
	readonly decStartX?: number
	readonly decStartY?: number
	readonly raSteps: number
	readonly decSteps: number
	readonly clearingSteps: number
	readonly raNetDistancePx: number
	readonly decNetDistancePx: number
	readonly clearingDistancePx: number
	readonly badFrames: number
	readonly backlash: number
	readonly decMotionDetected: boolean
	readonly pendingPulse?: CalibrationPulseCommand
	readonly warnings: readonly string[]
	readonly notes: readonly string[]
	readonly phaseHistory: readonly GuidingCalibrationPhase[]
	readonly raSamples: readonly GuidingCalibrationSample[]
	readonly decSamples: readonly GuidingCalibrationSample[]
	readonly clearingSamples: readonly GuidingCalibrationSample[]
}

export interface CalibrationStepResult {
	readonly phase: GuidingCalibrationPhase
	readonly pulse?: CalibrationPulseCommand
	readonly completed?: GuidingCalibrationResult
	readonly failure?: GuidingCalibrationFailure
	readonly diagnostics: GuidingCalibrationDiagnostics
}

interface GuidingCalibratorState {
	phase: GuidingCalibrationPhase
	startX: number
	startY: number
	lastX: number
	lastY: number
	currentX: number
	currentY: number
	decStartX: number
	decStartY: number
	raSteps: number
	decSteps: number
	raNoMotionSteps: number
	decNoMotionSteps: number
	clearingSteps: number
	plannedClearingSteps: number
	settleFramesRemaining: number
	pendingPulseAxis: 'ra' | 'dec' | null
	pendingPulseDirection: GuideDirectionRA | GuideDirectionDEC | null
	pendingPulseMs: number
	raSamples: GuidingCalibrationSample[]
	decSamples: GuidingCalibrationSample[]
	clearingSamples: GuidingCalibrationSample[]
	raSolution?: GuidingCalibrationAxisSolution
	decSolution?: GuidingCalibrationAxisSolution
	result?: GuidingCalibrationResult
	failure?: GuidingCalibrationFailure
	badFrames: number
	decMotionDetected: boolean
	decBacklashMs: number
	warnings: string[]
	phaseHistory: GuidingCalibrationPhase[]
	lastDiagnostics: GuidingCalibrationDiagnostics
}

interface GuidingCalibrationConfigIssue {
	readonly key: string
	readonly reason: string
}

const NO_PULSE: AxisPulse = { direction: null, duration: 0 }

export const DEFAULT_GUIDING_CALIBRATOR_CONFIG: Readonly<GuidingCalibrationConfig> = {
	raPulse: 650,
	decPulse: 650,
	raDirection: 'west',
	decDirection: 'north',
	maxRaSteps: 20,
	maxDecSteps: 20,
	maxRaNoMotionSteps: 4,
	maxDecNoMotionSteps: 8,
	minMovePerStepPx: 0.15,
	minNetRaTravelPx: 12,
	minNetDecTravelPx: 10,
	maxFrameJumpPx: 8,
	maxBadFrames: 3,
	settleFramesAfterMove: 0,
	clearingMoveEnabled: true,
	clearingMoveFraction: 1,
	maxClearingSteps: 20,
	maxClearingOffsetPx: 4,
	minAxisSeparation: (12 * Math.PI) / 180,
	minDeterminant: 1e-6,
	maxMatchDistancePx: 8,
	edgeMarginPx: 12,
	minFrameQuality: 0.2,
	minRatePxPerMs: 1e-4,
	maxRatePxPerMs: 2,
	filter: DEFAULT_GUIDER_CONFIG.filter,
}

const EMPTY_DIAGNOSTICS: Readonly<GuidingCalibrationDiagnostics> = {
	phase: 'idle',
	totalStars: 0,
	acceptedStars: 0,
	qualityScore: 0,
	rejectedReasons: {},
	raSteps: 0,
	decSteps: 0,
	clearingSteps: 0,
	raNetDistancePx: 0,
	decNetDistancePx: 0,
	clearingDistancePx: 0,
	badFrames: 0,
	backlash: 0,
	decMotionDetected: false,
	warnings: [],
	notes: [],
	phaseHistory: ['idle'],
	raSamples: [],
	decSamples: [],
	clearingSamples: [],
}

const EMPTY_GUIDING_CALIBRATOR_STATE: Readonly<GuidingCalibratorState> = {
	phase: 'idle',
	startX: 0,
	startY: 0,
	lastX: 0,
	lastY: 0,
	currentX: 0,
	currentY: 0,
	decStartX: 0,
	decStartY: 0,
	raSteps: 0,
	decSteps: 0,
	raNoMotionSteps: 0,
	decNoMotionSteps: 0,
	clearingSteps: 0,
	plannedClearingSteps: 0,
	settleFramesRemaining: 0,
	pendingPulseAxis: null,
	pendingPulseDirection: null,
	pendingPulseMs: 0,
	raSamples: [],
	decSamples: [],
	clearingSamples: [],
	badFrames: 0,
	decMotionDetected: false,
	decBacklashMs: 0,
	warnings: [],
	phaseHistory: ['idle'],
	lastDiagnostics: EMPTY_DIAGNOSTICS,
}

// GuidingCalibrator drives a frame-by-frame RA/DEC calibration sequence.
export class GuidingCalibrator {
	readonly config: GuidingCalibrationConfig
	readonly state: GuidingCalibratorState

	constructor(config: Partial<GuidingCalibrationConfig> = {}) {
		this.config = {
			...DEFAULT_GUIDING_CALIBRATOR_CONFIG,
			...config,
			filter: {
				...DEFAULT_GUIDING_CALIBRATOR_CONFIG.filter,
				...(config.filter ?? {}),
			},
		}

		const issues = validateGuidingCalibratorConfig(this.config)

		if (issues.length > 0) {
			const message = issues.map((issue) => `${issue.key}:${issue.reason}`).join(', ')
			throw new Error(`invalid guiding calibrator config: ${message}`)
		}

		this.state = structuredClone(EMPTY_GUIDING_CALIBRATOR_STATE)
	}

	// Processes one post-pulse frame and advances the calibration state machine.
	processFrame(frame: GuideFrame) {
		if (this.state.phase === 'idle') {
			this.reset()
			this.transitionTo('precheck')
			const acquired = this.acquireInitialStar(frame)
			if (acquired.failure !== undefined) return acquired
			return this.queuePulse('raForwardPulse', 'ra', this.config.raDirection, this.config.raPulse, frame, ['calibration_started'])
		}

		if (this.state.phase === 'completed' || this.state.phase === 'failed') {
			return this.makeStepResult(undefined, frame, ['terminal_state'])
		}

		if (this.state.pendingPulseAxis === null) {
			return this.fail('bad_frame', 'no pending calibration pulse to measure', frame, ['missing_pending_pulse'])
		}

		if (this.state.settleFramesRemaining > 0) {
			this.state.settleFramesRemaining--
			return this.makeStepResult(undefined, frame, ['settling'])
		}

		const tracked = this.trackStar(frame)
		if (tracked.failure !== undefined) return tracked.failure

		const { point, filtered } = tracked

		switch (this.state.phase) {
			case 'raForwardPulse':
				return this.handleRaForwardMeasurement(frame, point, filtered)
			case 'raClearPulse':
				return this.handleRaClearMeasurement(frame, point, filtered)
			case 'decForwardPulse':
			case 'decBacklashClearing':
				return this.handleDecMeasurement(frame, point, filtered)
			default:
				return this.fail('bad_frame', `unexpected calibration phase ${this.state.phase}`, frame, ['invalid_phase'], filtered)
		}
	}

	// Resets runtime state while preserving immutable configuration.
	reset() {
		Object.assign(this.state, structuredClone(EMPTY_GUIDING_CALIBRATOR_STATE))
	}

	// Returns a public snapshot of the mutable calibration state.
	get currentState() {
		return {
			phase: this.state.phase,
			startX: this.state.startX,
			startY: this.state.startY,
			currentX: this.state.currentX,
			currentY: this.state.currentY,
			decStartX: this.state.decStartX,
			decStartY: this.state.decStartY,
			raSteps: this.state.raSteps,
			decSteps: this.state.decSteps,
			raNoMotionSteps: this.state.raNoMotionSteps,
			decNoMotionSteps: this.state.decNoMotionSteps,
			clearingSteps: this.state.clearingSteps,
			plannedClearingSteps: this.state.plannedClearingSteps,
			decMotionDetected: this.state.decMotionDetected,
			backlash: this.state.decBacklashMs,
		}
	}

	// Returns diagnostics from the most recent calibration step.
	lastDiagnostics() {
		return this.state.lastDiagnostics
	}

	// Validates the initial frame and locks the starting guide star.
	private acquireInitialStar(frame: GuideFrame) {
		this.transitionTo('acquireLock')

		const filtered = filterGuideStars(frame, this.config.filter)

		if (filtered.accepted.length === 0 || filtered.qualityScore < this.config.minFrameQuality) {
			return this.fail('no_usable_star', 'no usable guide star available for calibration start', frame, ['precheck_failed'], filtered)
		}

		const guideStar = filtered.accepted[0]
		if (isNearEdge(guideStar, frame.width, frame.height, this.config.edgeMarginPx)) {
			return this.fail('star_near_edge', 'guide star is too close to the image edge for calibration', frame, ['start_edge'], filtered)
		}

		this.state.startX = guideStar.x
		this.state.startY = guideStar.y
		this.state.lastX = guideStar.x
		this.state.lastY = guideStar.y
		this.state.currentX = guideStar.x
		this.state.currentY = guideStar.y
		this.state.decStartX = guideStar.x
		this.state.decStartY = guideStar.y

		this.updateDiagnostics(frame, filtered, ['lock_acquired'])

		return this.makeStepResult(undefined, frame, ['lock_acquired'], filtered)
	}

	// Tracks the current guide star and rejects invalid measurement frames.
	private trackStar(frame: GuideFrame) {
		const filtered = filterGuideStars(frame, this.config.filter)

		if (filtered.accepted.length === 0 || filtered.qualityScore < this.config.minFrameQuality) {
			this.state.badFrames++

			if (this.state.badFrames > this.config.maxBadFrames) {
				return { failure: this.fail('bad_frame', 'too many unusable frames during calibration', frame, ['bad_frame_limit'], filtered) } as const
			}

			return { failure: this.makeStepResult(undefined, frame, ['bad_frame'], filtered) } as const
		}

		const tracked = pickNearestCalibrationStar(filtered.accepted, this.state.lastX, this.state.lastY, this.config.maxMatchDistancePx)

		if (tracked === undefined) {
			return { failure: this.fail('star_lost', 'guide star could not be matched in the calibration frame', frame, ['star_lost'], filtered) } as const
		}

		if (isNearEdge(tracked, frame.width, frame.height, this.config.edgeMarginPx)) {
			return { failure: this.fail('star_near_edge', 'guide star moved too close to the image edge during calibration', frame, ['edge_abort'], filtered) } as const
		}

		const jumpX = tracked.x - this.state.lastX
		const jumpY = tracked.y - this.state.lastY
		const jumpDistance = Math.hypot(jumpX, jumpY)

		if (jumpDistance > this.config.maxFrameJumpPx) {
			return { failure: this.fail('impossible_jump', 'measured star displacement exceeded the allowed frame jump threshold', frame, ['jump_rejected'], filtered) } as const
		}

		this.state.badFrames = 0

		return { point: { x: tracked.x, y: tracked.y }, filtered } as const
	}

	// Records one RA-forward sample and either continues pulsing or advances to clearing.
	private handleRaForwardMeasurement(frame: GuideFrame, point: Point, filtered: ReturnType<typeof filterGuideStars>) {
		this.transitionTo('raForwardMeasure')
		const sample = this.recordSample(this.state.raSteps + 1, this.config.raPulse, this.config.raDirection, point, this.state.startX, this.state.startY)
		this.state.raSteps++
		this.state.raSamples.push(sample)
		this.finishMeasurement(point)

		if (sample.stepDistance < this.config.minMovePerStepPx) {
			this.state.raNoMotionSteps++

			if (this.state.raNoMotionSteps > this.config.maxRaNoMotionSteps) {
				return this.fail('too_many_ra_no_motion_steps', 'RA calibration pulses did not produce measurable motion', frame, ['ra_no_motion'], filtered)
			}
		}

		this.updateDiagnostics(frame, filtered, ['ra_measured'])

		if (sample.netDistance >= this.config.minNetRaTravelPx) {
			this.state.raSolution = solveAxisFromSamples(this.state.raSamples)

			if (!isAxisRateValid(this.state.raSolution, this.config.minRatePxPerMs, this.config.maxRatePxPerMs)) {
				return this.fail('axis_rate_invalid', 'RA calibration rate is outside the accepted range', frame, ['ra_rate_invalid'], filtered)
			}

			if (this.state.raSolution.negativeProjectionCount > Math.max(1, Math.floor(this.state.raSamples.length / 3))) {
				return this.fail('axis_direction_inconsistent', 'RA calibration samples contain too many reverse projections', frame, ['ra_projection_inconsistent'], filtered)
			}

			this.transitionTo('raForwardComplete')

			if (!this.config.clearingMoveEnabled) {
				this.startDecPhase(point)
				return this.queuePulse('decForwardPulse', 'dec', this.config.decDirection, this.config.decPulse, frame, ['dec_started'], filtered)
			}

			this.state.plannedClearingSteps = Math.trunc(clamp(Math.round(this.state.raSteps * this.config.clearingMoveFraction), 1, this.config.maxClearingSteps))
			return this.queuePulse('raClearPulse', 'ra', oppositeRA(this.config.raDirection), this.config.raPulse, frame, ['ra_clearing_started'], filtered)
		}

		if (this.state.raSteps >= this.config.maxRaSteps) {
			return this.fail('insufficient_ra_movement', 'RA calibration did not reach the required net travel before the step limit', frame, ['ra_travel_short'], filtered)
		}

		return this.queuePulse('raForwardPulse', 'ra', this.config.raDirection, this.config.raPulse, frame, ['ra_continue'], filtered)
	}

	// Records one RA clearing sample and either continues reversing or starts DEC.
	private handleRaClearMeasurement(frame: GuideFrame, point: Point, filtered: ReturnType<typeof filterGuideStars>) {
		this.transitionTo('raClearMeasure')

		const sample = this.recordSample(this.state.clearingSteps + 1, this.config.raPulse, oppositeRA(this.config.raDirection), point, this.state.startX, this.state.startY)

		this.state.clearingSteps++
		this.state.clearingSamples.push(sample)
		this.finishMeasurement(point)
		this.updateDiagnostics(frame, filtered, ['ra_clearing_measured'])

		if (sample.netDistance <= this.config.maxClearingOffsetPx) {
			this.startDecPhase(point)
			return this.queuePulse('decForwardPulse', 'dec', this.config.decDirection, this.config.decPulse, frame, ['dec_started'], filtered)
		}

		if (this.state.clearingSteps >= this.state.plannedClearingSteps || this.state.clearingSteps >= this.config.maxClearingSteps) {
			return this.fail('ra_clearing_failed', 'RA clearing pulses did not return the guide star close enough to the calibration origin', frame, ['ra_clearing_failed'], filtered)
		}

		return this.queuePulse('raClearPulse', 'ra', oppositeRA(this.config.raDirection), this.config.raPulse, frame, ['ra_clearing_continue'], filtered)
	}

	// Records one DEC sample, applies backlash tolerance, and either continues or solves calibration.
	private handleDecMeasurement(frame: GuideFrame, point: Point, filtered: ReturnType<typeof filterGuideStars>) {
		const sample = this.recordDecSample(this.state.decSteps + 1, point)
		this.state.decSteps++
		this.finishMeasurement(point)

		if (!this.state.decMotionDetected && sample.projectedDistance < this.config.minMovePerStepPx && Math.abs(sample.orthogonalDistance) < this.config.minMovePerStepPx) {
			this.state.decNoMotionSteps++
			this.state.decBacklashMs = this.state.decSteps * this.config.decPulse
			this.transitionTo('decBacklashClearing')
			this.updateDiagnostics(frame, filtered, ['dec_backlash'])

			if (this.state.decNoMotionSteps > this.config.maxDecNoMotionSteps) {
				return this.fail('too_many_dec_no_motion_steps', 'DEC calibration never showed measurable motion before backlash tolerance was exhausted', frame, ['dec_no_motion'], filtered)
			}

			if (this.state.decSteps >= this.config.maxDecSteps) {
				return this.fail('insufficient_dec_movement', 'DEC calibration did not begin moving before the step limit', frame, ['dec_travel_short'], filtered)
			}

			return this.queuePulse('decBacklashClearing', 'dec', this.config.decDirection, this.config.decPulse, frame, ['dec_backlash_continue'], filtered)
		}

		if (!this.state.decMotionDetected) {
			this.state.decMotionDetected = true
			this.state.decBacklashMs = (this.state.decSteps - 1) * this.config.decPulse
		}

		this.transitionTo('decForwardMeasure')
		this.state.decSamples.push(sample)
		this.updateDiagnostics(frame, filtered, ['dec_measured'])

		const decTravel = computeDecTravel(this.state.decSamples)
		if (decTravel >= this.config.minNetDecTravelPx) {
			this.state.decSolution = solveAxisFromSamples(this.state.decSamples)

			if (!isAxisRateValid(this.state.decSolution, this.config.minRatePxPerMs, this.config.maxRatePxPerMs)) {
				return this.fail('axis_rate_invalid', 'DEC calibration rate is outside the accepted range', frame, ['dec_rate_invalid'], filtered)
			}

			if (this.state.decSolution.negativeProjectionCount > Math.max(1, Math.floor(this.state.decSamples.length / 3))) {
				return this.fail('axis_direction_inconsistent', 'DEC calibration samples contain too many reverse projections', frame, ['dec_projection_inconsistent'], filtered)
			}

			this.transitionTo('decForwardComplete')

			return this.solveAndValidate(frame, filtered)
		}

		if (this.state.decSteps >= this.config.maxDecSteps) {
			return this.fail('insufficient_dec_movement', 'DEC calibration did not reach the required net travel before the step limit', frame, ['dec_travel_short'], filtered)
		}

		return this.queuePulse('decForwardPulse', 'dec', this.config.decDirection, this.config.decPulse, frame, ['dec_continue'], filtered)
	}

	// Solves the 2x2 calibration matrices and validates the final geometry.
	private solveAndValidate(frame: GuideFrame, filtered: ReturnType<typeof filterGuideStars>) {
		this.transitionTo('solving')

		const { raSolution, decSolution } = this.state

		if (raSolution === undefined || decSolution === undefined) {
			return this.fail('matrix_singular', 'calibration solve requires both RA and DEC axis solutions', frame, ['solve_missing_axis'], filtered)
		}

		const dot = clamp(raSolution.unitX * decSolution.unitX + raSolution.unitY * decSolution.unitY, -1, 1)
		const separation = Math.acos(Math.abs(dot))
		if (separation < this.config.minAxisSeparation) {
			return this.fail('axes_too_parallel', 'RA and DEC calibration vectors are too close to parallel', frame, ['axes_parallel'], filtered)
		}

		const m00 = raSolution.unitX * raSolution.ratePxPerMs
		const m10 = raSolution.unitY * raSolution.ratePxPerMs
		const m01 = decSolution.unitX * decSolution.ratePxPerMs
		const m11 = decSolution.unitY * decSolution.ratePxPerMs
		const determinant = m00 * m11 - m01 * m10

		if (!Number.isFinite(determinant) || Math.abs(determinant) <= this.config.minDeterminant) {
			return this.fail('matrix_singular', 'calibration image-motion matrix is singular or ill-conditioned', frame, ['matrix_singular'], filtered)
		}

		this.transitionTo('validating')

		const warnings = this.state.warnings.slice()
		if (this.state.clearingSteps > 0 && Math.hypot(this.state.currentX - this.state.startX, this.state.currentY - this.state.startY) > this.config.maxClearingOffsetPx * 0.6) {
			warnings.push('ra_clearing_finished_near_threshold')
		}

		this.state.result = {
			ra: { ...raSolution, direction: this.config.raDirection },
			dec: { ...decSolution, direction: this.config.decDirection },
			imageMotion: [m00, m01, m10, m11],
			imageToAxis: [m11 / determinant, -m01 / determinant, -m10 / determinant, m00 / determinant],
			determinant,
			backlash: this.state.decBacklashMs,
			startX: this.state.startX,
			startY: this.state.startY,
			decStartX: this.state.decStartX,
			decStartY: this.state.decStartY,
			clearingSteps: this.state.clearingSteps,
			warnings,
		}

		this.state.warnings = warnings.slice()
		this.transitionTo('completed')
		this.updateDiagnostics(frame, filtered, ['completed'])

		return this.makeStepResult(undefined, frame, ['completed'], filtered)
	}

	// Starts the DEC phase from the most recent post-clearing position.
	private startDecPhase(point: Point) {
		this.state.decStartX = point.x
		this.state.decStartY = point.y
		this.state.decSteps = 0
		this.state.decNoMotionSteps = 0
		this.state.decMotionDetected = false
		this.state.decBacklashMs = 0
	}

	// Finalizes one measured frame by clearing the pending pulse and updating the track point.
	private finishMeasurement(point: Point) {
		this.state.currentX = point.x
		this.state.currentY = point.y
		this.state.lastX = point.x
		this.state.lastY = point.y
		this.state.pendingPulseAxis = null
		this.state.pendingPulseDirection = null
		this.state.pendingPulseMs = 0
	}

	// Records one generic calibration sample against the provided origin.
	private recordSample(step: number, pulse: number, pulseDirection: GuideDirectionRA | GuideDirectionDEC, point: Point, originX: number, originY: number): GuidingCalibrationSample {
		const deltaX = point.x - this.state.lastX
		const deltaY = point.y - this.state.lastY
		const netX = point.x - originX
		const netY = point.y - originY
		return { step, pulse, pulseDirection, x: point.x, y: point.y, deltaX, deltaY, netX, netY, stepDistance: Math.hypot(deltaX, deltaY), netDistance: Math.hypot(netX, netY), projectedDistance: Math.hypot(deltaX, deltaY), orthogonalDistance: 0 }
	}

	// Records one DEC sample projected onto the RA-orthogonal seed direction.
	private recordDecSample(step: number, point: Point): GuidingCalibrationSample {
		const deltaX = point.x - this.state.lastX
		const deltaY = point.y - this.state.lastY
		const netX = point.x - this.state.decStartX
		const netY = point.y - this.state.decStartY
		const raUnit = this.state.raSolution ?? solveAxisFromSamples(this.state.raSamples)
		const seedX = -raUnit.unitY
		const seedY = raUnit.unitX
		const { decPulse, decDirection } = this.config

		return {
			step,
			pulse: decPulse,
			pulseDirection: decDirection,
			x: point.x,
			y: point.y,
			deltaX,
			deltaY,
			netX,
			netY,
			stepDistance: Math.hypot(deltaX, deltaY),
			netDistance: Math.hypot(netX, netY),
			projectedDistance: Math.abs(dot2(deltaX, deltaY, seedX, seedY)),
			orthogonalDistance: dot2(netX, netY, seedX, seedY),
		}
	}

	// Queues the next pulse and returns the step result the caller should execute.
	private queuePulse(phase: GuidingCalibrationPhase, axis: 'ra' | 'dec', direction: GuideDirectionRA | GuideDirectionDEC, duration: number, frame: GuideFrame, notes: readonly string[], filtered = filterGuideStars(frame, this.config.filter)) {
		this.transitionTo(phase)
		this.state.pendingPulseAxis = axis
		this.state.pendingPulseDirection = direction
		this.state.pendingPulseMs = duration
		this.state.settleFramesRemaining = this.config.settleFramesAfterMove
		const pulse: CalibrationPulseCommand = axis === 'ra' ? { ra: { direction, duration }, dec: NO_PULSE } : { ra: NO_PULSE, dec: { direction, duration } }
		this.updateDiagnostics(frame, filtered, notes, pulse)
		return this.makeStepResult(pulse, frame, notes, filtered)
	}

	// Fails calibration with a structured reason and snapshot diagnostics.
	private fail(code: GuidingCalibrationFailureCode, message: string, frame: GuideFrame, notes: readonly string[], filtered = filterGuideStars(frame, this.config.filter)) {
		this.state.failure = { code, phase: this.state.phase, message, frameId: frame.frameId }
		this.transitionTo('failed')
		this.updateDiagnostics(frame, filtered, notes)
		return this.makeStepResult(undefined, frame, notes, filtered)
	}

	// Updates the mutable diagnostics snapshot used by tests and callers.
	private updateDiagnostics(frame: GuideFrame, filtered: ReturnType<typeof filterGuideStars>, notes: readonly string[], pendingPulse?: CalibrationPulseCommand) {
		const raNet = this.state.raSamples.length > 0 ? this.state.raSamples[this.state.raSamples.length - 1].netDistance : 0
		const decNet = computeDecTravel(this.state.decSamples)
		const clearingDistance = Math.hypot(this.state.currentX - this.state.startX, this.state.currentY - this.state.startY)
		this.state.lastDiagnostics = {
			phase: this.state.phase,
			frameId: frame.frameId,
			totalStars: frame.stars.length,
			acceptedStars: filtered.accepted.length,
			qualityScore: filtered.qualityScore,
			rejectedReasons: filtered.rejectedReasons,
			startX: this.state.phase === 'idle' ? undefined : this.state.startX,
			startY: this.state.phase === 'idle' ? undefined : this.state.startY,
			currentX: this.state.phase === 'idle' ? undefined : this.state.currentX,
			currentY: this.state.phase === 'idle' ? undefined : this.state.currentY,
			decStartX: hasDecOrigin(this.state.phase, this.state.decSteps) ? this.state.decStartX : undefined,
			decStartY: hasDecOrigin(this.state.phase, this.state.decSteps) ? this.state.decStartY : undefined,
			raSteps: this.state.raSteps,
			decSteps: this.state.decSteps,
			clearingSteps: this.state.clearingSteps,
			raNetDistancePx: raNet,
			decNetDistancePx: decNet,
			clearingDistancePx: clearingDistance,
			badFrames: this.state.badFrames,
			backlash: this.state.decBacklashMs,
			decMotionDetected: this.state.decMotionDetected,
			pendingPulse,
			warnings: this.state.warnings.slice(),
			notes,
			phaseHistory: this.state.phaseHistory.slice(),
			raSamples: this.state.raSamples.slice(),
			decSamples: this.state.decSamples.slice(),
			clearingSamples: this.state.clearingSamples.slice(),
		}
	}

	// Converts internal state into the public step result payload.
	private makeStepResult(pulse: CalibrationPulseCommand | undefined, frame: GuideFrame, notes: readonly string[], filtered = filterGuideStars(frame, this.config.filter)): CalibrationStepResult {
		if (this.state.lastDiagnostics.phase !== this.state.phase || this.state.lastDiagnostics.frameId !== frame.frameId) {
			this.updateDiagnostics(frame, filtered, notes, pulse)
		}

		return { phase: this.state.phase, pulse, completed: this.state.result, failure: this.state.failure, diagnostics: this.state.lastDiagnostics }
	}

	// Appends a phase transition while avoiding duplicate adjacent entries.
	private transitionTo(phase: GuidingCalibrationPhase) {
		this.state.phase = phase

		if (this.state.phaseHistory[this.state.phaseHistory.length - 1] !== phase) {
			this.state.phaseHistory.push(phase)
		}
	}
}

// Validates calibrator configuration values before runtime use.
function validateGuidingCalibratorConfig(config: GuidingCalibrationConfig) {
	const issues: GuidingCalibrationConfigIssue[] = []
	if (config.raPulse <= 0) issues.push({ key: 'raPulseMs', reason: 'must be > 0' })
	if (config.decPulse <= 0) issues.push({ key: 'decPulseMs', reason: 'must be > 0' })
	if (config.maxRaSteps <= 0) issues.push({ key: 'maxRaSteps', reason: 'must be > 0' })
	if (config.maxDecSteps <= 0) issues.push({ key: 'maxDecSteps', reason: 'must be > 0' })
	if (config.maxRaNoMotionSteps < 0) issues.push({ key: 'maxRaNoMotionSteps', reason: 'must be >= 0' })
	if (config.maxDecNoMotionSteps < 0) issues.push({ key: 'maxDecNoMotionSteps', reason: 'must be >= 0' })
	if (config.minMovePerStepPx <= 0) issues.push({ key: 'minMovePerStepPx', reason: 'must be > 0' })
	if (config.minNetRaTravelPx <= 0) issues.push({ key: 'minNetRaTravelPx', reason: 'must be > 0' })
	if (config.minNetDecTravelPx <= 0) issues.push({ key: 'minNetDecTravelPx', reason: 'must be > 0' })
	if (config.maxFrameJumpPx <= 0) issues.push({ key: 'maxFrameJumpPx', reason: 'must be > 0' })
	if (config.maxBadFrames < 0) issues.push({ key: 'maxBadFrames', reason: 'must be >= 0' })
	if (config.settleFramesAfterMove < 0) issues.push({ key: 'settleFramesAfterMove', reason: 'must be >= 0' })
	if (config.clearingMoveFraction <= 0) issues.push({ key: 'clearingMoveFraction', reason: 'must be > 0' })
	if (config.maxClearingSteps <= 0) issues.push({ key: 'maxClearingSteps', reason: 'must be > 0' })
	if (config.maxClearingOffsetPx < 0) issues.push({ key: 'maxClearingOffsetPx', reason: 'must be >= 0' })
	if (config.minAxisSeparation <= 0 || config.minAxisSeparation >= Math.PI / 2) issues.push({ key: 'minAxisSeparation', reason: 'must be within (0, pi/2)' })
	if (config.minDeterminant <= 0) issues.push({ key: 'minDeterminant', reason: 'must be > 0' })
	if (config.maxMatchDistancePx <= 0) issues.push({ key: 'maxMatchDistancePx', reason: 'must be > 0' })
	if (config.edgeMarginPx < 0) issues.push({ key: 'edgeMarginPx', reason: 'must be >= 0' })
	if (config.minFrameQuality < 0 || config.minFrameQuality > 1) issues.push({ key: 'minFrameQuality', reason: 'must be within [0, 1]' })
	if (config.minRatePxPerMs <= 0) issues.push({ key: 'minRatePxPerMs', reason: 'must be > 0' })
	if (config.maxRatePxPerMs <= config.minRatePxPerMs) issues.push({ key: 'maxRatePxPerMs', reason: 'must be > minRatePxPerMs' })
	return issues
}

// Solves one axis vector from measured pulse-to-pulse displacements.
function solveAxisFromSamples(samples: readonly GuidingCalibrationSample[]): GuidingCalibrationAxisSolution {
	let sumX = 0
	let sumY = 0
	let totalPulse = 0

	for (const sample of samples) {
		sumX += sample.deltaX
		sumY += sample.deltaY
		totalPulse += sample.pulse
	}

	const travel = Math.hypot(sumX, sumY)
	const unitX = sumX / travel
	const unitY = sumY / travel
	const perpX = -unitY
	const perpY = unitX
	let projectedTravel = 0
	let orthogonalSq = 0
	let negativeProjectionCount = 0

	for (const sample of samples) {
		const projection = dot2(sample.deltaX, sample.deltaY, unitX, unitY)
		if (projection < 0) negativeProjectionCount++
		projectedTravel += projection
		const orthogonal = dot2(sample.deltaX, sample.deltaY, perpX, perpY)
		orthogonalSq += orthogonal * orthogonal
	}

	return { unitX, unitY, ratePxPerMs: projectedTravel / totalPulse, totalTravelPx: projectedTravel, totalPulse, angle: Math.atan2(unitY, unitX), rmsOrthogonalResidualPx: Math.sqrt(orthogonalSq / samples.length), negativeProjectionCount }
}

// Validates that an axis solution is finite and within the configured rate bounds.
function isAxisRateValid(solution: GuidingCalibrationAxisSolution, minRatePxPerMs: number, maxRatePxPerMs: number) {
	return Number.isFinite(solution.unitX) && Number.isFinite(solution.unitY) && Number.isFinite(solution.ratePxPerMs) && solution.totalTravelPx > 0 && solution.ratePxPerMs >= minRatePxPerMs && solution.ratePxPerMs <= maxRatePxPerMs
}

// Computes accepted DEC travel from detected-motion samples only.
function computeDecTravel(samples: readonly GuidingCalibrationSample[]) {
	let sumX = 0
	let sumY = 0

	for (const sample of samples) {
		sumX += sample.deltaX
		sumY += sample.deltaY
	}

	return Math.hypot(sumX, sumY)
}

// Picks the nearest star within the configured match radius.
function pickNearestCalibrationStar(stars: readonly GuideStar[], targetX: number, targetY: number, maxDistancePx: number) {
	const maxDistanceSq = maxDistancePx * maxDistancePx
	let best: GuideStar | undefined
	let bestDistanceSq = Infinity

	for (const star of stars) {
		const dx = star.x - targetX
		const dy = star.y - targetY
		const distanceSq = dx * dx + dy * dy

		if (distanceSq <= maxDistanceSq && distanceSq < bestDistanceSq) {
			best = star
			bestDistanceSq = distanceSq
		}
	}

	return best
}

// Tests whether the tracked star is too close to any image edge.
function isNearEdge(star: GuideStar | Point, width: number, height: number, margin: number) {
	return star.x < margin || star.y < margin || star.x >= width - margin || star.y >= height - margin
}

// Indicates whether the current state should expose the DEC origin in diagnostics.
function hasDecOrigin(phase: GuidingCalibrationPhase, decSteps: number) {
	return decSteps > 0 || phase === 'decForwardPulse' || phase === 'decBacklashClearing' || phase === 'decForwardMeasure' || phase === 'decForwardComplete' || phase === 'solving' || phase === 'validating' || phase === 'completed'
}

// Computes a 2D dot product.
function dot2(ax: number, ay: number, bx: number, by: number) {
	return ax * bx + ay * by
}
