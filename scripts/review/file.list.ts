import { stat } from 'fs/promises'
import { isAbsolute, relative, resolve, sep } from 'path'

// File selection uses repository-relative paths; list filenames use the invocation directory.
export class ReviewFileList {
	constructor(
		readonly root: string,
		readonly defaultPath: string,
	) {}

	normalize(file: string) {
		const normalized = relative(this.root, resolve(this.root, file)).split(sep).join('/')
		if (!normalized || isAbsolute(normalized) || normalized === '..' || normalized.startsWith('../')) throw new Error(`Review file must be inside the repository: ${file}`)
		if (/[\r\n\t\0]/.test(normalized)) throw new Error(`Review file contains a control character: ${JSON.stringify(file)}`)
		return normalized
	}

	async select(positional: readonly string[], filesPath: string | undefined, invocationDirectory: string) {
		const entries = positional.length > 0 ? positional : (await Bun.file(filesPath ? resolve(invocationDirectory, filesPath) : this.defaultPath).text()).split(/\r?\n/).filter((line) => !/^\s*(?:#|$)/.test(line))
		const files: string[] = []
		const seen = new Set<string>()

		for (const entry of entries) {
			const file = this.normalize(entry)
			const key = process.platform === 'win32' ? file.toLowerCase() : file

			if (!seen.has(key)) {
				seen.add(key)
				files.push(file)
			}
		}

		return files
	}

	async exists(file: string) {
		try {
			return (await stat(resolve(this.root, file))).isFile()
		} catch (error) {
			if (error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return false
			throw error
		}
	}

	async regenerate() {
		const domains = ['core', 'math', 'io', 'astronomy', 'imaging', 'astrometry', 'catalogs', 'bindings', 'devices', 'adapters', 'observation']
		const lines = ['# Primary source files for per-file review.', '# Comment a line with # to skip and keep it excluded during refresh. Blank lines are ignored.', '# Regenerate with: bun run review --refresh-list', '']
		const current = Bun.file(this.defaultPath)
		const disabled = new Map<string, string>()
		const fileMatchRegex = /^\s*#+\s*(.+\.ts)\s*$/

		if (await current.exists()) {
			for (const line of (await current.text()).split(/\r?\n/)) {
				const match = fileMatchRegex.exec(line)

				if (!match) continue

				const file = relative(this.root, resolve(this.root, match[1].replaceAll('\\', '/')))
					.split(sep)
					.join('/')

				const key = process.platform === 'win32' ? file.toLowerCase() : file
				if (key.startsWith('src/') && !/[\r\n\t\0]/.test(file)) disabled.set(key, file)
			}
		}

		for (const domain of domains) {
			const files = new Map<string, string>()

			for await (const file of new Bun.Glob(`src/${domain}/**/*.ts`).scan({ cwd: this.root, onlyFiles: true })) {
				if (file.endsWith('.data.ts')) continue
				const normalized = this.normalize(file)
				files.set(process.platform === 'win32' ? normalized.toLowerCase() : normalized, normalized)
			}

			// Keep disabled entries even if their files are temporarily absent, so refresh cannot reactivate them later.
			for (const [key, file] of disabled) {
				if (key.startsWith(`src/${domain}/`) && !files.has(key)) files.set(key, file)
			}

			lines.push(`# --- src/${domain} ---`)

			for (const file of [...files.values()].sort()) {
				const key = process.platform === 'win32' ? file.toLowerCase() : file
				lines.push(disabled.has(key) ? `# ${file}` : file)
				disabled.delete(key)
			}

			lines.push('')
		}

		// Preserve exclusions outside the standard domain list without activating them.
		for (const file of [...disabled.values()].sort()) lines.push(`# ${file}`)
		if (disabled.size > 0) lines.push('')

		await Bun.write(this.defaultPath, lines.join('\n'))
	}
}
