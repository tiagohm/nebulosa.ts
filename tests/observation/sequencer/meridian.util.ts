import { localSiderealTime } from '../../../src/astronomy/observer/location'
import { timeUnix } from '../../../src/astronomy/time/time'
import { SIDEREAL_DAYSEC, SIDEREAL_DRIFT_RATE } from '../../../src/core/constants'
import { GUIDE_PULSE_ACK_MARGIN } from '../../../src/devices/commanders/guideoutput'
import type { PierSide, TrackMode } from '../../../src/devices/indi/device'
import { type Angle, normalizePI } from '../../../src/math/units/angle'
import { mountKeyHolders, type SequencerHardProtectionLead, type SequencerMeridianFlipSettings, type SequencerMountMotionBounds } from '../../../src/observation/sequencer/pointing'
import type { SequencerEvent, SequencerTaskId } from '../../../src/observation/sequencer/sequencer'
import type { DeviceCommandEntry, DeviceLogEntry, DeviceTransitionEntry } from '../../util/rig'
import type { LeaseEntry, RunnerLogEntry, ScriptedGuidingEntry } from './util'

// Oracle of the meridian protection of the Sequencer (section 24, invariants I18, I30, I31, I41, I47, I54, I58–I60 and
// I62–I69). It replays one log merged from the device recorder (or the device log of a fake mount), the runner
// recorder of every process of the session (each entry tagged with the runtime that produced it) and the scripted
// guiding session, all stamped from one test sequence, and recomputes the physical hour angle of the mount from the log
// itself: the apparent local sidereal time at the wall instant of each entry and the published longitude, minus the
// published right ascension. Times are wall instants in ms; the device and runner clocks of a test share them.

// Runner entry of one runtime (one process) of the session.
export type MeridianRunnerEntry = RunnerLogEntry & { readonly runtime: string }

// Command of the scripted guiding session.
export interface MeridianGuidingEntry extends ScriptedGuidingEntry {
	readonly kind: 'guiding'
}

// Entry of the meridian log.
export type MeridianLogEntry = DeviceLogEntry | MeridianRunnerEntry | MeridianGuidingEntry

// Tags the entries of one runner recorder with its runtime.
export function runtimeEntries(entries: readonly RunnerLogEntry[], runtime: string): MeridianRunnerEntry[] {
	return entries.map((entry) => ({ ...entry, runtime }))
}

// Wraps the commands of a scripted guiding session.
export function guidingEntries(entries: readonly ScriptedGuidingEntry[]): MeridianGuidingEntry[] {
	return entries.map((entry) => ({ ...entry, kind: 'guiding' }))
}

// Mount state when the log starts; absent fields are unknown until published.
export interface MeridianMountState {
	readonly tracking: boolean
	readonly pierSide: PierSide
	readonly trackMode?: TrackMode
	// Published right ascension of date, radians.
	readonly rightAscension?: Angle
	// Published longitude, radians.
	readonly longitude?: Angle
}

// What the oracle needs to know about the session.
export interface MeridianProtectionOracleOptions {
	// Name of the mount in the log.
	readonly mount: string
	// Resolved meridian flip of the session (`sequencerMeridianFlipSettings`).
	readonly flip: Pick<SequencerMeridianFlipSettings, 'flipAt' | 'latestAt' | 'protectionMargin' | 'beforeFlipPierSide' | 'afterFlipPierSide' | 'maxRetries' | 'flipTimeout'>
	// Hard protection lead of the session (`meridianHardProtectionLead`); without it the hard deadline and the step
	// durations are not judged (I41, I47).
	readonly lead?: Pick<SequencerHardProtectionLead, 'lead' | 'supervisionJitter' | 'guidingBound' | 'mountMotionReleaseBound' | 'trackingTimeout'>
	readonly initial: MeridianMountState
	// Guide outputs a mount ditherer of the session moves the mount with (`MountDitherer.movement`), by name (I60).
	readonly guideOutputs?: readonly string[]
	// Inherited pulse barrier each runtime installs at its first entry (section 18 step 0a'), on both axes (I60).
	readonly barrier?: { readonly guideOutput: string; readonly maxPulseDuration: number }
	// Persisted `meridianTransitAt` of the session, Unix ms (I66).
	readonly transitAt?: number
	// Whether every light is exposed with the mount under `ensureTracking` (I67).
	readonly lightsTracked?: boolean
	// Release bound, ms, of the roots of each task after their cancellation (`mountKeyHolders`, I59).
	readonly releaseBounds?: Partial<Readonly<Record<SequencerTaskId, number>>>
	// Tolerance, ms, of the instants of the log; default 250.
	readonly tolerance?: number
	// Wall instant the log ends at, when time went on after its last entry (a manual clock); default its last entry.
	readonly endAt?: number
	// Whether a mount without tracking stands still (its hour angle frozen until it publishes a position), as a real
	// mount; false for a fake that keeps its right ascension, and so ages its hour angle, without tracking. Default true.
	readonly standsWithoutTracking?: boolean
}

