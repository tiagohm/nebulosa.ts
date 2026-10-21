import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { hostname, tmpdir } from 'os'
import { basename, join, relative, sep } from 'path'
import { type Camera, DEFAULT_CAMERA } from '../../../src/devices/indi/device'
import { failedOperationResult, OperationCoordinator, type OperationResult, successfulOperationResult } from '../../../src/devices/orchestration/operation'
import { ResourceArbiter } from '../../../src/devices/orchestration/resource'
import { isPathSegment } from '../../../src/io/path'
import { mulberry32, type Random } from '../../../src/math/numerical/random'
import { type SequencerCaptureContext, type SequencerCapturedFrame, type SequencerContext, type SequencerRunner, type SequencerShutdownTask, type SequencerTask, type SequencerTaskResult, startSequencerRunner } from '../../../src/observation/sequencer/runner'
import { sequencerFrameSlotId } from '../../../src/observation/sequencer/scheduler'
// oxfmt-ignore
import type { SequencerCameraCapture, SequencerCaptureConfiguration, SequencerCheckpoint, SequencerCheckpointStore, SequencerConfiguration, SequencerEvent, SequencerFrameGroup, SequencerFrameSlot, SequencerResult } from '../../../src/observation/sequencer/sequencer'
import { createSequencerIntents, createSequencerSchedulerState, createSequencerTriggerAnchors } from '../../../src/observation/sequencer/state'
// oxfmt-ignore
import { FileSystemSequencerCheckpointStore, FileSystemSequencerStorage, type FileSystemSequencerStorageOptions, prepareFrameDestinationTask, readSequencerJournal, type SequencerJournalEntry, sequencerFrameDestination } from '../../../src/observation/sequencer/storage'
import { isTimeConsumingTestSkipped, waitUntil } from '../../util'
import { ManualClock } from '../../util/rig'
import { assertJournalInvariants, injectFileSystemFaults } from './util'

const LIGHT: SequencerCameraCapture = { exposureTime: 60, exposureTimeUnit: 'second', frameType: 'LIGHT', x: 0, y: 0, width: 0, height: 0, subframe: false, binX: 1, binY: 1, frameFormat: '', gain: 100, offset: 10, compressed: false }
const DARK: SequencerCameraCapture = { ...LIGHT, frameType: 'DARK' }

// Bytes of a fake frame; another frame of the same size differs only in content.
const FRAME = Buffer.from('SIMPLE  =                    T / fake frame of the storage tests')
const OTHER_FRAME = Buffer.from('SIMPLE  =                    T / other frame of the storage test')

// Root of the session directories of this file.
const ROOT = await mkdtemp(join(tmpdir(), 'nebulosa-sequencer-storage-'))

afterAll(async () => {
	await rm(ROOT, { recursive: true, force: true })
})

function storageOf(options: Partial<FileSystemSequencerStorageOptions> = {}) {
	return new FileSystemSequencerStorage({ root: ROOT, sessionId: Bun.randomUUIDv7(), ...options })
}

// Locked storage of a session; `copy` locks it on a volume without hard links, so it promotes by copy.
async function lockedStorage(options: Partial<FileSystemSequencerStorageOptions> = {}, copy: boolean = false) {
	const storage = storageOf(options)
	using _ = copy ? injectFileSystemFaults({ linkError: 'EPERM' }) : undefined
	expect(await storage.lock()).toEqual({ ok: true, value: undefined })
	return storage
}

// The next process of the same session: a new storage of the same directory.
function reopen(storage: FileSystemSequencerStorage, options: Partial<FileSystemSequencerStorageOptions> = {}) {
	return storageOf({ sessionId: storage.sessionId, ...options })
}

function slotOf(groupId: string, ordinal: number, attempt: number = 1, kind: SequencerFrameSlot['kind'] = 'scheduled'): SequencerFrameSlot {
	return { id: sequencerFrameSlotId(groupId, ordinal), groupId, kind, ordinal, attempt, discardedTotal: 0, discardBudgetUsed: 0, captureFailures: 0, capture: kind === 'scheduled' ? LIGHT : DARK }
}

function configurationOf(groups: readonly SequencerFrameGroup[] = [scheduled('L', 1)], capture: Partial<SequencerCaptureConfiguration> = {}): SequencerConfiguration {
	return {
		schemaVersion: 1,
		id: 'session',
		revision: 1,
		name: 'Session',
		capture: { order: 'sequential', groups, retry: { maxAttempts: 3, delay: 0, backoff: 1, maximumDelay: 0, retryOn: ['timeout'] }, onFailure: 'fail', cameraRecovery: { onTimeout: 'stop' }, ...capture },
		startup: { onFailure: 'fail' },
		shutdown: { stepTimeout: 30, totalTimeout: 300 },
		execution: { compensation: { timeout: 30 } },
	}
}

function scheduled(id: string, count: number): SequencerFrameGroup {
	return { kind: 'scheduled', id, enabled: true, capture: LIGHT, count, weight: 1 }
}

// Checkpoint of the default configuration with `sequence`.
function checkpointOf(sessionId: string, sequence: number, patch: Partial<SequencerCheckpoint> = {}): SequencerCheckpoint {
	const configuration = configurationOf()
	return {
		version: 1,
		sessionId,
		configurationId: configuration.id,
		configurationRevision: configuration.revision,
		capture: { L: { accepted: 0, forced: 0, discarded: 0, skipped: 0 } },
		scheduler: createSequencerSchedulerState(),
		anchors: createSequencerTriggerAnchors(configuration),
		intents: createSequencerIntents(),
		focus: { kind: 'unset' },
		meridianFlipAttempts: 0,
		consecutiveDiscards: 0,
		sequence,
		updatedAt: 0,
		...patch,
	}
}

async function journalOf(storage: FileSystemSequencerStorage) {
	return await readSequencerJournal(join(storage.directory!, 'journal.jsonl'))
}

function kindsOf(journal: readonly SequencerJournalEntry[]) {
	return journal.map((entry) => entry.kind)
}

// Every file under a session directory, relative with `/` separators, sorted.
function filesOf(directory: string) {
	return (readdirSync(directory, { recursive: true }) as string[])
		.filter((path) => statSync(join(directory, path)).isFile())
		.map((path) => path.split(sep).join('/'))
		.sort()
}

// Whether a path is the lock of a session, which a simulated crash still releases.
function isLockPath(path: string) {
	const name = basename(path)
	return name === 'session.lock' || name === 'session.lock.reclaim' || /^\.session\.lock\..+\.tmp$/.test(name)
}

// Prepares the attempt of `slot` and writes its temporary as a capture would.
async function captureInto(storage: FileSystemSequencerStorage, slot: SequencerFrameSlot, data: Buffer = FRAME) {
	const prepared = await storage.prepare(slot)
	if (!prepared.ok) throw new Error(prepared.failure.detail)
	await storage.writeDurably(prepared.value.temporary, data)
	return prepared.value
}

// Recovers a session in a new process and records every checkpoint the recovery saved.
async function recoverIn(storage: FileSystemSequencerStorage, persisted: SequencerCheckpoint | undefined, copy: boolean = false) {
	const next = reopen(storage)

	{
		using _ = copy ? injectFileSystemFaults({ linkError: 'EPERM' }) : undefined
		expect((await next.lock()).ok).toBeTrue()
	}

	const saved: SequencerCheckpoint[] = []
	const recovery = await next.recover(persisted, (checkpoint) => {
		saved.push(checkpoint)
		return Promise.resolve()
	})
	return { storage: next, recovery, saved }
}

describe('names', () => {
	test('35: frame[L][1] has the final L/frame[L][1].fit and the hidden temporary L/.frame[L][1].1.partial.fit', () => {
		const destination = sequencerFrameDestination(join('root', 'session'), 'L', 'frame[L][1]', 1)
		expect(destination).toEqual({ slot: 'frame[L][1]', groupId: 'L', attempt: 1, final: join('root', 'session', 'L', 'frame[L][1].fit'), temporary: join('root', 'session', 'L', '.frame[L][1].1.partial.fit') })
		// 5: the hidden temporary is a portable path segment.
		expect(isPathSegment(basename(destination.temporary))).toBeTrue()
	})

	test('5: a group id that is not a portable path segment is refused before anything is written', async () => {
		const storage = await lockedStorage()
		const prepared = await storage.prepare(slotOf('L:R', 1))
		expect(prepared).toMatchObject({ ok: false, failure: { kind: 'storage' } })
		expect(await journalOf(storage)).toEqual([])
		await storage.release()
	})

	test('35, 36: the journal records paths relative to the session; a discard goes to rejected/{group}/{slot id}.{attempt}.fit', async () => {
		const storage = await lockedStorage()
		await captureInto(storage, slotOf('L', 1))
		const disposed = await storage.dispose('moveToRejected', checkpointOf(storage.sessionId, 1))
		expect(disposed).toEqual({ ok: true, value: join(storage.directory!, 'rejected', 'L', 'frame[L][1].1.fit') })

		const journal = await journalOf(storage)
		expect(journal[0]).toMatchObject({ kind: 'prepared', slot: 'frame[L][1]', attempt: 1, temporary: 'L/.frame[L][1].1.partial.fit', final: 'L/frame[L][1].fit' })
		expect(journal[1]).toMatchObject({ kind: 'disposing', artifact: 'moveToRejected', destination: 'rejected/L/frame[L][1].1.fit' })
		expect(kindsOf(journal)).toEqual(['prepared', 'disposing', 'disposed'])
		expect(filesOf(storage.directory!)).toEqual(['journal.jsonl', 'rejected/L/frame[L][1].1.fit', 'session.lock'])
		assertJournalInvariants(journal)
		await storage.release()
	})

	test('8A.6: the measured sensor temperature is journaled with the transaction and read back; without one it is absent', async () => {
		const storage = await lockedStorage()
		await captureInto(storage, slotOf('L', 1))
		await storage.dispose('delete', checkpointOf(storage.sessionId, 1), -10.25)
		await captureInto(storage, slotOf('L', 1, 2))
		await storage.promote(checkpointOf(storage.sessionId, 2), false, 3.5)
		await captureInto(storage, slotOf('L', 2))
		await storage.promote(checkpointOf(storage.sessionId, 3), false)

		const journal = await journalOf(storage)
		expect(journal.filter((entry) => entry.kind === 'disposing' || entry.kind === 'promoting').map((entry) => (entry as { sensorTemperature?: number }).sensorTemperature)).toEqual([-10.25, 3.5, undefined])
		expect(journal.find((entry) => entry.kind === 'promoting' && entry.slot === 'frame[L][2]')).not.toHaveProperty('sensorTemperature')
		assertJournalInvariants(journal)
		await storage.release()
	})

	test('a keepInPlace discard stays in the group directory and a deleted one is removed', async () => {
		const storage = await lockedStorage()
		await captureInto(storage, slotOf('L', 1))
		expect(await storage.dispose('keepInPlace', checkpointOf(storage.sessionId, 1))).toEqual({ ok: true, value: join(storage.directory!, 'L', 'frame[L][1].1.discarded.fit') })
		await captureInto(storage, slotOf('L', 1, 2))
		expect(await storage.dispose('delete', checkpointOf(storage.sessionId, 2))).toEqual({ ok: true, value: undefined })
		expect(filesOf(storage.directory!)).toEqual(['L/frame[L][1].1.discarded.fit', 'journal.jsonl', 'session.lock'])
		await storage.release()
	})
})

