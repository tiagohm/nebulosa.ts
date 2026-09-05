import { expect, test } from 'bun:test'
import { PI, TAU } from '../../../src/core/constants'
import { deg, type Angle, normalizeAngle } from '../../../src/math/units/angle'
// oxfmt-ignore
import { computeHourAngle, computeLocalSiderealTime, createMeridianFlipState, evaluateMeridianFlip, type MeridianFlipAction, type MeridianFlipEvent, type MeridianFlipPhase, type MeridianFlipPolicy, type MeridianFlipReason, type MeridianFlipSnapshot, type MeridianFlipState, transitionMeridianFlip } from '../../../src/observation/mount/meridian.flip'

const TARGET_RA = deg(40)

function basePolicy(overrides: Partial<MeridianFlipPolicy> = {}): MeridianFlipPolicy {
	return { enabled: true, prepareAt: deg(-2), flipAt: deg(1), latestAt: deg(5), ...overrides }
}

function snapshotAt(hourAngle: Angle, overrides: Partial<MeridianFlipSnapshot> = {}): MeridianFlipSnapshot {
	return {
		localSiderealTime: normalizeAngle(TARGET_RA + hourAngle),
		target: { rightAscension: TARGET_RA },
		...overrides,
	}
}

function expectDecision(decision: ReturnType<typeof evaluateMeridianFlip>, phase: MeridianFlipPhase, action: MeridianFlipAction, reason: MeridianFlipReason) {
	expect(decision.phase).toBe(phase)
	expect(decision.action).toBe(action)
	expect(decision.reason).toBe(reason)
}

test('angular utilities compute signed hour angle and local sidereal time', () => {
	expect(computeHourAngle(2, 1)).toBeCloseTo(1, 16)
	expect(computeHourAngle(1, 2)).toBeCloseTo(-1, 16)
	expect(computeHourAngle(deg(1), deg(359))).toBeCloseTo(deg(2), 14)
	expect(computeHourAngle(deg(359), deg(1))).toBeCloseTo(deg(-2), 14)
	expect(computeHourAngle(0, PI)).toBe(PI)
	expect(computeLocalSiderealTime(deg(10), deg(20))).toBeCloseTo(deg(30), 14)
	expect(computeLocalSiderealTime(deg(350), deg(20))).toBeCloseTo(deg(10), 14)
})

test('hour angle and local sidereal time are inverse operations', () => {
	const rightAscension = deg(40)
	for (const hourAngle of [deg(-30), 0, deg(15), deg(120)]) {
		const lst = computeLocalSiderealTime(rightAscension, hourAngle)
		expect(computeHourAngle(lst, rightAscension)).toBeCloseTo(normalizeAngle(hourAngle) > PI ? normalizeAngle(hourAngle) - TAU : normalizeAngle(hourAngle), 12)
	}
})

test('angular utilities reject non-finite input', () => {
	expect(() => computeHourAngle(Number.NaN, 0)).toThrow(RangeError)
	expect(() => computeHourAngle(0, Number.POSITIVE_INFINITY)).toThrow(RangeError)
	expect(() => computeLocalSiderealTime(Number.NEGATIVE_INFINITY, 0)).toThrow(RangeError)
	expect(() => computeLocalSiderealTime(0, Number.NaN)).toThrow(RangeError)
})

test('policy validation rejects invalid thresholds, retries, and configured pier sides', () => {
	expect(() => evaluateMeridianFlip(basePolicy({ prepareAt: deg(2), flipAt: deg(1) }), snapshotAt(0))).toThrow(RangeError)
	expect(() => evaluateMeridianFlip(basePolicy({ flipAt: deg(6), latestAt: deg(5) }), snapshotAt(0))).toThrow(RangeError)

	for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
		expect(() => evaluateMeridianFlip(basePolicy({ prepareAt: value }), snapshotAt(0))).toThrow(RangeError)
	}

	expect(() => evaluateMeridianFlip(basePolicy({ prepareAt: -PI }), snapshotAt(0))).toThrow(RangeError)
	expect(() => evaluateMeridianFlip(basePolicy({ latestAt: PI }), snapshotAt(0))).toThrow(RangeError)

	for (const maxRetries of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN, Number.POSITIVE_INFINITY]) {
		expect(() => evaluateMeridianFlip(basePolicy({ maxRetries }), snapshotAt(0))).toThrow(RangeError)
	}

	expect(() => evaluateMeridianFlip(basePolicy({ beforeFlipPierSide: 'EAST', afterFlipPierSide: 'EAST' }), snapshotAt(0))).toThrow(RangeError)
	expect(() => evaluateMeridianFlip(basePolicy({ beforeFlipPierSide: 'NEITHER' }), snapshotAt(0))).toThrow(RangeError)
	expect(() => evaluateMeridianFlip(basePolicy({ afterFlipPierSide: 'NEITHER' }), snapshotAt(0))).toThrow(RangeError)
})

