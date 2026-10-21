import { join } from 'path'
import { hourAngle } from '../../astronomy/events/hourangle'
import { localSiderealTime } from '../../astronomy/observer/location'
import { timeUnix } from '../../astronomy/time/time'
import { DEG2RAD, PIOVERTWO, SIDEREAL_DRIFT_RATE } from '../../core/constants'
import type { GuideOutputCommander } from '../../devices/commanders/guideoutput'
import type { MountCommander, MountCommandOptions } from '../../devices/commanders/mount'
import type { RotatorCommander } from '../../devices/commanders/rotator'
import type { Device, GuideOutput, Mount, MountTargetCoordinate, PierSide, Rotator, TrackMode } from '../../devices/indi/device'
import type { DeviceHandler } from '../../devices/indi/manager/device'
import { type MountManager, mountTargetEquatorial } from '../../devices/indi/manager/mount'
import { isDeviceQuiescent } from '../../devices/orchestration/device.lifecycle'
import { type FailedOperationResult, failedOperationResult, type OperationContext, type OperationResult, successfulOperationResult } from '../../devices/orchestration/operation'
import { type ResourceKey, resourceKey } from '../../devices/orchestration/resource'
import { type Angle, normalizeAngle, normalizePI, toDeg } from '../../math/units/angle'
import type { CameraCapturer } from '../capture/capture'
import { type Ditherer, MountDitherer, type MountMovementResource } from '../guiding/ditherer'
import type { GuidingSession } from '../guiding/session'
import { centerTarget, type CenteringOptions, type CenteringServices } from '../mount/centering'
import { createMeridianFlipState, evaluateMeridianFlip, type MeridianFlipPolicy, type MeridianFlipStatePhase, transitionMeridianFlip } from '../mount/meridian.flip'
import { awaitAtMost, pauseGuidingOf, pauseSequencerGuiding } from './guiding'
import { configurationFailure, failedTask, isSequencerMountOffTarget, missingDependency, reconcileTracking, sequencerFrameHourAngleSpan, sequencerStartupTrackMode } from './lifecycle'
// oxfmt-ignore
import type { SequencerContext, SequencerFailedTaskResult, SequencerProtectionOutcome, SequencerShutdownTask, SequencerSupervisor, SequencerSupervisorHost, SequencerTask, SequencerTaskPolicy, SequencerTaskResult, SequencerTaskView, SequencerTrackingProtection } from './runner'
// oxfmt-ignore
import { DEFAULT_SEQUENCER_COLLABORATOR_ABORT_GRACE, DEFAULT_SEQUENCER_MERIDIAN_FLIP, type SequencerCenteringConfiguration, type SequencerConfiguration, type SequencerConfigurationDiagnostic, type SequencerDevices, type SequencerFailureAction, type SequencerMeridianFlipConfiguration, type SequencerMeridianProtectionFailure, type SequencerPlateSolver, type SequencerPointingConfiguration, type SequencerRotatorConfiguration, type SequencerTarget, type SequencerTaskId } from './sequencer'
import { exposureTimeInSeconds } from '../capture/types'
import { advanceSequencerMeridianFlip, isWithinSequencerMeridianCycle, SEQUENCER_MERIDIAN_HALF_CYCLE, type SequencerRuntimeState, sequencerMeridianTransitAt, toMeridianFlipPolicy } from './state'
import type { SequencerStorage } from './storage'
import { holdSequencerDither, recenterDue, recordSequencerActionSuccess, sequencerElapsedSince } from './trigger'

// Pointing tasks of the Sequencer pre-capture: target acquisition and recenter (`acquireOrRecenterTarget`, section
// 20.3) and field rotation (`rotateField`, section 20.4), for LIGHT frames only. The centering algorithm itself is the
// reusable operation of `observation/mount/centering.ts`; this module decides when it runs and wires it to the
// session: the auxiliary namespace of the storage, the session clock, the caller's plate solver with its cooperative
// timeout and its health across the session, and the anchors and intents it satisfies.
//
// It is also the application driver of the meridian flip of section 24: the pre-capture task `meridianFlip` drives the
// pure state machine of `observation/mount/meridian.flip.ts` (no hour-angle arithmetic of its own beyond the deadlines),
// the final exposure guard of section 20.9 (`finalExposureGuard`, repeated synchronously right before the dispatch) and
// the limit supervisor of sections 24.4 and 24.5 (`SequencerMeridianSupervisor`), armed by the runner at step 0b and
// active until the tracking off of the shutdown. The supervisor only asks the runner for a graceful protection at a
// safe point, except for the hard path: when the physical hour angle of a pre-flip tracking mount reaches
// `latestAt − hardProtectionLead`, it turns tracking off itself as a critical root (`protectMountTracking`).
//
// The physical hour angle is the published local sidereal time (apparent, at the published longitude) minus the
// published equinox-of-date right ascension, in one observation; it measures mechanical risk. The decision hour angle of
// the flip is the one of the target (J2000 converted at the wall instant of the session clock by `mountTargetEquatorial`,
// the same conversion the mount is commanded with), or the larger of both once the target was acquired, or the
// physical one without a target. Every rate comes from `SIDEREAL_DRIFT_RATE`; deadlines are wall instants and every
// wait is a monotonic `clock.delay`.
//
// The first acquisition slews to the J2000 target converted at the wall instant of the session clock, reconciles
// tracking on a fresh observation (`reconcileTracking`, never presuming tracking from the slew), settles and centers.
// Still in the meridian zone after the slew, tracking stays off, nothing is captured and the target counts as
// acquired, with a recenter left requested. A recenter only centers (no initial slew), on a tracking mount; without
// centering configured it slews to the target again. A success clears the recenter intent and advances the recenter
// anchor, persisted at once. The target is never assumed acquired after a restart: `targetAcquired` is runtime-only.
//
// Conventions: angles in radians (degrees only at the rotator commander), configured durations in seconds turned into
// milliseconds at the clock or a commander, wall instants in Unix ms.
//
// Every mount motion of the acquisition (slew, corrective slews and syncs of the centering) happens only after the
// guiding session of the session paused and proved its pulses ended; the guiding resumes and settles later, in
// `ensureGuiding`. A motion also postpones the next due dither past the next light.

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
	// Guiding session paused before every mount motion; absent or without guiding configured nothing is paused.
	readonly guiding?: GuidingSession
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

	// The mount moves only once guiding is paused and its pulses ended; a failed pause moves nothing.
	const paused = await pauseGuidingOf(context, services.guiding)
	if (!paused.ok) return paused
	holdSequencerDither(state)

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

	// The recenter a meridian flip of the session waits for is done.
	const flip = configuration.meridianFlip
	if (flip?.enabled === true && state.meridianFlip.phase === 'RECENTERING') {
		const completed = advanceSequencerMeridianFlip(state, toMeridianFlipPolicy(flip, configuration), { type: 'RECENTER_COMPLETED' })
		if (completed !== undefined) context.emit(completed)
	}

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

// Meridian flip of a session with every optional field resolved from `DEFAULT_SEQUENCER_MERIDIAN_FLIP`. Hour angles in
// radians in (−π, π]; durations in seconds.
export interface SequencerMeridianFlipSettings {
	// Hour angle where the preparation warning begins.
	readonly prepareAt: Angle
	// First hour angle at which the flip may start.
	readonly flipAt: Angle
	// Last hour angle at which the flip may start with tracking on, on the pre-flip side.
	readonly latestAt: Angle
	// Pier side before the flip.
	readonly beforeFlipPierSide: PierSide
	// Pier side after the flip.
	readonly afterFlipPierSide: PierSide
	// Wait for a NEITHER pier side to resolve.
	readonly pierSideTimeout: number
	// Flip retries after the first started flip; a durable budget.
	readonly maxRetries: number
	// Time the guard adds to an exposure.
	readonly exposureMargin: number
	// Advance of the graceful deadline before `latestAt`.
	readonly protectionMargin: number
	// Longest sleep of the supervisor between re-evaluations.
	readonly supervisionInterval: number
	// Timeout of the flip command and watchdog of a supervised flip slew.
	readonly flipTimeout: number
	// Graceful protection while paused.
	readonly whilePaused: 'flip' | 'stopTracking'
	// Session action once the flip or a protection failed.
	readonly onFailure: SequencerFailureAction
	// Settle timeout of every supervised mount command.
	readonly mountStopTimeout: number
	// Wait for a guiding stop when the guiding pause failed.
	readonly guidingStopTimeout: number
	// Timeout of the protective tracking off.
	readonly trackingTimeout: number
}

// Resolves the optional fields of a meridian flip configuration from `DEFAULT_SEQUENCER_MERIDIAN_FLIP`, the only source
// of their defaults. A fresh object.
export function sequencerMeridianFlipSettings(flip: SequencerMeridianFlipConfiguration): SequencerMeridianFlipSettings {
	const defaults = DEFAULT_SEQUENCER_MERIDIAN_FLIP
	const hard = flip.hardProtection

	return {
		prepareAt: flip.prepareAt,
		flipAt: flip.flipAt,
		latestAt: flip.latestAt,
		beforeFlipPierSide: flip.beforeFlipPierSide,
		afterFlipPierSide: flip.afterFlipPierSide,
		pierSideTimeout: flip.pierSideTimeout ?? defaults.pierSideTimeout,
		maxRetries: flip.maxRetries ?? defaults.maxRetries,
		exposureMargin: flip.exposureMargin ?? defaults.exposureMargin,
		protectionMargin: flip.protectionMargin ?? defaults.protectionMargin,
		supervisionInterval: flip.supervisionInterval ?? defaults.supervisionInterval,
		flipTimeout: flip.flipTimeout ?? defaults.flipTimeout,
		whilePaused: flip.whilePaused ?? defaults.whilePaused,
		onFailure: flip.onFailure ?? defaults.onFailure,
		mountStopTimeout: hard?.mountStopTimeout ?? defaults.hardProtection.mountStopTimeout,
		guidingStopTimeout: hard?.guidingStopTimeout ?? defaults.hardProtection.guidingStopTimeout,
		trackingTimeout: hard?.trackingTimeout ?? defaults.hardProtection.trackingTimeout,
	}
}

