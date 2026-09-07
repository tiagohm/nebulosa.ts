import { join, resolve } from 'path'
import type { DeepWritable } from '../../src/core/types'
import { errorMessage } from '../../src/core/util'
import { CodexReviewProvider } from './codex.provider'
import { ReviewFileList } from './file.list'
import { GrokReviewProvider } from './grok.provider'
import { ReviewOrchestrator } from './orchestrator'
import { BunProcessRunner } from './process.runner'
import { ReviewPromptBuilder } from './prompt.builder'
import type { ProviderOption, ReviewOptions, ReviewProvider } from './provider'
import { ReviewStateStore } from './state.store'

// Composition root: adding a provider requires its implementation and this registry entry only.
const providers: ReadonlyMap<string, ReviewProvider> = new Map<string, ReviewProvider>([
	['grok', new GrokReviewProvider()],
	['codex', new CodexReviewProvider()],
])

function parseOptions(args: readonly string[]): ReviewOptions {
	const options: DeepWritable<ReviewOptions> = { provider: 'grok', mode: 'review', force: false, dryRun: false, status: false, help: false, refreshList: false, files: [], limit: 0, timeout: 0, providerOptions: {} }

	for (let i = 0; i < args.length; i++) {
		const arg = args[i]

		const value = () => {
			const next = args[++i]
			if (!next || next.startsWith('-')) throw new Error(`${arg} requires a value`)
			return next
		}

		switch (arg) {
			case '-h':
			case '--help':
				options.help = true
				break
			case '--fix':
				options.mode = 'fix'
				break
			case '--force':
				options.force = true
				break
			case '--dry-run':
				options.dryRun = true
				break
			case '--status':
				options.status = true
				break
			case '--refresh-list':
				options.refreshList = true
				break
			case '--allow-subagents':
				options.providerOptions.allowSubagents = true
				break
			case '--provider':
				options.provider = value()
				break
			case '--files':
				options.filesPath = value()
				break
			case '--model':
				options.providerOptions.model = value()
				break
			case '--effort':
				options.providerOptions.effort = value()
				break
			case '--limit':
				options.limit = numericOption(arg, value(), true, 0)
				break
			case '--max-turns':
				options.providerOptions.maxTurns = numericOption(arg, value(), true, 1)
				break
			case '--timeout':
				options.timeout = numericOption(arg, value(), false, 0)
				break
			case '--':
				for (let j = i + 1; j < args.length; j++) options.files.push(args[j])
				return options
			default:
				if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`)
				options.files.push(arg)
		}
	}
	return options
}

function numericOption(option: string, text: string, integer: boolean, minimum: number) {
	const number = Number(text)
	if (!text.trim() || !Number.isFinite(number) || !(number >= minimum && number <= Number.MAX_SAFE_INTEGER / (integer ? 1 : 1000)) || (integer && !Number.isSafeInteger(number))) throw new Error(`${option} requires a finite ${integer ? 'integer' : 'number'} >= ${minimum} within the safe numeric range`)
	return number
}

function help(provider: ReviewProvider) {
	console.info(`Usage: bun run review [options] [--] [file ...]

Run one independent provider session per file, sequentially, on Linux or Windows.

  --provider ID         Provider (available: ${[...providers.keys()].join(', ')}; default: grok)
  --fix                 Commit each fixed finding per AGENTS.md; requires a clean worktree
  --force               Retry completed files; clear completion before attempting
  --dry-run             Print pending files without writing or starting a provider
  --status              Show selected files' progress for this provider and mode
  --refresh-list        Regenerate scripts/review/FILES.txt, preserving commented exclusions
  --files PATH          List path relative to the invocation directory
  --limit N             At most N pending sessions (0 means unlimited)
  --max-turns N         Grok turn fuse (positive integer; unsupported by Codex)
  --timeout N           Session timeout in seconds (0 disables it)
  --model ID            Provider model
  --effort LEVEL        Provider reasoning effort
  --allow-subagents     Enable provider subagents
  -h, --help            Show help without writing or starting a provider

${provider.id} defaults: ${JSON.stringify(provider.defaults)}
Codex inherits its configured model and effort unless explicitly overridden.
Codex review uses read-only sandboxing; fix uses danger-full-access to allow commits.
Explicit unsupported provider options are errors. Positional files override --files.
Review paths resolve from the repository root; absolute paths inside it are accepted.
Lists accept comments, blank lines and CRLF; paths are deduplicated in order.
--help, --status and --dry-run take precedence over --refresh-list and never write.

State: .reviews/<provider>/<review|fix>/ (independent from .grok-reviews/).
Results print optional turns, cost in US dollars and findings, including zero.
Missing/invalid REVIEW_TRAILER metadata only omits findings; it does not affect completion.
Failed/incomplete sessions remain pending. Exit: 0 success, 1 failures, 130 interrupt,
143 termination. The first error, incomplete result or timeout stops the batch;
the current file remains pending for retry without --force. Partial work is preserved.
Fix sessions commit each corrected finding before the next; uncommitted changes
prevent completion. Review mode never stages or commits.
Linux: TERM then KILL after 15 seconds. Windows: hidden taskkill /T /F.
Global lock: .reviews/lock. After an abrupt exit, inspect its PID/owner, stop all
review processes and descendants, then manually remove the stale lock. See scripts/review/README.md.`)
}

async function main() {
	const options = parseOptions(Bun.argv.slice(2))
	const provider = providers.get(options.provider)

	if (!provider) throw new Error(`Unknown provider: ${options.provider}. Available: ${[...providers.keys()].join(', ')}`)

	for (const option of Object.keys(options.providerOptions) as ProviderOption[]) {
		if (!provider.capabilities.has(option)) throw new Error(`Provider ${provider.id} does not support option ${option}`)
	}

	if (options.help) {
		help(provider)
		return 0
	}

	const root = resolve(import.meta.dir, '../..')
	const fileList = new ReviewFileList(root, join(import.meta.dir, 'FILES.txt'))
	const state = new ReviewStateStore(root, provider.id, options.mode)

	if (options.refreshList && !options.status && !options.dryRun) {
		try {
			await state.acquire()
			await fileList.regenerate()
			console.info(`Wrote ${fileList.defaultPath}`)
			return 0
		} finally {
			await state.release()
		}
	}

	// Bun package scripts run in the package directory; preserve the caller's directory for --files.
	const files = await fileList.select(options.files, options.filesPath, process.env.INIT_CWD || process.cwd())
	const orchestrator = new ReviewOrchestrator(root, provider, new BunProcessRunner(root), state, fileList, new ReviewPromptBuilder(join(import.meta.dir, 'SESSION.md'), join(import.meta.dir, 'PROMPT.md')))
	if (options.status) return orchestrator.status(files)
	if (files.length === 0) throw new Error('No files to review')
	return orchestrator.run(files, options)
}

try {
	process.exitCode = await main()
} catch (error) {
	console.error(errorMessage(error))
	process.exitCode = 1
}
