# AGENTS.md

## Overview

This is a **TypeScript library for astronomy-related computations**.

It focuses on: 
- Celestial coordinate systems (RA/Dec, Alt/Az, etc.), Astronomical transformations 
- Image alignment and astrometric utilities 
- High-precision numerical calculations 
- Performance-sensitive vector/matrix math

The project uses:

- **TypeScript (strict mode)**
- **Bun** as runtime, package manager, and test runner
- ESM modules only

Agents modifying this repository must strictly follow the rules below.

---

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

All changes must: 
- Compile with zero TypeScript errors
- Pass all tests 
- Avoid introducing performance regressions

---

## Project Structure

Agents must respect the existing structure:

- src/
- tests/

Do not create new top-level.

---

## Library Design Principles

### 1. Determinism

Astronomical computations must be deterministic.

- No hidden state
- No reliance on system timezone
- No reliance on system locale
- All units must be explicit

Never assume degrees vs radians. Always document units.

---

### 2. Numerical Stability

Astronomical math is sensitive to floating-point error.

Agents must:

- Avoid unnecessary trig recomputation
- Avoid subtracting nearly equal floating values when possible
- Clamp floating inputs before `acos`, `asin`
- Normalize vectors explicitly when required
- Document precision expectations

If precision trade-offs are introduced, they must be documented.

---

### 3. Performance

This library may operate on:

- Large star catalogs
- Image pixel grids
- Vector transformations in tight loops

Rules:

- Avoid unnecessary allocations inside hot paths
- Prefer mutable vector utilities when performance critical
- Avoid object churn
- Prefer flat numeric structures over nested objects
- Prefer TypedArrays for large datasets

Do not replace optimized loops with functional abstractions if
performance degrades.

---

## TypeScript Standards

### Strict Mode

`"strict": true` is required.

### Rules

- Never use `any`
- Use `unknown` if necessary
- Functions MUST NOT declare explicit return types unless necessary
- Prefer `type` over `interface`

---

## Units Policy

- Angle units are always in radians, otherwise must be documented
- Distance units are always in AU, otherwise must be documented
- Velocity units are always in AU/day, otherwise must be documented
- Temperature units are always in degree celsius, otherwise must be documented
- Pressure units are always in millibar (hPa), otherwise must be documented

---

## Error Handling

- Never silently clamp invalid astronomical values unless mathematically justified.
- Throw explicit errors for invalid domain inputs.
- Avoid generic `Error` when domain-specific error improves clarity.

---

## Testing Requirements

Tests must include:

- Known astronomical reference values
- Edge cases (poles, equator, zero vectors)
- Precision-sensitive comparisons using tolerances

Example test:

```ts
import { describe, test, expect } from "bun:test"

describe('sum', () => {
  test('adds numbers correctly', () => {
    expect(sum(1, 2)).toBe(3)
  })
})
```

Never compare floating-point values using strict equality unless guaranteed.

Use tolerances:

``` ts
expect(a).toBeCloseTo(b, 10)
```

---

## Time Handling

Astronomy is time-sensitive.

Rules:

- Never use system local time.
- Use UTC explicitly.
- Clearly distinguish between:
    - UTC
    - TAI
    - TT
    - Julian Date

If converting to Julian Date, document epoch reference.

---

## Dependency Policy

- Minimize dependencies.
- Avoid heavy math libraries unless strictly necessary.
- Prefer internal vector/matrix utilities.

Before adding a dependency, verify Bun-native support.

---

## Performance Critical Sections

You must:

- Avoid new allocations in loops
- Avoid closures in tight loops
- Avoid JSON operations
- Avoid dynamic object reshaping

Benchmark-sensitive code must remain flat and predictable.

---

## Documentation Expectations

All exported functions must include:

- Unit documentation
- Reference frame
- Mathematical description when non-trivial
- Single-line comments

Example:

``` ts
// Converts equatorial coordinates (RA/Dec, radians, ICRS)
// to horizontal coordinates (Alt/Az, radians, topocentric).
```

---

## Refactoring Rules

When refactoring:

- Improve type safety first
- Preserve performance
- Avoid speculative abstractions
- Do not introduce frameworks

---

## Summary

This library prioritizes:

- Mathematical correctness
- Deterministic behavior
- Numerical stability
- Performance
- Strict typing

Agents must respect all constraints above when generating or modifying
code.