// Fixed allowance, in ms, for the delay of a supervisor timer plus the longest synchronous stretch the event loop may run
// (`supervisionJitter` of the hard protection lead, section 24.5). A wake later than this is reported `supervisionLate`.
export const SEQUENCER_SUPERVISION_JITTER = 1000

// Iterations of the evaluate → effect → transition loop of one `meridianFlip` task; more is a logic bug.
const MERIDIAN_FLIP_DRIVER_ITERATIONS = 16

// Remaining time, in ms, under which a deadline counts as reached: two evaluations of the sidereal time differ by about a
// microsecond of floating-point noise, which must never leave a vanishing wait behind instead of protecting.
const DEADLINE_RESOLUTION = 0.01

// Poll interval, in ms, of the motion quiescence of step 2b, bounded by its deadline.
const MOTION_QUIESCENCE_POLL_INTERVAL = 50

// Mount motion of the roots of one built-in task (section 24.5): the resource keys whose lease can move the mount, kept
// in the motion owners of the runner while a root lives, and the worst case, in ms, between the cancellation of the root
// and the release of the lease of the mount or of those keys.
export interface SequencerMountMotion {
	// Mount or movement keys; empty for a task that leases the mount without moving it (tracking, track mode).
	readonly keys: readonly ResourceKey[]
	// Release bound after a cancellation, in ms.
	readonly releaseBound: number
}

// Inputs of the motion table of a session.
export interface SequencerMountMotionBounds {
	// Resource key of the mount; absent without a mount.
	readonly mount?: ResourceKey
	// Settle, in ms, of a stopped mount motion: passed explicitly to every supervised mount command.
	readonly mountSettle: number
	// What a mount ditherer of the session may move (`MountDitherer.movement(mountSettle)`); empty otherwise.
	readonly ditherMovement: readonly MountMovementResource[]
}

// Motion table of the built-in tasks (`mountKeyHolders`, section 24.5), the single source of the keys recorded in the
// motion owners and of the release bound of the hard protection: unpark, park, meridian flip and target acquisition
// lease and move the mount, released within `mountSettle`; a mount ditherer moves what its `movement` declares, released
// within its bounds; tracking and track mode lease the mount without moving it and release it at once; every other
// task leases neither the mount nor a movement key (no other device of the session shares the hardware of the mount
// under hard protection). Undefined for those, or without a mount. The switch is exhaustive over the task ids.
export function mountKeyHolders(task: SequencerTaskId, bounds: SequencerMountMotionBounds): SequencerMountMotion | undefined {
	switch (task) {
		case 'unparkMount':
		case 'parkMount':
		case 'meridianFlip':
		case 'acquireOrRecenterTarget':
			return bounds.mount === undefined ? undefined : { keys: [bounds.mount], releaseBound: bounds.mountSettle }
		case 'ditherAndSettle': {
			const { ditherMovement } = bounds
			if (ditherMovement.length === 0) return undefined
			let releaseBound = 0
			for (const movement of ditherMovement) releaseBound = Math.max(releaseBound, movement.releaseBound)
			return { keys: ditherMovement.map((movement) => movement.request.key), releaseBound }
		}
		case 'configureTracking':
		case 'ensureTracking':
		case 'stopTracking':
		case 'protectMeridianWhilePaused':
		case 'protectMeridianDuringStartup':
			return bounds.mount === undefined ? undefined : { keys: [], releaseBound: 0 }
		case 'bootstrapFocusBaseline':
		case 'quiesceGuiding':
		case 'quiesceDitherPulses':
		case 'coolCamera':
		case 'safetyGate':
		case 'openDome':
		case 'openCover':
		case 'awaitCameraRecovery':
		case 'prepareOpticalPath':
		case 'rotateField':
		case 'autofocus':
		case 'ensureGuiding':
		case 'awaitDarkTemperature':
		case 'prepareFrameDestination':
		case 'finalExposureGuard':
		case 'captureFrame':
		case 'pauseGuiding':
		case 'stopGuiding':
		case 'closeCover':
		case 'closeOrParkDome':
		case 'turnOffFlatPanel':
		case 'warmCamera':
			return undefined
		default: {
			const unknown: never = task
			throw new RangeError(`unknown sequencer task ${String(unknown)}`)
		}
	}
}

// Motion bounds of a session: the mount key, the supervised settle (`hardProtection.mountStopTimeout` with a meridian
// flip, `shutdown.stepTimeout` otherwise, in ms) and the movement of a mount ditherer of the dither feature.
export function sequencerMountMotionBounds(configuration: Pick<SequencerConfiguration, 'meridianFlip' | 'shutdown' | 'dither'>, devices: Pick<SequencerDevices, 'mount'>, ditherer: Ditherer | undefined): SequencerMountMotionBounds {
	const flip = configuration.meridianFlip?.enabled === true ? sequencerMeridianFlipSettings(configuration.meridianFlip) : undefined
	const mountSettle = (flip?.mountStopTimeout ?? configuration.shutdown.stepTimeout) * 1000
	const ditherMovement = configuration.dither !== undefined && ditherer instanceof MountDitherer ? ditherer.movement(mountSettle) : []
	return { ...(devices.mount !== undefined && { mount: resourceKey(devices.mount) }), mountSettle, ditherMovement }
}

// Built-in tasks the configuration enables that may hold the mount or a movement key, in the order of section 42.
export function sequencerMountMotionTasks(configuration: SequencerConfiguration, ditherer: Ditherer | undefined): SequencerTaskId[] {
	const { startup, shutdown, target, pointing, dither } = configuration
	const flip = configuration.meridianFlip?.enabled === true
	const tasks: SequencerTaskId[] = []

	if (startup.mount?.unpark === true) tasks.push('unparkMount')
	if (sequencerStartupTrackMode(configuration) !== undefined) tasks.push('configureTracking')
	if (flip) tasks.push('meridianFlip', 'protectMeridianWhilePaused', 'protectMeridianDuringStartup')
	if (target !== undefined || flip) tasks.push('ensureTracking')
	if (target !== undefined && pointing !== undefined) tasks.push('acquireOrRecenterTarget')
	if (dither !== undefined && ditherer instanceof MountDitherer) tasks.push('ditherAndSettle')
	if (shutdown.stopTracking !== undefined) tasks.push('stopTracking')
	if (shutdown.parkMount !== undefined) tasks.push('parkMount')

	return tasks
}

// Timings of the tracking protection prefix (`protectMountTracking`: 2a guiding pause, 2b motion release, 2c tracking
// off), resolved once by `mountTrackingProtectionTimings` and used by all its callers. Every value in ms.
export interface SequencerMountTrackingProtectionTimings {
	// Bound of the guiding pause, `guiding.pauseTimeout`; 0 without guiding.
	readonly pause: number
	// Wait for a guiding stop after a failed pause: `hardProtection.guidingStopTimeout` with a meridian flip,
	// `shutdown.stepTimeout` otherwise; 0 without guiding.
	readonly guidingStop: number
	// Settle of a stopped mount motion.
	readonly mountSettle: number
	// Timeout of the tracking off: `hardProtection.trackingTimeout` with a meridian flip, `shutdown.stepTimeout` otherwise.
	readonly tracking: number
	// Worst case of step 2a, `pause + guidingStop`; 0 without guiding.
	readonly guidingBound: number
	// Worst case of step 2b, the largest release bound of the enabled tasks; 0 without a mount.
	readonly mountMotionReleaseBound: number
	// Worst case of step 2c; 0 without a mount.
	readonly trackingBound: number
	// Task whose release bound dominates step 2b.
	readonly dominantTask?: SequencerTaskId
	// `guidingBound + mountMotionReleaseBound + trackingBound`.
	readonly bound: number
}

// Resolves the timings of the tracking protection of a session (section 24.5) from its configuration, its mount and its
// guiding session and ditherer. Without a meridian flip the step timeout of the shutdown bounds the stop of guiding, the
// settle of the mount and the tracking off. Pure.
export function mountTrackingProtectionTimings(configuration: SequencerConfiguration, devices: Pick<SequencerDevices, 'mount'>, services: { readonly guiding?: GuidingSession; readonly ditherer?: Ditherer }): SequencerMountTrackingProtectionTimings {
	const flip = configuration.meridianFlip?.enabled === true ? sequencerMeridianFlipSettings(configuration.meridianFlip) : undefined
	const { stepTimeout } = configuration.shutdown
	const guiding = services.guiding === undefined ? undefined : configuration.guiding
	const pause = guiding === undefined ? 0 : guiding.pauseTimeout * 1000
	const guidingStop = guiding === undefined ? 0 : (flip?.guidingStopTimeout ?? stepTimeout) * 1000
	const tracking = (flip?.trackingTimeout ?? stepTimeout) * 1000
	const bounds = sequencerMountMotionBounds(configuration, devices, services.ditherer)
	let mountMotionReleaseBound = 0
	let dominantTask: SequencerTaskId | undefined

	if (devices.mount !== undefined) {
		for (const task of sequencerMountMotionTasks(configuration, services.ditherer)) {
			const motion = mountKeyHolders(task, bounds)

			if (motion !== undefined && (dominantTask === undefined || motion.releaseBound > mountMotionReleaseBound)) {
				mountMotionReleaseBound = motion.releaseBound
				dominantTask = task
			}
		}
	}

	const guidingBound = pause + guidingStop
	const trackingBound = devices.mount === undefined ? 0 : tracking

	return { pause, guidingStop, mountSettle: bounds.mountSettle, tracking, guidingBound, mountMotionReleaseBound, trackingBound, ...(dominantTask !== undefined && { dominantTask }), bound: guidingBound + mountMotionReleaseBound + trackingBound }
}

// Hard protection lead of section 24.5 and its parts, in ms: each part is the bound the protection itself waits.
export interface SequencerHardProtectionLead {
	// Delay of a supervisor timer plus the longest synchronous stretch of the event loop.
	readonly supervisionJitter: number
	// Step 2a.
	readonly guidingBound: number
	// Step 2b.
	readonly mountMotionReleaseBound: number
	// Step 2c.
	readonly trackingTimeout: number
	// Task whose release bound dominates step 2b.
	readonly dominantTask?: SequencerTaskId
	// Sum of the parts.
	readonly lead: number
}

