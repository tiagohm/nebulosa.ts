---
title: Earth Rotation and Orientation
layout: default
parent: Time and Earth Orientation
grand_parent: Astronomy
nav_order: 20
description: Computes sidereal angles, precession and nutation, polar motion, and celestial-to-terrestrial rotations for an astronomical instant.

doc_kind: topic

sources:
    - src/astronomy/time/time.ts
    - src/astronomy/coordinates/erfa/erfa.ts

api:
    - greenwichApparentSiderealTime
    - greenwichMeanSiderealTime
    - equationOfEquinoxes
    - earthRotationAngle
    - meanObliquity
    - trueObliquity
    - nutationAngles
    - precessionMatrix
    - precessionNutationMatrix
    - cirsRotationMatrix
    - equationOfOrigins
    - pmAngles
    - pmMatrix
    - gcrsToItrsRotationMatrix
    - trueEclipticRotation
    - instantaneousEarthRotationMatrix
    - instantaneousEarthAngularVelocity
    - PolarMotion
    - NO_POLAR_MOTION
---

# Earth Rotation and Orientation

These functions evaluate the orientation of the Earth at a `Time`: Greenwich sidereal angles, precession and nutation, polar motion, and rotations between celestial and terrestrial axes. Use them when a direction or geocentric position needs an Earth-fixed orientation, or when an observing calculation needs an Earth-rotation angle.

## Background

Earth rotation is measured on UT1; precession, nutation, and obliquity are evaluated on TT. Each function accepts a `Time` on any supported scale and performs the required conversions. With the default providers, the angles and celestial matrices use the IAU 2006/2000A models implemented by ERFA routines in this repository.

`greenwichMeanSiderealTime` (GMST) refers to the mean equinox, while `greenwichApparentSiderealTime` (GAST) refers to the true equinox. `equationOfEquinoxes` is **GAST − GMST**, normalized to (−π, π]. `earthRotationAngle` (ERA) is the CIO-based rotation angle, so it is not interchangeable with GAST in an equinox-based matrix.

With the default providers, GAST, GMST, and ERA are normalized to [0, 2π). A custom provider can return a different range.

The equinox-based `precessionNutationMatrix` and CIO-based `cirsRotationMatrix` use different right-ascension origins. Choose the matrix that matches the next coordinate operation. In particular, `gcrsToItrsRotationMatrix` assembles an equinox-based rotation from precession-nutation, GAST, and polar motion.

## Basic usage

```ts
import { earthRotationAngle, equationOfEquinoxes, gcrsToItrsRotationMatrix, greenwichApparentSiderealTime, timeYMDHMS, Timescale } from '../src/astronomy/time/time';
import { matMulVec, matTransposeMulVec } from '../src/math/linear-algebra/mat3';

const instant = timeYMDHMS(2020, 10, 7, 12, 0, 0, Timescale.UTC);
const gast = greenwichApparentSiderealTime(instant); // radians
const era = earthRotationAngle(instant); // radians
const equinoxCorrection = equationOfEquinoxes(instant); // GAST − GMST, radians

const rotation = gcrsToItrsRotationMatrix(instant);
const itrsDirection = matMulVec(rotation, [1, 0, 0]); // unitless GCRS direction → ITRS
const gcrsDirection = matTransposeMulVec(rotation, itrsDirection); // inverse rotation
```

The matrix rotates a geocentric vector without translating its origin. It preserves the input's distance unit; the example uses a unitless direction. `gast`, `era`, and `equinoxCorrection` are separate angles with different reference origins.

## API

All angles are radians. The returned `Mat3` values are flat, row-major 3 × 3 matrices acting on column vectors through `matMulVec`. The model descriptions below apply to the default providers; `Time.providers` can replace calculations where an override is available.

