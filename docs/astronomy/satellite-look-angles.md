---
title: Satellite Look Angles
layout: default
parent: Astronomy
nav_order: 490
description: Projects an SGP4 satellite record onto an observer's local horizon at one instant.

doc_kind: topic

sources:
    - src/astronomy/events/satellite.ts

api:
    - satelliteLookAngles
    - SatelliteLookAngles
---

# Satellite Look Angles

`satelliteLookAngles` gives the azimuth, altitude, and slant range of an SGP4 satellite from a geographic observer at one `Time`. Use it to point at a propagated satellite or evaluate its position at an instant; it does not search for a pass.

## Basic usage

```ts
import { satelliteLookAngles } from '../src/astronomy/events/satellite';
import { geodeticLocation } from '../src/astronomy/observer/location';
import { parseTLE, recordFromTLE } from '../src/astronomy/orbits/propagation/sgp4';
import { AU_KM } from '../src/core/constants';
import { deg, toDeg } from '../src/math/units/angle';

// Historical ISS elements: the epoch is part of this TLE, not the current orbit.
const tle = parseTLE('1 25544U 98067A   20330.54791667  .00016717  00000-0  10270-3 0  9000', '2 25544  51.6442  21.4611 0001363  85.7790 274.3535 15.49180547 25697', 'ISS');
const site = geodeticLocation(deg(-46.6361), deg(-23.5475));
const angles = satelliteLookAngles(recordFromTLE(tle), site, tle.epoch);
console.log(toDeg(angles.azimuth).toFixed(1), toDeg(angles.altitude).toFixed(1), (angles.range * AU_KM).toFixed(0));
// 148.0 -75.9 12806
```

The input is a prepared **SGP4 `SatRec`**, created from TLE or OMM elements; it is not a Cartesian ICRF state. The geographic site uses east-positive longitude, north-positive latitude, and elevation in AU. A negative altitude, as in the example, places the satellite below the geometric horizon.

## Result and geometry

`SatelliteLookAngles.azimuth` is in **[0, 2π) radians**, measured from north through east. `altitude` is the geometric elevation in **radians** above the observer's local geodetic horizon, without atmospheric refraction. At the exact zenith or nadir, azimuth has no physical direction. `range` is the observer-to-satellite slant distance in **AU**; multiply by `AU_KM` for kilometers.

The function propagates the record with SGP4 in TEME, rotates the position to Earth-fixed ITRS, subtracts the observer's ITRS position, and resolves the difference onto local south, east, and zenith axes. It evaluates one instant and does not include terrain obstructions, illumination, atmospheric extinction, or a search window. An SGP4 propagation failure throws an `Error`. Accuracy is limited by the input orbital elements, their age, the propagation model, and the coordinate transform.

See [Celestial and Terrestrial Reference Frames]({% link astronomy/coordinates-and-observers/celestial-and-terrestrial-reference-frames.md %}) for TEME and ITRS conventions.