// Hard protection lead (`meridianHardProtectionLead`): `supervisionJitter + guidingBound + mountMotionReleaseBound +
// trackingTimeout`, from the timings of the tracking protection. Pure.
export function meridianHardProtectionLead(timings: SequencerMountTrackingProtectionTimings): SequencerHardProtectionLead {
	const { guidingBound, mountMotionReleaseBound, trackingBound, dominantTask } = timings
	return { supervisionJitter: SEQUENCER_SUPERVISION_JITTER, guidingBound, mountMotionReleaseBound, trackingTimeout: trackingBound, ...(dominantTask !== undefined && { dominantTask }), lead: SEQUENCER_SUPERVISION_JITTER + timings.bound }
}

// One observation of the mount for the meridian decisions of a safe point or a supervisor evaluation, at one wall
// instant. Hour angles in radians in (−π, π].
export interface SequencerMeridianObservation {
	// Wall instant of the observation, in Unix ms.
	readonly at: number
	// Apparent local sidereal time at the published longitude; undefined without a published site.
	readonly localSiderealTime?: Angle
	// Published pier side.
	readonly pierSide: PierSide
	// Whether the mount tracks.
	readonly tracking: boolean
	// Published track mode.
	readonly trackMode: TrackMode
	// Whether the mount tracks at the sidereal rate (SIDEREAL, or no published track modes).
	readonly sidereal: boolean
	// Physical hour angle: local sidereal time minus the published equinox-of-date right ascension.
	readonly mountHourAngle?: Angle
	// Hour angle of the target, its J2000 coordinate converted at `at` as the mount is commanded.
	readonly targetHourAngle?: Angle
	// Telemetry the deadlines need that the mount does not publish.
	readonly missing: readonly ('geographicCoordinate' | 'equatorialCoordinate')[]
}

// Whether a mount tracks at the sidereal rate: it reports SIDEREAL, or publishes no track mode (documented as sidereal).
export function isSiderealTrackMode(mount: Pick<Mount, 'trackModes' | 'trackMode'>) {
	return mount.trackModes.length === 0 || mount.trackMode === 'SIDEREAL'
}

// Observes `mount` at the wall instant `wallNow` (Unix ms, UTC): the apparent local sidereal time at the published
// longitude, the physical hour angle from the published equinox-of-date right ascension, and the hour angle of `target`
// converted by `mountTargetEquatorial` at the same instant. Reads the device only.
export function observeSequencerMeridian(mount: Mount, target: SequencerTarget | undefined, wallNow: number): SequencerMeridianObservation {
	const time = timeUnix(wallNow / 1000)
	const missing: ('geographicCoordinate' | 'equatorialCoordinate')[] = []
	if (!mount.hasGeographicCoordinate) missing.push('geographicCoordinate')
	if (!mount.hasEquatorialCoordinate) missing.push('equatorialCoordinate')

	const lst = mount.hasGeographicCoordinate ? localSiderealTime(time, mount.geographicCoordinate.longitude) : undefined
	const mountHourAngle = lst !== undefined && mount.hasEquatorialCoordinate ? hourAngle(lst, mount.equatorialCoordinate.rightAscension) : undefined
	const targetHourAngle = lst !== undefined && target !== undefined ? hourAngle(lst, mountTargetEquatorial(mount, j2000(target), time)[0]) : undefined

	return {
		at: wallNow,
		...(lst !== undefined && { localSiderealTime: lst }),
		pierSide: mount.pierSide,
		tracking: mount.connected && mount.tracking,
		trackMode: mount.trackMode,
		sidereal: isSiderealTrackMode(mount),
		...(mountHourAngle !== undefined && { mountHourAngle }),
		...(targetHourAngle !== undefined && { targetHourAngle }),
		missing,
	}
}

// Decision hour angle of the flip (section 24.1), radians: the physical one without a target, the one of the target
// while it is not acquired in this process, and the larger of both once acquired (near the pole the mount may lag or
// lead the target). Undefined when a needed hour angle is not observed. Pure.
export function sequencerDecisionHourAngle(observation: Pick<SequencerMeridianObservation, 'mountHourAngle' | 'targetHourAngle'>, hasTarget: boolean, targetAcquired: boolean): Angle | undefined {
	const { mountHourAngle, targetHourAngle } = observation
	if (!hasTarget) return mountHourAngle
	if (!targetAcquired || mountHourAngle === undefined || targetHourAngle === undefined) return targetHourAngle
	return Math.max(targetHourAngle, mountHourAngle)
}

// Wall instant (Unix ms) at which the physical hour angle of `observation` reaches `latestAt − leadMs × sidereal rate`:
// `at + (latestAt − lead − hourAngle) / SIDEREAL_DRIFT_RATE`, already past when not in the future. Undefined when there
// is no risk: tracking off, or the post-flip side observed (NEITHER counts as pre-flip). `hourAngle` may be unwrapped
// beyond π within an epoch. The graceful deadline uses `protectionMargin`, the hard one `hardProtectionLead`. Pure.
export function meridianProtectionDeadline(flip: Pick<SequencerMeridianFlipSettings, 'latestAt' | 'afterFlipPierSide'>, observation: { readonly at: number; readonly hourAngle: Angle; readonly pierSide: PierSide; readonly tracking: boolean }, leadMs: number) {
	if (!observation.tracking || observation.pierSide === flip.afterFlipPierSide) return undefined
	return observation.at + ((flip.latestAt - observation.hourAngle) / SIDEREAL_DRIFT_RATE) * 1000 - leadMs
}

// Decision of the meridian limit of the final exposure guard (section 20.9):
// - expose: the exposure fits;
// - wait: no exposure now; wait `ms` (monotonic) until the flip is due, then re-enter;
// - reenter: no exposure; re-enter the pre-capture at once (flip due, pier side unknown, mount off target).
export type SequencerMeridianGuardDecision = { readonly kind: 'expose' } | { readonly kind: 'wait'; readonly ms: number; readonly reason: string } | { readonly kind: 'reenter'; readonly reason: string }

// Inputs of the meridian limit of the guard.
export interface SequencerMeridianGuardInput {
	// Pier side observed at the guard.
	readonly pierSide: PierSide
	// Decision hour angle at the guard, radians in (−π, π].
	readonly decisionHourAngle: Angle
	// Physical hour angle, checked as well while the mount is off its target.
	readonly mountHourAngle?: Angle
	// Whether the target is not acquired, so the physical hour angle must fit too.
	readonly offTarget: boolean
	// Exposure time, in seconds.
	readonly exposure: number
}

const EXPOSE: SequencerMeridianGuardDecision = { kind: 'expose' }

// Meridian limit of the final guard (section 20.9): on the observed post-flip side the thresholds no longer apply;
// NEITHER re-enters; on the pre-flip side `HA_end = HA₀ + (T + exposureMargin) × SIDEREAL_DRIFT_RATE` must stay before
// the graceful deadline `B = latestAt − protectionMargin × SIDEREAL_DRIFT_RATE` (strictly: `HA_end = B` refuses), for the
// physical hour angle as well while the mount is off its target. A frame that does not fit waits until `flipAt` when the
// flip is not due yet (a finite wait, since the preflight keeps `flipAt ≤ B`), or re-enters at once to flip. A mount off
// target in the zone re-enters, so the flip task stops its tracking. Pure.
export function sequencerMeridianGuard(settings: Pick<SequencerMeridianFlipSettings, 'flipAt' | 'latestAt' | 'afterFlipPierSide' | 'exposureMargin' | 'protectionMargin'>, input: SequencerMeridianGuardInput): SequencerMeridianGuardDecision {
	if (input.pierSide === settings.afterFlipPierSide) return EXPOSE
	if (input.pierSide === 'NEITHER') return { kind: 'reenter', reason: 'the pier side of the mount is not known' }

	const span = (input.exposure + settings.exposureMargin) * SIDEREAL_DRIFT_RATE
	const deadline = settings.latestAt - settings.protectionMargin * SIDEREAL_DRIFT_RATE
	const fits = input.decisionHourAngle + span < deadline
	const mountFits = !input.offTarget || input.mountHourAngle === undefined || input.mountHourAngle + span < deadline

	if (fits && mountFits) return EXPOSE
	if (fits) return { kind: 'reenter', reason: 'the mount is off its target in the meridian zone' }
	if (input.decisionHourAngle < settings.flipAt) return { kind: 'wait', ms: ((settings.flipAt - input.decisionHourAngle) / SIDEREAL_DRIFT_RATE) * 1000, reason: 'the exposure crosses the meridian limit before the flip is due' }
	return { kind: 'reenter', reason: 'the meridian flip is due' }
}

// Decision of the final exposure guard over a view: the meridian limit, or the end of the single meridian cycle of the
// session.
export type SequencerExposureGuardDecision = SequencerMeridianGuardDecision | { readonly kind: 'cycleExceeded'; readonly meridianTransitAt: number; readonly wallNow: number }

// Phases of a flip whose recovery is still pending: no LIGHT is exposed in them.
const FLIP_RECOVERY_PHASES = new Set<MeridianFlipStatePhase>(['FLIPPING', 'VERIFYING_PIER_SIDE', 'RECENTERING', 'SETTLING'])

// Final exposure guard of section 20.9 over the live view of a frame, for a session with a target or a meridian flip:
// outside the meridian cycle nothing is exposed; a LIGHT needs tracking with the SIDEREAL mode observed and no pending
// flip recovery; with a meridian flip and a tracking mount, a non-sidereal mode re-enters and the meridian limit
// (`sequencerMeridianGuard`) applies to the decision hour angle at the wall instant of the session clock. A frame of a
// session without a target or a flip, and a dark with tracking off, are exposed. Reads the devices; synchronous.
export function sequencerExposureGuard(view: SequencerTaskView): SequencerExposureGuardDecision {
	const { configuration, devices, state, frame, clock } = view
	const { mount } = devices
	const { target, meridianFlip } = configuration
	const flip = meridianFlip?.enabled === true ? meridianFlip : undefined
	if (frame === undefined || mount === undefined || (target === undefined && flip === undefined)) return EXPOSE

	const wallNow = clock.wallNow()
	if (flip !== undefined && state.meridianTransitAt !== undefined && !isWithinSequencerMeridianCycle(state.meridianTransitAt, wallNow)) return { kind: 'cycleExceeded', meridianTransitAt: state.meridianTransitAt, wallNow }

	const light = frame.capture.frameType === 'LIGHT'
	if (light && !(mount.connected && mount.tracking && isSiderealTrackMode(mount))) return { kind: 'reenter', reason: 'tracking with the SIDEREAL mode is not observed' }
	if (flip === undefined || !mount.connected || !mount.tracking) return EXPOSE
	if (!isSiderealTrackMode(mount)) return { kind: 'reenter', reason: `the mount tracks at ${mount.trackMode}` }
	if (light && FLIP_RECOVERY_PHASES.has(state.meridianFlip.phase)) return { kind: 'reenter', reason: `the meridian flip is still ${state.meridianFlip.phase}` }

	const observation = observeSequencerMeridian(mount, target, wallNow)
	const decisionHourAngle = sequencerDecisionHourAngle(observation, target !== undefined, state.targetAcquired)
	if (decisionHourAngle === undefined) return { kind: 'reenter', reason: 'the mount publishes no site or position' }

	const { exposureTime, exposureTimeUnit } = frame.capture
	const offTarget = target !== undefined && !state.targetAcquired
	return sequencerMeridianGuard(sequencerMeridianFlipSettings(flip), { pierSide: observation.pierSide, decisionHourAngle, ...(observation.mountHourAngle !== undefined && { mountHourAngle: observation.mountHourAngle }), offTarget, exposure: exposureTimeInSeconds(exposureTime, exposureTimeUnit) })
}

