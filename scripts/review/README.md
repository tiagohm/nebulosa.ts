# Per-file review with TypeScript and Bun

Run `bun run review` on Linux or Windows. The orchestrator starts one fresh,
independent process per file, sequentially. Providers are `grok` (the default)
and `codex`; install the chosen CLI on PATH and authenticate before real sessions.
For Codex, use `codex login`. Planning, status and help do not need either CLI
and never create state, locks or artifacts, even when combined with `--fix`,
`--force` or `--refresh-list`.

## Usage

```sh
bun run review --help
bun run review --dry-run
bun run review --provider grok --limit 1
bun run review --provider codex --limit 1 src/math/units/angle.ts
bun run review --provider codex --fix --timeout 1800 src/math/units/angle.ts
bun run review --provider codex --fix --reports .reviews/grok/review/reports --dry-run
bun run review --provider codex --status src/math/units/angle.ts
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
Use a commented path to persist an exclusion across `--refresh-list`; deleting
a line alone does not retain that exclusion when the list is regenerated.

Grok defaults are 60 turns, `high` effort, no timeout and no subagents. Use
`--max-turns`, `--effort`, `--model`, `--timeout` and `--allow-subagents` to
override them. `--limit 0` means unlimited pending sessions. Unknown options,
missing arguments, invalid numbers and explicitly unsupported provider options
are rejected.

Codex inherits the model and reasoning effort from its existing CLI configuration
unless `--model` or `--effort` is supplied. Subagents and timeout are disabled by
default; `--allow-subagents` and `--timeout` enable them. Codex does not support
`--max-turns`, so explicitly passing it is an error. Use `--timeout` to bound a
Codex session. CLI argument compatibility was checked against Codex 0.153.4.

`--status` reports completed, failed, skipped, existing-artifact and remaining counts
for the selected files. Review progress is scoped to the provider; fix progress is
shared across providers. A completed entry or a successful report skips the file
unless `--force` is supplied. Reports without completion metadata or a valid
trailer are preserved unless failure metadata identifies an unsuccessful attempt.
Prompts, raw logs and stderr never block retries. Dry runs use the same selection.

`--force` permits a new session and replacement of its artifacts. It removes the
previous completion **before** attempting each file. Missing source files are
recorded in `SKIPPED.txt` during real batches. Failed, incomplete and interrupted
sessions produce no report and remain pending without `--force`. Diagnostics are
retained until the next attempt replaces them. Legacy reports marked failed or
interrupted in progress/history are also retried automatically.

## Fix mode

Review and fix are separate stages. First run review, read its reports, and add
"Notas pós-revisão" (or "Nota pós-revisão") wherever findings need context,
correction guidance or dismissal as false positives. Then run `--fix`:

```sh
bun run review --provider grok
# Read and annotate .reviews/grok/review/reports/*.md.
bun run review --provider codex --fix --reports .reviews/grok/review/reports --dry-run
bun run review --provider codex --fix --reports .reviews/grok/review/reports
```

The input directory defaults to `.reviews/<provider>/review/reports/`.
`--reports PATH` overrides it, resolves from the invocation directory and requires
`--fix`. Only that directory's Markdown files are considered, without recursively
searching other providers or modes. The normal file list and positional arguments
still restrict which source files are eligible.

Reports are matched by the exact normalized `file` in their unique REVIEW_TRAILER,
not by filename. Input reports need `mode: review`, a nonnegative integer `findings`
and a boolean `incomplete`. Reports without a unique identity trailer are skipped
with a warning naming the report; add valid metadata to make them usable as fix
inputs. Invalid metadata in an identified, selected file's report aborts selection
with the report path rather than silently falling back to another report.
The latest modification time wins when several reports identify the same source
file; the lexically greatest path breaks ties. Editing notes intentionally updates
that report's selection priority. To choose a different set explicitly, copy only
the reports you intend to process into a directory and pass it with `--reports`.

Selection occurs before sessions start. `--dry-run`, `--status` and real sessions
show the selected report paths; pending fix sessions also show their SHA-256 hashes.
The batch keeps the selected content as a snapshot and embeds it verbatim in each
fix prompt, including all author notes. Finish editing notes before starting the
batch. A missing directory or report, zero findings, or `incomplete: true` skips
the source file without starting a provider. A newer clean or incomplete report
does not fall back to an older report with findings.

Fix uses `SESSION.md` + `FIX.md` + the supplied report. It does not load `REVIEW.md`,
perform a new review or search for additional findings. It checks each original
finding against the current code and author notes, then fixes, dismisses, recognizes
an existing correction, or records an unresolved point. The output maps every
original finding to its decision, validation and any commit. Original reports and
notes are preserved; successful outputs are saved in `.reviews/fix/reports/`.
The fix output's `findings` count includes only confirmed original defects that
remain unresolved, excluding dismissed and resolved findings.
The saved prompt records the input path, hash and full snapshot for traceability.

Fix completion is shared per source file. Changing `--provider` continues with
the pending files; keep `--reports` pointing at the same input directory when the
reports belong to another provider. On first use, successful entries from existing
`.reviews/<provider>/fix/COMPLETED.txt` lists are imported into the shared state.
Dry runs and status preview this import without writing. Legacy files are retained;
once the shared completion list exists, it is authoritative, including after a
failed forced retry. If you change the input report or notes after a completed fix,
use `--force` to process that file again. `--force` does not bypass report
eligibility or start a new review.

Real `--fix` batches require a clean worktree. After acquiring the repository lock,
the orchestrator runs `git status --porcelain=v1 -z --untracked-files=all` before
starting sessions. Staged changes, unstaged changes, conflicts and untracked files
block the batch; ignored files do not. Blocking paths are printed. Git failures
also abort startup. There is no automatic stash, reset or cleanup.

Each fix session must validate and create **one local commit per corrected
finding**, finishing that commit before editing the next finding. This applies
even when multiple findings affect the same source file. The session follows the
applicable `AGENTS.md`: imperative English subject, required explanatory body,
blank-line separators and the authoring agent's `Co-Authored-By` trailer. It stages
explicit paths, reviews the staged diff, uses a temporary message file with
`git commit -F`, reads the message back and reports each finding's commit hash.
Clean files and findings that cannot safely be fixed do not get empty commits.

The orchestrator also checks the worktree after a successful fix session. Leftover
staged, unstaged or untracked changes make the session incomplete and stop the
batch before the next file. This catches fixes whose commits were not completed.
Previously created commits remain intact. Partial edits after a failure are
preserved; handle them before restarting `--fix`, since the clean-start check
still applies. Sessions must repair lint, type, formatting and test failures
introduced by their own changes, then rerun the affected checks before committing
or moving to the next finding. This includes validation failures from commit
hooks. A failed check alone does not end the session. Unrelated pre-existing or
environment failures follow AGENTS.md's verification policy. An unresolved blocker
after diagnosis and reasonable repair attempts, or a non-validation commit
failure, stops the session with an explanation of the remaining work. Sessions
must never commit introduced failures, weaken checks to pass, amend, squash,
rebase, rewrite existing commits or push.

Review mode never stages or commits. Review mode, dry runs, status and help do
not require a clean worktree. The orchestrator does not combine all fixes into
a file-level commit; the session owns the per-finding validation and commits.

Grok uses `--sandbox off` in both modes. The workspace Landlock profile cannot
write `~/.cache/codebase-memory-mcp`, so headless graph MCP handshakes fail with
`connection closed: initialize response`. Review mode still denies `Bash(git *)`
and the `search_replace`/`write` tools.

Codex uses `read-only` sandboxing in review mode. In fix mode it uses
`danger-full-access`, because workspace sandboxing protects `.git` and prevents
unattended commits. **Codex fix commands therefore run without a filesystem or
network sandbox.** Both modes set `approval_policy="never"`; the shared prompt
limits fixes to the reviewed findings and forbids pushes and history rewriting.
Existing Codex authentication, model configuration and MCP integrations are kept.
Managed CLI restrictions still apply; a denied invocation fails and remains pending.

## Results and state

```text
[1/3] OK: src/math/units/angle.ts | turns=12 | cost=US$0.042 | findings=2
```

Every session prints its outcome, file and all available metrics, including on
errors, incomplete results and interruptions. Zero values are shown; absent
metrics are omitted. Grok supplies `turns` from `num_turns`, `costUsd` from
`total_cost_usd`, and `findingsCount` from a unique `REVIEW_TRAILER` whose `file`
and `mode` match the session and whose `findings` is a nonnegative safe integer.
Invalid or missing output trailer data only omits the findings metric. Reusing a
review report as fix input requires the identity, findings and incomplete metadata
described above; successful review completion alone does not make it eligible.

Codex supplies the same optional findings metric from its last completed
`agent_message`. Its JSONL protocol exposes token usage and top-level turn events,
but no model-call count or dollar cost; `turns` and `costUsd` are therefore omitted
instead of estimated. The thread ID from `thread.started` is saved as the session ID.

Completion retains the previous parser's rules: Grok errors and malformed JSON
fail; `max_turn_requests`, `max_tokens` and `cancelled` are incomplete. Other JSON
object results complete when the process exits successfully. A trailer is not
required for completion; its `incomplete` and `verdict` fields do not override the
provider's stop reason. Nonzero process exits and timeouts cannot complete a file.

Codex parses stdout incrementally as JSONL. Completion requires `turn.completed`
and a nonempty agent message in that turn. `turn.failed` and top-level `error`
events fail the session even if a partial report exists. Empty or malformed JSONL
fails; a stream missing its completion event or final message is incomplete.
Individual tool failures do not decide the review outcome; Codex can recover
from them within the session. Partial output remains available in raw logs.

New state is independent of legacy `.grok-reviews/`, which is neither imported
nor deleted. `.reviews/` is gitignored. Review progress is provider-specific;
fix progress is shared.

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
  codex/
    review/
      ...
  fix/
    COMPLETED.txt
    FAILED.txt
    SKIPPED.txt
    USAGE.tsv
    prompts/
    logs/
    reports/
    stderr/
```

