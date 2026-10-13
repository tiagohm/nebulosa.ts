import { failedOperationResult, type OperationResult, type OperationScope } from '../../devices/orchestration/operation'
import { resourceKey } from '../../devices/orchestration/resource'
import { type Ditherer, type DitherRequest, MountDitherer } from '../guiding/ditherer'
import type { GuidingSession, GuidingSessionState } from '../guiding/session'
import { LocalGuidingSession } from '../guiding/session.client'
import { PHD2GuidingSession } from '../guiding/session.phd2'
import { failedTask, taskResult } from './lifecycle'
import type { SequencerContext, SequencerShutdownTask, SequencerTask, SequencerTaskResult } from './runner'
// oxfmt-ignore
import { DEFAULT_SEQUENCER_MERIDIAN_FLIP, type SequencerClock, type SequencerConfiguration, type SequencerConfigurationDiagnostic, type SequencerDevices, type SequencerDitherConfiguration, type SequencerFrameSlot, type SequencerGuidingConfiguration, type SequencerShutdownConfiguration, type SequencerShutdownStepPolicy } from './sequencer'
import { advanceSequencerMeridianFlip, toMeridianFlipPolicy } from './state'
import { ditherDue, recordSequencerActionSuccess } from './trigger'

// Guiding and dither of the Sequencer: the `GuidingSession` and the `Ditherer` of the caller driven at the safe points
// of the session, independent of each other and of PHD2 or the local GuiderClient. The startup proves the quiescence of
// pulses dispatched before the run (`quiesceGuiding` for a session with a run admission, `quiesceDitherPulses` for a
// pulse mount ditherer, whose inherited-pulse barrier the runner installs right after the reservation); the pre-capture
// ensures guiding before every light (start, resume or recovery, always ending on a settle) and keeps it paused for a
// calibration frame whose optical path is closed, then dithers when due (`ditherAndSettle`, which ends only after its
// settle); the shutdown pauses guiding before tracking stops and stops it afterwards.
//
// Every pause before a mount motion goes through `pauseSequencerGuiding`, bounded by `guiding.pauseTimeout`: it resolves
// ok only once the guiding session proved that no pulse can be emitted and the pulses already sent ended physically.
// Conventions: configured durations in seconds, turned into milliseconds only at the clock; the dither anchor advances
// only after the settle succeeded and is persisted at once.

// Guiding session and ditherer of the session tasks; the same instances the runner reserves for.
export interface SequencerGuidingServices {
	// Guiding of the LIGHT frames.
	readonly guiding?: GuidingSession
	// Dither between LIGHT frames.
	readonly ditherer?: Ditherer
}

// States in which a guiding session may emit corrections, so a closed optical path pauses it.
const ACTIVE_GUIDING = new Set<GuidingSessionState>(['calibrating', 'guiding', 'settling', 'lost'])

// Whether `frame` is a calibration frame whose optical path the session closes (cover or opaque filter), so guiding is
// paused before the path closes and never settles for it.
export function sequencerClosesOpticalPath(configuration: Pick<SequencerConfiguration, 'capture'>, frame: Pick<SequencerFrameSlot, 'groupId' | 'kind' | 'capture'>) {
	if (frame.kind !== 'triggered' || frame.capture.frameType === 'LIGHT') return false
	const group = configuration.capture.groups.find((group) => group.id === frame.groupId)
	return group?.kind === 'triggered' && group.opticalPath.kind !== 'none'
}

// Pauses `guiding` as the child `sequencer.guidingPause` of `scope`, cancelled with 'timeout' after `pauseTimeout`
// seconds of the monotonic clock: ok only once the session proved that no pulse can be emitted and the pulses already
// sent ended physically. Leaves no pending delay behind.
export async function pauseSequencerGuiding(scope: OperationScope, guiding: GuidingSession, pauseTimeout: number, clock: SequencerClock): Promise<OperationResult<void>> {
	const handle = scope.start<void>('sequencer.guidingPause', [], (context) => guiding.pause(context))
	const timer = new AbortController()

	void clock.delay(pauseTimeout * 1000, timer.signal).then((elapsed) => {
		if (elapsed.ok) void handle.cancel('timeout')
	})

	try {
		return await handle.result
	} finally {
		timer.abort()
	}
}