// The guard repeated synchronously by `beforeExposure`, right before the dispatch: why the exposure must not go now, or
// undefined. A wait is a refusal too: the pre-capture re-enters and waits there.
export function sequencerExposureRefusal(view: SequencerTaskView) {
	const decision = sequencerExposureGuard(view)
	if (decision.kind === 'expose') return undefined
	if (decision.kind === 'cycleExceeded') return 'the session left its meridian cycle'
	return decision.reason
}

// Pre-capture task `finalExposureGuard` (section 20.9), the last one, after the frame destination, for a session with a
// target or a meridian flip: exposes, re-enters (after the wait until the flip is due) or, outside the meridian cycle,
// fails the session with `meridianCycleExceeded`. It never commands anything; the runner closes the prepared attempt
// with `deferred` before a wait or a re-entry, which count against the re-entry limit.
export function finalExposureGuardTask(): SequencerTask {
	return {
		id: 'finalExposureGuard',
		shouldRun: ({ frame, devices, configuration }) => frame !== undefined && devices.mount !== undefined && (configuration.target !== undefined || configuration.meridianFlip?.enabled === true),
		run: (context) => Promise.resolve(finalExposureGuard(context)),
	}
}

// Result of the final guard over the context of its task.
function finalExposureGuard(context: SequencerContext): SequencerTaskResult {
	const decision = sequencerExposureGuard(context)

	switch (decision.kind) {
		case 'expose':
			return DONE
		case 'wait':
			return { ok: true, reenter: { reason: decision.reason, wait: decision.ms } }
		case 'reenter':
			return { ok: true, reenter: { reason: decision.reason } }
		case 'cycleExceeded':
			context.emit({ type: 'meridianCycleExceeded', meridianTransitAt: decision.meridianTransitAt, wallNow: decision.wallNow })
			return { ...configurationFailure('meridianCycleExceeded: the session left its single meridian cycle'), fatal: true }
	}
}

// Subscription to the changes of a mount (any field, or its removal); returns the unsubscription.
export type SequencerMountUpdates = (mount: Mount, listener: VoidFunction) => VoidFunction

// Mount changes as the mount manager publishes them.
export function mountManagerUpdates(manager: MountManager): SequencerMountUpdates {
	return (mount, listener) => {
		const handler: DeviceHandler<Mount> = {
			added: () => {},
			updated: (device) => {
				if (device === mount) listener()
			},
			removed: (device) => {
				if (device === mount) listener()
			},
		}

		manager.addHandler(handler)
		return () => manager.removeHandler(handler)
	}
}

// Services of the meridian flip, its supervision and its protections.
export interface SequencerMeridianServices {
	// Flip, tracking and motion stop of the mount.
	readonly mountCommander?: MountCommander
	// Guiding paused before the flip and by every protection.
	readonly guiding?: GuidingSession
	// Ditherer whose movement the hard protection waits for.
	readonly ditherer?: Ditherer
	// Evidence of the end of the pulses of a pulse mount ditherer.
	readonly guideOutputCommander?: GuideOutputCommander
	// Changes of the mount; default the handlers of the mount manager of the commander.
	readonly mountUpdates?: SequencerMountUpdates
}

// What the tracking protection reads of the session it protects: its live view, its orchestration core and the living
// roots of its run that may move the mount.
export type SequencerTrackingProtectionHost = Pick<SequencerSupervisorHost, 'view' | 'motionOwners' | 'coordinator'>

// Tracking protection prefix of section 24.5 (`protectMountTracking`: 2a guiding pause, 2b motion release, 2c tracking
// off) of one session, with the timings of `mountTrackingProtectionTimings` resolved once. Its three callers share it:
// the hard meridian path of the supervisor, the safety critical protection of the runner (section 32.4), which needs no
// meridian flip, and the shutdown, whose steps `pauseGuiding` and `stopTracking` are no-ops while the tracking off of a
// clean prefix holds (`shutdownStep`). Every caller runs it as a critical root, single-flight through the runner.
export class SequencerMountTrackingProtection implements SequencerTrackingProtection {
	// Timings of the prefix.
	readonly timings: SequencerMountTrackingProtectionTimings
	// Motion bounds of the session.
	readonly bounds: SequencerMountMotionBounds
	// Whether the last prefix ended clean and tracking was not observed on since (the meridian supervisor clears it when it
	// observes tracking), so the shutdown steps of the prefix have nothing left to do.
	trackingProtected = false

	constructor(
		configuration: SequencerConfiguration,
		devices: Pick<SequencerDevices, 'mount'>,
		readonly services: SequencerMeridianServices,
	) {
		this.timings = mountTrackingProtectionTimings(configuration, devices, services)
		this.bounds = sequencerMountMotionBounds(configuration, devices, services.ditherer)
	}

	// Wraps a shutdown step of the prefix (`pauseGuiding`, `stopTracking`): it is a no-op while `trackingProtected`.
	shutdownStep(step: SequencerShutdownTask): SequencerShutdownTask {
		return { ...step, shouldRun: (view) => !this.trackingProtected && step.shouldRun(view) }
	}

	// Runs the prefix inside `context` for the session of `host`: 2a pauses the guiding within `pause` (a failure stops it
	// within `guidingStop` and goes on), 2b waits for the release of the mount by every root of the run and of the movement
	// keys by their motion owners, stopping at once a motion nobody of the run owns, then for the quiescence of the mount
	// and of the movement guide outputs, all within `mountMotionReleaseBound`, and 2c turns tracking off within `tracking`,
	// always attempted. Without a mount only 2a runs. Then tracking counts as stopped by the protection, the target as not
	// acquired, and `trackingProtected` holds when nothing failed. Resolves the first failure of the steps (`cause` first),
	// undefined when clean, with the physical hour angle at the end.
	async protect(context: OperationContext, host: SequencerTrackingProtectionHost, cause?: SequencerMeridianProtectionFailure): Promise<{ readonly failure?: SequencerMeridianProtectionFailure; readonly hourAngle?: Angle }> {
		const { configuration, devices, state, clock } = host.view()
		const { guiding, mountCommander } = this.services
		const failures: SequencerMeridianProtectionFailure[] = cause === undefined ? [] : [cause]

		if (configuration.guiding !== undefined && guiding !== undefined) {
			const paused = await pauseSequencerGuiding(context, guiding, this.timings.pause / 1000, clock)

			if (!paused.ok) {
				await awaitAtMost(guiding.stop(context), this.timings.guidingStop, clock)
				failures.push('guidingNotQuiescent')
			}

			// Tracking stopped under the guide star: the next light starts guiding again, never from the old lock position.
			state.intents.recoverGuiding = true
		}

		const { mount } = devices

		if (mount !== undefined && mountCommander !== undefined) {
			const motion = await this.#releaseMotion(context, host, mount, mountCommander)
			if (motion !== undefined) failures.push(motion)

			const off = await mountCommander.setTracking(context, mount, false, { timeout: this.timings.tracking })
			if (!off.ok) failures.push('trackingNotStopped')
		}

		state.trackingStoppedForMeridianProtection = true
		state.targetAcquired = false
		this.trackingProtected = failures.length === 0

		const hourAngle = mount === undefined ? undefined : observeSequencerMeridian(mount, configuration.target, clock.wallNow()).mountHourAngle
		return { ...(failures.length > 0 && { failure: failures[0] }), ...(hourAngle !== undefined && { hourAngle }) }
	}

	// Step 2b: within `mountMotionReleaseBound` from its start, without acquiring anything, waits for the release of the
	// mount by any root of the run and of each other movement key by the motion owners holding it (a co-resident lease
	// that is not motion is never waited), stops at once a motion of the mount nobody of the run owns, then waits for the
	// quiescence of the mount and of the movement guide outputs (no dispatched pulse window left, no pulse of a connected
	// view). Resolves the failure, if any.
	async #releaseMotion(context: OperationContext, host: SequencerTrackingProtectionHost, mount: Mount, mountCommander: MountCommander): Promise<SequencerMeridianProtectionFailure | undefined> {
		const { clock } = host.view()
		const { coordinator } = host
		const deadline = clock.monotonicNow() + this.timings.mountMotionReleaseBound
		const mountKey = resourceKey(mount)

		const external = (mount.slewing || mount.moving) && !ownsSequencerMountMotion(host.motionOwners, mount) ? mountCommander.stopMotion(mount, { settleTimeout: this.timings.mountSettle }) : undefined

		const releases: Promise<unknown>[] = []

		for (const owner of coordinator.arbiter.ownersOf(mountKey)) {
			const handle = coordinator.get(owner.id)
			if (handle !== undefined) releases.push(handle.result)
		}

		for (const movement of this.bounds.ditherMovement) {
			const { key } = movement.request
			if (key === mountKey) continue

			for (const owner of coordinator.arbiter.ownersOf(key)) {
				const handle = host.motionOwners.get(owner.id)?.keys.includes(key) === true ? coordinator.get(owner.id) : undefined
				if (handle !== undefined) releases.push(handle.result)
			}
		}

