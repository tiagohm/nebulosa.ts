import { spyOn } from 'bun:test'
import * as fsp from 'node:fs/promises'
import { join, sep } from 'path'
import { equatorialToJ2000 } from '../../../src/astronomy/coordinates/coordinate'
import { localSiderealTime } from '../../../src/astronomy/observer/location'
import { timeUnix } from '../../../src/astronomy/time/time'
import { MountCommander, type MountCommandOptions, type MountFlipResult, type MountSlewResult } from '../../../src/devices/commanders/mount'
import { DEFAULT_MOUNT, type Device, type Mount, type MountTargetCoordinate, type TrackMode } from '../../../src/devices/indi/device'
import { mountTargetEquatorial } from '../../../src/devices/indi/manager/mount'
import { failedOperationResult, type OperationContext, OperationCoordinator, type OperationFailureReason, type OperationHandle, type OperationResult, type OperationScope, successfulOperationResult } from '../../../src/devices/orchestration/operation'
import { ResourceArbiter, type ResourceRequest, type ResourceReservation, type ResourceReservationOwner } from '../../../src/devices/orchestration/resource'
import { type Angle, deg, hour, normalizeAngle, normalizePI } from '../../../src/math/units/angle'
import type { Ditherer, DitherPhase, DitherRequest, DitherResult } from '../../../src/observation/guiding/ditherer'
// oxfmt-ignore
import { type GuidingInterruption, GuidingInterruptionHistory, type GuidingSession, type GuidingSessionState, type GuidingSettle, type GuidingStartOptions } from '../../../src/observation/guiding/session'
import type { SequencerClock, SequencerConfiguration, SequencerEvent, SequencerListener, SequencerSafetySnapshot, SequencerSafetySource, SequencerTarget, SequencerTaskId } from '../../../src/observation/sequencer/sequencer'
import type { SequencerJournalEntry } from '../../../src/observation/sequencer/storage'
import { createTestSequence, type DeviceCommandEntry, type DeviceLogEntry, ManualClock, RECORDED_TRANSITIONS, type RecorderClock, type TestSequence } from '../../util/rig'

// Shared infrastructure of the Sequencer tests over the clock, the INDI simulator rig and the device recorder of
// tests/util/rig: file-system fault injection, the recorders of the runner and the leases, the scripted guiding
// session, safety source and mount, and the invariant oracle over recorded logs. The oracle checks the invariants a
// device log can prove; the ones about Sequencer events join it with the runner that emits them.

// File-system operations the fault injector can count and fail. `sync` and `write` are the methods of the handles
// `open` returns.
export type FileSystemOperation = 'open' | 'writeFile' | 'appendFile' | 'rename' | 'link' | 'copyFile' | 'unlink' | 'stat' | 'sync' | 'write'

// Durable steps a storage crash matrix enumerates by default.
export const DURABLE_FILE_SYSTEM_OPERATIONS: readonly FileSystemOperation[] = ['writeFile', 'appendFile', 'rename', 'link', 'copyFile', 'unlink', 'sync', 'write']

// File-system operation as the injector saw it.
export interface FileSystemEntry {
	readonly kind: 'fs'
	readonly sequence: number
	readonly operation: FileSystemOperation
	readonly paths: readonly string[]
	// Ordinal of the operation among the counted ones, 1-based; absent when it is not counted.
	readonly step?: number
	readonly failed: boolean
}

// Fault plan of one injector.
export interface FileSystemFaultOptions {
	// Counted operation that fails, 1-based; undefined only records.
	readonly failAt?: number
	// Operations counted towards `failAt`. Default DURABLE_FILE_SYSTEM_OPERATIONS.
	readonly operations?: readonly FileSystemOperation[]
	// 'crash' fails every counted operation from `failAt` on, as a dead process would; 'once' only that one.
	readonly mode?: 'once' | 'crash'
	// Error code of the injected failure. Default EIO.
	readonly code?: string
	// For a failing copyFile, bytes of the source written to the destination before the failure (a partial copy).
	readonly partialCopyBytes?: number
	// Error code every `link` throws, uncounted, as on a volume without hard links (EPERM).
	readonly linkError?: string
	// Paths whose operations (when every path an operation touches is spared) are neither counted nor failed, such as
	// the session lock a simulated crash must still release so the same process can play the next one.
	readonly spare?: (path: string) => boolean
	readonly sequence?: TestSequence
}

// Injector over node:fs/promises: the operations it saw and the call that removes it.
export interface FileSystemFaults extends Disposable {
	readonly entries: FileSystemEntry[]
	// Counted operations so far.
	readonly steps: () => number
}