// Pauses the guiding of the session before a mount motion or the closing of the optical path, inside the task of
// `context`, bounded by `guiding.pauseTimeout`; ok at once without guiding. Its failure names the guiding quiescence.
export async function pauseGuidingOf(context: SequencerContext, guiding: GuidingSession | undefined): Promise<SequencerTaskResult> {
	const configuration = context.configuration.guiding
	if (guiding === undefined || configuration === undefined) return DONE
	return quiescenceResult(await pauseSequencerGuiding(context.scope, guiding, configuration.pauseTimeout, context.clock), 'guidingNotQuiescent')
}

// Startup task `quiesceGuiding` (0c), first physical command of a run whose guiding session installed a run admission:
// pauses the guiding, proving the end of the pulses dispatched before the run within `pulseQuiescenceBound()` ≤
// `pauseTimeout`. Its failure applies the startup policy.
export function quiesceGuidingTask(guiding: GuidingSession, configuration: SequencerGuidingConfiguration): SequencerTask {
	return {
		id: 'quiesceGuiding',
		shouldRun: () => guiding.beginRun !== undefined,
		run: async (context) => quiescenceResult(await pauseSequencerGuiding(context.scope, guiding, configuration.pauseTimeout, context.clock), 'guidingNotQuiescent'),
	}
}

// Startup task `quiesceDitherPulses` (0c') of a pulse mount ditherer: waits, commanding nothing, until the barrier of
// pulses inherited from a previous process (installed by the runner after the reservation) and every pulse recorded
// since ended by continuous observation of a registered and connected guide output view, within
// `guidePulseReleaseBound(maxPulseDuration)`. A timeout or an unobservable guide output fails with `mountNotQuiescent`
// (`dispatchedPulseUnobserved`), applying the startup policy.
export function quiesceDitherPulsesTask(ditherer: MountDitherer): SequencerTask {
	return {
		id: 'quiesceDitherPulses',
		shouldRun: () => ditherer.options.method === 'pulse',
		run: async (context) => quiescenceResult(await ditherer.awaitPulseQuiescence(context.signal), 'mountNotQuiescent: dispatchedPulseUnobserved'),
	}
}

// Pre-capture task `ensureGuiding` (section 20.7), after the pointing, the rotator and the autofocus. For a LIGHT frame
// it runs unless the session already guides without a pending recovery: a paused session resumes; a stopped, lost,
// calibrating or settling one (or a recovery the quality asked for) starts again with a new settle, recalibrating only
// on the first start of the process when configured; a lost guiding is recovered up to `maxRecoveries` times in the
// safe point. Every path ends on a settle, and a success clears the recovery intent. For a calibration frame whose
// optical path is closed it only keeps an active guiding paused, without settle; one whose path stays open is left
// alone. Its failure applies `guiding.onFailure`.
export function ensureGuidingTask(guiding: GuidingSession, configuration: SequencerGuidingConfiguration): SequencerTask {
	return {
		id: 'ensureGuiding',
		shouldRun: (view) => {
			const { frame } = view
			if (frame === undefined) return false
			const state = guiding.state()
			if (frame.capture.frameType === 'LIGHT') return view.state.intents.recoverGuiding || state !== 'guiding' || view.state.meridianFlip.phase === 'SETTLING'
			return sequencerClosesOpticalPath(view.configuration, frame) && ACTIVE_GUIDING.has(state)
		},
		run: async (context) => {
			if (context.frame?.capture.frameType !== 'LIGHT') return quiescenceResult(await pauseSequencerGuiding(context.scope, guiding, configuration.pauseTimeout, context.clock), 'guidingNotQuiescent')
			return await ensureGuiding(context, guiding, configuration)
		},
		policy: { onFailure: configuration.onFailure },
	}
}