| Function                              | Result and interpretation                                                                                                     |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `greenwichApparentSiderealTime(time)` | GAST from UT1 and TT.                                                                                                         |
| `greenwichMeanSiderealTime(time)`     | GMST from UT1 and TT.                                                                                                         |
| `equationOfEquinoxes(time)`           | Signed GAST − GMST in (−π, π].                                                                                                |
| `earthRotationAngle(time)`            | ERA from UT1.                                                                                                                 |
| `meanObliquity(time)`                 | Mean ecliptic obliquity from TT.                                                                                              |
| `nutationAngles(time)`                | `[Δψ, Δε]`: nutation in longitude and obliquity from TT.                                                                      |
| `trueObliquity(time)`                 | Mean obliquity + Δε.                                                                                                          |
| `precessionMatrix(time)`              | GCRS-to-mean-equator-and-equinox-of-date bias-precession matrix from TT.                                                      |
| `precessionNutationMatrix(time)`      | Equinox-based GCRS-to-true-equator-and-equinox matrix, including frame bias.                                                  |
| `cirsRotationMatrix(time)`            | CIO-based GCRS-to-CIRS matrix from TT.                                                                                        |
| `trueEclipticRotation(time)`          | GCRS-to-true-ecliptic-of-date rotation, using true obliquity and the precession-nutation matrix.                              |
| `equationOfOrigins(time)`             | A **matrix**, constructed as `matRotZ(GAST − ERA) · precessionNutationMatrix(time)`; it is not the equation-of-origins angle. |
| `pmAngles(time, pm?)`                 | `[s′, x, y]`: TIO locator and polar-motion angles. `s′` uses TT; the selected `pm` receives the supplied `Time`.              |
| `pmMatrix(time, pm?)`                 | Polar-motion matrix built from `[s′, x, y]`.                                                                                  |
| `gcrsToItrsRotationMatrix(time)`      | GCRS-to-ITRS rotation including precession-nutation, GAST, and polar motion.                                                  |

`pm` is a `PolarMotion` function `(time: Time) => [x, y]`. `NO_POLAR_MOTION` supplies `[0, 0]`; it does not suppress the TIO locator `s′`. When `pm` is omitted, `pmAngles` and `pmMatrix` choose `time.providers?.pm`, then `TIME_PROVIDERS.pm`. Their caches distinguish the selected polar-motion function.

### Rotation rate

`instantaneousEarthRotationMatrix(time)` returns `W = (dR/dt) · Rᵀ`, where `R` is `gcrsToItrsRotationMatrix(time)`. It estimates the derivative with a centered difference at ±1/86400 day in the input `Time` scale, so its elements are per day of that scale. Multiplying `W` by an ITRS position gives the rotating-frame velocity term in the position's distance unit per day.

`instantaneousEarthAngularVelocity(time)` extracts the Earth-rotation vector in ITRS, in radians per day of the input scale. For current dates with the default models, its dominant `z` component is positive. With the row-major matrix convention used here, `W · r ≈ −ω × r` for smooth orientation models; the difference is the symmetric part introduced by the finite difference. Use `W` when the desired quantity is the rotating-frame velocity term.

## Providers and cached results

`Time.providers` can replace GAST, GMST, ERA, obliquity, nutation, precession, precession-nutation, the TIO locator, the polar-motion function, and the polar-motion matrix. Unspecified fields use `TIME_PROVIDERS`. The default orientation providers call ERFA `eraGst06a`, `eraGmst06`, `eraEra00`, `eraObl06`, `eraNut06a`, `eraPmat06`, `eraPnm06a`, `eraSp00`, and `eraPom00`. `cirsRotationMatrix` calls `eraC2i06a` on TT directly; overriding `pnm` does not replace that CIRS calculation.

The default polar-motion function reads the shared IERS tables. Before a bulletin is loaded, its `x` and `y` are zero, and the default UT1 − UTC offset is zero. Thus an unloaded table provides a model fallback, not a measured Earth orientation. Load the needed Earth-orientation data and set provider overrides before evaluating the rotation. Derived values are cached on the `Time`; use a fresh `Time` after changing providers or loading different IERS data.

## Accuracy and limitations

{: .accuracy }
With the default providers, the celestial models are the bundled ERFA IAU 2006/2000A implementations. The orientation also depends on the supplied UT1 − UTC and polar-motion data. No overall accuracy bound is assigned here to an orientation computed without current Earth-orientation parameters.

{: .important }
`gcrsToItrsRotationMatrix` returns a cached matrix. Treat it and the other cached matrices and angle tuples as read-only; mutating one changes later results read from the same `Time`.

## Related topics

- [Astronomical Time Scales]({% link astronomy/time-and-earth-orientation/astronomical-time-scales.md %}) explains `Time`, UT1, TT, and provider storage.

## References

- The bundled ERFA/SOFA routines `eraGst06a`, `eraGmst06`, `eraEra00`, `eraPnm06a`, `eraC2i06a`, and `eraC2teqx` implement the orientation models and matrix composition described here.
