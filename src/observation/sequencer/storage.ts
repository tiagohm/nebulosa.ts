import { constants, copyFile, type FileHandle, link, lstat, mkdir, open, readdir, readFile, realpath, rename, stat, unlink } from 'fs/promises'
import { hostname } from 'os'
import { basename, dirname, join, resolve, sep } from 'path'
import { errorMessage } from '../../core/util'
import { isPathSegment } from '../../io/path'
import type { SequencerTask } from './runner'
import type { SequencerAuxiliaryArtifact, SequencerCheckpoint, SequencerCheckpointStore, SequencerFailure, SequencerFrameDiscardPolicy, SequencerFrameSlot } from './sequencer'

// Artifact protocol of the Sequencer over the filesystem: the exclusive lock of a session directory, the write-ahead
// journal that proves which file belongs to which slot attempt, the temporary → final promotion that never
// overwrites, the disposition of discarded frames, the reconciliation of journal × disk × checkpoint after a crash,
// and the filesystem checkpoint store. Layout of `{root}/{sessionId}/`:
//
//   session.lock                     exclusive lock of the session (JSON payload)
//   checkpoint.json                  last checkpoint (replaced through checkpoint.json.tmp)
//   journal.jsonl                    append-only journal, one JSON line per durable step, fsynced per line
//   {group}/{slot id}.fit            accepted frames
//   {group}/.{slot id}.{attempt}.partial.fit   hidden temporary of an attempt, in the directory of its final
//   rejected/{group}/{slot id}.{attempt}.fit   discarded frames ('moveToRejected')
//   rejected/incomplete/{group}/...  attempts the recovery moved aside
//   auxiliary/{centering|autofocus}/  auxiliary frames of centering and autofocus, outside the journal
//
// Every file is FITS and ends in `.fit`. Identity is the journal, never a file name: paths are recorded relative to
// the session directory (with `/` separators, so a session can be moved or read on another platform) and compared as
// recorded, never recomputed. Files are written with exclusive creation, fsynced before anything depends on them,
// and promoted by a hard link or an exclusive copy verified by size and SHA-256 digest (`rename` overwrites, so it is
// never used for frames); directories are fsynced on POSIX and not on Windows, which cannot open them. Only async
// filesystem I/O runs here, and a digest is computed by streaming. Journal lines and checkpoints are external input
// when read back and are validated before use. Wall instants are Unix ms.

// How a temporary becomes its final file without overwriting: a hard link to the same inode (then the temporary is
// unlinked) or an exclusive copy verified by size and digest. Probed once per session when its lock is acquired.
export type SequencerPromotionMethod = 'link' | 'copy'

// Why a prepared attempt was closed without being dispatched.
export type SequencerDeferReason = 'guard' | 'pause' | 'meridian' | 'safety' | 'beforeExposure' | 'stop'

// Why an attempt ended without a frame transaction:
// - crash: the recovery found it open, as a dispatched exposure of a dead process, and counted it as a capture failure;
// - failed: its capture failed in process; the failure was persisted in the checkpoint before the line;
// - interrupted: a stop or a disposal cancelled its exposure; never counted, so the same attempt is prepared again.
export type SequencerAbandonReason = 'crash' | 'failed' | 'interrupted'

// Disposition of a discarded frame.
export type SequencerDiscardArtifact = SequencerFrameDiscardPolicy['artifact']

// Absolute paths of one attempt of a slot, inside the locked session directory.
export interface SequencerFrameDestination {
	// Slot id.
	readonly slot: string
	// Group of the slot, also the directory of its files.
	readonly groupId: string
	// Physical attempt, 1-based.
	readonly attempt: number
	// Final file of an accepted frame, `{session}/{group}/{slot id}.fit`.
	readonly final: string
	// Hidden temporary the capture writes, `{session}/{group}/.{slot id}.{attempt}.partial.fit`, in the directory of
	// the final so a hard link is always possible.
	readonly temporary: string
}

// Fields every attempt line of the journal carries.
interface SequencerJournalAttemptLine {
	// Slot id.
	readonly slot: string
	// Physical attempt, 1-based.
	readonly attempt: number
	// Wall instant the line was written, in Unix ms; diagnostic only.
	readonly at: number
}

// The attempt was prepared: its temporary and final paths are reserved; nothing exists on disk yet.
export interface SequencerJournalPrepared extends SequencerJournalAttemptLine {
	readonly kind: 'prepared'
	// Temporary, relative to the session directory with `/` separators.
	readonly temporary: string
	// Final, relative to the session directory with `/` separators.
	readonly final: string
}

// The prepared attempt was closed without being dispatched; attempt and counters are unchanged.
export interface SequencerJournalDeferred extends SequencerJournalAttemptLine {
	readonly kind: 'deferred'
	// What postponed it.
	readonly reason: SequencerDeferReason
}

// Write-ahead record of a promotion with the logical transaction of the frame: the checkpoint it produces.
export interface SequencerJournalPromoting extends SequencerJournalAttemptLine {
	readonly kind: 'promoting'
	// Temporary, relative to the session directory.
	readonly temporary: string
	// Final, relative to the session directory.
	readonly final: string
	// Promotion method of the session.
	readonly method: SequencerPromotionMethod
	// Size of the temporary, in bytes.
	readonly size: number
	// SHA-256 of the temporary, lowercase hex; 'copy' only.
	readonly digest?: string
	// Whether a discarded frame is promoted by `keepLast`.
	readonly forced: boolean
	// Checkpoint the frame produces, with `sequence` one above the persisted one.
	readonly next: SequencerCheckpoint
	// Sensor temperature the camera reported at the end of the exposure, in °C; absent without a thermometer.
	readonly sensorTemperature?: number
}

// The final exists and is verified; the transaction of `sequence` is durable.
export interface SequencerJournalCommitted extends SequencerJournalAttemptLine {
	readonly kind: 'committed'
	// Final, relative to the session directory.
	readonly final: string
	// Promotion method.
	readonly method: SequencerPromotionMethod
	// Size of the final, in bytes.
	readonly size: number
	// SHA-256 of the final; 'copy' only.
	readonly digest?: string
	// Sequence of the checkpoint of the transaction.
	readonly sequence: number
}

// Write-ahead record of the disposition of a discarded frame with its logical transaction.
export interface SequencerJournalDisposing extends SequencerJournalAttemptLine {
	readonly kind: 'disposing'
	// Temporary, relative to the session directory.
	readonly temporary: string
	// What happens to the file.
	readonly artifact: SequencerDiscardArtifact
	// Where the file goes, relative to the session directory; absent for 'delete'.
	readonly destination?: string
	// Checkpoint the discard produces.
	readonly next: SequencerCheckpoint
	// Sensor temperature the camera reported at the end of the exposure, in °C; absent without a thermometer.
	readonly sensorTemperature?: number
}

// The disposition is done; the transaction of `sequence` is durable.
export interface SequencerJournalDisposed extends SequencerJournalAttemptLine {
	readonly kind: 'disposed'
	// Sequence of the checkpoint of the transaction.
	readonly sequence: number
}

// The attempt ended without a frame transaction.
export interface SequencerJournalAbandoned extends SequencerJournalAttemptLine {
	readonly kind: 'abandoned'
	// Why it ended.
	readonly reason: SequencerAbandonReason
}

