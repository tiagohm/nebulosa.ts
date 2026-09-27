---
title: Precession, Nutation, and Obliquity
layout: default
parent: Time and Earth Orientation
grand_parent: Astronomy
nav_order: 17
description: Evaluates the equator and ecliptic of date and the celestial rotation into equinox or CIO axes.

doc_kind: topic

sources:
    - src/astronomy/time/time.ts

api:
    - meanObliquity
    - trueObliquity
    - nutationAngles
    - precessionMatrix
    - precessionNutationMatrix
    - cirsRotationMatrix
    - trueEclipticRotation
---

# Precession, Nutation, and Obliquity

These functions give the time-dependent orientation of the celestial equator and ecliptic. Use their matrices to rotate a vector between GCRS-oriented axes and the equator or ecliptic of date. They change axes, not the vector's origin, and do not apply light time, aberration, parallax, or atmospheric refraction.

## Basic usage

```ts
import { cirsRotationMatrix, nutationAngles, precessionNutationMatrix, timeYMDHMS, Timescale, trueEclipticRotation } from '../src/astronomy/time/time';
import { matMulVec } from '../src/math/linear-algebra/mat3';

const instant = timeYMDHMS(2020, 10, 7, 12, 0, 0, Timescale.UTC);
const direction = [1, 0, 0] as const; // GCRS-oriented unit vector
const equinoxDirection = matMulVec(precessionNutationMatrix(instant), direction);
const cirsDirection = matMulVec(cirsRotationMatrix(instant), direction);
const eclipticDirection = matMulVec(trueEclipticRotation(instant), direction);
const [deltaPsi, deltaEpsilon] = nutationAngles(instant);
console.log({ equinoxDirection, cirsDirection, eclipticDirection, deltaPsi, deltaEpsilon });
```

The input `Time` may use any supported scale; the celestial models evaluate at TT. Angles are radians. Matrices are flat, row-major 3 × 3 rotations acting on column vectors, and preserve the distance unit of an input vector. `equinoxDirection` uses the true equator and equinox of date; `cirsDirection` uses the celestial intermediate origin (CIO), so the two directions differ in their right-ascension origin.

## Choosing a quantity

| Function                         | Result with the default providers                                                                         |
| -------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `meanObliquity(time)`            | Mean obliquity of the ecliptic, from TT.                                                                  |
| `nutationAngles(time)`           | `[Δψ, Δε]`, nutation in longitude and obliquity.                                                          |
| `trueObliquity(time)`            | Mean obliquity plus `Δε`.                                                                                 |
| `precessionMatrix(time)`         | GCRS-oriented axes to the mean equator and equinox of date, including frame bias.                         |
| `precessionNutationMatrix(time)` | GCRS-oriented axes to the true equator and equinox of date.                                               |
| `cirsRotationMatrix(time)`       | GCRS-oriented axes to CIO-based CIRS.                                                                     |
| `trueEclipticRotation(time)`     | GCRS-oriented axes to the true ecliptic of date, using the true obliquity and precession-nutation matrix. |

With the default providers, mean obliquity, nutation, precession, and precession-nutation use the bundled IAU 2006/2000A ERFA routines. `Time.providers` can override those individual quantities. `trueObliquity` combines the selected mean-obliquity and nutation results; `trueEclipticRotation` uses the selected true obliquity and precession-nutation matrix. `cirsRotationMatrix` calls the bundled `eraC2i06a` on TT directly, so a `pnm` provider override does not replace its CIRS result.

The equinox-based and CIO-based matrices represent different celestial origins. Keep the chosen origin consistent with the following sidereal or observed-place calculation. When a `Time` caches a matrix or angle tuple, treat that returned value as read-only; use a fresh `Time` if its providers change. The models specify orientation, but their accuracy in an Earth-fixed result also depends on UT1 and polar-motion data used later in the chain.

## Related topics

- [Sidereal Time and Earth Rotation Angle]({% link astronomy/time-and-earth-orientation/sidereal-time-and-earth-rotation-angle.md %}) supplies equinox-based sidereal angles and CIO-based ERA.
- [Earth Rotation and Orientation]({% link astronomy/time-and-earth-orientation/earth-rotation-and-orientation.md %}) composes the terrestrial rotation.
- [Celestial and Terrestrial Reference Frames]({% link astronomy/coordinates-and-observers/celestial-and-terrestrial-reference-frames.md %}) applies these rotations to vectors and states.
