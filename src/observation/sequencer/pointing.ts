import { join } from 'path'
import { timeUnix } from '../../astronomy/time/time'
import { DEG2RAD } from '../../core/constants'
import type { MountCommander, MountCommandOptions } from '../../devices/commanders/mount'
import type { RotatorCommander } from '../../devices/commanders/rotator'
import type { Rotator } from '../../devices/indi/device'
import { failedOperationResult } from '../../devices/orchestration/operation'
import type { CameraCapturer } from '../../devices/runners/camera.capture'
import { type Angle, normalizePI, toDeg } from '../../math/units/angle'
import { centerTarget, type CenteringOptions, type CenteringServices } from '../mount/centering'
import { configurationFailure, failedTask, missingDependency, reconcileTracking } from './lifecycle'
import type { SequencerContext, SequencerFailedTaskResult, SequencerTask, SequencerTaskPolicy, SequencerTaskResult, SequencerTaskView } from './runner'
// oxfmt-ignore
import { DEFAULT_SEQUENCER_COLLABORATOR_ABORT_GRACE, DEFAULT_SEQUENCER_MERIDIAN_FLIP, type SequencerCenteringConfiguration, type SequencerConfiguration, type SequencerPlateSolver, type SequencerPointingConfiguration, type SequencerRotatorConfiguration, type SequencerTarget } from './sequencer'
import type { SequencerStorage } from './storage'
import { recenterDue, recordSequencerActionSuccess, sequencerElapsedSince } from './trigger'

// Pointing tasks of the Sequencer pre-capture: target acquisition and recenter (`acquireOrRecenterTarget`, section
// 20.3) and field rotation (`rotateField`, section 20.4), for LIGHT frames only. The centering algorithm itself is the
// reusable operation of `observation/mount/centering.ts`; this module decides when it runs and wires it to the
// session: the auxiliary namespace of the storage, the session clock, the caller's plate solver with its cooperative
// timeout and its health across the session, and the anchors and intents it satisfies.
//
// The first acquisition slews to the J2000 target converted at the wall instant of the session clock, reconciles
// tracking on a fresh observation (`reconcileTracking`, never presuming tracking from the slew), settles and centers.
// Still in the meridian zone after the slew, tracking stays off, nothing is captured and the target counts as
// acquired, with a recenter left requested. A recenter only centers (no initial slew), on a tracking mount; without
// centering configured it slews to the target again. A success clears the recenter intent and advances the recenter
// anchor, persisted at once. The target is never assumed acquired after a restart: `targetAcquired` is runtime-only.
//
// Conventions: angles in radians (degrees only at the rotator commander), configured durations in seconds turned into
// milliseconds at the clock or a commander, wall instants in Unix ms. Pausing guiding around mount motion belongs to
// the guiding stage.

// Services of the pointing tasks; a task whose dependency is absent fails with a 'configuration' failure before
// commanding anything.
export interface SequencerPointingServices {
	// Slews, sync and tracking of the mount.
	readonly mountCommander?: MountCommander
	// Auxiliary captures of the centering.
	readonly cameraCapturer?: CameraCapturer
	// Plate solver of the centering.
	readonly plateSolver?: SequencerPlateSolver
	// Auxiliary namespace of the session.
	readonly storage?: Pick<SequencerStorage, 'auxiliaryDirectory'>
	// Field rotation.
	readonly rotatorCommander?: RotatorCommander
}

// Options of every mount command the pointing supervises: with a meridian flip, the settle of a stopped slew is bounded
// by the hard-protection `mountStopTimeout` (ms), the same bound the protection lead assumes; otherwise the commander
// default applies.
export function sequencerMountCommandOptions(configuration: Pick<SequencerConfiguration, 'meridianFlip'>): Pick<MountCommandOptions, 'settleTimeout'> {
	const { meridianFlip } = configuration
	if (meridianFlip?.enabled !== true) return {}
	return { settleTimeout: (meridianFlip.hardProtection?.mountStopTimeout ?? DEFAULT_SEQUENCER_MERIDIAN_FLIP.hardProtection.mountStopTimeout) * 1000 }
}

// Centering options of the session: the configured bounds, the default abort grace and auxiliary disposition, and the
// supervised slew options.
export function sequencerCenteringOptions(centering: SequencerCenteringConfiguration, configuration: Pick<SequencerConfiguration, 'meridianFlip'>): CenteringOptions {
	const { tolerance, maximumAttempts, settle, syncMount, capture, solveTimeout } = centering
	const abortGrace = centering.abortGrace ?? DEFAULT_SEQUENCER_COLLABORATOR_ABORT_GRACE
	return { tolerance, maximumAttempts, settle, syncMount, capture, solveTimeout, abortGrace, auxiliary: centering.auxiliary ?? 'delete', slew: sequencerMountCommandOptions(configuration) }
}