test('runtime validation rejects invalid snapshot and state values', () => {
	expect(() => evaluateMeridianFlip(basePolicy(), snapshotAt(0, { pierSide: 'NORTH' as never }))).toThrow(RangeError)
	expect(() => evaluateMeridianFlip(basePolicy(), snapshotAt(0, { localSiderealTime: Number.NaN }))).toThrow(RangeError)
	expect(() => evaluateMeridianFlip(basePolicy(), { localSiderealTime: 0, target: { rightAscension: Number.POSITIVE_INFINITY } })).toThrow(RangeError)
	expect(() => evaluateMeridianFlip(basePolicy(), snapshotAt(0), { phase: 'BAD' as never, attempts: 0, preparationCompleted: false })).toThrow(RangeError)
	expect(() => evaluateMeridianFlip(basePolicy(), snapshotAt(0), { phase: 'WAITING', attempts: -1, preparationCompleted: false })).toThrow(RangeError)
	expect(() => evaluateMeridianFlip(basePolicy(), snapshotAt(0), { phase: 'WAITING', attempts: 0.5, preparationCompleted: false })).toThrow(RangeError)
	expect(() => evaluateMeridianFlip(basePolicy(), snapshotAt(0), { phase: 'WAITING', attempts: 0, preparationCompleted: false, failure: 'EXECUTION_FAILED' })).toThrow(RangeError)
	expect(() => evaluateMeridianFlip(basePolicy(), snapshotAt(0), { phase: 'FAILED', attempts: 0, preparationCompleted: false, failure: 'BAD' as never })).toThrow(RangeError)
})

test('threshold decisions classify preparation, flip, latest, and signed distances', () => {
	const before = evaluateMeridianFlip(basePolicy(), snapshotAt(deg(-3)))
	expectDecision(before, 'WAITING', 'NONE', 'BEFORE_PREPARE_WINDOW')
	expect(before.state.preparationCompleted).toBeFalse()

	const preparing = evaluateMeridianFlip(basePolicy(), snapshotAt(deg(-1)))
	expectDecision(preparing, 'PREPARING', 'PREPARE', 'PREPARE_WINDOW_REACHED')

	const atPrepare = evaluateMeridianFlip(basePolicy(), snapshotAt(deg(-2)))
	expectDecision(atPrepare, 'PREPARING', 'PREPARE', 'PREPARE_WINDOW_REACHED')

	const atFlip = evaluateMeridianFlip(basePolicy(), snapshotAt(deg(1), { isGuiding: true }))
	expectDecision(atFlip, 'READY', 'PAUSE_GUIDING', 'FLIP_THRESHOLD_REACHED')

	const exposingAtFlip = evaluateMeridianFlip(basePolicy(), snapshotAt(deg(2), { isExposing: true }))
	expectDecision(exposingAtFlip, 'READY', 'WAIT_FOR_EXPOSURE', 'WAITING_FOR_EXPOSURE')

	const prepared = transitionMeridianFlip(basePolicy(), atFlip.state, { type: 'PREPARED' })
	const start = evaluateMeridianFlip(basePolicy(), snapshotAt(deg(2)), prepared)
	expectDecision(start, 'READY', 'START_FLIP', 'FLIP_THRESHOLD_REACHED')

	const overdueExposure = evaluateMeridianFlip(basePolicy(), snapshotAt(deg(5), { isExposing: true }))
	expectDecision(overdueExposure, 'READY', 'ABORT_EXPOSURE', 'LATEST_THRESHOLD_REACHED')
	expect(overdueExposure.isOverdue).toBeTrue()

	const overdueUnprepared = evaluateMeridianFlip(basePolicy(), snapshotAt(deg(6), { isGuiding: true }))
	expectDecision(overdueUnprepared, 'READY', 'PAUSE_GUIDING', 'LATEST_THRESHOLD_REACHED')

	const overduePrepared = evaluateMeridianFlip(basePolicy(), snapshotAt(deg(6)), prepared)
	expectDecision(overduePrepared, 'READY', 'START_FLIP', 'LATEST_THRESHOLD_REACHED')
	expect(overduePrepared.untilFlip).toBeCloseTo(deg(-5), 14)
	expect(overduePrepared.untilLatest).toBeCloseTo(deg(-1), 14)
})

