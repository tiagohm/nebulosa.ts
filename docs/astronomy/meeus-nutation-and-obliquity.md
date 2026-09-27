---
title: Meeus Nutation and Obliquity
layout: default
parent: Astronomy
nav_order: 280
description: Evaluates chapter-style nutation angles and mean ecliptic obliquity from a TT Julian day.

doc_kind: topic

sources:
    - src/astronomy/ephemeris/meeus.ts

api:
    - Nutation
---

# Meeus Nutation and Obliquity

`Nutation` evaluates the Meeus chapter 22 nutation and mean-obliquity formulas. Use it to reproduce a textbook correction or to supply angles to another Meeus calculation. Inputs are numeric **TT Julian ephemeris days (JDE)**; outputs are **radians**.

## Basic usage

```ts
import { Julian, Nutation } from '../src/astronomy/ephemeris/meeus';

const jde = new Julian.CalendarGregorian(1987, 4, 10).toJDE(); // UT1 labels to modeled TT.
const [deltaPsi, deltaEpsilon] = Nutation.nutation(jde);
const meanObliquity = Nutation.meanObliquity(jde);
const trueObliquity = meanObliquity + deltaEpsilon;
console.log(deltaPsi, deltaEpsilon, meanObliquity, trueObliquity);
```

`nutation(jde)` returns `[Δψ, Δε]`: nutation in ecliptic longitude and nutation in obliquity. The function forms the lunar and solar arguments in Julian centuries from J2000 and sums the chapter's periodic table. `approxNutation(jde)` returns the same pair from a shorter four-term expression. Neither function converts a `Time` or estimates ΔT; the caller supplies JDE on the intended TT scale.

`meanObliquity(jde)` returns ε₀ from the IAU 1980 polynomial used by the chapter. `meanObliquityLaskar(jde)` evaluates its longer Laskar polynomial. Add **Δε to ε₀** for the true obliquity in this model. `nutationInRA(jde)` computes the chapter's equation-of-equinoxes term **Δψ cos(ε₀ + Δε)**, also in radians. The sign of each result follows the signed periodic series; the functions do not return absolute magnitudes.

## Accuracy and limits

The short approximation omits terms retained by `nutation`; the local tests check a chapter date and compare the two obliquity polynomials at selected years, rather than establishing a uniform error bound. These functions do not implement the library's IAU 2006/2000A Earth-orientation path. Use the `Time`-based orientation functions when a current celestial frame or Earth-fixed transform is required.

## Related topics

- [Meeus Precession]({% link astronomy/meeus-precession.md %}) rotates chapter-style coordinates between Julian epochs.
- [Precession, Nutation, and Obliquity]({% link astronomy/time-and-earth-orientation/precession-nutation-and-obliquity.md %}) describes the library's date-dependent celestial orientation.