// Whether the pointing of a frame is due: a LIGHT frame of a session with a target and pointing, whose target is not
// acquired in this process, whose recenter is requested, or whose periodic recenter is due. Darks and biases never
// point. Pure over the view.
export function sequencerPointingDue(view: SequencerTaskView) {
	const { configuration, state, frame, clock } = view
	const { target, pointing } = configuration
	if (target === undefined || pointing === undefined || frame?.capture.frameType !== 'LIGHT') return false
	if (!state.targetAcquired || state.intents.recenter) return true
	return recenterDue(pointing.recenter, state.anchors, sequencerElapsedSince(state, 'recenter', clock.monotonicNow()))
}

// Pre-capture task `acquireOrRecenterTarget` (section 20.3) of a session with a target and pointing. Its failure
// applies `pointing.onFailure` after `pointing.retry`; a LIGHT is never exposed before its target was verified. The
// plate solver of the task is faulted for the rest of the session once a solve outlived its abort grace.
export function acquireOrRecenterTargetTask(services: SequencerPointingServices, pointing: SequencerPointingConfiguration): SequencerTask {
	const solver = { faulted: false }

	return {
		id: 'acquireOrRecenterTarget',
		shouldRun: sequencerPointingDue,
		run: (context) => acquireOrRecenterTarget(context, services, pointing, solver),
		policy: taskPolicy(pointing),
	}
}

// Pre-capture task `rotateField` (section 20.4), after pointing and before autofocus, for LIGHT frames whose rotator is
// farther than `rotator.tolerance` (wrapped) from `rotator.angle`: rotates through the commander (degrees, mapped into
// the driver range) with an arrival tolerance of `rotator.tolerance`, then settles `rotator.settle` seconds. Its
// failure applies `rotator.onFailure` after `rotator.retry`.
export function rotateFieldTask(services: SequencerPointingServices, rotator: SequencerRotatorConfiguration): SequencerTask {
	return {
		id: 'rotateField',
		shouldRun: ({ devices, frame }) => frame?.capture.frameType === 'LIGHT' && (devices.rotator === undefined || !devices.rotator.connected || devices.rotator.moving || !isRotatorAt(devices.rotator, rotator.angle, rotator.tolerance)),
		run: async (context) => {
			const { rotatorCommander } = services
			const device = context.devices.rotator
			if (device === undefined) return missingDependency('rotator')
			if (rotatorCommander === undefined) return missingDependency('rotator commander')

			const moved = await rotatorCommander.moveTo(context.scope, device, toDeg(rotator.angle), { arrivalTolerance: toDeg(rotator.tolerance) })
			if (!moved.ok) return failedTask(moved)

			const settled = await context.clock.delay(rotator.settle * 1000, context.signal)
			return settled.ok ? DONE : failedTask(settled)
		},
		policy: taskPolicy(rotator),
	}
}

// Pointing tasks of the pre-capture in their fixed order (section 42), only the configured ones: target acquisition
// or recenter (with a target and pointing), then field rotation.
export function sequencerPointingTasks(configuration: Pick<SequencerConfiguration, 'target' | 'pointing' | 'rotator'>, services: SequencerPointingServices): SequencerTask[] {
	const { target, pointing, rotator } = configuration
	const tasks: SequencerTask[] = []

	if (target !== undefined && pointing !== undefined) tasks.push(acquireOrRecenterTargetTask(services, pointing))
	if (rotator !== undefined) tasks.push(rotateFieldTask(services, rotator))

	return tasks
}

// Whether the rotator stands within `tolerance` (radians, wrapped) of `angle` (radians).
function isRotatorAt(rotator: Rotator, angle: Angle, tolerance: Angle) {
	return Math.abs(normalizePI(rotator.angle.value * DEG2RAD - angle)) <= tolerance
}

const DONE: SequencerTaskResult = { ok: true }

// Retry and failure action of a feature configuration.
function taskPolicy(feature: Pick<SequencerPointingConfiguration, 'retry' | 'onFailure'>): SequencerTaskPolicy {
	return feature.retry === undefined ? { onFailure: feature.onFailure } : { retry: feature.retry, onFailure: feature.onFailure }
}

