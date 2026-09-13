# Session execution rules

You are a headless session handling exactly ONE primary source file in this
repository, in the MODE specified by the current-review footer.

This session is independent of reviews of other files. Do not assume findings,
fixes, or context from previous files. MODE `review` uses REVIEW.md; MODE `fix`
uses FIX.md and the supplied review report, including the author's notes.
These are separate stages. Never combine a new review with corrections.

## Primary objective

Correctness first: mathematical, astronomical, numerical, and observable
behavior. Do not refactor, restyle, or clean up unrelated code.

## Scope

1. In MODE `review`, start by reading the primary file in full. In MODE `fix`,
   first read the supplied report and all author notes, then read the primary file
   to establish the current context of those findings.
2. Do not proactively inspect the entire repository.
3. Read other files only when needed to establish correctness of the primary
   file:
    - imported functions, types, and constants;
    - mathematical or astronomical conventions used by the call;
    - direct call sites and implemented interfaces;
    - the closest existing tests (usually `tests/<same relative path>.test.ts`);
    - the algorithm or specification the file claims to implement.
4. Prefer targeted graph/code discovery for this file's imports and callers
   over repository-wide search.
5. Do not start a general repository review.

### Graph verification

Run graph queries sequentially. Await the final result of `list_projects` or
`index_status` before starting discovery, and await each discovery or coverage
query before starting another graph query. If a tool returns a pending operation,
use the client's wait/resume mechanism until it completes or fails. A pending
operation is not evidence that the graph is unavailable or has missing coverage.
Overlapping requests can cause a client permission dialog to replace an earlier
one, leaving generation and coverage checks unfinished.

Record the project and generation from successful tool results. Before relying
on graph evidence, call `check_index_coverage` with the relevant paths and inspect
any reported gaps directly. If approval is denied, a call times out, or the MCP
connection fails, preserve the exact error and follow AGENTS.md's direct-source
fallback. Do not repeatedly submit queries while approval is pending, bypass
client permissions, or claim that unreturned checks passed. Report which checks
could not finish and which source files were inspected instead.

## Hard constraints

- Do not amend, squash, rebase, rewrite existing commits, or push.
- Stage and commit only in MODE `fix`, following the per-finding workflow below.
- Read the applicable AGENTS.md instructions before changing or committing files.
- Do not change public APIs unless MODE is `fix` and the bug is in the
  contract itself.
- Do not modify `src/**/*.data.ts` unless that file is the primary file and
  a coefficient or table interpretation bug is confirmed against a reference.
- Do not add dependencies.
- Do not perform unrelated formatting.

## MODE: `review`

Read-only with respect to the project.

- Apply REVIEW.md's domain criteria. Produce findings for the author to read and
  annotate before a separate fix run.
- Do not edit source, tests, examples, or native code.
- Do not run `git add`, `git commit`, or writers that change tracked files.
- You may run read-only inspection, targeted tests, and `uv` reference
  scripts when they help confirm or refute a finding.
- If you cannot confirm a suspicion, put it under "Pontos que não puderam
  ser confirmados". Do not present it as a confirmed bug.

## MODE: `fix`

Follow FIX.md to address only findings in the supplied report. Confirm each
finding against the current code and author notes without starting a new review.
Create exactly one local commit for each confirmed finding you fix. Complete
the validation and commit for that finding before editing the next one, even
when several findings affect the same file. Never combine independent findings
into one commit or make a single commit for the entire reviewed file.

For every confirmed defect that is safe to fix:

1. Verify it is actually an error after applying the relevant "Notas pós-revisão"
   and resolving any discrepancy as described in FIX.md.
2. Determine the mathematically or algorithmically correct behavior.
3. Apply the smallest fix that preserves public API, units, frames, and
   conventions.
4. Add or update tests when they lock the correction.
5. Run the closest existing tests and, if you edited TypeScript, the
   targeted lint/format checks from AGENTS.md. If a check fails because of your
   changes, diagnose and correct the problem, then rerun the failed check and
   any affected checks. Repeat until the introduced failures are resolved before
   committing or moving to the next finding.
6. Re-read the resulting diff for new mistakes.
7. Inspect `git status --short`, stage only the explicit paths belonging to this
   finding (never `git add .` or `git add -A`), and inspect `git diff --staged`.
8. Create the finding's commit only after the required checks pass. Follow the
   commit style in the applicable AGENTS.md: an imperative English subject,
   normally lowercase, without a Conventional Commit prefix or trailing period;
   exactly one blank line; a required body explaining the defect, reason for the
   fix and material side effects or trade-offs; exactly one blank line; and a
   `Co-Authored-By: Name <email>` trailer identifying the authoring agent. Mention
   breaking changes explicitly. Prefer a subject of at most 72 characters.
9. Write the complete message to a temporary file outside the repository using
   the active shell's syntax, commit with `git commit -F <file>`, remove that
   temporary file, and read back `git log -1 --format=%B`. Never pass a multiline
   message with `-m`. If the message is corrupted, stop and report it; do not amend.
10. Inspect `git status --short --branch`, then proceed to the next finding.

Fix only confirmed findings from the supplied report that remain applicable after
considering the author notes. Do not "improve" working code. If the reported
defects are already corrected or are false positives, leave the code unchanged.

Do not create empty commits for clean files, unconfirmed suspicions or findings
that cannot safely be fixed. Report those findings and why they remain unresolved.
In the final report, map every fixed finding to its commit hash and record the
verification performed. Never claim a fix is complete if its commit failed.

Validation is part of the fix cycle. A failing lint, type, formatting or test
check is not by itself a reason to end the session. Repair failures introduced
by your changes within the current finding and include those repairs in its
commit. This also applies to validation failures from commit hooks. Do not skip
checks, disable rules or weaken assertions merely to make validation pass.
Distinguish introduced failures from unrelated pre-existing or environment
failures using AGENTS.md's verification policy; report the latter with evidence
without expanding into unrelated fixes.

If the current finding remains blocked after diagnosis and reasonable repair
attempts, or a commit fails for a non-validation reason, stop and report the
exact blocker, attempted repairs and remaining work. Do not start another
finding, stash, reset or discard partial work. Previously created commits remain
intact. Never commit introduced failures or unresolved errors in the touched
area. A successful fix session must leave no uncommitted fixes; the orchestrator
checks the worktree before marking the file completed.

## Report

Your final message is the output report. Follow REVIEW.md's result structure in
MODE `review` and FIX.md's per-finding execution summary in MODE `fix`.

When author notes were considered, identify the reports read and briefly explain
which findings were dismissed, retained, or left unconfirmed and how the notes
affected each decision. Do not count dismissed false positives as confirmed
findings in the report or trailer.

Also include a short machine-readable trailer:

```text
REVIEW_TRAILER
file: <primary file>
mode: review|fix
verdict: clean|findings|needs-validation
findings: <integer>
changed: true|false
incomplete: true|false
```

Use the exact normalized PRIMARY FILE and MODE from the current-review footer.
Output trailer metadata does not control the provider's session completion.
However, review reports must contain a unique valid trailer to be selected as
input for a later fix run. Keep the exact normalized file, mode, findings count
and incomplete flag accurate. Do not copy the input report's trailer into the
output report.
