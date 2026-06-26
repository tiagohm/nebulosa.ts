import { PIOVERTWO } from '../../core/constants'
import type { PierSide } from '../../devices/indi/device'
import { type Angle, normalizeAngle, normalizePI } from '../../math/units/angle'

// Logical Meridian Flip lifecycle phase, including the non-persisted disabled decision phase.
export type MeridianFlipPhase = 'DISABLED' | 'WAITING' | 'PREPARING' | 'READY' | 'FLIPPING' | 'VERIFYING_PIER_SIDE' | 'RECENTERING' | 'SETTLING' | 'COMPLETED' | 'FAILED'

// Persisted lifecycle phase. DISABLED is decision-only and is never stored.
export type MeridianFlipStatePhase = Exclude<MeridianFlipPhase, 'DISABLED'>

// Device-independent application action recommended by the decision engine.
export type MeridianFlipAction = 'NONE' | 'PREPARE' | 'WAIT_FOR_EXPOSURE' | 'ABORT_EXPOSURE' | 'PAUSE_GUIDING' | 'START_FLIP' | 'VERIFY_PIER_SIDE' | 'RECENTER' | 'RESUME_GUIDING' | 'COMPLETE' | 'FAIL'

// Deterministic explanation for a decision or persisted failure state.
export type MeridianFlipReason =
	| 'DISABLED'
	| 'BEFORE_PREPARE_WINDOW'
	| 'PREPARE_WINDOW_REACHED'
	| 'FLIP_THRESHOLD_REACHED'
	| 'LATEST_THRESHOLD_REACHED'
	| 'WAITING_FOR_EXPOSURE'
	| 'ALREADY_ON_POST_FLIP_SIDE'
	| 'PIER_SIDE_NOT_CONFIGURED'
	| 'PIER_SIDE_NEITHER'
	| 'PIER_SIDE_MISMATCH'
	| 'FLIP_IN_PROGRESS'
	| 'VERIFYING_PIER_SIDE'
	| 'RECENTER_REQUIRED'
	| 'GUIDING_SETTLE_REQUIRED'
	| 'FLIP_COMPLETED'
	| 'RETRY_AVAILABLE'
	| 'RETRY_LIMIT_REACHED'
	| 'EXECUTION_FAILED'
	| 'INVALID_CONFIGURATION'
	| 'INVALID_TRANSITION'

// Target coordinate for one logical Meridian Flip cycle.
export interface MeridianFlipTarget {
	// Apparent right ascension compatible with local sidereal time, in radians.
	rightAscension: Angle
}

// Runtime policy for pure Meridian Flip decisions.
export interface MeridianFlipPolicy {
	// Enables automatic Meridian Flip decisions.
	enabled: boolean

	// Hour angle where pre-flip preparation may begin, in radians.
	prepareAt: Angle

	// Hour angle where the mount may begin the flip, in radians.
	flipAt: Angle

	// Latest safe hour angle for initiating the flip, in radians.
	latestAt: Angle

	// Expected mount side before the flip after application-level driver mapping.
	beforeFlipPierSide?: PierSide

	// Expected mount side after the flip after application-level driver mapping.
	afterFlipPierSide?: PierSide

	// Allows lifecycle progress when required pier-side telemetry is unavailable.
	allowUnknownPierSide?: boolean

	// Maximum retry attempts after the initial started flip has failed.
	maxRetries?: number

	// Requires a recentering phase after pier-side verification.
	requireRecentering?: boolean

	// Requires guiding resume and settle confirmation after recentering.
	requireGuidingSettle?: boolean
}

// Current application telemetry snapshot used for one deterministic evaluation.
export interface MeridianFlipSnapshot {
	// Local apparent sidereal time, in radians.
	localSiderealTime: Angle

	// Target used for this logical flip cycle.
	target: MeridianFlipTarget

	// Current pier side reported by the mount adapter; omitted is treated as NEITHER.
	pierSide?: PierSide

	// Whether an exposure is currently active.
	isExposing?: boolean

	// Whether guiding is currently active.
	isGuiding?: boolean

	// Whether the mount is currently slewing.
	isSlewing?: boolean

