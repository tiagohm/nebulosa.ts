---
title: Satellite Trail Prediction
layout: default
parent: Astronomy
nav_order: 540
description: Clips equatorial tracks to a rectangular sensor and predicts geometric SGP4 satellite trails.

doc_kind: topic

sources:
    - src/astronomy/events/satellite.trail.ts

api:
    - sensorTrails
    - predictSatelliteTrails
    - SensorField
    - SensorTrackSample
    - SensorTrail
    - SensorTrailOptions
    - SatelliteTrailPrediction
    - SatelliteTrailPredictionOptions
---

# Satellite Trail Prediction

Use `sensorTrails` to clip a sampled equatorial track to a rectangular sensor, or `predictSatelliteTrails` to generate that track for an SGP4 satellite and an Earth observer. The result describes entry-to-exit chords and their timing; it does not render an image or estimate streak brightness.

## Clip a supplied track

```ts
import { sensorTrails } from '../src/astronomy/events/satellite.trail';
import { DEG2RAD } from '../src/core/constants';

const trails = sensorTrails(
	0,
	0,
	{ width: DEG2RAD, height: DEG2RAD },
	[
		{ time: 0, rightAscension: -DEG2RAD, declination: 0 },
		{ time: 1, rightAscension: DEG2RAD, declination: 0 },
	],
	{ arcsecPerPixel: 2 },
);
console.log(trails.length, trails[0].entry.time, trails[0].exit.time, trails[0].lengthPixels);
// 1 0.25 0.75 1800
```

Supply right ascension and declination in **radians**. Sample times are numbers in any consistent caller unit; the returned entry and exit times use that same unit. Samples are sorted by time before clipping. At least two distinct times and positive field width and height are needed; a missed field returns an empty array. The method interpolates between supplied RA/Dec samples, so a curved or fast track needs sufficiently dense samples.

## Predict an SGP4 crossing

```ts
import { predictSatelliteTrails } from '../src/astronomy/events/satellite.trail';
import { geodeticLocation } from '../src/astronomy/observer/location';
import { parseTLE, recordFromTLE } from '../src/astronomy/orbits/propagation/sgp4';
import { timeShift } from '../src/astronomy/time/time';
import { DAYSEC, DEG2RAD } from '../src/core/constants';

const tle = parseTLE('1 25544U 98067A   20330.54791667  .00016717  00000-0  10270-3 0  9000', '2 25544  51.6442  21.4611 0001363  85.7790 274.3535 15.49180547 25697', 'ISS');
const site = geodeticLocation(-46.6361 * DEG2RAD, -23.5475 * DEG2RAD);
const at = (seconds: number) => timeShift(tle.epoch, seconds / DAYSEC);
// Bore-sight near the archived ISS direction at the center of this exposure.
const visits = predictSatelliteTrails(recordFromTLE(tle), site, 2.821619372202283, -0.8419514025782707, { width: DEG2RAD / 10, height: DEG2RAD / 10, positionAngle: 0.7 }, at(3330), at(3334), { arcsecPerPixel: 2 });
console.log(visits.length, visits[0].lengthPixels?.toFixed(1)); // 1 235.9
```

The predictor accepts a prepared `SatRec`, a geographic site, an equatorial bore-sight RA/Dec in **radians**, a field, and exposure start and stop `Time` values. It propagates the satellite and Earth observer to obtain **geometric topocentric** directions in the library's ICRS-oriented axes. It uses neither atmospheric refraction nor light-time, aberration, illumination, occultation, or pointing corrections. Its returned endpoint times are `Time` values on the **TT** scale. The input record is copied before propagation, so the caller's SGP4 cache is preserved.

## Sensor geometry and results

`SensorField.width` and `height` are full angular extents in **radians**. The gnomonic sensor rectangle has half-width `tan(width / 2)` and half-height `tan(height / 2)` in dimensionless plane coordinates. At the default `positionAngle = 0`, sensor **+X points east** and **+Y points north**. A positive position angle rotates +Y from north toward east; the +X axis rotates with it.

Each visit has `entry` and `exit` points with equatorial coordinates and dimensionless `sensorX`/`sensorY`. `length` is the **great-circle angular distance** between the endpoints in radians, not an integrated length along a curved trail. `positionAngle` is the entry-to-exit direction from north toward east, wrapped to **[0, 2π)**. Supplying `arcsecPerPixel` adds `lengthPixels = length × arcseconds per radian / arcsecPerPixel`. A visit already under way at either exposure boundary is clipped to that boundary; separate visits remain chronological.

## Accuracy and limits

`predictSatelliteTrails` adaptively subdivides the exposure using geometric interpolation. `maxStep` defaults to **1 SI second**, `maxInterpolationError` to **0.1 arcsecond**, and `maxSamples` to **65,537** evaluations. The residual is a local sampling check, not a guaranteed error bound on grazing contacts. Tighten the controls for small fields or rapid apparent motion. Exhausting the sample budget, exhausting time resolution, or failing propagation throws; an empty or reversed exposure returns `[]`.

These are geometric sensor crossings from the supplied orbit, not [Satellite Passes]({% link astronomy/satellite-passes.md %}) above a horizon. Prediction quality depends on the age and quality of the orbital elements. [Satellite Look Angles]({% link astronomy/satellite-look-angles.md %}) instead reports local horizon coordinates at one instant.
