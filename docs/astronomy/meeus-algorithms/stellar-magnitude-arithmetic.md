---
title: Meeus Stellar magnitude arithmetic
layout: default
parent: Meeus Algorithms
grand_parent: Astronomy
nav_order: 360
description: Combines stellar magnitudes, compares brightness, and computes absolute magnitude from distance or parallax.

doc_kind: topic

sources:
    - src/astronomy/ephemeris/meeus.ts

api:
    - Stellar
---

# Meeus Stellar magnitude arithmetic

`Stellar` implements the logarithmic magnitude formulas in Meeus chapter 56. Use it to combine unresolved stars, compare two measured fluxes through their magnitudes, or convert an apparent magnitude to an absolute magnitude. Supply magnitudes measured in a **consistent photometric band**; the functions perform arithmetic on the supplied numbers and do not calibrate an image or correct for extinction.

## Basic usage

```ts
import { Stellar } from '../src/astronomy/ephemeris/meeus';

const combined = Stellar.sum(1.96, 2.89);
const ratio = Stellar.ratio(0.14, 2.12);
const absolute = Stellar.absoluteByParallax(5, 0.1); // parallax in arcseconds
console.log(combined, ratio, absolute);
```

These inputs give a combined magnitude near `1.58`, a brightness ratio near `6.19`, and absolute magnitude `5`. The first star in the ratio call is brighter: its smaller magnitude produces a ratio greater than one.

## Combining and comparing brightness

| Function                   | Input and result                                                                                                        |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `Stellar.sum(m1, m2)`      | Combines the fluxes represented by two apparent magnitudes and returns their combined apparent magnitude.               |
| `Stellar.sumN(magnitudes)` | Combines a nonempty array of apparent magnitudes by summing their relative fluxes; returns a single apparent magnitude. |
| `Stellar.ratio(m1, m2)`    | Returns **brightness of the first star divided by brightness of the second**, `10^(0.4 · (m2 − m1))`.                   |
| `Stellar.difference(r)`    | Converts a positive first-to-second brightness ratio `r` to the magnitude difference **`m2 − m1`**, `2.5 log10(r)`.     |

Magnitudes are dimensionless logarithmic quantities. A smaller magnitude means a brighter source; combining fluxes therefore gives a magnitude smaller than either component. `sumN([])` has no finite magnitude: the implementation's zero-flux sum produces `+Infinity`.

## Absolute magnitude and units

`Stellar.absoluteByParallax(m, pi)` returns `m + 5 + 5 log10(pi)` with **annual parallax `pi` supplied as a number of arcseconds**, not radians. `Stellar.absoluteByDistance(m, d)` returns `m + 5 − 5 log10(d)` with **distance `d` supplied as a number of parsecs**, not AU. For consistent positive inputs with `d = 1 / pi`, the formulas agree. The returned absolute magnitude is the apparent magnitude the source would have at 10 parsecs under this distance-modulus model.

These formulas use the given apparent magnitude directly. They do not apply interstellar extinction, atmospheric extinction, a color correction, or an uncertainty model. A nonpositive parallax or distance lies outside the logarithm's physical domain; the functions do not validate it before evaluation.

## Related topics

- [Meeus numerical helpers]({% link astronomy/meeus-algorithms/numerical-helpers.md %}) provides other arithmetic used by the chapter algorithms.
- [Angular Size and Planning Magnitudes]({% link astronomy/observing-formulas/angular-size-and-planning-magnitudes.md %}) estimates apparent magnitudes for Solar System planning.