// The lock of a dead owner was reclaimed.
export interface SequencerJournalLockReclaimed {
	readonly kind: 'lockReclaimed'
	// Token of the previous owner.
	readonly previousOwnerToken: string
	// Process id of the previous owner.
	readonly previousPid: number
	// Wall instant, in Unix ms.
	readonly at: number
}

// One line of the session journal.
export type SequencerJournalEntry = SequencerJournalPrepared | SequencerJournalDeferred | SequencerJournalPromoting | SequencerJournalCommitted | SequencerJournalDisposing | SequencerJournalDisposed | SequencerJournalAbandoned | SequencerJournalLockReclaimed

// Payload of `session.lock`.
export interface SequencerSessionLock {
	// Session of the directory and of the checkpoint.
	readonly sessionId: string
	// UUIDv7 generated by each acquisition; only its owner unlinks the lock.
	readonly ownerToken: string
	// Process id of the owner.
	readonly pid: number
	// Host name of the owner.
	readonly host: string
	// Wall instant of the acquisition, in Unix ms; diagnostic only, never used to decide staleness.
	readonly createdAt: number
}

// Outcome of a storage operation; a failure is always of kind 'storage'.
export type SequencerStorageResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly failure: SequencerFailure }

// Outcome of the reconciliation of a session.
export interface SequencerStorageRecovery {
	// Checkpoint to resume from once the journal was reapplied; undefined when the session never produced one.
	readonly checkpoint?: SequencerCheckpoint
	// What was left untouched or moved aside for the operator: unknown files, inconsistent temporaries.
	readonly warnings: readonly string[]
}

// Artifact protocol of one session, as the runner uses it. At most one attempt is open at a time: prepared by
// `prepare`, then closed by `defer` (not dispatched), `abandon`, `promote` or `dispose`. Every write requires the lock.
export interface SequencerStorage {
	// Session whose directory this storage locks.
	readonly sessionId: string
	// Open attempt: prepared and not closed yet.
	readonly prepared: SequencerFrameDestination | undefined
	// Writer of the primary frames: creates the file exclusively and resolves only after it is fsynced.
	readonly writeDurably: (path: string, data: Buffer) => Promise<void>
	// Acquires the exclusive lock of the session directory and probes the promotion method. Idempotent.
	readonly lock: () => Promise<SequencerStorageResult<void>>
	// Releases the lock when this storage still owns it. Never rejects.
	readonly release: () => Promise<void>
	// Reconciles journal, disk and the persisted checkpoint (section 36.6): finishes or rejects interrupted
	// promotions and dispositions, reapplies their transactions through `save`, moves incomplete temporaries aside and
	// counts an exposure in flight as one capture failure (saved before its `abandoned` line). Idempotent.
	readonly recover: (persisted: SequencerCheckpoint | undefined, save: (checkpoint: SequencerCheckpoint) => Promise<void>) => Promise<SequencerStorageResult<SequencerStorageRecovery>>
	// Reserves and journals the destination of the attempt of `slot`; the same open attempt is returned again.
	readonly prepare: (slot: SequencerFrameSlot) => Promise<SequencerStorageResult<SequencerFrameDestination>>
	// Closes the open attempt as not dispatched. Refused when its temporary already exists.
	readonly defer: (reason: SequencerDeferReason) => Promise<SequencerStorageResult<void>>
	// Size in bytes of the temporary of the open attempt; a failure when it is missing or empty.
	readonly verify: () => Promise<SequencerStorageResult<number>>
	// Promotes the temporary of the open attempt to its final with the transaction `next`, journaling the measured sensor
	// temperature (°C) when given; resolves the final path.
	readonly promote: (next: SequencerCheckpoint, forced: boolean, sensorTemperature?: number) => Promise<SequencerStorageResult<string>>
	// Disposes of the temporary of the open attempt with the transaction `next`, journaling the measured sensor
	// temperature (°C) when given; resolves where it went.
	readonly dispose: (artifact: SequencerDiscardArtifact, next: SequencerCheckpoint, sensorTemperature?: number) => Promise<SequencerStorageResult<string | undefined>>
	// Removes the temporary of the open attempt, if any, and closes it.
	readonly abandon: (reason: Exclude<SequencerAbandonReason, 'crash'>) => Promise<SequencerStorageResult<void>>
	// Auxiliary namespace, required by centering and autofocus: the directory of the auxiliary frames of `kind`, created
	// while locked. With `artifact` 'delete' the first call for `kind` removes the frames a previous process left there.
	// Auxiliary frames never enter the journal nor the reconciliation and never count anywhere.
	readonly auxiliaryDirectory?: (kind: SequencerAuxiliaryKind, artifact: SequencerAuxiliaryArtifact) => Promise<SequencerStorageResult<string>>
}

// Feature an auxiliary frame belongs to, also the name of its directory under `auxiliary/`.
export type SequencerAuxiliaryKind = 'centering' | 'autofocus'

// Process-wide registry of the session locks this JS realm holds: canonical session directory (realpath) → owner
// token. An entry is created before the lock file and removed only after it was unlinked, so two storages of the
// same process never both believe they own a session. Sessions running in a Worker (another realm) are out of scope.
const ACTIVE_SESSION_LOCKS = new Map<string, string>()

// Names inside the session directory.
const LOCK_FILE = 'session.lock'
const RECLAIM_FILE = 'session.lock.reclaim'
const JOURNAL_FILE = 'journal.jsonl'
const CHECKPOINT_FILE = 'checkpoint.json'
const CHECKPOINT_TEMPORARY_FILE = 'checkpoint.json.tmp'
const REJECTED_DIRECTORY = 'rejected'
const AUXILIARY_DIRECTORY = 'auxiliary'
const INCOMPLETE_DIRECTORY = 'incomplete'
const FRAME_EXTENSION = '.fit'
const PARTIAL_EXTENSION = '.partial.fit'

// Temporary payload of a lock acquisition, `.session.lock.{ownerToken}.tmp`.
const LOCK_TEMPORARY_PATTERN = /^\.session\.lock\.(.+)\.tmp$/

// Error codes of a volume without hard links, where promotions fall back to exclusive copies.
const LINK_UNSUPPORTED = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS'])

// Successful outcome without a value.
const OK: SequencerStorageResult<void> = { ok: true, value: undefined }

// Absolute destination of an attempt inside the session directory `directory`.
export function sequencerFrameDestination(directory: string, groupId: string, slot: string, attempt: number): SequencerFrameDestination {
	const group = join(directory, groupId)
	return { slot, groupId, attempt, final: join(group, `${slot}${FRAME_EXTENSION}`), temporary: join(group, `.${slot}.${attempt}${PARTIAL_EXTENSION}`) }
}

// Options of a filesystem storage. Everything but `root` and `sessionId` stands for the process and exists so tests
// can play another process or host.
export interface FileSystemSequencerStorageOptions {
	// Directory holding one directory per session.
	readonly root: string
	// Session id; a portable path segment.
	readonly sessionId: string
	// Wall clock of the journal instants, in Unix ms. Default `Date.now`.
	readonly wallNow?: () => number
	// Host name written in and compared with the lock. Default `os.hostname()`.
	readonly host?: string
	// Process id written in and compared with the lock. Default `process.pid`.
	readonly pid?: number
	// Liveness probe of a process id, with the contract of `process.kill(pid, 0)`. Default `process.kill`.
	readonly kill?: (pid: number, signal: number) => unknown
	// Registry of the locks held by this realm. Default the process-wide one; a separate map plays another process.
	readonly registry?: Map<string, string>
}

