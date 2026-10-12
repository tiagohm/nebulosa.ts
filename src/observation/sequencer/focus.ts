import { join } from 'path'
import type { FocuserCommander } from '../../devices/commanders/focuser'
import type { WheelCommander } from '../../devices/commanders/wheel'
import type { Focuser, Wheel } from '../../devices/indi/device'
import { failedOperationResult } from '../../devices/orchestration/operation'
import type { CooperativeJobHealth } from '../../devices/orchestration/operation.wait'
import type { CameraCapturer } from '../../devices/runners/camera.capture'
import { type AutoFocusRunOptions, runAutoFocus } from '../focus/autofocus.runner'
import type { GuidingSession } from '../guiding/session'
import { pauseGuidingOf, sequencerClosesOpticalPath } from './guiding'
import { configurationFailure, failedTask, missingDependency } from './lifecycle'
import type { SequencerContext, SequencerFailedTaskResult, SequencerTask, SequencerTaskPolicy, SequencerTaskResult, SequencerTaskView } from './runner'
// oxfmt-ignore
import { DEFAULT_SEQUENCER_COLLABORATOR_ABORT_GRACE, type SequencerAutofocusConfiguration, type SequencerConfiguration, type SequencerConfigurationDiagnostic, type SequencerDevices, type SequencerFilterReference, type SequencerFocusBaseline, type SequencerFocusMeasurer } from './sequencer'
import { bootstrapFocusBaseline, focusBaselineAfterAutofocus, focusBaselineRequiresAutofocus, focusOffsetOf, focusPositionFor, pushSequencerCompensation } from './state'
import type { SequencerStorage } from './storage'
import { autofocusDue, recordSequencerAutofocusSuccess, type SequencerAutofocusObservation, sequencerElapsedSince } from './trigger'

// Filter and focus of the Sequencer: the focus-baseline bootstrap of the startup (`bootstrapFocusBaseline`), the filter
// and absolute focus offset of the pre-capture optical path (`prepareOpticalPath`, section 20.5) and the pre-capture
// autofocus (`autofocus`, sections 20.6 and 22.1), plus the focus part of the runtime preflight. The autofocus loop
// itself is the reusable operation of `observation/focus/autofocus.runner.ts`; this module decides when it runs and
// wires it to the session: the dedicated autofocus filter, the auxiliary namespace of the storage, the session clock,
// the caller's HFD measurer with its cooperative timeout and its health across the session, the compensations of an
// interruption, the focus baseline and the anchors it satisfies.
//
// Focus offsets are absolute, never deltas: the focuser of a filter `F` goes to `referencePosition + offsets[F]` of the
// persisted baseline, a call that is correct before a crash, after it and repeated. The baseline is derived once, from
// the physical wheel slot and focuser position read before anything moved, and afterwards changes only by a successful
// autofocus (`referencePosition = best − offsets[filter focused through]`), saved in the same checkpoint as the
// autofocus anchors. A light is never exposed with an unknown baseline: it requires an autofocus first. The wheel and
// the focuser are never commanded in parallel, and the filter is read from the wheel, never from the state.
//
// Conventions: focuser positions in steps, wheel slots 0-based, temperatures in °C, configured durations in seconds
// turned into milliseconds only at the clock. Nothing here allocates per frame beyond the task results and, for an
// autofocus, its observation and services.

// Services of the focus tasks; a task whose dependency is absent fails with a 'configuration' failure before
// commanding anything.
export interface SequencerFocusServices {
	// Moves of the filter wheel.
	readonly wheelCommander?: WheelCommander
	// Moves of the focuser.
	readonly focuserCommander?: FocuserCommander
	// Auxiliary captures of the autofocus.
	readonly cameraCapturer?: CameraCapturer
	// HFD measurer of the autofocus frames.
	readonly focusMeasurer?: SequencerFocusMeasurer
	// Auxiliary namespace of the session.
	readonly storage?: Pick<SequencerStorage, 'auxiliaryDirectory'>
	// Guiding session paused before the wheel closes the optical path of a calibration frame.
	readonly guiding?: GuidingSession
}

