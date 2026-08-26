# AGENTS.md

## Scope and Project Overview

These instructions apply to the whole repository unless a nested `AGENTS.md` provides narrower rules.

Nebulosa is a Bun-first, ESM-only TypeScript toolkit for numerical astronomy, astrophotography, and observatory control.

- Runtime, package manager, builder, and test runner: **Bun**
- Modules: **ESM only**
- Domains: astronomy, imaging, astrometry, catalogs, observation algorithms, and device protocols
- Native access: TypeScript FFI bindings in `src/bindings` with runtime support in `native/`

Use the user's task to determine the authorized outcome:

- A review, audit, diagnosis, or explanation is read-only unless the user also asks for a change.
- An implementation request includes the smallest necessary source, test, documentation, and example updates.
- Do not broaden a task into a refactor, compatibility layer, remote operation, or unrelated cleanup.

## Working Principles

- Inspect live code, tests, configuration, and nearby patterns before editing. Treat plans and prior descriptions as hypotheses until verified.
- Make the smallest cohesive change that fully solves the task. Avoid parallel architectures, speculative abstractions, and compatibility wrappers unless the task requires them.
- Deliver finished production code: no TODOs, placeholders, debug artifacts, temporary branches, or partially wired behavior.
- Preserve unrelated worktree changes. If task files are already modified, understand and retain those edits rather than overwriting them.
- Treat numerical correctness, physical meaning, unit consistency, lifecycle behavior, performance, and memory use as first-class requirements.
- Avoid broad refactors while fixing local issues.
- Update affected tests and examples whenever behavior or public contracts change.
- Reuse the existing stack and local primitives. Add a dependency only when they cannot solve the problem and its startup, bundle, binary, and operational costs are justified.
- Do not introduce unrelated formatting, generated files, logs, fixtures, or local-only configuration.

## Code Discovery

This repository uses `codebase-memory-mcp`. Prefer graph discovery when it is available and current:

1. `list_projects` and `index_status` to identify the project and index health on first use.
2. `search_graph` to locate functions, classes, constants, interfaces, and types.
3. `trace_path` for callers, callees, dependencies, and impact.
4. `get_code_snippet` to read an exact symbol after discovery.
5. `search_code` for scoped text or usage searches.
6. `query_graph` and `get_architecture` for broader structural questions.
7. `check_index_coverage` before relying on negative or exhaustive graph claims.

The graph is an index, not source authority. Read the exact implementation and nearby tests before editing. If the MCP service is unavailable, stale, partial, or cannot answer the query, continue with `rg` and direct source inspection rather than blocking the task.

Use `rg` first for string literals, errors, configuration, documentation, generated data, and filesystem-oriented searches. Re-run `bun run index` after major module additions, moves, or broad symbol changes; routine local edits are watched automatically.

## Repository Map and Dependency Boundaries

- `src/core/`: shared constants, types, validation, and general utilities.
- `src/math/`: units, numerical algorithms, geometry, vectors, and matrices.
- `src/io/`: byte-stream abstractions and formats such as FITS and XISF.
- `src/astronomy/`: time, coordinates, ephemerides, bodies, orbits, projections, and events.
- `src/imaging/`: image models, processing, star measurement, optical/sensor analysis, and synthetic data.
- `src/astrometry/`: WCS, plate solvers, star matching, and crossmatching.
- `src/catalogs/`: local catalog formats and spatial query engines.
- `src/devices/`: INDI, Alpaca, Firmata, PHD2, telescope protocols, and simulators.
- `src/adapters/`: external service integrations.
- `src/bindings/`: TypeScript FFI surfaces; `native/` contains their runtime support and is high-risk.
- `src/observation/`: high-level focus, guiding, alignment, framing, dome, and mount algorithms.
- `tests/`: mirrors `src/`; shared helpers remain at the tests root.
- `data/`: large fixture-backed FITS, XISF, SPK, catalog, and Earth-orientation data.
- `examples/` and `scripts/`: runnable integrations and maintenance utilities that import directly from `src/`.
- `main.ts`: package placeholder, not the implementation surface. Reusable code belongs in `src/`.

