---
title: Angular Motion
layout: default
parent: Coordinates and Observers
grand_parent: Astronomy
nav_order: 60
description: Derives spherical position, angular rates, and radial velocity from a Cartesian state or sampled sky positions.

doc_kind: topic

sources:
    - src/astronomy/coordinates/astrometry.ts
    - src/astronomy/coordinates/motion.ts

api:
    - SphericalPositionAndVelocity
    - sphericalPositionAndVelocity
    - frameSphericalPositionAndVelocity
    - SphericalMotionSample
    - AngularMotion
    - angularMotionOrDifferentialTrackingRate
---

# Angular Motion

Use `sphericalPositionAndVelocity` for **instantaneous** angular and radial rates from a Cartesian `[position, velocity]` state. Use `angularMotionOrDifferentialTrackingRate` for **sampled** angular rates, and optionally acceleration, from positions at different times. Both report coordinate longitude rate `dλ/dt` directly; neither multiplies it by `cos(latitude)`.

## Basic usage

```ts
import { sphericalPositionAndVelocity } from '../src/astronomy/coordinates/astrometry';
import { angularMotionOrDifferentialTrackingRate } from '../src/astronomy/coordinates/motion';
import { deg } from '../src/math/units/angle';

const instantaneous = sphericalPositionAndVelocity([
	[1, 0, 0], // position, AU
	[0, 0.37, 0], // velocity, AU/day
]);
// instantaneous?.longitudeRate = +0.37 rad/day; radialVelocity = 0 AU/day.

const sampled = angularMotionOrDifferentialTrackingRate([
	{ longitude: deg(1), latitude: 0, timeDays: 1 },
	{ longitude: deg(359), latitude: 0, timeDays: 0 },
]);
// sampled?.longitudeRatePerDay = +2 degrees/day, across the 0° wrap.
```

The sampled function sorts a copy by `timeDays`, so input order does not set the rate sign. Both examples move toward increasing longitude.

## Instantaneous Cartesian rates

`sphericalPositionAndVelocity([p, v])` reads a state in its **already chosen** axes: `p` in AU, `v` in AU/day. It returns a `SphericalPositionAndVelocity` object with:

| Property                        | Meaning                                                                                     |
| ------------------------------- | ------------------------------------------------------------------------------------------- |
| `longitude`, `latitude`         | Direction in radians; longitude is normalized to `[0, 2π)`, latitude lies in `[-π/2, π/2]`. |
| `distance`                      | Length of `p`, in AU.                                                                       |
| `longitudeRate`, `latitudeRate` | Analytic coordinate derivatives in radians/day; they are optional at a pole.                |
| `radialVelocity`                | `p · v / ‖p‖` in AU/day, positive when the distance increases.                              |

The zero position has no direction and returns `undefined`. At an **exact** Cartesian pole (`x = y = 0`, `z ≠ 0`), longitude is `0` and both angular rates are `undefined`; distance, latitude, and radial velocity remain available. Near a pole, a large longitude rate is returned rather than capped. The returned result is a fresh object; the input state is read without mutation.

`frameSphericalPositionAndVelocity(pv, frame, time, out?)` first applies `frameAt` to the **full state**, then computes these spherical quantities. When the frame supplies a rate operator `W`, its rotational velocity transport is included. For example, a state at rest in ITRS has near-zero ITRS angular rates even though its inertial longitude changes as Earth turns. `out` is an optional mutable workspace for the transformed Cartesian state; it may alias `pv`. The spherical result is separate from that workspace.

## Sampled sky rates

Each `SphericalMotionSample` has finite longitude and latitude in radians and a finite `timeDays` value in days on a consistent time axis. The origin of `timeDays` is arbitrary. For physical rad/s results, a difference of one `timeDays` unit must represent 86400 elapsed seconds; convert civil UTC intervals across leap seconds accordingly. `angularMotionOrDifferentialTrackingRate(samples)` sorts a copy, then uses the **earliest and latest** samples for the overall rate and position angle:

| Property                                                                  | Meaning                                                                                                                                                                                                             |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `longitudeRatePerDay`, `latitudeRatePerDay`                               | Endpoint coordinate differences divided by elapsed days, in rad/day. The longitude difference is wrapped into `(−π, π]`.                                                                                            |
| `angularRatePerDay`                                                       | Great-circle separation of the endpoints divided by elapsed days, in rad/day. It is a nonnegative secant rate.                                                                                                      |
| `longitudeRatePerSecond`, `latitudeRatePerSecond`, `angularRatePerSecond` | The corresponding per-day values divided by 86400, in rad/s.                                                                                                                                                        |
| `positionAngle`                                                           | Direction from the first endpoint to the last, north through east in `[0, 2π)`. The direction is undefined for coincident or antipodal endpoints; the formula returns `0` when its two components are exactly zero. |

With two samples, these are secant rates and no acceleration is returned. With three or more, the function chooses the interior sample closest to the midpoint in time. It uses the first-to-middle and middle-to-last legs to compute `longitudeAccelerationPerDaySquared` and `latitudeAccelerationPerDaySquared` in rad/day²; other interior samples affect only the midpoint selection. `angularAccelerationPerDaySquared` is the **magnitude** of tangential acceleration on the sphere, also in rad/day²: it compares the two great-circle tangent velocities in the middle sample's tangent plane. It is not the magnitude of the two coordinate-acceleration fields.

The function returns `undefined` for fewer than two samples or when the earliest and latest times coincide. If an interior leg has zero duration, the endpoint rates are still returned without acceleration. When a leg is antipodal or numerically too close to antipodal, its tangent is not unique: `angularAccelerationPerDaySquared` is omitted while the defined coordinate rates remain available.

{: .warning }
Longitude unwrapping chooses the shorter difference in `(−π, π]`. If the true track turns by more than half a revolution between samples, the sampled longitude rate is aliased; sample more densely. These finite-interval rates are not catalog proper motion or an instantaneous derivative.

## Related topics

- [Spherical Coordinate Conversions]({% link astronomy/coordinates-and-observers/spherical-coordinate-conversions.md %}) converts angular positions among celestial axes.
- [Angular Separation and Position Angle]({% link astronomy/coordinates-and-observers/angular-separation-and-position-angle.md %}) measures distance and bearing between sampled directions.
- [Celestial and Terrestrial Reference Frames]({% link astronomy/coordinates-and-observers/celestial-and-terrestrial-reference-frames.md %}) explains the frame-rate term included before spherical rates are evaluated.