// Pre-capture task `ditherAndSettle` (section 20.8), after the guiding, for LIGHT frames whose dither is due
// (`ditherDue`: never the first light of the session nor the first one after a motion of the mount for the target). The
// ditherer dithers and resolves only after its settle; each phase is emitted as `ditherPhase`. Only then the dither
// anchor advances, persisted at once. A ditherer that is not ready (a guider not guiding) fails without dithering. Its
// failure applies `dither.onFailure` and never advances the anchor.
export function ditherAndSettleTask(ditherer: Ditherer, configuration: SequencerDitherConfiguration): SequencerTask {
	const request = sequencerDitherRequest(configuration)

	return {
		id: 'ditherAndSettle',
		shouldRun: (view) => view.frame?.capture.frameType === 'LIGHT' && ditherDue(configuration, view.state.anchors, view.state.ditherHeldAt),
		run: async (context) => {
			if (!ditherer.ready()) return failedTask(failedOperationResult('unexpectedState', 'the ditherer is not ready to dither'))

			const dithered = await ditherer.dither(context.scope, request, (phase) => context.emit({ type: 'ditherPhase', phase }))
			if (!dithered.ok) return failedTask(dithered)

			const { state, clock } = context
			recordSequencerActionSuccess(state, 'dither', clock.wallNow(), clock.monotonicNow())
			return await context.saveCheckpoint()
		},
		policy: { onFailure: configuration.onFailure },
	}
}

// Shutdown step `pauseGuiding`, the first of the shutdown and the guiding half of the tracking protection prefix: pauses
// the guiding within `guiding.pauseTimeout` (never cut by the step or total timeout of the shutdown). A pause that failed
// stops the guiding, waiting at most the hard-protection `guidingStopTimeout` with a meridian flip and
// `shutdown.stepTimeout` otherwise, and the step fails with `guidingNotQuiescent` while the shutdown goes on.
export function pauseGuidingTask(guiding: GuidingSession, configuration: SequencerGuidingConfiguration): SequencerShutdownTask {
	return {
		id: 'pauseGuiding',
		shouldRun: () => true,
		run: async (context) => {
			const paused = await pauseSequencerGuiding(context.scope, guiding, configuration.pauseTimeout, context.clock)
			if (paused.ok) return DONE

			await awaitAtMost(guiding.stop(context.scope), guidingStopTimeout(context.configuration) * 1000, context.clock)
			return quiescenceResult(paused, 'guidingNotQuiescent')
		},
		policy: 'required',
	}
}

// Shutdown step `stopGuiding`, after the tracking off: stops the guiding and ends its root. It runs only while guiding
// is not stopped or its root lives.
export function stopGuidingTask(guiding: GuidingSession, policy: SequencerShutdownStepPolicy): SequencerShutdownTask {
	return {
		id: 'stopGuiding',
		shouldRun: () => guiding.operationId?.() !== undefined || guiding.state() !== 'stopped',
		run: async (context) => taskResult(await guiding.stop(context.scope)),
		policy,
	}
}

// Startup tasks of the guiding and the dither in their fixed order (section 42), before every lifecycle task: the
// guiding quiescence of a session with a run admission, then the pulse quiescence of a pulse mount ditherer.
export function sequencerGuidingStartupTasks(configuration: Pick<SequencerConfiguration, 'guiding' | 'dither'>, services: SequencerGuidingServices): SequencerTask[] {
	const tasks: SequencerTask[] = []
	if (configuration.guiding !== undefined && services.guiding !== undefined) tasks.push(quiesceGuidingTask(services.guiding, configuration.guiding))
	if (configuration.dither !== undefined && services.ditherer instanceof MountDitherer) tasks.push(quiesceDitherPulsesTask(services.ditherer))
	return tasks
}

// Pre-capture tasks of the guiding and the dither in their fixed order (section 42), after the autofocus and before the
// frame destination: `ensureGuiding`, then `ditherAndSettle`, only the configured ones.
export function sequencerGuidingTasks(configuration: Pick<SequencerConfiguration, 'guiding' | 'dither'>, services: SequencerGuidingServices): SequencerTask[] {
	const tasks: SequencerTask[] = []
	if (configuration.guiding !== undefined && services.guiding !== undefined) tasks.push(ensureGuidingTask(services.guiding, configuration.guiding))
	if (configuration.dither !== undefined && services.ditherer !== undefined) tasks.push(ditherAndSettleTask(services.ditherer, configuration.dither))
	return tasks
}

// Shutdown steps in their fixed physical order (section 31): the guiding pause, then the lifecycle steps with the
// guiding stop right after the tracking off (first when there is no tracking off). Without guiding, the lifecycle steps
// as given. `stopGuiding` uses the configured policy, 'required' by default.
export function sequencerShutdownTasks(configuration: Pick<SequencerConfiguration, 'guiding'> & { readonly shutdown: SequencerShutdownConfiguration }, services: SequencerGuidingServices, lifecycle: readonly SequencerShutdownTask[]): SequencerShutdownTask[] {
	const { guiding } = services
	if (configuration.guiding === undefined || guiding === undefined) return [...lifecycle]

	const stop = stopGuidingTask(guiding, configuration.shutdown.stopGuiding ?? 'required')
	const tracking = lifecycle.findIndex((task) => task.id === 'stopTracking')
	const steps = [...lifecycle]
	steps.splice(tracking + 1, 0, stop)
	return [pauseGuidingTask(guiding, configuration.guiding), ...steps]
}

