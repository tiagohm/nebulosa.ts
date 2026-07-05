# AGENTS.md

## Overview

Nebulosa is a Bun-first, ESM-only TypeScript astronomy library.

The codebase is module-oriented and organized under `src/` into domain-and-responsibility folders that follow the direction of dependencies. Low-level layers (`core`, `math`, `io`) never import from higher ones (`astronomy`, `imaging`, `astrometry`, `catalogs`, `observation`); runtime edges (`devices`, `adapters`, `bindings`) sit on top. Within a folder, related modules keep dot-separated domain names, such as `alpaca.*`, `firmata.*`, `image.*`, `indi.*`, and `star.*`. `tests/` mirrors the `src/` folder layout.

## Working Principles

- Preserve the existing architecture unless the task explicitly requires a structural change.
- Prefer small, focused changes that match nearby code patterns.
- Treat numerical correctness, unit consistency, and performance as first-class requirements.
- Avoid broad refactors while fixing local issues.
- Do not introduce unrelated formatting changes, generated files, debug logs, temporary code, or local-only configuration.
- When behavior changes, update tests and any affected examples in the same task.

## Code Discovery

This repository uses `codebase-memory-mcp`.

Prefer the MCP graph tools for code discovery:

1. `search_graph` for locating functions, classes, constants, interfaces, and types.
2. `trace_path` for callers, callees, dependencies, and impact analysis.
3. `get_code_snippet` for reading exact symbols after discovery.
4. `query_graph` for broader structural queries.
5. Fall back to `rg` only for string literals, config files, shell scripts, generated data, or when graph results are insufficient.

## Repository Map

- `src/`: library source, grouped into domain folders. Top layers: `core`, `math/*`, `io/*`. Domain layers: `astronomy/*`, `imaging/*`, `astrometry/*`, `catalogs/*`. Runtime edges: `devices/*`, `adapters/*`, `bindings/*`, and the high-level `observation/*` algorithms. Place new implementation code in the folder that matches its domain and respects the dependency direction.
- `src/**/*.data.ts`: large static numeric tables, co-located with the model that consumes them. Do not rewrite, reformat, or regenerate them unless the task explicitly requires it.
- `tests/**/*.test.ts`: Bun tests mirroring the `src/` folder layout and module names.
- `tests/setup.ts`: Bun preload for shared test state and fixture-backed resources. Kept at the `tests/` root.
- `tests/download.ts`, `tests/*.util.ts`: shared test helpers kept at the `tests/` root; downloads missing fixtures into `data/` from GitHub when tests need them.
- `data/`: test fixtures such as FITS, XISF, SPK, catalogs, and Earth orientation files.
- `examples/`, `scripts/`: runnable usage examples and maintenance scripts that import from `src/`. Update their imports when modules move.
- `native/`: native/runtime support used by `postinstall` (distinct from `src/bindings/`, which holds the TypeScript FFI bindings). Treat changes here as high-risk.
- `main.ts`: not the main implementation surface of the library. Prefer editing `src/` and `tests/`.

## Project Structure Rules

- Place new modules in the existing `src/` domain folder that matches their responsibility; do not add new top-level `src/` categories without a clear domain need.
- Respect the layer dependency direction: `core`, `math`, and `io` must not import from `astronomy`, `imaging`, `astrometry`, `catalogs`, `observation`, `devices`, `adapters`, or `bindings`. `observation` may import `devices`/`adapters`, never the reverse.
- Keep `tests/` mirroring the `src/` folder layout, with shared test helpers (`setup.ts`, `download.ts`, `*.util.ts`) at the `tests/` root.
- Within a folder, prefer dot-separated filenames for related modules of the same domain, for example `firmata.barometer.ts`, rather than deeper nesting.
- Prefer direct module imports over new barrel files unless the task explicitly requires an aggregated entrypoint.
- Preserve existing relative import style without `.ts` extensions.
- Reuse existing modules before creating new ones, especially in math, time, image, catalog, and coordinate code.

## Tooling

