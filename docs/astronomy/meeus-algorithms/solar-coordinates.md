---
title: Meeus Solar Coordinates
layout: default
parent: Meeus Algorithms
grand_parent: Astronomy
nav_order: 150
description: Evaluates low-order and VSOP87E geocentric solar angles, distances, and rectangular vectors.

doc_kind: topic

sources:
    - src/astronomy/ephemeris/meeus.ts
    - src/astronomy/ephemeris/models/analytical/vsop87e.ts

api:
    - Solar
    - SolarXYZ
---

# Meeus Solar Coordinates

`Solar` supplies the chapter 25 geocentric Sun formulas, from short polynomials to a reduction of the VSOP87E Earth and Sun series. `SolarXYZ` provides geometric geocentric rectangular vectors in several equinoxes. Use these routines when reproducing Meeus solar calculations or when another chapter formula needs a geocentric Sun; they do not provide a surface observer's apparent place.

## Basic usage

```ts
import { Solar, SolarXYZ } from '../src/astronomy/ephemeris/meeus';

const jde = 2451545.0; // TT Julian ephemeris day, J2000
const T = 0; // TT Julian centuries from J2000
const [trueLongitude, trueAnomaly] = Solar.trueLongitude(T);
const [apparentRA, apparentDec, distanceAU] = Solar.apparentEquatorialVSOP87(jde);
const sunJ2000AU = SolarXYZ.positionJ2000(jde);
console.log(trueLongitude, trueAnomaly, apparentRA, apparentDec, distanceAU, sunJ2000AU);
```

The short polynomial functions take `T = (JDE_TT − 2451545.0) / 36525`, in **TT Julian centuries from J2000**. Functions taking `jde` instead receive a numeric **TT Julian ephemeris day**. Angles are radians, distances and Cartesian components are **AU**, and returned tuples and vectors are fresh values.

## Short chapter formulas

| Function                  | Result and convention                                                                                            |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `trueLongitude(T)`        | `[true longitude, true anomaly]` in radians, each wrapped to `[0, 2π)`; longitude uses the mean equinox of date. |
| `radius(T)`               | Approximate Sun–Earth distance in AU.                                                                            |
| `apparentLongitude(T)`    | Longitude in radians, wrapped to `[0, 2π)`, after the short nutation and aberration corrections.                 |
| `trueEquatorial(jde)`     | Geometric `[RA, Dec]` at the mean equator and equinox of date.                                                   |
| `apparentEquatorial(jde)` | Approximate apparent `[RA, Dec]` at the true equator and equinox of date.                                        |

The equatorial short formulas set solar ecliptic latitude to zero and wrap RA to `[0, 2π)`. `true2000(T)` gives the corresponding short longitude in a J2000 equinox convention, together with true anomaly. `meanAnomaly(T)` is an **unwrapped** angle; `eccentricity(T)` is dimensionless. Use these polynomials for chapter-level calculations, rather than substituting them for the VSOP-based variant.

## VSOP87E reduction

`trueVSOP87(jde)` returns geocentric `[longitude, latitude, distance]` in the **mean ecliptic and equinox of date**, with the Meeus solar FK5 correction but without nutation or aberration. It forms the Sun direction from the VSOP87E Earth state in Meeus's dynamical ecliptic J2000 axes and precesses to date. `apparentVSOP87(jde)` adds nutation in longitude and the low-order solar aberration term, returning ecliptic angles referred to the **true** equinox of date. `apparentEquatorialVSOP87(jde)` rotates that apparent direction to the **true equator and equinox of date** and returns `[RA, Dec, distance]`. Returned longitude and RA are wrapped to `[0, 2π)`.

`Solar.aberration(range)` returns the **negative** longitude correction `−20.4898″ / range` in radians for a positive Sun–Earth `range` in AU. This is the chapter's low-order correction, not a full observer-velocity aberration calculation.

## Rectangular solar vectors

| `SolarXYZ` function           | Geocentric vector axes                                                           |
| ----------------------------- | -------------------------------------------------------------------------------- |
| `xyz(jde)`                    | Dynamical ecliptic and equinox J2000.                                            |
| `position(jde)`               | Mean equator and equinox of date, FK5.                                           |
| `positionJ2000(jde)`          | Mean equator and equinox J2000, FK5.                                             |
| `positionB1950(jde)`          | Mean equator and equinox B1950 expressed by the Meeus FK5 rotation, **not FK4**. |
| `positionEquinox(jde, epoch)` | Mean equator and equinox of the supplied Julian `epoch` year, FK5.               |

Every vector is a newly allocated `[x, y, z]` in AU. `SolarXYZ.xyz` subtracts the Earth barycentric position from the Sun barycentric position at the **same TT instant**, with no light-time correction. `positionEquinox` precesses the J2000 vector with the chapter 21 polynomial; `epoch` is a Julian year, not a Julian day. These vectors are geometric; the apparent spherical functions above add different corrections.

## Accuracy and limits

The short polynomials and the VSOP87E reduction are different models. The tests compare both against selected Meeus examples, but do not establish one error bound for arbitrary epochs or a site-specific observed position. The VSOP path includes Meeus FK5, nutation, and low-order aberration where stated; it does not apply terrestrial parallax or atmospheric refraction. Choose an observer-aware reduction when those effects matter.

## Related topics

- [VSOP87E Planetary Theory]({% link astronomy/vsop87e-planetary-theory.md %}) describes the barycentric analytical series underlying this reduction.
- [Meeus Apparent Place of a Star]({% link astronomy/meeus-algorithms/apparent-place-of-a-star.md %}) uses a different aberration calculation for stars.
