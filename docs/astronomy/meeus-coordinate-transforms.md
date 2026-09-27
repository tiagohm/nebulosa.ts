---
title: Meeus Coordinate Transforms
layout: default
parent: Astronomy
nav_order: 260
description: Converts chapter-style ecliptic, equatorial, horizontal, and B1950 Galactic angles.

doc_kind: topic

sources:
    - src/astronomy/ephemeris/meeus.ts

api:
    - Coords
---

# Meeus Coordinate Transforms

`Coords` converts spherical angles between ecliptic and equatorial, equatorial and horizontal, or B1950 equatorial and Galactic coordinates. Use these chapter-style formulas when you already have the required obliquity, Greenwich sidereal time, and observer angles. The functions return new **two-angle arrays** in radians; they do not calculate an observing epoch or transform a Cartesian state.

## Basic usage

```ts
import { Coords } from '../src/astronomy/ephemeris/meeus';
import { deg } from '../src/math/units/angle';

const [eclipticLongitude, eclipticLatitude] = Coords.equatorialToEcliptic(deg(120), deg(20), deg(23.4392911));
const [rightAscension, declination] = Coords.eclipticToEquatorial(eclipticLongitude, eclipticLatitude, deg(23.4392911));
console.log(eclipticLongitude, eclipticLatitude, rightAscension, declination);
```

`eclipticToEquatorial(longitude, latitude, obliquity)` returns `[RA, Dec]`, with RA normalized to **[0, 2π)**. `equatorialToEcliptic(RA, Dec, obliquity)` returns `[longitude, latitude]`, with longitude in **[−π, π]**. Longitude is east-positive. The caller supplies the obliquity appropriate to the same equator and ecliptic as the coordinates; these functions do not precess from one epoch to another.

## Horizontal and Galactic conventions

`equatorialToHorizontal(RA, Dec, longitude, latitude, st)` and `horizontalToEquatorial(azimuth, altitude, longitude, latitude, st)` take observer **west-positive longitude** and north-positive latitude in radians. `st` is **Greenwich sidereal seconds of time**, not radians. Azimuth is **zero at south and increases toward west**, with a returned range of **[−π, π]**; altitude is in radians. The supplied sidereal time must match the equatorial coordinates' mean or apparent convention. The reverse function normalizes RA to `[0, 2π)`.

`equatorialToGalactic` assumes equatorial coordinates referred to **B1950.0** and returns `[Galactic longitude, Galactic latitude]` in radians, with longitude in `[0, 2π)`. `galacticToEquatorial` returns B1950.0 `[RA, Dec]`. The fixed reference values are Galactic north pole RA **12h49m**, Dec **27.4°**, and longitude origin offset **33°**. Passing J2000 or ICRS coordinates without an appropriate frame conversion changes the represented direction.

## Limits

These routines rotate directions using supplied angles. They do not apply parallax, aberration, refraction, or observer-position corrections. At a pole, the corresponding longitude or RA is geometrically undefined; at zenith or nadir, horizontal azimuth is undefined. The functions still return numeric angles from their `atan2` expressions, so do not interpret those singular components as a unique direction.

## Related topics

- [Spherical Coordinate Conversions]({% link astronomy/coordinates-and-observers/spherical-coordinate-conversions.md %}) describes the library's general coordinate conventions.
- [Local Horizon Coordinates]({% link astronomy/coordinates-and-observers/local-horizon-coordinates.md %}) converts equatorial and horizon directions using library-facing azimuth conventions.
- [Meeus Sidereal Time]({% link astronomy/meeus-sidereal-time.md %}) supplies Greenwich sidereal seconds for a numeric Julian day.
