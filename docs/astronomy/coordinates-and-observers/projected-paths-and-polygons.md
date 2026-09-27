---
title: Projected Paths and Polygons
layout: default
parent: Coordinates and Observers
grand_parent: Astronomy
nav_order: 235
description: Densifies and splits projected polylines and polygon rings at wraps, domain gaps, and planar jumps.

doc_kind: topic

sources:
    - src/astronomy/projections/projection.ts

api:
    - ProjectionPolylineOptions
    - LongitudeWrapMode
    - projectPolyline
    - projectPolygon
---

# Projected Paths and Polygons

`projectPolyline` and `projectPolygon` turn connected spherical paths into pieces that a chart can draw without connecting across a map seam or projection gap. They use a chosen [Sky Projection]({% link astronomy/coordinates-and-observers/sky-projections.md %}) for each point and keep the pieces in separate arrays. Use them for tracks, boundaries, and footprints whose original vertex order matters.

## Basic usage

```ts
import { PlateCarree, projectPolygon, projectPolyline } from '../src/astronomy/projections/projection';
import { deg } from '../src/math/units/angle';

const map = new PlateCarree();
const track = projectPolyline(map, [
	{ x: deg(170), y: deg(10) },
	{ x: deg(-170), y: deg(12) },
]);
const footprint = projectPolygon(map, [
	[
		{ x: deg(170), y: 0 },
		{ x: deg(179), y: 0 },
		{ x: deg(-179), y: 0 },
	],
]);
console.log(track.length, footprint[0].length);
```

Each input `Point` stores `{ x: longitude, y: latitude }` in **radians**; for an equatorial chart these may be right ascension and declination on a consistent frame and epoch. The output points use the selected projection's planar units and axes. `projectPolyline` returns `Point[][]`, one array per drawable segment. Empty input returns an empty array. `projectPolygon` takes an array of rings and returns `Point[][][]`: each ring retains its own array of projected segments. A ring is not closed for you; repeat its first input vertex when its closing edge is needed.

## Splitting and densification

The functions accept `ProjectionPolylineOptions`, including the normal projection options and three path controls:

| Option                   | Effect                                                                                                                                               |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `splitLongitudeGap`      | Split when consecutive longitude deltas, after central-meridian, RA-axis, and wrap handling, differ by more than the threshold. Default `π` radians. |
| `maxSegmentRadians`      | Insert intermediate spherical coordinates before projection when a longitude or latitude coordinate step exceeds this positive threshold.            |
| `discontinuityThreshold` | Split when consecutive projected points are farther apart than this positive threshold in planar units.                                              |

Densification follows the shortest wrapped longitude difference and interpolates latitude linearly. It is a coordinate interpolation, not a great-circle path solver. The algorithm also starts a new segment when the projection returns `undefined` for a point. Split segments do not acquire an exact seam or domain-boundary intersection; draw the returned pieces independently. `projectPolygon` applies the same splitting rules to every input ring without flattening their grouping.

These helpers use the selected projection's constructor defaults unless per-call projection options override them. The path controls alter sampling and display topology, not the underlying source directions. They do not perform precession, refraction, WCS fitting, or astronomical trajectory calculation.

## Related topics

- [Sky Projections]({% link astronomy/coordinates-and-observers/sky-projections.md %}) chooses the planar mapping and its valid domain.
- [Spherical Coordinate Conversions]({% link astronomy/coordinates-and-observers/spherical-coordinate-conversions.md %}) prepares source directions on the intended celestial axes.
