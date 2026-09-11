import { BREAK_LINE_PATTERN } from '../../src/core/patterns'
import type { SessionArtifacts } from './provider'

// Validate optional metrics at the external JSON boundary; invalid data stays absent.
export function metric(value: unknown, integer = false) {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0 && (!integer || Number.isSafeInteger(value)) ? value : undefined
}

const FINDINGS_COUNT_PATTERN = /^\d+$/

// A unique, line-delimited trailer must identify this exact file and mode. It never controls completion.
export function findingsCount(text: string, artifacts: Pick<SessionArtifacts, 'file' | 'mode'>) {
	const fields = reviewTrailer(text)
	if (!fields || fields.get('file') !== artifacts.file || fields.get('mode') !== artifacts.mode) return undefined
	const count = fields.get('findings')
	return count !== undefined && FINDINGS_COUNT_PATTERN.test(count) ? metric(Number(count), true) : undefined
}

// Read a unique trailer without interpreting report prose or author notes as metadata.
export function reviewTrailer(text: string) {
	const lines = text.split(BREAK_LINE_PATTERN)
	const markers: number[] = []

	for (let i = 0; i < lines.length; i++) if (lines[i].trim() === 'REVIEW_TRAILER') markers.push(i)
	if (markers.length !== 1) return undefined
	const fields = new Map<string, string>()

	for (let i = markers[0] + 1; i < lines.length; i++) {
		const line = lines[i].trim()
		if (!line || line.startsWith('```')) break
		const match = /^(file|mode|verdict|findings|changed|incomplete):\s*(.*?)\s*$/.exec(line)
		if (!match || fields.has(match[1])) return undefined
		fields.set(match[1], match[2])
	}

	return fields
}
