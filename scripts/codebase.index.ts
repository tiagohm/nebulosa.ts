import { $ } from 'bun'

const cwd = process.cwd().replaceAll('\\', '/')

await $`codebase-memory-mcp cli index_repository '{"repo_path": "${cwd}"}'`