		let quiescent = await settledBefore(Promise.all(releases), deadline, clock, context.signal)
		if (quiescent) quiescent = await this.#awaitQuiescence(mount, deadline, clock, context.signal)
		if (external !== undefined) await external

		if (external !== undefined) return 'externalMotion'
		return quiescent ? undefined : 'mountNotQuiescent'
	}

	// Polls the motion quiescence of the mount and of the movement guide outputs until the monotonic `deadline` (ms).
	async #awaitQuiescence(mount: Mount, deadline: number, clock: SequencerTaskView['clock'], signal: AbortSignal) {
		while (true) {
			if (this.#isMotionQuiescent(mount)) return true
			const remaining = deadline - clock.monotonicNow()
			if (!(remaining > 0) || signal.aborted) return false
			await clock.delay(Math.min(remaining, MOTION_QUIESCENCE_POLL_INTERVAL), signal)
		}
	}

	// Whether the mount is quiescent and no movement guide output has a dispatched pulse window or a pulse on a connected view.
	#isMotionQuiescent(mount: Mount) {
		if (!isDeviceQuiescent(mount)) return false

		for (const movement of this.bounds.ditherMovement) {
			const device = movement.request.device
			if (device === undefined || device === (mount as Device)) continue
			const guideOutput = device as GuideOutput
			if (this.services.guideOutputCommander?.dispatchedPulseWindow(guideOutput) !== undefined) return false
			if (guideOutput.connected && guideOutput.pulsing) return false
		}

		return true
	}
}

// Whether `promise` settles before the monotonic `deadline` (ms); never rejects.
async function settledBefore(promise: Promise<unknown>, deadline: number, clock: SequencerTaskView['clock'], signal: AbortSignal) {
	const timer = new AbortController()
	const remaining = deadline - clock.monotonicNow()
	if (!(remaining > 0)) return false

	try {
		return await Promise.race([promise.then(() => true), clock.delay(remaining, AbortSignal.any([timer.signal, signal])).then(() => false)])
	} finally {
		timer.abort()
	}
}

// Whether a living root of the run among `motionOwners` holds the motion of the mount.
function ownsSequencerMountMotion(motionOwners: SequencerSupervisorHost['motionOwners'], mount: Mount) {
	const key = resourceKey(mount)
	for (const owner of motionOwners.values()) if (owner.keys.includes(key)) return true
	return false
}

// Risk epoch of the supervisor: born when a pre-flip mount starts tracking (or at arming), ended when the risk is removed
// physically (tracking off or post-flip side observed). Phase changes of the runner never end it.
interface MeridianRiskEpoch {
	// Whether the epoch was armed with less than the hard lead left, outside SIDEREAL, without telemetry, or across an
	// unsupervised gap; decided once.
	late: boolean
	// Physical hour angle of the last observation, unwrapped while no slew was observed, radians.
	hourAngle?: Angle
	// Whether the hard protection ran (or was absorbed by the shutdown prefix) in this epoch.
	protected: boolean
	// Whether the graceful protection was requested and not yet served.
	requested: boolean
}

// Meridian limit supervision and flip driver of one session (sections 24.2–24.5). Created with the session tasks: its
// `flipTask` and `guardTask` join the pre-capture, `shutdownStep` wraps the tracking prefix of the shutdown, and the
// runner arms it at step 0b and disarms it at the terminalization at the latest; it disarms itself once the shutdown
// observed tracking off.
//
// While armed it re-evaluates on every change of the mount (coalesced in a microtask), after every safe point and on a
// timer of at most `supervisionInterval` aimed at the nearest deadline. On a pre-flip (or NEITHER) tracking mount it
// computes, from the physical hour angle, the graceful deadline (`protectionMargin`) and the hard one (the hard lead):
// at the graceful one it asks the runner for a protection run at a safe point (the flip task while running, the
// `whilePaused` action in the hold, a tracking stop in the startup); at the hard one, or at once for a late arming, a
// non-sidereal mode or unpublished telemetry, it runs `protectMountTracking` as a critical root without waiting for
// anything of the run. Only the slew of a flip it dispatched, observed slewing and within `flipTimeout`, suspends the
// hard deadline.
export class SequencerMeridianSupervisor implements SequencerSupervisor {
	// Resolved flip configuration.
	readonly settings: SequencerMeridianFlipSettings
	// Policy of the pure state machine.
	readonly policy: MeridianFlipPolicy
	// Tracking protection prefix of the session, run by the hard path and shared with the safety protection.
	readonly protection: SequencerMountTrackingProtection
	// Timings of the tracking protection.
	readonly timings: SequencerMountTrackingProtectionTimings
	// Hard protection lead and its parts.
	readonly lead: SequencerHardProtectionLead
	// Motion bounds of the session.
	readonly bounds: SequencerMountMotionBounds
	// Pre-capture task `meridianFlip`.
	readonly flipTask: SequencerTask
	// Pre-capture task `finalExposureGuard`.
	readonly guardTask: SequencerTask = finalExposureGuardTask()

	#host?: SequencerSupervisorHost
	#unsubscribe?: VoidFunction
	#wake?: AbortController
	#armed = false
	#scheduled = false
	#epoch?: MeridianRiskEpoch
	// Whether a slew was observed since the last observation, which restarts the unwrapping of the hour angle.
	#slewed = false
	// Monotonic instant (ms) the flip of the session was dispatched, while its command runs.
	#flipDispatched?: number
	// Whether the last flip of the session ended without the post-flip side.
	#flipUnchanged = false
	// Whether the flip command in flight was observed slewing.
	#flipSlewObserved = false
	// Whether the commander observed the side change of the last flip from a known side.
	#pierSideVerified = false
	// Whether a hard protection is in flight.
	#protecting = false
	// Whether the end of the cycle was reported.
	#cycleExceeded = false