describe('promotion', () => {
	test('1: link promotes to the final on the same inode, then removes the temporary; the journal carries the transaction', async () => {
		const storage = await lockedStorage()
		expect(storage.method).toBe('link')
		const destination = await captureInto(storage, slotOf('L', 1))
		const next = checkpointOf(storage.sessionId, 7)

		expect(await storage.promote(next, false)).toEqual({ ok: true, value: destination.final })
		expect(readFileSync(destination.final)).toEqual(FRAME)
		expect(existsSync(destination.temporary)).toBeFalse()
		expect(storage.prepared).toBeUndefined()

		const journal = await journalOf(storage)
		expect(kindsOf(journal)).toEqual(['prepared', 'promoting', 'committed'])
		expect(journal[1]).toMatchObject({ method: 'link', size: FRAME.byteLength, forced: false, next })
		expect(journal[1]).not.toHaveProperty('digest')
		expect(journal[2]).toMatchObject({ final: 'L/frame[L][1].fit', size: FRAME.byteLength, sequence: 7 })
		await storage.release()
	})

	test('1: a final that appears before the promotion is never overwritten', async () => {
		const storage = await lockedStorage()
		const destination = await captureInto(storage, slotOf('L', 1))
		writeFileSync(destination.final, OTHER_FRAME)

		expect(await storage.promote(checkpointOf(storage.sessionId, 1), false)).toMatchObject({ ok: false, failure: { kind: 'storage' } })
		expect(readFileSync(destination.final)).toEqual(OTHER_FRAME)
		expect(readFileSync(destination.temporary)).toEqual(FRAME)
		await storage.release()
	})

	test('1: a slot whose final already exists is refused at the preparation', async () => {
		const storage = await lockedStorage()
		await mkdir(join(storage.directory!, 'L'))
		writeFileSync(join(storage.directory!, 'L', 'frame[L][1].fit'), OTHER_FRAME)
		expect(await storage.prepare(slotOf('L', 1))).toMatchObject({ ok: false, failure: { kind: 'storage', detail: expect.stringContaining('already exists') } })
		await storage.release()
	})

	test('1: without hard links the lock probe chooses copy from the first frame: exclusive copy verified by size and digest', async () => {
		using faults = injectFileSystemFaults({ linkError: 'EPERM' })
		const storage = await lockedStorage()
		expect(storage.method).toBe('copy')
		const destination = await captureInto(storage, slotOf('L', 1))
		const links = faults.entries.filter((entry) => entry.operation === 'link').length

		expect(await storage.promote(checkpointOf(storage.sessionId, 1), false)).toEqual({ ok: true, value: destination.final })
		expect(faults.entries.filter((entry) => entry.operation === 'link')).toHaveLength(links)
		expect(faults.entries.some((entry) => entry.operation === 'copyFile' && entry.paths[1] === destination.final)).toBeTrue()
		expect(readFileSync(destination.final)).toEqual(FRAME)
		expect(existsSync(destination.temporary)).toBeFalse()

		const journal = await journalOf(storage)
		const digest = new Bun.CryptoHasher('sha256').update(FRAME).digest('hex')
		expect(journal[1]).toMatchObject({ kind: 'promoting', method: 'copy', size: FRAME.byteLength, digest })
		expect(journal[2]).toMatchObject({ kind: 'committed', method: 'copy', digest })
		await storage.release()
	})

	test('6: the temporary of a copy is removed only after committed', async () => {
		using faults = injectFileSystemFaults({ linkError: 'EPERM' })
		const storage = await lockedStorage()
		const destination = await captureInto(storage, slotOf('L', 1))
		await storage.promote(checkpointOf(storage.sessionId, 1), false)

		const committed = faults.entries.findLast((entry) => entry.operation === 'sync' && entry.paths[0].endsWith('journal.jsonl'))!
		const removed = faults.entries.find((entry) => entry.operation === 'unlink' && entry.paths[0] === destination.temporary)!
		expect(removed.sequence).toBeGreaterThan(committed.sequence)
		await storage.release()
	})

	test('2: a failed capture commits nothing and removes the temporary it wrote', async () => {
		const storage = await lockedStorage()
		const destination = await captureInto(storage, slotOf('L', 1))
		expect(await storage.abandon('failed')).toEqual({ ok: true, value: undefined })
		expect(existsSync(destination.temporary)).toBeFalse()
		expect(kindsOf(await journalOf(storage))).toEqual(['prepared', 'abandoned'])
		expect(filesOf(storage.directory!)).toEqual(['journal.jsonl', 'session.lock'])
		await storage.release()
	})

	test('writeDurably never overwrites and resolves only after the fsync', async () => {
		using faults = injectFileSystemFaults()
		const storage = await lockedStorage()
		const path = join(storage.directory!, 'frame.fit')
		await storage.writeDurably(path, FRAME)
		const operations = faults.entries.filter((entry) => entry.paths[0] === path).map((entry) => entry.operation)
		expect(operations).toEqual(['open', 'write', 'sync'])
		expect(storage.writeDurably(path, OTHER_FRAME)).rejects.toThrow()
		expect(readFileSync(path)).toEqual(FRAME)
		await storage.release()
	})

	test('defer closes a prepared attempt that wrote nothing and is refused once its temporary exists', async () => {
		const storage = await lockedStorage()
		await storage.prepare(slotOf('L', 1))
		expect(await storage.defer('pause')).toEqual({ ok: true, value: undefined })
		expect(storage.prepared).toBeUndefined()

		const destination = await captureInto(storage, slotOf('L', 1))
		expect(await storage.defer('stop')).toMatchObject({ ok: false, failure: { kind: 'storage' } })
		expect(storage.prepared).toEqual(destination)
		expect(kindsOf(await journalOf(storage))).toEqual(['prepared', 'deferred', 'prepared'])
		await storage.release()
	})
})

// Liveness probes of `process.kill(pid, 0)`.
const ALIVE = () => true
const errno = (code: string) => () => {
	throw Object.assign(new Error(code), { code })
}
const DEAD = errno('ESRCH')

// Another process of this host: its own registry, process id and liveness probe.
function anotherProcess(kill: (pid: number, signal: number) => unknown = ALIVE, pid = 40001): Partial<FileSystemSequencerStorageOptions> {
	return { registry: new Map(), pid, kill }
}

// Writes the lock a process left behind in the directory of a session; a string is written as is.
async function leaveLock(sessionId: string, lock: Partial<{ sessionId: string; ownerToken: string; pid: number; host: string; createdAt: number }> | string) {
	const directory = join(ROOT, sessionId)
	await mkdir(directory, { recursive: true })
	const payload = typeof lock === 'string' ? lock : JSON.stringify({ sessionId, ownerToken: Bun.randomUUIDv7(), pid: 39999, host: hostname(), createdAt: 0, ...lock })
	await writeFile(join(directory, 'session.lock'), payload)
	return join(directory, 'session.lock')
}

function lockOf(storage: FileSystemSequencerStorage) {
	return JSON.parse(readFileSync(join(ROOT, storage.sessionId, 'session.lock'), 'utf-8'))
}

// Silences console.error for an expected report.
function silenceConsoleError() {
	const original = console.error
	console.error = () => {}
	return { restore: () => (console.error = original) }
}

