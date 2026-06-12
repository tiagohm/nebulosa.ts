# AGENTS.md

## Overview

Nebulosa is a Bun-first, ESM-only TypeScript astronomy library.

The codebase is intentionally flat and module-oriented. Most numerical and coordinate work lives in top-level `src/*.ts` files, while protocol and device integrations also follow the same flat naming scheme with dot-separated domains such as `alpaca.*`, `firmata.*`, `image.*`, `indi.*`, and `star.*`.

## Code Discovery

This repository uses `codebase-memory-mcp`.

Prefer the MCP graph tools for code discovery:

1. `search_graph` for locating functions, classes, and types.
2. `trace_path` for callers, callees, and impact analysis.
3. `get_code_snippet` for reading exact symbols after discovery.
4. `query_graph` for broader structural queries.
5. Fall back to `rg` only for string literals, config files, shell scripts, or when graph results are insufficient.

## Repository Map

- `src/*.ts`: library source files. Keep new code here and preserve the existing flat file layout.
- `src/*.data.ts`: large static numeric tables. Do not rewrite, reformat, or regenerate them unless the task explicitly requires it.
- `tests/*.test.ts`: Bun tests, usually mirroring source module names.
- `tests/setup.ts`: Bun preload for the whole test suite. It prepares shared test state and fixture-backed resources.
- `tests/download.ts`: downloads missing fixtures into `data/` from GitHub when tests need them.
- `data/`: test fixtures such as FITS, XISF, SPK, catalogs, and Earth orientation files.
- `examples/`: runnable usage examples. Update these when a public API or workflow changes.
- `native/`: native/runtime support used by `postinstall`. Treat changes here as high-risk.
- `README.md`: public API documentation. Update it when exported behavior or examples change.
- `main.ts`: not the main implementation surface of the library. Prefer editing `src/` and `tests/`.

## Project Structure Rules

- Do not create new top-level directories.
- Keep the existing flat file organization in `src/` and `tests/`.
- Prefer the current dot-separated filename style for new modules, for example `image.processing.ts` rather than nested folders.
- Prefer direct module imports over adding new barrel files unless the task explicitly requires an aggregated entrypoint.
- Preserve the existing relative import style without `.ts` extensions.

## Tooling

- Use **Bun** for install, scripts, and tests.
- Format: `bun run fmt`
- Format check: `bun run fmt:check`
- Lint and Type-check: `bun run lint`
- Lint with fixes: `bun run lint:fix`
- Refresh codebase graph: `bun run index`
- If tests are added, prefer `bun test` before introducing another test runner.
- Tests run through Bun with `bunfig.toml` configured to use `tests/` as the test root and `tests/setup.ts` as preload.
- Some tests depend on large fixtures in `data/`, and missing fixtures may trigger downloads through `tests/download.ts`.
- DO NOT use `bun run compile` as fallback to linting.

## Verification Workflow

- All changes must leave the touched area with zero TypeScript errors, passing related tests, and no obvious performance regression.
- Always run the most relevant targeted tests for the files you changed.
- Run `bun run lint` after TypeScript changes.
- Prefer targeted test commands such as `bun test tests/vec3.test.ts` before considering broader runs.
- If a touched feature is fixture-backed, verify with the closest real test rather than only unit-level smoke checks.
- If network or fixture availability prevents full verification, state that explicitly.

## Formatting And Style

- Follow OXC formatting: tabs, single quotes, no semicolons, trailing commas, long line width.
- Preserve existing `// oxfmt-ignore` comments when they are there for a reason, especially around very long grouped imports.
- Follow the current comment style: descriptive double-slashed comments above exported functions, methods, and numerically important lines.
- When commenting a function or method, include the description and document each parameter with its description plus possible values, units, or valid ranges when constrained or domain-specific.
- Multi-line comments are always double-slashed.
- Do not add noisy comments for obvious assignments or control flow.
- Always type method and function parameters.
- Avoid `any`. Use `unknown` when a type truly cannot be expressed more precisely.
- Functions should not declare explicit return types for primitives or tuples unless needed for branded primitive types. Prefer inference or `as const` where appropriate.
- Functions should declare explicit return types for structured objects and public interfaces.
- Prefer `interface` for structured public shapes.
- Comment every interface property with its description. For numeric properties, include units and possible range values when the range is bounded or domain-specific. Place the comment next to property.
- Use `readonly` where it helps preserve API intent without fighting the existing tuple and mutable-output patterns.
- Use tuple aliases and readonly aliases for low-level numeric structures such as vectors and matrices.

