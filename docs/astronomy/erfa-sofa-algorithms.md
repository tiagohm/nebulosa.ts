---
title: ERFA / SOFA Algorithms
layout: default
parent: Astronomy
nav_order: 40
description: Uses the low-level era-prefixed astronomy routines for time scales, Earth orientation, astrometry, and related numerical recipes.

doc_kind: topic

sources:
    - src/astronomy/coordinates/erfa/erfa.ts
    - src/astronomy/coordinates/erfa/erfa.data.ts

api:
    - eraEra00
    - eraPnm06a
    - eraS2c
    - eraC2s
    - eraTaiUtc
    - eraStarpm
    - eraRefco
    - EraAstrom
    - LEAP_SECOND_CHANGES
---

# ERFA / SOFA Algorithms

The `era*` exports provide a low-level, SOFA/ERFA-style numerical surface. Use them when following a specific SOFA recipe, matching a reference test vector, or needing a routine that has no higher-level wrapper. The time, frame, and observed-place topics describe the library workflows that already compose many of these functions.

## Basic usage

```ts
import { eraEra00, eraPnm06a, eraS2c } from '../src/astronomy/coordinates/erfa/erfa';
import { timeYMDHMS, Timescale, tt, ut1 } from '../src/astronomy/time/time';
import { deg } from '../src/math/units/angle';

const observed = timeYMDHMS(2020, 1, 1, 0, 0, 0, Timescale.UTC);
const earthRotationTime = ut1(observed);
const dynamicalTime = tt(observed);

const earthRotationAngle = eraEra00(earthRotationTime.day, earthRotationTime.fraction);
const biasPrecessionNutation = eraPnm06a(dynamicalTime.day, dynamicalTime.fraction);
const direction = eraS2c(deg(40), deg(-10));
console.log(earthRotationAngle, biasPrecessionNutation, direction);
```

The date arguments shown here are **two-part Julian Dates**. `eraEra00` requires **UT1** and returns an Earth rotation angle in radians; `eraPnm06a` requires **TT** and returns the IAU 2006/2000A bias–precession–nutation matrix. `eraS2c` converts two angles in radians to a Cartesian unit direction. Pass each routine the time scale and units in its signature; these raw calls do not convert the example's UTC observation to UT1 or TT on their own. Keeping the two Julian Date parts separate preserves precision in the astronomical algorithms.

## Available families

| Family                     | Examples in this module                                       | Use                                                                                                               |
| -------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Calendar and time scales   | `eraCalToJd`, `eraTaiUtc`, `eraTtTdb`, `eraUt1Utc`            | Calendar conversion and individual time-scale steps; `LEAP_SECOND_CHANGES` supplies the built-in TAI−UTC history. |
| Earth orientation          | `eraEra00`, `eraGst06a`, `eraPnm06a`, `eraC2i06a`, `eraPom00` | Sidereal and Earth rotation angles, precession–nutation, intermediate axes, and polar motion.                     |
| Star and apparent place    | `eraStarpm`, `eraStarpv`, `eraAb`, `eraLdSun`                 | Catalog propagation, space-motion states, aberration, and gravitational deflection.                               |
| Geometry and atmosphere    | `eraS2c`, `eraC2s`, `eraGd2Gce`, `eraGc2Gde`, `eraRefco`      | Direction vectors, ellipsoidal geodesy, and refraction coefficients.                                              |
| Analytical planetary model | `eraPlan94`                                                   | Approximate planetary states from the ERFA model.                                                                 |

The table shows entry points for common recipes, not every export. `EraAstrom` is the mutable bundle of star-independent astrometry parameters consumed by several lower-level apparent-place routines. The coefficient arrays in `erfa.data.ts` support the algorithms; calling a routine does not require importing those tables separately. `eraEpv00` and `eraMoon98` reside in their own Earth and Moon modules rather than this file.

## Choosing the level of API

Use the higher-level time and coordinate functions when a complete time conversion, frame transform, or observed-place calculation is needed. A raw `era*` call generally represents one mathematical step, so the caller must choose the correct time scale, frame, units, and sequence of steps. For example, `eraTaiUtc` takes two TAI Julian Date parts and returns two UTC parts using the built-in leap-second table; it does not choose an Earth-orientation provider. Some routines accept mutable output arrays, while others allocate a result; consult the chosen function's signature when reusing buffers.

## Related topics

- [Astronomical Time Scales]({% link astronomy/time-and-earth-orientation/astronomical-time-scales.md %}) composes time-scale conversions.
- [Celestial and Terrestrial Reference Frames]({% link astronomy/coordinates-and-observers/celestial-and-terrestrial-reference-frames.md %}) composes rotations and velocity transport.
- [Topocentric Observed Place]({% link astronomy/coordinates-and-observers/topocentric-observed-place.md %}) combines astrometry and Earth orientation for an observer.