describe('lock', () => {
	test('7: a second process is refused; an orphan of this host is reclaimed; another host is never reclaimed', async () => {
		const owner = await lockedStorage()
		expect(lockOf(owner)).toMatchObject({ sessionId: owner.sessionId, pid: process.pid, host: hostname() })
		expect(await reopen(owner, anotherProcess()).lock()).toMatchObject({ ok: false, failure: { kind: 'storage', detail: expect.stringContaining(`process ${process.pid}`) } })
		await owner.release()

		const orphan = storageOf()
		await leaveLock(orphan.sessionId, { ownerToken: 'dead-owner', pid: 39999 })
		const reclaimer = reopen(orphan, anotherProcess(DEAD))
		expect((await reclaimer.lock()).ok).toBeTrue()
		expect(lockOf(reclaimer)).toMatchObject({ pid: 40001 })
		expect(await journalOf(reclaimer)).toMatchObject([{ kind: 'lockReclaimed', previousOwnerToken: 'dead-owner', previousPid: 39999 }])
		await reclaimer.release()

		const remote = storageOf()
		await leaveLock(remote.sessionId, { host: 'another-host' })
		expect(await reopen(remote, anotherProcess(DEAD)).lock()).toMatchObject({ ok: false, failure: { detail: expect.stringContaining('another-host') } })
	})

	test('8: a crash between the payload and the link leaves only an ignored temporary, removed once its pid is known dead', async () => {
		const storage = storageOf()
		const directory = join(ROOT, storage.sessionId)
		await mkdir(directory)
		const dead = join(directory, '.session.lock.dead-token.tmp')
		const live = join(directory, '.session.lock.live-token.tmp')
		await writeFile(dead, JSON.stringify({ sessionId: storage.sessionId, ownerToken: 'dead-token', pid: 39998, host: hostname(), createdAt: 0 }))
		await writeFile(live, JSON.stringify({ sessionId: storage.sessionId, ownerToken: 'live-token', pid: 39997, host: hostname(), createdAt: 0 }))

		const acquirer = reopen(
			storage,
			anotherProcess((pid) => (pid === 39998 ? DEAD() : true)),
		)
		expect((await acquirer.lock()).ok).toBeTrue()
		expect(existsSync(dead)).toBeFalse()
		expect(existsSync(live)).toBeTrue()
		expect(filesOf(directory)).toEqual(['.session.lock.live-token.tmp', 'journal.jsonl', 'session.lock'])
		await acquirer.release()
	})

	test('8: without hard links the lock is created exclusively (O_EXCL) and visible only complete', async () => {
		using faults = injectFileSystemFaults({ linkError: 'EPERM' })
		const storage = await lockedStorage()
		const lock = join(storage.directory!, 'session.lock')
		expect(faults.entries.find((entry) => entry.operation === 'link')).toMatchObject({ paths: [expect.stringMatching(/\.session\.lock\..+\.tmp$/), lock], failed: true })
		expect(faults.entries.filter((entry) => entry.paths[0] === lock).map((entry) => entry.operation)).toEqual(['open', 'write', 'sync'])
		expect(lockOf(storage).ownerToken).toBeString()
		await storage.release()
	})

	test('9: never reclaimed: empty or malformed payload, another session, EPERM, an unknown probe error, a live reused pid, a leftover guard', async () => {
		const refused = async (lock: Parameters<typeof leaveLock>[1], kill: (pid: number, signal: number) => unknown = DEAD) => {
			const storage = storageOf()
			const path = await leaveLock(storage.sessionId, lock)
			const before = readFileSync(path, 'utf-8')
			const result = await reopen(storage, anotherProcess(kill)).lock()
			expect(result).toMatchObject({ ok: false, failure: { kind: 'storage' } })
			expect(readFileSync(path, 'utf-8')).toBe(before)
			return result.ok ? '' : result.failure.detail!
		}

		expect(await refused('')).toContain('malformed')
		expect(await refused('{"sessionId":')).toContain('malformed')
		expect(await refused({ pid: 0 })).toContain('malformed')
		expect(await refused({ sessionId: 'another-session' })).toContain('another-session')
		expect(await refused({}, errno('EPERM'))).toContain('locked by process')
		expect(await refused({}, errno('EINVAL'))).toContain('cannot verify')
		expect(await refused({}, ALIVE)).toContain('locked by process')

		const guarded = storageOf()
		await leaveLock(guarded.sessionId, {})
		await writeFile(join(ROOT, guarded.sessionId, 'session.lock.reclaim'), '{}')
		expect(await reopen(guarded, anotherProcess(DEAD)).lock()).toMatchObject({ ok: false, failure: { detail: expect.stringContaining('reclaim') } })
		expect(existsSync(join(ROOT, guarded.sessionId, 'session.lock.reclaim'))).toBeTrue()
	})

	test('10: the pid of this process with a token unknown to the registry (a reboot reused it) is reclaimed', async () => {
		const storage = storageOf()
		await leaveLock(storage.sessionId, { ownerToken: 'before-reboot', pid: process.pid })
		expect((await storage.lock()).ok).toBeTrue()
		expect(await journalOf(storage)).toMatchObject([{ kind: 'lockReclaimed', previousOwnerToken: 'before-reboot', previousPid: process.pid }])
		await storage.release()
	})

	test('11: two processes reclaiming the same orphan at once: exactly one acquires', async () => {
		for (let i = 0; i < 20; i++) {
			const storage = storageOf()
			await leaveLock(storage.sessionId, { pid: 39999 })
			const kill = (pid: number) => (pid === 39999 ? DEAD() : true)
			const a = reopen(storage, anotherProcess(kill, 40001))
			const b = reopen(storage, anotherProcess(kill, 40002))
			const results = await Promise.all([a.lock(), b.lock()])

			expect(results.filter((result) => result.ok)).toHaveLength(1)
			const winner = results[0].ok ? a : b
			expect(lockOf(winner).pid).toBe(winner === a ? 40001 : 40002)
			expect(existsSync(join(ROOT, storage.sessionId, 'session.lock.reclaim'))).toBeFalse()
			await winner.release()
		}
	})

	test('12: only the owner removes the lock; a normal release lets another process acquire without reclaim', async () => {
		const storage = await lockedStorage()
		const path = join(storage.directory!, 'session.lock')
		const replaced = JSON.stringify({ sessionId: storage.sessionId, ownerToken: 'operator', pid: 39999, host: hostname(), createdAt: 0 })
		await writeFile(path, replaced)
		await storage.release()
		expect(readFileSync(path, 'utf-8')).toBe(replaced)

		const owner = await lockedStorage()
		await owner.release()
		expect(existsSync(join(ROOT, owner.sessionId, 'session.lock'))).toBeFalse()
		const next = reopen(owner, anotherProcess(DEAD))
		expect((await next.lock()).ok).toBeTrue()
		expect(await journalOf(next)).toEqual([])
		await next.release()
	})

	test('13: the session directory is fsynced on POSIX and never opened on Windows', async () => {
		using faults = injectFileSystemFaults()
		const storage = await lockedStorage()
		const directory = storage.directory!
		if (process.platform === 'win32') expect(faults.entries.some((entry) => entry.paths[0] === directory)).toBeFalse()
		else expect(faults.entries.some((entry) => entry.operation === 'sync' && entry.paths[0] === directory)).toBeTrue()
		await storage.release()
	})

	test('14: a second storage of this process is busy without touching the lock, until the first releases', async () => {
		const a = await lockedStorage()
		const lock = readFileSync(join(a.directory!, 'session.lock'), 'utf-8')
		const b = reopen(a)

		{
			using faults = injectFileSystemFaults()
			expect(await b.lock()).toMatchObject({ ok: false, failure: { detail: expect.stringContaining('locked by this process') } })
			expect(faults.entries).toEqual([])
			expect(readFileSync(join(a.directory!, 'session.lock'), 'utf-8')).toBe(lock)
		}

		await a.release()
		expect((await b.lock()).ok).toBeTrue()
		expect(await journalOf(b)).toEqual([])
		await b.release()
	})

	test('14 (incorrect variant): a registry private to each storage would let the second one reclaim a live lock', async () => {
		const a = await lockedStorage()
		const b = reopen(a, { registry: new Map() })
		expect((await b.lock()).ok).toBeTrue()
		expect(await journalOf(b)).toMatchObject([{ kind: 'lockReclaimed', previousPid: process.pid }])
		await b.release()
		await a.release()
	})

	test('14: equivalent paths share the registry key by realpath; different sessions are independent', async () => {
		const a = await lockedStorage()
		const variants = [relative(process.cwd(), ROOT), join(ROOT, '..', basename(ROOT)), `${ROOT}${sep}`, ...(process.platform === 'win32' ? [ROOT.toUpperCase()] : [])]

		for (const root of variants) {
			expect(await new FileSystemSequencerStorage({ root, sessionId: a.sessionId }).lock()).toMatchObject({ ok: false, failure: { detail: expect.stringContaining('locked by this process') } })
		}

		const other = await lockedStorage()
		await other.release()
		await a.release()
	})

	test('14: a racing acquisition of the same process is busy; a failed acquisition and a failed release keep the registry safe', async () => {
		const first = storageOf()
		const second = reopen(first)
		const results = await Promise.all([first.lock(), second.lock()])
		expect(results.filter((result) => result.ok)).toHaveLength(1)
		expect(results.find((result) => !result.ok)).toMatchObject({ failure: { detail: expect.stringContaining('locked by this process') } })
		const a = results[0].ok ? first : second
		await a.release()

		{
			using _ = injectFileSystemFaults({ failAt: 1, operations: ['link'] })
			expect((await a.lock()).ok).toBeFalse()
		}

		expect((await a.lock()).ok).toBeTrue()

		{
			using _ = injectFileSystemFaults({ failAt: 1, operations: ['unlink'] })
			const silenced = silenceConsoleError()
			await a.release()
			silenced.restore()
		}

		// The release failed: the lock is still owned in this process, so nothing else acquires it.
		expect(await reopen(a).lock()).toMatchObject({ ok: false, failure: { detail: expect.stringContaining('locked by this process') } })
		await a.release()
		expect(existsSync(join(ROOT, a.sessionId, 'session.lock'))).toBeFalse()
	})

	test('15: busy acquisitions leave no temporary; a failure between the payload and the link removes its own temporary only', async () => {
		const owner = await lockedStorage()
		const directory = owner.directory!

		for (let i = 0; i < 20; i++) expect((await reopen(owner, anotherProcess()).lock()).ok).toBeFalse()
		expect(readdirSync(directory).filter((name) => name.startsWith('.session.lock.'))).toEqual([])
		await owner.release()

		await writeFile(join(directory, '.session.lock.foreign.tmp'), JSON.stringify({ sessionId: owner.sessionId, ownerToken: 'foreign', pid: 39996, host: hostname(), createdAt: 0 }))

		{
			using _ = injectFileSystemFaults({ failAt: 1, operations: ['link'] })
			expect((await reopen(owner, anotherProcess()).lock()).ok).toBeFalse()
		}

		expect(readdirSync(directory).filter((name) => name.startsWith('.session.lock.'))).toEqual(['.session.lock.foreign.tmp'])
	})
})

// Slot frame[L][1] in progress at `attempt`, as the checkpoint saved at its selection or after its failures persists it.
function inProgress(sessionId: string, sequence: number = 1, attempt: number = 1, captureFailures: number = attempt - 1) {
	return checkpointOf(sessionId, sequence, { currentSlot: { id: 'frame[L][1]', attempt, discardedTotal: 0, discardBudgetUsed: 0, captureFailures } })
}

// Transaction accepting frame[L][1] of a light with "dark after each light": one light exposure more, a dark batch with
// the captured settings frozen, a recenter requested by the analyzer, the slot done.
function acceptance(sessionId: string, sequence: number = 2) {
	const base = inProgress(sessionId, sequence)
	return checkpointOf(sessionId, sequence, {
		capture: { L: { accepted: 1, forced: 0, discarded: 0, skipped: 0 } },
		scheduler: { ...base.scheduler, batches: [{ groupId: 'D', firstOrdinal: 1, size: 1, capture: { ...LIGHT, frameType: 'DARK' }, triggeredBy: 'frame[L][1]' }], sessionStartQueued: true },
		anchors: { ...base.anchors, lightExposures: 1, calibration: { D: { lightExposures: 1, batches: 1 } } },
		intents: { autofocus: false, recenter: true, recoverGuiding: false },
	})
}

// Transaction discarding frame[L][1]#1 for a retake: the slot stays current at attempt 2 with its budget partly used.
function retake(sessionId: string, sequence: number = 2) {
	return checkpointOf(sessionId, sequence, {
		capture: { L: { accepted: 0, forced: 0, discarded: 1, skipped: 0 } },
		anchors: { ...createSequencerTriggerAnchors(configurationOf()), lightExposures: 1 },
		currentSlot: { id: 'frame[L][1]', attempt: 2, discardedTotal: 1, discardBudgetUsed: 1, captureFailures: 0 },
		consecutiveDiscards: 1,
	})
}

// Fault plan failing the `n`-th write of a journal line.
function journalWrite(n: number) {
	return { failAt: n, operations: ['write' as const], spare: (path: string) => !path.endsWith('journal.jsonl') }
}

// Fault plan failing the first `operation` on `path`.
function onPath(operation: 'link' | 'unlink' | 'copyFile', path: string, options: { readonly partialCopyBytes?: number; readonly linkError?: string } = {}) {
	return { failAt: 1, operations: [operation], spare: (touched: string) => touched !== path, ...options }
}

const SLOT = slotOf('L', 1)