	constructor(
		readonly configuration: SequencerConfiguration & { readonly meridianFlip: SequencerMeridianFlipConfiguration },
		devices: SequencerDevices,
		readonly services: SequencerMeridianServices,
	) {
		this.settings = sequencerMeridianFlipSettings(configuration.meridianFlip)
		this.policy = toMeridianFlipPolicy(configuration.meridianFlip, configuration)
		this.protection = new SequencerMountTrackingProtection(configuration, devices, services)
		this.timings = this.protection.timings
		this.lead = meridianHardProtectionLead(this.timings)
		this.bounds = this.protection.bounds
		this.flipTask = { id: 'meridianFlip', shouldRun: ({ devices }) => devices.mount !== undefined, run: (context) => this.#flip(context), policy: { onFailure: this.settings.onFailure } }
	}

	// Whether the tracking protection prefix already holds: the last protection turned tracking off cleanly and nothing
	// turned it on since, so the shutdown steps of the prefix have nothing left to do.
	get trackingProtected() {
		return this.protection.trackingProtected
	}

	// Motion keys of the roots of `task`.
	motionKeys(task: SequencerTaskId) {
		return mountKeyHolders(task, this.bounds)?.keys ?? []
	}

	// Arms the supervision at step 0b, synchronously: subscribes to the mount, anchors the meridian cycle of a first
	// process (or verifies it), looks for an unsupervised gap since the last persisted observation, and evaluates at once.
	arm(host: SequencerSupervisorHost) {
		if (this.#armed) return
		this.#armed = true
		this.#host = host

		const { configuration, devices, state, clock } = host.view()
		const { mount } = devices
		if (mount === undefined) return

		const updates = this.services.mountUpdates ?? (this.services.mountCommander === undefined ? undefined : mountManagerUpdates(this.services.mountCommander.mountManager))
		this.#unsubscribe = updates?.(mount, () => this.#onUpdate())

		const wallNow = clock.wallNow()
		const observation = observeSequencerMeridian(mount, configuration.target, wallNow)

		if (state.meridianTransitAt === undefined) {
			const decision = sequencerDecisionHourAngle(observation, configuration.target !== undefined, false)
			if (decision !== undefined) state.meridianTransitAt = sequencerMeridianTransitAt(wallNow, decision)
		} else if (!isWithinSequencerMeridianCycle(state.meridianTransitAt, wallNow)) {
			this.#exceedCycle(state.meridianTransitAt, wallNow)
		}

		this.#checkGap(observation)
		this.#evaluate()
	}

	// A safe point passed: re-evaluate.
	safePoint() {
		this.#evaluate()
	}

	// Ends the supervision: no more wakes, no subscription. Idempotent.
	disarm() {
		this.#armed = false
		this.#unsubscribe?.()
		this.#unsubscribe = undefined
		this.#wake?.abort()
		this.#wake = undefined
	}

	// Wraps a shutdown step of the tracking prefix (`pauseGuiding`, `stopTracking`): it is a no-op once a protection
	// already turned tracking off (`SequencerMountTrackingProtection.shutdownStep`).
	shutdownStep(step: SequencerShutdownTask): SequencerShutdownTask {
		return this.protection.shutdownStep(step)
	}

	// Tracking protection prefix of section 24.5 (`protectMountTracking`) inside `context` for the armed session (see
	// `SequencerMountTrackingProtection.protect`).
	protectMountTracking(context: OperationContext, cause?: SequencerMeridianProtectionFailure) {
		return this.protection.protect(context, this.#host!, cause)
	}

	// Meridian flip task (section 24.2): see `flipTask`.
	async #flip(context: SequencerContext): Promise<SequencerTaskResult> {
		const { configuration, devices, state, clock } = context
		const { mountCommander } = this.services
		const { mount } = devices
		const { target } = configuration
		const { settings, policy } = this
		if (mount === undefined) return missingDependency('mount')
		if (mountCommander === undefined) return missingDependency('mount commander')

		let lastFlip: FailedOperationResult | undefined
		let reevaluated = false

		for (let i = 0; i < MERIDIAN_FLIP_DRIVER_ITERATIONS; i++) {
			if (!mount.connected) return failedTask(failedOperationResult('disconnected', `mount ${mount.name} is disconnected`))

			const wallNow = clock.wallNow()

			if (state.meridianTransitAt !== undefined && !isWithinSequencerMeridianCycle(state.meridianTransitAt, wallNow)) {
				this.#exceedCycle(state.meridianTransitAt, wallNow)
				return { ...configurationFailure('meridianCycleExceeded: the session left its single meridian cycle'), fatal: true }
			}

			// A NEITHER side is waited for, never accepted; still NEITHER, the state machine fails the cycle.
			if (mount.pierSide === 'NEITHER') {
				const known = await this.#awaitPierSide(context, mount)
				if (!known.ok) return failedTask(known)
			}

			const observation = observeSequencerMeridian(mount, target, clock.wallNow())
			const { localSiderealTime } = observation
			if (localSiderealTime === undefined || (target === undefined && observation.mountHourAngle === undefined)) return failedTask(failedOperationResult('unexpectedState', `mount ${mount.name} publishes no site or position`))

			// A mount off its target in the meridian zone, whose target flip is not due, stops tracking instead of flipping.
			if (this.#isOffTarget(state, observation, sequencerFrameHourAngleSpan(configuration, context.frame))) {
				context.emit({ type: 'meridianProtectionMountOffTarget', mountHourAngle: observation.mountHourAngle!, targetHourAngle: observation.targetHourAngle! })
				const stopped = await this.#stopTracking(context)
				if (!stopped.ok) return stopped
				continue
			}

			const decisionHourAngle = sequencerDecisionHourAngle(observation, target !== undefined, state.targetAcquired)
			if (decisionHourAngle === undefined) return failedTask(failedOperationResult('unexpectedState', `mount ${mount.name} publishes no position`))

			// The mount is the authority on its side: a pre-flip side read in COMPLETED recreates the state from the budget.
			if (state.meridianFlip.phase === 'COMPLETED' && observation.pierSide === settings.beforeFlipPierSide) {
				context.emit({ type: 'meridianFlipSideReverted', pierSide: observation.pierSide, hourAngle: decisionHourAngle })
				state.meridianFlip = createMeridianFlipState(state.meridianFlipAttempts)
			}

			const snapshot = { localSiderealTime, target: { rightAscension: normalizeAngle(localSiderealTime - decisionHourAngle) }, pierSide: observation.pierSide, isSlewing: mount.slewing, isGuiding: this.#isGuiding(configuration), isExposing: false }
			const decision = evaluateMeridianFlip(policy, snapshot, state.meridianFlip)
			state.meridianFlip = decision.state

			switch (decision.action) {
				case 'NONE':
				case 'PREPARE':
				case 'COMPLETE':
				case 'RESUME_GUIDING':
					return DONE
				case 'RECENTER':
					// The centering after the optical path of the frame recenters; a dark leaves it for the next light.
					if (state.intents.recenter) return DONE
					state.intents.recenter = true
					return await context.saveCheckpoint()
				case 'WAIT_FOR_EXPOSURE':
				case 'ABORT_EXPOSURE':
					if (reevaluated) return failedTask(failedOperationResult('commandFailed', `meridian flip decision ${decision.action} at a safe point`))
					reevaluated = true
					continue
				case 'PAUSE_GUIDING': {
					const paused = await pauseGuidingOf(context, this.services.guiding)
					if (!paused.ok) return paused
					if (decision.phase === 'READY') state.meridianFlip = transitionMeridianFlip(policy, state.meridianFlip, { type: 'PREPARED' })
					continue
				}
				case 'START_FLIP': {
					const started = await this.#startFlip(context, mount, mountCommander)
					if (!started.ok) return started
					lastFlip = started.value
					continue
				}
				case 'VERIFY_PIER_SIDE': {
					state.meridianFlipVerification = { hourAngle: decision.hourAngle, pierSide: observation.pierSide, pierSideVerified: this.#pierSideVerified }
					const completed = advanceSequencerMeridianFlip(state, policy, { type: 'PIER_SIDE_CONFIRMED' })
					if (completed !== undefined) context.emit(completed)
					continue
				}
				case 'FAIL':
					return failedTask(failedOperationResult('unexpectedState', `the meridian flip failed: ${decision.reason}${lastFlip === undefined ? '' : ` (${lastFlip.reason}${lastFlip.error === undefined ? '' : `: ${lastFlip.error}`})`}`))
			}
		}

		return failedTask(failedOperationResult('commandFailed', `the meridian flip driver did not settle in ${MERIDIAN_FLIP_DRIVER_ITERATIONS} iterations`))
	}

	// START_FLIP: one more started flip persisted before FLIP_STARTED (a failed save commands nothing), the guiding paused,
	// then the flip to the target (J2000 at the wall instant of the session) or, without a target, to the published
	// equinox-of-date position, with the configured timeout and supervised settle. Resolves the failed flip command, if
	// any, after its FAILED transition; or a failure before the command.
	async #startFlip(context: SequencerContext, mount: Mount, mountCommander: MountCommander): Promise<{ readonly ok: true; readonly value?: FailedOperationResult } | SequencerFailedTaskResult> {
		const { configuration, state, clock } = context
		const { settings, policy } = this
		if (state.meridianTransitAt === undefined) return failedTask(failedOperationResult('commandFailed', 'a flip would start without the anchored meridian cycle'))

		state.meridianFlipAttempts++
		const saved = await context.saveCheckpoint()

		if (!saved.ok) {
			state.meridianFlipAttempts--
			return saved
		}

		state.meridianFlip = transitionMeridianFlip(policy, state.meridianFlip, { type: 'FLIP_STARTED' })

		const paused = await pauseGuidingOf(context, this.services.guiding)

		if (!paused.ok) {
			state.meridianFlip = transitionMeridianFlip(policy, state.meridianFlip, { type: 'FAILED', reason: 'EXECUTION_FAILED' })
			return paused
		}

		const { target } = configuration
		const destination: MountTargetCoordinate<Angle> = target !== undefined ? j2000(target) : { type: 'JNOW', JNOW: { x: mount.equatorialCoordinate.rightAscension, y: mount.equatorialCoordinate.declination } }
		const options: MountCommandOptions = { time: timeUnix(clock.wallNow() / 1000), timeout: settings.flipTimeout * 1000, settleTimeout: settings.mountStopTimeout * 1000 }

		this.#flipDispatched = clock.monotonicNow()
		this.#flipUnchanged = false
		this.#flipSlewObserved = false
		const flipped = await mountCommander.flip(context.scope, mount, destination, options)
		this.#flipDispatched = undefined
		holdSequencerDither(state)

		if (flipped.ok) {
			this.#pierSideVerified = flipped.value.pierSideVerified
			state.meridianFlip = transitionMeridianFlip(policy, state.meridianFlip, { type: 'FLIP_COMPLETED' })
			state.flipCalibrationPending = configuration.guiding?.flipCalibration === true
			if (target !== undefined) state.targetAcquired = true
			this.#evaluate()
			return { ok: true }
		}

		// A failed or cancelled flip always leaves FLIPPING, so the retry budget decides the next safe point.
		this.#flipUnchanged = mount.pierSide !== settings.afterFlipPierSide
		state.meridianFlip = transitionMeridianFlip(policy, state.meridianFlip, { type: 'FAILED', reason: 'EXECUTION_FAILED' })
		this.#evaluate()
		if (context.signal.aborted) return failedTask(flipped)
		return { ok: true, value: flipped }
	}

	// Waits, event-driven, up to `pierSideTimeout` for a NEITHER pier side to become known; ok also when it stays NEITHER.
	async #awaitPierSide(context: SequencerContext, mount: Mount): Promise<OperationResult<void>> {
		const { clock, signal } = context
		const deadline = clock.monotonicNow() + this.settings.pierSideTimeout * 1000
		let wake: AbortController | undefined
		const updates = this.services.mountUpdates ?? (this.services.mountCommander === undefined ? undefined : mountManagerUpdates(this.services.mountCommander.mountManager))
		const unsubscribe = updates?.(mount, () => wake?.abort())

		try {
			while (mount.pierSide === 'NEITHER') {
				if (signal.aborted) return failedOperationResult('aborted')
				const remaining = deadline - clock.monotonicNow()
				if (!(remaining > 0)) break
				wake = new AbortController()
				await clock.delay(remaining, AbortSignal.any([signal, wake.signal]))
				wake = undefined
			}

			return signal.aborted ? failedOperationResult('aborted') : successfulOperationResult(undefined)
		} finally {
			unsubscribe?.()
		}
	}

	// Graceful tracking stop (`protectMeridianWhilePaused`, `protectMeridianDuringStartup`, and the stop of a mount off its
	// target): guiding paused before tracking (a failed pause stops guiding and tracking still goes off, reported as
	// `meridianProtectionFailed { guidingNotQuiescent }`), then tracking off observed, then tracking counts as stopped by the
	// protection, the target as not acquired and the guiding as to be started again. Tracking already off commands nothing.
	async #stopTracking(context: SequencerContext): Promise<SequencerTaskResult> {
		const { configuration, devices, state, clock } = context
		const { guiding, mountCommander } = this.services
		const { mount } = devices
		let failure: SequencerMeridianProtectionFailure | undefined

		if (configuration.guiding !== undefined && guiding !== undefined) {
			const paused = await pauseSequencerGuiding(context.scope, guiding, this.timings.pause / 1000, clock)

			if (!paused.ok) {
				if (context.signal.aborted) return failedTask(paused)
				await awaitAtMost(guiding.stop(context.scope), this.timings.guidingStop, clock)
				failure = 'guidingNotQuiescent'
			}

			state.intents.recoverGuiding = true
		}

		if (mount !== undefined && mountCommander !== undefined && (!mount.connected || mount.tracking)) {
			const off = await mountCommander.setTracking(context.scope, mount, false, { timeout: this.timings.tracking })

			if (!off.ok) {
				if (context.signal.aborted) return failedTask(off)
				failure ??= 'trackingNotStopped'
			}
		}

		state.trackingStoppedForMeridianProtection = true
		state.targetAcquired = false

		if (failure !== undefined) {
			const hourAngle = mount === undefined ? undefined : observeSequencerMeridian(mount, configuration.target, clock.wallNow()).mountHourAngle
			context.emit({ type: 'meridianProtectionFailed', reason: failure, lateStart: false, hourAngle: hourAngle ?? this.settings.latestAt })
			return failedTask(failedOperationResult('unexpectedState', `meridian protection failed: ${failure}`))
		}

		return await context.saveCheckpoint()
	}

	// Task of a graceful tracking stop.
	#stopTrackingTask(id: 'protectMeridianWhilePaused' | 'protectMeridianDuringStartup'): SequencerTask {
		return { id, shouldRun: () => true, run: (context) => this.#stopTracking(context), policy: { onFailure: this.settings.onFailure } }
	}

	// Whether a tracking pre-flip mount stands off its target, not acquired yet, in the meridian zone
	// (`isSequencerMountOffTarget` with `span`, radians, the frame of the safe point as the guard adds it). The guard
	// refuses such a frame; stopping the tracking here is the graceful request it anticipates.
	#isOffTarget(state: SequencerRuntimeState, observation: SequencerMeridianObservation, span: Angle) {
		const { mountHourAngle, targetHourAngle } = observation
		if (this.configuration.target === undefined || state.targetAcquired || !observation.tracking || observation.pierSide === this.settings.afterFlipPierSide) return false
		if (mountHourAngle === undefined || targetHourAngle === undefined) return false
		return isSequencerMountOffTarget(this.settings, mountHourAngle, targetHourAngle, span)
	}

