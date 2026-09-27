---
title: Solar Parallax and Semidiameter
layout: default
parent: Astronomy
nav_order: 230
description: Scales the Sun's horizontal parallax and apparent angular radius with observer distance.

doc_kind: topic

sources:
    - src/astronomy/bodies/sun.ts

api:
    - sunParallax
    - sunSemidiameter
---

# Solar Parallax and Semidiameter

`sunParallax` and `sunSemidiameter` give two different angles for a supplied Sun–observer distance: the Sun's equatorial horizontal parallax and its apparent angular radius. Use the former for basic observer-displacement geometry and the latter to draw a solar limb or estimate an angular diameter. The input distance is in **AU**; both results are in **radians**.

## Basic usage

```ts
import { sunParallax, sunSemidiameter } from '../src/astronomy/bodies/sun';
import { toArcsec } from '../src/math/units/angle';

const distance = 1.0167; // Sun to observer, AU
const parallax = sunParallax(distance);
const radius = sunSemidiameter(distance);
console.log(toArcsec(parallax), toArcsec(radius), toArcsec(2 * radius));
```

At `1.0167 AU`, the values are about `8.65″` for horizontal parallax, `943.87″` for solar semidiameter, and `1887.73″` for angular diameter. The semidiameter is half the apparent diameter, while the parallax is the angle associated with shifting the observer by an Earth equatorial radius.

## Distance scaling and interpretation

| Function                    | Formula in radians                          | At 1 AU     |
| --------------------------- | ------------------------------------------- | ----------- |
| `sunParallax(distance)`     | `8.794143″ / distance` converted to radians | `8.794143″` |
| `sunSemidiameter(distance)` | `959.63″ / distance` converted to radians   | `959.63″`   |

Both functions scale fixed Meeus reference angles by inverse distance. They evaluate an angular approximation from the supplied scalar distance; they do not calculate a Sun–observer vector, a topocentric apparent place, atmospheric refraction, or a time-dependent solar radius. Supply a distance consistent with the geometry being drawn: an Earth-center distance for a geocentric diagram or a site-to-Sun distance for an observer-specific size estimate.

The returned angles are distinct from the Besselian umbral and penumbral radii `u` and `p` used in solar-eclipse circumstances, which are measured in **Earth equatorial radii** in the fundamental plane. These helpers also do not decide whether solar and lunar limbs touch in a local eclipse.

## Related topics

- [Meeus Angular Semidiameters]({% link astronomy/meeus-algorithms/angular-semidiameters.md %}) gives the Sun's unit-distance reference alongside planetary and lunar disk estimates.
- [Sub-Observer and Sub-Solar Points]({% link astronomy/sub-observer-and-sub-solar-points.md %}) uses body orientation to find the Sun-facing point on a rotating body.
