---
title: Local Horizon Coordinates
layout: default
parent: Coordinates and Observers
grand_parent: Astronomy
nav_order: 180
description: Converts equatorial right ascension and declination to geometric azimuth and altitude using a supplied local sidereal angle.

doc_kind: topic

sources:
    - src/astronomy/coordinates/coordinate.ts

api:
    - equatorialToHorizontal
    - horizontalToEquatorial
---

# Local Horizon Coordinates

`equatorialToHorizontal` converts an equatorial direction to local azimuth and altitude with spherical trigonometry. `horizontalToEquatorial` reverses the conversion. Use this pair when the equatorial direction and local sidereal time have already been chosen consistently and a geometric horizon direction is needed.

## Basic usage

```ts
import { equatorialToHorizontal, horizontalToEquatorial } from '../src/astronomy/coordinates/coordinate';
import { deg, toDeg } from '../src/math/units/angle';

const latitude = deg(-23.55); // geodetic latitude, north-positive
const lst = deg(140); // local sidereal angle for the input equatorial axes
const rightAscension = deg(95);
const declination = deg(-16.7);

const [azimuth, altitude] = equatorialToHorizontal(rightAscension, declination, latitude, lst);
const [recoveredRa, recoveredDec] = horizontalToEquatorial(azimuth, altitude, latitude, lst);
console.log(toDeg(azimuth), toDeg(altitude), toDeg(recoveredRa), toDeg(recoveredDec));
```

All arguments and results are **radians**. Azimuth is measured from **north through east** and returned in `[0, 2π)`; altitude is measured above the local horizon, with negative values below it. Right ascension from the inverse is normalized to `[0, 2π)`. Latitude is north-positive geodetic latitude. The functions do not take a `Time` or observer longitude: the caller supplies the **local sidereal angle** `lst`.

## Equatorial convention and limits

The hour angle used internally is `lst − rightAscension`, positive toward the west. The forward calculation uses this angle, declination, and latitude to find altitude and azimuth; the inverse recovers hour angle and then right ascension. Match the input right ascension's equinox and equator to the sidereal angle. For a true equator-and-equinox-of-date direction, use local apparent sidereal time; for a mean-of-date direction, use the corresponding mean sidereal time. [Geographic Observer]({% link astronomy/coordinates-and-observers/geographic-observer.md %}) documents `localSiderealTime` and its `mean` option.

These functions perform **geometric spherical conversion**. They do not themselves calculate precession, nutation, parallax, polar motion, or atmospheric refraction. A supplied sidereal angle can already reflect Earth-orientation choices made elsewhere. An ICRS/J2000 catalog direction needs the appropriate reduction before pairing it with a date-dependent sidereal angle. For a stellar observed place including topocentric and optional refractive effects, use [Topocentric Observed Place]({% link astronomy/coordinates-and-observers/topocentric-observed-place.md %}).

The inverse round-trips regular directions to floating-point precision, including directions below the horizon. At zenith or nadir, azimuth has no geometric meaning; near a pole, some angular coordinates are likewise singular. The implementation uses `atan2` and clamps the inverse-sine inputs to keep computed angles finite at these boundaries, but a finite azimuth there is a convention of the calculation rather than a unique physical direction.

## Related topics

- [Spherical Coordinate Conversions]({% link astronomy/coordinates-and-observers/spherical-coordinate-conversions.md %}) covers equatorial, ecliptic, and Galactic axes and angular separation.
- [Refractive Displacement]({% link astronomy/coordinates-and-observers/refractive-displacement.md %}) adds an atmospheric altitude correction when that model is appropriate.