Use Bun for installs, scripts, tests, and local execution.

- Install: `bun install`
- Format: `bun run fmt`
- Format check: `bun run fmt:check`
- Lint and type-check: `bun run lint`
- Lint with fixes: `bun run lint:fix`
- Refresh codebase graph: `bun run index`
- Test all: `bun test`
- Test one file: `bun test tests/vec3.test.ts`

Additional rules:

- Prefer targeted Bun tests before broader test runs.
- Tests run through Bun with `bunfig.toml` configured to use `tests/` as the test root and `tests/setup.ts` as preload.
- Some tests depend on large fixtures in `data/`; missing fixtures may trigger downloads through `tests/download.ts`.
- Do not introduce another test runner unless the task explicitly requires it.
- Do not use `bun run compile` as a fallback for linting or type-checking.

### Python fixtures and reference values

- Use `uv` to run Python scripts that generate fixtures or reference values, for example with Astropy, ERFA, NumPy, or Skyfield. Do not invoke `python`, `pip`, or a manually managed virtualenv directly.
- Run one-off scripts with `uv run script.py` and declare their dependencies inline with PEP 723 metadata so `uv` resolves them automatically, for example `uv run --with astropy --with numpy script.py`.
- Use these scripts to cross-check TypeScript results against a trusted reference (Astropy/ERFA) and to produce expected values for tests; paste the resulting numbers into the test as literals rather than depending on Python at test time.
- Keep generated values reproducible: pin the timescale, epoch, location, and ellipsoid in the script, and note the reference library and version in a comment near the generated fixture or expected value.
- Do not add Python to the project's runtime or test path. `uv` is a local fixture-generation tool only; Bun remains the sole runtime for the library and its tests.

## Formatting And TypeScript Style

- Follow OXC formatting: tabs, single quotes, no semicolons, trailing commas, and the configured long line width.
- For intentionally long imports, add `// oxfmt-ignore` immediately above the import declaration and restore it to a single line when OXC formats it across multiple lines.
- Preserve existing `// oxfmt-ignore` comments when they protect intentional formatting, especially long grouped imports.
- Always type function and method parameters.
- Avoid `any`. Use `unknown` when a value cannot be expressed more precisely.
- Prefer `undefined` over `null` for absent, unavailable, or not-yet-computed values. Use `null` only when it has a distinct documented semantic meaning or an external contract requires it.
- Prefer inference for primitive and tuple return types unless an explicit return type improves the public contract or protects a branded primitive.
- Declare explicit return types for structured objects, exported public interfaces, and functions whose inferred type would be unclear or unstable.
- Prefer `interface` for structured public shapes.
- Prefer string-literal union types with `camelCase` values, such as `'notStarted' | 'inProgress'`, over enums for finite internal value sets unless a runtime enum or external API contract requires one.
- Use `readonly` where it communicates API intent without fighting existing mutable-output patterns.
- Use tuple aliases and readonly aliases for low-level numeric structures such as vectors and matrices.

## Documentation Comment Style

Use concise, Claude-style documentation comments: explain intent, units, constraints, side effects, and edge cases. Do not restate obvious code.

- Always add a documentation comment above every function, method, class, interface, type alias, enum, and module-level constant.
- Always comment constants. For local throwaway constants inside a function, comment the surrounding calculation when individual comments would create noise.
- Prefer the repository's existing `//` comment style. Use multi-line `//` comment blocks instead of `/* ... */` unless the file already uses TSDoc/JSDoc or tooling requires it.
- A function or method comment should describe what it computes or performs, document each parameter, state relevant units and valid ranges, and mention return semantics.
- If a function mutates an output parameter such as `o?: MutVec3`, document that mutation and whether the returned value aliases `o`.
- If a function accepts angles, distances, times, pixel coordinates, magnitudes, rates, or temperatures, document the unit explicitly.
- If a function assumes normalized vectors, sorted arrays, non-empty inputs, monotonic values, or a specific coordinate frame, document that precondition.
- If a function uses an approximation, tolerance, iteration limit, or precision trade-off, document it near the implementation.
- A constant comment should explain the physical or algorithmic meaning, unit, source if known, and valid range when applicable.
- An interface comment should describe the object as a whole, and every property must have an adjacent comment explaining meaning, units, and constraints when relevant.
- Do not add comments for obvious assignments, loop mechanics, or control flow unless they explain a non-obvious domain decision.