// 0-based slot of a filter reference on `wheel`: a slot inside the carousel, or the first slot named exactly so.
// Undefined when it does not resolve, which fails before any movement.
export function resolveSequencerFilter(wheel: Pick<Wheel, 'count' | 'names'>, reference: SequencerFilterReference) {
	const slot = reference.kind === 'slot' ? reference.slot : wheel.names.indexOf(reference.name)
	return slot >= 0 && slot < wheel.count ? slot : undefined
}

// Name of the filter the wheel stands on, read from its physical slot; undefined without a wheel, while it is
// disconnected or moving, or on an unnamed slot.
export function sequencerPhysicalFilter(wheel: Wheel | undefined) {
	if (wheel === undefined || !wheel.connected || wheel.moving) return undefined
	return filterNameAt(wheel, wheel.position)
}

// Baseline of a session that never inspected the wheel and the focuser.
const UNSET_BASELINE: SequencerFocusBaseline = { kind: 'unset' }

// Focus part of the runtime preflight (sections 41.2 and 41.3), against the resolved, connected devices and the
// persisted baseline (`unset` for a new session). It never commands anything. Every problem is returned as a
// diagnostic of the configuration path it concerns:
// - every filter of an enabled group, the opaque filter of a 'filter' optical path and the dedicated autofocus filter
//   resolve on the wheel; the dedicated autofocus filter is never an opaque slot;
// - an autofocus has a focuser;
// - focus offsets need a focuser that moves to absolute positions, a wheel naming the reference filter, and a known
//   offset for the filter of every enabled LIGHT group and for the dedicated autofocus filter;
// - with focus offsets, no autofocus and an enabled LIGHT group, an unset baseline whose wheel stands on a filter
//   without a known offset could never be focused (the early diagnostic of the bootstrap, which stays authoritative).
export function preflightSequencerFocus(configuration: Pick<SequencerConfiguration, 'capture' | 'autofocus'>, devices: Pick<SequencerDevices, 'wheel' | 'focuser'>, baseline: SequencerFocusBaseline = UNSET_BASELINE): SequencerConfigurationDiagnostic[] {
	const { capture, autofocus } = configuration
	const { focusOffsets } = capture
	const { wheel, focuser } = devices
	const diagnostics: SequencerConfigurationDiagnostic[] = []
	const report = (path: string, message: string) => diagnostics.push({ path, message })

	const resolve = (reference: SequencerFilterReference, path: string) => {
		if (wheel === undefined) {
			report(path, 'requires a filter wheel')
			return undefined
		}

		const slot = resolveSequencerFilter(wheel, reference)
		if (slot === undefined) report(path, `${describeFilter(reference)} is not a filter of ${wheel.name}`)
		return slot
	}

	const requireOffset = (slot: number | undefined, path: string) => {
		if (focusOffsets === undefined || wheel === undefined || slot === undefined) return
		const name = filterNameAt(wheel, slot)
		if (focusOffsetOf(focusOffsets, name) === undefined) report(path, `filter ${name ?? `slot ${slot}`} has no known focus offset`)
	}

	const opaque = new Set<number>()

	for (const [i, group] of capture.groups.entries()) {
		if (!group.enabled) continue

		const at = `capture.groups[${i}]`
		const slot = group.filter === undefined ? undefined : resolve(group.filter, `${at}.filter`)
		if (group.capture.frameType === 'LIGHT') requireOffset(slot, `${at}.filter`)

		if (group.kind === 'triggered' && group.opticalPath.kind === 'filter') {
			const closed = resolve(group.opticalPath.filter, `${at}.opticalPath.filter`)
			if (closed !== undefined) opaque.add(closed)
		}
	}

	if (autofocus !== undefined) {
		if (focuser === undefined) report('autofocus', 'requires a focuser')

		if (autofocus.filter !== undefined) {
			const slot = resolve(autofocus.filter, 'autofocus.filter')
			if (slot !== undefined && opaque.has(slot)) report('autofocus.filter', 'is the opaque filter of a calibration optical path')
			requireOffset(slot, 'autofocus.filter')
		}
	}

	if (focusOffsets !== undefined) {
		if (focuser === undefined || !focuser.canAbsoluteMove) report('capture.focusOffsets', 'requires a focuser that moves to absolute positions')

		if (wheel === undefined) report('capture.focusOffsets', 'requires a filter wheel')
		else if (resolveSequencerFilter(wheel, { kind: 'name', name: focusOffsets.reference }) === undefined) report('capture.focusOffsets.reference', `is not a filter of ${wheel.name}`)

		if (autofocus === undefined && baseline.kind === 'unset' && hasLightGroup(configuration)) {
			const physical = sequencerPhysicalFilter(wheel)
			if (focusOffsetOf(focusOffsets, physical) === undefined) report('capture.focusOffsets', unknownBaselineMessage(physical))
		}
	}

	return diagnostics
}