// Failures of the hard path under which tracking past `latestAt` is a reported outcome, never a violation (I18 c).
const REPORTED_CROSSINGS = new Set(['flipSideUnchanged', 'flipSlewTimeout', 'externalMotion', 'unsupervisedCrossing'])

// Root of the hard path.
const HARD_ROOT = 'sequencer.protect.meridianHard'

// One risk epoch: the mount tracks on its pre-flip side since an arming transition (the first entry of a runtime,
// tracking turned on, the mount reconnected) of `runtime`.
interface Epoch {
	readonly runtime?: string
	readonly armedAt: number
	// A valid `meridianProtectionLateStart` was emitted for it.
	lateStart: boolean
	// `CUSTOM` was observed in it.
	custom: boolean
	// `supervisionLate` was reported in it.
	reportedLate: boolean
	// The hard root started, or the shutdown prefix absorbed it.
	protecting: boolean
	// Wall instant at which the physical hour angle reaches the hard deadline, from the last position tracked outside a
	// slew.
	dueAt?: number
	// Last unwrapped physical hour angle, reset by a slew.
	lastHourAngle?: Angle
	// First entry at which the mount tracked at or past `latestAt`.
	crossing?: { readonly sequence: number; readonly hourAngle: Angle }
}

// Evidence of one dispatched pulse axis (or of the barrier) of a movement guide output.
interface PulseAxis {
	readonly device: string
	readonly axis: 'NS' | 'WE'
	readonly sequence: number
	readonly busyAckDeadline: number
	// A Busy of the axis was observed by a connected view since the dispatch.
	busy: boolean
	// A view observed the axis without a gap since the dispatch, or since the reconnection that republished it.
	continuous: boolean
}

// Tracking off of the mount while it was at risk.
interface Off {
	readonly sequence: number
	readonly wallNow: number
	readonly epoch?: Epoch
	readonly pulsing: boolean
	readonly moving: boolean
	readonly guidingPaused: boolean
}

// Direction and duration, ms, of a guide pulse command of the guide output manager, in its generic form
// `pulse(direction, duration)` or its per-direction form `pulseNorth(duration)`; undefined for any other command.
function guidePulseOf(entry: DeviceCommandEntry): { readonly direction: string; readonly duration: number } | undefined {
	if (entry.manager !== 'guideOutput') return undefined
	if (entry.command === 'pulse') return { direction: entry.args[0] as string, duration: entry.args[1] as number }
	if (entry.command.startsWith('pulse')) return { direction: entry.command.slice('pulse'.length).toUpperCase(), duration: entry.args[0] as number }
	return undefined
}

