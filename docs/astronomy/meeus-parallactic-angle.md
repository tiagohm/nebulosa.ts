---
title: Meeus Parallactic Angle
layout: default
parent: Astronomy
nav_order: 300
description: Computes chapter-style parallactic and horizon-intersection angles from observer and sky geometry.

doc_kind: topic

sources:
    - src/astronomy/ephemeris/meeus.ts

api:
    - Parallactic
---

# Meeus Parallactic Angle

`Parallactic` evaluates the Meeus chapter 14 parallactic-angle formula and related ecliptic and diurnal-path geometry. Use these scalar formulas when the observer latitude and relevant sky angles are already known. Inputs and outputs are **radians**.

## Basic usage

```ts
import { Parallactic } from '../src/astronomy/ephemeris/meeus';
import { deg } from '../src/math/units/angle';

const latitude = deg(40);
const declination = deg(20);
const hourAngle = deg(30); // west of the meridian
const q = Parallactic.parallacticAngle(latitude, declination, hourAngle);
const atHorizon = Parallactic.parallacticAngleOnHorizon(latitude, declination);
console.log(q, atHorizon);
```

`parallacticAngle(phi, delta, H)` takes north-positive geographic latitude `phi`, equatorial declination `delta`, and **west-positive hour angle** `H = local sidereal angle − RA`. It returns the signed angle from `atan2(sin H, tan phi cos delta − sin delta cos H)` in `[-π, π]`; for the example above it is positive. The result is an angle, not an angular rate.

`parallacticAngleOnHorizon(phi, delta)` evaluates `acos(sin phi / cos delta)`, returning a principal angle in `[0, π]` when its argument lies in `[-1, 1]`. It does not distinguish the rising and setting sides of the horizon.

## Related horizon geometry

| Function                                 | Inputs in radians                                           | Return value                                                                                                    |
| ---------------------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `eclipticAtHorizon(epsilon, phi, theta)` | Ecliptic obliquity, observer latitude, local sidereal angle | `[lambda1, lambda2, inclination]`: two opposite ecliptic longitudes at the horizon and their intersection angle |
| `eclipticAtEquator(lambda, epsilon)`     | Ecliptic longitude, obliquity                               | Principal angle between the ecliptic and its latitude parallel                                                  |
| `diurnalPathAtHorizon(phi, delta)`       | Observer latitude, declination                              | Angle of the object's diurnal path relative to the horizon at rising or setting                                 |

`eclipticAtHorizon` selects its first intersection longitude in the half-circle from 0 to π and returns the opposite point as `lambda1 + π`. It does not normalize the latter independently. Its inclination is the principal angle returned by `acos`. These functions provide geometry from supplied angles; they do not calculate sidereal time, a rise/set event, or a field-rotation rate.

## Accuracy and limits

The parallactic orientation is physically undefined at the zenith even if the formula returns a numeric convention there. `parallacticAngleOnHorizon` and `eclipticAtHorizon` use inverse cosine without clamping; floating-point rounding or geometry outside their real domain can produce `NaN`. `diurnalPathAtHorizon` contains `sqrt(1 − (tan delta tan phi)²)`, so its result is not real when the object's diurnal circle does not cross the geometric horizon. None of these formulas includes atmospheric refraction or a finite target's topocentric parallax.

For sensor rotation or derotator commands on an alt-az mount, use the [Alt-Az Field Rotation]({% link astronomy/coordinates-and-observers/alt-az-field-rotation.md %}) topic, which supplies the rate and command conventions.

## Related topics

- [Local Horizon Coordinates]({% link astronomy/coordinates-and-observers/local-horizon-coordinates.md %}) describes observer-facing altitude, azimuth, and hour angle.
- [Meeus Coordinate Transforms]({% link astronomy/meeus-coordinate-transforms.md %}) converts chapter-style equatorial and horizontal coordinates.