describe('reconciliation (one row of section 36.6 per test)', () => {
	test('committed, final verified, checkpoint at or above the transaction: nothing happens', async () => {
		const storage = await lockedStorage()
		const next = acceptance(storage.sessionId)
		const destination = await captureInto(storage, SLOT)
		await storage.promote(next, false)
		await storage.release()

		const { storage: recovered, recovery, saved } = await recoverIn(storage, next)
		expect(recovery).toEqual({ ok: true, value: { checkpoint: next, warnings: [] } })
		expect(saved).toEqual([])
		expect(readFileSync(destination.final)).toEqual(FRAME)
		expect(kindsOf(await journalOf(recovered))).toEqual(['prepared', 'promoting', 'committed'])
		await recovered.release()
	})

	test('committed by copy with its temporary left behind: the temporary is removed', async () => {
		const storage = await lockedStorage({}, true)
		const next = acceptance(storage.sessionId)
		const destination = await captureInto(storage, SLOT)

		{
			using _ = injectFileSystemFaults(onPath('unlink', destination.temporary))
			expect((await storage.promote(next, false)).ok).toBeFalse()
		}

		await storage.release()
		expect(existsSync(destination.temporary)).toBeTrue()

		const { storage: recovered, recovery, saved } = await recoverIn(storage, next, true)
		expect(recovery.ok).toBeTrue()
		expect(saved).toEqual([])
		expect(existsSync(destination.temporary)).toBeFalse()
		expect(readFileSync(destination.final)).toEqual(FRAME)
		await recovered.release()
	})

	test('16: committed, checkpoint below the transaction: the transaction is reapplied exactly, also by a repeated recovery', async () => {
		const storage = await lockedStorage()
		const persisted = inProgress(storage.sessionId)
		const next = acceptance(storage.sessionId)
		await captureInto(storage, SLOT)
		await storage.promote(next, false)
		await storage.release()

		// The first recovery dies while saving; the second one reaches the same checkpoint.
		const failing = reopen(storage)
		await failing.lock()
		expect(await failing.recover(persisted, () => Promise.reject(new Error('disk full')))).toMatchObject({ ok: false, failure: { kind: 'storage' } })
		await failing.release()

		const { storage: recovered, recovery, saved } = await recoverIn(storage, persisted)
		expect(saved).toEqual([next])
		expect(recovery).toEqual({ ok: true, value: { checkpoint: next, warnings: [] } })
		expect(saved[0]).toMatchObject({ anchors: { lightExposures: 1 }, intents: { recenter: true }, scheduler: { batches: [{ groupId: 'D', capture: { frameType: 'DARK', exposureTime: 60 } }] }, consecutiveDiscards: 0 })
		expect(saved[0].currentSlot).toBeUndefined()
		await recovered.release()
	})

	test('18: a transaction whose sequence is not above the checkpoint is ignored', async () => {
		const storage = await lockedStorage()
		await captureInto(storage, SLOT)
		await storage.promote(acceptance(storage.sessionId, 2), false)
		await storage.release()

		const newer = inProgress(storage.sessionId, 5)
		const { storage: recovered, recovery, saved } = await recoverIn(storage, newer)
		expect(recovery).toEqual({ ok: true, value: { checkpoint: newer, warnings: [] } })
		expect(saved).toEqual([])
		await recovered.release()
	})

	test('promoting by link, final on the same inode as the temporary: the temporary goes, committed, reapplied', async () => {
		const storage = await lockedStorage()
		const next = acceptance(storage.sessionId)
		const destination = await captureInto(storage, SLOT)

		{
			using _ = injectFileSystemFaults(onPath('unlink', destination.temporary))
			expect((await storage.promote(next, false)).ok).toBeFalse()
		}

		await storage.release()
		const { storage: recovered, recovery, saved } = await recoverIn(storage, inProgress(storage.sessionId))
		expect(recovery).toEqual({ ok: true, value: { checkpoint: next, warnings: [] } })
		expect(saved).toEqual([next])
		expect(existsSync(destination.temporary)).toBeFalse()
		expect(readFileSync(destination.final)).toEqual(FRAME)
		expect(kindsOf(await journalOf(recovered))).toEqual(['prepared', 'promoting', 'committed'])
		await recovered.release()
	})

	test('promoting by link, temporary gone and final of the recorded size: committed, reapplied', async () => {
		const storage = await lockedStorage()
		const next = acceptance(storage.sessionId)
		const destination = await captureInto(storage, SLOT)

		{
			using _ = injectFileSystemFaults(journalWrite(2))
			expect((await storage.promote(next, false)).ok).toBeFalse()
		}

		await storage.release()
		expect(existsSync(destination.temporary)).toBeFalse()
		const { storage: recovered, recovery, saved } = await recoverIn(storage, inProgress(storage.sessionId))
		expect(recovery.ok).toBeTrue()
		expect(saved).toEqual([next])
		expect(kindsOf(await journalOf(recovered))).toEqual(['prepared', 'promoting', 'committed'])
		await recovered.release()
	})

	test('6: promoting by link, final of another inode: storage failure, final untouched, temporary moved to rejected/incomplete', async () => {
		const storage = await lockedStorage()
		const destination = await captureInto(storage, SLOT)

		{
			using _ = injectFileSystemFaults(onPath('link', destination.final))
			expect((await storage.promote(acceptance(storage.sessionId), false)).ok).toBeFalse()
		}

		await storage.release()
		writeFileSync(destination.final, OTHER_FRAME)

		const { storage: recovered, recovery, saved } = await recoverIn(storage, inProgress(storage.sessionId))
		expect(recovery).toMatchObject({ ok: false, failure: { kind: 'storage', detail: expect.stringContaining('another file') } })
		expect(saved).toEqual([])
		expect(readFileSync(destination.final)).toEqual(OTHER_FRAME)
		expect(readFileSync(join(recovered.directory!, 'rejected', 'incomplete', 'L', '.frame[L][1].1.partial.fit'))).toEqual(FRAME)
		await recovered.release()
	})

	test('promoting by link, only the temporary: the promotion is repeated', async () => {
		const storage = await lockedStorage()
		const next = acceptance(storage.sessionId)
		const destination = await captureInto(storage, SLOT)

		{
			using _ = injectFileSystemFaults(onPath('link', destination.final))
			expect((await storage.promote(next, false)).ok).toBeFalse()
		}

		await storage.release()
		const { storage: recovered, recovery, saved } = await recoverIn(storage, inProgress(storage.sessionId))
		expect(recovery.ok).toBeTrue()
		expect(saved).toEqual([next])
		expect(readFileSync(destination.final)).toEqual(FRAME)
		expect(existsSync(destination.temporary)).toBeFalse()
		await recovered.release()
	})

	test('promoting by copy, final verified and temporary present: committed, reapplied, then the temporary goes', async () => {
		const storage = await lockedStorage({}, true)
		const next = acceptance(storage.sessionId)
		const destination = await captureInto(storage, SLOT)

		{
			using _ = injectFileSystemFaults(journalWrite(2))
			expect((await storage.promote(next, false)).ok).toBeFalse()
		}

		await storage.release()
		expect(existsSync(destination.temporary)).toBeTrue()
		const { storage: recovered, recovery, saved } = await recoverIn(storage, inProgress(storage.sessionId), true)
		expect(recovery.ok).toBeTrue()
		expect(saved).toEqual([next])
		expect(existsSync(destination.temporary)).toBeFalse()
		expect(kindsOf(await journalOf(recovered))).toEqual(['prepared', 'promoting', 'committed'])
		await recovered.release()
	})

	test('6: promoting by copy, partial final and intact temporary: the partial is replaced and the temporary goes only after committed', async () => {
		const storage = await lockedStorage({}, true)
		const next = acceptance(storage.sessionId)
		const destination = await captureInto(storage, SLOT)

		{
			using _ = injectFileSystemFaults(onPath('copyFile', destination.temporary, { partialCopyBytes: 10 }))
			expect((await storage.promote(next, false)).ok).toBeFalse()
		}

		await storage.release()
		expect(readFileSync(destination.final)).toHaveLength(10)

		using faults = injectFileSystemFaults({ linkError: 'EPERM' })
		const { storage: recovered, recovery, saved } = await recoverIn(storage, inProgress(storage.sessionId))
		expect(recovery.ok).toBeTrue()
		expect(saved).toEqual([next])
		expect(readFileSync(destination.final)).toEqual(FRAME)
		expect(existsSync(destination.temporary)).toBeFalse()

		const committed = faults.entries.findLast((entry) => entry.operation === 'sync' && entry.paths[0].endsWith('journal.jsonl'))!
		const removed = faults.entries.find((entry) => entry.operation === 'unlink' && entry.paths[0] === destination.temporary)!
		expect(removed.sequence).toBeGreaterThan(committed.sequence)
		await recovered.release()
	})

	test('promoting by copy, only the temporary: the copy is repeated', async () => {
		const storage = await lockedStorage({}, true)
		const next = acceptance(storage.sessionId)
		const destination = await captureInto(storage, SLOT)

		{
			using _ = injectFileSystemFaults(onPath('copyFile', destination.temporary))
			expect((await storage.promote(next, false)).ok).toBeFalse()
		}

		await storage.release()
		expect(existsSync(destination.final)).toBeFalse()
		const { storage: recovered, recovery, saved } = await recoverIn(storage, inProgress(storage.sessionId), true)
		expect(recovery.ok).toBeTrue()
		expect(saved).toEqual([next])
		expect(readFileSync(destination.final)).toEqual(FRAME)
		await recovered.release()
	})

	test('6: promoting by copy, final differs and temporary missing or differing: storage failure, nothing removed', async () => {
		for (const temporaryState of ['missing', 'differing'] as const) {
			const storage = await lockedStorage({}, true)
			const destination = await captureInto(storage, SLOT)

			{
				using _ = injectFileSystemFaults(onPath('copyFile', destination.temporary, { partialCopyBytes: 10 }))
				expect((await storage.promote(acceptance(storage.sessionId), false)).ok).toBeFalse()
			}

			await storage.release()
			if (temporaryState === 'missing') await rm(destination.temporary)
			else writeFileSync(destination.temporary, OTHER_FRAME)

			const { storage: recovered, recovery, saved } = await recoverIn(storage, inProgress(storage.sessionId), true)
			expect(recovery).toMatchObject({ ok: false, failure: { kind: 'storage', detail: expect.stringContaining('both differ') } })
			expect(saved).toEqual([])
			expect(readFileSync(destination.final)).toHaveLength(10)
			expect(existsSync(destination.temporary)).toBe(temporaryState === 'differing')
			await recovered.release()
		}
	})

	test('17: disposing: the disposition is redone, disposed, and the discard transaction reapplied (budget and retake kept)', async () => {
		for (const fault of ['disposed line', 'move'] as const) {
			const storage = await lockedStorage()
			const next = retake(storage.sessionId)
			const destination = await captureInto(storage, SLOT)
			const rejected = join(storage.directory!, 'rejected', 'L', 'frame[L][1].1.fit')

			{
				using _ = injectFileSystemFaults(fault === 'move' ? onPath('link', rejected) : journalWrite(2))
				expect((await storage.dispose('moveToRejected', next)).ok).toBeFalse()
			}

			await storage.release()
			const { storage: recovered, recovery, saved } = await recoverIn(storage, inProgress(storage.sessionId))
			expect(recovery).toEqual({ ok: true, value: { checkpoint: next, warnings: [] } })
			expect(saved).toEqual([next])
			expect(saved[0]).toMatchObject({ currentSlot: { attempt: 2, discardedTotal: 1, discardBudgetUsed: 1, captureFailures: 0 }, consecutiveDiscards: 1 })
			expect(readFileSync(rejected)).toEqual(FRAME)
			expect(existsSync(destination.temporary)).toBeFalse()
			expect(kindsOf(await journalOf(recovered))).toEqual(['prepared', 'disposing', 'disposed'])
			await recovered.release()
		}
	})

	test('21: prepared with its temporary: the attempt is incomplete, moved aside and counted once as a capture failure', async () => {
		const storage = await lockedStorage()
		const destination = await captureInto(storage, SLOT, FRAME.subarray(0, 12))
		await storage.release()

		// The first recovery dies before its abandoned line; the repetition counts nothing more.
		const persisted = inProgress(storage.sessionId)
		const first = reopen(storage)
		await first.lock()
		const saved: SequencerCheckpoint[] = []

		{
			using _ = injectFileSystemFaults(journalWrite(1))
			expect((await first.recover(persisted, (checkpoint) => Promise.resolve(void saved.push(checkpoint)))).ok).toBeFalse()
		}

		await first.release()
		expect(saved).toMatchObject([{ sequence: 2, currentSlot: { id: 'frame[L][1]', attempt: 2, captureFailures: 1 } }])
		expect(existsSync(destination.temporary)).toBeFalse()

		const { storage: recovered, recovery, saved: repeated } = await recoverIn(storage, saved[0])
		expect(recovery).toEqual({ ok: true, value: { checkpoint: saved[0], warnings: [] } })
		expect(repeated).toEqual([])
		expect(readFileSync(join(recovered.directory!, 'rejected', 'incomplete', 'L', '.frame[L][1].1.partial.fit'))).toEqual(FRAME.subarray(0, 12))
		expect(await journalOf(recovered)).toMatchObject([{ kind: 'prepared' }, { kind: 'abandoned', slot: 'frame[L][1]', attempt: 1, reason: 'crash' }])
		await recovered.release()
	})

	test('prepared without a temporary: counted once as a capture failure', async () => {
		const storage = await lockedStorage()
		await storage.prepare(SLOT)
		await storage.release()

		const { storage: recovered, recovery, saved } = await recoverIn(storage, inProgress(storage.sessionId))
		expect(saved).toMatchObject([{ sequence: 2, currentSlot: { attempt: 2, captureFailures: 1 } }])
		expect(recovery).toEqual({ ok: true, value: { checkpoint: saved[0], warnings: [] } })
		expect(kindsOf(await journalOf(recovered))).toEqual(['prepared', 'abandoned'])
		await recovered.release()
	})

	test('deferred without a temporary: nothing is counted and the same attempt is prepared again', async () => {
		const storage = await lockedStorage()
		await storage.prepare(SLOT)
		await storage.defer('meridian')
		await storage.release()

		const persisted = inProgress(storage.sessionId)
		const { storage: recovered, recovery, saved } = await recoverIn(storage, persisted)
		expect(recovery).toEqual({ ok: true, value: { checkpoint: persisted, warnings: [] } })
		expect(saved).toEqual([])
		expect((await recovered.prepare(SLOT)).ok).toBeTrue()
		expect(kindsOf(await journalOf(recovered))).toEqual(['prepared', 'deferred', 'prepared'])
		await recovered.release()
	})

	test('28: deferred with a temporary: an inconsistency moved aside with a warning, never counted', async () => {
		const storage = await lockedStorage()
		const destination = (await storage.prepare(SLOT)) as { readonly value: { readonly temporary: string } }
		await storage.defer('pause')
		writeFileSync(destination.value.temporary, FRAME)
		await storage.release()

		const persisted = inProgress(storage.sessionId)
		const { storage: recovered, recovery, saved } = await recoverIn(storage, persisted)
		expect(recovery).toMatchObject({ ok: true, value: { checkpoint: persisted, warnings: [expect.stringContaining('was deferred but its temporary existed')] } })
		expect(saved).toEqual([])
		expect(existsSync(join(recovered.directory!, 'rejected', 'incomplete', 'L', '.frame[L][1].1.partial.fit'))).toBeTrue()
		await recovered.release()
	})

	test('37: a frame file without any journal line is left untouched with a warning, even one named like a temporary', async () => {
		const storage = await lockedStorage()
		await mkdir(join(storage.directory!, 'L'))
		writeFileSync(join(storage.directory!, 'L', 'frame[L][7].fit'), FRAME)
		writeFileSync(join(storage.directory!, 'L', '.frame[L][9].1.partial.fit'), FRAME)
		await storage.release()

		const { storage: recovered, recovery, saved } = await recoverIn(storage, undefined)
		expect(recovery).toMatchObject({ ok: true, value: { warnings: expect.arrayContaining([expect.stringContaining('L/frame[L][7].fit'), expect.stringContaining('L/.frame[L][9].1.partial.fit')]) } })
		expect(saved).toEqual([])
		expect(filesOf(recovered.directory!)).toEqual(['L/.frame[L][9].1.partial.fit', 'L/frame[L][7].fit', 'journal.jsonl', 'session.lock'])
		await recovered.release()
	})

	test('auxiliary frames are outside the journal: never reported; delete clears the leftovers of a previous process once, keep keeps them', async () => {
		const storage = await lockedStorage()
		expect(await storage.auxiliaryDirectory('centering', 'keep')).toEqual({ ok: true, value: join(storage.directory!, 'auxiliary', 'centering') })
		writeFileSync(join(storage.directory!, 'auxiliary', 'centering', 'a.1.fit'), FRAME)
		await storage.release()
		expect(await storage.auxiliaryDirectory('centering', 'delete')).toMatchObject({ ok: false, failure: { kind: 'storage' } })

		const { storage: recovered, recovery } = await recoverIn(storage, undefined)
		expect(recovery).toMatchObject({ ok: true, value: { warnings: [] } })
		expect(await recovered.auxiliaryDirectory('centering', 'keep')).toMatchObject({ ok: true })
		expect(filesOf(recovered.directory!)).toContain('auxiliary/centering/a.1.fit')

		const directory = join(recovered.directory!, 'auxiliary', 'centering')
		expect(await recovered.auxiliaryDirectory('centering', 'delete')).toEqual({ ok: true, value: directory })
		expect(readdirSync(directory)).toEqual([])
		// Cleared once per lock: a frame of this process survives the next call.
		writeFileSync(join(directory, 'b.1.fit'), FRAME)
		expect(await recovered.auxiliaryDirectory('centering', 'delete')).toMatchObject({ ok: true })
		expect(readdirSync(directory)).toEqual(['b.1.fit'])
		expect(kindsOf(await readSequencerJournal(join(recovered.directory!, 'journal.jsonl')))).toEqual([])
		await recovered.release()
	})

	test('committed with its final missing or differing: storage failure, never captured again over it', async () => {
		for (const finalState of ['missing', 'differing'] as const) {
			const storage = await lockedStorage()
			const destination = await captureInto(storage, SLOT)
			await storage.promote(acceptance(storage.sessionId), false)
			await storage.release()
			if (finalState === 'missing') await rm(destination.final)
			else writeFileSync(destination.final, FRAME.subarray(0, 5))

			const { storage: recovered, recovery, saved } = await recoverIn(storage, inProgress(storage.sessionId))
			expect(recovery).toMatchObject({ ok: false, failure: { kind: 'storage', detail: expect.stringContaining('missing or differs') } })
			expect(saved).toEqual([])
			await recovered.release()
		}
	})

	test('4: a truncated last line is ignored (a truncated promoting is as if it never existed); a malformed line before it fails', async () => {
		const storage = await lockedStorage()
		await captureInto(storage, SLOT)
		const journal = join(storage.directory!, 'journal.jsonl')
		await writeFile(journal, `${readFileSync(journal, 'utf-8')}{"kind":"promoting","slot":"frame[L][1]"`)
		await storage.release()

		const { storage: recovered, recovery, saved } = await recoverIn(storage, inProgress(storage.sessionId))
		expect(recovery.ok).toBeTrue()
		expect(saved).toMatchObject([{ currentSlot: { attempt: 2, captureFailures: 1 } }])
		await recovered.release()

		await writeFile(journal, `not json\n${readFileSync(journal, 'utf-8')}`)
		const { storage: broken, recovery: failed } = await recoverIn(storage, inProgress(storage.sessionId))
		expect(failed).toMatchObject({ ok: false, failure: { kind: 'storage', detail: expect.stringContaining('line 1') } })
		await broken.release()
	})

	test('a journal path escaping the session directory is refused before anything is touched', async () => {
		const storage = await lockedStorage()
		const victim = join(ROOT, `victim-${storage.sessionId}.fit`)
		writeFileSync(victim, FRAME)
		await writeFile(join(storage.directory!, 'journal.jsonl'), `${JSON.stringify({ kind: 'prepared', slot: 'frame[L][1]', attempt: 1, temporary: `../${basename(victim)}`, final: 'L/frame[L][1].fit', at: 0 })}\n`)
		await storage.release()

		const { storage: recovered, recovery } = await recoverIn(storage, inProgress(storage.sessionId))
		expect(recovery).toMatchObject({ ok: false, failure: { kind: 'storage' } })
		expect(readFileSync(victim)).toEqual(FRAME)
		await recovered.release()
	})
})

