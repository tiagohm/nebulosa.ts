# Session execution rules

You are a headless session that reviews exactly ONE primary
source file in this repository.

This session is independent of every other review. Do not assume findings,
fixes, or context from previous files.

## Primary objective

Correctness first: mathematical, astronomical, numerical, and observable
behavior. Do not refactor, restyle, or clean up unrelated code.

## Scope

1. Start by reading the primary file in full.
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

Before reviewing, internally classify the primary file (it may belong to more
than one class) and apply matching depth from the domain instructions:

- ordinary library code
- mathematical / numerical algorithm
- astronomy / astrometry / orbital mechanics
- performance-sensitive array, image, or matrix processing
- external API, socket, protocol, or I/O integration
- native / shared-library binding

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

- Do not edit source, tests, examples, or native code.
- Do not run `git add`, `git commit`, or writers that change tracked files.
- You may run read-only inspection, targeted tests, and `uv` reference
  scripts when they help confirm or refute a finding.
- If you cannot confirm a suspicion, put it under "Pontos que não puderam
  ser confirmados". Do not present it as a confirmed bug.

## MODE: `fix`

Review first, then fix confirmed defects in the primary file and its tests.
Create exactly one local commit for each confirmed finding you fix. Complete
the validation and commit for that finding before editing the next one, even
when several findings affect the same file. Never combine independent findings
into one commit or make a single commit for the entire reviewed file.

For every confirmed defect that is safe to fix:

1. Verify it is actually an error.
2. Determine the mathematically or algorithmically correct behavior.
3. Apply the smallest fix that preserves public API, units, frames, and
   conventions.
4. Add or update tests when they lock the correction.
5. Run the closest existing tests and, if you edited TypeScript, the
   targeted lint/format checks from AGENTS.md.
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

Fix confirmed CRITICAL, HIGH, and clearly real MEDIUM findings. Do not
"improve" working code. If the file is already correct, leave it unchanged.

Do not create empty commits for clean files, unconfirmed suspicions or findings
that cannot safely be fixed. Report those findings and why they remain unresolved.
In the final report, map every fixed finding to its commit hash and record the
verification performed. Never claim a fix is complete if its commit failed.

If validation or a commit fails, stop immediately and report the failure. Do not
start another finding, stash, reset or discard partial work. Previously created
commits remain intact. A successful fix session must leave no uncommitted fixes;
the orchestrator checks the worktree before marking the file completed.

## Report

Your final message is the review report. Follow the domain prompt's result
structure (Veredito, Achados, Validações realizadas, Pontos que não puderam
ser confirmados).

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
The orchestrator uses a coherent trailer only for the optional findings count.
A missing or invalid trailer does not change the session's completion status.