Lists contain normalized paths, one per line; tabs, newlines and NUL in filenames
are rejected. Report names use the entire sanitized source path:
`src/io/xml.ts` becomes `reports/src_io_xml.ts.md`. Slashes, spaces and characters
forbidden in Windows filenames become `_`; periods, hyphens and Unicode remain.
Selected source paths that would collide after sanitization abort the batch.

Prompts, raw logs and stderr use the same sanitized name with their respective
extensions: `prompts/src_io_xml.ts.md`, `logs/src_io_xml.ts.json` and
`stderr/src_io_xml.ts.log`. There are no hashes or attempt IDs in artifact names.
Pending attempts replace their diagnostic files while holding the repository lock.
Only `--force` repeats completed work. A retry invalidates the previous completion
and removes any old report before starting the provider.
Codex logs contain JSONL, even though log artifact filenames use `.json`.
`USAGE.tsv` stores file, mode, outcome, stop reason, optional metrics, session ID
and the log basename. Empty cells mean absent values; backslashes and control
characters in TSV fields are escaped as `\\`, `\t`, `\r` and `\n`.
The prompt, stdout, stderr, successful report and usage history are saved before completion.
Progress lists are replaced using a temporary file and rename.

The first error, incomplete session (including an exhausted turn/token limit) or
timeout stops the batch with exit code `1`. The current file is not completed;
run again without `--force` to retry it. Later files are not started.
Logs, optional metrics and failure history remain available for diagnosis; an
unsuccessful attempt does not create a report. `--limit` simply ends the batch after the requested number of
sessions and is not a session failure.
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

