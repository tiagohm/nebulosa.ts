import { mkdir, open, readdir, rename, rm, unlink, type FileHandle } from 'fs/promises'
import { basename, dirname, join } from 'path'
import { BREAK_LINE_PATTERN } from '../../src/core/patterns'
import type { ReviewMode, ReviewResult, SessionArtifacts } from './provider'

export type ReviewOutcome = 'ok' | 'error' | 'incomplete' | 'interrupted'
type StateList = 'COMPLETED' | 'FAILED' | 'SKIPPED'

// Reviews are provider-specific; fixes share progress and artifacts across providers.
export class ReviewStateStore {
	readonly directory: string
	readonly lockPath: string
	private readonly owner = Bun.randomUUIDv7()
	private readonly lists = new Map<StateList, Set<string>>()
	private locked = false

	constructor(
		root: string,
		provider: string,
		private readonly mode: ReviewMode,
	) {
		this.directory = mode === 'fix' ? join(root, '.reviews', 'fix') : join(root, '.reviews', provider, mode)
		this.lockPath = join(root, '.reviews', 'lock')
	}

	async acquire() {
		await mkdir(dirname(this.lockPath), { recursive: true })
		let handle: FileHandle

		try {
			handle = await open(this.lockPath, 'wx')
		} catch (error) {
			if (error instanceof Error && 'code' in error && error.code === 'EEXIST') throw new Error(`Review lock already exists: ${this.lockPath}. Check its PID and stop all review processes before manually removing a stale lock.`, { cause: error })
			throw error
		}

		try {
			try {
				await handle.writeFile(JSON.stringify({ pid: process.pid, owner: this.owner, startedAt: new Date().toISOString() }) + '\n')
			} finally {
				await handle.close()
			}
		} catch (error) {
			await unlink(this.lockPath)
			throw error
		}

		this.locked = true
	}

	async release() {
		if (!this.locked) return
		const value: unknown = await Bun.file(this.lockPath).json()
		if (typeof value !== 'object' || value === null || !('owner' in value) || value.owner !== this.owner) throw new Error(`Review lock ownership changed: ${this.lockPath}`)
		await unlink(this.lockPath)
		this.locked = false
	}

	async initialize() {
		for (const directory of ['prompts', 'logs', 'reports', 'stderr']) await mkdir(join(this.directory, directory), { recursive: true })
		for (const name of ['COMPLETED', 'FAILED', 'SKIPPED'] as const) {
			if (!(await Bun.file(this.listPath(name)).exists())) {
				const list = await this.readList(name)
				await this.atomicWrite(this.listPath(name), list.size > 0 ? [...list].join('\n') + '\n' : '')
			}
		}
		const usage = join(this.directory, 'USAGE.tsv')
		if (!(await Bun.file(usage).exists())) await Bun.write(usage, 'file\tmode\tstatus\tstopReason\tturns\tcostUsd\tfindingsCount\tsessionId\tlog\n')
	}

	async readList(name: StateList) {
		let list = this.lists.get(name)

		if (!list) {
			const file = Bun.file(this.listPath(name))
			list = new Set(((await file.exists()) ? await file.text() : '').split(BREAK_LINE_PATTERN).filter(Boolean))
			if (name === 'COMPLETED') for (const path of await this.retryableFiles(this.directory)) list.delete(path)
			// Import existing fix completions once; subsequent retries use only the shared state.
			if (name === 'COMPLETED' && this.mode === 'fix' && !(await file.exists())) {
				let entries
				try {
					entries = await readdir(dirname(this.lockPath), { withFileTypes: true })
				} catch (error) {
					if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
				}
				for (const entry of entries ?? []) {
					if (!entry.isDirectory() || entry.name === 'fix') continue
					const directory = join(dirname(this.lockPath), entry.name, 'fix')
					const completed = Bun.file(join(directory, 'COMPLETED.txt'))
					const failed = await this.retryableFiles(directory)
					if (await completed.exists()) for (const path of (await completed.text()).split(BREAK_LINE_PATTERN)) if (path && !failed.has(path)) list.add(path)
				}
			}
			this.lists.set(name, list)
		}

		return list
	}

	async updateList(name: StateList, file: string, present: boolean) {
		const list = await this.readList(name)
		if (list.has(file) === present) return
		if (present) list.add(file)
		else list.delete(file)
		await this.atomicWrite(this.listPath(name), list.size > 0 ? [...list].join('\n') + '\n' : '')
	}