test('flip threshold without active guiding can start without a fabricated preparation event', () => {
	for (const isGuiding of [false, undefined]) {
		const result = evaluateMeridianFlip(basePolicy(), snapshotAt(deg(2), { isGuiding }))
		expectDecision(result, 'READY', 'START_FLIP', 'FLIP_THRESHOLD_REACHED')
		expect(result.state.preparationCompleted).toBeTrue()
	}
})

test('flip threshold waits while the mount is slewing or unsettled', () => {
	const state: MeridianFlipState = { phase: 'READY', attempts: 0, preparationCompleted: true }

	for (const snapshot of [snapshotAt(deg(2), { isSlewing: true }), snapshotAt(deg(2), { isMountSettled: false })]) {
		const result = evaluateMeridianFlip(basePolicy(), snapshot, state)
		expectDecision(result, 'READY', 'NONE', 'FLIP_THRESHOLD_REACHED')
		expect(result.state.preparationCompleted).toBeTrue()
	}
})

test('configured post-flip side completes active pre-flip states without recommending another flip', () => {
	const policy = basePolicy({ beforeFlipPierSide: 'EAST', afterFlipPierSide: 'WEST' })

	for (const phase of ['WAITING', 'PREPARING', 'READY'] as const) {
		const state: MeridianFlipState = { phase, attempts: 0, preparationCompleted: phase === 'READY' }
		const result = evaluateMeridianFlip(policy, snapshotAt(deg(2), { pierSide: 'WEST' }), state)
		expectDecision(result, 'COMPLETED', 'COMPLETE', 'ALREADY_ON_POST_FLIP_SIDE')
		expect(result.isAlreadyFlipped).toBeTrue()
		expect(result.state.phase).toBe('COMPLETED')
		expect(result.action).not.toBe('START_FLIP')
	}
})

test('before-flip pier-side validation handles completed, mismatch, and unknown telemetry', () => {
	const mappedPolicy = basePolicy({ beforeFlipPierSide: 'EAST', afterFlipPierSide: 'WEST' })
	expectDecision(evaluateMeridianFlip(mappedPolicy, snapshotAt(deg(-3), { pierSide: 'WEST' })), 'COMPLETED', 'COMPLETE', 'ALREADY_ON_POST_FLIP_SIDE')

	const mismatchPolicy = basePolicy({ beforeFlipPierSide: 'EAST' })
	expectDecision(evaluateMeridianFlip(mismatchPolicy, snapshotAt(deg(-3), { pierSide: 'WEST' })), 'FAILED', 'FAIL', 'PIER_SIDE_MISMATCH')
	expectDecision(evaluateMeridianFlip(mismatchPolicy, snapshotAt(deg(-3))), 'FAILED', 'FAIL', 'PIER_SIDE_NEITHER')
	expectDecision(evaluateMeridianFlip(basePolicy({ beforeFlipPierSide: 'EAST', allowUnknownPierSide: true }), snapshotAt(deg(-3), { pierSide: 'WEST' })), 'FAILED', 'FAIL', 'PIER_SIDE_MISMATCH')
	expectDecision(evaluateMeridianFlip(basePolicy({ beforeFlipPierSide: 'EAST', allowUnknownPierSide: true }), snapshotAt(deg(-3))), 'WAITING', 'NONE', 'BEFORE_PREPARE_WINDOW')
})

test('post-flip pier-side verification requires explicit confirmation event', () => {
	const verifying: MeridianFlipState = { phase: 'VERIFYING_PIER_SIDE', attempts: 1, preparationCompleted: true }
	const policy = basePolicy({ afterFlipPierSide: 'WEST' })

	expectDecision(evaluateMeridianFlip(policy, snapshotAt(deg(3)), verifying), 'FAILED', 'FAIL', 'PIER_SIDE_NEITHER')
	expectDecision(evaluateMeridianFlip(basePolicy({ afterFlipPierSide: 'WEST', allowUnknownPierSide: true }), snapshotAt(deg(3)), verifying), 'VERIFYING_PIER_SIDE', 'VERIFY_PIER_SIDE', 'PIER_SIDE_NEITHER')
	expectDecision(evaluateMeridianFlip(policy, snapshotAt(deg(3), { pierSide: 'WEST' }), verifying), 'VERIFYING_PIER_SIDE', 'VERIFY_PIER_SIDE', 'ALREADY_ON_POST_FLIP_SIDE')
	expectDecision(evaluateMeridianFlip(policy, snapshotAt(deg(3), { pierSide: 'EAST' }), verifying), 'FAILED', 'FAIL', 'PIER_SIDE_MISMATCH')
	expectDecision(evaluateMeridianFlip(basePolicy(), snapshotAt(deg(3)), verifying), 'VERIFYING_PIER_SIDE', 'VERIFY_PIER_SIDE', 'PIER_SIDE_NOT_CONFIGURED')
})

