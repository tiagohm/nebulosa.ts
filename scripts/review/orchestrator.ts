import { join } from 'path'
import { $ } from 'bun'
import { errorMessage } from '../../src/core/util'
import type { ReviewFileList } from './file.list'
import type { BunProcessRunner, ProcessResult } from './process.runner'
import type { ReviewPromptBuilder } from './prompt.builder'
import type { PreparedSession, ReviewOptions, ReviewProvider, ReviewResult, SessionArtifacts } from './provider'
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
	) {}

	async status(files: readonly string[]) {
		const [completed, failed, skipped] = await Promise.all([this.state.readList('COMPLETED'), this.state.readList('FAILED'), this.state.readList('SKIPPED')])
		console.info(`state: ${this.state.directory}\nselected: ${files.length}`)
		console.info(`completed: ${files.filter((file) => completed.has(file)).length}`)
		console.info(`failed: ${files.filter((file) => failed.has(file)).length}`)
		console.info(`skipped: ${files.filter((file) => skipped.has(file)).length}`)
		console.info(`remaining: ${files.filter((file) => !completed.has(file)).length}`)
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

			const completed = await this.state.readList('COMPLETED')
			let ran = 0
			let ok = 0
			let failed = 0
			let skipped = 0

			for (let i = 0; i < files.length; i++) {
				if (controller.signal.aborted) break

				const file = files[i]
				const prefix = `[${i + 1}/${files.length}]`

				if (!options.force && completed.has(file)) {
					console.info(`${prefix} SKIP completed: ${file}`)
					skipped++
					continue
				}
				if (options.limit > 0 && ran >= options.limit) break
				if (options.force && !options.dryRun) await this.state.updateList('COMPLETED', file, false)
				if (!(await this.fileList.exists(file))) {
					console.info(`${prefix} SKIP missing: ${file}`)
					if (!options.dryRun) await this.state.updateList('SKIPPED', file, true)
					skipped++
					continue
				}

				ran++
				console.info(`${prefix} ${options.mode} ${file}`)
				if (options.dryRun) continue

				const artifacts = this.state.artifacts(file)
				const execution = await this.session(artifacts, options, controller.signal)
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

				await this.state.saveResult(artifacts, result, outcome)

				// An interrupt during artifact writes must not leave a forced retry completed.
				if (controller.signal.aborted && outcome !== 'interrupted') {
					await this.state.updateList('COMPLETED', file, false)
					outcome = 'interrupted'
				}

				this.printResult(prefix, file, result, outcome)

				if (outcome === 'interrupted') return controller.signal.reason === 'SIGTERM' || processResult.signal === 'SIGTERM' || processResult.exitCode === 143 ? 143 : 130
				if (outcome === 'ok') ok++
				else {
					failed++
					console.error(`Stopping batch: ${file} remains pending and will be retried on the next run.`)
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

	private async session(artifacts: SessionArtifacts, options: ReviewOptions, signal: AbortSignal): Promise<{ result: ReviewResult; processResult: ProcessResult }> {
		await Promise.all([Bun.write(artifacts.prompt, await this.prompts.build(artifacts.file, options.mode)), Bun.write(artifacts.log, ''), Bun.write(artifacts.stderr, '')])

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
