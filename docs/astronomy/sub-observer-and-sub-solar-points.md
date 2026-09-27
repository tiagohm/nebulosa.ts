---
title: Sub-Observer and Sub-Solar Points
layout: default
parent: Astronomy
nav_order: 220
description: Projects an observer and the Sun onto a rotating body's surface and measures its apparent pole angle.

doc_kind: topic

sources:
    - src/astronomy/bodies/orientation.ts

api:
    - SurfacePoint
    - subObserverPoint
    - subSolarPoint
    - positionAngleOfPole
---

# Sub-Observer and Sub-Solar Points

These functions use an IAU body-orientation model to find the surface point facing an observer, the point facing the Sun, and the north pole's angle on the apparent disk. Use them for a planet's central-meridian geometry, a subsolar latitude, or a lunar or planetary disk drawing. Supply body-relative vectors in **AU** with **ICRF-oriented axes** and a `Time` for the observation.

## Basic usage

```ts
import { MARS_ROTATION, positionAngleOfPole, subObserverPoint, subSolarPoint } from '../src/astronomy/bodies/orientation';
import { earth, mars, sun } from '../src/astronomy/ephemeris/models/analytical/vsop87e';
import { timeYMDHMS, Timescale } from '../src/astronomy/time/time';
import { vecMinus } from '../src/math/linear-algebra/vec3';
import { toDeg } from '../src/math/units/angle';

const instant = timeYMDHMS(2026, 6, 29, 0, 0, 0, Timescale.UTC);
const marsPosition = mars(instant)[0];
const bodyToObserver = vecMinus(earth(instant)[0], marsPosition);
const bodyToSun = vecMinus(sun(instant)[0], marsPosition);
const subEarth = subObserverPoint(MARS_ROTATION, instant, bodyToObserver);
const subSun = subSolarPoint(MARS_ROTATION, instant, bodyToObserver, bodyToSun);
const poleAngle = positionAngleOfPole(MARS_ROTATION, instant, bodyToObserver);
console.log(toDeg(subEarth.longitude), toDeg(subEarth.latitude));
console.log(toDeg(subSun.longitude), toDeg(subSun.latitude), toDeg(poleAngle));
```

For this model and epoch, the Mars sub-Earth point is about `[131.85°, −9.86°]` and the subsolar point about `[107.57°, −19.17°]`. The example subtracts barycentric states to form the required **body → observer** and **body → Sun** vectors; reversing either subtraction changes the projected surface point.

## Surface and sky conventions

`subObserverPoint(elements, time, bodyToObserver)` returns a fresh `{ longitude, latitude }` point beneath the observer. `subSolarPoint(elements, time, bodyToObserver, bodyToSun)` returns the corresponding point beneath the supplied Sun direction. Both use **planetocentric east-positive longitude** from the model's IAU prime meridian, wrapped to `[0, 2π)`, and latitude north of the body equator in `[-π/2, π/2]`. These are coordinates of directions on a body-fixed sphere; neither function intersects a shape or computes terrain elevation. For a prograde body's conventional west-positive planetographic longitude, take the wrapped complement `2π − longitude`.

`positionAngleOfPole(elements, time, bodyToObserver)` returns an angle in **radians** from celestial north toward east at the disk center, wrapped to `(−π, π]`. It uses the body's model north pole and the **observer → body** sightline to form a sky-plane basis on the **true equator and equinox of the observation date**. It does not apply annual aberration to that sightline. When the pole projects onto the disk center, its position angle is geometrically undefined; the function has no separate undefined result.

## Light time and limits

The length of `bodyToObserver` sets a **one-way light-time delay**. All three functions evaluate the body's orientation at observation time minus that delay. The two surface-point functions then rotate the direction vectors the caller supplied; `subSolarPoint` does not separately advance or retard `bodyToSun`. `positionAngleOfPole` precesses and nutates the pole and sightline using the **observation** time after evaluating the pole at retarded time.

The caller must supply nonzero vectors from a compatible ephemeris and origin. The functions do not validate zero-length directions; such a direction cannot define a surface point. Light-time rotation is material for fast rotators: the repository's fixed 2026-06-29 Jupiter test finds about a `31.18°` change in its sub-observer longitude relative to using an unretarded rotation. Output accuracy also depends on the selected rotation table and supplied vectors; these helpers do not establish a general error bound.

## Related topics

- [IAU Body Orientation]({% link astronomy/iau-body-orientation.md %}) defines the rotation elements and body-fixed matrix used here.
- [Binary PCK Rotation]({% link astronomy/binary-pck-rotation.md %}) supplies an alternative orientation from a suitable kernel.
- [Meeus Lunar Libration and Surface Lighting]({% link astronomy/meeus-algorithms/lunar-libration-and-surface-lighting.md %}) uses a different chapter model for geocentric lunar disk geometry.
