// oxfmt-ignore
import type { SequencerCalibrationBatch, SequencerCameraCapture, SequencerCaptureConfiguration, SequencerCheckpointSlot, SequencerEventBody, SequencerFrameGroup, SequencerFrameGroupTrigger, SequencerFrameSlot, SequencerScheduledFrameGroup, SequencerSchedulerState, SequencerTriggeredFrameGroup } from './sequencer'
import type { SequencerCaptureProgress } from './state'

// Pure frame selection of the Sequencer: which slot the next safe point prepares and exposes. It applies a fixed
// order (the pending slot of a retake or retry, then the calibration batches in fire order, then the scheduled
// groups by `capture.order`, then the session-end batches; after a graceful stop only the session-end groups with
// `onStop`) and builds stable slot identities `frame[{groupId}][{ordinal}]` that never depend on array positions,
// counters, file names or timestamps. The persisted scheduler state (cursor, credits, batch queue, session-boundary
// flags) is mutated in place; per-group progress is only read. A slot is done when it is accepted, forced or
// skipped, and the slots of a group are done in ordinal order, so the next ordinal of a group is always derived
// from its progress and the queue, never from a separate counter; the slot a checkpoint persisted as in progress is
// rebuilt from its id the same way. Every selection is O(groups + batches) and
// allocates the returned slot plus small per-group scratch; nothing here touches devices, clocks or storage.

// Trigger events produced when a calibration batch is enqueued, in the exact shape the runner emits.
export type SequencerTriggerEvent = Extract<SequencerEventBody, { readonly type: 'triggerFired' | 'triggerSuppressed' }>

// Stable id of the slot `ordinal` (1-based) of a group.
export function sequencerFrameSlotId(groupId: string, ordinal: number) {
	return `frame[${groupId}][${ordinal}]`
}

// Slots of a group that are done (accepted, forced or skipped); 0 for a group without progress.
export function completedSlotsOf(progress: SequencerCaptureProgress, groupId: string) {
	const counters = progress.get(groupId)
	return counters === undefined ? 0 : counters.accepted + counters.forced + counters.skipped
}

// Slots a triggered group consumed from its `maxFrames`: the done ones plus every slot pending in the queue,
// including the one in progress. A slot counts from the moment its batch is enqueued; retakes never change it and
// a skipped slot never gives its capacity back. Equal to the last ordinal assigned to the group.
export function consumedSlotsOf(scheduler: SequencerSchedulerState, progress: SequencerCaptureProgress, groupId: string) {
	let consumed = completedSlotsOf(progress, groupId)

	for (const batch of scheduler.batches) {
		if (batch.groupId === groupId) consumed = Math.max(consumed, batch.firstOrdinal + batch.size - 1)
	}

	return consumed
}

// Enqueues a batch of a triggered group at the end of the queue (FIFO; a batch in progress is never preempted),
// in place. The batch receives `min(batchSize, maxFrames − consumed)` slots: a truncated batch fires with its
// effective size and a group without free capacity enqueues nothing and reports `triggerSuppressed`. With
// `inherit: 'triggeringFrame'` the camera settings of `triggering` (the light that fired the batch) are copied and
// frozen, the frame type of the group prevailing; without a triggering frame (session-boundary triggers) the group
// settings apply. A disabled group never produces slots and returns undefined.
export function enqueueCalibrationBatch(scheduler: SequencerSchedulerState, progress: SequencerCaptureProgress, group: SequencerTriggeredFrameGroup, triggering?: SequencerFrameSlot): SequencerTriggerEvent | undefined {
	if (!group.enabled) return undefined

	const triggeredBy = triggering?.id
	const consumed = consumedSlotsOf(scheduler, progress, group.id)
	const size = Math.min(group.batchSize, group.maxFrames - consumed)

	if (!(size > 0)) return { type: 'triggerSuppressed', groupId: group.id, ...(triggeredBy !== undefined && { triggeredBy }) }

	const capture = group.inherit === 'triggeringFrame' && triggering !== undefined ? calibrationCapture(triggering.capture, group.capture) : { ...group.capture }
	const filter = group.opticalPath.kind === 'filter' ? group.opticalPath.filter : group.filter
	scheduler.batches.push({ groupId: group.id, firstOrdinal: consumed + 1, size, capture, ...(filter !== undefined && { filter }), ...(triggeredBy !== undefined && { triggeredBy }) })

	return { type: 'triggerFired', groupId: group.id, slots: size, ...(triggeredBy !== undefined && { triggeredBy }) }
}

