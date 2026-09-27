---
title: Low-Precision Earth Ephemeris
layout: default
parent: Astronomy
nav_order: 50
description: Computes approximate barycentric and heliocentric Earth position-and-velocity states from ERFA's simplified VSOP2000 series.

doc_kind: topic

sources:
    - src/astronomy/coordinates/erfa/earth.ts

api:
    - eraEpv00
---

# Low-Precision Earth Ephemeris

`eraEpv00` evaluates an analytical Earth model and returns Earth states relative to the solar-system barycenter and the Sun. Use it when the precision of ERFA's simplified VSOP2000 solution is suitable and a kernel-derived Earth state is not required. The function evaluates this model on every call; it does not load an SPK or select between ephemeris providers.

## Basic usage

```ts
import { eraEpv00 } from '../src/astronomy/coordinates/erfa/earth';
import { tdb, timeYMDHMS, Timescale } from '../src/astronomy/time/time';

const observed = timeYMDHMS(2020, 1, 1, 0, 0, 0, Timescale.UTC);
const date = tdb(observed);
const [barycentricEarth, heliocentricEarth] = eraEpv00(date.day, date.fraction);
console.log(barycentricEarth, heliocentricEarth);
```

The arguments are the two parts of a **TDB Julian Date**. Pass `day` and `fraction` separately so the model can retain the precision of the split date. The return order is **`[barycentricEarth, heliocentricEarth]`**. Each element is `[position, velocity]`: position is in **AU** and velocity in **AU/day**, expressed on BCRS-oriented axes. The first state is relative to the solar-system barycenter; the second is relative to the Sun. To obtain the Sun's barycentric state from these vectors, subtract the heliocentric Earth state from the barycentric Earth state component by component.

The model is an ERFA adaptation of a simplified VSOP2000 solution. It is an approximate analytical ephemeris, not a JPL/SPK state. Choose an ephemeris source appropriate to the accuracy and time span of the intended calculation, and keep the origin of each returned state explicit when passing it to an observer, light-time, or apparent-place function.

## Related topics

- [ERFA / SOFA Algorithms]({% link astronomy/erfa-sofa-algorithms.md %}) covers the other low-level numerical routines.
- [Radial Velocity Correction]({% link astronomy/coordinates-and-observers/radial-velocity-correction.md %}) uses an Earth velocity relative to the desired reference origin.
- [Barycentric and Heliocentric Light-Time Correction]({% link astronomy/coordinates-and-observers/barycentric-and-heliocentric-light-time-correction.md %}) uses the corresponding Earth position.
