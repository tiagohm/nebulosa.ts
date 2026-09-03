# Per-file Grok review

External orchestrator: one fresh `grok -p` process per source file. The
process exits after each file, so the next review does not inherit
conversation history or compaction state.

This is **not** the interactive `/review` skill. That skill reviews a diff
and stays read-only. This pipeline reviews a chosen source file against
the domain instructions in `PROMPT.md`.

## Why this shape

- Independent sessions beat `/new` inside one long TUI conversation.
- `--max-turns` is a fuse, not a token budget. The goal is to finish
  before auto-compaction, not to raise the compaction threshold.
- Memory stays off (`GROK_MEMORY=0`). There is no `--no-memory` flag.
- Subagents stay off by default so one file does not fan out into several
  extra contexts.
- Default mode is **review-only**. Auto-fixing scientific code in the same
  pass is optional (`--fix`) because a false positive can land in the
  shared worktree and affect the next file.

## Usage

```bash
# Planned files (no API calls)
./scripts/review/review.sh --dry-run

# First real trial
./scripts/review/review.sh --limit 1

# Continue later; completed files are skipped
./scripts/review/review.sh

# One file
./scripts/review/review.sh src/math/units/angle.ts

# Apply confirmed fixes after inspecting reports
./scripts/review/review.sh --fix --limit 1 src/math/units/angle.ts

./scripts/review/review.sh --status
```

State lives in gitignored `.grok-reviews/`:

```text
.grok-reviews/
  COMPLETED.txt
  FAILED.txt
  SKIPPED.txt
  USAGE.tsv
  logs/
  reports/
  prompts/
  stderr/
```

Ctrl+C leaves the current file out of `COMPLETED.txt`, so the next run
retries it.

## Flags that matter

| Flag / env                                | Role                                           |
| ----------------------------------------- | ---------------------------------------------- |
| `--no-subagents`                          | One agent per file                             |
| `--max-turns 60`                          | Stop runaway read/search/fix loops             |
| `--always-approve`                        | Required for headless tool use                 |
| `--sandbox workspace`                     | Write reports/state; keep uv and web available |
| `--disallowed-tools search_replace,write` | Review mode cannot edit via tools              |
| `--deny 'Bash(git *)'`                    | Never commit or stage                          |
| `GROK_MEMORY=0`                           | No cross-session memory                        |

`--sandbox read-only` is **not** used: it blocks child network on Linux,
which would break `uv` reference scripts and some web lookups that
astronomy reviews need.

## File list

`FILES.txt` is every `src/**/*.ts` except `*.data.ts`, ordered by domain
(`core`, `math`, `io`, then astronomy and the rest). Comment a line with
`#` to skip it.

```bash
./scripts/review/review.sh --refresh-list
```

## Prompt split

1. `SESSION.md` — one-file scope, no commit, review vs fix.
2. Domain instructions: `PROMPT.md`.
3. A short current-file footer assembled by `review.sh`.

The script passes the assembled prompt with `--prompt-file` and
`--verbatim` so it is not truncated by the shell.

Do not commit automatically. Inspect `git diff` and the report under
`.grok-reviews/reports/` first.
