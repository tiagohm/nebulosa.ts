---
title: Lunar Parallax and Semidiameter
layout: default
parent: Astronomy
nav_order: 280
description: Computes lunar horizontal parallax, geocentric and topocentric angular radius, and crescent width.

doc_kind: topic

sources:
    - src/astronomy/bodies/moon.ts

api:
    - moonParallax
    - moonSemidiameter
    - moonTopocentricSemidiameter
    - moonTopocentricSemidiameterApprox
    - crescentWidth
---

# Lunar Parallax and Semidiameter

These helpers turn an Earth–Moon distance into the Moon's equatorial horizontal parallax or angular radius. Use the geocentric radius for an Earth-centered diagram and a topocentric radius when the observer's position changes the apparent size. All distances passed to these functions are in **AU** and all angles are in **radians**.

## Basic usage

```ts
import { crescentWidth, moonParallax, moonSemidiameter, moonTopocentricSemidiameter } from '../src/astronomy/bodies/moon';
import { toArcsec } from '../src/math/units/angle';
import { kilometer } from '../src/math/units/distance';

const distance = kilometer(384400); // Geocentric Earth–Moon distance, AU
const parallax = moonParallax(distance);
const geocentricRadius = moonSemidiameter(distance);
// Equatorial observer with the Moon at the zenith: δ = H = 0, ρ sin φ = 0, ρ cos φ = 1.
const zenithRadius = moonTopocentricSemidiameter(distance, 0, 0, 0, 1);
const crescentWidth25 = crescentWidth(geocentricRadius, 0.25);
console.log(toArcsec(parallax), toArcsec(geocentricRadius), toArcsec(zenithRadius), toArcsec(crescentWidth25));
```

For this illustrative geometry, the output is approximately `3422.59″`, `932.55″`, `948.29″`, and `466.28″`. The zenith radius is larger because the surface observer is closer to the Moon than Earth's center.

## Distance and observer geometry

`moonParallax(distance)` returns `asin(Earth equatorial radius / distance)`, using an Earth equatorial radius of **6378.135 km**. The distance must exceed that radius. `moonSemidiameter(distance)` is the Meeus chapter 55 small-angle estimate `358473400 arcseconds · km / distance in kilometers`. Its result is the **geocentric** lunar angular radius, not a diameter.

`moonTopocentricSemidiameter(distance, declination, hourAngle, rhoSinPhi, rhoCosPhi)` uses the geocentric distance and direction, plus the observer's parallax constants, to compute the angular radius from that observer. The lunar physical radius is modeled as `0.272481` Earth equatorial radii. Its input geometry is:

| Parameter     | Unit / convention                | Meaning                                                                            |
| ------------- | -------------------------------- | ---------------------------------------------------------------------------------- |
| `distance`    | AU                               | Geocentric Earth–Moon distance.                                                    |
| `declination` | radians                          | Geocentric lunar declination.                                                      |
| `hourAngle`   | radians, positive westward       | Local lunar hour angle.                                                            |
| `rhoSinPhi`   | Dimensionless Earth-radius ratio | Observer's geocentric polar coordinate divided by Earth equatorial radius.         |
| `rhoCosPhi`   | Dimensionless Earth-radius ratio | Observer's distance from Earth's rotation axis divided by Earth equatorial radius. |

The last two values can be obtained from a `GeographicPosition` with `rhoSinPhi(location)` and `rhoCosPhi(location)`. They must describe the same site for which the local hour angle was calculated. The function assumes the observer is outside the Moon; its inverse-sine argument is capped at one against roundoff.

`moonTopocentricSemidiameterApprox(distance, altitude)` instead multiplies the geocentric angular radius by `1 + sin(altitude) · Earth radius / distance`. Give the Moon's **true geometric altitude** in radians, without atmospheric refraction. This first-order correction omits higher-order parallax terms and the observer's detailed position; use the full function when that geometry is available.

## Illuminated crescent width

`crescentWidth(semidiameter, illuminatedFraction)` returns `2 · semidiameter · illuminatedFraction`, an angular width in radians. Supply the angular radius in radians and an illuminated fraction from zero to one. It is a first-order geometric estimate of the span from bright limb to terminator, especially useful for a thin crescent. It does not calculate the phase or illuminated fraction itself.

## Accuracy and related topics

These functions evaluate the supplied distance and geometry; they do not find a lunar ephemeris or account for atmospheric refraction. The geocentric radius and altitude correction use approximations, so select the observer-based calculation when local limb size matters. No general numerical accuracy bound is supplied for this family.

- [Meeus Angular Semidiameters]({% link astronomy/meeus-algorithms/angular-semidiameters.md %}) gives unit-distance planetary radii and asteroid size estimates.
- [Meeus Lunar Illumination]({% link astronomy/meeus-algorithms/lunar-illumination.md %}) calculates an illuminated fraction for crescent-width estimates.
- [Meeus Topocentric Parallax]({% link astronomy/meeus-algorithms/topocentric-parallax.md %}) treats the change in lunar direction for an Earth observer.