// Startup task `bootstrapFocusBaseline` (section 20.5), first of the startup lifecycle and before anything moves the
// wheel or the focuser, only with focus offsets and an `unset` baseline: reads the physical wheel slot, then the focuser
// position, commanding nothing, derives `known` (the wheel stands on a filter with a known offset, presumed in focus) or
// `unknown`, and saves the checkpoint before the first move, so an `unset` checkpoint proves the wheel never moved. An
// `unknown` baseline without autofocus and with an enabled LIGHT group is a 'configuration' failure and is not saved: a
// later process derives again from where the wheel then stands. A moving or disconnected wheel or focuser fails the
// task, which the startup policy applies.
export function bootstrapFocusBaselineTask(): SequencerTask {
	return {
		id: 'bootstrapFocusBaseline',
		shouldRun: ({ configuration, state }) => configuration.capture.focusOffsets !== undefined && state.focus.kind === 'unset',
		run: async (context) => {
			const { configuration, devices, state } = context
			const { focusOffsets } = configuration.capture
			const { wheel, focuser } = devices
			if (focusOffsets === undefined) return DONE
			if (focuser === undefined) return missingDependency('focuser')

			let filter: string | undefined

			if (wheel !== undefined) {
				const unready = unreadyFailure(wheel)
				if (unready !== undefined) return unready
				filter = filterNameAt(wheel, wheel.position)
			}

			const unready = unreadyFailure(focuser)
			if (unready !== undefined) return unready

			const baseline = bootstrapFocusBaseline(state.focus, focusOffsets, filter, focuser.position.value)
			if (baseline.kind === 'unknown' && configuration.autofocus === undefined && hasLightGroup(configuration)) return configurationFailure(unknownBaselineMessage(filter))

			state.focus = baseline
			const saved = await context.saveCheckpoint()
			if (!saved.ok) state.focus = { kind: 'unset' }
			return saved
		},
	}
}

// Pre-capture task `prepareOpticalPath` (sections 20.2A and 20.5), before the pointing: moves the wheel to the filter of
// the frame (a group without a filter leaves the wheel where it is; a calibration frame of a 'filter' optical path has
// its opaque filter), then, for a LIGHT frame with focus offsets and a `known` baseline, the focuser to
// `referencePosition + offsets[filter]`. With an `unknown` baseline the focuser is not commanded (the autofocus decides),
// and darks and biases never apply a focus offset. Every check runs before anything moves: an unresolvable filter or a
// light filter without a known offset fails with 'configuration', a focus position outside the focuser range with
// 'unexpectedState'. A wheel or focuser already in place is not commanded; the task runs only when something must
// move or a check fails. Before the wheel moves to the opaque filter of a calibration frame, the guiding of the session
// is paused (bounded by `guiding.pauseTimeout`). Its failure fails the session.
export function prepareOpticalPathTask(services: SequencerFocusServices): SequencerTask {
	return {
		id: 'prepareOpticalPath',
		shouldRun: (view) => {
			if (view.frame === undefined) return false
			const planned = opticalPathPlan(view)
			if (!planned.ok) return true
			const { slot, focuserPosition } = planned.plan
			return (slot !== undefined && !isWheelAt(view.devices.wheel!, slot)) || (focuserPosition !== undefined && !isFocuserAt(view.devices.focuser!, focuserPosition))
		},
		run: async (context) => {
			const planned = opticalPathPlan(context)
			if (!planned.ok) return planned

			const { slot, focuserPosition } = planned.plan
			const { wheel, focuser } = context.devices
			const { wheelCommander, focuserCommander } = services
			const moveWheel = slot !== undefined && !isWheelAt(wheel!, slot)
			if (moveWheel && wheelCommander === undefined) return missingDependency('wheel commander')
			if (focuserPosition !== undefined && focuserCommander === undefined) return missingDependency('focuser commander')

			if (moveWheel && sequencerClosesOpticalPath(context.configuration, context.frame!)) {
				const paused = await pauseGuidingOf(context, services.guiding)
				if (!paused.ok) return paused
			}

			if (moveWheel) {
				const moved = await wheelCommander!.moveTo(context.scope, wheel!, slot)
				if (!moved.ok) return failedTask(moved)
			}

			if (focuserPosition !== undefined && !isFocuserAt(focuser!, focuserPosition)) {
				const moved = await focuserCommander!.moveTo(context.scope, focuser!, focuserPosition)
				if (!moved.ok) return failedTask(moved)
			}

			return DONE
		},
	}
}