Preserve these boundaries:

- `core`, `math`, and `io` never import from astronomy, imaging, astrometry, catalogs, observation, devices, adapters, or bindings.
- `observation` may compose device and adapter layers; devices and adapters never import from `observation`.
- Bindings are integration dependencies and may be consumed by the matching domain module; keep native/runtime concerns out of unrelated numerical code.
- Follow existing cross-domain dependencies and do not introduce new cycles.
- Keep filesystem, process, device, network, and other runtime side effects out of portable numerical modules.
- Keep large FITS, XISF, SPK, image, and catalog paths streaming-friendly; avoid unnecessary materialization and deep cloning.

Project layout conventions:

- Add modules to the existing domain folder that owns the responsibility. Do not create a new top-level `src/` category without a clear architectural need.
- Keep `tests/` aligned with `src/`; shared `setup.ts`, `download.ts`, and `*.util.ts` files stay at the tests root.
- Prefer dot-separated related filenames within a domain, such as `firmata.barometer.ts`, rather than adding shallow one-file subdirectories.
- Use direct relative imports without `.ts` extensions. Do not add a barrel or broad `export *` surface unless an aggregated entry point is the task.
- Reuse existing math, time, image, catalog, coordinate, and I/O modules before creating helpers.
- Do not rewrite, format, or regenerate `src/**/*.data.ts` unless explicitly requested.

## Tooling

Use Bun for installs, scripts, tests, and local execution.

- Install: `bun install`
- Format touched paths: `bunx oxfmt <path...>`
- Format the repository: `bun run fmt`
- Check formatting: `bun run fmt:check`
- Lint and type-check: `bun run lint`
- Lint with fixes: `bun run lint:fix`
- Refresh the code graph: `bun run index`
- Run the full suite: `bun test --parallel`
- Run one test file: `bun test tests/vec3.test.ts`

Tests use `bunfig.toml`, with `tests/` as the root and `tests/setup.ts` as preload. Missing large fixtures may be downloaded through `tests/download.ts`.

Do not introduce npm, Yarn, pnpm, Vite, PostCSS, Prettier, ESLint, another test runner, or another bundling layer.

### Python Reference Values

Use `uv` only as a development-time reference tool for Astropy, ERFA, NumPy, Skyfield, or similar trusted libraries.

- Do not invoke `python`, `pip`, or a manually managed virtual environment.
- Use `uv run --with <dependency> <script>` or a PEP 723 script so dependencies resolve reproducibly.
- Pin the epoch, timescale, observer, location, ellipsoid, units, and other inputs.
- Record the reference library and version near committed expected values or fixtures.
- Paste stable reference values into Bun tests; Python must not enter the runtime or test dependency path.
- Keep one-off scripts outside the repository unless reproducible fixture generation is itself part of the task.

## TypeScript, Formatting, and Runtime Style

Follow OXC configuration: tabs, single quotes, no semicolons, trailing commas, sorted imports, LF endings, and the configured line width.

- Use TypeScript and ESM. Never add CommonJS.
- Preserve `// oxfmt-ignore` immediately above intentionally long imports and keep those imports on one line.
- Keep strict types. Avoid `any`, broad index signatures, unchecked assertions, and suppressions when `unknown`, generics, narrowing, or explicit shapes work.
- Always type function and method parameters.
- Prefer inference for primitive and tuple returns. Add explicit return types for public structured results or where inference would make a contract unclear or unstable.
- Prefer `interface` for structured public objects and `type` for unions, tuples, mapped types, and aliases.
- Use tuple aliases and the existing `MutX` plus `Readonly<MutX>` convention for low-level numeric structures.
- Use `readonly` where it communicates API intent without fighting mutable-output hot paths.
- Prefer `undefined` for absence. Use `null` only when it has a distinct documented meaning or an external protocol requires it.
- Prefer exhaustive discriminated unions and camel-case string-literal states over enums unless runtime identity or an external contract requires an enum.
- Use `import type`, `export type`, `satisfies`, and `as const` when they preserve intent and inference.
- Await promises. Mark intentional fire-and-forget work with `void` and explicit error handling.
- Throw only `Error` instances. Normalize unknown failures at logging, protocol, and API boundaries.
- Use `performance.now()` for durations and `Date` for wall-clock timestamps.

