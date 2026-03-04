# AGENTS.md

## Overview

This is a TypeScript library for astronomy-related computations.

It focuses on celestial coordinate systems, astronomical transformations, image alignment and astrometric utilities, high-precision numerical calculations, performance-sensitive vector/matrix math.

## Rules

Agents must respect all constraints below when generating or modifying code.

* The project uses **Bun** as runtime, package manager, and test runner, ESM modules only.
* All changes must compile with zero TypeScript errors, pass all related tests and avoid introducing performance regressions.
* Must respect the existing structure: `/src` for source code files and `/tests` for test files. Do not create new top-level directory.
* Avoid unnecessary trig recomputation.
* Avoid subtracting nearly equal floating values when possible.
* Normalize vectors explicitly when required. Use `vecNormalize` or `vecNormalizeMut`.
* If precision trade-offs are introduced, they must be documented.
* Avoid unnecessary allocations inside hot paths.
* Prefer mutable vector utilities when performance critical.
* Avoid object churn.
* Prefer flat numeric structures over nested objects.
* Prefer TypedArrays for large datasets.
* Do not replace optimized loops with functional abstractions if performance degrades.
* Avoid use `any`, use `unknown` if necessary.
* Functions MUST NOT declare explicit return types unless necessary. Prefer returning as const.
* Prefer `type` over `interface`.
* Angle units are always in radians, otherwise must be documented.
* Distance units are always in AU (astronomical unit), otherwise must be documented.
* Velocity units are always in AU/day, otherwise must be documented.
* Temperature units are always in degree Celsius, otherwise must be documented.
* Pressure units are always in millibar (hPa), otherwise must be documented.
* Tests must includes precision-sensitive comparisons using tolerances.
* Never compare floating-point values using strict equality unless guaranteed.
* Minimize install dependencies.
* Avoid heavy math libraries unless strictly necessary.
* Prefer internal vector/matrix utilities.
* Before adding a dependency, verify Bun-native support.
* Avoid new allocations in loops.
* Avoid closures in tight loops.
* Avoid JSON operations.
* Avoid dynamic object reshaping.
* Always single-line comment methods and relevant lines.

## Environment

### Install dependencies

``` bash
bun i
```

### Lint

```bash
bun lint
```

### Format

```bash
bun format
```

### Type Check

```bash
bun tsc
```

### Run tests

``` bash
bun test tests/FILENAME.ts
```