// Whether an autofocus is due before the frame of `view` (section 20.6): only for a LIGHT frame of a session with
// autofocus, when the focus baseline is unknown (`focusBaselineUnknown`, which no anchor suppresses) or any configured
// trigger is due by `autofocusDue`, observed on the physical filter, the focuser temperature and the monotonic time
// since the last success. Darks and biases never focus. Pure over the view.
export function sequencerAutofocusDue(view: SequencerTaskView) {
	const { configuration, state, frame } = view
	const { autofocus } = configuration
	if (autofocus === undefined || frame?.capture.frameType !== 'LIGHT') return false
	if (focusBaselineRequiresAutofocus(state.focus, 'LIGHT')) return true
	return autofocusDue(autofocus.triggers, state.anchors, state.intents, autofocusObservation(view))
}

// Options of one autofocus run of the session: the configured algorithm, capture and measurement timeout, with the
// default abort grace and auxiliary disposition.
export function sequencerAutofocusOptions(autofocus: SequencerAutofocusConfiguration): AutoFocusRunOptions {
	const { algorithm, capture, measureTimeout } = autofocus
	return { algorithm, capture, measureTimeout, abortGrace: autofocus.abortGrace ?? DEFAULT_SEQUENCER_COLLABORATOR_ABORT_GRACE, auxiliary: autofocus.auxiliary ?? 'delete' }
}

// Pre-capture task `autofocus` (sections 20.6 and 22.1), after the rotation: at most one autofocus per safe point. Before
// the focuser moves it registers the compensation of the starting position; with a dedicated filter it also registers the
// frame slot, moves the wheel to that filter and, with a known baseline, the focuser to its focus offset (an unknown
// baseline starts where the focuser is). After a successful run the baseline becomes `best − offsets[filter focused
// through]`, every autofocus trigger advances and the intent is cleared, all in one checkpoint, after which the focuser
// compensation is removed; with a dedicated filter the frame filter and its focus are then restored absolutely. A
// failure that is not a cancellation restores the frame filter and the starting position by itself before the failure
// policy (`autofocus.onFailure` after `autofocus.retry`) applies; a cancellation leaves both to the compensations the
// runner runs after the quiescence. A failed restore (its compensations left for the runner) and a failure that leaves
// the baseline unknown are fatal for the safe point: never skipped, since no light may be exposed from there. The HFD
// measurer of the task is faulted for the rest of the session once a measurement outlived its abort grace.
export function autofocusTask(services: SequencerFocusServices, autofocus: SequencerAutofocusConfiguration): SequencerTask {
	const measurer = { faulted: false }

	return {
		id: 'autofocus',
		shouldRun: sequencerAutofocusDue,
		run: (context) => runSequencerAutofocus(context, services, autofocus, measurer),
		policy: taskPolicy(autofocus),
	}
}

const DONE: SequencerTaskResult = { ok: true }

// Retry and failure action of the autofocus configuration.
function taskPolicy(autofocus: Pick<SequencerAutofocusConfiguration, 'retry' | 'onFailure'>): SequencerTaskPolicy {
	return autofocus.retry === undefined ? { onFailure: autofocus.onFailure } : { retry: autofocus.retry, onFailure: autofocus.onFailure }
}

// Where the optical path of a frame must stand: the wheel slot of its filter and, for a LIGHT frame with focus offsets
// and a known baseline, the absolute focuser position of that filter.
interface OpticalPathPlan {
	// 0-based wheel slot of the frame filter; undefined leaves the wheel where it is.
	readonly slot?: number
	// Absolute focuser position, in steps, inside the focuser range; undefined leaves the focuser where it is.
	readonly focuserPosition?: number
}

