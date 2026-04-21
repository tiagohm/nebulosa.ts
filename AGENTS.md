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
- Treat `bun run tsc` as the authoritative type-check command. It runs `tsgo --noEmit`, not stock `tsc`.
- `bun run lint` and `bun run fmt` both write changes because they invoke Biome with `--write`.
- Tests run through Bun with `bunfig.toml` configured to use `tests/` as the test root and `tests/setup.ts` as preload.
- Some tests depend on large fixtures in `data/`, and missing fixtures may trigger downloads through `tests/download.ts`.

## Verification Workflow

- All changes must leave the touched area with zero TypeScript errors, passing related tests, and no obvious performance regression.
- Always run the most relevant targeted tests for the files you changed.
- Run `bun run tsc` after TypeScript changes.
- Prefer targeted test commands such as `bun test tests/vec3.test.ts` before considering broader runs.
- If a touched feature is fixture-backed, verify with the closest real test rather than only unit-level smoke checks.
- If network or fixture availability prevents full verification, state that explicitly.

## Formatting And Style

- Follow OXC formatting: tabs, single quotes, no semicolons, trailing commas, long line width.
- Preserve existing `// oxfmt-ignore` comments when they are there for a reason, especially around very long grouped imports.
- Follow the current comment style: short single-line comments above exported functions, methods, and numerically important lines.
- Do not add noisy comments for obvious assignments or control flow.
- Always type method and function parameters.
- Avoid `any`. Use `unknown` when a type truly cannot be expressed more precisely.
- Functions should not declare explicit return types for primitives or tuples unless needed for branded primitive types. Prefer inference or `as const` where appropriate.
- Functions should declare explicit return types for structured objects and public interfaces.
- Prefer `interface` for structured public shapes.
- Use `readonly` where it helps preserve API intent without fighting the existing tuple and mutable-output patterns.
- Use tuple aliases and readonly aliases for low-level numeric structures such as vectors and matrices.

## Code Patterns To Preserve

- Most math-heavy modules use top-level pure functions, not classes.
- Classes are mainly used for protocol clients, simulators, device managers, and stateful integrations such as Alpaca, INDI, and Firmata.
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

## Environment

### Install dependencies

```bash
bun i
```

### Lint

```bash
bun run lint
```

### Format code

```bash
bun run fmt
```

### Type check

```bash
bun run tsc
```

### Run a targeted test

```bash
bun test tests/FILENAME.test.ts
```