// Wraps the functions of node:fs/promises (named imports included) so the counted operations are logged and the
// `failAt`-th one throws an Error carrying `code`; handles from `open` get their `write` and `sync` wrapped too.
// Only named imports of `fs/promises` are intercepted: a module reaching them through the default export (`fs.link`)
// escapes the injector. Injectors never nest: a second one replaces the first until it is disposed, which also
// removes the first.
export function injectFileSystemFaults(options: FileSystemFaultOptions = {}): FileSystemFaults {
	const { failAt, mode = 'once', code = 'EIO', partialCopyBytes, linkError, spare } = options
	const counted = new Set(options.operations ?? DURABLE_FILE_SYSTEM_OPERATIONS)
	const sequence = options.sequence ?? createTestSequence()
	const entries: FileSystemEntry[] = []
	const restores: VoidFunction[] = []
	let steps = 0

	// Logs one operation and returns whether it must fail.
	const enter = (operation: FileSystemOperation, paths: readonly string[]) => {
		const spared = spare !== undefined && paths.every(spare)
		const step = counted.has(operation) && !spared ? ++steps : undefined
		const failed = step !== undefined && failAt !== undefined && (mode === 'crash' ? step >= failAt : step === failAt)
		entries.push({ kind: 'fs', sequence: sequence.next(), operation, paths, step, failed })
		return failed
	}

	const injected = (operation: FileSystemOperation, paths: readonly string[], error = code) => Object.assign(new Error(`injected ${error} on ${operation} ${paths.join(' ')}`), { code: error })

	const wrap = (operation: Exclude<FileSystemOperation, 'sync' | 'write'>, paths: (args: readonly unknown[]) => readonly string[]) => {
		const target = fsp as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>
		const original = target[operation]
		const spy = spyOn(target, operation).mockImplementation(async (...args: unknown[]) => {
			const touched = paths(args)

			if (operation === 'link' && linkError !== undefined) {
				entries.push({ kind: 'fs', sequence: sequence.next(), operation, paths: touched, failed: true })
				throw injected(operation, touched, linkError)
			}

			if (enter(operation, touched)) {
				if (operation === 'copyFile' && partialCopyBytes !== undefined) {
					const source = await Bun.file(String(args[0])).bytes()
					await Bun.write(String(args[1]), source.subarray(0, partialCopyBytes))
				}

				throw injected(operation, touched)
			}

			const result = await original(...args)
			return operation === 'open' ? wrapHandle(result as fsp.FileHandle, touched[0]) : result
		})
		restores.push(() => spy.mockRestore())
	}

	const wrapHandle = (handle: fsp.FileHandle, path: string) => {
		for (const method of ['write', 'sync'] as const) {
			const original = handle[method].bind(handle) as (...args: unknown[]) => Promise<unknown>
			;(handle as unknown as Record<string, unknown>)[method] = async (...args: unknown[]) => {
				if (enter(method, [path])) throw injected(method, [path])
				return await original(...args)
			}
		}

		return handle
	}

	const first = (args: readonly unknown[]) => [String(args[0])]
	const both = (args: readonly unknown[]) => [String(args[0]), String(args[1])]

	wrap('open', first)
	wrap('writeFile', first)
	wrap('appendFile', first)
	wrap('rename', both)
	wrap('link', both)
	wrap('copyFile', both)
	wrap('unlink', first)
	wrap('stat', first)

	return {
		entries,
		steps: () => steps,
		[Symbol.dispose]: () => {
			for (const restore of restores.toReversed()) restore()
		},
	}
}

// Entry of a Sequencer test log: device commands, transitions and memberships, and file-system operations.
export type SequencerLogEntry = DeviceLogEntry | FileSystemEntry

// What the oracle needs to know about the configuration of the run.
export interface SequencerOracleOptions {
	// Whether a safety snapshot that is not known counts as unsafe, as the Sequencer safety option of that name.
	readonly unknownIsUnsafe?: boolean
	// 0-based wheel slots of the opaque filters of the session; no LIGHT exposure starts on one (I8, I16).
	readonly opaqueSlots?: readonly number[]
	// Whether the darks of the session close the cover ('cover' optical path); no DARK starts unless the cover was
	// observed closed (I8).
	readonly coverDarks?: boolean
}

// Mount commands that move it.
const MOUNT_MOTION_COMMANDS = new Set(['goTo', 'flipTo', 'park', 'unpark', 'home', 'findHome'])
// Manual mount motion commands; only an enabled one moves.
const MOUNT_MANUAL_COMMANDS = new Set(['moveNorth', 'moveSouth', 'moveWest', 'moveEast'])

// Whether a command moves something in the optical train: mount, focuser, wheel, rotator, cover or a guide pulse.
function isMotionCommand(entry: DeviceCommandEntry) {
	switch (entry.manager) {
		case 'mount':
			return MOUNT_MOTION_COMMANDS.has(entry.command) || (MOUNT_MANUAL_COMMANDS.has(entry.command) && entry.args[0] === true)
		case 'focuser':
		case 'wheel':
		case 'rotator':
			return entry.command.startsWith('move')
		case 'cover':
			return entry.command === 'park' || entry.command === 'unpark'
		case 'guideOutput':
			return true
		default:
			return false
	}
}

// Whether a mount command moves the mount, the subject of I14.
function isMountMotion(entry: DeviceCommandEntry) {
	return entry.manager === 'mount' && isMotionCommand(entry)
}

// Whether a command opens the optical path or the observatory to the sky, the subject of I15.
function isOpening(entry: DeviceCommandEntry) {
	return (entry.manager === 'cover' && entry.command === 'unpark') || (entry.manager === 'mount' && entry.command === 'unpark') || (entry.manager === 'dome' && (entry.command === 'unpark' || entry.command === 'openShutter'))
}

