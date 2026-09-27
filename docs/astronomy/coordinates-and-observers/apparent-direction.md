---
title: Apparent Direction
layout: default
parent: Coordinates and Observers
grand_parent: Astronomy
nav_order: 70
description: Computes a finite target's light-time-corrected astrometric and apparent directions from supplied barycentric states.

doc_kind: topic

sources:
    - src/astronomy/coordinates/apparent.ts

api:
    - apparentDirection
    - applyApparentDirectionCorrections
    - ApparentDirection
    - ApparentDirectionOptions
    - ApparentDirectionCorrections
---

# Apparent Direction

Use `apparentDirection` to obtain the astrometric and corrected apparent directions from an observer to a **finite-distance target**. Supply barycentric states for the target, observer, and any bodies used for corrections; the function does not fetch an ephemeris.

## Basic usage

```ts
import { apparentDirection } from '../src/astronomy/coordinates/apparent';
import type { PositionAndVelocityOverTime } from '../src/astronomy/coordinates/astrometry';
import { timeYMDHMS, Timescale } from '../src/astronomy/time/time';

// Illustrative constant barycentric states, not planetary ephemerides.
const target: PositionAndVelocityOverTime = () => [
	[2, 0.1, 0],
	[0, 0, 0],
];
const observer: PositionAndVelocityOverTime = () => [
	[1, 0, 0],
	[0, 0.017, 0],
];
const sun: PositionAndVelocityOverTime = () => [
	[0, 0, 0],
	[0, 0, 0],
];
const time = timeYMDHMS(2025, 1, 1, 0, 0, 0, Timescale.TDB);

const place = apparentDirection(target, observer, time, { sun });
if (place) {
	// place.astrometric and place.apparent are unit directions.
	// place.distance is the target distance in AU; place.lightTime is in days.
	console.log(place.apparent, place.distance, place.emissionTime);
}
```

Each provider returns `[position, velocity]` in shared barycentric ICRS/BCRS axes, in AU and AU/day. `time` is the reception epoch; the observer is sampled there, while the target is sampled at successively retarded epochs. Providers must interpret the supplied `Time` consistently. When aberration is enabled, the required Sun provider is sampled at reception for the observer–Sun distance used by that correction.

## Corrections and results

The pipeline first solves the observer-to-target light time, then applies the listed gravitational deflectors in **photon encounter order**, then applies aberration from the observer's full barycentric velocity. A provider that includes a topocentric observer's diurnal velocity therefore contributes diurnal aberration as well as its orbital component. `deflectors` is empty by default; supply the Sun explicitly if solar gravitational deflection is wanted. Each `LightDeflector` supplies a barycentric state provider, mass in solar masses, and a near-body deflection limiter in radians²/2. Deflector states are sampled at reception and linearly backtracked for the finite photon path.

| Result         | Meaning                                                                               |
| -------------- | ------------------------------------------------------------------------------------- |
| `astrometric`  | Unit observer-to-target direction after light time, before deflection and aberration. |
| `apparent`     | Unit direction after the requested corrections, still expressed on ICRS/BCRS axes.    |
| `distance`     | Length of the retarded observer-to-target vector, in AU.                              |
| `lightTime`    | One-way travel time for that distance, in days.                                       |
| `emissionTime` | `time` shifted backward by `lightTime`.                                               |

The two vectors are separately allocated, and their unit lengths do not encode `distance`. The output does not include precession, nutation, Earth rotation, a horizontal transformation, or atmospheric refraction. For sky angles, convert the returned direction with a spherical-coordinate API; for an observed altitude and azimuth, use an observed-place transform.

`applyApparentDirectionCorrections(astrometric, targetEmissionPosition, observerPosition, observerVelocity, lightTimeDays, options)` applies the correction stages to **already solved snapshots**. Its positions are in AU, observer velocity in AU/day, and light time in days. Pass `sunPosition` at reception when aberration is enabled; pass `deflectors` as reception-time `LightDeflectorSnapshot` values. It returns a new unit vector without mutating the supplied direction or snapshots.

## Accuracy and limitations

`lightTimeIterations` defaults to three fixed-point refinements. Zero uses the same-epoch geometric direction, although the result still reports a travel time and corresponding shifted `emissionTime`. The solver samples the target once more than the iteration count; the reported `emissionTime` is calculated from the final separation and can differ slightly from the epoch of the final target sample when the iteration has not converged. Choose states and an iteration count appropriate for the target's motion; no convergence tolerance or accuracy guarantee is applied.

The default `aberration: true` requires `sun`; omitting it throws. Set `aberration: false` to omit this correction and its Sun requirement. An omitted or empty deflector list applies no gravitational deflection. `lightTimeIterations` must be an integer from 0 through 16; other values throw. If the final observer-to-target separation is zero, `apparentDirection` returns `undefined` because no direction exists.

## Related topics

- [Celestial and Terrestrial Reference Frames]({% link astronomy/coordinates-and-observers/celestial-and-terrestrial-reference-frames.md %}) covers rotations into other reference axes.
- [Spherical Coordinate Conversions]({% link astronomy/coordinates-and-observers/spherical-coordinate-conversions.md %}) converts a Cartesian direction to sky angles.
- [Starlight Deflection]({% link astronomy/coordinates-and-observers/starlight-deflection.md %}) explains finite-source and star-at-infinity bending by supplied bodies.
- [Annual Aberration]({% link astronomy/coordinates-and-observers/annual-aberration.md %}) explains the velocity-dependent final correction.