// Optical path of the frame of `view`, every check made before anything moves; reads the physical state, never
// commands.
function opticalPathPlan(view: SequencerTaskView): { readonly ok: true; readonly plan: OpticalPathPlan } | SequencerFailedTaskResult {
	const { configuration, devices, state, frame } = view
	const { wheel, focuser } = devices
	const { focusOffsets } = configuration.capture
	let slot: number | undefined

	if (frame?.filter !== undefined) {
		if (wheel === undefined) return missingDependency('filter wheel')
		if (!wheel.connected) return failedTask(failedOperationResult('disconnected', `wheel ${wheel.name} is disconnected`))
		slot = resolveSequencerFilter(wheel, frame.filter)
		if (slot === undefined) return configurationFailure(`${describeFilter(frame.filter)} is not a filter of ${wheel.name}`)
	}

	if (focusOffsets === undefined || frame?.capture.frameType !== 'LIGHT') return { ok: true, plan: { slot } }

	const filter = slot === undefined ? sequencerPhysicalFilter(wheel) : filterNameAt(wheel!, slot)
	if (focusOffsetOf(focusOffsets, filter) === undefined) return configurationFailure(`the light filter ${filter ?? 'in place'} has no known focus offset`)
	if (state.focus.kind === 'unset') return failedTask(failedOperationResult('unexpectedState', 'the focus baseline was never bootstrapped'))

	// An unknown baseline commands nothing: the autofocus of the frame establishes it.
	const focuserPosition = focusPositionFor(state.focus, focusOffsets, filter)
	if (focuserPosition === undefined) return { ok: true, plan: { slot } }
	if (focuser === undefined) return missingDependency('focuser')

	const outside = outsideRange(focuser, focuserPosition)
	if (outside !== undefined) return outside

	return { ok: true, plan: { slot, focuserPosition } }
}