// Checks the invariants a log of device commands, transitions and file operations can prove, and throws an Error
// starting with the invariant id on the first violation:
// - I2: no motion command (mount, focuser, wheel, rotator, cover, guide pulse) between a startExposure and the end of
//   that exposure, observed as its camera `exposuring` turning false;
// - I14: no mount motion while any guide output reports `pulsing` (the Sequencer half, pause() resolved before the
//   motion, joins the oracle with the guiding events);
// - I15: no opening (dome unpark or shutter opening, cover or mount unpark) while the last safety snapshot is unsafe, or unknown with
//   `unknownIsUnsafe`;
// - I8 and I16: no exposure of frame type LIGHT (primary, centering or autofocus alike) starts with a cover observed
//   closed, a flat panel observed lit, or a wheel observed on one of `opaqueSlots`; with `coverDarks`, no
//   DARK starts unless every cover was observed closed. The frame type of an exposure is the last one commanded to its
//   camera; a state never observed in the log counts as the open path the rig reset leaves.
export function assertSequencerInvariants(log: readonly SequencerLogEntry[], options: SequencerOracleOptions = {}) {
	const entries = [...log].sort((a, b) => a.sequence - b.sequence)
	const exposing = new Set<string>()
	const pulsing = new Set<string>()
	const frameTypes = new Map<string, unknown>()
	const covers = new Map<string, boolean>()
	const lit = new Set<string>()
	const wheels = new Map<string, unknown>()
	const opaque = new Set(options.opaqueSlots)
	let safe: boolean | undefined

	for (const entry of entries) {
		if (entry.kind === 'transition') {
			if (entry.manager === 'cover' && entry.property === 'parked') covers.set(entry.device, entry.value === true)
			else if (entry.manager === 'flatPanel' && entry.property === 'enabled') {
				if (entry.value === true) lit.add(entry.device)
				else lit.delete(entry.device)
			} else if (entry.manager === 'wheel' && entry.property === 'position') wheels.set(entry.device, entry.value)
			else if (entry.property === 'exposuring' && entry.value === false) exposing.delete(entry.device)
			else if (entry.property === 'pulsing') {
				if (entry.value === true) pulsing.add(entry.device)
				else pulsing.delete(entry.device)
			} else if (entry.property === 'safe') safe = entry.value === true
			continue
		}

		if (entry.kind !== 'command') continue

		if (isMotionCommand(entry) && exposing.size > 0) {
			throw new Error(`I2: ${entry.manager} ${entry.command} on ${entry.device} (#${entry.sequence}) while ${[...exposing].join(', ')} is exposing`)
		}

		if (isMountMotion(entry) && pulsing.size > 0) {
			throw new Error(`I14: mount ${entry.command} on ${entry.device} (#${entry.sequence}) while ${[...pulsing].join(', ')} is pulsing`)
		}

		if (isOpening(entry) && (safe === false || (safe === undefined && options.unknownIsUnsafe === true))) {
			throw new Error(`I15: ${entry.manager} ${entry.command} on ${entry.device} (#${entry.sequence}) with the safety ${safe === undefined ? 'unknown' : 'unsafe'}`)
		}

		if (entry.manager === 'camera' && entry.command === 'frameType') frameTypes.set(entry.device, entry.args[0])

		if (entry.manager === 'camera' && entry.command === 'startExposure') {
			const frameType = frameTypes.get(entry.device)

			if (frameType === 'LIGHT') {
				const closed = [...covers].find(([, parked]) => parked)?.[0]
				if (closed !== undefined) throw new Error(`I8: LIGHT exposure on ${entry.device} (#${entry.sequence}) with the cover ${closed} closed`)
				if (lit.size > 0) throw new Error(`I8: LIGHT exposure on ${entry.device} (#${entry.sequence}) with the flat panel ${[...lit].join(', ')} lit`)
				const blocked = [...wheels].find(([, position]) => opaque.has(position as number))?.[0]
				if (blocked !== undefined) throw new Error(`I8: LIGHT exposure on ${entry.device} (#${entry.sequence}) with the wheel ${blocked} on an opaque filter`)
			} else if (frameType === 'DARK' && options.coverDarks === true && (covers.size === 0 || [...covers.values()].some((parked) => !parked))) {
				throw new Error(`I8: DARK exposure on ${entry.device} (#${entry.sequence}) without the cover observed closed`)
			}

			exposing.add(entry.device)
		}
	}
}

// Root operation of the reservation as the runner recorder saw it.
export interface RunnerRootEntry {
	readonly kind: 'root'
	readonly sequence: number
	readonly event: 'start' | 'cancel' | 'end'
	// Operation id.
	readonly id: string
	// Operation kind, such as `sequencer.autofocus` or `sequencer.compensate.focuserPosition`.
	readonly operation: string
	// Reason of a cancel, or of a failed end.
	readonly reason?: OperationFailureReason
	// Detail of a failed end.
	readonly error?: string
	// Whether an ended root succeeded.
	readonly ok?: boolean
	// Wall instant of the entry, with a recorder clock.
	readonly wallNow?: number
}

// Drain of the reservation: `terminal` is cancelByReservationOwner, otherwise drainByReservationOwner.
export interface RunnerDrainEntry {
	readonly kind: 'drain'
	readonly sequence: number
	readonly event: 'begin' | 'end'
	readonly terminal: boolean
}

// Release of the session reservation.
export interface RunnerReleaseEntry {
	readonly kind: 'release'
	readonly sequence: number
}

// Event of the session.
export interface RunnerEventEntry {
	readonly kind: 'event'
	readonly sequence: number
	readonly event: SequencerEvent
	// Wall instant of the entry, with a recorder clock.
	readonly wallNow?: number
}

// Entry of the runner log.
export type RunnerLogEntry = RunnerRootEntry | RunnerDrainEntry | RunnerReleaseEntry | RunnerEventEntry

// Recorder of one runner: the entries in order, the listener to give the session, and the call that stops recording.
export interface RunnerRecorder extends Disposable {
	readonly entries: RunnerLogEntry[]
	readonly listener: SequencerListener
	// Owner of the first reservation the session took; absent before it.
	readonly reservationOwner?: ResourceReservationOwner
}

