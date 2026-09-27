---
title: Geographic Sub-point
layout: default
parent: Coordinates and Observers
grand_parent: Astronomy
nav_order: 160
description: Converts a geocentric GCRS position into geodetic longitude, latitude, and ellipsoidal height.

doc_kind: topic

sources:
    - src/astronomy/observer/location.ts

api:
    - subpoint
---

# Geographic Sub-point

`subpoint(geocentric, time, ellipsoid?)` finds the geodetic longitude and latitude below a geocentric position at an instant. Use it for a satellite ground track or another finite Earth-centered position. It also returns the position's height above the selected ellipsoid.

## Basic usage

```ts
import { itrs } from '../src/astronomy/coordinates/itrs';
import { Ellipsoid, geodeticLocation, subpoint } from '../src/astronomy/observer/location';
import { gcrsToItrsRotationMatrix, timeYMDHMS, Timescale } from '../src/astronomy/time/time';
import { matTransposeMulVec } from '../src/math/linear-algebra/mat3';
import { deg, toDeg } from '../src/math/units/angle';
import { kilometer, toKilometer } from '../src/math/units/distance';

const time = timeYMDHMS(2026, 6, 29, 0, 0, 0, Timescale.UTC);
const satellite = geodeticLocation(deg(-70), deg(-30), kilometer(550), Ellipsoid.WGS84);
const geocentricGcrs = matTransposeMulVec(gcrsToItrsRotationMatrix(time), itrs(satellite));
const point = subpoint(geocentricGcrs, time, Ellipsoid.WGS84);

console.log(toDeg(point.longitude), toDeg(point.latitude), toKilometer(point.elevation));
// Approximately -70 degrees, -30 degrees, 550 km.

const surfaceSite = geodeticLocation(point.longitude, point.latitude, 0, Ellipsoid.WGS84);
```

The input is an **Earth-centered position in GCRS axes**, with each Cartesian component in **AU**. `subpoint` rotates it into ITRS at `time`, then inverts the selected reference ellipsoid; `ellipsoid` defaults to `Ellipsoid.IERS2010`. Convert TEME, ITRS, or another frame to GCRS axes before calling it. A direction unit vector can identify longitude and latitude, but its length would produce a physically unrelated elevation.

## Result and interpretation

The returned `GeographicPosition` has east-positive longitude normalized to **(−π, π]**, north-positive **geodetic** latitude in radians, and ellipsoidal elevation in AU. Its `itrs` field contains the rotated Earth-fixed Cartesian input in AU. For a finite satellite position, elevation is the satellite's height above the ellipsoid along the local geodetic normal; the function does not replace it with zero. Create a `geodeticLocation` with the returned longitude and latitude and zero elevation when a point on the ellipsoid is needed.

Geodetic latitude uses the ellipsoid normal and generally differs from the geocentric angle of the position vector. The result depends on the `Time` orientation calculation, including UT1, TT, and polar motion from its configured providers. Load [Earth Orientation Parameters]({% link astronomy/time-and-earth-orientation/earth-orientation-parameters.md %}) when a measured ground track matters. The calculation uses an ideal reference ellipsoid; it does not model geoid undulation, topography, or a propagated satellite orbit.

## Related topics

- [Geographic Observer]({% link astronomy/coordinates-and-observers/geographic-observer.md %}) creates sites and converts their geodetic coordinates to ITRS.
- [Celestial and Terrestrial Reference Frames]({% link astronomy/coordinates-and-observers/celestial-and-terrestrial-reference-frames.md %}) provides the frame conversion needed for other vector axes.