test('state machine completes full lifecycle with recentering and guiding settle', () => {
	const policy = basePolicy({ afterFlipPierSide: 'WEST' })
	let state = createMeridianFlipState()

	state = evaluateMeridianFlip(policy, snapshotAt(deg(-1)), state).state
	expect(state.phase).toBe('PREPARING')

	state = evaluateMeridianFlip(policy, snapshotAt(deg(1), { isGuiding: true }), state).state
	expect(state.phase).toBe('READY')
	expect(state.preparationCompleted).toBeFalse()

	state = transitionMeridianFlip(policy, state, { type: 'PREPARED' })
	expect(state.preparationCompleted).toBeTrue()

	state = transitionMeridianFlip(policy, state, { type: 'FLIP_STARTED' })
	expect(state).toMatchObject({ phase: 'FLIPPING', attempts: 1 })

	state = transitionMeridianFlip(policy, state, { type: 'FLIP_COMPLETED' })
	expect(state.phase).toBe('VERIFYING_PIER_SIDE')

	state = transitionMeridianFlip(policy, state, { type: 'PIER_SIDE_CONFIRMED' })
	expect(state.phase).toBe('RECENTERING')

	state = transitionMeridianFlip(policy, state, { type: 'RECENTER_COMPLETED' })
	expect(state.phase).toBe('SETTLING')

	state = transitionMeridianFlip(policy, state, { type: 'GUIDING_SETTLED' })
	expect(state.phase).toBe('COMPLETED')

	expectDecision(evaluateMeridianFlip(policy, snapshotAt(deg(3), { pierSide: 'WEST' }), state), 'COMPLETED', 'COMPLETE', 'FLIP_COMPLETED')
})

test('state machine can complete after pier-side confirmation without optional phases', () => {
	const policy = basePolicy({ requireRecentering: false, requireGuidingSettle: false })
	const state = transitionMeridianFlip(policy, { phase: 'VERIFYING_PIER_SIDE', attempts: 1, preparationCompleted: true }, { type: 'PIER_SIDE_CONFIRMED' })
	expect(state.phase).toBe('COMPLETED')
})

test('retry accounting respects maxRetries and reset clears cycle state', () => {
	const policy = basePolicy({ maxRetries: 1 })
	let state: MeridianFlipState = { phase: 'READY', attempts: 0, preparationCompleted: true }

	state = transitionMeridianFlip(policy, state, { type: 'FLIP_STARTED' })
	expect(state.attempts).toBe(1)

	state = transitionMeridianFlip(policy, state, { type: 'FAILED' })
	expect(state).toMatchObject({ phase: 'FAILED', attempts: 1, failure: 'EXECUTION_FAILED' })

	expectDecision(evaluateMeridianFlip(policy, snapshotAt(deg(2)), state), 'FAILED', 'START_FLIP', 'RETRY_AVAILABLE')

	state = transitionMeridianFlip(policy, state, { type: 'FLIP_STARTED' })
	expect(state).toMatchObject({ phase: 'FLIPPING', attempts: 2 })

	state = transitionMeridianFlip(policy, state, { type: 'FAILED', reason: 'PIER_SIDE_MISMATCH' })
	expect(state).toMatchObject({ phase: 'FAILED', attempts: 2, failure: 'PIER_SIDE_MISMATCH' })
	expectDecision(evaluateMeridianFlip(policy, snapshotAt(deg(2)), state), 'FAILED', 'FAIL', 'RETRY_LIMIT_REACHED')

	state = transitionMeridianFlip(policy, state, { type: 'RESET' })
	expect(state).toEqual(createMeridianFlipState())
})