describe('checkpoint store', () => {
	test('saves and loads; refuses a sequence not above the persisted one; ignores a leftover temporary; rejects a malformed file', async () => {
		const store = new FileSystemSequencerCheckpointStore(ROOT)
		const sessionId = Bun.randomUUIDv7()
		expect(await store.load(sessionId)).toBeUndefined()

		const second = acceptance(sessionId, 2)
		await store.save(second)
		expect(await store.load(sessionId)).toEqual(second)

		expect(store.save(inProgress(sessionId, 2))).rejects.toThrow('not newer')
		expect(store.save(inProgress(sessionId, 1))).rejects.toThrow('not newer')
		expect(await store.load(sessionId)).toEqual(second)

		writeFileSync(join(ROOT, sessionId, 'checkpoint.json.tmp'), '{"version":')
		expect(await store.load(sessionId)).toEqual(second)
		const third = inProgress(sessionId, 3)
		await store.save(third)
		expect(await store.load(sessionId)).toEqual(third)

		writeFileSync(join(ROOT, sessionId, 'checkpoint.json'), JSON.stringify({ ...third, intents: { autofocus: 'yes' } }))
		expect(store.load(sessionId)).rejects.toThrow('malformed')
		await store.remove(sessionId)
		expect(await store.load(sessionId)).toBeUndefined()
	})

	test('a crash at any durable step of a save keeps the previous checkpoint', async () => {
		const store = new FileSystemSequencerCheckpointStore(ROOT)
		const sessionId = Bun.randomUUIDv7()
		const first = inProgress(sessionId, 1)
		await store.save(first)

		for (let step = 1; step <= 3; step++) {
			{
				using faults = injectFileSystemFaults({ failAt: step, mode: 'crash' })
				expect(store.save(acceptance(sessionId, 2))).rejects.toThrow('injected')
				await waitUntil(() => faults.entries.some((entry) => entry.failed), 1000, 1)
			}

			expect(await store.load(sessionId)).toEqual(first)
		}
	})
})

const CAMERA: Camera = { ...DEFAULT_CAMERA, id: 'Camera', name: 'Camera', hardwareId: 'Camera', connected: true }

const OK: SequencerTaskResult = { ok: true }
const ABORTED: SequencerTaskResult = { ok: false, failure: { kind: 'operation', reason: 'aborted' } }

// Capture of one attempt, given its storage.
type CaptureBehaviour = (context: SequencerCaptureContext, storage: FileSystemSequencerStorage) => Promise<OperationResult<SequencerCapturedFrame>>

// Successful capture: the frame is written durably to the temporary of the destination.
const writeFrame: CaptureBehaviour = async (context, storage) => {
	await storage.writeDurably(context.destination.temporary, FRAME)
	const at = context.clock.wallNow()
	const monotonic = context.clock.monotonicNow()
	return successfulOperationResult({ exposureDispatchedAt: at, exposureDispatchedMonotonic: monotonic, exposureStartedAt: at, exposureStartedMonotonic: monotonic, exposureFinishedAt: at, exposureFinishedMonotonic: monotonic })
}

// Capture that never ends by itself: it writes part of the frame, then waits for its root to abort.
const inFlight: CaptureBehaviour = async (context) => {
	writeFileSync(context.destination.temporary, FRAME.subarray(0, 12))
	const { promise, resolve } = Promise.withResolvers<OperationResult<SequencerCapturedFrame>>()
	context.signal.addEventListener('abort', () => resolve(failedOperationResult('aborted')), { once: true })
	return await promise
}

// One process of a session: the runner with its own storage, store, coordinator and listener.
interface SessionProcess {
	readonly runner: SequencerRunner
	readonly storage: FileSystemSequencerStorage
	readonly clock: ManualClock
	readonly events: SequencerEvent[]
	// Slot attempts handed to the capture, `{slot}#{attempt}`.
	readonly captures: string[]
	readonly result: Promise<SequencerResult>
	done: boolean
}

interface SessionProcessOptions {
	readonly configuration?: SequencerConfiguration
	readonly capture?: CaptureBehaviour
	// Pre-capture tasks after the frame destination.
	readonly afterPrepare?: readonly SequencerTask[]
	readonly shutdown?: SequencerShutdownTask[]
	readonly store?: SequencerCheckpointStore
	readonly clock?: ManualClock
	// Sees every event after it was recorded.
	readonly onEvent?: (event: SequencerEvent) => void
}

