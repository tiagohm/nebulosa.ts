---
title: Earth Occultation of a Finite Target
layout: default
parent: Astronomy
nav_order: 450
description: Tests whether the solid Earth intersects an observer-to-target line segment.

doc_kind: topic

sources:
    - src/astronomy/events/occultation.earth.ts

api:
    - earthOccultation
    - EarthOccultation
---

# Earth Occultation of a Finite Target

`earthOccultation` tests whether the solid Earth's reference ellipsoid blocks a finite target from a geocentric observer position. Use it for geometric line-of-sight checks to a spacecraft, Moon, or planet when both positions are already known at one time.

## Basic usage

```ts
import { earthOccultation } from '../src/astronomy/events/occultation.earth';
import { Ellipsoid } from '../src/astronomy/observer/location';
import { gcrsToItrsRotationMatrix, timeYMDHMS, Timescale } from '../src/astronomy/time/time';
import { ELLIPSOID_PARAMETERS } from '../src/core/constants';
import { matTransposeMulVec } from '../src/math/linear-algebra/mat3';

const time = timeYMDHMS(2026, 6, 29, 0, 0, 0, Timescale.UTC);
const radius = ELLIPSOID_PARAMETERS[Ellipsoid.IERS2010].radius;
const rotation = gcrsToItrsRotationMatrix(time);
const observer = matTransposeMulVec(rotation, [2 * radius, 0, 0]);
const target = matTransposeMulVec(rotation, [-2 * radius, 0, 0]);
const hit = earthOccultation(observer, target, time);
console.log(hit.occulted, hit.intersection?.toFixed(2), hit.tangent); // true 0.25 false
```

`observer` and `target` are **geocentric Cartesian positions in AU**, in GCRS/ICRS-oriented axes at the same reception time. The observer must lie outside the chosen ellipsoid. The example builds two positions on opposite sides of Earth in ITRS and rotates them back to the required celestial axes. If starting with barycentric states, first subtract Earth's position from both endpoints.

## Segment result

The function rotates both endpoints into ITRS and intersects the **closed segment** from observer to target with an oblate reference ellipsoid. The optional `ellipsoid` argument defaults to `Ellipsoid.IERS2010`; other `Ellipsoid` values select their own equatorial radius and flattening.

`EarthOccultation.occulted` is true when the segment enters or touches the ellipsoid, including contact at an endpoint. When there is a hit, `intersection` is the first contact parameter `t` in `[0, 1]` along `observer + t × (target − observer)`; it is `undefined` for a clear line of sight. `tangent` identifies a near-double-root limb contact at numerical tolerance, not a duration or an eclipse classification. An empty observer-to-target segment has no line of sight and returns `occulted: false`.

## Accuracy and related topics

This is a same-epoch geometric solid-Earth test. It does not apply light-time to the target or model atmosphere, terrain, refraction, or solar shadow. Limb results depend on the chosen ellipsoid and Earth-orientation rotation; a nearly tangent segment is sensitive to position error and numerical tolerance.

See [Earth Rotation and Orientation]({% link astronomy/time-and-earth-orientation/earth-rotation-and-orientation.md %}) for the celestial-to-terrestrial rotation, and [Stellar and Asteroidal Occultations]({% link astronomy/stellar-and-asteroidal-occultations.md %}) for a body's disk crossing a star from one site.