// Records, in one sequence, the roots the session opens in its reserved scopes (start, cancel through the handle,
// end with its result), the drains of the reservation, the release of the reservation and the session events, by
// wrapping the coordinator and its arbiter. The wrappers only observe. With `clock`, roots and events carry the wall
// instant they were recorded at.
export function recordRunner(coordinator: OperationCoordinator, sequence: TestSequence = createTestSequence(), clock?: Pick<RecorderClock, 'wallNow'>): RunnerRecorder {
	const entries: RunnerLogEntry[] = []
	let owner: ResourceReservationOwner | undefined
	const restores: VoidFunction[] = []
	const stamp = () => (clock === undefined ? {} : { wallNow: clock.wallNow() })
	const push = (entry: Omit<RunnerRootEntry, 'sequence'> | Omit<RunnerDrainEntry, 'sequence'> | Omit<RunnerReleaseEntry, 'sequence'>) => entries.push({ ...entry, sequence: sequence.next(), ...(entry.kind === 'root' && stamp()) })

	const wrapHandle = <T>(handle: OperationHandle<T>): OperationHandle<T> => {
		const operation = handle.kind
		push({ kind: 'root', event: 'start', id: handle.id, operation })
		void handle.result.then((result) => push({ kind: 'root', event: 'end', id: handle.id, operation, ok: result.ok, ...(!result.ok && { reason: result.reason, error: result.error }) }))

		return Object.freeze({
			...handle,
			cancel: (reason: OperationFailureReason = 'aborted') => {
				push({ kind: 'root', event: 'cancel', id: handle.id, operation, reason })
				return handle.cancel(reason)
			},
		})
	}

	const reservedScope = coordinator.reservedScope.bind(coordinator)
	const scopeSpy = spyOn(coordinator, 'reservedScope').mockImplementation((reservation: ResourceReservation): OperationScope => {
		const scope = reservedScope(reservation)
		return { start: (kind, resources, executor) => wrapHandle(scope.start(kind, resources, executor)) }
	})
	restores.push(() => scopeSpy.mockRestore())

	const drain = coordinator.drainByReservationOwner.bind(coordinator)
	const drainSpy = spyOn(coordinator, 'drainByReservationOwner').mockImplementation(async (...args: Parameters<typeof drain>) => {
		push({ kind: 'drain', event: 'begin', terminal: false })
		await drain(...args)
		push({ kind: 'drain', event: 'end', terminal: false })
	})
	restores.push(() => drainSpy.mockRestore())

	const cancel = coordinator.cancelByReservationOwner.bind(coordinator)
	const cancelSpy = spyOn(coordinator, 'cancelByReservationOwner').mockImplementation(async (...args: Parameters<typeof cancel>) => {
		push({ kind: 'drain', event: 'begin', terminal: true })
		await cancel(...args)
		push({ kind: 'drain', event: 'end', terminal: true })
	})
	restores.push(() => cancelSpy.mockRestore())

	const reserve = coordinator.arbiter.reserve.bind(coordinator.arbiter)
	const reserveSpy = spyOn(coordinator.arbiter, 'reserve').mockImplementation((...args: Parameters<typeof reserve>) => {
		const reserved = reserve(...args)
		if (!reserved.ok) return reserved
		owner ??= args[0]
		const { reservation } = reserved
		let released = false

		return {
			ok: true,
			reservation: {
				ownerId: reservation.ownerId,
				token: reservation.token,
				get resources() {
					return reservation.resources
				},
				release: () => {
					if (!released) push({ kind: 'release' })
					released = true
					reservation.release()
				},
			},
		}
	})
	restores.push(() => reserveSpy.mockRestore())

	return {
		entries,
		get reservationOwner() {
			return owner
		},
		listener: (event) => entries.push({ kind: 'event', sequence: sequence.next(), event, ...stamp() }),
		[Symbol.dispose]: () => {
			for (const restore of restores.toReversed()) restore()
		},
	}
}

// Shutdown tasks, whose roots are never cancelled by a stop.
const SHUTDOWN_TASKS = new Set<string>(['pauseGuiding', 'stopTracking', 'stopGuiding', 'closeCover', 'parkMount', 'closeOrParkDome', 'turnOffFlatPanel', 'warmCamera'] satisfies SequencerTaskId[])

// Whether a root kind is a shutdown step.
function isShutdownRoot(operation: string) {
	return operation.startsWith('sequencer.') && SHUTDOWN_TASKS.has(operation.slice('sequencer.'.length))
}

// Whether a root kind is a run task: neither a compensation, a protection nor a shutdown step.
function isRunRoot(operation: string) {
	return operation.startsWith('sequencer.') && !operation.startsWith('sequencer.compensate.') && !operation.startsWith('sequencer.protect.') && !isShutdownRoot(operation)
}

// What the runner oracle needs to know about the run.
export interface RunnerOracleOptions {
	// Whether the session was disposed, which may cancel the shutdown.
	readonly disposed?: boolean
}

// Checks the invariants a runner log can prove, and throws an Error starting with the invariant id on the first
// violation:
// - I12: one terminal event at most, after the single release; the release comes after the terminal drain and
//   after every root ended; no root starts after it;
// - I13: no shutdown root is cancelled for anything but its timeout, unless the session was disposed;
// - I17: every compensation root starts with no run task root alive, before any shutdown root and before the release;
// - I42 (drain half): no drainByReservationOwner begins while a cancelled run task root has not ended yet.
export function assertRunnerInvariants(log: readonly RunnerLogEntry[], options: RunnerOracleOptions = {}) {
	const entries = [...log].sort((a, b) => a.sequence - b.sequence)
	const started = entries.some((entry) => entry.kind === 'event' && entry.event.type === 'sessionStarted')
	const alive = new Map<string, string>()
	const cancelled = new Set<string>()
	let released = false
	let terminalDrained = false
	let shutdownStarted = false
	let terminals = 0

	for (const entry of entries) {
		switch (entry.kind) {
			case 'root':
				if (entry.event === 'start') {
					if (released) throw new Error(`I12: root ${entry.operation} (#${entry.sequence}) started after the release`)

					if (entry.operation.startsWith('sequencer.compensate.')) {
						const run = [...alive.values()].find(isRunRoot)
						if (run !== undefined) throw new Error(`I17: compensation ${entry.operation} (#${entry.sequence}) started while ${run} is alive`)
						if (shutdownStarted) throw new Error(`I17: compensation ${entry.operation} (#${entry.sequence}) started after the shutdown`)
					}

					if (isShutdownRoot(entry.operation)) shutdownStarted = true
					alive.set(entry.id, entry.operation)
				} else if (entry.event === 'cancel') {
					if (isShutdownRoot(entry.operation) && entry.reason !== 'timeout' && options.disposed !== true) throw new Error(`I13: shutdown root ${entry.operation} (#${entry.sequence}) cancelled with ${entry.reason}`)
					if (alive.has(entry.id)) cancelled.add(entry.id)
				} else {
					alive.delete(entry.id)
					cancelled.delete(entry.id)
				}
				break
			case 'drain':
				if (entry.event === 'begin' && !entry.terminal) {
					const pending = [...cancelled].map((id) => alive.get(id) ?? '').find(isRunRoot)
					if (pending !== undefined) throw new Error(`I42: drain (#${entry.sequence}) began before the cancelled root ${pending} ended`)
				}
				if (entry.event === 'end' && entry.terminal) terminalDrained = true
				break
			case 'release':
				if (released) throw new Error(`I12: reservation released twice (#${entry.sequence})`)
				if (!terminalDrained) throw new Error(`I12: reservation released (#${entry.sequence}) before the terminal drain`)
				if (alive.size > 0) throw new Error(`I12: reservation released (#${entry.sequence}) while ${[...alive.values()].join(', ')} is alive`)
				released = true
				break
			case 'event': {
				const { type } = entry.event

				if (type === 'sessionCompleted' || type === 'sessionStopped' || type === 'sessionFailed') {
					if (++terminals > 1) throw new Error(`I12: second terminal event ${type} (#${entry.sequence})`)
					if (started && !released) throw new Error(`I12: terminal event ${type} (#${entry.sequence}) before the release`)
				}
			}
		}
	}
}

