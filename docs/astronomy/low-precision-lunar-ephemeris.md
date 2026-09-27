---
title: Low-Precision Lunar Ephemeris
layout: default
parent: Astronomy
nav_order: 60
description: Computes an approximate geocentric Moon position and velocity from the ERFA Meeus-based lunar series.

doc_kind: topic

sources:
    - src/astronomy/coordinates/erfa/moon.ts

api:
    - eraMoon98
---

# Low-Precision Lunar Ephemeris

`eraMoon98` evaluates an approximate geocentric Moon state. It is the ERFA-style port of a Meeus lunar series based on ELP terms, useful when that level of analytical approximation is sufficient. The function evaluates its built-in series directly; it does not load a lunar SPK or select a different ephemeris model.

## Basic usage

```ts
import { eraMoon98 } from '../src/astronomy/coordinates/erfa/moon';
import { timeYMDHMS, Timescale, tt } from '../src/astronomy/time/time';
import { vecLength } from '../src/math/linear-algebra/vec3';
import { toKilometer } from '../src/math/units/distance';

const observed = timeYMDHMS(2020, 1, 1, 0, 0, 0, Timescale.UTC);
const date = tt(observed);
const [positionAu, velocityAuPerDay] = eraMoon98(date.day, date.fraction);
const geocentricDistanceKm = toKilometer(vecLength(positionAu));
console.log(positionAu, velocityAuPerDay, geocentricDistanceKm);
```

Pass the two parts of a **TT Julian Date** separately. The result is `[position, velocity]`, with position in **AU** and velocity in **AU/day**. Its origin is Earth's center; its axes are GCRS/ICRS-oriented. The example's distance is the length of this geocentric position vector, not a topocentric range from an observing site.

The evaluator forms the Moon's mean-ecliptic-of-date position and velocity from its periodic terms, then rotates both vectors into GCRS-oriented axes with the IAU 2006 Fukushima–Williams bias and precession angles. The returned state is geometric: it does not calculate light-time delay, an apparent direction, or an observed altitude. This compact model is distinct from the higher-detail ELP/MPP02 lunar theory and from a lunar SPK state. Keep its geocentric origin explicit when combining it with Earth or observer states.

## Related topics

- [ERFA / SOFA Algorithms]({% link astronomy/erfa-sofa-algorithms.md %}) describes the other low-level numerical routines.
- [Low-Precision Earth Ephemeris]({% link astronomy/low-precision-earth-ephemeris.md %}) provides approximate Earth states relative to the Sun and barycenter.
- [Apparent Direction]({% link astronomy/coordinates-and-observers/apparent-direction.md %}) applies observer geometry and light-time handling to supplied states.
