---
title: Meeus Angular Semidiameters
layout: default
parent: Meeus Algorithms
grand_parent: Astronomy
nav_order: 350
description: Estimates apparent angular radii of Solar System bodies and asteroids from their distances.

doc_kind: topic

sources:
    - src/astronomy/ephemeris/meeus.ts

api:
    - Semidiameter
---

# Meeus Angular semidiameters

An angular **semidiameter** is a body's apparent radius on the sky. `Semidiameter` estimates disk size from a distance or a tabulated radius. Use the angular radius for limb geometry; double it when an angular diameter is required. Distances passed to these functions are in **AU**, and angular results are in **radians**.

## Basic usage

```ts
import { Semidiameter } from '../src/astronomy/ephemeris/meeus';
import { toArcsec } from '../src/math/units/angle';

const sunRadius = Semidiameter.semidiameter(Semidiameter.SUN, 1);
const asteroidRadius = Semidiameter.asteroid(100, 1);
console.log(toArcsec(sunRadius), toArcsec(asteroidRadius));
```

At these distances, the example gives about `959.63″` and `0.0689″`, respectively. The asteroid input `100` is its **physical diameter in kilometers**; the result is its angular radius.

## Unit-distance and asteroid estimates

`Semidiameter` provides reference angular radii at **1 AU**, including `SUN = 959.63″`, `VENUS_SURFACE = 8.34″`, `VENUS_CLOUD = 8.41″`, and separate equatorial and polar values for Jupiter and Saturn. `Semidiameter.semidiameter(s0, delta)` scales any such reference angle by `s0 / delta`, where `delta` is the observer–body distance in AU. For a spherical body this is the chapter's inverse-distance approximation, rather than an exact inverse-sine calculation.

`Semidiameter.saturnApparentPolar(delta, B)` accounts for Saturn's projected oblateness. `B` is the Saturnicentric latitude of the observer relative to the ring plane, in radians. The result is the apparent **polar** angular radius: at `B = 0` it uses the polar reference radius, and at `|B| = π/2` it uses the equatorial one. The companion `SATURN_EQUATORIAL` reference can be scaled with `semidiameter`.

For an asteroid, `Semidiameter.asteroidDiameter(H, A)` estimates **physical diameter in kilometers** from absolute magnitude `H` and positive geometric albedo `A`. It implements `10^(3.12 − 0.2H − 0.5 log10 A)`. The estimate depends on the supplied albedo. `Semidiameter.asteroid(d, delta)` then uses `d / (2 · delta · AU_KM)` to estimate angular radius in radians from diameter `d` in kilometers and distance `delta` in AU; it uses the small-angle approximation.

## Limits and related topics

The tabulated radii and inverse-distance scaling are Meeus reference estimates. The asteroid diameter additionally depends on an assumed albedo, while its angular radius assumes a distant, small body.

- [Solar Parallax and Semidiameter]({% link astronomy/solar-parallax-and-semidiameter.md %}) explains the standalone solar radius and parallax helpers.
- [Lunar Parallax and Semidiameter]({% link astronomy/lunar-parallax-and-semidiameter.md %}) covers the geocentric and topocentric Moon, including crescent width.
- [Meeus Saturn Ring Geometry]({% link astronomy/meeus-algorithms/saturn-ring-geometry.md %}) supplies the Saturnicentric ring latitude used for the projected polar radius.
