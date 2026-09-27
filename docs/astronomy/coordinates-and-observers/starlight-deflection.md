---
title: Starlight Deflection
layout: default
parent: Coordinates and Observers
grand_parent: Astronomy
nav_order: 90
description: Applies gravitational bending by caller-supplied Solar System bodies to finite-target or stellar directions.

doc_kind: topic

sources:
    - src/astronomy/coordinates/apparent.ts
    - src/astronomy/coordinates/erfa/erfa.ts

api:
    - deflectStarlight
    - LightDeflector
    - LightDeflectorSnapshot
    - LdBody
    - SUN_LIGHT_DEFLECTOR_MASS
    - JUPITER_LIGHT_DEFLECTOR_MASS
    - SATURN_LIGHT_DEFLECTOR_MASS
    - SUN_LIGHT_DEFLECTOR_LIMITER
    - JUPITER_LIGHT_DEFLECTOR_LIMITER
    - SATURN_LIGHT_DEFLECTOR_LIMITER
---

# Starlight Deflection

Massive Solar System bodies bend the incoming direction of light. Use the `deflectors` option of [Apparent Direction]({% link astronomy/coordinates-and-observers/apparent-direction.md %}) for a **finite-distance target**. Use `deflectStarlight` when the source is modeled at infinity and you already have its unit observer-to-star direction.

## Finite-distance targets

```ts
import { apparentDirection, SUN_LIGHT_DEFLECTOR_LIMITER, SUN_LIGHT_DEFLECTOR_MASS } from '../src/astronomy/coordinates/apparent';
import type { PositionAndVelocityOverTime } from '../src/astronomy/coordinates/astrometry';
import { timeYMDHMS, Timescale } from '../src/astronomy/time/time';

// Illustrative states in barycentric ICRS/BCRS axes, not ephemeris data.
const sun: PositionAndVelocityOverTime = () => [
	[0, 0, 0],
	[0, 0, 0],
];
const observer: PositionAndVelocityOverTime = () => [
	[1, 0, 0],
	[0, 0, 0],
];
const target: PositionAndVelocityOverTime = () => [
	[2, 0.01, 0],
	[0, 0, 0],
];
const time = timeYMDHMS(2025, 1, 1, 0, 0, 0, Timescale.TDB);

const place = apparentDirection(target, observer, time, {
	aberration: false,
	deflectors: [{ mass: SUN_LIGHT_DEFLECTOR_MASS, limiter: SUN_LIGHT_DEFLECTOR_LIMITER, state: sun }],
});
// place?.astrometric is before bending; place?.apparent is after bending.
```

Each `LightDeflector` has `mass` in solar masses, `limiter` in radians²/2, and a `state(time)` provider returning barycentric position in AU and velocity in AU/day. Supply bodies in the order encountered by the photon. `apparentDirection` samples each deflector at reception, linearly backtracks its position toward the photon encounter, and clips the backtrack to the target's light time. The correction uses a separate deflector-to-source direction, so a mass beyond a finite target is not treated like a mass on the ray to a star at infinity. For the lower-level `applyApparentDirectionCorrections`, provide equivalent reception-time `LightDeflectorSnapshot` objects with `position` and `velocity` instead of `state`.

Solar gravity bends the direction only when the Sun appears in `deflectors`; supplying `sun` separately for aberration does not add solar deflection. An omitted or empty deflector list leaves the astrometric direction unbent. Set `aberration: false` when isolating deflection as above; otherwise aberration follows the deflection stage and requires a Sun state.

## Sources modeled at infinity

`deflectStarlight(direction, observerBarycentricPosition, deflectors)` accepts a unit ICRS/BCRS observer-to-star coordinate direction, observer barycentric position in AU, and an ordered array of reception-time `LdBody` values. Each body has `bm` (solar masses), `dl` (radians²/2), `p` (barycentric AU), and `v` (barycentric AU/day). The function delegates to the ERFA-style `eraLdn` path and returns a fresh deflected direction without mutating the input. The result is close to unit length but is not explicitly normalized. It does not solve finite target geometry, apply aberration, or rotate into an observed frame.

```ts
import { deflectStarlight, SUN_LIGHT_DEFLECTOR_LIMITER, SUN_LIGHT_DEFLECTOR_MASS } from '../src/astronomy/coordinates/apparent';

const natural = deflectStarlight([0, 1, 0], [1, 0, 0], [{ bm: SUN_LIGHT_DEFLECTOR_MASS, dl: SUN_LIGHT_DEFLECTOR_LIMITER, p: [0, 0, 0], v: [0, 0, 0] }]);
```

## Model and limits

The shipped mass ratios and near-body limiter values are:

| Body    | Mass in solar masses | Limiter in rad²/2 |
| ------- | -------------------: | ----------------: |
| Sun     |                  `1` |            `6e-6` |
| Jupiter |         `0.00095435` |            `3e-9` |
| Saturn  |         `0.00028574` |           `3e-10` |

The limiter sets a lower bound on the denominator of the single-body deflection formula near the body. Supply positive masses and limiters with consistent states and a unit stellar input direction. The model uses body positions and velocities supplied by the caller and a linear encounter-time backtrack; its precision therefore depends on those states, the geometry, and the limiter. Near a source–deflector or observer–deflector coincidence, the finite-target path skips that body's correction because its direction is undefined. `deflectStarlight` uses the star-at-infinity path, so use the finite-target pipeline for Solar System objects. The implementation does not compute body ephemerides or gravitational light-travel delay.

## Related topics

- [Apparent Direction]({% link astronomy/coordinates-and-observers/apparent-direction.md %}) combines light time, finite-source deflection, and aberration.
- [Light-Time Solution]({% link astronomy/coordinates-and-observers/light-time-solution.md %}) supplies the retarded target geometry before deflection.
- [Annual Aberration]({% link astronomy/coordinates-and-observers/annual-aberration.md %}) applies the observer-velocity correction after deflection.

## References

- [ERFA `eraLd` source and routine notes](https://github.com/liberfa/erfa/blob/master/src/ld.c) describe the single-body deflection and limiter.
- [ERFA `eraLdn` source and routine notes](https://github.com/liberfa/erfa/blob/master/src/ldn.c) describe multi-body deflection for a source at infinity.