## Code Patterns To Preserve

- Most math-heavy modules use top-level pure functions, not classes.
- Classes are mainly used for protocol clients, simulators, device managers, and stateful integrations such as Alpaca, INDI, and Firmata.
- When applied, use the shared validators in `src/validation.ts` for runtime input validation. Before adding inline validation logic, check whether an existing helper fits; if a reusable validation is missing, add it to `src/validation.ts` and cover it with tests.
- Do not add validation for function parameters, object properties, or interface fields unless it is truly required for the algorithm to work correctly. Prefer interface property comments, including units and valid ranges, as the guidance for callers to pass correct values.
- Preserve the mutable-output convention in hot paths: many vector and matrix helpers accept an optional output parameter such as `o?: MutVec3` or `o?: MutMat3`.
- Reuse existing low-level utilities from `vec2.ts`, `vec3.ts`, `mat3.ts`, `math.ts`, `time.ts`, and related core files before introducing new helpers.
- Preserve the `MutX` plus `Readonly<MutX>` pattern for numeric tuples.
- Prefer top-level helper functions over local closures when performance matters.

## Numerical Rules

- Angle units are radians unless explicitly documented otherwise.
- Distance units are AU unless explicitly documented otherwise.
- Velocity units are AU/day unless explicitly documented otherwise.
- Temperature units are degrees Celsius unless explicitly documented otherwise.
- Pressure units are millibar (`hPa`) unless explicitly documented otherwise.
- Avoid unnecessary trig recomputation. Cache `sin` and `cos` values locally when used more than once.
- Avoid subtracting nearly equal floating-point values when a more stable formulation exists.
- Prefer stable `atan2`-based formulations over `acos` when precision near 0 or `PI` matters.
- Clamp inputs before inverse trig when rounding error may push values slightly outside the valid domain.
- Normalize vectors explicitly when required, using `vecNormalize` or `vecNormalizeMut`.
- If you introduce a precision trade-off, document it in the code comment nearest to the implementation.

## Performance Rules

- Avoid unnecessary allocations inside hot paths.
- Prefer mutable vector and matrix utilities when performance is important.
- Avoid object churn and dynamic object reshaping in tight loops.
- Prefer flat numeric structures over nested objects for high-volume calculations.
- Prefer `TypedArray` only when the data size or access pattern justifies it.
- Do not replace tight numeric loops with functional abstractions if that adds overhead.
- Avoid closures in tight loops.
- Avoid JSON operations in performance-sensitive code.

## Runtime Boundaries

- Keep low-level math, coordinate, ephemeris, and transformation modules portable and lightweight.
- Avoid introducing Bun-only or Node-only APIs into core numerical modules unless the file is already runtime-specific.
- Runtime-specific integrations such as I/O, device protocols, downloads, and simulators may use Bun, `Buffer`, timers, `fetch`, and `fs/promises` where consistent with the existing file.
- Before adding a dependency, verify Bun compatibility and prefer internal utilities first.

## Tests

- Add or update tests in the closest existing `tests/*.test.ts` file whenever possible.
- Mirror existing test style with Bun's `test` and `expect`.
- Use `toBeCloseTo` or explicit tolerances for floating-point assertions.
- Only use strict equality for floating-point results when the result is guaranteed exact.
- Cover edge cases that matter for astronomy and geometry code, such as zero vectors, pole and zenith cases, wrap-around at `0` and `TAU`, and degenerate or identity transforms.
- Reuse existing fixtures from `data/` instead of embedding large blobs in tests.

## Change Management

- Minimize new dependencies.
- Avoid heavy math libraries unless absolutely necessary.
- Keep public API shapes stable unless the task explicitly requires a breaking change.
- If you change exported behavior, update the relevant tests, examples, and README snippets in the same task.
- The commit message must be in English and entirely in lowercase letters, except for acronyms and file names.
- The commit message should begin with a present-tense verb such as `implement`, `fix`, `improve`, `update`, or `use`.

# Code Review Instructions

This is a Bun-first, ESM-only TypeScript astronomy library. Review the changes on the current branch with a **strictly limited correctness scope**.

Only report findings that fall into the categories below. Do **not** comment on style, naming, formatting, documentation wording, test organization, dependency choices, API design, or any concern outside this list.

A finding must be:

- actionable;
- tied to a concrete correctness, numerical, algorithmic, performance, or memory issue;
- supported by code evidence;
- relevant to the changed code or to code directly affected by the change.

