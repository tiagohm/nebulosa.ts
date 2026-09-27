---
title: Meeus Equation of Time
layout: default
parent: Meeus Algorithms
grand_parent: Astronomy
nav_order: 170
description: Evaluates the Meeus apparent-minus-mean solar-time offset from a TT Julian ephemeris day.

doc_kind: topic

sources:
    - src/astronomy/ephemeris/meeus.ts

api:
    - EquationOfTime
---

# Meeus Equation of Time

`EquationOfTime` calculates the chapter 28 difference between apparent solar time and mean solar time. Use it for a Meeus sundial correction or with other chapter-style solar formulas. It accepts a numeric **TT Julian ephemeris day (JDE)** and returns an **angle in radians**, rather than a clock timestamp.

## Basic usage

```ts
import { EquationOfTime } from '../src/astronomy/ephemeris/meeus';
import { toSecondsOfTime } from '../src/math/units/angle';

const jde = 2448908.5; // TT
const offsetRadians = EquationOfTime.e(jde);
const offsetSeconds = toSecondsOfTime(offsetRadians);
console.log(offsetRadians, offsetSeconds);
```

The sign is **apparent solar time minus mean solar time**. A positive result means the apparent Sun's time leads the mean-solar clock. The example date produces about **+13 minutes 42.6 seconds** with `e`, as checked by the local test. Convert radians to seconds of time with `radians × 43200 / π`; the same factor is used by `toSecondsOfTime`.

## Two chapter formulas

`e(jde)` evaluates the longer chapter expression. It combines a mean-solar-longitude polynomial with the VSOP87E-based geocentric solar position, nutation, low-order solar aberration, and the resulting apparent right ascension. Its returned angle is wrapped to `[-π, π)` so the solar-longitude wrap does not cause a discontinuity at 0°. It does not receive a site or a `Time` object.

`eSmart(jde)` evaluates the shorter eccentricity-and-obliquity approximation without a VSOP87E solar-position evaluation. It returns an angle in radians with the same sign convention; the function does **not** normalize the result. `Sunrise.Sunrise` uses this shorter value to estimate solar noon and the surrounding events. The two formulas agree closely in the chapter test case, but the tests do not establish a uniform difference or accuracy bound across epochs.

The [Season Instants and Equation of Time]({% link astronomy/season-instants-and-equation-of-time.md %}) topic documents the separate `equationOfTime(time, apparentSunRightAscension)` contract. It takes a `Time` and an apparent solar right ascension of date, then combines Greenwich apparent sidereal time with the UT1 day fraction. Select that function when those time-scale and coordinate inputs are already part of the workflow.

## Related topics

- [Meeus Solar Coordinates]({% link astronomy/meeus-algorithms/solar-coordinates.md %}) supplies the geocentric solar reduction used by `e`.
- [Meeus Solar Day Clock]({% link astronomy/meeus-algorithms/solar-day-clock.md %}) uses `eSmart` for its daily solar events.
- [Meeus Calendar]({% link astronomy/meeus-algorithms/calendar.md %}) explains numeric TT JDE and its conversion to calendar labels.