## Code Patterns To Preserve

- Prefer top-level pure functions for math-heavy modules.
- Use classes mainly for protocol clients, simulators, device managers, and stateful integrations such as Alpaca, INDI, and Firmata.
- Reuse existing low-level utilities from `vec2.ts`, `vec3.ts`, `mat3.ts`, `math.ts`, `time.ts`, and related core files before adding new helpers.
- Preserve the `MutX` plus `Readonly<MutX>` pattern for numeric tuples.
- Preserve the mutable-output convention in hot paths: many vector and matrix helpers accept an optional output parameter such as `o?: MutVec3` or `o?: MutMat3`.
- Prefer top-level helper functions over local closures when performance matters.
- Do not replace tight numeric loops with functional abstractions if that adds overhead.
- Prefer flat numeric structures over nested objects for high-volume calculations.

## Validation Rules

- Use shared validators from `src/validation.ts` when runtime validation is required.
- Before adding inline validation, check whether an existing helper fits.
- If a reusable validation helper is missing, add it to `src/validation.ts` and cover it with tests.
- Do not add runtime validation for every interface field by default.
- Add validation when invalid input would produce misleading public results, non-finite geometry, infinite loops, memory errors, or hard-to-debug numerical failures.
- Prefer clear interface comments for caller-facing unit, range, and shape expectations when runtime checks are not required.

## Numerical Rules

- Angles are radians unless explicitly documented otherwise.
- Distances are AU unless explicitly documented otherwise.
- Velocities are AU/day unless explicitly documented otherwise.
- Time intervals are days or seconds according to the local convention; document which one is used.
- Temperature is degrees Celsius unless explicitly documented otherwise.
- Pressure is millibar (`hPa`) unless explicitly documented otherwise.
- Pixel coordinates follow the local image convention; document origin and axis direction when relevant.
- Avoid unnecessary trig recomputation. Cache `sin` and `cos` values locally when used more than once.
- Avoid subtracting nearly equal floating-point values when a more stable formulation exists.
- Prefer stable `atan2`-based formulations over `acos` when precision near `0` or `PI` matters.
- Clamp inputs before inverse trig when rounding error may push values slightly outside the valid domain.
- Normalize vectors explicitly when required, using `vecNormalize` or `vecNormalizeMut`.
- Preserve angle wrap behavior deliberately. Document whether a returned angle is normalized to `0..TAU`, `-PI..PI`, or left unwrapped.
- Represent undefined directions explicitly, usually with `undefined`, when the geometry is singular or separation is too small.
- Guard divisions by small values when valid inputs can approach zero.
- Do not allow `NaN` or `Infinity` to leak into public geometry, time, coordinate, or SVG/image outputs.

## Performance Rules

- Avoid unnecessary allocations inside hot paths.
- Prefer mutable vector and matrix utilities when performance is important.
- Avoid object churn and dynamic object reshaping in tight loops.
- Prefer scalar variables, reusable buffers, flat arrays, or `TypedArray` when the data size or access pattern justifies it.
- Avoid closures in tight loops.
- Avoid JSON operations in performance-sensitive code.
- Avoid repeated ephemeris, trig, projection, or coordinate-frame computations for the same sample.
- Do not optimize cold code at the expense of correctness, readability, or API stability.

## Runtime Boundaries

- Keep low-level math, coordinate, ephemeris, interpolation, and transformation modules portable and lightweight.
- Avoid Bun-only or Node-only APIs in core numerical modules unless the file is already runtime-specific.
- Runtime-specific integrations such as I/O, device protocols, downloads, and simulators may use Bun, `Buffer`, timers, `fetch`, and `fs/promises` where consistent with nearby code.
- Before adding a dependency, verify Bun compatibility and prefer internal utilities first.
- Minimize new dependencies. Avoid heavy math libraries unless absolutely necessary.