	// Whether the mount has completed the commanded slew and is settled.
	isMountSettled?: boolean
}

// Persisted pure lifecycle state for one Meridian Flip cycle.
export interface MeridianFlipState {
	// Current persisted lifecycle phase.
	phase: MeridianFlipStatePhase

	// Total number of accepted FLIP_STARTED events in this cycle.
	attempts: number

	// Whether immediate pre-flip preparation, including applicable guiding pause, is complete.
	preparationCompleted: boolean

	// Failure diagnostic present only while phase is FAILED.
	failure?: MeridianFlipReason
}

// Complete decision returned by one pure evaluation.
export interface MeridianFlipDecision {
	// Recommended current phase.
	phase: MeridianFlipPhase

	// Next action for the application.
	action: MeridianFlipAction

	// Deterministic explanation for the action.
	reason: MeridianFlipReason

	// Current target hour angle normalized to (-PI, PI], in radians.
	hourAngle: Angle

	// Signed linear distance to the flip threshold, in radians.
	untilFlip: Angle

	// Signed linear distance to the latest threshold, in radians.
	untilLatest: Angle

	// Whether hourAngle is at or beyond latestAt.
	isOverdue: boolean

	// Whether configured post-flip pier-side telemetry currently matches.
	isAlreadyFlipped: boolean

	// State the caller should persist after this evaluation.
	state: MeridianFlipState
}

// External lifecycle event emitted by the application after it verifies an operation.
export type MeridianFlipEvent = { type: 'RESET' } | { type: 'PREPARED' } | { type: 'FLIP_STARTED' } | { type: 'FLIP_COMPLETED' } | { type: 'PIER_SIDE_CONFIRMED' } | { type: 'RECENTER_COMPLETED' } | { type: 'GUIDING_SETTLED' } | { type: 'FAILED'; reason?: MeridianFlipReason }

// Policy with defaults resolved without mutating the caller-provided policy object.
interface ResolvedMeridianFlipPolicy extends MeridianFlipPolicy {
	// Allows progress when pier-side telemetry is missing or NEITHER.
	allowUnknownPierSide: boolean

	// Maximum retry attempts after the initial accepted FLIP_STARTED event.
	maxRetries: number

	// Whether the post-verification lifecycle includes recentering.
	requireRecentering: boolean

	// Whether the post-verification lifecycle includes guiding settle.
	requireGuidingSettle: boolean
}

// Persisted phases accepted by lifecycle state validation.
const STATE_PHASES = new Set<MeridianFlipStatePhase>(['WAITING', 'PREPARING', 'READY', 'FLIPPING', 'VERIFYING_PIER_SIDE', 'RECENTERING', 'SETTLING', 'COMPLETED', 'FAILED'])

// Pier-side literals accepted from policy and runtime telemetry.
const PIER_SIDES = new Set<PierSide>(['EAST', 'WEST', 'NEITHER'])

// Failure and decision reasons accepted in persisted state and FAILED events.
const REASONS = new Set<MeridianFlipReason>([
	'DISABLED',
	'BEFORE_PREPARE_WINDOW',
	'PREPARE_WINDOW_REACHED',
	'FLIP_THRESHOLD_REACHED',
	'LATEST_THRESHOLD_REACHED',
	'WAITING_FOR_EXPOSURE',
	'ALREADY_ON_POST_FLIP_SIDE',
	'PIER_SIDE_NOT_CONFIGURED',
	'PIER_SIDE_NEITHER',
	'PIER_SIDE_MISMATCH',
	'FLIP_IN_PROGRESS',
	'VERIFYING_PIER_SIDE',
	'RECENTER_REQUIRED',
	'GUIDING_SETTLE_REQUIRED',
	'FLIP_COMPLETED',
	'RETRY_AVAILABLE',
	'RETRY_LIMIT_REACHED',
	'EXECUTION_FAILED',
	'INVALID_CONFIGURATION',
	'INVALID_TRANSITION',
])