Do not report speculative preferences, cosmetic improvements, or alternative designs unless the current implementation is demonstrably incorrect, fragile over the valid input domain, or materially less robust than a standard approach for the same astronomical/geometric problem.

## Review Scope

### 1. Mathematical correctness

Verify that formulas, equations, numeric expressions, and geometric constructions are correct for the intended astronomical model.

Check specifically for:

- unit consistency:
    - angles in radians;
    - distances in AU unless explicitly documented otherwise;
    - velocities in AU/day;
    - temperature in Celsius;
    - pressure in hPa;
    - time intervals in days or seconds according to the local convention;

- incorrect or leftover conversion factors:
    - spurious `DEG2RAD`;
    - spurious `RAD2DEG`;
    - missing radians conversion;
    - squared factors used where linear factors are required;
    - off-by-constant errors;

- sign conventions:
    - longitude east/west convention;
    - hour angle sign;
    - right-handed vs left-handed frames;
    - screen/SVG y-axis direction;
    - east-left vs east-right visual conventions;

- coordinate frames and reference systems:
    - geocentric vs topocentric;
    - apparent vs geometric;
    - equatorial vs horizontal;
    - celestial-north frame vs zenith-oriented frame;
    - local tangent frame vs global frame;

- formulas that mix incompatible frames, such as using a topocentric separation with a geocentric position angle;
- incorrect use of contact geometry:
    - center-to-center angle vs limb contact angle;
    - external vs internal tangency;
    - total vs annular C2/C3 contact direction;

- physical interpretation of quantities:
    - magnitude;
    - apparent diameter ratio;
    - umbra/antumbra/penumbra limits;
    - local chord width vs canonical path width;
    - horizon visibility vs geometric existence.

If a value is intentionally approximate, report it only if the approximation is undocumented, violates the stated precision target, or can produce materially wrong results in valid cases.

### 2. Algorithmic correctness

Verify that the algorithm actually solves the intended problem across the full supported input domain.

Check specifically for:

- wrong objective functions;
- wrong search interval;
- missing expansion of adaptive search windows;
- using a global time/window when a local event can fall outside it;
- assuming an event is absent only because the initial search window has no roots;
- incorrect handling when the current window is entirely inside or entirely outside a phase;
- root-finding failures:
    - missed sign changes;
    - missed roots exactly at sample points;
    - missed roots at endpoints;
    - missed double/tangential roots;
    - missed two-root intervals entirely between coarse samples;
    - false roots produced by endpoint grazing outside the search window;

- convergence and termination issues:
    - infinite loops;
    - non-finite bounds;
    - inverted intervals;
    - insufficient iteration limits;
    - stale best candidate after adaptive expansion;

- degenerate and boundary cases:
    - zero vectors;
    - near-zero separations;
    - poles;
    - zenith/nadir;
    - antimeridian and `0`/`TAU` wrap;
    - grazing eclipse limits;
    - near-limb geometry;
    - horizon crossings;
    - very short event durations;
    - endpoints of validity windows;
    - identity or degenerate transforms;

- classification based only on discrete event samples when the physical property is continuous over an interval, such as horizon visibility during an eclipse interval.

When reviewing local eclipse circumstances or similar geometry, verify that geometric events are still computed even when they are below the horizon. Horizon visibility should affect observability/classification, not erase the geometric event.

### 3. Best approach for the problem

Assess whether the chosen method is appropriate and robust for the astronomical/geometric problem.

Report cases where the implementation:

- uses a fundamentally wrong frame or reference system;
- uses a geocentric shortcut where topocentric geometry is required;
- uses event-sample-only logic where continuous interval analysis is required for correctness;
- uses a fragile root-finding strategy where a standard bracketing/minimization hybrid is needed;
- treats a numerically unresolved grazing case as a finite-duration phase;
- uses a planar, spherical, or linear approximation where the surrounding algorithm clearly assumes ellipsoidal/topocentric/curved geometry and the mismatch produces material error;
- computes a metric with a name or downstream use implying a different physical quantity, unless the code contract explicitly documents the intended semantics.

Do not report a different algorithm merely because it is more sophisticated. Report it only when the current algorithm fails valid cases, is numerically unstable, or contradicts the stated precision requirements.

### 4. Performance and memory allocation

Identify performance or allocation problems that matter for the library’s expected usage.

Report:

