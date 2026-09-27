---
title: Stellar Space Motion
layout: default
parent: Astronomy
nav_order: 330
description: Converts catalog astrometry into a barycentric star state and propagates its position to another epoch.

doc_kind: topic

sources:
    - src/astronomy/bodies/star.ts

api:
    - Star
    - StarPositionAndVelocity
    - star
    - spaceMotion
---

# Stellar Space Motion

`star(...)` combines catalog right ascension, declination, proper motion, parallax, and radial velocity into a **BCRS position and velocity** at the catalog epoch. `spaceMotion(...)` propagates that state to another epoch. Use this path when a catalog star's direction changes enough over time that a fixed J2000 coordinate is insufficient.

## Basic usage

```ts
import { spaceMotion, star } from '../src/astronomy/bodies/star';
import { equatorial } from '../src/astronomy/coordinates/astrometry';
import { timeYMD } from '../src/astronomy/time/time';
import { deg, mas, normalizeAngle, toDeg } from '../src/math/units/angle';
import { kilometerPerSecond } from '../src/math/units/velocity';

const dec = deg(-16.7225);
const catalog = star(
	deg(101.27724),
	dec,
	mas(-415.12) / Math.cos(dec), // Catalog μ_α* converted to dα/dt
	mas(-1163.79),
	mas(378.932),
	kilometerPerSecond(-10),
);
const [position] = spaceMotion(catalog, timeYMD(2025, 7, 27));
const [ra, propagatedDec] = equatorial(position);
console.log(toDeg(normalizeAngle(ra)), toDeg(propagatedDec));
```

The final coordinates here are derived from the propagated **BCRS vector**. They are not a date-dependent apparent or topocentric observed place.

## Catalog inputs and state

| Argument to `star` | Unit / convention          | Meaning                                                                  |
| ------------------ | -------------------------- | ------------------------------------------------------------------------ |
| `ra`, `dec`        | radians, ICRS catalog axes | Catalog right ascension and declination at `epoch`.                      |
| `pmRA`             | radians per Julian year    | Coordinate derivative `dα/dt`, **without** multiplication by `cos(dec)`. |
| `pmDEC`            | radians per Julian year    | Coordinate derivative `dδ/dt`.                                           |
| `parallax`         | radians                    | Annual stellar parallax.                                                 |
| `rv`               | AU/day                     | Radial velocity; positive means receding.                                |
| `epoch`            | `Time`                     | Catalog reference epoch; defaults to **J2000.0 TDB**.                    |

The four motion and distance inputs default to zero. If a catalog supplies `μ_α* = (dα/dt) cos δ`, divide by `cos δ` before passing `pmRA`, away from the celestial poles. Convert catalog milliarcseconds with `mas(...)`; convert kilometers per second with `kilometerPerSecond(...)`. The supplied RA, declination, and motion must refer to the same catalog epoch.

`star(...)` returns a `StarPositionAndVelocity`: tuple element `[0]` is BCRS position in **AU**, `[1]` is velocity in **AU/day**, and its named fields retain the catalog values and `epoch`. It calls the ERFA-style `eraStarpv` conversion. A nonpositive or very small parallax is limited to **0.5 microarcsecond** internally, giving a finite distant position rather than an infinite-distance vector. If the derived speed exceeds half the speed of light, the conversion zeroes the velocity vector.

## Propagating and interpreting the result

`spaceMotion(catalog, time)` returns a `[position, velocity]` pair in the same BCRS axes and units. It converts the catalog epoch and target time to **TT** before passing their Julian Dates to the propagation routine, using TT as a practical stand-in for TDB. The position is newly computed. The returned velocity is **the same array** as `catalog[1]`; it is not a newly estimated velocity at the target epoch. Mutating it would also change the catalog state's velocity.

This operation propagates space motion. It does not apply Earth's position, annual aberration, precession–nutation, atmospheric refraction, or an observer's horizon. The result's usefulness depends on the quality of the catalog parallax and velocities; the implementation gives no general accuracy bound for arbitrary epochs or stars. For a site-specific direction, use the observed-star reduction. [ERFA / SOFA Algorithms]({% link astronomy/erfa-sofa-algorithms.md %}) documents the lower-level astrometry family.
