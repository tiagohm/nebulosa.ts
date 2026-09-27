---
title: Planetary Surface Locations
layout: default
parent: Coordinates and Observers
grand_parent: Astronomy
nav_order: 270
description: Places a planetocentric point on a tri-axial body and transforms its body-relative position and rotational velocity into inertial axes.

doc_kind: topic

sources:
    - src/astronomy/observer/body.ts
    - src/astronomy/coordinates/frame.ts

api:
    - BodyShape
    - bodyShape
    - BodySurfaceLocation
    - bodySurfaceLocation
    - bodySurfaceState
    - bodySurfacePositionAndVelocity
---

# Planetary Surface Locations

These helpers place a crust-fixed point on a tri-axial ellipsoid and evaluate its body-relative inertial state. Supply a body-fixed `Frame` to orient the point at a chosen time. To obtain a state relative to an ephemeris origin, combine it with a body-center ephemeris through `bodySurfacePositionAndVelocity`.

## Basic usage

```ts
import { bodyFixedFrame, MOON_ROTATION } from '../src/astronomy/bodies/orientation';
import { bodyShape, bodySurfaceLocation, bodySurfaceState } from '../src/astronomy/observer/body';
import { timeYMDHMS, Timescale } from '../src/astronomy/time/time';
import { deg } from '../src/math/units/angle';
import { kilometer } from '../src/math/units/distance';

// Illustrative tri-axial semi-axes; supply radii appropriate to the chosen body model.
const shape = bodyShape([kilometer(1_738), kilometer(1_737), kilometer(1_736)]);
const frame = bodyFixedFrame(MOON_ROTATION);
const site = bodySurfaceLocation(deg(-46.8), deg(26.3), kilometer(0), shape, frame);
const time = timeYMDHMS(2020, 1, 1, 0, 0, 0, Timescale.TDB);
const [positionAu, velocityAuPerDay] = bodySurfaceState(site, time);
console.log(positionAu, velocityAuPerDay);
```

`bodyShape` accepts three positive semi-axes, either `[x, y, z]` or `{ x, y, z }`, in **AU**, and copies them into its `radii` array. `kilometer(...)` converts the example's dimensions to AU. The axes refer to the supplied body-fixed frame's +X, +Y, and +Z directions. The example uses an IAU/WGCCRE lunar orientation; a caller can instead supply another compatible rotating frame.

`bodySurfaceLocation(longitude, latitude, elevation, shape, frame)` takes angles in **radians** and elevation in **AU**. Longitude is planetocentric and east-positive around body-fixed +Z; the stored longitude is normalized to `[0, 2π)`. Latitude is the angle from the body-fixed equator toward +Z, ordinarily within `[-π/2, π/2]`. The function intersects that radial direction with the ellipsoid and adds elevation **along the same ray**. Elevation is therefore a radial offset, not planetographic or geodetic height measured along the ellipsoid normal. At a pole, longitude does not change the physical point.

## Inertial state and ownership

`bodySurfaceState(site, time, out?)` transforms the cached body-fixed point into the library's GCRS/ICRS-oriented base axes. Its position is relative to the **body center** in AU; its velocity is the surface's rotational velocity in AU/day. A frame with `dRdtTimesRtAt` supplies the rotation-rate term. If that operator is absent, the crust-fixed point's body-relative velocity is zero even if `rotationAt` varies with time.

`bodySurfaceLocation` computes and caches the Cartesian body-fixed point once. Treat its longitude, latitude, elevation, shape, and cached point as fixed after construction. Without `out`, `bodySurfaceState` returns a new state pair; with `out`, it mutates and returns the supplied pair, which can be reused across calls.

`bodySurfacePositionAndVelocity(body, site)` returns a time-dependent state function. At each time, it adds the body's center position and velocity to the surface state and returns a fresh `[position, velocity]` pair. The body-center state must use the same base axes, in **AU** and **AU/day**; a barycentric ICRS/BCRS body ephemeris produces a barycentric surface state. This composition does not fetch an ephemeris or choose a body-orientation model for you.

## Related topics

- [Celestial and Terrestrial Reference Frames]({% link astronomy/coordinates-and-observers/celestial-and-terrestrial-reference-frames.md %}) explains position-and-velocity transport through a rotating `Frame`.
- [Geographic Observer]({% link astronomy/coordinates-and-observers/geographic-observer.md %}) models an Earth site using geodetic coordinates and an Earth reference ellipsoid.
- [Light-Time Solution]({% link astronomy/coordinates-and-observers/light-time-solution.md %}) accepts time-dependent states for finite-distance targets.
