---
title: IAU Body Orientation
layout: default
parent: Astronomy
nav_order: 210
description: Evaluates tabulated IAU pole and prime-meridian elements and builds rotating body-fixed frames.

doc_kind: topic

sources:
    - src/astronomy/bodies/orientation.ts
    - src/astronomy/bodies/orientation.data.ts

api:
    - RotationElements
    - orientation
    - bodyFixedMatrix
    - bodyFixedFrame
    - MOON_ROTATION
    - JUPITER_ROTATION
    - JUPITER_SYSTEM_I
    - JUPITER_SYSTEM_II
---

# IAU Body Orientation

These IAU/WGCCRE rotation elements describe a body's north pole and prime meridian as functions of time. Use `orientation` for those angles, `bodyFixedMatrix` to rotate an ICRF-oriented vector into body-fixed axes, or `bodyFixedFrame` when a position and velocity must include the body's rotation. The built-in tables provide an analytical orientation without loading a binary PCK.

## Basic usage

```ts
import { bodyFixedFrame, bodyFixedMatrix, MARS_ROTATION, orientation } from '../src/astronomy/bodies/orientation';
import { timeYMDHMS, Timescale } from '../src/astronomy/time/time';
import { matMulVec } from '../src/math/linear-algebra/mat3';
import { toDeg } from '../src/math/units/angle';

const instant = timeYMDHMS(2000, 1, 1, 12, 0, 0, Timescale.TDB);
const angles = orientation(MARS_ROTATION, instant);
const fixedDirection = matMulVec(bodyFixedMatrix(MARS_ROTATION, instant), [1, 0, 0]);
const frame = bodyFixedFrame(MARS_ROTATION);
console.log(toDeg(angles.poleRa), toDeg(angles.poleDec), toDeg(angles.primeMeridian));
console.log(fixedDirection, frame.dRdtTimesRtAt?.(instant));
```

At J2000, the Mars table gives pole right ascension `317.68143°`, declination `52.8865°`, and prime-meridian angle `176.63°`. The example's `[1, 0, 0]` is an illustrative direction in ICRF-oriented axes; it is not a Mars position.

## Time and rotation conventions

`orientation(elements, time)` converts the supplied `Time` to **TDB**. Let `d` be TDB days from J2000 and `T = d / 36525` be Julian centuries. The table evaluates pole right ascension `α(T)`, pole declination `δ(T)`, and prime-meridian angle `W(d) = W₀ + rotationRate · d`, plus any listed periodic corrections. The returned angles are radians: `poleRa` and `primeMeridian` are wrapped to `[0, 2π)`; `poleDec` is the evaluated polynomial and periodic sum, without a wrap or clamp.

`RotationElements` stores polynomial coefficients for `poleRa` and `poleDec` in radians, `primeMeridian` in radians at J2000, and `rotationRate` in radians per day. Optional `PeriodicTerm` corrections use radian amplitudes and arguments with rates in radians per Julian century. A negative `rotationRate` describes a retrograde prime meridian, as in the Venus and Uranus tables.

`bodyFixedMatrix(elements, time)` returns the rotation `R₃(W) · R₁(π/2 − δ) · R₃(π/2 + α)`. It maps ICRF/GCRS-oriented Cartesian components into the body's rotating axes, with **+Z along the model north pole** and **+X toward the prime meridian**. It rotates a direction or body-relative vector; it does not translate a position to the body center.

`bodyFixedFrame(elements)` returns a `Frame` whose `rotationAt(time)` uses that same matrix. Its `dRdtTimesRtAt(time)` is the analytic skew-symmetric operator `W = (dR/dt)Rᵀ` in **radians per day**, including the pole, meridian, and periodic-term derivatives. For a body-relative state, the frame contract transports velocity as `v_fixed = R v_base + W p_fixed`. The optional precomputed rotation argument accepted by the general `Frame` interface is not used by this analytic operator.

## Built-in models and limits

The tables include the Sun, Mercury, Venus, Earth, Mars, Jupiter, Saturn, Uranus, Neptune, and Moon. `JUPITER_ROTATION` uses the System III meridian; `JUPITER_SYSTEM_I` and `JUPITER_SYSTEM_II` share its pole but use different meridian offsets and rotation rates for equatorial and temperate cloud features. Their meridians also feed `jupiterCentralMeridian`.

Jupiter's pole terms, Neptune's periodic term, and the Moon's E1–E13 terms are included. The Mercury table omits small periodic `W` corrections, the Mars table omits the 2015 periodic refinements, and the lunar table omits its tiny quadratic `W` term. These are tabulated analytical models with no uniform accuracy bound established by the repository tests. Use a suitable binary PCK when its coverage and orientation model are required. For precise terrestrial frames, use the Earth-orientation and polar-motion path instead of treating the cartographic `EARTH_ROTATION` table as ITRS.

## Related topics

- [Binary PCK Rotation]({% link astronomy/binary-pck-rotation.md %}) evaluates kernel-defined body orientation and rotation rate.
- [Planetary Surface Locations]({% link astronomy/coordinates-and-observers/planetary-surface-locations.md %}) uses a rotating frame for body-relative surface states.
- [Earth Rotation and Orientation]({% link astronomy/time-and-earth-orientation/earth-rotation-and-orientation.md %}) builds the terrestrial frame with Earth orientation data.
- [Meeus Lunar Libration and Surface Lighting]({% link astronomy/meeus-algorithms/lunar-libration-and-surface-lighting.md %}) uses a separate chapter 53 lunar-disk model.
