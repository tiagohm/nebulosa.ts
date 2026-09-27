---
title: Angular Separation and Position Angle
layout: default
parent: Coordinates and Observers
grand_parent: Astronomy
nav_order: 55
description: Measures great-circle separation and north-through-east sky bearing between equatorial directions.

doc_kind: topic

sources:
    - src/astronomy/coordinates/coordinate.ts

api:
    - angularDistance
    - angularDistanceHaversine
    - positionAngleBetween
---

# Angular Separation and Position Angle

These functions measure the relationship between two equatorial directions. Use angular separation for a scalar distance on the sky, and position angle for the bearing of the second direction from the first. Both inputs must use the same celestial frame, epoch, and origin for the comparison to have the intended physical meaning.

## Basic usage

```ts
import { angularDistance, angularDistanceHaversine, positionAngleBetween } from '../src/astronomy/coordinates/coordinate';
import { deg } from '../src/math/units/angle';

const separation = angularDistance(0, 0, deg(90), 0); // π/2 radians
const alternative = angularDistanceHaversine(0, 0, deg(90), 0);
const bearing = positionAngleBetween(0, 0, deg(90), 0); // east: π/2 radians
console.log({ separation, alternative, bearing });
```

All four input angles are radians, in the order `(ra0, dec0, ra1, dec1)`. `angularDistance` and `angularDistanceHaversine` return the great-circle angle in `[0, π]`. The first uses an `atan2` formulation that preserves very small separations; the alternative uses the haversine formula and clamps its inverse-trigonometric input against rounding. Neither function performs precession, parallax, or observed-place reduction.

`positionAngleBetween` measures from celestial north toward east at the first direction and wraps its result to `[0, 2π)`. The bearing depends on which direction is first; it is not a coordinate-frame conversion. At coincident directions the geometric bearing is undefined, although the function returns `0` when both components passed to `atan2` are exactly zero. Near antipodes or celestial poles, a position angle can be sensitive to tiny changes in the inputs. Use separation when the bearing has no useful meaning.

## Related topics

- [Spherical Coordinate Conversions]({% link astronomy/coordinates-and-observers/spherical-coordinate-conversions.md %}) places directions on matching equatorial axes before comparison.
- [Angular Motion]({% link astronomy/coordinates-and-observers/angular-motion.md %}) derives rates from positions or sampled directions.