// Event types accepted by the pure lifecycle transition function.
const EVENT_TYPES = new Set<MeridianFlipEvent['type']>(['RESET', 'PREPARED', 'FLIP_STARTED', 'FLIP_COMPLETED', 'PIER_SIDE_CONFIRMED', 'RECENTER_COMPLETED', 'GUIDING_SETTLED', 'FAILED'])

// Angular comparison tolerance for threshold boundaries after cyclic normalization.
const ANGULAR_THRESHOLD_EPSILON = 1e-14

// Normalizes Greenwich sidereal time plus east-positive longitude to [0, TAU).
export function computeLocalSiderealTime(greenwichSiderealTime: Angle, longitude: Angle): Angle {
	validateFiniteAngle(greenwichSiderealTime, 'greenwichSiderealTime')
	validateFiniteAngle(longitude, 'longitude')
	return normalizeAngle(greenwichSiderealTime + longitude)
}

// Computes signed local hour angle LAST - RA normalized to (-PI, PI].
export function computeHourAngle(localSiderealTime: Angle, rightAscension: Angle): Angle {
	validateFiniteAngle(localSiderealTime, 'localSiderealTime')
	validateFiniteAngle(rightAscension, 'rightAscension')
	return normalizePI(localSiderealTime - rightAscension)
}

// Creates the initial persisted lifecycle state for one Meridian Flip cycle.
export function createMeridianFlipState(): MeridianFlipState {
	return { phase: 'WAITING', attempts: 0, preparationCompleted: false }
}

// Evaluates the current policy, telemetry snapshot, and lifecycle state without side effects.
// Hour angle, normalized to (-PI, PI], is compared linearly against the thresholds, which are
// bounded to [-PI / 2, PI / 2]. The function assumes evaluation near the upper meridian: any
// hour angle past flipAt up to PI (toward lower culmination) is intentionally treated as
// "past the flip threshold", so callers must not feed snapshots far west of the meridian.
export function evaluateMeridianFlip(policy: MeridianFlipPolicy, snapshot: MeridianFlipSnapshot, state: MeridianFlipState = createMeridianFlipState()): MeridianFlipDecision {
	const resolved = resolvePolicy(policy)
	validateSnapshot(snapshot)
	validateState(state)

	const hourAngle = computeHourAngle(snapshot.localSiderealTime, snapshot.target.rightAscension)
	const untilFlip = resolved.flipAt - hourAngle
	const untilLatest = resolved.latestAt - hourAngle
	const isOverdue = isAtOrAfterThreshold(hourAngle, resolved.latestAt)
	const isAlreadyFlipped = resolved.afterFlipPierSide !== undefined && snapshot.pierSide === resolved.afterFlipPierSide

	if (!resolved.enabled) return decision('DISABLED', 'NONE', 'DISABLED', hourAngle, untilFlip, untilLatest, isOverdue, isAlreadyFlipped, state)

	if (isPreFlipPhase(state.phase) && isAlreadyFlipped) {
		return decision('COMPLETED', 'COMPLETE', 'ALREADY_ON_POST_FLIP_SIDE', hourAngle, untilFlip, untilLatest, isOverdue, isAlreadyFlipped, updateState(state, 'COMPLETED', state.attempts, state.preparationCompleted))
	}

	if (state.phase === 'COMPLETED') return decision('COMPLETED', 'COMPLETE', 'FLIP_COMPLETED', hourAngle, untilFlip, untilLatest, isOverdue, isAlreadyFlipped, state)
	if (state.phase === 'FAILED') return evaluateFailedState(resolved, snapshot, state, hourAngle, untilFlip, untilLatest, isOverdue, isAlreadyFlipped)

	if (isPreFlipPhase(state.phase)) {
		const pierSideFailure = evaluatePreFlipPierSide(resolved, snapshot, state, hourAngle, untilFlip, untilLatest, isOverdue, isAlreadyFlipped)
		if (pierSideFailure) return pierSideFailure
		return evaluatePreFlipThresholds(resolved, snapshot, state, hourAngle, untilFlip, untilLatest, isOverdue, isAlreadyFlipped)
	}

	if (state.phase === 'FLIPPING') return decision('FLIPPING', 'NONE', 'FLIP_IN_PROGRESS', hourAngle, untilFlip, untilLatest, isOverdue, isAlreadyFlipped, state)
	if (state.phase === 'VERIFYING_PIER_SIDE') return evaluatePostFlipPierSide(resolved, snapshot, state, hourAngle, untilFlip, untilLatest, isOverdue, isAlreadyFlipped)
	if (state.phase === 'RECENTERING') return decision('RECENTERING', 'RECENTER', 'RECENTER_REQUIRED', hourAngle, untilFlip, untilLatest, isOverdue, isAlreadyFlipped, state)

	return decision('SETTLING', 'RESUME_GUIDING', 'GUIDING_SETTLE_REQUIRED', hourAngle, untilFlip, untilLatest, isOverdue, isAlreadyFlipped, state)
}

