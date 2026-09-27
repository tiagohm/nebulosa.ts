---
title: Annual Aberration
layout: default
parent: Coordinates and Observers
grand_parent: Astronomy
nav_order: 100
description: Corrects a natural ICRS direction for an observer's barycentric velocity using the ERFA aberration model.

doc_kind: topic

sources:
    - src/astronomy/coordinates/correction.ts

api:
    - annualAberration
---

# Annual Aberration

`annualAberration` turns an already established **natural source direction** into the direction shifted by the observer's motion. Supply the observer's full barycentric velocity to include both the orbital contribution and, for a topocentric observer, any diurnal contribution present in that velocity.

## Basic usage

```ts
import { annualAberration } from '../src/astronomy/coordinates/correction';

const natural = [0, 1, 0] as const; // unit ICRS/BCRS direction
const observerVelocity = [0.017, 0, 0] as const; // AU/day
const observerSunDistance = 1; // AU

const proper = annualAberration(natural, observerVelocity, observerSunDistance);
// The apparent direction moves toward the observer's +X velocity component.
```

`direction` is a unit vector toward the source in ICRS/BCRS axes. `observerVelocity` uses the same axes, in AU/day, and `sunDistance` is the observer-to-Sun separation in AU. The function converts velocity to units of the speed of light, derives the Lorentz factor, and calls the ERFA-style `eraAb` model. It returns a fresh normalized vector; the inputs are not mutated.

## Model and limits

The model includes special-relativistic aberration and the small solar gravitational-potential term used by `eraAb`. That term depends on `sunDistance`; it is distinct from gravitational **direction bending** by a Sun deflector. For an Earth-like orbital speed, the dominant angular displacement is on the order of 20 arcseconds. The actual displacement depends on direction and supplied velocity, so this is not a bound for arbitrary observers.

Supply a physical observer velocity with speed below light speed and a positive observer–Sun distance. The routine does not fetch an ephemeris, construct an observer state, or validate these physical inputs. It also does not solve target light time, apply directional deflection by listed masses, rotate frames, or calculate atmospheric refraction. Its precision depends on the supplied velocity and Sun distance.

Within `apparentDirection`, aberration follows light time and any requested deflection. That higher-level call defaults to aberration and requires a Sun state provider even when the Sun is absent from the deflector list; omitting it throws. Disable aberration there with `{ aberration: false }` when a Sun state is unavailable or the correction is unwanted.

## Related topics

- [Apparent Direction]({% link astronomy/coordinates-and-observers/apparent-direction.md %}) combines this correction with finite-target light time and optional deflection.
- [Starlight Deflection]({% link astronomy/coordinates-and-observers/starlight-deflection.md %}) applies directional gravitational bending by supplied Solar System bodies.

## References

- [ERFA `eraAb` source and routine notes](https://github.com/liberfa/erfa/blob/master/src/ab.c) describe the aberration formula, solar-potential term, and normalization.
