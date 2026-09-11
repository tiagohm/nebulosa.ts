import { readdir, stat } from 'fs/promises'
import { join } from 'path'
import type { ReviewFileList } from './file.list'
import { findingsCount, reviewTrailer } from './result.metrics'

// Immutable input snapshots keep manual review notes intact throughout a fix batch.
export interface FixReport {
	readonly file: string
	readonly path: string
	readonly text: string
	readonly hash: string
	readonly findings: number
	readonly incomplete: boolean
	readonly modifiedAt: number
}

// Select one report per exact normalized source path, never by basename or provider inference.
export class ReviewReportStore {
	constructor(
		readonly directory: string,
		private readonly fileList: ReviewFileList,
	) {}

	async load(files: readonly string[]): Promise<Map<string, FixReport>> {
		const selected = new Set(files)
		const reports = new Map<string, FixReport>()
		let entries: string[]

		try {
			entries = await readdir(this.directory)
		} catch (error) {
			if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return reports
			throw error
		}

		// Sequential reads bound open files and temporary report buffers independently of batch size.
		for (const entry of entries.sort()) {
			if (!entry.endsWith('.md')) continue

			const path = join(this.directory, entry)
			const metadata = await stat(path)
			if (!metadata.isFile()) continue

			const text = await Bun.file(path).text()
			const trailer = reviewTrailer(text)
			const file = trailer?.get('file')

			if (!file) {
				console.warn(`SKIP report without a unique REVIEW_TRAILER identity: ${path}. Add valid file, mode, findings and incomplete metadata to use it as fix input.`)
				continue
			}

			if (!selected.has(file)) continue
			if (this.fileList.normalize(file) !== file || trailer?.get('mode') !== 'review') throw new Error(`Invalid review identity in fix input: ${path}`)

			const findings = findingsCount(text, { file, mode: 'review' })
			const incomplete = trailer?.get('incomplete')
			if (findings === undefined || (incomplete !== 'true' && incomplete !== 'false')) throw new Error(`Invalid findings or incomplete metadata in fix input: ${path}`)

			const previous = reports.get(file)
			// Modification time includes deliberate author edits; lexical path order breaks exact ties.
			if (previous && (previous.modifiedAt > metadata.mtimeMs || (previous.modifiedAt === metadata.mtimeMs && previous.path > path))) continue
			reports.set(file, { file, path, text, hash: Bun.SHA256.hash(text, 'hex'), findings, incomplete: incomplete === 'true', modifiedAt: metadata.mtimeMs })
		}

		return reports
	}
}