// Checks the invariants a session journal, with the events of the same session when given, can prove, and throws an
// Error starting with the invariant id on the first violation:
// - I11: at most one committed final per slot and per final path, always the final its prepared line reserved;
// - I36: no attempt is prepared while another one is still open (its last line `prepared`), and no attempt is deferred
//   once it produced a transaction;
// - I49: every final and discarded destination ends in `.fit` but not `.partial.fit`, every temporary in
//   `.partial.fit`, and the final of an attempt never changes between prepared, promoting and committed;
// - I4 (journal half): every frameAccepted event has the committed line of its attempt, with its final;
// - I20 (with `configuration`): the slots selected for a triggered group (by frameSelected events) and the batches its
//   triggerFired events enqueued never exceed its `maxFrames`, and no ordinal of it lies beyond.
export function assertJournalInvariants(journal: readonly SequencerJournalEntry[], events: readonly SequencerEvent[] = [], configuration?: Pick<SequencerConfiguration, 'capture'>) {
	const finals = new Map<string, string>()
	const committedSlots = new Set<string>()
	const committedFinals = new Set<string>()
	const committed = new Map<string, string>()
	const transactions = new Set<string>()
	let open: string | undefined

	const isFinal = (path: string) => path.endsWith('.fit') && !path.endsWith('.partial.fit')

	for (const [i, entry] of journal.entries()) {
		if (entry.kind === 'lockReclaimed') continue
		const key = `${entry.slot}#${entry.attempt}`

		switch (entry.kind) {
			case 'prepared':
				if (open !== undefined && open !== key) throw new Error(`I36: ${key} prepared (line ${i + 1}) while ${open} is open`)
				if (!entry.temporary.endsWith('.partial.fit') || !isFinal(entry.final)) throw new Error(`I49: ${key} prepared with ${entry.temporary} and ${entry.final} (line ${i + 1})`)
				if (finals.has(key) && finals.get(key) !== entry.final) throw new Error(`I49: final of ${key} changed to ${entry.final} (line ${i + 1})`)
				finals.set(key, entry.final)
				open = key
				break
			case 'deferred':
				if (transactions.has(key)) throw new Error(`I36: ${key} deferred after its transaction (line ${i + 1})`)
				if (open === key) open = undefined
				break
			case 'promoting':
			case 'committed':
				if (entry.final !== finals.get(key)) throw new Error(`I49: ${entry.kind} of ${key} with final ${entry.final} instead of ${finals.get(key)} (line ${i + 1})`)
				transactions.add(key)
				if (open === key) open = undefined

				if (entry.kind === 'committed') {
					if (committedSlots.has(entry.slot) && committed.get(entry.slot) !== key) throw new Error(`I11: second committed final of ${entry.slot} (line ${i + 1})`)
					if (committedFinals.has(entry.final) && committed.get(entry.slot) !== key) throw new Error(`I11: ${entry.final} committed twice (line ${i + 1})`)
					committedSlots.add(entry.slot)
					committedFinals.add(entry.final)
					committed.set(entry.slot, key)
				}

				break
			case 'disposing':
				if (entry.destination !== undefined && !isFinal(entry.destination)) throw new Error(`I49: ${key} disposed of to ${entry.destination} (line ${i + 1})`)
				transactions.add(key)
				if (open === key) open = undefined
				break
			case 'disposed':
			case 'abandoned':
				if (open === key) open = undefined
		}
	}

	for (const event of events) {
		if (event.type !== 'frameAccepted') continue
		const key = `${event.slot}#${event.attempt}`
		const final = finals.get(key)
		if (committed.get(event.slot) !== key || final === undefined || !event.path.split(sep).join('/').endsWith(`/${final}`)) throw new Error(`I4: frameAccepted ${key} at ${event.path} without its committed line`)
	}

	if (configuration === undefined) return

	for (const group of configuration.capture.groups) {
		if (group.kind !== 'triggered') continue
		const slots = new Set<string>()
		let enqueued = 0

		for (const event of events) {
			if (event.type === 'frameSelected' && event.frame.groupId === group.id) {
				slots.add(event.frame.id)
				if (event.frame.ordinal > group.maxFrames) throw new Error(`I20: ${event.frame.id} beyond the ${group.maxFrames} frames of ${group.id}`)
			} else if (event.type === 'triggerFired' && event.groupId === group.id) enqueued += event.slots
		}

		if (slots.size > group.maxFrames) throw new Error(`I20: ${slots.size} slots of ${group.id} beyond its ${group.maxFrames} frames`)
		if (enqueued > group.maxFrames) throw new Error(`I20: ${enqueued} slots enqueued for ${group.id} beyond its ${group.maxFrames} frames`)
	}
}

