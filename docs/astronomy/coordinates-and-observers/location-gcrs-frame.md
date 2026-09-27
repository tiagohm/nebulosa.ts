---
title: Location GCRS Frame
layout: default
parent: Coordinates and Observers
grand_parent: Astronomy
nav_order: 170
description: Rotates GCRS-oriented vectors and states into a site's north, east, and up axes.

doc_kind: topic

sources:
    - src/astronomy/observer/location.ts

api:
    - gcrs
    - gcrsRotationAt
---

# Location GCRS Frame

`gcrs(location)` constructs a time-dependent `Frame` that expresses GCRS-oriented vectors in a site's local **north, east, up** axes. Use it to orient a direction or a position–velocity state for local geometry. `gcrsRotationAt(location, time)` returns the corresponding position rotation at one instant.

## Basic usage

```ts
import { frameAt, frameToBase } from '../src/astronomy/coordinates/frame';
import { gcrs, gcrsRotationAt, geodeticLocation } from '../src/astronomy/observer/location';
import { timeYMDHMS, Timescale } from '../src/astronomy/time/time';
import type { Vec3 } from '../src/math/linear-algebra/vec3';
import { deg } from '../src/math/units/angle';

const site = geodeticLocation(deg(-70), deg(-30));
const time = timeYMDHMS(2026, 6, 29, 0, 0, 0, Timescale.UTC);
const directionGcrs: Vec3 = [1, 0, 0];
const localFrame = gcrs(site);

const northEastUp = frameAt(directionGcrs, localFrame, time);
const recoveredGcrs = frameToBase(northEastUp, localFrame, time);
const rotation = gcrsRotationAt(site, time);
console.log(northEastUp, recoveredGcrs, rotation);
```

The local components are ordered `[north, east, up]`. North follows increasing geodetic latitude, east follows increasing longitude, and up follows the ellipsoid normal. These axes form an orthogonal **left-handed** basis in this order. The rotation combines the date-dependent GCRS→ITRS orientation with the site's longitude and geodetic latitude. Elevation and ellipsoid choice do not enter this orientation.

## Position, origin, and velocity

`gcrsRotationAt` returns a flat row-major 3 × 3 matrix. `frameAt` applies that matrix to a vector, while `frameToBase` applies its transpose to reverse the orientation. The rotation changes axes **without translating the origin**: a geocentric input position remains geocentric in local axes. For a topocentric offset, subtract the site's geocentric position from the target position in a common frame before rotating. [Geographic Observer]({% link astronomy/coordinates-and-observers/geographic-observer.md %}) supplies the site's ITRS position; transform it into GCRS axes if the target is in GCRS.

For a `[position, velocity]` state, use `frameAt` with `gcrs(site)` rather than applying `gcrsRotationAt` to both vectors. The frame supplies `dRdtTimesRtAt`, so the local velocity includes the rotational transport term `W · p_local`, with `W = (dR/dt) · Rᵀ` in day⁻¹. Position components are in AU and velocity components in AU/day for astronomical states. The implementation derives Earth's instantaneous angular velocity from a centered one-second difference of its orientation matrix; the frame's velocity operator is tested against a finite difference of `gcrsRotationAt`.

The orientation follows the `Time` instance's UT1/TT conversions and Earth-orientation providers. Supply suitable [Earth Orientation Parameters]({% link astronomy/time-and-earth-orientation/earth-orientation-parameters.md %}) when measured terrestrial orientation matters. The site object caches its latitude and longitude rotations after use; create a new location if either coordinate changes.

## Related topics

- [Celestial and Terrestrial Reference Frames]({% link astronomy/coordinates-and-observers/celestial-and-terrestrial-reference-frames.md %}) explains `Frame`, state transport, and origin-preserving rotations.
- [Geographic Sub-point]({% link astronomy/coordinates-and-observers/geographic-sub-point.md %}) inverts an Earth-centered GCRS position to geographic coordinates.
