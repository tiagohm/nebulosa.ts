import type { ReviewMode } from './provider'
import type { FixReport } from './report.store'

// Shared session instructions contain no provider-specific identity or protocol.
export class ReviewPromptBuilder {
	constructor(
		private readonly sessionPath: string,
		private readonly reviewPath: string,
		private readonly fixPath: string,
	) {}

	async build(file: string, mode: ReviewMode, report?: FixReport) {
		if (mode === 'fix' && (!report || report.file !== file || report.findings === 0 || report.incomplete)) throw new Error(`Fix requires a complete review report with findings for ${file}`)
		const [session, instructions] = await Promise.all([Bun.file(this.sessionPath).text(), Bun.file(mode === 'fix' ? this.fixPath : this.reviewPath).text()])
		const input = mode === 'fix' && report ? `\n---\n\n# INPUT REVIEW REPORT\n\nSOURCE REPORT: ${JSON.stringify(report.path)}\nSOURCE SHA256: ${report.hash}\n\n${report.text}\n\n# END INPUT REVIEW REPORT\n` : ''
		const start = mode === 'fix' ? 'Read the supplied report and all author notes first. Address only its findings; do not perform a new review.' : 'Start with the primary file. Perform only the requested file review; do not make corrections.'
		return `${session}\n---\n\n${instructions}${input}\n---\n\n# CURRENT REVIEW\n\nMODE: ${mode}\nPRIMARY FILE: ${file}\n\n${start}\nDo not perform a general repository review.\nYour final message is the report, including the REVIEW_TRAILER.\n`
	}
}
