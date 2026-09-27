---
title: Satellite Passes
layout: default
parent: Astronomy
nav_order: 500
description: Finds complete geometric rise, culmination, and set events of an SGP4 satellite.

doc_kind: topic

sources:
    - src/astronomy/events/satellite.ts

api:
    - satellitePasses
    - SatellitePass
    - SatellitePassEvent
    - SatellitePassOptions
---

# Satellite Passes

`satellitePasses` finds complete stretches when an SGP4 satellite rises above a chosen geometric altitude and later sets below it for a ground observer. Use its rise, culmination, and set events to build a pointing schedule from a current orbital record.

## Basic usage

```ts
import { satellitePasses } from '../src/astronomy/events/satellite';
import { geodeticLocation } from '../src/astronomy/observer/location';
import { parseTLE, recordFromTLE } from '../src/astronomy/orbits/propagation/sgp4';
import { timeShift } from '../src/astronomy/time/time';
import { deg, toDeg } from '../src/math/units/angle';

// Archived ISS elements, used only at their 2020 epoch for this example.
const tle = parseTLE('1 25544U 98067A   20330.54791667  .00016717  00000-0  10270-3 0  9000', '2 25544  51.6442  21.4611 0001363  85.7790 274.3535 15.49180547 25697', 'ISS');
const site = geodeticLocation(deg(-46.6361), deg(-23.5475));
const passes = satellitePasses(recordFromTLE(tle), site, tle.epoch, timeShift(tle.epoch, 1));
console.log(passes.length, toDeg(passes[0].culmination.altitude).toFixed(1)); // 6 32.1
```

The input is an SGP4 `SatRec`, and the site uses east-positive longitude and north-positive latitude. Each `SatellitePass` has `rise`, `culmination`, and `set` `SatellitePassEvent` values. An event combines a `Time` with the azimuth, geometric altitude, and slant range described in [Satellite Look Angles]({% link astronomy/satellite-look-angles.md %}).

## Pass boundary and options

`SatellitePassOptions.minAltitude` is the crossing altitude in **radians**, defaulting to **0** for an ideal geometric horizon. Raise it for a minimum elevation or a simple local obstruction threshold. The scanner pairs an upward crossing with the next downward crossing and refines the highest altitude between them as `culmination`. Results are chronological.

Both the rise and set must lie inside `[start, stop]`. A pass already underway when the window opens, or still underway when it closes, is omitted. `step` is a coarse spacing in **days**, defaulting to **30 seconds**; `tolerance` is a refinement tolerance in **days**, with the root scanner defaulting to **10⁻⁶ day**. Narrow, grazing passes can be missed if the step is too broad. An SGP4 propagation failure throws an `Error`.

These are geometric altitude passes. The function does not require sunlight on the satellite, darkness at the site, atmospheric refraction, or an unobstructed local skyline. Orbital-element age and propagation quality affect the predicted circumstances; no uniform pass-timing accuracy is guaranteed.

Use [Satellite Look Angles]({% link astronomy/satellite-look-angles.md %}) for a single instant and [Time-Domain Event Search]({% link astronomy/time-domain-event-search.md %}) for the root-sampling behavior.
