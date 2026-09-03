// Parse grok --output-format json into a markdown report and a TSV status line.
//
// Usage: bun scripts/review/parse.result.ts <log.json> <report.md>
// Prints: status<TAB>stopReason<TAB>turns<TAB>cost<TAB>sessionId
// Exit: 0 success, 1 grok error, 2 invalid JSON, 3 incomplete stop reason.

const logPath = Bun.argv.at(2)
const reportPath = Bun.argv.at(3)

if (!logPath || !reportPath) {
	console.error('usage: bun scripts/review/parse.result.ts <log.json> <report.md>')
	process.exit(2)
}

const raw = await Bun.file(logPath).text()
let value: unknown

try {
	value = JSON.parse(raw)
} catch {
	await Bun.write(reportPath, raw)
	console.log(['parse_error', '', '', '', ''].join('\t'))
	process.exit(2)
}

if (typeof value !== 'object' || value === null) {
	await Bun.write(reportPath, raw)
	console.log(['parse_error', '', '', '', ''].join('\t'))
	process.exit(2)
}

const record = value as Record<string, unknown>

if (record.type === 'error') {
	const message = typeof record.message === 'string' ? record.message : 'unknown grok error'
	await Bun.write(reportPath, message + '\n')
	console.log(['error', message.replaceAll('\t', ' ').replaceAll('\n', ' '), '', '', ''].join('\t'))
	process.exit(1)
}

const text = typeof record.text === 'string' ? record.text : ''
await Bun.write(reportPath, text.endsWith('\n') ? text : text + '\n')

const stop = typeof record.stopReason === 'string' ? record.stopReason : ''
const turns = typeof record.num_turns === 'number' ? String(record.num_turns) : ''
const cost = typeof record.total_cost_usd === 'number' ? String(record.total_cost_usd) : ''
const session = typeof record.sessionId === 'string' ? record.sessionId : ''

console.log(['ok', stop, turns, cost, session].join('\t'))

if (stop === 'max_turn_requests' || stop === 'max_tokens' || stop === 'cancelled') {
	process.exit(3)
}
