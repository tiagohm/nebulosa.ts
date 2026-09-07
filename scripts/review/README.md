# Per-file review with TypeScript and Bun

Run `bun run review` on Linux or Windows. The orchestrator starts one fresh,
independent process per file, sequentially. Only Grok is currently registered;
install it on PATH for real sessions. Planning, status and help do not need Grok
and never create state, locks or artifacts, even when combined with `--fix`,
`--force` or `--refresh-list`.

## Usage

```sh
bun run review --help
bun run review --dry-run
bun run review --provider grok --limit 1
bun run review
bun run review src/math/units/angle.ts
bun run review --fix --limit 1 src/math/units/angle.ts
bun run review --fix --status src/math/units/angle.ts
bun run review --files "my review list.txt" --limit 0
```

Positional files override `--files`. Review paths resolve from the repository
root; absolute paths inside the repository, native separators, spaces and Unicode
are supported. Paths are stored relative to the root with `/` separators and
deduplicated in selection order. `--files` resolves from the invocation directory.
Lists accept comments starting with `#` (optionally indented), blank lines and
CRLF. Reading a list leaves its contents, including commented selections, intact.

Grok defaults are 60 turns, `high` effort, no timeout and no subagents. Use
`--max-turns`, `--effort`, `--model`, `--timeout` and `--allow-subagents` to
override them. `--limit 0` means unlimited pending sessions. Unknown options,
missing arguments, invalid numbers and explicitly unsupported provider options
are rejected.

`--status` reports completed, failed, missing and remaining counts for the selected
files in the chosen provider and mode. `--force` retries completed files and removes
the previous completion **before** attempting each file, so an interrupted retry
stays pending. Missing files are recorded in `SKIPPED.txt` during real batches.

## Fix mode

Real `--fix` batches require a clean worktree. After acquiring the repository lock,
the orchestrator runs `git status --porcelain=v1 -z --untracked-files=all` before
starting sessions. Staged changes, unstaged changes, conflicts and untracked files
block the batch; ignored files do not. Blocking paths are printed. Git failures
also abort startup. There is no automatic stash, reset, cleanup or commit.

This check happens only at batch start. Fixes from one session remain available
to subsequent sessions. Review mode, dry runs, status and help do not require a
clean worktree. Sessions are instructed never to stage, commit, amend, rebase or
push. Inspect the resulting changes and reports yourself.

## Results and state

```text
[1/3] OK: src/math/units/angle.ts | turns=12 | cost=US$0.042 | findings=2
```

Every session prints its outcome, file and all available metrics, including on
errors, incomplete results and interruptions. Zero values are shown; absent
metrics are omitted. Grok supplies `turns` from `num_turns`, `costUsd` from
`total_cost_usd`, and `findingsCount` from a unique `REVIEW_TRAILER` whose `file`
and `mode` match the session and whose `findings` is a nonnegative safe integer.
Invalid or missing trailer data only omits the findings metric.

Completion retains the previous parser's rules: Grok errors and malformed JSON
fail; `max_turn_requests`, `max_tokens` and `cancelled` are incomplete. Other JSON
object results complete when the process exits successfully. A trailer is not
required for completion; its `incomplete` and `verdict` fields do not override the
provider's stop reason. Nonzero process exits and timeouts cannot complete a file.

New state is independent of legacy `.grok-reviews/`, which is neither imported
nor deleted. Both directories are gitignored.

```text
.reviews/
  lock
  grok/
    review/
      COMPLETED.txt
      FAILED.txt
      SKIPPED.txt
      USAGE.tsv
      prompts/
      logs/
      reports/
      stderr/
    fix/
      ...
```

Lists contain normalized paths, one per line; tabs, newlines and NUL in filenames
are rejected. Artifact names combine a Windows-safe basename, a SHA-256 path hash
and a unique attempt ID. Previous attempt artifacts remain available.
`USAGE.tsv` stores file, mode, outcome, stop reason, optional metrics, session ID
and the log basename. Empty cells mean absent values; backslashes and control
characters in TSV fields are escaped as `\\`, `\t`, `\r` and `\n`.
The prompt, stdout, stderr, report and usage history are saved before completion.
Progress lists are replaced using a temporary file and rename.

Errors, incomplete sessions and timeouts remain pending; the batch continues.
SIGINT/Ctrl+C and SIGTERM cancel the batch, preserving partial output and leaving
the interrupted file pending. Exit codes are `0` for no failures, `1` for failures,
`130` for interruption and `143` for termination.

Timeout and cancellation terminate the process tree. On Linux, each session has
its own process group: TERM is followed by KILL after a grace period of up to
15 seconds, including when the leader exits before its descendants. On Windows,
Bun starts `taskkill /T /F` with a hidden window. Output is written directly to
files, and cleanup finishes before the lock is released.

## Lock recovery

The exclusive `.reviews/lock` covers all providers and modes. It records the PID,
owner ID and start timestamp. Normal completion and handled failures release it.
An abrupt shutdown or forced kill can leave it behind. Read the lock, verify that
its owner is no longer running and stop any surviving review descendants, then
manually delete **only** `.reviews/lock`. Do not delete an active lock; there is no
automatic stale-lock takeover or legacy-state cleanup.

## File list and prompts

`FILES.txt` groups `src/**/*.ts` by domain (`core`, `math`, `io`, `astronomy`,
`imaging`, `astrometry`, `catalogs`, `bindings`, `devices`, `adapters`,
`observation`), sorts paths deterministically and excludes `*.data.ts`.

```sh
bun run review --refresh-list
```

Regeneration replaces the default list with all eligible files, including those
previously commented out. It acquires the repository lock and does not start a
provider. Normal selection never rewrites the list. `--help`, `--status` and
`--dry-run` take precedence over regeneration, in that order.

The shared prompt combines `SESSION.md` (scope, review/fix rules, no commits),
`PROMPT.md` (domain review criteria), and the current-file footer. Grok receives
it through `--prompt-file` and `--verbatim`. Memory and auto-updates are disabled.
Subagents use both `--no-subagents` and `GROK_SUBAGENTS=0` by default; allowing them
removes the flag and sets `GROK_SUBAGENTS=1`. The existing workspace sandbox,
approval policy, `Bash(git *)` denial and review-only tool restrictions are kept.

## Components and future providers

`ReviewOrchestrator` composes `ReviewProvider`, `BunProcessRunner`,
`ReviewStateStore`, `ReviewFileList` and `ReviewPromptBuilder` through constructors.
`GrokReviewProvider` owns its arguments, environment and JSON/trailer parsing.
There is no Bash entry point or parser subprocess.

To add Codex CLI later, implement `ReviewProvider` and add it to the registry in
`review.ts`. Declare supported options and defaults, prepare an executable,
argument array, environment and optional stdin in `prepareSession(request)`, and
return the report, classification, stop reason, session ID and optional metrics
from `parseResult(artifacts)`. The central session flow does not inspect provider
formats or require changes for a new provider.

Runtime APIs: [Bun.spawn](https://bun.sh/docs/runtime/child-process),
[Bun Shell](https://bun.sh/docs/runtime/shell) for Git, and
[Bun file I/O](https://bun.sh/docs/runtime/file-io). Native Bun-compatible modules
handle paths, exclusive lock creation, directories and atomic rename.
