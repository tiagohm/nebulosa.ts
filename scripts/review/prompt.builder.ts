import type { ReviewMode } from './provider'

// Shared session instructions contain no provider-specific identity or protocol.
export class ReviewPromptBuilder {
	constructor(
		private readonly sessionPath: string,
		private readonly domainPath: string,
	) {}

	async build(file: string, mode: ReviewMode) {
		const [session, domain] = await Promise.all([Bun.file(this.sessionPath).text(), Bun.file(this.domainPath).text()])
		return `${session}\n---\n\n${domain}\n---\n\n# CURRENT REVIEW\n\nMODE: ${mode}\nPRIMARY FILE: ${file}\n\nThis session is independent from every previous review.\nStart with the primary file. Do not perform a general repository review.\nYour final message is the report, including the REVIEW_TRAILER.\n`
	}
}
