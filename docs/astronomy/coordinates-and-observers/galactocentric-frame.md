---
title: Galactocentric Frame
layout: default
parent: Coordinates and Observers
grand_parent: Astronomy
nav_order: 30
description: Builds a fixed Galactocentric affine frame from a Galactic-center direction, distance, solar height, and roll.

doc_kind: topic

sources:
    - src/astronomy/coordinates/affine.ts

api:
    - GalactocentricParameters
    - GALACTOCENTRIC_DEFAULTS
    - galactocentricFrame
---

# Galactocentric Frame

`galactocentricFrame()` builds an [affine frame]({% link astronomy/coordinates-and-observers/affine-origin-frames.md %}) whose origin is the Galactic center. Use it to express an absolute Cartesian position or state on axes aligned with the Galactic center and north Galactic pole. The default distance is measured **from the Sun**, so positions supplied to this preset must also be relative to the Sun on ICRS-oriented axes. Shift a barycentric ephemeris position to a Sun-relative origin first.

## Basic usage

```ts
import { affineFromBase, affineToBase, galactocentricFrame } from '../src/astronomy/coordinates/affine';
import { timeYMDHMS, Timescale } from '../src/astronomy/time/time';
import { ONE_KILOPARSEC } from '../src/core/constants';
import type { Vec3 } from '../src/math/linear-algebra/vec3';

const frame = galactocentricFrame();
const instant = timeYMDHMS(2025, 9, 28, 12, 0, 0, Timescale.UTC);
const sunPosition: Vec3 = [0, 0, 0]; // Sun-relative ICRS axes, AU
const atSun = affineFromBase(sunPosition, frame, instant);
const atSunKpc = atSun.map((component) => component / ONE_KILOPARSEC);
const restored = affineToBase(atSun, frame, instant);
```

For the default geometry, `atSunKpc` is approximately `[-8.121973, 0, +0.0208]`. `restored` is near the Sun-relative origin, with finite-precision residuals. The frame's rotation and origin are fixed after construction; the `Time` argument is required by the affine-transform API but does not change this preset.

## Parameters and axes

`GalactocentricParameters` and `GALACTOCENTRIC_DEFAULTS` define the frame geometry:

| Property         | Meaning                                                                               | Default                    |
| ---------------- | ------------------------------------------------------------------------------------- | -------------------------- |
| `galcen`         | ICRS right ascension and declination of the Galactic center, in radians.              | `(266.4051°, −28.936175°)` |
| `galcenDistance` | Distance from the Sun to the Galactic center, in AU.                                  | `8.122 kpc`                |
| `zSun`           | Solar height above the Galactic midplane, positive toward north Galactic pole, in AU. | `20.8 pc`                  |
| `roll`           | Additional rotation about the Sun–Galactic-center line, in radians.                   | `0`                        |

With the default geometry, the Sun lies at negative x and positive z; positive z points toward Galactic north. The implementation uses `58.5986320306° − roll` for the x-axis alignment rotation, then applies the solar-height tilt. The geometry requires `galcenDistance > 0` and `|zSun / galcenDistance| ≤ 1` for the tilt calculation to remain defined.

The default geometric numbers match Astropy's `v4.0` Galactocentric parameter set. This library does **not** include Astropy's `galcen_v_sun` default in this frame: `galactocentricFrame()` supplies no origin-velocity offset. For a full state, `affineFromBase` rotates the supplied velocity but does not add the Sun's orbital or peculiar motion. Provide the velocity adjustment separately if the required result is a physical Galactocentric velocity rather than a velocity expressed on Galactocentric axes.

{: .important }
Pass absolute positions in AU, not unit directions. Input state velocities are AU/day. The translation is constructed from a Sun-to-center distance; passing a barycentric position directly would leave the Sun-to-barycenter offset in the result.

{: .accuracy }
The default origin offset is roughly 1.7 billion AU. Inverting the example's Sun position leaves component residuals around `10⁻⁷` AU from floating-point cancellation. Use a local origin when kilometer-scale precision near the Sun matters; this frame is intended for Galactic-scale positions.

## Related topics

- [Affine Origin Frames]({% link astronomy/coordinates-and-observers/affine-origin-frames.md %}) explains the position and velocity translation formulas and mutable outputs.
- [Celestial and Terrestrial Reference Frames]({% link astronomy/coordinates-and-observers/celestial-and-terrestrial-reference-frames.md %}) covers orientation-only transformations.

## References

- [Astropy Galactocentric frame defaults](https://docs.astropy.org/en/stable/api/astropy.coordinates.galactocentric_frame_defaults.html) lists the `v4.0` geometry and the solar-velocity default that this frame does not apply.