// Acquisition or recenter of the target of the session (see `acquireOrRecenterTargetTask`).
async function acquireOrRecenterTarget(context: SequencerContext, services: SequencerPointingServices, pointing: SequencerPointingConfiguration, solver: { faulted: boolean }): Promise<SequencerTaskResult> {
	const { configuration, devices, state, clock } = context
	const { mountCommander } = services
	const { mount, camera } = devices
	const { target } = configuration
	if (target === undefined) return configurationFailure('pointing requires a target')
	if (mount === undefined) return missingDependency('mount')
	if (mountCommander === undefined) return missingDependency('mount commander')

	// Every dependency of the centering is resolved before the mount moves.
	const centeringConfiguration = pointing.centering
	let centering: CenteringServices | undefined

	if (centeringConfiguration !== undefined) {
		const resolved = await centeringServicesOf(context, mountCommander, services, centeringConfiguration, solver)
		if (!resolved.ok) return resolved
		centering = resolved.value
	}

	const acquiring = !state.targetAcquired

	if (acquiring || centering === undefined) {
		const slewed = await mountCommander.goTo(context.scope, mount, j2000(target), { ...sequencerMountCommandOptions(configuration), time: timeUnix(clock.wallNow() / 1000) })
		if (!slewed.ok) return failedTask(slewed)

		// The arrival never proves tracking: it is reconciled on a fresh observation after every slew of the acquisition.
		const tracking = await reconcileTracking(context, mountCommander)
		if (!tracking.ok) return tracking

		if (!mount.tracking) {
			// Still in the meridian zone: no centering with tracking off. The target counts as acquired so the re-entry
			// decides by the flip, and the unverified pointing stays requested for a later recenter.
			state.targetAcquired = true
			state.intents.recenter = true
			return await context.saveCheckpoint()
		}

		const settled = await clock.delay(pointing.settle * 1000, context.signal)
		if (!settled.ok) return failedTask(settled)
	} else if (!mount.tracking) {
		return failedTask(failedOperationResult('unexpectedState', `mount ${mount.name} does not track; the target cannot be recentered`))
	}

	if (centeringConfiguration !== undefined && centering !== undefined) {
		const centered = await centerTarget(context.scope, mount, camera, { frame: 'J2000', rightAscension: target.rightAscension, declination: target.declination }, sequencerCenteringOptions(centeringConfiguration, configuration), centering)
		if (!centered.ok) return failedTask(centered)
	}

	state.targetAcquired = true
	state.intents.recenter = false
	recordSequencerActionSuccess(state, 'recenter', clock.wallNow(), clock.monotonicNow())
	return await context.saveCheckpoint()
}

// Services of one centering of the session: the capturer and the solver, a fresh name per centering in the auxiliary
// directory of the storage (never a slot identity), the session clock, and the solver health, whose watchdog reports
// `collaboratorUnresponsive` and the snapshot `waitingFor: 'plateSolver'` until the late solve ended and the solver is
// faulted for the rest of the session.
async function centeringServicesOf(context: SequencerContext, mountCommander: MountCommander, services: SequencerPointingServices, centering: SequencerCenteringConfiguration, solver: { faulted: boolean }): Promise<{ readonly ok: true; readonly value: CenteringServices } | SequencerFailedTaskResult> {
	const { cameraCapturer, plateSolver, storage } = services
	if (cameraCapturer === undefined) return missingDependency('camera capturer')
	if (plateSolver === undefined) return missingDependency('plate solver')
	if (storage?.auxiliaryDirectory === undefined) return configurationFailure('the storage provides no auxiliary namespace for the centering frames')

	const directory = await storage.auxiliaryDirectory('centering', centering.auxiliary ?? 'delete')
	if (!directory.ok) return directory

	const { state, frame, clock } = context
	const run = Bun.randomUUIDv7()

	return {
		ok: true,
		value: {
			mountCommander,
			cameraCapturer,
			solver: plateSolver,
			auxiliaryPath: (attempt) => join(directory.value, `${run}.${attempt}.fit`),
			clock,
			solverHealth: {
				faulted: solver.faulted,
				onUnresponsive: () => {
					state.waitingFor = 'plateSolver'
					context.emit({ type: 'collaboratorUnresponsive', service: 'solve', ...(frame !== undefined && { slot: frame.id, attempt: frame.attempt }) })
				},
				onFaulted: () => {
					solver.faulted = true
					if (state.waitingFor === 'plateSolver') state.waitingFor = undefined
				},
			},
		},
	}
}

// J2000 mount target of the session target.
function j2000(target: SequencerTarget) {
	return { type: 'J2000' as const, J2000: { x: target.rightAscension, y: target.declination } }
}