	// Whether the guiding session of the session is actively guiding (`paused` counts as not guiding).
	#isGuiding(configuration: SequencerConfiguration) {
		const state = configuration.guiding === undefined ? undefined : this.services.guiding?.state()
		return state === 'calibrating' || state === 'guiding' || state === 'settling'
	}

	// Coalesces the changes of the mount into one evaluation in a microtask of the same tick.
	#onUpdate() {
		if (this.#scheduled) return
		this.#scheduled = true

		queueMicrotask(() => {
			this.#scheduled = false
			this.#evaluate()
		})
	}

	// Reports the end of the single meridian cycle once and fails the session with `meridianCycleExceeded`.
	#exceedCycle(meridianTransitAt: number, wallNow: number) {
		if (this.#cycleExceeded) return
		this.#cycleExceeded = true
		this.#host?.emit({ type: 'meridianCycleExceeded', meridianTransitAt, wallNow })
		this.#host?.fail({ kind: 'configuration', detail: 'meridianCycleExceeded: the session left its single meridian cycle' })
	}

	// Gap between runtimes at the arming of a restart: the last persisted observation, pre-flip (or NEITHER) and tracking,
	// extrapolated at the sidereal rate to now, reached `latestAt`. A pre-flip tracking mount now starts a late epoch and
	// the hard path at once, whose outcome is always `unsupervisedCrossing`; tracking off only reports it.
	#checkGap(observation: SequencerMeridianObservation) {
		const host = this.#host!
		const { state } = host.view()
		const previous = state.mountRiskObservation
		if (previous === undefined || !previous.tracking || previous.pierSide === this.settings.afterFlipPierSide) return

		const extrapolated = previous.hourAngle + ((observation.at - previous.at) / 1000) * SIDEREAL_DRIFT_RATE
		if (!(extrapolated >= this.settings.latestAt)) return

		const risk = observation.tracking && observation.pierSide !== this.settings.afterFlipPierSide
		host.emit({ type: 'meridianProtectionUnsupervisedGap', observedAt: previous.at, observedHourAngle: previous.hourAngle, extrapolatedHourAngle: extrapolated, hourAngle: observation.mountHourAngle ?? normalizePI(extrapolated), tracking: observation.tracking })

		if (risk) {
			this.#epoch = { late: true, ...(observation.mountHourAngle !== undefined && { hourAngle: observation.mountHourAngle }), protected: false, requested: false }
			this.#hard('unsupervisedCrossing')
		}
	}

	// One evaluation of the supervision (section 24.4): ends it after the tracking off of the shutdown, verifies the
	// cycle, records the observation, tracks the risk epoch, and protects or schedules the next wake.
	#evaluate() {
		const host = this.#host
		if (!this.#armed || host === undefined) return

		const { configuration, devices, state, clock } = host.view()
		const { mount } = devices
		if (mount === undefined) return

		// The supervision lasts until the tracking off of the shutdown.
		if (state.phase === 'shutdown' && !this.#protecting && !(mount.connected && mount.tracking)) {
			this.disarm()
			return
		}

		const wallNow = clock.wallNow()
		if (state.meridianTransitAt !== undefined && !isWithinSequencerMeridianCycle(state.meridianTransitAt, wallNow)) this.#exceedCycle(state.meridianTransitAt, wallNow)

		const observation = observeSequencerMeridian(mount, configuration.target, wallNow)
		const moving = mount.slewing || mount.moving
		if (mount.slewing) this.#slewed = true
		if (mount.slewing && this.#flipDispatched !== undefined) this.#flipSlewObserved = true

		// A motion nobody of the run owns invalidates the acquired target.
		if (moving && !ownsSequencerMountMotion(host.motionOwners, mount)) state.targetAcquired = false

		if (observation.tracking) this.protection.trackingProtected = false

		const risk = observation.tracking && observation.pierSide !== this.settings.afterFlipPierSide

		if (!risk) {
			this.#epoch = undefined
			if (observation.mountHourAngle !== undefined) state.mountRiskObservation = { at: wallNow, hourAngle: observation.mountHourAngle, pierSide: observation.pierSide, tracking: observation.tracking }
			this.#schedule(undefined)
			return
		}

		const arming = this.#epoch === undefined
		const epoch: MeridianRiskEpoch = this.#epoch ?? { late: false, protected: false, requested: false }
		this.#epoch = epoch
		if (arming && this.#flipDispatched === undefined) this.#flipUnchanged = false

		// Within an epoch the physical hour angle is unwrapped from the previous one while no slew was observed.
		let hourAngle = observation.mountHourAngle

		if (hourAngle !== undefined) {
			if (!arming && !this.#slewed && epoch.hourAngle !== undefined) hourAngle = epoch.hourAngle + normalizePI(hourAngle - epoch.hourAngle)
			if (!mount.slewing) this.#slewed = false
			epoch.hourAngle = hourAngle
			state.mountRiskObservation = { at: wallNow, hourAngle: observation.mountHourAngle!, pierSide: observation.pierSide, tracking: true }
		}

		if (observation.missing.length > 0 || hourAngle === undefined) {
			if (arming) epoch.late = true
			if (!epoch.protected) host.emit({ type: 'meridianProtectionTelemetryUnobserved', missing: observation.missing })
			this.#hard()
			this.#schedule(undefined)
			return
		}

		if (!observation.sidereal) {
			if (arming) epoch.late = true
			if (!epoch.protected) host.emit({ type: 'meridianProtectionTrackModeUnsupervisable', trackMode: observation.trackMode, hourAngle })
			this.#hard()
			this.#schedule(undefined)
			return
		}

		const { lead } = this.lead
		const remaining = ((this.settings.latestAt - hourAngle) / SIDEREAL_DRIFT_RATE) * 1000

		if (arming && remaining < lead) {
			epoch.late = true
			host.emit({ type: 'meridianProtectionLateStart', remainingMs: remaining, requiredLeadMs: lead, hourAngle })
			this.#hard()
			this.#schedule(undefined)
			return
		}

		const untilHard = remaining - lead
		const untilGraceful = remaining - this.settings.protectionMargin * 1000

		// Only the slew of the flip of the session, observed slewing within its watchdog, suspends the hard deadline.
		const watchdog = this.#flipDispatched === undefined ? undefined : this.#flipDispatched + this.settings.flipTimeout * 1000
		const now = clock.monotonicNow()

		if (watchdog !== undefined && mount.slewing && now < watchdog && this.#ownsFlip(host)) {
			this.#schedule(watchdog - now)
			return
		}

		if (!(untilHard > DEADLINE_RESOLUTION)) {
			// A flip slew beyond its watchdog timed out; one observed slewing that stopped, or ended, before the post-flip side
			// left the mount unchanged. A dispatched flip never observed slewing is protected as usual.
			const unchanged = this.#flipUnchanged || (watchdog !== undefined && this.#flipSlewObserved && !mount.slewing)
			const cause = watchdog !== undefined && mount.slewing ? 'flipSlewTimeout' : unchanged ? 'flipSideUnchanged' : undefined
			this.#hard(cause)
			this.#schedule(undefined)
			return
		}

		if (state.meridianProtection === undefined) epoch.requested = false

		// The flip of the session in flight is the graceful action itself: it is never preempted by a request.
		if (!(untilGraceful > DEADLINE_RESOLUTION) && !epoch.requested && !this.#protecting && this.#flipDispatched === undefined) {
			epoch.requested = this.#requestGraceful(host)
		}

		this.#schedule(epoch.requested || !(untilGraceful > DEADLINE_RESOLUTION) ? untilHard : Math.min(untilGraceful, untilHard))
	}

	// Asks the runner for the graceful protection of the state the session is in: the `whilePaused` action in the hold
	// ('flip' only with the flip due by the decision hour angle), a tracking stop in the startup, the flip task otherwise
	// (the pre-capture re-enters through it, or it stops the tracking of a mount off its target).
	#requestGraceful(host: SequencerSupervisorHost) {
		const { configuration, devices, state, clock } = host.view()
		let action: SequencerTask

		if (state.state === 'paused') {
			const observation = observeSequencerMeridian(devices.mount!, configuration.target, clock.wallNow())
			const decision = sequencerDecisionHourAngle(observation, configuration.target !== undefined, state.targetAcquired)
			const due = decision !== undefined && decision >= this.settings.flipAt
			action = this.settings.whilePaused === 'flip' && due ? this.flipTask : this.#stopTrackingTask('protectMeridianWhilePaused')
		} else if (state.phase === 'startup' || state.phase === undefined) {
			action = this.#stopTrackingTask('protectMeridianDuringStartup')
		} else {
			action = this.flipTask
		}

		return host.requestProtection(action)
	}

	// Starts the hard path once per epoch: the critical root `sequencer.protect.meridianHard` runs `protectMountTracking`
	// and reports `meridianHardProtection` or `meridianProtectionFailed`. Absorbed by the shutdown prefix in flight.
	#hard(cause?: SequencerMeridianProtectionFailure) {
		const host = this.#host!
		const epoch = this.#epoch
		if (this.#protecting || epoch?.protected === true) return
		if (epoch !== undefined) epoch.protected = true

		const { state } = host.view()

		// The tracking prefix of the shutdown in flight is that very protection.
		if (state.phase === 'shutdown' && (state.task === 'pauseGuiding' || state.task === 'stopTracking')) return

		const late = epoch?.late ?? true
		this.#protecting = true

		void host
			.protectCritically('sequencer.protect.meridianHard', (context) => this.#hardProtection(context, late, cause))
			.then((outcome) => {
				this.#protecting = false
				this.protection.trackingProtected = outcome.ok
				this.#evaluate()
			})
	}

	// Physical hour angle, radians, of the last observation of the mount at risk, aged at the sidereal rate to now: the
	// hour angle of a protection that could not observe the mount (telemetry withdrawn). The epoch itself may already be
	// gone, ended by the tracking off. Undefined without such an observation.
	#lastObservedHourAngle() {
		const { state, clock } = this.#host!.view()
		const observation = state.mountRiskObservation
		if (observation?.tracking !== true) return undefined
		return observation.hourAngle + ((clock.wallNow() - observation.at) / 1000) * SIDEREAL_DRIFT_RATE
	}

	// Body of the critical root of the hard path, with its events.
	async #hardProtection(context: OperationContext, late: boolean, cause: SequencerMeridianProtectionFailure | undefined): Promise<OperationResult<SequencerProtectionOutcome>> {
		const host = this.#host!
		const { latestAt } = this.settings
		const protection = await this.protectMountTracking(context, cause)
		const hourAngle = protection.hourAngle ?? this.#lastObservedHourAngle() ?? latestAt
		let failure = protection.failure

		// A tracking off at or past latestAt is a clean outcome only in a normal epoch at the sidereal rate.
		if (failure === undefined && hourAngle >= latestAt) {
			if (host.view().devices.mount?.trackMode === 'CUSTOM') failure = 'trackRateUnknown'
			else if (late) failure = 'lateStart'
		}

		if (failure === undefined) {
			host.emit({ type: 'meridianHardProtection', late, hourAngle, latestAt, leadMs: this.lead.lead })
			return successfulOperationResult({ ok: true })
		}

		host.emit({ type: 'meridianProtectionFailed', reason: failure, lateStart: late, hourAngle })
		return successfulOperationResult({ ok: false, failure: { kind: 'operation', reason: 'unexpectedState', detail: `meridian protection failed: ${failure}` }, action: this.settings.onFailure })
	}

	// Whether the root of the flip task of the session lives.
	#ownsFlip(host: SequencerSupervisorHost) {
		for (const owner of host.motionOwners.values()) if (owner.task === 'meridianFlip') return true
		return false
	}

	// Schedules the next wake in `ms` (monotonic), capped by `supervisionInterval` and by the end of the meridian cycle;
	// none without a deadline and without a cycle. A wake later than the jitter allowance reports `supervisionLate`.
	#schedule(ms: number | undefined) {
		this.#wake?.abort()
		this.#wake = undefined
		const host = this.#host
		if (!this.#armed || host === undefined) return

		const { state, clock } = host.view()
		let delay = ms

		if (state.meridianTransitAt !== undefined && !this.#cycleExceeded) {
			const end = state.meridianTransitAt + SEQUENCER_MERIDIAN_HALF_CYCLE - clock.wallNow()
			delay = delay === undefined ? end : Math.min(delay, end)
		}

		if (delay === undefined) return
		delay = Math.max(0, Math.min(delay, this.settings.supervisionInterval * 1000))

		const controller = new AbortController()
		const expected = clock.monotonicNow() + delay
		this.#wake = controller

		void clock.delay(delay, controller.signal).then((waited) => {
			if (!waited.ok || this.#wake !== controller) return
			this.#wake = undefined
			const lateMs = clock.monotonicNow() - expected
			if (lateMs > SEQUENCER_SUPERVISION_JITTER) host.emit({ type: 'supervisionLate', lateMs })
			this.#evaluate()
		})
	}
}

