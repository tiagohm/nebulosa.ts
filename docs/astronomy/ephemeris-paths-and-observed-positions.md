---
title: Ephemeris Paths and Observed Positions
layout: default
parent: Astronomy
nav_order: 100
description: Composes center-to-target states and samples geometric, astrometric, and apparent positions.

doc_kind: topic

sources:
    - src/astronomy/ephemeris/path.ts
    - src/astronomy/ephemeris/position.ts

api:
    - EphemerisPath
    - ephemerisPath
    - naifEphemerisEndpoint
    - customEphemerisEndpoint
    - SOLAR_SYSTEM_BARYCENTER
    - reverseEphemerisPath
    - composeEphemerisPaths
    - relativeEphemerisPath
    - ephemerisAt
    - observeEphemeris
    - apparentPosition
    - equatorialPosition
    - geometricPositionInFrame
    - directionPositionInFrame
    - geometricSphericalPositionAndVelocity
---

# Ephemeris Paths and Observed Positions

An `EphemerisPath` labels a synchronous state provider with its center and target. The position helpers sample such paths at three distinct stages: a same-epoch **geometric** state, a light-time-corrected **astrometric** direction, and a direction with requested **apparent** corrections. Use the stage that matches the physical quantity you need; a same-epoch relative state is not an observed place.

## Basic usage

```ts
import { Naif } from '../src/astronomy/ephemeris/kernels/naif';
import { ephemerisPath, naifEphemerisEndpoint, SOLAR_SYSTEM_BARYCENTER } from '../src/astronomy/ephemeris/path';
import { apparentPosition, ephemerisAt, equatorialPosition, observeEphemeris } from '../src/astronomy/ephemeris/position';
import { timeYMDHMS, Timescale } from '../src/astronomy/time/time';

// Illustrative constant barycentric states, not planetary ephemerides.
const observer = ephemerisPath(SOLAR_SYSTEM_BARYCENTER, naifEphemerisEndpoint(Naif.EARTH), () => [
	[1, 0, 0],
	[0, 0.017, 0],
]);
const target = ephemerisPath(SOLAR_SYSTEM_BARYCENTER, naifEphemerisEndpoint(Naif.MARS), () => [
	[1.5, 0.1, 0],
	[0, 0, 0],
]);
const sun = ephemerisPath(SOLAR_SYSTEM_BARYCENTER, naifEphemerisEndpoint(Naif.SUN), () => [
	[0, 0, 0],
	[0, 0, 0],
]);
const instant = timeYMDHMS(2025, 1, 1, 0, 0, 0, Timescale.TDB);

const geometric = ephemerisAt(target, instant); // SSB to target at one epoch
const astrometric = observeEphemeris(observer, target, instant);
if (astrometric === undefined) throw new Error('observer and target coincide');
const apparent = apparentPosition(astrometric, { sun });
const [rightAscension, declination, distanceAu] = equatorialPosition(apparent);
console.log(geometric.position, rightAscension, declination, distanceAu);
```

Each path's provider returns `[position, velocity]` in **AU** and **AU/day**, on common ICRS/BCRS-oriented Cartesian axes. `naifEphemerisEndpoint` and `customEphemerisEndpoint` label the two ends; endpoint identity uses the kind and ID, not the optional display name. `ephemerisPath` retains the supplied provider and endpoints. It does not fetch a state, change an origin, or rotate axes.

## Paths and position stages

`reverseEphemerisPath` reverses a center-to-target path. `composeEphemerisPaths(first, second)` adds a center-to-middle and middle-to-target state at the **same epoch**; their shared endpoint must match. `relativeEphemerisPath(target, origin)` subtracts two paths with the same center, giving a state from the origin path's target to the target path's target. A mismatch throws. These operations do not apply light time.

| Stage       | Call                                                 | Result                                                                                                                                                            |
| ----------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Geometric   | `ephemerisAt(path, time)`                            | Same-epoch center-to-target position and velocity, with the path's declared origin.                                                                               |
| Astrometric | `observeEphemeris(observer, target, time, options?)` | Observer at reception and target at retarded emission; observer-to-target vector, unit direction, distance, and one-way light time.                               |
| Apparent    | `apparentPosition(astrometric, options)`             | Unit direction after explicitly requested finite-distance gravitational deflection and observer aberration; the astrometric distance and light time are retained. |

For `observeEphemeris`, **both input paths must be centered on the solar-system barycenter** (`SOLAR_SYSTEM_BARYCENTER`); a planet-centered path cannot be retarded on its own. The `time` argument is the observer's reception epoch. The target is sampled at successively earlier epochs, with three fixed-point refinements by default; `lightTimeIterations` accepts integers from 0 through 16. Zero uses the target's same-epoch state. A zero final separation returns `undefined` because the direction is undefined. The result's `position` is in AU, `direction` has unit length, `distance` is in AU, and `lightTime` is in days. `emissionTime` is recomputed from the final separation, so it may differ slightly from the last sampled target epoch if the iteration has not converged.

`apparentPosition` applies deflectors in the supplied photon-encounter order, then aberration from the observer's barycentric velocity. Deflectors are optional; each needs an SSB-centered path, mass in solar masses, and an ERFA near-body limiter in radians²/2. Aberration defaults to enabled and requires an SSB-centered Sun path for the observer–Sun distance; passing the Sun path does **not** include solar gravitational deflection unless the Sun is also listed as a deflector. Set `{ aberration: false }` when aberration is not wanted. The apparent result remains in ICRS/BCRS-oriented axes; it is not a horizontal or refracted observed place.

## Coordinates, frames, and ownership

`equatorialPosition` returns `[rightAscension, declination, distance]`: angles in radians, right ascension normalized to `[0, 2π)`, and distance in AU. For geometric input, it uses the position's length; for astrometric or apparent input, it preserves the retarded distance rather than treating the unit direction as a one-AU vector. Direction stages do not carry a velocity.

`geometricPositionInFrame` rotates a geometric position and velocity at their epoch. A rotating frame contributes **W · p** to velocity, where `W = (dR/dt) Rᵀ` in day⁻¹. Supply `out` to mutate and return that state, including when it aliases the input; otherwise the helper allocates a state. `directionPositionInFrame` rotates only an astrometric or apparent unit direction at reception, allocating a new vector. These rotations change axes, not origins. `geometricSphericalPositionAndVelocity` additionally derives angular rates in radians/day and radial velocity in AU/day from a geometric state, optionally after a frame rotation; zero distance returns `undefined`, and angular rates can be undefined at a pole.

`ephemerisAt` exposes the vectors returned by its provider without copying them. The path-algebra helpers also operate on provider-returned vectors: reversal negates them in place, and composition adds into the first provider's vectors. Supply fresh state vectors when using those helpers if a provider's storage must remain unchanged. In contrast, `observeEphemeris` stores fresh snapshots of its sampled vectors, and `apparentPosition` returns a new direction.

## Related topics

- [Light-Time Solution]({% link astronomy/coordinates-and-observers/light-time-solution.md %}) documents the underlying retarded-time solver.
- [Apparent Direction]({% link astronomy/coordinates-and-observers/apparent-direction.md %}) explains the finite-target correction pipeline without path metadata.
- [Celestial and Terrestrial Reference Frames]({% link astronomy/coordinates-and-observers/celestial-and-terrestrial-reference-frames.md %}) explains rotating states and velocity transport.
- [DAF and SPK Kernels]({% link astronomy/daf-and-spk-kernels.md %}) provides one source of ephemeris states.
