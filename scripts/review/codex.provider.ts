import { createInterface } from 'readline'
import { Readable } from 'stream'
import type { PreparedSession, ProviderOption, ReviewProvider, ReviewResult, SessionArtifacts, SessionRequest } from './provider'
import { findingsCount } from './result.metrics'

// Codex exec uses one ephemeral thread per file and emits JSONL lifecycle events.
export class CodexReviewProvider implements ReviewProvider {
	readonly id = 'codex'
	readonly capabilities: ReadonlySet<ProviderOption> = new Set(['model', 'effort', 'allowSubagents'])
	readonly defaults = { allowSubagents: false, effort: 'high' }

	async prepareSession(request: SessionRequest): Promise<PreparedSession> {
		const executable = Bun.which('codex')
		if (!executable) throw new Error('codex is not on PATH; install Codex CLI and authenticate with codex login')
		const options = { ...this.defaults, ...request.options }
		const args = [
			'exec',
			'--cd',
			request.root,
			'--json',
			'--ephemeral',
			'--color',
			'never',
			'--sandbox',
			// Workspace sandboxing protects .git, so unattended per-finding commits need full access.
			request.mode === 'fix' ? 'danger-full-access' : 'read-only',
			'--config',
			'approval_policy="never"',
			'--config',
			'features.memories=false',
			'--config',
			'features.unbounded_connection_retries=false',
			'--config',
			`features.multi_agent=${options.allowSubagents}`,
		]

		if (!options.allowSubagents) args.push('--config', 'features.multi_agent_v2=false')
		if (options.model) args.push('--model', options.model)
		if (options.effort) args.push('--config', `model_reasoning_effort=${JSON.stringify(options.effort)}`)
		args.push('-')

		return { executable, args, env: { ...process.env }, stdin: await Bun.file(request.artifacts.prompt).text() }
	}

	async parseResult(artifacts: SessionArtifacts): Promise<ReviewResult> {
		const input = Readable.from(Bun.file(artifacts.log).stream())
		const lines = createInterface({ input, crlfDelay: Infinity })
		let sessionId: string | undefined
		let report = ''
		let completed = false
		let messageInTurn = false
		let sawEvent = false
		let failure: string | undefined
		let malformed = false

		try {
			for await (const line of lines) {
				if (!line.trim()) continue

				let value: unknown

				try {
					value = JSON.parse(line)
				} catch {
					malformed = true
					continue
				}

				if (!isRecord(value) || typeof value.type !== 'string') {
					malformed = true
					continue
				}

				sawEvent = true

				switch (value.type) {
					case 'thread.started':
						if (typeof value.thread_id === 'string') sessionId = value.thread_id
						break
					case 'turn.started':
						completed = false
						messageInTurn = false
						break
					case 'item.completed':
						if (isRecord(value.item) && value.item.type === 'agent_message' && typeof value.item.text === 'string') {
							report = value.item.text
							messageInTurn = !!report.trim()
						}
						break
					case 'turn.completed':
						completed = true
						break
					case 'turn.failed':
						failure = isRecord(value.error) && typeof value.error.message === 'string' ? value.error.message : 'codex turn failed'
						break
					case 'error':
						failure = typeof value.message === 'string' ? value.message : 'codex error'
						break
				}
			}
		} finally {
			lines.close()
			input.destroy()
		}

		const stopReason = failure !== undefined ? failure || 'codex error' : malformed ? 'parse_error' : !sawEvent ? 'empty codex output' : !completed ? 'missing turn.completed' : !messageInTurn ? 'missing final agent message' : 'turn.completed'
		const classification = failure !== undefined || malformed || !sawEvent ? 'error' : completed && messageInTurn ? 'ok' : 'incomplete'
		const metrics = { findingsCount: findingsCount(report, artifacts) }
		if (!report) report = `Codex produced no report (${stopReason}). stderr:\n${await Bun.file(artifacts.stderr).text()}`
		return { classification, stopReason, report: report.endsWith('\n') ? report : report + '\n', sessionId, metrics }
	}
}

// Narrow only the external fields the JSONL parser needs; tool payloads stay opaque.
function isRecord(value: unknown): value is { type?: unknown; thread_id?: unknown; item?: unknown; text?: unknown; message?: unknown; error?: unknown } {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}
