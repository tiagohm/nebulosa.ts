import { open } from 'fs/promises'
import { join } from 'path'
import { $ } from 'bun'
import { errorMessage } from '../../src/core/util'
import type { ReviewFileList } from './file.list'
import type { BunProcessRunner, ProcessResult } from './process.runner'
import type { ReviewPromptBuilder } from './prompt.builder'
import type { PreparedSession, ReviewOptions, ReviewProvider, ReviewResult, SessionArtifacts } from './provider'
import type { FixReport } from './report.store'
import type { ReviewOutcome, ReviewStateStore } from './state.store'

// Runs independent sessions sequentially. Provider results are persisted before recording completion.
export class ReviewOrchestrator {
	constructor(
		private readonly root: string,
		private readonly provider: ReviewProvider,
		private readonly runner: BunProcessRunner,
		private readonly state: ReviewStateStore,
		private readonly fileList: ReviewFileList,
		private readonly prompts: ReviewPromptBuilder,
		private readonly reports?: ReadonlyMap<string, FixReport>,
	) {}

	async status(files: readonly string[]) {
		const [completed, failed, skipped, existing] = await Promise.all([this.state.readList('COMPLETED'), this.state.readList('FAILED'), this.state.readList('SKIPPED'), this.state.existingArtifacts(files)])
		console.info(`state: ${this.state.directory}\nselected: ${files.length}`)
		console.info(`completed: ${files.filter((file) => completed.has(file)).length}`)
		console.info(`existing artifacts: ${existing.size}`)
		console.info(`failed: ${files.filter((file) => failed.has(file)).length}`)
		console.info(`skipped: ${files.filter((file) => skipped.has(file)).length}`)
		console.info(`remaining: ${files.filter((file) => !completed.has(file) && !existing.has(file) && (!this.reports || this.eligibleReport(file))).length}`)

		if (this.reports) {
			console.info(`without eligible report: ${files.filter((file) => !this.eligibleReport(file)).length}`)

			for (const file of files) {
				const report = this.reports.get(file)
				console.info(`${file}: ${this.reportSkipReason(file) ?? 'eligible'}${report ? ` | report: ${report.path} | sha256: ${report.hash}` : ''}`)
			}
		}

		return 0
	}

	async run(files: readonly string[], options: ReviewOptions) {
		const controller = new AbortController()
		const onInterrupt = () => controller.abort('SIGINT')
		const onTerminate = () => controller.abort('SIGTERM')

		process.on('SIGINT', onInterrupt)
		process.on('SIGTERM', onTerminate)

		try {
			if (!options.dryRun) {
				await this.state.acquire()
				if (options.mode === 'fix') await this.requireCleanWorktree('Fix requires a clean worktree at batch start')
				if (controller.signal.aborted) return controller.signal.reason === 'SIGTERM' ? 143 : 130
				await this.state.initialize()
			}

			let ran = 0
			let ok = 0
			let failed = 0
			let skipped = 0

			const completed = await this.state.readList('COMPLETED')
			const existing = await this.state.existingArtifacts(files)

			for (let i = 0; i < files.length; i++) {
				if (controller.signal.aborted) break

				const file = files[i]
				const prefix = `[${(i + 1).toFixed(0).padStart(3, '0')}/${files.length.toFixed(0).padStart(3, '0')}]`
				const existingArtifact = existing.get(file)

				if (!options.force && existingArtifact === this.state.reportPath(file)) {
					console.info(`${prefix} SKIP existing report: ${file}`)
					skipped++
					continue
				}

				if (!options.force && completed.has(file)) {
					console.info(`${prefix} SKIP completed: ${file}`)
					skipped++
					continue
				}

				if (options.limit > 0 && ran >= options.limit) break

				const report = options.mode === 'fix' ? this.reports?.get(file) : undefined

				if (options.mode === 'fix') {
					const reason = this.reportSkipReason(file)

					if (reason) {
						console.info(`${prefix} SKIP ${reason}: ${file}${report ? ` | report: ${report.path}` : ''}`)
						if (!options.dryRun) await this.state.updateList('SKIPPED', file, true)
						skipped++
						continue
					}
				}

				if (options.force && !options.dryRun) await this.state.updateList('COMPLETED', file, false)

				if (!(await this.fileList.exists(file))) {
					console.info(`${prefix} SKIP missing: ${file}`)
					if (!options.dryRun) await this.state.updateList('SKIPPED', file, true)
					skipped++
					continue
				}

				ran++
				console.info(`${prefix} ${options.mode} ${file}${report ? ` | report: ${report.path} | sha256: ${report.hash}` : ''}`)
				if (options.dryRun) continue

				await this.state.beginAttempt(file)
				const artifacts = this.state.artifacts(file)
				const execution = await this.session(artifacts, options, controller.signal, report)
				const result = execution.result
				const processResult = execution.processResult
				const interrupted = controller.signal.aborted || processResult.signal !== undefined || (!processResult.timedOut && (processResult.exitCode === 130 || processResult.exitCode === 143))
				let outcome: ReviewOutcome = result.classification

				if (interrupted) outcome = 'interrupted'
				else if (processResult.timedOut || processResult.error || (processResult.exitCode !== 0 && outcome === 'ok')) outcome = 'error'
				if (processResult.timedOut) result.stopReason = `timeout after ${options.timeout}s${result.stopReason ? `; ${result.stopReason}` : ''}`
				else if (processResult.error) result.stopReason = processResult.error
				else if (processResult.exitCode !== 0) result.stopReason = `exit ${processResult.exitCode}${result.stopReason ? `; ${result.stopReason}` : ''}`

				// A successful fix session must finish committing its corrections before it can complete.
				if (options.mode === 'fix' && outcome === 'ok') {
					try {
						await this.requireCleanWorktree('Fix session left changes without a per-finding commit')
					} catch (error) {
						outcome = 'incomplete'
						result.stopReason = errorMessage(error)
					}
				}

				await this.state.saveResult(artifacts, result, outcome, options.force)

				// An interrupt during artifact writes must not leave a forced retry completed.
				if (controller.signal.aborted && outcome !== 'interrupted') {
					await this.state.removeReport(file)
					await this.state.updateList('COMPLETED', file, false)
					await this.state.updateList('FAILED', file, true)
					outcome = 'interrupted'
				}

				this.printResult(prefix, file, result, outcome)

				if (outcome === 'interrupted') return controller.signal.reason === 'SIGTERM' || processResult.signal === 'SIGTERM' || processResult.exitCode === 143 ? 143 : 130
				if (outcome === 'ok') ok++
				else {
					failed++
					console.error(`Stopping batch: ${file} did not complete. Logs are preserved; run again to retry.`)
					break
				}
			}

			console.info(`done. provider=${this.provider.id} mode=${options.mode} ran=${ran} ok=${ok} failed=${failed} skipped=${skipped}`)

			if (!options.dryRun) console.info(`reports: ${join(this.state.directory, 'reports')}`)
			if (controller.signal.aborted) return controller.signal.reason === 'SIGTERM' ? 143 : 130
			return failed > 0 ? 1 : 0
		} catch (error) {
			if (!controller.signal.aborted) throw error
			console.error(errorMessage(error))
			return controller.signal.reason === 'SIGTERM' ? 143 : 130
		} finally {
			try {
				await this.state.release()
			} finally {
				process.off('SIGINT', onInterrupt)
				process.off('SIGTERM', onTerminate)
			}
		}
	}