// Applies a verified external lifecycle event and returns the next persisted state.
export function transitionMeridianFlip(policy: MeridianFlipPolicy, state: MeridianFlipState, event: MeridianFlipEvent): MeridianFlipState {
	const resolved = resolvePolicy(policy)
	validateState(state)
	validateEvent(event)

	if (event.type === 'RESET') return updateState(state, 'WAITING', 0, false)

	// PREPARED confirms the guiding pause requested by the READY-phase PAUSE_GUIDING action,
	// not the advisory PREPARE action emitted during PREPARING; it is only valid once READY.
	if (event.type === 'PREPARED') {
		if (state.phase !== 'READY') throwInvalidTransition()
		return updateState(state, 'READY', state.attempts, true)
	}

	if (event.type === 'FLIP_STARTED') {
		if (state.phase === 'READY' && state.preparationCompleted) return updateState(state, 'FLIPPING', state.attempts + 1, true)
		if (state.phase === 'FAILED' && state.attempts >= 1 && state.attempts <= resolved.maxRetries) return updateState(state, 'FLIPPING', state.attempts + 1, true)
		throwInvalidTransition()
	}

	if (event.type === 'FLIP_COMPLETED') {
		if (state.phase !== 'FLIPPING') throwInvalidTransition()
		return updateState(state, 'VERIFYING_PIER_SIDE', state.attempts, state.preparationCompleted)
	}

	if (event.type === 'PIER_SIDE_CONFIRMED') {
		if (state.phase !== 'VERIFYING_PIER_SIDE') throwInvalidTransition()
		return updateState(state, phaseAfterPierSideConfirmed(resolved), state.attempts, state.preparationCompleted)
	}

	if (event.type === 'RECENTER_COMPLETED') {
		if (state.phase !== 'RECENTERING') throwInvalidTransition()
		return updateState(state, resolved.requireGuidingSettle ? 'SETTLING' : 'COMPLETED', state.attempts, state.preparationCompleted)
	}

	if (event.type === 'GUIDING_SETTLED') {
		if (state.phase !== 'SETTLING') throwInvalidTransition()
		return updateState(state, 'COMPLETED', state.attempts, state.preparationCompleted)
	}

	if (!isNonTerminalPhase(state.phase)) throwInvalidTransition()
	return updateState(state, 'FAILED', state.attempts, state.preparationCompleted, event.reason ?? 'EXECUTION_FAILED')
}

// Resolves policy defaults after validating the public configuration.
function resolvePolicy(policy: MeridianFlipPolicy): ResolvedMeridianFlipPolicy {
	validateThreshold(policy.prepareAt, 'prepareAt')
	validateThreshold(policy.flipAt, 'flipAt')
	validateThreshold(policy.latestAt, 'latestAt')
	validateConfiguredPierSide(policy.beforeFlipPierSide, 'beforeFlipPierSide')
	validateConfiguredPierSide(policy.afterFlipPierSide, 'afterFlipPierSide')

	if (policy.prepareAt > policy.flipAt) throw new RangeError('prepareAt must be less than or equal to flipAt')
	if (policy.flipAt > policy.latestAt) throw new RangeError('flipAt must be less than or equal to latestAt')
	if (policy.beforeFlipPierSide !== undefined && policy.afterFlipPierSide !== undefined && policy.beforeFlipPierSide === policy.afterFlipPierSide) throw new RangeError('beforeFlipPierSide and afterFlipPierSide must differ')
	if (policy.maxRetries !== undefined && (!Number.isFinite(policy.maxRetries) || !Number.isInteger(policy.maxRetries) || !Number.isSafeInteger(policy.maxRetries) || policy.maxRetries < 0)) throw new RangeError('maxRetries must be a non-negative safe integer')

	return {
		...policy,
		allowUnknownPierSide: policy.allowUnknownPierSide ?? false,
		maxRetries: policy.maxRetries ?? 0,
		requireRecentering: policy.requireRecentering ?? true,
		requireGuidingSettle: policy.requireGuidingSettle ?? true,
	}
}