// Storage of one session over the filesystem.
export class FileSystemSequencerStorage implements SequencerStorage {
	readonly sessionId: string

	readonly #root: string
	readonly #wallNow: () => number
	readonly #host: string
	readonly #pid: number
	readonly #kill: (pid: number, signal: number) => unknown
	readonly #registry: Map<string, string>
	// Canonical session directory while locked.
	#directory?: string
	// Token of the held lock.
	#token?: string
	#method: SequencerPromotionMethod = 'link'
	#prepared?: SequencerFrameDestination
	// Auxiliary kinds whose leftovers were removed during the current lock.
	readonly #auxiliaryCleared = new Set<SequencerAuxiliaryKind>()

	constructor(options: FileSystemSequencerStorageOptions) {
		this.sessionId = options.sessionId
		this.#root = options.root
		this.#wallNow = options.wallNow ?? Date.now
		this.#host = options.host ?? hostname()
		this.#pid = options.pid ?? process.pid
		this.#kill = options.kill ?? ((pid, signal) => process.kill(pid, signal))
		this.#registry = options.registry ?? ACTIVE_SESSION_LOCKS
	}

	// Canonical session directory while locked.
	get directory() {
		return this.#directory
	}

	// Promotion method probed by the lock; meaningful only while locked.
	get method() {
		return this.#method
	}

	// Open attempt: prepared and not closed yet.
	get prepared() {
		return this.#prepared
	}

	// Writer of the primary frames: exclusive create, then fsync before resolving.
	readonly writeDurably = async (path: string, data: Buffer) => {
		await writeExclusive(path, data)
	}

