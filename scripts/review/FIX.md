# Fix findings from an author-reviewed report

This session performs corrections only. The author has already read the report
provided in INPUT REVIEW REPORT and may have added notes. Do not perform a new
file review, search for new issues, or load REVIEW.md. Resolve only findings from
the supplied report, following SESSION.md and the applicable AGENTS.md.

## Input and author notes

Read the entire report, including every "Notas pós-revisão" or "Nota pós-revisão"
section, regardless of heading level or position. The supplied content is the
version selected by the orchestrator; SOURCE REPORT and SOURCE SHA256 identify
its origin. Preserve the original report and its notes. Do not replace this input
with another report or search for additional findings in reports from other files,
attempts, or providers.

The repository author writes these notes to identify false positives, explain
intent, assumptions, contracts and context, guide a correction, or indicate that
a fix has already been applied. Associate each note with the relevant findings
before deciding whether to change the code. Re-evaluate the original report's
recommendations in light of these notes.

- Dismiss findings whose premises are invalidated by the notes or current code.
- Incorporate the author's context and correction guidance. Respect explicit
  instructions not to modify a particular behavior.
- If a correction has already been applied, validate it without applying it again.
  Add relevant regression tests when requested in the notes.
- If current evidence contradicts a note, explain the discrepancy and concrete
  failing scenario before treating the finding as confirmed. If the discrepancy
  cannot be resolved, preserve the code and report the point as unconfirmed.
- The absence of notes is not proof that a finding is correct. Confirm the
  reported defect against the current implementation before correcting it.

If no report is supplied, its identity does not match PRIMARY FILE, or it contains
no findings, do not make changes or start a review as a fallback. Report the input
problem and end the session.

## Execution limited to supplied findings

1. Read the current primary file and only the dependencies, contracts and tests
   needed to understand and confirm the supplied findings.
2. For each finding, decide whether to fix it, dismiss it as a false positive,
   recognize it as already fixed, or leave it unconfirmed/unresolved.
3. For confirmed findings, apply the smallest necessary correction, preserving
   APIs, units, reference frames, conventions and behavior explained by the author.
4. Follow SESSION.md's validation and per-finding commit workflow. Complete one
   finding before editing the next. Correct lint, type, formatting and test
   failures introduced by your fix and rerun the affected checks before committing;
   these repairs belong to the same finding and do not require a new review.
   Do not end the session merely because a validation check failed. Do not create
   empty commits.

Confirming a finding means checking its scenario and premises. It does not
authorize repeating a general technical review. If an independent issue becomes
apparent incidentally, do not fix it in this session. Record it separately for
future author review without adding it to the authorized correction list.

## Execution report

Report the input report's path and hash. For each original finding, retain its
identifier or title and provide:

- decision: fixed, false positive, already fixed, or unconfirmed/unresolved;
- rationale, including how the author's notes affected the decision;
- validation performed and any limitations;
- commit hash, if this session made a change.

List incidental issues separately, solely for future review. Do not copy the
entire input report or its REVIEW_TRAILER. End with one output trailer using
MODE `fix`, as specified in SESSION.md. Its `findings` field counts only confirmed
defects from the original report that remain unresolved; false positives and
resolved findings are excluded.
