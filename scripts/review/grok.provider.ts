import type { PreparedSession, ProviderOption, ReviewMetrics, ReviewProvider, ReviewResult, SessionArtifacts, SessionRequest } from './provider'
import { findingsCount, metric } from './result.metrics'

// Grok's command line and JSON envelope are confined to this provider.
export class GrokReviewProvider implements ReviewProvider {
	readonly id = 'grok'
	readonly capabilities = new Set<ProviderOption>(['maxTurns', 'model', 'effort', 'allowSubagents'])
	readonly defaults = { maxTurns: 60, effort: 'high', allowSubagents: false }

	prepareSession(request: SessionRequest): PreparedSession {
		const executable = Bun.which('grok')
		if (!executable) throw new Error('grok is not on PATH')
		const options = { ...this.defaults, ...request.options }
		// Workspace Landlock cannot write ~/.cache/codebase-memory-mcp, so the graph MCP handshake fails.
		const args = ['--cwd', request.root, '--no-auto-update', '--always-approve', '--sandbox', 'off', '--max-turns', String(options.maxTurns), '--reasoning-effort', options.effort, '--output-format', 'json', '--verbatim', '--prompt-file', request.artifacts.prompt]
		if (!options.allowSubagents) args.push('--no-subagents')
		if (options.model) args.push('--model', options.model)
		if (request.mode === 'review') args.push('--deny', 'Bash(git *)', '--disallowed-tools', 'search_replace,write')

		return {
			executable,
			args,
			env: { ...process.env, GROK_MEMORY: '0', GROK_SUBAGENTS: options.allowSubagents ? '1' : '0', GROK_DISABLE_AUTOUPDATER: '1' },
		}
	}

	async parseResult(artifacts: SessionArtifacts): Promise<ReviewResult> {
		const raw = await Bun.file(artifacts.log).text()
		if (!raw) return { classification: 'error', stopReason: 'empty grok output', report: `Grok produced no stdout. stderr:\n${await Bun.file(artifacts.stderr).text()}\n` }

		let value: unknown
		try {
			value = JSON.parse(raw)
		} catch {
			return { classification: 'error', stopReason: 'parse_error', report: raw }
		}

		if (typeof value !== 'object' || value === null) return { classification: 'error', stopReason: 'parse_error', report: raw }

		const record = value as { type?: unknown; message?: unknown; text?: unknown; stopReason?: unknown; num_turns?: unknown; total_cost_usd?: unknown; sessionId?: unknown }
		const text = typeof record.text === 'string' ? record.text : ''
		const sessionId = typeof record.sessionId === 'string' ? record.sessionId : undefined
		const metrics: ReviewMetrics = { turns: metric(record.num_turns, true), costUsd: metric(record.total_cost_usd), findingsCount: findingsCount(text, artifacts) }

		if (record.type === 'error') {
			const message = typeof record.message === 'string' ? record.message : 'unknown grok error'
			return { classification: 'error', stopReason: message, report: message + '\n', metrics, sessionId }
		}

		const stopReason = typeof record.stopReason === 'string' ? record.stopReason : ''

		return {
			classification: ['max_turn_requests', 'max_tokens', 'cancelled'].includes(stopReason) ? 'incomplete' : 'ok',
			stopReason,
			sessionId,
			metrics,
			report: text.endsWith('\n') ? text : text + '\n',
		}
	}
}
