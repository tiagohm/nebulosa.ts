---
title: Meeus Apparent Place of a Star
layout: default
parent: Meeus Algorithms
grand_parent: Astronomy
nav_order: 90
description: Reduces a mean stellar position to a chapter-style apparent place with precession, nutation, and annual aberration.

doc_kind: topic

sources:
    - src/astronomy/ephemeris/meeus.ts

api:
    - Apparent
---

# Meeus Apparent Place of a Star

`Apparent` applies the Meeus chapter 23 corrections to a star's mean equatorial coordinates. Use it for a textbook apparent place at a Julian epoch. The result is an equatorial right ascension and declination in radians; it is not a site-specific observed place.

## Basic usage

```ts
import { Apparent } from '../src/astronomy/ephemeris/meeus';
import { deg } from '../src/math/units/angle';

const meanRA = deg(40);
const meanDec = deg(20);
const apparent = Apparent.position(meanRA, meanDec, 2000, 2028);
const withRonVondrak = Apparent.positionRonVondrak(meanRA, meanDec, 2028);
console.log(apparent, withRonVondrak);
```

`position(ra, dec, epochFrom, epochTo, pmRA?, pmDEC?)` accepts mean equatorial coordinates at the **Julian epoch** `epochFrom`, applies proper motion and precession to `epochTo`, then adds nutation and the shorter annual-aberration correction at that date. Both epochs are Julian **years**, such as `2000` and `2028`, rather than Julian day numbers. Optional proper motions default to zero and are radians per Julian year; `pmRA` means dRA/dt, without a cos(declination) factor.

`positionRonVondrak(ra, dec, epochTo, pmRA?, pmDEC?)` instead requires mean equatorial **J2000** input. It advances proper motion and applies the Ron–Vondrák aberration series in J2000 axes, then precesses to the target Julian epoch and adds nutation of date. The two functions therefore differ in correction order and input epoch as well as in their aberration formulas. Each call returns a fresh `[rightAscension, declination]` pair in radians, with right ascension wrapped to `[0, 2π)`.

## Individual corrections

| Function                                       | Input coordinates                   | Result                                       |
| ---------------------------------------------- | ----------------------------------- | -------------------------------------------- |
| `nutation(ra, dec, jde)`                       | Mean equatorial coordinates of date | `[ΔRA, ΔDec]` in radians                     |
| `aberration(ra, dec, jde)`                     | Mean equatorial coordinates of date | Short-series annual `[ΔRA, ΔDec]` in radians |
| `aberrationRonVondrak(ra, dec, jde)`           | Equatorial J2000 coordinates        | Ron–Vondrák annual `[ΔRA, ΔDec]` in radians  |
| `eclipticAberration(longitude, latitude, jde)` | Ecliptic coordinates of date        | Annual `[Δlongitude, Δlatitude]` in radians  |

Here `jde` is a numeric **TT Julian ephemeris day**, unlike the Julian-year `epochTo` used by the position functions. The corrections are signed increments to add to the stated input coordinates. The short aberration formulas use the chapter's annual-aberration constant of 20.49552 arcseconds. `perihelion(T)` supplies the Earth's perihelion longitude in radians for `T` TT Julian centuries from J2000.

## Accuracy and limits

These are first-order angular corrections. The RA formulas divide by cos(declination), so use coordinates away from the celestial poles; `eclipticAberration` similarly divides by cos(latitude) and requires coordinates away from the ecliptic poles. The functions do not guard those singular regions or establish a uniform accuracy bound. Their returned coordinates do not include a terrestrial observer's location, parallax, or atmospheric refraction.

For an observed catalog star at a site, use the library's stellar observed-place path, which handles a different reduction model and observer geometry. `Apparent` is a Meeus calculation rather than an ERFA observed-place reduction.

## Related topics

- [Meeus Precession]({% link astronomy/meeus-algorithms/precession.md %}) describes the chapter's epoch transformation and proper-motion convention.
- [Meeus Nutation and Obliquity]({% link astronomy/meeus-algorithms/nutation-and-obliquity.md %}) describes the nutation angles used here.
- [Topocentric Observed Place]({% link astronomy/coordinates-and-observers/topocentric-observed-place.md %}) covers observer-based reductions.