- unnecessary allocations in hot paths and tight loops;
- repeated construction of arrays/objects where scalar variables or reusable buffers are sufficient;
- closures allocated inside high-frequency loops when avoidable;
- repeated trig calls where `sin`/`cos` can be cached;
- repeated ephemeris evaluations for the same time/sample;
- repeated recomputation of local state during scans when one sampled table could feed multiple phases of the algorithm;
- avoidable conversions between object and numeric representations;
- inefficient data structures where a flat numeric array or `TypedArray` is clearly justified;
- failure to use mutable output parameters where the codebase convention favors them, such as `o?: MutVec3`.

Do not report performance issues for code that is clearly not on a hot path unless the cost is substantial or scales poorly with realistic inputs.

### 5. Numerical precision

Verify that numerical precision is appropriate for an astronomy library.

Report:

- subtraction of nearly equal values where a stable formulation exists;
- use of `acos` where an `atan2` formulation is more stable near `0` or `PI`;
- missing clamping before inverse trig functions;
- unguarded division by small values;
- tolerances that are inconsistent across related decisions;
- tolerances that classify a finite event in one part of the algorithm but a grazing/unresolved event in another;
- absolute tolerances used where relative tolerances are required;
- `NaN`/`Infinity` propagation into public results or SVG/geometry outputs;
- non-finite distances, angles, radii, times, or iteration steps;
- use of `value === 0` as the only way to detect a root;
- excessive precision loss near poles, horizon, limb contact, or near-perfect alignment.

When reviewing angle outputs, ensure that:

- undefined directions are represented as `null` or otherwise clearly handled when the separation is too small;
- angle normalization is consistent;
- wrap-around at `0`, `PI`, and `TAU` is handled correctly;
- `atan2` argument order matches the documented convention.

### 6. Possible bugs

Find concrete logic and implementation bugs, including:

- incorrect conditionals;
- wrong comparison direction;
- wrong inclusive/exclusive boundary;
- wrong index or off-by-one error;
- skipped endpoint;
- duplicated or missing sample;
- stale state after loop expansion;
- swapped arguments;
- incorrect fallback path;
- incorrect handling of optional output parameters;
- uninitialized state;
- mutation of values expected to be immutable;
- public/exported helpers that can hang or return invalid results for invalid but possible arguments;
- silently returning plausible-looking geometry from missing internal state;
- creating inconsistent output metadata, such as reporting one selected event while drawing another.

If a helper is exported, review it as part of the public correctness surface, even if the main call path passes safe arguments.

## Reporting Rules

For each finding, include:

1. severity:
    - `P0` correctness blocker;
    - `P1` likely correctness bug;
    - `P2` edge-case correctness issue or numerical robustness issue;
    - `P3` minor robustness/performance issue;

2. exact file/function/line or the smallest identifiable code location;
3. explanation of the bug;
4. why it matters physically, mathematically, numerically, or algorithmically;
5. a concrete fix;
6. a minimal test or scenario that would fail before the fix.

Do not report:

- style-only issues;
- naming-only issues;
- formatting;
- comments or documentation wording unless it directly causes incorrect interpretation of a public result;
- test organization;
- dependency choices;
- API design preferences;
- harmless micro-optimizations;
- known deliberate trade-offs already documented by the project;
- issues that require changing the documented contract without a correctness bug.

# Before finishing a change

* Leave the touched area with zero TypeScript errors and passing related tests.
* Run the closest targeted tests first, then run `bun run lint` and `bun run fmt`.
* Fix any regression introduced by the change before committing.
* Review the diff and make sure it contains only intentional changes.
* Do not commit unrelated formatting, generated files, debug logs, temporary code, or local-only configuration.
* Commit only the touched changes after all relevant checks are green.

## Commit message guidelines

* Write commit messages in English.
* Use lowercase text, except for acronyms, proper nouns, package names, and file names.
* Start with a present-tense imperative verb, such as `implement`, `fix`, `improve`, `update`, `use`, `remove`, `rename`, or `refactor`.
* Keep the subject concise and specific. Prefer describing the actual change over a generic action.
* Avoid vague subjects such as `fix bug`, `update code`, `changes`, or `wip`.
* Use one logical change per commit.
* Do not mention implementation noise unless it is relevant to the change.
* Add a commit body when the reason, trade-off, migration step, or behavior change is not obvious from the subject.
* In the body, explain why the change was made and any important side effects.
* Reference issues, tickets, or follow-up work when applicable.
* Mention breaking changes explicitly.