## Tests

- Add or update tests in the closest existing `tests/*.test.ts` file whenever possible.
- Mirror existing test style with Bun's `test` and `expect`.
- Use `toBeCloseTo` or explicit tolerances for floating-point assertions.
- Use strict equality for floating-point values only when the result is guaranteed exact.
- Cover astronomy and geometry edge cases: zero vectors, near-zero separations, poles, zenith/nadir, horizon crossings, antimeridian crossings, wrap-around at `0` and `TAU`, grazing cases, degenerate transforms, identity transforms, and endpoints of validity windows.
- Reuse existing fixtures from `data/` instead of embedding large blobs in tests.
- For fixture-backed behavior, prefer the closest real fixture test over only unit-level smoke checks.

## Verification Before Finishing

Before finishing a change:

- Leave the touched area with zero TypeScript errors, passing related tests, and no obvious performance regression.
- Run the closest targeted tests for the files you changed.
- Run `bun run lint` after TypeScript changes.
- Run `bun run fmt` when formatting may have changed, then review the resulting diff.
- Fix regressions introduced by the change before committing.
- Review the diff and make sure it contains only intentional changes.
- Commit only touched changes after relevant checks are green.
- If network access, missing fixtures, or environment limitations prevent full verification, state that explicitly with the exact command that could not be completed.

## Code Review

When asked to review changes, use a strictly limited correctness scope. Report only findings that are actionable, supported by code evidence, and tied to a concrete correctness, numerical, algorithmic, performance, or memory issue in changed code or directly affected code.

Do not report style, naming, formatting, documentation wording, test organization, dependency choices, API design preferences, or speculative alternatives unless the current implementation is demonstrably incorrect, fragile over the valid input domain, or materially less robust than a standard approach for the same astronomical/geometric problem.

### Review Scope

#### Mathematical and physical correctness

Check formulas, units, signs, frames, and physical interpretation.

Report issues involving:

- unit inconsistencies for radians, AU, AU/day, Celsius, hPa, pixels, days, or seconds;
- spurious or missing conversion factors such as `DEG2RAD`, `RAD2DEG`, squared factors, or off-by-constant errors;
- wrong sign conventions for longitude, hour angle, handedness, screen/SVG y-axis direction, or east-left/east-right visual conventions;
- mixed coordinate frames such as geocentric vs topocentric, apparent vs geometric, equatorial vs horizontal, celestial-north vs zenith-oriented, or tangent-plane vs global-frame values;
- contact-geometry mistakes such as center-to-center angle vs limb contact angle, external vs internal tangency, or total vs annular C2/C3 direction;
- misleading physical quantities such as magnitude, apparent diameter ratio, umbra/antumbra/penumbra limits, local chord width, canonical path width, or horizon visibility.

If a value is intentionally approximate, report it only when the approximation is undocumented, violates the stated precision target, or produces materially wrong results for valid inputs.

#### Algorithmic correctness

Verify that the algorithm solves the intended problem across the supported input domain.

Report issues involving:

- wrong objective functions or search intervals;
- missing adaptive search-window expansion;
- assuming an event is absent only because the initial window has no roots;
- root-finding failures, including missed sign changes, endpoint roots, sample-point roots, double roots, tangential roots, or two roots between coarse samples;
- false roots produced by endpoint grazing outside the search window;
- convergence failures such as infinite loops, non-finite bounds, inverted intervals, stale best candidates, or insufficient iteration limits;
- degenerate and boundary cases such as zero vectors, near-zero separations, poles, zenith/nadir, antimeridian crossings, `0`/`TAU` wrap, grazing limits, near-limb geometry, horizon crossings, very short durations, and identity or degenerate transforms;
- classification based only on discrete event samples when the physical property is continuous over an interval.

