---
title: Local Horizon Mask
layout: default
parent: Coordinates and Observers
grand_parent: Astronomy
nav_order: 200
description: Interpolates a circular minimum-altitude profile and finds sampled path crossings of local obstructions.

doc_kind: topic

sources:
    - src/astronomy/observer/horizon.ts

api:
    - HorizonSample
    - HorizontalPathSample
    - HorizonCrossing
    - horizonMinimumAltitude
    - isAboveHorizon
    - horizonCrossings
---

# Local Horizon Mask

A horizon mask records the minimum altitude that a target must reach at each azimuth to clear local obstructions. Use `horizonMinimumAltitude` for a threshold at one direction, `isAboveHorizon` for a visibility check, and `horizonCrossings` to locate where a supplied, sampled alt/az path moves behind or emerges from the mask.

## Basic usage

```ts
import { horizonCrossings, horizonMinimumAltitude, isAboveHorizon } from '../src/astronomy/observer/horizon';
import { deg } from '../src/math/units/angle';

const mask = [
	{ azimuth: deg(0), minimumAltitude: deg(10) },
	{ azimuth: deg(180), minimumAltitude: deg(30) },
];

const eastLimit = horizonMinimumAltitude(mask, deg(90)); // 20 degrees, in radians
const eastClear = isAboveHorizon(mask, deg(20), deg(90)); // true at equality
const crossings = horizonCrossings(
	[
		{ time: 0, azimuth: deg(0), altitude: deg(15) },
		{ time: 1, azimuth: deg(180), altitude: deg(15) },
	],
	mask,
);
console.log(eastLimit, eastClear, crossings); // one 'set' crossing at time 0.25
```

Azimuth is in **radians from north through east**; altitude and `minimumAltitude` are in radians above the local horizon. `isAboveHorizon` returns `true` when the supplied altitude is **at least** the interpolated threshold. In the example, the 15° path starts clear and meets the rising profile at 45° azimuth, one quarter of the way through its sampled time interval.

## Circular profile

The mask samples may be unordered. The implementation normalizes azimuth to `[0, 2π)`, sorts the profile, and linearly interpolates minimum altitude between neighboring samples, including the segment from the last sample across north to the first. If multiple samples have the same normalized azimuth, the **higher** minimum altitude wins. One sample defines a constant threshold at every azimuth. An empty mask has threshold `−π/2`, so every physically valid sky altitude clears it.

## Path crossings

Each `HorizontalPathSample` supplies `time`, `azimuth`, and geometric `altitude`. `time` may use any uniform caller-chosen unit; the returned crossing keeps that unit. The routine sorts path samples by time and interpolates each positive-duration segment linearly in time and altitude. It takes the **shortest signed azimuth arc** between adjacent samples, crossing the 0/2π wrap when appropriate.

The result is an array of `HorizonCrossing` values in time order, with interpolated time, altitude, normalized azimuth, and `kind`. A `set` crossing changes clearance (`altitude − minimumAltitude`) from positive to negative; `rise` is the reverse. At a zero-clearance sample or plateau, classification follows surrounding nonzero clearances when available; a tangential touch that returns to the same side is not reported as a rise or set. Fewer than two path samples yield no crossings.

The routine splits each path segment at every mask knot traversed by its short azimuth arc. A peak or valley in the mask can therefore produce multiple crossings within one input segment. It still assumes that the **target path** is adequately represented by linear interpolation between supplied samples. Sample densely enough to capture changes in the true path and keep each azimuth step on the intended short arc; otherwise crossings can be missed or timed incorrectly.

The mask does not compute an ephemeris, astronomical rise/set event, parallax, or atmospheric refraction. Supply geometric path altitudes and obstruction thresholds in the same altitude convention. For astronomical event search rather than a user-supplied path, use the relevant event topic when available.

## Related topics

- [Local Horizon Coordinates]({% link astronomy/coordinates-and-observers/local-horizon-coordinates.md %}) produces geometric azimuth and altitude from a reduced equatorial direction.
- [Topocentric Observed Place]({% link astronomy/coordinates-and-observers/topocentric-observed-place.md %}) produces observed local angles, optionally with atmospheric refraction.
