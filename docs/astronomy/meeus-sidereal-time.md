---
title: Meeus Sidereal Time
layout: default
parent: Astronomy
nav_order: 240
description: Evaluates chapter-style Greenwich mean and apparent sidereal time in seconds of time.

doc_kind: topic

sources:
    - src/astronomy/ephemeris/meeus.ts

api:
    - Sidereal
---

# Meeus Sidereal Time

`Sidereal` evaluates the Greenwich sidereal-time formulas used in Meeus chapter 12. Use it to reproduce a textbook calculation from a numeric Julian day. Its outputs are **seconds of sidereal time** in `[0, 86400)`, rather than angles in radians.

## Basic usage

```ts
import { Sidereal } from '../src/astronomy/ephemeris/meeus';

const jd = 2446895.5;
const meanSeconds = Sidereal.mean(jd);
const apparentSeconds = Sidereal.apparent(jd);
const meanAtMidnightSeconds = Sidereal.mean0UT(jd);
console.log(meanSeconds, apparentSeconds, meanAtMidnightSeconds);
```

The input `jd` is a numeric Julian day on the **UT** timescale assumed by the chapter formula. `mean(jd)` computes Greenwich mean sidereal time using the IAU 1982 polynomial in Julian centuries from J2000 and advances it from 0h UT by the fractional day. `apparent(jd)` adds nutation in right ascension, converted from radians to seconds of time. The implementation evaluates that nutation using the **same numeric JD** passed to the sidereal routine; it does not separately convert the input to TT.

`mean0UT(jd)` and `apparent0UT(jd)` return the values for **0h UT on the JD's calendar date**, ignoring the supplied time of day. `jdToCFrac(jd)` exposes `[centuriesFromJ2000At0hUT, fractionOfDaySince0hUT]`. `IAU82` contains the polynomial coefficients in seconds of time. To convert a result to an angle, multiply the seconds by `2π / 86400`.

## Accuracy and limits

These formulas follow the Meeus/IAU 1982 chapter computation and do not consume the repository's `Time` providers for UT1 − UTC, precession-nutation, or sidereal time. The code has no quantified error bound for this path. For pointing or Earth-orientation work with a `Time`, use the dedicated sidereal-time functions, which accept the selected time and orientation providers and return radians.

## Related topics

- [Sidereal Time and Earth Rotation Angle]({% link astronomy/time-and-earth-orientation/sidereal-time-and-earth-rotation-angle.md %}) computes Greenwich angles from a `Time`.
- [Meeus Calendar]({% link astronomy/meeus-calendar.md %}) converts chapter-style calendar labels to numeric Julian days.