// Autofocus of the frame of `context` (see `autofocusTask`).
async function runSequencerAutofocus(context: SequencerContext, services: SequencerFocusServices, autofocus: SequencerAutofocusConfiguration, measurer: { faulted: boolean }): Promise<SequencerTaskResult> {
	const { configuration, devices, state, clock, frame } = context
	const { focuser, wheel, camera } = devices
	const { focuserCommander, wheelCommander, cameraCapturer, focusMeasurer, storage } = services
	const { focusOffsets } = configuration.capture
	if (focuser === undefined) return missingDependency('focuser')
	if (focuserCommander === undefined) return missingDependency('focuser commander')
	if (cameraCapturer === undefined) return missingDependency('camera capturer')
	if (focusMeasurer === undefined) return missingDependency('focus measurer')
	if (storage?.auxiliaryDirectory === undefined) return configurationFailure('the storage provides no auxiliary namespace for the autofocus frames')

	const focuserUnready = unreadyFailure(focuser)
	if (focuserUnready !== undefined) return focuserUnready

	// The dedicated filter is resolved, and the frame filter the optical path left in place read, before anything moves.
	let dedicated: number | undefined

	if (autofocus.filter !== undefined) {
		if (wheel === undefined) return missingDependency('filter wheel')
		if (wheelCommander === undefined) return missingDependency('wheel commander')
		const wheelUnready = unreadyFailure(wheel)
		if (wheelUnready !== undefined) return wheelUnready
		dedicated = resolveSequencerFilter(wheel, autofocus.filter)
		if (dedicated === undefined) return configurationFailure(`${describeFilter(autofocus.filter)} is not a filter of ${wheel.name}`)
	}

	const frameSlot = wheel?.position
	const frameFilter = sequencerPhysicalFilter(wheel)

	const directory = await storage.auxiliaryDirectory('autofocus', autofocus.auxiliary ?? 'delete')
	if (!directory.ok) return directory

	const initialPosition = focuser.position.value
	const removeFocuserCompensation = pushSequencerCompensation(state, { kind: 'focuserPosition', task: 'autofocus', position: initialPosition })
	let removeWheelCompensation: VoidFunction | undefined
	let focusFilter = frameFilter

	// A failure that is not a cancellation restores the frame filter and the starting position here, and a failed restore
	// keeps the compensations for the runner; a cancellation leaves them to the compensations, after the quiescence.
	const abandon = async (failed: SequencerFailedTaskResult): Promise<SequencerFailedTaskResult> => {
		if (context.signal.aborted) return failed

		const restored = await restoreOpticalTrain(context, focuserCommander, wheelCommander, removeWheelCompensation === undefined ? undefined : frameSlot, initialPosition)
		if (restored !== undefined) return context.signal.aborted ? failed : { ...restored, fatal: true }

		removeWheelCompensation?.()
		removeFocuserCompensation()
		return state.focus.kind === 'unknown' ? { ...failed, fatal: true } : failed
	}

	if (dedicated !== undefined && dedicated !== frameSlot) {
		removeWheelCompensation = pushSequencerCompensation(state, { kind: 'wheelSlot', task: 'autofocus', slot: frameSlot! })
		const moved = await wheelCommander!.moveTo(context.scope, wheel!, dedicated)
		if (!moved.ok) return await abandon(failedTask(moved))

		focusFilter = filterNameAt(wheel!, dedicated)

		// A known baseline starts the run at the focus of the dedicated filter; an unknown one where the focuser stands.
		const start = focusOffsets === undefined ? undefined : focusPositionFor(state.focus, focusOffsets, focusFilter)

		if (start !== undefined && !isFocuserAt(focuser, start)) {
			const outside = outsideRange(focuser, start)
			if (outside !== undefined) return await abandon(outside)
			const focused = await focuserCommander.moveTo(context.scope, focuser, start)
			if (!focused.ok) return await abandon(failedTask(focused))
		}
	}

	const run = Bun.randomUUIDv7()
	const measurerHealth: CooperativeJobHealth = {
		faulted: measurer.faulted,
		onUnresponsive: () => {
			state.waitingFor = 'focusMeasurer'
			context.emit({ type: 'collaboratorUnresponsive', service: 'hfd', ...(frame !== undefined && { slot: frame.id, attempt: frame.attempt }) })
		},
		onFaulted: () => {
			measurer.faulted = true
			if (state.waitingFor === 'focusMeasurer') state.waitingFor = undefined
		},
	}

	const focused = await runAutoFocus(context.scope, focuser, camera, sequencerAutofocusOptions(autofocus), { focuserCommander, cameraCapturer, measurer: focusMeasurer, auxiliaryPath: (capture) => join(directory.value, `${run}.${capture}.fit`), clock, measurerHealth })
	if (!focused.ok) return await abandon(failedTask(focused))

	if (focusOffsets !== undefined) {
		const baseline = focusBaselineAfterAutofocus(focusOffsets, focusFilter, focused.value.position)
		if (baseline === undefined) return await abandon(configurationFailure(`the autofocus filter ${focusFilter ?? 'in place'} has no known focus offset`))
		state.focus = baseline
	}

	// Baseline and anchors in one checkpoint, before the frame filter is restored: a crash in between is resolved by the
	// absolute reconciliation of the next pre-capture with the new baseline.
	recordSequencerAutofocusSuccess(state, frameFilter, focuserTemperature(focuser), clock.wallNow(), clock.monotonicNow())
	const saved = await context.saveCheckpoint()
	if (!saved.ok) return saved
	removeFocuserCompensation()

	if (removeWheelCompensation === undefined) return DONE

	const back = await wheelCommander!.moveTo(context.scope, wheel!, frameSlot!)
	if (!back.ok) return fatalUnlessCancelled(context, failedTask(back))
	removeWheelCompensation()

	const position = focusOffsets === undefined ? undefined : focusPositionFor(state.focus, focusOffsets, frameFilter)

	if (position !== undefined && !isFocuserAt(focuser, position)) {
		const outside = outsideRange(focuser, position)
		if (outside !== undefined) return fatalUnlessCancelled(context, outside)
		const refocused = await focuserCommander.moveTo(context.scope, focuser, position)
		if (!refocused.ok) return fatalUnlessCancelled(context, failedTask(refocused))
	}

	return DONE
}