For local eclipse circumstances and similar geometry, geometric events must still be computed even when below the horizon. Horizon visibility should affect observability and classification, not erase the geometric event.

#### Method suitability

Report the chosen method when it is fundamentally unsuitable for the stated astronomical or geometric problem.

Examples:

- using a wrong frame or reference system;
- using a geocentric shortcut where topocentric geometry is required;
- using event-sample-only logic where continuous interval analysis is required;
- using fragile root finding where a standard bracketing/minimization hybrid is needed;
- treating numerically unresolved grazing as a finite-duration phase;
- using planar, spherical, or linear approximations where the surrounding algorithm assumes ellipsoidal, topocentric, or curved geometry and the mismatch creates material error;
- computing a metric whose name or downstream use implies a different physical quantity than what is actually computed.

Do not report a different algorithm merely because it is more sophisticated. Report it only when the current algorithm fails valid cases, is numerically unstable, or contradicts stated precision requirements.

#### Performance and memory

Report performance or allocation problems that matter for realistic library usage.

Report:

- unnecessary allocations in hot paths or tight loops;
- repeated object/array construction where scalar variables or reusable buffers would suffice;
- closures allocated inside high-frequency loops;
- repeated trig, ephemeris, projection, or coordinate-frame evaluations for the same sample;
- repeated recomputation of local state during scans when one sampled table could feed multiple phases;
- avoidable conversions between object and numeric representations;
- inefficient structures where flat arrays or `TypedArray` are clearly justified;
- failure to use mutable output parameters where the codebase convention favors them, such as `o?: MutVec3`.

Do not report harmless micro-optimizations or cold-path costs unless they scale poorly or are substantial.

#### Numerical precision and robustness

Report:

- unstable subtraction of nearly equal values;
- use of `acos` where `atan2` is more stable near `0` or `PI`;
- missing clamps before inverse trig functions;
- unguarded division by small values;
- inconsistent tolerances across related decisions;
- absolute tolerances where relative tolerances are required;
- `NaN` or `Infinity` propagation into public results or geometry outputs;
- exact zero checks as the only root-detection strategy;
- precision loss near poles, horizon, limb contact, or near-perfect alignment;
- inconsistent angle normalization or wrong `atan2` argument order.

Undefined directions should be represented explicitly, usually as `undefined`, when the geometry is singular or separation is too small.

#### Concrete bugs

Report concrete logic and implementation bugs, including:

- wrong conditionals, comparison direction, or inclusive/exclusive boundary;
- wrong index, off-by-one error, skipped endpoint, or duplicated/missing sample;
- stale state after loop expansion;
- swapped arguments;
- incorrect fallback path;
- incorrect optional output parameter handling;
- uninitialized state;
- mutation of values expected to be immutable;
- exported helpers that can hang or return invalid results for possible inputs;
- plausible-looking geometry produced from missing internal state;
- inconsistent output metadata, such as reporting one selected event while drawing another.

If a helper is exported, review it as public correctness surface even if the main call path passes safe arguments.

### Performance Checklist

When reviewing or before committing TypeScript changes, check for avoidable performance issues, especially in hot paths, numerical code, rendering loops, data-processing pipelines, and frequently called functions.

Prefer readable code by default, but avoid unnecessary allocations, copies, callbacks, and repeated work when the code is performance-sensitive.

#### Arrays and collections

- Avoid `.slice()` when no real copy is needed.
- Avoid `[...array]` when the array is only being iterated, passed through, or defensively copied without a clear reason.
- Avoid `target.push(...source)` for large arrays. Prefer an indexed loop to avoid argument-spread overhead and stack limits.
- Avoid repeated `concat()` inside loops.
- Avoid chaining `.filter().map().reduce()` in hot paths when a single loop can do the same work without intermediate arrays.
- Avoid `.find()` inside loops. Build a `Map` when repeated lookup by key is needed.
- Avoid `.includes()` on large arrays when repeated membership checks are needed. Use a `Set`.
- Preallocate arrays when the final size is known.
- Avoid `Array.from()` in hot paths when a simple loop is cheaper.