// Validates one operational-window threshold angle in radians.
function validateThreshold(value: Angle, name: string) {
	validateFiniteAngle(value, name)
	if (value < -PIOVERTWO || value > PIOVERTWO) throw new RangeError(`${name} must be within [-PI / 2, PI / 2]`)
}

// Validates one finite angular runtime value in radians.
function validateFiniteAngle(value: Angle, name: string) {
	if (!Number.isFinite(value)) throw new RangeError(`${name} must be finite`)
}

// Validates configured pier sides, rejecting NEITHER as a policy expectation.
function validateConfiguredPierSide(pierSide: PierSide | undefined, name: string) {
	if (pierSide === undefined) return
	if (!PIER_SIDES.has(pierSide)) throw new RangeError(`${name} must be EAST, WEST, or NEITHER`)
	if (pierSide === 'NEITHER') throw new RangeError(`${name} cannot be NEITHER`)
}

// Validates one runtime telemetry snapshot.
function validateSnapshot(snapshot: MeridianFlipSnapshot) {
	validateFiniteAngle(snapshot.localSiderealTime, 'localSiderealTime')
	validateFiniteAngle(snapshot.target.rightAscension, 'target.rightAscension')
	if (snapshot.pierSide !== undefined && !PIER_SIDES.has(snapshot.pierSide)) throw new RangeError('pierSide must be EAST, WEST, or NEITHER')
}

// Validates a persisted lifecycle state supplied by the application.
function validateState(state: MeridianFlipState) {
	if (!STATE_PHASES.has(state.phase)) throw new RangeError('state.phase is invalid')
	if (!Number.isInteger(state.attempts) || !Number.isSafeInteger(state.attempts) || state.attempts < 0) throw new RangeError('state.attempts must be a non-negative safe integer')
	if (typeof state.preparationCompleted !== 'boolean') throw new RangeError('state.preparationCompleted must be boolean')
	if (state.failure !== undefined && !REASONS.has(state.failure)) throw new RangeError('state.failure is invalid')
	if (state.phase !== 'FAILED' && state.failure !== undefined) throw new RangeError('state.failure is only valid when phase is FAILED')
}

// Validates one external lifecycle event.
function validateEvent(event: MeridianFlipEvent) {
	if (!EVENT_TYPES.has(event.type)) throw new RangeError('event.type is invalid')
	if (event.type === 'FAILED' && event.reason !== undefined && !REASONS.has(event.reason)) throw new RangeError('event.reason is invalid')
}

// Returns true when the phase is controlled by threshold classification before a flip starts.
function isPreFlipPhase(phase: MeridianFlipStatePhase) {
	return phase === 'WAITING' || phase === 'PREPARING' || phase === 'READY'
}

// Returns true when FAILED may be emitted from the phase.
function isNonTerminalPhase(phase: MeridianFlipStatePhase) {
	return phase !== 'COMPLETED' && phase !== 'FAILED'
}

// Evaluates pier-side requirements while still in a pre-flip phase.
function evaluatePreFlipPierSide(resolved: ResolvedMeridianFlipPolicy, snapshot: MeridianFlipSnapshot, state: MeridianFlipState, hourAngle: Angle, untilFlip: Angle, untilLatest: Angle, isOverdue: boolean, isAlreadyFlipped: boolean): MeridianFlipDecision | undefined {
	if (resolved.beforeFlipPierSide === undefined) return undefined

	const pierSide = snapshot.pierSide ?? 'NEITHER'
	if (pierSide === 'NEITHER') {
		if (resolved.allowUnknownPierSide) return undefined
		return failedDecision(state, 'PIER_SIDE_NEITHER', hourAngle, untilFlip, untilLatest, isOverdue, isAlreadyFlipped)
	}

	if (pierSide !== resolved.beforeFlipPierSide) return failedDecision(state, 'PIER_SIDE_MISMATCH', hourAngle, untilFlip, untilLatest, isOverdue, isAlreadyFlipped)
	return undefined
}