// Selects the slot the next safe point prepares, in the fixed order:
// 1. `current`, the slot whose last attempt was consumed without completing it (retake or retry), returned with
//    `attempt + 1` and every other counter unchanged; the scheduler state is not touched;
// 2. the next pending slot of the calibration batches, in fire order (the 'sessionStart' batches are enqueued
//    before the first scheduled selection);
// 3. the next slot of the scheduled groups according to `capture.order`;
// 4. the 'sessionEnd' batches, enqueued once when the scheduled groups are exhausted;
// 5. undefined: nothing is left and the session shuts down.
// Mutates `scheduler` in place (cursor, credits, finished batches removed, session-boundary batches enqueued);
// `progress` and `current` are only read and the returned slot is a fresh object (its camera settings alias the
// configuration or the batch). The trigger events of session-boundary batches are appended to `events` when given.
// The same configuration, scheduler state, progress and current slot always select the same slot.
export function selectNextFrame(capture: SequencerCaptureConfiguration, scheduler: SequencerSchedulerState, progress: SequencerCaptureProgress, current?: SequencerFrameSlot, events?: SequencerTriggerEvent[]): SequencerFrameSlot | undefined {
	if (current !== undefined) return { ...current, attempt: current.attempt + 1 }

	if (!scheduler.sessionStartQueued) {
		scheduler.sessionStartQueued = true
		enqueueSessionBatches(capture.groups, scheduler, progress, 'sessionStart', events)
	}

	const calibration = nextCalibrationSlot(scheduler, progress)
	if (calibration !== undefined) return calibration

	const group = selectScheduledGroup(capture, scheduler, progress)
	if (group !== undefined) return scheduledSlot(group, completedSlotsOf(progress, group.id) + 1)

	if (scheduler.sessionEndQueued) return undefined

	scheduler.sessionEndQueued = true
	enqueueSessionBatches(capture.groups, scheduler, progress, 'sessionEnd', events)
	return nextCalibrationSlot(scheduler, progress)
}

// Selects the slot the next safe point prepares once a graceful stop was requested: only the 'sessionEnd' groups
// with `onStop` still produce frames, and nothing else is ever selected (no scheduled slot, no other batch).
// 1. `current`, when it belongs to such a group, returned with `attempt + 1` like a retake or retry;
// 2. the 'sessionEnd' batches are enqueued once if the scheduled groups were not exhausted yet, for the `onStop`
//    groups only (a group already enqueued at the natural end is never enqueued again);
// 3. the next pending slot of the `onStop` batches, in fire order, skipping every other batch, which stays queued;
// 4. undefined: the session shuts down.
// Mutates `scheduler` in place (session-end flag and batches, finished `onStop` batches removed); `progress` and
// `current` are only read. The trigger events of the enqueued batches are appended to `events` when given.
export function selectNextFrameOnStop(capture: SequencerCaptureConfiguration, scheduler: SequencerSchedulerState, progress: SequencerCaptureProgress, current?: SequencerFrameSlot, events?: SequencerTriggerEvent[]): SequencerFrameSlot | undefined {
	const onStop = new Set<string>()

	for (const group of capture.groups) {
		if (group.kind === 'triggered' && group.enabled && group.trigger.kind === 'sessionEnd' && group.trigger.onStop) onStop.add(group.id)
	}

	if (current !== undefined && onStop.has(current.groupId)) return { ...current, attempt: current.attempt + 1 }

	if (!scheduler.sessionEndQueued) {
		scheduler.sessionEndQueued = true

		for (const group of capture.groups) {
			if (group.kind !== 'triggered' || !onStop.has(group.id)) continue
			const event = enqueueCalibrationBatch(scheduler, progress, group)
			if (event !== undefined) events?.push(event)
		}
	}

	const { batches } = scheduler

	for (let i = 0; i < batches.length;) {
		const batch = batches[i]

		if (!onStop.has(batch.groupId)) {
			i++
			continue
		}

		const slot = pendingBatchSlot(batch, progress)
		if (slot !== undefined) return slot
		batches.splice(i, 1)
	}

	return undefined
}

// Pattern of a slot id: the group id (which may itself contain brackets) and the 1-based ordinal, always last.
const SLOT_ID_PATTERN = /^frame\[(.+)\]\[([1-9][0-9]*)\]$/s