Preserve established implementation patterns:

- Prefer top-level pure functions for numerical work.
- Use classes primarily for protocol clients, simulators, managers, and other stateful integrations.
- Reuse `vec2.ts`, `vec3.ts`, `mat2.ts`, `mat3.ts`, `matrix.ts`, `math.ts`, `time.ts`, and nearby primitives before adding equivalents.
- In hot paths, preserve optional mutable outputs such as `out?: MutVec3`; document whether the return aliases the output.
- Prefer flat numeric layouts, stable object shapes, typed arrays, and reusable buffers for high-volume work.
- Keep portable numerical modules free of Bun- or Node-only APIs. Runtime integrations may use Bun, `Buffer`, timers, `fetch`, and `fs/promises` where nearby code does.

## Documentation Comments

These rules apply to production code under `src/`. Use concise repository-style `//` comments that explain contracts, not syntax.

- Start every new `src/` file with a module description immediately after imports, or at the top when there are none. Describe its responsibility, domain, units/conventions, and mutation or allocation behavior.
- Keep a file's module description current when its responsibility changes.
- Add a documentation comment above every function, method, class, interface, type alias, enum, and module-level constant.
- Describe intent, every parameter, return semantics, side effects, valid domain, and important edge cases without restating the signature.
- State units for angles, distances, times, rates, temperatures, pressure, magnitudes, and pixel coordinates.
- State coordinate frames, handedness, origins, axis directions, normalization, ordering, non-empty, monotonic, and other preconditions.
- For mutable outputs, document mutation, aliasing, and whether a fresh value is allocated when the output is omitted.
- Document approximations, tolerances, iteration limits, fallback behavior, precision trade-offs, and authoritative sources near the implementation.
- Explain a constant's physical or algorithmic meaning, unit, source when known, and valid range.
- Describe every interface property adjacent to the property, including units and constraints where relevant.
- Do not comment obvious assignments, loop mechanics, or control flow.

Tests do not need production-style documentation comments. Add test comments only when they preserve non-obvious fixture provenance, trusted reference versions, numerical intent, lifecycle timing, or a regression's physical reason.

## Validation Policy

The project deliberately performs little runtime validation for trusted, typed inputs. Callers are responsible for satisfying documented preconditions; validation is not a substitute for a precise contract.

Runtime validation is warranted only when:

1. It prevents a hang, non-convergence, stack overflow, process crash, or unbounded/accidentally huge allocation.
2. The types cannot express a structurally nonsensical state and continuing would silently produce a plausible-looking wrong result.

Untrusted boundaries are separate: validate network payloads, files, protocol messages, environment/process values, and third-party responses once when they enter the system.

For trusted internal and public function arguments, do not add checks merely for:

- numeric range, sign, index bounds, or angle normalization;
- union, enum, or discriminant membership already expressed by the type;
- `null`, `undefined`, or optional property presence already expressed by the type;
- object shape already expressed by TypeScript;
- `NaN` or `Infinity` inputs;
- array lengths, dimensions, non-emptiness, or sorting unless one of the two allowed failure modes actually applies.

A caller outside the documented domain gets whatever mathematical result the computation produces, but it still must not trigger the first failure mode above. Valid inputs must not produce non-finite public geometry, time, coordinate, or image/SVG results.

When validation is justified:

- Validate once at the operation entry point or external parsing boundary, never repeatedly in deeper trusted layers or hot loops.
- Reuse `src/core/validation.ts`; add and test a shared validator only when the check is genuinely reusable.
- Comment the concrete failure the check prevents.
- Do not use exceptions as routine state-machine or result control flow; prefer discriminated result unions for expected failures.
- In reviews, report the concrete hang, crash, unbounded work, or plausible wrong result—not “missing validation.”