// Starts the next process of the session `sessionId`; the checkpoints live in ROOT unless another store is given.
function startProcess(sessionId: string, options: SessionProcessOptions = {}): SessionProcess {
	const clock = options.clock ?? new ManualClock()
	const storage = new FileSystemSequencerStorage({ root: ROOT, sessionId, wallNow: clock.wallNow })
	const events: SequencerEvent[] = []
	const captures: string[] = []
	const capture = options.capture ?? writeFrame
	const services = {
		coordinator: new OperationCoordinator(new ResourceArbiter()),
		storage,
		checkpointStore: options.store ?? new FileSystemSequencerCheckpointStore(ROOT),
		clock,
		listener: (event: SequencerEvent) => {
			events.push(event)
			options.onEvent?.(event)
		},
	}
	const phases = {
		startup: [],
		preCapture: [prepareFrameDestinationTask(storage), ...(options.afterPrepare ?? [])],
		// The capture asks `beforeExposure` first, as the capturer does right before dispatching.
		capture: (context: SequencerCaptureContext) => {
			captures.push(`${context.frame!.id}#${context.frame!.attempt}`)
			const refusal = context.beforeExposure()
			if (refusal !== undefined) return Promise.resolve(refusal)
			context.exposureStarted()
			return capture(context, storage)
		},
		shutdown: options.shutdown ?? [],
	}
	const runner = startSequencerRunner({ configuration: options.configuration ?? configurationOf(), devices: { camera: CAMERA }, services, phases })
	const process: SessionProcess = { runner, storage, clock, events, captures, result: runner.handle.result, done: false }
	void process.result.then(() => (process.done = true))
	return process
}

// Plays the death of a process: from now on every durable operation fails but the lock (so this process can play the
// next one), the runner is disposed and its end awaited.
async function crash(process: SessionProcess) {
	using _ = injectFileSystemFaults({ failAt: 1, mode: 'crash', spare: isLockPath })
	const { warn } = console
	console.warn = () => {}

	try {
		process.runner.dispose()
		await process.result
	} finally {
		console.warn = warn
	}
}

// Pre-capture task that holds until released (ok) or until its root aborts.
class Gate {
	readonly entered: SequencerContext[] = []
	#release?: VoidFunction

	readonly task: SequencerTask = {
		id: 'finalExposureGuard',
		shouldRun: () => true,
		run: (context) =>
			new Promise<SequencerTaskResult>((resolve) => {
				this.entered.push(context)
				this.#release = () => resolve(OK)
				context.signal.addEventListener('abort', () => resolve(ABORTED), { once: true })
			}),
	}

	release() {
		this.#release?.()
	}

	async waitEntered(count: number = 1) {
		await waitUntil(() => this.entered.length >= count, 2000, 1)
	}
}

async function checkpointOfSession(sessionId: string) {
	return await new FileSystemSequencerCheckpointStore(ROOT).load(sessionId)
}

async function journalOfSession(sessionId: string) {
	return await readSequencerJournal(join(ROOT, sessionId, 'journal.jsonl'))
}

// Store that fails the saves whose sequence `fails` selects.
function failingStore(fails: (sequence: number) => boolean): SequencerCheckpointStore {
	const store = new FileSystemSequencerCheckpointStore(ROOT)
	return { load: store.load, save: (checkpoint) => (fails(checkpoint.sequence) ? Promise.reject(new Error('disk full')) : store.save(checkpoint)) }
}

function eventIndex(events: readonly SequencerEvent[], predicate: (event: SequencerEvent) => boolean) {
	const index = events.findIndex(predicate)
	return index < 0 ? Infinity : index
}

const RETRY_ONCE_PER_SECOND = { maxAttempts: 3, delay: 1, backoff: 1, maximumDelay: 1, retryOn: ['timeout' as const] }

