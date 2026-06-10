# Code Review Instructions

This is a Bun-first, ESM-only TypeScript astronomy library. Review the changes
on the current branch with a **strictly limited scope**. Only report findings
that fall into the categories below. Do not comment on style, naming,
formatting, documentation, test organization, or anything outside this list.

## Review Scope

### 1. Mathematical correctness

- Verify that every formula, equation, and numeric expression is correct.
- Check unit consistency: angles in radians, distances in AU, velocities in
  AU/day, temperature in Celsius, pressure in hPa, unless explicitly documented
  otherwise.
- Confirm sign conventions, coordinate frames, and reference systems are applied
  consistently and correctly.
- Watch for incorrect or leftover conversion factors (e.g. spurious `DEG2RAD`,
  `RAD2DEG`, squared factors) and off-by-constant errors.

### 2. Algorithmic correctness

- Verify the algorithm actually solves the intended problem and produces correct
  results across the full input domain.
- Check edge cases: zero vectors, poles, zenith, wrap-around at `0` and `TAU`,
  degenerate or identity transforms, near-limb / grazing geometry, and boundary
  conditions of iterative solvers.
- Verify convergence criteria, iteration counts, seeds, and termination of any
  Newton/root-finding or iterative steps.

### 3. Best approach for the problem

- Assess whether the chosen approach is the most appropriate and robust for the
  problem, or whether a better-known, more stable, or simpler algorithm exists.
- Flag approaches that are unnecessarily fragile, indirect, or that ignore a
  standard astronomical/geometric technique that would fit better.

### 4. Performance and memory allocation

- Identify unnecessary allocations in hot paths and tight loops.
- Check that mutable vector/matrix output parameters (`o?: MutVec3`, etc.) are
  used where the codebase favors them, and that object churn is avoided.
- Flag redundant trig recomputation (cache `sin`/`cos` when reused), repeated
  work that could be hoisted, and closures created inside tight loops.
- Flag inefficient data structures where a flat numeric / `TypedArray` layout is
  clearly justified.

### 5. Numerical precision

- Verify the precision is acceptable for an astronomy library.
- Flag subtraction of nearly-equal floating-point values where a more stable
  formulation exists.
- Prefer `atan2`-based formulations over `acos` near `0` or `PI`; flag missing
  domain clamping before inverse trig where rounding may push values out of
  range.
- Flag any precision trade-off that is undocumented or unacceptably lossy.

### 6. Possible bugs

- Find logic errors, incorrect conditionals, wrong indices/bounds, swapped
  arguments, uninitialized or stale state, and incorrect handling of optional
  output parameters.
- Find any latent correctness bug not covered above.

## Out of Scope (do not report)

Style, formatting, naming, comments, documentation wording, test layout,
dependency choices, API design, and any concern not in the six categories above.