// Guiding and dither part of the runtime preflight (sections 13 and 41.2), against the resolved devices and the
// services of the caller. It never commands anything. Every problem is returned as a diagnostic of the configuration
// path it concerns:
// - guiding needs a guiding session whose `pulseQuiescenceBound()` fits `guiding.pauseTimeout`; a local session needs
//   a pulse ceiling the guider configuration does not exceed; a PHD2 session needs a finite positive pulse premise and
//   Paused allowance;
// - dither needs a ditherer that accepts the configured request; a mount ditherer never dithers a guided session, and
//   by pulse it needs both positive directions, a finite positive longest pulse and a guide output that pulses;
// - nothing the guiding or the ditherer holds for itself is a device the session commands (the guide camera on the
//   primary camera or on a commanded device included).
export function preflightSequencerGuiding(configuration: SequencerConfiguration, devices: SequencerDevices, services: SequencerGuidingServices, commanded: readonly string[]): SequencerConfigurationDiagnostic[] {
	const { guiding, dither } = configuration
	const diagnostics: SequencerConfigurationDiagnostic[] = []
	const report = (path: string, message: string) => diagnostics.push({ path, message })
	const keys = new Set(commanded)

	if (guiding !== undefined) {
		const session = services.guiding

		if (session === undefined) report('guiding', 'requires a guiding session')
		else {
			const bound = session.pulseQuiescenceBound()
			if (!(guiding.pauseTimeout * 1000 >= bound)) report('guiding.pauseTimeout', `must be at least ${bound / 1000} s, the pulse quiescence bound of the guiding session`)

			if (session instanceof LocalGuidingSession) {
				const longest = session.client.maxPulseDuration()
				if (longest > session.pulseCeiling) report('guiding', `the guider allows ${longest} ms pulses, above the pulse ceiling of ${session.pulseCeiling} ms`)
			} else if (session instanceof PHD2GuidingSession) {
				const { maxGuidePulse, pausedEventAllowance } = session.options
				if (!(maxGuidePulse > 0 && Number.isFinite(maxGuidePulse))) report('guiding', 'the PHD2 session needs a finite positive maxGuidePulse')
				if (pausedEventAllowance !== undefined && !(pausedEventAllowance > 0 && Number.isFinite(pausedEventAllowance))) report('guiding', 'the PHD2 session needs a finite positive pausedEventAllowance')
			}

			for (const request of session.resources().hold) {
				if (keys.has(request.key)) report('guiding', `holds ${request.device?.name ?? request.key}, a device the session commands`)
			}
		}
	}

	if (dither !== undefined) {
		const { ditherer } = services

		if (ditherer === undefined) report('dither', 'requires a ditherer')
		else {
			if (!ditherer.accepts(sequencerDitherRequest(dither))) report('dither', 'the ditherer does not accept its amount or settle')

			if (ditherer instanceof MountDitherer) {
				const { method, rightAscensionDirection, declinationDirection, maxPulseDuration } = ditherer.options
				if (guiding !== undefined) report('dither', 'a mount ditherer cannot dither a guided session')

				if (method === 'pulse') {
					if (rightAscensionDirection === undefined || declinationDirection === undefined) report('dither', 'a pulse mount ditherer needs both positive pulse directions')
					if (!(maxPulseDuration > 0 && Number.isFinite(maxPulseDuration))) report('dither', 'a pulse mount ditherer needs a finite positive maxPulseDuration')
					if (ditherer.guideOutput === undefined || !ditherer.guideOutput.canPulseGuide) report('dither', 'a pulse mount ditherer needs a guide output that can pulse')
				} else if (devices.mount === undefined || resourceKey(devices.mount) !== resourceKey(ditherer.mount)) report('dither', 'a slew mount ditherer must move the mount of the session')
			}

			// A ditherer that is the guiding session was checked with it.
			if ((ditherer as unknown) !== services.guiding) {
				for (const request of ditherer.resources().hold) {
					if (keys.has(request.key)) report('dither', `holds ${request.device?.name ?? request.key}, a device the session commands`)
				}
			}
		}
	}

	return diagnostics
}

