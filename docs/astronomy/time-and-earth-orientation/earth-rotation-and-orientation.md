---
title: Earth Rotation and Orientation
layout: default
parent: Time and Earth Orientation
grand_parent: Astronomy
nav_order: 20
description: Combines celestial rotation and polar motion into GCRS-to-ITRS orientation and instantaneous terrestrial spin.

doc_kind: topic

sources:
    - src/astronomy/time/time.ts

api:
    - pmAngles
    - pmMatrix
    - gcrsToItrsRotationMatrix
    - instantaneousEarthRotationMatrix
    - instantaneousEarthAngularVelocity
    - PolarMotion
    - NO_POLAR_MOTION
    - TIME_PROVIDERS
---

# Earth Rotation and Orientation

These functions orient geocentric GCRS vectors on Earth-fixed ITRS axes at a `Time`. The full rotation combines celestial precession-nutation, Greenwich apparent sidereal time, and polar motion. The instantaneous rotation helpers provide a rate for velocity transport at the same instant.

## Basic usage

```ts
import { gcrsToItrsRotationMatrix, instantaneousEarthAngularVelocity, pmAngles, timeYMDHMS, Timescale } from '../src/astronomy/time/time';
import { matMulVec, matTransposeMulVec } from '../src/math/linear-algebra/mat3';

const instant = timeYMDHMS(2020, 10, 7, 12, 0, 0, Timescale.UTC);
const rotation = gcrsToItrsRotationMatrix(instant);
const itrsDirection = matMulVec(rotation, [1, 0, 0]);
const gcrsDirection = matTransposeMulVec(rotation, itrsDirection);
const [sPrime, x, y] = pmAngles(instant);
const spin = instantaneousEarthAngularVelocity(instant);
console.log({ itrsDirection, gcrsDirection, sPrime, x, y, spin });
```

`rotation` is a flat, row-major 3 × 3 matrix acting on column vectors. It rotates a geocentric position or direction without changing its origin or distance unit. `pmAngles(time, pm?)` returns `[s′, x, y]` in radians: the TIO locator and polar-motion coordinates. `pmMatrix(time, pm?)` builds the associated polar-motion rotation. The `s′` model uses TT; the selected polar-motion function receives the supplied `Time`. `gcrsToItrsRotationMatrix` combines the equinox-based precession-nutation matrix, GAST, and the selected polar-motion matrix.

## Polar-motion providers

`PolarMotion` is a function `(time: Time) => [x, y]`. When `pm` is passed to `pmAngles` or `pmMatrix`, it selects that function. Otherwise they use `time.providers?.pm`, then `TIME_PROVIDERS.pm`. The default function reads the shared IERS tables; before an appropriate bulletin is loaded, its `x` and `y` are zero, which is a fallback rather than a measurement. `NO_POLAR_MOTION` explicitly supplies `[0, 0]`; it does not suppress the modeled TIO locator `s′`.

`TIME_PROVIDERS` also holds the default celestial orientation and sidereal providers used by the full rotation. `Time.providers` can override applicable stages. Cached polar-motion values distinguish the selected polar-motion function. Other derived values are cached on the `Time`; use a fresh `Time` after changing providers or loading different IERS data. Treat returned cached matrices and angle tuples as read-only because mutation affects later reads of that `Time`.

## Instantaneous rotation rate

Let `R` be `gcrsToItrsRotationMatrix(time)`. `instantaneousEarthRotationMatrix(time)` estimates `W = (dR/dt) · Rᵀ` from a centered ±1-second difference. Its matrix elements are per day of the input `Time` scale. Multiplying `W` by an ITRS position gives the rotating-frame velocity term in the position's distance unit per day.

`instantaneousEarthAngularVelocity(time)` extracts an ITRS vector in radians per day from the antisymmetric part of `W`. For current dates with the default models, its dominant `z` component is positive. With the row-major matrix convention here, `W · r ≈ −ω × r` for smooth orientation models; finite differencing can leave a small symmetric part. Use `W` when computing the rotating-frame velocity term.

## Accuracy and limits

The default celestial rotation uses the bundled ERFA IAU 2006/2000A implementation. Earth-fixed accuracy also depends on the selected UT1 − UTC and polar-motion data. Without current Earth-orientation parameters, the default UT1 − UTC and polar-motion values fall back to zero; no measured-orientation accuracy follows from that result.

The position rotation alone does not transport a full position–velocity state. Use the frame transformation API when the source or destination axes rotate and the velocity term matters.

## Related topics

- [Sidereal Time and Earth Rotation Angle]({% link astronomy/time-and-earth-orientation/sidereal-time-and-earth-rotation-angle.md %}) explains GAST, GMST, and ERA.
- [Precession, Nutation, and Obliquity]({% link astronomy/time-and-earth-orientation/precession-nutation-and-obliquity.md %}) supplies the celestial orientation.
- [Earth Orientation Parameters]({% link astronomy/time-and-earth-orientation/earth-orientation-parameters.md %}) loads the IERS data for UT1 − UTC and polar motion.
- [Celestial and Terrestrial Reference Frames]({% link astronomy/coordinates-and-observers/celestial-and-terrestrial-reference-frames.md %}) transports vectors and full states.
