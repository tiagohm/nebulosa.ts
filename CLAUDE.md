# CLAUDE.md

This file guides Claude Code when working in this repository. The full
contributor guidelines live in `AGENTS.md` and are imported below so there is a
single source of truth shared with other agents.

@AGENTS.md

## Claude Code Quick Reference

### Code discovery

This repository is indexed by `codebase-memory-mcp` (configured in `.mcp.json`).
Prefer its graph tools over raw text search:

1. `search_graph` to locate functions, classes, and types.
2. `trace_path` for callers, callees, and impact analysis.
3. `get_code_snippet` to read exact symbols after discovery.
4. `query_graph` for broader structural queries.
5. Fall back to `Grep`/`rg` only for string literals, config files, shell
   scripts, or when graph results are insufficient.

A `UserPromptSubmit` hook runs `bun run index` to keep the graph fresh. If the
`codebase-memory-mcp` binary is not installed, run its installer or remove the
hook from `.claude/settings.json`.

### Common commands

| Task                | Command                           |
| ------------------- | --------------------------------- |
| Install deps        | `bun i`                           |
| Lint + type-check   | `bun run lint`                    |
| Lint with fixes     | `bun run lint:fix`                |
| Format              | `bun run fmt`                     |
| Format check        | `bun run fmt:check`               |
| Run a targeted test | `bun test tests/FILENAME.test.ts` |
| Refresh code graph  | `bun run index`                   |

Use **Bun** for everything. Do not introduce npm/pnpm/yarn or a second test
runner. Do not use `bun run compile` as a substitute for linting.

### Before finishing a change

- Leave the touched area with zero TypeScript errors and passing related tests.
- Run the closest targeted tests, then `bun run lint`.
- Commit messages: English, all lowercase except acronyms and file names, and
  starting with a present-tense verb such as `implement`, `fix`, `improve`,
  `update`, or `use`.