// Behaviour of one command of a scripted guiding session: its result, possibly after a wait the test controls.
export type ScriptedGuidingStep = (scope: OperationContext) => OperationResult<void> | Promise<OperationResult<void>>

// One command the scripted guiding session received, in the shared sequence of the test.
export interface ScriptedGuidingEntry {
	readonly sequence: number
	readonly command: 'beginRun' | 'endRun' | 'start' | 'stop' | 'pause' | 'resume' | 'flipCalibration' | 'dither'
	// Recalibration of a start.
	readonly recalibrate?: boolean
}

// Options of a scripted guiding session.
export interface ScriptedGuidingSessionOptions {
	// Resources reserved; default one logical guider resource.
	readonly reserve?: readonly ResourceRequest[]
	// Resources held by the root `guiding`; default the reserved ones.
	readonly hold?: readonly ResourceRequest[]
	// Pulse quiescence bound, in ms; default 1000.
	readonly bound?: number
	// Capacity of the interruption history; default 256.
	readonly capacity?: number
}

// Guiding session and ditherer of the unit and e2e tests (50.1): a state machine without devices whose commands follow a
// script, open a real root `guiding` under the reservation they are given, settle at once by default, and record every
// command in the shared sequence. Interruptions are recorded by `interrupt`.
export class ScriptedGuidingSession implements GuidingSession, Ditherer {
	readonly log: ScriptedGuidingEntry[] = []
	current: GuidingSessionState = 'stopped'
	beginRunResult: OperationResult<void> = successfulOperationResult(undefined)
	onStart: ScriptedGuidingStep = () => successfulOperationResult(undefined)
	onPause: ScriptedGuidingStep = () => successfulOperationResult(undefined)
	onResume: ScriptedGuidingStep = () => successfulOperationResult(undefined)
	onDither: ScriptedGuidingStep = () => successfulOperationResult(undefined)
	// Successful starts that still leave the session lost (recoveries that do not hold).
	loseAfterStart = 0
	readonly #history: GuidingInterruptionHistory
	readonly #sequence: TestSequence
	#root?: { readonly handle: OperationHandle<void>; readonly id: string; readonly finish: VoidFunction }

	constructor(
		readonly options: ScriptedGuidingSessionOptions = {},
		sequence: TestSequence = createTestSequence(),
	) {
		this.#sequence = sequence
		this.#history = new GuidingInterruptionHistory(options.capacity)
	}

	// Commands received, in order.
	commands() {
		return this.log.map((entry) => entry.command)
	}

	beginRun() {
		this.#record('beginRun')
		return this.beginRunResult
	}

	endRun() {
		this.#record('endRun')
	}

	preflight(report: (message: string) => void) {}

	resources() {
		const reserve = this.options.reserve ?? [{ key: 'logical:scripted-guider' }]
		return { reserve, hold: this.options.hold ?? reserve }
	}

	state() {
		return this.current
	}

	async start(task: OperationScope, reservation: OperationScope, options: GuidingStartOptions) {
		this.#record('start', options.recalibrate)

		if (this.#root === undefined) {
			let opened: { readonly id: string; readonly finish: VoidFunction } | undefined
			const handle = reservation.start<void>(
				'guiding',
				this.resources().hold,
				(context) =>
					new Promise((resolve) => {
						opened = { id: context.id, finish: () => resolve(successfulOperationResult(undefined)) }
						context.signal.addEventListener(
							'abort',
							() => {
								this.current = 'lost'
								this.#root = undefined
								resolve(failedOperationResult('aborted'))
							},
							{ once: true },
						)
					}),
			)
			if (opened === undefined) return await handle.result
			this.#root = { handle, ...opened }
		}

		const started = await task.start('scriptedStart', [], (context) => this.onStart(context)).result
		if (started.ok) this.current = this.loseAfterStart-- > 0 ? 'lost' : 'guiding'
		return started
	}

	async stop() {
		this.#record('stop')
		this.current = 'stopped'
		const root = this.#root
		this.#root = undefined
		root?.finish()
		if (root !== undefined) await root.handle.result
		return successfulOperationResult(undefined)
	}

	async pause(scope: OperationScope) {
		this.#record('pause')
		const paused = await scope.start('scriptedPause', [], (context) => this.onPause(context)).result
		if (paused.ok && (this.current === 'guiding' || this.current === 'settling' || this.current === 'calibrating')) this.current = 'paused'
		return paused
	}

	pulseQuiescenceBound() {
		return this.options.bound ?? 1000
	}

	async resume(scope: OperationScope, _settle: GuidingSettle) {
		this.#record('resume')
		const resumed = await scope.start('scriptedResume', [], (context) => this.onResume(context)).result
		if (resumed.ok) this.current = 'guiding'
		return resumed
	}

	flipCalibration() {
		this.#record('flipCalibration')
		return Promise.resolve(successfulOperationResult(undefined))
	}

	interruptions(fromMonotonic: number, toMonotonic: number) {
		return this.#history.query(fromMonotonic, toMonotonic)
	}

	// Records one interruption.
	interrupt(interruption: GuidingInterruption) {
		this.#history.record(interruption)
	}

	operationId() {
		return this.#root?.id
	}

	accepts(_request: DitherRequest) {
		return true
	}

	ready() {
		return this.current === 'guiding' || this.current === 'settling'
	}

	async dither(scope: OperationScope, _request: DitherRequest, onPhase?: (phase: DitherPhase) => void): Promise<OperationResult<DitherResult>> {
		this.#record('dither')
		onPhase?.('dithering')
		const dithered = await scope.start('scriptedDither', [], (context) => {
			onPhase?.('dithered')
			onPhase?.('settling')
			return this.onDither(context)
		}).result
		if (!dithered.ok) return dithered
		onPhase?.('settled')
		return successfulOperationResult<DitherResult>({ kind: 'guider', lockShift: [1, 1] })
	}