describe('session persistence', () => {
	test('4: a checkpoint of another configuration id or revision refuses the resume before anything is reserved', async () => {
		const sessionId = Bun.randomUUIDv7()
		expect((await startProcess(sessionId, { configuration: configurationOf([scheduled('L', 2)]) }).result).state).toBe('completed')

		for (const configuration of [
			{ ...configurationOf([scheduled('L', 2)]), revision: 2 },
			{ ...configurationOf([scheduled('L', 2)]), id: 'other' },
		]) {
			const refused = startProcess(sessionId, { configuration })
			expect(await refused.result).toMatchObject({ state: 'failed', failure: { kind: 'configuration', detail: expect.stringContaining('cannot resume') } })
			expect(refused.events.some((event) => event.type === 'sessionStarted')).toBeFalse()
			expect(refused.captures).toEqual([])
			expect(existsSync(join(ROOT, sessionId, 'session.lock'))).toBeFalse()
		}
	})

	test('4: the persisted scheduler resumes the exact slot a continuous run would select', async () => {
		const configuration = configurationOf([scheduled('A', 2), scheduled('B', 2)], { order: 'roundRobin' })
		const sessionId = Bun.randomUUIDv7()
		const first = startProcess(sessionId, { configuration })
		await waitUntil(() => first.events.some((event) => event.type === 'frameAccepted'), 2000, 1)
		expect(await first.runner.handle.stop()).toMatchObject({ state: 'stopped' })

		const second = startProcess(sessionId, { configuration })
		expect((await second.result).state).toBe('completed')
		expect([...first.captures, ...second.captures]).toEqual(['frame[A][1]#1', 'frame[B][1]#1', 'frame[A][2]#1', 'frame[B][2]#1'])
		assertJournalInvariants(await journalOfSession(sessionId), [...first.events, ...second.events])
	})

	test('4: a committed frame whose checkpoint fails blocks new exposures; the next process reapplies it and continues', async () => {
		const configuration = configurationOf([scheduled('L', 2)])
		const sessionId = Bun.randomUUIDv7()
		const silenced = silenceConsoleError()
		// Sequence 1 is the selection of frame[L][1]; 2 its transaction.
		const first = startProcess(sessionId, { configuration, store: failingStore((sequence) => sequence === 2) })
		expect(await first.result).toMatchObject({ state: 'failed', failure: { kind: 'storage', detail: expect.stringContaining('checkpoint 2') } })
		silenced.restore()
		expect(first.captures).toEqual(['frame[L][1]#1'])
		expect(kindsOf(await journalOfSession(sessionId))).toEqual(['prepared', 'promoting', 'committed'])

		const second = startProcess(sessionId, { configuration })
		const result = await second.result
		expect(result.state).toBe('completed')
		expect(result.capture.groups[0]).toMatchObject({ accepted: 2 })
		expect(second.captures).toEqual(['frame[L][2]#1'])
		expect(await checkpointOfSession(sessionId)).toMatchObject({ capture: { L: { accepted: 2 } }, anchors: { lightExposures: 2 } })
	})

	test('4: intents survive a restart, physical state does not', async () => {
		const sessionId = Bun.randomUUIDv7()
		const configuration = configurationOf([scheduled('L', 2)])
		const marker: SequencerTask = {
			id: 'acquireOrRecenterTarget',
			shouldRun: () => true,
			run: (context) => {
				context.state.intents.recenter = true
				context.state.targetAcquired = true
				return Promise.resolve(OK)
			},
		}

		const gate = new Gate()
		const first = startProcess(sessionId, { configuration, afterPrepare: [marker, gate.task] })
		await gate.waitEntered()
		gate.release()
		await waitUntil(() => first.events.some((event) => event.type === 'frameAccepted'), 2000, 1)
		await gate.waitEntered(2)
		await crash(first)

		const seen: { recenter?: boolean; targetAcquired?: boolean } = {}
		const probe: SequencerTask = {
			id: 'acquireOrRecenterTarget',
			shouldRun: () => true,
			run: (context) => {
				seen.recenter = context.state.intents.recenter
				seen.targetAcquired = context.state.targetAcquired
				return Promise.resolve(OK)
			},
		}

		const second = startProcess(sessionId, { configuration, afterPrepare: [probe] })
		expect((await second.result).state).toBe('completed')
		expect(seen).toEqual({ recenter: true, targetAcquired: false })
	})

	test('19, 20: a camera that always fails is captured exactly maxAttempts times although every process dies after each failure', async () => {
		const configuration = configurationOf([scheduled('L', 1)], { retry: RETRY_ONCE_PER_SECOND })
		const sessionId = Bun.randomUUIDv7()
		const captures: string[] = []
		let process: SessionProcess

		for (let n = 1; ; n++) {
			if (n > 5) throw new Error('the session never applied its capture policy')
			process = startProcess(sessionId, { configuration, capture: () => Promise.resolve(failedOperationResult('timeout')) })
			await waitUntil(() => process.done || process.clock.pending > 0, 2000, 1)
			captures.push(...process.captures)
			if (process.done) break

			// 20: the failure is durable before the pre-capture of the retry.
			const { events } = process
			const failed = eventIndex(events, (event) => event.type === 'taskFailed' && event.task === 'captureFrame')
			expect(eventIndex(events, (event) => event.type === 'checkpointSaved' && events.indexOf(event) > failed)).toBeLessThan(Infinity)
			expect(await checkpointOfSession(sessionId)).toMatchObject({ currentSlot: { attempt: n + 1, captureFailures: n } })
			await crash(process)
		}

		expect(captures).toEqual(['frame[L][1]#1', 'frame[L][1]#2', 'frame[L][1]#3'])
		expect(await process.result).toMatchObject({ state: 'failed', failure: { kind: 'operation', reason: 'timeout', task: 'captureFrame' } })
		expect(kindsOf(await journalOfSession(sessionId))).toEqual(['prepared', 'abandoned', 'prepared', 'abandoned', 'prepared', 'abandoned'])
	})

	test('20: a crash between the failure and its checkpoint is recovered from the open prepared line', async () => {
		const configuration = configurationOf([scheduled('L', 1)], { retry: RETRY_ONCE_PER_SECOND })
		const sessionId = Bun.randomUUIDv7()
		// Sequence 1 is the selection of frame[L][1]; 2 would persist its failure.
		const first = startProcess(sessionId, { configuration, store: failingStore((sequence) => sequence === 2), capture: () => Promise.resolve(failedOperationResult('timeout')) })
		expect(await first.result).toMatchObject({ state: 'failed', failure: { kind: 'storage' } })
		expect(kindsOf(await journalOfSession(sessionId))).toEqual(['prepared'])

		const second = startProcess(sessionId, { configuration })
		expect((await second.result).state).toBe('completed')
		expect(second.captures).toEqual(['frame[L][1]#2'])
		expect(await journalOfSession(sessionId)).toMatchObject([{ kind: 'prepared' }, { kind: 'abandoned', attempt: 1, reason: 'crash' }, { kind: 'prepared', attempt: 2 }, { kind: 'promoting' }, { kind: 'committed' }])
	})

	test('21: a crash with the exposure in flight counts one failure, moves the partial aside, and N crashes end in the policy', async () => {
		const configuration = configurationOf([scheduled('L', 1)], { retry: { ...RETRY_ONCE_PER_SECOND, maxAttempts: 2 }, onFailure: 'skipFrame' })
		const sessionId = Bun.randomUUIDv7()

		for (let n = 1; n <= 2; n++) {
			const process = startProcess(sessionId, { configuration, capture: inFlight })
			await waitUntil(() => process.captures.length > 0, 2000, 1)
			expect(process.captures).toEqual([`frame[L][1]#${n}`])
			await crash(process)
		}

		const last = startProcess(sessionId, { configuration })
		const result = await last.result
		expect(last.captures).toEqual([])
		expect(result).toMatchObject({ state: 'completed', capture: { groups: [{ groupId: 'L', skipped: 1, accepted: 0 }] } })
		expect(last.events.find((event) => event.type === 'slotSkipped')).toMatchObject({ slot: 'frame[L][1]', reason: 'captureFailures' })

		const journal = await journalOfSession(sessionId)
		expect(journal.filter((entry) => entry.kind === 'abandoned')).toMatchObject([
			{ attempt: 1, reason: 'crash' },
			{ attempt: 2, reason: 'crash' },
		])
		expect(filesOf(join(ROOT, sessionId)).filter((path) => path.endsWith('.partial.fit'))).toEqual(['rejected/incomplete/L/.frame[L][1].1.partial.fit', 'rejected/incomplete/L/.frame[L][1].2.partial.fit'])
	})

	test('23, 24: a protection after the preparation writes deferred before waiting; a crash an hour later counts nothing', async () => {
		const sessionId = Bun.randomUUIDv7()
		const gate = new Gate()
		const first = startProcess(sessionId, { afterPrepare: [gate.task] })
		await gate.waitEntered()

		let journalAtWait: SequencerJournalEntry[] = []
		const wait: SequencerTask = {
			id: 'meridianFlip',
			shouldRun: () => true,
			run: async (context) => {
				journalAtWait = await journalOfSession(sessionId)
				return (await context.clock.delay(3600000, context.signal)).ok ? OK : ABORTED
			},
		}

		expect(first.runner.requestProtection(wait)).toBeTrue()
		await waitUntil(() => first.clock.pending > 0, 2000, 1)
		expect(journalAtWait.at(-1)).toMatchObject({ kind: 'deferred', slot: 'frame[L][1]', attempt: 1, reason: 'meridian' })
		expect(existsSync(sequencerFrameDestination(join(ROOT, sessionId), 'L', 'frame[L][1]', 1).temporary)).toBeFalse()
		expect(await checkpointOfSession(sessionId)).toMatchObject({ currentSlot: { attempt: 1, captureFailures: 0 } })

		await first.clock.advance(3599000)
		await crash(first)

		const second = startProcess(sessionId)
		expect((await second.result).state).toBe('completed')
		expect(second.captures).toEqual(['frame[L][1]#1'])
		expect(kindsOf(await journalOfSession(sessionId))).toEqual(['prepared', 'deferred', 'prepared', 'promoting', 'committed'])
	})

	test('24 (incorrect variant): without its deferred line the same wait counts one failure after the crash', async () => {
		const sessionId = Bun.randomUUIDv7()
		const gate = new Gate()
		const first = startProcess(sessionId, { afterPrepare: [gate.task] })
		await gate.waitEntered()

		{
			// The journal dies with the deferred line: nothing closes the attempt afterwards.
			using _ = injectFileSystemFaults({ ...journalWrite(1), mode: 'crash' })
			expect(first.runner.requestProtection({ id: 'meridianFlip', shouldRun: () => true, run: () => Promise.resolve(OK) })).toBeTrue()
			expect(await first.result).toMatchObject({ state: 'failed', failure: { kind: 'storage' } })
		}

		const second = startProcess(sessionId)
		expect((await second.result).state).toBe('completed')
		expect(second.captures).toEqual(['frame[L][1]#2'])
	})

	test('26: a crash between the preparation and the guard decision counts exactly one failure', async () => {
		const sessionId = Bun.randomUUIDv7()
		const gate = new Gate()
		const first = startProcess(sessionId, { afterPrepare: [gate.task] })
		await gate.waitEntered()
		await crash(first)

		const second = startProcess(sessionId)
		expect((await second.result).state).toBe('completed')
		expect(second.captures).toEqual(['frame[L][1]#2'])
		expect((await journalOfSession(sessionId)).filter((entry) => entry.kind === 'abandoned')).toMatchObject([{ attempt: 1, reason: 'crash' }])
	})

	test('27: ten prepared → deferred cycles with a crash each keep the slot at its first attempt without failures', async () => {
		const configuration = configurationOf([scheduled('L', 1)], { retry: { ...RETRY_ONCE_PER_SECOND, maxAttempts: 2 } })
		const sessionId = Bun.randomUUIDv7()

		for (let n = 1; n <= 10; n++) {
			const gate = new Gate()
			const process = startProcess(sessionId, { configuration, afterPrepare: [gate.task] })
			await gate.waitEntered()
			const paused = process.runner.handle.pause()
			gate.release()
			expect(await paused).toBe('paused')
			await crash(process)
		}

		expect(await checkpointOfSession(sessionId)).toMatchObject({ currentSlot: { id: 'frame[L][1]', attempt: 1, captureFailures: 0 } })
		const journal = await journalOfSession(sessionId)
		expect(journal).toHaveLength(20)
		expect(journal.every((entry, i) => entry.kind === (i % 2 === 0 ? 'prepared' : 'deferred') && entry.attempt === 1)).toBeTrue()

		const last = startProcess(sessionId, { configuration })
		expect((await last.result).state).toBe('completed')
		expect(last.captures).toEqual(['frame[L][1]#1'])
	})

	test('28: a deferred line that cannot be written fails with storage and consumes no capture attempt', async () => {
		const sessionId = Bun.randomUUIDv7()
		const gate = new Gate()
		const process = startProcess(sessionId, { afterPrepare: [gate.task] })
		await gate.waitEntered()

		using _ = injectFileSystemFaults(journalWrite(1))
		void process.runner.handle.pause()
		gate.release()
		expect(await process.result).toMatchObject({ state: 'failed', failure: { kind: 'storage', detail: expect.stringContaining('defer') } })
		expect(process.captures).toEqual([])
		expect(await checkpointOfSession(sessionId)).toMatchObject({ currentSlot: { attempt: 1, captureFailures: 0 } })
	})

	test('29: a stop between the preparation and the dispatch writes deferred before the shutdown; the resume prepares the same attempt', async () => {
		const sessionId = Bun.randomUUIDv7()
		const gate = new Gate()
		let journalAtShutdown: SequencerJournalEntry[] = []
		const shutdown: SequencerShutdownTask = {
			id: 'warmCamera',
			policy: 'required',
			shouldRun: () => true,
			run: async () => {
				journalAtShutdown = await journalOfSession(sessionId)
				return OK
			},
		}

		const first = startProcess(sessionId, { afterPrepare: [gate.task], shutdown: [shutdown] })
		await gate.waitEntered()
		expect(await first.runner.handle.stop()).toMatchObject({ state: 'stopped' })
		expect(journalAtShutdown.at(-1)).toMatchObject({ kind: 'deferred', attempt: 1, reason: 'stop' })

		const second = startProcess(sessionId)
		expect((await second.result).state).toBe('completed')
		expect(second.captures).toEqual(['frame[L][1]#1'])
		expect((await journalOfSession(sessionId)).some((entry) => entry.kind === 'abandoned')).toBeFalse()
	})

	test('7, 34.2: a pending capture pause is reapplied by a restart before any exposure; only resume() renews it, durably', async () => {
		const configuration = configurationOf([scheduled('L', 1)], { retry: { ...RETRY_ONCE_PER_SECOND, maxAttempts: 1 }, onFailure: 'pause' })
		const sessionId = Bun.randomUUIDv7()
		const first = startProcess(sessionId, { configuration, capture: () => Promise.resolve(failedOperationResult('timeout')) })
		await waitUntil(() => first.runner.snapshot().state === 'paused', 2000, 1)
		expect(await checkpointOfSession(sessionId)).toMatchObject({ currentSlot: { attempt: 2, captureFailures: 1 } })
		await crash(first)

		// The restart is not a resume: it holds before exposing anything.
		let failuresAtCapture: number | undefined
		const second = startProcess(sessionId, {
			configuration,
			capture: async (context, storage) => {
				failuresAtCapture = (await checkpointOfSession(sessionId))?.currentSlot?.captureFailures
				return await writeFrame(context, storage)
			},
		})
		await waitUntil(() => second.runner.snapshot().state === 'paused', 2000, 1)
		expect(second.captures).toEqual([])
		expect(second.runner.snapshot().currentFrame).toMatchObject({ id: 'frame[L][1]', attempt: 2, captureFailures: 1 })

		expect(second.runner.handle.resume()).toBeTrue()
		expect((await second.result).state).toBe('completed')
		expect(second.captures).toEqual(['frame[L][1]#2'])
		// The renewed budget was saved before the exposure.
		expect(failuresAtCapture).toBe(0)
	})

	test('34.2: a started meridian flip is durable before it is commanded; a failed save changes nothing', async () => {
		const sessionId = Bun.randomUUIDv7()
		const gate = new Gate()
		const process = startProcess(sessionId, { afterPrepare: [gate.task] })
		await gate.waitEntered()

		expect(await process.runner.recordMeridianFlipStart()).toEqual({ ok: true })
		expect(await checkpointOfSession(sessionId)).toMatchObject({ meridianFlipAttempts: 1 })

		{
			using _ = injectFileSystemFaults({ failAt: 1, operations: ['rename'] })
			expect(await process.runner.recordMeridianFlipStart()).toMatchObject({ ok: false, failure: { kind: 'storage' } })
		}

		expect(await checkpointOfSession(sessionId)).toMatchObject({ meridianFlipAttempts: 1 })
		gate.release()
		expect((await process.result).state).toBe('completed')
		expect(await checkpointOfSession(sessionId)).toMatchObject({ meridianFlipAttempts: 1 })
	})
})

// Logical part of a checkpoint: everything but its session, order and save instant.
function logicalOf(checkpoint: SequencerCheckpoint | undefined) {
	if (checkpoint === undefined) return undefined
	const { sessionId, sequence, updatedAt, ...logical } = checkpoint
	return logical
}

// Fails the test with a console report silenced while `body` runs.
async function quietly<T>(body: () => Promise<T>) {
	const { error, warn } = console
	console.error = () => {}
	console.warn = () => {}

	try {
		return await body()
	} finally {
		console.error = error
		console.warn = warn
	}
}

