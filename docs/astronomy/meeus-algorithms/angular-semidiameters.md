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
    - src/astronomy/bodies/moon.ts

api:
    - Semidiameter
    - moonSemidiameter
    - moonParallax
    - moonTopocentricSemidiameter
    - moonTopocentricSemidiameterApprox
    - crescentWidth
---

# Meeus Angular semidiameters

An angular **semidiameter** is a body's apparent radius on the sky. These Meeus-style helpers estimate disk size from a distance, a tabulated radius, or a lunar observer geometry. Use the angular radius for limb geometry; double it when an angular diameter is required. Distances passed to these functions are in **AU**, and angular results are in **radians**.

## Basic usage

```ts
import { moonParallax, moonSemidiameter } from '../src/astronomy/bodies/moon';
import { sunSemidiameter } from '../src/astronomy/bodies/sun';
import { Semidiameter } from '../src/astronomy/ephemeris/meeus';
import { toArcsec } from '../src/math/units/angle';
import { kilometer } from '../src/math/units/distance';

const sunRadius = sunSemidiameter(1);
const lunarDistance = kilometer(384400);
const moonRadius = moonSemidiameter(lunarDistance);
const lunarHorizontalParallax = moonParallax(lunarDistance);
const asteroidRadius = Semidiameter.asteroid(100, 1);
console.log(toArcsec(sunRadius), toArcsec(moonRadius), toArcsec(lunarHorizontalParallax), toArcsec(asteroidRadius));
```

At these distances, the example gives about `959.63″`, `932.55″`, `3422.59″`, and `0.0689″`, respectively. The asteroid input `100` is its **physical diameter in kilometers**; the result is its angular radius.

## Unit-distance and asteroid estimates

`Semidiameter` provides reference angular radii at **1 AU**, including `SUN = 959.63″`, `VENUS_SURFACE = 8.34″`, `VENUS_CLOUD = 8.41″`, and separate equatorial and polar values for Jupiter and Saturn. `Semidiameter.semidiameter(s0, delta)` scales any such reference angle by `s0 / delta`, where `delta` is the observer–body distance in AU. For a spherical body this is the chapter's inverse-distance approximation, rather than an exact inverse-sine calculation.

`Semidiameter.saturnApparentPolar(delta, B)` accounts for Saturn's projected oblateness. `B` is the Saturnicentric latitude of the observer relative to the ring plane, in radians. The result is the apparent **polar** angular radius: at `B = 0` it uses the polar reference radius, and at `|B| = π/2` it uses the equatorial one. The companion `SATURN_EQUATORIAL` reference can be scaled with `semidiameter`.

For an asteroid, `Semidiameter.asteroidDiameter(H, A)` estimates **physical diameter in kilometers** from absolute magnitude `H` and positive geometric albedo `A`. It implements `10^(3.12 − 0.2H − 0.5 log10 A)`. The estimate depends on the supplied albedo. `Semidiameter.asteroid(d, delta)` then uses `d / (2 · delta · AU_KM)` to estimate angular radius in radians from diameter `d` in kilometers and distance `delta` in AU; it uses the small-angle approximation.

## Solar and lunar geometry

`sunSemidiameter(distance)` uses the same `959.63″ / distance` coefficient as `Semidiameter.SUN`. The separate [Solar Parallax and Semidiameter]({% link astronomy/solar-parallax-and-semidiameter.md %}) topic explains it alongside the Sun's horizontal parallax.

`moonSemidiameter(distance)` uses the chapter 55 coefficient `358473400 arcseconds · km` divided by the distance in kilometers. `moonParallax(distance)` computes the **equatorial horizontal parallax** as `asin(Earth equatorial radius / distance)`. Both take **geocentric** Earth–Moon distance in AU. `crescentWidth(semidiameter, illuminatedFraction)` returns the first-order width `2 · semidiameter · illuminatedFraction` in radians, with the illuminated fraction between zero and one.

For an Earth observer, `moonTopocentricSemidiameter(distance, declination, hourAngle, rhoSinPhi, rhoCosPhi)` computes the lunar angular radius from the observer–Moon geometry. Pass geocentric lunar distance in AU, declination and **westward** local hour angle in radians, and the observer's dimensionless parallax constants in Earth equatorial radii. The rigorous calculation uses a lunar radius of `0.272481` Earth equatorial radii. `moonTopocentricSemidiameterApprox(distance, altitude)` instead applies a first-order correction to `moonSemidiameter(distance)` using the Moon's **true geometric altitude** in radians; it omits higher-order parallax terms.

## Limits and related topics

The tabulated radii and inverse-distance scaling are Meeus reference estimates. The asteroid diameter additionally depends on an assumed albedo, while its angular radius assumes a distant, small body. The lunar topocentric calculations need an observer position or altitude; geocentric lunar semidiameter alone does not describe the disk as seen from a particular site.

- [Meeus Saturn Ring Geometry]({% link astronomy/meeus-algorithms/saturn-ring-geometry.md %}) supplies the Saturnicentric ring latitude used for the projected polar radius.
- [Meeus Lunar Illumination]({% link astronomy/meeus-algorithms/lunar-illumination.md %}) estimates the illuminated fraction used in crescent width.
- [Meeus Topocentric Parallax]({% link astronomy/meeus-algorithms/topocentric-parallax.md %}) transforms geocentric coordinates for a terrestrial observer.