	#record(command: ScriptedGuidingEntry['command'], recalibrate?: boolean) {
		this.log.push(recalibrate === undefined ? { sequence: this.#sequence.next(), command } : { sequence: this.#sequence.next(), command, recalibrate })
	}
}

// Safety source of the unit and e2e tests (50.1): `publish` notifies the subscribers synchronously, in subscription
// order, and `current()` always returns the last published snapshot; reads and live subscriptions are counted. It never
// replays the current state to a new subscriber, as the contract of the source requires.
export class ScriptedSafetySource implements SequencerSafetySource {
	#snapshot: SequencerSafetySnapshot
	readonly #listeners = new Set<(snapshot: SequencerSafetySnapshot) => void>()
	reads = 0

	constructor(state: SequencerSafetySnapshot['state'] = 'safe') {
		this.#snapshot = { state }
	}

	// Live subscriptions.
	get subscriptions() {
		return this.#listeners.size
	}

	readonly current = () => {
		this.reads++
		return this.#snapshot
	}

	readonly subscribe = (listener: (snapshot: SequencerSafetySnapshot) => void) => {
		this.#listeners.add(listener)
		return () => {
			this.#listeners.delete(listener)
		}
	}

	// Publishes `state` (with an optional `detail`) to every subscriber.
	publish(state: SequencerSafetySnapshot['state'], detail?: string) {
		this.#snapshot = detail === undefined ? { state } : { state, detail }
		for (const listener of Array.from(this.#listeners)) listener(this.#snapshot)
	}
}

// Shared order of the fakes of a test file (mount commands, checkpoint saves), increasing across tests.
let fakeOrder = 0

// Next value of the shared order of the fakes.
export function nextFakeOrder() {
	return ++fakeOrder
}

// Mount command as the fake recorded it.
export interface FakeCommand {
	readonly command: 'tracking' | 'trackMode' | 'flipTo' | 'goTo' | 'stop'
	readonly args: readonly unknown[]
	readonly wallNow: number
	readonly order: number
}

// Behaviour of one flip command of the fake.
export type FlipBehaviour = (context: OperationContext, target: MountTargetCoordinate<string | Angle>, options: MountCommandOptions) => OperationResult<MountFlipResult> | Promise<OperationResult<MountFlipResult>>

// Fake mount at a published site of longitude 0, with its commander and change notifications: it reports the hour
// angle it was placed at for the current wall instant of `clock`, tracking at the sidereal rate, and leases itself for
// every command like the real commander. Commands are stamped with `nextFakeOrder`.
export class FakeMount<C extends Pick<SequencerClock, 'wallNow'> = ManualClock> {
	readonly mount: Mount
	readonly commands: FakeCommand[] = []
	// Device log of the fake in `sequence`, as the rig recorder would write it: every command before it acts and every
	// change of a recorded field, stamped with the wall instant of the clock in both domains.
	readonly entries: DeviceLogEntry[] = []
	// State of the mount when the fake was created, the start of its log.
	readonly initial: Readonly<Pick<Mount, 'tracking' | 'pierSide' | 'trackMode'>> & { readonly rightAscension: Angle; readonly longitude: Angle }
	readonly #listeners = new Set<VoidFunction>()
	// Failure of every tracking switch while set.
	trackingFailure?: OperationResult<void>
	flipBehaviour: FlipBehaviour = () => this.succeed()
	// Whether the driver turns tracking on with every slew (TRACK in its ON_COORD_SET).
	trackOnSlew = false
	// Duration, ms, of a goTo slew on the delay of the clock; 0 arrives at once.
	slewTime = 0

	constructor(
		readonly clock: C,
		hourAngle: Angle,
		state: Partial<Pick<Mount, 'tracking' | 'pierSide' | 'trackMode'>> = {},
		readonly sequence: TestSequence = createTestSequence(),
	) {
		this.mount = {
			...DEFAULT_MOUNT,
			id: 'Mount',
			name: 'Mount',
			hardwareId: 'Mount',
			connected: true,
			canFlip: true,
			canTracking: true,
			canAbort: true,
			canGoTo: true,
			hasPierSide: true,
			hasGeographicCoordinate: true,
			hasEquatorialCoordinate: true,
			trackModes: ['SIDEREAL', 'LUNAR', 'CUSTOM'],
			trackMode: state.trackMode ?? 'SIDEREAL',
			tracking: state.tracking ?? false,
			pierSide: state.pierSide ?? 'WEST',
			geographicCoordinate: { latitude: 0, longitude: 0, elevation: 0 },
			equatorialCoordinate: { rightAscension: 0, declination: deg(-30) },
		}
		this.place(hourAngle)
		this.initial = { tracking: this.mount.tracking, pierSide: this.mount.pierSide, trackMode: this.mount.trackMode, rightAscension: this.mount.equatorialCoordinate.rightAscension, longitude: this.mount.geographicCoordinate.longitude }
		this.entries.length = 0
	}

	// Apparent local sidereal time at the clock.
	lst() {
		return localSiderealTime(timeUnix(this.clock.wallNow() / 1000), this.mount.geographicCoordinate.longitude)
	}

	// Physical hour angle at the clock.
	hourAngle() {
		return normalizePI(this.lst() - this.mount.equatorialCoordinate.rightAscension)
	}

	// Publishes the position whose hour angle is `hourAngle` now.
	place(hourAngle: Angle) {
		;(this.mount.equatorialCoordinate as { rightAscension: Angle }).rightAscension = normalizeAngle(this.lst() - hourAngle)
		this.#transition('equatorialCoordinate')
		this.notify()
	}

	set(patch: Partial<Mount>) {
		const fields = this.mount as unknown as Record<string, unknown>
		const changed = Object.entries(patch).filter(([field, value]) => RECORDED_TRANSITIONS.has(field) && fields[field] !== value)
		Object.assign(this.mount, patch)
		for (const [field] of changed) this.#transition(field)
		this.notify()
	}

	notify() {
		for (const listener of this.#listeners) listener()
	}

	// J2000 target at the current position, converted at the clock.
	target(): SequencerTarget {
		const { rightAscension, declination } = this.mount.equatorialCoordinate
		const [ra, dec] = equatorialToJ2000(rightAscension, declination, timeUnix(this.clock.wallNow() / 1000))
		return { frame: 'J2000', rightAscension: normalizeAngle(ra), declination: dec }
	}

	of(command: FakeCommand['command']) {
		return this.commands.filter((entry) => entry.command === command)
	}

	readonly updates = (_: Mount, listener: VoidFunction) => {
		this.#listeners.add(listener)
		return () => this.#listeners.delete(listener)
	}

	get listeners() {
		return this.#listeners.size
	}

	// Successful flip to the post-flip side, observed by the commander.
	succeed(): OperationResult<MountFlipResult> {
		this.set({ pierSide: 'EAST' })
		const { rightAscension, declination } = this.mount.equatorialCoordinate
		return successfulOperationResult({ rightAscension, declination, pierSide: 'EAST', initialPierSide: 'WEST', pierSideVerified: true })
	}

	// Flip that only ends, aborted, with its operation.
	hang(context: OperationContext, onAbort?: VoidFunction) {
		return new Promise<OperationResult<MountFlipResult>>((resolve) => {
			context.signal.addEventListener(
				'abort',
				() => {
					onAbort?.()
					resolve(failedOperationResult('aborted'))
				},
				{ once: true },
			)
		})
	}

	#record(command: FakeCommand['command'], args: readonly unknown[]) {
		const wallNow = this.clock.wallNow()
		this.commands.push({ command, args, wallNow, order: nextFakeOrder() })
		this.entries.push({ kind: 'command', sequence: this.sequence.next(), wallNow, monotonicNow: wallNow, device: this.mount.name, manager: 'mount', command, args })
	}

	#transition(property: string) {
		const wallNow = this.clock.wallNow()
		const value = structuredClone((this.mount as unknown as Record<string, unknown>)[property])
		this.entries.push({ kind: 'transition', sequence: this.sequence.next(), wallNow, monotonicNow: wallNow, device: this.mount.name, manager: 'mount', property, value })
	}

	readonly commander = {
		setTracking: (scope: OperationScope, mount: Mount, enabled: boolean, options?: MountCommandOptions) =>
			scope.start<void>('mountTracking', [{ key: 'Mount', device: mount }], () => {
				this.#record('tracking', [enabled, options])
				if (this.trackingFailure !== undefined) return this.trackingFailure
				this.set({ tracking: enabled })
				return successfulOperationResult(undefined)
			}).result,
		setTrackMode: (scope: OperationScope, mount: Mount, mode: TrackMode) =>
			scope.start<void>('mountTrackMode', [{ key: 'Mount', device: mount }], () => {
				this.#record('trackMode', [mode])
				this.set({ trackMode: mode })
				return successfulOperationResult(undefined)
			}).result,
		flip: (scope: OperationScope, mount: Mount, target: MountTargetCoordinate<string | Angle>, options: MountCommandOptions = {}) =>
			scope.start<MountFlipResult>('mountFlip', [{ key: 'Mount', device: mount }], (context) => {
				this.#record('flipTo', [target, options])
				return this.flipBehaviour(context, target, options)
			}).result,
		// Slews to the target converted at `options.time` on the same pier side, recorded like the device command (the
		// coordinates of date), during `slewTime`; a mount already there (within 1″) answers at once without any command,
		// as the fast path of the commander.
		goTo: (scope: OperationScope, mount: Mount, target: MountTargetCoordinate<string | Angle>, options: MountCommandOptions = {}) =>
			scope.start<MountSlewResult>('mountGoTo', [{ key: 'Mount', device: mount }], async (context) => {
				const [rightAscension, declination] = mountTargetEquatorial(this.mount, target, options.time ?? timeUnix(this.clock.wallNow() / 1000))
				const position = this.mount.equatorialCoordinate
				const there = Math.abs(normalizePI(position.rightAscension - rightAscension)) < deg(1 / 3600) && Math.abs(position.declination - declination) < deg(1 / 3600)

				if (!there) {
					this.#record('goTo', [rightAscension, declination, options])
					this.set({ slewing: true })
					const { delay } = this.clock as Partial<Pick<SequencerClock, 'delay'>>
					if (this.slewTime > 0 && delay !== undefined) await delay(this.slewTime, context.signal)
					Object.assign(this.mount.equatorialCoordinate, { rightAscension, declination })
					this.#transition('equatorialCoordinate')
					this.set({ slewing: false, ...(this.trackOnSlew && { tracking: true }) })
				}

				return successfulOperationResult({ rightAscension, declination, pierSide: this.mount.pierSide })
			}).result,
		stopMotion: (_: Mount, options?: MountCommandOptions) => {
			this.#record('stop', [options])
			this.set({ slewing: false, moving: false })
			return Promise.resolve(successfulOperationResult(undefined))
		},
	} as unknown as MountCommander
}

// Lease granted by the arbiter: the kind of the root operation that holds it and its keys.
export interface LeaseEntry {
	readonly root: string
	readonly keys: readonly string[]
}

// Recorder of the leases the arbiter grants.
export interface LeaseRecorder extends Disposable {
	readonly entries: LeaseEntry[]
}

// Records every lease `arbiter` grants, by the kind of its root (every scope of a tree acquires under the root's
// context). The wrapper only observes.
export function recordLeases(arbiter: ResourceArbiter): LeaseRecorder {
	const entries: LeaseEntry[] = []
	const acquire = arbiter.acquire.bind(arbiter)
	const spy = spyOn(arbiter, 'acquire').mockImplementation((...args: Parameters<typeof acquire>) => {
		const acquired = acquire(...args)
		if (acquired.ok) entries.push({ root: args[0].kind, keys: args[1].map((request) => request.key) })
		return acquired
	})
	return { entries, [Symbol.dispose]: () => spy.mockRestore() }
}