## Numerical and Physical Rules

- Angles are radians unless documented otherwise.
- Distances are AU unless documented otherwise.
- Velocities are AU/day unless documented otherwise.
- Time intervals use the local days-or-seconds convention; always document which.
- Temperature is degrees Celsius and pressure is millibar (`hPa`) unless documented otherwise.
- Pixel coordinates must document origin, extent convention, channel layout, CFA phase, and axis direction when relevant.
- Cache repeated trigonometric and frame computations.
- Avoid subtracting nearly equal values when a stable formulation exists.
- Prefer `atan2`-based formulations over `acos` near `0` or `PI`.
- Clamp rounding-sensitive inverse-trigonometric inputs.
- Guard divisions when valid geometry can approach a singular denominator.
- Normalize vectors explicitly with existing vector helpers when required.
- Preserve angle wrapping deliberately and document whether output is `0..TAU`, `-PI..PI`, or unwrapped.
- Represent singular or undefined directions explicitly, usually with `undefined`.
- Use tolerances that match scale and conditioning; distinguish absolute, relative, angular, pixel, and time tolerances.
- Never “fix” a numerical regression by changing expected values before independently proving the new result.

## Performance and Memory

Optimize code paths that are hot, scale with realistic data, process large payloads, or run every simulation/render tick. Do not add complexity to cold code without evidence, and never trade away correctness or numerical stability for a micro-optimization.

### Algorithms and Data Layout

- Check asymptotic complexity before micro-optimizing.
- Replace repeated linear lookup with `Map`, `Set`, indexing, bucketing, or spatial structures when the scale justifies it.
- Preallocate when final size is known. Avoid sparse and heterogeneous arrays in critical paths.
- Prefer flat objects or typed arrays for large numeric datasets; do not convert typed arrays to regular arrays without need.
- Prefer `subarray()` when a view is enough and `slice()` only when a copy is required.
- Do not use argument spread for potentially large collections.
- Keep caches bounded or provide an eviction/size policy; use stable keys and do not memoize cheap work.

### Hot Loops and Numerical Work

- Hoist loop invariants, unit conversions, decoders, regular expressions, and repeated trigonometric/projection/frame calculations.
- Avoid intermediate arrays from chained `map`/`filter`/`reduce`, object/array spreads, closures, and temporary objects in measured hot loops.
- Reuse mutable outputs, workspaces, typed-array views, and buffers when ownership is clear.
- Compare squared distances when the distance itself is not needed; use direct multiplication for small integer powers.
- Avoid formatting, logging, JSON conversion, exceptions, and dynamic object reshaping in high-volume loops.
- Keep performance-motivated code readable and document non-obvious allocation or numerical trade-offs.

### Async, I/O, and Lifecycle

- Do not accidentally serialize independent I/O. Use bounded concurrency for large or untrusted batches.
- Stream large FITS, XISF, SPK, catalog, image, and network payloads when materialization is unnecessary.
- Reuse long-lived clients and expensive helpers where lifecycle ownership is explicit.
- Clean up timers, listeners, observers, sockets, pending requests, and buffers on success, failure, cancellation, disconnect, and disposal.
- Quarantine or ignore late replies/events from obsolete sessions.
- Avoid blocking the event loop with substantial CPU work; use an existing worker/offload pattern when one exists.

Before accepting a performance-sensitive change, verify complexity, allocation behavior, buffer reuse, concurrency bounds, cache growth, lifecycle cleanup, and readability. A performance review finding must identify realistic scale or frequency and a material effect.

## Tests