// Evaluates threshold-driven WAITING, PREPARING, and READY decisions.
function evaluatePreFlipThresholds(resolved: ResolvedMeridianFlipPolicy, snapshot: MeridianFlipSnapshot, state: MeridianFlipState, hourAngle: Angle, untilFlip: Angle, untilLatest: Angle, isOverdue: boolean, isAlreadyFlipped: boolean): MeridianFlipDecision {
	if (isBeforeThreshold(hourAngle, resolved.prepareAt)) {
		return decision('WAITING', 'NONE', 'BEFORE_PREPARE_WINDOW', hourAngle, untilFlip, untilLatest, isOverdue, isAlreadyFlipped, updateState(state, 'WAITING', state.attempts, false))
	}

	if (isBeforeThreshold(hourAngle, resolved.flipAt)) {
		return decision('PREPARING', 'PREPARE', 'PREPARE_WINDOW_REACHED', hourAngle, untilFlip, untilLatest, isOverdue, isAlreadyFlipped, updateState(state, 'PREPARING', state.attempts, false))
	}

	const reason = isOverdue ? 'LATEST_THRESHOLD_REACHED' : 'FLIP_THRESHOLD_REACHED'
	if (snapshot.isExposing === true) {
		return decision('READY', isOverdue ? 'ABORT_EXPOSURE' : 'WAIT_FOR_EXPOSURE', isOverdue ? 'LATEST_THRESHOLD_REACHED' : 'WAITING_FOR_EXPOSURE', hourAngle, untilFlip, untilLatest, isOverdue, isAlreadyFlipped, updateState(state, 'READY', state.attempts, state.preparationCompleted))
	}

	if (!state.preparationCompleted && snapshot.isGuiding === true) return decision('READY', 'PAUSE_GUIDING', reason, hourAngle, untilFlip, untilLatest, isOverdue, isAlreadyFlipped, updateState(state, 'READY', state.attempts, false))
	return decision('READY', 'START_FLIP', reason, hourAngle, untilFlip, untilLatest, isOverdue, isAlreadyFlipped, updateState(state, 'READY', state.attempts, true))
}

// Evaluates post-flip pier-side verification without automatically completing it.
function evaluatePostFlipPierSide(resolved: ResolvedMeridianFlipPolicy, snapshot: MeridianFlipSnapshot, state: MeridianFlipState, hourAngle: Angle, untilFlip: Angle, untilLatest: Angle, isOverdue: boolean, isAlreadyFlipped: boolean): MeridianFlipDecision {
	if (resolved.afterFlipPierSide === undefined) return decision('VERIFYING_PIER_SIDE', 'VERIFY_PIER_SIDE', 'PIER_SIDE_NOT_CONFIGURED', hourAngle, untilFlip, untilLatest, isOverdue, isAlreadyFlipped, state)

	const pierSide = snapshot.pierSide ?? 'NEITHER'
	if (pierSide === 'NEITHER') {
		if (resolved.allowUnknownPierSide) return decision('VERIFYING_PIER_SIDE', 'VERIFY_PIER_SIDE', 'PIER_SIDE_NEITHER', hourAngle, untilFlip, untilLatest, isOverdue, isAlreadyFlipped, state)
		return failedDecision(state, 'PIER_SIDE_NEITHER', hourAngle, untilFlip, untilLatest, isOverdue, isAlreadyFlipped)
	}

	if (pierSide !== resolved.afterFlipPierSide) return failedDecision(state, 'PIER_SIDE_MISMATCH', hourAngle, untilFlip, untilLatest, isOverdue, isAlreadyFlipped)
	return decision('VERIFYING_PIER_SIDE', 'VERIFY_PIER_SIDE', 'ALREADY_ON_POST_FLIP_SIDE', hourAngle, untilFlip, untilLatest, isOverdue, isAlreadyFlipped, state)
}