// Moves the wheel back to `slot` (when given) and then the focuser to `position` (steps), each only when not there
// already; resolves the first failure, or undefined once both stand in place.
async function restoreOpticalTrain(context: SequencerContext, focuserCommander: FocuserCommander, wheelCommander: WheelCommander | undefined, slot: number | undefined, position: number): Promise<SequencerFailedTaskResult | undefined> {
	const { wheel, focuser } = context.devices

	if (slot !== undefined && wheel !== undefined && wheelCommander !== undefined && !isWheelAt(wheel, slot)) {
		const moved = await wheelCommander.moveTo(context.scope, wheel, slot)
		if (!moved.ok) return restoreFailure(failedTask(moved))
	}

	if (focuser !== undefined && !isFocuserAt(focuser, position)) {
		const moved = await focuserCommander.moveTo(context.scope, focuser, position)
		if (!moved.ok) return restoreFailure(failedTask(moved))
	}

	return undefined
}

// Failure of a restore, with its detail naming the restore.
function restoreFailure(failed: SequencerFailedTaskResult): SequencerFailedTaskResult {
	const { failure } = failed
	return failure.kind === 'operation' ? { ok: false, failure: { ...failure, detail: `restore of the optical train: ${failure.detail ?? failure.reason}` } } : failed
}

// A failure after the new baseline was saved, while restoring the frame filter: fatal for the safe point, unless the
// task was cancelled (the compensations and the next pre-capture take over).
function fatalUnlessCancelled(context: SequencerContext, failed: SequencerFailedTaskResult): SequencerFailedTaskResult {
	return context.signal.aborted ? failed : { ...restoreFailure(failed), fatal: true }
}

// Physical facts the autofocus triggers read for the frame of `view`.
function autofocusObservation(view: SequencerTaskView): SequencerAutofocusObservation {
	const { devices, state, clock } = view
	return { filter: sequencerPhysicalFilter(devices.wheel), temperature: focuserTemperature(devices.focuser), elapsed: sequencerElapsedSince(state, 'autofocus', clock.monotonicNow()), resumed: state.resumedSinceAutofocus, flipped: state.flippedSinceAutofocus }
}

// Temperature the focuser publishes, in °C; undefined without a focuser, while disconnected or without a thermometer.
function focuserTemperature(focuser: Focuser | undefined) {
	return focuser !== undefined && focuser.connected && focuser.hasThermometer ? focuser.temperature : undefined
}

// Name of the filter of a wheel slot; undefined for an unnamed slot.
function filterNameAt(wheel: Pick<Wheel, 'names'>, slot: number) {
	const name = wheel.names[slot]
	return name === undefined || name === '' ? undefined : name
}

// Whether a connected wheel stands still on `slot`.
function isWheelAt(wheel: Wheel, slot: number) {
	return wheel.connected && !wheel.moving && wheel.position === slot
}

// Whether a connected focuser stands still at `position` (steps).
function isFocuserAt(focuser: Focuser, position: number) {
	return focuser.connected && !focuser.moving && focuser.position.value === position
}

// Failure of a focus position outside the published range of the focuser, or undefined inside it.
function outsideRange(focuser: Focuser, position: number) {
	const { min, max } = focuser.position
	if (position >= min && position <= max) return undefined
	return failedTask(failedOperationResult('unexpectedState', `focus position ${position} is outside the range [${min}, ${max}] of ${focuser.name}`))
}

// Failure of a wheel or focuser that cannot be read or commanded now: disconnected or moving.
function unreadyFailure(device: Wheel | Focuser) {
	if (!device.connected) return failedTask(failedOperationResult('disconnected', `${device.type} ${device.name} is disconnected`))
	if (device.moving) return failedTask(failedOperationResult('unexpectedState', `${device.type} ${device.name} is moving`))
	return undefined
}

// Whether an enabled group exposes LIGHT frames.
function hasLightGroup(configuration: Pick<SequencerConfiguration, 'capture'>) {
	return configuration.capture.groups.some((group) => group.enabled && group.capture.frameType === 'LIGHT')
}

// Diagnostic of a baseline that only an autofocus could establish.
function unknownBaselineMessage(filter: string | undefined) {
	return `focus baseline unknown: the wheel stands on ${filter === undefined ? 'a filter' : `filter ${filter}`} without a focus offset; configure autofocus or move the wheel to a calibrated filter`
}

// Human-readable filter reference.
function describeFilter(reference: SequencerFilterReference) {
	return reference.kind === 'slot' ? `slot ${reference.slot}` : `filter ${reference.name}`
}