	private eligibleReport(file: string) {
		return this.reportSkipReason(file) === undefined
	}

	private reportSkipReason(file: string) {
		const report = this.reports?.get(file)
		if (!report) return 'no review report'
		if (report.incomplete) return 'incomplete review report'
		if (report.findings === 0) return 'no findings'
		return undefined
	}

	private async session(artifacts: SessionArtifacts, options: ReviewOptions, signal: AbortSignal, report?: FixReport): Promise<{ result: ReviewResult; processResult: ProcessResult }> {
		const prompt = await this.prompts.build(artifacts.file, options.mode, report)
		const writes = await Promise.allSettled([this.writeArtifact(artifacts.prompt, prompt), this.writeArtifact(artifacts.log, ''), this.writeArtifact(artifacts.stderr, '')])

		// Finish and close every artifact write before releasing the lock on a creation failure.
		for (const write of writes) {
			if (write.status === 'rejected') throw new Error(errorMessage(write.reason))
		}

		let prepared: PreparedSession

		try {
			prepared = await this.provider.prepareSession({ root: this.root, file: artifacts.file, mode: options.mode, options: options.providerOptions, artifacts })
		} catch (error) {
			const message = errorMessage(error)
			await Bun.write(artifacts.stderr, message + '\n')
			return { result: { classification: 'error', report: message + '\n', stopReason: message }, processResult: { exitCode: 1, timedOut: false, error: message } }
		}

		// Cleanup failures are reported and persisted, then abort the batch before another session starts.
		const processResult = await this.runner.run(prepared, artifacts, options.timeout, signal)

		try {
			return { result: await this.provider.parseResult(artifacts), processResult }
		} catch (error) {
			const message = errorMessage(error)
			return { result: { classification: 'error', report: `Unable to parse session output: ${message}\n`, stopReason: message }, processResult }
		}
	}

	// Diagnostic artifacts belong to the latest attempt; they never mark completion.
	private async writeArtifact(path: string, text: string) {
		const file = await open(path, 'w')

		try {
			await file.writeFile(text)
		} finally {
			await file.close()
		}
	}

	private printResult(prefix: string, file: string, result: ReviewResult, outcome: ReviewOutcome) {
		const values = [`${prefix} ${outcome.toUpperCase()}: ${file}`]
		if (result.metrics?.turns !== undefined) values.push(`turns=${result.metrics.turns}`)
		if (result.metrics?.costUsd !== undefined) values.push(`cost=US$${result.metrics.costUsd}`)
		if (result.metrics?.findingsCount !== undefined) values.push(`findings=${result.metrics.findingsCount}`)
		if (outcome !== 'ok' && result.stopReason) values.push(`reason=${result.stopReason.replaceAll(/[\r\n\t]/g, ' ')}`)
		console.info(values.join(' | '))
	}

	private async requireCleanWorktree(reason: string) {
		const status = await $`git -C ${this.root} status --porcelain=v1 -z --untracked-files=all`.quiet().nothrow()
		if (status.exitCode !== 0) throw new Error(`Cannot check fix worktree: ${status.stderr.toString().trim()}`)

		const records = status.stdout.toString().split('\0')
		const paths: string[] = []

		for (let i = 0; i < records.length; i++) {
			const record = records[i]
			if (!record) continue
			paths.push(`${record.slice(0, 2)} ${JSON.stringify(record.slice(3))}`)
			if (/[RC]/.test(record.slice(0, 2))) paths.push(`   from ${JSON.stringify(records[++i])}`)
		}

		if (paths.length > 0) throw new Error(`${reason}. Blocking paths:\n${paths.join('\n')}`)
	}
}