// Rebuilds the slot a checkpoint persisted as in progress, with its persisted counters and `attempt` the attempt it
// has not consumed yet: a scheduled slot takes the settings of its group, a triggered one those frozen in the pending
// batch that holds its ordinal. Undefined when the id names no enabled group of the configuration or no pending
// batch, which only a checkpoint of another configuration produces. Reads `scheduler` without changing it.
export function restoreSequencerFrameSlot(capture: SequencerCaptureConfiguration, scheduler: SequencerSchedulerState, slot: SequencerCheckpointSlot): SequencerFrameSlot | undefined {
	const match = SLOT_ID_PATTERN.exec(slot.id)
	if (match === null) return undefined

	const groupId = match[1]
	const ordinal = +match[2]
	const group = capture.groups.find((group) => group.id === groupId)
	if (group === undefined || !group.enabled) return undefined

	const { attempt, discardedTotal, discardBudgetUsed, captureFailures } = slot
	const counters = { attempt, discardedTotal, discardBudgetUsed, captureFailures }

	if (group.kind === 'scheduled') return { ...scheduledSlot(group, ordinal), ...counters }

	const batch = scheduler.batches.find((batch) => batch.groupId === groupId && ordinal >= batch.firstOrdinal && ordinal < batch.firstOrdinal + batch.size)
	if (batch === undefined) return undefined

	const { capture: settings, filter, triggeredBy } = batch
	return { id: slot.id, groupId, kind: 'triggered', ordinal, ...counters, capture: settings, ...(filter !== undefined && { filter }), ...(triggeredBy !== undefined && { triggeredBy }) }
}

// Camera settings of a calibration slot inheriting from the light that fired it: every setting of the light, the
// frame type of the group. A fresh object, so later changes of the light never alter the batch.
function calibrationCapture(light: SequencerCameraCapture, group: SequencerCameraCapture): SequencerCameraCapture {
	const { exposureTime, exposureTimeUnit, x, y, width, height, subframe, binX, binY, frameFormat, gain, offset, compressed } = light
	return { exposureTime, exposureTimeUnit, frameType: group.frameType, x, y, width, height, subframe, binX, binY, frameFormat, gain, offset, compressed }
}

// Enqueues, in declared order, a batch of every enabled triggered group whose trigger is `kind`.
function enqueueSessionBatches(groups: readonly SequencerFrameGroup[], scheduler: SequencerSchedulerState, progress: SequencerCaptureProgress, kind: Extract<SequencerFrameGroupTrigger['kind'], 'sessionStart' | 'sessionEnd'>, events: SequencerTriggerEvent[] | undefined) {
	for (const group of groups) {
		if (group.kind !== 'triggered' || group.trigger.kind !== kind) continue
		const event = enqueueCalibrationBatch(scheduler, progress, group)
		if (event !== undefined) events?.push(event)
	}
}

// Next pending slot of the head batch, after removing the finished batches from the head, in place.
function nextCalibrationSlot(scheduler: SequencerSchedulerState, progress: SequencerCaptureProgress): SequencerFrameSlot | undefined {
	const { batches } = scheduler

	while (batches.length > 0) {
		const slot = pendingBatchSlot(batches[0], progress)
		if (slot !== undefined) return slot
		batches.shift()
	}

	return undefined
}

// Fresh first attempt of the next pending slot of a batch, or undefined once every slot of the batch is done.
function pendingBatchSlot(batch: SequencerCalibrationBatch, progress: SequencerCaptureProgress): SequencerFrameSlot | undefined {
	const ordinal = Math.max(batch.firstOrdinal, completedSlotsOf(progress, batch.groupId) + 1)
	if (ordinal >= batch.firstOrdinal + batch.size) return undefined
	const { groupId, capture, filter, triggeredBy } = batch
	return { id: sequencerFrameSlotId(groupId, ordinal), groupId, kind: 'triggered', ordinal, attempt: 1, discardedTotal: 0, discardBudgetUsed: 0, captureFailures: 0, capture, ...(filter !== undefined && { filter }), ...(triggeredBy !== undefined && { triggeredBy }) }
}

// Fresh first attempt of the slot `ordinal` of a scheduled group.
function scheduledSlot(group: SequencerScheduledFrameGroup, ordinal: number): SequencerFrameSlot {
	const { id, capture, filter } = group
	return { id: sequencerFrameSlotId(id, ordinal), groupId: id, kind: 'scheduled', ordinal, attempt: 1, discardedTotal: 0, discardBudgetUsed: 0, captureFailures: 0, capture, ...(filter !== undefined && { filter }) }
}