// Checks the meridian invariants over `log` and throws an Error starting with the invariant id on the first violation:
// - I18 (strong form): within a risk epoch the physical hour angle, unwrapped while no slew is observed, never reaches
//   `latestAt` before the first physical protection (tracking off, or a flip slew that ends on the post-flip side). A
//   crossing is accepted only when the next protection outcome is `meridianProtectionFailed` with a reported reason
//   (`flipSideUnchanged`, `flipSlewTimeout`, `externalMotion`, `unsupervisedCrossing`), `trackRateUnknown` after CUSTOM
//   was observed in the epoch, or `lateStart: true` after a valid late start. A `meridianProtectionLateStart` is valid
//   only before any device command since an arming transition, and no command of another task follows it before the
//   tracking off (only the tracking off, a motion stop and zero pulses);
// - I30: the tracking off of a fulfilled protection follows the guiding pause; no pulse while the guiding is paused;
//   no hard root with tracking off; after a protective tracking off, tracking goes on again only after the flip task
//   evaluated the flip;
// - I31: at most `maxRetries + 1` flipTo across the runtimes, each after a checkpoint saved since its flip task began;
// - I41: the hard root opens at most one supervision jitter after the hard deadline (`latestAt − lead`) is due, after
//   the arming and after the end of a flip slew, unless the epoch reported `supervisionLate`;
// - I47: a hard root that succeeded turned tracking off within `guidingBound + mountMotionReleaseBound` and ended
//   within the steps of the lead;
// - I54: one hard root at a time; none after the tracking off of the shutdown; in the shutdown the guiding is paused
//   before that off and stopped after it; a late epoch never ends in `meridianHardProtection` without `late`;
// - I58: the tracking off of a fulfilled protection finds the mount still and no guide output pulsing;
// - I59: a cancelled root of a task with a release bound ends within it;
// - I60: no `meridianHardProtection` and no end of `quiesceDitherPulses` while a pulse (or the barrier) of a movement
//   guide output is unobserved: its axis neither went Busy and stopped, nor was observed without a gap until its
//   Busy deadline;
// - I62 and I64: a non-sidereal track mode or withdrawn telemetry on a mount at risk is reported before any other
//   command and before the tracking off, unless a protection already runs; a successful hard protection has tracking
//   off observed and reports the physical hour angle;
// - I63: no tracking on, and no goTo ending on the pre-flip side, at or past the graceful deadline
//   (`latestAt − protectionMargin`);
// - I65: every flipTo from the pre-flip side read, every `meridianFlipCompleted` with the post-flip side read, no
//   light exposed after a flipTo before the post-flip side is read nor on NEITHER;
// - I66: no tracking on, flipTo, goTo or exposure outside the meridian cycle of `transitAt`;
// - I67: every light exposed while tracking at the sidereal rate is observed;
// - I68: a flip slew suspends a due hard deadline at most until `flipTimeout` after its dispatch; an `externalMotion`
//   outcome follows a motion stop issued by the hard path;
// - I69: an unsupervised gap ends only in `meridianProtectionFailed { unsupervisedCrossing, lateStart: true }`.
export function assertMeridianProtectionInvariants(log: readonly MeridianLogEntry[], options: MeridianProtectionOracleOptions) {
	const { flip, lead } = options
	const tolerance = options.tolerance ?? 250
	const graceful = flip.latestAt - flip.protectionMargin * SIDEREAL_DRIFT_RATE
	const hardDeadline = lead === undefined ? undefined : flip.latestAt - (lead.lead / 1000) * SIDEREAL_DRIFT_RATE
	const movementOutputs = new Set(options.guideOutputs ?? [])
	const entries = [...log].sort((a, b) => a.sequence - b.sequence)
	const hasRunner = entries.some((entry) => entry.kind === 'event' || entry.kind === 'root')

	const mount = { slewing: false, moving: false, connected: true, hasGeographicCoordinate: true, hasEquatorialCoordinate: true, ...options.initial }
	const pulsing = new Map<string, boolean>()
	const connected = new Map<string, boolean>()
	const frameTypes = new Map<string, unknown>()
	const runtimes = new Set<string>()
	const shutdowns = new Map<string | undefined, { off: boolean }>()
	const roots = new Map<string, { readonly operation: string; readonly wallNow?: number; cancelAt?: number; offAt?: number; succeeded?: boolean; stopped?: boolean }>()
	const axes: PulseAxis[] = []
	const crossings: Epoch[] = []
	const guiding = { active: false, paused: false }
	const flipTask = { started: false, checkpointed: false }

	let runtime: string | undefined
	let wallNow = Number.NaN
	let epoch: Epoch | undefined
	let arming: { commands: number } | undefined
	let lateStartUntilOff = false
	let flips = 0
	let flipDispatchedAt: number | undefined
	let flipPending = false
	let flipSlewing = false
	let lastFlipSlewEnd = Number.NEGATIVE_INFINITY
	let goToHourAngle: Angle | undefined
	let pendingReport: { readonly invariant: 'I62' | 'I64'; readonly sequence: number } | undefined
	let prefixAlive = false
	let lastOff: Off | undefined
	let offBeforeFlipEvaluation = false
	let gap = false

	const atRisk = () => mount.tracking && mount.pierSide !== flip.afterFlipPierSide
	const hardAlive = () => [...roots.values()].some((root) => root.operation === HARD_ROOT)

	// Hour angle at which a mount without tracking stands still, until it publishes a new position.
	let standing: Angle | undefined

	// Physical hour angle at `at`, in (−π, π]: the published position aged at the sidereal rate while tracking, the
	// standing one without tracking; undefined until the position and the longitude are published.
	const stands = options.standsWithoutTracking !== false
	const hourAngleAt = (at: number) => {
		if (stands && standing !== undefined) return standing
		if (mount.rightAscension === undefined || mount.longitude === undefined) return undefined
		return normalizePI(localSiderealTime(timeUnix(at / 1000), mount.longitude) - mount.rightAscension)
	}

	// Physical hour angle at `at`, unwrapped within the epoch while no slew is observed (I69).
	const physicalHourAngle = (at: number) => {
		const hourAngle = hourAngleAt(at)
		if (hourAngle === undefined || epoch === undefined) return hourAngle
		const unwrapped = epoch.lastHourAngle === undefined ? hourAngle : epoch.lastHourAngle + normalizePI(hourAngle - epoch.lastHourAngle)
		epoch.lastHourAngle = unwrapped
		return unwrapped
	}

	const arm = (at: number) => {
		arming = { commands: 0 }
		epoch = atRisk() ? { ...(runtime !== undefined && { runtime }), armedAt: at, lateStart: false, custom: mount.trackMode === 'CUSTOM', reportedLate: false, protecting: hardAlive() || prefixAlive } : undefined
	}

	const withinCycle = (at: number) => options.transitAt === undefined || (at >= options.transitAt - SIDEREAL_DAYSEC * 500 && at < options.transitAt + SIDEREAL_DAYSEC * 500)

	const cycle = (entry: DeviceCommandEntry, what: string) => {
		if (!withinCycle(entry.wallNow)) throw new Error(`I66: ${what} (#${entry.sequence}) outside the meridian cycle of ${options.transitAt}`)
	}

	// Time-based end of the unobserved pulses: no Busy until the deadline under a continuous observation.
	const expirePulses = (at: number) => {
		for (let i = axes.length - 1; i >= 0; i--) {
			const axis = axes[i]
			if (!axis.busy && axis.continuous && at >= axis.busyAckDeadline) axes.splice(i, 1)
		}
	}

	const assertPulsesObserved = (what: string, sequence: number) => {
		if (axes.length > 0) throw new Error(`I60: ${what} (#${sequence}) before the end of the pulse of ${axes[0].device} dispatched at #${axes[0].sequence} was observed`)
	}

	// Strong I18 and the hard deadline (I41, I68), before the entry at `at` changes the state.
	const evaluate = (sequence: number, at: number, reportingLate: boolean) => {
		if (epoch === undefined || !atRisk()) return

		if (flipSlewing) {
			if (lead !== undefined && epoch.dueAt !== undefined && at > epoch.dueAt && !epoch.protecting && flipDispatchedAt !== undefined && at > flipDispatchedAt + flip.flipTimeout * 1000 + lead.supervisionJitter + tolerance) {
				throw new Error(`I68: a due hard deadline was suspended by a flip slew beyond flipTimeout (#${sequence})`)
			}

			return
		}

		const hourAngle = physicalHourAngle(at)
		if (hourAngle === undefined) return

		if (epoch.crossing === undefined && hourAngle >= flip.latestAt) {
			epoch.crossing = { sequence, hourAngle }
			crossings.push(epoch)
		}

		if (lead !== undefined && hardDeadline !== undefined) {
			// Instant the hard deadline is due from the position tracked now; a flip slew keeps the last one.
			epoch.dueAt = at + ((hardDeadline - hourAngle) / SIDEREAL_DRIFT_RATE) * 1000

			if (at >= epoch.dueAt && !epoch.protecting && !epoch.reportedLate && !reportingLate) {
				const reference = Math.max(epoch.dueAt, epoch.armedAt, lastFlipSlewEnd)
				if (at > reference + lead.supervisionJitter + tolerance) throw new Error(`I41: the hard deadline was due at ${epoch.dueAt} and no hard protection began by #${sequence} (${at})`)
			}
		}
	}

	// Pairs the crossings with the protection outcome that follows them (I18).
	const settleCrossings = (event: Extract<SequencerEvent, { type: 'meridianHardProtection' | 'meridianProtectionFailed' }>, sequence: number) => {
		for (const crossed of crossings.splice(0)) {
			const failed = event.type === 'meridianProtectionFailed'
			const accepted = failed && (REPORTED_CROSSINGS.has(event.reason) || (event.reason === 'trackRateUnknown' && crossed.custom) || (event.lateStart && crossed.lateStart))
			if (!accepted) throw new Error(`I18: the mount tracked on its pre-flip side at hour angle ${crossed.crossing!.hourAngle} rad (#${crossed.crossing!.sequence}), at or past latestAt ${flip.latestAt} rad, and ${event.type} (#${sequence}) does not report it`)
		}
	}

	const command = (entry: DeviceCommandEntry) => {
		if (arming !== undefined) arming.commands++

		const isMount = entry.device === options.mount
		const pulse = guidePulseOf(entry)
		const stopping = (isMount && ((entry.command === 'tracking' && entry.args[0] === false) || entry.command === 'stop')) || (pulse !== undefined && !(pulse.duration > 0))

		if (lateStartUntilOff && !stopping) throw new Error(`I18: ${entry.manager} ${entry.command} (#${entry.sequence}) after a late start, before the tracking off`)
		if (pendingReport !== undefined && !stopping) throw new Error(`${pendingReport.invariant}: ${entry.manager} ${entry.command} (#${entry.sequence}) before the report of the unsupervisable mount observed at #${pendingReport.sequence}`)

		if (isMount) {
			switch (entry.command) {
				case 'tracking':
					if (entry.args[0] === true) {
						cycle(entry, 'tracking on')

						if (mount.pierSide !== flip.afterFlipPierSide) {
							const hourAngle = hourAngleAt(entry.wallNow)
							if (hourAngle !== undefined && hourAngle >= graceful) throw new Error(`I63: tracking on (#${entry.sequence}) on the pre-flip side at hour angle ${hourAngle} rad, at or past the graceful deadline ${graceful} rad`)
							if (offBeforeFlipEvaluation) throw new Error(`I30: tracking on (#${entry.sequence}) after a protective tracking off, before the flip was evaluated`)
						}
					}

					break
				case 'flipTo':
					cycle(entry, 'flipTo')
					if (++flips > flip.maxRetries + 1) throw new Error(`I31: flipTo #${flips} (#${entry.sequence}) above the budget of ${flip.maxRetries + 1}`)
					if (hasRunner && flipTask.started && !flipTask.checkpointed) throw new Error(`I31: flipTo (#${entry.sequence}) without a checkpoint saved since its flip task began`)
					if (mount.pierSide !== flip.beforeFlipPierSide) throw new Error(`I65: flipTo (#${entry.sequence}) with the pier side ${mount.pierSide} read, not ${flip.beforeFlipPierSide}`)
					flipDispatchedAt = entry.wallNow
					flipPending = true
					break
				case 'goTo':
				case 'syncTo': {
					cycle(entry, entry.command)
					const lst = mount.longitude === undefined ? undefined : localSiderealTime(timeUnix(entry.wallNow / 1000), mount.longitude)
					if (entry.command === 'goTo') goToHourAngle = lst === undefined ? undefined : normalizePI(lst - (entry.args[0] as Angle))
					break
				}
				case 'stop':
					for (const root of roots.values()) if (root.operation === HARD_ROOT) root.stopped = true
					break
			}

			return
		}

		if (entry.manager === 'camera') {
			if (entry.command === 'frameType') frameTypes.set(entry.device, entry.args[0])
			else if (entry.command === 'startExposure') {
				cycle(entry, 'startExposure')
				const light = frameTypes.get(entry.device) === 'LIGHT'
				if (light && (flipPending || mount.pierSide === 'NEITHER')) throw new Error(`I65: light exposed (#${entry.sequence}) without the post-flip side read`)
				if (light && options.lightsTracked === true && !(mount.tracking && (mount.trackMode === undefined || mount.trackMode === 'SIDEREAL'))) throw new Error(`I67: light exposed (#${entry.sequence}) without sidereal tracking observed`)
			}

			return
		}

		if (pulse !== undefined) {
			const { direction, duration } = pulse
			if (!(duration > 0)) return
			if (guiding.paused) throw new Error(`I30: pulse of ${entry.device} (#${entry.sequence}) while the guiding is paused`)
			if (movementOutputs.has(entry.device)) axes.push({ device: entry.device, axis: direction === 'NORTH' || direction === 'SOUTH' ? 'NS' : 'WE', sequence: entry.sequence, busyAckDeadline: entry.wallNow + duration + GUIDE_PULSE_ACK_MARGIN, busy: false, continuous: connected.get(entry.device) !== false })
		}
	}

	const mountTransition = (entry: DeviceTransitionEntry) => {
		switch (entry.property) {
			case 'tracking': {
				const was = mount.tracking
				const risky = atRisk()
				const offHourAngle = hourAngleAt(entry.wallNow)
				if (was !== (entry.value === true)) {
					// Tracking off freezes the hour angle; tracking on again ages it from where the mount stood.
					const hourAngle = hourAngleAt(entry.wallNow)
					standing = entry.value === true ? undefined : hourAngle
					if (entry.value === true && hourAngle !== undefined && mount.longitude !== undefined) mount.rightAscension = localSiderealTime(timeUnix(entry.wallNow / 1000), mount.longitude) - hourAngle
				}

				mount.tracking = entry.value === true

				if (was && !mount.tracking) {
					if (pendingReport !== undefined && !prefixAlive) throw new Error(`${pendingReport.invariant}: tracking off (#${entry.sequence}) without the report of the unsupervisable mount observed at #${pendingReport.sequence}`)
					pendingReport = undefined
					lateStartUntilOff = false

					// A tracking off is protective inside a protection or at the graceful deadline.
					if (risky && (hardAlive() || prefixAlive || (offHourAngle !== undefined && offHourAngle >= graceful))) offBeforeFlipEvaluation = true

					if (risky) {
						lastOff = { sequence: entry.sequence, wallNow: entry.wallNow, ...(epoch !== undefined && { epoch }), pulsing: [...pulsing.values()].some(Boolean), moving: mount.slewing || mount.moving, guidingPaused: !guiding.active || guiding.paused }
					}

					const shutdown = shutdowns.get(runtime)

					if (shutdown !== undefined && !shutdown.off) {
						if (guiding.active && !guiding.paused) throw new Error(`I54: the shutdown turned tracking off (#${entry.sequence}) before pausing the guiding`)
						shutdown.off = true
					}

					for (const root of roots.values()) if (root.operation === HARD_ROOT && root.offAt === undefined) root.offAt = entry.wallNow
					epoch = undefined
				} else if (!was && mount.tracking) arm(entry.wallNow)

				break
			}
			case 'pierSide':
				mount.pierSide = entry.value as PierSide

				if (mount.pierSide === flip.afterFlipPierSide) {
					flipPending = false
					offBeforeFlipEvaluation = false
					epoch = undefined
				}

				break
			case 'slewing':
				mount.slewing = entry.value === true
				// A slew restarts the unwrapping of the hour angle at both of its edges.
				if (epoch !== undefined) epoch.lastHourAngle = undefined

				if (mount.slewing) {
					if (flipPending && !flipSlewing) flipSlewing = true
				} else {
					if (flipSlewing) {
						flipSlewing = false
						lastFlipSlewEnd = entry.wallNow
					}

					if (goToHourAngle !== undefined && mount.pierSide !== flip.afterFlipPierSide && goToHourAngle >= graceful) throw new Error(`I63: a goTo ended (#${entry.sequence}) on the pre-flip side with the target at hour angle ${goToHourAngle} rad, at or past the graceful deadline`)
					goToHourAngle = undefined
				}

				break
			case 'moving':
				mount.moving = entry.value === true
				break
			case 'equatorialCoordinate':
				mount.rightAscension = (entry.value as { readonly rightAscension: Angle }).rightAscension
				standing = undefined
				if (!mount.tracking) standing = hourAngleAt(entry.wallNow)
				break
			case 'geographicCoordinate':
				mount.longitude = (entry.value as { readonly longitude: Angle }).longitude
				if (!mount.tracking) {
					standing = undefined
					standing = hourAngleAt(entry.wallNow)
				}
				break
			case 'trackMode':
				mount.trackMode = entry.value as TrackMode
				if (mount.trackMode === 'CUSTOM' && epoch !== undefined) epoch.custom = true
				if (mount.trackMode !== 'SIDEREAL' && atRisk() && !hardAlive() && !prefixAlive) pendingReport ??= { invariant: 'I62', sequence: entry.sequence }
				break
			case 'hasGeographicCoordinate':
			case 'hasEquatorialCoordinate':
				mount[entry.property] = entry.value === true
				if (entry.value !== true && atRisk() && !hardAlive() && !prefixAlive) pendingReport ??= { invariant: 'I64', sequence: entry.sequence }
				break
			case 'connected': {
				const was = mount.connected
				mount.connected = entry.value === true
				if (!was && mount.connected) arm(entry.wallNow)
				break
			}
		}
	}

	const guideTransition = (entry: DeviceTransitionEntry) => {
		const { device } = entry

		switch (entry.property) {
			case 'pulsing':
				pulsing.set(device, entry.value === true)
				break
			case 'pulsingNS':
			case 'pulsingWE': {
				const name = entry.property === 'pulsingNS' ? 'NS' : 'WE'

				for (let i = axes.length - 1; i >= 0; i--) {
					const axis = axes[i]
					if (axis.device !== device || axis.axis !== name) continue
					if (entry.value === true) axis.busy = true
					else if (axis.busy) axes.splice(i, 1)
				}

				break
			}
			case 'connected':
				connected.set(device, entry.value === true)

				for (const axis of axes) {
					if (axis.device !== device) continue
					// A disconnection hides the end; the reconnection republishes the axes, observed from then on.
					axis.busy = false
					axis.continuous = entry.value === true
				}

				break
		}
	}

	const event = (event: SequencerEvent, sequence: number) => {
		switch (event.type) {
			case 'taskStarted':
				if (event.task === 'meridianFlip') {
					flipTask.started = true
					flipTask.checkpointed = false
					offBeforeFlipEvaluation = false
				} else if (event.phase === 'shutdown' && (event.task === 'pauseGuiding' || event.task === 'stopTracking')) {
					prefixAlive = true
					if (epoch !== undefined) epoch.protecting = true
				}

				break
			case 'taskCompleted':
			case 'taskFailed':
				if (event.task === 'stopTracking') prefixAlive = false
				if (event.type === 'taskCompleted' && event.task === 'quiesceDitherPulses') assertPulsesObserved('quiesceDitherPulses completed', sequence)
				break
			case 'checkpointSaved':
				if (flipTask.started) flipTask.checkpointed = true
				break
			case 'shutdownStarted':
				shutdowns.set(runtime, { off: !mount.tracking })
				break
			case 'supervisionLate':
				if (epoch !== undefined) epoch.reportedLate = true
				break
			case 'meridianProtectionLateStart':
				if (arming === undefined || arming.commands > 0 || epoch === undefined) throw new Error(`I18: meridianProtectionLateStart (#${sequence}) outside an arming transition`)
				epoch.lateStart = true
				lateStartUntilOff = true
				break
			case 'meridianProtectionTrackModeUnsupervisable':
			case 'meridianProtectionTelemetryUnobserved':
				pendingReport = undefined
				break
			case 'meridianProtectionUnsupervisedGap':
				gap = true
				break
			case 'meridianHardProtection': {
				if (gap) throw new Error(`I69: an unsupervised gap ended in meridianHardProtection (#${sequence})`)
				if (mount.tracking) throw new Error(`I62: meridianHardProtection (#${sequence}) without the tracking off observed`)

				if (lastOff !== undefined) {
					if (lastOff.pulsing) throw new Error(`I58: the tracking off of a fulfilled protection (#${lastOff.sequence}) found a guide output pulsing`)
					if (lastOff.moving) throw new Error(`I58: the tracking off of a fulfilled protection (#${lastOff.sequence}) found the mount moving`)
					if (!lastOff.guidingPaused) throw new Error(`I30: the tracking off of a fulfilled protection (#${lastOff.sequence}) did not follow the guiding pause`)
					if (lastOff.epoch?.lateStart === true && !event.late) throw new Error(`I54: a late epoch ended in meridianHardProtection (#${sequence}) without late`)
				}

				assertPulsesObserved('meridianHardProtection', sequence)

				const hourAngle = mount.slewing ? undefined : hourAngleAt(event.at)
				if (hourAngle !== undefined && !(Math.abs(normalizePI(event.hourAngle - hourAngle)) <= ((tolerance + 1000) / 1000) * SIDEREAL_DRIFT_RATE)) throw new Error(`I64: meridianHardProtection (#${sequence}) reports the hour angle ${event.hourAngle} rad, the physical one is ${hourAngle} rad`)

				for (const root of roots.values()) if (root.operation === HARD_ROOT) root.succeeded = true
				settleCrossings(event, sequence)
				break
			}
			case 'meridianProtectionFailed':
				if (gap && !(event.reason === 'unsupervisedCrossing' && event.lateStart)) throw new Error(`I69: an unsupervised gap ended in meridianProtectionFailed { ${event.reason} } (#${sequence})`)
				gap = false
				if (event.reason === 'externalMotion' && ![...roots.values()].some((root) => root.operation === HARD_ROOT && root.stopped === true)) throw new Error(`I68: externalMotion (#${sequence}) without a motion stop by the hard path`)
				settleCrossings(event, sequence)
				break
			case 'meridianFlipCompleted':
				if (mount.pierSide !== flip.afterFlipPierSide) throw new Error(`I65: meridianFlipCompleted (#${sequence}) with the pier side ${mount.pierSide} read`)
				break
		}
	}

	const root = (entry: Extract<MeridianRunnerEntry, { kind: 'root' }>) => {
		const at = entry.wallNow

		switch (entry.event) {
			case 'start':
				if (entry.operation === HARD_ROOT) {
					if (hardAlive()) throw new Error(`I54: a second hard root (#${entry.sequence}) while one is alive`)
					if (shutdowns.get(runtime)?.off === true) throw new Error(`I54: a hard root (#${entry.sequence}) after the tracking off of the shutdown`)
					if (!mount.tracking) throw new Error(`I30: a hard root (#${entry.sequence}) with tracking off`)
					if (epoch !== undefined) epoch.protecting = true
				} else if (entry.operation === 'sequencer.meridianFlip') {
					flipTask.started = true
					flipTask.checkpointed = false
					offBeforeFlipEvaluation = false
				}

				roots.set(entry.id, { operation: entry.operation, ...(at !== undefined && { wallNow: at }) })
				break
			case 'cancel': {
				const alive = roots.get(entry.id)
				if (alive !== undefined && alive.cancelAt === undefined && at !== undefined) alive.cancelAt = at
				break
			}
			case 'end': {
				const ended = roots.get(entry.id)
				roots.delete(entry.id)
				if (ended === undefined || at === undefined) break

				if (ended.operation === HARD_ROOT && ended.succeeded === true && lead !== undefined && ended.wallNow !== undefined) {
					const steps = lead.guidingBound + lead.mountMotionReleaseBound + lead.trackingTimeout
					if (ended.offAt !== undefined && ended.offAt - ended.wallNow > lead.guidingBound + lead.mountMotionReleaseBound + tolerance) throw new Error(`I47: the hard root (#${entry.sequence}) turned tracking off ${ended.offAt - ended.wallNow} ms after it began, above 2a + 2b`)
					if (at - ended.wallNow > steps + tolerance) throw new Error(`I47: the hard root (#${entry.sequence}) took ${at - ended.wallNow} ms, above the ${steps} ms of its steps`)
				}

				const bound = ended.operation.startsWith('sequencer.') ? options.releaseBounds?.[ended.operation.slice('sequencer.'.length) as SequencerTaskId] : undefined
				if (bound !== undefined && ended.cancelAt !== undefined && at - ended.cancelAt > bound + tolerance) throw new Error(`I59: ${ended.operation} released ${at - ended.cancelAt} ms after its cancellation, above its bound of ${bound} ms`)
				break
			}
		}
	}

	for (const [index, entry] of entries.entries()) {
		const at = entry.kind === 'guiding' ? undefined : entry.kind === 'event' ? entry.event.at : 'wallNow' in entry ? entry.wallNow : undefined
		if (at !== undefined) wallNow = at

		if ((entry.kind === 'event' || entry.kind === 'root' || entry.kind === 'drain' || entry.kind === 'release') && 'runtime' in entry && !runtimes.has(entry.runtime)) {
			runtimes.add(entry.runtime)
			runtime = entry.runtime
			arm(wallNow)
			if (options.barrier !== undefined)
				for (const axis of ['NS', 'WE'] as const) axes.push({ device: options.barrier.guideOutput, axis, sequence: entry.sequence, busyAckDeadline: wallNow + options.barrier.maxPulseDuration + GUIDE_PULSE_ACK_MARGIN, busy: false, continuous: connected.get(options.barrier.guideOutput) !== false })
		} else if (index === 0) arm(wallNow)

		if (!Number.isNaN(wallNow)) {
			// A mount that starts without tracking stands where its first observation finds it.
			if (!mount.tracking && standing === undefined) standing = hourAngleAt(wallNow)
			expirePulses(wallNow)
			evaluate(entry.sequence, wallNow, entry.kind === 'event' && entry.event.type === 'supervisionLate')
		}

		switch (entry.kind) {
			case 'command':
				command(entry)
				break
			case 'transition':
				if (entry.device === options.mount) mountTransition(entry)
				else guideTransition(entry)
				break
			case 'removed':
			case 'added':
				// A removed view hides the end of a pulse; a view added again republishes it, like a reconnection.
				if (entry.device !== options.mount) guideTransition({ ...entry, kind: 'transition', property: 'connected', value: entry.kind === 'added' })
				break
			case 'event':
				event(entry.event, entry.sequence)
				break
			case 'root':
				root(entry)
				break
			case 'guiding':
				switch (entry.command) {
					case 'start':
						guiding.active = true
						guiding.paused = false
						break
					case 'resume':
						guiding.paused = false
						break
					case 'pause':
						guiding.paused = true
						break
					case 'stop':
						if (shutdowns.get(runtime)?.off === false && mount.tracking) throw new Error(`I54: the shutdown stopped the guiding (#${entry.sequence}) before the tracking off`)
						guiding.active = false
						guiding.paused = false
						break
				}

				break
		}
	}

	const endAt = Math.max(wallNow, options.endAt ?? Number.NEGATIVE_INFINITY)
	if (Number.isFinite(endAt)) evaluate(Number.POSITIVE_INFINITY, endAt, false)

	const [crossed] = crossings
	if (crossed !== undefined) throw new Error(`I18: the mount tracked on its pre-flip side at hour angle ${crossed.crossing!.hourAngle} rad (#${crossed.crossing!.sequence}), at or past latestAt ${flip.latestAt} rad, with no protection outcome reporting it`)
}