	// Acquisition protocol of section 36.1: the registry first (busy without touching the lock), then the payload
	// written to an own temporary and published by `link` (atomic, never overwriting; it is also the hard-link probe),
	// or by an exclusive create on a volume without hard links. An existing lock is reclaimed only when its owner is
	// provably dead on this host. The own temporary and a failed registry entry are always removed.
	async lock(): Promise<SequencerStorageResult<void>> {
		if (this.#token !== undefined) return OK
		if (!isPathSegment(this.sessionId)) return storageFailure(`session id ${JSON.stringify(this.sessionId)} is not a portable path segment`)

		let directory: string

		try {
			const path = resolve(this.#root, this.sessionId)
			await makeDirectory(path)
			directory = await realpath(path)
		} catch (error) {
			return storageFailure(`session directory: ${errorMessage(error)}`)
		}

		// Synchronous check and registration: two storages of this realm never pass it together.
		if (this.#registry.has(directory)) return storageFailure(`session ${this.sessionId} is locked by this process`)
		const token = Bun.randomUUIDv7()
		this.#registry.set(directory, token)

		const temporary = join(directory, `.${LOCK_FILE}.${token}.tmp`)
		let acquired = false

		try {
			const acquisition = await this.#acquire(directory, token, temporary)
			if (!acquisition.ok) return acquisition
			acquired = true
			this.#directory = directory
			this.#token = token

			try {
				await ensureFile(join(directory, JOURNAL_FILE))
				const previous = acquisition.value
				if (previous !== undefined) await this.#append({ kind: 'lockReclaimed', previousOwnerToken: previous.ownerToken, previousPid: previous.pid, at: this.#wallNow() })
				await fsyncDirectory(directory)
			} catch (error) {
				await this.release()
				return storageFailure(`lock: ${errorMessage(error)}`)
			}

			await this.#removeStaleLockTemporaries(directory, token)
			return OK
		} catch (error) {
			return storageFailure(`lock: ${errorMessage(error)}`)
		} finally {
			await removeQuietly(temporary)
			if (!acquired && this.#registry.get(directory) === token) this.#registry.delete(directory)
		}
	}

	async release() {
		const directory = this.#directory
		const token = this.#token
		if (directory === undefined || token === undefined) return

		try {
			const lock = parseSessionLock(await readTextIfExists(join(directory, LOCK_FILE)))
			// A lock replaced by another token (reclaimed by an operator) is never removed.
			if (lock?.ownerToken === token) await unlink(join(directory, LOCK_FILE))
		} catch (error) {
			// The entry stays: this storage may still own the lock, and a false busy is safe.
			console.error('sequencer storage failed to release its lock:', directory, errorMessage(error))
			return
		}

		await fsyncDirectory(directory).catch(() => undefined)
		if (this.#registry.get(directory) === token) this.#registry.delete(directory)
		this.#directory = undefined
		this.#token = undefined
		this.#prepared = undefined
		this.#auxiliaryCleared.clear()
	}

	async prepare(slot: SequencerFrameSlot): Promise<SequencerStorageResult<SequencerFrameDestination>> {
		const directory = this.#directory
		if (directory === undefined) return storageFailure('the session directory is not locked')

		const open = this.#prepared

		if (open !== undefined) {
			if (open.slot === slot.id && open.attempt === slot.attempt) return { ok: true, value: open }
			return storageFailure(`attempt ${open.slot}#${open.attempt} is still open`)
		}

		const destination = sequencerFrameDestination(directory, slot.groupId, slot.id, slot.attempt)

		if (!isPathSegment(slot.groupId) || !isPathSegment(basename(destination.final)) || !isPathSegment(basename(destination.temporary))) {
			return storageFailure(`slot ${slot.id} does not name portable files`)
		}

		try {
			const group = dirname(destination.final)
			await makeDirectory(group)
			if ((await lstat(group)).isSymbolicLink()) return storageFailure(`${group} is a symbolic link`)
			// The journal decides on a retake; an existing final of a slot still in progress is an inconsistency.
			if ((await statIfExists(destination.final)) !== undefined) return storageFailure(`${destination.final} already exists`)
			if ((await statIfExists(destination.temporary)) !== undefined) return storageFailure(`${destination.temporary} already exists`)
			await this.#append({ kind: 'prepared', slot: slot.id, attempt: slot.attempt, temporary: this.#relative(destination.temporary), final: this.#relative(destination.final), at: this.#wallNow() })
		} catch (error) {
			return storageFailure(`prepare ${slot.id}#${slot.attempt}: ${errorMessage(error)}`)
		}

		this.#prepared = destination
		return { ok: true, value: destination }
	}

	async defer(reason: SequencerDeferReason): Promise<SequencerStorageResult<void>> {
		const open = this.#prepared
		if (open === undefined) return OK

		try {
			// A temporary means something was written: the attempt is incomplete, not deferred.
			if ((await statIfExists(open.temporary)) !== undefined) return storageFailure(`${open.temporary} exists: the attempt ${open.slot}#${open.attempt} is incomplete`)
			await this.#append({ kind: 'deferred', slot: open.slot, attempt: open.attempt, reason, at: this.#wallNow() })
		} catch (error) {
			return storageFailure(`defer ${open.slot}#${open.attempt}: ${errorMessage(error)}`)
		}

		this.#prepared = undefined
		return OK
	}

	async verify(): Promise<SequencerStorageResult<number>> {
		const open = this.#prepared
		if (open === undefined) return storageFailure('no attempt is open')
		const stats = await statIfExists(open.temporary).catch(() => undefined)
		if (stats === undefined || stats.size === 0n) return storageFailure(`${open.temporary} is missing or empty`)
		return { ok: true, value: Number(stats.size) }
	}

	// Promotion of section 36.4: size (and digest for a copy) decided before the destination is touched, `promoting`
	// with the transaction, the link or the verified exclusive copy, `committed`, and only then the temporary of a copy
	// is removed. An existing final is never overwritten.
	async promote(next: SequencerCheckpoint, forced: boolean, sensorTemperature?: number): Promise<SequencerStorageResult<string>> {
		const open = this.#prepared
		if (open === undefined) return storageFailure('no attempt is open')

		try {
			const { slot, attempt, temporary, final } = open
			const size = (await stat(temporary)).size
			const method = this.#method
			const digest = method === 'copy' ? await sha256(temporary) : undefined
			const promoting: SequencerJournalPromoting = { kind: 'promoting', slot, attempt, temporary: this.#relative(temporary), final: this.#relative(final), method, size, ...(digest !== undefined && { digest }), forced, next, ...(sensorTemperature !== undefined && { sensorTemperature }), at: this.#wallNow() }
			await this.#append(promoting)
			await this.#promote(promoting)
		} catch (error) {
			return storageFailure(`promote ${open.slot}#${open.attempt}: ${errorMessage(error)}`)
		}

		this.#prepared = undefined
		return { ok: true, value: open.final }
	}

	async dispose(artifact: SequencerDiscardArtifact, next: SequencerCheckpoint, sensorTemperature?: number): Promise<SequencerStorageResult<string | undefined>> {
		const directory = this.#directory
		const open = this.#prepared
		if (directory === undefined || open === undefined) return storageFailure('no attempt is open')

		const { slot, attempt, groupId, temporary } = open
		const destination = discardDestination(directory, groupId, slot, attempt, artifact)

		try {
			const disposing: SequencerJournalDisposing = { kind: 'disposing', slot, attempt, temporary: this.#relative(temporary), artifact, ...(destination !== undefined && { destination: this.#relative(destination) }), next, ...(sensorTemperature !== undefined && { sensorTemperature }), at: this.#wallNow() }
			await this.#append(disposing)
			await this.#dispose(disposing, [])
			await this.#append({ kind: 'disposed', slot, attempt, sequence: next.sequence, at: this.#wallNow() })
		} catch (error) {
			return storageFailure(`dispose ${slot}#${attempt}: ${errorMessage(error)}`)
		}

		this.#prepared = undefined
		return { ok: true, value: destination }
	}

	async abandon(reason: Exclude<SequencerAbandonReason, 'crash'>): Promise<SequencerStorageResult<void>> {
		const open = this.#prepared
		if (open === undefined) return OK

		try {
			// Never promote the temporary of an attempt without an ok result.
			await unlinkIfExists(open.temporary)
			await this.#append({ kind: 'abandoned', slot: open.slot, attempt: open.attempt, reason, at: this.#wallNow() })
		} catch (error) {
			return storageFailure(`abandon ${open.slot}#${open.attempt}: ${errorMessage(error)}`)
		}

		this.#prepared = undefined
		return OK
	}

	// Creates `{session}/auxiliary/{kind}`. The first call for a kind with 'delete' removes the `.fit` files left there by
	// an earlier process (or an earlier lock of this one); files that cannot be removed are left for the next run.
	async auxiliaryDirectory(kind: SequencerAuxiliaryKind, artifact: SequencerAuxiliaryArtifact): Promise<SequencerStorageResult<string>> {
		const directory = this.#directory
		if (directory === undefined) return storageFailure('the session directory is not locked')

		const path = join(directory, AUXILIARY_DIRECTORY, kind)

		try {
			await makeDirectory(path)

			if (artifact === 'delete' && !this.#auxiliaryCleared.has(kind)) {
				for (const entry of await readdir(path, { withFileTypes: true })) {
					if (entry.isFile() && entry.name.endsWith(FRAME_EXTENSION)) await removeQuietly(join(path, entry.name))
				}
			}
		} catch (error) {
			return storageFailure(`auxiliary ${kind}: ${errorMessage(error)}`)
		}

		if (artifact === 'delete') this.#auxiliaryCleared.add(kind)
		return { ok: true, value: path }
	}

	// Reconciliation of section 36.6. Transactions are resolved first, in journal order (their sequences increase
	// along it), so the attempts left open are judged against the checkpoint they produced. A committed frame is
	// verified by size, and by digest only when its transaction is reapplied or its copy left the temporary behind.
	async recover(persisted: SequencerCheckpoint | undefined, save: (checkpoint: SequencerCheckpoint) => Promise<void>): Promise<SequencerStorageResult<SequencerStorageRecovery>> {
		const directory = this.#directory
		if (directory === undefined) return storageFailure('the session directory is not locked')

		const warnings: string[] = []
		let attempts: Map<string, JournalAttempt>
		let referenced: Set<string>

		try {
			;({ attempts, referenced } = collectJournalAttempts(await readSequencerJournal(join(directory, JOURNAL_FILE))))
		} catch (error) {
			return storageFailure(`journal: ${errorMessage(error)}`)
		}

		let checkpoint = persisted

		const reapply = async (next: SequencerCheckpoint) => {
			if (checkpoint !== undefined && !(next.sequence > checkpoint.sequence)) return
			await save(next)
			checkpoint = next
		}

		try {
			for (const attempt of attempts.values()) {
				const failure = await this.#recoverTransaction(attempt, () => checkpoint, reapply, warnings)
				if (failure !== undefined) return { ok: false, failure }
			}

			for (const attempt of attempts.values()) {
				const { last } = attempt
				if (last.kind !== 'prepared' && last.kind !== 'deferred' && last.kind !== 'abandoned') continue
				const temporary = this.#absolute(attempt.temporary)

				if ((await statIfExists(temporary)) !== undefined) {
					const aside = await this.#moveAside(temporary, attempt.groupId)
					if (last.kind !== 'prepared') warnings.push(`${attempt.slot}#${attempt.attempt} was ${last.kind} but its temporary existed; moved to ${aside}`)
				}

				if (last.kind !== 'prepared') continue

				// An exposure in flight: one capture failure, saved before `abandoned` so a repetition never counts it twice.
				const current = checkpoint?.currentSlot

				if (checkpoint !== undefined && current !== undefined && current.id === last.slot && current.attempt === last.attempt) {
					const next: SequencerCheckpoint = { ...checkpoint, currentSlot: { ...current, attempt: current.attempt + 1, captureFailures: current.captureFailures + 1 }, sequence: checkpoint.sequence + 1, updatedAt: this.#wallNow() }
					await save(next)
					checkpoint = next
				}

				await this.#append({ kind: 'abandoned', slot: last.slot, attempt: last.attempt, reason: 'crash', at: this.#wallNow() })
			}

			await this.#reportUnknownFiles(directory, referenced, warnings)
		} catch (error) {
			return storageFailure(`recovery: ${errorMessage(error)}`)
		}

		return { ok: true, value: checkpoint === undefined ? { warnings } : { checkpoint, warnings } }
	}

	// Resolves an attempt whose last line belongs to a transaction; returns the failure that stops the recovery.
	async #recoverTransaction(attempt: JournalAttempt, checkpoint: () => SequencerCheckpoint | undefined, reapply: (next: SequencerCheckpoint) => Promise<void>, warnings: string[]): Promise<SequencerFailure | undefined> {
		const { last, transaction } = attempt

		switch (last.kind) {
			case 'committed': {
				if (transaction?.kind !== 'promoting') {
					const persisted = checkpoint()
					return persisted !== undefined && last.sequence <= persisted.sequence ? undefined : storageFailure(`${last.slot}#${last.attempt} was committed without its transaction`).failure
				}

				const final = this.#absolute(last.final)
				const temporary = this.#absolute(transaction.temporary)
				const pending = checkpoint() === undefined || transaction.next.sequence > checkpoint()!.sequence
				const leftover = last.method === 'copy' && (await statIfExists(temporary)) !== undefined
				if (!(await matchesFile(final, last.size, pending || leftover ? last.digest : undefined))) return storageFailure(`${final} of a committed frame is missing or differs`).failure
				if (last.method === 'copy') await unlinkIfExists(temporary)
				await reapply(transaction.next)
				return undefined
			}
			case 'promoting':
				return await this.#recoverPromotion(last, reapply)
			case 'disposing':
				await this.#dispose(last, warnings)
				await this.#append({ kind: 'disposed', slot: last.slot, attempt: last.attempt, sequence: last.next.sequence, at: this.#wallNow() })
				await reapply(last.next)
				return undefined
			case 'disposed':
				if (transaction?.kind === 'disposing') await reapply(transaction.next)
				return undefined
			default:
				return undefined
		}
	}

	// Rows `promoting` of the reconciliation table.
	async #recoverPromotion(promoting: SequencerJournalPromoting, reapply: (next: SequencerCheckpoint) => Promise<void>): Promise<SequencerFailure | undefined> {
		const temporary = this.#absolute(promoting.temporary)
		const final = this.#absolute(promoting.final)
		const { size, digest } = promoting
		const committed = async () => {
			await fsyncDirectory(dirname(final))
			await this.#append({ kind: 'committed', slot: promoting.slot, attempt: promoting.attempt, final: promoting.final, method: promoting.method, size, ...(digest !== undefined && { digest }), sequence: promoting.next.sequence, at: this.#wallNow() })
			await reapply(promoting.next)
		}

		const temporaryStats = await statIfExists(temporary)
		const finalStats = await statIfExists(final)

		if (promoting.method === 'link') {
			if (finalStats !== undefined) {
				if (temporaryStats !== undefined) {
					if (temporaryStats.ino !== finalStats.ino || temporaryStats.dev !== finalStats.dev) {
						const aside = await this.#moveAside(temporary, groupOf(promoting.final))
						return storageFailure(`${final} is another file than the promoted temporary (moved to ${aside})`).failure
					}

					await unlink(temporary)
				} else if (Number(finalStats.size) !== size) {
					return storageFailure(`${final} differs from the promoted temporary`).failure
				}

				await committed()
				return undefined
			}

			if (temporaryStats === undefined) return storageFailure(`both ${temporary} and ${final} are missing`).failure
			await link(temporary, final)
			await unlink(temporary)
			await committed()
			return undefined
		}

		if (await matchesFile(final, size, digest)) {
			await committed()
			await unlinkIfExists(temporary)
			return undefined
		}

		// The temporary is the only source: it is never removed before `committed`.
		if (!(await matchesFile(temporary, size, digest))) return storageFailure(`${final} and ${temporary} both differ from the promoted frame`).failure
		if (finalStats !== undefined) await unlink(final)
		await copyVerified(temporary, final, size, digest)
		await committed()
		await unlink(temporary)
		return undefined
	}

	// Link or verified exclusive copy of the temporary of a `promoting` line onto its final, never overwriting.
	async #promote(promoting: SequencerJournalPromoting) {
		const temporary = this.#absolute(promoting.temporary)
		const final = this.#absolute(promoting.final)
		const { size, digest } = promoting

		if (promoting.method === 'link') {
			await link(temporary, final)
			await unlink(temporary)
		} else {
			await copyVerified(temporary, final, size, digest)
		}

		await fsyncDirectory(dirname(final))
		await this.#append({ kind: 'committed', slot: promoting.slot, attempt: promoting.attempt, final: promoting.final, method: promoting.method, size, ...(digest !== undefined && { digest }), sequence: promoting.next.sequence, at: this.#wallNow() })

		if (promoting.method === 'copy') {
			await unlink(temporary)
			await fsyncDirectory(dirname(temporary))
		}
	}

	// Disposition of a `disposing` line, idempotent per destination: a temporary already moved (or deleted) is done.
	async #dispose(disposing: SequencerJournalDisposing, warnings: string[]) {
		const temporary = this.#absolute(disposing.temporary)

		if (disposing.destination === undefined) {
			await unlinkIfExists(temporary)
			await fsyncDirectory(dirname(temporary))
			return
		}

		const destination = this.#absolute(disposing.destination)

		if ((await statIfExists(temporary)) !== undefined) await this.#move(temporary, destination)
		else if ((await statIfExists(destination)) === undefined) warnings.push(`discarded frame ${disposing.slot}#${disposing.attempt} is missing from ${destination}`)
	}

	// Moves a file without overwriting: link (an existing same file completes an interrupted move) or verified exclusive
	// copy (a differing existing copy is a partial one of an interrupted move and is replaced), then the source goes.
	async #move(from: string, to: string) {
		await makeDirectory(dirname(to))

		if (this.#method === 'link') {
			try {
				await link(from, to)
			} catch (error) {
				if (errorCode(error) !== 'EEXIST' || !(await isSameFile(from, to))) throw error
			}
		} else {
			const size = (await stat(from)).size
			const digest = await sha256(from)
			if (!(await matchesFile(to, size, digest))) await unlinkIfExists(to)
			if ((await statIfExists(to)) === undefined) await copyVerified(from, to, size, digest)
		}

		await fsyncDirectory(dirname(to))
		await unlink(from)
		await fsyncDirectory(dirname(from))
	}

	// Moves an incomplete temporary to `rejected/incomplete/{group}/`, under its own name or the first free numbered
	// variant; a repeated recovery finding the same file already there only removes the source. Returns the new path.
	async #moveAside(temporary: string, groupId: string) {
		const directory = join(this.#directory!, REJECTED_DIRECTORY, INCOMPLETE_DIRECTORY, groupId)
		const name = basename(temporary)
		const stem = name.endsWith(PARTIAL_EXTENSION) ? name.slice(0, -PARTIAL_EXTENSION.length) : name

		for (let n = 0; ; n++) {
			const target = join(directory, n === 0 ? name : `${stem}.${n}${PARTIAL_EXTENSION}`)
			const existing = await statIfExists(target)

			if (existing === undefined || (await isSameFile(temporary, target))) {
				await this.#move(temporary, target)
				return target
			}
		}
	}

	// Reports every frame file of the group directories that no journal line names; it is never touched. Discarded and
	// auxiliary frames live outside the group directories.
	async #reportUnknownFiles(directory: string, referenced: ReadonlySet<string>, warnings: string[]) {
		for (const entry of await readdir(directory, { recursive: true })) {
			const relative = entry.split(sep).join('/')
			if (!relative.endsWith(FRAME_EXTENSION) || relative.startsWith(`${REJECTED_DIRECTORY}/`) || relative.startsWith(`${AUXILIARY_DIRECTORY}/`) || referenced.has(relative)) continue
			const stats = await statIfExists(join(directory, entry))
			if (stats?.isFile()) warnings.push(`unknown file ${relative} left untouched`)
		}
	}

	// Removes the lock temporaries of other acquisitions whose owner is provably dead; never one of a live owner.
	async #removeStaleLockTemporaries(directory: string, token: string) {
		try {
			for (const name of await readdir(directory)) {
				const match = LOCK_TEMPORARY_PATTERN.exec(name)
				if (match === null || match[1] === token) continue
				const lock = parseSessionLock(await readTextIfExists(join(directory, name)))
				if (lock !== undefined && lock.host === this.#host && this.#ownerAlive(lock) === false) await removeQuietly(join(directory, name))
			}
		} catch {
			// Best effort: a leftover temporary never blocks an acquisition.
		}
	}

	// Publishes the own payload as the lock and, when one exists, decides between busy, refusal and reclaim (table of
	// section 36.1). Resolves the reclaimed previous lock, if any.
	async #acquire(directory: string, token: string, temporary: string): Promise<SequencerStorageResult<SequencerSessionLock | undefined>> {
		const path = join(directory, LOCK_FILE)
		const payload: SequencerSessionLock = { sessionId: this.sessionId, ownerToken: token, pid: this.#pid, host: this.#host, createdAt: this.#wallNow() }
		const content = JSON.stringify(payload)
		await writeExclusive(temporary, content)

		if (await this.#publish(temporary, path, content)) return { ok: true, value: undefined }

		const previous = parseSessionLock(await readTextIfExists(path))
		const refusal = this.#refusal(path, previous)
		if (refusal !== undefined) return storageFailure(refusal)

		// Mutually exclusive reclaim through an exclusive guard file.
		const guard = join(directory, RECLAIM_FILE)

		try {
			await writeExclusive(guard, JSON.stringify({ ownerToken: token, pid: this.#pid }))
		} catch (error) {
			if (errorCode(error) === 'EEXIST') return storageFailure(`${guard} exists: another reclaim is running or was interrupted`)
			throw error
		}

		try {
			const current = parseSessionLock(await readTextIfExists(path))
			if (current?.ownerToken !== previous!.ownerToken) return storageFailure(`${path} changed during the reclaim`)
			await unlink(path)
			if (!(await this.#publish(temporary, path, content))) return storageFailure(`${path} was acquired by another process during the reclaim`)
		} finally {
			await removeQuietly(guard)
		}

		return { ok: true, value: previous }
	}

	// Creates the lock from the own temporary: `link`, or an exclusive create where hard links are unsupported, which
	// also decides the promotion method. False when a lock already exists.
	async #publish(temporary: string, path: string, content: string) {
		try {
			await link(temporary, path)
			this.#method = 'link'
			return true
		} catch (error) {
			const code = errorCode(error)
			if (code === 'EEXIST') return false
			if (code === undefined || !LINK_UNSUPPORTED.has(code)) throw error
		}

		try {
			await writeExclusive(path, content)
			this.#method = 'copy'
			return true
		} catch (error) {
			if (errorCode(error) === 'EEXIST') return false
			throw error
		}
	}

	// Why an existing lock is not reclaimed, or undefined when its owner is provably dead on this host. A false busy is
	// safe; a false reclaim is not, so anything uncertain refuses.
	#refusal(path: string, lock: SequencerSessionLock | undefined) {
		if (lock === undefined) return `${path} is unreadable or malformed`
		if (lock.sessionId !== this.sessionId) return `${path} belongs to session ${lock.sessionId}`
		if (lock.host !== this.#host) return `session ${this.sessionId} is locked by host ${lock.host}`

		const alive = this.#ownerAlive(lock)
		if (alive === undefined) return `cannot verify the owner process ${lock.pid} of ${path}`
		return alive ? `session ${this.sessionId} is locked by process ${lock.pid}` : undefined
	}

	// Whether the owner of a lock of this host is alive: this realm while its token is registered (a pid of this
	// process with an unknown token was reused after a reboot), otherwise `kill(pid, 0)`: ESRCH is dead, success and
	// EPERM are alive, anything else is unknown.
	#ownerAlive(lock: SequencerSessionLock) {
		if (lock.pid === this.#pid) return [...this.#registry.values()].includes(lock.ownerToken)

		try {
			this.#kill(lock.pid, 0)
			return true
		} catch (error) {
			const code = errorCode(error)
			return code === 'ESRCH' ? false : code === 'EPERM' ? true : undefined
		}
	}

	// Appends one line to the journal and fsyncs it.
	async #append(entry: SequencerJournalEntry) {
		const handle = await open(join(this.#directory!, JOURNAL_FILE), 'a')

		try {
			await writeAll(handle, Buffer.from(`${JSON.stringify(entry)}\n`))
			await handle.sync()
		} finally {
			await handle.close()
		}
	}

	// Path relative to the session directory with `/` separators, as the journal records it.
	#relative(path: string) {
		return path
			.slice(this.#directory!.length + 1)
			.split(sep)
			.join('/')
	}

	// Absolute path of a journal path.
	#absolute(path: string) {
		return join(this.#directory!, ...path.split('/'))
	}
}

// Pre-capture task `prepareFrameDestination` (step 9 of the pre-capture): prepares and journals the destination of the
// attempt of the frame, before the final guard so no filesystem work lies between the guard and the exposure. A
// storage failure fails the task, under the policy of the pre-capture.
export function prepareFrameDestinationTask(storage: SequencerStorage): SequencerTask {
	return {
		id: 'prepareFrameDestination',
		shouldRun: (view) => view.frame !== undefined,
		run: async (context) => {
			const prepared = await storage.prepare(context.frame!)
			return prepared.ok ? { ok: true } : { ok: false, failure: prepared.failure }
		},
	}
}

// Checkpoint store over `{root}/{sessionId}/checkpoint.json`. A save writes `checkpoint.json.tmp`, fsyncs it and
// renames it over the checkpoint (replacing is intended here), then fsyncs the directory on POSIX; a leftover
// temporary is ignored by the reads. The sequence of every save must exceed the persisted one.
export class FileSystemSequencerCheckpointStore implements SequencerCheckpointStore {
	// Directory holding one directory per session.
	constructor(readonly root: string) {}

	readonly load = async (sessionId: string) => {
		const text = await readTextIfExists(this.#path(sessionId, CHECKPOINT_FILE))
		if (text === undefined) return undefined
		const checkpoint = parseSequencerCheckpoint(parseJson(text))
		if (checkpoint === undefined || checkpoint.sessionId !== sessionId) throw new Error(`checkpoint of session ${sessionId} is malformed`)
		return checkpoint
	}

	readonly save = async (checkpoint: SequencerCheckpoint) => {
		const { sessionId, sequence } = checkpoint
		const persisted = await this.load(sessionId)
		if (persisted !== undefined && !(sequence > persisted.sequence)) throw new Error(`checkpoint ${sequence} of session ${sessionId} is not newer than ${persisted.sequence}`)

		const temporary = this.#path(sessionId, CHECKPOINT_TEMPORARY_FILE)
		await makeDirectory(dirname(temporary))
		const handle = await open(temporary, 'w')

		try {
			await writeAll(handle, Buffer.from(JSON.stringify(checkpoint)))
			await handle.sync()
		} finally {
			await handle.close()
		}

		await rename(temporary, this.#path(sessionId, CHECKPOINT_FILE))
		await fsyncDirectory(dirname(temporary))
	}

	readonly remove = async (sessionId: string) => {
		await unlinkIfExists(this.#path(sessionId, CHECKPOINT_FILE))
	}

	#path(sessionId: string, name: string) {
		if (!isPathSegment(sessionId)) throw new Error(`session id ${JSON.stringify(sessionId)} is not a portable path segment`)
		return join(this.root, sessionId, name)
	}
}

// Lines of a journal file in order. A last line without its newline was cut by a crash and is ignored (a truncated
// `promoting` is as if it never existed); any other unreadable line throws. A missing file has no lines.
export async function readSequencerJournal(path: string): Promise<SequencerJournalEntry[]> {
	const text = await readTextIfExists(path)
	if (text === undefined) return []

	const lines = text.split('\n')
	// The segment after the last newline is empty, or a truncated line.
	lines.pop()

	return lines.map((line, i) => {
		const entry = parseJournalEntry(parseJson(line))
		if (entry === undefined) throw new Error(`line ${i + 1} of ${path} is malformed`)
		return entry
	})
}

// Lines of one attempt, by `{slot}#{attempt}`.
interface JournalAttempt {
	readonly slot: string
	readonly attempt: number
	// Group directory of its files.
	readonly groupId: string
	// Temporary of its latest `prepared`, relative.
	temporary: string
	// Latest line.
	last: Exclude<SequencerJournalEntry, SequencerJournalLockReclaimed>
	// Latest `promoting` or `disposing`.
	transaction?: SequencerJournalPromoting | SequencerJournalDisposing
}

// Attempts of a journal in order of first appearance, and every path the journal names (relative).
function collectJournalAttempts(entries: readonly SequencerJournalEntry[]) {
	const attempts = new Map<string, JournalAttempt>()
	const referenced = new Set<string>()

	for (const entry of entries) {
		if (entry.kind === 'lockReclaimed') continue

		const key = `${entry.slot}#${entry.attempt}`
		let attempt = attempts.get(key)

		if (entry.kind === 'prepared') {
			referenced.add(entry.temporary).add(entry.final)
			if (attempt === undefined) attempts.set(key, (attempt = { slot: entry.slot, attempt: entry.attempt, groupId: groupOf(entry.final), temporary: entry.temporary, last: entry }))
			attempt.temporary = entry.temporary
		} else if (attempt === undefined) {
			throw new Error(`${entry.kind} line of ${key} without its prepared line`)
		}

		attempt.last = entry

		if (entry.kind === 'promoting' || entry.kind === 'disposing') {
			attempt.transaction = entry
			if (entry.kind === 'disposing' && entry.destination !== undefined) referenced.add(entry.destination)
		}
	}

	return { attempts, referenced }
}

// Group directory of a journal path `{group}/{name}`.
function groupOf(path: string) {
	return path.slice(0, path.indexOf('/'))
}

// Where a discarded frame goes, absolute; undefined for 'delete'.
function discardDestination(directory: string, groupId: string, slot: string, attempt: number, artifact: SequencerDiscardArtifact) {
	switch (artifact) {
		case 'moveToRejected':
			return join(directory, REJECTED_DIRECTORY, groupId, `${slot}.${attempt}${FRAME_EXTENSION}`)
		case 'keepInPlace':
			return join(directory, groupId, `${slot}.${attempt}.discarded${FRAME_EXTENSION}`)
		case 'delete':
			return undefined
	}
}

// Storage failure with `detail`.
function storageFailure(detail: string): { readonly ok: false; readonly failure: SequencerFailure } {
	return { ok: false, failure: { kind: 'storage', detail } }
}

function errorCode(error: unknown) {
	return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : undefined
}

// Writes `data` at the current position of the handle, looping over partial writes.
async function writeAll(handle: FileHandle, data: Uint8Array) {
	for (let offset = 0; offset < data.byteLength;) {
		const { bytesWritten } = await handle.write(data, offset, data.byteLength - offset)
		if (!(bytesWritten > 0)) throw new Error('write made no progress')
		offset += bytesWritten
	}
}

// Creates `path` exclusively (never overwriting), writes `data` and fsyncs it before resolving.
async function writeExclusive(path: string, data: Uint8Array | string) {
	const handle = await open(path, 'wx')

	try {
		await writeAll(handle, typeof data === 'string' ? Buffer.from(data) : data)
		await handle.sync()
	} finally {
		await handle.close()
	}
}

// Creates a directory and its missing parents; on POSIX the parent of every directory it created is fsynced, so the
// new entries survive a power loss like the files written into them.
async function makeDirectory(path: string) {
	const created = await mkdir(path, { recursive: true })
	if (created === undefined) return

	for (let directory = path; ; directory = dirname(directory)) {
		await fsyncDirectory(dirname(directory))
		if (directory === created || dirname(directory) === directory) return
	}
}

// Creates an empty file when it does not exist, leaving an existing one as is.
async function ensureFile(path: string) {
	await (await open(path, 'a')).close()
}

// Fsyncs a regular file.
async function fsyncFile(path: string) {
	const handle = await open(path, 'r+')

	try {
		await handle.sync()
	} finally {
		await handle.close()
	}
}

// Fsyncs a directory so the entries created or removed in it are durable. Windows cannot open a directory, so it is
// skipped there.
async function fsyncDirectory(path: string) {
	if (process.platform === 'win32') return
	const handle = await open(path, 'r')

	try {
		await handle.sync()
	} finally {
		await handle.close()
	}
}

// Exclusive copy fsynced and verified by size and digest; a differing copy is removed and fails.
async function copyVerified(from: string, to: string, size: number, digest: string | undefined) {
	await copyFile(from, to, constants.COPYFILE_EXCL)
	await fsyncFile(to)

	if (!(await matchesFile(to, size, digest))) {
		await unlink(to)
		throw new Error(`copy of ${from} to ${to} differs from its source`)
	}
}

// SHA-256 of a file, lowercase hex, computed by streaming.
async function sha256(path: string) {
	const hasher = new Bun.CryptoHasher('sha256')
	for await (const chunk of Bun.file(path).stream()) hasher.update(chunk)
	return hasher.digest('hex')
}

// Whether a file exists with `size` bytes and, when given, the SHA-256 `digest`.
async function matchesFile(path: string, size: number, digest: string | undefined) {
	const stats = await statIfExists(path)
	if (stats === undefined || Number(stats.size) !== size) return false
	return digest === undefined || (await sha256(path)) === digest
}

// Whether two paths are the same file (same inode on the same device).
async function isSameFile(a: string, b: string) {
	const [first, second] = await Promise.all([statIfExists(a), statIfExists(b)])
	return first !== undefined && second !== undefined && first.ino === second.ino && first.dev === second.dev
}

// Exact stats (bigint inode and device) of a path, or undefined when it does not exist.
async function statIfExists(path: string) {
	try {
		return await stat(path, { bigint: true })
	} catch (error) {
		if (errorCode(error) === 'ENOENT') return undefined
		throw error
	}
}

// Text of a file, or undefined when it does not exist.
async function readTextIfExists(path: string) {
	try {
		return await readFile(path, 'utf-8')
	} catch (error) {
		if (errorCode(error) === 'ENOENT') return undefined
		throw error
	}
}

async function unlinkIfExists(path: string) {
	try {
		await unlink(path)
	} catch (error) {
		if (errorCode(error) !== 'ENOENT') throw error
	}
}

// Removes a file, ignoring every failure.
async function removeQuietly(path: string) {
	await unlink(path).catch(() => undefined)
}

// Parsed JSON, or undefined when the text is not JSON.
function parseJson(text: string): unknown {
	try {
		return JSON.parse(text)
	} catch {
		return undefined
	}
}

// Validation of the files read back from disk, which are external input: a value of the expected shape is returned
// as is (never copied), anything else is undefined.

type JsonObject = Readonly<Record<string, unknown>>

function isObject(value: unknown): value is JsonObject {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isString(value: unknown): value is string {
	return typeof value === 'string'
}

function isCount(value: unknown, minimum = 0): value is number {
	return Number.isSafeInteger(value) && (value as number) >= minimum
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value)
}

function isOptional(value: unknown, check: (value: unknown) => boolean) {
	return value === undefined || check(value)
}

// Whether every own value of an object passes `check`.
function isRecordOf(value: unknown, check: (value: unknown) => boolean) {
	return isObject(value) && Object.values(value).every(check)
}

// A journal path: relative, `/`-separated portable segments, so it never escapes the session directory.
function isJournalPath(value: unknown): value is string {
	return isString(value) && value.split('/').every(isPathSegment)
}

function parseSessionLock(text: string | undefined): SequencerSessionLock | undefined {
	const value = text === undefined ? undefined : parseJson(text)
	if (!isObject(value)) return undefined
	const { sessionId, ownerToken, pid, host, createdAt } = value
	return isString(sessionId) && isString(ownerToken) && ownerToken.length > 0 && isCount(pid, 1) && isString(host) && isFiniteNumber(createdAt) ? (value as unknown as SequencerSessionLock) : undefined
}

function isGroupCounters(value: unknown) {
	return isObject(value) && isCount(value.accepted) && isCount(value.forced) && isCount(value.discarded) && isCount(value.skipped)
}

function isFilterReference(value: unknown) {
	return isObject(value) && ((value.kind === 'slot' && isCount(value.slot)) || (value.kind === 'name' && isString(value.name)))
}

function isCalibrationBatch(value: unknown) {
	return isObject(value) && isString(value.groupId) && isCount(value.firstOrdinal, 1) && isCount(value.size, 1) && isObject(value.capture) && isOptional(value.filter, isFilterReference) && isOptional(value.triggeredBy, isString)
}

function isSchedulerState(value: unknown) {
	return isObject(value) && isOptional(value.cursor, isString) && isRecordOf(value.credits, isFiniteNumber) && Array.isArray(value.batches) && value.batches.every(isCalibrationBatch) && typeof value.sessionStartQueued === 'boolean' && typeof value.sessionEndQueued === 'boolean'
}

function isActionAnchor(value: unknown): value is JsonObject {
	return isObject(value) && isCount(value.lightExposures) && isOptional(value.lastSuccessfulAt, isFiniteNumber)
}

function isTriggerAnchors(value: unknown) {
	if (!isObject(value) || !isCount(value.lightExposures) || !isActionAnchor(value.dither) || !isActionAnchor(value.recenter)) return false
	const { autofocus, calibration } = value
	return isActionAnchor(autofocus) && isOptional(autofocus.temperature, isFiniteNumber) && isOptional(autofocus.filter, isString) && isRecordOf(calibration, (anchor) => isObject(anchor) && isCount(anchor.lightExposures) && isCount(anchor.batches) && isOptional(anchor.sensorTemperature, isFiniteNumber))
}

function isFocusBaseline(value: unknown) {
	return isObject(value) && (value.kind === 'unset' || value.kind === 'unknown' || (value.kind === 'known' && isFiniteNumber(value.referencePosition)))
}

function isMountRiskObservation(value: unknown) {
	return isObject(value) && isFiniteNumber(value.at) && isFiniteNumber(value.hourAngle) && (value.pierSide === 'EAST' || value.pierSide === 'WEST' || value.pierSide === 'NEITHER') && typeof value.tracking === 'boolean'
}

function isCheckpointSlot(value: unknown) {
	return isObject(value) && isString(value.id) && isCount(value.attempt, 1) && isCount(value.discardedTotal) && isCount(value.discardBudgetUsed) && isCount(value.captureFailures)
}

// Checkpoint read from disk or from a journal transaction, or undefined when its shape is wrong.
export function parseSequencerCheckpoint(value: unknown): SequencerCheckpoint | undefined {
	if (!isObject(value) || value.version !== 1 || !isString(value.sessionId) || !isString(value.configurationId) || !isCount(value.configurationRevision)) return undefined
	if (!isRecordOf(value.capture, isGroupCounters) || !isSchedulerState(value.scheduler) || !isTriggerAnchors(value.anchors) || !isFocusBaseline(value.focus)) return undefined

	const { intents } = value
	if (!isObject(intents) || typeof intents.autofocus !== 'boolean' || typeof intents.recenter !== 'boolean' || typeof intents.recoverGuiding !== 'boolean') return undefined
	if (!isCount(value.meridianFlipAttempts) || !isOptional(value.meridianTransitAt, isFiniteNumber) || !isOptional(value.mountRiskObservation, isMountRiskObservation)) return undefined
	if (!isOptional(value.currentSlot, isCheckpointSlot) || !isCount(value.consecutiveDiscards) || !isCount(value.sequence) || !isFiniteNumber(value.updatedAt)) return undefined

	return value as unknown as SequencerCheckpoint
}

const DEFER_REASONS = new Set<unknown>(['guard', 'pause', 'meridian', 'safety', 'beforeExposure', 'stop'] satisfies SequencerDeferReason[])
const ABANDON_REASONS = new Set<unknown>(['crash', 'failed', 'interrupted'] satisfies SequencerAbandonReason[])
const DISCARD_ARTIFACTS = new Set<unknown>(['moveToRejected', 'keepInPlace', 'delete'] satisfies SequencerDiscardArtifact[])

function isMethod(value: unknown) {
	return value === 'link' || value === 'copy'
}

// Journal line, or undefined when its shape is wrong.
function parseJournalEntry(value: unknown): SequencerJournalEntry | undefined {
	if (!isObject(value) || !isFiniteNumber(value.at)) return undefined
	if (value.kind === 'lockReclaimed') return isString(value.previousOwnerToken) && isCount(value.previousPid) ? (value as unknown as SequencerJournalEntry) : undefined
	if (!isString(value.slot) || !isCount(value.attempt, 1)) return undefined

	const ok = (() => {
		switch (value.kind) {
			case 'prepared':
				return isJournalPath(value.temporary) && isJournalPath(value.final) && value.final.includes('/')
			case 'deferred':
				return DEFER_REASONS.has(value.reason)
			case 'promoting':
				return isJournalPath(value.temporary) && isJournalPath(value.final) && isMethod(value.method) && isCount(value.size) && isOptional(value.digest, isString) && typeof value.forced === 'boolean' && parseSequencerCheckpoint(value.next) !== undefined && isOptional(value.sensorTemperature, isFiniteNumber)
			case 'committed':
				return isJournalPath(value.final) && isMethod(value.method) && isCount(value.size) && isOptional(value.digest, isString) && isCount(value.sequence)
			case 'disposing':
				return isJournalPath(value.temporary) && DISCARD_ARTIFACTS.has(value.artifact) && isOptional(value.destination, isJournalPath) && parseSequencerCheckpoint(value.next) !== undefined && isOptional(value.sensorTemperature, isFiniteNumber)
			case 'disposed':
				return isCount(value.sequence)
			case 'abandoned':
				return ABANDON_REASONS.has(value.reason)
			default:
				return false
		}
	})()

	return ok ? (value as unknown as SequencerJournalEntry) : undefined
}