test('failed state exposes retry only after threshold, not while exposing or already flipped', () => {
	const state: MeridianFlipState = { phase: 'FAILED', attempts: 1, preparationCompleted: true, failure: 'EXECUTION_FAILED' }
	const policy = basePolicy({ maxRetries: 1, afterFlipPierSide: 'WEST' })

	expectDecision(evaluateMeridianFlip(policy, snapshotAt(deg(0)), state), 'FAILED', 'NONE', 'EXECUTION_FAILED')
	expectDecision(evaluateMeridianFlip(policy, snapshotAt(deg(2), { isExposing: true }), state), 'FAILED', 'NONE', 'EXECUTION_FAILED')
	expectDecision(evaluateMeridianFlip(policy, snapshotAt(deg(2), { pierSide: 'WEST' }), state), 'FAILED', 'NONE', 'EXECUTION_FAILED')
})

test('failed retry rechecks pre-flip pier-side guards before starting another flip', () => {
	const state: MeridianFlipState = { phase: 'FAILED', attempts: 1, preparationCompleted: true, failure: 'EXECUTION_FAILED' }
	const policy = basePolicy({ beforeFlipPierSide: 'EAST', maxRetries: 1 })

	expectDecision(evaluateMeridianFlip(policy, snapshotAt(deg(2), { pierSide: 'WEST' }), state), 'FAILED', 'FAIL', 'PIER_SIDE_MISMATCH')
	expectDecision(evaluateMeridianFlip(policy, snapshotAt(deg(2)), state), 'FAILED', 'FAIL', 'PIER_SIDE_NEITHER')
	expectDecision(evaluateMeridianFlip(policy, snapshotAt(deg(2), { pierSide: 'EAST' }), state), 'FAILED', 'START_FLIP', 'RETRY_AVAILABLE')
	expectDecision(evaluateMeridianFlip(basePolicy({ beforeFlipPierSide: 'EAST', allowUnknownPierSide: true, maxRetries: 1 }), snapshotAt(deg(2)), state), 'FAILED', 'START_FLIP', 'RETRY_AVAILABLE')
})

test('failed retry waits while the mount is slewing or unsettled', () => {
	const state: MeridianFlipState = { phase: 'FAILED', attempts: 1, preparationCompleted: true, failure: 'EXECUTION_FAILED' }
	const policy = basePolicy({ maxRetries: 1 })

	expectDecision(evaluateMeridianFlip(policy, snapshotAt(deg(2), { isSlewing: true }), state), 'FAILED', 'NONE', 'EXECUTION_FAILED')
	expectDecision(evaluateMeridianFlip(policy, snapshotAt(deg(2), { isMountSettled: false }), state), 'FAILED', 'NONE', 'EXECUTION_FAILED')
})

test('invalid lifecycle transitions throw RangeError', () => {
	const policy = basePolicy()
	const cases: readonly [MeridianFlipState, MeridianFlipEvent][] = [
		[{ phase: 'WAITING', attempts: 0, preparationCompleted: false }, { type: 'GUIDING_SETTLED' }],
		[{ phase: 'COMPLETED', attempts: 1, preparationCompleted: true }, { type: 'FLIP_STARTED' }],
		[{ phase: 'FLIPPING', attempts: 1, preparationCompleted: true }, { type: 'RECENTER_COMPLETED' }],
		[{ phase: 'READY', attempts: 0, preparationCompleted: false }, { type: 'FLIP_STARTED' }],
		[{ phase: 'FAILED', attempts: 0, preparationCompleted: false, failure: 'EXECUTION_FAILED' }, { type: 'FLIP_STARTED' }],
		[{ phase: 'COMPLETED', attempts: 1, preparationCompleted: true }, { type: 'FAILED' }],
		[{ phase: 'FAILED', attempts: 1, preparationCompleted: true, failure: 'EXECUTION_FAILED' }, { type: 'FAILED' }],
		[{ phase: 'WAITING', attempts: 0, preparationCompleted: false }, { type: 'BOGUS' } as never],
	]

	for (const [state, event] of cases) {
		expect(() => transitionMeridianFlip(policy, state, event)).toThrow(RangeError)
	}
})

test('disabled policy returns a disabled decision while preserving existing state', () => {
	const state: MeridianFlipState = { phase: 'FAILED', attempts: 1, preparationCompleted: true, failure: 'EXECUTION_FAILED' }
	const result = evaluateMeridianFlip(basePolicy({ enabled: false }), snapshotAt(deg(2)), state)

	expectDecision(result, 'DISABLED', 'NONE', 'DISABLED')
	expect(result.state).toBe(state)
})