// Checks the closure of the motion table (49.12 61, I59) over the leases of a run: every root of a built-in task that
// leased the mount key or a movement key of the ditherer has a row in `mountKeyHolders`, and a moving row lists the key
// it leased. Protection and compensation roots are the protection itself. Keys in `coResident` (the primary camera that
// carries the ST4 port of the ditherer) are leased by captures that are no motion, so they are not judged.
export function assertMountKeyClosure(leases: readonly LeaseEntry[], bounds: SequencerMountMotionBounds, coResident: readonly string[] = []) {
	const motion = new Set([...(bounds.mount === undefined ? [] : [bounds.mount]), ...bounds.ditherMovement.map((movement) => movement.request.key)].filter((key) => !coResident.includes(key)))

	for (const { root, keys } of leases) {
		if (!root.startsWith('sequencer.') || root.startsWith('sequencer.protect.') || root.startsWith('sequencer.compensate.')) continue
		const leased = keys.filter((key) => motion.has(key))
		if (leased.length === 0) continue

		const task = root.slice('sequencer.'.length) as SequencerTaskId
		const row = mountKeyHolders(task, bounds)
		if (row === undefined) throw new Error(`I59: ${task} leased ${leased.join(', ')} without a row in mountKeyHolders`)
		for (const key of leased) if (row.keys.length > 0 && !row.keys.includes(key)) throw new Error(`I59: ${task} leased ${key}, outside its row ${row.keys.join(', ')}`)
	}
}