Regeneration updates eligible files in domain order while keeping previously
commented paths disabled. Disabled paths remain in the list even when their files
are temporarily missing, so a later refresh cannot silently reactivate them.
New eligible files are added as active entries. Regeneration acquires the
repository lock and does not start a provider. Normal selection never rewrites
the list. `--help`, `--status` and `--dry-run` take precedence over regeneration,
in that order.

Both modes use `SESSION.md` (scope, execution and per-finding commit rules).
Review adds `REVIEW.md` (domain review criteria); fix adds `FIX.md` (report-driven
correction instructions) and the selected report with author notes. Each prompt
ends with a mode-specific current-file footer. Grok receives
it through `--prompt-file` and `--verbatim`. Memory and auto-updates are disabled.
Subagents use both `--no-subagents` and `GROK_SUBAGENTS=0` by default; allowing them
removes the flag and sets `GROK_SUBAGENTS=1`. Grok uses `--sandbox off` so the graph
MCP can handshake; approval policy is kept.
`Bash(git *)` denial and editing-tool restrictions apply only to
review mode; fix mode permits the Git commands required to inspect, stage and
commit each finding. Remote operations and history rewriting remain prohibited
by the shared session instructions.

Codex receives the same prompt through stdin (`codex exec ... -`) to preserve
spaces, Unicode and long prompts without shell interpolation. Each invocation
uses `--json`, `--ephemeral` and `--color never`; it never resumes another thread.
Memory and unbounded connection retries are disabled. Subagents are disabled
unless `--allow-subagents` is supplied. The last completed agent message becomes
the report; no provider-specific prompt or trailer requirement is introduced.

Codex protocol and configuration references:
[non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode),
[CLI commands](https://learn.chatgpt.com/docs/developer-commands?surface=cli),
[permissions](https://learn.chatgpt.com/docs/permissions).

## Components and future providers

`ReviewOrchestrator` composes `ReviewProvider`, `BunProcessRunner`,
`ReviewStateStore`, `ReviewFileList` and `ReviewPromptBuilder` through constructors.
`ReviewReportStore` selects and snapshots fix inputs before session execution.
`GrokReviewProvider` and `CodexReviewProvider` own their arguments, environment
and result parsing. Both use the shared trailer metric parser.
There is no Bash entry point or parser subprocess.

To add another provider, implement `ReviewProvider` and add it to the registry in
`review.ts`. Declare supported options and defaults, prepare an executable,
argument array, environment and optional stdin in `prepareSession(request)`, and
return the report, classification, stop reason, session ID and optional metrics
from `parseResult(artifacts)`. The central session flow does not inspect provider
formats or require changes for a new provider.

Runtime APIs: [Bun.spawn](https://bun.sh/docs/runtime/child-process),
[Bun Shell](https://bun.sh/docs/runtime/shell) for Git, and
[Bun file I/O](https://bun.sh/docs/runtime/file-io). Native Bun-compatible modules
handle paths, exclusive lock creation, directories and atomic rename.