#### Object copies and allocations

- Avoid object spread inside loops unless a copy is required.
- Avoid array spread inside loops.
- Avoid creating temporary objects in functions called very frequently.
- Avoid creating closures, lambdas, or bound functions inside hot loops.
- Avoid `JSON.parse(JSON.stringify(...))` for cloning.
- Avoid `structuredClone()` unless a deep copy is explicitly required and acceptable for the path.
- Reuse temporary objects or output buffers when the function is called repeatedly.
- Avoid repeatedly creating `Date`, `RegExp`, `Intl.*`, `URL`, `TextEncoder`, or `TextDecoder` instances in hot paths. Hoist or cache them when possible.

#### Strings

- Avoid incremental string concatenation for large outputs inside loops. Collect parts and use `.join("")`.
- Avoid `.split()` when only a prefix, suffix, or single separator lookup is needed. Prefer `indexOf()`, `startsWith()`, `endsWith()`, or direct slicing.
- Avoid repeated `.toLowerCase()` / `.toUpperCase()` on the same value. Normalize once and reuse.
- Avoid building expensive log messages when the log level may be disabled.

#### Loops and algorithms

- Check for accidental `O(n²)` behavior from nested loops, repeated `.find()`, repeated `.filter()`, or repeated scans.
- Use `Map`, `Set`, indexing, bucketing, spatial grids, or caches when repeated lookup is required.
- Move loop-invariant calculations outside the loop.
- Avoid repeated unit conversions inside loops.
- Avoid `try/catch` inside hot loops. Put error handling outside the loop when possible.
- Avoid unnecessary function calls inside tight numerical loops when inlining or direct operations would be clearer and faster.
- Avoid logging inside high-volume loops.

#### Math and numerical code

- Avoid `Math.pow(x, 2)` for squaring. Use `x * x`.
- Avoid `Math.sqrt()` when only comparing distances. Compare squared distances instead.
- Reuse expensive trigonometric results such as `sin`, `cos`, `tan`, `atan2`, and `sqrt` when possible.
- Precompute constants such as degree/radian conversion factors.
- Avoid formatting numbers or converting them to strings inside computational paths.

#### Typed arrays and buffers

- Use `Float32Array`, `Float64Array`, `Uint8Array`, or other typed arrays for large numeric datasets.
- Avoid converting typed arrays to regular arrays unless required.
- Prefer `typedArray.subarray(start, end)` when a view is enough.
- Use `typedArray.slice(start, end)` only when a real copy is required.
- Reuse buffers for repeated computations.
- Avoid creating typed-array views repeatedly inside tight loops.
- For large numeric structures, consider separate typed arrays instead of arrays of objects when memory layout and throughput matter.

#### Async and promises

- Avoid marking functions as `async` when they do not await or need to return a promise.
- Avoid unnecessary manual `new Promise(...)` wrappers.
- Avoid sequential `await` inside loops when operations are independent.
- Use `Promise.all` only when unbounded parallelism is safe.
- Use concurrency limits for large batches of async work.
- Batch I/O operations when possible.

#### Maps, sets, and caches

- Use `Map` for repeated key-based lookup.
- Use `Set` for repeated membership checks.
- Avoid recreating `Map` or `Set` inside functions called frequently when the source data is stable.
- Do not add unbounded caches without an eviction or size policy.
- Avoid memoizing cheap computations.
- Avoid using newly created objects as cache keys when their identity changes on every call.

#### Object shapes and JIT friendliness

- Keep object shapes stable.
- Initialize all expected properties when creating objects or class instances.
- Avoid adding properties dynamically after object creation in hot paths.
- Avoid mixing different value types in the same property.
- Avoid heterogeneous arrays in performance-critical code.
- Avoid sparse arrays and large index gaps.

#### Immutability