// Supervisor of a session with an enabled meridian flip and a mount; undefined otherwise.
export function sequencerMeridianSupervisor(configuration: SequencerConfiguration, devices: SequencerDevices, services: SequencerMeridianServices) {
	const { meridianFlip } = configuration
	if (meridianFlip?.enabled !== true || devices.mount === undefined) return undefined
	return new SequencerMeridianSupervisor({ ...configuration, meridianFlip }, devices, services)
}

// Device roles of a session that share the resource key of the mount (`mountKeyAliases`, section 41): the hard
// protection waits for the mount by its key, so under a meridian flip or `shutdownImmediately` no other commanded device
// (and no guide camera held by the guiding) may be the same hardware. The table covers every device role but the mount.
export function mountKeyAliases(devices: SequencerDevices, held: readonly { readonly key: ResourceKey; readonly device?: Device }[] = []) {
	const { mount } = devices
	if (mount === undefined) return []

	const key = resourceKey(mount)
	const roles: Readonly<Record<Exclude<keyof SequencerDevices, 'mount'>, Device | undefined>> = { camera: devices.camera, wheel: devices.wheel, focuser: devices.focuser, rotator: devices.rotator, cover: devices.cover, dome: devices.dome, flatPanel: devices.flatPanel }
	const aliases: string[] = []

	for (const [role, device] of Object.entries(roles)) {
		if (device !== undefined && resourceKey(device) === key) aliases.push(role)
	}

	for (const request of held) {
		if (request.key === key && request.device?.type === 'camera') aliases.push('guideCamera')
	}

	return aliases
}

// Meridian part of the runtime preflight (section 41), against the resolved devices and services; it never commands.
// Every problem is a diagnostic of the configuration path it concerns:
// - with a target or a meridian flip, a mount that publishes track modes must offer SIDEREAL;
// - the shutdown total timeout covers the tracking protection bound whenever it is positive;
// - under a meridian flip or `shutdownImmediately`, no other device role shares the hardware of the mount;
// - a meridian flip needs a mount commander and a mount that flips, tracks, aborts and publishes its pier side, site and
//   position; thresholds within [−π/2, π/2] for the state machine; `protectionMargin` at least the hard protection lead
//   (with its parts and dominant task); the continuous window `flipAt ≤ latestAt − protectionMargin × sidereal rate`; a
//   recentering only with pointing and a guiding settle only with guiding; a slew mount ditherer settling within
//   `mountStopTimeout`.
export function preflightSequencerMeridian(configuration: SequencerConfiguration, devices: SequencerDevices, services: SequencerMeridianServices): SequencerConfigurationDiagnostic[] {
	const { target, meridianFlip, safety, shutdown, pointing, guiding } = configuration
	const { mount } = devices
	const flip = meridianFlip?.enabled === true ? meridianFlip : undefined
	const diagnostics: SequencerConfigurationDiagnostic[] = []
	const report = (path: string, message: string) => diagnostics.push({ path, message })
	const timings = mountTrackingProtectionTimings(configuration, devices, services)

	if ((target !== undefined || flip !== undefined) && mount !== undefined && mount.trackModes.length > 0 && !mount.trackModes.includes('SIDEREAL')) {
		report('devices.mount', `${mount.name} offers no SIDEREAL track mode`)
	}

	if (timings.bound > 0 && !(shutdown.totalTimeout * 1000 >= timings.bound)) {
		report('shutdown.totalTimeout', `must be at least ${timings.bound / 1000} s, the tracking protection bound (guiding ${timings.guidingBound / 1000} s, mount motion ${timings.mountMotionReleaseBound / 1000} s, tracking ${timings.trackingBound / 1000} s)`)
	}

	if (flip !== undefined || safety?.unsafeAction === 'shutdownImmediately') {
		const held = configuration.guiding === undefined ? [] : (services.guiding?.resources().hold ?? [])
		for (const role of mountKeyAliases(devices, held)) report(`devices.${role}`, `shares the hardware of the mount ${mount!.name}, which the hard protection cannot tell apart`)
	}

	if (flip === undefined) return diagnostics

	const settings = sequencerMeridianFlipSettings(flip)

	if (mount === undefined) report('meridianFlip', 'requires a mount')
	else {
		const flags = { canFlip: mount.canFlip, canTracking: mount.canTracking, hasPierSide: mount.hasPierSide, canAbort: mount.canAbort, hasGeographicCoordinate: mount.hasGeographicCoordinate, hasEquatorialCoordinate: mount.hasEquatorialCoordinate }
		for (const [flag, value] of Object.entries(flags)) if (!value) report('devices.mount', `${mount.name} must publish ${flag} for a meridian flip`)
	}

	if (services.mountCommander === undefined) report('meridianFlip', 'requires a mount commander')

	for (const name of ['prepareAt', 'flipAt', 'latestAt'] as const) {
		const value = settings[name]
		if (!(value >= -PIOVERTWO && value <= PIOVERTWO)) report(`meridianFlip.${name}`, 'must be within [-PI / 2, PI / 2]')
	}

	const lead = meridianHardProtectionLead(timings)

	if (!(settings.protectionMargin * 1000 >= lead.lead)) {
		report(
			'meridianFlip.protectionMargin',
			`must be at least ${lead.lead / 1000} s, the hard protection lead (supervision jitter ${lead.supervisionJitter / 1000} s, guiding ${lead.guidingBound / 1000} s, mount motion ${lead.mountMotionReleaseBound / 1000} s${lead.dominantTask === undefined ? '' : ` by ${lead.dominantTask}`}, tracking ${lead.trackingTimeout / 1000} s)`,
		)
	}

	const minimumLatestAt = settings.flipAt + settings.protectionMargin * SIDEREAL_DRIFT_RATE
	if (!(settings.flipAt <= settings.latestAt - settings.protectionMargin * SIDEREAL_DRIFT_RATE)) report('meridianFlip.latestAt', `must be at least ${minimumLatestAt} rad: flipAt ${settings.flipAt} rad plus protectionMargin ${settings.protectionMargin} s at the sidereal rate`)

	const policy = toMeridianFlipPolicy(flip, configuration)
	if (policy.requireRecentering === true && (target === undefined || pointing === undefined)) report('meridianFlip.requireRecentering', 'requires a target with pointing')
	if (policy.requireGuidingSettle === true && (guiding === undefined || services.guiding === undefined)) report('meridianFlip.requireGuidingSettle', 'requires guiding')

	const { ditherer } = services
	if (configuration.dither !== undefined && ditherer instanceof MountDitherer && ditherer.options.method === 'slew' && ditherer.options.settleTimeout !== settings.mountStopTimeout * 1000) {
		report('dither', `a slew mount ditherer must settle a stopped slew within hardProtection.mountStopTimeout (${settings.mountStopTimeout * 1000} ms)`)
	}

	return diagnostics
}