- Use `bun:test`; place tests under `tests/` mirroring source folders and module names.
- Add tests to the closest existing `*.test.ts` file when practical.
- Match nearby `test` and `expect` style.
- Write the smallest deterministic test that proves the behavior at the correct unit or integration seam.
- Prefer pure focused tests for numerical logic and integration-style tests for parsers, serializers, adapters, protocol clients, I/O, and simulators.
- Mock only true external or nondeterministic boundaries. Reuse `data/` fixtures rather than embedding large payloads.
- Cover success and typed failures at boundaries, including malformed external input, missing configuration, timeout, cancellation, and upstream failure.
- For devices and orchestration, cover capability absence, disconnect/reconnect, busy/conflict/Alert states, late events, cancellation ownership, cleanup, and boundary timing—not only the happy path.
- For simulators, assert meaningful state transitions, timing, trajectory, and physical behavior rather than only command acknowledgement.
- Do not test that pure functions reject out-of-range or wrong-typed trusted inputs; that is outside the validation contract.
- Assert behavior precisely and avoid snapshot-heavy tests.
- Use `toBeCloseTo` or explicit tolerances for floating-point results. Use strict equality only for mathematically exact results.
- Cover relevant astronomical/geometric boundaries: zero vectors, near-zero separations, poles, zenith/nadir, horizon and antimeridian crossings, `0`/`TAU` wrap, grazing contact, degenerate/identity transforms, and validity-window endpoints.
- Treat image hashes as regression alarms, not algorithmic truth. Before updating one, inspect the numerical/pixel difference and verify the new result independently.
- Prefer the closest real fixture test over a fixture-free smoke test when behavior depends on an actual format or dataset.

## Verification Before Finishing

Verification is proportional to the change, but the touched area must have zero introduced TypeScript errors, passing relevant tests, and no obvious correctness or performance regression.

- Documentation-only changes: format-check the touched files, validate referenced paths/commands, and run `git diff --check`.
- TypeScript changes: run the closest targeted tests, `bun run lint`, `bun run fmt:check`, and `git diff --check`.
- Cross-cutting shared primitives, test infrastructure, broad refactors, or high-risk numerical/runtime changes: also run `bun test --parallel`.
- Native-binding changes: run the relevant native-backed tests and state any platform/library limitation.
- Prefer `bunx oxfmt <explicit paths>` when the worktree contains unrelated edits. Use repository-wide `bun run fmt` only when its entire output is in scope, then inspect every formatted change.
- Re-run tests after any fix made in response to a failed check.
- Distinguish failures introduced by the task from pre-existing, fixture, network, or platform failures. Establish overlap with touched code before treating a full-suite failure as a task regression.
- Do not commit with introduced failures or unresolved errors in the touched area.
- Report every skipped or failed verification command and its exact reason.
- Review the final diff and status before staging.

## Code Review

A review request is read-only. Do not edit, stage, commit, push, or resolve remote threads unless the user separately requests those actions.

Review changed code and directly affected contracts. Report only actionable findings supported by code evidence and tied to concrete correctness, numerical, algorithmic, physical, lifecycle, performance, or memory harm.

For pull-request work, refresh the current diff, review bodies, general comments, and live review threads rather than relying on a previous snapshot. A push and remote thread resolution remain separate authorization decisions.

### Review Scope

Check:

- **Mathematical and physical correctness** — units, conversion factors, signs, handedness, coordinate frames, reference systems, apparent/geometric or topocentric/geocentric distinctions, contact geometry, physical quantities, and documented approximation limits.
- **Algorithmic suitability** — objective functions, search windows, adaptive expansion, continuous-versus-discrete classification, bracketing, endpoint/sample/tangential/double roots, convergence, degenerate cases, and supported-domain completeness.
- **Numerical robustness** — cancellation, unstable inverse trig, missing clamps, small denominators, tolerance scaling, angle normalization, pole/horizon/limb behavior, and non-finite output from valid inputs.
- **Implementation correctness** — condition direction, indices, endpoints, stale state, swapped arguments, fallback paths, optional outputs, mutation, initialization, metadata consistency, and cleanup.
- **Performance and memory** — only realistic, material issues under the “Performance and Memory” rules.
- **Async and device lifecycle** — capability state, command ownership, disconnect/reconnect, cancellation, timeout, late events, session invalidation, and cleanup.

Examples of reportable domain failures include:

- mixing radians with degrees, AU/day with km/s, or days with seconds;
- applying a geocentric shortcut where topocentric geometry is required;
- confusing center separation with limb contact, or total with annular C2/C3 geometry;
- missing roots because two events lie between coarse samples or because a tangent never changes sign;
- accepting a discrete sampled classification for a property that must hold over a continuous interval;
- using an approximation that materially violates its documented precision/domain;
- propagating `NaN` or `Infinity` from valid inputs into public geometry, time, coordinate, SVG, or image output;
- leaking timers, listeners, observers, sockets, or in-flight work.

Do not recommend a more sophisticated method merely because it exists. Report it only when the current method fails valid cases, is unstable, or violates a stated precision or performance requirement.

Missing routine input validation is not a finding. Read “Validation Policy” first. An exported helper must work over its documented domain and must not hang, crash, or allocate without bound outside it; that does not require it to reject every invalid argument.

Do not report:

- style, naming, formatting, or test-organization preferences;
- documentation wording unless it causes a public result to be interpreted incorrectly;
- missing or deliberately removed validation outside the two allowed validation cases;
- dependency or API-design preferences without a demonstrated bug;
- speculative alternatives, harmless micro-optimizations, or documented trade-offs;
- pre-existing issues unrelated to the change.

### Reporting Findings

Order findings by severity:

- `P0`: catastrophic correctness failure, data loss, or process-wide failure on a supported path.
- `P1`: likely correctness or lifecycle bug in normal supported use.
- `P2`: edge-case correctness or meaningful numerical robustness issue.
- `P3`: minor robustness issue or material performance/memory issue.

For each finding, provide:

1. severity and a concise title;
2. the exact file, symbol, and smallest useful line location;
3. the failing scenario and code evidence;
4. why it matters physically, mathematically, numerically, or operationally;
5. a concrete fix;
6. the minimal regression test that fails before the fix.

If there are no actionable findings, say so explicitly and mention any verification gap or residual risk. Do not inflate review output with non-findings.

## Git and Commit Workflow

For every completed task that changes tracked files, create a local commit unless the user explicitly says not to commit. Do not create empty commits for review-only or analysis-only tasks.

Before committing:

- Inspect `git status --short`.
- Review the unstaged diff and confirm every changed line is intentional.
- Stage task files explicitly by path; never rely on `git add .` or `git add -A`.
- Inspect `git diff --staged`.
- Commit only after relevant checks pass.
- Follow any user-requested commit granularity, such as one commit per independent review comment.

Authorization boundaries:

- A request to commit does not authorize a push.
- A request to fix review comments does not authorize resolving remote threads.
- Pushes, PR creation/updates, comments, and remote thread resolution each require explicit authorization.
- Never amend, squash, rebase, or rewrite existing commits unless explicitly requested.
- Preserve and leave unstaged all unrelated user changes.

### Commit Messages

Write precise English commit messages with:

1. an imperative subject, normally lowercase, preferably no more than 72 characters and without a trailing period;
2. exactly one blank line;
3. a required body explaining why the change exists and any important side effects, limitations, or trade-offs;
4. exactly one blank line;
5. a `Co-Authored-By: Name <email>` trailer for the authoring agent.

Do not use Conventional Commit prefixes. Avoid vague subjects such as `fix bug`, `update code`, `changes`, `misc`, `cleanup`, `final`, or `wip`. Mention breaking changes explicitly.

Wrap body paragraphs at a readable width and use `-` bullets for several independent effects.

On Windows and across mixed shells:

- Write the complete message to a temporary file outside the repository and commit with `git commit -F <file>`.
- Use the active environment's file-writing mechanism or quoting syntax; never mix PowerShell here-strings with Bash or Bash heredocs with PowerShell.
- Do not pass a multiline message inline with `-m`.
- Remove the temporary file after the commit.
- Read the result back with `git log -1 --format=%B`.
- If quoting corrupts the message, do not amend automatically; report it and let the user decide.

After committing, inspect `git status --short --branch` and report the commit hash, verification performed, skipped checks, and whether remote state was unchanged.
