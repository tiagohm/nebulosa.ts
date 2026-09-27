---
title: Satellite Conjunctions
layout: default
parent: Astronomy
nav_order: 530
description: Finds local minima of physical separation between two SGP4 satellites.

doc_kind: topic

sources:
    - src/astronomy/events/satellite.ts

api:
    - satelliteConjunctions
    - SatelliteConjunction
    - SatelliteConjunctionOptions
---

# Satellite Conjunctions

`satelliteConjunctions` screens two SGP4 satellites for local minima of their **three-dimensional distance** over a time window. Use it to find close-approach candidates in space before applying any separate collision-risk or uncertainty analysis.

## Basic usage

```ts
import { satelliteConjunctions } from '../src/astronomy/events/satellite';
import { parseTLE, recordFromTLE } from '../src/astronomy/orbits/propagation/sgp4';
import { timeShift } from '../src/astronomy/time/time';
import { AU_KM, DAYSEC } from '../src/core/constants';

const iss = parseTLE('1 25544U 98067A   20330.54791667  .00016717  00000-0  10270-3 0  9000', '2 25544  51.6442  21.4611 0001363  85.7790 274.3535 15.49180547 25697', 'ISS');
// Synthetic second orbit: its node differs by 10°; it is not a real encounter.
const companion = parseTLE('1 25545U 98067A   20330.54791667  .00016717  00000-0  10270-3 0  9000', '2 25545  51.6442  31.4611 0001363  85.7790 274.3535 15.49180547 25697', 'COMPANION');
const events = satelliteConjunctions(recordFromTLE(iss), recordFromTLE(companion), iss.epoch, timeShift(iss.epoch, 100 / 1440));
console.log(events.length, (events[0].distance * AU_KM).toFixed(1), ((events[0].relativeSpeed * AU_KM) / DAYSEC).toFixed(2));
// 2 734.7 1.34
```

The two inputs are prepared `SatRec` records. Both positions are propagated with SGP4 in the same TEME frame, then directly differenced. No observing site is involved: a small angle between two objects on the sky is a different condition from a small physical separation.

## Results and limits

Each `SatelliteConjunction` has the `Time` of a local distance minimum, `distance` in **AU**, and `relativeSpeed` in **AU/day**, the magnitude of the difference between the two SGP4 velocity vectors there. `relativeSpeed` is not a radial closing speed. The events are chronological.

`SatelliteConjunctionOptions.threshold` is a maximum physical distance in **AU**; only minima at or below it are returned. Without a threshold, every detected local minimum is returned. The search samples **squared distance**, which has the same minima as distance, and refines each bracket. `step` is in **days**, defaulting to **30 seconds**; `tolerance` is a refinement tolerance in **days**, defaulting to **10⁻⁶ day** for the extremum scanner. A brief close approach or an endpoint minimum can be missed by coarse sampling.

The routine does not use satellite radii, covariance, maneuver plans, or collision-probability calculations. Keep the search near both element epochs; prediction quality degrades with stale TLEs. See [Time-Domain Extrema Search]({% link astronomy/time-domain-extrema-search.md %}) for sampling behavior and [Satellite Look Angles]({% link astronomy/satellite-look-angles.md %}) for observer-relative sky direction.