describe('journal oracle', () => {
	const next = checkpointOf('s', 2)
	const prepared = (slot: string, attempt: number, final = `L/${slot}.fit`): SequencerJournalEntry => ({ kind: 'prepared', slot, attempt, temporary: `L/.${slot}.${attempt}.partial.fit`, final, at: 0 })
	const promoting = (slot: string, attempt: number, final = `L/${slot}.fit`): SequencerJournalEntry => ({ kind: 'promoting', slot, attempt, temporary: `L/.${slot}.${attempt}.partial.fit`, final, method: 'link', size: 1, forced: false, next, at: 0 })
	const committed = (slot: string, attempt: number, final = `L/${slot}.fit`): SequencerJournalEntry => ({ kind: 'committed', slot, attempt, final, method: 'link', size: 1, sequence: 2, at: 0 })
	const accepted = (slot: string, attempt: number, path: string): SequencerEvent => ({ type: 'frameAccepted', slot, attempt, path, forced: false, sessionId: 's', at: 0 })
	const A = 'frame[L][1]'
	const B = 'frame[L][2]'

	test('accepts a coherent journal: deferred and abandoned attempts, a retake, a crash recovered', () => {
		const journal: SequencerJournalEntry[] = [
			prepared(A, 1),
			{ kind: 'deferred', slot: A, attempt: 1, reason: 'pause', at: 0 },
			prepared(A, 1),
			{ kind: 'abandoned', slot: A, attempt: 1, reason: 'failed', at: 0 },
			prepared(A, 2),
			{ kind: 'abandoned', slot: A, attempt: 2, reason: 'crash', at: 0 },
			prepared(A, 3),
			promoting(A, 3),
			committed(A, 3),
			prepared(B, 1),
			promoting(B, 1),
			committed(B, 1),
		]
		assertJournalInvariants(journal, [accepted(A, 3, join('root', 's', 'L', `${A}.fit`)), accepted(B, 1, `/root/s/L/${B}.fit`)])
	})

	test('I11: a second final of a slot, or one final committed by two slots', () => {
		expect(() => assertJournalInvariants([prepared(A, 1), promoting(A, 1), committed(A, 1), prepared(A, 2), promoting(A, 2), committed(A, 2)])).toThrow(/^I11: second committed final of frame\[L\]\[1\]/)
		expect(() => assertJournalInvariants([prepared(A, 1, 'L/x.fit'), promoting(A, 1, 'L/x.fit'), committed(A, 1, 'L/x.fit'), prepared(B, 1, 'L/x.fit'), promoting(B, 1, 'L/x.fit'), committed(B, 1, 'L/x.fit')])).toThrow(/^I11: L\/x.fit committed twice/)
	})

	test('I36: an attempt prepared while another is open, or deferred after its transaction', () => {
		expect(() => assertJournalInvariants([prepared(A, 1), prepared(B, 1)])).toThrow(/^I36: frame\[L\]\[2\]#1 prepared .* while frame\[L\]\[1\]#1 is open/)
		expect(() => assertJournalInvariants([prepared(A, 1), promoting(A, 1), { kind: 'deferred', slot: A, attempt: 1, reason: 'stop', at: 0 }])).toThrow(/^I36: .* deferred after its transaction/)
	})

	test('I49: a final named like a temporary, a temporary that is not partial, a final that changes', () => {
		expect(() => assertJournalInvariants([prepared(A, 1, 'L/x.partial.fit')])).toThrow(/^I49:/)
		expect(() => assertJournalInvariants([{ ...prepared(A, 1), temporary: 'L/x.fit' } as SequencerJournalEntry])).toThrow(/^I49:/)
		expect(() => assertJournalInvariants([prepared(A, 1), promoting(A, 1, 'L/other.fit')])).toThrow(/^I49: promoting of frame\[L\]\[1\]#1 with final L\/other.fit/)
		expect(() => assertJournalInvariants([prepared(A, 1), { kind: 'disposing', slot: A, attempt: 1, temporary: `L/.${A}.1.partial.fit`, artifact: 'moveToRejected', destination: 'rejected/L/x.partial.fit', next, at: 0 }])).toThrow(/^I49:/)
	})

	test('I20: slots selected or enqueued for a triggered group beyond its maxFrames', () => {
		const dark: SequencerFrameGroup = { kind: 'triggered', id: 'D', enabled: true, capture: { ...LIGHT, frameType: 'DARK' }, trigger: { kind: 'afterFrames', frames: 1 }, batchSize: 2, maxFrames: 2, inherit: 'none', opticalPath: { kind: 'none' } }
		const capture = configurationOf([scheduled('L', 3), dark])
		const selected = (ordinal: number): SequencerEvent => ({ type: 'frameSelected', frame: { id: `frame[D][${ordinal}]`, groupId: 'D', kind: 'triggered', ordinal, attempt: 1, discardedTotal: 0, discardBudgetUsed: 0, captureFailures: 0, frameType: 'DARK' }, sessionId: 's', at: 0 })
		const fired = (slots: number): SequencerEvent => ({ type: 'triggerFired', groupId: 'D', slots, sessionId: 's', at: 0 })

		assertJournalInvariants([], [fired(2), selected(1), selected(1), selected(2)], capture)
		expect(() => assertJournalInvariants([], [selected(1), selected(2), selected(3)], capture)).toThrow(/^I20: frame\[D\]\[3\] beyond the 2 frames of D/)
		expect(() => assertJournalInvariants([], [fired(2), fired(1)], capture)).toThrow(/^I20: 3 slots enqueued for D beyond its 2 frames/)
	})

	test('I4: a frameAccepted without the committed line of its attempt and final', () => {
		expect(() => assertJournalInvariants([prepared(A, 1), promoting(A, 1)], [accepted(A, 1, `/root/L/${A}.fit`)])).toThrow(/^I4:/)
		expect(() => assertJournalInvariants([prepared(A, 1), promoting(A, 1), committed(A, 1)], [accepted(A, 1, '/root/L/other.fit')])).toThrow(/^I4:/)
	})
})

describe.skipIf(isTimeConsumingTestSkipped())('crash matrix', () => {
	// Two groups in round robin, so a restart must also restore the cursor.
	const configuration = configurationOf([scheduled('A', 2), scheduled('B', 1)], { order: 'roundRobin', retry: { maxAttempts: 4, delay: 0, backoff: 1, maximumDelay: 0, retryOn: ['timeout', 'commandFailed'] } })
	const finals = ['A/frame[A][1].fit', 'A/frame[A][2].fit', 'B/frame[B][1].fit']

	for (const links of [true, false]) {
		test(`a process dying at any durable step ${links ? 'with' : 'without'} hard links is completed by the next one exactly like a run without crash`, async () => {
			const volume = links ? {} : { linkError: 'EPERM' }
			const baselineId = Bun.randomUUIDv7()
			let steps: number

			{
				using faults = injectFileSystemFaults({ spare: isLockPath, ...volume })
				expect((await startProcess(baselineId, { configuration }).result).state).toBe('completed')
				steps = faults.steps()
			}

			const baseline = logicalOf(await checkpointOfSession(baselineId))
			expect(baseline).toMatchObject({ capture: { A: { accepted: 2 }, B: { accepted: 1 } } })
			expect(steps).toBeGreaterThan(40)

			for (let k = 1; k <= steps; k++) {
				const sessionId = Bun.randomUUIDv7()

				await quietly(async () => {
					using _ = injectFileSystemFaults({ failAt: k, mode: 'crash', spare: isLockPath, ...volume })
					expect((await startProcess(sessionId, { configuration }).result).state).toBe('failed')
				})

				const resumed = await quietly(async () => {
					using _ = links ? undefined : injectFileSystemFaults(volume)
					const process = startProcess(sessionId, { configuration })
					await process.result
					return process
				})

				const directory = join(ROOT, sessionId)
				const files = filesOf(directory)

				try {
					expect(await resumed.result).toMatchObject({ state: 'completed', capture: { groups: [{ accepted: 2 }, { accepted: 1 }] } })
					expect(logicalOf(await checkpointOfSession(sessionId))).toEqual(baseline)
					expect(files.filter((path) => !path.startsWith('rejected/') && path.endsWith('.fit'))).toEqual(finals)
					for (const final of finals) expect(readFileSync(join(directory, final))).toEqual(FRAME)
					expect(files.filter((path) => path.endsWith('.partial.fit') && !path.startsWith('rejected/incomplete/'))).toEqual([])
					assertJournalInvariants(await journalOfSession(sessionId), resumed.events)
				} catch (error) {
					throw new Error(`crash at step ${k}: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
				}
			}
		}, 120000)
	}
})

describe.skipIf(isTimeConsumingTestSkipped())('properties', () => {
	function pick<T>(random: Random, values: readonly T[]) {
		return values[Math.floor(random() * values.length)]
	}

	test('P7, P8: random capture failures, crashes (exposure in flight included) and resumes never exceed a slot budget nor reset a counter', async () => {
		for (let seed = 1; seed <= 300; seed++) {
			const random = mulberry32(seed)
			const maxAttempts = 1 + Math.floor(random() * 3)
			const onFailure = pick(random, ['pause', 'skipFrame', 'fail', 'stop'] as const)
			const groups = [scheduled('A', 1 + Math.floor(random() * 2)), ...(random() < 0.5 ? [scheduled('B', 1 + Math.floor(random() * 2))] : [])]
			const configuration = configurationOf(groups, { order: 'roundRobin', retry: { maxAttempts, delay: 0, backoff: 1, maximumDelay: 0, retryOn: ['timeout'] }, onFailure })
			const sessionId = Bun.randomUUIDv7()
			// Exposures per slot since its budget was last renewed by a resume, and the last attempt dispatched.
			const exposures = new Map<string, number>()
			const attempts = new Map<string, number>()
			let previous: SequencerCheckpoint | undefined

			try {
				for (let n = 0; ; n++) {
					if (n > 40) throw new Error('the session never ended')

					const plan = random()
					const inFlightAt = plan < 0.2 ? 1 + Math.floor(random() * 3) : 0
					const failAt = plan >= 0.2 && plan < 0.45 ? 1 + Math.floor(random() * 40) : undefined
					let dispatched = 0
					let resumed = false
					let killed = false
					// Wakes the driver: the session ended, held paused, or has its exposure in flight.
					let wake = Promise.withResolvers<void>()
					const poke = () => wake.resolve()

					const capture: CaptureBehaviour = async (context, storage) => {
						const { id, attempt } = context.frame!
						const count = (exposures.get(id) ?? 0) + 1
						exposures.set(id, count)
						// I10 without discards: at most maxAttempts exposures of a slot between two resumes, across processes.
						if (count > maxAttempts) throw new Error(`I10: ${id} exposed ${count} times with a budget of ${maxAttempts}`)
						// Attempts are monotonic: never dispatched twice, never renewed by a restart.
						if (!(attempt > (attempts.get(id) ?? 0))) throw new Error(`${id} dispatched attempt ${attempt} after ${attempts.get(id)}`)
						attempts.set(id, attempt)
						if (++dispatched === inFlightAt) {
							poke()
							return await inFlight(context, storage)
						}
						return random() < 0.35 ? failedOperationResult('timeout') : await writeFrame(context, storage)
					}

					const process = await quietly(async () => {
						using _ = failAt === undefined ? undefined : injectFileSystemFaults({ failAt, mode: 'crash', spare: isLockPath })
						const process = startProcess(sessionId, { configuration, capture, onEvent: (event) => event.type === 'stateChanged' && event.state === 'paused' && poke() })
						void process.result.then(poke)

						while (true) {
							await wake.promise
							wake = Promise.withResolvers()
							if (process.done) return process
							const paused = process.runner.snapshot().state === 'paused'
							if (!paused && !(inFlightAt > 0 && dispatched >= inFlightAt)) continue

							if (paused && random() < 0.6) {
								// A resume renews the capture budget of the held slot.
								const held = process.runner.snapshot().currentFrame?.id
								if (held !== undefined) exposures.set(held, 0)
								resumed = true
								expect(process.runner.handle.resume()).toBeTrue()
								continue
							}

							killed = true
							await crash(process)
							return process
						}
					})

					const result = await process.result
					const checkpoint = await checkpointOfSession(sessionId)
					const slot = checkpoint?.currentSlot
					const before = previous?.currentSlot

					// A restart never reduces a persisted counter of the slot in progress; only a resume renews its failures.
					if (slot !== undefined && before !== undefined && slot.id === before.id) {
						expect(slot.attempt).toBeGreaterThanOrEqual(before.attempt)
						if (!resumed) expect(slot.captureFailures).toBeGreaterThanOrEqual(before.captureFailures)
					}

					// P8: failures never exceed the commanded exposures plus the crashes that left an attempt open.
					if (slot !== undefined) {
						const crashes = (await journalOfSession(sessionId)).filter((entry) => entry.kind === 'abandoned' && entry.reason === 'crash' && entry.slot === slot.id).length
						expect(slot.captureFailures).toBeLessThanOrEqual((exposures.get(slot.id) ?? 0) + crashes)
					}

					previous = checkpoint
					// A process that died (killed, or failing on the injected crash) is followed by the next one.
					if (!killed && !(failAt !== undefined && result.failure?.kind === 'storage')) break
				}

				assertJournalInvariants(await journalOfSession(sessionId))
			} catch (error) {
				throw new Error(`seed ${seed}: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
			}
		}
	}, 300000)
})
