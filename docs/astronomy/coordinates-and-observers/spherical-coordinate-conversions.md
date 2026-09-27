---
title: Spherical Coordinate Conversions
layout: default
parent: Coordinates and Observers
grand_parent: Astronomy
nav_order: 50
description: Converts equatorial, ecliptic, and Galactic angles and computes sky separation, position angle, and local reference directions.

doc_kind: topic

sources:
    - src/astronomy/coordinates/coordinate.ts

api:
    - angularDistance
    - angularDistanceHaversine
    - positionAngleBetween
    - equatorialFromJ2000
    - equatorialToJ2000
    - equatorialToEcliptic
    - eclipticToEquatorial
    - equatorialToEclipticJ2000
    - eclipticJ2000ToEquatorial
    - galacticToEquatorial
    - equatorialToGalactic
    - zenith
    - meridianEquator
    - meridianEcliptic
    - equatorEcliptic
---

# Spherical Coordinate Conversions

These functions convert angular positions among equatorial, ecliptic, and Galactic axes, or measure separation and position angle on the sky. Angle inputs and outputs are **radians**. Supply conversion inputs on the named source axes; compare two directions only when they share a reference frame and origin. The transforms rotate directions and do not add parallax, aberration, deflection, or refraction.

## Basic usage

```ts
import { angularDistance, equatorialFromJ2000, equatorialToEcliptic, equatorialToGalactic, positionAngleBetween } from '../src/astronomy/coordinates/coordinate';
import { timeYMDHMS, Timescale } from '../src/astronomy/time/time';
import { deg, normalizeAngle } from '../src/math/units/angle';

const instant = timeYMDHMS(2026, 1, 4, 23, 30, 0, Timescale.UTC);
const j2000 = [deg(101.2875), deg(-16.7251)] as const;
const [raOfDate, decOfDate] = equatorialFromJ2000(...j2000, instant);
const [eclipticLongitude, eclipticLatitude] = equatorialToEcliptic(raOfDate, decOfDate, instant);
const [galacticLongitude, galacticLatitude] = equatorialToGalactic(...j2000);
const displayedGalacticLongitude = normalizeAngle(galacticLongitude);
const separation = angularDistance(0, 0, deg(90), 0); // π/2 radians
const positionAngle = positionAngleBetween(0, 0, deg(90), 0); // east: π/2 radians
```

`equatorialFromJ2000` uses the precession-nutation matrix at `instant`; `equatorialToEcliptic` then rotates the resulting equator-of-date angles by the **true obliquity of that date**. The Galactic conversion instead uses the fixed J2000 matrix and the original J2000 angles. Use `normalizeAngle` when a nonnegative longitude is needed for display or indexing.

## Conversion families

| Functions                                                 | Input and operation                                                                                                                                                            |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `equatorialFromJ2000` / `equatorialToJ2000`               | Rotate between J2000-oriented and true equator-and-equinox-of-date angles with the precession-nutation matrix or its transpose. The `Time` is converted to TT for that matrix. |
| `equatorialToEcliptic` / `eclipticToEquatorial`           | Rotate between equator and ecliptic **of the same date** with `trueObliquity(time)`. They do not precess an input from another epoch.                                          |
| `equatorialToEclipticJ2000` / `eclipticJ2000ToEquatorial` | Rotate between J2000 equatorial and J2000 ecliptic axes using the fixed `ECLIPTIC_J2000_MATRIX`.                                                                               |
| `equatorialToGalactic` / `galacticToEquatorial`           | Rotate between J2000/ICRS-oriented equatorial and fixed Galactic axes with `GALACTIC_MATRIX`.                                                                                  |

Each result is a two-element `[longitude, latitude]` pair, or `[rightAscension, declination]` for equatorial output. The underlying Cartesian-to-spherical operation uses `atan2`, so a returned right ascension or longitude may be **negative**; these conversion functions do not normalize it to `[0, 2π)`. At and very near a pole, the Cartesian-to-spherical helper sets longitude to `0` when the squared transverse component is below machine epsilon. The J2000-to-date pair applies orientation alone, so it is not a complete observed-place or catalog reduction.

The date-dependent functions accept a `Time` on any supported scale and use the required TT conversion. Omitting `time` selects the current UTC clock via `timeNow(true)`; pass an explicit instant for reproducible results. Their results can also depend on the selected `Time` orientation providers.

## Sky geometry

`angularDistance(ra0, dec0, ra1, dec1)` returns separation in `[0, π]` using an `atan2` formulation that preserves small separations. `angularDistanceHaversine` is an alternative that clamps the haversine value before `asin`. Both operate on two directions in the **same** equatorial frame. `positionAngleBetween` returns the direction of the second point as seen from the first, measured from celestial north through east and normalized to `[0, 2π)`. If its two `atan2` terms are exactly zero, it returns `0`; the position angle is geometrically undefined for coincident points and can be sensitive near antipodes or poles.

## Local reference directions

These helpers return `[rightAscension, declination]` in the true equator-of-date frame. Longitude is the observer's east-positive terrestrial longitude; `zenith` uses the supplied observer latitude as its declination (geodetic latitude for an ellipsoid-normal zenith). Local apparent sidereal time (LAST) supplies the right ascension.

| Function                             | Returned direction                                                                                                        |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `zenith(longitude, latitude, time?)` | `[LAST, latitude]`, the local zenith direction.                                                                           |
| `meridianEquator(longitude, time?)`  | `[LAST, 0]`, where the local meridian meets the celestial equator.                                                        |
| `meridianEcliptic(longitude, time?)` | The ecliptic point on the local meridian: RA is LAST; declination uses true obliquity.                                    |
| `equatorEcliptic(longitude, time?)`  | The nearer equinox node, `[0, 0]` or `[π, 0]`. It selects the π node when LAST lies in `[π/2, 3π/2]`, including the ties. |

These are angular directions, not topocentric apparent positions; the functions do not apply atmospheric refraction or a physical observer displacement. As with the conversion functions, omitted `time` means the current UTC clock.

## Related topics

- [Celestial and Terrestrial Reference Frames]({% link astronomy/coordinates-and-observers/celestial-and-terrestrial-reference-frames.md %}) rotates Cartesian vectors and transports full velocities between frames.
- [Earth Rotation and Orientation]({% link astronomy/time-and-earth-orientation/earth-rotation-and-orientation.md %}) supplies precession-nutation, sidereal time, and true obliquity.