- Avoid blind immutability in hot paths.
- Avoid repeated `{ ...state }` or `[...items]` patterns when local mutation would be safe and contained.
- Prefer controlled local mutation for temporary data that does not escape the function.
- Keep immutable patterns where they improve correctness, but do not use them automatically in high-volume code without considering allocation cost.

#### Backend code

- Avoid blocking the event loop with heavy CPU work.
- Move heavy CPU-bound work to worker threads, queues, or separate processes when needed.
- Avoid reading large files fully into memory when streaming is suitable.
- Avoid parsing the same large JSON payload repeatedly.
- Reuse clients, pools, and long-lived resources instead of recreating them per operation.
- Avoid excessive synchronous logging in high-throughput paths.

#### Validation and errors

- Avoid using exceptions as normal control flow.
- Validate at system boundaries instead of repeatedly validating the same trusted data deep inside hot paths.
- Avoid repeated deep validation of objects that were already validated.
- Avoid constructing expensive error messages unless they are actually needed.
- Use the most performant formula instead of the most readable or usual one.

#### Approval Rule

Before accepting a performance-sensitive change, verify:

- The algorithmic complexity is appropriate.
- There are no avoidable array or object copies.
- There are no avoidable allocations inside critical loops.
- Repeated lookups use the right data structure.
- Buffers are reused where appropriate.
- Async work is not accidentally serialized.
- Parallel async work has a safe concurrency limit when needed.
- Numerical code avoids unnecessary expensive operations.
- The implementation remains readable enough to maintain.
- Any performance-motivated complexity is justified by the code path.

### Reporting Rules

For each finding, include:

1. severity:
    - `P0`: correctness blocker;
    - `P1`: likely correctness bug;
    - `P2`: edge-case correctness issue or numerical robustness issue;
    - `P3`: minor robustness or meaningful performance issue;
2. exact file, function, line, or smallest identifiable location;
3. explanation of the bug;
4. why it matters physically, mathematically, numerically, algorithmically, or operationally;
5. concrete fix;
6. minimal test or scenario that would fail before the fix.

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

## Commit Message Guidelines

Commit messages must be precise, English, and easy to scan.

- Use lowercase text, except for acronyms, proper nouns, package names, and file names.
- Start the subject directly with a present-tense imperative verb such as `implement`, `fix`, `improve`, `update`, `use`, `remove`, `rename`, or `refactor`.
- Do not prefix the subject with Conventional Commit-style labels such as `feat:`, `fix:`, `perf:`, `docs:`, `refactor:`, `test:`, or scoped variants such as `feat(image):`.
- Keep the subject concise and specific; prefer 72 characters or fewer when practical.
- Do not end the subject with a period.
- Describe the user-visible or technical effect, not the amount of work.
- Prefer one logical change per commit.
- Avoid vague subjects such as `fix bug`, `update code`, `changes`, `misc`, `cleanup`, `final`, or `wip`.
- Do not mention implementation noise unless it is relevant to the change.
- Add a commit body when the reason, trade-off, migration step, or behavior change is not obvious from the subject.
- In the body, explain why the change was made and mention important side effects, limitations, or follow-up work.
- Reference issues, tickets, or follow-up tasks when applicable.
- Mention breaking changes explicitly.

## After Finishing

After the change is complete:

- Always create a commit for the completed task unless the user explicitly asks not to commit.
- Commit only the changes made for the current task.
- Do not include unrelated edits, incidental formatting, generated files, debug logs, temporary files, or local-only configuration.
- Inspect the final state with `git status --short` before staging.
- Review the final diff with `git diff` and confirm every changed line belongs to the task.
- Stage files explicitly by path. Avoid broad staging commands such as `git add .` unless every changed file has been reviewed and belongs to the task.
- Before committing, inspect staged changes with `git diff --staged`.
- Do not amend, squash, rebase, or rewrite existing commits unless the task explicitly requests it.
- If verification could not be fully completed because of environment limits, the commit message may still be created for the finished change, but the final response must list the skipped or failed verification command and the reason.
- If unresolved errors remain, do not commit. Explain what is blocking the commit and which files are affected.