	// Restore shell-era path names while also replacing characters forbidden in Windows filenames.
	reportPath(file: string) {
		return join(this.directory, 'reports', file.replaceAll(/[\\/:*?"<>| ]/g, '_') + '.md')
	}

	// Only successful reports prevent reruns. Old failure reports and diagnostic artifacts remain retryable.
	async existingArtifacts(files: readonly string[]): Promise<Map<string, string>> {
		const targets = new Map<string, string>()
		const existing = new Map<string, string>()
		const retryable = await this.retryableFiles(this.directory)

		for (const file of files) {
			const path = this.reportPath(file)
			const key = process.platform === 'win32' ? path.toLowerCase() : path
			const previous = targets.get(key)

			// Distinct source paths must never overwrite each other after lossy filename sanitization.
			if (previous !== undefined && previous !== file) throw new Error(`Report filename collision: ${previous} and ${file} both map to ${path}`)
			targets.set(key, file)

			if (!retryable.has(file) && (await Bun.file(path).exists())) existing.set(file, path)
		}

		return existing
	}

	// FAILED covers attempts interrupted before history is appended; the last usage entry also covers legacy interrupts.
	private async retryableFiles(directory: string) {
		const failed = Bun.file(join(directory, 'FAILED.txt'))
		const files = new Set(((await failed.exists()) ? await failed.text() : '').split(BREAK_LINE_PATTERN).filter(Boolean))
		const usage = Bun.file(join(directory, 'USAGE.tsv'))
		const outcomes = new Map<string, string>()
		if (await usage.exists()) {
			for (const line of (await usage.text()).split(BREAK_LINE_PATTERN).slice(1)) {
				const [file, , outcome] = line.split('\t')
				if (file && outcome) outcomes.set(file, outcome)
			}
		}
		for (const [file, outcome] of outcomes) if (outcome !== 'ok') files.add(file)
		return files
	}

	// Invalidate completion before starting work, so even an abrupt exit remains retryable.
	async beginAttempt(file: string) {
		await this.updateList('FAILED', file, true)
		await this.updateList('COMPLETED', file, false)
		await this.removeReport(file)
	}

	async removeReport(file: string) {
		await rm(this.reportPath(file), { force: true })
	}

	artifacts(file: string): SessionArtifacts {
		const name = basename(this.reportPath(file), '.md')
		return { file, mode: this.mode, prompt: join(this.directory, 'prompts', name + '.md'), log: join(this.directory, 'logs', name + '.json'), report: this.reportPath(file), stderr: join(this.directory, 'stderr', name + '.log') }
	}

	async saveResult(artifacts: SessionArtifacts, result: ReviewResult, outcome: ReviewOutcome, force = false) {
		if (outcome === 'ok') {
			// Exclusive creation preserves a report created externally while the provider was running.
			const report = await open(artifacts.report, force ? 'w' : 'wx')
			try {
				await report.writeFile(result.report)
			} finally {
				await report.close()
			}
		} else if (force) {
			await this.removeReport(artifacts.file)
		}

		const metrics = result.metrics
		const fields = [artifacts.file, this.mode, outcome, result.stopReason, metrics?.turns, metrics?.costUsd, metrics?.findingsCount, result.sessionId, basename(artifacts.log)]
		const line =
			fields
				.map((value) =>
					String(value ?? '')
						.replaceAll('\\', '\\\\')
						.replaceAll('\t', '\\t')
						.replaceAll('\r', '\\r')
						.replaceAll('\n', '\\n'),
				)
				.join('\t') + '\n'

		const history = await open(join(this.directory, 'USAGE.tsv'), 'a')

		try {
			await history.writeFile(line)
		} finally {
			await history.close()
		}

		// Completion is deliberately the last write, after session artifacts and history are saved.
		await this.updateList('SKIPPED', artifacts.file, false)
		await this.updateList('FAILED', artifacts.file, outcome !== 'ok')
		await this.updateList('COMPLETED', artifacts.file, outcome === 'ok')
	}

	private listPath(name: StateList) {
		return join(this.directory, name + '.txt')
	}

	private async atomicWrite(path: string, text: string) {
		const temporary = path + '.' + this.owner + '.tmp'

		try {
			await Bun.write(temporary, text)
			await rename(temporary, path)
		} finally {
			if (await Bun.file(temporary).exists()) await unlink(temporary)
		}
	}
}