// Whether a group is an enabled scheduled group with slots still to be done.
function isPendingScheduledGroup(group: SequencerFrameGroup, progress: SequencerCaptureProgress): group is SequencerScheduledFrameGroup {
	return group.kind === 'scheduled' && group.enabled && completedSlotsOf(progress, group.id) < group.count
}

// Scheduled group of the next slot, updating the cursor or the credits in place; undefined when every scheduled
// group is done or disabled.
function selectScheduledGroup(capture: SequencerCaptureConfiguration, scheduler: SequencerSchedulerState, progress: SequencerCaptureProgress) {
	switch (capture.order) {
		case 'sequential':
			return capture.groups.find((group) => isPendingScheduledGroup(group, progress))
		case 'roundRobin':
			return selectRoundRobin(capture.groups, scheduler, progress)
		case 'weightedRoundRobin':
			return selectWeightedRoundRobin(capture.groups, scheduler, progress)
	}
}

// First pending group after the cursor, in declared order and wrapping; the cursor moves to it. Between two
// selections of a group every other pending group is selected at most once.
function selectRoundRobin(groups: readonly SequencerFrameGroup[], scheduler: SequencerSchedulerState, progress: SequencerCaptureProgress) {
	const n = groups.length
	// An absent (or unknown) cursor starts at the first group.
	const start = scheduler.cursor === undefined ? 0 : groups.findIndex((group) => group.id === scheduler.cursor) + 1

	for (let i = 0; i < n; i++) {
		const group = groups[(start + i) % n]

		if (isPendingScheduledGroup(group, progress)) {
			scheduler.cursor = group.id
			return group
		}
	}

	return undefined
}

// Weighted round robin by Tijdeman's chairman-assignment rule (R. Tijdeman, "The chairman assignment problem",
// Discrete Mathematics 32, 1980), deterministic and without randomness or timestamps. The rotation is the set of
// pending groups; its credits start at zero and are reset whenever the set changes (a group finishes), so the
// guarantees hold within each rotation. With W the sum of the pending weights, a group of weight w that was
// selected n times in k selections of the rotation holds the credit k·w − n·W. Every selection adds each weight to
// its credit; among the groups whose credit reached W/(2m − 2), for m pending groups, it selects the earliest
// deadline (C·W − credit)/w, with C = 1 − 1/(2m − 2) and ties going to the declared order, and subtracts W from the
// selected credit. The theorem bounds every prefix by |n − k·w/W| ≤ C < 1, so no credit grows without bound and the
// gap between two selections of a group is at most 1 + 2C·W/w. A group without weight (never the case for a
// validated configuration) weighs 1.
function selectWeightedRoundRobin(groups: readonly SequencerFrameGroup[], scheduler: SequencerSchedulerState, progress: SequencerCaptureProgress) {
	const pending = groups.filter((group) => isPendingScheduledGroup(group, progress))
	const m = pending.length
	if (m === 0) return undefined

	if (!isCurrentRotation(scheduler.credits, pending)) {
		// `Object.fromEntries` defines own properties, so any group id (even `__proto__`) is a plain key.
		scheduler.credits = Object.fromEntries(pending.map((group) => [group.id, 0]))
	}

	const { credits } = scheduler
	let total = 0

	for (const group of pending) {
		const weight = group.weight ?? 1
		credits[group.id] += weight
		total += weight
	}

	let selected = pending[0]

	if (m > 1) {
		const bound = 1 - 1 / (2 * m - 2)
		const threshold = total / (2 * m - 2)
		let earliest = Infinity
		let largest = selected

		for (const group of pending) {
			const credit = credits[group.id]
			if (credit > credits[largest.id]) largest = group
			if (credit < threshold) continue
			const deadline = (bound * total - credit) / (group.weight ?? 1)

			if (deadline < earliest) {
				earliest = deadline
				selected = group
			}
		}

		// The largest credit is at least W/m ≥ W/(2m − 2), so some group is always eligible; the largest credit stands
		// in only when rounding leaves every credit a few ulps below the threshold.
		if (earliest === Infinity) selected = largest
	}

	credits[selected.id] -= total
	return selected
}

// Whether the credits belong to exactly the pending groups (a rotation that did not change).
function isCurrentRotation(credits: Readonly<Record<string, number>>, pending: readonly SequencerScheduledFrameGroup[]) {
	return Object.keys(credits).length === pending.length && pending.every((group) => Object.hasOwn(credits, group.id))
}