// Dither request of the configuration.
export function sequencerDitherRequest(configuration: SequencerDitherConfiguration): DitherRequest {
	return { amount: configuration.amount, raOnly: configuration.raOnly, settle: configuration.settle }
}

const DONE: SequencerTaskResult = { ok: true }

// Light frame guiding: resume, start or recover, each ending on a settle. After a meridian flip of the session the
// guiding calibration is flipped first, once, when configured and supported; a settled guiding completes the guiding
// settle the flip waits for (SETTLING → GUIDING_SETTLED).
async function ensureGuiding(context: SequencerContext, guiding: GuidingSession, configuration: SequencerGuidingConfiguration): Promise<SequencerTaskResult> {
	const { state, clock } = context
	const { settle, maxRecoveries, recalibrate } = configuration
	let last: OperationResult<void> | undefined

	if (state.flipCalibrationPending && configuration.flipCalibration && guiding.flipCalibration !== undefined) {
		const flipped = await guiding.flipCalibration(context.scope)
		if (!flipped.ok) return failedTask(flipped)
		state.flipCalibrationPending = false
	}

	for (let attempt = 0; attempt <= maxRecoveries; attempt++) {
		const current = guiding.state()
		if (current === 'lost') context.emit({ type: 'guidingInterrupted', detail: 'guiding lost' })

		// Guiding that went on through the flip only completes the settle the flip waits for.
		if (current === 'guiding' && !state.intents.recoverGuiding && last === undefined) {
			settleMeridianFlip(context)
			return DONE
		}

		if (current === 'paused' && !state.intents.recoverGuiding && last === undefined) {
			last = await guiding.resume(context.scope, settle)
		} else {
			last = await guiding.start(context.scope, context.reservation, { recalibrate: recalibrate && !state.guidingStarted, settle, clock })
			if (last.ok) state.guidingStarted = true
		}

		if (last.ok && guiding.state() !== 'lost') {
			settleMeridianFlip(context)
			if (!state.intents.recoverGuiding) return DONE
			state.intents.recoverGuiding = false
			return await context.saveCheckpoint()
		}

		if (context.signal.aborted || (!last.ok && last.reason === 'aborted')) break
	}

	return last === undefined || last.ok ? failedTask(failedOperationResult('unexpectedState', 'guiding was lost again after its recoveries')) : failedTask(last)
}

// Completes the guiding settle a meridian flip of the session waits for, emitting its completion.
function settleMeridianFlip(context: SequencerContext) {
	const { configuration, state } = context
	const flip = configuration.meridianFlip
	if (flip?.enabled !== true || state.meridianFlip.phase !== 'SETTLING') return
	const completed = advanceSequencerMeridianFlip(state, toMeridianFlipPolicy(flip, configuration), { type: 'GUIDING_SETTLED' })
	if (completed !== undefined) context.emit(completed)
}

// Task result of a quiescence proof, its failure detail naming the protection outcome.
function quiescenceResult(result: OperationResult<void>, outcome: string): SequencerTaskResult {
	if (result.ok) return DONE
	return { ok: false, failure: { kind: 'operation', reason: result.reason, detail: result.error === undefined ? outcome : `${outcome}: ${result.error}` } }
}

// Guiding stop timeout of the shutdown, in seconds: the hard-protection one with a meridian flip, the step timeout
// otherwise.
function guidingStopTimeout(configuration: Pick<SequencerConfiguration, 'meridianFlip' | 'shutdown'>) {
	const { meridianFlip, shutdown } = configuration
	return meridianFlip?.enabled === true ? (meridianFlip.hardProtection?.guidingStopTimeout ?? DEFAULT_SEQUENCER_MERIDIAN_FLIP.hardProtection.guidingStopTimeout) : shutdown.stepTimeout
}

// Awaits `promise` at most `ms` milliseconds of the monotonic clock; a late outcome is dropped. Leaves no pending
// delay behind.
export async function awaitAtMost(promise: Promise<unknown>, ms: number, clock: SequencerClock) {
	const timer = new AbortController()

	try {
		await Promise.race([promise, clock.delay(ms, timer.signal)])
	} finally {
		timer.abort()
	}
}
