import { tmpdir } from 'os'
import { join } from 'path'
import { $ } from 'bun'

const cwd = process.cwd().replaceAll('\\', '/')
const args = { repo_path: cwd, name: 'nebulosa.ts' } as const

const file = Bun.file(join(tmpdir(), Bun.randomUUIDv7() + '.json'))
await Bun.write(file, JSON.stringify(args))

try {
	// Exit 0 with no output is treated as success and Codex continues.
	await $`codebase-memory-mcp cli index_repository --args-file '${file}'`.quiet()
} catch (e) {
	if (e instanceof $.ShellError) {
		process.exitCode = e.exitCode
		console.error(e.stderr.toString())
	}
} finally {
	await file.delete()
}
