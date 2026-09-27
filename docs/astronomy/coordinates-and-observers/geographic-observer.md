---
title: Geographic Observer
layout: default
parent: Coordinates and Observers
grand_parent: Astronomy
nav_order: 150
description: Defines an Earth observer on a reference ellipsoid and computes its Earth-fixed position, sidereal time, and parallax factors.

doc_kind: topic

sources:
    - src/astronomy/observer/location.ts
    - src/astronomy/coordinates/itrs.ts

api:
    - Ellipsoid
    - GeographicCoordinate
    - GeographicPosition
    - geodeticLocation
    - geocentricLocation
    - localSiderealTime
    - polarRadius
    - rhoCosPhi
    - rhoSinPhi
    - itrs
---

# Geographic Observer

An Earth observer has geodetic longitude, latitude, and height relative to a selected reference ellipsoid. Create a `GeographicPosition` to supply a site to topocentric calculations, obtain its Earth-fixed Cartesian position, or calculate local sidereal time and parallax factors.

## Basic usage

```ts
import { itrs } from '../src/astronomy/coordinates/itrs';
import { Ellipsoid, geocentricLocation, geodeticLocation, localSiderealTime, rhoCosPhi, rhoSinPhi } from '../src/astronomy/observer/location';
import { timeYMDHMS, Timescale } from '../src/astronomy/time/time';
import { deg, toHour } from '../src/math/units/angle';
import { meter, toMeter } from '../src/math/units/distance';

const site = geodeticLocation(deg(-45), deg(-23), meter(890), Ellipsoid.IERS2010);
const [x, y, z] = itrs(site); // ITRS Cartesian coordinates, AU
const recovered = geocentricLocation(x, y, z, Ellipsoid.IERS2010);
const time = timeYMDHMS(2020, 10, 7, 12, 0, 0, Timescale.UTC);

console.log(toMeter(x), toMeter(y), toMeter(z));
console.log(recovered.longitude, recovered.latitude, toMeter(recovered.elevation));
console.log(toHour(localSiderealTime(time, site)), rhoCosPhi(site), rhoSinPhi(site));
```

`geodeticLocation(longitude?, latitude?, elevation?, ellipsoid?)` defaults to zero longitude, latitude, and elevation on `Ellipsoid.IERS2010`. Angles are **radians**: longitude increases eastward and latitude northward. Elevation is a distance in **AU** above the ellipsoid along its local normal; use `meter(...)` for a height in metres. Available ellipsoids are `GRS80`, `WGS72`, `WGS84`, and `IERS2010`.

`geocentricLocation(x, y, z, ellipsoid?)` takes an **ITRS** Earth-centered Cartesian position in AU and recovers geodetic coordinates on the selected ellipsoid, also IERS2010 by default. The returned latitude is geodetic latitude, measured from the ellipsoid normal; it generally differs from the geocentric angle of the Cartesian vector. `itrs(site)` performs the forward conversion, returning `[x, y, z]` in AU. The ITRS axes place zero longitude on +X, east longitude toward +Y, and the north pole on +Z.

## Local sidereal time

`localSiderealTime(time, location?, mean?, tio?)` returns an angle in `[0, 2π)` radians. `location` may be a `GeographicCoordinate` or an east-positive longitude angle. If omitted, it uses `time.location`; set that field or pass a location explicitly.

| Option      | Default | Effect                                                                                         |
| ----------- | ------- | ---------------------------------------------------------------------------------------------- |
| `mean`      | `false` | Uses Greenwich apparent sidereal time (GAST); `true` uses Greenwich mean sidereal time (GMST). |
| `tio`       | `false` | Adds geographic longitude to the Greenwich angle without a TIO correction.                     |
| `tio: 'sp'` | —       | Adds the TIO locator s′ computed from TT, without the x/y polar-motion rotation.               |
| `tio: true` | —       | Uses s′ plus the x/y polar-motion rotation when forming the local angle.                       |

The Greenwich angle depends on the `Time` conversion to UT1 and TT and on its selected sidereal-time provider. For `tio: true`, the polar-motion values and s′ come from the time's orientation providers. The `'sp'` branch computes s′ with `eraSp00` from TT; it does not query the optional `sp` provider. Load suitable [Earth Orientation Parameters]({% link astronomy/time-and-earth-orientation/earth-orientation-parameters.md %}) when measured DUT1 or polar motion matters.

## Earth radius and parallax factors

`polarRadius(ellipsoid)` returns that ellipsoid's polar semiminor radius in AU: equatorial radius × (1 − flattening). `rhoCosPhi(site)` and `rhoSinPhi(site)` return **dimensionless** parallax factors formed from geodetic latitude and elevation relative to the ellipsoid's equatorial radius. They represent the observer's equatorial-plane and polar-axis distances in units of that radius, respectively; southern latitudes yield a negative `rhoSinPhi` for ordinary surface sites. The functions use IERS2010 if a supplied `GeographicPosition` has no `ellipsoid` field.

## Caching and limits

`geodeticLocation` and `geocentricLocation` return new coordinate objects. `itrs`, `rhoCosPhi`, and `rhoSinPhi` memoize their results on the supplied `GeographicPosition`; repeated `itrs(site)` calls return the same vector reference. Treat a site as fixed after computing these values. If longitude, latitude, elevation, or ellipsoid changes, create a new position so the cached geometry agrees with it.

These functions use reference-ellipsoid geometry, not geoid height or terrain. Their precision depends on the supplied coordinates, ellipsoid, time scale conversions, and Earth-orientation data. No site uncertainty or atmospheric effect is modeled here.

## Related topics

- [Topocentric Observed Place]({% link astronomy/coordinates-and-observers/topocentric-observed-place.md %}) consumes a geodetic site for observed sky angles.
- [Celestial and Terrestrial Reference Frames]({% link astronomy/coordinates-and-observers/celestial-and-terrestrial-reference-frames.md %}) describes ITRS axes and transforms involving Earth rotation.