// Evaluates terminal FAILED state retry availability.
function evaluateFailedState(resolved: ResolvedMeridianFlipPolicy, snapshot: MeridianFlipSnapshot, state: MeridianFlipState, hourAngle: Angle, untilFlip: Angle, untilLatest: Angle, isOverdue: boolean, isAlreadyFlipped: boolean): MeridianFlipDecision {
	if (state.attempts >= 1 && state.attempts <= resolved.maxRetries) {
		if (isAtOrAfterThreshold(hourAngle, resolved.flipAt) && snapshot.isExposing !== true && !isAlreadyFlipped) {
			const pierSideFailure = evaluatePreFlipPierSide(resolved, snapshot, state, hourAngle, untilFlip, untilLatest, isOverdue, isAlreadyFlipped)
			if (pierSideFailure) return pierSideFailure
			return decision('FAILED', 'START_FLIP', 'RETRY_AVAILABLE', hourAngle, untilFlip, untilLatest, isOverdue, isAlreadyFlipped, state)
		}
		return decision('FAILED', 'NONE', 'EXECUTION_FAILED', hourAngle, untilFlip, untilLatest, isOverdue, isAlreadyFlipped, state)
	}

	return decision('FAILED', 'FAIL', 'RETRY_LIMIT_REACHED', hourAngle, untilFlip, untilLatest, isOverdue, isAlreadyFlipped, state)
}

// Builds a failed decision and persisted failed state for validation failures.
function failedDecision(state: MeridianFlipState, reason: MeridianFlipReason, hourAngle: Angle, untilFlip: Angle, untilLatest: Angle, isOverdue: boolean, isAlreadyFlipped: boolean): MeridianFlipDecision {
	return decision('FAILED', 'FAIL', reason, hourAngle, untilFlip, untilLatest, isOverdue, isAlreadyFlipped, updateState(state, 'FAILED', state.attempts, state.preparationCompleted, reason))
}

// Returns the phase reached after explicit pier-side confirmation.
function phaseAfterPierSideConfirmed(resolved: ResolvedMeridianFlipPolicy): MeridianFlipStatePhase {
	if (resolved.requireRecentering) return 'RECENTERING'
	if (resolved.requireGuidingSettle) return 'SETTLING'
	return 'COMPLETED'
}

// Returns true when value is materially before a signed threshold.
function isBeforeThreshold(value: Angle, threshold: Angle) {
	return value < threshold && threshold - value > ANGULAR_THRESHOLD_EPSILON
}

// Returns true when value is at or materially after a signed threshold.
function isAtOrAfterThreshold(value: Angle, threshold: Angle) {
	return value > threshold || threshold - value <= ANGULAR_THRESHOLD_EPSILON
}

// Creates a decision object from already-computed angular fields and state.
function decision(phase: MeridianFlipPhase, action: MeridianFlipAction, reason: MeridianFlipReason, hourAngle: Angle, untilFlip: Angle, untilLatest: Angle, isOverdue: boolean, isAlreadyFlipped: boolean, state: MeridianFlipState): MeridianFlipDecision {
	return { phase, action, reason, hourAngle, untilFlip, untilLatest, isOverdue, isAlreadyFlipped, state }
}

// Returns the prior state when no persisted field changes, otherwise returns a new state.
function updateState(state: MeridianFlipState, phase: MeridianFlipStatePhase, attempts: number, preparationCompleted: boolean, failure?: MeridianFlipReason): MeridianFlipState {
	if (state.phase === phase && state.attempts === attempts && state.preparationCompleted === preparationCompleted && state.failure === failure) return state

	if (failure === undefined) {
		return { phase, attempts, preparationCompleted }
	}

	return { phase, attempts, preparationCompleted, failure }
}

// Throws a consistent error for invalid lifecycle event ordering.
function throwInvalidTransition(): never {
	throw new RangeError('invalid Meridian Flip transition')
}