test('evaluation and transition do not mutate inputs and reuse unchanged states', () => {
	const policy = Object.freeze(basePolicy({ beforeFlipPierSide: 'EAST', allowUnknownPierSide: true }))
	const snapshot = Object.freeze({
		localSiderealTime: normalizeAngle(TARGET_RA + deg(-3)),
		target: Object.freeze({ rightAscension: TARGET_RA }),
	}) as MeridianFlipSnapshot
	const state = Object.freeze(createMeridianFlipState()) as MeridianFlipState
	const event = Object.freeze({ type: 'RESET' }) as MeridianFlipEvent

	const result = evaluateMeridianFlip(policy, snapshot, state)
	expect(result.state).toBe(state)
	expect(policy).toEqual(basePolicy({ beforeFlipPierSide: 'EAST', allowUnknownPierSide: true }))
	expect(snapshot).toEqual({ localSiderealTime: normalizeAngle(TARGET_RA + deg(-3)), target: { rightAscension: TARGET_RA } })
	expect(state).toEqual(createMeridianFlipState())

	const reset = transitionMeridianFlip(policy, state, event)
	expect(reset).toBe(state)
	expect(event).toEqual({ type: 'RESET' })
})

test('evaluation reports in-progress phases and preserves their persisted state', () => {
	const cases: readonly [MeridianFlipState, MeridianFlipPhase, MeridianFlipAction, MeridianFlipReason][] = [
		[{ phase: 'FLIPPING', attempts: 1, preparationCompleted: true }, 'FLIPPING', 'NONE', 'FLIP_IN_PROGRESS'],
		[{ phase: 'RECENTERING', attempts: 1, preparationCompleted: true }, 'RECENTERING', 'RECENTER', 'RECENTER_REQUIRED'],
		[{ phase: 'SETTLING', attempts: 1, preparationCompleted: true }, 'SETTLING', 'RESUME_GUIDING', 'GUIDING_SETTLE_REQUIRED'],
	]

	for (const [input, phase, action, reason] of cases) {
		const state = Object.freeze(input)
		const result = evaluateMeridianFlip(basePolicy(), snapshotAt(deg(2)), state)
		expectDecision(result, phase, action, reason)
		expect(result.state).toBe(state)
	}
})

test('hour angle past flip up to PI is treated as past the flip threshold', () => {
	const nearLowerCulmination = evaluateMeridianFlip(basePolicy(), snapshotAt(deg(170), { isGuiding: true }))
	expectDecision(nearLowerCulmination, 'READY', 'PAUSE_GUIDING', 'LATEST_THRESHOLD_REACHED')
	expect(nearLowerCulmination.isOverdue).toBeTrue()
	expect(nearLowerCulmination.hourAngle).toBeCloseTo(deg(170), 14)
})

test('failed state without an accepted flip cannot retry', () => {
	const state: MeridianFlipState = { phase: 'FAILED', attempts: 0, preparationCompleted: false, failure: 'PIER_SIDE_MISMATCH' }
	expectDecision(evaluateMeridianFlip(basePolicy({ maxRetries: 1 }), snapshotAt(deg(2)), state), 'FAILED', 'FAIL', 'RETRY_LIMIT_REACHED')
})

test('pier-side confirmation and recenter completion honor optional phase toggles', () => {
	const settleOnly = transitionMeridianFlip(basePolicy({ requireRecentering: false }), { phase: 'VERIFYING_PIER_SIDE', attempts: 1, preparationCompleted: true }, { type: 'PIER_SIDE_CONFIRMED' })
	expect(settleOnly.phase).toBe('SETTLING')

	const recenterToComplete = transitionMeridianFlip(basePolicy({ requireGuidingSettle: false }), { phase: 'RECENTERING', attempts: 1, preparationCompleted: true }, { type: 'RECENTER_COMPLETED' })
	expect(recenterToComplete.phase).toBe('COMPLETED')
})

test('flip start beyond the retry limit is rejected', () => {
	const policy = basePolicy({ maxRetries: 1 })
	const exhausted: MeridianFlipState = { phase: 'FAILED', attempts: 2, preparationCompleted: true, failure: 'EXECUTION_FAILED' }
	expect(() => transitionMeridianFlip(policy, exhausted, { type: 'FLIP_STARTED' })).toThrow(RangeError)
})
